import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

import { motionOn } from '@/system/motion'

/**
 * 悬浮条拖拽停靠 · 手势与弹簧物理（组件无关，可单测）。
 *
 * 职责边界：本模块全权拥有元素的位置——外部只读槽位状态、绑定
 * onPointerDown 与 expandFromBlob；坐标一律以「中心点」表达，
 * 通过 translate3d 写到 posEl 上（left/top 恒为 0，避免与 CSS 布局打架）。
 *
 * 松手决策（设计稿）：|v| ≥ 0.35px/ms 视为轻弹，速度主轴定去向
 * （横向→左右方块并记住松手高度；纵向→顶/底）；慢速释放用
 * 投影法 p+v·180px 取最近槽位。settle 用可打断弹簧——飞行途中
 * 再次按下时以当前位置接管为新拖拽，速度不丢。
 *
 * 边缘避让：所有静止槽位收进 --safe-* 安全区内（Android 左右为
 * 返回手势带）；拖拽越界走橡皮筋阻尼而不是硬墙。
 */

export type DockSlot = 'bottom' | 'top' | 'left' | 'right'
export type DockForm = 'bar' | 'blob'

/* ---------- 手感参数（真机验证的调参入口都收在这里） ---------- */
const SLOP_PX = 8 // 点按 / 拖拽判定位移：按钮点击永远达不到
const FLICK_PXMS = 0.35 // 轻弹阈值 ≈350px/s
const PROJECTION_PX = 180 // 慢速释放投影：偏移 = v(px/ms) × 本值（=0.18s 折算）
const VELOCITY_WINDOW_MS = 100 // 速度采样窗口
const RUBBER_C = 0.55 // 橡皮筋刚度，越小越软
export const BLOB_SIZE = 64 // 方块边长：44px 无障碍下限之上刻意做大
const EDGE_GAP = 12 // 顶 / 底停靠的呼吸边距：顶部距安全区，底部距 Dock 上缘（--dock-top）
/** settle 弹簧（半隐式欧拉）：ζ≈0.87、ωn≈12.6rad/s ≈ Apple 式 0.48s/bounce0.16 */
const SPRING = { stiffness: 160, damping: 22 }
/** 默认持久化 key；多浮窗实例（运动条 / 录音条）各传各的，互不挤占停靠位 */
export const DOCK_STORAGE_KEY = 'rein.wbar.dock.v1'

interface Persist {
  slot: DockSlot
  /** 上一次的全宽条槽位（方块轻点展开回去的地方） */
  barSlot: 'bottom' | 'top'
  /** 方块纵向位置占可用区间的比例 0..1 */
  sideY: number
}

interface Metrics {
  vw: number
  vh: number
  safeL: number
  safeR: number
  safeT: number
  safeB: number
  tabH: number
}

type Sample = { t: number; x: number; y: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function loadPersist(key: string): Persist {
  const fallback: Persist = { slot: 'bottom', barSlot: 'bottom', sideY: 0.7 }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const p = JSON.parse(raw) as Partial<Persist>
    if (p.slot !== 'bottom' && p.slot !== 'top' && p.slot !== 'left' && p.slot !== 'right')
      return fallback
    return {
      slot: p.slot,
      barSlot: p.barSlot === 'top' ? 'top' : 'bottom',
      sideY: clamp(Number(p.sideY) || fallback.sideY, 0, 1),
    }
  } catch {
    return fallback
  }
}

function numToken(name: string, fb: number): number {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(n) ? n : fb
}

/* 探针法度量安全区：--safe-* 是含 env()/max() 的表达式，JS 读不出像素，
   用一个隐藏定点元素分别按左上 / 右下锚定后量 rect，一次拿齐四向真实值。 */
let probeEl: HTMLDivElement | null = null
function probeMetrics(): Metrics {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!probeEl) {
    probeEl = document.createElement('div')
    probeEl.setAttribute('aria-hidden', 'true')
    const s = probeEl.style
    s.position = 'fixed'
    s.width = '0'
    s.height = '0'
    s.visibility = 'hidden'
    s.pointerEvents = 'none'
    document.documentElement.appendChild(probeEl)
  }
  const s = probeEl.style
  s.left = 'var(--safe-left)'
  s.top = 'var(--safe-top)'
  s.right = 'auto'
  s.bottom = 'auto'
  const tl = probeEl.getBoundingClientRect()
  s.left = 'auto'
  s.top = 'auto'
  s.right = 'var(--safe-right)'
  s.bottom = 'var(--safe-bottom)'
  const br = probeEl.getBoundingClientRect()
  const safeB = Math.max(0, vh - br.bottom)
  // 底部让位区 = Dock 的**上缘**到视口底。直接探 --dock-top（全应用统一口径：
  // 安全区 + 悬浮距 --dock-float + Dock 高，输入行显隐由 html[data-dock-quick]
  // 改写，observer 会跟着重落位）。
  // 从前这里拼 --tabbar-h + --dock-quick-h，漏掉了 Dock 离底的悬浮距 16px ——
  // 浮条停底时反而扎进 Dock 上沿约 4px（412×915 截图实测：浮条底边压在 Dock
  // 玻璃上缘之下），看起来就是「浮条与 Dock 之间没有 gap」。
  s.left = '0'
  s.top = 'auto'
  s.right = 'auto'
  s.bottom = 'var(--dock-top)'
  const dockTop = probeEl.getBoundingClientRect().top
  return {
    vw,
    vh,
    safeL: tl.left,
    safeT: tl.top,
    safeR: Math.max(0, vw - br.right),
    safeB,
    // tabH 与 safeB 在下方按「safeB + tabH = Dock 上缘离底距离」相加使用
    tabH: Math.max(0, vh - dockTop - safeB),
  }
}

