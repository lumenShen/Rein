import { AudioLines } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 录音模块：录音台 + 「附加到待办」的录音 take（可开关，见「打开或关闭功能」）。
 *
 * 与语音模块是**两条独立的链路**：这里是 `system/recorderRuntime`（MediaRecorder，
 * 录完的 take 附加到待办附件），语音那边是转写纪要。两者共用 `micBus` 做麦克风互斥，
 * 但开关各管各的。
 *
 * 关闭后 `/record` 被守卫拦回主页、命令面板里的「录音」页不再列出、录音悬浮条不渲染、
 * 待办编辑抽屉里的「录音」附件钮收起；已附加到待办的录音作为附件原样保留。
 * 录音同样是用户按下去才开始（无常驻后台引擎），不需要 Rust 侧门闩。
 */
export const recordPlugin = definePlugin({
  id: 'record',
  name: '录音',
  desc: '录音台 · 附加到待办',
  icon: AudioLines,
  accent: '--mod-record',
  toggleable: true,
  defaultEnabled: true,
  routes: ['record'],
})
