<script setup lang="ts">
/**
 * 一个「user 回合」段：段内消息按原顺序渲染，事件全部原样转发给页面
 * （长按菜单 / 键盘 / 引用 / 撤回 / 文件 / 食物卡都仍由 AIPage 一处实现）。
 *
 * 不在这里做布局定位：段的外层 `.virtual-seg` 由页面持有，窗口化与实测高度
 * 都发生在页面层（useVirtualChat）。
 */
import ChatMessage from './ChatMessage.vue'
import { useAiStore } from '@/stores/ai'
import type { ChatSegment } from '@/ai/chatSegments'
import type { MealType } from '@/types'

defineOptions({ inheritAttrs: false })

defineProps<{
  segment: ChatSegment
  /** 流式气泡 id（原 AIPage 的 ai.streamingBubbleId） */
  streamingBubbleId: string | null
  mealOf: (messageId: string) => MealType
  expandedOf: (messageId: string) => boolean | undefined
  flashId: string | null
}>()

const ai = useAiStore()
</script>

<template>
  <div class="chat-segment" :data-seg-id="segment.id">
    <ChatMessage
      v-for="m in segment.messages"
      :key="m.id"
      v-bind="$attrs"
      :message="m"
      :meta="ai.getMeta(m.id)"
      :streaming-bubble-id="streamingBubbleId"
      :meal-of="mealOf"
      :expanded-of="expandedOf"
      :flash-id="flashId"
    />
  </div>
</template>

<style scoped>
/* flow-root：让段内最后一条消息的 margin-bottom 计入段高（spacer 数学依赖它） */
.chat-segment {
  display: flow-root;
}
</style>
