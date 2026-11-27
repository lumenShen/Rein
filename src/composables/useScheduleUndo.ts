/**
 * 日程改动撤销：登记移动类改动（date / startMin），toast 提供「撤销」动作回滚。
 * 覆盖画布拖拽、池拖入、快排、AI 应用等位移场景；跨页面共享同一撤销栈。
 * 编辑器里的全量表单保存不在此列（改动面大，语义上不是"挪一下"）。
 */

import { useTodoStore } from '@/stores/todo'
import { useToast } from './useToast'
import { minToHHmm } from '@/utils/date'
import type { Todo } from '@/types'

/** 单条待办的改动前快照 */
interface MoveSnap {
  id: number
  date: string | null
  startMin: number | null
}

interface UndoGroup {
  id: number
  snaps: MoveSnap[]
}

const stack: UndoGroup[] = []
let seq = 0
const MAX_GROUPS = 30

export function useScheduleUndo() {
  const store = useTodoStore()
  const { toast } = useToast()

  const hhmm = (min: number | null) => (min != null ? minToHHmm(min) : '')

  /**
   * 应用一次移动并登记撤销。changed 才落库；返回是否有实际变化。
   * text 缺省时按"日期/时间是否变化"生成提示文案。
   */
  async function applyMove(
    t: Todo,
    next: { date: string | null; startMin: number | null },
    text?: string,
  ): Promise<boolean> {
    const dayChanged = t.date !== next.date
    const timeChanged = t.startMin !== next.startMin
    if (!dayChanged && !timeChanged) return false
    const group: UndoGroup = {
      id: ++seq,
      snaps: [{ id: t.id, date: t.date, startMin: t.startMin }],
    }
    await store.update({ ...t, date: next.date, startMin: next.startMin })
    stack.push(group)
    if (stack.length > MAX_GROUPS) stack.shift()
    const fallback = dayChanged
      ? '已移到另一天'
      : `已挪到 ${hhmm(next.startMin)}`
    toast(text ?? fallback, { action: { label: '撤销', run: () => void undo(group) } })
    return true
  }

  /** 批量应用（AI 排程应用等）：一组改动共享一个「撤销」 */
  async function applyMoves(
    items: { todo: Todo; date: string | null; startMin: number | null }[],
    text: string,
  ): Promise<void> {
    const changed = items.filter(
      (it) => it.todo.date !== it.date || it.todo.startMin !== it.startMin,
    )
    if (!changed.length) return
    const group: UndoGroup = {
      id: ++seq,
      snaps: changed.map((it) => ({ id: it.todo.id, date: it.todo.date, startMin: it.todo.startMin })),
    }
    const applied: MoveSnap[] = []
    try {
      for (const it of changed) {
        const snap = { id: it.todo.id, date: it.todo.date, startMin: it.todo.startMin }
        // 写库可能已成功，随后刷新失败；先登记，才能把这一项也恢复。
        applied.push(snap)
        await store.update({ ...it.todo, date: it.date, startMin: it.startMin })
      }
    } catch (e) {
      // 批量排程不是事务；中途失败时把已经写入的项逐个挪回原位，避免留下半套安排。
      const failed: number[] = []
      for (const snap of applied.reverse()) {
        const cur = store.allTodos.find((t) => t.id === snap.id)
        if (!cur) {
          failed.push(snap.id)
          continue
        }
        try {
          await store.update({ ...cur, date: snap.date, startMin: snap.startMin })
        } catch {
          failed.push(snap.id)
        }
      }
      if (failed.length) {
        const reason = e instanceof Error ? e.message : '未知错误'
        throw new Error(`${reason}；${failed.length} 项未能确认恢复，请检查排程`, { cause: e })
      }
      if (applied.length) {
        const reason = e instanceof Error ? e.message : '未知错误'
        throw new Error(`${reason}；本次排程已恢复`, { cause: e })
      }
      throw e
    }
    stack.push(group)
    if (stack.length > MAX_GROUPS) stack.shift()
    toast(text, { action: { label: '撤销', run: () => void undo(group) } })
  }

  /** 回滚一组改动；待办已删除/再次改动则以当前库内对象为准恢复位置 */
  async function undo(group: UndoGroup): Promise<void> {
    const i = stack.indexOf(group)
    if (i === -1) return
    stack.splice(i, 1)
    for (const snap of group.snaps) {
      const cur = store.allTodos.find((t) => t.id === snap.id)
      if (!cur) continue
      await store.update({ ...cur, date: snap.date, startMin: snap.startMin })
    }
    toast('已撤销')
  }

  return { applyMove, applyMoves }
}
