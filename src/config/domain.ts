/** 领域展示元数据：标签、图标色、MET 表。UI 文案统一从这里取，避免散落硬编码。 */

import type { Component } from 'vue'
import { Apple, Coffee, Utensils } from 'lucide-vue-next'

import type { Goal, ActivityLevel, DailyTargets } from '@/types/nutrition'
import type { MealLog, MealType } from '@/types/diet'
import type {
  EffortLevel,
  Intensity,
  WorkoutGroup,
  WorkoutType,
  ExerciseCategory,
  ExerciseEquipment,
  ExerciseKind,
} from '@/types/exercise'
import type { TodoCategory } from '@/types/todo'

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
}

export const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack']

/**
 * 餐次展示名 → MealType。方案菜单的槽位名比 MEAL_LABELS 更细
 * （「上午加餐 / 下午加餐」都对不上 MEAL_LABELS.snack 的「加餐」），
 * 所以用包含匹配而非相等比较，且必须先判「加餐」再判「午」，否则
 * 「上午加餐」会被 '午' 命中成午餐。未识别的一律归为加餐。
 */
export function mealTypeOfSlot(slot: string): MealType {
  if (slot.includes('加餐')) return 'snack'
  if (slot.includes('早')) return 'breakfast'
  if (slot.includes('午')) return 'lunch'
  if (slot.includes('晚')) return 'dinner'
  return 'snack'
}

/** 各餐次展示元数据：图标与主题色（一日脊柱、饮食历史共用） */
export const MEAL_META: Record<MealType, { icon: Component; colorVar: string }> = {
  breakfast: { icon: Coffee, colorVar: 'var(--led-food)' },
  lunch: { icon: Utensils, colorVar: 'var(--c-protein)' },
  dinner: { icon: Utensils, colorVar: 'var(--cat-study)' },
  snack: { icon: Apple, colorVar: 'var(--c-carb)' },
}

/** 单笔记录热量：每 100g 营养 × 克重 ÷ 100；food 未 join 时返回 null */
export function mealKcal(log: MealLog): number | null {
  if (!log.food) return null
  return Math.round((log.food.kcal * log.grams) / 100)
}

/** 单笔记录克重文案：份模式带份数与换算克重，克模式只给克重 */
export function mealQtyText(log: MealLog): string {
  if (log.quantityMode === 'unit' && log.units != null && log.unitName) {
    return `${log.units} ${log.unitName}（${Math.round(log.grams)} g）`
  }
  return `${Math.round(log.grams)} g`
}

/** 营养克数展示：≥10 取整，<10 保留一位小数（历史行与详情页共用同一口径） */
export function fmtGrams(n: number): string {
  if (!n) return '0'
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}

/**
 * 壳层形态的三档（唯一的宽度判据，别再在别处写 1100 / 1280 这类裸值）：
 *
 *   · <  DESKTOP_MIN(900)     手机壳 —— .app-frame 居中窄栏 + 底部 Dock；
 *   · ≥  DESKTOP_MIN(900)     桌面壳 —— 导航轨（64px）+ 主人区；信息栏**缺省收起**，
 *                             900–1279 的主人区只有 836–1215px，再挂 298px 的第三格
 *                             会把 900 宽的内容挤到 538px（比手机栏还窄）。⌘I 仍可展开；
 *   · ≥  INSPECTOR_DEFAULT_MIN(1280)
 *                             桌面壳 + 信息栏**缺省展开** —— 三窗格并排后主人区 = 918px。
 *
 * 为什么是 900 而不是 1100：900×1200 / 1024×768 这一档（平板竖屏、半屏窗口）此前
 * 拿到的是 480px 的手机窄栏居中，两侧各空 200px —— 桌面级导航与主人区在 900 就装得下。
 *
 * `--desk-min`（src/styles/tokens.css）必须与本值同值：媒体查询读不到 var()，
 * 那份令牌是给 CSS 侧的备忘，改这里就要同步改那里。
 */
export const DESKTOP_MIN = 900

/** 桌面壳下信息栏「缺省」展开的宽度下限（用户显式开关过就照用户的，见 system/deskShell） */
export const INSPECTOR_DEFAULT_MIN = 1280

