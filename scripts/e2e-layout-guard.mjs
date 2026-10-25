/**
 * 布局守卫（真机视口 406×904）—— 盯住三类「显示异常」，改动后跑一次就能发现漂移。
 *
 *   1 徽章/标签拆行：短中文标签被拆成两行（「在线」→「在 / 线」），卡片高度跟着变
 *   2 真实裁切：overflow 非 visible 的容器里子元素超出**内边距盒**（会被切掉那种）
 *   3 三处间距不变量（用户实测口径）：
 *        · #/ai/models  首个模型卡片：名称→provider·modelId = 3、→价格 = 4、→能力徽章 = 10
 *        · #/settings/update  更新设置各行之间 = 0（行高自带内边距）
 *        · #/ai        输入栏底 → 底栏顶 = 10（悬浮条与 Dock 之间的空气，--cb-gap）
 *   4 操作边界：整页的双指捏合 / 双击缩放必须无效（见下面 ZOOM_GUARD 的长注释）——
 *     这套界面的尺寸全按 430×932 标定成绝对像素，整体放大不会重排，只会把固定定位的
 *     Dock / 悬浮条撑出错位，是"超出设计允许"的那一类操作。
 *
 * 运行：node scripts/e2e-layout-guard.mjs   （先 `npm run dev`，或设 REIN_E2E_URL 指向已构建产物）
 * 退出码非 0 表示有断言失败。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { presetFeatureFlags } from './lib/features.mjs'

const EDGE = process.env.REIN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-layout-guard-${Date.now()}`
const W = Number(process.env.REIN_E2E_W ?? 406)
const H = Number(process.env.REIN_E2E_H ?? 904)
const VIEW = { w: W, h: H }

const ROUTES = [
  '#/', '#/sports', '#/ai', '#/me', '#/nutrition', '#/nutrition/adjust', '#/nutrition/foods',
  '#/nutrition/recipes', '#/program', '#/ledger', '#/focus', '#/todos', '#/settings',
  '#/settings/features', '#/settings/float', '#/settings/update', '#/settings/perf', '#/ai/models', '#/ai/knowledge', '#/ai/files',
  '#/sports/plans', '#/sports/exercises', '#/sports/records', '#/campus/schedule',
  '#/campus/settings', '#/campus/program', '#/campus/course-select', '#/record',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
  srv.on('error', reject)
})

let ws
let msgId = 0
const pending = new Map()
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const SCAN = `(() => {
  const desc = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : ''
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '')
  }
  const path = (el) => { const p = []; let n = el; while (n && n !== document.body && p.length < 3) { p.unshift(desc(n)); n = n.parentElement } return p.join('>') }
  const skip = (el) => el.closest('.pblur') || el.closest('svg') || el.tagName === 'SVG'
  // 缩略预览（画布/计时器的小样）内部本来就被裁：它按比例缩小整屏，行高与容器尺寸对不上
  const inScaledPreview = (el) =>
    !!el.closest('.vt.preview') || !!el.closest('.ctl.compact') || !!el.closest('.tlwrap .scroll')
  const out = { wrapped: [], clipped: [] }

  for (const el of document.querySelectorAll('span, button, b, em') ) {
    if (skip(el)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (cs.display === 'block' || cs.display === 'flex' || cs.display === 'inline-flex') continue
    if (!(el.textContent || '').trim()) continue
    if (el.getClientRects().length > 1 && /chip|badge|pill|tag|cap/i.test(String(el.className))) {
      out.wrapped.push({ path: path(el), text: el.textContent.trim().slice(0, 10), lines: el.getClientRects().length })
    }
  }

  for (const el of document.querySelectorAll('body *')) {
    if (skip(el) || inScaledPreview(el)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
    if (cs.textOverflow === 'ellipsis') continue
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue
    const box = el.getBoundingClientRect()
    if (box.width < 12 || box.height < 12) continue
    for (const kid of el.querySelectorAll(':scope > *')) {
      if (skip(kid)) continue
      const kcs = getComputedStyle(kid)
      if (kcs.display === 'none' || kcs.position === 'absolute' || kcs.position === 'fixed') continue
      const kr = kid.getBoundingClientRect()
      if (kr.height < 3 || kr.width < 3) continue
      const overB = Math.round(kr.bottom - box.bottom)
      const overR = Math.round(kr.right - box.right)
      if (overB > 3 || overR > 3) out.clipped.push({ parent: path(el), kid: desc(kid), overB, overR })
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, 8)
  return out
})()`

/** 三处间距不变量 */
const SPACING = `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
  }
  const out = { hash: location.hash, checks: [] }
  if (location.hash.startsWith('#/ai/models')) {
    // 四行必须取自**同一张卡片**：querySelector 会跨卡片各取一个，量出来的差值毫无意义
    const card = document.querySelector('.m-card')
    const rectIn = (sel) => {
      const el = card?.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) }
    }
    const name = rectIn('.m-name')
    const id = rectIn('.m-id')
    const cost = rectIn('.m-cost')
    const caps = rectIn('.caps')
    if (name && id) out.checks.push({ name: '模型卡片 名称→modelId', got: id.top - name.bottom, want: 3 })
    if (id && cost) out.checks.push({ name: 'modelId→价格', got: cost.top - id.bottom, want: 4 })
    const after = cost ?? id
    if (after && caps) out.checks.push({ name: '价格/modelId→能力徽章', got: caps.top - after.bottom, want: 10 })
  }
  if (location.hash.startsWith('#/settings/update')) {
    const kids = [...document.querySelectorAll('.card .rows > *')].map((el) => el.getBoundingClientRect())
    for (let i = 1; i < kids.length; i++) {
      out.checks.push({ name: '更新设置 行间空档 #' + i, got: Math.round(kids[i].top - kids[i - 1].bottom), want: 0 })
    }
  }
  if (location.hash === '#/ai') {
    // 悬浮条（dock 样式）：**玻璃外缘**到 Dock 顶 = 10px（--cb-gap）——不是压在一起。
    // 量 .cbar（玻璃本体）而不是 .inbar：输入行退在玻璃的描边之内，会多算 1px（实测 11）。
    const bar = rect('.cbar') || rect('.inbar'), dock = rect('.dock')
    if (bar && dock) out.checks.push({ name: 'AI 输入栏底→底栏顶', got: Math.round(dock.top - bar.bottom), want: 10 })
  }
  return out
})()`

