/**
 * 方案周期的展示口径 · 纯函数：起止 / 周次 / 进度 / 当日课程 / 复盘到期。
 * 主页状态卡与方案页共用，避免各自算一份。
 */

import type { ProgramBlob, ProgramRecord } from '@/types'
import { diffDays, todayStr } from '@/utils/date'

export interface ProgramStatus {
  startDate: string
  endDate: string
  /** 已过结束日 */
  ended: boolean
  /** 尚未开始（今天早于起始日） */
  upcoming: boolean
  /** 第几周（1 起；未开始时为 1） */
  week: number
  weeks: number
  /** 周期进度 0-1（按自然日；未开始 0，结束 1） */
  progress: number
}

export function programStatus(record: ProgramRecord, blob: ProgramBlob, today = todayStr()): ProgramStatus | null {
  const startDate = blob.days[0]?.date
  const endDate = blob.days.at(-1)?.date
  if (!startDate || !endDate) return null
  const total = Math.max(blob.days.length, 1)
  const passed = diffDays(startDate, today) + 1
  const clamped = Math.min(Math.max(passed, 0), total)
  return {
    startDate,
    endDate,
    ended: endDate < today,
    upcoming: startDate > today,
    week: Math.max(1, Math.min(record.weeks, Math.floor(Math.max(diffDays(startDate, today), 0) / 7) + 1)),
    weeks: record.weeks,
    progress: clamped / total,
  }
}

/** 某天的课程安排（只有训练日才有） */
export function courseOnDate(
  blob: ProgramBlob,
  date: string,
): { courseId: string; courseName: string; durationMin: number } | null {
  const day = blob.days.find((d) => d.date === date)
  if (!day || day.rest || !day.courseId || !day.courseName) return null
  return { courseId: day.courseId, courseName: day.courseName, durationMin: day.courseDurationMin ?? 45 }
}

/* ---------------- 复盘到期（主页提醒；完成复盘后重新计时） ---------------- */

const REVIEW_INTERVAL_DAYS = 7
const reviewedKey = (id: number): string => `rein.program.reviewed.${id}`

/** 距上次复盘（或方案开始）满 7 天、且周期进行中时到期 */
export function reviewDue(record: ProgramRecord, blob: ProgramBlob, today = todayStr()): boolean {
  const st = programStatus(record, blob, today)
  if (!st || st.ended || st.upcoming) return false
  if (diffDays(st.startDate, today) < REVIEW_INTERVAL_DAYS) return false
  let last = ''
  try {
    last = localStorage.getItem(reviewedKey(record.id)) ?? ''
  } catch {
    /* 存储不可用时按「从未复盘」处理，只是提醒会更频繁 */
  }
  return last === '' || diffDays(last, today) >= REVIEW_INTERVAL_DAYS
}

/** 记录一次完成的复盘（主页提醒据此计时） */
export function markReviewed(id: number): void {
  try {
    localStorage.setItem(reviewedKey(id), todayStr())
  } catch {
    /* 标记写不进去只影响下一次提醒时间 */
  }
}
