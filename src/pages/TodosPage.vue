<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Plus, Sparkles } from 'lucide-vue-next'

import { useMediaQuery } from '@/composables/useMediaQuery'
import { useToast } from '@/composables/useToast'
import { useScheduleUndo } from '@/composables/useScheduleUndo'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { DESKTOP_MIN } from '@/config/domain'
import { autoSchedule, type Placement } from '@/ai/autoSchedule'
import { recordCardOutcome } from '@/ai/cardOutcomes'
import { useModelsStore } from '@/stores/models'
import { useTodoStore } from '@/stores/todo'
import CanvasTimeline from '@/components/todo/CanvasTimeline.vue'
import DailyRitual from '@/components/todo/DailyRitual.vue'
import DayDetailPanel from '@/components/todo/DayDetailPanel.vue'
import AllTodoList from '@/components/todo/AllTodoList.vue'
import WeekSummary from '@/components/todo/WeekSummary.vue'
import WeekTimeline from '@/components/todo/WeekTimeline.vue'
import { addDays, fmtDateCn, minToHHmm, nowMin, todayStr, weekDates } from '@/utils/date'
import { busyIntervals, freeGaps } from '@/utils/schedule'
import type { Todo, TodoDraft, TodoInput, TodoSubtask } from '@/types'
import QuickAddBar from '@/components/todo/QuickAddBar.vue'
import TodoEditorSheet from '@/components/todo/TodoEditorSheet.vue'
import CourseDetailSheet from '@/components/campus/CourseDetailSheet.vue'

/**
 * 今日画布：待办与日程熔成一条时间轴。
 * - 画布 = 未安排池 + 单日时间轴 + 详情联动（桌面右栏 / 移动端直接进编辑抽屉）；
 * - 智能排程 = AI 建议 → 幽灵块预览 → 用户确认落库（L2 契约），无模型走启发式；
 * - 周 = 周选择 + 周回顾；清单 = 全部待办分组列表。
 */
const store = useTodoStore()
const models = useModelsStore()
const { toast } = useToast()
const { applyMove, applyMoves } = useScheduleUndo()
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

type Segment = 'canvas' | 'week' | 'list'
const segment = ref<Segment>('canvas')
/**
 * 视图分段：画布 / 周 / 清单。
 * 换用共享 SegmentedControl —— 它带 roving tabindex、左右方向键与 radiogroup 语义；
 * 原先手搓的 role=tablist 给读屏的心智模型是错的（读屏会以为下面有一块跟着换的
 * 页签内容），而且没有方向键支持。
 */
const VIEW_OPTIONS: { value: Segment; label: string }[] = [
  { value: 'canvas', label: '画布' },
  { value: 'week', label: '周' },
  { value: 'list', label: '清单' },
]
const canvasDate = ref(todayStr())
const today = todayStr()

/* ---------- 数据 ---------- */

onMounted(async () => {
  await store.loadAll()
  maybeOpenRitual()
})

const dayTodos = computed(() => store.allTodos.filter((t) => t.date === canvasDate.value))
const scheduled = computed(() => dayTodos.value.filter((t) => t.startMin != null))
const pool = computed(() => dayTodos.value.filter((t) => t.startMin == null && t.status !== 'done'))
const doneCount = computed(() => dayTodos.value.filter((t) => t.status === 'done').length)

/* ---------- 周时间线数据 ---------- */

const weekSet = new Set(weekDates(today))
const weekScheduled = computed(() =>
  store.allTodos.filter((t) => t.date != null && weekSet.has(t.date) && t.startMin != null),
)
const weekUnscheduled = computed(() =>
  store.allTodos.filter((t) => t.date != null && weekSet.has(t.date) && t.startMin == null && t.status !== 'done'),
)

const headTitle = computed(() =>
  segment.value === 'canvas' ? fmtDateCn(canvasDate.value) : segment.value === 'week' ? '本周' : '全部待办',
)
const headSub = computed(() => {
  if (segment.value === 'list') return '按日期分组'
  if (segment.value === 'week') return '本周时间线 · 长按块可跨天改时'
  return `${doneCount.value}/${dayTodos.value.length} 已完成`
})

function shiftDay(n: number): void {
  canvasDate.value = addDays(canvasDate.value, n)
}

