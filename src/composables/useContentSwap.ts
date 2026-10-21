import { animate, createSpring, type AnimationParams, type SpringParams } from 'animejs'
import { nextTick, onBeforeUnmount, type Ref } from 'vue'

import { motionOn } from '@/system/motion'
import {
  NUDGE_SPRING,
  SWAP_BLUR_PX,
  SWAP_IN_DELAY_MS,
  SWAP_IN_MS,
  SWAP_OUT_MS,
  SWAP_SPRING,
} from '@/system/motionSpring'

/**
 * 「容器尺寸 + 内容」一起变的那一条动画（交错交换）。
 *
 * 抽出来是因为它**不是一个组件的一处小动效，而是一套时序**：容器有自己的尺寸，
 * 内容按它排版，两者同时变时若一起淡入淡出，读起来就是"两块字叠在一起"；
 * 必须让旧内容先走干净、容器再 spring 到新尺寸、新内容最后进场。三段的时间点
 * 与两端的模糊量是一组，任何一处抄错都会露馅（最典型的是旧内容还没消失就换
 * 底色，于是同一帧里有两套字）。这种东西写第二遍就会有第二套数字。
 *
 * 时序（数字在 `system/motionSpring.ts`，与 `scratch/spring-bubble` 实验室同源）：
 *   0.00s  旧内容 blur + 缩小 + 淡出        outMs
 *   outMs  spring 把 width / height 送到新尺寸（约 0.4s）
 *   +in    新内容由 blur + 缩小淡入          inMs
 * 旧新两层**不在同一时刻都清晰** —— 这是整套动画唯一的硬约束。
 *
 * 三层的分工（调用方按这个约定摆 DOM）：
 *   container  容器：宽高由本模块 spring 驱动，自己不要写 transition: width/height
 *   ghost      旧内容层：交换期间渲染**快照**（v-if 控制，没有旧内容时可以不渲染）
 *   live       新内容层：绝大多数时候就是"当前内容"，只在交换的 0.7s 里被压成透明
 *   measure    量宽层：`width: max-content` 的隐藏层，渲染**即将呈现**的文案
 *
 * ⚠️ 量宽层必须自己按内容撑开（`.layer` 那种 `position:absolute; inset:0` 不能用）：
 *   那样量到的是容器自己的宽度，每交换一轮就把容器撑大一圈（实测 160 → 378）。
 *
 * 竞态：连续两次交换时，后一次作废前一次遗留的定时器（`seq`）；`resize` 在交换
 * 进行中（`busy()`）一律不动 —— 否则 spring 还在飞就被第二个 spring 顶掉。
 */

export interface SwapBox {
  /** 容器：宽 / 高被 spring 驱动的那个元素 */
  container: Ref<HTMLElement | null>
  /** 旧内容层（快照层，可缺省） */
  ghost: Ref<HTMLElement | null>
  /** 新内容层 */
  live: Ref<HTMLElement | null>
  /** 量宽层：渲染即将呈现的文案，隐藏且不参与布局 */
  measure: Ref<HTMLElement | null>
}

export interface SwapTiming {
  /** 内容两侧的留白（单侧 px）。不给就读容器自己的内距 + 边框宽度 */
  padX?: number
  /** 量不到内容时的兜底尺寸（也是短文案不至于缩成一条的保底） */
  minWidth?: number
  minHeight?: number
  /** 交换的尺寸 spring */
  spring?: SpringParams
  /** 同阶段内尺寸微调的 spring（更短、过冲更小） */
  nudgeSpring?: SpringParams
  /** 旧内容淡出（ms） */
  outMs?: number
  /** spring 起跑后多久新内容进场（ms） */
  inDelayMs?: number
  /** 新内容淡入（ms） */
  inMs?: number
  /** 进出两端的模糊量（px） */
  blurPx?: number
}

export interface SwapSteps {
  /** 0.00s 之前：把旧内容搬进 ghost 层（调用方自己的状态） */
  stash: () => void
  /** outMs 时刻：容器开始 spring —— 换底色的时机，不早于旧内容消失 */
  tint?: () => void
  /** outMs + inDelayMs 时刻：新内容置位（ghost 清空） */
  commit: () => void
}

