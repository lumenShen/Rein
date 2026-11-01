/** 心率域类型 · 与 Rust `modules/heartrate/models.rs` 对应。 */

export type HrConnState =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

export interface HrDevice {
  id: string
  name: string
  rssi: number | null
  /** 广播里带了标准心率服务 0x180D（只作排序 / 标记，不代表一定连得上） */
  hasHeartRate: boolean
}

/** 后端轮询 / 事件共用的完整状态快照 */
export interface HrStatus {
  supported: boolean
  state: HrConnState
  device: HrDevice | null
  /** 扫描期间发现的设备（按「心率设备优先 + RSSI 降序」排好） */
  devices: HrDevice[]
  bpm: number | null
  contact: boolean | null
  lastSampleAt: number | null
  error: string | null
  maxHr: number | null
  zone: number | null
  workoutActive: boolean
  liveAvgBpm: number | null
  liveMaxBpm: number | null
  liveKcal: number | null
  liveCoverage: number | null
  liveElapsedSec: number | null
  liveLevel: number | null
}

/** 单条心率样本（1 Hz 节流后）+ 当次测量的实时读数 */
export interface HrSample {
  bpm: number
  contact: boolean | null
  at: number
  rrMs: number[]
  zone: number | null
  pctMax: number | null
  workoutActive: boolean
  liveAvgBpm: number | null
  liveMaxBpm: number | null
  liveKcal: number | null
  liveCoverage: number | null
  liveElapsedSec: number | null
  liveLevel: number | null
}

export interface HrZoneTime {
  zone: number
  seconds: number
}

/** 一次测量会话的最终读数 */
export interface HrWorkoutSummary {
  durationSec: number
  measuredSec: number
  /** measuredSec / durationSec，0..1 */
  coverage: number
  samples: number
  avgBpm: number | null
  maxBpm: number | null
  minBpm: number | null
  kcal: number | null
  zones: HrZoneTime[]
  /** 平均心率所在 5 分区（1..5） */
  level: number | null
  /** 由平均心率反推的强度档；与 healthsync 的阈值一致 */
  intensity: 'low' | 'moderate' | 'high' | null
}

/** 计算心率区间 / 热量所需的身体数据（年龄由生日换算） */
export interface HrProfileInput {
  ageYears: number | null
  sex: 'male' | 'female' | null
  weightKg: number | null
}
