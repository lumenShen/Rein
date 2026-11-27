/**
 * 智能排程：把「未安排池」里的待办放进当天空档。
 *
 * - 无模型 / 模型失败：启发式（优先级高、时长短的先进第一个装得下的空档）；
 * - 有模型：单轮 pi-agent，读取 busy/now/priority 上下文给出槽位与理由，
 *   前端逐条校验（不重叠、装得下、不越界），非法项回落启发式。
 *
 * 遵守 L2 契约：只产出"建议槽位"，落库前必须经用户确认。
 */

import type { AiModel, Todo } from '@/types'
import { minToHHmm } from '@/utils/date'
import { busyIntervals, freeGaps, overlaps, SCHEDULE_BUFFER, type Interval } from '@/utils/schedule'
import { extractJsonObject, lastAssistantText } from './json'
import { jsonArrayItems } from './streamExtract'
import { RustAgent } from './rustAgent'

export interface Placement {
  id: number
  startMin: number
}

export interface ScheduleResult {
  placements: Placement[]
  /** 未能安排的待办 id */
  unplaced: number[]
  /** 一句话依据 */
  reason: string
  source: 'ai' | 'heuristic'
}

/** 排程 horizon：最晚排到 22:00 */
const UNTIL_MIN = 22 * 60

/**
 * 启发式：按 优先级降序 → 时长升序 逐条放进"装得下的最早空档"。
 * busyTodos = 该日已排程的待办（占用来源），与 pool 无交集。
 */
export function heuristicSchedule(
  pool: Todo[],
  busyTodos: Todo[],
  date: string,
  fromMin: number,
): ScheduleResult {
  if (!pool.length) return { placements: [], unplaced: [], reason: '池子里没有待安排的事项', source: 'heuristic' }
  const gaps = freeGaps(busyIntervals(busyTodos, date), fromMin, UNTIL_MIN)
  const cursors = gaps.map((g) => g.start)
  const placements: Placement[] = []
  const unplaced: number[] = []
  const sorted = [...pool].sort(
    (a, b) => b.priority - a.priority || (a.durationMin ?? 30) - (b.durationMin ?? 30),
  )
  for (const t of sorted) {
    const dur = t.durationMin ?? 30
    let at: number | null = null
    for (let i = 0; i < gaps.length; i++) {
      const start = cursors[i]!
      if (start + dur <= gaps[i]!.end) {
        at = start
        cursors[i] = start + dur + SCHEDULE_BUFFER
        break
      }
    }
    if (at == null) unplaced.push(t.id)
    else placements.push({ id: t.id, startMin: at })
  }
  return { placements, unplaced, reason: '按优先级与时长顺序放入最早的空档', source: 'heuristic' }
}

function systemPrompt(date: string, nowLine: string, busyLine: string, poolLine: string): string {
  return `你是 Rein 的日程排程助手。用户在 ${date} 有一批"想做但还没定时间"的待办，请把它们放进当天的空闲时段。
当前时间：${nowLine}。已占用时段：${busyLine || '无'}。排程最晚到 22:00，不要排在过去。
待办清单（id|标题|预计分钟|重要程度0-2）：${poolLine || '无'}
排程原则：重要紧急的优先占精力好的空档（上午 9-11 点通常最好）；短任务见缝插针；同类任务相邻；不要产生任何重叠，每条之间留 5 分钟缓冲。
只能输出一个 JSON 对象（不要 markdown、不要解释）：
{"placements":[{"id":待办id,"startMin":距00:00的分钟数}],"reason":"一句话中文依据，说明你如何权衡了时间与优先级"}`
}

interface RawPlacement {
  id: number
  startMin: number
}

/** AI 排程：模型必须已配置。校验失败的项会进 unplaced / 回落启发式。
 * onProgress 可选：流式回传已排条数（输出逐条完整即计一次）。 */