/**
 * 操作边界 · 整页缩放必须无效。
 *
 * 为什么它算「显示异常」而不是"无障碍偏好"：这套界面的尺寸全部是按 430×932 的视口
 * 标定成绝对像素的（触区 44、Dock 58、页头钮 38）。捏合放大**不会触发重排**，
 * 只是把已经画好的东西整体放大 —— 于是固定定位的 Dock / 悬浮条与内容错位、
 * 玻璃的位移贴图停在标定尺寸上（放大后边缘那道折射带跟着被拉粗）。
 * 也就是说它不是"把界面变大"，是"把界面画错"，所以归到这里守。
 *
 * 三道闸（index.html 的 viewport / base.css 的 touch-action / Android 的
 * Settings.setSupportZoom(false)）在浏览器里只能验到前两道；这里量的是**行为**：
 * 捏合与双击之后 visualViewport 的 scale 与页面布局宽度都不许变。
 * 量行为比查声明强 —— 声明写对了但不生效（`user-scalable=no` 在 iOS 上就是这样）
 * 是这类问题的常态。
 */
const ZOOM_GUARD = `(() => {
  const vv = window.visualViewport
  return {
    scale: vv ? Number(vv.scale.toFixed(3)) : 1,
    width: Math.round(document.documentElement.clientWidth),
    overflow: document.documentElement.scrollWidth,
    touchAction: getComputedStyle(document.documentElement).touchAction,
    viewportMeta: document.querySelector('meta[name="viewport"]')?.content ?? '',
  }
})()`

