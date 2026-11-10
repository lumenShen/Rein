/**
 * e2e-about-settings-apps —— 「关于你」工作区投影 + 设置三组 + 连接应用 + 运动设置链
 * （无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么单独一条：这一轮是**信息架构重构**——「我」改「关于你」、设置页压成三组、
 * 番茄钟/训练准备时长移回各自模块。它没有新增 IPC，坏掉的方式也几乎全是「入口不见了 /
 * 落错页 / 分组多了或少了一行」，单测与类型检查都看不出来，只能真渲染一遍。
 *
 * 覆盖：
 *   1. `/me` 关于你：hero、记忆卡（正文或空态）、健康大卡（4 磁贴）、5 张普通文件夹卡、
 *      程序数据卡在最后一项；点进 `/me/program` 后 13 行且最后一行是「记忆」。
 *   2. `/settings` 三组（能力与连接 / 通用 / 关于）与七行入口。
 *   3. 运动设置两级入口：`/sports` 页头齿轮 → `/sports/settings` → 跑步设置 / 课程设置。
 *   4. `/settings/apps` 平台页签存在、Android 页签下有真实健康数据行；页底外部访问入口
 *      能进 `/settings/apps/external`，网关卡与开关在。
 *
 * 断言只用 `data-testid` 与文本，不依赖 scoped CSS 类名；平台相关断言**不写死是哪个平台**
 * （CI 可能是 macOS/Linux 的浏览器），只要求页签存在且 Android 页签能切出健康行。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-about-settings-apps.mjs
 * 环境变量：REIN_E2E_OUT（截图与 profile 目录）；默认时间戳唯一目录，避免 localStorage 残留。
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-about-settings-${Date.now()}`
const USER_DATA = `${OUT}/profile`
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
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

async function waitFor(expr, timeoutMs = 10000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return true
    } catch {
      /* 导航中上下文会短暂失效 */
    }
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

const sel = (id) => `document.querySelector('[data-testid="${id}"]')`
const selAll = (id) => `document.querySelectorAll('[data-testid="${id}"]')`
const has = (id) => `!!${sel(id)}`
const text = (id) => `${sel(id)}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`

