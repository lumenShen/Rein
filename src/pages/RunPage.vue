<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, Play, X } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import CountdownOverlay from '@/components/common/CountdownOverlay.vue'
import GlassThumb from '@/components/common/GlassThumb.vue'
import HoldToEnd from '@/components/run/HoldToEnd.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useRunStore, fmtClock, fmtPace } from '@/stores/run'
import { DISP_MIN_M, HERO_METER_MAX_M } from '@/stores/runGate'
import { trackingService, type TrackingStatus } from '@/services/trackingService'
import { buildRunSummary, fmtDuration, type SplitRow } from '@/utils/runSummary'
import { fmtDateCn, todayStr } from '@/utils/date'
import { motionRich } from '@/system/motion'
import { usePressGlow } from '@/composables/usePressGlow'
import { workoutRuntime } from '@/system/workoutRuntime'
import { openImmersive } from '@/system/sessionImmersive'
import { useToast } from '@/composables/useToast'

/**
 * 运动模式 · 跑步（R5 深色轨迹头部）：覆盖整个窗口的沉浸二级页。
 *
 * 分区（2026 版）：暗区承载**空间与真伪**——轨迹、定位新鲜度、后台对账、中断横幅；
 * 亮区承载**读数与动作**——时长 hero 行（+ 距离）、目标进度条、瞬时/平均/消耗
 * 三列指标卡、底部控制行。两区互不重复：同一个量只出现一次。
 *
 * 与训练课同一条结束语义：跑步中只允许暂停，结束必须在暂停后**长按 5 秒**——
 * 奔跑中误触一颗红按钮就是丢一次记录，长按要求手指原地停留，松手即取消。
 * GPS 不可用时退化为纯计时，距离在总结页手动补填（跑步机场景）。
 *
 * 这一页只说真话：没落到点的时刻不叫「已连接」（按 fix 新鲜度分四态）、
 * 定位被系统掐断时不假装还在记（后台对账胶囊）、进程被杀再回来直接接续上次
 * 会话（只给气泡提醒，轨迹与累计量全部继承，不再用核对卡挡住主内容）。
 */
const r = useRunStore()
const router = useRouter()
const { toast } = useToast()

const endOpen = ref(false)
const conflictOpen = ref(false)
const countdownOpen = ref(false)
/** 开跑前预检进行中（按钮切成「正在准备定位…」） */
const preflightBusy = ref(false)
/** 预检判定为「没有后台保活」：照跑，但在准备页说明这次按无 GPS 兜底 */
const preflightDegraded = ref(false)
/**
 * 总结页距离输入。
 *
 * 类型是 `string | number` 而不是 `string`：`<input type="number" v-model>`
 * 在 Vue 里会把用户输入**写成数字**（"4.50" → 4.5），只有程序赋值
 * （syncManualKm 写 toFixed 串）时才是字符串。
 * 从前注释写着「字符串便于空值表示未填」，于是每个读它的地方都直接
 * `.trim()` —— 用户一改距离（变数字）computed 就抛 TypeError，
 * 界面静默停在旧状态（踩过：症状是「输入框改了、界面没反应」，
 * 控制台只有一条看起来无关的 render 错）。
 * 所以：**读它一律先 String(...) 归一**，别再加字符串方法。
 */
const manualKmText = ref<string | number>('')

onMounted(async () => {
  // 先等运动系统运行时的启动接管（冷开直达本页时防竞态）；
  // 状态机已激活（收起后再进入 / 运行时已恢复）则原样展示，不重复恢复
  void refreshTrackStatus() // 与 whenReady 并行：冷开直达准备页也要能读到保活状态
  await workoutRuntime.whenReady()
  if (r.isActive) {
    syncManualKm() // 恢复到总结页时预填 GPS 距离
    return
  }
  if (r.phase === 'ready') return // 已设过目标，保留
  const restored = await r.hydrateFromServer()
  if (restored) {
    syncManualKm()
    return
  }
  if (r.courseConflict) conflictOpen.value = true
  r.enterReady()
})

/* ---------- 保活/权限状态：读缓存 + 重试收敛 ---------- */

/**
 * `tracking_status` 是「缓存 + 异步刷新」语义（原生侧静态初值 GRANTED=false/BUSY=true）：
 * 冷启动首读几乎必然拿到 busy=true 的旧缓存 —— 只读一次会把「已授权」误读成
 * 「未授权」（准备页的就绪行、通知提示都据它说话）。所以按 400ms 重试到收敛或 5 次为止，
 * 与 run.ts 的 armKeepalive 同一形状（那边等的是同一个字段）。
 */
const trackStatus = ref<TrackingStatus | null>(null)
/** 通知权限提示被用户关掉：本次跑步不再提（下次进入重新评估） */
const notifyNudgeClosed = ref(false)

