/** 心率区间展示元数据（与 Rust calc::zone_of_ratio 的 5 分区一一对应）。
 *
 * 最大心率口径 = Tanaka / Gulati（见 modules/heartrate/calc.rs），颜色按
 * 「热身 → 极限」渐进：蓝 → 绿 → 橙 → 红 → 紫。
 * 色相只出现在色点 / 分段条 / 图标上；区间文字一律中性色。
 *
 * colorVar 取主令牌表里**已有**的语义色：此前写的 --sys-* 在 main 的 tokens
 * 里并不存在，字段一直没人使用、因此也没暴露出来。 */
export interface HrZoneMeta {
  zone: 1 | 2 | 3 | 4 | 5
  label: string
  /** 最大心率百分比区间（展示用） */
  range: string
  colorVar: string
}

export const HR_ZONES: HrZoneMeta[] = [
  { zone: 1, label: '热身', range: '< 60%', colorVar: '--c-water' },
  { zone: 2, label: '燃脂', range: '60–70%', colorVar: '--ok' },
  { zone: 3, label: '有氧', range: '70–80%', colorVar: '--warn' },
  { zone: 4, label: '无氧', range: '80–90%', colorVar: '--danger' },
  { zone: 5, label: '极限', range: '≥ 90%', colorVar: '--mod-ai-tone' },
]

export function hrZoneMeta(zone: number | null | undefined): HrZoneMeta | null {
  if (zone == null || zone < 1 || zone > 5) return null
  return HR_ZONES[Math.trunc(zone) - 1] ?? null
}
