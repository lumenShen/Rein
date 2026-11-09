<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Mic, Plus, SendHorizontal } from 'lucide-vue-next'

/**
 * 全局唯一的输入条（2026-11-09 用户定稿）—— **AI 页与其余页面的输入框从此是同一个组件**：
 * 同一根输入行、同一层薄底、同一组图标、同一套回车语义。差别只在调用方给的上下文
 * （占位文字 / 「+」的去向 / 语音手势的宿主 / 发送落点），不在外观。
 *
 * 视觉定稿（用户拿两张真机图逐项比对后的结论）：
 *   · 不要 AI 页旧 `.cbar` 的边框、落影与玻璃 —— 那是「浮在页面上的另一块玻璃」；
 *   · 也不要快捷输入行原来的完全透明 —— 那读不出「这里能输入」；
 *   · 只留一层薄底：暗色 = 一点点提亮，亮色 = 一点点灰（`--field-fill`，文字色 7% 合成，
 *     同一支公式随主题翻面）；
 *   · 圆角走 `--dock-radius-in`（= 玻璃外圈半径 − 内缩一档），与 Dock 的外圈**同心**，
 *     不再各自写 999px（见 tokens.css 的同心圆链）。
 *
 * 行为：回车 = 提交（落点由调用方定 —— TabBar 的 sendQuick 是「递话 + 去 AI 页」，
 * AI 页的 send 是原地发送）；Shift+回车换行；输入时自己长高到 5 行；组合输入中的
 * 回车不发送（isComposing）。
 *
 * 真实 Dock（TabBar）传 interactive 走完整交互；画质预览页的标本传 interactive=false
 * 拿**静态复本** —— readonly + 整行 pointer-events:none + tabindex 全摘，但 DOM 结构
 * 与类名逐一同源，e2e-perf-glass 的「标本与真实 Dock 逐项一致」才有得比。
 * （不用 disabled：禁用态的透明度会改计算样式，比对就漂了。）
 *
 * 行为归调用方：send / add / voice-down 只上报事件 —— 发送链路（askFrom → AI 页）、
 * 添加入口、语音会话与草稿归属都是调用方的事，本组件零业务。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    interactive?: boolean
    placeholder?: string
    /** 可发送的判定：调用方可并入附件 / 文档等非文本条件；缺省 = 有非空文字。
     *  它同时决定「麦克风 ↔ 发送」的换位（有东西可发时发送钮占位）。 */
    sendable?: boolean
    /** AI 忙碌：发送钮禁用（与 AIPage 原来的 ai.busy 语义一致） */
    busy?: boolean
    /** 行本体的外边距交给调用方（并入 AI 页 .composer 时用：那边统一管内缩） */
    flush?: boolean
    /** 语音钮的 data-testid：AI 页与底栏的回归脚本各认各的 */
    voiceTestid?: string
    /** 「+」的无障碍名：底栏是「去 AI 页加内容」，AI 页是「打开添加菜单」 */
    addLabel?: string
  }>(),
  {
    interactive: true,
    placeholder: '点击输入或按住说话…',
    // 必须显式给 undefined：Boolean 类型的 prop 缺省会被 Vue 铸成 false，
    // 而 sendable 是**三态**（undefined = 按文字判定 / true / false）
    sendable: undefined,
    busy: false,
    flush: false,
    voiceTestid: 'dock-voice-btn',
    addLabel: '添加内容',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 「+」：调用方决定去 AI 页（底栏）还是开添加菜单（AI 页 / 桌面） */
  add: []
  /** 发送（Enter 或发送钮）：调用方决定话往哪里去 */
  send: []
  /** 麦克风按下的原始指针事件：按住说话 / 轻点连听的手势在调用方结算 */
  'voice-down': [e: PointerEvent]
}>()

const inputEl = ref<HTMLTextAreaElement | null>(null)
const addEl = ref<HTMLButtonElement | null>(null)

const hasText = computed(() => !!props.modelValue.trim())
/** 有东西可发（文字，或调用方并进来的附件 / 引用 / 文档） */
const hasContent = computed(() => props.sendable ?? hasText.value)
const canSend = computed(() => props.interactive && !props.busy && hasContent.value)

/** 文本域自适应高度：随内容增高，上限 5 行；清空时复位 */
function autoGrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = '0'
  el.style.height = `${Math.min(el.scrollHeight, 5 * 22)}px`
}

