/**
 * e2e-dock-edit —— 移动端 Dock 长按编辑 + 合并输入行（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：Dock 编辑态是一条跨组件链 —— 长按计时器把 RouterLink 换身成 button、
 * 草稿驱动页签行重排、托盘的「＋」与徽标的「−」互为逆操作、保存/放弃分别落盘或回滚、
 * mask 与固定件封印要同时成立。这些时序与联动单测拼不出来，只有真渲染一遍才验证得了；
 * 同时它也是回归网：编辑态的任何视觉若漏进装配层（画质标本比对的那份几何），断言会红。
 *
 * 2026-11 底栏合并重构：一块玻璃 = 输入行 + 页签行。左独立圆钮（换落点）与引导气泡
 * 退役，AI 从右圆钮槽位改为页签行的固定条目 —— 原来的「回归 1b/1c」与「编辑态闸门
 * （左钮）」段落随之删除；输入行的跨页行为（发送 / 「+」带草稿）在本剧本末尾冒烟。
 *
 * 剧本：
 *   0. 基线：默认页签行 = 主页,运动,我,AI，输入行在场（未编辑过的容器按目录缺省渲染）
 *   1. 输入行：AI 页也是同一个 ComposerBar（在 .dock / #dock-ai-composer 内），回主页同源
 *   2. 长按**页签** 480ms 进编辑态：mask / 托盘出现、页签按钮化、可移动项带「−」徽标、
 *      固定件（主页 / 我 / AI）无徽标、输入行收起、长按不跳转
 *   3. 点 mask 不退出编辑态（退出只有放弃 / 保存两条路）
 *   4. 「−」摘除 ↔ 托盘「＋」加回：草稿即时联动
 *   5. 拖拽边界：把「运动」拖到固定件「主页」上方 → 钳制回可移动区，顺序不变
 *   6. 放弃变更：页签行回滚、rein.navLayout.v1 从未落盘
 *   7. 保存布局：移除「运动」落盘并跨刷新保持
 *   8. 加回并保存：固定件页签同样能长按进编辑，加回「运动」落盘保持
 *   9. 联动冒烟：关掉「运动」模块 → 页签行条目消失而布局字节不变，重开原位回来
 *  10. 输入行冒烟：发送 → 跳 AI 页话已递出；「+」→ 草稿填进完整输入条不发送
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-dock-edit.mjs
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
/** 输出目录：默认系统临时目录；REIN_E2E_OUT 可指定（便于人工翻看截图） */
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-dock-edit-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

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

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return
  const file = `${SHOTS}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${file}`)
}

/** 暗色截图：同一页面切 prefers-color-scheme 再拍一张（规范要求 UI 改动浅深各一张） */
async function shotDark(name) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(350)
  await shot(name)
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(250)
}

async function connect(url) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
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
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      if ((await evalJS('document.readyState')) === 'complete') return
    } catch {
      /* 导航中上下文会短暂失效 */
    }
    await sleep(200)
  }
  throw new Error('页面加载超时')
}

