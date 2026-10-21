<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

/**
 * 长按结束闸门（暂停态的唯一下场动作）。
 *
 * 跑步中只允许暂停；结束必须在暂停后按住 5 秒。滑动闸门在奔跑中被掌心擦到仍可能
 * 走完全程，长按则要求手指原地停留 —— 松手即取消，误触只会看到进度条退回去。
 *
 * 进度用 RAF 推动 `transform: scaleX()`，全程只动合成层；不做倒计时数字，
 * 五秒的反馈是「填充条走到头」，比每秒跳一个数更不打断呼吸。
 */
const props = withDefaults(
  defineProps<{
    label?: string
    holdMs?: number
    disabled?: boolean
  }>(),
  {
    label: '长按 5 秒结束',
    holdMs: 5000,
    disabled: false,
  },
)

const emit = defineEmits<{ done: [] }>()

const holding = ref(false)
const progress = ref(0)
const completed = ref(false)
/** 剩余秒数（只在按住时更新；text 依赖它才会逐秒重算） */
const leftSec = ref(0)
let raf = 0
let startedAt = 0

const text = computed(() => {
  if (completed.value) return '正在结束…'
  if (holding.value) return `保持按住 · ${leftSec.value}`
  return props.label
})

function beginHold(): void {
  if (props.disabled || completed.value || holding.value) return
  startedAt = performance.now()
  progress.value = 0
  leftSec.value = Math.max(1, Math.ceil(props.holdMs / 1000))
  holding.value = true
  raf = requestAnimationFrame(tick)
}

function tick(): void {
  if (!holding.value) return
  const elapsed = performance.now() - startedAt
  const p = Math.min(1, elapsed / props.holdMs)
  progress.value = p
  const nextLeft = Math.max(1, Math.ceil((props.holdMs - elapsed) / 1000))
  if (nextLeft !== leftSec.value) leftSec.value = nextLeft
  if (p >= 1) {
    holding.value = false
    completed.value = true
    cancelAnimationFrame(raf)
    emit('done')
    return
  }
  raf = requestAnimationFrame(tick)
}

function cancelHold(): void {
  if (!holding.value) return
  holding.value = false
  progress.value = 0
  cancelAnimationFrame(raf)
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 合成指针事件（自动化/测试）没有真实活动指针，忽略 */
  }
  beginHold()
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  if (!e.repeat) beginHold()
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') cancelHold()
}

onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <button
    type="button"
    class="hte"
    :class="{ holding, completed }"
    :disabled="disabled"
    :aria-label="`${label}（按住不放）`"
    @pointerdown="onPointerDown"
    @pointerup="cancelHold"
    @pointercancel="cancelHold"
    @keydown="onKeyDown"
    @keyup="onKeyUp"
    @blur="cancelHold"
    @contextmenu.prevent
  >
    <i class="hte-fill" :style="{ transform: `scaleX(${progress})` }" aria-hidden="true" />
    <span class="hte-text">{{ text }}</span>
  </button>
</template>

<style scoped>
.hte {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 56px;
  overflow: hidden;
  /* 长按闸门与控制行同高同形：主行动一律胶囊 */
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  box-shadow: inset 0 0 0 1.5px var(--danger);
  color: var(--danger-strong);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.3px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.hte:disabled {
  opacity: var(--disabled-opacity);
}

.hte-fill {
  position: absolute;
  inset: 0;
  transform: scaleX(0);
  transform-origin: left center;
  background: var(--danger);
  opacity: 0.22;
  pointer-events: none;
}

.hte-text {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 var(--sp-12);
  white-space: nowrap;
}

.hte.holding {
  color: var(--danger-strong);
}

.hte.completed {
  opacity: 0.75;
}

@media (prefers-reduced-motion: reduce) {
  .hte-fill {
    /* 进度本身就是操作反馈，减弱动效时保留（只是不再跟手到每一帧） */
  }
}
</style>
