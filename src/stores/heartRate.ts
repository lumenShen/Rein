/**
 * 心率域：蓝牙设备连接、实时心率与「按心率算消耗」的唯一真源。
 *
 * 分工：采集与积分都在 Rust（modules/heartrate），本 store 只镜像状态：
 *  · Tauri：订阅 `hr://status` / `hr://sample`，1 Hz 更新；
 *  · 浏览器开发：mock 后端没有事件通道，按 1s 轮询 `hr_state`（仅 mock 模式）。
 *
 * 设备记忆只存 localStorage（界面级偏好，不进 SQLite）：训练开始时自动连上次那台，
 * 训练结束自动断开——手环同时只能连一个中心，也没必要在非训练时段占着射频。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { heartRateService } from '@/services/heartRateService'
import { isTauri } from '@/services/transport'
import { useNutritionStore } from '@/stores/nutrition'
import { ageFromBirthday } from '@/utils/date'
import type {
  HrProfileInput,
  HrSample,
  HrStatus,
  HrWorkoutSummary,
  Profile,
} from '@/types'

const DEVICE_KEY = 'rein.hr.device.v1'
/** 覆盖率达到这个值心率热量才可用（心率法对断连空档极其敏感，35% 太宽）。 */
export const HR_KCAL_MIN_COVERAGE = 0.7
/** 至少测满 5 分钟：短样本连稳态都到不了，Keytel 假设直接不成立。 */
export const HR_KCAL_MIN_SEC = 300

interface DevicePref {
  id: string
  name: string
}

function blankStatus(): HrStatus {
  return {
    supported: true,
    state: 'idle',
    device: null,
    devices: [],
    bpm: null,
    contact: null,
    lastSampleAt: null,
    error: null,
    maxHr: null,
    zone: null,
    workoutActive: false,
    liveAvgBpm: null,
    liveMaxBpm: null,
    liveKcal: null,
    liveCoverage: null,
    liveElapsedSec: null,
    liveLevel: null,
  }
}

function readDevicePref(): DevicePref | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DevicePref>
    if (typeof parsed.id !== 'string' || !parsed.id) return null
    return { id: parsed.id, name: typeof parsed.name === 'string' ? parsed.name : '心率设备' }
  } catch {
    return null
  }
}

function writeDevicePref(pref: DevicePref | null): void {
  try {
    if (pref) localStorage.setItem(DEVICE_KEY, JSON.stringify(pref))
    else localStorage.removeItem(DEVICE_KEY)
  } catch {
    /* localStorage 不可用：退化为仅本次会话记忆 */
  }
}

function hrProfileFrom(profile: Profile | null): HrProfileInput {
  return {
    ageYears: profile ? ageFromBirthday(profile.birthday) : null,
    sex: profile?.sex ?? null,
    weightKg: profile?.weightKg ?? null,
  }
}

