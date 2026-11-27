/**
 * 录音系统运行时 · 应用级单例（与组件树生命周期解耦）。
 *
 * MediaRecorder 与计时都在模块级状态上：从编辑抽屉、录音页或悬浮条
 * 发起的是同一次录音——录音中可以切页 / 收起抽屉，录音悬浮条
 * （RecordFloatBar）接管显示与控制。录完的 take 统一进 takes 列表
 * （会话内内存，data URL 很大不落 localStorage）：
 * - 「附加到待办」→ 写入 todos.attachments 持久化；
 * - 未附加的 take 应用关闭即失，录音页有明示。
 *
 * Android 侧依赖 Manifest 声明 RECORD_AUDIO；WebView 的
 * RustWebChromeClient 已把 AUDIO_CAPTURE 映射为运行时权限请求。
 */

import { reactive } from 'vue'

import { claimMic, releaseMic, micOwner } from './micBus'

/** 一条录完的录音（会话内） */
export interface RecTake {
  id: string
  /** data URL（audio/webm 等，可直接喂 <audio> 与附件存储） */
  dataUrl: string
  durationSec: number
  size: number
  createdAt: string
}

export interface RecState {
  status: 'idle' | 'recording' | 'paused'
  /** 录音中经过秒数（暂停时不增加） */
  elapsedSec: number
  takes: RecTake[]
  /** 最近一次启动失败的文案（供 UI 提示），成功启动后清空 */
  lastError: string
}

export const recorder = reactive<RecState>({ status: 'idle', elapsedSec: 0, takes: [], lastError: '' })

let mr: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
let timer: number | null = null
let discard = false
let elapsed = 0
let onTake: ((t: RecTake) => void) | null = null
let seq = 0
let starting = false

export function fmtDur(totalSec: number): string {
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`
}

export function recordingNow(): boolean {
  return recorder.status !== 'idle'
}

/** 开始录音；已在录音中或启动中返回 true（幂等）。失败返回 false。 */
export async function startRecording(opts?: { onTake?: (t: RecTake) => void }): Promise<boolean> {
  if (starting || recorder.status === 'recording') return true
  if (recorder.status === 'paused') {
    resumeRecording()
    return true
  }
  if (micOwner() === 'voice') {
    recorder.lastError = '麦克风被语音对话占用中'
    return false
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    recorder.lastError = '当前环境不支持录音'
    return false
  }
  starting = true
  try {
    let acquiredStream: MediaStream
    try {
      acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      recorder.lastError = '无法访问麦克风，请检查权限'
      return false
    }
    if (!claimMic('recorder')) {
      acquiredStream.getTracks().forEach((t) => t.stop())
      recorder.lastError = '麦克风被其他功能占用中'
      return false
    }
    let recorderInstance: MediaRecorder
    try {
      recorderInstance = new MediaRecorder(acquiredStream)
    } catch {
      acquiredStream.getTracks().forEach((t) => t.stop())
      releaseMic('recorder')
      recorder.lastError = '当前环境不支持录音'
      return false
    }
    chunks = []
    discard = false
    elapsed = 0
    onTake = opts?.onTake ?? null
    recorderInstance.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    recorderInstance.onstop = onRecorderStop
    stream = acquiredStream
    mr = recorderInstance
    try {
      recorderInstance.start()
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
      mr = null
      releaseMic('recorder')
      recorder.lastError = '录音启动失败，请重试'
      return false
    }
    recorder.status = 'recording'
    recorder.elapsedSec = 0
    recorder.lastError = ''
    timer = window.setInterval(() => {
      if (recorder.status !== 'recording') return
      elapsed++
      recorder.elapsedSec = elapsed
    }, 1000)
    return true
  } finally {
    starting = false
  }
}

/** 暂停采集并停表；MediaRecorder 会继续持有麦克风，避免其它功能抢走。 */
export function pauseRecording(): void {
  if (recorder.status !== 'recording' || !mr || mr.state !== 'recording') return
  mr.pause()
  recorder.status = 'paused'
}

/** 从暂停处继续采集与计时。 */
export function resumeRecording(): void {
  if (recorder.status !== 'paused' || !mr || mr.state !== 'paused') return
  mr.resume()
  recorder.status = 'recording'
}

/** 停止并产出 take（异步：MediaRecorder onstop 后落列表）；未在录音时为 no-op */
export function stopRecording(): void {
  if (!recordingNow() || !mr) return
  if (mr.state !== 'inactive') mr.stop()
}

/** 取消本次录音：不产出 take */
export function cancelRecording(): void {
  if (!recordingNow() || !mr) return
  discard = true
  if (mr.state !== 'inactive') mr.stop()
}

function onRecorderStop(): void {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  releaseMic('recorder')
  if (timer != null) {
    window.clearInterval(timer)
    timer = null
  }
  const dur = elapsed
  const blob = new Blob(chunks, { type: mr?.mimeType || 'audio/webm' })
  const takeCallback = onTake
  onTake = null
  mr = null
  recorder.status = 'idle'
  recorder.elapsedSec = 0
  if (discard || !blob.size) {
    chunks = []
    return
  }
  const fr = new FileReader()
  fr.onload = () => {
    const take: RecTake = {
      id: `t${Date.now().toString(36)}${++seq}`,
      dataUrl: String(fr.result),
      durationSec: dur,
      size: blob.size,
      createdAt: new Date().toISOString(),
    }
    recorder.takes.unshift(take)
    takeCallback?.(take)
  }
  fr.readAsDataURL(blob)
}
