import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * 单行溢出文本跑马灯（宽度不变的横向循环）。
 *
 * 为什么不用「换字动画」代替：换字要么改 DOM 文本、要么改宽度，两者都会把父级
 * 重新量一遍布局 —— 页头标题跟着左右跳一格。这里把**宽度交给外部 sizer 钉死**，
 * 内容只做 transform 位移：布局一次到位，滚动期间不再有任何尺寸变化。
 *
 * 与 EffiBuddy 的 useMarquee 同一条管线（单向循环 + 双份副本 + mask 渐隐），
 * 去掉 hover 门控：状态标签是常驻信息，不该要求用户先把指针放上去才给看全。
 *
 * 模板结构（样式由使用方给；三个元素用 useTemplateRef 交给本函数）：
 *   <span ref="view" class="view" :class="{ 'is-overflow': isOverflow, 'is-scrolling': isScrolling }">
 *     <span ref="inner" class="track">
 *       <span ref="copy" class="copy">{{ text }}</span>
 *       <span v-if="isOverflow" class="copy" aria-hidden="true">{{ text }}</span>
 *     </span>
 *   </span>
 *
 * 生命周期：挂载后 nextTick 首测 → ResizeObserver 盯容器宽度 → fonts.ready 复测
 * （字体晚到会改单份副本宽度）→ 文本变化重置回起点重新判定 → 卸载取消动画与观察者。
 */
export interface MarqueeTextEls {
  /** 裁剪视口：宽度是判定溢出的基准 */
  view: Readonly<Ref<HTMLElement | null>>
  /** 内部滚动层（两份副本整体平移） */
  inner: Readonly<Ref<HTMLElement | null>>
  /** 首份副本：量完整文本宽度，不受第二份影响 */
  copy: Readonly<Ref<HTMLElement | null>>
}

/** 滚动速度 px/s（与参考实现一致） */
const SPEED = 40

export function useMarqueeText(text: Ref<string>, enabled: Ref<boolean>, els: MarqueeTextEls) {
  const isOverflow = ref(false)
  const isScrolling = ref(false)

  let anim: Animation | null = null
  let observer: ResizeObserver | null = null

  function stop(): void {
    anim?.cancel()
    anim = null
    isScrolling.value = false
  }

  function start(): void {
    stop()
    if (!enabled.value || !isOverflow.value) return
    const inner = els.inner.value
    const copy = els.copy.value
    if (!inner || !copy) return
    // 周期 = 单份宽度 + 副本间距：双份整体平移一个周期后与开头逐像素重合
    const gap = parseFloat(getComputedStyle(copy).marginRight) || 0
    const period = copy.offsetWidth + gap
    if (period <= 0) return
    isScrolling.value = true
    anim = inner.animate(
      [{ transform: 'translateX(0px)' }, { transform: `translateX(${-period}px)` }],
      {
        duration: Math.max(2000, (period / SPEED) * 1000),
        iterations: Infinity,
        easing: 'linear',
      },
    )
  }

  /** 量单份副本是否超出视口。副本不设 max-width，量到的就是完整文本宽 */
  function measure(): void {
    const view = els.view.value
    const copy = els.copy.value
    if (!view || !copy) return
    isOverflow.value = copy.offsetWidth > view.clientWidth + 1
    if (enabled.value && isOverflow.value) start()
    else stop()
  }

  // 文本变化：先停下回到起点，等第二份副本按新文本挂载后再量
  watch(text, () => {
    stop()
    void nextTick(measure)
  })

  // 动效关闭时保留溢出裁剪（右缘渐隐），但不滚动 —— 不拿位移当常态装饰
  watch(enabled, (on) => {
    if (on) measure()
    else stop()
  })

  onMounted(() => {
    void nextTick(measure)
    if (typeof ResizeObserver !== 'undefined' && els.view.value) {
      observer = new ResizeObserver(measure)
      observer.observe(els.view.value)
    }
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(measure).catch(() => {})
    }
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    stop()
  })

  return { isOverflow, isScrolling, remeasure: measure }
}
