/**
 * 拉取 ONNX Runtime 运行库（端侧 embedding 的推理后端，见 modules/kb）。
 *
 * 采用 load-dynamic（而非 link-time 链接），所以运行库由我们显式供给、显式加载：
 *   - Windows：落到 src-tauri/resources/ort/<target>/，由 tauri bundle.resources 随包分发，
 *     运行时经 resolve_resource 定位后 ort::init_from()。
 *   - Android：落到 gen/android/app/src/main/jniLibs/arm64-v8a/，由 gradle 自动打进 APK。
 *
 * 版本固定为 ORT 1.28.x —— ort 2.0.0-rc.13 包装的就是 ORT 1.28，load-dynamic 下必须对齐次版本。
 * 产物在 .gitignore 里，克隆仓库后先跑一次本脚本再构建。
 *
 * 用法：node scripts/fetch-ort-runtime.mjs [--target win-x64|win-arm64|android-arm64|all] [--force]
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
  copyFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const winOut = join(root, 'src-tauri', 'resources', 'ort')
const androidOut = join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'jniLibs', 'arm64-v8a')

const ORT_VERSION = '1.28.0'
// GitHub Release 未提供 1.28.x Windows CPU 资产，改从同版本官方 NuGet 包取 DLL。
const ANDROID_ORT_VERSION = '1.28.0' // Maven 上 android 制品滞后于 GitHub release
const WINDOWS_ORT_PACKAGE = `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${ORT_VERSION}/microsoft.ml.onnxruntime.${ORT_VERSION}.nupkg`

const TARGETS = {
  'win-x64': {
    archive: WINDOWS_ORT_PACKAGE,
    want: 'onnxruntime.dll',
    dest: join(winOut, 'win-x64', 'onnxruntime.dll'),
    label: 'Windows x64',
  },
  'win-arm64': {
    archive: WINDOWS_ORT_PACKAGE,
    want: 'onnxruntime.dll',
    dest: join(winOut, 'win-arm64', 'onnxruntime.dll'),
    label: 'Windows ARM64',
  },
  'android-arm64': {
    archive: `https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/${ANDROID_ORT_VERSION}/onnxruntime-android-${ANDROID_ORT_VERSION}.aar`,
    want: 'libonnxruntime.so',
    dest: join(androidOut, 'libonnxruntime.so'),
    label: 'Android arm64-v8a',
  },
}

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const tIdx = argv.indexOf('--target')
const picked = tIdx >= 0 ? argv[tIdx + 1] : 'all'
const names = picked === 'all' ? Object.keys(TARGETS) : [picked]

for (const n of names) {
  if (!TARGETS[n]) {
    console.error(`未知 target: ${n}（可选 ${Object.keys(TARGETS).join('|')}|all）`)
    process.exit(1)
  }
}

function fmt(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 可续传下载：以 Range 从已下载偏移继续，断流后退避重试。
 * GitHub release 的 79MB 压缩包实测会中途断连，一次性下载不可靠。
 */
async function download(url, dest, expectedSize = 0) {
  const MAX_ATTEMPTS = 10
  let lastErr = ''
  let lastWritten = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let offset = existsSync(dest) ? statSync(dest).size : 0
    if (expectedSize && offset > expectedSize) {
      rmSync(dest, { force: true })
      offset = 0
    }
    if (expectedSize && offset === expectedSize) return

    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      })
      // 206 = 服务端接受续传；200 = 忽略 Range，需要从头来
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`)
      if (res.status === 200 && offset > 0) {
        rmSync(dest, { force: true })
        offset = 0
      }
      if (!res.body) throw new Error('响应无 body')

      // 发布包没有预先已知的大小，用响应头推导；206 时 Content-Length 只是本次分片，
      // 所以取 Content-Range 里的总长，拿不到就退化为「流自然结束即成功」。
      if (!expectedSize) {
        const cr = res.headers.get('content-range')
        const cl = res.headers.get('content-length')
        expectedSize = cr ? Number(cr.split('/')[1]) || 0 : Number(cl) || 0
      }

      let written = offset
      let lastTick = 0
      const fd = openSync(dest, offset > 0 ? 'a' : 'w')
      try {
        for await (const chunk of res.body) {
          writeSync(fd, chunk)
          written += chunk.length
          const now = Date.now()
          if (now - lastTick > 500) {
            lastTick = now
            process.stdout.write(`\r    下载 ${fmt(written)}   `)
          }
        }
      } finally {
        closeSync(fd)
      }
      lastWritten = written
      if (!expectedSize || written === expectedSize) {
        process.stdout.write(`\r    下载完成 ${fmt(written)}   \n`)
        return
      }
      lastErr = `连接提前结束（${fmt(written)}/${fmt(expectedSize)}）`
    } catch (e) {
      lastErr = e.message
    }

    if (attempt < MAX_ATTEMPTS) {
      process.stdout.write(`\r    重试 ${attempt}/${MAX_ATTEMPTS - 1}：${lastErr}   \n`)
      await sleep(1000 * attempt)
    }
  }
  throw new Error(`${lastErr}（已续传到 ${fmt(lastWritten)}，重试 ${MAX_ATTEMPTS} 次仍失败）`)
}

/** 在解压目录里按文件名递归查找。不硬编码包内路径，避免 ORT 改布局就崩。 */
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (e.name === name) {
      return p
    }
  }
  return null
}

async function fetchOne(key) {
  const t = TARGETS[key]
  const dest = t.dest

  if (!force && existsSync(dest) && statSync(dest).size > 1024 * 1024) {
    console.log(`  ✓ ${t.label} 已存在（${fmt(statSync(dest).size)}）`)
    return
  }

  const work = join(tmpdir(), `rein-ort-${key}-${Date.now()}`)
  const archive = join(work, 'archive')
  mkdirSync(work, { recursive: true })
  try {
    console.log(`  · ${t.label} ← ${new URL(t.archive).host}`)
    await download(t.archive, archive)

    // Windows 的 tar(bsdtar) 与 Linux 的 unzip 都能吃 zip；AAR 也是 zip。
    const ex = spawnSync('tar', ['-xf', archive, '-C', work], { stdio: 'pipe' })
    if (ex.status !== 0) {
      const ex2 = spawnSync('unzip', ['-q', '-o', archive, '-d', work], { stdio: 'pipe' })
      if (ex2.status !== 0) throw new Error(`解压失败：${(ex.stderr || ex2.stderr || '').toString().slice(0, 200)}`)
    }

    const found = findFile(work, t.want)
    if (!found) throw new Error(`压缩包内找不到 ${t.want}`)

    mkdirSync(dirname(dest), { recursive: true })
    const part = `${dest}.part`
    rmSync(part, { force: true })
    // 先复制再改名，避免中断留下半截文件被后续判断为“已存在”。
    copyFileSync(found, part)
    renameSync(part, dest)
    console.log(`  ✓ ${t.label} → ${t.want}（${fmt(statSync(dest).size)}）`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main() {
  console.log(`拉取 ONNX Runtime ${ORT_VERSION}${picked.includes('android') ? ` / Android ${ANDROID_ORT_VERSION}` : ''}`)
  for (const n of names) await fetchOne(n)
  console.log('\n完成。')
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`)
  process.exit(1)
})
