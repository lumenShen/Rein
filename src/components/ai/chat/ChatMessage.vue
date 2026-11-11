<script setup lang="ts">
/**
 * 一条聊天消息（从 AIPage 的原模板逐条抽出）。
 *
 * 保留全部渲染分支与交互契约：过程折叠、引用块、照片/文档、Markdown 正文与
 * 流式光标、语音轮、食物解析卡、分析卡、文件卡；长按/右键/键盘事件只负责
 * 把「目标元素」一并抛给页面（菜单锚点因此不会在 450ms 定时器里丢）。
 *
 * 这个组件不持有不可重建的业务状态：
 * - 过程区是否展开由页面按消息 id 受控（`expandedOf`），滚动回收后仍保持；
 * - 食物卡编辑态在 FoodParseEditor 内部，基准克重已提升为模块级 WeakMap；
 * - 工具抽屉打开时页面把该段 pin 在窗口内（detail-open/close）。
 */
import { computed } from 'vue'
import { Archive, ChartPie, Check, FileText, Mic } from 'lucide-vue-next'

import ChatFileCard from '@/components/ai/ChatFileCard.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import MdText from '@/components/common/MdText.vue'
import ProcessSection from '@/components/ai/ProcessSection.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import { MEAL_LABELS, MEAL_ORDER } from '@/config/domain'
import { fmtMmSs } from '@/utils/format'
import type { StreamBubbleMeta } from '@/ai/streamBubbles'
import type { ChatMessage as ChatMessageModel } from '@/ai/chatSegments'
import type { KbEntry, MealType, ParsedFoodItem } from '@/types'

const props = defineProps<{
  message: ChatMessageModel
  meta: StreamBubbleMeta | null
  streamingBubbleId: string | null
  /** 页面级「每张解析卡选中的餐次」（默认按当前时间推荐） */
  mealOf: (messageId: string) => MealType
  /** 页面级受控展开状态：undefined = 交给 ProcessSection 自己的自动开合 */
  expandedOf: (messageId: string) => boolean | undefined
  /** 跳转高亮：命中的消息 id（2s 后由页面清空） */
  flashId: string | null
}>()

const emit = defineEmits<{
  'press-start': [event: PointerEvent, message: ChatMessageModel, el: HTMLElement]
  'press-move': [event: PointerEvent]
  'press-end': []
  'ctx-menu': [event: MouseEvent, message: ChatMessageModel, el: HTMLElement]
  'message-key': [event: KeyboardEvent, message: ChatMessageModel, el: HTMLElement]
  'open-memo': [memoId: string]
  commit: [messageId: string, meal: MealType]
  stash: [message: ChatMessageModel]
  'update-items': [messageId: string, items: ParsedFoodItem[]]
  'update-meal': [messageId: string, meal: MealType]
  'update-process': [messageId: string, expanded: boolean]
  'detail-open': [messageId: string]
  'detail-close': [messageId: string]
  'open-file': [file: KbEntry]
  'height-dirty': [messageId: string]
}>()

const segmentsMeta = computed(() => props.meta?.segments ?? [])
const flash = computed(() => props.flashId === props.message.id)

/** 正文气泡是否有东西可渲染：有正文，或流式中且还没有过程区（显示打字点）。
 *  与 AIPage 原有的 showTextBubble 完全同条件。 */
const textVisible = computed(() => {
  const m = props.message
  if (m.kind !== 'text') return false
  if (m.text) return true
  return !!m.streaming && segmentsMeta.value.length === 0
})

function msgImages(): { base64: string; mime: string }[] {
  const m = props.message
  if (m.images?.length) return m.images.map((im) => ({ base64: im.base64, mime: im.mime }))
  return m.imageBase64 ? [{ base64: m.imageBase64, mime: m.mime ?? 'image/jpeg' }] : []
}

function fmtVoiceDur(ms: number): string {
  return fmtMmSs(ms)
}

function onPointerDown(e: PointerEvent): void {
  const el = e.currentTarget
  if (el instanceof HTMLElement) emit('press-start', e, props.message, el)
}

function onContext(e: MouseEvent): void {
  const el = e.currentTarget
  if (el instanceof HTMLElement) emit('ctx-menu', e, props.message, el)
}

function onKey(e: KeyboardEvent): void {
  const el = e.currentTarget
  if (el instanceof HTMLElement) emit('message-key', e, props.message, el)
}

