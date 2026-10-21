<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CheckCircle2, ChevronRight, Loader2, TriangleAlert, Zap } from 'lucide-vue-next'

import { notifyGrabResult } from '@/services/notifyService'
import GlassFilter from '@/components/common/GlassFilter.vue'
import { useLiquidGlass } from '@/composables/useLiquidGlass'
import { liquidGlass } from '@/system/perf'
import { grabStatusMeta, useCourseSelectStore } from '@/stores/courseSelect'

/**
 * 抢课悬浮条 —— 全应用常驻的「抢课监视器」。
 *
 * 引擎本来就在应用启动时自己跑（`grab.rs` 的后台线程 + 落库的任务单），
 * 所以「一打开软件就检查要不要开始抢课」这件事**本来就是成立的** ——
 * 缺的只是**看得见**：任务单此前只在选课页里露脸，用户得先点进去才知道现在什么情况。
 *
 * 这条浮条补的就是那一眼：
 * - 有任务在排队 → 到点前显示倒计时，到点后显示「正在开抢」；
 * - 抢到了 / 出事了 → 短暂停留后自己消失（成功让人安心，失败要能看见）；
 * - 点一下进选课页看全部任务。
 *
 * 放在**顶部**而不是底部，是刻意的：底部已经挤了运动条、录音条、语音条三条浮条，
 * 再塞一条必然打架；而且监视器的语义就是「抬头看一眼」，顶部更符合这个直觉。
 */
const store = useCourseSelectStore()
const route = useRoute()
const router = useRouter()

/* 材质：超高 / 极致档换**真折射**，与悬浮运动条同一套做法（为什么这么做、以及三条边界
   见 ActiveWorkoutBar.vue 的那段注释）：把元素自己的 backdrop-filter 从 blur() 换成
   `url(#…)`，底 / 受光边 / 光学层继续由 `.glass-surface` 那套令牌给。滤镜定义在
   common/GlassFilter.vue，量尺默认是父元素（这条 HUD 自己）。
   与那三条浮条不同的是：这条是**顶部胶囊**、不参与拖拽，只有进出场的位移。 */
const { glassFilterId, glassStyle } = useLiquidGlass()

const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  // 订阅放在这里而不是选课页：这样无论用户从哪个页面启动 App，监视器都在看着
  await store.attachGrab()
  tick = setInterval(() => { now.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
})

/** 已经在选课页就没必要再浮一条（那里的面板信息更全） */
const onSelectPage = computed(() => route.name === 'campus-course-select')
/** 任务管理页：结果的正主就在那儿（能重排、能删）—— 到了那里也算「看过了」 */
const onTasksPage = computed(() => route.name === 'campus-grab-tasks')

/**
 * 进了这两页 = 他看到了结果 —— 浮条该收的收、该忘的忘。
 *
 * 任务页必须算在内：那正是现在「看结果 / 动手处理」的地方，
 * 只认选课页的话，用户明明已经把它看完了，浮条还在那儿挂着。
 */
watch([onSelectPage, onTasksPage], ([a, b]) => {
  if (a || b) justFinished.value = null
})

const actives = computed(() => store.activeTasks)

/** 有结果但还没被用户看到 —— 停一会儿再收，别让「抢到了」悄悄溜走 */
const justFinished = ref<{ label: string; ok: boolean; at: number; sticky: boolean } | null>(null)
const SEEN_MS = 12_000

/**
 * 第一次拿到的快照只用来**建立基线**。
 *
 * 否则每次打开 App，任务单里那些早就结束的记录都会被当成「刚刚发生的」：
 * 浮条会报一遍，系统通知也会跟着响一遍 —— 那是每天早上被自己的历史记录叫醒。
 */
let sawFirstSnapshot = false
let lastTerminal = new Set<number>()

/**
 * 把结果送出 App：能发系统通知就发，发不出去就把这条浮条**钉住**。
 *
 * 只对「他没在看结果」的结果调用（见 `watchTerminal`）。反过来，没看着就必须送达：
 * 要么通知到锁屏上，要么留一条不会自己消失的浮条，二者必居其一。
 */
async function deliver(item: { label: string; sticky: boolean }, ok: boolean): Promise<void> {
  const sent = await notifyGrabResult(ok ? '抢课完成' : '抢课有结果', item.label)
  if (!sent) item.sticky = true
}

/** 此刻是不是正看着**能显示结果**的那两页（选课页的面板 / 任务管理页） */
function lookingAtResults(): boolean {
  return (onSelectPage.value || onTasksPage.value) && !document.hidden
}