/** 外部改动草稿（语音上屏 / 看板递话 / 「+」带草稿）也走同一套长高与复位 */
watch(
  () => props.modelValue,
  (v) => {
    void nextTick(() => {
      if (!v) {
        if (inputEl.value) inputEl.value.style.height = ''
      } else {
        autoGrow()
      }
    })
  },
)

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  autoGrow()
}

function onEnter(e: KeyboardEvent): void {
  // 组合输入中的回车是「选词」，不是提交；这里连 preventDefault 都不能先做
  if (e.isComposing) return
  // 单行语义：回车永远不落换行（Shift+回车才是换行）
  e.preventDefault()
  if (!canSend.value) return
  emit('send')
}

function focus(): void {
  inputEl.value?.focus()
}

defineExpose({ focus, addButton: addEl, textarea: inputEl })
</script>

<template>
  <!-- 根就是那一行（.dock-quick 是几何与材质的唯一入口，.inbar 是输入条内部的稳定标记：
       AI 页的既有回归脚本按 .inbar textarea / .inbar .send 寻址，统一后不必改口径） -->
  <div
    class="dock-quick inbar"
    :class="{ static: !interactive, flush }"
    :aria-hidden="interactive ? undefined : 'true'"
  >
    <button
      ref="addEl"
      type="button"
      class="qk-btn qk-add"
      :tabindex="interactive ? undefined : -1"
      :aria-label="addLabel"
      @click="emit('add')"
    >
      <Plus :size="22" :stroke-width="2" />
    </button>
    <textarea
      ref="inputEl"
      class="qk-input"
      rows="1"
      :value="modelValue"
      :placeholder="placeholder"
      :readonly="!interactive"
      :tabindex="interactive ? undefined : -1"
      enterkeyhint="send"
      @input="onInput"
      @keydown.enter.exact="onEnter"
    />
    <!-- 麦克风常驻（参考图的空态就是「＋ / 输入 / 麦克风」三件套 —— 参考图空态没有
         独立发送钮，所以发送钮只在有内容时出现；语音则不因有字而消失：一边打字一边
         补一句是输入条的常规用法）。
         发送钮常驻 DOM（v-show 开关）：e2e 的「打字后发送钮」断言与读屏可达性
         都按「存在且可按」算；藏起来的那颗 tabindex 由 v-show 自然不可达。 -->
    <button
      type="button"
      class="qk-btn qk-voice"
      :data-testid="voiceTestid"
      :tabindex="interactive ? undefined : -1"
      aria-label="语音输入：按住说话，轻点连听"
      @pointerdown="emit('voice-down', $event)"
      @contextmenu.prevent
    >
      <Mic :size="22" :stroke-width="2" />
    </button>
    <button
      v-show="hasContent"
      type="button"
      class="qk-btn qk-send send"
      :class="{ ready: canSend }"
      :tabindex="interactive ? undefined : -1"
      :disabled="!canSend"
      aria-label="发送到 AI"
      @click="emit('send')"
    >
      <SendHorizontal :size="21" :stroke-width="2" />
    </button>
  </div>
</template>

<style scoped>
/* 行本体：玻璃里的**一层薄底**（不是又一块玻璃 —— 无边框、无落影、无折射）。
   底取 --field-fill：亮色是文字色的 7%（浅灰井），暗色同一支公式翻成一层提亮。
   高度 52 + 顶部内缩 4 = --dock-quick-h 的 56；圆角 = 外圈半径 − 内缩一档，同心。 */
.dock-quick {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-height: 52px;
  margin: var(--gap-tight) var(--gap-tight) 0;
  padding: 0 var(--gap-tight);
  border-radius: var(--dock-radius-in);
  background: var(--field-fill);
}

/* 并入 .composer（AI 页）时外边距归调用方管：芯片行与输入行落在同一条内缩线上 */
.dock-quick.flush {
  margin: 0;
}

.dock-quick.static {
  pointer-events: none;
}

/* 纯图标钮（与参考构图同一档）：＋ / 麦克风 / 发送都没有圆片底，直接压在输入行上 ——
   灰圆片会让输入行读成「三颗钮的工具栏」，而它应该读成「一条输入条」。
   40×40 保留为触控几何，::after 外扩 44 热区不动。 */
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
  resize: none;
  /* 22px 是行盒几何（5 行 × 22 = 110 的 max-height 跟它同源），不是间距 */
  line-height: 22px;
  padding: var(--sp-8) 0;
  max-height: 110px;
  overflow-y: auto;
  scrollbar-width: none;
}

.qk-input::-webkit-scrollbar {
  display: none;
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
