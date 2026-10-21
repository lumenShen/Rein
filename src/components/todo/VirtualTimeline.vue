<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, LocateFixed } from 'lucide-vue-next'

import { CATEGORY_META } from '@/config/domain'
import { useTodoStore } from '@/stores/todo'
import { addDays, diffDays, fmtDateCn, minToHHmm, nowMin, todayStr } from '@/utils/date'
import type { Todo } from '@/types'

/**
 * 虚拟时间线：从最早待办前一天到最晚待办后一天（至少含今天±1 天）的连续时间轴。
 * - 只渲染可视窗口内的标签 / 网格 / 待办块（虚拟化），滚动与惯性交给外层容器；
 * - full（抽屉展开态）：外层容器上下滑动，顶部浮条实时显示视口中心时刻，
 *   双指或 Ctrl+滚轮缩放数轴（以视口中心为轴心）；
 * - preview（卡片折叠态）：固定高度锚定今天，不可滚动，点按 emit('open')。
 */
const props = defineProps<{
  /** 全量待办（只取 date + startMin 都有值的） */
  todos: Todo[]
  /** 锚定日期（今天）：now 线与预览锚点 */
  date: string
  preview?: boolean
}>()

const emit = defineEmits<{ open: [] }>()

const store = useTodoStore()

const DEFAULT_PX = 56
const MIN_PX = 16
const MAX_PX = 112
const PREVIEW_H = 288
const PAD_DAYS = 1
const BUFFER_PX = 600

const pxPerHour = ref(DEFAULT_PX)
const scrollTop = ref(0)
const viewH = ref(0)
const host = ref<HTMLElement | null>(null)

const today = todayStr()
const isPreview = computed(() => !!props.preview)

const scheduled = computed(() => props.todos.filter((t) => t.date != null && t.startMin != null))

/** 覆盖到的日期集合：所有带时间待办的日期 ∪ 锚定日期 */
const allDates = computed(() => {
  const set = new Set<string>([props.date])
  for (const t of scheduled.value) set.add(t.date!)
  return [...set].sort()
})

/** 图上首尾天（各往外扩 PAD_DAYS，保证上下能"看空白"） */
const startDay = computed(() => addDays(allDates.value[0]!, -PAD_DAYS))
const endDay = computed(() => addDays(allDates.value[allDates.value.length - 1]!, PAD_DAYS))
const dayCount = computed(() => Math.max(1, diffDays(startDay.value, endDay.value) + 1))
const totalPx = computed(() => dayCount.value * 24 * pxPerHour.value)

function yOf(date: string, min: number): number {
  return diffDays(startDay.value, date) * 24 * pxPerHour.value + (min * pxPerHour.value) / 60
}

/* ---------- 虚拟化渲染 ---------- */

const range = computed(() => {
  const top = Math.max(0, scrollTop.value - BUFFER_PX)
  const bottom = Math.min(totalPx.value, scrollTop.value + viewH.value + BUFFER_PX)
  return { top, bottom }
})

/** 小时刻度的步进随缩放密度变化：1h / 2h / 4h */
const ticks = computed(() => {
  const step = pxPerHour.value >= 56 ? 1 : pxPerHour.value >= 26 ? 2 : 4
  const stepPx = step * pxPerHour.value
  const out: { y: number; label: string }[] = []
  const first = Math.floor(range.value.top / stepPx)
  const last = Math.min(Math.ceil(range.value.bottom / stepPx), dayCount.value * (24 / step))
  for (let h = Math.max(0, first); h <= last; h++) {
    const min = h * step * 60
    out.push({
      y: (min / 60) * pxPerHour.value,
      label: `${String((h * step) % 24).padStart(2, '0')}:00`,
    })
  }
  return out
})

const dayHeads = computed(() =>
  allDates.value
    .map((d) => ({ d, y: diffDays(startDay.value, d) * 24 * pxPerHour.value }))
    .filter((x) => x.y >= range.value.top && x.y <= range.value.bottom),
)

const nowTop = computed(() => yOf(today, nowMin()))
const showNow = computed(() => nowTop.value >= range.value.top && nowTop.value <= range.value.bottom)

const blocks = computed(() => {
  const out: { t: Todo; top: number; h: number }[] = []
  for (const t of scheduled.value) {
    const top = yOf(t.date!, t.startMin!)
    if (top < range.value.top || top > range.value.bottom) continue
    const h = t.durationMin
      ? Math.max(22, Math.min(240, (t.durationMin / 60) * pxPerHour.value))
      : 28
    out.push({ t, top, h })
  }
  return out.sort((a, b) => a.top - b.top)
})

