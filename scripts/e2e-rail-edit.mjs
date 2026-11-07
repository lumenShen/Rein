/**
 * e2e-rail-edit —— 桌面左栏「全部菜单 + 编辑态」端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：左栏的自定义价值全在跨组件的联动里 —— hover 菜单列的是「注册目录」而不是
 * 用户布局（撤掉的条目必须还能从这里回去）、编辑态的 ±/拖拽落在 useNavEdit 的草稿上
 * （保存才落 localStorage、放弃即回滚）、mask + inert 把被遮主内容封死、会话只有
 * 放弃/保存两条退出路。这些单测反映不出来，只有真渲染一遍才验证得了。
 *
 * 剧本（docs/nav-redesign.md §6 / §10 验收判据 ③⑤⑥）：
 *   A. 默认渲染与正常态菜单：rail 条目 = 目录缺省序；全部菜单 hover 浮出，
 *      菜单项 = features.nav('rail') 目录源（含被撤条目、不含「总览」）；点项 = 路由直达
 *   B. 编辑态进入与 mask：「编辑」钮 → mask(z45) 挂上、.desk-main inert、条目按钮化 +
 *      「−」徽标（总览固定件除外）、面板换候选源 + 两颗退出钮、壳层簇 aria-disabled
 *   C. 「−」撤回到 menu：会话中撤掉的条目立刻回到候选面板（草稿感知候选）
 *   D. 拖拽调序：整格把手（点按 = 撤回、拖过 8px slop = 调序），live reorder
 *   E. 保存布局：写入 rein.navLayout.v1（固定件不入存）、刷新后保持；
 *      目录源不受布局污染 —— 撤掉的条目仍能从菜单一键回得去（判据 ⑥）
 *   F. 放弃变更：草稿从未落盘，回滚到进入编辑态前的布局
 *   G. 预置布局（presetNavLayout）：冻结语义（编辑过的容器不自动出现新条目）、
 *      候选 = 目录 − 已存布局、「＋」加回落在可移动区末尾；Esc 不退出会话
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-rail-edit.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

import { presetNavLayout } from './lib/features.mjs'

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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-rail-edit-${Date.now()}`
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

/* ---------------- 页面助手 ---------------- */

/** rail 导航簇的条目序（data-nav-id，正常态 RouterLink 与编辑态 button 都带） */
const railOrder = () =>
  evalJS(`[...document.querySelectorAll('.rail .navs [data-nav-id]')].map((e) => e.dataset.navId)`)

/** rail 全部 .ric 的 aria-label（含壳层簇：命令面板 / 信息栏 / 我 / 全部菜单） */
const railAria = () =>
  evalJS(`[...document.querySelectorAll('.rail .ric')].map((e) => e.getAttribute('aria-label'))`)

/** 全部菜单面板的条目文案 */
const menuItems = () =>
  evalJS(`[...document.querySelectorAll('.panel[role="menu"] .item .lbl')].map((e) => e.textContent.trim())`)

/** 触发全部菜单的 hover 打开：mouseenter 不冒泡，直接派发到锚钮（Vue 原生监听） */
const hoverAllMenu = () =>
  evalJS(`(() => {
    const el = document.querySelector('.rail .ric.all')
    if (!el) return false
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    return true
  })()`)

const openMenu = async () => {
  if (!(await hoverAllMenu())) throw new Error('找不到「全部菜单」锚钮')
  await waitFor(`document.querySelector('.panel[role="menu"]')`, 6000, '全部菜单面板')
  await sleep(250) // 等入场动画与首次 syncPanel 落定
}

const closeMenu = async () => {
  await evalJS(`document.querySelector('.catcher')?.click()`)
  await waitFor(`!document.querySelector('.panel[role="menu"]')`, 4000, '菜单收起')
}

