/**
 * 专注计划（纯函数）：把「有多少时间」翻译成「几颗番茄、末颗多长、几点结束」。
 *
 * 这里不碰 Pinia / localStorage / Date.now 以外的环境，输入全部显式传入 ——
 * 卡片、安排抽屉、单元测试共用同一份算法，避免三处各算一套。
 *
 * 几条口径：
 * · 整颗专注时长沿用设置；**只有最后一颗**可以按剩余时间缩短（≥10 分钟才补）；
 * · 休息至少 5 分钟；长休按「今日已完成轮次 + 计划内轮次」判定，与 store 的
 *   `breakMinForRounds` 同一口径；
 * · 「预计结束」= 最后一颗专注结束，不含收尾那次休息（休息可以不做）；
 * · 到点 / 智能共用 `scheduleRounds`；按颗数只排整颗，不压缩。
 */
import type { PomodoroSettings, Todo } from '@/types'

export type FocusPlanSource = 'smart' | 'until' | 'count'

export interface FocusPlanRound {
  /** 这一颗的专注分钟（最后一颗可能被缩短） */
  focusMin: number
  /** 这颗结束后进入的休息分钟；null = 计划到此结束（不再排休息） */
  breakAfterMin: number | null
  /** 这段休息是不是长休（只用于计划条的视觉区分） */
  longBreak: boolean
}

export interface FocusPlan {
  source: FocusPlanSource
  /** 整颗专注分钟（设置值） */
  focusMin: number
  /** 短休分钟（已按 ≥5 收敛） */
  breakMin: number
  rounds: FocusPlanRound[]
  totalFocusMin: number
  /** 含颗间休息的总分钟（不含收尾休息） */
  totalMin: number
  startAtMs: number
  /** 最后一颗专注结束时刻 */
  endAtMs: number
  /** 智能 / 到点的目标截止时刻；按颗数 / 兜底为 null */
  deadlineMs: number | null
  /** 智能覆盖 / 关联的待办 id */
  todoId: number | null
  /** 智能同时覆盖的其它待办 id（含 todoId） */
  coveredTodoIds: number[]
  /** 空档态「提前收手」分钟；其它情况 null */
  bufferMin: number | null
  /** 没有后续待办时的 4 颗兜底 */
  fallback: boolean
  /** 末颗被缩短的分钟；没有缩短为 null */
  lastFocusMin: number | null
}

export interface PlanContext {
  nowMs: number
  settings: PomodoroSettings
  /** 今日已完成的整轮（长休周期偏移） */
  roundsDone: number
}

export interface SmartPlanResult {
  plan: FocusPlan | null
  kind: 'ongoing' | 'gap' | 'fallback' | 'none'
  chosenTodo: Todo | null
  coveredTodos: Todo[]
  nextTodo: Todo | null
  bufferMin: number
  availableMin: number
  deadlineMs: number | null
}

const MIN_LAST_FOCUS_MIN = 10

/** 有效短休：至少 5 分钟（需求口径） */
export function effectiveBreakMin(settings: PomodoroSettings): number {
  return Math.max(5, Math.round(settings.breakMin))
}

/** 第 index 颗（1-based）之后该休多久；与 store 的 breakMinForRounds 同口径 */
export function breakAfterRound(
  roundsDone: number,
  index: number,
  settings: PomodoroSettings,
): { min: number; long: boolean } {
  const n = Math.max(1, Math.round(settings.roundsBeforeLongBreak))
  const long = (roundsDone + index) % n === 0
  const short = effectiveBreakMin(settings)
  const min = Math.max(5, Math.round(long ? settings.longBreakMin : short))
  return { min, long }
}

function buildPlan(
  rounds: FocusPlanRound[],
  ctx: PlanContext,
  source: FocusPlanSource,
  meta: Partial<Omit<FocusPlan, 'rounds' | 'totalFocusMin' | 'totalMin' | 'endAtMs' | 'source' | 'startAtMs'>>,
): FocusPlan | null {
  if (rounds.length === 0) return null
  const totalFocusMin = rounds.reduce((sum, r) => sum + r.focusMin, 0)
  const totalMin = rounds.reduce((sum, r) => sum + r.focusMin + (r.breakAfterMin ?? 0), 0)
  const last = rounds[rounds.length - 1]!
  return {
    source,
    focusMin: Math.round(ctx.settings.focusMin),
    breakMin: effectiveBreakMin(ctx.settings),
    rounds,
    totalFocusMin,
    totalMin,
    startAtMs: ctx.nowMs,
    endAtMs: ctx.nowMs + totalMin * 60_000,
    deadlineMs: null,
    todoId: null,
    coveredTodoIds: [],
    bufferMin: null,
    fallback: false,
    lastFocusMin: last.focusMin < Math.round(ctx.settings.focusMin) ? last.focusMin : null,
    ...meta,
  }
}

/**
 * 按可用分钟排整颗 + 可选的压缩末颗。
 * 返回的 rounds 里最后一颗的 breakAfterMin 恒为 null。
 */
