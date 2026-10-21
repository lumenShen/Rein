<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  FileText,
  Keyboard,
  ListOrdered,
  ListTodo,
  MessageCircle,
  MessagesSquare,
  Mic,
  Pause,
  Play,
  Settings2,
  TimerReset,
  Trash2,
  Utensils,
  X,
} from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import MdText from '@/components/common/MdText.vue'
import SessionGlassButton from '@/components/exercise/SessionGlassButton.vue'
import TimeSpine from './TimeSpine.vue'
import VoiceMemosSheet from './VoiceMemosSheet.vue'
import type { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'
import { fmtMmSs } from '@/utils/format'
import {
  SETTLE_MS,
  cancelSession,
  closeView,
  discardRecovered,
  finishSpeaking,
  minimize,
  recoverSubmit,
  setAutoSettle,
  speakMemo,
  startRecording,
  togglePauseRecording,
  voice,
  writeMemoAll,
  writeMemoItem,
} from '@/system/voiceRuntime'
import type { MemoSummaryItem, VoiceMemo } from '@/types'

/**
 * 语音会话视图（App 根部常驻挂载，单例 runtime 驱动）。
 * 四态：ready 待机 / session 录音·转写 / memo 纪要详情（全览/转文字）/ processing 在 memo 内提示。
 *
 * 版面只有三块，从上到下：**状态 → 内容 → 操作**。
 * 顶栏在录音态不给标题，直接就是状态（波形 + 录音中/已暂停 + 计时器）——
 * 这一屏此刻只有一件事，标题占掉的是状态的位置。操作全部收进底栏，
 * 形状与高度唯一，只有「有状态可表达」的那颗按钮用颜色（见下）。
 * 文本区左右 padding 用 --page-pad-x，与全应用页面栅格对齐。
 */

/**
 * AI store **按需加载**（不是顶层 import）。
 *
 * 本视图在 App 根部常驻挂载，所以顶层 `import { useAiStore } from '@/stores/ai'`
 * 会把整个 AI 工具栈（工具注册表 + 18 个工具域，约 200 KB）钉进启动主包 ——
 * 而这份依赖只有「键盘输入回退」与「结算一段」用得到。改成一个可空 ref +
 * 首次真的要用时再 import，网关在 chat 侧，语音侧只管取。
 *
 * 触发点：语音视图被打开时（watch）—— 那一刻起用户随时可能敲字或让 AI 整理，
 * 提前预热正好把 await 藏在动画里。
 */
const aiStore = shallowRef<ReturnType<typeof useAiStore> | null>(null)

async function ensureAiStore(): Promise<ReturnType<typeof useAiStore>> {
  if (!aiStore.value) {
    const { useAiStore: use } = await import('@/stores/ai')
    aiStore.value = use()
  }
  return aiStore.value
}

watch(
  () => voice.view !== 'closed',
  (open) => {
    if (open) void ensureAiStore()
  },
)

const toast = useToast()
/** 「引用该对话与 AI 聊聊」要跳 AI 页 */
const router = useRouter()

/* ---------- 计时 ---------- */

function fmtMs(ms: number): string {
  return fmtMmSs(ms)
}

/* ---------- 转写视图 ---------- */

/** 喂给时间脊的形状（与 TimeSpine 的 SpineSeg 结构一致） */
interface SpineSeg {
  t: number
  durMs?: number
  who: string
  text: string
  partial?: boolean
}

/**
 * 把句子喂给时间脊。ASR 不给说话人，所以只有一条轨道 —— 脊本身支持多轨，
 * 等哪天接上说话人分离，这里换个字段就有第二条了。
 */
const spineSegs = computed<SpineSeg[]>(() =>
  voice.sentences.map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  })),
)

/** 纪要里的条目本来就带 refs（指向句 idx），直接当锚点钉在轴上 */
const memoSpineSegs = computed<SpineSeg[]>(() =>
  (memo.value?.sentences ?? []).map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  })),
)

const memoPins = computed(() =>
  (memo.value?.summary ?? []).flatMap((it) => {
    const ref = it.refs[0]
    const pos = ref == null ? undefined : posOfSentenceIdx.value.get(ref)
    return pos == null
      ? []
      : [{ idx: pos, kind: it.kind === 'todo' ? ('todo' as const) : ('answer' as const), text: it.text }]
  }),
)

/** 转写中的脊：已定稿句 + 那句未定稿（灰块在生长） */
const liveSpineSegs = computed<SpineSeg[]>(() => {
  const out: SpineSeg[] = [...spineSegs.value]
  if (voice.partial) {
    out.push({ t: voice.elapsedMs, who: '我', text: voice.partial, partial: true })
  }
  return out
})

/* ---------- 纪要详情 ---------- */

const tab = ref<'ov' | 'tr'>('ov')

/** 纪要详情视图的当前纪要（供模板窄化） */
const memo = computed<VoiceMemo | null>(() => (voice.view === 'memo' ? voice.currentMemo : null))

function switchTab(t: 'ov' | 'tr'): void {
  tab.value = t
}

/* 引用角标 → 切到精读并高亮那一句 */
const focusIdx = ref<number | null>(null)
let focusTimer: number | null = null

/** refs 里存的是句 idx，时间脊按数组位置索引 —— 这两个不一定相等，必须映射 */
const posOfSentenceIdx = computed(() => {
  const m = new Map<number, number>()
  ;(voice.currentMemo?.sentences ?? []).forEach((s, i) => m.set(s.idx, i))
  return m
})

function focusAt(pos: number, switchTab = true): void {
  if (pos < 0) return
  if (switchTab) tab.value = 'tr'
  focusIdx.value = pos
  if (focusTimer != null) clearTimeout(focusTimer)
  focusTimer = window.setTimeout(() => {
    focusIdx.value = null
  }, 2400)
}

