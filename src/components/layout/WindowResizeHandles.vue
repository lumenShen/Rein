<script setup lang="ts">
import { LogicalPosition, LogicalSize, getCurrentWindow } from '@tauri-apps/api/window'
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { isTauriDesktopWindow, isWindowMaximized, onMaximizedChange } from '@/system/windowChrome'

/** 八向缩放方向：字母组合即语义（含 e/s/w/n 的组合为角） */
type Dir = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se'

/**
 * 无边框窗口的八向缩放热区（四条边 + 四个角）。
 *
 * 为什么必须有这一层：decorations: false 之后系统不再画窗口边框，原生那圈
 * 可拖拽的缩放带也一起消失 —— 不补这一层，窗口就再也改不了大小（GLOBAL-FLOAT §3.5）。
 *
 * 为什么是**手动手势**而不是 startResizeDragging：后者在 Windows 上靠
 * PostMessage(WM_NCLBUTTONDOWN, HT*) 借系统缩放循环实现（tao 传入的 lParam 是
 * 指针而非 MAKELPARAM 坐标）。实测（真实 OS 鼠标输入的闭环探针）在新版 Windows
 * （26220，大概率 26100+ 同理）上该循环**收不到后续鼠标输入** —— 循环启动后只在
 * 初始钳制上生效一次（窗口小于最小尺寸时跳到最小宽高），之后就不再跟随光标；
 * 而 HTCAPTION 的移动循环一切正常。tao 上游改不了（pointer lParam 是 undocumented
 * 约定，没有开关），所以对齐 useFloatDock 的成熟方案：**pointer 手势 + setSize /
 * setPosition**，一个代码路径跑所有平台，不赌任何系统模态循环。
 *
 * 实现要点：
 *  · 热区只有 6px，沿着窗口边缘摆，不覆盖内容中间的点击（wrapper 是 inset:0 的
 *    fixed 层但 pointer-events: none，只有八个窄条接受事件）；
 *  · 增量取 PointerEvent.screenX/screenY 的**差值** —— 窗口在 w/n 方向会挪位置，
 *    客户区坐标会漂移，屏幕坐标的差值永远稳定（Chromium 的 screen 坐标按主屏
 *    缩放折算，dpr 差异被差值抵消）；
 *  · setPointerCapture 把后续 move/up 钉在热区元素上，光标拖出窗口也继续跟
 *    （原生边框行为）；
 *  · 最小尺寸交给 tauri 的 setSize 钳制（窗口 minWidth/minHeight，900×640 逻辑）；
 *  · 最大化时整组隐藏：最大化窗口不可缩放，留着热区只会在窗口边缘吃掉点击；
 *  · 角排在边之后：重叠的 6×6 那格归角（对角缩放比单向缩放更符合直觉）。
 */
const maximized = ref(false)
let off: (() => void) | null = null
let disposed = false

/** 进行中的手势：起始屏幕坐标 + 窗口外框的逻辑基线 */
let gesture: {
  dir: Dir
  startSX: number
  startSY: number
  base: { x: number; y: number; w: number; h: number }
} | null = null

function beginResize(e: PointerEvent, dir: Dir): void {
  if (!isTauriDesktopWindow || e.button !== 0 || maximized.value) return
  // 阻止默认的文本选择 / 图片拖拽：热区压在内容边上，不拦的话斜拖会选中几行字
  e.preventDefault()
  // capture 必须**同步**挂：事件派发结束后 currentTarget 就是 null，await 之后再挂
  // 必然抛错 —— 手势会整个死掉（第一版实测就是这样，缩放纹丝不动）。
  const el = e.currentTarget as Element | null
  if (!el) return
  try {
    // 光标拖出窗口后 move 事件仍钉在这条热区上 —— 没有它，出窗即断手
    el.setPointerCapture(e.pointerId)
  } catch {
    /* 指针已被系统抢占：继续，只是出窗会断手 */
  }
  // 几何基线晚一两帧没关系，光标还没动。尺寸基线必须用 **innerSize**：
  // setSize 改的是 inner 尺寸，而外框带着不可见的 resize 边框（实测宽差 ~15 逻辑、
  // 高差 ~9），拿 outer 当基线会让每一下缩放多出一截一次性跳变。
  // 位置仍然用 outerPosition —— setPosition 设的就是外框位置，两套单位各自自洽。
  const startSX = e.screenX
  const startSY = e.screenY
  const win = getCurrentWindow()
  void (async () => {
    const [pos, size, sf] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()])
    gesture = {
      dir,
      startSX,
      startSY,
      base: { x: pos.x / sf, y: pos.y / sf, w: size.width / sf, h: size.height / sf },
    }
  })().catch(() => {
    /* 窗口正在销毁 / 极早期调用：这一下缩放就是没反应，不抛未捕获异常 */
    gesture = null
  })
}

