<script setup lang="ts">
import { fmtNutrient } from '@/utils/format'
import type { MicroRow } from '@/utils/nutritionCalc'

/**
 * 微量营养素列表 · 食品详情与饮食记录详情共用。
 *
 * 两处此前各有一份逐像素相同的 `.micros / .mrow / .bar` 样式，而且数值格式
 * 一个走「≥100 取整、否则一位小数」、一个走「≥10 取整」—— 同一项 12.5mg 的
 * 钙在食品详情显示 12.5、在记录详情显示 13。现在格式与行结构都只有这一份。
 */
withDefaults(
  defineProps<{
    rows: MicroRow[]
    /** 进入动画：false 时进度条保持零宽，由父层的双 rAF 置 true */
    grown?: boolean
  }>(),
  { grown: true },
)
</script>

<template>
  <ul class="micros" :class="{ grown }">
    <li v-for="m in rows" :key="m.key">
      <div class="row between mrow">
        <span class="mlabel">
          {{ m.label }}<em v-if="m.isLimit" class="lim">上限</em>
        </span>
        <span class="mright">
          <span class="num mval">{{ fmtNutrient(m.value) }}<em class="munit"> {{ m.unit }}</em></span>
          <b class="num mpct">{{ m.pct }}%</b>
        </span>
      </div>
      <div class="bar">
        <div class="fill" :class="{ limit: m.isLimit }" :style="{ '--p': `${Math.min(m.pct, 100)}%` }" />
      </div>
    </li>
  </ul>
</template>

<style scoped>
.micros {
  /* 与上方含量行之间 8（标题/结论与内容一档） */
  margin-top: var(--gap-sm);
  padding-left: 0;
  list-style: none;
}

.micros li + li {
  /* 每条微量是一组「标签行 + 条」：组与组之间 16（有明显边界的区块） */
  margin-top: var(--gap-lg);
}

.mrow {
  /* 标签行与它下方的进度条：8 */
  margin-bottom: var(--gap-sm);
}

/* 实际含量 + 结论占比同一行右端：含量是详情，占比是结论 */
.mright {
  display: inline-flex;
  align-items: baseline;
  /* 实际含量与结论占比是两个不同的数：12 让它们不读成一串 */
  gap: var(--gap-md);
}

.mval {
  font-weight: var(--fw-semibold);
}

.mval em {
  font-style: normal;
  font-weight: var(--fw-regular);
  color: var(--text-3);
}

.mpct {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.mlabel {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.lim {
  font-style: normal;
  /* 名称与「上限」角标之间 8；角标上下 2 保住单行、左右 8 两字不贴边 */
  margin-left: var(--gap-sm);
  padding: var(--gap-text) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  /* 「高钠」是健康状态词，读不出来等于没标。soft 底上的文字走 strong 档
     （--c-sodium 是 danger 实底档，压 soft 底只有 3.5:1，STANDARDS §4） */
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.bar {
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--surface);
  overflow: hidden;
}

.fill {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.micros:not(.grown) .fill {
  clip-path: inset(0 100% 0 0 round var(--radius-full));
}

.fill.limit {
  background: var(--c-sodium);
}
</style>
