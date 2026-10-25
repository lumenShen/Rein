/**
 * 发布工具链的公共部分：签名、清单组装、与 Rein 服务端/ GitHub Release 的对话。
 *
 * 为什么签名要走 tauri CLI 而不是自己写：客户端的验签用的是 minisign-verify
 * （tauri-plugin-updater 同款），密钥文件与签名格式都由官方 CLI 定义。
 * 自己实现一套「看起来一样」的格式，一旦某个字节不同，表现是「某些机器上装不上」，
 * 那是发布链路里最难查的一类故障 —— 不值得为省一次子进程去赌。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const AUTHORS = 'gozaoo <gozaoo@outlook.com>'
export const GITHUB_REPO = process.env.REIN_GITHUB_REPO ?? 'lumenShen/Rein'

/** 各平台的清单键名（与 tauri-plugin-updater 的 target 命名一致）。 */
export const TARGETS = {
  'windows-x86_64': { os: 'windows', arch: 'x86_64', kind: 'installer' },
  'windows-aarch64': { os: 'windows', arch: 'aarch64', kind: 'installer' },
  'android-aarch64': { os: 'android', arch: 'aarch64', kind: 'apk' },
  'android-armv7': { os: 'android', arch: 'armv7', kind: 'apk' },
  'linux-x86_64': { os: 'linux', arch: 'x86_64', kind: 'appimage' },
  'darwin-aarch64': { os: 'darwin', arch: 'aarch64', kind: 'app' },
}

export function log(...args) {
  process.stdout.write(`${args.join(' ')}\n`)
}

export function fail(message) {
  process.stderr.write(`\n✖ ${message}\n\n`)
  process.exit(1)
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (c) => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 调 tauri CLI（本地 devDependency 优先，回落全局）。
 *  默认静默：签名命令会把整份签名原文打到 stdout，几千行噪声会淹掉发布日志；
 *  只有失败时才把输出倒出来。 */
function tauriCli(args, opts = {}) {
  const local = path.join(REPO_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  const cmd = fs.existsSync(local) ? process.execPath : 'tauri'
  const argv = fs.existsSync(local) ? [local, ...args] : args
  const res = spawnSync(cmd, argv, { cwd: REPO_ROOT, encoding: 'utf8', ...opts })
  if (res.status !== 0) {
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    throw new Error(`tauri ${args.join(' ')} 失败（退出码 ${res.status}）`)
  }
}

/** 生成更新签名密钥对。返回 { publicKey }（base64，可直接写进配置/代码）。 */
export function generateKeypair({ keyPath, password }) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  const out = spawnSync(
    process.execPath,
    [
      fs.existsSync(path.join(REPO_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'))
        ? path.join(REPO_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
        : 'tauri',
      'signer',
      'generate',
      '-w',
      keyPath,
      '-p',
      password,
      '--ci',
      '--force',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  if (out.status !== 0) {
    throw new Error(`生成密钥失败：${out.stderr || out.stdout}`)
  }
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`

  // 新版 CLI 把公钥写进 <key>.pub（内容是 base64 的两行 minisign 公钥文本，
  // 也正是 tauri.conf.json 的 pubkey 需要的字符串）；老版本直接打印在 stdout。
  const pubFile = `${keyPath}.pub`
  if (fs.existsSync(pubFile)) {
    return { publicKey: fs.readFileSync(pubFile, 'utf8').trim() }
  }
  const match = /Public key:\s*(\S+)/.exec(text)
  if (!match) throw new Error(`未能从输出里解析公钥：\n${text}`)
  return { publicKey: match[1] }
}

/**
 * 对文件签名。
 *
 * 返回的 `signature` 就是清单 `signature` 字段该填的东西 —— **.sig 文件的内容原样**。
 * 别再加一层 base64：新版 tauri CLI 写出的 .sig 文件本身已经是 base64(minisign 文本)，
 * 老版本是明文四行。两代格式客户端都会认（服务端解析器也都能吃），
 * 但「原样搬运」是唯一在两代之间都正确的做法。
 */
export function signFile(file, { keyPath, password }) {
  const hasEnvKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY)
  if (!fs.existsSync(keyPath) && !hasEnvKey) {
    throw new Error(
      `私钥不存在：${keyPath}\n  本机先跑：node scripts/release/keygen.mjs\n  CI 里用 Secret: TAURI_SIGNING_PRIVATE_KEY`,
    )
  }
  // 空口令时不要传 -p：tauri CLI 收到空串会当成「口令不匹配」而报错。
  // 私钥来源二选一：文件路径（本机）或 TAURI_SIGNING_PRIVATE_KEY 环境变量（CI），
  // 两者都不传时 CLI 自己读环境变量。
  const args = ['signer', 'sign']
  if (fs.existsSync(keyPath)) args.push('-f', keyPath)
  if (password) args.push('-p', password)
  args.push(file)
  tauriCli(args)
  const sigFile = `${file}.sig`
  if (!fs.existsSync(sigFile)) throw new Error(`签名未生成：${sigFile}`)
  return { signature: fs.readFileSync(sigFile, 'utf8').trim(), sigFile }
}

/** 对一段文本（清单原文）签名。 */
export function signText(text, { keyPath, password, label = 'manifest.json' }) {
  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'rein-sign-'))
  const tmpFile = path.join(tmpDir, label)
  fs.writeFileSync(tmpFile, text, 'utf8')
  try {
    return signFile(tmpFile, { keyPath, password })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

export function formatSize(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 读发布配置（环境变量优先，其次 scripts/release/release.config.json）。 */
export function loadReleaseConfig() {
  const file = path.join(REPO_ROOT, 'scripts', 'release', 'release.config.json')
  const fromFile = fs.existsSync(file) ? readJson(file) : {}
  const keyPath =
    process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ??
    fromFile.keyPath ??
    path.join(REPO_ROOT, 'src-tauri', 'keys', 'rein-update.key')

  // 口令优先级：环境变量（CI）> release.config.json > keygen 落在私钥旁边的口令文件（本机）
  let keyPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? fromFile.keyPassword ?? ''
  if (!keyPassword) {
    const pwFile = `${keyPath}.password`
    if (fs.existsSync(pwFile)) {
      const line = fs
        .readFileSync(pwFile, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .pop()
      if (line) keyPassword = line
    }
  }

  return {
    // 清单里写出去的地址（客户端要能访问到）
    serverBaseUrl: process.env.REIN_UPDATE_BASE_URL ?? fromFile.serverBaseUrl ?? 'http://47.100.36.179:8787',
    // 发布时管理接口实际连的地址。默认同上；安全组尚未放行时用 SSH 隧道把上传走
    // 127.0.0.1，而清单里仍写公网地址 —— 两件事分开，才不用为了发一版去开端口。
    uploadBaseUrl:
      process.env.REIN_UPDATE_UPLOAD_URL ??
      fromFile.uploadBaseUrl ??
      process.env.REIN_UPDATE_BASE_URL ??
      fromFile.serverBaseUrl ??
      'http://47.100.36.179:8787',
    adminToken: process.env.REIN_UPDATE_TOKEN ?? fromFile.adminToken ?? '',
    githubRepo: process.env.REIN_GITHUB_REPO ?? fromFile.githubRepo ?? GITHUB_REPO,
    channel: process.env.REIN_RELEASE_CHANNEL ?? fromFile.channel ?? 'stable',
    keyPath,
    keyPassword,
  }
}

export function setNested(obj, dotted, value) {
  const parts = dotted.split('.')
  let cur = obj
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}
    cur = cur[p]
  }
  cur[parts.at(-1)] = value
  return obj
}