/** 点一个按钮：按选择器 + 文本包含匹配 */
const clickText = (selector, text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

/** 底栏页签文案清单（底栏根类名是 `.dock`，页签类是 `.dock-tab`；编辑态是按钮、平时是链接，
    断言只看文本序列 —— 两个形态给出同一条序列） */
const pillSeq = () =>
  evalJS(`[...document.querySelectorAll('.dock .dock-tab')].map((e) => e.textContent.trim())`)

/** 编辑态的两件套是否在场（mask 由 App.vue 常驻挂载、托盘由 TabBar 挂在编辑态） */
const editState = () =>
  evalJS(`(() => ({
    mask: !!document.querySelector('.nav-edit-mask'),
    tray: !!document.querySelector('.dock-edit-tray'),
    trayBtns: [...document.querySelectorAll('.dock-edit-tray .tray-btn')].map((e) => e.textContent.trim()),
  }))()`)

/** 按文本找一颗页签并返回中心坐标（拖拽 / 长按都要真坐标） */
const tabCenter = (label) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll('.dock .dock-tab')]
      .find((e) => e.textContent.trim().includes(${JSON.stringify(label)}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)

/** 长按一颗页签：按住越过 480ms 判定线（长按页签 = 进编辑态） */
async function longPressPill(label) {
  const p = await tabCenter(label)
  if (!p) throw new Error(`页签「${label}」不在页签行上`)
  await evalJS(`(() => {
    const el = [...document.querySelectorAll('.dock .dock-tab')]
      .find((e) => e.textContent.trim().includes(${JSON.stringify(label)}))
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, isPrimary: true, button: 0,
      clientX: ${p.x}, clientY: ${p.y},
    }))
  })()`)
  await sleep(700)
}

/** 点页签上的「−」徽标 / 托盘 chip 上的「＋」徽标（合成 click 会穿透 pointer-events，
    正好把代码层的闸门与回调一起验证掉） */
const clickBadge = (id, kind) =>
  evalJS(`(() => {
    const badge = document.querySelector('.dock .dock-tab[data-nav-id="${id}"] [data-nav-badge="${kind}"]')
      ?? document.querySelector('.dock-edit-tray [data-nav-id="${id}"] [data-nav-badge="${kind}"]')
    if (!badge) return false
    badge.click()
    return true
  })()`)

/** 往底栏输入行里打字（原生设值 + input 事件，让 v-model 收到） */
const typeQuick = (text) =>
  evalJS(`(() => {
    const i = document.querySelector('.dock .qk-input')
    if (!i) return false
    i.value = ${JSON.stringify(text)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/** 打开/关闭某模块开关（功能页的行按名字定位） */
const setToggle = (name, on) =>
  evalJS(`(() => {
    const row = [...document.querySelectorAll('.prow')]
      .find((r) => r.querySelector('.ptxt b')?.textContent.trim() === ${JSON.stringify(name)})
    if (!row) return 'no-row'
    const sw = row.querySelector('[role="switch"]')
    if (!sw) return 'no-switch'
    const isOn = sw.getAttribute('aria-checked') === 'true'
    if (isOn !== ${on}) sw.click()
    return isOn === ${on} ? 'already' : 'clicked'
  })()`)

/** 收尾清理：本剧本动过的键全部清掉（pinia 是内存单例，删键后要 reload 才真的回到默认） */
async function cleanUpAndReload() {
  await evalJS(`['rein.features.v1', 'rein.navLayout.v1']
    .forEach((k) => localStorage.removeItem(k))`)
  await evalJS(`location.reload()`)
  await waitFor(`!!document.querySelector('.dock .dock-tab')`, 12000, '清理后的底栏')
  await sleep(600)
}

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9500 + (process.pid % 200)

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
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    await connect(`${APP}/#/me`)
    // 等应用挂载完成再动手：vue-router 的首次导航若与赋值竞争，会把 hash 拽回初始路由
    await waitFor(`!!document.querySelector('.page')`, 8000, '应用挂载')
    await cleanUpAndReload()
    await evalJS(`location.hash = '#/'`)
    await sleep(700)

    /* ---- 0. 基线：未编辑过的容器按目录缺省渲染 ---- */
    const pill0 = await pillSeq()
    ok(
      '默认页签行 = 主页,运动,我,AI（固定件就位 + 插件条目，AI 殿后）',
      pill0.join() === '主页,运动,我,AI',
      pill0.join(' · '),
    )
    const quick0 = await evalJS(`(() => ({
      quick: !!document.querySelector('.dock .dock-quick'),
      placeholder: document.querySelector('.dock .qk-input')?.placeholder ?? '',
    }))()`)
    ok(
      '默认带 AI 输入行（每个显示底栏的页面都有，占位含「按住说话」）',
      quick0.quick && quick0.placeholder.includes('按住说话'),
      JSON.stringify(quick0),
    )
    const state0 = await editState()
    ok('默认无编辑态（mask / 托盘都不在）', !state0.mask && !state0.tray, JSON.stringify(state0))

    /* ---- 1. 输入行：AI 页与其余页面是同一个 ComposerBar（2026-11-09 全局统一） ---- */
    await evalJS(`location.hash = '#/ai'`)
    await sleep(900)
    const aiQuick = await evalJS(`(() => {
      const q = document.querySelector('.dock .dock-quick')
      return {
        inDock: !!q && !!q.closest('.dock'),
        inHost: !!q && !!q.closest('#dock-ai-composer'),
        hasTextarea: !!q?.querySelector('textarea.qk-input'),
        chipsInDock: !!document.querySelector('.dock .composer'),
      }
    })()`)
    ok(
      'AI 页输入行 = 同一个 ComposerBar（在 Dock 玻璃内、文本域同源）、页签行照常（AI 高亮）',
      aiQuick.inDock && aiQuick.inHost && aiQuick.hasTextarea && aiQuick.chipsInDock &&
        (await pillSeq()).join() === '主页,运动,我,AI',
      JSON.stringify(aiQuick) + ' · ' + (await pillSeq()).join(' · '),
    )
    await evalJS(`location.hash = '#/'`)
    await sleep(700)
    ok(
      '回主页输入行仍是同一个组件（textarea.qk-input）',
      await evalJS(`!!document.querySelector('.dock .dock-quick textarea.qk-input')`),
    )

    /* ---- 2. 长按页签进编辑态 ---- */
    await longPressPill('运动')
    await waitFor(`!!document.querySelector('.dock-edit-tray')`, 4000, '编辑托盘')
    const inEdit = await editState()
    ok(
      '长按页签进编辑态：mask 与托盘齐备，退出只有放弃 / 保存两颗',
      inEdit.mask && inEdit.tray && inEdit.trayBtns.join() === '放弃变更,保存布局',
      JSON.stringify(inEdit),
    )
    const editDom = await evalJS(`(() => ({
      tabs: [...document.querySelectorAll('.dock .dock-tab')].map((e) => e.tagName),
      pill: [...document.querySelectorAll('.dock .dock-tab')].map((e) => e.textContent.trim()),
      badgeSports: !!document.querySelector('.dock .dock-tab[data-nav-id="sports"] [data-nav-badge="-"]'),
      badgeHome: !!document.querySelector('.dock .dock-tab[data-nav-id="home"] [data-nav-badge="-"]'),
      badgeMe: !!document.querySelector('.dock .dock-tab[data-nav-id="me"] [data-nav-badge="-"]'),
      badgeAi: !!document.querySelector('.dock .dock-tab[data-nav-id="ai"] [data-nav-badge="-"]'),
      aiAria: document.querySelector('.dock .dock-tab[data-nav-id="ai"]')?.getAttribute('aria-label'),
      quickGone: !document.querySelector('.dock .dock-quick'),
    }))()`)
    ok(
      '编辑态页签按钮化、可移动项带「−」徽标、固定件（主页 / 我 / AI）无徽标',
      editDom.tabs.every((t) => t === 'BUTTON') &&
        editDom.badgeSports &&
        !editDom.badgeHome &&
        !editDom.badgeMe &&
        !editDom.badgeAi,
      JSON.stringify(editDom),
    )
    ok(
      '固定件 AI 的 aria 保持条目名（不用动作语义骗读屏用户）、输入行收起、页签序列不变',
      editDom.aiAria === null && editDom.quickGone && editDom.pill.join() === '主页,运动,我,AI',
      `aiAria=${editDom.aiAria} quickGone=${editDom.quickGone} · ${editDom.pill.join(' · ')}`,
    )
    ok(
      '长按进编辑不跳转（元素换身 + 吞窗：松手不再是导航）',
      (await evalJS(`location.hash`)) === '#/',
      await evalJS(`location.hash`),
    )
    await shot('3-dock-edit-light')
    await shotDark('3-dock-edit-dark')

    /* ---- 3. 点 mask 不退出编辑态 ---- */
    await evalJS(`document.querySelector('.nav-edit-mask').click()`)
    await sleep(300)
    ok(
      '点 mask 不退出编辑态（退出只有放弃 / 保存两条路）',
      (await editState()).tray,
    )

    /* ---- 4. 「−」摘除 ↔ 托盘「＋」加回 ---- */
    ok('「−」徽标摘除「运动」', (await clickBadge('sports', '-')) === true)
    await sleep(300)
    const removed = await evalJS(`(() => ({
      pill: [...document.querySelectorAll('.dock .dock-tab')].map((e) => e.textContent.trim()),
      chip: !!document.querySelector('.dock-edit-tray [data-nav-id="sports"] [data-nav-badge="+"]'),
    }))()`)
    ok(
      '摘除后页签行 = 主页,我,AI，托盘出现「运动」chip（data-nav-badge="+"）',
      removed.pill.join() === '主页,我,AI' && removed.chip,
      JSON.stringify(removed),
    )
    ok('「＋」加回「运动」（追加到可移动区末尾）', (await clickText('.dock-edit-tray .tray-chip', '运动')) === true)
    await sleep(300)
    ok(
      '加回后页签行恢复 主页,运动,我,AI（固定件之间 / 之后）',
      (await pillSeq()).join() === '主页,运动,我,AI',
      (await pillSeq()).join(' · '),
    )

    /* ---- 5. 拖拽边界：可移动项拖向固定件 → 钳制回可移动区 ---- */
    await evalJS(`(() => {
      const tabs = [...document.querySelectorAll('.dock .dock-tab[data-nav-id]')]
      const sports = tabs.find((e) => e.dataset.navId === 'sports')
      const home = tabs.find((e) => e.dataset.navId === 'home')
      const s = sports.getBoundingClientRect()
      const h = home.getBoundingClientRect()
      const sx = s.left + s.width / 2
      const sy = s.top + s.height / 2
      // 落点压在「主页」上半（越过中线 → 解算成「插到它前面」）
      const hx = h.left + h.width / 2
      const hy = h.top + 4
      const opts = (x, y) => ({ bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y })
      sports.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy)))
      // 越过 8px slop 才算抓住：分步推到目标（window 级监听收得到合成 pointermove）
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', opts(sx + ((hx - sx) * i) / steps, sy + ((hy - sy) * i) / steps)))
      }
      window.dispatchEvent(new PointerEvent('pointerup', opts(hx, hy)))
      return true
    })()`)
    // 拖拽松手会让 useNavDrag 装一枚 400ms 的一次性吞窗：等它出窗再点别的东西
    await sleep(600)
    ok(
      '拖「运动」到固定件「主页」上方被钳制，顺序仍是 主页,运动,我,AI',
      (await pillSeq()).join() === '主页,运动,我,AI',
      (await pillSeq()).join(' · '),
    )

    /* ---- 6. 放弃变更：回滚且从未落盘 ---- */
    ok('再次摘除「运动」', (await clickBadge('sports', '-')) === true)
    await sleep(200)
    await clickText('.dock-edit-tray .tray-btn', '放弃变更')
    await sleep(400)
    const afterDiscard = await editState()
    ok(
      '放弃变更：退出编辑态、页签行回滚',
      !afterDiscard.mask && !afterDiscard.tray && (await pillSeq()).join() === '主页,运动,我,AI',
      (await pillSeq()).join(' · '),
    )
    ok(
      '放弃变更不落盘（rein.navLayout.v1 没有 tabbar 字段）',
      (await evalJS(`JSON.parse(localStorage.getItem('rein.navLayout.v1') ?? '{}').tabbar === undefined`)),
    )

    /* ---- 7. 保存布局：摘除「运动」落盘并跨刷新保持 ---- */
    await longPressPill('运动')
    await waitFor(`!!document.querySelector('.dock-edit-tray')`, 4000, '编辑托盘')
    ok('第二次长按照常进编辑态（会话可反复进入）', await editState().then((s) => s.mask && s.tray))
    ok('「−」摘除「运动」', (await clickBadge('sports', '-')) === true)
    await sleep(200)
    await clickText('.dock-edit-tray .tray-btn', '保存布局')
    await sleep(400)
    ok(
      '保存布局：退出编辑态，页签行 = 主页,我,AI',
      !(await editState()).mask && !(await editState()).tray && (await pillSeq()).join() === '主页,我,AI',
      (await pillSeq()).join(' · '),
    )
    ok(
      '布局写入 rein.navLayout.v1（tabbar = []，固定件永不入存）',
      (await evalJS(`JSON.stringify(JSON.parse(localStorage.getItem('rein.navLayout.v1') ?? '{}').tabbar)`)) === '[]',
    )
    await evalJS(`location.reload()`)
    await waitFor(`!!document.querySelector('.dock .dock-tab')`, 12000, '刷新后的底栏')
    await sleep(600)
    ok(
      '刷新后布局保持（主页,我,AI）',
      (await pillSeq()).join() === '主页,我,AI',
      (await pillSeq()).join(' · '),
    )

    /* ---- 8. 加回并保存：固定件页签同样能长按进编辑 ---- */
    await longPressPill('主页')
    await waitFor(`!!document.querySelector('.dock-edit-tray')`, 4000, '编辑托盘')
    ok(
      '固定件页签的长按同样能进编辑态（入口是页签行整体）',
      (await editState()).tray,
    )
    ok('托盘「＋」加回「运动」', (await clickText('.dock-edit-tray .tray-chip', '运动')) === true)
    await sleep(200)
    await clickText('.dock-edit-tray .tray-btn', '保存布局')
    await sleep(400)
    ok(
      '加回后保存：页签行 = 主页,运动,我,AI',
      (await pillSeq()).join() === '主页,运动,我,AI',
      (await pillSeq()).join(' · '),
    )
    await evalJS(`location.reload()`)
    await waitFor(`!!document.querySelector('.dock .dock-tab')`, 12000, '刷新后的底栏')
    await sleep(600)
    ok(
      '刷新后布局保持（主页,运动,我,AI；tabbar = ["sports"]）',
      (await pillSeq()).join() === '主页,运动,我,AI' &&
        (await evalJS(`JSON.stringify(JSON.parse(localStorage.getItem('rein.navLayout.v1') ?? '{}').tabbar)`)) === '["sports"]',
    )

    /* ---- 9. 联动冒烟：关模块条目消失而布局字节不变，重开原位回来 ---- */
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')
    ok('关闭「运动」开关', (await setToggle('运动', false)) === 'clicked')
    await evalJS(`location.hash = '#/'`)
    await sleep(700)
    ok(
      '关掉「运动」：页签行条目消失（主页,我,AI），布局字节不变',
      (await pillSeq()).join() === '主页,我,AI' &&
        (await evalJS(`JSON.stringify(JSON.parse(localStorage.getItem('rein.navLayout.v1') ?? '{}').tabbar)`)) === '["sports"]',
      (await pillSeq()).join(' · '),
    )
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')
    ok('重新打开「运动」开关', (await setToggle('运动', true)) === 'clicked')
    await evalJS(`location.hash = '#/'`)
    await sleep(700)
    ok(
      '重开「运动」：条目原位回来',
      (await pillSeq()).join() === '主页,运动,我,AI',
      (await pillSeq()).join(' · '),
    )

    /* ---- 10. 输入行冒烟：发送跨页递话、「+」带草稿去完整输入条 ---- */
    ok('输入行打字后发送钮点亮', (await typeQuick('帮我想个周末计划')) === true && await evalJS(`!document.querySelector('.dock .qk-send').disabled`))
    await evalJS(`document.querySelector('.dock .qk-send').click()`)
    await waitFor(`location.hash.startsWith('#/ai')`, 6000, '发送跳转 AI 页')
    await sleep(900)
    ok(
      '发送：话已递到 AI 页的流水线（发出 / busy 落输入框 / 无模型时走关键词解析——三种落点都算到达）',
      await evalJS(`(() => {
        const ta = document.querySelector('.composer textarea')
        const hasMsgs = document.querySelectorAll('.msgs .msg').length > 0
        return !!ta && (hasMsgs || (ta.value ?? '').includes('帮我想个周末计划'))
      })()`),
    )
    await evalJS(`location.hash = '#/'`)
    await sleep(700)
    ok('「+」前输入行草稿可输入', (await typeQuick('记一件事')) === true)
    // 「+」是输入行第一颗圆钮（+ / 输入 / 麦克风 / 发送 的头一颗）
    await evalJS(`document.querySelector('.dock .dock-quick .qk-btn').click()`)
    await waitFor(`location.hash.startsWith('#/ai')`, 6000, '「+」跳转 AI 页')
    await sleep(900)
    ok(
      '「+」带草稿去 AI 页：填进完整输入条、不自动发送',
      await evalJS(`(() => {
        const ta = document.querySelector('.composer textarea')
        return !!ta && (ta.value ?? '').includes('记一件事')
      })()`),
    )

    /* ---- 收尾：本剧本动过的键全部清掉，不给别的剧本留状态 ---- */
    await cleanUpAndReload()
    ok('清理后回到默认（主页,运动,我,AI）', (await pillSeq()).join() === '主页,运动,我,AI')
  } finally {
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  console.log(`截图目录：${SHOTS}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('e2e 失败：', e.message)
  process.exit(1)
})
