import { onBeforeUnmount, ref, type Ref } from 'vue'

/* ============================================================
   导航条目拖拽换位（不引库）—— 手势骨架从 useBentoDrag（useBentoLayout.ts）泛化：
   pointerdown 只登记，位移越过 8px slop 才算抓住（此前松手仍是点按）；抓住后
   setPointerCapture，event 一直回到把手；落点靠 elementFromPoint 找目标条目，
   越过它中线就当场改顺序（live reorder）；松手吞掉随后一次 click（幽灵点击）；
   Esc 取消 —— 行为与便当拖拽完全同手感。

   与便当的两处差别：
   - **不给被拖项做绝对定位、也不做 translate 幽灵**：条目就是它自己的盒子
     （药丸 / 图标格 / 窗控钮），被拖项原地不动、顺序在指针越过邻项中线时实时变化 ——
     底部 Dock 的三块玻璃被画质预览页当标本逐像素比对（e2e-perf-glass），编辑态的
     任何位移都会把标本比对打红；live reorder 只改渲染顺序，玻璃几何零改动。
   - 取消走 snapshot/restore 回调：顺序变更落在 useNavEdit 的草稿里（内存态），
     Esc / pointercancel 把草稿回滚到按下前 —— 与便当「取消恢复快照」同语义，
     但不落盘（草稿从未到 localStorage）。

   容器侧的三条契约：
   1. 条目统一带 `data-nav-id` 属性（对应便当的 data-bento-id），把手绑定
      `onHandleDown(e, id)`，只在编辑态绑定；
   2. 拖拽面（Dock 药丸行 / rail 的 .navs 簇 / 顶栏按钮行）在**编辑态**声明
      `touch-action: none` —— base.css 给文档滚动层的全局手势是 pan-x pan-y，
      不前置这条，安卓上指针事件会被滚动链接管成 pointercancel，拖拽永不触发
      （BentoOverview 的抓柄同理）；非编辑态不挂，页面滚动照旧；
   3. move/snapshot/restore 由容器接到 useNavEdit 的草稿上（见 useNavEdit.ts）。
   ============================================================ */

const SLOP_PX = 8
/** 拖后吞 click 的窗口：与 useBentoDrag / useDragDock 同值 */
const CLICK_SWALLOW_MS = 400
/** 拖到滚动容器上下缘多少像素内开始自动滚（列表比一屏高时才用得上） */
const EDGE_BAND = 56
const EDGE_SPEED = 14

export interface NavDragApi {
  /** 正在被拖的条目 id（null = 没在拖）。容器用它给被拖项挂临时态样式 */
  dragId: Ref<string | null>
  /** 条目的把手按下（一般是条目根元素本身）：编辑态绑定，非编辑态不绑 */
  onHandleDown: (e: PointerEvent, id: string) => void
}

