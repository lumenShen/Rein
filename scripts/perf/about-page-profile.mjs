/**
 * 「关于你」页面性能断点采集（无头 Edge + 原生 CDP + CPU profile + Tracing）。
 *
 * 采集三段时间的证据：
 *   A 进入页面：主页 →「关于你」（真实应用内导航，hash 路由）
 *   B 页面静止后的滚动：连续滚轮，量帧与光栅成本
 *   C 文件夹详情：/me/folder?key=health（kb_list_dir + 摘要 kb_read 链路）
 *
 * 产物：<out>/profile.json（CPU 采样聚合）、trace.json（关键事件）、summary.txt
 *
 * 用法（由 e2e-run 起服）：
 *   node scripts/e2e-run.mjs scripts/perf/about-page-profile.mjs
 * 或复用已在跑的服：
 *   REIN_E2E_URL=http://127.0.0.1:17420 node scripts/perf/about-page-profile.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const BROWSER = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('找不到 Edge/Chrome')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const VIEWPORT = process.env.REIN_PERF_VIEWPORT ?? 'mobile'
const OUT = process.env.REIN_PERF_OUT ?? `${process.env.TEMP}/rein-perf-about-${Date.now()}`
mkdirSync(OUT, { recursive: true })
const USER_DATA = `${OUT}/profile-data`
const PORT = 9600 + (process.pid % 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DIM = VIEWPORT === 'desktop'
  ? { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }
  : { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }

let ws
let msgId = 0
const pending = new Map()
const events = []
function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}
async function waitFor(expr, timeoutMs = 15000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return Date.now() - t0
    } catch { /* 导航中 */ }
    await sleep(80)
  }
  const state = await evalJS(`JSON.stringify({
    href: location.href,
    ready: document.readyState,
    pages: document.querySelectorAll('.page').length,
    testids: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).slice(0, 20),
    text: (document.querySelector('#app')?.innerText ?? '').slice(0, 200),
  })`).catch(() => 'n/a')
  throw new Error(`等待超时: ${label} — ${state}`)
}

/* ---------------- 启动浏览器 ---------------- */