/** 盯住任务状态变化：刚变成终态的那一条值得单独报一次 */
function watchTerminal(): void {
  const terminal = store.grabTasks.filter(
    (t) => t.status === 'success' || t.status === 'failed' || t.status === 'conflict',
  )
  if (!sawFirstSnapshot) {
    if (store.grab == null) return
    sawFirstSnapshot = true
    lastTerminal = new Set(terminal.map((t) => t.id))
    return
  }
  for (const t of terminal) {
    if (lastTerminal.has(t.id)) continue
    lastTerminal.add(t.id)
    const name = t.courseName || t.lessonName || `教学班 ${t.id}`
    const label =
      t.status === 'success'
        ? `已抢到《${name}》`
        : t.status === 'conflict'
          ? `《${name}》时间冲突，需办免听`
          : `《${name}》未能抢到`
    const item = { label, ok: t.status === 'success', at: Date.now(), sticky: false }
    justFinished.value = item
    // 他正看着结果页时不必推送（`show` 会让浮条在这两页上不出现），
    // 但仍要记下来：这样「结果就在那儿」这件事与他此刻在看什么无关。
    if (!lookingAtResults()) void deliver(item, item.ok)
  }
  // 任务被清掉后，id 集合也要跟着收，否则重新加入同 id 的任务不会再报
  if (terminal.length < lastTerminal.size) {
    lastTerminal = new Set(terminal.map((t) => t.id))
  }
}

/* ---------------- 窗口开放 ----------------
 * 「窗口开了」是这套系统里唯一值得**跨页面**播报的事件：抢课窗口只开几小时，
 * 而大一在窗口开放前连课都查不到，没有任何任务可以排。
 */
const windowNotice = ref<{ label: string; at: number } | null>(null)
const WINDOW_SEEN_MS = 30_000
/** 上一次看到的状态：只在「没开 → 开了」那一下报，反复推同一份快照不该反复弹 */
let sawOpenWindow = false
let sawFirstProbe = false

function watchWindowOpen(): void {
  const snap = store.grab
  // 第一次探测只建立基线：那时「批次已存在」不是新闻
  if (!sawFirstProbe) {
    if (snap?.probedAt == null) return
    sawFirstProbe = true
    sawOpenWindow = (snap.turns ?? []).some((t) => t.allowEnter)
    return
  }
  const open = (snap?.turns ?? []).filter((t) => t.allowEnter)
  if (open.length && !sawOpenWindow) {
    sawOpenWindow = true
    windowNotice.value = {
      label: `选课窗口已开放：${open.map((t) => t.name ?? t.id).join('、')}`,
      at: Date.now(),
    }
  } else if (!open.length) {
    sawOpenWindow = false
  }
}

/**
 * 引擎每推一份新快照就过一遍。
 *
 * 之前这里只在 setup 里裸调了一次 `watchTerminal()` —— 那是「挂载那一刻恰好是终态」
 * 才会报，之后抢到了也不会响。改成跟着快照走才对得上它的注释。
 */
watch(
  () => store.grab,
  () => {
    watchTerminal()
    watchWindowOpen()
  },
  { immediate: true },
)

/** 最急的那条任务：倒计时按它算 */
const lead = computed(() => {
  const list = actives.value
  if (!list.length) return null
  return [...list].sort((a, b) => {
    const fa = a.fireAt ?? Number.MAX_SAFE_INTEGER
    const fb = b.fireAt ?? Number.MAX_SAFE_INTEGER
    return fa - fb
  })[0]!
})

/**
 * 倒计时**只认引擎算好的那个时刻**（`GrabState.nextFireAt`）。
 *
 * 早先这里是自己在任务行里找「最早的 fireAt」，于是和面板上的倒计时会互相打架；
 * 而且碰到「窗口还没公布」的任务（`fireAt` 是 `i64::MAX` 那种哨兵值）时，
 * 算出来是一串天文数字。引擎那边已经算过一遍了 —— 它还知道时钟偏差与提前量，
 * 界面不该再算第二遍。
 */
const countdown = computed(() => {
  const ms = store.fireInMs(now.value)
  if (ms == null || ms <= 0) return ''
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
})

/** 倒计时只剩几秒就该用「马上要开始了」的语气 */
const imminent = computed(() => {
  const ms = store.fireInMs(now.value)
  return ms != null && ms <= 60_000
})

const finishedFresh = computed(() => {
  const f = justFinished.value
  if (!f) return null
  // 系统通知没发出去时**不许自己消失**：那条通知没到，这条就是唯一的告知。
  // 用 now 而不是 Date.now()：后者不是响应式依赖，计时到了也不会重算。
  if (f.sticky) return f
  return now.value - f.at < SEEN_MS ? f : null
})

/** 依赖 `now` 才会每秒重算 —— 否则这条提示出来就不会自己消失了 */
const windowFresh = computed(() => {
  const w = windowNotice.value
  if (!w) return null
  return now.value - w.at < WINDOW_SEEN_MS ? w : null
})

