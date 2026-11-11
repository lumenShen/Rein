/** AI 域：对话消息流（Rust SQLite 持久化）+ 解析确认写入饮食。 */

import { nextTick, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { animate } from 'animejs'

import { aiService } from '@/services/aiService'
import { dietService } from '@/services/dietService'
import { kbService } from '@/services/kbService'
import { useMemoryStore } from '@/stores/memory'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { useModelsStore } from '@/stores/models'
import { hasImage, getEntry, registerImage, registerSourceImage, resetChat, setActiveChat, setViewEdgeCap } from '@/ai/imageZoom'
import { chatStreamView } from '@/ai/streamExtract'
import { createStreamAggregator } from '@/ai/streamBubbles'
import { toParsedItems, type ModelFoodRow } from '@/ai/foodMatch'
import { buildCardStateBlock, MAX_MEMOS } from '@/ai/cardState'
import { listCardOutcomes, recordCardOutcome } from '@/ai/cardOutcomes'
import { findAppTool, resolveToolPlan } from '@/ai/tools/registry'
import type { ToolGroup } from '@/ai/tools/types'
import { dedupeFiles, fileAttachmentOf, MAX_CHAT_FILES } from '@/ai/chatFiles'
import { useFeaturesStore } from '@/stores/features'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import type { ChatTurn } from '@/ai/chat'
import { DEFAULT_IMAGE_EDGE } from '@/utils/image'
import { todayStr } from '@/utils/date'
import { voiceService } from '@/services/voiceService'
import type {
  AiChat,
  AiChatMessage,
  AiChatMessageInput,
  AiDocMeta,
  AiMessage,
  KbEntry,
  MealType,
  ParsedFoodItem,
  ProcessSegment,
  ProcessToolCall,
  TargetAdjustProposal,
  ToolCallRecord,
  VoiceMemo,
} from '@/types'
import type { MemoGenResult } from '@/ai/memoGen'
import { useToast } from '@/composables/useToast'
import { motionOn } from '@/system/motion'
import { perfDegraded } from '@/system/perf'

let seq = 0
const uid = () => `m${Date.now().toString(36)}${++seq}`
const newChatId = () => `c${Date.now().toString(36)}${++seq}`

/** 待发送图片：base64 视图（发模型）+ 原始来源（放大镜按需解码取细节） */
export interface SendImage {
  base64: string
  mime: string
  /** 视图尺寸（= 发给模型的图的实际尺寸，坐标空间） */
  w: number
  h: number
  /** 图片清单说明：'附图' / '文档《x》第3页' */
  label: string
  /** 原始来源（File/Blob 或 dataURL），供放大镜解码高分辨率位图 */
  source: Blob | string
}

/** 归档路径与发送时写入的一致（files::normalize_path 会补 .md 后缀） */
function docArchivePath(name: string): string {
  return `文档/${name.replace(/\.[a-z0-9]+$/i, '')}.md`
}

/** 用户轮发给模型的文本：文档全文块 + 用户输入 + 图片清单 */
function composeOutgoingText(clean: string, doc: AiDocMeta | undefined, imgNote: string | undefined): string {
  const parts: string[] = []
  if (doc) {
    // 截断时告知全文归档位置：模型在用户追问「继续看后面」时才能自己定位并分页取全文
    const archiveNote =
      doc.truncated && doc.fullText?.trim()
        ? `\n（全文已归档到知识库「${docArchivePath(doc.name)}」，需要未展示的部分时用 glob_knowledge 查「文档/**」拿 id，再 read_knowledge level=l2 分页读取）`
        : ''
    parts.push(`（附带文档《${doc.name}》，已解析全文如下）${archiveNote}\n${doc.text}`)
  }
  if (clean) parts.push(clean)
  if (imgNote) parts.push(imgNote)
  return parts.join('\n\n')
}

/** 把消息里的图片（含放大镜结果图）注册进放大镜注册表（幂等）。
 * 放大条目优先共享根图条目的位图解码器并按 zoomRect 恢复「裁原图」语义；
 * 旧数据（无 zoomRect）或根图缺失时退化为对结果图本身继续放大。 */
function registerMessageImages(chatId: string, m: AiMessage): void {
  for (const [k, im] of (m.images ?? []).entries()) {
    const id = `img-${m.id}-${k}`
    if (hasImage(chatId, id)) continue
    registerSourceImage(chatId, {
      id,
      label: im.label,
      source: `data:${im.mime};base64,${im.base64}`,
      viewW: im.w,
      viewH: im.h,
    })
  }
  if (m.kind === 'tools' || m.segments?.length) {
    for (const seg of m.segments ?? []) {
      if (seg.kind !== 'tool') continue
      const c = seg.call
      if (!c.resultImage || !c.zoomId || hasImage(chatId, c.zoomId)) continue
      const depth = Number(c.zoomId.match(/z(\d+)(?:-\d+)?$/)?.[1] ?? 0)
      const rootId = c.zoomId.replace(/z\d+(?:-\d+)?$/, '')
      const root = depth > 0 ? getEntry(chatId, rootId) : null
      if (root && c.zoomRect) {
        registerImage(chatId, {
          id: c.zoomId,
          label: c.toolName,
          depth,
          viewW: c.zoomW ?? 0,
          viewH: c.zoomH ?? 0,
          resolve: root.resolve,
          rect: c.zoomRect,
        })
      } else {
        registerSourceImage(chatId, {
          id: c.zoomId,
          label: c.toolName,
          source: `data:${c.resultImage.mime};base64,${c.resultImage.base64}`,
          viewW: c.zoomW ?? 0,
          viewH: c.zoomH ?? 0,
          depth,
        })
      }
    }
  }
}

/**
 * 会话内已装载的工具分组（粘住）。
 *
 * 为什么要有它：装载判定是「本轮消息命中关键词」这种一次性判断，
 * 而真实对话是「先聊记账、隔几轮再问『那笔改一下』」——没有粘住的话第二句就丢了工具。
 * 切换会话时按该会话历史重新播种（重开 App 也能恢复），新对话/清空上下文时归零。
 */
let chatToolGroups = new Set<ToolGroup>()

/** 当前启用的功能插件 id：按需组里「课表 / 运动 / 健康方案」的装载门禁 */
function enabledPluginIds(): string[] {
  return useFeaturesStore().activePlugins.map((p) => p.id)
}

/** 按一段文本重播装载判定（会话历史即会话的「话题足迹」） */
function seedToolGroups(historyText: string): void {
  chatToolGroups = new Set(
    resolveToolPlan({
      text: historyText,
      plugins: enabledPluginIds(),
      // 连接应用组只在「已连接 + 允许 AI」时才会进 available；app 组没有 keywords，
      // 所以历史文本不会把它们自动装回来，模型需要时重新 load_tools。
      apps: useConnectedAppsStore().aiEnabledAppIds(),
    }).loaded,
  )
}

/** 恢复/切换会话后重建图片注册表 */
function attachChatContext(chatId: string, messages: AiMessage[]): void {
  setActiveChat(chatId)
  for (const m of messages) registerMessageImages(chatId, m)
  seedToolGroups(messages.map((m) => m.text ?? '').join('\n'))
}

/** 工具入参 → 原始 JSON 字符串（过程段展示用，落库前先脱敏与截断） */
/** 这些键的值不进聊天记录、也不落库（`save_provider` 的明文 Key 曾会永久躺在 payload 里） */
const SECRET_KEY_RE = /(api[-_]?key|token|secret|password|passwd|credential)/i
/** 单个字符串值的展示上限：本体 base64 这类几 MB 的入参不该被整份写进 ai_messages */
const ARG_VALUE_MAX = 400

function redactArgValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactArgValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '****'
      continue
    }
    if (typeof v === 'string' && v.length > ARG_VALUE_MAX) {
      out[k] = `${v.slice(0, 120)}…（共 ${v.length} 字符，已省略）`
      continue
    }
    out[k] = redactArgValue(v, depth + 1)
  }
  return out
}

