/**
 * 力量记录聚合 · 重量曲线的数据整形。
 * 输入是 workout_sets 的查询行（含热身组），输出按「次训练」聚合的做组序列。
 */

import { fmtKg } from './format'
import type { StrengthSetRecord } from '@/types'

export { fmtKg }

export interface StrengthDay {
  workoutId: number
  date: string
  /** 该次训练的最大重量组（渐进超负荷对照点） */
  top: number
  topReps: number | null
  /** 正式组明细（热身组已过滤，按组序） */
  sets: { setNo: number; weightKg: number | null; reps: number | null }[]
}

/** 按训练日聚合：过滤热身行与无重量行，日期升序（同日多课按 workoutId 分开） */
export function aggregateStrengthDays(rows: StrengthSetRecord[]): StrengthDay[] {
  const map = new Map<number, StrengthDay>()
  for (const r of rows) {
    if (r.warmup || r.weightKg == null) continue
    let day = map.get(r.workoutId)
    if (!day || day.date !== r.date) {
      day = { workoutId: r.workoutId, date: r.date, top: r.weightKg, topReps: r.reps, sets: [] }
      map.set(r.workoutId, day)
    }
    day.sets.push({ setNo: r.setNo, weightKg: r.weightKg, reps: r.reps })
    if (r.weightKg > day.top || (r.weightKg === day.top && day.topReps == null)) {
      day.top = r.weightKg
      day.topReps = r.reps
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
}