export function useDragDock(posEl: Ref<HTMLElement | null>, options?: { storageKey?: string }) {
  const storageKey = options?.storageKey ?? DOCK_STORAGE_KEY
  const saved = loadPersist(storageKey)

  const slot = ref<DockSlot>(saved.slot)
  const barSlot = ref<'bottom' | 'top'>(saved.barSlot)
  const sideYFrac = ref(saved.sideY)
  const pressing = ref(false)
  const dragging = ref(false)
  /** 方块轻点展开回全宽条（模板层绑定） */
  function expandFromBlob(): void {
    if (form.value === 'blob') void dockTo(barSlot.value, 0, 0)
  }

  const form = computed<DockForm>(() =>
    slot.value === 'left' || slot.value === 'right' ? 'blob' : 'bar',
  )

  /* ---------- 几何 ---------- */
  let M: Metrics = probeMetrics()
  let cx = M.vw / 2
  let cy = M.vh / 2
  let curW = 0
  let curH = 0
  let placed = false

  function barWidth(m: Metrics = M): number {
    return Math.min(m.vw - 24, numToken('--frame-max', 480) - 24)
  }

  /** 实测当前渲染尺寸（拖拽 / 按压缩放期间不准，只在静止时调用） */
  function measureSize(): { w: number; h: number } {
    const el = posEl.value
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height }
    }
    if (form.value === 'blob') return { w: BLOB_SIZE, h: BLOB_SIZE }
    return { w: barWidth(), h: 58 }
  }

  function sideYRange(m: Metrics): { lo: number; hi: number } {
    const half = BLOB_SIZE / 2 + EDGE_GAP
    return {
      lo: m.safeT + half,
      hi: m.vh - (m.safeB + m.tabH) - half,
    }
  }

  function slotCenter(s: DockSlot, m: Metrics = M): { x: number; y: number } {
    const tabZone = m.safeB + m.tabH
    switch (s) {
      case 'bottom':
        return { x: m.vw / 2, y: m.vh - tabZone - EDGE_GAP - curH / 2 }
      case 'top':
        return { x: m.vw / 2, y: m.safeT + EDGE_GAP + curH / 2 }
      case 'left':
      case 'right': {
        const { lo, hi } = sideYRange(m)
        return {
          x: s === 'left' ? m.safeL + BLOB_SIZE / 2 : m.vw - m.safeR - BLOB_SIZE / 2,
          y: lo + sideYFrac.value * Math.max(0, hi - lo),
        }
      }
    }
  }

  /** 拖拽活动范围（以元素中心表达：槽位中心都落在界内，越界部分交给橡皮筋）。
   *  条形态宽近整屏时左右可能没余量（x0 ≥ x1），该轴退化——调用方锁死不滑，
   *  且避免倒置区间让橡皮筋按 span=1 硬吞到边界（表现为抓取瞬间横跳半屏）。 */
  function bounds(w = curW, h = curH): { x0: number; x1: number; y0: number; y1: number } {
    return {
      x0: M.safeL + w / 2,
      x1: M.vw - M.safeR - w / 2,
      y0: M.safeT + EDGE_GAP + h / 2,
      y1: M.vh - (M.safeB + M.tabH) - EDGE_GAP - h / 2,
    }
  }

  function writePos(): void {
    const el = posEl.value
    if (el) el.style.transform = `translate3d(${cx - curW / 2}px, ${cy - curH / 2}px, 0)`
  }

  function syncSize(): void {
    const s = measureSize()
    curW = s.w
    curH = s.h
  }

  function placeInstant(): void {
    refreshMetrics()
    syncSize()
    const c = slotCenter(slot.value)
    cx = c.x
    cy = c.y
    writePos()
    placed = true
  }

  function refreshMetrics(): void {
    M = probeMetrics()
  }

  /* ---------- 弹簧 settle（可被打断，速度继承） ---------- */
  let raf = 0
  let settling = false
  let svx = 0
  let svy = 0

  function stopSpring(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    settling = false
    svx = 0
    svy = 0
  }

  function startSpring(tx: number, ty: number, vx: number, vy: number, done?: () => void): void {
    stopSpring()
    settling = true
    svx = vx
    svy = vy
    let last = performance.now()
    let calm = 0
    const step = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.032)
      last = now
      svx += (SPRING.stiffness * (tx - cx) - SPRING.damping * svx) * dt
      svy += (SPRING.stiffness * (ty - cy) - SPRING.damping * svy) * dt
      cx += svx * dt
      cy += svy * dt
      writePos()
      if (
        Math.abs(tx - cx) < 0.15 &&
        Math.abs(ty - cy) < 0.15 &&
        Math.hypot(svx, svy) < 8 &&
        ++calm >= 2
      ) {
        cx = tx
        cy = ty
        writePos()
        stopSpring()
        done?.()
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  /** 切换槽位并飞过去；形态切换先落 DOM 再量尺寸，保证中心算准 */
  async function dockTo(next: DockSlot, vxPms: number, vyPms: number): Promise<void> {
    stopSpring()
    slot.value = next
    if (next === 'bottom' || next === 'top') barSlot.value = next
    await nextTick()
    refreshMetrics()
    syncSize()
    const t = slotCenter(next)
    if (!motionOn.value) {
      cx = t.x
      cy = t.y
      writePos()
      persist()
      return
    }
    startSpring(t.x, t.y, vxPms * 1000, vyPms * 1000, persist)
  }

  function persist(): void {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          slot: slot.value,
          barSlot: barSlot.value,
          sideY: Math.round(sideYFrac.value * 1000) / 1000,
        }),
      )
    } catch {
      /* 私隐模式等存储不可用：泊车位置不持久化即可 */
    }
  }

  /* ---------- 指针手势 ---------- */
  let activeId: number | null = null
  let startX = 0
  let startY = 0
  let grabDX = 0
  let grabDY = 0
  let samples: Sample[] = []

  function pushSample(t: number, x: number, y: number): void {
    samples.push({ t, x, y })
    const cut = t - VELOCITY_WINDOW_MS
    while (samples.length > 2 && samples[0].t < cut) samples.shift()
  }

  function sampleVelocity(): { vx: number; vy: number } {
    if (samples.length < 2) return { vx: 0, vy: 0 }
    const a = samples[0]
    const b = samples[samples.length - 1]
    const dt = b.t - a.t
    if (dt <= 0) return { vx: 0, vy: 0 }
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt }
  }

  /** 橡皮筋：界外位移按 iOS 同式衰减，越拉越紧 */
  function rubber(raw: number, lo: number, hi: number, span: number): number {
    if (raw < lo) return lo - resist(lo - raw, span)
    if (raw > hi) return hi + resist(raw - hi, span)
    return raw
  }

  function resist(x: number, span: number): number {
    const d = Math.max(span, 1)
    return d * (1 - 1 / ((x * RUBBER_C) / d + 1))
  }

  function onPointerDown(e: PointerEvent): void {
    if (activeId !== null) return // 多指保护：拖拽中忽略第二根手指
    activeId = e.pointerId
    startX = e.clientX
    startY = e.clientY
    samples = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }]
    pressing.value = true
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  function detach(): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
  }

  /** 越过 slop 才算真正抓住：此前松手是点按，原生 click 照常触发 */
  function engage(e: PointerEvent): void {
    // 以渲染实况重基准，保证任何异常时序下抓取瞬间零跳变：
    // 按下时 body 是 scale(0.97)，但尺测的是 posEl 盒，不受子级 transform 影响；
    // rect 中心在均匀缩放下不变，故这里可安全取真值。
    syncSize()
    const el = posEl.value
    if (el) {
      const r = el.getBoundingClientRect()
      cx = r.left + r.width / 2
      cy = r.top + r.height / 2
    }
    pressing.value = false
    dragging.value = true
    if (settling) stopSpring() // 飞行途中接住：以当前位置接管，速度由新的采样接管
    grabDX = cx - e.clientX
    grabDY = cy - e.clientY
    armClickSwallow()
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== activeId) return
    pushSample(e.timeStamp, e.clientX, e.clientY)
    if (!dragging.value) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= SLOP_PX) return
      engage(e)
    }
    const b = bounds()
    if (b.x1 > b.x0) cx = rubber(e.clientX + grabDX, b.x0, b.x1, b.x1 - b.x0)
    if (b.y1 > b.y0) cy = rubber(e.clientY + grabDY, b.y0, b.y1, b.y1 - b.y0)
    writePos()
  }

  function finish(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerId !== activeId) return
    detach()
    activeId = null
    pressing.value = false
    const wasDragging = dragging.value
    dragging.value = false
    if (!wasDragging) return // 点按：交给原生 click
    if (cancelled) {
      void dockTo(nearestSlot(cx, cy), 0, 0)
      return
    }
    const { vx, vy } = sampleVelocity()
    void dockTo(solveRelease(cx, cy, vx, vy), vx, vy)
  }

  function onUp(e: PointerEvent): void {
    finish(e, false)
  }

  function onCancel(e: PointerEvent): void {
    finish(e, true)
  }

  /* ---------- 松手解算 ---------- */
  function solveRelease(px: number, py: number, vx: number, vy: number): DockSlot {
    if (Math.hypot(vx, vy) >= FLICK_PXMS) {
      // 轻弹：速度主轴决定去向
      if (Math.abs(vx) > Math.abs(vy)) {
        sideYFrac.value = yToSideY(py)
        return vx > 0 ? 'right' : 'left'
      }
      return vy > 0 ? 'bottom' : 'top'
    }
    return nearestSlot(px, py, vx, vy)
  }

  /** 慢放：投影 p+v·PROJECTION 后取最近槽位 */
  function nearestSlot(px: number, py: number, vx = 0, vy = 0): DockSlot {
    const jx = px + vx * PROJECTION_PX
    const jy = py + vy * PROJECTION_PX
    const sideY = yToSideY(jy)
    const cands: Array<{ s: DockSlot; d: number }> = []
    for (const s of ['bottom', 'top', 'left', 'right'] as const) {
      const save = sideYFrac.value
      sideYFrac.value = sideY
      const c = slotCenter(s)
      sideYFrac.value = save
      cands.push({ s, d: (c.x - jx) ** 2 + (c.y - jy) ** 2 })
    }
    const best = cands.reduce((a, b) => (b.d < a.d ? b : a))
    if (best.s === 'left' || best.s === 'right') sideYFrac.value = sideY
    return best.s
  }

  function yToSideY(y: number): number {
    const { lo, hi } = sideYRange(M)
    if (hi <= lo) return 0
    return clamp((y - lo) / (hi - lo), 0, 1)
  }

  /* ---------- 拖拽后的幽灵点击吞咽（防止松手误触按钮） ---------- */
  let swallowArmedAt = 0
  function armClickSwallow(): void {
    swallowArmedAt = Date.now()
    document.addEventListener('click', onClickSwallow, { capture: true, once: true })
  }

  function onClickSwallow(e: MouseEvent): void {
    // 只吞抓取后短暂窗口内的那次 click；迟到的旧监听直接放行
    if (Date.now() - swallowArmedAt < 400) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  /* ---------- 生命周期 ---------- */
  function onResize(): void {
    if (!placed) return
    refreshMetrics()
    if (dragging.value) return // 下一次 move 会按新边界收敛
    if (settling) {
      const t = slotCenter(slot.value)
      startSpring(t.x, t.y, svx, svy)
      return
    }
    syncSize()
    const c = slotCenter(slot.value)
    cx = c.x
    cy = c.y
    writePos()
  }

  // 落位时机：浮条元素可能迟于 composable 挂载才渲染（view 从空到有——
  // 冷启动恢复即如此；或视图重挂载，且 transform 不跨卸载保留）。
  // 元素一出现就藏一帧、落在持久化槽位再显示，避免 (0,0) 闪现；
  // 重挂载时先停掉可能遗留的飞行。
  watch(
    posEl,
    (el) => {
      if (!el) return
      stopSpring()
      el.style.visibility = 'hidden'
      void nextTick(() => {
        if (posEl.value !== el) return
        placeInstant()
        el.style.visibility = ''
      })
    },
    { flush: 'post' },
  )

  // 底栏输入行显隐（TabBar 写 <html data-dock-quick>）改变 Dock 实际占高：
  // 已停靠的浮条要跟着重落位，否则导航一次就被长高了的 Dock 盖进里面。
  // 拖拽 / 弹簧飞行中不抢（落位以结束态为准，弹簧 settle 自己会取新度量）。
  let quickObserver: MutationObserver | null = null

  onMounted(() => {
    window.addEventListener('resize', onResize)
    quickObserver = new MutationObserver(() => {
      if (dragging.value || settling) return
      if (!placed) return
      refreshMetrics()
      syncSize()
      const c = slotCenter(slot.value)
      cx = c.x
      cy = c.y
      writePos()
    })
    quickObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-dock-quick'],
    })
  })

  onBeforeUnmount(() => {
    quickObserver?.disconnect()
    quickObserver = null
    detach()
    stopSpring()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('click', onClickSwallow, { capture: true })
  })

  return {
    slot,
    form,
    barSlot,
    sideYFrac,
    pressing,
    dragging,
    onPointerDown,
    expandFromBlob,
  }
}