const port = await freePort()
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', `--user-data-dir=${USER_DATA}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' })
const failures = []
try {
  await sleep(1500)
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
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
  // 抢课是课表的子模块，**默认关闭** —— 本剧本测的正是它，先把开关预置好
  await presetFeatureFlags(cdp)
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true })
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('rein.perf.v1','high');
      document.documentElement.style.setProperty('--safe-top-native','42px');
      document.documentElement.style.setProperty('--safe-bottom-native','0px');
      document.documentElement.style.setProperty('--safe-left-native','20px');
      document.documentElement.style.setProperty('--safe-right-native','20px');`,
  })
  await cdp('Page.navigate', { url: `${APP}/#/ai/models` })
  await sleep(2500)
  // 造一条带「在线」徽章的模型：徽章拆行的场景在真机上才出现，这里复刻同样的数据形状
  await evalJS(`(async () => {
    const m = await import('/src/stores/models.ts')
    const s = m.useModelsStore()
    await s.load(true)
    if (!s.models.some((x) => x.name === 'dsv')) {
      await s.add({ name: 'dsv', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-t', modelId: 'deepseek-v4-flash', isDefault: true, priceIn: 0, priceOut: 0 })
      await s.add({ name: '火山方舟 · deepseek-v4.1-flash', provider: 'rein-online', baseUrl: 'http://47.100.36.179:8787/v1', apiKey: 'rein_sk_t', modelId: 'deepseek-v4.1-flash', isDefault: false, priceIn: 2, priceOut: 8 })
    }
    await s.load(true)
    return true
  })()`)

  for (const hash of ROUTES) {
    await evalJS(`location.hash = '${hash}'`)
    await sleep(950)
    const scan = await evalJS(SCAN)
    const spacing = await evalJS(SPACING)
    const bad = [...scan.wrapped.map((w) => `徽章拆行 ${w.path} 「${w.text}」${w.lines}行`), ...scan.clipped.map((c) => `裁切 ${c.parent} > ${c.kid} overB=${c.overB} overR=${c.overR}`), ...spacing.checks.filter((c) => c.got !== c.want).map((c) => `间距 ${c.name}：实测 ${c.got}，应为 ${c.want}`)]
    if (bad.length) {
      failures.push({ hash, bad })
      console.log(`✗ ${hash}`)
      for (const b of bad) console.log(`    ${b}`)
    } else {
      const spacingNote = spacing.checks.length ? `（间距 ${spacing.checks.length} 项 ✓）` : ''
      console.log(`✓ ${hash} ${spacingNote}`)
    }
  }

  // ---------- 4 操作边界：双指捏合 / 双击都不许把整页放大 ----------
  await evalJS(`location.hash = '#/nutrition'`)
  await sleep(1200)
  const before = await evalJS(ZOOM_GUARD)
  const cx = Math.round(W / 2)
  const cy = Math.round(H / 2)
  // 真的发手势（不是查声明）：捏合放大 1.6 倍、再双击一次
  await cdp('Input.synthesizePinchGesture', { x: cx, y: cy, scaleFactor: 1.6, relativeSpeed: 800, gestureSourceType: 'touch' })
  await sleep(700)
  const afterPinch = await evalJS(ZOOM_GUARD)
  await cdp('Input.synthesizeTapGesture', { x: cx, y: cy, tapCount: 2, duration: 60, gestureSourceType: 'touch' })
  await sleep(700)
  const afterTap = await evalJS(ZOOM_GUARD)

  const zoomChecks = [
    ['捏合后 scale 仍为 1', afterPinch.scale === 1, `scale=${afterPinch.scale}`],
    ['双击后 scale 仍为 1', afterTap.scale === 1, `scale=${afterTap.scale}`],
    [
      '捏合 / 双击都没有改变布局宽度',
      afterPinch.width === before.width && afterTap.width === before.width,
      `${before.width} → ${afterPinch.width} → ${afterTap.width}`,
    ],
    [
      '捏合 / 双击都没有撑出横向溢出',
      afterPinch.overflow <= afterPinch.width + 1 && afterTap.overflow <= afterTap.width + 1,
      `overflow ${before.overflow} → ${afterPinch.overflow} → ${afterTap.overflow}`,
    ],
    [
      '声明齐备：viewport 带 user-scalable=no + maximum-scale=1',
      /user-scalable=no/.test(before.viewportMeta) && /maximum-scale=1/.test(before.viewportMeta),
      before.viewportMeta,
    ],
    [
      '声明齐备：html 的 touch-action 排掉了 pinch-zoom',
      /pan-x\s+pan-y/.test(before.touchAction) && !/pinch-zoom/.test(before.touchAction),
      `touch-action=${before.touchAction}`,
    ],
  ]
  const zoomBad = zoomChecks.filter(([, pass]) => !pass)
  if (zoomBad.length) {
    failures.push({ hash: '操作边界 · 整页缩放', bad: zoomBad.map(([name, , detail]) => `${name}：${detail}`) })
    console.log('✗ 操作边界 · 整页缩放')
    for (const [, , detail] of zoomBad) console.log(`    ${detail}`)
  } else {
    console.log('✓ 操作边界 · 整页缩放（捏合 / 双击都无效，声明齐备）')
  }
} finally {
  edge.kill()
}

console.log('')
if (failures.length) {
  console.log(`布局守卫失败：${failures.length} 个页面有问题（视口 ${VIEW.w}×${VIEW.h}）`)
  process.exit(1)
}
console.log(
  `布局守卫通过：${ROUTES.length} 个路由 + 操作边界（整页缩放已关），视口 ${VIEW.w}×${VIEW.h}`,
)
