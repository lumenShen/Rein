<script setup lang="ts">
/**
 * Markdown 文本渲染（聊天气泡 / 纪要总结共用）。
 * streaming=true 时按块增量：已完成块缓存静态 HTML，仅末尾未完块重渲（见 utils/markdown）。
 */
import { computed } from 'vue'
import { renderBlock, splitBlocks } from '@/utils/markdown'

const props = defineProps<{ text: string; streaming?: boolean }>()

// 块级缓存（组件实例内）：签名 = 已完成块的原文
let cacheSig = ''
let cacheHtml: string[] = []

const html = computed(() => {
  const blocks = splitBlocks(props.text)
  const streaming = props.streaming === true
  const done = streaming ? blocks.slice(0, -1) : blocks
  const sig = done.join('\u0000')
  if (sig !== cacheSig) {
    cacheSig = sig
    cacheHtml = done.map(renderBlock)
  }
  const tail = streaming && blocks.length > 0 ? renderBlock(blocks[blocks.length - 1] ?? '') : ''
  return cacheHtml.join('') + tail
})
</script>

<template>
  <div class="md" v-html="html" />
</template>

<style scoped>
.md :deep(p) {
  margin: 0;
  line-height: inherit;
}

.md :deep(p + p) {
  /* 段落之间 6（--sp-6）：正文行高 1.5 之下，6 是「另起一段」的最小可见差 */
  margin-top: var(--sp-6);
}

.md :deep(ul),
.md :deep(ol) {
  margin: var(--gap-tight) 0 0;
  /* 列表缩进 18（--sp-18）：与项目符号的悬挂宽度对齐，比 16 多 2 才不挤字 */
  padding-left: var(--sp-18);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.md :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.9em;
  /* 底色取 --text-1 的混合而不是写死黑：写死的 6% 黑贴在暗色画布上等于没贴，
     气泡在亮暗两档都存在，合成后两档都读得出来 */
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  /* 行内代码只横向留白（--sp-4），纵向交给行高 —— 上下加 px 会把行撑开 */
  padding: 0 var(--sp-4);
  border-radius: var(--radius-xs);
}

.md :deep(.md-pre) {
  margin: var(--sp-6) 0 var(--gap-text);
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  overflow-x: auto;
}

.md :deep(.md-pre code) {
  background: none;
  padding: 0;
  white-space: pre;
}

.md :deep(.md-h) {
  margin-top: var(--sp-6);
}

/* 引用块：不用「3px 左边框强调条」——那是全库最泛滥的一块 slop。
   改成一整面 soft tint 底（与 AIPage 的引用块 .qblock、各处提示条同一套语言：
   靠面不靠线），tint 取 --text-1 的混合，亮暗两档各自成立。
   连续多行引用会渲染成相邻的几个 .md-quote：相邻选择器把缝、内侧圆角与内侧
   留白收掉，让它们读成一面底里的一段话，而不是一排碎块。 */
.md :deep(.md-quote) {
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  color: var(--text-2);
}

.md :deep(.md-quote + .md-quote) {
  margin-top: 0;
  padding-top: 0;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

/* 后面还跟着引用的那行：下圆角与下留白一并让给段尾 */
.md :deep(.md-quote:has(+ .md-quote)) {
  padding-bottom: 0;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

/* 表格：与全应用的表（.wtable / .matrix）同一套语言 —— 只有行分隔线，没有网格。
   外层 wrap 管横向滚动：手机气泡窄，宽表在表内滚，不把气泡撑破。
   对齐由 renderTable 写进单元格的 inline style（对齐是数据，不是主题）。 */
.md :deep(.md-table-wrap) {
  margin: var(--sp-6) 0 var(--gap-text);
  overflow-x: auto;
}

.md :deep(.md-table) {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-body);
}

.md :deep(.md-table th),
.md :deep(.md-table td) {
  /* 单元格 4×8（--sp-4 / --sp-8）：行高靠上下 4 撑开，窄表格也不糊成一片 */
  padding: var(--sp-4) var(--sp-8);
  border-bottom: 0.5px solid var(--line);
  color: var(--text-2);
  vertical-align: top;
  overflow-wrap: anywhere;
}

.md :deep(.md-table th) {
  font-weight: var(--fw-semibold);
  /* 表头与表体同档 --text-2：表头比数据还浅会层级倒置，加重只留字重 */
  color: var(--text-2);
  white-space: nowrap;
}

/* 表尾不画线：最后一条横线会让表看起来「没结束」 */
.md :deep(.md-table tbody tr:last-child td) {
  border-bottom: none;
}

/* 首列是行标签（「周一 / 胸 / 1月」这类）：加重一档，正文列才是数据 */
.md :deep(.md-table tbody td:first-child) {
  color: var(--text-1);
}
</style>