function onCite(refs: number[]): void {
  if (refs.length === 0) return
  const target = posOfSentenceIdx.value.get(Math.min(...refs.filter((n) => n >= 0)))
  if (target != null) focusAt(target)
}

/* ---------- 重放 ---------- */

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const curMs = ref(0)

function togglePlay(): void {
  const a = audioEl.value
  if (!a) return
  if (a.paused) void a.play()
  else a.pause()
}

function onTime(): void {
  curMs.value = (audioEl.value?.currentTime ?? 0) * 1000
}

function seekBar(e: MouseEvent): void {
  const a = audioEl.value
  if (!a || !voice.durationMs) return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  a.currentTime = ((e.clientX - r.left) / r.width) * (voice.durationMs / 1000)
  void a.play()
}

/** 时间脊上的 seek：跳音频到该时刻 */
function onSpineSeek(ms: number): void {
  const a = audioEl.value
  if (!a || !voice.audioUrl) return
  a.currentTime = ms / 1000
  void a.play()
}

/** 播放中的当前句位置（卡拉OK式跟随高亮） */
const playingPos = computed(() => {
  const m = voice.currentMemo
  if (!m || !playing.value) return -1
  let pos = -1
  m.sentences.forEach((s, i) => {
    if (curMs.value >= s.startMs) pos = i
  })
  return pos
})

/** 脊上要高亮的句：引用跳转优先，其次播放跟随 */
const spineActive = computed<number | undefined>(
  () => focusIdx.value ?? (playingPos.value >= 0 ? playingPos.value : undefined),
)

/* ---------- 写入 ---------- */

const writing = ref(false)

async function onWriteAll(m: VoiceMemo): Promise<void> {
  writing.value = true
  try {
    const n = await writeMemoAll(m)
    toast.toast(n > 0 ? `已写入 ${n} 项` : '没有待写入的条目')
  } finally {
    writing.value = false
  }
}

async function onWriteItem(memo: VoiceMemo, item: MemoSummaryItem): Promise<void> {
  if (await writeMemoItem(memo, item)) toast.toast('已写入')
}

function onSpeak(memo: VoiceMemo): void {
  void speakMemo(memo)
}

/* ---------- 统一操作语言：底栏 + 工具菜单 ---------- */

/**
 * 底栏的三条规矩：
 *  1. **全部收进底栏**，高度统一（`--vbar-h`）、形状统一（正圆 / 胶囊）——
 *     不靠大小、粗细、位置区分主次；
 *  2. **只有暂停/继续用颜色**：它是这里唯一有「状态」的按钮（录音中 vs 已暂停），
 *     颜色回答的是「现在录着还是停着」；其余按钮没有状态可表达，一律中性；
 *  3. **中性按钮走高画质液态玻璃**：低画质档（data-perf=low）由 base.css 把玻璃
 *     顶成实底 —— 那是「别在这台机器上加滤镜面」这一档的承诺，不是降级。
 *     暂停/继续是实色按钮，不进玻璃：它靠颜色区分，玻璃反而会吃掉那层色。
 */
const toolOpen = ref(false)
const toolBtn = ref<HTMLElement | null>(null)

/** 完成前的二次确认（复用仓里统一的底部操作面板，与删除动作同款） */
const confirmFinish = ref(false)

/** 是否处于「录音会话中」（含暂停）—— 顶栏状态与底栏按钮都按它切换 */
const live = computed(() => voice.status === 'recording' || voice.status === 'paused')

/**
 * 顶栏进度条 = **本段的进度**，窗口是自动整理的周期（`SETTLE_MS`，3 分钟）。
 * 不另造一个"录音总进度"：录音没有已知总长，任何百分比都是编的。
 * 自动整理开着时以 `nextSettleAt` 为准（与「N 后整理」的文案同源，不会一个说 2:31 一个差半分钟）；
 * 关掉时它没有所指，整条不渲染（见模板）。
 */
const settleProgress = computed(() => {
  const W = SETTLE_MS
  if (voice.autoSettle) {
    const start = voice.nextSettleAt - W
    return Math.min(1, Math.max(0, (voice.elapsedMs - start) / W))
  }
  return (voice.elapsedMs % W) / W
})

/** 距下次自动整理还有多久（仅自动整理开启时显示 —— 关掉时它没有所指） */
const settleRemain = computed(() => Math.max(0, voice.nextSettleAt - voice.elapsedMs))

/**
 * 录音态顶栏的副行。
 *
 * 自动整理开着时它就是那条进度条的注脚（与进度条同源于 `nextSettleAt`，
 * 所以条与文字不会一个说 2:31、一个差半分钟）；关掉时进度条没有所指、整条不出现，
 * 这一行退成一句安顿话 —— 「中断可恢复」是这条链路对用户最要紧的承诺。
 */
const liveNote = computed(() => {
  if (voice.lastError) return voice.lastError
  return voice.autoSettle ? `${fmtMs(settleRemain.value)} 后整理` : '逐句实时留档 · 中断可恢复'
})

/** 工具菜单：用户点名的三件事，都带图标（bind 式锚定底栏那颗圆钮弹出） */
const toolActions = computed(() => {
  const acts: MenuItem[] = [
    { label: voice.autoSettle ? '关闭自动整理' : '启用自动整理', value: 'auto', icon: TimerReset },
    { label: kbdOpen.value ? '收起键盘补充' : '键盘补充', value: 'kbd', icon: Keyboard },
    { label: '引用该对话，与 AI 聊聊', value: 'ask', icon: MessagesSquare },
  ]
  // 取消是破坏性的，放进菜单里并要二次确认 —— 底栏是"继续用"的地方，不该常驻一颗丢弃键
  if (live.value) acts.push({ label: '取消本次录音', value: 'cancel', icon: Trash2, danger: true })
  return acts
})

const confirmCancel = ref(false)