export function useContentSwap(box: SwapBox, timing: SwapTiming = {}) {
  const spring: SpringParams = timing.spring ?? SWAP_SPRING
  const nudge: SpringParams = timing.nudgeSpring ?? NUDGE_SPRING
  const outMs = timing.outMs ?? SWAP_OUT_MS
  const inDelayMs = timing.inDelayMs ?? SWAP_IN_DELAY_MS
  const inMs = timing.inMs ?? SWAP_IN_MS
  const blurPx = timing.blurPx ?? SWAP_BLUR_PX

  let seq = 0
  let busyUntil = 0
  let timers: number[] = []
  let anims: ReturnType<typeof animate>[] = []

  function clearTimers(): void {
    for (const t of timers) window.clearTimeout(t)
    timers = []
  }

  function stop(): void {
    clearTimers()
    seq++
    for (const a of anims) a.cancel()
    anims = []
  }

  function play(target: HTMLElement, params: AnimationParams): void {
    // 顺手清掉已结束的：本模块每次交换最多留三个实例，不去重会一直堆
    anims = anims.filter((a) => !a.completed)
    anims.push(animate(target, params))
  }

  /** 容器自己给内容的横向留白：量宽层不带内距，得由这里补回去 */
  function gutter(): number {
    if (timing.padX != null) return timing.padX * 2
    const el = box.container.value
    if (!el) return 0
    const cs = getComputedStyle(el)
    const px = (v: string): number => Number.parseFloat(v) || 0
    return px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)
  }

  /** 目标尺寸 = 量宽层的自然宽度 + 容器留白（高度按内容，低于下限取下限） */
  function size(): { w: number; h: number } {
    const minW = timing.minWidth ?? 0
    const minH = timing.minHeight ?? 0
    const el = box.measure.value
    if (!el) {
      // 量不到就**保持现状**：宁可这一轮不动，也别把容器写成 0
      const boxEl = box.container.value
      if (!boxEl) return { w: 0, h: 0 }
      const r = boxEl.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }
    const r = el.getBoundingClientRect()
    return {
      w: Math.max(minW, Math.ceil(r.width) + gutter()),
      h: Math.max(minH, Math.ceil(r.height)),
    }
  }

  function apply(to: { w: number; h: number }): void {
    const el = box.container.value
    if (!el) return
    el.style.width = `${to.w}px`
    el.style.height = `${to.h}px`
  }

  /** 完整交错交换：旧内容淡出 → spring 尺寸 → 新内容淡入 */
  async function swap(steps: SwapSteps): Promise<void> {
    const mySeq = ++seq
    clearTimers()
    // 关动效 / 容器还没挂上：直接到位 —— 关的是补间，不是状态
    if (!motionOn.value || !box.container.value) {
      steps.commit()
      steps.tint?.()
      await nextTick()
      apply(size())
      return
    }
    busyUntil = performance.now() + outMs + inDelayMs + inMs
    steps.stash()
    await nextTick()
    const to = size()
    const live = box.live.value
    if (live) live.style.opacity = '0'
    const ghostEl = box.ghost.value
    if (ghostEl) {
      play(ghostEl, {
        opacity: [1, 0],
        scale: [1, 0.88],
        filter: ['blur(0px)', `blur(${blurPx}px)`],
        duration: outMs,
        ease: 'outQuad',
      })
    }
    timers.push(
      window.setTimeout(() => {
        if (mySeq !== seq) return
        const el = box.container.value
        if (!el) return
        steps.tint?.()
        play(el, { width: to.w, height: to.h, ease: createSpring({ ...spring }) })
      }, outMs),
    )
    timers.push(
      window.setTimeout(() => {
        if (mySeq !== seq) return
        void (async () => {
          steps.commit()
          await nextTick()
          const el = box.live.value
          if (!el || !motionOn.value) return
          play(el, {
            opacity: [0, 1],
            scale: [0.9, 1],
            filter: [`blur(${blurPx}px)`, 'blur(0px)'],
            duration: inMs,
            ease: 'outQuad',
          })
        })()
      }, outMs + inDelayMs),
    )
  }

  /**
   * 同一阶段内的数字变化：只 spring 尺寸，内容直接换。
   * 不做模糊进出 —— 那是"每秒都在闪"，读起来像卡顿而不像反馈。
   */
  async function resize(commit: () => void): Promise<void> {
    if (performance.now() < busyUntil) return
    await nextTick()
    const to = size()
    commit()
    const el = box.container.value
    if (!el) return
    if (!motionOn.value) {
      apply(to)
      return
    }
    play(el, { width: to.w, height: to.h, ease: createSpring({ ...nudge }) })
  }

  /** 首帧把尺寸对到真实内容（CSS 里的初值只是防跳动的近似） */
  async function sync(): Promise<void> {
    await nextTick()
    apply(size())
  }

  /** 作废在飞行中的那一次交换（换组 / 换阶段时调用） */
  function invalidate(): void {
    seq++
    clearTimers()
  }

  /** 是否正在交换中 */
  function busy(): boolean {
    return performance.now() < busyUntil
  }

  onBeforeUnmount(stop)

  return { swap, resize, sync, invalidate, busy, size }
}
