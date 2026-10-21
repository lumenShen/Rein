<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { useTodoStore } from '@/stores/todo'
import VirtualTimeline from './VirtualTimeline.vue'
import TimelineSheet from './TimelineSheet.vue'

/**
 * 日程卡：连续时间线折叠为固定一屏预览（自动锚定今天），
 * 点按把完整时间线（含历史/未来 + 缩放）收进抽屉。
 */
defineProps<{
  date: string
  title?: string
}>()

const store = useTodoStore()
const open = ref(false)

const scheduledCount = computed(() => store.dayTodos.filter((t) => t.startMin != null).length)

onMounted(() => {
  void store.loadAll()
})
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>{{ title ?? '今日日程' }}</h2>
      <span v-if="scheduledCount" class="count num">{{ scheduledCount }} 个安排</span>
    </header>

    <!-- 时间线预览（不展开，整卡点击弹抽屉） -->
    <VirtualTimeline :todos="store.allTodos" :date preview @open="open = true" />
  </section>

  <TimelineSheet :open="open" :todos="store.allTodos" :date @close="open = false" />
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.count {
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