function onToolSelect(v: string): void {
  if (v === 'auto') setAutoSettle(!voice.autoSettle)
  else if (v === 'kbd') kbdOpen.value = !kbdOpen.value
  else if (v === 'ask') void quoteToAi()
  else if (v === 'cancel') confirmCancel.value = true
}

/**
 * 把这段对话交给 AI：把转写拼成一段引用，走与「弱项加练 → 交给 AI」同一条路径
 * （`ai.askFrom` + 跳 AI 页，AI 页会直接发送）。用 `takePendingPrompt` 那套而不是
 * 自己发请求：模型选择、上下文注入、会话归属都归 AI 页管，这里再发一次等于绕开它。
 */
async function quoteToAi(): Promise<void> {
  const lines = (voice.view === 'memo' ? memo.value?.sentences : voice.sentences) ?? []
  if (!lines.length) {
    toast.toast('这段还没有转写内容')
    return
  }
  const body = lines.map((s) => s.text).join('')
  const head = voice.view === 'memo' && memo.value ? `《${memo.value.title}》` : '这段语音'
  void (await ensureAiStore()).askFrom(`引用${head}的转写，我来聊聊：\n\n${body}\n\n`)
  closeView()
  void router.push({ name: 'ai' })
}

/* ---------- 键盘输入回退 ---------- */

const kbdOpen = ref(false)
const kbdText = ref('')
const kbdSending = ref(false)

async function sendKbd(): Promise<void> {
  const text = kbdText.value.trim()
  if (!text || kbdSending.value) return
  kbdSending.value = true
  try {
    await (await ensureAiStore()).sendText(text)
    kbdText.value = ''
  } finally {
    kbdSending.value = false
  }
}

/** 键盘输入后最近一条助手回复（流式跟随） */
const kbdReply = computed(() => {
  const ai = aiStore.value
  if (!ai) return null // AI 栈还没加载：键盘面板此时也不会有回复
  for (let i = ai.messages.length - 1; i >= 0; i--) {
    const m = ai.messages[i]
    if (m && m.role === 'assistant') return m
  }
  return null
})

/* ---------- 全部纪要 ---------- */

const memosOpen = ref(false)

function onPickMemo(memo: VoiceMemo): void {
  memosOpen.value = false
  if (voice.status === 'recording') {
    toast.toast('转写中，先完成或取消当前转写')
    return
  }
  import('@/system/voiceRuntime').then(({ openMemoById }) => void openMemoById(memo.id))
}

