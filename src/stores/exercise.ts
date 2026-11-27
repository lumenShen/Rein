/** 运动域：本周记录 + 写入联动刷新能量总览。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { exerciseService } from '@/services/exerciseService'
import { useNutritionStore } from '@/stores/nutrition'
import { addDays, startOfWeek, todayStr } from '@/utils/date'
import type { Workout, WorkoutInput, WorkoutUpdateInput } from '@/types'

export const useExerciseStore = defineStore('exercise', () => {
  const weekWorkouts = ref<Workout[]>([])
  /** 全量记录（全部运动记录页用），日期倒序 */
  const allWorkouts = ref<Workout[]>([])
  let allLoaded = false
  const loading = ref(false)

  /** 拉取 anchor 所在周（周一起）的记录 */
  async function loadWeek(anchor = todayStr()): Promise<void> {
    loading.value = true
    try {
      const start = startOfWeek(anchor)
      weekWorkouts.value = await exerciseService.listWorkouts(start, addDays(start, 6))
    } finally {
      loading.value = false
    }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      allWorkouts.value = await exerciseService.listAllWorkouts()
      allLoaded = true
    } finally {
      loading.value = false
    }
  }

  async function add(input: WorkoutInput): Promise<void> {
    await exerciseService.createWorkout(input)
    const jobs: Promise<void>[] = [loadWeek(input.date), useNutritionStore().loadSummary(todayStr())]
    if (allLoaded) jobs.push(loadAll())
    await Promise.all(jobs)
  }

  async function update(id: number, input: WorkoutUpdateInput, previousDate: string): Promise<Workout> {
    const updated = await exerciseService.updateWorkout(id, input)
    const today = todayStr()
    const jobs: Promise<void>[] = [loadWeek()]
    if (previousDate === today || input.date === today) {
      jobs.push(useNutritionStore().loadSummary(today))
    }
    if (allLoaded) jobs.push(loadAll())
    await Promise.all(jobs)
    return updated
  }

  async function remove(id: number): Promise<void> {
    await exerciseService.deleteWorkout(id)
    const jobs: Promise<void>[] = [loadWeek(), useNutritionStore().loadSummary(todayStr())]
    if (allLoaded) jobs.push(loadAll())
    await Promise.all(jobs)
    bumpStrength() // 删除训练会级联删逐组记录，曲线同步失效
  }

  /**
   * 逐组做组记录版本号：strength_history 落库变化（结束保存 / 删除训练）后 +1。
   * 力量进步卡据此失效本地历史缓存重拉——页面常驻（训练课沉浸层不再走路由）
   * 之后，曲线卡不再因导航离开而重挂载刷新，必须显式感知。
   */
  const strengthRev = ref(0)
  function bumpStrength(): void {
    strengthRev.value++
  }

  const todayKcal = computed(() =>
    weekWorkouts.value.filter((w) => w.date === todayStr()).reduce((s, w) => s + w.kcal, 0),
  )

  const weekKcal = computed(() => weekWorkouts.value.reduce((s, w) => s + w.kcal, 0))

  const weekMinutes = computed(() => weekWorkouts.value.reduce((s, w) => s + w.durationMin, 0))

  /** 周一到周日每天的运动分钟数（柱状图数据） */
  const minutesByDay = computed(() => {
    const start = startOfWeek(todayStr())
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i)
      return {
        date,
        isToday: date === todayStr(),
        minutes: weekWorkouts.value.filter((w) => w.date === date).reduce((s, w) => s + w.durationMin, 0),
      }
    })
  })

  const recent = computed(() => [...weekWorkouts.value].sort((a, b) => b.id - a.id).slice(0, 8))

  return { weekWorkouts, allWorkouts, loading, loadWeek, loadAll, add, update, remove, todayKcal, weekKcal, weekMinutes, minutesByDay, recent, strengthRev, bumpStrength }
})
