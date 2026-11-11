<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Mic, Plus, SendHorizontal } from 'lucide-vue-next'

import { createComposerFocusToken, setComposerFocus } from '@/system/composerFocus'

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
 *
 * 聚焦态写到 system/composerFocus（同一个单例）：底栏据此在输入时收起页签行，
 * 用户在哪一页聚焦都成立。占位默认是**能力提示轮播**（每句 8s，弹簧式上下换位）；
 * 调用方给了上下文占位（附图 / 文档）时按调用方那句话显示，轮播暂停。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    interactive?: boolean
    /** 调用方给的上下文占位（如附图时「问问这张图」）。缺省 = 能力提示轮播 */
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
    // 缺省（undefined）= 走能力提示轮播；不能用空串占位，空串会被当成「调用方明确要空占位」
    placeholder: undefined,
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

/* ---------- 占位轮播：提醒「这根输入条能帮你做什么」 ----------
 *
 * 不是广告位，是**能力清单**：每个短句都是本应用真能完成的一件事（记饮食 / 查训练 /
 * 记账 / 加待办 / 拍照算热量 / 搜历史 / 闹钟天气）。首句保留「按住说话」—— 它既是
 * 麦克风的手势说明，也是底栏回归脚本的锚点。
 *
 * 原生的 textarea placeholder 不能做位移动画，所以视觉层是自绘的：原生占位透明，
 * 上面盖一层绝对定位的轮播文字。每句 8s；旧句向上移走、新句从下面冒上来，两端
 * 同时起步（delay 0），两行字之间始终留着 0.2em 的间距 —— 用户定的节奏。 */
const COMPOSER_HINTS = [
  '按住说话，或直接输入',
  '记一句「午饭 28 块」',
  '拍张照，让 AI 算热量',
  '问训练：「这周练了几次？」',
  '查体重、睡眠和心率',
  '加待办：「周五前交方案」',
  '定个闹钟，或记个提醒',
  '搜我以前的笔记和对话',
] as const

/** 每句停留 8 秒：够读完一句，又不至于像在催人 */
const HINT_MS = 8000

const hintIndex = ref(0)
/** 调用方给了上下文占位时轮播让位（附图时「问问这张图」比能力清单更该出现在眼前） */
const rotating = computed(() => props.interactive && !props.placeholder)
const placeholderText = computed(
  () => props.placeholder ?? COMPOSER_HINTS[hintIndex.value % COMPOSER_HINTS.length]!,
)

let hintTimer: number | null = null

function stopHintTimer(): void {
  if (hintTimer !== null) {
    window.clearInterval(hintTimer)
    hintTimer = null
  }
}

function startHintTimer(): void {
  stopHintTimer()
  if (!rotating.value || COMPOSER_HINTS.length < 2) return
  hintTimer = window.setInterval(() => {
    hintIndex.value = (hintIndex.value + 1) % COMPOSER_HINTS.length
  }, HINT_MS)
}

/** 页面切到后台时停表：看不见的占位不必继续轮播 */
function onVisibility(): void {
  if (document.hidden) stopHintTimer()
  else startHintTimer()
}

watch(rotating, startHintTimer)

/* ---------- 聚焦态：底栏在输入时收起页签行（任何页面共用同一份事实） ---------- */
const focusToken = createComposerFocusToken()

function onFocus(): void {
  if (props.interactive) setComposerFocus(focusToken, true)
}

function onBlur(): void {
  setComposerFocus(focusToken, false)
}

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

onMounted(() => {
  startHintTimer()
  document.addEventListener('visibilitychange', onVisibility)
  // 草稿住在跨页 store：挂载时可能已经有一整段文字（切页带过来的），
  // watch 只在「变化」时跑，初值要在这里补一次长高
  if (props.modelValue) void nextTick(autoGrow)
})

