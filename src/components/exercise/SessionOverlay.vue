<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { createLayout } from 'animejs'
import { ChevronDown, ChevronRight, ClockPlus, Coffee, Ellipsis, Gauge, Info, ListPlus, PlusCircle, Repeat, RotateCcw, SkipForward, Timer } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import CountdownOverlay from '@/components/common/CountdownOverlay.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import RingProgress from '@/components/common/RingProgress.vue'
import StatusChip from '@/components/common/StatusChip.vue'
// 这两块按需加载：肌群图本体是 160 KB 的解剖 SVG（三个视图 raw 内联）＋ 一处
// 只在点开动作详情时才出现的抽屉。它们是沉浸层**内部**的详情块，用户不开到那一屏
// 就用不到 —— 而沉浸层挂在 App 根上，静态 import 等于让每个路由都背着这 160 KB 首屏。
// 沉浸层自身的显隐与形变动画不受影响：这两个组件都渲染在 v-if 分支里。
const ExerciseDetailDrawer = defineAsyncComponent(
  () => import('@/components/exercise/ExerciseDetailDrawer.vue'),
)
const WeightAdviceSheet = defineAsyncComponent(
  () => import('@/components/exercise/WeightAdviceSheet.vue'),
)
const MuscleMap = defineAsyncComponent(() => import('@/components/exercise/MuscleMap.vue'))
import SessionBigNumberInput from '@/components/exercise/SessionBigNumberInput.vue'
import SessionStageBubble from '@/components/exercise/SessionStageBubble.vue'
import SessionCourseDrawer from '@/components/exercise/SessionCourseDrawer.vue'
import SessionExerciseSwapSheet from '@/components/exercise/SessionExerciseSwapSheet.vue'
import SessionGlassButton from '@/components/exercise/SessionGlassButton.vue'
import SessionSummaryPane from '@/components/exercise/SessionSummaryPane.vue'
import ReadinessDialog from '@/components/exercise/ReadinessDialog.vue'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useExercisePrefs } from '@/stores/exercisePrefs'
import { useSessionStore } from '@/stores/session'
import { usePressGlow } from '@/composables/usePressGlow'
import { useScrolled } from '@/composables/useScrolled'
import { motionOn, motionRich } from '@/system/motion'
import { perfDegraded } from '@/system/perf'
import { workoutRuntime } from '@/system/workoutRuntime'
import { useToast } from '@/composables/useToast'
import {
  closeImmersive,
  closeImmersiveNow,
  immersiveClosing,
  immersiveOpen,
  immersiveOpenSeq,
  immersiveOriginSnapshot,
  measureOriginNow,
  settleClosed,
  type ImmersiveOriginSnapshot,
} from '@/system/sessionImmersive'
import { setDurationSec } from '@/config/exerciseGuide'
import ExerciseGuideBlock from '@/components/exercise/ExerciseGuideBlock.vue'
import { fmtKg } from '@/utils/strength'
import type { SwapCandidate } from '@/types'

/**
 * 运动模式 · 训练课沉浸层（底部坞 × 组格矩阵）：覆盖整个窗口（含底部导航栏）。
 * 不再走路由：App.vue 常驻挂载本组件，由 system/sessionImmersive 驱动显隐——
 * 收起 / 恢复不触发整页卸载重建，与悬浮运动条之间做 container transform
 * 连续形变（从浮窗当前 rect 生长到全屏，任意吸附位同理）。
 * 结构：顶栏 → 全课分格进度条（每格一组，按动作分组留缝）→ 可滚动内容区
 * （动作名 hero ＋ 重量输入 ＋ 次数输入 ＋ 动作要点 ＋ 接下来）→ 常驻底部操作坞
 * （组格即完成控件；热身态为小重量激活格；休息态为时长抽屉图标＋跳过）。
 * 坞内「更多」菜单提供跳过当前组 / 临时休息 / 再加一组 / 上一组 / 临时更换本动作 / 当前动作详解。
 * 顶部组数胶囊（带 ›）唤起全课浏览抽屉：逐动作逐组浏览、跳至某组、临时更换未做的动作。
 * 重量 / 次数登记：数字可点，就地变成输入框用输入法键入；也可用 ± 步进微调。
 * 正式组与激活热身组都支持现场调整，完成组即落当前值，结束保存后展开为逐组记录
 * （重量曲线数据源）。只有「结束 → 二级确认」才结束会话。
 */
const s = useSessionStore()
/** 训练偏好：准备时长（设置 › 训练可改，气泡下一组立即生效） */
const prefs = useExercisePrefs()
const lib = useExerciseLibStore()
const router = useRouter()
const { toast } = useToast()

const endOpen = ref(false)
const restSheetOpen = ref(false)
const moreOpen = ref(false)
const detailOpen = ref(false)
const courseOpen = ref(false)
const swapOpen = ref(false)
/** 插入动作面板（末尾加一个动作，课程库不变） */
const insertOpen = ref(false)

/** bind 菜单锚定元素：坞内触发各菜单的图标钮；临时休息从更多菜单二级唤起，沿用更多钮位置 */
const moreAnchor = ref<HTMLElement | null>(null)
const restAnchor = ref<HTMLElement | null>(null)

function openMore(e: MouseEvent): void {
  moreAnchor.value = (e.currentTarget as HTMLElement) ?? null
  moreOpen.value = true
}

function openRestAdd(e: MouseEvent): void {
  restAnchor.value = (e.currentTarget as HTMLElement) ?? null
  restSheetOpen.value = true
}

/** 上次做组参照（渐进超负荷对照，按动作库 id 取） */
const lastRef = computed(() => s.lastWeights[s.currentEx?.exerciseId ?? ''])

/** 今日建议：平均状态（近 3 次 e1RM 加权）× 今日状态（恢复/容量/趋势/自评） */
const curAdvice = computed(() => (s.currentEx ? s.adviceFor(s.currentEx) : null))

/** 建议说明抽屉：摘要行只留一句话，RM 单位 / 完整依据 / 计算过程都收进抽屉
 *  （从前是内联展开，会把下方次数输入整个推开，打断登记流） */
const adviceOpen = ref(false)

/** 展示名：库内名优先（动作库改名全端跟随），回落课程条目快照 */
const displayName = computed(() => (s.currentEx ? lib.resolveName(s.currentEx) : ''))

/** 动作要点：课程条目优先，缺失回落库内要点 */
const exTips = computed(() => (s.currentEx ? lib.tipsOf(s.currentEx) : ''))

const WEIGHT_STEP = 2.5

/**
 * 当前动作的激活热身处方：按**当天的估算极限（e1RM）**实时换算，拿不到极限时
 * 回落按推荐重量（见 stores/session::warmupPlanFor）。课程里写死的 warmups 是最终回落，
 * 只在连工作重量都没有时用。推荐重量或极限一变（加档 / 降载 / 改自评），这里的重量
 * 与组数立刻跟着变。
 */
const curWarmupPlan = computed(() => (s.currentEx ? s.warmupPlanFor(s.currentEx) : null))

const curWarmups = computed(() => curWarmupPlan.value?.sets ?? [])

/** 当前待做的激活热身组（热身页据此预填并展示处方值） */
const curWarmup = computed(() => {
  const ex = s.currentEx
  const rx = curWarmups.value
  if (!ex || !rx.length) return null
  return rx[Math.min(s.warmupDone(ex), rx.length - 1)] ?? null
})

/**
 * 热身换算依据（热身页脚注）：写清「按**哪个**重量、什么比例、算出来多少」。
 * 基准有两种（估算极限 / 推荐重量），脚注必须跟着 `usedBaseline` 走 ——
 * 一律写「按推荐重量换算」在有极限时就是错的说法：乘的根本不是那个数。
 */
const warmupNote = computed(() => {
  const ex = s.currentEx
  const plan = curWarmupPlan.value
  const rx = plan?.sets ?? []
  if (!ex || !rx.length) return ''
  const w = s.workingWeightFor(ex)
  if (w <= 0) return ''
  // 实测比例会因取整偏离标称值（如 62.5kg 的 50% = 31.25 → 32.5），
  // 所以标称规则与换算结果一起给，免得用户以为算错了
  const based = plan!.usedBaseline ? (ex ? (s.adviceFor(ex)?.todayCeiling ?? 0) : 0) : w
  const nominal = plan!.usedBaseline
    ? rx.length > 1
      ? '50% / 70% 极限'
      : '50% 极限'
    : rx.length > 1
      ? '50% / 75%'
      : '50%'
  const out = rx.map((d) => `${fmtKg(d.weightKg)}×${d.reps}`).join(' → ')
  const basisText = plan!.usedBaseline
    ? `按当天估算极限 ${fmtKg(based)} kg 换算`
    : `按推荐重量 ${fmtKg(w)} kg 换算`
  return `${basisText}（${nominal}，取整到 2.5kg）：${out} · 不计入组数与总容量`
})

/** 结论行右侧那句指引：只负责指到数字的来处，具体换算收在 InfoHint 里 */
const warmupBasisText = computed(() => (curWarmupPlan.value?.usedBaseline ? '按估算极限换算' : '按推荐重量换算'))

/** 一键填入的重量候选：同一个重量的三个出处（今日建议 / 上次 / 计划），点一下即填入 */
interface FillSource {
  key: string
  caption: string
  value: string
  weight: number
  /** 主推来源（今日建议 / 热身处方）：在候选里抬起来，其余为备选参照 */
  recommended: boolean
}

const fillSources = computed<FillSource[]>(() => {
  const ex = s.currentEx
  if (!ex) return []
  // 热身页给的是这一组的激活重量处方，只有一个出处
  if (s.phase === 'warmup') {
    const w = curWarmup.value
    if (!w) return []
    return [{ key: 'warmup', caption: '热身组', value: `${fmtKg(w.weightKg)} kg × ${w.reps}`, weight: w.weightKg, recommended: true }]
  }
  const list: FillSource[] = []
  const advised = curAdvice.value?.suggestedWeight
  if (advised != null) {
    list.push({ key: 'advice', caption: '建议', value: `${fmtKg(advised)} kg`, weight: advised, recommended: true })
  }
  const last = lastRef.value
  if (last) {
    list.push({
      key: 'last',
      caption: '上次',
      value: last.reps != null ? `${fmtKg(last.weightKg)} kg × ${last.reps}` : `${fmtKg(last.weightKg)} kg`,
      weight: last.weightKg,
      recommended: false,
    })
  }
  if (ex.weightKg != null) {
    list.push({ key: 'plan', caption: '计划', value: `${fmtKg(ex.weightKg)} kg`, weight: ex.weightKg, recommended: false })
  }
  return list
})

/**
 * 重量回写：一律走 store action（直接改 s.weight 不会 touch()，快照不落盘）。
 * 输入框清空时组件给 null，此时保留原值，不让重量凭空变 0。
 */
function onWeight(v: number | null): void {
  if (v != null) s.setWeight(v)
}

/** 次数回写：清空表示「该动作没配次数」，允许置空由用户自行键入 */
function onReps(v: number | null): void {
  s.setReps(v)
}

/** 打开即接管：等运动系统运行时的启动接管完成，再从服务端恢复会话。
 *  已激活（收起后再展开）则原样展示；服务端也没有进行中的训练课 →
 *  原地关层（页面路由从未变化），跑步会话转去跑步路由。 */
watch(
  immersiveOpenSeq,
  async () => {
    await workoutRuntime.whenReady()
    if (s.phase !== 'idle') return
    const ok = await s.hydrateFromServer()
    if (!ok && s.phase === 'idle') {
      closeImmersiveNow()
      if (s.foreignRoute) void router.push(s.foreignRoute)
    }
  },
  { flush: 'post' },
)

/* ---------- 全课进度格条 ---------- */

/**
 * 顶栏占位高度：内容区据此留出顶部内边距。
 * 常量与 .ctrl-top 的版式一一对应（一行胶囊 --cap-h ＋ 上缘偏移 10 ＋ 下缘留白 16），
 * 两侧引用同一组数值，改版式时不会只剩一边更新。
 *
 * 进度轨退场后这条占位从 94 降到 62：从前栏里是「32 控件行 ＋ 24 进度轨」两行，
 * 现在只有一行胶囊 —— 内容区凭空多出的 32px 就是这次顶栏改版的直接收益之一。
 */
const TOP_OFFSET = 10
/**
 * 顶栏胶囊的高度。取 44 而不是 36：这三枚（收起 / 全课进度 / 结束）是沉浸层里**唯一**
 * 的一行入口，而 44 是全仓通行的触控命中区下限（步进钮 44、菜单项 44、抽屉关闭热区 44、
 * 浮条按钮 44）—— 36 是这一处唯一的例外。这里没有用「伪元素把热区撑到 44」那条路：
 * 胶囊的材质根是 GlassSurface，它带 `overflow: hidden`（折射层要按圆角裁），
 * 伪元素外扩会被它裁掉，撑不出来。所以直接把视觉高度本身抬到 44 ——
 * `--cap-h` 与 `topHeight` 共用这一个常量，内容区留白自动跟着走，不会只剩一边更新。
 */
