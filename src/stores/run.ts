/**
 * 跑步会话状态机 v2。
 *
 * 落盘复用 workout_sessions（plan_id = RUN_PLAN_ID），与训练课共用同一套
 * 「active 行 = 未正常结束」不变量：只有保存/放弃（结束键 + 二级确认）
 * 会关闭会话；其余一切离开方式按异常中断处理，恢复时**自动接续**上一段跑步
 * （轨迹、时长、距离、暂停桶全部继承，只给一次气泡提醒，不再弹核对卡）。
 *
 * 采集真源（契约 A，唯一判定 tracking_status.native）：
 *  · Android（native=true）：原生前台服务是唯一真源——时长/距离/配速/轨迹都从
 *    原生 live 快照（1 Hz pull 为准 + 推送做秒级平滑）与轨迹文件来；WebView
 *    **不开** navigator.geolocation（两源同采会双计）。原生静默失败（30s 内无
 *    首个 fix / 连续 60s 无新 fix）→ 两级降级：
 *      · 一级：nativeDegraded=true，保留服务与常驻通知（进程仍被保活），web 采集
 *        接管；播种 accumMs/segStartedMs/distanceM 防时长虚增。
 *      · 二级：服务确认不可用（runBegin 连续失败 / runEnd 后仍无服务）→ runEnd
 *        停服务（通知消失）。**二级分支仅前台有效、无实时通知，属产品折中。**
 *    降级**单向不回退**：原生即使恢复吐点也不回升，避免双源合并双计。
 *  · 桌面/浏览器（native=false）：沿用 WebView 内的 watchPosition 采集（本地闸门
 *    + 自动暂停状态机），行为与旧版一致；原生不可用时优雅回退到这里。
 *  · 永久开发覆盖：localStorage['rein.run.forceWeb.v1']==='1' 时本轮恒用 web 采集
 *    （native 构建也可用，用来在真机上验证降级后的 web 路径；mock 下 native 本就是
 *    false，不需要它）。web 采集源可注入 window.__reinGeoDriver，形状见 A4 契约。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { estimateRunKcal } from '@/config/domain'
import { sessionService } from '@/services/sessionService'
import { fmtClock, fmtPace } from '@/utils/format'

export { fmtClock, fmtPace }
import { FALLBACK_LIVE, trackingService } from '@/services/trackingService'
import { useToast } from '@/composables/useToast'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { PACE_STALE_SEC, RunGate } from '@/stores/runGate'
import { todayStr } from '@/utils/date'
import { trackLengthM } from '@/utils/geo'
import { RUN_PLAN_ID } from '@/types'
import type {
  NativeRunLive,
  NativeRunPoint,
  TrackingRunConfig,
} from '@/services/trackingService'
import type { Intensity, RunGoalKind, RunSnapshot, RunTrackPoint, SessionRecord } from '@/types'

export type RunPhase = 'idle' | 'ready' | 'running' | 'paused' | 'summary'
export type GpsStatus = 'off' | 'acquiring' | 'active' | 'unavailable'

/* ---------- 闸门与判定阈值（契约 K/L 的唯一数值表，见 stores/runGate.ts） ---------- */

/**
 * web 采集路径的防抖/判定/自动暂停全部由 `RunGate`（stores/runGate.ts）承担 —— 常量、
 * 公式、状态机与 Kotlin `RunAutoPause.kt::RunCore` / Rust `model.rs::spec` 逐字同值。
 * 本文件只负责把它的结论镜像进响应式 ref、写轨迹、记账与降级接线。
 */

/** 无新被接受 fix 超过它 → 瞬时配速置 null（同一张表：runGate.PACE_STALE_SEC） */
const PACE_STALE_MS = PACE_STALE_SEC * 1000
/** 回前台后的看门狗宽限：先 drain 原生快照，再允许用「无新 fix」判定降级 */
const NATIVE_RESUME_GRACE_MS = 20_000
/** 轨迹落盘抽稀上限（点）：控制 state_json 体积（800 点 ≈ 2 小时跑步） */
const MAX_SNAPSHOT_POINTS = 800
/** 抽稀时间桶：5s 内只留最后一个点 */
const SNAPSHOT_BUCKET_MS = 5000

const AUTO_PAUSE_KEY = 'rein.run.autoPause.v1'
const FORCE_WEB_KEY = 'rein.run.forceWeb.v1'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 自动暂停开关（缺省 true）；隐私模式下 localStorage 不可用，按缺省处理 */
function readAutoPauseOn(): boolean {
  try {
    return localStorage.getItem(AUTO_PAUSE_KEY) !== '0'
  } catch {
    return true
  }
}

/** 开发覆盖：真机上验证降级后的 web 路径（见文件头） */
function forceWeb(): boolean {
  try {
    return localStorage.getItem(FORCE_WEB_KEY) === '1'
  } catch {
    return false
  }
}

/** web 采集源形状（冻结契约 A4）：真机/自动化可注入 window.__reinGeoDriver */
interface GeoFix {
  coords: {
    latitude: number
    longitude: number
    accuracy: number
    altitude?: number | null
    altitudeAccuracy?: number | null
  }
  timestamp: number
}

interface GeoSource {
  watchPosition(
    cb: (pos: GeoFix) => void,
    err?: (e: unknown) => void,
    opts?: PositionOptions,
  ): number
  clearWatch(id: number): void
}

declare global {
  interface Window {
    /** web 采集源注入（缺省 navigator.geolocation） */
    __reinGeoDriver?: GeoSource
    /** 原生推送通道（Kotlin → JS，契约 F）：push 只做秒级平滑，pull 为准 */
    __reinRunLive?: (payload: unknown) => void
    __reinRunPoint?: (payload: unknown) => void
  }
}

