/**
 * e2e-focus —— 专注 / 番茄钟域端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：本轮打磨的几乎全是「跨时序 / 跨刷新 / 跨页面」的状态语义 ——
 *   · 相位总秒数冻结（长休进度环不再恒空）—— 只有让时间真的走才看得见；
 *   · 三态落库（完成 / 中断 / 放弃）—— 只有真的结束一段才看得见；
 *   · 冷启动接管（关掉 App 期间那一轮到底算不算）—— 只有真的刷新才看得见；
 *   · 环境式浮条（切页后还看得见计时）—— 只有真的导航才看得见。
 * 这些单测都反映不出来，而它们是这次修复的全部价值所在，所以必须真渲染一遍。
 *
 * 剧本：
 *   A. 主页一步起跑 + 浮条跨页常驻 + 控制台零错误
 *   B. 浮条暂停 / 继续（状态点与文案）
 *   C. 满一轮 → 完整段统计 + 圆点点亮 + 「通知发不出」的常驻送达条（且不自动消失）
 *   D. 长休进度环：中途真的在涨、且不越界（**修复前的 P0 回归**）；
 *      顺带验证「本轮轮次按天持久化」——刷新后圆点不丢、且第二轮确实进长休
 *   E. 中断 <1 分钟：文案即代价、不落库
 *   F. 中断 ≥1 分钟（借快照造出已投入）：落库为「中途停下」
 *   G. 冷启动接管：关闭期间已走完 → 补记一条完成且不再有浮条
 *   H. 冷启动接管：关闭期间还在走 → 停在暂停态 + 浮条出现
 *   I. 模块关掉 → 浮条不渲染
 *   J. 浅色 / 暗色截图（规范要求 UI 改动附截图）
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-focus.mjs
 * 环境变量：REIN_E2E_OUT（截图与 profile 目录）。**默认用时间戳唯一目录**——
 *          固定目录会让浏览器 profile 跨次复用、localStorage 残留污染断言（实测踩过）。
 *
 * 用分数分钟把 25 分钟压成几秒：store 的时长只从 localStorage 读，接受小数
 * （`focusMin: 0.1` = 6 秒），这样一轮完整周期几秒就能跑完，而走的是与真机**同一条**代码路径。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const BROWSER = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('找不到 Edge/Chrome，无法运行 e2e')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
/** 输出目录（截图 + 报告）：默认系统临时目录（时间戳唯一）；REIN_E2E_OUT 可指定 */
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-focus-${Date.now()}`
/**
 * 浏览器 profile **恒定放系统临时目录**，绝不放进项目目录 ——
 * Vite 的文件监听会去 watch 项目目录，而 Edge 时刻锁着自己的 Cookies / Network 文件，
 * 于是 FSWatcher 抛 EBUSY 'error' 事件、Node 直接崩：dev server 会死在 e2e 中途，
 * 表现成「刷新后页面永远挂不上」这种极难定位的假象（实测踩过两次）。
 */
const USER_DATA = `${process.env.TEMP}/rein-e2e-profile-${Date.now()}-${process.pid}`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const DEBUG_PORT = 9500 + (process.pid % 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 断言与结果汇总 ---------------- */

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

let ws
let nextId = 1
const pending = new Map()
/** 控制台 error / 未捕获异常：任何一条都算失败（静默失败即缺陷） */
const consoleErrors = []

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r?.result?.value
}

async function waitFor(expr, timeoutMs = 15000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 轮询直到某元素的 textContent 含某个词（相位推进用它，比死等秒数稳） */
async function waitText(sel, text, timeoutMs = 40000, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const t = await evalJS(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
    if (t && t.includes(text)) return t
    await sleep(150)
  }
  const cur = await evalJS(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? '(无此元素)'`)
  throw new Error(`等待文本超时: ${label || `${sel} 含「${text}」`}（当前「${cur}」）`)
}

/** 点击文案命中的按钮：取**最后一个**匹配（弹层渲染在文档末尾，等价于最上层） */
const clickButtonText = (text) =>
  evalJS(`(() => {
    const hits = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes(${JSON.stringify(text)}))
    const el = hits[hits.length - 1]
    if (!el) return false
    el.click()
    return true
  })()`)

const clickSel = (sel) =>
  evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`)

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${SHOTS}/${name}.png`)
}