/* ---------- 选中与编辑 ---------- */

const selectedId = ref<number | null>(null)
const selectedTodo = computed<Todo | null>(
  () => store.allTodos.find((t) => t.id === selectedId.value) ?? null,
)
const editorOpen = ref(false)
const editorTarget = computed<Todo | null>(
  () => store.allTodos.find((t) => t.id === (editorId.value ?? -1)) ?? null,
)
const editorId = ref<number | null>(null)
const addOpen = ref(false)

/* ---------- 一句话记待办 → 编辑器 ---------- */

/** 输入条解析出的草稿填进编辑器时，走**独立的抽屉实例**：
 *  editorId/editorTarget 是「编辑既有待办」的通道，共用会把正在编辑的那条覆盖掉。 */
const draftOpen = ref(false)
const draftInitial = ref<Partial<TodoInput> | null>(null)
const quickBar = ref<InstanceType<typeof QuickAddBar> | null>(null)

/** 点输入条箭头：把草稿铺成 TodoInput 预填，打开新的待办编辑器等用户确认 */
function onQuickFill(draft: TodoDraft): void {
  draftInitial.value = {
    title: draft.title,
    date: draft.date,
    startMin: draft.startMin,
    durationMin: draft.durationMin,
    category: draft.category,
    priority: draft.priority,
    notes: draft.notes,
  }
  draftOpen.value = true
}

/** 保存后清空输入条；取消（未保存）则保留预览，用户可接着改那句话 */
function onQuickSaved(): void {
  quickBar.value?.clear()
}

/** 课表派生行是只读投影：点开的是课程详情，不是待办编辑器（见 CourseDetailSheet）。
 *  与 editorTarget 同理按 id 派生 —— 存对象快照的话，打卡后面板读到的还是旧对象。 */
const courseId = ref<number | null>(null)
const course = computed<Todo | null>(
  () => store.allTodos.find((t) => t.id === (courseId.value ?? -1)) ?? null,
)
const courseOpen = ref(false)

function openCourse(t: Todo): void {
  selectedId.value = t.id
  courseId.value = t.id
  courseOpen.value = true
}

function onSelect(t: Todo): void {
  if (t.courseSessionId != null) {
    openCourse(t)
    return
  }
  selectedId.value = t.id
  if (!isDesktop.value) {
    editorId.value = t.id
    editorOpen.value = true
  }
}

function onToggle(t: Todo): void {
  clearGhosts()
  void store.toggle(t)
}

function onMove(t: Todo, startMin: number): void {
  clearGhosts()
  void applyMove(t, { date: canvasDate.value, startMin })
}

/** 直开编辑抽屉（周段无详情右栏；画布卡片右下角编辑钮同入口）：课程派生行转只读详情 */
function openEditor(t: Todo): void {
  if (t.courseSessionId != null) {
    openCourse(t)
    return
  }
  selectedId.value = t.id
  editorId.value = t.id
  editorOpen.value = true
}

function onWeekMove(t: Todo, date: string, startMin: number): void {
  clearGhosts()
  void applyMove(t, { date, startMin })
}

function onWeekDaySelect(d: string): void {
  canvasDate.value = d
  segment.value = 'canvas'
}

function onWeekAdd(d: string): void {
  canvasDate.value = d
  addOpen.value = true
}

async function onSubtasks(next: TodoSubtask[]): Promise<void> {
  const t = selectedTodo.value
  if (!t) return
  await store.update({ ...t, subtasks: next.length ? next : null })
}

function editSelected(): void {
  editorId.value = selectedId.value
  editorOpen.value = true
}

async function removeSelected(): Promise<void> {
  const t = selectedTodo.value
  if (!t) return
  await store.remove(t)
  selectedId.value = null
}

/* ---------- 未安排池：点击快排 + 拖入时间轴 ---------- */

const tlWrap = ref<HTMLElement | null>(null)
const tlComp = ref<InstanceType<typeof CanvasTimeline> | null>(null)
const dropMin = ref<number | null>(null)
const chipDrag = ref<Todo | null>(null)

