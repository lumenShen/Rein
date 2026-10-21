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
 * 沉浸模式 · 临时换动作选择面板（嵌套抽屉）。
 * 候选池 = 动作库内同类型的全部动作（唯一真源，不再从各课程的动作条目里翻找）。
 * 只允许换成与被替换动作同类型（力量↔力量、计时↔计时）的动作：
 * 编排（组数/次数/休息/热身）沿用本课程原动作，换类型会让参数对不上。
 */
const props = defineProps<{
  open: boolean
  /** 只列出该类型的动作 */
  kind: PlanExerciseKind
  /** 被替换动作的动作库 id（同名候选无意义，直接排除） */
  currentId: string
}>()

const emit = defineEmits<{
  close: []
  pick: [exercise: SwapCandidate]
}>()

const lib = useExerciseLibStore()
const kw = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    kw.value = ''
    void lib.ensureLoaded()
  },
)

const candidates = computed(() =>
  lib.list.filter((e) => e.kind === props.kind && !e.hidden && e.id !== props.currentId),
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

function metaOf(e: (typeof candidates.value)[number]): string {
  const bits = [EXERCISE_CATEGORY_LABELS[e.category]]
  if (e.equipment) bits.push(EXERCISE_EQUIPMENT_LABELS[e.equipment])
  if (e.sessions > 0) bits.push(`练过 ${e.sessions} 次`)
  return bits.join(' · ')
}
</script>

<template>
  <SheetModal :open="open" :title="`换成哪个${KIND_LABEL[kind]}？`" initial-snap="large" @close="emit('close')">
    <!-- 规则说明收进标题栏 InfoHint：用户打开抽屉是来挑动作的，两句式灰字既挡在候选
         列表之上又读不清。面上只留标题、搜索框与一枚结论胶囊 -->
    <template #action>
      <InfoHint title="换动作的规则">
        <p>候选来自动作库。</p>
        <p>只替换动作本体，组数 / 次数 / 组间休息沿用本课程当前动作。</p>
      </InfoHint>
    </template>
    <div class="searchrow row">
      <Search :size="15" />
      <input v-model="kw" class="search" type="search" placeholder="搜索动作（动作库）" aria-label="搜索动作" />
    </div>

    <p class="tags">
      <StatusChip tone="neutral" size="sm">组数 / 次数 / 组间休息沿用当前动作</StatusChip>
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
