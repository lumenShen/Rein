import { computed, ref, watch } from 'vue'

import { perfDegraded } from '@/system/perf'

/**
 * 动效丰富程度 · UI 状态单例（system 层）。
 *
 * 为什么单独一个开关，而不是挂在画质档位下：**这是两个正交的问题**。
 * 画质档位回答的是「这块玻璃画不画得出来」（能力 + 成本），动效档位回答的是
 * 「界面要不要动」。一台撑得住超高折射的机器，用户也可能就是不想要动画；反过来，
 * 一台只能跑「流畅优先」的机器，用户选「关闭」也不该被理解成"降级"。
 *
 * 三档：
 *   off      关闭：不做任何补间 —— 状态直接切换，循环动画停住。
 *            注意「关的是补间，不是状态」：`:active` 的颜色与缩放终值照常生效，
 *            只是瞬时到位。这与 base.css 里那块 `prefers-reduced-motion` 完全同一
 *            套做法，也避开了 `data-perf='low'` 注释里那句「没有按压反馈会显得失灵」。
 *   default  默认：**这一次改动之前的那一套**，一个字节都不改。新加的动效一律不出现。
 *   rich     丰富：默认之上再加液态玻璃那几样 —— 融合 / 形变 / 定向光晕 / 透镜进出 /
 *            滚动边缘。它们的共同点是**每帧都在合成**，所以必须能被单独关掉。
 *
 * 落地：结论写进 <html data-motion>，CSS 只认这一个属性（与 perf 层写 data-perf 同构）。
 * 优先级见下面的 effective —— **只有一个写入点**，别处不要再各自算一遍。
 */

export type MotionLevel = 'off' | 'default' | 'rich'

/** 档位清单：设置页与画质预览页共用这一份（标签、说明都不在页面里另抄一遍） */
export const MOTION_LEVELS: { value: MotionLevel; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '不做任何补间：状态直接切换，循环动画停住' },
  { value: 'default', label: '默认', hint: '现在这一套：按压反馈、弹层进出、必要的循环提示' },
  { value: 'rich', label: '丰富', hint: '默认之上再加液态玻璃：融合、形变、定向光晕、透镜进出' },
]

const STORE_KEY = 'rein.motion.v1'

/** 读本地档位；损坏 / 不可用一律回落 **default**。
 *  默认必须是 default 而不是 off：动效是**产品的一部分**，全新安装直接不动
 *  等于「装完就像坏了一样」（perf 层那条 default 的教训，见 system/perf 的注释）。 */
function loadLevel(): MotionLevel {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw === 'off' || raw === 'default' || raw === 'rich') return raw
  } catch {
    /* 本地存储不可用时用默认档 */
  }
  return 'default'
}

/** 用户档位：off / default / rich */
export const motionLevel = ref<MotionLevel>(loadLevel())

/**
 * 系统「减弱动效」：与应用内档位是**或**的关系 —— 系统要求了就不做。
 * 做成响应式是为了让 JS 侧（自绘弹簧、逐帧插值）与 CSS 侧判定同源：
 * CSS 那块媒体查询仍然保留（JS 还没执行时它是唯一兜底），但 JS 侧不再各自 matchMedia。
 */
export const systemReducedMotion = ref(false)

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  systemReducedMotion.value = mq.matches
  mq.addEventListener('change', (e) => {
    systemReducedMotion.value = e.matches
  })
}

/**
 * **真正生效的档位**（CSS 与 JS 都只认它）：
 *   · 用户选了关闭，或系统要求减弱动效        → off
 *   · 画质档位是「流畅」（perfDegraded）      → 至多 default ——
 *     丰富档那几样都是**每帧合成**（融合滤镜、全视口遮罩模糊、滚动逐帧写变量），
 *     用户主动选了最省的画质档时再叠上去就是火上浇油。流畅档承诺的是「先把画面稳住」。
 *   · 其余                                    → 用户选的档位
 */
const effective = computed<MotionLevel>(() => {
  if (motionLevel.value === 'off' || systemReducedMotion.value) return 'off'
  if (perfDegraded.value) return 'default'
  return motionLevel.value
})

/** 当前生效的档位（设置页要如实报出被系统 / 掉帧压回后的结果） */
export const motionEffective = effective

/** 补间开不开：off 为 false。JS 侧的动效调用点一律读它，别再去 matchMedia */
export const motionOn = computed(() => effective.value !== 'off')

/** 丰富档那几样（融合 / 形变 / 光晕 / 透镜 / 滚动边缘）要不要出：只有 rich 为 true */
export const motionRich = computed(() => effective.value === 'rich')

export function setMotionLevel(level: MotionLevel): boolean {
  motionLevel.value = level
  try {
    localStorage.setItem(STORE_KEY, level)
    return true
  } catch {
    return false
  }
}

/** 写在 <html> 上供 CSS 读。off 之外的两档都要写全名：CSS 靠 `[data-motion='rich']`
 *  把新增动效整段圈起来，靠 `[data-motion='off']` 关补间 —— 中间那档不需要额外规则。 */
watch(
  effective,
  (level) => {
    document.documentElement.dataset.motion = level
  },
  { immediate: true },
)
