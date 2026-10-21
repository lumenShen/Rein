/**
 * 动作库（0025）：全部运动动作的唯一真源。
 *
 * 课程的展示名 / 肌群 / 要点一律先查这里，查不到才回落课程条目里的名称快照 ——
 * 所以库内改名（内置动作随种子刷新）全端跟随，重量曲线也不会因改名而断成两条。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { normalizeActivation, resolveActivation, type MuscleKey } from '@/config/muscles'
import { guideOf as guideOfId, type ExerciseGuide } from '@/config/exerciseGuide'
import { exerciseLibService } from '@/services/exerciseLibService'
import { libraryMuscles } from '@/utils/libraryMuscles'
import type {
  ExerciseCategory,
  ExerciseEquipment,
  ExerciseInput,
  ExerciseKind,
  ExerciseRecord,
  ExerciseSort,
  PlanExercise,
} from '@/types'

export const useExerciseLibStore = defineStore('exerciseLib', () => {
  const list = ref<ExerciseRecord[]>([])
  const loaded = ref(false)
  const loading = ref(false)

  const byId = computed(() => {
    const map = new Map<string, ExerciseRecord>()
    for (const e of list.value) map.set(e.id, e)
    return map
  })

  async function load(includeHidden = false): Promise<void> {
    loading.value = true
    try {
      list.value = await exerciseLibService.list({ includeHidden })
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await load()
  }

  async function upsert(input: ExerciseInput): Promise<ExerciseRecord> {
    const rec = await exerciseLibService.upsert(input)
    await load(true)
    return rec
  }

  /** 自建动作真删 / 内置动作隐藏（后端按 is_custom 分派） */
  async function remove(id: string): Promise<void> {
    await exerciseLibService.remove(id)
    await load(true)
  }

  async function restore(id: string): Promise<void> {
    await exerciseLibService.restore(id)
    await load(true)
  }

  /** 收藏 / 取消收藏：先乐观更新（列表立即置顶），失败再回滚 */
  async function setFavorite(id: string, favorite: boolean): Promise<void> {
    const rec = get(id)
    if (!rec) return
    const prev = rec.favorite
    rec.favorite = favorite
    try {
      await exerciseLibService.setFavorite(id, favorite)
    } catch (e) {
      rec.favorite = prev
      throw e
    }
  }

  function get(id: string): ExerciseRecord | null {
    return byId.value.get(id) ?? null
  }

  /** 展示名：库内名优先（改名跟随），缺失回落课程条目里的名称快照 */
  function resolveName(item: Pick<PlanExercise, 'exerciseId' | 'name'>): string {
    return get(item.exerciseId)?.name ?? item.name
  }

  /**
   * 展示用肌群激活表：库内显式数据优先，其次课程条目自带（AI 写入），
   * 最后按动作名关键词识别（自建动作没填肌群时的兜底）。
   * 两条显式来源都过一遍白名单（防止历史脏数据带出未知键）。
   */
  function musclesOf(item: PlanExercise): ReturnType<typeof resolveActivation> {
    const lib = get(item.exerciseId)
    const explicit = normalizeActivation(
      Object.keys(lib?.muscles ?? {}).length ? lib?.muscles : item.muscles,
    )
    if (Object.keys(explicit).length) return explicit
    return resolveActivation(resolveName(item))
  }

  /** 动作要点：库内优先（课程条目的 tips 允许被课程覆盖时仍以课程为准） */
  function tipsOf(item: PlanExercise): string {
    return item.tips || get(item.exerciseId)?.tips || ''
  }

  /**
   * 结构化动作详解（准备 3 条 / 开始 / 结束 / 注意）。
   *
   * 数据在前端常量表（`config/exerciseGuide`）而不是库表：它是**教学内容**，
   * 不随用户改动、不参与同步，也不该为 81 个内置动作各写一列 JSON。
   * 自建动作返回 null，界面回落 `tipsOf` 那一句话。
   */
  function guideOf(item: Pick<PlanExercise, 'exerciseId'> | null | undefined): ExerciseGuide | null {
    return guideOfId(item?.exerciseId)
  }

  /** 按类型取库内动作（沉浸页「更换动作」用） */
  function forKind(kind: ExerciseKind, excludeId?: string): ExerciseRecord[] {
    return list.value.filter((e) => e.kind === kind && !e.hidden && e.id !== excludeId)
  }

  /**
   * 本地检索 / 筛选（picker 与动作库页共用，纯内存）。
   * - 关键词命中名称或别名；`muscles` 多选 = 命中任一（按**展示用**肌群表判断，
   *   与图上看到的一致：显式数据优先，空表按名称规则兜底）；
   * - 排序：收藏永远置顶，其余按所选口径（最近使用 / 名称 / 训练次数）。
   */
  function search(
    query: string,
    opts?: {
      kind?: ExerciseKind
      category?: ExerciseCategory
      equipment?: ExerciseEquipment
      muscles?: MuscleKey[]
      onlyFavorite?: boolean
      includeHidden?: boolean
      sort?: ExerciseSort
    },
  ): ExerciseRecord[] {
    const q = query.trim().toLowerCase()
    const wantMuscles = opts?.muscles?.length ? new Set(opts.muscles) : null
    const rows = list.value.filter((e) => {
      if (e.hidden && !opts?.includeHidden) return false
      if (opts?.kind && e.kind !== opts.kind) return false
      if (opts?.category && e.category !== opts.category) return false
      if (opts?.equipment && e.equipment !== opts.equipment) return false
      if (opts?.onlyFavorite && !e.favorite) return false
      if (wantMuscles) {
        const map = libraryMuscles(e)
        if (!Object.keys(map).some((k) => wantMuscles.has(k as MuscleKey))) return false
      }
      if (!q) return true
      return e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q))
    })
    const sort = opts?.sort ?? 'recent'
    if (sort !== 'recent') {
      // 稳定排序：收藏置顶优先，再按所选口径
      const cmp =
        sort === 'name'
          ? (a: ExerciseRecord, b: ExerciseRecord) => a.name.localeCompare(b.name, 'zh-Hans-CN')
          : (a: ExerciseRecord, b: ExerciseRecord) => b.sessions - a.sessions
      rows.sort((a, b) => Number(b.favorite) - Number(a.favorite) || cmp(a, b))
      return rows
    }
    // 「最近使用」= 后端顺序；只把收藏稳提到最前
    return [...rows].sort((a, b) => Number(b.favorite) - Number(a.favorite))
  }

  return {
    list,
    loaded,
    loading,
    byId,
    load,
    ensureLoaded,
    upsert,
    remove,
    restore,
    setFavorite,
    get,
    resolveName,
    musclesOf,
    tipsOf,
    guideOf,
    forKind,
    search,
  }
})
