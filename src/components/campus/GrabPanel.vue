<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  Check,
  CheckCircle2,
  Layers,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  Trash2,
  Zap,
} from 'lucide-vue-next'

import GrabResult from '@/components/campus/GrabResult.vue'
import { useTwoStepConfirm } from '@/composables/useTwoStepConfirm'
import { campusService } from '@/services/campusService'
import { grabStatusMeta, useCourseSelectStore } from '@/stores/courseSelect'
import type { GrabPreflight, GrabTask } from '@/types'
import { askAiForGrabRescue } from '@/utils/campusAi'
import { grabTaskTitle, groupGrabSquads } from '@/utils/grab'

/**
 * 抢课任务单面板 —— 引擎的仪表盘。
 *
 * 这里要回答三个问题，且必须在**不盯着屏幕**时也能一眼答上：
 * 1. 现在在抢什么？（任务行 + 状态标签）
 * 2. 什么时候出手？（倒计时，按服务器时钟校正）
 * 3. 出事了吗？（引擎级故障横幅 / 任务失败原因）
 *
 * **没有在抢的时候，它整体让位给 [`GrabResult`]** —— 那一刻用户要的不是「过程」，
 * 而是「拿到了什么、还欠什么、现在做什么」（见那个组件的说明）。
 *
 * 倒计时每秒刷一次：它只是个显示，真正的开火时刻在 Rust 那边，
 * 界面卡了、页面切走了都不影响抢课 —— 所以这里用本地定时器完全够用。
 */
const store = useCourseSelectStore()
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

/* ---------------- 起飞前自检 ----------------
 *
 * 抢课最贵的一种失败是「**以为在抢，其实早就放弃了**」：名单没拉到、计划一个班都没匹配上、
 * 时钟没测准、窗口已经过去 —— 这些在任务列表里都长得像「在等待」。
 * 所以这里给一个按钮，把每一件「行不行」连同证据一次摆出来。
 *
 * 它是**按需触发**的（会打几次网络，和预览一个量级），不自动跑：
 * 自动跑就等于每分钟替用户做一次全量体检，而绝大多数时候他只想看一眼进度。
 */
const preflight = ref<GrabPreflight | null>(null)
const preflightBusy = ref(false)

async function runPreflight(): Promise<void> {
  if (preflightBusy.value) return
  preflightBusy.value = true
  try {
    preflight.value = await campusService.grabPreflight()
  } catch (e) {
    preflight.value = {
      ok: false,
      items: [],
      summary: e instanceof Error ? e.message : '体检失败',
    }
  } finally {
    preflightBusy.value = false
  }
}

/**
 * 自检结果：**先看坏的**。
 *
 * 只排序、不截断 —— 自检是用户自己点出来的，他要的就是一份完整结论；
 * 把第 5 项折叠成「还有 1 项」反而把最该看的那条藏了
 * （计划那一项恰恰是「一个候选都没匹配上」最可能出现的地方）。
 */
const pfItems = computed(() => {
  const items = preflight.value?.items ?? []
  return [...items.filter((i) => !i.ok), ...items.filter((i) => i.ok)]
})

/**
 * 页面级的几件事实由页面传进来（服务器时钟、上次刷新时刻、对时偏差、账号、当前窗口）。
 *
 * 为什么不在这里自己算：这些值每一秒都在变，而页面已经在算它们了 —— 复制一份
 * 就是给「同一件事两种说法」再开一条路（这块板上已经吃过一次这个亏）。
 */
const props = withDefaults(
  defineProps<{
    /** 教务服务器时间（已在页面里按采样时刻线性推进到当下） */
    clock?: string
    /** 上一次自动刷新的时刻 */
    refreshedAt?: string
    /** 对时偏差告警，空串表示没有值得说的偏差 */
    skew?: string
    /** 「张伟 20231001」 */
    account?: string
    /** 当前批次的窗口：「07-31 10:00 → 09-30 23:00」 */
    windowText?: string
  }>(),
  { clock: '', refreshedAt: '', skew: '', account: '', windowText: '' },
)

onMounted(() => {
  tick = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
})

const tasks = computed(() => store.grabTasks)
const actives = computed(() => store.activeTasks)
const paused = computed(() => tasks.value.filter((t) => t.status === 'paused'))
/** 未结束的排前面，已结束的沉底（后端已经排好序，这里只负责分组渲染） */
const finished = computed(() =>
  tasks.value.filter(
    (t) =>
      t.status === 'success' ||
      t.status === 'failed' ||
      t.status === 'conflict' ||
      t.status === 'cancelled' ||
      // 被教务拒绝的也是「这一轮的结局」：引擎已经停手，它该出现在结果里，
      // 而不是留在任务单上看着像还在抢
      t.status === 'needs_ai',
  ),
)

