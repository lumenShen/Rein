/**
 * 健康方案域：方案生成 / 启用 / 调整的编排。
 *
 * 计算在 utils/programEngine（纯函数），持久化在 programService；
 * 跨域联动（同步每日营养目标、刷新待办）按规范收敛在本 store 的 action 里，
 * 页面与 AI 工具只调 action，不自行编排多个 store。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { planService } from '@/services/planService'
import { programService } from '@/services/programService'
import { dietService } from '@/services/dietService'
import { useNutritionStore } from '@/stores/nutrition'
import { useTodoStore } from '@/stores/todo'
import { addDays, fmtDateCn, startOfWeek, todayStr } from '@/utils/date'
import { calcTargets } from '@/utils/nutritionCalc'
import seedRecipes from '@resources/recipe_templates.json'
import {
  buildProgramPlans,
  buildScheduleTodos,
  clampAdjustment,
  makeAdjustmentEntry,
  parseBlob,
  profileCalcParams,
  programEndDate,
  rebuildBlob,
  type AdjustmentPatch,
  type CourseLite,
} from '@/utils/programEngine'
import {
  buildShoppingList,
  itemsFromAi,
  itemsFromTemplate,
  type CheckedRow,
  type ShoppingDay,
} from '@/utils/shoppingList'
import type { AiMenuMeal } from '@/ai/recipeGen'
import type { ProgramAdjustment, ProgramChange, ProgramPlan, ProgramRecord } from '@/types'

export const DEFAULT_PROGRAM_WEEKS = 4

/** 日程格式迁移标记：v1 会把每日饮食锚点铺成待办，v2 只落训练日课程条目 */
const SCHEDULE_V2_KEY = 'rein.program.sched2'

/** 默认从下周一开跑（周模板以周一为起点对齐） */
export function defaultStartDate(): string {
  return startOfWeek(addDays(todayStr(), 7))
}

/** 食物分类映射（采购清单分组用）：id 与名称双键；页面/工具共享、进程内缓存 */
const foodCatById = new Map<number, string>()
const foodCatByName = new Map<string, string>()

/** 采购清单组装结果（rows 已叠加勾选状态） */
export interface ShoppingBuild {
  rows: CheckedRow[]
  rangeLabel: string
  aiDays: number
  templateDays: number
  from: string
  to: string
}

function parseAdjustments(json: string): ProgramAdjustment[] {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? (v as ProgramAdjustment[]) : []
  } catch {
    return []
  }
}