onBeforeUnmount(() => {
  if (focusTimer != null) clearTimeout(focusTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="vs">
      <section v-if="voice.view !== 'closed' && !voice.minimized" class="vs-root" aria-label="录音纪要">
        <!-- ===== 顶栏 =====
             录音（含暂停）时**不显示标题**：这一屏的唯一任务是「正在录」，
             把「录音纪要」四个字留在上面等于用标题占掉状态的位置。
             取而代之的是状态本身 —— 波形 + 录音中/已暂停 + 计时器，下面一条进度条。
             非录音态（待机/纪要）仍用标题：那时候用户需要知道自己在哪里。 -->
        <header class="vs-top" :class="{ 'is-live': live }">
          <div class="vs-toprow">
            <button class="vs-tbtn" :aria-label="live ? '收起为浮条' : '关闭'" @click="minimize">
              <X v-if="voice.status === 'idle'" :size="17" />
              <ChevronDown v-else :size="19" />
            </button>

            <span v-if="live" class="vs-live">
              <span class="wave" :class="{ off: voice.status === 'paused' }" aria-hidden="true">
                <i v-for="i in 5" :key="i" />
              </span>
              <b class="vl-t">{{ voice.status === 'paused' ? '已暂停' : '录音中' }}</b>
              <span class="vl-sep" aria-hidden="true" />
              <span class="num vl-time">{{ fmtMs(voice.elapsedMs) }}</span>
            </span>
            <span v-else class="vs-title">
              <span class="vs-tname">录音纪要</span>
              <!-- 纪要标题只在下面那张纪要头卡上出现一次：顶栏再印一遍会让人以为是两条纪要 -->
              <small v-if="voice.status === 'processing'">与 AI 对话同会话{{ voice.segmentCount > 0 ? ` · 已结算 ${voice.segmentCount} 段` : '' }}</small>
              <small v-else>逐句实时留档 · 中断可恢复</small>
            </span>

            <!-- 录音态不放「全部纪要」：那一刻没有比「正在录」更需要入口的东西 -->
            <button v-if="!live" class="vs-tbtn wide" @click="memosOpen = true">
              <ListOrdered :size="14" /> 全部纪要
            </button>
            <span v-else class="vs-tbal" aria-hidden="true" />
          </div>

          <!-- 副行：自动整理开着 = 本段进度（条 + 倒计时）；关掉 = 一句安顿话。
               不编一个"录音总进度"——录音没有已知总长，百分比只能是假的。 -->
          <div v-if="live" class="vs-subrow">
            <span
              v-if="voice.autoSettle"
              class="vs-prog"
              :class="{ paused: voice.status === 'paused' }"
              role="progressbar"
              :aria-valuenow="Math.round(settleProgress * 100)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <i :style="{ transform: `scaleX(${settleProgress})` }" />
            </span>
            <span class="vs-subtxt" :class="{ num: voice.autoSettle, err: !!voice.lastError }">{{ liveNote }}</span>
          </div>
        </header>

        <!-- ===== 待机 ===== -->
        <template v-if="voice.view === 'ready'">
          <div class="ready">
            <!-- 崩溃恢复提示 -->
            <div v-if="voice.recovered" class="recover">
              <p>
                上次有 <b>{{ voice.recovered.sentences.length }}</b> 句未整理的转写
                <span class="t-3">（{{ new Date(voice.recovered.startedAt).toTimeString().slice(0, 5) }}）</span>
              </p>
              <div class="rec-acts">
                <button class="rbtn primary" @click="recoverSubmit">补交整理</button>
                <button class="rbtn" @click="discardRecovered">丢弃</button>
              </div>
            </div>
            <div class="ready-orb" aria-hidden="true">
              <AudioLines :size="44" />
            </div>
            <p class="ready-cap">轻点麦克风开始说话</p>
            <button class="mic-big start" aria-label="开始说话" @click="startRecording">
              <Mic :size="28" />
            </button>
            <p v-if="voice.lastError" class="err t-2">{{ voice.lastError }}</p>
          </div>
        </template>

        <!-- ===== 转写中 ===== -->
        <template v-else-if="voice.view === 'session'">
          <!-- 转写正文：时间脊的精读形态（顶部保留按真实比例的定位带）。
               录音状态已经在顶栏了，这里不再重复一条状态卡 —— 内容区只放内容。 -->
          <div class="tr">
            <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 滚动框站住，只有内容位移（system/rubberScroll） -->
            <div class="rubber-layer" data-rubber-content>
              <TimeSpine
                size="full"
                mode="read"
                :segments="liveSpineSegs"
                :head-ms="voice.elapsedMs"
                :head-pulse="voice.status === 'recording'"
                :fold-silence-over="12"
              />
              <!-- 还没有内容时给一句引导，而不是一屏空白 -->
              <p v-if="liveSpineSegs.length === 0" class="tr-empty t-2">在听着了，直接说就行。</p>
            </div>
          </div>
          <footer class="foot">
            <div v-if="kbdOpen" class="kbd-bar">
              <input v-model="kbdText" type="text" placeholder="改用键盘输入…" @keydown.enter="sendKbd">
              <button class="kb-send" :disabled="kbdSending" @click="sendKbd"><ArrowUp :size="16" /></button>
            </div>
            <div v-if="kbdOpen && kbdReply" class="kbd-reply">
              <MdText v-if="kbdReply.text" :text="kbdReply.text" :streaming="kbdReply.streaming" />
            </div>

            <!-- 底栏：三颗同高按钮。中性两枚（工具 / 完成）走玻璃，
                 只有暂停/继续是实色 —— 它是这里唯一有"状态"的按钮。
                 两颗图标字都用同一颗「暂停↔播放」的交叉淡入，随时可打断。 -->
            <div class="vbar">
              <SessionGlassButton w="var(--vbar-h)" h="var(--vbar-h)" radius="50%">
                <button
                  ref="toolBtn"
                  class="vb ic"
                  type="button"
                  aria-label="工具"
                  aria-haspopup="menu"
                  :aria-expanded="toolOpen"
                  @click="toolOpen = true"
                >
                  <Settings2 :size="19" />
                </button>
              </SessionGlassButton>

              <button
                class="vb ic state"
                :class="voice.status === 'paused' ? 'go' : 'hold'"
                type="button"
                :aria-label="voice.status === 'paused' ? '继续录音' : '暂停录音'"
                @click="togglePauseRecording"
              >
                <!-- 两颗图标常驻、只做交叉淡入：状态来回切时可打断、不闪空档 -->
                <span class="swap" aria-hidden="true">
                  <Pause class="s-pause" :size="19" />
                  <Play class="s-play" :size="19" />
                </span>
              </button>

              <SessionGlassButton h="var(--vbar-h)">
                <button class="vb wide" type="button" :disabled="!live" @click="confirmFinish = true">
                  <Check :size="16" /> 完成
                </button>
              </SessionGlassButton>
            </div>
          </footer>
        </template>

        <!-- ===== 纪要详情 ===== -->
        <template v-else-if="voice.view === 'memo'">
          <div class="body">
            <!-- 超范围平移层：同上（item 超伸） -->
            <div class="rubber-layer" data-rubber-content>
              <p v-if="!memo" class="vs-hint">
                {{ voice.processingCount > 0 || voice.status === 'processing' ? 'AI 正在整理纪要…' : '这段没有产生纪要' }}
              </p>
              <template v-else>
                <!-- 纪要头（平铺） -->
                <div class="vm-head">
                  <span class="vm-ic"><FileText :size="17" /></span>
                  <span class="vm-t">
                    <b>{{ memo.title }}</b>
                    <!-- 时长是主角（title3 + .num），时刻/字数/句数降为元数据行，与主数值分开 -->
                    <em class="vm-dur num">{{ fmtMs(memo.durationMs) }}</em>
                    <em>
                      {{ new Date(memo.createdAt).toTimeString().slice(0, 5) }} ·
                      {{ memo.words }} 字 · {{ memo.sentences.length }} 句
                    </em>
                  </span>
                </div>

                <!-- 重放条 -->
                <div v-if="memo.audioPath" class="player">
                  <button class="pl-btn" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
                    <Play v-if="!playing" :size="15" />
                    <Pause v-else :size="15" />
                  </button>
                  <span class="pl-cur num">{{ fmtMs(curMs) }}</span>
                  <div class="pl-bar" @click="seekBar">
                    <i :style="{ width: `${Math.min(100, (curMs / Math.max(1, memo.durationMs)) * 100)}%` }" />
                    <b :style="{ left: `${Math.min(100, (curMs / Math.max(1, memo.durationMs)) * 100)}%` }" />
                  </div>
                  <span class="pl-dur num">{{ fmtMs(memo.durationMs) }}</span>
                </div>

                <!-- 分段 -->
                <div class="seg" :class="{ right: tab === 'tr' }">
                  <span class="sthumb" />
                  <button :class="{ on: tab === 'ov' }" @click="switchTab('ov')">全览</button>
                  <button :class="{ on: tab === 'tr' }" @click="switchTab('tr')">转文字</button>
                </div>

                <!-- 会话结构：整场压成一屏，块宽 = 说话时长，纪要是钉在轴上的锚点。
                     句数与时长已由上方纪要头卡给出，这里只留标题，不再重印一遍。 -->
                <section class="ov-sec spine-sec">
                  <h5>会话结构</h5>
                  <TimeSpine
                    size="full"
                    mode="structure"
                    :segments="memoSpineSegs"
                    :total-ms="memo.durationMs"
                    :pins="memoPins"
                    :head-ms="playing ? curMs : undefined"
                    :active-idx="spineActive"
                    @seek="onSpineSeek"
                    @pick="focusAt"
                  />
                </section>

                <!-- 整理中（轻提示行） -->
                <div v-if="voice.status === 'processing' || voice.processingCount > 0" class="proc">
                  <span class="spin" />
                  <span>
                    <b>AI 正在整理纪要…</b>
                    <em>转写已保存，整理不会丢内容</em>
                  </span>
                </div>

                <!-- 全览 -->
                <template v-else-if="tab === 'ov'">
                  <p v-if="memo.summary.length === 0" class="vs-hint">
                    这段没有提取出结构化条目，转写内容见「转文字」。
                  </p>
                  <section v-if="memo.summary.length > 0" class="ov-sec">
                    <h5>总结</h5>
                    <div v-for="(it, i) in memo.summary" :key="i" class="sum-li">
                      <i class="ic" :class="`i-${it.kind}`">
                        <Utensils v-if="it.kind === 'food'" :size="13" />
                        <ListTodo v-else-if="it.kind === 'todo'" :size="13" />
                        <MessageCircle v-else :size="13" />
                      </i>
                      <span class="sum-body">
                        <span class="md-line"><MdText :text="it.text" /><button
                          v-if="it.refs.length"
                          class="cite"
                          :aria-label="`跳到第 ${it.refs.map((r) => r + 1).join('、')} 句`"
                          @click="onCite(it.refs)"
                        >{{ it.refs.map((r) => r + 1).join('') }}</button></span>
                        <em v-if="it.note" class="sub">{{ it.note }}</em>
                      </span>
                    </div>
                  </section>
                  <section v-if="memo.summary.some((it) => it.kind === 'todo' && it.todo)" class="ov-sec">
                    <h5>待办事项</h5>
                    <div
                      v-for="(it, i) in memo.summary.filter((x) => x.kind === 'todo' && x.todo)"
                      :key="i"
                      class="todo-li"
                    >
                      <span class="cb" :class="{ done: it.written }" />
                      <span class="tt">
                        {{ it.todo!.title }}
                        <em v-if="it.todo!.startMin != null">
                          {{ String(Math.floor(it.todo!.startMin! / 60)).padStart(2, '0') }}:{{ String(it.todo!.startMin! % 60).padStart(2, '0') }}
                        </em>
                      </span>
                      <button v-if="!it.written" class="wbtn" @click="onWriteItem(memo, it)">写入</button>
                      <span v-else class="done-mark"><Check :size="14" /></span>
                    </div>
                  </section>
                  <div class="acts-flat">
                    <button class="commit" :disabled="writing" @click="onWriteAll(memo)">
                      <Check :size="15" /> 全部写入
                    </button>
                    <button class="ghost" @click="onSpeak(memo)">
                      <span v-if="voice.speaking" class="mini-wave"><i /><i /><i /></span>
                      <Play v-else :size="15" />
                      {{ voice.speaking ? '停止朗读' : '朗读纪要' }}
                    </button>
                  </div>
                </template>

                <!-- 转文字：脊的精读形态（顶带定位 + 句表 + 句尾锚点角标） -->
                <template v-else>
                  <section class="ov-sec tr-sec">
                    <TimeSpine
                      size="full"
                      mode="read"
                      :segments="memoSpineSegs"
                      :total-ms="memo.durationMs"
                      :pins="memoPins"
                      :head-ms="playing ? curMs : undefined"
                      :active-idx="spineActive"
                      :fold-silence-over="12"
                      @seek="onSpineSeek"
                      @pick="focusAt"
                    />
                    <p class="vs-hint">点句子跳到音频该句 · 点句尾角标对照总结</p>
                  </section>
                </template>
              </template>
            </div>
          </div>
          <!-- 底部控制：同一套底栏语言（工具 + 继续说）。
               全部中性 —— 这一屏没有「状态」可表达，颜色留给上一屏那颗暂停键。 -->
          <footer class="foot">
            <div class="vbar">
              <SessionGlassButton w="var(--vbar-h)" h="var(--vbar-h)" radius="50%">
                <button
                  ref="toolBtn"
                  class="vb ic"
                  type="button"
                  aria-label="工具"
                  aria-haspopup="menu"
                  :aria-expanded="toolOpen"
                  @click="toolOpen = true"
                >
                  <Settings2 :size="19" />
                </button>
              </SessionGlassButton>
              <SessionGlassButton h="var(--vbar-h)">
                <button class="vb wide" type="button" @click="startRecording">
                  <Mic :size="16" /> 继续说
                </button>
              </SessionGlassButton>
            </div>
            <p v-if="voice.lastError" class="err t-2">{{ voice.lastError }}</p>
          </footer>
        </template>

        <VoiceMemosSheet :open="memosOpen" @close="memosOpen = false" @pick="onPickMemo" />

        <!-- 工具菜单（bind：锚定底栏那颗圆钮弹出，三项都带图标） -->
        <AppMenu
          :open="toolOpen"
          :actions="toolActions"
          :anchor="toolBtn"
          title="工具"
          @close="toolOpen = false"
          @select="onToolSelect"
        />

        <!-- 完成 / 取消的二次确认：复用仓里统一的底部操作面板（与删除动作同一款） -->
        <ActionSheet
          :open="confirmFinish"
          title="完成并整理纪要？"
          :actions="[{ label: '完成，整理纪要', value: 'ok' }]"
          @select="(v: string) => { if (v === 'ok') { confirmFinish = false; void finishSpeaking() } }"
          @close="confirmFinish = false"
        />
        <ActionSheet
          :open="confirmCancel"
          title="取消本次录音？已转写的句子会一并丢弃"
          :actions="[{ label: '取消录音', value: 'ok', danger: true }]"
          @select="(v: string) => { if (v === 'ok') { confirmCancel = false; cancelSession() } }"
          @close="confirmCancel = false"
        />
        <audio
          v-if="memo?.audioPath"
          ref="audioEl"
          :src="memo.audioPath"
          @play="playing = true"
          @pause="playing = false"
          @timeupdate="onTime"
        />
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vs-root {
  /* 底栏唯一的高度：形状与高度不承担主次，只有色彩承担「哪个不一样」 */
  --vbar-h: 52px;
  position: fixed;
  inset: 0;
  z-index: 65;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  max-width: var(--frame-max);
  margin: 0 auto;
}

.vs-enter-active,
.vs-leave-active {
  transition:
    opacity var(--dur-sheet) var(--ease-sheet),
    transform var(--dur-sheet) var(--ease-sheet);
}

.vs-enter-from,
.vs-leave-to {
  opacity: 0;
  transform: translateY(24px);
}

/* ===== 顶栏 ===== */
.vs-top {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  padding: calc(var(--safe-top) + var(--sp-8)) var(--page-pad-x) var(--sp-8);
}

.vs-toprow {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  min-height: var(--control-icon);
}

.vs-tbtn {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  flex: none;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

/* 顶栏两颗入口（收起 / 全部纪要）视觉 34，命中区补到 44：
   它们是这一屏唯一常驻的导航钮，触屏上不该点空 */
.vs-tbtn::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-6)) calc(-1 * var(--sp-6));
  border-radius: inherit;
}

.vs-tbtn.wide::after {
  /* 宽版本身已超过 44，只在纵向补：横向不再外扩，避免压到中段状态簇 */
  inset: calc(-1 * var(--sp-6)) 0;
}

.vs-tbtn.wide {
  width: auto;
  border-radius: var(--radius-full);
  padding: 0 var(--sp-12);
  gap: var(--gap-tight);
  display: inline-flex;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

/* 录音态右侧的占位：与左侧那颗同宽，中段的状态簇才是真的落在中轴上 */
.vs-tbal {
  width: 34px;
  flex: none;
}

.vs-title {
  flex: 1;
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vs-title small {
  display: block;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  margin-top: var(--gap-text);
}

/* ----- 录音态的状态簇：波形 + 状态词 + 计时器 ----- */
.vs-live {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
}

.vs-live .vl-t {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.2px;
}

.vs-live .vl-sep {
  width: 1px;
  height: 12px;
  background: var(--line-strong);
  border-radius: 1px;
}

/* 计时器是这一刻的主角：字重轻、字距收紧、等宽数字，与波形一起读成「仪表」 */
.vs-live .vl-time {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  letter-spacing: -0.6px;
  font-variant-numeric: tabular-nums;
}

.wave {
  display: flex;
  align-items: center;
  gap: 2.5px;
  height: 18px;
  flex: none;
}

.wave i {
  width: 3px;
  height: 100%;
  border-radius: 2px;
  background: var(--danger);
  transform-origin: center;
  animation: wv 0.9s ease-in-out infinite;
}

.wave i:nth-child(1) {
  height: 40%;
}

.wave i:nth-child(2) {
  height: 74%;
  animation-delay: 0.12s;
}

.wave i:nth-child(3) {
  height: 100%;
  animation-delay: 0.24s;
}

.wave i:nth-child(4) {
  height: 64%;
  animation-delay: 0.08s;
}

.wave i:nth-child(5) {
  height: 46%;
  animation-delay: 0.2s;
}

/* 暂停：整簇落下成一条静态的等化器轮廓，颜色退到中性灰 ——
   「还在，但没在动」比单纯停掉动画更准确 */
.wave.off i {
  animation: none;
  background: var(--text-3);
}

@keyframes wv {
  0%,
  100% {
    transform: scaleY(0.4);
  }
  50% {
    transform: scaleY(1);
  }
}

/* ----- 副行：本段进度 ----- */
.vs-subrow {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  min-height: 15px;
}

.vs-prog {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  overflow: hidden;
}

/* 填充铺满整条轨道，从左缘用 scaleX 生长（每 250ms 走一格，300ms 的线性过渡把它接成连续生长）。
   不走 width：width 每帧都要重排（本项目的既有反模式），transform 只走合成。 */
.vs-prog i {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--led-shopping) 60%, var(--on-accent)),
    var(--led-shopping)
  );
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--on-accent) 35%, transparent);
  transform-origin: left center;
  transition: transform 300ms linear;
}

