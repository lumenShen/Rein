/**
 * 语音会话运行时 · 应用级单例（与组件树生命周期解耦，仿 recorderRuntime / workoutRuntime）。
 *
 * 状态机：closed →(openView)→ ready →(startRecording)→ recording
 *        →(finishSpeaking)→ processing → memo →(再说一轮)→ recording…
 * 转写中可 minimize 收起为浮条（后台转写继续）。
 *
 * 链路：AudioWorklet 16k PCM（200ms 包）→ voice_asr_audio → Rust WS → 豆包 ASR；
 * definite 句经 `voice://asr` 事件逐句上屏并落草稿（500ms 防抖，崩溃粒度=句）；
 * 「每 3 分钟自动整理」到点把未结算句结算为一段交 memoGen（录音不中断）。
 * 与录音系统经 micBus 互斥。
 *
 * **AI 栈按需加载**：本模块被 App 根部的语音浮条静态 import，所以它对 `stores/ai` 的
 * 引用一律走函数内 `aiStore()`（动态 import）。静态 import 会把整个 AI 工具栈
 * （工具注册表 + 全部工具域）钉进启动主包，而语音链路真正用到它只在「结算一段」之后。
 */

import { reactive } from 'vue'

import { audioUrlFromPath, voiceService } from '@/services/voiceService'
import type { AsrEventPayload, MemoSummaryItem, VoiceMemo, VoiceSentence, VoiceDraft } from '@/types'
import { toParsedItems } from '@/ai/foodMatch'
import { suggestMeal } from '@/config/domain'
import { todayStr } from '@/utils/date'
import { useTodoStore } from '@/stores/todo'
import { int16ToB64, mergeInt16 } from './pcm'
import { useToast } from '@/composables/useToast'
import { claimMic, micOwner, releaseMic } from './micBus'

/** 自动整理窗口：每满 3 分钟把已转写内容结算一段交 AI（录音不中断） */
/** 自动整理窗口长度（3 分钟）。导出给视图画「本段进度条」——
 *  进度条必须以它为准，否则条和「N 后整理」的文案会对不上。 */
export const SETTLE_MS = 3 * 60 * 1000
const DRAFT_DEBOUNCE = 500
const AUTO_SETTLE_KEY = 'rein.voice.autoSettle.v1'

export interface VoiceState {
  /** closed=未打开；ready=待机；session=转写/整理；memo=纪要详情 */
  view: 'closed' | 'ready' | 'session' | 'memo'
  minimized: boolean
  /**
   * paused = 录音中但**不采音频、不走计时**（用户按了暂停）。
   * 单独一档而不是复用 recording + 一个布尔：视图、悬浮条、自动整理、完成/取消
   * 四条路径都要判它，分散的布尔会在某一条上漏掉（表现为「暂停了还在转写」）。
   */
  status: 'idle' | 'recording' | 'paused' | 'processing'
  elapsedMs: number
  /** 本次会话全部定稿句（含已结算段； settledIdx 之前属于已产出段） */
  sentences: VoiceSentence[]
  partial: string
  settledIdx: number
  segmentCount: number
  /** 下次自动结算的 elapsedMs 时点（autoSettle=false 时不使用） */
  nextSettleAt: number
  /** 距下次自动结算的毫秒数（autoSettle=false 时为 0） */
  settleRemainMs: number
  autoSettle: boolean
  lastError: string
  /** 本段录音回放 URL（ended 事件后有值） */
  audioUrl: string | null
  durationMs: number
  currentMemo: VoiceMemo | null
  /** 后台整理中的段数（>0 显示整理中提示） */
  processingCount: number
  configured: boolean
  /** 崩溃恢复草稿（ready 视图提示补交/丢弃） */
  recovered: VoiceDraft | null
  /** TTS 朗读中 */
  speaking: boolean
}

/**
 * 会话是否「仍在手里」—— 录音中或已暂停。
 * 暂停不是结束：完成、取消、收起浮条、热键都要照常认它，
 * 否则暂停之后这些操作会静默失效（用户读到的是「按钮没反应」）。
 */
export function isLive(): boolean {
  return voice.status === 'recording' || voice.status === 'paused'
}

