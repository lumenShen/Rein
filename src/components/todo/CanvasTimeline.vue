<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronRight, Layers, Pencil } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { CATEGORY_META } from '@/config/domain'
import { useZoomWheel } from '@/composables/useZoomWheel'
import { minToHHmm, nowMin, todayStr } from '@/utils/date'
import { durationOf as durOfShared, layoutDayBlocks } from '@/utils/timelineLayout'
import type { Todo } from '@/types'

/**
 * 单日画布时间轴：0-24 时连续刻度，块按 date+startMin+durationMin 定位。
 * - 左侧 48px 刻度栏，块区从 56px 起，不遮挡时间轴；时间跨度块上方标起点、下方标终点；
 * - 重叠块贪心分列：≤2 列并排；≥3 列收成「叠层卡」（全宽卡面 + 底层错位条 + 计数徽标，
 *   点开底部清单逐条勾选/定位），避免窄列把标题挤成省略号；
 * - 卡面控件按角分配：右下角「编辑」钮（所有块与叠层卡）emit edit 交父级开抽屉，
 *   叠层卡右上角「展开 +N」钮开同时段清单；两钮 pointerdown 即 stop，绝不进拖拽管线；
 * - 块内标题顶对齐、按块宽折行、按块高截行（行数上限 --blk-lines 由块高折算），
 *   放不下才在行末省略，不单行居中也不出现半行裁切；
 * - 点按选中、长按 320ms 武装后才可拖拽改位（防误触，武装后每 5 分钟吸附）；
 * - 拿起/放下走弹性过渡（右移让位/放大/浮影），跟手的 top 位移不过渡、不延迟；
 * - 外部拖入（未安排池）经 dropMin 显示落点线，落库由父级完成；
 * - Ctrl+滚轮缩放；过去未完成块降透明；现在线只锚定今天。
 */
const props = withDefaults(
  defineProps<{
    date: string
    /** 该日已排程的待办（date+startMin 均有值，由父级过滤） */
    todos: Todo[]
    /** AI 排程预览（未落库的幽灵块） */
    ghosts?: { todo: Todo; startMin: number }[]
    /** 外部拖入时的落点指示（距 00:00 分钟数），null = 无 */
    dropMin?: number | null
    selectedId?: number | null
    compact?: boolean
    /**
     * 画布已嵌在一张现成的卡片里（主页「今日画布」卡）：**不画自己的壳**。
     *
     * 为什么不干脆删掉 `.ctl` 的底色与描边：`/todos` 页的 `.tlwrap` 没有任何卡片样式，
     * 画布自己就是那一层表面 —— 删了它那边就只剩刻度线浮在页面渐变上。
     * 所以「要不要自带表面」必须由**放在哪里**决定，交给父级声明，而不是写死在组件里。
     * 顺带消掉的是「卡片套卡片」：主页那张卡里本不该再套一个带边框的盒子。
     */
    bare?: boolean
  }>(),
  { ghosts: () => [], dropMin: null, selectedId: null, compact: false, bare: false },
)

const emit = defineEmits<{
  select: [todo: Todo]
  toggle: [todo: Todo]
  move: [todo: Todo, startMin: number]
  edit: [todo: Todo]
}>()

const DEFAULT_PX = 56
const MIN_PX = 18
const MAX_PX = 104

/** .tt 行高与卡片纵向内边距（px）：按块高折算可完整显示的行数 */
const TT_LINE_H = 17
const TT_LINE_H_COMPACT = 16
const CARD_PAD_Y = 8

/**
 * 首行行高 —— **样式的唯一来源**。
 * 它同时决定三件事，三者必须永远相等：行数折算（`linesFor`）、CSS 里的 `--blk-lh`、
 * 以及勾选框尺寸 `--ck`（勾选框与行高等大，控件才和文字同档，在首行里也天生居中）。
 * 从前 CSS 各自写一份（17px / 16px），改一处忘另一处就会出现「算得出 2 行、视觉只放得下 1 行」
 * 这种谁也说不清的现象，所以这里统一由 TS 下发。
 */
const lineH = computed(() => (props.compact ? TT_LINE_H_COMPACT : TT_LINE_H))
const lineVars = computed(() => {
  const px = `${lineH.value}px`
  return { '--blk-lh': px, '--ck': px }
})

/**
 * 紧凑画布默认缩放（px/小时）。
 * 48 是「半小时块正好 24px」的临界值：块的最小高度是一行标题（16px）+ 上下内边距（8px），
 * 缩放低于它，最常见的半小时任务就被压到最小高度、首行被裁、彼此重叠 —— 而勾选框的尺寸
 * 等于行高，也就跟着塞不进去。
 */
const COMPACT_PX = 48

const px = ref(props.compact ? COMPACT_PX : DEFAULT_PX)
const scroller = ref<HTMLElement | null>(null)

const totalPx = computed(() => 24 * px.value)
const pxPerMin = computed(() => px.value / 60)

const hours = computed(() => {
  const step = px.value >= 42 ? 1 : 2
  const out: { min: number; label: string }[] = []
  for (let h = 0; h <= 24; h += step) out.push({ min: h * 60, label: `${String(h).padStart(2, '0')}:00` })
  return out
})

