/**
 * useVirtualChat —— 可变高度聊天段的窗口化。
 *
 * 模型：段（ChatSegment）是唯一的行；高度 = 实测缓存 ?? 估算。
 * 布局：`.virtual-body` 里「上 spacer + 连续可见段 + 下 spacer」，
 * spacer 用前缀和 offsets 算，因此 DOM 里永远只有视口段 + overscan + pinned，
 * 与总消息数无关（一万条消息也只有 15–25 段）。
 *
 * 三个聊天特有问题的处理：
 *  1. 前插：captureAnchor/restoreAnchor 用「首个与视口相交的段 + rect.top」，
 *     不依赖浏览器原生 overflow-anchor（spacer 布局下不可靠）。
 *  2. 流式：末段在视口内时由 ResizeObserver 实测；页面在 streamSeq 上吸底。
 *  3. 折叠/展开：段高变化经 RO 回写；若段在视口上方，同步修正 scrollTop。
 *
 * 不使用绝对定位（plan 提到的 transform 方案）是因为 spacer 流式布局能保留
 * `.msg` 的自然 margin/焦点顺序；代价是 pinned 段只能并入连续窗口（有上限保护）。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { estimateSegmentHeight, type ChatSegment } from '@/ai/chatSegments'
import { deleteHeight, flushHeights, loadHeights, setHeight as persistHeight } from './heightCache'

export interface VirtualAnchor {
  /** 段 id（`seg:<首条可见消息 id>`） */
  id: string
  /** 捕获时的视口 top（getBoundingClientRect().top） */
  top: number
  index: number
  scrollTop: number
  scrollHeight: number
}

export interface VirtualChatOptions {
  /** 滚动容器（AI 页的 `.msgs`） */
  scroller: Ref<HTMLElement | null>
  /** spacer + 段所在的普通流容器 */
  body: Ref<HTMLElement | null>
  segments: ComputedRef<ChatSegment[]>
  chatId: ComputedRef<string>
  /** 用户手动展开过过程区的消息 id（影响未测量段的估算） */
  expandedIds?: ComputedRef<ReadonlySet<string>>
  /** 需要强制保留在窗口内的段（焦点 / 长按菜单 / 工具抽屉） */
  pinnedIds?: ComputedRef<readonly string[]>
  overscan?: number
  hasMoreBefore?: ComputedRef<boolean>
  hasMoreAfter?: ComputedRef<boolean>
  onLoadOlder?: () => void
  onLoadNewer?: () => void
}

export interface VirtualChat {
  visibleSegments: ComputedRef<ChatSegment[]>
  topSpacer: ComputedRef<number>
  bottomSpacer: ComputedRef<number>
  totalHeight: ComputedRef<number>
  windowStart: ComputedRef<number>
  windowEnd: ComputedRef<number>
  heightVersion: Ref<number>
  setSegmentEl(id: string, el: HTMLElement | null): void
  measure(): void
  invalidate(segmentId: string): void
  invalidateMessage(messageId: string): void
  captureAnchor(): VirtualAnchor | null
  restoreAnchor(anchor: VirtualAnchor | null): Promise<void>
  scrollToSegment(segmentId: string): Promise<boolean>
  scrollToMessage(messageId: string, opts?: { highlight?: boolean }): Promise<string | null>
  /** passes：吸底重试帧数（流式逐 token 传 1，收尾默认 3） */
  scrollToBottom(passes?: number): Promise<void>
  scrollToTop(): Promise<void>
  suspendScroll(): void
  resumeScroll(): void
  dispose(): void
}

const DEFAULT_OVERSCAN = 3
const OVERSCAN_PX_PER_ROW = 48
/** pin 距离窗口太远时放弃并入，避免一次渲染上千段 */
const MAX_PIN_DISTANCE = 40
const LOAD_TRIGGER_TOP = 200
const LOAD_TRIGGER_BOTTOM = 240
const LOAD_COOLDOWN_MS = 350

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