/* 暂停时条不再生长（elapsed 冻住），颜色也一起退掉 —— 状态是同一件事 */
.vs-prog.paused i {
  background: var(--text-3);
  box-shadow: none;
}

.vs-subtxt {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  /* 11px 的说明文字要能读：--text-3 在白底上只有 3.6:1，这一档提到 --text-2 */
  color: var(--text-2);
}

.vs-subtxt.err {
  color: var(--danger);
}

/* ===== 待机 ===== */
.ready {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-14);
  padding: 0 var(--page-pad-x) calc(var(--safe-bottom) + var(--sp-28));
  text-align: center;
}

.recover {
  width: 100%;
  padding: var(--sp-12) var(--sp-14);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-footnote);
}

.recover p {
  color: var(--text-2);
}

.rec-acts {
  display: flex;
  gap: var(--sp-8);
  margin-top: var(--sp-10);
}

.rbtn {
  position: relative;
  flex: 1;
  /* 常规按钮高 40（HarmonyOS 控件规范）：原先 34 比同屏其它主操作矮一档 */
  min-height: var(--control-md);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
}

/* 40 → 44：恢复提示里的两颗按钮一左一右，各补 2px 纵向热区，横向不重叠 */
.rbtn::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--gap-text)) 0;
  border-radius: inherit;
}

