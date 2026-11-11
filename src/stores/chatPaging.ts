/**
 * chatPaging —— 会话分页状态机（尾页 / 向上加载 / 向下加载 / around 跳转）。
 *
 * 约定（与方案 §9.3 一致）：
 * - `messages` 仍是**单一真源（已加载后缀）**，虚拟列表只窗口化渲染，不裁剪 store。
 * - 游标是 seq 数值边界，不要求对应消息仍存在（撤回留下空洞，ai_chat_seq 保证不复用）。
 * - `generation` 令牌丢弃晚到的响应：快速切会话不会串消息。
 * - `loadOlder` / `loadNewer` 在 `ai.busy` 时拒绝（流式期间禁止重建消息）。
 *
 * 与 E 域（stores/ai.ts）的接口通过可选方法适配：E 提供 `mapStored` /
 * `replaceMessages` / `prependMessages` / `appendMessages`；未合并时退化为
 * 本文件内的最小映射与直接赋值（旧 `ai.init()` 全量加载仍可正常显示）。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { aiService, type AiChatPage } from '@/services/aiService'
import { useAiStore } from '@/stores/ai'
import type {
  AiChatMessage,
  AiDocMeta,
  AiMessage,
  KbEntry,
  ProcessSegment,
  ProcessToolCall,
  ToolCallRecord,
} from '@/types'

/** 一页 16 个完整回合：覆盖 sendText 的 16 条历史、24 条抽取、6 张食物卡、3 条纪要 */
export const PAGE_TURNS = 16

/** E 域在 stores/ai.ts 暴露的分页接口（未合并时全部可缺省） */
interface PagingAiStore {
  messages: AiMessage[]
  busy: boolean
  chatId: string
  init(): Promise<void>
  mapStored?: (rows: AiChatMessage[]) => AiMessage[]
  replaceMessages?: (next: AiMessage[]) => void
  prependMessages?: (older: AiMessage[]) => void
  appendMessages?: (next: AiMessage[]) => void
}

function pagingAi(): PagingAiStore {
  return useAiStore() as unknown as PagingAiStore
}

/* ---------- 未合并 E 域时的最小 fromStored ---------- */

function legacyCallToProcess(t: ToolCallRecord, i: number, msgId: string): ProcessToolCall {
  return {
    callId: t.zoomId ?? `tc-${msgId}-${i}`,
    toolName: t.label || t.name,
    rawName: t.name,
    arguments: t.argsBrief,
    result: t.resultBrief,
    isError: t.status === 'error',
    pending: false,
    ...(t.resultImage ? { resultImage: t.resultImage } : {}),
    ...(t.zoomId
      ? { zoomId: t.zoomId, zoomW: t.zoomW, zoomH: t.zoomH, ...(t.zoomRect ? { zoomRect: t.zoomRect } : {}) }
      : {}),
  }
}

function fallbackFromStored(s: AiChatMessage): AiMessage {
  // 分页字段：Rust 的 ai_chat_page 已返回 seq 与 anchor_id，直接带上，
  // 段构建/跳转的落点才与后端一致。
  const m: AiMessage = {
    id: s.id,
    role: s.role,
    kind: s.kind,
    at: s.createdAt,
    seq: s.seq,
    anchorId: s.anchorId ?? undefined,
  }
  if (s.text) m.text = s.text
  if (s.imageBase64) {
    m.imageBase64 = s.imageBase64
    m.mime = s.mime ?? 'image/jpeg'
  }
  if (s.payload) {
    try {
      const p = JSON.parse(s.payload) as {
        items?: AiMessage['items']
        source?: AiMessage['source']
        committedAt?: string | null
        mealType?: AiMessage['mealType']
        proposal?: AiMessage['proposal']
        thinking?: string
        thinkingSec?: number
        segments?: ProcessSegment[]
        quote?: string
        calls?: ToolCallRecord[]
        doc?: AiDocMeta
        images?: AiMessage['images']
        imgNote?: string
        voice?: AiMessage['voiceMeta']
        files?: KbEntry[]
      }
      if (s.kind === 'food-parse') {
        m.items = p.items
        m.source = p.source
        if (p.committedAt) m.committed = true
        if (p.mealType) m.mealType = p.mealType
        if (p.proposal) m.proposal = p.proposal
        if (p.thinking) m.thinking = p.thinking
      } else if (p.thinking) {
        m.thinking = p.thinking
      }
      if (s.kind === 'tools' && p.calls) m.toolCalls = p.calls
      if (p.segments?.length) m.segments = p.segments
      if (typeof p.thinkingSec === 'number') m.thinkingSec = p.thinkingSec
      if (p.quote) m.quoteText = p.quote
      if (p.doc) m.doc = p.doc
      if (p.images) m.images = p.images
      if (p.imgNote) m.imgNote = p.imgNote
      if (p.voice) m.voiceMeta = p.voice
      if (p.files?.length) m.files = p.files
    } catch {
      /* 损坏的 payload 忽略；文本仍可读 */
    }
  }
  if (!m.segments?.length) {
    const segs: ProcessSegment[] = []
    if (m.thinking) segs.push({ kind: 'reasoning', text: m.thinking })
    for (const [i, t] of (m.toolCalls ?? []).entries()) segs.push({ kind: 'tool', call: legacyCallToProcess(t, i, m.id) })
    if (segs.length > 0) m.segments = segs
  }
  return m
}