export function useVirtualChat(options: VirtualChatOptions): VirtualChat {
  const { scroller, body, segments, chatId } = options
  const overscan = Math.max(0, options.overscan ?? DEFAULT_OVERSCAN)

  const heights = reactive(new Map<string, number>())
  const heightVersion = ref(0)
  const scrollTop = ref(0)
  const viewportHeight = ref(0)
  const viewportWidth = ref(0)
  const bodyOffset = ref(0)
  const topInset = ref(0)
  /** 跳转时临时保留的目标段（避免估算误差让目标落在窗口外） */
  const anchorHold = ref<string | null>(null)

  const contentWidth = computed(() => Math.max(240, viewportWidth.value - 32))

  /** 估算缓存：offsets 每帧会遍历全部段，段对象不变时不必重算文本行数 */
  const estimateCache = new WeakMap<ChatSegment, { width: number; expanded: number; height: number }>()

  function estimateOf(seg: ChatSegment): number {
    const exp = options.expandedIds?.value
    const expanded = exp && seg.messages.some((m) => exp.has(m.id)) ? 1 : 0
    const cached = estimateCache.get(seg)
    if (cached && cached.width === contentWidth.value && cached.expanded === expanded) return cached.height
    const height = estimateSegmentHeight(seg, contentWidth.value, exp)
    estimateCache.set(seg, { width: contentWidth.value, expanded, height })
    return height
  }

  function heightOf(seg: ChatSegment): number {
    const cached = heights.get(seg.id)
    if (cached != null) return cached
    return estimateOf(seg)
  }

  /** 前缀和：offsets[i] = 段 i 的顶部；offsets[n] = 总高 */
  const offsets = computed<number[]>(() => {
    // 读 version 以便 delete/清空时即使 Map 引用不变也重算
    heightVersion.value
    const segs = segments.value
    const out = new Array<number>(segs.length + 1)
    out[0] = 0
    for (let i = 0; i < segs.length; i++) out[i + 1] = (out[i] ?? 0) + heightOf(segs[i]!)
    return out
  })

  const totalHeight = computed(() => offsets.value[offsets.value.length - 1] ?? 0)

  const indexById = computed(() => {
    const map = new Map<string, number>()
    segments.value.forEach((s, i) => map.set(s.id, i))
    return map
  })

  /** 二分：第一个 bottom > y 的下标（前缀和上的 lowerBound） */
  const firstIndex = computed(() => {
    const n = segments.value.length
    if (n === 0) return 0
    const offs = offsets.value
    const y = Math.max(0, scrollTop.value - bodyOffset.value)
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((offs[mid + 1] ?? 0) <= y) lo = mid + 1
      else hi = mid
    }
    return lo
  })

  const windowRange = computed(() => {
    const n = segments.value.length
    if (n === 0) return { start: 0, end: 0 }
    const offs = offsets.value
    const first = firstIndex.value
    let start = Math.max(0, first - overscan)
    const target = Math.max(0, scrollTop.value - bodyOffset.value) + Math.max(1, viewportHeight.value) + overscan * OVERSCAN_PX_PER_ROW
    let end = start
    while (end < n && (offs[end] ?? 0) < target) end++
    if (end <= first) end = Math.min(n, first + 1)

    const pins = [...(options.pinnedIds?.value ?? [])]
    if (anchorHold.value) pins.push(anchorHold.value)
    for (const id of pins) {
      const i = indexById.value.get(id)
      if (i == null) continue
      if (i < start) {
        if (start - i <= MAX_PIN_DISTANCE) start = i
      } else if (i >= end) {
        if (i - end <= MAX_PIN_DISTANCE) end = i + 1
      }
    }
    return { start, end: Math.min(n, end) }
  })

  const windowStart = computed(() => windowRange.value.start)
  const windowEnd = computed(() => windowRange.value.end)
  const visibleSegments = computed(() => segments.value.slice(windowStart.value, windowEnd.value))

  const topSpacer = computed(() => offsets.value[windowStart.value] ?? 0)
  const bottomSpacer = computed(() => {
    const offs = offsets.value
    return Math.max(0, (offs[offs.length - 1] ?? 0) - (offs[windowEnd.value] ?? 0))
  })

  /* ---------- 元素测量 ---------- */

  const segEls = new Map<string, HTMLElement>()
  const elToSeg = new WeakMap<Element, string>()
  let ro: ResizeObserver | null = null

  function ensureObserver(): ResizeObserver | null {
    if (typeof ResizeObserver === 'undefined') return null
    if (!ro) {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const id = elToSeg.get(entry.target)
          if (id) onSegmentResize(id, entry.target as HTMLElement)
        }
      })
    }
    return ro
  }

  function setSegmentEl(id: string, el: HTMLElement | null): void {
    const prev = segEls.get(id)
    if (prev === (el ?? undefined)) return
    if (prev) {
      ro?.unobserve(prev)
      elToSeg.delete(prev)
      segEls.delete(id)
    }
    if (!el) return
    segEls.set(id, el)
    elToSeg.set(el, id)
    ensureObserver()?.observe(el)
  }

  function onSegmentResize(id: string, el: HTMLElement): void {
    const h = el.getBoundingClientRect().height
    if (!Number.isFinite(h) || h <= 0) return
    // 切会话后旧段的 ResizeObserver 回调可能晚到：id 已不在当前 segments 里，
    // 这时 heights 与 persistHeight 都属于新会话，写进去就是串会话的缓存污染。
    const segIndex = indexById.value.get(id)
    if (segIndex == null) return
    const old = heights.get(id)
    const seg = segments.value[segIndex]
    const previous = old ?? (seg ? estimateOf(seg) : h)
    if (old != null && Math.abs(previous - h) <= 0.5) return
    // 是否在视口上方必须看 DOM 矩形，不能只看 segIndex < firstIndex：
    // 前插页加载期间 scrollTop.value 还是旧值，firstIndex 会过小，把真正在上方的
    // 段判成「视口内」，估算高度换成实测值后 spacer 变化、可见内容被顶走（实测 38px）。
    const sc = scroller.value
    const aboveViewport = sc
      ? el.getBoundingClientRect().bottom <= sc.getBoundingClientRect().top + 1
      : segIndex < firstIndex.value
    heights.set(id, Math.round(h * 100) / 100)
    heightVersion.value++
    const cid = chatId.value
    if (cid) persistHeight(cid, id, h)
    // 视口上方的段长高/缩短（含首次实测相对估算的偏差）要同步补偿 scrollTop，
    // 否则可见内容会被顶走一截。段在视口内或下方时不补偿（流式吸底由页面负责）。
    if (aboveViewport && Math.abs(h - previous) > 0.5) {
      if (sc) sc.scrollTop += h - previous
    }
  }

  /* ---------- 滚动窗口 ---------- */

  let rafId = 0
  let suspendCount = 0
  let lastOlderAt = 0
  let lastNewerAt = 0

  function syncScroll(): void {
    const sc = scroller.value
    if (!sc) return
    scrollTop.value = sc.scrollTop
    viewportHeight.value = sc.clientHeight
    viewportWidth.value = sc.clientWidth
  }

  /** 清空内存高度并读当前宽度桶/字体档的缓存（跨桶时旧值不再可信） */
  function reloadHeights(id: string): void {
    flushHeights()
    heights.clear()
    if (id) {
      for (const [segId, h] of loadHeights(id)) heights.set(segId, h)
    }
    heightVersion.value++
  }

  function widthBucketOf(width: number): number {
    return Math.max(320, Math.round((width || 360) / 80) * 80)
  }

  function measure(): void {
    const sc = scroller.value
    if (!sc) return
    const prevWidth = viewportWidth.value
    viewportHeight.value = sc.clientHeight
    viewportWidth.value = sc.clientWidth
    scrollTop.value = sc.scrollTop
    const b = body.value
    if (b) {
      const sr = sc.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      // 不用 offsetTop：`.rubber-layer` 的 transform / 负外边距会让 offsetParent 不可靠
      const prevBodyOffset = bodyOffset.value
      bodyOffset.value = br.top - sr.top + sc.scrollTop
      // 顶部记忆卡是虚拟体之前的普通块：卡片出现/消失会改变 bodyOffset，
      // 内容整体上下平移。不补 scrollTop 的话，视口里的消息会硬跳（实测 38px）。
      // 初次测量（prev=0）不补，避免挂载时把已经吸底的位置再推走。
      const delta = bodyOffset.value - prevBodyOffset
      if (prevBodyOffset > 0 && Math.abs(delta) > 0.5) {
        const next = Math.max(0, sc.scrollTop + delta)
        if (Math.abs(next - sc.scrollTop) > 0.5) {
          sc.scrollTop = next
          scrollTop.value = next
        }
      }
    }
    const header = sc.querySelector('.page-header')
    topInset.value = header instanceof HTMLElement ? header.offsetHeight : 0
    if (prevWidth !== viewportWidth.value) {
      heightVersion.value++
      // 跨宽度桶：旧桶的实测高度不再可信，重新读当前桶（未渲染段用估算，渲染后由 RO 修正）
      if (prevWidth > 0 && widthBucketOf(prevWidth) !== widthBucketOf(viewportWidth.value)) {
        reloadHeights(chatId.value)
      }
    }
  }

  function maybeTriggerLoad(): void {
    const sc = scroller.value
    if (!sc) return
    const now = Date.now()
    const localTop = sc.scrollTop - bodyOffset.value
    if (
      options.hasMoreBefore?.value &&
      windowStart.value === 0 &&
      localTop > -40 &&
      localTop < LOAD_TRIGGER_TOP &&
      now - lastOlderAt > LOAD_COOLDOWN_MS
    ) {
      lastOlderAt = now
      options.onLoadOlder?.()
    }
    if (options.hasMoreAfter?.value) {
      const remain = sc.scrollHeight - sc.scrollTop - sc.clientHeight
      if (remain < LOAD_TRIGGER_BOTTOM && now - lastNewerAt > LOAD_COOLDOWN_MS) {
        lastNewerAt = now
        options.onLoadNewer?.()
      }
    }
  }

  function onScroll(): void {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      syncScroll()
      if (suspendCount > 0) return
      // syncScroll 改的是 ref，Vue 要等微任务才 patch DOM；同一帧里 loadOlder 的
      // captureAnchor 会看到「旧 DOM + 新窗口」并抓到视口外的段，导致前插后
      // scrollTop 补偿到错误位置、甚至连续加载完整部历史。推迟一帧再判定。
      requestAnimationFrame(() => {
        if (suspendCount === 0) maybeTriggerLoad()
      })
    })
  }

  function onWindowResize(): void {
    measure()
  }

  let attachedScroller: HTMLElement | null = null

  function attach(): void {
    const sc = scroller.value
    if (!sc || sc === attachedScroller) return
    detach()
    attachedScroller = sc
    sc.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onWindowResize, { passive: true })
    ensureObserver()
    measure()
    // 字体/布局稳定后再量一次（WebView 首帧字体可能晚到）
    void nextTick(() => {
      measure()
      requestAnimationFrame(() => measure())
    })
  }

  function detach(): void {
    if (!attachedScroller) return
    attachedScroller.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onWindowResize)
    attachedScroller = null
  }

  /* ---------- 高度缓存随会话切换 ---------- */

  watch(
    chatId,
    (id) => {
      reloadHeights(id)
      void nextTick(() => measure())
    },
    { immediate: true },
  )

  // 段消失（撤回 / 空占位 splice）时不主动删高度：缓存以段 id 为键，
  // 重新加载历史页时同一个 id 还能直接复用；容量由 heightCache 的 2000 条上限兜住。
  // 这里只保留「会话切换清空」，避免把已卸载页面的高度误当成当前页的数据。

  // 容器尺寸变化（例如记忆卡出现/消失）由页面调用 measure；这里兜住 scroller 晚挂载
  watch(scroller, () => attach(), { immediate: true })

  onMounted(() => {
    attach()
    measure()
  })

  onBeforeUnmount(() => {
    detach()
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    ro?.disconnect()
    ro = null
    segEls.clear()
    flushHeights()
  })

  /* ---------- 滚动 API ---------- */

  function invalidate(segmentId: string): void {
    // 已渲染的段不要删缓存：删了会退回估算高度，而尺寸没变化时 RO 不会再回调，
    // spacer 与真实 DOM 高度就永久对不上。直接按当前 DOM 重量一次即可；真正的高度
    // 变化（展开过渡 / 食物卡增删行）随后仍由 ResizeObserver 逐帧回写。
    const el = segEls.get(segmentId)
    if (el) {
      onSegmentResize(segmentId, el)
      return
    }
    if (heights.delete(segmentId)) {
      if (chatId.value) deleteHeight(chatId.value, segmentId)
      heightVersion.value++
    }
  }

  function invalidateMessage(messageId: string): void {
    const seg = segments.value.find((s) => s.messages.some((m) => m.id === messageId))
    if (seg) invalidate(seg.id)
  }

  function captureAnchor(): VirtualAnchor | null {
    const sc = scroller.value
    if (!sc) return null
    const scTop = sc.getBoundingClientRect().top
    const scBottom = scTop + sc.clientHeight
    // 必须按「DOM 里真实挂着且与视口相交」的段取，不能只看 windowRange：翻页触发的
    // rAF 里 computed 窗口已经指向新位置，但 DOM 还是旧窗口（Vue 尚未 patch）。拿新的
    // 段 id 去查旧 DOM 会全部落空 → anchor=null → 前插后不补偿 scrollTop，
    // 视口留在顶部又触发下一页，最后一口气加载完整部历史。
    let best: VirtualAnchor | null = null
    for (const [id, el] of segEls) {
      if (!el.isConnected) continue
      const rect = el.getBoundingClientRect()
      if (rect.bottom <= scTop + 1 || rect.top >= scBottom - 1) continue
      if (best && rect.top >= best.top) continue
      const index = indexById.value.get(id)
      if (index == null) continue
      best = { id, top: rect.top, index, scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight }
    }
    return best
  }

  async function restoreAnchor(anchor: VirtualAnchor | null): Promise<void> {
    if (!anchor) return
    await nextTick()
    await nextFrame()
    measure()
    const sc = scroller.value
    if (!sc) return

    const apply = (): void => {
      const el = segEls.get(anchor.id)
      if (el) {
        const delta = el.getBoundingClientRect().top - anchor.top
        if (Math.abs(delta) > 0.5) sc.scrollTop += delta
        return
      }
      const idx = indexById.value.get(anchor.id)
      if (idx != null) {
        const scTop = sc.getBoundingClientRect().top
        sc.scrollTop = Math.max(0, bodyOffset.value + (offsets.value[idx] ?? 0) - (anchor.top - scTop))
        return
      }
      if (anchor.scrollHeight > 0) {
        sc.scrollTop = Math.max(0, anchor.scrollTop + (sc.scrollHeight - anchor.scrollHeight))
      }
    }

    apply()
    await nextFrame()
    syncScroll()
    apply()
    await nextFrame()
    measure()
    // measure() 会把新挂载段的估算高度换成实测值，offsets 随之变化；而 spacer 里的
    // 未挂载段仍用估算，锚点的内容偏移会和 offsets 差几十像素。多对几帧，直到
    // 锚点的 DOM top 稳定（实测前插一页的残差约 38px）。
    for (let i = 0; i < 3; i++) {
      await nextFrame()
      apply()
    }
  }

  async function scrollToSegment(segmentId: string): Promise<boolean> {
    const idx = indexById.value.get(segmentId)
    if (idx == null) return false
    anchorHold.value = segmentId
    suspendScroll()
    try {
      const sc = scroller.value
      if (!sc) return false
      measure()
      sc.scrollTop = Math.max(0, bodyOffset.value + (offsets.value[idx] ?? 0) - topInset.value - 8)
      scrollTop.value = sc.scrollTop
      await nextTick()
      await nextFrame()
      measure()
      const el = segEls.get(segmentId)
      if (el) {
        const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - topInset.value - 8
        if (Math.abs(delta) > 1) sc.scrollTop += delta
      }
      await nextFrame()
      measure()
      return true
    } finally {
      // 多等一帧：让 spacer 与实测高度稳定后再恢复滚动监听
      await nextFrame()
      anchorHold.value = null
      resumeScroll()
    }
  }

  async function scrollToMessage(messageId: string, _opts?: { highlight?: boolean }): Promise<string | null> {
    const direct = segments.value.find((s) => s.messages.some((m) => m.id === messageId))
    const seg = direct ?? segments.value.find((s) => s.anchorId === messageId) ?? null
    if (!seg) return null
    // absorbed 空壳不在 DOM 里：高亮目标退化为段内首条可见消息
    const targetId = direct ? messageId : (seg.messages[0]?.id ?? null)
    await scrollToSegment(seg.id)
    if (!targetId) return null

    await nextTick()
    await nextFrame()
    const sc = scroller.value
    const el = typeof document !== 'undefined' ? document.getElementById(`msg-${targetId}`) : null
    if (sc && el) {
      const wantTop = sc.getBoundingClientRect().top + topInset.value + 8
      const adjust = (): void => {
        const delta = el.getBoundingClientRect().top - wantTop
        if (Math.abs(delta) > 1) sc.scrollTop += delta
      }
      adjust()
      await nextFrame()
      adjust()
      await nextFrame()
      measure()
    }
    return targetId
  }

  async function scrollToBottom(passes = 3): Promise<void> {
    await nextTick()
    const sc = scroller.value
    if (!sc) return
    suspendScroll()
    try {
      // 估算高度在滚动过程中被实测替换，一次滚到底可能差一截：
      // 收尾（卡片/图片长高）用 3 帧；流式逐 token 只跑 1 帧，下一次事件会继续跟。
      const rounds = Math.max(1, Math.min(5, passes))
      for (let i = 0; i < rounds; i++) {
        sc.scrollTop = sc.scrollHeight
        await nextFrame()
        measure()
      }
      scrollTop.value = sc.scrollTop
    } finally {
      resumeScroll()
    }
  }

  async function scrollToTop(): Promise<void> {
    const sc = scroller.value
    if (!sc) return
    suspendScroll()
    try {
      sc.scrollTop = 0
      await nextFrame()
      measure()
    } finally {
      resumeScroll()
    }
  }

  function suspendScroll(): void {
    suspendCount++
  }

  function resumeScroll(): void {
    suspendCount = Math.max(0, suspendCount - 1)
    if (suspendCount === 0) syncScroll()
  }

  function dispose(): void {
    detach()
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    ro?.disconnect()
    ro = null
    segEls.clear()
    flushHeights()
  }

  return {
    visibleSegments,
    topSpacer,
    bottomSpacer,
    totalHeight,
    windowStart,
    windowEnd,
    heightVersion,
    setSegmentEl,
    measure,
    invalidate,
    invalidateMessage,
    captureAnchor,
    restoreAnchor,
    scrollToSegment,
    scrollToMessage,
    scrollToBottom,
    scrollToTop,
    suspendScroll,
    resumeScroll,
    dispose,
  }
}