const isToday = computed(() => props.date === todayStr())
/** 现在分钟数：30s 轮询刷新，长驻页面时红线不走位 */
const nowMin_ = ref(nowMin())
let nowTimer: number | null = null
const nowTop = computed(() => nowMin_.value * pxPerMin.value)

/** 「现在」标签与整点刻度碰撞时隐藏该刻度，避免红线盖在背景时间上 */
function labelMasked(min: number): boolean {
  return isToday.value && Math.abs(min * pxPerMin.value - nowTop.value) < 16
}

/*
 * 关于「块的起止时间标会不会撞上刻度」：不会，也不需要因此隐藏。
 * 刻度栏在 `.inner` 的 0–40px，而块区从 56px 起（见 .blocks），所以两者的文字是**两列**、
 * 横向根本不相交（实测首页与 /todos 的 32 枚标签零重叠）。
 * 曾经试过「落在整点上就不写」的规则来消重影，但那只隐掉信息（12:00–13:00 这类整块两端
 * 都会消失）而没有任何碰撞可修，故撤掉。
 */

/* ---------- 布局：重叠贪心分列；≥3 列收成叠层卡 ---------- */

const durOf = durOfShared

interface Laid {
  t: Todo
  top: number
  h: number
  col: number
  cols: number
}

/** ≥3 条同时段的叠层簇：卡面展示 front，其余收进底部清单 */
interface Stack {
  key: string
  items: Todo[]
  top: number
  front: Todo
  /** 除卡面外的条数（徽标 +N） */
  extra: number
  /** 底层错位条的颜色（按后续条目的分类色，最多 2 条） */
  under: string[]
  h: number
}

/**
 * 块的最小高度 = 一行标题 + 上下内边距。
 * 勾选框与行高等大，所以这同时是「一个块最少要有多高才塞得下首行那一行」；
 * 低于它的块会把自己的首行（和勾选框）裁掉一截 —— 那不是可接受的退化。
 */
const minBlkH = computed(() => lineH.value + CARD_PAD_Y)

/**
 * 叠层卡最小高度：卡面要同时容下右上「展开」与右下「编辑」两枚控件，
 * 即 纵向内边距 ×2 + 展开钮 + 间隙 + 编辑钮（普通块只有右下编辑钮，现有最小高度已够）。
 * 数值须与样式里 .stk-card 内边距 / .stk-more 高度 / .edit 尺寸保持一致。
 */
const minStackH = computed(() => (props.compact ? 35 : 42))

/** 用户在清单里点选某条 → 置顶为卡面（会话内状态，跨日/重载自然失效） */
const frontByStack = ref(new Map<string, number>())

const stackKey = (items: Todo[]): string => `${items[0]!.id}-${items.length}`

const layout = computed(() => layoutDayBlocks(props.todos))

const laid = computed(() =>
  layout.value.blocks.map((b) => ({
    t: b.todo,
    top: b.startMin * pxPerMin.value,
    h: Math.max(minBlkH.value, b.durationMin * pxPerMin.value),
    col: b.col,
    cols: b.cols,
  })),
)

const stacks = computed(() =>
  layout.value.stacks.map((s) => {
    const sorted = [...s.items].sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0) || a.id - b.id)
    return {
      key: `${sorted[0]!.id}-${sorted.length}`,
      items: sorted,
      top: sorted[0]!.startMin! * pxPerMin.value,
      front: frontOf(sorted),
      extra: sorted.length - 1,
      under: sorted
        .filter((t) => t.id !== sorted[0]!.id)
        .slice(0, 2)
        .map((t) => CATEGORY_META[t.category].colorVar),
      h: Math.max(minStackH.value, durOf(sorted[0]!) * pxPerMin.value),
    }
  }),
)

/** 叠层簇的卡面项：用户点选置顶的优先（未完成），否则最早未完成，兜底最早 */
function frontOf(items: Todo[]): Todo {
  const pinnedId = frontByStack.value.get(stackKey(items))
  const pinned = pinnedId != null ? items.find((t) => t.id === pinnedId) : undefined
  if (pinned && pinned.status !== 'done') return pinned
  return items.find((t) => t.status !== 'done') ?? items[0]!
}

const ghostLaid = computed(() =>
  props.ghosts.map((g) => ({
    todo: g.todo,
    startMin: g.startMin,
    top: g.startMin * pxPerMin.value,
    h: Math.max(minBlkH.value, durOf(g.todo) * pxPerMin.value),
  })),
)

/** 块高 → 可完整显示的标题行数（至少 1 行；再放不下由 line-clamp 在行末省略） */
function linesFor(h: number): number {
  return Math.max(1, Math.floor((h - CARD_PAD_Y) / lineH.value))
}

/** 块定位（外层只管坐标与手势，卡片视觉在 .blk-card）：fit-content 收窄，列宽作上限；拖拽中实时跟手 */
function blkStyle(b: Laid): Record<string, string> {
  const dragging = drag.value?.armed && drag.value.todo.id === b.t.id
  const top = dragging ? drag.value!.curMin * pxPerMin.value : b.top
  return {
    top: `${top}px`,
    height: `${b.h}px`,
    left: `${(b.col / b.cols) * 100}%`,
    maxWidth: `calc(${100 / b.cols}% - 4px)`,
    '--blk-cat': `var(${CATEGORY_META[b.t.category].colorVar})`,
    '--blk-lines': `${linesFor(b.h)}`,
  }
}