const show = computed(() => {
  // 这两页本身就是看结果/看任务的地方 —— 再浮一条只会压在它们的标题上
  if (onSelectPage.value || onTasksPage.value) return false
  if (windowFresh.value) return true
  if (finishedFresh.value) return true
  return actives.value.length > 0 || !!store.grabError
})

const tone = computed(() => {
  if (store.grabError) return 'bad'
  if (finishedFresh.value) return finishedFresh.value.ok ? 'ok' : 'bad'
  if (windowFresh.value) return 'ok'
  return 'run'
})

/**
 * 浮条正文。两种形态：
 *
 * - **带倒计时的**：状态词 / 课程名 / 倒计时各成元素 —— 倒计时是掐着秒盯抢课的人
 *   唯一要读的数，单独提为主值（--fs-title3 + .num + accent 胶囊托底），
 *   状态词降到 11px/--text-3，课程名挤不下就截断，三者竖线分隔。
 *   原先三样东西用「·」串成一行、同一个字档，要先读完整行才找到数字。
 * - **其余**（结果播报 / 窗口播报 / 已暂停）：一整句，保持原来的截断处理。
 */
type HudBody =
  | { kind: 'plain'; text: string }
  | { kind: 'parts'; status: string; name: string; cd: string }

const body = computed<HudBody>(() => {
  // 「引擎」是内部术语：用户不知道那是什么，也不知道还要不要自己动手 ——
  // 说人话，并把出路（点开这条浮条）直接写在句子里
  if (store.grabError) return { kind: 'plain', text: '抢课已暂停 · 点开看看' }
  // **结果优先于窗口播报**：窗口开着这件事是**持续为真**的（结果说完它还会再显示），
  // 而结果是一次性的事件 —— 被它压住就等于没播。（真踩过：任务页上重排之后
  // 那条「需办免听」被「窗口已开放」顶掉，用户什么都看不到。）
  if (finishedFresh.value) return { kind: 'plain', text: finishedFresh.value.label }
  // 窗口开放：那一刻用户最该做的是进去排课
  if (windowFresh.value) return { kind: 'plain', text: windowFresh.value.label }
  const t = lead.value
  if (!t) return { kind: 'plain', text: '' }
  const name = t.courseName || t.lessonName || '课程'
  if (countdown.value) {
    return {
      kind: 'parts',
      status: imminent.value ? '马上开抢' : '待开抢',
      name,
      cd: countdown.value,
    }
  }
  const meta = grabStatusMeta(t)
  const n = actives.value.length
  return {
    kind: 'plain',
    text: n > 1 ? `${name} 等 ${n} 门 · ${meta.label}` : `${name} · ${meta.label}`,
  }
})

function open(): void {
  // 「去看」的终点按**此刻要做什么**分：结果是「重排还是放弃」的决定，
  // 任务管理页才是能动手的地方；进行中是「还有多久出手」，回选课页看倒计时。
  const toTasks = !!finishedFresh.value && actives.value.length === 0
  void router.push({ name: toTasks ? 'campus-grab-tasks' : 'campus-course-select' })
}

/**
 * 给读屏的播报：**只报关键节点**（与面板同一套档位）。
 *
 * 可见那行文字里嵌着每秒都在变的倒计时。原先它被挂成 `role="status"` 的
 * `aria-label` —— 一个**每秒改写自己名字的 live region**：读屏要么被刷屏，
 * 要么排出一长串已经过时的播报，而用户没有办法让它停下。
 * 而这条浮条是全应用常驻的，等于每翻一页都带着它。
 *
 * 现在拆开：可见内容 `aria-hidden`，播报另走一条只在跨档时才改写的隐藏文本。
 */
const spoken = computed(() => {
  if (store.grabError) return '抢课已暂停 · 点开看看'
  if (windowFresh.value) return windowFresh.value.label
  if (finishedFresh.value) return finishedFresh.value.label
  if (!actives.value.length) return ''
  const name = lead.value ? (lead.value.courseName || lead.value.lessonName || '课程') : '课程'
  const ms = store.fireInMs(now.value)
  if (ms == null) return `正在抢《${name}》`
  if (ms <= 0) return `正在开抢《${name}》`
  const s = Math.ceil(ms / 1000)
  if (s <= 10) return `还有 ${s} 秒开抢《${name}》`
  if (s <= 60) return `不到一分钟就要抢《${name}》`
  if (s <= 300) return `还有五分钟就要抢《${name}》`
  return `待开抢《${name}》`
})
</script>