export function scheduleRounds(
  availableMin: number,
  ctx: PlanContext,
): FocusPlanRound[] {
  const available = Math.floor(availableMin)
  if (available < MIN_LAST_FOCUS_MIN) return []
  const focus = Math.max(1, Math.round(ctx.settings.focusMin))
  const rounds: FocusPlanRound[] = []
  let used = 0
  let index = 0
  while (used + focus <= available) {
    index += 1
    used += focus
    const b = breakAfterRound(ctx.roundsDone, index, ctx.settings)
    const remaining = available - used
    // 还能再排一颗整颗（先休再专注）
    if (remaining >= b.min + focus) {
      rounds.push({ focusMin: focus, breakAfterMin: b.min, longBreak: b.long })
      used += b.min
      continue
    }
    // 排不下整颗，但休完之后还有 ≥10 分钟：补一颗缩短的末颗
    if (remaining >= b.min + MIN_LAST_FOCUS_MIN) {
      rounds.push({ focusMin: focus, breakAfterMin: b.min, longBreak: b.long })
      used += b.min
      const lastFocus = available - used
      rounds.push({ focusMin: lastFocus, breakAfterMin: null, longBreak: false })
      used += lastFocus
      break
    }
    // 这颗就是最后一颗，不再排收尾休息
    rounds.push({ focusMin: focus, breakAfterMin: null, longBreak: false })
    break
  }
  if (rounds.length === 0 && available >= MIN_LAST_FOCUS_MIN) {
    rounds.push({ focusMin: available, breakAfterMin: null, longBreak: false })
  }
  return rounds
}

/** 到点：按目标截止时刻排。 */
export function planUntil(
  ctx: PlanContext,
  deadlineMs: number,
): FocusPlan | null {
  const availableMin = Math.floor((deadlineMs - ctx.nowMs) / 60_000)
  if (availableMin < MIN_LAST_FOCUS_MIN) return null
  const rounds = scheduleRounds(availableMin, ctx)
  return buildPlan(rounds, ctx, 'until', { deadlineMs })
}

/** 按颗数：只排整颗，不压缩；结束时间跟着算。 */
export function planCount(
  ctx: PlanContext,
  count: number,
): FocusPlan | null {
  const n = Math.max(1, Math.min(24, Math.round(count)))
  const focus = Math.max(1, Math.round(ctx.settings.focusMin))
  const rounds: FocusPlanRound[] = []
  for (let i = 1; i <= n; i += 1) {
    const last = i === n
    const b = breakAfterRound(ctx.roundsDone, i, ctx.settings)
    rounds.push({
      focusMin: focus,
      breakAfterMin: last ? null : b.min,
      longBreak: !last && b.long,
    })
  }
  return buildPlan(rounds, ctx, 'count', {})
}

function minutesOfDay(ms: number): number {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

function startOfDayMs(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

interface TodoWindow {
  todo: Todo
  start: number
  end: number
}

function todoWindows(todos: Todo[]): TodoWindow[] {
  const out: TodoWindow[] = []
  for (const t of todos) {
    if (t.status === 'done') continue
    if (t.startMin == null || t.durationMin == null || t.durationMin <= 0) continue
    out.push({ todo: t, start: t.startMin, end: t.startMin + t.durationMin })
  }
  return out
}

/**
 * 智能：
 * · 有进行中的待办 → 按**最晚结束**的那条排到它结束；其余覆盖项如实返回；
 * · 没有进行中但有下一个 → 排到「下一个开始 − 提前收手」；
 * · 都没有 → 4 颗标准番茄兜底。
 */
export function resolveSmartPlan(
  ctx: PlanContext,
  todos: Todo[],
  bufferMin: number,
): SmartPlanResult {
  const nowMin = minutesOfDay(ctx.nowMs)
  const windows = todoWindows(todos)
  const buffer = Math.max(0, Math.round(bufferMin))
  const ongoing = windows
    .filter((w) => w.start <= nowMin && nowMin < w.end)
    .sort((a, b) => b.end - a.end)
  if (ongoing.length > 0) {
    const chosen = ongoing[0]!
    const deadlineMs = startOfDayMs(ctx.nowMs) + chosen.end * 60_000
    const availableMin = Math.floor((deadlineMs - ctx.nowMs) / 60_000)
    const rounds = scheduleRounds(availableMin, ctx)
    const plan = buildPlan(rounds, ctx, 'smart', {
      deadlineMs,
      todoId: chosen.todo.id,
      coveredTodoIds: ongoing.map((w) => w.todo.id),
      bufferMin: null,
    })
    return {
      plan,
      kind: 'ongoing',
      chosenTodo: chosen.todo,
      coveredTodos: ongoing.map((w) => w.todo),
      nextTodo: null,
      bufferMin: buffer,
      availableMin,
      deadlineMs,
    }
  }

  const next = windows
    .filter((w) => w.start > nowMin)
    .sort((a, b) => a.start - b.start)[0]
  if (next) {
    const deadlineMs = startOfDayMs(ctx.nowMs) + next.start * 60_000 - buffer * 60_000
    const availableMin = Math.floor((deadlineMs - ctx.nowMs) / 60_000)
    const rounds = scheduleRounds(availableMin, ctx)
    const plan = buildPlan(rounds, ctx, 'smart', {
      deadlineMs,
      bufferMin: buffer,
    })
    return {
      plan,
      kind: 'gap',
      chosenTodo: null,
      coveredTodos: [],
      nextTodo: next.todo,
      bufferMin: buffer,
      availableMin,
      deadlineMs,
    }
  }

  // 今天没有后续待办：4 颗兜底（不设 deadline，结束时间按 4 颗算）
  const plan = planCount(ctx, 4)
  if (plan) plan.source = 'smart'
  if (plan) plan.fallback = true
  return {
    plan,
    kind: 'fallback',
    chosenTodo: null,
    coveredTodos: [],
    nextTodo: null,
    bufferMin: buffer,
    availableMin: plan?.totalMin ?? 0,
    deadlineMs: null,
  }
}

/** 计划里第 index 颗（0-based）的专注分钟 */
export function roundFocusMin(plan: FocusPlan, index: number): number {
  return plan.rounds[Math.min(Math.max(0, index), plan.rounds.length - 1)]?.focusMin ?? plan.focusMin
}