const waitId = (id, timeoutMs = 10000, label = id) => waitFor(has(id), timeoutMs, label)
const waitH1 = (title, timeoutMs = 10000) =>
  waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(title)}`, timeoutMs, `h1=${title}`)

async function clickId(id) {
  return evalJS(`(() => {
    const el = ${sel(id)}
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function count(selector) {
  return evalJS(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
}

async function goto(hash, title, timeoutMs = 12000) {
  await evalJS(`location.hash = ${JSON.stringify(hash)}`)
  await waitH1(title, timeoutMs)
  await sleep(500)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${SHOTS}/${name}.png`)
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(m.params?.exceptionDetails?.exception?.description ?? 'uncaught exception'))
    }
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

/* ---------------- 主流程 ---------------- */

async function main() {
  const edge = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--disable-extensions',
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    await connect(`${APP}/#/me`)
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await evalJS(`localStorage.removeItem('rein.features.v1')`)
    await evalJS(`localStorage.removeItem('rein.connectedApps.placeholder.v1')`)
    await evalJS(`localStorage.removeItem('rein.connectedApps.v1')`)

    /* ================= 1. 关于你 ================= */
    await waitId('about-page', 12000, '关于你页挂载')
    ok('1.1 页头标题是「关于你」', (await evalJS(`document.querySelector('h1')?.textContent`)) === '关于你')

    await waitId('about-hero')
    const hero = await evalJS(`(() => {
      const el = ${sel('about-hero')}
      return { h2: el?.querySelector('h2')?.textContent.trim() ?? null, text: el?.textContent.replace(/\\s+/g, ' ').trim() ?? '' }
    })()`)
    ok(
      '1.2 hero：标题「让 Rein 更了解你」且三行引导都在（上传 / 连接应用 / 聊聊）',
      hero.h2 === '让 Rein 更了解你' &&
        hero.text.includes('知道得越多') &&
        !!(await evalJS(has('about-guide-upload'))) &&
        !!(await evalJS(has('about-guide-connect'))) &&
        !!(await evalJS(has('about-guide-chat'))),
      JSON.stringify(hero),
    )
    ok(
      '1.3 页头齿轮存在（进设置）',
      !!(await evalJS(has('about-settings-entry'))),
    )

    await waitId('about-memory-card', 12000, '记忆卡')
    await waitFor(
      `${has('about-memory-body')} || ${has('about-memory-empty')}`,
      12000,
      '记忆卡正文或空态',
    )
    const memory = await evalJS(`(() => {
      const card = ${sel('about-memory-card')}
      return {
        title: card?.querySelector('h2')?.textContent.trim() ?? null,
        body: ${has('about-memory-body')},
        empty: ${has('about-memory-empty')},
        manage: ${has('about-memory-manage')},
      }
    })()`)
    ok(
      '1.4 记忆卡：「我对你的了解」+ 正文或空态（两者必居其一）',
      memory.title === '我对你的了解' && (memory.body || memory.empty),
      JSON.stringify(memory),
    )

    await waitId('about-health-card', 12000, '健康大卡')
    const health = await evalJS(`(() => ({
      meta: ${text('about-health-meta')},
      view: ${has('about-folder-health')},
      auth: ${has('about-health-auth')},
      constraints: ${has('about-constraints-edit')},
      tiles: ['about-health-tile-sleep', 'about-health-tile-resting-hr', 'about-health-tile-hrv', 'about-health-tile-steps']
        .filter((id) => document.querySelector('[data-testid="' + id + '"]')).length,
    }))()`)
    ok(
      '1.5 健康大卡：计数行 + 4 个指标磁贴 + 「查看」/授权/约束编辑入口',
      typeof health.meta === 'string' &&
        health.tiles === 4 &&
        health.view &&
        health.auth &&
        health.constraints,
      JSON.stringify(health),
    )

    const folderIds = ['about-folder-about', 'about-folder-life', 'about-folder-voice', 'about-folder-notes', 'about-folder-corner']
    const missingFolders = []
    for (const id of folderIds) if (!(await evalJS(has(id)))) missingFolders.push(id)
    ok(
      '1.6 文件夹网格：关于你 / 生活 / 语音笔记 / 笔记与文档 / Rein 的角落 五张卡都在',
      missingFolders.length === 0,
      missingFolders.length ? missingFolders.join(', ') : folderIds.join(' · '),
    )

    const program = await evalJS(`(() => {
      const card = ${sel('about-program-card')}
      if (!card) return null
      // 「全部」区域里程序数据卡排在最后：只依赖 DOM 结构，不依赖任何样式类
      const last = card.parentElement ? card.parentElement.lastElementChild === card : false
      return { text: card.textContent.replace(/\\s+/g, ' ').trim(), last }
    })()`)
    ok(
      '1.7 「程序数据」是全部区域的最后一项，且标出 13 个目录',
      !!program && program.last && program.text.includes('程序数据') && program.text.includes('13 个目录'),
      program ? JSON.stringify(program) : '未找到程序数据卡',
    )
    await shot('1-about-you')

    /* 程序数据页：13 行固定存在，最后一项是「记忆」 */
    await goto('#/me/program', '程序数据')
    await waitId('program-data-page')
    const dirs = await evalJS(`(() => {
      const rows = [...document.querySelectorAll('[data-testid^="program-data-row-"]')]
      return {
        n: rows.length,
        last: rows.at(-1)?.getAttribute('data-testid') ?? null,
        lastText: rows.at(-1)?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      }
    })()`)
    ok(
      '1.8 程序数据页：13 行都在，最后一项是「记忆」',
      dirs.n === 13 && dirs.last === 'program-data-row-memories' && (dirs.lastText ?? '').includes('记忆'),
      JSON.stringify(dirs),
    )
    ok(
      '1.9 程序数据页的「打开完整文件管理器」入口在',
      !!(await evalJS(has('program-data-open-manager'))),
    )

    /* ================= 2. 设置三组七行 ================= */
    await goto('#/settings', '设置')
    const groups = await evalJS(`(() => {
      const want = ['settings-group-capability', 'settings-group-general', 'settings-group-about']
      return want.map((id) => {
        const el = document.querySelector('[data-testid="' + id + '"]')
        return { id, title: el?.querySelector('.gtitle, h2')?.textContent.trim() ?? null }
      })
    })()`)
    ok(
      '2.1 设置页三组：能力与连接 / 通用 / 关于',
      groups.map((g) => g.title).join() === '能力与连接,通用,关于',
      JSON.stringify(groups),
    )
    const settingsRows = [
      'settings-row-apps',
      'settings-row-devices',
      'settings-row-features',
      'settings-float-entry',
      'settings-row-appearance',
      'settings-data-clear',
      'settings-row-update',
    ]
    const missingRows = []
    for (const id of settingsRows) if (!(await evalJS(has(id)))) missingRows.push(id)
    ok(
      '2.2 设置页七行入口都在（连接应用 / 设备 / 功能 / 浮窗 / 外观与性能 / 清数据 / 更新）',
      missingRows.length === 0,
      missingRows.length ? `缺 ${missingRows.join(', ')}` : `${settingsRows.length} 行`,
    )
    ok(
      '2.3 设置页不再有番茄钟 / 训练 / 外部访问 / 第三方数据管理卡',
      (await evalJS(`(() => {
        const hs = [...document.querySelectorAll('[data-testid^="settings-group-"] .gtitle')].map((e) => e.textContent.trim())
        return !hs.some((t) => ['番茄钟', '训练', '外部访问', '第三方数据管理'].includes(t))
      })()`)) === true,
    )
    await shot('2-settings')

    /* ================= 3. 运动设置两级入口 ================= */
    await goto('#/sports', '运动')
    ok('3.1 运动页页头有设置齿轮', !!(await evalJS(has('sports-settings-entry'))))
    await clickId('sports-settings-entry')
    await waitH1('运动设置')
    await waitId('sports-settings-page')
    ok(
      '3.2 运动设置两级入口：跑步设置 / 课程设置',
      !!(await evalJS(has('sports-settings-run'))) && !!(await evalJS(has('sports-settings-course'))),
    )

    await clickId('sports-settings-run')
    await waitH1('跑步设置')
    await waitId('run-settings-page')
    const runPage = await evalJS(`(() => ({
      autoPause: ${has('run-settings-autopause')},
      background: ${has('run-settings-background')},
      tutorialBg: ${has('run-settings-tutorial-background')},
      tutorialKilled: ${has('run-settings-tutorial-killed')},
      status: ${has('run-settings-status-granted')} || ${has('run-settings-status-retry')},
    }))()`)
    ok(
      '3.3 跑步设置：自动暂停 + 后台记录状态 + 两篇教程',
      runPage.autoPause && runPage.background && runPage.tutorialBg && runPage.tutorialKilled && runPage.status,
      JSON.stringify(runPage),
    )

    await goto('#/sports/settings', '运动设置')
    await clickId('sports-settings-course')
    await waitH1('课程设置')
    await waitId('course-settings-page')
    ok(
      '3.4 课程设置：训练准备时长步进器在',
      !!(await evalJS(has('course-settings-prep'))),
    )
    await shot('3-sports-settings')

    /* ================= 4. 连接应用 ================= */
    await goto('#/settings/apps', '连接应用')
    await waitId('connected-apps-page')
    const tabs = await evalJS(`(() => ({
      android: !!document.querySelector('[data-testid="apps-tab-android"]'),
      ios: !!document.querySelector('[data-testid="apps-tab-ios"]'),
      mac: !!document.querySelector('[data-testid="apps-tab-mac"]'),
      windows: !!document.querySelector('[data-testid="apps-tab-windows"]'),
      selected: [...document.querySelectorAll('[data-testid^="apps-tab-"]')]
        .filter((e) => e.getAttribute('aria-selected') === 'true').length,
    }))()`)
    ok(
      '4.1 平台页签齐备（Android / iOS / Mac / Windows），且恰有一枚 aria-selected',
      tabs.android && tabs.ios && tabs.mac && tabs.windows && tabs.selected === 1,
      JSON.stringify(tabs),
    )

    await clickId('apps-tab-android')
    await waitId('apps-row-health')
    const healthRow = await evalJS(`(() => {
      const row = ${sel('apps-row-health')}
      return {
        text: row?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
        label: row?.querySelector('[data-testid="connected-app-health"]')?.getAttribute('aria-label') ?? null,
      }
    })()`)
    ok(
      '4.2 Android 页签下有真实健康数据行',
      !!healthRow.text && healthRow.text.includes('健康数据'),
      JSON.stringify(healthRow),
    )
    await shot('4-connected-apps')

    await clickId('apps-external-entry')
    await waitH1('外部访问')
    await waitId('external-access-page')
    ok(
      '4.3 页底外部访问入口能进 /settings/apps/external，网关卡与开关在',
      !!(await evalJS(has('settings-external-access'))) &&
        !!(await evalJS(has('gateway-toggle-enabled'))),
    )

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
