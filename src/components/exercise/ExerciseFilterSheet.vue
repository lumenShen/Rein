<script setup lang="ts">
import { computed } from 'vue'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { EXERCISE_EQUIPMENT_LABELS, EXERCISE_KIND_LABELS } from '@/config/domain'
import { MUSCLE_GROUPS, MUSCLE_LABELS, type MuscleKey } from '@/config/muscles'
import { EMPTY_EXERCISE_FILTER, filterBadgeCount } from '@/types'
import type { ExerciseEquipment, ExerciseFilterState, ExerciseKind, ExerciseSort } from '@/types'

/**
 * 动作库筛选面板（动作库页与动作选择器共用）：
 * 排序 / 器材 / 类型 / 肌群（可多选，按部位分组）/ 只看收藏。
 * 分类（推拉腿…）留在页面主浏览轴上，不进这个面板。
 */
const props = defineProps<{
  open: boolean
  modelValue: ExerciseFilterState
  /** 结果条数（面板底部实时反馈，避免「筛完是空的」） */
  resultCount?: number
}>()

const emit = defineEmits<{
  close: []
  'update:modelValue': [filter: ExerciseFilterState]
}>()

const SORT_OPTIONS: { value: ExerciseSort; label: string }[] = [
  { value: 'recent', label: '最近使用' },
  { value: 'name', label: '名称' },
  { value: 'sessions', label: '练得最多' },
]

const EQUIPMENT_KEYS: ExerciseEquipment[] = [
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'band',
  'cardio',
  'other',
]

const KIND_KEYS: ExerciseKind[] = ['strength', 'timed', 'cardio']

const activeCount = computed(() => filterBadgeCount(props.modelValue))

function patch(part: Partial<ExerciseFilterState>): void {
  emit('update:modelValue', { ...props.modelValue, ...part })
}

function toggleMuscle(m: MuscleKey): void {
  const cur = props.modelValue.muscles
  patch({ muscles: cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m] })
}

function reset(): void {
  emit('update:modelValue', { ...EMPTY_EXERCISE_FILTER })
}

const chipsOf = (keys: string[], labels: Record<string, string>) =>
  keys.map((k) => ({ key: k, label: labels[k] }))
</script>

<template>
  <SheetModal :open="open" title="筛选与排序" initial-snap="large" @close="emit('close')">
    <div class="field">
      <span class="flabel">排序</span>
      <SegmentedControl
        :options="SORT_OPTIONS"
        :model-value="modelValue.sort"
        @update:model-value="patch({ sort: $event as ExerciseSort })"
      />
    </div>

    <div class="field">
      <span class="flabel">只看收藏</span>
      <label class="rowline row">
        <span class="hint">收藏的动作永远排在列表最前</span>
        <ToggleSwitch
          :model-value="modelValue.onlyFavorite"
          label="只看收藏"
          @update:model-value="patch({ onlyFavorite: $event })"
        />
      </label>
    </div>

    <div class="field">
      <span class="flabel">类型</span>
      <div class="chips row">
        <button class="chip" :class="{ on: modelValue.kind === '' }" @click="patch({ kind: '' })">
          全部
        </button>
        <button
          v-for="k in chipsOf(KIND_KEYS, EXERCISE_KIND_LABELS)"
          :key="k.key"
          class="chip"
          :class="{ on: modelValue.kind === k.key }"
          @click="patch({ kind: k.key as ExerciseKind })"
        >
          {{ k.label }}
        </button>
      </div>
    </div>

    <div class="field">
      <span class="flabel">器材</span>
      <div class="chips row">
        <button class="chip" :class="{ on: modelValue.equipment === '' }" @click="patch({ equipment: '' })">
          全部
        </button>
        <button
          v-for="k in chipsOf(EQUIPMENT_KEYS, EXERCISE_EQUIPMENT_LABELS)"
          :key="k.key"
          class="chip"
          :class="{ on: modelValue.equipment === k.key }"
          @click="patch({ equipment: k.key as ExerciseEquipment })"
        >
          {{ k.label }}
        </button>
      </div>
    </div>

    <div class="field">
      <span class="flabel">
        肌群
        <span class="fsub">可多选，命中任一块即出现</span>
        <button v-if="modelValue.muscles.length" class="clear" @click="patch({ muscles: [] })">
          清除（{{ modelValue.muscles.length }}）
        </button>
      </span>
      <div v-for="g in MUSCLE_GROUPS" :key="g.label" class="mgroup">
        <span class="ghead">{{ g.label }}</span>
        <div class="chips row">
          <button
            v-for="m in g.keys"
            :key="m"
            class="chip"
            :class="{ on: modelValue.muscles.includes(m) }"
            @click="toggleMuscle(m)"
          >
            {{ MUSCLE_LABELS[m] }}
          </button>
        </div>
      </div>
    </div>

    <div class="footer row">
      <button class="reset" :disabled="activeCount === 0" @click="reset">重置</button>
      <button class="done" @click="emit('close')">
        完成<span v-if="resultCount != null"> · {{ resultCount }} 个动作</span>
      </button>
    </div>
  </SheetModal>
</template>

<style scoped>
.field {
  display: block;
  padding: var(--sp-10) 0;
}

.field + .field {
  border-top: 0.5px solid var(--line);
}

.flabel {
  display: block;
  margin-bottom: var(--sp-6);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fsub {
  margin-left: var(--sp-8);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

/* 清除肌群是**可点文字**：字号下限 12（规则 3），不再落 10px 的 Caption_M。
   它是这一行里的次要动作，视觉高度随标签行走；不补伪元素热区 ——
   正下方就是肌群胶囊组，外扩会抢 chip 的点击（同 D10 的取舍）。 */
.clear {
  margin-left: var(--sp-8);
  font-size: var(--fs-caption);
  color: var(--accent);
}

.rowline {
  justify-content: space-between;
  gap: var(--sp-10);
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.chips {
  gap: var(--sp-6);
  flex-wrap: wrap;
}

/* 与动作库页/方案向导同一套 chips：描边白底，选中实底 accent */
.chip {
  padding: var(--sp-6) var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-bold);
}

.mgroup + .mgroup {
  margin-top: var(--sp-8);
}

.ghead {
  display: block;
  margin-bottom: var(--sp-4);
  font-size: var(--fs-micro);
  letter-spacing: 1px;
  color: var(--text-3);
}

.footer {
  gap: var(--sp-10);
  margin-top: var(--sp-14);
}

/* 重置 = 程序页 .cap 胶囊；完成 = .primary 主按钮（accent 实底）。
   两颗同为页脚动作，高度统一取热区下限 44（规则 5）：
   原来「重置」视觉 ~33 高，「完成」~44，并排时一颗明显矮一截。 */
.reset {
  min-height: var(--hit-min);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.reset:disabled {
  opacity: var(--disabled-opacity);
}

.done {
  flex: 1;
  min-height: var(--hit-min);
  padding: var(--sp-12) 0;
  /* 注释自称「完成 = .primary 主按钮」，那就得与真正的 .primary 同形状（胶囊）——
     从前它是 --radius-s 的圆角矩形，与 MuscleCatchupSheet 的 .primary 分道。
     （决策见 docs/exercise-quality-review-2026-10-17.md §8 D5） */
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}
</style>
