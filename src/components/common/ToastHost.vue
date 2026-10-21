<script setup lang="ts">
import GlassSurface from '@/components/common/GlassSurface.vue'
import { useToast } from '@/composables/useToast'

const { toasts } = useToast()

/**
 * 提示条：**唯一一处用折射表面的瞬时控件**（超高档下它会真的把背后的内容折一下，
 * 与底栏那三块同一套材质 —— 都是「离散小控件」）。
 *
 * 底色与其余玻璃**不同色**：这里传的是 `--surface` 的 86% 而不是 `--glass-fill`。
 * 提示条压的是任意页面内容、文字还是 nowrap 的一行短句 —— 玻璃底越薄，句子越过
 * 一句就看不清一句。所以它要的是「一块几乎不透明、但边缘仍然在折射的玻璃」，
 * fill 这个口子本来就是给这种「同一套材质、不同浓度」的场景留的
 * （Dock 那边传 --glass-fill 是为了与其余玻璃同色，理由见 TabBar）。
 * 弱档下 --surface 不变、全局关掉 blur，于是它落成一块实底 —— 仍然是读得清的。
 *
 * 原先这里写的是硬编码的 rgba(250,250,250,.92) / rgba(58,58,60,.94) 与写死的文字色：
 * 既是规范里的"魔法颜色"，也会在弱档下变成一层发灰的薄膜（半透明底没了 blur 兜底）。
 */
const TOAST_FILL = 'color-mix(in srgb, var(--surface) 86%, transparent)'
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <GlassSurface
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        width="auto"
        height="auto"
        border-radius="var(--radius-full)"
        :fill="TOAST_FILL"
      >
        <span class="txt">{{ t.text }}</span>
        <button v-if="t.action" class="tact" @click="t.action.run()">{{ t.action.label }}</button>
      </GlassSurface>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  /* 提示条与底栏之间 24（--sp-24，吸附自 26）：写死的 26 进不了 4/8 体系 */
  bottom: calc(var(--dock-top) + var(--sp-24) + var(--wbar-reserve, 0px));
  z-index: 120;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-sm);
  pointer-events: none;
}

/* 只定「排版 + 命中区」：材质（底 / 受光边 / 高光 / 投影 / 模糊）全在 GlassSurface 里 ——
   这里再写一遍 background 或 box-shadow 就会与它抢同一条声明，而胜负取决于样式表顺序 */
.toast {
  pointer-events: auto;
  gap: var(--gap-tight);
  max-width: min(78vw, 420px);
  /* 一条悬在底栏上的胶囊：上下 10 / 左右 20 —— 与胶囊（12）拉开一档，
     因为它承载的是一句完整的话，不是标签 */
  padding: var(--sp-10) var(--sp-20);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.txt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tact {
  flex: none;
  color: var(--accent);
  font-size: var(--fs-footnote);
  /* 800 不在字重阶梯上（只有 300–700 五档）：提到 Bold，观感不变 */
  font-weight: var(--fw-bold);
  padding: var(--sp-2) 0 var(--sp-2) var(--sp-10);
}

/* 出入同方向同向量：进来从下方 10px 升起、出去落回同一处，读作「同一条通道的
   两个方向」而不是两套动画；退场一律快于入场 —— 离场是收尾，不该和接手的
   下一步操作抢时间 */
.toast-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
}
.toast-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* 丰富档：提示条从**底栏那个方向**长出来（苹果那条「警告框的展开动画与触发它的
   按钮关联」）。提示条就悬在 Dock 上方，所以锚点取底边中点、从压扁的状态展开 ——
   读起来是"从底栏冒出来一条"，而不是"从上面掉下来一条"。
   默认档保持上面那套（自下 10px 淡入），一个字节不动。 */
html[data-motion='rich'] .toast {
  transform-origin: center bottom;
}

html[data-motion='rich'] .toast-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-liquid);
}
html[data-motion='rich'] .toast-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-liquid);
}

html[data-motion='rich'] .toast-enter-from,
html[data-motion='rich'] .toast-leave-to {
  transform: scale(0.86, 0.72);
}
</style>