async function refreshTrackStatus(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const st = await trackingService.status()
    if (!st.busy) {
      trackStatus.value = st
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  // 五次仍未收敛：按最后一次读到的值落状态（busy 与 granted 同读，不会误报「已授权」）
  trackStatus.value = await trackingService.status()
}

// 运行态与准备页都要这份状态（就绪行 / 通知提示），阶段一变就重读一次；
// 回到准备页 = 新的一次跑步，通知提示的「已关闭」也随之复位
watch(
  () => r.phase,
  (p) => {
    if (p === 'ready') notifyNudgeClosed.value = false
    if (p === 'ready' || p === 'running') void refreshTrackStatus()
  },
)

/**
 * 后台对账胶囊：只说「现在是谁在记」—— 落点新鲜度归更靠上的 GPS chip，
 * 同一件事不在两颗相邻胶囊里各报一遍（眼睛要对照两个数字才知道是同一件）。
 * 只在有原生前台服务的机型上才敢说「后台记录中」——桌面/浏览器里进程本就在前台，
 * 那是另一句实话；降级后前台服务已放手（nativeDegraded），更不能沿用原话。
 */
const bgChip = computed(() => {
  if (r.phase !== 'running' && r.phase !== 'paused') return ''
  if (r.source !== 'native') return '前台记录中'
  if (r.nativeDegraded) return '应用内记录 · 锁屏可能中断'
  return '后台记录中'
})

/**
 * 短时长（秒）→「45 秒」/「1 分 05 秒」：chip 里的年龄读数要能一眼比大小。
 * 不用 `45s` / `1m05s` —— 同屏的 `m` 另有「米」的语义（GPS 良好 ±5 m、比例尺 500 m），
 * 字母记法要先猜单位。
 */
function fmtShortAge(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

/**
 * 后台中断横幅：`gapNotice` 由 run-core 在「回前台且离线 >15s」时置位。
 * 它要回答的是「刚才那段时间去哪了」——补记到数就报数，没记到就说没记到；
 * 3.5s 后自行退场（它只是回前台那一刻的一次性对账，不是常驻状态）。
 */
const gapNoticeText = computed(() => {
  const n = r.gapNotice
  if (!n) return ''
  const off = fmtDuration(n.ms / 1000)
  if (n.creditedM > 0 || n.creditedMs > 0) {
    return `后台 ${off} · 已补记 ${Math.round(n.creditedM)} m / ${Math.round(n.creditedMs / 1000)} 秒`
  }
  return `后台 ${off}未记录到轨迹（定位被系统中断）`
})

let gapBannerTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => r.gapNotice,
  (n) => {
    if (gapBannerTimer) clearTimeout(gapBannerTimer)
    gapBannerTimer = null
    if (!n) return
    gapBannerTimer = setTimeout(() => r.clearGapNotice(), 3500)
  },
)
onBeforeUnmount(() => {
  if (gapBannerTimer) clearTimeout(gapBannerTimer)
})

/** 通知权限提示：可关闭、不弹窗（首次进入运行态才评估；关掉后本次不再提） */
const notifyNudge = computed(() => {
  const st = trackStatus.value
  if (!st || notifyNudgeClosed.value) return false
  if (!st.native || st.notify) return false
  return r.phase === 'running' || r.phase === 'paused'
})

/**
 * 准备页的就绪行（文案纪律）。
 * 「锁屏也继续记录」这句话只有「原生前台服务 + 定位已授权」两件都成立时才允许出现 ——
 * 它是这次记录可不可信的承诺，不是通用安抚语；没有原生保活的桌面/浏览器不显示这一行。
 */
const readyLine = computed(() => {
  const st = trackStatus.value
  if (!st || !st.native) return ''
  return st.granted ? '后台记录：已就绪 · 锁屏也继续记录' : '未授权 · 锁屏后可能中断'
})

const clockText = computed(() => fmtClock(r.elapsedSec))
const paceText = computed(() => (r.paceSecPerKm != null ? fmtPace(r.paceSecPerKm) : '—'))
const instPaceText = computed(() =>
  r.paceInstantSecPerKm != null ? fmtPace(r.paceInstantSecPerKm) : '—',
)
const kmText = computed(() => (r.km > 0.005 ? r.km.toFixed(2) : '—'))

/**
 * hero 主视觉距离：走**显示专用**快通道 `distDisplayM`（低滞后、单调不减），不走结算
 * 真源 `r.km`（`kmText` 仍供 splitsHint/结束确认用，快通道不得进结算文案）。
 * 单位规则（冻结规格 §3.2/§6）：<100m 显整数米（≥1m 才出现非零数位），≥100m 显 km 2 位。
 * value/unit 同源，避免出现 '0.29 km km' 这类双单位。
 */
const heroDist = computed<{ value: string; unit: string }>(() => {
  const m = r.distDisplayM
  if (m >= HERO_METER_MAX_M) return { value: (m / 1000).toFixed(2), unit: 'km' }
  return { value: m >= DISP_MIN_M ? String(Math.round(m)) : '—', unit: m >= DISP_MIN_M ? 'm' : '' }
})

/* ---------- 总结派生（口径见 utils/runSummary，与写入记录同一把尺） ---------- */

/**
 * 距离是否被用户改过。
 *
 * ⚠ `manualKmText` **不能当字符串用**：`<input type="number" v-model>` 在
 * Vue 里会把它写成**数字**（"4.50" → 4.5），所以 `.trim()` / `.toFixed()`
 * 这类字符串方法会在用户输入小数时抛 TypeError。
 * 症状很隐蔽：computed 抛错 → 渲染回退到上一次的 vnode →
 * 界面看起来「改了距离但什么都没变」，而控制台只有一条无关的 render 错。
 * 所以这里一律先 `String(...)` 归一，两个读它的地方都这么处理。
 */
const kmOverridden = computed(() => {
  const t = String(manualKmText.value ?? '').trim()
  if (!t) return false
  const v = Number(t)
  if (!Number.isFinite(v)) return false
  return Math.abs(v - r.km) > 0.005
})

/** 归一后的改填公里数；没改填（或填了等于没填）时为 null */
const manualKm = computed<number | null>(() => {
  const t = String(manualKmText.value ?? '').trim()
  if (!t) return null
  const v = Number(t)
  if (!Number.isFinite(v) || v <= 0) return null
  return kmOverridden.value ? v : null
})

/**
 * 生效距离：改填值优先，否则 GPS 入账距离（<0.01km 视为没测到）。
 * 距离 / 平均配速 / 消耗三格都从它派生 —— 与 store 的 save() 同一口径，
 * 屏幕上看到的数字与最终写进记录的数字必须是同一个。
 */
const effKm = computed<number | null>(() => manualKm.value ?? (r.km > 0.01 ? r.km : null))
const effKmText = computed(() => (effKm.value != null ? effKm.value.toFixed(2) : '—'))
const avgPaceText = computed(() => {
  const k = effKm.value
  if (k == null || k <= 0.05) return '—' // 与 save() 的 paceSec 门槛同一条
  return fmtPace(Math.round(r.elapsedSec / k))
})
const kcalText = computed(() => r.kcalAt(effKm.value))

const runSummary = computed(() =>
  buildRunSummary(r.trackPoints, { distanceM: r.distanceM, manualKm: manualKm.value }),
)
const runSplits = computed(() => runSummary.value.splits)
const runAscent = computed(() => runSummary.value.ascentM)
const runAscentAvailable = computed(() => runSummary.value.ascentAvailable)
const runPaceSpread = computed(() => runSummary.value.paceSpread)

/** 分段的距离基准：入账距离优先（与 buildRunSummary 内部同一条判据） */
const basisM = computed(() => (r.distanceM > 0 ? r.distanceM : r.trackM))
const fullKmCount = computed(() => Math.floor(basisM.value / 1000))
const isPartial = (sp: SplitRow): boolean => sp.index > fullKmCount.value

/**
 * 尾段（非整公里）的标签。
 * SplitRow 只有序号（契约 J4 对它的追加只有 suspect/startPt/endPt），序号当标签会把
 * 5.4km 的尾段读成「第 6 公里」—— 那是编造。尾段长度由距离基准反推（与
 * buildRunSummary 的 D 同一条规则，精确值而不是从 sec/pace 回算，免受取整误差），
 * floor 到 0.1km：0.95km 的尾段不该四舍五入成「1.0」。
 */
function segLabel(sp: SplitRow): string {
  if (!isPartial(sp)) return String(sp.index)
  const tailM = basisM.value - fullKmCount.value * 1000
  return tailM > 0 ? (Math.floor(tailM / 100) / 10).toFixed(1) : '尾段'
}

/** 改填值与 GPS 入账距离的偏差（%）；没改填或没有基准时为 null */
const mismatchPct = computed<number | null>(() => {
  const man = manualKm.value
  const d = basisM.value
  if (man == null || d <= 0) return null
  return (Math.abs(man * 1000 - d) / d) * 100
})

/**
 * 偏差过大（>20%）时分段整块撤下：轨迹的累计距离与用户填的值对不上，
 * 强行按填的值切段会给出与实际路线无关的配速 —— 那种数字比没有更糟
 * （用户会照它调整训练）。3%~20% 之间仍展示，但脚注把差值摆出来。
 */
const splitsHidden = computed(
  () => runSummary.value.distanceMismatch && (mismatchPct.value ?? 0) > 20,
)
/** 不足 1 公里时只有一段折算段 —— 那不是「逐公里分段」，不画表 */
const splitsSinglePartial = computed(
  () => runSplits.value.length === 1 && isPartial(runSplits.value[0]!),
)
const showSplits = computed(
  () => runSplits.value.length > 0 && !splitsHidden.value && !splitsSinglePartial.value,
)

const isFastest = (sp: SplitRow): boolean =>
  !isPartial(sp) && runSummary.value.fastestKm?.index === sp.index
const isSlowest = (sp: SplitRow): boolean =>
  !isPartial(sp) && runSummary.value.slowestKm?.index === sp.index
const fastestPace = computed(() =>
  runSummary.value.fastestKm ? fmtPace(runSummary.value.fastestKm.paceSecPerKm) : '—',
)
const slowestPace = computed(() =>
  runSummary.value.slowestKm ? fmtPace(runSummary.value.slowestKm.paceSecPerKm) : '—',
)

/** 分段不可用时的那句说明：必须说清是「哪一档不可用」，不能只说「无数据」 */
const splitsHint = computed(() => {
  if (splitsHidden.value)
    return `距离已改填 ${effKmText.value} km · 与 GPS 入账距离差 ${Math.round(mismatchPct.value ?? 0)}%，分段配速不再显示`
  if (r.trackPoints.length < 2) return '本次没有定位轨迹（GPS 不可用）· 分段配速需要轨迹'
  if (splitsSinglePartial.value)
    return `本次不足 1 公里（${kmText.value === '—' ? '无距离' : kmText.value + ' km'}）· 满 1 公里后才有分段`
  return '本次距离太短（不足 200 米）· 分段配速需要更长的轨迹'
})

/** 分段脚注：说清「按哪个距离切的」以及「与填报值差多少」 */
const splitsFootnote = computed(() => {
  const base = `分段按入账距离 ${(basisM.value / 1000).toFixed(2)} km（GPS）计算`
  const pct = mismatchPct.value
  return pct == null ? base : `${base}，与填报值差 ${Math.round(pct)}%`
})

/** 爬升率副行（米/公里）：距离太短它没有意义，宁可不给 */
const runAscentRate = computed(() => {
  if (!runAscentAvailable.value || runAscent.value == null || basisM.value < 300) return null
  return Math.round((runAscent.value / basisM.value) * 1000)
})

const hasGaps = computed(() => r.gapSlowCount + r.gapFastCount + r.gapDropCount > 0)
/** 消耗是估算：有断档或没有距离时如实标「≈」，并给一句为什么 */
const kcalApprox = computed(() => hasGaps.value || effKm.value == null)
const kcalHint = computed(() => {
  if (!kcalApprox.value) return ''
  return effKm.value == null
    ? '≈ 未测得距离：消耗按跑步中等强度估算'
    : '≈ 消耗按平均速度估算'
})

/**
 * 记录说明卡的逐行取值。
 * **互斥是硬约束**：每一段墙钟只能落进一个桶（契约 H 的四类桶），所以
 * slow/drop 归「未计入」、fast 归「已按直线补记」、自动暂停归 autoPauseMs ——
 * 同一段时间出现在两行里，等于把一次断档说成两次。
 * **段数口径也只在卡里出现一次**：首行按 total（含 fast）报，fast 的明细以「另有」起头 ——
 * 从「其中」改来，「其中」暗示 fast 是上一行 missN 的子集（实际是互斥的两个桶），
 * missN 为 0 时更会成无前文的「其中」。
 */
const runNotes = computed<string[]>(() => {
  const out: string[] = []
  const gapN = r.gapSlowCount + r.gapFastCount + r.gapDropCount
  const missN = r.gapSlowCount + r.gapDropCount
  if (gapN > 0)
    out.push(
      missN > 0
        ? `定位中断 ${gapN} 段 · 未计入 ${missN} 段（共 ${fmtDuration((r.gapSlowMs + r.gapDropMs) / 1000)}）`
        : `定位中断 ${gapN} 段`,
    )
  if (r.gapFastCount > 0)
    out.push(`另有 ${r.gapFastCount} 段长间隔已按直线补记距离（共 ${fmtDuration(r.gapFastMs / 1000)}）`)
  if (r.autoPauseCount > 0)
    out.push(`自动暂停 ${r.autoPauseCount} 次 · 共 ${fmtDuration(r.autoPauseMs / 1000)}（不计入时长与配速）`)
  if (kmOverridden.value)
    out.push(
      r.distanceM > 0
        ? `距离为手动改填 · GPS 记录 ${(r.distanceM / 1000).toFixed(2)} km`
        : '距离为手动改填 · GPS 未记录距离',
    )
  if (r.jumpCount > 0) out.push(`含定位跳变 ${r.jumpCount} 处（未计入距离）`)
  return out
})

/** 有断档/自动暂停才引导「按轨迹距离修正」——它们正是入账距离偏少的两类原因 */
const canFixByTrack = computed(
  () => r.trackM > 0 && (hasGaps.value || r.autoPauseCount > 0) && !kmOverridden.value,
)

/** 按轨迹里程回填改填框（轨迹是没被闸门丢点的原始记录，断档后它更接近实际） */
function fixByTrack(): void {
  manualKmText.value = (r.trackM / 1000).toFixed(2)
}

const distHint = computed(() => {
  if (effKm.value == null) return '未获取到定位：跑步机跑完可手动填距离'
  if (hasGaps.value || r.autoPauseCount > 0) return 'GPS 距离可能偏少，可按实际修正'
  return 'GPS 距离已预填，可按实际修正'
})

/**
 * 总结屏结论：完成状态单独一行。中断的段数与时长只在记录说明卡里说一次，
 * 两条 hint 也只留各自的结论（消耗为什么是估算 / 距离可修正）——
 * 「含定位中断」这个前提从前在四处各说一遍，真正的结论反被稀释。
 */
const runState = computed(() =>
  r.gpsStatus === 'unavailable' && r.trackPoints.length < 2 ? '无 GPS' : '全程完成',
)

/**
 * GPS chip 四态：按「最近一次落点有多新」分档，而不是「连接上了没有」。
 * 连接是持续状态、落点是离散事实 —— 只有后者能回答「现在这行距离还可信吗」；
 * 旧文案的「已连接」在系统掐断定位后仍挂着，等于替系统打包票。
 */
const gpsChip = computed<{ text: string; tone: string } | null>(() => {
  if (r.phase !== 'running' && r.phase !== 'paused') return null
  if (r.lastFixAt === 0) {
    if (r.fixWaitSec < 20)
      return {
        text: r.fixWaitSec > 10 ? `定位中… · 已等 ${fmtShortAge(r.fixWaitSec)}` : '定位中…',
        tone: 'wait',
      }
    return { text: `无定位 ${fmtShortAge(r.fixWaitSec)} · 距离已停止累加`, tone: 'lost' }
  }
  const age = r.fixAgeSec
  if (age < 3) return { text: `GPS 良好 ±${Math.round(r.lastFixAccM)} m`, tone: 'ok' }
  if (age <= 30) return { text: `定位中断 ${fmtShortAge(age)}`, tone: 'warn' }
  return { text: `无定位 ${fmtShortAge(age)} · 距离已停止累加`, tone: 'lost' }
})

const goalLabel = computed(() => {
  if (r.goalKind === 'time') return `目标 ${r.goalTimeMin} 分钟`
  if (r.goalKind === 'distance') return `目标 ${r.goalDistanceKm.toFixed(2)} km`
  return '自由跑'
})

/** 目标进度（0..100）；'open' 目标下为 null，那一行整块不渲染 */
const goalPct = computed(() => {
  const p = r.goalProgress
  return p == null ? null : Math.round(Math.min(1, p) * 100)
})

const goalBarWidth = computed(() => `${(Math.min(1, r.goalProgress ?? 0) * 100).toFixed(1)}%`)

const pausedBadgeText = computed(() =>
  r.pauseCause === 'auto' ? '自动暂停 · 继续移动即自动恢复' : '已暂停 · 计时停止',
)

/** 结束/放弃的二级确认标题：总结页那一次必须把「要丢的是什么」写进标题（时长 + 距离） */
const endTitle = computed(() => {
  if (r.phase === 'summary') return `放弃本次跑步？已记录 ${clockText.value} · ${effKmText.value} km`
  if (r.phase === 'paused')
    return `结束本次跑步？已记录 ${clockText.value}${kmText.value === '—' ? '' : ` · ${kmText.value} km`}`
  return '结束本次跑步？'
})

/** 总结页是唯一「已经跑完、还没落库」的位置：选项里多一条继续核对（不丢记录的那条路）。
 *  顺序即主次：「继续核对」排最上（不做的那个选项是视觉主选项），放弃垫后。 */
const endActions = computed(() =>
  r.phase === 'summary'
    ? [
        { label: '继续核对', value: 'keep' },
        { label: '放弃不保存', value: 'discard', danger: true },
      ]
    : [
        { label: '结束并保存', value: 'finish' },
        { label: '放弃本次跑步（不保存）', value: 'discard', danger: true },
      ],
)

const heroWaitText = computed(() => {
  if (r.phase === 'ready') return '开跑后轨迹将在此描绘'
  if (r.gpsStatus === 'unavailable') return '' // 状态 chip 已说明，不重复
  return '等待轨迹…'
})


/* ---------- 轨迹相机：世界坐标 = 相对首点的局部米坐标，屏幕 = R(rot)·p·scale + t ---------- */

/**
 * 可见画布窗口（CSS px，与 SVG 用户单位 1:1）= 顶栏下沿 → 抽屉上沿之间的整片区域。
 *
 * 从前投影把 viewBox(480×320 + `slice`) 的中心当画面中心，而可见区的中心并不在那里：
 * 抽屉从 46% 处压上来、顶栏又占掉顶部，于是「固定」把「我」钉在被抽屉盖住的地方，
 * 「全览」把整条轨迹推到偏下。slice 的放大系数（本机 ≈8.5）还把 stroke-width:5
 * 放大成约 42 设备像素——尺寸必须按 CSS px 算，所见即所得。
 *
 * 现在的约定：1 用户单位 = 1 CSS px；画布窗口 = 顶栏下沿…抽屉上沿；窗口中心 = (cx, cy)。
 */
const canvas = ref({ w: 0, h: 0, winTop: 0, winH: 0, cx: 0, cy: 0, pad: 18 })
/** 安全边距（全览内缩、比例尺内缩）：真实值测量时从 --page-pad-x 令牌读，不另立魔数 */
const CANVAS_PAD_FALLBACK = 18
/** 固定缩放档基准：1 画布 px = 1 m，捏合可在此上下调整 */
const BASE_SCALE = 1
const SCALE_MIN = 0.15
const SCALE_MAX = 12
/** 全览专用缩放下限：长距离（>40km）也得整条塞进窗口，不受捏合下限约束 */
const FIT_SCALE_MIN = 0.002
/** 比例尺允许的渲染长度（CSS px）：太短读不出、太长喧宾夺主 */
const SCALE_BAR_MIN_PX = 40
const SCALE_BAR_MAX_PX = 120
/** 每纬度米数（等距圆柱近似） */
const M_LAT = 111_320

interface Cam {
  scale: number
  rot: number
  tx: number
  ty: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 相机模式：follow = 跟随「我」+ 运动方向朝上（默认）；manual = 手势接管；fit = 全览整条轨迹 */
type CamMode = 'follow' | 'manual' | 'fit'
const camMode = ref<CamMode>('follow')
/** 固定档捏合比例（回到 follow 时保留用户缩放） */
const userScale = ref(1)

/**
 * 相机模式两段切换的液态滑块（丰富档）：与 SegmentedControl 同一套做法 ——
 * 两段是等宽的，GlassThumb 要的就是"均分槽位"这个前提。
 * manual 与 follow 在这一格上语义相同（都锁定跟随），所以手动接管后仍高亮「固定」。
 */
const goo = motionRich
const msegIndex = computed(() => (camMode.value === 'fit' ? 1 : 0))
/** 手势接管的冻结相机（世界坐标稳定：锚定首点） */
const manualCam = ref<Cam | null>(null)
/** 运动方向朝上的旋转角（度，EMA 平滑） */
const headingDeg = ref(0)

/** 局部米坐标（相对轨迹首点；首点不增不改 → 手动相机在世界系下稳定） */
const trackMeters = computed(() => {
  const pts = r.trackPoints
  if (pts.length === 0) return null
  const o = pts[0]!
  const kx = Math.cos((o.lat * Math.PI) / 180)
  return pts.map((p) => ({ x: (p.lon - o.lon) * kx * M_LAT, y: -(p.lat - o.lat) * M_LAT }))
})

watch(trackMeters, (m) => {
  if (!m || m.length < 2 || r.phase !== 'running') return
  const a = m[m.length - 2]!
  const b = m[m.length - 1]!
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.hypot(dx, dy) < 3) return // 位移太小不更新朝向（GPS 抖动）
  // 把运动方向向量旋到屏幕上方 (0, -1)
  const target = -90 - (Math.atan2(dy, dx) * 180) / Math.PI
  let diff = target - headingDeg.value
  diff = ((diff + 540) % 360) - 180 // 最短角差
  headingDeg.value = (headingDeg.value + diff * 0.25 + 360) % 360
})

const view = computed(() => {
  const m = trackMeters.value
  if (!m || m.length === 0) return { cam: null, d: null, start: null, last: null }

  const win = canvas.value
  // 全览可用框：窗口内缩一个 page-padding，再把末点标记的半径算进去 ——
  // 要求是「所有点都在 page-padding 之内」，圆点也不该压到那条安全线上
  const fitPad = win.pad + 7
  const fitW = Math.max(80, win.w - fitPad * 2)
  const fitH = Math.max(80, win.winH - fitPad * 2)

  let cam: Cam
  if (camMode.value === 'fit') {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of m) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const scale = clamp(Math.min(fitW / spanX, fitH / spanY), FIT_SCALE_MIN, SCALE_MAX)
    cam = {
      scale,
      rot: 0,
      // 居中到可见窗口中心（不是 viewBox 中心）：整条轨迹落在 top…bottom 之间
      tx: win.cx - ((minX + maxX) / 2) * scale,
      ty: win.cy - ((minY + maxY) / 2) * scale,
    }
  } else if (camMode.value === 'manual' && manualCam.value) {
    cam = manualCam.value
  } else {
    const scale = clamp(BASE_SCALE * userScale.value, SCALE_MIN, SCALE_MAX)
    const rot = ((headingDeg.value % 360) + 360) % 360
    const rad = (rot * Math.PI) / 180
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    const last = m[m.length - 1]!
    cam = {
      scale,
      rot,
      // 「我」钉在可见窗口中心：从前钉在 viewBox 中心，落点被抽屉盖住
      tx: win.cx - (c * last.x - s * last.y) * scale,
      ty: win.cy - (s * last.x + c * last.y) * scale,
    }
  }

  const rad = (cam.rot * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const to = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: (c * p.x - s * p.y) * cam.scale + cam.tx,
    y: (s * p.x + c * p.y) * cam.scale + cam.ty,
  })

  // 抽稀描线（≤400 点），末点必含
  let d: string | null = null
  if (m.length >= 2) {
    const step = Math.max(1, Math.ceil(m.length / 400))
    const idxs: number[] = []
    for (let i = 0; i < m.length; i += step) idxs.push(i)
    if (idxs[idxs.length - 1] !== m.length - 1) idxs.push(m.length - 1)
    const p0 = to(m[idxs[0]!]!)
    d = `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)}`
    for (let k = 1; k < idxs.length; k++) {
      const q = to(m[idxs[k]!]!)
      d += ` L ${q.x.toFixed(1)} ${q.y.toFixed(1)}`
    }
  }
  return { cam, d, start: to(m[0]!), last: to(m[m.length - 1]!) }
})