/**
 * 结束态：没有在抢的、也没有被暂停的，但手上有已结束的记录 —— 这时该显示**结果**。
 *
 * 判定里必须有「也没有被暂停的」：全部暂停时 `actives` 同样是空的，
 * 但那些任务还没结束（用户随时会恢复），把它们盖在结果面板下就看不见了。
 */
const resultMode = computed(
  () => actives.value.length === 0 && paused.value.length === 0 && finished.value.length > 0,
)

const rows = computed<RenderRow[]>(() => {
  const out: RenderRow[] = []
  for (const g of squads.value) {
    out.push({ kind: 'head', key: g.key, name: g.name, lead: leading(g) })
    for (const m of g.members) out.push({ kind: 'task', t: m })
  }
  for (const t of loose.value) out.push({ kind: 'task', t })
  return out
})

const hasAny = computed(() => tasks.value.length > 0)

/** 距下一次开火的倒计时文案 */
const countdown = computed(() => {
  const ms = store.fireInMs(now.value)
  if (ms == null) return ''
  if (ms <= 0) return '正在开抢'
  return formatCountdown(ms)
})

/**
 * T-0 前后这块板要**换形态**，而不是只换个数字。
 *
 * 一个 12:34 的倒计时和 00:07 的倒计时长得一样，但它们是完全不同的两件事：
 * 前者是等待，后者是「下一秒就出手」。形态（底色、脉冲、数字颜色）就是用来
 * 让人从余光里也能分辨这一点 —— 尤其这块板会成为首屏第一眼看到的东西。
 */
const stageHot = computed(() => {
  if (countdown.value === '正在开抢') return true
  const ms = store.fireInMs(now.value)
  return ms != null && ms <= 10_000
})

/**
 * **窗口已经开了，而任务单是空的** —— 整套机制里最危险的那一格。
 *
 * 危险在哪：名额正在以秒为单位消失，而他手上一条任务都没有。
 * 而它原先长什么样？——没有倒计时（`fireInMs` 在没有任务时返回 null）、没有变色、
 * 没有一句话说要紧 —— 整页呈现出的是一天里最平静的样子，
 * 恰恰把「更危险的态」画成了「更安心的态」。
 *
 * 所以这个态要自己站出来：换底色（警告档）、把窗口时间从 11px 副信息里提出来、
 * 并且明确说清「现在该干什么」。判据用 `allowEnter`（窗口真的开了）
 * 而不是「有没有批次」——批次存在但进不去时，确实没什么可急的。
 */
const stageOpen = computed(
  () => store.activeTurn?.allowEnter === true && actives.value.length === 0 && !resultMode.value,
)

/** 窗口已经开了多久 / 还剩多久：比一个静态的时间区间更像「正在发生的事」 */
const openFor = computed(() => {
  if (!stageOpen.value) return ''
  const raw = store.activeTurn?.selectDateTimeRange?.endDateTime
  if (!raw) return ''
  const end = new Date(String(raw).replace(' ', 'T')).getTime()
  if (Number.isNaN(end)) return ''
  const ms = end - now.value
  if (ms <= 0) return '窗口已结束'
  return `还剩 ${formatCountdown(ms)}`
})

/**
 * **窗口是否开着** —— 这件事本身要一直看得见，但不该一直报警。
 *
 * 正选窗口可以开好几天，把整块板染成警告色过一整天就成了狼来了。
 * 所以拆成两层：窗口开着是**事实**（说出来、用颜色标出来），
 * 而「进了批次却一条任务都没排」才是**警报**（stageOpen，整块板变色）。
 */
const windowOpen = computed(
  () => store.activeTurn?.allowEnter === true || store.turns.some((t) => t.allowEnter),
)

/**
 * 给读屏的播报：**只报关键节点**。
 *
 * 可见的那个大数字挂的是 `aria-hidden` —— 它每秒都在变，读屏会跟着念一整晚。
 * 按 5 分钟 / 1 分钟 / 10 秒 / 开抢 四档播报，既听得见关键进展，又不吵。
 */
const spoken = computed(() => {
  const ms = store.fireInMs(now.value)
  if (ms == null) return ''
  if (ms <= 0) return '正在开抢'
  const s = Math.ceil(ms / 1000)
  if (s <= 10) return `还有 ${s} 秒开抢`
  if (s <= 60) return '不到一分钟就要开抢'
  if (s <= 300) return '还有五分钟就要开抢'
  return ''
})

/**
 * **阶段陈述**：这块板上最重要的一句话。
 *
 * 它回答的是「现在到底在发生什么」—— 而这恰恰是原先最含糊的地方：
 * 状态散在倒计时、徽标、空态和跨页浮条四处，用户得自己拼。
 * 一句人话 + 一个必要时才出现的倒计时，比四个各自为政的指示器都管用。
 */
