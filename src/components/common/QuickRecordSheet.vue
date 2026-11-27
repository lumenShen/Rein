<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Camera, Dumbbell, ListTodo, Wallet } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
const SmartAddSheet = defineAsyncComponent(() => import('@/components/common/SmartAddSheet.vue'))
const AddWorkoutSheet = defineAsyncComponent(() => import('@/components/exercise/AddWorkoutSheet.vue'))
import { useFeaturesStore } from '@/stores/features'
import { todayStr } from '@/utils/date'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const features = useFeaturesStore()
const today = computed(() => todayStr())
const child = ref<'food' | 'todo' | 'workout' | null>(null)

const actions = computed(() => [
  ...(features.isEnabled('nutrition')
    ? [{ id: 'food' as const, label: '记饮食', hint: '拍照或说一句', icon: Camera }]
    : []),
  { id: 'todo' as const, label: '加待办', hint: '手动或 AI 提取', icon: ListTodo },
  ...(features.isEnabled('sports')
    ? [{ id: 'workout' as const, label: '记运动', hint: '补录一次训练', icon: Dumbbell }]
    : []),
  ...(features.isEnabled('ledger')
    ? [{ id: 'ledger' as const, label: '记一笔账', hint: '支出、收入或转账', icon: Wallet }]
    : []),
])

async function choose(id: (typeof actions.value)[number]['id']): Promise<void> {
  emit('close')
  await nextTick()
  if (id === 'ledger') {
    void router.push({ name: 'ledger' })
    return
  }
  child.value = id
}
</script>

<template>
  <SheetModal :open="open" title="快速记录" initial-snap="small" @close="emit('close')">
    <div class="quick-grid">
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        class="quick-action"
        @click="choose(action.id)"
      >
        <span class="quick-icon"><component :is="action.icon" :size="22" /></span>
        <span class="quick-copy">
          <b>{{ action.label }}</b>
          <em>{{ action.hint }}</em>
        </span>
      </button>
    </div>
  </SheetModal>

  <SmartAddSheet
    v-if="child === 'food'"
    :open="child === 'food'"
    mode="food"
    :date="today"
    @close="child = null"
  />
  <SmartAddSheet
    v-if="child === 'todo'"
    :open="child === 'todo'"
    mode="todo"
    :date="today"
    @close="child = null"
  />
  <AddWorkoutSheet v-if="child === 'workout'" :open="child === 'workout'" @close="child = null" />
</template>

<style scoped>
.quick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gap-md);
}

.quick-action {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  min-height: var(--row-h-double);
  padding: var(--pad-card);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  text-align: left;
  color: var(--text-1);
}

.quick-icon {
  width: 40px;
  height: 40px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface);
  color: var(--accent);
}

.quick-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.quick-copy b {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
}

.quick-copy em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

@media (max-width: 360px) {
  .quick-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
