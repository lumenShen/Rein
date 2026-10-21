/**
 * 训练会话工具集的共用件：取会话、会话全景投影、成功 / 失败回执的固定形状。
 *
 * 这个目录是**独立工具集**（`ToolGroup = 'session'`，见 `tools/types.ts`）：它只碰
 * 「正在进行的那一场」，一个字都不写课程库（`tools/plan.ts` 那个工具集才写库）。
 * 三块分开是为了让模型一眼分清手上这把是「手」（执行流）还是「编排」（这一场有哪些动作）：
 *  - `read.ts`   —— 看清现场（相位、第几个动作、推荐重量、热身处方）
 *  - `adjust.ts` —— 动这一组（改重量 / 次数、登记完成、跳过、加练、回退、休息、跳组）
 *  - `arrange.ts`—— 动这一场的结构（换动作、插入、删除、改组数 / 次数 / 休息）
 */

import { useSessionStore } from '@/stores/session'
import { WARMUP_RULE_TEXT } from '@/utils/warmup'

export type SessionStore = ReturnType<typeof useSessionStore>

/** 相位的中文名（模型读得懂，也方便它向用户复述） */
export const PHASE_LABEL: Record<string, string> = {
  idle: '未开始',
  warmup: '激活热身',
  exercise: '做组中',
  rest: '组间休息',
  'timed-ready': '计时准备',
  'timed-run': '计时进行中',
  summary: '已结束待保存',
}

/** 数值入参收敛：非有限数返回 null，让调用方给出可读的 reason */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 取到「确实有进行中训练课」的会话 store。
 *
 * 应用重启后 store 是 idle，但服务端还留着未结束的会话 —— 先尝试接续一次。
 * 接续失败（课程已删 / 记录损坏）一律按「没有会话」处理，绝不抛错：
 * 这里只是查询入口，不该因为脏数据把整轮对话打断。
 */
export async function activeSession(): Promise<SessionStore | null> {
  const s = useSessionStore()
  if (s.isActive) return s
  try {
    await s.hydrateFromServer()
  } catch {
    return null
  }
  return s.isActive ? s : null
}

/** 某一动作在这一场里的身份摘要（编排类工具都要先看这份清单挑 exerciseIndex） */
function exerciseRows(s: SessionStore): Record<string, unknown>[] {
  const plan = s.plan
  if (!plan) return []
  return plan.exercises.map((e, i) => ({
    exerciseIndex: i + 1,
    name: e.name,
    kind: e.kind,
    sets: s.effSets(e),
    reps: e.reps,
    workingWeightKg: (() => {
      const w = s.workingWeightFor(e)
      return w > 0 ? w : null
    })(),
    doneSets: s.exDoneCount(e.id),
    skippedSets: (s.skippedSets[e.id] ?? []).length,
    isCurrent: i === s.exIndex,
  }))
}

/**
 * 会话全景（查询与写操作的回执共用同一份投影，模型不必再调一次查询）。
 *
 * `exercises` 是**必给**的：插入 / 删除 / 改组数都要挑「这一场的第几个」，
 * 只给「当前动作」的话模型只能瞎猜下标 —— 而下标错一位就会改到别的动作上。
 */
export function describeSession(s: SessionStore): Record<string, unknown> {
  const ex = s.currentEx
  const totalEx = s.plan?.exercises.length ?? 0
  const advice = ex ? s.adviceFor(ex) : null
  const working = ex ? s.workingWeightFor(ex) : 0
  const rxPlan = ex ? s.warmupPlanFor(ex) : null
  const rx = rxPlan?.sets ?? []
  const doneWarm = ex ? s.warmupDone(ex) : 0
  const isStrength = ex?.kind === 'strength'

  return {
    planName: s.plan?.name ?? '',
    phase: s.phase,
    phaseLabel: PHASE_LABEL[s.phase] ?? s.phase,
    elapsedSec: s.durationSec,
    progress: `动作 ${s.exIndex + 1}/${totalEx} · 第 ${s.setIndex} 组`,
    exerciseIndex: s.exIndex + 1,
    exerciseCount: totalEx,
    setIndex: s.setIndex,
    currentExercise: ex
      ? {
          exerciseId: ex.exerciseId,
          name: ex.name,
          kind: ex.kind,
          plannedSets: ex.sets,
          extraSets: s.effSets(ex) - ex.sets,
          sets: s.effSets(ex),
          reps: s.reps,
          restSec: ex.restSec,
        }
      : null,
    /** 这一场的完整动作清单（编排类操作的坐标来源） */
    exercises: exerciseRows(s),
    /** 正式组那一档的重量（今日建议优先，回落上次实际 / 课程建议值） */
    workingWeightKg: working > 0 ? working : null,
    /**
     * 今日推荐重量（建议引擎给出）。它**不是**热身处方的换算基准 —— 有极限时基准是
     * `warmup.basisE1rmKg`，推荐重量只在估不出极限时兜底（见 warmup.basisUsed）。
     */
    recommendedWeightKg: advice?.suggestedWeight ?? null,
    /** 当前输入框里的重量：热身相位时是热身重量，做组相位时是工作重量 */
    currentWeightKg: s.weight,
    /** 激活热身：规则 + 按当天估算极限（无极限时按推荐重量）换算出的处方 + 已做/剩余 */
    warmup:
      isStrength && ex
        ? {
            rule: WARMUP_RULE_TEXT,
            basisWeightKg: working > 0 ? working : null,
            /**
             * 换算基准有两种：乘在**当天的估算极限（e1RM）**上（那才是「40%–75% 1RM」的
             * 区间），拿不到极限时回落按工作重量的绝对阈值。模型复述时要说清用的是哪套，
             * 否则用户按「工作重量的 50%」去核对数字会发现对不上。
             */
            basisE1rmKg: advice?.todayCeiling ?? null,
            basisUsed: rxPlan?.usedBaseline ? 'e1rm' : 'working_weight',
            prescribed: rx.map((d) => ({ weightKg: d.weightKg, reps: d.reps })),
            doneSets: doneWarm,
            remainingSets: Math.max(0, rx.length - doneWarm),
          }
        : null,
    restLeftSec: s.phase === 'rest' ? s.restLeft : null,
    counts: { done: s.doneCount, total: s.totalCount },
  }
}

/** 写成功回执：带上最新全景，模型不必再查询一次 */
export function changed(s: SessionStore, message: string): Record<string, unknown> {
  return { updated: true, message, session: describeSession(s) }
}

/** 写失败回执：结构化的原因，交给模型改参数或改说法 */
export function rejected(reason: string): Record<string, unknown> {
  return { updated: false, reason }
}