onBeforeUnmount(() => {
  stopHintTimer()
  document.removeEventListener('visibilitychange', onVisibility)
  // 卸载（切页 / 底栏与 AI 页的输入条换手）时把聚焦席位还回去，别让页签行永久收起
  setComposerFocus(focusToken, false)
})

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
      @mousedown.prevent
      @click="emit('add')"
    >
      <Plus :size="22" :stroke-width="2" />
    </button>
    <!-- 文本域 + 自绘占位：原生 placeholder 不能做位移动画，所以它只留透明的一份
         给读屏与回归脚本（:placeholder 仍是最新一句），视觉由 .qk-ph 轮播承担 -->
    <div class="qk-field">
      <textarea
        ref="inputEl"
        class="qk-input"
        rows="1"
        :value="modelValue"
        :placeholder="placeholderText"
        :readonly="!interactive"
        :tabindex="interactive ? undefined : -1"
        enterkeyhint="send"
        @focus="onFocus"
        @blur="onBlur"
        @input="onInput"
        @keydown.enter.exact="onEnter"
      />
      <div v-show="!modelValue" class="qk-ph" aria-hidden="true">
        <Transition name="ph-roll">
          <span :key="placeholderText">{{ placeholderText }}</span>
        </Transition>
      </div>
    </div>
    <!-- 麦克风常驻（参考图的空态就是「＋ / 输入 / 麦克风」三件套 —— 参考图空态没有
         独立发送钮，所以发送钮只在有内容时出现；语音则不因有字而消失：一边打字一边
         补一句是输入条的常规用法）。
         发送钮常驻 DOM（v-show 开关）：e2e 的「打字后发送钮」断言与读屏可达性
         都按「存在且可按」算；藏起来的那颗 tabindex 由 v-show 自然不可达。
         ＋ / 发送用 mousedown.prevent 保住输入框焦点：底栏在聚焦时收起页签行，
         若按下就把焦点交给按钮，整行会在 click 落地前向下跳 58px（按钮从指下滑走）。 -->
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
      @mousedown.prevent
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

/* 文本域的定位容器：高度仍由 textarea 自己撑（rows/scrollHeight），
   轮播占位绝对定位盖在它上面，不参与行高计算 */
.qk-field {
  position: relative;
  flex: 1;
  min-width: 0;
}

.qk-input {
  display: block;
  width: 100%;
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

/* 原生 placeholder 只留给读屏与回归脚本（:placeholder 仍是最新一句）；
   视觉一律走下面的 .qk-ph —— 原生文本没法做位移动画 */
.qk-input::placeholder {
  color: transparent;
}

/* 轮播占位：与文本域首行同一基线（padding-top 8 + line-height 22），
   内容超宽时单行省略（文案本身都控制在十几个字，正常宽度不会截）。
   --ph-line / --ph-gap 是滚动换句的几何：两行字整段上移一行，行与行之间
   始终隔着 0.2em（用户定的间距）—— 旧句完全移出裁切盒，新句从下方补位。 */
.qk-ph {
  --ph-line: 22px;
  --ph-gap: 0.2em;
  position: absolute;
  top: var(--sp-8);
  left: 0;
  right: 0;
  height: var(--ph-line);
  overflow: hidden;
  pointer-events: none;
  font-size: var(--fs-subhead);
  line-height: var(--ph-line);
  white-space: nowrap;
  /* 与 AI 页同一条配方：--text-1 的 64% 合成，两色主题都够 4.7:1 */
  color: color-mix(in srgb, var(--text-1) 64%, transparent);
}

.qk-ph > span {
  position: absolute;
  inset: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 旧句向上移走、新句从下面冒上来：两端同时起步（delay 0），间距 0.2em。
   弹簧曲线负责「冒」的那一下过冲与回正。 */
.ph-roll-enter-active,
.ph-roll-leave-active {
  transition:
    transform var(--dur-slow) var(--ease-spring),
    opacity var(--dur-base) var(--ease-standard);
}

.ph-roll-enter-from {
  opacity: 0;
  transform: translateY(calc(var(--ph-line) + var(--ph-gap)));
}

.ph-roll-leave-to {
  opacity: 0;
  transform: translateY(calc(0px - var(--ph-line) - var(--ph-gap)));
}

/* 关闭动效：换句是状态，照常发生；只是不做补间 */
html[data-motion='off'] .ph-roll-enter-active,
html[data-motion='off'] .ph-roll-leave-active {
  transition: none;
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
