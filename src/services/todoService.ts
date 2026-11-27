/** 待办域 IPC 封装 · 对应 modules/todo/commands.rs */

import type { Todo, TodoInput } from '@/types'
import { invoke } from './transport'

/** 分页查询参数：scope=focus 默认聚焦视图（逾期未完成+未来7天+收件箱）；scope=range 按 start/end 区间 */
export interface TodoPageQuery {
  today: string
  scope?: 'focus' | 'range'
  start?: string
  end?: string
  limit?: number
  offset?: number
}

export interface TodoPage {
  items: Todo[]
  total: number
  limit: number
  offset: number
}

export interface TodoDistribution {
  days: { date: string; count: number }[]
  inbox: number
  overdue: number
}

/** 主页「全部待办」信息流分页参数：today 只参与排序分桶，不参与过滤 */
export interface TodoFeedQuery {
  today: string
  limit?: number
  offset?: number
}

export const todoService = {
  listTodos: (startDate: string, endDate: string) =>
    invoke<Todo[]>('list_todos', { startDate, endDate }),

  /** 全部待办（含收件箱），按日期→时间→优先级排序 */
  listAllTodos: () => invoke<Todo[]>('list_all_todos', {}),

  /** AI 渐进式分页查询（默认聚焦视图，避免全量倾倒） */
  queryTodoPage: (query: TodoPageQuery) =>
    invoke<TodoPage>('query_todos', {
      today: query.today,
      scope: query.scope ?? 'focus',
      start: query.start ?? null,
      end: query.end ?? null,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    }),

  /** 主页全部待办信息流（一页一取，避免全量倾倒）：未完成在前、已完成沉底 */
  queryTodoFeed: (query: TodoFeedQuery) =>
    invoke<TodoPage>('query_todo_feed', {
      today: query.today,
      limit: query.limit ?? 30,
      offset: query.offset ?? 0,
    }),

  /** 全部日程按日分布总览 */
  todoDistribution: (today: string) => invoke<TodoDistribution>('todo_distribution', { today }),

  createTodo: (input: TodoInput) => invoke<Todo>('create_todo', { ...input }),

  updateTodo: (todo: Todo) => invoke<Todo>('update_todo', { todo }),

  restoreTodo: (todo: Todo) => invoke<Todo>('restore_todo', { todo }),

  deleteTodo: (id: number) => invoke<void>('delete_todo', { id }),

  /** 重复实例物化（幂等）：返回本次新增实例数。loadAll 前调用。 */
  syncRecurrences: (today: string) => invoke<number>('sync_recurrences', { today }),
}