const phaseText = computed(() => {
  if (store.grabError) return '引擎停了 —— 先处理上面的问题'
  if (store.rejectedTasks.length) return '有请求被教务拒了（参数错误），已交给 AI 排查'
  if (resultMode.value) return ''
  if (!hasAny.value) {
    if (stageOpen.value) return '窗口开着，但还没有排课'
    if (windowOpen.value) return '窗口开放中 · 还没有排队的课程'
    return listening.value ? '正在盯着选课窗口' : '还没有排队的课程'
  }
  if (actives.value.some((t) => (t.attempts ?? 0) > 0 || (t.polls ?? 0) > 0)) {
    return '已经出手了'
  }
  if (actives.value.some((t) => t.awaitWindow && !t.windowWall)) {
    return '已排好，等教务公布窗口'
  }
  if (countdown.value === '正在开抢') return '正在开抢'
  if (actives.value.length && actives.value.every((t) => t.fireAt != null)) {
    return '已排好，等窗口开了就出手'
  }
  return '正在按节奏重试'
})

function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 任务行标题：命名规矩在 utils/grab（任务行 / 结果行 / 志愿组共用一份） */
const title = grabTaskTitle

/**
 * 「这一秒为什么没在打」——等待中的任务要有这句话。
 *
 * 引擎被拒之后会让那个候选先退开一会儿（冷却），把机会交给组里下一个候选
 * （见 Rust 侧 `REJECT_COOLDOWN_MS` / `group_lead`）。界面上如果只写「待开抢」，
 * 用户看到的就是「它明明该在抢却一动不动」—— 而真相是「它在按冷却排队」。
 */
function waitText(t: GrabTask): string {
  if (t.status !== 'waiting' && t.status !== 'running') return ''
  const ms = (t.nextAt ?? 0) - now.value
  if (ms <= 0) return ''
  if (ms < 1000) return '马上重试'
  const s = Math.ceil(ms / 1000)
  return s < 60 ? `${s} 秒后重试` : `${Math.ceil(s / 60)} 分钟后重试`
}

/** 一行副标题：课程号 · 第几次尝试 · 什么时候再动 · 教务最近说了什么 */
function detail(t: GrabTask): string {
  const bits: string[] = []
  if (t.courseCode) bits.push(t.courseCode)
  if (t.attempts > 0) bits.push(`已尝试 ${t.attempts} 次`)
  const wait = waitText(t)
  if (wait) bits.push(wait)
  if (t.lastMessage) bits.push(t.lastMessage)
  return bits.join(' · ')
}

async function act(id: number, action: 'pause' | 'cancel' | 'retry' | 'remove'): Promise<void> {
  await store.taskAction(id, action)
}

/**
 * 行上那枚徽标：**引擎级故障时一律改成「引擎已停」**。
 *
 * 会话失效时后端只是把任务降速重排（`status` 仍是 waiting），所以行内会继续挂着蓝色的
 * 「待开抢 / 排队中」—— 而它此刻根本不会开火。同一个状态在浮条上叫「已暂停」、
 * 在行内叫「待开抢」、实际是「每分钟重试一次」，三种说法里只有一种是真的。
 */
function chipOf(t: GrabTask): { label: string; tone: string } {
  if (store.grabError && (t.status === 'waiting' || t.status === 'running')) {
    return { label: '引擎已停', tone: 'bad' }
  }
  return grabStatusMeta(t)
}

/**
 * 移除是**两步**的：这些行是「抢到了什么」的唯一本地记录，
 * 一次误触就把它删掉不值 —— 尤其它离「重试 / 取消」只有 4px。
 */
const { pending: pendingRemove, ask } = useTwoStepConfirm()
function askRemove(id: number): void {
  ask(id, () => void act(id, 'remove'))
}

/* ---------------- 志愿组 ----------------
 * 组内是**互斥备选**：一次只主攻当前志愿，中选后其余自动取消。所以组要看成一个
 * 整体来渲染 —— 散在列表里的话，「为什么第 2 志愿一直不动」就没人答得上来。
 */
/* 面板要展示已取消的成员（任务单历史），选课页的「加入某一组」只要活着的组 */
const squads = computed(() => groupGrabSquads(tasks.value, { includeCancelled: true }))

/** 不在任何组里的任务，照旧平铺 */
const loose = computed(() => tasks.value.filter((t) => !t.groupKey?.trim()))

/** 渲染行：组头 + 组成员，然后是散任务。展平之后模板里只有一份任务行 */
type RenderRow =
  | { kind: 'head'; key: string; name: string; lead: GrabTask | null }
  | { kind: 'task'; t: GrabTask }

