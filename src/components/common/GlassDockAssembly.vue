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
    left?: GlassDockItem
    right?: GlassDockItem
    goo?: boolean
    ariaLabel?: string
    /** 左右两块玻璃在 DOM 上的稳定标记（落到 data-slot，回归脚本按它寻址） */
    leftSlot?: string
    rightSlot?: string
  }>(),
  {
    active: '',
    goo: false,
    ariaLabel: '玻璃导航预览',
  },
)

defineSlots<{
  left(props: { item: GlassDockItem; active: boolean }): unknown
  tab(props: { item: GlassDockItem; active: boolean }): unknown
  right(props: { item: GlassDockItem; active: boolean }): unknown
}>()
</script>

<template>
  <div class="dock-assembly" :aria-label="ariaLabel">
    <GlassSurface
      v-if="left"
      class="dock-block"
      :data-slot="leftSlot"
      width="var(--tabbar-h)"
      height="var(--tabbar-h)"
      border-radius="50%"
      fill="var(--glass-fill)"
    >
      <slot name="left" :item="left" :active="active === left.id">
        <span class="dock-slot" :class="{ active: active === left.id }">
          <component :is="left.icon" :size="24" :stroke-width="active === left.id ? 2.4 : 1.9" />
          <span>{{ left.label }}</span>
        </span>
      </slot>
    </GlassSurface>

    <GlassSurface
      class="dock-block pill"
      :class="{ goo }"
      height="var(--tabbar-h)"
      border-radius="var(--radius-full)"
      fill="var(--glass-fill)"
    >
      <GlassThumb v-if="goo" :index="Math.max(0, items.findIndex((item) => item.id === active))" :count="items.length" />
      <template v-for="item in items" :key="item.id">
        <slot name="tab" :item="item" :active="item.id === active">
          <span class="dock-tab" :class="{ active: item.id === active }">
            <component :is="item.icon" :size="24" :stroke-width="item.id === active ? 2.4 : 1.9" />
            <span>{{ item.label }}</span>
          </span>
        </slot>
      </template>
    </GlassSurface>

    <GlassSurface
      v-if="right"
      class="dock-block"
      :data-slot="rightSlot"
      width="var(--tabbar-h)"
      height="var(--tabbar-h)"
      border-radius="50%"
      fill="var(--glass-fill)"
    >
      <slot name="right" :item="right" :active="active === right.id">
        <span class="dock-slot" :class="{ active: active === right.id }">
          <component :is="right.icon" :size="24" :stroke-width="active === right.id ? 2.4 : 1.9" />
          <span>{{ right.label }}</span>
        </span>
      </slot>
    </GlassSurface>
  </div>
</template>

<style scoped>
.dock-assembly {
  display: flex;
  align-items: center;
  /* 三块玻璃并列留缝、互不叠压（各自都有受光边）：无边界控件之间 8 */
  gap: var(--gap-sm);
  width: 100%;
  height: var(--tabbar-h);
}
</style>