export async function aiSchedule(
  config: AiModel,
  pool: Todo[],
  busyTodos: Todo[],
  date: string,
  fromMin: number,
  onProgress?: (placed: number, total: number) => void,
): Promise<ScheduleResult> {
  if (!pool.length) {
    return { placements: [], unplaced: [], reason: '池子里没有待安排的事项', source: 'ai' }
  }
  const busy = busyIntervals(busyTodos, date)
  // 空数组 join 出来是空串（不是 null），`?? '无'` 永远不会兜底 ——
  // 「整天没安排」时提示词里传过去的是一片空白。这里显式判空。
  const busyLine = busy.length
    ? busy
        .map((b) => `${minToHHmm(b.start)}-${minToHHmm(b.end)}${b.title ? ` ${b.title}` : ''}`)
        .join('、')
    : '无'
  const poolLine = pool.map((t) => `${t.id}|${t.title}|${t.durationMin ?? 30}|${t.priority}`).join('；')

  const agent = new RustAgent({
    initialState: {
      systemPrompt: systemPrompt(date, minToHHmm(fromMin), busyLine ?? '无', poolLine),
      modelPk: config.id,
      thinkingLevel: 'off',
      tools: [],
      messages: [],
    },
  })

  if (onProgress) {
    let acc = ''
    agent.subscribe((e) => {
      if (e.type !== 'message_update') return
      const ev = e.assistantMessageEvent
      if (ev.type !== 'text_delta') return
      acc += ev.delta
      onProgress(jsonArrayItems(acc, 'placements').length, pool.length)
    })
  }

  await agent.prompt('请给出今天的排程建议。')
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  const body = extractJsonObject(raw) as
    | { placements?: RawPlacement[]; reason?: string }
    | null
  if (!body || !Array.isArray(body.placements)) throw new Error('模型未返回有效排程')

  // 逐条校验：id 合法、不与已占用/已排项重叠、装得下、不越界
  const poolById = new Map(pool.map((t) => [t.id, t]))
  const occupied: Interval[] = [...busy]
  const placements: Placement[] = []
  const unplaced: number[] = []
  for (const p of body.placements) {
    const t = poolById.get(p.id)
    if (!t) continue
    const dur = t.durationMin ?? 30
    const slot = { start: p.startMin, end: p.startMin + dur }
    const valid =
      Number.isFinite(p.startMin) &&
      p.startMin >= fromMin - 30 && // 容忍轻微过去时（刚发生）
      p.startMin + dur <= UNTIL_MIN &&
      !occupied.some((k) => overlaps(slot, k))
    if (!valid) {
      unplaced.push(t.id)
      continue
    }
    placements.push({ id: t.id, startMin: p.startMin })
    occupied.push({ start: slot.start - SCHEDULE_BUFFER, end: slot.end + SCHEDULE_BUFFER })
  }
  // 模型漏排的回落启发式：已接受的 AI 槽位也算占用，避免回落项覆盖它们。
  const missed = pool.filter((t) => !placements.some((p) => p.id === t.id) && !unplaced.includes(t.id))
  if (missed.length) {
    const acceptedAsBusy: Todo[] = placements.flatMap((p) => {
      const todo = poolById.get(p.id)
      return todo ? [{ ...todo, date, startMin: p.startMin }] : []
    })
    const rest = heuristicSchedule(missed, [...busyTodos, ...acceptedAsBusy], date, fromMin)
    placements.push(...rest.placements)
    unplaced.push(...rest.unplaced)
  }
  return { placements, unplaced, reason: body.reason?.trim() || '按时间与优先级权衡安排', source: 'ai' }
}

/** 统一入口：无模型 → 启发式；有模型 → AI（失败回落启发式并说明） */
export async function autoSchedule(
  pool: Todo[],
  busyTodos: Todo[],
  date: string,
  fromMin: number,
  config: AiModel | null,
  onProgress?: (placed: number, total: number) => void,
): Promise<ScheduleResult> {
  if (!config) return heuristicSchedule(pool, busyTodos, date, fromMin)
  try {
    return await aiSchedule(config, pool, busyTodos, date, fromMin, onProgress)
  } catch (e) {
    const r = heuristicSchedule(pool, busyTodos, date, fromMin)
    return { ...r, reason: `模型不可用（${(e as Error).message}），已按规则排程` }
  }
}