function onVoiceClick(): void {
  const memoId = props.message.voiceMeta?.memoId
  if (memoId) emit('open-memo', memoId)
}

function onItems(items: ParsedFoodItem[]): void {
  emit('update-items', props.message.id, items)
}

function onMeal(value: string): void {
  emit('update-meal', props.message.id, value as MealType)
}

function onProcessExpanded(expanded: boolean): void {
  emit('update-process', props.message.id, expanded)
}

function onDetailOpen(): void {
  emit('detail-open', props.message.id)
}

function onDetailClose(): void {
  emit('detail-close', props.message.id)
}

function onImageLoad(): void {
  emit('height-dirty', props.message.id)
}
</script>

<template>
  <div
    :id="`msg-${message.id}`"
    class="msg"
    :class="[message.role, { flash }]"
    :data-msg-id="message.id"
    role="group"
    tabindex="0"
    :aria-label="`${message.role === 'user' ? '我' : 'AI'} 的消息（回车打开操作菜单）`"
    @keydown="onKey"
    @pointerdown="onPointerDown"
    @pointermove="emit('press-move', $event)"
    @pointerup="emit('press-end')"
    @pointerleave="emit('press-end')"
    @pointercancel="emit('press-end')"
    @contextmenu.prevent="onContext"
  >
    <div class="msg-col">
      <!-- 推理过程 + 工具调用合并区块：单行摘要标题，进行中展开、完成后自动折叠 -->
      <ProcessSection
        v-if="segmentsMeta.length"
        :segments="segmentsMeta"
        :is-thinking="meta?.isThinking ?? false"
        :thinking-sec="meta?.thinkingSec ?? 0"
        :final="message.id !== streamingBubbleId"
        :expanded="expandedOf(message.id) ?? null"
        @update:expanded="onProcessExpanded"
        @detail-open="onDetailOpen"
        @detail-close="onDetailClose"
      />

      <!-- 引用块 -->
      <p v-if="message.quoteText" class="qblock">{{ message.quoteText }}</p>

      <!-- 照片（可多图；可带随图文字，图与文分气泡，同属一条消息） -->
      <template v-if="message.kind === 'photo' && (message.imageBase64 || message.images?.length)">
        <div class="photo-bubble" :class="{ multi: (message.images?.length ?? 0) > 1 }">
          <img
            v-for="(im, i) in msgImages()"
            :key="i"
            :src="`data:${im.mime};base64,${im.base64}`"
            alt="用户上传的照片"
            @load="onImageLoad"
          >
        </div>
        <p v-if="message.text" class="bubble">{{ message.text }}</p>
      </template>

      <!-- 文档消息（解析文本随消息发给模型，气泡展示卡片与勾选的内嵌图） -->
      <template v-else-if="message.kind === 'doc' && message.doc">
        <div class="doc-card">
          <FileText :size="16" />
          <div class="dc-info">
            <p class="dc-name">{{ message.doc.name }}</p>
            <p class="dc-meta dc-meta-row">
              <span class="dc-facts"><span class="num">{{ message.doc.chars }}</span> 字{{ message.doc.truncated ? '（已截断）' : '' }} · 图片 <span class="num">{{ message.doc.imagesTotal }}</span> 张</span>
              <template v-if="message.doc.skippedImages > 0">
                <StatusChip tone="warn">跳过 <span class="num">{{ message.doc.skippedImages }}</span> 张图</StatusChip>
                <InfoHint title="被跳过的图片" content="文档里的内嵌图只有一部分会发给 AI：不支持的格式、体积过小的图标或装饰图、重复出现的图，以及超出数量上限的图会被跳过。跳过的图不参与推理，正文不受影响。" />
              </template>
            </p>
          </div>
        </div>
        <div v-if="message.images?.length" class="photo-bubble multi">
          <img
            v-for="(im, i) in message.images"
            :key="i"
            :src="`data:image/jpeg;base64,${im.base64}`"
            alt="文档内嵌图片"
            @load="onImageLoad"
          >
        </div>
        <p v-if="message.text" class="bubble">{{ message.text }}</p>
      </template>

      <!-- 纯文本（Markdown 渲染，流式按块增量；正文还没到就显示打字点） -->
      <div v-else-if="textVisible" class="bubble">
        <MdText v-if="message.text" :text="message.text" :streaming="message.streaming" />
        <span v-if="message.text && message.streaming" class="caret" aria-hidden="true" />
        <span v-else-if="!message.text" class="tdots" aria-hidden="true"><i /><i /><i /></span>
      </div>

      <!-- 语音轮（转写 + 关联纪要，点开语音会话回看/重放） -->
      <button v-else-if="message.kind === 'voice'" class="voice-bub" @click="onVoiceClick">
        <span class="vb-head"><Mic :size="13" /> 语音<span v-if="message.voiceMeta" class="num">&nbsp;{{ fmtVoiceDur(message.voiceMeta.durationMs) }}</span> · 会议纪要</span>
        <span class="vb-txt">{{ (message.text ?? '').slice(0, 72) }}{{ (message.text ?? '').length > 72 ? '…' : '' }}</span>
        <span class="vb-go">查看纪要 ›</span>
      </button>

      <!-- 食物解析卡（行内改重量 / 删行，未匹配项不会写入） -->
      <div v-else-if="message.kind === 'food-parse' && message.items" class="parse">
        <p class="parse-title">识别到 <span class="num">{{ message.items.length }}</span> 项食物</p>
        <FoodParseEditor
          :model-value="message.items"
          @update:model-value="onItems"
          @change="onImageLoad"
        />

        <template v-if="!message.committed">
          <SegmentedControl
            class="meal"
            :model-value="mealOf(message.id)"
            :options="MEAL_ORDER.map((x) => ({ value: x, label: MEAL_LABELS[x] }))"
            @update:model-value="onMeal"
          />
          <div class="row actions">
            <button
              class="stash"
              :disabled="message.items.length === 0"
              @click="emit('stash', message)"
            >
              <Archive :size="14" /> 存草稿箱
            </button>
            <button
              class="commit"
              :disabled="message.items.every((it) => it.foodId == null)"
              @click="emit('commit', message.id, mealOf(message.id))"
            >
              加入记录
            </button>
          </div>
          <p v-if="message.items.every((it) => it.foodId == null)" class="parse-hint">
            全部未匹配到食物库，无法直接写入 —— 可先存草稿，稍后调整。
          </p>
        </template>
        <p v-else class="committed">
          <Check :size="14" />
          {{ message.mealType ? `已写入今日${MEAL_LABELS[message.mealType]}` : '已写入今日饮食' }}
        </p>
      </div>

      <!-- 分析卡 -->
      <div v-else-if="message.kind === 'analysis'" class="analysis">
        <p class="a-title row center"><ChartPie :size="15" /> 今日饮食分析</p>
        <p class="a-body">{{ message.text }}</p>
      </div>

      <!-- AI 挂出的工作区文件（present_file）：点在聊天里，开在文件页里。 -->
      <div v-if="message.files?.length" class="msg-files">
        <ChatFileCard
          v-for="f in message.files"
          :key="f.path"
          :file="f"
          @open="emit('open-file', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 气泡之间 8：同一屏里每条消息的独立性靠这条固定节奏读出来 */
