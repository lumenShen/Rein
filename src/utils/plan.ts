/** 课程展示辅助：时长估算与动作摘要文案（最近卡片 / 详情页 / 编辑页共用）。 */

import { WORKOUT_META } from '@/config/domain'
import type { ExerciseRecord, PlanExercise, WorkoutPlan } from '@/types'

/**
 * 用一个库内动作造一条**课程条目**（新建课程 / 会话内插入动作共用）。
 *
 * 处方一律取库内默认值：`defaultSets` / `defaultReps` / `defaultWeightKg` /
 * `defaultTargetSec` / `defaultDurationMin` / `defaultRestSec`。会话内插入时若不带这些，
 * 条目就会是一副「3 组 10 次 20kg」的空壳，智能建议与热身都失去参照。
 *
 * 条目 id 由调用方决定（课程编辑器与插入动作各生成一次）：它是 `doneSets` 的键，
 * 随机值与后端预期无关，但**必须在本场会话内唯一**。
 */
export function planExerciseFromLib(rec: ExerciseRecord, id = crypto.randomUUID()): PlanExercise {
  const kind = rec.kind
  const rest = rec.defaultRestSec > 0 ? rec.defaultRestSec : kind === 'cardio' ? 0 : 60
  return {
    id,
    exerciseId: rec.id,
    name: rec.name,
    kind,
    sets: kind === 'cardio' ? 1 : Math.max(1, rec.defaultSets || 3),
    reps: kind === 'strength' ? (rec.defaultReps ?? 10) : null,
    weightKg: kind === 'strength' ? rec.defaultWeightKg : null,
    targetSec: kind === 'timed' ? (rec.defaultTargetSec ?? 45) : null,
    durationMin: kind === 'cardio' ? (rec.defaultDurationMin ?? 15) : null,
    restSec: rest,
    tips: rec.tips,
    muscles: Object.keys(rec.muscles ?? {}).length ? { ...rec.muscles } : undefined,
  }
}

/**
 * 粗估课程时长（分钟）：有氧按分钟数；计时组按目标秒（缺省 30s）；
 * 力量正式组按 45s；激活热身组同样按 45s 计（不额外加组间休息）；含组间休息。
 *
 * 组间休息按「组与组之间」算（n 组 → n−1 段）：最后一组做完这个动作就结束了，
 * 后面没有等待。从前写成 `sets × (per + restSec)`，等于每个动作都白搭一段休息
 * （4 组 90s 休息多算 90 秒；六个动作的课虚高约 9 分钟）——「约 N 分钟」是这页
 * 的主数值，系统性偏高就是在骗用户。
 */
export function estimatePlanMinutes(plan: WorkoutPlan): number {
  const WORKING_SET_SEC = 45
  let s = 0
  for (const e of plan.exercises) {
    if (e.kind === 'cardio') s += (e.durationMin ?? 0) * 60
    else {
      const per = e.kind === 'timed' ? (e.targetSec ?? 30) : WORKING_SET_SEC
      s += e.sets * per + Math.max(0, e.sets - 1) * e.restSec
      if (e.kind === 'strength') s += (e.warmups?.length ?? 0) * WORKING_SET_SEC
    }
  }
  return Math.max(1, Math.round(s / 60))
}

/**
 * 动作行摘要：如「4×8 @60kg · 休息 90s」；配激活热身组时追加标注。
 *
 * 处方数值在 AI 建课路径上可能为 null（`src/ai/tools/plan.ts` 把缺省项归一成 null），
 * 缺值时只保留已知的那一半（如「3 组」），不把 null 渲染到界面上。
 */
export function exerciseSub(e: PlanExercise): string {
  if (e.kind === 'strength') {
    const scheme = e.reps != null ? `${e.sets}×${e.reps}` : `${e.sets} 组`
    const weight = e.weightKg != null ? ` @${e.weightKg}kg` : '（自重）'
    const warm = e.warmups?.length ? ` · 热身 ${e.warmups.length} 组` : ''
    return `${scheme}${weight} · 休息 ${e.restSec}s${warm}`
  }
  if (e.kind === 'timed') {
    const scheme = e.targetSec != null ? `${e.sets}×${e.targetSec}s` : `${e.sets} 组`
    return `${scheme} · 组间休息 ${e.restSec}s`
  }
  return e.durationMin != null ? `${e.durationMin} 分钟 · 有氧放松` : '有氧放松'
}

/**
 * 动作类型徽标文案：摘要里已经说出类别时返回空串（同一行不把类别说两遍）。
 * 类别用文字而非 emoji —— emoji 在暗色与字号阶梯上都不受控。
 */
export function exerciseBadge(e: PlanExercise): string {
  const label = e.kind === 'timed' ? '计时' : e.kind === 'cardio' ? '有氧' : ''
  return label !== '' && !exerciseSub(e).includes(label) ? label : ''
}

/** 课程可选的运动类型（用于卡路里估算与保存记录），避开纯户外项 */
export const PLAN_TYPE_OPTIONS = ['strength', 'hiit', 'yoga', 'ball', 'other'] as const

export function planTypeLabel(t: WorkoutPlan['workoutType']): string {
  return WORKOUT_META[t]?.label ?? t
}
