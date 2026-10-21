import { onBeforeUnmount, ref, watch, type Ref, type WatchSource } from 'vue'

import { motionOn } from '@/system/motion'

/**
 * 抽屉 / 详情页的「数据入场」：打开后双 rAF 再置位，让首帧先以零态上屏，
 * 供 CSS 的 clip-path / transform 过渡从零生长。
 *
 * 之所以要双 rAF：单 rAF 仍在同一帧的样式计算之前，过渡起点会被合并掉；
 * 这是全应用三处详情卡此前各自手写的一段，抽出来避免再出现「一处双 rAF、
 * 一处直接置位」的节奏差。
 */
export function useGrowOnOpen(open: WatchSource<boolean>): Ref<boolean> {
  const grown = ref(false)
  let raf1 = 0
  let raf2 = 0

  function cancel(): void {
    if (raf1) cancelAnimationFrame(raf1)
    if (raf2) cancelAnimationFrame(raf2)
    raf1 = 0
    raf2 = 0
  }

  watch(open, (isOpen) => {
    cancel()
    if (!isOpen) {
      grown.value = false
      return
    }
    // 动效关闭时直接给终态：省掉两帧等待，也避免「关了动效反而晚两帧才出现」
    if (!motionOn.value) {
      grown.value = true
      return
    }
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        grown.value = true
      })
    })
  })

  onBeforeUnmount(cancel)
  return grown
}
