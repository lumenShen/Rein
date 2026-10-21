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

/** 主行：教室在前（去哪儿上课是打开课表最先找的答案），教师跟在后面 */
function metaOf(e: ScheduleEntry): string {
  return [place(e), e.session.teachers.join('、')].filter(Boolean).join(' · ')
}

function place(e: ScheduleEntry): string {
  return [e.session.building, e.session.room].filter(Boolean).join(' ')
}

/** 第三行：周次 / 学分 / 类型 —— 背景信息，压到最小一档 */
function facts(e: ScheduleEntry): string {
  const s = e.session
  return [
    s.weeksStr ? `第 ${s.weeksStr} 周` : '',
    s.credits ? `${s.credits} 学分` : '',
    s.courseType ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
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
        <!-- 左侧时间柱：起止时刻 + 节次 -->
        <div class="rail">
          <span class="t1 num">{{ e.session.startTime }}</span>
          <span class="line" />
          <span class="t2 num">{{ e.session.endTime }}</span>
          <span class="unit">{{ unitLabel(e.session.startUnit, e.session.endUnit) }}</span>
        </div>

        <div class="body">
          <div class="top">
            <span v-if="e.holiday" class="hd-tag" :class="e.holiday">{{ e.holiday === 'off' ? '假' : '调' }}</span>
            <span class="name">{{ e.session.courseName }}</span>
            <span v-if="i === activeIndex" class="badge">进行中</span>
            <span v-else-if="isNext(e, i)" class="badge soft">下一节</span>
          </div>
          <p v-if="metaOf(e)" class="meta">{{ metaOf(e) }}</p>
          <p v-if="facts(e)" class="dim">{{ facts(e) }}</p>
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

/* 课程卡：**中性面 + 左侧 3px 色条**。此前整卡铺课程色的 soft tint，一天里几节课
   就是几块彩色底，卡片之间的边界反而要靠阴影去认；色相收进色条后，
   白卡在画布上是一张张清楚的卡，配色只承担「哪门课」这一件事。 */
.row {
  position: relative;
  display: flex;
  /* 时间柱与正文之间取有明显边界的一档（16）——它们是两种信息 */
  gap: var(--gap-lg);
  background: var(--surface);
  /* 卡片档 16：课程块在日视图里是一张张卡，20 会让它们读成按钮 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  /* 左 20 = 色条 3 + 与正文的间隙；其余三边 12/16（紧凑卡的内距） */
  padding: var(--pad-card-tight) var(--pad-card) var(--pad-card-tight) var(--sp-20);
  overflow: hidden;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.row::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--blk);
}

.row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 「正在进行」不再靠整卡染蓝：一道 accent 内描边就能把这一张从同级卡里抬出来，
   而卡片本身仍是中性面（色相只走色条与这条状态描边） */
.row.now {
  box-shadow:
    var(--shadow-card),
    inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 45%, transparent);
}

.row:active {
  transform: scale(0.995);
}

/* 时间柱：开始时刻是主角，中间一条细线把起止连起来，节次垫底 */
.rail {
  flex: none;
  width: var(--sp-44);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-text);
}

.t1 {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-title);
}

/* 时间柱中间那条竖线，把起止时刻连起来 */
.line {
  width: 1.5px;
  flex: 1;
  min-height: var(--sp-8);
  background: var(--blk);
  opacity: 0.45;
  /* 1.5px 宽的竖线：满圆角让两端是圆的，与时间柱的胶囊语言一致 */
  border-radius: var(--radius-full);
}

/* 结束时刻与节次都是补充读数：同一档字号、同一档色阶，靠位置分先后 */
.t2,
.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-title);
  white-space: nowrap;
}

.body {
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
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  line-height: var(--lh-title);
  word-break: break-word;
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

/* 第二行「教室 · 教师」与第三行周次/学分：各占一行、各自省略号。
   层级只靠字号与色阶（16 / 12 / 10 与 text-1 / 2 / 3），不再给副文加粗。 */
.meta {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-subtitle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dim {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-display);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
