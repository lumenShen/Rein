<script setup lang="ts">
import { computed } from 'vue'

import EmptyState from '@/components/common/EmptyState.vue'
import type { ScheduleEntry } from '@/types'
import { unitLabel } from '@/utils/campusTimeAxis'
import { nowMin, todayStr } from '@/utils/date'
import { CalendarOff } from 'lucide-vue-next'

/**
 * 日视图 · 一天的上课清单，按真实时间排列。
 *
 * 左侧时间柱显示**实际上课时间**（教务的 `startTime`/`endTime`）与节次区间，
 * 右侧是课程卡片；当天正在进行的那一节会被高亮，并标出剩余时间。
 */
const props = defineProps<{
  entries: ScheduleEntry[]
  date: string
}>()

/** 点某一行 → 交给课表页拉该时段的教务课程详情 */
const emit = defineEmits<{ select: [entry: ScheduleEntry] }>()

const now = nowMin()
const isToday = computed(() => props.date === todayStr())

/**
 * 只取当天的课。**必须自己过滤而不是直接用 props.entries**：
 * 切到日视图会异步重载该日区间，在重载回来之前 store 里仍是上一个视图的数据，
 * 直接渲染会出现「9月16日 周三」下列着周一/周二的课这种串台。
 */
const list = computed(() => props.entries.filter((e) => e.date === props.date))

function startMin(e: ScheduleEntry): number {
  const [h, m] = e.session.startTime.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function endMin(e: ScheduleEntry): number {
  const [h, m] = e.session.endTime.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 正在进行：今天的课，且当前时刻落在区间内 */
function isNow(e: ScheduleEntry): boolean {
  return isToday.value && now >= startMin(e) && now < endMin(e)
}

/** 下一节：今天的课，还没开始 */
function isNext(e: ScheduleEntry, i: number): boolean {
  if (!isToday.value) return false
  if (now >= startMin(e)) return false
  return i === 0 || now >= endMin(list.value[i - 1]!)
}

const activeIndex = computed(() => list.value.findIndex((e) => isNow(e)))

function colorOf(e: ScheduleEntry): string {
  return e.session.color ?? 'var(--cat-class)'
}

function place(e: ScheduleEntry): string {
  return [e.session.building, e.session.room].filter(Boolean).join(' ')
}
</script>

<template>
  <div class="day">
    <!-- 日期只由页头那颗可点的日期按钮承载（同一句日期在上下相邻两处各出现一遍，
           而它还能点回今天）—— 这里只在「今天」时留一枚胶囊当锚点，非今天整行不渲染 -->
    <p v-if="isToday" class="date-line">
      <span class="today-tag">今天</span>
    </p>

    <EmptyState
      v-if="list.length === 0"
      :icon="CalendarOff"
      title="这天没有课"
      hint="好好休息，或者去看看别的日期"
    />

    <ul v-else class="list">
      <li
        v-for="(e, i) in list"
        :key="e.session.id + (e.holiday ?? '')"
        class="row"
        :class="{ now: i === activeIndex, next: isNext(e, i) }"
        :style="{ '--blk': colorOf(e) }"
        role="button"
        tabindex="0"
        :aria-label="`${e.session.courseName} 课程详情`"
        @click="emit('select', e)"
        @keydown.enter.prevent="emit('select', e)"
        @keydown.space.prevent="emit('select', e)"
      >
        <!-- 左侧时间柱：实际上课时间 + 节次 -->
        <div class="rail">
          <span class="t1">{{ e.session.startTime }}</span>
          <span class="line" />
          <span class="t2">{{ e.session.endTime }}</span>
          <span class="unit">{{ unitLabel(e.session.startUnit, e.session.endUnit) }}</span>
        </div>

        <div class="card">
          <div class="top">
            <span v-if="e.holiday" class="hd-tag" :class="e.holiday">{{ e.holiday === 'off' ? '假' : '调' }}</span>
            <span class="name">{{ e.session.courseName }}</span>
            <span v-if="i === activeIndex" class="badge">进行中</span>
            <span v-else-if="isNext(e, i)" class="badge soft">下一节</span>
          </div>
          <p v-if="place(e)" class="meta">{{ place(e) }}</p>
          <p v-if="e.session.teachers.length" class="meta">
            {{ e.session.teachers.join('、') }}
          </p>
          <p class="meta dim">
            <span v-if="e.session.weeksStr">第 {{ e.session.weeksStr }} 周</span>
            <span v-if="e.session.credits"> · {{ e.session.credits }} 学分</span>
            <span v-if="e.session.courseType"> · {{ e.session.courseType }}</span>
          </p>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.day {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.date-line {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  padding: 0 var(--sp-2);
}

.today-tag {
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  /* soft 底上的文字蓝用 strong 档（--accent 压 accent-soft 达不到 AA） */
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-8);
}

.list {
  display: flex;
  flex-direction: column;
  /* 每节课在日视图里是一张卡：卡间距取 12 */
  gap: var(--gap-md);
}

/* 课程色整面 soft tint（课表三视图同一档浓度：基础 12% / 强调 20%），
   不再靠左边框做强调条（side-tab 收编）—— 色相由整面 tint 承担，
   与周视图 .blk、月视图 .chip 是同一套画法。 */
.row {
  display: flex;
  gap: var(--gap-md);
  background: color-mix(in srgb, var(--blk) 12%, var(--surface));
  /* 卡片档 16：课程块在日视图里是一张张卡，20 会让它们读成按钮 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--sp-12) var(--pad-card);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 「正在进行」= tint 加浓一档（三视图共用的强调级） */
.row.now {
  background: color-mix(in srgb, var(--blk) 20%, var(--surface));
}

.row:active {
  transform: scale(0.995);
}

.rail {
  flex: none;
  width: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-text);
}

.t1 {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-title);
}

/* 时间柱中间那条竖线，把起止时刻连起来 */
.line {
  width: 1.5px;
  flex: 1;
  min-height: 8px;
  background: var(--blk);
  opacity: 0.35;
  /* 1.5px 宽的竖线：满圆角让两端是圆的，与时间柱的胶囊语言一致 */
  border-radius: var(--radius-full);
}

.t2 {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-title);
}

.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-top: var(--gap-text);
  white-space: nowrap;
}

.card {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.top {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.name {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  line-height: var(--lh-title);
  word-break: break-all;
}

.badge {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-8);
}

.badge.soft {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

/* 「假 / 调」标记：排在课名之前，一眼看出这天被调过 */
.hd-tag {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-8);
}

.hd-tag.off {
  color: var(--warn-strong);
  background: color-mix(in srgb, var(--warn) 16%, var(--surface));
}

.hd-tag.makeup {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.meta {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-subtitle);
}

.meta.dim {
  color: var(--text-3);
  font-size: var(--fs-micro);
}
</style>
