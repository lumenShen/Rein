<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, Minus, Square, X } from 'lucide-vue-next'
import type { UnlistenFn } from '@tauri-apps/api/event'

import TitleBarBase from '@/components/layout/TitleBarBase.vue'
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onMaximizedChange,
  toggleMaximizeWindow,
} from '@/system/windowChrome'

/**
 * 主窗口自绘标题栏：左 = 品牌，右 = 最小化 / 最大化还原 / 关闭。
 *
 * 视觉一律复用 TitleBarBase（外壳）与 base.css 的 .wbtn / .wbtn-danger（按钮）——
 * 全局浮窗的 FloatTitleBar 用同一套，两条窗口的标题栏才是同一份语言。
 *
 * 只在此处管「最大化态」这一份本地状态：图标与 aria-label 都要跟着它换
 * （最大化后第二颗钮是「向下还原」）。状态来源是窗口本身（isWindowMaximized +
 * onMaximizedChange），不是点击次数 —— 双击标题栏、系统快捷键、Aero Snap 都会改它，
 * 自己记一份必然对不上。
 */
const maximized = ref(false)
let off: UnlistenFn | null = null
let disposed = false

onMounted(() => {
  void (async () => {
    maximized.value = await isWindowMaximized()
    const unlisten = await onMaximizedChange((v) => {
      maximized.value = v
    })
    // 订阅返回前组件已卸载（窗口秒关 / 热重载）：当场退订，别把监听漏在窗口上
    if (disposed) unlisten()
    else off = unlisten
  })()
})

onBeforeUnmount(() => {
  disposed = true
  off?.()
  off = null
})
</script>

<template>
  <TitleBarBase>
    <template #left>
      <span class="brand">
        <span class="dot" aria-hidden="true" />
        <span class="word">Rein</span>
      </span>
    </template>

    <!-- 三颗窗口控制钮：尺寸 / 材质 / hover / 按压全在 base.css 的 .wbtn（见那里的注释），
         这里只放图标与 aria-label。mousedown.stop 让拖拽区收不到这次按下 ——
         按钮本来就不该触发窗口拖动；dblclick.stop 与它同理（双击按钮不是双击标题栏）。 -->
    <template #right>
      <button
        type="button"
        class="wbtn"
        aria-label="最小化"
        @mousedown.stop
        @dblclick.stop
        @click="minimizeWindow"
      >
        <Minus :size="15" :stroke-width="2" />
      </button>
      <button
        type="button"
        class="wbtn"
        :aria-label="maximized ? '向下还原' : '最大化'"
        @mousedown.stop
        @dblclick.stop
        @click="toggleMaximizeWindow"
      >
        <Copy v-if="maximized" :size="14" :stroke-width="2" />
        <Square v-else :size="14" :stroke-width="2" />
      </button>
      <button
        type="button"
        class="wbtn wbtn-danger"
        aria-label="关闭"
        @mousedown.stop
        @dblclick.stop
        @click="closeWindow"
      >
        <X :size="15" :stroke-width="2" />
      </button>
    </template>
  </TitleBarBase>
</template>

<style scoped>
/* 品牌区：一枚 8px 色点 + 「Rein」字标。
   色点用 --accent（品牌色只出现在「图元」上，遵守 STANDARDS 的色彩配额）；
   字标 13/700 —— 它是窗口身份，不是正文层级，所以走 --fs-brand 而不是正文阶梯。
   字号 / 字重 / 颜色都走令牌；这里只定排布。 */
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-8);
  min-width: 0;
}

.dot {
  width: var(--sp-8);
  height: var(--sp-8);
  flex: none;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.word {
  font-size: var(--fs-brand);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  white-space: nowrap;
}
</style>
