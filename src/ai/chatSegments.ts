/**
 * chatSegments —— 聊天消息 → 「assistant 锚点回合」段。
 *
 * 段 = 一条 user 消息 + 其后连续的 assistant 消息，直到下一条 user；
 * 第一条 user 之前的 legacy assistant 归入最老的一段（以它自己开头）。
 * 这与 store 里 `restoreBubbleMetaFromHistory` 的分组边界一致：流程气泡不会跨 user 合并，
 * 因此按 user 切段后，跨页加载不会把同一条 assistant 回复拆到两段。
 *
 * 只做纯数据变换与**估算**：真实高度由渲染后的 ResizeObserver 实测回写
 * （见 components/ai/chat/useVirtualChat.ts）。估算只服务窗口外未测量的段。
 */

import type { AiMessage, AiMessageKind, ParsedFoodItem, ProcessSegment } from '@/types'

/**
 * 消息在分页后带上的两个扩展字段（D/E 域会加进 `AiMessage`）。
 * 这里用交叉类型而不是改 `types/ai.ts`：本域不拥有该文件，字段缺席时
 * `seq ?? 0` / `anchorId ?? null` 仍能安全降级。
 */
export type ChatMessage = AiMessage & {
  /** 会话内单调 seq（分页游标；旧数据缺失时为 undefined） */
  seq?: number
  /** 回合锚点（与 `MemoryShard.anchorMessageId` 同值） */
  anchorId?: string | null
}

export interface ChatSegment {
  /** 稳定 id：`seg:<段内首条可见消息 id>`（不随 anchor 移动而变） */
  id: string
  /** 段内 anchor；与 MemoryShard.anchorMessageId 同值 */
  anchorId: string | null
  startSeq: number
  endSeq: number
  /** 仅作元数据；v1 不渲染日期分隔条（避免新增行类型） */
  dayKey: string
  messages: ChatMessage[]
}

/** 段间距与消息间距保持一致（`.msg` 的 margin-bottom = --gap-sm = 8） */
const MSG_GAP = 8
/** 折叠后的过程区标题行高度（含热区） */
const PROCESS_HEAD_H = 28
/** ProcessSection 展开内容的最大高度（`.process-scroll { max-height: 320px }`） */
const PROCESS_BODY_MAX = 320
/** 正文行高（--lh-body 约 1.5 × 16） */
const TEXT_LINE_H = 24
/** 气泡内距：竖向 12 × 2 */
const BUBBLE_PAD_Y = 24
/** 单行文件卡的高度（ChatFileCard 的最小热区 + 间距） */
const FILE_CARD_H = 56

/**
 * 把**已按 showMsg 过滤**的可见消息按 user 边界切段。
 * 传入未过滤消息会让空壳/被吸收消息占一段高度，所以调用方必须先过滤。
 */
export function buildChatSegments(messages: readonly ChatMessage[]): ChatSegment[] {
  const segments: ChatSegment[] = []
  let current: ChatMessage[] = []

  const flush = (): void => {
    if (current.length === 0) return
    const first = current[0]!
    const last = current[current.length - 1]!
    // anchor：优先取消息自带的 anchor_id（与后端 segment 对齐）；
    // 旧数据没有该列时退化为段内最后一条 assistant —— 与分页/跳转的落点语义一致。
    let anchorId: string | null = null
    for (const m of current) {
      if (m.anchorId) {
        anchorId = m.anchorId
        break
      }
    }
    if (!anchorId) {
      for (let i = current.length - 1; i >= 0; i--) {
        if (current[i]!.role === 'assistant') {
          anchorId = current[i]!.id
          break
        }
      }
    }
    segments.push({
      id: `seg:${first.id}`,
      anchorId,
      startSeq: first.seq ?? 0,
      endSeq: last.seq ?? 0,
      dayKey: (first.at || '').slice(0, 10),
      messages: current,
    })
    current = []
  }

  for (const m of messages) {
    // assistant 永远跟随当前段（过程气泡、正文气泡、food 卡都属于同一回合）；
    // 只有 user 是回合边界。首条就是 assistant 时自然开一个 legacy 段。
    if (m.role === 'user' && current.length > 0) flush()
    current.push(m)
  }
  flush()
  return segments
}

/** 某条消息（可能被吸收/隐藏）落在哪一段；找不到返回 null。 */
export function segmentIdOfMessage(segments: readonly ChatSegment[], messageId: string): string | null {
  for (const seg of segments) {
    if (seg.anchorId === messageId) return seg.id
    if (seg.messages.some((m) => m.id === messageId)) return seg.id
  }
  return null
}

/** 段内找到某条消息（用于跳转时把消息滚进视口，而不只滚到段顶）。 */
export function segmentOfMessage(segments: readonly ChatSegment[], messageId: string): ChatSegment | null {
  return (
    segments.find((s) => s.messages.some((m) => m.id === messageId)) ??
    segments.find((s) => s.anchorId === messageId) ??
    null
  )
}

/**
 * 估算一段的高度（px）。只用于窗口外尚未测量过的段；
 * 视口内一旦挂载，ResizeObserver 的实测值会覆盖它。
 *
 * @param width       滚动容器的内容宽度（clientWidth 已含 padding 的近似值）
 * @param expandedIds 用户手动展开过过程区的消息 id；展开段按最多 320 估
 */
export function estimateSegmentHeight(
  segment: ChatSegment,
  width: number,
  expandedIds?: ReadonlySet<string>,
): number {
  const contentW = Math.max(240, width)
  const bubbleW = Math.min(contentW * 0.82, 720)
  // 中文正文按 16px 字宽保守估；英文更窄，估多不估少（多出来的一截由实测收敛）
  const charsPerLine = Math.max(8, Math.floor((bubbleW - 32) / 16))
  let h = 0
  for (const m of segment.messages) {
    h += estimateMessageHeight(m, contentW, charsPerLine, expandedIds) + MSG_GAP
  }
  return Math.max(32, Math.round(h))
}

