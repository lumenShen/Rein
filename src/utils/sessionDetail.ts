/**
 * 运动详情抽屉的「做组明细」派生（纯函数，无 IPC / 无 store）。
 *
 * ## 为什么数据源是 `workout_sets` 而不是快照里的 `doneSets`
 *
 * `doneSets` 的键是**课程条目 id**（`PlanExercise.id`，前端生成的 UUID）。课程是可以
 * 被整体覆盖的：AI 的 `upsert_plan` 早期版本每次都重建 id，手动编辑课程也可能整套重排。
 * 键一变，这场训练里已完成的每一组就都匹配不上课程动作了 —— 详情页的表现是：
 *
 *   · 课程里的 10 个动作全部显示 `0/N 组` + 一排「未完成」；
 *   · 真实数据被当成「课程里已不存在的动作」，以十几条 `其他动作` 平铺在下面；
 *   · 完成组数分母把两批动作都算了一遍（32/72），还顺带误报一个「提前结束」。
 *
 * 而 `workout_sets` 在保存训练时就把**当时的动作名与动作库 id** 固化了，与课程后续
 * 怎么改无关。所以明细以落库行为准；`doneSets` 只在落库行缺失（老后端 / 旧记录）时
 * 作为退化路径使用。
 *
 * ## 组数口径
 *
 * 分母 = 课程计划组数，但**不低于实际完成组数** —— 「再加一组」是合法操作，
 * 从前会显示成 `5/4 组`（分子大于分母），合计里那一组又被静默丢掉。
 * 现在加练时分母跟着抬到实际值（`5/5`），不再补「未完成」胶囊。
 */

import { setVolumeKg } from './sessionSummary'
import type { DoneSet, PlanExercise, PlanExerciseKind, SessionSetRow } from '@/types'

/** 明细里的一行：一个动作 + 它这场训练的全部组 */
export interface DetailExRow {
  key: string
  /** 命中到的课程条目 id（用于取肌群/处方）；课程里没有则为 null */
  planExerciseId: string | null
  name: string
  kind: PlanExerciseKind
  /** 计划组数（已含「再加一组」；不低于实际完成组数） */
  plannedSets: number
  /** 课程处方次数（逐组次数缺失时回落） */
  reps: number | null
  /** 正式组（热身组已拆出） */
  done: DoneSet[]
  /** 激活热身组（不计入组数与总容量） */
  warmups: DoneSet[]
  /** 热身定义（课程存在时有，用于显示热身次数） */
  warmupDefs?: { weightKg: number; reps: number }[]
  /** 课程里找不到对应动作（课程被整体覆盖 / 动作被删）—— 名字取自落库快照 */
  orphan: boolean
  /**
   * 是否计入「完成组数」的分母。
   *
   * 课程里没有的动作（orphan）**不进分母**：它们是这次训练额外做的，算进分母会让
   * 「完成组数」凭空变多（从前 32 组会被显示成 32/72）。课程里计划了但没做的动作
   * 仍进分母 —— 那才是「提前结束」的真实含义。
   */
  counted: boolean
}

function toDoneSet(s: SessionSetRow): DoneSet {
  return {
    weight: s.weightKg,
    sec: s.sec,
    reps: s.reps,
    warmup: s.warmup,
  }
}

/** 课程条目的三分索引：先按条目 id，再按动作库 id、动作名（同一动作可在一个课程里出现多次，用队列） */
function indexPlan(exercises: PlanExercise[]) {
  const byKey = new Map<string, PlanExercise>()
  const byExId = new Map<string, PlanExercise[]>()
  const byName = new Map<string, PlanExercise[]>()
  for (const e of exercises) {
    byKey.set(e.id, e)
    if (e.exerciseId) {
      const arr = byExId.get(e.exerciseId) ?? []
      arr.push(e)
      byExId.set(e.exerciseId, arr)
    }
    const named = byName.get(e.name) ?? []
    named.push(e)
    byName.set(e.name, named)
  }
  return { byKey, byExId, byName }
}

