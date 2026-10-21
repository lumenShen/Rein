/**
 * 全局沉浸浮窗验证工装 · 公共层（无头 Edge + 原生 CDP）。
 *
 * 两个剧本共用这一层：
 *  · scripts/e2e-global-float.mjs —— mock（浏览器）与真机（Tauri/WebView2）断言；
 *  · scripts/shot-global-float.mjs —— 浅色 / 暗色截图。
 *
 * 为什么要自己的 CDP 小客户端而不是 playwright：仓库既有 e2e（e2e-cdp / e2e-focus /
 * e2e-record）全是「spawn 无头 Edge → /json 找 target → WebSocket 调 Runtime.evaluate」，
 * 浮窗是**第二个 window/target**，需要同时连多个页面；这里把连接、求值、轮询、截图、
 * 错误收集抽出来，避免两个剧本各抄一份。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]

export function findBrowser() {
  const hit = EDGE_CANDIDATES.find((p) => existsSync(p))
  if (!hit) throw new Error('找不到 Edge/Chrome，无法运行 e2e')
  return hit
}

/** 取一个当前空闲端口：固定端口会被并行会话的浏览器 / dev server 占用。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/* ==========================================================================
 * CDP 客户端：一个 WebSocket = 一个 page target
 * ========================================================================== */

export class CdpPage {
  constructor(ws, label = 'page') {
    this.ws = ws
    this.label = label
    this.nextId = 0
    this.pending = new Map()
    this.eventHandlers = new Set()
    ws.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`CDP ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else p.resolve(msg.result)
        return
      }
      if (msg.method) for (const handler of this.eventHandlers) handler(msg)
    }
  }

  static async attach(webSocketDebuggerUrl, label = 'page') {
    const ws = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${label}`))
    })
    return new CdpPage(ws, label)
  }

  onEvent(handler) {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r?.exceptionDetails) {
      throw new Error(`eval 异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r?.result?.value
  }

  /** 轮询直到表达式为真（超时抛错，错误里带标签） */
  async waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await this.eval(`Boolean(${expr})`)) return true
      await sleep(150)
    }
    throw new Error(`等待超时: ${label}`)
  }

  /** 点含指定文本的按钮（默认最后一个命中 = 最上层弹层） */
  clickText(text, scope = 'body', last = true) {
    return this.eval(`(() => {
      const hits = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')]
        .filter((b) => b.textContent.includes(${JSON.stringify(text)}) && b.getBoundingClientRect().width > 0)
      const el = hits[${last ? 'hits.length - 1' : '0'}]
      if (!el) return false
      el.click()
      return true
    })()`)
  }

  clickSel(sel) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return false
      el.click()
      return true
    })()`)
  }

  async shot(path, { dark = null, clip = null } = {}) {
    if (dark !== null) {
      await this.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
      })
      await sleep(350)
    }
    const params = { format: 'png', captureBeyondViewport: false }
    if (clip) params.clip = { ...clip, scale: 1 }
    const r = await this.send('Page.captureScreenshot', params)
    if (!r?.data) throw new Error('Page.captureScreenshot 没有返回数据')
    mkdirSync(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))), { recursive: true })
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/* ==========================================================================
 * 浏览器 / target 管理
 * ========================================================================== */

/** 拉起无头 Edge，等调试端口就绪 */
export async function launchBrowser({ windowSize = '430,932', extraArgs = [] } = {}) {
  const executable = findBrowser()
  const port = await freePort()
  const profile = `${process.env.TEMP}/rein-float-e2e-${Date.now()}-${process.pid}`
  const proc = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      // 无头下 rAF / 定时器会被节流：Vue 过渡与计时器会停住
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      `--window-size=${windowSize}`,
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const started = Date.now()
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break
    } catch {
      /* 还没起 */
    }
    if (Date.now() - started > 40_000) {
      proc.kill()
      throw new Error('无头浏览器调试端口未就绪')
    }
    await sleep(200)
  }
  return { proc, port, profile, executable }
}

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return await res.json()
}

/** 开一个空白 page target 并连上（与 e2e-cdp 的做法一致：显式导航并等加载完成） */
export async function openPage(port, url, label = 'page') {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  await sleep(250)
  const page = await CdpPage.attach(target.webSocketDebuggerUrl, label)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.navigate', { url })
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    try {
      if ((await page.eval('document.readyState')) === 'complete') break
    } catch {
      /* 导航中上下文短暂失效 */
    }
    await sleep(200)
  }
  return { page, targetId: target.id }
}

/** 连上已经存在的 target（真机 WebView2 用：/json/list 里挑 page） */
export async function attachPage(target, label = 'page') {
  const page = await CdpPage.attach(target.webSocketDebuggerUrl, label)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  return page
}

