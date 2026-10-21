<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import type { ScheduleEntry } from '@/types'
import { parseDate, weekDates, todayStr } from '@/utils/date'
import {
  buildTimeAxis,
  cellKey,
  rowKey,
  rowWeights,
  unitLabel,
  type AxisCell,
  type AxisRow,
} from '@/utils/campusTimeAxis'

/**
 * 周视图 · 7 列 × 节次行。
 *
 * 行 = 时间轴上的**互斥片段**（`@/utils/campusTimeAxis`）：学校给了节次表就画到逐节
 * （第1节 08:00-08:40），只有排课区间就画成若干节的合并。左侧列显示**实际上课时间**，
 * 数据来自教务，不需要我们维护节次表。表头在星期几下方标注具体日期（需求明确要求）。
 *
 * 各校作息不一样（四十分钟一节 / 一上两节 / 上午下午晚上各一套），所以：
 * 1. **课块跨行绘制**：3 节连排的课占三行，和「三节单排」在视觉上终于能分开；
 * 2. **行高按真实时长成比例**：40 分钟的一行不该和 130 分钟的一行一样高；
 * 3. 每个格子**显式落位**（见 `layout`），不靠自动排布 —— 跨行会把自动排布后面的格子挤到
 *    别的列上，课程格一多列就错位。
 *
 * 滚动体验的三个关键决定：
 * 1. **单一滚动容器同时承担 x/y**：斜向滑动自然，不会出现两个滚动上下文互相打架；
 * 2. **双向冻结窗格**：表头 `sticky top`、时间列 `sticky left`、左上角两者兼具，
 *    横滑不丢时间、纵滑不丢星期；
 * 3. **刻意不用 `scroll-snap`**：吸附会在纵向滚动时劫持手势，横滑到头也会触发浏览器的
 *    返回手势。改为 `overscroll-behavior: contain` 把滚动留在网格内，手感更稳。
 */
const props = defineProps<{
  entries: ScheduleEntry[]
  timeSlots: AxisRow[]
  /** 该周内任意一天，用来定位这一周 */
  anchor: string
}>()

/** 点某格课程 → 交给课表页拉该时段的教务课程详情 */
const emit = defineEmits<{ select: [entry: ScheduleEntry] }>()

const today = todayStr()

/** 行高的下限：一行要装下「起止时刻 + 节次」两行字和一个课块，再矮就读不出来了 */
const ROW_MIN = 56

/** 同格多课：>2 门时只画两门，其余折成「+N」提示（课程冲突不是常态，不必为它牺牲可读性） */
const VISIBLE_LIMIT = 2

const days = computed(() => weekDates(props.anchor))

const todayIndex = computed(() => days.value.findIndex((d) => d === today))

/** 行轴：后端同步出的 `timeSlots`。按节次排 —— 时刻只是它的展示，节次才是行的身份 */
const rows = computed<AxisRow[]>(() =>
  [...props.timeSlots].sort((a, b) => a.startUnit - b.startUnit || a.endUnit - b.endUnit),
)

const axis = computed(() => buildTimeAxis(rows.value, props.entries))

/** 行轨：表头 `auto` + 每行 `minmax(下限, 权重 fr)`。节次少时 fr 把可用高度铺满，多时滚动 */
const gridRows = computed(() => {
  const weights = rowWeights(axis.value.rows)
  return ['auto', ...weights.map((w) => `minmax(${ROW_MIN}px, ${w}fr)`)].join(' ')
})

function colorOf(e: ScheduleEntry): string {
  return e.session.color ?? 'var(--cat-class)'
}

/** 教师一行：多教师用「、」连起来（列窄，超出交给 CSS 省略号） */
function teacherOf(e: ScheduleEntry): string {
  return e.session.teachers.filter(Boolean).join('、')
}

/** 地点一行：教室在前 —— 它才是「去哪儿上课」的答案，楼名跟在后面作补充 */
function placeOf(e: ScheduleEntry): string {
  return [e.session.room, e.session.building].filter(Boolean).join(' · ')
}