const CAP_H = 44
const TOP_GAP = 16

const topHeight = computed(() => TOP_OFFSET + CAP_H + TOP_GAP)

/**
 * 同步失败警示的高度（没有警示时为 0）：顶簇是绝对定位的，得知道这一段被警示占了
 * 多高才能整块下移、不被它盖住。**必须量而不是写死**：那条信息里嵌着底层错误原文，
 * 窄屏上会折成两三行，任何"一行 26px"的常量都会在真机上错位。
 * ResizeObserver 在布局后、绘制前回调，所以纠正落在**同一帧**里，看不到跳动。
 */
const warnEl = ref<HTMLElement | null>(null)
const warnH = ref(0)
let warnRO: ResizeObserver | null = null

watch(warnEl, (el) => {
  warnRO?.disconnect()
  warnRO = null
  warnH.value = el ? el.offsetHeight : 0
  if (!el) return
  warnRO = new ResizeObserver(() => {
    warnH.value = el.offsetHeight
  })
  warnRO.observe(el)
})

onBeforeUnmount(() => warnRO?.disconnect())

/* ---------- 坞与内容派生 ---------- */

const dockMode = computed<'warmup' | 'exercise' | 'rest' | 'timed-ready' | 'timed' | 'summary' | 'none'>(() => {
  if (s.phase === 'warmup' && s.currentEx) return 'warmup'
  if (s.phase === 'exercise' && s.currentEx) return 'exercise'
  if (s.phase === 'rest') return 'rest'
  if (s.phase === 'timed-ready' && s.currentEx) return 'timed-ready'
  if (s.phase === 'timed-run') return 'timed'
  if (s.phase === 'summary') return 'summary'
  return 'none'
})

/**
 * 底簇占位高度：内容区据此留出底部内边距，让内容**从玻璃下面滚过去**
 * 而不是被玻璃挡住。数值必须与 .ctrl-dock 的实际高度一致，所以两条
 * 行高写成常量，样式里也只引用这两个常量。
 */
const DOCK_ROW_H = 54
/** 气泡轨高度：与 SessionStageBubble 的 .stagewrap 同高 */
const DOCK_TRACK_H = 52
const DOCK_GAP = 12

/** 气泡出现在热身 / 做组 / 组间休息三个阶段（计时与总结有自己的主体显示） */
const bubbleDock = computed(
  () => dockMode.value === 'warmup' || dockMode.value === 'exercise' || dockMode.value === 'rest',
)

const dockHeight = computed(() => {
  if (dockMode.value === 'none') return 0
  return (bubbleDock.value ? DOCK_TRACK_H + DOCK_GAP : 0) + DOCK_ROW_H
})

/* ---------- 灵动气泡（替代原来的组格轨） ----------
 * 组格只能在完成后告诉你结果，训练中真正需要的是「此刻该干什么」：
 * 准备姿势还剩几秒 / 第几个 / 该结束了。逐组进度仍在顶栏「n/N 组」胶囊与全课抽屉里。
 */

/** 当前动作的结构化详解（自建动作没有，界面回落 tips） */
const curGuide = computed(() => lib.guideOf(s.currentEx))

/** 当前这一组要做的次数（热身组取热身处方，正式组取现场次数） */
const curReps = computed<number | null>(() => {
  const ex = s.currentEx
  if (!ex) return null
  if (s.phase === 'warmup') return curWarmup.value?.reps ?? null
  return s.reps ?? ex.reps
})

/**
 * 单组预计动作秒数：力量 = 次数 × 每次循环秒数（内置动作的「AI 预填时长」），
 * 计时 / 有氧取各自处方秒数。拿不到任何处方时回落 40 秒兜底。
 */
const curSetSec = computed(() => {
  const ex = s.currentEx
  if (!ex) return 0
  return setDurationSec(curGuide.value, ex.kind, curReps.value, ex.targetSec, ex.durationMin)
})

/** 气泡的组序号 / 总组数：热身与正式组各用各的口径（热身不计入正式组数） */
const bubbleSetNo = computed(() => (s.phase === 'warmup' && s.currentEx ? s.warmupDone(s.currentEx) + 1 : s.setIndex))
const bubbleTotal = computed(() => {
  const ex = s.currentEx
  if (!ex) return 0
  return s.phase === 'warmup' ? curWarmups.value.length : s.effSets(ex)
})

/** 组标识：动作 / 相位 / 组号 / 热身完成数任一变化都重开一轮节拍 */
const bubbleToken = computed(() => {
  const ex = s.currentEx
  if (!ex) return 'none'
  const warm = s.phase === 'warmup' ? `w${s.warmupDone(ex)}` : ''
  return `${ex.id}:${s.phase}:${s.setIndex}:${warm}`
})

const nextEx = computed(() => s.plan?.exercises[s.exIndex + 1] ?? null)

/** 当前动作的肌群激活表（库内显式数据优先 → 课程条目 → 按动作名关键词；均无 → 隐藏卡片） */
const activation = computed(() => (s.currentEx ? lib.musclesOf(s.currentEx) : null))

/** 下一动作的处方摘要：单位按类型取（计时只认秒、有氧认分钟；次数带脏值时也不能顶掉秒） */
const nextExDesc = computed(() => {
  const n = nextEx.value
  if (!n) return ''
  const per =
    n.kind === 'timed'
      ? n.targetSec != null
        ? `${n.targetSec} 秒`
        : ''
      : n.kind === 'cardio'
        ? n.durationMin != null
          ? `${n.durationMin} 分钟`
          : ''
        : n.reps != null
          ? `${n.reps} 次`
          : ''
  return `${s.effSets(n)} 组${per ? ` · ${per}` : ''}`
})

const nextExName = computed(() => (nextEx.value ? lib.resolveName(nextEx.value) : ''))

/**
 * 休息屏 meta 行：eyebrow（位置更靠上）已经是状态名（临时休息 / 热身组间 / 组间休息），
 * 这里只留结论 —— 同一屏两个同义标签会把真正的差异信息淹掉。
 *
 * 下一组分支再拆一层主次：「第 N 组」是主数值（title3 + .num，setIndex 就是刚做完的
 * 那一组），次数与重量降为 caption 次要说明，中间用竖线分层。
 * 「下一组」前缀删掉：它与「第 N 组」指同一件事，写两遍读者要多花一步才读出主角。
 */
const restMeta = computed(() => {
  if (s.restWarmup) return { lead: '', rest: '准备下一次小重量激活' }
  if (s.restIsTemp) return { lead: '', rest: '结束后继续当前训练' }
  if (s.restTargetIsNextSet) {
    const bits: string[] = []
    if (s.reps != null) bits.push(`${s.reps} 次`)
    if (s.weight > 0) bits.push(`${fmtKg(s.weight)} kg`)
    return { lead: `第 ${s.setIndex + 1} 组`, rest: bits.join(' · ') }
  }
  return { lead: '', rest: `下一个 · ${nextExName.value}` }
})

const restSheetTitle = computed(() => `还要休息多久？剩余 ${s.restLeft} 秒`)

const REST_ADD_ACTIONS: MenuItem[] = [
  { label: '+ 15 秒', value: '15', icon: ClockPlus },
  { label: '+ 30 秒', value: '30', icon: ClockPlus },
  { label: '+ 60 秒', value: '60', icon: ClockPlus },
  { label: '+ 2 分钟', value: '120', icon: ClockPlus },
]

/* ---------- 更多菜单：临时休息 / 再加一组 / 上一组 / 当前动作详解 ---------- */

const MORE_TITLE = computed(() => `更多 · ${displayName.value || '训练中'}`)

/** 跳过当前组只在真正「手上有一组」的阶段出现：热身态有专门的跳过热身，休息态当前组已经做完了 */
const CAN_SKIP_PHASES = ['exercise', 'timed-ready', 'timed-run'] as const

const MORE_ACTIONS = computed<MenuItem[]>(() => {
  const list: MenuItem[] = []
  if (CAN_SKIP_PHASES.includes(s.phase as (typeof CAN_SKIP_PHASES)[number])) {
    list.push({ label: '跳过当前组', value: 'skip-set', icon: SkipForward })
  }
  list.push(
    // 临时休息：层叠二级菜单直接选时长；仅做组/计时阶段可用（热身、休息中置灰）
    { label: '临时休息', value: 'temp-rest', icon: Coffee, disabled: !CAN_SKIP_PHASES.includes(s.phase as (typeof CAN_SKIP_PHASES)[number]), children: TEMP_REST_ACTIONS },
    { label: '再加一组', value: 'extra-set', icon: PlusCircle },
    { label: '上一组（重做）', value: 'redo-last', icon: RotateCcw },
    { label: '今日状态', value: 'readiness', icon: Gauge, children: READINESS_ACTIONS },
    // 临时更换本动作：换动作是健身房里最高频的中断之一，可它此前只藏在
    // 「顶栏 n/N → 全课抽屉 → 找到当前动作 → 更换」四步之后。这里直通同一张
    // 选择面板（候选池仍是动作库内的同类型动作，处方按新动作的库内默认值）。
    ...(s.canSwapExercise(s.exIndex)
      ? [{ label: '临时更换本动作', value: 'swap', icon: Repeat }]
      : []),
    // 插入动作：这一场想再多做一个。与「加练一组」不是一件事 ——
    // 那个是把当前动作多做一组，这个是往这一场里加一个**新动作**（课程库不变）。
    // 结束后的总结屏不给它：会话已经收口，再插动作没有执行位。
    ...(s.phase !== 'summary' ? [{ label: '插入一个动作', value: 'insert', icon: ListPlus }] : []),
    { label: '当前动作详解', value: 'detail', icon: Info },
  )
  return list
})

/** 今日状态自评档位（写进快照，建议引擎据此修正今日处方） */
const READINESS_ACTIONS: MenuItem[] = [
  { label: '很好 · 精力充沛', value: '5', icon: Gauge },
  { label: '不错 · 状态在线', value: '4', icon: Gauge },
  { label: '一般 · 正常', value: '3', icon: Gauge },
  { label: '疲惫 · 有点顶', value: '2', icon: Gauge },
  { label: '很差 · 硬撑', value: '1', icon: Gauge },
  { label: '清除自评（纯自动推断）', value: 'clear', icon: Gauge },
]

/** 首次进入力量训练时的一次性自评入口（跳过即纯自动推断）：热身做完、第一正式组开做前才弹 */
const showReadinessPrompt = computed(
  () =>
    s.readiness === null &&
    !!s.currentEx &&
    s.currentEx.kind === 'strength' &&
    s.phase === 'exercise' &&
    s.doneCount === 0,
)

/* ---------- 今日状态对话框 ----------
 * 出现时机完全由 showReadinessPrompt 决定（首次进入力量训练、热身做完、还没自评、还没做第一组）：
 * 热身中不弹 —— 自评本就该在身体活动开之后答才准，也不打断热身节奏。
 *  · 一旦完成第一组（doneCount > 0）或离开该阶段，computed 变 false → 对话框自动收起。
 *    这是"打断"路径 —— 不强迫作答，但也不让它一直悬着挡视线；
 *  · 答过（选档或跳过）就记 readinessAsked，本次训练不再自动弹；
 *    「更多 → 今日状态」仍可随时改，两处写的是同一个 store 值，不会两套。
 * 它取代了原来各自嵌在热身/做组两组卡片里的内联 chips（同一件事写两遍，且说不清代价）。 */
const readinessAsked = ref(false)
const readinessOpen = ref(false)

watch(
  showReadinessPrompt,
  (show) => {
    if (show && !readinessAsked.value) readinessOpen.value = true
    else if (!show) readinessOpen.value = false
  },
  { immediate: true },
)

function onReadinessPick(v: number | null): void {
  readinessAsked.value = true
  readinessOpen.value = false
  s.setReadiness(v)
  if (v != null) toast('已记录今日状态 · 建议重量与练够分已同步')
}

/** 点遮罩 / 关闭键退出：记作"已问过"（避免每次进动作又弹），但**不写值** */
function onReadinessClose(): void {
  readinessAsked.value = true
  readinessOpen.value = false
}

/** 临时休息时长：作为更多菜单「临时休息」的层叠子菜单 */
const TEMP_REST_ACTIONS: MenuItem[] = [
  { label: '1 分钟', value: '1', icon: Timer },
  { label: '2 分钟', value: '2', icon: Timer },
  { label: '3 分钟', value: '3', icon: Timer },
  { label: '5 分钟', value: '5', icon: Timer },
  { label: '10 分钟', value: '10', icon: Timer },
]

/** 详解抽屉用的动作：组数展示为「计划 + 加练」后的实际值，热身也换成实时处方 */
const detailExercise = computed(() => {
  const e = s.currentEx
  return e ? { ...e, sets: s.effSets(e), warmups: s.warmupsFor(e) } : null
})

