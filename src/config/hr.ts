/** 心率区间展示元数据（与 Rust calc::zone_of_ratio 的 5 分区一一对应）。
 *
 * 最大心率口径 = 220 − 年龄（与 modules/healthsync 反推强度用的一致），
 * 所以颜色顺序也按「热身 → 极限」渐进：青 → 绿 → 橙 → 红 → 紫。
 * 色相只出现在色点 / 分段条 / 图标上；区间文字一律中性色。
 */

export interface HrZoneMeta {
  zone: 1 | 2 | 3 | 4 | 5
  label: string
  /** 最大心率百分比区间（展示用） */
  range: string
  colorVar: string
}

export const HR_ZONES: HrZoneMeta[] = [
  { zone: 1, label: '热身', range: '< 60%', colorVar: '--sys-teal' },
  { zone: 2, label: '燃脂', range: '60–70%', colorVar: '--sys-green' },
  { zone: 3, label: '有氧', range: '70–80%', colorVar: '--sys-orange' },
  { zone: 4, label: '无氧', range: '80–90%', colorVar: '--sys-red' },
  { zone: 5, label: '极限', range: '≥ 90%', colorVar: '--sys-purple' },
]

export function hrZoneMeta(zone: number | null | undefined): HrZoneMeta | null {
  if (zone == null || zone < 1 || zone > 5) return null
  return HR_ZONES[Math.trunc(zone) - 1] ?? null
}