/* ---------- 地图手势：单指平移 / 双指捏合缩放平移 ---------- */

const heroEl = ref<HTMLElement | null>(null)
/** 顶栏：画布窗口的上沿 —— 测量时只读它的下边界 */
const sheadEl = ref<HTMLElement | null>(null)
const pointers = new Map<number, { x: number; y: number }>()
type Gesture =
  | { kind: 'pan'; startCam: Cam; startPt: { x: number; y: number } }
  | { kind: 'pinch'; startCam: Cam; startDist: number; startMid: { x: number; y: number } }
let gesture: Gesture | null = null

/** page-padding 令牌（--page-pad-x）；读不到就用兜底值，避免与设计令牌脱钩 */
function readPadToken(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--page-pad-x')
  const px = Number.parseFloat(raw)
  return Number.isFinite(px) && px > 0 ? px : CANVAS_PAD_FALLBACK
}

/**
 * 量出可见画布窗口：顶栏下沿 → 抽屉上沿，宽度取整幅 hero。
 * 抽屉的 top（ready 26% / running 46% / summary 32%）、收起档、拖拽落定、窗口尺寸
 * 任何一项变了，窗口就变了 —— 「固定」的中心与「全览」的缩放都得跟着重量。
 */
function syncCanvas(): void {
  const hero = heroEl.value
  if (!hero) return
  const hr = hero.getBoundingClientRect()
  const top = clamp((sheadEl.value?.getBoundingClientRect().bottom ?? hr.top) - hr.top, 0, hr.height)
  const rawBottom = drawerEl.value?.getBoundingClientRect().top ?? hr.bottom
  const bottom = clamp(rawBottom - hr.top, top + 120, hr.height)
  const winH = bottom - top
  canvas.value = {
    w: hr.width,
    h: hr.height,
    winTop: top,
    winH,
    cx: hr.width / 2,
    cy: top + winH / 2,
    pad: readPadToken(),
  }
}

/** 窗口几何的变动都带过渡动画（抽屉 top / transform）：下一帧量一次、落定后再量一次 */
let canvasSyncTimer: number | null = null
function scheduleSyncCanvas(): void {
  void nextTick(syncCanvas)
  if (canvasSyncTimer != null) clearTimeout(canvasSyncTimer)
  canvasSyncTimer = window.setTimeout(() => {
    canvasSyncTimer = null
    syncCanvas()
  }, 420)
}

/** client 坐标 → 画布坐标（1 用户单位 = 1 CSS px，无需 slice 补偿） */
function toView(clientX: number, clientY: number): { x: number; y: number } {
  const el = heroEl.value
  if (!el) return { x: clientX, y: clientY }
  const rect = el.getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}

function camNow(): Cam {
  // 手动态用冻结相机；跟随/全览态用 view computed 解析出的当前相机（含用户缩放与朝向）
  const c = canvas.value
  return manualCam.value ?? view.value.cam ?? { scale: BASE_SCALE, rot: 0, tx: c.cx, ty: c.cy }
}

/**
 * 比例尺：挑一个 1/2/5×10^k 的整距（≥10 m，即用户说的「10 的倍数」），
 * 让它渲染成 [40, 120] CSS px 长的一段——读数=屏幕上真实尺子，随缩放实时变。
 */
