/**
 * Dream：离线记忆维护的前端编排（方案 §6.5）。
 *
 * 分工：**模型调用与提示词只在前端**；Rust 的 `memory_dream_*` 只做门控、上下文、事务化 apply。
 * 本模块负责：
 * 1. 3 小时冷却（客户端兜底；服务端 `memory_dream_runs.finished_at` 才是权威）；
 * 2. 最小素材门控（≥1 会话且 ≥5 条新消息；Rust gate 已算，前端复核一次）；
 * 3. 使用 `memory_dream_begin` 返回的素材（最近会话 ≤8 / 消息 ≤200 / 分片样本 ≤40 / 重复对 ≤20）；
 * 4. 调模型产出四类结构化动作，校验/截断后交给 `memory_dream_apply`；
 * 5. 成功或失败都收敛 run（失败走 `memory_dream_cancel`），绝不把异常抛给对话 UI。
 *
 * 纪律：
 * - Dream 没有 `mark_important` 权限：解析层直接丢弃；Rust 侧还会以 `dream_action_forbidden` 拒绝。
 * - 模型返回非法 JSON 时**仍然**调用 `apply(runId, [])` 结束 run，避免 3 小时冷却前反复触发；
 * - 没有模型时直接跳过：不调 begin、不产生 run 行。
 */

import type {
  AiModel,
  DreamAction,
  DreamBeginResult,
  DreamContext,
  KbMemoryType,
} from '@/types'
import { kbService } from '@/services/kbService'
import { useModelsStore } from '@/stores/models'
import { useToast } from '@/composables/useToast'
import { extractJsonObject, lastAssistantText } from './json'
import { RustAgent } from './rustAgent'

/** 与服务端 `DREAM_COOLDOWN_HOURS` 一致；客户端只做兜底，权威冷却在 Rust。 */
export const DREAM_COOLDOWN_HOURS = 3
/** 与服务端 `DREAM_MIN_SESSIONS` 一致。 */
export const DREAM_MIN_SESSIONS = 1
/** 与服务端 `DREAM_MIN_MESSAGES` 一致。 */
export const DREAM_MIN_MESSAGES = 5
/** 与服务端 `DREAM_MAX_ACTIONS` 一致。 */
export const DREAM_MAX_ACTIONS = 12
/** 与服务端 `SHARD_MAX_CHARS` 一致。 */
export const DREAM_MAX_CONTENT_CHARS = 1800
/** 上一次 Dream 尝试时间的本地兜底键（权威时间在 `memory_dream_runs`）。 */
const LAST_DREAM_KEY = 'rein.memory.dream.lastAt'

const MEMORY_TYPES: KbMemoryType[] = [
  'preference',
  'constraint',
  'event',
  'entity',
  'profile',
  'pattern',
]

/** 前端解析 Dream 动作时用于校验 id 的允许集合；缺省表示不校验（仍然由 Rust 兜底）。 */
export type DreamShardIdSet = ReadonlySet<number>

export interface DreamOutcome {
  skipped: 'no_model' | 'gate' | 'error' | null
  runId?: string
  /** created + superseded + consolidated + revived */
  changes: number
  reason?: string
}

// ---------------------------------------------------------------------------
// 冷却（客户端兜底）
// ---------------------------------------------------------------------------

function readLastDreamAttempt(): number {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_DREAM_KEY)
    const ms = raw ? Number(raw) : 0
    return Number.isFinite(ms) ? ms : 0
  } catch {
    return 0
  }
}

function markDreamAttempt(at = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(LAST_DREAM_KEY, String(at))
  } catch {
    // localStorage 不可用（隐私模式/测试环境）时只影响客户端节流，不影响 Dream 本身
  }
}