/** 悬停时的整条读数：格子里放不下 / 被省略号吃掉的部分在这里补全 */
function tipOf(e: ScheduleEntry): string {
  return [e.session.courseName, teacherOf(e), placeOf(e)].filter(Boolean).join(' · ')
}

function dayLabel(d: string): string {
  return `周${'一二三四五六日'[(parseDate(d).getDay() + 6) % 7]}`
}

function monthDay(d: string): string {
  const dt = parseDate(d)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

/** 教学周序号：优先用当天的课自带的周次，没有就留空 */
function weekNoOf(d: string): number | null {
  for (const e of props.entries) {
    if (e.date === d) return e.week
  }
  return null
}

/** 「第 N 周」只标在周界上（第一天 / 周次变化处）：七列重复同一个数字是噪音，
 *  页头副标题里本来就有当前周次 */
const wkShown = computed(() => {
  const flags: boolean[] = []
  let prev: number | null = null
  for (const d of days.value) {
    const w = weekNoOf(d)
    flags.push(w !== null && w !== prev)
    prev = w
  }
  return flags
})

/** 同格多课：只画前两门，其余折成「+N」 */
function visible(list: ScheduleEntry[]): ScheduleEntry[] {
  return list.length > VISIBLE_LIMIT ? list.slice(0, VISIBLE_LIMIT) : list
}

interface SlotTile {
  date: string
  /** 网格列号（1 是时间列，所以日期列从 2 起） */
  col: number
  isToday: boolean
  /** 该行该列的格子；`null` = 这天这一行没课（只铺网格线） */
  cell: AxisCell | null
}

interface LayoutRow {
  key: string
  slot: AxisRow
  /** 网格行号（第 1 行是表头） */
  gridRow: number
  tiles: SlotTile[]
}

/**
 * 渲染布局。**每个格子都显式落位**：课块要跨行绘制，而自动排布遇到跨行会把后续格子
 * 挤到别的列上（同一行的日期就串列了）。显式落位之后，「哪一格画什么」全由这里决定。
 *
 * 三种行：
 * - 组的起点行 → 课块（`grid-row: <起行> / span <跨几行>`）；
 * - 组内其余行 → **不画**（课块已盖住那几行，再画一道边框就横穿课块了）；
 * - 这天没课的行 → 画空格子（`--line` 的网格线靠它铺满整周）。
 */
const layout = computed<LayoutRow[]>(() =>
  axis.value.rows.map((slot, r) => {
    const tiles: SlotTile[] = []
    days.value.forEach((date, i) => {
      const cell = axis.value.cells.get(cellKey(date, r)) ?? null
      if (cell && cell.row !== r) return
      tiles.push({ date, col: i + 2, isToday: i === todayIndex.value, cell })
    })
    return { key: rowKey(slot), slot, gridRow: r + 2, tiles }
  }),
)

const scroller = ref<HTMLElement | null>(null)

/**
 * 打开时把「今天」那一列滚进视野（今天不在本周则滚到周一）。
 * 课表有 7 列，窄屏下默认停在最左边会让用户以为今天没课。
 */
function scrollToToday(): void {
  const el = scroller.value
  if (!el) return
  const grid = el.querySelector<HTMLElement>('.grid')
  const timeCell = el.querySelector<HTMLElement>('.cell.time')
  if (!grid || !timeCell) return
  const idx = days.value.findIndex((d) => d === today)
  if (idx < 0) {
    el.scrollLeft = 0
    return
  }
  // 宽度全部实测：列宽受 minmax 下限与实际可用宽度共同决定，时间列也由 CSS 定死，
  // 任何一处用常量估算都会偏。
  const timeW = timeCell.getBoundingClientRect().width
  const colWidth = (grid.scrollWidth - timeW) / 7
  if (colWidth <= 0) return
  // 一屏能完整放下几天（冻结的时间列要先扣掉）
  const perScreen = Math.max(1, Math.min(7, Math.floor((el.clientWidth - timeW) / colWidth)))
  // **必须对齐到列边界**：按像素居中会让边上那一列只露半截，看起来像渲染坏了
  let first = Math.max(0, Math.min(idx - Math.floor(perScreen / 2), 7 - perScreen))
  // 目标位置可能超出「能滚到的范围」（右边已经没有更多内容）：浏览器会把它夹住，
  // 而夹完的结果**不落在列边界上** —— 左边会留下几像素的前一天残影。
  // 这种情况退到最靠右的列边界：今天照样在屏幕里，只是不贴左边。
  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth)
  if (first * colWidth > maxScroll) {
    first = Math.floor(maxScroll / colWidth)
  }
  el.scrollLeft = first * colWidth
}

