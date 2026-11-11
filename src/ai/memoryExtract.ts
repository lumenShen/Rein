/**
 * 长期记忆抽取：会话结束时，把「本轮对话 + 现有记忆分片」交给模型，
 * 一次调用同时完成**抽取与去重合并**，产出 `ShardWriteAction[]`。
 *
 * 为什么编排在前端：模型请求由 WebView 里的 pi-ai 直连 provider，Rust 不调模型；
 * Rust 侧只负责落库（`memory_shard_apply`，origin='manual_write'）。
 *
 * 与 Dream 的分工（方案 §6.6）：
 * - 抽取是「会话结束时往库里增量写」，只看得到最近一段对话；
 * - 整库去噪/合并/摘要由 Dream（`memoryDream.ts`）负责，本文件不再做整库整理。
 *
 * 边界：只允许改 `origin in ('manual_write','marked_important')` 的分片；
 * `conversation` 分片只作为背景，不能 update/delete/archive（否则会把低置信对话
 * 当成长期记忆改写）。需要把对话里的信息沉淀下来时用 `add` 新建 manual_write。
 */

import type { AiModel, KbMemoryType, MemoryShard, ShardWriteAction } from '@/types'
import type { ChatTurn } from './chat'
import { extractJsonObject, lastAssistantText } from './json'
import { RustAgent } from './rustAgent'

/** 单次抽取允许的最大变更条数。防止模型把整段对话逐句复述成记忆。 */
const MAX_OPS = 8
/** 单条内容硬上限；与服务端 `SHARD_MAX_CHARS` 一致。 */
const MAX_CONTENT = 1800
/** 现有记忆清单的条数上限：库变大后不能让 prompt 无限膨胀。 */
const MAX_EXISTING_IN_PROMPT = 120

const MEMORY_TYPES: KbMemoryType[] = [
  'preference',
  'constraint',
  'event',
  'entity',
  'profile',
  'pattern',
]

/** 只有这两类来源允许被抽取路径改写；conversation/dream_summary 只读。 */
const EDITABLE_ORIGINS = new Set(['manual_write', 'marked_important'])

function systemPrompt(): string {
  return `你是 Rein 健康应用的长期记忆整理器。任务：从一段刚结束的对话里提炼**值得长期记住的、关于用户本人的稳定信息**，并与现有记忆合并。

只记录这些类型：
- preference 偏好：喜欢/讨厌、习惯性选择（「不喜欢香菜」「偏好早上训练」）
- constraint 约束：伤病、禁忌、硬性时间限制（「膝盖不适，深蹲不宜超过 60kg」「工作日 19 点前没空」）
- event 事件：发生过的、**带原因或结论**的事（「因为膝盖不适，把深蹲换成了腿举」）
- entity 实体：反复出现的人、地点、器械、课程名称
- profile 稳定画像：作息、经验水平、身体基础（「健身两年，能独立完成引体向上」）
- pattern 规律：反复出现的行为模式（「每周三、周六练腿」）

**不要记录**：一次性的任务内容（那已经在应用数据里）、临时状态（「今天有点累」）、
对话里的寒暄与助手说的话、用户没表达过的推测。
**宁缺毋滥**：一条都提炼不出来就返回空数组，这是完全正常的输出。

合并规则（重要）：
- 新信息与某条现有记忆是同一件事 → 用 update 并带上那条的 id，把内容改写成合并后的完整表述
- 新信息与现有记忆矛盾 → 用 update 带上 id，以用户本次说法为准
- 用户明确表示某条不再成立 → 用 delete 带上 id
- 与现有记忆完全重复 → 什么都不要输出
- 确实是全新的信息 → 用 add
- 现有记忆里标了 [已归档] 的 manual/marked 条目：这次又被提到就 update 复活它；没被提到就不要管

**可改范围**：只有标为 manual_write / marked_important 的条目允许 update / delete / archive。
标为 conversation 的条目是「近期对话派生」的临时背景，**禁止**修改、删除或归档；
需要把对话里的信息沉淀成长记忆时，用 add 新建一条 manual_write。

分类：每条带一个 category，用 1~2 层「大类/小类」路径，如 健康/训练、饮食/禁忌、生活/作息；
优先复用现有记忆里已经出现的分类，别造同义的新分类；实在拿不准就留空字符串。

内容写法：一句话、完整、自洽、脱离对话上下文也能读懂；不要写「用户说」「他提到」这类转述壳子；
单条不超过 60 个字。

**权限**：你没有 mark_important 权限，不要输出该操作。

只输出一个 JSON 对象，不要 markdown 代码块、不要解释：
{"ops":[{"op":"add","memType":"constraint","topic":"膝盖","category":"健康/训练","content":"膝盖不适，深蹲不宜超过 60kg","confidence":0.9}]}
update 与 delete/archive 必须带 "id"；update 可以只带要改的字段。没有可记的就输出 {"ops":[]}。`
}

function rank(m: MemoryShard): number {
  // 可编辑的、活跃的排前面；归档排最后。
  const editable = EDITABLE_ORIGINS.has(m.origin) ? 0 : 2
  const state = m.state === 'active' ? 0 : m.state === 'dormant' ? 1 : 2
  return editable + state
}