export const voice = reactive<VoiceState>({
  view: 'closed',
  minimized: false,
  status: 'idle',
  elapsedMs: 0,
  sentences: [],
  partial: '',
  settledIdx: 0,
  segmentCount: 0,
  nextSettleAt: SETTLE_MS,
  settleRemainMs: 0,
  autoSettle: (() => {
    try {
      return localStorage.getItem(AUTO_SETTLE_KEY) === '1'
    } catch {
      return false
    }
  })(),
  lastError: '',
  audioUrl: null,
  durationMs: 0,
  currentMemo: null,
  processingCount: 0,
  configured: false,
  recovered: null,
  speaking: false,
})

export function setAutoSettle(v: boolean): void {
  voice.autoSettle = v
  try {
    localStorage.setItem(AUTO_SETTLE_KEY, v ? '1' : '0')
  } catch {
    /* 忽略不可用的本地存储 */
  }
}

/* ---------- 麦克风管线（非响应式模块状态） ---------- */

let sessionId = ''
let startedAt = 0
/** 暂停时结存的已录音时长（毫秒）；恢复时用它回推 startedAt */
let accumulatedMs = 0
/** 暂停那一刻的时间戳；非 null = 当前处于暂停中 */
let pausedAt: number | null = null
let seq = 0
let audioCtx: AudioContext | null = null
let worklet: AudioWorkletNode | null = null
let mediaStream: MediaStream | null = null
let unlisten: (() => void) | null = null
let acc: Int16Array[] = []
let elapsedTimer: number | null = null
let draftTimer: number | null = null
let endedResolve: (() => void) | null = null
let audioPathRaw: string | null = null
let speakingAudio: HTMLAudioElement | null = null

function stopMedia(): void {
  mediaStream?.getTracks().forEach((t) => t.stop())
  mediaStream = null
}

function stopMicPipeline(): void {
  if (worklet) {
    worklet.port.onmessage = null
    try {
      worklet.disconnect()
    } catch {
      /* 忽略 */
    }
  }
  worklet = null
  if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close().catch(() => undefined)
  audioCtx = null
  stopMedia()
  acc = []
  if (unlisten) {
    unlisten()
    unlisten = null
  }
}

/** 纪要展示前把音频绝对路径转成可播放 URL（mock 下原样） */
function withAudioUrl(memo: VoiceMemo): VoiceMemo {
  return { ...memo, audioPath: audioUrlFromPath(memo.audioPath) }
}

/**
 * 取 AI store —— **动态 import**，见文件头的「AI 栈按需加载」。
 * 三处调用都在函数体内（不是模块顶层），所以调用点只是多一次 await。
 */
async function aiStore(): Promise<ReturnType<typeof import('@/stores/ai').useAiStore>> {
  const { useAiStore } = await import('@/stores/ai')
  return useAiStore()
}

function scheduleDraftSave(): void {
  if (draftTimer != null) clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => void saveDraft(), DRAFT_DEBOUNCE)
}

async function saveDraft(): Promise<void> {
  draftTimer = null
  const ai = await aiStore()
  await voiceService
    .draftSave({
      sessionId,
      chatId: ai.chatId,
      startedAt: new Date(startedAt).toISOString(),
      sentences: voice.sentences,
      partial: voice.partial,
    })
    .catch(() => undefined)
}

/* ---------- 事件 ---------- */

function flushPartial(): void {
  const text = voice.partial.trim()
  if (!text) return
  voice.sentences = [
    ...voice.sentences,
    { idx: voice.sentences.length, text, startMs: 0, endMs: voice.elapsedMs },
  ]
  voice.partial = ''
}

function onAsrEvent(e: AsrEventPayload): void {
  if (e.sessionId !== sessionId) return
  if (e.kind === 'final') {
    const text = e.text ?? ''
    if (!text) return
    voice.sentences = [
      ...voice.sentences,
      { idx: voice.sentences.length, text, startMs: e.startMs ?? 0, endMs: e.endMs ?? e.startMs ?? 0 },
    ]
    voice.partial = ''
    scheduleDraftSave()
  } else if (e.kind === 'partial') {
    voice.partial = e.text ?? ''
    scheduleDraftSave()
  } else if (e.kind === 'ended') {
    audioPathRaw = e.audioPath ?? null
    voice.audioUrl = audioUrlFromPath(e.audioPath)
    voice.durationMs = e.durationMs ?? 0
    endedResolve?.()
    endedResolve = null
  } else if (e.kind === 'error') {
    voice.lastError = e.message ?? '识别出错'
    endedResolve?.()
    endedResolve = null
    // 出错时保留已存内容并停止采集（转写不丢）
    if (isLive()) void finishSpeaking()
  }
}

