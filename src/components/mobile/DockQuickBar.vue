<script setup lang="ts">
import { Mic, Plus, SendHorizontal } from 'lucide-vue-next'

/**
 * 底栏合并重构 · AI 快捷输入行（一块玻璃里的上排）。
 *
 * 参考构图（2026-11）：输入行铺满玻璃、页签行摊开在下 —— 底栏从此每个页面都带着
 * AI 入口，不再只有 AI 页有输入框。控件配方与 AI 页完整输入条（.inbar）同一档：
 * 40px 圆钮 + ::after 外扩 44 热区 + 9% 浅色层，「细一号」就读不成同一条底栏了。
 *
 * 真实 Dock（TabBar）传 interactive 走完整交互；画质预览页的标本传 interactive=false
 * 拿**静态复本** —— readonly + 整行 pointer-events:none + tabindex 全摘，但 DOM 结构
 * 与类名逐一同源，e2e-perf-glass 的「标本与真实 Dock 逐项一致」才有得比。
 * （不用 disabled：禁用态的透明度会改计算样式，比对就漂了。）
 *
 * 行为归调用方：send / add / voice-down 只上报事件 —— 发送链路（askFrom → AI 页）、
 * 语音会话（aiVoiceInput）与草稿归属都是 TabBar 的事，本组件零业务。
 */
withDefaults(
  defineProps<{
    modelValue: string
    interactive?: boolean
    placeholder?: string
  }>(),
  {
    interactive: true,
    placeholder: '点击输入或按住说话…',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 「+」：去 AI 页完整输入条（附件 / 文档在那边） */
  add: []
  /** 发送（Enter 或发送钮）：调用方决定怎么把话递给 AI 页 */
  send: []
  /** 麦克风按下的原始指针事件：按住说话 / 轻点连听的手势在调用方结算 */
  'voice-down': [e: PointerEvent]
}>()
</script>

<template>
  <div class="dock-quick" :class="{ static: !interactive }" :aria-hidden="interactive ? undefined : 'true'">
    <button
      type="button"
      class="qk-btn qk-add"
      :tabindex="interactive ? undefined : -1"
      aria-label="打开 AI，添加图片或文件"
      @click="emit('add')"
    >
      <Plus :size="22" :stroke-width="2" />
    </button>
    <input
      class="qk-input"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      :readonly="!interactive"
      :tabindex="interactive ? undefined : -1"
      enterkeyhint="send"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter.exact.prevent="emit('send')"
    >
    <!-- 空态 = 麦克风、有字 = 发送（对齐参考构图：参考图空态没有独立发送钮）。
         两个钮都常驻 DOM（v-show 开关）：e2e 的「打字后发送钮」断言与读屏可达性
         都按「存在且可按」算；藏起来的那颗 tabindex 由 v-show 自然不可达。 -->
    <button
      v-show="!modelValue.trim()"
      type="button"
      class="qk-btn qk-voice"
      data-testid="dock-voice-btn"
      :tabindex="interactive ? undefined : -1"
      aria-label="语音输入：按住说话，轻点连听"
      @pointerdown="emit('voice-down', $event)"
      @contextmenu.prevent
    >
      <Mic :size="22" :stroke-width="2" />
    </button>
    <button
      v-show="!!modelValue.trim()"
      type="button"
      class="qk-btn qk-send"
      :class="{ ready: !!modelValue.trim() }"
      :tabindex="interactive ? undefined : -1"
      :disabled="interactive ? !modelValue.trim() : true"
      aria-label="发送到 AI"
      @click="emit('send')"
    >
      <SendHorizontal :size="21" :stroke-width="2" />
    </button>
  </div>
</template>

<style scoped>
/* 行本体：玻璃内的**嵌套浅色层**（不是又一块玻璃 —— 嵌套 div 不带受光边，
   不会在缝上画出月牙硬边；底取 --surface-translucent，与 AI 页 .cbar 同一档，
   承载占位文字的对比度才够）。上、左、右缩 --gap-tight，底与页签行直接衔接。 */
.dock-quick {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  height: 52px;
  margin: var(--gap-tight) var(--gap-tight) 0;
  padding: 0 var(--gap-tight);
  border-radius: var(--radius-full);
  background: var(--surface-translucent);
}

.dock-quick.static {
  pointer-events: none;
}

/* 纯图标钮（2026-11-08 像素级对齐参考构图）：参考图的 ＋ / 麦克风没有圆片底，
   就是直接压在输入胶囊上的图标 —— 灰圆片让输入行读成「三颗钮的工具栏」，
   而参考是「一条输入条」。40×40 保留为触控几何，::after 外扩 44 热区不动。 */
.qk-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-2);
  transition:
    color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.qk-btn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
}

.qk-btn:active {
  color: var(--text-1);
  transform: scale(0.92);
}

/* 语音是持续手势：touch-action 关掉浏览器把按压当滚动/长按起点的默认处理 */
.qk-voice {
  touch-action: none;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
}

.qk-input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  font-family: inherit;
  color: var(--text-1);
  border: none;
  outline: none;
  background: transparent;
}

/* 占位与 AI 页同一条配方：--text-1 的 64% 合成，两色主题都够 4.7:1（见那边实测） */
.qk-input::placeholder {
  color: color-mix(in srgb, var(--text-1) 64%, transparent);
}

/* 有话待发时点亮：没有圆片底可填，主操作改**accent 前景**（参考图里按钮都是
   纯描边，实底圆片会让发送钮在窄输入行里重新读成一颗「工具钮」） */
.qk-send.ready {
  color: var(--accent-strong);
}

.qk-send:disabled {
  opacity: var(--disabled-opacity);
}
</style>