/* ---------- 顶部时间条（仅 full） ---------- */

const gauge = computed(() => {
  const px = scrollTop.value + Math.max(0, viewH.value) / 2
  const minutes = Math.max(0, (px * 60) / pxPerHour.value)
  const dayIdx = Math.floor(minutes / 1440)
  const d = addDays(startDay.value, Math.min(dayIdx, dayCount.value - 1))
  const m = Math.round(minutes - dayIdx * 1440)
  return {
    date: d,
    min: Math.min(1439, m),
    isNow: d === today && Math.abs(m - nowMin()) < 5,
  }
})

/* ---------- 滚动与缩放 ---------- */

function scroller(): HTMLElement | null {
  if (!host.value) return null
  // 预览态：宿主自身（overflow hidden，靠程序化 scrollTop 锚定）；
  // 展开态：真正的滚动容器是 SheetModal 的 .body（宿主的父节点），
  // 宿主自己没有 overflow，对它写 scrollTop / 监听 scroll 都不生效。
  return isPreview.value ? host.value : host.value.parentElement
}

function clampPos(v: number): number {
  return Math.min(Math.max(v, 0), Math.max(0, totalPx.value - viewH.value))
}

function setScroll(v: number): void {
  const el = scroller()
  if (!el) return
  el.scrollTop = clampPos(v)
  scrollTop.value = el.scrollTop
}

function onScroll(): void {
  const el = scroller()
  if (!el) return
  scrollTop.value = el.scrollTop
}

function measure(): void {
  const el = scroller()
  if (!el) return
  viewH.value = el.clientHeight
}

/** 以视口内 y（相对视口顶）为轴心缩放数轴，保持该处时刻不动 */
function zoom(factor: number, yViewport: number): void {
  const px0 = pxPerHour.value
  const pxNew = Math.min(Math.max(px0 * factor, MIN_PX), MAX_PX)
  if (pxNew === px0) return
  const anchorPx = scrollTop.value + yViewport
  const minutes = (anchorPx * 60) / px0
  pxPerHour.value = pxNew
  setScroll((minutes * pxNew) / 60 - yViewport)
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  const hostRect = (isPreview.value ? host.value : scroller())?.getBoundingClientRect()
  if (!hostRect) return
  e.preventDefault()
  zoom(e.deltaY > 0 ? 1 / 1.18 : 1.18, e.clientY - hostRect.top)
}

interface PinchState {
  /** 上一帧的两指间距：因子相对上一帧取增量，相对起点累计会越捏越快 */
  d0: number
  yCenter: number
}
let pinch: PinchState | null = null

function pinchPoints(e: TouchEvent): { d: number; yCenter: number } | null {
  if (e.touches.length < 2) return null
  const [a, b] = [e.touches[0]!, e.touches[1]!]
  const rect = (isPreview.value ? host.value : scroller())?.getBoundingClientRect()
  if (!rect) return null
  const dx = a.clientX - b.clientX
  const dy = a.clientY - b.clientY
  return {
    d: Math.hypot(dx, dy),
    yCenter: (a.clientY + b.clientY) / 2 - rect.top,
  }
}

function onTouchStart(e: TouchEvent): void {
  const st = pinchPoints(e)
  pinch = st ? { d0: st.d, yCenter: st.yCenter } : null
}

function onTouchMove(e: TouchEvent): void {
  const st = pinchPoints(e)
  if (!st) return
  if (!pinch) {
    // 滚动中再落下一指：此时才开启捏合，免首帧跳变
    pinch = { d0: st.d, yCenter: st.yCenter }
    return
  }
  // 双指缩放：以两指中点（相对视口）为轴，滚动交给 zoom 保持时刻
  e.preventDefault()
  zoom(st.d / pinch.d0, pinch.yCenter)
  pinch.d0 = st.d
  pinch.yCenter = st.yCenter
}

function onTouchEnd(): void {
  pinch = null
}

function scrollToAnchor(anchorY: number, pct = 0.2): void {
  setScroll(anchorY - viewH.value * pct)
}

/** 打开抽屉后：锚定在"现在"（今天），否则今天第一个安排或今天 09:00 */
function scrollToNow(): void {
  if (allDates.value.includes(today)) {
    scrollToAnchor(nowTop.value)
    return
  }
  const first = scheduled.value.find((t) => t.date === props.date)
  const ay = first ? yOf(first.date!, first.startMin!) : yOf(props.date, 9 * 60)
  scrollToAnchor(ay)
}

