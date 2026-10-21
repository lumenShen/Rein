<script setup lang="ts">
import { computed } from 'vue'
import { Square, X } from 'lucide-vue-next'

import TitleBarBase from '@/components/layout/TitleBarBase.vue'
import type { GlobalFloatKind, GlobalFloatTone } from '@/types'

/**
 * 浮窗自绘标题栏（高 32 紧凑版）。
 *
 * 外壳与拖拽区走 layout/TitleBarBase（主窗口与浮窗共用同一份拖拽 / 双击判定），
 * 按钮视觉走 base.css 的全局 .wbtn（理由见那里的注释：slot 内容穿不过 scoped 样式，
 * 两个标题栏各写一份按钮必然漂）。本组件只决定「左边放什么、右边放什么」。
 *
 * 左侧是会话标题 + 状态点（专注 / 训练），右侧两颗：泊车为方块（把窗口收成 64×64）
 * 与关闭（本次失焦期不再自动出现，由主窗口的 globalFloat 落实）。空态（浏览器预览 /
 * 尚未收到会话）不给这两颗：没有会话可泊、也不该有「关闭」的承诺。
 */
const props = withDefaults(
  defineProps<{
    /** 会话标题：专注 / 训练课（空态时是「Rein 浮窗」，没有状态点语义） */
    title: string
    /** 会话种类：状态点的色相跟它走（关注与运动各用各自的领域色） */
    kind?: GlobalFloatKind
    /** 状态点语义：work 呼吸中 / break 中性 / paused 警示 / done 结束 */
    tone?: GlobalFloatTone
    /** 右侧两颗窗口按钮是否出现（空态没有可泊 / 可关的会话） */
    showActions?: boolean
  }>(),
  { showActions: true },
)

const emit = defineEmits<{ park: []; close: [] }>()

/** 状态点色：与内容区的 .dot 同一套语义色，但更小（8px）且不呼吸 ——
 *  标题栏是壳层，常驻动画会与内容区那颗呼吸点抢注意力。 */
const dotClass = computed(() => {
  if (!props.tone) return 'idle'
  if (props.tone === 'paused') return 'paused'
  if (props.tone === 'done') return 'done'
  if (props.tone === 'break') return 'break'
  return props.kind === 'workout' ? 'work-exercise' : 'work-focus'
})
</script>

<template>
  <TitleBarBase compact>
    <template #left>
      <span
        class="tb-dot"
        :class="dotClass"
      />
      <span class="tb-title">{{ title }}</span>
    </template>
    <template #right>
      <template v-if="showActions">
        <button
          type="button"
          class="wbtn"
          aria-label="泊车为方块"
          title="泊车为方块"
          @mousedown.stop
          @click="emit('park')"
        >
          <Square
            :size="14"
            :stroke-width="2.4"
          />
        </button>
        <button
          type="button"
          class="wbtn wbtn-danger"
          aria-label="关闭浮窗"
          title="关闭浮窗"
          @mousedown.stop
          @click="emit('close')"
        >
          <X
            :size="15"
            :stroke-width="2.4"
          />
        </button>
      </template>
    </template>
  </TitleBarBase>
</template>

<style scoped>
/* slot 内容不受 TitleBarBase 的 scoped 样式管辖，标题与色点的样式必须写在这里 */
.tb-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
  margin-right: var(--gap-sm);
}

.tb-dot.work-focus {
  background: var(--cat-work);
}

.tb-dot.work-exercise {
  background: var(--c-exercise);
}

.tb-dot.break {
  background: var(--cat-general);
}

.tb-dot.paused {
  background: var(--warn);
}

.tb-dot.done {
  background: var(--text-3);
}

.tb-title {
  min-width: 0;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.2px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
