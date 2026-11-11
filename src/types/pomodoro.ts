/** 番茄钟域类型 · 与 Rust `modules/pomodoro` 对应 */

/**
 * 计时方向：
 * - `down` 倒计时（番茄钟）—— 从 `focusMin` 走到 0，走满进入休息；
 * - `up` 正计时（正计时专注）—— 从 0 往上累加，每满一个 `focusMin` 周期得一颗番茄，
 *   不自动进入休息，由用户主动结束。
 */
export type PomodoroMode = 'down' | 'up'

export interface PomodoroSettings {
  focusMin: number
  breakMin: number
  longBreakMin: number
  roundsBeforeLongBreak: number
  /** 相位结束时是否出声（Web Audio 合成，无音频资源）；新增字段，旧数据缺省按 true。 */
  chime: boolean
  /**
   * 最长暂停分钟：一段专注里**累计**暂停超过它就自动结束本段（走 endPhase 的中断口径）。
   * 0 = 不限制。缺省 9。新增字段，旧数据缺省 9。
   */
  maxPauseMin: number
  /** 计时方向（番茄钟 / 正计时）。缺省 down。新增字段，旧数据缺省 down（与旧行为一致）。 */
  mode: PomodoroMode
  /**
   * 智能安排的空档缓冲：没有进行中的待办时，排到「下一个待办 − 这个分钟数」。
   * 可编辑、会记住；缺省 20。新增字段，旧数据缺省 20。
   */
  smartBufferMin: number
}

/**
 * 一段番茄钟记录。
 *
 * 三态口径复用 `completed`（不新增列）：
 * - **完成**：自然走满 → `completed: true`，`focusMin` = 本轮计划分钟，同时「今日轮次」+1；
 * - **中断**：主动「记录并结束本轮」→ 实际投入 ≥ 60 秒才写 `completed: false`，`focusMin` = 真实投入分钟；
 * - **放弃**：`reset()` → **不写任何记录**。
 */
export interface PomodoroSession {
  id: number
  todoId: number | null
  startedAt: string
  endedAt: string
  /** 专注分钟：完成记计划值、中断记「计划秒数 − 剩余秒数」折算的真实投入（暂停时间天然不计入）。 */
  focusMin: number
  /** 该轮**计划**休息分钟（长休写 `longBreakMin`，否则写生效的短休分钟）——统一口径，不再是 0。 */
  breakMin: number
  /** 是否自然走满（见上面三态口径）：true = 完整段，false = 中断段。 */
  completed: boolean
}

export interface PomodoroSessionInput {
  todoId: number | null
  startedAt: string
  endedAt: string
  focusMin: number
  breakMin: number
  completed: boolean
}

/**
 * 一条「阶段结束」送达（专注→休息、休息→专注都发一条）。
 *
 * `delivered` = 系统通知是否真的发出（`notifyFocusPhase` 的返回值）。为 false 表示
 * 当前环境发不出去，**必须把结果留在页面上**——否则「通知发不出去」会静默成「结果丢了」。
 * 形状由专注域与浮条/卡片共同依赖，不要改字段名。
 */
export interface FocusNotice {
  id: string
  /** 如「专注完成」「休息结束」。 */
  title: string
  /** 如「第 3 段 · 25 分钟 · 休息 5 分钟」。 */
  body: string
  /** 刚结束的相位：focus = 专注→休息，break = 休息→专注。 */
  tone: 'focus' | 'break'
  /** ISO-8601。 */
  at: string
  /** 系统通知是否真的送达；false = 必须留在页面上（不得静默失败）。 */
  delivered: boolean
}