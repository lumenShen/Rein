/**
 * 训练建议引擎（纯数据 + 纯函数，无 IPC、不落库）。
 *
 * 回答两个问题：
 *  1. 今天这个动作练多重、多少组多少次（`perExercise`）——由「平均状态」与「今日极限状态」共同决定；
 *  2. 这周各肌群的容量够不够（`muscleLoad`）——按每肌群周组数地标判定。
 *
 * 科学依据分两类写：**有出处**的（下面「有出处」一节）与**产品启发式**的（无文献出处、
 * 数值可调）。从前两类混在一起写，下一个改代码的人会把那些系数也当成文献值。
 *
 * 有出处：
 *  - 1RM 估算：Epley `w×(1+r/30)`；次数 > 12 时换 Brzycki `w×36/(37−r)`。
 *    Epley 1985；Brzycki 1993。两式在 r=10 处交叉（同为 1.333×）：r<10 时 Epley 略高，
 *    r>10 时 Brzycki 更高 —— 所以「>12 换 Brzycki」的效果是**抬高**高次数的估值，
 *    而不是压低。这一取向与 Brzycki 的出身一致：它是经典 rep-max 百分比表
 *    （20 次 ≈ 50% 1RM）的反函数，r=1 时精确给出 1.000×，13–20 次区间比 Epley
 *    更贴近该表；代价是 r 逼近 37 时发散，故有 MAX_E1RM_REPS 上限。
 *  - RIR ↔ %1RM：RIR 0=100% / 1=97.5% / 2=95% / 3=92.5% / 4=90% / 5=87.5%（Zourdos 等 2016 RPE 表）。
 *    增肌训练的目标强度取 RIR 1–3。
 *  - 容量地标：每肌群每周组数的 MEV（最小有效容量）/ MAV（最佳适应区间）/ MRV（可恢复上限），
 *    Israetel 等《Scientific Principles of Hypertrophy Training》；剂量-反应证据见 Schoenfeld 等 2017。
 *  - 恢复窗口：同一肌群力量恢复约需 48–72 小时，故 48h 内重复训练降载、72h 后视为恢复完全（Damas 等 2016）。
 *  - 渐进超负荷：双重渐进（先做满次数再加重量），上肢 +2.5kg / 下肢 更大幅度，取整到器材步进；
 *    低状态日允许回退到上次的 85% 保底（ACSM 渐进原则 + 自体调节 autoregulation）。
 *
 * 产品启发式（无文献出处；数值是我们定的，可直接调，不要当成科学结论引用）：
 *  - 今日状态四因子的**档位差与钳制范围**：恢复 ×0.90 / ×0.95 / ×1.00 / ×1.02、容量 ×0.92 / ×0.97、
 *    趋势 ×0.97、自评 ×0.85…×1.04，总钳制 0.85–1.06。「48–72h 恢复窗口」有出处，
 *    但「窗口外给 +2%」这类**档位差**没有 —— 有出处的是窗口，不是系数。
 *  - 自评 1..5 → 因子 0.85..1.04 的线性映射（自评这个做法有出处，映射斜率没有）。
 *  - 次数上限 MAX_E1RM_REPS = 20：Brzycki 在 r→37 才发散，具体卡在哪一档是我们定的。
 *  - 默认目标 RIR 2（= 95% 1RM）：RIR↔%1RM 对照表有出处，「默认取 RIR 2」是产品取向。
 *
 * 间接刺激计半组以上的折算：动作肌群激活档位 3=主攻（1 组）/2=辅助（0.5 组）/1=稳定（0.25 组）。
 * 日期只有「天」粒度（工作簿存 YYYY-MM-DD），恢复小时数按整天 × 24 近似 —— 对小重量多次数的
 * 日常训练足够，不引入额外的时间戳存储。
 */

import { MUSCLE_LABELS, resolveActivation, type Level, type MuscleKey } from '@/config/muscles'
import type { ExerciseRecord, PlanExercise, StrengthSetRecord } from '@/types'
import { computeStrengthTrend, type StrengthTrend } from './strengthTrend'

/* ---------------- 科学依据数据表 ---------------- */

/** 每肌群每周组数地标（MEV / MAV / MRV），针对力量训练的中等强度容量。
 *  细化到肌束后，同一大肌群各束地标之和与整块肌群的地标相当。 */
