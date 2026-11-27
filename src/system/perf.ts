import { computed, ref, watch } from 'vue'

/**
 * 运行时画质档位 · UI 状态单例（system 层）。
 *
 * 四个固定档（data-perf 的取值与之一致）：
 *   low      流畅：玻璃顶成实底、关模糊与循环动画
 *   high     高画质：玻璃材质全开（卡片 / 抽屉 / 菜单 / 操作面板 / 页头圆钮，
 *            **不含折射**）+ 渐进模糊与动效全开
 *   ultra    超高：高画质之上再加折射（塌缩管线）与两道光学层（内圈描边 / 上缘焦散）
 *   extreme  极致：与超高**同一条折射管线**，差别只在材质 —— 光学层再深一档、
 *            外缘层加厚。**覆盖范围与高画质一致**（从高画质起玻璃就铺到内容层），
 *            对齐苹果 Liquid Glass 的分层：导航与控件层用玻璃，内容保持可读。
 *
 * 「全程序只走一条折射管线」（2026-09-26）：此前 ultra 走塌缩链、extreme 走完整
 * 三通道链，理由是「极致要保留色散能力」。但色散从来不是出厂观感的一部分
 * （出厂三个通道偏移都是 0，两条链逐像素等价），代价却每帧都在付：同一个合
 * 成台架实测，12 块折射面上完整链比塌缩链**多 0.8ms/帧**（1.875 vs 1.060，
 * 见 scripts/e2e-glass-perf.mjs）。于是完整链整条删掉 —— 色散这一档能力没有
 * 对应的产品设计，而它是这条链上唯一还贵着的东西。**档位差异从此只在材质**：
 * 覆盖范围与光学层，与「观感差异不来自加 blur」是同一条原则。
 *
 * 旧值迁移（0.3.x → 本版）：auto → high（它本来就只在 high / low 之间自动切），
 * 「超高＋」ultra-opt → ultra（塌缩管线成为标准超高）。
 *
 * 落地：档位写进 <html data-perf>，折射管线单独写 <html data-glass>；
 * base.css 据此切换整套 --glass-* 令牌，PageHeader 读降级态换遮罩。
 */

export type PerfMode = 'low' | 'high' | 'ultra' | 'extreme'

/**
 * 折射表面的滤镜管线。**只有两条**：
 *   collapsed feImage + 1×feDisplacementMap + feGaussianBlur（3 个原语）
 *   off       不画折射
 *
 * 值仍然是字符串而不是布尔：`data-glass` 是给台架与像素比对读的**实现标签** ——
 * 断言写 `data-glass === 'collapsed'` 比 `=== 'true'` 更能说明此刻跑的是哪条链。
 */
export type GlassPipeline = 'collapsed' | 'off'

/**
 * 档位清单：设置页与画质预览页共用这一份（标签、说明都不在页面里另抄一遍）。
 * hint 说的是这一档**做了什么**，与页面上「此刻生效的是哪一档」是两件事。
 */
export const PERF_MODES: { value: PerfMode; label: string; hint: string }[] = [
  { value: 'low', label: '流畅', hint: '玻璃顶成实底、关模糊与循环动画，合成成本最低' },
  {
    value: 'high',
    label: '高画质',
    hint: '玻璃材质铺到卡片 / 抽屉 / 菜单 / 操作面板与页头圆钮（不含折射）+ 渐进模糊与动效',
  },
  {
    value: 'ultra',
    label: '超高',
    hint: '折射表面（塌缩管线）+ 两道光学层（内圈描边 / 上缘焦散）',
  },
  {
    value: 'extreme',
    label: '极致',
    hint: '光学层再深一档 + 外缘层加厚（折射管线与覆盖范围同超高 / 高画质）',
  },
]

const STORE_KEY = 'rein.perf.v1'

/** 旧值迁移表：改的是内部取值，已有的本地档位不能因此掉回默认 */
const LEGACY_MODES: Record<string, PerfMode> = {
  auto: 'high',
  'ultra-opt': 'ultra',
}

/**
 * 读本地档位；损坏 / 不可用一律回落 **high**。
 *
 * 为什么默认不是 low：渐进模糊、玻璃、页面进场动效都是**产品的一部分**，
 * 默认关掉等于「装完就像坏了一样」—— 0.2.5 升到 0.2.7 后用户看到的正是
 * 「渐进式模糊消失了」。现在的语义是「先给高画质，卡就手动切流畅」：
 * 四个档都是手动钉死的固定档，不再有自动判定。
 */