function onMorePick(value: string): void {
  if (value === 'skip-set') {
    // 跳过 = 未做 = 不统计：只推进流程，不写 doneSets
    if (s.skipCurrentSet()) toast('已跳过当前组 · 不计入统计')
    else toast('当前没有可跳过的组')
  } else if (value === 'extra-set') {
    const ex = s.currentEx
    if (!ex) return
    s.addExtraSet()
    toast(`已加练 1 组 · 「${ex.name}」共 ${s.effSets(ex)} 组`)
  } else if (value === 'redo-last') {
    if (!s.redoLastSet()) toast('还没有已完成的组')
  } else if (value === 'clear') {
    s.setReadiness(null)
    toast('已清除自评 · 建议按训练历史自动推断')
  } else if (value === '5' || value === '4' || value === '3' || value === '2' || value === '1') {
    s.setReadiness(Number(value))
    toast('已记录今日状态 · 建议重量已同步调整')
  } else if (value === 'swap') {
    swapOpen.value = true
  } else if (value === 'insert') {
    insertOpen.value = true
  } else if (value === 'detail') {
    detailOpen.value = true
  } else {
    // 临时休息子菜单：直接给分钟数
    const min = Number(value)
    if (Number.isFinite(min) && min > 0 && s.startTempRest(min)) toast(`临时休息 ${min} 分钟`)
  }
}

/** 换动作：与全课抽屉里那颗「更换」走同一条路径（同一张选择面板、同一个 store 方法） */
function onSwapPick(src: SwapCandidate): void {
  swapOpen.value = false
  if (s.swapExercise(s.exIndex, src)) toast(`已更换为「${src.name}」`)
  else toast('该动作已经做过，不能更换')
}

/**
 * 插入动作：往**这一场的末尾**加一个库内动作（课程库不变）。
 * 追加位置由 store 兜（不许插到当前动作之前 —— 那会让进度游标错位），
 * 这里只负责把「插到哪儿、药方是什么」如实回给用户：处方取库内默认值，
 * 轮到它时今日建议会把重量接上。
 */
function onInsertPick(src: SwapCandidate): void {
  insertOpen.value = false
  const at = s.insertExercise(src.exerciseId)
  if (at == null) {
    toast('插入失败：这一场已结束，或动作不可用')
    return
  }
  toast(`已插入「${src.name}」· 这一场第 ${at + 1} 个动作`)
}

/** 全课抽屉底部的「插入动作」：先收起抽屉再弹选择面板（两层抽屉叠着会互相遮） */
function onDrawerInsert(): void {
  courseOpen.value = false
  insertOpen.value = true
}

const restProgress = computed(() =>
  s.restTotal <= 0 ? 0 : Math.min(s.restLeft / s.restTotal, 1),
)

