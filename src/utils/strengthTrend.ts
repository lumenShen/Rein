/**
 * 14 日力量趋势 · 纯函数（无 IPC、不改 store）。
 *
 * 回答一个问题：「最近两周，这个动作是在往上走还是走平？」
 *
 * 口径：
 *  - 样本 = 近 14 个日历天（含今天）里每次训练的**最好 e1RM**，一次训练一个点，
 *    不是逐组。逐组会把「同一重量做 4 组」算成 4 个点，斜率被组数拖着走 —— 组数多
 *    不代表变强了。
 *  - 拟合 = 加权最小二乘直线，权重按「离今天的天数」线性衰减（今天 1.0 → 第 14 天 0.5）。
 *    越近的训练越能代表当下的水平，但两周内的老点也不能直接丢掉，否则 3 个点的
 *    样本会被最近一次主导成一条水平线。
 *  - 预测 = 把这条直线外推到**今天**（不是外推到未来某天）。外推到未来要假设训练
 *    节奏不变，那个假设在数据里没有依据；而「按当前趋势，今天大概能涨到多少」
 *    是可检验的说法。
 *  - 外推幅度钳制在样本区间外 ±8%：只有两点、且相隔一天的样本，斜率能被单次
 *    状态波动放大成每周 +10kg，那种数字放进界面就是误导。
 *
 * 置信度只用于界面上的措辞（「样本还少」/「趋势明确」），不参与任何重量计算 ——
 * 建议重量仍由 `trainingAdvice` 的基线 × 今日极限决定，趋势只是它的一个因子。
 */

import { diffDays as daysBetween } from './date'

/** 趋势窗口（天，含今天） */
export const TREND_WINDOW_DAYS = 14

/** 一次训练的 e1RM 点 */
export interface TrendSample {
  /** 本地 YYYY-MM-DD */
  date: string
  /** 该次训练的最大估算极限（kg） */
  e1rm: number
}

export interface StrengthTrend {
  /** 窗口天数（常量回显，界面写「近 14 天」时用它而不是再抄一个 14） */
  days: number
  /** 窗口内有效训练次数 */
  samples: number
  /** 首次样本到今天的跨度（天）；1 个样本时为 0 */
  spanDays: number
  /** 每周 e1RM 变化（kg/周）：正 = 在涨 */
  slopePerWeek: number
  /** 趋势线在今天的值（kg）；样本不足时为最近一次的值 */
  projected: number | null
  /** 窗口内最近一次的 e1RM */
  latest: number | null
  /** 窗口内最高一次的 e1RM */
  peak: number | null
  /** 窗口内的样本点（日期升序，已按同去重），迷你趋势线直接吃它 */
  points: TrendSample[]
  direction: 'up' | 'flat' | 'down'
  /** 0..1：样本数与时间跨度共同决定，只影响措辞 */
  confidence: number
}

/** 方向判定阈值：两周折算下来周变化不到 0.5% 就是「走平」 */
const FLAT_RATIO = 0.005

/** 外推钳制：不超过样本区间外 8% */
const EXTRAPOLATE_CAP = 0.08

/**
 * @param samples 该动作的历史 e1RM 点（可含窗口外的，函数自己过滤）
 * @param today   本地今天（YYYY-MM-DD）
 */
export function computeStrengthTrend(samples: TrendSample[], today: string): StrengthTrend | null {
  const pts = samples
    .filter((s) => s.e1rm > 0 && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    .filter((s) => {
      const age = daysBetween(s.date, today)
      return age >= 0 && age < TREND_WINDOW_DAYS
    })
    // 同日多个点（一天两练）取最好的一次
    .reduce<TrendSample[]>((acc, s) => {
      const hit = acc.find((x) => x.date === s.date)
      if (hit) hit.e1rm = Math.max(hit.e1rm, s.e1rm)
      else acc.push({ ...s })
      return acc
    }, [])
    .sort((a, b) => a.date.localeCompare(b.date))

  if (!pts.length) return null

  const latest = pts[pts.length - 1].e1rm
  const peak = Math.max(...pts.map((p) => p.e1rm))
  const spanDays = Math.max(0, daysBetween(pts[0].date, pts[pts.length - 1].date))

  // 单点：没有斜率可谈，走平、低置信度。仍返回对象（界面要显示「最近一次」）
  if (pts.length === 1) {
    return {
      days: TREND_WINDOW_DAYS,
      samples: 1,
      spanDays: 0,
      slopePerWeek: 0,
      projected: latest,
      latest,
      peak,
      points: pts,
      direction: 'flat',
      confidence: 0.2,
    }
  }

  // 加权最小二乘：x = 距首点的天数，w = 1 - 0.5 × (x / span)
  const base = pts[0].date
  const xs = pts.map((p) => daysBetween(base, p.date))
  const ys = pts.map((p) => p.e1rm)
  const spanX = Math.max(1, xs[xs.length - 1])
  const ws = xs.map((x) => 1 - 0.5 * (x / spanX))

  const sw = ws.reduce((a, b) => a + b, 0)
  const mx = xs.reduce((a, x, i) => a + ws[i] * x, 0) / sw
  const my = ys.reduce((a, y, i) => a + ws[i] * y, 0) / sw
  const num = xs.reduce((a, x, i) => a + ws[i] * (x - mx) * (ys[i] - my), 0)
  const den = xs.reduce((a, x, i) => a + ws[i] * (x - mx) ** 2, 0)
  const slopePerDay = den > 0 ? num / den : 0

  const todayX = daysBetween(base, today)
  const raw = my + slopePerDay * (todayX - mx)

  // 外推钳制：只能在样本区间外扩 8%
  const lo = Math.min(...ys) * (1 - EXTRAPOLATE_CAP)
  const hi = Math.max(...ys) * (1 + EXTRAPOLATE_CAP)
  const projected = Math.round(Math.min(Math.max(raw, lo), hi) * 10) / 10

  const slopePerWeek = slopePerDay * 7
  const flatBand = Math.max(0.2, my * FLAT_RATIO)
  const direction: StrengthTrend['direction'] =
    Math.abs(slopePerWeek) < flatBand ? 'flat' : slopePerWeek > 0 ? 'up' : 'down'

  // 置信度：样本数给主档，时间跨度打折（两天里练三次，撑不起一条趋势线）
  const byCount = pts.length >= 5 ? 0.9 : pts.length === 4 ? 0.78 : pts.length === 3 ? 0.62 : 0.45
  const confidence = Math.round(byCount * Math.min(1, 0.55 + spanDays / 12) * 100) / 100

  return {
    days: TREND_WINDOW_DAYS,
    samples: pts.length,
    spanDays,
    slopePerWeek: Math.round(slopePerWeek * 10) / 10,
    projected,
    latest,
    peak,
    points: pts,
    direction,
    confidence,
  }
}
