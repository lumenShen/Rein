/**
 * e2e-connected-apps-real —— 连接应用（/settings/apps）真实状态 + 抽屉 + AI 工具链
 * （无头 Edge/Chrome + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么单独一条：`e2e-about-settings-apps.mjs` 只守信息架构（页签/入口/健康行）；
 * 这条守「连接 → 允许 AI → 允许写入 → 工具读 → 工具写 → 确认 → 审计」整条链。
 * 无头浏览器里没有真模型，但这条链上真正会坏的是状态注册表、权限拆分、确认层与
 * mock 错误码，不是模型的措辞；工具直调钩子 `window.__REIN_TOOL__` 与聊天链路
 * 用的是同一份 `src/ai/tools/registry.ts`。
 *
 * 覆盖：
 *   1. 页面行状态：已连接 / 去授权 / 不支持；右侧是 pill，不是 `+` / `✓`。
 *   2. 点行开 `connected-app-sheet`；读取/写入权限分行；AI/写入开关的可用性。
 *   3. 文件根区显示「可读写 / 只读」与根 label；「重新检测」不丢状态。
 *   4. `window.__REIN_TOOL__` 读日历；写日历弹 `tool-confirm-sheet`：
 *      允许 → mock 成功、列表可见；拒绝 → 工具 error、列表不变、`__audit` 有 denied。
 *   5. 桌面文件：`list_desktop_roots` 剥离绝对路径；写文件确认后读回新内容。
 *   6. 命令行：勾风险确认后连接，`run_terminal_command` 每次确认，mock 明确标 simulated。
 *   7. 全程零 console error / 零未捕获异常。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-connected-apps-real.mjs
 * 说明：浏览器 mock 不读写本机文件、不执行真实命令；写方法返回样例并带 `meta.mock=true`。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const BROWSER = BROWSER_CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('找不到 Edge/Chrome，无法运行 e2e')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-connected-apps-${Date.now()}`
const USER_DATA = `${OUT}/profile`
mkdirSync(OUT, { recursive: true })

const DEBUG_PORT = 9570 + (process.pid % 180)
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
  const r = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error(
      'eval 异常: ' +
        String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
    )
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
const has = (id) => `!!${sel(id)}`
const text = (id) =>
  `${sel(id)}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`

const waitId = (id, timeoutMs = 10000, label = id) => waitFor(has(id), timeoutMs, label)
const waitH1 = (title, timeoutMs = 12000) =>
  waitFor(
    `document.querySelector('h1')?.textContent === ${JSON.stringify(title)}`,
    timeoutMs,
    `h1=${title}`,
  )

async function clickId(id) {
  return evalJS(`(() => {
    const el = ${sel(id)}
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function goto(hash, title, timeoutMs = 12000) {
  await evalJS(`location.hash = ${JSON.stringify(hash)}`)
  await waitH1(title, timeoutMs)
  await sleep(400)
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

/* ---------------- 工具直调（不阻塞 UI 的写工具） ---------------- */

async function ensureToolHook() {
  const okHook = await evalJS(`(async () => {
    await import('/src/ai/tools/registry.ts')
    return typeof window.__REIN_TOOL__ === 'function'
  })()`)
  if (!okHook) throw new Error('window.__REIN_TOOL__ 未挂载')
}

/** 启动一次工具调用，不等待 Promise（写工具会停在确认层）。 */
async function startTool(name, args) {
  await evalJS(`(() => {
    window.__E2E_TOOL_RESULT__ = { status: 'pending' }
    window.__REIN_TOOL__(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(
      (value) => { window.__E2E_TOOL_RESULT__ = { status: 'ok', value } },
      (error) => {
        window.__E2E_TOOL_RESULT__ = {
          status: 'error',
          code: error && error.code ? error.code : null,
          message: String((error && error.message) || error),
        }
      },
    )
    return true
  })()`)
}

async function waitToolResult(timeoutMs = 12000) {
  await waitFor(
    `window.__E2E_TOOL_RESULT__ && window.__E2E_TOOL_RESULT__.status !== 'pending'`,
    timeoutMs,
    '工具结果',
  )
  return evalJS(`window.__E2E_TOOL_RESULT__`)
}

/** 读工具：直接 await（不会弹确认）。 */
async function callTool(name, args) {
  return evalJS(`window.__REIN_TOOL__(${JSON.stringify(name)}, ${JSON.stringify(args)})`)
}

