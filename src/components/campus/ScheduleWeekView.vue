<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

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

/** 行高的下限：一行要装下「开始时间 + 第N节」两行字和一个课块，再矮就读不出来了。
 *  52 是两行时间（12/10）加 8 内距再加一个单行课块的下限；比原来的 56 矮 4，
 *  换来 10 个节次在一屏里少溢出一点（竖向滚动条出现的门槛更低）。 */
const ROW_MIN = 52

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

/**
 * 格子里的第二行：**教室 · 教师**。
 *
 * 这一行只有一行的预算（块高 50 上下），所以两项合成一句、末尾统一省略号 ——
 * 原来教师、教室各占一行，把课名挤到第三行；而「在哪上、谁上」本来就是同一层级的两件事，
 * 合成一句后主次自然落到课名上（课名两行、副文一行）。
 */
function metaOf(e: ScheduleEntry): string {
  return [e.session.room, teacherOf(e)].filter(Boolean).join(' · ')
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
 * 右缘渐隐只在「右边还有内容」时出现。
 *
 * 七列永远放不下一屏，但半截列本身读起来像渲染坏了 —— 那道从透明到卡面的渐变
 * 把「被裁掉」翻译成「还能往右滑」。滚到最右时必须撤掉：否则它盖住最后一列，
 * 又变成另一种「这里显示不全」。
 */
const canRight = ref(false)

function syncEdge(): void {
  const el = scroller.value
  if (!el) return
  canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}

/** 滚动 / 换周后重算一次；rAF 是因为程序化改 scrollLeft 与吸附都要等一帧才落定 */
function refreshEdge(): void {
  requestAnimationFrame(syncEdge)
}

function onResize(): void {
  syncEdge()
}

/**
 * 打开时把「今天」那一列滚进视野（今天不在本周则滚到周一）。
 * 课表有 7 列，窄屏下默认停在最左边会让用户以为今天没课。
 *
 * 列宽由 CSS 按「一屏正好三列」算（`--sched-time-col` 与容器宽度），
 * 所以这里量出来的 colWidth 与吸附点同源：滚到整列边界时，左缘永远不会露出半截列。
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
    refreshEdge()
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
  refreshEdge()
}

onMounted(() => {
  scrollToToday()
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
})

watch(() => props.anchor, scrollToToday)
</script>

<template>
  <!-- 外壳只负责两件事：把网格撑满剩余高度（页面底部入口不压在它身上），
       给右缘渐隐提供一个**不随网格滚动**的定位父级。 -->
  <div class="shell">
    <div ref="scroller" class="wrap" data-rubber-self @scroll.passive="syncEdge">
      <div class="grid" :style="{ gridTemplateRows: gridRows }">
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
          <span class="dline">
            <span class="dnum num">{{ monthDay(d) }}</span>
            <!-- 周次只缀在周界那一格的日期后面（同列重复七天是噪音，页头副标题本来就有） -->
            <span v-if="wkShown[i]" class="wk">第{{ weekNoOf(d) }}周</span>
          </span>
        </div>

        <!-- 主体：每行 = 时间轴上的一个片段；课块按自己占的节次跨行 -->
        <template v-for="row in layout" :key="row.key">
          <div class="cell time" :style="{ gridRow: row.gridRow, gridColumn: 1 }">
            <span class="t1 num">{{ row.slot.startTime }}</span>
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
                     课名最多两行，教室与教师合成第二行；行数按格子高度自适应
                     （见样式里的容器查询）——矮格子给课名一行，高格子把课名放开。 -->
                <span v-if="metaOf(e)" class="meta">{{ metaOf(e) }}</span>
              </button>
              <span v-if="t.cell.entries.length > VISIBLE_LIMIT" class="more">
                +{{ t.cell.entries.length - VISIBLE_LIMIT }}
              </span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 右缘渐隐：滚到最右撤掉（见 syncEdge），宽度只够提示，不遮住整列文字 -->
    <span class="edge" :class="{ on: canRight }" aria-hidden="true" />
  </div>
</template>

<style scoped>
/**
 * 外壳 = 网格的「剩余高度」容器 + 右缘渐隐的定位父级。
 *
 * 网格高度从「页面上估算一个 236px 的常量」改成**由页面剩余空间决定**：
 * 页面是弹性列（页头 / 工具行 / 网格 / 底部入口），网格吃剩下的高度，
 * 底部那两条入口因此在内容流末尾、永远压不到最后一行课上；屏幕实在不够高时
 * 由 min-height 兜底，整页滚动而不是把课表压扁。
 */
.shell {
  /* 一屏正好三列 —— 列宽 =（可用宽 − 时间列）/ 3。
     这个换算是「滚到哪都对齐列边界」的前提：可用宽是列宽的整数倍，
     滚动停下的位置就永远是整列，不会露半截。容器查询单位让它在任何宽度下自洽。
     上下限只在极窄 / 桌面档才生效：88 是 320 宽手机上仍能排下 7 个字的下限，
     132 是桌面档的一列（再宽七天就散成一条条细缝，1fr 会自己铺满）。 */
  --sched-time-col: 48px;
  --sched-days-per-view: 3;
  --sched-day-col: clamp(
    calc(var(--sp-44) * 2),
    calc((100cqw - var(--sched-time-col)) / var(--sched-days-per-view)),
    calc(var(--sp-44) * 3)
  );

  container-type: inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  /* 高度下限只防「被压成一条」：低于四行就该整页滚，而不是把十个节次压成十条线。
     240 而不是 320 —— 矮视口（横屏 / 分屏）下 320 会和视口等高，
     网格反而把底部入口挤出屏幕，正是这一页要修的那个问题。 */
  min-height: calc(var(--sp-48) * 5);
}

/* 右缘渐隐：贴在卡片右缘的一道 24 宽渐变，只在还能往右滑时出现。
   它是 .shell 的兄弟而不是 .wrap 的子级 —— 放进滚动容器里会跟着内容一起滑走。
   渐隐色走 --glass-scroll-edge（亮 0.16 / 暗 0.44 的**黑**），不是渐隐到 --surface：
   课表右缘多半是空格子，渐隐到「和底色一样」等于什么都没画；一层薄黑纱才看得出「下面还有」。 */
.edge {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--sp-24);
  pointer-events: none;
  /* 压过冻结表头（z 3）与左上角（z 4）：渐隐要沿整张卡片的右缘连续，
     断在表头下缘会读成「表头没画完」 */
  z-index: 5;
  border-radius: 0 var(--radius-m) var(--radius-m) 0;
  /* 三段而不是两段：线性渐变在中段几乎看不出浓度，加一个 45% 的中间停靠点，
     薄纱才「铺得开」而不是只在最右两像素上压出一条灰线 */
  background: linear-gradient(
    to right,
    transparent 0%,
    color-mix(in srgb, var(--glass-scroll-edge) 55%, transparent) 45%,
    var(--glass-scroll-edge) 100%
  );
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.edge.on {
  opacity: 1;
}

/**
 * 单一滚动容器：横竖都归它管。
 * 高度 100% 吃满 .shell（父级是 flex 子项，高度已定）—— 用定高而不是 max-height，
 * 节次少时课表铺满可用高度（和纸质课表一样）。行轨由脚本算出的
 * `grid-template-rows` 给出（每行按真实时长成比例，下限 ROW_MIN）。
 */
.wrap {
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  touch-action: pan-x pan-y;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  /* 轨道透明、滑块用分隔线的颜色：七列永远放不下一屏，这条细滚动条是
     「右边/下面还有」的唯一提示，不能像全局那样把它藏掉。 */
  scrollbar-color: var(--line-strong) transparent;
  /* 横滑停在列边界：x 轴用 proximity（只在快对齐时吸），纵向不参与 ——
     mandatory 会在纵滑时劫持手势，这是此前刻意不用 scroll-snap 的原因。
     scroll-padding 让出一条时间列：吸附点是「列首对齐到冻结列右侧」，不是滚动容器左缘。 */
  scroll-snap-type: x proximity;
  scroll-padding-left: var(--sched-time-col);
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
  /* 表头与网格共用**同一条列宽变量**（--sched-day-col 由 .shell 按可用宽算出）：
     两者在同一个网格里，对齐是构造出来的，不是靠两处各自算一遍凑出来的。 */
  grid-template-columns: var(--sched-time-col) repeat(7, minmax(var(--sched-day-col), 1fr));
  /* 盒宽必须等于**轨道总宽**（手机上是三列多的 865，桌面上是整宽），不能是滚动容器的宽：
     sticky 的位移上限就是包含块（= 这个盒）的宽度 —— 盒只有 398 宽时，时间列最多右移
     398−48 就顶住，再往右滑它就被内容带着走了（冻结列在最后两列上失效）。
     max-content 撑出真实宽度，min-width 兜住「七列本来放得下」的桌面档。 */
  width: max-content;
  min-width: 100%;
  /* 行轨由内联 `grid-template-rows` 给出（脚本里的 gridRows）；这条只兜底隐式行 */
  grid-auto-rows: minmax(52px, 1fr);
  /* 高度必须**确定**（= 滚动容器高度）才轮得到 fr 去分配：只给 min-height 时，
     fr 行按内容反推，最后一行会吃掉一段凭空的余量，整张表比容器高出一截。 */
  height: 100%;
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
  /* 主时间与节次是同级的两行字，行间只留 2（--gap-text），不靠间距分主次 */
  gap: var(--gap-text);
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
/* 表头两行：星期 + 「日期 · 周次」。周次并进日期那一行 —— 原来它独占第三行，
   七个格子里只有一个有字，整条表头却为它高出一行（横滑时那一条空白很显眼）。 */
.day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--gap-text);
  padding: var(--sp-4) var(--sp-2);
  /* 吸附点落在每个日期列的列首（scroll-padding 已扣掉冻结的时间列） */
  scroll-snap-align: start;
}

