/**
 * 结营成绩单：把一份方案的执行数据聚合成「有没有用、改变了什么、下一步」。
 *
 * 复用 buildProgramReport 的口径（同一份 training/actual/recordedDays/trainedDates），
 * 在其上补齐：起点对照（体重 / 摄入 / 训练频率）、最长连续打卡、徽章判定、
 * 下一期档位建议——全部纯前端规则，不引入新表。
 */

import { dietService } from '@/services/dietService'
import { exerciseService } from '@/services/exerciseService'
import { nutritionService } from '@/services/nutritionService'
import { GOAL_LABELS, mealKcal } from '@/config/domain'
import { addDays } from '@/utils/date'
import { parseBlob } from '@/utils/programEngine'
import {
  buildProgramReport,
  fmtRate,
  reportSpanDays,
  type ProgramReport,
} from '@/utils/programReport'
import type { ProgramRecord, ProgramTier } from '@/types'

export interface WrapupBadge {
  emoji: string
  title: string
  sub: string
}

export interface WrapupCompare {
  weight: { before: number | null; after: number | null }
  /** 日均摄入（大卡）：两侧同为「有记录的自然日」的平均，不是按餐平均 */
  intake: { before: number | null; after: number | null }
  /** 周均训练次数：两侧同为「每周完成几次」，不是整期累计次数 */
  trainingFreq: { before: number; after: number }
}

export interface WrapupData {
  report: ProgramReport
  /** 完成度 0-1（计划训练兑现率：有运动记录或勾了日程都算；无计划训练日时 null） */
  completion: number | null
  /** 最长连续打卡天数（当天有运动记录或完成方案日程记 1 天） */
  streakDays: number
  compare: WrapupCompare
  badges: WrapupBadge[]
  /** 下一期档位建议（按完成率） */
  nextTier: ProgramTier
  nextTierText: string
}

/** 最长连续日期段长度（YYYY-MM-DD 字符串连续性） */
function longestStreak(dates: string[]): number {
  const sorted = [...new Set(dates)].sort()
  let best = 0
  let run = 0
  let prev: string | null = null
  for (const d of sorted) {
    if (prev != null && addDays(prev, 1) === d) run += 1
    else run = 1
    best = Math.max(best, run)
    prev = d
  }
  return best
}

/** 基线窗口长度：方案开始前 7 天，作为「起点」对照 */
const BASELINE_DAYS = 7

const round1 = (x: number): number => Math.round(x * 10) / 10

