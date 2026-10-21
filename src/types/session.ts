/** 训练课域类型 · 纯前端状态机（保存时落库为 Workout） */

import type { ActivationMap } from '@/config/muscles'

import type { WorkoutType } from './exercise'

export type PlanExerciseKind = 'strength' | 'timed' | 'cardio'

/** 力量动作的激活热身组：小重量找发力感 / 复合动作渐进 ramp-up */
export interface WarmupSet {
  /** 热身重量 kg（按工作重量的 50% / 75% 换算，见 `utils/warmup.ts`） */
  weightKg: number
  reps: number
}

/** 计划中的一个动作 */
export interface PlanExercise {
  id: string
  /**
   * 动作库 id（`exercises.id`）——动作的唯一真源。
   * 课程条目只是「用哪个动作 + 什么处方」；展示名/肌群/要点优先取库内数据，
   * 库里查不到（老数据未回填、自建动作被删）时回落下面的 name 快照。
   */
  exerciseId: string
  /** 动作名快照：库内名缺失时展示用（写入时由后端按名称挂库） */
  name: string
  kind: PlanExerciseKind
  /** 力量：组数 */
  sets: number
  /** 力量：每组次数 */
  reps: number | null
  /** 力量：建议重量 kg */
  weightKg: number | null
  /**
   * 激活热身组（strength 用，可选）：正式组前依次完成；不计入组数进度与总容量。
   *
   * ⚠️ 会话运行时**不再直接吃这个字段**：热身重量按当天推荐重量实时换算
   * （`utils/warmup.ts::warmupPrescription`，store 的 `warmupsFor`）。
   * 这里存的只是**回落值** —— 拿不到工作重量（无建议引擎 / 无历史 / 无计划重量）
   * 时才会用到，保证首次训练与离线场景仍能热身。
   * 规则（`utils/warmup.ts`）：拿得到当天的估算极限（e1RM）时按**相对强度**换算，百分比
   * 乘在极限上（50%×8 + 70%×4）；没有极限时回落绝对负荷 —— ≥30kg 两段（50%×8 + 75%×4）、
   * 12~30kg 单组激活（50%×12）、<12kg 不配；≤20kg 的轻负荷一律不配。
   */
  warmups?: WarmupSet[]
  /** 计时动作：每组目标秒 */
  targetSec: number | null
  /** 有氧：时长分钟 */
  durationMin: number | null
  /** 组间休息秒 */
  restSec: number
  /** 超级组等分组标签（A1 / A2） */
  group?: string
  /** 动作要点（列表展开显示） */
  tips: string
  /**
   * 显式肌群激活表（AI/种子提供时优先展示；缺省按动作名关键词匹配）。
   * exercises_json 旧数据无此字段，读取时按 undefined 处理。
   */
  muscles?: ActivationMap
}

export interface WorkoutPlan {
  id: string
  name: string
  subtitle: string
  /** 保存训练时使用的运动类型 */
  workoutType: WorkoutType
  exercises: PlanExercise[]
}

/** 一组已完成记录：力量存重量，计时存秒数；热身组带 warmup 标记（不计入正式进度） */
export interface DoneSet {
  weight: number | null
  sec: number | null
  /**
   * 该组实际完成次数（完成瞬间登记：正式组取现场次数，热身组取热身定义次数）。
   * 逐组登记而非回读课程定义——课程可能事后被编辑/删除，回读会让历史记录失真。
   * 旧快照没有此字段，读取时按 undefined 处理并回落到课程定义。
   */
  reps?: number | null
  /** true = 激活热身组 */
  warmup?: boolean
}

export type SessionPhase =
  | 'idle'
  | 'warmup' // 力量：激活热身中（动作配了 warmups 且未完成/跳过）
  | 'exercise' // 力量：做组中
  | 'rest' // 组间休息
  | 'timed-ready' // 计时/有氧：准备
  | 'timed-run' // 计时中
  | 'summary' // 全部完成

/**
 * 会话内临时换掉的动作用它落盘 —— 键 = 课程条目 id（`PlanExercise.id`）。
 *
 * 为什么必须进快照：恢复（`stores/session.ts::applyRecord`）是按 planId 从课程库
 * **重建** plan 的，而换动作只改了内存里那份深拷贝 —— 接管后会被抹回原动作。
 * 而 `doneSets` 的键正是那个课程条目 id，于是按新动作做完的每一组会以**原动作**的
 * `exerciseId / exerciseName` 落进 `workout_sets`，而 `exercise_id` 是重量曲线的聚合键
 * ——曲线里那些组会长在原来那个动作身上，且不可逆（记录已落库）。
 */