export const useProgramStore = defineStore('program', () => {
  const active = ref<ProgramRecord | null>(null)
  const history = ref<ProgramRecord[]>([])
  const loaded = ref(false)

  async function load(): Promise<void> {
    active.value = await programService.getActiveProgram()
    history.value = await programService.listPrograms()
    loaded.value = true
    await migrateScheduleOnce()
  }

  /**
   * 一次性迁移：旧版把每日饮食锚点铺成待办，v2 只落训练日课程条目。
   * 用新规则重排今日起的日程（重排本身会清掉未来的旧锚点），完成后写标记；
   * 失败不写标记、不阻塞加载，下次 load 再试。
   */
  async function migrateScheduleOnce(): Promise<void> {
    try {
      if (localStorage.getItem(SCHEDULE_V2_KEY) === '1') return
    } catch {
      return /* 存储不可用：不做迁移也不写标记 */
    }
    try {
      if (active.value) {
        // 重排要用用户的常练时段（profile 可能还没被别的入口拉过）
        const n = useNutritionStore()
        if (!n.profile) await n.loadProfile()
        await scheduleTodos(active.value.id, parseBlob(active.value), todayStr())
      }
      try {
        localStorage.setItem(SCHEDULE_V2_KEY, '1')
      } catch {
        /* 标记写不进去也不影响本次迁移结果 */
      }
    } catch {
      /* 方案数据损坏等：保持未迁移状态，下次再试 */
    }
  }

  /** 归档/删除当前方案后，把每日目标还原为档案目标的默认公式值
   * （方案期内的档位目标是显式同步进去的，撤销方案时一并撤销） */
  async function restoreGoalTargets(): Promise<void> {
    const n = useNutritionStore()
    try {
      if (!n.profile) await n.loadProfile()
      const body = n.profile ? profileCalcParams(n.profile) : null
      if (!body) return
      await n.saveTargets(calcTargets(body).targets)
    } catch {
      /* 还原失败不阻塞归档/删除主流程 */
    }
  }

  /** 引擎需要的课程元信息（名称/时长）；workout_plans 全量很小，直接拉取 */
  async function loadCourseList(): Promise<CourseLite[]> {
    const plans = await planService.list()
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      equipment: p.equipment ?? null,
      estDurationMin: p.estDurationMin ?? null,
    }))
  }

  /** 生成三档方案草稿（确定性：同档案同输入必得同结果；选菜受食谱偏好影响）。
   * phase = 周模板序列相位，支持从今天/明天开始并接续当前训练节奏 */
  async function generateDrafts(startDate: string, weeks: number, phase = 0): Promise<ProgramPlan[]> {
    const n = useNutritionStore()
    if (!n.profile) await n.loadProfile()
    const profile = n.profile
    if (!profile) throw new Error('个人资料未加载')
    const prefs = await dietService.recipePrefsList()
    return buildProgramPlans(profile, startDate, weeks, await loadCourseList(), prefs, phase)
  }

  /** 把方案内容铺成日程待办；fromDate 起的未来未完成条目会被整批替换 */
  async function scheduleTodos(programId: number, blobParam: ReturnType<typeof parseBlob>, fromDate: string): Promise<void> {
    const n = useNutritionStore()
    const todos = buildScheduleTodos(blobParam, n.profile?.preferredTimeSlots ?? null)
    await programService.replaceSchedule(programId, fromDate, todos)
  }

  /** 启用一套方案：落库 → 写日程 → 同步每日营养目标 → 刷新待办 */
  async function activate(plan: ProgramPlan): Promise<ProgramRecord> {
    const blob = { params: plan.params, days: plan.days }
    const record = await programService.createProgram({
      goal: plan.goal,
      tier: plan.tier,
      weeks: plan.weeks,
      paramsJson: JSON.stringify(blob),
    })
    try {
      await finishActivation(record)
      return record
    } catch (e) {
      try {
        await load()
      } catch {
        // 已创建的方案仍以 active 记录为准，页面提供重试同步，不能再次创建。
      }
      throw new Error('方案已启用，但日程或营养目标尚未同步完成，请重试同步', { cause: e })
    }
  }

  /** 启用后的排程与目标同步可独立重试，避免半成功后重复创建方案。 */
  async function finishActivation(record: ProgramRecord): Promise<void> {
    const n = useNutritionStore()
    const blob = parseBlob(record)
    active.value = record
    await scheduleTodos(record.id, blob, blob.days[0]?.date ?? todayStr())
    await n.saveTargets(blob.params.targets)
    await useTodoStore().loadAll()
    await load()
  }

  /** 调整进行中标志（adjust 的并发闸门，见 adjust） */
  let adjusting = false

  /**
   * 应用一次调整（AI 复盘确认 / 手动改参共用入口）：
   * 钳制 → 用最新身体数据重算并保留历史天重建内容 → 版本+1 → 从今天起重排日程。
   * 返回实际生效的变更明细（可能少于建议：越界值被钳到边界）。
   * 补丁经钳制后与现参数完全一致时不落任何变更（不推版本、不重排、不记历史）。
   */
  async function adjust(
    record: ProgramRecord,
    patch: AdjustmentPatch,
    summary: string,
    source: 'ai' | 'manual',
  ): Promise<{ changes: ProgramChange[]; record: ProgramRecord }> {
    // 连点/AI 重复触发会让两次 adjust 基于同一份旧参数计算，后写覆盖前写
    // （丢更新 + 日程重排两次），且版本号 = record.version + 1 的假设被打破
    if (adjusting) throw new Error('方案正在调整中，请稍候')
    adjusting = true
    try {
      return await applyAdjustment(record, patch, summary, source)
    } finally {
      adjusting = false
    }
  }

  async function applyAdjustment(
    record: ProgramRecord,
    patch: AdjustmentPatch,
    summary: string,
    source: 'ai' | 'manual',
  ): Promise<{ changes: ProgramChange[]; record: ProgramRecord }> {
    const n = useNutritionStore()
    if (!n.profile) await n.loadProfile()
    const profile = n.profile!
    const oldBlob = parseBlob(record)
    const { next, changes } = clampAdjustment(profile, oldBlob.params, patch)
    if (!changes.length) return { changes: [], record }
    const fromDate = todayStr()
    const courses = await loadCourseList()
    const prefs = await dietService.recipePrefsList()
    const blob = rebuildBlob(oldBlob, next, profile, fromDate, courses, prefs)

    const entries = parseAdjustments(record.adjustmentsJson)
    entries.push(makeAdjustmentEntry(record.version + 1, summary, changes, source))
    const updated = await programService.updateProgramParams(
      record.id,
      JSON.stringify(blob),
      JSON.stringify(entries),
    )
    // 参数变了，未来日期的 AI 菜单缓存全部作废（按新目标重新生成）
    await programService.clearProgramMeals(updated.id, fromDate)

    await scheduleTodos(updated.id, blob, fromDate)
    await n.saveTargets(next.targets)
    active.value = updated
    await useTodoStore().loadAll()
    await load()
    return { changes, record: updated }
  }

  /** 归档方案：今天（含）起未完成的日程一并回收，已完成项保留为执行历史；
   * 归档的是当前生效方案时，每日目标还原为档案默认值 */
  async function archive(id: number): Promise<void> {
    const wasActive = active.value?.id === id
    await programService.archiveProgram(id, todayStr())
    await useTodoStore().loadAll()
    await load()
    if (wasActive) await restoreGoalTargets()
  }

  /** 读取某天的 AI 菜单缓存；未生成时返回 null（页面回落模板菜单） */
  async function loadDayMeals(record: ProgramRecord, date: string): Promise<AiMenuMeal[] | null> {
    const row = await programService.getProgramMeals(record.id, date)
    if (!row) return null
    try {
      const arr = JSON.parse(row.mealsJson) as AiMenuMeal[]
      return Array.isArray(arr) && arr.length ? arr : null
    } catch {
      return null
    }
  }

  /** 区间读取 AI 菜单缓存（采购清单聚合用）：date → 菜单；损坏行按未生成跳过 */
  async function loadAiMealsRange(
    record: ProgramRecord,
    startDate: string,
    endDate: string,
  ): Promise<Map<string, AiMenuMeal[]>> {
    const rows = await programService.getProgramMealsRange(record.id, startDate, endDate)
    const out = new Map<string, AiMenuMeal[]>()
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.mealsJson) as AiMenuMeal[]
        if (Array.isArray(arr) && arr.length) out.set(row.date, arr)
      } catch {
        /* 损坏行按未生成处理 */
      }
    }
    return out
  }

  /** AI 生成某天的菜单并落缓存；同步更新当天饮食锚点待办的备注。
   * onStatus 可选：流式回传生成过程摘要（匹配食材等活动），供调用方上屏。 */
  async function generateDayMeals(
    record: ProgramRecord,
    date: string,
    onStatus?: (status: string) => void,
  ): Promise<AiMenuMeal[]> {
    const n = useNutritionStore()
    if (!n.profile) await n.loadProfile()
    const profile = n.profile!
    const { useModelsStore } = await import('@/stores/models')
    const models = useModelsStore()
    await models.load()
    const cfg = models.defaultModel()
    if (!cfg) throw new Error('未配置 AI 模型，请先在「AI › 管理模型」添加')

    const blob = parseBlob(record)
    const day = blob.days.find((d) => d.date === date)
    if (!day) throw new Error('该日期不在方案周期内')

    const prefs = await dietService.recipePrefsList()
    const recipes = (seedRecipes as { recipes: { id: string; name: string }[] }).recipes
    const recipeName = (id: string): string => recipes.find((x) => x.id === id)?.name ?? id
    const recent = await dietService.listMealsRange(addDays(date, -3), addDays(date, -1))
    const avoidNames = [...new Set(recent.map((m) => m.food?.name ?? '').filter(Boolean))]

    const { generateDayMenu } = await import('@/ai/recipeGen')
    const { mealLayoutFor } = await import('@/utils/programEngine')
    const res = await generateDayMenu(
      cfg,
      {
        slots: mealLayoutFor(blob.params.mealsCount).map((s) => ({ slot: s.slot, share: s.share })),
        targets: blob.params.targets,
        restrictions: (profile.dietRestrictions ?? []).map((r) => r.trim()).filter(Boolean),
        likes: prefs.filter((p) => p.rating === 1).map((p) => recipeName(p.recipeId)),
        dislikes: prefs.filter((p) => p.rating === -1).map((p) => recipeName(p.recipeId)),
        avoidNames,
        trainingDay: !day.rest,
        dateNote: date,
      },
      onStatus ? { onTool: onStatus } : undefined,
    )

    await programService.setProgramMeals(record.id, date, JSON.stringify(res.meals))
    return res.meals
  }

  /** 删除方案（其未完成日程一并清除）；返回清除条数。
   * 删除的是当前生效方案时，每日目标还原为档案默认值 */
  async function remove(id: number): Promise<number> {
    const wasActive = active.value?.id === id
    const removed = await programService.deleteProgram(id)
    await useTodoStore().loadAll()
    await load()
    if (wasActive) await restoreGoalTargets()
    return removed
  }

  /**
   * 组装采购清单（方案页弹层与聊天工具共用）：未来 fromDays 天的菜单实时聚合
   * （AI 缓存优先、模板回落，方案期外空天自然跳过），叠加 shopping_checks 勾选状态。
   */
  async function buildShopping(record: ProgramRecord, fromDays = 7): Promise<ShoppingBuild> {
    const from = todayStr()
    const blob = parseBlob(record)
    const horizonTo = addDays(from, Math.min(14, Math.max(1, Math.round(fromDays))) - 1)
    const end = programEndDate(blob)
    const to = end != null && end < horizonTo ? end : horizonTo
    if (to < from) throw new Error('方案期已结束，没有待采购的日期')

    if (!foodCatById.size && !foodCatByName.size) {
      try {
        const foods = await dietService.listFoods(undefined, null, 9999)
        for (const f of foods) {
          if (!f.category) continue
          foodCatById.set(f.id, f.category)
          foodCatByName.set(f.name.trim().toLowerCase(), f.category)
        }
      } catch {
        /* 分类缺失按「其他」 */
      }
    }

    let aiByDate = new Map<string, AiMenuMeal[]>()
    try {
      aiByDate = await loadAiMealsRange(record, from, to)
    } catch {
      /* 缓存读取失败按全模板处理 */
    }
    const days: ShoppingDay[] = []
    for (let d = from; ; d = addDays(d, 1)) {
      const ai = aiByDate.get(d)
      const tpl = blob.days.find((x) => x.date === d)
      days.push({
        date: d,
        source: ai ? 'ai' : 'template',
        meals: ai ? ai.map((m) => itemsFromAi(m)) : tpl ? tpl.meals.map((m) => itemsFromTemplate(m)) : [],
      })
      if (d >= to) break
    }
    const rows = buildShoppingList(days, ({ label, foodId }) =>
      foodId != null
        ? foodCatById.get(foodId) ?? null
        : foodCatByName.get(label.trim().toLowerCase()) ?? null,
    )
    let checkSet = new Set<string>()
    try {
      const checks = await programService.listShoppingChecks()
      checkSet = new Set(checks.map((c) => c.itemKey))
    } catch {
      /* 勾选读取失败按全未勾 */
    }
    const aiDays = days.filter((d) => d.source === 'ai').length
    return {
      rows: rows.map((r) => ({ ...r, checked: checkSet.has(r.key) })),
      rangeLabel: `${fmtDateCn(from)} – ${fmtDateCn(to)} · ${days.length} 天`,
      aiDays,
      templateDays: days.length - aiDays,
      from,
      to,
    }
  }

  /** 勾选/取消一个采购项 */
  async function setShoppingCheck(itemKey: string, checked: boolean): Promise<void> {
    await programService.setShoppingCheck(itemKey, checked)
  }

  /** 清空全部勾选；返回清除条数 */
  async function clearShoppingChecks(): Promise<number> {
    return programService.clearShoppingChecks()
  }

  return {
    active,
    history,
    loaded,
    load,
    generateDrafts,
    activate,
    finishActivation,
    adjust,
    archive,
    remove,
    loadDayMeals,
    generateDayMeals,
    loadAiMealsRange,
    buildShopping,
    setShoppingCheck,
    clearShoppingChecks,
  }
})