/* ---------- 滚动 / 缩放 ---------- */

const { onWheel } = useZoomWheel(px, MIN_PX, MAX_PX)

/** 锚定：今天看"现在"附近，其它日子看第一个安排或 8 点 */
function scrollToAnchor(): void {
  const el = scroller.value
  if (!el) return
  const first = props.todos.reduce<number | null>(
    (acc, t) => (acc == null || t.startMin! < acc ? t.startMin! : acc),
    null,
  )
  const target = isToday.value ? nowMin() - 75 : (first ?? 8 * 60) - 60
  nextTick(() => {
    el.scrollTop = Math.max(0, Math.min(target * pxPerMin.value, totalPx.value - el.clientHeight))
  })
}

defineExpose({ scrollToAnchor, getPxPerMin: () => pxPerMin.value })

/* ---------- 块拖拽改位：长按武装后才可拖（防点按/滚动误触） ---------- */

/*
 * 块上手势优先级（高 → 低）：
 * 1. 控件：勾选钮 / 叠层展开钮，pointerdown 即 stop，绝不进入拖拽管线；
 * 2. 原生滚动：未武装阶段的位移归滚动，pointercancel（浏览器接管）只清理、绝不当点按；
 * 3. 拖拽：长按 320ms 武装后才可拖，期间 preventDefault 屏蔽滚动；
 * 4. 点按：仅 pointerup 正常结束、未武装、未超抖动距离（aborted）时选中。
 */
interface DragState {
  todo: Todo
  grabMin: number
  curMin: number
  /** 长按已武装：之后指针移动才改位 */
  armed: boolean
  /** 武装后指针实际移动过（松手判定 move） */
  moved: boolean
  /** 未武装时已超抖动距离（滚动/滑走）：作废，松手不再选中 */
  aborted: boolean
}

const LONGPRESS_MS = 320
const ARM_CANCEL_PX = 10

const drag = ref<DragState | null>(null)
let pressTimer: number | null = null
let downX = 0
let downY = 0

function clearPress(): void {
  if (pressTimer != null) {
    window.clearTimeout(pressTimer)
    pressTimer = null
  }
}

/** 收尾：清定时器与触摸拦截，返回本次手势状态（无则 null） */
function releaseDrag(): DragState | null {
  const d = drag.value
  clearPress()
  drag.value = null
  window.removeEventListener('touchmove', onTouchMove)
  return d
}

/** 武装后阻止浏览器把触摸手势判成滚动（否则 pointercancel 会掐断拖拽） */
function onTouchMove(e: TouchEvent): void {
  if (drag.value?.armed) e.preventDefault()
}

function onBlockDown(e: PointerEvent, t: Todo): void {
  if (t.status === 'done' || e.button !== 0) return
  const el = scroller.value
  if (!el) return
  // 课表派生行（courseSessionId 非空）是只读投影：标题/时间/地点都由课表同步生成，
  // 只能回课表配置页改。这里只关掉「长按武装」这一步 —— 点选与抛滚手势全部照旧，
  // 长按则什么都不发生，比整体禁用更不容易误触。
  const readonly = t.courseSessionId != null
  const rect = el.getBoundingClientRect()
  const pointerMin = (e.clientY - rect.top + el.scrollTop) / pxPerMin.value
  drag.value = { todo: t, grabMin: pointerMin - t.startMin!, curMin: t.startMin!, armed: false, moved: false, aborted: false }
  downX = e.clientX
  downY = e.clientY
  // 合成指针 / 指针已失效等边缘会抛 NotFoundError：吞掉即可，只影响出界跟踪
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 无有效指针：拖拽沿元素事件继续 */
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
  const el = scroller.value
  if (!d || !el) return
  if (!d.armed) {
    // 未武装的移动是普通手势（滚动/滑走）：超抖动距离即放弃长按并作废点按
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > ARM_CANCEL_PX) {
      clearPress()
      d.aborted = true
    }
    return
  }
  d.moved = true
  const rect = el.getBoundingClientRect()
  const pointerMin = (e.clientY - rect.top + el.scrollTop) / pxPerMin.value
  const dur = durOf(d.todo)
  d.curMin = Math.round(Math.max(0, Math.min(pointerMin - d.grabMin, 1440 - dur)) / 5) * 5
}

function onBlockUp(): void {
  const d = releaseDrag()
  if (!d) return
  if (d.moved) emit('move', d.todo, d.curMin)
  else if (!d.armed && !d.aborted) emit('select', d.todo)
  // 武装后原地松手 / 已作废手势：无动作，避免误开详情
}

/** pointercancel（浏览器接管滚动、多指等）：只清理，绝不当点按 */
function onBlockCancel(): void {
  releaseDrag()
}

/** 拖拽中的实时起点（其余情况返回落库值） */
const liveStart = (t: Todo, fallback: number) =>
  drag.value?.armed && drag.value.todo.id === t.id ? drag.value.curMin : fallback

/* ---------- 叠层簇：卡面拖拽/勾选复用块逻辑，点按开底部清单 ---------- */

/** 叠层卡定位：拖拽中跟手（卡面项的当前分钟） */
function stkStyle(s: Stack): Record<string, string> {
  const dragging = drag.value?.armed && drag.value.todo.id === s.front.id
  return {
    top: `${dragging ? drag.value!.curMin * pxPerMin.value : s.top}px`,
    height: `${s.h}px`,
    '--blk-cat': `var(${CATEGORY_META[s.front.category].colorVar})`,
    '--blk-lines': `${linesFor(s.h)}`,
  }
}

