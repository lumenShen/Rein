/**
 * 聊天虚拟列表端到端（浏览器 mock 模式，无头 Edge + 原生 CDP）。
 *
 * 运行：node scripts/e2e-chat-virtual-list.mjs
 * 前置：`npm run dev` 已在 1420；或用 REIN_E2E_URL 指向其它实例。
 *
 * 覆盖（对应 docs/CHAT-VIRTUAL-LIST.md）：
 *   1. 长会话（40 回合 / 81 条消息）只渲染视口段，DOM 段数远小于总回合数；
 *   2. 上滑加载更早一页后，首可见段的 rect.top 不跳（前插锚定）；滚动位置增加；
 *   3. 展开 reasoning 后段高被 ResizeObserver 写入 localStorage；滚走再滚回，展开状态与实测高度都保住；
 *   4. 流式输出期间旧段 DOM 元素不重建、旧正文不变，只有末段增长，DOM 段数有上界；
 *   5. 跳转锚点高亮：`?anchor=<id>&chat=<id>` 深链进入后 `#msg-<id>.flash` 且在视口内。
 *
 * 说明：本脚本只写不跑。当前 `stores/ai.ts::init()` 仍全量加载（见 docs §3.2），所以脚本先用
 * `paging.reset() + loadTail()` 把窗口切到 16 回合尾页，再走真实上滑/展开/流式路径；这等于手动补上
 * E 域尚未接入的那一步。真实 Rust 的分页 SQL 由 `cargo test --lib` 覆盖。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 9387 不在 Windows 的 9238-9337 排除段；可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9387)
/** 目标应用地址：默认 1420；并发会话时用 REIN_E2E_URL 指向独立实例 */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-virtual-${Date.now()}`
const CHAT_ID = 'e2e-virtual-chat'
const TOTAL_TURNS = 40

import { spawn } from 'node:child_process'

const results = []
let ws
let msgId = 0
const pending = new Map()

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    throw new Error(
      'eval 异常: ' +
        JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
    )
  }
  return r?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 同步布尔表达式等待（不要传 async IIFE：Boolean(Promise) 恒 true）。 */
async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return true
    } catch {
      /* 页面重载期间上下文会短暂销毁 */
    }
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 需要 awaitPromise 的表达式等待（可传 async IIFE）。 */
async function waitForValue(expr, timeoutMs = 10000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(expr)) return true
    } catch {
      /* 页面重载期间上下文会短暂销毁 */
    }
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

async function connect(url, seedSource) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  await sleep(300)
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
  if (seedSource) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: seedSource })
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch {
      /* 尚未就绪 */
    }
    await sleep(250)
  }
}

/* ---------- 种子数据 ---------- */

/** 一条 40 回合的 mock 会话；第 39 回合带 reasoning + tool，供展开/高度缓存用。 */
function buildSeedChat() {
  const base = Date.now() - 40 * 60_000
  let seq = 0
  const messages = []
  const push = (id, role, kind, text, payload = null, offsetMin = 0) => {
    messages.push({
      id,
      chatId: CHAT_ID,
      seq: ++seq,
      role,
      kind,
      text,
      imageBase64: null,
      mime: null,
      payload,
      createdAt: new Date(base + offsetMin * 60_000).toISOString(),
    })
  }

  for (let turn = 1; turn <= TOTAL_TURNS; turn++) {
    push(`u${turn}`, 'user', 'text', `第 ${turn} 轮：关于训练安排与恢复的提问。`, null, turn * 2)
    if (turn === 39) {
      const payload = JSON.stringify({
        thinking: '先核对这周的恢复情况，再给出建议。',
        thinkingSec: 3,
        segments: [
          {
            kind: 'reasoning',
            text: '用户最近训练频率较高，需要先看恢复指标。'.repeat(6),
          },
          {
            kind: 'tool',
            call: {
              callId: 'c39',
              toolName: '查看训练记录',
              rawName: 'list_workouts',
              arguments: '{"limit":5}',
              result: '已找到 5 条记录，平均恢复良好。',
              isError: false,
              pending: false,
            },
          },
        ],
      })
      push(`p${turn}`, 'assistant', 'tools', null, payload, turn * 2 + 0.2)
    }
    push(
      `a${turn}`,
      'assistant',
      'text',
      `第 ${turn} 轮回复：${'这是用于测量段高度的正文。'.repeat(1 + (turn % 3))}`,
      null,
      turn * 2 + 0.5,
    )
  }

  return {
    id: CHAT_ID,
    seq,
    title: '虚拟列表 E2E',
    createdAt: new Date(base).toISOString(),
    updatedAt: new Date(base + (TOTAL_TURNS * 2 + 2) * 60_000).toISOString(),
    messages,
  }
}

/* ---------- 页面状态读取 ---------- */

async function pagingState() {
  return evalJS(`(async () => {
    const { useChatPagingStore } = await import('/src/stores/chatPaging.ts')
    const p = useChatPagingStore()
    return {
      ready: p.ready,
      hasMoreBefore: p.hasMoreBefore,
      hasMoreAfter: p.hasMoreAfter,
      nextBeforeSeq: p.nextBeforeSeq,
      nextAfterSeq: p.nextAfterSeq,
      loadingBefore: p.loadingBefore,
      loadingAfter: p.loadingAfter,
      error: p.error,
    }
  })()`)
}

async function aiState() {
  return evalJS(`(async () => {
    const { useAiStore } = await import('/src/stores/ai.ts')
    const ai = useAiStore()
    return {
      chatId: ai.chatId,
      busy: ai.busy,
      count: ai.messages.length,
      first: ai.messages[0]?.id ?? null,
      last: ai.messages.at(-1)?.id ?? null,
      streamingBubbleId: ai.streamingBubbleId ?? null,
    }
  })()`)
}

/** 渲染中的段 id（DOM 顺序）。 */
function renderedSegIdsExpr() {
  return `[...document.querySelectorAll('.chat-segment')].map((el) => el.dataset.segId)`
}

/** 视口内第一个段（按 DOM 顺序）。 */
function firstVisibleSegExpr() {
  return `(() => {
    const sc = document.querySelector('.msgs')
    if (!sc) return null
    const sr = sc.getBoundingClientRect()
    const el = [...document.querySelectorAll('.chat-segment')].find((x) => {
      const r = x.getBoundingClientRect()
      return r.bottom > sr.top + 1 && r.top < sr.bottom - 1
    })
    if (!el) return null
    return { id: el.dataset.segId, top: el.getBoundingClientRect().top, scrollTop: sc.scrollTop }
  })()`
}

/** 将某条消息滚进已渲染窗口（用于找 p39）。 */
async function ensureMessageRendered(messageId) {
  for (let i = 0; i < 14; i++) {
    const found = await evalJS(`!!document.getElementById(${JSON.stringify(messageId)})`)
    if (found) return true
    await evalJS(`(() => {
      const sc = document.querySelector('.msgs')
      if (!sc) return false
      sc.scrollTop = Math.max(0, sc.scrollTop - 220)
      return true
    })()`)
    await sleep(120)
  }
  return false
}

/* ---------- 主流程 ---------- */

async function main() {
  // mock 模型 + 脚本化内核：流式期间要有中间态可观察
  const model = {
    id: 1,
    name: 'E2E 假模型',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-e2e',
    modelId: 'e2e-model',
    isDefault: true,
    vision: false,
    thinking: true,
    effort: null,
    imageMaxEdge: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const streamText = JSON.stringify({
    kind: 'chat',
    text: '流式回复：' + '这是后续内容，用于验证虚拟列表只更新最后一段。'.repeat(12),
  })
  const agentScript = [
    {
      thinking: '先核对这周的恢复情况，再给出建议。' + '恢复良好。'.repeat(10),
      chunkMs: 120,
    },
    { text: streamText, chunkMs: 120 },
  ]
  const seedSource = `
    localStorage.setItem('rein.mock.ai_models.v1', ${JSON.stringify(JSON.stringify([model]))});
    window.__REIN_MOCK_AGENT__ = { script: ${JSON.stringify(agentScript)} };
    window.__REIN_MOCK_AGENT_LOG__ = [];
  `

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  await sleep(1800)

  try {
    await connect(`${APP}/#/ai`, seedSource)
    await waitFor(
      `!!document.querySelector('.page-header button[aria-label="历史"]')`,
      15000,
      'AI 页挂载',
    )
    await sleep(600)

    // 写种子会话并重载，让 mock 的 aiChats 模块从 localStorage 重新读取
    const chat = buildSeedChat()
    await evalJS(`localStorage.setItem('rein.mock.ai_chats.v1', ${JSON.stringify(JSON.stringify([chat]))})`)
    await evalJS('(() => { setTimeout(() => location.reload(), 0); return true })()')
    await sleep(700)
    await waitFor(
      `!!document.querySelector('.page-header button[aria-label="历史"]')`,
      15000,
      '重载后 AI 页挂载',
    )
    await waitFor(`!!document.getElementById('msg-a40')`, 10000, '尾页最后一条消息上屏')
    await sleep(400)

    /* ============================================================
       1. 长会话只渲染视口段
       ============================================================ */
    const initial = await evalJS(`(() => {
      const ids = ${renderedSegIdsExpr()}
      return {
        segIds: ids,
        segCount: ids.length,
        msgCount: document.querySelectorAll('.msg').length,
        totalSegs: 0,
        scroller: !!document.querySelector('.msgs'),
        body: !!document.querySelector('.virtual-body'),
      }
    })()`)
    const initialAi = await aiState()
    ok(
      '1.1 首屏载入 16 回合尾页（33 条消息）',
      initialAi?.chatId === CHAT_ID && initialAi?.count === 33,
      `chat=${initialAi?.chatId} messages=${initialAi?.count}`,
    )
    ok(
      '1.2 DOM 只渲染视口段（远小于 40 段）',
      initial?.segCount > 0 && initial?.segCount < 20,
      `DOM 段=${initial?.segCount} / 总回合=${TOTAL_TURNS}`,
    )
    ok(
      '1.3 首屏在尾部（首渲染段不是 seg:u1）',
      initial?.segIds?.[0] !== 'seg:u1' && initial?.segIds?.at(-1) === 'seg:u40',
      `${initial?.segIds?.[0]} … ${initial?.segIds?.at(-1)}`,
    )
    ok(
      '1.4 虚拟体与滚动容器都在',
      initial?.scroller === true && initial?.body === true,
      '',
    )

    /* ============================================================
       2. 切到 16 回合尾页（补 E 域未接的分页窗口）
       ============================================================ */
    const tail = await evalJS(`(async () => {
      const { useChatPagingStore } = await import('/src/stores/chatPaging.ts')
      const p = useChatPagingStore()
      p.reset()
      await p.loadTail(${JSON.stringify(CHAT_ID)})
      return {
        hasMoreBefore: p.hasMoreBefore,
        hasMoreAfter: p.hasMoreAfter,
        nextBeforeSeq: p.nextBeforeSeq,
        ready: p.ready,
        error: p.error,
      }
    })()`)
    await waitFor(`!!document.getElementById('msg-a40')`, 8000, '尾页重载完成')
    await sleep(400)
    const tailDom = await evalJS(`(() => {
      const ids = ${renderedSegIdsExpr()}
      return { ids, count: ids.length, ai: null }
    })()`)
    const tailAi = await aiState()
    ok(
      '2.1 loadTail 后 hasMoreBefore=true、窗口为 16 回合',
      tail?.hasMoreBefore === true && tail?.ready === true,
      `hasMoreBefore=${tail?.hasMoreBefore} cursor=${tail?.nextBeforeSeq}`,
    )
    ok(
      '2.2 尾页只装 16 回合（store 消息数 33）',
      tailAi?.count === 33,
      `messages=${tailAi?.count}`,
    )
    ok(
      '2.3 尾页 DOM 段数有上界',
      tailDom?.count > 0 && tailDom?.count <= 12,
      `DOM 段=${tailDom?.count}`,
    )

    /* ============================================================
       3. 上滑加载：首可见段 rect.top 不跳
       ============================================================ */
    const before = await evalJS(`(async () => {
      const sc = document.querySelector('.msgs')
      const body = document.querySelector('.virtual-body')
      if (!sc || !body) return null
      // 把 scrollTop 放到虚拟体顶部附近（触发 maybeTriggerLoad 的 localTop ∈ (-40,200)）
      const offset = body.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
      sc.scrollTop = Math.max(0, offset + 10)
      // 等两帧：第一帧让 scroll 处理里的 syncScroll 跑完，第二帧让 Vue 把新窗口 patch 到
      // DOM；自动加载要等 syncScroll 之后的下一帧才判定，此时 IPC 还在飞，锚点仍是前插前的。
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const sr = sc.getBoundingClientRect()
      const el = [...document.querySelectorAll('.chat-segment')].find((x) => {
        const r = x.getBoundingClientRect()
        return r.bottom > sr.top + 1 && r.top < sr.bottom - 1
      })
      return el
        ? { id: el.dataset.segId, top: el.getBoundingClientRect().top, scrollTop: sc.scrollTop }
        : { fail: true, scrollTop: sc.scrollTop, segments: document.querySelectorAll('.chat-segment').length }
    })()`)
    if (!before || before.fail) {
      throw new Error(`上滑前找不到视口内的段（scrollTop=${before?.scrollTop ?? '?'}，DOM 段=${before?.segments ?? '?'}）`)
    }

    // 原生 scroll 事件 + rAF 会触发 loadOlder；若 1s 内没加载，用键盘哨兵兜底。
    // 断言看 store 消息数（虚拟列表只挂视口段，用某个段是否在 DOM 判断会误报）。
    await sleep(1000)
    let olderLoaded = ((await aiState())?.count ?? 0) > 33
    if (!olderLoaded) {
      await evalJS(`document.querySelector('.load-sentinel')?.click()`)
      await sleep(1000)
      olderLoaded = ((await aiState())?.count ?? 0) > 33
    }
    // 前插后的高度实测/补偿要跨几帧才收敛；测量前留一拍，避免读到中间态。
    await sleep(500)
    const after = await evalJS(`(() => {
      const el = document.querySelector('[data-seg-id="${before.id}"]')
      const sc = document.querySelector('.msgs')
      return el && sc
        ? { exists: true, top: el.getBoundingClientRect().top, scrollTop: sc.scrollTop }
        : { exists: false, scrollTop: sc?.scrollTop }
    })()`)
    const afterState = await pagingState()
    ok(
      '3.1 上滑触发加载更早一页（seg:u24 出现）',
      olderLoaded === true,
      `hasMoreBefore=${afterState?.hasMoreBefore}`,
    )
    ok(
      '3.2 前插后首可见段仍在 DOM 且 rect.top 不跳（±2px）',
      after?.exists === true && Math.abs(Number(after.top) - Number(before.top)) <= 2,
      `${Number(before.top).toFixed(1)} → ${Number(after?.top ?? NaN).toFixed(1)}`,
    )
    ok(
      '3.3 前插后 scrollTop 增加（内容插在上方，视口没被顶走）',
      Number(after?.scrollTop) > Number(before.scrollTop) + 50,
      `${Number(before.scrollTop).toFixed(0)} → ${Number(after?.scrollTop ?? NaN).toFixed(0)}`,
    )

    /* ============================================================
       4. 展开 reasoning：高度缓存 + 折叠回写
       ============================================================ */
    // 上滑测试停在顶部；先回到底部，p39（第 39 回合）才会进入渲染窗口
    await evalJS(`(() => { const sc = document.querySelector('.msgs'); sc.scrollTop = sc.scrollHeight; return true })()`)
    await sleep(600)
    const p39Ready = await ensureMessageRendered('msg-p39')
    if (!p39Ready) throw new Error('找不到 msg-p39（第 39 回合的过程消息）')
    const collapsed = await evalJS(`(() => {
      const msg = document.getElementById('msg-p39')
      const seg = msg?.closest('.chat-segment')
      const section = msg?.querySelector('.process-section')
      if (!seg || !section) return null
      return {
        segId: seg.dataset.segId,
        height: seg.getBoundingClientRect().height,
        collapsed: section.classList.contains('collapsed'),
      }
    })()`)
    if (!collapsed) throw new Error('msg-p39 没有可测量的段/过程区')

    const clicked = await evalJS(`(() => {
      const h = document.querySelector('#msg-p39 .process-header')
      if (!h) return false
      h.click()
      return true
    })()`)
    await waitFor(
      `(() => { const s = document.querySelector('#msg-p39 .process-section'); return !!s && !s.classList.contains('collapsed') })()`,
      4000,
      'reasoning 展开',
    )
    await sleep(700)
    const expanded = await evalJS(`(() => {
      const msg = document.getElementById('msg-p39')
      const seg = msg?.closest('.chat-segment')
      const body = msg?.querySelector('.process-body')
      if (!seg || !body) return null
      return {
        segId: seg.dataset.segId,
        height: seg.getBoundingClientRect().height,
        visible: getComputedStyle(body).display !== 'none',
      }
    })()`)
    const cached = await evalJS(`(async () => {
      const { loadHeights } = await import('/src/components/ai/chat/heightCache.ts')
      const map = loadHeights(${JSON.stringify(CHAT_ID)})
      return map.get(${JSON.stringify(expanded?.segId ?? '')}) ?? null
    })()`)

    ok(
      '4.1 展开后段变高且过程正文可见',
      clicked === true &&
        expanded?.visible === true &&
        Number(expanded?.height) > Number(collapsed.height) + 20,
      `${Number(collapsed.height).toFixed(1)} → ${Number(expanded?.height ?? NaN).toFixed(1)}`,
    )
    ok(
      '4.2 ResizeObserver 实测高度写入 localStorage 缓存',
      cached != null && Math.abs(Number(cached) - Number(expanded?.height)) <= 2,
      `cached=${cached} measured=${expanded?.height}`,
    )

    // 滚到顶：p39 应被回收；再滚到底：展开状态与高度都应从缓存/页面状态恢复
    await evalJS(`(() => { const sc = document.querySelector('.msgs'); sc.scrollTop = 0; return true })()`)
    await sleep(900)
    const gone = await evalJS(`!document.getElementById('msg-p39')`)
    await evalJS(`(() => { const sc = document.querySelector('.msgs'); sc.scrollTop = sc.scrollHeight; return true })()`)
    await sleep(900)
    const back = await evalJS(`(() => {
      const msg = document.getElementById('msg-p39')
      const seg = msg?.closest('.chat-segment')
      const section = msg?.querySelector('.process-section')
      if (!seg || !section) return null
      return {
        segId: seg.dataset.segId,
        height: seg.getBoundingClientRect().height,
        collapsed: section.classList.contains('collapsed'),
      }
    })()`)
    ok(
      '4.3 滚出视口后段被回收（DOM 里不存在）',
      gone === true,
      '',
    )
    ok(
      '4.4 滚回后展开状态保持、高度与展开实测一致（±3px）',
      back != null &&
        back.collapsed === false &&
        Math.abs(Number(back.height) - Number(expanded?.height)) <= 3,
      `${expanded?.height} → ${back?.height} collapsed=${back?.collapsed}`,
    )

    /* ============================================================
       5. 流式只更新末段
       ============================================================ */
    const pre = await evalJS(`(() => {
      const els = [...document.querySelectorAll('.chat-segment')]
      window.__preSegs = els.map((el) => el.dataset.segId)
      window.__preEls = new Map(els.map((el) => [el.dataset.segId, el]))
      window.__preLastText = document.getElementById('msg-a40')?.textContent ?? ''
      return { count: window.__preSegs.length, ids: [...window.__preSegs] }
    })()`)
    const preAi = await aiState()

    await evalJS(`(() => {
      const ta = document.querySelector('.inbar textarea')
      if (!ta) return false
      ta.value = '虚拟列表流式测试'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await evalJS(`document.querySelector('.inbar .send')?.click()`)
    await sleep(700)

    const during = await evalJS(`(() => {
      const els = [...document.querySelectorAll('.chat-segment')]
      const ids = els.map((el) => el.dataset.segId)
      const kept = window.__preSegs.filter((id) => ids.includes(id))
      const sameEls = kept.every(
        (id) => window.__preEls.get(id) === document.querySelector('.chat-segment[data-seg-id="' + id + '"]'),
      )
      return {
        ids,
        kept: kept.length,
        sameEls,
        oldText: document.getElementById('msg-a40')?.textContent ?? '',
        segCount: ids.length,
        msgCount: document.querySelectorAll('.msg').length,
        last: ids.at(-1) ?? null,
        streaming: !!document.querySelector('.process-dots') ||
          [...document.querySelectorAll('.msg.assistant')].some((el) => el.textContent.includes('流式回复')),
      }
    })()`)
    ok(
      '5.1 流式期间旧段 DOM 元素没有重建',
      during?.sameEls === true && Number(during?.kept) >= 2,
      `保留旧段=${during?.kept} same=${during?.sameEls}`,
    )
    const oldTextOk = await evalJS(`(() => {
      const el = document.getElementById('msg-a40')
      return el ? el.textContent === window.__preLastText : true
    })()`)
    ok(
      '5.2 流式期间旧正文不变（只有末段更新；旧段被回收也算通过）',
      oldTextOk === true,
      `msg-a40 文本长度 ${String(during?.oldText ?? '').length}`,
    )
    ok(
      '5.3 流式期间 DOM 段数仍有上界',
      Number(during?.segCount) <= Number(pre?.count) + 2 && Number(during?.segCount) < 20,
      `${pre?.count} → ${during?.segCount}`,
    )
    ok(
      '5.4 新回合的末段已经出现',
      during?.last != null && !(pre?.ids ?? []).includes(during.last),
      `${pre?.ids?.at(-1)} → ${during?.last}`,
    )

    await waitForValue(
      `(async () => {
        const { useAiStore } = await import('/src/stores/ai.ts')
        return useAiStore().busy === false
      })()`,
      20000,
      '流式回合结束',
    )
    await sleep(500)
    const final = await evalJS(`(async () => {
      const { useAiStore } = await import('/src/stores/ai.ts')
      const ai = useAiStore()
      const ids = ${renderedSegIdsExpr()}
      const lastMsg = ai.messages.at(-1)
      return {
        busy: ai.busy,
        count: ai.messages.length,
        lastRole: lastMsg?.role ?? null,
        lastText: lastMsg?.text ?? '',
        segCount: ids.length,
        assistant: document.querySelectorAll('.msg.assistant').length,
      }
    })()`)
    ok(
      '5.5 回合结束：新 assistant 正文落盘，DOM 段数仍小于 20',
      final?.busy === false &&
        Number(final?.count) >= Number(preAi?.count ?? 0) + 2 &&
        String(final?.lastText).includes('流式回复') &&
        Number(final?.segCount) < 20,
      `messages=${preAi?.count} → ${final?.count} DOM 段=${final?.segCount}`,
    )

    /* ============================================================
       6. around：从尾页跳到旧回合（store 级）
       ============================================================ */
    const around = await evalJS(`(async () => {
      const { useChatPagingStore } = await import('/src/stores/chatPaging.ts')
      const { useAiStore } = await import('/src/stores/ai.ts')
      const p = useChatPagingStore()
      const ai = useAiStore()
      // 先回到 16 回合尾页，让 a3 不在窗口里，jumpToAnchor 才会真的拉 around 页。
      p.reset()
      await p.loadTail(ai.chatId)
      const hadA3Before = ai.messages.some((m) => m.id === 'a3')
      const target = await p.jumpToAnchor('a3')
      return {
        target,
        hadA3Before,
        hasA3: ai.messages.some((m) => m.id === 'a3'),
        hasA40: ai.messages.some((m) => m.id === 'a40'),
        count: ai.messages.length,
        hasMoreAfter: p.hasMoreAfter,
        hasMoreBefore: p.hasMoreBefore,
      }
    })()`)
    ok(
      '6.1 jumpToAnchor 拉 around 页并包含旧消息 a3',
      around?.target === 'a3' && around?.hasA3 === true,
      `target=${around?.target} count=${around?.count}`,
    )
    ok(
      '6.2 around 页不再包含尾部 a40，且 hasMoreAfter=true',
      around?.hasA40 === false && around?.hasMoreAfter === true,
      `hasA40=${around?.hasA40} hasMoreAfter=${around?.hasMoreAfter}`,
    )

    /* ============================================================
       7. 深链跳转高亮
       ============================================================ */
    await evalJS(`(() => {
      location.hash = '#/ai?anchor=a3&chat=${CHAT_ID}'
      setTimeout(() => location.reload(), 0)
      return true
    })()`)
    await sleep(800)
    await waitFor(
      `!!document.querySelector('.page-header button[aria-label="历史"]')`,
      15000,
      '深链重载后 AI 页挂载',
    )
    let flashOk = true
    try {
      await waitFor(
        `(() => {
          const el = document.getElementById('msg-a3')
          if (!el || !el.classList.contains('flash')) return false
          const sc = document.querySelector('.msgs')
          const er = el.getBoundingClientRect()
          const sr = sc.getBoundingClientRect()
          return er.bottom > sr.top + 1 && er.top < sr.bottom - 1
        })()`,
        8000,
        'msg-a3 .flash 且在视口内',
      )
    } catch {
      flashOk = false
    }
    const jump = await evalJS(`(() => {
      const el = document.getElementById('msg-a3')
      const sc = document.querySelector('.msgs')
      if (!el || !sc) return { found: false, hash: location.hash }
      const er = el.getBoundingClientRect()
      const sr = sc.getBoundingClientRect()
      return {
        found: true,
        flash: el.classList.contains('flash'),
        inViewport: er.bottom > sr.top + 1 && er.top < sr.bottom - 1,
        hash: location.hash,
      }
    })()`)
    ok(
      '7.1 深链 ?anchor=a3 后 msg-a3 出现 .flash 且进入视口',
      flashOk === true && jump?.found === true && jump?.inViewport === true,
      JSON.stringify(jump),
    )
    await sleep(800)
    await waitFor(
      `!location.hash.includes('anchor=') && !location.hash.includes('chat=')`,
      3000,
      '清掉 anchor/chat 查询参数',
    )
    const cleaned = await evalJS(`location.hash`)
    ok(
      '7.2 跳转后清掉 anchor/chat 查询参数（避免刷新重复跳转）',
      !String(cleaned).includes('anchor=') && !String(cleaned).includes('chat='),
      String(cleaned),
    )
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
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('运行失败：', e)
  process.exit(1)
})
