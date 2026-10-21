<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

import { isTauriDesktopWindow, toggleMaximizeWindow } from '@/system/windowChrome'

/**
 * 自绘标题栏的**唯一外壳**（主窗口 40 / 浮窗 compact 32 共用这一份）。
 *
 * 它只负责三件事：盒子与拖拽区、双击最大化、左右 slot 的排布。
 * 按钮外观**不在这里**：slot 内容进不了 scoped 样式（Vue 的 scoped 管不到插槽里的
 * 元素），而主窗口标题栏与浮窗标题栏是两个组件、视觉必须同一套 —— 所以按钮类
 * （.wbtn / .wbtn-danger）放在 base.css，见那里的注释。
 */
defineProps<{
  /** 浮窗紧凑版：高 32（--titlebar-h-compact），左右内边距也收一档 */
  compact?: boolean
}>()

const root = ref<HTMLElement | null>(null)

/** 拖拽属性恢复成「深区」：整条标题栏（含品牌文字、会话标题）都能拖 */
const DRAG_REGION = 'deep'

function setDragEnabled(on: boolean): void {
  root.value?.setAttribute('data-tauri-drag-region', on ? DRAG_REGION : 'false')
}

/** 命中按钮 / 链接 / 输入框等可交互元素（双击不归标题栏管，拖拽也由原生脚本让行） */
function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a, input, select, textarea, [role="button"], [role="link"]') !== null
  )
}

/**
 * 第二次按下时先把拖拽属性临时关掉。
 *
 * 为什么需要这一步：Tauri 2 注入的 drag-region 脚本会在**第二次 mousedown**（detail===2）
 * 上调 internal_toggle_maximize 自行切换最大化（见 tauri 的 window/scripts/drag.js）。
 * 而双击最大化必须由本组件接管 —— 浮窗（maximizable: false）上要能判出不切、主窗口也
 * 只该切一次。两条路径叠起来会互相抵消：窗口闪一下又回原状。
 *
 * 时机：元素自己的 mousedown 处理先于 document 上的注入脚本（冒泡阶段），所以这里
 * 把属性置为 false 之后，原生那条双击分支整条退出（isDragRegion 读到 'false' 直接返回）。
 * 下一次单击（detail===1）会立刻恢复；dblclick 里也恢复；定时器只是兜底（第二次按下后
 * 拖走了、dblclick 没到的情况）。
 */
let restoreTimer: ReturnType<typeof setTimeout> | null = null

function restoreDragRegion(): void {
  if (restoreTimer) {
    clearTimeout(restoreTimer)
    restoreTimer = null
  }
  setDragEnabled(true)
}

function onMouseDown(e: MouseEvent): void {
  if (!isTauriDesktopWindow || e.button !== 0) return
  if (isInteractive(e.target)) return
  // 单击：确保拖拽区是开着的（可能还停在上一次双击的临时关闭窗口里）
  if (e.detail === 1) {
    restoreDragRegion()
    return
  }
  if (e.detail !== 2) return
  setDragEnabled(false)
  if (restoreTimer) clearTimeout(restoreTimer)
  restoreTimer = setTimeout(restoreDragRegion, 400)
}

/**
 * 双击（非按钮区域）切换最大化。
 *
 * 与上面那条 mousedown 配合：原生脚本的 double-click 分支被提前关掉，切换只发生在这里，
 * 因此不会出现「原生切一次 + 这里再切一次」的来回抵消。
 */
function onDoubleClick(e: MouseEvent): void {
  if (!isTauriDesktopWindow) return
  if (isInteractive(e.target)) return
  restoreDragRegion()
  void toggleMaximizeWindow()
}

onBeforeUnmount(() => {
  if (restoreTimer) clearTimeout(restoreTimer)
})
</script>

<template>
  <!-- 整条都是拖拽区（deep：子元素上的按下也算），按钮等可交互元素由原生脚本自动让行。
       这里**不声明 background**：宽窗由壳的环境光固定层透上来（base.css「环境光」段），
       窄窗由 App.vue 给根节点挂 .glass-surface（内容从底下滚过，玻璃条才读得出层级）。
       若在这里写 background: transparent，scoped 选择器的特指度会压掉 .glass-surface。 -->
  <header
    ref="root"
    class="titlebar"
    :class="{ compact }"
    data-tauri-drag-region="deep"
    @mousedown="onMouseDown"
    @dblclick="onDoubleClick"
  >
    <div class="tb-left">
      <slot name="left" />
    </div>
    <div class="tb-right">
      <slot name="right" />
    </div>
  </header>
</template>

<style scoped>
/* 只管外壳与拖拽区：高度、横排、两侧让位。按钮的尺寸 / 颜色 / 反馈全在 base.css 的
   .wbtn（slot 里的内容不受这里的 scoped 样式管辖，写了也命不中）。 */
.titlebar {
  flex: none;
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding-inline: var(--sp-16);
  user-select: none;
}

/* 浮窗紧凑版：32 高（--titlebar-h-compact），横向呼吸收到 12 —— 430 宽的浮窗里
   16 的左右留白会让标题与两颗按钮之间的空白读起来像少放了一块 */
.titlebar.compact {
  height: var(--titlebar-h-compact);
  padding-inline: var(--sp-12);
}

/* 左侧吃剩余宽度、右侧按钮组不参与压缩：窄到 430 时三颗 44 宽的按钮也不能被挤掉 */
.tb-left {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.tb-right {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
}
</style>