const activeStackKey = ref<string | null>(null)
const stackOpen = ref(false)
const activeStack = computed(() => stacks.value.find((s) => s.key === activeStackKey.value) ?? null)

function openStack(s: Stack): void {
  activeStackKey.value = s.key
  stackOpen.value = true
}

/** 清单点选：置顶为卡面并冒泡选中（详情抽屉由父级打开） */
function pickStackItem(t: Todo): void {
  if (activeStack.value) frontByStack.value.set(activeStack.value.key, t.id)
  stackOpen.value = false
  emit('select', t)
}

function onStackUp(s: Stack): void {
  const d = releaseDrag()
  if (d?.moved) emit('move', d.todo, d.curMin)
  else if (d && !d.armed && !d.aborted) openStack(s)
}

onMounted(() => {
  scrollToAnchor()
  nowTimer = window.setInterval(() => {
    nowMin_.value = nowMin()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (nowTimer != null) window.clearInterval(nowTimer)
  clearPress()
  drag.value = null
  window.removeEventListener('touchmove', onTouchMove)
})
</script>

<template>
  <div class="ctl" :class="{ compact, bare }" :style="lineVars" @wheel="onWheel">
    <div ref="scroller" class="scroll" data-testid="canvas-scroll">
      <div class="inner" :style="{ height: `${totalPx}px` }" data-rubber-content>
        <template v-for="h in hours" :key="h.min">
          <span v-show="!labelMasked(h.min)" class="hlab num" :style="{ top: `${h.min * pxPerMin}px` }">{{ h.label }}</span>
          <i class="hline" :style="{ top: `${h.min * pxPerMin}px` }" />
        </template>

        <!-- 现在线（仅今天） -->
        <div v-if="isToday" class="nowline" :style="{ top: `${nowTop}px` }">
          <span class="nowtag num">现在</span>
        </div>

        <!-- 外部拖入落点指示：位移走 transform（top 恒 0），短过渡平滑 5min 吸附台阶 -->
        <div v-if="dropMin != null" class="dropline" :style="{ transform: `translateY(${dropMin * pxPerMin}px)` }" />

        <!-- 待办块区：整体右移让出左侧刻度栏，块上标起点、下标终点 -->
        <div class="blocks">
          <div
            v-for="b in laid"
            :key="b.t.id"
            class="blk"
            :class="{
              done: b.t.status === 'done',
              sel: selectedId === b.t.id,
              past: isToday && b.t.startMin! + durOf(b.t) < nowMin_ && b.t.status !== 'done',
              dragging: drag?.armed && drag.todo.id === b.t.id,
              prog: b.t.programId != null,
            }"
            :style="blkStyle(b)"
            :data-title="b.t.title"
            @pointerdown="onBlockDown($event, b.t)"
            @pointermove="onBlockMove"
            @pointerup="onBlockUp"
            @pointercancel="onBlockCancel"
            @contextmenu.prevent
          >
            <span class="bmin bmin-start num" :class="{ live: drag?.armed && drag.todo.id === b.t.id }">{{ minToHHmm(liveStart(b.t, b.t.startMin!)) }}</span>
            <div class="blk-card">
              <button
                class="ck"
                :aria-label="b.t.status === 'done' ? '标记未完成' : '标记完成'"
                @pointerdown.stop
                @click.stop="emit('toggle', b.t)"
              />
              <div class="body">
                <!-- 「来自健康方案」原先只写在 Target 图标的 aria-label 里，界面上只剩
                     一枚没图例的靶心；改成标题前一枚「方案」胶囊，来源一眼可读 -->
                <StatusChip v-if="b.t.programId != null" tone="accent" size="sm" class="srcchip">方案</StatusChip>
                <span class="tt">{{ b.t.title }}</span>
              </div>
              <button
                class="edit"
                :aria-label="`编辑 ${b.t.title}`"
                @pointerdown.stop
                @click.stop="emit('edit', b.t)"
              >
                <Pencil :size="9" :stroke-width="2.6" />
              </button>
            </div>
            <span class="bmin bmin-end num" :class="{ live: drag?.armed && drag.todo.id === b.t.id }">{{ minToHHmm(liveStart(b.t, b.t.startMin!) + durOf(b.t)) }}</span>
          </div>

          <!-- 叠层簇：≥3 条同时段，卡面展示 front，点开清单处理其余 -->
          <div
            v-for="s in stacks"
            :key="`s-${s.key}`"
            class="stk"
            :class="{ dragging: drag?.armed && drag.todo.id === s.front.id }"
            :style="stkStyle(s)"
            :data-title="`${s.items.length} 项同时段日程`"
            @pointerdown="onBlockDown($event, s.front)"
            @pointermove="onBlockMove"
            @pointerup="onStackUp(s)"
            @pointercancel="onBlockCancel"
            @contextmenu.prevent
          >
            <span class="bmin bmin-start num" :class="{ live: drag?.armed && drag.todo.id === s.front.id }">{{ minToHHmm(liveStart(s.front, s.front.startMin!)) }}</span>
            <i
              v-for="(cv, i) in s.under"
              :key="i"
              class="stk-under"
              :style="{ background: `color-mix(in srgb, var(${cv}) 14%, var(--surface))`, transform: `translateY(${(i + 1) * (compact ? 3 : 4)}px)` }"
            />
            <div
              class="stk-card"
              :class="{ done: s.front.status === 'done', sel: selectedId === s.front.id, prog: s.front.programId != null }"
            >
              <button
                class="ck"
                :aria-label="s.front.status === 'done' ? '标记未完成' : '标记完成'"
                @pointerdown.stop
                @click.stop="emit('toggle', s.front)"
              />
              <div class="body">
                <StatusChip v-if="s.front.programId != null" tone="accent" size="sm" class="srcchip">方案</StatusChip>
                <span class="tt">{{ s.front.title }}</span>
              </div>
              <div class="card-acts">
                <button class="stk-more" :aria-label="`展开同时段 ${s.items.length} 项日程`" @pointerdown.stop @click.stop="openStack(s)">
                  <Layers :size="11" :stroke-width="2.4" />
                  +{{ s.extra }}
                </button>
                <button
                  class="edit"
                  :aria-label="`编辑 ${s.front.title}`"
                  @pointerdown.stop
                  @click.stop="emit('edit', s.front)"
                >
                  <Pencil :size="9" :stroke-width="2.6" />
                </button>
              </div>
            </div>
            <span class="bmin bmin-end num" :class="{ live: drag?.armed && drag.todo.id === s.front.id }">{{ minToHHmm(liveStart(s.front, s.front.startMin!) + durOf(s.front)) }}</span>
          </div>

          <!-- AI 排程预览（幽灵块） -->
          <div
            v-for="g in ghostLaid"
            :key="`g-${g.todo.id}`"
            class="blk ghost"
            :style="{ top: `${g.top}px`, height: `${g.h}px`, left: '0%', maxWidth: '100%', '--blk-lines': `${linesFor(g.h)}` }"
          >
            <div class="body">
              <b class="num">{{ minToHHmm(g.startMin) }}</b>
              <span class="tt">{{ g.todo.title }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 同时段清单：叠层簇展开，逐条勾选或定位 -->
    <SheetModal :open="stackOpen" :title="`同时段 ${activeStack?.items.length ?? 0} 项安排`" @close="stackOpen = false">
      <ul class="stk-list">
        <li v-for="t in activeStack?.items ?? []" :key="t.id">
          <i class="dot" :style="{ background: `var(${CATEGORY_META[t.category].colorVar})` }" />
          <span class="num stk-time">{{ minToHHmm(t.startMin!) }}</span>
          <button
            class="ck"
            :aria-label="t.status === 'done' ? '标记未完成' : '标记完成'"
            @click="emit('toggle', t)"
          />
          <button class="stk-row" @click="pickStackItem(t)">
            <span class="tt" :class="{ done: t.status === 'done' }">{{ t.title }}</span>
            <ChevronRight :size="13" class="t-3" />
          </button>
        </li>
      </ul>
      <p class="stk-hint t-2">点条目在画布上置顶并查看详情。</p>
    </SheetModal>
  </div>
</template>

<style scoped>
.ctl {
  /* --blk-lh / --ck 由 TS 下发（见 lineVars）：行数折算与视觉行高只能有一个来源 */
  position: relative;
  border-radius: var(--radius-m);
  background: var(--surface);
  border: 0.5px solid var(--line);
  overflow: hidden;
}

/* 嵌在现成卡片里（主页「今日画布」）：不画自己的壳，让刻度线与上下缘渐隐充当结构 ——
   与「摄入总览」把条直接铺在卡面上是同一种做法。方形圆角一并归零，免得留下看不见的内圆角。 */
.ctl.bare {
  background: transparent;
  border: 0;
  border-radius: 0;
}

.scroll {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  /* 上下缘 12px 渐隐：锚定「现在」后首尾刻度正好压在滚动口边界上，
     不渐隐就是半截字悬在窗口边（看起来像裁切 bug）。 */
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 12px,
    #000 calc(100% - 12px),
    transparent 100%
  );
}

.inner {
  position: relative;
  margin: 0 var(--sp-10) 0 0;
}

/* 刻度标签：与「摄入总览」里 `.m-label`（蛋白质 / 碳水 / 脂肪 那排）同一规格 ——
   小号、半粗、最浅一档灰。「刻度」是标签角色，不是要读的数字。 */
.hlab {
  position: absolute;
  left: 0;
  width: 40px;
  text-align: right;
  transform: translateY(-6px);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-3);
}