export const useChatPagingStore = defineStore('chatPaging', () => {
  const ready = ref(false)
  /** 是否已经走过一次 init：初始挂载前不渲染看板，避免「骨架 → 看板」闪一下 */
  const started = ref(false)
  const error = ref<string | null>(null)
  const hasMoreBefore = ref(false)
  const hasMoreAfter = ref(false)
  const loadingBefore = ref(false)
  const loadingAfter = ref(false)
  const loadingTail = ref(false)
  const nextBeforeSeq = ref<number | null>(null)
  const nextAfterSeq = ref<number | null>(null)

  let generation = 0
  let tailPromise: Promise<void> | null = null
  let ensurePromise: Promise<void> | null = null
  /** 每个方向独立的操作 token：晚到的 finally 不能清掉新操作的 loading 标志 */
  let tailToken = 0
  let olderOp = 0
  let newerOp = 0
  /** 最近一次 loadTail/jump 针对的会话（与 ai.chatId 不同说明需要重载） */
  let requestedChatId: string | null = null

  function mapRows(rows: AiChatMessage[]): AiMessage[] {
    const s = pagingAi()
    return s.mapStored ? s.mapStored(rows) : rows.map(fallbackFromStored)
  }

  function replaceMessages(next: AiMessage[]): void {
    const s = pagingAi()
    if (s.replaceMessages) s.replaceMessages(next)
    else s.messages = next
  }

  function prependMessages(older: AiMessage[]): void {
    const s = pagingAi()
    // 按 id 去重：分页边界可能重叠（撤回留洞、并发写入），重复前插会让同一条
    // 消息渲染两次并进入模型 history。
    const seen = new Set(s.messages.map((m) => m.id))
    const fresh = older.filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
    if (fresh.length === 0) return
    if (s.prependMessages) s.prependMessages(fresh)
    else s.messages = [...fresh, ...s.messages]
  }

  function appendMessages(next: AiMessage[]): void {
    const s = pagingAi()
    // 按 id 去重；同一条消息已在 store 里时补齐后端才有的 seq/anchorId
    // （本地发送的消息没有这两个字段），但不重复入列。
    const byId = new Map(s.messages.map((m) => [m.id, m] as const))
    const fresh: AiMessage[] = []
    for (const m of next) {
      const old = byId.get(m.id)
      if (old) {
        if (old.seq == null && m.seq != null) old.seq = m.seq
        if (!old.anchorId && m.anchorId) old.anchorId = m.anchorId
        continue
      }
      byId.set(m.id, m)
      fresh.push(m)
    }
    if (fresh.length === 0) return
    if (s.appendMessages) s.appendMessages(fresh)
    else s.messages = [...s.messages, ...fresh]
  }

  /**
   * 分页游标只推进「本次翻页方向」的边界。
   *
   * 后端页面上的 `has_more_before/after` 描述的是 **DB 相对本页边界** 是否还有消息，
   * 而 store 保存的是「已加载窗口」。向前翻页时页面必然有 `has_more_after=true`
   * （请求边界之后就是 store 已加载的那段），无条件写回会把 after 游标打回已加载
   * 区间，下一次 loadNewer 就会把整页重新 append；反向同理。
   */
  function applyBeforeCursors(page: AiChatPage): void {
    hasMoreBefore.value = !!page.hasMoreBefore
    nextBeforeSeq.value = page.nextBeforeSeq ?? null
  }

  function applyAfterCursors(page: AiChatPage): void {
    hasMoreAfter.value = !!page.hasMoreAfter
    nextAfterSeq.value = page.nextAfterSeq ?? null
  }

  /** 整页替换（尾页 / around）：两个边界都按本页重置。 */
  function applyCursors(page: AiChatPage): void {
    applyBeforeCursors(page)
    applyAfterCursors(page)
  }

  function fail(e: unknown): void {
    error.value = e instanceof Error ? e.message : String(e)
  }

  /** 载入最新一页（切会话 / 初始化）。同一会话的并发调用共享同一个 promise。 */
  async function loadTail(chatId: string): Promise<void> {
    if (!chatId) return
    started.value = true
    if (tailPromise && requestedChatId === chatId) return tailPromise
    const gen = ++generation
    const token = ++tailToken
    requestedChatId = chatId
    loadingTail.value = true
    error.value = null
    const p = (async () => {
      try {
        const page = await aiService.aiChatPage(chatId, null, null, PAGE_TURNS)
        if (gen !== generation || pagingAi().chatId !== chatId) return
        replaceMessages(mapRows(page.messages))
        applyCursors(page)
        ready.value = true
      } catch (e) {
        if (gen !== generation) return
        fail(e)
        // 失败时不要清掉可能已经存在的全量消息（旧 init 路径），只把空会话标为就绪
        if (pagingAi().messages.length === 0) replaceMessages([])
        ready.value = true
      } finally {
        if (token === tailToken) loadingTail.value = false
      }
    })()
    tailPromise = p
    try {
      await p
    } finally {
      if (tailPromise === p) tailPromise = null
    }
  }

  /** 向上加载更早一页。返回是否真的插入了消息。 */
  async function loadOlder(): Promise<boolean> {
    const s = pagingAi()
    if (!s.chatId || s.busy || loadingBefore.value) return false
    if (requestedChatId !== s.chatId) {
      // 当前窗口不属于这个会话（例如旧路径 selectChat 刚切过来）：先对齐尾页
      await loadTail(s.chatId)
      return false
    }
    if (!hasMoreBefore.value) return false
    const gen = generation
    const token = ++olderOp
    const before = nextBeforeSeq.value
    const chat = s.chatId
    loadingBefore.value = true
    try {
      const page = await aiService.aiChatPage(chat, before, null, PAGE_TURNS)
      if (gen !== generation || s.chatId !== chat || requestedChatId !== chat) return false
      const rows = mapRows(page.messages)
      if (rows.length === 0) {
        hasMoreBefore.value = false
        return false
      }
      prependMessages(rows)
      applyBeforeCursors(page)
      return true
    } catch (e) {
      fail(e)
      return false
    } finally {
      if (token === olderOp) loadingBefore.value = false
    }
  }

  /** 向下加载更新的一页（around 跳转后用户继续往下读）。 */
  async function loadNewer(): Promise<boolean> {
    const s = pagingAi()
    if (!s.chatId || s.busy || loadingAfter.value) return false
    if (requestedChatId !== s.chatId) return false
    if (!hasMoreAfter.value) return false
    const gen = generation
    const token = ++newerOp
    const after = nextAfterSeq.value
    const chat = s.chatId
    loadingAfter.value = true
    try {
      const page = await aiService.aiChatPage(chat, null, after, PAGE_TURNS)
      if (gen !== generation || s.chatId !== chat || requestedChatId !== chat) return false
      const rows = mapRows(page.messages)
      if (rows.length === 0) {
        hasMoreAfter.value = false
        return false
      }
      appendMessages(rows)
      applyAfterCursors(page)
      return true
    } catch (e) {
      fail(e)
      return false
    } finally {
      if (token === newerOp) loadingAfter.value = false
    }
  }

  /**
   * 跳转到某条消息：已在当前窗口则直接返回；否则拉 around 页并替换消息。
   * busy 时拒绝（replaceMessages 会 reset 流式状态）。
   */
  async function jumpToAnchor(messageId: string): Promise<string | null> {
    if (!messageId) return null
    const s = pagingAi()
    if (s.messages.some((m) => m.id === messageId)) return messageId
    if (s.busy || !s.chatId) return null
    const chat = s.chatId
    const gen = ++generation
    requestedChatId = chat
    error.value = null
    try {
      const page = await aiService.aiChatPageAround(chat, messageId, PAGE_TURNS)
      if (gen !== generation || s.chatId !== chat) return null
      replaceMessages(mapRows(page.messages))
      applyCursors(page)
      ready.value = true
      return messageId
    } catch (e) {
      fail(e)
      return null
    }
  }

  /** 初始化：建/取会话 → 若旧 init 已经全量加载过就沿用，否则拉尾页。 */
  async function init(): Promise<void> {
    started.value = true
    loadingTail.value = true
    try {
      const s = pagingAi()
      await s.init()
      if (ready.value) return
      if (s.messages.length > 0) {
        // 兼容尚未合并 E 域时的 `ai.init()` 全量加载；不重复请求、不清空已有消息
        ready.value = true
        requestedChatId = s.chatId
        return
      }
      await loadTail(s.chatId)
    } finally {
      loadingTail.value = false
    }
  }

  /** sendText 前调用：保证当前会话至少有一页可作上下文。 */
  function ensureReady(): Promise<void> {
    if (ready.value) return Promise.resolve()
    if (ensurePromise) return ensurePromise
    ensurePromise = (async () => {
      started.value = true
      loadingTail.value = true
      try {
        const s = pagingAi()
        await s.init()
        if (ready.value) return
        if (s.messages.length > 0) {
          ready.value = true
          requestedChatId = s.chatId
          return
        }
        await loadTail(s.chatId)
      } finally {
        loadingTail.value = false
      }
    })().finally(() => {
      ensurePromise = null
    })
    return ensurePromise
  }

  /**
   * 发送前把窗口对齐到会话尾部。
   *
   * 用户可能刚「查看原文」跳到旧 anchor（`jumpToAnchor` 用 around 页整体替换了 store）。
   * 此时 store 不含最近消息：直接发送会让模型 history 只剩一页旧上下文，之后
   * `loadNewer` 还会把中间页 append 到新消息之后，数组不再按 seq 有序。
   * 发送语义永远是「接着最近一轮说」，所以先把窗口拉回尾页。
   */
  async function alignToTail(): Promise<void> {
    const s = pagingAi()
    if (!s.chatId) return
    if (!ready.value) {
      await ensureReady()
      return
    }
    if (requestedChatId !== s.chatId) {
      await loadTail(s.chatId)
      return
    }
    if (!hasMoreAfter.value) return
    await loadTail(s.chatId)
  }

  /**
   * 会话 id 变化后对齐分页窗口。E 域的 selectChat 会自己调 loadTail；
   * 这里只兜住「未合并时旧 selectChat 直接全量加载」的路径，避免游标停留在旧会话。
   */
  async function syncChat(): Promise<void> {
    const s = pagingAi()
    if (!s.chatId || s.busy) return
    if (requestedChatId === s.chatId) return
    await loadTail(s.chatId)
  }

  /** 新对话 / 清空 / 切换会话前清状态（E 域负责在对应动作里调用）。 */
  function reset(): void {
    generation++
    ready.value = false
    error.value = null
    hasMoreBefore.value = false
    hasMoreAfter.value = false
    loadingBefore.value = false
    loadingAfter.value = false
    loadingTail.value = false
    nextBeforeSeq.value = null
    nextAfterSeq.value = null
    tailPromise = null
    ensurePromise = null
    requestedChatId = null
  }

  return {
    ready,
    started,
    error,
    hasMoreBefore,
    hasMoreAfter,
    loadingBefore,
    loadingAfter,
    loadingTail,
    nextBeforeSeq,
    nextAfterSeq,
    PAGE_TURNS,
    init,
    ensureReady,
    alignToTail,
    syncChat,
    loadTail,
    loadOlder,
    loadNewer,
    jumpToAnchor,
    reset,
  }
})