.rbtn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

/* 待机态的呼吸圆：语音域色的淡彩底 + 同色波形图标。
   原先是一颗四层径向渐变的霓虹球 + 零偏移彩色光晕 —— 那种写法在全应用里独一份，
   且光晕是纯装饰。这里回到与工具格同一套语言，动画保留（它表达「在等你开口」）。 */
.ready-orb {
  width: 110px;
  height: 110px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--text-1);
  animation: vbreathe 4s var(--ease-standard) infinite;
}

@keyframes vbreathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.04);
  }
}

.ready-cap {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.err {
  font-size: var(--fs-caption);
  color: var(--danger);
}

/* ===== 转写区（page padding 对齐全应用） ===== */
.tr {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-6) var(--page-pad-x) var(--sp-10);
  scrollbar-width: none;
}

.tr::-webkit-scrollbar {
  display: none;
}

.tr-empty {
  padding: var(--sp-26) var(--sp-2);
  font-size: var(--fs-footnote);
}

/* ===== 纪要详情 ===== */
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-10) var(--page-pad-x) calc(var(--safe-bottom) + var(--sp-20));
  scrollbar-width: none;
}

.body::-webkit-scrollbar {
  display: none;
}

.vm-head {
  display: flex;
  gap: var(--sp-10);
  padding: var(--sp-2) var(--sp-2) var(--sp-12);
}

