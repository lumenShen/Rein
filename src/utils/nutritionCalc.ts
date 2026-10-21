/**
 * 营养参数计算 · 纯函数。
 * BMR 用 Mifflin-St Jeor 公式；TDEE = BMR × 活动系数；
 * 按目标加减热量缺口后，蛋白质按体重配比、脂肪按供能占比、碳水补足剩余热量。
 */

import { MICROS, type MicroDef } from '@/config/dri'
import type { ActivityLevel, DailyTargets, Goal, NutrientIntake, Sex } from '@/types'

/** 宏量供能（千卡/克）：蛋白与碳水 4、脂肪 9 */
const MACRO_KCAL_PER_G = { protein: 4, carb: 4, fat: 9 } as const

export interface MacroEnergyPart {
  key: keyof typeof MACRO_KCAL_PER_G
  label: string
  grams: number
  colorVar: string
  /** 供能占比（0–100，未四舍五入） */
  pct: number
}

/**
 * 宏量供能占比 —— 食品详情 / 记录详情 / 食谱菜单 / 食品库四处共用。
 *
 * 此前四处各写一遍：三处按 >0.5% 过滤、菜单卡不过滤；三处保留小数、菜单卡逐项
 * 四舍五入（三项之和会出现 99 / 101）。统一在这里算，展示层再决定取整。
 */
export function macroEnergyShare(
  protein: number,
  carb: number,
  fat: number,
  opts: { minPct?: number } = {},
): MacroEnergyPart[] {
  const parts: MacroEnergyPart[] = [
    { key: 'protein', label: '蛋白质', grams: protein, colorVar: '--c-protein', pct: 0 },
    { key: 'carb', label: '碳水', grams: carb, colorVar: '--c-carb', pct: 0 },
    { key: 'fat', label: '脂肪', grams: fat, colorVar: '--c-fat', pct: 0 },
  ]
  const total = parts.reduce((s, p) => s + p.grams * MACRO_KCAL_PER_G[p.key], 0)
  if (total <= 0) return []
  const minPct = opts.minPct ?? 0.5
  return parts
    .map((p) => ({ ...p, pct: ((p.grams * MACRO_KCAL_PER_G[p.key]) / total) * 100 }))
    .filter((p) => p.pct > minPct)
}

export interface MicroRow extends MicroDef {
  value: number
  /** 占 DRI 的百分比（未钳制；进度条宽度由视图自己 min(100)） */
  pct: number
  /** 上限类营养已超标 */
  over: boolean
}

/**
 * 微量营养素行 —— 营养全览卡 / 食品详情 / 记录详情共用。
 *
 * 三处原先各算一遍：全览卡把 pct 钳在 100 且 value 保留一位；两个详情按实际含量算
 * 并在模板里再钳一次。数值与百分比口径收在这里，`clampPct` 只给「进度环式」视图用。
 */
export function buildMicroRows(
  intake: Partial<NutrientIntake> | null | undefined,
  opts: { clampPct?: boolean; roundValue?: boolean; onlyPositive?: boolean } = {},
): MicroRow[] {
  const rows = MICROS.map((def) => {
    const raw = Number(intake?.[def.key]) || 0
    const pct = def.dri > 0 ? Math.round((raw / def.dri) * 100) : 0
    return {
      ...def,
      value: opts.roundValue ? Math.round(raw * 10) / 10 : raw,
      pct: opts.clampPct ? Math.min(pct, 100) : pct,
      over: def.isLimit === true && raw > def.dri,
    }
  })
  return opts.onlyPositive ? rows.filter((r) => r.value > 0) : rows
}

/** 计算输入：身体数据 + 目标（age 由生日换算或直接输入） */
export interface CalcParams {
  sex: Sex
  age: number
  heightCm: number
  weightKg: number
  activityLevel: ActivityLevel
  goal: Goal
}

export interface CalcResult {
  /** 基础代谢（大卡/天） */
  bmr: number
  /** 每日总消耗（大卡/天） */
  tdee: number
  /** 推荐每日目标 */
  targets: DailyTargets
}

/** TDEE 活动系数 */
const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
}

/** 目标热量偏移：减脂温和缺口、增肌可控盈余 */
const GOAL_KCAL_DELTA: Record<Goal, number> = { cut: -400, keep: 0, bulk: 300 }

/** 蛋白质 g/kg 体重：减脂期更高以保留肌肉 */
const PROTEIN_PER_KG: Record<Goal, number> = { cut: 1.8, keep: 1.2, bulk: 1.6 }

/** 脂肪供能占比（膳食指南建议 20%~30%） */
const FAT_ENERGY_SHARE = 0.25

/** 热量安全下限，避免推荐值过低 */
export const KCAL_FLOOR = 1200

/** 覆盖默认公式的可调参数（方案引擎按档位传入不同缺口 / 蛋白配比） */
export interface TargetOverrides {
  /** 覆盖按目标取的默认热量偏移 */
  kcalDelta?: number
  /** 覆盖按目标取的默认蛋白 g/kg */
  proteinPerKg?: number
}

export function calcTargetsWith(p: CalcParams, o: TargetOverrides = {}): CalcResult {
  const sexOffset = p.sex === 'male' ? 5 : -161
  const bmr = Math.round(10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + sexOffset)
  const tdee = Math.round(bmr * ACTIVITY_FACTORS[p.activityLevel])
  const kcal = Math.max(
    KCAL_FLOOR,
    Math.round((tdee + (o.kcalDelta ?? GOAL_KCAL_DELTA[p.goal])) / 10) * 10,
  )
  const protein = Math.round(p.weightKg * (o.proteinPerKg ?? PROTEIN_PER_KG[p.goal]))
  const fat = Math.round((kcal * FAT_ENERGY_SHARE) / 9)
  const carb = Math.max(50, Math.round((kcal - protein * 4 - fat * 9) / 4))
  return {
    bmr,
    tdee,
    targets: {
      kcal,
      protein,
      carb,
      fat,
      sodiumMg: 1500,
      waterMl: Math.round((p.weightKg * 30) / 100) * 100,
    },
  }
}

export function calcTargets(p: CalcParams): CalcResult {
  return calcTargetsWith(p)
}
