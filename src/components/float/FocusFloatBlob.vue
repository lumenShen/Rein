<script setup lang="ts">
import { computed } from 'vue'

import type { GlobalFloatSnapshot } from '@/types'

/**
 * 专注浮条的方块泊车内容（64×64）：状态点 + mm:ss 读数。
 *
 * 与 FocusFloatContent 分文件是契约要求的四个共享组件之一；两边的 .dot / .bt 样式
 * 刻意各写一份 —— FloatDock 的 #bar / #blob 是两个不同组件，scoped 样式不能互相继承。
 * 抄的是同一组令牌与同一套类名，改读数样式时**两处必须一起改**（改错只会表现为
 * 泊车方块与横条的字号 / 颜色对不上，评审很难一眼看出来）。
 */
const props = defineProps<{ snapshot: GlobalFloatSnapshot }>()

/** 与 FocusFloatContent 的 dotClass 同源：work / break / paused 三态，done 兜底暂停色 */
const dotClass = computed(() => {
  switch (props.snapshot.tone) {
    case 'work':
      return 'work'
    case 'break':
      return 'brk'
    default:
      return 'paused'
  }
})
</script>

<template>
  <span
    class="dot"
    :class="dotClass"
  />
  <b class="bt num">{{ snapshot.stat }}</b>
</template>

<style scoped>
.bt {
  max-width: 100%;
  padding: 0 var(--gap-tight);
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
}

.dot.work {
  background: var(--cat-work);
  box-shadow: 0 0 8px color-mix(in srgb, var(--cat-work) 65%, transparent);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.dot.brk {
  background: var(--cat-general);
}

.dot.paused {
  background: var(--warn);
}

@media (prefers-reduced-motion: reduce) {
  .dot.work {
    animation: none;
  }
}
</style>
