<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ListTodo } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import TodoItem from '@/components/todo/TodoItem.vue'
import { useTodoStore } from '@/stores/todo'
import { diffDays, fmtDateCn, todayStr } from '@/utils/date'
import { cmpUrgency } from '@/utils/todo'
import type { Todo } from '@/types'

/** 全部待办清单：按紧急程度排序、按日期分组（今天 → 明天 → 未来 → 历史 → 收件箱）。 */
const store = useTodoStore()
const today = todayStr()

onMounted(() => {
  void store.loadAll()
})

function groupLabel(d: string | null): string {
  if (!d) return '收件箱'
  const diff = diffDays(today, d)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  return fmtDateCn(d)
}

function groupKey(d: string | null): number {
  if (!d) return 1e9
  const diff = diffDays(today, d)
  return diff >= 0 ? diff : 1000 - diff
}

const groups = computed<{ date: string | null; label: string; items: Todo[] }[]>(() => {
  const byDate = new Map<string | null, Todo[]>()
  for (const t of store.allTodos) {
    const arr = byDate.get(t.date) ?? []
    arr.push(t)
    byDate.set(t.date, arr)
  }
  return [...byDate.entries()]
    .sort((a, b) => groupKey(a[0]) - groupKey(b[0]))
    .map(([date, items]) => ({
      date,
      label: groupLabel(date),
      items: [...items].sort(cmpUrgency),
    }))
})
</script>

<template>
  <template v-if="groups.length">
    <section v-for="g in groups" :key="g.date ?? 'inbox'" class="card group">
      <header class="row between ghead">
        <h2 class="glabel">{{ g.label }}</h2>
        <span class="num gcount">{{ g.items.length }}</span>
      </header>
      <ul class="list">
        <TodoItem v-for="t in g.items" :key="t.id" :todo="t" />
      </ul>
    </section>
    <p class="foot t-3 num">共 {{ store.allTodos.length }} 条</p>
  </template>

  <EmptyState
    v-else
    :icon="ListTodo"
    title="还没有待办"
    hint="点右上角「+」，粘贴一句话让 AI 帮你拆成待办"
  />
</template>

<style scoped>
.group {
  margin-bottom: var(--gap-md);
  padding-bottom: var(--sp-4);
}

.ghead {
  padding-bottom: var(--sp-4);
}

.glabel {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.gcount {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.foot {
  text-align: center;
  padding: var(--sp-16) 0 var(--sp-4);
}
</style>