export const MUSCLE_VOLUME_TARGETS: Record<MuscleKey, { mev: number; mav: number; mrv: number }> = {
  'chest-up': { mev: 4, mav: 9, mrv: 14 },
  'chest-low': { mev: 4, mav: 9, mrv: 14 },
  lats: { mev: 8, mav: 16, mrv: 22 },
  'traps-up': { mev: 2, mav: 8, mrv: 14 },
  'traps-mid': { mev: 4, mav: 10, mrv: 16 },
  'traps-low': { mev: 2, mav: 8, mrv: 14 },
  'delt-ant': { mev: 4, mav: 10, mrv: 16 },
  'delt-lat': { mev: 4, mav: 12, mrv: 18 },
  'delt-post': { mev: 4, mav: 10, mrv: 16 },
  'lower-back': { mev: 4, mav: 10, mrv: 16 },
  'glute-max': { mev: 4, mav: 12, mrv: 20 },
  'glute-med': { mev: 2, mav: 8, mrv: 14 },
  biceps: { mev: 6, mav: 14, mrv: 20 },
  triceps: { mev: 6, mav: 14, mrv: 20 },
  forearm: { mev: 2, mav: 8, mrv: 14 },
  'quads-lat': { mev: 4, mav: 10, mrv: 16 },
  'quads-rec': { mev: 4, mav: 10, mrv: 16 },
  'quads-med': { mev: 2, mav: 8, mrv: 14 },
  adductors: { mev: 2, mav: 8, mrv: 14 },
  hamstrings: { mev: 6, mav: 14, mrv: 20 },
  calves: { mev: 6, mav: 14, mrv: 20 },
  soleus: { mev: 4, mav: 10, mrv: 16 },
  tibialis: { mev: 2, mav: 8, mrv: 14 },
  abs: { mev: 4, mav: 12, mrv: 20 },
  obliques: { mev: 2, mav: 8, mrv: 14 },
  scm: { mev: 2, mav: 6, mrv: 10 },
  'teres-major': { mev: 2, mav: 8, mrv: 14 },
  rhomboids: { mev: 2, mav: 8, mrv: 14 },
  'rotator-cuff': { mev: 2, mav: 6, mrv: 12 },
  'serratus-ant': { mev: 1, mav: 4, mrv: 8 },
  iliopsoas: { mev: 1, mav: 4, mrv: 8 },
  'glute-min': { mev: 1, mav: 4, mrv: 10 },
  'vastus-intermedius': { mev: 2, mav: 8, mrv: 14 },
  'levator-scapulae': { mev: 1, mav: 4, mrv: 8 },
  'tibialis-post': { mev: 1, mav: 4, mrv: 8 },
  fibularis: { mev: 1, mav: 4, mrv: 8 },
  plantaris: { mev: 0, mav: 2, mrv: 6 },
  popliteus: { mev: 0, mav: 2, mrv: 6 },
  'quadratus-femoris': { mev: 0, mav: 2, mrv: 6 },
}

/** 肌群激活档位 → 计组权重（辅助/稳定肌群的间接刺激按比例折算） */
export const ACTIVATION_WEIGHT: Record<Level, number> = { 1: 0.25, 2: 0.5, 3: 1 }

/** 增肌目标强度：留 2 次余量（RIR 2 ≈ RPE 8，对应约 95% 的当日极限） */
export const DEFAULT_TARGET_RIR = 2

/**
 * 自评 1..5 → readiness 系数。导出是给「今日状态」对话框用的 ——
 * 那里要把"这一步会影响训练计算"落到实处（本次建议重量的系数、练够分的体感分），
 * 用户看到的数字必须与引擎真实使用的一致，不能在对话框里另写一份。
 */
export const READINESS_FACTOR: Record<number, number> = { 1: 0.9, 2: 0.95, 3: 1.0, 4: 1.02, 5: 1.04 }

/* ---------------- 基础工具 ---------------- */

/**
 * 可估算 1RM 的次数上限。Brzycki 的系数 `36/(37−r)` 在 r 逼近 37 时发散：
 * r=25 → 3.0 倍工作重量、r=30 → 5.1 倍、r=36 → 36 倍、r=37 → 除零得 Infinity、r>37 → 负数。
 * 20 是这条曲线还站得住的最后一格：r=20 给 2.12×，与经典 rep-max 表（20 次 ≈ 50% → 2.0×）
 * 相差约 6%；再往上误差超线性放大，而 20 次以上的组已属肌耐力范畴，反推出来的
 * 「极限」不再描述力量水平。留着它只会让一个 36 倍工作重量的假数字流进重量曲线、
 * PR 判定与下次建议的基线。因此超出上限一律返回 0 =「不可估」，由调用方按
 * 「没有估算值」处理（各调用点本就只认 > 0 的有效估算）。
 */