onMounted(scrollToToday)
watch(() => props.anchor, scrollToToday)
</script>

<template>
  <div ref="scroller" class="wrap" data-rubber-self>
    <div class="grid" :style="{ gridTemplateRows: gridRows, '--today-col': todayIndex + 1 }">
      <!-- 表头：星期 + 日期；左上角同时冻结两轴 -->
      <div class="cell head corner" :style="{ gridRow: 1, gridColumn: 1 }">时间</div>
      <div
        v-for="(d, i) in days"
        :key="d"
        class="cell head day"
        :class="{ today: i === todayIndex }"
        :style="{ gridRow: 1, gridColumn: i + 2 }"
      >
        <span class="dow">{{ dayLabel(d) }}</span>
        <span class="dnum">{{ monthDay(d) }}</span>
        <span v-if="wkShown[i]" class="wk">第{{ weekNoOf(d) }}周</span>
      </div>

      <!-- 主体：每行 = 时间轴上的一个片段；课块按自己占的节次跨行 -->
      <template v-for="row in layout" :key="row.key">
        <div class="cell time" :style="{ gridRow: row.gridRow, gridColumn: 1 }">
          <span class="t1">{{ row.slot.startTime }}</span>
          <span class="t2">{{ row.slot.endTime }}</span>
          <span class="unit">{{ unitLabel(row.slot.startUnit, row.slot.endUnit) }}</span>
        </div>
        <div
          v-for="t in row.tiles"
          :key="t.date"
          class="cell slot"
          :class="{ today: t.isToday }"
          :style="{
            gridRow: t.cell ? `${row.gridRow} / span ${t.cell.span}` : row.gridRow,
            gridColumn: t.col,
          }"
        >
          <div v-if="t.cell" class="blocks">
            <button
              v-for="e in visible(t.cell.entries)"
              :key="e.session.id + t.date + (e.holiday ?? '')"
              class="blk"
              :class="{ 'has-hd': e.holiday }"
              :style="{ '--blk': colorOf(e) }"
              :title="tipOf(e)"
              @click="emit('select', e)"
            >
              <span v-if="e.holiday" class="hd" :class="e.holiday">{{ e.holiday === 'off' ? '假' : '调' }}</span>
              <span class="name">{{ e.session.courseName }}</span>
              <!-- 这一格要回答的就三件事：哪门课、谁上、在哪上。
                   行数按格子高度自适应（见样式里的容器查询）——矮格子给课名一行，
                   高格子把课名放开，教师与地点两行始终留着。 -->
              <span v-if="teacherOf(e)" class="meta tch">{{ teacherOf(e) }}</span>
              <span v-if="placeOf(e)" class="meta room">{{ placeOf(e) }}</span>
            </button>
            <span v-if="t.cell.entries.length > VISIBLE_LIMIT" class="more">
              +{{ t.cell.entries.length - VISIBLE_LIMIT }}
            </span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/**
 * 单一滚动容器：横竖都归它管。
 * 用定高而不是 max-height —— 节次少时课表也该铺满可用高度（和纸质课表一样），
 * 行轨由脚本算出的 `grid-template-rows` 给出（每行按真实时长成比例，下限 ROW_MIN）：
 * 节次少时 fr 把高度铺满，节次多时按下限滚动。
 */
