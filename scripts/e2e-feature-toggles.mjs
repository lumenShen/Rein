/**
 * e2e-feature-toggles —— 功能插件开关端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：这套开关的价值全在「关掉之后整个应用真的变了样」——工具格少一张卡、
 * 底栏少一个页签、直链被守卫拦回主页、刷新后状态还在。这些跨组件的联动单测反映不出来，
 * 只有真渲染一遍才验证得了；同时它也是回归网：哪天工具格又冒出硬编码卡片，断言会立刻红。
 *
 * 剧本：
 *   1. 「我」页的设置行 → 二级页「设置」三组齐备
 *   2. 「设置 › 打开或关闭功能」→ 十个模块开关（营养 / 记账 / 专注 / 语音 / 录音 / 多设备同步 /
 *      运动 / 课表 / 抢课 / 健康方案）；抢课是课表的子模块且默认关
 *   3. 关掉「运动」→ 工具格无「记运动」、底栏无「运动」页签、直链 /#/sports 被拦回主页
 *   4. 关掉「课表」/「健康方案」→ 工具格对应卡片消失、直链 /#/program 被拦回主页
 *   4b. 关掉「营养 / 记账 / 专注」→ 吃卡整块不渲染、两格状态卡收起、三条直链被拦
 *   4c. 关掉「语音 / 录音 / 多设备同步」→ 录音纪要 chip 消失、设置页番茄钟与同步卡收起、
 *       两条直链（/#/record、/#/settings/sync）被拦
 *   4d. 对外服务网关拿到模块快照（关掉的模块一个都不在里面）—— Rust 侧门禁的前端那一半
 *   5. 重新打开「运动」→ 入口恢复
 *   6. 刷新后开关状态保持（localStorage 持久化）
 *   7. 合并底栏（2026-11：输入行 + 页签行一块玻璃）：输入行在场、页签行听开关
 *      （关掉模块条目消失、重开原位回来）；左钮换落点与引导气泡已随合并退役
 *   8. 桌面工作台：导航轨与便当快捷入口同样听开关，便当不留空洞
 *   9. 内容域模块（营养 / 专注 / 记账）在桌面端的收法 + 拨动后网关快照同步
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-feature-toggles.mjs
 *
 * 修订（2026-11-07）：底栏左右独立圆钮自 b736528 起是**纯图标钮**（不落文字标签，名字进
 * aria-label）——落点断言由 textContent 改读 aria-label（长按提示尾巴「（长按更换）」摘掉
 * 后比对），与 e2e-dock-edit.mjs 的读法同一约定。
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-features-${Date.now()}`
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

/** 主页页脚的入口文案：记录域成员 chip + 状态格标签 + 工具 chip（HomeFooter.vue） */
const toolTitles = () =>
  evalJS(`[...document.querySelectorAll('.hf-member, .hf-chip, .hf-fk, .hf-zk')].map((e) => e.textContent.trim())`)

/** 课表条在不在（连了教务且模块开着才渲染；未连接 = 整条不出现） */
const courseStrip = () => evalJS(`!!document.querySelector('[data-testid="hf-course"]')`)

/** 底栏页签文案清单（底栏根类名是 `.dock`，页签类是 `.dock-tab`） */
const tabLabels = () => evalJS(`[...document.querySelectorAll('.dock .dock-tab')].map((e) => e.textContent.trim())`)

