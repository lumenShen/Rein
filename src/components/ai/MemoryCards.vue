<!--
  顶部记忆卡（方案 §8.3）：Dream 摘要 + 常驻锚点。
  - 不参与聊天虚拟滚动：由 AIPage 放在虚拟体之前，作为普通 block。
  - 卡片最多 3 张；内容来自 memory store 的注入结果（自动注入严格只读）。
  - anchorMessageId 为空（撤回/清空后后端置 NULL）时只给「查看记忆」，不跳原文。
-->
<script setup lang="ts">
import { computed } from 'vue'
import type { MemoryInjectShard } from '@/types'

const props = defineProps<{
  cards: MemoryInjectShard[]
  /** Dream 正在跑时显示一条低干扰状态行 */
  dreaming?: boolean
}>()

const emit = defineEmits<{
  jump: [payload: { anchorMessageId: string; chatId: string }]
  open: [payload: { shardId: number }]
  dismiss: [shardId: number]
}>()

const shown = computed(() => props.cards.slice(0, 3))

function badgeOf(card: MemoryInjectShard): string {
  if (card.origin === 'marked_important') return '重要'
  if (card.reason === 'digest' || card.origin === 'dream_summary') return '梦境摘要'
  if (card.origin === 'manual_write') return '长期记忆'
  if (card.origin === 'conversation') return '对话记忆'
  if (card.reason === 'relevant') return '相关'
  return '记忆'
}

function toneOf(card: MemoryInjectShard): string {
  if (card.origin === 'marked_important') return 'is-important'
  if (card.reason === 'digest' || card.origin === 'dream_summary') return 'is-dream'
  if (card.origin === 'conversation') return 'is-conversation'
  return 'is-manual'
}

function jumpTo(card: MemoryInjectShard): void {
  if (!card.anchorMessageId || !card.chatId) return
  emit('jump', { anchorMessageId: card.anchorMessageId, chatId: card.chatId })
}
</script>

<template>
  <section
    v-if="shown.length || dreaming"
    class="memory-cards"
    data-testid="memory-cards"
    aria-label="记忆提示"
  >
    <article
      v-for="card in shown"
      :key="card.shardId"
      class="memory-card"
      :class="toneOf(card)"
      data-testid="memory-card"
    >
      <header class="mc-head">
        <span class="mc-badge">{{ badgeOf(card) }}</span>
        <span v-if="card.topic" class="mc-topic">{{ card.topic }}</span>
        <span v-else-if="card.category" class="mc-topic">{{ card.category }}</span>
        <button
          class="mc-close"
          type="button"
          aria-label="隐藏这条记忆卡"
          @click="emit('dismiss', card.shardId)"
        >
          ×
        </button>
      </header>
      <p class="mc-text">{{ card.content }}</p>
      <footer class="mc-foot">
        <button
          v-if="card.anchorMessageId && card.chatId"
          class="mc-link"
          type="button"
          @click="jumpTo(card)"
        >
          查看原文
        </button>
        <button
          v-else
          class="mc-link muted"
          type="button"
          @click="emit('open', { shardId: card.shardId })"
        >
          查看记忆
        </button>
      </footer>
    </article>

    <p v-if="dreaming" class="mc-dreaming" aria-live="polite">
      <span class="mc-dot" aria-hidden="true" />
      AI 正在整理记忆…
    </p>
  </section>
</template>

<style scoped>
.memory-cards {
  display: flex;
  align-items: stretch;
  gap: var(--gap-sm);
  padding: var(--sp-2) 0 var(--sp-6);
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.memory-cards::-webkit-scrollbar {
  display: none;
}

.memory-card {
  position: relative;
  flex: 0 0 min(280px, 78vw);
  display: grid;
  gap: var(--sp-4);
  padding: var(--sp-10) var(--sp-12);
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.memory-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--sp-10);
  bottom: var(--sp-10);
  width: 2px;
  border-radius: var(--radius-full);
  background: var(--accent);
  opacity: 0.55;
}
.memory-card.is-important::before {
  background: var(--warning, var(--accent));
  opacity: 1;
}
.memory-card.is-dream::before {
  background: var(--accent);
  opacity: 0.9;
}
.memory-card.is-conversation::before {
  background: var(--text-3);
  opacity: 0.5;
}

.mc-head {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  min-height: 20px;
}
.mc-badge {
  flex: none;
  padding: 1px var(--sp-8);
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  background: var(--accent-soft);
  color: var(--accent);
}
.is-important .mc-badge {
  background: var(--accent-soft);
  color: var(--accent);
}
.is-conversation .mc-badge {
  background: var(--surface-3);
  color: var(--text-2);
}
.mc-topic {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.mc-close {
  position: relative;
  flex: none;
  margin-left: auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-full);
  background: none;
  color: var(--text-3);
  font-size: 18px;
  line-height: 1;
}
.mc-close::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.mc-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-1);
}

.mc-foot {
  display: flex;
  justify-content: flex-end;
}
.mc-link {
  position: relative;
  min-height: var(--control-sm);
  padding: 0;
  border: none;
  background: none;
  font-size: var(--fs-caption);
  color: var(--accent);
}
.mc-link::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}
.mc-link.muted {
  color: var(--text-2);
}

.mc-dreaming {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  align-self: center;
  flex: none;
  padding: 0 var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.mc-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--accent);
  animation: mc-pulse 1.4s ease-in-out infinite;
}
@keyframes mc-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mc-dot {
    animation: none;
    opacity: 0.7;
  }
}
</style>
