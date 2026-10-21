<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Plus } from 'lucide-vue-next'

import { CATEGORY_META, DESKTOP_MIN } from '@/config/domain'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useZoomWheel } from '@/composables/useZoomWheel'
import { minToHHmm, nowMin, todayStr, weekDates } from '@/utils/date'
import { durationOf, layoutDayBlocks, titleLinesFor } from '@/utils/timelineLayout'
import type { StackGroup } from '@/utils/timelineLayout'
import type { Todo } from '@/types'

/**
 * 周甘特时间线：横轴 7 日、纵轴 0-24 时，块按 date+startMin+durationMin 定位，
 * 与单日画布（CanvasTimeline）同一套时间语言。
 * - 左侧 48px 刻度栏；块高 = 时长 × px/min，块顶标起点；
 * - 今天列整高强调 + 现在线横贯（30s 轮询）；过去列整体压暗、过去块未完成降透明；
 * - 长按 320ms 武装拖拽：跨日改期、纵向改时（5 分钟吸附），统一走 applyMove 撤销；
 * - 无时间待办收进底部池，点击即排到该日 09:00；Ctrl+滚轮缩放行高。
 */
const props = withDefaults(
  defineProps<{
    /** 该周已排程的待办（startMin 有值），由父级过滤 */
    todos: Todo[]
    /** 无时间待办（startMin 为 null 且未完成），按日期分组展示在底部池 */
    unscheduled?: Todo[]
    selectedId?: number | null
  }>(),
  { unscheduled: () => [], selectedId: null },
)

const emit = defineEmits<{
  select: [todo: Todo]
  toggle: [todo: Todo]
  move: [todo: Todo, date: string, startMin: number]
  daySelect: [date: string]
  add: [date: string]
}>()

const DEFAULT_PX = 44
const MIN_PX = 16
const MAX_PX = 72
/** 块内标题行高与纵向内边距（须与样式一致） */
const TT_LINE_H = 16
const CARD_PAD_Y = 8
/**
 * 并排后每块的最小可读宽度（px）：内边距 12 + 勾选钮与间距 17 + 3 个汉字 33 ≈ 62。
 * 低于它就宁可收成叠层卡 —— 卡面独占整列（~50px 标题区，4 字/行），比并排出两条「一字一行」强。
 */
const MIN_SPLIT_BLOCK_PX = 62

const dates = weekDates(todayStr())
const today = todayStr()
const px = ref(DEFAULT_PX)
const ppm = computed(() => px.value / 60)
const totalPx = computed(() => 24 * px.value)

const hours = computed(() => {
  const step = px.value >= 30 ? 2 : 4
  const out: { min: number; label: string }[] = []
  for (let h = 0; h <= 24; h += step) out.push({ min: h * 60, label: `${String(h).padStart(2, '0')}:00` })
  return out
})

/* ---------- 今天 / 现在线 ---------- */

const nowMin_ = ref(nowMin())
let nowTimer: number | null = null
const nowTop = computed(() => nowMin_.value * ppm.value)

/** 现在线与整点刻度相撞时隐藏该刻度 */
function labelMasked(min: number): boolean {
  return Math.abs(min * ppm.value - nowTop.value) < 14
}

/* ---------- 每日布局 ---------- */

/** 叠层簇 + 视图态（key 作 v-for 键与置顶表索引，front 是当前露在卡面上的那条） */
interface DayStack extends StackGroup {
  key: string
  front: Todo
}

interface DayColumn {
  date: string
  weekday: string
  dayNum: number
  isToday: boolean
  isPast: boolean
  blocks: ReturnType<typeof layoutDayBlocks>['blocks']
  stacks: DayStack[]
  done: number
  total: number
}