/** 组里正在出手的那个。终态/暂停的成员不在场上，别把它们当成「当前志愿」 */
function leading(g: { members: GrabTask[] }): GrabTask | null {
  return (
    g.members.find(
      (m) =>
        !m.heldBy &&
        m.status !== 'success' &&
        m.status !== 'failed' &&
        m.status !== 'conflict' &&
        m.status !== 'cancelled' &&
        m.status !== 'paused',
    ) ?? null
  )
}

/** 被压住的是在等第几志愿 —— 直接说出序号，别让人自己数 */
function waitingOn(t: GrabTask): string {
  const holder = tasks.value.find((x) => x.id === t.heldBy)
  return holder ? `等第 ${holder.priority ?? '?'} 志愿` : '待命'
}

/* ---------------- 窗口监听 ----------------
 * 没有任务时这块也不是空的：引擎只要账号在、开关开着，就在每分钟问「窗口开了没」。
 * 大一新生在窗口开放前没有任何任务可排，这条就是他唯一能看到的进展。
 */
const listenedTurns = computed(() => store.grab?.turns ?? [])
/* 「它还在盯着」这句话只在该说的时候说 —— 上面的阶段行没有排课时已经在
   说「正在盯着选课窗口 / 还没有排队的课程」了，探测还没报出任何批次时
   再把同一句话写第二遍，读者只会浪费时间去找那句并不存在的差别。
   所以只有探测真的有实质新信息（报出了批次，或窗口已开放）才返回内容 */
const listenText = computed(() => {
  const open = listenedTurns.value.filter((t) => t.allowEnter)
  if (open.length) return `窗口已开放：${open.map((t) => t.name ?? t.id).join('、')}`
  if (listenedTurns.value.length) {
    return `已发现 ${listenedTurns.value.length} 个批次，但还不能进入`
  }
  return ''
})
/**
 * 「它还在盯着」这句话必须**只在该说的时候说**。
 *
 * 判据是引擎真的在报数：`alive`（线程活着）+ 最近一次窗口探测足够新。
 * 早先这里只看 `probedAt != null` —— 那是「历史上探测过一次」，
 * 引擎停了、会话掉了它都还是真，等于在安慰用户。
 */
const listening = computed(() => {
  const g = store.grab
  if (!g || !g.alive) return false
  return g.probedAt != null && now.value - g.probedAt < 3 * 60_000
})

/**
 * 交给 AI 排查：把现场（引擎故障原文、任务卡在哪一步、计划解析状态、批次窗口）压成一段话递过去，
 * 由 AI 决定是重登、重排、改节奏，还是去教务那边看原始响应。
 *
 * 为什么要有这个入口：引擎能自己处理的失败都已经自己处理了（重试、退避、会话自愈），
 * 剩下它处理不了的 —— 教务改了接口、文案换了、批次规则变了 —— 恰恰是人最不知道从哪下手的那类。
 */
function handToAi(): void {
  askAiForGrabRescue(store.grab)
}
</script>

