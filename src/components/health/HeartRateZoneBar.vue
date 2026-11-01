<script setup lang="ts">
/**
 * 心率区间条（五段色阶 + 位置三角）。
 *
 * 单独抽出来是因为它要在两种尺寸里出现：心率抽屉里的标准条，和训练顶栏
 * 心率胶囊里的紧凑条。两处的定位算法必须是同一份 —— 不然「同一个心率，
 * 抽屉里在 62%，顶栏里在 58%」这种错位没人能解释。
 *
 * 位置按 50%–100% HRmax 连续映射（五个区间各占 20%），用 cqw 把 --p 换算成
 * 像素位移，transition 只作用于 transform。
 */
import { computed } from 'vue'

import { HR_ZONES } from '@/config/hr'

const props = withDefaults(
  defineProps<{
    bpm?: number | null
    maxHr?: number | null
    /** 有实时样本才画三角；否则整条变淡作图例 */
    live?: boolean
    /** 紧凑档：条更细、三角更小（训练顶栏胶囊用） */
    compact?: boolean
  }>(),
  { bpm: null, maxHr: null, live: false, compact: false },
)

/** 0..1：50% HRmax → 0，100% HRmax → 1 */
const progress = computed<number | null>(() => {
  if (props.bpm == null || !props.maxHr) return null
  const ratio = props.bpm / props.maxHr
  return Math.min(1, Math.max(0, (ratio - 0.5) / 0.5))
})

const showMarker = computed(() => props.live && progress.value != null)
</script>

<template>
  <span class="hzb" :class="{ dim: !showMarker, compact }" aria-hidden="true">
    <i
      v-for="z in HR_ZONES"
      :key="z.zone"
      class="hzb-seg"
      :style="{ background: `var(${z.colorVar})` }"
    />
    <span
      v-if="showMarker"
      class="hzb-marker"
      :style="{ '--p': progress ?? 0 }"
    />
  </span>
</template>

<style scoped>
.hzb {
  position: relative;
  display: flex;
  gap: 3px;
  width: 100%;
  height: 10px;
  /* cqw 的基准：三角按 --p 换算成这条的真实像素宽度 */
  container-type: inline-size;
}

.hzb.compact {
  gap: 2px;
  height: 4px;
}

.hzb-seg {
  flex: 1;
  border-radius: var(--radius-full);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 没有实时样本时整条变淡：它退化成图例，不再假装是当前读数 */
.hzb.dim .hzb-seg {
  opacity: 0.35;
}

.hzb-marker {
  position: absolute;
  left: 0;
  bottom: -6px;
  width: 0;
  height: 0;
  margin-left: -5px;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  /* border-bottom 的三角尖朝上，顶住条的底边 */
  border-bottom: 6px solid var(--text-1);
  transform: translateX(calc(var(--p) * 100cqw));
  transition: transform var(--dur-slow) var(--ease-out);
  will-change: transform;
}

.hzb.compact .hzb-marker {
  bottom: -3px;
  margin-left: -3px;
  border-left-width: 3px;
  border-right-width: 3px;
  border-bottom-width: 4px;
}
</style>
