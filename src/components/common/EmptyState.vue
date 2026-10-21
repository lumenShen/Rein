<script setup lang="ts">
import type { FunctionalComponent } from 'vue'

/** 空状态：图标 + 标题 + 提示。 */
defineProps<{
  icon: FunctionalComponent
  title: string
  hint?: string
}>()
</script>

<template>
  <div class="empty col center">
    <component :is="icon" :size="34" :stroke-width="1.6" />
    <p class="title">{{ title }}</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <!-- 行动出口：空状态的终点是引导用户走出空态 -->
    <div v-if="$slots.action" class="act">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
/* hint 承载的是**可执行指令**（「点下面的『记一笔』，第一笔就落在这个月」这类）——
   读不出来等于没写。--text-3 白底实测只有 3.6:1，抬到 --text-2（4.9:1）；
   图标尺寸大、本身不带信息，仍留在母级的 --text-3。 */
.empty {
  gap: var(--sp-6);
  /* 空状态是「一块占位区」：上下 28（--sp-28，吸附自 26）撑起呼吸，
     左右 12 与卡片内距同档，不贴卡片边 */
  padding: var(--sp-28) var(--sp-12);
  text-align: center;
  color: var(--text-3);
}

.title {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 居中短句折行时 balance 掉 1-2 个字的孤字尾行（「……住」「……可」这类读起来像 bug）。
   颜色提到 --text-2：hint 是用户照做的那句话，不吃三级灰那档（见 .empty 注释）。 */
.hint {
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-wrap: balance;
}

.act {
  /* 说明文字与操作按钮是两组：间隔 12（--gap-md） */
  margin-top: var(--gap-md);
}
</style>
