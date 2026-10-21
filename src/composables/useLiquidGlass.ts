import { computed, type ComputedRef } from 'vue'

import { liquidGlass } from '@/system/perf'

let seq = 0

/**
 * 悬浮件真折射材质（超高 / 极致档）：把元素自己的 backdrop-filter 从 blur() 换成
 * `url(#…)`，底 / 受光边 / 光学层仍由 `.glass-surface` 的令牌给。
 *
 * 滤镜定义由 common/GlassFilter 按同一个 id 渲染；量尺默认是父元素（浮条自己是
 * `.dock-body` / `.hud`）。五条悬浮件（运动 / 录音 / 专注 / 语音 / 抢课）现在共用
 * 这一份 —— 此前每个组件各抄一遍 id 生成与 style 组装，曾出现某条漏挂 saturate。
 */
export function useLiquidGlass(): {
  glassFilterId: string
  glassStyle: ComputedRef<Record<string, string> | undefined>
} {
  const glassFilterId = `glass-filter-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const glassStyle = computed<Record<string, string> | undefined>(() => {
    if (!liquidGlass.value) return undefined
    const filter = `url(#${glassFilterId}) saturate(var(--glass-sat))`
    return { backdropFilter: filter, WebkitBackdropFilter: filter }
  })
  return { glassFilterId, glassStyle }
}
