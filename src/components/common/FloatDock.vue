<script setup lang="ts">
import { ref } from 'vue'

import GlassFilter from '@/components/common/GlassFilter.vue'
import { useDragDock } from '@/composables/useDragDock'
import { useLiquidGlass } from '@/composables/useLiquidGlass'
import { liquidGlass } from '@/system/perf'

/**
 * 悬浮条外壳 · 全应用四条浮条（运动 / 录音 / 专注 / 语音转写）的唯一实现。
 *
 * 这一层只负责四件**必须一致**的事：
 *  · 三层结构（root 只吃 fixed + z、.dock-pos 只被弹簧写 transform、.dock-body 承载材质）；
 *  · useDragDock 的拖拽停靠与条 / 方块两态；
 *  · 超高 / 极致档的真折射材质（普通档回落 .glass-surface 的毛玻璃）；
 *  · 进出场节奏（入场 250ms ease-sheet、退场 150ms ease-out，同路径同向量）。
 *
 * 业务内容走 #bar / #blob 插槽，结束确认等二级弹层走默认插槽。各域不再各写一份
 * 外壳 —— 此前四条浮条各有一份近似的 CSS 与 glassStyle，语音条还因此漏掉了
 * 非对称退场与减弱动效下的位移清理，同一套手感出现了四种实际行为。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    /** 停靠位置持久化 key：四条浮条各停各位，互不挤占 */
    storageKey: string
    /** 条形态读屏名称（region；不用 aria-label 作 prop 名，避免与原生 attribute 冲突） */
    regionLabel: string
    /** 方块形态展开按钮的读屏名称 */
    blobLabel: string
    /** e2e / 沉浸态依赖的根类名（如 fdock-root） */
    rootClass?: string | Record<string, boolean> | (string | Record<string, boolean>)[]
    /** 条形态纵向内边距：默认 8px；运动条两行内容用 10px */
    paddingY?: number
    /** 沉浸形变等场景下关掉 CSS 进出场 */
    noTransition?: boolean
  }>(),
  { paddingY: 8, noTransition: false },
)

const posEl = ref<HTMLElement | null>(null)
const { slot, form, pressing, dragging, onPointerDown, expandFromBlob } = useDragDock(posEl, {
  storageKey: props.storageKey,
})

/* 折射滤镜 id 每个实例唯一：多条浮条可能同时在 DOM 里 */
const { glassFilterId, glassStyle } = useLiquidGlass()

defineExpose({ posEl, slot, form })
</script>

<template>
  <Transition :css="!noTransition" name="float-dock">
    <section
      v-if="open"
      class="float-dock"
      :class="[rootClass, `dock-${slot}`, { dragging }]"
      :style="{ '--dock-pad-y': `${paddingY}px` }"
    >
      <div ref="posEl" class="dock-pos">
        <div
          class="dock-body glass-surface"
          :class="[form === 'blob' ? 'is-blob' : 'is-bar', { pressing, dragging }]"
          :style="glassStyle"
          role="region"
          :aria-label="regionLabel"
          @pointerdown="onPointerDown"
        >
          <!-- 折射滤镜定义（不参与绘制，绝对定位）：只在超高档挂，量尺是这个 .dock-body -->
          <GlassFilter :id="glassFilterId" :enabled="liquidGlass" />


          <div class="layer layer-bar" :class="{ off: form !== 'bar' }">
            <slot name="bar" />
          </div>

          <!-- 方块泊车形态：轻点展开回全宽条 -->
          <button
            class="layer layer-blob"
            :class="{ off: form !== 'blob' }"
            type="button"
            :aria-label="blobLabel"
            @click="expandFromBlob"
          >
            <slot name="blob" />
          </button>
        </div>
      </div>

      <slot />
    </section>
  </Transition>
</template>

<style scoped>
/* root：只管 fixed 定位与 z 序（零尺寸、不接事件），位移全在 .dock-pos */
.float-dock {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 59; /* 页面内容之上、TabBar(60) 之下 */
  pointer-events: none;
}

.float-dock.dragging {
  z-index: 70; /* 拖拽 / 飞行中盖过 TabBar，落位即回 */
}

.dock-pos {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}

/* 材质走全局 .glass-surface（与底部 Dock 同一份定义），这里只留几何与手感 */
.dock-body {
  position: relative;
  display: flex;
  align-items: center;
  /* 一条浮条里是「图标 / 读数 / 操作」三组，彼此有边界 → 间距 12（--gap-md）；
     原来 10 是手感值，落在两个令牌之间。 */
  gap: var(--gap-md);
  /* 纵向由调用方给（条 8 / 两行的运动条 10），横向统一 --pad-inline 12 */
  padding: var(--dock-pad-y, var(--sp-8)) var(--pad-inline);
  border-radius: var(--radius-l);
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transition:
    transform var(--dur-fast) var(--ease-standard),
    box-shadow var(--dur-fast) var(--ease-standard);
}

.dock-body.is-blob {
  width: 64px;
  height: 64px;
  padding: 0;
  flex-direction: column;
  justify-content: center;
  /* 方块态只有图标与一行微标签：无边界的一组，用最小呼吸 4（原来 5 进不了 4/8 体系） */
  gap: var(--gap-tight);
  border-radius: var(--radius-l);
}

.dock-body.pressing {
  transform: scale(0.97);
}

.dock-body.is-bar {
  /* 两侧各让 12（--sp-24 的一半）：浮条不贴屏幕边缘 */
  width: calc(100vw - var(--sp-24));
  max-width: calc(var(--frame-max) - var(--sp-24));
}

.dock-body.dragging {
  transform: scale(1.03);
  box-shadow: var(--shadow-float-lift);
}

/* 两层内容同位交叉淡变；隐藏层延迟到淡出结束后才真正不可见 */
.layer {
  visibility: visible;
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    visibility 0s;
}

.layer.off {
  opacity: 0;
  transform: scale(0.92);
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    visibility 0s linear var(--dur-fast);
}

.layer-bar {
  display: flex;
  align-items: center;
  /* 与 .dock-body 同一档：方块的纵向间距是 4，横条的横向间距是 12 */
  gap: var(--gap-md);
  flex: 1;
  min-width: 0;
}

.layer-blob {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
}

/* 出入不对称：入场 250、退场 150；方向由停靠槽决定，四条浮条同一套 */
.float-dock-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-sheet),
    transform var(--dur-base) var(--ease-sheet);
}

.float-dock-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.float-dock-enter-from,
.float-dock-leave-to {
  opacity: 0;
}

.dock-bottom.float-dock-enter-from,
.dock-bottom.float-dock-leave-to {
  transform: translateY(18px);
}

.dock-top.float-dock-enter-from,
.dock-top.float-dock-leave-to {
  transform: translateY(-18px);
}

.dock-left.float-dock-enter-from,
.dock-left.float-dock-leave-to {
  transform: translateX(-14px);
}

.dock-right.float-dock-enter-from,
.dock-right.float-dock-leave-to {
  transform: translateX(14px);
}

@media (prefers-reduced-motion: reduce) {
  .layer,
  .layer.off {
    transform: none;
    transition-duration: 120ms;
  }

  .dock-body {
    transition: none;
  }
}
</style>
