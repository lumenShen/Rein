import { computed, ref } from 'vue'

/**
 * 液态玻璃（GlassSurface）的可调参数 —— system 层的界面级偏好。
 *
 * 为什么要可调：这套折射管线的默认值是**按 54~58px 的 UI 尺寸标定**出来的
 * （见 GlassSurface 头注释），换一块尺寸 / 换一种底色，合适的「厚度」「位移量」
 * 就会变。与其每次改代码重编，不如把管线上的 9 个数字摊开：画质预览页的
 * 「液态玻璃参数调节」面板就地改，改完存本地（`rein.glass.v1`），GlassSurface
 * 的默认值读这里 —— 组件调用处仍然只给尺寸与圆角，材质只有这一份定义。
 *
 * 只有**折射分支**读这些值（普通毛玻璃档走 CSS 令牌 --glass-fill / blur）；
 * 所以调参时要把档位切到「超高」才看得见差别。
 *
 * 英文键名与 GlassSurface 的 prop 同名（面板里并列显示中文名），
 * 定稿后把选定的数写回 GLASS_DEFAULTS 即可 —— 面板的「恢复默认」就是回到它。
 */
export type GlassParamKey =
  | 'borderWidth'
  | 'brightness'
  | 'opacity'
  | 'blur'
  | 'distortionScale'
  | 'displace'
  | 'saturation'
  | 'backgroundOpacity'
  | 'mapScale'

export interface GlassParamSpec {
  key: GlassParamKey
  /** 中文名（与英文键名并列显示） */
  cn: string
  min: number
  max: number
  step: number
}

/**
 * 参数清单（也是面板的渲染顺序）：按管线的数据流排 ——
 * 位移贴图（边缘厚度 / 中心亮度 / 贴图不透明度 / 贴图模糊 / 贴图分辨率）→ 位移
 * （位移强度）→ 收尾（边缘柔化）→ 表面（背景饱和度 / 底色浓度）。
 * 区间刻意给宽（面板是给「调到合适为止」用的，不是给日常微调的）。
 *
 * 从前这里还有 redOffset / greenOffset / blueOffset 三项（三通道色散）。它们随完整链
 * 一起删掉了：只有一次位移时，那份「加在 distortionScale 上的通道偏置」就是一个
 * 换个名字的 distortionScale —— 参数面板上留三个不起作用的滑杆比删掉更糟。
 */
export const GLASS_PARAM_SPECS: GlassParamSpec[] = [
  { key: 'borderWidth', cn: '边缘厚度', min: 0, max: 1, step: 0.02 },
  { key: 'brightness', cn: '中心亮度', min: 0, max: 100, step: 1 },
  { key: 'opacity', cn: '贴图不透明度', min: 0, max: 1, step: 0.05 },
  { key: 'blur', cn: '贴图模糊', min: 0, max: 100, step: 1 },
  // 位移贴图的分辨率除数：1 = 按元素像素尺寸烘，2 = 半分辨率再让 feImage 拉回原尺寸。
  // 贴图本身是一条平滑的渐变（边缘那道斜坡由 blur 撑开），降分辨率只是把斜坡采样得粗一点，
  // 位移量是连续量，采样误差落回亚像素 —— 这是「省一点、观感几乎不动」的那个旋钮。
  { key: 'mapScale', cn: '贴图分辨率除数', min: 1, max: 4, step: 1 },
  // 位移强度按**绝对像素**给（feDisplacementMap 的 scale）：小表面本来只需 ±20 上下，
  // 但「厚玻璃」那一路要把边缘整个扯开，区间因此开到 ±300 —— 数值可以点一下直接输入，
  // 滑杆在这里只是粗调。
  { key: 'distortionScale', cn: '折射位移强度', min: -300, max: 300, step: 1 },
  { key: 'displace', cn: '边缘柔化', min: 0, max: 8, step: 0.1 },
  { key: 'saturation', cn: '背景饱和度', min: 0, max: 5, step: 0.1 },
  { key: 'backgroundOpacity', cn: '玻璃底色浓度', min: 0, max: 1, step: 0.02 },
]