const scaleBar = computed(() => {
  const cam = view.value.cam
  const c = canvas.value
  if (!cam || c.w === 0 || c.winH <= 0) return null
  let meters = 0
  for (let exp = 1; exp <= 6; exp += 1) {
    for (const mult of [1, 2, 5]) {
      const v = mult * 10 ** exp
      if (v * cam.scale <= SCALE_BAR_MAX_PX) meters = v
    }
  }
  if (meters === 0) return null
  const px = meters * cam.scale
  if (px < SCALE_BAR_MIN_PX) return null // 缩放异常时宁可不画，也不画一条读不出的短杠
  const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`
  return { px, label }
})

/** 比例尺落位：画布右下角（抽屉上沿之上、内缩一个 page-padding） */
const scaleBarStyle = computed(() => {
  const c = canvas.value
  return {
    right: `${c.pad}px`,
    bottom: `${Math.max(c.pad, c.h - (c.winTop + c.winH) + c.pad)}px`,
  }
})

/* 画布窗口的生命周期：挂载即量；尺寸变化重量；抽屉档位/阶段变动由各调用点触发 */
onMounted(() => {
  syncCanvas()
  window.addEventListener('resize', syncCanvas)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncCanvas)
  if (canvasSyncTimer != null) clearTimeout(canvasSyncTimer)
})

function onMapDown(e: PointerEvent): void {
  if ((e.target as HTMLElement).closest('button, .chip, input, a')) return
  try {
    heroEl.value?.setPointerCapture?.(e.pointerId)
  } catch {
    /* 合成指针事件（自动化/测试）无真实活动指针，忽略 */
  }
  const pt = toView(e.clientX, e.clientY)
  pointers.set(e.pointerId, pt)
  if (pointers.size === 1) {
    gesture = { kind: 'pan', startCam: camNow(), startPt: pt }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    gesture = {
      kind: 'pinch',
      startCam: camNow(),
      startDist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)),
      startMid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
    }
  }
}

function onMapMove(e: PointerEvent): void {
  if (!pointers.has(e.pointerId) || !gesture) return
  const pt = toView(e.clientX, e.clientY)
  pointers.set(e.pointerId, pt)
  const g = gesture
  if (g.kind === 'pan' && pointers.size === 1) {
    const dx = pt.x - g.startPt.x
    const dy = pt.y - g.startPt.y
    if (camMode.value !== 'manual' && Math.hypot(dx, dy) < 4) return // 抑制点按抖动
    manualCam.value = { ...g.startCam, tx: g.startCam.tx + dx, ty: g.startCam.ty + dy }
  } else if (g.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const dist = Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y))
    const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }
    const scale = clamp(g.startCam.scale * (dist / g.startDist), SCALE_MIN, SCALE_MAX)
    // 起始中点下的世界点钉在当前中点下（锚点不漂移）
    const rad = (g.startCam.rot * Math.PI) / 180
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    const wx = (g.startMid.x - g.startCam.tx) / g.startCam.scale
    const wy = (g.startMid.y - g.startCam.ty) / g.startCam.scale
    const ux = c * wx + s * wy // R(-rot) 逆变换回世界系
    const uy = -s * wx + c * wy
    manualCam.value = {
      scale,
      rot: g.startCam.rot,
      tx: mid.x - (c * ux - s * uy) * scale,
      ty: mid.y - (s * ux + c * uy) * scale,
    }
  } else {
    return
  }
  camMode.value = 'manual'
  userScale.value = clamp((manualCam.value?.scale ?? BASE_SCALE) / BASE_SCALE, SCALE_MIN / BASE_SCALE, SCALE_MAX / BASE_SCALE)
}

function onMapUp(e: PointerEvent): void {
  pointers.delete(e.pointerId)
  if (pointers.size === 1 && gesture?.kind === 'pinch') {
    // 双指抬成一指 → 无缝转为平移
    const [pt] = [...pointers.values()]
    gesture = { kind: 'pan', startCam: manualCam.value ?? camNow(), startPt: pt! }
  } else if (pointers.size === 0) {
    gesture = null
  }
}

function recenter(): void {
  camMode.value = 'follow'
  manualCam.value = null
}

function fitAll(): void {
  camMode.value = 'fit'
  manualCam.value = null
}

// 阶段切换时重置相机：开跑回跟随默认档，总结页自动全览
watch(
  () => r.phase,
  (p) => {
    scheduleSyncCanvas() // 抽屉的 top 按阶段不同（26%/32%/46%），窗口先重量
    if (p === 'summary') {
      fitAll()
      drawerCollapsed.value = false
      return
    }
    if (p === 'ready') {
      camMode.value = 'follow'
      manualCam.value = null
      userScale.value = 1
      headingDeg.value = 0
      drawerCollapsed.value = false
    }
  },
)

/* ---------- 底部抽屉拖拽：展开 ↔ 收起（露出 peek）两档吸附 ---------- */

const drawerEl = ref<HTMLElement | null>(null)
/** 按压定向光晕（丰富档）：整页一份委托 —— :active 决定亮不亮，即时反馈等不得事件 */
usePressGlow(drawerEl, '.glow-layer')
/** 丰富档的滚动边缘：抽屉里任一面板滚起来即置位（暗带只画一条，在抽屉上缘） */
const paneScrolled = ref(false)

/** 三个面板各是独立的滚动框（v-if 换面），事件冒泡到抽屉根统一收一份。 */
function onDrawerScroll(e: Event): void {
  const t = e.target as HTMLElement
  paneScrolled.value = t.scrollTop > 4
}

// 阶段切换时换了一整个面板，滚动位置随之归零 —— 暗带不能留着上一面的状态
watch(() => r.phase, () => (paneScrolled.value = false))

const drawerCollapsed = ref(false)
const drawerDragging = ref(false)
const dragY = ref<number | null>(null)
// 收起/展开改的是画布窗口的下沿：落定后重量一次（几何带过渡，schedule 里会再等一拍）
watch(drawerCollapsed, scheduleSyncCanvas)
/** 收起态露出的 peek 高度：把手 + 时长/千卡行 */
const PEEK_PX = 176
let dragBase = 0
let dragStartY = 0
let dragMoved = false

const dragStyle = computed(() =>
  dragY.value != null ? { transform: `translateY(${dragY.value}px)` } : undefined,
)

function onHandleDown(e: PointerEvent): void {
  if (r.phase !== 'running' && r.phase !== 'paused') return
  if ((e.target as HTMLElement).closest('button')) return
  const el = e.currentTarget as HTMLElement | null
  if (!el) return
  try {
    // 捕获到把手自身：捕获后事件只流向 handle（含其监听），不会经过父容器
    el.setPointerCapture(e.pointerId)
  } catch {
    /* 合成指针事件，忽略 */
  }
  const drawer = drawerEl.value
  dragBase = drawerCollapsed.value && drawer ? drawer.offsetHeight - PEEK_PX : 0
  dragStartY = e.clientY
  dragMoved = false
  drawerDragging.value = true
}

function onHandleMove(e: PointerEvent): void {
  if (!drawerDragging.value) return
  const el = drawerEl.value
  if (!el) return
  const max = el.offsetHeight - PEEK_PX
  if (Math.abs(e.clientY - dragStartY) > 6) dragMoved = true
  dragY.value = clamp(dragBase + e.clientY - dragStartY, 0, max)
}

function onHandleUp(): void {
  if (!drawerDragging.value) return
  drawerDragging.value = false
  const el = drawerEl.value
  if (dragMoved && el && dragY.value != null) {
    drawerCollapsed.value = dragY.value > (el.offsetHeight - PEEK_PX) / 2
  } else if (!dragMoved) {
    drawerCollapsed.value = !drawerCollapsed.value // 轻点把手 = 切换档位
  }
  dragY.value = null
  scheduleSyncCanvas() // 抽屉落定 = 画布窗口的下沿确定，重量一次
}

function syncManualKm(): void {
  manualKmText.value = r.km > 0.005 ? r.km.toFixed(2) : ''
}

function minimize(): void {
  if (r.isActive) void router.push('/sports')
  else void router.replace('/sports')
}

/**
 * 开跑前的定位就绪门：授权框在 3·2·1 之前答完（先跑 preflight 再进倒数）。
 * 两级都放行 —— degraded 只意味着「这一次没有后台保活」，跑步照跑、距离结束时补填；
 * 把它做成硬门等于用权限绑架用户：没给定位就不能跑步是说不通的。
 */
async function onGo(): Promise<void> {
  if (preflightBusy.value) return
  preflightBusy.value = true
  preflightDegraded.value = false
  try {
    const res = await r.preflight()
    preflightDegraded.value = res === 'degraded'
  } finally {
    preflightBusy.value = false
  }
  countdownOpen.value = true
}

async function onCountdownDone(): Promise<void> {
  const res = await r.begin()
  if (res === 'conflict' && r.courseConflict) conflictOpen.value = true
}

function onEndPick(value: string): void {
  endOpen.value = false
  if (value === 'finish') {
    r.enterSummary()
    syncManualKm()
  } else if (value === 'discard') {
    void doDiscard()
  }
  // 'keep'（总结页的「继续核对」）什么都不做：弹层关掉就是继续核对
}

async function doDiscard(): Promise<void> {
  try {
    await r.discard()
    toast('已放弃本次跑步')
    void router.replace('/sports')
  } catch (e) {
    // 放弃失败：总结/暂停态保留，可原样再点（会话仍 active）
    toast(e instanceof Error ? e.message : '放弃失败，请重试')
  }
}

async function doSave(): Promise<void> {
  // String(...) 归一：type=number 的 v-model 给回的是**数字**而非字符串
  // （理由见 kmOverridden 的注释）。parseFloat 对数字虽能工作，
  // 但那依赖隐式转字符串，属于「碰巧对」，与上面两处保持同一写法。
  const parsed = Number.parseFloat(String(manualKmText.value ?? ''))
  const fillKm = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null
  try {
    const result = await r.save(fillKm)
    const parts = [`已保存跑步 ${result.durationMin} 分钟 · ${result.kcal} 大卡`]
    if (result.km != null) parts.push(`${result.km.toFixed(2)} km`)
    toast(parts.join(' · '))
    void router.replace('/sports')
  } catch (e) {
    // 写库本身失败：停在总结页、保留补填距离，按钮可再点（重试用同一 sessionId）
    toast(e instanceof Error ? e.message : '保存失败，请重试')
  }
}

function bumpKm(delta: number): void {
  const cur = Math.round(r.goalDistanceKm * 2) / 2
  r.goalDistanceKm = Math.min(42, Math.max(0.5, cur + delta))
}
</script>

<template>
  <div class="run-page" :class="r.phase">
    <!-- ========== 暗区 · 轨迹剧场（满屏，抽屉覆盖其下沿） ==========
         stage-dark：这一片是深色底，浮在上面的 chip 要取**暗场**玻璃令牌
         （暗色下 halo 是溢到背后的微光、rim 收得更低），亮色那套压上来会翻白。 -->
    <section
      ref="heroEl"
      class="hero stage-dark"
      @pointerdown="onMapDown"
      @pointermove="onMapMove"
      @pointerup="onMapUp"
      @pointercancel="onMapUp"
    >
      <!-- 画布坐标 = 整屏的 CSS px（viewBox 与实际尺寸 1:1，preserveAspectRatio=none）：
           线宽、半径、比例尺因此都是「屏幕上多少 px」的直接写法，不再被 slice 系数放大。
           轨迹照旧画满整屏（抽屉盖住下沿无妨），中心由 camera 钉在可见窗口中心。 -->
      <svg
        v-if="canvas.w > 0"
        class="map"
        :viewBox="`0 0 ${canvas.w} ${canvas.h}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path v-if="view.d" class="route" :d="view.d" />
        <circle v-if="view.start" class="mk-start" :cx="view.start.x" :cy="view.start.y" r="5.5" />
        <g v-if="view.last">
          <circle class="mk-pulse" :cx="view.last.x" :cy="view.last.y" r="7" />
          <circle class="mk-dot" :cx="view.last.x" :cy="view.last.y" r="7" />
        </g>
      </svg>
      <p v-if="!view.d && heroWaitText" class="hero-wait">{{ heroWaitText }}</p>

      <!-- 比例尺：画布右下角（抽屉上沿之上），标出这段整距在屏幕上有多长 -->
      <div v-if="scaleBar" class="scalebar" :style="scaleBarStyle" aria-hidden="true">
        <i class="sb-bar" :style="{ width: `${scaleBar.px.toFixed(1)}px` }" />
        <span class="sb-label">{{ scaleBar.label }}</span>
      </div>

      <header ref="sheadEl" class="shead row between">
        <button class="min" aria-label="收起运动模式" @click="minimize">
          <ChevronDown :size="20" /> 收起
        </button>
        <span class="ptitle">跑步</span>
        <!-- 结束不再放这里：它落在拇指最顺手的位置、又只是「红字一碰即中」。
             跑步中只留暂停；暂停后由控制行的长按闸门结束（见 HoldToEnd）。 -->
        <span class="ph" />
      </header>

      <!-- 左上 HUD 一列：定位新鲜度 → 后台对账 → 通知权限提示。
           竖向叠放（而不是像从前左右各挂一颗）是因为两者读的是同一件事的两面：
           「点有多新」与「谁在记」，眼睛不该在屏幕上跳两处。 -->
      <div class="hud">
        <span v-if="gpsChip" class="chip glass-surface gps" :class="gpsChip.tone">
          <i class="gdot" />{{ gpsChip.text }}
        </span>
        <span v-if="bgChip" class="chip glass-surface stat"><i class="sdot" />{{ bgChip }}</span>
        <button
          v-if="notifyNudge"
          type="button"
          class="chip glass-surface nudge"
          aria-label="关闭通知权限提示"
          @click="notifyNudgeClosed = true"
        >
          <span>通知权限未开 · 锁屏时看不到跑步进度</span>
          <X :size="13" />
        </button>
      </div>

      <!-- 回前台的一次性对账横幅：只在 gapNotice 非空时出现，3.5s 后自行退场 -->
      <p v-if="r.gapNotice" class="gapban glass-surface" role="status">{{ gapNoticeText }}</p>

      <span v-if="r.phase === 'paused'" class="paused-badge glass-surface">{{ pausedBadgeText }}</span>
    </section>

    <p v-if="r.finishError" class="warn">⚠ 结束失败：{{ r.finishError }}</p>
    <p v-else-if="r.persistError" class="warn">⚠ 进度同步失败：{{ r.persistError }}</p>

    <!-- ========== 亮区 · 可拖拽抽屉 ========== -->
    <main
      ref="drawerEl"
      class="drawer"
      :class="{ collapsed: drawerCollapsed, dragging: drawerDragging, 'is-scrolled': paneScrolled }"
      :style="dragStyle"
      @scroll.capture="onDrawerScroll"
    >
      <!-- 把手行：拖拽档位 / 缩放模式（仅进行中与暂停）。
           回中钮与占位块已删：「固定」段就是回中（同一个 recenter），两个入口
           只会让人犹豫按哪个；腾出的空间留给右侧分段控件，把手仍居中。 -->
      <div
        v-if="r.phase === 'running' || r.phase === 'paused'"
        class="handle"
        @pointerdown="onHandleDown"
        @pointermove="onHandleMove"
        @pointerup="onHandleUp"
        @pointercancel="onHandleUp"
      >
        <i class="grab" />
        <div ref="msegEl" class="mseg glass-surface" :class="{ goo: goo }">
          <GlassThumb v-if="goo" :index="msegIndex" :count="2" />
          <button class="seg-item glow-layer" :class="{ on: camMode !== 'fit' }" @click="recenter">固定</button>
          <button class="seg-item glow-layer" :class="{ on: camMode === 'fit' }" @click="fitAll">全览</button>
        </div>
      </div>

      <!-- 准备页：目标选择 -->
      <div v-if="r.phase === 'ready'" class="pane col center">
        <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 页面框站住，只有 item 位移（system/rubberScroll） -->
        <div class="rubber-layer" data-rubber-content>
          <p class="eyebrow">设定目标</p>
          <SegmentedControl
            class="seg"
            :options="[
              { value: 'open', label: '自由跑' },
              { value: 'time', label: '时长' },
              { value: 'distance', label: '距离' },
            ]"
            :model-value="r.goalKind"
            @update:model-value="r.goalKind = $event as typeof r.goalKind"
          />

          <div v-if="r.goalKind === 'time'" class="goalbox row">
            <button class="gbtn glass-surface glow-layer" :disabled="r.goalTimeMin <= 5" @click="r.goalTimeMin -= 5">− 5</button>
            <b class="num gval">{{ r.goalTimeMin }}</b>
            <small class="gunit">分钟</small>
            <button class="gbtn glass-surface glow-layer" :disabled="r.goalTimeMin >= 180" @click="r.goalTimeMin += 5">+ 5</button>
          </div>
          <div v-else-if="r.goalKind === 'distance'" class="goalbox row">
            <button class="gbtn glass-surface glow-layer" @click="bumpKm(-0.5)">− 0.5</button>
            <b class="num gval">{{ r.goalDistanceKm }}</b>
            <small class="gunit">公里</small>
            <button class="gbtn glass-surface glow-layer" @click="bumpKm(0.5)">+ 0.5</button>
          </div>
          <p v-else class="meta">不限时长与距离，随时结束并保存</p>

          <!-- 自动暂停：慢下来就停表。它是「这次记录可不可信」的一部分，
               所以放在开跑前、与目标同级，而不是埋进设置页。 -->
          <div class="pfrow row between">
            <span class="pf-l">
              <span class="pf-lab">自动暂停</span>
              <small class="pf-desc">慢于 {{ fmtPace(r.autoPausePaceSec) }}/km 自动停表 · 快起来自动继续</small>
            </span>
            <ToggleSwitch
              :model-value="r.autoPauseOn"
              label="自动暂停"
              @update:model-value="r.autoPauseOn = $event"
            />
          </div>

          <!-- 定位就绪行：只有「原生前台保活 + 已授权」才敢承诺锁屏也继续记录。
               状态是缓存 + 异步刷新的语义，首读必须重试（见 refreshTrackStatus）——
               否则冷启动第一眼会把「已就绪」读成「未授权」。 -->
          <p v-if="readyLine" class="pf-line">{{ readyLine }}</p>

          <button class="gobtn glass-surface glow-layer" :disabled="preflightBusy" @click="onGo">
            <Play :size="30" :stroke-width="2.6" />
            <span>{{ preflightBusy ? '正在准备定位…' : '开始跑步' }}</span>
          </button>
          <!-- 预检降级：照跑，但先说清这次拿不到后台保活（结束后可补填距离） -->
          <p v-if="preflightDegraded" class="hint warnhint">
            未授权定位 · 本次按无 GPS 记录，结束后可补填距离
          </p>
          <p v-else class="hint">暂停期间不计入时长与配速</p>
        </div>
      </div>

      <!-- 进行中 / 暂停：hero 行（时长 + 距离）→ 目标进度 → 三列指标卡 → 控制行 -->
      <div v-else-if="r.phase === 'running' || r.phase === 'paused'" class="pane col center live">
        <!-- 超范围平移层：同上（item 超伸）。这一屏额外要 align-self: stretch（见样式）：
             hero 行与指标卡必须同宽同位，否则「时长墨水左边界 = 卡片左边缘」
             这条对不齐 —— 居中列会让每一块按自己的内容宽各自居中。 -->
        <div class="rubber-layer" data-rubber-content>
          <!-- hero 行：距离（主）+ 瞬时配速（次）。
               跑步时用户真正盯着的就是这两个「现在到哪了 / 现在多快」，
               其余（时长/平均配速/消耗）退到下面那张三列卡里。 -->
          <div class="livehero row between">
            <div class="lh-l">
              <span class="lh-line">
                <b class="num lh-dist">{{ heroDist.value }}</b>
                <i v-if="heroDist.unit" class="lh-unit">{{ heroDist.unit }}</i>
              </span>
              <p class="tcap">本次距离</p>
            </div>
            <div class="lh-r">
              <span class="lh-line">
                <b class="num lh-pace" :class="{ dim: r.pauseCause === 'auto' }">{{ instPaceText }}</b>
                <i v-if="instPaceText !== '—'" class="lh-unit">/km</i>
              </span>
              <!-- 与左侧「本次距离」同一套阅读顺序：大数字在上，说明小字在下。
                   两个标签的底边对齐，眼睛横扫时才不会在左右之间重新找基线。 -->
              <p class="tcap lh-r-cap"><i class="live-dot" />瞬时配速</p>
            </div>
          </div>

          <!-- 目标进度：满宽一条。'open' 目标下 goalProgress 为 null，整行不渲染 -->
          <div v-if="r.goalProgress != null" class="goalrow">
            <span class="goalhead row between">
              <span class="glab">{{ goalLabel }}</span>
              <span class="gpct num">{{ goalPct }}%</span>
            </span>
            <span class="gbar"><i :style="{ '--p': goalBarWidth }" /></span>
          </div>

          <!-- 三列指标卡：时长 / 平均配速 / 消耗（主读数已上提到 hero 行）。
               瞬时那列从前在这里，现在它是 hero 的右读数，不再重复出现。 -->
          <div class="pace row glass-surface">
            <div class="col center">
              <span class="lab">时长</span>
              <b class="num pv">{{ clockText }}</b>
              <!-- 暂停只说徽标一处；这一格不再跟一个「已停表」与它逐字重复 -->
              <span v-if="r.phase === 'running'" class="pu">计时中</span>
            </div>
            <div class="col center">
              <span class="lab">平均配速</span>
              <b class="num pv">{{ paceText }}</b>
              <span class="pu">/km</span>
            </div>
            <div class="col center kcal">
              <span class="lab">消耗</span>
              <b class="num">{{ r.kcal }}</b>
              <span class="pu">kcal</span>
            </div>
          </div>

          <div class="ctl row">
            <!-- 跑步中只允许暂停：结束必须在暂停之后，且要按住 5 秒（HoldToEnd）。 -->
            <template v-if="r.phase === 'running'">
              <button class="primary pausebtn" @click="r.pause()">暂停</button>
            </template>
            <template v-else>
              <button class="primary continuebtn" @click="r.resume()">继续</button>
              <HoldToEnd @done="onEndPick('finish')" />
            </template>
          </div>
        </div>
      </div>

      <!-- 总结页：成绩单（分段配速 / 爬升）+ 距离核对（可修正）后保存 -->
      <div v-else-if="r.phase === 'summary'" class="pane col center sumpane">
        <!-- 超范围平移层：同上（item 超伸）。总结屏内容比其它阶段长，
             所以这一屏取消居中（align-items/justify-content 覆盖回 flex-start）——
             居中会把顶部一截顶出可滚范围，用户以为没有更多内容。 -->
        <div class="rubber-layer sumlayer" data-rubber-content>
          <p class="donetitle">跑步完成</p>
          <!-- 结论单独一行（这一屏最该被读到的一句），日期与目标降为次要行 -->
          <div class="donemeta">
            <b class="donestate">{{ runState }}</b>
            <span class="donesub num">{{ fmtDateCn(todayStr()) }} · {{ goalLabel }}</span>
          </div>

          <!-- 四项指标：总时长 / 距离 / 平均配速 / 消耗。
               后三格由**生效距离**（改填值优先）驱动 —— 与写入记录同一把尺：
               改了距离屏幕必须跟着改，否则用户核对的是一份不存在的成绩单。
               配速与距离没测到时报「—」而不是 0：画成 0 会被读成「跑了个零」。 -->
          <div class="sumgrid">
            <div class="sumstat">
              <span class="sslabel">总时长</span>
              <b class="ssval num">{{ clockText }}</b>
            </div>
            <div class="sumstat">
              <span class="sslabel">距离<i v-if="kmOverridden" class="ssflag">手动</i></span>
              <b class="ssval num">{{ effKmText }}<i v-if="effKmText !== '—'" class="ssunit">km</i></b>
            </div>
            <div class="sumstat">
              <span class="sslabel">平均配速</span>
              <b class="ssval num">{{ avgPaceText }}<i v-if="avgPaceText !== '—'" class="ssunit">/km</i></b>
            </div>
            <div class="sumstat">
              <span class="sslabel">消耗</span>
              <b class="ssval num">{{ kcalApprox ? '≈' : '' }}{{ kcalText }}<i class="ssunit">kcal</i></b>
            </div>
          </div>
          <p v-if="kcalHint" class="hint left">{{ kcalHint }}</p>

          <!-- 记录说明：逐行说清这次「哪些段没算、哪些段补了」。取值互斥
               （每一段墙钟只落一个桶），同一段时间不会在两行里各说一遍。 -->
          <section v-if="runNotes.length > 0" class="sumcard">
            <h3>记录说明</h3>
            <p v-for="(n, i) in runNotes" :key="i" class="sumnote">{{ n }}</p>
          </section>

          <!-- 逐公里分段：跑步这一边唯一能回答「为什么这次这么快/这么慢」的地方。
               不可用时说清是「哪一档不可用」，而不是画一张空表。 -->
          <section v-if="showSplits" class="sumcard">
            <h3>逐公里分段</h3>
            <p class="hint left">每格依次是：公里序号、配速、爬升 ↑</p>
            <div class="splitrow">
              <span
                v-for="sp in runSplits"
                :key="sp.index"
                class="splitcell"
                :class="{ fast: isFastest(sp), slow: isSlowest(sp), sus: sp.suspect }"
              >
                <span class="spidx num">
                  {{ segLabel(sp) }}
                  <i v-if="sp.suspect" class="spwarn" role="img" aria-label="该段含长时间停顿，配速不可信">⚠</i>
                </span>
                <span class="sppace num">{{ fmtPace(sp.paceSecPerKm) }}</span>
                <!-- 爬升带单位：↑45 m。单位放独立元素，.spup 读数本身只承载数字 -->
                <span v-if="sp.ascentM > 0" class="spup-row num">
                  <span class="spup">↑{{ sp.ascentM }}</span><i class="spunit">m</i>
                </span>
              </span>
            </div>
            <p v-if="runPaceSpread" class="hint left">
              最快 {{ fastestPace }} · 最慢 {{ slowestPace }} · 相差 {{ fmtDuration(runPaceSpread) }}
            </p>
            <p class="hint left">{{ splitsFootnote }}</p>
          </section>
          <section v-else class="sumcard">
            <h3>逐公里分段</h3>
            <p class="hint left">{{ splitsHint }}</p>
          </section>

          <!-- 爬升：GPS 高程噪声很大，数字只在「有效点够、没有长弦」时才给 ——
               宁可说「定位不完整」，也不报一个自己都不信的数。 -->
          <section v-if="r.trackPoints.length > 1" class="sumcard">
            <h3>累计爬升（GPS 估算）</h3>
            <template v-if="runAscentAvailable">
              <p class="sumbig num">{{ runAscent ?? 0 }}<span class="ssunit"> m</span></p>
              <p v-if="runAscentRate != null" class="hint left">爬升率 · 每公里 {{ runAscentRate }} m</p>
            </template>
            <p v-else class="hint left">—（定位不完整）</p>
          </section>

          <label class="distfield row between">
            <span>距离（公里）</span>
            <input
              v-model="manualKmText"
              class="num"
              type="number"
              inputmode="decimal"
              step="0.01"
              min="0"
              max="999"
              placeholder="未测得，可补填"
            />
          </label>
          <p class="hint left">{{ distHint }}</p>
          <!-- 有断档/自动暂停时给一条捷径：轨迹是没被闸门丢点的原始记录，
               断档之后它比入账距离更接近实际跑量 -->
          <button v-if="canFixByTrack" class="ghost glass-surface glow-layer fixbtn" @click="fixByTrack">
            按轨迹距离 {{ (r.trackM / 1000).toFixed(2) }} km 修正
          </button>

          <button class="primary" @click="doSave">保存训练</button>
          <button class="ghost glass-surface glow-layer danger" @click="endOpen = true">放弃不保存</button>
        </div>
      </div>
    </main>

    <!-- 覆盖层：3·2·1 倒数 -->
    <CountdownOverlay :show="countdownOpen" label="" sub="准备开跑" :count-from="3" @done="countdownOpen = false; void onCountdownDone()" />

    <!-- 结束（二级确认）：只有这里才算正常结束。
         总结页那一次的标题要把「损失」写全（时长 + 距离），并给一条退路
         （继续核对）—— 在总结页误点放弃，丢的是一次已经跑完的记录。 -->
    <ActionSheet
      :open="endOpen"
      :title="endTitle"
      :actions="endActions"
      @select="onEndPick"
      @close="endOpen = false"
    />

    <!-- 有进行中的训练课：引导前往接续，防止覆盖 -->
    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练课，请先接续"
      :actions="[{ label: '前往继续', value: 'go' }]"
      @select="conflictOpen = false; openImmersive()"
      @close="conflictOpen = false; void router.replace('/sports')"
    />
  </div>
</template>

<style scoped>
.run-page {
  position: fixed;
  inset: 0;
  z-index: 80; /* 覆盖 TabBar(60) 与全部页面内容 */
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  /* fixed 定位不随 .app-frame 偏移，顶部安全区自行处理 */
  padding-top: var(--safe-top);
}

/* ---------- 暗区 · 轨迹剧场（满屏底图，抽屉覆盖下沿） ---------- */
.hero {
  position: absolute;
  inset: 0;
  background: var(--hero-bg);
  overflow: hidden;
  touch-action: none; /* 手势：单指平移 / 双指捏合，不触发页面滚动 */
}

/* 暂停压暗：用**遮罩层**而不是 filter。
   从前这一条是 `.run-page.paused .hero { filter: ... }` —— filter 会把整棵子树
   一起压暗，包括浮在上面的 chip 与徽标（它们表达的正是「暂停了，但定位/记录还在」，
   跟着变暗就把这条信息一起吃掉）。遮罩层落在 z-index:3：轨迹与网格（z 自动）沉下去，
   chip(4) / 顶栏(5) / 徽标(6) 原亮度留在上面。 */
.hero::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
  background: var(--scrim);
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-standard);
}