.wrap {
  overflow: auto;
  overscroll-behavior: contain;
  touch-action: pan-x pan-y;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  /* 轨道透明、滑块用分隔线的颜色：七列永远放不下一屏，这条细滚动条是
     「右边/下面还有」的唯一提示，不能像全局那样把它藏掉。 */
  scrollbar-color: var(--line-strong) transparent;
  height: calc(
    100dvh - var(--safe-top) - var(--tabbar-h) - var(--safe-bottom) - var(--wbar-reserve, 0px) - 236px
  );
  /* 内容容器档 16：这张网格与日 / 月视图的卡面同层，20 会把它抬到按钮层级 */
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  user-select: none;
}

/* 全局那条 `::-webkit-scrollbar { width:0; height:0 }` 是「全应用不显示滚动条」的苹果风格，
   但这个网格**必须**双轴滚动 —— 藏掉滚动条后，右边被切掉的半列看起来像渲染坏了，
   而不是「还能往右滑」。这里按类选择器把这条细滚动条要回来（特异性高于全局那条）。
   滑块做得克制：只求一眼看出「还有」，不抢课表的视觉。 */
.wrap::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.wrap::-webkit-scrollbar-track,
.wrap::-webkit-scrollbar-corner {
  background: transparent;
}

.wrap::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: var(--radius-full);
}

.wrap::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}

.grid {
  display: grid;
  grid-template-columns: 58px repeat(7, minmax(92px, 1fr));
  /* 行轨由内联 `grid-template-rows` 给出（脚本里的 gridRows）；这条只兜底隐式行 */
  grid-auto-rows: minmax(56px, 1fr);
  min-height: 100%;
}

.cell {
  border-bottom: 0.5px solid var(--line);
  border-right: 0.5px solid var(--line);
  min-width: 0;
}

/* ---------- 冻结三件套 ---------- */
/* 表头行、左上角、左侧时间列**与卡片底同一种材质（--surface）**。
   这里曾经让表头格子走 .glass-surface（半透明 + blur）、角与时间列走实底：
   亮色下两者颜色本来就接近、看不出，暗色下就是两块深浅不同的灰拼在一起（实测确认），
   而且八个格子各自背一层 backdrop-filter。数据表的冻结区属于内容面，
   跟卡片走同一种实底；玻璃留给悬浮控件（底部 Dock、页头盘、悬浮条）。 */
.head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--surface);
  /* 冻结区下缘比行线重一档：横滑时它仍是「表头的边界」（原来靠 glass-edge-b 的同一条渐变） */
  border-bottom-color: var(--line-strong);
}

/* 冻结边界的「封边」：一道硬分隔线 + 一道向右衰减的阴影。
   缺了它，横滑时左边缘与内容之间没有界线 —— 看起来只是「一列被切掉了」，
   而不是「左侧这一列是冻住的」。封边同时把任何从缝隙里透出来的内容挡住。

   阴影色走 --glass-scroll-edge（亮 0.16 / 暗 0.44 的**黑**）：原来取的是 --text-1 的 32%，
   而暗色下 --text-1 是近白 —— 一条白雾沿着整列铺开，比不画还糟。 */
.time,
.corner {
  background: var(--surface);
  box-shadow:
    1px 0 0 var(--line-strong),
    10px 0 12px -10px var(--glass-scroll-edge);
}

.time {
  position: sticky;
  left: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-2);
}

.corner {
  left: 0;
  z-index: 4;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ---------- 表头 ---------- */
.day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6) var(--sp-2);
}

/* 「今天」的定位器：一条 accent 短线钉在表头顶缘。表头是冻结的，横滚到哪它都跟着 ——
   代价只是一条 3px 的线。曾经给今天整列刷 --accent-soft：空格子也填成一块实色板，
   看起来像课程块渲染丢了（每帧还多 7~8 个混合层）；线条在语义相同的前提下两个都省了。 */
