/**
 * 全局沉浸浮窗 · 前后端契约类型。
 *
 * 主窗口是**唯一真源**：它把正在跑的沉浸会话（专注 / 训练课）压成一份快照推给系统浮窗；
 * 浮窗只负责按快照渲染并发回动作，不持有任何状态机。契约与设计见 docs/GLOBAL-FLOAT.md。
 *
 * 为什么快照里带 `clock` 而不是只推文案：浮窗所在的窗口（桌面第二 webview / Android
 * 原生浮层）在应用退到后台后不保证还能按秒收到推送，读数必须能自己走 —— 基准 + 时刻
 * 与系统时钟一致，两侧各自算同一份显示，断流时最多停在最后一秒而不是显示错值。
 */

/** 读数时钟：基准读数 + 对应的本地时刻（epoch ms）。atEpochMs 为 null 表示静止。 */
export interface GlobalFloatClock {
  /** down = 倒计时（剩余）；up = 正计时（已累计） */
  direction: 'down' | 'up'
  /** 快照时刻的读数（秒） */
  baseSec: number
  atEpochMs: number | null
}

/** 结束确认的单个动作（文案与程序内 ActionSheet 逐字一致） */
export interface GlobalFloatEndAction {
  id: string
  label: string
  danger?: boolean
}

/** 结束确认：标题说明后果（与 ActionSheet 的 title 同源），动作按会话语义给 */
export interface GlobalFloatEndSheet {
  title: string
  actions: GlobalFloatEndAction[]
}

/** 主动作：暂停 / 继续 / 完成当组 / 跳过休息 */
export interface GlobalFloatPrimary {
  id: 'pause' | 'resume' | 'complete' | 'skip-rest'
  label: string
}

/**
 * 次级动作：训练条的「跳过动作」与总结态的「去保存」。
 * 训练浮窗只给两颗业务按钮（完成当组 / 跳过动作），结束与打开不再上浮窗 ——
 * 结束留在沉浸页顶栏，点信息区即可回到应用。
 */
export interface GlobalFloatSecondary {
  id: 'skip' | 'open'
  label: string
}

/** 状态点语义：专注中 / 休息中 / 已暂停 / 已结束（与浮条的 .dot 类一一对应） */
export type GlobalFloatTone = 'work' | 'break' | 'paused' | 'done'

/** 沉浸会话种类：专注（番茄钟）/ 训练课（含跑步） */
export type GlobalFloatKind = 'focus' | 'workout'

/**
 * 浮窗内容快照 —— 主窗口 → 浮窗的全部内容契约。
 * 字段取值必须由 `components/float/snapshot.ts` 的构造器产出（与程序内浮条同源）。
 */
export interface GlobalFloatSnapshot {
  kind: GlobalFloatKind
  tone: GlobalFloatTone
  /** 首行文案：专注 = 相位；训练 = 标题（动作名 / 跑步） */
  title: string
  /** 次行：专注 = mm:ss 读数（clock 在场时由浮窗自己走）；训练 = 统计行 */
  stat: string
  /** 读数时钟；训练课的静态统计为 null */
  clock: GlobalFloatClock | null
  /**
   * blob 泊车态的一行短读数（程序内浮条 `#blob` 插槽用的就是它）：
   * 训练课 = 组进度 / 时长这类短统计，专注 = 读数本身（可省略，浮窗按 clock 自己算）。
   * 与程序内浮条同源：`buildWorkoutSnapshot` 直接取 `view.blob`。
   */
  blob?: string
  primary: GlobalFloatPrimary | null
  /** 训练条的次级动作（跳过动作 / 去保存）；专注浮窗为 null */
  secondary?: GlobalFloatSecondary | null
  /** 结束确认：专注浮窗保留内联结束；训练浮窗不再提供结束（end 恒为 null） */
  end: { label: string; sheet: GlobalFloatEndSheet } | null
  /** 「打开」落地路由名（专注页 / 运动页） */
  route: string
  /** 是否给「进入沉浸」按钮（专注有、训练课有；跑步是路由沉浸页也走打开） */
  canImmersive: boolean
  /**
   * 专注计划的轮次信息（训练课为 undefined）：
   * 浮窗标题「专注时间段（第 1 个/共 5 个）」与「下一个：休息 5 分钟」用它。
   */
  roundIndex?: number
  roundTotal?: number
  nextLabel?: string | null
  /** 专注计划预计结束 HH:mm（普通单轮 / 正计时为 null） */
  estimatedEnd?: string | null
  /** 当前相位总秒数：浮窗「显示剩余时间 / 已用时间」互相换算用 */
  phaseTotalSec?: number
}

/** 浮窗形态：bar 全宽条 / blob 64×64 泊车方块（与程序内两态同义，用户偏好会持久化） */
export type GlobalFloatForm = 'bar' | 'blob'

/**
 * 浮窗**窗口形状**：在两种持久形态之外，多一个专注卡面与一个「确认态」。
 * 专注在桌面用 360×450 的卡（`card`），训练仍用 430×92 的条（`bar`）；
 * 训练的结束确认要把完整标题与两条动作放下，所以确认时窗口临时长高（`confirm`）。
 */
export type GlobalFloatWindowShape = GlobalFloatForm | 'card' | 'confirm'

/** 主窗口 → 浮窗的完整推送载荷（内容 + 形态 + 首帧画质档） */
export interface GlobalFloatStatePayload {
  snapshot: GlobalFloatSnapshot
  form: GlobalFloatForm
  /** 主窗口当前画质档（system/perf）；浮窗首帧就按同一档渲染 */
  perf: string
  /** 主窗口当前动效档（system/motion） */
  motion: string
}

/** 全局浮窗能力状态（平台支持 / 权限 / 此刻是否在显示） */
export interface GlobalFloatStatus {
  /** 本平台是否支持系统浮窗（桌面 / 已授权的 Android 为 true；浏览器为 false） */
  supported: boolean
  /** 是否已获得系统浮窗权限（桌面恒 true；Android 看「在其他应用上显示」） */
  permitted: boolean
  /** 浮窗此刻是否在显示 */
  visible: boolean
}

/**
 * 浮窗所在显示器的工作区（逻辑像素，虚拟屏幕坐标，与 LogicalPosition 同口径）。
 * 浮窗前端用它算停靠槽位与橡皮筋边界；读不到显示器 / 非 Windows 时为零矩形。
 */
export interface GlobalFloatWorkArea {
  x: number
  y: number
  width: number
  height: number
}

/** 浮窗发给主窗口的动作名（两端同一份） */
export type GlobalFloatActionName =
  | 'pause'
  | 'resume'
  | 'complete'
  | 'skip-rest'
  | 'skip'
  | 'skip-phase'
  | 'end'
  | 'open'
  | 'immerse'
  | 'close'
  | 'form'

/** 浮窗动作：end 动作必须带 option（取自 snapshot.end.sheet.actions 的 id） */
export interface GlobalFloatAction {
  action: GlobalFloatActionName
  /** end 的选项 id；form 动作见 form 字段 */
  option?: string
  /** form 动作的目标窗口形状（confirm 只用于结束确认的临时长高） */
  form?: GlobalFloatWindowShape
}