async function shotDark(name) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(400)
  await shot(name)
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(250)
}

/** 应用挂载完成（真实应用根节点，不用 e2e 之外的约定） */
const appReady = () => waitFor(`!!document.querySelector('.page')`, 45000, '应用挂载')

async function goto(hash) {
  await evalJS(`location.hash = ${JSON.stringify(hash)}`)
  await appReady()
  await sleep(350)
}

async function reload() {
  await evalJS(`location.reload()`)
  await sleep(400)
  await appReady()
  await sleep(500)
}

async function connect(url) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  // 优先挑 about:blank：Edge 冷启动可能先冒出别的 page（同步确认对话框等）
  const target =
    list.find((t) => t.type === 'page' && t.url === 'about:blank') ?? list.find((t) => t.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      p.resolve(m.result ?? m.error)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('未捕获异常: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try {
      if ((await evalJS('document.readyState')) === 'complete') break
    } catch {
      /* 导航中上下文短暂失效 */
    }
    await sleep(200)
  }
}

/* ---------------- 状态注入小工具（全部走真实 localStorage 键，与真机同一路径） ---------------- */

const SETTINGS_KEY = 'rein.pomodoro.settings.v1'
const LIVE_KEY = 'rein.pomodoro.live.v1'
const ROUND_KEY = 'rein.pomodoro.round.v1'
const LINKED_KEY = 'rein.pomodoro.linkedTodo.v1'
const FEATURES_KEY = 'rein.features.v1'

const DEFAULT_SETTINGS = { focusMin: 25, breakMin: 5, longBreakMin: 15, roundsBeforeLongBreak: 4, chime: false }

/** 把本地状态复位成一份已知干净的现场，然后刷新（每次改设置都从这里走） */
async function resetState(settings = DEFAULT_SETTINGS, extras = {}) {
  await evalJS(`(() => {
    localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(JSON.stringify(settings))})
    localStorage.removeItem(${JSON.stringify(LIVE_KEY)})
    localStorage.removeItem(${JSON.stringify(ROUND_KEY)})
    localStorage.removeItem(${JSON.stringify(LINKED_KEY)})
    localStorage.removeItem(${JSON.stringify(FEATURES_KEY)})
    ${extras.live ? `localStorage.setItem(${JSON.stringify(LIVE_KEY)}, ${JSON.stringify(JSON.stringify(extras.live))})` : ''}
    ${extras.round ? `localStorage.setItem(${JSON.stringify(ROUND_KEY)}, ${JSON.stringify(JSON.stringify(extras.round))})` : ''}
    ${extras.features ? `localStorage.setItem(${JSON.stringify(FEATURES_KEY)}, ${JSON.stringify(JSON.stringify(extras.features))})` : ''}
  })()`)
  await reload()
}

/* ---------------- 读取界面事实 ---------------- */

/** 卡片相位文案（智能安排 · 共 N 颗 / 第 N 颗番茄 / 休息一下 / 专注已暂停 …） */
const cardPhase = () => evalJS(`document.querySelector('.page .card .cap')?.textContent.trim() ?? null`)
/** 点亮圆点数 / 圆点总数 */
const dotCounts = () =>
  evalJS(`(() => {
    const all = [...document.querySelectorAll('.page .card .rdot')]
    return { on: all.filter((e) => e.classList.contains('on')).length, total: all.length }
  })()`)
/** 今日番茄计数：卡片右下的「× N 颗」（完整段计数） */
const tomatoCount = () =>
  evalJS(`(() => {
    const el = document.querySelector('.page .card .tcount')
    const m = el?.textContent.match(/(\\d+)\\s*颗/)
    return m ? Number(m[1]) : null
  })()`)
/** 卡底统计文本（完整 / 中途停下两行） */
const statText = () =>
  evalJS(`document.querySelector('.page .card .stat')?.textContent.replace(/\\s+/g, ' ').trim() ?? '(空态)'`)
/** 「完整 N 段」的 N（mock 里有种子记录，所以断言一律走增量，不写绝对条数） */
const completedCount = () =>
  evalJS(`(() => {
    const t = document.querySelector('.page .card .stat')?.textContent ?? ''
    const m = t.match(/完整\\s*(\\d+)\\s*段/)
    return m ? Number(m[1]) : 0
  })()`)
