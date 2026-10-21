/**
 * 番茄钟域：计时状态机 + 今日专注统计 + 阶段结束送达。
 *
 * 计时基于时间戳（endAt）而非 setInterval 累加，避免漂移；设置、「今日轮次」与进行中快照都
 * 持久化在 localStorage。相位总秒数 `phaseTotalSec` 在**进入相位时冻结**，进度与对外运行态
 * 快照一律由它派生——否则改设置或长短休会让进度环分母与倒计时不同源（长休前 2/3 恒空的旧 bug）。
 *
 * 三态口径（复用 `completed` 字段，不新增列）：
 * · 完成 = 自然走满 → completed:true，focusMin 记本轮计划分钟，「今日轮次」+1；
 * · 中断 = 主动「记录并结束本轮」→ 实际投入 ≥ 60 秒才写 completed:false + 真实投入分钟；
 * · 放弃 = reset() → 不写任何记录。
 * `breakMin` 统一为「该轮计划休息分钟」。
 *
 * 今日统计口径（AI、页脚、桌面右栏、设置页共用）：
 * · todayFocusMin = 今日所有 session 的 focusMin 之和（**含中断段**）＝「今天实际投入了多少分钟」；
 * · todayCompletedCount / todayInterruptedCount = completed 为真 / 假的段数。
 *
 * 计时方向（settings.mode）：
 * · `down` 番茄钟 —— 倒计时，走满进休息（上面那套相位机制）；
 * · `up` 正计时 —— 读数往上累加，每满一个 `focusMin` 周期记一颗完整番茄并**继续**走
 *   （不进休息），由用户主动 `endRound`/`endPhase` 收尾，零头按中断口径处理。
 * 另外还有 `rewindPhase()`（回到本番茄钟初，重来当前相位）与 `settings.maxPauseMin`
 * （最长暂停：累计暂停超时自动结束本段，看门狗在 pause() 起、start() 停）。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { pomodoroService } from '@/services/pomodoroService'
import { todoService } from '@/services/todoService'
import { gatewayService } from '@/services/gatewayService'
import { notifyFocusPhase } from '@/services/notifyService'
import { compatActive } from '@/compat/layers'
import { fmtClockHms, fmtClockSec } from '@/utils/clock'
import { addDays, localDateOf, todayStr } from '@/utils/date'
import { playPhaseChime } from '@/utils/notifyTone'
import type {
  FocusNotice,
  FocusRuntime,
  PomodoroMode,
  PomodoroSession,
  PomodoroSessionInput,
  PomodoroSettings,
} from '@/types'

const SETTINGS_KEY = 'rein.pomodoro.settings.v1'
/** 进行中快照：冷启动据此接管「关 App 期间」的计时。 */
const LIVE_KEY = 'rein.pomodoro.live.v1'
/** 今日轮次（长休周期的唯一真源）：{ date, rounds }。 */
const ROUND_KEY = 'rein.pomodoro.round.v1'
/** 关联待办 id（数字或 null）。 */
const LINKED_KEY = 'rein.pomodoro.linkedTodo.v1'

/** 运行态上报周期（毫秒）：1 秒一次，值没变就不重复写（contract §14.1）。 */
const PUBLISH_INTERVAL_MS = 1000
/** 中断落库的门槛：不足 60 秒按误触处理，不写记录。 */
const MIN_RECORD_SEC = 60

type Phase = 'focus' | 'break'

/** 冷启动接管用的进行中快照（不含任何敏感信息）。 */
interface LiveSnapshot {
  phase: Phase
  running: boolean
  /** 预计结束墙钟毫秒；暂停 / 未起跑为 0。 */
  endAtMs: number
  remainingSec: number
  phaseTotalSec: number
  linkedTodoId: number | null
  runFocusMin: number | null
  runBreakMin: number | null
  completedRounds: number
  /** 相位真实起点墙钟毫秒（0 = 尚未起跑）。 */
  phaseStartedAtMs: number
  /** 计时方向；旧快照缺省 down。 */
  mode?: PomodoroMode
  /** 正计时已累计秒数（down 模式恒为 0）；旧快照缺省 0。 */
  upElapsedSec?: number
}

function loadSettings(): PomodoroSettings {
  const fallback: PomodoroSettings = {
    focusMin: 25,
    breakMin: 5,
    longBreakMin: 15,
    roundsBeforeLongBreak: 4,
    chime: true,
    maxPauseMin: 9,
    mode: 'down',
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<PomodoroSettings>
      const merged = { ...fallback, ...saved }
      // 旧存档缺 `mode` / `maxPauseMin`：由兼容层 0.0.2 保证回退（down / 9）。删掉那层后
      // 缺键直接落到上面的 fallback 默认值，行为一致 —— 不让回退逻辑硬编码散落在此。
      if (compatActive('0.0.2')) {
        if (saved.mode == null) merged.mode = 'down'
        if (saved.maxPauseMin == null) merged.maxPauseMin = 9
      }
      return merged
    }
  } catch {
    /* 忽略损坏的本地设置 */
  }
  return fallback
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 同上 */
  }
}