<template>
  <!-- 没有任务但**引擎在监听**时也要显示：大一新生在窗口开放前没有任何任务可排，
       「它正在盯着窗口」就是他唯一能看到的进展（早先这块只在出错时才渲染，等于没说） -->
  <section
    v-if="hasAny || store.grabError || listening || props.clock"
    class="card grab"
    :class="{ hot: stageHot, open: stageOpen }"
  >
    <header class="head">
      <span class="row title">
        <Zap :size="15" class="bolt" />
        <b>抢课</b>
        <span v-if="actives.length" class="live num">{{ actives.length }} 个进行中</span>
        <span v-if="!store.grab?.alive && (hasAny || listening)" class="chip bad">引擎没在跑</span>
      </span>

      <!-- 主数字：这是整页最该一眼看到的东西。倒计时**只有真的存在时**才出现 ——
           没有值得等的时刻就不摆一个数字在那儿 -->
      <template v-if="countdown">
        <span class="cd-label">距出手</span>
        <p class="cd-big num" :class="{ live: countdown === '正在开抢' }" aria-hidden="true">
          {{ countdown }}
        </p>
      </template>

      <!-- 一句话阶段：先说「现在在发生什么」，再给「还有多久」 -->
      <p class="phase" role="status" :class="{ lede: !countdown }">
        {{ phaseText || (listening ? '正在盯着选课窗口' : '等你安排要抢的课') }}
      </p>

      <!-- 窗口开没开，是「现在该不该动手」的唯一依据。
           它原先只是副信息行里的第 3 个片段（窗口 09-24 00:00 → …），
           和「上次刷新」「演示同学」同一个份量、同一档 11px 灰字 ——
           等于把「现在能选课」这件事藏进了一行背景事实里 -->
      <p v-if="props.windowText" class="win" :class="{ on: windowOpen }">
        <CalendarClock :size="12" />
        <span>{{ windowOpen ? '选课窗口开放中' : '选课窗口' }} {{ props.windowText }}</span>
        <b v-if="openFor" class="num">{{ openFor }}</b>
      </p>

      <!-- 副信息：教务的钟、上次刷新、账号，全部降级成这一行小字。
           抢课对时全靠教务的钟，但它不该比「还有多久出手」更抢眼 -->
      <p class="facts">
        <span class="num">教务服务器时间 {{ props.clock || '—' }}</span>
        <span v-if="props.refreshedAt">· 上次刷新 {{ props.refreshedAt }}</span>
        <span v-if="props.account">· {{ props.account }}</span>
      </p>

      <!-- 这条硬前提原先是最淡的一档小字。可它是「关掉 App 就不再出手」——
           整个产品最容易让人误解的地方，读不清就等于没说 -->
      <p class="engine">
        <ShieldAlert :size="12" />
        引擎跑在 App 进程里：App 被划掉或清理后就不再出手
      </p>

      <!-- 起飞前自检：一行按钮 + 逐项结果。它回答的是「现在这套配置真能抢到吗」，
           而不是「任务跑到哪一步了」—— 那两件事在出问题时长得一样 -->
      <div class="preflight">
        <button class="pf-go" type="button" :disabled="preflightBusy" @click="runPreflight">
          <Stethoscope :size="13" />
          {{ preflightBusy ? '正在体检…' : '起飞前自检' }}
        </button>
        <span v-if="preflight" class="pf-sum" :class="preflight.ok ? 'ok' : 'bad'">
          {{ preflight.summary }}
        </span>
      </div>
      <ul v-if="pfItems.length" class="pf-list">
        <li v-for="it in pfItems" :key="it.key + it.label" :class="it.ok ? 'ok' : 'bad'">
          <span class="pf-mark" aria-hidden="true">{{ it.ok ? '✓' : '✕' }}</span>
          <span class="col">
            <b>{{ it.label }}</b>
            <em class="pf-detail">{{ it.detail }}</em>
          </span>
        </li>
      </ul>

      <p v-if="props.skew" class="warn" role="status">
        <AlertTriangle :size="14" /> {{ props.skew }}
      </p>

      <!-- 读屏专用：只有跨档才说话（可见的大数字是 aria-hidden 的） -->
      <span class="sr" aria-live="polite">{{ spoken }}</span>
    </header>

    <!-- 引擎级故障：会话失效这类问题必须显眼 -->
    <p v-if="store.grabError" class="fault" role="status">
      <AlertTriangle :size="14" />
      <span>{{ store.grabError }}</span>
      <button class="fix" type="button" @click="handToAi">交给 AI 排查</button>
      <RouterLink :to="{ name: 'campus-settings' }" class="fix">去重登</RouterLink>
    </p>

    <!-- **参数错误**：教务拒了这条请求 —— 重试不会改变结果，引擎已经停手。
         这里要说清「为什么停了」并给出唯一有用的下一步（交 AI / 重新解析），
         而不是让用户对着一个不动的任务反复点重试。 -->
    <div v-if="store.rejectedTasks.length" class="rejected" role="status">
      <p class="rl">
        <Ban :size="14" />
        <span>
          教务拒绝了 {{ store.rejectedTasks.length }} 条请求（参数错误）——
          <b>重试不会成功</b>，引擎已停手，等 AI 查明教务现在要什么参数
        </span>
      </p>
      <p class="why">{{ store.rejectedTasks[0]!.lastMessage }}</p>
      <div class="row acts">
        <button class="fix" type="button" @click="handToAi">交给 AI 排查</button>
        <button
          class="fix"
          type="button"
          @click="store.rejectedTasks.forEach((t) => act(t.id, 'retry'))"
        >
          重新排队试试
        </button>
      </div>
    </div>

    <!-- 没有任务时，只在探测真的报出东西（批次 / 窗口开放）时才显示这一行。
         同卡上面的阶段句没有排课时已经在说「还没有排课」了，
         同一张卡上把同一句话说两遍，只是让人多读一遍 -->
    <p v-if="!hasAny && listenText" class="listen-line">{{ listenText }}</p>

    <!-- 结束态：没有在抢的了 —— 把「结果」顶上来。此刻「正在抢什么」已经没有内容，
         而用户（多半是睡醒的人）要的是「拿到了什么、还欠什么、现在做什么」 -->
    <GrabResult
      v-else-if="resultMode"
      :tasks="finished"
      @retry="(id: number) => act(id, 'retry')"
      @clean="store.clearFinished()"
    />

    <ul v-else class="list">
      <template v-for="row in rows" :key="row.kind === 'head' ? `h-${row.key}` : row.t.id">
        <!-- 志愿组头：把「谁在抢、谁在等」一次说清 -->
        <li v-if="row.kind === 'head'" class="squad">
          <Layers :size="13" />
          <b>{{ row.name }}</b>
          <span>
            {{ row.lead ? `第 ${row.lead.priority ?? '?'} 志愿在抢` : '等待接手' }}
          </span>
        </li>

        <li v-else class="task" :class="chipOf(row.t).tone">
          <div class="col flex-1 body">
            <div class="row line1">
              <span v-if="row.t.groupKey" class="ord num">第 {{ row.t.priority ?? '?' }}</span>
              <span class="name">{{ title(row.t) }}</span>
              <span class="chip" :class="chipOf(row.t).tone">{{ chipOf(row.t).label }}</span>
              <span v-if="row.t.heldBy" class="chip idle">{{ waitingOn(row.t) }}</span>
            </div>
            <p v-if="detail(row.t)" class="meta">{{ detail(row.t) }}</p>
          </div>

          <div class="row ops">
            <button
              v-if="row.t.status === 'waiting' || row.t.status === 'running'"
              class="op"
              title="暂停"
              aria-label="暂停"
              @click="act(row.t.id, 'pause')"
            >
              <Pause :size="14" />
            </button>
            <button
              v-else-if="row.t.status === 'paused'"
              class="op"
              title="恢复"
              aria-label="恢复"
              @click="act(row.t.id, 'retry')"
            >
              <Play :size="14" />
            </button>
            <button
              v-else-if="row.t.status === 'failed' || row.t.status === 'conflict'"
              class="op"
              title="重试"
              aria-label="重试"
              @click="act(row.t.id, 'retry')"
            >
              <RotateCcw :size="14" />
            </button>
            <button
              v-if="row.t.status === 'success' || row.t.status === 'cancelled'"
              class="op"
              :class="{ danger: pendingRemove === row.t.id }"
              :title="
                pendingRemove === row.t.id
                  ? `再点一次确认移除「${title(row.t)}」：这条抢课记录将不再显示，也无法恢复`
                  : '移除'
              "
              :aria-label="pendingRemove === row.t.id ? '确认移除' : '移除'"
              @click="askRemove(row.t.id)"
            >
              <Check v-if="pendingRemove === row.t.id" :size="14" />
              <Trash2 v-else :size="14" />
            </button>
            <button
              v-else
              class="op"
              title="取消"
              aria-label="取消"
              @click="act(row.t.id, 'cancel')"
            >
              <Ban :size="14" />
            </button>
          </div>
        </li>
      </template>
    </ul>

    <footer v-if="hasAny" class="foot">
      <button v-if="actives.length" class="link" @click="store.pauseAll()">全部暂停</button>
      <button v-else-if="paused.length" class="link" @click="store.resumeAll()">全部恢复</button>
      <!-- 结束态下清理由结果面板负责（那里是两步确认的），这里不再给第二个入口 -->
      <button v-if="finished.length && !resultMode" class="link t-3" @click="store.clearFinished()">
        <CheckCircle2 :size="13" /> 清掉已结束的 {{ finished.length }} 条
      </button>
      <!-- 常驻入口：引擎能自己处理的失败都自己处理了，剩下处理不了的那些才需要人喊 AI -->
      <button class="link ai" type="button" @click="handToAi">
        <Sparkles :size="13" /> 交给 AI 排查
      </button>
    </footer>
  </section>
