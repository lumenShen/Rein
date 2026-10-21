<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowRight, Clock, LoaderCircle, Sparkles, X } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { parseQuickTodo } from '@/ai/quickParse'
import { useModelsStore } from '@/stores/models'
import { addDays, minToHHmm, parseDate } from '@/utils/date'
import type { TodoDraft } from '@/types'

/**
 * AI 一句话记待办：页顶那枚悬浮胶囊。
 * 左：Sparkles 徽章；中：自然语言输入；右：→ 填入待办。
 * 解析成功后在胶囊下方浮出一枚**预览 chip**（解析出的标题 + 人话时间 chip），
 * 点箭头把这条草稿交给页面打开编辑器确认落库。
 *
 * 为什么预览放在胶囊下方而不是塞进胶囊中段：输入框必须始终可编辑（用户会改句子），
 * 预览再挤进同一行会把输入压到读不下；下方独立一枚 chip 能同时容纳标题、时间 chip、
 * 「识别到 N 条」计数与清空钮，且不打断输入。胶囊本身仍保持「单一悬浮 pill」的形态。
 */
const props = defineProps<{
  /** 今天（YYYY-MM-DD）；用于把解析出的日期说成人话（今天 / 明天 / 具体某日） */
  date: string
}>()

const emit = defineEmits<{ fill: [draft: TodoDraft] }>()

const router = useRouter()
const models = useModelsStore()

/** 无模型时的面上结论（只一句）；完整指引收进 InfoHint —— 与 SmartAddSheet 同一语气 */
const NO_MODEL_TEXT = '还没有可用的 AI 模型'
const NO_MODEL_HINT = '先到「管理模型」添加并测试模型后，「一句话记待办」即可用。'

/** 输入防抖：600ms 静默后才解析（回车立即解析） */
const DEBOUNCE_MS = 600

const text = ref('')
const drafts = ref<TodoDraft[]>([])
const error = ref('')
const noModel = ref(false)
const busy = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

/** 请求序号：连打 / 回车重解析后，旧请求的返回一律作废（乱序返回只认最后一次） */
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

const first = computed<TodoDraft | null>(() => drafts.value[0] ?? null)
/** 有结果、且不在解析中——才允许填入（避免把上一次的旧结果填进表单） */
const canFill = computed(() => drafts.value.length > 0 && !busy.value)
const timeText = computed(() => (first.value ? humanTime(first.value) : ''))
const hintText = computed(() => (noModel.value ? NO_MODEL_TEXT : error.value))
const showUnder = computed(() => drafts.value.length > 0 || noModel.value || !!error.value)

function clearTimer(): void {
  if (timer != null) {
    clearTimeout(timer)
    timer = null
  }
}

/** 清空预览并使在途请求作废（不动输入框文本） */
function reset(): void {
  seq++
  busy.value = false
  drafts.value = []
  error.value = ''
}

async function ensureModels(): Promise<void> {
  if (!models.loaded) await models.load()
}

async function runParse(): Promise<void> {
  const clean = text.value.trim()
  if (!clean) {
    reset()
    return
  }
  // 已有解析在跑就不重复发起：句子一变 watch 会把 busy 落回 false，这里只挡「同一句重复触发」
  if (busy.value) return
  try {
    await ensureModels()
  } catch {
    /* 模型列表拉取失败按「没有模型」处理，不把异常甩到卡面上 */
  }
  const cfg = models.defaultModel()
  if (!cfg) {
    // 无模型不是错误：箭头保持禁用，只落一句结论 + 去 AI 页的入口
    noModel.value = true
    drafts.value = []
    error.value = ''
    return
  }
  noModel.value = false

  const my = ++seq
  busy.value = true
  try {
    const r = await parseQuickTodo(cfg, clean)
    if (my !== seq) return // 已过期：期间用户又改了句子 / 清空了
    drafts.value = r
    error.value = r.length ? '' : '没识别出待办，说得再具体一点？'
  } catch (e) {
    if (my !== seq) return
    drafts.value = []
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (my === seq) busy.value = false
  }
}

// 输入即防抖解析：每次改动都作废在途请求，空输入直接清预览、不发请求
watch(text, () => {
  clearTimer()
  seq++
  busy.value = false
  drafts.value = []
  error.value = ''
  if (!text.value.trim()) return
  timer = setTimeout(() => void runParse(), DEBOUNCE_MS)
})

function onEnter(): void {
  clearTimer()
  if (!text.value.trim()) return
  void runParse()
}

function onEsc(): void {
  if (text.value) clear()
  else inputEl.value?.blur()
}

function onFill(): void {
  const d = first.value
  if (!canFill.value || !d) return
  emit('fill', d)
}

/** 清空整条输入（×、Esc 与「保存后清空」共用；由 defineExpose 暴露给页面） */
function clear(): void {
  clearTimer()
  text.value = ''
  reset()
  inputEl.value?.blur()
}

function goAi(): void {
  void router.push({ name: 'ai' })
}

/** 时间 chip 的人话：今天/明天用「时段 + 12 小时制」，其它日期用「M月D日 + 24 小时制」 */
function humanTime(d: TodoDraft): string {
  if (d.startMin == null) return ''
  const min = d.startMin
  if (d.date === props.date) return `今天${periodOf(min)} ${h12(min)}`
  if (d.date === addDays(props.date, 1)) return `明天${periodOf(min)} ${h12(min)}`
  if (d.date === addDays(props.date, -1)) return `昨天${periodOf(min)} ${h12(min)}`
  const dt = parseDate(d.date)
  return `${dt.getMonth() + 1}月${dt.getDate()}日 ${minToHHmm(min)}`
}