/** 进度环：stroke 由元素自身读出（卡片 12 / 沉浸层 16 等都可能不同），不写死 */
const ring = () =>
  evalJS(`(() => {
    const el = document.querySelector('.page .card .val')
    if (!el) return null
    const sw = Number(el.getAttribute('stroke-width')) || 12
    const C = 2 * Math.PI * (50 - sw / 2 - 1)
    const off = Number(el.getAttribute('stroke-dashoffset'))
    return { off, C, pct: Math.min(1, Math.max(0, 1 - off / C)) }
  })()`)

/** 起跑 / 续跑：空闲态是宽胶囊 .cta，进行中（含暂停）是控制簇里的 .ibtn.main */
const startOrResume = () =>
  evalJS(`(() => {
    // 2026-11 专注改版：界面默认先排计划再开始。以下时序用例需要「单轮 + 小数分钟」
    // 的快速回归，dev 构建提供了一个直达 store 的入口（生产构建不含）。
    const hook = window.__reinTestStartPomodoro
    if (typeof hook === 'function') {
      let s = {}
      try { s = JSON.parse(localStorage.getItem('rein.pomodoro.settings.v1') || '{}') } catch {}
      hook({ focusMin: s.focusMin, breakMin: s.breakMin })
      return true
    }
    const el = document.querySelector('.page .card .cta') ?? document.querySelector('.page .card .acts .ibtn.main')
    if (!el) return false
    el.click()
    return true
  })()`)

/** 浮条是否在场 + 相位文案 + 倒计时 */
const floatBar = () =>
  evalJS(`(() => {
    const root = document.querySelector('.fdock-root')
    if (!root) return null
    return {
      phase: root.querySelector('.layer-bar .t')?.textContent.trim() ?? null,
      time: root.querySelector('.layer-bar .s')?.textContent.trim() ?? null,
      dot: [...(root.querySelector('.dot')?.classList ?? [])].join(' '),
    }
  })()`)

/** 送达条（通知发不出去时才出现） */
const noticeBar = () =>
  evalJS(`(() => {
    const el = document.querySelector('.fnb')
    if (!el) return null
    return { text: el.textContent.replace(/\\s+/g, ' ').trim(), closes: !!el.querySelector('button') }
  })()`)

/**
 * 视觉不变量 —— 把令牌**解析成真实颜色**再比对，而不是目测截图。
 *
 * 为什么这么做：截图适合人看，但没人能保证它不随重构悄悄漂移；
 * 这几条判据（环用专注 accent、未点亮圆点与胶囊底拉开一档、数值走中性色、
 * 不横向溢出、减弱动效时停呼吸）是可以机器复跑的回归网，也正合「用实测值锁定不变量」。
 */
const visualInvariants = () =>
  evalJS(`(() => {
    const root = document.documentElement
    // 令牌真值：造一个探针元素让浏览器替我们把 var(--x) 解析成 rgb()
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const tok = (name) => { probe.style.color = 'var(--' + name + ')'; return getComputedStyle(probe).color }
    const T = {
      work: tok('cat-work'), focusTone: tok('mod-focus-tone'), general: tok('cat-general'),
      text1: tok('text-1'), text2: tok('text-2'), text3: tok('text-3'),
      surface2: tok('surface-2'), surface3: tok('surface-3'),
    }
    probe.remove()
    const card = document.querySelector('.page .card')
    const val = card?.querySelector('.val')
    // 设置摘要条是卡片里唯一的 --surface-2 面片；未点亮圆点（--surface-3）要与它拉开一档
    const chip = card?.querySelector('.acts')
    const rdot = card?.querySelector('.rdot:not(.on)')
    const phase = card?.querySelector('.cap')
    const time = card?.querySelector('.readout')
    const hero = card?.querySelector('.stat .hero')
    const bar = document.querySelector('.fdock-root .dock-body')
    const fb = document.querySelector('.fdock-root')
    const abtns = [...document.querySelectorAll('.fdock-root .abtn')]
    return {
      tokens: T,
      ringStroke: val ? getComputedStyle(val).stroke : null,
      phaseColor: phase ? getComputedStyle(phase).color : null,
      timeColor: time ? getComputedStyle(time).color : null,
      heroColor: hero ? getComputedStyle(hero).color : null,
      chipBackground: chip ? getComputedStyle(chip).backgroundColor : null,
      rdotBackground: rdot ? getComputedStyle(rdot).backgroundColor : null,
      cardBackground: card ? getComputedStyle(card).backgroundColor : null,
      /* 浮条几何：条形态宽度不得超视口；按钮命中区高度 */
      barW: bar ? Math.round(bar.getBoundingClientRect().width) : null,
      vw: window.innerWidth,
      btnH: abtns.length ? abtns.map((b) => Math.round(b.getBoundingClientRect().height)) : [],
      /* 呼吸动画（减弱动效时应为 none） */
      dotAnim: fb?.querySelector('.dot.work') ? getComputedStyle(fb.querySelector('.dot.work')).animationName : null,
      pdotAnim: card?.querySelector('.cdot.live') ? getComputedStyle(card.querySelector('.cdot.live')).animationName : null,
      overflowX: root.scrollWidth - window.innerWidth,
    }
  })()`)