/** 把未安排事项放进"现在之后"的第一个装得下的空档 */
async function placeInNextGap(t: Todo): Promise<void> {
  const busy = busyIntervals(scheduled.value, canvasDate.value)
  const from = canvasDate.value === today ? Math.max(nowMin(), 6 * 60) : 6 * 60
  const gaps = freeGaps(busy, from, 22 * 60)
  const dur = t.durationMin ?? 30
  const gap = gaps.find((g) => g.end - g.start >= dur)
  if (!gap) {
    toast('今天 22 点前没有装得下的空档了')
    return
  }
  const at = `${String(Math.floor(gap.start / 60)).padStart(2, '0')}:${String(gap.start % 60).padStart(2, '0')}`
  await applyMove(t, { date: canvasDate.value, startMin: gap.start }, `已排到 ${at}`)
}

function onChipDown(e: PointerEvent, t: Todo): void {
  if (e.button !== 0) return
  const el = e.currentTarget as HTMLElement
  // **捕获失败不能带走整个拖拽**：合成指针、指针已失效等边缘会抛 NotFoundError，
  // 而这里没有捕获也能靠元素自身的 pointermove 继续（画布那边就是这么办的）。
  // 曾经这里少了个 try，于是「捕获一失败，池卡片就完全拖不动」。
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    /* 无有效指针：拖拽沿元素事件继续 */
  }
  chipDrag.value = t
  chipStart = { x: e.clientX, y: e.clientY }
  chipMoved = false
}

let chipStart = { x: 0, y: 0 }
let chipMoved = false

function onChipMove(e: PointerEvent): void {
  const t = chipDrag.value
  if (!t) return
  if (!chipMoved && Math.hypot(e.clientX - chipStart.x, e.clientY - chipStart.y) < 6) return
  chipMoved = true
  const sc = tlWrap.value?.querySelector('.scroll') as HTMLElement | null
  const wrap = tlWrap.value?.getBoundingClientRect()
  const ppm = tlComp.value?.getPxPerMin() ?? 0.5
  if (!sc || !wrap) return
  if (e.clientX < wrap.left || e.clientX > wrap.right || e.clientY < wrap.top || e.clientY > wrap.bottom) {
    dropMin.value = null
    return
  }
  const min = (e.clientY - wrap.top + sc.scrollTop) / ppm
  dropMin.value = Math.max(0, Math.min(1435, Math.round(min / 5) * 5))
}

async function onChipUp(): Promise<void> {
  const t = chipDrag.value
  const min = dropMin.value
  chipDrag.value = null
  dropMin.value = null
  if (t && chipMoved && min != null) {
    await applyMove(t, { date: canvasDate.value, startMin: min })
  }
}

/* ---------- 智能排程（AI 建议 → 确认 → 落库） ---------- */

const aiRunning = ref(false)
/** AI 排程流式进度（已安排 N/M 项），运行中显示在排程按钮上 */
const aiProgress = ref('')
const ghosts = ref<{ todo: Todo; startMin: number }[]>([])
const aiReason = ref('')
const aiSource = ref<'ai' | 'heuristic'>('heuristic')

function clearGhosts(): void {
  if (ghosts.value.length) ghosts.value = []
}

async function runSchedule(): Promise<void> {
  if (aiRunning.value || !pool.value.length) return
  clearGhosts()
  aiRunning.value = true
  aiProgress.value = ''
  try {
    if (!models.loaded) await models.load()
    const from = canvasDate.value === today ? Math.max(nowMin(), 6 * 60) : 6 * 60
    const res = await autoSchedule(
      pool.value,
      scheduled.value,
      canvasDate.value,
      from,
      models.defaultModel(),
      (n, total) => (aiProgress.value = `已排 ${n}/${total} 项`),
    )
    const byId = new Map(pool.value.map((t) => [t.id, t]))
    ghosts.value = res.placements
      .filter((p: Placement) => byId.has(p.id))
      .map((p) => ({ todo: byId.get(p.id)!, startMin: p.startMin }))
    aiReason.value = res.reason
    aiSource.value = res.source
    if (!ghosts.value.length) toast('今天装不下更多安排了，试试改天或减时长')
  } finally {
    aiRunning.value = false
  }
}