function userPrompt(turns: ChatTurn[], existing: MemoryShard[]): string {
  const convo = turns
    .filter((t) => t.text.trim())
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text.trim().slice(0, 1500)}`)
    .join('\n')

  const ordered = [...existing].sort((a, b) => rank(a) - rank(b))
  const mem = ordered.length
    ? ordered
        .slice(0, MAX_EXISTING_IN_PROMPT)
        .map((m) => {
          const flags = [
            m.origin === 'conversation' ? '[仅背景]' : '',
            m.state === 'archived' ? '[已归档]' : '',
          ]
            .filter(Boolean)
            .join('')
          return (
            `id=${m.id} [${m.origin}]${flags} [${m.memType}]` +
            `${m.topic ? `(${m.topic})` : ''}${m.category ? `{${m.category}}` : ''} ` +
            m.content.slice(0, 300)
          )
        })
        .join('\n')
    : '（暂无）'

  return `【现有记忆分片】\n${mem}\n\n【刚结束的对话】\n${convo}\n\n请输出 JSON。`
}

function textOf(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return [...value.trim()].slice(0, max).join('')
}

function idOf(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

function memTypeOf(value: unknown): KbMemoryType {
  return MEMORY_TYPES.includes(value as KbMemoryType)
    ? (value as KbMemoryType)
    : 'preference'
}

function confidenceOf(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : undefined
}

/**
 * 校验并收敛模型输出：抽 JSON、最多 `maxOps` 条、丢弃形状不对的条目。
 *
 * - `add`：content 必填；id 由服务端分配。
 * - `update`：必须带存在且可编辑的 id；content/topic/category/memType 至少改一项。
 * - `delete` / `archive`：必须带存在且可编辑的 id。
 * - 未知 op（包括 `mark_important`）直接丢弃。
 */
export function toShardActions(
  raw: string,
  existing: MemoryShard[],
  maxOps = MAX_OPS,
): ShardWriteAction[] {
  const parsed = extractJsonObject(raw) as { ops?: unknown }
  if (!Array.isArray(parsed.ops)) return []

  const byId = new Map(existing.map((m) => [m.id, m]))
  const editable = (id: number): boolean => {
    const m = byId.get(id)
    return !!m && EDITABLE_ORIGINS.has(m.origin)
  }

  const out: ShardWriteAction[] = []
  for (const item of parsed.ops) {
    if (out.length >= maxOps) break
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const op = String(o.op ?? '')

    if (op === 'delete' || op === 'archive') {
      const id = idOf(o.id)
      if (id === null || !editable(id)) continue
      if (op === 'delete') {
        out.push({ op: 'delete', id })
      } else {
        const reason = textOf(o.reason, 40)
        out.push({ op: 'archive', id, ...(reason ? { reason } : {}) })
      }
      continue
    }

    if (op === 'update') {
      const id = idOf(o.id)
      if (id === null || !editable(id)) continue
      const content = textOf(o.content, MAX_CONTENT)
      const topic = textOf(o.topic, 40)
      const category = textOf(o.category, 40)
      const memType = MEMORY_TYPES.includes(o.memType as KbMemoryType)
        ? (o.memType as KbMemoryType)
        : undefined
      // 什么都没改的 update 没有意义，丢弃而不是制造空写。
      if (!content && !topic && !category && !memType) continue
      const action: ShardWriteAction = { op: 'update', id }
      if (content) action.content = content
      if (topic) action.topic = topic
      if (category) action.category = category
      if (memType) action.memType = memType
      const confidence = confidenceOf(o.confidence)
      if (confidence !== undefined) action.confidence = confidence
      out.push(action)
      continue
    }

    if (op === 'add') {
      const content = textOf(o.content, MAX_CONTENT)
      if (!content) continue
      const topic = textOf(o.topic, 40)
      const category = textOf(o.category, 40)
      const action: ShardWriteAction = {
        op: 'add',
        memType: memTypeOf(o.memType),
        content,
      }
      if (topic) action.topic = topic
      if (category) action.category = category
      const confidence = confidenceOf(o.confidence)
      if (confidence !== undefined) action.confidence = confidence
      out.push(action)
      continue
    }
    // mark_important / 未知 op：丢弃
  }
  return out
}

export interface ExtractMemoriesInput {
  config: AiModel
  /** 本次会话的可见轮次（通常取最近若干条） */
  turns: ChatTurn[]
  /** 现有记忆分片；调用方应只传 curated（含归档），conversation 仅作背景 */
  existing: MemoryShard[]
}

/**
 * 跑一次记忆抽取。失败不应影响对话，所以调用方要吞掉异常（见 stores/ai.ts）。
 * 轮次太少或没有用户发言时直接跳过，省掉一次无意义的模型调用。
 */
export async function extractMemories(
  input: ExtractMemoriesInput,
): Promise<ShardWriteAction[]> {
  const userTurns = input.turns.filter((t) => t.role === 'user' && t.text.trim())
  if (userTurns.length === 0) return []

  const agent = new RustAgent({
    initialState: {
      systemPrompt: systemPrompt(),
      modelPk: input.config.id,
      thinkingLevel: 'off',
      // 抽取是纯文本变形，不需要任何工具；挂工具反而会诱使模型去查数据
      tools: [],
      messages: [],
    },
  })

  await agent.prompt(userPrompt(input.turns, input.existing), undefined)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  if (!raw) return []
  try {
    return toShardActions(raw, input.existing)
  } catch {
    // 模型偶尔会返回非 JSON；抽取失败静默，不写任何分片。
    return []
  }
}

/** 与 Rust 侧 MEMORY_TYPES 对应的中文标签，供 UI 展示。 */
export const MEMORY_TYPE_LABELS: Record<KbMemoryType, string> = {
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  entity: '实体',
  profile: '画像',
  pattern: '规律',
}
