/**
 * AI 页语音输入运行时 · 输入框麦克风按钮的独立链路（不复用 voiceRuntime 的会话/纪要层）。
 *
 * 两种驱动方式共用同一条「采集 → ASR」管线（worklet 16k PCM 200ms 一包）：
 * - 按住说话（hold）：按下即开始，松开即结束、文字上屏；
 * - 轻点说话（continuous）：按下即开始，松开时不足一次「按住」则转入连听——
 *   等待**停止信号**自动结束：最后一个（音量占优的）发言人停止输出、
 *   静默超过 SILENCE_MS 后自动收束；在此之前用户再点一次（遮罩任意处）也可手动结束。
 *
 * 停止信号：ASR 事件没有置信度字段，改用**音量占优**近似「置信度较高」——
 * 离麦最近的说话人必然最响，只有峰值过「主导门槛」的语音段才算主导发言人开口；
 * 主导发言人开过口、且此后持续静默，即视为TA已停止输出。
 *
 * 与录音系统 / 语音会话经 micBus 互斥（owner 'ai-input'）。
 * 模块级状态 + reactive 快照，与组件树生命周期解耦（页面离开由页面负责取消）。
 */

import { reactive } from 'vue'

import { voiceService } from '@/services/voiceService'
import type { AsrEventPayload } from '@/types'
import { claimMic, micOwner, releaseMic } from './micBus'
import { int16ToB64, mergeInt16 } from './pcm'

/** 按下低于该时长视为「轻点」（转入连听），否则是「按住」（松开即结束） */
export const VOICE_TAP_MS = 320

/* ---------- 停止信号参数（连听模式） ---------- */
/** 主导发言人停止后的静默窗口：超过即认为TA已停止输出 */
const SILENCE_MS = 1500
/** 自动结束的最短总时长（防止刚点开就被环境噪声里的假静默收掉） */
const MIN_TOTAL_MS = 1500
/** 一段语音要算「开口」的最短时长 */
const MIN_SPEECH_MS = 240
/** 单次语音输入硬上限（连听失控的保险丝） */
const MAX_SESSION_MS = 120_000
/** 结束时等 ASR 收尾句的超时（ended 事件到达即提前放行） */
const FINAL_WAIT_MS = 2500
/** worklet 一包 = 100ms（1600 样本 @16k），主线程再攒 2 包发 200ms */
const PACKET_MS = 100

export interface AiVoiceInputState {
  active: boolean
  /** hold=按住松开结束；continuous=连听，等停止信号或再点一次 */
  mode: 'hold' | 'continuous'
  /** starting=连接中；listening=聆听中；stopping=已请求结束，等收尾句 */
  phase: 'starting' | 'listening' | 'stopping'
  finals: string[]
  partial: string
  /** 最近一包的平滑 RMS（0..1），遮罩画音量用 */
  volume: number
  elapsedMs: number
  lastError: string
}

export const aiVoiceInput = reactive<AiVoiceInputState>({
  active: false,
  mode: 'hold',
  phase: 'starting',
  finals: [],
  partial: '',
  volume: 0,
  elapsedMs: 0,
  lastError: '',
})

export type AiVoiceStopReason = 'release' | 'manual' | 'stop-signal' | 'cap' | 'error' | 'cancel'
export interface AiVoiceResult {
  text: string
  reason: AiVoiceStopReason
}

let handler: ((r: AiVoiceResult) => void) | null = null

/** 注册结果回调（页面层接住文字上屏 / 空结果提示） */
export function onAiVoiceResult(fn: (r: AiVoiceResult) => void): void {
  handler = fn
}

/* ---------- 文本拼接：中英文相邻的空格规则 ---------- */

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

/** 把一段新识别文字接到已有文本后面：两侧都是 ASCII 词字符时补一个空格，中文直接相连 */
export function appendVoiceText(prev: string, next: string): string {
  if (!prev) return next
  if (!next) return prev
  const a = prev[prev.length - 1]
  const b = next[0]
  if (!CJK_RE.test(a) && !CJK_RE.test(b) && /\w|[)）."']/.test(a) && /[\w(".']/.test(b)) {
    return `${prev} ${next}`
  }
  return prev + next
}

function joinSegments(segs: string[]): string {
  return segs.reduce((acc, s) => appendVoiceText(acc, s), '')
}

/* ---------- 非响应式管线状态 ---------- */