function periodOf(min: number): string {
  const h = Math.floor(min / 60)
  if (h < 5) return '凌晨'
  if (h < 9) return '早上'
  if (h < 12) return '上午'
  if (h < 13) return '中午'
  if (h < 18) return '下午'
  return '晚上'
}

function h12(min: number): string {
  const h = Math.floor(min / 60) % 12
  const m = min % 60
  return `${h === 0 ? 12 : h}:${String(m).padStart(2, '0')}`
}

// 进页面先探一次模型：没配模型时直接把「箭头禁用 + 一句提示」摆在面上，
// 而不是等用户打完字才报错（模型可在别处添加，加载失败则不武断报「没有模型」）
onMounted(async () => {
  try {
    await ensureModels()
    noModel.value = !models.defaultModel()
  } catch {
    /* 拉不到模型列表：留白，交给首轮解析再判 */
  }
})

onBeforeUnmount(() => {
  clearTimer()
  seq++ // 卸载后到达的结果直接丢弃
})

defineExpose({ clear })
</script>

<template>
  <div class="quick">
    <!-- 悬浮胶囊：徽章 | 输入 | → -->
    <div class="bar">
      <span class="badge" aria-hidden="true"><Sparkles :size="15" /></span>
      <input
        ref="inputEl"
        v-model="text"
        class="nl"
        type="text"
        maxlength="120"
        placeholder="AI 一句话记待办，如：今晚 7 点半去健身房练腿"
        aria-label="AI 一句话记待办"
        enterkeyhint="done"
        @keydown.enter.prevent="onEnter"
        @keydown.esc="onEsc"
      >
      <LoaderCircle v-if="busy" :size="15" class="spin" aria-label="解析中" />
      <button
        class="go"
        :class="{ on: canFill }"
        :disabled="!canFill"
        aria-label="填入待办"
        @click="onFill"
      >
        <ArrowRight :size="16" />
      </button>
    </div>

    <!-- 预览 / 提示行 -->
    <div v-if="showUnder" class="under">
      <template v-if="first">
        <span class="preview">
          <b class="ptitle">{{ first.title }}</b>
          <span v-if="timeText" class="time"><Clock :size="12" />{{ timeText }}</span>
        </span>
        <!-- 多条时点箭头仍只填第一条；要挑要改去「添加待办 › 智能添加」的完整流程，
             输入条不再挂一个重弹层（保持这里的轻量心智） -->
        <StatusChip v-if="drafts.length > 1" tone="accent" size="sm">识别到 {{ drafts.length }} 条</StatusChip>
        <button class="clr" aria-label="清空" @click="clear"><X :size="14" /></button>
      </template>
      <p v-else class="hint">
        <span>{{ hintText }}</span>
        <InfoHint v-if="noModel" title="可用的 AI 模型" :content="NO_MODEL_HINT" />
        <button v-if="noModel" class="link" @click="goAi">去添加模型</button>
      </p>
    </div>
  </div>
</template>

<style scoped>
.quick {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin-bottom: var(--gap-md);
}

/* 悬浮胶囊：surface 底 + 软落影，圆角走 radius-full */
.bar {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 左 8 让徽章与输入文字之间呼吸，右 6 收住 34 的圆钮（保持胶囊整体高度） */
  padding: var(--sp-6) var(--sp-6) var(--sp-6) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface);
  border: 0.5px solid var(--line);
  box-shadow: var(--shadow-float);
  transition: border-color var(--dur-fast) var(--ease-standard);
}

.bar:focus-within {
  border-color: var(--accent);
}

.badge {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.nl {
  flex: 1;
  min-width: 0;
  padding: var(--sp-6) var(--sp-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.nl::placeholder {
  color: var(--text-3);
}

/* → 按钮：无内容时是灰底占位，可填入时升为强调色实底 */
.go {
  position: relative;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-3);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

/* 视觉 34 不动，热区撑到 44（输入条本身 46 高，外扩的 5px 落在条内空白里） */
.go::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.go.on {
  background: var(--accent);
  color: var(--on-accent);
}

.go:disabled {
  opacity: var(--disabled-opacity);
}

.spin {
  flex: none;
  color: var(--text-3);
  animation: qa-spin 0.9s linear infinite;
}

@keyframes qa-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 预览 / 提示行 */
.under {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  padding: 0 var(--sp-4);
}

.preview {
  flex: 0 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 预览胶囊与全库胶囊同高（24 起），不再比下面的提示行高出一截 */
  min-height: var(--chip-h);
  padding: var(--sp-4) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.ptitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

/* 时间 chip：琥珀（warn）soft 底 + strong 字，与左侧徽章的 accent 凑成一对 */
.time {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--warn-soft);
  color: var(--warn-strong);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
}

.clr {
  position: relative;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.clr::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.link {
  position: relative;
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--accent-strong);
}

/* 「去添加模型」只有 16px 高，但它是这条提示里唯一的去处：热区补到 44 */
.link::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: calc(100% + 16px);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
}

/* 全站已由 base.css 对减弱动效统一归零；这里再钉住本组件自己的那点动效 */
@media (prefers-reduced-motion: reduce) {
  .bar,
  .go {
    transition: none;
  }

  .spin {
    animation: none;
  }
}
</style>
