<script setup lang="ts">
/**
 * AI 语音输入遮罩 · 全屏半透明层（颜色渐入 → 聆听 → 渐出 → v-if 回收）。
 * 状态全部读 system/aiVoiceInput 的响应式快照，动作直接调运行时：
 * - 连听中轻点遮罩任意处 = 手动停止（按住说话时手指正按着，点击不响应）；
 * - 「取消」丢弃本次内容；Esc 与轻点同义（仅连听）。
 * 音量球走 rAF 插值（worklet 只有 10Hz 包），transform 直写不走响应式。
 */
import { Mic } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  aiVoiceInput,
  aiVoiceStop,
  aiVoiceCancel,
  appendVoiceText,
} from '@/system/aiVoiceInput'
import { fmtMmSs } from '@/utils/format'

const orbEl = ref<HTMLElement | null>(null)
const glowEl = ref<HTMLElement | null>(null)
const txtEl = ref<HTMLElement | null>(null)

const finalsText = computed(() => aiVoiceInput.finals.reduce((a, s) => appendVoiceText(a, s), ''))

const hint = computed(() => {
  if (aiVoiceInput.phase === 'stopping') return '正在识别最后一句…'
  if (aiVoiceInput.mode === 'hold') return '松开结束，文字进输入框'
  return '停顿后自动结束 · 轻点任意处立即结束'
})

const modeLabel = computed(() => (aiVoiceInput.mode === 'hold' ? '按住说话' : '轻点说话'))

function fmtSec(ms: number): string {
  return fmtMmSs(ms)
}

function onMaskClick(): void {
  if (aiVoiceInput.mode === 'continuous' && aiVoiceInput.phase === 'listening') void aiVoiceStop()
}

/* ---------- 音量球：rAF 插值到 60fps（prefers-reduced-motion 时静止） ---------- */

let raf = 0
let disp = 0
const reducedMotion =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function frame(): void {
  const target = Math.min(1, aiVoiceInput.volume / 0.2)
  disp += (target - disp) * 0.16
  if (disp < 0.003 && target < 0.003) disp = 0
  orbEl.value?.style.setProperty('transform', `scale(${(1 + disp * 0.3).toFixed(3)})`)
  glowEl.value?.style.setProperty('opacity', (0.35 + disp * 0.65).toFixed(3))
  raf = requestAnimationFrame(frame)
}

watch(
  () => aiVoiceInput.active,
  (active) => {
    cancelAnimationFrame(raf)
    if (active && !reducedMotion) {
      disp = 0
      raf = requestAnimationFrame(frame)
    } else {
      orbEl.value?.style.setProperty('transform', '')
      glowEl.value?.style.setProperty('opacity', '')
    }
  },
  { immediate: true },
)

/* 转写追加时把预览滚到底（长内容看得到最新一句） */
watch(
  () => [aiVoiceInput.finals.length, aiVoiceInput.partial] as const,
  () => {
    void nextTick(() => {
      const el = txtEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (aiVoiceInput.active && aiVoiceInput.mode === 'continuous' && aiVoiceInput.phase === 'listening') {
    e.preventDefault()
    void aiVoiceStop()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  cancelAnimationFrame(raf)
})
</script>

<template>
  <Transition name="vmask">
    <div v-if="aiVoiceInput.active" class="vmask" data-testid="ai-voice-mask" @click="onMaskClick">
      <div ref="glowEl" class="vm-glow" aria-hidden="true" />
      <div class="vm-card" role="dialog" aria-label="语音输入">
        <span class="vm-mode" data-testid="ai-voice-mode">{{ modeLabel }}</span>
        <div class="vm-stage" aria-hidden="true">
          <i class="vm-ring" :class="{ still: aiVoiceInput.phase === 'stopping' }" />
          <div ref="orbEl" class="vm-orb" :class="{ still: aiVoiceInput.phase === 'stopping' }">
            <Mic :size="30" :stroke-width="2.2" />
          </div>
        </div>
        <p class="vm-sec">{{ fmtSec(aiVoiceInput.elapsedMs) }}</p>
        <div ref="txtEl" class="vm-txt" data-testid="ai-voice-text">
          <template v-if="finalsText || aiVoiceInput.partial">
            <span>{{ finalsText }}</span>
            <span v-if="aiVoiceInput.partial" class="vm-partial">{{ aiVoiceInput.partial }}</span>
          </template>
          <span v-else class="vm-wait">{{ aiVoiceInput.phase === 'starting' ? '正在连接…' : '开始说话…' }}</span>
        </div>
        <p class="vm-hint">{{ hint }}</p>
        <button
          v-if="aiVoiceInput.mode === 'continuous' && aiVoiceInput.phase === 'listening'"
          class="vm-cancel"
          data-testid="ai-voice-cancel"
          @click.stop="aiVoiceCancel()"
        >
          取消
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 遮罩本体：半透明 surface 铺满全屏（z 在 Dock/悬浮条之上、弹层之下） */
.vmask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--surface) 76%, transparent);
  overflow: hidden;
}