/* ==========================================================================
 * 错误收集：未捕获异常 + console.error（favicon 404 不算）
 * ========================================================================== */

const ERROR_COLLECTOR_SOURCE = `(() => {
  window.__errs = []
  window.addEventListener('error', (e) => window.__errs.push(String(e.message)))
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)))
})()`

/** 在页面装载前注入收集器（之后 reload 生效） */
export async function injectErrorCollector(page) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_COLLECTOR_SOURCE })
}

/** 实时收集 Runtime 层的异常 / console.error；返回 { errors, dispose } */
export function watchErrors(page) {
  const errors = []
  const dispose = page.onEvent((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      errors.push('未捕获异常: ' + (d.exception?.description ?? d.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (!/favicon\.ico/i.test(text)) errors.push('console.error: ' + text)
    }
  })
  return { errors, dispose }
}

/** 页面自报的 window.__errs（注入式收集器） */
export async function pageErrors(page) {
  try {
    return (await page.eval('window.__errs ?? []')) ?? []
  } catch {
    return []
  }
}

/* ==========================================================================
 * mock（浏览器）用的浮窗 Tauri IPC 桩
 * ==========================================================================
 * 浏览器里 float.html 会渲染「等待会话」空态（isTauri=false）。要在这台机器上截出 /
 * 断言系统浮窗那一页的真实 DOM（bar / confirm / blob），就把最小可用的 Tauri IPC 桩
 * 在页面脚本之前注入：isTauri 在模块装载时判定，因此必须在 addScriptToEvaluateOnNewDocument
 * 里注册。桩只实现浮窗用到的三条命令：
 *   global_float_latest           → window.__LATEST
 *   plugin:event|listen           → 记下回调，测试里用 window.__fire(payload) 触发
 *   plugin:event|emit             → 记下浮窗发回主窗口的动作（断言按钮回灌）
 */
export const TAURI_STUB_SOURCE = `(() => {
  const callbacks = new Map()
  let seq = 0
  window.__CALLS = []
  window.__LATEST = ''
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) {
      const id = ++seq
      callbacks.set(id, cb)
      return id
    },
    invoke(cmd, args) {
      window.__CALLS.push({ cmd, args })
      if (cmd === 'global_float_latest') return Promise.resolve(window.__LATEST || '')
      if (cmd === 'plugin:event|listen') {
        window.__LISTEN = { event: args.event, id: args.handler }
        return Promise.resolve(1)
      }
      return Promise.resolve(null)
    },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  window.__fire = (payload) => {
    const listen = window.__LISTEN
    const cb = listen ? callbacks.get(listen.id) : null
    if (cb) cb({ event: listen.event, id: 1, payload })
  }
  window.__emitted = () => window.__CALLS.filter((c) => c.cmd === 'plugin:event|emit').map((c) => c.args)
})()`

/** 浮窗载荷（与 src/types/float.ts 的 GlobalFloatStatePayload 同形） */
export function focusPayload(overrides = {}) {
  const snapshot = {
    kind: 'focus',
    tone: 'work',
    title: '专注中',
    stat: '25:00',
    clock: { direction: 'down', baseSec: 1500, atEpochMs: Date.now() },
    primary: { id: 'pause', label: '暂停' },
    end: {
      label: '结束',
      sheet: {
        title: '现在结束会记录这一轮的专注时长并进入休息；放弃则这一轮不留记录',
        actions: [
          { id: 'end', label: '结束并保留记录' },
          { id: 'reset', label: '放弃这一轮（不保存）', danger: true },
        ],
      },
    },
    route: 'focus',
    canImmersive: true,
    ...(overrides.snapshot ?? {}),
  }
  return { snapshot, form: overrides.form ?? 'bar', perf: overrides.perf ?? 'high', motion: overrides.motion ?? 'default' }
}

/** 训练（跑步）载荷：blob 截图与两行版内容用 */
export function workoutPayload(overrides = {}) {
  const snapshot = {
    kind: 'workout',
    tone: 'work',
    title: '户外跑',
    stat: "00:42 · 5'30\"/km · 0.21 km",
    clock: null,
    blob: '00:42',
    primary: { id: 'pause', label: '暂停' },
    end: {
      label: '结束',
      sheet: {
        title: '现在结束会进入总结页，核对距离与时长后再保存；放弃则这次跑步不会留下记录',
        actions: [
          { id: 'finish', label: '结束并保存' },
          { id: 'discard', label: '放弃本次跑步（不保存）', danger: true },
        ],
      },
    },
    route: '/session/run',
    canImmersive: true,
    ...(overrides.snapshot ?? {}),
  }
  return { snapshot, form: overrides.form ?? 'bar', perf: overrides.perf ?? 'high', motion: overrides.motion ?? 'default' }
}
