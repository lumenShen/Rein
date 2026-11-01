/** 训练课会话 IPC 封装 · 对应 modules/session/commands.rs */

import type {
  HrWorkoutSummary,
  RunSnapshot,
  SessionRecord,
  SessionSnapshotState,
  StrengthExerciseRef,
  StrengthLastWeight,
  StrengthSetRecord,
  StrengthSetRow,
  Workout,
} from '@/types'
import { invoke } from './transport'

/** 会话状态快照：课程与跑步两种结构（Rust state_json 透传） */
type SessionState = SessionSnapshotState | RunSnapshot

export const sessionService = {
  start: (p: { planId: string; planName: string; startedAt: string; state: SessionState }) =>
    invoke<SessionRecord>('session_start', {
      planId: p.planId,
      planName: p.planName,
      startedAt: p.startedAt,
      stateJson: p.state,
    }),

  /** 事件级快照（做组/休息/计时/重量调整后调用）。elapsedSec 由服务端累加。 */
  snapshot: (p: {
    id: number
    exIndex: number
    setIndex: number
    weightKg: number
    state: SessionState
  }) =>
    invoke<void>('session_snapshot', {
      id: p.id,
      exIndex: p.exIndex,
      setIndex: p.setIndex,
      weightKg: p.weightKg,
      stateJson: p.state,
    }),

  /** 存在进行中（含异常中断）的训练时返回记录，否则 null */
  getActive: () => invoke<SessionRecord | null>('session_active'),

  /** 正常结束（保存）：事务内写入训练记录 + 逐组做组明细（重量曲线数据源）并关闭会话。
   *  `intensity` 可空（Rust 侧是 `Option<String>`）：外部下行的结束载荷允许省略它。
   *  `hr` 是整场心率摘要（无样本传 null）：Rust 原样落进 workouts.hr_json。 */
  finish: (p: {
    id: number
    name: string
    workoutType: string
    date: string
    durationMin: number
    intensity: string | null
    kcal: number
    note: string | null
    hr?: HrWorkoutSummary | null
    sets: StrengthSetRow[]
  }) => invoke<Workout>('session_finish', { input: p }),

  /** 正常结束（放弃）：仅关闭会话 */
  abort: (id: number) => invoke<void>('session_abort', { id }),

  /** 按训练记录反查来源会话（含最后一帧快照）；手动添加的记录返回 null */
  forWorkout: (workoutId: number) =>
    invoke<SessionRecord | null>('session_for_workout', { workoutId }),

  /** 某动作的全部做组记录（按日期升序，含热身组）——重量曲线数据源。
   *  `exerciseId` 传动作库 id；传动作名也能命中（AI 工具与旧调用兼容）。 */
  strengthHistory: (exerciseId: string) =>
    invoke<StrengthSetRecord[]>('strength_history', { exerciseId }),

  /** 有力量记录的动作（按最近训练倒序）——曲线动作选择 */
  strengthExercises: () => invoke<StrengthExerciseRef[]>('strength_exercises'),

  /** 一批动作各自的「最近一次做组重量」——沉浸页预填上次重量（传动作库 id） */
  strengthLastWeights: (exerciseIds: string[]) =>
    invoke<StrengthLastWeight[]>('strength_last_weights', { exerciseIds }),

  /** 近 N 天全部做组记录（默认 42 天）——训练建议引擎的一次性原料 */
  strengthRecentSets: (days?: number) =>
    invoke<StrengthSetRecord[]>('strength_recent_sets', { days: days ?? null }),
}