const columns = computed<DayColumn[]>(() => {
  const byDate = new Map<string, Todo[]>()
  for (const t of props.todos) {
    if (!t.date) continue
    const list = byDate.get(t.date)
    if (list) list.push(t)
    else byDate.set(t.date, [t])
  }
  return dates.map((date, i) => {
    const day = byDate.get(date) ?? []
    // 列宽不足时并排会压成「一字一行」，交给叠层卡（见 MIN_SPLIT_BLOCK_PX）
    const { blocks, stacks } = layoutDayBlocks(day, {
      colWidth: colW.value || undefined,
      minBlockPx: MIN_SPLIT_BLOCK_PX,
    })
    return {
      date,
      weekday: ['一', '二', '三', '四', '五', '六', '日'][i]!,
      dayNum: Number(date.slice(8, 10)),
      isToday: date === today,
      isPast: date < today,
      blocks,
      stacks: stacks.map((s) => ({ ...s, key: stackKeyOf(s), front: frontOf(s) })),
      done: day.filter((t) => t.status === 'done').length,
      total: day.length,
    }
  })
})

/**
 * 叠层簇的卡面项：点「+N」在簇内轮换（会话内状态，与日画布的 `frontByStack` 同一思路）。
 * 周列只有 ~80px，塞不下日画布那种展开清单，就地轮换是唯一还能让簇内每条都够得着的办法。
 */
const frontByStack = ref(new Map<string, number>())

const stackKeyOf = (s: StackGroup): string => `${s.items[0]!.id}-${s.items.length}`

function frontOf(s: StackGroup): Todo {
  const pinnedId = frontByStack.value.get(stackKeyOf(s))
  const pinned = pinnedId != null ? s.items.find((t) => t.id === pinnedId) : undefined
  if (pinned && pinned.status !== 'done') return pinned
  return s.items.find((t) => t.status !== 'done') ?? s.items[0]!
}

function cycleStack(s: StackGroup): void {
  const cur = frontOf(s)
  const i = s.items.findIndex((t) => t.id === cur.id)
  frontByStack.value.set(stackKeyOf(s), s.items[(i + 1) % s.items.length]!.id)
}

function blkStyle(b: { todo: Todo; startMin: number; durationMin: number; col: number; cols: number }): Record<string, string> {
  return {
    top: `${b.startMin * ppm.value}px`,
    height: `${Math.max(15, b.durationMin * ppm.value)}px`,
    left: `calc(${(b.col / b.cols) * 100}% + ${b.col * 2}px)`,
    width: `calc(${100 / b.cols}% - 3px)`,
    '--blk-cat': `var(${CATEGORY_META[b.todo.category].colorVar})`,
    '--blk-lines': `${titleLinesFor(Math.max(15, b.durationMin * ppm.value), TT_LINE_H, CARD_PAD_Y)}`,
  }
}

/**
 * 叠层卡几何：卡面独占整列（`cols = 1`），其余同块。
 * 必须走同一套坐标 —— `.blk` 是 absolute 且没有偏移量，不绑的话卡片会贴在列首（00:00）而不是真实时段。
 */
function stkStyle(s: { items: Todo[]; startMin: number }): Record<string, string> {
  const first = s.items[0]!
  return blkStyle({
    todo: first,
    startMin: s.startMin,
    durationMin: durationOf(first),
    col: 0,
    cols: 1,
  })
}

/* ---------- 底部池：按日分组的无时间待办 ---------- */

const pool = computed(() =>
  dates.map((date) => ({
    date,
    isToday: date === today,
    items: props.unscheduled.filter((t) => t.date === date),
  })),
)

/* ---------- 缩放 ---------- */

/**
 * 「Ctrl+滚轮缩放」只在桌面壳提示：与 App.vue 写 html[data-shell] 同一阈值（DESKTOP_MIN）。
 * 移动端没有实体键盘与精确指针，印在提示里也执行不了 —— 长按改时的操作句同理，
 * 只留在 /todos 页头副标题一处，本组件不再重复。
 */
const isDesk = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

const { onWheel } = useZoomWheel(px, MIN_PX, MAX_PX)