/** 合并底栏（2026-11）：输入行（AI 快捷输入）+ 页签行（固定件 + 插件条目） */
const dockParts = () =>
  evalJS(`(() => ({
    quick: !!document.querySelector('.dock .dock-quick'),
    tabs: [...document.querySelectorAll('.dock .dock-tab')].map((e) => e.textContent.trim()),
  }))()`)

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
    // 等应用挂载完成再改 hash：vue-router 的首次导航若与赋值竞争，会把 hash 拽回初始路由
    await waitFor(`!!document.querySelector('.page')`, 8000, '应用挂载')
    // 每次从干净状态开跑：清掉上一轮的开关
    await evalJS(`localStorage.removeItem('rein.features.v1')`)
    await evalJS(`location.hash = '#/'`)
    await waitFor(`document.querySelectorAll('.hf-member, .hf-chip').length > 0`, 8000, '主页页脚挂载')
    await sleep(400)

    /* ---- 1. 我 › 设置 ---- */
    const beforeTools = await toolTitles()
    ok(
      '默认页脚含 记运动 / 健康方案 成员；未连教务时课表条不出现',
      ['记运动', '健康方案'].every((t) => beforeTools.includes(t)) && !(await courseStrip()),
      beforeTools.join(' · '),
    )
    ok('默认底栏含运动页签', (await tabLabels()).includes('运动'), (await tabLabels()).join(' · '))

    const dock0 = await dockParts()
    ok(
      '合并底栏：输入行在场 · 页签行 = 主页/运动/我/AI（固定件 + 插件条目）',
      dock0.quick && dock0.tabs.join() === '主页,运动,我,AI',
      JSON.stringify(dock0),
    )

    await evalJS(`location.hash = '#/me'`)
    await waitFor(`document.querySelector('.setrow')`, 8000, '「我」页设置行')
    await clickText('.setrow', '设置')
    await waitFor(`document.querySelector('h1')?.textContent === '设置'`, 8000, '设置二级页挂载')
    ok('「我 › 设置」进入二级页', true)
    const groups = await evalJS(`[...document.querySelectorAll('.card .gtitle')].map((e) => e.textContent.trim())`)
    // 设置页的分组会长（性能组就是后加的）——钉住「第一组是功能、最后一组是关于、顺序稳定」，
    // 而不是把当时的组名清单抄死在断言里
    ok(
      '设置页分组齐备（功能在最前、关于在最后）',
      groups[0] === '功能' && groups.at(-1) === '关于' && groups.includes('番茄钟'),
      groups.join(' · '),
    )
    await shot('1-settings')
    await shotDark('1-settings-dark')

    /* ---- 2. 打开或关闭功能 ---- */
    await clickText('.frow', '打开或关闭功能')
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页挂载')
    const rows = await evalJS(`[...document.querySelectorAll('.prow .ptxt b')].map((e) => e.textContent.trim())`)
    ok(
      '开关页列出十个可开关模块（抢课缩进挂在课表下面）',
      rows.join() === '营养,记账,专注,语音,录音,多设备同步,运动,课表,抢课,健康方案',
      rows.join(' · '),
    )
    const switches = await evalJS(`document.querySelectorAll('.prow [role="switch"]').length`)
    ok('每个模块一个 role=switch 开关', switches === 10, `${switches} 个`)
    // 子模块必须缩进挂在父模块下面（DOM 顺序即视觉顺序）
    const nested = await evalJS(`(() => {
      const all = [...document.querySelectorAll('.prow')]
      const parent = all.findIndex((r) => r.querySelector('.ptxt b')?.textContent.trim() === '课表')
      const child = all.findIndex((r) => r.querySelector('.ptxt b')?.textContent.trim() === '抢课')
      const childEl = all[child]
      return {
        rightAfter: child === parent + 1,
        indented: childEl ? parseFloat(getComputedStyle(childEl).marginLeft) > 0 : false,
        tagged: childEl?.querySelector('.namerow .tag')?.textContent.trim() === '子模块',
      }
    })()`)
    ok(
      '子模块紧跟在父模块之后、有缩进且带「子模块」标记',
      nested.rightAfter && nested.indented && nested.tagged,
      JSON.stringify(nested),
    )
    // **默认关闭**：抢课是这套开关里唯一一个默认关的（它比课表激进）
    const defaults = await evalJS(`(() => {
      const out = {}
      for (const r of document.querySelectorAll('.prow')) {
        const name = r.querySelector('.ptxt b')?.textContent.trim()
        const sw = r.querySelector('[role="switch"]')
        if (name && sw) out[name] = sw.getAttribute('aria-checked') === 'true'
      }
      return out
    })()`)
    ok(
      '抢课默认关闭，其余默认打开',
      defaults['抢课'] === false && defaults['课表'] === true && defaults['运动'] === true,
      JSON.stringify(defaults),
    )
    // 默认关着 → 直链进不去
    await evalJS(`location.hash = '#/campus/course-select'`)
    await sleep(600)
    ok(
      '抢课默认关闭时直链被守卫拦回主页',
      (await evalJS(`location.hash`)) === '#/',
      await evalJS(`location.hash`),
    )
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')

    /* ---- 2b. 子模块开关真的放行（开了就能进，关了就不行） ---- */
    ok('打开「抢课」开关', (await setToggle('抢课', true)) === 'clicked')
    await evalJS(`location.hash = '#/campus/course-select'`)
    await sleep(800)
    ok(
      '打开后直链可进（选课页真的挂载了）',
      (await evalJS(`document.querySelector('h1')?.textContent`)) === '选课',
      await evalJS(`location.hash`),
    )
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')
    ok('关掉「抢课」开关（回到默认态）', (await setToggle('抢课', false)) === 'clicked')
    await sleep(300)
    await shot('2-features')
    await shotDark('2-features-dark')

    /* ---- 3. 关掉「运动」 ---- */
    ok('关闭「运动」开关', (await setToggle('运动', false)) === 'clicked')
    await evalJS(`location.hash = '#/'`)
    await waitFor(`document.querySelectorAll('.hf-member, .hf-chip').length > 0`, 8000, '回主页')
    await sleep(400)
    const afterSports = await toolTitles()
    ok('页脚不再有「记运动」', !afterSports.includes('记运动'), afterSports.join(' · '))
    ok('页脚其余入口仍在（记饮食）', afterSports.includes('记饮食'))
    const tabsAfter = await tabLabels()
    ok('底栏不再有「运动」页签', !tabsAfter.includes('运动'), tabsAfter.join(' · '))
    await shot('3-home-sports-off')

    await evalJS(`location.hash = '#/sports'`)
    await sleep(700)
    ok('直链 /#/sports 被守卫拦回主页', (await evalJS(`location.hash`)) === '#/', await evalJS(`location.hash`))
    ok('拦截时给出原因提示', await evalJS(`document.body.textContent.includes('已关闭')`))

    /* ---- 4. 关掉「课表」「健康方案」 ---- */
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')
    ok('关闭「课表」开关', (await setToggle('课表', false)) === 'clicked')
    await sleep(300)
    // 子模块继承父模块：课表关了，抢课开关必须置灰且视为关闭 ——
    // 「工具卡没了但直链还能进」那种半关状态就是这里防的。
    // 原因文案在**状态胶囊**里（2026-10 起从描述行剥出来单独成态，见 FeatureSettingsPage 的注释），
    // 描述行只剩模块自己的说明 —— 断言别再去 em 里找那句话。
    const subOff = await evalJS(`(() => {
      const row = [...document.querySelectorAll('.prow')].find(
        (r) => r.querySelector('.ptxt b')?.textContent.trim() === '抢课',
      )
      const sw = row?.querySelector('[role="switch"]')
      return {
        disabled: sw?.disabled === true,
        checked: sw?.getAttribute('aria-checked') === 'true',
        hint: row?.querySelector('.ptxt .schip')?.textContent.includes('课表关闭时不可用') === true,
      }
    })()`)
    ok(
      '课表关掉后抢课开关置灰、视为关闭、并写明原因',
      subOff.disabled && subOff.checked === false && subOff.hint,
      JSON.stringify(subOff),
    )
    await evalJS(`location.hash = '#/settings/features'`) // 关掉的开关会改导航，这里重新确认页面在
    await sleep(300)
    ok('关闭「健康方案」开关', (await setToggle('健康方案', false)) === 'clicked')
    await sleep(450)
    await shot('4-features-all-off')

    await evalJS(`location.hash = '#/'`)
    await sleep(700)
    const afterAll = await toolTitles()
    ok(
      '模块成员全部消失，内核事实仍在（吃卡 / 专注 / 钱）',
      !afterAll.includes('记运动') &&
        !afterAll.includes('健康方案') &&
        !(await courseStrip()) &&
        afterAll.includes('记饮食') &&
        afterAll.includes('钱') &&
        afterAll.includes('专注'),
      afterAll.join(' · '),
    )
    const dockNoCampus = await dockParts()
    // 此时「运动」还在关着（第 3 步关掉、第 5 步才重开），页签行 = 主页,我,AI；
    // 课表只投 rail，关掉它动不了底栏
    ok(
      '关掉课表后：底栏不受影响（页签行 = 主页/我/AI，输入行在场）',
      dockNoCampus.quick && dockNoCampus.tabs.join() === '主页,我,AI',
      JSON.stringify(dockNoCampus),
    )
    await shot('5-home-modules-off')

    await evalJS(`location.hash = '#/program'`)
    await sleep(700)
    ok('直链 /#/program 被守卫拦回主页', (await evalJS(`location.hash`)) === '#/')

    /* ---- 4b. 内容域模块：营养 / 记账 / 专注 一键收起 ---- */
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')
    for (const name of ['营养', '记账', '专注']) {
      ok(`关闭「${name}」开关`, (await setToggle(name, false)) === 'clicked')
    }
    await sleep(400)
    await evalJS(`location.hash = '#/'`)
    await waitFor(`document.querySelectorAll('.hf-member, .hf-chip').length > 0`, 8000, '回主页')
    await sleep(400)
    const afterCoreOff = await toolTitles()
    ok(
      '营养关掉后「吃」卡整块不渲染（成员缺失即整区消失，不留空壳）',
      !(await evalJS(`!!document.querySelector('[data-testid="hf-zone-eat"]')`)) &&
        !afterCoreOff.includes('记饮食') &&
        !afterCoreOff.includes('饮食库'),
      afterCoreOff.join(' · '),
    )
    ok(
      '记账 / 专注关掉后两格状态卡（钱 / 专注）一起收起',
      !(await evalJS(`!!document.querySelector('[data-testid="hf-fact-money"]')`)) &&
        !(await evalJS(`!!document.querySelector('[data-testid="hf-fact-focus"]')`)),
    )
    for (const [path, label] of [
      ['#/nutrition', '营养'],
      ['#/ledger', '记账'],
      ['#/focus', '专注'],
    ]) {
      await evalJS(`location.hash = '${path}'`)
      await sleep(500)
      ok(
        `${label}关掉后直链 /${path} 被守卫拦回主页`,
        (await evalJS(`location.hash`)) === '#/',
        await evalJS(`location.hash`),
      )
    }
    await shot('4b-home-content-modules-off')

    /* ---- 4c. 语音 / 录音 / 多设备同步：入口与设置卡一起收 ---- */
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')
    for (const name of ['语音', '录音', '多设备同步']) {
      ok(`关闭「${name}」开关`, (await setToggle(name, false)) === 'clicked')
    }
    await sleep(400)
    await evalJS(`location.hash = '#/'`)
    await waitFor(`document.querySelectorAll('.hf-member, .hf-chip').length > 0`, 8000, '回主页')
    await sleep(400)
    const afterToolOff = await toolTitles()
    ok(
      '语音关掉后「录音纪要」chip 消失（AI 助手仍在）',
      !afterToolOff.includes('录音纪要') && afterToolOff.includes('AI 助手'),
      afterToolOff.join(' · '),
    )
    await evalJS(`location.hash = '#/record'`)
    await sleep(600)
    ok(
      '录音关掉后直链 /#/record 被守卫拦回主页',
      (await evalJS(`location.hash`)) === '#/',
      await evalJS(`location.hash`),
    )
    await evalJS(`location.hash = '#/settings/sync'`)
    await sleep(600)
    ok(
      '同步关掉后直链 /#/settings/sync 被守卫拦回主页',
      (await evalJS(`location.hash`)) === '#/',
      await evalJS(`location.hash`),
    )
    // 设置页：番茄钟配置卡属「专注」、同步卡属「多设备同步」，都应随模块一起收
    await evalJS(`location.hash = '#/settings'`)
    await waitFor(`document.querySelector('h1')?.textContent === '设置'`, 8000, '设置二级页')
    await sleep(400)
    const groupsOff = await evalJS(
      `[...document.querySelectorAll('.card .gtitle')].map((e) => e.textContent.trim())`,
    )
    ok(
      '设置页的番茄钟与多设备同步两张卡随模块收起，其余分组仍在',
      !groupsOff.includes('番茄钟') &&
        !groupsOff.includes('多设备同步') &&
        groupsOff.includes('性能') &&
        groupsOff.includes('关于'),
      groupsOff.join(' · '),
    )
    await shot('4c-settings-modules-off')

    /* ---- 4d. 对外服务网关拿到模块快照（Rust 侧门禁的输入，contract §4.7） ----
       真机的门禁在 `store::module_gate`（Rust 单测守住），这里守的是**前端那一半**：
       App.vue 的 watcher 有没有把「已启用模块」推给 Rust —— 推丢了门禁就永远 fail-open。 */
    const gwModules = await evalJS(`(async () => {
      const { mockGatewayEnabledModules } = await import('/src/mock/server.ts')
      return mockGatewayEnabledModules()
    })()`)
    const TOGGLEABLE = [
      'sports', 'campus', 'campus-grab', 'program', 'nutrition',
      'ledger', 'focus', 'voice', 'record', 'sync',
    ]
    ok(
      '对外网关拿到模块快照：关掉的十个模块一个都不在，内核（ai / todos）在',
      Array.isArray(gwModules) &&
        gwModules.includes('ai') &&
        gwModules.includes('todos') &&
        gwModules.every((id) => !TOGGLEABLE.includes(id)),
      JSON.stringify(gwModules),
    )

    /* ---- 5. 重新打开「运动」 ---- */
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页')
    ok('重新打开「运动」开关', (await setToggle('运动', true)) === 'clicked')
    await evalJS(`location.hash = '#/'`)
    await sleep(700)
    const reopened = await toolTitles()
    ok('工具格恢复「记运动」', reopened.includes('记运动'), reopened.join(' · '))
    ok('底栏恢复「运动」页签', (await tabLabels()).includes('运动'))

    /* ---- 6. 持久化 ---- */
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelectorAll('.hf-member, .hf-chip').length > 0`, 12000, '刷新后页脚挂载')
    await sleep(500)
    const afterReload = await toolTitles()
    ok(
      '刷新后开关状态保持（运动开、课表 / 健康方案关）',
      afterReload.includes('记运动') && !afterReload.includes('健康方案') && !(await courseStrip()),
      afterReload.join(' · '),
    )

    /* ---- 6. 桌面工作台：导航轨与便当快捷入口同样听开关 ---- */
    await evalJS(`localStorage.removeItem('rein.features.v1')`)
    // 新键也进清场清单（rein.navLayout.v1）：上一个跑过的布局编辑剧本若留下状态，
    // 这里的桌面段断言（rail aria 全集）会被残留布局带偏 —— 防跨剧本泄漏
    await evalJS(`localStorage.removeItem('rein.navLayout.v1')`)
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await evalJS(`location.hash = '#/'`)
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelector('.rail') && document.querySelectorAll('.rail .ric').length > 0`, 12000, '桌面导航轨')
    await sleep(600)
    const railAll = await evalJS(`[...document.querySelectorAll('.rail .ric')].map((e) => e.getAttribute('aria-label'))`)
    ok(
      '桌面导航轨默认含课表与运动',
      railAll.includes('课表') && railAll.includes('运动'),
      railAll.join(' · '),
    )
    await shot('6-desktop-rail')

    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页（桌面）')
    await setToggle('课表', false)
    await setToggle('运动', false)
    await evalJS(`location.hash = '#/'`)
    await sleep(800)
    const railOff = await evalJS(`[...document.querySelectorAll('.rail .ric')].map((e) => e.getAttribute('aria-label'))`)
    ok(
      '关掉后导航轨里课表 / 运动消失，其余保留',
      !railOff.includes('课表') && !railOff.includes('运动') && railOff.includes('营养') && railOff.includes('待办'),
      railOff.join(' · '),
    )
    const tiles = await evalJS(`[...document.querySelectorAll('.t-qa .qtile, .t-qa button')].map((e) => e.textContent.trim())`)
    ok('便当快捷入口不再有「记运动」', !tiles.some((t) => t.includes('记运动')), tiles.join(' · '))
    const wkCard = await evalJS(`!!document.querySelector('.t-wk')`)
    ok('便当「本周运动」概览一并消失（无空洞布局）', wkCard === false)
    // 布局自检：grid-template-areas 少写一行会凭空多出隐式轨道，把各块挤成竖条。
    // 断言「每块都有正常宽度且无横向溢出」，这类错误不会再靠肉眼发现。
    const bentoFit = await evalJS(`(() => {
      const b = document.querySelector('.bento')
      const kids = [...b.children].map((e) => Math.round(e.getBoundingClientRect().width))
      return { overflowX: b.scrollWidth - b.clientWidth, minW: Math.min(...kids), cols: kids.length }
    })()`)
    ok(
      '便当布局没有隐式轨道（子块宽度正常、无横向溢出）',
      bentoFit.overflowX <= 1 && bentoFit.minW > 200,
      `最小块宽 ${bentoFit.minW}px · 横向溢出 ${bentoFit.overflowX}px`,
    )
    await shot('7-desktop-modules-off')

    /* ---- 9. 内容域模块在桌面端的收法（导航轨 + 便当块 + 快捷磁贴一起收） ---- */
    await evalJS(`location.hash = '#/settings/features'`)
    await waitFor(`document.querySelector('h1')?.textContent === '打开或关闭功能'`, 8000, '功能开关页（桌面）')
    for (const name of ['营养', '专注', '记账']) {
      ok(`桌面端关闭「${name}」开关`, (await setToggle(name, false)) === 'clicked')
    }
    await evalJS(`location.hash = '#/'`)
    await sleep(800)
    const bentoOff = await evalJS(`(() => ({
      ids: [...document.querySelectorAll('.bento .b-item')].map((e) => e.dataset.bentoId),
      rail: [...document.querySelectorAll('.rail .ric')].map((e) => e.getAttribute('aria-label')),
    }))()`)
    ok(
      '关掉营养 / 专注 / 记账后：便当对应的块（能量 / 今日饮食 / 记饮食磁贴 / 番茄钟 / 专注磁贴 / 记账）与导航轨条目一起消失',
      !['hero', 'diet', 'qa-food', 'pomodoro', 'qa-focus', 'led'].some((id) => bentoOff.ids.includes(id)) &&
        !['营养', '专注', '记账'].some((l) => bentoOff.rail.includes(l)) &&
        bentoOff.rail.includes('待办'),
      bentoOff.ids.join(' · '),
    )
    // 少了几块也不能冒出隐式轨道（与第 8 节同一条自检，这一轮少的是 6 块）
    const bentoFit2 = await evalJS(`(() => {
      const b = document.querySelector('.bento')
      const kids = [...b.children].map((e) => Math.round(e.getBoundingClientRect().width))
      return { overflowX: b.scrollWidth - b.clientWidth, minW: Math.min(...kids), cols: kids.length }
    })()`)
    ok(
      '便当仍无隐式轨道（剩下每块宽度正常、无横向溢出）',
      bentoFit2.overflowX <= 1 && bentoFit2.minW > 200,
      `剩 ${bentoFit2.cols} 块 · 最小块宽 ${bentoFit2.minW}px · 横向溢出 ${bentoFit2.overflowX}px`,
    )
    // 桌面端拨动同样会推快照（证明 watcher 是「拨动时」也发，而不是只在启动发一次）
    const gwDesktop = await evalJS(`(async () => {
      const { mockGatewayEnabledModules } = await import('/src/mock/server.ts')
      return mockGatewayEnabledModules()
    })()`)
    ok(
      '桌面端拨动后网关快照同步：营养 / 专注 / 记账出局，待办 / AI 留下',
      Array.isArray(gwDesktop) &&
        gwDesktop.includes('todos') &&
        !['nutrition', 'focus', 'ledger', 'sports', 'campus'].some((id) => gwDesktop.includes(id)),
      JSON.stringify(gwDesktop),
    )
    await shot('8-desktop-content-modules-off')

    // 收尾：恢复默认，避免污染后续手工演示（导航布局新键同清，防跨剧本泄漏）
    await cdp('Emulation.clearDeviceMetricsOverride')
    await evalJS(`localStorage.removeItem('rein.features.v1')`)
    await evalJS(`localStorage.removeItem('rein.navLayout.v1')`)
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
