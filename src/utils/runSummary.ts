/**
 * 跑步总结的派生口径（纯函数，无 store / 无 IPC）。
 *
 * 训练课总结（utils/sessionSummary）回答的是「每组练得怎么样」，
 * 跑步这一边能回答的完全不同：**配速怎么分布、爬了多少、心率如何**。
 * 原来跑步总结只有一行 `时长 · 距离 · 配速 · 大卡`，等于把一次跑步里
 * 唯一有分析价值的两个维度（分段配速与爬升）全丢了 ——
 * 而这两个恰好是「为什么这次这么快/这么慢」的唯一答案。
 *
 * 两块数据：
 *  1. **分段配速**：**唯一口径在 `utils/geo.ts::trackSplits`**（本文件只做
 *     展示整形与可疑标记），明细抽屉与总结页因此永远同数据。
 *     为什么每公里而不是每 400m：每公里是跑者唯一在表盘上能对上的刻度。
 *  2. **爬升**：唯一口径在 `utils/geo.ts::trackAscentFiltered`（丢差精度点 →
 *     每 50m 重采样 → 中值窗 5 → 迟滞 5m），本文件不再自带一份滤波。
 *
 * 手动补填距离（`manualKm`）不再作废分段：轨迹与填值的偏差是**信息**
 * （`distanceMismatch` + 视图算出的百分比），按哪种口径展示由视图决定；
 * 直接把整张表删掉，用户连「差多少」都看不到。
 */

import { fmtClock, fmtPace } from './format'
import { haversineM, trackAscentFiltered, trackLengthM, trackSplits } from './geo'
import type { RunTrackPoint } from '@/types'

export { fmtClock, fmtPace }

export interface SplitRow {
  /** 第几公里（1-based） */
  index: number
  /** 该段耗时（秒） */
  sec: number
  /** 该段配速（秒/公里） */
  paceSecPerKm: number
  /** 该段爬升（米，只计正；段内高程数据不足时为 0） */
  ascentM: number
  /** 该段起点/终点在轨迹点里的索引（与 geo.TrackSplit 同源，用于高亮/定位） */
  startPt: number
  endPt: number
  /**
   * 可疑段：段内任一步 Δt≥30s（后台断档）或隐含速度<0.4 m/s（几乎没动）。
   * 这类段的配速是「数据缺口+弦线」算出来的，不该参与最快/最慢评比。
   */
  suspect?: boolean
}

export interface RunSummary {
  /** 逐公里分段；距离不足 1km 或轨迹不足时为空数组 */
  splits: SplitRow[]
  /** 累计爬升（米）；一个有效高程点都没有时 null（不是 0 —— 「没测到」与「平路」要分得开） */
  ascentM: number | null
  /** 爬升估计是否可信（有效点 ≥20 且无 >200m 断档）；false 时视图说「高程数据不足」 */
  ascentAvailable: boolean
  /**
   * 分段是否可用：false = 轨迹不足（splits 必为空）。
   * 与手动补填无关 —— 补填造成的口径差由 distanceMismatch 表达。
   */
  splitsAvailable: boolean
  /** 最快的一公里；不足 1km / 只有一段可比时 null。可疑段不参与评比 */
  fastestKm: SplitRow | null
  /** 最慢的一公里；同上 */
  slowestKm: SplitRow | null
  /** 快慢差（秒/公里）；不足两段时 null —— 只跑了一公里谈不上「稳定性」 */
  paceSpread: number | null
  /** 轨迹里程（米）：与入账距离对照，说明「画的线」与「记的距离」差在哪 */
  trackM: number
  /** 填报距离与分段口径不一致：|manualKm*1000 − D| > max(50m, 3%×D) */
  distanceMismatch: boolean
}

/** 时长显示：秒 → 「3 分 20 秒」/「45 秒」 */
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} 秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
}