/**
 * 出厂值 = 2026-09-24 在调节面板上定稿的第二组（对着 54~58px 的 UI 尺寸调出来的）。
 * 这一组的走向是**薄边 + 大位移**：边缘厚度收到 0.06（折射带只有一两像素宽）、
 * 位移强度给到 -180（把那道窄边整个扯开），配 2.0 的边缘柔化把硬边化开 ——
 * 玻璃读起来是「一层很薄的膜裹着厚折射」，而不是均匀糊开的一片。
 * 底色浓度 0.1 压得很薄：折射层背后就是页面本身，浓度一高会把折射一起压平。
 */
export const GLASS_DEFAULTS: Record<GlassParamKey, number> = {
  borderWidth: 0.06,
  brightness: 50,
  opacity: 0.95,
  blur: 11,
  mapScale: 1,
  distortionScale: -180,
  displace: 2.0,
  saturation: 1.4,
  backgroundOpacity: 0.1,
}

const STORE_KEY = 'rein.glass.v1'

/**
 * 出厂值版本：**改一次 GLASS_DEFAULTS / GLASS_PARAM_SPECS 就 +1**。
 *
 * 本地存的是「调参会话」——出厂值一换，上一次会话就不再是「从当前出厂值出发的微调」，
 * 留着只会让人对着旧的一组数调（面板显示的是本地值，不是新出厂值）。所以版本不符就
 * 整份丢弃、回到新的出厂值；面板里的「恢复默认」同样回到这里。
 *
 * rev 4：三个通道偏移随完整链删除（rev 3 的会话里有它们的值，读进来也没处用）。
 */
const DEFAULTS_REV = 4

function clamp(spec: GlassParamSpec, value: number): number {
  return Math.min(spec.max, Math.max(spec.min, value))
}

/** 读本地会话：缺项 / 损坏 / 越界一律回落默认值（面板拖坏了也不能拖垮玻璃） */
function load(): Record<GlassParamKey, number> {
  const out = { ...GLASS_DEFAULTS }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as { rev?: unknown; values?: unknown } | null
    // 旧版（扁平结构，没有 rev）或出厂值已换代：整份丢弃，不做字段级迁移 —— 会话是一次性的
    if (!parsed || typeof parsed !== 'object' || parsed.rev !== DEFAULTS_REV) return out
    const values = parsed.values
    if (!values || typeof values !== 'object') return out
    for (const spec of GLASS_PARAM_SPECS) {
      const value = (values as Record<string, unknown>)[spec.key]
      if (typeof value === 'number' && Number.isFinite(value)) out[spec.key] = clamp(spec, value)
    }
  } catch {
    /* 本地存储不可用 → 默认值 */
  }
  return out
}

/** 当前生效的参数（GlassSurface 的默认值读它；面板改的也是它） */
export const glassParams = ref<Record<GlassParamKey, number>>(load())

/** 是否已经偏离出厂值（面板据此点亮「恢复默认」） */
export const glassTuned = computed(() =>
  GLASS_PARAM_SPECS.some((spec) => glassParams.value[spec.key] !== GLASS_DEFAULTS[spec.key]),
)

function persist(): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ rev: DEFAULTS_REV, values: glassParams.value }))
    return true
  } catch {
    return false
  }
}

export function specOf(key: GlassParamKey): GlassParamSpec {
  return GLASS_PARAM_SPECS.find((spec) => spec.key === key)!
}

export function setGlassParam(key: GlassParamKey, value: number): boolean {
  if (!Number.isFinite(value)) return false
  glassParams.value = { ...glassParams.value, [key]: clamp(specOf(key), value) }
  return persist()
}

export function resetGlassParams(): boolean {
  glassParams.value = { ...GLASS_DEFAULTS }
  return persist()
}