export function useNavDrag(options: {
  /** 条目所在容器（找条目、找滚动宿主） */
  listEl: Ref<HTMLElement | null>
  /** 当前顺序（草稿 id 序） */
  orderIds: () => string[]
  /** 换位：容器接到 useNavEdit.moveInDraft（固定件边界由它钳制） */
  move: (id: string, to: number) => void
  /** 拖拽开始前的顺序快照（Esc / pointercancel 取消时用它回滚） */
  snapshot: () => string[]
  /** 回滚到快照 */
  restore: (ids: string[]) => void
}): NavDragApi {
  const dragId = ref<string | null>(null)

  let pointerId: number | null = null
  let pendingId: string | null = null
  let startX = 0
  let startY = 0
  let snap: string[] | null = null
  let prevUserSelect = ''
  let scrollRaf = 0
  let scrollHostEl: HTMLElement | null = null
  /** 抓住那一刻宿主真实的滚动上限（拖拽中滚动位置夹在这里，见 useBentoDrag 的注释） */
  let scrollLimit = 0
  let pointerY = 0

  /** 最近的可滚动祖先（桌面下就是 .desk-main）：自动滚的宿主 */
  function findScrollHost(): HTMLElement | null {
    let el: HTMLElement | null = options.listEl.value
    while (el) {
      const cs = getComputedStyle(el)
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) return el
      el = el.parentElement
    }
    return null
  }

  /* ---------- 自动滚：拖到滚动容器上下缘时按帧推（与 useBentoDrag 同一套夹子） ---------- */
  function scrollStep(): void {
    scrollRaf = 0
    const host = scrollHostEl
    if (!host || dragId.value === null) return
    const r = host.getBoundingClientRect()
    const d =
      pointerY < r.top + EDGE_BAND
        ? pointerY - (r.top + EDGE_BAND)
        : pointerY > r.bottom - EDGE_BAND
          ? pointerY - (r.bottom - EDGE_BAND)
          : 0
    if (!d) return
    const step = (Math.max(-EDGE_BAND, Math.min(EDGE_BAND, d)) / EDGE_BAND) * EDGE_SPEED
    host.scrollTop = Math.max(0, Math.min(scrollLimit, host.scrollTop + step))
    scrollRaf = requestAnimationFrame(scrollStep)
  }

  function armEdgeScroll(): void {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(scrollStep)
  }

  function stopEdgeScroll(): void {
    if (scrollRaf) cancelAnimationFrame(scrollRaf)
    scrollRaf = 0
  }

  /* ---------- 幽灵点击：抓过之后的第一次 click 吞掉 ---------- */
  let swallowedAt = 0
  function armClickSwallow(): void {
    swallowedAt = Date.now()
    document.addEventListener('click', onClickSwallow, { capture: true, once: true })
  }

  function onClickSwallow(e: MouseEvent): void {
    if (Date.now() - swallowedAt < CLICK_SWALLOW_MS) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  /** 落点解算：指针下的那一项 + 越过它中线的哪一侧 → 插到它前/后（与便当同一套轴判定） */
  function dropTarget(px: number, py: number): number | null {
    const id = dragId.value
    if (!id) return null
    const hit = document.elementFromPoint(px, py)?.closest<HTMLElement>('[data-nav-id]')
    const over = hit?.dataset.navId
    if (!over || over === id) return null
    const others = options.orderIds().filter((x) => x !== id)
    const i = others.indexOf(over)
    if (i < 0) return null
    const r = hit!.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // 用「归一化后的偏移谁更大」定轴：同排邻居比 x、上下排邻居比 y
    const useX = Math.abs(px - cx) * Math.max(r.height, 1) > Math.abs(py - cy) * Math.max(r.width, 1)
    const after = useX ? px > cx : py > cy
    return after ? i + 1 : i
  }

  function engage(): void {
    const id = pendingId
    if (!id) return
    snap = options.snapshot()
    dragId.value = id
    scrollHostEl = findScrollHost()
    scrollLimit = scrollHostEl ? scrollHostEl.scrollHeight - scrollHostEl.clientHeight : 0
    prevUserSelect = document.body.style.userSelect
    // 拖过条目文字时不许选词：拖动期间整页禁选，松手还原（点按不受影响）
    document.body.style.userSelect = 'none'
    armClickSwallow()
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    if (dragId.value === null) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= SLOP_PX) return
      engage()
    }
    const id = dragId.value
    if (!id) return
    pointerY = e.clientY
    const to = dropTarget(e.clientX, e.clientY)
    if (to !== null) options.move(id, to)
    armEdgeScroll()
  }

  function finish(cancelled: boolean): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    stopEdgeScroll()
    scrollHostEl = null
    const id = dragId.value
    const wasDragging = id !== null
    pointerId = null
    pendingId = null
    dragId.value = null
    document.body.style.userSelect = prevUserSelect
    prevUserSelect = ''
    if (!wasDragging || !id) return
    if (cancelled && snap) options.restore(snap)
    snap = null
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    finish(false)
  }

  function onCancel(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    finish(true)
  }

  /** Esc 只取消进行中的拖拽（回滚到按下前的顺序），不退出编辑会话 —— useNavEdit 的不变量 */
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || dragId.value === null) return
    e.preventDefault()
    finish(true)
  }

  function onHandleDown(e: PointerEvent, id: string): void {
    if (e.button !== 0) return // 只认主键（右键/中键不抓）
    if (pointerId !== null) return // 多指保护：拖拽中忽略第二根手指
    pointerId = e.pointerId
    pendingId = id
    startX = e.clientX
    startY = e.clientY
    pointerY = e.clientY
    const handle = e.currentTarget as HTMLElement
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已失效等极端时序：事件仍沿元素冒泡到 window，手势照常走 */
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('click', onClickSwallow, { capture: true })
    stopEdgeScroll()
  })

  return { dragId, onHandleDown }
}
