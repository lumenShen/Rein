<script setup lang="ts">
/**
 * 胶囊 chip：主页与画布上「一条短语（+ 可选前导点 / 尾部注）」的统一实现。
 *
 * **为什么要有它**：同一个主页上原本并存四套同类实现 —— 文字链（7×13px / 13px 字）、
 * 待办 chip（7×12px / 12px）、餐次 chip（5×10px / 11px）、详情胶囊（5×10px / 12px）。
 * 单看每一颗都不难看，排在一屏里就散：同一种视觉语法有四种尺寸。
 * 收成「两档尺寸 + 三档语气」，规格只有一份，以后改一处就是全站。
 *
 * 尺寸（差的是「一行放得下几颗」，不是随手 1px）：
 *   `md` 常规 12px 字 / 左右 12 内边距；`sm` 密集 12px 字 / 左右 8 内边距。
 *   两档高度都锁在 --chip-h（24px，胶囊 / 标签规格；--control-sm 的 28 是小按钮，
 *   不是标签 —— 一排胶囊与旁边的按钮同高会显得比按钮还壮）：
 *   11px 曾是 `sm` 的档位，但它是**可点**控件，低于 12px 的中文开始糊；
 *   密集只该省横向，不该省到读不清。
 * 语气（只决定正文色与强调，不改变形状）：
 *   `label` 中性内容（待办标题，最深一档）、`muted` 中性控件（导航、摘要）、
 *   `action` 去处（强调色 + 更重字重，按下去交给全局 `button:active`）。
 *
 * `as` 决定渲染成什么：**要点的传 `button`，纯展示的传 `span`**。
 * 主页那条「摄入总览」本身就是一整枚 `button`，里面凡是 chip 都必须是 `span`
 * （button 不能嵌 button），所以元素类型不能写死。
 */
withDefaults(
  defineProps<{
    /** 渲染元素：可点的用 `button`（自带按压反馈），纯展示用 `span` */
    as?: 'button' | 'span'
    /** 语气：中性内容 / 中性控件 / 去处 */
    tone?: 'label' | 'muted' | 'action'
    /** 尺寸：常规 / 密集 */
    size?: 'md' | 'sm'
  }>(),
  { as: 'span', tone: 'muted', size: 'md' },
)
</script>

<template>
  <component :is="as" class="chip" :class="[tone, size]">
    <slot />
  </component>
</template>

<style scoped>
.chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  max-width: 100%;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  /* 胶囊文字 12 Medium（Caption_L）：600 在这个尺寸上会读成「加粗过一遍」 */
  font-weight: var(--fw-medium);
  white-space: nowrap;
}

/* 可点的胶囊（as="button"）：视觉仍是 24 高的标签，热区用伪元素撑到 44。
   只对 button 生效 —— span 版本常被塞进另一个 button（button 不能嵌 button），
   给它加伪元素只会在父按钮里多出一块抢点击的死区。

   用 inset 简写而不是 height + transform：调用点若已经自己补过热区
   （HomeCanvas .detail / HomeTodoCard .all-link 的 ::after 都比这里特指度高），
   简写会被整条覆盖，不会残留一个孤零零的 translate 把热区顶偏。 */
button.chip::after {
  content: '';
  position: absolute;
  inset: calc(50% - var(--hit-min) / 2) 0;
  border-radius: var(--radius-full);
}

/* 胶囊 / 标签统一 24 高（--chip-h）、左右 12（--pad-inline）：
   此前两档都是 28 高，比规范高 4，一排胶囊在一行里比旁边的按钮还壮 */
.md {
  min-height: var(--chip-h);
  padding: 0 var(--pad-inline);
  font-size: var(--fs-caption);
}

/* 小号只收字号与左右内距，高度仍落在 24 —— 20 会让 12px 中文上下贴边 */
.sm {
  min-height: var(--chip-h);
  padding: 0 var(--sp-8);
  font-size: var(--fs-caption);
}

.label {
  color: var(--text-1);
}

.muted {
  color: var(--text-2);
}

.action {
  color: var(--accent-strong);
  font-weight: var(--fw-bold);
}

/* 前导圆点：四颗 chip 此前各写一份 7px，这里收一份。
   `:slotted` 是必须的 —— 点由使用方塞进插槽，属于父组件的作用域。 */
.chip :slotted(.dot) {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
}

/* 尾部注（时长 / 计数）：比正文浅一档。`label` 下才看得出层次，
   `muted` 下与正文同为 --text-2，是刻意的「不加戏」。 */
.chip :slotted(.trail) {
  font-style: normal;
  font-weight: var(--fw-medium);
  color: var(--text-2);
}
</style>
