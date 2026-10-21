/**
 * 迷你趋势图几何（体重卡 / 健康指标详情共用）。
 *
 * 同一套「折线 + 渐变面积 + 末点」在两个页面各写过一遍，Y 轴留白口径却不同：
 * 一边 `max(max-min, |max|·2%, 0.8)`，一边 `max(max-min, 0.8)` —— 体重这种
 * 变化量很小的序列，在前者里被压平、在后者里被放大，同一份数据两处读起来不一样。
 * 现在统一走「量级 2% 与 0.8 取大」：小波动不会铺满整张图，也不会被当成平线。
 */
export interface TrendGeometry {
  /** SVG polyline 的 points */
  points: string
  /** 折线下方闭合区域 */
  area: string
  /** 末点（画圆点用） */
  last: { x: number; y: number }
  min: number
  max: number
}

export function trendGeometry(
  values: number[],
  opts: {
    width: number
    height: number
    padX?: number
    padY?: number
    /** 数据完全相等时的最小纵向跨度：按量级给一个下限，避免除零 */
    magnitudeFloor?: number
    /** 绝对最小跨度（兜底） */
    minSpan?: number
  },
): TrendGeometry | null {
  if (values.length < 2) return null
  const padX = opts.padX ?? 5
  const padY = opts.padY ?? 14
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(
    max - min,
    Math.abs(max) * (opts.magnitudeFloor ?? 0.02),
    opts.minSpan ?? 0.8,
  )
  const lo = min - span * 0.12
  const hi = max + span * 0.12
  const x = (i: number) => padX + (i * (opts.width - padX * 2)) / (values.length - 1)
  const y = (v: number) => padY + ((hi - v) / (hi - lo)) * (opts.height - padY * 2)

  return {
    points: values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    area: `M${x(0).toFixed(1)},${y(values[0]!).toFixed(1)} ${values
      .map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ')} L${x(values.length - 1).toFixed(1)},${opts.height} L${x(0).toFixed(1)},${opts.height} Z`,
    last: { x: x(values.length - 1), y: y(values[values.length - 1]!) },
    min,
    max,
  }
}
