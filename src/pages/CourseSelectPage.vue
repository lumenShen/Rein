<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock,
  ExternalLink,
  Hourglass,
  Info,
  ListChecks,
  RefreshCw,
  Search,
  Settings2,
  Zap,
} from 'lucide-vue-next'

import GrabPanel from '@/components/campus/GrabPanel.vue'
import GrabPlan from '@/components/campus/GrabPlan.vue'
import GrabSettingsSheet from '@/components/campus/GrabSettingsSheet.vue'
import GrabSheet from '@/components/campus/GrabSheet.vue'
import OpenCourseQuery from '@/components/campus/OpenCourseQuery.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import { grabStatusMeta, idOf, teacherText, useCourseSelectStore } from '@/stores/courseSelect'
import type { CourseSelectLesson } from '@/types'

/**
 * 选课（API 直接抢课）。
 *
 * 与课表页的关键区别：课表读的是本地快照，**选课打的是教务的实时接口**，
 * 所以这里的每个动作都是网络请求，且令牌可能过期（过期后会自动去门户重换一张）。
 *
 * 大一新生的选课窗口由教务处统一开放，在那之前批次列表是空的 ——
 * 页面必须把「还没有窗口」讲清楚，而不是显示成故障。
 *
 * **抢课不靠这个页面**：任务单交给 Rust 后台引擎（见 `modules/campus/grab.rs`），
 * 页面只负责「下单」和「看进度」。所以这里既能一键把课排进任务单，
 * 也能整页关掉 —— 引擎照跑。
 */
const store = useCourseSelectStore()
const campus = useCampusStore()
const toast = useToast()

const refresh = ref(false)
const settingsOpen = ref(false)
/**
 * 抽屉里正在配置的教学班 **id**。
 *
 * 存 id 不存对象：自动刷新会整表替换 `store.lessons`，存下来的那个对象会变成一份
 * 没人再更新的孤儿数据 —— 抽屉里的「已选 12 / 30」会停在打开那一刻的旧数字，
 * 而页面上其它地方都是新的。存 id 每次从 store 取，两边永远同源。
 */
const sheetLessonId = ref<string | null>(null)
const sheetLesson = computed<CourseSelectLesson | null>(() => {
  const id = sheetLessonId.value
  if (id == null) return null
  return store.lessons.find((l) => idOf(l.id) === id) ?? null
})

const status = computed(() => store.status)
const skew = computed(() => store.clockSkewSec)

/**
 * 页头那个入口上的角标：**没抢到的条数**。
 *
 * 它回答的是「有没有事等着我处理」—— 抢到了不必催（课已经是你的了），
 * 没抢到才需要决定「重排还是放弃」。
 */
const failedCount = computed(
  () =>
    store.grabTasks.filter(
      (t) =>
        t.status === 'failed' ||
        t.status === 'conflict' ||
        t.status === 'needs_ai' ||
        t.status === 'cancelled',
    ).length,
)

/** 偏差超过 30 秒才提示：小偏差是网络往返造成的，不必惊动用户 */
const skewWarning = computed(() => {
  const s = skew.value
  if (s == null || Math.abs(s) < 30) return ''
  return s > 0
    ? `教务服务器比你本机快 ${s} 秒，抢课时以服务器时间为准`
    : `教务服务器比你本机慢 ${-s} 秒，抢课时以服务器时间为准`
})

/* ---------------- 教务服务器时间 ----------------
 * 它**必须每秒走**。之前这里显示的是最近一次采样的字符串（几十秒才更新一次），
 * 而学生会在 09:59:40 拿它对表 —— 一个不走的钟比没有钟更糟：它看着像准的。
 * 偏差是缓变量，采到一次就能推到当下，所以这里只在采样时刻上做线性推进。
 */
const serverClock = ref('')
let clockAt = 0
let clockText = ''

watch(
  () => store.serverTime,
  (t) => {
    if (!t) return
    clockText = t
    clockAt = Date.now()
    serverClock.value = t
  },
  { immediate: true },
)

const pad2 = (n: number) => String(n).padStart(2, '0')

function tickClock(): void {
  if (!clockAt) {
    serverClock.value = clockText || '—'
    return
  }
  const base = new Date(clockText.replace(' ', 'T'))
  if (Number.isNaN(base.getTime())) {
    serverClock.value = clockText
    return
  }
  const wall = new Date(base.getTime() + (Date.now() - clockAt))
  serverClock.value =
    `${wall.getFullYear()}-${pad2(wall.getMonth() + 1)}-${pad2(wall.getDate())} ` +
    `${pad2(wall.getHours())}:${pad2(wall.getMinutes())}:${pad2(wall.getSeconds())}`
}

/** 「张伟 20231001」—— 账号在副信息行里，够用但不再单开一行 */
const accountText = computed(() => {
  const s = status.value
  if (!s?.studentCode) return ''
  return `${s.studentName ?? ''} ${s.studentCode}`.trim()
})

/**
 * 批次的窗口时间。
 *
 * 早先它只在「还没有批次」的空态里出现 —— 一进批次反而查不到自己剩多少时间（rubric #6）。
 * 现在它跟着账号、时钟一起进阶段条的副信息行，进批次之后仍然看得见。
 */
const windowText = computed(() => {
  const t = store.activeTurn
  if (!t) return ''
  const fmt = (raw?: string | null): string => {
    if (!raw) return ''
    const m = raw.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
    return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : raw
  }
  const r = t.selectDateTimeRange
  const a = fmt(r?.startDateTime)
  const b = fmt(r?.endDateTime)
  if (a && b) return `${a} → ${b}`
  // 教务没给区间时退回它自己那句话（原样透传，不改写它的措辞）
  return a || b || t.selectDateTimeText?.trim() || ''
})

function lessonName(l: CourseSelectLesson): string {
  return l.course?.nameZh || l.course?.nameEn || '（教务未给课程名）'
}

/** 项目名（体育课的「羽毛球」）—— 没有就是 null */
function minorOf(l: CourseSelectLesson): string {
  const m = l.minorCourse?.nameZh ?? l.minorCourse?.nameEn
  return m && m.trim() ? m.trim() : ''
}

