#!/usr/bin/env node
/**
 * IPC 契约守护：命令的「三处同步」不再只写在文档里（ARCHITECTURE §3 / STANDARDS §3），
 * 而是变成一条可执行的断言（`npm run contract`，CI 同跑）。
 *
 * 三方集合必须完全一致：
 *   1. Rust：src-tauri/src/lib.rs 的 generate_handler![...]
 *   2. 前端：src/services/*.ts 与 src/**\/*.vue 里 invoke('<cmd>') / invoke<T>('<cmd>') 的命令名
 *      （第二窗口如 src/float/FloatApp.vue 不经过 service，直接 invoke）
 *   3. mock：src/mock/server.ts **顶层** switch 的 case '<cmd>'
 *      （4 空格缩进；更深的缩进是命令内部 switch 的分支，不是命令）
 *
 * 任一方多一条或少一条都会红着退出 —— 漏一处以前要跑到运行时才发现。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Rust：generate_handler![...] 里每个 `a::b::c::cmd,` 的末段 */
function rustCommands() {
  const src = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
  const block = src.match(/generate_handler!\[([\s\S]*?)\n\s*\]\)/)
  if (!block) throw new Error('lib.rs 里找不到 generate_handler![…] 代码块')
  const out = new Set()
  for (const m of block[1].matchAll(/::([a-z][a-z0-9_]*)\s*,\s*$/gm)) out.add(m[1])
  return out
}

/** 收集一份源码里的 invoke<…>('cmd') / invoke('cmd') 命令名 */
function collectInvokes(src, out) {
  for (const m of src.matchAll(/\binvoke\s*(?:<[\s\S]*?>)?\s*\(\s*'([a-z][a-z0-9_]+)'/g)) {
    out.add(m[1])
  }
}

/** src 下所有 .vue（独立 Tauri 窗口可能直接 invoke，不经过 services） */
function walkVue(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkVue(path, out)
    else if (entry.name.endsWith('.vue')) out.push(path)
  }
  return out
}

/** 前端 services + 独立窗口里的直接 invoke，第一个字面量参数 */
function serviceCommands() {
  const dir = join(root, 'src/services')
  const out = new Set()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue
    collectInvokes(readFileSync(join(dir, file), 'utf8'), out)
  }
  // 契约守护要盯住**所有**直接调用点：`src/float/FloatApp.vue` 这类第二窗口
  // 不经过 service，漏扫时命令可以只在 Rust + mock 存在而在真实前端无人调用。
  for (const file of walkVue(join(root, 'src'))) {
    collectInvokes(readFileSync(file, 'utf8'), out)
  }
  return out
}

/** mock：顶层 switch 的 case（恰好 4 空格缩进） */
function mockCommands() {
  const src = readFileSync(join(root, 'src/mock/server.ts'), 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/^ {4}case '([a-z][a-z0-9_]+)':/gm)) out.add(m[1])
  return out
}

const rust = rustCommands()
const svc = serviceCommands()
const mock = mockCommands()

const problems = []
for (const c of rust) {
  if (!svc.has(c)) problems.push(`services 缺 ${c}（Rust 已注册）`)
  if (!mock.has(c)) problems.push(`mock 缺 ${c}（Rust 已注册）`)
}
for (const c of svc) if (!rust.has(c)) problems.push(`Rust 未注册 ${c}（services 已在调）`)
for (const c of mock) if (!rust.has(c)) problems.push(`Rust 未注册 ${c}（mock 已实现）`)

console.log(`命令数：Rust ${rust.size} / services ${svc.size} / mock ${mock.size}`)
if (problems.length > 0) {
  console.error('\nIPC 契约不一致：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\n新增命令必须三处同步：modules/x/commands.rs ↔ lib.rs ↔ services/xService.ts（mock 补同名实现）。',
  )
  process.exit(1)
}
console.log('IPC 契约一致 ✓')
