<script setup lang="ts">
import type { WorkoutSource } from '@/types'

/**
 * 「这条运动记录是谁的」标签：手机同步进来的第三方数据标出来，本机记的默认不标。
 *
 * 为什么本机记录不标：在绝大多数面上本机记录是常态，逐行打「本机」只是噪声
 * （读起来像每一行都在替自己辩解）；而第三方记录**必须先说清楚**，因为两者归属不同 ——
 * 在 Rein 里改它会被下次同步覆盖回去、删它也不会动 Health Connect 里那份。
 * 只有「第三方数据管理」页要逐行标出两边（那里的列表本来就按来源分块），
 * 所以本机标签做成可选项。
 */
const props = defineProps<{
  source: WorkoutSource
  /** 本机记录也标出来 */
  showLocal?: boolean
}>()

const LABEL: Record<WorkoutSource, string> = {
  health_connect: '手机同步',
  local: '本机',
}
</script>

<template>
  <span v-if="props.source === 'health_connect' || props.showLocal" class="tag" :class="props.source">
    {{ LABEL[props.source] }}
  </span>
</template>

<style scoped>
.tag {
  flex: none;
  padding: var(--sp-2) var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-body);
  white-space: nowrap;
}

/* 第三方数据用强调色：它才是需要解释的那一类 */
.tag.health_connect {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
</style>