/**
 * 列表行的标题：**项目名优先**，否则课程名。
 *
 * 体育课 3 个项目的课程名全都叫「大学体育1」——拿课程名当标题，
 * 一列行长得一模一样，用户根本认不出自己点的是羽毛球还是匹克球。
 * 项目名才是他嘴里的那门课（与计划预览的 `matchTitle` 同一条规矩）。
 */
function lessonTitle(l: CourseSelectLesson): string {
  return minorOf(l) || lessonName(l)
}

/** 副信息里把「哪门课 / 哪个班」补全 —— 同门课的几个班才分得开 */
function lessonSubtitle(l: CourseSelectLesson): string {
  const bits: string[] = []
  if (minorOf(l)) bits.push(lessonName(l))
  const section = l.lessonName?.trim()
  if (section && section !== lessonName(l)) bits.push(section)
  return bits.join(' · ')
}

function lessonCode(l: CourseSelectLesson): string {
  return l.course?.code ?? ''
}

/**
 * 上课时间地点。
 *
 * 教务把 `dateTimePlace` 给成什么形状没有保证（字符串 / 数组 / 嵌套对象都见过），
 * 所以按「能认出来就认」处理：把里面所有字符串掏出来拼成一行 —— 与 Rust 匹配器
 * 和 mock 用的是同一套读法。**这一行必须出现在列表上**：一门课挂了 7 个教学班时，
 * 「谁在什么时候上」才是选班的依据，藏在抽屉里等于逼用户逐个点开背下来。
 */
function scheduleTextOf(l: CourseSelectLesson): string {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.trim()) out.push(v.trim())
    } else if (Array.isArray(v)) {
      v.forEach(walk)
    } else if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk)
    }
  }
  ;(l.scheduleGroups ?? []).forEach((g) => walk(g.dateTimePlace))
  // 同一段时间会在多个组里重复出现，去重后再拼
  return [...new Set(out)].join(' ')
}

function picked(l: CourseSelectLesson): boolean {
  return l.selectedLesson != null
}

/** 这门课在多选里的志愿序（1 起；没选中是 0） */
function ordOf(l: CourseSelectLesson): number {
  return store.selectedIds.indexOf(idOf(l.id)) + 1
}

function isSelected(l: CourseSelectLesson): boolean {
  return store.selectedIds.includes(idOf(l.id))
}

function seatText(l: CourseSelectLesson): string {
  const a = l.stdCount
  const b = l.limitCount
  if (a == null && b == null) return ''
  return `${a ?? '?'} / ${b ?? '?'}`
}

/** 已满：有上限且已选人数达到上限 */
function full(l: CourseSelectLesson): boolean {
  return l.limitCount != null && l.stdCount != null && l.stdCount >= l.limitCount
}

/** 这门课在抢课任务单里的状态（没有则 null） */
function grabChip(l: CourseSelectLesson): { label: string; tone: string } | null {
  const t = store.taskFor(l)
  if (!t) return null
  return grabStatusMeta(t)
}

/** 抢课状态折算成 StatusChip 的语义档：store 侧是 run/ok/warn/bad/idle 五态，
 *  run 落 accent（进行中）、idle 落 neutral（已取消/暂停这类无色彩状态） */
function grabTone(tone: string): 'accent' | 'ok' | 'warn' | 'danger' | 'neutral' {
  switch (tone) {
    case 'ok':
      return 'ok'
    case 'warn':
      return 'warn'
    case 'bad':
      return 'danger'
    case 'idle':
      return 'neutral'
    default:
      return 'accent'
  }
}

async function onRefresh(): Promise<void> {
  refresh.value = true
  try {
    await store.loadStatus()
    lastStatusAt = Date.now()
    if (store.activeTurn) {
      await store.loadLessons()
      lastLessonsAt = Date.now()
    }
    autoAt.value = new Date()
  } finally {
    refresh.value = false
  }
  // 任务单是旁路：它自己会被引擎的事件推着更新，**不该拖着刷新按钮一起等** ——
  // 让用户抢课途中按第二下没反应，比少刷新一次任务单糟得多
  void store.refreshGrab()
}

async function onSearch(): Promise<void> {
  try {
    await store.loadLessons()
    lastLessonsAt = Date.now()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '查询教学班失败')
  }
}

async function onEnter(turnId: unknown): Promise<void> {
  const turn = store.turns.find((t) => idOf(t.id) === idOf(turnId))
  if (!turn) return
  store.enterTurn(turn)
  try {
    await store.loadLessons()
    lastLessonsAt = Date.now()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '查询教学班失败')
  }
}

/**
 * 打开抽屉看这门的设置。
 *
 * **已选中的课也要能打开**：那是「我刚才到底怎么排的」的唯一入口 ——
 * 早先这里对已选直接 return，于是抢到手之后这门课在列表上就变成一块点不动的死砖，
 * 想去核对一下「我当时选的是哪个组」，全应用没有任何地方答得上来。
 */
function openSheet(l: CourseSelectLesson): void {
  sheetLessonId.value = idOf(l.id)
}

/* ---------------- 长按直接入队（加速器） ----------------
 * 行上的胶囊打开的是「怎么抢」的设置抽屉，而设置对绝大多数课并不需要改：
 * 默认就是占位优先 + 意愿值 0 + 教务默认组。要抢 5 门课时，那 5 次
 * 「打开抽屉 → 再点一下加入」是纯税 —— 可它又不能省掉，因为抢错组是要付代价的。
 *
 * 所以留一条**加速器**：长按整行 = 按上面那套默认值直接排进任务单。
 * 它刻意不占任何视觉、也不做提示 —— 加速器本来就该对新手隐形（启发式 #7），
 * 而结果由 toast 和行上的状态徽标回执。设置入口仍然在胶囊上，一步就到。
 */
const DEFAULT_GRAB = {
  mode: 'predicate' as const,
  virtualCost: null,
  scheduleGroupId: null,
  groupKey: null,
  groupName: null,
  priority: 0,
}
/** 500ms：短到不觉得在等，长到不会在滚动/误触时被触发 */
const LONG_PRESS_MS = 500