function loadMode(): PerfMode {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw === 'low' || raw === 'high' || raw === 'ultra' || raw === 'extreme') return raw
    const legacy = raw ? LEGACY_MODES[raw] : undefined
    if (legacy) {
      // 迁移后立刻落盘：下次启动不必再走一遍映射
      try {
        localStorage.setItem(STORE_KEY, legacy)
      } catch {
        /* 存不下就只留内存态 */
      }
      return legacy
    }
  } catch {
    /* 本地存储不可用时用默认档 */
  }
  return 'high'
}

/** 用户档位：四个固定档，手动切换 */
export const perfMode = ref<PerfMode>(loadMode())

/** 实际生效的降级态：页面头遮罩与动效开关都读它 */
export const perfDegraded = computed(() => perfMode.value === 'low')

/**
 * `backdrop-filter: url(#f)` 只有 Chromium 系认（滤镜当背景滤镜用是它独有的一步）；
 * Safari / Firefox 会**静默忽略**整条声明 —— 不探测的话表现就是「一片没玻璃的空白」。
 * 探测一次后缓存：能力在一台设备上是常量。
 */
let svgBackdropCache: boolean | null = null

export function supportsSvgBackdrop(): boolean {
  if (svgBackdropCache !== null) return svgBackdropCache
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return (svgBackdropCache = false)
  const ua = navigator.userAgent
  if ((/Safari/.test(ua) && !/Chrome/.test(ua)) || /Firefox/.test(ua)) return (svgBackdropCache = false)
  try {
    const probe = document.createElement('div')
    probe.style.setProperty('backdrop-filter', 'url(#pv-probe)')
    svgBackdropCache = probe.style.getPropertyValue('backdrop-filter') !== ''
  } catch {
    svgBackdropCache = false
  }
  return svgBackdropCache
}

/**
 * 液态玻璃开关（超高 / 极致两档共用）：用户选了这两档、这台设备画得出来。
 * 判定放在 perf 层而不是组件里 —— 档位是应用级状态，「哪些表面用得起玻璃」
 * 应当由状态说了算，组件不该各自去猜。
 */
export const liquidGlass = computed(
  () => (perfMode.value === 'ultra' || perfMode.value === 'extreme') && supportsSvgBackdrop(),
)

/**
 * 实际生效的折射管线 —— GlassSurface / 悬浮条 / 沉浸层控制层都按它决定挂不挂那段滤镜。
 *
 * **只有一条**：feImage + 1×feDisplacementMap + feGaussianBlur（3 个原语）。
 * 上游那条完整链是「三次位移 + 三色矩阵 + 两次 screen 复合」，为的是色散；
 * 而三次位移的 scale 是 `distortionScale + 各通道 offset` —— 三个 offset 相等时
 * 三次结果逐像素相同，三张单通道图 screen 起来正好还原原色（screen 在通道互斥时
 * 就是相加），整段复合是**恒等变换**。出厂值三个 offset 都是 0，所以完整链与
 * 塌缩链逐像素一致（台架实测 0/399900 像素差）。
 *
 * 既然出厂就是恒等、色散又没有产品设计对应，完整链整条删掉：超高与极致共用
 * 塌缩链，档位差异只在材质（光学层深度 + 覆盖范围）。省下的不是小数 ——
 * 12 块折射面上完整链比塌缩链多 0.8ms/帧（见 e2e-glass-perf 的实测）。
 */
export const glassPipeline = computed<GlassPipeline>(() => (liquidGlass.value ? 'collapsed' : 'off'))

export function setPerfMode(mode: PerfMode): boolean {
  perfMode.value = mode
  try {
    localStorage.setItem(STORE_KEY, mode)
    return true
  } catch {
    return false
  }
}

watch(
  [perfDegraded, perfMode, glassPipeline],
  ([degraded, mode, pipeline]) => {
    // 档位原样写进 DOM（low / high / ultra / extreme）：base.css 与各处断言都读它。
    // 四个档都是手动钉死的固定档，不会出现「选了高档又被悄悄降级」这种前后不一致的状态。
    // 折射实现单独写 data-glass，像素比对与性能台架读它。
    document.documentElement.dataset.perf = degraded ? 'low' : mode
    document.documentElement.dataset.glass = pipeline
  },
  { immediate: true },
)