.vm-ic {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.vm-t {
  flex: 1;
  min-width: 0;
}

.vm-t b {
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  display: block;
  line-height: var(--lh-title);
}

.vm-t em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
  display: block;
  margin-top: var(--gap-text);
}

/* 时长是这一屏的主数值：title3 + 等宽，与其余三个元数据分形 */
.vm-t em.vm-dur {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  letter-spacing: -0.3px;
  margin-top: var(--sp-4);
}

/* 重放条：可交互控件 → 卡片 */
.player {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: var(--sp-8) var(--sp-12);
  background: var(--surface);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
}

.pl-btn {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex: none;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 32 的播放钮命中区补到 44（播放器条内距 8，外扩 6 仍落在条内） */
.pl-btn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.pl-cur,
.pl-dur {
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
  color: var(--text-2);
  flex: none;
}

/* 轨道走「细轨 + 实心填充 + 端头圆钮」：与时间脊同一套几何观感，
   但用 accent 而不是域色 —— 这是音频播放，不是会话结构。 */
.pl-bar {
  position: relative;
  flex: 1;
  height: 4px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 10%, transparent);
  cursor: pointer;
}

.pl-bar i {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.pl-bar b {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  /* 亮暗两色档同为白（iOS 规格，令牌已写明）—— 用 --surface 在暗色下会变成一颗看不见的暗钮 */
  background: var(--switch-knob);
  box-shadow: var(--shadow-thumb);
  transform: translate(-50%, -50%);
}

/* 分段控件 */
.seg {
  position: relative;
  display: flex;
  margin-top: var(--sp-12);
  background: var(--surface-2);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
}

.seg .sthumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc(50% - 2px);
  background: var(--surface);
  border-radius: var(--radius-xs);
  box-shadow: var(--shadow-thumb);
  transition: transform var(--dur-base) var(--ease-standard);
}

.seg.right .sthumb {
  transform: translateX(100%);
}

.seg button {
  position: relative;
  z-index: 1;
  flex: 1;
  height: 28px;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  border-radius: var(--radius-xs);
}

.seg button.on {
  color: var(--text-1);
  font-weight: var(--fw-bold);
}

/* 整理中（轻提示行，无卡片壳） */
.proc {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  padding: var(--sp-16) var(--sp-2);
}

.spin {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2.5px solid var(--line);
  border-top-color: var(--accent);
  animation: rot 1s linear infinite;
  flex: none;
}

@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}

.proc b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  display: block;
}

.proc em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 总结（平铺 + Markdown） */
.ov-sec {
  margin-top: var(--gap-lg);
}

.ov-sec > h5 {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  /* 小节标题是必须读出来的结构信息：走 --text-2（4.9:1），不吃 --text-3 的微字档 */
  color: var(--text-2);
  letter-spacing: 0.5px;
  margin-bottom: var(--gap-text);
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
}

/* 小结标题只留标题本身：句数与时长已由上方纪要头卡给出，h5 里不再挂 em
   （原 `.ov-sec > h5 em` 规则随之删除 —— 三个小节标题现在都是纯文本） */
.sum-li {
  display: flex;
  gap: var(--gap-sm);
  padding: var(--sp-8) 0;
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
}

.sum-li + .sum-li {
  border-top: 0.5px solid var(--line);
}

.sum-li .ic {
  flex: none;
  width: 17px;
  height: 17px;
  margin-top: var(--sp-2);
  border-radius: var(--radius-xs);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  display: flex;
  align-items: center;
  justify-content: center;
}

.i-food {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.i-todo {
  background: var(--accent-soft);
  color: var(--accent);
}

.i-note {
  background: var(--surface-2);
  color: var(--text-2);
}

.sum-body {
  flex: 1;
  min-width: 0;
}

.md-line {
  display: block;
}

.sub {
  font-style: normal;
  color: var(--text-2);
  font-size: var(--fs-caption);
  display: block;
  margin-top: var(--gap-text);
}

.cite {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 var(--sp-4);
  margin-left: var(--sp-4);
  border-radius: var(--radius-full);
  vertical-align: 2px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  /* 交互文字不小于 12（HarmonyOS 文本排版下限）：原先 10px 是微字档，
     引用角标是**可点的**，不能落在说明文字那一档 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

/* 待办行卡 */
.todo-li {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: var(--sp-10) var(--sp-12);
  background: var(--surface);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  margin-top: var(--gap-sm);
}

.todo-li .cb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  flex: none;
}

.todo-li .cb.done {
  background: var(--ok);
  border-color: var(--ok);
}

.todo-li .tt {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-body);
}