/* 「今天」列：底色 + 两条内描边 + 表头顶上一条 accent 线。
   只靠文字变蓝不够 —— 七列并排时眼睛先找的是「一块有底的面」，再读字。
   浓度压到 6%：空格子也铺满这一列，再浓就成了一块实色板（看起来像课块没渲染出来）。 */
.day.today,
.slot.today {
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  box-shadow:
    inset 1px 0 0 color-mix(in srgb, var(--accent) 26%, transparent),
    inset -1px 0 0 color-mix(in srgb, var(--accent) 26%, transparent);
}

.day.today::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent);
}

.dow {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: var(--lh-display);
}

.dline {
  display: flex;
  align-items: baseline;
  gap: var(--sp-4);
  max-width: 100%;
  overflow: hidden;
}

.dnum {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-display);
  white-space: nowrap;
}

.wk {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-display);
  white-space: nowrap;
}

.day.today .dow {
  color: var(--accent);
}

.day.today .dnum {
  color: var(--accent);
  font-weight: var(--fw-semibold);
}

/* ---------- 左侧时间列 ---------- */
/* 两行：主行是**开始时刻**（看课表要的是「几点开始」），次行是节次区间。
   结束时刻撤掉了 —— 一格里三行数字（08:00 / 08:40 / 第1节）密到读不出来，
   而「上到几点」在课程详情里随时可查。 */