async function applyGhosts(): Promise<void> {
  const list = ghosts.value
  ghosts.value = []
  const items: { todo: Todo; date: string | null; startMin: number | null }[] = []
  for (const g of list) {
    const cur = store.allTodos.find((t) => t.id === g.todo.id)
    if (cur) items.push({ todo: cur, date: canvasDate.value, startMin: g.startMin })
  }
  await applyMoves(items, `已排入 ${items.length} 项，可拖动微调`)
  // 智能排程是「AI 提议 → 幽灵块预览 → 用户确认」，确认这一步只有界面知道：
  // 记一条给聊天模型（@/ai/cardOutcomes），省得它回过头又问「要不要我帮你排一下」
  if (items.length > 0) {
    recordCardOutcome(
      'schedule',
      `智能排程采纳 ${items.length} 项安排（${items
        .slice(0, 3)
        .map((i) => `${i.startMin != null ? minToHHmm(i.startMin) : ''} ${i.todo.title}`.trim())
        .join('、')}${items.length > 3 ? ' 等' : ''}）`,
    )
  }
}

/* ---------- 每日规划仪式 ---------- */

const ritualOpen = ref(false)

const ritualCandidates = computed(() => {
  const inbox = store.allTodos.filter((t) => t.date === null && t.status !== 'done')
  const overdue = store.allTodos.filter(
    (t) => t.date !== null && t.date < today && t.status !== 'done',
  )
  return [...inbox, ...overdue, ...pool.value]
})

function maybeOpenRitual(): void {
  const key = `rein.ritual.${today}`
  if (localStorage.getItem(key)) return
  if (!ritualCandidates.value.length) return
  ritualOpen.value = true
}

function closeRitual(): void {
  localStorage.setItem(`rein.ritual.${today}`, '1')
  ritualOpen.value = false
}

async function onRitualConfirm(ids: number[], mode: 'ai' | 'manual'): Promise<void> {
  closeRitual()
  for (const id of ids) {
    const t = store.allTodos.find((x) => x.id === id)
    if (!t) continue
    const next: Todo = { ...t, date: t.date === null || t.date < today ? today : t.date }
    if (next.date === today && next.startMin != null && t.date === null) next.startMin = null
    if (t.date !== today) await store.update(next)
  }
  if (mode === 'ai') await runSchedule()
  else toast('已加入今天，拖进时间轴安排时间')
}
</script>