</template>

<style scoped>
.card {
  background: var(--surface);
  /* 卡片档 16：这几张是页面级的内容容器，32 是半模态的层级；
     用 32 会让一屏卡片看起来比弹出的抽屉还高一层 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--pad-card);
  margin-bottom: var(--gap-md);
}

.head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  margin-bottom: var(--sp-10);
}

.title {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-callout);
  color: var(--text-1);
}

.bolt {
  color: var(--accent);
}

.live {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-8);
}

/* 阶段陈述：这块板上最该被读到的一行 —— 15px 正文级，而不是 12px 的元信息 */
.phase {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-4);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  line-height: var(--lh-caption);
}

/* 没有倒计时时，这句话就是主角：抬到 headline 级 */
.phase.lede {
  font-size: var(--fs-headline);
}

/* 那句「距出手」的小标签：说明下面这个数字是什么 */
.cd-label {
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-top: var(--sp-2);
}

/* 主数字：整页最大的字。倒计时是决定成败的那个量，它比教务的钟更该抢眼 ——
   早先这里是 15px/--text-2，比旁边的钟还弱，正好把权重放反了 */
.cd-big {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  line-height: var(--lh-display);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.cd-big.live {
  font-size: var(--fs-display-m);
  color: var(--accent-strong);
  animation: pulse 1.4s ease-in-out infinite;
}

/* 副信息：一行小字，允许折行；它们是背景事实，不该跟主数字抢注意力。
   但「不抢注意力」不等于「读不出来」—— 这两行里装着教务的钟和对时的依据，
   原先 11px 的 --text-3 在亮色下只有约 2.5:1，暗色下更低，等于印了一层水印。 */
.facts,
.engine {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0 var(--sp-6);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.engine {
  gap: 0 var(--sp-4);
  align-items: flex-start;
}

.engine svg {
  flex: none;
  margin-top: var(--sp-2);
  color: var(--warn-strong);
}

/* 起飞前自检：按钮与逐项结果。刻意做成「一行小字 + 一个按钮」的份量 ——
   它是出事时才会去看的东西，不该跟倒计时抢注意力 */
.preflight {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-6) var(--sp-8);
  margin-top: var(--sp-2);
}

.pf-go {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  /* 小号按钮一档 28；命中区由 ::after 撑到 44 */
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--sp-10);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-2);
  font-size: var(--fs-caption);
  cursor: pointer;
}

