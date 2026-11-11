/**
 * 危险工具确认层：单例队列 + 超时默认拒绝。
 *
 * 设计约束（plan §4.6 / §5.5 / §13.3）：
 * - 只有 app 工具在 execute 里显式 `await askToolConfirm({...})` 才会弹层；
 *   注册表**不得**按 `dangerous` 统一弹（现有 13 个非 app dangerous 工具行为不变）。
 * - 同一时刻只展示一条，其余排队；没有「始终允许」。
 * - 超时 / 用户关闭 / Esc / 页面转后台 都按拒绝处理，**不重试、不自动放行**。
 * - 无 UI 环境（Node 直跑、SSR）直接返回 false，不挂起。
 *
 * 超时取 60s：比 plan §5.5 的 45s 多一档等待余量（与任务书「60s 超时默认拒绝」一致），
 * 仍远小于 Agent 工具结果 180s 的桥超时。
 */

import { ref } from 'vue'

export interface ToolConfirmRequest {
  /** 短标题，如「运行命令」「删除日程」 */
  title: string
  /** 给用户看的正文：完整 argv、收件人、路径、重复系列警告等 */
  body: string
  /** 逐行详情（动作 / 路径 / 收件人 / 上限等）；可选 */
  details?: string[]
  /** UI 红标 */
  danger?: boolean
}

/** 当前展示中的确认（带内部 id，供队列去重/结算） */
export interface ToolConfirmActive extends ToolConfirmRequest {
  id: number
}

/** 确认等待上限；超时按拒绝。 */
export const TOOL_CONFIRM_TIMEOUT_MS = 60_000

interface PendingConfirm {
  id: number
  req: ToolConfirmRequest
  resolve: (allowed: boolean) => void
  timer: ReturnType<typeof setTimeout> | null
}

const queue: PendingConfirm[] = []
let current: PendingConfirm | null = null
let seq = 0
let visibilityBound = false

/** 当前展示的确认；ToolConfirmSheet 订阅它。 */
export const activeToolConfirm = ref<ToolConfirmActive | null>(null)

/** 有没有可承载抽屉的 UI 环境；Node 直跑直接拒绝，不挂起。 */
function hasUi(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  )
}

/** 页面转后台 = 用户离开，按拒绝（不同确认共享一个监听）。 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') resolveToolConfirm(false)
}

function bindVisibility(): void {
  if (visibilityBound) return
  visibilityBound = true
  document.addEventListener('visibilitychange', onVisibilityChange)
}

// 模块加载时绑定一次；无 UI（Node 直跑）不碰 document。
if (hasUi()) bindVisibility()

function clearCurrentTimer(item: PendingConfirm): void {
  if (item.timer !== null) {
    clearTimeout(item.timer)
    item.timer = null
  }
}

/** 展示队首；已有展示中的条目时什么也不做。 */
function showNext(): void {
  if (current || queue.length === 0) return
  const item = queue.shift()!
  current = item
  activeToolConfirm.value = { id: item.id, ...item.req }
  item.timer = setTimeout(() => settle(item.id, false), TOOL_CONFIRM_TIMEOUT_MS)
}

/** 结算一条确认：只处理当前展示中的，避免旧的延时/重复点击误伤下一条。 */
function settle(id: number, allowed: boolean): void {
  if (!current || current.id !== id) return
  const item = current
  current = null
  clearCurrentTimer(item)
  activeToolConfirm.value = null
  item.resolve(allowed)
  // 队列里还有就接着展示；上一条的离场动画不影响下一条（open 仍为 true）
  showNext()
}

/**
 * 弹一次确认，返回 true = 允许一次 / false = 拒绝（超时、关闭、Esc、转后台都算拒绝）。
 */
export function askToolConfirm(req: ToolConfirmRequest): Promise<boolean> {
  if (!hasUi()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    queue.push({ id: ++seq, req, resolve, timer: null })
    showNext()
  })
}

/** UI 的「允许一次 / 拒绝」和关闭路径统一走这里。 */
export function resolveToolConfirm(allowed: boolean): void {
  if (current) settle(current.id, allowed)
}

/** 测试 / 热重载用：清空排队与展示（不结算已排队的 Promise 会永久挂起，仅供进程退出前）。 */
export function resetToolConfirmQueue(): void {
  if (current) {
    clearCurrentTimer(current)
    current.resolve(false)
  }
  current = null
  while (queue.length > 0) queue.shift()!.resolve(false)
  activeToolConfirm.value = null
}
