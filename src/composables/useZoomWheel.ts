import type { Ref } from 'vue'

/**
 * Ctrl/⌘ + 滚轮缩放一个数值（时间轴的两个视图共用）。
 *
 * 缩放比例固定 1.15：它对应「每滚一格约 15%」的体感，和系统滚轮步长无关；
 * 上下限由视图自己给（周甘特与日画布的密度完全不同），这里只收边界钳制。
 */
export function useZoomWheel(px: Ref<number>, min: number, max: number) {
  function zoom(factor: number): void {
    px.value = Math.min(Math.max(px.value * factor, min), max)
  }

  function onWheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    zoom(e.deltaY > 0 ? 1 / 1.15 : 1.15)
  }

  return { zoom, onWheel }
}
