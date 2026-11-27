<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, LoaderCircle, Trash2 } from 'lucide-vue-next'

import { useToast } from '@/composables/useToast'
import { useTwoStepConfirm } from '@/composables/useTwoStepConfirm'
import { useTodoStore } from '@/stores/todo'
import type { Todo } from '@/types'

const props = withDefaults(defineProps<{
  todo: Todo
  iconOnly?: boolean
  label?: string
}>(), {
  iconOnly: false,
  label: '删除',
})

const emit = defineEmits<{ removed: [todo: Todo] }>()
const store = useTodoStore()
const { toast } = useToast()
const { pending, ask } = useTwoStepConfirm()
const removing = ref(false)
const confirming = computed(() => pending.value === props.todo.id)
const canUndo = computed(() => !props.todo.programId && !props.todo.recKey && !props.todo.courseSessionId)

async function remove(): Promise<void> {
  if (removing.value) return
  removing.value = true
  try {
    await store.remove(props.todo)
    toast('已删除待办', canUndo.value
      ? { action: { label: '撤销', run: () => { void store.restore(props.todo) } }, duration: 5000 }
      : undefined)
    emit('removed', props.todo)
  } catch (e) {
    toast(e instanceof Error ? e.message : '删除失败，请重试')
  } finally {
    removing.value = false
  }
}

function onClick(): void {
  ask(props.todo.id, () => void remove())
}
</script>

<template>
  <button
    type="button"
    class="delete-todo"
    :class="{ pending: confirming, busy: removing }"
    :disabled="removing"
    :aria-label="confirming ? `确认删除：${todo.title}` : `删除：${todo.title}`"
    :title="confirming
      ? (canUndo ? '再点一次确认删除；删除后可在提示条中撤销' : '再点一次确认删除；这条记录无法撤销')
      : '删除这条待办'"
    @click="onClick"
  >
    <LoaderCircle v-if="removing" :size="16" class="spin" />
    <Check v-else-if="confirming" :size="16" />
    <Trash2 v-else :size="16" />
    <span v-if="!iconOnly">{{ confirming ? '确认删除' : label }}</span>
  </button>
</template>

<style scoped>
.delete-todo {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-m);
  color: var(--danger-strong);
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.delete-todo.pending {
  background: var(--danger-soft);
}

.delete-todo:disabled {
  opacity: var(--disabled-opacity);
}

.delete-todo:active {
  transform: scale(0.96);
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