/** 客户端冷却是否已过；`force` 永远返回 true。 */
export function dreamCooldownElapsed(now = Date.now(), force = false): boolean {
  if (force) return true
  const last = readLastDreamAttempt()
  return !last || now - last >= DREAM_COOLDOWN_HOURS * 60 * 60 * 1000
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function systemPrompt(): string {
  return `你是 Rein 健康应用的长期记忆「离线维护者」。你只做四类维护，不采集新情报：

1. supersede：某条旧记忆被新事实取代 → 新建一条修订版，旧条目会被归档。
2. consolidate：多条记忆在说同一件事（措辞不同、跨会话重复）→ 合并成一条更完整、更准确的表述。
3. digest：把一段时间的零散事件提炼成一条跨会话的阶段性摘要（带趋势/结论，不是流水账）。
4. revive：某条已休眠（dormant）的记忆仍然有长期价值 → 把它救回 active。

硬约束（违反任何一条，整批会被服务端回滚）：
- 不许发明上下文里没有的事实，不许把两条不相干的信息拼成一条。
- 只能用【长期记忆样本】里出现过的 id；consolidate 至少 2 条；不许处理 archived 条目（revive 也只接受 dormant）。
- 不许 mark_important、不许删除/归档、不许写不在四类里的动作。
- 拿不准就保持原样；没有值得做的维护时输出 {"actions":[]}，这是完全正常的输出。
- content 是一句完整、自洽、脱离对话也能读懂的中文；不要写「用户说」「助手提到」这类转述壳子；单条不超过 ${DREAM_MAX_CONTENT_CHARS} 字。

只输出一个 JSON 对象，不要 markdown 代码块、不要解释：
{"actions":[
  {"type":"supersede","oldShardId":3,"content":"...","memType":"constraint","topic":"膝盖","category":"健康/训练","reason":"newer_fact"},
  {"type":"consolidate","shardIds":[4,9],"content":"...","memType":"pattern","topic":"训练时间","category":"健康/训练","reason":"duplicate"},
  {"type":"digest","content":"...","topic":"睡眠","category":"生活/作息"},
  {"type":"revive","shardId":11,"reason":"still_relevant"}
]}`
}

function userPrompt(context: DreamContext | null): string {
  if (!context) return '【素材】没有可用上下文。请输出 {"actions":[]}。'

  const sessions = context.sessions.map((s) => ({
    chatId: s.chatId,
    title: s.title,
    updatedAt: s.updatedAt,
    messages: s.messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      role: m.role,
      kind: m.kind,
      text: m.text,
    })),
  }))
  const shards = context.shards.map((s) => ({
    id: s.id,
    content: s.content,
    memType: s.memType,
    topic: s.topic,
    category: s.category,
    origin: s.origin,
    state: s.state,
    stability: Number(s.stability.toFixed(2)),
    effectiveWeight: Number(s.effectiveWeight.toFixed(3)),
    updatedAt: s.updatedAt,
  }))
  const duplicates = context.duplicatePairs.map((d) => ({
    aId: d.aId,
    bId: d.bId,
    score: Number(d.score.toFixed(3)),
  }))

  return [
    `【窗口】${context.since ?? '首次 Dream'} 之后；共 ${context.totalSessions} 个会话 / ${context.totalMessages} 条消息。`,
    `【最近会话】\n${JSON.stringify(sessions)}`,
    `【长期记忆样本】（state=dormant 可 revive；archived 不在样本里）\n${JSON.stringify(shards)}`,
    duplicates.length
      ? `【疑似重复对（本地向量算出，重点核对；向量也会错，拿不准就别动）】\n${JSON.stringify(duplicates)}`
      : '【疑似重复对】没有向量提示（无 embedding 或样本不足），请只依据正文判断。',
    '请输出维护动作 JSON。',
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// 动作解析
// ---------------------------------------------------------------------------

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return [...value.trim()].slice(0, max).join('')
}

