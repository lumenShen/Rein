import { onBeforeUnmount, ref } from 'vue'

/**
 * 两步确认（点第一次进入待确认，限时内再点一次才执行）。
 *
 * 抢课任务行在「全部任务」与面板里各有一份完全相同的实现：4s 超时、第二次点击
 * 才真正移除。抽成 composable 后两处的误触窗口与视觉待确认态不会各自漂移。
 */
export function useTwoStepConfirm(timeoutMs = 4000) {
  const pending = ref<number | null>(null)
  let timer: number | null = null

  function reset(): void {
    if (timer != null) window.clearTimeout(timer)
    timer = null
    pending.value = null
  }

  /** 同一个 id 再点一次即执行；换一条则把待确认态挪过去并重新计时 */
  function ask(id: number, confirm: () => void): void {
    if (timer != null) window.clearTimeout(timer)
    if (pending.value === id) {
      reset()
      confirm()
      return
    }
    pending.value = id
    timer = window.setTimeout(() => (pending.value = null), timeoutMs)
  }

  onBeforeUnmount(reset)
  return { pending, ask, reset }
}
