<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * 全屏覆盖层：训练开始提示。
 * - countFrom > 0：3·2·1 →「GO!」倒数（计时动作开始前）
 * - countFrom = 0：直接闪现 label（如「开始第 3 组」）
 * 结束后 emit('done') 并自动隐藏。
 * immediate：沉浸页可能在 overlay 已 show 的状态下才挂载（悬浮运动条
 * 完成组后 store 侧触发了 flash），挂载即接管倒计时而不是卡在静态层。
 *
 * ---------- 播报（无障碍）----------
 * 整层是 `role="status"` + `aria-live="polite"` + `aria-atomic`：3·2·1 与「开始第 N 组」
 * 这类闪现是**离散事件**，正是 live region 的用途 —— 视障用户此前完全听不到节奏推进。
 *
 * 已知局限：本层是 `v-if` 挂载的，live region 与它的内容**同时**进入 DOM，而部分读屏会忽略
 * 「区域出现时就已经带着内容」这种变化。彻底稳妥的做法是常驻一个空 region、由 store 事件
 * 更新它的文本 —— 那要把它挪到页面根部并改驱动方式，属另一件事，本轮不做（现状是
 * 「有些读屏会念、没有一个会漏」，不劣于改动前）。
 *
 * 休息倒数与计时中**不**走这里：它们每 100ms–1s 变一次，逐秒播报会淹没其他信息。
 * 那两处用 `role="timer"`（其隐式 aria-live 就是 off），读屏用户需要时可主动读到当前值。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    countFrom?: number
    label?: string
    sub?: string
  }>(),
  { countFrom: 3, label: '', sub: '' },
)

const emit = defineEmits<{ done: [] }>()

const text = ref('')
const isGo = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
/** done 延迟回调句柄：show 提前关闭时必须撤销，否则会在错误时机触发下游计时 */
let doneTimer: ReturnType<typeof setTimeout> | null = null

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (doneTimer) {
    clearTimeout(doneTimer)
    doneTimer = null
  }
}

function finishAfter(ms: number): void {
  doneTimer = setTimeout(() => {
    doneTimer = null
    emit('done')
  }, ms)
}

watch(
  () => props.show,
  (show) => {
    stopTimer()
    if (!show) return

    if (props.countFrom > 0) {
      let n = props.countFrom
      isGo.value = false
      text.value = String(n)
      timer = setInterval(() => {
        n--
        if (n >= 1) {
          text.value = String(n)
        } else {
          stopTimer()
          isGo.value = true
          text.value = 'GO!'
          finishAfter(800)
        }
      }, 1000)
    } else {
      isGo.value = true
      text.value = props.label || 'GO!'
      finishAfter(1200)
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="ov-fade">
      <div v-if="show" class="overlay col center" role="status" aria-live="polite" aria-atomic="true">
        <p class="sub">{{ sub }}</p>
        <!-- :key 触发重新挂载，让 pop 动画每个数字都播放 -->
        <b :key="text" class="big num" :class="{ go: isGo }">{{ text }}</b>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 105;
  /* 副标题与读数之间 14 → 12（--gap-md）：这组是「标签 + 读数」，不是两个区块 */
  gap: var(--gap-md);
  background: color-mix(in srgb, var(--bg) 94%, transparent);
}

.big {
  /* 全 App 最大的读数走展示级令牌（--fs-display-xl 84px），num 等宽防 8→1 抖位 */
  font-size: var(--fs-display-xl);
  /* 200 不在字重阶梯上：展示级最细的一档是 Light 300 */
  font-weight: var(--fw-light);
  letter-spacing: -3px;
  line-height: 1;
  /* 数字节拍 1000ms：动画长过节拍，下一个数字会顶着上一个的余韵进场，
     340ms 收在节拍内。keyframes 三段式 0→55%→100% 与 ease-out 配套，不动 */
  animation: ov-pop 340ms var(--ease-out);
}

.big.go {
  /* GO! 是读数：数值走中性色（色彩配额，STANDARDS §4）。随字色一起去掉粉色光晕 ——
     光晕是同一支色相爬在文字上的另一种形态；「开始了」由字号、字重与画面本身表达。 */
  color: var(--text-1);
  font-weight: var(--fw-light);
}

.sub {
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

@keyframes ov-pop {
  0% {
    transform: scale(0.4);
    opacity: 0;
  }
  55% {
    transform: scale(1.18);
    opacity: 1;
  }
  100% {
    transform: scale(1);
  }
}

/* 退场快于入场：倒数结束后遮罩该立刻让开画面，不等最后一帧 */
.ov-fade-enter-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.ov-fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-standard);
}
.ov-fade-enter-from,
.ov-fade-leave-to {
  opacity: 0;
}
</style>