.todo-li .tt em {
  font-style: normal;
  display: block;
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-weight: var(--fw-regular);
  margin-top: var(--gap-text);
}

.todo-li .wbtn {
  flex: none;
  height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  /* soft 底上的文字走 strong 档（STANDARDS §4） */
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.done-mark {
  color: var(--ok);
  font-weight: var(--fw-bold);
  flex: none;
}

/* 底部操作（平铺按钮组） */
.acts-flat {
  display: flex;
  gap: var(--gap-sm);
  margin-top: var(--gap-lg);
}

.acts-flat button {
  flex: 1;
  height: var(--control-md);
  border-radius: var(--radius-full);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
}

.acts-flat .commit {
  background: var(--accent);
  color: var(--on-accent);
}

/* 禁用浓度全站同一档（tokens.css），不再各写各的裸值 */
.acts-flat .commit:disabled {
  opacity: var(--disabled-opacity);
}

.acts-flat .ghost {
  background: var(--surface-2);
  color: var(--text-1);
}

.mini-wave {
  display: inline-flex;
  align-items: flex-end;
  gap: var(--sp-2);
  height: 12px;
}

.mini-wave i {
  width: 2.5px;
  border-radius: 2px;
  background: currentColor;
  animation: wv 0.9s ease-in-out infinite;
}

.mini-wave i:nth-child(1) {
  height: 40%;
}

.mini-wave i:nth-child(2) {
  height: 90%;
  animation-delay: 0.15s;
}

.mini-wave i:nth-child(3) {
  height: 60%;
  animation-delay: 0.3s;
}

/* 转文字页 */
.tr-sec {
  margin-top: var(--sp-8);
}

/* 11px 的说明文字用 --text-3 只有约 2.3:1，读不清；提到 --text-2（≈4.9:1） */
.vs-hint {
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-top: var(--sp-8);
}

/* ===== 底部控制（统一操作语言） ===== */
.foot {
  flex: none;
  padding: var(--sp-10) var(--page-pad-x) calc(var(--safe-bottom) + var(--sp-14));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-10);
}

.vbar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-10);
}

.vb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-6);
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
  color: var(--text-1);
  transition: transform var(--dur-fast) var(--ease-standard), background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.vb.ic {
  width: var(--vbar-h);
  height: var(--vbar-h);
  padding: 0;
}

.vb.wide {
  height: var(--vbar-h);
  padding: 0 var(--sp-20);
}

/* 玻璃里的按钮**撑满玻璃**：正圆与胶囊的几何都由玻璃那一层给。
   玻璃自带 1px 受光描边，按钮若也按 --vbar-h 定长宽会被裁掉 2px（圆会变成椭圆）。 */
:deep(.sgbtn) .vb.ic {
  width: 100%;
  height: 100%;
}

:deep(.sgbtn) .vb.wide {
  height: 100%;
}

/* 禁用浓度全站同一档（tokens.css），不再各写各的裸值 */
.vb:disabled {
  opacity: var(--disabled-opacity);
}

/* 按压反馈加在玻璃里的按钮上（玻璃自身不缩放，折射才不失效） */
.vb:active:not(:disabled) {
  transform: scale(0.94);
}

/* 暂停/继续：全屏唯一带颜色的按钮。
   · 录音中（显示暂停）：淡彩底 —— 它是「先停下」这个次要动作；
   · 已暂停（显示继续）：实色 —— 此刻这是用户唯一该按的那颗。 */
.vb.state.hold {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.vb.state.go {
  background: var(--accent);
  color: var(--on-accent);
}

/* 暂停↔播放的交叉淡入：两颗图标常驻叠放，只换不透明度与缩放，
   所以来回快切也不会出现「空档」，中断即可逆。 */
.swap {
  position: relative;
  width: 19px;
  height: 19px;
  display: grid;
  place-items: center;
}

.swap svg {
  position: absolute;
  transition:
    opacity 140ms var(--ease-standard),
    transform 140ms var(--ease-spring);
}

.swap .s-play {
  opacity: 0;
  transform: scale(0.5);
}

.vb.state.go .swap .s-pause {
  opacity: 0;
  transform: scale(0.5);
}

.vb.state.go .swap .s-play {
  opacity: 1;
  transform: scale(1);
}

.mic-big {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
}

/* 待机态的主 CTA。**类名不能叫 ready** —— `.ready` 是外层容器的类，
   `flex: 1 + padding` 会连带命中按钮，把 72×72 撑成 72×167 的椭圆（真实的坑）。 */
.mic-big.start {
  background: var(--accent);
  color: var(--on-accent);
  box-shadow: var(--shadow-float);
}

.kbd-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  width: 100%;
  padding: var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.kbd-bar input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  padding-left: var(--sp-8);
}

.kb-send {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--fw-bold);
}

/* 32 的发送钮命中区补到 44（键盘条本身 ~48 高，外扩的 6 落在条内） */
.kb-send::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

/* 禁用浓度全站同一档（tokens.css），不再各写各的裸值 */
.kb-send:disabled {
  opacity: var(--disabled-opacity);
}

.kbd-reply {
  width: 100%;
  max-height: 160px;
  overflow-y: auto;
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
}

@media (prefers-reduced-motion: reduce) {
  .ready-orb,
  .wave i,
  .mini-wave i,
  .spin {
    animation: none;
  }

  .vs-enter-active,
  .vs-leave-active {
    transition-duration: 150ms;
  }

  .vs-prog i,
  .swap svg,
  .vb,
  .seg .sthumb {
    transition: none;
  }
}
</style>
