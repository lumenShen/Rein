<script setup lang="ts">
import { computed } from 'vue'

import type { GlobalFloatSnapshot } from '@/types'

/**
 * 训练浮条的方块泊车内容（64×64）：状态点 + 一行短统计。
 *
 * 读数取快照的 blob 字段（buildWorkoutSnapshot 直接取 view.blob），与程序内浮条的
 * #blob 插槽同源：跑步 = 时长、课程 = 热身 / 3/8 组 / 30s / 准备这类短读数。
 * 老载荷没有 blob 时回落到 stat（会截断，但不至于空着）。.dot / .bt 的样式与
 * WorkoutFloatContent 那份刻意保持一致 —— FloatDock 的两个插槽是两个组件，
 * scoped 样式不共享，改一边必须同步另一边。
 */
const props = defineProps<{ snapshot: GlobalFloatSnapshot }>()

const dotClass = computed(() => {
  switch (props.snapshot.tone) {
    case 'paused':
      return 'pause'
    case 'done':
      return 'done'
    default:
      return 'live'
  }
})

const text = computed(() => props.snapshot.blob ?? props.snapshot.stat)
</script>

<template>
  <span
    class="dot"
    :class="dotClass"
  />
  <b class="bt num">{{ text }}</b>
</template>

<style scoped>
.bt {
  max-width: 100%;
  padding: 0 var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.live {
  background: var(--c-exercise);
  box-shadow: 0 0 8px color-mix(in srgb, var(--c-exercise) 65%, transparent);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.dot.pause {
  background: var(--warn);
}

@media (prefers-reduced-motion: reduce) {
  .dot.live {
    animation: none;
  }
}
</style>