/* 命中区纵向撑到 44：它是 T-1 分钟最可能被按的那颗按钮，
   而它视觉上只有 28 高（横向不外扩：右边紧挨着自检结论那句话） */
.pf-go::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.pf-go:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

.pf-sum {
  font-size: var(--fs-caption);
}

/* 结论文字是正文，不是填充色：实底档 --ok / --danger 压白底不够 4.5:1，
   与全库 soft 底上的状态词同一条规则，走 strong 档 */
.pf-sum.ok {
  color: var(--ok-strong);
}

.pf-sum.bad {
  color: var(--danger-strong);
}

.pf-list {
  list-style: none;
  margin: var(--sp-4) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.pf-list li {
  display: flex;
  gap: var(--sp-6);
  align-items: flex-start;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.pf-list li .col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pf-list li em {
  font-style: normal;
  word-break: break-word;
}

/* 自检的**证据**（「会话有效，选课令牌可用」这类）—— 这一行才是自检存在的理由，
   它不能比上面那个 ✓/✕ 还看不见 */
.pf-detail {
  color: var(--text-2);
}

.pf-mark {
  flex: none;
  width: 1em;
  text-align: center;
}

/* 自检的 ✓ / ✕ 是文字字形（不是 SVG 图标）：同一条「实底档不当文字色」 */
.pf-list li.ok .pf-mark {
  color: var(--ok-strong);
}

.pf-list li.bad .pf-mark {
  color: var(--danger-strong);
}

/* T-0 前后换形态：整块板染色 + 描边，余光里也能看出「正在出手」 */
.grab.hot {
  background: var(--accent-soft);
  box-shadow: var(--shadow-card), inset 0 0 0 1px var(--accent);
}

/* **窗口开着、任务单却是空的** —— 名额正在消失，而他一条任务都还没排。
   这个态必须自己站出来，否则它长得和一天里最平静的那几秒一模一样：
   没有倒计时（没有任务就没有 fireInMs）、没有变色、没有一句话说要紧。
   用警告档而不是强调档：强调档是「正在出手」（好事），警告档是「你还什么都没做」。 */
.grab.open {
  background: color-mix(in srgb, var(--warn) 10%, var(--surface));
  box-shadow: var(--shadow-card), inset 0 0 0 1px var(--warn);
}

.grab.open .bolt {
  color: var(--warn-strong);
}

/* 窗口开没开：一行事实，开着的用强调色说出来 */
.win {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0 var(--sp-4);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.win svg {
  flex: none;
}

.win.on {
  color: var(--accent-strong);
  font-weight: var(--fw-semibold);
}

.win b {
  font-weight: var(--fw-bold);
}

/* 读屏专用文本：可见的那个大数字每秒都变，不能让它当 live region */
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cd.hot {
    animation: none;
  }
}

/* 对时偏差告警：教务的钟与本机差得太多时说一句，抢课一律以教务时间为准 */
.warn {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--warn-strong);
  line-height: var(--lh-caption);
  margin-top: var(--sp-4);
}

.fault {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  flex-wrap: wrap;
  font-size: var(--fs-caption);
  color: var(--warn-strong);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border-radius: var(--radius-m);
  padding: var(--sp-8) var(--sp-10);
  margin-bottom: var(--sp-10);
  line-height: var(--lh-caption);
}

.fix {
  position: relative;
  display: inline-flex;
  align-items: center;
  /* 小号按钮一档；命中区由 ::after 补到 44（下面两条横幅里的唯一出路） */
  min-height: var(--control-sm);
  font-weight: var(--fw-bold);
  color: var(--accent-strong);
  margin-left: auto;
}

.fix::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

/* 被教务拒绝的请求：警告色但**给出路**（交 AI / 重新排队），不做成死路一条的红条 */
.rejected {
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border-radius: var(--radius-m);
  padding: var(--sp-8) var(--sp-10);
  margin-bottom: var(--sp-10);
}

.rl {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--warn-strong);
  line-height: var(--lh-caption);
}

