<script setup lang="ts">
import type { Component } from 'vue'

import GlassSurface from '@/components/common/GlassSurface.vue'
import GlassThumb from '@/components/common/GlassThumb.vue'

export interface GlassDockItem {
  id: string
  label: string
  icon?: Component
}

withDefaults(
  defineProps<{
    items: GlassDockItem[]
    active?: string
    goo?: boolean
    ariaLabel?: string
    /** 这块玻璃在 DOM 上的稳定标记（落到 data-slot，回归脚本按它寻址） */
    dataSlot?: string
  }>(),
  {
    active: '',
    goo: false,
    ariaLabel: '玻璃导航预览',
  },
)

defineSlots<{
  /** 输入行（底栏合并重构的上排）：真实 Dock 与标本各自渲染内容，几何共用同一份组件/类名 */
  quick(): unknown
  tab(props: { item: GlassDockItem; active: boolean }): unknown
}>()
</script>

<template>
  <div class="dock-assembly" :aria-label="ariaLabel">
    <GlassSurface
      class="dock-block"
      :data-slot="dataSlot"
      border-radius="var(--dock-radius)"
      fill="var(--glass-fill)"
    >
      <slot name="quick" />
      <!-- 页签行：等分容器（页签 flex:1），GlassThumb 的 blob 按等分位移 —— 它必须
           包在玻璃 slot 里面（带 filter 的元素做祖先会让折射整段失效，见其文件头），
           自己 absolute + inset:0，所以这一行要自持 position:relative -->
      <div class="dock-navs" :class="{ goo }">
        <GlassThumb
          v-if="goo"
          :index="Math.max(0, items.findIndex((item) => item.id === active))"
          :count="items.length"
        />
        <template v-for="item in items" :key="item.id">
          <slot name="tab" :item="item" :active="item.id === active">
            <span class="dock-tab" :class="{ active: item.id === active }">
              <component :is="item.icon" :size="24" :stroke-width="item.id === active ? 2.4 : 1.9" />
              <span>{{ item.label }}</span>
            </span>
          </slot>
        </template>
      </div>
    </GlassSurface>
  </div>
</template>

<style scoped>
.dock-assembly {
  display: flex;
  /* 合并 Dock（2026-11 底栏重构）：一块玻璃装下输入行 + 页签行，宽度随容器
     （真实 Dock 左右留浮边铺满，标本随 .dockrow）—— 从前「左右圆钮 + 定宽药丸」
     的三块装配随左右钮一起退役，页签在玻璃内均摊正是参考构图的摊开式页签行。 */
  width: 100%;
  height: auto;
}

/* 两行堆叠是本组件的**构图契约**：输入行在上、页签行在下。GlassSurface 的 .gbody
   默认 row + 水平居中——插槽里的两个兄弟会并排成两列，页签行被挤到内容宽
   （真机 412px 实测：页签行只剩 80px、每签 18px 宽、文字竖排糊字，e2e 断言只查
   顺序没查几何所以桌面上一路绿灯）。转纵向 + 拉伸，两行各铺满玻璃宽，
   页签行的 flex:1 均分这才成立；:deep 提特异度，压过 .gbody 的 scoped 声明。 */
.dock-assembly :deep(.gbody) {
  flex-direction: column;
  align-items: stretch;
}
</style>