export interface PlanExerciseOverride {
  exerciseId: string
  name: string
  tips: string
  muscles?: ActivationMap
  /** 换成新动作时同时改写的处方重量（见 `session.ts::swapExercise`） */
  weightKg: number | null
  /**
   * 这一场的组数 / 每组次数 / 组间休息。缺省 = 沿用课程条目里的值。
   *
   * 换动作时这三个字段**必须**一起换：智能建议吃的是条目上的处方（目标组数决定
   * 「上次是否全部做满」的判据、目标次数决定加档门槛），沿用旧动作会让建议对新动作失真。
   */
  sets?: number
  reps?: number | null
  restSec?: number
}

/**
 * 训练后体感三档（**相对预期**）。这是练够分「体感」维度的首选输入。
 *
 * 刻意不问「有多累」（RPE）：把「很累」喂进体感维度会让「练得越狠、分越低」，
 * 方向是反的 —— 那次练得好不好，与它让你多累是两件事。
 * 问「和预期比」还顺带容纳了两种情况：状态好、练得很爽（比预期好），
 * 以及状态差、但本来就预期低（也是差不多）。
 */
export type FeelingInput = 'better' | 'as_expected' | 'worse'

export const FEELING_INPUT_LABEL: Record<FeelingInput, string> = {
  better: '比预期好',
  as_expected: '和预期差不多',
  worse: '比预期差',
}

/**
 * 快照里每个课程条目的**身份快照**（id / 动作库 id / 名称）。
 *
 * 为什么需要：快照的 `doneSets` / `extraSets` / `skippedSets` 都以课程条目 id 为键，
 * 而课程可以在会话进行中被整体覆盖（AI 的 `upsert_plan`、手动重排）。恢复时 plan 是
 * 按 planId 从课程库**重建**的，键一旦失配，`alignProgressToPlan` 会把已完成的组当成
 * 「不属于当前课程」整批丢掉 —— 那是这一场唯一的一份进度。带上身份快照，恢复时就能
 * 按动作库 id / 名称把旧键迁到新条目上。
 *
 * 旧版本客户端写的快照没有这段，读取时按 undefined 处理（无法迁移，走原裁剪逻辑）。
 */
export interface PlanExerciseRef {
  id: string
  exerciseId: string
  name: string
}

/** 落盘用的状态快照（与 Rust state_json 对应） */
export interface SessionSnapshotState {
  doneSets: Record<string, DoneSet[]>
  exIndex: number
  setIndex: number
  weight: number
  phase: Exclude<SessionPhase, 'idle'>
  restLeft?: number
  restTargetIsNextSet?: boolean
  timedTotal?: number
  /** 临时休息：不推进流程，倒计时结束回到 resumePhase */
  restIsTemp?: boolean
  resumePhase?: 'exercise' | 'timed-ready' | 'timed-run'
  /** 激活热身组间休息：不推进正式组数 */
  restWarmup?: boolean
  /** 当前组现场次数（力量动作可临时改写；null = 该动作未配次数） */
  reps?: number | null
  /** 「再加一组」：动作 id → 追加的组数 */
  extraSets?: Record<string, number>
  /** 已跳过的正式组：动作 id → 被跳过的组号（1-based）。跳过 = 未做，不计入完成统计 */
  skippedSets?: Record<string, number[]>
  /**
   * 今日状态自评（1=很差 … 5=很好）；null / 缺省 = 未自评（建议引擎纯自动推断）。
   * 随快照落盘，训练中断恢复后不丢。
   */
  readiness?: number | null
  /**
   * 训练后体感三档（总结页回答，相对预期）。也随快照落盘 ——
   * 它比 readiness 更晚才产生（要练完才有），中断恢复的窗口正好覆盖它。
   */
  postFeeling?: FeelingInput | null
  /** 临时换过的动作（键 = 课程条目 id）；缺省/空 = 一次都没换过 */
  exerciseOverrides?: Record<string, PlanExerciseOverride>
  /**
   * **这一场的课程结构实况**（完整条目清单，含插入 / 删除 / 换动作 / 改组数之后的结果）。
   *
   * 为什么必须有它：中断恢复是按 `planId` 从课程库**重建** plan 的，而课程库不知道
   * 这一场被现场改成了什么样 —— 插入的动作会凭空消失、删掉的动作又回来了、
   * 「这场深蹲改成 5 组」退回库里的 3 组。`doneSets` 的键是条目 id，条目一旦重建，
   * 键就失配（那是这一场唯一的一份进度）。
   *
   * 带上整份实况后，恢复不再依赖「课程库此刻长什么样」：结构、条目 id、处方全部照搬，
   * 课程库在会话期间被整体覆盖（AI `upsert_plan` / 手动重排）也不会打乱这一场。
   * 缺省 = 旧快照（走 `planRefs` 键迁移那条老路）。
   */
  sessionPlan?: PlanExercise[]
  /**
   * 课程条目的身份快照（仅用于恢复时把旧键迁到新条目）。
   * 见 [`PlanExerciseRef`]；缺省 = 旧快照，无法迁移。
   */
  planRefs?: PlanExerciseRef[]
}

