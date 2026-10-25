/**
 * HarmonyOS 对齐审查截图台。
 * 运行：node scripts/review-hw-shots.mjs [phone|desk|all] [routeName...]
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指过去）。
 * 产出：.zcode/shots/hw/{phone|desk}-{name}.png，逐路由视口截图。
 * 结构：无头 Edge + 原生 CDP（与 e2e-cdp.mjs 同一套驱动方式）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = '.zcode/shots/hw'
const USER_DATA = process.env.TEMP + '/rein-hw-shots-' + Date.now()

const VIEWS = {
  phone: { tag: 'phone', width: 430, height: 932, deviceScaleFactor: 2, mobile: true },
  desk: { tag: 'desk', width: 1512, height: 950, deviceScaleFactor: 1.5, mobile: false },
}

/** 路由清单：[文件名, hash 路由] */
const ROUTES = [
  ['home', '#/'],
  ['nutrition', '#/nutrition'],
  ['nutrition-adjust', '#/nutrition/adjust'],
  ['sports', '#/sports'],
  ['todos', '#/todos'],
  ['schedule', '#/campus/schedule'],
  ['ai', '#/ai'],
  ['models', '#/ai/models'],
  ['settings', '#/settings'],
  ['me', '#/me'],
  ['ledger', '#/ledger'],
  ['records', '#/sports/records'],
  ['program', '#/program'],
  ['focus', '#/focus'],
  ['files', '#/ai/files'],
  ['space', '#/ai/files/space'],
  ['perf', '#/settings/perf'],
  ['plans', '#/sports/plans'],
  ['exercises', '#/sports/exercises'],
  ['campus-settings', '#/campus/settings'],
  ['course-select', '#/campus/course-select'],
  ['grab-tasks', '#/campus/grab-tasks'],
  ['knowledge', '#/ai/knowledge'],
  ['features', '#/settings/features'],
  ['float', '#/settings/float'],
  ['sync', '#/settings/sync'],
  ['update', '#/settings/update'],
  ['record', '#/record'],
]

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

async function waitFor(expr, timeoutMs = 15000, label = expr.slice(0, 40)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evalJS('Boolean(' + expr + ')')) return true } catch { /* 导航中 */ }
    await sleep(150)
  }
  throw new Error('等待超时: ' + label)
}

/** 关掉挡在页面上的浮层（更新提示 / 引导 / toast）：截图前必须清场，
 *  否则每张图都被同一张对话框盖住。找不到就算了 —— 它们不是每次都出现。 */
async function dismissOverlays() {
  await evalJS(
    "(() => {" +
      "const pat = /^(稍后|跳过此版本|关闭|以后再说|取消|知道了|好的|暂不更新)$/;" +
      "const els = [...document.querySelectorAll('button, [role=button], a')];" +
      "let n = 0;" +
      "for (const el of els) {" +
      "  const t = (el.textContent || '').trim();" +
      "  if (pat.test(t) && el.getBoundingClientRect().width > 0) { el.click(); n++; }" +
      "}" +
      "return n;" +
    "})()",
  )
  await sleep(350)
  // 兜底：更新提示的根节点若还在（有些版本没有「稍后」按钮），直接把它从流里摘掉再截图
  await evalJS(
    "(() => { for (const el of document.querySelectorAll('.upd-mask, .update-mask, .updmask')) el.style.display = 'none'; return true })()",
  )
  await sleep(120)
}

async function injectStableCSS() {
  await evalJS(
    "(() => {" +
    "if (document.getElementById('__shot-stable')) return true;" +
    "const s = document.createElement('style');" +
    "s.id = '__shot-stable';" +
    "s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }';" +
    "document.head.appendChild(s); return true;" +
    "})()",
  )
}

/** 等 Edge 的调试端口起来：spawn 之后立刻 fetch 会 ECONNREFUSED（首启 1~3s）。 */
async function waitPort(port, timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version')
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('调试端口未就绪: ' + port)
}

const RESULTS = []

async function shot(name, hash, view) {
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: view.width, height: view.height, deviceScaleFactor: view.deviceScaleFactor, mobile: view.mobile,
  })
  await evalJS("location.hash = '" + hash + "'")
  await sleep(500)
  try {
    await waitFor("document.querySelector('.page, .desk-main, main') !== null", 12000, name + ' 挂载')
  } catch {
    await cdp('Page.reload')
    await sleep(700)
    await evalJS("location.hash = '" + hash + "'")
    await sleep(700)
  }
  await sleep(900)
  await injectStableCSS()
  await dismissOverlays()
  await sleep(150)
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
  mkdirSync(OUT, { recursive: true })
  const file = OUT + '/' + view.tag + '-' + name + '.png'
  writeFileSync(file, Buffer.from(data, 'base64'))
  RESULTS.push(file)
  console.log('shot', file)
}

async function main() {
  const mode = process.argv[2] ?? 'all'
  const only = process.argv.slice(3)
  const debugPort = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + debugPort,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--user-data-dir=' + USER_DATA,
    '--no-first-run', '--hide-scrollbars', '--window-size=430,932', 'about:blank',
  ], { stdio: 'ignore' })

  await waitPort(debugPort)
  const res = await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })
  const target = await res.json()
  await sleep(300)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m.result ?? m.error) }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: APP })
  await waitFor("document.querySelector('#app')?.children.length > 0", 20000, '应用挂载')
  await injectStableCSS()
  await dismissOverlays()

  const views = []
  if (mode === 'all' || mode === 'phone') views.push(VIEWS.phone)
  if (mode === 'all' || mode === 'desk') views.push(VIEWS.desk)

  const list = only.length ? ROUTES.filter(([n]) => only.includes(n)) : ROUTES
  for (const view of views) {
    console.log('--- viewport', view.tag, view.width + 'x' + view.height)
    for (const [name, hash] of list) {
      try { await shot(name, hash, view) } catch (e) { console.log('FAIL', name, String(e).slice(0, 160)) }
    }
  }
  console.log('共 ' + RESULTS.length + ' 张')
  ws.close()
  edge.kill()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
