/** 训练课程 store：课程列表 CRUD、最近使用、内置课程种子升级决策。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { planService } from '@/services/planService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import type { PlanSeedStatus, WorkoutPlanInput, WorkoutPlanRecord } from '@/types'

export const usePlanStore = defineStore('plan', () => {
  const plans = ref<WorkoutPlanRecord[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref('')

  /** 内置课程种子升级状态；null = 未查询到（列表加载时顺带查） */
  const seed = ref<PlanSeedStatus | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      plans.value = await planService.list()
      loaded.value = true
      // 动作库要跟着课程一起就位：课程里的动作名一律经它解析（改名跟随），
      // 没加载时只能回落课程条目里的名称快照。失败静默（回落路径本身可用）。
      void useExerciseLibStore()
        .ensureLoaded()
        .catch(() => undefined)
      // 种子状态与列表同批取，避免多一次往返；失败静默（横幅缺失无害）
      try {
        seed.value = await planService.seedStatus()
      } catch {
        seed.value = null
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '训练课程读取失败'
    } finally {
      loading.value = false
    }
  }

  /** 首次访问时惰性加载（页面/恢复流程共用，避免重复拉取） */
  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await load()
  }

  async function reload(): Promise<void> {
    await load()
  }

  function byId(id: string): WorkoutPlanRecord | undefined {
    return plans.value.find((p) => p.id === id)
  }

  /** 最近使用的三个课程（后端已按 last_used_at 排序，直接取前三） */
  const recent = computed<WorkoutPlanRecord[]>(() => plans.value.slice(0, 3))

  /** 是否有待用户决策的内置课程新版本 */
  const seedPending = computed(() => {
    const s = seed.value
    return !!s && s.currentVersion < s.latestVersion
  })

  /** 兼容合并：新种子按动作字段级合并进本地内置课，不覆盖用户设置 */
  async function applySeedMigrate(): Promise<void> {
    seed.value = await planService.seedMigrate()
    await reload()
  }

  /** 使用新版本：内置课内容整体替换为新种子 */
  async function applySeedOverride(): Promise<void> {
    seed.value = await planService.seedOverride()
    await reload()
  }

  /** 保留我的：本版本不再刷新内置课内容，只结清提示 */
  async function applySeedKeep(): Promise<void> {
    seed.value = await planService.seedKeep()
    await reload()
  }

  async function upsert(input: WorkoutPlanInput): Promise<WorkoutPlanRecord> {
    const rec = await planService.upsert(input)
    await reload()
    return rec
  }

  async function remove(id: string): Promise<void> {
    await planService.remove(id)
    await reload()
  }

  /** 开始训练时维护最近使用；乐观更新本地排序，失败不阻塞训练 */
  async function touch(id: string): Promise<void> {
    try {
      await planService.touch(id)
      await reload()
    } catch (e) {
      console.warn('[plan] touch 失败', e)
    }
  }

  return {
    plans,
    loaded,
    loading,
    error,
    seed,
    seedPending,
    load,
    ensureLoaded,
    reload,
    byId,
    recent,
    upsert,
    remove,
    touch,
    applySeedMigrate,
    applySeedOverride,
    applySeedKeep,
  }
})
