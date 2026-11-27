/** 饮食域：当日记录的增删查。任何写入都会联动刷新营养汇总。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { dietService } from '@/services/dietService'
import { useNutritionStore } from '@/stores/nutrition'
import { MEAL_ORDER } from '@/config/domain'
import type { Food, MealLog, MealLogInput, MealType } from '@/types'

export const useDietStore = defineStore('diet', () => {
  const meals = ref<MealLog[]>([])
  const loading = ref(false)

  async function load(date: string): Promise<void> {
    loading.value = true
    try {
      meals.value = await dietService.listMeals(date)
    } finally {
      loading.value = false
    }
  }

  async function add(input: MealLogInput): Promise<{ meal: MealLog; refreshed: boolean }> {
    const meal = await dietService.logMeal(input)
    const results = await Promise.allSettled([
      load(input.date),
      useNutritionStore().loadSummary(input.date),
    ])
    return { meal, refreshed: results.every((r) => r.status === 'fulfilled') }
  }

  async function remove(id: number, date: string): Promise<void> {
    await dietService.deleteMeal(id)
    await Promise.all([load(date), useNutritionStore().loadSummary(date)])
  }

  const grouped = computed<{ mealType: MealType; logs: MealLog[] }[]>(() =>
    MEAL_ORDER.map((mealType) => ({
      mealType,
      logs: meals.value.filter((m) => m.mealType === mealType),
    })).filter((g) => g.logs.length > 0),
  )

  function calcGrams(food: Food, mode: 'grams' | 'unit', grams: number, units: number | null, unitName: string | null): number {
    if (mode === 'grams') return grams
    const u = food.units.find((x) => x.name === unitName)
    return Math.round((u?.grams ?? 100) * (units ?? 1))
  }

  return { meals, loading, load, add, remove, grouped, calcGrams }
})
