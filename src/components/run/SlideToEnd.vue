<script setup lang="ts">
import { ref, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

/**
 * 滑动结束闸门（危险动作的防误触形状）。
 *
 * 为什么不用一颗红按钮：结束跑步会冻结时长、把这次记录推进结算流程，而它偏偏
 * 落在拇指最顺手的位置 —— 一颗 44px 的红按钮在奔跑中被擦到的概率不是零。
 * 滑动把「意图」摊成一段行程（与 iOS slide-to-unlock 同一条思路）：手指必须真的
 * 走完，没走完就弹回，擦到只会看到把手晃一下。
 *
 * 阈值取**行程的 60%**：轨道 138、把手 56 → 可滑行程 82，0.6×82 = 49.2px；
 * 与「把手滑过轨道 60%（82.8px）」几乎重合 —— 两种读法下判据一致，不必挑一种。
 *
 * 几何三个值同时成立：轨道 138×56、把手 56×56（触控目标 ≥44 之上再留余量）、
 * 描边走**内阴影**。不用 border 是因为它会吃掉内容盒 3px，把手就凑不满 56；
 * 内阴影画的 ring 观感相同而几何不缩水。
 *
 * `hold`：提交后把手停在末端不回弹（用户还要在弹层里确认），弹层关掉
 * （hold 落回 false）才收回起点 —— 否则「滑过头」会读成一次闪回。
 */
const props = withDefaults(defineProps<{ label?: string; hold?: boolean }>(), {
  label: '滑动结束',
  hold: false,
})
const emit = defineEmits<{ done: [] }>()

const trackEl = ref<HTMLElement | null>(null)
const dragging = ref(false)
/** 把手位移（px，已夹进可滑行程） */
const dx = ref(0)
let startX = 0
/** 可滑行程 = 轨道宽 − 把手宽；轨道被窄屏压缩时按实测重算 */
let travel = 82

function onDown(e: PointerEvent): void {
  const el = trackEl.value
  if (!el) return
  try {
    // 捕获到轨道自身：捕获后事件只流向它，手指滑出轨道也不会丢
    el.setPointerCapture(e.pointerId)
  } catch {
    /* 合成指针事件（自动化/测试）无真实活动指针，忽略 */
  }
  travel = Math.max(1, el.clientWidth - 56)
  startX = e.clientX
  dragging.value = true
}

function onMove(e: PointerEvent): void {
  if (!dragging.value) return
  dx.value = Math.min(travel, Math.max(0, e.clientX - startX))
}

function onUp(): void {
  if (!dragging.value) return
  dragging.value = false
  if (dx.value >= travel * 0.6) {
    dx.value = travel // 滑到头：提交态是「把手停在对岸」
    emit('done')
  } else {
    dx.value = 0 // 没走完：弹回起点，不提交
  }
}

/** 键盘路径：按钮是可聚焦的，Enter/空格/右方向键等价于滑到底 */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
    e.preventDefault()
    dx.value = travel
    emit('done')
  }
}

watch(
  () => props.hold,
  (h) => {
    if (!h) dx.value = 0
  },
)
</script>

<template>
  <div
    ref="trackEl"
    class="ste"
    :class="{ dragging }"
    role="group"
    :aria-label="label"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
  >
    <span class="stetext" aria-hidden="true">{{ label }}</span>
    <button
      type="button"
      class="steknob glow-layer"
      :aria-label="`${label}（向右滑动，或按 Enter）`"
      :style="{ transform: `translateX(${dx}px)` }"
      @keydown="onKey"
    >
      <ChevronRight :size="20" :stroke-width="2.6" />
    </button>
  </div>
</template>

<style scoped>
.ste {
  position: relative;
  width: 138px;
  height: 56px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  box-shadow: inset 0 0 0 1.5px var(--danger); /* 描边（理由见文件头：不能让内容盒缩水） */
  overflow: hidden;
  touch-action: none; /* 拖拽自管；也顺带让页面的超范围回弹整场让位 */
  user-select: none;
  -webkit-user-select: none;
}

.stetext {
  position: absolute;
  inset: 0 10px 0 62px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.5px;
  color: var(--danger-strong);
  pointer-events: none; /* 命中区归轨道，文字不参与指针测试 */
}

.steknob {
  position: absolute;
  left: 0;
  top: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 实心把手（--switch-knob = 亮暗同为白，iOS 规格；与 ToggleSwitch 同一支令牌）。
     这里**不用 .glass-surface**：玻璃的落影是往外铺的，而把手正好嵌在与它同高的轨道里 ——
     那条影子要么被轨道裁掉（白搭），要么就得去掉轨道的 overflow、让它溢到旁边的
     「暂停」上（更糟）。iOS 的滑动解锁本来就是实心圆钮，--shadow-thumb 那一档足矣。 */
  background: var(--switch-knob);
  box-shadow: var(--shadow-thumb);
  color: var(--danger);
  transition: transform var(--dur-base) var(--ease-standard);
}

/* 拖拽中不挂过渡：位移只跟手指（与抽屉把手同一取舍） */
.ste.dragging .steknob {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .steknob {
    transition: none;
  }
}
</style>