function onResizeMove(e: PointerEvent): void {
  if (!gesture) return
  const dx = e.screenX - gesture.startSX
  const dy = e.screenY - gesture.startSY
  const b = gesture.base
  const d = gesture.dir
  let x = b.x
  let y = b.y
  let w = b.w
  let h = b.h
  if (d.includes('e')) w = b.w + dx
  if (d.includes('s')) h = b.h + dy
  if (d.includes('w')) {
    w = b.w - dx
    x = b.x + dx
  }
  if (d.includes('n')) {
    h = b.h - dy
    y = b.y + dy
  }
  // 尺寸被钳到极小（tauri 的 min 在 setSize 里生效，但位置先算出来了）：
  // 这种几何没有意义，直接等钳制结果，别把窗口甩到天边
  if (w < 1 || h < 1) return
  const win = getCurrentWindow()
  void win.setSize(new LogicalSize(w, h)).catch(() => {})
  if (d !== 'e' && d !== 's') void win.setPosition(new LogicalPosition(x, y)).catch(() => {})
}

function endResize(e: PointerEvent): void {
  if (!gesture) return
  gesture = null
  try {
    ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
  } catch {
    /* 指针已经释放（窗口销毁 / 系统抢占）：无所谓 */
  }
}

onMounted(() => {
  void (async () => {
    maximized.value = await isWindowMaximized()
    const unlisten = await onMaximizedChange((v) => {
      maximized.value = v
    })
    if (disposed) unlisten()
    else off = unlisten
  })()
})

onBeforeUnmount(() => {
  disposed = true
  off?.()
  off = null
  gesture = null
})
</script>

<template>
  <div v-show="!maximized" class="rz" aria-hidden="true">
    <div
      v-for="cls in (['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'] as const)"
      :key="cls"
      class="rz-zone"
      :class="'rz-' + cls"
      @pointerdown="beginResize($event, cls)"
      @pointermove="onResizeMove"
      @pointerup="endResize"
      @pointercancel="endResize"
    />
  </div>
</template>

<style scoped>
/* 整层 fixed 铺满窗口、不吃事件；只有下面八个窄条 pointer-events: auto。
   z-index 80：在壳层内容（Dock 60）之上、抽屉遮罩（90）之下 —— 打开抽屉时
   边缘缩放让位给遮罩，与「弹层期间不该还能拽窗口边缘」一致。 */
.rz {
  position: fixed;
  inset: 0;
  z-index: 80;
  pointer-events: none;
}

.rz-zone {
  position: absolute;
  pointer-events: auto;
  /* 手势期间不参与滚动 / 触摸手势 */
  touch-action: none;
}

/* 四条边：厚度 = 6（--sp-6），两端各让开 6 给角 */
.rz-n {
  top: 0;
  left: var(--sp-6);
  right: var(--sp-6);
  height: var(--sp-6);
  cursor: ns-resize;
}

.rz-s {
  bottom: 0;
  left: var(--sp-6);
  right: var(--sp-6);
  height: var(--sp-6);
  cursor: ns-resize;
}

.rz-w {
  left: 0;
  top: var(--sp-6);
  bottom: var(--sp-6);
  width: var(--sp-6);
  cursor: ew-resize;
}

.rz-e {
  right: 0;
  top: var(--sp-6);
  bottom: var(--sp-6);
  width: var(--sp-6);
  cursor: ew-resize;
}

/* 四个角：6×6 的小方块盖在边的端头（DOM 在后，重叠处归角） */
.rz-nw,
.rz-ne,
.rz-sw,
.rz-se {
  width: var(--sp-6);
  height: var(--sp-6);
}

.rz-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.rz-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.rz-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}

.rz-se {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}
</style>