/** 点面板里含指定文案的菜单项 */
const clickMenuItem = (text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll('.panel[role="menu"] .item')]
      .find((e) => e.textContent.includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

/** 点面板标题行右缘的动作钮（编辑 / 放弃变更 / 保存布局） */
const clickPanelAction = (text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll('.panel .pactions button')]
      .find((e) => (e.getAttribute('aria-label') ?? e.textContent).includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

/** 进编辑态：hover 开菜单 → 点「编辑」 */
const enterEdit = async () => {
  await openMenu()
  if (!(await clickPanelAction('编辑左栏'))) throw new Error('找不到「编辑」钮')
  await waitFor(`!!document.querySelector('.nav-edit-mask')`, 4000, '编辑态遮罩')
  await sleep(300)
}

/* 合成指针手势（点按 / 拖拽）：headless 下 CDP 注入的鼠标事件到不了元素（见
   e2e-day-canvas 的实测），统一派发合成 PointerEvent —— 冒泡到 window 的
   pointermove/up 由 useNavDrag 接住；setPointerCapture 失败已被它 try 包住。 */
const pDown = (x, y) => evalJS(`(() => {
  const el = document.elementFromPoint(${x}, ${y})
  if (!el) return false
  window.__pd = { el }
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }))
  return true
})()`)

const pMove = (x, y) => evalJS(`(() => {
  const el = window.__pd?.el
  if (!el) return false
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }))
  return true
})()`)

const pUp = (x, y) => evalJS(`(() => {
  const el = window.__pd?.el
  if (!el) return false
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }))
  delete window.__pd
  return true
})()`)

/** rail 条目中心坐标（按 data-nav-id 找） */
const centerOfNav = (id) =>
  evalJS(`(() => {
    const el = document.querySelector('.rail .navs [data-nav-id="${id}"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)

/** 把某条目拖到另一条目当前位置（竖向整格拖拽：越过 slop 起抓、落到目标中线、松手） */
async function dragNav(fromId, toId) {
  const from = await centerOfNav(fromId)
  const to = await centerOfNav(toId)
  if (!from || !to) throw new Error(`拖拽端点找不到: ${fromId} → ${toId}`)
  if (!(await pDown(from.x, from.y))) throw new Error('pointerdown 落空')
  await sleep(60)
  // 先挪 16px（越过 8px slop 起抓），再分两步挪到目标中线（给 live reorder 喂中间态）
  await pMove(from.x, from.y - 16)
  await sleep(60)
  await pMove(from.x, (from.y + to.y) / 2)
  await sleep(60)
  await pMove(to.x, to.y)
  await sleep(120)
  await pUp(to.x, to.y)
  await sleep(150)
}

const goto = async (hash) => {
  await evalJS(`location.hash = '${hash}'`)
  await sleep(500)
}

/** 关掉更新提示浮卡：它是 z60+ 的悬浮层，盖住视口中心的命中测试（与 e2e-desktop-audit 同款收法） */
const dismissUpdate = async () => {
  await evalJS(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '稍后')?.click()`)
  await sleep(300)
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
      // 桌面壳的宽度档（≥900 渲染 .rail）；非 Tauri 窗口没有自绘标题栏，正合本剧本
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  edge.on('error', (e) => console.error('浏览器启动失败:', e.message))
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    try {
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      break
    } catch {
      await sleep(200)
    }
  }

  try {
    await connect(APP)
    // hover 门（锚钮 mouseenter 只在 hover:hover 设备开）在 headless 里显式钉住：
    // 有的环境报告 hover:none，菜单就永远开不了 —— 与剧本无关的设备差异，统掉
    await cdp('Emulation.setEmulatedMedia', {
      features: [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }],
    })
    // 干净起点：清掉三个界面偏好键后整页重载（store 启动即读，进页再清无效）
    await evalJS(`localStorage.removeItem('rein.navLayout.v1'); localStorage.removeItem('rein.features.v1'); `)
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelector('.rail .ric')`, 12000, '桌面导航轨')
    await sleep(500)
    await dismissUpdate()

    /* ================ A. 默认渲染与正常态菜单 ================ */
    console.log('—— A. 默认渲染与正常态菜单 ——')

    // 目录缺省序 = 声明 order：总览(内核 0) + 营养110 运动120 课表130 专注140 待办150 记账160 AI170
    const order0 = await railOrder()
    ok(
      '默认 rail 条目 = 目录缺省序（总览居首，插件按声明 order）',
      JSON.stringify(order0) === JSON.stringify(['home', 'nutrition', 'sports', 'campus-schedule', 'focus', 'todos', 'ledger', 'ai']),
      order0.join(' · '),
    )

    const aria0 = await railAria()
    ok(
      'rail aria 全集含壳层簇（命令面板 / 信息栏 / 我）与「全部菜单」',
      aria0.includes('总览') && aria0.includes('命令面板') && aria0.includes('显示或隐藏信息栏') && aria0.includes('我') && aria0.includes('全部菜单'),
      aria0.join(' · '),
    )

    const allBtn = await evalJS(`(() => {
      const el = document.querySelector('.rail .ric.all')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: r.width, h: r.height, label: el.getAttribute('data-label') }
    })()`)
    ok(
      '「全部菜单」钮 42×42（≥22px 可点靶）、data-label 同值',
      allBtn && allBtn.w >= 22 && allBtn.h >= 22 && allBtn.label === '全部菜单',
      JSON.stringify(allBtn),
    )

    // 容器没编辑过就绝不写键（navLayout 的首写克制）
    const keyBefore = await evalJS(`localStorage.getItem('rein.navLayout.v1')`)
    ok('默认渲染不写 rein.navLayout.v1', keyBefore === null, String(keyBefore))

    await openMenu()
    await shot('A1-all-menu')
    const items0 = await menuItems()
    ok(
      '正常态菜单 = 目录源（启用插件全集，不含「总览/主页」内核条目）',
      ['营养', '运动', '课表', '专注', '待办', '记账', 'AI'].every((t) => items0.some((x) => x.includes(t))) &&
        !items0.some((x) => x.includes('总览') || x.includes('主页')),
      items0.join(' · '),
    )

    const editBtn = await evalJS(`(() => {
      const el = document.querySelector('.panel .pactions button')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { aria: el.getAttribute('aria-label'), w: r.width, h: r.height }
    })()`)
    ok(
      '面板右上角「编辑」钮（圆角方框 + ≥22px 靶）',
      editBtn && editBtn.aria === '编辑左栏' && editBtn.w >= 22 && editBtn.h >= 22,
      JSON.stringify(editBtn),
    )

    // 点菜单项 = 路由直达（被撤掉的模块从这里一键回得去的那条路）
    if (!(await clickMenuItem('待办'))) throw new Error('菜单项「待办」找不到')
    await sleep(500)
    const hashAfterItem = await evalJS(`location.hash`)
    const menuGone = await evalJS(`!document.querySelector('.panel[role="menu"]')`)
    ok('点菜单项「待办」路由直达并收起面板', hashAfterItem.includes('todos') && menuGone, String(hashAfterItem))
    await goto('#/')

    /* ================ B. 编辑态进入与 mask ================ */
    console.log('—— B. 编辑态进入与 mask ——')
    await enterEdit()
    await shot('B1-edit-session')

    const maskEl = await evalJS(`document.querySelector('.nav-edit-mask')?.className ?? null`)
    ok('编辑态遮罩挂上（z45，--scrim-edit）', maskEl === 'nav-edit-mask', String(maskEl))

    const mainInert = await evalJS(`document.querySelector('.desk-main')?.inert ?? null`)
    ok('被遮主内容根 .desk-main 挂 inert（mask 只挡指针不挡焦点）', mainInert === true, String(mainInert))

    const badgeState = await evalJS(`(() => {
      const badges = [...document.querySelectorAll('.rail .navs [data-nav-badge="-"]')]
      const home = document.querySelector('.rail .navs [data-nav-id="home"]')
      const sports = document.querySelector('.rail .navs [data-nav-id="sports"]')
      return {
        count: badges.length,
        homeIsButton: home?.tagName === 'BUTTON',
        homeBadge: home?.querySelector('[data-nav-badge]') ? 1 : 0,
        sportsAria: sports?.getAttribute('aria-label'),
      }
    })()`)
    ok(
      '编辑态条目按钮化：7 枚「−」徽标（总览固定件除外）、总览不可移除、aria 换动作语义',
      badgeState.count === 7 && badgeState.homeIsButton && badgeState.homeBadge === 0 && badgeState.sportsAria === '从左栏移除『运动』',
      JSON.stringify(badgeState),
    )

    const exitState = await evalJS(`(() => {
      const acts = [...document.querySelectorAll('.panel .pactions button')].map((e) => e.textContent.trim())
      const title = document.querySelector('.panel .ptitle')?.textContent.trim()
      return { acts, title, editGone: !acts.some((t) => t.includes('编辑左栏')) }
    })()`)
    ok(
      '面板换候选源：「编辑」原位替换为「放弃变更 / 保存布局」两颗',
      exitState.title === '添加到左栏' && exitState.editGone && exitState.acts.includes('放弃变更') && exitState.acts.includes('保存布局'),
      JSON.stringify(exitState),
    )

    // 全新安装（无布局键）→ 渲染 = 全目录 → 候选为空是正确语义（没有可加回的东西）
    const cand0 = await menuItems()
    ok('全新安装候选面板为空（目录已全在布局里）', cand0.length === 0, cand0.join(' · '))

    // 壳层簇的非编辑面：aria-disabled 挂上、键盘/指针路径封死（点击不跳）
    const gated = await evalJS(`(() => {
      const me = document.querySelector('.rail .ric.me')
      const cmd = document.querySelector('.rail .ric.cmd')
      return { me: me?.getAttribute('aria-disabled'), cmd: cmd?.getAttribute('aria-disabled') }
    })()`)
    ok('壳层簇编辑态挂 aria-disabled（logo/cmd/insp/me 非编辑面）', gated.me === 'true' && gated.cmd === 'true', JSON.stringify(gated))
    await evalJS(`document.querySelector('.rail .ric.me')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`)
    await sleep(400)
    const hashAfterMe = await evalJS(`location.hash`)
    ok('编辑态里点「我」不导航（路由出口封死）', !hashAfterMe.includes('me'), String(hashAfterMe))

    // mask 盖住主内容：主内容区的命中元素就是遮罩自己（inert + z45 的双保险）
    const maskHit = await evalJS(`(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      return el?.className ?? null
    })()`)
    ok('主内容区命中的是遮罩（mask 覆盖被遮内容）', String(maskHit).includes('nav-edit-mask'), String(maskHit))

    /* ================ C. 「−」撤回到 menu（草稿感知候选） ================ */
    console.log('—— C. 「−」撤回到 menu ——')
    await evalJS(`document.querySelector('.rail .navs [data-nav-id="sports"]')?.click()`)
    await sleep(300)
    const orderC = await railOrder()
    ok(
      '「−」撤回：运动从草稿摘除（总览仍居首）',
      JSON.stringify(orderC) === JSON.stringify(['home', 'nutrition', 'campus-schedule', 'focus', 'todos', 'ledger', 'ai']),
      orderC.join(' · '),
    )
    const candC = await menuItems()
    ok(
      '撤掉的条目立刻回到候选面板（「−」= 撤回到 menu 的语义）',
      candC.some((x) => x.includes('运动')),
      candC.join(' · '),
    )
    await shot('C1-remove-to-menu')

    /* ================ D. 拖拽调序 ================ */
    console.log('—— D. 拖拽调序 ——')
    await dragNav('ledger', 'nutrition')
    const orderD = await railOrder()
    ok(
      '整格把手拖拽：记账拖到营养之前（live reorder）',
      JSON.stringify(orderD) === JSON.stringify(['home', 'ledger', 'nutrition', 'campus-schedule', 'focus', 'todos', 'ai']),
      orderD.join(' · '),
    )

    /* ================ E. 保存布局与持久化 ================ */
    console.log('—— E. 保存布局与持久化 ——')
    if (!(await clickPanelAction('保存布局'))) throw new Error('找不到「保存布局」钮')
    await sleep(500)
    const savedOrder = await railOrder()
    const savedAria = await railAria()
    ok(
      '保存退出：布局落定（运动出局）、aria 全集保留壳层簇',
      JSON.stringify(savedOrder) === JSON.stringify(['home', 'ledger', 'nutrition', 'campus-schedule', 'focus', 'todos', 'ai']) &&
        !savedAria.includes('运动') &&
        savedAria.includes('全部菜单'),
      savedOrder.join(' · '),
    )
    const maskGoneSave = await evalJS(`!document.querySelector('.nav-edit-mask')`)
    ok('保存后编辑态收场（遮罩撤下）', maskGoneSave === true)

    const storedRaw = await evalJS(`localStorage.getItem('rein.navLayout.v1')`)
    const stored = storedRaw ? JSON.parse(storedRaw) : null
    ok(
      'rein.navLayout.v1 写入 rail 序（固定件「home」不入存）',
      stored?.v === 1 && JSON.stringify(stored.rail) === JSON.stringify(['ledger', 'nutrition', 'campus-schedule', 'focus', 'todos', 'ai']),
      storedRaw ?? 'null',
    )

    await evalJS(`location.reload()`)
    await waitFor(`document.querySelector('.rail .ric')`, 12000, '刷新后导航轨')
    await sleep(500)
    const reloaded = await railOrder()
    ok(
      '刷新后布局保持（localStorage 持久化）',
      JSON.stringify(reloaded) === JSON.stringify(['home', 'ledger', 'nutrition', 'campus-schedule', 'focus', 'todos', 'ai']),
      reloaded.join(' · '),
    )

    // 判据 ⑥：目录源不受布局污染 —— 撤掉的条目仍能从菜单一键回得去
    await openMenu()
    const itemsE = await menuItems()
    ok('目录源不受布局污染：撤掉的「运动」仍在菜单（列出所有注册的功能）', itemsE.some((x) => x.includes('运动')), itemsE.join(' · '))
    if (!(await clickMenuItem('运动'))) throw new Error('菜单项「运动」找不到')
    await sleep(500)
    const hashSports = await evalJS(`location.hash`)
    ok('从菜单一键回到被撤模块（#\\/sports）', hashSports.includes('sports'), String(hashSports))
    await goto('#/')

    /* ================ F. 放弃变更回滚 ================ */
    console.log('—— F. 放弃变更回滚 ——')
    await enterEdit()
    await evalJS(`document.querySelector('.rail .navs [data-nav-id="todos"]')?.click()`)
    await sleep(300)
    const draftF = await railOrder()
    if (!(await clickPanelAction('放弃变更'))) throw new Error('找不到「放弃变更」钮')
    await sleep(500)
    const afterDiscard = await railOrder()
    const storedAfterDiscard = await evalJS(`localStorage.getItem('rein.navLayout.v1')`)
    const maskGoneDiscard = await evalJS(`!document.querySelector('.nav-edit-mask') && !document.querySelector('.panel[role="menu"]')`)
    ok(
      '放弃变更：布局回滚到编辑前、存储一字未动、会话收场',
      JSON.stringify(draftF) === JSON.stringify(['home', 'ledger', 'nutrition', 'campus-schedule', 'focus', 'ai']) &&
        JSON.stringify(afterDiscard) === JSON.stringify(['home', 'ledger', 'nutrition', 'campus-schedule', 'focus', 'todos', 'ai']) &&
        JSON.parse(storedAfterDiscard).rail.includes('todos') &&
        maskGoneDiscard === true,
      `草稿 ${draftF.join('·')} → 回滚 ${afterDiscard.join('·')}`,
    )
    await shot('F1-discard-rollback')
    await shotDark('F2-discard-rollback-dark')

    /* ================ G. 预置布局 · 冻结语义 · Esc 不退会话 ================ */
    console.log('—— G. 预置布局 · 冻结语义 · Esc ——')
    // 预置时机走 Page.addScriptToEvaluateOnNewDocument（与 presetFeatureFlags 同一条纪律：
    // navLayout store 启动即读，进页再写无效）
    await presetNavLayout((method, params) => cdp(method, params), { rail: ['ai', 'nutrition', 'todos'] })
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelector('.rail .ric')`, 12000, '预置布局后的导航轨')
    await sleep(500)
    const orderG = await railOrder()
    ok(
      '预置布局生效且「冻结」：存储外的条目不自动出现（总览居首 + AI/营养/待办）',
      JSON.stringify(orderG) === JSON.stringify(['home', 'ai', 'nutrition', 'todos']),
      orderG.join(' · '),
    )

    await openMenu()
    const itemsG = await menuItems()
    ok('预置布局下正常态菜单仍是目录全集（不随布局收窄）', itemsG.length >= 7 && itemsG.some((x) => x.includes('运动')), itemsG.join(' · '))
    await closeMenu()

    await enterEdit()
    const candG = await menuItems()
    ok(
      '候选 = 目录 − 已存布局（运动/课表/专注/记账 四项待加回）',
      ['运动', '课表', '专注', '记账'].every((t) => candG.some((x) => x.includes(t))) && candG.length === 4,
      candG.join(' · '),
    )

    // 「＋」加回：落在可移动区末尾（随后可拖）
    if (!(await clickMenuItem('运动'))) throw new Error('候选「＋ 运动」找不到')
    await sleep(300)
    const orderG2 = await railOrder()
    const menuStillOpen = await evalJS(`!!document.querySelector('.panel[role="menu"]')`)
    ok(
      '「＋」加回到可移动区末尾；locked 面板不被点「＋」关掉',
      JSON.stringify(orderG2) === JSON.stringify(['home', 'ai', 'nutrition', 'todos', 'sports']) && menuStillOpen,
      `${orderG2.join(' · ')} · menu=${menuStillOpen}`,
    )
    await shot('G1-edit-with-candidates')
    await shotDark('G2-edit-with-candidates-dark')

    // Esc 不是会话出口：只取消进行中的拖拽（这里无拖拽 → 什么都不发生）
    await evalJS(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)
    const escState = await evalJS(`({
      mask: !!document.querySelector('.nav-edit-mask'),
      menu: !!document.querySelector('.panel[role="menu"]'),
    })`)
    ok('Esc 不退出编辑会话（退出只有放弃/保存两条路）', escState.mask === true && escState.menu === true, JSON.stringify(escState))

    // 收尾：恢复默认，避免污染后续手工演示（三个界面偏好键同清，防跨剧本泄漏）
    await evalJS(`localStorage.removeItem('rein.navLayout.v1'); localStorage.removeItem('rein.features.v1'); `)
    await cdp('Emulation.clearDeviceMetricsOverride')
  } finally {
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
    try {
      edge.kill()
    } catch {
      /* 忽略 */
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ✗ ${f.name}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
