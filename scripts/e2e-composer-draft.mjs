/**
 * e2e-composer-draft —— 全局输入条（2026-11-10 用户定稿）
 *
 * 三件事只有真渲染一遍才验证得了：
 *   1. 聚焦输入框 → 底栏页签行收起（任何一页都成立），失焦恢复；
 *   2. 草稿是**跨页唯一真源**：文字 / 附图 / 文档 / 引用切页都不丢，AI 页与底栏读写同一份；
 *   3. 占位是能力提示轮播：每句 8s，旧句上移、新句自下而上（.qk-ph 自绘层）。
 *
 * 剧本：
 *   0. 基线：底栏输入行在场，占位来自能力清单
 *   1. 聚焦（主页）→ html[data-dock-quick='input']、.dock.is-typing、页签行高度归零；失焦恢复
 *   2. 在主页打字 → 切「我」→ 文字仍在（底栏常驻、草稿在 store）
 *   3. 切 AI 页 → AI 输入条里是同一段文字；切回主页仍在
 *   4. AI 页选图 + 文字 → 切走再回来：附图芯片与文字都还在（AIPage 卸载过一轮）
 *   5. 在主页按发送（草稿带图）→ 跳 AI 页并自动发出：附件芯片清空、消息 +1
 *   6. 占位轮播：8s 后换下一句；.qk-ph 的当前句与 textarea 的 placeholder 属性同步
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-composer-draft.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-composer-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

// 1x1 红色 JPEG（最小合法图，与 e2e-food-ai 同一枚）
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
  'AAIRAxEAPwD3+iiigD//2Q=='
const MEAL_JPG = `${OUT}/meal.jpg`
writeFileSync(MEAL_JPG, Buffer.from(JPEG_B64, 'base64'))

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
  await cdp('DOM.enable')
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

/** 启动两秒后「有新版本」卡片会自己弹出来，带全屏遮罩 —— 不关掉后面全被挡住 */
async function dismissUpdate() {
  return evalJS(`(() => {
    const b = [...document.querySelectorAll('.up-actions .up-btn')].find((x) => x.textContent.includes('稍后'))
    if (!b) return false
    b.click()
    return true
  })()`)
}