/** 按当前时间推荐餐次（聊天解析卡与拍照识别弹层共用） */
export function suggestMeal(): MealType {
  const h = new Date().getHours()
  if (h < 10) return 'breakfast'
  if (h < 14) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

export const CATEGORY_META: Record<TodoCategory, { label: string; colorVar: string }> = {
  general: { label: '日常', colorVar: '--cat-general' },
  workout: { label: '运动', colorVar: '--cat-workout' },
  health: { label: '健康', colorVar: '--cat-health' },
  study: { label: '学习', colorVar: '--cat-study' },
  work: { label: '工作', colorVar: '--cat-work' },
  // 课表派生行专用；不在 TODO_CATEGORIES 里，用户与 AI 都选不到它
  class: { label: '课程', colorVar: '--cat-class' },
}

/**
 * 优先级四象限（重要 × 紧急）：0 普通（不重要不紧急）/ 1 重要不紧急 / 2 紧急不重要 / 3 重要且紧急。
 * 旧三档（普通/重要/紧急）数值语义不变，编辑器以四象限选择，排序仍按 value 降序。
 */
export const PRIORITY_META: { value: number; label: string; colorVar: string }[] = [
  { value: 0, label: '普通', colorVar: '--text-3' },
  { value: 1, label: '重要不紧急', colorVar: '--c-carb' },
  { value: 2, label: '紧急不重要', colorVar: '--c-fat' },
  { value: 3, label: '重要且紧急', colorVar: '--danger' },
]

export function priorityMeta(value: number): { value: number; label: string; colorVar: string } {
  return PRIORITY_META.find((p) => p.value === value) ?? PRIORITY_META[0]!
}

export const INTENSITY_LABELS: Record<Intensity, string> = {
  low: '低强度',
  moderate: '中强度',
  high: '高强度',
}

export const ACTIVITY_LEVEL_LABELS: Record<ActivityLevel, string> = {
  sedentary: '久坐',
  light: '轻度活动',
  moderate: '中度活动',
  active: '高度活动',
}

export const GOAL_LABELS: Record<Goal, string> = {
  cut: '减脂',
  keep: '保持',
  bulk: '增肌',
}

/** 偏好运动时段 / 器械条件 / 训练经验的展示标签（「我」页约束卡与方案页共用） */
export const TIME_SLOT_LABELS: Record<string, string> = {
  morning: '早晨',
  noon: '午间',
  evening: '晚间',
}

export const EQUIPMENT_LABELS: Record<string, string> = {
  gym: '健身房',
  home: '居家徒手',
  mixed: '都可以',
}

export const EXPERIENCE_LABELS: Record<string, string> = {
  beginner: '新手',
  intermediate: '有基础',
  advanced: '进阶',
}

/** 忌口预设：方案向导与「我 › 个人约束」编辑抽屉共用一份（点选排除 + 关键词过滤食谱） */
export const DIET_RESTRICTION_PRESETS: string[] = ['乳制品', '麸质', '海鲜', '蛋类', '大豆', '坚果']

/* ---------------- 动作库展示元数据（action library：分类 / 器材 / 类型） ---------------- */

/** 动作分类（动作库页分组与筛选的顺序即此数组顺序） */
export const EXERCISE_CATEGORY_META: { key: ExerciseCategory; label: string }[] = [
  { key: 'push', label: '推' },
  { key: 'pull', label: '拉' },
  { key: 'legs', label: '腿' },
  { key: 'core', label: '核心' },
  { key: 'cardio', label: '有氧' },
  { key: 'mobility', label: '柔韧' },
  { key: 'other', label: '其他' },
]

export const EXERCISE_CATEGORY_LABELS: Record<ExerciseCategory, string> = Object.fromEntries(
  EXERCISE_CATEGORY_META.map((c) => [c.key, c.label]),
) as Record<ExerciseCategory, string>

export const EXERCISE_EQUIPMENT_LABELS: Record<ExerciseEquipment, string> = {
  barbell: '杠铃',
  dumbbell: '哑铃',
  machine: '器械',
  cable: '绳索',
  bodyweight: '自重',
  band: '弹力带',
  cardio: '有氧器械',
  other: '其他',
}

export const EXERCISE_KIND_LABELS: Record<ExerciseKind, string> = {
  strength: '力量',
  timed: '计时',
  cardio: '有氧',
}

/** 可编辑目标字段元数据：标签 / 单位（计算器差异、AI 建议卡共用） */
export const TARGET_FIELD_META: { key: keyof DailyTargets; label: string; unit: string }[] = [
  { key: 'kcal', label: '能量', unit: '大卡' },
  { key: 'protein', label: '蛋白质', unit: 'g' },
  { key: 'carb', label: '碳水', unit: 'g' },
  { key: 'fat', label: '脂肪', unit: 'g' },
  { key: 'sodiumMg', label: '钠', unit: 'mg' },
  { key: 'waterMl', label: '饮水', unit: 'ml' },
]

/**
 * 各运动的 MET 值（Ainsworth Compendium 近似），按强度分档。
 * `group` 决定「记运动」类型选择器的分区；顺序即选择器里的呈现顺序（常用的在前）。
 */
export const WORKOUT_META: Record<
  WorkoutType,
  { label: string; group: WorkoutGroup; met: Record<Intensity, number> }
> = {
  // ---- 走路 / 日常移动 ----
  walk: { label: '快走', group: 'daily', met: { low: 2.8, moderate: 3.5, high: 4.3 } },
  hike: { label: '徒步', group: 'daily', met: { low: 3.5, moderate: 5.0, high: 6.5 } },
  stairs: { label: '爬楼梯', group: 'daily', met: { low: 4.0, moderate: 8.0, high: 9.0 } },
  chores: { label: '做家务', group: 'daily', met: { low: 2.5, moderate: 3.3, high: 4.0 } },
  dogwalk: { label: '遛狗', group: 'daily', met: { low: 2.0, moderate: 3.0, high: 3.8 } },

  // ---- 跑步 / 骑行 / 场馆有氧 ----
  run: { label: '跑步', group: 'cardio', met: { low: 8.0, moderate: 9.8, high: 11.5 } },
  cycle: { label: '骑行', group: 'cardio', met: { low: 5.0, moderate: 7.5, high: 10.0 } },
  hiit: { label: 'HIIT', group: 'cardio', met: { low: 7.0, moderate: 10.0, high: 12.0 } },
  rope: { label: '跳绳', group: 'cardio', met: { low: 8.8, moderate: 11.8, high: 12.3 } },
  elliptical: { label: '椭圆机', group: 'cardio', met: { low: 4.6, moderate: 5.0, high: 8.0 } },
  row: { label: '划船机', group: 'cardio', met: { low: 4.0, moderate: 7.0, high: 10.0 } },
  dance: { label: '跳舞', group: 'cardio', met: { low: 4.5, moderate: 6.5, high: 8.5 } },

  // ---- 球类 ----
  ball: { label: '球类', group: 'ball', met: { low: 4.5, moderate: 6.5, high: 8.0 } },
  basketball: { label: '篮球', group: 'ball', met: { low: 4.5, moderate: 6.5, high: 8.0 } },
  badminton: { label: '羽毛球', group: 'ball', met: { low: 3.5, moderate: 5.5, high: 7.0 } },
  tennis: { label: '网球', group: 'ball', met: { low: 4.0, moderate: 7.0, high: 9.0 } },
  pingpong: { label: '乒乓球', group: 'ball', met: { low: 2.5, moderate: 4.0, high: 5.5 } },
  football: { label: '足球', group: 'ball', met: { low: 5.0, moderate: 7.0, high: 9.5 } },
  golf: { label: '高尔夫', group: 'ball', met: { low: 3.0, moderate: 4.5, high: 6.0 } },

  // ---- 水上 ----
  swim: { label: '游泳', group: 'water', met: { low: 6.0, moderate: 8.3, high: 10.5 } },
  kayak: { label: '皮划艇', group: 'water', met: { low: 4.0, moderate: 5.5, high: 7.0 } },

  // ---- 力量 / 场馆课 ----
  strength: { label: '力量训练', group: 'gym', met: { low: 3.5, moderate: 5.0, high: 6.5 } },
  yoga: { label: '瑜伽', group: 'gym', met: { low: 2.5, moderate: 3.0, high: 4.0 } },
  pilates: { label: '普拉提', group: 'gym', met: { low: 2.5, moderate: 3.5, high: 5.0 } },
  boxing: { label: '拳击', group: 'gym', met: { low: 5.0, moderate: 7.8, high: 10.0 } },
  martial: { label: '武术散打', group: 'gym', met: { low: 4.0, moderate: 6.0, high: 8.0 } },
  climbing: { label: '攀岩', group: 'gym', met: { low: 5.0, moderate: 8.0, high: 9.0 } },
  skate: { label: '滑冰轮滑', group: 'gym', met: { low: 4.5, moderate: 6.5, high: 8.5 } },

  // ---- 户外 ----
  ski: { label: '滑雪', group: 'outdoor', met: { low: 5.0, moderate: 6.5, high: 8.5 } },
  other: { label: '其他', group: 'outdoor', met: { low: 3.5, moderate: 5.0, high: 6.5 } },
}

/** 类型分组展示元数据：顺序即选择器里的分区顺序 */
export const WORKOUT_GROUPS: { key: WorkoutGroup; label: string }[] = [
  { key: 'daily', label: '走路日常' },
  { key: 'cardio', label: '跑跳有氧' },
  { key: 'ball', label: '球类' },
  { key: 'water', label: '水上' },
  { key: 'gym', label: '力量场馆' },
  { key: 'outdoor', label: '户外其他' },
]

/** 按分区过滤类型（供选择器渲染；无匹配时返回空数组） */
export function workoutTypesInGroup(group: WorkoutGroup): WorkoutType[] {
  return (Object.keys(WORKOUT_META) as WorkoutType[]).filter((t) => WORKOUT_META[t].group === group)
}

/**
 * 体感强度 1–5 → 客观 MET 档。
 *
 * 为什么不是直接给每档一个 MET：MET 表本身是按**动作类型 × 强度**二维给的，
 * 而用户只会答「累不累」。这里把体感折算成档位（1–2 轻松 → low，3 适中 → moderate，
 * 4–5 累 → high），复用既有的 MET 分档 —— 于是新增 30 个类型只需要各填一行 MET，
 * 体感维度的全部科学性由这一张映射表承担，改一处即全应用生效。
 *
 * 刻意不做得更细（比如把 effort 线性插值进 MET）：那会让「3.5 分体感」这种不存在的输入
 * 看起来更精确，而 MET 分档本身的误差远大于插值带来的收益。
 */
export function effortToIntensity(effort: EffortLevel): Intensity {
  if (effort <= 2) return 'low'
  if (effort === 3) return 'moderate'
  return 'high'
}

/** 体感档位文案（选择器与记录详情共用；避免各处硬写「累不累」） */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  1: '毫不累',
  2: '有点累',
  3: '适中',
  4: '挺累',
  5: '累坏了',
}