/* ---------- 视图与恢复 ---------- */

/** 打开语音会话视图；识别（ASR）未配置时引导去模型页 */
export async function openView(): Promise<boolean> {
  if (!voice.configured) {
    const st = await voiceService.configStatus().catch(() => null)
    voice.configured = st?.asrReady === true
  }
  if (!voice.configured) return false
  if (voice.view === 'closed') {
    const draft = await voiceService.draftGet().catch(() => null)
    voice.recovered = draft && draft.sentences?.length ? draft : null
    voice.view = 'ready'
  } else {
    voice.minimized = false
  }
  return true
}

export function closeView(): void {
  if (isLive()) {
    minimize()
    return
  }
  voice.view = 'closed'
  voice.minimized = false
}

/** 收起为浮条（录音/整理继续） */
export function minimize(): void {
  if (isLive() || voice.status === 'processing') voice.minimized = true
  else voice.view = 'closed'
}

export function restore(): void {
  voice.minimized = false
}

export function discardRecovered(): void {
  voice.recovered = null
  void voiceService.draftClear().catch(() => undefined)
}

/** 补交上次崩溃残留的转写（整理为纪要） */
export async function recoverSubmit(): Promise<void> {
  const draft = voice.recovered
  if (!draft) return
  voice.recovered = null
  void voiceService.draftClear().catch(() => undefined)
  voice.sentences = draft.sentences
  voice.settledIdx = 0
  voice.status = 'processing'
  voice.view = 'memo'
  await settleSegment(false)
}

/* ---------- 录音与结算 ---------- */

/** 开始录音（幂等）；失败原因写入 voice.lastError */
export async function startRecording(): Promise<boolean> {
  if (isLive()) return true
  voice.lastError = ''
  if (micOwner() === 'recorder') {
    voice.lastError = '麦克风被录音功能占用中'
    return false
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
    voice.lastError = '当前环境不支持语音采集'
    return false
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    voice.lastError = '无法访问麦克风，请检查权限'
    return false
  }
  if (!claimMic('voice')) {
    stopMedia()
    voice.lastError = '麦克风被其他功能占用中'
    return false
  }
  try {
    audioCtx = new AudioContext()
    await audioCtx.audioWorklet.addModule('/voice-worklet.js')
    worklet = new AudioWorkletNode(audioCtx, 'pcm-capture')
    worklet.port.onmessage = (e: MessageEvent) => {
      // 暂停期间**丢弃**音频块（管线不拆，恢复才无感）。放在最前面：
      // 攒进 acc 再判就晚了 —— 恢复后会把暂停前攒的半包和新音频拼成一句。
      if (voice.status === 'paused') return
      acc.push(e.data as Int16Array)
      if (acc.length >= 2) {
        const merged = mergeInt16(acc)
        acc = []
        // 200ms 一包（豆包双向流式最优）
        void voiceService.asrAudio(sessionId, int16ToB64(merged)).catch(() => undefined)
      }
    }
    audioCtx.createMediaStreamSource(mediaStream).connect(worklet)
    worklet.connect(audioCtx.destination)
  } catch (e) {
    stopMicPipeline()
    releaseMic('voice')
    const detail = e instanceof Error ? e.message : String(e)
    voice.lastError = `语音采集不可用：${detail}`
    return false
  }

  sessionId = `vs${Date.now().toString(36)}${++seq}`
  startedAt = Date.now()
  accumulatedMs = 0
  pausedAt = null
  voice.elapsedMs = 0
  voice.sentences = []
  voice.partial = ''
  voice.settledIdx = 0
  voice.segmentCount = 0
  voice.nextSettleAt = SETTLE_MS
  voice.settleRemainMs = SETTLE_MS
  voice.audioUrl = null
  voice.durationMs = 0
  audioPathRaw = null
  voice.view = 'session'
  voice.minimized = false
  voice.status = 'recording'

  unlisten = await voiceService.onAsr(onAsrEvent)
  discardRecovered() // 选择重新开始即丢弃崩溃草稿
  try {
    await voiceService.asrStart(sessionId)
  } catch (e) {
    voice.lastError = e instanceof Error ? e.message : String(e)
    stopMicPipeline()
    releaseMic('voice')
    voice.status = 'idle'
    voice.view = 'ready'
    return false
  }

  elapsedTimer = window.setInterval(() => {
    // 计时基于 accumulatedMs + 本段已走时间：暂停时把 accumulatedMs 冻结、
    // 恢复时把 startedAt 回推，于是 elapsedMs（以及依赖它的自动整理窗口）自然停住。
    voice.elapsedMs = accumulatedMs + (pausedAt != null ? 0 : Date.now() - startedAt)
    if (voice.autoSettle) {
      voice.settleRemainMs = Math.max(0, voice.nextSettleAt - voice.elapsedMs)
      if (voice.elapsedMs >= voice.nextSettleAt && voice.sentences.length > voice.settledIdx) {
        void settleSegment(true)
      }
    }
  }, 250)
  return true
}