let pressTimer: number | null = null
let longPressed = false

async function quickGrab(l: CourseSelectLesson): Promise<void> {
  try {
    const n = await store.enqueue([l], DEFAULT_GRAB)
    toast.toast(
      n
        ? `已加入（默认设置：占位优先 · 意愿值 0）—— 要改就点行上的「配置抢课」`
        : '没有加入任何课程',
    )
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '加入抢课失败')
  }
}

function onRowDown(l: CourseSelectLesson): void {
  if (store.selectMode || picked(l)) return
  longPressed = false
  pressTimer = window.setTimeout(() => {
    pressTimer = null
    longPressed = true
    void quickGrab(l)
  }, LONG_PRESS_MS)
}

function onRowUp(): void {
  if (pressTimer != null) {
    window.clearTimeout(pressTimer)
    pressTimer = null
  }
}

/** 长按之后浏览器还会补一次 click，那一下不能再当成「打开设置」 */
function onRowClick(l: CourseSelectLesson): void {
  if (longPressed) {
    longPressed = false
    return
  }
  if (store.selectMode) store.toggleSelect(l)
  else openSheet(l)
}

/* ---------------- 名单新鲜度 ----------------
 * 座位数是会变的，而「已选 118 / 120」看起来永远是当下的数字。抢课当天
 * 一份 90 秒前的名单和一份 3 秒前的名单，看到的是同一行字，但前者可能已经没位了。
 * 所以列表必须说得出自己是几秒前拉的 —— 数据本来就在（每次 loadLessons 都会换掉
 * `store.lessons` 这个数组），差的只是把它显示出来。
 */