.run-page.paused .hero::after {
  opacity: 1;
}

/* 底图网格：向右上渐隐 */
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--hero-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-grid) 1px, transparent 1px);
  background-size: 44px 44px;
  -webkit-mask-image: radial-gradient(130% 110% at 62% 18%, #000 45%, transparent 100%);
  mask-image: radial-gradient(130% 110% at 62% 18%, #000 45%, transparent 100%);
}

.hero .map {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* 线宽/半径一律按 CSS px 写（viewBox 已与屏幕 1:1）：**上限 8px** ——
   任何缩放、任何 slice/系数都不许再把它放大（从前 stroke-width:5 被 slice 乘成 ~42 设备像素） */
.route {
  fill: none;
  stroke: var(--hero-route-line);
  stroke-width: 5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 6px var(--hero-route-glow));
}

.mk-start {
  fill: var(--hero-text);
  opacity: 0.85;
}

.mk-dot {
  fill: var(--surface);
  stroke: var(--hero-route-line);
  stroke-width: 3;
}

.mk-pulse {
  fill: none;
  stroke: var(--hero-route-line);
  stroke-width: 2;
  transform-box: fill-box;
  transform-origin: center;
  animation: ping 1.8s var(--ease-standard) infinite;
}

.run-page.paused .mk-pulse {
  animation-play-state: paused;
}

@keyframes ping {
  0% {
    transform: scale(1);
    opacity: 0.9;
  }
  100% {
    transform: scale(3);
    opacity: 0;
  }
}

.hero-wait {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  letter-spacing: 1px;
  color: var(--hero-text-dim);
}

/* 比例尺：静默的「尺子」——只读信息，不参与交互（pointer-events:none 别挡地图手势）。
   z-index 4 与 chip 同级：暂停压暗遮罩(3) 之上，读数不被吃掉。 */
.scalebar {
  position: absolute;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--gap-tight);
  pointer-events: none;
}