<template>
  <div class="page">
    <PageHeader :title="headTitle" :subtitle="headSub" back>
      <template #action>
        <button class="hdr-btn" aria-label="添加待办" @click="addOpen = true">
          <Plus :size="20" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- AI 一句话记待办：输入一句自然语言 → 预览 chip → 点箭头填入编辑器 -->
    <QuickAddBar ref="quickBar" :date="today" @fill="onQuickFill" />

    <!-- 视图切换 + 智能排程 -->
    <div class="toolbar row">
      <SegmentedControl v-model="segment" :options="VIEW_OPTIONS" class="viewseg" aria-label="视图" />
      <button
        v-if="segment === 'canvas'"
        class="ai-btn"
        :disabled="aiRunning || !pool.length"
        data-testid="ai-schedule"
        @click="runSchedule"
      >
        <Sparkles :size="14" /> {{ aiRunning ? aiProgress || '排程中…' : '智能排程' }}
      </button>
    </div>

    <!-- ═══ 画布 ═══ -->
    <template v-if="segment === 'canvas'">
      <div class="dateline row between">
        <button class="daynav" aria-label="前一天" @click="shiftDay(-1)">‹</button>
        <!-- 日期已由页头大标题承担，这里降为「正在看哪天」的次要说明，不与标题同款 -->
        <span class="dlabel num">正在看 {{ canvasDate === today ? '今天' : fmtDateCn(canvasDate) }}</span>
        <button class="daynav" aria-label="后一天" @click="shiftDay(1)">›</button>
      </div>

      <!-- 未安排池 -->
      <section class="pool" data-testid="pool">
        <header class="row between poolh">
          <b>未安排 <span class="num">{{ pool.length }}</span></b>
          <span class="hint">拖进时间轴，或点卡片快排</span>
        </header>
        <div class="chips">
          <button
            v-for="t in pool"
            :key="t.id"
            class="pchip"
            :class="{ sel: selectedId === t.id, drag: chipDrag?.id === t.id }"
            :data-title="t.title"
            @pointerdown="onChipDown($event, t)"
            @pointermove="onChipMove"
            @pointerup="onChipUp"
            @pointercancel="onChipUp"
            @click="!chipMoved && onSelect(t)"
          >
            <i class="pdot" />{{ t.title }}
            <em v-if="t.durationMin" class="num">{{ t.durationMin }} 分钟</em>
          </button>
          <p v-if="!pool.length" class="pool-empty">池子空了 — 该安排的都安排上了。</p>
        </div>
      </section>

      <!-- 智能排程确认条 -->
      <section v-if="ghosts.length" class="confirm" data-testid="ai-confirm">
        <p class="cr">
          <b>{{ aiSource === 'ai' ? 'AI 建议' : '规则排程' }}</b>
          {{ aiReason }}
        </p>
        <div class="row gap">
          <button class="cbtn ghost" @click="clearGhosts">取消</button>
          <button class="cbtn primary" data-testid="ai-apply" @click="applyGhosts">应用（{{ ghosts.length }}）</button>
        </div>
      </section>

      <!-- 时间轴 + 详情（桌面右栏，移动端点击块进编辑抽屉） -->
      <div class="cgrid" :class="{ wide: isDesktop && selectedTodo }">
        <div ref="tlWrap" class="tlwrap">
          <CanvasTimeline
            ref="tlComp"
            :date="canvasDate"
            :todos="scheduled"
            :ghosts="ghosts"
            :drop-min="dropMin"
            :selected-id="selectedId"
            :compact="!isDesktop"
            data-testid="canvas-timeline"
            @select="onSelect"
            @edit="openEditor"
            @toggle="onToggle"
            @move="onMove"
          />
        </div>
        <DayDetailPanel
          v-if="isDesktop"
          :todo="selectedTodo"
          @toggle="selectedTodo && onToggle(selectedTodo)"
          @edit="editSelected"
          @remove="removeSelected"
          @place="selectedTodo && placeInNextGap(selectedTodo)"
          @subtasks="onSubtasks"
        />
      </div>
    </template>

    <!-- ═══ 周 ═══ -->
    <template v-else-if="segment === 'week'">
      <section class="card">
        <WeekTimeline
          :todos="weekScheduled"
          :unscheduled="weekUnscheduled"
          :selected-id="selectedId"
          @select="openEditor"
          @toggle="onToggle"
          @move="onWeekMove"
          @day-select="onWeekDaySelect"
          @add="onWeekAdd"
        />
      </section>
      <WeekSummary />
    </template>

    <!-- ═══ 清单 ═══ -->
    <template v-else>
      <AllTodoList />
    </template>

    <DailyRitual :open="ritualOpen" :candidates="ritualCandidates" @close="closeRitual" @confirm="onRitualConfirm" />
    <TodoEditorSheet :open="editorOpen" :todo="editorTarget" :date="canvasDate" @close="editorOpen = false" />
    <!-- 一句话记待办走独立实例（todo=null 恒为新建），不与上面的「编辑既有待办」互相覆盖 -->
    <TodoEditorSheet
      :open="draftOpen"
      :todo="null"
      :initial="draftInitial"
      :date="canvasDate"
      @close="draftOpen = false"
      @saved="onQuickSaved"
    />
    <CourseDetailSheet
      :open="courseOpen"
      :todo="course"
      @close="courseOpen = false"
      @toggle="onToggle"
    />
    <SmartAddSheet :open="addOpen" :date="canvasDate" @close="addOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶距走 --page-pad-top（手机 12 / 桌面 40）：页面四边留白只有这一处来源，
     各页不再各自加一档 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.toolbar {
  justify-content: space-between;
  /* 分段控件与右侧主操作是两块各有边界的控件，取卡片间的 12 档 */
  gap: var(--gap-md);
  margin-bottom: var(--gap-md);
}

/* 视图分段：共享 SegmentedControl（radiogroup + roving tabindex + 方向键）。
   它自带 --surface-2 轨道，选中段的滑块阴影走 var(--shadow-thumb) 令牌 ——
   原先手搓轨道上那条 0 1px 3px 魔法阴影随规则一起退场，由共享组件接管。
   这里只管布局：定宽让三段均分（与课表页同规格），且不拉伸，
   把剩余空间留给右边的「智能排程」按钮。 */
.viewseg {
  flex: none;
  width: 132px;
}

