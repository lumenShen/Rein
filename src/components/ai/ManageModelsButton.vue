<script setup lang="ts">
import { ChevronRight, SlidersHorizontal } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

/** 全应用统一的「管理模型」入口：胶囊按钮 + 箭头，AI 页与各智能添加弹层共用同一样式。 */
const router = useRouter()

const emit = defineEmits<{ manage: [] }>()

function go(): void {
  emit('manage')
  void router.push('/ai/models')
}
</script>

<template>
  <button class="manage row center" aria-label="管理模型" @click="go">
    <SlidersHorizontal :size="15" />
    管理模型
    <i class="chev row center"><ChevronRight :size="13" :stroke-width="2.5" /></i>
  </button>
</template>

<style scoped>
/* 行内小胶囊按钮：高 28（--control-sm）、左右 12 */
.manage {
  gap: var(--gap-tight);
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  flex: none;
}

.chev {
  /* 尖括号自带视觉内边距，左右各收 2px 才与胶囊内缘同齐 */
  margin: 0 calc(-1 * var(--sp-2));
  color: var(--text-2);
}
</style>
