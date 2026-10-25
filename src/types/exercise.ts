/** 运动域类型 · 与 Rust `modules/exercise` / `modules/exercise_lib` 对应 */

import type { ActivationMap, MuscleKey } from '@/config/muscles'

/**
 * 运动类型枚举 · 「记运动」可选的**全部**项目。
 *
 * 口径：这里列的是**健身课程体系之外**的自主运动 —— 课程（workout_plans）走的是
 * 「逐组做组」那条路，本枚举走的是「一段时间一段消耗」的粗粒度补录。
 * 所以凡是能当课程开的（力量/自重/HIIT 器械）也在这里给一份，因为真实生活里
 * 「今天在宿舍练了二十分钟腹肌」不会先去建一门课。
 *
 * 键名一律 snake_case 英文（进 IPC 与 SQLite，不随语言变）；中文名只在
 * `config/domain.ts` 的 WORKOUT_META 里给一份。
 */
export const WORKOUT_TYPES = [
  // 走路 / 日常移动
  'walk',
  'hike',
  'stairs',
  'chores',
  'dogwalk',
  // 跑步 / 骑行 / 场馆有氧
  'run',
  'cycle',
  'hiit',
  'rope',
  'elliptical',
  'row',
  'dance',
  // 球类
  'ball',
  'basketball',
  'badminton',
  'tennis',
  'pingpong',
  'football',
  'golf',
  // 水上
  'swim',
  'kayak',
  // 力量 / 场馆课
  'strength',
  'yoga',
  'pilates',
  'boxing',
  'martial',
  'climbing',
  'skate',
  // 户外
  'ski',
  'other',
] as const

export type WorkoutType = (typeof WORKOUT_TYPES)[number]

/** 类型分组：「记运动」的类型选择器按这两级组织（30 个类型平铺一屏没法用） */
export type WorkoutGroup = 'daily' | 'cardio' | 'ball' | 'water' | 'gym' | 'outdoor'

/** 自动档强度：由客观数据（配速 / 逐组重量）反推，只在课程与跑步路径写入 */
export type Intensity = 'low' | 'moderate' | 'high'

/**
 * 体感强度 1–5：用户主观「这次累不累」。
 *
 * 与 Intensity 的分工：Intensity 是**算出来的**（配速 5'30"/km 内 = high），
 * 体感是**用户说的**。手动补录只认体感 —— 让一个刚跑完的人去判断自己属于
 * 「低强度」还是「中强度」，本身就要求他先知道 MET 表；而「跑完这趟累不累」他一定答得上。
 * 落库列 `workouts.effort`（INTEGER 1..5），课程/跑步路径为 NULL（它们有客观档位可依）。
 */
export const EFFORT_LEVELS = [1, 2, 3, 4, 5] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/* ---------------- 动作库（迁移 0025：全部运动动作的唯一真源） ---------------- */

export type ExerciseKind = 'strength' | 'timed' | 'cardio'

/** 浏览分组（动作库页的分类筛选） */
export type ExerciseCategory = 'push' | 'pull' | 'legs' | 'core' | 'cardio' | 'mobility' | 'other'

/** 器材：决定建议重量的取整步进（杠铃 2.5 / 哑铃 2 …） */
export type ExerciseEquipment =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'band'
  | 'cardio'
  | 'other'

/** 库内动作（含使用统计）。内置动作 isCustom=false 只读；自建动作可改可删 */
export interface ExerciseRecord {
  id: string
  name: string
  /** 别名：仅用于把旧数据（自由命名）匹配到库内动作 */
  aliases: string[]
  kind: ExerciseKind
  category: ExerciseCategory
  equipment: ExerciseEquipment | null
  /** 肌群激活表（显式数据；自建动作缺省时前端按名称规则兜底展示） */
  muscles: ActivationMap
  tips: string
  /** 动作要领：分步说明（空数组 = 未收录） */
  steps: string[]
  /** 用户收藏（置顶展示；种子刷新不覆盖） */
  favorite: boolean
  defaultSets: number
  defaultReps: number | null
  defaultWeightKg: number | null
  defaultTargetSec: number | null
  defaultDurationMin: number | null
  defaultRestSec: number
  /** 建议重量取整步进 kg；0 = 自重动作不加重量 */
  weightStep: number
  isCustom: boolean
  hidden: boolean
  /** 有做组记录的训练次数 */
  sessions: number
  /** 最近一次做组的训练日期 */
  lastUsedAt: string | null
}

/**
 * 动作详解的覆盖行（迁移 0048）· 与 `config/exerciseGuide.ts` 的 `ExerciseGuide`
 * 同形状 —— 这里不复用那个接口是为了不把 types 反向依赖到 config
 * （`exerciseGuide.ts` 已经依赖 `@/types` 的 ExerciseKind，反向再引就成环了）。
 *
 * 语义：基线在代码里（内置 81 条），本表只存**被改过的动作**；删行 = 恢复基线。
 */