export const useRunStore = defineStore('run', () => {
  const phase = ref<RunPhase>('idle')
  const goalKind = ref<RunGoalKind>('open')
  const goalTimeMin = ref(30)
  const goalDistanceKm = ref(5)

  const sessionId = ref<number | null>(null)
  const startedAtIso = ref('')
  /** 已累计运动毫秒（不含当前 running 段；native 真源下由原生快照镜像） */
  const accumMs = ref(0)
  /** 当前 running 段起点（epoch ms） */
  let segStartedMs = 0

  const distanceM = ref(0)
  /**
   * 显示专用低滞后距离（hero 主视觉；**不是真源**）：单调不减，只喂 hero 距离数字，
   * 不落盘、不参与任何判定/结算/改填比对文案。web 侧由 runGate.dispM（快通道）喂养，
   * native 侧由 live.dispM / live.distanceM 喂养 —— 每被接受 fix 一次即刷新（≤1s）。
   */
  const distDisplayM = ref(0)
  /** 抬高显示距离（只增不减；跨 run 由 begin/resetLocal 归零、applyRecord 播种） */
  function bumpDisplay(m: number): void {
    if (m > distDisplayM.value) distDisplayM.value = m
  }
  const gpsStatus = ref<GpsStatus>('off')
  const persistError = ref('')
  /**
   * 最近一次保存/放弃本身失败（写库未成功）。与 persistError 同族：原样抛给
   * 调用点 toast 原因，本地**不**收尾 —— 总结态保留、会话仍 active，可原样重试。
   */
  const finishError = ref('')
  /** 服务端存在进行中的训练课（非跑步）→ RunPage 弹「前往继续」 */
  const courseConflict = ref(false)
  /** 轨迹面包屑（仅 running 时记录；t=累计运动毫秒、alt=GPS 海拔，供详情页分段配速/爬升） */
  const trackPoints = ref<RunTrackPoint[]>([])
  /** 瞬时配速（秒/公里，EMA 平滑）；停跑过久或无定位时为 null */
  const paceInstantSecPerKm = ref<number | null>(null)

  /* ---------- 采集真源与降级（契约 A） ---------- */

  /** 原生采集能力（preflight()/begin() 各读一次 tracking_status；桌面/mock 恒 false） */
  const nativeReady = ref(false)
  /** 一级降级已发生：source 落回 web 且**单向不回退**（避免双源合并双计） */
  const nativeDegraded = ref(false)
  /** 二级降级：前台服务确认不可用（仅前台有效、无实时通知；产品折中，视图需明示） */
  const nativeServiceDown = ref(false)
  /** 原生快照镜像（native 真源的时长/距离唯一来源） */
  const nativeElapsedMs = ref(0)
  const nativeDistanceM = ref(0)
  /** 自动暂停中（web 状态机 / native live 镜像共用一个字段） */
  const autoPaused = ref(false)
  const pauseCause = ref<'manual' | 'auto' | null>(null)

  /** 最近一次 fix 的墙钟时间（native = live.lastFixMs；web = pos.timestamp） */
  const lastFixAt = ref(0)
  const lastFixAccM = ref(0)
  /** 本轮开跑墙钟（begin()/applyRecord 置）：首个 fix 之前 fixWaitSec 的起算点 */
  const runStartedAtMs = ref(0)

  /** 自动暂停开关与阈值（随快照保留；缺省 600 = 10'00"/km） */
  const autoPauseOn = ref(readAutoPauseOn())
  const autoPausePaceSec = ref(600)

  /** 手动暂停段墙钟（ms）+ 次数 */
  const manualPauseMs = ref(0)
  const pauseCount = ref(0)
  /** 自动暂停状态机段（与 gapMs 互斥：>10s 空窗一律归 gap 桶） */
  const autoPauseMs = ref(0)
  const autoPauseCount = ref(0)
  /** >10s 空窗段（web 明细 + native 镜像的 per-class 计数） */
  const gapMs = ref(0)
  const gapSlowMs = ref(0)
  const gapFastMs = ref(0)
  const gapDropMs = ref(0)
  const gapSlowCount = ref(0)
  const gapFastCount = ref(0)
  const gapDropCount = ref(0)
  /** web 空窗明细（≤40 条；native 恒空——per-class 计数由 live 镜像） */
  const gaps = ref<{ t: number; ms: number; why: 'slow' | 'fast' | 'drop' }[]>([])
  /** d>dMax 被丢弃的跳变次数 */
  const jumpCount = ref(0)
  /** 切后台回来的空窗提示：ms=离线墙钟，credited*=期间实际入账（独立量，不互相推导） */
  const gapNotice = ref<{ ms: number; atMs: number; creditedM: number; creditedMs: number } | null>(
    null,
  )

  /** 响应式时钟：running 时 250ms 一跳，驱动所有时间派生值 */
  const nowTick = ref(Date.now())

  let tickTimer: ReturnType<typeof setInterval> | null = null
  let persistTimer: ReturnType<typeof setInterval> | null = null
  let watchId: number | null = null
  /** 手动暂停段起点（epoch ms；0 = 不在手动暂停） */
  let manualPausedWallMs = 0
  /** 轨迹 t 单调不减的下限 */
  let pointLastT = 0
  /** 快照落盘抽稀标记：本数组已是从抽稀快照恢复的 → 直接返回（幂等） */
  const trackDecimated = ref(false)
  /** save() 写进快照的最终距离（总结页核对值） */
  const finalKmSnap = ref<number | null>(null)
  /** 结束流程里「取轨迹 → 停服务 → 再取轨迹」的一次性流水（save 前 await） */
  let trackDrain: Promise<void> | null = null

  /* ---------- web 采集状态（含降级接管）：防抖/判定全在 RunGate ---------- */

  /** 新建闸门：阈值取当前自动暂停设置（缺省 600/540 → 1.6667/1.8519 m/s） */
  function newGate(baselineElapsedMs = 0, baselineDistM = 0): RunGate {
    const { enter, exit } = autoPauseThresholds()
    return new RunGate(enter, exit, baselineElapsedMs, baselineDistM)
  }

  /** web 采集闸门（K/L 口径的纯逻辑，常量/公式/状态机见 stores/runGate.ts） */
  let gate = newGate()
  /** 下一个落点是否 brk（手动暂停恢复后的轨迹断点；空窗/自动暂停的 brk 由 gate 给） */
  let webMarkBrk = false
  /** 上一个被 gate 接收的 fix 时刻（空窗 slow/drop 的墙钟结账用） */
  let webLastFixT = 0
  /** 方向防抖触发校正的次数（与原生 logcat 的 jc= 同义）：诊断与验收断言用 */
  const jitterCorrections = ref(0)

  /* ---------- 原生通道/看门狗状态 ---------- */

  let nativePollTimer: ReturnType<typeof setInterval> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let watchdogStartWall = 0
  let watchdogLastFixMs = 0
  let watchdogLastFixWall = 0
  /** 上一拍看门狗的实际墙钟：周期被冻结后（熄屏/后台）用它识别「这一拍不可信」 */
  let watchdogLastRunWall = 0
  /** native 自动暂停段是否在记账（live 只给状态，墙钟按轮询增量累计） */
  let apLiveCounted = false
  let lastLivePollWall = 0
  /** 能力判定是否已读过（preflight/begin 各读一次；resume 复用） */
  let nativeCapChecked = false
  /** 一级降级时刻的原生已录运动毫秒：此后原生若仍在记录（服务未停），其点不回灌 */
  let nativeMergeCutoffMs: number | null = null
  /** 原生最近一次 fix 坐标（降级播种时用于重建暂停锚点） */
  let nativeLastLat = 0
  let nativeLastLon = 0

  /* ---------- 切后台空窗 ---------- */

  let hiddenAtMs = 0
  let hiddenAtDistanceM = 0
  let hiddenAtElapsedMs = 0
  /**
   * 回前台后的看门狗宽限期（epoch ms）。
   *
   * WebView 被 onPause/熄屏冻结时，JS 定时器停摆，lastFixAt 会停在冻结前的时刻；
   * 若醒来立刻用「60s 无新 fix」判定，会把一个仍在正常采集的原生服务误降级到 web
   * （且降级单向不回退）——用户看到的就是「熄屏一次后永远没有定位」。
   * 醒后先 drain 原生快照，再给一段宽限，期间只看「轮询后是否仍有新 fix」。
   */
  let resumeGraceUntil = 0

  /* ---------- 落盘节奏 ---------- */

  let pointsSincePersist = 0
  let lastPersistWall = 0
  let persistInFlight: Promise<void> | null = null

  /* ---------- 派生 ---------- */

  /** 采集真源：原生可用且未降级且未开开发覆盖时走原生，否则 web */
  const source = computed<'native' | 'web'>(() =>
    nativeReady.value && !nativeDegraded.value && !forceWeb() ? 'native' : 'web',
  )

  const elapsedMs = computed(() =>
    source.value === 'native'
      ? nativeElapsedMs.value
      : phase.value === 'running'
        ? accumMs.value + (nowTick.value - segStartedMs)
        : accumMs.value,
  )
  const elapsedSec = computed(() => Math.floor(elapsedMs.value / 1000))
  const km = computed(() => distanceM.value / 1000)
  /** 平均配速（秒/公里）；距离太短时不显示 */
  const paceSecPerKm = computed(() =>
    km.value > 0.05 && elapsedSec.value > 10 ? Math.round(elapsedSec.value / km.value) : null,
  )
  const isActive = computed(() => phase.value !== 'idle' && phase.value !== 'ready')
  const weightKg = computed(() => useNutritionStore().profile?.weightKg ?? 70)

  /** 四类桶（逐段互斥）：wallMs = 运动 + 全部暂停/空窗墙钟 */
  const pausedMs = computed(() => manualPauseMs.value + autoPauseMs.value + gapMs.value)
  const wallMs = computed(() => elapsedMs.value + pausedMs.value)

  /** 最近一次 fix 的年龄（秒）；无 fix 恒 9999（视图按「无定位」渲染） */
  const fixAgeSec = computed(() =>
    lastFixAt.value === 0 ? 9999 : Math.floor((nowTick.value - lastFixAt.value) / 1000),
  )
  /** 等待 fix 的秒数：首个 fix 前从开跑时刻算，之后同 fixAgeSec */
  const fixWaitSec = computed(() =>
    lastFixAt.value === 0
      ? Math.floor((nowTick.value - runStartedAtMs.value) / 1000)
      : Math.floor((nowTick.value - lastFixAt.value) / 1000),
  )

  /** 轨迹里程（米）：与入账距离对照——「画的线」与「记的距离」不是一回事 */
  const trackM = computed(() => trackLengthM(trackPoints.value))

  /** 按配速分档强度：≤5'30"/km 高，≤7'30" 中，其余低；无距离按中 */
  const intensity = computed<Intensity>(() => {
    const p = paceSecPerKm.value
    if (p == null) return 'moderate'
    if (p <= 330) return 'high'
    if (p <= 450) return 'moderate'
    return 'low'
  })

  /** ACSM 速度连续模型：有 GPS 距离按平均配速精确计算，无距离退回 MET 中档 */
  const kcal = computed(() => estimateRunKcal(km.value, elapsedSec.value, weightKg.value))

  /** 任意距离下的热量（总结页距离核对时实时重算） */
  function kcalAt(kmVal: number | null): number {
    return estimateRunKcal(kmVal, elapsedSec.value, weightKg.value)
  }

  const goalProgress = computed<number | null>(() => {
    if (goalKind.value === 'time')
      return Math.min(elapsedSec.value / Math.max(1, goalTimeMin.value * 60), 1)
    if (goalKind.value === 'distance')
      return Math.min(km.value / Math.max(0.5, goalDistanceKm.value), 1)
    return null // 自由跑没有进度条：用千卡冒充目标会让「进度」变成另一件事
  })

  /** 快照用的累计运动毫秒：native 以原生快照为准（不墙钟外推），web 沿用墙钟外推 */
  function coastedMs(): number {
    if (source.value === 'native') return nativeElapsedMs.value
    return phase.value === 'running' ? accumMs.value + (Date.now() - segStartedMs) : accumMs.value
  }

  /* ---------- 落盘 ---------- */

  /**
   * 轨迹抽稀：5s 时间桶留每桶最后一点、尾点必留、上限 800 点。
   * 已从抽稀快照恢复的数组直接返回（幂等，避免二次抽稀把轨迹抹平）。
   */
  function decimatedPoints(): RunTrackPoint[] {
    const pts = trackPoints.value
    if (trackDecimated.value || pts.length <= 2) return pts
    const out: RunTrackPoint[] = []
    let bucket = Number.NaN
    for (const p of pts) {
      const b = Math.floor((p.t ?? pointLastT) / SNAPSHOT_BUCKET_MS)
      if (b !== bucket) {
        out.push(p)
        bucket = b
      } else {
        out[out.length - 1] = p // 每桶留最后一个
      }
    }
    if (out.length <= MAX_SNAPSHOT_POINTS) return out
    const step = Math.ceil(out.length / MAX_SNAPSHOT_POINTS)
    return out.filter((_, i) => i % step === 0 || i === out.length - 1)
  }

  function snapshot(): RunSnapshot {
    const running = phase.value === 'running'
    const pts = decimatedPoints()
    return {
      kind: 'run',
      phase: phase.value === 'summary' ? 'summary' : running ? 'running' : 'paused',
      goalKind: goalKind.value,
      goalTimeMin: goalTimeMin.value,
      goalDistanceKm: goalDistanceKm.value,
      accumMs: coastedMs(),
      segStartedAt: running ? new Date(segStartedMs).toISOString() : null,
      distanceM: distanceM.value,
      points: pts,
      pausedMs: pausedMs.value,
      pauseCount: pauseCount.value,
      autoPauseMs: autoPauseMs.value,
      autoPauseCount: autoPauseCount.value,
      gapMs: gapMs.value,
      gapSlowCount: gapSlowCount.value,
      gapFastCount: gapFastCount.value,
      gapDropCount: gapDropCount.value,
      decimated: trackDecimated.value || pts.length < trackPoints.value.length,
      finalKm: finalKmSnap.value,
      autoPauseOn: autoPauseOn.value,
      autoPausePaceSec: autoPausePaceSec.value,
    }
  }

  async function persist(): Promise<void> {
    const id = sessionId.value
    if (!id) return
    if (persistInFlight) await persistInFlight // 串行化：旧快照后到会覆盖新快照
    const mine = (async () => {
      try {
        await sessionService.snapshot({ id, exIndex: 0, setIndex: 1, weightKg: 0, state: snapshot() })
        persistError.value = ''
      } catch (e) {
        console.warn('[run] 快照落盘失败', e)
        persistError.value = e instanceof Error ? e.message : String(e)
      }
    })()
    persistInFlight = mine
    await mine
    if (persistInFlight === mine) persistInFlight = null
  }

  /** 落盘节奏：每 5 个落点或距上次 ≥15s 补一次（崩溃最多丢 15s） */
  function markPointPersist(): void {
    pointsSincePersist++
    if (pointsSincePersist >= 5 || Date.now() - lastPersistWall >= 15_000) {
      pointsSincePersist = 0
      lastPersistWall = Date.now()
      void persist()
    }
  }

  /* ---------- 阈值归一化（与 Rust normalize_auto_pause 同规则） ---------- */

  function autoPauseThresholds(): { enter: number; exit: number } {
    if (!autoPauseOn.value || autoPausePaceSec.value <= 0) return { enter: 0, exit: 0 }
    const enter = Math.min(1200, Math.max(300, Math.round(autoPausePaceSec.value)))
    const exit = Math.min(enter - 30, Math.max(300, enter - 60))
    return { enter, exit }
  }

  /* ---------- web 采集（桌面/浏览器 + 降级接管） ---------- */

  /** web 采集源：注入源与 navigator.geolocation 二选一（守卫与 clearWatch 走同一个源） */
  function geoSource(): GeoSource | null {
    if (typeof window === 'undefined') return null
    if (window.__reinGeoDriver) return window.__reinGeoDriver
    return typeof navigator !== 'undefined' && 'geolocation' in navigator
      ? navigator.geolocation
      : null
  }

  /** 轨迹点附加信息：记录时刻的累计运动毫秒 + 精度/海拔（详情页分段配速/爬升用） */
  function pointMeta(pos: GeoFix, brk: boolean): Omit<RunTrackPoint, 'lat' | 'lon'> {
    let t = accumMs.value + Math.max(0, pos.timestamp - segStartedMs)
    if (t < pointLastT) t = pointLastT // t 单调不减（暂停恢复/时钟抖动都不许倒退）
    pointLastT = t
    const meta: Omit<RunTrackPoint, 'lat' | 'lon'> = { t }
    const acc = pos.coords.accuracy
    if (typeof acc === 'number' && acc > 0) meta.acc = acc
    if (typeof pos.coords.altitude === 'number') meta.alt = pos.coords.altitude
    if (typeof pos.coords.altitudeAccuracy === 'number') meta.altAcc = pos.coords.altitudeAccuracy
    if (brk) meta.brk = true
    return meta
  }

  /**
   * 复位采集窗口（保留累计量）：防抖窗口 / 判定链 / W10 / 参考点全部清空。
   * 用于「停采集后再开」（开始/继续）——距离与时长不因换源或恢复而倒退。
   * 不清 webMarkBrk：手动暂停/降级设的轨迹断点要活到下一个落点（调用点自己复位）。
   */
  function resetWebState(): void {
    gate.resetWindows()
    webLastFixT = 0
  }

  /** 把 gate 的结论镜像进响应式 ref（每次 fix 一次，≤1s）；瞬时配速由调用点按相位决定 */
  function mirrorGate(): void {
    distanceM.value = gate.distM
    bumpDisplay(gate.dispM)
    autoPaused.value = gate.autoPaused
    autoPauseCount.value = gate.autoPauseCount
    autoPauseMs.value = gate.autoPauseMs
    gapMs.value = gate.gapMs
    gapSlowMs.value = gate.gapSlowMs
    gapFastMs.value = gate.gapFastMs
    gapDropMs.value = gate.gapDropMs
    gapSlowCount.value = gate.gapSlowCount
    gapFastCount.value = gate.gapFastCount
    gapDropCount.value = gate.gapDropCount
    jumpCount.value = gate.jumpCount
    jitterCorrections.value = gate.jitterCorrections
  }

  /**
   * 结束自动暂停段（手动按暂停 / 进入总结 / 复位）：web 段把当前自动暂停墙钟结账给
   * gate（`settleAutoPause` 同时清段锚点）；native 段按轮询增量记账，这里只复位镜像标记。
   * **不给补距** —— 补距只发生在 gate 的退出判定里。
   */
  function closeAutoPause(): void {
    if (source.value === 'web') {
      gate.settleAutoPause(Date.now())
      autoPaused.value = gate.autoPaused
      autoPauseCount.value = gate.autoPauseCount
      autoPauseMs.value = gate.autoPauseMs
      pauseCause.value = null
      return
    }
    apLiveCounted = false
    if (!autoPaused.value) return
    autoPaused.value = false
    if (pauseCause.value === 'auto') pauseCause.value = null
  }

  /**
   * web 采集回调（含注入源）：闸门/自动暂停/空窗三分支的唯一入口。
   *
   * 判定全部交给 `gate`（K/L 口径），本函数只做三件事：镜像结论、写轨迹点、
   * 维护墙钟段（run.ts 的时长按墙钟走，暂停/空窗由段起止切换）。
   */
  function onWebFix(pos: GeoFix): void {
    const t = pos.timestamp
    const acc = pos.coords.accuracy ?? 0
    const lat = pos.coords.latitude
    const lon = pos.coords.longitude
    if (gpsStatus.value !== 'active') gpsStatus.value = 'active'
    // 新鲜度：任何收到的 fix（含精度不合格/暂停期间）都说明定位还在吐点
    lastFixAt.value = t
    lastFixAccM.value = acc
    if (phase.value !== 'running' && phase.value !== 'paused') return
    const prevT = webLastFixT
    const out = gate.onFix({ t, lat, lon, acc })
    mirrorGate()
    // 瞬时配速只在 running 时对外可见（手动暂停期间显式 null）
    paceInstantSecPerKm.value = phase.value === 'running' ? gate.paceSecPerKm : null
    if (!out.dropped && !out.jumped) webLastFixT = t
    if (out.accepted) {
      const brk = out.brk || webMarkBrk
      webMarkBrk = false
      const point: RunTrackPoint = { lat, lon, ...pointMeta(pos, brk) }
      trackPoints.value.push(point)
      markPointPersist()
      if (out.gap) {
        if (gaps.value.length >= 40) gaps.value.shift()
        gaps.value.push({ t: point.t ?? 0, ms: out.gapBucketMs, why: out.gap })
      }
    }
    if (out.entered) {
      // 自动暂停进入：时长/距离冻结（gate 已停表），墙钟段结账
      pauseCause.value = 'auto'
      accumMs.value += Math.max(0, Date.now() - segStartedMs)
      segStartedMs = Date.now()
      void persist()
    } else if (out.exited) {
      // 恢复跑：墙钟段重新起算（净位移补距已由 gate 计入 distM）
      pauseCause.value = null
      segStartedMs = Date.now()
      void persist()
    } else if (out.gap === 'slow' || out.gap === 'drop') {
      // 慢/丢弃空窗：空窗时间不计运动时长——段结账到空窗起点，再从本次 fix 起算
      accumMs.value += Math.max(0, prevT - segStartedMs)
      segStartedMs = Date.now()
    }
  }

  function startGps(): void {
    if (source.value === 'native') return // 原生真源下不开 web 采集，杜绝双计（契约 A3）
    const geo = geoSource()
    if (!geo) {
      gpsStatus.value = 'unavailable'
      return
    }
    stopGps()
    gpsStatus.value = 'acquiring'
    watchId = geo.watchPosition(
      onWebFix,
      () => {
        gpsStatus.value = 'unavailable'
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
    )
  }

  function stopGps(): void {
    const geo = geoSource()
    if (watchId != null && geo) geo.clearWatch(watchId)
    watchId = null
    resetWebState()
  }

  /* ---------- 原生真源：双通道 + 看门狗 + 两级降级 ---------- */

  function parseLive(payload: unknown): NativeRunLive | null {
    let obj: unknown = payload
    if (typeof payload === 'string') {
      try {
        obj = JSON.parse(payload)
      } catch {
        return null
      }
    }
    if (typeof obj !== 'object' || obj === null) return null
    const l = obj as Partial<NativeRunLive>
    if (typeof l.elapsedMs !== 'number' || typeof l.distanceM !== 'number') return null
    return { ...FALLBACK_LIVE, ...l }
  }

  function parsePoint(payload: unknown): RunTrackPoint | null {
    let obj: unknown = payload
    if (typeof payload === 'string') {
      try {
        obj = JSON.parse(payload)
      } catch {
        return null
      }
    }
    if (typeof obj !== 'object' || obj === null) return null
    const p = obj as Partial<NativeRunPoint>
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return null
    const out: RunTrackPoint = { lat: p.lat, lon: p.lon }
    if (typeof p.t === 'number') out.t = p.t
    if (typeof p.acc === 'number') out.acc = p.acc
    if (typeof p.alt === 'number') out.alt = p.alt
    if (typeof p.altAcc === 'number') out.altAcc = p.altAcc
    if (p.brk === true) out.brk = true
    return out
  }

  /** 消费原生 live：native 为唯一真源时镜像（降级后不再采信，单向） */
  function applyLive(live: NativeRunLive): void {
    if (source.value !== 'native') return
    if (live.elapsedMs > nativeElapsedMs.value) nativeElapsedMs.value = live.elapsedMs
    if (live.distanceM > nativeDistanceM.value) nativeDistanceM.value = live.distanceM
    distanceM.value = nativeDistanceM.value
    // 显示专用快通道：优先原生低滞后 dispM（同节拍推送），退回稳通道 distanceM
    const liveDisp = (live as NativeRunLive & { dispM?: number }).dispM
    bumpDisplay(Math.max(live.distanceM, typeof liveDisp === 'number' && Number.isFinite(liveDisp) ? liveDisp : 0))
    paceInstantSecPerKm.value = live.paceSecPerKm
    lastFixAt.value = live.lastFixMs
    lastFixAccM.value = live.accM
    if (live.lat !== 0 || live.lon !== 0) {
      nativeLastLat = live.lat
      nativeLastLon = live.lon
    }
    if (live.lastFixMs > 0 && gpsStatus.value !== 'active') gpsStatus.value = 'active'
    gapMs.value = live.gapMs
    gapSlowMs.value = live.gapSlowMs
    gapFastMs.value = live.gapFastMs
    gapDropMs.value = live.gapDropMs
    gapSlowCount.value = live.gapSlowCount
    gapFastCount.value = live.gapFastCount
    gapDropCount.value = live.gapDropCount
    // 自动暂停段：live 只给状态——按轮询增量记账（≤1s 粒度），翻转时计一次数
    const now = Date.now()
    const pollDt = lastLivePollWall > 0 ? Math.min(2000, now - lastLivePollWall) : 0
    lastLivePollWall = now
    if (live.autoPaused) {
      if (!apLiveCounted) {
        autoPauseCount.value++
        apLiveCounted = true
      }
      autoPauseMs.value += pollDt
    } else {
      apLiveCounted = false
    }
    autoPaused.value = live.autoPaused
    pauseCause.value = live.autoPaused ? 'auto' : phase.value === 'paused' ? 'manual' : null
  }

  async function pollNativeLive(): Promise<void> {
    if (source.value !== 'native') return
    try {
      applyLive(await trackingService.live())
    } catch {
      // 命令不可用：当作没有新快照，等下一轮/降级看门狗
    }
  }

  function startNativePoll(): void {
    stopNativePoll()
    lastLivePollWall = 0
    nativePollTimer = setInterval(() => void pollNativeLive(), 1000)
    void pollNativeLive()
  }

  function stopNativePoll(): void {
    if (nativePollTimer) clearInterval(nativePollTimer)
    nativePollTimer = null
  }

  function stopWatchdog(): void {
    if (watchdogTimer) clearInterval(watchdogTimer)
    watchdogTimer = null
  }

  /** 看门狗：30s 内无首个 fix 或连续 60s 无新 fix → 一级降级（原生静默失败兜底） */
  function startWatchdog(): void {
    stopWatchdog()
    watchdogStartWall = Date.now()
    watchdogLastFixMs = 0
    watchdogLastFixWall = 0
    watchdogLastRunWall = 0
    watchdogTimer = setInterval(() => {
      if (source.value !== 'native') return
      const now = Date.now()
      // 定时器本应是 5s 一拍；若这一拍隔了 >12s，说明页面被冻结/限流过，
      // 这段墙钟不能用来判「60s 无新 fix」。先宽限，再恢复判定 ——
      // 这个判据不依赖 visibilitychange 与定时器的先后顺序。
      const tickGap = watchdogLastRunWall > 0 ? now - watchdogLastRunWall : 0
      watchdogLastRunWall = now
      if (tickGap > 12_000) {
        watchdogStartWall = now
        watchdogLastFixWall = now
        watchdogLastFixMs = lastFixAt.value
        resumeGraceUntil = Math.max(resumeGraceUntil, now + NATIVE_RESUME_GRACE_MS)
        return
      }
      // 页面不可见时 JS 定时器会被冻结/限流：这段墙钟不能算作「原生没在吐点」。
      // 熄屏前后 lastFixAt 本来就停在冻结前，拿它判 60s 会把健康的前台服务误降级，
      // 而降级是单向的 —— 这正是「熄屏一次后永远无定位」的来源。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        watchdogStartWall = now
        watchdogLastFixWall = now
        return
      }
      // 回前台宽限：onVisibility 已发起 drain，等首轮 poll 落地再恢复判定
      if (now < resumeGraceUntil) {
        watchdogStartWall = now
        watchdogLastFixWall = now
        return
      }
      // 手动暂停期间原生本就不吐新 fix：两个窗口都顺延，别把「用户按了暂停」判成采集失败
      if (phase.value !== 'running') {
        watchdogStartWall = now
        watchdogLastFixWall = now
        return
      }
      if (lastFixAt.value === 0) {
        if (now - watchdogStartWall >= 30_000) void degradeNative('30s 无首个 fix')
        return
      }
      if (lastFixAt.value !== watchdogLastFixMs) {
        watchdogLastFixMs = lastFixAt.value
        watchdogLastFixWall = now
        return
      }
      if (now - watchdogLastFixWall >= 60_000) void degradeNative('60s 无新 fix')
    }, 5000)
  }

  /** 降级播种（三件套）：原生已停止写入后，web 墙钟从它的快照值接着走，时长不虚增 */
  function seedWebFromNative(): void {
    nativeMergeCutoffMs = nativeElapsedMs.value
    accumMs.value = nativeElapsedMs.value
    segStartedMs = Date.now()
    distanceM.value = nativeDistanceM.value
    bumpDisplay(nativeDistanceM.value)
    pointLastT = trackPoints.value.reduce((m, p) => Math.max(m, p.t ?? 0), pointLastT)
    // 闸门以原生快照为基线重建（distM/elapsedMs 接着走），换源处画断开
    gate = newGate(nativeElapsedMs.value, nativeDistanceM.value)
    if (autoPaused.value) {
      // 原生正处于自动暂停：web 闸门接着从当前坐标起算退出窗口
      gate.seedAutoPause(nativeLastLat, nativeLastLon, Date.now())
    }
    webMarkBrk = true // 原生点与 web 点之间没有几何连续性
    webLastFixT = 0
  }

  /**
   * 一级降级：保留前台服务与常驻通知（进程仍被保活），web 采集接管。
   * 不调 runEnd —— 通知消失只发生在二级/正常结束。
   */
  async function degradeNative(reason: string): Promise<void> {
    if (nativeDegraded.value || nativeServiceDown.value) return
    // 页面不可见时绝不降级：JS 的「多久没 fix」在后台没有可信的墙钟
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    nativeDegraded.value = true
    stopWatchdog()
    stopNativePoll()
    console.warn('[run] 原生采集降级（一级）：', reason)
    seedWebFromNative()
    if (phase.value === 'running') startGps()
    useToast().toast('定位已回退到应用内 · 锁屏可能中断')
  }

  /**
   * 二级降级：服务确认不可用（runBegin 连续失败 / 服务无法启动）→ 停服务、通知消失。
   * 此时只有前台有效：熄屏可能中断定位，结束后可补填距离（产品折中，UI 必须明示）。
   */
  async function disableNativeService(): Promise<void> {
    if (nativeServiceDown.value) return
    nativeServiceDown.value = true
    if (!nativeDegraded.value) {
      nativeDegraded.value = true
      stopWatchdog()
      stopNativePoll()
      seedWebFromNative()
      if (phase.value === 'running') startGps()
    }
    try {
      await trackingService.runEnd()
    } catch {
      /* 服务本就不可用 */
    }
    try {
      await trackingService.setKeepalive(false)
    } catch {
      /* 同上 */
    }
  }

  /** 读一次 tracking_status 判定真源：busy（快照未收敛）时 400ms 重试 ≤5 次 */
  async function readNativeStatus(): Promise<boolean> {
    let st = await trackingService.status()
    for (let i = 0; i < 5 && st.busy; i++) {
      await sleep(400)
      st = await trackingService.status()
    }
    nativeReady.value = st.native === true
    nativeCapChecked = true
    return nativeReady.value
  }

  /** 能力判定按需读一次（preflight()/begin() 各自强制读，其余路径复用） */
  async function ensureNativeCap(): Promise<void> {
    if (nativeCapChecked) return
    await readNativeStatus()
  }

  /** 原生动相位：runBegin 连续失败即二级降级 */
  async function nativeRunBegin(baselineMs: number, baselineM: number): Promise<void> {
    const { enter, exit } = autoPauseThresholds()
    const cfg: TrackingRunConfig = {
      runId: startedAtIso.value,
      autoPauseEnterSecPerKm: enter,
      autoPauseExitSecPerKm: exit,
      baselineElapsedMs: Math.max(0, Math.round(baselineMs)),
      baselineDistanceM: Math.max(0, baselineM),
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await trackingService.runBegin(cfg)
        startWatchdog()
        startNativePoll()
        return
      } catch (e) {
        console.warn('[run] 原生采集启动失败', e)
        if (attempt === 0) await sleep(400)
      }
    }
    await disableNativeService()
  }

  /** 原生轨迹文件（E 契约每行一个 JSON）→ 轨迹点；坏行跳过，不毁整段 */
  function parseNativeTrack(data: string): RunTrackPoint[] {
    const out: RunTrackPoint[] = []
    for (const line of data.split('\n')) {
      const s = line.trim()
      if (!s) continue
      const p = parsePoint(s)
      if (p) out.push(p)
    }
    if (nativeMergeCutoffMs != null) {
      const cut = nativeMergeCutoffMs
      return out.filter((p) => (p.t ?? 0) <= cut)
    }
    return out
  }

  /** B7 异步刷新：400ms 重试到 lines>0（默认 ≤5 次）——读到空是「还在写」，不是「没有」 */
  async function takeTrack(
    runId: string,
    attempts = 5,
  ): Promise<{ lines: number; data: string }> {
    let chunk = { lines: 0, data: '' }
    for (let i = 0; i < attempts; i++) {
      chunk = await trackingService.trackTake(runId)
      if (chunk.lines > 0) break
      if (i < attempts - 1) await sleep(400)
    }
    return chunk
  }

  /**
   * 取回并合并原生轨迹：文件是原生段的完整记录（快照里的点是抽稀过的），
   * 原生段整体以文件为准；文件时间轴之后仍在内存里的点（降级后 web 那一段）接尾。
   * 空结果不覆盖已有轨迹（尚未写入 / 还未交付）。
   */
  async function mergeNativeTrackFile(runId: string, attempts = 5): Promise<number> {
    if (!runId) return 0
    let chunk: { lines: number; data: string }
    try {
      chunk = await takeTrack(runId, attempts)
    } catch (e) {
      console.warn('[run] 轨迹取回失败', e)
      return 0
    }
    if (chunk.lines <= 0 || !chunk.data) return 0
    const pts = parseNativeTrack(chunk.data)
    if (pts.length === 0) return 0
    let lastNativeT = 0
    for (const p of pts) if ((p.t ?? 0) > lastNativeT) lastNativeT = p.t ?? 0
    const tail = trackPoints.value.filter((p) => (p.t ?? 0) > lastNativeT)
    trackPoints.value = [...pts, ...tail]
    return pts.length
  }

  function installNativeChannels(): void {
    if (typeof window === 'undefined') return
    window.__reinRunLive = (payload) => {
      const live = parseLive(payload)
      if (live) applyLive(live)
    }
    window.__reinRunPoint = (payload) => {
      if (source.value !== 'native') return // 降级后不回灌原生点（双源合并会双计）
      const p = parsePoint(payload)
      if (!p) return
      trackPoints.value.push(p)
      if ((p.t ?? 0) > pointLastT) pointLastT = p.t ?? 0
      markPointPersist()
    }
  }

  /* ---------- 切后台 / 回前台 ---------- */

  /** 后台空窗提示：墙钟取真实离线时长，入账量取「回来时」的读数 */
  function reportHiddenGap(fromWall: number, nowWall: number): void {
    const ms = nowWall - fromWall
    if (ms <= 15_000) return
    gapNotice.value = {
      ms,
      atMs: nowWall,
      creditedM: Math.max(0, distanceM.value - hiddenAtDistanceM),
      creditedMs: Math.max(0, elapsedMs.value - hiddenAtElapsedMs),
    }
  }

  function onVisibility(): void {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') {
      if (phase.value !== 'running' && phase.value !== 'paused') return
      hiddenAtMs = Date.now()
      hiddenAtDistanceM = distanceM.value
      hiddenAtElapsedMs = elapsedMs.value
      void persist() // 立即落盘：后台被系统杀掉最多丢这一次
      return
    }
    const hiddenFrom = hiddenAtMs
    hiddenAtMs = 0
    nowTick.value = Date.now()
    if (source.value === 'native') {
      // 先把「回前台宽限」立起来，再 drain：poll 返回前 lastFixAt 必然还是冻结前的旧值，
      // 看门狗若在这一拍跑，会把健康原生服务误判成 60s 无 fix（降级不可逆）。
      resumeGraceUntil = Date.now() + NATIVE_RESUME_GRACE_MS
      watchdogStartWall = Date.now()
      watchdogLastFixWall = Date.now()
      watchdogLastRunWall = Date.now()
      watchdogLastFixMs = lastFixAt.value
      // 空窗提示要等 drain 落地再算：冻结期间原生仍在记录，入账量必须以最新快照为准，
      // 否则会把「后台补记了 400m」写成「已补记 0m」。
      void pollNativeLive().finally(() => {
        if (hiddenFrom > 0) reportHiddenGap(hiddenFrom, Date.now())
      })
      if (phase.value === 'running') void mergeNativeTrackFile(startedAtIso.value) // 文件兜底
    } else if (hiddenFrom > 0) {
      reportHiddenGap(hiddenFrom, Date.now())
    }
    void persist()
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void persist())
  }
  installNativeChannels()

  function clearGapNotice(): void {
    gapNotice.value = null
  }

  /* ---------- 流程 ---------- */

  function stopTimers(): void {
    if (tickTimer) clearInterval(tickTimer)
    if (persistTimer) clearInterval(persistTimer)
    tickTimer = null
    persistTimer = null
  }

  /** 进入准备页（新的一次跑步） */
  function enterReady(): void {
    resetLocal()
    phase.value = 'ready'
    goalKind.value = 'open'
    goalTimeMin.value = 30
    goalDistanceKm.value = 5
  }

  /**
   * 开始前的预检（准备页「开始跑步」前调用）：判定采集真源与可用性。
   * degraded = 本轮没有可用定位（native 服务未授权启动 / 浏览器无 geolocation），
   * 视图据此提示「纯计时，距离结束后补填」。
   */
  async function preflight(): Promise<'ready' | 'degraded'> {
    nativeCapChecked = false
    await readNativeStatus() // preflight() 与 begin() 各读一次（契约 A1）
    if (source.value === 'native') return 'ready'
    return geoSource() ? 'ready' : 'degraded'
  }

  /**
   * 安卓开跑前先拉起前台保活（首次未授权会弹系统授权框，授权后服务自动启动）。
   * 原生采集生效后，锁屏停摆的是 WebView 而不是采集本身：前台服务继续吐快照，
   * 回到前台 drain 一次即可补齐。最多等 20s，用户拒绝则立即放行，走 GPS 自身的
   * 不可用降级（总结页补填距离）。顺带完成本轮的「真源判定」（契约 A1）。
   */
  async function armKeepalive(): Promise<void> {
    await trackingService.setKeepalive(true)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const st = await trackingService.status()
      nativeReady.value = st.native === true
      nativeCapChecked = true
      if (!st.granted) {
        if (!st.busy) return // 用户明确拒绝，立即降级
        await sleep(400)
        continue
      }
      // 权限就绪：若等待期间授权框被别处（如 WebView 自身提示）代答，
      // 保活服务可能尚未拉起，再发一次 enable（已授权时是直接启动服务的幂等操作）
      await trackingService.setKeepalive(true)
      return
    }
  }

  /**
   * 3·2·1 倒数结束后正式开跑：创建后端会话并开始计时。
   * 服务端已有进行中会话时返回 'conflict'（课程 → courseConflict，跑步 → 已恢复）。
   */
  async function begin(): Promise<'ok' | 'conflict'> {
    const existing = await sessionService.getActive()
    if (existing) {
      if (existing.planId === RUN_PLAN_ID) {
        await applyRecord(existing)
        return 'conflict' // 已接续/恢复到进行中的跑步，页面直接展示
      }
      courseConflict.value = true
      return 'conflict'
    }
    courseConflict.value = false
    startedAtIso.value = new Date().toISOString()
    runStartedAtMs.value = Date.now()
    accumMs.value = 0
    distanceM.value = 0
    distDisplayM.value = 0 // 跨 run 归零：hero 不带着上一轮的数
    gate = newGate() // 新一轮闸门从零起
    webMarkBrk = false
    webLastFixT = 0
    trackPoints.value = []
    trackDecimated.value = false
    paceInstantSecPerKm.value = null
    const rec = await sessionService.start({
      planId: RUN_PLAN_ID,
      planName: '户外跑',
      startedAt: startedAtIso.value,
      state: snapshot(),
    })
    sessionId.value = rec.id
    await armKeepalive() // 起表前先确保保活/授权，弹框等待不计入运动时长
    if (source.value === 'native') {
      gpsStatus.value = 'acquiring'
      await nativeRunBegin(0, 0) // baseline 0/0：新一轮从零起
    }
    phase.value = 'running'
    segStartedMs = Date.now()
    nowTick.value = Date.now()
    startGps() // native 时由 A3 守卫直接返回
    startTimers()
    await persist()
    return 'ok'
  }

  function startTimers(): void {
    stopTimers()
    tickTimer = setInterval(() => {
      nowTick.value = Date.now()
      // 无新 fix 超过 15s：瞬时配速失效（native 侧 live 自带 null，这里只管 web）
      if (
        source.value === 'web' &&
        paceInstantSecPerKm.value != null &&
        lastFixAt.value > 0 &&
        Date.now() - lastFixAt.value > PACE_STALE_MS
      )
        paceInstantSecPerKm.value = null
    }, 250)
    // 运行中每 10s 落盘一次：崩溃/退出后距离与时长最多回退 10s
    persistTimer = setInterval(() => void persist(), 10_000)
  }

  function pause(): void {
    if (phase.value !== 'running') return
    closeAutoPause() // 自动暂停中手动按暂停：先把自动暂停段结账
    accumMs.value += Date.now() - segStartedMs
    nowTick.value = Date.now()
    phase.value = 'paused'
    paceInstantSecPerKm.value = null // L6：显式清，避免恢复后拿着旧值当新值
    pauseCause.value = 'manual'
    pauseCount.value++
    manualPausedWallMs = Date.now()
    gate.setManualPaused(true) // 手动暂停期间判定全部跳过，链与锚点清零（与 native 侧 B4 对称）
    if (source.value === 'native') void trackingService.runPhase('paused')
    void pollNativeLive() // 相位变化各拉一次 live
    void persist()
  }

  function resume(): void {
    if (phase.value !== 'paused') return
    if (manualPausedWallMs > 0) {
      manualPauseMs.value += Math.max(0, Date.now() - manualPausedWallMs)
      manualPausedWallMs = 0
    }
    segStartedMs = Date.now()
    nowTick.value = Date.now()
    phase.value = 'running'
    pauseCause.value = null
    webMarkBrk = true // 手动暂停也是轨迹断点
    gate.setManualPaused(false)
    startTimers() // 恢复/自动接续都要把响应式时钟与周期落盘重新挂上
    void trackingService.setKeepalive(true) // 恢复跑同样需要前台保活
    void (async () => {
      await ensureNativeCap()
      if (source.value === 'native') {
        stopGps() // 判定落地前可能已开过 web 采集：停掉，避免双源
        await pollNativeLive()
        const live = await trackingService.live().catch(() => null)
        if (!live || !live.active) {
          // 服务已停（force-stop 后重开）：以真源最后快照为基线续采，时长/距离不回 0。
          // 基线取 nativeElapsedMs 而不是 accumMs —— 原生跑动期间 accumMs 是休眠的
          // （墙钟段只在 web 真源里维护），拿它当基线会让时长直接倒退。
          const baseMs = nativeElapsedMs.value
          const baseM = distanceM.value
          nativeElapsedMs.value = baseMs
          nativeDistanceM.value = baseM
          // 播种三件套：真源已停，墙钟段与后续降级路径都从这个值接着走
          accumMs.value = baseMs
          segStartedMs = Date.now()
          await nativeRunBegin(baseMs, baseM)
          await trackingService.runPhase('running')
        } else {
          // 服务还活着：重新接上拉取与看门狗（applyRecord 会先 stopWatchdog，
          // 不复挂的话恢复后原生再静默失败就没人兜底了）
          startWatchdog()
          startNativePoll()
          await trackingService.runPhase('running')
        }
      } else if (gpsStatus.value !== 'unavailable') {
        startGps()
      }
    })()
    void persist()
  }

  /** 结束并保存前：冻结时长，进入总结页（可手动修正距离） */
  function enterSummary(): void {
    if (phase.value === 'running') {
      accumMs.value += Date.now() - segStartedMs
      nowTick.value = Date.now()
    }
    closeAutoPause()
    phase.value = 'summary'
    stopTimers()
    stopGps()
    // 轨迹生命周期（B7）：采集仍在跑时只读（不删）→ runEnd 停服务 → 停后取回即交付删除。
    // 流水在 save() 前 await，保证总结页拿到的是完整轨迹。
    trackDrain = (async () => {
      const runId = startedAtIso.value
      if (source.value === 'native') {
        await pollNativeLive()
        await mergeNativeTrackFile(runId)
        stopWatchdog()
        stopNativePoll()
        try {
          await trackingService.runEnd()
        } catch (e) {
          console.warn('[run] 停原生采集失败', e)
        }
        await mergeNativeTrackFile(runId)
      }
      await trackingService.setKeepalive(false) // 总结页停留时不再占用前台服务与 WakeLock
    })()
    void persist()
  }

  /** 保存训练记录并关闭会话。manualKm = 总结页确认后的公里数（跑步机补填）。 */
  async function save(
    manualKm: number | null,
  ): Promise<{ durationMin: number; kcal: number; km: number | null; paceSec: number | null }> {
    if (trackDrain) {
      try {
        await trackDrain
      } catch (e) {
        console.warn('[run] 轨迹交付失败，按已有点保存', e)
      }
      trackDrain = null
    }
    const durationMin = Math.max(1, Math.round(elapsedMs.value / 60_000))
    const finalKm = manualKm != null && manualKm > 0 ? manualKm : km.value > 0.01 ? km.value : null
    const paceSec =
      finalKm != null && finalKm > 0.05 ? Math.round(elapsedSec.value / finalKm) : null
    const tier: Intensity =
      paceSec == null ? 'moderate' : paceSec <= 330 ? 'high' : paceSec <= 450 ? 'moderate' : 'low'
    const kcalFinal = estimateRunKcal(finalKm, elapsedSec.value, weightKg.value)
    const noteParts: string[] = []
    if (finalKm != null) noteParts.push(`${finalKm.toFixed(2)} km`)
    if (paceSec != null) noteParts.push(`配速 ${fmtPace(paceSec)}`)
    if (manualKm != null && finalKm !== km.value) noteParts.push('距离手动补填')
    // 最终距离写进快照：详情抽屉/对账都以它为准（保存前的最后一次落盘）
    finalKmSnap.value = finalKm
    await persist()
    if (sessionId.value) {
      try {
        await sessionService.finish({
          id: sessionId.value,
          name: '户外跑',
          workoutType: 'run',
          date: todayStr(),
          durationMin,
          intensity: tier,
          kcal: kcalFinal,
          note: noteParts.length > 0 ? noteParts.join(' · ') : null,
          sets: [], // 跑步无逐组重量
        })
      } catch (e) {
        // 写库失败：记态并原样抛，调用点 toast 原因；本地不收尾，会话仍 active 可重试
        finishError.value = e instanceof Error ? e.message : String(e)
        throw e
      }
      finishError.value = ''
    }
    try {
      await Promise.all([
        useExerciseStore().loadWeek(todayStr()),
        useNutritionStore().loadSummary(todayStr()),
      ])
    } catch (e) {
      // 记录已落库、结束语义已达成：刷新失败只给非阻塞提示，绝不阻断本地收尾
      console.warn('[run] 保存后刷新失败', e)
      useToast().toast('已保存，但统计刷新失败')
    }
    resetLocal()
    return { durationMin, kcal: kcalFinal, km: finalKm, paceSec }
  }

  /** 放弃本次跑步（已确认）：关闭会话，不写记录 */
  async function discard(): Promise<void> {
    const id = sessionId.value
    if (id) {
      try {
        await sessionService.abort(id)
      } catch (e) {
        // 同 save：放弃失败保留总结态，供原样重试
        finishError.value = e instanceof Error ? e.message : String(e)
        throw e
      }
    }
    resetLocal()
  }

  async function discardById(id: number): Promise<void> {
    try {
      await sessionService.abort(id)
    } catch (e) {
      finishError.value = e instanceof Error ? e.message : String(e)
      throw e
    }
    if (sessionId.value === id) resetLocal()
  }

  function resetLocal(): void {
    stopTimers()
    stopGps()
    stopWatchdog()
    stopNativePoll()
    closeAutoPause()
    void trackingService.runEnd() // 未运行时为无害空操作（服务不在跑）
    void trackingService.setKeepalive(false)
    sessionId.value = null
    startedAtIso.value = ''
    accumMs.value = 0
    segStartedMs = 0
    distanceM.value = 0
    distDisplayM.value = 0 // 跨 run 归零
    gate = newGate() // 闸门复位（累计量清零）
    webMarkBrk = false
    webLastFixT = 0
    trackPoints.value = []
    trackDecimated.value = false
    paceInstantSecPerKm.value = null
    gpsStatus.value = 'off'
    persistError.value = ''
    finishError.value = ''
    courseConflict.value = false
    nativeReady.value = false
    nativeDegraded.value = false
    nativeServiceDown.value = false
    nativeCapChecked = false
    nativeElapsedMs.value = 0
    nativeDistanceM.value = 0
    nativeMergeCutoffMs = null
    nativeLastLat = 0
    nativeLastLon = 0
    watchdogLastRunWall = 0
    apLiveCounted = false
    pauseCause.value = null
    manualPauseMs.value = 0
    pauseCount.value = 0
    autoPauseMs.value = 0
    autoPauseCount.value = 0
    gapMs.value = 0
    gapSlowMs.value = 0
    gapFastMs.value = 0
    gapDropMs.value = 0
    gapSlowCount.value = 0
    gapFastCount.value = 0
    gapDropCount.value = 0
    gaps.value = []
    jumpCount.value = 0
    gapNotice.value = null
    finalKmSnap.value = null
    trackDrain = null
    pointLastT = 0
    runStartedAtMs.value = 0
    hiddenAtMs = 0
    resumeGraceUntil = 0
    manualPausedWallMs = 0
    phase.value = 'idle'
  }

  /* ---------- 中断恢复 ---------- */

  /** 恢复到进行中的跑步会话（进程被杀 / 冷启动） */
  async function hydrateFromServer(): Promise<boolean> {
    courseConflict.value = false
    let rec: SessionRecord | null
    try {
      rec = await sessionService.getActive()
    } catch {
      rec = null
    }
    if (!rec) return false
    if (rec.planId !== RUN_PLAN_ID) {
      courseConflict.value = true
      return false
    }
    try {
      await applyRecord(rec)
    } catch (e) {
      console.warn('[run] 恢复失败，已作废该会话', e)
      await discardById(rec.id)
      return false
    }
    return true
  }

  async function applyRecord(rec: SessionRecord): Promise<void> {
    const st = rec.state as unknown
    if (typeof st !== 'object' || st === null || (st as RunSnapshot).kind !== 'run') {
      throw new Error('非跑步会话状态')
    }
    const s = st as RunSnapshot
    sessionId.value = rec.id
    startedAtIso.value = rec.startedAt
    runStartedAtMs.value = Date.now()
    goalKind.value = s.goalKind ?? 'open'
    goalTimeMin.value = s.goalTimeMin ?? 30
    goalDistanceKm.value = s.goalDistanceKm ?? 5
    accumMs.value = Math.max(0, s.accumMs ?? 0)
    distanceM.value = Math.max(0, s.distanceM ?? 0)
    // 显示距离播种：恢复续跑时 hero 在首个 live 前不闪 0/'—'
    distDisplayM.value = distanceM.value
    trackPoints.value = Array.isArray(s.points) ? s.points : [] // 旧快照无轨迹，按空处理
    trackDecimated.value = s.decimated === true
    // 计数器与暂停桶：旧快照缺字段按 0 处理；manualPauseMs 由总暂停墙钟反推
    autoPauseMs.value = Math.max(0, s.autoPauseMs ?? 0)
    gapMs.value = Math.max(0, s.gapMs ?? 0)
    manualPauseMs.value = Math.max(0, (s.pausedMs ?? 0) - autoPauseMs.value - gapMs.value)
    pauseCount.value = Math.max(0, s.pauseCount ?? 0)
    autoPauseCount.value = Math.max(0, s.autoPauseCount ?? 0)
    gapSlowCount.value = Math.max(0, s.gapSlowCount ?? 0)
    gapFastCount.value = Math.max(0, s.gapFastCount ?? 0)
    gapDropCount.value = Math.max(0, s.gapDropCount ?? 0)
    autoPauseOn.value = s.autoPauseOn ?? true
    autoPausePaceSec.value = s.autoPausePaceSec ?? 600
    finalKmSnap.value = s.finalKm ?? null
    nativeElapsedMs.value = accumMs.value
    nativeDistanceM.value = distanceM.value
    pointLastT = trackPoints.value.reduce((m, p) => Math.max(m, p.t ?? 0), 0)
    nowTick.value = Date.now()
    stopTimers()
    stopGps()
    stopWatchdog()
    stopNativePoll()
    manualPausedWallMs = 0
    hiddenAtMs = 0
    // 快照里的 phase 是进程死亡前最后一次落盘时的相位：
    //  · running → 用户当时还在跑，恢复后自动接续（不弹卡、不询问）；
    //  · paused  → 用户主动按过暂停，恢复后保持暂停；
    //  · summary → 已经跑完待保存，原样进总结页。
    const interruptedRunning = s.phase === 'running'
    phase.value = s.phase === 'summary' ? 'summary' : 'paused'
    pauseCause.value = phase.value === 'paused' ? 'manual' : null
    webMarkBrk = false
    webLastFixT = 0
    // 原生轨迹文件是本轮轨迹的完整记录：先取回再 resume，避免新服务开始追加时
    // 与「读完即删」的交付路径抢同一个文件。恢复场景下文件已写完，2 次重试足够。
    const got = await mergeNativeTrackFile(rec.startedAt, 2).catch(() => 0)
    if (got > 0) {
      trackDecimated.value = false // 文件是完整轨迹，后续快照可以重新抽稀
      const lastT = trackPoints.value.reduce((m, p) => Math.max(m, p.t ?? 0), 0)
      pointLastT = lastT
      // 快照每 10s 落一次，文件里的最后一个点可能更新：用它把时长补到真实值，
      // 避免恢复后凭空少掉最后一段（距离仍以快照/原生 live 为准）。
      if (lastT > accumMs.value) {
        accumMs.value = lastT
        nativeElapsedMs.value = Math.max(nativeElapsedMs.value, lastT)
      }
    }
    // 闸门以最终基线重建（续跑距离/时长不回 0）；暂停态下手动相位置位
    gate = newGate(accumMs.value, distanceM.value)
    if (phase.value === 'paused') gate.setManualPaused(true)
    if (phase.value === 'paused') {
      if (interruptedRunning) {
        resume()
        useToast().toast(
          got > 0 ? `已接续上次跑步 · ${got} 个轨迹点已恢复` : '已接续上次跑步 · 从上次记录继续',
          { duration: 3000 },
        )
        return
      }
      useToast().toast('已恢复上次跑步 · 保持暂停', { duration: 3000 })
    }
  }

  /* ---------- 自动暂停开关落盘 ---------- */

  watch(autoPauseOn, (on) => {
    try {
      localStorage.setItem(AUTO_PAUSE_KEY, on ? '1' : '0')
    } catch {
      // 隐私模式：忽略（下次仍按缺省 true）
    }
  })

  return {
    phase,
    goalKind,
    goalTimeMin,
    goalDistanceKm,
    sessionId,
    startedAtIso,
    distanceM,
    distDisplayM,
    gpsStatus,
    persistError,
    finishError,
    courseConflict,
    trackPoints,
    trackM,
    paceInstantSecPerKm,
    elapsedMs,
    elapsedSec,
    km,
    paceSecPerKm,
    isActive,
    intensity,
    kcal,
    kcalAt,
    goalProgress,
    // 采集真源与降级
    source,
    nativeDegraded,
    nativeServiceDown,
    autoPaused,
    pauseCause,
    lastFixAt,
    lastFixAccM,
    runStartedAtMs,
    fixAgeSec,
    fixWaitSec,
    // 暂停/空窗四类桶
    wallMs,
    pausedMs,
    manualPauseMs,
    pauseCount,
    autoPauseMs,
    autoPauseCount,
    gapMs,
    gapSlowMs,
    gapFastMs,
    gapDropMs,
    gapSlowCount,
    gapFastCount,
    gapDropCount,
    gaps,
    jumpCount,
    jitterCorrections,
    gapNotice,
    autoPauseOn,
    autoPausePaceSec,
    // 流程
    enterReady,
    preflight,
    begin,
    pause,
    resume,
    enterSummary,
    save,
    discard,
    discardById,
    hydrateFromServer,
    startGps,
    coastedMs,
    clearGapNotice,
  }
})