/** 往底栏输入行里打字（原生设值 + input 事件，让 v-model 收到） */
const typeDock = (text) =>
  evalJS(`(() => {
    const i = document.querySelector('.dock .qk-input')
    if (!i) return false
    i.value = ${JSON.stringify(text)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/** 当前占位：textarea 的属性（读屏/脚本口）与自绘轮播层应当一致 */
const placeholderState = () =>
  evalJS(`(() => {
    const i = document.querySelector('.dock .qk-input')
    const ph = document.querySelector('.dock .qk-ph span')
    return {
      attr: i?.placeholder ?? null,
      visual: ph?.textContent?.trim() ?? null,
      overlay: !!document.querySelector('.dock .qk-ph'),
    }
  })()`)

const isTyping = () =>
  evalJS(`(() => {
    const dock = document.querySelector('.dock')
    const navs = document.querySelector('.dock .dock-navs')
    return {
      cls: !!dock?.classList.contains('is-typing'),
      state: document.documentElement.dataset.dockQuick ?? null,
      navH: navs ? Math.round(navs.getBoundingClientRect().height) : -1,
    }
  })()`)

/** 把焦点交给底栏输入行：程序化 focus 偶发被更新提示等浮层抢走，这里重试几次 */
async function focusDock() {
  for (let i = 0; i < 4; i++) {
    await evalJS(`document.querySelector('.dock .qk-input')?.focus()`)
    if (await evalJS(`document.activeElement === document.querySelector('.dock .qk-input')`)) return true
    await sleep(200)
  }
  return false
}

/** 给 AI 页的第一个隐藏文件框塞一张图（真 change 事件，走应用自己的压图链路） */
async function attachImage() {
  const { root } = await cdp('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file]',
  })
  if (!nodeId) throw new Error('找不到文件输入框')
  await cdp('DOM.setFileInputFiles', { files: [MEAL_JPG], nodeId })
}

const msgCount = () => evalJS(`document.querySelectorAll('.msgs .msg').length`)

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9700 + (process.pid % 200)

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
    await connect(`${APP}/#/`)
    await waitFor(`!!document.querySelector('.page')`, 8000, '应用挂载')
    await sleep(2600)
    await dismissUpdate()
    await sleep(300)

    /* ---- 0. 基线：输入行在，占位来自能力清单 ---- */
    const ph0 = await placeholderState()
    ok(
      '基线：底栏输入行 + 自绘轮播层在场，视觉句与 placeholder 属性一致',
      ph0.overlay && !!ph0.attr && ph0.attr === ph0.visual,
      JSON.stringify(ph0),
    )

    /* ---- 1. 聚焦 → 页签行收起；失焦 → 恢复 ---- */
    await dismissUpdate()
    await sleep(200)
    const focusedNow = await focusDock()
    await waitFor(`document.querySelector('.dock').classList.contains('is-typing')`, 3000, '聚焦后 is-typing')
    await sleep(400) // 等 250ms 收起补间跑完
    const focused = await isTyping()
    ok(
      '聚焦输入框：页签行收起（is-typing / data-dock-quick=input / 高度归零）',
      focusedNow && focused.cls && focused.state === 'input' && focused.navH <= 2,
      JSON.stringify({ focusedNow, ...focused }),
    )
    await shot('focus-typing')

    await evalJS(`document.querySelector('.dock .qk-input').blur()`)
    await waitFor(`!document.querySelector('.dock').classList.contains('is-typing')`, 3000, '失焦恢复')
    await sleep(200)
    const blurred = await isTyping()
    ok(
      '失焦：页签行恢复（is-typing 摘掉 / data-dock-quick=on / 高度回到 56）',
      !blurred.cls && blurred.state === 'on' && blurred.navH >= 40,
      JSON.stringify(blurred),
    )

    /* ---- 2. 文字跨页：主页 → 「我」 ---- */
    ok('主页输入行可输入', (await typeDock('周末的安排')) === true)
    await evalJS(`location.hash = '#/me'`)
    await waitFor(`!!document.querySelector('.page')`, 6000, '「我」页渲染')
    await sleep(500)
    const meVal = await evalJS(`document.querySelector('.dock .qk-input')?.value ?? ''`)
    ok('切到「我」：底栏里的文字还在（草稿跨页）', meVal === '周末的安排', JSON.stringify(meVal))

    /* ---- 3. 同一份草稿：主页 ↔ AI 页 ---- */
    await evalJS(`location.hash = '#/ai'`)
    await waitFor(`!!document.querySelector('.composer textarea')`, 8000, 'AI 输入条')
    await sleep(500)
    const aiVal = await evalJS(`document.querySelector('.composer textarea')?.value ?? ''`)
    ok('切到 AI 页：完整输入条里是同一段文字（底栏与 AI 页共用一个草稿）', aiVal === '周末的安排', JSON.stringify(aiVal))
    await evalJS(`location.hash = '#/'`)
    await waitFor(`!!document.querySelector('.dock .qk-input')`, 6000, '主页输入行')
    await sleep(500)
    ok('切回主页：文字仍在', (await evalJS(`document.querySelector('.dock .qk-input').value`)) === '周末的安排')

    /* ---- 4. 附图跨页：AI 页选图 → 切走 → 回来 ---- */
    await evalJS(`location.hash = '#/ai'`)
    await waitFor(`!!document.querySelector('.composer textarea')`, 8000, 'AI 输入条')
    await sleep(400)
    await attachImage()
    await waitFor(`document.querySelectorAll('.attach-chip').length === 1`, 8000, '附图芯片')
    await sleep(650) // 等占位从轮播句滚到上下文句（480ms spring + 收尾）
    const attachmentPh = await placeholderState()
    ok(
      '有附图时占位切成上下文句（轮播让位，视觉层同步）',
      attachmentPh.attr === '问问这张图，或直接记录饮食' &&
        attachmentPh.visual === '问问这张图，或直接记录饮食',
      JSON.stringify(attachmentPh),
    )
    const aiFocused = await focusDock()
    await waitFor(`document.querySelector('.dock').classList.contains('is-typing')`, 3000, 'AI 页聚焦 is-typing')
    await sleep(350)
    const aiTyping = await isTyping()
    ok(
      'AI 页聚焦也收起页签行（无论在哪个页面）',
      aiFocused && aiTyping.cls && aiTyping.state === 'input' && aiTyping.navH <= 2,
      JSON.stringify({ aiFocused, ...aiTyping }),
    )

    await evalJS(`location.hash = '#/me'`)
    await waitFor(`!!document.querySelector('.page')`, 6000, '「我」页渲染')
    await sleep(500)
    await evalJS(`location.hash = '#/ai'`)
    await waitFor(`document.querySelectorAll('.attach-chip').length === 1`, 8000, '回来后的附图芯片')
    const backVal = await evalJS(`document.querySelector('.composer textarea')?.value ?? ''`)
    ok(
      'AI 页选图后切走再回来：附图芯片与文字都还在（AIPage 卸载过一轮）',
      backVal === '周末的安排' && (await evalJS(`document.querySelectorAll('.attach-chip').length`)) === 1,
      JSON.stringify(backVal),
    )
    const msgsBefore = await msgCount()

    /* ---- 5. 跨页发送：底栏按发送，带图草稿在 AI 页自动发出 ---- */
    await evalJS(`location.hash = '#/me'`)
    await waitFor(`!!document.querySelector('.dock .qk-input')`, 6000, '「我」输入行')
    await sleep(500)
    const beforeSend = await evalJS(`(() => ({
      send: !!document.querySelector('.dock .qk-send'),
      disabled: document.querySelector('.dock .qk-send')?.disabled ?? true,
    }))()`)
    ok(
      '草稿带图时底栏发送钮可见且可点（sendable 由附件撑起）',
      beforeSend.send && beforeSend.disabled === false,
      JSON.stringify(beforeSend),
    )
    await evalJS(`document.querySelector('.dock .qk-send').click()`)
    await waitFor(`location.hash.startsWith('#/ai')`, 6000, '发送跳转 AI 页')
    await waitFor(`document.querySelectorAll('.attach-chip').length === 0`, 8000, '附件随消息清空')
    await sleep(900)
    ok(
      '底栏发送带图草稿：跳到 AI 页后自动组装发出（附件清空、消息数增加）',
      (await msgCount()) > msgsBefore,
      `before=${msgsBefore} after=${await msgCount()}`,
    )

    /* ---- 6. 占位轮播：8s 换句，视觉与属性同步 ---- */
    // 回主页重新挂载底栏输入条，从第一句开始计时
    await evalJS(`location.hash = '#/'`)
    await waitFor(`!!document.querySelector('.dock .qk-ph span')`, 6000, '主页占位轮播层')
    await sleep(500)
    const phBefore = await placeholderState()
    await sleep(8600)
    const phAfter = await placeholderState()
    ok(
      '占位每 8s 换一句（旧句上移、新句自下而上）',
      phBefore.attr !== phAfter.attr && phBefore.visual === phBefore.attr && phAfter.visual === phAfter.attr,
      `${JSON.stringify(phBefore)} → ${JSON.stringify(phAfter)}`,
    )

    await shot('placeholder-after-8s')
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
