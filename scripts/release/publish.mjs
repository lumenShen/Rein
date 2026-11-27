#!/usr/bin/env node
/**
 * Rein 发布器：签名 → 组装清单 → 推服务端 / 发 GitHub Release。
 *
 * 本地与 CI 走的是同一份代码（CI 里只是环境变量来自 Secrets），
 * 这样「本地能发、CI 发出来不一样」这类事故不会发生。
 *
 * 用法：
 *   node scripts/release/publish.mjs \
 *     --version 0.2.1 \
 *     --target windows-x86_64=src-tauri/target/release/bundle/nsis/Rein_0.2.1_x64-setup.exe \
 *     --target android-aarch64=path/to/app-universal-release.apk \
 *     --notes-file RELEASE_NOTES.md \
 *     --to server,github
 *
 * 环境变量（或 scripts/release/release.config.json）：
 *   REIN_UPDATE_BASE_URL   服务端地址，如 http://47.100.36.179:8787
 *   REIN_UPDATE_TOKEN      服务端管理令牌
 *   GITHUB_TOKEN           发 GitHub Release 用（CI 自带）
 *   TAURI_SIGNING_PRIVATE_KEY_PATH / _PASSWORD   更新签名私钥
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  TARGETS,
  REPO_ROOT,
  fail,
  formatSize,
  loadReleaseConfig,
  log,
  readJson,
  sha256File,
  signFile,
  signText,
} from './lib.mjs'
import { NOTES_LIMITS, prepareNotes } from './notes.mjs'

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const out = { targets: {}, to: 'server,github', publish: true, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) fail(`参数 ${a} 缺少取值`)
      i += 1
      return v
    }
    switch (a) {
      case '--version':
        out.version = next().replace(/^v/i, '')
        break
      case '--target': {
        const raw = next()
        const eq = raw.indexOf('=')
        if (eq < 0) fail(`--target 需要写成 <平台键>=<文件路径>：${raw}`)
        const key = raw.slice(0, eq)
        const file = raw.slice(eq + 1)
        if (!TARGETS[key]) fail(`未知平台键：${key}（可用：${Object.keys(TARGETS).join(', ')}）`)
        out.targets[key] = file
        break
      }
      case '--notes':
        out.notes = next()
        break
      case '--notes-file':
        out.notesFile = next()
        break
      case '--allow-long-notes':
        out.allowLongNotes = true
        break
      case '--channel':
        out.channel = next()
        break
      case '--to':
        out.to = next()
        break
      case '--mandatory':
        out.mandatory = true
        break
      case '--no-publish':
        out.publish = false
        break
      case '--dry-run':
        out.dryRun = true
        break
      default:
        fail(`未知参数：${a}`)
    }
  }
  return out
}

// ---------- GitHub REST（零依赖） ----------

class GitHub {
  constructor(repo, token) {
    this.repo = repo
    this.token = token
    this.api = 'https://api.github.com'
  }

  async request(method, url, body, extraHeaders = {}) {
    const res = await fetch(url.startsWith('http') ? url : `${this.api}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rein-release',
        ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* 上传接口返回非 JSON 时忽略 */
    }
    if (!res.ok) {
      const message = json?.message ?? text.slice(0, 300)
      const err = new Error(`GitHub ${method} ${url} → ${res.status} ${message}`)
      err.status = res.status
      throw err
    }
    return json
  }

  async ensureRelease({ tag, name, body, prerelease }) {
    try {
      return await this.request('GET', `/repos/${this.repo}/releases/tags/${tag}`)
    } catch (e) {
      if (e.status !== 404) throw e
    }
    return this.request('POST', `/repos/${this.repo}/releases`, {
      tag_name: tag,
      name,
      body,
      draft: false,
      prerelease,
    })
  }

  async uploadAsset(release, file, fileName) {
    const data = fs.readFileSync(file)
    // 已有同名资产先删掉 —— 重发同一个版本必须是幂等的
    const existing = (release.assets ?? []).find((a) => a.name === fileName)
    if (existing) {
      await this.request('DELETE', `/repos/${this.repo}/releases/assets/${existing.id}`)
      log(`   · 覆盖已存在的资产 ${fileName}`)
    }
    return this.request(
      'POST',
      `https://uploads.github.com/repos/${this.repo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`,
      data,
      { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) },
    )
  }
}

// ---------- 服务端管理 API ----------

class UpdateServer {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
  }

  async request(method, pathname, { body, headers = {} } = {}) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'rein-release',
        ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* 忽略非 JSON */
    }
    if (!res.ok) throw new Error(`服务端 ${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`)
    return json
  }

  async uploadArtifact(channel, version, file) {
    const data = fs.readFileSync(file)
    const fileName = path.basename(file)
    return this.request('POST', `/admin/api/artifacts/${channel}/${version}/${encodeURIComponent(fileName)}`, {
      body: data,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) },
    })
  }

  publish(payload) {
    return this.request('POST', '/admin/api/releases', { body: payload })
  }

  state() {
    return this.request('GET', '/admin/api/state')
  }
}

