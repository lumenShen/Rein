<script setup lang="ts">
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import { BENTO_SPANS, useBentoLayout } from '@/composables/useBentoLayout'

/**
 * 便当布局面板 —— 「拖动换位」的**键盘替代路径**。
 *
 * 抓手柄对指针用户是直接的（按住就拖），但触屏第一次点不出来、纯键盘更完全够不着。
 * 于是同一件事在这里有一份不用拖拽的实现：↑/↓ 调顺序、3/4/6/12 切列宽、一键回缺省。
 * 顺序即渲染顺序（「上移」= 在便当里往前挪一格），尺寸档与栅格共用一套列数。
 *
 * 状态与栅格是同一份（useBentoLayout 的模块单例）：面板里改一下，背后的便当当场重排，
 * 不需要确认按钮，也没有第二份草稿要同步。
 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { cells, isDefault, move, resize, reset } = useBentoLayout()
</script>

<template>
  <SheetModal :open="open" title="便当布局" @close="emit('close')">
    <!-- 背景性说明（顺序即便当顺序 / 会记住 / 怎么回缺省）三步就能试出来：
         收进标题行右侧的说明入口，面板面上直接是行列表 -->
    <template #action>
      <InfoHint
        title="便当布局"
        content="卡片顺序就是便当里的顺序。改成什么样都会记住，换设备 / 重新打开都还在。

想回到设计者的排法，按最下方「恢复默认」。"
      />
    </template>

    <ul class="rows">
      <li v-for="(c, i) in cells" :key="c.id" class="brow">
        <div class="brow-main">
          <b class="brow-name">{{ c.label }}</b>
          <span class="brow-meta t-3">{{ c.span }} 列{{ c.rows > 1 ? ' · 2 行' : '' }}</span>
        </div>

        <div class="brow-move">
          <button
            type="button"
            class="mini"
            :disabled="i === 0"
            :aria-label="`「${c.label}」上移`"
            @click="move(c.id, i - 1)"
          >
            <ArrowUp :size="15" :stroke-width="2.2" />
          </button>
          <button
            type="button"
            class="mini"
            :disabled="i === cells.length - 1"
            :aria-label="`「${c.label}」下移`"
            @click="move(c.id, i + 1)"
          >
            <ArrowDown :size="15" :stroke-width="2.2" />
          </button>
        </div>

        <div class="brow-size" role="group" :aria-label="`「${c.label}」宽度`">
          <!-- 这排裸数字唯一的可见口径；单位「列」由左侧「N 列」的选中说明给出 -->
          <span class="brow-size-t t-3">宽度</span>
          <button
            v-for="s in BENTO_SPANS"
            :key="s"
            type="button"
            class="size num"
            :class="{ on: c.span === s }"
            :aria-pressed="c.span === s"
            :aria-label="`「${c.label}」宽度 ${s} 列`"
            @click="resize(c.id, s)"
          >
            {{ s }}
          </button>
        </div>
      </li>
    </ul>

    <template #footer>
      <button type="button" class="reset pressable" :disabled="isDefault" @click="reset()">
        <RotateCcw :size="16" :stroke-width="2.2" />
        恢复默认
      </button>
    </template>
  </SheetModal>
</template>

<style scoped>
.brow {
  display: flex;
  align-items: center;
  /* 名称列与右侧两组按钮 12（--gap-md）；行内上下 8 —— 抽屉里的设置行节奏 */
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
  border-bottom: 0.5px solid var(--line);
}

.brow:last-child {
  border-bottom: 0;
}

.brow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 主次文本上下 2（--gap-text） */
  gap: var(--gap-text);
}

.brow-name {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.brow-meta {
  font-size: var(--fs-caption);
}

.brow-move {
  display: flex;
  gap: var(--sp-6);
  flex: none;
}

.mini {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.mini:disabled {
  /* 禁用浓度走令牌（tokens.css:37-40），不同按钮不再各写一档 */
  opacity: var(--disabled-opacity);
}

.brow-size {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  flex: none;
}

/* 「宽度」标签：这排裸数字的可见口径（caption / --text-3，与 .brow-meta 同档） */
.brow-size-t {
  font-size: var(--fs-caption);
}

.size {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
}

.size.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.reset {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  padding: var(--sp-12);
  /* 抽屉底部的主操作是按钮：圆角 20（--radius-l），与 .commit 同档 */
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.reset:disabled {
  /* 同上：禁用态不透明度统一引用令牌 */
  opacity: var(--disabled-opacity);
}
</style>