export const useHeartRateStore = defineStore('heartRate', () => {
  const status = ref<HrStatus>(blankStatus())
  const lastSummary = ref<HrWorkoutSummary | null>(null)
  const devicePref = ref<DevicePref | null>(readDevicePref())
  const workoutStartedAtMs = ref<number | null>(null)
  /** 本次测量是否处于暂停（跑步暂停 / 自动暂停 / 总结）；用于去重 IPC */
  const workoutPaused = ref(false)
  /** 本次训练是否由「自动连接上次设备」发起：训练结束就断开，把中心位还给手机 */
  const autoConnectRequested = ref(false)
  const inited = ref(false)

  const unsubs: (() => void)[] = []
  let pollTimer: number | null = null
  /** 正在进行的「开始测量」（拉画像 + IPC）；结束时先等它落地，避免命令乱序 */
  let pendingBegin: Promise<void> | null = null

  /* ---------- 事件 / 轮询 ---------- */

  function applyStatus(s: HrStatus | null | undefined): void {
    if (!s) return
    status.value = s
    if (s.state === 'connected' && s.device) {
      if (devicePref.value?.id !== s.device.id) {
        devicePref.value = { id: s.device.id, name: s.device.name }
        writeDevicePref(devicePref.value)
      }
    }
  }

  function applySample(s: HrSample): void {
    status.value = {
      ...status.value,
      bpm: s.bpm,
      contact: s.contact,
      lastSampleAt: s.at,
      zone: s.zone,
      workoutActive: s.workoutActive,
      liveAvgBpm: s.liveAvgBpm,
      liveMaxBpm: s.liveMaxBpm,
      liveKcal: s.liveKcal,
      liveCoverage: s.liveCoverage,
      liveElapsedSec: s.liveElapsedSec,
      liveLevel: s.liveLevel,
    }
  }

  async function pollOnce(): Promise<void> {
    try {
      applyStatus(await heartRateService.state())
    } catch {
      /* 后端暂不可用：保留上一帧，不打断训练 */
    }
  }

  /** 应用启动调用（幂等）：桥接事件、镜像初始状态；mock 模式额外起轮询 */
  async function init(): Promise<void> {
    if (inited.value) return
    inited.value = true
    try {
      unsubs.push(await heartRateService.onStatus(applyStatus))
      unsubs.push(await heartRateService.onSample(applySample))
    } catch (e) {
      console.warn('[heartRate] 事件桥接失败，改用轮询', e)
    }
    await pollOnce()
    // 回到前台补一次快照：WebView 挂起期间事件可能丢掉，状态不要停在旧帧上
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void pollOnce()
    })
    if (!isTauri && pollTimer == null) {
      pollTimer = window.setInterval(() => void pollOnce(), 1000)
    }
  }

  /* ---------- 设备连接 ---------- */

  async function scanStart(): Promise<void> {
    try {
      applyStatus(await heartRateService.scanStart())
    } catch (e) {
      markError(e)
    }
  }

  async function scanStop(): Promise<void> {
    try {
      applyStatus(await heartRateService.scanStop())
    } catch (e) {
      markError(e)
    }
  }

  async function connect(device: { id: string; name: string }): Promise<void> {
    try {
      applyStatus(await heartRateService.connect(device.id, device.name))
    } catch (e) {
      markError(e)
    }
  }

  async function disconnect(): Promise<void> {
    try {
      applyStatus(await heartRateService.disconnect())
    } catch (e) {
      markError(e)
    }
  }

  function markError(e: unknown): void {
    status.value = {
      ...status.value,
      state: 'error',
      error: e instanceof Error ? e.message : String(e),
    }
  }

  /* ---------- 身体数据 ---------- */

  async function configureProfile(profile: Profile | null): Promise<void> {
    if (!profile) return
    try {
      applyStatus(await heartRateService.setProfile(hrProfileFrom(profile)))
    } catch {
      /* 画像同步失败不挡设备连接 */
    }
  }

  async function ensureProfileInput(): Promise<HrProfileInput> {
    const nutrition = useNutritionStore()
    if (!nutrition.profile) {
      try {
        await nutrition.loadProfile()
      } catch {
        /* 拿不到画像时后端用默认年龄 / 体重兜底 */
      }
    }
    return hrProfileFrom(nutrition.profile)
  }

  /* ---------- 测量会话（训练课 / 跑步共用） ---------- */

  /** 开始测量。恢复会话时传入原 startedAtIso，让覆盖率按整场时长算。
   *  跑步恢复到暂停态时 `paused: true`：暂停期间的心率不计热量。 */
  async function beginWorkout(
    startedAtIso: string,
    opts?: { paused?: boolean },
  ): Promise<void> {
    if (!status.value.supported) return
    const parsed = Date.parse(startedAtIso)
    const started = Number.isNaN(parsed) ? Date.now() : parsed
    if (workoutStartedAtMs.value === started) return
    workoutStartedAtMs.value = started
    workoutPaused.value = opts?.paused === true
    lastSummary.value = null
    const run = (async () => {
      const profile = await ensureProfileInput()
      // 等待画像期间用户可能已经结束 / 放弃这场运动：别再补一条迟到的开始命令
      if (workoutStartedAtMs.value !== started) return
      const device = devicePref.value
      autoConnectRequested.value = !!device && status.value.state !== 'connected'
      try {
        applyStatus(
          await heartRateService.workoutStart({
            ...profile,
            startedAtMs: started,
            deviceId: device?.id ?? null,
            deviceName: device?.name ?? null,
            paused: opts?.paused === true,
          }),
        )
      } catch (e) {
        console.warn('[heartRate] 开始测量失败（不影响训练）', e)
      }
    })()
    const wrapped = run.finally(() => {
      if (pendingBegin === wrapped) pendingBegin = null
    })
    pendingBegin = wrapped
    return wrapped
  }

  /** 跑步暂停 / 自动暂停 / 进入总结时冻结积分；恢复时解冻。 */
  async function setWorkoutPaused(paused: boolean): Promise<void> {
    if (workoutStartedAtMs.value == null || workoutPaused.value === paused) return
    workoutPaused.value = paused
    try {
      applyStatus(
        paused ? await heartRateService.workoutPause() : await heartRateService.workoutResume(),
      )
    } catch {
      /* 暂停积分失败只影响热量精度，不打断跑步 */
    }
  }

  /**
   * 结束测量并取回总结。重复调用（保存失败后重试）直接返回上一次的结果，
   * 避免第二次拿到 null 把已算好的心率热量弄丢。
   */
  async function finishWorkout(): Promise<HrWorkoutSummary | null> {
    if (workoutStartedAtMs.value == null && lastSummary.value != null) {
      return lastSummary.value
    }
    // 开始测量可能还在拉画像 / 发 IPC：等它落地再收尾，否则晚到的 start 会留下一场幽灵测量
    if (pendingBegin) {
      try {
        await pendingBegin
      } catch {
        /* begin 自己已兜住错误 */
      }
    }
    let summary: HrWorkoutSummary | null = null
    try {
      summary = await heartRateService.workoutFinish()
    } catch (e) {
      console.warn('[heartRate] 结束测量失败（回退到 MET / ACSM 估算）', e)
    }
    lastSummary.value = summary
    workoutStartedAtMs.value = null
    workoutPaused.value = false
    if (autoConnectRequested.value) {
      autoConnectRequested.value = false
      void disconnect()
    }
    return summary
  }

  /** 放弃本次测量（放弃训练时调用）：不产生总结，也不参与消耗。 */
  async function cancelWorkout(): Promise<void> {
    workoutStartedAtMs.value = null
    workoutPaused.value = false
    lastSummary.value = null
    // 与 finishWorkout 同一条纪律：先等 start 落地，再取消；否则晚到的 start 会留下一场幽灵测量
    if (pendingBegin) {
      try {
        await pendingBegin
      } catch {
        /* begin 自己已兜住错误 */
      }
    }
    try {
      applyStatus(await heartRateService.workoutCancel())
    } catch {
      /* 会话已本地收尾，后端清理失败只留日志 */
    }
    if (autoConnectRequested.value) {
      autoConnectRequested.value = false
      void disconnect()
    }
  }

  /** 记录已写完：清掉总结，避免下一场误用。 */
  function clearFinished(): void {
    lastSummary.value = null
  }

  /* ---------- 派生 ---------- */

  const connected = computed(() => status.value.state === 'connected')
  const scanning = computed(() => status.value.state === 'scanning')
  const connecting = computed(() => status.value.state === 'connecting')
  const reconnecting = computed(() => status.value.state === 'reconnecting')
  const supported = computed(() => status.value.supported)
  const bpm = computed(() => status.value.bpm)
  const contact = computed(() => status.value.contact)
  const zone = computed(() => status.value.zone ?? status.value.liveLevel)
  const maxHr = computed(() => status.value.maxHr)
  const device = computed(() => status.value.device)
  const deviceName = computed(() => status.value.device?.name ?? devicePref.value?.name ?? '')
  const devices = computed(() => status.value.devices)
  const error = computed(() => status.value.error)
  const workoutActive = computed(
    () => workoutStartedAtMs.value != null || status.value.workoutActive,
  )

  /** 本次测量的实时 / 已结束读数（展示口径统一从这里取）。
   *  有总结时以总结为准：结束那一拍的状态事件可能晚于命令返回值。 */
  const liveAvgBpm = computed(
    () => lastSummary.value?.avgBpm ?? status.value.liveAvgBpm ?? null,
  )
  const liveMaxBpm = computed(
    () => lastSummary.value?.maxBpm ?? status.value.liveMaxBpm ?? null,
  )
  const liveKcal = computed(
    () => lastSummary.value?.kcal ?? status.value.liveKcal ?? null,
  )
  const liveCoverage = computed(
    () => lastSummary.value?.coverage ?? status.value.liveCoverage ?? null,
  )
  /** 实际测到的心率秒数（结束用总结；进行中用覆盖率 × 净时长估算） */
  const liveMeasuredSec = computed<number | null>(() => {
    if (lastSummary.value) return lastSummary.value.measuredSec
    if (status.value.liveCoverage == null) return null
    return Math.round((status.value.liveElapsedSec ?? 0) * status.value.liveCoverage)
  })
  const liveLevel = computed(
    () => lastSummary.value?.level ?? status.value.liveLevel ?? null,
  )

  /**
   * 可用的心率热量（取整）。覆盖率不足 70% 或没有样本时为 null。
   * 心率法（Keytel）只在稳态有氧上可用：跑步仅在没有距离数据时兜底，
   * 力量/课程热量一律不吃它（见 run/session store 的口径注释）。
   */
  const usableKcal = computed<number | null>(() => {
    // 结束后的总结是权威读数：即便状态事件还没把 workoutActive 翻成 false，也先用它
    const summary = lastSummary.value
    if (
      summary &&
      summary.measuredSec >= HR_KCAL_MIN_SEC &&
      summary.coverage >= HR_KCAL_MIN_COVERAGE &&
      (summary.kcal ?? 0) > 0
    ) {
      return Math.round(summary.kcal ?? 0)
    }
    if (status.value.workoutActive) {
      const coverage = status.value.liveCoverage ?? 0
      const kcal = status.value.liveKcal ?? 0
      const elapsed = status.value.liveElapsedSec ?? 0
      return elapsed >= HR_KCAL_MIN_SEC && coverage >= HR_KCAL_MIN_COVERAGE && kcal > 0
        ? Math.round(kcal)
        : null
    }
    return null
  })

  return {
    status,
    lastSummary,
    devicePref,
    workoutStartedAtMs,
    inited,
    connected,
    scanning,
    connecting,
    reconnecting,
    supported,
    bpm,
    contact,
    zone,
    maxHr,
    device,
    deviceName,
    devices,
    error,
    workoutActive,
    liveAvgBpm,
    liveMaxBpm,
    liveKcal,
    liveCoverage,
    liveMeasuredSec,
    liveLevel,
    usableKcal,
    init,
    scanStart,
    scanStop,
    connect,
    disconnect,
    configureProfile,
    beginWorkout,
    setWorkoutPaused,
    finishWorkout,
    cancelWorkout,
    clearFinished,
  }
})