const timedText = computed(() => {
  const t = Math.floor(s.timedElapsed)
  const d = Math.floor((s.timedElapsed * 10) % 10)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.${d}`
})

const timedTargetText = computed(() => {
  const t = s.timedTotal
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
})

const timedProgress = computed(() =>
  s.timedTotal <= 0 ? 0 : Math.min(s.timedElapsed / s.timedTotal, 1),
)

/* ---------- 动作 ---------- */

function minimize(): void {
  // 播形变动画收回到悬浮条当前位置；页面路由不再变化（沉浸层与路由已解耦）
  closeImmersive()
}

function onEndPick(value: string): void {
  endOpen.value = false
  if (value === 'save') {
    void saveNow()
  } else if (value === 'discard') {
    void s
      .discard()
      .then(() => {
        toast('已放弃本次训练')
        closeImmersiveNow()
      })
      .catch((e: unknown) => {
        // 放弃失败：层与总结态保留，可原样再点（会话仍 active）
        toast(e instanceof Error ? e.message : '放弃失败，请重试')
      })
  }
}

function onRestAdd(value: string): void {
  s.addRest(Number(value))
}

async function saveNow(): Promise<void> {
  try {
    const r = await s.finishAndSave()
    if (r) toast(`已保存 ${r.done} 组 · 约 ${r.durationMin} 分钟 · ${r.kcal} 大卡`)
    // 会话已关闭、悬浮条随之消失：直接关层，不做形变动画
    closeImmersiveNow()
  } catch (e: unknown) {
    // 写库本身失败：层与总结态保留，按钮可再点（重试用同一 sessionId）
    toast(e instanceof Error ? e.message : '保存失败，请重试')
  }
}

/* ---------- container transform：悬浮条 ⇄ 全屏形变 ---------- */

const layerEl = ref<HTMLElement | null>(null)
const fadeEl = ref<HTMLElement | null>(null)

/* 丰富档的按压定向光晕：跟随手指位置的那一路反馈（另一路 scale 挤压各控件自带）。
   事件走整层委托，:active 决定亮不亮 —— 即时反馈等不得一个事件回调。 */
usePressGlow(layerEl, '.glow-layer')

/* 滚动边缘（丰富档）：内容滚离顶部即置位，CSS 据此浮起底坞的暗带。
 *
 * ⚠️ 探测点必须是**滚动容器内的后代**，不能把 ref 放在滚动框自己身上 ——
 * `useScrolled` 的解析是从 `el.parentElement` 起步的（它不看传入元素本身），
 * 而 `.scrollbody` 的父链（.session-page → .session-layer）两级的 overflow 都是 hidden，
 * 于是会一路解析到 window。训练中真正在滚的是 `.scrollbody`（window.scrollY 恒为 0），
 * `is-scrolled` 因此永不置位 —— 那条「内容滑到玻璃底下、影子变重」的浮起反馈等于没接上。
 * 挂到 `.rubber-layer`（滚动框的直接子元素）之后，父链第一跳就命中 `.scrollbody`。
 * 顺带解掉旧注释里那笔账：以前解析到文档，主页一滚它也跟着翻，所以模板处必须与
 * `immersiveOpen` 相与；现在解析结果与开合无关，那个相与仍留着（关层时不写类，
 * 语义更清楚），但不再是「防串台」的必需品。
 *
 * 这里只负责读：rAF 合并、值不变不写，开着时判定照旧。 */
const scrollProbeEl = ref<HTMLElement | null>(null)
const bodyScrolled = useScrolled(scrollProbeEl)

const EXPAND_MS = 480
const COLLAPSE_MS = 400
const EXPAND_MS_LOW = 360
const COLLAPSE_MS_LOW = 300

/** 形变锚点：无浮窗几何（课程页直接开课等）时兜底为屏幕中央卡片 */
function anchorFrom(s: ImmersiveOriginSnapshot | null): { rect: DOMRect; radius: number } {
  if (s) return s
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(300, vw * 0.6)
  return {
    rect: new DOMRect((vw - w) / 2, (vh - 120) / 2, w, 120),
    radius: 28,
  }
}

/* 形变走自管 rAF 逐帧插值（与 useDragDock 弹簧同模式），不用 WAAPI：
   平移与缩放必须各自线性插值，锚点才会匀速滑向悬浮条；WAAPI 对
   matrix/函数列表的插值策略不可控（矩阵分解会让块中途原地收缩）。
   cur 是当前形变态的唯一真源，打断即从现值继续，天然可反转。 */
interface MorphState {
  sx: number
  sy: number
  tx: number
  ty: number
  r: number
  fade: number
}

const IDENTITY = (): MorphState => ({ sx: 1, sy: 1, tx: 0, ty: 0, r: 0, fade: 1 })

let cur: MorphState = IDENTITY()
let morphRaf = 0
let morphFrom: MorphState | null = null
let morphTo: MorphState | null = null
let morphT0 = 0
let morphDur = 0
let morphDone: (() => void) | null = null

/** M3 emphasized 近似：起始快、收尾缓。二分求解 cubic-bezier 的进度映射 */
const easeAt = ((): ((x: number) => number) => {
  const X1 = 0.32
  const Y1 = 0.72
  const X2 = 0
  const Y2 = 1
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * X1 + 3 * (1 - t) * t * t * X2 + t ** 3
  const by = (t: number) => 3 * (1 - t) ** 2 * t * Y1 + 3 * (1 - t) * t * t * Y2 + t ** 3
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 12; i++) {
      const t = (lo + hi) / 2
      if (bx(t) < x) lo = t
      else hi = t
    }
    return by((lo + hi) / 2)
  }
})()

/** 最近一次写入的圆角（null=未知，''=已归零）——避免重复写同值触发无谓重绘 */
let writtenRadius: string | null = null

function writeMorph(m: MorphState, opts?: { skipRadius?: boolean }): void {
  const el = layerEl.value
  const fade = fadeEl.value
  if (!el || !fade) return
  cur = m
  if (m.sx === 1 && m.sy === 1 && m.tx === 0 && m.ty === 0 && m.r === 0) {
    el.style.transform = ''
    if (writtenRadius !== '') {
      el.style.borderRadius = ''
      writtenRadius = ''
    }
  } else {
    el.style.transform = `translate3d(${m.tx}px, ${m.ty}px, 0) scale(${m.sx}, ${m.sy})`
    // 圆角补偿：层被各向异性缩放，把目标圆角原样写在壳上，绘制出来会被
    // scale 压成扁椭圆——收起落位瞬间壳的四角与悬浮条的圆角对不上，展开
    // 途中屏幕四角还会豁出底页。这里反除以当前 scale 写成椭圆半径，绘制
    // 出来的视觉圆角恒等于 r；布局盒是全屏的，小锚点反算出的大写值装得
    // 下，不会被钳制。r≈0（全屏端）归零成方角，与屏幕边缘对齐。
    // 圆角是**绘制属性**：每写一次就整层重绘一次。真机实测这是手机掉帧的
    // 大头之一，所以逐帧写改成节拍写（stepMorph 每 N 帧放行一次，末帧精确
    // 补写），肉眼读不出 1/3 频率的圆角步进，代价却是 1/3。
    if (!opts?.skipRadius) {
      const radius = m.r <= 0.01 ? '0px' : `${(m.r / m.sx).toFixed(2)}px / ${(m.r / m.sy).toFixed(2)}px`
      if (radius !== writtenRadius) {
        el.style.borderRadius = radius
        writtenRadius = radius
      }
    }
  }
  fade.style.opacity = String(m.fade)
  fade.style.visibility = m.fade <= 0.001 ? 'hidden' : 'visible'
}

function stopMorph(): void {
  if (morphRaf) cancelAnimationFrame(morphRaf)
  morphRaf = 0
  morphFrom = null
  morphTo = null
  morphDone = null
  // 无论正常收尾还是中途打断，都恢复毛玻璃材质。圆角不在这里清：它归
  // writeMorph 逐帧管——落位溶解期壳还要带着悬浮条的圆角淡出，在这里清了
  // 会在溶解段变回方角；恒等归位统一走 writeMorph(IDENTITY())。
  layerEl.value?.classList.remove('is-morphing')
}

/* ---- 形变调试日志（默认静默）：控制台执行
   localStorage.setItem('reinMorphDebug','1') 后刷新/下一次开合生效，
   输出锚点取值、优先级决策与形变首末帧的屏幕坐标，真机远程调试可读；
   关闭：localStorage.removeItem('reinMorphDebug') ---- */
let morphDebugOn = false
let morphFrameLogged = false
function debugMorph(label: string, data: Record<string, unknown>): void {
  if (!morphDebugOn) return
  const rect = (el: Element | null | undefined) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: +b.left.toFixed(1), y: +b.top.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }
  }
  console.warn(`[morph] ${label}`, JSON.stringify({ ...data, layer: rect(layerEl.value), dockPos: rect(document.querySelector('.dock-pos')) }))
}

let morphTick = 0
const RADIUS_WRITE_EVERY = 3

function stepMorph(now: number): void {
  if (!morphFrom || !morphTo) return
  const p = easeAt(Math.min(1, (now - morphT0) / morphDur))
  morphTick += 1
  const lp = (a: number, b: number) => a + (b - a) * p
  // 收起方向的内容淡出走前段加速的独立进度：壳还在收缩早期就把内容
  // 淡干净，避免「微缩快照」残影。展开向延后到末段 8% 才浮现——壳先长到
  // 近 1:1 内容再出现（阈值同见 contentThreshold）：内容在非 1:1 缩放下
  // 每帧都会被重新栅格化，真机实测这是开合掉到 15fps 的最大一笔。
  const pf = morphTo.fade < morphFrom.fade ? Math.min(1, p * 2.5) : Math.max(0, (p - 0.92) / 0.08)
  const lpf = (a: number, b: number) => a + (b - a) * pf
  writeMorph({
    sx: lp(morphFrom.sx, morphTo.sx),
    sy: lp(morphFrom.sy, morphTo.sy),
    tx: lp(morphFrom.tx, morphTo.tx),
    ty: lp(morphFrom.ty, morphTo.ty),
    // 圆角与几何同步插值（从前冻结在起点值上）：全屏端为 0，锚点端为
    // 悬浮条圆角，绘制值由 writeMorph 做 scale 补偿
    r: lp(morphFrom.r, morphTo.r),
    fade: lpf(morphFrom.fade, morphTo.fade),
  }, { skipRadius: p < 1 && morphTick % RADIUS_WRITE_EVERY !== 1 })
  // 可见性阈值与展开向的淡入起点对齐（0.92 ≈ 壳长到 99% 缩放的时刻）；
  // 收起向沿用「恒隐藏」快速淡出。丰富档的内容块另有编舞（CONTENT_ENTER_AT
  // 同样锚在这个时刻之后），画布走同一套阈值。
  const contentThreshold = morphTo.fade > morphFrom.fade ? 0.92 : 2
  fadeEl.value!.style.visibility = p < contentThreshold ? 'hidden' : 'visible'
  if (!morphFrameLogged) {
    morphFrameLogged = true
    debugMorph('firstFrame', { p: +p.toFixed(3), cur: { ...cur, sx: +cur.sx.toFixed(4), sy: +cur.sy.toFixed(4), tx: +cur.tx.toFixed(1), ty: +cur.ty.toFixed(1), r: +cur.r.toFixed(1), fade: +cur.fade.toFixed(3) } })
  }
  if (p >= 1) {
    debugMorph('lastFrame', { cur: { ...cur, sx: +cur.sx.toFixed(4), sy: +cur.sy.toFixed(4), tx: +cur.tx.toFixed(1), ty: +cur.ty.toFixed(1), r: +cur.r.toFixed(1) } })
    const done = morphDone
    stopMorph()
    done?.()
    return
  }
  morphRaf = requestAnimationFrame(stepMorph)
}

/** 从 from 向 to 逐帧插值；动效关掉时直接落到 to */
function morphRun(from: MorphState, to: MorphState, dur: number, done?: () => void): void {
  stopMorph()
  const brief = (m: MorphState) => ({ sx: +m.sx.toFixed(4), sy: +m.sy.toFixed(4), tx: +m.tx.toFixed(1), ty: +m.ty.toFixed(1), r: +m.r.toFixed(1), fade: +m.fade.toFixed(3) })
  debugMorph('run', { from: brief(from), to: brief(to), dur })
  if (!motionOn.value) {
    prepareMorphShell()
    writeMorph(to)
    stopMorph()
    done?.()
    return
  }
  morphFrameLogged = false
  morphTick = 0
  prepareMorphShell()
  if (to.fade <= from.fade) fadeEl.value!.style.visibility = 'hidden'
  morphFrom = { ...from }
  morphTo = { ...to }
  morphT0 = performance.now()
  morphDur = dur
  morphDone = done ?? null
  morphRaf = requestAnimationFrame(stepMorph)
}

function prepareMorphShell(): void {
  const layer = layerEl.value
  if (!layer) return
  // 圆角不在这里预写（从前预写成锚点圆角，全屏壳会先以圆角态露一帧，四角
  // 豁出底页）——起始帧就该是全屏方角，之后每帧由 writeMorph 按 scale 补偿。
  layer.classList.add('is-open', 'is-morphing')
}

/* ---- 丰富档 · 内容编舞（animejs layout 的 modal-dialog 用法）----
   默认档的内容进出是画布一次性淡入淡出（成本最低）。丰富档按 animejs
   modal-dialog 的那套方法换掉它：顶栏 / 底坞 / 内容屏作为布局子元素登记进
   createLayout，进出各走一次 update()——子元素从 enterFrom（下移＋透明）
   逐个交错入场，离场反向汇出。它动画的是每个子元素自己的位置与透明度
   （FLIP），没有整屏缩放带来的文字拉伸，这就是文档里「子元素的位置与
   透明度自动动画」的细节来源。子元素必须先离场（display:none）再由
   update 的回调放回，enter/leave 状态才会生效；显隐全部走命令式直改，
   不经 Vue（record→mutate→animate 的契约要求 DOM 变更同步发生在回调里）。 */
type ContentLayout = ReturnType<typeof createLayout>

/** 每个内容块一个独立 layout 实例，**root = 块自身**。两个源码级约束：
 *  ① 实例的 inline-style 捕获/恢复会横扫 root 子树全部节点（newState.forEachRootNode），
 *  root 同为画布的多实例会互相把别人的块恢复成捕获时的 display:none（0.5.8 白屏的
 *  第二根因：pane 反复「显形→被藏」）；root 收窄到块自身后互不越界。
 *  ② root 本身恒为 target（源码 "Root node are always targets"），块 display none→''
 *  即触发 enter/leave，enterFrom/leaveTo 直接作用于块。
 *  另外动画终点是 update 回调后的**自然态**——绝不能预先垫 opacity/transform
 *  内联值，否则终点被毒化成初值（0.5.8 白屏的第一根因：内容停在 opacity:0）。 */
const contentLayouts = new WeakMap<HTMLElement, ContentLayout>()
const CONTENT_SELECTORS = ['.ctrl-top', '.pane', '.ctrl-dock']
let contentTimers: number[] = []
let contentAnims: { cancel?: () => void }[] = []

/** 展开向：内容块等壳长到近 1:1 才逐个入场（既是防压扁，也是防内容在
 *  非等比缩放下被逐帧重栅格——430ms 时形变已到 ~99.7%，内容栅格一笔不亏） */
const CONTENT_ENTER_AT = 430
const CONTENT_ENTER_MS = 260
const CONTENT_ENTER_GAP = 50
/** 收起向：内容块先逐个汇出，壳体随后才收缩 */
const CONTENT_LEAVE_MS = 140
const CONTENT_LEAVE_GAP = 20
const CONTENT_SHELL_DELAY = 130

/** WAAPI 的 easing 是字符串直解析、var() 不被替换，故把令牌值读一次缓存 */
const EASE_OUT = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'cubic-bezier(0.33, 1, 0.68, 1)'

function layoutFor(el: HTMLElement): ContentLayout {
  let layout = contentLayouts.get(el)
  if (!layout) {
    layout = createLayout(el, {
      ease: 'out(3)',
      enterFrom: { opacity: 0, translateY: 16 },
      leaveTo: { opacity: 0, translateY: 10 },
    })
    contentLayouts.set(el, layout)
  }
  return layout
}

function contentEls(): HTMLElement[] {
  const root = fadeEl.value
  if (!root) return []
  const els: HTMLElement[] = []
  for (const sel of CONTENT_SELECTORS) els.push(...root.querySelectorAll<HTMLElement>(sel))
  return els
}

/** 打断内容编舞：方向反打时先停掉在飞的 enter/leave 与待触发的调度 */
function cancelContentChoreo(): void {
  for (const t of contentTimers) clearTimeout(t)
  contentTimers = []
  for (const a of contentAnims) a?.cancel?.()
  contentAnims = []
}

/** 丰富档内容块逐个入场：槽位将启前才按选择器**现查元素**——开课时 pane/底坞
 *  会晚于 prep 随会话水合才挂载，调度期捕获的引用会变成死元素（0.5.8 白屏的
 *  第三根因）。只接管**被 prep 藏过**的块（display none→'' 才是 enter）；晚挂载
 *  的块走自身 fadeUp，不拉进编舞。编舞失败就立刻显形：宁缺动画，不能白屏。 */
function choreoContentEnter(): void {
  CONTENT_SELECTORS.forEach((sel, i) => {
    contentTimers.push(
      window.setTimeout(() => {
        if (!immersiveOpen.value || immersiveClosing.value) return
        const el = fadeEl.value?.querySelector<HTMLElement>(sel)
        if (!el || el.style.display !== 'none') return
        try {
          const anim = layoutFor(el).update(() => { el.style.display = '' }, { duration: CONTENT_ENTER_MS })
          if (anim) contentAnims.push(anim as { cancel?: () => void })
        } catch {
          el.style.display = ''
        }
      }, CONTENT_ENTER_AT + i * CONTENT_ENTER_GAP),
    )
  })
}

/** 收起向：三块依次轻微下移＋淡出（20ms 交错）。这里刻意**不走 animejs
 *  layout**：离场没有 FLIP 可言（块只是原地淡出），而 layout.update 的记录/
 * 测量会在肌群图那棵大子树上强制一次布局——真机实测单帧 ~50ms×倍率，就是
 * 收起开头的卡顿帧。WAAPI 直写只动合成属性，代价落在合成器。 */
function choreoContentLeave(): void {
  const els = contentEls()
  els.forEach((el, i) => {
    try {
      const anim = el.animate(
        [
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(10px)' },
        ],
        {
          duration: CONTENT_LEAVE_MS,
          delay: i * CONTENT_LEAVE_GAP,
          easing: EASE_OUT,
          fill: 'backwards',
        },
      )
      contentAnims.push(anim as unknown as { cancel?: () => void })
      const hide = () => {
        el.style.display = 'none'
      }
      anim.addEventListener('finish', hide)
      anim.addEventListener('cancel', hide)
    } catch {
      el.style.display = 'none'
    }
  })
}

/* ---- 落位溶解 ----
   收起伏贴到悬浮条 rect 后（含补偿过的同款圆角），壳面原地短淡出让位给
   底下原位的悬浮条——closing 起浮条就已就位，壳与浮窗同位同角，视觉上是
   同一块材质交棒。取代「壳凭空消失 → 浮窗/壳元素再各自滑入」的两段式：
   那两段位移正是返回动画对不上的根源。 */
const SETTLE_FADE_MS = 130
let settleTimer = 0

function settleWithFade(): void {
  const layer = layerEl.value
  if (!layer || !motionOn.value) {
    writeMorph(IDENTITY())
    settleClosed()
    return
  }
  layer.classList.add('is-settling')
  settleClosed()
  settleTimer = window.setTimeout(() => {
    settleTimer = 0
    writeMorph(IDENTITY())
    layer.classList.remove('is-settling')
  }, SETTLE_FADE_MS + 30)
}

function playExpand(): void {
  if (!layerEl.value || !fadeEl.value) return
  // 打断落位溶解 / 内容编舞：清掉待执行的归位与在飞的 enter/leave，
  // 从当前（悬浮条 rect）直接接续展开
  if (settleTimer) {
    clearTimeout(settleTimer)
    settleTimer = 0
    layerEl.value.classList.remove('is-settling')
  }
  cancelContentChoreo()
  morphDebugOn = !!localStorage.getItem('reinMorphDebug')
  const richExpand = motionRich.value && !!fadeEl.value
  // 内容块显形权归各档编舞：默认档恒可见；丰富档先收起（display:none），
  // 由各块自己的 layout enter 动画接手显形。清一遍再收，保证从任何前一态出发都干净。
  const els = contentEls()
  for (const el of els) el.style.display = richExpand ? 'none' : ''
  const presetSnap = immersiveOriginSnapshot()
  prepareMorphShell()
  fadeEl.value.style.visibility = 'hidden'
  debugMorph('expand:req', {
    explicit: presetSnap?.explicit ?? false,
    snapshot: presetSnap ? { x: +presetSnap.rect.left.toFixed(1), y: +presetSnap.rect.top.toFixed(1), w: +presetSnap.rect.width.toFixed(1), h: +presetSnap.rect.height.toFixed(1), r: presetSnap.radius } : null,
  })
  if (presetSnap) {
    const preset = morphStateOf(presetSnap.rect, presetSnap.radius)
    preset.fade = 0
    writeMorph(preset)
  }
  requestAnimationFrame(() => {
    if (!immersiveOpen.value || !layerEl.value || !fadeEl.value) return
    // 锚点优先级：显式锚（开课按钮等）恒用打开时快照——浮窗在会话开始后
    // 立即出现，若被「现量浮窗」覆盖，块会从底部而非用户点击处长出；
    // 无显式锚（从浮窗打开 / 收起途中反打）才现量优先，量不到落回快照
    const snap = immersiveOriginSnapshot()
    const anchor = snap ?? measureOriginNow()
    debugMorph('expand:anchor', {
      source: anchor?.explicit ? 'snapshot(显式锚)' : anchor ? 'snapshot(打开时测量)' : 'fallback(中央兜底)',
      rect: anchor ? { x: +anchor.rect.left.toFixed(1), y: +anchor.rect.top.toFixed(1), w: +anchor.rect.width.toFixed(1), h: +anchor.rect.height.toFixed(1) } : null,
      radius: anchor?.radius ?? null,
    })
    const { rect, radius } = anchorFrom(anchor)
    // 内容与不透明底随形变淡入：形变初期只见材质壳长大，内容随后浮现
    // （形变中断后的反向展开从当前透明度接续，不闪跳）
    const from = morphStateOf(rect, radius)
    from.fade = cur.fade < 1 ? cur.fade : 0
    morphRun(from, IDENTITY(), perfDegraded.value ? EXPAND_MS_LOW : EXPAND_MS)
    if (richExpand) choreoContentEnter()
  })
}

/** rect + 圆角 → 形变态。scale 分母用层自身布局尺寸（inset:0 的实际
 *  渲染宽高）而非 innerWidth/innerHeight——桌面端常驻滚动条会让后者
 *  偏大，起点块随之偏窄且中心错位 */
function morphStateOf(rect: DOMRect, radius: number): MorphState {
  const el = layerEl.value!
  // 层未完成布局时（offsetWidth 为 0）回退视口尺寸，避免 scale 出 NaN
  // 导致 transform 写入被浏览器拒绝——动画整段失效、层无过渡直接出现
  const w = el.offsetWidth || window.innerWidth
  const h = el.offsetHeight || window.innerHeight
  return {
    sx: rect.width / w,
    sy: rect.height / h,
    tx: rect.left,
    ty: rect.top,
    r: radius,
    fade: cur.fade,
  }
}

function playCollapse(): void {
  if (!layerEl.value || !fadeEl.value) return
  cancelContentChoreo()
  const rich = motionRich.value && !!fadeEl.value
  // closing 驱动的浮窗 v-show 可能晚一拍才 patch 生效：先等一帧再量锚点，
  // 否则量到 display:none 的零矩形会掉进中央卡片兜底（轨迹跳向屏幕中部）。
  // 层在等待帧内保持全屏静止，视觉无感；若期间状态被打断则静默放弃。
  requestAnimationFrame(() => {
    if (!immersiveClosing.value || !layerEl.value || !fadeEl.value) return
    const anchor = measureOriginNow()
    debugMorph('collapse:anchor', {
      rect: anchor ? { x: +anchor.rect.left.toFixed(1), y: +anchor.rect.top.toFixed(1), w: +anchor.rect.width.toFixed(1), h: +anchor.rect.height.toFixed(1) } : 'fallback(中央兜底)',
      radius: anchor?.radius ?? null,
    })
    const { rect, radius } = anchorFrom(anchor)
    // 收缩到悬浮条 rect：内容快速淡出，材质壳滑回原位与浮窗同位接续；
    // 收尾走落位溶解（壳面原地淡出、交棒给底下原位的浮条），不再凭空消失
    const to = { ...morphStateOf(rect, radius), fade: 0 }
    const dur = perfDegraded.value ? COLLAPSE_MS_LOW : COLLAPSE_MS
    if (rich) {
      // 丰富档：内容块先逐个汇出，壳体稍后才收缩——内容不会跟着壳一起被
      // 压成微缩快照。壳的启动用 setTimeout 推迟，期间被打断则静默放弃
      //（展开已在跑）。
      choreoContentLeave()
      window.setTimeout(() => {
        if (!immersiveClosing.value || !layerEl.value || !fadeEl.value) return
        morphRun({ ...cur }, to, dur, () => settleWithFade())
      }, CONTENT_SHELL_DELAY)
    } else {
      morphRun({ ...cur }, to, dur, () => settleWithFade())
    }
  })
}

// flush:'post' 是锚点正确性的关键：展开时层已随 v-show 显示、收起时悬浮条
// 已先恢复显示（closing 驱动），此刻量 rect 才是真实位置——pre 时机量到
// display:none 的零矩形，会掉进「屏幕中央卡片」兜底、形变锚点跳到屏幕中央
watch(immersiveOpenSeq, () => playExpand(), { flush: 'post' })
watch(immersiveClosing, (closing) => {
  if (closing) playCollapse()
}, { flush: 'post' })
/**
 * 开层把焦点移进层内、关层归还。
 *
 * 为什么必须有：本层开层时就是 role="dialog" + aria-modal="true"（见模板），
 * 而无障碍的模态语义要求焦点**落在模态内部** —— 否则键盘用户按 Tab 会从层外的
 * 页面元素开始走，读屏用户也不知道"现在到了一个对话框"。
 * 反过来，关层后本层被 aria-hidden，焦点若还留在里面就成了「焦点在 aria-hidden 元素上」
 * ——两边都不成立的那一格，所以关闭时必须把焦点还回开层前那个元素。
 * 元素在开层期间已被卸载（`isConnected` 为假）时就退回 blur，同样不留悬空焦点。
 */
let focusBeforeOpen: HTMLElement | null = null

watch(immersiveOpen, (open) => {
  if (open) {
    const active = document.activeElement
    focusBeforeOpen = active instanceof HTMLElement ? active : null
    // preventScroll：聚焦一个大容器不该顺带把底下的页面滚一下
    layerEl.value?.focus({ preventScroll: true })
    return
  }
  layerEl.value?.classList.remove('is-open')
  stopMorph()
  const back = focusBeforeOpen
  focusBeforeOpen = null
  if (back?.isConnected) back.focus({ preventScroll: true })
  else if (layerEl.value?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
})

/**
 * 焦点陷阱：`aria-modal` 只在**无障碍语义**上让读屏忽略背景，它拦不住 Tab ——
 * 键盘用户依然能把焦点一路移到被盖住的页面元素上（「看不见但点得到」，
 * 比没有模态语义更糟）。这里把 Tab 收在层内循环。
 *
 * 只认**可见且可聚焦**的元素：层里挂着一批 v-show 收纳的子层（抽屉 / 弹窗 / 建议面板），
 * display:none 的那些 offsetParent 为 null，不能进循环 —— 否则焦点会掉进隐藏面板。
 * 一个可聚焦元素都没有时把焦点留在层本身（层是 tabindex="-1" 的容器，不会掉出窗口）。
 */
function trapFocus(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !immersiveOpen.value) return
  const root = layerEl.value
  if (!root) return
  const nodes = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  const items = Array.from(nodes).filter((el) => el.offsetParent !== null)
  if (items.length === 0) {
    e.preventDefault()
    root.focus({ preventScroll: true })
    return
  }
  const first = items[0]!
  const last = items[items.length - 1]!
  const active = document.activeElement
  const inside = active instanceof HTMLElement && root.contains(active)
  if (e.shiftKey && (!inside || active === first || active === root)) {
    e.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault()
    first.focus({ preventScroll: true })
  }
}
</script>

<template>
  <!-- 沉浸层根：形变壳（transform/border-radius 由 container transform 动画驱动，静止恒为全屏）。
       无障碍语义：**开层时**才是 role="dialog" + aria-modal，关层时整层 aria-hidden ——
       本层是常驻挂载的（收起只是 opacity:0 + pointer-events:none，不卸载），
       若把 role/aria-modal 常挂上去，无障碍树里会始终存在一个看不见的 dialog，
       读屏用户在没开课时也能"进"到里面去。tabindex="-1" 只为程序化聚焦（见脚本里的
       focusBeforeOpen）：开层把焦点带进来、关层还回去，焦点不会停在一个 aria-hidden 的元素上。 -->
  <div
    ref="layerEl"
    class="session-layer"
    tabindex="-1"
    @keydown="trapFocus"
    :role="immersiveOpen ? 'dialog' : undefined"
    :aria-modal="immersiveOpen ? 'true' : undefined"
    :aria-label="immersiveOpen ? '训练课' : undefined"
    :aria-hidden="immersiveOpen ? undefined : 'true'"
  >
    <!-- 内容画布 + 浮起的控制层。派生的 --dock-h 让内容区知道底簇占了多高，
         内容因此从玻璃**下面**滚过（玻璃才有东西可采样），而不是被玻璃切掉。 -->
    <div
      ref="fadeEl"
      class="session-page"
      :class="{ 'is-scrolled': bodyScrolled && immersiveOpen }"
      :style="{
        '--dock-h': `${dockHeight}px`,
        '--top-h': `${topHeight}px`,
        '--warn-h': `${warnH}px`,
        '--cap-h': `${CAP_H}px`,
        '--imm-btn-h': `${DOCK_ROW_H}px`,
      }"
    >
      <!-- 同步失败警示：留在页面流首位（**不是**滚动区里），所以永远不会被浮起的顶簇
           盖住；它占的高度由 ResizeObserver 量成 --warn-h，顶簇据此整体下移同样的距离，
           内容区（在它之后的流里）自然也让出这一段。
           保存/放弃失败（finishError）优先展示：它比快照失败更需要用户在原位重试。 -->
      <p v-if="s.finishError || s.persistError" ref="warnEl" class="warn">
        {{ s.finishError ? `⚠ 结束失败：${s.finishError}` : `⚠ 进度同步失败：${s.persistError}` }}
      </p>

      <!-- 内容区（内容层：全程不透明，不参与玻璃）。上下缘用遮罩渐隐而不是硬边：
           滚到玻璃底下的内容「溶解」进背景，而不是被一条横线切断。
           两簇玻璃是它的绝对定位兄弟 —— 内容因此从玻璃**下面**滚过（玻璃才有东西
           可采样），而不是被夹在两条不透明玻璃条之间。 -->
      <main class="scrollbody">
        <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 滚动框站住，只有 item 位移
             （system/rubberScroll）。各态的 .pane 都留在层内：它们带 fadeUp 入场动画，
             自己不能当层（会与动画抢同一个 transform）。 -->
        <div ref="scrollProbeEl" class="rubber-layer" data-rubber-content>
          <!-- 激活热身：小重量找发力感 / 复合动作渐进 ramp-up -->
          <div v-if="s.phase === 'warmup' && s.currentEx" class="pane col center">
            <p class="eyebrow">激活热身 · 第 {{ s.warmupDone(s.currentEx) + 1 }} / {{ curWarmups.length }} 组</p>
            <h1 class="actname">{{ displayName }}</h1>
            <p class="meta">先用小重量激活目标肌群与动作模式，找发力感后再上正式重量</p>
            <div class="wlist">
              <span
                v-for="(wd, i) in curWarmups"
                :key="i"
                class="wstep num"
                :class="{ done: i < s.warmupDone(s.currentEx!), cur: i === s.warmupDone(s.currentEx!) }"
              >
                {{ i < s.warmupDone(s.currentEx!) ? '✓' : '' }} {{ fmtKg(wd.weightKg) }} kg × {{ wd.reps }}
              </span>
            </div>

            <!-- 本组登记：小重量找发力感，重量可现场调整，完成即按实际重量登记 -->
            <div class="setcard">
              <!-- 今日状态自评已升格为「今日状态」对话框（ReadinessDialog）：它会改
                   建议重量与练够分，代价说不清就不该藏在卡片里当一行小字。
                   自动弹窗等热身做完（第一正式组前）才出现；要改也仍在「更多 → 今日状态」。 -->

              <div class="field">
                <span class="flabel">重量</span>
                <SessionBigNumberInput
                  :model-value="s.weight"
                  label="热身重量"
                  unit="kg"
                  :step="WEIGHT_STEP"
                  :precision="1"
                  :max="999"
                  @update:model-value="onWeight"
                />
              </div>

              <div v-if="fillSources.length" class="qfill">
                <button
                  v-for="f in fillSources"
                  :key="f.key"
                  type="button"
                  class="qseg"
                  :class="{ rec: f.recommended }"
                  :aria-label="`填入${f.caption}重量 ${f.value}`"
                  @click="onWeight(f.weight)"
                >
                  <span class="qcap">{{ f.caption }}</span>
                  <span class="qval num">{{ f.value }}</span>
                </button>
              </div>

              <!-- 热身换算依据：卡面只留结论胶囊 + 一行基准指引，
                   「按哪个比例、取整到多少、逐组算出什么」收进右侧 InfoHint ——
                   11px 灰字承载不了那种换算说明，真机上几乎读不清，用户会以为重量算错。
                   指引句必须写出**这一份处方实际用的基准**（估算极限 / 推荐重量），
                   而不是固定写「按推荐重量换算」：有极限时乘的就是极限，固定文案会说谎
                   （e2e-session-warmup.mjs 断言 .whint 指到数字的来处）。
                   本卡本来没有标题行，帮助入口就落在结论行右端（aria-label 由
                   InfoHint 自己保证，见 STANDARDS §4）。 -->
              <div v-if="warmupNote" class="whint-row">
                <p class="whint">
                  <StatusChip tone="neutral" size="sm">热身组不计入组数与总容量</StatusChip>
                  <span class="wbasis">{{ warmupBasisText }}</span>
                </p>
                <InfoHint title="热身重量怎么换算" :content="warmupNote" />
              </div>
              <p v-else class="whint">热身组不计入组数与总容量，重量可按需调整</p>
            </div>

            <div v-if="activation" class="blockcard">
              <h3>肌群激活</h3>
              <MuscleMap :activation="activation" interactive />
            </div>

            <!-- 要点：内置动作给结构化三段（准备 / 轨迹 / 注意），自建动作回落库里一句话 -->
            <div v-if="curGuide" class="blockcard">
              <h3>动作要点</h3>
              <ExerciseGuideBlock :guide="curGuide" density="compact" />
            </div>
            <div v-else-if="exTips" class="blockcard">
              <h3>动作要点</h3>
              <p>{{ exTips }}</p>
            </div>
          </div>

          <!-- 动作中：名称 hero ＋ 重量输入 ＋ 次数输入 ＋ 要点 ＋ 接下来 -->
          <div v-else-if="s.phase === 'exercise' && s.currentEx" class="pane col center">
            <p class="eyebrow">当前动作 · 第 {{ s.setIndex }} / {{ s.effSets(s.currentEx) }} 组</p>
            <h1 class="actname">{{ displayName }}</h1>

            <!-- 本组登记（重量 ＋ 次数同卡同构）：数字可点键入，± 微调；完成本组即记录当前值。
                 这两行是同一组记录的两个字段，之前分开在两处（重量在卡里、次数裸在卡外当大字），
                 视觉上像两件不相干的事，中间还夹着今日状态那张卡，谁主谁次读不出来 -->
            <div class="setcard">
              <!-- 今日状态自评见 ReadinessDialog（首次进入力量训练、热身做完后的那张对话框）；
                   这里只留重量与次数，两者是同一组记录的两个字段 -->
              <div class="field">
                <span class="flabel">重量</span>
                <SessionBigNumberInput
                  :model-value="s.weight"
                  label="重量"
                  unit="kg"
                  :step="WEIGHT_STEP"
                  :precision="1"
                  :max="999"
                  @update:model-value="onWeight"
                />
              </div>

              <!-- 一键填入：建议 / 上次 / 计划三个出处等宽并列，点一下即填入。
                   等宽是为了让「同一个值的三个候选」这层关系读得出来 —— 从前三个
                   宽度不一的胶囊各自飘着，加上重量本身，五个数字挤在一张卡里没有主次 -->
              <div v-if="fillSources.length" class="qfill">
                <button
                  v-for="f in fillSources"
                  :key="f.key"
                  type="button"
                  class="qseg"
                  :class="{ rec: f.recommended }"
                  :aria-label="`填入${f.caption}重量 ${f.value}`"
                  @click="onWeight(f.weight)"
                >
                  <span class="qcap">{{ f.caption }}</span>
                  <span class="qval num">{{ f.value }}</span>
                </button>
              </div>

              <!-- 建议依据：一行摘要，点开抽屉看完整推导（RM 单位 / 依据 / 计算过程）。
                   箭头用 ›（去抽屉）而非 ⌄（原地展开），指向与行为一致 -->
              <button
                v-if="curAdvice?.rationale.length"
                class="whydis"
                aria-label="查看建议的完整依据与计算过程"
                @click="adviceOpen = true"
              >
                <span class="whytxt">{{ curAdvice?.rationale[0] }}</span>
                <ChevronRight :size="14" />
              </button>

              <div class="fsep" />

              <!-- 次数：同样可点键入，登记的是实际完成次数（与计划不同也能如实记录） -->
              <div class="field">
                <span class="flabel">次数</span>
                <SessionBigNumberInput
                  :model-value="s.reps"
                  label="次数"
                  unit="次"
                  :step="1"
                  :max="999"
                  @update:model-value="onReps"
                />
              </div>
            </div>

            <div v-if="activation" class="blockcard">
              <h3>肌群激活</h3>
              <MuscleMap :activation="activation" interactive />
            </div>

            <div v-if="curGuide" class="blockcard">
              <h3>动作要点</h3>
              <ExerciseGuideBlock :guide="curGuide" density="compact" />
            </div>
            <div v-else-if="exTips" class="blockcard">
              <h3>动作要点</h3>
              <p>{{ exTips }}</p>
            </div>

            <div v-if="nextEx" class="blockcard">
              <h3>接下来</h3>
              <!-- 标题已交代「接下来」，正文不再写「下一动作」前缀，也不放 ▸：
                   一行里两个同义前缀，读者要多花一步才看出主角是动作名 -->
              <p class="nextrow">
                <b>{{ nextExName }}</b>
                <span>{{ nextExDesc }}</span>
              </p>
            </div>
          </div>

          <!-- 组间休息：青环倒数（临时休息/热身组间同视图，结束后回到对应流程） -->
          <div v-else-if="s.phase === 'rest'" class="pane col center">
            <p class="eyebrow">{{ s.restIsTemp ? '临时休息' : s.restWarmup ? '热身组间' : '组间休息' }}</p>
            <RingProgress :value="restProgress" color-var="--c-balance" :size="216" :stroke="13">
              <b class="num restnum" role="timer" aria-label="休息倒计时">{{ s.restLeft }}</b>
              <span class="restsec">秒</span>
            </RingProgress>
            <p class="meta" :class="{ 'meta-lead': restMeta.lead }">
              <b v-if="restMeta.lead" class="num rlead">{{ restMeta.lead }}</b>
              <i v-if="restMeta.lead && restMeta.rest" class="rsep" aria-hidden="true" />
              <span v-if="restMeta.rest">{{ restMeta.rest }}</span>
            </p>

            <!-- 组间休息正是「抬头看下一步怎么做」的时机：把刚做完那个动作的要点留在屏上 -->
            <div v-if="curGuide" class="blockcard">
              <h3>{{ displayName }} · 动作要点</h3>
              <ExerciseGuideBlock :guide="curGuide" density="compact" />
            </div>
          </div>

          <!-- 计时动作准备 -->
          <div v-else-if="s.phase === 'timed-ready' && s.currentEx" class="pane col center">
            <p class="eyebrow">{{ s.currentEx.kind === 'cardio' ? '有氧计时' : '计时动作' }}</p>
            <h1 class="actname">{{ displayName }}</h1>
            <p class="meta">
              目标
              {{ s.currentEx.kind === 'timed' ? `${s.currentEx.targetSec} 秒 × ${s.effSets(s.currentEx)} 组` : `${s.currentEx.durationMin} 分钟` }}
              <template v-if="s.currentEx.kind === 'timed'"> · 组间休息 {{ s.currentEx.restSec }} 秒</template>
            </p>
            <div v-if="activation" class="blockcard">
              <h3>肌群激活</h3>
              <MuscleMap :activation="activation" interactive />
            </div>
            <p class="hint">准备好后，点下方「我准备好了」开始倒数</p>
          </div>

          <!-- 计时进行中 -->
          <div v-else-if="s.phase === 'timed-run'" class="pane col center">
            <RingProgress :value="timedProgress" color-var="--c-intake" :size="248" :stroke="15">
              <b class="num timernum" role="timer" aria-label="已用时">{{ timedText }}</b>
              <span class="hint">目标 {{ timedTargetText }}</span>
            </RingProgress>
          </div>

          <!-- 总结：成绩单交给独立组件（完成环 / 四项指标 / 进步 / 逐动作明细 /
               肌群 / 下次建议）。这一屏的内容量已超过一屏，逻辑与版式都不适合
               再塞进本组件 —— 它已 1800 行，且总结的派生口径集中在
               utils/sessionSummary，组件只做呈现。底簇仍是保存/放弃（同其它阶段）。 -->
          <SessionSummaryPane v-else-if="s.phase === 'summary'" />
        </div>
      </main>

      <!-- 顶栏：**三块并列的玻璃**，中间夹状态显示 —— 收起一枚胶囊、结束一枚胶囊，
           组数状态居中。苹果对文字按钮的规矩是「让它坐在自己的容器里」：从前两枚是
           裸文字、只有中间那颗有底，三者的层级在版式上读不出来。
           整课进度不再占第二行：逐组明细在全课抽屉里，栏上只留「n/N 组」这条状态 ——
           苹果的做法是「层级靠版式与分组表达，能去掉的就去掉」，而不是同一条栏里
           叠两层进度。三块各自是独立的玻璃体，并排不叠压（同 Dock 的语言）。 -->
      <header class="ctrl-top">
        <SessionGlassButton h="var(--cap-h)">
          <button class="cbtn min" aria-label="收起运动模式" @click="minimize">
            <ChevronDown :size="18" /> 收起
          </button>
        </SessionGlassButton>

        <SessionGlassButton h="var(--cap-h)">
          <button class="cbtn pcapsule" aria-label="查看全课程进度" @click="courseOpen = true">
            <span class="num">{{ s.doneCount }}/{{ s.totalCount }}</span>
            <span class="punit">组</span>
            <ChevronRight :size="13" class="chev" />
          </button>
        </SessionGlassButton>

        <!-- 结束是这条栏里唯一的「主行动」：苹果的规矩是它单独着色（tinted）当焦点，
             其余留中性 —— 所以色落在字上，不把整颗胶囊染红 -->
        <SessionGlassButton h="var(--cap-h)">
          <button class="cbtn end" @click="endOpen = true">结束</button>
        </SessionGlassButton>
      </header>

      <!-- 底簇：组格轨（热身态=重量格，做组态=组矩阵）＋ 一行并排的独立控件。
           两行各自都是**并排的独立块**，不是嵌套 —— 轨内的组格是填充（fill），
           不再是第二层玻璃（苹果明令禁止 glass on glass）。
           主行动是实底、独立于玻璃之外：这是这一步唯一的主行动，不能被半透明削弱。 -->
      <div v-if="dockMode !== 'none'" class="ctrl-dock col">
        <!-- 组格轨：一块玻璃，轨内的组格是**填充**（fill），不是第二层玻璃 ——
             苹果明令禁止 glass on glass；GlassSurface 的折射因此作用在整条轨上，
             组格与缝隙里的内容从它底下滚过时才真的被折射（不是只糊一层）。 -->
        <!-- 灵动气泡：热身 / 做组 / 组间休息三态共用一条，颜色与闪频表达阶段。
             逐组完成靠下方主按钮（气泡不再兼作完成控件）。 -->
        <SessionStageBubble
          v-if="bubbleDock"
          :token="bubbleToken"
          :kind="dockMode === 'rest' ? 'rest' : 'set'"
          :set-no="bubbleSetNo"
          :total-sets="bubbleTotal"
          :set-sec="curSetSec"
          :reps="curReps"
          :rest-left="s.restLeft"
          :prep-sec="prefs.prepSec"
          :warmup="dockMode === 'warmup'"
          :active="s.phase !== 'summary'"
          @tap="s.skipRest()"
        />

        <div class="drow row">
          <template v-if="dockMode === 'warmup'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <SessionGlassButton h="var(--imm-btn-h)">
              <button class="ghost" @click="s.skipWarmup()">跳过热身</button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.completeWarmup()">完成热身组</button>
          </template>

          <template v-else-if="dockMode === 'exercise'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.completeSet()">完成第 {{ s.setIndex }} 组</button>
          </template>

          <template v-else-if="dockMode === 'rest'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="调整休息时长" @click="openRestAdd($event)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="13.5" r="7.5" />
                  <path d="M11 13.5V9.5" />
                  <path d="M9 2.5h4" />
                  <path d="M18.5 4.5h4" />
                  <path d="M20.5 2.5v4" />
                </svg>
              </button>
            </SessionGlassButton>
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.skipRest()">
              {{ s.restIsTemp ? '继续训练' : s.restTargetIsNextSet ? '跳过休息' : '开始下一动作' }}
            </button>
          </template>

          <!-- 计时准备：主行动与其它阶段同槽同位（从前它是内容区里一颗 216px 的玻璃大圆，
               既占掉最多的玻璃面积、又让它随内容一起滚走） -->
          <template v-else-if="dockMode === 'timed-ready'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <button class="primary flex-1 glow-layer" @click="s.prepareTimed()">我准备好了</button>
          </template>

          <template v-else-if="dockMode === 'timed'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <SessionGlassButton h="var(--imm-btn-h)">
              <!-- 放弃未完成的事：浅灰次按钮（与实底主行动「完成」拉开层级），
                   不铺危险色——红色留给确认层里那枚真破坏项 -->
              <button class="ghost" @click="s.abortTimed()">放弃</button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.finishTimed()">完成</button>
          </template>

          <!-- 总结：保存是本阶段唯一的主行动，与「放弃不保存」并排（同 timed 的
               放弃 + 完成）。从前它俩在内容区居中飘着 —— 全页只有这一阶段的动作
               不在底簇里，既够不着拇指，也和别的阶段不是一个地方 -->
          <template v-else-if="dockMode === 'summary'">
            <SessionGlassButton h="var(--imm-btn-h)">
              <!-- 同 timed 的「放弃」：放弃未完成的事走浅灰次按钮，实底主按钮是「保存训练」 -->
              <button class="ghost" @click="endOpen = true">放弃不保存</button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="saveNow">保存训练</button>
          </template>
        </div>
      </div>

      <!-- 覆盖层：闪现提示 / 3·2·1 倒数 -->
      <CountdownOverlay
        :show="s.overlay.show"
        :label="s.overlay.label"
        :sub="s.overlay.sub"
        :count-from="s.overlay.countFrom"
        @done="s.onOverlayDone()"
      />

      <!-- 今日状态对话框：进入力量训练时问一次（会改建议重量与练够分，见组件头注释） -->
      <ReadinessDialog
        :open="readinessOpen"
        :value="s.readiness"
        @pick="onReadinessPick"
        @close="onReadinessClose"
      />

      <!-- 结束（二级确认）：只有这里才算正常结束。
           标题说后果不说规定：写清「放弃」具体丢什么、「结束并保存」留下什么 -->
      <ActionSheet
        :open="endOpen"
        title="放弃会丢失本次训练已做的全部组数；结束并保存则留下这次记录"
        :actions="[
          { label: '结束并保存', value: 'save' },
          { label: '放弃本次训练（不保存）', value: 'discard', danger: true },
        ]"
        @select="onEndPick"
        @close="endOpen = false"
      />

      <!-- 休息时长加时菜单：图标钮唤起 -->
      <AppMenu
        :open="restSheetOpen"
        :title="restSheetTitle"
        :actions="REST_ADD_ACTIONS"
        :anchor="restAnchor"
        @select="onRestAdd"
        @close="restSheetOpen = false"
      />

      <!-- 更多菜单：临时休息 / 再加一组 / 上一组 / 当前动作详解 -->
      <AppMenu
        :open="moreOpen"
        :title="MORE_TITLE"
        :actions="MORE_ACTIONS"
        :anchor="moreAnchor"
        @select="onMorePick"
        @close="moreOpen = false"
      />

      <!-- 当前动作详解 -->
      <ExerciseDetailDrawer :open="detailOpen" :exercise="detailExercise" @close="detailOpen = false" />

      <!-- 全课浏览抽屉：逐组进度 / 跳至该组 / 临时换动作 / 末尾插入动作 -->
      <SessionCourseDrawer :open="courseOpen" @close="courseOpen = false" @insert="onDrawerInsert" />

      <!-- 临时更换本动作（更多菜单直通）：候选池 = 动作库内的同类型动作 -->
      <SessionExerciseSwapSheet
        :open="swapOpen"
        :kind="s.currentEx?.kind ?? 'strength'"
        :current-id="s.currentEx?.exerciseId ?? ''"
        @pick="onSwapPick"
        @close="swapOpen = false"
      />

      <!-- 插入动作（更多菜单 / 全课抽屉直通）：类型自己选，处方取库内默认值 -->
      <SessionExerciseSwapSheet
        :open="insertOpen"
        mode="insert"
        @pick="onInsertPick"
        @close="insertOpen = false"
      />

      <!-- 重量建议说明抽屉：RM 单位 / 本次依据 / 四步计算过程 -->
      <WeightAdviceSheet
        :open="adviceOpen"
        :advice="curAdvice"
        :exercise-name="displayName"
        @close="adviceOpen = false"
      />
    </div>
  </div>
</template>

<style scoped>
/* 沉浸层根（形变壳）：transform/border-radius 由 container transform 动画驱动，
   静止时恒为全屏恒等。**壳不是玻璃** —— 静止时它整块被 .session-page 盖住，
   形变期又是逐帧缩放（blur + 逐帧 transform 正是 Android WebView 合成器最易
   冻结的组合，原先这里那条全屏 backdrop-filter 既拿不到任何折射、又白付一次
   全视口采样）。壳只留一个不透明表面色给形变首帧用，投影让块在生长中仍有分量。
   刻意不写 will-change：常驻合成层提升会把层冻在动画中途（真机实测：半透明
   残影叠在真实 UI 上），手写 rAF 每帧写 transform 自带提升，无需常驻提示。 */
.session-layer {
  position: fixed;
  inset: 0;
  z-index: 80; /* 覆盖 TabBar(60) 与全部页面内容 */
  overflow: hidden;
  contain: layout paint;
  transform-origin: 0 0;
  opacity: 0;
  pointer-events: none;
  box-shadow: var(--shadow-float);
  background: var(--surface);
}

.session-layer.is-open {
  opacity: 1;
  pointer-events: auto;
}

/* 沉浸层自己不是可交互控件：程序化聚焦只为把键盘 / 读屏的焦点带进层内，
   不给它画焦点环（层内按钮、抽屉、输入框各自的焦点环不受影响）。 */
.session-layer:focus,
.session-layer:focus-visible {
  outline: none;
}

/* 落位溶解：收起到位后壳面原地短淡出（层还停在悬浮条的 rect 上），交棒给
   底下原位的悬浮条。过渡只在这一态声明——is-open 的摘除在其余场合都必须
   瞬时（展开起点、打断接续），不能被这里的过渡拖出渐隐。130ms 与脚本里
   SETTLE_FADE_MS 同源，改时两处一起动。 */
.session-layer.is-settling {
  transition: opacity 130ms var(--ease-out);
}

/* 形变进行中：控制层的玻璃退成**近材质**而不是纯透明——令牌换成实底 + 常规描边，
   这样即使折射被摘掉，顶栏/底簇仍是可读的一层，而不是空掉。形变期整个层在逐帧
   缩放，每多一块 backdrop-filter 就多一处重采样（折射那一路尤其贵）。
   .bubble（SessionStageBubble 的玻璃胶囊）同属这一层，一并摘掉。 */
.session-layer.is-morphing :deep(.sgbtn),
.session-layer.is-morphing :deep(.bubble) {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  transition: none !important;
  background: var(--surface);
  border-color: var(--line);
  box-shadow: none;
}

/* 淡入层：不透明底 + 全部内容的统一 opacity 载体——形变初期只见材质壳
   长大，内容随后浮现；收起时先淡出内容再缩回，压扁过程不可见。
   底部安全区在这里处理：底簇按它上浮，内容区也据它留出末段内边距。 */
.session-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  /* 层定位不随 .app-frame 偏移，顶部/底部安全区自行处理 */
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
}

/* ---------- 控制层 · 顶栏 ----------
   苹果对控制层的要求是**浮起、内缩、圆角、内容从底下滚过去**，外加「文字按钮要坐在
   自己的容器里」。所以这条栏是三块**并列的独立玻璃**：收起一枚胶囊、结束一枚胶囊、
   组数状态居中 —— 三块各自带受光边、并排留缝、互不叠压（叠压会在缝上出现月牙硬边，
   与 Dock 三块是同一条结论）。

   材质归 GlassSurface（超高 / 极致折射，其余档位退成毛玻璃，弱档顶成实底）：
   从前这条栏挂的是 .glass-surface —— 它只有 backdrop-filter，超高下**也只是糊**，
   拿不到任何折射。几何归这里，材质归组件，两边不重复定义同一件事。

   同心：胶囊是**独立控件**（不在任何玻璃里面），所以 --radius-full 成立；
   栏内不再有需要同心的嵌套层（进度轨退场后，「内圈 = 外圈 − 内边距」这条约束随之消失）。 */
.ctrl-top {
  position: absolute;
  /* 绝对定位的包含块是 .session-page 的 padding box，而 padding 不会把 padding box
     边界推下来 —— 安全区因此得在这里自己加上，不能指望父层的 padding-top。
     `--warn-h` 是同步失败警示实占的高度（无警示时 0）：整条栏让开它，否则会被盖住。 */
  top: calc(var(--safe-top) + 10px + var(--warn-h));
  /* 左右各留余量：Android 手势导航在屏幕两缘留返回手势带，停靠元素要整体收进带外
     （--safe-left 已含 20px 兜底），这里再叠 6px 呼吸空间。 */
  inset-inline: calc(var(--safe-left) + 6px);
  z-index: 2;
  max-width: var(--frame-max);
  margin-inline: auto;
  /* 三栏等分：左右各占一份、中间那格按内容宽 —— 中间那颗因此是**数学居中**的
     （两侧宽度不等时 space-between 会让它偏，而苹果对这种情形的态度是「能居中就居中」）。
     两枚胶囊靠边对齐，格宽不参与伸缩：胶囊的宽度只由「字 + 自己的内边距」决定 ——
     从前这里的按钮被拉伸成 134px 的隐形命中区（点空白处会把训练收起来）。 */
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--gap-sm);
}

.ctrl-top > :first-child {
  justify-self: start;
}

.ctrl-top > :last-child {
  justify-self: end;
}

/* 胶囊里那颗按钮：内边距归它（玻璃跟着内容走，宽度天然就是「字 + 这个内边距」），
   按压反馈也加在它身上 —— 它是玻璃的**后代**，缩放不会动到玻璃自己那块背景根
   （GlassSurface 的折射靠 backdrop-filter，祖先带 transform / filter 会把它废掉）。 */
.ctrl-top .min,
.ctrl-top .end,
.ctrl-top .pcapsule {
  height: 100%;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-full);
  font-size: var(--fs-subhead);
  color: var(--text-1);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.ctrl-top .min {
  gap: var(--gap-text);
  padding: 0 var(--sp-14) 0 var(--sp-10);
  font-weight: var(--fw-semibold);
}

/* 组数状态：点开全课抽屉。它是这条栏里唯一的「读数」，所以数字给最重的字重、
   「组」与箭头退到次级色 —— 层级靠前景，不靠再叠一层底。 */
.ctrl-top .pcapsule {
  gap: var(--gap-text);
  padding: 0 var(--sp-10) 0 var(--sp-14);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

/* 结束是这条栏唯一的「主行动」：苹果的规矩是它单独着色（tinted）当焦点 ——
   色落在字上（不把整颗胶囊染红），按压时才给一层 soft 反馈。 */
.ctrl-top .end {
  padding: 0 var(--sp-14);
  font-weight: var(--fw-bold);
  color: var(--danger-strong);
}

.ctrl-top .min:active,
.ctrl-top .end:active,
.ctrl-top .pcapsule:active {
  transform: scale(1.04, 0.92);
  transition: transform 120ms var(--ease-out);
}

.ctrl-top .end:active {
  background: var(--danger-soft);
}

.punit {
  margin-right: var(--sp-2);
}

.pcapsule .chev {
  color: var(--text-3);
}

/* 同步失败警示：它是页面 flex 列的第一行，而顶簇是绝对定位的 —— 从前两者互不知情，
   一有同步失败，警示就被那块玻璃整个盖住（审查实测：警示在 y=0..24，顶簇在 10..78）。
   现在顶簇的 top 加上 `--warn-h`（见脚本里的 ResizeObserver），整条让开这一段；
   内容区在它之后的流里，自然也让出同样的高度，于是"警示 → 顶簇 → 内容"的次序
   在任何高度下都成立，不需要写死任何一行的像素数。
   底走 --warn-soft（不再是手搓 color-mix：tokens.css 已把这档收成一份令牌，
   原先散落在各组件里），字走 --warn-strong —— 实底档 --warn 不当文字用。 */
.warn {
  flex: none;
  /* 警示条与内容区同宽（左右 16），不然只在出错的这一屏突然内缩一圈。 */
  margin: 0 var(--pad-sheet);
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-s);
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  background: var(--warn-soft);
}

/* ---------- 内容层 ----------
   内容铺满整块舞台并**从两簇玻璃底下滚过去**（这是玻璃能采样到东西、而不是当装饰
   的前提）。上下留出两簇的占位高度，于是静止时首屏内容正好落在玻璃下缘之外。

   上下缘用一条**遮罩渐隐**而不是硬边：滚到玻璃底下的内容在进入玻璃之前就溶解进背景，
   而不是被玻璃的边缘切成一条横线（苹果的 Scroll Edge Effect —— 「把内容溶解进背景」，
   它不遮挡、也不压暗；从前这里是一条压暗的暗带，方向正好是反的）。
   遮罩是纯合成器操作，代价约等于零，且不产生背景根。

   渐隐段的长度**取自浮层实际盖住的区域**（这是苹果对这条效果的定度：效果铺满
   固定控件与它下面那块 accessory view 的高度）：
     · 下缘 = 底簇占位 + 26（那 26 正是内容末段的内边距，见 padding-bottom）——
       于是滚到底时最后一屏正文正好落在**完全不透明**的那条线上，不会被自己的渐隐吃掉；
       而滚过底簇的内容全程处在渐隐里，组格上的数字因此始终读得清。
     · 上缘只需抹掉视口顶缘那条硬边（顶簇里没有需要压在内容上读的字），34 就够。 */
.scrollbody {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: var(--top-h);
  /* 与下面的渐隐同值：正文的终点 = 完全不透明的那条线 */
  padding-bottom: calc(var(--dock-h) + var(--sp-26));
  --edge-fade-top: 34px;
  --edge-fade-bottom: calc(var(--dock-h) + 26px);
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--edge-fade-top),
    #000 calc(100% - var(--edge-fade-bottom)),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--edge-fade-top),
    #000 calc(100% - var(--edge-fade-bottom)),
    transparent 100%
  );
}

/* 超范围平移层：撑满滚动框（min-height:100%），让内容不足一屏时 .pane 仍能居中；
   内容超一屏时按内容撑高，滚动与原来一致。只承载 transform，不改观感。 */
.rubber-layer {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.pane {
  /* 原来是 min-height:100%（百分比落在 auto 高的包裹层上会失效），改用 flex:1：
     在包裹层里等价地撑满，且内容超一屏时按内容撑高 */
  flex: 1;
  /* 内容区左右收成 16（--pad-sheet），与顶簇胶囊、底簇按钮同一条竖线；
     原来 26 比同一屏的控制层还宽，正文边缘与按钮边缘对不齐。 */
  gap: var(--gap-md);
  padding: var(--sp-24) var(--pad-sheet);
  /* 与丰富档 CONTENT_ENTER_MS=260 同档：组间切换每天数十次，420ms 跟不上手速 */
  animation: fadeUp var(--dur-base) var(--ease-standard);
}

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}

.eyebrow {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.6px;
  color: var(--text-3);
}

.actname {
  /* 40px 就是 --fs-display-m 这一档：阶梯外禁止裸字号，且桌面壳调字号阶梯时这处要跟随 */
  font-size: var(--fs-display-m);
  font-weight: var(--fw-bold);
  letter-spacing: -1px;
  line-height: 1.1;
  text-align: center;
}

.meta {
  max-width: 330px;
  text-align: center;
  font-size: var(--fs-subhead);
  color: var(--text-2);
  line-height: var(--lh-body);
}

/* 下一组分支：主数值「第 N 组」与次要说明（次数 · 重量）同行分层。
   字档压在 title3 不再往上 —— 休息屏的焦点是中央那枚 76px 的环，这条 meta 是它的
   注脚，再大一档就反过来跟环抢主角了。 */
.meta-lead {
  display: flex;
  align-items: baseline;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}

.rlead {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 竖线分隔：主数值与次要说明是两层，不用同一个「·」串成一锅 */
.rsep {
  flex: none;
  width: 1px;
  height: 13px;
  background: var(--line-strong);
  align-self: center;
}

/* 次要项（次数 · 重量）：降为 caption / --text-3 —— 主数值已是 title3 / --text-1，
   同一行两档之间必须读得出主次（无主次时整行仍是 .meta 的 subhead / --text-2） */
.meta-lead span {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 本组登记卡：重量与次数同卡同构 —— 标签定宽在左、± 分列两端、数值居中，
   两行因此左右严格对齐，读起来是一张表，而不是几块拼图。
   今日状态（首次进入时的一次性自评）也收进这张卡：它是建议重量的输入，
   单开一张卡夹在重量与次数之间，等于把「一组记录」切成了两半。

   材质：**内容层，不是玻璃**。苹果的分层是内容层 —— 导航层 —— 覆盖层三层，
   玻璃只属于中间那层；把表格这类内容做成玻璃，它会和别的元素抢注意力、把层级
   搅浑（原话：making it Liquid Glass would make it compete with other elements
   and muddy the hierarchy）。这里还有两个本地理由：① 它宽 min(360px) 几乎贴满
   内容区，玻璃面积与成本都最大；② 它要从底簇玻璃**下面**滚过去，自己再是玻璃
   就成了玻璃叠玻璃。所以内容层用的是「实底 + 轻投影」这套全仓通用的 .card 语汇。 */
.setcard {
  width: min(360px, 100%);
  /* 走 .card 那一档几何（半径 16 / 内距 16）：注释里就说它是「全仓通用的 .card 语汇」，
     而 20 / 14 让它比页面上的卡片大一号、内距少一号。 */
  border-radius: var(--radius-m);
  padding: var(--pad-card);
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
}

/* 标签定宽：两行的 ± 与数值因此落在同一条竖线上 */
.flabel {
  flex: none;
  width: 32px;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.field > :deep(.biginput) {
  flex: 1;
  min-width: 0;
}

/* 重量块与次数之间的分格线 */
.fsep {
  height: 0;
  border-top: 0.5px solid var(--line);
}

/* 热身结论行：结论胶囊 + 换算指引 + 右侧帮助入口一行排开。
   指引句比胶囊再轻一档，只负责指到数字的来处；换算说明整段收进 InfoHint ——
   11px 灰字读不清那种信息密度 */
.whint-row {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.whint {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.wbasis {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 一键填入：建议 / 上次 / 计划 等宽并列（同一个重量的三个出处） */
.qfill {
  display: flex;
  /* 分段控件的段间 4（规范：段间 2–4），原来 6 让三格像三颗独立胶囊 */
  gap: var(--gap-tight);
  padding: var(--sp-4);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.qseg {
  flex: 1;
  min-width: 0;
  padding: var(--sp-6) var(--sp-4);
  /* 同心：外轨 16 − 轨道内距 4 = 12（原来减 3 的裸值，格子与轨道角差 1px 会露边） */
  border-radius: calc(var(--radius-m) - var(--sp-4));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-text);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.qseg:active {
  transform: scale(0.96);
}

.qcap {
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  white-space: nowrap;
}

.qval {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  white-space: nowrap;
}

/* 主推来源（今日建议 / 热身处方）在候选里抬起来。刻意不用主色实底：
   它是「可以填进去」的候选，不是已经生效的状态，实底会与完成态的绿撞语义 */
.qseg.rec {
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
}

.qseg.rec .qval {
  /* 候选值是数值：中性色（色彩配额，STANDARDS §4）。主推候选的「抬起来」
     由白底 + 投影承担，不靠给文字上色。 */
  color: var(--text-1);
}

/* 建议依据：全宽左对齐的展开行（从前是居中飘着的一行小字，看不出可点） */
.whydis {
  width: 100%;
  /* 命中区撑到 44：这是建议抽屉的唯一入口，而 caption 字号让整行只有约 18 高 ——
     全屏里点得最多的入口配最小的热区。整行本来就是通栏，加高不像其它胶囊那样动观感。 */
  min-height: var(--hit-min);
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  color: var(--text-3);
  font-size: var(--fs-caption);
  text-align: left;
}

.whytxt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.whydis svg {
  flex: none;
}

/* 热身清单步骤 chips */
.wlist {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--gap-sm);
}

.wstep {
  padding: var(--sp-6) var(--sp-14);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.wstep.cur {
  background: var(--text-1);
  color: var(--bg);
  /* 呼吸循环已删：它引用的 keyframes 全仓没有定义（静默失效），而当前步 chip 本就是
     整列最强的反色、信息已足；无限循环还会与形变的 rAF 抢帧。 */
}

.wstep.done {
  background: var(--c-exercise-soft);
  /* 「✓ 60 kg × 10」是登记值：数值中性色，色相留在 soft 底的色块上（色彩配额，STANDARDS §4） */
  color: var(--text-1);
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-top: var(--sp-8);
}

/* 要点 / 接下来 卡片 —— 与 .setcard 同材质（内容层实底），只补几何 */
.blockcard {
  width: min(360px, 100%);
  /* 与 .setcard 同一档：半径 16、四边内距 16（原来左右 18 比上下多 2） */
  border-radius: var(--radius-m);
  padding: var(--pad-card);
  display: flex;
  flex-direction: column;
  /* 标题与内容之间 8（卡内标题与内容 8），原来 6 比规范紧一档 */
  gap: var(--gap-sm);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.blockcard h3 {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.blockcard p {
  font-size: var(--fs-subhead);
  color: var(--text-1);
  line-height: var(--lh-body);
}

.nextrow {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  color: var(--text-2);
}

.nextrow b {
  color: var(--text-1);
}

/* 动作名之后的处方摘要（组数 · 次数）：与名字同为正文档，靠间距分层而不是 「·」 ——
   名字是主角（--text-1 加粗），摘要是补充（--text-2） */
.nextrow span {
  min-width: 0;
}

/* 休息 */
.restnum {
  font-size: var(--fs-readout-lg);
  /* 字重阶梯只到 300（--fw-light）：200 不在阶梯里，是历史遗留的裸值。
     76px 上 300 与 200 的笔画差不到半像素，读数观感不变。 */
  font-weight: var(--fw-light);
  letter-spacing: -3px;
  line-height: 1;
}

.restsec {
  font-size: var(--fs-callout);
  color: var(--text-2);
  font-weight: var(--fw-medium);
}

/* 计时中 */
.timernum {
  font-size: var(--fs-readout-md);
  /* 同上：沉浸读数统一取阶梯最轻一档 --fw-light（300），不再写裸 200。 */
  font-weight: var(--fw-light);
  letter-spacing: -2.5px;
  line-height: 1;
}

/* ---------- 控制层 · 底簇 ----------
   两行并排的独立块：组格轨（一块玻璃，轨内组格是填充）＋ 一行独立控件
   （图标钮/次按钮用玻璃，主行动用实底）。没有任何一层玻璃套在另一层玻璃里。

   底簇本身**不是**玻璃 —— 它是这两行的定位容器，行内的每块各自是浮起的玻璃体。
   这样它们与悬浮 Dock（圆形钮 + 药丸 + 圆形钮）是同一套语言：并排的独立玻璃块，
   而不是一大块玻璃里塞满小玻璃。 */
.ctrl-dock {
  position: absolute;
  /* 页脚操作区离底 16（规范：底部操作区 16），原来 14 与内容末段的 26 也不同源。 */
  bottom: calc(var(--safe-bottom) + var(--sp-16));
  inset-inline: calc(var(--safe-left) + 6px);
  z-index: 2;
  max-width: var(--frame-max);
  margin-inline: auto;
  gap: var(--gap-md);
}

/* 滚起来之后加一层更沉的外投影：苹果的玻璃会**随背后内容自适应影子深浅** ——
   内容压到玻璃底下时影子变重，把玻璃和内容分开。静止时那道轻影读作「这是浮层」。
   目标是 .sgbtn（SessionGlassButton 的那层玻璃根）—— 背景根在它身上，
   光学层的清单与 GlassSurface 里那份逐条对齐（少一条就会掉档）。 */
.session-page.is-scrolled :deep(.sgbtn) {
  box-shadow:
    var(--glass-shadow-lifted),
    var(--glass-halo),
    inset 0 1px 0 0 var(--glass-rim-hi),
    inset 0 -1px 0 0 var(--glass-rim-lo),
    inset 0 14px 22px -16px var(--glass-sheen),
    inset 0 0 0 1px var(--glass-rim-2),
    inset 0 1px 10px -2px var(--glass-caustic);
}

/* 上面那条把整串 box-shadow 重写了一遍（CSS 没法只覆盖列表里的第一项），
   所以「减弱透明度」下要在这里再压回去一次：系统要的是实底 + 常规投影，
   不能因为内容滚起来了就把光学层和重落影又请回来。同权重、排在后面，故它赢。 */
@media (prefers-reduced-transparency: reduce) {
  .session-page.is-scrolled :deep(.sgbtn) {
    box-shadow: var(--shadow-float);
  }
}

.drow {
  gap: var(--gap-md);
  width: 100%;
}

/* 坞内主按钮随行伸缩：休息态两枚图标钮 + 主键在窄屏也要放得下；
   热身态三键并排（图标 + 跳过 + 完成），收窄内边距避免 390px 挤爆 */
.drow .primary {
  min-width: 0;
  padding: 0 var(--sp-26);
}

/* 主按钮 —— 实底是**语义选择**不是玻璃：它是这一步唯一的主行动，
   超高档也要保住"黑/白实底 + 玻璃"这条最高的对比层级，玻璃化会和内容糊在一起。
   它也因此**独立于玻璃之外**（苹果：主行动单独放、并且着色当焦点），
   于是它是胶囊这件事不构成同心问题 —— 胶囊只对独立控件成立，嵌套进玻璃里才会「胀角」。
   按压走全仓 Dock 那套体积守恒挤压 + 回弹（见 base.css 的 .dock-tab）。 */
.primary {
  min-width: 240px;
  height: 54px;
  padding: 0 var(--sp-36);
  /* 高 ≥ 48 的单屏唯一主行动走**胶囊**（--radius-full）：这一档在 HarmonyOS 里就是
     「胶囊按钮」，和卡片（16）、容器（32）都不同层 —— 32 夹在中间会读成第三层圆角 */
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  box-shadow: var(--shadow-float);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.primary:active {
  /* 纵向压得多、横向略胀，近似体积守恒；松手沿弹簧曲线过冲回正 */
  transform: scale(1.04, 0.92);
  transition: transform 120ms var(--ease-out);
}

/* 次按钮与图标钮：它们**坐在 SessionGlassButton 那块玻璃里**，所以这里只管内容与
   按压 —— 材质 / 圆角 / 尺寸都在玻璃那一层（写在这里会和折射抢同一块盒子）。
   两者都撑满玻璃的 .gbody：玻璃多大，命中区就多大，不会出现「看着是玻璃、
   点下去只有中间一小块」那种偏差。 */
.ghost {
  width: 100%;
  height: 100%;
  padding: 0 var(--sp-22);
  border-radius: var(--radius-full);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.ghost:active {
  transform: scale(1.03, 0.94);
  transition: transform 120ms var(--ease-out);
}

.ghost.danger {
  color: var(--danger-strong);
}

/* 休息时长图标钮：正圆由玻璃根给（radius 50%），按钮撑满即可 */
.iconbtn {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-1);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.iconbtn:active {
  transform: scale(1.05, 0.9);
  transition: transform 120ms var(--ease-out);
}

.iconbtn svg {
  width: 24px;
  height: 24px;
}
</style>
