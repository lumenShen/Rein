import { onBeforeUnmount, onMounted, ref } from 'vue'

import { todayStr } from '@/utils/date'

const today = ref(todayStr())
let timer: number | null = null
let users = 0

function refresh(): void {
  const next = todayStr()
  if (next !== today.value) today.value = next
}

function onVisible(): void {
  if (document.visibilityState === 'visible') refresh()
}

function acquire(): void {
  if (users === 0) {
    refresh()
    timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
  }
  users++
}

function release(): void {
  users = Math.max(0, users - 1)
  if (users > 0) return
  if (timer !== null) window.clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', refresh)
}

export function useToday() {
  onMounted(acquire)
  onBeforeUnmount(release)
  return { today, refresh }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
    users = 0
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', refresh)
  })
}