export const MAX_E1RM_REPS = 20

/** 估算 1RM：次数 ≤12 用 Epley，13–MAX_E1RM_REPS 用 Brzycki；次数 ≤0 或 > 上限视为不可估 */
export function estimateOneRepMax(weightKg: number, reps: number): number {
  if (!Number.isFinite(weightKg) || !Number.isFinite(reps) || weightKg <= 0 || reps <= 0) return 0
  if (reps > MAX_E1RM_REPS) return 0
  if (reps > 12) return (weightKg * 36) / (37 - reps)
  return weightKg * (1 + reps / 30)
}

/**
 * `estimateOneRepMax` 的反函数：给定估算极限与目标次数，回推工作重量。
 *
 * 这一支必须存在，否则「估算」与「封顶」会变成两套口径：封顶从前写死 Epley
 * `ceiling / (1 + r/30)`，而 13 次以上 `estimateOneRepMax` 走的是 Brzycki ——
 * r>10 时 Brzycki 更高，它的反函数就更低，15 次目标的封顶因此比一致口径高约 9%。
 * 同一个 e1rm 在「估算」与「封顶」里必须是同一个数。
 */
export function weightForReps(e1rm: number, reps: number): number {
  if (!Number.isFinite(e1rm) || !Number.isFinite(reps) || e1rm <= 0 || reps <= 0) return 0
  if (reps > MAX_E1RM_REPS) return 0
  if (reps > 12) return (e1rm * (37 - reps)) / 36
  return e1rm / (1 + reps / 30)
}

/** 按器材步进取整（向下取整到步进，避免建议重量超出今日能力）；step ≤ 0 = 不取整 */
export function roundToStep(kg: number, step: number): number {
  if (!Number.isFinite(kg)) return kg
  if (!(step > 0)) return Math.round(kg * 10) / 10
  return Math.round(Math.floor(kg / step + 1e-6) * step * 10) / 10
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** 日期差（YYYY-MM-DD，本地日历天）：b - a */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  if (!ay || !by) return 0
  const ta = Date.UTC(ay, am - 1, ad)
  const tb = Date.UTC(by, bm - 1, bd)
  return Math.round((tb - ta) / 86_400_000)
}

/* ---------------- 输入 ---------------- */

export interface TrainingAdviceInput {
  /** 近 N 天逐组记录（`strength_recent_sets`），含热身组 */
  sets: StrengthSetRecord[]
  /** 动作库（肌群表、重量步进、默认处方） */
  library: ExerciseRecord[]
  /** 今日课程的处方（可为空：只算周容量） */
  planExercises?: PlanExercise[]
  /** 本地今天（YYYY-MM-DD） */
  today: string
  /** 今日状态自评 1..5；null/缺省 = 未自评（纯自动推断） */
  selfRating?: number | null
  /** 容量统计窗口（天），默认 7 */
  volumeDays?: number
}

/* ---------------- 输出 ---------------- */

export interface ExerciseAdvice {
  exerciseId: string
  name: string
  kind: PlanExercise['kind']
  suggestedWeight: number | null
  suggestedReps: number | null
  suggestedSets: number
  /** 目标余力（RIR）；力量动作为 2，其余为 null */
  targetRir: number | null
  weightStep: number
  /** 平均状态：近几次训练的 e1RM 加权基线 */
  baselineE1rm: number | null
  /** 今日极限状态：基线 × readiness */
  todayCeiling: number | null
  /** 该动作的今日状态系数（0.85~1.06） */
  readiness: number
  lastWeight: number | null
  lastReps: number | null
  lastDate: string | null
  /** 历史最高：单组最大重量（不限窗口），与该组的次数、日期 */
  bestWeight: number | null
  bestReps: number | null
  bestDate: string | null
  /** 历史最高估算极限 e1RM（不限窗口） */
  bestE1rm: number | null
  /** 近 14 天 e1RM 趋势；样本不足（无记录）时为 null */
  trend: StrengthTrend | null
  hasHistory: boolean
  /** 逐条中文依据（沉浸页「为什么」展开） */
  rationale: string[]
  /** 该动作自己的今日状态四因子（建议抽屉的因子条可视化用） */
  factors: ReadinessFactor[]
  /** 锚定修正一句话（做满递增/状态差降载），无修正时为空 */
  anchorNote?: string
}