const lessonsAt = ref(0)
const stampNow = ref(Date.now())
watch(
  () => store.lessons,
  (list) => {
    if (list.length) lessonsAt.value = Date.now()
  },
)
const lessonsAge = computed(() => {
  if (!lessonsAt.value) return ''
  const s = Math.max(0, Math.floor((stampNow.value - lessonsAt.value) / 1000))
  // 不满一分钟一律落到秒：「刚刚」档看不出是 2 秒还是 9 秒，而这句存在的全部理由就是新鲜度
  return s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`
})

/* ---------------- 批量预定 ----------------
 * 「多个抢课任务」在引擎里本来就是一行一条，缺的是**一次把它们排好**的入口：
 * 一门课挂着 5 个教学班时，逐个点开抽屉加 5 遍，还得自己记住谁排第几。
 *
 * 勾选顺序**就是**志愿顺序 —— 所以这里用数组而不是 Set。
 *
 * 状态本身住在 store 里（`selectMode` / `selectedIds`）：这套顺序是页面上唯一
 * 不可恢复的东西，不能跟着页面一起被卸载掉（见 store 里的说明）。
 */
const batchOpen = ref(false)
const batchSquad = ref(false)
const batchPriority = ref(1)

function openBatch(): void {
  if (!store.selectedLessons.length) return
  // 选了两门以上，多半就是「同一门课的备选」或「时间冲突的几门」—— 默认按志愿组排
  batchSquad.value = store.selectedLessons.length > 1
  batchPriority.value = 1
  batchOpen.value = true
}

async function confirmBatch(): Promise<void> {
  const lessons = store.selectedLessons
  if (!lessons.length) return
  const squad = batchSquad.value
  try {
    const key = squad
      ? (globalThis.crypto?.randomUUID?.() ?? `g-${Date.now().toString(36)}`)
      : null
    const name = squad
      ? (lessons[0]?.course?.nameZh ?? lessons[0]?.course?.nameEn ?? '志愿组')
      : null
    const n = await store.enqueue(lessons, {
      groupKey: key,
      groupName: name,
      priority: batchPriority.value,
    })
    // 抽屉归页面自己关：`store.exitSelect()` 只管「选中了什么」，
    // 它不该知道这一页有没有开着抽屉（原先靠它顺手关掉，搬进 store 之后就漏了）
    batchOpen.value = false
    store.exitSelect()
    toast.toast(
      n
        ? squad
          ? `已排入志愿组：${n} 个志愿，同组只会中一个`
          : `已预定 ${n} 门课，到点自动开抢`
        : '没有加入任何课程',
    )
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '加入抢课失败')
  }
}

/* ---------------- 自动刷新 ----------------
 * 抢课这件事上「界面旧了」是有代价的：窗口开放、名额释放都发生在你没点按钮的时候。
 * 所以批次和教学班都自己刷，手动按钮只留作「我现在就想刷一次」的出口。
 *
 * 节奏是权衡出来的：批次 60s 一次（那三个接口很轻），教学班 30s 一次
 * （批次开着的时候名额才是活的，但一次要拉一批教学班，别太频繁）。
 */
const STATUS_EVERY_MS = 60_000
const LESSONS_EVERY_MS = 30_000
const TICK_MS = 15_000

const autoAt = ref<Date | null>(null)
let ticker: number | null = null
/** 服务器时钟自己的秒针（与自动刷新那条 15 秒的节拍分开） */
let clockTicker: number | null = null
let lastStatusAt = 0
let lastLessonsAt = 0

const autoText = computed(() => {
  const t = autoAt.value
  if (!t) return '开启中…'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
})

/** 副信息行里只放**真实的**刷新时刻：还没刷过就干脆不提这一项（「上次刷新 开启中…」是病句） */
const refreshedText = computed(() => (autoAt.value ? autoText.value : ''))

/** 有请求在飞、或正在提交，就别插队 —— 叠请求既浪费也容易把令牌撞出 401 */
function autoBusy(): boolean {
  return store.loading || store.lessonsLoading || store.submitting != null || store.grabBusy
}

async function autoRefresh(force = false): Promise<void> {
  if (autoBusy()) return
  const now = Date.now()
  try {
    if (force || now - lastStatusAt >= STATUS_EVERY_MS) {
      lastStatusAt = now
      await store.loadStatus()
    }
    if (store.activeTurn && (force || now - lastLessonsAt >= LESSONS_EVERY_MS)) {
      lastLessonsAt = now
      await store.loadLessons()
    }
    autoAt.value = new Date()
  } catch {
    // 自动刷新失败不打扰用户：store.error 会显示，下一次成功再把它抹掉
  }
}

function tick(): void {
  // 后台标签页的定时器会被 WebView 节流（普遍降到 1 次/分钟），
  // 与其按一个不准的节拍空打教务，不如等切回来时补一次
  if (document.hidden) return
  // 名单新鲜度跟着这条 15 秒的节拍走就够了（显示到「分钟」级，不必每秒重排）
  stampNow.value = Date.now()
  void autoRefresh()
}

/** 切回前台立刻补一次 —— 这比定时器值钱，也是「不用手点刷新」真正好用的地方 */
function onVisible(): void {
  if (document.hidden) return
  void autoRefresh(true)
}

function onFocus(): void {
  void autoRefresh(true)
}

/** 「加入抢课」：交给后台引擎持续重试 */
async function onGrab(payload: {
  mode: 'predicate' | 'direct'
  virtualCost: number
  scheduleGroupId: unknown
  groupKey: string | null
  groupName: string | null
  priority: number
}): Promise<void> {
  const lesson = sheetLesson.value
  if (!lesson) return
  try {
    const n = await store.enqueue([lesson], {
      mode: payload.mode,
      virtualCost: payload.virtualCost > 0 ? payload.virtualCost : null,
      scheduleGroupId: payload.scheduleGroupId,
      groupKey: payload.groupKey,
      groupName: payload.groupName,
      priority: payload.priority,
    })
    sheetLessonId.value = null
    toast.toast(
      n
        ? payload.groupKey
          ? `已加入志愿组（第 ${payload.priority} 志愿），同组只会中一个`
          : '已加入抢课任务，到点自动开抢'
        : '没有加入任何课程',
    )
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '加入抢课失败')
  }
}

/** 「立即试一次」：一次性提交并等结果 */
async function onApply(payload: { virtualCost: number }): Promise<void> {
  const lesson = sheetLesson.value
  if (!lesson) return
  try {
    const msg = await store.apply(lesson, {
      virtualCost: payload.virtualCost > 0 ? payload.virtualCost : null,
    })
    sheetLessonId.value = null
    toast.toast(msg)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '选课失败')
  }
}

onMounted(async () => {
  await campus.init()
  if (!campus.hasAccount) {
    toast.toast('还没有绑定教务系统账号，请先到「课表配置」登录')
    return
  }
  await store.loadStatus()
  lastStatusAt = Date.now()
  // 任务单与引擎推送是全局的：进页面就接上，这次看到的进度和上次关页面时是连贯的
  await store.attachGrab()

  ticker = window.setInterval(tick, TICK_MS)
  clockTicker = window.setInterval(tickClock, 1000)
  tickClock()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onFocus)
})

onBeforeUnmount(() => {
  if (ticker != null) window.clearInterval(ticker)
  if (clockTicker != null) window.clearInterval(clockTicker)
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', onFocus)
  // **不在这里清多选状态**：它住在 store 里，正是为了扛过「切出去看一眼再回来」。
  // 清掉它等于把用户按顺序排出来的志愿序当成垃圾一起收了。
  store.detachGrab()
})
</script>

<template>
  <div class="page">
    <PageHeader
      :title="store.activeTurn ? '选择教学班' : '选课'"
      :subtitle="store.activeTurn ? String(store.activeTurn.name ?? '') : '直接向教务提交选课'"
      back
    >
      <template #action>
        <!-- 任务管理入口：**常驻**（多选模式下也在）。抢完之后「哪些没抢到」
             正是最需要它的时刻，不能因为处在别的模式里就找不到 -->
        <RouterLink class="hdr-btn" :to="{ name: 'campus-grab-tasks' }" aria-label="抢课任务">
          <ListChecks :size="19" />
          <span v-if="failedCount" class="badge num" aria-hidden="true">{{ failedCount }}</span>
        </RouterLink>
        <!-- 多选是个**模式**：开着的时候点整行不再是「打开设置」而是「追加一个志愿」。
             一旦这个模式滚出视野，用户就没有任何线索知道自己处在哪种解释里了 ——
             所以它的状态与出口交给**页头**（本来就吸顶），而不是列表顶上那条会滚走的工具条。
             出口只此一个：件数交给工具条的「已选 N」，这里不再跟一个「· 3」 -->
        <button v-if="store.selectMode" class="exit-sel" @click="store.exitSelect()">
          退出多选
        </button>
        <template v-else>
          <button class="hdr-btn" aria-label="抢课节奏设置" @click="settingsOpen = true">
            <Settings2 :size="19" />
          </button>
          <button class="hdr-btn" :disabled="refresh" aria-label="立即刷新" title="立即刷新" @click="onRefresh">
            <RefreshCw :size="19" :class="{ spin: refresh }" />
          </button>
        </template>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <EmptyState
      v-if="!campus.hasAccount"
      :icon="AlertTriangle"
      title="还没有绑定教务系统账号"
      hint="选课要先用教务账号登录 —— 先去「课表配置」登录一次"
    >
      <template #action>
        <RouterLink :to="{ name: 'campus-settings' }" class="cta">去配置</RouterLink>
      </template>
    </EmptyState>

    <!-- 会话过期时给一条明确的路：重登一次即可恢复（不再抛「登录态/令牌」术语） -->
    <EmptyState
      v-else-if="store.error"
      :icon="AlertTriangle"
      :title="store.error"
      :hint="isSessionLostMessage(store.error) ? '重新登录一次就能恢复' : '下拉刷新或稍后再试'"
    >
      <template v-if="isSessionLostMessage(store.error)" #action>
        <RouterLink :to="{ name: 'campus-settings' }" class="cta">去重新登录</RouterLink>
      </template>
    </EmptyState>

    <template v-else>
      <!-- 抢课任务单就是首屏第一块：它现在同时承担「阶段 + 主数字倒计时 + 教务的钟」，
           批次的窗口时间、账号、自动刷新节拍也一并交给他做副信息 ——
           早先是「教务服务器时间」单开一张卡摆在最上面，比「还有多久出手」还显眼 -->
      <GrabPanel
        :clock="serverClock"
        :refreshed-at="refreshedText"
        :skew="skewWarning"
        :account="accountText"
        :window-text="windowText"
      />

      <!-- 批次列表 -->
      <template v-if="!store.activeTurn">
        <!-- 抢课计划：提前输入「我想抢什么」，引擎到点自己解析 + 开抢。
             窗口没开时这里就是他唯一能做的事，所以摆在批次列表之上 -->
        <GrabPlan />

        <EmptyState
          v-if="!store.hasTurn"
          :icon="Hourglass"
          title="当前没有开放的选课批次"
          hint="选课窗口由教务处统一开放。开放后这里会自动出现批次，进来就能一键选课。"
        >
          <template #action>
            <a v-if="status?.entryUrl" class="cta ghost" :href="status.entryUrl" target="_blank" rel="noreferrer">
              打开官方选课页 <ExternalLink :size="14" />
            </a>
          </template>
        </EmptyState>

        <!-- 桌面栅格：批次卡的高度随公告长短而变，并排才看得出「哪一批开着」。
             手机端它只是个普通 div，卡片仍是那条 margin-bottom: 14px 的一列 -->
        <div v-if="store.turns.length" class="d-grid turn-grid">
        <section v-for="t in store.turns" :key="idOf(t.id)" class="card turn">
          <div class="turn-head">
            <h2>{{ t.name ?? '选课批次' }}</h2>
            <span class="tag" :class="{ open: t.allowEnter }">
              {{ t.allowEnter ? '可进入' : '未开放' }}
            </span>
          </div>

          <p v-if="t.selectDateTimeText" class="line">选课时间：{{ t.selectDateTimeText }}</p>
          <p v-if="t.dropDateTimeText" class="line">退课时间：{{ t.dropDateTimeText }}</p>

          <ul v-if="t.disallowReasons?.length" class="reasons">
            <li v-for="(r, i) in t.disallowReasons" :key="i">{{ r }}</li>
          </ul>

          <p v-if="t.bulletin" class="bulletin">{{ t.bulletin }}</p>

          <button class="primary" :disabled="!t.allowEnter" @click="onEnter(t.id)">
            {{ t.allowEnter ? '进入选课' : '尚未开放' }}
          </button>
        </section>
        </div>

        <!-- 全校开课查询：**不依赖批次** —— 窗口没开的时候，这里就是他能做的规划。
             摆在批次列表之后而不是之前：批次开着时「进去选」才是主线，
             开课查询是辅助；批次没开时它自然成了唯一可用的一块。
             显隐按教务系统的能力位（正方那套没有这个接口）。 -->
        <OpenCourseQuery v-if="campus.capabilities.lessonSearch" />
      </template>

      <!-- 教学班列表 -->
      <template v-else>
        <button class="back-row" @click="store.leaveTurn(); store.exitSelect()">
          <ChevronLeft :size="16" /> 返回批次列表
        </button>

        <div class="search">
          <Search :size="15" />
          <input
            v-model="store.keyword"
            type="search"
            placeholder="搜索课程名或代码"
            @keyup.enter="onSearch"
          />
          <button class="go" :disabled="store.lessonsLoading" @click="onSearch">
            {{ store.lessonsLoading ? '…' : '查询' }}
          </button>
        </div>

        <!-- 名单是几秒前拉的。座位数每一秒都在变，而「已选 118 / 120 人」看上去永远是
             当下的数字 —— 抢课当天，一份 90 秒前的名单和一份 3 秒前的名单，
             看到的是同一行字，前者却可能已经没位了。
             量词提前成「名单 · N 秒前更新」：不再有「更新于 刚刚」这种病句 -->
        <p v-if="lessonsAge" class="fresh">
          <Clock :size="12" />
          名单 · {{ lessonsAge }}更新
        </p>

        <!-- 多选工具条：模式的**状态与出口**在吸顶的页头里（见上面那个分支），
             这里放的是「进入多选」和「批量下单」这两个动作本身。
             「退出多选」只出现在页头 —— 同一标签不在两处各写一遍 -->
        <div class="pick-bar">
          <button v-if="!store.selectMode" class="mini" @click="store.selectMode = true">
            多选预定
          </button>
          <span v-if="store.selectMode" class="count">已选 <b class="num">{{ store.selectedLessons.length }}</b></span>
          <button
            v-if="store.selectMode"
            class="mini primary-mini"
            :disabled="!store.selectedLessons.length"
            @click="openBatch"
          >
            加入抢课
          </button>
        </div>

        <p v-if="store.progress" class="progress">{{ store.progress }}</p>

        <EmptyState
          v-if="!store.lessonsLoading && store.lessons.length === 0"
          :icon="Search"
          title="没有查到教学班"
          hint="换个关键字试试，或清空搜索看全部"
        />

        <ul v-else class="lessons" :class="{ picking: store.selectMode }">
          <li
            v-for="l in store.lessons"
            :key="idOf(l.id)"
            class="lesson"
            :class="{ sel: isSelected(l) }"
          >
            <!-- 点整行开抽屉（选「上课小组 / 意愿值 / 志愿组」的地方）；多选模式下改成勾选；
                 长按 = 按默认值直接入队（加速器，见脚本里的说明）。
                 已选中的课同样可以点开 —— 那是核对「我当时怎么排的」的唯一入口 -->
            <button
              class="l-main"
              title="点开设置；长按 = 按默认设置直接加入抢课"
              @click="onRowClick(l)"
              @pointerdown="onRowDown(l)"
              @pointerup="onRowUp"
              @pointerleave="onRowUp"
              @pointercancel="onRowUp"
            >
              <span class="l-top">
                <span v-if="store.selectMode" class="tick" :class="{ on: isSelected(l) }" />
                <span class="l-name">{{ lessonTitle(l) }}</span>
                <!-- 既成事实交给课名旁的胶囊（soft 底 + strong 字，走 StatusChip）。
                     class="chip" 是 e2e 选择器的钩子（scripts/e2e-course-select.mjs 断言 .chip.ok） -->
                <StatusChip v-if="picked(l)" class="chip" tone="ok">已选</StatusChip>
                <StatusChip v-else-if="full(l)" class="chip" tone="danger">已满</StatusChip>
                <!-- 余量挨着课名：抢课当天最稀缺的就是座位，它该在视线落点上。
                     标签与单位各自一档，读成「已选 118 / 120 人」 -->
                <span v-if="seatText(l)" class="seats">
                  <span class="seats-cap">已选</span>
                  <span class="num">{{ seatText(l) }}</span>
                  <span class="seats-unit">人</span>
                </span>
              </span>
              <!-- 选班的依据：谁在教、什么时候上。一门课挂 7 个教学班时，
                   这两项才是用户真正在比较的东西 —— 藏进抽屉等于让他逐个点开背下来。
                   主依据（教师 + 上课时间）与核对用的事实（代码 / 学分 / 小组）分两档 -->
              <span class="l-meta">
                <span class="l-key">
                  <span v-if="teacherText(l)">{{ teacherText(l) }}</span>
                  <span v-if="scheduleTextOf(l)" class="l-sched">{{ scheduleTextOf(l) }}</span>
                </span>
                <span class="l-facts">
                  <span v-if="lessonCode(l)" class="num">{{ lessonCode(l) }}</span>
                  <span v-if="l.course?.credits != null">{{ l.course.credits }} 学分</span>
                  <span v-if="l.scheduleGroups?.length">{{ l.scheduleGroups.length }} 个小组</span>
                  <span v-if="isSelected(l)" class="num ord">第 {{ ordOf(l) }} 志愿</span>
                </span>
              </span>
              <!-- 同门课的班分得开：项目名当标题时，课程名与教学班名（院系在里面）落到这里 -->
              <span v-if="lessonSubtitle(l)" class="l-meta dim l-sched">{{ lessonSubtitle(l) }}</span>
            </button>

            <!-- 多选模式下右槽让给「调顺序」：顺序**就是**志愿序，而它原先只能靠点按的
                 先后排出来 —— 点错一步的唯一补救是取消重排，等于把顺序写成了只读。
                 这两个钮是唯一能改它的地方，所以它们得在行上、就在序号的旁边 -->
            <span v-if="store.selectMode && isSelected(l)" class="ord-ops">
              <button
                class="ord-op"
                :disabled="ordOf(l) === 1"
                aria-label="上移一位"
                @click.stop="store.moveSelected(idOf(l.id), -1)"
              >
                <ChevronUp :size="15" />
              </button>
              <button
                class="ord-op"
                :disabled="ordOf(l) === store.selectedLessons.length"
                aria-label="下移一位"
                @click.stop="store.moveSelected(idOf(l.id), 1)"
              >
                <ChevronDown :size="15" />
              </button>
            </span>

            <!-- 已在任务单里：显示引擎给的状态，而不是再给一个按钮。
                 class="chip grab" 同样保留给 e2e 选择器（scripts/e2e-auto-grab.mjs） -->
            <StatusChip
              v-else-if="grabChip(l) && !store.selectMode"
              class="chip grab"
              :tone="grabTone(grabChip(l)!.tone)"
            >{{ grabChip(l)!.label }}</StatusChip>
            <!-- 已选中的课不该变成一块点不动的砖：这颗按钮永远打开设置抽屉。
                 标签说实话 —— 它打开的是**设置**，不是「立刻出手」；
                 「已选」这个既成事实由课名旁的胶囊承担，按钮不再复读一遍。
                 真正的「立刻出手」是长按整行（加速器） -->
            <button
              v-else-if="!store.selectMode"
              class="pick"
              :disabled="store.grabBusy"
              @click="openSheet(l)"
            >
              <Settings2 :size="14" /> 查看设置
            </button>
          </li>
        </ul>

        <!-- 抢课计划：批次里它排在列表**之后** —— 那一刻用户是来挑课的，能一眼看到
             教学班才是主线；按关键词批量排队是次要入口。窗口没开时它才该在最上面
             （见上面那个分支） -->
        <GrabPlan />
      </template>
    </template>

    <GrabSheet
      :open="!!sheetLesson"
      :lesson="sheetLesson"
      :allow-enter="!!store.activeTurn?.allowEnter"
      :busy="store.grabBusy || !!store.submitting"
      @close="sheetLessonId = null"
      @grab="onGrab"
      @apply="onApply"
    />

    <GrabSettingsSheet :open="settingsOpen" @close="settingsOpen = false" />

    <!-- 批量预定：一次把多个教学班排好次序交给引擎 -->
    <SheetModal :open="batchOpen" title="批量预定" initial-snap="medium" @close="batchOpen = false">
      <p class="lead t-2">
        选中 <b>{{ store.selectedLessons.length }}</b> 个教学班。<b>勾选顺序就是志愿顺序</b>，
        可以直接在列表里用行上的 ↑↓ 调整。
      </p>

      <SegmentedControl
        :model-value="batchSquad ? 'squad' : 'solo'"
        :options="[
          { value: 'solo', label: '各抢各的' },
          { value: 'squad', label: '排成志愿组' },
        ]"
        @update:model-value="batchSquad = $event === 'squad'"
      />

      <p v-if="batchSquad" class="hint">
        <Info :size="13" />
        <span>
          同组<b>互斥</b>：只会中一个，中选后其余自动取消。同一门课的多个教学班、
          或时间冲突的几门课，都该排进一组。
        </span>
      </p>
      <p v-else class="hint">
        <Info :size="13" /> 各抢各的：互不干扰，适合时间不冲突、想全都要的几门课。
      </p>

      <NumberStepper
        v-if="batchSquad"
        v-model="batchPriority"
        :min="1"
        :max="20"
        :step="1"
        label="起始志愿序"
      />

      <ol class="batch-list">
        <li v-for="(l, i) in store.selectedLessons" :key="idOf(l.id)">
          <span class="tag-mini">{{ batchSquad ? `第 ${batchPriority + i}` : '独立' }}</span>
          <span class="flex-1">{{ lessonName(l) }}</span>
          <span v-if="lessonCode(l)" class="t-3 num">{{ lessonCode(l) }}</span>
        </li>
      </ol>

      <div class="acts">
        <button
          class="primary"
          :disabled="store.grabBusy || !store.selectedLessons.length"
          @click="confirmBatch"
        >
          <Zap :size="16" />
          加入抢课（{{ store.selectedLessons.length }}）
        </button>
      </div>
    </SheetModal>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶距走 --page-pad-top（手机 12 / 桌面 40），与全库页面同一处来源 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 桌面（本页是 wide 路由：壳层不套栅格，内容宽度自己负责） ----------
   抢课面板 / 抢课计划 / 开课查询是「一段设置 + 一份名单」的内容，它们拉到
   主人区整宽（1512 下约 1150）会把分段控件、输入框抻成一千多像素的长条 ——
   桌面宽屏的价值是**一屏多放几块**，不是把每一块拉长。所以这三块收在 820 居中，
   批次卡与教学班名单仍各自按 auto-fit 摊开（它们的行多，宽一点是赚的）。
   :deep 是因为这三块的根元素在组件自己身上。 */
.desk-main .rubber-layer > :deep(.grab),
.desk-main .rubber-layer > :deep(.plan),
.desk-main .rubber-layer > :deep(.open-course) {
  max-width: 820px;
  margin-inline: auto;
}

.card {
  background: var(--surface);
  /* 卡片档 16：这一页的批次卡是内容容器，32 是半模态的圆角，用在这里
     会让「卡」看起来比抽屉还高一层 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--pad-card);
  margin-bottom: var(--gap-md);
}

/* ---------- 批次 ---------- */
.turn-head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-bottom: var(--gap-sm);
}

.turn-head h2 {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.tag {
  flex: none;
  /* 状态胶囊统一 24 高（--chip-h）：2px 上下内距配 10 号字只有 18，
     和同一行的标题不在一条水平线上 */
  min-height: var(--chip-h);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
}

.tag.open {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.line {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.reasons {
  margin: var(--gap-sm) 0 0;
  padding-left: var(--sp-18);
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  line-height: var(--lh-body);
}

/* 批次公告：教务的原话，里面常有「只能选 X 门」「先到先得」这类硬约束 ——
   它不该比课程名更看不见 */
.bulletin {
  margin-top: var(--gap-sm);
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: var(--lh-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.primary {
  width: 100%;
  margin-top: var(--gap-lg);
  /* 表单主按钮：高 40、圆角 20（按钮档），与卡片 16 拉开一档 */
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

/* ---------- 空态出口 ---------- */
.cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  /* 与课表页 / 抢课页的空态出口同一形状：高 40、左右 24、胶囊 */
  min-height: var(--control-md);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: var(--sp-8) var(--sp-24);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cta:active {
  transform: scale(0.96);
}

.cta.ghost {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

/* ---------- 教学班 ---------- */
.back-row {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 44 而不是 40：这是手机上返回上一层的唯一入口，指头比像素大 */
  min-height: var(--hit-min);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
  padding: var(--sp-2) 0;
}

.search {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 44px 是手机上的下限：这一行里点的是「查询」，而它是 21px 高的文字按钮 ——
     行高撑起来、按钮纵向拉伸之后才有像个样的命中区 */
  min-height: var(--hit-min);
  padding: var(--sp-2) var(--sp-8) var(--sp-2) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-3);
  margin-bottom: var(--gap-sm);
}

.search input {
  flex: 1;
  min-width: 0;
  /* 输入框自己撑满整行高度：整行看着可点，就不该只有那条 16px 的文字线真的可点
     （手机上一行 44px、其中 16px 是热的，是那种「点了没反应」的来源） */
  align-self: stretch;
  font-size: var(--fs-caption);
  color: var(--text-1);
  background: none;
}

/* 名单新鲜度：一行小字，跟着「查询」这一排走，不占额外一份注意力 */
.fresh {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-micro);
  color: var(--text-2);
  margin: calc(-1 * var(--sp-4)) 0 var(--gap-sm) var(--sp-2);
  font-variant-numeric: tabular-nums;
}

.go {
  flex: none;
  align-self: stretch;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
  padding: 0 var(--sp-12);
}

.go:disabled {
  opacity: var(--disabled-opacity);
}

.progress {
  font-size: var(--fs-micro);
  color: var(--accent-strong);
  margin-bottom: var(--gap-sm);
}

.lessons {
  display: flex;
  flex-direction: column;
  /* 每个教学班是一张独立卡片，卡间距取 12 —— 原来 8 让两张卡糊成一片名单 */
  gap: var(--gap-md);
}

.lesson {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: var(--sp-12) var(--pad-card);
  /* 卡片档 16（原来 20 把列表行抬到了按钮层级） */
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.l-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 课名行与副信息之间是主次文本关系，取 2 */
  gap: var(--gap-text);
  text-align: left;
}

.l-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}

/* 余量：紧挨课名的数字。它是这一行里最该被比出来的量（60 / 60 与 118 / 120
   是两个完全不同的处境），所以放在视线落点上、用正文色，而不是埋进 11px 灰字里 */
.seats {
  flex: none;
  display: inline-flex;
  align-items: baseline;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  margin-left: auto;
  padding-left: var(--gap-sm);
}

/* 「已选」是标签、「人」是单位：都比数字本身小一档，不再是没单位的裸数字对 */
.seats-cap {
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.seats-unit {
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.l-name {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  line-height: var(--lh-title);
  word-break: break-all;
}

/* 行上的状态胶囊（已选 / 已满 / 抢课状态）一律用 StatusChip 承载语义色；
   模板里仍带 class="chip"（+ grab）只是 e2e 选择器的钩子，样式不再手写 */

/* 副信息分两档：主依据（谁在教、什么时候上）与核对用的事实（代码 / 学分 / 小组）。
   整行是一个按钮，行内文字不低于 12px：10px 在 320 宽的手机上已经读不出
   「哪个班 / 还差几学分」这类要做决定的信息，字号下限优先于行高紧凑。 */
.l-meta {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 主依据：选班时真正在比较的东西（谁在教 / 什么时候上），可换行 */
.l-key {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-text) var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.l-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-text) var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 「N 个小组」与上课时间：都是**用来做决定的信息**（哪个班、什么时候上），
   不是装饰 —— 降级到 --text-2 就够：层级还在（比课名弱），读得出来 */
.l-meta.dim {
  color: var(--text-2);
}

/* 上课时间地点：教务给的是自由文本，可能一长串（周次 + 节次 + 教室，还可能多段）。
   限两行：它要能读到，但不该把整个列表的行高撑成参差不齐的样子 */
.l-sched {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.pick {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 小号按钮一档：高 28 起、左右 16 */
  min-height: var(--control-sm);
  padding: var(--sp-6) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 32px 高的主按钮在拇指下太窄：视觉不动，命中区纵向撑到 44、横向各让 4px
   （它旁边是整行的 .l-main，4px 不会抢走它的点击） */
.pick::after {
  content: '';
  position: absolute;
  inset: -6px -4px;
}

.pick:active {
  transform: scale(0.94);
}

.pick:disabled {
  background: var(--surface-2);
  color: var(--text-3);
}

/* 调序的两个圆钮：占的是「抢课」胶囊在多选模式下本来就不显示的那个位置，
   所以不会挤掉任务行里的任何信息 */
.ord-ops {
  flex: none;
  display: flex;
  align-items: center;
  /* 14 档：两颗各把命中区外扩 7px 之后正好相接，谁也不偷谁的边缘
     （收到 12 会让两个 44 命中区重叠 2px） */
  gap: var(--sp-14);
}

.ord-op {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--accent-strong);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 命中区撑到 44（视觉尺寸不动）：这是改志愿序唯一的一双手 */
.ord-op::after {
  content: '';
  position: absolute;
  inset: -7px;
}

.ord-op:active {
  transform: scale(0.9);
}

.ord-op:disabled {
  opacity: var(--disabled-opacity);
  color: var(--text-3);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}

/* ---------- 多选预定 ---------- */
.pick-bar {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-bottom: var(--gap-sm);
}

.mini {
  position: relative;
  flex: none;
  /* 小号按钮一档：高 28、左右 12（与设置页的 .mini 同规格） */
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 命中区撑到 44 高（横向不动：同一行的两颗只隔 8px）。
   纵向各外扩 8px：上面是卡片间距、下面是 10px，都不会压到别人 */
.mini::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.mini.primary-mini {
  background: var(--accent);
  color: var(--on-accent);
  margin-left: auto;
}

.mini:disabled {
  opacity: var(--disabled-opacity);
}

.count {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 页头那个入口上的角标：没抢到的条数。
   白边（用 surface 描一圈）是为了让它从圆钮的边上「浮」起来，
   而不是长在按钮里 —— 它标的是**别的地方**（任务页）有事。 */
.badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-full);
  background: var(--danger);
  color: var(--on-accent);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  line-height: 18px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--surface);
}

/* 多选的退出键：材质与页头那两颗圆钮一致（surface + 卡片-shadow + 同高），
   但它是胶囊配文字 —— 它说的是一句话（还开着多选），不是一个图标动作。
   件数不在这里重复：工具条的「已选 N」是唯一报数的地方 */
.exit-sel {
  flex: none;
  display: flex;
  align-items: center;
  height: 38px;
  padding: 0 var(--sp-16);
  /* 与页头 38px 圆钮的 3px 底线对齐：差 1px 比「差一档令牌」更显眼 */
  margin-bottom: var(--sp-2);
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--accent-strong);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.exit-sel:active {
  transform: scale(0.94);
}

/* 选中态要一眼看得出，而且要看得出**排第几** —— 顺序就是志愿序 */
.lesson.sel {
  background: var(--accent-soft);
}

.tick {
  position: relative;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--line-strong);
}

.tick.on {
  border-color: var(--accent);
}

/* 实心点与 GrabSheet 的「上课小组」单选保持同一套视觉语言 */
.tick.on::after {
  content: '';
  position: absolute;
  inset: 3.5px;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.l-meta .ord {
  color: var(--accent-strong);
  font-weight: var(--fw-bold);
}

/* ---------- 批量预定抽屉 ---------- */
.lead {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  margin-bottom: var(--gap-md);
}

/* 说明文字：它是「怎么用」的唯一解释，却曾经是全页最淡的一档。
   11px 的 --text-3 在亮色下约 2.5:1、暗色下更低 —— 解释读不出来，等于没有解释 */
.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
  margin: var(--gap-sm) 0;
}

.hint svg {
  flex: none;
  margin-top: var(--gap-text);
}

.batch-list {
  margin: var(--gap-sm) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.batch-list li {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.tag-mini {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.flex-1 {
  flex: 1;
  min-width: 0;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin-top: var(--gap-lg);
}

.acts .primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  margin-top: 0;
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   这一页是宽形态（desk: 'wide'），构图自负。
   · 整页收到 --desk-wide；
   · 教学班列表是这一页唯一的长列表，也是最该被并读的东西（同一门课挂 7 个班，
     「谁在教 / 什么时候上 / 还剩几个位」本来就是要横向比的）——桌面上摊成两栏；
   · 批次卡并排（见上面的 .d-grid）。
   ============================================================ */
.desk-main .page {
  max-width: var(--desk-wide);
  margin-inline: auto;
}

/* 一行教学班 = 课名 + 徽标 + 余量 + 一枚「配置抢课」胶囊，380px 是它的舒适下限：
   1280 与 1512 两个验收宽度下都正好两栏（一行太长时「谁在教」与「还剩几个位」
   就离得太远，反而比不上一列） */
.desk-main .lessons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: var(--desk-gap);
}

/* 批次卡用 auto-fit：只有一批时它铺满整行（半栏里那个「进入选课」主按钮
   会短得不像主操作），两批以上才并排。420px 与教学班一行的下限同源 */
.desk-main .turn-grid {
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
}

/* 栅格用 gap 管列间距，批次卡自带的那条 margin-bottom 会把它撑成两倍 */
.desk-main .turn-grid > .turn {
  margin-bottom: 0;
}
</style>
