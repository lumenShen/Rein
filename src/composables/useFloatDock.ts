import { onBeforeUnmount, ref, type Ref } from 'vue'
import { getCurrentWindow, LogicalPosition } from '@tauri-apps/api/window'

import { floatService } from '@/services/floatService'
import { motionOn } from '@/system/motion'
import { isTauriDesktopWindow } from '@/system/windowChrome'
import type { GlobalFloatForm } from '@/types'

/**
 * 全局浮窗 · 窗口级拖拽停靠（useDragDock 的 OS 窗口版，手感参数逐条同源）。
 *
 * 程序内浮条拖的是 DOM 元素（translate3d），这里拖的是**整扇 Tauri 窗口**（setPosition）：
 * 坐标一律以「窗口中心点」表达（逻辑像素），写位置时换算回左上角。为什么不用原生
 * drag region / startDragging：它们在 mousedown 就把指针让给系统移动循环，webview 再也
 * 收不到 pointermove —— 测不到速度，轻弹 / 投影 / 弹簧就全无从谈起。
 *
 * 松手决策与程序内同一份：|v| ≥ 0.35px/ms 视为轻弹，速度主轴定去向（横向→左右方块
 * 并记住松手高度；纵向→顶/底全宽条）；慢速释放用投影 p+v·180 取最近槽位。settle 用
 * 可打断弹簧，飞行途中再次按下以当前位置接管。越界走橡皮筋阻尼（当前显示器工作区为界）。
 *
 * 形态切换（bar↔blob）由 changeForm 回调落实（浮窗先直接改窗口尺寸再通知主窗口持久化）；
 * 槽位（slot/barSlot/sideY）持久化在 localStorage，跨重启按当前工作区重算 —— 与程序内
 * 浮条各停各位互不挤占（key 不同）。confirm 长高也在本模块锚定（底边不动、钳制进工作区）。
 */

export type FloatSlot = 'bottom' | 'top' | 'left' | 'right'

/* ---------- 手感参数（与 composables/useDragDock 同一份，改一处两处一起看） ---------- */
const SLOP_PX = 8 // 点按 / 拖拽判定位移：按钮点击永远达不到
const FLICK_PXMS = 0.35 // 轻弹阈值 ≈350px/s
const PROJECTION_PX = 180 // 慢速释放投影：偏移 = v(px/ms) × 本值
const VELOCITY_WINDOW_MS = 100 // 速度采样窗口
const RUBBER_C = 0.55 // 橡皮筋刚度，越小越软
const EDGE_GAP = 12 // 顶 / 底 / 侧边停靠距工作区的呼吸边距
const SPRING = { stiffness: 160, damping: 22 } // ζ≈0.87，与程序内同一组常量

/** 窗口形状尺寸（逻辑像素）—— 与 Rust FloatShape::size 逐字对齐（docs/GLOBAL-FLOAT.md §6.2） */
export const FLOAT_SIZE = {
  bar: { w: 430, h: 92 },
  card: { w: 360, h: 450 },
  blob: { w: 64, h: 64 },
  confirm: { w: 430, h: 172 },
} as const

/** 停靠槽位持久化 key（浮窗独占；程序内四条浮条各用各的 key） */
const STORAGE_KEY = 'rein.float.dock.v1'

interface Persist {
  slot: FloatSlot
  /** 上一次的全宽条槽位（方块轻点展开回去的地方） */
  barSlot: 'bottom' | 'top'
  /** 方块纵向位置占可用区间的比例 0..1 */
  sideY: number
}

interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