<template>
  <Transition name="hud">
    <!-- 整条浮条**不再是**一个按钮：它压在页头之上横跨大半屏，装在兜里误触一下就跳页。
         现在是「一块会播报的状态条 + 一个明确的『去看』按钮」。
         注意 aria-hidden 只挂在**会每秒变的文字**上，不能挂在整块上 ——
         那样会把「去看」这颗唯一的可操作元素一起从读屏里抹掉。
         真正给读屏的是下面那条只在跨档时才改写的 .sr 播报。 -->
    <div v-if="show" class="hud glass-surface" :class="tone" :style="glassStyle">
      <!-- 折射滤镜定义（不参与绘制，绝对定位）：只在超高档挂，量尺是上面这条 .hud -->
      <GlassFilter :id="glassFilterId" :enabled="liquidGlass" />
      <span class="dot" :class="{ pulse: tone === 'run' }" aria-hidden="true" />
      <Zap v-if="tone === 'run'" :size="14" class="ico" />
      <CheckCircle2 v-else-if="tone === 'ok'" :size="14" class="ico" />
      <TriangleAlert v-else :size="14" class="ico" />
      <span v-if="body.kind === 'plain'" class="txt" aria-hidden="true">{{ body.text }}</span>
      <!-- 状态词｜课名｜倒计时各成元素：倒计时是主值，一眼先读到它 -->
      <span v-else class="txt-row" aria-hidden="true">
        <b class="st">{{ body.status }}</b>
        <i class="sep" aria-hidden="true" />
        <span class="nm">《{{ body.name }}》</span>
        <i class="sep" aria-hidden="true" />
        <b class="cd num">{{ body.cd }}</b>
      </span>
      <Loader2 v-if="tone === 'run' && !countdown" :size="13" class="spin" aria-hidden="true" />
      <button class="go" type="button" aria-label="查看抢课任务" @click="open">
        <ChevronRight :size="15" />
      </button>
      <!-- 读屏专用：只在跨档（5 分钟 / 1 分钟 / 10 秒 / 开抢）时才改写，
           所以它不是那个「每秒改一次名字」的 live region —— 那才是原来的病 -->
      <span class="sr" aria-live="polite">{{ spoken }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.hud {
  position: fixed;
  top: calc(var(--safe-top) + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 80;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  max-width: min(calc(var(--frame-max) - 24px), calc(100vw - 24px));
  /* 浮条统一一档：高 44（--hit-min）、左右 16，与参照里的「进行中」胶囊同高 */
  min-height: var(--hit-min);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  color: var(--text-1);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.hud:active {
  transform: translateX(-50%) scale(0.97);
}

.txt {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}

/* 带主值的那一行：状态词｜课名｜倒计时各成元素，撑满浮条让课名去截断 */
.txt-row {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex: 1;
  min-width: 0;
}

/* 状态词：让位给倒计时的最浅一档 */
.st {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

/* 课程名：挤不下就截断（这是这一行里唯一该让位的） */
.nm {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

/* 竖线分隔：状态 / 课名 / 倒计时是三层，不用同一枚「·」串成一锅 */
.sep {
  flex: none;
  width: 1px;
  height: 12px;
  background: var(--line-strong);
}

/* 倒计时：这条浮条的主值。掐着秒盯抢课的人要先读到它 ——
   大字 + 等宽 + accent 胶囊托底，和状态词、课名分出三个字档 */
.cd {
  flex: none;
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  line-height: var(--lh-title);
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-12);
}

.ico {
  flex: none;
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.hud.ok .dot {
  background: var(--ok);
}

.hud.bad .dot {
  background: var(--danger);
}

.hud.ok .ico {
  color: var(--ok);
}

.hud.bad .ico {
  color: var(--danger);
}

.hud.run .ico {
  color: var(--accent);
}

.dot.pulse {
  animation: hud-pulse 1.1s ease-in-out infinite;
}

@keyframes hud-pulse {
  50% {
    opacity: 0.25;
  }
}

.spin {
  flex: none;
  color: var(--accent);
  animation: hud-spin 1.1s linear infinite;
}

@keyframes hud-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 「去看」是浮条里**唯一**的按钮：命中区撑到 44×44（浮条本身才 33px 高），
   这样它既好点，又不会像整条浮条那样在兜里被误触 */
.go {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-3);
}

.go::after {
  content: '';
  position: absolute;
  inset: -9px;
}

.go:active {
  background: var(--surface-2);
}

/* 读屏专用：视觉上不存在，但它是这条浮条留给读屏的唯一出口 */
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* 进出：从顶部滑入，别用缩放——它是「降下来的一条」，不是弹出来的 */
.hud-enter-active,
.hud-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-out);
}

.hud-enter-from,
.hud-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-14px);
}

@media (prefers-reduced-motion: reduce) {
  .dot.pulse,
  .spin {
    animation-duration: 3s;
  }
}
</style>