/* 刻度线：与「摄入总览」的 `.hr` 同规格（1px / --text-1 10%）。
   原先是 0.5px 的 `--line`（7% 黑），在白卡上淡到几乎看不见；嵌卡（bare）之后刻度线
   就是画布唯一的结构，所以升到项目里「分隔」这一角色真正在用的那一档。 */
.hline {
  position: absolute;
  left: 48px;
  right: 0;
  height: 1px;
  background: color-mix(in srgb, var(--text-1) 10%, transparent);
}

.nowline {
  position: absolute;
  left: 48px;
  right: 0;
  /* 实底 + 满圆角：直接引用「摄入总览」那枚参考线胶囊的几何（细、实、全圆）。
     从前是 1.5px 上边框 —— 零高度盒子描边既不能圆角，也细得几乎看不见。 */
  height: 2px;
  border-radius: var(--radius-full);
  background: var(--danger);
  z-index: 2;
}

.nowline::before {
  content: '';
  position: absolute;
  left: -4px;
  top: -2.5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}

/* 「现在」胶囊：
   宽度**随文字收缩**，左右内边距对称 —— 于是文字天生居中。
   从前写死 `width: 40px; text-align: right`：那 40px 本来只是为了与左侧刻度栏右对齐，
   但背景同样铺满这 40px，结果胶囊 40px 宽、文字被推到右缘，左内边距 18px、右 0。
   定位改为「右缘贴住刻度栏右缘」：`right: 100%` 把右缘放到 .nowline 的左缘（= 48px），
   再退 8px 就是刻度栏的右缘 40px —— 与 .hlab 同一列，且宽度不定也能对上。
   垂直用 translateY(-50%) 锚在 .nowline（高 2px）的中心，与字号无关。

   实底红 + 白字：白字压 `--danger`(#ff3b30) 实测只有 3.55:1，11px 够不着 4.5 的门槛，
   所以底色取 `--danger-strong`（白字 5.87:1）—— 与主页「去复盘」按钮是同一对配色。 */