function safeArgs(args: unknown): string {
  try {
    return JSON.stringify(redactArgValue(args)) ?? ''
  } catch {
    return ''
  }
}

/** 过程段工具调用 → 旧版持久化记录（保留放大镜元数据；兼容既有读法） */
function legacyToolRecord(c: ProcessToolCall): ToolCallRecord {
  return {
    name: c.rawName ?? c.toolName,
    label: c.toolName,
    argsBrief: c.arguments.length > 48 ? `${c.arguments.slice(0, 45)}…` : c.arguments,
    resultBrief: c.result,
    status: c.pending ? 'running' : c.isError ? 'error' : 'ok',
    ...(c.resultImage ? { resultImage: c.resultImage } : {}),
    ...(c.zoomId
      ? { zoomId: c.zoomId, zoomW: c.zoomW, zoomH: c.zoomH, ...(c.zoomRect ? { zoomRect: c.zoomRect } : {}) }
      : {}),
  }
}

/** 旧版持久化记录 → 过程段工具调用（历史恢复用） */
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

export const useAiStore = defineStore('ai', () => {
  const toast = useToast()
  const messages = ref<AiMessage[]>([])
  const busy = ref(false)
  /** 当前会话 id（多会话；历史抽屉可切换） */
  const chatId = ref('')
  /** 会话列表（最新置顶，来自 ai_chat_list） */
  const chats = ref<AiChat[]>([])
  /** 是否已初始化（页面重复挂载不重载） */
  const loaded = ref(false)

  // 每轮生成结束后若空闲，交给 Dream 调度（busy/dreaming/5 分钟节流都在 memory store 内再检查）
  watch(busy, (b) => {
    if (!b) void useMemoryStore().maybeDreamOnIdle()
  })
  /** 目标调整建议：解析后待用户确认，不直接生效 */
  const targetProposal = ref<TargetAdjustProposal | null>(null)
  /**
   * 从别处递进来的一句话（抢课面板的「交给 AI 排查」等）。
   *
   * 为什么走 store 而不是路由参数：携带的是**现场快照**（任务、报错原文），
   * 几十行文本塞进 URL 既难看又会被编码搞乱；而 AI 页挂载时取一次就够了。
   */
  const pendingPrompt = ref<string | null>(null)

  /** 递给 AI 页一句话；调用方负责跳转 */
  function askFrom(text: string): void {
    pendingPrompt.value = text
  }

  /** AI 页取走（取完即清，避免回到页面时重复发送） */
  function takePendingPrompt(): string | null {
    const t = pendingPrompt.value
    pendingPrompt.value = null
    return t
  }

  /**
   * 只填不发的交接（底栏快捷输入的「+」：带草稿去 AI 页加附件 —— 人按「+」是想
   * 补充内容，不是想立刻发出去）。与 pendingPrompt 的差别就在 AI 页那边发不发。
   */
  const pendingDraft = ref<string | null>(null)

  /** 递给 AI 页一段草稿（填进输入框，不发送） */
  function handOffDraft(text: string): void {
    pendingDraft.value = text
  }

  /** AI 页取走草稿（取完即清） */
  function takePendingDraft(): string | null {
    const t = pendingDraft.value
    pendingDraft.value = null
    return t
  }

  /**
   * 旧版欢迎语入口 —— **现在刻意什么都不做**。
   *
   * 它原来往空会话里插一条「你好，我是 Rein AI……」的**文字气泡**。两个问题：
   *  1. 形态上它和下面第一条真实消息完全一样（都居左、都是气泡、都同一种底色），
   *     用户分不清哪条是机器说的、哪条是自己的数据 —— 视觉重心无处安放。
   *  2. 它答的是「我是谁」，而空会话真正要答的是「我现在能干什么」。
   *     现在由 AIPage 的 AiBoard 回答（今天的数据 + 六个能力入口 + 最近会话）。
   *
   * 保留这个空实现而不是删掉：调用点有 5 处（init / selectChat / newChat /
   * clearContext / 从历史恢复），空会话的判定已经统一收敛在这里，
   * 以后若要恢复某种「开场」行为（例如按时间给不同引导），改一处即可。
   */
  function greet(): void {
    /* 空会话由 AiBoard 呈现，此处不插消息 */
  }

  /* ---------- 持久化 ---------- */

  /** 内存消息 → 存储消息（结构化信息统一放 payload：food-parse 卡 / thinking / quote） */
  function toInput(m: AiMessage): AiChatMessageInput {
    const meta: Record<string, unknown> = {}
    if (m.kind === 'food-parse') {
      meta.items = m.items
      meta.source = m.source
      meta.committedAt = m.committed ? m.at : null
      // mealType / proposal 供下一轮回灌的【食物卡状态】段（@/ai/cardState）读回
      if (m.mealType) meta.mealType = m.mealType
      if (m.proposal?.length) meta.proposal = m.proposal
    }
    if (m.kind === 'tools' && m.toolCalls) meta.calls = m.toolCalls
    if (m.kind === 'tools' && m.segments?.length) meta.segments = m.segments
    if (m.kind === 'tools' && m.thinkingSec) meta.thinkingSec = m.thinkingSec
    if (m.thinking) meta.thinking = m.thinking
    if (m.quoteText) meta.quote = m.quoteText
    if (m.voiceMeta) meta.voice = m.voiceMeta
    if (m.files?.length) meta.files = m.files
    return {
      id: m.id,
      role: m.role,
      kind: m.kind,
      text: m.text ?? null,
      imageBase64: m.imageBase64 ?? null,
      mime: m.mime ?? null,
      payload: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
    }
  }

  function persist(m: AiMessage): void {
    if (!chatId.value) return
    void aiService.aiChatAppend(chatId.value, toInput(m))
  }

  function fromStored(s: AiChatMessage): AiMessage {
    const m: AiMessage = {
      id: s.id,
      role: s.role,
      kind: s.kind,
      at: s.createdAt,
      // 分页字段随历史一起恢复：冷启动全量加载（ai_chat_messages）与
      // 分页（ai_chat_page）必须给出同一个 anchor，段构建/跳转才不会漂移。
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
        /* 损坏的历史 payload 忽略，卡片仍可展示文本 */
      }
    }
    // 旧格式（无 payload.segments）补出过程段：推理在前、工具在后，供统一渲染与放大镜注册
    if (!m.segments?.length) {
      const segs: ProcessSegment[] = []
      if (m.thinking) segs.push({ kind: 'reasoning', text: m.thinking })
      for (const [i, t] of (m.toolCalls ?? []).entries()) {
        segs.push({ kind: 'tool', call: legacyCallToProcess(t, i, m.id) })
      }
      if (segs.length > 0) m.segments = segs
    }
    return m
  }

  /** 启动载入：取最近会话（无则新建），并恢复其消息 */
  async function init(): Promise<void> {
    if (loaded.value) return
    loaded.value = true
    try {
      chats.value = await aiService.aiChatList()
      if (chats.value.length > 0) {
        chatId.value = chats.value[0]!.id
      } else {
        chatId.value = newChatId()
        await aiService.aiChatEnsure(chatId.value, null)
        chats.value = await aiService.aiChatList()
      }
      messages.value = (await aiService.aiChatMessages(chatId.value)).map(fromStored)
      resetStreaming()
      restoreBubbleMetaFromHistory()
      attachChatContext(chatId.value, messages.value)
      // 打开会话时按最近一条用户消息预取顶部记忆卡（无消息时清除）
      void useMemoryStore().loadCardsForChat(chatId.value)
    } catch {
      messages.value = []
    }
    if (messages.value.length === 0) greet()
    // 启动后若空闲，检查一次 Dream（Rust 侧 3h 冷却 + 前端 5 分钟节流；无模型直接跳过）
    void useMemoryStore().maybeDreamOnIdle()
  }

  async function refreshChats(): Promise<void> {
    chats.value = await aiService.aiChatList()
  }

  /* ---------- 知识库 / 长期记忆 ---------- */

  /**
   * 取喂给系统提示词的「用户认知」块（委托 memory store 的分片注入）。
   * 自动注入严格只读：不写 history/stability/state；失败返回旧缓存/undefined，
   * 绝不因此让对话发不出去。
   */
  async function cognitionForPrompt(query?: string): Promise<string | undefined> {
    return useMemoryStore().injectForPrompt(query, chatId.value)
  }

  function invalidateCognitionCache(): void {
    useMemoryStore().invalidate()
  }

  /**
   * 取喂给系统提示词的「全量注入区」：系统提示词目录 + 用户记忆目录（docs/ai-workspace.md §3.4）。
   * 与认知块同样的短 TTL 缓存：改完用户记忆要能很快生效，但也不必每轮都查库。
   * 知识库不可用时返回 undefined，绝不因此让对话发不出去。
   */
  let injectionCache: { at: number; value: { system: string; memory: string; truncated: boolean } } | null =
    null
  const INJECTION_TTL_MS = 60_000

  async function injectionForPrompt(): Promise<
    { system: string; memory: string; truncated: boolean } | undefined
  > {
    const now = Date.now()
    if (!injectionCache || now - injectionCache.at > INJECTION_TTL_MS) {
      try {
        const inj = await kbService.injection()
        injectionCache = {
          at: now,
          value: { system: inj.system, memory: inj.memory, truncated: inj.truncated },
        }
      } catch {
        return injectionCache?.value
      }
    }
    const v = injectionCache.value
    return v.system.trim() || v.memory.trim() ? v : undefined
  }

  /**
   * 本会话引用过的纪要（含每条总结的写入状态，见 voice_memos.summaryJson）。
   * 只在会话里真的有语音轮时才查库（其余会话零开销）；不缓存 —— 用户刚点「写入」
   * 下一轮就得反映出来。任何失败都静默返回空：绝不因为纪要读不到就让这一轮发不出去。
   */
  async function memosForChat(list: AiMessage[]): Promise<VoiceMemo[]> {
    const ids: string[] = []
    for (const m of list) {
      const id = m.kind === 'voice' ? m.voiceMeta?.memoId : undefined
      if (id && !ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0) return []
    try {
      // 只认最近 MAX_MEMOS 条纪要：更早的那些不属于「刚发生的事」
      const want = new Set(ids.slice(-MAX_MEMOS))
      const all = await voiceService.memoList(50)
      return all
        .filter((memo) => want.has(memo.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    } catch {
      return []
    }
  }

  /* ---------- 记忆抽取（会话结束） ---------- */

  /**
   * 会话结束时的记忆抽取。刻意做成**不 await 的后台任务**：
   * 一次模型调用要 1~3 秒，让用户等它结束才切会话是不可接受的。
   * 传快照而非读 messages.value，是因为调用方随后就会清空消息。
   */
  function scheduleMemoryExtraction(snapshotChatId: string, snapshot: AiMessage[]): void {
    const turns = snapshot
      .filter(
        (m) =>
          (m.kind === 'text' || m.kind === 'analysis' || m.kind === 'voice') && (m.text ?? '').trim(),
      )
      .map((m) => ({ role: m.role, text: m.text as string }))
      .slice(-24)
    if (turns.filter((t) => t.role === 'user').length === 0) return

    void (async () => {
      // 记忆抽取失败绝不能影响对话，整段静默
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const cfg = models.defaultModel()
      if (!cfg) return
      const s = await kbService.settingsGet()
      if (!s.autoMemory) return

      // 只给模型看 curated（手动/梦境/重要）；conversation 会占满 120 条并把旧记忆挤出上下文
      const existing = await kbService.memoryShards('all', 'curated', 120)
      const { extractMemories } = await import('@/ai/memoryExtract')
      const actions = await extractMemories({ config: cfg, turns, existing })
      if (actions.length === 0) return

      const r = await kbService.memoryShardApply(
        actions,
        snapshotChatId,
        snapshot.map((m) => m.id),
      )
      invalidateCognitionCache()
      const changed = r.added + r.updated + r.deleted + r.restored
      if (changed > 0) toast.toast(`已更新 ${changed} 条长期记忆`)
    })()
      .catch(() => {})
      .finally(() => {
        // 抽取结束后若空闲，交给 Dream 调度（3h 冷却 + 5 分钟内存节流）
        void useMemoryStore().maybeDreamOnIdle()
      })
  }

  /** 切换会话（历史抽屉选择） */
  async function selectChat(id: string): Promise<void> {
    if (busy.value || id === chatId.value) return
    // 离开当前会话 = 一次会话结束，先拿快照再切
    scheduleMemoryExtraction(chatId.value, messages.value)
    chatId.value = id
    try {
      messages.value = (await aiService.aiChatMessages(id)).map(fromStored)
      resetStreaming()
      restoreBubbleMetaFromHistory()
      attachChatContext(id, messages.value)
    } catch {
      messages.value = []
    }
    if (messages.value.length === 0) greet()
    // 顶部记忆卡跟随会话：缓存命中时不会多发 IPC
    void useMemoryStore().loadCardsForChat(id)
  }

  /**
   * 新对话 / 清空上下文后重置分页游标。
   *
   * 不重置会留下上一轮的 `hasMoreAfter/nextAfterSeq`：清空后新发的消息没有 seq，
   * 下一次 `loadNewer` 会把它们当成「更早的页」再 append 一遍；切会话时旧游标
   * 还可能让 `loadTail` 的响应被 `requestedChatId` 提前认领。动态引入避免
   * ai ↔ chatPaging 的静态循环依赖。
   */
  async function resetPaging(reloadTail: boolean): Promise<void> {
    const { useChatPagingStore } = await import('@/stores/chatPaging')
    const p = useChatPagingStore()
    p.reset()
    if (reloadTail && chatId.value) await p.loadTail(chatId.value)
  }

  /** 新对话：新建空会话并写入欢迎语 */
  async function newChat(): Promise<void> {
    if (busy.value) return
    busy.value = true
    // 清空之前先快照，否则抽取看不到刚聊完的内容
    scheduleMemoryExtraction(chatId.value, messages.value)
    try {
      chatId.value = newChatId()
      resetChat(chatId.value)
      chatToolGroups.clear()
      await aiService.aiChatEnsure(chatId.value, null)
      messages.value = []
      resetStreaming()
      greet()
      await resetPaging(true)
      void useMemoryStore().loadCardsForChat(chatId.value)
      await refreshChats()
    } finally {
      busy.value = false
    }
  }

  /** 清空当前会话上下文（消息删除，会话保留） */
  async function clearContext(): Promise<void> {
    if (busy.value) return
    busy.value = true
    scheduleMemoryExtraction(chatId.value, messages.value)
    try {
      await aiService.aiChatClear(chatId.value)
      resetChat(chatId.value)
      chatToolGroups.clear()
      messages.value = []
      resetStreaming()
      greet()
      await resetPaging(true)
      void useMemoryStore().loadCardsForChat(chatId.value)
      await refreshChats()
    } finally {
      busy.value = false
    }
  }

  /** 撤回用户消息：连同其后（按顺序）的对话一起删除 */
  async function retract(messageId: string): Promise<void> {
    if (busy.value) return
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx === -1 || messages.value[idx]!.role !== 'user') return
    busy.value = true
    try {
      await aiService.aiChatCut(chatId.value, messageId)
      messages.value = messages.value.slice(0, idx)
      // 撤回后重新播种：被撤掉的轮次不该继续粘着它的工具分组
      seedToolGroups(messages.value.map((m) => m.text ?? '').join('\n'))
      await refreshChats()
    } finally {
      busy.value = false
    }
  }

  /** 会话首条用户消息后，把默认标题改成消息摘要 */
  async function maybeRename(firstText: string): Promise<void> {
    const chat = chats.value.find((c) => c.id === chatId.value)
    if (!chat || chat.title !== 'AI 对话') return
    const title = firstText.replace(/\s+/g, ' ').slice(0, 16) || '照片'
    try {
      await aiService.aiChatRename(chatId.value, title)
      chat.title = title
    } catch {
      /* 重命名失败不阻塞聊天 */
    }
  }

  /** 入列后取回消息的**响应式代理**再交给调用方。
   *
   * 为什么必须取回来：`messages.value` 是 ref 数组，元素读出来才是 Proxy，直接写原始对象
   * 绕过了 set 拦截器 —— 数据变了、依赖不触发、界面不动。用户报的「AI 已经出卡，切到别的
   * 页面再回来才弹出」就是这条：定稿时改的正是刚 push 进去的原始对象。 */
  function reactiveMsg(m: AiMessage): AiMessage {
    return messages.value.find((x) => x.id === m.id) ?? m
  }

  function pushAssistant(msg: Partial<AiMessage>, persistNow = true): AiMessage {
    const m: AiMessage = { id: uid(), role: 'assistant', kind: 'text', at: new Date().toISOString(), ...msg }
    messages.value.push(m)
    if (persistNow) persist(m)
    return reactiveMsg(m)
  }

  function pushUser(msg: Partial<AiMessage>): AiMessage {
    const m: AiMessage = { id: uid(), role: 'user', kind: 'text', at: new Date().toISOString(), ...msg }
    messages.value.push(m)
    persist(m)
    return reactiveMsg(m)
  }

  /* ---------- 流式气泡聚合 ----------
   * 聚合规则与数据结构见 @/ai/streamBubbles（照搬 EffiBuddy useChatStreaming）；
   * 本 store 只负责：消息入列 + 入场动画、增量切片投喂、定稿持久化、历史恢复。 */

  const streamSeq = ref(0)
  /** 本轮流式创建的消息（定稿时统一收尾/持久化） */
  let streamCreated: AiMessage[] = []
  /**
   * 本轮 AI 挂出的工作区文件（`present_file` 的结果，见 @/ai/chatFiles）。
   *
   * 为什么先在轮级攒着、定稿时才落到气泡上：工具调用发生在**过程气泡**里，
   * 而正文（以及正文承载气泡）可能还没出现 —— 卡片跟着正文那条走才读得顺
   * （「写了什么」与「产物在哪」在同一处），所以收尾时一次性挂上去。
   */
  let turnFiles: KbEntry[] = []

  function createBubble(id: string, withAnim: boolean): AiMessage {
    const msg: AiMessage = {
      id,
      role: 'assistant',
      kind: 'text',
      at: new Date().toISOString(),
      text: '',
      streaming: true,
    }
    messages.value.push(msg)
    // 与 pushAssistant 同理：入列后一律用响应式代理往下传（streamCreated 会被
    // settleStreamMessages / applyLlmReply 就地改写，写原始对象同样不触发渲染）
    const bubble = reactiveMsg(msg)
    streamCreated.push(bubble)
    streamSeq.value++
    // 入场动画仅 opacity + scale，不动 height（思考/工具占位气泡跳过；
    // 掉帧降级期同样跳过——每个气泡一次合成在弱机上是纯负担。
    // 「要不要动」统一读 system/motion 的生效档位：它把用户选的「关闭」与
    // 系统 prefers-reduced-motion 合成一个答案，这里不再各自 matchMedia）
    if (withAnim && motionOn.value && !perfDegraded.value) {
      void nextTick(() => {
        const el = document.getElementById('msg-' + id)
        if (!el) return
        // 初始状态:透明 + 缩放 0.96(轻微,避免大幅缩放导致内容模糊)
        el.style.opacity = '0'
        el.style.transform = 'scale(0.96)'
        el.style.transformOrigin = 'center top'
        void el.offsetHeight // 强制 reflow 确保 anime.js 起点准确
        animate(el, {
          opacity: [0, 1],
          scale: [0.96, 1],
          duration: 280,
          ease: 'out(3)',
          onComplete: () => {
            el.style.opacity = ''
            el.style.transform = ''
            el.style.transformOrigin = ''
          },
        })
      })
    }
    return bubble
  }

  const agg = createStreamAggregator<AiMessage>({
    messages: () => messages.value,
    createBubble,
    nextId: uid,
    onEvent: () => {
      streamSeq.value++
    },
  })

  /** 纯过程气泡定稿：morph 成 tools 载体并附上推理/过程段/工具记录（供历史与放大镜读回） */
  function settleProcessMessage(m: AiMessage): void {
    const meta = agg.getMeta(m.id)
    if (!meta) return
    m.streaming = false
    m.kind = 'tools'
    m.thinking = meta.reasoning || undefined
    m.thinkingSec = meta.thinkingSec
    m.segments = meta.segments
    m.toolCalls = meta.toolCalls.map(legacyToolRecord)
  }

  /** 本轮创建的流式消息收尾：过程气泡定格、正文气泡保留、纯空占位撤掉 */
  function settleStreamMessages(finalBubble: AiMessage | null): void {
    for (const m of streamCreated) {
      m.streaming = false
      // 认 id 不认对象：finalBubble 可能是 messages.value.find(...) 取出的代理，
      // 也可能是 pushAssistant 新建的那条 —— 对象身份不作为判据，id 才是。
      // （历史上这里吃过亏：定稿气泡被当「无正文也无过程的空占位」摘掉，
      //  于是「模型没思考没工具、直接出 food 卡」时卡片落在一个已脱列的对象上，
      //  界面上什么都不显示。）
      if (finalBubble && m.id === finalBubble.id) continue
      const meta = agg.getMeta(m.id)
      if (!m.text && meta && (meta.reasoning || meta.toolCalls.length)) {
        settleProcessMessage(m)
        persist(m)
        continue
      }
      if (m.text) {
        persist(m)
        continue
      }
      // 无正文也无过程的纯空占位 → 从列表撤掉（不落库）
      const idx = messages.value.indexOf(m)
      if (idx >= 0) messages.value.splice(idx, 1)
    }
    // 注：不清空 streamCreated —— 定稿后若再抛错，catch 里还能补一次收尾（落库按 id 幂等）
  }

  /** 会话切换/清空:清空全部流式与渲染状态 */
  function resetStreaming(): void {
    agg.reset()
    streamCreated = []
    turnFiles = []
  }

  /** 历史恢复：从持久化消息重建气泡元数据（照搬 EffiBuddy restoreBubbleMetaFromHistory） */
  function restoreBubbleMetaFromHistory(): void {
    // 第一遍：合并连续「纯过程消息」（kind=tools）到同一个容器。
    // 后端按消息边界分条落盘，流式期间这些轮次共用同一气泡；恢复时若逐条渲染
    // 会出现多个独立的推理框。这里把紧随其后的纯过程消息内容并入前一条（容器）。
    let containerId: string | null = null
    for (const m of messages.value) {
      if (m.role !== 'assistant') {
        containerId = null
        continue
      }
      const isProcessOnly = m.kind === 'tools' && !m.text
      if (isProcessOnly && containerId) {
        const host = messages.value.find((x) => x.id === containerId)
        if (host) {
          if (m.thinking) host.thinking = (host.thinking ?? '') + m.thinking
          host.thinkingSec = (host.thinkingSec ?? 0) + (m.thinkingSec ?? 0)
          host.segments = [...(host.segments ?? []), ...(m.segments ?? [])]
          host.toolCalls = [...(host.toolCalls ?? []), ...(m.toolCalls ?? [])]
        }
        // 被吸收消息清空内容，仅保留 id/kind 空壳，渲染跳过
        agg.ensureMeta(m.id).absorbed = true
        m.thinking = undefined
        m.segments = []
        m.toolCalls = []
        continue
      }
      containerId = isProcessOnly ? m.id : null
    }
    // 第二遍：逐条恢复 meta（被吸收消息跳过）
    for (const m of messages.value) {
      if (m.role !== 'assistant') continue
      if (agg.getMeta(m.id)?.absorbed) continue
      const meta = agg.ensureMeta(m.id)
      // 思考时长 → 「已思考 X 秒」（历史中视为已思考完成）
      meta.thinkingSec = m.thinkingSec ?? 0
      meta.isThinking = false
      if (m.segments?.length) {
        // 新格式：过程段按持久化顺序原样恢复（历史记录总是已完成，pending=false）
        meta.segments = m.segments.map((s) =>
          s.kind === 'tool' ? { kind: 'tool', call: { ...s.call, pending: false } } : s,
        )
        meta.reasoning = m.thinking ?? ''
      } else {
        // 旧格式：推理在前、工具在后，按持久化顺序还原过程段
        if (m.thinking) {
          meta.reasoning = m.thinking
          meta.segments.push({ kind: 'reasoning', text: m.thinking })
        }
        for (const [i, t] of (m.toolCalls ?? []).entries()) {
          meta.segments.push({ kind: 'tool', call: legacyCallToProcess(t, i, m.id) })
        }
      }
    }
  }

  /* ---------- 会话 ---------- */

  /** 无模型时的兜底：本地关键词解析（无网络依赖） */
  async function keywordParse(clean: string): Promise<void> {
    const items = await aiService.parseFoodText(clean)
    if (items.length === 0) {
      pushAssistant({ text: '暂时没能从这句话里识别出食物。试试「一个苹果」「200克鸡胸肉」这样的说法。' })
    } else {
      pushAssistant({ kind: 'food-parse', source: 'text_ai', items })
    }
  }

  /** LLM 回复定稿：原地把流式气泡 morph 成解析卡或文本气泡，并持久化。
   * 思考已在过程气泡上（ProcessSection），此处不再回填 thinking。 */
  async function applyLlmReply(msg: AiMessage, raw: string): Promise<void> {
    msg.streaming = false
    let body: unknown = null
    try {
      const s = raw.indexOf('{')
      const e = raw.lastIndexOf('}')
      if (s !== -1 && e > s) body = JSON.parse(raw.slice(s, e + 1))
    } catch {
      /* 非 JSON 输出：整段当纯文本回复 */
    }
    const obj = body as { kind?: unknown; items?: unknown; text?: unknown } | null
    if (obj && obj.kind === 'food' && Array.isArray(obj.items)) {
      const rows = normalizeFoodRows(obj.items)
      if (rows.length > 0) {
        msg.kind = 'food-parse'
        msg.source = 'text_ai'
        msg.items = await toParsedItems(rows)
        // 模型原始条目快照：用户改过克重时，卡片状态回灌要标出「修改后确认」（@/ai/cardState）
        msg.proposal = msg.items.map((it) => ({ foodName: it.foodName, grams: it.grams }))
        msg.text = undefined
        persist(msg)
        return
      }
    }
    const parsed = obj && typeof obj.text === 'string' ? obj.text : raw
    // 解析出的正文可能为空（模型只回了结构或空串）：此时保住流式期间已经显示出来的正文，
    // 不能因为定稿解析这一下把用户刚才看到的内容清掉
    msg.text = parsed.trim() ? parsed : (msg.text ?? '')
    if (!msg.text.trim()) {
      // 挂出的文件卡片也是内容：模型只调了 present_file 没说话时，消息要留下来承载卡片
      if (msg.files?.length) {
        persist(msg)
        return
      }
      // 模型没输出任何内容：撤掉空正文气泡（过程气泡已由 settleStreamMessages 落库），不写空消息。
      // 注意这里不再按「有没有过程段」豁免——撇开空文字本身就说明它没有正文可留，
      // 而承载过程段的气泡在 settleStreamMessages 里已另走一趟，不会走到这里。
      const idx = messages.value.indexOf(msg)
      if (idx >= 0) messages.value.splice(idx, 1)
      return
    }
    persist(msg)
  }

  /** 模型输出的 items 行 → 标准识别行（容忍变体键名；克重缺省 100g；foodId 透传待校验） */
  function normalizeFoodRows(items: unknown[]): ModelFoodRow[] {
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null
    const gramsFromQuantity = (v: unknown): number | null => {
      const m = typeof v === 'string' ? v.match(/(\d+(?:\.\d+)?)\s*(克|g|kg|公斤)/i) : null
      if (!m) return null
      return /^kg|公斤$/i.test(m[2]!) ? Number(m[1]!) * 1000 : Number(m[1]!)
    }
    const rows: ModelFoodRow[] = []
    for (const r of items) {
      if (typeof r !== 'object' || r === null) continue
      const o = r as Record<string, unknown>
      const foodName =
        typeof o.foodName === 'string' ? o.foodName.trim() : typeof o.name === 'string' ? o.name.trim() : ''
      if (!foodName) continue
      // 每 100g 营养估算（库中不存在时自动补录用）；容忍 kcal 放在 nutrition 外层
      const n = (typeof o.nutrition === 'object' && o.nutrition !== null ? o.nutrition : {}) as Record<string, unknown>
      const nutrition = {
        kcal: num(n.kcal) ?? num(o.nutritionKcal) ?? undefined,
        protein: num(n.protein) ?? undefined,
        carb: num(n.carb) ?? undefined,
        fat: num(n.fat) ?? undefined,
        fiber: num(n.fiber) ?? undefined,
        sugar: num(n.sugar) ?? undefined,
        sodiumMg: num(n.sodiumMg) ?? undefined,
      }
      rows.push({
        foodName,
        grams: num(o.grams) ?? num(o.weight) ?? gramsFromQuantity(o.quantity) ?? 100,
        kcalEstimate: num(o.kcalEstimate) ?? num(o.kcal) ?? num(o.calories) ?? 0,
        foodId: typeof o.foodId === 'number' && Number.isFinite(o.foodId) ? o.foodId : null,
        nutrition,
      })
    }
    return rows
  }

  /** 发送一轮消息：纯文本 / 文字+附图 / 文档（含解析文本与选中图片）。
   * 图片随消息发给模型并注册进放大镜注册表（生成 img-xx 编号清单）；
   * 带图时自动改用视觉模型；模型看图决定出 food 卡（智能填入）还是回答问题。
   * memoRefs：@纪要引用——把纪要总结与逐句转写注入本轮文本。 */
  async function sendText(
    text: string,
    opts: { quoteText?: string; images?: SendImage[]; doc?: AiDocMeta; memoRefs?: VoiceMemo[] } = {},
  ): Promise<void> {
    const clean = text.trim()
    const sendImages = opts.images ?? []
    if ((!clean && sendImages.length === 0 && !opts.doc) || busy.value) return
    // 发送必须基于会话尾部：用户可能刚「查看原文」跳到旧 anchor，分页窗口被
    // around 页整体替换。不先对齐尾页的话，本轮 history 只剩旧页，且之后
    // loadNewer 会把中间消息追加到新消息之后（数组不再按 seq 有序）。
    // 动态引入避免 ai ↔ chatPaging 的静态循环依赖。
    // 对齐有一次异步 IPC：先占住 busy，期间不能被另一次发送插进来。
    const sendChatId = chatId.value
    busy.value = true
    try {
      const { useChatPagingStore } = await import('@/stores/chatPaging')
      await useChatPagingStore().alignToTail()
    } catch {
      /* 对齐失败不阻塞发送：继续用当前窗口，至少不丢用户刚输入的内容 */
    } finally {
      busy.value = false
    }
    if (chatId.value !== sendChatId) return
    const quote = opts.quoteText?.trim()
    setActiveChat(chatId.value)
    // 预注册历史轮图片（幂等），保证放大镜 id 与历史清单一致
    for (const m of messages.value) registerMessageImages(chatId.value, m)
    const mid = uid()
    // 注册本轮图片 → 生成图片清单文本（随用户轮发给模型，供 view_image_detail 引用）
    const outImages = sendImages.map((im) => ({ base64: im.base64, mime: im.mime, w: im.w, h: im.h, label: im.label }))
    sendImages.forEach((im, k) => {
      registerSourceImage(chatId.value, {
        id: `img-${mid}-${k}`,
        label: im.label,
        source: im.source,
        viewW: im.w,
        viewH: im.h,
      })
    })
    const imgNote =
      outImages.length > 0
        ? `[图片清单] ${outImages.map((im, k) => `img-${mid}-${k}（视图 ${im.w}×${im.h}，${im.label}）`).join('；')}`
        : undefined
    if (opts.doc) {
      pushUser({ id: mid, kind: 'doc', text: clean || undefined, doc: opts.doc, images: outImages.length > 0 ? outImages : undefined, imgNote })
    } else if (outImages.length > 0) {
      pushUser({
        id: mid,
        kind: 'photo',
        text: clean || undefined,
        imageBase64: outImages[0]!.base64,
        mime: outImages[0]!.mime,
        images: outImages.length > 1 ? outImages : undefined,
        imgNote,
        quoteText: quote || undefined,
      })
    } else {
      pushUser({ id: mid, text: clean, quoteText: quote || undefined })
    }
    void maybeRename(clean)
    busy.value = true
    // 本轮流式聚合状态：过程气泡 + 正文气泡按 EffiBuddy 聚合规则生成
    streamCreated = []
    turnFiles = []
    // 增量基准：协议流回调给的是「累计全文」，按已展示长度切片投喂聚合器
    let textShown = ''
    let thinkingShown = ''
    try {
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const { chatWithModel } = await import('@/ai/chat')
      // 上下文：历史轮次（文本/照片/文档），最多 16 轮；图片随轮次重建
      const history = messages.value
        .slice(0, -1)
        .flatMap((mm): ChatTurn[] => {
          const imgs = (mm.images ?? []).map((im) => ({ data: im.base64, mimeType: im.mime }))
          const turnImgs = imgs.length > 0 ? imgs : mm.imageBase64 ? [{ data: mm.imageBase64, mimeType: mm.mime ?? 'image/jpeg' }] : undefined
          if (mm.kind === 'doc' && mm.doc) {
            return [{ role: 'user', text: composeOutgoingText(mm.text ?? '', mm.doc, mm.imgNote), images: turnImgs }]
          }
          if (mm.kind === 'photo' && (turnImgs || mm.text || mm.imgNote)) {
            return [{ role: 'user', text: [mm.text, mm.imgNote].filter(Boolean).join('\n'), images: turnImgs }]
          }
          if ((mm.kind === 'text' || mm.kind === 'analysis' || mm.kind === 'voice') && mm.text) {
            return [{ role: mm.role, text: mm.text }]
          }
          return []
        })
        .slice(-16)
      // 本轮带图或历史带图：自动降级用视觉模型（默认不支持视觉时改用任一已证实视觉的）
      const outgoingImages = outImages.map((im) => ({ data: im.base64, mimeType: im.mime }))
      const needsVision =
        outgoingImages.length > 0 || history.some((h) => h.role === 'user' && (!!h.images?.length || !!h.image))
      const cfg = needsVision ? models.bestVisionModel() : models.defaultModel()
      if (!cfg) {
        if (outgoingImages.length > 0) {
          pushAssistant({ text: '识别图片需要先在「模型」页添加并探测 AI 模型。' })
        } else {
          await keywordParse(clean)
        }
        return
      }
      // 同步放大镜的视图/输出上限到所选模型配置（发送视图在选图时已按视觉模型压好）
      setViewEdgeCap(cfg.imageMaxEdge ?? DEFAULT_IMAGE_EDGE)
      // @纪要引用：把总结+逐句转写注入本轮文本，模型据此回答针对录音内容的问题
      const memoContext = (opts.memoRefs ?? [])
        .map((memo) => {
          const sums = memo.summary.map((it) => `- [${it.kind}] ${it.text}`).join('\n') || '（无总结条目）'
          const sents = memo.sentences.map((s) => `${s.idx}. ${s.text}`).join('\n')
          return `（引用语音纪要《${memo.title}》\n总结：\n${sums}\n逐句转写：\n${sents}）`
        })
        .join('\n\n')
      const outgoingText =
        (memoContext ? memoContext + '\n\n' : '') +
        composeOutgoingText(
          quote ? `（引用我之前的一条消息：「${quote}」）\n${clean}` : clean,
          opts.doc,
          imgNote,
        )
      // 上传文档的**全文**自动归档进知识库（prompt 只带截断版，全文靠 read_knowledge 分页读）。
      // 归档要 await：落库完成后模型本轮就能 read_knowledge 到全文；失败只提示，不影响本轮对话。
      if (opts.doc?.fullText?.trim()) {
        const docPath = docArchivePath(opts.doc.name)
        await kbService
          .fileWrite({ path: docPath, content: opts.doc.fullText })
          .then(() => {
            invalidateCognitionCache()
            toast.toast(`已归档到知识库：${docPath}`)
          })
          .catch(() => {})
      }
      // 流式占位气泡：先建一个空 text 气泡承载推理/工具（无内容不播入场动画）；
      // 正文出现时按聚合规则「断开合并」另起正文气泡
      agg.openBubble(false)
      // 长期记忆作为「事实前提」预注入，而不是等模型自己去调工具发现；
      // 分片注入严格只读，默认只取 curated（手动/梦境/重要），不进 conversation
      const cognition = await cognitionForPrompt(clean)
      // 顶部记忆卡与注入同一份结果；不参与消息列表/虚拟滚动
      void useMemoryStore().loadCardsForChat(chatId.value, clean)
      const injection = await injectionForPrompt()
      // 卡片本身不进历史（下面的 history 只挑 text/analysis/voice/photo/doc），
      // 所以「用户确认了没有、最终写了什么」只能靠这段每轮重发的事实前提带过去：
      // 聊天内的卡（食物卡 / 纪要）现算，跨页面的 AI 提议看记录（@/ai/cardOutcomes）
      const cardState = buildCardStateBlock({
        messages: messages.value,
        memos: await memosForChat(messages.value),
        outcomes: listCardOutcomes(),
      })
      const r = await chatWithModel(cfg, history, { text: outgoingText, images: outgoingImages.length > 0 ? outgoingImages : undefined }, {
        onText: (p) => {
          // 从 JSON 协议流里解出正文；food 卡 / 未定型阶段保持打字态
          const view = chatStreamView(p)
          const visible = view.mode === 'chat' || view.mode === 'plain' ? view.text : ''
          if (visible.length >= textShown.length && visible.startsWith(textShown)) {
            const delta = visible.slice(textShown.length)
            textShown = visible
            if (delta) agg.appendText(delta)
          } else {
            // 基准失效（工具后 textAcc 清零重新累计）→ 仅重置基准
            textShown = visible
          }
        },
        onThinking: (p) => {
          // thinking_delta 给累计增量、thinking_end 重发全量；统一按已展示长度切增量
          if (p.length >= thinkingShown.length && p.startsWith(thinkingShown)) {
            const delta = p.slice(thinkingShown.length)
            thinkingShown = p
            if (delta) agg.appendReasoning(delta)
          } else {
            thinkingShown = p
          }
        },
        onToolStart: (name, args) => {
          agg.toolCall(name, findAppTool(name)?.label ?? name, safeArgs(args))
        },
        onToolEnd: (name, ok, brief, resultImage, details) => {
          agg.toolResult(name, { ok, brief, resultImage, details })
          // present_file：工具结果里带 file 条目 → 本轮攒着，定稿时挂到正文气泡下（见 turnFiles）
          const f = fileAttachmentOf(name, details)
          if (f) turnFiles.push(f)
        },
      }, {
        cognition,
        injection,
        cardState,
        // 按需装载：常驻组 + 本轮消息命中的组 + 本会话粘住的组；关掉的功能插件整组不给
        plugins: enabledPluginIds(),
        loadedGroups: chatToolGroups,
      })
      // 本轮扩载过的组（含模型自己调 load_tools 装的）粘到会话上，后续追问不再重猜
      for (const g of r.loadedGroups) chatToolGroups.add(g)
      // 流式收尾：结束思考计时（照搬 EffiBuddy finalizeStream 的状态语义）
      const lastStreamBubble = agg.streamingBubbleId.value
        ? (messages.value.find((m) => m.id === agg.streamingBubbleId.value) ?? null)
        : null
      agg.finalize()
      // 正文承载气泡：流式指针上的气泡已有正文、或它本就是纯占位（无过程段）时由它承载；
      // 指针上是纯过程气泡（有推理/工具无正文）则取最后一条有正文的气泡
      let bodyBubble: AiMessage | null =
        lastStreamBubble && (lastStreamBubble.text || !(agg.getMeta(lastStreamBubble.id)?.segments.length))
          ? lastStreamBubble
          : ([...streamCreated].reverse().find((m) => m.text) ?? null)
      if (!bodyBubble) {
        // 全程只有过程（模型直接出 food 卡 / 空回复）：另起一个空正文气泡承接定稿
        bodyBubble = pushAssistant({ kind: 'text', text: '', streaming: false }, false)
        streamCreated.push(bodyBubble)
      }
      settleStreamMessages(bodyBubble)
      // 挂出的文件卡片落到正文气泡上：先挂再定稿，payload 一次写全（含空回复那一支）
      if (turnFiles.length > 0) {
        bodyBubble.files = dedupeFiles([...(bodyBubble.files ?? []), ...turnFiles]).slice(0, MAX_CHAT_FILES)
      }
      await applyLlmReply(bodyBubble, r.text)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 流式中断：结束思考计时，过程气泡与已有正文保留，纯空占位撤掉
      agg.finalize()
      settleStreamMessages(null)
      pushAssistant({ text: `AI 回复失败：${msg}` })
    } finally {
      busy.value = false
    }
  }

  /** 语音轮：转写文本入会话（kind=voice 用户消息）+ 调 memoGen 整理纪要。
   * 整理期间回复流每 ~1s upsert 一次（实时持久化：崩溃最多丢最后一秒，不丢整段）。
   * 返回创建的纪要（无模型/失败时 null，转写内容始终已入会话）。 */
  async function sendVoiceTurn(input: {
    lines: { idx: number; text: string; startMs: number; endMs: number }[]
    memoId: string
    audioPath?: string | null
    durationMs: number
  }): Promise<VoiceMemo | null> {
    const transcript = input.lines.map((l) => l.text).join('')
    pushUser({
      kind: 'voice',
      text: transcript,
      voiceMeta: { memoId: input.memoId, durationMs: input.durationMs, words: transcript.length },
    })
    void maybeRename(transcript.slice(0, 16) || '语音')
    busy.value = true
    // 占位气泡：流式期间周期 upsert（原始协议文本，定稿后替换为 markdown 回复）
    const bubble = pushAssistant({ kind: 'text', text: '', streaming: true }, false)
    let lastPersist = 0

    /** 把这一段（转写 + 音频 + 纪要条目）落进历史。
     *  **无论 AI 整理成功与否都必须调用** —— 记录与音频是用户自己的东西，
     *  不该因为模型没配置、没额度或整理报错就从历史里消失。 */
    const persistMemo = (result: MemoGenResult | null): Promise<VoiceMemo> =>
      voiceService.memoCreate({
        id: input.memoId,
        chatId: chatId.value,
        messageId: bubble.id,
        title: result?.title || `语音 ${new Date().toTimeString().slice(0, 5)}`,
        audioPath: input.audioPath ?? null,
        durationMs: input.durationMs,
        words: transcript.length,
        sentencesJson: JSON.stringify(input.lines),
        summaryJson: JSON.stringify((result?.items ?? []).map((it) => ({ ...it, written: false }))),
      })

    try {
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const cfg = models.defaultModel()
      let result: MemoGenResult | null = null
      if (cfg) {
        const { generateMemo } = await import('@/ai/memoGen')
        result = await generateMemo(cfg, input.lines, {
          onText: (raw) => {
            bubble.text = raw
            const now = Date.now()
            if (now - lastPersist > 1000) {
              lastPersist = now
              persist(bubble)
            }
          },
        })
      }
      bubble.streaming = false
      bubble.text = result?.reply ?? '还没有配置 AI 模型，转写已保存，配置后可整理纪要。'
      persist(bubble)
      const memo = await persistMemo(result)
      void refreshChats()
      return memo
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      bubble.streaming = false
      if (bubble.text) {
        persist(bubble)
      } else {
        const idx = messages.value.indexOf(bubble)
        if (idx >= 0) messages.value.splice(idx, 1)
      }
      // 整理失败也必须落库：记录与音频不能因为模型报错就丢
      try {
        await persistMemo(null)
        void refreshChats()
      } catch {
        /* 连纪要行都写不进去：下面的提示已说明转写仍留在会话里 */
      }
      pushAssistant({ text: `纪要整理失败：${msg}。转写与录音已存入历史。` })
      return null
    } finally {
      busy.value = false
    }
  }

  /** 解析条目 → 写入某日饮食（跳过未匹配项）。聊天解析卡与拍照识别弹层共用。 */
  async function commitParsedItems(
    items: ParsedFoodItem[],
    mealType: MealType,
    source: 'photo_ai' | 'text_ai' = 'text_ai',
    date = todayStr(),
  ): Promise<{ written: number }> {
    let written = 0
    for (const item of items) {
      if (item.foodId == null) continue
      await dietService.logMeal({
        foodId: item.foodId,
        date,
        mealType,
        quantityMode: 'grams',
        grams: item.grams,
        units: null,
        unitName: null,
        source,
        note: null,
      })
      written++
    }
    await Promise.all([useDietStore().load(date), useNutritionStore().loadSummary(date)])
    return { written }
  }

  /** 确认聊天里的解析卡：写入今日饮食并标记完成 */
  async function commitParse(messageId: string, mealType: MealType): Promise<void> {
    const msg = messages.value.find((m) => m.id === messageId)
    if (!msg?.items?.length || msg.committed) return
    const r = await commitParsedItems(msg.items, mealType, msg.source ?? 'text_ai')
    msg.committed = true
    // 餐次落 payload：下一轮回灌要告诉模型「已写入今日午餐」（否则只能说「已写入今日饮食」）
    msg.mealType = mealType
    persist(msg)
    const skipped = msg.items.length - r.written
    if (skipped > 0) toast.toast(`已写入 ${r.written} 项，跳过 ${skipped} 项未匹配`)
  }

  /**
   * 今日饮食分析 —— **走模型的真提问**，不是模板句。
   *
   * 原实现是把 kcal / 蛋白质缺口 / 钠 / 纤维拼成三行固定字符串，不调模型。
   * 它有两个问题：① 与营养子页、主页状态条展示的是同一份数据，点它只是把
   * 已经在屏幕上的数字重念一遍；② 建议是死的（「可以来一份鸡胸肉、鸡蛋或酸奶」
   * 对每个人都一样），也不知道用户今天到底吃了什么。
   *
   * 现在只发一句话，让模型自己用 list_meals / search_food 查今天吃了什么、
   * 再结合目标给建议 —— 它能看到真实条目，也能追问「那晚饭换成什么好」。
   */
  async function analyzeToday(): Promise<void> {
    if (busy.value) return
    await sendText(`看看我今天的饮食摄入，分析一下结构和问题，并给出明天可以怎么调整的建议。`)
  }

  /** 自然语言 → 目标调整建议（仅生成待确认方案；失败时抛错由页面提示） */
  async function requestTargetAdjust(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean || busy.value) return
    const n = useNutritionStore()
    if (!n.profile) await n.loadProfile()
    if (!n.profile) throw new Error('profile 不可用')
    busy.value = true
    try {
      targetProposal.value = await aiService.parseTargetAdjust(clean, n.profile.targets)
    } finally {
      busy.value = false
    }
  }

  /** 目标建议的变更摘要（一行，给模型看）：热量 1900 → 1800 大卡、蛋白质 110 → 130 g */
  function targetChangeText(p: TargetAdjustProposal): string {
    const parts = p.changes
      .slice(0, 4)
      .map((c) => `${c.label} ${Math.round(c.from)} → ${Math.round(c.to)}${c.unit}`)
    return `${parts.join('、')}${p.changes.length > 4 ? ` 等 ${p.changes.length} 项` : ''}`
  }

  /** 确认采用 AI 建议的新目标（跨域联动：经 nutrition store 落库并刷新） */
  async function applyTargetProposal(): Promise<void> {
    const p = targetProposal.value
    if (!p) return
    await useNutritionStore().saveTargets(p.targets)
    // 目标值本身模型自己查得到，查不到的是「这是刚采纳的 AI 建议」这条因果
    recordCardOutcome('target-adjust', `采用了 AI 目标调整建议 —— ${targetChangeText(p)}`)
    targetProposal.value = null
  }

  function dismissTargetProposal(): void {
    const p = targetProposal.value
    // 只有真的改动了目标才值得记一条；无变更的「知道了」是纯噪音
    if (p?.changes.length) recordCardOutcome('target-adjust', '放弃了 AI 目标调整建议 —— 目标未改动')
    targetProposal.value = null
  }

  return {
    messages,
    busy,
    chatId,
    chats,
    targetProposal,
    /** 流式渲染状态（AIPage 用：过程段 / 思考计时 / 流式指针） */
    streamingBubbleId: agg.streamingBubbleId,
    streamSeq,
    getMeta: agg.getMeta,
    init,
    greet,
    /** 别的页面递进来的一句话（抢课面板的「交给 AI 排查」） */
    askFrom,
    takePendingPrompt,
    /** 别的页面递进来的一段草稿（底栏快捷输入的「+」，只填不发） */
    handOffDraft,
    takePendingDraft,
    selectChat,
    newChat,
    clearContext,
    /** 知识库页改过记忆后调它，让下一轮的认知注入立刻反映改动而不是等 TTL 过期 */
    invalidateCognitionCache,
    retract,
    sendText,
    sendVoiceTurn,
    commitParse,
    commitParsedItems,
    analyzeToday,
    requestTargetAdjust,
    applyTargetProposal,
    dismissTargetProposal,
  }
})