/** 汇总一份方案的结营成绩单（只读） */
export async function buildWrapup(record: ProgramRecord): Promise<WrapupData> {
  const blob = parseBlob(record)
  const startDate = blob.days[0]?.date ?? ''
  const endDate = blob.days.at(-1)?.date ?? startDate

  const [report, metrics] = await Promise.all([buildProgramReport(record), nutritionService.listBodyMetrics(100)])

  /* 连续打卡：当天有运动记录或完成方案日程即算打卡（并集口径，与报告一致） */
  const streakDays = longestStreak(report.trainedDates)

  /* 起点对照：方案开始前 7 天（基线窗口）vs 方案全期。
     两侧必须同口径，否则对照不成立：摄入都按「有记录的自然日」日均（不是按餐平均），
     训练都折算成周均（不是「7 天计数 vs 全期计数」那种虚假跳变）。 */
  const [beforeMeals, beforeWorkouts] = await Promise.all([
    dietService.listMealsRange(addDays(startDate, -BASELINE_DAYS), addDays(startDate, -1)),
    exerciseService.listWorkouts(addDays(startDate, -BASELINE_DAYS), addDays(startDate, -1)),
  ])
  // 与 report.avgIntake 同口径：总摄入 ÷ 有记录的自然日数
  const beforeDays = new Set(beforeMeals.map((m) => m.date)).size
  const intakeBefore = beforeDays > 0
    ? Math.round(beforeMeals.reduce((s, m) => s + (mealKcal(m) ?? 0), 0) / beforeDays)
    : null
  // 基线窗口正好一周，窗口内次数即周均；全期次数需除以周数（都是「记录条数」口径）
  const weeks = Math.max(reportSpanDays(startDate, endDate), 1) / BASELINE_DAYS
  const trainingBefore = beforeWorkouts.length
  const trainingAfter = round1(report.actual.count / weeks)

  const weights = metrics
    .filter((m) => m.weightKg != null && m.date >= startDate && m.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((m) => m.weightKg as number)
  const weightAfter = weights.length ? weights.at(-1)! : null
  const weightBefore = weights.length ? weights[0]! : null

  const completion =
    report.training.planned > 0 ? report.training.done / report.training.planned : null

  /* 徽章（纯前端规则） */
  const badges: WrapupBadge[] = []
  if (streakDays >= 3) {
    badges.push({ emoji: '🔥', title: `连续打卡 ${streakDays} 天`, sub: '最长一段未间断的执行' })
  }
  const recordRate = report.plannedDays > 0 ? report.recordedDays / report.plannedDays : 0
  if (report.recordedDays > 0 && recordRate >= 0.8) {
    badges.push({ emoji: '🥗', title: `饮食记录 ${report.recordedDays} 天`, sub: `记录率 ${Math.round(recordRate * 100)}%，数据完整是复盘的前提` })
  }
  if (report.actual.sessions >= 3) {
    badges.push({ emoji: '🏋️', title: `跟课训练 ${report.actual.sessions} 次`, sub: '沉浸训练课完整走下来的次数' })
  }
  const trainingRate = report.training.planned > 0 ? report.training.done / report.training.planned : 0
  if (report.training.planned > 0 && trainingRate >= 0.9) {
    badges.push({ emoji: '💪', title: `训练完成率 ${Math.round(trainingRate * 100)}%`, sub: `${report.training.done}/${report.training.planned} 次全部兑现` })
  } else if (report.weightDeltaKg != null && report.weightDeltaKg !== 0) {
    const good =
      (record.goal === 'cut' && report.weightDeltaKg < 0) ||
      (record.goal === 'bulk' && report.weightDeltaKg > 0) ||
      record.goal === 'keep'
    if (good) {
      badges.push({ emoji: '🎯', title: `体重变化 ${report.weightDeltaKg > 0 ? '+' : ''}${report.weightDeltaKg}kg`, sub: '朝目标方向真实移动了' })
    }
  }

  /* 下一期档位：完成率决定，完成率比野心更重要 */
  const rate = completion ?? 0.7
  const nextTier: ProgramTier =
    completion == null ? 'conservative' : rate < 0.6 ? 'conservative' : rate < 0.85 ? 'balanced' : 'aggressive'
  const tierLabel = { conservative: '保守', balanced: '均衡', aggressive: '进取' }[nextTier]
  const trainRateText = fmtRate(report.training.done, report.training.planned)
  const nextTierText =
    completion == null
      ? '这份方案没有计划训练日，下一期建议从保守档起步，先把「完成」建立起来。'
      : rate < 0.6
        ? `训练完成率 ${trainRateText} 是唯一短板。下一期降为 ${tierLabel}档但保证完成，比高配只做一半更有效。`
        : rate < 0.85
          ? `训练完成率 ${trainRateText}，节奏可以稳住。下一期维持 ${tierLabel}档，在执行质量上做提升。`
          : `训练完成率 ${trainRateText}，执行力有富余。下一期可以上 ${tierLabel}档试试更高的目标。`

  return {
    report,
    completion,
    streakDays,
    compare: {
      weight: { before: weightBefore, after: weightAfter },
      intake: { before: intakeBefore, after: report.avgIntake },
      trainingFreq: { before: trainingBefore, after: trainingAfter },
    },
    badges,
    nextTier,
    nextTierText,
  }
}

/** 成绩单副标题：`28 天 · 减脂 · 均衡档` */
export function wrapupSubtitle(record: ProgramRecord): string {
  const blobDays = (() => {
    try {
      return parseBlob(record).days.length
    } catch {
      return record.weeks * 7
    }
  })()
  const tier = record.tier === 'conservative' ? '保守' : record.tier === 'aggressive' ? '进取' : '均衡'
  return `${blobDays} 天 · ${GOAL_LABELS[record.goal]} · ${tier}档`
}