/** 进入锚定：今天看现在附近，否则看最早安排或 8 点 */
function scrollToAnchor(): void {
  const el = scroller.value
  if (!el) return
  const first = props.todos.reduce<number | null>((acc, t) => {
    if (t.startMin == null) return acc
    return acc == null || t.startMin < acc ? t.startMin : acc
  }, null)
  const target = first != null && first < nowMin_.value + 60 ? first - 45 : Math.min(nowMin_.value - 75, 8 * 60)
  nextTickScroll(Math.max(0, target * ppm.value))
}

function nextTickScroll(top: number): void {
  void nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = Math.min(top, Math.max(0, totalPx.value - el.clientHeight))
  })
}

defineExpose({ scrollToAnchor, getPxPerMin: () => ppm.value })

/* ---------- 拖拽：长按武装，跨日 + 纵向改时 ---------- */

interface DragState {
  todo: Todo
  /** 按下时指针在网格内的 (dayIndex, minute) */
  grabDay: number
  grabMin: number
  curDay: number
  curMin: number
  armed: boolean
  moved: boolean
  aborted: boolean
}

const LONGPRESS_MS = 320
const ARM_CANCEL_PX = 10

const drag = ref<DragState | null>(null)
let pressTimer: number | null = null
let downX = 0
let downY = 0

const gridEl = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)

/**
 * 单列实际宽度（px）：并排与否由它决定，所以要在挂载/窗口变化后量一次。
 * 周甘特一列只有 ~80px，两列并排后每块 37px，扣掉内边距(12) 与勾选钮(12+5) 只剩不到 11px，
 * 连一个汉字都放不下（`word-break` 会把它拆成一行一个字）。布局层据此退化成叠层卡。
 */
const colW = ref(0)
let gridRo: ResizeObserver | null = null

function measureCol(): void {
  const g = gridEl.value
  if (g) colW.value = g.clientWidth / 7
}

/** 指针位置 → (dayIndex, minute)，越界钳制 */
function pointToGrid(e: PointerEvent): { day: number; min: number } {
  const g = gridEl.value
  const s = scroller.value
  if (!g || !s) return { day: 0, min: 0 }
  const rect = g.getBoundingClientRect()
  const day = Math.max(0, Math.min(6, Math.floor(((e.clientX - rect.left) / rect.width) * 7)))
  const min = Math.max(0, Math.min(24 * 60, (e.clientY - rect.top + s.scrollTop) / ppm.value))
  return { day, min }
}

function clearPress(): void {
  if (pressTimer != null) {
    window.clearTimeout(pressTimer)
    pressTimer = null
  }
}

function releaseDrag(): DragState | null {
  const d = drag.value
  clearPress()
  drag.value = null
  window.removeEventListener('touchmove', onTouchMove)
  return d
}

/** 武装后阻止浏览器把触摸手势判成滚动 */
function onTouchMove(e: TouchEvent): void {
  if (drag.value?.armed) e.preventDefault()
}

function onBlockDown(e: PointerEvent, t: Todo): void {
  if (t.status === 'done' || e.button !== 0) return
  const pos = pointToGrid(e)
  const day = dates.indexOf(t.date ?? today)
  const base = day === -1 ? pos.day : day
  // 课表派生行是只读投影（见 types/todo.ts 的 courseSessionId）：只关掉长按武装，
  // 点选与抛滚照旧，避免用户把它拖到别的时间上造成「看起来改了其实没改」。
  const readonly = t.courseSessionId != null
  drag.value = {
    todo: t,
    grabDay: pos.day - base,
    grabMin: pos.min - (t.startMin ?? 0),
    curDay: base,
    curMin: t.startMin ?? 0,
    armed: false,
    moved: false,
    aborted: false,
  }
  downX = e.clientX
  downY = e.clientY
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 无有效指针：手势沿元素事件继续 */
  }
  clearPress()
  pressTimer = window.setTimeout(() => {
    pressTimer = null
    if (!drag.value || readonly) return
    drag.value.armed = true
    try { navigator.vibrate?.(8) } catch { /* 设备不支持则无感 */ }
  }, LONGPRESS_MS)
  window.addEventListener('touchmove', onTouchMove, { passive: false })
}