// ---------- 主流程 ----------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadReleaseConfig()
  const version = args.version
  const channel = args.channel ?? cfg.channel

  if (!version) fail('缺少 --version（例如 --version 0.2.1）')
  if (Object.keys(args.targets).length === 0) fail('至少需要一个 --target <平台键>=<文件>')

  // 说明只取**这一版**那一节，并按《更新文案规范》校验（scripts/release/notes.mjs）。
  // 从前是把整份 RELEASE_NOTES.md 塞进清单：线上实测 79,848 字节里 77,481 是 notes，
  // 每个客户端每次检查更新都要下这一整份历史，而用户要看的只有最后一节。
  const notesFile = args.notesFile ?? 'RELEASE_NOTES.md'
  const notesSource = fs.readFileSync(path.resolve(REPO_ROOT, notesFile), 'utf8')
  const prepared = prepareNotes({ fullText: notesSource, version, inline: args.notes })
  const notes = prepared.body
  if (!prepared.ok) {
    if (args.allowLongNotes) {
      log(`\n⚠ 更新文案不合规范（--allow-long-notes 已放行）：`)
      for (const p of prepared.problems) log(`   · ${p}`)
    } else {
      fail(
        [
          `v${version} 的更新文案不合规范：`,
          ...prepared.problems.map((p) => `  · ${p}`),
          '',
          `规范（v1）：最多 ${NOTES_LIMITS.bullets} 条、单条 ≤ ${NOTES_LIMITS.bulletChars} 字、整段 ≤ ${NOTES_LIMITS.totalChars} 字，`,
          '不写实现细节与工程过程、不嵌套列表与表格。',
          '详见 scripts/release/notes.mjs 顶部 / docs/UPDATES.md §10。',
          '确有必要时用 --allow-long-notes 显式放行。',
        ].join('\n'),
      )
    }
  }
  const tag = `v${version}`
  const toServer = args.to.split(',').map((s) => s.trim()).filter(Boolean).includes('server')
  const toGithub = args.to.split(',').map((s) => s.trim()).filter(Boolean).includes('github')

  log(`\n▶ Rein ${tag}（通道 ${channel}）`)
  if (prepared.found) {
    const lines = notes.split('\n').length
    log(`   · 说明取自${prepared.source === 'inline' ? ' --notes' : ` ${notesFile} 的 v${version} 一节`}：${lines} 行 · ${notes.replace(/\s+/g, '').length} 字`)
  } else {
    log('   · 说明：无')
  }

  // 1) 逐个产物算摘要 + 签名
  const platforms = {}
  const artifacts = []
  for (const [target, rawPath] of Object.entries(args.targets)) {
    const file = path.resolve(REPO_ROOT, rawPath)
    if (!fs.existsSync(file)) fail(`[${target}] 产物不存在：${rawPath}`)
    const fileName = path.basename(file)
    const sha256 = await sha256File(file)
    const size = fs.statSync(file).size

    // tauri build 若已产出 .sig（createUpdaterArtifacts），直接复用：那是官方实现签的
    const existingSig = `${file}.sig`
    let signature
    let signSource = 'tauri-build'
    if (fs.existsSync(existingSig)) {
      signature = fs.readFileSync(existingSig, 'utf8').trim()
    } else {
      if (args.dryRun) {
        signature = 'DRY-RUN'
      } else {
        signature = signFile(file, { keyPath: cfg.keyPath, password: cfg.keyPassword }).signature
      }
      signSource = 'rein-publish'
    }

    log(`   · ${target.padEnd(16)} ${fileName}  ${formatSize(size)}  sha256 ${sha256.slice(0, 12)}…  签名(${signSource})`)
    artifacts.push({ target, file, fileName, sha256, size, signature })
  }

  // 2) 两套清单：服务端（本地 URL 优先）与 GitHub（Release 资产 URL 优先）
  const githubBase = `https://github.com/${cfg.githubRepo}/releases/download/${tag}`
  const serverBase = `${cfg.serverBaseUrl}/dl/${channel}/${version}`

  const buildManifest = (primaryBase, mirrorBase, name) => {
    const platformsOut = {}
    for (const a of artifacts) {
      const primary = `${primaryBase}/${encodeURIComponent(a.fileName)}`
      const mirror = `${mirrorBase}/${encodeURIComponent(a.fileName)}`
      platformsOut[a.target] = {
        url: primary,
        signature: a.signature,
        sha256: a.sha256,
        size: a.size,
        name: a.fileName,
        mirrors: mirror === primary ? [] : [mirror],
      }
    }
    return {
      version,
      notes,
      pub_date: new Date().toISOString(),
      channel,
      mandatory: Boolean(args.mandatory),
      platforms: platformsOut,
      'x-rein': {
        generator: 'rein-release',
        source: name,
        repo: cfg.githubRepo,
        repoTag: tag,
      },
    }
  }

  const manifestForServer = buildManifest(serverBase, githubBase, 'server')
  const manifestForGithub = buildManifest(githubBase, serverBase, 'github')
  const serverText = `${JSON.stringify(manifestForServer, null, 2)}\n`
  const githubText = `${JSON.stringify(manifestForGithub, null, 2)}\n`

  const outDir = path.join(REPO_ROOT, 'dist-release', version)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'latest.server.json'), serverText, 'utf8')
  fs.writeFileSync(path.join(outDir, 'latest.github.json'), githubText, 'utf8')

  let serverManifestSig = null
  let githubManifestSig = null
  if (!args.dryRun) {
    serverManifestSig = signText(serverText, { keyPath: cfg.keyPath, password: cfg.keyPassword, label: 'latest.json' }).signature
    githubManifestSig = signText(githubText, { keyPath: cfg.keyPath, password: cfg.keyPassword, label: 'latest.json' }).signature
    fs.writeFileSync(path.join(outDir, 'latest.server.json.sig'), serverManifestSig, 'utf8')
    fs.writeFileSync(path.join(outDir, 'latest.github.json.sig'), githubManifestSig, 'utf8')
    log(`   · 清单已签名 → dist-release/${version}/latest.{server,github}.json(+.sig)`)
  }

  if (args.dryRun) {
    log('\n◌ dry-run：跳过上传。生成的清单：')
    log(serverText)
    return
  }

  // 3) 推服务端
  if (toServer) {
    if (!cfg.adminToken) {
      log('\n⚠ 未配置 REIN_UPDATE_TOKEN，跳过服务端发布（只发 GitHub）。')
    } else {
      log(`\n→ 推送服务端 ${cfg.uploadBaseUrl}${cfg.uploadBaseUrl === cfg.serverBaseUrl ? '' : `（清单地址仍写 ${cfg.serverBaseUrl}）`}`)
      const server = new UpdateServer(cfg.uploadBaseUrl, cfg.adminToken)
      for (const a of artifacts) {
        const info = await server.uploadArtifact(channel, version, a.file)
        if (info.sha256 !== a.sha256) fail(`服务端回执 sha256 不一致：${info.sha256} ≠ ${a.sha256}`)
        log(`   ✓ 已上传 ${a.fileName}`)
      }
      await server.publish({
        channel,
        version,
        notes,
        mandatory: Boolean(args.mandatory),
        publish: args.publish,
        platforms: Object.fromEntries(
          artifacts.map((a) => [
            a.target,
            {
              file: a.fileName,
              signature: a.signature,
              sha256: a.sha256,
              size: a.size,
              mirrors: [`${githubBase}/${encodeURIComponent(a.fileName)}`],
            },
          ]),
        ),
        manifestText: serverText,
        manifestSignature: serverManifestSig,
      })
      log(`   ✓ 已登记并${args.publish ? '发布' : '登记（未切换 latest）'}：${channel}/${version}`)
      const state = await server.state()
      log(`   ✓ 服务端当前版本：${state.channels.map((c) => `${c.channel}=${c.current ?? '—'}`).join('  ')}`)
    }
  }

  // 4) 发 GitHub Release
  if (toGithub) {
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      fail('缺少 GITHUB_TOKEN：在 GitHub Actions 里用 secrets.GITHUB_TOKEN，本地用 `gh auth token` 或 PAT。')
    }
    log(`\n→ 发布 GitHub Release ${cfg.githubRepo} ${tag}`)
    const gh = new GitHub(cfg.githubRepo, token)
    const release = await gh.ensureRelease({
      tag,
      name: `Rein ${tag}`,
      body: notes || `Rein ${tag}`,
      prerelease: channel !== 'stable',
    })
    for (const a of artifacts) {
      await gh.uploadAsset(release, a.file, a.fileName)
      await gh.uploadAsset(release, `${a.file}.sig`, `${a.fileName}.sig`)
      log(`   ✓ 已上传 ${a.fileName} + .sig`)
    }
    const manifestTmp = path.join(outDir, 'latest.json')
    fs.writeFileSync(manifestTmp, githubText, 'utf8')
    await gh.uploadAsset(release, manifestTmp, 'latest.json')
    const sigTmp = path.join(outDir, 'latest.json.sig')
    fs.writeFileSync(sigTmp, githubManifestSig, 'utf8')
    await gh.uploadAsset(release, sigTmp, 'latest.json.sig')
    log('   ✓ 已上传 latest.json + latest.json.sig')
    log(`\n   GitHub 清单地址（客户端直连）：\n   https://github.com/${cfg.githubRepo}/releases/latest/download/latest.json`)
  }

  log(
    [
      '',
      `✔ ${tag} 发布完成`,
      `   通道 ${channel} · ${artifacts.length} 个平台 · ${formatSize(artifacts.reduce((n, a) => n + a.size, 0))}`,
      `   校验：node scripts/release/verify.mjs --manifest ${cfg.serverBaseUrl}/updates/latest.json`,
      '   端口未放行时加 --via 走隧道（见 scripts/release/verify.mjs 顶部注释）',
      '',
    ].join('\n'),
  )
}

main().catch((e) => fail(e.stack ?? String(e)))