.nowtag {
  position: absolute;
  right: 100%;
  margin-right: var(--gap-sm);
  top: 1px;
  transform: translateY(-50%);
  padding: var(--sp-2) var(--sp-6);
  /* 「现在」是定位词；白字压 --danger-strong 只有 5.87:1，11px 粗体勉强够，
     提一档到 12px 更稳，且不撑高（line-height: 1）+ 视觉仍是角标 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  line-height: 1;
  white-space: nowrap;
  color: var(--on-accent);
  background: var(--danger-strong);
  border-radius: var(--radius-full);
}

.dropline {
  position: absolute;
  left: 48px;
  right: 6px;
  top: 0;
  height: 0;
  border-top: 2px dashed var(--accent);
  z-index: 3;
  /* 位置由 transform 提供：过渡平滑吸附台阶，进场淡入 */
  transition: transform var(--dur-fast) var(--ease-standard);
  animation: dropline-in var(--dur-fast) var(--ease-standard);
}

@keyframes dropline-in {
  from {
    opacity: 0;
  }
}

/* 块区：右移让出左侧 48px 刻度栏 + 8px 间隙，永不遮挡时间标签 */
.blocks {
  position: absolute;
  left: 56px;
  right: 6px;
  top: 0;
  bottom: 0;
}

.blk {
  position: absolute;
  /* 收窄包裹内容（列宽为上限，超长标题省略） */
  width: fit-content;
  max-width: 100%;
  cursor: grab;
  z-index: 1;
  /* 长按拖拽与原生文本选择/长按菜单互斥，手势归拖拽管线 */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  /* 拿起/放下：右移让位走弹性过渡；跟手的 top 不在列表里（直接操纵不延迟） */
  transition:
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-standard);
}

.blk-card {
  /* 流内撑满父级高度（父 .blk fit-content 靠它量宽；absolute 子元素不参与 shrink-to-fit） */
  height: 100%;
  display: flex;
  /* 顶对齐：标题从块顶向下折行铺开，不悬浮居中 */
  align-items: flex-start;
  gap: var(--gap-sm);
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-s);
  overflow: hidden;
  background: color-mix(in srgb, var(--blk-cat) 15%, var(--surface));
  /* 边缘区分：分类色描边 + 轻投影（与卡片系组件同一配方） */
  border: 0.5px solid color-mix(in srgb, var(--blk-cat) 38%, var(--line));
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text-1) 9%, transparent);
  transition:
    box-shadow var(--dur-fast) var(--ease-standard),
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .blk:hover .blk-card {
    box-shadow: var(--shadow-card);
  }
}

.blk.sel .blk-card {
  box-shadow: 0 0 0 2px var(--accent);
}

/* 来自健康方案的条目：分类色之外再加一道强调色左棱 + 标题前的「方案」胶囊，
   与普通待办一眼可分（方案日程是「课表」，不是随手记的待办）；
   颜色仍走分类色 + 一个强调色棱，不新增一套颜色语义 */
.blk.prog .blk-card,
.stk.prog .stk-card {
  border-left: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
}

/* 「方案」胶囊：块内不放缩，标题再窄也先砍标题（.tt 有 line-clamp） */
.srcchip {
  flex: none;
  align-self: center;
}

/* 起止时间标记：上方起点、下方终点；拖拽中高亮为实时时间。
   这是要读的**数字**，按「摄入总览」的规矩给足待遇 ——
   中性深色 `--text-2`（白底 5.07:1）而不是最浅的 `--text-3`（3.6:1），字重 700 配 tabular
   （模板上的 `.num`）。从前是 10px / 600 / `--text-3`，紧凑档更只有 9px —— 比字号阶梯最低档还小。 */
.bmin {
  position: absolute;
  left: 2px;
  font-size: var(--fs-caption);
  line-height: 1;
  font-weight: var(--fw-bold);
  color: var(--text-2);
  pointer-events: none;
  white-space: nowrap;
  /* 起止标记拖拽中高亮为实时时间：颜色跟上抬起节奏 */
  transition: color var(--dur-fast) var(--ease-standard);
}