function onBlockMove(e: PointerEvent): void {
  const d = drag.value
  if (!d) return
  if (!d.armed) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > ARM_CANCEL_PX) {
      clearPress()
      d.aborted = true
    }
    return
  }
  d.moved = true
  const pos = pointToGrid(e)
  const dur = durationOf(d.todo)
  d.curDay = Math.max(0, Math.min(6, pos.day - d.grabDay))
  d.curMin = Math.round(Math.max(0, Math.min(pos.min - d.grabMin, 1440 - dur)) / 5) * 5
}

function onBlockUp(): void {
  const d = releaseDrag()
  if (!d) return
  if (d.moved) {
    const date = dates[d.curDay] ?? today
    emit('move', d.todo, date, d.curMin)
  } else if (!d.armed && !d.aborted) {
    emit('select', d.todo)
  }
}

function onBlockCancel(): void {
  releaseDrag()
}

/** 拖拽中的实时定位（其余情况返回落库值） */
function liveGeom(t: Todo, fallbackDay: number, fallbackMin: number): { day: number; min: number } {
  if (drag.value?.armed && drag.value.todo.id === t.id) return { day: drag.value.curDay, min: drag.value.curMin }
  return { day: fallbackDay, min: fallbackMin }
}

const isDragging = (id: number): boolean => !!drag.value?.armed && drag.value.todo.id === id

/* ---------- 池快排：点击排到当天早上 ---------- */

function quickSchedule(t: Todo): void {
  emit('move', t, t.date ?? today, 9 * 60)
}

onMounted(() => {
  scrollToAnchor()
  measureCol()
  if (gridEl.value && typeof ResizeObserver !== 'undefined') {
    gridRo = new ResizeObserver(measureCol)
    gridRo.observe(gridEl.value)
  }
  nowTimer = window.setInterval(() => {
    nowMin_.value = nowMin()
  }, 30_000)
})

onBeforeUnmount(() => {
  gridRo?.disconnect()
  gridRo = null
  if (nowTimer != null) window.clearInterval(nowTimer)
  clearPress()
  drag.value = null
  window.removeEventListener('touchmove', onTouchMove)
})

const HHMM = minToHHmm
</script>