export interface MuscleLoadRow {
  muscle: MuscleKey
  label: string
  /** 近 volumeDays 天的加权组数 */
  sets: number
  mev: number
  mav: number
  mrv: number
  status: 'low' | 'ok' | 'high' | 'over'
  /** 最近一次练到该肌群的日期（含间接刺激） */
  lastDate: string | null
}

export interface ReadinessFactor {
  key: 'recovery' | 'volume' | 'trend' | 'self'
  label: string
  value: number
  note: string
}

export interface TrainingAdvice {
  /** 全局今日状态（供页面展示）：score + 逐项分解 */
  readiness: { score: number; factors: ReadinessFactor[] }
  perExercise: Record<string, ExerciseAdvice>
  muscleLoad: MuscleLoadRow[]
  /** 一句话总结（页面直接用） */
  summary: string
}

/* ---------------- 内部结构 ---------------- */

interface SessionPerf {
  workoutId: number
  date: string
  /** 该次训练的最大重量正式组 */
  topWeight: number
  topReps: number
  e1rm: number
  /** 正式组列表（重量/次数） */
  working: { weightKg: number; reps: number }[]
}

interface ExerciseStat {
  id: string
  name: string
  sessions: SessionPerf[]
}

function musclesOfExercise(ex: ExerciseRecord | undefined, name: string): Partial<Record<MuscleKey, Level>> {
  if (ex && Object.keys(ex.muscles ?? {}).length) return ex.muscles
  return resolveActivation(name) ?? {}
}

/* ---------------- 主入口 ---------------- */

