/** 营养域：能量与营养总览（摄入 / 目标 / 运动消耗 / 三环数据）。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { nutritionService } from '@/services/nutritionService'
import { EXERCISE_KCAL_GOAL } from '@/config/domain'
import type { BodyMetric, BodyMetricInput, CalcState, DailySummary, DailyTargets, Profile } from '@/types'

export interface MacroStat {
  key: 'protein' | 'carb' | 'fat' | 'sodiumMg'
  label: string
  unit: string
  current: number
  target: number
  colorVar: string
  /** 上限类营养（钠）：目标是"不超过" */
  isLimit: boolean
}

/**
 * 某日汇总 → 宏量列表（含钠）。
 *
 * 抽成纯函数而不是只留在 store 的 computed 里：**历史回看的任意一天**也要用同一份口径
 * 画同一套宏量（饮食历史抽屉里的「摄入总览 / 宏量营养素 / 微量元素」都吃一份 DailySummary），
 * 各写一遍必然漂 —— 这份口径只此一处。
 */
export function macroStatsFrom(s: DailySummary | null): MacroStat[] {
  if (!s) return []
  return [
    { key: 'protein', label: '蛋白质', unit: 'g', current: s.intake.protein, target: s.targets.protein, colorVar: '--c-protein', isLimit: false },
    { key: 'carb', label: '碳水', unit: 'g', current: s.intake.carb, target: s.targets.carb, colorVar: '--c-carb', isLimit: false },
    { key: 'fat', label: '脂肪', unit: 'g', current: s.intake.fat, target: s.targets.fat, colorVar: '--c-fat', isLimit: false },
    { key: 'sodiumMg', label: '钠', unit: 'mg', current: s.intake.sodiumMg, target: s.targets.sodiumMg, colorVar: '--c-sodium', isLimit: true },
  ]
}

export const useNutritionStore = defineStore('nutrition', () => {
  const summary = ref<DailySummary | null>(null)
  const loading = ref(false)
  const profile = ref<Profile | null>(null)

  async function loadSummary(date: string): Promise<void> {
    loading.value = true
    try {
      summary.value = await nutritionService.getDailySummary(date)
    } finally {
      loading.value = false
    }
  }

  async function loadProfile(): Promise<void> {
    profile.value = await nutritionService.getProfile()
  }

  async function saveTargets(targets: DailyTargets): Promise<void> {
    await nutritionService.setTargets(targets)
    if (profile.value) profile.value.targets = { ...targets }
    if (summary.value) summary.value.targets = { ...targets }
  }

  async function saveProfile(p: Profile): Promise<void> {
    profile.value = await nutritionService.updateProfile(p)
  }

  /** 采用推荐方案：身体数据 + 每日目标一次性落库（update_profile 同源持久化 targets）。 */
  async function adoptPlan(patch: Partial<Profile>, targets: DailyTargets): Promise<void> {
    const base = profile.value
    if (!base) return
    const merged: Profile = { ...base, ...patch, targets: { ...targets } }
    profile.value = await nutritionService.updateProfile(merged)
    if (summary.value) summary.value.targets = { ...targets }
  }

  /* ---- 方案计算器参数快照 ---- */

  const calcState = ref<CalcState | null>(null)

  async function loadCalcState(): Promise<void> {
    calcState.value = await nutritionService.getCalcState()
  }

  /** 静默持久化计算器参数（自动保存，不打扰） */
  async function saveCalcState(s: CalcState): Promise<void> {
    calcState.value = await nutritionService.saveCalcState(s)
  }

  /* ---- 体重 / 身高追踪 ---- */

  const metrics = ref<BodyMetric[]>([])

  async function loadMetrics(limit?: number): Promise<void> {
    metrics.value = await nutritionService.listBodyMetrics(limit)
  }

  /** 记一笔：按天 upsert；后端同步 profile，本地直接补齐避免二次拉取 */
  async function recordMetric(input: BodyMetricInput): Promise<void> {
    const m = await nutritionService.recordBodyMetric(input)
    const i = metrics.value.findIndex((x) => x.date === m.date)
    if (i === -1) metrics.value.push(m)
    else metrics.value[i] = m
    metrics.value.sort((a, b) => b.date.localeCompare(a.date))
    if (profile.value) {
      if (input.weightKg != null) profile.value.weightKg = input.weightKg
      if (input.heightCm != null) profile.value.heightCm = input.heightCm
    }
  }

  async function deleteMetric(id: number): Promise<void> {
    await nutritionService.deleteBodyMetric(id)
    metrics.value = metrics.value.filter((x) => x.id !== id)
  }

  /* ---- 派生数据 ---- */

  const kcalIntake = computed(() => Math.round(summary.value?.intake.kcal ?? 0))
  const kcalTarget = computed(() => Math.round(summary.value?.targets.kcal ?? 0))
  const exerciseKcal = computed(() => Math.round(summary.value?.exerciseKcal ?? 0))
  // 目标（TDEE ± 缺口/盈余）已含活动系数里的训练消耗，不再把总运动消耗加回 ——
  // 加回等于双重计入。运动消耗只作独立指标展示（三环里的运动环）。
  const kcalRemaining = computed(() => Math.max(0, kcalTarget.value - kcalIntake.value))

  const macros = computed<MacroStat[]>(() => macroStatsFrom(summary.value))

  /** 三环：摄入达标 / 运动消耗 / 营养均衡（三大宏量完成度的均值） */
  const rings = computed(() => {
    const s = summary.value
    const cap = (v: number, max: number) => (max <= 0 ? 0 : Math.min(v / max, 1.2))
    const macroAvg =
      macros.value.length === 0
        ? 0
        : macros.value
            .filter((m) => !m.isLimit)
            .reduce((sum, m) => sum + Math.min(m.current / m.target, 1), 0) / 3
    return [
      { key: 'intake', value: s ? cap(s.intake.kcal, s.targets.kcal) : 0, colorVar: '--c-intake' },
      { key: 'exercise', value: s ? cap(s.exerciseKcal, EXERCISE_KCAL_GOAL) : 0, colorVar: '--c-exercise' },
      { key: 'balance', value: macroAvg, colorVar: '--c-balance' },
    ]
  })

  return {
    summary,
    loading,
    profile,
    loadSummary,
    loadProfile,
    saveTargets,
    saveProfile,
    adoptPlan,
    calcState,
    loadCalcState,
    saveCalcState,
    metrics,
    loadMetrics,
    recordMetric,
    deleteMetric,
    kcalIntake,
    kcalTarget,
    exerciseKcal,
    kcalRemaining,
    macros,
    rings,
  }
})