.ai-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 图标与文字之间按「主次文本左右 8」；横向 16 与页面卡片内距同档 */
  gap: var(--gap-text-inline);
  /* 常规按钮高 40（HarmonyOS 控件规范）：原先 8+8 内距 + 12 字（行高 1.5）= 34，
     在日期行与分段控件旁边明显矮一档 */
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-16);
  /* 与 .cbtn / 各页 .cta 统一成胶囊：同一类主操作全库一个形状，
     不再出现「页内按钮 16 圆角、空态按钮 full」的两种同级写法 */
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  box-shadow: var(--shadow-float);
}

.ai-btn:disabled {
  opacity: var(--disabled-opacity);
  box-shadow: none;
}

/* 视觉 40 的常规钮命中区补到 44（上下各 2）：主操作不该比触控下限还窄 */
.ai-btn::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--gap-text)) 0;
  border-radius: inherit;
}

.dateline {
  margin: 0 0 var(--gap-sm);
}

/* 日期翻页：视觉 34（--control-icon），热区撑到 44。
   它停在屏幕两缘，是这一页每天都会点的两颗钮，30px 的视觉对拇指偏小。 */
.daynav {
  position: relative;
  width: var(--control-icon);
  height: var(--control-icon);
  border-radius: 50%;
  background: var(--surface);
  border: 0.5px solid var(--line);
  color: var(--text-2);
  font-size: var(--fs-headline);
  line-height: 1;
}

.daynav::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

/* 日期行：页头大标题已是这一天（fmtDateCn），这里只是「正在看哪天」的次要说明 */
.dlabel {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.pool {
  background: var(--surface);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-m);
  /* 卡片内距统一 16：原先 10/14/12 三边各不相同，读起来像「凑出来的」边距；
     四边拉平成规范值后标题与胶囊组在卡内的落点才稳 */
  padding: var(--pad-card);
  margin-bottom: var(--gap-md);
}

.poolh b {
  font-size: var(--fs-footnote);
}

.poolh .hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
  min-height: 20px;
}

.pchip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 药丸统一 24 高（--chip-h）：原先 6px 上下内距把这一档撑到 30，
     比规范高一档，和页内其它胶囊不在一条水平线上 */
  min-height: var(--chip-h);
  padding: var(--sp-4) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  border: 0.5px solid var(--line);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  touch-action: none;
  cursor: grab;
}

.pchip:active {
  cursor: grabbing;
}

.pchip.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.pchip.drag {
  opacity: 0.55;
  transform: scale(1.03);
}

.pdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.pchip em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.pool-empty {
  font-size: var(--fs-footnote);
  color: var(--text-3);
  padding: var(--sp-4) 0;
}

.confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  background: var(--accent-soft);
  border-radius: var(--radius-m);
  /* 确认条是紧凑条，纵 12 / 横 16：横向与卡片内距对齐，纵向留出按钮自身的呼吸 */
  padding: var(--sp-12) var(--pad-card);
  margin-bottom: var(--gap-md);
}

.confirm .cr {
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-1);
}

.confirm b {
  color: var(--accent);
  margin-right: var(--gap-text-inline);
}

.gap {
  gap: var(--gap-sm);
}

.cbtn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 与 .ai-btn 同档：确认条里的取消 / 应用也是常规按钮，视觉高度取 40 */
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
}

/* 40 → 44 的命中区：两颗并排，横向各撑自身，之间仍留 8 的槽位 */
.cbtn::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--gap-text)) 0;
  border-radius: inherit;
}

.cbtn.ghost {
  color: var(--text-2);
}

.cbtn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.cgrid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--gap-md);
}

.cgrid.wide {
  grid-template-columns: 1fr 292px;
}

.tlwrap {
  min-width: 0;
}

/* 画布时间轴默认高度（.scroll 撑起） */
.tlwrap :deep(.ctl .scroll) {
  height: min(62vh, 620px);
}

/* 手机档（< DESKTOP_MIN，见 :38 的 isDesktop）：底部 Dock 与悬浮条占掉一截，
   画布比桌面矮一档（62vh → 56vh）。断点必须跟着 DESKTOP_MIN 走 ——
   900–1099 现在是桌面壳，不该再吃手机那档高度。 */
@media (max-width: 899px) {
  .tlwrap :deep(.ctl .scroll) {
    height: 56vh;
  }
}
</style>
