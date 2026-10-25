import { Mic } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 语音模块：实时转写 + AI 纪要（可开关，见「打开或关闭功能」）。
 *
 * 与别的模块不同，它**没有自己的路由** —— 语音会话是 `system/voiceRuntime` 驱动的
 * 全屏浮层（`VoiceSessionView`），入口是主页页脚的「录音纪要」工具卡。所以关闭它
 * 靠三处一起收：工具卡（插件层）、语音会话浮层与转写悬浮条（`App.vue` 按开关渲染）、
 * AI 的「语音服务」工具组与提示词段落（`plugin: 'voice'`，两段随组同进同出）。
 *
 * 语音会话是用户按下去才连 ASR 的（没有常驻后台引擎），因此不需要 Rust 侧门闩。
 * 会话正在跑时去关掉模块由 `App.vue` 的 watcher 收尾（走 `finishSpeaking` 结算，不丢转写）。
 */
export const voicePlugin = definePlugin({
  id: 'voice',
  name: '语音',
  desc: '实时转写与 AI 纪要',
  icon: Mic,
  accent: '--mod-record',
  toggleable: true,
  defaultEnabled: true,
  // 语音版式对照页（`?v=3` 直开某一版的设计探索页）也属语音：不认领的话，
  // 关掉语音后它仍能被直链打开 —— 正是「工具卡没了但直链还能进」那种半关。
  routes: ['voice-layouts'],
  tools: [
    {
      id: 'voice.session',
      title: '录音纪要',
      sub: '实时转写 · AI 纪要',
      icon: Mic,
      ic: {
        background: 'var(--mod-record-soft)',
        color: 'var(--mod-record-strong)',
      },
      order: 40,
      action: 'voice-session',
    },
  ],
})
