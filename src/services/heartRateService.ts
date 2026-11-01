/** 心率域 IPC 封装 · 对应 modules/heartrate/commands.rs。
 *
 * 事件（Tauri）：`hr://status`（状态 / 扫描列表）与 `hr://sample`（节流后的
 * 心率 + 当次测量实时读数）。浏览器 mock 没有事件通道，store 在非 Tauri
 * 环境按 1s 轮询 `hr_state` 镜像同一份状态。 */

import type {
  HrProfileInput,
  HrSample,
  HrStatus,
  HrWorkoutSummary,
} from '@/types'
import { invoke, isTauri } from './transport'

type StatusListener = (s: HrStatus) => void
type SampleListener = (s: HrSample) => void

const statusListeners = new Set<StatusListener>()
const sampleListeners = new Set<SampleListener>()
let bridging: Promise<void> | null = null

function dispatchStatus(s: HrStatus): void {
  for (const cb of [...statusListeners]) cb(s)
}

function dispatchSample(s: HrSample): void {
  for (const cb of [...sampleListeners]) cb(s)
}

/** 事件桥：同一进程只建立一次；失败时清掉缓存，下次订阅还能重试。 */
function bridgeEvents(): Promise<void> {
  bridging ??= (async () => {
    if (isTauri) {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<HrStatus>('hr://status', (e) => dispatchStatus(e.payload))
      await listen<HrSample>('hr://sample', (e) => dispatchSample(e.payload))
      return
    }
    const { mockHeartRate } = await import('@/mock/server')
    mockHeartRate.onStatus = dispatchStatus as (s: unknown) => void
    mockHeartRate.onSample = dispatchSample as (s: unknown) => void
  })().catch((e: unknown) => {
    bridging = null
    throw e
  })
  return bridging
}

export const heartRateService = {
  /** 订阅连接状态 / 扫描列表；返回取消订阅函数 */
  async onStatus(cb: StatusListener): Promise<() => void> {
    await bridgeEvents()
    statusListeners.add(cb)
    return () => statusListeners.delete(cb)
  },

  /** 订阅节流后的心率样本 */
  async onSample(cb: SampleListener): Promise<() => void> {
    await bridgeEvents()
    sampleListeners.add(cb)
    return () => sampleListeners.delete(cb)
  },

  state: () => invoke<HrStatus>('hr_state'),

  setProfile: (p: HrProfileInput) =>
    invoke<HrStatus>('hr_set_profile', {
      ageYears: p.ageYears,
      sex: p.sex,
      weightKg: p.weightKg,
    }),

  scanStart: () => invoke<HrStatus>('hr_scan_start'),
  scanStop: () => invoke<HrStatus>('hr_scan_stop'),

  connect: (id: string, name: string) => invoke<HrStatus>('hr_connect', { id, name }),
  disconnect: () => invoke<HrStatus>('hr_disconnect'),

  workoutStart: (p: HrProfileInput & {
    startedAtMs: number
    deviceId: string | null
    deviceName: string | null
    paused: boolean
  }) =>
    invoke<HrStatus>('hr_workout_start', {
      ageYears: p.ageYears,
      sex: p.sex,
      weightKg: p.weightKg,
      startedAtMs: p.startedAtMs,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      paused: p.paused,
    }),

  workoutFinish: () => invoke<HrWorkoutSummary | null>('hr_workout_finish'),
  workoutCancel: () => invoke<HrStatus>('hr_workout_cancel'),

  /** 跑步暂停 / 自动暂停：暂停期间的样本不计热量与覆盖率 */
  workoutPause: () => invoke<HrStatus>('hr_workout_pause'),
  workoutResume: () => invoke<HrStatus>('hr_workout_resume'),
}