export const usePomodoroStore = defineStore('pomodoro', () => {
  const settings = ref<PomodoroSettings>(loadSettings())

  const phase = ref<Phase>('focus')
  const running = ref(false)
  /** 本阶段剩余秒数（down 模式的真源） */
  const remainingSec = ref(settings.value.focusMin * 60)
  /** 本阶段总秒数：**进入相位时冻结**，progress / 运行态快照都由它派生。 */
  const phaseTotalSec = ref(settings.value.focusMin * 60)
  let endAt = 0
  /** 正计时已累计秒数（up 模式的真源）；down 模式恒为 0。 */
  const upElapsedSec = ref(0)
  /** 正计时当前运行段的锚点墙钟毫秒与其起点累计值（暂停即冻结，续跑从此推进）。 */
  let upAnchorAt = 0
  let upBaseSec = 0
  /** 本段**累计**暂停秒数：超过 settings.maxPauseMin 自动结束本段（0 = 不限制）。 */
  const pausedAccumSec = ref(0)
  let pauseStartedAt = 0
  let pauseTimer: ReturnType<typeof setInterval> | null = null
  /** 正计时这一段里**已记账**的番茄周期数：跨过新周期的边界时才 +1，避免重复记账。 */
  let recordedCycles = 0
  let timer: ReturnType<typeof setInterval> | null = null
  /** 本相位真实起点墙钟毫秒（0 = 尚未起跑）；暂停续跑不重置，故 startedAt 是真实开始时刻。 */
  let phaseStartedAtMs = 0

  const linkedTodoId = ref<number | null>(null)
  const todaySessions = ref<PomodoroSession[]>([])
  /** 近 7 天 session（供 suggestedFocusMin 用）。 */
  const recentSessions = ref<PomodoroSession[]>([])
  const completedRounds = ref(0)
  const notice = ref<FocusNotice | null>(null)

  /** 写库失败的记录：内存待重试，下一次相位结束时先补写（不进 localStorage，避免残留脏数据）。 */
  let pendingSessions: PomodoroSessionInput[] = []

  /* ---------- 运行态上报（contract §14.1） ---------- */

  let publishTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次上报的状态键（不含 `reportedAt`）：与它相同就不重复写。 */
  let publishedKey = ''
  /** 是否已经报过一份还没清的状态（决定要不要发 `focus_unpublish`）。 */
  let published = false

  /**
   * 外部起跑（`pomodoro.start` 载荷）为本轮指定的一次性时长（分钟）；null = 用本地设置。
   * 只作用于这一轮，**不**写进 settings / localStorage —— 外部控制不改用户保存的偏好。
   */
  const runFocusMin = ref<number | null>(null)
  const runBreakMin = ref<number | null>(null)

  /** 本轮生效的专注时长（分钟）：外部起跑覆盖优先，否则本地设置。 */
  function focusMinValue(): number {
    return runFocusMin.value ?? settings.value.focusMin
  }

  /** 当前计时方向（番茄钟 / 正计时）。 */
  function mode(): PomodoroMode {
    return settings.value.mode
  }

  /** 正计时一个「番茄」周期（分钟）：每满一个周期得一颗番茄，不自动进入休息。 */
  function upCycleSec(): number {
    return Math.max(1, Math.round(focusMinValue() * 60))
  }

  /** 本轮生效的短休息时长（分钟）：外部起跑覆盖优先，否则本地设置。 */
  function breakMinValue(): number {
    return runBreakMin.value ?? settings.value.breakMin
  }

  /** 按给定轮次数判定将进入的休息分钟：整轮（完成轮数命中长休间隔）走长休，否则短休。
   *  外部载荷只带 `breakMin`（短休息），长休仍按本地设置。 */
  function breakMinForRounds(rounds: number, shortMin: number): number {
    const n = Math.max(1, settings.value.roundsBeforeLongBreak)
    return rounds > 0 && rounds % n === 0 ? settings.value.longBreakMin : shortMin
  }

  /** 当前轮次之下将进入的休息分钟（用于进入休息 / 写库的 breakMin）。 */
  function breakPlannedMin(): number {
    return breakMinForRounds(completedRounds.value, breakMinValue())
  }

  /* ---------- 持久化小工具 ---------- */

  /** 今日轮次读回：date 不是今天一律归零。 */
  function loadRounds(): number {
    try {
      const raw = readLocal(ROUND_KEY)
      if (!raw) return 0
      const o = JSON.parse(raw) as { date?: string; rounds?: number }
      if (o.date === todayStr() && typeof o.rounds === 'number') return Math.max(0, Math.floor(o.rounds))
    } catch {
      /* 损坏按 0 */
    }
    return 0
  }

  function saveRounds(): void {
    writeLocal(ROUND_KEY, JSON.stringify({ date: todayStr(), rounds: completedRounds.value }))
  }

  function loadLinkedTodo(): number | null {
    const raw = readLocal(LINKED_KEY)
    if (!raw) return null
    try {
      const v = JSON.parse(raw) as unknown
      return typeof v === 'number' ? v : null
    } catch {
      return null
    }
  }

  /** 维护进行中快照：fresh 空闲相位不写（没有要接管的东西），其余如实落盘。 */
  function persistLive(): void {
    if (!running.value && remainingSec.value >= phaseTotalSec.value && upElapsedSec.value === 0) {
      removeLocal(LIVE_KEY)
      return
    }
    const snap: LiveSnapshot = {
      phase: phase.value,
      running: running.value,
      endAtMs: running.value && mode() === 'down' ? endAt : 0,
      remainingSec: remainingSec.value,
      phaseTotalSec: phaseTotalSec.value,
      linkedTodoId: linkedTodoId.value,
      runFocusMin: runFocusMin.value,
      runBreakMin: runBreakMin.value,
      completedRounds: completedRounds.value,
      phaseStartedAtMs,
      mode: mode(),
      upElapsedSec: upElapsedSec.value,
    }
    writeLocal(LIVE_KEY, JSON.stringify(snap))
  }

  /* ---------- 设置 / 关联待办的反应式维护 ---------- */

  watch(
    settings,
    (s) => {
      writeLocal(SETTINGS_KEY, JSON.stringify(s))
      // 尚未起跑的新专注相位跟随设置刷新冻结总秒数；一旦起跑（或相位中途）就冻结，不再改写
      if (phase.value === 'focus' && !running.value && phaseStartedAtMs === 0 && runFocusMin.value === null) {
        phaseTotalSec.value = s.focusMin * 60
        remainingSec.value = phaseTotalSec.value
      }
      // 计时方向只影响显示口径：切到 down 时把正计时读数归零，切回 up 时剩余不重要。
      // 正在跑的一段不允许中途换向（会与已投入的时间对不上），由 setMode 守住入口。
      if (s.mode === 'down') upElapsedSec.value = 0
    },
    { deep: true },
  )

  // 直接赋值（旧组件 `pomo.linkedTodoId = x`）与新 setter 都要落盘，故监听 ref 本身
  watch(linkedTodoId, (id) => {
    writeLocal(LINKED_KEY, JSON.stringify(id))
    persistLive()
  })

  /* ---------- 对外快照（contract §14.1，形状冻结） ---------- */

  /** 拼一份对外快照。相位锚点由 endAt 反推：`phaseStartedAt + remainingSec` = 预计结束时刻，
   *  后端的 `recover_focus` 就按这条等式判「关闭期间是否已走完」（contract §14.1）。 */
  function runtimeSnapshot(): FocusRuntime {
    if (mode() === 'up') {
      // 正计时：没有「剩余到 0」这一说 —— 对外报「距下一颗番茄还有多少秒」，
      // 于是 phaseStartedAt + remainingSec 落在未来，recover_focus 不会误判为已走完。
      const cycle = upCycleSec()
      const toNext = cycle - (upElapsedSec.value % cycle)
      const anchorMs = Date.now() - upElapsedSec.value * 1000
      return {
        phase: phase.value,
        running: running.value,
        remainingSec: toNext,
        plannedFocusMin: focusMinValue(),
        // 正计时不进入休息：如实报 0，而不是编一个将到来的休息长度
        plannedBreakMin: 0,
        phaseStartedAt: new Date(anchorMs).toISOString(),
        linkedTodoId: linkedTodoId.value,
        completedRounds: completedRounds.value,
        reportedAt: new Date().toISOString(),
      }
    }
    const anchorMs =
      endAt > 0
        ? endAt - remainingSec.value * 1000
        : Date.now() - (phaseTotalSec.value - remainingSec.value) * 1000
    // plannedBreakMin：专注相位报「这一段结束后将进入的休息」，休息相位报当前休息长度
    const plannedBreak =
      phase.value === 'focus'
        ? breakMinForRounds(completedRounds.value + 1, breakMinValue())
        : breakPlannedMin()
    return {
      phase: phase.value,
      running: running.value,
      remainingSec: remainingSec.value,
      plannedFocusMin: focusMinValue(),
      plannedBreakMin: plannedBreak,
      phaseStartedAt: new Date(anchorMs).toISOString(),
      linkedTodoId: linkedTodoId.value,
      completedRounds: completedRounds.value,
      reportedAt: new Date().toISOString(),
    }
  }

  /** 上报一份运行态（仅计时中）；状态没变则跳过。失败静默：上报不是用户的动作。 */
  function publishRuntime(): void {
    if (!running.value) return
    const snap = runtimeSnapshot()
    const key = JSON.stringify({ ...snap, reportedAt: '' })
    if (published && key === publishedKey) return
    publishedKey = key
    published = true
    void gatewayService.focusPublish(snap).catch(() => {})
  }

  /** 清掉运行态（暂停 / 复位 / 相位结束）：没报过就不发，避免无谓 IPC。 */
  function clearRuntime(): void {
    if (!published) return
    published = false
    publishedKey = ''
    void gatewayService.focusUnpublish().catch(() => {})
  }

  /* ---------- 落库（可失败）与送达 ---------- */

  async function tryPersistSession(input: PomodoroSessionInput): Promise<boolean> {
    try {
      await pomodoroService.saveSession(input)
      return true
    } catch {
      return false
    }
  }

  /** 先补写上次失败的记录；仍失败就留在待重试队列里（由相位结束时的通知兜底告知）。 */
  async function flushPending(): Promise<void> {
    if (pendingSessions.length === 0) return
    const rest: PomodoroSessionInput[] = []
    for (const p of pendingSessions) {
      if (!(await tryPersistSession(p))) rest.push(p)
    }
    pendingSessions = rest
  }

  function mkNotice(title: string, body: string, tone: Phase, delivered: boolean): FocusNotice {
    return { id: crypto.randomUUID(), title, body, tone, at: new Date().toISOString(), delivered }
  }

  /**
   * 相位结束送达：系统通知 + （设置开启时）提示音，并把结果写成一条 `notice`。
   * 写库若还有待补写的记录，把 notice 让给它（「记录没落下」比「阶段结束」更要紧，且同样不静默）。
   */
  async function announcePhaseEnd(tone: Phase, title: string, body: string): Promise<void> {
    const delivered = await notifyFocusPhase(title, body)
    if (settings.value.chime) playPhaseChime(tone)
    if (pendingSessions.length > 0) {
      notice.value = mkNotice('记录未保存', '这段专注还在，下次阶段结束会自动补写', tone, false)
      return
    }
    notice.value = mkNotice(title, body, tone, delivered)
  }

  /* ---------- 今日统计口径 ---------- */

  const todayFocusMin = computed(() => todaySessions.value.reduce((s, x) => s + x.focusMin, 0))
  const todayCompletedCount = computed(() => todaySessions.value.filter((s) => s.completed).length)
  const todayInterruptedCount = computed(() => todaySessions.value.filter((s) => !s.completed).length)

  /* ---------- 相位推进（必须执行，不依赖写库成功） ---------- */

  /** 把「本段累计暂停」归零并停掉暂停看门狗（进入新相位 / 复位 / 重来都要走） */
  function resetPause(): void {
    pausedAccumSec.value = 0
    pauseStartedAt = 0
    if (pauseTimer) {
      clearInterval(pauseTimer)
      pauseTimer = null
    }
  }

  function advanceFocusToBreak(): void {
    resetPause()
    phase.value = 'break'
    phaseTotalSec.value = breakPlannedMin() * 60
    remainingSec.value = phaseTotalSec.value
    phaseStartedAtMs = 0
    // 转入休息：接着 start() 会立刻报一份休息态，所以这里不先清（免得白跑一趟 unpublish）
    start()
  }

  function advanceBreakToFocus(): void {
    clearRuntime() // 休息结束：这一轮专注结束，对外回到「没有进行中的计时」
    resetPause()
    phase.value = 'focus'
    // 外部起跑的一次性覆盖只覆盖「这一轮专注 + 它的休息」；回到新轮次即失效（回到本地设置）
    runFocusMin.value = null
    runBreakMin.value = null
    phaseTotalSec.value = settings.value.focusMin * 60
    remainingSec.value = phaseTotalSec.value
    phaseStartedAtMs = 0
    persistLive() // 全新空闲相位：快照随之清空
  }

  /* ---------- 计时 ---------- */

  function tick(): void {
    if (mode() === 'up') {
      // 正计时：读秒往上走；每跨过一个周期边界就记一颗番茄，然后接着走（不进入休息）
      const elapsed = upBaseSec + Math.round((Date.now() - upAnchorAt) / 1000)
      if (elapsed !== upElapsedSec.value) {
        upElapsedSec.value = Math.max(0, elapsed)
        persistLive()
      }
      const crossed = Math.floor(upElapsedSec.value / upCycleSec())
      if (crossed > recordedCycles) {
        recordedCycles = crossed
        void recordUpCycle()
      }
      return
    }
    // 只在整秒变化时才写 remainingSec：250ms 的采样保证相位结束最多晚 250ms，但不引发每秒 4 次重排
    const next = Math.max(0, Math.round((endAt - Date.now()) / 1000))
    if (next !== remainingSec.value) {
      remainingSec.value = next
      persistLive()
    }
    if (next === 0) void finishPhase()
  }

  function stopTimer(): void {
    running.value = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (publishTimer) {
      clearInterval(publishTimer)
      publishTimer = null
    }
    endAt = 0
  }

  /* ---------- 最长暂停看门狗 ---------- */

  /** 暂停开始：起 1s 看门狗，累计暂停一旦超过 settings.maxPauseMin 就自动结束本段。 */
  function startPauseWatch(): void {
    if (settings.value.maxPauseMin <= 0) return
    if (pauseStartedAt === 0) pauseStartedAt = Date.now()
    pauseTimer ??= setInterval(() => {
      if (pauseStartedAt === 0) return
      const acc = pausedAccumSec.value + Math.round((Date.now() - pauseStartedAt) / 1000)
      pausedAccumSec.value = acc
      if (acc >= settings.value.maxPauseMin * 60) {
        // 超时：按「提前结束本段」处理 —— 专注记中断（≥60s 才写），休息直接跳过
        resetPause()
        void endPhase()
      }
    }, 1000)
  }

  /** 续跑：把本次暂停段计入累计并停表 */
  function freezePause(): void {
    if (pauseStartedAt > 0) {
      pausedAccumSec.value += Math.round((Date.now() - pauseStartedAt) / 1000)
      pauseStartedAt = 0
    }
    if (pauseTimer) {
      clearInterval(pauseTimer)
      pauseTimer = null
    }
  }

  /**
   * 起跑。可选参数由外部下行控制（`pomodoro.start` 载荷，contract §14.3）带入：
   * `focusMin` / `breakMin` 覆盖本轮时长，`todoId` 关联待办。全部省略时与无参调用行为一致
   * （界面按钮走的就是无参这条）。
   *
   * 已经在跑就直接返回 —— 重复收到同一 `start` 不会重新起跑、也不会改写本轮参数（幂等）。
   */
  function start(opts?: { focusMin?: number; breakMin?: number; todoId?: number | null }): void {
    if (running.value) return
    freezePause() // 从暂停续跑：先把这次暂停段计入累计、停掉看门狗
    if (opts) {
      // 只在专注相位（含复位后的初始态）采用外部时长：休息相位里的 start 是「续走休息」，
      // 与专注/休息参数无关，别让它改到下一轮的算法上去。
      if (phase.value === 'focus') {
        if (opts.focusMin != null && opts.focusMin > 0) {
          runFocusMin.value = opts.focusMin
          if (mode() === 'down') {
            remainingSec.value = Math.round(opts.focusMin * 60)
            // 外部覆盖也属「进入相位」：此刻一并冻结总秒数
            phaseTotalSec.value = remainingSec.value
          }
        }
        if (opts.breakMin != null && opts.breakMin > 0) runBreakMin.value = opts.breakMin
      }
      if (opts.todoId !== undefined) setLinkedTodo(opts.todoId ?? null)
    }

    // 正计时：没有「剩余到 0」，读数从当前累计位置往上走；新的一段（0）重置周期计数
    if (mode() === 'up') {
      if (phase.value !== 'focus') phase.value = 'focus'
      if (upElapsedSec.value === 0) recordedCycles = 0
      upAnchorAt = Date.now()
      upBaseSec = upElapsedSec.value
      if (phaseStartedAtMs === 0) phaseStartedAtMs = Date.now()
      running.value = true
      timer ??= setInterval(tick, 250)
      publishRuntime()
      publishTimer ??= setInterval(publishRuntime, PUBLISH_INTERVAL_MS)
      persistLive()
      return
    }

    if (remainingSec.value === 0) return
    if (phaseStartedAtMs === 0) phaseStartedAtMs = Date.now()
    endAt = Date.now() + remainingSec.value * 1000
    running.value = true
    timer ??= setInterval(tick, 250)
    // 起跑立即报一份（不等 1s 周期），外部轮询 status 不必等下一秒才看见
    publishRuntime()
    publishTimer ??= setInterval(publishRuntime, PUBLISH_INTERVAL_MS)
    persistLive()
  }

  function pause(): void {
    if (!running.value) return
    if (mode() === 'up') {
      // 正计时：把当前运行段折算进累计并冻结锚点，续跑从此处推进
      upElapsedSec.value = upBaseSec + Math.max(0, Math.round((Date.now() - upAnchorAt) / 1000))
      upBaseSec = upElapsedSec.value
    } else {
      remainingSec.value = Math.max(0, Math.round((endAt - Date.now()) / 1000))
    }
    stopTimer()
    startPauseWatch() // 超过「最长暂停」自动结束本段（maxPauseMin = 0 则不限）
    clearRuntime() // 暂停：对外不再有「进行中的计时」（contract §14.4）
    persistLive()
  }

  /** 回到本番茄钟初：把**当前相位**倒回起点重来，不写任何记录（区别于「放弃」reset）。 */
  function rewindPhase(): void {
    resetPause()
    if (phase.value === 'focus' && mode() === 'up') {
      upElapsedSec.value = 0
      upBaseSec = 0
      upAnchorAt = Date.now()
      recordedCycles = 0
      phaseStartedAtMs = running.value ? Date.now() : 0
      persistLive()
      return
    }
    if (phase.value === 'focus') phaseTotalSec.value = focusMinValue() * 60
    remainingSec.value = phaseTotalSec.value
    if (running.value) endAt = Date.now() + remainingSec.value * 1000
    phaseStartedAtMs = running.value ? Date.now() : 0
    persistLive()
  }

  /** 提前结束本阶段：专注 → 记录并结束本轮（进休息）；休息 → 跳过休息回专注。 */
  function endPhase(): Promise<void> | void {
    if (phase.value === 'focus') return endRound()
    reset()
  }

  /** 切换计时方向（番茄钟 / 正计时）。进行中不换向（已投入的时间会与方向对不上），由 UI 禁用入口。 */
  function setMode(m: PomodoroMode): void {
    if (settings.value.mode === m) return
    if (active.value) return
    settings.value.mode = m
    phase.value = 'focus'
    phaseTotalSec.value = settings.value.focusMin * 60
    remainingSec.value = phaseTotalSec.value
    upElapsedSec.value = 0
    upBaseSec = 0
    upAnchorAt = 0
    recordedCycles = 0
    phaseStartedAtMs = 0
    persistLive()
  }

  /** 放弃 / 跳过休息：不落库、回专注相位、**不动 completedRounds**（见下方注释）。 */
  function reset(): void {
    stopTimer()
    resetPause()
    clearRuntime()
    phase.value = 'focus'
    // 外部起跑带来的一次性覆盖随「停止」作废：回到用户本地设置
    runFocusMin.value = null
    runBreakMin.value = null
    phaseTotalSec.value = settings.value.focusMin * 60
    remainingSec.value = phaseTotalSec.value
    upElapsedSec.value = 0
    upBaseSec = 0
    upAnchorAt = 0
    recordedCycles = 0
    phaseStartedAtMs = 0
    // reset() 刻意**不清空 completedRounds**：它是「今天这个长休周期已完成的轮数」，
    // 只有走满整轮才 +1，放弃从未计入过。有位评审建议清空，但那会让「今天已完成 3 段」
    // 的历史被一次误点抹掉——真实投入不该因误触而消失。
    persistLive() // 放弃本轮：不留接管快照
  }

  /** 正计时每跨过一个番茄周期：记一颗完整番茄（completed:true），然后**继续**走，不进休息。 */
  async function recordUpCycle(): Promise<void> {
    const cyc = Math.max(1, Math.round(upCycleSec() / 60))
    const input: PomodoroSessionInput = {
      todoId: linkedTodoId.value,
      startedAt: new Date(Date.now() - upCycleSec() * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      focusMin: cyc,
      breakMin: 0,
      completed: true,
    }
    completedRounds.value += 1
    saveRounds()
    await flushPending()
    if (!(await tryPersistSession(input))) pendingSessions.push(input)
    persistLive()
    await announcePhaseEnd('focus', '又攒到一颗番茄', `已专注 ${cyc} 分钟 · 继续`)
    await loadToday().catch(() => {})
  }

  /** 正计时收尾：把最后一个未满周期的零头（≥60s）记成中断段，然后回空闲专注相位。 */
  async function endUpSession(): Promise<void> {
    if (running.value) {
      upElapsedSec.value = upBaseSec + Math.max(0, Math.round((Date.now() - upAnchorAt) / 1000))
    }
    const cycle = upCycleSec()
    const leftover = Math.max(0, upElapsedSec.value - recordedCycles * cycle)
    const totalMin = Math.round(upElapsedSec.value / 60)
    stopTimer()
    resetPause()
    clearRuntime()
    await flushPending()
    if (leftover >= MIN_RECORD_SEC) {
      const input: PomodoroSessionInput = {
        todoId: linkedTodoId.value,
        startedAt: new Date(Date.now() - leftover * 1000).toISOString(),
        endedAt: new Date().toISOString(),
        focusMin: Math.max(1, Math.round(leftover / 60)),
        breakMin: 0,
        completed: false,
      }
      if (!(await tryPersistSession(input))) pendingSessions.push(input)
    }
    phase.value = 'focus'
    upElapsedSec.value = 0
    upBaseSec = 0
    upAnchorAt = 0
    recordedCycles = 0
    phaseTotalSec.value = settings.value.focusMin * 60
    remainingSec.value = phaseTotalSec.value
    phaseStartedAtMs = 0
    persistLive()
    await announcePhaseEnd(
      'focus',
      '正计时结束',
      totalMin >= 1 ? `这次累计专注 ${totalMin} 分钟` : '这一段太短，没留下记录',
    )
    await loadToday().catch(() => {})
  }

  /**
   * 记录并结束本轮（中断）。实际投入 ≥ 60 秒才写 `completed:false` + 真实 `focusMin`；
   * 不足 60 秒视为误触不写。随后进入休息（与自然完成同路径，但 `completedRounds` 不变）。
   */
  async function endRound(): Promise<void> {
    if (phase.value !== 'focus') return
    if (mode() === 'up') {
      await endUpSession()
      return
    }
    // 提前把 remaining 对齐到真实剩余（endRound 可能在整秒之间被点），保证真实投入不虚高
    if (running.value) remainingSec.value = Math.max(0, Math.round((endAt - Date.now()) / 1000))
    stopTimer()
    resetPause()
    const elapsedSec = Math.max(0, phaseTotalSec.value - remainingSec.value)
    await flushPending()
    if (elapsedSec >= MIN_RECORD_SEC) {
      const input: PomodoroSessionInput = {
        todoId: linkedTodoId.value,
        startedAt: new Date(phaseStartedAtMs || Date.now() - elapsedSec * 1000).toISOString(),
        endedAt: new Date().toISOString(),
        focusMin: Math.max(1, Math.round(elapsedSec / 60)),
        breakMin: breakPlannedMin(),
        completed: false,
      }
      if (!(await tryPersistSession(input))) pendingSessions.push(input)
    }
    const investedMin = Math.round(elapsedSec / 60)
    const restMin = breakPlannedMin()
    advanceFocusToBreak()
    await announcePhaseEnd(
      'focus',
      '本轮结束',
      elapsedSec >= MIN_RECORD_SEC ? `已记 ${investedMin} 分钟 · 休息 ${restMin} 分钟` : `休息 ${restMin} 分钟`,
    )
    await loadToday().catch(() => {})
  }

  /**
   * 给当前相位加时（浮条调用）。加时 = 用户显式延长了这一段，故计划变长、
   * `phaseTotalSec` 随之变大（progress 分母变长是正确的）。
   */
  function extend(min: number): void {
    if (!Number.isFinite(min) || min <= 0) return
    const sec = Math.round(min * 60)
    phaseTotalSec.value += sec
    remainingSec.value += sec
    if (running.value) endAt += sec * 1000
    persistLive()
  }

  function setLinkedTodo(id: number | null): void {
    linkedTodoId.value = id // 落盘与快照由 watch(linkedTodoId) 负责
  }

  function dismissNotice(): void {
    notice.value = null
  }

  /* ---------- 相位结束：写库（可失败）与推进（必须执行）分离 ---------- */

  /** 记录一段自然完成的专注：写库失败不阻断推进，记待重试并让 notice 告知。 */
  async function recordFocusFinished(): Promise<void> {
    await flushPending()
    const input: PomodoroSessionInput = {
      todoId: linkedTodoId.value,
      startedAt: new Date(phaseStartedAtMs || Date.now()).toISOString(),
      endedAt: new Date().toISOString(),
      focusMin: focusMinValue(),
      // 该轮计划休息分钟：先按「这一轮也要计入」的轮次数取，再自增，语义一致
      breakMin: breakMinForRounds(completedRounds.value + 1, breakMinValue()),
      completed: true,
    }
    completedRounds.value += 1
    saveRounds()
    if (!(await tryPersistSession(input))) pendingSessions.push(input)
  }

  /**
   * 相位结束。写库（可失败）与相位推进（必须执行）分成两段——旧实现把两者串在一个
   * `await` 链里，IPC 一失败 `completedRounds++` / 相位切换 / `start()` 全不执行，
   * `remainingSec===0` 后 `start()` 直接 return，只能刷新页面才恢复（死锁）。
   */
  async function finishPhase(): Promise<void> {
    stopTimer()
    if (phase.value === 'focus') {
      await recordFocusFinished()
      const roundNo = completedRounds.value
      const body = `第 ${roundNo} 段 · ${focusMinValue()} 分钟 · 休息 ${breakPlannedMin()} 分钟`
      advanceFocusToBreak() // 相位推进：无论写库成败都必须执行
      await announcePhaseEnd('focus', '专注完成', body)
      await loadToday().catch(() => {})
    } else {
      clearRuntime()
      await flushPending() // 两个相位结束都先补写待重试记录
      advanceBreakToFocus()
      await announcePhaseEnd('break', '休息结束', '回到专注，开始下一段')
    }
  }

  /* ---------- 加载与冷启动接管 ---------- */

  async function loadToday(): Promise<void> {
    const t = todayStr()
    // 后端按 UTC 前缀过滤，跨零点会漏/串：取 ±1 天再按本地日期前缀收窄（见 localDateOf）
    const rows = await pomodoroService.listSessions(addDays(t, -1), addDays(t, 1))
    todaySessions.value = rows.filter((r) => localDateOf(r.startedAt) === t)
    // 跨天归零今日轮次（date 不是今天）
    if (loadRounds() !== completedRounds.value) completedRounds.value = loadRounds()
    saveRounds()
    await pruneStaleLinkedTodo(t)
  }

  /** 关联待办若已不在今日列表里，则置空——别让浮条/卡片显示一条已删的待办。 */
  async function pruneStaleLinkedTodo(date: string): Promise<void> {
    if (linkedTodoId.value == null) return
    try {
      const todos = await todoService.listTodos(date, date)
      if (!todos.some((x) => x.id === linkedTodoId.value)) setLinkedTodo(null)
    } catch {
      /* 读不到待办时不误删关联：宁可暂时留着，也不清掉用户选的 */
    }
  }

  async function loadRecent(): Promise<void> {
    const t = todayStr()
    const from = addDays(t, -6)
    const rows = await pomodoroService.listSessions(from, t)
    recentSessions.value = rows.filter((r) => {
      const d = localDateOf(r.startedAt)
      return d >= from && d <= t
    })
  }

  /**
   * 近 7 天**完整段**的中位专注时长 → 建议值（吸附到 5 的倍数）。
   *
   * 为什么不硬编码「最优时长」：番茄工作法 25 分钟的原始出处无同行评审支撑，52/17 与 90min
   * 也各自漂移或只在睡眠期测得。既然没有权威常量，就从用户**自身基线**给建议，决策权留给用户：
   * 样本 < 5 段或与当前档位偏离 < 20% 时返回 null（不值得打扰），且**永不自动改写** settings。
   */
  const suggestedFocusMin = computed<number | null>(() => {
    const mins = recentSessions.value.filter((s) => s.completed).map((s) => s.focusMin)
    if (mins.length < 5) return null
    const sorted = [...mins].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
    const cur = settings.value.focusMin
    if (cur <= 0 || Math.abs(median - cur) / cur < 0.2) return null
    return Math.max(5, Math.round(median / 5) * 5)
  })

  /**
   * 冷启动接管：读进行中快照，处理「关 App 期间」的三种情形。
   * - 专注且已走完、且已投入 ≥ 60s → 补写一条 completed:true（用户关了 App，那一轮其实走完了）；
   *   此刻没法确认用户看见，故 notice.delivered = false（留在页面上）。
   * - 还在走 / 暂停中 → 停在暂停态（不自动 start），提示「上一轮还在」。
   * - 投入 < 60s → 丢弃。
   */
  async function restoreLive(): Promise<void> {
    let snap: LiveSnapshot | null = null
    try {
      const raw = readLocal(LIVE_KEY)
      if (raw) snap = JSON.parse(raw) as LiveSnapshot
    } catch {
      snap = null // 损坏快照按「没有」处理
    }
    removeLocal(LIVE_KEY)
    if (!snap) return
    const now = Date.now()
    const investedSec = Math.max(0, snap.phaseTotalSec - snap.remainingSec)
    const finished = snap.running && snap.endAtMs > 0 && snap.endAtMs <= now

    // 正计时快照：没有「是否走完」的判定 —— 恢复累计读数并停在暂停态。
    // 关 App 期间跨过的周期边界不再补记（无法确认那一刻用户是否真的在专注），
    // 只把已累计的读数如实放回，由用户决定继续还是重置。
    if ((snap.mode ?? 'down') === 'up') {
      const el = Math.max(0, snap.upElapsedSec ?? 0)
      if (el < MIN_RECORD_SEC) return
      phase.value = 'focus'
      upElapsedSec.value = el
      upBaseSec = el
      recordedCycles = Math.floor(el / upCycleSec())
      phaseStartedAtMs = snap.phaseStartedAtMs
      notice.value = mkNotice('正计时还在', '点开始继续累加，或重置', 'focus', false)
      persistLive()
      return
    }

    if (snap.phase === 'focus' && finished) {
      if (investedSec < MIN_RECORD_SEC) return // 起步就关：不值得补写
      const focusMin = snap.runFocusMin ?? settings.value.focusMin
      const input: PomodoroSessionInput = {
        todoId: snap.linkedTodoId,
        startedAt: new Date(
          snap.phaseStartedAtMs > 0 ? snap.phaseStartedAtMs : snap.endAtMs - snap.phaseTotalSec * 1000,
        ).toISOString(),
        endedAt: new Date(snap.endAtMs).toISOString(),
        focusMin,
        breakMin: breakMinForRounds(snap.completedRounds + 1, snap.runBreakMin ?? settings.value.breakMin),
        completed: true,
      }
      if (!(await tryPersistSession(input))) pendingSessions.push(input)
      completedRounds.value = snap.completedRounds + 1
      saveRounds()
      phase.value = 'focus'
      phaseTotalSec.value = settings.value.focusMin * 60
      remainingSec.value = phaseTotalSec.value
      notice.value = mkNotice('上一轮已记录', `专注 ${focusMin} 分钟，已归到今天`, 'focus', false)
      await loadToday().catch(() => {})
      return
    }

    if (snap.phase === 'break' && finished) {
      // 休息在关闭期间走完：不落库，直接回专注空闲态
      phase.value = 'focus'
      phaseTotalSec.value = settings.value.focusMin * 60
      remainingSec.value = phaseTotalSec.value
      return
    }

    // 还在走 / 暂停中：续走（停在暂停态，不自动 start）
    phase.value = snap.phase
    runFocusMin.value = snap.runFocusMin
    runBreakMin.value = snap.runBreakMin
    completedRounds.value = snap.completedRounds
    linkedTodoId.value = snap.linkedTodoId
    phaseTotalSec.value = snap.phaseTotalSec
    phaseStartedAtMs = snap.phaseStartedAtMs
    const liveRemaining =
      snap.running && snap.endAtMs > 0
        ? Math.max(0, Math.round((snap.endAtMs - now) / 1000))
        : snap.remainingSec
    remainingSec.value = liveRemaining
    notice.value = mkNotice('上一轮还在', '点开始继续，或重置放弃', snap.phase, false)
    persistLive() // 续存快照：这次关 App 之前若再关一次，仍能接管
  }

  /**
   * 冷启动入口（幂等，`main.ts` 调用一次）：恢复今日轮次 / 关联待办，接管上次未走完的运行态。
   * 损坏的 localStorage 全部在读取处兜住，不让它挡住启动。
   */
  let initialized = false
  function init(): void {
    if (initialized) return
    initialized = true
    completedRounds.value = loadRounds()
    linkedTodoId.value = loadLinkedTodo()
    void restoreLive()
    void loadToday().catch(() => {})
    void loadRecent().catch(() => {})
  }

  /* ---------- 派生显示 ---------- */

  /* 读数格式化统一走 utils/clock —— 全局浮窗（独立 webview）与这里共用同一份
     mm:ss / HH:MM:SS 实现，两处读数才可能逐字节一致。 */
  /** 本条真源读数：down = 剩余秒数；up = 已累计秒数。 */
  const readSec = computed(() => (mode() === 'up' ? upElapsedSec.value : remainingSec.value))

  const displayTime = computed(() => fmtClockSec(readSec.value))

  /** 大读数（三段式）：沉浸层与卡片头部用。 */
  const clockTime = computed(() => fmtClockHms(readSec.value))

  /** 进度 0..1：down 分母是本相位冻结的 `phaseTotalSec`；up 分母是一个番茄周期（每满一圈得一颗）。 */
  const progress = computed(() => {
    if (mode() === 'up') {
      const cycle = upCycleSec()
      return Math.min(1, Math.max(0, (upElapsedSec.value % cycle) / cycle))
    }
    const total = phaseTotalSec.value
    if (total <= 0) return 0
    return Math.min(1, Math.max(0, 1 - remainingSec.value / total))
  })

  /** 圆点：长度 = roundsBeforeLongBreak，点亮 = 本轮已完成的轮数（completedRounds 是唯一真源）。 */
  const roundDots = computed<boolean[]>(() => {
    const n = Math.max(1, settings.value.roundsBeforeLongBreak)
    const done = completedRounds.value % n
    const filled = done === 0 && completedRounds.value > 0 ? n : done
    return Array.from({ length: n }, (_, i) => i < filled)
  })

  /** 是否在本相位中途（计时中，或暂停在半途 / 正计时已有累计）。浮条/卡片据此决定是否露出。 */
  const active = computed(() => {
    if (mode() === 'up') return running.value || upElapsedSec.value > 0
    return running.value || remainingSec.value < phaseTotalSec.value
  })

  return {
    settings,
    phase,
    running,
    remainingSec,
    phaseTotalSec,
    upElapsedSec,
    pausedAccumSec,
    linkedTodoId,
    todaySessions,
    recentSessions,
    completedRounds,
    notice,
    displayTime,
    clockTime,
    progress,
    todayFocusMin,
    todayCompletedCount,
    todayInterruptedCount,
    roundDots,
    suggestedFocusMin,
    active,
    init,
    loadToday,
    loadRecent,
    start,
    pause,
    endRound,
    endPhase,
    rewindPhase,
    setMode,
    reset,
    extend,
    setLinkedTodo,
    dismissNotice,
  }
})