/** 相对亮度 / 对比度（sRGB，按 WCAG 公式；只作读数，不教条卡 4.5） */
function contrast(rgbA, rgbB) {
  const lum = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const [r, g, b] = m[1].split(',').map((x) => Number(x.trim()) / 255)
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const a = lum(rgbA)
  const b = lum(rgbB)
  if (a == null || b == null) return null
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const edge = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      // 首次运行 / 同步 / 扩展初始化会把冷启动拖到几十秒：关掉，调试端口 0.5s 就绪
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    // 轮询调试端口，别用固定 sleep（机器忙时 1.5s 根本不够）
    let ready = false
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok) {
          ready = true
          break
        }
      } catch {
        /* 还没起 */
      }
      await sleep(200)
    }
    if (!ready) throw new Error('无头浏览器调试端口未就绪')

    await connect(`${APP}/#/`)
    await appReady()
    await resetState()
    await goto('#/')
    await waitFor(`!!document.querySelector('[data-testid="hf-fact-focus"]')`, 20000, '主页页脚专注格')

    /* ---------- A. 一步起跑 + 浮条跨页常驻 ---------- */
    ok(
      '未在跑时，专注格给出一步起跑（视频 / 事实并存）',
      await evalJS(`!!document.querySelector('[data-testid="hf-focus-start"]')`),
    )
    await clickSel('[data-testid="hf-focus-start"]')
    await waitFor(`!!document.querySelector('.fdock-root')`, 8000, '起跑后浮条出现')
    const fb0 = await floatBar()
    ok(
      '主页一步起跑后：常驻浮条出现并显示「专注中 + 倒计时」',
      fb0?.phase === '专注中' && /^\d{2}:\d{2}$/.test(fb0?.time ?? ''),
      JSON.stringify(fb0),
    )

    await goto('#/focus')
    const onPage = await floatBar()
    await goto('#/')
    const onHome = await floatBar()
    ok(
      '切页（专注页 ↔ 主页）后浮条仍在 —— 状态不再只关在专用页里',
      onPage?.phase === '专注中' && onHome?.phase === '专注中',
      `focus页=${onPage?.phase} 主页=${onHome?.phase}`,
    )

    /* ---------- B. 暂停 / 继续 ---------- */
    await clickSel('.fdock-root .abtn.main')
    await sleep(300)
    const paused = await floatBar()
    ok('浮条暂停：文案转「已暂停」、状态点转 paused', paused?.phase === '已暂停' && paused?.dot.includes('paused'), JSON.stringify(paused))
    await clickSel('.fdock-root .abtn.main')
    await sleep(300)
    const resumed = await floatBar()
    ok('浮条继续：回到「专注中」', resumed?.phase === '专注中', JSON.stringify(resumed))

    /* ---------- C. 满一轮：完整段 + 圆点 + 常驻送达条 ---------- */
    await resetState({ ...DEFAULT_SETTINGS, focusMin: 0.1, breakMin: 0.2, longBreakMin: 0.5, roundsBeforeLongBreak: 4 })
    await goto('#/focus')
    const cBefore = await completedCount()
    await startOrResume()
    await waitText('.page .card .cap', '休息', 40000, '一轮专注自然走满、进入休息')
    // finishPhase 里 loadToday() 排在 announcePhaseEnd 之后，相位文案会先于统计刷新一瞬：等它跟上
    await waitFor(
      `(() => { const m = (document.querySelector('.page .card .stat')?.textContent ?? '').match(/完整\\s*(\\d+)\\s*段/); return !!m && Number(m[1]) === ${cBefore + 1} })()`,
      10000,
      '卡底「完整段」+1（统计刷新）',
    )
    const statAfter = await statText()
    const cAfter = await completedCount()
    ok('满一轮后卡底出现「完整 N 段 … 分钟」的诚实分账', /完整\s*\d+\s*段/.test(statAfter) && cAfter === cBefore + 1, `完整段 ${cBefore}→${cAfter}｜${statAfter}`)
    ok('满一轮后「N 个番茄」= 完整段计数', (await tomatoCount()) === cAfter, `tomato=${await tomatoCount()} 完整=${cAfter}`)
    const dots1 = await dotCounts()
    ok('满一轮后点亮 1 颗圆点', dots1.on === 1 && dots1.total === 4, JSON.stringify(dots1))

    const nb1 = await noticeBar()
    ok('mock 下系统通知发不出去 → 相位切换后出现**常驻**送达条', !!nb1?.text.includes('专注完成'), JSON.stringify(nb1))
    await sleep(6000)
    const nb2 = await noticeBar()
    ok('送达条不自动消失（不是 toast，12s 后仍在）', !!nb2, JSON.stringify(nb2))
    await clickSel('.fnb button')
    await sleep(300)
    ok('送达条可手动关闭', (await noticeBar()) === null)

    /* ---------- D. 长休进度环（修复前的 P0 回归） + 轮次持久化 ---------- */
    // 参数：专注 6s / 短休 6s / 长休 30s / 每 2 轮长休
    await resetState({ ...DEFAULT_SETTINGS, focusMin: 0.1, breakMin: 0.1, longBreakMin: 0.5, roundsBeforeLongBreak: 2 })
    await goto('#/focus')
    // 第 1 轮（含短休）
    await startOrResume()
    await waitText('.page .card .cap', '休息', 40000, '第 1 轮结束进入短休')
    await waitText('.page .card .cap', '智能安排', 40000, '短休结束回到专注空闲（空闲卡现在展示智能计划）')
    const dotsAfter1 = await dotCounts()

    await reload()
    await goto('#/focus')
    const dotsAfterReload = await dotCounts()
    ok(
      '轮次按天持久化：刷新后圆点不丢（completedRounds 是唯一真源）',
      dotsAfter1.on === 1 && dotsAfterReload.on === 1,
      `刷新前=${JSON.stringify(dotsAfter1)} 刷新后=${JSON.stringify(dotsAfterReload)}`,
    )

    // 第 2 轮 → 应进**长休**（30s）
    await startOrResume()
    await waitText('.page .card .cap', '休息', 40000, '第 2 轮结束进入休息')
    const dotsAfter2 = await dotCounts()
    ok('走到第 2 轮（长休间隔）后圆点点满', dotsAfter2.on === 2, JSON.stringify(dotsAfter2))

    const samples = []
    for (let i = 0; i < 40; i++) {
      const r = await ring()
      if (r) samples.push({ t: Date.now(), pct: r.pct, off: r.off, C: r.C })
      await sleep(300)
    }
    const first = samples[0]
    const mid = samples.find((s) => s.t - first.t >= 12000) ?? samples[samples.length - 1]
    const last = samples[samples.length - 1]
    const inRange = samples.every((s) => s.pct >= -0.001 && s.pct <= 1.001)
    const grew = last.pct - first.pct
    ok(
      '长休进度环恒在 [0,1]（修复前会算出 -2 → 前 2/3 恒空）',
      inRange,
      `样本 ${samples.length} 个，区间 [${Math.min(...samples.map((s) => s.pct)).toFixed(3)}, ${Math.max(...samples.map((s) => s.pct)).toFixed(3)}]`,
    )
    ok(
      '长休进度环中途真的在涨（不是卡在空环）',
      grew >= 0.2 && mid.pct >= 0.15,
      `起=${first.pct.toFixed(3)} · 12s 处=${mid.pct.toFixed(3)} · 止=${last.pct.toFixed(3)}`,
    )
    ok(
      '第 2 轮进入的是**长休**（30s），不是 6s 短休 —— 轮次真源驱动长休判定',
      (await cardPhase())?.includes('休息'),
      `12s 后相位=${await cardPhase()}`,
    )

    /* ---------- E. 中断 <1 分钟：文案即代价、不落库 ---------- */
    await resetState({ ...DEFAULT_SETTINGS, focusMin: 0.2 })
    await goto('#/focus')
    await startOrResume()
    await sleep(3000) // 投入约 3 秒（< 60s）
    await clickSel('[aria-label="提前结束本阶段"]')
    await waitFor(`!!document.querySelector('[role="dialog"]') || document.body.textContent.includes('还不到 1 分钟')`, 6000, '结束确认弹出')
    const guardText = await evalJS(`document.body.textContent`)
    ok('不足 1 分钟时文案如实说「不会留下记录」（文案即代价）', guardText.includes('还不到 1 分钟'), '')
    await clickButtonText('进入休息')
    await sleep(800)
    const interruptedAfterShort = await evalJS(
      `document.body.textContent.includes('中途停下')`,
    )
    ok('不足 1 分钟的「结束」不落库（无「中途停下」记录）', interruptedAfterShort === false, `见到中途停下=${interruptedAfterShort}`)

    /* ---------- F. 中断 ≥1 分钟：借快照造出已投入，落库为「中途停下」 ---------- */
    // 跨零点夹具：起点不能落到昨天，否则 loadToday 按本地日期收窄时会把记录滤掉
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const fStart = Math.max(dayStart.getTime() + 60000, Date.now() - 480000)
    // 快照：phaseTotalSec=600、remainingSec=120 → 已投入 480s（≥60s）；running=true 但 endAt 在未来 → 接管为暂停态
    await resetState(DEFAULT_SETTINGS, {
      live: {
        phase: 'focus',
        running: true,
        endAtMs: Date.now() + 120000,
        remainingSec: 120,
        phaseTotalSec: 600,
        linkedTodoId: null,
        runFocusMin: null,
        runBreakMin: null,
        completedRounds: 0,
        phaseStartedAtMs: fStart,
      },
    })
    await goto('#/focus')
    await waitFor(`!!document.querySelector('.fdock-root')`, 8000, '接管后浮条出现')
    await clickSel('.fdock-root .abtn.end')
    await waitFor(`document.body.textContent.includes('记')`, 6000, '浮条结束确认弹出')
    await clickButtonText('结束并保留记录')
    await sleep(1200)
    const statInterrupted = await statText()
    ok(
      '投入 ≥1 分钟的中断落库为「中途停下」（未被当成完整段）',
      /中途停下/.test(statInterrupted),
      statInterrupted,
    )

    /* ---------- G. 冷启动接管：关闭期间已走完 → 补记 + 无浮条 ---------- */
    const gBefore = await completedCount()
    await resetState(DEFAULT_SETTINGS, {
      live: {
        phase: 'focus',
        running: true,
        endAtMs: Date.now() - 1000, // 关闭期间已到点
        remainingSec: 0,
        phaseTotalSec: 60,
        linkedTodoId: null,
        runFocusMin: 1,
        runBreakMin: null,
        completedRounds: 0,
        phaseStartedAtMs: Math.max(dayStart.getTime() + 1000, Date.now() - 30000),
      },
    })
    await goto('#/focus')
    const afterFinish = await statText()
    const gAfter = await completedCount()
    ok('关闭期间走完的一轮被补记一条完成', gAfter === gBefore + 1, `完整段 ${gBefore}→${gAfter}｜${afterFinish}`)
    ok('补记后**没有**进行中的浮条（那一轮已经结束）', (await floatBar()) === null)

    /* ---------- H. 冷启动接管：还在走 → 停在暂停态 + 浮条 ---------- */
    await resetState(DEFAULT_SETTINGS, {
      live: {
        phase: 'focus',
        running: true,
        endAtMs: Date.now() + 600000, // 关闭期间还在走
        remainingSec: 600,
        phaseTotalSec: 1500,
        linkedTodoId: null,
        runFocusMin: null,
        runBreakMin: null,
        completedRounds: 0,
        phaseStartedAtMs: Date.now() - 900000,
      },
    })
    await goto('#/focus')
    await waitFor(`!!document.querySelector('.fdock-root')`, 8000, '接管后浮条出现')
    const hb = await floatBar()
    ok(
      '关闭期间还在走的一轮被接管：停在**暂停态**（不偷偷替你继续跑）',
      hb?.phase === '已暂停',
      JSON.stringify(hb),
    )
    ok('接管时如实在页面上提示（notice 常驻，不静默）', !!(await noticeBar())?.text.includes('还在'), JSON.stringify(await noticeBar()))

    /* ---------- I. 模块关掉 → 浮条不渲染 ---------- */
    await resetState(DEFAULT_SETTINGS, {
      live: {
        phase: 'focus',
        running: true,
        endAtMs: Date.now() + 600000,
        remainingSec: 600,
        phaseTotalSec: 1500,
        linkedTodoId: null,
        runFocusMin: null,
        runBreakMin: null,
        completedRounds: 0,
        phaseStartedAtMs: Date.now() - 900000,
      },
      features: { focus: false },
    })
    await goto('#/focus')
    await sleep(600)
    ok('关掉「专注」模块后浮条不渲染（关就是整个关，不留半截）', (await floatBar()) === null)

    /* ---------- J. 视觉不变量（实测计算） + 截图 ---------- */
    await resetState()
    await evalJS(`localStorage.setItem(${JSON.stringify(ROUND_KEY)}, JSON.stringify({ date: new Date().toISOString().slice(0, 10), rounds: 1 }))`)
    await reload()
    await goto('#/focus')
    await startOrResume()
    await sleep(800) // 让状态点进入「专注中」（呼吸态）

    const inv = await visualInvariants()
    ok(
      '进度环色相 = 专注模块色（--mod-focus-tone），不再借营养三环的粉',
      inv.ringStroke === inv.tokens.focusTone,
      `环=${inv.ringStroke} --mod-focus-tone=${inv.tokens.focusTone}`,
    )
    ok(
      '未点亮圆点的底与胶囊底**拉开一档**（修复「圆点与胶囊同色、看不见」）',
      inv.rdotBackground === inv.tokens.surface3 && inv.chipBackground === inv.tokens.surface2 && inv.rdotBackground !== inv.chipBackground,
      `圆点=${inv.rdotBackground} 胶囊=${inv.chipBackground}`,
    )
    ok(
      '读数与正文走中性色（色彩配额）：倒计时 / 主数值 = --text-1，相位小字 = --text-2',
      inv.timeColor === inv.tokens.text1 && inv.heroColor === inv.tokens.text1 && inv.phaseColor === inv.tokens.text2,
      `时间=${inv.timeColor} 主数值=${inv.heroColor} 相位=${inv.phaseColor}`,
    )
    const cPhase = contrast(inv.phaseColor, inv.cardBackground)
    ok(
      '相位小字对卡底的对比度 ≥ 3（必读信息，不再压三级灰）',
      cPhase != null && cPhase >= 3,
      `对比度 ${cPhase?.toFixed(2)}:1（相位 ${inv.phaseColor} on ${inv.cardBackground}）`,
    )
    ok(
      '浮条条形态不超视口、按钮命中区 ≥ 34px',
      inv.barW != null && inv.barW <= inv.vw && inv.btnH.every((h) => h >= 34),
      `条宽 ${inv.barW}/${inv.vw} 按钮高 ${inv.btnH.join(',')}`,
    )
    ok('页面无横向溢出', inv.overflowX <= 1, `溢出 ${inv.overflowX}px`)

    await shot('focus-page-light')
    await shotDark('focus-page-dark')
    await sleep(200)
    await shot('focus-floatbar-light')
    await shotDark('focus-floatbar-dark')

    /* 暗色档：同一组不变量再跑一遍（两档都要能读） */
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await sleep(400)
    const invDark = await visualInvariants()
    const cPhaseDark = contrast(invDark.phaseColor, invDark.cardBackground)
    ok(
      '暗色档：环仍走 --mod-focus-tone、圆点仍与胶囊底分档、相位字 < --text-2、对比度 ≥ 3',
      invDark.ringStroke === invDark.tokens.focusTone &&
        invDark.rdotBackground === invDark.tokens.surface3 &&
        invDark.rdotBackground !== invDark.chipBackground &&
        invDark.phaseColor === invDark.tokens.text2 &&
        cPhaseDark != null &&
        cPhaseDark >= 3,
      `环=${invDark.ringStroke} 圆点=${invDark.rdotBackground} 胶囊=${invDark.chipBackground} 相位对比 ${cPhaseDark?.toFixed(2)}:1`,
    )
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await sleep(250)

    /* 减弱动效：呼吸点必须停（可访问性） */
    await cdp('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'light' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    })
    await sleep(500)
    const invRm = await visualInvariants()
    ok(
      '减弱动效档：浮条与卡片的状态呼吸动画都停',
      invRm.dotAnim === 'none' && invRm.pdotAnim === 'none',
      `dot=${invRm.dotAnim} pdot=${invRm.pdotAnim}`,
    )
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

    /* 专注页的设置抽屉（番茄钟配置已从设置页移回本页）：
       2026-11 起「设置」入口收进安排抽屉的右上角 —— 先放弃本轮回到空闲，
       点计划条开「安排专注」，再点「设置」。 */
    await evalJS(`document.querySelector('.page .card .ibtn.danger')?.click()`)
    await sleep(350)
    await evalJS(`(() => {
      const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => (x.textContent || '').includes('放弃本轮'))
      if (b) b.click()
    })()`)
    await sleep(600)
    const pickerOpened = await evalJS(`(() => {
      const plan = document.querySelector('.page .card .plan')
      if (!plan) return false
      plan.click()
      return true
    })()`)
    await sleep(500)
    await evalJS(`document.querySelector('.fps-panel .fps-settings')?.click()`)
    await sleep(500)
    const picker = await evalJS(`(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="专注设置"]')
      if (!dlg) return null
      const text = dlg.textContent || ''
      return {
        hasFocus: text.includes('专注时长'),
        hasRounds: text.includes('长休间隔'),
        hasChime: !!dlg.querySelector('[role="switch"][aria-label="结束提示音"]'),
      }
    })()`)
    ok(
      '专注页「专注设置」抽屉：专注时长 / 长休间隔 / 结束提示音三项都在',
      pickerOpened && !!picker && picker.hasFocus && picker.hasRounds && picker.hasChime,
      picker ? JSON.stringify(picker) : '未打开设置抽屉',
    )

    const settingsBefore = await evalJS(
      `JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) || '{}')`,
    )
    await evalJS(`document.querySelector('[aria-label="增加 专注时长"]')?.click()`)
    await evalJS(`document.querySelector('[aria-label="增加 长休间隔"]')?.click()`)
    await evalJS(`document.querySelector('[role="switch"][aria-label="结束提示音"]')?.click()`)
    await sleep(400)
    const settingsAfter = await evalJS(
      `JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) || '{}')`,
    )
    ok(
      '抽屉里改专注时长 / 长休间隔 / 提示音立即落到 rein.pomodoro.settings.v1',
      settingsAfter.focusMin === (settingsBefore.focusMin ?? 25) + 5 &&
        settingsAfter.roundsBeforeLongBreak === (settingsBefore.roundsBeforeLongBreak ?? 4) + 1 &&
        settingsAfter.chime === !settingsBefore.chime,
      `before=${JSON.stringify(settingsBefore)} after=${JSON.stringify(settingsAfter)}`,
    )
    await evalJS(`document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click()`)
    await sleep(300)
    await shot('focus-settings-picker-light')
    await shotDark('focus-settings-picker-dark')

    /* ---------- 控制台零错误 ---------- */
    ok('全流程控制台零 error / 零未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  } finally {
    try {
      edge.kill()
    } catch {
      /* noop */
    }
  }

  const passed = results.filter((r) => r.pass).length
  console.log(`\n${passed}/${results.length} 通过`)
  console.log(`截图目录：${SHOTS}`)
  if (passed !== results.length) {
    const failed = results.filter((r) => !r.pass).map((r) => r.name)
    console.log(`失败项：\n- ${failed.join('\n- ')}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('e2e 失败：', e.message ?? e)
  const passed = results.filter((r) => r.pass).length
  console.log(`（已跑 ${results.length} 条，${passed} 通过）`)
  process.exit(1)
})