.t1 {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-display);
}

/* 节次只是补充读数：不叠 opacity —— --text-3 再乘 0.75 只剩约 2.5:1，
   左侧时间列几乎读不出来，层级靠字号与颜色差，不靠透明度 */
.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-display);
  white-space: nowrap;
}

/* ---------- 课程格 ---------- */
/* 每个格子是一个**查询容器**：课程格要按自己拿到的高度决定课名放开几行
   （见下面两条 `@container`）。高度由网格行轨给出（`minmax(52px, N fr)`，与内容无关），
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

/* 课块：中性底 + 左侧 3px 色条。
   色相原先铺满整块（soft tint），七列并排时每格都是一片彩色底，块与块的边界反而糊掉；
   现在色只承担「哪门课」的识别，底色退回 --surface-2（卡内的二级面），
   文字层级与块边界都清楚。圆角 12 = 卡内分组面那一档（16 会读成一张小卡）。 */
.blk {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--gap-text);
  /* 三边 8、左边 12（色条 3 + 缝 9）：两行课名 + 一行副文在 48 高的块里正好装下 */
  padding: var(--sp-8) var(--sp-8) var(--sp-8) var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  text-align: left;
  overflow: hidden;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 左侧色条：钉在块的左边，上下由块自己的圆角裁齐（overflow:hidden） */
.blk::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--blk);
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
  padding-right: var(--sp-16);
}

.blk:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.blk:active {
  transform: scale(0.97);
}

/* 课名行数**跟着格子高度走**：矮格子一行（把副文让出来），连排课的块放到两行。
   一行课名 13.9 + 副文 11.6 + 2 缝 + 8 内距 ≈ 36，56 高的格子起就能放开两行
   （63 = 27.8 + 11.6 + 2 + 8 再留 12 余量）。 */
.name {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  line-height: var(--lh-display);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

@container (min-height: 64px) {
  .name {
    -webkit-line-clamp: 2;
  }
}

/* 桌面档的列宽接近手机的两倍（170 上下）：同一句课名在宽列里用 12 会显得小，
   抬到 --fs-callout（14）与副文（10）拉开两档字阶。窄列不动 —— 116 宽里
   14px 只能排 6 个字，长课名会被切掉。 */
@container (min-width: 140px) {
  .name {
    font-size: var(--fs-callout);
  }
}

/* 「教室 · 教师」一行：主次靠字号（12/10）与色阶（--text-1 / --text-2）拉开，
   不再各占一行把课名挤到第三行；放不下就整行省略，绝不再折行 */
.meta {
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: var(--lh-display);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  align-self: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  padding: 0 var(--sp-2);
}
</style>
