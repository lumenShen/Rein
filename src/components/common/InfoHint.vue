<script setup lang="ts">
import { ref } from 'vue'
import { CircleQuestionMark } from 'lucide-vue-next'
import SheetModal from '@/components/common/SheetModal.vue'

/**
 * 卡面帮助入口：一枚浅灰 circle-? 图标按钮 + SheetModal 抽屉。
 *
 * 只承载**背景 / 口径 / 算法 / 换算 / 实现细节**这一类说明；
 * 结论、数值与单位、错误提示、可执行的下一步一律留在卡面上 —— 判据是
 * 「用户看完这句话要不要做一个动作」，要就留卡面，不要才收进来。
 *
 * 落点：页头走 PageHeader 的 #action 槽并挂 class="hdr-btn"；卡头放标题行右端
 * （卡头是 flex 行的用 margin-left:auto）；抽屉内走 SheetModal 的 #action 槽。
 * 同一行不放第二枚图标按钮，同屏两枚 ? 必须合并成一处入口。
 *
 * 样式只用令牌（docs/STANDARDS.md §4），图标按钮必带 aria-label、必有可见按压态。
 */
const props = defineProps<{
  /** 抽屉标题；同时作为按钮 aria-label 的语义前缀 */
  title: string
  /**
   * 抽屉正文（纯文本，空行分段）。
   * 需要图、代码块、URL、表格、强调这类富内容时留空，改用默认插槽。
   */
  content?: string
}>()

const open = ref(false)
</script>

<template>
  <button
    type="button"
    class="info-hint"
    :aria-label="`${props.title}：说明`"
    @click="open = true"
  >
    <CircleQuestionMark :size="16" />
  </button>

  <SheetModal
    :open="open"
    :title="props.title"
    initial-snap="medium"
    @close="open = false"
  >
    <div class="info-hint-body">
      <slot>
        <p v-for="(para, i) in (props.content ?? '').split('\n\n')" :key="i">{{ para }}</p>
      </slot>
    </div>
  </SheetModal>
</template>

<style scoped>
.info-hint {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex: none;
}

/* 视觉 28px 不变，热区撑到 44×44。它是卡头里唯一的「问一句」入口，
   28 的图标按起来太小；外扩的 8px 落在标题行的空白里。 */
.info-hint::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.info-hint:active {
  background: var(--surface-2);
  transform: scale(0.94);
}

@media (hover: hover) {
  .info-hint:hover {
    color: var(--text-2);
  }
}

.info-hint-body {
  display: flex;
  flex-direction: column;
  /* 说明段落之间 10（--sp-10），行高走正文档 --lh-body —— 原来 1.6 让
     这种短说明在小气泡里读起来比正文还松 */
  gap: var(--sp-10);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.info-hint-body p {
  margin: 0;
}
</style>