/** 每日运动消耗目标（大卡），对应三环中的绿环 */
export const EXERCISE_KCAL_GOAL = 300

/** MET → 千卡：kcal = MET × 3.5 × 体重kg ÷ 200 × 分钟 */
export function kcalFromMet(met: number, minutes: number, weightKg: number): number {
  return Math.round(((met * 3.5 * weightKg) / 200) * minutes)
}

/** 按类型 + 客观档位估算（课程 / 跑步 / AI 工具的老口径） */
export function estimateKcal(
  type: WorkoutType,
  intensity: Intensity,
  minutes: number,
  weightKg: number,
): number {
  return kcalFromMet(WORKOUT_META[type].met[intensity], minutes, weightKg)
}

/** 按类型 + 体感估算（手动补录口径：用户说「累不累」，不由他去挑 MET 档） */
export function estimateKcalByEffort(
  type: WorkoutType,
  effort: EffortLevel,
  minutes: number,
  weightKg: number,
): number {
  return estimateKcal(type, effortToIntensity(effort), minutes, weightKg)
}

/**
 * 跑步热量：ACSM 跑步代谢方程（平地，坡度按 0 计）。
 * VO2 (ml/kg/min) = 0.2 × v + 3.5，v 为平均速度 (m/min)；
 * 千卡 = VO2(L/min) × 5 kcal/L → 化简为 (0.2v + 3.5) × 体重kg × 分钟 ÷ 200。
 * 相比配速三档 MET，热量随平均配速连续变化，长距离误差显著更小。
 * km 缺失（跑步机未补填 / GPS 不可用）时退回 MET 中档估算。
 */
/**
 * 跑步热量：ACSM 跑步代谢方程。
 * VO2 (ml/kg/min) = 0.2 × v + 0.9 × v × grade + 3.5，v 为平均速度 (m/min)，
 * grade 为坡度（净爬升/里程的分数）。千卡 = VO2(L/min) × 5 kcal/L
 * → 化简为 (0.2v + 0.9·v·grade + 3.5) × 体重kg × 分钟 ÷ 200。
 * 相比配速三档 MET，热量随平均配速连续变化，长距离误差显著更小。
 * 坡度由调用方提供；GPS 海拔噪声大，算不出可信坡度时传 0（平地）。
 * km 缺失（跑步机未补填 / GPS 不可用）时退回 MET 中档估算。
 */
export function estimateRunKcal(
  km: number | null,
  elapsedSec: number,
  weightKg: number,
  grade = 0,
): number {
  const minutes = Math.max(1, elapsedSec / 60)
  if (km == null || km <= 0.01) return estimateKcal('run', 'moderate', minutes, weightKg)
  const v = (km * 1000) / minutes // 平均速度 m/min
  const vo2 = 0.2 * v + 0.9 * v * grade + 3.5
  return Math.round((vo2 * weightKg * minutes) / 200)
}