/**
 * 暂停 / 继续录音（同一个按钮的两面）。
 *
 * 暂停做三件事，缺一不可：
 *  1. **闸掉音频转发**：AudioWorklet 仍在跑（不拆管线，恢复才无感），但 onmessage 里
 *     丢弃数据块 —— 否则暂停期间说的话照样会被转写；
 *     同时清空 `acc` 里攒着的半包，避免恢复后把暂停前的残块和新音频拼成一句。
 *  2. **冻住计时**：把已走时间结进 accumulatedMs，elapsedMs 不再上涨 ——
 *     自动整理的窗口（nextSettleAt 是 elapsed 时点）也跟着一起停。
 *  3. **不动 ASR 连接**：豆包那边保持会话，恢复即续传，不必重连（重连会丢上下文）。
 */
export function pauseRecording(): void {
  if (voice.status !== 'recording') return
  accumulatedMs = voice.elapsedMs
  pausedAt = Date.now()
  acc = []
  voice.status = 'paused'
}

export function resumeRecording(): void {
  if (voice.status !== 'paused') return
  // 把起点回推，让「重启后已经过去的时间」不计入时长（否则暂停多久就多算多久）
  startedAt = Date.now() - accumulatedMs
  pausedAt = null
  voice.status = 'recording'
}

/** 在录音中 / 已暂停之间翻转；其它状态是 no-op */
export function togglePauseRecording(): void {
  if (voice.status === 'recording') pauseRecording()
  else if (voice.status === 'paused') resumeRecording()
}

/** 完成并整理纪要：停采集 → 等最终句 → 剩余内容结算为一段（前台，展示纪要） */
export async function finishSpeaking(): Promise<void> {
  if (!isLive()) return
  // 暂停中直接完成：先把计时与状态接回来，后面的停采集/结算才走同一条路
  if (voice.status === 'paused') resumeRecording()
  if (elapsedTimer != null) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  const ended = new Promise<void>((resolve) => {
    endedResolve = resolve
    window.setTimeout(() => {
      if (endedResolve) {
        endedResolve = null
        resolve()
      }
    }, 6000)
  })
  try {
    await voiceService.asrFinish(sessionId)
  } catch {
    /* 服务端收尾失败也照常整理已收到的句子 */
  }
  await ended
  stopMicPipeline()
  releaseMic('voice')
  voice.minimized = false // 浮条上「完成」也要回到界面看纪要

  const hasMore = voice.sentences.length > voice.settledIdx || !!voice.partial.trim()
  if (!hasMore) {
    if (voice.segmentCount === 0) {
      const toast = useToast()
      toast.toast('这段没有识别到内容')
      voice.status = 'idle'
      voice.view = 'ready'
      void voiceService.draftClear().catch(() => undefined)
      return
    }
    // 全部已自动结算：直接看最近一条纪要
    voice.status = 'idle'
    voice.view = 'memo'
    return
  }
  voice.status = 'processing'
  voice.view = 'memo'
  await settleSegment(false)
  void voiceService.draftClear().catch(() => undefined)
}

/** 取消当前会话：丢弃未结算内容与音频 */
export async function cancelSession(): Promise<void> {
  if (sessionId) await voiceService.asrCancel(sessionId).catch(() => undefined)
  stopMicPipeline()
  releaseMic('voice')
  if (elapsedTimer != null) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  voice.sentences = []
  voice.partial = ''
  voice.settledIdx = 0
  voice.segmentCount = 0
  voice.audioUrl = null
  voice.durationMs = 0
  audioPathRaw = null
  voice.currentMemo = null
  voice.lastError = ''
  voice.status = 'idle'
  voice.view = 'ready'
  void voiceService.draftClear().catch(() => undefined)
}