<template>
  <div class="wk" data-testid="week-timeline" @wheel="onWheel">
    <div class="hwrap" data-rubber-self>
      <div class="hinner">
    <header class="dhead">
      <button
        v-for="c in columns"
        :key="`h-${c.date}`"
        type="button"
        class="dh"
        :class="{ today: c.isToday, past: c.isPast }"
        :aria-label="`查看 ${c.date} 的画布，完成 ${c.done}/${c.total}`"
        @click="emit('daySelect', c.date)"
      >
        <span class="num n" :class="{ today: c.isToday }">{{ c.dayNum }}</span>
        <span class="lab" :class="{ today: c.isToday }">{{ c.weekday }}</span>
        <!-- 空日不渲染「0/0」；分子分母写进 aria-label（表头放不下「已完成」字样） -->
        <span v-if="c.total > 0" class="num cnt" :class="{ full: c.total > 0 && c.done >= c.total }">{{ c.done }}/{{ c.total }}</span>
      </button>
    </header>

    <div ref="scroller" class="scroll" data-testid="week-scroll">
      <div class="inner" :style="{ height: `${totalPx}px` }">
        <!-- 刻度栏 -->
        <div class="gutter">
          <template v-for="h in hours" :key="h.min">
            <span v-show="!labelMasked(h.min)" class="hlab num" :style="{ top: `${h.min * ppm}px` }">{{ h.label }}</span>
          </template>
          <div v-if="columns.some((c) => c.isToday)" class="nowtag num" :style="{ top: `${nowTop}px` }">现在</div>
        </div>

        <!-- 网格：7 列 -->
        <div ref="gridEl" class="grid">
          <!-- 背景层：整点横线 + 今天列高亮 + 现在线 -->
          <div class="bg" aria-hidden="true">
            <i v-for="h in hours" :key="`l-${h.min}`" class="hline" :style="{ top: `${h.min * ppm}px` }" />
            <div v-for="(c, ci) in columns" v-show="c.isToday" :key="`t-${c.date}`" class="today-col" :style="{ left: `calc((100% / 7) * ${ci})` }" />
            <div v-if="columns.some((c) => c.isToday)" class="nowline" :style="{ top: `${nowTop}px` }" />
          </div>



          <!-- 每列块 -->
          <div
            v-for="(c, ci) in columns"
            :key="`c-${c.date}`"
            class="col"
            :class="{ past: c.isPast, today: c.isToday }"
            :style="{ left: `calc((100% / 7) * ${ci})` }"
          >
            <div
              v-for="b in c.blocks"
              :key="b.todo.id"
              class="blk"
              :class="{
                done: b.todo.status === 'done',
                sel: selectedId === b.todo.id,
                past: c.isPast && b.todo.status !== 'done',
                dragging: isDragging(b.todo.id),
              }"
              :style="blkStyle(b)"
              :data-title="b.todo.title"
              :data-date="c.date"
              @pointerdown="onBlockDown($event, b.todo)"
              @pointermove="onBlockMove"
              @pointerup="onBlockUp"
              @pointercancel="onBlockCancel"
              @contextmenu.prevent
            >
              <div class="card">
                <button
                  class="ck"
                  :aria-label="b.todo.status === 'done' ? '标记未完成' : '标记完成'"
                  @pointerdown.stop
                  @click.stop="emit('toggle', b.todo)"
                />
                <span class="tt">{{ b.todo.title }}</span>
              </div>
              <span v-if="b.durationMin * ppm >= 30" class="bmin num" :class="{ live: isDragging(b.todo.id) }">{{ HHMM(liveGeom(b.todo, dates.indexOf(c.date), b.startMin).min) }}</span>
            </div>

            <!-- 叠层簇：≥3 条同时段，或列宽放不下并排（见 MIN_SPLIT_BLOCK_PX） -->
            <div
              v-for="s in c.stacks"
              :key="`s-${s.key}`"
              class="blk stk"
              :class="{ dragging: isDragging(s.front.id) }"
              :style="stkStyle(s)"
              :data-title="`${s.items.length} 项同时段`"
              @pointerdown="onBlockDown($event, s.front)"
              @pointermove="onBlockMove"
              @pointerup="onBlockUp"
              @pointercancel="onBlockCancel"
              @contextmenu.prevent
            >
              <div class="card face">
                <button
                  class="ck"
                  :aria-label="s.front.status === 'done' ? '标记未完成' : '标记完成'"
                  @pointerdown.stop
                  @click.stop="emit('toggle', s.front)"
                />
                <span class="tt">{{ s.front.title }}</span>
              </div>
              <!-- 余量徽标放块下方标签行：卡面标题在窄列里每一像素都金贵，不能被它吃掉；
                   点它在簇内轮换卡面，簇里每条都还够得着 -->
              <span class="bmin num">
                <template v-if="durationOf(s.front) * ppm >= 30">{{ HHMM(liveGeom(s.front, ci, s.startMin).min) }}</template>
                <button
                  class="more"
                  :aria-label="`切换到同时段的下一项（共 ${s.items.length} 项）`"
                  @pointerdown.stop
                  @click.stop="cycleStack(s)"
                >
                  +{{ s.items.length - 1 }}
                </button>
              </span>
            </div>
          </div>

          <!-- 拖拽影子：跨列跟手 -->
          <div v-if="drag?.armed" class="ghost" :style="{
            left: `calc(${(drag.curDay / 7) * 100}% + 1px)`,
            width: `calc(${100 / 7}% - 3px)`,
            top: `${drag.curMin * ppm}px`,
            height: `${Math.max(15, durationOf(drag.todo) * ppm)}px`,
          }" />
        </div>
      </div>
    </div>

    <!-- 底部池：无时间待办，按日分组 -->
    <div class="pool">
      <div v-for="p in pool" :key="`p-${p.date}`" class="pcol" :class="{ today: p.isToday }">
        <div class="pitems">
          <button
            v-for="t in p.items"
            :key="t.id"
            type="button"
            class="pchip"
            :data-title="t.title"
            :aria-label="`把 ${t.title} 排到当天早上`"
            @click="quickSchedule(t)"
          >
            <i class="dot" :style="{ background: `var(${CATEGORY_META[t.category].colorVar})` }" />
            <span class="ptt">{{ t.title }}</span>
          </button>
          <button
            type="button"
            class="padd"
            :aria-label="`在 ${p.date} 新建待办`"
            @click="emit('add', p.date)"
          >
            <Plus :size="11" :stroke-width="2.6" />
          </button>
        </div>
      </div>
    </div>
      </div>
    </div>

    <p class="hint t-3">点击池中卡片排到当天早上<span v-if="isDesk"> · Ctrl+滚轮缩放</span></p>
  </div>