.day.today::before {
  content: '';
  position: absolute;
  top: 0;
  left: 22%;
  right: 22%;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.dow {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: var(--lh-display);
}

.dnum {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-display);
}

.wk {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-display);
}

.day.today .dow {
  color: var(--accent);
}

.day.today .dnum {
  color: var(--accent);
  font-weight: var(--fw-semibold);
}

/* ---------- 左侧时间列 ---------- */
.t1 {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-display);
}

.t2 {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-display);
}

/* 节次区间只是时间柱的补充读数（主角是上下两端实际上课时间）：
   不叠 opacity —— --text-3 的 3.6:1 再乘 0.75 只剩约 2.5:1，
   左侧时间列几乎读不出来，层级靠字号与颜色差，不靠透明度 */
.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-display);
}

/* ---------- 课程格 ---------- */
/* 每个格子是一个**查询容器**：课程格要按自己拿到的高度决定课名放开几行
   （见下面两条 `@container`）。高度由网格行轨给出（`minmax(56px, N fr)`，与内容无关），
   所以这里的 `contain: size` 不会让行轨跟着内容长 —— 与加它之前的行为一致。 */
.slot {
  padding: var(--sp-2);
  display: flex;
  container-type: size;
}

.blocks {
  display: flex;
  gap: var(--sp-2);
  flex: 1;
  min-width: 0;
}

.blk {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-4);
  border-radius: var(--radius-s);
  /* 课程色整面 soft tint（课表三视图同一档浓度：与日视图 .row、月视图 .chip 同画法），
     不再靠 3px 左边框（side-tab 收编） */
  background: color-mix(in srgb, var(--blk) 12%, var(--surface));
  text-align: left;
  overflow: hidden;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 「假 / 调」角标：钉在右上角，不占正文的排版流 */
.hd {
  position: absolute;
  top: 2px;
  right: 2px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-full);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  line-height: var(--lh-title);
}

/* soft 底上的文字走 strong 档：--warn / --accent 当文字色压在同名浅底上不够读 */
.hd.off {
  color: var(--warn-strong);
  background: color-mix(in srgb, var(--warn) 16%, var(--surface));
}

.hd.makeup {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

/* 有角标时给课名留出右边距，避免长课名的首行压到角标上 */
.blk.has-hd .name {
  padding-right: var(--sp-14);
}

.blk:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.blk:active {
  transform: scale(0.97);
}

/* 课名行数**跟着格子高度走**：矮格子只给一行（把教师与地点那两行让出来），
   高一档放开两行、再高放开三行。阈值按「三行文字正好装得下」反推：
   一行课名 13.8px + 教师 12.1 + 地点 12.1 + 两条 1px 缝 ≈ 40px，加内边距 10px 即 56px 起；
   两行课名要 62px 内容高度 → 72px 起；三行 → 100px 起。 */
.name {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  line-height: var(--lh-display);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}

@container (min-height: 72px) {
  .name {
    -webkit-line-clamp: 2;
  }
}

@container (min-height: 100px) {
  .name {
    -webkit-line-clamp: 3;
  }
}

/* 教师与地点：各占一行、各自省略号 —— 合成一行会让教室被教师名挤掉，
   而「去哪儿上课」恰恰是看课表时最常找的那一个读数 */
.meta {
  font-size: var(--fs-micro);
  line-height: var(--lh-display);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 教师与教室都是「去不去 / 去哪儿」的直接依据，同用 --text-2；
   层级由字号与顺序承担，不靠把某一行压到读不出的灰 */
.meta.tch {
  color: var(--text-2);
}

/* 教室是「现在去哪儿上课」的答案，属于必须读出来的信息：
   --text-3 的 3.6:1 在 10px 上不够，提到 --text-2 并与教师同档 */
.meta.room {
  color: var(--text-2);
}

.more {
  align-self: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  padding: 0 var(--sp-2);
}
</style>