function integer(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

function memoryType(value: unknown): KbMemoryType | undefined {
  return MEMORY_TYPES.includes(value as KbMemoryType) ? (value as KbMemoryType) : undefined
}

function commonFields(o: Record<string, unknown>): {
  memType?: KbMemoryType
  topic?: string
  category?: string
  reason?: string
} {
  const memType = memoryType(o.memType)
  const topic = text(o.topic, 40)
  const category = text(o.category, 40)
  const reason = text(o.reason, 200)
  return {
    ...(memType ? { memType } : {}),
    ...(topic ? { topic } : {}),
    ...(category ? { category } : {}),
    ...(reason ? { reason } : {}),
  }
}

/**
 * 把模型输出收敛成合法的 `DreamAction[]`：
 * - 只接受 supersede / consolidate / digest / revive；`mark_important` 与未知 type 直接丢弃；
 * - 最多 12 条；content 截断到 1800 字；
 * - `oldShardId` / `shardIds` 必须是上下文里出现过的 id（传了 allowedIds 时）。
 */
export function toDreamActions(raw: string, allowedIds?: DreamShardIdSet): DreamAction[] {
  const parsed = extractJsonObject(raw) as { actions?: unknown }
  if (!Array.isArray(parsed.actions)) return []

  const out: DreamAction[] = []
  for (const item of parsed.actions) {
    if (out.length >= DREAM_MAX_ACTIONS) break
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const type = String(o.type ?? '')
    const content = text(o.content, DREAM_MAX_CONTENT_CHARS)
    const allowed = (id: number) => !allowedIds || allowedIds.has(id)

    if (type === 'supersede') {
      const oldShardId = integer(o.oldShardId)
      if (oldShardId === null || !allowed(oldShardId) || !content) continue
      out.push({
        type: 'supersede',
        oldShardId,
        content,
        ...commonFields(o),
      })
      continue
    }

    if (type === 'consolidate') {
      if (!Array.isArray(o.shardIds)) continue
      const ids: number[] = []
      for (const rawId of o.shardIds) {
        const id = integer(rawId)
        if (id === null || ids.includes(id)) continue
        if (!allowed(id)) continue
        ids.push(id)
      }
      if (ids.length < 2 || !content) continue
      out.push({
        type: 'consolidate',
        shardIds: ids,
        content,
        ...commonFields(o),
      })
      continue
    }

    if (type === 'digest') {
      if (!content) continue
      const fields = commonFields(o)
      out.push({
        type: 'digest',
        content,
        ...(fields.topic ? { topic: fields.topic } : {}),
        ...(fields.category ? { category: fields.category } : {}),
      })
      continue
    }

    if (type === 'revive') {
      const shardId = integer(o.shardId)
      if (shardId === null || !allowed(shardId)) continue
      const reason = text(o.reason, 200)
      out.push({ type: 'revive', shardId, ...(reason ? { reason } : {}) })
      continue
    }

    // mark_important / 未知 type：Dream 没有权限，丢弃。
  }
  return out
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

async function askDreamModel(config: AiModel, context: DreamContext | null): Promise<string> {
  const agent = new RustAgent({
    initialState: {
      systemPrompt: systemPrompt(),
      modelPk: config.id,
      thinkingLevel: 'off',
      // 维护是纯文本变形，不需要任何工具；挂工具反而会诱使模型去查数据。
      tools: [],
      messages: [],
    },
  })
  await agent.prompt(userPrompt(context), undefined)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
  return lastAssistantText(agent.state.messages) ?? ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function cancelQuietly(runId: string, reason: string): Promise<void> {
  await kbService.memoryDreamCancel(runId, reason).catch(() => {})
}

/**
 * 跑一次 Dream。失败不抛出；调用方可以完全不处理返回值。
 *
 * 返回 `skipped='no_model'` 时不产生 run 行；`skipped='gate'` 时 `reason` 是
 * `cooldown` / `insufficient_material` / `running` / `disabled` / `no_material`。
 */
export async function runMemoryDream(opts: { force?: boolean } = {}): Promise<DreamOutcome> {
  const force = opts.force ?? false

  // 1. 无模型：直接跳过，不 begin、不产生 run。
  const models = useModelsStore()
  try {
    if (!models.loaded) await models.load()
  } catch (error) {
    return { skipped: 'no_model', changes: 0, reason: messageOf(error) }
  }
  const config = models.defaultModel()
  if (!config) return { skipped: 'no_model', changes: 0, reason: '未配置模型' }

  // 2. 客户端 3 小时冷却（服务端 gate 仍会再判一次）。
  if (!dreamCooldownElapsed(Date.now(), force)) {
    return { skipped: 'gate', changes: 0, reason: 'cooldown' }
  }

  let begin: DreamBeginResult
  try {
    begin = await kbService.memoryDreamBegin(force)
  } catch (error) {
    return { skipped: 'error', changes: 0, reason: messageOf(error) }
  }

  const runId = begin.runId
  if (!runId) {
    return { skipped: 'gate', changes: 0, reason: begin.gate.reason }
  }
  // 从这一刻起失败要显式 cancel，否则 run 会挂到 lease 超时。
  markDreamAttempt()

  // 3. 最小素材复核：服务端已经算过，这里再挡一次（force 也不跳过）。
  if (
    begin.gate.sessionsSince < DREAM_MIN_SESSIONS ||
    begin.gate.messagesSince < DREAM_MIN_MESSAGES
  ) {
    await cancelQuietly(runId, 'insufficient_material')
    return { skipped: 'gate', runId, changes: 0, reason: 'insufficient_material' }
  }

  try {
    // 4. 模型产出 → 校验；非法 JSON 也要用空动作结束 run。
    const raw = await askDreamModel(config, begin.context)
    const allowedIds = begin.context
      ? new Set(begin.context.shards.map((s) => s.id))
      : undefined
    const actions = raw ? toDreamActions(raw, allowedIds) : []

    // 5. 落库：整批一个事务；成功即 done。
    const applied = await kbService.memoryDreamApply(runId, actions)
    markDreamAttempt()
    const changes =
      applied.created + applied.superseded + applied.consolidated + applied.revived
    if (force && changes > 0) {
      useToast().toast(`已整理 ${changes} 处记忆`)
    }
    return { skipped: null, runId, changes }
  } catch (error) {
    const reason = messageOf(error)
    await cancelQuietly(runId, reason)
    return { skipped: 'error', runId, changes: 0, reason }
  }
}