async function confirmBody() {
  return evalJS(
    `${sel('tool-confirm-sheet')}?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`,
  )
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
    await connect(`${APP}/#/settings/apps`)
    await waitId('connected-apps-page', 15000, '连接应用页挂载')
    await evalJS(`(async () => {
      localStorage.removeItem('rein.connectedApps.placeholder.v1')
      localStorage.removeItem('rein.connectedApps.v1')
      localStorage.removeItem('rein.connectedApps.ai.v1')
      const m = await import('/src/mock/connectedApps/index.ts')
      m.resetMockConnectedApps()
      const { useConnectedAppsStore } = await import('/src/stores/connectedApps.ts')
      await useConnectedAppsStore().refresh()
      return true
    })()`)
    await ensureToolHook()

    /* ================= 1. 页面行状态 ================= */
    await clickId('apps-tab-android')
    await waitId('apps-row-calendar', 8000, 'Android 日历行')
    const rows = await evalJS(`(() => {
      const ids = ['alarm', 'usage', 'calendar', 'contacts', 'filesystem', 'location', 'notification', 'sms']
      return {
        native: ids.filter((id) => document.querySelector('[data-testid="apps-row-' + id + '"]')).length,
        pills: ids.map((id) => {
          const el = document.querySelector('[data-testid="apps-toggle-' + id + '"]')
          return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null
        }),
      }
    })()`)
    ok(
      '1.1 Android 页签 8 个原生行，右侧是真实状态 pill（不是 + / ✓）',
      rows.native === 8 && rows.pills.every((p) => p && p !== '+' && p !== '✓'),
      `${rows.native} 行 / ${rows.pills.join(' · ')}`,
    )

    /* 「去授权」「不支持」是状态注册表的投影：直接改 store 状态，不伪造连接。 */
    await evalJS(`(async () => {
      const { useConnectedAppsStore } = await import('/src/stores/connectedApps.ts')
      const s = useConnectedAppsStore()
      s.statuses['alarm'] = { ...s.statuses['alarm'], enabled: true, connected: false, aiEnabled: false, writeAllowed: false, availability: 'partial', roots: [] }
      s.statuses['usage'] = { ...s.statuses['usage'], enabled: false, connected: false, aiEnabled: false, writeAllowed: false, availability: 'unsupported', supported: false, roots: [] }
      return true
    })()`)
    await waitFor(`${text('apps-toggle-alarm')} === '去授权'`, 5000, '去授权 pill')
    await waitFor(`${text('apps-toggle-usage')} === '不支持'`, 5000, '不支持 pill')
    const pills = await evalJS(`(() => ({
      alarm: document.querySelector('[data-testid="apps-toggle-alarm"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      usage: document.querySelector('[data-testid="apps-toggle-usage"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    }))()`)
    ok(
      '1.2 行状态：缺权限 → 去授权；平台不支持 → 不支持',
      pills.alarm === '去授权' && pills.usage === '不支持',
      JSON.stringify(pills),
    )
    await evalJS(`(async () => {
      const { useConnectedAppsStore } = await import('/src/stores/connectedApps.ts')
      await useConnectedAppsStore().refresh()
      return true
    })()`)

    /* ================= 2. 日历抽屉：连接 / AI / 写入 / 刷新 ================= */
    await clickId('connected-app-calendar')
    await waitId('connected-app-sheet', 8000, '日历抽屉')
    const before = await evalJS(`(() => {
      const sheet = document.querySelector('[data-testid="connected-app-sheet"]')
      return {
        status: document.querySelector('[data-testid="connected-app-status"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
        headings: [...(sheet?.querySelectorAll('h4') ?? [])].map((e) => e.textContent.trim()),
        read: !!document.querySelector('[data-testid="connected-app-permission-read_calendar"]'),
        write: !!document.querySelector('[data-testid="connected-app-permission-write_calendar"]'),
        aiDisabled: document.querySelector('[data-testid="connected-app-ai-toggle"]')?.disabled === true,
        writeLabel: document.querySelector('[data-testid="connected-app-write-toggle"]')?.getAttribute('aria-label') ?? null,
      }
    })()`)
    ok(
      '2.1 点行开抽屉：未连接；读取/写入权限分行；AI 开关禁用',
      before.status === '未连接' &&
        before.headings.includes('读取') &&
        before.headings.includes('写入') &&
        before.read &&
        before.write &&
        before.aiDisabled,
      JSON.stringify(before),
    )
    ok(
      '2.2 「允许写入」控件存在（日历文案「允许写入日程」）',
      before.writeLabel === '允许写入日程',
      String(before.writeLabel),
    )

    await clickId('connected-app-connect')
    await waitFor(`${text('connected-app-status')} === '已连接'`, 8000, '已连接')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-ai-toggle"]')?.disabled === false`,
      8000,
      '连接动作结束（AI 开关可用）',
    )
    const connected = await evalJS(`(() => ({
      aiDisabled: document.querySelector('[data-testid="connected-app-ai-toggle"]')?.disabled === true,
      writeDisabled: document.querySelector('[data-testid="connected-app-write-toggle"]')?.disabled === true,
    }))()`)
    ok(
      '2.3 连接后 AI / 写入开关都可用',
      !connected.aiDisabled && !connected.writeDisabled,
      JSON.stringify(connected),
    )

    await clickId('connected-app-ai-toggle')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-ai-toggle"]')?.getAttribute('aria-checked') === 'true'`,
      8000,
      'AI 开关打开',
    )
    const aiIds = await evalJS(`(async () => {
      const { useConnectedAppsStore } = await import('/src/stores/connectedApps.ts')
      return useConnectedAppsStore().aiEnabledAppIds()
    })()`)
    ok('2.4 允许 AI 使用 → aiEnabledAppIds() 含 calendar', aiIds.includes('calendar'), aiIds.join(','))

    await clickId('connected-app-write-toggle')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-write-toggle"]')?.getAttribute('aria-checked') === 'true'`,
      10000,
      '写入开关打开',
    )
    const writeState = await evalJS(`(async () => {
      const { useConnectedAppsStore } = await import('/src/stores/connectedApps.ts')
      const s = useConnectedAppsStore().statusFor('calendar')
      return { writeAllowed: s?.writeAllowed === true, writeHint: document.querySelector('[data-testid="connected-app-write-toggle"]')?.getAttribute('aria-checked') }
    })()`)
    ok('2.5 允许写入 → status.writeAllowed=true（有效值，不是只存意图）', writeState.writeAllowed, JSON.stringify(writeState))

    await waitFor(
      `document.querySelector('[data-testid="connected-app-reconnect"]')?.disabled === false`,
      5000,
      '写入动作结束（重新检测可用）',
    )
    await clickId('connected-app-reconnect')
    await waitFor(`${text('connected-app-status')} === '已连接'`, 8000, '重新检测后仍已连接')
    ok('2.6 「重新检测」不丢连接状态、不报错', !(await evalJS(has('connected-app-error'))))

    await clickId('connected-app-sheet-close')
    await waitFor(`!document.querySelector('[data-testid="connected-app-sheet"]')`, 8000, '抽屉关闭')
    const rowAfter = await evalJS(text('apps-toggle-calendar'))
    ok('2.7 行 pill 变「已连接 · AI」', rowAfter === '已连接 · AI', String(rowAfter))

    /* ================= 3. 日历工具：读 / 写确认 / 拒绝审计 ================= */
    const listBefore = await callTool('list_calendar_events', {
      from: '2026-11-01T00:00:00+08:00',
      to: '2026-11-30T23:59:59+08:00',
    })
    ok(
      '3.1 读工具 list_calendar_events 返回 mock 事件（meta.mock=true）',
      Array.isArray(listBefore?.events) && listBefore.events.length >= 1 && listBefore.meta?.mock === true,
      `${listBefore?.events?.length ?? 0} 条`,
    )
    ok(
      '3.1b 读工具不弹确认层',
      !(await evalJS(has('tool-confirm-sheet'))),
    )

    await startTool('create_calendar_event', {
      title: 'E2E 新增日程',
      start: '2026-11-12T09:00:00+08:00',
      end: '2026-11-12T10:00:00+08:00',
      description: '连接应用 e2e 写入',
    })
    await waitId('tool-confirm-sheet', 8000, '新建日程确认')
    const createBody = await confirmBody()
    await clickId('tool-confirm-allow')
    const createResult = await waitToolResult()
    ok(
      '3.2 写工具先弹确认；允许后 mock 成功并返回 eventId',
      createBody.includes('新建日程') &&
        createBody.includes('E2E 新增日程') &&
        createResult.status === 'ok' &&
        Boolean(createResult.value?.eventId),
      `确认含标题=${createBody.includes('E2E 新增日程')} / ${createResult.status}`,
    )
    const createdId = createResult.status === 'ok' ? String(createResult.value.eventId) : ''
    const listAfterCreate = await callTool('list_calendar_events', {
      from: '2026-11-01T00:00:00+08:00',
      to: '2026-11-30T23:59:59+08:00',
    })
    ok(
      '3.3 允许后列表能看到新事件',
      (listAfterCreate?.events ?? []).some((e) => e.title === 'E2E 新增日程'),
      `${listAfterCreate?.events?.length ?? 0} 条`,
    )

    const beforeDenyCount = (listAfterCreate?.events ?? []).length
    await startTool('delete_calendar_event', { eventId: createdId })
    await waitId('tool-confirm-sheet', 8000, '删除日程确认')
    const deleteBody = await confirmBody()
    await clickId('tool-confirm-deny')
    const denyResult = await waitToolResult()
    const listAfterDeny = await callTool('list_calendar_events', {
      from: '2026-11-01T00:00:00+08:00',
      to: '2026-11-30T23:59:59+08:00',
    })
    const audit = await evalJS(`window.__REIN_MOCK_APP_AUDIT__ || []`)
    ok(
      '3.4 拒绝 → connected_app_user_denied，不调用 native，列表不变',
      deleteBody.includes('删除日程') &&
        denyResult.status === 'error' &&
        denyResult.code === 'connected_app_user_denied' &&
        (listAfterDeny?.events ?? []).length === beforeDenyCount,
      `${denyResult.code} / ${beforeDenyCount}→${(listAfterDeny?.events ?? []).length}`,
    )
    ok(
      '3.5 拒绝写入 __audit（decision=denied）',
      Array.isArray(audit) &&
        audit.some(
          (a) =>
            a.app === 'calendar' &&
            a.method === 'delete_calendar_event' &&
            a.decision === 'denied',
        ),
      `${Array.isArray(audit) ? audit.length : 0} 条审计`,
    )

    /* ================= 4. 桌面文件：根 / 只读 / 写入读回 ================= */
    await clickId('apps-tab-windows')
    await waitId('apps-row-win-desktop', 8000, 'Windows 桌面行')
    await clickId('connected-app-win-desktop')
    await waitId('connected-app-sheet', 8000, '桌面抽屉')
    await clickId('connected-app-connect')
    await waitFor(`${text('connected-app-status')} === '已连接'`, 8000, '桌面已连接')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-ai-toggle"]')?.disabled === false`,
      8000,
      '桌面连接动作结束',
    )
    await clickId('connected-app-ai-toggle')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-ai-toggle"]')?.getAttribute('aria-checked') === 'true'`,
      8000,
      '桌面 AI 打开',
    )
    await clickId('connected-app-write-toggle')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-write-toggle"]')?.getAttribute('aria-checked') === 'true'`,
      10000,
      '桌面写入打开',
    )
    const rootsText = await evalJS(text('connected-app-roots'))
    ok(
      '4.1 文件根区显示根 label 与「可读写」',
      typeof rootsText === 'string' && rootsText.includes('桌面') && rootsText.includes('可读写'),
      String(rootsText),
    )

    // 只读根是 UI 投影：改 mock 的根对象后 refresh，确认抽屉如实显示「只读」。
    await evalJS(`(async () => {
      const { mockStatusFor } = await import('/src/mock/connectedApps/status.ts')
      mockStatusFor('win-desktop').roots[0].writable = false
      const { useConnectedAppsStore } = await import('/src/stores/connectedApps.ts')
      await useConnectedAppsStore().refresh()
      return true
    })()`)
    await waitFor(
      `(${text('connected-app-roots')} ?? '').includes('只读')`,
      5000,
      '只读根',
    )
    const readonlyText = await evalJS(text('connected-app-roots'))
    ok('4.2 不可写根显示「只读」', String(readonlyText).includes('只读'), String(readonlyText))
    await evalJS(`(async () => {
      const { mockStatusFor } = await import('/src/mock/connectedApps/status.ts')
      mockStatusFor('win-desktop').roots[0].writable = true
      const { useConnectedAppsStore } = await import('/src/stores/connectedApps.ts')
      await useConnectedAppsStore().refresh()
      return true
    })()`)

    await clickId('connected-app-sheet-close')
    await waitFor(`!document.querySelector('[data-testid="connected-app-sheet"]')`, 8000, '桌面抽屉关闭')

    const desktopRoots = await callTool('list_desktop_roots', {})
    ok(
      '4.3 list_desktop_roots 只给 id/label/writable，不泄漏绝对路径',
      Array.isArray(desktopRoots?.roots) &&
        desktopRoots.roots.some((r) => r.id === 'win-desktop:default') &&
        desktopRoots.roots.every((r) => !('path' in r)),
      JSON.stringify(desktopRoots?.roots ?? []),
    )

    await startTool('write_desktop_file', {
      root: 'win-desktop:default',
      path: 'e2e-note.txt',
      content: 'hello from connected apps e2e\n',
    })
    await waitId('tool-confirm-sheet', 8000, '写入文件确认')
    const writeBody = await confirmBody()
    await clickId('tool-confirm-allow')
    const writeResult = await waitToolResult()
    const readBack = await callTool('read_desktop_file', {
      root: 'win-desktop:default',
      path: 'e2e-note.txt',
    })
    ok(
      '4.4 写桌面文件：确认后成功，read_desktop_file 读回新内容',
      writeBody.includes('e2e-note.txt') &&
        writeBody.includes('不覆盖') &&
        writeResult.status === 'ok' &&
        readBack?.content?.includes('hello from connected apps e2e'),
      `${writeResult.status} / ${readBack?.content?.slice(0, 20) ?? ''}`,
    )

    /* ================= 5. 命令行：风险确认 + 每次执行确认 ================= */
    await clickId('apps-tab-windows')
    await waitId('apps-row-win-terminal', 8000, 'Windows 命令行行')
    await clickId('connected-app-win-terminal')
    await waitId('connected-app-sheet', 8000, '终端抽屉')
    const terminalRisk = await evalJS(`(() => ({
      risk: !!document.querySelector('[data-testid="connected-app-terminal-risk"]'),
      ack: !!document.querySelector('[data-testid="connected-app-terminal-ack"]'),
      connectDisabled: document.querySelector('[data-testid="connected-app-connect"]')?.disabled === true,
    }))()`)
    ok(
      '5.1 终端抽屉有风险说明；未勾选前不能连接',
      terminalRisk.risk && terminalRisk.ack && terminalRisk.connectDisabled,
      JSON.stringify(terminalRisk),
    )
    await clickId('connected-app-terminal-ack')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-connect"]')?.disabled === false`,
      3000,
      '勾选风险确认后可连接',
    )
    await clickId('connected-app-connect')
    await waitFor(`${text('connected-app-status')} === '已连接'`, 8000, '终端已连接')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-ai-toggle"]')?.disabled === false`,
      8000,
      '终端连接动作结束',
    )
    await clickId('connected-app-ai-toggle')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-ai-toggle"]')?.getAttribute('aria-checked') === 'true'`,
      8000,
      '终端 AI 打开',
    )
    await clickId('connected-app-write-toggle')
    await waitFor(
      `document.querySelector('[data-testid="connected-app-write-toggle"]')?.getAttribute('aria-checked') === 'true'`,
      10000,
      '终端执行许可打开',
    )
    await clickId('connected-app-sheet-close')
    await waitFor(`!document.querySelector('[data-testid="connected-app-sheet"]')`, 8000, '终端抽屉关闭')

    await startTool('run_terminal_command', { program: 'echo', args: ['hi'] })
    await waitId('tool-confirm-sheet', 8000, '命令确认')
    const terminalBody = await confirmBody()
    await clickId('tool-confirm-allow')
    const terminalResult = await waitToolResult()
    ok(
      '5.2 run_terminal_command 每次确认；允许后 mock 返回 simulated 输出（不冒充真机执行）',
      terminalBody.includes('程序：echo') &&
        terminalResult.status === 'ok' &&
        terminalResult.value?.stdout?.includes('hi') &&
        terminalResult.value?.simulated === true &&
        terminalResult.value?.meta?.mock === true,
      `${terminalResult.status} / simulated=${terminalResult.value?.simulated}`,
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
  if (passed !== results.length) {
    const failed = results.filter((r) => !r.pass).map((r) => r.name)
    console.log(`失败项：\n- ${failed.join('\n- ')}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('e2e 失败：', e?.message ?? e)
  const passed = results.filter((r) => r.pass).length
  console.log(`（已跑 ${results.length} 条，${passed} 通过）`)
  process.exit(1)
})