</template>

<style scoped>
.wk {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

/* 窄屏：表头 + 时间线 + 池 同轴横向滚动（620px 下限），宽屏单列铺满 */
.hwrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}

.hinner {
  min-width: 620px;
}

.scroll {
  height: 480px;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
}

.inner {
  position: relative;
}

.gutter {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 48px;
}

.hlab {
  position: absolute;
  left: 0;
  width: 40px;
  text-align: right;
  transform: translateY(-6px);
  /* 整点刻度是「这一格是几点」的定位信息，不吃 11px */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.nowtag {
  position: absolute;
  left: 2px;
  width: 40px;
  text-align: right;
  /* 当下时刻是时间线的定位词，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--danger);
}

.grid {
  position: relative;
  margin-left: 56px;
  margin-right: 6px;
  height: 100%;
}

/* 背景层 */
.bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hline {
  position: absolute;
  left: 0;
  right: 0;
  height: 0.5px;
  background: var(--line);
}

.today-col {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc((100% / 7) * var(--d, 0));
  width: calc(100% / 7);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.nowline {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1.5px solid var(--danger);
  z-index: 3;
}

.nowline::before {
  content: '';
  position: absolute;
  left: -3px;
  top: -3.5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}

/* 表头 */
.dhead {
  z-index: 5;
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin: 0 6px 0 56px;
  background: var(--surface);
  border-bottom: 0.5px solid var(--line);
}

.dh {
  display: flex;
  align-items: baseline;
  gap: var(--gap-tight);
  padding: var(--sp-8);
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .dh:hover {
    background: var(--surface-2);
  }
}

.dh.today {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.dh .n {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.dh .n.today {
  color: var(--accent);
}

.dh .lab {
  /* 日期头小帽（「周一」）是定位信息 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.dh.past .lab,
.dh.past .n {
  opacity: 0.7;
}

.dh .cnt {
  margin-left: auto;
  /* 「3 项」是这一格的计数，是要读的状态 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.dh .cnt.full {
  color: var(--ok);
  font-weight: var(--fw-bold);
}

/* 列与块 */
.col {
  position: absolute;
  top: 0;
  bottom: 0;
  width: calc(100% / 7);
}

.col.today {
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.col.past {
  opacity: 0.82;
}

.blk {
  position: absolute;
  z-index: 2;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transition: transform var(--dur-base) var(--ease-spring), opacity var(--dur-fast) var(--ease-standard);
}

.card {
  height: 100%;
  display: flex;
  align-items: flex-start;
  gap: var(--gap-tight);
  padding: var(--sp-4) var(--sp-6);
  border-radius: var(--radius-s);
  overflow: hidden;
  background: color-mix(in srgb, var(--blk-cat) 15%, var(--surface));
  border: 0.5px solid color-mix(in srgb, var(--blk-cat) 38%, var(--line));
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text-1) 9%, transparent);
  transition: box-shadow var(--dur-fast) var(--ease-standard), transform var(--dur-base) var(--ease-spring);
}

@media (hover: hover) {
  .blk:hover .card {
    box-shadow: var(--shadow-card);
  }
}

.blk.sel .card {
  box-shadow: 0 0 0 2px var(--accent);
}

.blk.dragging {
  z-index: 6;
  opacity: 0.85;
}

.blk.dragging .card {
  box-shadow: var(--shadow-float);
  transform: scale(1.02);
  cursor: grabbing;
}

.blk.done {
  opacity: 0.45;
}

.blk.done .tt {
  text-decoration: line-through;
}

.blk.past {
  opacity: 0.6;
}

.tt {
  min-width: 0;
  /* 块内标题就是待办本身，是这一屏最该读的东西 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  line-height: var(--blk-lh, 16px);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--blk-lines, 1);
  overflow: hidden;
  overflow-wrap: break-word;
}

.ck {
  flex: none;
  width: 12px;
  height: 12px;
  margin-top: var(--gap-text);
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  background: transparent;
  padding: 0;
}

@media (hover: hover) {
  .ck:hover {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 18%, transparent);
  }
}

.bmin {
  position: absolute;
  left: 2px;
  top: calc(100% + 1px);
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 块下的开始时刻（「09:00」）是日程的定位信息：原先 9px 是为了塞进矮块，
     提到 --fs-caption（12px）后仍收在块外那一行，line-height: 1 保住不撑高块 */
  font-size: var(--fs-caption);
  line-height: 1;
  color: var(--text-3);
  pointer-events: none;
  white-space: nowrap;
}

.bmin.live {
  color: var(--accent);
  font-weight: var(--fw-bold);
}

.stk .card.face {
  background: color-mix(in srgb, var(--text-1) 7%, var(--surface));
}

/* 叠层卡余量：跟时间标签同一行（卡面标题在窄列里不能被它挤掉）；点它在簇内轮换卡面 */
.more {
  flex: none;
  /* 父级 .bmin 整体禁指针（时间标签不该拦截拖拽），只有这枚徽标要可点 */
  pointer-events: auto;
  cursor: pointer;
  border: 0;
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 10%, transparent);
  font: inherit;
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

@media (hover: hover) {
  .more:hover {
    background: color-mix(in srgb, var(--text-1) 18%, transparent);
    color: var(--text-1);
  }
}

/* 拖拽影子 */
.ghost {
  position: absolute;
  z-index: 7;
  border: 1.5px dashed var(--accent);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  pointer-events: none;
}

/* 底部池 */
.pool {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--gap-sm);
  /* 与上方块区网格（56px 刻度栏 + 6px 右缘）对齐 */
  margin: 0 6px 0 56px;
}

.pcol {
  min-height: 34px;
  padding: var(--sp-6);
  border-radius: var(--radius-s);
  background: var(--surface-2);
}

.pcol.today {
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
}

.pitems {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-tight);
}

.pchip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  max-width: 100%;
  padding: var(--sp-2) var(--sp-8);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-full);
  background: var(--surface);
  font: inherit;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .pchip:hover {
    box-shadow: var(--shadow-card);
  }
}

.pchip:active {
  transform: scale(0.96);
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.ptt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 堆叠面板里的条目标题 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.padd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0.5px dashed var(--line-strong);
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}

@media (hover: hover) {
  .padd:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
}

.hint {
  margin: 0;
  /* 面板提示句，操作指令 */
  font-size: var(--fs-caption);
}

@media (max-width: 720px) {
  .scroll {
    height: 420px;
  }
}
</style>
