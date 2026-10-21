<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

import { useTodoStore } from '@/stores/todo'
import { fmtMonthTitle, monthGrid, todayStr } from '@/utils/date'

/** 月视图：todolist 完成度日历。格子下方进度条 = 当日完成比例。 */
const props = defineProps<{
  selected?: string
}>()

const emit = defineEmits<{ select: [date: string] }>()

const store = useTodoStore()
const today = todayStr()

const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth() + 1)

const cells = computed(() => monthGrid(year.value, month.value))
const title = computed(() => fmtMonthTitle(year.value, month.value))

function shift(n: number): void {
  const d = new Date(year.value, month.value - 1 + n, 1)
  year.value = d.getFullYear()
  month.value = d.getMonth() + 1
}

async function load(): Promise<void> {
  const lastDay = new Date(year.value, month.value, 0).getDate()
  const pad = (x: number) => String(x).padStart(2, '0')
  await store.loadStats(`${year.value}-${pad(month.value)}-01`, `${year.value}-${pad(month.value)}-${pad(lastDay)}`)
}

onMounted(load)
watch([year, month], load)

const ratioOf = (date: string): number => {
  const s = store.statsByDate[date]
  if (!s || s.total === 0) return 0
  return s.done / s.total
}
</script>

<template>
  <div>
    <header class="row between head">
      <button class="nav" aria-label="上一月" @click="shift(-1)"><ChevronLeft :size="16" /></button>
      <b class="title">{{ title }}</b>
      <button class="nav" aria-label="下一月" @click="shift(1)"><ChevronRight :size="16" /></button>
    </header>

    <ul class="grid">
      <li v-for="(c, i) in cells" :key="i">
        <button
          type="button"
          class="cell col center"
          :class="{
            today: c.date === today,
            selected: c.date && c.date === props.selected,
          }"
          :disabled="!c.date"
          @click="c.date && emit('select', c.date)"
        >
          <span v-if="c.date" class="num day">{{ c.day }}</span>
          <span v-if="c.date" class="bar">
            <i :style="{ '--p': `${ratioOf(c.date) * 100}%` }" :class="{ full: ratioOf(c.date) >= 1 }" />
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* 月份导航行：与周视图共用同一套「页头 → 内容」节奏（10px + 本行），
   因此做成紧凑单行，不再在卡片里撑出第二条 38px 高的页头。 */
.head {
  margin-bottom: var(--gap-sm);
}

.title {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
}

.nav {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--sp-2);
}

.grid > li {
  aspect-ratio: 1 / 1.06;
}

/* 格子是真按钮：键盘可达，按压反馈走全局 :active */
.cell {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.cell:disabled {
  cursor: default;
}

.cell.selected {
  background: var(--accent-soft);
}

.day {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.cell.today .day {
  color: var(--accent);
  font-weight: var(--fw-bold);
}

.bar {
  width: 16px;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
  margin-top: var(--gap-tight);
}

.bar i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.bar i.full {
  background: var(--ok);
}
</style>