/* 括注式：一条下横线 + 两端竖脚，长度 = 该整距在屏幕上的真实长度 */
.sb-bar {
  height: 5px;
  min-width: 24px;
  border: 1.5px solid var(--hero-text-dim);
  border-top: none;
}

.sb-label {
  font-size: var(--fs-micro);
  line-height: 1;
  letter-spacing: 0.5px;
  color: var(--hero-text-dim);
  text-shadow: 0 1px 2px var(--scrim);
}

/* 顶栏（暗区上）—— 不再承载「结束」：见模板注释（改走底部滑动闸门） */
.shead {
  position: absolute;
  top: var(--safe-top);
  left: 0;
  right: 0;
  z-index: 5;
  height: 54px;
  padding: 0 var(--sp-18);
  background: linear-gradient(rgba(6, 6, 8, 0.55), rgba(6, 6, 8, 0));
}

/* 收起钮：命中区靠**自身盒高**做到 44px（不是靠伪元素外扩）。
   `position: relative` 仍然要写：只要哪天有人给它加 ::after 外扩，
   定位祖先必须是它自己而不是 .shead（那会把命中区摊到整条 54px 顶栏上，
   连标题和右端一起吞掉）。负外边距让文字左边界与顶栏内边距对齐 ——
   命中区变大了，视觉一动不动。 */
.min {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--gap-text);
  min-height: 44px;
  padding: 0 var(--sp-8);
  margin-left: calc(-1 * var(--sp-8));
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--hero-text);
}

.ptitle {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--hero-text-dim);
}

.ph {
  width: 48px;
}

/* 左上 HUD 一列：定位新鲜度 → 后台对账 → 通知提示。
   竖排而不是左右分挂：三行读的是同一件事的不同面（点多新 / 谁在记 / 通知通不通），
   眼睛不该在屏幕上跳两处。z-index 4 = 遮罩层（3）之上 —— 暂停时它们保持原亮度。 */
.hud {
  position: absolute;
  top: calc(var(--safe-top) + 62px);
  /* HUD 左缘对齐页面边距（16）：原来 14 与下方抽屉内容的左缘差 2px，
     暂停时两条竖线一上一下看着错位。 */
  left: var(--page-pad-x);
  z-index: 4;
  max-width: 64%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-sm);
}

/* 悬浮信息 chip —— 走 .glass-surface + .stage-dark 的暗场令牌
   （超高档的 halo/caustic/rim 在暗场里才有意义：亮色下的落影压在深色地图上
   才是"这块玻璃浮在画面之上"的重量感。手写 blur(14px) 拿不到那三层光学层，
   弱档也顶不掉 blur —— 都交给令牌。） */
.chip {
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-m);
  color: var(--hero-text);
}

.gps,
.stat,
.nudge {
  display: flex;
  align-items: center;
  /* 状态点 + 文字是「图标 + 文字」关系，取 --gap-text-inline（8），
     三枚 chip 里这一处原来 6 与 .nudge 的 8 混着用。 */
  gap: var(--gap-text-inline);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  text-align: left;
}

/* 四态：wait（还没落点）/ ok（新鲜）/ warn（中断）/ lost（已停累计）。
   颜色只用于"要不要看一眼"，文案本身不缩写 —— 变色但不说人话等于没说。 */
.gps.wait .gdot {
  background: var(--hero-text-dim);
}

.gps.ok .gdot {
  background: var(--hero-route-line);
  box-shadow: 0 0 8px var(--hero-route-glow);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.run-page.paused .gps.ok .gdot {
  animation-play-state: paused;
}

.gps.warn {
  color: var(--warn);
}

.gps.warn .gdot,
.gps.lost .gdot {
  background: var(--warn);
}

/* 第四态用 --hero-end 而不是 --warn-strong：后者在亮色档是 #8a5300
   （为 warn-soft 底设计的「橙字」），压在这块**固定近黑**的舞台上实测只有 ~3:1 ——
   而本页舞台的深色与系统配色无关（--hero-bg 亮暗同值），所以这里要的是暗场红。
   语义也没丢：--hero-end 就是这一块暗区自己的强调红。 */
.gps.lost {
  color: var(--hero-end);
}

.gps.lost .gdot {
  background: var(--danger);
}

.gdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hero-text-dim);
  flex: none;
}

/* 后台对账胶囊：中性色（它报的是状态，不是警报） */
.sdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hero-route-line);
  flex: none;
}

/* 通知提示：可点可关的一行，压暗一档不抢 GPS chip 的注意力 */
.nudge {
  position: relative;
  gap: var(--gap-sm);
  color: var(--hero-text-dim);
  font-weight: var(--fw-medium);
}

/* 关闭钮视觉 ~33 高，热区补到 44（规则 5）：上下各 6px 落在 HUD 的 8px 列距里，
   横向 4px 仍在页面 16px 边距之内。 */
.nudge::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-6)) calc(-1 * var(--sp-4));
}

/* 回前台对账横幅：托在暗区下沿（抽屉上缘之上 14px），
   z-index 与暂停徽标同级 —— 它要能被一眼看见，但不遮住 chip。 */
.gapban {
  position: absolute;
  z-index: 6;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(54% + 14px);
  max-width: min(340px, calc(100% - 28px));
  padding: var(--sp-10) var(--sp-16);
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  text-align: center;
  color: var(--hero-text);
}

/* 暂停徽标 —— 材质同 chip（.glass-surface + .stage-dark 令牌）。
   暂停是"运动被冻结"的状态，徽标要压得住画面：底色仍偏黑（stage-dark 令牌
   里 --glass-fill 就是 --hero-chip-bg），只是光学层与饱和度交给令牌统一管。
   文案由 pausedBadgeText 分叉：自动暂停说的是「动起来就恢复」，手动暂停说的是「已停表」。 */
.paused-badge {
  position: absolute;
  z-index: 6;
  left: 50%;
  top: 26%;
  transform: translate(-50%, -50%);
  padding: var(--sp-10) var(--sp-22);
  border-radius: var(--radius-full);
  color: var(--hero-text);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  letter-spacing: 1px;
}

.warn {
  position: absolute;
  top: calc(var(--safe-top) + 56px);
  left: 0;
  right: 0;
  z-index: 30;
  text-align: center;
  padding: var(--sp-4);
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  background: var(--warn-soft);
}