function estimateMessageHeight(
  m: ChatMessage,
  contentW: number,
  charsPerLine: number,
  expandedIds?: ReadonlySet<string>,
): number {
  let h = 0

  // 过程区（推理 / 工具）在消息列顶部
  const segs: ProcessSegment[] = m.segments ?? []
  if (segs.length > 0) {
    h += PROCESS_HEAD_H + MSG_GAP
    if (expandedIds?.has(m.id)) {
      const toolCount = segs.filter((s) => s.kind === 'tool').length
      const reasoning = segs
        .filter((s): s is Extract<ProcessSegment, { kind: 'reasoning' }> => s.kind === 'reasoning')
        .map((s) => s.text)
        .join('\n')
      const body = reasoningHeight(reasoning, charsPerLine) + toolCount * 44 + 24
      h += Math.min(PROCESS_BODY_MAX, Math.max(48, body))
    }
  }

  if (m.quoteText) h += 36 + MSG_GAP

  switch (m.kind) {
    case 'photo': {
      const n = m.images?.length ?? (m.imageBase64 ? 1 : 0)
      h += photoGridHeight(n, contentW)
      if (m.text) h += textBubbleHeight(m.text, charsPerLine) + MSG_GAP
      break
    }
    case 'doc': {
      h += 66
      const n = m.images?.length ?? 0
      if (n > 0) h += photoGridHeight(n, contentW)
      if (m.text) h += textBubbleHeight(m.text, charsPerLine) + MSG_GAP
      break
    }
    case 'food-parse': {
      const items = m.items?.length ?? 0
      // 标题 + 条目行（约 48/行）+ 餐次/操作（未确认时）
      h += 24 + items * 48 + (m.committed ? 32 : 88) + 24
      break
    }
    case 'analysis': {
      h += 24 + textHeight(m.text ?? '', charsPerLine) + 24
      break
    }
    case 'voice': {
      h += 90
      break
    }
    case 'text': {
      if (m.text) h += textBubbleHeight(m.text, charsPerLine)
      else if (m.streaming) h += 48
      break
    }
    case 'tools': {
      // 内容已在过程区计入；没有过程段时它不会出现在可见消息里
      break
    }
    default:
      break
  }

  if (m.files?.length) h += m.files.length * FILE_CARD_H + MSG_GAP
  return Math.max(24, h)
}

function reasoningHeight(text: string, charsPerLine: number): number {
  if (!text) return 0
  // 推理文字在 320px 滚动区里字号更小，按 1.4 倍行距估
  return textHeight(text, charsPerLine) * 0.95
}

function textBubbleHeight(text: string, charsPerLine: number): number {
  return textHeight(text, charsPerLine) + BUBBLE_PAD_Y
}

function textHeight(text: string, charsPerLine: number): number {
  if (!text) return 0
  let lines = 0
  for (const raw of text.split('\n')) {
    lines += Math.max(1, Math.ceil(raw.length / charsPerLine))
  }
  return lines * TEXT_LINE_H
}

function photoGridHeight(count: number, contentW: number): number {
  if (count <= 0) return 0
  if (count === 1) return Math.min(220, Math.max(120, contentW * 0.74 * 0.75))
  const rows = Math.ceil(count / 2)
  return rows * 150 + Math.max(0, rows - 1) * 2
}

/* ---------- 记忆锚点（供抽取/回溯，不在本页渲染） ---------- */

export interface ChatMemoryAnchor {
  /** 与 MemoryShard.anchorMessageId 同值 */
  anchorId: string
  /** anchor 消息自身 id（通常等于 anchorId） */
  messageId: string
  text: string
  kind: AiMessageKind
  at: string
}

/**
 * 从已加载消息里提取可读的记忆锚点：assistant 文本型消息，按时间倒序去重。
 * 空文本 / 结构化食物卡不作为可读结论（与 shard 的 terminal 口径一致）。
 */
export function extractMemoryAnchors(messages: readonly ChatMessage[], limit = 20): ChatMemoryAnchor[] {
  const out: ChatMemoryAnchor[] = []
  const seen = new Set<string>()
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    if (m.kind !== 'text' && m.kind !== 'analysis') continue
    const text = (m.text ?? '').trim()
    if (!text) continue
    const anchorId = m.anchorId || m.id
    if (seen.has(anchorId)) continue
    seen.add(anchorId)
    out.push({ anchorId, messageId: m.id, text, kind: m.kind, at: m.at })
  }
  return out.reverse()
}

/** 供页面判断「这条消息是否需要计入高度」时复用（保持与模板分支同条件）。 */
export function messageHasRenderableBody(m: ChatMessage, meta: { segments?: ProcessSegment[]; absorbed?: boolean } | null): boolean {
  if (meta?.absorbed) return false
  if (meta?.segments?.length) return true
  if (m.quoteText) return true
  if (m.files?.length) return true
  switch (m.kind) {
    case 'text':
      return !!m.text || (!!m.streaming && !(meta?.segments?.length ?? 0))
    case 'photo':
      return !!(m.imageBase64 || m.images?.length)
    case 'doc':
      return !!m.doc
    case 'food-parse':
      return !!m.items?.length
    case 'tools':
      return false
    default:
      return true
  }
}

/** 食物卡条目在估算时的最小高度（供未来测试/调试直接断言）。 */
export const FOOD_ITEM_ROW_H = 48
export function parsedItemsCount(items: ParsedFoodItem[] | undefined): number {
  return items?.length ?? 0
}
