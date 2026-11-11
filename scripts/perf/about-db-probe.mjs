/**
 * 「关于你」后端热点的独立计时：直接在**生产库副本**上跑与 Rust 命令同形的 SQL。
 *
 * 用法：node scripts/perf/about-db-probe.mjs <dbPath> [repeat]
 * 只读意图，但 WAL 恢复需要写权限 —— 传副本，不要传生产库。
 */
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'

const dbPath = process.argv[2]
const repeat = Number(process.argv[3] ?? 20)
if (!dbPath) {
  console.error('usage: node about-db-probe.mjs <dbPath> [repeat]')
  process.exit(2)
}

const db = new DatabaseSync(dbPath)
const out = []

function time(name, fn, n = repeat) {
  // 预热 2 次
  for (let i = 0; i < 2; i++) fn()
  const samples = []
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const med = samples[Math.floor(samples.length / 2)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  const row = { name, median_ms: +med.toFixed(3), p95_ms: +p95.toFixed(3), max_ms: +samples.at(-1).toFixed(3) }
  out.push(row)
  console.log(`${row.name.padEnd(46)} med ${row.median_ms.toString().padStart(9)} ms  p95 ${row.p95_ms.toString().padStart(9)} ms  max ${row.max_ms.toString().padStart(9)} ms`)
}

/* ---------- 数据规模 ---------- */
const counts = {}
for (const t of ['kb_docs', 'kb_files', 'kb_assets', 'kb_chunks', 'kb_memories', 'health_metrics', 'workouts', 'kb_fts_data']) {
  try {
    counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  } catch (e) {
    counts[t] = `ERR ${e.message}`
  }
}
console.log('=== 规模 ===')
for (const [k, v] of Object.entries(counts)) console.log(`${k.padEnd(18)} ${v}`)
console.log(`db bytes           ${statSync(dbPath).size}`)
console.log('')

const COLS = 'id, mem_type, topic, category, content, confidence, active_count, source_chat_id, created_at, updated_at, last_used_at, archived_at, archived_reason'
const IDLE = "(julianday('now') - julianday(COALESCE(last_used_at, updated_at, created_at)))"

/* ---------- 记忆三连：页面同时发三条命令，每条都全量拉活跃记忆 ---------- */
time('kb_memories(active) 全量行 + salience', () => {
  db.prepare(`SELECT ${COLS}, ${IDLE} AS idle_days FROM kb_memories WHERE archived_at IS NULL ORDER BY (archived_at IS NOT NULL), updated_at DESC, id DESC`).all()
})
time('kb_memory_stats 的 active_with_idle', () => {
  db.prepare(`SELECT ${COLS}, ${IDLE} AS idle_days FROM kb_memories WHERE archived_at IS NULL`).all()
})
time('kb_cognition 的 active_with_idle（同一条）', () => {
  db.prepare(`SELECT ${COLS}, ${IDLE} AS idle_days FROM kb_memories WHERE archived_at IS NULL`).all()
})

/* ---------- 根目录列举：listing::list_dir('') ---------- */
const MAX_SCAN = 20000
time('list_dir("") docs 前缀扫描', () => {
  db.prepare('SELECT id, path, source_type, title, kind, editable, system, occurred_on, updated_at FROM kb_docs WHERE path >= ?1 AND path < ?2 ORDER BY path LIMIT ?3').all('', '\u{10FFFF}', MAX_SCAN + 1)
})
time('list_dir("") nodes 前缀扫描（LENGTH(content)）', () => {
  db.prepare("SELECT id, path, kind, system, pinned, classify_state, updated_at, LENGTH(CAST(content AS BLOB)), rating, tags, (note <> '') FROM kb_files WHERE path >= ?1 AND path < ?2 AND trashed_at IS NULL ORDER BY path LIMIT ?3").all('', '\u{10FFFF}', MAX_SCAN + 1)
})
time('list_dir("") assets JOIN 扫描', () => {
  db.prepare('SELECT a.file_id, a.modal, a.bytes FROM kb_assets a JOIN kb_files f ON f.id = a.file_id WHERE f.path >= ?1 AND f.path < ?2 AND f.trashed_at IS NULL ORDER BY a.file_id, a.modal LIMIT ?3').all('', '\u{10FFFF}', MAX_SCAN + 1)
})

/* 各分组的真实 root */
const roots = ['用户记忆', '体测', '运动', '方案', '日程', '饮食', '语音', '笔记', '文档', '未分类数据', '记忆', '对话', '附件']
console.log('\n=== 逐分组 root 列举（时间总量 = 详情页一次加载） ===')
let rootTotal = 0
for (const root of roots) {
  const lo = `${root}/`
  const hi = `${lo}\u{10FFFF}`
  let ms = 0
  let nDocs = 0
  let nNodes = 0
  const t0 = process.hrtime.bigint()
  const docs = db.prepare('SELECT id, path, source_type, title, kind, editable, system, occurred_on, updated_at FROM kb_docs WHERE path >= ?1 AND path < ?2 ORDER BY path LIMIT ?3').all(lo, hi, MAX_SCAN + 1)
  const nodes = db.prepare("SELECT id, path, kind, system, pinned, classify_state, updated_at, LENGTH(CAST(content AS BLOB)), rating, tags, (note <> '') FROM kb_files WHERE path >= ?1 AND path < ?2 AND trashed_at IS NULL ORDER BY path LIMIT ?3").all(lo, hi, MAX_SCAN + 1)
  const assets = db.prepare('SELECT a.file_id, a.modal, a.bytes FROM kb_assets a JOIN kb_files f ON f.id = a.file_id WHERE f.path >= ?1 AND f.path < ?2 AND f.trashed_at IS NULL ORDER BY a.file_id, a.modal LIMIT ?3').all(lo, hi, MAX_SCAN + 1)
  ms = Number(process.hrtime.bigint() - t0) / 1e6
  nDocs = docs.length
  nNodes = nodes.length
  rootTotal += ms
  console.log(`${root.padEnd(10)} ${ms.toFixed(2).padStart(9)} ms  docs=${String(nDocs).padStart(5)} nodes=${String(nNodes).padStart(5)} assets=${String(assets.length).padStart(5)}`)
}
console.log(`roots total ${rootTotal.toFixed(2)} ms`)

/* ---------- d_bytes 的 N+1：派生文档且无文件节点时逐行查询 ---------- */
const docOnly = db.prepare(`SELECT d.id FROM kb_docs d LEFT JOIN kb_files f ON f.path = d.path WHERE f.id IS NULL LIMIT 200`).all()
console.log(`\n派生文档缺文件节点（逐行 d_bytes N+1 的受害行）样本 ${docOnly.length}`)
if (docOnly.length) {
  time('d_bytes N+1 × 200', () => {
    const stmt = db.prepare('SELECT LENGTH(CAST(body AS BLOB)) FROM kb_docs WHERE id = ?1')
    for (const r of docOnly) stmt.get(r.id)
  })
}

/* ---------- 健康指标 ---------- */
time('health_metrics_all 全表（ORDER BY metric, day）', () => {
  db.prepare('SELECT metric, day, value FROM health_metrics ORDER BY metric, day').all()
})

/* ---------- 用户资料：前端 nutrition store 的 loadProfile ---------- */
for (const sql of [
  ['SELECT * FROM nutrition_profile LIMIT 1', 'nutrition_profile 单行'],
]) {
  try {
    time(sql[1], () => db.prepare(sql[0]).all())
  } catch (e) {
    console.log(`${sql[1]} ERR ${e.message}`)
  }
}

/* ---------- 索引存在性 ---------- */
console.log('\n=== 相关索引 ===')
for (const r of db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('kb_docs','kb_files','kb_assets','kb_memories','health_metrics')").all()) {
  console.log(`${r.tbl_name.padEnd(14)} ${r.name}  ${r.sql ?? '(auto)'}`)
}

console.log('\n=== 查询计划 ===')
for (const [label, sql, args] of [
  ['kb_docs path range', 'SELECT id FROM kb_docs WHERE path >= ?1 AND path < ?2 ORDER BY path', ['', '\u{10FFFF}']],
  ['kb_files path range', 'SELECT id FROM kb_files WHERE path >= ?1 AND path < ?2 AND trashed_at IS NULL ORDER BY path', ['', '\u{10FFFF}']],
  ['assets join', 'SELECT a.file_id FROM kb_assets a JOIN kb_files f ON f.id = a.file_id WHERE f.path >= ?1 AND f.path < ?2', ['', '\u{10FFFF}']],
  ['memories active', 'SELECT id FROM kb_memories WHERE archived_at IS NULL', []],
  ['health metrics', 'SELECT metric, day, value FROM health_metrics ORDER BY metric, day', []],
]) {
  console.log(`-- ${label}`)
  for (const r of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)) console.log(`   ${r.detail}`)
}

db.close()
