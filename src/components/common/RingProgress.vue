<script setup lang="ts">
import { computed } from 'vue'

/** 单个进度环（Apple 活动环的基本单元）。value/max 可超过 1，环封顶但保留溢出信息。 */
const props = withDefaults(
  defineProps<{
    value: number
    max?: number
    colorVar: string
    size?: number
    stroke?: number
  }>(),
  { max: 1, size: 64, stroke: 10 },
)

const R = computed(() => 50 - props.stroke / 2 - 1)
const C = computed(() => 2 * Math.PI * R.value)
const pct = computed(() => Math.min(Math.max(props.value / props.max, 0), 1))
const dashOffset = computed(() => C.value * (1 - pct.value))
</script>

<template>
  <div class="ring" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg viewBox="0 0 100 100">
      <circle class="track" cx="50" cy="50" :r="R" :stroke-width="stroke" />
      <circle
        class="val"
        cx="50"
        cy="50"
        :r="R"
        :stroke-width="stroke"
        :stroke="`var(${colorVar})`"
        :stroke-dasharray="C"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
    <div class="center"><slot /></div>
  </div>
</template>

<style scoped>
.ring {
  position: relative;
}

svg {
  width: 100%;
  height: 100%;
}

.track {
  fill: none;
  stroke: var(--ring-track);
}

.val {
  fill: none;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 50px 50px;
  /* 环是跟手补数控件：700ms 追不上数值变化；dashoffset 是描边位移，前快后缓
     才像弧长在长 → --dur-slow 配 --ease-out */
  transition: stroke-dashoffset var(--dur-slow) var(--ease-out);
}


.center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>