const proc = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DATA}`,
  '--no-first-run',
  '--disable-extensions',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  `--window-size=${DIM.width},${DIM.height}`,
  'about:blank',
], { stdio: 'ignore' })

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const target = list.find((t) => t.type === 'page')
      if (target) {
        ws = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id) }
          else if (m.method) {
            events.push(m)
            if (m.method === 'Runtime.exceptionThrown') {
              console.error('[page exception]', m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text)
            }
            if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
              console.error('[page console.error]', (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
            }
          }
        }
        return
      }
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('连不上 CDP')
}

/* ---------------- 采样聚合 ---------------- */

function aggregateProfile(profile) {
  // nodeId → 节点；timeDeltas[i] 是第 i 个采样距上一次的微秒数
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map() // key → { fn, url, line, selfUs, count }
  let parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

  let prev = profile.startTime
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    const t = profile.timeDeltas[i] ?? 0
    prev += t
    const n = byId.get(id)
    if (!n) continue
    const cf = n.callFrame
    const fn = cf.functionName || '(anonymous)'
    const url = (cf.url || '').replace(APP, '').replace(/^https?:\/\/[^/]+/, '')
    const key = `${fn} @ ${url}:${(cf.lineNumber ?? -1) + 1}`
    const rec = self.get(key) ?? { fn, url, line: (cf.lineNumber ?? -1) + 1, selfUs: 0, count: 0 }
    rec.selfUs += t
    rec.count += 1
    self.set(key, rec)
  }
  const rows = [...self.values()].sort((a, b) => b.selfUs - a.selfUs)
  const total = rows.reduce((s, r) => s + r.selfUs, 0)
  return { rows, totalUs: total }
}

/** 从 trace 事件里汇总主线程各类开销（µs） */
function aggregateTrace(traceEvents) {
  const sum = {}
  const top = []
  for (const e of traceEvents) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    const name = e.name
    sum[name] = (sum[name] ?? 0) + e.dur
    if (e.dur >= 2000) {
      top.push({
        name,
        dur_us: e.dur,
        tid: e.tid,
        url: e.args?.data?.url ? String(e.args.data.url).replace(APP, '') : undefined,
        fn: e.args?.data?.functionName,
        line: e.args?.data?.lineNumber != null ? e.args.data.lineNumber + 1 : undefined,
        type: e.args?.data?.type,
        detail: e.args?.data?.beginData?.url ?? e.args?.data?.beginData?.functionName,
      })
    }
  }
  top.sort((a, b) => b.dur_us - a.dur_us)
  return { sum, top }
}

/* ---------------- 初始化脚本（里程碑） ---------------- */

const INIT = `
window.__PERF__ = { longTasks: [], marks: {} };
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__PERF__.longTasks.push({ start: e.startTime, dur: e.duration, name: e.name });
  }).observe({ type: 'longtask', buffered: true });
} catch {}
window.__mark = (k) => { window.__PERF__.marks[k] = performance.now(); };
`
const MARK_TREE = `
(() => {
  const q = (s) => document.querySelector(s);
  const done = {};
  const tick = () => {
    const page = q('[data-testid="about-page"]');
    if (page && !done.page) { done.page = 1; __mark('about-page'); }
    const folder = q('[data-testid="about-folder-page"]');
    if (folder && !done.folder) { done.folder = 1; __mark('about-folder'); }
    const mem = q('[data-testid="about-memory-card"]');
    if (page && mem && !q('.mskel') && !done.mem) { done.mem = 1; __mark('memory-settled'); }
    const list = q('[data-testid="about-folder-list"]');
    if (folder && list && !q('.skel-entry') && !done.list) { done.list = 1; __mark('folder-settled'); }
    if (!done.__raf) {
      done.__raf = 1;
      requestAnimationFrame(() => { requestAnimationFrame(() => { __mark('next-frame'); done.__raf = 0; }); });
    }
  };
  const mo = new MutationObserver(tick);
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'class'] });
  tick();
})();
`

/* ---------------- 主流程 ---------------- */

const report = {}

async function startRecording({ trace = true, profiler = true } = {}) {
  events.length = 0
  if (trace) {
    await cdp('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: {
        includedCategories: [
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'blink.user_timing',
          'v8',
          'cc',
          'viz',
          'benchmark',
        ],
      },
    })
  }
  if (profiler) {
    await cdp('Profiler.enable')
    await cdp('Profiler.setSamplingInterval', { interval: 100 })
    await cdp('Profiler.start')
  }
}

async function stopRecording() {
  let profile = null
  if (events.length >= 0) {
    try { profile = (await cdp('Profiler.stop')).profile } catch { /* not started */ }
  }
  const traceEvents = []
  const done = new Promise((r) => {
    const timer = setTimeout(r, 5000)
    const handler = (e) => {
      const m = JSON.parse(e.data)
      if (m.method === 'Tracing.tracingComplete') {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        r()
      }
    }
    ws.addEventListener('message', handler)
  })
  await cdp('Tracing.end')
  await done
  for (const m of events) {
    if (m.method === 'Tracing.dataCollected') traceEvents.push(...(m.params.value ?? []))
  }
  return { profile, traceEvents }
}

try {
  await connect()
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', DIM)
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT })

  // 先到主页，让应用外壳与路由就绪。
  // vite 首次按需优化依赖会触发一次整页 reload，导航可能落在旧上下文上；
  // 等不到就 reload 一次再等（冷启动的抖动，不代表页面本身慢）。
  await cdp('Page.navigate', { url: `${APP}/#/` })
  try {
    await waitFor(`!!document.querySelector('[data-testid="home-page"], .page')`, 20000, '主页就绪')
  } catch {
    await cdp('Page.reload', { ignoreCache: false })
    await waitFor(`!!document.querySelector('[data-testid="home-page"], .page')`, 40000, '主页就绪（reload 后）')
  }
  await sleep(1200)

  /* ---- A. 主页 → 关于你 ---- */
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: MARK_TREE })
  await evalJS(MARK_TREE)
  await evalJS(`window.__PERF__ = { longTasks: [], marks: {} }; window.__perfT0 = performance.now()`)
  await startRecording()
  await evalJS(`location.hash = '#/me'`)
  const tPage = await waitFor(`!!document.querySelector('[data-testid="about-page"]')`, 15000, '关于你挂载')
  await waitFor(`!!document.querySelector('[data-testid="about-memory-card"]') && !document.querySelector('.mskel')`, 15000, '记忆卡结算')
  await sleep(500)
  const snapshotA = await evalJS(`({ marks: window.__PERF__.marks, longTasks: window.__PERF__.longTasks, t0: window.__perfT0 })`)
  const recA = await stopRecording()
  report.enterMs = tPage
  report.milestones = snapshotA
  report.enter = {
    profile: aggregateProfile(recA.profile),
    trace: aggregateTrace(recA.traceEvents),
  }
  writeFileSync(`${OUT}/trace-enter.json`, JSON.stringify(recA.traceEvents))

  /* ---- B. 滚动 ---- */
  await evalJS(`window.__PERF__ = { longTasks: [], marks: {} }`)
  const rafMs = await evalJS(`new Promise((resolve) => {
    const out = []
    let last = performance.now()
    let n = 0
    const step = () => {
      const now = performance.now()
      out.push(now - last)
      last = now
      window.scrollBy(0, 28)
      if (++n < 90) requestAnimationFrame(step)
      else resolve(out)
    }
    requestAnimationFrame(step)
  })`)
  await startRecording()
  await evalJS(`(async () => {
    for (let i = 0; i < 14; i++) {
      window.scrollBy(0, 40)
      await new Promise((r) => requestAnimationFrame(r))
    }
    window.scrollTo(0, 0)
  })()`)
  await sleep(300)
  const recB = await stopRecording()
  report.scroll = {
    raf: summarize(rafMs),
    trace: aggregateTrace(recB.traceEvents),
  }
  writeFileSync(`${OUT}/trace-scroll.json`, JSON.stringify(recB.traceEvents))

  /* ---- C. 文件夹详情（健康） ---- */
  await evalJS(`window.__PERF__ = { longTasks: [], marks: {} }; window.__perfT0 = performance.now()`)
  await startRecording()
  await evalJS(`location.hash = '#/me/folder?key=health'`)
  await waitFor(`!!document.querySelector('[data-testid="about-folder-page"]')`, 15000, '文件夹挂载')
  await waitFor(`!!document.querySelector('[data-testid="about-folder-list"]') && !document.querySelector('.skel-entry')`, 20000, '文件夹结算')
  await sleep(800)
  const snapshotC = await evalJS(`({ marks: window.__PERF__.marks, longTasks: window.__PERF__.longTasks, t0: window.__perfT0 })`)
  const recC = await stopRecording()
  report.folder = {
    milestones: snapshotC,
    profile: aggregateProfile(recC.profile),
    trace: aggregateTrace(recC.traceEvents),
  }
  writeFileSync(`${OUT}/trace-folder.json`, JSON.stringify(recC.traceEvents))

  /* ---- D. 各分组文件夹的行数与结算时长（不抓 trace，只看真实渲染量） ---- */
  report.folderRows = {}
  for (const key of ['corner', 'life', 'notes', 'health', 'voice', 'about']) {
    await evalJS(`window.__PERF__ = { longTasks: [], marks: {} }; window.__perfT0 = performance.now()`)
    const t0 = Date.now()
    await evalJS(`location.hash = '#/me/folder?key=${key}'`)
    // 同一个组件复用（只换 query）：必须等 data-group-key 真的切过去，否则读到的是上一页的 DOM
    await waitFor(
      `document.querySelector('[data-testid="about-folder-page"]')?.getAttribute('data-group-key') === ${JSON.stringify(key)}`,
      15000,
      `${key} 挂载`,
    )
    await waitFor(
      `!!document.querySelector('[data-testid="about-folder-list"]') && !document.querySelector('.skel-entry')`,
      20000,
      `${key} 结算`,
    )
    await sleep(350)
    const info = await evalJS(`(() => {
      const rows = document.querySelectorAll('[data-testid="about-folder-list"] .entry').length
      const marks = window.__PERF__.marks
      const sett = marks['folder-settled'] != null && marks['about-folder'] != null ? marks['folder-settled'] - marks['about-folder'] : null
      return { rows, settleMs: sett, longTasks: window.__PERF__.longTasks }
    })()`)
    report.folderRows[key] = { ...info, wallMs: Date.now() - t0 }
    await sleep(120)
  }

  /* ---- 报告 ---- */
  const lines = []
  const p = (s) => { lines.push(s); console.log(s) }
  p(`\n===== 关于你性能断点（${VIEWPORT} ${DIM.width}x${DIM.height}）=====`)
  p(`\n[A] 进入页面：导航→挂载 ${report.enterMs}ms`)
  p(`里程碑 ${JSON.stringify(report.milestones.marks)}`)
  p(`长任务 ${JSON.stringify(report.milestones.longTasks)}`)
  p(`\n[A] 自耗时 Top 30（µs）  总采样 ${(report.enter.profile.totalUs / 1000).toFixed(0)}ms`)
  for (const r of report.enter.profile.rows.slice(0, 30)) {
    p(`  ${(r.selfUs / 1000).toFixed(1).padStart(8)}ms  ${String(r.count).padStart(4)}x  ${r.fn}  ${r.url}:${r.line}`)
  }
  p(`\n[A] 引擎事件 > 2ms Top 20`)
  for (const e of report.enter.trace.top.slice(0, 20)) {
    p(`  ${(e.dur_us / 1000).toFixed(1).padStart(8)}ms  ${e.name}  ${e.fn ?? ''} ${e.url ?? ''}`)
  }
  p(`\n[A] 各阶段合计（ms，Top 20）`)
  const stageRows = Object.entries(report.enter.trace.sum).sort((a, b) => b[1] - a[1]).slice(0, 20)
  for (const [k, v] of stageRows) p(`  ${(v / 1000).toFixed(1).padStart(8)}ms  ${k}`)
  p(`\n[B] 滚动 rAF 间隔：${JSON.stringify(report.scroll.raf)}`)
  const raster = Object.entries(report.scroll.trace.sum)
    .filter(([k]) => /Raster|Paint|Commit|Layerize|PrePaint|Layout|UpdateLayoutTree|FunctionCall|EvaluateScript/.test(k))
    .sort((a, b) => b[1] - a[1])
  for (const [k, v] of raster.slice(0, 12)) p(`  ${(v / 1000).toFixed(1).padStart(8)}ms  ${k}`)
  p(`\n[C] 文件夹详情：里程碑 ${JSON.stringify(report.folder.milestones.marks)}`)
  p(`长任务 ${JSON.stringify(report.folder.milestones.longTasks)}`)
  p(`\n[C] 自耗时 Top 30`)
  for (const r of report.folder.profile.rows.slice(0, 30)) {
    p(`  ${(r.selfUs / 1000).toFixed(1).padStart(8)}ms  ${String(r.count).padStart(4)}x  ${r.fn}  ${r.url}:${r.line}`)
  }
  p(`\n[C] 引擎事件 > 2ms Top 20`)
  for (const e of report.folder.trace.top.slice(0, 20)) {
    p(`  ${(e.dur_us / 1000).toFixed(1).padStart(8)}ms  ${e.name}  ${e.fn ?? ''} ${e.url ?? ''}`)
  }
  p(`\n[D] 各分组文件夹：行数 / 结算 / 长任务`)
  for (const [k, v] of Object.entries(report.folderRows)) {
    p(`  ${k.padEnd(8)} rows=${String(v.rows).padStart(4)}  settle=${v.settleMs == null ? '—' : v.settleMs.toFixed(1) + 'ms'}  wall=${v.wallMs}ms  longTasks=${v.longTasks.length}`)
  }
  writeFileSync(`${OUT}/summary.txt`, lines.join('\n'))
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  p(`\n产物目录：${OUT}`)
} catch (e) {
  console.error('采集失败：', e)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
}

function summarize(arr) {
  const a = arr.slice().sort((x, y) => x - y)
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0
  const avg = a.reduce((s, v) => s + v, 0) / (a.length || 1)
  return {
    n: a.length,
    avg: +avg.toFixed(2),
    p50: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +(a.at(-1) ?? 0).toFixed(2),
    over33: a.filter((v) => v > 33.4).length,
  }
}