let sessionId = ''
let seq = 0
let startedAt = 0
let audioCtx: AudioContext | null = null
let worklet: AudioWorkletNode | null = null
let mediaStream: MediaStream | null = null
let unlisten: (() => void) | null = null
let acc: Int16Array[] = []
let tickTimer: number | null = null
let finalWaitResolve: (() => void) | null = null
let stopInProgress = false

/** VAD 计数（包粒度，onPcm 里累计） */
let noiseFloor = 0.012
let inSpeechRun = false
let runMs = 0
let runPeak = 0
let silenceMs = 0
let hadDominantSpeech = false

function err(msg: string): void {
  aiVoiceInput.lastError = msg
}

function stopMedia(): void {
  mediaStream?.getTracks().forEach((t) => t.stop())
  mediaStream = null
}

/** 拆管线 + 还麦克风；不动响应式状态（调用方负责） */
function teardown(): void {
  if (tickTimer != null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
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
  releaseMic('ai-input')
}

function resetSessionState(): void {
  aiVoiceInput.finals = []
  aiVoiceInput.partial = ''
  aiVoiceInput.volume = 0
  aiVoiceInput.elapsedMs = 0
  noiseFloor = 0.012
  inSpeechRun = false
  runMs = 0
  runPeak = 0
  silenceMs = 0
  hadDominantSpeech = false
  stopInProgress = false
}

/* ---------- ASR 事件 ---------- */

function onAsrEvent(e: AsrEventPayload): void {
  if (e.sessionId !== sessionId) return
  if (e.kind === 'final') {
    const t = e.text?.trim()
    if (!t) return
    aiVoiceInput.finals.push(t)
    aiVoiceInput.partial = ''
  } else if (e.kind === 'partial') {
    aiVoiceInput.partial = e.text ?? ''
  } else if (e.kind === 'ended') {
    finalWaitResolve?.()
    finalWaitResolve = null
  } else if (e.kind === 'error') {
    err(e.message ?? '识别出错')
    void finish('error')
  }
}

/* ---------- 音量包：RMS + VAD 计数 ---------- */

function onPcm(chunk: Int16Array): void {
  if (aiVoiceInput.phase === 'stopping') return
  let sumSq = 0
  for (let i = 0; i < chunk.length; i++) {
    const v = chunk[i] / 0x8000
    sumSq += v * v
  }
  const rms = Math.sqrt(sumSq / Math.max(1, chunk.length))
  // UI 音量平滑（10Hz 更新，遮罩里再由 rAF 插值）
  aiVoiceInput.volume = aiVoiceInput.volume * 0.35 + rms * 0.65

  // 迟滞双门槛：speechOn 进入、silenceOff 退出（避免临界抖动把一句话拆碎）
  const speechOn = Math.max(0.03, noiseFloor * 3.5)
  const silenceOff = Math.max(0.018, noiseFloor * 2.2)
  const dominantOn = Math.max(0.06, noiseFloor * 5)
  if (!inSpeechRun && rms >= speechOn) {
    inSpeechRun = true
    runMs = 0
    runPeak = 0
    silenceMs = 0
  }
  if (inSpeechRun) {
    runMs += PACKET_MS
    runPeak = Math.max(runPeak, rms)
    if (rms < silenceOff) {
      inSpeechRun = false
      // 「音量占优」的发言人开过口：这段才算数（背景里的小声不算）
      if (runPeak >= dominantOn && runMs >= MIN_SPEECH_MS) hadDominantSpeech = true
    }
  } else {
    silenceMs += PACKET_MS
    // 无语音时慢速跟踪本底噪声（房间噪声变化自适应）
    if (silenceMs > 400) noiseFloor = Math.max(0.003, noiseFloor * 0.97 + rms * 0.03)
  }

  acc.push(chunk)
  if (acc.length >= 2) {
    const merged = mergeInt16(acc)
    acc = []
    void voiceService.asrAudio(sessionId, int16ToB64(merged)).catch(() => undefined)
  }
}

/* ---------- 周期检查：计时 + 连听自动结束 ---------- */

function tick(): void {
  if (!aiVoiceInput.active || stopInProgress) return
  aiVoiceInput.elapsedMs = Date.now() - startedAt
  if (aiVoiceInput.phase !== 'listening') return
  if (aiVoiceInput.elapsedMs >= MAX_SESSION_MS) {
    void finish('cap')
    return
  }
  if (aiVoiceInput.mode !== 'continuous') return
  if (
    aiVoiceInput.elapsedMs >= MIN_TOTAL_MS &&
    hadDominantSpeech &&
    silenceMs >= SILENCE_MS
  ) {
    void finish('stop-signal')
  }
}

/* ---------- 开始 / 模式切换 / 结束 / 取消 ---------- */

/** 开始语音输入。失败返回 false（原因写入 lastError） */
export async function aiVoiceStart(mode: 'hold' | 'continuous'): Promise<boolean> {
  if (aiVoiceInput.active) return true
  aiVoiceInput.lastError = ''
  if (micOwner() === 'recorder') {
    err('麦克风被录音功能占用中')
    return false
  }
  if (micOwner() === 'voice') {
    err('麦克风被语音会话占用中')
    return false
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
    err('当前环境不支持语音采集')
    return false
  }
  // 未配置凭据时快失败（也不弹麦克风权限），引导文案指向模型页
  const st = await voiceService.configStatus().catch(() => null)
  if (!st?.asrReady) {
    err('未配置语音识别，请到「管理模型」里配置语音服务')
    return false
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    err('无法访问麦克风，请检查权限')
    return false
  }
  if (!claimMic('ai-input')) {
    stopMedia()
    err('麦克风被其他功能占用中')
    return false
  }
  try {
    audioCtx = new AudioContext()
    await audioCtx.audioWorklet.addModule('/voice-worklet.js')
    worklet = new AudioWorkletNode(audioCtx, 'pcm-capture')
    worklet.port.onmessage = (e: MessageEvent) => onPcm(e.data as Int16Array)
    audioCtx.createMediaStreamSource(mediaStream).connect(worklet)
    worklet.connect(audioCtx.destination)
  } catch (e) {
    teardown()
    err(`语音采集不可用：${e instanceof Error ? e.message : String(e)}`)
    return false
  }

  sessionId = `ai${Date.now().toString(36)}${++seq}`
  resetSessionState()
  aiVoiceInput.active = true
  aiVoiceInput.mode = mode
  aiVoiceInput.phase = 'starting'

  unlisten = await voiceService.onAsr(onAsrEvent)
  try {
    await voiceService.asrStart(sessionId)
  } catch (e) {
    teardown()
    aiVoiceInput.active = false
    err(e instanceof Error ? e.message : String(e))
    return false
  }
  startedAt = Date.now()
  aiVoiceInput.phase = 'listening'
  tickTimer = window.setInterval(tick, 100)
  return true
}

/** 按住后很快松开：转入连听（模式切换不影响已在跑的采集与识别） */
export function aiVoiceSetContinuous(): void {
  if (aiVoiceInput.active && aiVoiceInput.phase === 'listening') aiVoiceInput.mode = 'continuous'
}

/** 结束并返回识别文字（finish 与收尾等待全程 phase=stopping，遮罩据此显示收尾态） */
async function finish(reason: AiVoiceStopReason): Promise<string> {
  if (!aiVoiceInput.active || stopInProgress) return ''
  stopInProgress = true
  aiVoiceInput.phase = 'stopping'
  if (tickTimer != null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  const waitFinals = new Promise<void>((resolve) => {
    finalWaitResolve = resolve
    window.setTimeout(() => {
      if (finalWaitResolve) {
        finalWaitResolve = null
        resolve()
      }
    }, FINAL_WAIT_MS)
  })
  try {
    await voiceService.asrFinish(sessionId)
  } catch {
    await voiceService.asrCancel(sessionId).catch(() => undefined)
  }
  await waitFinals
  let text = joinSegments(aiVoiceInput.finals)
  const dangling = aiVoiceInput.partial.trim()
  if (dangling) text = appendVoiceText(text, dangling)
  teardown()
  aiVoiceInput.active = false
  aiVoiceInput.phase = 'starting'
  aiVoiceInput.volume = 0
  handler?.({ text: text.trim(), reason })
  return text.trim()
}

/** 手动停止（用户再点一次） */
export function aiVoiceStop(): Promise<string> {
  return finish('manual')
}

/** 丢弃本次内容（遮罩上的「取消」；收尾中不接受，避免与 finish 抢收尾路径） */
export async function aiVoiceCancel(): Promise<void> {
  if (!aiVoiceInput.active || stopInProgress) return
  stopInProgress = true
  await voiceService.asrCancel(sessionId).catch(() => undefined)
  teardown()
  aiVoiceInput.active = false
  aiVoiceInput.phase = 'starting'
  aiVoiceInput.volume = 0
  handler?.({ text: '', reason: 'cancel' })
}