.bmin-start {
  top: -15px;
}

.bmin-end {
  top: calc(100% + 3px);
}

.bmin.live {
  color: var(--accent);
  font-weight: var(--fw-bold);
}

.blk.dragging {
  z-index: 4;
  /* 拖起时整体右移让出原位：不遮挡左侧时间轴与底层块，读得清起点 */
  transform: translateX(12px);
}

.blk.dragging .blk-card {
  opacity: 0.88;
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

/* 已过时刻未完成：整体降透明（现在线之后的"还剩下"保持满格） */
.blk.past {
  opacity: 0.55;
}

/* 勾选框：尺寸 = 首行行高（--ck），于是它与文字同档、在首行里天生居中，不需要 margin 补偿 */
.ck {
  position: relative;
  flex: none;
  width: var(--ck);
  height: var(--ck);
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  background: transparent;
  padding: 0;
}

/* 触达：视觉尺寸是排版规格（--ck 跟随首行行高），不该为触控改掉；但 44 是拇指下限，
   而勾选是画布上最高频的动作。用 ::after 把命中区撑到 44×44（PageHeader .back 同款惯用法），
   排版一格不变。它盖住的是同一格日程内的空白，不会抢到邻块的点击。 */
.ck::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

@media (hover: hover) {
  .ck:hover {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 18%, transparent);
  }
}

.body {
  display: flex;
  /* 幽灵块里时间与标题同行：基线对齐首行；块内单标题时无感 */
  align-items: baseline;
  gap: var(--gap-sm);
  min-width: 0;
}

.tt {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

/* 画布块内标题：顶对齐、按块宽折行、按块高截行（--blk-lines 由块高折算），放不下才省略 */
.blk-card .tt,
.stk-card .tt,
.blk.ghost .tt {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--blk-lines, 1);
  overflow: hidden;
  line-height: var(--blk-lh, 17px);
  overflow-wrap: break-word;
}

/* 幽灵块：AI 预览，虚线描边；出现淡入（预览生成是瞬时状态切换，不该闪现） */
.blk.ghost {
  border: 1.5px dashed var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-s);
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  padding: var(--sp-4) var(--sp-8);
  overflow: hidden;
  cursor: default;
  z-index: 2;
  animation: ghost-in var(--dur-base) var(--ease-standard);
}

@keyframes ghost-in {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
}

.blk.ghost .body b {
  /* 时段标题（「第 3 节」这类）是日历块上的信息，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

/* ---------- 叠层簇（≥3 条同时段） ---------- */

.stk {
  position: absolute;
  left: 0;
  width: 100%;
  z-index: 2;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  /* 与 .blk 同配方：拿起右移/放下归位走弹性过渡 */
  transition: transform var(--dur-base) var(--ease-spring);
}

.stk.dragging {
  z-index: 4;
  transform: translateX(12px);
}

/* 底层错位条：按后续条目的分类色淡染，向下错位露出「还有几张」 */
.stk-under {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 0;
  height: 100%;
  border-radius: var(--radius-s);
  pointer-events: none;
}

.stk-card {
  position: relative;
  display: flex;
  /* 与 .blk-card 同配方：顶对齐铺开 */
  align-items: flex-start;
  gap: var(--gap-sm);
  height: 100%;
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-s);
  /* 卡面必须不透明：底层错位条（.stk-under）铺在卡面之后，透出来会让卡面看着发灰发虚 */
  background: color-mix(in srgb, var(--blk-cat) 15%, var(--surface));
  border: 0.5px solid color-mix(in srgb, var(--blk-cat) 38%, var(--line));
  overflow: hidden;
  cursor: grab;
  box-shadow: 0 1px 4px color-mix(in srgb, var(--text-1) 8%, transparent);
  transition:
    box-shadow var(--dur-fast) var(--ease-standard),
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .stk-card:hover {
    box-shadow: var(--shadow-card);
  }
}

.stk-card.sel {
  box-shadow: 0 0 0 2px var(--accent);
}

.stk.dragging .stk-card {
  opacity: 0.85;
  box-shadow: var(--shadow-float);
  cursor: grabbing;
}

.stk-card.done {
  opacity: 0.45;
}

.stk-card.done .tt {
  text-decoration: line-through;
}

.stk-more {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 高度写死：叠层卡最小高度按「展开钮 + 编辑钮」折算（见 minStackH），不能随字号浮动 */
  height: 18px;
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  /* 「展开同时段 N 项」是操作按钮，不吃 11px；下方 .compact 里另有降档规则 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  white-space: nowrap;
}

/* 展开钮：高 18px 的密集控件，命中区纵向撑到 44（横向不外扩：右侧就是编辑钮） */
.stk-more::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 44px;
  transform: translateY(-50%);
}

.stk-more:active {
  transform: scale(0.96);
}

/* 卡面右侧控件列：右上「展开本簇」、右下「编辑」，两块控件各占一行 */
.card-acts {
  flex: none;
  margin-left: auto;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--gap-text);
}

/* 卡片右下角编辑钮：比勾选框低一档的次级控件（勾选框与行高等大，它是一枚角标），
   紧凑再缩一档；最小块高也放得下 */