function goNow(): void {
  scrollToNow()
}

defineExpose({ scrollToNow })

/* ---------- 生命周期 ---------- */

let ro: ResizeObserver | null = null

onMounted(() => {
  const el = scroller()
  if (!el) return
  el.addEventListener('scroll', onScroll)
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measure())
    ro.observe(el)
  } else {
    window.addEventListener('resize', measure)
  }
  measure()
  // 折叠态：固定锚定今天；展开态：打开后定位到"现在"附近
  scrollToNow()
  /* 这里**刻意不再**给 .content 补一条 translateY(-scrollTop)：
     上一版这么写，是想在首帧免掉一次位置跳变，但折叠态的宿主 .vt 本身就是
     overflow: hidden 的滚动盒（见 scroller() 的注释），setScroll 里那句
     el.scrollTop 已经把内容滚到位了 —— 再叠一条 transform 等于**位移两次**，
     内容被推到可视窗口外，整张日程卡在桌面（和任何视口）上是一片空白
     （实测锚点 2368 时首个子元素落在 -1429px，卡片里什么都没有）。
     折叠态的锚定只该有一处实现，就是 el.scrollTop。 */
})

onBeforeUnmount(() => {
  const el = scroller()
  el?.removeEventListener('scroll', onScroll)
  ro?.disconnect()
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <component
    :is="isPreview ? 'button' : 'div'"
    ref="host"
    class="vt"
    :type="isPreview ? 'button' : undefined"
    :class="{ preview: isPreview, full: !isPreview }"
    :style="isPreview ? { height: `${PREVIEW_H}px` } : undefined"
    :aria-label="isPreview ? '查看完整时间线' : undefined"
    @click="isPreview && emit('open')"
    @wheel="onWheel"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchEnd"
  >
    <!-- 顶部时间条：视口中心对应的时刻（仅展开态）。
         零高 sticky 钉在滚动视口顶，不挤占内容布局；必须放在 .content 之前，
         放后面自然位置会落到整条时间轴末尾，永远吸不上来。 -->
    <div v-if="!isPreview" class="gauge-pin" aria-hidden="true">
      <div class="gauge">
        <span class="row center">
          <b v-if="gauge.isNow" class="now-tag">现在</b>
          <span>{{ fmtDateCn(gauge.date) }} · {{ minToHHmm(gauge.min) }}</span>
        </span>
      </div>
    </div>

    <div class="content" :style="{ height: `${totalPx}px` }">
      <!-- 日期分隔头 -->
      <span v-for="dh in dayHeads" :key="dh.d" class="dayhead" :class="{ today: dh.d === date }" :style="{ top: `${dh.y}px` }">
        <i class="now-dot" v-if="dh.d === date" />
        <b>{{ dh.d === date || dh.d === today ? '今天' : fmtDateCn(dh.d) }}</b>
      </span>

      <!-- 小时刻度 / 网格线 -->
      <template v-for="t in ticks" :key="t.y">
        <span class="hour num" :style="{ top: `${t.y}px` }">{{ t.label }}</span>
        <i class="gridline" :style="{ top: `${t.y}px` }" />
      </template>

      <!-- 当前时刻线 -->
      <div v-if="showNow" class="nowline" :style="{ top: `${nowTop}px` }">
        <i class="dot" />
      </div>

      <!-- 待办块（预览态为 div 整卡点击弹抽屉；展开态为 button 点按勾选） -->
      <component
        :is="isPreview ? 'div' : 'button'"
        v-for="b in blocks"
        :key="b.t.id"
        class="block"
        :class="{ done: b.t.status === 'done' }"
        :style="{ top: `${b.top}px`, height: `${b.h}px`, borderLeftColor: `var(${CATEGORY_META[b.t.category].colorVar})` }"
        @click="!isPreview && store.toggle(b.t)"
      >
        <b class="num">{{ minToHHmm(b.t.startMin!) }}</b>
        <span>{{ b.t.title }}</span>
      </component>
    </div>

    <!-- 回到现在 -->
    <button v-if="!isPreview" class="now-btn" aria-label="回到现在" @click="goNow">
      <LocateFixed :size="16" />
    </button>

    <!-- 折叠态：底部渐隐提示 -->
    <div v-if="isPreview" class="peek">
      <span class="pill">查看完整时间线<ChevronDown :size="13" :stroke-width="2.5" /></span>
    </div>
  </component>
</template>

<style scoped>
.vt {
  position: relative;
  /* 与上面 .vt.preview 那条 14px 的上缘渐隐同源：间距小于渐隐高度时
     首行会落在「还没化开」的那一段里 */
  margin-top: var(--sp-14);
  touch-action: pan-y;
  /* 预览态宿主是 <button>：还原浏览器默认样式 */
  display: block;
  width: 100%;
  padding: 0;
  background: transparent;
  border: 0;
  font: inherit;
  color: inherit;
  text-align: left;
}

.vt.full {
  margin-top: 0;
}

.vt.preview {
  overflow: hidden;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  /* 顶缘渐隐：锚定「今天」后首行正好压在刻度上，不渐隐就是一行半截字
     悬在标题下方（底缘已有 .peek 渐隐垫，这里只补上缘）。 */
  mask-image: linear-gradient(to bottom, transparent 0, #000 14px);
}

/* 折叠态纯展示：内容不参与命中，整卡点击统一弹抽屉 */
.vt.preview .content {
  pointer-events: none;
}

.vt.preview:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.content {
  position: relative;
  border-top: 0.5px solid var(--line);
}

/* 日期头 */
.dayhead {
  position: absolute;
  left: 0;
  top: 0;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 日期头钉在轴线上，高度收在 24（--chip-h）以内，不压住相邻刻度 */
  min-height: var(--chip-h);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  z-index: 2;
}

.dayhead b {
  font-weight: var(--fw-semibold);
}

.dayhead.today {
  background: var(--accent-soft);
  color: var(--accent);
}

.now-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
}

.hour {
  position: absolute;
  left: 0;
  transform: translateY(-6px);
  /* 整点刻度是「这一格是几点」的定位信息，不吃 11px */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.gridline {
  position: absolute;
  left: 44px;
  right: 0;
  height: 0.5px;
  background: var(--line);
}

.nowline {
  position: absolute;
  left: 40px;
  right: 0;
  height: 0;
  border-top: 1.5px solid var(--danger);
  z-index: 1;
}

.nowline .dot {
  position: absolute;
  left: -5px;
  top: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}

.block {
  position: absolute;
  left: 44px;
  right: 0;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  text-align: left;
  /* 纵向外距压到 6：块的高度由时间跨度决定，上下留白多一档就会把短块的字挤出去 */
  padding: var(--sp-6) var(--sp-12);
  background: var(--surface-2);
  border-left: 3px solid transparent;
  border-radius: var(--radius-s);
  overflow: hidden;
  transition: transform var(--dur-fast) var(--ease-standard), opacity var(--dur-fast);
}

.block:active {
  transform: scale(0.98);
}

.block[role='button'],
button.block {
  -webkit-tap-highlight-color: transparent;
}

.block b {
  /* 块上的开始时刻是日程的定位信息，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  flex: none;
}

.block span {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 完成态压暗走禁用档令牌（tokens.css:37-40），禁用浓度全库只有一份 */
.block.done {
  opacity: var(--disabled-opacity);
}

.block.done span {
  text-decoration: line-through;
}

/* 顶部时间条（仅展开态，零高钉子吸附于滚动视口顶） */
.gauge-pin {
  position: sticky;
  top: 0;
  z-index: 3;
  height: 0;
}

.gauge {
  display: flex;
  justify-content: center;
  height: 30px;
  /* 出血量与抽屉内容区的左右内距同源（--pad-sheet）：两处不同步就会露出一条缝 */
  margin: 0 calc(-1 * var(--pad-sheet));
  padding: var(--sp-4) var(--pad-sheet) var(--sp-6);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 94%, transparent), transparent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  pointer-events: none;
}

.now-tag {
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  /* 「现在」是定位词：白字压 --danger 实测只有 3.55:1，够不着小字 4.5:1 的 AA 门槛；
     换成 soft 底 + strong 字这一对（约 5.0:1），与 tokens.css:163-168 的规定一致 */
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
}

.now-btn {
  position: absolute;
  right: 2px;
  bottom: 10px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-2);
}

/* 折叠态底部渐隐 + 提示胶囊 */
.peek {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  padding: var(--sp-32) 0 var(--sp-12);
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--surface) 82%, transparent));
  pointer-events: none;
}

.pill {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: var(--sp-4) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}
</style>
