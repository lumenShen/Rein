<script setup lang="ts">
/**
 * 语义色状态胶囊：把「soft 底 + strong 字」这一对只能成对使用的令牌收成一处。
 *
 * tokens.css 规定实底档（--ok / --warn / --danger / --accent）不当文字用 ——
 * --ok 落在 --ok-soft 上只有 1.95:1；soft 底上的文字一律走对应的 --*-strong。
 * 本组件是该规则的唯一实现：凡语义色胶囊都从这里出，不再逐处手写底/字色。
 *
 * 与 PillChip 的分工：PillChip 是**中性**胶囊（label / muted / action 三档语气），
 * 没有语义色；要表达状态语义（已满 / 必须更新 / 超支 / 待归类）用本组件。
 * 字号规格与 PillChip 对齐（sm 11px / md 12px），差的是「一行放得下几颗」。
 */
withDefaults(
  defineProps<{
    /** 语义档；neutral 是不带语义的中性胶囊 */
    tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'
    /** 尺寸：md 常规 12px / sm 密集 11px */
    size?: 'md' | 'sm'
    /** 渲染元素：可点的传 button，纯展示传 span */
    as?: 'span' | 'button'
  }>(),
  { tone: 'neutral', size: 'sm', as: 'span' },
)
</script>

<template>
  <component :is="as" class="schip" :class="[tone, size]">
    <slot />
  </component>
</template>

<style scoped>
.schip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  max-width: 100%;
  border-radius: var(--radius-full);
  /* 与 PillChip 同一档字重：状态词是 12px 的标签，不是标题 */
  font-weight: var(--fw-medium);
  white-space: nowrap;
}

/* 标签高 24（--chip-h）/ 左右 12（--pad-inline），与 PillChip 同尺寸 ——
   两者常并排出现在同一个卡头里，高度不同就会错基线 */
.md {
  min-height: var(--chip-h);
  padding: 0 var(--pad-inline);
  font-size: var(--fs-caption);
}

/* 微状态（在线 / 已同步）：20 高一档，左右收到 8 */
.sm {
  min-height: var(--sp-20);
  padding: 0 var(--sp-8);
  font-size: var(--fs-micro);
}

/* 五档语义：底色与字色成对，只在这里写一次 */
.neutral {
  background: var(--surface-2);
  color: var(--text-2);
}

.ok {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.warn {
  background: var(--warn-soft);
  color: var(--warn-strong);
}

.danger {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.accent {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
</style>
