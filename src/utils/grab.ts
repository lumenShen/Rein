import type { GrabTask } from '@/types'

/**
 * 抢课任务标题 —— 任务行 / 结果行 / 志愿组共用的一条命名规矩。
 *
 * `lessonName` 里存的是「这个班怎么和同门课其他班区分」（引擎写进去的，项目名优先）：
 * 体育课 8 个项目的课程名全都叫「大学体育1」，只写课程名，用户认不出哪条是羽毛球。
 * 但它**只在真有新信息时才拼上去**：教学班名常常以课程名开头
 * （「大学体育1-花江校区-26级（3院…）」），再拼一遍只会把标题撑长。
 */
export interface GrabSquad {
  key: string
  name: string
  members: GrabTask[]
}

/**
 * 按 `groupKey` 聚成志愿组，组内按志愿序号升序。
 *
 * 面板要展示「已取消」的成员（它们是任务单历史的一部分），选课页的「加入某一组」
 * 只该看见还活着的组 —— 这个差异用 `includeCancelled` 显式表达，而不是两处各写一遍
 * 循环、哪天改了一边另一边悄悄漂移。
 */
export function groupGrabSquads(
  tasks: readonly GrabTask[],
  opts: { includeCancelled?: boolean } = {},
): GrabSquad[] {
  const byKey = new Map<string, GrabSquad>()
  for (const t of tasks) {
    const key = t.groupKey?.trim()
    if (!key) continue
    if (!opts.includeCancelled && t.status === 'cancelled') continue
    const squad = byKey.get(key) ?? { key, name: t.groupName?.trim() || '志愿组', members: [] }
    squad.members.push(t)
    byKey.set(key, squad)
  }
  for (const squad of byKey.values()) {
    squad.members.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  }
  return [...byKey.values()]
}

export function grabTaskTitle(t: Pick<GrabTask, 'courseName' | 'lessonName' | 'lessonId'>): string {
  const course = t.courseName?.trim()
  const label = t.lessonName?.trim()
  if (!course) return label || `教学班 ${t.lessonId == null ? '' : String(t.lessonId)}`
  if (!label || label === course || label.startsWith(course)) return course
  return `${course} · ${label}`
}