/** 结算一段：把 settledIdx 之后的句子（含未完句）交给 AI 整理。
 * auto=true 为 3 分钟窗口自动结算（后台跑，录音继续）；false 为完成时前台结算（产出纪要卡）。 */
async function settleSegment(auto: boolean): Promise<void> {
  flushPartial()
  const raw = voice.sentences.slice(voice.settledIdx)
  if (raw.length === 0) {
    if (!auto && voice.status === 'processing') voice.status = 'idle'
    return
  }
  voice.settledIdx = voice.sentences.length
  voice.segmentCount++
  const lines = raw.map((s, i) => ({ idx: i, text: s.text, startMs: s.startMs, endMs: s.endMs }))
  const memoId = `vm${Date.now().toString(36)}${++seq}`
  const ai = await aiStore()
  await ai.init()
  voice.processingCount++
  try {
    const memo = await ai.sendVoiceTurn({
      lines,
      memoId,
      audioPath: audioPathRaw,
      durationMs: voice.durationMs,
    })
    if (memo) {
      voice.currentMemo = withAudioUrl(memo)
      if (!auto) voice.status = 'idle'
    } else if (!auto) {
      voice.status = 'idle'
    }
  } finally {
    voice.processingCount = Math.max(0, voice.processingCount - 1)
    if (auto) voice.nextSettleAt = voice.elapsedMs + SETTLE_MS
  }
}

/* ---------- 纪要查看 / 朗读 / 写入 ---------- */

/** 打开一条历史纪要（全部纪要列表 / AI 页语音气泡） */
export async function openMemoById(id: string): Promise<void> {
  if (isLive()) return // 录音/暂停中不打断会话视图
  try {
    voice.currentMemo = withAudioUrl(await voiceService.memoGet(id))
    voice.view = 'memo'
    voice.minimized = false
  } catch {
    const toast = useToast()
    toast.toast('纪要不存在或已删除')
  }
}

/** 朗读纪要（TTS 同步合成后播放；再次调用即停止） */
export async function speakMemo(memo: VoiceMemo): Promise<void> {
  const toast = useToast()
  if (voice.speaking) {
    stopSpeak()
    return
  }
  const text = memo.summary.map((it) => it.text).join('；') || memo.sentences.map((s) => s.text).join('')
  if (!text.trim()) {
    toast.toast('这段纪要没有内容可朗读')
    return
  }
  try {
    const { audioUrl } = await voiceService.ttsSpeak(memo.id, text)
    if (!audioUrl) throw new Error('未获得音频')
    const a = new Audio(audioUrl)
    speakingAudio = a
    a.onended = () => {
      voice.speaking = false
      speakingAudio = null
    }
    await a.play()
    voice.speaking = true
  } catch (e) {
    voice.speaking = false
    speakingAudio = null
    toast.toast(`朗读失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

export function stopSpeak(): void {
  speakingAudio?.pause()
  speakingAudio = null
  voice.speaking = false
}

/** 写入纪要条目：todo → 创建待办；food → 匹配/补录食物并记入今日饮食 */
export async function writeMemoItem(memo: VoiceMemo, item: MemoSummaryItem): Promise<boolean> {
  if (item.kind === 'note' || item.written) return true
  const toast = useToast()
  try {
    if (item.kind === 'todo' && item.todo) {
      await useTodoStore().create({
        title: item.todo.title,
        date: item.todo.date || todayStr(),
        startMin: item.todo.startMin ?? null,
        category: 'general',
        priority: 0,
      })
    } else if (item.kind === 'food' && item.food) {
      const items = await toParsedItems([
        { foodName: item.food.name, grams: item.food.grams ?? 100, kcalEstimate: 0, foodId: null, nutrition: {} },
      ])
      const r = await (await aiStore()).commitParsedItems(items, suggestMeal())
      if (r.written === 0) throw new Error('未能匹配到食物库')
    }
    item.written = true
    await voiceService.memoSetSummary(memo.id, JSON.stringify(memo.summary))
    return true
  } catch (e) {
    toast.toast(`写入失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 全部写入（todo/food 条目逐个执行） */
export async function writeMemoAll(memo: VoiceMemo): Promise<number> {
  let n = 0
  for (const item of memo.summary) {
    if (item.kind === 'note' || item.written) continue
    if (await writeMemoItem(memo, item)) n++
  }
  return n
}