/** 全课扁平化后每一组的状态（抽屉与顶部进度格条的唯一数据源） */
export type SessionSetState =
  | 'done' // 已真实完成（进入统计）
  | 'skipped' // 已跳过（未做 / 不统计）
  | 'current' // 当前待做（或正在做）
  | 'pending' // 排在后面，尚未轮到

/** 全课组清单的一格：动作坐标 + 组号 + 状态 + 完成登记值 */
export interface SessionSetSlot {
  /** 该组所属动作在课程中的下标 */
  exIdx: number
  exId: string
  exName: string
  kind: PlanExerciseKind
  /** 1-based 组号；热身组单独从 1 计，不占正式组号 */
  setNo: number
  /** true = 激活热身组（只出现在 courseSlots，不进进度格条与游标计算） */
  warmup?: boolean
  state: SessionSetState
  /** 已完成组登记的实际次数 / 重量 / 秒数；其余状态为 null */
  done: { weight: number | null; sec: number | null; reps?: number | null } | null
}

/** 逐组重量落库行（session_finish 事务内写入 workout_sets 表；重量曲线的数据源） */
export interface StrengthSetRow {
  exerciseKey: string
  /** 动作库 id —— 重量曲线的聚合键 */
  exerciseId: string
  exerciseName: string
  kind: PlanExerciseKind
  setNo: number
  weightKg: number | null
  reps: number | null
  sec: number | null
  warmup: boolean
}

/** workout_sets 查询返回行（含 JOIN workouts 的日期）；exerciseName 只是历史快照 */
export interface StrengthSetRecord {
  workoutId: number
  date: string
  exerciseKey: string
  exerciseId: string | null
  exerciseName: string
  kind: PlanExerciseKind
  setNo: number
  weightKg: number | null
  reps: number | null
  sec: number | null
  warmup: boolean
  /**
   * 该组所属会话的「今日状态自评」1..5（`workout_sessions.state_json.readiness`，Rust 侧拍平）。
   * 未自评 / 手动补录为 null —— 「体感」维度在**没有** postFeeling 时回退用它
   * （映射：5、4→良好 / 3→一般 / 1、2→差；缺失按规范默认 60 分并降置信度）。
   */
  readiness?: number | null
  /**
   * 该组所属会话的训练后体感（`state_json.postFeeling`，Rust 侧拍平）。
   * **体感维度的首选输入**：readiness 问的是训练前状态，与「这次练得怎么样」不是一件事。
   * 没有它的记录（0.6.1 之前）走兼容层 0.0.1 回退到 readiness，来源如实标注。
   */
  postFeeling?: FeelingInput | null
}

/** 单次训练里某动作的聚合（曲线/明细展示用，由前端按 date 聚合） */
export interface StrengthDayEntry {
  workoutId: number
  date: string
  planName?: string
  sets: { setNo: number; weightKg: number | null; reps: number | null; warmup: boolean }[]
}

/** 有力量记录的动作（按最近训练排序）。exerciseId 为空 = 老库未回填，回落 name 作键 */
export interface StrengthExerciseRef {
  exerciseId: string
  name: string
  lastDate: string
  sessions: number
}

/** 某动作最近一次做组重量（沉浸页「上次重量」预填用） */
export interface StrengthLastWeight {
  exerciseId: string
  name: string
  weightKg: number
  reps: number | null
  date: string
}

/**
 * 沉浸页「更换动作」的候选（来自动作库）：
 * 只换动作本体，编排（组数/次数/休息/热身）沿用课程当前动作。
 */
export interface SwapCandidate {
  exerciseId: string
  name: string
  tips: string
  muscles?: ActivationMap
}

/** 跑步目标类型 */
export type RunGoalKind = 'open' | 'time' | 'distance'