export interface ExerciseGuideOverride {
  exerciseId: string
  /** 准备：三条，顺序固定（摆位 → 躯干 → 呼吸/绷紧） */
  setup: string[]
  /** 开始：起始位与运动轨迹 */
  start: string
  /** 结束：终点、回位与离心要求 */
  end: string
  /** 注意：该动作最常见的错误与安全边界（1–3 条） */
  cautions: string[]
  /** 一次完整动作循环的建议秒数；0 = 不做次数切分（计时 / 有氧 / 行走类） */
  repSec: number
  /** 最后改动者 */
  updatedBy: 'ai' | 'user'
  updatedAt: string
}

/** 覆盖层的写入体（五段必须完整 —— 局部修改由调用方先读再合并） */
export interface ExerciseGuideInput {
  exerciseId: string
  setup: string[]
  start: string
  end: string
  cautions: string[]
  repSec: number
  updatedBy?: 'ai' | 'user'
}

/** 自建动作的新建 / 更新提交体（内置动作提交会被后端拒绝） */
export interface ExerciseInput {
  id?: string
  name: string
  aliases?: string[]
  kind: ExerciseKind
  category: ExerciseCategory
  equipment?: ExerciseEquipment | null
  muscles?: ActivationMap
  tips?: string
  /** 动作要领：分步说明（清洗：最多 12 条、单条 200 字） */
  steps?: string[]
  defaultSets?: number
  defaultReps?: number | null
  defaultWeightKg?: number | null
  defaultTargetSec?: number | null
  defaultDurationMin?: number | null
  defaultRestSec?: number
  weightStep?: number
}

/**
 * 一条运动记录是谁的。
 *
 * `local` = Rein 自己记的（补录 / 课程 / 跑步）；`health_connect` = 从系统
 * Health Connect 同步进来的第三方数据。两者归属不同：前者以本机为准（会回写 HC，
 * 删除时连带收掉 HC 那副本），后者以 HC 为准（在 Rein 里改会被下次同步覆盖回、
 * 删只写墓碑不动 HC 那份）。DB 列默认 `local`，且参与跨设备同步。
 */
export type WorkoutSource = 'local' | 'health_connect'

export interface Workout {
  id: number
  name: string
  type: WorkoutType
  date: string
  startMin: number | null
  durationMin: number
  kcal: number
  /**
   * 客观档位（配速/逐组重量反推出来的「低/中/高强度」）。
   * DB 里是 NOT NULL，所以手动补录也会写一档 —— 但那是从 effort 派生的，
   * 不是用户的判断（旧代码与知识库派生仍读它）。有 effort 时展示以 effort 为准。
   */
  intensity: Intensity
  /** 体感强度 1–5：手动补录由用户口述；课程/跑步路径为 null */
  effort: EffortLevel | null
  note: string | null
  /** 来源会话（训练课/跑步保存时落关联）；手动添加为 null */
  sessionId: number | null
  /** 来源：本机记的 / 手机同步进来的第三方数据（见 [`WorkoutSource`]） */
  source: WorkoutSource
  createdAt: string
}

export interface WorkoutInput {
  name: string
  type: WorkoutType
  date: string
  startMin?: number | null
  durationMin: number
  /** 与 effort 二选一：手动补录给 effort，课程/跑步给 intensity */
  intensity?: Intensity | null
  effort?: EffortLevel | null
  kcal: number
  note?: string | null
}

/* ---------------- 动作库筛选（动作库页与动作选择器共用） ---------------- */

/** 排序口径：最近使用 / 名称 / 训练次数（收藏永远置顶） */
export type ExerciseSort = 'recent' | 'name' | 'sessions'

export interface ExerciseFilterState {
  kind: ExerciseKind | ''
  category: ExerciseCategory | ''
  equipment: ExerciseEquipment | ''
  /** 肌群多选：命中任一即算（按展示用肌群表判断） */
  muscles: MuscleKey[]
  onlyFavorite: boolean
  sort: ExerciseSort
}

export const EMPTY_EXERCISE_FILTER: ExerciseFilterState = {
  kind: '',
  category: '',
  equipment: '',
  muscles: [],
  onlyFavorite: false,
  sort: 'recent',
}

/** 除分类外的筛选条件个数（角标用；分类在页面上是主浏览轴，单独一行） */
export function filterBadgeCount(f: ExerciseFilterState): number {
  return (
    (f.kind ? 1 : 0) +
    (f.equipment ? 1 : 0) +
    (f.muscles.length ? 1 : 0) +
    (f.onlyFavorite ? 1 : 0) +
    (f.sort !== 'recent' ? 1 : 0)
  )
}