export function buildDetailRows(
  exercises: PlanExercise[] | null,
  sets: SessionSetRow[] | null | undefined,
  doneSets: Record<string, DoneSet[]>,
): DetailExRow[] {
  const logged = sets ?? []

  /* ---------- 主路径：以落库逐组明细为准 ---------- */
  if (logged.length > 0) {
    // 按 exercise_key 分组，保持落库顺序（= 当时登记的先后）
    const order: string[] = []
    const groups = new Map<string, SessionSetRow[]>()
    for (const s of logged) {
      let arr = groups.get(s.exerciseKey)
      if (!arr) {
        arr = []
        groups.set(s.exerciseKey, arr)
        order.push(s.exerciseKey)
      }
      arr.push(s)
    }

    const plan = indexPlan(exercises ?? [])
    const used = new Set<string>()
    const rows: DetailExRow[] = []

    /** 取该动作在课程里尚未被别的落库组占用的那一条 */
    function match(key: string, exId: string | null, name: string): PlanExercise | null {
      const direct = plan.byKey.get(key)
      if (direct && !used.has(direct.id)) return direct
      if (exId) {
        const hit = plan.byExId.get(exId)?.find((e) => !used.has(e.id))
        if (hit) return hit
      }
      const named = plan.byName.get(name)?.find((e) => !used.has(e.id))
      return named ?? null
    }

    for (const key of order) {
      const list = groups.get(key)!
      const head = list[0]!
      const ex = match(key, head.exerciseId, head.exerciseName)
      if (ex) used.add(ex.id)
      const warmups = list.filter((s) => s.warmup).map(toDoneSet)
      const done = list.filter((s) => !s.warmup).map(toDoneSet)
      rows.push({
        key,
        planExerciseId: ex?.id ?? null,
        // 名字取落库快照：会话中临时换过动作时，课程条目名仍是原动作，落库名才是当天练的
        name: head.exerciseName || ex?.name || '未命名动作',
        kind: (head.kind as PlanExerciseKind) || ex?.kind || 'strength',
        plannedSets: Math.max(ex?.sets ?? 0, done.length),
        reps: ex?.reps ?? null,
        done,
        warmups,
        warmupDefs: ex?.warmups,
        orphan: !ex,
        counted: !!ex,
      })
    }

    // 课程里计划了但一组都没做的动作：仍然列出来（0/N + 未完成）——
    // 「提前结束」的真实含义就在这里，不能因为没数据就把它藏掉
    for (const ex of exercises ?? []) {
      if (used.has(ex.id)) continue
      rows.push({
        key: ex.id,
        planExerciseId: ex.id,
        name: ex.name,
        kind: ex.kind,
        plannedSets: ex.sets,
        reps: ex.reps,
        done: [],
        warmups: [],
        warmupDefs: ex.warmups,
        orphan: false,
        counted: true,
      })
    }
    return rows
  }

  /* ---------- 退化路径：老记录没有落库明细，只能按快照的 doneSets 拼 ---------- */
  const split = (list: DoneSet[]) => ({
    done: list.filter((x) => !x.warmup),
    warmups: list.filter((x) => x.warmup),
  })

  if (!exercises) {
    // 课程已删除：按落盘顺序以序号展示原始做组数据
    return Object.entries(doneSets).map(([, list], i) => {
      const { done, warmups } = split(list)
      return {
        key: `orphan-${i}`,
        planExerciseId: null,
        name: `动作 ${i + 1}`,
        kind: typeof list[0]?.sec === 'number' ? ('timed' as const) : ('strength' as const),
        plannedSets: done.length,
        reps: null,
        done,
        warmups,
        orphan: true,
        counted: true,
      }
    })
  }

  const rows: DetailExRow[] = exercises.map((ex) => {
    const { done, warmups } = split(doneSets[ex.id] ?? [])
    return {
      key: ex.id,
      planExerciseId: ex.id,
      name: ex.name,
      kind: ex.kind,
      plannedSets: Math.max(ex.sets, done.length),
      reps: ex.reps,
      done,
      warmups,
      warmupDefs: ex.warmups,
      orphan: false,
      counted: true,
    }
  })
  const known = new Set(exercises.map((e) => e.id))
  for (const [key, list] of Object.entries(doneSets)) {
    if (known.has(key)) continue
    const { done, warmups } = split(list)
    rows.push({
      key,
      planExerciseId: null,
      name: '其他动作',
      kind: typeof list[0]?.sec === 'number' ? 'timed' : 'strength',
      // 口径同主路径：分母只算正式组，不把热身组混进「计划组数」
      plannedSets: done.length,
      reps: null,
      done,
      warmups,
      orphan: true,
      counted: true,
    })
  }
  return rows
}

/** 统计格用的合计：完成组数 / 总组数 / 总容量 / 计时合计 */
export function detailTotals(rows: DetailExRow[]): {
  volume: number
  timedSec: number
  doneCount: number
  totalCount: number
  earlyEnd: boolean
} {
  let volume = 0
  let timedSec = 0
  let doneCount = 0
  let totalCount = 0
  for (const row of rows) {
    // 只有课程里的动作占分母 —— 课程已删掉的动作是「额外做的」，算进分母就是虚增
    if (row.counted) totalCount += row.plannedSets
    doneCount += row.done.length
    for (const d of row.done) {
      // 容量口径走全端唯一那份 setVolumeKg（逐组登记 → 课程处方 → 1 次兜底），
      // 与训练中的实时容量、总结页容量同源
      volume += setVolumeKg(d.weight, d.reps ?? null, row.reps)
      if (d.sec != null) timedSec += d.sec
    }
  }
  return {
    volume: Math.round(volume),
    timedSec,
    // 课程整门被换掉（一条都匹配不上）时没有分母可言：按实际完成组数收口，
    // 而不是显示「32/0」这种读不出意思的数
    doneCount,
    totalCount: totalCount > 0 ? totalCount : doneCount,
    earlyEnd: totalCount > 0 && doneCount < totalCount,
  }
}
