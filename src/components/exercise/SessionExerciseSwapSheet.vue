<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { EXERCISE_CATEGORY_LABELS, EXERCISE_EQUIPMENT_LABELS } from '@/config/domain'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import type { PlanExerciseKind, SwapCandidate } from '@/types'

/**
 * 沉浸模式 · 动作选择面板（嵌套抽屉）：**换掉**某个未做的动作，或**插入**一个新动作。
 *
 * 候选池 = 动作库内的动作（唯一真源，不再从各课程的动作条目里翻找）。
 * 两种模式的差别只在语义与处方，UI 是同一张面板：
 *  - `swap`：只允许换成与被替换动作**同类型**的动作 —— 编排（组数/次数/休息/热身）
 *    要跟着新动作的库内处方一起换，跨类型会让流程相位对不上（力量 ↔ 计时）；
 *  - `insert`：类型由用户自己选（力量 / 计时 / 有氧），插到这一场的末尾，
 *    处方取库内默认值。
 */
const props = defineProps<{
  open: boolean
  /** 限定类型；不传 = 不按类型限（插入模式由面板内的类型切换决定） */
  kind?: PlanExerciseKind | null
  /** 被替换动作的动作库 id（同名候选无意义，直接排除） */
  currentId?: string
  /** swap = 换掉某个动作（默认）；insert = 插入一个新动作 */
  mode?: 'swap' | 'insert'
}>()

const emit = defineEmits<{
  close: []
  pick: [exercise: SwapCandidate]
}>()

const lib = useExerciseLibStore()
const kw = ref('')
/** 插入模式下用户选的类型（换动作模式用 props.kind，不看这个） */
const insKind = ref<PlanExerciseKind>('strength')

const isInsert = computed(() => props.mode === 'insert')
/** 当前生效的类型过滤：null = 不限 */
const activeKind = computed<PlanExerciseKind | null>(() =>
  isInsert.value ? (props.kind ?? insKind.value) : (props.kind ?? null),
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    kw.value = ''
    insKind.value = 'strength'
    void lib.ensureLoaded()
  },
)

const candidates = computed(() =>
  lib.list.filter(
    (e) =>
      !e.hidden &&
      e.id !== props.currentId &&
      (activeKind.value == null || e.kind === activeKind.value),
  ),
)

const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase()
  if (!q) return candidates.value
  return candidates.value.filter(
    (e) => e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q)),
  )
})

const KIND_LABEL: Record<PlanExerciseKind, string> = {
  strength: '力量动作',
  timed: '计时动作',
  cardio: '有氧动作',
}

const KIND_OPTIONS: PlanExerciseKind[] = ['strength', 'timed', 'cardio']

const title = computed(() =>
  isInsert.value
    ? `插入哪个${KIND_LABEL[activeKind.value ?? 'strength']}？`
    : `换成哪个${KIND_LABEL[(props.kind ?? 'strength') as PlanExerciseKind]}？`,
)

function metaOf(e: (typeof candidates.value)[number]): string {
  const bits = [EXERCISE_CATEGORY_LABELS[e.category]]
  if (e.equipment) bits.push(EXERCISE_EQUIPMENT_LABELS[e.equipment])
  if (e.sessions > 0) bits.push(`练过 ${e.sessions} 次`)
  return bits.join(' · ')
}
</script>

<template>
  <SheetModal :open="open" :title="title" initial-snap="large" @close="emit('close')">
    <!-- 规则说明收进标题栏 InfoHint：用户打开抽屉是来挑动作的，两句式灰字既挡在候选
         列表之上又读不清。面上只留标题、搜索框与一枚结论胶囊 -->
    <template #action>
      <InfoHint :title="isInsert ? '插入动作的规则' : '换动作的规则'">
        <p>候选来自动作库。</p>
        <p v-if="isInsert">插到这一场的末尾，处方（组数 / 次数 / 休息）取该动作在库内的默认值；课程库里的课程不变。</p>
        <p v-else>只替换动作本体，组数 / 次数 / 组间休息一并换成新动作在库内的默认处方（旧动作的处方不适用）。</p>
      </InfoHint>
    </template>
    <div class="searchrow row">
      <Search :size="15" />
      <input v-model="kw" class="search" type="search" placeholder="搜索动作（动作库）" aria-label="搜索动作" />
    </div>

    <!-- 插入模式：类型由用户自己选；换动作模式类型是固定的（跨类型换会让相位对不上） -->
    <div v-if="isInsert && !kind" class="kinds row" role="group" aria-label="动作类型">
      <button
        v-for="k in KIND_OPTIONS"
        :key="k"
        type="button"
        class="kchip"
        :class="{ on: activeKind === k }"
        :aria-pressed="activeKind === k"
        @click="insKind = k"
      >
        {{ KIND_LABEL[k] }}
      </button>
    </div>

    <p class="tags">
      <StatusChip tone="neutral" size="sm">{{ isInsert ? '加到这一场末尾 · 课程库不变' : '处方按新动作的库内默认值' }}</StatusChip>
    </p>

    <ul class="list">
      <li v-for="c in filtered" :key="c.id">
        <button
          type="button"
          class="cand col"
          @click="emit('pick', { exerciseId: c.id, name: c.name, tips: c.tips, muscles: c.muscles })"
        >
          <span class="cname">{{ c.name }}</span>
          <span class="cmeta t-3">{{ metaOf(c) }}</span>
        </button>
      </li>
    </ul>

    <p v-if="filtered.length === 0" class="empty">
      {{ candidates.length === 0 ? '动作库里还没有同类动作' : '没有匹配的动作' }}
    </p>
  </SheetModal>
</template>

<style scoped>
.searchrow {
  gap: var(--sp-6);
  height: 38px;
  padding: 0 var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-3);
}

.search {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

/* 结论胶囊贴在搜索框下：规则全文已收进标题栏 InfoHint，这行只留结论 */
.tags {
  margin-top: var(--sp-10);
  display: flex;
}

/* 类型切换（仅插入模式）：三枚等宽胶囊，选中态走 soft 底 + strong 字
   （实底 --accent 上的白字在暗色只有 3.65:1，浅底上的主色文字一律 strong 档） */
.kinds {
  gap: var(--gap-sm);
  margin-top: var(--sp-10);
}

.kchip {
  flex: 1;
  height: 34px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.kchip.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.list {
  margin-top: var(--sp-10);
}

.cand {
  width: 100%;
  gap: var(--gap-text);
  padding: var(--sp-10) var(--sp-2);
  text-align: left;
  border-radius: var(--radius-s);
}

.list li + li {
  border-top: 0.5px solid var(--line);
}

.cname {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.cmeta {
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty {
  padding: var(--sp-32) 0;
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