/** 轨迹点：t = 记录时的累计运动毫秒（旧快照可能缺失），alt = GPS 海拔米 */
export interface RunTrackPoint {
  lat: number
  lon: number
  t?: number
  alt?: number
  /** 水平精度（米）；native 采集与注入源会带上，缺省按未知处理 */
  acc?: number
  /** 高程精度（米）；>20m 的点在爬升滤波里直接丢弃 */
  altAcc?: number
  /** true = 该点之前有一段空窗/自动暂停（投影时此处断开重画，不连弦） */
  brk?: boolean
}

/**
 * 跑步会话的落盘快照（state_json 里以 kind:'run' 区分于课程快照）。
 * points 为轨迹面包屑（写入前抽稀）；早期快照可能缺失，恢复时按空处理。
 *
 * 暂停桶逐一对应页面上的四类时间归属（互斥，见 stores/run.ts）：
 * pausedMs = 总暂停墙钟 = manual + autoPause + gap；每个字段只有一个生产者。
 * **不写 gaps 明细数组**：明细只活在内存（≤40 条），落盘只存 per-class 计数。
 */
export interface RunSnapshot {
  kind: 'run'
  phase: 'running' | 'paused' | 'summary'
  goalKind: RunGoalKind
  goalTimeMin: number
  goalDistanceKm: number
  /** 已累计运动毫秒（不含被打断的当前段） */
  accumMs: number
  /** 当前段起点（running 时存在）；恢复时强制暂停、丢弃该段 */
  segStartedAt: string | null
  distanceM: number
  /** 轨迹点（崩溃恢复后整条轨迹重画） */
  points?: RunTrackPoint[]
  /** 总暂停墙钟（毫秒）：手动 + 自动暂停 + >10s 空窗 */
  pausedMs?: number
  /** 手动暂停次数 */
  pauseCount?: number
  /** 自动暂停状态机段（毫秒）；与 gapMs 互斥（>10s 空窗优先归 gap 桶） */
  autoPauseMs?: number
  /** 自动暂停次数 */
  autoPauseCount?: number
  /** >10s 空窗段（毫秒） */
  gapMs?: number
  /** 空窗 per-class 计数（slow = 几乎没动 / fast = 位移可信但断档 / drop = 机动车级速度） */
  gapSlowCount?: number
  gapFastCount?: number
  gapDropCount?: number
  /** points 是否已经抽稀过（恢复后直接使用，不再二次抽稀） */
  decimated?: boolean
  /** 保存时确认的最终距离（公里）；null = 没距离 */
  finalKm?: number | null
  /** 自动暂停开关（随快照保留，恢复后不丢用户的设置） */
  autoPauseOn?: boolean
  /** 自动暂停阈值（秒/公里）：缺省 600 = 10'00"/km */
  autoPausePaceSec?: number
}

/** 一场训练已落库的逐组明细（`workout_sets` 一行，服务端按登记顺序返回）。
 *
 * **为什么详情页读它而不是只读 `state.doneSets`**：`doneSets` 的键是课程条目 id
 * （`PlanExercise.id`），课程一旦被整体覆盖（AI 重写课程、手动增删重排）键就全变，
 * 历史记录的每一组都匹配不上课程动作 —— 详情页于是把真实数据摊成十几条「其他动作」，
 * 而课程里的动作全部显示「未完成」，完成组数分母还虚增一倍。
 * 这里带着**当时登记的动作名 + 动作库 id**，是详情页唯一稳定的真源。
 */
export interface SessionSetRow {
  /** 当时课程条目 id（可能已不在课程里，仅作参考） */
  exerciseKey: string
  /** 当时登记的动作名（课程改名不追溯，与重量曲线同一口径） */
  exerciseName: string
  /** 动作库 id；老记录可能为空 */
  exerciseId: string | null
  kind: PlanExerciseKind
  /** 正式组与热身组各从 1 计 */
  setNo: number
  weightKg: number | null
  reps: number | null
  sec: number | null
  warmup: boolean
}

/** 服务端的进行中会话记录 */
export interface SessionRecord {
  id: number
  planId: string
  planName: string
  status: 'active' | 'finished' | 'aborted'
  startedAt: string
  /** SQLite datetime('now')，UTC */
  updatedAt: string
  exIndex: number
  setIndex: number
  weightKg: number
  /** 服务端按快照间隔自动累加的真实流逝秒数 */
  elapsedSec: number
  state: SessionSnapshotState
  /**
   * 逐组落库明细：仅 `session_for_workout` 填充（active / finish 等路径为空数组）。
   * 旧版本客户端与老版本后端没有此字段，读取时按空数组处理。
   */
  sets?: SessionSetRow[]
}
