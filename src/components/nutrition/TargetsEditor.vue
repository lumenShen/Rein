<script setup lang="ts">
import NumberStepper from '@/components/common/NumberStepper.vue'
import type { DailyTargets } from '@/types'

/** 每日目标编辑器：六项步进器。受控组件，持久化策略由父级决定。 */
const props = defineProps<{ modelValue: DailyTargets }>()

const emit = defineEmits<{ 'update:modelValue': [value: DailyTargets] }>()

function set<K extends keyof DailyTargets>(key: K, value: number): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<template>
  <div class="grid">
    <NumberStepper
      :model-value="modelValue.kcal"
      label="能量"
      unit="大卡"
      :step="50"
      :min="800"
      :max="5000"
      @update:model-value="set('kcal', $event)"
    />
    <NumberStepper
      :model-value="modelValue.protein"
      label="蛋白质"
      unit="g"
      :step="5"
      :min="20"
      :max="300"
      @update:model-value="set('protein', $event)"
    />
    <NumberStepper
      :model-value="modelValue.carb"
      label="碳水"
      unit="g"
      :step="10"
      :min="50"
      :max="600"
      @update:model-value="set('carb', $event)"
    />
    <NumberStepper
      :model-value="modelValue.fat"
      label="脂肪"
      unit="g"
      :step="5"
      :min="20"
      :max="200"
      @update:model-value="set('fat', $event)"
    />
    <NumberStepper
      :model-value="modelValue.sodiumMg"
      label="钠"
      unit="mg"
      :step="100"
      :min="500"
      :max="5000"
      @update:model-value="set('sodiumMg', $event)"
    />
    <NumberStepper
      :model-value="modelValue.waterMl"
      label="饮水"
      unit="ml"
      :step="100"
      :min="500"
      :max="5000"
      @update:model-value="set('waterMl', $event)"
    />
  </div>
</template>

<style scoped>
.grid {
  /* 与上方说明之间 8（标题与内容一档） */
  margin-top: var(--gap-sm);
  display: grid;
  grid-template-columns: 1fr;
}

.grid > * + * {
  border-top: 0.5px solid var(--line);
}
</style>