/* 被教务拒绝的那句原话：它是「为什么停了」的唯一直接证据 */
.why {
  font-size: var(--fs-caption);
  margin-top: var(--sp-4);
  line-height: var(--lh-caption);
  word-break: break-word;
  color: var(--text-2);
}

.rejected .acts {
  gap: var(--sp-14);
  margin-top: var(--sp-6);
}

/* 这一块里的按钮有自己的排布，别继承 .fix 的「推到右边」 */
.rejected .fix {
  margin-left: 0;
  min-height: var(--control-sm);
}

/* 窗口监听：没有任务时也要让人看到「它还在盯着」，否则关掉页面就等于什么都没发生。
   这一行是那块板上唯一的新信息（上面已经说过「还没有排队的课程」了），
   所以给它强调色 —— 它是「引擎还活着」的证据 */
.listen-line {
  font-size: var(--fs-caption);
  color: var(--accent-strong);
  line-height: var(--lh-body);
  padding: var(--sp-4) 0;
}

.list {
  display: flex;
  flex-direction: column;
}

/* 志愿组头：小标题级，但读得出来 —— 「第 2 志愿在抢」是理解这份任务单的关键 */
.squad {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  padding: var(--sp-8) 0 var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.squad b {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.squad svg {
  color: var(--accent);
}

/* 组内的行往右缩一格，一眼看出「这些是一伙的」。
   2px 等于没缩 —— 组头与成员在视觉上连成一片，志愿组的边界只能靠读文字才知道。 */
.squad + .task {
  padding-left: var(--sp-14);
}

.ord {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-8);
}

.task {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  padding: var(--sp-10) 0;
}

.task + .task {
  border-top: 0.5px solid var(--line);
}

.body {
  min-width: 0;
  gap: var(--sp-2);
}

.line1 {
  gap: var(--sp-6);
  min-width: 0;
}

.name {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.meta {
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
  /* 这一行是「这一秒为什么没在打」的答案（第几次尝试、几秒后重试、教务的原话），
     它是任务行里唯一会解释沉默的东西 —— 不能是最淡的一档 */
  color: var(--text-2);
}

.chip {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  /* 中性档徽标（已取消 / 待命）也是**状态词**，不是装饰 ——
     原先的 --text-3 压 --surface-2 只有 2.3:1，等于这些状态读不出来 */
  color: var(--text-2);
}

.chip.run {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.chip.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.chip.warn {
  color: var(--warn-strong);
  background: var(--warn-soft);
}

.chip.bad {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

/* 终态行压暗：已经结束的事不该和正在抢的争注意力 */
.task.ok .name,
.task.bad .name,
.task.idle .name {
  color: var(--text-2);
}

.ops {
  flex: none;
  /* 16px 而不是 12px：每个按钮的命中区外扩 7px，相邻两个才不会互相压住
     （重合成 14px 时「取消」会偷走「暂停」的边缘，那比按钮小更糟） */
  gap: var(--sp-16);
}

.op {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 命中区撑到 44×44，但视觉尺寸不动 —— 这几个按钮是时间压力下最容易点错的那排，
   视觉上放大它们会挤掉任务行里的信息，扩命中区则两全（手机上是拇指在点）。
   间距同时从 4px 放到 12px：命中区外扩 7px 后相邻两个不会互相压住 —— 否则
   「取消」会偷走「暂停」右边缘那几像素，那比按钮小更糟。 */
.op::after {
  content: '';
  position: absolute;
  inset: -7px;
}

.op.danger {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.op:active {
  transform: scale(0.9);
}

.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  /* 行距留 18：每颗按钮的命中区纵向各外扩 7px，折行之后相邻两行才不会互相吃掉 */
  gap: var(--sp-18) var(--sp-14);
  padding-top: var(--sp-10);
  margin-top: var(--sp-4);
  border-top: 0.5px solid var(--line);
}

/* 这一排是 16px 高的文字按钮（原先实测 48×16 / 114×16），
   而它们里面有「全部暂停」这种一键改变全局的动作 —— 拇指按不准就等于按不到 */
.link {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-8) 0;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
}

.link::after {
  content: '';
  position: absolute;
  inset: -7px -4px;
}

.link.t-3 {
  color: var(--text-2);
}

/* AI 排障入口：平时不抢注意力（和「全部暂停」同档），出问题时它才是最有用的那个。
   `margin-left: auto` 把它推到右侧，与左边的操作分开，避免误点。 */
.link.ai {
  margin-left: auto;
  color: var(--accent-strong);
}
</style>
