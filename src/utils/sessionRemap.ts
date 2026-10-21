/**
 * 会话快照的键迁移（纯函数）：把以**旧课程条目 id** 为键的进度迁到当前课程的新条目上。
 *
 * ## 为什么需要
 *
 * 快照里的 `doneSets` / `extraSets` / `skippedSets` / `exerciseOverrides` 都以
 * `PlanExercise.id` 为键 —— 那是前端生成的 UUID，不是稳定标识。课程可以被整体覆盖
 * （AI 的 `upsert_plan` 重写、手动增删重排），一次覆盖就把所有条目 id 换掉。
 *
 * 而中断恢复是**按 planId 从课程库重建 plan** 的（见 `stores/session.ts::applyRecord`）：
 * 重建出来的条目全是新 id，接着 `alignProgressToPlan` 只保留「键在当前课程里」的登记，
 * 于是一场练到一半的训练会被整批清空，下一拍 `touch()` 再把空进度写回快照 ——
 * 那是这一场唯一的一份进度，丢了没有任何恢复途径。
 *
 * 快照里带了 `planRefs`（每个条目当时的 id / 动作库 id / 名称），本函数据此把旧键
 * 迁到新条目：先看 id，再看动作库 id，最后看动作名。匹配不上的键按原逻辑丢弃
 * （动作真的被从课程里删掉了）。
 *
 * 老快照没有 `planRefs`，无法迁移 —— 这是历史限制，调用方按「无需变更」处理。
 */

import type { DoneSet, PlanExercise, PlanExerciseOverride, PlanExerciseRef } from '@/types'

export interface RemapTables {
  doneSets: Record<string, DoneSet[]>
  extraSets: Record<string, number>
  skippedSets: Record<string, number[]>
  /** 换动作覆盖（键同 doneSets） */
  overrides: Record<string, PlanExerciseOverride>
}

/**
 * 返回迁移后的四张表；`null` = 不需要迁移（没有 refs，或键已经全部对得上）。
 * 调用方拿到 null 时不要覆盖原对象。
 */
export function remapPlanKeys(
  refs: PlanExerciseRef[] | undefined,
  exercises: PlanExercise[],
  tables: RemapTables,
): RemapTables | null {
  if (!refs?.length) return null
  const keys = new Set([
    ...Object.keys(tables.doneSets),
    ...Object.keys(tables.extraSets),
    ...Object.keys(tables.skippedSets),
    ...Object.keys(tables.overrides),
  ])
  if (!keys.size) return null

  const known = new Set(exercises.map((e) => e.id))
  const used = new Set<string>()
  const map = new Map<string, string>()
  for (const old of keys) {
    // 键仍在课程里：原样保留（同一动作在课程里出现两次时，第二次走身份匹配）
    if (known.has(old) && !used.has(old)) {
      map.set(old, old)
      used.add(old)
      continue
    }
    const ref = refs.find((r) => r.id === old)
    if (!ref) continue
    // 身份候选按可信度排：动作库 id → 名称 → （换过动作时）换进来的动作身份。
    // 最后两级是为「课程被整体覆盖 + 该条目又临时换过动作」这个叠加场景兜的：
    // 此时课程里的新条目带着的是**换进来的**那个动作，原来的 ref 已经对不上了。
    const ov = tables.overrides[old]
    const tests: ((e: PlanExercise) => boolean)[] = [
      (e) => !!ref.exerciseId && e.exerciseId === ref.exerciseId,
      (e) => e.name === ref.name,
    ]
    if (ov) {
      tests.push((e) => !!ov.exerciseId && e.exerciseId === ov.exerciseId, (e) => e.name === ov.name)
    }
    let hit: PlanExercise | undefined
    for (const t of tests) {
      hit = exercises.find((e) => !used.has(e.id) && t(e))
      if (hit) break
    }
    if (!hit) continue
    map.set(old, hit.id)
    used.add(hit.id)
  }

  // 键一个都没变（课程没被覆盖过）→ 不产生新对象，避免无谓的重渲染
  if ([...map.entries()].every(([old, next]) => old === next)) return null

  const move = <T>(src: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [old, val] of Object.entries(src)) {
      const next = map.get(old)
      if (next) out[next] = val
    }
    return out
  }

  return {
    doneSets: move(tables.doneSets),
    extraSets: move(tables.extraSets),
    skippedSets: move(tables.skippedSets),
    overrides: move(tables.overrides),
  }
}
