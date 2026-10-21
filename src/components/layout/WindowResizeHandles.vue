<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { isTauriDesktopWindow, isWindowMaximized, onMaximizedChange } from '@/system/windowChrome'

/** 缩放方向。@tauri-apps/api 的 ResizeDirection 没有从模块导出（只在本文件里声明），
 *  从方法签名反推，而不是再抄一份字面量联合 —— 上游加方向时这里自动跟上。 */
type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>['startResizeDragging']>[0]

/**
 * 无边框窗口的八向缩放热区（四条边 + 四个角）。
 *
 * 为什么必须有这一层：decorations: false 之后系统不再画窗口边框，原生那圈
 * 可拖拽的缩放带也一起消失 —— 不补这一层，窗口就再也改不了大小（GLOBAL-FLOAT §3.5）。
 *
 * 实现要点：
 *  · 热区只有 6px，沿着窗口边缘摆，不覆盖内容中间的点击（wrapper 是 inset:0 的
 *    fixed 层但 pointer-events: none，只有八个窄条接受事件）；
 *  · pointerdown → startResizeDragging(direction)，之后由系统接管缩放（鼠标不必
 *    停在热区里，与原生边框一致）；
 *  · 最大化时整组隐藏：最大化窗口不可缩放，留着热区只会在窗口边缘吃掉点击；
 *  · 角排在边之后：重叠的 6×6 那格归角（对角缩放比单向缩放更符合直觉）。
 */
const maximized = ref(false)
let off: (() => void) | null = null
let disposed = false

const HANDLES: ReadonlyArray<{ dir: ResizeDirection; cls: string }> = [
  { dir: 'North', cls: 'n' },
  { dir: 'South', cls: 's' },
  { dir: 'West', cls: 'w' },
  { dir: 'East', cls: 'e' },
  { dir: 'NorthWest', cls: 'nw' },
  { dir: 'NorthEast', cls: 'ne' },
  { dir: 'SouthWest', cls: 'sw' },
  { dir: 'SouthEast', cls: 'se' },
]

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
})

function onPointerDown(e: PointerEvent, dir: ResizeDirection): void {
  if (!isTauriDesktopWindow || e.button !== 0) return
  // 阻止默认的文本选择 / 图片拖拽：热区压在内容边上，不拦的话斜拖会选中几行字
  e.preventDefault()
  try {
    void getCurrentWindow()
      .startResizeDragging(dir)
      .catch(() => {
        /* 权限缺失 / 窗口已最大化：这一拖就是没反应，不抛未捕获异常 */
      })
  } catch {
    /* 非 Tauri 环境（组件本不该渲染，留一条兜底） */
  }
}
</script>

<template>
  <div v-show="!maximized" class="rz" aria-hidden="true">
    <div
      v-for="h in HANDLES"
      :key="h.dir"
      class="rz-zone"
      :class="'rz-' + h.cls"
      @pointerdown="onPointerDown($event, h.dir)"
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
  /* 拖动缩放由系统接管，热区自己不参与滚动手势 */
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
