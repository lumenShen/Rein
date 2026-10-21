/**
 * 浏览器开发用内存后端：与 Rust 后端实现同一套命令契约。
 * 仅在非 Tauri 环境（`npm run dev` 直接开网页）时被 transport.ts 动态加载，
 * 附带少量演示数据便于 UI 迭代；正式数据路径永远是 Rust + SQLite。
 */
import seedJson from '@resources/foods.json'
import seedPlansJson from '@resources/workout_plans.json'
import seedExercisesJson from '@resources/exercises.json'

import type {
  AiChatMessage,
  AiChatMessageInput,
  AiModel,
  AiModelInput,
  AiModelPrefs,
  AiProbeResult,
  AiProvider,
  AiProviderInput,
  AiProviderModel,
  AiUsageByModel,
  AiUsageInput,
  AiUsageSummary,
  AiUsageTotals,
  BodyMetric,
  BodyMetricInput,
  CalcState,
  ChatSearchHit,
  DailySummary,
  DailyTargets,
  ExerciseCategory,
  ExerciseEquipment,
  ExerciseInput,
  ExerciseKind,
  ExerciseRecord,
  Food,
  FoodCreateInput,
  GrabSettings,
  GrabIntent,
  GrabMatch,
  GatewayAuthRequest,
  GatewayClient,
  GatewayStatus,
  GatewayPomodoroCommand,
  GatewaySessionCommand,
  FocusRuntime,
  GrabState,
  GrabTurnBrief,
  LedgerEntry,
  LedgerEntryInput,
  LedgerSettings,
  MealLog,
  NutrientIntake,
  ParsedFoodItem,
  RecipePref,
  PomodoroSession,
  PlanSeedStatus,
  ProgramRecord,
  Profile,
  OnlineCatalog,
  ProviderAdapter,
  ProviderCatalog,
  ProviderModelKind,
  ScheduleTodoInput,
  TargetAdjustProposal,
  TargetChange,
  Todo,
  UpdateCheck,
  UpdateSettings,
  UpdateSettingsPatch,
  UpdateSnapshot,
  DownloadState,
  SourceReport,
  Workout,
  WorkoutPlanInput,
  WorkoutPlanRecord,
} from '@/types'
import { normalizeActivation } from '@/config/muscles'
import { buildAxisRows } from '@/utils/campusTimeAxis'
import { addDays, startOfMonth, startOfWeek, todayStr } from '@/utils/date'
import { ruleMatchesDate } from '@/utils/recurrence'
import { COURSE_CATEGORY } from '@/types/todo'

/* ---------------- 种子载入 ---------------- */

interface SeedFood {
  name: string
  category: string
  kcal: number
  protein: number
  carb: number
  fat: number
  fiber: number
  sugar: number
  sodiumMg: number
  potassiumMg: number
  calciumMg: number
  ironMg: number
  zincMg: number
  magnesiumMg: number
  vitAUg: number
  vitCMg: number
  vitDUg: number
  vitEMg: number
  vitB12Ug: number
  folateUg: number
  defaultUnit: string
  units: { name: string; grams: number }[]
}

const seed = seedJson as unknown as { foods: SeedFood[] }

const NUTRIENT_KEYS = [
  'kcal', 'protein', 'carb', 'fat', 'fiber', 'sugar',
  'sodiumMg', 'potassiumMg', 'calciumMg', 'ironMg', 'zincMg', 'magnesiumMg',
  'vitAUg', 'vitCMg', 'vitDUg', 'vitEMg', 'vitB12Ug', 'folateUg',
] as const satisfies readonly (keyof NutrientIntake)[]

function zeroIntake(): NutrientIntake {
  const zero = {} as NutrientIntake
  for (const k of NUTRIENT_KEYS) zero[k] = 0
  return zero
}

/* ---------------- 内存数据库 ---------------- */

let foodId = 0
const foods: Food[] = seed.foods.map((f) => ({ id: ++foodId, ...f }))

const today = todayStr()
const yesterday = addDays(today, -1)
const weekStart = startOfWeek(today)

let mealId = 0
const meals: MealLog[] = []

/** 食谱偏好（与 Rust recipe_prefs 表同契约） */
const recipePrefs: RecipePref[] = []

let todoId = 0
const todos: Todo[] = []

/**
 * 重复待办的「除外日期」：模板 id → 用户删掉的那几次（"YYYY-MM-DD"）。
 * 镜像 Rust `todos.rec_exdates`（内部列，不进 `Todo` 类型）：不记的话，删掉的实例会被
 * `sync_recurrences` 按规则原样补回来 —— 表现上就是「待办删不掉」。
 */
const recSkips = new Map<number, Set<string>>()

/** `recKey = "模板id:日期"` → `[模板id, 日期]`；不成形状返回 null（同 Rust `parse_rec_key`）。 */
function parseRecKey(key: string): [number, string] | null {
  const i = key.lastIndexOf(':')
  if (i < 0) return null
  const tid = Number(key.slice(0, i))
  return Number.isFinite(tid) ? [tid, key.slice(i + 1)] : null
}

/** 健康方案（与 Rust programs 表同契约） */
let programId = 0
const programs: ProgramRecord[] = []

/** 每日 AI 菜单缓存（与 Rust program_meals 表同契约） */
const programMeals: { programId: number; date: string; mealsJson: string; updatedAt: string }[] = []

/** 采购清单勾选状态（与 Rust shopping_checks 表同契约） */
const shoppingChecks: { itemKey: string; checkedAt: string }[] = []

let workoutId = 0
const workouts: Workout[] = []

/**
 * 第三方健康数据（Health Connect）的 mock 状态。
 *
 * 这里**故意模拟「在 Android 手机上已授权」的样子**，而不是照桌面端返回
 * `supported: false`：真机上能不能用由 Rust 侧的 `supported()` 判（桌面端恒 false），
 * 而 mock 是浏览器里迭代 UI 用的 —— 若照实返回不支持，整页只剩一句禁用说明，
 * 没法调。要看不可用态，直接把 supported 改成 false。
 */
let healthPush = false
let healthLastSync: string | null = null
let healthImported = 12
let healthExported = 0
let healthSteps = 0

/**
 * health_sync_workouts 的静态样例。
 *
 * mock 的 `workouts` 数组（本文件里由 `list_workouts` / `add_workout` 维护）**没有 source**，
 * 结构上造不出「Health Connect 导入记录」；要模拟导入块只能在命令层直接给样例。
 * 两条各代表一个展示块：health_connect = 手机同步进来的；local + startMin=null =
 * 没填开始时间、回写 HC 时会被跳过的本机记录。真机数据由 Rust 从 workouts 表读。
 */
function healthSyncWorkoutsSample(): unknown[] {
  return [
    {
      id: 90001,
      name: '晨跑',
      type: 'run',
      date: '2024-03-15',
      startMin: 440,
      durationMin: 32,
      kcal: 286,
      intensity: 'high',
      note: null,
      source: 'health_connect',
      externalId: 'hc-session-90001',
    },
    {
      id: 90002,
      name: '瑜伽',
      type: 'yoga',
      date: '2024-06-02',
      startMin: null,
      durationMin: 45,
      kcal: 150,
      intensity: 'low',
      note: '补录时没填开始时间',
      source: 'local',
      externalId: null,
    },
  ]
}

/** 样例里最早一条导入记录的日期：与 health_sync_workouts 样例第一条一致，
 *  也就是「自动」模式此刻会采用的下界 */
const HEALTH_AUTO_WINDOW_START = '2024-03-15'

/**
 * 样例里「本机记录且没填开始时间」的条数 —— 回写时会被 `build_push` 跳过的那批。
 *
 * 从样例算出来而不是写死一个数：这两处一旦不同步，页面上的「跳过 N（没填开始时间）」
 * 就和它下面的明细块对不上，而这个 N 正是用户要看的东西。真机上 skipped 只在
 * 开着回写时才有值（`build_push` 只在 push 分支里跑），所以调用处跟着 healthPush 走。
 */
function healthSkippedSample(): number {
  return (
    healthSyncWorkoutsSample() as { source: string; startMin: number | null }[]
  ).filter((w) => w.source === 'local' && w.startMin == null).length
}

/** 体征预览的样例缓存（首次生成后固定，dev 迭代时数据不跳） */
let healthMetricsCache: unknown[] | null = null

/** 伪随机（LCG，种子固定 → 每次生成同一份数据，截图可复现） */
function mockRandom(seed: number): () => number {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

/**
 * 体征镜像的样例数据：近 14 天，形状与 Kotlin `readMetrics` 的产出一致
 * （`(metric, day, value)` 行 + 各指标独立决定哪些天有值 —— 手环不会每天每项都全，
 * 空天是常态，预览卡的「灰点空位」正是为它们准备的）。
 */
function healthMetricsSample(): unknown[] {
  if (healthMetricsCache) return healthMetricsCache
  const rnd = mockRandom(20261006)
  const days: string[] = []
  const now = new Date()
  // 30 天：预览卡只取最近 14 天，详情抽屉的 raw 列表要能看到更长的历史
  for (let i = 29; i >= 0; i--) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    days.push(
      `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
    )
  }
  const build = (
    metric: string,
    value: () => number,
    keep: (i: number) => boolean,
  ) => {
    const points = days
      .map((day) => ({ day, value: value() }))
      .filter((_, i) => keep(i))
    if (!points.length) return null
    const last = points[points.length - 1]
    return { metric, latestDay: last.day, latestValue: last.value, points }
  }
  // 偶尔没戴手环（i=4、18 那两天睡眠整体缺）；体脂秤 / 血压计偶尔才上；体温计数据干脆没有
  healthMetricsCache = [
    build('steps', () => Math.round(5200 + rnd() * 6500 + (rnd() < 0.2 ? 4200 : 0)), () => true),
    build('sleep_min', () => Math.round(390 + rnd() * 110), (i) => i !== 4 && i !== 18),
    build('sleep_deep_min', () => Math.round(70 + rnd() * 45), (i) => i !== 4 && i !== 18),
    build('sleep_rem_min', () => Math.round(75 + rnd() * 50), (i) => i !== 4 && i !== 18 && i !== 11 && i !== 25),
    build(
      'weight_kg',
      () => Math.round((72.4 + (rnd() - 0.5) * 0.3) * 10) / 10,
      (i) => i % 2 === 0,
    ),
    build(
      'body_fat_pct',
      () => Math.round((20.8 + (rnd() - 0.5) * 0.8) * 10) / 10,
      (i) => i % 7 === 1,
    ),
    build('bmr_kcal', () => Math.round(1580 + rnd() * 60), (i) => i % 3 !== 1),
    build('resting_hr_bpm', () => Math.round(54 + rnd() * 8), (i) => i !== 9 && i !== 22),
    build('hrv_rmssd_ms', () => Math.round(48 + rnd() * 38), () => true),
    build('spo2_pct', () => Math.round((97.2 + rnd() * 1.6) * 10) / 10, (i) => i > 2),
    build('resp_rate_bpm', () => Math.round((14.2 + rnd() * 2.2) * 10) / 10, (i) => i % 4 === 2),
    build(
      'vo2max_ml_kg_min',
      () => Math.round((41.5 + (rnd() - 0.5) * 2) * 10) / 10,
      (i) => i % 11 === 5,
    ),
    build(
      'bp_sys_mmhg',
      () => Math.round(114 + rnd() * 10),
      (i) => i % 4 === 2,
    ),
    build(
      'bp_dia_mmhg',
      () => Math.round(72 + rnd() * 8),
      (i) => i % 4 === 2,
    ),
  ].filter((s) => s !== null)
  return healthMetricsCache
}

let sessionId = 0
interface MockSession {
  id: number
  planId: string
  planName: string
  status: 'active' | 'finished' | 'aborted'
  startedAt: string
  updatedAt: string
  exIndex: number
  setIndex: number
  weightKg: number
  elapsedSec: number
  state: Record<string, unknown>
}
const sessions: MockSession[] = []
const SESSION_STORE_KEY = 'rein.mock.sessions.v1'

/** 会话存储走 localStorage：模拟真实后端的持久化（页面刷新/重启不丢），
 *  用于验证「中断恢复」链路；后端真实实现是 SQLite workout_sessions 表。 */
function loadSessions(): void {
  try {
    const raw = localStorage.getItem(SESSION_STORE_KEY)
    if (raw) {
      const list = JSON.parse(raw) as MockSession[]
      sessions.push(...list)
      sessionId = Math.max(sessionId, ...list.map((s) => s.id), 0)
    }
  } catch {
    /* 忽略损坏数据，按空处理 */
  }
}

function saveSessions(): void {
  try {
    localStorage.setItem(SESSION_STORE_KEY, JSON.stringify(sessions))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

loadSessions()

/* ---------------- 逐组做组记录（与 Rust workout_sets 表同契约） ---------------- */

/** 重量曲线数据源：session_finish 时展开落行；exercise_id 是聚合键（动作库），
 *  exercise_name 只是历史快照（与 Rust workout_sets 同契约） */
interface MockStrengthSet {
  id: number
  workoutId: number
  planId: string | null
  exerciseKey: string
  exerciseId: string
  exerciseName: string
  setNo: number
  kind: string
  weightKg: number | null
  reps: number | null
  sec: number | null
  warmup: boolean
  createdAt: string
}

let strengthSetId = 0
const strengthSets: MockStrengthSet[] = []
const SETS_STORE_KEY = 'rein.mock.sets.v1'
/**
 * 演示做组明细的种子版本。strengthSets 持久化在 localStorage，而演示播种写在模块
 * 顶层——若不设版本闸门，每次页面加载都会再叠一份演示行（20 → 40 → 60…），
 * 污染力量曲线与「上次重量」，且 localStorage 无上限增长。
 */
const SETS_SEED_VER_KEY = 'rein.mock.sets.seedVer.v1'
const SETS_SEED_VERSION = 1
let setsSeeded = false

function loadSets(): void {
  try {
    const raw = localStorage.getItem(SETS_STORE_KEY)
    if (raw) {
      const list = JSON.parse(raw) as MockStrengthSet[]
      strengthSets.push(...list)
      strengthSetId = Math.max(strengthSetId, ...list.map((s) => s.id), 0)
    }
    setsSeeded = Number(localStorage.getItem(SETS_SEED_VER_KEY) ?? '0') >= SETS_SEED_VERSION
  } catch {
    /* 忽略损坏数据，按空处理 */
  }
}

/** 播种完成后落版本位；升版或用户清库后自动补种一次 */
function markSetsSeeded(): void {
  setsSeeded = true
  try {
    localStorage.setItem(SETS_SEED_VER_KEY, String(SETS_SEED_VERSION))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveSets(): void {
  try {
    localStorage.setItem(SETS_STORE_KEY, JSON.stringify(strengthSets))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

loadSets()

/* ---------------- 课程库（与 Rust workout_plans 表同契约） ---------------- */

interface SeedPlan {
  id: string
  name: string
  subtitle: string
  workoutType: string
  exercises: unknown[]
  equipment?: 'gym' | 'home' | null
  estDurationMin?: number | null
}

const plans: WorkoutPlanRecord[] = []
const PLAN_STORE_KEY = 'rein.mock.plans.v1'
/**
 * 内置课程种子版本：种子内容变更时 +1。
 * v5 起语义：启动只做增量补种（补齐缺失的内置课），内容升级不再自动覆盖；
 * 由前端发起「兼容合并 / 使用新版本 / 保留我的」三选一（与 Rust 端 seed.rs 一致）。
 */
const PLAN_SEED_VERSION = 5
const PLAN_SEED_VER_KEY = 'rein.mock.plans.seedVer.v1'
/** 已应用（兼容合并或使用新版本）的目标版本；0 = 未应用 */
const PLAN_SEED_APPLIED_KEY = 'rein.mock.plans.applied.v1'

/**
 * 与会话一致：localStorage 持久化，模拟真实库的「用户编辑不丢失」。
 * 种子导入与 Rust 端 seed_builtin_plans 同语义：按 id 幂等补齐缺失项，
 * 已有行（含用户改过的）永不覆盖；种子版本升级后由前端决定如何应用（v5 起）。
 */
function loadPlans(): void {
  try {
    const raw = localStorage.getItem(PLAN_STORE_KEY)
    if (raw) {
      const list = JSON.parse(raw) as WorkoutPlanRecord[]
      plans.push(...list)
    }
  } catch {
    /* 损坏数据按空处理，走种子 */
  }

  let applied = 0
  try {
    applied = Number(localStorage.getItem(PLAN_SEED_APPLIED_KEY) ?? '0')
  } catch {
    /* 读不到按 0 */
  }
  // 已应用当前版本：仍要补缺失的内置课，但不再改动已有行
  const known = new Set(plans.map((p) => p.id))
  const now = new Date().toISOString()
  for (const p of (seedPlansJson as { plans: SeedPlan[] }).plans) {
    if (!known.has(p.id)) {
      plans.push({
        id: p.id,
        name: p.name,
        subtitle: p.subtitle,
        workoutType: p.workoutType as WorkoutPlanRecord['workoutType'],
        exercises: structuredClone(p.exercises) as WorkoutPlanRecord['exercises'],
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
        equipment: p.equipment ?? null,
        estDurationMin: p.estDurationMin ?? null,
      })
    }
  }
  // 从未导入过种子（首次安装）：直接按最新版本导入并结清
  let ver = 0
  try {
    ver = Number(localStorage.getItem(PLAN_SEED_VER_KEY) ?? '0')
  } catch {
    /* 读不到按 0 */
  }
  if (ver === 0 && applied === 0) {
    localStorage.setItem(PLAN_SEED_VER_KEY, String(PLAN_SEED_VERSION))
  }
  savePlans()
}

/** 种子升级状态（模拟 Rust plan_seed_status）：已应用版本 = 决策版本 */
function planSeedStatus(): PlanSeedStatus {
  let applied: number
  try {
    applied = Number(localStorage.getItem(PLAN_SEED_APPLIED_KEY) ?? '0')
  } catch {
    applied = 0
  }
  return {
    currentVersion: applied || Number(localStorage.getItem(PLAN_SEED_VER_KEY) ?? '0'),
    latestVersion: PLAN_SEED_VERSION,
  }
}

function settleSeed(appliedVersion: number): void {
  try {
    localStorage.setItem(PLAN_SEED_APPLIED_KEY, String(appliedVersion))
    localStorage.setItem(PLAN_SEED_VER_KEY, String(PLAN_SEED_VERSION))
  } catch {
    /* 写不进去时下次启动重跑，幂等无害 */
  }
}

/** 兼容合并：字段级合并新种子到本地内置课，不覆盖用户设置（与 Rust merge_plan_exercises 同语义） */
function migratePlans(): void {
  const seed = (seedPlansJson as { plans: SeedPlan[] }).plans
  const now = new Date().toISOString()
  for (const p of seed) {
    const row = plans.find((x) => x.id === p.id)
    if (!row) continue
    const local = (Array.isArray(row.exercises) ? row.exercises : []) as unknown as Array<Record<string, unknown>>
    const seedEx = (Array.isArray(p.exercises) ? p.exercises : []) as unknown as Array<Record<string, unknown>>
    const localMap = new Map(local.map((e) => [e.id, e]))
    const out: Array<Record<string, unknown>> = []
    for (const se of seedEx) {
      const id = se.id as string | undefined
      const le = id ? localMap.get(id) : undefined
      if (le) {
        // 只补本地缺失的字段，已有的（含用户改过的）保留
        const merged = { ...le }
        for (const [k, v] of Object.entries(se)) {
          if (!(k in merged)) merged[k] = v
        }
        out.push(merged)
      } else {
        out.push(se) // 新动作：整条补上
      }
    }
    // 本地独有的动作（用户新增）保留
    const seedIds = new Set(seedEx.map((e) => e.id))
    for (const le of local) {
      if (le.id && !seedIds.has(le.id)) out.push(le)
    }
    row.exercises = out as unknown as WorkoutPlanRecord['exercises']
    row.updatedAt = now
  }
  settleSeed(PLAN_SEED_VERSION)
  savePlans()
  backfillExerciseRefs() // 种子内容不含动作库 id：合并后立刻挂回（幂等）
}

/** 使用新版本：内置课内容整体替换为新种子 */
function overridePlans(): void {
  const seed = (seedPlansJson as { plans: SeedPlan[] }).plans
  const now = new Date().toISOString()
  for (const p of seed) {
    const row = plans.find((x) => x.id === p.id)
    if (!row) continue
    row.subtitle = p.subtitle
    row.exercises = structuredClone(p.exercises) as WorkoutPlanRecord['exercises']
    row.updatedAt = now
  }
  settleSeed(PLAN_SEED_VERSION)
  savePlans()
  backfillExerciseRefs() // 覆盖进来的种子内容不含动作库 id：立刻挂回（幂等）
}

/** 保留我的：本版本不再刷新内置课内容，只结清提示 */
function keepPlans(): void {
  settleSeed(PLAN_SEED_VERSION)
}

function savePlans(): void {
  try {
    localStorage.setItem(PLAN_STORE_KEY, JSON.stringify(plans))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

/** 与 Rust list_workout_plans 的 ORDER BY 保持一致：最近使用的在前 */
function sortedPlans(): WorkoutPlanRecord[] {
  return [...plans].sort(
    (a, b) =>
      (a.lastUsedAt ? 0 : 1) - (b.lastUsedAt ? 0 : 1) ||
      (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') ||
      b.updatedAt.localeCompare(a.updatedAt),
  )
}

loadPlans()

/* ---------------- 动作库（与 Rust exercises 表同契约，0025） ---------------- */

interface SeedExercise {
  id: string
  name: string
  aliases?: string[]
  kind: string
  category: string
  equipment?: string | null
  muscles?: Record<string, number>
  tips?: string
  steps?: string[]
  defaultSets: number
  defaultReps?: number | null
  defaultWeightKg?: number | null
  defaultTargetSec?: number | null
  defaultDurationMin?: number | null
  defaultRestSec: number
  weightStep: number
}

/** 要领清洗（与 Rust steps::sanitize_steps 同语义）：最多 12 条、单条 200 字 */
function sanitizeSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return []
  return steps
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((s) => s.slice(0, 200))
}

const exercises: ExerciseRecord[] = []
/** 只持久化自建动作：内置动作每次启动按种子覆盖式刷新（与 Rust seed_exercises 同语义） */
const EXERCISE_STORE_KEY = 'rein.mock.exercises.v1'
/** 用户隐藏的内置动作 id */
const EXERCISE_HIDDEN_KEY = 'rein.mock.exercises.hidden.v1'
/** 用户收藏的内置动作 id（用户态：种子刷新不覆盖，与 Rust favorite 列同语义） */
const EXERCISE_FAVORITE_KEY = 'rein.mock.exercises.favorite.v1'

function loadExercises(): void {
  let custom: ExerciseRecord[] = []
  let hidden: string[] = []
  let favorite: string[] = []
  try {
    custom = JSON.parse(localStorage.getItem(EXERCISE_STORE_KEY) ?? '[]') as ExerciseRecord[]
    hidden = JSON.parse(localStorage.getItem(EXERCISE_HIDDEN_KEY) ?? '[]') as string[]
    favorite = JSON.parse(localStorage.getItem(EXERCISE_FAVORITE_KEY) ?? '[]') as string[]
  } catch {
    /* 损坏数据按空处理 */
  }
  const hiddenSet = new Set(hidden)
  const favoriteSet = new Set(favorite)
  const seed = seedExercisesJson as unknown as { exercises: SeedExercise[] }
  for (const e of seed.exercises) {
    exercises.push({
      id: e.id,
      name: e.name,
      aliases: e.aliases ?? [],
      kind: e.kind as ExerciseKind,
      category: e.category as ExerciseCategory,
      equipment: (e.equipment ?? null) as ExerciseEquipment | null,
      muscles: normalizeActivation(e.muscles) as ExerciseRecord['muscles'],
      tips: e.tips ?? '',
      steps: sanitizeSteps(e.steps),
      favorite: favoriteSet.has(e.id),
      defaultSets: e.defaultSets,
      defaultReps: e.defaultReps ?? null,
      defaultWeightKg: e.defaultWeightKg ?? null,
      defaultTargetSec: e.defaultTargetSec ?? null,
      defaultDurationMin: e.defaultDurationMin ?? null,
      defaultRestSec: e.defaultRestSec,
      weightStep: e.weightStep,
      isCustom: false,
      hidden: hiddenSet.has(e.id),
      sessions: 0,
      lastUsedAt: null,
    })
  }
  for (const c of custom) exercises.push({ ...c, isCustom: true, hidden: false })
}

function saveExercises(): void {
  try {
    localStorage.setItem(
      EXERCISE_STORE_KEY,
      JSON.stringify(exercises.filter((e) => e.isCustom)),
    )
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveExerciseHidden(): void {
  try {
    localStorage.setItem(
      EXERCISE_HIDDEN_KEY,
      JSON.stringify(exercises.filter((e) => !e.isCustom && e.hidden).map((e) => e.id)),
    )
  } catch {
    /* 同上 */
  }
}

function saveExerciseFavorite(): void {
  try {
    localStorage.setItem(
      EXERCISE_FAVORITE_KEY,
      JSON.stringify(exercises.filter((e) => !e.isCustom && e.favorite).map((e) => e.id)),
    )
  } catch {
    /* 同上 */
  }
}

/** 名称（或别名）精确匹配；名字已被 trim/规范化 */
function findExerciseByName(name: string): ExerciseRecord | undefined {
  const key = name.trim()
  return exercises.find((e) => e.name === key || e.aliases.includes(key))
}

interface ExerciseHint {
  kind?: string
  sets?: number | null
  reps?: number | null
  weightKg?: number | null
  targetSec?: number | null
  durationMin?: number | null
  restSec?: number | null
  tips?: string | null
  muscles?: unknown
}

/** 按名解析库 id；未命中则新建自建动作（与 Rust resolve::ensure_for_name 同语义） */
function ensureExerciseForName(name: string, hint: ExerciseHint = {}): string {
  const trimmed = name.trim() || '未命名动作'
  const hit = findExerciseByName(trimmed)
  if (hit) return hit.id
  const id = `custom-${crypto.randomUUID()}`
  const kind = (hint.kind ?? 'strength') as ExerciseKind
  exercises.push({
    id,
    name: trimmed,
    aliases: [],
    kind,
    category: 'other',
    equipment: null,
    muscles: normalizeActivation(hint.muscles),
    tips: hint.tips ?? '',
    steps: [],
    favorite: false,
    defaultSets: hint.sets ?? 3,
    defaultReps: hint.reps ?? null,
    defaultWeightKg: hint.weightKg ?? null,
    defaultTargetSec: hint.targetSec ?? null,
    defaultDurationMin: hint.durationMin ?? null,
    defaultRestSec: hint.restSec ?? 90,
    weightStep: kind === 'strength' ? 2.5 : 0,
    isCustom: true,
    hidden: false,
    sessions: 0,
    lastUsedAt: null,
  })
  saveExercises()
  return id
}

/** 课程条目一律经动作库解析（缺 exerciseId 的按名挂库），与 Rust 写入路径同语义 */
function resolvePlanExerciseIds(list: unknown[]): unknown[] {
  return list.map((raw) => {
    const item = raw as Record<string, unknown>
    if (typeof item.exerciseId === 'string' && item.exerciseId) return item
    const name = typeof item.name === 'string' ? item.name : ''
    if (!name.trim()) return item
    const id = ensureExerciseForName(name, {
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      sets: typeof item.sets === 'number' ? item.sets : null,
      reps: typeof item.reps === 'number' ? item.reps : null,
      weightKg: typeof item.weightKg === 'number' ? item.weightKg : null,
      targetSec: typeof item.targetSec === 'number' ? item.targetSec : null,
      durationMin: typeof item.durationMin === 'number' ? item.durationMin : null,
      restSec: typeof item.restSec === 'number' ? item.restSec : null,
      tips: typeof item.tips === 'string' ? item.tips : null,
      muscles: item.muscles,
    })
    return { ...item, exerciseId: id }
  })
}

/** 存量回填（幂等）：课程条目与做组记录都挂上库 id（与 Rust backfill_exercise_refs 同语义） */
function backfillExerciseRefs(): void {
  let setsChanged = false
  for (const s of strengthSets) {
    if (s.exerciseId) continue
    s.exerciseId = ensureExerciseForName(s.exerciseName, {
      kind: s.kind,
      weightKg: s.weightKg,
      reps: s.reps,
    })
    setsChanged = true
  }
  if (setsChanged) saveSets()

  let plansChanged = false
  for (const p of plans) {
    const arr = Array.isArray(p.exercises) ? (p.exercises as unknown[]) : []
    const next = resolvePlanExerciseIds(arr)
    if (JSON.stringify(next) !== JSON.stringify(arr)) {
      p.exercises = next as WorkoutPlanRecord['exercises']
      plansChanged = true
    }
  }
  if (plansChanged) savePlans()
}

/** 使用统计（sessions / lastUsedAt）：查询时按做组记录现算 */
function exerciseUsage(id: string): { sessions: number; lastUsedAt: string | null } {
  const ids = new Set<number>()
  let last: string | null = null
  for (const r of strengthSets) {
    if (r.exerciseId !== id) continue
    ids.add(r.workoutId)
    const w = workouts.find((x) => x.id === r.workoutId)
    const date = w?.date ?? r.createdAt.slice(0, 10)
    if (!last || date > last) last = date
  }
  return { sessions: ids.size, lastUsedAt: last }
}

/** 「动作库 id 或动作名」→ 库 id（旧调用 / AI 工具兼容，与 Rust resolve_exercise_id 同语义） */
function resolveExerciseId(key: string): string {
  const raw = key.trim()
  if (exercises.some((e) => e.id === raw)) return raw
  return findExerciseByName(raw)?.id ?? raw
}

/** 逐组记录 → 查询行（含 JOIN workouts 的日期与库内展示名） */
function strengthRecord(r: MockStrengthSet) {
  const w = workouts.find((x) => x.id === r.workoutId)
  // readiness / postFeeling 与 Rust 的 json_extract(state_json,'$.…') 同语义：
  // 取来源会话的值，未答 / 手动记录为 null（练够分「体感」维度的输入，postFeeling 优先）
  const sess = w?.sessionId != null ? sessions.find((x) => x.id === w.sessionId) : undefined
  const readiness = sess?.state?.readiness
  const postFeeling = sess?.state?.postFeeling
  return {
    workoutId: r.workoutId,
    date: w?.date ?? r.createdAt.slice(0, 10),
    exerciseKey: r.exerciseKey,
    exerciseId: r.exerciseId || null,
    exerciseName: exercises.find((e) => e.id === r.exerciseId)?.name ?? r.exerciseName,
    kind: r.kind,
    setNo: r.setNo,
    weightKg: r.weightKg,
    reps: r.reps,
    sec: r.sec,
    warmup: r.warmup,
    readiness: typeof readiness === 'number' ? readiness : null,
    postFeeling: typeof postFeeling === 'string' ? postFeeling : null,
  }
}

loadExercises()

let pomodoroSeq = 0
const pomodoroSessions: PomodoroSession[] = []

/* ---------------- 方案计算器快照 + 体重身高追踪（与 Rust calc_params / body_metrics 同契约） ---------------- */

interface MockBodyStore {
  /** null = 计算器从未保存过参数 */
  calc: CalcState | null
  metrics: BodyMetric[]
}

const bodyStore: MockBodyStore = { calc: null, metrics: [] }
let metricId = 0
const BODY_STORE_KEY = 'rein.mock.body.v1'

function loadBody(): void {
  try {
    const raw = localStorage.getItem(BODY_STORE_KEY)
    if (!raw) return
    const data = JSON.parse(raw) as MockBodyStore
    bodyStore.calc = data.calc ?? null
    bodyStore.metrics.push(...(data.metrics ?? []))
    metricId = Math.max(metricId, ...bodyStore.metrics.map((m) => m.id), 0)
  } catch {
    /* 损坏数据按空处理 */
  }
}

function saveBody(): void {
  try {
    localStorage.setItem(BODY_STORE_KEY, JSON.stringify(bodyStore))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

/** 首次载入的演示数据：近八周体重缓降（截图 / 演示友好） */
function seedMetricsIfEmpty(): void {
  let has = false
  try {
    has = localStorage.getItem(BODY_STORE_KEY) != null
  } catch {
    /* 无存储环境时仍提供演示数据 */
  }
  if (has) return
  for (let w = 8; w >= 1; w--) {
    const date = addDays(today, -w * 7)
    const weightKg = Math.round((72.6 - (8 - w) * 0.32) * 10) / 10
    bodyStore.metrics.push({ id: ++metricId, date, weightKg, heightCm: 175, createdAt: `${date}T08:30:00` })
  }
  saveBody()
}

loadBody()
seedMetricsIfEmpty()

/* ---------------- AI：模型配置 + 聊天历史（localStorage，与真实后端同契约） ---------------- */

interface MockAiChat {
  id: string
  seq: number
  messages: AiChatMessage[]
  title: string
  createdAt: string
  updatedAt: string
}

const aiModels: AiModel[] = []
const aiChats = new Map<string, MockAiChat>()
let aiModelId = 0
const AI_MODEL_STORE_KEY = 'rein.mock.ai_models.v1'
const AI_CHAT_STORE_KEY = 'rein.mock.ai_chats.v1'

function loadAiStore(): void {
  try {
    const rawModels = localStorage.getItem(AI_MODEL_STORE_KEY)
    if (rawModels) {
      aiModels.push(...(JSON.parse(rawModels) as AiModel[]))
      aiModelId = Math.max(aiModelId, ...aiModels.map((m) => m.id), 0)
    }
    const rawChats = localStorage.getItem(AI_CHAT_STORE_KEY)
    if (rawChats) {
      for (const c of JSON.parse(rawChats) as MockAiChat[]) {
        aiChats.set(c.id, c)
      }
    }
  } catch {
    /* 损坏数据按空处理 */
  }
}

function saveAiModels(): void {
  try {
    localStorage.setItem(AI_MODEL_STORE_KEY, JSON.stringify(aiModels))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

/* ---- Rein 在线服务（浏览器演示的假服务端） + 本机成本账本 ---- */

const ONLINE_STORE_KEY = 'rein.mock.online_service.v1'
const ONLINE_CATALOG_STORE_KEY = 'rein.mock.online_catalog.v1'
const AI_USAGE_STORE_KEY = 'rein.mock.ai_usage.v1'

let mockOnlineSettings = { baseUrl: 'http://47.100.36.179:8787', apiKey: '', savedAt: null as string | null }
let aiUsage: (AiUsageInput & { at: string })[] = []
/** 最近一次成功拿到的目录快照 —— 与 Rust 的 app_meta `online_service_catalog_v1` 同角色 */
let mockOnlineCatalog: OnlineCatalog | null = null

/** 演示用目录：与真服务端 /v1/models 的 rein 扩展字段同构 */
const MOCK_ONLINE_MODELS = [
  { id: 'auto-model', providerId: 'ark', providerName: '火山方舟', priceIn: 2, priceOut: 8 },
  { id: 'deepseek-flash', providerId: 'deepseek', providerName: 'DeepSeek', priceIn: 2, priceOut: 8 },
  { id: 'deepseek-v4-pro', providerId: 'deepseek', providerName: 'DeepSeek', priceIn: 9, priceOut: 27 },
  { id: 'qwen3-max', providerId: 'dashscope', providerName: '阿里云百炼', priceIn: 0, priceOut: 0 },
]

function buildMockCatalog(baseUrl: string, apiKey: string): OnlineCatalog {
  const base = (baseUrl || mockOnlineSettings.baseUrl).replace(/\/+$/, '')
  const key = (apiKey || mockOnlineSettings.apiKey).trim()
  const offline = mockFlag('__REIN_MOCK_SERVICE_OFFLINE__')
  const ok = Boolean(key) && !offline
  return {
    baseUrl: base,
    ok,
    status: ok ? 'ready' : offline ? 'unreachable' : 'unauthorized',
    modelsEndpoint: `${base}/v1/models`,
    chatEndpoint: `${base}/v1/chat/completions`,
    currency: 'CNY',
    trafficPerGb: 0.8,
    trafficScope: 'egress',
    clientName: ok ? '浏览器演示' : null,
    clientModels: [],
    // 账号可用性：真服务端在 rein.client 里报 status/note，这里用开关模拟「余额不足」
    clientStatus: ok && mockFlag('__REIN_MOCK_SERVICE_QUOTA_LOW__') ? '余额不足' : null,
    clientNote:
      ok && mockFlag('__REIN_MOCK_SERVICE_QUOTA_LOW__')
        ? '余额不足：请到服务端后台充值后重试'
        : null,
    models: ok
      ? MOCK_ONLINE_MODELS.map((m) => ({
          ...m,
          priced: m.priceIn > 0 || m.priceOut > 0,
          currency: 'CNY',
          unit: 'per_1m_tokens',
        }))
      : [],
    error: ok ? null : offline ? `无法连接 ${base}/v1/models` : '还没有填服务密钥（rein_sk_…）',
    checkedAt: new Date().toISOString(),
    elapsedMs: 12,
  }
}

function saveMockOnline(): void {
  try {
    localStorage.setItem(ONLINE_STORE_KEY, JSON.stringify(mockOnlineSettings))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveMockOnlineCatalog(): void {
  try {
    if (mockOnlineCatalog) localStorage.setItem(ONLINE_CATALOG_STORE_KEY, JSON.stringify(mockOnlineCatalog))
    else localStorage.removeItem(ONLINE_CATALOG_STORE_KEY)
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveMockUsage(): void {
  try {
    localStorage.setItem(AI_USAGE_STORE_KEY, JSON.stringify(aiUsage))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

/* ---- 提供商（服务商账号 + 模型目录）：与 Rust modules/ai/providers.rs 同契约 ----
 *
 * 浏览器模式没有 Rust，所以适配器注册表在这里再写一份（字段与 Rust 一一对应）。
 * 拉模型清单不联网：按适配器给一份演示目录；密钥为空或开关置位时走「接口不通」分支，
 * 于是「内置参考目录 + 失败原因」这条路径在浏览器里也能验。 */

const PROVIDER_STORE_KEY = 'rein.mock.ai_providers.v1'
const PREFS_STORE_KEY = 'rein.mock.ai_model_prefs.v1'

/** 与 Rust ADAPTERS 同构的演示注册表 */
const MOCK_ADAPTERS: ProviderAdapter[] = [
  {
    id: 'volc-ark',
    label: '火山方舟',
    nickname: '火山方舟',
    hint: '方舟模型 API / Agent Plan 套餐：LLM、视觉、向量、语音识别都能从这一个账号取',
    docs: 'https://www.volcengine.com/docs/82379',
    keyHint: '方舟 API Key（控制台 › API Key 管理）',
    modelsPath: '/models',
    styles: [
      {
        id: 'ark',
        label: '方舟模型 API',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        note: '按量计费：Key 取自方舟控制台 › API Key 管理',
      },
      {
        id: 'agent-plan',
        label: 'Agent Plan API',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        note: '套餐/计划：填套餐签发的 Key；网关地址与按量一致，若服务商给了专用域名请直接改地址',
      },
    ],
    kinds: ['llm', 'vision', 'embedding', 'asr'],
    extraFields: [
      {
        key: 'appId',
        label: '语音 App ID',
        hint: '只给「启用语音识别模型」用：火山语音控制台的 App ID（旧版凭据）',
        secret: false,
        placeholder: '选填',
      },
      {
        key: 'accessToken',
        label: '语音 Access Token',
        hint: '旧版凭据的 Access Token；填了就走旧版鉴权，不填则用上面的 API Key（新版）',
        secret: true,
        placeholder: '选填',
      },
    ],
    preset: [
      { id: 'doubao-seed-1.6', kind: 'llm', dim: null, note: '方舟主力对话模型' },
      { id: 'doubao-seed-1.6-thinking', kind: 'llm', dim: null, note: '带思考链的对话模型' },
      { id: 'doubao-seed-1.6-vision', kind: 'vision', dim: null, note: '看图/多模态' },
      { id: 'doubao-embedding-text-240715', kind: 'embedding', dim: null, note: '方舟文本向量（维度见服务商文档）' },
      { id: 'volc.seedasr.sauc.duration', kind: 'asr', dim: null, note: '豆包流式语音识别 2.0（小时版 Resource-Id）' },
    ],
  },
  {
    id: 'dashscope',
    label: '阿里云百炼',
    nickname: '百炼',
    hint: '通义千问系列：对话、视觉、向量与语音识别',
    docs: 'https://help.aliyun.com/zh/model-studio/',
    keyHint: 'DASHSCOPE_API_KEY',
    modelsPath: '/models',
    styles: [
      {
        id: 'compatible',
        label: 'OpenAI 兼容模式',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        note: '百炼的 OpenAI 兼容端点；Key 即 DASHSCOPE_API_KEY',
      },
    ],
    kinds: ['llm', 'vision', 'embedding', 'asr'],
    extraFields: [],
    preset: [
      { id: 'qwen3-max', kind: 'llm', dim: null, note: '通义千问旗舰对话模型' },
      { id: 'qwen-plus', kind: 'llm', dim: null, note: '均衡档对话模型' },
      { id: 'qwen-vl-max', kind: 'vision', dim: null, note: '视觉理解' },
      { id: 'text-embedding-v4', kind: 'embedding', dim: 1024, note: '文本向量（可降维）' },
      { id: 'paraformer-realtime-v2', kind: 'asr', dim: null, note: '实时语音识别（中文，句子级定稿；推荐）' },
      { id: 'qwen-audio-3.1-asr-flash-streaming', kind: 'asr', dim: null, note: '流式语音识别（通义千问音频）' },
      { id: 'fun-asr-realtime', kind: 'asr', dim: null, note: 'Fun-ASR 实时识别' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    nickname: 'DeepSeek',
    hint: '官方 API：对话与视觉模型',
    docs: 'https://api-docs.deepseek.com/',
    keyHint: 'sk-…',
    modelsPath: '/models',
    styles: [
      { id: 'openai', label: '官方 API', baseUrl: 'https://api.deepseek.com/v1', note: 'OpenAI 兼容；不带 /v1 也能用，这里统一带上' },
    ],
    kinds: ['llm', 'vision'],
    extraFields: [],
    preset: [
      { id: 'deepseek-flash', kind: 'llm', dim: null, note: '轻量快档' },
      { id: 'deepseek-v4-pro', kind: 'llm', dim: null, note: '高质档' },
      { id: 'deepseek-v4-flash-vision-exp', kind: 'vision', dim: null, note: '视觉实验模型（拍照识别可用）' },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    nickname: '硅基流动',
    hint: '聚合网关：对话、视觉与向量',
    docs: 'https://docs.siliconflow.cn/',
    keyHint: 'sk-…',
    modelsPath: '/models',
    styles: [
      { id: 'openai', label: 'OpenAI 兼容', baseUrl: 'https://api.siliconflow.cn/v1', note: '聚合网关地址；模型 ID 形如 组织/模型' },
    ],
    kinds: ['llm', 'vision', 'embedding'],
    extraFields: [],
    preset: [
      { id: 'deepseek-ai/DeepSeek-V3', kind: 'llm', dim: null, note: '第三方托管的 DeepSeek V3' },
      { id: 'Qwen/Qwen3-8B', kind: 'llm', dim: null, note: '小体积对话模型' },
      { id: 'BAAI/bge-m3', kind: 'embedding', dim: 1024, note: '多语向量（1024 维）' },
    ],
  },
  {
    id: 'openai-compatible',
    label: '自定义（OpenAI 兼容）',
    nickname: '自定义',
    hint: '任何 OpenAI 兼容网关：地址自己填，模型清单从 /models 拉',
    docs: '',
    keyHint: '服务商给的 Key',
    modelsPath: '/models',
    styles: [
      { id: 'openai', label: 'OpenAI 兼容', baseUrl: '', note: '填服务商给的 base 地址（通常以 /v1 结尾）' },
    ],
    kinds: ['llm', 'vision', 'embedding'],
    extraFields: [],
    preset: [],
  },
]

let mockProviders: AiProvider[] = []
let mockProviderId = 0
let mockPrefs: AiModelPrefs = {
  visionRef: 'auto',
  asrRef: 'voice',
  embeddingRef: '',
  providerNameDisplay: true,
  providerNameFolder: true,
}

/** 与 Rust guess_kind 同一套词表（浏览器演示用） */
function mockGuessKind(modelId: string): ProviderModelKind {
  const s = modelId.toLowerCase()
  if (/(embed|bge|gte-|text-embedding|vector)/.test(s)) return 'embedding'
  if (/(asr|whisper|sensevoice|paraformer|sauc|seedasr|speech-to-text|transcription)/.test(s)) return 'asr'
  if (/(tts|speech-synthesis|text-to-speech|voice-clone)/.test(s)) return 'tts'
  if (/(vision|-vl|vl-|omni|visual|multimodal)/.test(s)) return 'vision'
  return 'llm'
}

/** 适配器不提供的类别丢掉；视觉没有槽位时按对话收下（与 Rust accept_kind 同规则） */
function mockAcceptKind(kind: ProviderModelKind, kinds: ProviderModelKind[]): ProviderModelKind | null {
  if (kinds.includes(kind)) return kind
  if ((kind === 'llm' || kind === 'vision') && kinds.includes('llm')) return 'llm'
  return null
}

function saveMockProviders(): void {
  try {
    localStorage.setItem(PROVIDER_STORE_KEY, JSON.stringify(mockProviders))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveMockPrefs(): void {
  try {
    localStorage.setItem(PREFS_STORE_KEY, JSON.stringify(mockPrefs))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function loadMockProviders(): void {
  try {
    const raw = localStorage.getItem(PROVIDER_STORE_KEY)
    if (raw) {
      mockProviders = JSON.parse(raw) as AiProvider[]
      mockProviderId = Math.max(0, ...mockProviders.map((p) => p.id))
    }
    const rawPrefs = localStorage.getItem(PREFS_STORE_KEY)
    if (rawPrefs) mockPrefs = { ...mockPrefs, ...(JSON.parse(rawPrefs) as AiModelPrefs) }
  } catch {
    /* 损坏数据按空处理 */
  }
}

function mockProviderModel(
  providerId: number,
  modelId: string,
  kind: ProviderModelKind,
  origin: 'api' | 'preset' | 'manual',
  meta: string | null,
): AiProviderModel {
  return { providerId, modelId, kind, origin, meta, fetchedAt: new Date().toISOString() }
}

/** 拉目录（演示）：密钥为空或开关置位 → 接口不通 + 内置参考目录 */
function buildMockProviderCatalog(
  adapter: ProviderAdapter,
  baseUrl: string,
  apiKey: string,
): ProviderCatalog {
  const base = (baseUrl || adapter.styles[0]?.baseUrl || '').replace(/\/+$/, '')
  const endpoint = `${base}${adapter.modelsPath}`
  const offline = mockFlag('__REIN_MOCK_PROVIDER_OFFLINE__')
  const presets = adapter.preset.map((p) =>
    mockProviderModel(
      0,
      p.id,
      p.kind,
      'preset',
      p.dim ? JSON.stringify({ dim: p.dim, note: p.note }) : JSON.stringify({ note: p.note }),
    ),
  )
  if (!apiKey.trim() || offline) {
    return {
      ok: false,
      status: offline ? 'unreachable' : 'unauthorized',
      endpoint,
      error: offline ? `无法连接 ${endpoint}` : '还没有填该提供商的密钥，模型清单需要密钥才能取到',
      models: presets,
      elapsedMs: 9,
      fromPreset: true,
      fetchedAt: new Date().toISOString(),
    }
  }
  // 演示目录：内置参考 + 一条只在该适配器出现的「额外」模型，模拟接口清单比参考目录更全
  const extra: Record<string, [string, ProviderModelKind][]> = {
    'volc-ark': [['doubao-1.5-lite-32k', 'llm'], ['doubao-embedding-large-text-240915', 'embedding']],
    dashscope: [['qwen-long', 'llm'], ['qwen-audio-turbo', 'asr']],
    deepseek: [['deepseek-coder-v2', 'llm']],
    siliconflow: [['THUDM/glm-4-9b-chat', 'llm']],
    'openai-compatible': [['gpt-4o-mini', 'llm'], ['text-embedding-3-small', 'embedding']],
  }
  const apiModels = [
    ...adapter.preset.map((p) => mockProviderModel(0, p.id, p.kind, 'api', null)),
    ...(extra[adapter.id] ?? []).map(([id, kind]) => mockProviderModel(0, id, kind, 'api', null)),
  ]
  return {
    ok: true,
    status: 'ready',
    endpoint,
    error: null,
    models: apiModels,
    elapsedMs: 14,
    fromPreset: false,
    fetchedAt: new Date().toISOString(),
  }
}

/** 写目录：ok 时以接口清单为准（清掉过期的 api 行、把 preset 提升成 api），失败只补参考 */
function mockPersistModels(
  provider: AiProvider,
  models: AiProviderModel[],
  ok: boolean,
): void {
  for (const m of models) {
    const existing = provider.models.find((x) => x.modelId === m.modelId)
    if (existing) {
      if (ok) {
        existing.kind = m.kind
        existing.origin = 'api'
        existing.meta = m.meta ?? existing.meta
        existing.fetchedAt = m.fetchedAt
      }
    } else {
      provider.models.push({ ...m, providerId: provider.id })
    }
  }
  if (ok) {
    const keep = new Set(models.map((m) => m.modelId))
    provider.models = provider.models.filter((m) => m.origin !== 'api' || keep.has(m.modelId))
  }
}

function loadMockOnlineAndUsage(): void {
  try {
    const rawOnline = localStorage.getItem(ONLINE_STORE_KEY)
    if (rawOnline) mockOnlineSettings = { ...mockOnlineSettings, ...(JSON.parse(rawOnline) as typeof mockOnlineSettings) }
    const rawCatalog = localStorage.getItem(ONLINE_CATALOG_STORE_KEY)
    if (rawCatalog) mockOnlineCatalog = JSON.parse(rawCatalog) as OnlineCatalog
    const rawUsage = localStorage.getItem(AI_USAGE_STORE_KEY)
    if (rawUsage) aiUsage = JSON.parse(rawUsage) as typeof aiUsage
  } catch {
    /* 损坏数据按空处理 */
  }
}

/** 本机账本汇总：与 Rust `ai_usage_summary` 同结构 */
function summarizeMockUsage(rows: typeof aiUsage, days: number, since: string): AiUsageSummary {
  const blank = (): AiUsageTotals => ({
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    requestBytes: 0,
    responseBytes: 0,
    costModelNano: 0,
    costTrafficNano: 0,
    costTotalNano: 0,
  })
  const add = (b: AiUsageTotals, u: (typeof aiUsage)[number]): AiUsageTotals => ({
    calls: b.calls + 1,
    promptTokens: b.promptTokens + (u.promptTokens ?? 0),
    completionTokens: b.completionTokens + (u.completionTokens ?? 0),
    requestBytes: b.requestBytes + (u.requestBytes ?? 0),
    responseBytes: b.responseBytes + (u.responseBytes ?? 0),
    costModelNano: b.costModelNano + (u.costModelNano ?? 0),
    costTrafficNano: b.costTrafficNano + (u.costTrafficNano ?? 0),
    costTotalNano: b.costTotalNano + (u.costModelNano ?? 0) + (u.costTrafficNano ?? 0),
  })

  const total = rows.reduce(add, blank())
  const todayKey = new Date().toISOString().slice(0, 10)
  const today = rows.filter((u) => u.at.slice(0, 10) === todayKey).reduce(add, blank())

  const dayMap = new Map<string, AiUsageTotals>()
  for (const u of rows) {
    const d = u.at.slice(0, 10)
    dayMap.set(d, add(dayMap.get(d) ?? blank(), u))
  }
  const modelMap = new Map<string, AiUsageByModel>()
  for (const u of rows) {
    const key = `${u.modelName}|${u.modelId}|${u.source ?? 'manual'}`
    const cur =
      modelMap.get(key) ??
      ({ modelPk: u.modelPk ?? null, modelName: u.modelName, modelId: u.modelId, source: u.source ?? 'manual', ...blank() } as AiUsageByModel)
    modelMap.set(key, { ...cur, ...add(cur, u) })
  }

  return {
    days,
    since,
    today,
    total,
    byDay: [...dayMap.entries()].map(([date, t]) => ({ date, ...t })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    byModel: [...modelMap.values()].sort((a, b) => b.costTotalNano - a.costTotalNano),
  }
}

loadMockOnlineAndUsage()

function saveAiChats(): void {
  try {
    localStorage.setItem(AI_CHAT_STORE_KEY, JSON.stringify([...aiChats.values()]))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

loadAiStore()
loadMockProviders()

const defaultTargets: DailyTargets = {
  kcal: 2000,
  protein: 80,
  carb: 250,
  fat: 65,
  sodiumMg: 1500,
  waterMl: 1700,
}

const profile: Profile = {
  nickname: 'Rein 用户',
  sex: null,
  birthday: null,
  heightCm: 175,
  weightKg: 70,
  targetWeightKg: 68,
  activityLevel: 'light',
  goal: 'cut',
  targets: { ...defaultTargets },
  trainingDaysPerWeek: 3,
  preferredTimeSlots: ['evening'],
  equipment: 'gym',
  dietRestrictions: [],
  experience: 'beginner',
}

/* ---------------- 演示数据 ---------------- */

function foodByName(name: string): Food {
  const f = foods.find((x) => x.name.startsWith(name))
  if (!f) throw new Error(`演示数据缺少食物 ${name}`)
  return f
}

function unitGrams(f: Food, unitName: string): number {
  return f.units.find((u) => u.name === unitName)?.grams ?? 100
}

function addMeal(
  foodName: string,
  date: string,
  mealType: MealLog['mealType'],
  qty: { mode: 'grams'; grams: number } | { mode: 'unit'; unit: string; count: number },
  source: MealLog['source'] = 'search',
): void {
  const f = foodByName(foodName)
  const grams = qty.mode === 'grams' ? qty.grams : qty.count * unitGrams(f, qty.unit)
  meals.push({
    id: ++mealId,
    foodId: f.id,
    date,
    mealType,
    quantityMode: qty.mode === 'grams' ? 'grams' : 'unit',
    grams,
    units: qty.mode === 'unit' ? qty.count : null,
    unitName: qty.mode === 'unit' ? qty.unit : null,
    source,
    note: null,
    createdAt: `${date}T08:00:00`,
    food: f,
  })
}

// 今天的三餐（截图 / 演示友好）
addMeal('燕麦片', today, 'breakfast', { mode: 'grams', grams: 40 })
addMeal('鸡蛋', today, 'breakfast', { mode: 'unit', unit: '个', count: 1 })
addMeal('牛奶', today, 'breakfast', { mode: 'unit', unit: '杯', count: 1 })
addMeal('米饭', today, 'lunch', { mode: 'unit', unit: '碗', count: 1 })
addMeal('鸡胸肉', today, 'lunch', { mode: 'grams', grams: 150 })
addMeal('西兰花', today, 'lunch', { mode: 'grams', grams: 150 })
addMeal('蓝莓', today, 'snack', { mode: 'unit', unit: '盒', count: 1 })

function addTodo(t: Partial<Todo> & { title: string; date: string }): void {
  todos.push({
    id: ++todoId,
    title: t.title,
    notes: t.notes ?? null,
    date: t.date,
    startMin: t.startMin ?? null,
    durationMin: t.durationMin ?? null,
    category: t.category ?? 'general',
    priority: t.priority ?? 0,
    status: t.status ?? 'todo',
    completedAt: t.status === 'done' ? `${t.date}T09:00:00` : null,
    createdAt: `${t.date}T07:00:00`,
    programId: t.programId ?? null,
    recRule: t.recRule ?? null,
    recKey: t.recKey ?? null,
    subtasks: t.subtasks ?? null,
  })
}

addTodo({ title: '晨间拉伸', date: today, startMin: 7 * 60 + 20, durationMin: 15, category: 'health', status: 'done' })
addTodo({ title: '午休散步 20 分钟', date: today, startMin: 12 * 60 + 40, durationMin: 20, category: 'health', priority: 1 })
addTodo({ title: '力量训练 · 上肢', date: today, startMin: 18 * 60 + 30, durationMin: 45, category: 'workout', priority: 2 })
addTodo({ title: '写今日复盘', date: today, startMin: 21 * 60 + 30, category: 'study' })
// 未安排池演示：今天要做但还没定时间
addTodo({ title: '预约牙医', date: today, durationMin: 10, category: 'health' })
addTodo({ title: '回复产品反馈', date: today, durationMin: 15, category: 'work', priority: 1 })
addTodo({ title: '阅读《睡眠革命》', date: today, durationMin: 30, category: 'study' })
addTodo({ title: '跑步 5 公里', date: yesterday, startMin: 19 * 60, durationMin: 30, category: 'workout', status: 'done' })
addTodo({ title: '蔬菜摄入达标', date: yesterday, category: 'health', status: 'done' })
addTodo({ title: '整理周报提纲', date: addDays(today, 1), startMin: 10 * 60, durationMin: 30, category: 'work', priority: 1 })
// 重复模板演示：工作日每天 10 分钟拉伸（实例由 sync_recurrences 物化）
addTodo({
  title: '通勤骑行',
  date: today,
  startMin: 8 * 60 + 30,
  durationMin: 25,
  category: 'workout',
  recRule: { freq: 'weekly', weekdays: [0, 1, 2, 3, 4], intervalDays: 0, endDate: null },
})

/**
 * 主页「全部待办」信息流（HomeTodoFeed / query_todo_feed）的演示种子 —— 三个开关都只服务
 * scripts/e2e-home-todo-feed.mjs，默认（一个都不设）本函数不改任何数据，演示数据与从前逐字节一致：
 *
 *   · localStorage['rein.e2e.todoFeedBulk'] === '1' → 追加 296 条种子，条数远大于一页
 *     （HomeTodoFeed 的 FEED_PAGE = 30），用来验证「滑到底边再逐批渲染」；
 *   · window.__REIN_MOCK_TODO_EMPTY__ = true → 清空全部待办（连重复模板一起清，
 *     于是 sync_recurrences 也不会再物化实例），用来验证信息流空态；
 *   · window.__REIN_MOCK_TODO_FEED_FAIL__ = true → query_todo_feed 直接抛错（见 mockInvoke 的同名 case），
 *     用来验证失败态与重试。
 *
 * 种子构成（296 = 8 + 36 + 12 + 200 + 40）覆盖四个日期桶与已完成：
 *   未安排 8（date=null）· 逾期 36（today-1…today-36）· 今天 12 · 未来 40 天 × 5 = 200 ·
 *   已完成 40（未安排 / 逾期 / 今天 / 未来各 10）。标题带序号便于 e2e 顺序抽查；
 *   priority 取 i%3、startMin 按 i%2 交替，覆盖「无时间靠后 / 优先级降序」这两个排序键。
 *
 * 注意：默认演示数据（上面那批 addTodo）必须保持 ≤ FEED_PAGE（30 条）。
 * 超过一页，主页信息流就会从「首屏一次挂完」切到「到边分批」，
 * 于是滑到主页底边会持续长高、rubberScroll 的 band 起不来 ——
 * scripts/e2e-rubber-scroll.mjs 的 I2a/I3a 会红（阈值见 HomeTodoFeed.vue 的 FEED_PAGE）。
 */
function seedTodoFeedBulk(): void {
  if (mockFlag('__REIN_MOCK_TODO_EMPTY__')) {
    todos.length = 0
    return
  }
  const bulk =
    typeof localStorage !== 'undefined' && localStorage.getItem('rein.e2e.todoFeedBulk') === '1'
  if (!bulk) return
  const pad = (n: number): string => String(n).padStart(2, '0')
  // 不走 addTodo：它的 date 参数是非空 string，而种子要造收件箱（date=null）行
  const seed = (title: string, date: string | null, i: number, status: Todo['status'] = 'todo'): void => {
    todos.push({
      id: ++todoId,
      title,
      notes: null,
      date,
      startMin: i % 2 === 1 ? null : 9 * 60 + i,
      durationMin: null,
      category: 'general',
      priority: i % 3,
      status,
      completedAt: status === 'done' ? `${date ?? today}T09:00:00` : null,
      createdAt: `${date ?? today}T07:00:00`,
      programId: null,
      recRule: null,
      recKey: null,
      subtasks: null,
    })
  }
  for (let i = 1; i <= 8; i++) seed(`未安排待办 ${pad(i)}`, null, i)
  for (let i = 1; i <= 36; i++) seed(`逾期待办 ${pad(i)}`, addDays(today, -i), i)
  for (let i = 1; i <= 12; i++) seed(`今日待办 ${pad(i)}`, today, i)
  for (let d = 1; d <= 40; d++) {
    for (let k = 1; k <= 5; k++) seed(`未来待办 ${pad(d)}-${k}`, addDays(today, d), d * 5 + k)
  }
  for (let i = 1; i <= 10; i++) seed(`已完成未安排 ${pad(i)}`, null, i, 'done')
  for (let i = 1; i <= 10; i++) seed(`已完成逾期 ${pad(i)}`, addDays(today, -i), i, 'done')
  for (let i = 1; i <= 10; i++) seed(`已完成今天 ${pad(i)}`, today, i, 'done')
  // 已完成 · 未来统一落在今天+40：让 done 段只多出一个日期分组
  for (let i = 1; i <= 10; i++) seed(`已完成未来 ${pad(i)}`, addDays(today, 40), i, 'done')
}

seedTodoFeedBulk()

function addWorkout(w: Partial<Workout> & { name: string; type: Workout['type']; date: string; durationMin: number; kcal: number }): void {
  workouts.push({
    id: ++workoutId,
    name: w.name,
    type: w.type,
    date: w.date,
    startMin: w.startMin ?? null,
    durationMin: w.durationMin,
    kcal: w.kcal,
    intensity: w.intensity ?? 'moderate',
    effort: w.effort ?? null,
    note: w.note ?? null,
    sessionId: w.sessionId ?? null,
    // 种子记录默认是本机记的；要一条「手机同步」样例见下面「晨跑」那条
    source: w.source ?? 'local',
    createdAt: `${w.date}T20:00:00`,
  })
}

// 「夜跑」这条标成手机同步：dev 里唯一能看到「手机同步」徽标的记录。
// 只改这一条的来源、**不新插记录** —— 这份数据同时喂着浏览器 e2e，多一条就会动到
// 「本周分钟 / 大卡 / 次数」与记录页行数这类断言（见 scripts/e2e-feature-toggles.mjs、
// scripts/e2e-strength.mjs）。真机上这个值由 Rust 从 workouts.source 读，不由 mock 决定。
addWorkout({ name: '夜跑', type: 'run', date: addDays(today, -2), startMin: 19 * 60 + 30, durationMin: 30, intensity: 'high', kcal: 360, source: 'health_connect' })
addWorkout({ name: '力量训练 · 下肢', type: 'strength', date: yesterday, startMin: 18 * 60 + 30, durationMin: 40, intensity: 'moderate', kcal: 245 })
// 手动补录样例：走体感 + 用户直接给热量那条路（effort 有值、intensity 是派生档位）
addWorkout({ name: '羽毛球 · 47分钟', type: 'badminton', date: today, startMin: 20 * 60, durationMin: 47, intensity: 'moderate', effort: 4, kcal: 412 })

/** 演示会话落库（与 session_start/session_finish 同语义）：浏览器 dev 也能查看带轨迹/做组明细的详情 */
function addDemoSession(p: {
  planId: string
  planName: string
  startedAt: string
  elapsedSec: number
  state: Record<string, unknown>
}): number {
  const id = ++sessionId
  sessions.push({
    id,
    planId: p.planId,
    planName: p.planName,
    status: 'finished',
    startedAt: p.startedAt,
    updatedAt: p.startedAt,
    exIndex: 0,
    setIndex: 1,
    weightKg: 0,
    elapsedSec: p.elapsedSec,
    state: p.state,
  })
  return id
}

/** 合成一条绕圈 GPS 轨迹（含时间戳与海拔），用于演示跑步详情 */
function synthTrack(totalKm: number, totalSec: number, laps = 4): { lat: number; lon: number; t: number; alt: number }[] {
  const cx = 31.2304
  const cy = 121.4737
  const rBase = 0.0045 / laps // 每圈半径递增，避免完全重合
  const n = Math.min(400, Math.round(totalKm * 60))
  const points: { lat: number; lon: number; t: number; alt: number }[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const ang = f * laps * 2 * Math.PI
    const r = rBase * (1 + f * 0.25)
    points.push({
      lat: cx + r * Math.sin(ang),
      lon: cy + (r * Math.cos(ang)) / Math.cos((cx * Math.PI) / 180),
      t: Math.round(f * totalSec * 1000),
      alt: 8 + Math.sin(f * 7) * 6,
    })
  }
  return points
}

// 演示一：夜跑（5 km · 30 min，目标距离）→ 详情抽屉的跑步视图
{
  const durSec = 30 * 60
  const sid = addDemoSession({
    planId: '__run__',
    planName: '户外跑',
    startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    elapsedSec: durSec,
    state: {
      kind: 'run',
      phase: 'summary',
      goalKind: 'distance',
      goalTimeMin: 30,
      goalDistanceKm: 5,
      accumMs: durSec * 1000,
      segStartedAt: null,
      distanceM: 5000,
      points: synthTrack(5, durSec),
    },
  })
  workouts[0]!.sessionId = sid
  workouts[0]!.note = "5.00 km · 配速 6'00\""
}

// 演示二：腿日（ppl-legs 前四个动作）→ 详情抽屉的课程做组明细视图
{
  const doneSets: Record<string, { weight: number | null; sec: number | null; warmup?: boolean }[]> = {
    'ppl-legs-squat': [
      { weight: 35, sec: null, warmup: true },
      { weight: 52.5, sec: null, warmup: true },
      { weight: 70, sec: null },
      { weight: 72.5, sec: null },
      { weight: 75, sec: null },
      { weight: 75, sec: null },
    ],
    'ppl-legs-rdl': [
      { weight: 30, sec: null, warmup: true },
      { weight: 60, sec: null },
      { weight: 60, sec: null },
      { weight: 62.5, sec: null },
    ],
    'ppl-legs-bulgarian': [
      { weight: 16, sec: null },
      { weight: 16, sec: null },
      { weight: 16, sec: null },
    ],
    'ppl-legs-leg-curl': [{ weight: 30, sec: null }],
  }
  const sid = addDemoSession({
    planId: 'ppl-legs',
    planName: '腿日',
    startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    elapsedSec: 40 * 60,
    state: {
      doneSets,
      exIndex: 3,
      setIndex: 1,
      weight: 30,
      phase: 'exercise',
      restLeft: 0,
      restTargetIsNextSet: true,
      timedTotal: 0,
    },
  })
  workouts[1]!.sessionId = sid
  workouts[1]!.note = '11/26 组完成 · 提前结束 · 总容量约 5005 kg'
  // 深蹲/罗马尼亚硬拉的逐组明细（含热身行）→ 重量曲线演示数据
  const legSets: [string, string, { w: number | null; reps: number; warmup?: boolean }[]][] = [
    ['ppl-legs-squat', '杠铃深蹲', [{ w: 35, reps: 8, warmup: true }, { w: 52.5, reps: 4, warmup: true }, { w: 70, reps: 8 }, { w: 72.5, reps: 8 }, { w: 75, reps: 8 }, { w: 75, reps: 8 }]],
    ['ppl-legs-rdl', '罗马尼亚硬拉', [{ w: 30, reps: 12, warmup: true }, { w: 60, reps: 10 }, { w: 60, reps: 10 }, { w: 62.5, reps: 10 }]],
  ]
  if (!setsSeeded) {
    for (const [key, name, list] of legSets) {
      let warmNo = 0
      let setNo = 0
      for (const it of list) {
        if (it.warmup) warmNo++
        else setNo++
        strengthSets.push({
          id: ++strengthSetId,
          workoutId: workouts[1]!.id,
          planId: 'ppl-legs',
          exerciseKey: key,
          exerciseId: '',
          exerciseName: name,
          setNo: it.warmup ? warmNo : setNo,
          kind: 'strength',
          weightKg: it.w,
          reps: it.reps,
          sec: null,
          warmup: !!it.warmup,
          createdAt: new Date().toISOString(),
        })
      }
    }
    saveSets()
  }
}

// 演示三：杠铃卧推近 4 周渐进超负荷（推日，供力量曲线卡与「上次重量」演示）
{
  const benchWeeks = [
    { daysAgo: 27, sets: [55, 57.5, 57.5] },
    { daysAgo: 20, sets: [57.5, 60, 60] },
    { daysAgo: 13, sets: [60, 60, 60] },
    { daysAgo: 6, sets: [60, 62.5, 62.5] },
  ]
  for (const wk of benchWeeks) {
    const w: Workout = {
      id: ++workoutId,
      name: '推日',
      type: 'strength',
      date: addDays(today, -wk.daysAgo),
      startMin: 18 * 60 + 30,
      durationMin: 55,
      kcal: 320,
      intensity: 'moderate',
      effort: null,
      note: null,
      sessionId: null,
      // 本机记的（真机由 workouts.source 列的默认值决定）
      source: 'local',
      createdAt: new Date().toISOString(),
    }
    workouts.push(w)
    // 30×8 + 45×4 激活热身，正式组递增
    const rows: { w: number; reps: number; warmup?: boolean }[] = [
      { w: 30, reps: 8, warmup: true },
      { w: 45, reps: 4, warmup: true },
      ...wk.sets.map((weight) => ({ w: weight, reps: 8 })),
    ]
    if (setsSeeded) continue
    let warmNo = 0
    let setNo = 0
    for (const r of rows) {
      if (r.warmup) warmNo++
      else setNo++
      strengthSets.push({
        id: ++strengthSetId,
        workoutId: w.id,
        planId: 'ppl-push',
        exerciseKey: 'ppl-push-bench',
        exerciseId: '',
        exerciseName: '杠铃卧推',
        setNo: r.warmup ? warmNo : setNo,
        kind: 'strength',
        weightKg: r.w,
        reps: r.reps,
        sec: null,
        warmup: !!r.warmup,
        createdAt: new Date().toISOString(),
      })
    }
  }
  if (!setsSeeded) saveSets()
  markSetsSeeded()
}

/** 演示数据与老 localStorage 数据统一挂上动作库 id（幂等，与 Rust 启动回填同语义） */
backfillExerciseRefs()

// 历史演示记录：过去约 5 个月每周 1–2 次，确定性模式生成（供日/周/年视图浏览）
const DEMO_HISTORY = [
  { name: '晨跑', type: 'run' as const, startMin: 7 * 60, durationMin: 35, intensity: 'moderate' as const },
  { name: '力量训练 · 上肢', type: 'strength' as const, startMin: 19 * 60, durationMin: 45, intensity: 'moderate' as const },
  { name: '周末骑行', type: 'cycle' as const, startMin: 9 * 60 + 30, durationMin: 60, intensity: 'high' as const },
]
for (let wk = 1; wk <= 22; wk++) {
  for (let k = 0; k < (wk % 2 === 0 ? 2 : 1); k++) {
    const d = DEMO_HISTORY[(wk + k) % DEMO_HISTORY.length]!
    const date = addDays(today, -(wk * 7) - k * 2)
    addWorkout({ ...d, date, kcal: Math.round(d.durationMin * 6.5) })
  }
}

pomodoroSessions.push(
  { id: ++pomodoroSeq, todoId: null, startedAt: `${today}T10:00:00`, endedAt: `${today}T10:25:00`, focusMin: 25, breakMin: 5, completed: true },
  { id: ++pomodoroSeq, todoId: null, startedAt: `${today}T14:00:00`, endedAt: `${today}T14:50:00`, focusMin: 50, breakMin: 10, completed: true },
)

/* ---------------- 记账演示数据 ---------------- */

let ledgerId = 0
const ledgerEntries: LedgerEntry[] = []

const ledgerSettings: LedgerSettings = { id: 1, monthlyBudgetCents: 300000, updatedAt: null }

/** 本月演示流水：offset 为距今天的天数，越过月初则跳过 */
function addLedgerEntry(
  offset: number,
  kind: 'expense' | 'income',
  category: string,
  amountCents: number,
  note: string | null,
): void {
  const date = addDays(today, -offset)
  if (date < startOfMonth(today)) return
  ledgerEntries.push({
    id: ++ledgerId,
    kind,
    category,
    amountCents,
    note,
    date,
    createdAt: `${date}T12:00:00`,
  })
}

addLedgerEntry(0, 'expense', 'food', 3250, '午餐 + 咖啡')
addLedgerEntry(0, 'expense', 'transport', 600, '地铁通勤')
addLedgerEntry(0, 'expense', 'shopping', 12900, '超市采购')
addLedgerEntry(1, 'expense', 'food', 4590, '朋友聚餐')
addLedgerEntry(1, 'expense', 'entertainment', 3800, '电影票')
addLedgerEntry(2, 'expense', 'transport', 1500, '打车')
addLedgerEntry(2, 'expense', 'bills', 8800, '话费充值')
addLedgerEntry(3, 'expense', 'food', 2800, '晚餐')
addLedgerEntry(4, 'expense', 'medical', 5650, '感冒药')
addLedgerEntry(5, 'expense', 'shopping', 26800, '新跑鞋')
addLedgerEntry(6, 'expense', 'food', 1890, '早餐')
addLedgerEntry(9, 'expense', 'housing', 180000, '房租')
addLedgerEntry(13, 'expense', 'transport', 32000, '加油')
addLedgerEntry(1, 'income', 'salary', 1200000, '8 月工资')
addLedgerEntry(8, 'income', 'refund', 3900, '退款 · 退货')
addLedgerEntry(12, 'income', 'bonus', 200000, '项目奖金')

/* ---------------- 命令实现 ---------------- */

type Args = Record<string, unknown>

async function delay<T>(value: T): Promise<T> {
  await new Promise((r) => setTimeout(r, 120))
  return value
}

/**
 * 入参统一转纯 JSON 数据：store 传来的对象可能是响应式代理，
 * 直接 structuredClone 会抛 DataCloneError。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

function summarize(date: string): DailySummary {
  const intake = zeroIntake()
  for (const m of meals) {
    if (m.date !== date || !m.food) continue
    const k = m.grams / 100
    for (const key of NUTRIENT_KEYS) intake[key] += m.food[key] * k
  }
  const exerciseKcal = workouts.filter((w) => w.date === date).reduce((s, w) => s + w.kcal, 0)
  return { date, intake, targets: { ...profile.targets }, exerciseKcal }
}

const CN_NUM: Record<string, number> = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function defaultGrams(f: Food): number {
  if (f.defaultUnit) {
    const u = f.units.find((x) => x.name === f.defaultUnit)
    if (u) return u.grams
  }
  return 100
}

/** 关键词解析：食物名命中 + 就近数量词（"一个""200克"）→ 克重估计 */
export function parseFoodText(text: string): ParsedFoodItem[] {
  const out: ParsedFoodItem[] = []
  for (const f of foods) {
    if (out.length >= 6) break
    const base = f.name.replace(/\(.*?\)/g, '')
    const idx = text.indexOf(base)
    if (idx === -1 || out.some((r) => r.foodId === f.id)) continue

    const before = text.slice(Math.max(0, idx - 8), idx)
    let grams = defaultGrams(f)

    const gramMatch = [...before.matchAll(/(\d+(?:\.\d+)?)\s*(?:克|g)/gi)].pop()
    const unitMatch = [...before.matchAll(/([半一两二两三四五六七八九十\d]+)\s*(个|碗|杯|根|片|块|勺|份|颗|把|盒|支)/)].pop()

    if (gramMatch) {
      grams = Number(gramMatch[1])
    } else if (unitMatch && unitMatch[2]) {
      // CN_NUM 里没有这个词：退回数字解析；都不是数字就按「一份」算
      // （`Number(x) ?? 1` 是错的 —— Number 只会给 NaN，不会给 null）
      const cn = CN_NUM[unitMatch[1]] as number | undefined
      const parsed = Number(unitMatch[1])
      const count = cn ?? (Number.isFinite(parsed) ? parsed : 1)
      const u = f.units.find((x) => x.name === unitMatch[2])
      grams = Math.round((u?.grams ?? defaultGrams(f)) * count)
    }

    out.push({
      foodId: f.id,
      foodName: base,
      grams,
      kcalEstimate: Math.round((f.kcal * grams) / 100),
      confidence: 0.6,
      note: null,
    })
  }
  return out
}

/* ---------------- AI 目标调整解析（与 Rust ai_parse_target_adjust 同规则镜像） ---------------- */

interface TargetFieldSpec {
  field: keyof DailyTargets
  label: string
  unit: string
  keywords: string[]
  min: number
  max: number
  roundStep: number
}

const TARGET_FIELD_SPECS: TargetFieldSpec[] = [
  { field: 'kcal', label: '能量', unit: '大卡', keywords: ['热量', '大卡', '千卡', '卡路里', 'kcal'], min: 800, max: 5000, roundStep: 10 },
  { field: 'protein', label: '蛋白质', unit: 'g', keywords: ['蛋白'], min: 20, max: 300, roundStep: 1 },
  { field: 'carb', label: '碳水', unit: 'g', keywords: ['碳水'], min: 50, max: 600, roundStep: 1 },
  { field: 'fat', label: '脂肪', unit: 'g', keywords: ['脂肪'], min: 20, max: 200, roundStep: 1 },
  { field: 'sodiumMg', label: '钠', unit: 'mg', keywords: ['钠', '盐'], min: 500, max: 5000, roundStep: 50 },
  { field: 'waterMl', label: '饮水', unit: 'ml', keywords: ['饮水', '喝水', '水'], min: 500, max: 5000, roundStep: 100 },
]

const UP_WORDS = ['提高', '提升', '增加', '上调', '多']
const DOWN_WORDS = ['降低', '降到', '减少', '下调', '少', '控制']
/** 方向词后紧跟这些字时按绝对目标理解（"降到1700"） */
const ABSOLUTE_PARTICLES = ['到', '为', '成', '至', '在']

function readTargetNumber(chars: string[], start: number): [value: number, end: number] | null {
  let i = start
  let seenDot = false
  while (i < chars.length && (/[\d]/.test(chars[i]!) || (chars[i] === '.' && !seenDot))) {
    if (chars[i] === '.') seenDot = true
    i += 1
  }
  if (i === start) return null
  return [Number(chars.slice(start, i).join('')), i]
}

function numberForward(chars: string[], from: number, skipLimit: number): [value: number, numStart: number] | null {
  const end = Math.min(chars.length, from + skipLimit)
  for (let i = from; i < end; i++) {
    if (/[\d]/.test(chars[i]!)) {
      const r = readTargetNumber(chars, i)
      return r && [r[0], i]
    }
  }
  return null
}

function numberBackward(chars: string[], before: number, window: number): [value: number, numStart: number] | null {
  const lo = Math.max(0, before - window)
  for (let i = before - 1; i >= lo; i--) {
    if (/[\d.]/.test(chars[i]!)) {
      let start = i
      while (start > 0 && /[\d.]/.test(chars[start - 1]!)) start -= 1
      const r = readTargetNumber(chars, start)
      return r && [r[0], start]
    }
  }
  return null
}

/** 数字前上下文：+1/-1 为增量，0 为绝对值语义 */
function directionBefore(chars: string[], numStart: number): number {
  const ctx = chars.slice(Math.max(0, numStart - 8), numStart).join('').replace(/\s+$/, '')
  if (ABSOLUTE_PARTICLES.includes(ctx.charAt(ctx.length - 1))) return 0
  if (UP_WORDS.some((w) => ctx.includes(w))) return 1
  if (DOWN_WORDS.some((w) => ctx.includes(w))) return -1
  return 0
}

function clampRoundTarget(v: number, spec: TargetFieldSpec): number {
  return Math.round(Math.min(spec.max, Math.max(spec.min, v)) / spec.roundStep) * spec.roundStep
}

export function parseTargetAdjustText(text: string, current: DailyTargets): TargetAdjustProposal {
  const chars = [...text.toLowerCase()]
  const proposal: DailyTargets = { ...current }
  const changes: TargetChange[] = []

  for (const spec of TARGET_FIELD_SPECS) {
    if (changes.some((c) => c.field === spec.field)) continue
    for (const kw of spec.keywords) {
      const pos = chars.join('').indexOf(kw)
      if (pos === -1) continue
      // 裸「水」排除「水果」等复合词
      if (kw === '水' && chars[pos + 1] === '果') continue

      const found = numberForward(chars, pos + [...kw].length, 6) ?? numberBackward(chars, pos, 6)
      if (!found) continue
      const [value, numStart] = found

      const sign = directionBefore(chars, numStart)
      const from = current[spec.field]
      const to =
        sign !== 0 ? clampRoundTarget(from + sign * value, spec) : clampRoundTarget(value, spec)
      if (to === from) continue
      proposal[spec.field] = to
      changes.push({ field: spec.field, label: spec.label, unit: spec.unit, from, to })
      break
    }
  }

  const reply =
    changes.length === 0
      ? '没有从这句话里识别出要调整的目标。可以这样说：「把热量降到 1800 大卡」「蛋白质提高到 130 克」。'
      : `已根据你的描述整理出 ${changes.length} 项目标调整，确认后立即生效。`
  return { targets: proposal, changes, reply }
}

/* ---- 模糊搜索（镜像 Rust `search_foods_fuzzy` 的打分算法） ---- */

function fuzzyNorm(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

function mockFuzzyScore(query: string, name: string): number {
  const qn = fuzzyNorm(query)
  const nn = fuzzyNorm(name)
  if (!qn) return 0
  if (qn === nn) return 100
  const qc = [...qn]
  const nc = [...nn]
  // LCS（保持顺序的最长公共子序列）
  const n = qc.length
  const m = nc.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = qc[i - 1] === nc[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const lcs = dp[n][m]
  if (!lcs) return 0
  const order = lcs / qc.length
  const len = Math.min(1, qc.length / nc.length)
  return Math.round((0.65 * order + 0.35 * len) * 100)
}

/** 简易 HTML → 纯文本（dev 环境镜像 Rust html2text 的粗粒度行为） */
function mockHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

async function mockWebFetch(url: string, maxChars: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })
    const html = await resp.text()
    const plain = mockHtmlToText(html)
    const chars = [...plain].length
    const truncated = chars > maxChars
    const text = truncated ? `${[...plain].slice(0, maxChars).join('')}\n\n…（内容已截断，如需更多请用更具体的关键词搜索）` : plain
    return {
      url: resp.url || url,
      contentType: resp.headers.get('content-type') ?? '',
      text,
      truncated,
      chars,
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- AI 内核（modules/ai/agent 同契约） ---------------- */

/** 浏览器 mock 的事件出口：agentService 在非 Tauri 环境把 onEvent 挂到这里 */
export const mockAgent: { onEvent: ((e: unknown) => void) | null } = { onEvent: null }

/** 浏览器 mock 的脚本化内核：e2e / 调试用 window.__REIN_MOCK_AGENT__ = { script } 覆盖 */
export interface MockAgentStep {
  thinking?: string
  text?: string
  /** 该步模型请求的工具（由前端壳执行并回传结果，与 Rust 桥接期同构） */
  tools?: { name: string; args?: unknown }[]
  /** 每个增量块之间的间隔（毫秒，默认 4）；e2e 需要观察中间态时调大 */
  chunkMs?: number
}

interface MockAgentRun {
  cancelled: boolean
  pending: Map<string, (outcome: { content: string; isError: boolean }) => void>
}

const mockAgentRuns = new Map<string, MockAgentRun>()

function mockAgentEmit(e: Record<string, unknown>): void {
  // e2e 观测：脚本设置 window.__REIN_MOCK_AGENT_LOG__ = [] 即可收到全部事件
  ;(
    window as unknown as { __REIN_MOCK_AGENT_LOG__?: Record<string, unknown>[] }
  ).__REIN_MOCK_AGENT_LOG__?.push({ ...e })
  mockAgent.onEvent?.({ ...e })
}

function mockAgentSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 默认脚本：一句说明性回复（不触网） */
function defaultAgentScript(): MockAgentStep[] {
  return [{ text: '（浏览器 mock）我是脚本化内核，没有调用真实模型。设置 window.__REIN_MOCK_AGENT__ 可以编排回复与工具。' }]
}

function splitChunks(text: string): string[] {
  if (text.length <= 3) return [text]
  const size = Math.max(1, Math.ceil(text.length / 4))
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function waitMockToolResult(run: MockAgentRun, callId: string, timeoutMs: number): Promise<{ content: string; isError: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      run.pending.delete(callId)
      resolve({ content: '工具执行超时（浏览器 mock）', isError: true })
    }, timeoutMs)
    run.pending.set(callId, (o) => {
      clearTimeout(timer)
      run.pending.delete(callId)
      resolve(o)
    })
  })
}

async function playMockRun(runId: string, script: MockAgentStep[]): Promise<void> {
  const run = mockAgentRuns.get(runId)
  if (!run) return
  let lastText = ''
  let lastThinking: string | null = null
  let toolCount = 0
  for (const step of script) {
    if (run.cancelled) return
    const chunkMs = step.chunkMs ?? 4
    if (step.thinking) {
      for (const c of splitChunks(step.thinking)) {
        if (run.cancelled) return
        mockAgentEmit({ type: 'thinkingDelta', runId, delta: c })
        await mockAgentSleep(chunkMs)
      }
      mockAgentEmit({ type: 'thinkingEnd', runId, content: step.thinking })
      lastThinking = step.thinking
    }
    if (step.text) {
      for (const c of splitChunks(step.text)) {
        if (run.cancelled) return
        mockAgentEmit({ type: 'textDelta', runId, delta: c })
        await mockAgentSleep(chunkMs)
      }
      lastText = step.text
    }
    for (const call of step.tools ?? []) {
      if (run.cancelled) return
      const callId = `mock-${Math.random().toString(36).slice(2, 10)}`
      toolCount += 1
      // 浏览器 mock 没有 Rust 内核：所有工具都由前端执行，故 kernel 恒为 false
      mockAgentEmit({ type: 'toolStarted', runId, callId, name: call.name, args: call.args ?? {}, kernel: false })
      const outcome = await waitMockToolResult(run, callId, 8000)
      if (run.cancelled) return
      mockAgentEmit({
        type: 'toolCompleted',
        runId,
        callId,
        name: call.name,
        isError: outcome.isError,
        content: outcome.content,
        kernel: false,
      })
      // 工具后文本重新起算（与内核一致：最终文本 = 最后一步的正文）
      lastText = ''
    }
  }
  if (run.cancelled) return
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
  mockAgentEmit({ type: 'usage', runId, usage })
  mockAgentEmit({
    type: 'done',
    runId,
    text: lastText,
    thinking: lastThinking,
    usage,
    stopReason: 'stop',
    steps: script.length,
    tools: toolCount,
    durationMs: 0,
  })
}

/* ---------------- 外部访问（对外服务网关，modules/gateway 同契约） ---------------- */

/**
 * 浏览器 mock 的事件出口：gatewayService 在非 Tauri 环境把订阅挂到这里
 * （真机的事件由 Rust 侧 `gateway://authorization-required` / `gateway://authorization-changed` /
 * 两条下行控制事件发出）。
 */
export const mockGateway: {
  onRequired: ((e: unknown) => void) | null
  onChanged: ((s: unknown) => void) | null
  onPomodoroCommand: ((c: unknown) => void) | null
  onSessionCommand: ((c: unknown) => void) | null
} = { onRequired: null, onChanged: null, onPomodoroCommand: null, onSessionCommand: null }

/** mock 的运行态快照：与真机 `app_meta:runtime.focus.v1` 同形（`focus_publish` 写它）。 */
let gwFocusRuntime: FocusRuntime | null = null

/** e2e / 调试入口：伪造一条外部下行控制（真机由 WS 方法经 AppHandle emit 发出）。 */
export function mockGatewayPomodoroCommand(cmd: GatewayPomodoroCommand): void {
  mockGateway.onPomodoroCommand?.(cmd)
}

export function mockGatewaySessionCommand(cmd: GatewaySessionCommand): void {
  mockGateway.onSessionCommand?.(cmd)
}

/** e2e / 调试入口：读回最近一次 `focus_publish` 的快照（真机由 `pomodoro.status` 读）。 */
export function mockGatewayFocusRuntime(): FocusRuntime | null {
  return gwFocusRuntime ? { ...gwFocusRuntime } : null
}

/**
 * 功能模块开关快照（真机落 `app_meta:gateway.enabledModules`）。
 * `null` = 前端还没推过 —— 与真机 `store::stored_modules` 同语义，**门禁按全放行处理**。
 * 浏览器里没有 WS 监听，所以这份快照在 mock 里只供 e2e 断言「前端确实推了、推的是谁」。
 */
let gwEnabledModules: string[] | null = null

/** e2e / 调试入口：读回最近一次 `gateway_set_enabled_modules` 的快照（`null` = 从未推过）。 */
export function mockGatewayEnabledModules(): string[] | null {
  return gwEnabledModules ? [...gwEnabledModules] : null
}

/** 清洗一份模块快照：去空白、去重（保序）—— 与 Rust `normalize_modules_lossy` 同语义。 */
function normalizeModules(ids: unknown): string[] {
  const out: string[] = []
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw).trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 演示态：默认关（与真机一致 —— 用户开了才监听）。字段与 `GatewayStatus` 同形。 */
const gwState: GatewayStatus = {
  enabled: false,
  bindMode: 'local',
  port: null,
  pairToken: null,
  pendingCount: 0,
  clients: [],
  blocked: [],
  allowedOrigins: [],
  blockedOrigins: [],
}
const gwPending: GatewayAuthRequest[] = []

/**
 * 用户批准过的网页来源（Origin）白名单 —— 与真机的 `app_meta` 键
 * `gateway.allowedOrigins` 同语义：整表替换、精确匹配、`file://` 的 Origin 就是字面量 `"null"`。
 */
let gwAllowedOrigins: string[] = []

/** 审计流水（与 `ext_audit` 同形；真机落库，mock 只在内存里留最近的）。 */
interface MockGatewayAudit {
  id: number
  at: string
  clientId: string | null
  method: string
  scope: string
  decision: 'allowed' | 'denied' | 'error'
  detail: string | null
  ip: string | null
  durationMs: number
}
const gwAudit: MockGatewayAudit[] = []
let gwAuditSeq = 0

/** 与 Rust `store::ORIGIN_BLOCKED_PREFIX` 同一串（被 Origin 闸门拒的审计详情前缀）。 */
const gwOriginRejectedPrefix = '浏览器来源未在白名单：'

function gwAuditPush(rec: Omit<MockGatewayAudit, 'id' | 'at'>): void {
  gwAudit.unshift({ id: ++gwAuditSeq, at: new Date().toISOString(), ...rec })
  if (gwAudit.length > 200) gwAudit.length = 200
}

/** 「被拦下的来源」：与真机一样从审计反解 —— 列被拒过且尚未加白的 Origin（去重、最近优先）。 */
function gwBlockedOrigins(): string[] {
  const allowed = new Set(gwAllowedOrigins)
  const out: string[] = []
  for (const r of gwAudit) {
    const origin = r.detail?.startsWith(gwOriginRejectedPrefix) ? r.detail.slice(gwOriginRejectedPrefix.length) : ''
    if (origin && !allowed.has(origin) && !out.includes(origin)) out.push(origin)
  }
  return out
}

function gwStatus(): GatewayStatus {
  return {
    ...gwState,
    pendingCount: gwPending.length,
    clients: gwState.clients.map((c) => ({ ...c })),
    blocked: gwState.blocked.map((b) => ({ ...b })),
    // 真机靠 `build_status` 从 app_meta / 审计读这两列；mock 同口径。
    allowedOrigins: [...gwAllowedOrigins],
    blockedOrigins: gwBlockedOrigins(),
  }
}

/** 真机每次改动都发 changed；mock 照发，设置页因此不必轮询。 */
function gwChanged(): void {
  mockGateway.onChanged?.(gwStatus())
}

/** e2e / 调试入口：伪造一条待裁决的授权请求（可选覆盖字段）；窗口上留了同名钩子。 */
export function mockGatewayPrompt(patch: Partial<GatewayAuthRequest> = {}): void {
  const req: GatewayAuthRequest = {
    requestId: `mock-req-${gwPending.length + 1}`,
    clientId: 'mock-client-1',
    clientName: '（mock）外部程序',
    origin: null,
    ip: '127.0.0.1',
    scopes: ['schedule.read'],
    createdAt: new Date().toISOString(),
    timeoutMs: 60000,
    ...patch,
  }
  gwPending.push(req)
  mockGateway.onRequired?.(req)
}

/** e2e / 调试入口：造一条「来源被 Origin 闸门拦下」的审计（真机由握手 403 落审计）。 */
export function mockGatewayBlockedOrigin(origin: string, ip = '127.0.0.1'): void {
  gwAuditPush({
    clientId: null,
    method: '',
    scope: '',
    decision: 'denied',
    detail: `${gwOriginRejectedPrefix}${origin}`,
    ip,
    durationMs: 0,
  })
  gwChanged()
}

if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __REIN_MOCK_GATEWAY_PROMPT__?: (patch?: Partial<GatewayAuthRequest>) => void
    __REIN_MOCK_GATEWAY_BLOCKED_ORIGIN__?: (origin: string, ip?: string) => void
    __REIN_MOCK_GATEWAY_POMODORO__?: (cmd: GatewayPomodoroCommand) => void
    __REIN_MOCK_GATEWAY_SESSION__?: (cmd: GatewaySessionCommand) => void
    __REIN_MOCK_GATEWAY_FOCUS__?: () => FocusRuntime | null
  }
  w.__REIN_MOCK_GATEWAY_PROMPT__ = mockGatewayPrompt
  w.__REIN_MOCK_GATEWAY_BLOCKED_ORIGIN__ = mockGatewayBlockedOrigin
  w.__REIN_MOCK_GATEWAY_POMODORO__ = mockGatewayPomodoroCommand
  w.__REIN_MOCK_GATEWAY_SESSION__ = mockGatewaySessionCommand
  w.__REIN_MOCK_GATEWAY_FOCUS__ = mockGatewayFocusRuntime
}

/* ---------------- 语音对话（modules/voice 同契约） ---------------- */

/** 浏览器 mock 的事件出口：voiceService 在非 Tauri 环境把 onAsr 挂到这里 */
export const mockVoice: { onAsr: ((e: unknown) => void) | null } = { onAsr: null }

interface MockVoiceConfig {
  mode: 'legacy' | 'new'
  appKey: string
  accessKey: string
  asrAdapter: string
  asrAdapterUserPicked: boolean
  asrBaseUrl: string
  ttsCredential: { mode: 'legacy' | 'new'; appKey: string; accessKey: string } | null
  asrResourceId: string
  ttsResourceId: string
  voiceName: string
  speed: number
}

let voiceConfig: MockVoiceConfig = {
  mode: 'legacy',
  appKey: '',
  accessKey: '',
  asrAdapter: 'auto',
  asrAdapterUserPicked: false,
  asrBaseUrl: '',
  ttsCredential: null,
  asrResourceId: 'volc.seedasr.sauc.duration',
  ttsResourceId: 'seed-tts-2.0',
  voiceName: '',
  speed: 1,
}

interface MockMemo {
  id: string
  chatId: string
  messageId: string | null
  title: string
  audioPath: string | null
  durationMs: number
  words: number
  sentences: unknown
  summary: unknown
  createdAt: string
}

const voiceMemos: MockMemo[] = []
let voiceDraft: unknown = null

/** 伪造识别会话：按脚本节奏发 partial/final 事件（e2e 与 UI 迭代用） */
// 时间压缩到 ~3.4s（mock 仅供 dev/e2e；真实节奏由服务端决定）
const MOCK_SENTENCES = [
  { startMs: 300, endMs: 700, text: '今天中午在公司楼下吃的，一个鸡胸肉汉堡，没喝可乐，加了杯无糖的。' },
  { startMs: 900, endMs: 1400, text: '对了，下午三点提醒我去拿快递，别忘记了。' },
  { startMs: 1600, endMs: 2500, text: '昨天练完腿，今天大腿前侧有点酸，晚上就不安排力量了，改成拉伸十五分钟。' },
  { startMs: 2700, endMs: 3200, text: '还有，帮我看看这个月外卖花了多少。' },
]

const voiceTimers = new Map<string, number[]>()
/** 已 final 的句子下标（finish 补发时去重） */
const voiceFinaled = new Map<string, Set<number>>()

function clearVoiceTimers(sessionId: string): void {
  const ids = voiceTimers.get(sessionId)
  if (ids) {
    for (const id of ids) clearTimeout(id)
    voiceTimers.delete(sessionId)
  }
}

function mockWavDataUrl(): string {
  const sampleRate = 16000
  const dataLen = sampleRate * 2 // 1s 静音
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const w = (off: number, str: string): void => {
    for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, dataLen, true)
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)))
  }
  return 'data:audio/wav;base64,' + btoa(bin)
}

/* ---------- 知识库与长期记忆（对应 Rust modules/kb）----------
 * 浏览器里没有 SQLite，所以这里用一份内存文档表模拟索引结果：
 * 首次访问时把各 mock 数据源扫一遍建成 kbDocs，之后 kb_memory_apply 等写入会顺带更新它。
 * 检索是 includes() 关键词匹配（真实实现是 FTS5 trigram + 向量 + RRF），
 * 形状与召回阶梯刻意保持一致（fts/like/fuzzy），这样 e2e 断言能复用。 */

interface MockKbDoc {
  id: number
  sourceType: string
  sourceId: string
  path: string | null
  editable: boolean
  system: boolean
  kind: 'text' | 'image' | 'file' | 'audio' | 'video' | 'folder'
  parentId: string | null
  title: string
  summary: string
  body: string
  occurredOn: string | null
  tags: string[]
  updatedAt: string
}

/** 文件节点（kb_files）：文本笔记 / 多模态节点 / 目录（ai-workspace §1） */
interface MockKbFile {
  id: number
  path: string
  content: string
  system: boolean
  kind: 'text' | 'multimodal' | 'folder'
  pinned: boolean
  classifyState: 'inbox' | 'filed' | 'manual'
  createdAt: string
  updatedAt: string
  /** 删除时间（非空 = 在回收站里）。与 Rust kb_files.trashed_at 对应 */
  trashedAt?: string | null
  /** 删除前的位置（恢复的目标）。与 Rust kb_files.trash_from 对应 */
  trashFrom?: string | null
  /** 用户评分 0..5（0 = 未评） */
  rating?: number
  /** 用户标签（JSON 数组字符串，与 Rust 列同形） */
  tags?: string
  /** 用户注释 */
  note?: string
}

/** 模态表示（kb_assets）。浏览器 mock 无法落盘，本体一律以内联 data URL 存在 ref 里 */
interface MockKbAsset {
  id: number
  fileId: number
  modal: 'text' | 'image' | 'audio' | 'video' | 'binary'
  mime: string
  ref: string
  bytes: number
  durationMs: number | null
  transcriptState: 'none' | 'pending' | 'done' | 'failed'
  derivedFrom: string | null
  createdAt: string
}

/** 整理审计（kb_fs_moves，ai-workspace §3.3） */
interface MockKbFsMove {
  id: number
  batchId: string
  source: string
  op: string
  pathFrom: string
  pathTo: string
  reason: string
  at: string
  undone: boolean
}

/** 路径净化：与 Rust source::sanitize 同一条规则（docs/kb-vfs.md §2） */
function kbSanitize(raw: string, max: number): string {
  const bad = /[/\\:*?"<>|\n\r\t]/
  let out = ''
  for (const ch of raw.trim()) {
    if (out.length >= max) break
    out += bad.test(ch) ? '-' : ch
  }
  const t = out.trim().replace(/^-+|-+$/g, '')
  return t || '未命名'
}

/** 系统命名空间（只读，ai-workspace §3.2） */
const KB_SYSTEM_ROOTS = ['规范', '系统提示词']
/** 知识区（可直接写的根） */
const KB_WRITABLE_ROOTS = ['笔记', '文档', '用户记忆', '未分类数据', '语音', '视频']
/** 投影区（派生文档所在的领域根；目录内保留区之外仍可写） */
const KB_DOMAIN_ROOTS = [
  '日程', '运动', '饮食', '体测', '课程', '食物', '方案', '菜单', '对话', '附件', '记忆', '纪要',
]

const kbKnownRoot = (seg: string): boolean =>
  KB_WRITABLE_ROOTS.includes(seg) || KB_DOMAIN_ROOTS.includes(seg)

/** 把用户给的路径归位成合法路径（与 Rust files::normalize_path 同构）。
 *  `dirLike`：目录不补扩展名；文件只在**末段完全没有点**时补 .md
 *  （否则把 `晨会录音.wav` 改成 `晨会录音.wav.md`，扩展名就废了）。 */
function kbNormalizePath(raw: string, dirLike = false): string {
  let p = raw.trim().replace(/^\/+/, '')
  if (!p) throw new Error('文件路径不能为空')
  if (p.split('/').some((seg) => seg === '..')) throw new Error(`路径不允许包含 ..：${p}`)
  const first = p.split('/')[0] ?? ''
  if (KB_SYSTEM_ROOTS.includes(first)) {
    throw new Error(`${first}/ 是系统命名空间，只能由应用更新，不能由用户写入`)
  }
  if (!kbKnownRoot(first)) p = `笔记/${p}`
  p = p
    .split('/')
    .filter(Boolean)
    .map((seg) => kbSanitize(seg, 60))
    .join('/')
  if (dirLike) return p
  if (p.endsWith('.md')) return p
  const last = p.split('/').pop() ?? p
  return last.includes('.') ? p : `${p}.md`
}

/** 媒体路径归位：保留扩展名，裸路径默认落收件箱（与 Rust files::normalize_media_path 同构） */
function kbNormalizeMediaPath(raw: string, name: string): string {
  const p = raw.trim().replace(/^\/+/, '')
  if (p.split('/').some((seg) => seg === '..')) throw new Error(`路径不允许包含 ..：${p}`)
  const safeName = kbSanitize(name, 60)
  const last = p.split('/').pop() ?? ''
  let dir: string
  let base = safeName
  if (last.includes('.')) {
    const cut = p.lastIndexOf('/')
    dir = cut >= 0 ? p.slice(0, cut) : ''
    base = kbSanitize(last, 60)
  } else {
    dir = p
  }
  if (dir) {
    const first = dir.split('/')[0] ?? ''
    if (KB_SYSTEM_ROOTS.includes(first)) {
      throw new Error(`${first}/ 是系统命名空间，只能由应用更新，不能由用户写入`)
    }
    if (!kbKnownRoot(first)) dir = `未分类数据/${kbSanitize(dir, 60)}`
  } else {
    dir = '未分类数据'
  }
  dir = dir
    .split('/')
    .filter(Boolean)
    .map((seg) => kbSanitize(seg, 60))
    .join('/')
  return dir ? `${dir}/${base}` : base
}

/** 保留区判定（与 Rust governance::is_reserved_path 同构）：
 *  `附件/` 全树、日期目录、以及**领域目录下**的 `-数字` 后缀；知识区的正常名字不受限。 */
function kbIsReservedPath(path: string): boolean {
  const segs = path.split('/').filter(Boolean)
  if (!segs.length) return true
  if (segs[0] === '附件') return true
  if (segs.some((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) return true
  if (!KB_DOMAIN_ROOTS.includes(segs[0])) return false
  const file = segs[segs.length - 1] ?? ''
  const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file
  const tail = stem.includes('-') ? stem.slice(stem.lastIndexOf('-') + 1) : ''
  return tail.length > 0 && /^\d+$/.test(tail)
}

/** 保留目录整体让位（与 Rust governance::safe_dir 同构）：
 *  日期目录 → `{日期}-用户/`；`附件/` 整树是编目 → 改投收件箱。 */
function kbSafeDir(dir: string): string {
  const segs = dir.split('/').filter(Boolean)
  if (segs[0] === '附件') return '未分类数据'
  return segs.map((seg) => (/^\d{4}-\d{2}-\d{2}$/.test(seg) ? `${seg}-用户` : seg)).join('/')
}

/** 在 dir 下为 basename 找一个自由路径（保留区 / 已占用都加 -v2 后缀） */
function kbFreePath(dir: string, basename: string): string {
  const d = kbSafeDir(dir.trim().replace(/^\/+|\/+$/g, ''))
  const cut = basename.lastIndexOf('.')
  const stem = cut > 0 ? basename.slice(0, cut) : basename
  const ext = cut > 0 ? basename.slice(cut) : ''
  for (let i = 0; i < 64; i++) {
    const name = i === 0 ? basename : `${stem}-v${i + 1}${ext}`
    const path = d ? `${d}/${name}` : name
    if (KB_SYSTEM_ROOTS.includes(path.split('/')[0] ?? '')) throw new Error(`${path} 在系统命名空间，只读`)
    if (kbIsReservedPath(path)) continue
    const taken = kbFiles.some((f) => f.path === path) || kbDocs.some((doc) => doc.path === path)
    if (!taken) return path
  }
  throw new Error(`在 ${d}/ 下找不到可用文件名（${basename}）`)
}

/** 解压产物让位：保留包内层级，只对最后一段加 `-v2`（对齐 Rust archive::free_child_path）。 */
function kbFreeChildPath(dir: string, inner: string): string {
  const parts = inner.split('/')
  const base = parts.pop() ?? inner
  const prefix = parts.join('/')
  const cut = base.lastIndexOf('.')
  const stem = cut > 0 ? base.slice(0, cut) : base
  const ext = cut > 0 ? base.slice(cut) : ''
  for (let i = 0; i < 64; i++) {
    const name = i === 0 ? base : `${stem}-v${i + 1}${ext}`
    const path = prefix ? `${dir}/${prefix}/${name}` : `${dir}/${name}`
    const taken = kbFiles.some((f) => f.path === path) || kbDocs.some((d) => d.path === path)
    if (!taken) return path
  }
  throw new Error(`${dir}/ 下同名文件过多：${inner}`)
}

/** 解压落点目录让位：同名目录已存在就 `-2`、`-3`……（对齐 Rust archive::free_dir，绝不覆盖） */
function kbFreeDir(dir: string): string {
  for (let i = 0; i < 64; i++) {
    const cand = i === 0 ? dir : `${dir}-${i + 1}`
    const occupied =
      kbFiles.some((f) => f.path === cand || f.path.startsWith(`${cand}/`)) ||
      kbDocs.some((d) => d.path === cand || (d.path ?? '').startsWith(`${cand}/`))
    if (!occupied) return cand
  }
  throw new Error(`找不到可用目录名：${dir}`)
}

/** 标签列解析：坏数据当空表（与 Rust files::parse_tags 同语义） */
function kbParseTags(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 与 Rust chunk_text 同参数的简化分块（300 字 / 50 重叠），供 L2 分页与 totalChunks */
function kbChunkText(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  if (normalized.length <= 300) return [normalized]
  const out: string[] = []
  let start = 0
  while (start < normalized.length) {
    const end = Math.min(start + 300, normalized.length)
    const piece = normalized.slice(start, end).trim()
    if (piece) out.push(piece)
    if (end >= normalized.length) break
    const next = Math.max(end - 50, start + 1)
    start = next
  }
  return out
}

/** note 源正文进检索缓存的上限（对应 Rust source.rs MAX_BODY = 8000）。
 *  缓存截断只影响召回；阅读（kb_read）必须直读 kb_files 真源给全文，见 kb_read 的 note 特判。 */
const KB_BODY_CAP = 8000
const kbCacheBody = (content: string) =>
  content.length <= KB_BODY_CAP ? content : `${content.slice(0, KB_BODY_CAP)}…`

interface MockKbMemory {
  id: number
  memType: string
  topic: string
  /** 分层分类路径（如 健康/训练），可为空 */
  category: string
  content: string
  confidence: number
  activeCount: number
  sourceChatId: string | null
  createdAt: string
  updatedAt: string
  /** 最近一次注入时间（衰减计时起点） */
  lastUsedAt: string | null
  /** 归档时间（软删除）；非空 = 不进注入与检索 */
  archivedAt: string | null
  archivedReason: string | null
}

/** 显著性半衰期（天），与 Rust memory.rs 的 SALIENCE_HALF_LIFE_DAYS 对齐 */
const KB_SALIENCE_HALF_LIFE_DAYS = 14
/** 低信号阈值，与 Rust memory.rs 的 STALE_SALIENCE 对齐 */
const KB_STALE_SALIENCE = 0.15
/** 自动归档判定，与 Rust memory.rs 对齐 */
const KB_NEVER_USED_PRUNE_DAYS = 30
const KB_STALE_PRUNE_DAYS = 45

/** 显著性 = 置信度 × 时间衰减 × 使用强化（读时计算，不落库存） */
function kbSalience(m: MockKbMemory): number {
  const since = Date.parse(m.lastUsedAt ?? m.updatedAt ?? m.createdAt)
  const idleDays = Number.isFinite(since) ? Math.max(0, (Date.now() - since) / 86_400_000) : 0
  const decay = 0.5 ** (idleDays / KB_SALIENCE_HALF_LIFE_DAYS)
  const reinforcement = 1 + Math.log(1 + m.activeCount) / 4
  return m.confidence * decay * reinforcement
}

function kbIdleDays(m: MockKbMemory): number {
  const since = Date.parse(m.lastUsedAt ?? m.updatedAt ?? m.createdAt)
  return Number.isFinite(since) ? Math.max(0, (Date.now() - since) / 86_400_000) : 0
}

/** 记忆类型 → 中文标签（与 Rust source.rs::mem_type_label 对齐） */
const KB_MEMORY_TYPE_LABELS: Record<string, string> = {
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  entity: '实体',
  profile: '画像',
  pattern: '规律',
}

/** 认知块的一行：`- [类型·分类] 内容`（与 Rust cognition_line 同构） */
function kbCognitionLine(m: MockKbMemory): string {
  const label = m.category
    ? `${KB_MEMORY_TYPE_LABELS[m.memType] ?? m.memType}·${m.category}`
    : (KB_MEMORY_TYPE_LABELS[m.memType] ?? m.memType)
  return `- [${label}] ${m.content.trim()}`
}

/** 从编目里摘掉某条记忆的文档（归档/删除共用） */
function kbDropMemoryDoc(id: number): void {
  const di = kbDocs.findIndex((d) => d.sourceType === 'memory' && d.sourceId === String(id))
  if (di >= 0) kbDocs.splice(di, 1)
}

// 规范文件内容与 src-tauri 的 include_str! 同源（docs/kb-vfs.md），浏览器 mock 也读同一份
import specMarkdown from '../../docs/kb-vfs.md?raw'

const KB_SETTINGS_KEY = 'rein.mock.kb_settings.v1'
const KB_MEMORY_KEY = 'rein.mock.kb_memories.v1'
const KB_FILE_KEY = 'rein.mock.kb_files.v1'
const KB_ASSET_KEY = 'rein.mock.kb_assets.v1'
const KB_MOVE_KEY = 'rein.mock.kb_fs_moves.v1'
const KB_SPEC_PATH = '规范/知识库规范.md'
/** 注入预算（与 Rust injection::BUDGET_CHARS 对齐） */
const KB_INJECT_BUDGET = 12000

const kbDocs: MockKbDoc[] = []
let kbDocId = 0
const kbMemories: MockKbMemory[] = []
let kbMemoryId = 0
const kbFiles: MockKbFile[] = []
let kbFileId = 0

/* ---------- 多设备同步：内存态 ----------
   起手就带一台已配对设备 + 一次同步记录：浏览器里一打开就能看到完整形态
   （设备列表、路径标签、「上次走的是哪条路」那一行）；点「开码」走的是真实配对流程，
   点「解除」会把这台摘掉、回到空态。路径每次点同步就换一条（lan → punch → relay）。 */
const syncMock = {
  name: '浏览器调试设备',
  objects: 137,
  conflicts: 2,
  peers: [
    {
      device: 'mock-peer-0000-0000-0000-000000000002',
      short: 'mock-pee',
      name: 'iPad（模拟）',
      fingerprint: 'MOCK-1111-1111',
      path: 'punch',
      lastSeen: Date.now() - 42 * 60 * 1000,
      seqSent: 12,
      seqAck: 12,
    },
  ] as Record<string, unknown>[],
  lastAt: Date.now() - 42 * 60 * 1000,
  lastPath: 'punch' as string | null,
  lastUp: 5120,
  lastDown: 262144,
  runCount: 1,
}

const SYNC_MOCK_PATHS = ['lan', 'punch', 'relay'] as const

const syncMockPeer = (): Record<string, unknown> => ({
  device: 'mock-peer-0000-0000-0000-000000000002',
  short: 'mock-pee',
  name: '另一台设备（模拟）',
  fingerprint: 'MOCK-1111-1111',
  path: syncMock.lastPath,
  lastSeen: syncMock.lastAt,
  seqSent: 12,
  seqAck: 12,
})

const syncMockStatus = (): Record<string, unknown> => ({
  deviceId: 'mock-device-0000-0000-0000-000000000001',
  deviceShort: 'mock-dev',
  deviceName: syncMock.name,
  fingerprint: 'MOCK-0000-0000',
  inGroup: syncMock.peers.length > 0,
  groupId: syncMock.peers.length > 0 ? 'mock-room' : null,
  peers: syncMock.peers,
  objects: syncMock.objects,
  tombstones: 3,
  logLen: syncMock.objects + 3,
  pending: 0,
  staleTables: 0,
  conflicts: syncMock.conflicts,
  lastAt: syncMock.lastAt,
  lastPath: syncMock.lastPath,
  lastUp: syncMock.lastUp,
  lastDown: syncMock.lastDown,
})

const syncMockPair = (): void => {
  if (!syncMock.peers.some((p) => p.device === 'mock-peer-0000-0000-0000-000000000002')) {
    syncMock.peers.push(syncMockPeer())
  }
}
const kbAssets: MockKbAsset[] = []
let kbAssetId = 0
const kbMoves: MockKbFsMove[] = []
let kbMoveId = 0
let kbIndexed = false
/** 记忆变更审计（对齐 Rust kb_memory_diffs；只存最近 20 条，不落 localStorage 之外的地方） */
const mockMemoryDiffs: Array<{ at: string; payload: Record<string, unknown> }> = []
const KB_DIFF_KEY = 'rein.mock.kb_memory_diffs.v1'

function saveMockMemoryDiffs(): void {
  try {
    localStorage.setItem(KB_DIFF_KEY, JSON.stringify(mockMemoryDiffs))
  } catch {
    /* 忽略 */
  }
}

function loadMockMemoryDiffs(): void {
  if (mockMemoryDiffs.length) return
  try {
    const raw = localStorage.getItem(KB_DIFF_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    // localStorage 是外部可写的：形状不对就当没有。页面直接读 at/payload，
    // 塞进非对象数组会在渲染期抛错（那个报错离根因很远，很难查）
    if (!Array.isArray(parsed)) return
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const at = (row as { at?: unknown }).at
      const payload = (row as { payload?: unknown }).payload
      if (typeof at === 'string' && payload && typeof payload === 'object') {
        mockMemoryDiffs.push(row as (typeof mockMemoryDiffs)[number])
      }
    }
  } catch {
    /* 忽略 */
  }
}

let kbSettings: {
  embeddingMode: 'keyword' | 'local' | 'cloud'
  localModel: string
  cloudBaseUrl: string | null
  cloudApiKey: string | null
  cloudModel: string | null
  cloudDim: number | null
  sourcesEnabled: Record<string, boolean>
  autoMemory: boolean
  autoConsolidate: boolean
  lastConsolidateAt: string | null
  lastMaintainAt: string | null
  lastError: string | null
  updatedAt: string
} = {
  embeddingMode: 'keyword',
  localModel: 'bge-small-zh-v1.5-int8',
  cloudBaseUrl: null,
  cloudApiKey: null,
  cloudModel: null,
  cloudDim: null,
  sourcesEnabled: {},
  autoMemory: true,
  autoConsolidate: true,
  lastConsolidateAt: null,
  lastMaintainAt: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
}

let kbLoaded = false

function loadKbStore(): void {
  if (kbLoaded) return
  kbLoaded = true
  try {
    const raw = localStorage.getItem(KB_SETTINGS_KEY)
    if (raw) kbSettings = { ...kbSettings, ...(JSON.parse(raw) as typeof kbSettings) }
    const mem = localStorage.getItem(KB_MEMORY_KEY)
    if (mem) {
      const list = JSON.parse(mem) as MockKbMemory[]
      kbMemories.push(
        ...list.map((m) => ({
          ...m,
          // 老版本没有生命周期字段：补默认值，避免 undefined 渗进界面
          category: m.category ?? '',
          lastUsedAt: m.lastUsedAt ?? null,
          archivedAt: m.archivedAt ?? null,
          archivedReason: m.archivedReason ?? null,
        })),
      )
      kbMemoryId = Math.max(kbMemoryId, ...list.map((m) => m.id), 0)
    }
    const f = localStorage.getItem(KB_FILE_KEY)
    if (f) {
      const list = JSON.parse(f) as MockKbFile[]
      kbFiles.push(
        ...list.map((x) => ({
          ...x,
          // 老版本只存了 path/content/system：补上 v2 字段
          kind: x.kind ?? 'text',
          pinned: x.pinned ?? false,
          classifyState: x.classifyState ?? 'manual',
          rating: x.rating ?? 0,
          tags: x.tags ?? '[]',
          note: x.note ?? '',
        })),
      )
      kbFileId = Math.max(kbFileId, ...list.map((x) => x.id), 0)
    }
    const a = localStorage.getItem(KB_ASSET_KEY)
    if (a) {
      const list = JSON.parse(a) as MockKbAsset[]
      kbAssets.push(...list.map((x) => ({ ...x, derivedFrom: x.derivedFrom ?? null })))
      kbAssetId = Math.max(kbAssetId, ...list.map((x) => x.id), 0)
    }
    const mv = localStorage.getItem(KB_MOVE_KEY)
    if (mv) {
      const list = JSON.parse(mv) as MockKbFsMove[]
      kbMoves.push(...list)
      kbMoveId = Math.max(kbMoveId, ...list.map((x) => x.id), 0)
    }
  } catch {
    /* 损坏数据按空处理 */
  }
}

function saveKbSettings(): void {
  try {
    localStorage.setItem(KB_SETTINGS_KEY, JSON.stringify(kbSettings))
  } catch {
    /* 忽略 */
  }
}

function saveKbMemories(): void {
  try {
    localStorage.setItem(KB_MEMORY_KEY, JSON.stringify(kbMemories))
  } catch {
    /* 忽略 */
  }
}

function saveKbFiles(): void {
  try {
    localStorage.setItem(KB_FILE_KEY, JSON.stringify(kbFiles))
  } catch {
    /* 忽略 */
  }
}

function saveKbAssets(): void {
  try {
    localStorage.setItem(KB_ASSET_KEY, JSON.stringify(kbAssets))
  } catch {
    /* 忽略 */
  }
}

function saveKbMoves(): void {
  try {
    localStorage.setItem(KB_MOVE_KEY, JSON.stringify(kbMoves))
  } catch {
    /* 忽略 */
  }
}

loadKbStore()

function kbUpsertDoc(
  sourceType: string,
  sourceId: string,
  title: string,
  body: string,
  occurredOn: string | null,
  tags: string[] = [],
  vfs: { path?: string | null; editable?: boolean; system?: boolean; kind?: MockKbDoc['kind']; parentId?: string | null } = {},
): void {
  const summary = body.trim().split(/[。！？\n]/)[0]?.slice(0, 120) ?? ''
  const existing = kbDocs.find((d) => d.sourceType === sourceType && d.sourceId === sourceId)
  if (existing) {
    Object.assign(existing, {
      title, summary, body, occurredOn, tags,
      path: vfs.path ?? existing.path,
      editable: vfs.editable ?? existing.editable,
      system: vfs.system ?? existing.system,
      kind: vfs.kind ?? existing.kind,
      parentId: vfs.parentId ?? existing.parentId,
      updatedAt: new Date().toISOString(),
    })
    return
  }
  kbDocs.push({
    id: ++kbDocId,
    sourceType,
    sourceId,
    path: vfs.path ?? null,
    editable: vfs.editable ?? false,
    system: vfs.system ?? false,
    kind: vfs.kind ?? 'text',
    parentId: vfs.parentId ?? null,
    title,
    summary,
    body,
    occurredOn,
    tags,
    updatedAt: new Date().toISOString(),
  })
}

/** 系统提示词与用户记忆模板（与 Rust files.rs 的常量同源，改一处要改两处） */
const KB_PROMPT_FILES: Record<string, string> = {
  '系统提示词/角色与语气.md': [
    '# 角色与语气',
    '',
    '- 你是 Rein AI：Rein 健康生活应用的内置助手，用户的数据与文件都在你的虚拟工作区里。',
    '- 用简体中文，语气自然亲切；直接给结论，不复述用户已知的信息。',
    '- 能用工具查到的事不要反问用户；需要决策时给两三个具体选项。',
    '',
  ].join('\n'),
  '系统提示词/工作区约定.md': [
    '# 工作区约定',
    '',
    '- 目录里的派生文档是应用数据的只读投影：要改内容就改源数据，直接改文件会被重放覆盖。',
    '- 可写：笔记/、文档/、未分类数据/、语音/、视频/、用户记忆/ 与各领域目录的用户子目录；系统区只读。',
    '- 新内容先落 未分类数据/，再用 classify_move 归类并写清 reason；被 pin 的文件不要动。',
    '- 文件可以有多种模态：需要原件时用 read_modal，音频/视频可能返回降级文本。',
    '',
  ].join('\n'),
}
const KB_MEMORY_TPLS: Record<string, string> = {
  '用户记忆/角色设定.md': '<!-- 角色设定：AI 该怎么称呼你、用什么语气、注意什么。有内容时每轮自动注入。 -->',
  '用户记忆/全局规范.md': '<!-- 全局规范：你希望 AI 始终遵守的规则。有内容时每轮自动注入。 -->',
}

/** 播种系统文件与默认目录（幂等，对应 Rust files::ensure_system_files） */
function kbEnsureSystemFiles(): void {
  const now = new Date().toISOString()
  const seed = (path: string, content: string, system: boolean): void => {
    const have = kbFiles.find((f) => f.path === path)
    if (have) {
      if (system && have.content !== content) {
        have.content = content
        have.updatedAt = now
      }
      return
    }
    kbFiles.push({
      id: ++kbFileId,
      path,
      content,
      system,
      kind: 'text',
      pinned: false,
      classifyState: 'manual',
      createdAt: now,
      updatedAt: now,
    })
  }

  seed(KB_SPEC_PATH, specMarkdown, true)
  for (const [path, content] of Object.entries(KB_PROMPT_FILES)) seed(path, content, true)
  // 用户记忆模板只在缺失时建，绝不覆盖用户编辑
  for (const [path, content] of Object.entries(KB_MEMORY_TPLS)) seed(path, content, false)
  // 收件箱目录：让默认树完整可见
  if (!kbFiles.some((f) => f.path === '未分类数据')) {
    kbFiles.push({
      id: ++kbFileId,
      path: '未分类数据',
      content: '【目录】未分类数据',
      system: false,
      kind: 'folder',
      pinned: false,
      classifyState: 'inbox',
      createdAt: now,
      updatedAt: now,
    })
  }
  saveKbFiles()
}

/* ---------- 模态层 / 目录治理 / 注入区的 mock 辅助（对应 Rust assets/governance/injection） ---------- */

const KB_MODAL_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  binary: '文件',
}

function kbModalOfMime(mime: string): MockKbAsset['modal'] {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('text/') || m.includes('json') || m.includes('markdown')) return 'text'
  return 'binary'
}

function kbMimeOfName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
    mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
    pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

function primaryModalKind(fileId: number): MockKbDoc['kind'] {
  const modals = kbAssets.filter((a) => a.fileId === fileId).map((a) => a.modal)
  if (modals.includes('video')) return 'video'
  if (modals.includes('audio')) return 'audio'
  if (modals.includes('image')) return 'image'
  return 'file'
}

/**
 * 浏览器 mock 的伪嵌入：字符三元组哈希到 512 维再 L2 归一化。
 * **不是真模型**（没有 ONNX 可用），但确定性、同义改写会共享大量三元组，
 * 所以相似度排序有真实意义 —— 界面与 e2e 能验证交互，模型质量本身必须在真机看。
 */
function mockEmbed(text: string, dim = 512): number[] {
  const v = new Array<number>(dim).fill(0)
  const chars = [...text.replace(/\s+/g, '')]
  if (!chars.length) return v
  const feed = (s: string): void => {
    let h = 2166136261
    for (const ch of s) {
      h ^= ch.codePointAt(0) ?? 0
      h = Math.imul(h, 16777619) >>> 0
    }
    v[h % dim] += 1
  }
  for (const ch of chars) feed(ch)
  for (let i = 0; i + 1 < chars.length; i++) feed(chars[i] + chars[i + 1])
  for (let i = 0; i + 2 < chars.length; i++) feed(chars[i] + chars[i + 1] + chars[i + 2])
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map((x) => x / norm) : v
}

/** 查重扫描的记忆条数上限（与 Rust memory::DUP_SCAN_LIMIT 一致） */
const DUP_SCAN_LIMIT = 400

/** 记忆向量缓存：内容没变就不重算（查重在页面挂载与每轮整理都会被调用） */
const mockMemVecCache = new Map<number, { content: string; vec: number[] }>()

function mockMemVec(id: number, content: string): number[] {
  const hit = mockMemVecCache.get(id)
  if (hit && hit.content === content) return hit.vec
  const vec = mockEmbed(content)
  mockMemVecCache.set(id, { content, vec })
  return vec
}

function mockCosine(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]
  return s
}

function kbHumanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 节点模态清单（含文本模态判定），对应 Rust assets::modals_for_source */
function kbModalsForSource(sourceType: string, sourceId: string, textChars: number): Array<{
  modal: string
  mime: string
  bytes: number
  durationMs: number | null
  transcriptState: string
  derivedFrom: string | null
  source: string
}> {
  const out: ReturnType<typeof kbModalsForSource> = []
  if (textChars > 0) {
    out.push({ modal: 'text', mime: 'text/markdown', bytes: textChars, durationMs: null, transcriptState: 'done', derivedFrom: null, source: 'text' })
  }
  if (sourceType === 'note') {
    for (const a of kbAssets.filter((x) => x.fileId === Number(sourceId))) {
      out.push({
        modal: a.modal, mime: a.mime, bytes: a.bytes, durationMs: a.durationMs,
        transcriptState: a.transcriptState, derivedFrom: null, source: 'asset',
      })
    }
  }
  if (sourceType === 'voice_memo') {
    const memo = voiceMemos.find((m) => m.id === sourceId)
    if (memo) {
      out.push({
        modal: 'audio', mime: 'audio/wav', bytes: 0,
        durationMs: memo.durationMs,
        transcriptState: 'done', derivedFrom: null, source: 'voice',
      })
    }
  }
  if (sourceType === 'todo_attachment') {
    const [todoId, idxRaw] = sourceId.split(':')
    const todo = todos.find((t) => String(t.id) === todoId)
    const att = todo?.attachments?.[Number(idxRaw)]
    if (att) {
      const attKind = String(att.kind)
      out.push({
        modal: attKind === 'text' ? 'text' : attKind,
        mime: kbMimeOfName(att.name),
        bytes: att.size ?? 0, durationMs: null,
        transcriptState: attKind === 'audio' || attKind === 'video' ? 'none' : 'done',
        derivedFrom: null, source: 'attachment',
      })
    }
  }
  return out
}

/** 整理审计写入（对应 Rust governance::audit） */
function kbAudit(source: string, op: string, from: string, to: string, reason: string): string {
  const batchId = `b${Date.now().toString(36)}-${++kbMoveId}`
  kbMoves.push({
    id: kbMoveId, batchId, source, op, pathFrom: from, pathTo: to,
    reason, at: new Date().toISOString(), undone: false,
  })
  saveKbMoves()
  return batchId
}

/** 注入块（对应 Rust injection::build）：注释行与空行不占预算，超限截断 */
function kbInjection(): {
  system: string
  memory: string
  files: Array<{ path: string; zone: string; chars: number; truncated: boolean }>
  totalChars: number
  budget: number
  truncated: boolean
} {
  kbEnsureIndex()
  const meaningful = (content: string): string | null => {
    const kept = content
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return t.length > 0 && !(t.startsWith('<!--') && t.endsWith('-->'))
      })
    const t = kept.join('\n').trim()
    return t ? t : null
  }
  const priority = (path: string): number => {
    if (path.startsWith('系统提示词/')) return 0
    if (path === '用户记忆/角色设定.md') return 1
    if (path === '用户记忆/全局规范.md') return 2
    return 3
  }
  const entries = kbFiles
    .filter((f) => f.path.startsWith('系统提示词/') || f.path.startsWith('用户记忆/'))
    .map((f) => ({ path: f.path, content: meaningful(f.content), zone: f.path.startsWith('系统提示词/') ? 'system' : 'memory' }))
    .filter((e): e is { path: string; content: string; zone: string } => e.content !== null)
    .sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path))

  let used = 0
  let truncated = false
  let system = ''
  let memory = ''
  const files: Array<{ path: string; zone: string; chars: number; truncated: boolean }> = []
  for (const e of entries) {
    if (used >= KB_INJECT_BUDGET) {
      truncated = true
      break
    }
    const header = `【${e.path}】\n`
    const left = KB_INJECT_BUDGET - used
    let text: string
    let cut = false
    if (header.length + e.content.length <= left) {
      text = `${header}${e.content}\n`
    } else {
      truncated = true
      cut = true
      text = `${header}${e.content.slice(0, Math.max(left - header.length - 1, 0))}…\n`
    }
    used += text.length
    if (e.zone === 'system') system += text
    else memory += text
    files.push({ path: e.path, zone: e.zone, chars: e.content.length, truncated: cut })
    if (cut) break
  }
  if (truncated) {
    const note = '（注入预算已满：还有内容没有注入，需要时用 glob_knowledge / read_knowledge 自己读）\n'
    if (memory) memory += note
    else system += note
    used += note.length
  }
  return { system, memory, files, totalChars: used, budget: KB_INJECT_BUDGET, truncated }
}

/** 把各 mock 数据源扫一遍建索引。真实实现由 SQLite 触发器登记 + 后台线程消费。 */
function kbEnsureIndex(): void {
  if (kbIndexed) return
  kbIndexed = true

  // 系统文件（规范 / 系统提示词 / 用户记忆模板 / 收件箱）与用户文件
  kbEnsureSystemFiles()
  for (const f of kbFiles) {
    // 回收站里的文件视同不存在：与 Rust source.rs::note_doc 的 trashed_at 过滤同语义
    if (f.trashedAt) {
      const di = kbDocs.findIndex((d) => d.sourceType === 'note' && d.sourceId === String(f.id))
      if (di >= 0) kbDocs.splice(di, 1)
      continue
    }
    const base = f.path.split('/').pop() ?? f.path
    const docKind: MockKbDoc['kind'] =
      f.kind === 'folder'
        ? 'folder'
        : f.kind === 'multimodal'
          ? primaryModalKind(f.id)
          : 'text'
    kbUpsertDoc(
      'note',
      String(f.id),
      base.replace(/\.[a-z0-9]+$/i, ''),
      kbCacheBody(f.content),
      f.createdAt.slice(0, 10),
      [f.system ? '规范' : '笔记'],
      { path: f.path, editable: !f.system, system: f.system, kind: docKind },
    )
  }

  for (const t of todos) {
    const sub = (t.subtasks ?? []).map((s) => `${s.done ? '✓' : '○'} ${s.title}`).join('、')
    // 附件只取 text 正文，绝不把 data URL 带进索引（与 Rust 侧同一条约束）
    const atts = (t.attachments ?? [])
      .map((a) =>
        a.kind === 'text'
          ? (a.content ?? '')
          : `${a.kind === 'image' ? '图片' : a.kind === 'audio' ? '录音' : '文件'}「${a.name}」`,
      )
      .join(' ')
    kbUpsertDoc(
      'todo',
      String(t.id),
      t.title,
      [t.title, t.notes ?? '', sub, atts].filter(Boolean).join(' '),
      t.date,
      [t.category],
      { path: `日程/${t.date ?? '收件箱'}/${kbSanitize(t.title, 60)}-${t.id}.md` },
    )
    // 附件编目：二进制内容绝不进正文（与 Rust 同一条铁律）
    ;(t.attachments ?? []).forEach((a, idx) => {
      const isText = a.kind === 'text'
      const body = isText
        ? (a.content ?? '')
        : `${a.kind === 'image' ? '图片' : a.kind === 'audio' ? '录音' : '文件'}「${a.name}」（${Math.round((a.size ?? 0) / 1024)} KB），随待办《${t.title}》保存`
      if (!body.trim()) return
      kbUpsertDoc(
        'todo_attachment',
        `${t.id}:${idx}`,
        a.name,
        body,
        t.date,
        ['附件', a.kind],
        {
          path: `附件/日程/${t.id}/${idx}-${kbSanitize(a.name, 40)}`,
          kind: a.kind === 'text' ? 'text' : a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'audio' : 'file',
          parentId: String(t.id),
        },
      )
    })
  }
  for (const w of workouts) {
    const sets = strengthSets.filter((s) => s.workoutId === w.id)
    const detail = sets.map((s) => `${s.exerciseName} ${s.weightKg ?? 0}kg × ${s.reps ?? 0}`).join('；')
    kbUpsertDoc('workout', String(w.id), w.name, [w.name, w.note ?? '', detail].filter(Boolean).join(' '), w.date, [w.type])
  }
  for (const p of plans) {
    kbUpsertDoc('plan', p.id, p.name, [p.name, p.subtitle ?? '', p.equipment ?? ''].filter(Boolean).join(' '), null, [p.workoutType])
  }
  for (const m of meals) {
    const f = foods.find((x) => x.id === m.foodId)
    kbUpsertDoc('meal', String(m.id), `${m.date} ${f?.name ?? '食物'}`, `${f?.name ?? ''} ${m.grams}g`, m.date, [m.mealType])
  }
  for (const b of bodyStore.metrics) {
    kbUpsertDoc('body_metric', String(b.id), `${b.date} 体测`, `体重 ${b.weightKg ?? '—'} kg`, b.date, ['body_metric'])
  }
  for (const memo of voiceMemos) {
    const sents = Array.isArray(memo.sentences) ? (memo.sentences as { text?: string }[]) : []
    kbUpsertDoc(
      'voice_memo',
      memo.id,
      memo.title || '语音纪要',
      sents.map((s) => s.text ?? '').join(''),
      memo.createdAt?.slice(0, 10) ?? null,
      ['voice_memo'],
      { path: `语音/${memo.createdAt?.slice(0, 10) ?? '收件箱'}/${kbSanitize(memo.title || '语音纪要', 60)}-${memo.id}.md` },
    )
  }
  // 长期记忆也编目（kb_docs 的一类来源，可被 glob/检索）；归档记忆退出检索
  for (const m of kbMemories) {
    if (m.archivedAt) continue
    const sub = m.category ? `${m.category}/` : ''
    kbUpsertDoc(
      'memory',
      String(m.id),
      m.topic ? `记忆 · ${m.topic}` : `记忆 · ${m.memType}`,
      m.content,
      m.createdAt.slice(0, 10),
      m.category ? [m.memType, m.category] : [m.memType],
      { path: `记忆/${m.memType}/${sub}${m.topic || '未命名'}-${m.id}.md`, editable: true },
    )
  }

  // 会话文档（全文转录，跳过工具卡与协议 JSON）+ 单条消息 + 对话附件
  const aiRole = (r: string) => (r === 'user' ? '用户' : 'AI')
  for (const chat of aiChats.values()) {
    const lines: string[] = []
    for (const m of chat.messages) {
      if (m.kind === 'tools') continue
      const text = (m.text ?? '').trim()
      if (!text || text.startsWith('{')) continue
      lines.push(`[${m.seq}] ${aiRole(m.role)}：${text}`)
      kbUpsertDoc(
        'chat_message',
        m.id,
        text.slice(0, 40),
        text,
        m.createdAt?.slice(0, 10) ?? null,
        ['chat', m.role],
        { path: `对话/${chat.id}/${m.seq}-${aiRole(m.role)}.md` },
      )
      // 对话附件：照片消息
      if (m.imageBase64) {
        const size = Math.round((m.imageBase64.length * 3) / 4)
        kbUpsertDoc(
          'chat_attachment',
          `${m.id}:img`,
          `图片-${(m.createdAt ?? '').slice(0, 10)}.jpg`,
          `随对话消息保存的图片（${size} B）；图片本体在消息的 imageBase64 里`,
          m.createdAt?.slice(0, 10) ?? null,
          ['附件', 'image'],
          { path: `附件/对话/${m.id}/图片-${(m.createdAt ?? '').slice(0, 10)}.jpg`, kind: 'image', parentId: m.id },
        )
      }
    }
    if (lines.length === 0) continue
    kbUpsertDoc(
      'chat',
      chat.id,
      `对话 · ${kbSanitize(chat.title, 40)}`,
      `与用户共 ${lines.length} 条消息的完整转录：\n${lines.join('\n')}`,
      chat.createdAt?.slice(0, 10) ?? null,
      ['chat'],
      { path: `对话/${kbSanitize(chat.title, 40)}-${chat.id}.md` },
    )
  }
}

/** glob 匹配（与 Rust glob_match 同语义：星号不跨 /、双星跨、问号单字符、双星斜杠可匹配零层目录） */
function kbGlobMatch(pattern: string, path: string): boolean {
  const toRe = (pat: string) =>
    new RegExp(
      '^' +
        pat
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          // 一趟替换：`**` 必须在 `*` 之前判，否则 `.*` 里那个 `*` 会被再替换一次
          .replace(/\*\*|\*|\?/g, (m) => (m === '**' ? '.*' : m === '*' ? '[^/]*' : '[^/]')) +
        '$',
    )
  if (toRe(pattern).test(path)) return true
  if (pattern.includes('/**/')) return toRe(pattern.replace('/**/', '/')).test(path)
  return false
}

function kbDocToMemory(m: MockKbMemory) {
  // 显著性读时计算：与 Rust 一样不落库，避免时间一长就和真实排序漂移
  return { ...m, salience: kbSalience(m) }
}

function kbSearchMock(query: string, opts: {
  sources?: string[]
  from?: string
  to?: string
  tags?: string[]
  limit?: number
}) {
  kbEnsureIndex()
  const q = query.trim()
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20)

  let pool = kbDocs.slice()
  if (opts.sources?.length) pool = pool.filter((d) => opts.sources!.includes(d.sourceType))
  if (opts.from) pool = pool.filter((d) => d.occurredOn && d.occurredOn >= opts.from!)
  if (opts.to) pool = pool.filter((d) => d.occurredOn && d.occurredOn <= opts.to!)
  if (opts.tags?.length) pool = pool.filter((d) => opts.tags!.some((t) => d.tags.includes(t)))

  if (!q) {
    return pool
      .sort((a, b) => (b.occurredOn ?? '').localeCompare(a.occurredOn ?? ''))
      .slice(0, limit)
      .map((d) => ({ ...d, snippet: d.summary, score: 0, matched: 'browse' as const }))
  }

  // 与真实实现同构的召回阶梯：整串命中 → 二字窗口模糊
  const exact = pool.filter((d) => `${d.title} ${d.body}`.includes(q))
  const tier = exact.length ? 'like' : 'fuzzy'
  const hits = exact.length
    ? exact
    : (() => {
        const chars = [...q.replace(/\s/g, '')]
        if (chars.length < 4) return []
        const grams = chars.slice(0, -1).map((c, i) => c + chars[i + 1]!)
        const need = Math.max(2, Math.ceil(grams.length * 0.6))
        return pool.filter((d) => {
          const hay = `${d.title} ${d.body}`
          return grams.filter((g) => hay.includes(g)).length >= need
        })
      })()

  return hits.slice(0, limit).map((d, i) => {
    const idx = d.body.indexOf(q)
    const snippet =
      idx >= 0
        ? `${idx > 20 ? '…' : ''}${d.body.slice(Math.max(0, idx - 20), idx + q.length + 20)}${idx + q.length + 20 < d.body.length ? '…' : ''}`
        : d.summary
    return { ...d, snippet, score: 1 / (i + 1), matched: tier }
  })
}

/* ---------- 校园教务（演示数据） ----------
 * 演示学期刻意锚定在「本周」，这样任何一天打开浏览器预览都能看到当周的课。
 * 「周次 → 公历日期」的展开在真实环境里由 Rust 完成，mock 必须自己算一遍，
 * 公式与 modules/campus/commands.rs::occurrence_date 保持一致。 */

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function campusMonday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

function campusRange(): [string, string] {
  const start = campusMonday()
  const from = new Date(start)
  from.setDate(from.getDate() - 7)
  const to = new Date(start)
  to.setDate(to.getDate() + 41)
  return [ymd(from), ymd(to)]
}

const CAMPUS_WEEKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]

interface CampusSessionDemo {
  id: number
  courseId: number
  weekday: number
  startUnit: number
  endUnit: number
  startTime: string
  endTime: string
  weeks: number[]
  weeksStr: string | null
  room: string | null
  building: string | null
  campus: string | null
  courseName: string
  courseCode: string | null
  teachers: string[]
  credits: number | null
  courseType: string | null
  color: string | null
}

/**
 * 节次时间表 —— 学校公布的「第 N 节 → 几点到几点」（正方教务单独给这张表，树维没有）。
 *
 * 这里照抄需求里那所学校的作息：40 分钟一节、节与节之间只隔 5 分钟，第2/3节之间 25 分钟，
 * 午休 12:00→14:30，晚课是一节 95 分钟的长节。**「时间不对称」就是从这儿来的** ——
 * 轴上的行高按这些真实时长成比例，而不是把所有节画成一样高。
 */
const CAMPUS_PERIOD_SLOTS = [
  { unit: 1, startTime: '08:00', endTime: '08:40' },
  { unit: 2, startTime: '08:45', endTime: '09:25' },
  { unit: 3, startTime: '09:50', endTime: '10:30' },
  { unit: 4, startTime: '10:35', endTime: '11:15' },
  { unit: 5, startTime: '11:20', endTime: '12:00' },
  { unit: 6, startTime: '14:30', endTime: '15:10' },
  { unit: 7, startTime: '15:15', endTime: '15:55' },
  { unit: 8, startTime: '16:10', endTime: '16:50' },
  { unit: 9, startTime: '16:55', endTime: '17:35' },
  { unit: 10, startTime: '17:40', endTime: '18:20' },
  { unit: 11, startTime: '19:30', endTime: '21:05' },
  { unit: 12, startTime: '21:10', endTime: '22:00' },
]

/** 一次课的起止 = 首节起点 → 末节止点（教务给的就是这两头），表里查不到就不猜 */
function campusSlotSpan(startUnit: number, endUnit: number): { startTime: string; endTime: string } {
  const first = CAMPUS_PERIOD_SLOTS.find((s) => s.unit === startUnit)
  const last = CAMPUS_PERIOD_SLOTS.find((s) => s.unit === endUnit)
  return { startTime: first?.startTime ?? '08:00', endTime: last?.endTime ?? '09:35' }
}

function campusSession(
  id: number,
  weekday: number,
  startUnit: number,
  endUnit: number,
  courseName: string,
  code: string,
  teacher: string,
  room: string,
  color: string,
  weeks: number[] = CAMPUS_WEEKS,
): CampusSessionDemo {
  const { startTime, endTime } = campusSlotSpan(startUnit, endUnit)
  return {
    id,
    courseId: id,
    weekday,
    startUnit,
    endUnit,
    startTime,
    endTime,
    weeks,
    weeksStr: weeks.length ? `${weeks[0]}~${weeks[weeks.length - 1]}` : null,
    room,
    building: '花江校区第六教学楼',
    campus: '花江校区',
    courseName,
    courseCode: code,
    teachers: [teacher],
    credits: 3,
    courseType: '专业必修',
    color,
  }
}

/**
 * 演示课表。刻意覆盖三种「不对称」：两节连排（大多数）、**三节连排**（大学物理实验，
 * 课块跨三行）、**一节 95 分钟的晚课**（通识讲座，那一行明显更高）。
 * 第5节（11:20-12:00）与第12节没课 —— 它们在轴上不出行。
 */
const CAMPUS_SESSIONS: CampusSessionDemo[] = [
  campusSession(1, 1, 1, 2, '高等数学（上）', '000001', '陈建国', '11A201', '#3B73B6'),
  campusSession(2, 3, 1, 2, '高等数学（上）', '000001', '陈建国', '11A201', '#3B73B6'),
  campusSession(3, 2, 3, 4, '大学英语（一）', '000002', 'Linda', '12B305', '#22A06B'),
  campusSession(4, 4, 3, 4, '大学英语（一）', '000002', 'Linda', '12B305', '#22A06B'),
  campusSession(5, 1, 6, 7, '数据结构与算法', '000101', '黄志远', '15C102', '#B5632E'),
  campusSession(6, 2, 6, 7, '大学物理', '000201', '刘敏', '13A408', '#8257C8'),
  campusSession(7, 5, 3, 4, '计算机组成原理', '000102', '周立', '15C210', '#C0392B'),
  campusSession(8, 5, 7, 8, '体育（一）', '000301', '吴强', '体育馆', '#2E86C1', CAMPUS_WEEKS.filter((w) => w % 2 === 1)),
  campusSession(9, 3, 8, 10, '大学物理实验', '000202', '刘敏', '13A408', '#8257C8'),
  campusSession(10, 4, 11, 11, '通识讲座', '000401', '校外讲师', '图书馆报告厅', '#C9A227'),
]

function campusExpand(
  sem: { startDate: string; weekStartOnSunday: boolean; totalWeeks: number },
  from: string,
  to: string,
): unknown[] {
  const anchor = new Date(`${sem.startDate}T00:00:00`)
  const plan = campusHolidayPlan()
  const out: unknown[] = []
  for (const s of CAMPUS_SESSIONS) {
    for (const w of s.weeks) {
      const offset = s.weekday - 1
      const d = new Date(anchor)
      d.setDate(d.getDate() + (w - 1) * 7 + offset)
      const date = ymd(d)
      if (date < from || date > to) continue
      // 放假日：课照上，只打一枚「假」标
      out.push({ date, week: w, session: s, holiday: plan.off.has(date) ? 'off' : null })
    }
  }
  // 调休补课：补班日额外挂上「被补星期几」在本教学周的课，并打「调」标
  for (const [date, weekday] of plan.makeup) {
    const w = campusWeekOf(anchor, date)
    if (w == null || w < 1 || w > sem.totalWeeks) continue
    if (date < from || date > to) continue
    for (const s of CAMPUS_SESSIONS) {
      if (s.weekday !== weekday || !s.weeks.includes(w)) continue
      out.push({ date, week: w, session: s, holiday: 'makeup' })
    }
  }
  out.sort((a, b) => {
    const x = a as { date: string; session: { startTime: string } }
    const y = b as { date: string; session: { startTime: string } }
    return x.date.localeCompare(y.date) || x.session.startTime.localeCompare(y.session.startTime)
  })
  return out
}

/** 公历日期落在第几教学周（1 起）；早于学期锚点返回 null。与 Rust 的 `week_of` 同构 */
function campusWeekOf(anchor: Date, date: string): number | null {
  const d = new Date(`${date}T00:00:00`)
  const days = Math.round((d.getTime() - anchor.getTime()) / 86400000)
  if (days < 0) return null
  return Math.floor(days / 7) + 1
}

/** 调休映射的演示配置（mock 内存态；刷新页面即回到默认「开启」）。 */
let campusHolidayCfg = { enabled: true, overrides: {} as Record<string, number> }

/**
 * 官方调休数据的 **2026 年真实快照**（`holiday-cn` 的 `days` 原样搬来）。
 *
 * 为什么要内嵌而不是联网：mock 是纯浏览器的内存后端，不该有网络依赖；它只影响浏览器预览，
 * 桌面端走 Rust 的 `holiday.rs`（联网抓取 + 落 `app_meta` 缓存）。
 * 只列非常规日：法定放假日 `isOffDay: true`、调休补班日 `isOffDay: false`，普通周末不在表里。
 * 2027 年的安排要等国务院发文（holiday-cn 现在还是空表），公布后照抄一份即可。
 */
const CAMPUS_HOLIDAY_2026: { name: string; date: string; isOffDay: boolean }[] = [
  { name: '元旦', date: '2026-01-01', isOffDay: true },
  { name: '元旦', date: '2026-01-02', isOffDay: true },
  { name: '元旦', date: '2026-01-03', isOffDay: true },
  { name: '元旦', date: '2026-01-04', isOffDay: false },
  { name: '春节', date: '2026-02-14', isOffDay: false },
  { name: '春节', date: '2026-02-15', isOffDay: true },
  { name: '春节', date: '2026-02-16', isOffDay: true },
  { name: '春节', date: '2026-02-17', isOffDay: true },
  { name: '春节', date: '2026-02-18', isOffDay: true },
  { name: '春节', date: '2026-02-19', isOffDay: true },
  { name: '春节', date: '2026-02-20', isOffDay: true },
  { name: '春节', date: '2026-02-21', isOffDay: true },
  { name: '春节', date: '2026-02-22', isOffDay: true },
  { name: '春节', date: '2026-02-23', isOffDay: true },
  { name: '春节', date: '2026-02-28', isOffDay: false },
  { name: '清明节', date: '2026-04-04', isOffDay: true },
  { name: '清明节', date: '2026-04-05', isOffDay: true },
  { name: '清明节', date: '2026-04-06', isOffDay: true },
  { name: '劳动节', date: '2026-05-01', isOffDay: true },
  { name: '劳动节', date: '2026-05-02', isOffDay: true },
  { name: '劳动节', date: '2026-05-03', isOffDay: true },
  { name: '劳动节', date: '2026-05-04', isOffDay: true },
  { name: '劳动节', date: '2026-05-05', isOffDay: true },
  { name: '劳动节', date: '2026-05-09', isOffDay: false },
  { name: '端午节', date: '2026-06-19', isOffDay: true },
  { name: '端午节', date: '2026-06-20', isOffDay: true },
  { name: '端午节', date: '2026-06-21', isOffDay: true },
  { name: '国庆节', date: '2026-09-20', isOffDay: false },
  { name: '中秋节', date: '2026-09-25', isOffDay: true },
  { name: '中秋节', date: '2026-09-26', isOffDay: true },
  { name: '中秋节', date: '2026-09-27', isOffDay: true },
  { name: '国庆节', date: '2026-10-01', isOffDay: true },
  { name: '国庆节', date: '2026-10-02', isOffDay: true },
  { name: '国庆节', date: '2026-10-03', isOffDay: true },
  { name: '国庆节', date: '2026-10-04', isOffDay: true },
  { name: '国庆节', date: '2026-10-05', isOffDay: true },
  { name: '国庆节', date: '2026-10-06', isOffDay: true },
  { name: '国庆节', date: '2026-10-07', isOffDay: true },
  { name: '国庆节', date: '2026-10-10', isOffDay: false },
]

/** 公历日期 → 1=周一 … 7=周日。与 Rust `holiday.rs::weekday_of` 同构。 */
function campusWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00`).getDay() + 6) % 7) + 1
}

/**
 * 推断「补班日 → 被补的星期几」。与 Rust `holiday.rs::infer_makeups` 同构：
 * 同一节日下，把「假期内被吃掉的工作日（周一~周五）」与补班日都按日期降序一一配对。
 * 2026 国庆 → 10/10 补周三、9/20 补周二；配不上的补班日不做映射（宁可不显示，也不张冠李戴）。
 */
function campusInferMakeups(): Map<string, number> {
  const groups = new Map<string, { offs: string[]; makeups: string[] }>()
  for (const d of CAMPUS_HOLIDAY_2026) {
    let g = groups.get(d.name)
    if (!g) {
      g = { offs: [], makeups: [] }
      groups.set(d.name, g)
    }
    // 只有落在工作日的放假日才「吃掉了课时」，周末本来就是休息日，不占配位
    if (d.isOffDay) {
      if (campusWeekdayOf(d.date) <= 5) g.offs.push(d.date)
    } else {
      g.makeups.push(d.date)
    }
  }
  const out = new Map<string, number>()
  for (const g of groups.values()) {
    g.offs.sort((a, b) => b.localeCompare(a))
    g.makeups.sort((a, b) => b.localeCompare(a))
    for (let i = 0; i < g.makeups.length && i < g.offs.length; i++) {
      out.set(g.makeups[i]!, campusWeekdayOf(g.offs[i]!))
    }
  }
  return out
}

/**
 * 调休计划：放假日集合 + 补班映射。与 Rust `holiday.rs::build_plan` 同构。
 * 关闭开关 → 空计划（不标「假」也不挂「调」）；用户覆盖优先级最高（`0` = 取消该日补课）。
 */
function campusHolidayPlan(): { off: Set<string>; makeup: Map<string, number> } {
  const off = new Set<string>()
  const makeup = new Map<string, number>()
  if (!campusHolidayCfg.enabled) return { off, makeup }
  for (const d of CAMPUS_HOLIDAY_2026) if (d.isOffDay) off.add(d.date)
  for (const [date, wd] of campusInferMakeups()) makeup.set(date, wd)
  for (const [date, wd] of Object.entries(campusHolidayCfg.overrides)) {
    if (wd === 0) makeup.delete(date)
    else if (wd >= 1 && wd <= 7) makeup.set(date, wd)
  }
  return { off, makeup }
}


const campusSemester = () => ({
  id: 1,
  accountId: 1,
  remoteId: 321,
  code: '2026-2027_1',
  name: '2026-2027 第一学期',
  schoolYear: '2026-2027',
  season: 'AUTUMN',
  startDate: ymd(campusMonday()),
  endDate: ymd(new Date(campusMonday().getFullYear() + 1, 0, 24)),
  weekStartOnSunday: false,
  totalWeeks: 18,
  currentWeek: 1,
  isCurrent: true,
})

/** 物化窗口：过去一周 + 未来五周，与 Rust 的 MATERIALIZE_* 常量一致 */
const CAMPUS_BACK_DAYS = 7
const CAMPUS_FORWARD_DAYS = 35

const campusHhmmToMin = (t: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '')
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 派生行备注：第几节 · 教室 · 教师（与 Rust 的 class_notes 同构） */
function campusClassNotes(s: CampusSessionDemo): string | null {
  const bits: string[] = []
  if (s.startUnit > 0 && s.endUnit >= s.startUnit) {
    bits.push(s.startUnit === s.endUnit ? `第${s.startUnit}节` : `第${s.startUnit}-${s.endUnit}节`)
  }
  const place = [s.building, s.room].filter(Boolean).join(' ')
  if (place) bits.push(place)
  if (s.teachers.length) bits.push(s.teachers.join('、'))
  return bits.length ? bits.join(' · ') : null
}

/** 按日期区间展开成「某天某节课」的发生列表 */
function campusOccurrences(from: string, to: string): { date: string; session: CampusSessionDemo }[] {
  return campusExpand(campusSemester(), from, to) as { date: string; session: CampusSessionDemo }[]
}

/**
 * 重建课表在时间线上的派生行，返回写入条数。
 *
 * 与 Rust 的 `commands.rs::materialize_todos` 同一套语义：**先删后建**（幂等），
 * 且 `status='done'` 的历史行永不删除、重建时跳过「已存在完成行」的发生 ——
 * 否则用户打过卡的课会被重新创建成未完成态，同一天出现两行。
 *
 * mock 必须自己算这一遍，否则「课表进时间线」这个功能在浏览器里根本看不见。
 */
function campusMaterializeTodos(): number {
  for (let i = todos.length - 1; i >= 0; i--) {
    const t = todos[i]!
    if (t.courseSessionId != null && t.status !== 'done') todos.splice(i, 1)
  }

  const done = new Set<string>()
  for (const t of todos) {
    if (t.courseSessionId != null && t.status === 'done') done.add(`${t.courseSessionId}:${t.date}`)
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const from = new Date(today)
  from.setDate(from.getDate() - CAMPUS_BACK_DAYS)
  const to = new Date(today)
  to.setDate(to.getDate() + CAMPUS_FORWARD_DAYS)

  const now = new Date().toISOString()
  let written = 0
  for (const { date, session } of campusOccurrences(ymd(from), ymd(to))) {
    if (done.has(`${session.id}:${date}`)) continue
    const startMin = campusHhmmToMin(session.startTime)
    if (startMin == null) continue
    const endMin = campusHhmmToMin(session.endTime)
    todos.push({
      id: ++todoId,
      title: session.courseName,
      notes: campusClassNotes(session),
      date,
      startMin,
      durationMin: endMin != null && endMin > startMin ? endMin - startMin : 95,
      category: COURSE_CATEGORY,
      priority: 0,
      status: 'todo',
      completedAt: null,
      createdAt: now,
      courseSessionId: session.id,
      programId: null,
      recRule: null,
      recKey: null,
      subtasks: null,
      attachments: null,
    })
    written++
  }
  return written
}

const campusDemoCourses = () => {
  const seen = new Map<number, unknown>()
  for (const s of CAMPUS_SESSIONS) {
    if (seen.has(s.courseId)) continue
    seen.set(s.courseId, {
      id: s.courseId,
      semesterId: 1,
      remoteLessonId: s.courseId,
      courseCode: s.courseCode,
      courseName: s.courseName,
      lessonCode: null,
      lessonName: null,
      teachers: s.teachers,
      credits: s.credits,
      courseType: s.courseType,
      color: s.color,
    })
  }
  return [...seen.values()] as {
    id: number
    remoteLessonId: number
    courseName: string
    courseCode: string | null
    teachers: string[]
    credits: number | null
    color: string | null
  }[]
}

let campusAccount: Record<string, unknown> | null = null
let campusNeedCaptcha = false
let campusCourses = [] as ReturnType<typeof campusDemoCourses>

/* ---------- 救援面（AI 的最后补救）：审计 + 剧本化的原始请求 ----------
 * 浏览器里没有真教务，也没有真的 AI 会话，所以要验的是**这条链的形状**：
 * 「带会话的请求长什么样、审计里留下什么、导出的脚本能不能重放」。
 * 剧本刻意覆盖最要命的那组对照：会话活着但接口返回 HTML 回退（教务改接口）
 * vs 会话被踢回登录页 —— 这两件事的处理方式完全不同，判错就白折腾。 */

interface MockAiAction {
  id: number
  at: string
  kind: string
  summary: string
  detail?: unknown
  curl?: string | null
  status: 'ok' | 'error'
  accountId?: number | null
}

const mockAiActions: MockAiAction[] = []
let mockActionId = 0

function mockAction(kind: string, summary: string, curl?: string | null, status: 'ok' | 'error' = 'ok', detail?: unknown): number {
  mockAiActions.push({
    id: ++mockActionId,
    at: new Date().toISOString(),
    kind,
    summary,
    curl: curl ?? null,
    status,
    accountId: campusAccount ? 1 : null,
    detail,
  })
  return mockActionId
}

/** 与 Rust `rescue::render_curl` 同形：凭据写成变量引用，绝不在每行里复制一份 Cookie。 */
function mockRenderCurl(o: {
  method: string
  url: string
  headers: [string, string][]
  body?: string | null
  withCookie: boolean
  withToken: boolean
}): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const lines: string[] = []
  if (o.withCookie || o.withToken) {
    const vars = [o.withCookie ? 'COOKIE' : null, o.withToken ? 'SELECT_TOKEN' : null].filter(Boolean)
    lines.push(`# 先设变量再执行：export ${vars.join(' ')}='…'（导出脚本时脚本头部已定义）`)
  }
  let cmd = `curl -sS -i -X ${o.method} ${q(o.url)}`
  for (const [k, v] of o.headers) cmd += `\n  -H ${q(`${k}: ${v}`)}`
  if (o.withCookie) cmd += '\n  -H "Cookie: $COOKIE"'
  if (o.withToken) cmd += '\n  -H "Authorization: $SELECT_TOKEN"'
  if (o.body) cmd += `\n  --data-raw ${q(o.body)}`
  lines.push(cmd)
  return lines.join('\n')
}

/** 剧本化的响应体。命中不了就 404 —— 「教务回了个没见过的页面」本身也是要能演练的状态。 */
function mockHttpScript(url: string): { status: number; contentType: string; body: string } {
  const path = url.replace(/^https?:\/\/[^/]+/, '')
  const broken = !!(globalThis as { __REIN_MOCK_CAMPUS_BREAK__?: boolean })
    .__REIN_MOCK_CAMPUS_BREAK__
  const dead = !!(globalThis as { __REIN_MOCK_CAMPUS_SESSION_DEAD__?: boolean })
    .__REIN_MOCK_CAMPUS_SESSION_DEAD__

  // 会话被踢：门户用 302 回登录页，这是教务表达「你没登录」的唯一方式
  if (dead) {
    return { status: 302, contentType: 'text/html', body: '<html><body>302 → /login</body></html>' }
  }
  // 「教务改接口」：SPA 的回退页。信封不见了 —— 这正是最值钱的线索
  if (broken && path.startsWith('/course-selection-api/')) {
    return {
      status: 200,
      contentType: 'text/html;charset=UTF-8',
      body: '<!DOCTYPE html><html><head><title>选课</title></head><body><div id="app"></div></body></html>',
    }
  }
  if (path === '/student/home') {
    return { status: 200, contentType: 'text/html', body: '<html><body>桂电教务 · 学生首页</body></html>' }
  }
  if (path.includes('/course-selection-api/')) {
    if (path.includes('getCurrentDateTime')) {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: 0, message: '', data: campusServerTime() }),
      }
    }
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: 0, message: '', data: [] }),
    }
  }
  if (path.startsWith('/course-selection/')) {
    return { status: 200, contentType: 'text/html', body: '<html><body>选课 SPA</body></html>' }
  }
  return { status: 404, contentType: 'text/html', body: `<html><body>404 ${path}</body></html>` }
}

/* ---------- 选课（演示批次刻意设为「开放中」） ----------
 * 真实环境里大一新生的选课窗口还没开，`open-turns` 会返回空数组；
 * mock 这里给一个开放中的批次，好让「进入 → 查询 → 一键选 → 轮询结果」整套流程
 * 能在浏览器里走通并被 e2e 覆盖。空批次那条分支由真机构造（见 Rust 的真机联调测试）。 */

function campusServerTime(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 全校开课查询的演示数据。
 *
 * 与「选课批次里的教学班」刻意分开：开课查询是**全校开课名单**，
 * 批次没开的时候照样有；批次里只放你这一轮能抢的班。
 * 混用会让界面演示出「批次没开但能抢」这种不可能的状态。
 */
function campusLessonSearchHits() {
  const mk = (
    id: number,
    code: string,
    nameZh: string,
    credits: number,
    lessonName: string,
    teacher: string,
    when: string,
  ) => ({
    id,
    course: { id: id * 10, code, nameZh, nameEn: null, credits },
    nameZh: lessonName,
    openDepartment: { nameZh: '计算机与信息安全学院' },
    teacherAssignmentList: [{ nameZh: teacher }],
    timeTableLayout: [],
    scheduleText: when,
    campus: { nameZh: '花江校区' },
    courseType: { nameZh: '专业选修' },
    examMode: { nameZh: '考查' },
    teachLang: { nameZh: '中文' },
    roomType: { nameZh: '普通教室' },
    raw: { id, courseCode: code, courseName: nameZh },
  })
  return [
    mk(9001, '000031', '高等数学A1', 5, '01班', '张伟', '周一 1-2节 花江A101；周三 3-4节 花江A101'),
    mk(9002, '000031', '高等数学A1', 5, '02班', '张伟明', '周一 3-4节 花江A102；周三 1-2节 花江A102'),
    mk(9003, '000031', '高等数学A1', 5, '03班', '李娜', '周二 1-2节 花江B201；周四 3-4节 花江B201'),
    mk(9004, '000004', '大学体育1', 1, '羽毛球 01班', '王强', '周五 5-6节 体育馆'),
    mk(9005, '000006', '大学体育3', 1, '羽毛球 01班', '王强', '周五 7-8节 体育馆'),
    mk(9006, '000018', '数据结构', 4, '01班', '陈静', '周二 3-4节 花江C301；周四 1-2节 花江C301'),
    mk(9007, '000018', '数据结构', 4, '02班', '陈静', '周二 5-6节 花江C302；周四 3-4节 花江C302'),
    mk(9008, '000052', '线性代数', 3, '01班', '刘洋', '周三 5-6节 花江A203'),
    mk(9009, '000077', '大学英语3', 3, '01班', 'Sarah', '周一 5-6节 花江D401；周五 1-2节 花江D401'),
    mk(9010, '000077', '大学英语3', 3, '02班', '赵敏', '周一 7-8节 花江D402；周五 3-4节 花江D402'),
  ]
}

function campusSelectTurns() {
  // e2e 钩子：置空批次列表，用来验证「选课窗口还没开放」的等待态 ——
  // 那才是大一新生的真实状态，而演示批次刻意是开放中的，两者都要能看。
  if ((globalThis as { __REIN_MOCK_NO_SELECT_TURN__?: boolean }).__REIN_MOCK_NO_SELECT_TURN__) {
    return []
  }
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  // 窗口从当天 00:00 起：写死在 08:00 的话，早上 7 点跑 e2e 会看到任务在「等开抢」而不是开抢，
  // 断言就随运行时刻飘了。演示批次要的是「窗口已经开着」这个状态。
  const opensAt = `${day} 00:00:00`
  const closesAt = `${day} 23:59:59`
  return [
    {
      id: 77,
      name: '2026-2027 第一学期 正选',
      bulletin: '本轮为正选轮次，先到先得。选中后请到「我的课表」核对。',
      allowEnter: true,
      disallowReasons: [],
      openDateTimeText: `${day} 00:00`,
      selectDateTimeText: `${day} 00:00 ~ 23:59`,
      dropDateTimeText: `${day} 00:00 ~ 23:59`,
      addRulesText: ['选课人数达到上限后不可再选'],
      dropRulesText: [],
      openDateTimeRange: { startDateTime: opensAt, endDateTime: closesAt },
      selectDateTimeRange: { startDateTime: opensAt, endDateTime: closesAt },
      dropDateTimeRange: { startDateTime: opensAt, endDateTime: closesAt },
    },
  ]
}

let campusPickedLessons = new Set<number>()
let campusSelectQueue: number[] = []
let campusSelectRequestId = ''
let campusSelectPolls = 0

function campusDemoLessons() {
  const mk = (
    id: number,
    code: string,
    nameZh: string,
    credits: number,
    stdCount: number,
    limitCount: number,
    groups: number,
    teachers: string[] = [],
    /** 教学班名称：院系 / 校区 / 年级**只写在这里**（真机实测形状） */
    lessonName: string | null = null,
    /** 项目名：体育课靠它区分「羽毛球」与「匹克球」（`minorCourse.nameZh`） */
    minorName: string | null = null,
  ) => ({
    id,
    course: { id: id * 10, code, nameZh, nameEn: null, credits },
    selectedLesson: campusPickedLessons.has(id)
      ? { status: '已选中', pinned: true, needAttend: false }
      : null,
    stdCount,
    limitCount,
    teachers: teachers.map((nameZh) => ({ nameZh })),
    lessonName,
    minorCourse: minorName ? { id: id * 10 + 1, nameZh: minorName, nameEn: null, code } : null,
    scheduleGroups: Array.from({ length: groups }, (_, i) => ({
      id: id * 100 + i,
      no: i + 1,
      default: i === 0,
      limitCount: Math.floor(limitCount / groups),
      dateTimePlace: { text: `第${i + 1}组` },
    })),
    canSelect: true,
  })
  return [
    mk(9001, '000001', '高等数学（上）', 5, 118, 120, 2, ['李娜']),
    // 同一门课的第二个班，且已满、教师不同 ——
    // 计划的模糊匹配要能分辨「高数 张」与「000001 余量优先」这两件事
    mk(9006, '000001', '高等数学（上）', 5, 60, 60, 1, ['张伟']),
    // 9007 的老师名字**包含** 9006 的：用来验「打全了名字 = 只抢这位老师的班」
    // （查「张伟」不该把「张伟明」的班也拖进志愿组）
    mk(9007, '000003', '线性代数', 3, 40, 50, 1, ['张伟明']),
    mk(9002, '000002', '大学英语（一）', 3, 56, 60, 3, ['王芳']),
    // 9003 固定返回「需要免听」，用来演示时间冲突分支
    mk(9003, '000011', '大学物理（含实验）', 4, 60, 60, 1, ['刘洋']),
    mk(9004, '000021', '计算机科学导论', 2, 42, 80, 1, ['陈静']),
    // 9005 固定「先满员两次再放名额」，用来演示守着一个满员班的完整过程
    mk(9005, '000031', '体育（一）', 1, 30, 30, 4, ['赵强']),
    // ── 体育课的真实形状（用户实际要抢的就是这个）─────────────────────────
    // 所有项目的**课程名都一样**（「大学体育1」），学生嘴里的课名是**项目名**；
    // 院系只写教学班名称里。这两段文字缺一个，8 个项目的班就无法区分、
    // 也无法表达「只抢本院系那个班」——所以 fixture 必须长成这样。
    mk(
      9010,
      '000004',
      '大学体育1',
      1,
      20,
      41,
      1,
      ['王秦丹青'],
      '大学体育1-花江校区-26级（3院、7院、建交院）',
      '羽毛球',
    ),
    mk(
      9011,
      '000004',
      '大学体育1',
      1,
      20,
      41,
      1,
      ['周之昊'],
      '大学体育1-花江校区-26级（4院、5院）',
      '羽毛球',
    ),
    mk(
      9012,
      '000004',
      '大学体育1',
      1,
      18,
      41,
      1,
      ['秦小鹏'],
      '大学体育1-花江校区-26级（3院、7院、建交院）',
      '匹克球',
    ),
  ]
}

/* ---------- 自动抢课（浏览器里的模拟引擎） ----------
 * 真实引擎在 Rust 后台线程（`modules/campus/grab.rs`），这里必须**自己实现一遍**：
 * 浏览器里没有那条线程，而「任务单会不会自己往前走」恰恰是这套 UI 的全部意义，
 * 不模拟的话 e2e 只能验一个静止的列表。
 *
 * 刻意压缩了时间尺度（轮询 400ms 而不是 2 秒）：断言的是**状态迁移**，不是时长。
 * 时间尺度上唯一不打折的是「开窗前不出手」那条闸门 —— 它是这套逻辑的核心不变量。 */

const GRAB_POLL_MS = 400
const GRAB_PROBE_MS = 1500

export const mockCampus: { onGrab: ((s: GrabState) => void) | null } = { onGrab: null }

interface MockGrabTask {
  id: number
  turnId: string
  turnName: string | null
  lessonId: unknown
  lessonName: string | null
  courseName: string | null
  courseCode: string | null
  teacher: string | null
  credits: number | null
  mode: 'predicate' | 'direct'
  virtualCost: number | null
  scheduleGroupId: unknown
  windowWall: string | null
  windowEndWall: string | null
  awaitWindow: boolean
  /** 占位是否已经交过。不能用 attempts===0 反推 —— 占位落定到正式提交之间它还是 0 */
  predicateDone: boolean
  /**
   * mock 内部：手里这张受理单是**占位单**（问 predicate-response）还是正式单。
   *
   * 真引擎对应的判据是 `polls_predicate()`：`predicateDone && attempts === 0`。
   * 这里显式记一位，是为了让 e2e 看到的**状态序列**与真引擎一致 ——
   * 少这一次「占位受理 → 转正式确认」，就等于把「占位优先」这个模式测成了「直接提交」。
   * （真机上的时间尺度不压缩，但节奏快慢不是这里要验的东西，见文件头。）
   */
  pollingPredicate?: boolean
  status: string
  phase: 'idle' | 'submit' | 'poll'
  attempts: number
  polls: number
  strikes: number
  strikeKind: string | null
  requestId: string | null
  lastMessage: string | null
  nextAt: number
  fireAt: number | null
  queuedAt: number
  finishedAt: number | null
  /** 志愿组。同组互斥，只会中一个；空 = 独立任务 */
  groupKey: string | null
  groupName: string | null
  /** 志愿序：1 = 第一志愿，小的优先；0 = 不在组里 */
  priority: number
  /** 连续满员的起点（「让贤期限」读它） */
  stuckSince: number | null
  /** 派生值：把它压住的更高优先级任务 id（不落库，与真引擎一致） */
  heldBy: number | null
  /** mock 内部：窗口探测的下一次时刻 */
  probeAt?: number
  /** mock 内部：该教学班已报了几次满员 */
  fullTimes?: number
}

const grabTasks: MockGrabTask[] = []
let grabSeq = 0

/* ---------- 任务单落盘 ----------
 * 真引擎把任务单写在 SQLite 里：**重启不丢**，开机会 `reconcile_on_start` 接着跑。
 * mock 不落盘的话，「重启之后界面别把旧结果当成新闻再报一遍」这条就永远测不到 ——
 * 而那正是用户实际报上来的那个毛病（每次启动都弹一次「XXX未选到」）。 */
const GRAB_TASKS_KEY = 'rein.mock.grabTasks'
/** 只有「id + 状态」变了才写盘：每次轮询都写太重，而重启后要复原的正是这份状态 */
let grabPersistKey = ''

function grabPersist(): void {
  const key = grabTasks.map((t) => `${t.id}:${t.status}`).join(',')
  if (key === grabPersistKey) return
  grabPersistKey = key
  try {
    localStorage.setItem(GRAB_TASKS_KEY, JSON.stringify(grabTasks))
  } catch {
    /* 存不下就算了：这份持久化是给「重启别重播」那条测试用的，不该反过来弄坏界面 */
  }
}

function grabHydrate(): void {
  try {
    const raw = localStorage.getItem(GRAB_TASKS_KEY)
    if (!raw) return
    const rows = JSON.parse(raw) as MockGrabTask[]
    if (!Array.isArray(rows) || !rows.length) return
    grabTasks.push(...rows)
    grabSeq = rows.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)
    grabPersistKey = rows.map((t) => `${t.id}:${t.status}`).join(',')
  } catch {
    /* 坏数据当没有：mock 不该因为一段脏 JSON 起不来 */
  }
}

grabHydrate()

let grabProbeSeq = 0
let grabLastEmit = ''

let grabSettings: GrabSettings = {
  minIntervalMs: 700,
  pollIntervalMs: 2000,
  fullRetryMs: 5000,
  backoffMs: 1500,
  maxBackoffMs: 30000,
  leadMs: 800,
  maxAttempts: 0,
  maxPolls: 15,
  cedeAfterMs: 0,
  watchWindow: true,
}

/* ---------------- 志愿组（与 Rust `grab.rs` 同一套规则） ----------------
 * 浏览器里没有那条后台线程，所以规则得在这儿再实现一遍 —— 但**必须同序**：
 * mock 与真引擎的行为只要分叉，e2e 就再也证明不了真引擎对不对。
 */
const GRAB_TERMINAL = new Set(['success', 'failed', 'conflict', 'cancelled', 'needs_ai'])

const grabGroupOf = (t: MockGrabTask): string => (t.groupKey ?? '').trim()

/** 是否已经让贤：连续满员超过期限（`cedeAfterMs === 0` 时恒为 false = 死守） */
function grabCeded(t: MockGrabTask, now: number): boolean {
  if (grabSettings.cedeAfterMs <= 0 || t.stuckSince == null) return false
  return now - t.stuckSince >= grabSettings.cedeAfterMs
}

/** 组里的当前志愿：还没结束的成员里 (priority, id) 最小的那个 */
function grabLead(group: string, now: number): MockGrabTask | null {
  const alive = grabTasks.filter(
    (t) => grabGroupOf(t) === group && !GRAB_TERMINAL.has(t.status) && t.status !== 'paused',
  )
  if (!alive.length) return null
  const fresh = alive.filter((t) => !grabCeded(t, now))
  // 整组都让贤了（罕见）就退回纯志愿序，否则整组会僵住
  const pool = fresh.length ? fresh : alive
  return pool.reduce((a, b) =>
    b.priority < a.priority || (b.priority === a.priority && b.id < a.id) ? b : a,
  )
}

/** 这个任务现在轮得到出手吗？不在组里的一律轮得到 */
function grabArmed(t: MockGrabTask, now: number): boolean {
  const g = grabGroupOf(t)
  if (!g) return true
  return grabLead(g, now)?.id === t.id
}

/** 同组有人中了：把其余还没结束的收摊（互斥志愿组的另一半保证） */
function grabCloseGroup(winner: MockGrabTask, now: number): void {
  const g = grabGroupOf(winner)
  if (!g) return
  const who = winner.courseName ?? winner.lessonName ?? '同组课程'
  for (const t of grabTasks) {
    if (grabGroupOf(t) !== g || t.id === winner.id || GRAB_TERMINAL.has(t.status)) continue
    t.status = 'cancelled'
    t.phase = 'idle'
    t.finishedAt = now
    t.lastMessage = `已被第 ${winner.priority} 志愿「${who}」抢先`
  }
}

/** 窗口监听的结果。`__REIN_MOCK_GRAB_TURNS__` 可以直接把批次摆出来（给 e2e 用）。 */
function grabTurns(): GrabTurnBrief[] {
  const g = globalThis as {
    __REIN_MOCK_GRAB_TURNS__?: GrabTurnBrief[]
    __REIN_MOCK_GRAB_NO_WINDOW__?: boolean
  }
  if (g.__REIN_MOCK_GRAB_TURNS__) return g.__REIN_MOCK_GRAB_TURNS__
  if (g.__REIN_MOCK_GRAB_NO_WINDOW__) return []
  const seen = new Map<string, GrabTurnBrief>()
  for (const t of grabTasks) {
    if (!t.windowWall || seen.has(t.turnId)) continue
    seen.set(t.turnId, {
      id: t.turnId,
      name: t.turnName,
      allowEnter: true,
      selectText: null,
      windowStart: t.windowWall,
      windowEnd: t.windowEndWall,
    })
  }
  return [...seen.values()]
}

/** 教务墙钟文本 → 本机毫秒。mock 里偏差恒为 0，所以按本地时区解析即可。 */
function grabWallToMs(text: string): number {
  const d = new Date(text.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

function grabWallOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ---------------- 计划的模糊匹配（与 Rust `matcher.rs` 同一套语义） ----------------
 *
 * mock 里必须再实现一遍：e2e 断言的是**界面显示出来的匹配与排序**，而它在真机上出自引擎。
 * 两边一旦分叉，这条 e2e 就什么都证明不了 —— 所以这里的规则逐条对齐 Rust：
 * 空格分词（每个词都要命中）、连续子串优先、退化为散落子序列、按抢课语义排序。 */

const GRAB_FIELD_WEIGHT: Record<string, number> = {
  course: 1,
  // 项目名与课程名同档：体育课所有项目的课程名都一样，学生嘴里的课名是项目名
  minor: 1,
  code: 0.85,
  teacher: 0.75,
  // 教学班名称（院系 / 校区 / 年级）：用来收窄，不是用来指认
  lesson: 0.7,
  place: 0.5,
}

function grabNormalize(s: string): string {
  return s.toLowerCase().replace(/[\s()（）[\]【】·\-_—/\\、,，.。:：]/g, '')
}

/** 散落子序列命中：字符按序出现即可，按「被打散的程度」扣分 */
function grabSubseqScore(hay: string, needle: string): number | null {
  if (!needle.length || needle.length > hay.length) return null
  let cursor = 0
  let first = -1
  let last = 0
  for (const ch of needle) {
    const at = hay.indexOf(ch, cursor)
    if (at < 0) return null
    if (first < 0) first = at
    last = at
    cursor = at + 1
  }
  const span = last - first + 1
  return 360 - (span - needle.length) * 12 - Math.min(40, first)
}

function grabFieldScore(text: string, token: string): number | null {
  const hay = grabNormalize(text)
  if (!hay) return null
  if (hay === token) return 1000
  const pos = hay.indexOf(token)
  if (pos >= 0) return 700 - Math.min(60, pos) + (pos === 0 ? 120 : 0)
  return grabSubseqScore(hay, token)
}

/** 一个教学班身上所有可匹配的文本（权重与 Rust 一致，课程名最重） */
function grabLessonFields(l: Record<string, any>): {
  tag: string
  text: string
  names?: string[]
}[] {
  const out: { tag: string; text: string; names?: string[] }[] = []
  const course = l.course ?? {}
  for (const name of [course.nameZh, course.nameEn]) {
    if (typeof name === 'string' && name.trim()) out.push({ tag: 'course', text: name })
  }
  if (typeof course.code === 'string' && course.code.trim()) out.push({ tag: 'code', text: course.code })
  // 项目名（体育课的「羽毛球」）：与课程名同档 —— 它才是学生嘴里的课名
  const minor = l.minorCourse ?? {}
  for (const name of [minor.nameZh, minor.nameEn]) {
    if (typeof name === 'string' && name.trim()) out.push({ tag: 'minor', text: name })
  }
  const teachers = (l.teachers ?? [])
    .map((t: any) => t?.nameZh ?? t?.person?.nameZh)
    .filter(Boolean)
  if (teachers.length) out.push({ tag: 'teacher', text: teachers.join('、'), names: teachers })
  // 教学班名称：院系 / 校区 / 年级的唯一出处
  if (typeof l.lessonName === 'string' && l.lessonName.trim()) {
    out.push({ tag: 'lesson', text: l.lessonName })
  }
  const place: string[] = []
  const walk = (v: any): void => {
    if (typeof v === 'string') place.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  ;(l.scheduleGroups ?? []).forEach((g: any) => walk(g?.dateTimePlace))
  if (place.length) out.push({ tag: 'place', text: place.join(' ') })
  return out
}

/* 教师命中分三档（与 Rust `matcher.rs` 逐条对齐）：
 *   精确 = 全名全等 → 那是「指定」，只抢这位老师的班（见 grabPreferred）
 *   普通 = 子串 / 子序列命中
 *   近似 = 姓对了、其余最多差一个字 → 名字打错时的退路，只加分不独占 */
const GRAB_TEACHER_EXACT_SCORE = 1000
const GRAB_TEACHER_NEAR_SCORE = 240

function grabLcsLen(a: string[], b: string[]): number {
  let prev = new Array(b.length + 1).fill(0)
  let cur = new Array(b.length + 1).fill(0)
  for (const ca of a) {
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = ca === b[j] ? prev[j] + 1 : Math.max(cur[j], prev[j + 1])
    }
    const t = prev
    prev = cur
    cur = t
    cur.fill(0)
  }
  return prev[b.length]
}

/** 「姓对了、其余最多差一个字」：单字查询不放行（那是子串匹配的活） */
function grabNearName(name: string, token: string): boolean {
  const n = [...grabNormalize(name)]
  const q = [...grabNormalize(token)]
  if (q.length < 2 || !n.length || n[0] !== q[0]) return false
  return grabLcsLen(n, q) + 1 >= q.length
}

/** 一个词在一个字段里的命中：教师字段精确 → 通用 → 近似，精确独占，其余取分高的 */
function grabFieldHit(
  f: { tag: string; text: string; names?: string[] },
  token: string,
): { score: number; tag: string } | null {
  const weight = GRAB_FIELD_WEIGHT[f.tag] ?? 1
  if (f.tag === 'teacher') {
    const names = f.names ?? []
    if (names.some((n) => grabNormalize(n) === token)) {
      return { score: Math.round(GRAB_TEACHER_EXACT_SCORE * weight), tag: 'teacherExact' }
    }
    const raw = grabFieldScore(f.text, token)
    const generic = raw == null ? null : { score: Math.round(raw * weight), tag: 'teacher' }
    const nearName = names.find((n) => grabNearName(n, token))
    const near = nearName
      ? {
          score: Math.round(
            (GRAB_TEACHER_NEAR_SCORE - Math.abs([...nearName].length - [...token].length) * 20) * weight,
          ),
          tag: 'teacherNear',
        }
      : null
    if (generic && near) return generic.score >= near.score ? generic : near
    return generic ?? near
  }
  const s = grabFieldScore(f.text, token)
  return s == null ? null : { score: Math.round(s * weight), tag: f.tag }
}

interface GrabHit {
  lesson: Record<string, any>
  score: number
  fields: string[]
  /** 有词**精确命中**了教师名 —— 「我就要这位老师的课」的唯一判据（与 Rust 同名） */
  hard: boolean
}

const grabRemaining = (l: Record<string, any>): number | null =>
  l.stdCount != null && l.limitCount != null ? l.limitCount - l.stdCount : null

/**
 * 放宽阶梯（与 Rust 侧 `matcher::match_lessons_relaxed` 同规矩）。
 *
 * 三条边界照搬：严格档有命中就不放宽；像人名的词永不丢；第二档只丢一个、
 * 而且丢的是**只落在时间地点上**的最笼统那个。mock 存在的意义就是「照 Rust 走」——
 * 两边不一致的 mock 比没有 mock 更坏：它会让界面测试全绿而真机全红。
 */
function grabRelaxedMatch(
  query: string,
  lessons: Record<string, any>[],
): { hits: GrabHit[]; dropped: string[]; relaxNote: string | null } {
  const strictHits = grabMatchLessons(query, lessons)
  const raw = query
    .split(/\s+/)
    .map(grabNormalize)
    .filter(Boolean)
  if (strictHits.length || raw.length < 2) {
    return { hits: strictHits, dropped: [], relaxNote: null }
  }

  const names = lessons.flatMap((l) =>
    (grabLessonFields(l).find((f) => f.tag === 'teacher')?.names ?? []).map(grabNormalize),
  )
  const looksLikeTeacher = (t: string): boolean => {
    const q = [...t]
    return names.some((n) => {
      const nc = [...n]
      return (nc.length >= q.length && nc.slice(0, q.length).join('') === q.join('')) || grabNearName(n, t)
    })
  }
  const looksLikeConstraint = (t: string): boolean => {
    const cs = [...t]
    const codeShaped = cs.every((c) => /[0-9a-zA-Z]/.test(c)) && cs.some((c) => /[0-9]/.test(c))
    const nameShaped = cs.every((c) => c.charCodeAt(0) > 0x7f) && cs.length >= 2 && cs.length <= 3
    return codeShaped || nameShaped || looksLikeTeacher(t)
  }
  const coverage = raw.map((token) => {
    let count = 0
    let identity = false
    let course = false
    for (const l of lessons) {
      for (const f of grabLessonFields(l)) {
        const h = grabFieldHit(f, token)
        if (!h) continue
        count += 1
        if (h.tag === 'course' || h.tag === 'code' || h.tag === 'minor') course = true
        if (['course', 'code', 'minor', 'teacher', 'teacherExact', 'teacherNear'].includes(h.tag)) {
          identity = true
        }
        break
      }
    }
    return { count, identity, course }
  })
  /** 丢完之后还认不认得是哪门课（与 Rust 的 `keeps_the_course` 同规矩）。
   *  项目名算「认得」—— 体育课里「羽毛球」就是那门课的名字。 */
  const keepsTheCourse = (tokens: string[]): boolean =>
    tokens.some((token) =>
      lessons.some((l) =>
        grabLessonFields(l).some(
          (f) => (f.tag === 'course' || f.tag === 'code' || f.tag === 'minor') && grabFieldHit(f, token),
        ),
      ),
    )

  // 第一档：丢掉一个班都没命中、又不像硬约束的词
  const keep = raw.filter((t, i) => !(coverage[i]!.count === 0 && !looksLikeConstraint(t)))
  const dropped = raw.filter((t, i) => coverage[i]!.count === 0 && !looksLikeConstraint(t))
  if (dropped.length && keep.length && keepsTheCourse(keep)) {
    const hits = grabMatchLessons(keep.join(' '), lessons)
    if (hits.length) return { hits, dropped, relaxNote: '已放宽：忽略了名单里查不到的词' }
  }

  // 第二档：只剩纯时间地点词彼此对不上时，丢最不挑人的那个
  const live = raw.map((_, i) => i).filter((i) => coverage[i]!.count > 0)
  if (live.length >= 2) {
    const common = live.filter((i) => !coverage[i]!.identity).sort((a, b) => coverage[b]!.count - coverage[a]!.count)[0]
    if (common != null) {
      const keep2 = keep.filter((t) => t !== raw[common])
      const hits = keep2.length && keepsTheCourse(keep2) ? grabMatchLessons(keep2.join(' '), lessons) : []
      if (hits.length) {
        return { hits, dropped: [...dropped, raw[common]!], relaxNote: '已放宽：忽略了太笼统的词' }
      }
    }
  }
  return { hits: [], dropped: [], relaxNote: null }
}

function grabMatchLessons(query: string, lessons: Record<string, any>[]): GrabHit[] {
  const tokens = query
    .split(/\s+/)
    .map(grabNormalize)
    .filter(Boolean)
  if (!tokens.length) return []

  const hits: GrabHit[] = []
  for (const l of lessons) {
    const fields = grabLessonFields(l)
    const used: string[] = []
    let total = 0
    let hard = false
    let ok = true
    for (const token of tokens) {
      // 一个词可能同时落在多个字段上：分数取最高，但每个命中都记下来 ——
      // 精确命中的教师不能被课名那次更高的分吞掉
      let best: number | null = null
      for (const f of fields) {
        const h = grabFieldHit(f, token)
        if (!h) continue
        best = best == null ? h.score : Math.max(best, h.score)
        if (h.tag === 'teacherExact') hard = true
        if (!used.includes(h.tag)) used.push(h.tag)
      }
      if (best == null) {
        ok = false
        break
      }
      total += best
    }
    if (ok) hits.push({ lesson: l, score: total, fields: used, hard })
  }

  // 抢课语义的排序：没选过的在前 → **精确指定了老师的在前** → 分高的在前 →
  // 有空位的在前 → 余量多的在前 → id 稳定。
  // 分在空位之前（与 Rust 同序）：查「张玮」时满员的「张伟」不能被有余量的
  // 「张伟明」挤到后面 —— 一个错字不该让目标换人。
  hits.sort((a, b) => {
    const pick = Number(a.lesson.selectedLesson != null) - Number(b.lesson.selectedLesson != null)
    if (pick) return pick
    const hard = Number(!a.hard) - Number(!b.hard)
    if (hard) return hard
    if (a.score !== b.score) return b.score - a.score
    const ra = grabRemaining(a.lesson)
    const rb = grabRemaining(b.lesson)
    const full = Number(ra != null && ra <= 0) - Number(rb != null && rb <= 0)
    if (full) return full
    const left = (rb ?? -1) - (ra ?? -1)
    if (left) return left
    return Number(a.lesson.id) - Number(b.lesson.id)
  })
  return hits
}

/**
 * 计划要抢的那一批（与 Rust `matcher::preferred` 同规则）：
 * 打全了老师名字 → 只抢那位老师的班；只打姓 / 打错字 → 原样返回，交给模糊匹配。
 */
function grabPreferred(hits: GrabHit[]): GrabHit[] {
  return hits.some((h) => h.hard) ? hits.filter((h) => h.hard) : hits
}

/**
 * 这个班**怎么和同门课的其他班区分开**（与 Rust `matcher::distinct_label` 同规矩）。
 *
 * 项目名优先：体育课 8 个项目的课程名全都叫「大学体育1」，
 * 任务行只写课程名，用户认不出哪条是羽毛球。没有项目名时退到教学班名称。
 */
function grabDistinctLabel(l: Record<string, any>): string | null {
  const minor = l.minorCourse?.nameZh ?? l.minorCourse?.nameEn
  if (typeof minor === 'string' && minor.trim()) return minor.trim()
  return typeof l.lessonName === 'string' && l.lessonName.trim() ? l.lessonName.trim() : null
}

/** 命中 → 界面形状（与 Rust `matcher::to_match` 同形） */
function grabMatchDto(h: GrabHit): GrabMatch {
  const l = h.lesson
  const teachers = (l.teachers ?? []).map((t: any) => t?.nameZh ?? t?.person?.nameZh).filter(Boolean)
  return {
    lessonId: l.id,
    courseName: l.course?.nameZh ?? l.course?.nameEn ?? null,
    courseCode: l.course?.code ?? null,
    teacher: teachers.length ? teachers.join('、') : null,
    stdCount: l.stdCount ?? null,
    limitCount: l.limitCount ?? null,
    picked: l.selectedLesson != null,
    fields: h.fields,
    // 同门课的班必须能被区分：体育课 8 个项目的课程名一模一样
    lessonName: typeof l.lessonName === 'string' && l.lessonName.trim() ? l.lessonName.trim() : null,
    minorName:
      typeof l.minorCourse?.nameZh === 'string' && l.minorCourse.nameZh.trim()
        ? l.minorCourse.nameZh.trim()
        : null,
  }
}

/** 命中分堆：默认合成一组（只中一个），`spread` 时按课程分堆（每门课各中一个） */
function grabPlanGroups(hits: GrabHit[], spread: boolean): GrabHit[][] {
  const grabbable = hits.filter((h) => h.lesson.selectedLesson == null)
  if (!grabbable.length) return []
  if (!spread) return [grabbable]
  const order: string[] = []
  const buckets = new Map<string, GrabHit[]>()
  for (const h of grabbable) {
    const c = h.lesson.course ?? {}
    const key = c.code?.trim() || c.nameZh?.trim() || String(h.lesson.id)
    if (!buckets.has(key)) order.push(key)
    const list = buckets.get(key) ?? []
    list.push(h)
    buckets.set(key, list)
  }
  return order.map((k) => buckets.get(k)!)
}

/* ---------------- 抢课计划（意向） ---------------- */

/**
 * 「这句查询跨了哪几门课」—— 与 Rust 的 `matcher::ambiguous_courses` 同一条规则。
 *
 * 跨课程 = 命中的是**两个不同的课程代码**：年级双开的体育课最典型（大一 000031 / 大二 000006）。
 * 「中一个就够」时这属于理解错了，引擎不该闷头排队（会把大二那门也排进来），
 * 而要让人补上课程代码；「每门课都要」（spread）是例外。
 */
function grabAmbiguousCourses(query: string, pool: GrabHit[]): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = []
  for (const h of pool) {
    const code = String(h.lesson.course?.code ?? '').trim()
    if (!code || out.some((o) => o.code === code)) continue
    out.push({ code, name: String(h.lesson.course?.nameZh ?? '').trim() })
  }
  if (out.length <= 1) return []
  const tokens = query.split(/\s+/).map((t) => t.trim()).filter(Boolean)
  if (out.some((o) => tokens.includes(o.code))) return []
  return out
}

/** 计划解析失败/没匹配到之后的重试间隔（真引擎是 60 秒，mock 压到 2 秒） */
const GRAB_INTENT_RETRY_MS = 2000

interface MockGrabIntent extends GrabIntent {
  /** mock 内部：下一次该重试解析的时刻 */
  nextAt: number
}

const grabIntents: MockGrabIntent[] = []
let grabIntentSeq = 0

/** 批次摘要：与真引擎读的 `open-turns` 对应（mock 里就是那个演示批次） */
function grabIntentBriefs(): GrabTurnBrief[] {
  const noWindow = !!(globalThis as { __REIN_MOCK_GRAB_NO_WINDOW__?: boolean })
    .__REIN_MOCK_GRAB_NO_WINDOW__
  return campusSelectTurns().map((t) => ({
    id: String(t.id),
    name: t.name ?? null,
    allowEnter: !!t.allowEnter,
    selectText: t.selectDateTimeText ?? null,
    windowStart: noWindow ? null : (t.selectDateTimeRange?.startDateTime ?? null),
    windowEnd: noWindow ? null : (t.selectDateTimeRange?.endDateTime ?? null),
  }))
}

/**
 * 解析一条到点的计划 —— 与真引擎同序：挑批次 → 拉名单 → 模糊匹配 → 分堆建任务。
 * 一轮只做一条，返回「有没有干活」。
 */
function grabResolveIntents(): boolean {
  const now = Date.now()
  const due = grabIntents.find(
    (i) => (i.status === 'pending' || i.status === 'empty' || i.status === 'ambiguous') && i.nextAt <= now,
  )
  if (!due) return false
  due.attempts += 1

  const briefs = grabIntentBriefs()
  const brief = due.turnId
    ? briefs.find((b) => b.id === due.turnId)
    : (briefs.find((b) => b.allowEnter) ?? briefs[0])
  if (!brief) {
    due.status = 'pending'
    due.lastMessage = '还没看到这个选课批次，教务公布后会自动继续'
    due.nextAt = now + GRAB_INTENT_RETRY_MS
    return true
  }
  due.turnId = brief.id
  due.turnName = brief.name ?? null

  const hits = grabMatchLessons(due.query, campusDemoLessons())
  // 打全了老师名字 → 那是指定，只抢他的班；只打姓 / 打错字 → 模糊匹配照旧
  const pool = grabPreferred(hits)
  const pickedOff = hits.length - pool.length

  // 跨课程（年级双开那种）：不排队，把课程代码摆出来让人补 —— 与 Rust 同一条闸门
  if (!due.spread) {
    const amb = grabAmbiguousCourses(due.query, pool)
    if (amb.length) {
      const list = amb.map((c) => (c.name ? `${c.code} ${c.name}` : c.code)).join(' / ')
      const sample = amb[0]!.name ? `${amb[0]!.name} ${amb[0]!.code}` : amb[0]!.code
      due.status = 'ambiguous'
      due.lastMessage = `「${due.query}」同时命中 ${amb.length} 门课：${list} —— 补上课程代码就只抢那一门（例如「${sample}」）`
      due.nextAt = now + GRAB_INTENT_RETRY_MS
      return true
    }
  }

  const groups = grabPlanGroups(pool, !!due.spread)
  if (!groups.length) {
    due.status = 'empty'
    due.lastMessage = hits.length
      ? '匹配到的教学班都已经在你名下了'
      : `没匹配到「${due.query}」—— 课名 / 课程代码 / 教师名都可以，空格分词`
    due.nextAt = now + GRAB_INTENT_RETRY_MS
    return true
  }

  const awaitWindow = !brief.windowStart && !brief.allowEnter
  const keys: string[] = []
  let created = 0
  groups.forEach((group, gi) => {
    // 与 Rust 一致：一条计划生成的组用 `intent-{id}` 起头，界面靠它把任务归到计划名下
    const key = groups.length === 1 ? `intent-${due.id}` : `intent-${due.id}-${gi + 1}`
    const groupName = (due.spread ? group[0]?.lesson.course?.nameZh : null) ?? due.query
    let made = false
    group.forEach((h, i) => {
      if (grabTasks.some((t) => String(t.lessonId) === String(h.lesson.id) && !GRAB_TERMINAL.has(t.status))) {
        return // 同一门课已经在抢了
      }
      grabPushTask({
        turnId: brief.id,
        turnName: brief.name,
        lessonId: h.lesson.id,
        // 任务行上那一小段能分辨它的文字：**项目名优先**。
        // 体育课所有项目的课程名都叫「大学体育1」，只写课程名的话，
        // 用户看着自己排的 8 条任务认不出哪条是羽毛球（与 Rust `distinct_label` 同规矩）。
        lessonName: grabDistinctLabel(h.lesson),
        courseName: h.lesson.course?.nameZh ?? null,
        courseCode: h.lesson.course?.code ?? null,
        teacher: grabMatchDto(h).teacher,
        credits: h.lesson.course?.credits ?? null,
        mode: due.mode,
        scheduleGroupId: h.lesson.scheduleGroups?.length === 1 ? h.lesson.scheduleGroups[0].id : null,
        windowWall: brief.windowStart ?? null,
        windowEndWall: brief.windowEnd ?? null,
        awaitWindow,
        groupKey: key,
        groupName,
        priority: i + 1,
      })
      made = true
      created += 1
    })
    if (made) keys.push(key)
  })

  due.status = 'ready'
  due.groupKeys = keys
  // 候选只列**真会抢的**那些班：被「指定老师」筛掉的不列出来，
  // 否则用户会问「为什么预览里有它、任务单里没有」
  due.candidates = pool.slice(0, 12).map(grabMatchDto)
  due.resolvedAt = now
  due.nextAt = now
  // 指定了老师就明说一句 —— 用户下次看到这条计划时，那是解释而不是意外
  const byTeacher = pickedOff > 0 ? `，只抢指定教师的班（另有 ${pickedOff} 个匹配被滤掉）` : ''
  due.lastMessage =
    created === 0
      ? '这些教学班都已经在抢了'
      : groups.length > 1
        ? `已为 ${groups.length} 门课各排一组，共 ${created} 个志愿${byTeacher}`
        : `已排入 ${created} 个志愿，按序出手${byTeacher}`
  return true
}

/** 造一条任务 —— 手动入队与计划解析共用同一形状（否则两种来源的任务会长得不一样） */
function grabPushTask(input: {
  turnId: string
  turnName?: string | null
  lessonId: unknown
  lessonName?: string | null
  courseName?: string | null
  courseCode?: string | null
  teacher?: string | null
  credits?: number | null
  mode: 'predicate' | 'direct'
  virtualCost?: number | null
  scheduleGroupId?: unknown
  windowWall?: string | null
  windowEndWall?: string | null
  awaitWindow?: boolean
  groupKey?: string | null
  groupName?: string | null
  priority?: number
}): MockGrabTask {
  const id = ++grabSeq
  const windowWall = input.windowWall ?? null
  const task: MockGrabTask = {
    id,
    turnId: input.turnId,
    turnName: input.turnName ?? null,
    lessonId: input.lessonId,
    lessonName: input.lessonName ?? null,
    courseName: input.courseName ?? null,
    courseCode: input.courseCode ?? null,
    teacher: input.teacher ?? null,
    credits: input.credits ?? null,
    mode: input.mode,
    virtualCost: input.virtualCost ?? null,
    scheduleGroupId: input.scheduleGroupId ?? null,
    windowWall,
    windowEndWall: input.windowEndWall ?? null,
    // 没有窗口就往「等窗口」走 —— 盲撞出来的「不在选课时间」会被判终态
    awaitWindow: input.awaitWindow ?? !windowWall,
    predicateDone: false,
    status: 'waiting',
    phase: 'idle',
    attempts: 0,
    polls: 0,
    strikes: 0,
    strikeKind: null,
    requestId: null,
    lastMessage: windowWall ? `已排队，${windowWall} 开抢` : '等待教务公布选课窗口',
    nextAt: Date.now(),
    fireAt: null,
    queuedAt: Date.now(),
    finishedAt: null,
    groupKey: input.groupKey ?? null,
    groupName: input.groupName ?? null,
    priority: input.priority ?? 0,
    stuckSince: null,
    heldBy: null,
  }
  grabTasks.unshift(task)
  return task
}

function grabSnapshot(): GrabState {
  const now = Date.now()
  const active = grabTasks.some((t) => t.status === 'waiting' || t.status === 'running')
  // 派生值：谁被谁压着。与真引擎一样在快照这一层算，不落库
  const leads = new Map<string, number>()
  for (const t of grabTasks) {
    const g = grabGroupOf(t)
    if (!g || leads.has(g)) continue
    const lead = grabLead(g, now)
    if (lead) leads.set(g, lead.id)
  }
  return {
    alive: true,
    // mock 里引擎总是「在跑」：浏览器的假引擎没有真门闩，开关由插件层管（入口/路由），
    // 而 e2e 要验的是插件层那部分。真后端才有真门闩（grab.rs 的 ENABLED_KEY）。
    enabled: true,
    active,
    serverTime: grabWallOf(now),
    skewSec: 0,
    nextAt: grabTasks
      .filter((t) => t.status === 'waiting' || t.status === 'running')
      .reduce<number | null>((min, t) => (min == null ? t.nextAt : Math.min(min, t.nextAt)), null),
    nextFireAt: grabTasks
      .filter((t) => t.status === 'waiting' || t.status === 'running')
      .reduce<number | null>(
        (min, t) => (t.fireAt == null ? min : min == null ? t.fireAt : Math.min(min, t.fireAt)),
        null,
      ),
    lastError: null,
    turns: grabTurns(),
    probedAt: now,
    intents: grabIntents.map((i) => ({
      ...i,
      groupKeys: [...(i.groupKeys ?? [])],
      candidates: [...(i.candidates ?? [])],
    })),
    tasks: grabTasks.map((t) => {
      const g = grabGroupOf(t)
      const lead = g ? leads.get(g) : undefined
      // 只有还在场上的才谈得上被谁压着：终态/暂停的任务不在等任何人
      const inPlay = !GRAB_TERMINAL.has(t.status) && t.status !== 'paused'
      return { ...t, heldBy: inPlay && lead != null && lead !== t.id ? lead : null }
    }) as unknown as GrabState['tasks'],
  }
}

function grabEmit(): void {
  // 落盘放在去重**之前**：去重管的是「要不要推给界面」，而落盘管的是
  // 「重启之后还认不认得这份任务单」—— 后者不该因为界面恰好不需要更新就漏掉
  grabPersist()
  const snap = grabSnapshot()
  const json = JSON.stringify(snap)
  if (json === grabLastEmit) return
  grabLastEmit = json
  mockCampus.onGrab?.(snap)
}

/** 一轮推进：与 Rust 引擎同序 —— 先过窗口闸门，再做一步提交或轮询。 */
function grabTick(): void {
  const now = Date.now()
  // 先解析计划：它可能要新建任务（下面那一轮循环立刻就能推进它们）
  let worked = grabResolveIntents()

  for (const t of grabTasks) {
    if (t.status !== 'waiting' && t.status !== 'running') continue

    // ① 窗口还没公布：定期去「问」一次（3 秒后公布，用来演示等窗口这个真实状态）
    if (t.awaitWindow && !t.windowWall) {
      t.probeAt ??= now + GRAB_PROBE_MS
      if (now >= t.probeAt) {
        t.windowWall = grabWallOf(now)
        t.windowEndWall = grabWallOf(now + 6 * 3600_000)
        t.awaitWindow = false
        t.lastMessage = `已获知选课窗口：${t.windowWall} 开放`
        t.nextAt = now
        worked = true
      } else {
        t.lastMessage = '等待教务公布选课窗口'
        continue
      }
    }

    // ② 志愿组：没轮到它就站着别动 —— 也不参与任何计时推进。
    //    排在窗口探测之后：探测是引擎级的事，跟轮到谁出手无关。
    if (!grabArmed(t, now)) continue

    // ③ 开窗闸门：**没到点绝不出手**。闸门只管第一枪 ——
    //    交过占位或正式提交过之后，任务就完全由重试节奏支配了。
    t.fireAt =
      t.attempts === 0 && !t.predicateDone && t.windowWall
        ? grabWallToMs(t.windowWall) - grabSettings.leadMs
        : null
    if (t.fireAt != null && now < t.fireAt) continue
    if (now < t.nextAt) continue

    t.queuedAt ||= now
    t.status = 'running'

    if (t.phase === 'poll' && t.requestId) {
      t.polls += 1
      if (t.polls < 2) {
        t.lastMessage = '教务处理中'
        t.nextAt = now + GRAB_POLL_MS
        worked = true
        continue
      }
      // 占位落定 → 转正式确认（这一步不留间隔）。
      // **判据是「手里这张是占位单」**，与真引擎的 `polls_predicate()` 同义。
      // 写成 `mode==='predicate' && !predicateDone` 就会永远不成立（占位交上时
      // predicateDone 已经是 true），于是占位单被当成最终结果、正式的确认请求
      // 一辈子发不出去 —— 真引擎那边正好也踩过这个坑。
      if (t.pollingPredicate) {
        t.pollingPredicate = false
        t.phase = 'submit'
        t.requestId = null
        t.polls = 0
        t.nextAt = now
        t.lastMessage = '占位成功，正在正式确认'
        worked = true
        continue
      }
      // 正式提交的结果
      const id = Number(t.lessonId)
      if (id === 9003) {
        t.status = 'conflict'
        t.phase = 'idle'
        t.finishedAt = now
        t.lastMessage = '与已选课程时间冲突，需到教务网页端办理免听'
        worked = true
        continue
      }
      t.fullTimes = t.fullTimes ?? 0
      if (id === 9005 && t.fullTimes < 2) {
        t.fullTimes += 1
        t.strikes += 1
        t.strikeKind = 'full'
        // 满员是持续状态：记下起点，「让贤期限」才有东西可读
        t.stuckSince ??= now
        t.status = 'waiting'
        t.phase = 'idle'
        t.lastMessage = '已选人数已达上限'
        t.nextAt = now + GRAB_POLL_MS
        worked = true
        continue
      }
      campusPickedLessons.add(id)
      t.status = 'success'
      t.phase = 'idle'
      t.requestId = null
      t.finishedAt = now
      t.lastMessage = '已抢到'
      // 中选即收组：同组备选与它互斥，继续抢只会多抢到一门冲突课
      grabCloseGroup(t, now)
      worked = true
      continue
    }

    // ③' **故障注入**：让 e2e 能在浏览器里把三类应急各走一遍（真机上这些由教务自己触发）。
    //     注入的是「教务的原话」，判定走下面那份与 Rust 同形的关键词表 ——
    //     这样浏览器里验的就是同一套分档语义，而不是给测试另开一条捷径。
    const faultMsg = mockGrabFaultMessage()
    if (faultMsg) {
      const kind = mockGrabVerdict(faultMsg)
      if (kind === 'badreq') {
        t.status = 'needs_ai'
        t.phase = 'idle'
        t.requestId = null
        t.strikes = 1
        t.strikeKind = 'badreq'
        t.finishedAt = now
        t.lastMessage = `请求被教务拒绝（参数错误），已停下等 AI 排查：${faultMsg}`
        clearMockGrabFault() // 一次性：AI 查清后重新排队就该能成功
        worked = true
        continue
      }
      if (kind === 'throttled' || kind === 'server') {
        t.attempts += 1 // 请求确实发出去了，真机也这么算
        t.status = 'waiting'
        t.phase = 'idle'
        t.requestId = null
        t.strikes = 0 // 对方的状态不记在这条任务账上
        t.strikeKind = kind
        t.lastMessage =
          (kind === 'throttled' ? '教务在限速（继续按节奏重试）' : '教务服务器出错（继续重试）') + `：${faultMsg}`
        t.nextAt = now // **不退避**：立刻回到队首，节奏交给节流闸门
        worked = true
        continue
      }
    }

    // ③ 提交一步
    if (t.mode === 'predicate' && !t.predicateDone) {
      // 占位：只是占住队列位次，**不是**最终提交（正式确认在下一轮）
      t.phase = 'poll'
      t.predicateDone = true
      t.pollingPredicate = true
      t.requestId = `gp${++grabProbeSeq}`
      t.polls = 0
      t.lastMessage = '已占位，等待教务受理'
      t.nextAt = now + GRAB_POLL_MS
    } else {
      t.attempts += 1
      t.phase = 'poll'
      t.requestId = `gr${++grabProbeSeq}`
      t.polls = 0
      t.lastMessage =
        t.attempts === 1 ? '已提交，等待教务处理' : `第 ${t.attempts} 次提交，等待教务处理`
      t.nextAt = now + GRAB_POLL_MS
    }
    worked = true
  }

  if (worked) grabEmit()
}

setInterval(grabTick, 250)

/* ---------- 抢课的三类应急：mock 侧的故障注入与同形分档 ----------
 *
 * e2e 用 `window.__REIN_MOCK_GRAB_FAULT__` 注入一段「教务的原话」：
 *   '请求过于频繁，请稍后再试' → 限流（继续打，不退避）
 *   '选课接口失败：HTTP 503'   → 服务器出错（同样继续打）
 *   '请求参数错误：缺少 assoc' → 参数错误（停下，交给 AI）
 * 也可以用简写 'throttle' / 'server' / 'params'。
 *
 * 判定表与 Rust `grab.rs::verdict_of` 的应急三档逐条对齐 —— 这里只覆盖这三档，
 * 兜底一律按「可重试」（真机上那段长表在 Rust 里，浏览器 mock 只服务测试）。
 */
const MOCK_GRAB_FAULT_ALIASES: Record<string, string> = {
  throttle: '请求过于频繁，请稍后再试',
  server: '选课接口失败：HTTP 503',
  params: '请求参数错误：缺少 assoc',
}

function mockGrabFaultMessage(): string {
  if (typeof window === 'undefined') return ''
  const raw = (window as unknown as Record<string, unknown>).__REIN_MOCK_GRAB_FAULT__
  if (typeof raw !== 'string' || !raw) return ''
  return MOCK_GRAB_FAULT_ALIASES[raw] ?? raw
}

function clearMockGrabFault(): void {
  if (typeof window === 'undefined') return
  delete (window as unknown as Record<string, unknown>).__REIN_MOCK_GRAB_FAULT__
}

function mockGrabVerdict(message: string): 'throttled' | 'server' | 'badreq' | 'retry' {
  const m = message.trim()
  const lower = m.toLowerCase()
  const hit = (kws: string[]) => kws.some((k) => m.includes(k) || lower.includes(k))
  if (
    hit([
      '请求过于频繁', '操作过于频繁', '请求频繁', '访问频繁', '请求过多', '请求太多',
      '请求太快', '频率超限', '超出频率', '频率限制', '限流', 'too many requests', 'rate limit', '429',
    ])
  ) {
    return 'throttled'
  }
  if (
    hit([
      '服务器内部错误', '服务异常', '服务器异常', '系统异常', '服务器繁忙', '系统繁忙',
      '服务不可用', '服务器维护', '连接被重置', '连接重置', '502', '503', '504', '500',
      'bad gateway', 'service unavailable', 'internal server error', 'connection reset',
    ])
  ) {
    return 'server'
  }
  if (
    hit([
      '参数错误', '参数有误', '参数不合法', '参数无效', '参数不正确', '参数校验', '缺少参数',
      '缺少必填', '非法参数', '请求参数', '格式错误', '格式不正确', '反序列化',
      'bad request', 'unprocessable', '400', '422',
    ])
  ) {
    return 'badreq'
  }
  return 'retry'
}

function grabFind(id: number): MockGrabTask | undefined {
  return grabTasks.find((t) => t.id === id)
}


/* ---------- 在线更新（mock：把「检查 → 下载 → 装」整条链路在浏览器里跑通） ----------
 *
 * 浏览器里没有 Rust 的 UpdateHub，也没有真实网络，所以这里自己维护一份同形的
 * 状态机，连**控制开关**都对齐真机的复杂度来源：
 *   window.__REIN_MOCK_UPDATE_NONE__    = true  → 检查结果「已是最新」
 *   window.__REIN_MOCK_SERVICE_OFFLINE__ = true → 在线服务探测不可达
 *   window.__REIN_MOCK_UPDATE_FAIL__     = true → 下载必定失败（用来验失败态与重试入口）
 * 唯一压缩的是时间尺度：3 秒下完，而不是真下几十 MB。
 */

const MOCK_CURRENT_VERSION = '0.2.1'
const MOCK_LATEST_VERSION = '0.2.2'

function mockFlag(name: string): boolean {
  return typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)[name] === true
}

function defaultUpdateSettings(): UpdateSettings {
  return {
    enabled: true,
    channel: 'stable',
    autoCheck: true,
    checkIntervalHours: 12,
    lastCheckAt: null,
    lastSeenVersion: null,
    ignoredVersion: null,
    allowHttp: true,
    silentInstall: false,
    sources: [
      {
        id: 'rein-service',
        name: 'Rein 在线服务',
        kind: 'rein',
        url: 'http://47.100.36.179:8787/updates/latest.json',
        enabled: true,
        priority: 0,
      },
      {
        id: 'github',
        name: 'GitHub Release',
        kind: 'tauri-static',
        url: 'https://github.com/gozaoo-coder/Rein/releases/latest/download/latest.json',
        enabled: true,
        priority: 10,
      },
    ],
  }
}

let updateSettings: UpdateSettings = defaultUpdateSettings()
let updateCheck: UpdateCheck | null = null
let updateDownload: DownloadState = idleDownload()
let updateTimer: ReturnType<typeof setInterval> | null = null

function idleDownload(): DownloadState {
  return {
    phase: 'idle',
    version: null,
    target: 'windows-x86_64',
    url: null,
    sourceName: null,
    received: 0,
    total: 0,
    bytesPerSec: 0,
    percent: 0,
    file: null,
    verified: false,
    error: null,
    startedAt: null,
    updatedAt: null,
  }
}

function stopUpdateTimer(): void {
  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }
}

/** 演示用：下载进度按 200ms 一跳走满，然后进入「校验 → 就绪」。 */
function startMockDownload(): void {
  const total = 42 * 1024 * 1024
  updateDownload = {
    ...idleDownload(),
    phase: 'downloading',
    version: MOCK_LATEST_VERSION,
    url: 'http://47.100.36.179:8787/dl/stable/0.2.1/Rein-0.2.1-arm64.apk',
    sourceName: 'Rein 在线服务',
    total,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  stopUpdateTimer()
  updateTimer = setInterval(() => {
    if (updateDownload.phase !== 'downloading') return
    const next = Math.min(total, updateDownload.received + total / 15)
    updateDownload = {
      ...updateDownload,
      received: next,
      bytesPerSec: total / 15 / 0.2,
      percent: (next / total) * 100,
      updatedAt: new Date().toISOString(),
    }
    if (next >= total) {
      updateDownload = { ...updateDownload, phase: 'verifying', updatedAt: new Date().toISOString() }
      setTimeout(() => {
        if (mockFlag('__REIN_MOCK_UPDATE_FAIL__')) {
          updateDownload = {
            ...updateDownload,
            phase: 'failed',
            verified: false,
            error: '安装包签名校验失败：签名 keyId 与内置公钥不匹配',
          }
          return
        }
        updateDownload = {
          ...updateDownload,
          phase: 'ready',
          verified: true,
          file: 'updates/Rein-0.2.1-arm64.apk',
          updatedAt: new Date().toISOString(),
        }
      }, 600)
    }
  }, 200)
}

function updateSnapshot(): UpdateSnapshot {
  return {
    currentVersion: MOCK_CURRENT_VERSION,
    platform: 'windows-x86_64',
    installSupported: true,
    installHint: '下载完成后会静默运行安装器并重启应用',
    settings: updateSettings,
    check: updateCheck,
    download: updateDownload,
    readyToInstall: updateDownload.verified,
  }
}

export async function mockInvoke<T>(cmd: string, args: Args = {}): Promise<T> {
  switch (cmd) {
    case 'list_foods': {
      const q = String(args.query ?? '').toLowerCase()
      const cat = args.category as string | null
      const limit = Number(args.limit ?? 60)
      const list = foods.filter(
        (f) =>
          (!q || f.name.toLowerCase().includes(q) || (f.category ?? '').toLowerCase().includes(q)) &&
          (!cat || f.category === cat),
      )
      return delay(list.slice(0, limit) as T)
    }

    case 'search_foods_fuzzy': {
      const q = String(args.query ?? '').trim()
      const limit = Number(args.limit ?? 20)
      if (!q) return delay(foods.slice(0, limit) as T)
      const scored = foods
        .map((f) => ({ f, s: mockFuzzyScore(q, f.name) }))
        .filter((x) => x.s >= 35)
        .sort((a, b) => b.s - a.s || a.f.name.length - b.f.name.length || a.f.id - b.f.id)
      return delay(scored.slice(0, limit).map((x) => x.f) as T)
    }

    case 'web_search':
    case 'web_fetch': {
      const url =
        cmd === 'web_search'
          ? // 与 Rust 侧同一组参数（zh 市场/语言），免得开发态与真机的搜索质量不一致
            `https://www.bing.com/search?q=${encodeURIComponent(String(args.query ?? '').trim())}&setmkt=zh-CN&setlang=zh-Hans`
          : String(args.url ?? '')
      if (!url) throw new Error('搜索关键词或 URL 不能为空')
      const maxChars = Number(args.maxChars ?? 6000)
      try {
        return delay((await mockWebFetch(url, maxChars)) as T)
      } catch (e) {
        throw new Error(
          `浏览器开发环境无法抓取网页（CORS 限制：${e instanceof Error ? e.message : String(e)}），请在 Tauri 桌面端使用 web 工具`,
          { cause: e },
        )
      }
    }

    case 'share_poll':
      // 浏览器开发环境没有系统分享收件箱
      return delay([] as T)

    case 'share_read':
      throw new Error('浏览器开发环境没有分享收件箱')

    // media（HEIF→JPEG）：纯浏览器没有原生解码器，报错让前端降级到内置软件解码
    case 'image_decode_heif':
      throw new Error('浏览器开发环境没有原生 HEIF 解码')

    case 'get_food': {
      const f = foods.find((x) => x.id === Number(args.id)) ?? null
      return delay((f ? structuredClone(f) : null) as T)
    }

    case 'create_food': {
      const input = plain(args.food as FoodCreateInput)
      const name = input.name.trim()
      const exist = foods.find((x) => x.name === name)
      if (exist) return delay({ food: structuredClone(exist), created: false } as T)
      const food: Food = {
        id: ++foodId,
        name,
        category: input.category ?? null,
        ...zeroIntake(),
        kcal: Number(input.kcal) || 0,
        protein: Number(input.protein) || 0,
        carb: Number(input.carb) || 0,
        fat: Number(input.fat) || 0,
        fiber: Number(input.fiber) || 0,
        sugar: Number(input.sugar) || 0,
        sodiumMg: Number(input.sodiumMg) || 0,
        defaultUnit: input.defaultUnit ?? null,
        units: (input.units ?? []).map((u) => ({ name: String(u.name), grams: Number(u.grams) || 0 })),
      }
      foods.push(food)
      return delay({ food: structuredClone(food), created: true } as T)
    }

    case 'list_meals': {
      const date = String(args.date)
      const list = meals
        .filter((m) => m.date === date)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return delay(structuredClone(list) as T)
    }

    case 'list_meals_range': {
      const start = String(args.startDate)
      const end = String(args.endDate)
      const list = meals
        .filter((m) => m.date >= start && m.date <= end)
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      return delay(structuredClone(list) as T)
    }

    case 'log_meal': {
      const f = foods.find((x) => x.id === args.foodId)!
      const log: MealLog = {
        id: ++mealId,
        foodId: f.id,
        date: String(args.date),
        mealType: args.mealType as MealLog['mealType'],
        quantityMode: args.quantityMode as MealLog['quantityMode'],
        grams: Number(args.grams),
        units: (args.units as number | null) ?? null,
        unitName: (args.unitName as string | null) ?? null,
        source: args.source as MealLog['source'],
        note: (args.note as string | null) ?? null,
        createdAt: new Date().toISOString(),
        food: f,
      }
      meals.push(log)
      return delay(structuredClone(log) as T)
    }

    case 'delete_meal': {
      const i = meals.findIndex((m) => m.id === args.id)
      if (i !== -1) meals.splice(i, 1)
      return delay(undefined as T)
    }

    case 'recipe_prefs_list':
      return delay(structuredClone(recipePrefs) as T)

    case 'recipe_prefs_set': {
      const input = args.input as { recipeId: string; rating: number }
      if (input.rating !== 1 && input.rating !== -1) throw new Error('rating 应为 1（喜欢）或 -1（不喜欢）')
      const now = new Date().toISOString()
      const i = recipePrefs.findIndex((p) => p.recipeId === input.recipeId)
      if (i !== -1) {
        recipePrefs[i] = { recipeId: input.recipeId, rating: input.rating, updatedAt: now }
      } else {
        recipePrefs.push({ recipeId: input.recipeId, rating: input.rating, updatedAt: now })
      }
      return delay(structuredClone(recipePrefs.find((p) => p.recipeId === input.recipeId)) as T)
    }

    case 'recipe_prefs_delete': {
      const i = recipePrefs.findIndex((p) => p.recipeId === args.recipeId)
      if (i !== -1) recipePrefs.splice(i, 1)
      return delay(undefined as T)
    }

    case 'get_daily_summary':
      return delay(summarize(String(args.date)) as T)

    case 'get_targets':
      return delay({ ...profile.targets } as T)

    case 'set_targets':
      return delay((() => {
        profile.targets = plain(args.targets as DailyTargets)
        return undefined
      })() as T)

    case 'get_profile':
      return delay(structuredClone(profile) as T)

    case 'update_profile':
      return delay((() => {
        Object.assign(profile, plain(args.profile))
        return structuredClone(profile)
      })() as T)

    case 'get_calc_state':
      return delay((bodyStore.calc ? structuredClone(bodyStore.calc) : null) as T)

    case 'save_calc_state': {
      const s = plain(args.s as CalcState)
      s.savedAt = new Date().toISOString()
      bodyStore.calc = s
      saveBody()
      return delay(structuredClone(s) as T)
    }

    case 'list_body_metrics': {
      const limit = Number(args.limit ?? 180)
      const list = [...bodyStore.metrics]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 180)
      return delay(structuredClone(list) as T)
    }

    case 'record_body_metric': {
      const input = plain(args.metric as BodyMetricInput)
      if (input.weightKg == null && input.heightCm == null) {
        throw new Error('体重与身高至少填写一项')
      }
      let m = bodyStore.metrics.find((x) => x.date === input.date)
      if (m) {
        if (input.weightKg != null) m.weightKg = input.weightKg
        if (input.heightCm != null) m.heightCm = input.heightCm
      } else {
        m = {
          id: ++metricId,
          date: input.date,
          weightKg: input.weightKg ?? null,
          heightCm: input.heightCm ?? null,
          createdAt: new Date().toISOString(),
        }
        bodyStore.metrics.push(m)
      }
      // 与 Rust record_body_metric 同步：非空值写回身体资料
      if (input.weightKg != null) profile.weightKg = input.weightKg
      if (input.heightCm != null) profile.heightCm = input.heightCm
      saveBody()
      return delay(structuredClone(m) as T)
    }

    case 'delete_body_metric': {
      const i = bodyStore.metrics.findIndex((x) => x.id === Number(args.id))
      if (i !== -1) bodyStore.metrics.splice(i, 1)
      saveBody()
      return delay(undefined as T)
    }

    case 'ai_parse_target_adjust':
      return delay(parseTargetAdjustText(String(args.text), plain(args.current as DailyTargets)) as T)

    case 'list_todos': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const list = todos
        .filter((t) => t.date !== null && t.date >= s && t.date <= e)
        .sort(
          (a, b) =>
            a.date!.localeCompare(b.date!) ||
            (a.startMin ?? 9999) - (b.startMin ?? 9999) ||
            b.priority - a.priority ||
            a.id - b.id,
        )
      return delay(structuredClone(list) as T)
    }

    case 'list_all_todos': {
      const list = [...todos].sort(
        (a, b) =>
          (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) ||
          (a.date === null ? 1 : 0) - (b.date === null ? 1 : 0) ||
          (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
          (a.startMin ?? 9999) - (b.startMin ?? 9999) ||
          b.priority - a.priority ||
          a.id - b.id,
      )
      return delay(structuredClone(list) as T)
    }

    case 'query_todos': {
      // 与 Rust query_todos 同语义：focus 聚焦视图 / range 区间，LIMIT/OFFSET 分页
      const todayS = String(args.today)
      const winEnd = addDays(todayS, 7)
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50)
      const offset = Math.max(Number(args.offset ?? 0), 0)
      const match =
        args.scope === 'range'
          ? (t: Todo) => t.date !== null && t.date >= String(args.start) && t.date <= String(args.end)
          : (t: Todo) =>
              t.date === null ||
              (t.status !== 'done' && (t.date < todayS || (t.date >= todayS && t.date <= winEnd)))
      const filtered = todos.filter(match).sort(
        (a, b) =>
          (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) ||
          (a.date === null ? 1 : 0) - (b.date === null ? 1 : 0) ||
          (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
          (a.startMin ?? 9999) - (b.startMin ?? 9999) ||
          b.priority - a.priority ||
          a.id - b.id,
      )
      return delay({
        items: structuredClone(filtered.slice(offset, offset + limit)),
        total: filtered.length,
        limit,
        offset,
      } as T)
    }

    case 'query_todo_feed': {
      // e2e 专用失败注入（scripts/e2e-home-todo-feed.mjs 的 fail 阶段）：
      // 首行先于任何取数逻辑，用来验错误态与「点此重试」。
      if (mockFlag('__REIN_MOCK_TODO_FEED_FAIL__')) throw new Error('mock：待办信息流取数失败')
      // 与 Rust query_todo_feed 逐桶同语义（两端口径必须一致，改一处就得同步改另一处）：
      // 全表不过滤（含已完成 / 收件箱 / 课表派生行）→ 未完成在前、已完成沉底 →
      // 日期桶 未安排(0) → 逾期(1) → 今天(2) → 未来(3) → date 升序（逾期里最早欠的排最前）→
      // 有时间的在前、时间早的在前 → priority 降序 → id 兜底（全序唯一，翻页边界确定）。
      const todayS = String(args.today)
      // 与 Rust parse_date（NaiveDate::parse_from_str "%Y-%m-%d"）同口径：形状须 YYYY-MM-DD
      // 且是真实存在的日历日。注意不能只用 Date.parse —— JS 会把 '2026-02-30' 滚成 3 月 2 日，
      // 而 Rust 侧会拒绝，所以回读三键校验。
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayS)
      const y = Number(dm?.[1])
      const mo = Number(dm?.[2])
      const day = Number(dm?.[3])
      const probe = new Date(0)
      probe.setUTCFullYear(y, mo - 1, day)
      if (
        !dm ||
        probe.getUTCFullYear() !== y ||
        probe.getUTCMonth() !== mo - 1 ||
        probe.getUTCDate() !== day
      ) {
        throw new Error('日期格式应为 YYYY-MM-DD')
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 30), 1), 100)
      const offset = Math.max(Number(args.offset ?? 0), 0)
      const bucketOf = (t: Todo): number =>
        t.date === null ? 0 : t.date < todayS ? 1 : t.date === todayS ? 2 : 3
      const sorted = [...todos].sort(
        (a, b) =>
          (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) ||
          bucketOf(a) - bucketOf(b) ||
          (a.date ?? '').localeCompare(b.date ?? '') ||
          (a.startMin ?? 9999) - (b.startMin ?? 9999) ||
          b.priority - a.priority ||
          a.id - b.id,
      )
      // total 与 Rust 的 SELECT COUNT(*) FROM todos 同口径：不过滤的全表条数
      return delay({
        items: structuredClone(sorted.slice(offset, offset + limit)),
        total: todos.length,
        limit,
        offset,
      } as T)
    }

    case 'todo_distribution': {
      const todayS = String(args.today)
      const days = new Map<string, number>()
      let inbox = 0
      let overdue = 0
      for (const t of todos) {
        if (t.date === null) {
          inbox += 1
          continue
        }
        days.set(t.date, (days.get(t.date) ?? 0) + 1)
        if (t.status !== 'done' && t.date < todayS) overdue += 1
      }
      return delay({
        days: [...days.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count })),
        inbox,
        overdue,
      } as T)
    }

    case 'create_todo': {
      const t: Todo = {
        id: ++todoId,
        title: String(args.title),
        notes: (args.notes as string | null) ?? null,
        date: (args.date as string | null) ?? null,
        startMin: (args.startMin as number | null) ?? null,
        durationMin: (args.durationMin as number | null) ?? null,
        category: (args.category as Todo['category']) ?? 'general',
        priority: (args.priority as number) ?? 0,
        status: 'todo',
        completedAt: null,
        createdAt: new Date().toISOString(),
        programId: null,
        recRule: (args.recRule as Todo['recRule']) ?? null,
        recKey: null,
        subtasks: (args.subtasks as Todo['subtasks']) ?? null,
        attachments: (args.attachments as Todo['attachments']) ?? null,
      }
      // 重复模板：自身即首日实例
      if (t.recRule && t.date) t.recKey = `${t.id}:${t.date}`
      todos.push(t)
      return delay(structuredClone(t) as T)
    }

    case 'update_todo': {
      // 注意：浏览器模式下入参可能是 Vue reactive 代理，structuredClone 会抛
      // DataCloneError，必须走 JSON 克隆（真实后端经 IPC 序列化无此问题）。
      const patch = JSON.parse(JSON.stringify(args.todo)) as Todo
      const i = todos.findIndex((t) => t.id === patch.id)
      if (i !== -1) todos[i] = patch
      return delay(JSON.parse(JSON.stringify(patch)) as T)
    }

    case 'delete_todo': {
      const i = todos.findIndex((t) => t.id === args.id)
      if (i === -1) return delay(undefined as T)
      const [gone] = todos.splice(i, 1) as [Todo]

      // 删实例 = 跳过这一次（与 Rust delete_todo_on_as_of 同语义）：记进模板的除外日期，
      // 物化时不再补回。模板自身的 recKey 也长这样，但它随模板一起没了，不必记。
      const parsed = gone.recKey ? parseRecKey(gone.recKey) : null
      if (parsed && parsed[0] !== gone.id) {
        const set = recSkips.get(parsed[0]) ?? new Set<string>()
        set.add(parsed[1])
        recSkips.set(parsed[0], set)
      }

      // 删模板 = 整条重复待办下线：今天与以后未完成的实例一并收走（未来实例本也会被
      // sync_recurrences 清掉，提前到删除当场是为了当天那条不变成永久孤儿）。
      if (gone.recRule) {
        const todayNow = ymd(new Date())
        for (let j = todos.length - 1; j >= 0; j--) {
          const inst = todos[j]!
          if (inst.status === 'done' || !inst.recKey || !inst.date || inst.date < todayNow) continue
          if (parseRecKey(inst.recKey)?.[0] === gone.id) todos.splice(j, 1)
        }
        recSkips.delete(gone.id)
      }
      return delay(undefined as T)
    }

    case 'sync_recurrences': {
      // 与 Rust sync_recurrences 同语义：清失效未来实例 + 补窗口 [今天-1, 今天+7] 缺失实例
      const todayS = String(args.today)
      const winStart = addDays(todayS, -1)
      const winEnd = addDays(todayS, 7)
      let inserted = 0
      for (let i = todos.length - 1; i >= 0; i--) {
        const inst = todos[i]!
        if (!inst.recKey || inst.status === 'done' || !inst.date || inst.date <= todayS) continue
        const tid = parseRecKey(inst.recKey)?.[0]
        const tpl = todos.find((x) => x.id === tid)
        const match =
          tpl?.recRule && tpl.date
            ? ruleMatchesDate(tpl.recRule, tpl.date, inst.date)
            : false
        if (!match) todos.splice(i, 1)
      }
      for (const tpl of todos) {
        if (!tpl.recRule || !tpl.date) continue
        const skips = recSkips.get(tpl.id)
        for (let d = winStart; d <= winEnd; d = addDays(d, 1)) {
          if (d === tpl.date || skips?.has(d) || !ruleMatchesDate(tpl.recRule, tpl.date, d)) continue
          const key = `${tpl.id}:${d}`
          if (todos.some((x) => x.recKey === key)) continue
          todos.push({
            id: ++todoId,
            title: tpl.title,
            notes: tpl.notes,
            date: d,
            startMin: tpl.startMin,
            durationMin: tpl.durationMin,
            category: tpl.category,
            priority: tpl.priority,
            status: 'todo',
            completedAt: null,
            createdAt: new Date().toISOString(),
            programId: null,
            recRule: null,
            recKey: key,
            subtasks: tpl.subtasks?.map((s) => ({ title: s.title, done: false })) ?? null,
          })
          inserted++
        }
      }
      // 与 Rust auto_complete_past_courses 同语义：已经上完的课表派生行自动打卡。
      // 派生行是只读投影（用户勾不了），下课时刻 = date + startMin + durationMin（缺省 95）。
      {
        const nowD = new Date()
        const todayNow = ymd(nowD)
        const nowMin = nowD.getHours() * 60 + nowD.getMinutes()
        const nowIso = nowD.toISOString()
        for (const t of todos) {
          if (t.courseSessionId == null || t.status === 'done' || !t.date || t.startMin == null) continue
          const endMin = t.startMin + (t.durationMin ?? 95)
          if (t.date < todayNow || (t.date === todayNow && endMin <= nowMin)) {
            t.status = 'done'
            t.completedAt = nowIso
          }
        }
      }
      return delay(inserted as T)
    }

    case 'list_workouts': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const list = workouts
        .filter((w) => w.date >= s && w.date <= e)
        .sort((a, b) => b.date.localeCompare(a.date) || (a.startMin ?? 0) - (b.startMin ?? 0))
      return delay(structuredClone(list) as T)
    }

    case 'list_all_workouts': {
      const list = [...workouts].sort(
        (a, b) => b.date.localeCompare(a.date) || (a.startMin ?? 0) - (b.startMin ?? 0),
      )
      return delay(structuredClone(list) as T)
    }

    case 'create_workout': {
      const w: Workout = {
        id: ++workoutId,
        name: String(args.name),
        type: args.workoutType as Workout['type'],
        date: String(args.date),
        startMin: (args.startMin as number | null) ?? null,
        durationMin: Number(args.durationMin),
        kcal: Number(args.kcal),
        // intensity 在 Rust 侧是 Option（NOT NULL 由 DEFAULT/前端兜底），effort 仅手动补录有
        intensity: (args.intensity as Workout['intensity'] | null) ?? 'moderate',
        effort: (args.effort as Workout['effort'] | null) ?? null,
        note: (args.note as string | null) ?? null,
        sessionId: null,
        // 补录/课程/跑步都是 Rein 自己记的：source 恒为 local（第三方来源只由同步写入）
        source: 'local',
        createdAt: new Date().toISOString(),
      }
      workouts.push(w)
      return delay(structuredClone(w) as T)
    }

    case 'delete_workout': {
      const i = workouts.findIndex((w) => w.id === args.id)
      if (i !== -1) workouts.splice(i, 1)
      // 与 Rust FK ON DELETE CASCADE 同语义：记录删除时清掉其逐组明细
      for (let k = strengthSets.length - 1; k >= 0; k--) {
        if (strengthSets[k]!.workoutId === Number(args.id)) strengthSets.splice(k, 1)
      }
      saveSets()
      return delay(undefined as T)
    }

    /* ---------------- 第三方健康数据（Health Connect） ---------------- */

    case 'health_sync_status': {
      return delay({
        supported: true,
        availability: 'available',
        readGranted: true,
        // 四组全授：浏览器里迭代预览卡与「已授权」胶囊用的样子；
        // 要看「按组去授权」的引导态，把某组改成 false 即可
        grantedCategories: { exercise: true, activity: true, body: true, vitals: true },
        // 写授权跟着回写开关走，好让「打开开关 → 提示去补授权」这条路在 mock 里也能走一遍
        writeGranted: healthPush,
        pushEnabled: healthPush,
        lastSyncAt: healthLastSync,
        importedCount: healthImported,
        exportedCount: healthExported,
        autoWindowStart: HEALTH_AUTO_WINDOW_START,
      } as T)
    }

    case 'health_sync_authorize':
      return delay(undefined as T)

    case 'health_sync_set_push': {
      healthPush = Boolean(args.enabled)
      return delay(undefined as T)
    }

    case 'health_sync_start': {
      // windowStart 在 mock 里刻意忽略：这里只推进相位，真实读取窗口对 UI 迭代没有可见影响
      healthSteps = 0
      return delay({ phase: 'pending', report: null, message: null } as T)
    }

    case 'health_sync_step': {
      healthSteps += 1
      // 真实现是「等原生侧把文件写出来」，这里给两拍 pending 模拟同样的时序
      if (healthSteps <= 2) return delay({ phase: 'pending', report: null, message: null } as T)
      const first = healthSteps === 3
      const report = {
        imported: first ? 3 : 0,
        updated: 0,
        removed: 0,
        exported: healthPush ? (first ? 2 : 0) : 0,
        reExported: 0,
        unexported: 0,
        // 之前这里是恒 0，于是「跳过 N（没填开始时间）」那句文案在浏览器里永远不渲染 ——
        // 而这句正是这次改动要对齐用户诉求的地方，dev 里看不见就等于改不了。
        // 口径同真机：只在开着回写时才有跳过（build_push 只在 push 分支里跑）。
        skipped: healthPush ? (first ? healthSkippedSample() : 0) : 0,
        scanned: healthImported,
        metricsImported: first
          ? (healthMetricsSample() as { points: unknown[] }[]).reduce(
              (n, s) => n + s.points.length,
              0,
            )
          : 0,
        pushed: healthPush,
      }
      healthImported += report.imported
      healthExported += report.exported
      healthLastSync = new Date().toISOString()
      return delay({ phase: 'done', report, message: null } as T)
    }

    case 'health_metrics_all':
      return delay(healthMetricsSample() as T)

    case 'health_sync_workouts':
      return delay(healthSyncWorkoutsSample() as T)

    case 'save_pomodoro_session': {
      const s: PomodoroSession = { ...(args.session as Omit<PomodoroSession, 'id'>), id: ++pomodoroSeq }
      pomodoroSessions.push(s)
      return delay(structuredClone(s) as T)
    }

    case 'list_pomodoro_sessions': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const list = pomodoroSessions.filter((x) => x.startedAt.slice(0, 10) >= s && x.startedAt.slice(0, 10) <= e)
      return delay(structuredClone(list) as T)
    }

    case 'session_start': {
      // 防御：并发生效会话先作废
      for (const s of sessions) if (s.status === 'active') s.status = 'aborted'
      const s: MockSession = {
        id: ++sessionId,
        planId: String(args.planId),
        planName: String(args.planName),
        status: 'active',
        startedAt: String(args.startedAt),
        updatedAt: new Date().toISOString(),
        exIndex: 0,
        setIndex: 1,
        weightKg: 0,
        elapsedSec: 0,
        state: JSON.parse(JSON.stringify(args.stateJson)) as Record<string, unknown>,
      }
      sessions.push(s)
      saveSessions()
      return delay(structuredClone(s) as T)
    }

    case 'session_snapshot': {
      const s = sessions.find((x) => x.id === args.id && x.status === 'active')
      if (s) {
        s.exIndex = Number(args.exIndex)
        s.setIndex = Number(args.setIndex)
        s.weightKg = Number(args.weightKg)
        s.state = JSON.parse(JSON.stringify(args.stateJson)) as Record<string, unknown>
        const nowIso = new Date().toISOString()
        s.elapsedSec += Math.max(0, (Date.now() - Date.parse(s.updatedAt || nowIso)) / 1000)
        s.updatedAt = nowIso
        saveSessions()
      }
      return delay(undefined as T)
    }

    case 'session_active': {
      const active = [...sessions].reverse().find((x) => x.status === 'active') ?? null
      return delay((active ? structuredClone(active) : null) as T)
    }

    case 'session_finish': {
      const input = args.input as {
        id: number
        name: string
        workoutType: string
        date: string
        durationMin: number
        intensity: string
        kcal: number
        note: string | null
        sets?: {
          exerciseKey: string
          exerciseId?: string
          exerciseName: string
          kind: string
          setNo: number
          weightKg: number | null
          reps: number | null
          sec: number | null
          warmup: boolean
        }[]
      }
      const s = sessions.find((x) => x.id === input.id)
      if (s) {
        s.status = 'finished'
        saveSessions()
      }
      const w: Workout = {
        id: ++workoutId,
        name: input.name,
        type: input.workoutType as Workout['type'],
        date: input.date,
        startMin: null,
        durationMin: input.durationMin,
        kcal: input.kcal,
        intensity: input.intensity as Workout['intensity'],
        effort: null, // 课程会话无体感输入（见 db.rs MIGRATION_0035）
        note: input.note,
        sessionId: input.id,
        source: 'local',
        createdAt: new Date().toISOString(),
      }
      workouts.push(w)
      // 逐组做组明细落库（重量曲线数据源，与 Rust session_finish 事务内写入同语义）
      const nowIso = new Date().toISOString()
      for (const st of input.sets ?? []) {
        strengthSets.push({
          id: ++strengthSetId,
          workoutId: w.id,
          planId: s?.planId ?? null,
          exerciseKey: st.exerciseKey,
          // 缺 exerciseId（旧客户端 / AI 提交）时按名称挂库，保证逐组记录进入对应曲线
          exerciseId: st.exerciseId?.trim() || ensureExerciseForName(st.exerciseName, { kind: st.kind, reps: st.reps, weightKg: st.weightKg }),
          exerciseName: st.exerciseName,
          setNo: st.setNo,
          kind: st.kind,
          weightKg: st.weightKg,
          reps: st.reps,
          sec: st.sec,
          warmup: !!st.warmup,
          createdAt: nowIso,
        })
      }
      if (input.sets?.length) saveSets()
      return delay(structuredClone(w) as T)
    }

    case 'session_abort': {
      const s = sessions.find((x) => x.id === args.id)
      if (s) {
        s.status = 'aborted'
        saveSessions()
      }
      return delay(undefined as T)
    }

    case 'session_for_workout': {
      const w = workouts.find((x) => x.id === Number(args.workoutId))
      const s = w?.sessionId != null ? sessions.find((x) => x.id === w.sessionId) : undefined
      return delay((s ? structuredClone(s) : null) as T)
    }

    /* ---------- 重量曲线（逐组记录查询，与 Rust 同语义；聚合键 = 动作库 id） ---------- */

    case 'strength_history': {
      const id = resolveExerciseId(String(args.exerciseId))
      const raw = String(args.exerciseId).trim()
      const rows = strengthSets
        .filter((r) => r.exerciseId === id || (!r.exerciseId && r.exerciseName === raw))
        .map(strengthRecord)
        .sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
      return delay(structuredClone(rows) as T)
    }

    case 'strength_exercises': {
      const agg = new Map<string, { id: string; display: string; lastDate: string; sessions: Set<number> }>()
      for (const r of strengthSets) {
        // 与 Rust 侧 `strength_exercises_on` 同一口径：自重动作只有次数、没有重量，
        // 用 weightKg == null 过滤会把引体/俯卧撑整条挡掉。次数在场即为有效记录。
        if (r.warmup || (r.weightKg == null && r.reps == null)) continue
        const lib = exercises.find((e) => e.id === r.exerciseId)
        const key = r.exerciseId || r.exerciseName
        const date = workouts.find((x) => x.id === r.workoutId)?.date ?? r.createdAt.slice(0, 10)
        const cur =
          agg.get(key) ?? { id: r.exerciseId, display: lib?.name ?? r.exerciseName, lastDate: '', sessions: new Set<number>() }
        if (date > cur.lastDate) cur.lastDate = date
        cur.sessions.add(r.workoutId)
        agg.set(key, cur)
      }
      const rows = [...agg.values()]
        .map((v) => ({ exerciseId: v.id, name: v.display, lastDate: v.lastDate, sessions: v.sessions.size }))
        .sort((a, b) => b.lastDate.localeCompare(a.lastDate))
      return delay(structuredClone(rows) as T)
    }

    case 'strength_last_weights': {
      const keys = (args.exerciseIds as string[]) ?? []
      const rows = keys
        .map((key) => {
          const id = resolveExerciseId(key)
          const raw = key.trim()
          const done = strengthSets
            .filter(
              (r) =>
                (r.exerciseId === id || (!r.exerciseId && r.exerciseName === raw)) &&
                !r.warmup &&
                r.weightKg != null,
            )
            .map((r) => {
              const w = workouts.find((x) => x.id === r.workoutId)
              return { ...r, date: w?.date ?? r.createdAt.slice(0, 10) }
            })
            // 与 Rust ORDER BY date DESC, workout_id DESC, id DESC 对齐：id 决胜保证取「最后一组」
            .sort((a, b) => b.date.localeCompare(a.date) || b.workoutId - a.workoutId || b.id - a.id)
          const last = done[0]
          return last
            ? {
                exerciseId: id,
                name: exercises.find((e) => e.id === id)?.name ?? last.exerciseName,
                weightKg: last.weightKg!,
                reps: last.reps,
                date: last.date,
              }
            : null
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
      return delay(structuredClone(rows) as T)
    }

    case 'strength_recent_sets': {
      const days = Number(args.days ?? 42)
      const from = addDays(todayStr(), -days)
      const rows = strengthSets
        .map(strengthRecord)
        .filter((r) => r.date >= from)
        .sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
      return delay(structuredClone(rows) as T)
    }

    /* ---------- 动作库（与 Rust modules/exercise_lib 同语义） ---------- */

    case 'list_exercises': {
      const kind = args.kind ? String(args.kind) : ''
      const category = args.category ? String(args.category) : ''
      const query = String(args.query ?? '').trim().toLowerCase()
      const includeHidden = args.includeHidden === true
      const rows = exercises
        .filter((e) => (includeHidden ? true : !e.hidden))
        .filter((e) => !kind || e.kind === kind)
        .filter((e) => !category || e.category === category)
        .filter(
          (e) =>
            !query ||
            e.name.toLowerCase().includes(query) ||
            e.aliases.some((a) => a.toLowerCase().includes(query)),
        )
        .map((e) => {
          const u = exerciseUsage(e.id)
          return { ...e, sessions: u.sessions, lastUsedAt: u.lastUsedAt }
        })
        .sort(
          (a, b) =>
            (a.lastUsedAt ? 0 : 1) - (b.lastUsedAt ? 0 : 1) ||
            (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') ||
            a.name.localeCompare(b.name),
        )
      return delay(structuredClone(rows) as T)
    }

    case 'get_exercise': {
      const e = exercises.find((x) => x.id === args.id)
      if (!e) throw new Error(`动作不存在：${String(args.id)}`)
      const u = exerciseUsage(e.id)
      return delay(structuredClone({ ...e, sessions: u.sessions, lastUsedAt: u.lastUsedAt }) as T)
    }

    case 'upsert_exercise': {
      const input = args.input as ExerciseInput
      const name = String(input.name ?? '').trim()
      if (!name) throw new Error('动作名称不能为空')
      const id = input.id?.trim() || `custom-${crypto.randomUUID()}`
      const existing = exercises.find((x) => x.id === id)
      if (existing && !existing.isCustom) {
        throw new Error('内置动作不可编辑：可以隐藏它，或另建一个自建动作')
      }
      const dup = exercises.find(
        (x) => x.id !== id && (x.name === name || x.aliases.includes(name)),
      )
      if (dup) throw new Error(`已有同名动作「${name}」（id=${dup.id}），请直接使用它`)
      const rec: ExerciseRecord = {
        id,
        name,
        aliases: input.aliases ?? [],
        kind: input.kind,
        category: input.category,
        equipment: input.equipment ?? null,
        muscles: normalizeActivation(input.muscles),
        tips: input.tips ?? '',
        steps: sanitizeSteps(input.steps),
        favorite: existing?.favorite ?? false,
        defaultSets: input.defaultSets ?? 3,
        defaultReps: input.defaultReps ?? null,
        defaultWeightKg: input.defaultWeightKg ?? null,
        defaultTargetSec: input.defaultTargetSec ?? null,
        defaultDurationMin: input.defaultDurationMin ?? null,
        defaultRestSec: input.defaultRestSec ?? 90,
        weightStep: input.weightStep ?? 2.5,
        isCustom: true,
        hidden: false,
        sessions: 0,
        lastUsedAt: null,
      }
      if (existing) Object.assign(existing, rec)
      else exercises.push(rec)
      saveExercises()
      const u = exerciseUsage(id)
      return delay(structuredClone({ ...rec, sessions: u.sessions, lastUsedAt: u.lastUsedAt }) as T)
    }

    case 'delete_exercise': {
      const e = exercises.find((x) => x.id === args.id)
      if (!e) throw new Error(`动作不存在：${String(args.id)}`)
      if (e.isCustom) {
        exercises.splice(exercises.indexOf(e), 1)
        saveExercises()
      } else {
        e.hidden = true
        saveExerciseHidden()
      }
      return delay(undefined as T)
    }

    case 'restore_exercise': {
      const e = exercises.find((x) => x.id === args.id)
      if (e) {
        e.hidden = false
        saveExerciseHidden()
      }
      return delay(undefined as T)
    }

    case 'set_exercise_favorite': {
      const e = exercises.find((x) => x.id === args.id)
      if (!e) throw new Error(`动作不存在：${String(args.id)}`)
      e.favorite = Boolean(args.favorite)
      if (!e.isCustom) saveExerciseFavorite()
      else saveExercises()
      return delay(undefined as T)
    }

    case 'list_workout_plans':
      return delay(structuredClone(sortedPlans()) as T)

    case 'get_workout_plan': {
      const p = plans.find((x) => x.id === args.id)
      if (!p) throw new Error(`课程不存在: ${String(args.id)}`)
      return delay(structuredClone(p) as T)
    }

    case 'upsert_workout_plan': {
      const input = args.input as WorkoutPlanInput
      const name = String(input.name ?? '').trim()
      if (!name) throw new Error('课程名称不能为空')
      const now = new Date().toISOString()
      // 动作条目一律经动作库解析（与 Rust upsert_workout_plan 同语义）
      const resolved = resolvePlanExerciseIds(
        Array.isArray(input.exercises) ? (input.exercises as unknown[]) : [],
      ) as WorkoutPlanRecord['exercises']
      const existing = plans.find((x) => x.id === input.id)
      if (existing) {
        existing.name = name
        existing.subtitle = String(input.subtitle ?? '').trim()
        existing.workoutType = input.workoutType
        existing.exercises = JSON.parse(JSON.stringify(resolved)) as WorkoutPlanRecord['exercises']
        // meta 字段编辑器不提供：缺省保留原值（与 Rust upsert 的 COALESCE 语义一致）
        if (input.equipment != null) existing.equipment = input.equipment
        if (input.estDurationMin != null) existing.estDurationMin = input.estDurationMin
        existing.updatedAt = now
        savePlans()
        return delay(structuredClone(existing) as T)
      }
      const rec: WorkoutPlanRecord = {
        id: input.id,
        name,
        subtitle: String(input.subtitle ?? '').trim(),
        workoutType: input.workoutType,
        exercises: JSON.parse(JSON.stringify(resolved)) as WorkoutPlanRecord['exercises'],
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
        equipment: input.equipment ?? null,
        estDurationMin: input.estDurationMin ?? null,
      }
      plans.push(rec)
      savePlans()
      return delay(structuredClone(rec) as T)
    }

    case 'delete_workout_plan': {
      const i = plans.findIndex((x) => x.id === args.id)
      if (i !== -1) plans.splice(i, 1)
      savePlans()
      return delay(undefined as T)
    }

    case 'touch_workout_plan': {
      const p = plans.find((x) => x.id === args.id)
      if (p) {
        p.lastUsedAt = new Date().toISOString()
        p.updatedAt = p.lastUsedAt
        savePlans()
      }
      return delay(undefined as T)
    }

    case 'plan_seed_status_cmd':
      return delay(planSeedStatus() as unknown as T)

    case 'apply_plan_seed_migrate': {
      if (planSeedStatus().currentVersion < planSeedStatus().latestVersion) migratePlans()
      return delay(planSeedStatus() as unknown as T)
    }

    case 'apply_plan_seed_override': {
      if (planSeedStatus().currentVersion < planSeedStatus().latestVersion) overridePlans()
      return delay(planSeedStatus() as unknown as T)
    }

    case 'apply_plan_seed_keep': {
      if (planSeedStatus().currentVersion < planSeedStatus().latestVersion) keepPlans()
      return delay(planSeedStatus() as unknown as T)
    }

    case 'ai_parse_food_text':
      return delay(parseFoodText(String(args.text)) as T)

    case 'list_ledger_entries': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const kw = args.keyword ? (String(args.keyword).trim().toLowerCase()) : null
      const cat = args.category ? String(args.category) : null
      const list = ledgerEntries.filter(
        (x) =>
          x.date >= s &&
          x.date <= e &&
          (!cat || x.category === cat) &&
          (!kw || (x.note ?? '').toLowerCase().includes(kw)),
      )
      return delay(structuredClone(list) as T)
    }

    case 'create_ledger_entry': {
      const input = plain(args.input as LedgerEntryInput)
      const entry: LedgerEntry = {
        id: ++ledgerId,
        kind: input.kind,
        category: input.category,
        amountCents: input.amountCents,
        note: input.note ?? null,
        date: input.date,
        createdAt: new Date().toISOString(),
      }
      ledgerEntries.push(entry)
      return delay(structuredClone(entry) as T)
    }

    case 'update_ledger_entry': {
      const patch = args.entry as LedgerEntry
      const i = ledgerEntries.findIndex((x) => x.id === patch.id)
      if (i !== -1) ledgerEntries[i] = structuredClone(patch)
      return delay(structuredClone(patch) as T)
    }

    case 'delete_ledger_entry': {
      const i = ledgerEntries.findIndex((x) => x.id === args.id)
      if (i !== -1) ledgerEntries.splice(i, 1)
      return delay(undefined as T)
    }

    case 'get_ledger_budget':
      return delay(structuredClone(ledgerSettings) as T)

    case 'set_ledger_budget': {
      ledgerSettings.monthlyBudgetCents = Number(args.monthlyBudgetCents)
      ledgerSettings.updatedAt = new Date().toISOString()
      return delay(structuredClone(ledgerSettings) as T)
    }

    case 'ai_model_list':
      return delay(structuredClone(aiModels) as T)

    case 'ai_model_add': {
      const input = plain(args.input as AiModelInput)
      const now = new Date().toISOString()
      // 镜像 Rust：库为空或显式默认时设为默认（同时清掉其他默认）
      const makeDefault = input.isDefault || aiModels.length === 0
      if (makeDefault) for (const m of aiModels) m.isDefault = false
      const model: AiModel = {
        id: ++aiModelId,
        name: input.name,
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        modelId: input.modelId,
        isDefault: makeDefault,
        vision: null,
        thinking: null,
        effort: null,
        imageMaxEdge: input.imageMaxEdge ?? null,
        lastError: null,
        source: 'manual',
        serviceBase: null,
        priceIn: input.priceIn ?? null,
        priceOut: input.priceOut ?? null,
        priceCurrency: input.priceIn || input.priceOut ? 'CNY' : null,
        trafficPerGb: null,
        createdAt: now,
        updatedAt: now,
      }
      aiModels.push(model)
      saveAiModels()
      return delay(structuredClone(model) as T)
    }

    case 'ai_model_update': {
      const id = Number(args.id)
      const input = plain(args.input as AiModelInput)
      const m = aiModels.find((x) => x.id === id)
      if (!m) throw new Error('模型不存在')
      if (input.isDefault) for (const x of aiModels) x.isDefault = false
      Object.assign(m, input, {
        isDefault: input.isDefault || aiModels.length === 1,
        vision: null,
        thinking: null,
        effort: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      // 镜像 Rust：仍无默认时最早一条设为默认
      if (!aiModels.some((x) => x.isDefault)) aiModels[0].isDefault = true
      saveAiModels()
      return delay(undefined as T)
    }

    case 'ai_model_delete': {
      const id = Number(args.id)
      const i = aiModels.findIndex((x) => x.id === id)
      if (i !== -1) aiModels.splice(i, 1)
      if (!aiModels.some((x) => x.isDefault) && aiModels.length > 0) aiModels[0].isDefault = true
      saveAiModels()
      return delay(undefined as T)
    }

    case 'ai_model_set_default': {
      const id = Number(args.id)
      const m = aiModels.find((x) => x.id === id)
      if (!m) throw new Error('模型不存在')
      for (const x of aiModels) x.isDefault = false
      m.isDefault = true
      saveAiModels()
      return delay(undefined as T)
    }

    case 'ai_model_save_probe': {
      const id = Number(args.id)
      const r = plain(args.result as AiProbeResult)
      const m = aiModels.find((x) => x.id === id)
      if (!m) throw new Error('模型不存在')
      m.vision = r.vision ?? null
      m.thinking = r.thinking ?? null
      m.effort = r.effort ?? null
      m.lastError = r.error ?? null
      m.updatedAt = new Date().toISOString()
      saveAiModels()
      return delay(undefined as T)
    }

    /* ---- 提供商（服务商账号 + 模型目录） ---- */

    case 'ai_provider_adapters':
      return delay(structuredClone(MOCK_ADAPTERS) as T)

    case 'ai_provider_list':
      return delay(structuredClone(mockProviders) as T)

    case 'ai_provider_save': {
      const input = plain(args.input as AiProviderInput)
      const adapter = MOCK_ADAPTERS.find((a) => a.id === input.adapter)
      if (!adapter) throw new Error(`未知适配器：${input.adapter}`)
      const base = (input.baseUrl ?? '').trim().replace(/\/+$/, '')
      if (!base) throw new Error('服务地址不能为空')
      const now = new Date().toISOString()
      const style = adapter.styles.find((s) => s.id === input.apiStyle)?.id ?? adapter.styles[0]!.id
      const name = (input.name ?? '').trim() || adapter.nickname
      // 同 adapter + 同地址视为同一个账号（镜像 Rust）
      let target = input.id
        ? mockProviders.find((p) => p.id === input.id)
        : mockProviders.find((p) => p.adapter === adapter.id && p.baseUrl === base)
      if (target) {
        Object.assign(target, {
          adapter: adapter.id,
          name,
          baseUrl: base,
          apiKey: (input.apiKey ?? '').trim(),
          apiStyle: style,
          extra: input.extra ?? null,
          updatedAt: now,
        })
      } else {
        target = {
          id: ++mockProviderId,
          adapter: adapter.id,
          name,
          baseUrl: base,
          apiKey: (input.apiKey ?? '').trim(),
          apiStyle: style,
          extra: input.extra ?? null,
          lastError: null,
          lastSyncAt: null,
          createdAt: now,
          updatedAt: now,
          models: [],
        }
        mockProviders.push(target)
      }
      saveMockProviders()
      return delay(structuredClone(target) as T)
    }

    case 'ai_provider_delete': {
      const id = Number(args.id)
      mockProviders = mockProviders.filter((p) => p.id !== id)
      saveMockProviders()
      return delay(undefined as T)
    }

    case 'ai_provider_fetch': {
      const adapterId = String(args.adapterId)
      const adapter = MOCK_ADAPTERS.find((a) => a.id === adapterId)
      if (!adapter) throw new Error(`未知适配器：${adapterId}`)
      const catalog = buildMockProviderCatalog(
        adapter,
        String(args.baseUrl ?? ''),
        String(args.apiKey ?? ''),
      )
      const id = args.id == null ? null : Number(args.id)
      if (id != null) {
        const p = mockProviders.find((x) => x.id === id)
        if (p) {
          mockPersistModels(p, catalog.models, catalog.ok)
          p.lastError = catalog.error
          p.lastSyncAt = catalog.fetchedAt
          p.updatedAt = catalog.fetchedAt
          saveMockProviders()
          return delay(structuredClone({ ...catalog, models: p.models }) as T)
        }
      }
      return delay(catalog as T)
    }

    case 'ai_provider_model_add': {
      const providerId = Number(args.providerId)
      const p = mockProviders.find((x) => x.id === providerId)
      if (!p) throw new Error('提供商不存在')
      const adapter = MOCK_ADAPTERS.find((a) => a.id === p.adapter)
      const id = String(args.modelId ?? '').trim()
      if (!id) throw new Error('模型 ID 不能为空')
      const asked = String(args.kind ?? 'llm') as ProviderModelKind
      const kind = (adapter?.kinds.includes(asked) ? asked : mockAcceptKind(mockGuessKind(id), adapter?.kinds ?? ['llm'])) ?? 'llm'
      const existing = p.models.find((m) => m.modelId === id)
      const row = mockProviderModel(providerId, id, kind, 'manual', (args.meta as string | null) ?? null)
      if (existing) Object.assign(existing, { kind, origin: 'manual', meta: row.meta, fetchedAt: row.fetchedAt })
      else p.models.push(row)
      saveMockProviders()
      return delay(structuredClone(existing ?? row) as T)
    }

    case 'ai_provider_model_remove': {
      const p = mockProviders.find((x) => x.id === Number(args.providerId))
      if (p) {
        p.models = p.models.filter((m) => m.modelId !== String(args.modelId))
        saveMockProviders()
      }
      return delay(undefined as T)
    }

    case 'ai_model_prefs_get':
      return delay(structuredClone(mockPrefs) as T)

    case 'ai_model_prefs_save': {
      mockPrefs = { ...mockPrefs, ...plain(args.prefs as AiModelPrefs) }
      saveMockPrefs()
      return delay(structuredClone(mockPrefs) as T)
    }

    /* ---- Rein 在线服务（浏览器演示：假服务端，但字段与真服务端一致） ---- */

    case 'online_service_settings_get':
      return delay(structuredClone(mockOnlineSettings) as T)

    case 'online_service_settings_save': {
      const input = plain(args.settings as typeof mockOnlineSettings)
      mockOnlineSettings = {
        baseUrl: (input.baseUrl ?? '').replace(/\/+$/, ''),
        apiKey: (input.apiKey ?? '').trim(),
        savedAt: new Date().toISOString(),
      }
      // 密钥被清空（断开）时快照一起清 —— 与 Rust online_service_settings_save 同构
      if (!mockOnlineSettings.apiKey) {
        mockOnlineCatalog = null
        saveMockOnlineCatalog()
      }
      saveMockOnline()
      return delay(structuredClone(mockOnlineSettings) as T)
    }

    case 'online_service_catalog': {
      const catalog = buildMockCatalog(String(args.baseUrl ?? mockOnlineSettings.baseUrl), String(args.apiKey ?? ''))
      // 成功才写快照：下次「冷启动」第一眼渲染上次的状态，后台再静默核对
      if (catalog.ok) {
        mockOnlineCatalog = catalog
        saveMockOnlineCatalog()
      }
      return delay(catalog as T)
    }

    case 'online_service_cached_catalog':
      return delay(structuredClone(mockOnlineCatalog) as T)

    case 'online_service_usage': {
      const days = Number(args.days ?? 30)
      const onlinePks = new Set(aiModels.filter((m) => m.source === 'online').map((m) => m.id))
      const rows = aiUsage.filter((u) => u.modelPk != null && onlinePks.has(u.modelPk))
      const costTokens = rows.reduce((s, u) => s + (u.costModelNano ?? 0), 0) / 1e9
      const costTraffic = rows.reduce((s, u) => s + (u.costTrafficNano ?? 0), 0) / 1e9
      return delay({
        ok: true,
        baseUrl: mockOnlineSettings.baseUrl,
        days,
        calls: rows.length,
        promptTokens: rows.reduce((s, u) => s + (u.promptTokens ?? 0), 0),
        completionTokens: rows.reduce((s, u) => s + (u.completionTokens ?? 0), 0),
        bytesIn: rows.reduce((s, u) => s + (u.requestBytes ?? 0), 0),
        bytesOut: rows.reduce((s, u) => s + (u.responseBytes ?? 0), 0),
        costTokens,
        costTraffic,
        costTotal: costTokens + costTraffic,
        currency: 'CNY',
        error: null,
      } as T)
    }

    case 'online_service_sync': {
      const catalog = buildMockCatalog(String(args.baseUrl ?? mockOnlineSettings.baseUrl), String(args.apiKey ?? ''))
      if (!catalog.ok) throw new Error(catalog.error ?? '在线服务不可用')
      // 同步成功同样是「目录有效」的一次证明：刷新快照（Rust 同构）
      mockOnlineCatalog = catalog
      saveMockOnlineCatalog()
      const wantedIds = ((args.modelIds as string[] | null) ?? []).filter(Boolean)
      const wanted = catalog.models.filter((m) => wantedIds.length === 0 || wantedIds.includes(m.id))
      const base = catalog.baseUrl
      let added = 0
      let updated = 0
      for (const m of wanted) {
        const name = `${m.providerName} · ${m.id}`
        const existing = aiModels.find((x) => x.source === 'online' && x.serviceBase === base && x.modelId === m.id)
        if (existing) {
          Object.assign(existing, {
            name,
            baseUrl: `${base}/v1`,
            apiKey: mockOnlineSettings.apiKey,
            priceIn: m.priceIn,
            priceOut: m.priceOut,
            priceCurrency: m.currency,
            trafficPerGb: catalog.trafficPerGb,
            updatedAt: new Date().toISOString(),
          })
          updated += 1
        } else {
          aiModels.push({
            id: ++aiModelId,
            name,
            provider: 'rein-online',
            baseUrl: `${base}/v1`,
            apiKey: mockOnlineSettings.apiKey,
            modelId: m.id,
            isDefault: false,
            vision: null,
            thinking: null,
            effort: null,
            imageMaxEdge: null,
            lastError: null,
            source: 'online',
            serviceBase: base,
            priceIn: m.priceIn,
            priceOut: m.priceOut,
            priceCurrency: m.currency,
            trafficPerGb: catalog.trafficPerGb,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          added += 1
        }
      }
      // 服务端撤下的同源模型会被清掉（手动模型不动）
      const keep = new Set(wanted.map((m) => m.id))
      const before = aiModels.length
      for (let i = aiModels.length - 1; i >= 0; i -= 1) {
        const x = aiModels[i]!
        if (x.source === 'online' && x.serviceBase === base && !keep.has(x.modelId)) aiModels.splice(i, 1)
      }
      const removed = before - aiModels.length
      // 镜像 Rust：无默认时优先 auto-model（服务端默认模型的别名），再退回最早一条
      if (!aiModels.some((x) => x.isDefault) && aiModels.length > 0) {
        const auto = aiModels.find(
          (x) => x.source === 'online' && x.serviceBase === base && x.modelId === 'auto-model',
        )
        ;(auto ?? aiModels[0]!).isDefault = true
      }
      saveAiModels()
      return delay({
        added,
        updated,
        removed,
        models: structuredClone(aiModels.filter((x) => x.source === 'online' && x.serviceBase === base)),
      } as T)
    }

    /* ---- 本机成本账本 ---- */

    case 'ai_usage_record': {
      const input = plain(args.input as AiUsageInput)
      aiUsage.push({
        ...input,
        promptTokens: input.promptTokens ?? 0,
        completionTokens: input.completionTokens ?? 0,
        requestBytes: input.requestBytes ?? 0,
        responseBytes: input.responseBytes ?? 0,
        costModelNano: input.costModelNano ?? 0,
        costTrafficNano: input.costTrafficNano ?? 0,
        at: new Date().toISOString(),
      })
      saveMockUsage()
      return delay(undefined as T)
    }

    case 'ai_usage_summary': {
      const days = Number(args.days ?? 30)
      const since = Date.now() - days * 86_400_000
      const inRange = aiUsage.filter((u) => Date.parse(u.at) >= since)
      return delay(summarizeMockUsage(inRange, days, new Date(since).toISOString()) as T)
    }

    case 'ai_usage_clear':
      aiUsage = []
      saveMockUsage()
      return delay(undefined as T)

    case 'ai_chat_ensure': {
      const id = String(args.id)
      if (!aiChats.has(id)) {
        aiChats.set(id, {
          id,
          seq: 0,
          title: (args.title as string | null) ?? 'AI 对话',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        })
        saveAiChats()
      }
      const c = aiChats.get(id)!
      return delay({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      } as T)
    }

    case 'ai_chat_messages': {
      const id = String(args.chatId)
      const msgs = aiChats.get(id)?.messages ?? []
      return delay(structuredClone(msgs) as T)
    }

    case 'ai_chat_append': {
      const chatId = String(args.chatId)
      const input = plain(args.input as AiChatMessageInput)
      let c = aiChats.get(chatId)
      if (!c) {
        c = {
          id: chatId,
          seq: 0,
          title: 'AI 对话',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        }
        aiChats.set(chatId, c)
      }
      const existing = c.messages.find((m) => m.id === input.id)
      const now = new Date().toISOString()
      if (existing) {
        // 镜像 Rust upsert：重复追加只刷新内容，保持原 seq
        existing.role = input.role
        existing.kind = input.kind
        existing.text = input.text ?? null
        existing.imageBase64 = input.imageBase64 ?? null
        existing.mime = input.mime ?? null
        existing.payload = input.payload ?? null
      } else {
        c.messages.push({
          id: input.id,
          chatId,
          seq: ++c.seq,
          role: input.role,
          kind: input.kind,
          text: input.text ?? null,
          imageBase64: input.imageBase64 ?? null,
          mime: input.mime ?? null,
          payload: input.payload ?? null,
          createdAt: now,
        })
      }
      c.updatedAt = now
      saveAiChats()
      return delay(undefined as T)
    }

    case 'ai_chat_clear': {
      const c = aiChats.get(String(args.chatId))
      if (c) {
        c.messages = []
        c.updatedAt = new Date().toISOString()
        saveAiChats()
      }
      return delay(undefined as T)
    }

    case 'ai_chat_list': {
      const list = [...aiChats.values()].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
      )
      return delay(
        list.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt })) as T,
      )
    }

    case 'ai_chat_cut': {
      const id = String(args.chatId)
      const messageId = String(args.messageId)
      const c = aiChats.get(id)
      if (c) {
        const target = c.messages.find((m) => m.id === messageId)
        if (target) {
          c.messages = c.messages.filter((m) => m.seq < target.seq)
          c.updatedAt = new Date().toISOString()
          saveAiChats()
        }
      }
      return delay(undefined as T)
    }

    case 'ai_chat_rename': {
      const id = String(args.id)
      const title = String(args.title).trim()
      if (!title) throw new Error('会话标题不能为空')
      const c = aiChats.get(id)
      if (c) {
        c.title = title
        c.updatedAt = new Date().toISOString()
        saveAiChats()
      }
      return delay(undefined as T)
    }

    case 'ai_probe': {
      // 浏览器 mock 没有真实网络链路：如实返回「未探测」，由 UI 展示为待探测
      const m = aiModels.find((x) => x.id === Number(args.modelId))
      if (!m) throw new Error('模型不存在')
      return delay(
        plain({ vision: null, thinking: null, effort: null, error: '浏览器 mock 环境不执行真实探测' }) as T,
      )
    }

    case 'ai_agent_run': {
      const params = plain(args.params as Record<string, unknown>)
      const modelId = Number(params.modelId)
      if (!aiModels.some((m) => m.id === modelId)) throw new Error('模型不存在或已删除')
      const runId = `mock-run-${Math.random().toString(36).slice(2, 10)}`
      mockAgentRuns.set(runId, { cancelled: false, pending: new Map() })
      const hook = (window as unknown as { __REIN_MOCK_AGENT__?: { script?: MockAgentStep[] } }).__REIN_MOCK_AGENT__
      const script = hook?.script?.length ? hook.script : defaultAgentScript()
      // 先返回 runId（微任务），脚本在下一个宏任务开始播 —— 让前端壳先认领 runId
      setTimeout(() => {
        mockAgentEmit({ type: 'started', runId })
        void playMockRun(runId, script)
      }, 0)
      return delay(runId as T)
    }

    case 'ai_agent_cancel': {
      const run = mockAgentRuns.get(String(args.runId))
      if (!run) return delay(false as T)
      run.cancelled = true
      run.pending.clear()
      mockAgentRuns.delete(String(args.runId))
      return delay(true as T)
    }

    case 'ai_agent_tool_result': {
      const run = mockAgentRuns.get(String(args.runId))
      const callId = String(args.callId)
      const waiter = run?.pending.get(callId)
      if (!waiter) return delay(false as T)
      waiter({ content: String(args.content ?? ''), isError: Boolean(args.isError) })
      return delay(true as T)
    }

    case 'ai_agent_update_context':
      // 浏览器 mock 不跑真实循环；上下文热更新只需受理（load_tools 的装载逻辑
      // 在工具执行侧仍是真实 TS 代码）
      return delay(Boolean(mockAgentRuns.has(String(args.runId))) as T)

    case 'ai_chat_search': {
      const keyword = String(args.keyword ?? '').trim().toLowerCase()
      if (!keyword) return delay([] as T)
      const limit = Number(args.limit ?? 8)
      const hits: ChatSearchHit[] = []
      for (const c of aiChats.values()) {
        for (const m of c.messages) {
          if ((m.text ?? '').toLowerCase().includes(keyword) || (m.payload ?? '').toLowerCase().includes(keyword)) {
            hits.push({
              chatId: c.id,
              chatTitle: c.title,
              seq: m.seq,
              role: m.role,
              kind: m.kind,
              text: m.text,
              createdAt: m.createdAt,
            })
          }
        }
      }
      hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return delay(hits.slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 8) as T)
    }

    // ---- 健康方案（与 Rust modules/program 同契约：持久化 + 单激活 + 日程重排）----
    case 'program_list':
      return delay(
        structuredClone(programs.sort((a, b) => b.id - a.id).slice(0, 20)) as T,
      )

    case 'program_get_active': {
      const p = [...programs].filter((x) => x.status === 'active').sort((a, b) => b.id - a.id)[0]
      return delay((p ? structuredClone(p) : null) as T)
    }

    case 'program_create': {
      const input = args.input as {
        goal: ProgramRecord['goal']
        tier: ProgramRecord['tier']
        weeks: number
        paramsJson: string
      }
      if (!(input.weeks >= 1 && input.weeks <= 26)) throw new Error('方案周期应为 1~26 周')
      // 单激活约束：旧 active 自动归档，并回收归档方案今天起未完成的日程待办
      // （与 Rust 的 program_create 同语义，含历史归档方案的脏数据自愈）
      for (const x of programs) {
        if (x.status === 'active') {
          x.status = 'archived'
          x.updatedAt = new Date().toISOString()
        }
      }
      for (let i = todos.length - 1; i >= 0; i--) {
        const t = todos[i]!
        if (
          t.programId != null &&
          t.date != null &&
          t.date >= today &&
          t.status !== 'done' &&
          programs.some((x) => x.id === t.programId && x.status === 'archived')
        ) {
          todos.splice(i, 1)
        }
      }
      const now = new Date().toISOString()
      const rec: ProgramRecord = {
        id: ++programId,
        goal: input.goal,
        tier: input.tier,
        status: 'active',
        version: 1,
        weeks: input.weeks,
        paramsJson: input.paramsJson,
        adjustmentsJson: '[]',
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
      }
      programs.push(rec)
      return delay(structuredClone(rec) as T)
    }

    case 'program_update_params': {
      const p = programs.find((x) => x.id === args.id)
      if (!p) throw new Error('方案不存在')
      const input = args.input as { paramsJson: string; adjustmentsJson: string }
      p.paramsJson = input.paramsJson
      p.adjustmentsJson = input.adjustmentsJson
      p.version += 1
      p.updatedAt = new Date().toISOString()
      return delay(structuredClone(p) as T)
    }

    case 'program_archive': {
      const p = programs.find((x) => x.id === args.id)
      if (p) {
        p.status = 'archived'
        p.updatedAt = new Date().toISOString()
      }
      // 与 Rust 同语义：归档即回收 from_date（含）起未完成的日程待办
      const from = String(args.fromDate ?? today)
      let removed = 0
      for (let i = todos.length - 1; i >= 0; i--) {
        const t = todos[i]!
        if (t.programId === args.id && t.date != null && t.date >= from && t.status !== 'done') {
          todos.splice(i, 1)
          removed++
        }
      }
      return delay(removed as T)
    }

    case 'program_meals_get': {
      const row = programMeals.find(
        (m) => m.programId === Number(args.programId) && m.date === String(args.date),
      )
      return delay((row ? structuredClone(row) : null) as T)
    }

    case 'program_meals_range': {
      const pid = Number(args.programId)
      const from = String(args.startDate)
      const to = String(args.endDate)
      const rows = programMeals
        .filter((m) => m.programId === pid && m.date >= from && m.date <= to)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .map((m) => structuredClone(m))
      return delay(rows as T)
    }

    case 'program_meals_set': {
      const pid = Number(args.programId)
      const date = String(args.date)
      const mealsJson = String(args.mealsJson)
      if (!date || !mealsJson) throw new Error('date 与 mealsJson 不能为空')
      if (!programs.some((x) => x.id === pid)) throw new Error('方案不存在')
      const now = new Date().toISOString()
      const i = programMeals.findIndex((m) => m.programId === pid && m.date === date)
      if (i !== -1) programMeals[i] = { programId: pid, date, mealsJson, updatedAt: now }
      else programMeals.push({ programId: pid, date, mealsJson, updatedAt: now })
      return delay(structuredClone(programMeals.find((m) => m.programId === pid && m.date === date)) as T)
    }

    case 'program_meals_clear': {
      const pid = Number(args.programId)
      const from = String(args.fromDate)
      let n = 0
      for (let i = programMeals.length - 1; i >= 0; i--) {
        if (programMeals[i]!.programId === pid && programMeals[i]!.date >= from) {
          programMeals.splice(i, 1)
          n++
        }
      }
      return delay(n as T)
    }

    case 'shopping_checks_list':
      return delay(structuredClone(shoppingChecks) as T)

    case 'shopping_check_set': {
      const key = String(args.itemKey)
      const checked = Boolean(args.checked)
      const i = shoppingChecks.findIndex((c) => c.itemKey === key)
      if (checked) {
        const now = new Date().toISOString()
        if (i !== -1) shoppingChecks[i]!.checkedAt = now
        else shoppingChecks.push({ itemKey: key, checkedAt: now })
      } else if (i !== -1) {
        shoppingChecks.splice(i, 1)
      }
      return delay(undefined as T)
    }

    case 'shopping_checks_clear': {
      const n = shoppingChecks.length
      shoppingChecks.length = 0
      return delay(n as T)
    }

    case 'program_delete': {
      const id = Number(args.id)
      let removed = 0
      for (let i = todos.length - 1; i >= 0; i--) {
        if (todos[i]!.programId !== id) continue
        if (todos[i]!.status === 'done') todos[i]!.programId = null
        else {
          todos.splice(i, 1)
          removed++
        }
      }
      const pi = programs.findIndex((x) => x.id === id)
      if (pi !== -1) programs.splice(pi, 1)
      // 与 Rust 的 ON DELETE CASCADE 同语义：方案删除时清掉每日菜单缓存
      for (let i = programMeals.length - 1; i >= 0; i--) {
        if (programMeals[i]!.programId === id) programMeals.splice(i, 1)
      }
      return delay(removed as T)
    }

    case 'program_schedule_replace': {
      const id = Number(args.id)
      const fromDate = String(args.fromDate)
      const list = args.todos as ScheduleTodoInput[]
      if (!programs.some((x) => x.id === id)) throw new Error('方案不存在')
      for (let i = todos.length - 1; i >= 0; i--) {
        const t = todos[i]!
        if (t.programId === id && t.date !== null && t.date >= fromDate && t.status !== 'done') {
          todos.splice(i, 1)
        }
      }
      for (const item of list) {
        if (!item.title?.trim() || !item.date) continue
        todos.push({
          id: ++todoId,
          title: item.title.trim(),
          notes: item.notes ?? null,
          date: item.date,
          startMin: item.startMin ?? null,
          durationMin: item.durationMin ?? null,
          category: (item.category as Todo['category']) ?? 'general',
          priority: item.priority ?? 0,
          status: 'todo',
          completedAt: null,
          createdAt: new Date().toISOString(),
          programId: id,
          recRule: null,
          recKey: null,
          subtasks: null,
        })
      }
      return delay(list.length as T)
    }

    // voice（语音对话：配置 / 伪造 ASR 事件流 / 纪要 CRUD / 草稿）
    case 'voice_config_get':
      return delay(JSON.parse(JSON.stringify(voiceConfig)) as T)
    case 'voice_config_save':
      voiceConfig = JSON.parse(JSON.stringify(args.config)) as MockVoiceConfig
      return delay(undefined as T)
    case 'voice_config_status': {
      const s = `${voiceConfig.asrBaseUrl} ${voiceConfig.asrResourceId}`.toLowerCase()
      // 'qwen' 与 'bailian' 同协议（百炼/DashScope）：状态统一报 bailian
      const adapter = voiceConfig.asrAdapter === 'auto'
        ? (/(qwen|dashscope|aliyun|bailian|paraformer|fun-asr)/.test(s) ? 'bailian' : 'doubao')
        : voiceConfig.asrAdapter === 'qwen'
          ? 'bailian'
          : voiceConfig.asrAdapter
      const asrReady = adapter === 'bailian'
        ? !!voiceConfig.appKey
        : voiceConfig.mode === 'new'
          ? !!voiceConfig.appKey
          : !!voiceConfig.appKey && !!voiceConfig.accessKey
      // mock 里 TTS 恒可合成；ttsReady 跟随音色是否有值，与真实端语义对齐
      return delay({
        asrReady,
        asrAdapter: adapter,
        ttsReady: !!voiceConfig.voiceName,
        ttsStandalone: !!voiceConfig.ttsCredential?.appKey,
      } as T)
    }
    case 'voice_tts_probe':
      return delay({ audioPath: mockWavDataUrl() } as T)
    case 'voice_asr_probe':
      return delay(undefined as T)
    case 'voice_tts_credential_save':
      voiceConfig.ttsCredential = (args.ttsCredential as MockVoiceConfig['ttsCredential']) ?? null
      return delay(undefined as T)
    case 'voice_asr_start': {
      const sessionId = String(args.sessionId)
      clearVoiceTimers(sessionId)
      voiceFinaled.set(sessionId, new Set())
      const ids: number[] = []
      MOCK_SENTENCES.forEach((sen, i) => {
        ids.push(
          window.setTimeout(() => {
            mockVoice.onAsr?.({ sessionId, kind: 'partial', text: sen.text, startMs: sen.startMs, endMs: sen.endMs })
          }, sen.startMs),
        )
        ids.push(
          window.setTimeout(() => {
            voiceFinaled.get(sessionId)?.add(i)
            mockVoice.onAsr?.({ sessionId, kind: 'final', text: sen.text, startMs: sen.startMs, endMs: sen.endMs })
          }, sen.endMs),
        )
      })
      voiceTimers.set(sessionId, ids)
      return delay(undefined as T)
    }
    case 'voice_asr_audio':
      return delay(undefined as T)
    case 'voice_asr_finish': {
      const sessionId = String(args.sessionId)
      clearVoiceTimers(sessionId)
      // 立即补发尚未 final 的句子 + ended（e2e 不必等真实时长）
      const done = voiceFinaled.get(sessionId) ?? new Set<number>()
      MOCK_SENTENCES.forEach((sen, i) => {
        if (!done.has(i)) {
          mockVoice.onAsr?.({ sessionId, kind: 'final', text: sen.text, startMs: sen.startMs, endMs: sen.endMs })
        }
      })
      voiceFinaled.delete(sessionId)
      mockVoice.onAsr?.({ sessionId, kind: 'ended', durationMs: 3400 })
      return delay(undefined as T)
    }
    case 'voice_asr_cancel':
      clearVoiceTimers(String(args.sessionId))
      voiceFinaled.delete(String(args.sessionId))
      return delay(undefined as T)
    case 'voice_tts_speak':
      return delay({ audioPath: mockWavDataUrl() } as T)
    case 'voice_memo_create': {
      const input = args.input as {
        id: string
        chatId: string
        messageId: string | null
        title?: string
        audioPath?: string | null
        durationMs?: number
        words?: number
        sentencesJson?: string
        summaryJson?: string
      }
      const memo: MockMemo = {
        id: input.id,
        chatId: input.chatId,
        messageId: input.messageId,
        title: input.title ?? '',
        audioPath: input.audioPath ?? null,
        durationMs: input.durationMs ?? 0,
        words: input.words ?? 0,
        sentences: input.sentencesJson ? JSON.parse(input.sentencesJson) : [],
        summary: input.summaryJson ? JSON.parse(input.summaryJson) : [],
        createdAt: new Date().toISOString(),
      }
      voiceMemos.unshift(memo)
      return delay(JSON.parse(JSON.stringify(memo)) as T)
    }
    case 'voice_memo_get': {
      const m = voiceMemos.find((x) => x.id === String(args.id))
      if (!m) throw new Error('纪要不存在')
      return delay(JSON.parse(JSON.stringify(m)) as T)
    }
    case 'voice_memo_list':
      return delay(JSON.parse(JSON.stringify(voiceMemos.slice(0, Number(args.limit ?? 200)))) as T)
    case 'voice_memo_set_summary': {
      const m = voiceMemos.find((x) => x.id === String(args.id))
      if (m) m.summary = JSON.parse(String(args.summaryJson))
      return delay(undefined as T)
    }
    case 'voice_memo_rename': {
      const m = voiceMemos.find((x) => x.id === String(args.id))
      if (m) m.title = String(args.title)
      return delay(undefined as T)
    }
    case 'voice_memo_delete': {
      const idx = voiceMemos.findIndex((x) => x.id === String(args.id))
      if (idx >= 0) voiceMemos.splice(idx, 1)
      return delay(undefined as T)
    }
    case 'voice_draft_save':
      voiceDraft = JSON.parse(String(args.draftJson))
      return delay(undefined as T)
    case 'voice_draft_get':
      return delay((voiceDraft ? JSON.parse(JSON.stringify(voiceDraft)) : null) as T)
    case 'voice_draft_clear':
      voiceDraft = null
      return delay(undefined as T)

    // tracking（跑步前台保活）：纯浏览器开发无需保活，空实现保持契约可见
    case 'tracking_keepalive':
      return delay(undefined as T)
    case 'tracking_status':
      return delay({ granted: true, busy: false, notify: true, native: false } as T)
    // 原生采集命令族：浏览器下 native=false，调用方读到兜底常量后自己走 navigator.geolocation
    case 'tracking_run_begin':
      return delay(undefined as T)
    case 'tracking_run_phase':
      return delay(undefined as T)
    case 'tracking_run_end':
      return delay(undefined as T)
    case 'tracking_live':
      return delay(
        '{"active":false,"autoPaused":false,"elapsedMs":0,"distanceM":0,"paceSecPerKm":null,"lastFixMs":0,"accM":0,"lat":0,"lon":0,"provider":"","gapSlowCount":0,"gapFastCount":0,"gapDropCount":0,"gapSlowMs":0,"gapFastMs":0,"gapDropMs":0,"gapCount":0,"gapMs":0}' as unknown as T,
      )
    case 'tracking_track_take':
      return delay('{"lines":0,"data":""}' as unknown as T)
    case 'tracking_notify':
      return delay(undefined as T)
    case 'tracking_open_pending':
      return delay('' as unknown as T)

    // 全局沉浸浮窗（桌面第二窗口 / Android 系统浮层）：浏览器里没有系统浮窗，
    // 一律如实回「不支持」，上层据此降级为仅程序内浮条 —— 与 docs/GLOBAL-FLOAT.md §2 一致。
    case 'global_float_status':
      return delay({ supported: false, permitted: false, visible: false } as T)
    case 'global_float_open':
      return delay({ supported: false, permitted: false, visible: false } as T)
    case 'global_float_close':
      return delay(undefined as T)
    case 'global_float_push':
      return delay(undefined as T)
    case 'global_float_latest':
      return delay('' as unknown as T)
    case 'global_float_set_form':
      return delay(undefined as T)
    case 'global_float_request_permission':
      return delay({ supported: false, permitted: false, visible: false } as T)
    case 'global_float_take_action':
      return delay('' as unknown as T)

    /* ---------- 多设备同步（浏览器开发用的空实现：形状与 Rust 一致，流程可走通） ---------- */
    case 'sync_status':
      return delay(syncMockStatus() as T)
    case 'sync_set_device_name':
      syncMock.name = String((args as { name?: string } | undefined)?.name ?? syncMock.name)
      return delay(syncMockStatus() as T)
    case 'sync_pair_start':
      // 短码固定，方便在浏览器里把「开码 → 报码 → 完成」这条流程点一遍
      return delay({ code: 'MOCKCODE', expiresAt: Date.now() + 5 * 60 * 1000 } as T)
    case 'sync_pair_poll':
      syncMockPair()
      return delay({ pending: false, peer: syncMockPeer(), room: 'mock-room' } as T)
    case 'sync_pair_claim':
      syncMockPair()
      return delay({ pending: false, peer: syncMockPeer(), room: 'mock-room' } as T)
    case 'sync_run': {
      // 每次点都换一条路，三种路径标签都能在浏览器里看一遍
      const next = SYNC_MOCK_PATHS[syncMock.runCount % SYNC_MOCK_PATHS.length] ?? 'lan'
      syncMock.runCount += 1
      syncMock.lastPath = next
      syncMock.lastAt = Date.now()
      syncMock.lastUp = 4096 + syncMock.runCount * 1024
      syncMock.lastDown = 262144 * syncMock.runCount
      syncMock.objects += 7
      syncMock.peers = syncMock.peers.map((p) => ({ ...p, path: next, lastSeen: syncMock.lastAt }))
      return delay(undefined as T)
    }
    case 'sync_forget':
      syncMock.peers = syncMock.peers.filter(
        (p) => p.device !== String((args as { device?: string } | undefined)?.device ?? ''),
      )
      return delay(syncMockStatus() as T)

    /* ---------- 知识库与长期记忆 ---------- */
    case 'kb_status': {
      kbEnsureIndex()
      // 与 Rust enabled_sources 同语义：全量集合减去显式关闭的
      const allSources = [
        'todo', 'todo_attachment', 'workout', 'plan', 'meal', 'body_metric', 'food',
        'program', 'program_meal', 'voice_memo', 'chat', 'chat_message',
        'chat_attachment', 'memory', 'note',
      ]
      const enabled = allSources.filter((k) => kbSettings.sourcesEnabled[k] !== false)
      return delay({
        mode: kbSettings.embeddingMode,
        docs: kbDocs.length + kbMemories.length,
        chunks: kbDocs.length + kbMemories.length,
        // keyword 模式下永远不会产生向量，如实回 0 而不是假装有
        vectors: kbSettings.embeddingMode === 'keyword' ? 0 : kbDocs.length,
        pending: 0,
        indexing: false,
        progress: { phase: 'idle', done: 0, total: 0 },
        lastError: kbSettings.lastError,
        embedderReady: kbSettings.embeddingMode === 'cloud' ? !!kbSettings.cloudBaseUrl : true,
        vecModel: kbSettings.embeddingMode === 'keyword'
          ? null
          : kbSettings.embeddingMode === 'local'
            ? kbSettings.localModel
            : kbSettings.cloudModel ?? 'bge-small-zh-v1.5-int8',
        enabledSources: enabled.length ? enabled : allSources,
      } as T)
    }

    case 'kb_search': {
      const q = plain(args.query as {
        query?: string
        sources?: string[]
        from?: string
        to?: string
        tags?: string[]
        limit?: number
      })
      const hits = kbSearchMock(String(q?.query ?? ''), q ?? {})
      // 记忆已编目进 kbDocs（见 kbEnsureIndex），与其它来源同池检索
      const merged = hits.filter((h) => !q?.sources?.length || q.sources.includes(h.sourceType))
      return delay(plain(merged) as T)
    }

    case 'kb_read': {
      kbEnsureIndex()
      const id = Number(args.docId)
      const level = String(args.level ?? 'l1')
      const offset = Math.max(Number(args.offset ?? 0), 0)
      const limit = level === 'l1' ? 1 : Math.min(Math.max(Number(args.limit ?? 8), 1), 64)

      const packDoc = (doc: MockKbDoc) => {
        // 与 Rust 一致：note 源直读 kb_files 真源——缓存 body 有 8000 字上限，
        // 全文归档的文档超限后若按缓存切块，AI 分页到头也读不到剩余内容
        const file = doc.sourceType === 'note' ? kbFiles.find((f) => f.id === Number(doc.sourceId)) : undefined
        const chunks = kbChunkText(file ? file.content : doc.body).map((text, ord) => ({ id: doc.id * 1000 + ord, ord, text }))
        const picked = level === 'l1' ? chunks.slice(0, 1) : chunks.slice(offset, offset + limit)
        const textChars = doc.sourceType === 'note' ? (file?.content.length ?? 0) : doc.body.length
        return {
          id: doc.id,
          sourceType: doc.sourceType,
          sourceId: doc.sourceId,
          path: doc.path,
          editable: doc.editable,
          system: doc.system,
          kind: doc.kind,
          title: doc.title,
          summary: doc.summary,
          occurredOn: doc.occurredOn,
          tags: doc.tags,
          meta: {} as Record<string, unknown>,
          updatedAt: doc.updatedAt,
          level,
          totalChunks: chunks.length,
          offset,
          hasMore: offset + picked.length < chunks.length,
          chunks: picked,
          modalities: kbModalsForSource(doc.sourceType, doc.sourceId, textChars).map((m) => m.modal),
        }
      }

      const mem = kbMemories.find((m) => m.id === id)
      if (mem) {
        return delay({
          id,
          sourceType: 'memory',
          sourceId: String(id),
          path: `记忆/${mem.memType}/${mem.topic || '未命名'}-${id}.md`,
          editable: true,
          system: false,
          kind: 'text',
          title: mem.topic ? `记忆 · ${mem.topic}` : `记忆 · ${mem.memType}`,
          summary: mem.content.slice(0, 120),
          occurredOn: mem.createdAt.slice(0, 10),
          tags: [mem.memType],
          meta: { confidence: mem.confidence, memType: mem.memType },
          updatedAt: mem.updatedAt,
          level,
          totalChunks: 1,
          offset: 0,
          hasMore: false,
          chunks: [{ id, ord: 0, text: mem.content }],
          modalities: ['text'],
        } as T)
      }
      const doc = kbDocs.find((d) => d.id === id)
      if (!doc) throw new Error(`知识库条目不存在：id=${id}（先用 search_knowledge 查 id）`)
      return delay(packDoc(doc) as T)
    }

    case 'kb_glob': {
      kbEnsureIndex()
      const pattern = String(args.pattern ?? '')
      const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 200)
      const hits = kbDocs
        .filter((d) => d.path && kbGlobMatch(pattern, d.path))
        .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''))
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          path: d.path,
          sourceType: d.sourceType,
          title: d.title,
          kind: d.kind,
          editable: d.editable,
          system: d.system,
          occurredOn: d.occurredOn,
        }))
      return delay(plain(hits) as T)
    }

    case 'kb_file_write': {
      loadKbStore()
      const input = plain(args.input as { path: string; content: string }) ?? { path: '', content: '' }
      const content = String(input.content ?? '')
      if (!content.trim()) throw new Error('文件内容不能为空')
      let path = kbNormalizePath(String(input.path ?? ''))
      // 落到保留区 / 撞上派生文档时自动让位（与 Rust files::settle_path 同构）
      if (!kbFiles.some((x) => x.path === path)) {
        const cut = path.lastIndexOf('/')
        path = kbFreePath(cut > 0 ? path.slice(0, cut) : '', cut > 0 ? path.slice(cut + 1) : path)
      }
      const now = new Date().toISOString()
      let f = kbFiles.find((x) => x.path === path)
      if (f) {
        f.content = content
        f.kind = 'text'
        f.updatedAt = now
      } else {
        f = {
          id: ++kbFileId,
          path,
          content,
          system: false,
          kind: 'text',
          pinned: false,
          classifyState: path.startsWith('未分类数据/') ? 'inbox' : 'manual',
          createdAt: now,
          updatedAt: now,
        }
        kbFiles.push(f)
      }
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      const doc = kbDocs.find((d) => d.sourceType === 'note' && d.sourceId === String(f!.id))!
      return delay({ ...f, docId: doc.id, modalities: [] } as T)
    }

    case 'kb_file_rename': {
      loadKbStore()
      // 与 Rust resolve_file_id 同语义：收文档 id（glob/检索给的）或文件 id
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (f.system) throw new Error('该文件是系统文件（规范/），不能改名；它的内容随应用版本更新')
      // 目录不补扩展名；文件不覆盖已有扩展名（与 Rust files::rename 同语义）
      let path = kbNormalizePath(String(args.path ?? ''), f.kind === 'folder')
      if (kbIsReservedPath(path)) {
        const cut = path.lastIndexOf('/')
        path = kbFreePath(cut > 0 ? path.slice(0, cut) : '', cut > 0 ? path.slice(cut + 1) : path)
      }
      if (kbFiles.some((x) => x.path === path && x.id !== id)) throw new Error(`目标路径已存在：${path}`)
      // 目录改名要带上整棵子树（与 Rust files::rewrite_subtree 同语义：
      // 只改目录那一行的话，新目录空、旧名字变幽灵目录）
      const oldPath = f.path
      const kids =
        f.kind === 'folder'
          ? kbFiles
              .filter((x) => !x.trashedAt && x.path.startsWith(`${oldPath}/`))
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          : []
      const moved = kids.map((k) => ({ k, to: `${path}${k.path.slice(oldPath.length)}` }))
      for (const m of moved) {
        if (kbFiles.some((x) => x.path === m.to && x.id !== m.k.id)) {
          throw new Error(`目标路径已存在：${m.to}`)
        }
      }
      f.path = path
      f.updatedAt = new Date().toISOString()
      for (const m of moved) {
        m.k.path = m.to
        m.k.updatedAt = f.updatedAt
      }
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      return delay({ ...f, modalities: [] } as T)
    }

    case 'kb_file_delete': {
      loadKbStore()
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (f.system) throw new Error('该文件是系统文件（规范/），不能删除；它的内容随应用版本更新')
      kbFiles.splice(kbFiles.indexOf(f), 1)
      // 模态行级联清掉（对应 Rust 的外键级联）
      for (let i = kbAssets.length - 1; i >= 0; i--) {
        if (kbAssets[i].fileId === id) kbAssets.splice(i, 1)
      }
      saveKbAssets()
      saveKbFiles()
      const di = kbDocs.findIndex((d) => d.sourceType === 'note' && d.sourceId === String(id))
      if (di >= 0) kbDocs.splice(di, 1)
      return delay(undefined as T)
    }

    case 'kb_file_get': {
      loadKbStore()
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      const modals = kbAssets
        .filter((a) => a.fileId === id)
        .map((a) => ({
          modal: a.modal, mime: a.mime, bytes: a.bytes, durationMs: a.durationMs,
          transcriptState: a.transcriptState, derivedFrom: a.derivedFrom, source: 'asset',
        }))
      return delay({ ...f, modalities: modals, rating: f.rating ?? 0, tags: kbParseTags(f.tags), note: f.note ?? '' } as T)
    }

    /* ---------- 文件管理器：一层列举 + 回收站（对应 Rust listing.rs / files.rs） ---------- */

    case 'kb_list_dir': {
      loadKbStore()
      kbEnsureIndex()
      const dir = String(args.path ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (dir.split('/').some((s) => s === '..')) throw new Error(`路径不允许包含 ..：${dir}`)
      const prefix = dir ? `${dir}/` : ''
      const inTrash = (p: string) => p === '回收站' || p.startsWith('回收站/')
      const relOf = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)
      /** 直接子项名（不在子目录里、也不在回收站里），否则 null */
      const directOf = (p: string): string | null => {
        const r = relOf(p)
        return r && !r.includes('/') && !inTrash(p) ? r : null
      }
      const childNames = new Map<string, Set<string>>()
      const folderNodes = new Map<string, MockKbFile>()
      const noteChild = (parent: string, child: string) => {
        const s = childNames.get(parent) ?? new Set<string>()
        s.add(child)
        childNames.set(parent, s)
      }
      const nodes = kbFiles.filter((f) => !f.trashedAt && f.path.startsWith(prefix))
      for (const f of nodes) {
        const d = directOf(f.path)
        if (d) {
          if (f.kind === 'folder') folderNodes.set(d, f)
        } else {
          const segs = relOf(f.path).split('/')
          if (segs.length >= 2) noteChild(segs[0], segs[1])
        }
      }
      const docsIn = kbDocs.filter((d) => d.path && d.path.startsWith(prefix))
      for (const d of docsIn) {
        if (directOf(d.path!)) continue
        const segs = relOf(d.path!).split('/')
        if (segs.length >= 2) noteChild(segs[0], segs[1])
      }
      const metaOf = (f: MockKbFile | undefined) => ({
        rating: f?.rating ?? 0,
        tags: kbParseTags(f?.tags),
        hasNote: !!(f?.note && f.note.trim()),
      })
      const assetBytes = new Map<number, number>()
      const assetModals = new Map<number, string[]>()
      for (const a of kbAssets) {
        if (a.modal !== 'text') assetBytes.set(a.fileId, (assetBytes.get(a.fileId) ?? 0) + a.bytes)
        const list = assetModals.get(a.fileId) ?? []
        if (!list.includes(a.modal)) list.push(a.modal)
        assetModals.set(a.fileId, list)
      }
      const entries: Array<Record<string, unknown>> = []
      const seen = new Set<string>()
      const bytesOf = (f: MockKbFile | undefined, docId: number) =>
        f ? f.content.length + (assetBytes.get(f.id) ?? 0) : (kbDocs.find((d) => d.id === docId)?.body.length ?? 0)
      const dirNames = new Set<string>([...childNames.keys(), ...folderNodes.keys()])
      for (const name of dirNames) {
        const path = dir ? `${dir}/${name}` : name
        const node = folderNodes.get(name)
        if (seen.has(path)) continue
        entries.push({
          id: 0,
          fileId: node?.id ?? null,
          path,
          name,
          kind: 'folder',
          sourceType: '',
          title: name,
          system: node?.system ?? false,
          editable: false,
          size: node ? node.content.length : 0,
          childCount: childNames.get(name)?.size ?? 0,
          occurredOn: null,
          updatedAt: node?.updatedAt ?? '',
          pinned: node?.pinned ?? false,
          classifyState: node?.classifyState ?? '',
          modalities: [] as string[],
          ...metaOf(node),
        })
        seen.add(path)
      }
      for (const d of docsIn) {
        const name = directOf(d.path!)
        // 去重必须用 has 判断：Set.add 返回的是集合本身（永远 truthy），
        // 写成 `!seen.add(x)` 这个守卫就永远不生效 —— 同一个文件会出两条。
        if (!name || d.kind === 'folder' || seen.has(d.path!)) continue
        seen.add(d.path!)
        const node = kbFiles.find((x) => x.path === d.path && !x.trashedAt)
        entries.push({
          id: d.id,
          fileId: node?.id ?? null,
          path: d.path,
          name,
          kind: d.kind,
          sourceType: d.sourceType,
          title: d.title,
          system: d.system || (node?.system ?? false),
          editable: d.editable,
          size: bytesOf(node, d.id),
          childCount: 0,
          occurredOn: d.occurredOn,
          updatedAt: node?.updatedAt ?? d.updatedAt,
          pinned: node?.pinned ?? false,
          classifyState: node?.classifyState ?? '',
          modalities: node ? (assetModals.get(node.id) ?? ['text']) : ['text'],
          ...metaOf(node),
        })
      }
      for (const f of nodes) {
        const name = directOf(f.path)
        if (!name || f.kind === 'folder' || seen.has(f.path)) continue
        seen.add(f.path)
        const modals = assetModals.get(f.id) ?? ['text']
        const kind =
          f.kind === 'multimodal'
            ? modals.includes('video')
              ? 'video'
              : modals.includes('audio')
                ? 'audio'
                : modals.includes('image')
                  ? 'image'
                  : 'file'
            : 'text'
        entries.push({
          id: 0,
          fileId: f.id,
          path: f.path,
          name,
          kind,
          sourceType: 'note',
          title: name.replace(/\.[a-z0-9]+$/i, ''),
          system: f.system,
          editable: !f.system,
          size: f.content.length + (assetBytes.get(f.id) ?? 0),
          childCount: 0,
          occurredOn: null,
          updatedAt: f.updatedAt,
          pinned: f.pinned,
          classifyState: f.classifyState,
          modalities: modals,
          ...metaOf(f),
        })
      }
      // 与 Rust listing.rs 同口径（MAX_SCAN 扫描上限 / MAX_ENTRIES 返回上限，超了置 truncated）：
      // 浏览器里也要能出现「目录过大，仅列出一部分」，否则这条提示的回归没人守。
      const MAX_SCAN = 20000
      const MAX_ENTRIES = 2000
      let truncated = docsIn.length > MAX_SCAN || nodes.length > MAX_SCAN
      entries.sort((a, b) => {
        const ad = a.kind === 'folder' ? 0 : 1
        const bd = b.kind === 'folder' ? 0 : 1
        return ad - bd || String(a.path).localeCompare(String(b.path))
      })
      if (entries.length > MAX_ENTRIES) {
        entries.length = MAX_ENTRIES
        truncated = true
      }
      return delay(plain({ path: dir, entries, total: entries.length, truncated }) as T)
    }

    case 'kb_meta_set': {
      loadKbStore()
      const input = plain(args.input as { id: number; rating?: number; tags?: string[]; note?: string }) ?? { id: 0 }
      const raw = Number(input.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${raw}`)
      if (input.rating !== undefined) f.rating = Math.min(5, Math.max(0, Number(input.rating)))
      if (input.tags !== undefined) {
        // 去空、去重、限长（与 Rust files::set_meta 同规则）
        const clean: string[] = []
        for (const t of input.tags) {
          const v = String(t).trim()
          if (!v || clean.includes(v)) continue
          clean.push(v.slice(0, 24))
          if (clean.length >= 30) break
        }
        f.tags = JSON.stringify(clean)
      }
      if (input.note !== undefined) f.note = String(input.note).slice(0, 4000)
      saveKbFiles()
      const modals = kbAssets
        .filter((a) => a.fileId === id)
        .map((a) => ({
          modal: a.modal, mime: a.mime, bytes: a.bytes, durationMs: a.durationMs,
          transcriptState: a.transcriptState, derivedFrom: a.derivedFrom, source: 'asset',
        }))
      return delay({ ...f, modalities: modals, rating: f.rating ?? 0, tags: kbParseTags(f.tags), note: f.note ?? '' } as T)
    }

    case 'kb_import_path': {
      // 浏览器没有任意路径的读权限：拖入走 File 对象（HTML5 drop）而不是路径
      throw new Error('浏览器模式不支持按路径导入：请用「导入文件」按钮，或把文件拖进列表')
    }

    case 'kb_export_file': {
      // 浏览器里的「导出」是下载（前端用 Blob 触发），没有「落盘路径」这个概念
      throw new Error('浏览器模式没有本地下载目录：导出会直接触发下载')
    }

    case 'kb_trash': {
      loadKbStore()
      kbEnsureIndex()
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id && !x.trashedAt)
      if (!f) throw new Error(`文件不存在或已在回收站：id=${id}`)
      if (f.system) throw new Error('该文件是系统文件（规范/），不能删除；它的内容随应用版本更新')
      const now = new Date().toISOString()
      const rows = kbFiles.filter(
        (x) => !x.trashedAt && (x.path === f.path || x.path.startsWith(`${f.path}/`)),
      )
      for (const row of rows) {
        row.trashFrom = row.path
        row.path = `回收站/${f.id}/${row.path}`
        row.trashedAt = now
        const di = kbDocs.findIndex((d) => d.sourceType === 'note' && d.sourceId === String(row.id))
        if (di >= 0) kbDocs.splice(di, 1)
      }
      saveKbFiles()
      return delay(plain({ fileId: f.id, count: rows.length, path: f.path }) as T)
    }

    case 'kb_trash_list': {
      loadKbStore()
      const limit = Math.min(Math.max(Number(args.limit ?? 200), 1), 500)
      const rows = kbFiles
        .filter((f) => !!f.trashedAt)
        .sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)) || b.id - a.id)
        .slice(0, limit)
        .map((f) => ({
          fileId: f.id,
          id: 0,
          name: f.path.split('/').pop() ?? f.path,
          path: f.path,
          originalPath: f.trashFrom ?? f.path,
          kind: f.kind === 'folder' ? 'folder' : f.kind === 'multimodal' ? 'file' : 'text',
          sourceType: 'note',
          size: f.content.length + (kbAssets.filter((a) => a.fileId === f.id).reduce((n, a) => n + a.bytes, 0)),
          system: f.system,
          trashedAt: f.trashedAt,
          updatedAt: f.updatedAt,
        }))
      return delay(plain(rows) as T)
    }

    case 'kb_trash_restore': {
      loadKbStore()
      const ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => Number(x))
      let done = 0
      const failed: string[] = []
      for (const id of ids) {
        const f = kbFiles.find((x) => x.id === id && !!x.trashedAt)
        if (!f) {
          failed.push(`该文件不在回收站里：id=${id}`)
          continue
        }
        const now = new Date().toISOString()
        const rows = kbFiles
          .filter((x) => !!x.trashedAt && (x.path === f.path || x.path.startsWith(`${f.path}/`)))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        // rows[0] 是子树根；后代跟着「新根 + 原后缀」落位（与 Rust files::untrash 同语义：
        // 各按自己的原路径让位的话，根让位后子项会落进占用原名的那棵树里）
        const oldRoot = rows[0]?.trashFrom ?? rows[0]?.path ?? ''
        let newRoot = ''
        for (const row of rows) {
          const original = row.trashFrom ?? row.path
          const candidate =
            newRoot && original.startsWith(`${oldRoot}/`)
              ? `${newRoot}${original.slice(oldRoot.length)}`
              : original
          const cut = candidate.lastIndexOf('/')
          // 目标被占就让位（与 governance::free_path 同语义：加 -v2）
          const back = kbFreePath(cut > 0 ? candidate.slice(0, cut) : '', cut > 0 ? candidate.slice(cut + 1) : candidate)
          if (!newRoot) newRoot = back
          row.path = back
          row.trashedAt = null
          row.trashFrom = null
          row.updatedAt = now
        }
        saveKbFiles()
        kbIndexed = false
        kbEnsureIndex()
        done += rows.length
      }
      return delay(plain({ done, freedBytes: 0, failed }) as T)
    }

    case 'kb_trash_purge': {
      loadKbStore()
      const ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => Number(x))
      let done = 0
      let freedBytes = 0
      const failed: string[] = []
      for (const id of ids) {
        const f = kbFiles.find((x) => x.id === id)
        if (!f) {
          failed.push(`文件不存在：id=${id}`)
          continue
        }
        if (f.system) {
          failed.push('该文件是系统文件（规范/），不能删除')
          continue
        }
        const rows = kbFiles.filter((x) => x.path === f.path || x.path.startsWith(`${f.path}/`))
        for (const row of rows) {
          freedBytes +=
            row.content.length +
            kbAssets.filter((a) => a.fileId === row.id).reduce((n, a) => n + a.bytes, 0)
          for (let i = kbAssets.length - 1; i >= 0; i--) {
            if (kbAssets[i].fileId === row.id) kbAssets.splice(i, 1)
          }
          const di = kbDocs.findIndex((d) => d.sourceType === 'note' && d.sourceId === String(row.id))
          if (di >= 0) kbDocs.splice(di, 1)
          kbFiles.splice(kbFiles.indexOf(row), 1)
          done += 1
        }
        saveKbFiles()
        saveKbAssets()
      }
      return delay(plain({ done, freedBytes, failed }) as T)
    }

    case 'kb_trash_empty': {
      loadKbStore()
      let done = 0
      let freedBytes = 0
      const rows = kbFiles.filter((f) => !!f.trashedAt)
      for (const row of rows) {
        freedBytes +=
          row.content.length +
          kbAssets.filter((a) => a.fileId === row.id).reduce((n, a) => n + a.bytes, 0)
        for (let i = kbAssets.length - 1; i >= 0; i--) {
          if (kbAssets[i].fileId === row.id) kbAssets.splice(i, 1)
        }
        const di = kbDocs.findIndex((d) => d.sourceType === 'note' && d.sourceId === String(row.id))
        if (di >= 0) kbDocs.splice(di, 1)
        kbFiles.splice(kbFiles.indexOf(row), 1)
        done += 1
      }
      saveKbFiles()
      saveKbAssets()
      return delay(plain({ done, freedBytes, failed: [] }) as T)
    }

    /* ---------- 模态层（对应 Rust kb_media_write / kb_media_get） ---------- */

    case 'kb_media_write': {
      loadKbStore()
      const input = plain(args.input as {
        path: string
        name?: string
        mime: string
        dataBase64: string
        text?: string
      }) ?? { path: '', mime: '', dataBase64: '' }
      const dataUrl = String(input.dataBase64 ?? '')
      if (!dataUrl.trim()) throw new Error('本体为空')
      const name = String(input.name ?? '').trim() || String(input.path ?? '').split('/').pop() || '未命名'
      const mime = String(input.mime ?? '').trim() || kbMimeOfName(name)
      const modal = kbModalOfMime(mime)
      const bytes = Math.round(((dataUrl.split(',').pop() ?? '').length * 3) / 4)
      const path = kbNormalizeMediaPath(String(input.path ?? ''), name)
      const text = String(input.text ?? '').trim() ||
        `【${KB_MODAL_LABEL[modal] ?? '文件'}】${name}（${mime}，${kbHumanSize(bytes)}）`
      const now = new Date().toISOString()
      let f = kbFiles.find((x) => x.path === path)
      if (f) {
        f.content = text
        f.kind = 'multimodal'
        f.updatedAt = now
      } else {
        f = {
          id: ++kbFileId,
          path,
          content: text,
          system: false,
          kind: 'multimodal',
          pinned: false,
          classifyState: path.startsWith('未分类数据/') ? 'inbox' : 'manual',
          createdAt: now,
          updatedAt: now,
        }
        kbFiles.push(f)
      }
      const existing = kbAssets.find((a) => a.fileId === f!.id && a.modal === modal)
      if (existing) {
        existing.ref = dataUrl
        existing.mime = mime
        existing.bytes = bytes
      } else {
        kbAssets.push({
          id: ++kbAssetId,
          fileId: f.id,
          modal,
          mime,
          ref: dataUrl,
          bytes,
          durationMs: null,
          transcriptState: modal === 'audio' || modal === 'video' ? 'none' : 'done',
          derivedFrom: null,
          createdAt: now,
        })
      }
      saveKbFiles()
      saveKbAssets()
      kbIndexed = false
      kbEnsureIndex()
      const modals = kbAssets
        .filter((a) => a.fileId === f!.id)
        .map((a) => ({
          modal: a.modal, mime: a.mime, bytes: a.bytes, durationMs: a.durationMs,
          transcriptState: a.transcriptState, derivedFrom: a.derivedFrom, source: 'asset',
        }))
      return delay({ ...f, modalities: modals } as T)
    }

    case 'kb_media_get': {
      loadKbStore()
      kbEnsureIndex()
      const docId = Number(args.docId)
      const requested = args.modal ? String(args.modal) : null
      const doc = kbDocs.find((d) => d.id === docId)
      if (!doc) throw new Error(`知识库条目不存在：id=${docId}（先用 search_knowledge 查 id）`)
      const file = doc.sourceType === 'note' ? kbFiles.find((f) => f.id === Number(doc.sourceId)) : undefined
      const textBody = file ? file.content : doc.body
      const infos = kbModalsForSource(doc.sourceType, doc.sourceId, textBody.length)
      const base = {
        docId,
        path: doc.path,
        title: doc.title,
        kind: doc.kind,
        modalities: infos,
        requested,
        degraded: false,
        degradeReason: null as string | null,
        mime: null as string | null,
        dataUrl: null as string | null,
        tooLarge: false,
        text: null as string | null,
        hint: null as string | null,
      }
      if (!requested) {
        return delay({
          ...base,
          hint: `该节点可用模态：${infos.map((m) => m.modal).join('、')}；需要本体时用 modal 指定`,
        } as T)
      }
      if (requested === 'text') {
        if (!infos.some((m) => m.modal === 'text')) {
          return delay({
            ...base,
            degraded: true,
            degradeReason: '该节点没有文本模态',
            text: `【${doc.kind}】${doc.title}（本体不在工作区，只有元信息）`,
          } as T)
        }
        return delay({ ...base, text: textBody } as T)
      }
      const info = infos.find((m) => m.modal === requested)
      if (!info) {
        return delay({
          ...base,
          degraded: true,
          degradeReason: `该节点没有 ${requested} 模态，已降级为文本`,
          text: textBody,
          hint: '已降级为文本模态；本体确实不存在时不要反复重试',
        } as T)
      }
      // 本体：asset（内联 data URL）或语音纪要（mock 生成静音 wav）
      let dataUrl: string | null = null
      if (info.source === 'voice') dataUrl = mockWavDataUrl()
      else if (info.source === 'asset') {
        dataUrl = kbAssets.find((a) => a.fileId === Number(doc.sourceId) && a.modal === requested)?.ref ?? null
      }
      const hint =
        info.transcriptState === 'none' && (requested === 'audio' || requested === 'video')
          ? '该本体尚未转写，暂不提供派生文本'
          : null
      return delay({ ...base, mime: info.mime, dataUrl, hint } as T)
    }

    /* ---------- 目录治理（对应 Rust kb_fs_*） ---------- */

    case 'kb_fs_move': {
      loadKbStore()
      const src = String(args.source ?? 'user')
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (KB_SYSTEM_ROOTS.includes(f.path.split('/')[0] ?? '')) {
        throw new Error(`${f.path} 在系统命名空间，只读`)
      }
      if (src === 'ai' && f.pinned) throw new Error(`${f.path} 被用户钉住（pin），AI 不能移动它`)
      const dir = String(args.toDir ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (src === 'ai') {
        const recent = kbMoves.find(
          (m) => m.pathTo === f!.path && m.source === 'ai' && m.op === 'move' && !m.undone &&
            Date.now() - new Date(m.at).getTime() < 24 * 3600 * 1000,
        )
        if (recent) throw new Error(`${f.path} 一天内已被自动整理过，暂不再移动（防抖）`)
      }
      const base = f.path.split('/').pop() ?? f.path
      const to = kbFreePath(dir, base)
      let batchId = ''
      const from = f.path
      if (to !== f.path) {
        // 目录 + 整棵子树一起搬（与 Rust governance::move_to 同语义）
        const kids =
          f.kind === 'folder'
            ? kbFiles.filter((x) => !x.trashedAt && x.path.startsWith(`${from}/`))
            : []
        const moved = kids.map((k) => ({ k, to: `${to}${k.path.slice(from.length)}` }))
        for (const m of moved) {
          if (kbFiles.some((x) => x.path === m.to && x.id !== m.k.id)) {
            throw new Error(`目标路径已存在：${m.to}`)
          }
        }
        f.path = to
        for (const m of moved) {
          m.k.path = m.to
          m.k.updatedAt = new Date().toISOString()
        }
        f.classifyState = dir.startsWith('未分类数据') ? 'inbox' : 'filed'
        f.updatedAt = new Date().toISOString()
        batchId = kbAudit(src, 'move', from, to, String(args.reason ?? ''))
        saveKbFiles()
        kbIndexed = false
        kbEnsureIndex()
      }
      return delay({ file: { ...f, modalities: [] }, from, to, batchId } as T)
    }

    case 'kb_fs_mkdir': {
      loadKbStore()
      const path = String(args.path ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (!path) throw new Error('目录路径不能为空')
      if (KB_SYSTEM_ROOTS.includes(path.split('/')[0] ?? '')) {
        throw new Error(`${path} 在系统命名空间，只读`)
      }
      if (kbIsReservedPath(path)) throw new Error(`${path} 落在派生文档的保留命名空间里，不能建目录`)
      if (kbFiles.some((x) => x.path === path)) throw new Error(`路径已存在：${path}`)
      const now = new Date().toISOString()
      const f: MockKbFile = {
        id: ++kbFileId,
        path,
        content: `【目录】${path}`,
        system: false,
        kind: 'folder',
        pinned: false,
        classifyState: 'manual',
        createdAt: now,
        updatedAt: now,
      }
      kbFiles.push(f)
      kbAudit(String(args.source ?? 'user'), 'mkdir', '', path, String(args.reason ?? ''))
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      return delay({ ...f, modalities: [] } as T)
    }

    case 'kb_fs_pin': {
      loadKbStore()
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (KB_SYSTEM_ROOTS.includes(f.path.split('/')[0] ?? '')) {
        throw new Error(`${f.path} 在系统命名空间，只读`)
      }
      const pinned = Boolean(args.pinned)
      f.pinned = pinned
      f.classifyState = pinned ? 'manual' : 'filed'
      f.updatedAt = new Date().toISOString()
      kbAudit(String(args.source ?? 'user'), pinned ? 'pin' : 'unpin', f.path, f.path, pinned ? '用户钉住' : '取消钉住')
      saveKbFiles()
      return delay({ ...f, modalities: [] } as T)
    }

    case 'kb_fs_moves': {
      loadKbStore()
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200)
      return delay(plain([...kbMoves].sort((a, b) => b.id - a.id).slice(0, limit)) as T)
    }

    case 'kb_fs_undo': {
      loadKbStore()
      const batchId = String(args.batchId ?? '')
      let n = 0
      for (const m of [...kbMoves].filter((x) => x.batchId === batchId && !x.undone).sort((a, b) => b.id - a.id)) {
        if (m.op === 'move' && m.pathFrom && m.pathTo) {
          const f = kbFiles.find((x) => x.path === m.pathTo)
          if (f) {
            const cut = m.pathFrom.lastIndexOf('/')
            const back = kbFreePath(cut > 0 ? m.pathFrom.slice(0, cut) : '', cut > 0 ? m.pathFrom.slice(cut + 1) : m.pathFrom)
            f.path = back
            f.updatedAt = new Date().toISOString()
          }
        }
        m.undone = true
        n++
      }
      saveKbMoves()
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      return delay(n as T)
    }

    case 'kb_injection_get':
      return delay(plain(kbInjection()) as T)

    case 'kb_reindex': {
      kbIndexed = false
      kbEnsureIndex()
      return delay(kbDocs.length as T)
    }

    case 'kb_settings_get':
      return delay({
        embeddingMode: kbSettings.embeddingMode,
        localModel: kbSettings.localModel,
        cloudBaseUrl: kbSettings.cloudBaseUrl,
        cloudApiKeyTail: kbSettings.cloudApiKey ? `…${kbSettings.cloudApiKey.slice(-4)}` : null,
        cloudModel: kbSettings.cloudModel,
        cloudDim: kbSettings.cloudDim,
        sourcesEnabled: kbSettings.sourcesEnabled,
        autoMemory: kbSettings.autoMemory,
        autoConsolidate: kbSettings.autoConsolidate,
        lastConsolidateAt: kbSettings.lastConsolidateAt,
        lastError: kbSettings.lastError,
        updatedAt: kbSettings.updatedAt,
      } as T)

    case 'kb_settings_set': {
      const input = plain(args.input as Record<string, unknown>) ?? {}
      if (input.embeddingMode !== undefined) {
        const mode = String(input.embeddingMode)
        if (!['keyword', 'local', 'cloud'].includes(mode)) {
          throw new Error(`未知的检索模式：${mode}（可选 keyword / local / cloud）`)
        }
        kbSettings.embeddingMode = mode as typeof kbSettings.embeddingMode
      }
      if (input.localModel !== undefined && String(input.localModel).trim()) {
        kbSettings.localModel = String(input.localModel).trim()
      }
      if (input.cloudBaseUrl !== undefined) kbSettings.cloudBaseUrl = String(input.cloudBaseUrl) || null
      if (input.cloudApiKey !== undefined) {
        const v = String(input.cloudApiKey)
        // 传空串=清除；不传=保留（前端拿不到明文）
        kbSettings.cloudApiKey = v.trim() ? v : null
      }
      if (input.cloudModel !== undefined) kbSettings.cloudModel = String(input.cloudModel) || null
      if (input.cloudDim !== undefined) kbSettings.cloudDim = Number(input.cloudDim) || null
      if (input.sourcesEnabled !== undefined) kbSettings.sourcesEnabled = input.sourcesEnabled as Record<string, boolean>
      if (input.autoMemory !== undefined) kbSettings.autoMemory = Boolean(input.autoMemory)
      if (input.autoConsolidate !== undefined) kbSettings.autoConsolidate = Boolean(input.autoConsolidate)
      kbSettings.updatedAt = new Date().toISOString()
      saveKbSettings()
      return mockInvoke<T>('kb_settings_get', {})
    }

    case 'kb_probe_embedder': {
      if (kbSettings.embeddingMode === 'keyword') {
        throw new Error('当前是纯关键词模式，没有可测试的嵌入后端')
      }
      // 浏览器里没有真的推理后端，如实报错而不是假装成功
      throw new Error('浏览器 mock 环境没有本地嵌入后端（真实应用走 ONNX Runtime）')
    }

    case 'kb_rebuild_vectors':
      return delay(0 as T)

    /* ---------- 压缩包（mock 用 jszip 真解，行为与 Rust 对齐） ---------- */

    case 'kb_archive_list': {
      loadKbStore()
      const docId = Number(args.docId)
      const doc = kbDocs.find((d) => d.id === docId)
      if (!doc) throw new Error(`知识库条目不存在：id=${docId}（先用 glob_knowledge 查 id）`)
      const asset = kbAssets.find((a) => a.fileId === Number(doc.sourceId) && a.modal !== 'text')
      if (!asset?.ref) throw new Error('该节点没有可读的本体（只有文本模态），不是压缩包')
      const { mockArchiveList } = await import('./archiveMock')
      return delay(plain(await mockArchiveList(asset.ref, doc.title)) as T)
    }

    case 'kb_archive_extract': {
      loadKbStore()
      const docId = Number(args.docId)
      const doc = kbDocs.find((d) => d.id === docId)
      if (!doc) throw new Error(`知识库条目不存在：id=${docId}`)
      const asset = kbAssets.find((a) => a.fileId === Number(doc.sourceId) && a.modal !== 'text')
      if (!asset?.ref) throw new Error('该节点没有可读的本体（只有文本模态），不是压缩包')
      const { mockArchiveExtract } = await import('./archiveMock')
      const report = await mockArchiveExtract(asset.ref, doc.title, {
        toDir: args.toDir ? String(args.toDir) : undefined,
        only: (args.only as string[] | undefined) ?? [],
      })
      const now = new Date().toISOString()
      // 落点目录让位（与 Rust 一致：同名目录加 -2，绝不覆盖既有内容）
      const target = kbFreeDir(report.target)
      const items: Array<Record<string, unknown>> = []
      for (const f of report.files) {
        // 不覆盖：同名产物自动 -v2（与 Rust free_child_path 同语义）
        const path = kbFreeChildPath(target, f.path)
        const row: MockKbFile = {
          id: ++kbFileId,
          path,
          content: f.text !== null ? f.text : `【文件】${f.path}`,
          system: false,
          kind: f.text !== null ? 'text' : 'multimodal',
          pinned: false,
          classifyState: 'inbox',
          createdAt: now,
          updatedAt: now,
        }
        kbFiles.push(row)
        if (f.text === null) {
          kbAssets.push({
            id: ++kbAssetId, fileId: row.id, modal: 'binary', mime: f.mime, ref: f.dataUrl,
            bytes: f.bytes, durationMs: null, transcriptState: 'done', derivedFrom: null, createdAt: now,
          })
        }
        items.push({ id: row.id, path, bytes: f.bytes, kind: f.text !== null ? 'text' : 'binary' })
      }
      saveKbFiles()
      saveKbAssets()
      kbIndexed = false
      kbEnsureIndex()
      return delay(plain({
        format: report.format, target, extracted: items,
        skipped: report.skipped, bytes: report.bytes, truncated: report.truncated,
        message: `已解压到 ${target}/：${items.length} 个文件（浏览器 mock）`,
      }) as T)
    }

    /* ---------- 空间管理 ---------- */

    case 'kb_usage': {
      loadKbStore()
      const top = Math.max(0, Math.min(Number(args.top ?? 20), 100))
      const minBytes = Math.max(0, Number(args.minBytes ?? 0))
      const textBytesOf = (f: MockKbFile): number => new Blob([f.content]).size
      const assetsOf = (id: number): number =>
        kbAssets.filter((a) => a.fileId === id).reduce((s2, a) => s2 + a.bytes, 0)
      const textBytes = kbFiles.filter((f) => f.kind !== 'folder').reduce((s2, f) => s2 + textBytesOf(f), 0)
      const assetBytes = kbAssets.reduce((s2, a) => s2 + a.bytes, 0)
      const areaMap = new Map<string, { bytes: number; count: number }>()
      const modalMap = new Map<string, { bytes: number; count: number }>()
      for (const f of kbFiles) {
        if (f.kind === 'folder') continue
        const area = f.path.includes('/') ? f.path.split('/')[0] : f.path
        const cur = areaMap.get(area) ?? { bytes: 0, count: 0 }
        cur.bytes += textBytesOf(f) + assetsOf(f.id)
        cur.count++
        areaMap.set(area, cur)
      }
      for (const a of kbAssets) {
        const cur = modalMap.get(a.modal) ?? { bytes: 0, count: 0 }
        cur.bytes += a.bytes
        cur.count++
        modalMap.set(a.modal, cur)
      }
      const sourceMap = new Map<string, { bytes: number; count: number }>()
      for (const d of kbDocs) {
        const cur = sourceMap.get(d.sourceType) ?? { bytes: 0, count: 0 }
        cur.bytes += new Blob([d.body ?? '']).size
        cur.count++
        sourceMap.set(d.sourceType, cur)
      }
      const largest = kbFiles
        .filter((f) => f.kind !== 'folder')
        .map((f) => ({
          id: f.id, path: f.path, kind: f.kind,
          bytes: textBytesOf(f) + assetsOf(f.id),
          textBytes: textBytesOf(f), assetBytes: assetsOf(f.id), updatedAt: f.updatedAt,
        }))
        .filter((f) => f.bytes >= minBytes)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, top)
      // 索引口径与 Rust 一致：正文快照 + 分块文本 + 向量（mock 的向量按 512 维 f32 计）
      const indexBytes = kbDocs.reduce((s2, d) => {
        const src = kbFiles.find((f) => d.sourceType === 'note' && d.sourceId === String(f.id))
        const chunks = kbChunkText(src ? src.content : (d.body ?? ''))
        const chunkBytes = chunks.reduce((s3, t) => s3 + new Blob([t]).size, 0)
        return s2 + new Blob([d.body ?? '']).size + chunkBytes + chunks.length * 512 * 4
      }, 0)
      const slices = (m: Map<string, { bytes: number; count: number }>): Array<{ name: string; bytes: number; count: number }> =>
        [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes)
      const totalBytes = textBytes + assetBytes
      const human = (n: number): string =>
        n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`
      return delay(plain({
        totalBytes, textBytes, assetBytes, indexBytes,
        dbBytes: 0,
        fileCount: kbFiles.length, docCount: kbDocs.length, assetCount: kbAssets.length,
        areas: slices(areaMap), sources: slices(sourceMap), modals: slices(modalMap),
        largest,
        orphanCount: 0, orphanBytes: 0, missingCount: 0,
        summary: `工作区共 ${human(totalBytes)}（文本 ${human(textBytes)} + 本体 ${human(assetBytes)}）：${kbFiles.length} 个文件节点、${kbDocs.length} 条索引文档、${kbAssets.length} 个本体（浏览器 mock 环境，不落磁盘）`,
      }) as T)
    }

    case 'kb_usage_clean':
      return delay({ removed: 0, bytes: 0, dryRun: Boolean(args.dryRun), message: '浏览器 mock 环境没有可清理的碎片' } as T)

    /* ---------- 本地嵌入模型（目录与 Rust 注册表一致；浏览器不能下载） ---------- */

    case 'kb_embed_models': {
      const { MOCK_EMBED_MODELS } = await import('./embedModelsMock')
      return delay(plain({
        models: MOCK_EMBED_MODELS.map((m) => ({
          ...m,
          installed: m.bundled,
          diskBytes: m.bundled ? m.bytes : 0,
          downloading: false,
        })),
        current: kbSettings.localModel,
        mode: kbSettings.embeddingMode,
        dir: '(浏览器 mock 没有模型目录)',
      }) as T)
    }

    case 'kb_embed_model_download':
      throw new Error('浏览器 mock 不能下载模型（真实应用从 hf-mirror / ModelScope 拉取）')

    case 'kb_embed_model_cancel':
      return delay(undefined as T)

    case 'kb_embed_model_remove':
      throw new Error('浏览器 mock 没有已下载的模型')

    case 'kb_embed_test': {
      const input = plain(args.input as { texts?: string[]; localModel?: string; cloud?: unknown }) ?? {}
      const texts = (input.texts ?? []).map((t) => String(t).trim()).filter(Boolean)
      if (!texts.length) throw new Error('请至少输入一段文本')
      const modelId = input.cloud ? '(云端测试)' : input.localModel ?? kbSettings.localModel
      const t0 = performance.now()
      const vecs = texts.map((t) => mockEmbed(t))
      const vectors = texts.map((t, i) => ({
        text: t.slice(0, 40),
        dim: vecs[i].length,
        preview: vecs[i].slice(0, 8).map((x) => Number(x.toFixed(4))),
        norm: Number(Math.sqrt(vecs[i].reduce((s2, x) => s2 + x * x, 0)).toFixed(4)),
        ms: 0.1,
      }))
      const ranking = texts
        .slice(1)
        .map((t, i) => ({ text: t.slice(0, 60), score: Number(mockCosine(vecs[0], vecs[i + 1]).toFixed(4)) }))
        .sort((a, b) => b.score - a.score)
      return delay(plain({
        modelId: `${modelId}（浏览器伪嵌入）`,
        dim: 512,
        vectors,
        ranking,
        buildMs: 0.3,
        totalMs: Number((performance.now() - t0).toFixed(1)),
        note: '浏览器 mock 用字符三元组哈希模拟向量：交互可用，模型质量要在真机看',
      }) as T)
    }

    case 'kb_memory_duplicates': {
      loadKbStore()
      const threshold = Number(args.threshold ?? 0.86)
      const limit = Number(args.limit ?? 30)
      // 与 Rust 同口径：只扫描最近 DUP_SCAN_LIMIT 条（那边是 SQL 的 ORDER BY id DESC LIMIT 400），
      // 否则 n² 在浏览器主线程上会随记忆库线性变慢
      const active = kbMemories
        .filter((m) => !m.archivedAt)
        .sort((a, b) => b.id - a.id)
        .slice(0, DUP_SCAN_LIMIT)
      const vecs = new Map(active.map((m) => [m.id, mockMemVec(m.id, m.content)]))
      const pairs: Array<Record<string, unknown>> = []
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i]
          const b = active[j]
          const score = mockCosine(vecs.get(a.id)!, vecs.get(b.id)!)
          if (score < threshold) continue
          pairs.push({
            aId: Math.min(a.id, b.id), bId: Math.max(a.id, b.id),
            score: Number(score.toFixed(3)),
            aContent: a.content.slice(0, 120), bContent: b.content.slice(0, 120),
          })
        }
      }
      pairs.sort((a, b) => Number(b.score) - Number(a.score))
      return delay(plain(pairs.slice(0, limit)) as T)
    }

    case 'kb_memory_diffs': {
      loadMockMemoryDiffs()
      const limit = Number(args.limit ?? 5)
      return delay(plain(mockMemoryDiffs.slice(0, limit)) as T)
    }

    case 'kb_memories': {
      loadKbStore()
      const t = args.memType as string | undefined
      const scope = (args.scope as string | undefined) ?? 'active'
      let list = t ? kbMemories.filter((m) => m.memType === t) : kbMemories.slice()
      if (scope === 'active') list = list.filter((m) => !m.archivedAt)
      else if (scope === 'archived') list = list.filter((m) => m.archivedAt)
      // 活跃永远排在归档前面；组内按最近修改
      list.sort(
        (a, b) =>
          Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      return delay(plain(list.map(kbDocToMemory)) as T)
    }

    case 'kb_memory_apply': {
      loadKbStore()
      const candidates = plain(args.candidates as Record<string, unknown>[]) ?? []
      const chatId = (args.chatId as string | undefined) ?? null
      let added = 0
      let updated = 0
      let deleted = 0
      let archived = 0
      let restored = 0
      let skipped = 0
      const validTypes = ['preference', 'constraint', 'event', 'entity', 'profile', 'pattern']
      // 分类规范化：按 / 分层、逐段净化、最多两层（与 Rust normalize_category 对齐）
      const normalizeCategory = (raw: unknown): string =>
        String(raw ?? '')
          .split('/')
          .map((s) => s.trim().replace(/[\\:*?"<>|\n\r\t]/g, '-').replace(/^-+|-+$/g, ''))
          .filter(Boolean)
          .slice(0, 2)
          .join('/')
          .slice(0, 40)
      for (const c of candidates) {
        const op = String(c.op ?? '')
        if (op === 'delete') {
          const id = Number(c.id)
          const i = kbMemories.findIndex((m) => m.id === id)
          if (i >= 0) {
            kbMemories.splice(i, 1)
            kbDropMemoryDoc(id)
            deleted++
          } else skipped++
          continue
        }
        if (op === 'archive') {
          const id = Number(c.id)
          const m = kbMemories.find((x) => x.id === id)
          if (m && !m.archivedAt) {
            m.archivedAt = new Date().toISOString()
            m.archivedReason = String(c.reason ?? '').trim() || 'manual'
            kbDropMemoryDoc(id)
            archived++
          } else skipped++
          continue
        }
        const content = String(c.content ?? '').trim()
        if (!content) {
          skipped++
          continue
        }
        const memType = validTypes.includes(String(c.memType)) ? String(c.memType) : 'preference'
        const topic = String(c.topic ?? '').trim()
        const category = normalizeCategory(c.category)
        if (op === 'add') {
          const dup = kbMemories.find((m) => m.memType === memType && m.topic === topic && m.content === content)
          if (dup) {
            // 命中已归档条目 = 用户又提到了它 → 复活，而不是当重复跳过
            if (dup.archivedAt) {
              dup.archivedAt = null
              dup.archivedReason = null
              dup.updatedAt = new Date().toISOString()
              restored++
            } else skipped++
            continue
          }
          const now = new Date().toISOString()
          kbMemories.push({
            id: ++kbMemoryId,
            memType,
            topic,
            category,
            content,
            confidence: Number(c.confidence ?? 0.7),
            activeCount: 0,
            sourceChatId: chatId,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
            archivedAt: null,
            archivedReason: null,
          })
          added++
        } else if (op === 'update') {
          const id = Number(c.id)
          const m = kbMemories.find((x) => x.id === id)
          if (!m) {
            skipped++
            continue
          }
          // 更新 = 重新确认：归档中的条目借机复活
          const wasArchived = Boolean(m.archivedAt)
          Object.assign(m, {
            memType,
            topic,
            category,
            content,
            confidence: Number(c.confidence ?? m.confidence),
            updatedAt: new Date().toISOString(),
            archivedAt: null,
            archivedReason: null,
          })
          if (wasArchived) restored++
          else updated++
        } else {
          throw new Error(`记忆操作只支持 add / update / delete / archive，收到：${op}`)
        }
      }
      if (added || updated || deleted || archived || restored) {
        mockMemoryDiffs.unshift({
          at: new Date().toISOString(),
          payload: { candidates: candidates.length, added, updated, deleted, archived, restored, skipped },
        })
        mockMemoryDiffs.length = Math.min(mockMemoryDiffs.length, 20)
        saveMockMemoryDiffs()
        saveKbMemories()
        // 编目同步：新增/更新/复活走重建；删除与归档已直接摘除文档
        if (added > 0 || updated > 0 || restored > 0) {
          kbIndexed = false
          kbEnsureIndex()
        }
      }
      return delay({ added, updated, deleted, archived, restored, skipped } as T)
    }

    case 'kb_memory_delete': {
      loadKbStore()
      const id = Number(args.id)
      const i = kbMemories.findIndex((m) => m.id === id)
      if (i < 0) return delay(false as T)
      kbMemories.splice(i, 1)
      kbDropMemoryDoc(id)
      saveKbMemories()
      return delay(true as T)
    }

    case 'kb_memory_archive': {
      loadKbStore()
      const id = Number(args.id)
      const m = kbMemories.find((x) => x.id === id)
      if (!m || m.archivedAt) return delay(false as T)
      m.archivedAt = new Date().toISOString()
      m.archivedReason = String(args.reason ?? '').trim() || 'manual'
      kbDropMemoryDoc(id)
      saveKbMemories()
      return delay(true as T)
    }

    case 'kb_memory_restore': {
      loadKbStore()
      const id = Number(args.id)
      const m = kbMemories.find((x) => x.id === id)
      if (!m || !m.archivedAt) return delay(false as T)
      m.archivedAt = null
      m.archivedReason = null
      m.updatedAt = new Date().toISOString()
      saveKbMemories()
      kbIndexed = false
      kbEnsureIndex()
      return delay(true as T)
    }

    case 'kb_memory_maintain': {
      loadKbStore()
      let checked = 0
      let archived = 0
      for (const m of kbMemories) {
        if (m.archivedAt) continue
        checked++
        const idle = kbIdleDays(m)
        const stale = kbSalience(m) < KB_STALE_SALIENCE
        const due =
          (m.activeCount === 0 && idle > KB_NEVER_USED_PRUNE_DAYS) ||
          (stale && idle > KB_STALE_PRUNE_DAYS)
        if (due) {
          m.archivedAt = new Date().toISOString()
          m.archivedReason = 'decay'
          kbDropMemoryDoc(m.id)
          archived++
        }
      }
      kbSettings.lastMaintainAt = new Date().toISOString()
      saveKbMemories()
      saveKbSettings()
      return delay({ checked, archived } as T)
    }

    case 'kb_memory_stats': {
      loadKbStore()
      const activeList = kbMemories.filter((m) => !m.archivedAt)
      const sorted = activeList.slice().sort((a, b) => kbSalience(b) - kbSalience(a) || b.id - a.id)
      // 与 Rust cognition_selection 相同的双上限：条数 + 字符
      let injected = 0
      let injectedChars = 0
      for (const m of sorted) {
        if (injected >= 24) break
        const line = kbCognitionLine(m)
        if (injectedChars + line.length + 1 > 1200) break
        injectedChars += line.length + 1
        injected++
      }
      const stale = activeList.filter((m) => kbSalience(m) < KB_STALE_SALIENCE).length
      const avg = (f: (m: MockKbMemory) => number): number =>
        activeList.length
          ? Number((activeList.reduce((s, m) => s + f(m), 0) / activeList.length).toFixed(3))
          : 0
      return delay({
        active: activeList.length,
        archived: kbMemories.length - activeList.length,
        total: kbMemories.length,
        limit: 24,
        maxChars: 1200,
        injected,
        injectedChars,
        stale,
        avgConfidence: avg((m) => m.confidence),
        avgSalience: avg((m) => kbSalience(m)),
        signalRatio: activeList.length ? Number((injected / activeList.length).toFixed(3)) : 1,
        noiseRatio: activeList.length ? Number((stale / activeList.length).toFixed(3)) : 0,
        autoConsolidate: kbSettings.autoConsolidate,
        lastConsolidateAt: kbSettings.lastConsolidateAt,
        lastMaintainAt: kbSettings.lastMaintainAt,
      } as T)
    }

    case 'kb_memory_consolidated': {
      loadKbStore()
      kbSettings.lastConsolidateAt = new Date().toISOString()
      saveKbSettings()
      return delay(undefined as T)
    }

    case 'kb_cognition': {
      loadKbStore()
      // 归档不进注入；排序与 Rust 一致：显著性降序
      const sorted = kbMemories
        .filter((m) => !m.archivedAt)
        .sort((a, b) => kbSalience(b) - kbSalience(a) || b.id - a.id)
        .slice(0, 24)
      let text = ''
      for (const m of sorted) {
        const line = kbCognitionLine(m)
        if (text.length + line.length + 1 > 1200) break
        text = text ? `${text}\n${line}` : line
      }
      return delay({ memories: plain(sorted.map(kbDocToMemory)), text } as T)
    }

    case 'kb_memory_bump': {
      loadKbStore()
      const ids = (args.ids as number[]) ?? []
      const now = new Date().toISOString()
      for (const id of ids) {
        const m = kbMemories.find((x) => x.id === id)
        if (m) {
          m.activeCount++
          m.lastUsedAt = now
        }
      }
      saveKbMemories()
      return delay(undefined as T)
    }

    /* ---------- 校园教务（演示数据，只在 mock 里存在） ---------- */

    case 'campus_systems':
      // 与 Rust 的 REGISTRY 同序同形。**字段名与语义必须与 `provider::list_info` 一致**：
      // 少一个 shortName，选择器与摘要入口在浏览器里就会显示成空白。
      return delay([
        {
          kind: 'guet-supwisdom-eams5',
          name: '桂林电子科技大学 · 本科生教学信息平台（正式）',
          shortName: '桂林电子科技大学',
          vendor: '树维 Supwisdom EAMS5 · 学生端 · bkjw.guet.edu.cn（正式选课在这里）',
          defaultBaseUrl: 'https://bkjw.guet.edu.cn',
          baseUrlHint: '默认指向学校测试环境；切换到正式环境时改这里。',
          loginStrategy: 'supwisdom-portal-rsa',
          bizTypeId: 2,
          mayRequireCaptcha: true,
        },
        {
          kind: 'guet-supwisdom-eams5-test',
          name: '桂林电子科技大学 · 本科生教学信息平台（测试）',
          shortName: '桂林电子科技大学',
          vendor: '树维 Supwisdom EAMS5 · 学生端 · bkjwtest.guet.edu.cn（联调用，风控更松）',
          defaultBaseUrl: 'https://bkjwtest.guet.edu.cn',
          baseUrlHint: '默认指向学校测试环境；切换到正式环境时改这里。',
          loginStrategy: 'supwisdom-portal-rsa',
          bizTypeId: 2,
          mayRequireCaptcha: true,
        },
        {
          kind: 'gxust-zfsoft-zftal',
          name: '广西科技大学 · 教学管理信息平台',
          shortName: '广西科技大学',
          vendor: '正方 ZFSoft zftal-ui-v5 · jwxt.gxust.edu.cn',
          defaultBaseUrl: 'https://jwxt.gxust.edu.cn',
          baseUrlHint: '学校正式教务地址；除非学校另行通知，不要改。',
          loginStrategy: 'zfsoft-login-rsa',
          // 正方没有「培养层次」这个概念（学期就是学年 + 学期代码）
          bizTypeId: null,
          mayRequireCaptcha: true,
        },
      ] as T)

    case 'campus_account_get':
      return delay((campusAccount ? { ...campusAccount } : null) as T)

    case 'campus_captcha': {
      campusNeedCaptcha = true
      // 1×1 的透明 JPEG，仅用于占位（真实环境由后端返回教务的图）
      const px =
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
      return delay(px as T)
    }

    case 'campus_login': {
      const loginName = String(args.loginName ?? '').trim()
      const password = String(args.password ?? '')
      // 与真后端同一套回落：密码留空 = 用账号里存下的那份（会话过期后的静默重登）
      const known = campusAccount?.loginName === loginName ? campusAccount : null
      const canReuseSaved = password === '' && known?.hasPassword === true
      if (!loginName || (password === '' && !canReuseSaved)) {
        const message = known
          ? '该账号没有保存密码，需要重新输入密码登录'
          : '请输入学号与密码'
        return delay({ ok: false, message, needCaptcha: false, actionRequired: null, account: null } as T)
      }
      // 演示约定：密码长度 < 3 视为「需要验证码」，方便在浏览器里走一遍验证码分支
      if (password.length < 3 && !canReuseSaved && !campusNeedCaptcha) {
        campusNeedCaptcha = true
        return delay({ ok: false, message: '需要输入验证码', needCaptcha: true, actionRequired: null, account: null } as T)
      }
      campusAccount = {
        id: 1,
        systemKind: String(args.systemKind ?? 'guet-supwisdom-eams5'),
        baseUrl: String(args.baseUrl ?? 'https://bkjwtest.guet.edu.cn'),
        loginName,
        hasPassword: args.savePassword !== false,
        loggedIn: true,
        sessionAt: new Date().toISOString(),
        studentId: '241250',
        studentCode: loginName,
        studentName: '演示同学',
        department: '计算机与信息安全学院',
        major: '智能科学与技术',
        adminclass: `${loginName.slice(0, 8)}01`,
        grade: '2026',
        totalCredits: 18.75,
        savePassword: args.savePassword !== false,
        active: true,
        lastSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      campusNeedCaptcha = false
      return delay({ ok: true, message: null, needCaptcha: false, actionRequired: null, account: { ...campusAccount } } as T)
    }

    case 'campus_session_probe':
      return delay((campusAccount?.loggedIn ?? false) as T)

    case 'campus_logout':
      if (campusAccount) {
        campusAccount.loggedIn = false
        campusAccount.sessionAt = null
      }
      return delay(undefined as T)

    case 'campus_account_delete': {
      campusAccount = null
      campusCourses = []
      campusPickedLessons = new Set<number>()
      campusSelectQueue = []
      campusSelectRequestId = ''
      campusSelectPolls = 0
      // 任务单与计划随账号一起清：换账号后旧任务不该还在后台排队
      grabTasks.length = 0
      grabIntents.length = 0
      grabEmit()
      // 删账号 = 连派生行一起清（与 Rust 一致：todos 未开外键级联，必须显式删）
      for (let i = todos.length - 1; i >= 0; i--) {
        if (todos[i]!.courseSessionId != null) todos.splice(i, 1)
      }
      return delay(undefined as T)
    }

    case 'campus_semesters':
      return delay((campusAccount ? [campusSemester()] : []) as T)

    case 'campus_set_current_semester':
      return delay(undefined as T)

    case 'campus_sync': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      campusCourses = campusDemoCourses()
      campusAccount.lastSyncAt = new Date().toISOString()
      const sem = campusSemester()
      const todosWritten = campusMaterializeTodos()
      return delay({
        courses: campusCourses.length,
        sessions: CAMPUS_SESSIONS.length,
        todosWritten,
        semesterId: sem.id,
        semesterName: sem.name,
        syncedAt: new Date().toISOString(),
        skippedActivities: 0,
      } as T)
    }

    case 'campus_schedule': {
      if (!campusAccount) {
        return delay({ account: null, semester: null, entries: [], timeSlots: [], courses: [] } as T)
      }
      const sem = campusSemester()
      const fallback = campusRange()
      const from = String(args.from ?? fallback[0])
      const to = String(args.to ?? fallback[1])
      return delay({
        account: { ...campusAccount },
        semester: sem,
        entries: campusExpand(sem, from, to),
        // 时间轴与 Rust 的 `build_time_axis` 同口径：节次表 ∪ 实际排课区间 → 互斥片段。
        // 有节次表就是逐节轴（第1节 08:00-08:40），课块再按占的节次跨行（见周视图）。
        timeSlots: buildAxisRows(CAMPUS_PERIOD_SLOTS, CAMPUS_SESSIONS),
        courses: campusCourses,
      } as T)
    }

    case 'campus_holiday_config_get': {
      const plan = campusHolidayPlan()
      const makeups: Record<string, number> = {}
      for (const [date, wd] of plan.makeup) makeups[date] = wd
      // 覆盖值原样带出（含 0 = 不补），好让设置页那一行仍在、可改回
      for (const [date, wd] of Object.entries(campusHolidayCfg.overrides)) makeups[date] = wd
      const sem = campusSemester()
      const years = [...new Set([Number(sem.startDate.slice(0, 4)), Number(sem.endDate.slice(0, 4))])]
      return delay({
        enabled: campusHolidayCfg.enabled,
        overrides: { ...campusHolidayCfg.overrides },
        makeups,
        years,
      } as T)
    }

    case 'campus_holiday_config_set': {
      const cfg = args.config as { enabled?: boolean; overrides?: Record<string, number> } | undefined
      campusHolidayCfg = {
        enabled: cfg?.enabled ?? true,
        overrides: { ...(cfg?.overrides ?? {}) },
      }
      // 开关/覆盖一变，时间线派生行立刻跟着变（与 Rust 的 campus_holiday_config_set 同语义）
      if (campusAccount) campusMaterializeTodos()
      return delay(undefined as T)
    }

    case 'campus_course_detail': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      // 与 Rust 适配器同一条口径：正方那套教务**没有课程详情接口**
      // （`AnyAdapter::fetch_course_detail` 直接返回「暂不支持」）。mock 照同样的样子失败 ——
      // 否则「本机档案兜底」那条分支在浏览器里永远走不到，而它正是正方用户唯一的详情来源。
      if (campusAccount.systemKind === 'gxust-zfsoft-zftal') {
        throw new Error('广西科技大学的正方教务系统暂不支持查看课程详情')
      }
      const lessonId = Number(args.lessonId)
      const weekday = args.weekday == null ? null : Number(args.weekday)
      const startUnit = args.startUnit == null ? null : Number(args.startUnit)
      const mine = CAMPUS_SESSIONS.filter((s) => s.courseId === lessonId)
      if (!mine.length) throw new Error(`课表里找不到课程 ${lessonId} 的上课时段`)
      const s =
        mine.find(
          (x) => (weekday == null || x.weekday === weekday) && (startUnit == null || x.startUnit === startUnit),
        ) ?? mine[0]!
      const weeks = [...s.weeks].sort((a, b) => a - b)
      return delay({
        courseName: s.courseName,
        courseCode: s.courseCode,
        lessonCode: null,
        lessonName: null,
        description: null,
        room: s.room,
        roomAlias: s.building,
        campus: s.campus,
        weekday: s.weekday,
        startUnit: s.startUnit,
        endUnit: s.endUnit,
        startTime: s.startTime,
        endTime: s.endTime,
        bigSection: s.startUnit > 0 ? Math.ceil(s.startUnit / 2) : 0,
        weeksStr: s.weeksStr,
        startWeek: weeks[0] ?? null,
        endWeek: weeks[weeks.length - 1] ?? null,
        teachers: s.teachers,
        credits: s.credits,
        courseTypeCode: null,
        courseTypeName: s.courseType,
        examCategory: '考试',
        examType: '统一考试',
        courseProperty: '必修',
        openDepartment: '计算机与信息安全学院',
        major: (campusAccount.major as string | null) ?? null,
        grade: (campusAccount.grade as string | null) ?? null,
        semesterName: campusSemester().name,
        capacity: 60,
        enrolled: 52,
        hasExperiment: false,
        experimentBatch: 0,
        experimentBatchNo: null,
        experimentName: null,
        remark: null,
        period: {
          total: 48,
          weeks: 16,
          theory: 48,
          practice: null,
          test: null,
          experiment: null,
          machine: null,
          design: null,
          extra: null,
        },
      } as T)
    }

    /* ---- 选课（演示批次是「开放中」，好让整套流程能在浏览器里走通） ---- */


    /* ---------- 全校开课查询（两个域都检测） ---------- */

    case 'campus_lesson_search_probe': {
      // 与 Rust 的结论保持一致：bkjw 是另一套系统（/student/** 全 404），
      // bkjwtest 才是这套 EAMS5。演示数据要如实反映，否则界面会骗人。
      return delay([
        {
          baseUrl: 'https://bkjw.guet.edu.cn',
          reachable: true,
          lessonSearchRoute: false,
          eamsAssets: false,
          hint: '另一套系统（ASP.NET + ExtJS 桌面，登录走 CAS）',
          pageStatus: 404,
          assetStatus: 404,
          detail: '开课查询入口 404、EAMS5 静态资源 404 —— 这个域上没有 EAMS5，另一套系统（ASP.NET + ExtJS 桌面，登录走 CAS）',
        },
        {
          baseUrl: 'https://bkjwtest.guet.edu.cn',
          reachable: true,
          lessonSearchRoute: true,
          eamsAssets: true,
          hint: '树维 EAMS5（本应用打通的那一套）',
          pageStatus: 302,
          assetStatus: 200,
          detail: '开课查询入口 302、EAMS5 静态资源 200 —— 这条路通',
        },
      ] as T)
    }

    case 'campus_lesson_search': {
      if (!campusAccount) {
        throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      }
      const page = Number(args.page ?? 1)
      const pageSize = Number(args.pageSize ?? 20)
      const hits = campusLessonSearchHits()
      const start = (page - 1) * pageSize
      return delay({
        domains: [
          {
            baseUrl: 'https://bkjw.guet.edu.cn',
            reachable: true,
            lessonSearchRoute: false,
            eamsAssets: false,
            hint: '另一套系统（ASP.NET + ExtJS 桌面，登录走 CAS）',
            pageStatus: 404,
            assetStatus: 404,
            detail: '开课查询入口 404、EAMS5 静态资源 404 —— 这个域上没有 EAMS5',
          },
          {
            baseUrl: 'https://bkjwtest.guet.edu.cn',
            reachable: true,
            lessonSearchRoute: true,
            eamsAssets: true,
            hint: '树维 EAMS5（本应用打通的那一套）',
            pageStatus: 302,
            assetStatus: 200,
            detail: '开课查询入口 302、EAMS5 静态资源 200 —— 这条路通',
          },
        ],
        usedBaseUrl: 'https://bkjwtest.guet.edu.cn',
        page: {
          hits: hits.slice(start, start + pageSize),
          page,
          pageSize,
          total: hits.length,
          rawKeys: ['rows', 'total'],
        },
        semesters: [campusSemester()],
      } as T)
    }
    case 'campus_course_select_status': {
      if (!campusAccount) {
        throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      }
      return delay({
        ready: true,
        reason: null,
        serverTime: campusServerTime(),
        studentId: 241250,
        studentCode: campusAccount.loginName ?? '2600350118',
        studentName: '演示同学',
        turns: campusSelectTurns(),
        entryUrl: `${campusAccount.baseUrl ?? 'https://bkjwtest.guet.edu.cn'}/course-selection/?token=demo`,
        // 与 Rust 的 is_production_base 同一条判定：**只有 bkjwtest 不算生产**。
        // 判定「不是测试域」而不是「等于某个常量」—— 用户可能填反向代理域名，
        // 那种同样不该被当成测试域。
        production: !String(campusAccount.baseUrl ?? '').toLowerCase().includes('bkjwtest'),
      } as T)
    }

    case 'campus_course_select_lessons': {
      // 课程名 / 教学班名 / 教师是三个独立字段，界面那个搜索框三个都发
      // （与 Rust 侧和 SPA 一致），所以这里任意一个命中即可。
      //
      // **刻意不匹配项目名（`minorCourse`）**：教务的查询里没有这个字段 ——
      // 真实服务器搜「羽毛球」就是一段空列表（课程名是「大学体育1」）。
      // mock 在这里放水，界面那条「本地兜底过滤」就永远测不到、
      // 真机上也就永远不知道自己漏了它。
      const q = (args.query ?? {}) as Record<string, unknown>
      const kws = [q.courseNameOrCode, q.lessonNameOrCode, q.teacherNameOrCode]
        .map((v) => String(v ?? '').trim().toLowerCase())
        .filter(Boolean)
      const all = campusDemoLessons()
      const list = kws.length
        ? all.filter((l) => {
            const hay = [
              l.course.nameZh,
              l.course.nameEn ?? '',
              l.course.code,
              l.lessonName ?? '',
              ...(l.teachers ?? []).map((t: { nameZh?: string }) => t?.nameZh ?? ''),
            ]
              .join(' ')
              .toLowerCase()
            return kws.some((kw) => hay.includes(kw))
          })
        : all
      return delay(list as T)
    }

    case 'campus_course_select_simplest_lessons':
      return delay(campusDemoLessons() as T)

    case 'campus_course_select_query_condition':
      // 批次未定义筛选表单时返回 null —— 界面据此回落到内置的搜索框
      return delay(null as T)

    case 'campus_course_select_apply': {
      const id = Number(args.lessonId)
      const picked = campusPickedLessons
      if (picked.has(id)) throw new Error('这门课已经选过了')
      campusSelectQueue.push(id)
      campusSelectRequestId = `req${Date.now()}`
      campusSelectPolls = 0
      return delay({ requestId: campusSelectRequestId } as T)
    }

    case 'campus_course_select_predicate': {
      campusSelectQueue.push(Number(args.lessonId))
      campusSelectRequestId = `pre${Date.now()}`
      campusSelectPolls = 0
      return delay({ requestId: campusSelectRequestId } as T)
    }

    case 'campus_course_select_result':
    case 'campus_course_select_predicate_result': {
      // 前两轮返回「处理中」，之后成功 —— 复刻真实教务的异步受理手感
      campusSelectPolls++
      if (campusSelectPolls < 2) {
        return delay({ pending: true, success: false, message: null, needAttend: false } as T)
      }
      const id = campusSelectQueue.shift()
      // 冲突演示：这门课固定返回「需要免听」，**不算选中** —— 真机上这条路
      // 也只是告诉你去网页端办免听，列表里不该出现「已选」。
      if (id === 9003) {
        return delay({ pending: false, success: false, message: null, needAttend: true } as T)
      }
      if (id != null) campusPickedLessons.add(id)
      return delay({ pending: false, success: true, message: null, needAttend: false } as T)
    }

    case 'campus_course_select_drop': {
      const ids = (args.lessonIds as unknown[] | undefined) ?? []
      for (const id of ids) campusPickedLessons.delete(Number(id))
      // 退课同样要「意向 → 正式」走一遍，所以给一点受理延迟
      return delay({
        pending: false,
        success: true,
        message: '已退课',
        needAttend: false,
      } as T)
    }

    /* ---- 自动抢课（模拟引擎见文件上方 grabTick） ---- */

    case 'campus_grab_state':
      return delay(grabSnapshot() as T)

    // 模块开关：真后端会落 app_meta 并停掉引擎线程；mock 里没有线程，收到即认。
    // 留着这一条是为了让「拨开关 → 同步给引擎」这条链路在浏览器里也不报缺命令。
    case 'campus_grab_set_enabled':
      return delay(undefined as T)

    /* ---- 救援面（AI 的最后补救） ---- */

    case 'campus_rescue_state': {
      // e2e 钩子：把在场（或刚被抢到）的任务打成「连败到该被救」的样子。真引擎里这种状态
      // 要靠连续撞满员/未知错误攒出来，在无头浏览器里等不起，但它恰恰是 AI 最常要处理的那种。
      //
      // 两条细节都是踩出来的：
      // ① 终态的也要拉回来 —— 从「加计划」到「第一次读现场」之间有十几秒，mock 引擎早就抢到手了，
      //    只对非终态生效的话这个场景会随机落空；
      // ② 顺带按在「等窗口公布」上（`probeAt` 推到一小时外），否则引擎下一拍就把它抢走，
      //    「救一个卡住的任务」根本无从演练。
      if ((globalThis as { __REIN_MOCK_CAMPUS_STUCK__?: boolean }).__REIN_MOCK_CAMPUS_STUCK__) {
        for (const t of grabTasks) {
          if (t.status === 'paused') continue
          if (GRAB_TERMINAL.has(t.status)) {
            t.status = 'waiting'
            t.phase = 'idle'
            t.finishedAt = null
          }
          t.strikes = 5
          t.strikeKind = 'full'
          t.lastMessage = '教学班人数已满，继续守着'
          t.awaitWindow = true
          t.windowWall = null
          t.windowEndWall = null
          t.probeAt = Date.now() + 3600_000
        }
      }
      const snap = grabSnapshot()
      const now = Date.now()
      const tasks = snap.tasks as unknown as Array<{ id: number; status: string; strikes: number; nextAt: number }>
      const dead = !!(globalThis as { __REIN_MOCK_CAMPUS_SESSION_DEAD__?: boolean })
        .__REIN_MOCK_CAMPUS_SESSION_DEAD__
      return delay({
        account: campusAccount ? { ...campusAccount } : null,
        // 探针：没有账号 = null（没探）；被踢 = false；其余 = true
        sessionAlive: campusAccount ? !dead : null,
        sessionError: null,
        grab: snap,
        stuckTaskIds: tasks
          .filter((t) => !GRAB_TERMINAL.has(t.status) && t.status !== 'paused')
          .filter((t) => t.strikes >= 3 || t.nextAt <= now)
          .map((t) => t.id),
        recentActions: [...mockAiActions].reverse(),
      } as T)
    }

    case 'campus_http': {
      const req = plain((args.req ?? {}) as Record<string, unknown>)
      const raw = String(req.url ?? '').trim()
      const method = String(req.method ?? 'GET').toUpperCase()
      const reason = String(req.reason ?? '').trim()
      if (!reason) throw new Error('reason 不能为空：这条请求想搞清楚什么？')
      const base = String(campusAccount?.baseUrl ?? 'https://bkjwtest.guet.edu.cn')
      const url = /^https?:\/\//.test(raw) ? raw : `${base.replace(/\/$/, '')}${raw.startsWith('/') ? '' : '/'}${raw}`
      const sameOrigin = url.startsWith(base.replace(/\/$/, ''))
      const withToken = !!req.withSelectToken
      const withSession = req.withSession == null ? sameOrigin : !!req.withSession
      // 与 Rust 同一条硬边界：带凭据只许打教务同源（安静的降级比报错更危险）
      if (!sameOrigin && (withSession || withToken)) {
        throw new Error(`带凭据的请求只能打教务自己的域名（${base}），${url} 是外部地址`)
      }
      for (const h of (req.headers as [string, string][] | undefined) ?? []) {
        if (/^(cookie|authorization|host|content-length)$/i.test(String(h[0]))) {
          throw new Error(`请求头「${h[0]}」不允许手写：会话与令牌走 withSession / withSelectToken`)
        }
      }
      const script = mockHttpScript(url)
      const headers: [string, string][] = [
        ['content-type', script.contentType],
        ...(sameOrigin ? ([['set-cookie', '__pstsid__=demo; Path=/']] as [string, string][]) : []),
      ]
      const curl = mockRenderCurl({
        method,
        url,
        headers: (req.headers as [string, string][] | undefined) ?? [],
        body: (req.body as string | null) ?? null,
        withCookie: withSession,
        withToken,
      })
      mockAction('http', `${method} ${url} → HTTP ${script.status}`, curl, script.status < 400 ? 'ok' : 'error', {
        reason,
      })
      return delay({
        url,
        method,
        status: script.status,
        ok: script.status >= 200 && script.status < 300,
        sameOrigin,
        withSession,
        withSelectToken: withToken,
        headers,
        body: script.body,
        truncated: false,
        bytes: script.body.length,
        elapsedMs: 120,
        curl,
        healed: false,
        note: sameOrigin ? null : '外部地址：这条请求没有携带任何教务凭据',
      } as T)
    }

    case 'campus_rescue_note': {
      const kind = String(args.kind ?? '').trim()
      if (!kind) throw new Error('kind 不能为空')
      const summary = String(args.summary ?? '').trim()
      if (!summary) throw new Error('summary 不能为空')
      return delay(mockAction(kind, summary, null, 'ok', args.detail ?? undefined) as T)
    }

    case 'campus_curl_export': {
      const hours = Number(args.hours ?? 6)
      const entries = mockAiActions.filter((a) => a.curl)
      if (!entries.length) {
        throw new Error(`最近 ${hours} 小时里没有可导出的请求。先在 App 里打几条真实请求再导出。`)
      }
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
      const lines = [
        '#!/usr/bin/env bash',
        `# Rein 教务救援脚本 · 生成于 ${d.toISOString()}`,
        '#',
        '# 这是什么：把 AI 在 App 里对教务发出的请求**原样搬下来**，脱离 App 也能重放。',
        '# 用法：bash 本文件（逐条执行，每条之间空一行）。',
        '#',
        '# ⚠ 凭据是生成那一刻的快照：Cookie 通常几小时失效，选课令牌（JWT）更短。',
        '#   过期后不要手工改这里面的值，重新导出一次即可。',
        '# ⚠ 文件里有你自己的账号凭据，别传到别处去。',
        'set -euo pipefail',
        '',
        `BASE=${q(String(campusAccount?.baseUrl ?? 'https://bkjwtest.guet.edu.cn'))}`,
      ]
      if (entries.some((e) => e.curl?.includes('$COOKIE'))) lines.push(`COOKIE='__pstsid__=demo; SESSION=demo'`)
      if (entries.some((e) => e.curl?.includes('$SELECT_TOKEN'))) lines.push(`SELECT_TOKEN='eyJhbGciOiJIUzI1NiJ9.demo.demo'`)
      entries.forEach((e, i) => {
        lines.push('', `# ── ${i + 1}) ${e.at} · ${e.summary}`, String(e.curl), 'echo')
      })
      const script = lines.join('\n')
      const path = `C:\\Users\\demo\\AppData\\Roaming\\com.gozaoo.rein\\rescue\\rescue-${stamp}.sh`
      mockAction('script', `导出救援脚本：${entries.length} 条请求 → ${path}`)
      return delay({
        path,
        script,
        count: entries.length,
        generatedAt: d.toISOString(),
      } as T)
    }

    case 'campus_grab_enqueue': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      const targets = (args.targets as Record<string, unknown>[] | undefined) ?? []
      if (!targets.length) throw new Error('没有要抢的课程')
      const mode = ((args.mode as string | null) ?? 'predicate') as 'predicate' | 'direct'
      // e2e 钩子：假装教务还没公布窗口，用来验「等窗口」这条真实状态
      const noWindow = !!(globalThis as { __REIN_MOCK_GRAB_NO_WINDOW__?: boolean })
        .__REIN_MOCK_GRAB_NO_WINDOW__
      const windowWall = noWindow ? null : ((args.windowWall as string | null) ?? null)
      const windowEndWall = noWindow ? null : ((args.windowEndWall as string | null) ?? null)

      const ids: number[] = []
      for (const t of targets) {
        const task = grabPushTask({
          turnId: String(args.turnId ?? ''),
          turnName: (args.turnName as string | null) ?? null,
          lessonId: t.lessonId,
          lessonName: (t.lessonName as string | null) ?? null,
          courseName: (t.courseName as string | null) ?? null,
          courseCode: (t.courseCode as string | null) ?? null,
          teacher: (t.teacher as string | null) ?? null,
          credits: (t.credits as number | null) ?? null,
          mode,
          virtualCost: (t.virtualCost as number | null) ?? null,
          scheduleGroupId: t.scheduleGroupId ?? null,
          windowWall,
          windowEndWall,
          groupKey: (t.groupKey as string | null) ?? null,
          groupName: (t.groupName as string | null) ?? null,
          priority: (t.priority as number | null) ?? 0,
        })
        ids.push(task.id)
      }
      grabEmit()
      return delay(ids as T)
    }

    /* ---- 抢课计划（模拟解析见文件上方 grabResolveIntents） ---- */

    case 'campus_grab_intent_add': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('要先写清楚想抢什么（课名 / 代码 / 教师）')
      const intent: MockGrabIntent = {
        id: ++grabIntentSeq,
        turnId: args.turnId ? String(args.turnId) : null,
        turnName: (args.turnName as string | null) ?? null,
        query,
        mode: args.mode === 'direct' ? 'direct' : 'predicate',
        spread: !!args.spread,
        status: 'pending',
        groupKeys: [],
        candidates: [],
        lastMessage: null,
        attempts: 0,
        nextAt: 0,
        createdAt: Date.now(),
        resolvedAt: null,
      }
      grabIntents.push(intent)
      grabEmit()
      return delay({ ...intent } as T)
    }

    case 'campus_grab_intent_action': {
      const id = Number(args.intentId)
      const i = grabIntents.findIndex((x) => x.id === id)
      if (i < 0) throw new Error('计划不存在（可能已被移除）')
      if (String(args.action) === 'remove') {
        // 与 Rust 一致：移除计划连它派出去的任务一起收
        const keys = grabIntents[i]!.groupKeys ?? []
        for (const t of grabTasks) {
          if (keys.includes(grabGroupOf(t)) && !GRAB_TERMINAL.has(t.status)) {
            t.status = 'cancelled'
            t.phase = 'idle'
            t.finishedAt = Date.now()
            t.lastMessage = '计划已移除'
          }
        }
        grabIntents.splice(i, 1)
      } else if (String(args.action) === 'now') {
        const it = grabIntents[i]!
        it.status = 'pending'
        it.nextAt = 0
        it.lastMessage = '正在重新解析教学班…'
      } else {
        throw new Error(`未知的操作：${String(args.action)}`)
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_intent_preview': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      const query = String(args.query ?? '').trim()
      const briefs = grabIntentBriefs()
      const want = args.turnId ? String(args.turnId) : null
      const brief = want
        ? briefs.find((b) => b.id === want)
        : (briefs.find((b) => b.allowEnter) ?? briefs[0])
      if (!brief) {
        throw new Error('教务还没公布选课批次，等它出现后预览会自动可用')
      }
      const lessons = campusDemoLessons()
      // 与 Rust 一致：走放宽阶梯（严格匹不到时才丢词），并把丢了什么带回去给界面
      const relaxed = grabRelaxedMatch(query, lessons)
      const hits = relaxed.hits
      const pool = grabPreferred(hits)
      return delay({
        turnId: brief.id,
        turnName: brief.name,
        total: lessons.length,
        matched: hits.length,
        // 与真引擎一致：打全了老师名字时只列那位老师的班
        matches: pool.slice(0, 30).map(grabMatchDto),
        // 跨课程告警：与解析共用同一条规则（grabAmbiguousCourses）
        ambiguous: grabAmbiguousCourses(query, pool),
        relaxNote: relaxed.relaxNote,
        droppedWords: relaxed.dropped,
        lessonsNote: null,
      } as T)
    }

    /**
     * 起飞前自检（与 Rust 侧 `campus_grab_preflight` 同形）。
     *
     * mock 里没有网络与令牌，所以它给的是**结构正确、内容取自当前 mock 状态**的结果：
     * 界面靠它验证「逐项 + 证据 + 总结」这套呈现，而不是验证教务。
     */
    case 'campus_grab_preflight': {
      const briefs = grabIntentBriefs()
      const brief = briefs.find((b) => b.allowEnter) ?? briefs[0]
      const lessons = campusDemoLessons()
      const items = [
        {
          key: 'account',
          label: '教务登录与选课令牌',
          ok: !!campusAccount,
          detail: campusAccount ? '会话有效，选课令牌可用（学生 id=1）' : '还没有绑定教务账号',
        },
        {
          key: 'turn',
          label: '选课批次',
          ok: !!brief?.allowEnter,
          detail: brief
            ? `可进入：「${brief.name ?? brief.id}」窗口 ${brief.windowStart ?? '未公布'} ~ ${brief.windowEnd ?? '未公布'}`
            : '教务还没公布选课批次',
        },
        {
          key: 'clock',
          label: '时钟校准',
          ok: true,
          detail: '教务与本机相差 120ms（不确定度 ±200ms，4 次采样、取交集）',
        },
        {
          key: 'lessons',
          label: '教学班名单',
          ok: lessons.length > 0,
          detail: `${lessons.length} 个教学班`,
        },
        ...grabIntents.map((it) => {
          const relaxed = grabRelaxedMatch(String(it.query ?? ''), lessons)
          const groups = grabPreferred(relaxed.hits)
          return {
            key: 'plan',
            label: `计划「${it.query}」`,
            ok: groups.length > 0,
            detail: groups.length
              ? `「${it.query}」→ ${groups.length} 个候选`
              : `「${it.query}」一个教学班都没匹配到`,
          }
        }),
      ]
      const bad = items.filter((x) => !x.ok)
      return delay({
        ok: bad.length === 0,
        items,
        summary: bad.length ? `${bad.length} 项没过：${bad.map((b) => b.label).join('、')}` : `全部 ${items.length} 项通过 —— 到点就会出手`,
      } as T)
    }

    case 'campus_grab_task_action': {
      const id = Number(args.taskId)
      const t = grabFind(id)
      if (!t) throw new Error('任务不存在（可能已被清理）')
      switch (String(args.action)) {
        case 'pause':
          t.status = 'paused'
          t.phase = 'idle'
          break
        case 'cancel':
          t.status = 'cancelled'
          t.phase = 'idle'
          t.finishedAt = Date.now()
          break
        case 'retry':
          t.status = 'waiting'
          t.phase = 'idle'
          t.attempts = 0
          t.polls = 0
          t.strikes = 0
          t.strikeKind = null
          t.requestId = null
          t.predicateDone = false
          t.finishedAt = null
          t.lastMessage = '已重新排队'
          t.nextAt = Date.now()
          break
        case 'remove': {
          const i = grabTasks.findIndex((x) => x.id === id)
          if (i >= 0) grabTasks.splice(i, 1)
          break
        }
        default:
          throw new Error(`未知的操作：${String(args.action)}`)
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_clear_finished': {
      const before = grabTasks.length
      for (let i = grabTasks.length - 1; i >= 0; i--) {
        const st = grabTasks[i]!.status
        if (st === 'success' || st === 'failed' || st === 'conflict' || st === 'cancelled') {
          grabTasks.splice(i, 1)
        }
      }
      grabEmit()
      return delay(before - grabTasks.length as T)
    }

    case 'campus_grab_pause_all': {
      for (const t of grabTasks) {
        if (t.status === 'waiting' || t.status === 'running') {
          t.status = 'paused'
          t.phase = 'idle'
        }
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_resume_all': {
      for (const t of grabTasks) {
        if (t.status === 'paused') {
          t.status = 'waiting'
          t.phase = 'idle'
          t.nextAt = Date.now()
        }
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_settings_get':
      return delay({ ...grabSettings } as T)

    case 'campus_grab_settings_set': {
      const incoming = plain(args.settings as GrabSettings)
      grabSettings = {
        minIntervalMs: Math.min(10000, Math.max(10, Number(incoming.minIntervalMs) || 700)),
        pollIntervalMs: Math.min(30000, Math.max(50, Number(incoming.pollIntervalMs) || 2000)),
        fullRetryMs: Math.min(120000, Math.max(100, Number(incoming.fullRetryMs) || 5000)),
        backoffMs: Math.min(60000, Math.max(50, Number(incoming.backoffMs) || 1500)),
        maxBackoffMs: Math.min(300000, Math.max(1000, Number(incoming.maxBackoffMs) || 30000)),
        // 0 是有意义的值（贴着开窗出手），所以不能写成 `|| 800`；坏值/缺省才回落 800
        leadMs: Math.min(5000, Math.max(0, Number.isFinite(incoming.leadMs) ? incoming.leadMs : 800)),
        maxAttempts: Math.min(100000, Math.max(0, Number(incoming.maxAttempts) || 0)),
        maxPolls: Math.min(200, Math.max(1, Number(incoming.maxPolls) || 15)),
        // 0 是有意义的值（死守），不能用 `|| 0` 兜底写法把它换掉
        cedeAfterMs: Math.min(3600000, Math.max(0, Number(incoming.cedeAfterMs) || 0)),
        watchWindow: incoming.watchWindow !== false,
      }
      return delay({ ...grabSettings } as T)
    }

    case 'campus_program':
      return delay({
        programInfos: [
          {
            id: 5881,
            nameZh: '2026级智能科学与技术专业培养方案(主修)',
            grade: '2026',
            department: { nameZh: '计算机与信息安全学院' },
            major: { nameZh: '智能科学与技术' },
            education: { nameZh: '本科' },
            cultivateType: { nameZh: '主修' },
            printedTime: `打印日期：${ymd(new Date())}`,
            creditDistrTable: {
              type: null,
              courseStatistics: [],
              children: [
                { type: { nameZh: '通识必修课程' }, courseStatistics: [], children: [
                  { type: { nameZh: '思想政治理论课程' }, courseStatistics: [{ courseProperty: { nameZh: '必修' }, sumCredit: 20, sumPeriod: 352 }] },
                  { type: { nameZh: '大学英语课程' }, courseStatistics: [{ courseProperty: { nameZh: '必修' }, sumCredit: 12, sumPeriod: 192 }] },
                ] },
                { type: { nameZh: '专业必修课程' }, courseStatistics: [], children: [
                  { type: { nameZh: '专业核心课程' }, courseStatistics: [{ courseProperty: { nameZh: '必修' }, sumCredit: 46, sumPeriod: 736 }] },
                ] },
                { type: { nameZh: '通识选修课程' }, courseStatistics: [{ courseProperty: { nameZh: '选修' }, sumCredit: 10, sumPeriod: 160 }] },
              ],
              sumCredit: 162,
              sumPeriod: 2600,
            },
            courseList: campusDemoCourses().map((c) => ({
              id: c.remoteLessonId,
              nameZh: c.courseName,
              code: c.courseCode,
            })),
          },
        ],
      } as T)

    /* ---------- 在线更新 ---------- */
    case 'update_status':
      return delay(updateSnapshot() as T)

    case 'update_settings_set': {
      const patch = plain(args.patch as UpdateSettingsPatch)
      updateSettings = {
        ...updateSettings,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.channel === undefined ? {} : { channel: patch.channel.trim().toLowerCase() || 'stable' }),
        ...(patch.autoCheck === undefined ? {} : { autoCheck: patch.autoCheck }),
        ...(patch.checkIntervalHours === undefined
          ? {}
          : { checkIntervalHours: Math.min(720, Math.max(1, Number(patch.checkIntervalHours) || 12)) }),
        ...(patch.allowHttp === undefined ? {} : { allowHttp: patch.allowHttp }),
        ...(patch.silentInstall === undefined ? {} : { silentInstall: patch.silentInstall }),
        ...(patch.ignoredVersion === undefined
          ? {}
          : { ignoredVersion: patch.ignoredVersion.trim() ? patch.ignoredVersion : null }),
        ...(patch.sources === undefined ? {} : { sources: patch.sources }),
      }
      // 与 Rust 侧同一条规则：跳过/防降级这些派生判断取决于**设置**，
      // 所以设置一变就要拿新设置把上次的检查结果重算一遍（否则「点了跳过卡片还在」）
      if (updateCheck) {
        updateCheck = {
          ...updateCheck,
          ignored: updateSettings.ignoredVersion === updateCheck.latestVersion,
        }
      }
      return delay(updateSnapshot() as T)
    }

    case 'update_check': {
      const none = mockFlag('__REIN_MOCK_UPDATE_NONE__')
      const version = none ? MOCK_CURRENT_VERSION : MOCK_LATEST_VERSION
      const enabledSources = updateSettings.sources.filter((s) => s.enabled)
      const reports: SourceReport[] = enabledSources.map((s, i) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        url: s.url,
        ok: true,
        version,
        // 内置的两个源都发清单签名（与真实发布链路一致）
        manifestSigned: true,
        error: null,
        elapsedMs: 120 + i * 80,
      }))
      // 被关掉的源照样出现在报告里：界面要能解释「为什么这个源没结果」
      for (const s of updateSettings.sources.filter((x) => !x.enabled)) {
        reports.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          url: s.url,
          ok: false,
          version: null,
          manifestSigned: false,
          error: '已在设置里关闭',
          elapsedMs: 0,
        })
      }
      const checkedAt = new Date().toISOString()
      updateSettings = { ...updateSettings, lastCheckAt: checkedAt }
      updateCheck = {
        checkedAt,
        currentVersion: MOCK_CURRENT_VERSION,
        platform: 'windows-x86_64',
        available: !none,
        latestVersion: version,
        // 形状与线上一致：发布侧裁出的**这一版那一节**，行首是 `- ` 而不是 `·`，
        // 说明是 Markdown（更新页与启动提示都走 MdText 渲染）。
        // 这里保持与 scripts/release/notes.mjs 归一后的形态相同 ——
        // 夹具与真实清单形状不一致时，界面上的渲染问题在 mock 里根本复现不出来。
        notes: none
          ? null
          : [
              `## v${version}`,
              '- 更新链路支持多源（自建服务 + GitHub）与断点续传',
              '- 安装包在下载与安装前各做一次 **Ed25519** 验签',
              '- 新增 Rein 在线服务能力探测（模型网关为预留接口）',
            ].join('\n'),
        publishedAt: new Date(Date.now() - 3600_000).toISOString(),
        sizeBytes: 42 * 1024 * 1024,
        sourceId: enabledSources[0]?.id ?? null,
        sourceName: enabledSources[0]?.name ?? null,
        sources: reports,
        mandatory: false,
        installSupported: true,
        installHint: '下载完成后会静默运行安装器并重启应用',
        ignored: updateSettings.ignoredVersion === version,
        downgradeBlocked: false,
      }
      return delay(updateCheck as T)
    }

    case 'update_download':
      if (updateDownload.verified) return delay(updateDownload as T)
      if (!updateCheck?.available) throw new Error('请先检查更新')
      startMockDownload()
      return delay(updateDownload as T)

    case 'update_cancel':
      stopUpdateTimer()
      updateDownload = { ...updateDownload, phase: 'cancelled', error: '已取消下载' }
      return delay(true as T)

    case 'update_discard':
      stopUpdateTimer()
      updateDownload = idleDownload()
      return delay(undefined as T)

    case 'update_install':
      updateDownload = { ...updateDownload, phase: 'installing' }
      return delay({
        ok: true,
        message: '（浏览器演示）真机上这里会交给系统安装器并重启应用',
        willExit: false,
      } as T)

    case 'update_progress':
      return delay(updateDownload as T)

    case 'update_prune_cache':
      return delay(0 as T)

    // 数据维护（清除软件数据）：mock 只负责把三步流程走通（选档 → 清单 → 长按），
    // 数字是演示范本，不对应任何真实库
    case 'data_clear_preview': {
      const scope = String(args.scope)
      const items = (
        scope === 'cache'
          ? [
              { key: 'cache-0', label: '更新安装包缓存', count: null, bytes: 0 },
              { key: 'cache-1', label: '嵌入模型文件（需要时重新下载）', count: null, bytes: 92_630_976 },
            ]
          : scope === 'ai'
            ? [
                { key: 'ai-0', label: 'AI 聊天会话', count: 4, bytes: null },
                { key: 'ai-1', label: 'AI 长期记忆', count: 17, bytes: null },
                { key: 'ai-2', label: 'AI 用量统计', count: 66, bytes: null },
                { key: 'ai-3', label: '语音纪要与录音', count: 3, bytes: 1_877_095 },
              ]
            : scope === 'business'
              ? [
                  { key: 'business-0', label: '饮食记录与食物库', count: 128, bytes: null },
                  { key: 'business-1', label: '训练记录与逐组数据', count: 42, bytes: null },
                  { key: 'business-2', label: '训练课程（内置课重启后自动补回）', count: 8, bytes: null },
                  { key: 'business-3', label: '动作库（内置动作重启后自动补回）', count: 56, bytes: null },
                  { key: 'business-4', label: '待办', count: 23, bytes: null },
                  { key: 'business-5', label: '记账流水与预算', count: 210, bytes: null },
                  { key: 'business-6', label: '身体指标与目标参数', count: 19, bytes: null },
                  { key: 'business-7', label: '第三方健康数据镜像', count: 0, bytes: null },
                  { key: 'business-8', label: '健康方案、菜单与采购勾选', count: 2, bytes: null },
                  { key: 'business-9', label: '番茄钟记录', count: 31, bytes: null },
                  { key: 'business-10', label: '校园课表、抢课任务与选课记录', count: 0, bytes: null },
                ]
              : [
                  { key: 'factory-0', label: '全部业务数据（同「业务与健康数据」档）', count: 559, bytes: null },
                  { key: 'factory-1', label: 'AI 聊天、长期记忆与语音纪要（含录音）', count: 90, bytes: 1_877_095 },
                  { key: 'factory-2', label: 'AI 配置：模型、提供商与密钥', count: 3, bytes: null },
                  { key: 'factory-3', label: 'AI 工作区文件与知识库索引', count: 12, bytes: 33_554_432 },
                  { key: 'factory-4', label: '多设备同步：配对、设备身份与对账数据', count: 0, bytes: null },
                  { key: 'factory-5', label: '应用设置与凭据（语音凭据、更新设置等）', count: 9, bytes: null },
                  { key: 'factory-6', label: '更新安装包与嵌入模型缓存', count: null, bytes: 92_630_976 },
                  { key: 'factory-7', label: '教务救援导出脚本', count: null, bytes: 0 },
                ]
      )
      return delay({
        scope,
        items,
        totalBytes: items.reduce((sum, it) => sum + (it.bytes ?? 0), 0),
        restartsApp: scope !== 'cache',
      } as T)
    }

    case 'data_clear': {
      const scope = String(args.scope)
      return delay({
        scope,
        freedBytes: scope === 'cache' ? 92_630_976 : scope === 'factory' ? 128_062_503 : 1_877_095,
        removedTables: scope === 'cache' ? [] : ['（mock）已按清单清空对应表'],
        removedDirs: scope === 'cache' ? ['updates', 'models'] : scope === 'factory' ? ['（mock）数据目录已清'] : ['voice_sessions'],
        failures: [],
      } as T)
    }

    case 'data_app_restart':
      // 浏览器演示里没有进程可重启；真机走到这里会退出并重新拉起
      return delay(undefined as T)

    case 'online_service_status': {
      const offline = mockFlag('__REIN_MOCK_SERVICE_OFFLINE__')
      const base = (args.baseUrl as string | null) ?? updateSettings.sources[0]?.url.replace(/\/updates\/.*$/, '') ?? ''
      return delay({
        baseUrl: base,
        reachable: !offline,
        service: offline ? null : 'rein-online-service',
        version: offline ? null : '1.0.0',
        currentRelease: offline ? null : MOCK_LATEST_VERSION,
        channels: offline ? [] : [{ channel: 'stable', current: MOCK_LATEST_VERSION }],
        manifestUrl: offline ? null : `${base}/updates/latest.json`,
        ai: offline
          ? null
          : {
              status: 'not_configured',
              enabled: true,
              requireToken: true,
              clientCount: 0,
              providers: [
                { id: 'ark', name: '火山方舟', enabled: false, models: ['doubao-seed-1-6-250615'] },
                { id: 'deepseek', name: 'DeepSeek', enabled: false, models: ['deepseek-chat'] },
              ],
              modelsEndpoint: `${base}/v1/models`,
              chatEndpoint: `${base}/v1/chat/completions`,
            },
        error: offline ? '无法连接 /health：连接被拒绝（mock）' : null,
        checkedAt: new Date().toISOString(),
        elapsedMs: offline ? 3000 : 84,
      } as T)
    }

    /* ---- 外部访问（对外服务网关）：9 条管理命令，与 modules/gateway/commands.rs 同名 ---- */

    case 'gateway_status':
      return delay(gwStatus() as T)

    case 'gateway_set_enabled': {
      const on = !!args.enabled
      gwState.enabled = on
      // 真机开启时按设置绑定、把**实际**端口写回；mock 固定 17650（真机被占会顺延、全占退系统分配）
      gwState.port = on ? 17650 : null
      // 真机开启时 `store::ensure_pair_token` 一定把令牌生成出来（设置页要显示它）；
      // 这里同口径补一把（真机是 base64url(32 随机字节)，mock 用固定串好让 e2e 断言），
      // 否则「配对令牌」那张卡在 mock 里永远不出现。
      if (on && !gwState.pairToken) gwState.pairToken = 'mZq3f1yR8k0TvP2sL5nQ7xW4bJ6dH9cA1eG3iK5oM7U'
      // 关闭 = 断链，本次会话授权随之消亡（contract §5.1）；「始终允许」的行留下
      if (!on) gwState.clients = gwState.clients.filter((c) => c.grant === 'always')
      gwChanged()
      return delay(gwStatus() as T)
    }

    case 'gateway_set_bind': {
      gwState.bindMode = args.bindMode === 'lan' ? 'lan' : 'local'
      const want = args.port === null || args.port === undefined ? null : Number(args.port)
      gwState.port = gwState.enabled ? (want ?? 17650) : null
      gwChanged()
      return delay(gwStatus() as T)
    }

    /* 模块开关快照（真机：`store::set_enabled_modules` → `app_meta:gateway.enabledModules`）。
       真机那边它决定 28 条对外方法里哪些回 module_disabled；mock 没有 WS 监听，
       这里只把快照存下来供 e2e 断言「前端推了、推的是谁」，清洗规则与 Rust 逐条对齐。 */
    case 'gateway_set_enabled_modules': {
      const ids = normalizeModules(args.ids)
      if (ids.length > 64) throw new Error('模块条数超限（上限 64 条）')
      if (ids.some((id) => id.length > 64)) throw new Error('模块 id 过长（上限 64 字符）')
      gwEnabledModules = ids
      return delay(ids as T)
    }

    case 'gateway_authorization_pending':
      return delay(gwPending.map((r) => ({ ...r })) as T)

    case 'gateway_authorization_respond': {
      const req = gwPending.find((r) => r.requestId === String(args.requestId))
      if (!req) throw new Error('该授权请求不存在或已被处理')
      const decision = String(args.decision)
      const scopes = (Array.isArray(args.scopes) ? args.scopes : []).map(String)
      const at = gwPending.indexOf(req)
      // 「忽略」不落决策、连接继续挂起（30s 限频）—— 请求留在队列里
      if (decision !== 'ignore' && at !== -1) gwPending.splice(at, 1)
      if (decision === 'allow-session' || decision === 'allow-always') {
        const granted: GatewayClient = {
          clientId: req.clientId,
          name: req.clientName,
          grant: decision === 'allow-always' ? 'always' : 'session',
          scopes,
          lastSeen: decision === 'allow-always' ? new Date().toISOString() : null,
          online: true,
          ip: null,
        }
        gwState.clients = [...gwState.clients.filter((c) => c.clientId !== req.clientId), granted]
        // 真机每次裁决都往 ext_audit 落一行；mock 照落，好让「最近访问记录」有内容可看。
        gwAuditPush({
          clientId: req.clientId,
          method: '',
          scope: scopes.join(','),
          decision: 'allowed',
          detail: `授权：${decision}`,
          ip: req.ip,
          durationMs: 0,
        })
        gwChanged()
      }
      // 「拒绝」在真机上会记 deny 行并以 1008 关连；deny 行不进已授权列表（build_status 会跳过）
      if (decision === 'deny') {
        gwAuditPush({
          clientId: req.clientId,
          method: '',
          scope: '',
          decision: 'denied',
          detail: '用户拒绝授权',
          ip: req.ip,
          durationMs: 0,
        })
        gwChanged()
      }
      return delay({} as T)
    }

    case 'gateway_revoke_client': {
      const id = String(args.clientId)
      gwState.clients = gwState.clients.filter((c) => c.clientId !== id)
      // 拒绝 / 已撤销 / 静默：解除 = 从「被拦下」清单移除（回到无记录）。
      gwState.blocked = gwState.blocked.filter((b) => b.clientId !== id)
      gwChanged()
      return delay(gwStatus() as T)
    }

    case 'gateway_set_allowed_origins': {
      // 整表替换（与 Rust store::set_allowed_origins 同语义）：去空白、去重、保序。
      const raw = Array.isArray(args.origins) ? args.origins : []
      gwAllowedOrigins = [...new Set(raw.map((o) => String(o).trim()).filter((o) => o !== ''))]
      gwChanged()
      return delay(gwStatus() as T)
    }

    case 'gateway_audit_recent': {
      // 真机从 ext_audit 读（limit 夹到 [1,500]，缺省 50）；mock 从内存流水里同口径取。
      const want = Number(args.limit)
      const limit = Number.isFinite(want) ? Math.max(1, Math.min(500, Math.trunc(want))) : 50
      const clientId = args.clientId === null || args.clientId === undefined ? null : String(args.clientId)
      const rows = gwAudit.filter((r) => clientId === null || clientId === '' || r.clientId === clientId)
      return delay(rows.slice(0, limit).map((r) => ({ ...r })) as T)
    }

    /* ---- 运行态上报（前端 → 后端，contract §14.1）---- */

    case 'focus_publish': {
      // 真机写 app_meta:runtime.focus.v1（原样 JSON）；mock 只留在内存里，供 e2e 读回。
      gwFocusRuntime = args.snapshot ? ({ ...(args.snapshot as FocusRuntime) }) : null
      return delay({} as T)
    }

    case 'focus_unpublish':
      gwFocusRuntime = null
      return delay({} as T)

    default:
      throw new Error(`mock 未实现的命令: ${cmd}`)
  }
}

// 供测试 / 开发检查使用
export const __weekStart = weekStart