/* ---------- 亮区 · 可拖拽抽屉 ----------
   抽屉本身**不玻璃化**：它是大面积可滚动的内容载体，自身带 backdrop-filter
   会成为整棵子树的后备根，把里面每一块玻璃的采样范围都锁死在抽屉自己的内容上
   （同 DesktopInspector 的取舍）。所以它保持不透明底，玻璃交给把手行上的
   离散控件与浮在上面的 HUD chip。
   丰富档的滚动边缘暗带挂在上缘：内容滚起来时把这条边抬离移动的内容。 */
.drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  top: 46%;
  z-index: 10;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  /* 抽屉是顶层浮层：顶部圆角按规范取 32（--radius-xl），与其它半模态一致。 */
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-float);
  overflow: hidden;
  transform: translateY(0);
  transition: transform var(--dur-sheet) var(--ease-standard);
}

html[data-motion='rich'] .drawer::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 22px;
  pointer-events: none;
  opacity: 0;
  z-index: 2;
  background: linear-gradient(to bottom, var(--glass-scroll-edge), transparent);
  transition: opacity var(--dur-base) var(--ease-standard);
}

html[data-motion='rich'] .drawer.is-scrolled::before {
  opacity: 1;
}

/* 收起档：只露出 peek（把手 + 时长/距离 hero 行）。
   收起比展开短一档（.drawer 基础规则是 dur-sheet）——展开是"生长"，收起只是让位；
   :not(.dragging) 让拖拽中不挂过渡，位移只跟手指 */
.drawer.collapsed:not(.dragging) {
  transform: translateY(calc(100% - 176px));
  transition: transform var(--dur-base) var(--ease-standard);
}

.drawer.dragging {
  transition: none;
}

.run-page.ready .drawer {
  top: 26%;
}

.run-page.summary .drawer {
  top: 32%;
}

/* 把手行：拖拽条 ｜ 缩放模式切换（回中钮已删，见模板注释） */
.handle {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 把手行是抽屉的页头：左右 16（--pad-sheet），与 .pane 的内容边同一条线。 */
  gap: var(--gap-sm);
  padding: var(--sp-8) var(--pad-sheet) var(--sp-4);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.grab {
  flex: 1;
  /* 半模态把手按规范收到 32×4、正圆角：原来 44×5 + 4 圆角读起来是一条小横杠 */
  max-width: 32px;
  margin: 0 auto;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--line);
}

/* 相机模式切换：两段分段控件 —— 轨道走 .glass-surface（抽屉上的浮玻璃），
   滑块在丰富档换成 GlassThumb（液态融合 + 形变），与 SegmentedControl 同一套做法。 */
.mseg {
  position: relative;
  display: flex;
  gap: var(--gap-text);
  /* 分段按钮整体 32（规则 4）：内缩 2 后段高 28（--control-sm），
     GlassThumb 的模糊半径也按 32 推（容器高度的 14%），与 SegmentedControl 同档。 */
  min-height: var(--sp-32);
  padding: var(--sp-2);
  /* 滑块内缩跟 32 的轨道走：与 common/SegmentedControl 的 .seg.goo 同值 */
  --thumb-inset-y: var(--sp-2);
  --thumb-inset-x: var(--sp-2);
  border-radius: var(--radius-m);
  /* 裁掉 goo 的模糊外溢。用 clip + clip-margin 而不是 hidden：hidden 会把按钮
     外扩的 44px 命中区一起裁掉（旧写法实测只剩 ~2px）；clip-margin 把裁切边
     向外放 8px，模糊照样不出轨道，命中区与焦点环却能完整保留。 */
  overflow: hidden;
  overflow: clip;
  overflow-clip-margin: var(--gap-sm);
}

/* 丰富档：滑块落在这条**玻璃轨道**上，所以用半透 blob 语义（不覆写令牌），
   融合时能看到它与轨道玻璃的通透关系。 */
.mseg button {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--sp-10);
  border-radius: var(--radius-s);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

/* 触控目标：段高 28，靠伪元素上下各外扩 8px 凑满 44。
   用 **::before** 而不是 ::after —— `.glow-layer` 已经占着 ::after 画按压光晕
   （base.css），两条规则会在同一个伪元素上抢位置；padding 也不能动，
   GlassThumb 的 blob 几何按容器高度推（文件头第 3 条）。 */
.mseg button::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: calc(-1 * var(--sp-8));
  bottom: calc(-1 * var(--sp-8));
}

.mseg button.on {
  color: var(--text-1);
}

/* 默认档：没有 goo 滤镜，纯色滑块常驻；丰富档由 GlassThumb 接管并压掉这块 */
.mseg:not(.goo) button.on {
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.mseg.goo button.on {
  background: transparent;
  box-shadow: none;
}

.pane {
  flex: 1;
  min-height: 0;
  /* 抽屉内容区：左右 16（--pad-sheet）与页脚操作区同一条线，块与块之间 16。
     原来左右 28 是全仓最宽的一档，面板里的读数与页脚按钮不在一条竖线上。 */
  gap: var(--gap-lg);
  padding: var(--sp-16) var(--pad-sheet) calc(var(--sp-28) + var(--safe-bottom));
  overflow-y: auto;
}

/* 超范围平移层：镜像 .pane 的弹性列布局（只承载 transform，不改观感）。
   flex:1 让内容不足一屏时由它占满容器、居中与原来一致；内容超一屏时按内容撑高，
   滚动照常，且不会再出现「居中把顶部一截顶出可滚范围」的老问题。 */
.rubber-layer {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* 与 .pane 的块间距同一档（16），否则平移层里的内容比滚动时松/紧一截。 */
  gap: var(--gap-lg);
}

.eyebrow {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.6px;
  color: var(--text-3);
}

.seg {
  width: min(300px, 100%);
}

.goalbox {
  align-items: baseline;
  /* 大字读数与两侧步进钮之间 16（有明显边界的控件间），原来 14 不在一档上 */
  gap: var(--gap-lg);
  margin-top: var(--gap-sm);
}

/* 目标步进钮：控制层小胶囊 —— 材质走 .glass-surface，这里只补几何 */
.gbtn {
  align-self: center;
  min-width: 64px;
  height: 44px;
  border-radius: var(--radius-l);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.gbtn:disabled {
  opacity: var(--disabled-opacity);
}

.gval {
  font-size: var(--fs-display-2xl);
  /* 字重阶梯下限是 300（--fw-light）：200 是阶梯外的裸值，56px 上肉眼差不到半像素。 */
  font-weight: var(--fw-light);
  letter-spacing: -2px;
  line-height: 1;
  min-width: 110px;
  text-align: center;
}

.gunit {
  font-size: var(--fs-callout);
  color: var(--text-2);
}

/* hero 行的说明行：只说这行大字是什么（距离）。
   13px/--text-2：它是「这行大字在说什么」的唯一线索，必须读得清 ——
   从前的 12px/--text-3 在深色抽屉底上只有 3.6:1，暂停时更要紧。
   暂停的原因只说暂停徽标一处，这一行在暂停态也说「本次距离」，不逐字重复。 */
.tcap {
  font-size: var(--fs-footnote);
  letter-spacing: 0.5px;
  color: var(--text-2);
  margin-top: var(--sp-8);
}

.meta {
  max-width: 320px;
  text-align: center;
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
  text-align: center;
}

.hint.left {
  align-self: stretch;
  text-align: left;
  margin: calc(-1 * var(--sp-8)) 0 0;
}

/* 开始跑步：全屏那颗最大的离散控件 —— 走玻璃材质（模板上的 .glass-surface）。
   3px 描边收成 1px 透明边框（受光边由背景渐变画出，硬描边会盖掉它），
   悬停仍翻成实底 —— 那是"确认要开始了"，不该被半透明削弱。
   Play 图标 + 「开始跑步」是图标与标签：文字走 --text-1（色彩配额，STANDARDS §4）。
   原为写死的 #3d7a00 绿（另有一条暗色档覆写翻成 --c-exercise）—— 两档都是
   「彩色文字」，且那支绿还是魔法值；统一收成中性色后，暗色档覆写成为冗余，删。 */
.gobtn {
  width: 216px;
  height: 216px;
  margin-top: var(--sp-10);
  border-radius: 50%;
  color: var(--text-1);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-6);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  transition:
    transform var(--dur-base) var(--ease-standard),
    background-color var(--dur-base) var(--ease-standard),
    color var(--dur-base) var(--ease-standard);
}

/* hover 只在真悬停设备生效（触屏上点一下会粘在反色态，误以为已进入确认） */
@media (hover: hover) {
  .gobtn:hover {
    background: var(--c-exercise);
    color: var(--hero-bg);
  }
}

.gobtn:active {
  transform: scale(0.95);
}

/* 进行中：内容贴顶（收起档 peek 正好露出 hero 行），控制行沉底。
   底距提到 46px：控制行必须落进单手可达区（真机 1220×2712/DPR3 下控件下沿 ≤864 CSS px），
   而 .pane 的 30px 在没有底部安全区的机型上会让它落到 874。 */
.live {
  justify-content: flex-start;
  padding-bottom: calc(46px + var(--safe-bottom));
}

/* hero 行与指标卡必须同宽同位：默认的「居中列」让每一块按自己的内容宽各自居中，
   时长的墨水左边界会飘在卡片左边缘右边。stretch 把这一层撑到面板满宽，
   内部所有 100% 宽的块（hero 行 / 目标条 / 指标卡）就共享同一条左边线 ——
   这条在暂停帧尤其要紧：切换不许重排。 */
.live .rubber-layer {
  align-self: stretch;
}

/* hero 行：左距离（84/600，主读数）右瞬时配速（44/700，次读数）。
   两者一行落定；其余指标退到三列卡。 */
.livehero {
  width: 100%;
  align-items: flex-end;
}

.lh-l {
  min-width: 0;
}

.lh-line {
  display: flex;
  align-items: baseline; /* 数字与单位共基线：单位不上浮成上标 */
}

.lh-dist {
  font-size: var(--fs-display-xl);
  font-weight: var(--fw-semibold);
  letter-spacing: -2px;
  line-height: 0.95;
  /* 数字首字的左轴承按 -0.02em 补掉：截图要比「距离墨水的左边界」与「指标卡左边缘」
     严丝合缝，侧轴承那 ~1.7px 正是差出来的那一点 */
  margin-left: -0.02em;
  color: var(--text-1);
}

.lh-r {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  white-space: nowrap;
}

/* 右侧说明行：与左侧「本次距离」共用 .tcap 的字号/上边距，
   只补一条右对齐 + 呼吸点的排布 —— 两个标签的底边由 hero 行的
   align-items:flex-end 对齐，读数在上、说明在下。 */
.lh-r-cap {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-6);
}

/* 瞬时配速：自动暂停时不再产生新值，留住停表前的读数并压暗表示「这是上一刻的」 */
.lh-pace {
  font-size: var(--fs-display-l);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  line-height: 1;
  color: var(--text-1);
}

.lh-pace.dim {
  opacity: 0.5;
}

.lh-unit {
  font-size: var(--fs-footnote);
  font-style: normal;
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  margin-left: var(--sp-4);
}

/* 目标进度：满宽一条 + 13px 标签。'open' 目标下整行不渲染（见模板） */
.goalrow {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.goalhead {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.gpct {
  color: var(--text-1);
}

.gbar {
  height: 6px;
  border-radius: var(--radius-xs);
  background: var(--line-strong);
  overflow: hidden;
}

.gbar i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-xs);
  background: var(--c-exercise-deep);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  /* 1s linear 保留：入账是 1s 一次的阶跃，linear 把台阶抹成匀速 ramp；
     换 ease 会让每次 retarget 都多一处速度断点 */
  transition: clip-path 1s linear;
}