.edit {
  position: relative;
  flex: none;
  align-self: flex-end;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
  color: var(--text-2);
  transition: background-color var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .edit:hover {
    background: color-mix(in srgb, var(--text-1) 16%, transparent);
    color: var(--text-1);
  }
}

.edit svg {
  width: 9px;
  height: 9px;
}

/* 编辑钮：11~14px 的图标钮，::after 把命中区撑到 44×44（与 .ck 同一条理由）；
   它贴在块右下角，外扩出的圆形只盖住本块内的空白。 */
.edit::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

/* 同时段清单 */
.stk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--gap-text);
}

.stk-list li {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-2) 0;
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.stk-time {
  flex: none;
  min-width: 40px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.stk-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  padding: var(--sp-8) var(--sp-4);
  text-align: left;
  font: inherit;
  color: inherit;
}

.stk-row .tt {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stk-row .tt.done {
  color: var(--text-3);
  text-decoration: line-through;
}

.stk-hint {
  margin-top: var(--gap-sm);
  /* 「点条目在画布上置顶并查看详情」是操作指令，不吃 11px */
  font-size: var(--fs-caption);
}

.compact .stk-more {
  height: 14px;
  padding: 0 var(--sp-6);
}

.compact .edit {
  width: 11px;
  height: 11px;
}

.compact .edit svg {
  width: 8px;
  height: 8px;
}

.compact .tt {
  font-size: var(--fs-caption);
}

/* 紧凑档的整点/结束时刻：这里**保留 11px** 是量出来的取舍，不是漏改 ——
   紧凑档每小时只有 48px（`/todos` 在窄视口也用这一档），时刻戳从块内移到块外
   那一行（.bmin-start top: -13px），字号再大就会压到上邻块的标题。
   时刻戳本身是定位信息，但它旁边就是块标题（.tt，12px），对照即可读出。 */
.compact .bmin {
  font-size: var(--fs-micro);
}

.compact .bmin-start {
  top: -13px;
}

/* ============ 桌面壳：画布上的两枚小控件放大到指针精度 ============

   实测（1512 #/todos）：.ck 17×17、.edit 14×14 —— 都低于 22 的下限，一屏十来个。
   但这两个尺寸不是随手的：.ck 与首行行高等大（`--ck`，与 `--blk-lh`、行数折算
   三个数必须永远相等，见 TS 的 lineH），.edit 是右下角一枚角标，它们的**视觉**
   尺寸是排版规格，不能动。

   所以这里只放大**按钮盒**，圆环/角标改由内层伪元素按原尺寸画：
   · 盒用负外边距吃回原占位（WorkoutRow 的 .del 同款惯用法）——
     块宽、标题折行、与首行的居中关系全都不变，minBlkH 也照旧；
   · 盒以原中心为心放大，所以在最小块（minBlkH = 行高 17 + 卡片内边距 8 = 25）里
     也不会被 .blk-card 的 overflow 裁到：.ck 的盒占 1.5~23.5，
     .edit 的盒贴到卡片下缘（3~25），都在卡片内。
   · 叠层卡的 .card-acts 是纵向排布（.stk-more 18 + 间隙 2 + .edit），
     负外边距让 .edit 的**外边距盒**仍是 14，那一列的总高没变 ——
     所以 minStackH(42) 不需要跟着改。 */

.desk-main .ck {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-width: 22px;
  min-height: 22px;
  /* (--ck - 22) / 2：原占位一分不多一分不少，圆环还在首行的同一条中线上 */
  margin: calc((var(--ck) - 22px) / 2);
  border: 0;
}

.desk-main .ck::before {
  content: '';
  width: var(--ck);
  height: var(--ck);
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
}

/* 基准的 .ck:hover 画在按钮自己的盒上（描边 + 淡绿底）——盒放大后那一圈会明显比
   圆环大一码，所以底色/描边一律改到 ::before 上，按钮盒保持透明。 */
.desk-main .ck:hover {
  background: transparent;
}

@media (hover: hover) {
  .desk-main .ck:hover::before {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 18%, transparent);
  }
}

.desk-main .edit {
  min-width: 22px;
  min-height: 22px;
  /* margin-left 仍是 auto（贴右端）；多出的 4px 用负外边距吃回，右下角位置不动 */
  margin: calc(-1 * var(--sp-4)) calc(-1 * var(--sp-4)) calc(-1 * var(--sp-4)) auto;
  background: transparent;
}

/* 角标改画在绝对定位的伪元素上：若做成流内 flex 项，它会把铅笔图标挤到旁边 */
.desk-main .edit::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 14px;
  height: 14px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
}

/* 基准的 .edit:hover 也是画在按钮盒上的（会变成一颗 22px 的灰丸），照 .ck 的处置 */
.desk-main .edit:hover {
  background: transparent;
}

@media (hover: hover) {
  .desk-main .edit:hover {
    color: var(--text-1);
  }

  .desk-main .edit:hover::before {
    background: color-mix(in srgb, var(--text-1) 16%, transparent);
  }
}

/* 叠层卡的展开钮（18px）同一配方：它只在同一时段挤了 ≥3 条时才出现，
   当前夹具里没有，但它是同一类「小于 22 的可见控件」，一并补上。
   同样用负外边距保住 .card-acts 那一列的排布（18 + 2 + 14）。 */
.desk-main .stk-more {
  min-height: 22px;
  margin-block: calc(-1 * var(--gap-text));
}
</style>