export function computeTrainingAdvice(input: TrainingAdviceInput): TrainingAdvice {
  const { sets, library, today } = input
  const volumeDays = input.volumeDays ?? 7
  const libById = new Map(library.map((e) => [e.id, e]))
  const nameOf = (id: string | null, fallback: string) => (id && libById.get(id)?.name) || fallback

  /* ---- 1. 按动作聚合历史（正式组） ---- */
  const stats = new Map<string, ExerciseStat>()
  for (const r of sets) {
    if (r.warmup || r.weightKg == null || r.reps == null) continue
    if (r.kind !== 'strength') continue
    const key = r.exerciseId ?? r.exerciseName
    const stat = stats.get(key) ?? { id: key, name: nameOf(r.exerciseId, r.exerciseName), sessions: [] }
    let perf = stat.sessions.find((s) => s.workoutId === r.workoutId)
    if (!perf) {
      perf = { workoutId: r.workoutId, date: r.date, topWeight: r.weightKg, topReps: r.reps, e1rm: 0, working: [] }
      stat.sessions.push(perf)
    }
    perf.working.push({ weightKg: r.weightKg, reps: r.reps })
    const oneRm = estimateOneRepMax(r.weightKg, r.reps)
    if (oneRm > perf.e1rm) {
      perf.e1rm = oneRm
      perf.topWeight = r.weightKg
      perf.topReps = r.reps
    }
    stats.set(key, stat)
  }
  for (const s of stats.values()) {
    s.sessions.sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
  }

  /* ---- 2. 每肌群近 volumeDays 天加权组数 + 上一窗口（减载侦测需要两周）+ 最近训练日期 ---- */
  const weekly = new Map<MuscleKey, number>()
  /**
   * **上一个同长度窗口**的加权组数（默认 [today−13, today−7]）。只服务减载侦测 ——
   * 「连续两周超上限」需要两周的数据，而上限本身按**单周**判（见下方 overTwoWeeks）。
   */
  const weeklyPrev = new Map<MuscleKey, number>()
  const lastTrained = new Map<MuscleKey, string>()
  const primaryLast = new Map<MuscleKey, string>()
  // 窗口是**含今天在内的 volumeDays 个日历天**（默认 7 → [today−6, today]），
  // 与练够分的 SCORE_WEEK_DAYS 同口径。写成 `-volumeDays` 会多算一天（today−7），
  // 于是同一节课在两处显示成两个「本周组数」——差一天就足以跨过 MEV/MAV 档位边界。
  const windowStart = shiftDate(today, -(volumeDays - 1))
  const prevWindowStart = shiftDate(today, -(volumeDays * 2 - 1))
  for (const r of sets) {
    if (r.warmup) continue
    if (r.weightKg == null && r.reps == null && r.sec == null) continue
    const ex = r.exerciseId ? libById.get(r.exerciseId) : undefined
    const map = musclesOfExercise(ex, r.exerciseName)
    for (const [muscle, level] of Object.entries(map) as [MuscleKey, Level][]) {
      const weight = ACTIVATION_WEIGHT[level] ?? 0.5
      if (r.date >= windowStart) weekly.set(muscle, (weekly.get(muscle) ?? 0) + weight)
      else if (r.date >= prevWindowStart) weeklyPrev.set(muscle, (weeklyPrev.get(muscle) ?? 0) + weight)
      const prev = lastTrained.get(muscle)
      if (!prev || r.date > prev) lastTrained.set(muscle, r.date)
      if (level === 3) {
        const prevPrimary = primaryLast.get(muscle)
        if (!prevPrimary || r.date > prevPrimary) primaryLast.set(muscle, r.date)
      }
    }
  }

  /* ---- 3. 目标区间 ----
   * 直接用地标原值，**不按每周可训练天数缩放**。旧版乘过一个
   * `scale = clamp(0.5 + 0.1 × 天数, 0.7, 1.0)`：练的天数越少，目标定得越低 ——
   * 方向是反的。每个肌群的**每周**容量地标描述的是刺激总量需求，不随日程松紧变化；
   * 一周只练 2 天的人，该做的是每次多练一点，而不是把标准降到 0.7 倍然后判自己「已达标」。
   * 地标本身有出处（见文件头「有出处」一节），乘出来的那个 scale 没有。 */
  const targets = (muscle: MuscleKey) => MUSCLE_VOLUME_TARGETS[muscle]

  const muscleLoad: MuscleLoadRow[] = (Object.keys(MUSCLE_VOLUME_TARGETS) as MuscleKey[])
    .map((muscle) => {
      const setsDone = Math.round((weekly.get(muscle) ?? 0) * 10) / 10
      const t = targets(muscle)
      const status: MuscleLoadRow['status'] =
        setsDone > t.mrv ? 'over' : setsDone > t.mav ? 'high' : setsDone < t.mev ? 'low' : 'ok'
      return {
        muscle,
        label: MUSCLE_LABELS[muscle],
        sets: setsDone,
        ...t,
        status,
        lastDate: lastTrained.get(muscle) ?? null,
      }
    })
    .sort((a, b) => b.sets - a.sets)

  /* ---- 4. 逐动作建议 ---- */
  const selfFactor = input.selfRating ? (READINESS_FACTOR[input.selfRating] ?? 1) : 1
  const readinessList: number[] = []
  let globalFactors: ReadinessFactor[] = []
  const perExercise: Record<string, ExerciseAdvice> = {}

  for (const item of input.planExercises ?? []) {
    const lib = libById.get(item.exerciseId)
    const key = item.exerciseId || item.name
    const stat = stats.get(key)
    const name = lib?.name ?? item.name
    const weightStep = lib?.weightStep && lib.weightStep > 0 ? lib.weightStep : 0
    const targetReps = item.reps ?? lib?.defaultReps ?? 8
    const targetSets = item.sets ?? lib?.defaultSets ?? 3
    const rationale: string[] = []

    if (item.kind !== 'strength') {
      perExercise[key] = {
        exerciseId: key,
        name,
        kind: item.kind,
        suggestedWeight: null,
        suggestedReps: null,
        suggestedSets: targetSets,
        targetRir: null,
        weightStep,
        baselineE1rm: null,
        todayCeiling: null,
        readiness: 1,
        lastWeight: null,
        lastReps: null,
        lastDate: null,
        bestWeight: null,
        bestReps: null,
        bestDate: null,
        bestE1rm: null,
        trend: null,
        hasHistory: false,
        rationale: [`${item.kind === 'timed' ? '计时' : '有氧'}动作不做重量建议`],
        factors: [],
      }
      continue
    }

    const map = musclesOfExercise(lib, name)
    const primaries = (Object.entries(map) as [MuscleKey, Level][])
      .filter(([, lv]) => lv === 3)
      .map(([m]) => m)
    const relevant = primaries.length ? primaries : (Object.keys(map) as MuscleKey[])

    // 恢复项：同主攻肌群上次训练距今的小时数（整天 × 24 近似）
    let hoursSince = Infinity
    let recoveryMuscle: MuscleKey | null = null
    for (const m of relevant) {
      const d = primaryLast.get(m) ?? lastTrained.get(m)
      if (!d) continue
      const h = Math.max(0, daysBetween(d, today)) * 24
      if (h < hoursSince) {
        hoursSince = h
        recoveryMuscle = m
      }
    }
    // 无记录 = 中性 1.0，不是扣分：`hoursSince` 保持 `Infinity` 时会落到最后一档，
    // 让「全新动作 / 从未专门练过的肌群」白拿一个 ×0.98 —— 而同一处的文案还写着
    // 「该肌群近期无训练记录」。没数据不等于没恢复，也不该把权重建议往下拉。
    const recoveryFactor =
      hoursSince === Infinity
        ? 1.0
        : hoursSince < 24
          ? 0.9
          : hoursSince < 48
            ? 0.95
            : hoursSince < 72
              ? 1.0
              : hoursSince < 120
                ? 1.02
                : 0.98
    const recoveryNote =
      hoursSince === Infinity
        ? '该肌群近期无训练记录'
        : `${recoveryMuscle ? MUSCLE_LABELS[recoveryMuscle] : '肌群'}距上次训练 ${Math.round(hoursSince)}h（${
            recoveryFactor >= 1.02 ? '超量恢复窗口' : recoveryFactor >= 1 ? '已恢复' : '尚未恢复'
          }）`

    // 容量项：主攻肌群里「最接近/超出上限」的那个
    let volumeFactor = 1
    let volumeNote = '本周容量适中'
    let worst: MuscleLoadRow | null = null
    for (const m of relevant) {
      const row = muscleLoad.find((x) => x.muscle === m)
      if (!row) continue
      if (!worst || row.sets / row.mav > worst.sets / worst.mav) worst = row
    }
    if (worst) {
      volumeFactor = worst.sets > worst.mrv ? 0.92 : worst.sets > worst.mav ? 0.97 : 1.0
      /**
       * 这句**不报目标区间**：`MUSCLE_VOLUME_TARGETS` 是 39 条肌束的地标（按主攻 1 组 /
       * 辅助 0.5 组 / 稳定 0.25 组加权求和），而用户在练够分卡上看到的那把尺是 10 个
       * 评估组的 SETS_SWEET（辅助及以上才算 1 组）。同一节课在两把尺上算出的组数不同 ——
       * 把两个「目标」并排摆给用户，他只会以为其中一个算错了。
       * 所以这里只说**事实与后果**（练了多少组、建议重量因此降了），目标口径留在内部
       * （`volumeFactor` 仍按地标算，只是不再把地标印出来）。
       */
      volumeNote = `本周${worst.label} ${worst.sets} 组${
        volumeFactor < 1 ? '，容量偏高，今日建议重量已相应下调' : ''
      }`
    }

    // 趋势项：上次 e1RM 相对基线的偏离
    const last = stat?.sessions[stat.sessions.length - 1] ?? null
    const baselineE1rm = stat ? weightedBaseline(stat.sessions) : null
    const trendFactor = last && baselineE1rm ? (last.e1rm < baselineE1rm * 0.95 ? 0.97 : 1.0) : 1.0
    const trendNote = last
      ? `上次 ${fmt(last.topWeight)}kg × ${last.topReps}（估算 1RM ${Math.round(last.e1rm)}kg）`
      : '暂无历史记录'

    /* 历史最高与 14 日趋势（建议抽屉 / 动作详情共用）。
     * 「最高」不限窗口 —— 那是个人纪录；「趋势」只看近两周 —— 那是当下走向。
     * 两者混成一个数会同时失真：半年前的一次爆种会永远把趋势线拉成下跌。 */
    let bestPerf: SessionPerf | null = null
    let bestE1rm = 0
    for (const perf of stat?.sessions ?? []) {
      if (!bestPerf || perf.topWeight > bestPerf.topWeight) bestPerf = perf
      if (perf.e1rm > bestE1rm) bestE1rm = perf.e1rm
    }
    const trend = stat
      ? computeStrengthTrend(
          stat.sessions.map((p) => ({ date: p.date, e1rm: p.e1rm })),
          today,
        )
      : null

    const readiness = clamp(recoveryFactor * volumeFactor * trendFactor * selfFactor, 0.85, 1.06)
    const todayCeiling = baselineE1rm ? baselineE1rm * readiness : null

    rationale.push(trendNote)
    rationale.push(recoveryNote)
    if (worst) rationale.push(volumeNote)
    rationale.push(
      `今日状态 ×${readiness.toFixed(2)} = 恢复 ×${recoveryFactor.toFixed(2)} · 容量 ×${volumeFactor.toFixed(
        2,
      )} · 趋势 ×${trendFactor.toFixed(2)}${input.selfRating ? ` · 自评 ${input.selfRating}/5` : ''}`,
    )

    let suggestedWeight: number | null = null
    const suggestedReps: number | null = targetReps
    let anchorNote: string | null = null
    if (!stat || !last) {
      // 无历史：按课程/库内建议值起步
      suggestedWeight = item.weightKg ?? lib?.defaultWeightKg ?? null
      rationale.push(
        suggestedWeight != null
          ? `首次记录：按建议值 ${fmt(suggestedWeight)}kg 起步，完成几组后即可给出个性化建议`
          : '首次记录：自重动作按次数推进即可',
      )
    } else if (todayCeiling) {
      /**
       * 建议重量 = 负荷锚定 + 自体调节（不直接由 e1RM 反推绝对重量）：
       * 历史记录没有 RPE，e1RM 只能当相对趋势用（把它当「这组若力竭的理论 1RM」）；
       * 用它反推重量会系统性低于用户实际做过的重量（训练本来就该留余力）。
       * 因此：以上次重量为锚，做满计划次数就加一档（双重渐进）；今日状态差则降载；
       * 今日极限只用来封顶（且不低于上次已完成过的重量）。
       */
      const allSetsDone =
        last.working.length >= Math.max(1, targetSets) && last.working.every((w) => w.reps >= targetReps)
      let base = last.topWeight
      /**
       * 本步的意图。文案一律**按实际结果生成**，不再先写死再 clamp ——
       * 从前的顺序是「先写 anchorNote，再夹到 [lo, cap]」，而 cap 的今日极限正是
       * 从这批历史反推出来的（`weightForReps` 是 `estimateOneRepMax` 的精确反函数），
       * 于是「做满递增」被自己的历史削回原值，anchorNote 却仍报 +2.5kg：
       * 用户看到 60kg 不变，解释里写着「+2.5kg」。数字与解释必须同源。
       */
      let intent: 'up' | 'down' | 'hold' = 'hold'
      let upSteps = 0
      if (allSetsDone && weightStep > 0) {
        upSteps = readiness >= 1.03 ? 2 : 1
        base += weightStep * upSteps
        intent = 'up'
      }
      if (readiness < 0.95) {
        base = last.topWeight * readiness
        intent = 'down'
      } else if (readiness < 0.98 && !allSetsDone) {
        base = last.topWeight
        intent = 'hold'
      }
      // 今日极限封顶：目标次数下的等价重量（走 weightForReps，与 estimateOneRepMax 同一口径）；
      // 但不低于上次实际完成过的重量（已证明可行）。次数超出可估上限时 weightForReps 返回 0
      // =「不可估」，此时不做抬高，cap 落回上次已完成的重量。
      let cap = Math.max(last.topWeight, weightForReps(todayCeiling, targetReps))
      // 全部做满时封顶不得低于递增后的值：用户已经用实际表现证明能做到目标次数，
      // 双重渐进就是要往上走一档。让「从历史反推的上限」把「基于历史的递增」削掉，是自相矛盾。
      if (intent === 'up') cap = Math.max(cap, base)
      const lo = Math.max(0, last.topWeight * 0.85)
      const clamped = clamp(base, lo, cap)
      suggestedWeight = weightStep > 0 ? roundToStep(clamped, weightStep) : Math.round(clamped * 10) / 10
      // 解释按**实际落定的值**写（含取整与封顶的后果），不写意图
      const delta = Math.round((suggestedWeight - last.topWeight) * 10) / 10
      if (intent === 'up') {
        anchorNote =
          delta > 0
            ? `上次全部做满 ${targetReps} 次 → 递增${upSteps === 2 ? '两档（今日状态很好）' : '一个步进'}（${delta > 0 ? '+' : ''}${fmt(delta)}kg）`
            : `上次全部做满 ${targetReps} 次，但今日极限封顶在 ${fmt(suggestedWeight)}kg —— 这次维持，不加档`
      } else if (intent === 'down') {
        anchorNote = `今日状态 ×${readiness.toFixed(2)} 明显偏低 → 主动降载到 ${fmt(suggestedWeight)}kg（下限为上次的 85%）`
      } else if (intent === 'hold') {
        anchorNote = '今日状态略低 → 维持上次重量，不做递增'
      }
      rationale.push(`建议 ${fmt(suggestedWeight)}kg × ${targetReps} × ${targetSets} 组 · 约留 1–2 次余力（按上次表现估计）`)
    }
    if (anchorNote) rationale.push(anchorNote)

    // 该动作自己的今日状态四因子（建议抽屉的因子条用；全局因子仍取首个动作）
    const exFactors: ReadinessFactor[] = [
      { key: 'recovery', label: '恢复', value: recoveryFactor, note: recoveryNote },
      { key: 'volume', label: '容量', value: volumeFactor, note: volumeNote },
      { key: 'trend', label: '趋势', value: trendFactor, note: trendNote },
      {
        key: 'self',
        label: '自评',
        value: selfFactor,
        note: input.selfRating ? `${input.selfRating}/5` : '未自评',
      },
    ]

    // 全局状态：今日课程各动作 readiness 的均值（页面抬头展示），分解取首个动作
    readinessList.push(readiness)
    if (!globalFactors.length) globalFactors = exFactors

    perExercise[key] = {
      exerciseId: key,
      name,
      kind: item.kind,
      suggestedWeight,
      suggestedReps,
      suggestedSets: targetSets,
      targetRir: DEFAULT_TARGET_RIR,
      weightStep,
      baselineE1rm,
      todayCeiling,
      readiness,
      lastWeight: last?.topWeight ?? null,
      lastReps: last?.topReps ?? null,
      lastDate: last?.date ?? null,
      bestWeight: bestPerf?.topWeight ?? null,
      bestReps: bestPerf?.topReps ?? null,
      bestDate: bestPerf?.date ?? null,
      bestE1rm: bestE1rm > 0 ? Math.round(bestE1rm * 10) / 10 : null,
      trend,
      hasHistory: !!last,
      rationale,
      factors: exFactors,
      anchorNote: anchorNote ?? undefined,
    }
  }

  const globalReadiness = readinessList.length
    ? readinessList.reduce((s, v) => s + v, 0) / readinessList.length
    : 1
  const lowCount = muscleLoad.filter((m) => m.status === 'low' && m.lastDate).length
  const overCount = muscleLoad.filter((m) => m.status === 'over').length

  /**
   * 减载侦测：**连续两个窗口**都超过可恢复上限（MRV）。
   *
   * 只看连续两周：单周超上限很常见（赶上心情好、或这周刚好排了两次同一肌群），
   * 而减载建议要的是趋势不是单次事件 —— 报得太勤等于没有建议。
   *
   * 刻意**不做 ACWR / 单调性**：那两个指标在 ≤4 练/周的场景下会退化成一个
   * 「每周练几天」的别名（2 练/周时 acute/chronic 只有 0.5 / 1.0 / 1.5 三档，
   * 「多练一次」直接跳档；1 练/周时一周里有六天 chronic 近似 0），
   * 拿它当告警依据会一路误报。这里用两周组数与上限的对照，数据是现成的。
   */
  const overTwoWeeks = muscleLoad.filter((m) => {
    const prevSets = weeklyPrev.get(m.muscle) ?? 0
    return m.sets > m.mrv && prevSets > m.mrv
  })
  const deloadNote = overTwoWeeks.length
    ? `「${overTwoWeeks
        .map((m) => m.label)
        .join('、')}」连续两周超过可恢复上限（本周 ${overTwoWeeks[0]!.sets} 组 / 上限 ${
        overTwoWeeks[0]!.mrv
      } 组），建议下周减载：组数降到约 60%，重量不动`
    : ''

  const summary = deloadNote
    ? deloadNote
    : overCount
      ? `${overCount} 个肌群本周容量偏高，建议减量或增加休息`
      : input.planExercises?.length
        ? `今日状态 ×${globalReadiness.toFixed(2)}，按建议重量训练即可${lowCount ? `；${lowCount} 个肌群容量偏低` : ''}`
        : lowCount
          ? `${lowCount} 个肌群本周容量偏低`
          : '本周各肌群容量都在合理区间'

  return {
    readiness: { score: globalReadiness, factors: globalFactors },
    perExercise,
    muscleLoad,
    summary,
  }
}

/** 近 3 次训练的 e1RM 加权基线（越近权重越高：0.2 / 0.3 / 0.5） */
function weightedBaseline(sessions: SessionPerf[]): number | null {
  const recent = sessions.slice(-3)
  if (!recent.length) return null
  const weights = recent.length === 3 ? [0.2, 0.3, 0.5] : recent.length === 2 ? [0.35, 0.65] : [1]
  let sum = 0
  let wsum = 0
  recent.forEach((s, i) => {
    const w = weights[i] ?? 0.5
    sum += s.e1rm * w
    wsum += w
  })
  return wsum > 0 ? sum / wsum : null
}

function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y!, m! - 1, d!) + deltaDays * 86_400_000
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}