/* 三列指标卡：瞬时配速｜平均配速｜消耗。材质走 .glass-surface（抽屉里最大的一张数据卡）。
   字色纪律（验收项）：卡内不出现 10/11/12px，也不出现 --text-3 ——
   标签与单位一律 13px/--text-2，值 34px/700 的 --text-1。 */
.pace {
  width: 100%;
  /* 数据卡统一走卡片档 16（--radius-m）：与 .sumstat 同层同档。 */
  border-radius: var(--radius-m);
  overflow: hidden;
}

.pace > div {
  flex: 1;
  min-width: 0;
  /* 三格内距上下对称 16（--pad-card），左右 8 给三列均分留宽度。 */
  padding: var(--pad-card) var(--sp-8);
  gap: var(--gap-tight);
}

.pace > div + div {
  border-left: 0.5px solid var(--line);
}

.pace .lab {
  display: flex;
  flex-direction: row;
  align-items: center;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.4px;
  color: var(--text-2);
  gap: var(--sp-6);
  white-space: nowrap;
}

.live-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--c-exercise);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.run-page.paused .live-dot {
  animation-play-state: paused;
}

.pace .pv {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  color: var(--text-1);
}

/* 自动暂停时不再产生新值：留住停表前的读数，压暗表示「这是上一刻的」——
   清零会把「暂停前跑多快」一起抹掉，那是另一条信息。 */
.pace .pv.dim {
  opacity: 0.5;
}

.pace .pu {
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

/* 消耗列（沿用 .kcal 这个名字：它本来就是这张卡的第三格） */
.kcal {
  text-align: center;
}

.kcal b {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  color: var(--text-1);
}

.ctl {
  width: 100%;
  /* 控制行是按钮组：两颗都带明确边界（继续 / 长按结束），按钮组之间 16。 */
  gap: var(--gap-lg);
  justify-content: center;
  margin-top: auto;
}

/* 主按钮：实底是**语义选择**不是玻璃 —— 保持"这一屏唯一的主行动"最高对比层级 */
.primary {
  min-width: 240px;
  height: 54px;
  padding: 0 var(--sp-36);
  /* 大主行动 = 胶囊（距 48 以上一律全圆），与卡片 16 / 浮层 32 分开 */
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  box-shadow: var(--shadow-float);
}

/* 进行中的暂停键：几何是验收项（200×56），要盖掉 .primary 的 240/54。
   选择器带上 .primary 是为了不靠源码顺序取胜 —— 两条规则同特指度时
   谁在后谁赢，那种依赖迟早会被一次重排弄坏。 */
.primary.pausebtn {
  width: 200px;
  min-width: 200px;
  height: 56px;
  flex: none;
}

/* 暂停态：继续与长按结束并排。继续不再是全宽主按钮 —— 这一屏的主行动
   已经从「继续」转到「结束这次记录」，两者各占一半，避免 240px 起宽把
   长按闸门挤出抽屉。 */
.primary.continuebtn {
  flex: 1;
  min-width: 0;
  height: 56px;
  padding: 0 var(--sp-14);
}

/* 次按钮：控制层玻璃 —— 材质走 .glass-surface（全仓一份定义），这里只补几何 */
.ghost {
  height: 50px;
  /* 与主行动同一档：控制行里两颗按钮形态必须一致，只有材质不同 */
  border-radius: var(--radius-full);
  padding: 0 var(--sp-24);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ghost.danger {
  color: var(--danger);
}

/* ---------- 准备页：自动暂停开关 + 定位就绪行 ---------- */

/* 与目标同级的设置行：左文右开关（开关自己是 51×31 的受控组件，
   行高由它的文案撑开）。 */
.pfrow {
  width: min(320px, 100%);
  gap: var(--gap-md);
  margin-top: var(--sp-4);
}

.pf-l {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  min-width: 0;
  text-align: left;
}

.pf-lab {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.pf-desc {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 定位就绪行：13px 二级色。它是这一屏唯一敢说「锁屏也继续记录」的地方，
   所以给足字号 —— 承诺的话要能读清（能不能说由 readyLine 判定）。 */
.pf-line {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  text-align: center;
}

/* 预检降级：照跑，但这一句必须比普通 hint 更显眼（它说的是这次会缺什么） */
.warnhint {
  color: var(--warn-strong);
  max-width: 300px;
}

/* 总结 */
/* 头部不再用 emoji：大标题直接开口，与力量总结页同一套语言
   （title1 标题 + caption 元信息行）。44px 的 emoji 在卡片化版式里
   是信息量为零的占位，还把标题往下顶了一截。 */
.donetitle {
  font-size: var(--fs-title1);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
}

/* 总结屏副行：完成状态是结论，单独一行加粗；日期与目标降为次要行 ——
   从前同字号同字重「·」串一行，最该读到的结论混在日期与目标里。
   与标题同左对齐（头部是一段左起的开场白，结论行居中会与标题错位） */
.donemeta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-text);
  margin-bottom: var(--sp-4);
}

.donestate {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.donesub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* ---------- 总结屏 ----------
   卡片用**亮色面**（--surface / --surface-2 一族），不是 --hero-chip-bg。
   理由：总结屏的底是 .run-page 的 var(--bg)（亮色 #f5f5f7），
   轨迹剧场（.hero，绝对定位满屏）只在它**下面**当背景纹理透出来。
   早先按「这是暗区」用了半透明深色卡片，结果一块块深灰压在浅底上，
   整屏像蒙了层脏 —— 半透明的深色压在浅底上必然发灰，与它下层是什么无关。 */

.sumpane {
  /* 取消滚动容器自身的居中：.pane 带 .center（justify-content:center），
     内容超高时居中溢出会把顶部顶进**不可滚动区**（scrollTop 够不到）——
     旧版这一截吃掉的是 emoji，头部改短后轮到标题被整个卷出去。
     内层 .rubber-layer 自带 flex:1，内容不足一屏时仍由它撑满并保持观感。 */
  justify-content: flex-start;
  padding-bottom: calc(30px + var(--safe-bottom));
}

/* 取消居中：内容长，居中会把顶部一截顶出可滚范围（用户以为没有更多）。
   保留 .pane 自己的 flex:1，让内容不足一屏时仍占满（滚动终点才确定）。 */
.sumlayer {
  justify-content: flex-start;
  align-items: stretch;
  max-width: 360px;
  text-align: left;
}

/* 四项指标 */
.sumgrid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  /* 四格指标之间 8（无边界控件间距）。 */
  gap: var(--gap-sm);
  width: 100%;
}

/* 窄机型（<360 CSS px）回退 2×2：四格并排时「5'30"」+「/km」在 62px 里会挤出去，
   nowrap 会把数字顶出格子。360 以上（含真机 407）保持四格一排。 */
@media (max-width: 359px) {
  .sumgrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* 四格指标与力量总结页同一套语言：灰砖面（--surface-2）、嵌套圆角 12、
   左对齐（标签在上、读数在下）—— 从前白卡描边居中的「表单格」观感就来自这里。 */
.sumstat {
  background: var(--surface-2);
  border-radius: var(--radius-m-nest);
  padding: var(--sp-8) var(--sp-10);
  min-width: 0;
  text-align: left;
}

.sslabel {
  display: block;
  font-size: var(--fs-footnote);
  color: var(--text-2);
  white-space: nowrap;
}

/* 改填距离的小标：它解释的是「这一格为什么与轨迹对不上」，
   所以挨着「距离」的标签而不是值（值那一格要给数字留宽度）。 */
.ssflag {
  font-style: normal;
  font-weight: var(--fw-semibold);
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-left: var(--sp-4);
}

.ssval {
  display: block;
  /* 与力量总结页的副指标格同一档（title3）：四屏两页的「一格数字」是一条刻度 */
  font-size: var(--fs-title3);
  font-weight: var(--fw-semibold);
  margin-top: var(--sp-2);
  color: var(--text-1);
  letter-spacing: -0.3px;
  /* 配速「5'30"」+「/km」在四格并排时是最长的一格：折行会把卡片撑高一档，
     nowrap + 上面那条窄屏 2×2 回退一起保证它不被折断 */
  white-space: nowrap;
}

.ssunit {
  font-size: var(--fs-footnote);
  font-style: normal;
  font-weight: var(--fw-regular);
  color: var(--text-2);
  margin-left: var(--sp-2);
}

/* 记录说明卡逐行：12px，说的是「哪段没算、哪段补了」—— 比卡片标题低一档但必须读得清 */
.sumnote {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

/* 分段 / 爬升卡 */
.sumcard {
  width: 100%;
  background: var(--surface);
  border: 0.5px solid var(--line);
  /* 总结页的卡片与 .sumstat / .pace 同一档圆角 16，不再混用 20。 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  /* 卡内距与力量总结页同一档（--pad-card 16）：两页卡片是同一套材质 */
  padding: var(--pad-card);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.sumcard h3 {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  letter-spacing: 0.4px;
  color: var(--text-2);
  text-align: left;
}

.sumbig {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: 1.1;
}

/* 逐公里分段：横向一排等宽格，横向滚。
   `flex: none` 要加在**格子**上而不是里面的文字上 —— flex 项是格子，
   只钉内部文字的话格子仍会被压缩，配速数字就会折行。 */
.splitrow {
  display: flex;
  /* 分段格之间 8，与四格指标同档。 */
  gap: var(--gap-sm);
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: var(--sp-2);
}

.splitrow::-webkit-scrollbar {
  display: none;
}

.splitcell {
  flex: none;
  min-width: 62px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-text);
  /* 段格内距上下对称 8：格子里是「公里数 / 配速 / 爬升」三行同组信息。 */
  padding: var(--sp-8);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.spidx {
  display: flex;
  align-items: center;
  gap: var(--gap-text);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

/* 段内停过（任一步 Δt≥30s 或隐含速度<0.4 m/s）：配速不可信，标出来并且不参与配色。
   ⚠ 用的是文字色而不是背景 —— 它要和「最快/最慢」的底色标记共存，抢底色会读串。 */
.spwarn {
  font-style: normal;
  color: var(--warn-strong);
}

.sppace {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: 1.15;
}

.spup {
  font-size: var(--fs-micro);
  /* 用 --ok-strong 而不是 --c-exercise-deep：
     后者是模块色的深档（运动橙），用来当「爬升」的文字色会与运动主色撞在
     同一屏里；--ok-strong 才是为「底上的绿字」留的一档，亮暗两档都过 3:1。
     上箭头「↑」本身已经说明了「爬升」，颜色不承担语义。 */
  color: var(--ok-strong);
}

/* 爬升的单位（m）与读数同行：.spup 只承载数字，单位放独立元素 */
.spup-row {
  display: flex;
  align-items: baseline;
  gap: var(--gap-text);
}

.spunit {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--ok-strong);
}

/* 最快 / 最慢：靠底色 + 左侧色条区分，文字色保持 --text-1 ——
   绿字压绿底在任何组合下都到不了 4.5:1（实测最好 3.7:1），
   所以「哪公里最快」由底色说，不让文字去承担。 */
.splitcell.fast {
  background: color-mix(in srgb, var(--pace-fast) 18%, var(--surface));
  box-shadow: inset 2px 0 0 var(--pace-fast);
}

.splitcell.slow {
  background: var(--surface-2);
  box-shadow: inset 2px 0 0 var(--text-3);
}

/* 可疑段：压一层中性底把「有瑕疵」说出来，但**不进** fast/slow 的配色体系 */
.splitcell.sus {
  background: color-mix(in srgb, var(--warn) 10%, var(--surface-2));
}

.sumcard .hint {
  text-align: left;
  color: var(--text-2);
}

/* 按轨迹距离修正：次按钮，但落在总结页的窄卡里要能整行放得下 */
.fixbtn {
  align-self: stretch;
}

.distfield {
  width: min(340px, 100%);
  gap: var(--gap-md);
  padding: var(--sp-12) var(--sp-16);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.distfield input {
  width: 130px;
  text-align: right;
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  background: transparent;
}

.distfield input::placeholder {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}
</style>