/** 段内是否有异常步（Δt≥30s 或隐含速度<0.4 m/s）：见 SplitRow.suspect */
function segmentSuspect(seg: RunTrackPoint[]): boolean {
  for (let i = 1; i < seg.length; i++) {
    const a = seg[i - 1]!
    const b = seg[i]!
    const dt = typeof a.t === 'number' && typeof b.t === 'number' ? (b.t - a.t) / 1000 : 0
    if (dt >= 30) return true
    if (dt > 0 && haversineM(a.lat, a.lon, b.lat, b.lon) / dt < 0.4) return true
  }
  return false
}

/** 逐段几何里程（米） */
function segLengthM(seg: RunTrackPoint[]): number {
  let sum = 0
  for (let i = 1; i < seg.length; i++) {
    sum += haversineM(seg[i - 1]!.lat, seg[i - 1]!.lon, seg[i]!.lat, seg[i]!.lon)
  }
  return sum
}

/**
 * 轨迹点 → 逐公里分段（口径委托 geo.trackSplits）+ 滤波爬升。
 *
 * @param opts.distanceM 记录的总距离（入账值）：分段按它缩放，与表盘数字一致。
 * @param opts.manualKm 总结页填报的距离：只用于 distanceMismatch 判定，不作废分段。
 */
export function buildRunSummary(
  points: RunTrackPoint[],
  opts: { distanceM?: number; manualKm?: number | null } = {},
): RunSummary {
  const { manualKm = null } = opts
  const trackM = trackLengthM(points)
  const D = opts.distanceM != null && opts.distanceM > 0 ? opts.distanceM : trackM
  const ascent = trackAscentFiltered(points)
  const distanceMismatch =
    manualKm != null && Math.abs(manualKm * 1000 - D) > Math.max(50, 0.03 * D)

  const raw = trackSplits(points, D)
  const scale = trackM > 0 ? D / trackM : 1 // 轨迹米 → 入账米
  const splits: SplitRow[] = (raw ?? []).map((s, i) => {
    const seg = points.slice(s.startPt, s.endPt + 1)
    const segDistM = segLengthM(seg) * scale
    // 末段是按实际距离折算的「配速」，其余是「耗时」——按 label 是否是纯数字区分
    const partial = !/^\d+$/.test(s.label)
    const sec = partial ? s.paceSec * (segDistM / 1000) : s.paceSec
    return {
      index: i + 1,
      sec: Math.round(sec),
      paceSecPerKm: segDistM > 0 ? Math.round((sec / segDistM) * 1000) : Math.round(s.paceSec),
      ascentM: Math.round(trackAscentFiltered(seg).m ?? 0),
      startPt: s.startPt,
      endPt: s.endPt,
      ...(segmentSuspect(seg) ? { suspect: true } : {}),
    }
  })

  /**
   * 最快 / 最慢：**全等速时返回 null**，不制造差异。
   *
   * `reduce` 不给初值时，全等速数组会一路返回第一项 —— 结果是
   * 「第 1 公里」同时被标成最快和最慢（踩过：等速合成轨迹上
   * fast=1 且 slow=1，叠在同一个格子上）。那样的标记是在编造信息：
   * 用户会以为第 1 公里有某种特殊性，而真相是四段一模一样。
   * 只有存在**真实差异**（最快 ≠ 最慢）才标；「相差」同理。
   * 可疑段（后台断档/几乎没动）一律不参与评比。
   */
  const candidates = splits.filter((r) => !r.suspect)
  let fastest: SplitRow | null = null
  let slowest: SplitRow | null = null
  for (const row of candidates) {
    if (fastest == null || row.paceSecPerKm < fastest.paceSecPerKm) fastest = row
    if (slowest == null || row.paceSecPerKm > slowest.paceSecPerKm) slowest = row
  }
  if (fastest && slowest && fastest.index === slowest.index) {
    fastest = null
    slowest = null
  }
  return {
    splits,
    ascentM: ascent.m,
    ascentAvailable: ascent.ok,
    // 不足一公里：没有可比的分段，同样按「不可用」处理
    splitsAvailable: splits.length > 0,
    fastestKm: fastest,
    slowestKm: slowest,
    paceSpread: fastest && slowest ? slowest.paceSecPerKm - fastest.paceSecPerKm : null,
    trackM,
    distanceMismatch,
  }
}