/* 音量辉光：跟着音量呼吸的 accent 光斑（透明度由 rAF 直写） */
.vm-glow {
  position: absolute;
  width: 460px;
  height: 460px;
  border-radius: 50%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 24%, transparent), transparent 72%);
  opacity: 0.35;
  pointer-events: none;
}

/* 顶层浮层：圆角走 32 那一档（比卡片 16 / 按钮 20 都高一级），内距上下 18 / 底部 16 */
.vm-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-sm);
  width: min(78vw, 340px);
  padding: var(--sp-18) var(--sp-18) var(--pad-card);
  border-radius: var(--radius-xl);
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  box-shadow: var(--shadow-float);
  text-align: center;
}

.vm-mode {
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

/* 音量球舞台：transform 缩放不占布局，舞台定住不挤文本 */
.vm-stage {
  position: relative;
  width: 88px;
  height: 88px;
  margin-top: var(--gap-sm);
  display: flex;
  align-items: center;
  justify-content: center;
}

.vm-orb {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent);
  will-change: transform;
}

.vm-orb.still {
  opacity: 0.55;
  transition: opacity var(--dur-base) var(--ease-standard);
}

/* 静默时的呼吸环（连续动画走 keyframes；收尾中停住） */
.vm-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  animation: vm-ring-pulse 1.8s var(--ease-standard) infinite;
}

.vm-ring.still {
  animation: none;
  opacity: 0.3;
}

@keyframes vm-ring-pulse {
  0% { transform: scale(1); opacity: 0.55; }
  70% { transform: scale(1.28); opacity: 0; }
  100% { transform: scale(1.28); opacity: 0; }
}

.vm-sec {
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
}

/* 转写预览：最少三行高避免逐句跳动，长了内部滚动 */
.vm-txt {
  min-height: 3em;
  max-height: 7.5em;
  overflow-y: auto;
  scrollbar-width: none;
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}

.vm-txt::-webkit-scrollbar {
  display: none;
}

.vm-partial {
  color: var(--text-2);
}

.vm-wait {
  color: var(--text-2);
}

.vm-hint {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.vm-cancel {
  margin-top: var(--gap-tight);
  min-height: var(--control-md);
  padding: 0 var(--sp-20);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
  color: var(--text-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.vm-cancel:active {
  background: color-mix(in srgb, var(--text-1) 16%, transparent);
  transform: scale(0.96);
}

/* 渐入 / 渐出：根层 opacity、卡片 transform，两层一起进退（可打断的 transition） */
.vmask-enter-active {
  transition: opacity 240ms var(--ease-out);
}

.vmask-enter-active .vm-card {
  transition: transform 240ms var(--ease-out);
}

.vmask-leave-active {
  transition: opacity 180ms var(--ease-standard);
}

.vmask-leave-active .vm-card {
  transition: transform 180ms var(--ease-standard);
}

.vmask-enter-from,
.vmask-leave-to {
  opacity: 0;
}

.vmask-enter-from .vm-card {
  transform: translateY(12px) scale(0.96);
}

.vmask-leave-to .vm-card {
  transform: scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .vmask-enter-active,
  .vmask-leave-active,
  .vmask-enter-active .vm-card,
  .vmask-leave-active .vm-card {
    transition: opacity var(--dur-fast) var(--ease-standard);
  }

  .vmask-enter-from .vm-card,
  .vmask-leave-to .vm-card {
    transform: none;
  }
}
</style>