.msg {
  margin-bottom: var(--gap-sm);
  display: flex;
  /* 长按期间的按压反馈。只换底色不缩放：消息行是通栏容器，
     transform 会把正文宽度一起改掉 */
  transition: background-color var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .msg:hover {
    background-color: var(--surface-inset);
    border-radius: var(--radius-m);
  }
}

.msg:active {
  background-color: var(--surface-2);
  border-radius: var(--radius-m);
}

.msg.user {
  justify-content: flex-end;
}

.msg.assistant {
  justify-content: flex-start;
}

/* 文本消息容器（可带思考折叠框） */
.msg-col {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  max-width: 82%;
}

.msg.user .msg-col {
  align-items: flex-end;
}

.msg.assistant .msg-col {
  align-items: flex-start;
}

.msg-col .bubble {
  max-width: 100%;
}

/* 跳转高亮：2s 内淡出（#msg-<id> 的 .flash，见 useVirtualChat.scrollToMessage） */
.msg.flash {
  animation: msg-flash 2s ease-out;
  border-radius: var(--radius-m);
}

@keyframes msg-flash {
  0%,
  55% {
    background-color: var(--accent-soft);
  }
  100% {
    background-color: transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .msg.flash {
    animation-duration: 1s;
  }
}

/* 引用块（气泡内）：强调改走整面 accent soft tint，不再靠左边框（side-tab 收编） */
.qblock {
  max-width: 82%;
  padding: var(--sp-6) var(--sp-10);
  background: var(--accent-soft);
  border-radius: var(--radius-m);
  color: var(--text-1);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg.user .qblock {
  align-self: flex-end;
}

/* 照片气泡 */
.photo-bubble {
  max-width: 74%;
  border-radius: var(--radius-l);
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
}

.photo-bubble img {
  display: block;
  width: 100%;
  max-height: 220px;
  object-fit: cover;
}

.photo-bubble.multi {
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.photo-bubble.multi img {
  width: calc(50% - 1px);
  max-height: 150px;
}

/* 文档消息卡（用户发过的文档） */
.doc-card {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  max-width: 86%;
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
}

.dc-info {
  min-width: 0;
}

.dc-name {
  font-weight: var(--fw-medium);
  font-size: var(--fs-footnote);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-meta {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.dc-meta-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-tight) var(--gap-sm);
}

/* 气泡：内距 12（竖向）/ 16（横向），行高走正文档。 */
.bubble {
  max-width: 82%;
  padding: var(--sp-12) var(--sp-16);
  border-radius: var(--radius-l);
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.msg.user .bubble {
  background: var(--accent);
  color: var(--on-accent);
  border-bottom-right-radius: var(--radius-xs);
}

.msg.assistant .bubble {
  background: var(--surface);
  box-shadow: var(--shadow-card);
  border-bottom-left-radius: var(--radius-xs);
}

/* 流式打字光标与打字点（仅流式占位气泡） */
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: var(--sp-2);
  vertical-align: -0.12em;
  background: var(--text-2);
  animation: rein-caret-blink 1s steps(2, start) infinite;
}

.tdots {
  display: inline-flex;
  gap: var(--gap-tight);
  padding: var(--sp-2) 0;
}

.tdots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-3);
  animation: tdots-pulse 1.2s ease-in-out infinite;
}

.tdots i:nth-child(2) { animation-delay: 0.15s; }
.tdots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes tdots-pulse {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

@media (prefers-reduced-motion: reduce) {
  .caret,
  .tdots i {
    animation: none;
  }
}

/* 解析卡 */
.parse,
.analysis {
  width: 92%;
  max-width: 360px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  border-radius: var(--radius-m);
  border-bottom-left-radius: var(--radius-xs);
  padding: var(--pad-card);
}

.parse-title {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  margin-bottom: var(--gap-sm);
}

.meal {
  margin-top: var(--sp-10);
}

/* 解析卡的两个去向：存草稿（次要）/ 加入记录（主操作）。 */
.actions {
  margin-top: var(--gap-md);
  gap: var(--gap-sm);
  justify-content: flex-end;
}

.stash {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.stash:disabled {
  opacity: var(--disabled-opacity);
}

.parse-hint {
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.commit {
  min-height: var(--control-md);
  padding: 0 var(--sp-20);
  border-radius: var(--radius-full);
  background: var(--ok);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.committed {
  margin-top: var(--gap-md);
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--ok-strong);
}

/* 分析卡 */
.a-title {
  gap: var(--gap-sm);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--accent);
  margin-bottom: var(--gap-tight);
}

.a-body {
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

/* AI 挂出的文件卡片列 */
.msg-files {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--gap-tight);
  width: 100%;
  max-width: 100%;
}

/* 语音轮气泡（用户侧，点开语音会话回看纪要/重放） */
.voice-bub {
  max-width: 82%;
  padding: var(--sp-12) var(--sp-16);
  border-radius: var(--radius-l);
  border-bottom-right-radius: var(--radius-xs);
  background: var(--accent);
  color: var(--on-accent);
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
}

.voice-bub .vb-head {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  opacity: 0.92;
}

.voice-bub .vb-txt {
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
}

.voice-bub .vb-go {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

/* 气泡内 Markdown（MdText 渲染的内容不带 pre-line，由块级元素控制行距） */
.bubble :deep(.md) {
  font-size: inherit;
  line-height: inherit;
}

/* 消息长按菜单：长按窗口内禁用原生文本选择，避免与「长按弹菜单」抢手势。
   只压 :active 这一拍，且限定 coarse —— 鼠标拖选复制不受影响。 */
@media (pointer: coarse) {
  .msg:active {
    user-select: none;
    -webkit-user-select: none;
  }
}
</style>