type Sample = { t: number; x: number; y: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function loadPersist(): Persist {
  const fallback: Persist = { slot: 'bottom', barSlot: 'bottom', sideY: 0.7 }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
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

export interface FloatDockOptions {
  /** 当前持久形态（FloatApp 持有，载荷回声会写它） */
  form: Ref<GlobalFloatForm>
  /** 切形态：先改窗口尺寸再通知主窗口持久化（FloatApp 提供，内部不抛） */
  changeForm: (next: GlobalFloatForm) => Promise<void>
  /** 此刻是否允许手势（桌面 + 有会话 + 非确认态） */
  active: Ref<boolean>
  /** 专注卡面：form 仍是 bar，但窗口实际是 360×450（停靠计算要按真实尺寸走） */
  card?: Ref<boolean>
}

export function useFloatDock(opts: FloatDockOptions) {
  const desktop = isTauriDesktopWindow
  const saved = loadPersist()

  const slot = ref<FloatSlot>(saved.slot)
  const barSlot = ref<'bottom' | 'top'>(saved.barSlot)
  const sideYFrac = ref(saved.sideY)
  const pressing = ref(false)
  const dragging = ref(false)

  /* ---------- 几何（中心点坐标，逻辑像素） ---------- */
  let work: WorkArea = { x: 0, y: 0, width: 0, height: 0 }
  let workKnown = false
  let cx = 0
  let cy = 0
  let posKnown = false
  /** confirm 长高期间的实际窗高（form 仍是 bar，尺寸却变了） */
  let heightOverride: number | null = null
  let confirmTall = false
  let preConfirmCy = 0

  function curSize(): { w: number; h: number } {
    if (opts.form.value === 'blob') return { w: FLOAT_SIZE.blob.w, h: heightOverride ?? FLOAT_SIZE.blob.h }
    const base = opts.card?.value ? FLOAT_SIZE.card : FLOAT_SIZE.bar
    return { w: base.w, h: heightOverride ?? base.h }
  }

  async function refreshWork(): Promise<void> {
    if (!desktop) return
    try {
      const w = await floatService.workArea()
      if (w.width > 0 && w.height > 0) {
        work = w
        workKnown = true
      }
    } catch {
      /* 读不到工作区：沿用旧值；从未读到过则跳过落位（窗口留在原处） */
    }
  }

  async function refreshPosition(): Promise<void> {
    if (!desktop) return
    try {
      const win = getCurrentWindow()
      const [p, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()])
      const { w, h } = curSize()
      cx = p.x / scale + w / 2
      cy = p.y / scale + h / 2
      posKnown = true
      // 异常时序下拖拽中途才拿到真位置：以最新指针重基准，避免下一帧横跳
      if (dragging.value) {
        grabDX = cx - lastX
        grabDY = cy - lastY
      }
    } catch {
      /* 窗口已销毁等：保持现有跟踪值 */
    }
  }

  function writePos(): void {
    if (!desktop || !posKnown) return
    const { w, h } = curSize()
    void getCurrentWindow()
      .setPosition(new LogicalPosition(cx - w / 2, cy - h / 2))
      .catch(() => {
        /* 权限缺失 / 窗口已销毁：这一下没拖动，不是报错 */
      })
  }

  /** 侧边槽位的纵向可用区间（中心点表达，方块尺寸） */
  function sideYRange(): { lo: number; hi: number } {
    const half = FLOAT_SIZE.blob.h / 2 + EDGE_GAP
    return { lo: work.y + half, hi: work.y + work.height - half }
  }

  function slotCenter(s: FloatSlot): { x: number; y: number } {
    const midX = work.x + work.width / 2
    switch (s) {
      case 'bottom':
        return { x: midX, y: work.y + work.height - EDGE_GAP - curSize().h / 2 }
      case 'top':
        return { x: midX, y: work.y + EDGE_GAP + curSize().h / 2 }
      case 'left':
      case 'right': {
        const { lo, hi } = sideYRange()
        const half = FLOAT_SIZE.blob.w / 2
        return {
          x: s === 'left' ? work.x + half : work.x + work.width - half,
          y: lo + sideYFrac.value * Math.max(0, hi - lo),
        }
      }
    }
  }

  /** 拖拽活动范围（中心点表达；条宽近半屏时左右余量小，越界交给橡皮筋） */
  function bounds(): { x0: number; x1: number; y0: number; y1: number } {
    const { w, h } = curSize()
    return {
      x0: work.x + w / 2,
      x1: work.x + work.width - w / 2,
      y0: work.y + EDGE_GAP + h / 2,
      y1: work.y + work.height - EDGE_GAP - h / 2,
    }
  }

  function persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          slot: slot.value,
          barSlot: barSlot.value,
          sideY: Math.round(sideYFrac.value * 1000) / 1000,
        }),
      )
    } catch {
      /* 存储不可用：停靠位置不持久化即可 */
    }
  }

  /* ---------- 弹簧 settle（可被打断，速度继承；与 useDragDock 同一积分器） ---------- */
  let raf = 0
  let svx = 0
  let svy = 0

  function stopSpring(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    svx = 0
    svy = 0
  }

  function startSpring(tx: number, ty: number, vx: number, vy: number, done?: () => void): void {
    stopSpring()
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

  /** 切换槽位并飞过去；形态切换先落尺寸再算中心，保证落位准 */
  async function dockTo(next: FloatSlot, vxPms: number, vyPms: number): Promise<void> {
    stopSpring()
    const nextForm: GlobalFloatForm = next === 'left' || next === 'right' ? 'blob' : 'bar'
    if (nextForm !== opts.form.value) {
      await opts.changeForm(nextForm)
      // set_size 锚定左上角：尺寸变了中心会偏，立刻按原中心写回一次，
      // 否则弹簧首帧才纠正，肉眼可见地跳一下（程序内浮条靠 nextTick 重算 transform 同理）
      writePos()
    }
    slot.value = next
    if (next === 'bottom' || next === 'top') barSlot.value = next
    await refreshWork()
    if (!workKnown) {
      persist()
      return
    }
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

  /* ---------- 指针手势 ---------- */
  let activeId: number | null = null
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0
  let grabDX = 0
  let grabDY = 0
  let samples: Sample[] = []
  let downEl: Element | null = null
  let dragWriteRaf = 0

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

  /** 橡皮筋：界外位移按 iOS 同式衰减，越拉越紧（与 useDragDock 同式） */
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
    if (!desktop || !opts.active.value || e.button !== 0) return
    if (activeId !== null) {
      if (dragging.value) return // 多指保护：拖拽中忽略第二根手指
      // 上一次按下在窗外松手（slop 前未捕获，收不到 pointerup）：清残局当新按下，
      // 否则小窗上这一次失手会让手势永久卡死
      detach()
      releaseCapture()
      activeId = null
      pressing.value = false
    }
    activeId = e.pointerId
    downEl = e.currentTarget instanceof Element ? e.currentTarget : null
    startX = e.screenX
    startY = e.screenY
    lastX = e.screenX
    lastY = e.screenY
    samples = [{ t: e.timeStamp, x: e.screenX, y: e.screenY }]
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

  function releaseCapture(): void {
    if (downEl && activeId !== null) {
      try {
        downEl.releasePointerCapture(activeId)
      } catch {
        /* 未捕获 / 指针已失效：忽略 */
      }
    }
    downEl = null
  }

  /** 越过 slop 才算真正抓住：此前松手是点按，原生 click 照常触发 */
  function engage(e: PointerEvent): void {
    stopSpring()
    if (!posKnown) void refreshPosition()
    void refreshWork()
    pressing.value = false
    dragging.value = true
    grabDX = cx - e.screenX
    grabDY = cy - e.screenY
    // 抓住之后才捕获指针：快速轻弹时指针可能短暂跑出窗口，捕获后事件仍回到壳上。
    // 点按阶段不捕获 —— 否则 click 会落到壳上，按钮永远收不到。
    if (downEl) {
      try {
        downEl.setPointerCapture(e.pointerId)
      } catch {
        /* 捕获失败不影响拖拽（窗口跟着指针走，事件大多仍在壳内） */
      }
    }
    armClickSwallow()
  }

  function scheduleDragWrite(): void {
    if (dragWriteRaf) return
    dragWriteRaf = requestAnimationFrame(() => {
      dragWriteRaf = 0
      writePos()
    })
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== activeId) return
    lastX = e.screenX
    lastY = e.screenY
    pushSample(e.timeStamp, e.screenX, e.screenY)
    if (!dragging.value) {
      if (Math.hypot(e.screenX - startX, e.screenY - startY) <= SLOP_PX) return
      engage(e)
    }
    if (!posKnown) return // 真位置还没读到：下一帧再跟（refreshPosition 会重基准）
    if (!workKnown) {
      cx = e.screenX + grabDX
      cy = e.screenY + grabDY
    } else {
      const b = bounds()
      if (b.x1 > b.x0) cx = rubber(e.screenX + grabDX, b.x0, b.x1, b.x1 - b.x0)
      if (b.y1 > b.y0) cy = rubber(e.screenY + grabDY, b.y0, b.y1, b.y1 - b.y0)
    }
    scheduleDragWrite()
  }

  function finish(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerId !== activeId) return
    detach()
    releaseCapture()
    activeId = null
    pressing.value = false
    const wasDragging = dragging.value
    dragging.value = false
    if (dragWriteRaf) {
      cancelAnimationFrame(dragWriteRaf)
      dragWriteRaf = 0
      writePos() // 把最后一帧位移落下去，再交给弹簧接管
    }
    if (!wasDragging) return // 点按：交给原生 click（blob 的 click 展开回条）
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

  /* ---------- 松手解算（与 useDragDock 同一条决策） ---------- */
  function solveRelease(px: number, py: number, vx: number, vy: number): FloatSlot {
    if (Math.hypot(vx, vy) >= FLICK_PXMS) {
      if (Math.abs(vx) > Math.abs(vy)) {
        sideYFrac.value = yToSideY(py)
        return vx > 0 ? 'right' : 'left'
      }
      return vy > 0 ? 'bottom' : 'top'
    }
    return nearestSlot(px, py, vx, vy)
  }

  /** 慢放：投影 p+v·PROJECTION 后取最近槽位 */
  function nearestSlot(px: number, py: number, vx = 0, vy = 0): FloatSlot {
    const jx = px + vx * PROJECTION_PX
    const jy = py + vy * PROJECTION_PX
    const sideY = yToSideY(jy)
    const cands: Array<{ s: FloatSlot; d: number }> = []
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
    const { lo, hi } = sideYRange()
    if (hi <= lo) return 0
    return clamp((y - lo) / (hi - lo), 0, 1)
  }

  /* ---------- 拖拽后的幽灵点击吞咽（防止松手误触按钮，与 useDragDock 同法） ---------- */
  let swallowArmedAt = 0
  function armClickSwallow(): void {
    swallowArmedAt = Date.now()
    document.addEventListener('click', onClickSwallow, { capture: true, once: true })
  }

  function onClickSwallow(e: MouseEvent): void {
    if (Date.now() - swallowArmedAt < 400) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  /* ---------- 对外动作 ---------- */

  /** 标题栏「泊车为方块」：吸附到最近一侧，记住当前高度 */
  async function parkToSide(): Promise<void> {
    if (!desktop || !opts.active.value) return
    await refreshWork()
    const side: FloatSlot = cx < work.x + work.width / 2 ? 'left' : 'right'
    sideYFrac.value = yToSideY(cy)
    await dockTo(side, 0, 0)
  }

  /** blob 轻点：展开回上一次的全宽条槽位 */
  function expandToBar(): void {
    if (!desktop || opts.form.value !== 'blob') return
    void dockTo(barSlot.value, 0, 0)
  }

  /** 按持久化槽位即时落位（首帧 / 重新显示 / 换屏后）；读不到工作区就留在原处 */
  async function redock(): Promise<void> {
    if (!desktop) return
    stopSpring()
    await refreshWork()
    await refreshPosition()
    if (!workKnown) return
    const s: FloatSlot =
      opts.form.value === 'blob'
        ? slot.value === 'left' || slot.value === 'right'
          ? slot.value
          : 'right'
        : barSlot.value
    slot.value = s
    const c = slotCenter(s)
    cx = c.x
    cy = c.y
    writePos()
  }

  /** 结束确认长高：底边锚定（钳制进工作区），记住原中心以便取消时还原 */
  async function openConfirm(): Promise<void> {
    if (!desktop || confirmTall) return
    // 弹簧飞行中点「结束」：先冻在当前位，否则长高期间弹簧还在按 bar 高度写位置
    stopSpring()
    confirmTall = true
    preConfirmCy = cy
    try {
      await floatService.setForm('confirm')
    } catch {
      /* 长高失败就挤在 bar 高度里渲染：内容可截断，动作仍可点 */
    }
    heightOverride = FLOAT_SIZE.confirm.h
    await refreshWork()
    if (workKnown && posKnown) {
      const bottom = preConfirmCy + FLOAT_SIZE.bar.h / 2
      cy = Math.max(bottom - FLOAT_SIZE.confirm.h / 2, work.y + FLOAT_SIZE.confirm.h / 2)
      writePos()
    }
  }

  /** 收回确认态：还原 bar 高度与确认前的位置 */
  async function closeConfirm(): Promise<void> {
    if (!desktop || !confirmTall) return
    confirmTall = false
    heightOverride = null
    try {
      await floatService.setForm('bar')
    } catch {
      /* 还原失败：下一次主窗口归一形状会再改一次 */
    }
    if (posKnown) {
      cy = preConfirmCy
      if (workKnown) {
        const half = FLOAT_SIZE.bar.h / 2
        cy = clamp(cy, work.y + EDGE_GAP + half, work.y + work.height - EDGE_GAP - half)
      }
      writePos()
    }
  }

  onBeforeUnmount(() => {
    detach()
    stopSpring()
    if (dragWriteRaf) cancelAnimationFrame(dragWriteRaf)
    document.removeEventListener('click', onClickSwallow, { capture: true })
  })

  return {
    pressing,
    dragging,
    onPointerDown,
    parkToSide,
    expandToBar,
    redock,
    openConfirm,
    closeConfirm,
  }
}