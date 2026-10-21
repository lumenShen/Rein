<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useContentSwap } from '@/composables/useContentSwap'
import { motionOn } from '@/system/motion'
import { PREPARE_SEC } from '@/system/motionSpring'

/**
 * 灵动气泡 · 底部控栏上方的状态条。
 *
 * 它取代了从前那一排组格（.dtile）：组格只能在「完成后」告诉你结果，而训练中真正
 * 需要的是**此刻该干什么**。三种阶段用色光区分，颜色只在底色与光晕上，文字一律
 * --text-1/2（绿字压绿底到不了 4.5:1，STANDARDS §4）：
 *
 *   prepare  蓝，每秒闪一次      摆好姿势，还有 n 秒开始
 *   act      绿，每完成一个闪一次  第 n 个 / 共 m 个
 *   due      橙，呼吸灯          该组预计时间已到，提示结束去休息
 *   rest     中性，无闪          剩余休息秒数
 *
 * 尺寸与内容用**交错动画**切换（不是淡入淡出式的整体叠化）：
 *   0.00s 旧内容 blur + 缩小 + 淡出 0.3s
 *   0.30s spring 把气泡宽高送到新内容的尺寸（约 0.4s）
 *   0.50s 新内容由模糊缩小淡入 0.2s
 * 旧内容在新内容进场前就彻底消失，两者不在同一时刻都清晰 —— 否则会读成两行字叠在一起。
 * 这一段时序不是本组件的私货：`composables/useContentSwap` 把它收成通用方法
 * （容器尺寸 spring + 内容交错），别的地方要同样的手感直接用那一份，别再抄数字。
 *
 * 阶段计时全部基于墙钟（performance.now），不做逐帧累加：切到后台再回来时，
 * 秒数 / 次数仍然是准的（与 store 里休息倒计时同一个纪律）。
 */

type Stage = 'prepare' | 'act' | 'due' | 'rest'
type Tone = Stage

interface BubbleContent {
  tone: Tone
  main: string
  sub: string
}

const props = withDefaults(
  defineProps<{
    /** 组标识：变化即重开一轮节拍（动作 id + 组号 + 阶段） */
    token: string
    /** set = 准备→动作→到点；rest = 休息倒计时 */
    kind: 'set' | 'rest'
    /** 当前组序号（1-based）与总组数 */
    setNo: number
    totalSets: number
    /** 本组预计动作秒数 */
    setSec: number
    /** 本组次数；null / 0 = 不做「第 n 个」切分，按秒显示 */
    reps: number | null
    /** 休息剩余秒（kind === 'rest' 时由父级驱动） */
    restLeft?: number
    /** 准备时长（秒） */
    prepSec?: number
    /** 会话是否在进行（收起 / 总结时停拍） */
    active?: boolean
    /** 热身组：文案前缀不同（不计入正式组数，所以不写「第 n/m 组」而写「热身 n/m」） */
    warmup?: boolean
  }>(),
  { restLeft: 0, prepSec: PREPARE_SEC, active: true, warmup: false },
)

const emit = defineEmits<{ tap: [] }>()

const bubbleEl = ref<HTMLElement | null>(null)
const ghostEl = ref<HTMLElement | null>(null)
const liveEl = ref<HTMLElement | null>(null)
const measureEl = ref<HTMLElement | null>(null)
const glowEl = ref<HTMLElement | null>(null)

const stage = ref<Stage>('prepare')
const tone = ref<Tone>('prepare')
const prepLeft = ref(PREPARE_SEC)
const repIdx = ref(1)
const actLeft = ref(0)

/* ---------- 文案 ---------- */

const content = computed<BubbleContent>(() => {
  if (props.kind === 'rest') {
    return { tone: 'rest', main: `休息 ${Math.max(0, props.restLeft)} 秒`, sub: '点此跳过' }
  }
  const total = props.warmup ? `热身 ${props.setNo}/${props.totalSets}` : `第 ${props.setNo}/${props.totalSets} 组`
  if (stage.value === 'prepare') {
    return { tone: 'prepare', main: '准备姿势', sub: `${prepLeft.value} 秒后开始` }
  }
  if (stage.value === 'act') {
    const reps = props.reps ?? 0
    if (reps > 0) {
      return { tone: 'act', main: `第 ${repIdx.value} 个`, sub: `共 ${reps} 个` }
    }
    return { tone: 'act', main: `坚持 ${actLeft.value} 秒`, sub: `共 ${props.setSec} 秒` }
  }
  return { tone: 'due', main: total, sub: '请结束休息' }
})

/** 当前真正显示的内容：交换动画的最后一步才替换，所以与 content 有意不同步 */
const shown = ref<BubbleContent>({ tone: 'prepare', main: '准备姿势', sub: `${PREPARE_SEC} 秒后开始` })
const ghost = ref<BubbleContent | null>(null)

/* ---------- 节拍 ---------- */

let timer = 0
let startMs = 0

function stopTicker(): void {
  if (timer) {
    window.clearInterval(timer)
    timer = 0
  }
}

function arm(): void {
  stopTicker()
  mover.invalidate() // 作废还在飞行中的交换回调
  if (props.kind === 'rest') {
    stage.value = 'rest'
    void swap(content.value)
    return
  }
  prepLeft.value = props.prepSec
  repIdx.value = 1
  actLeft.value = props.setSec
  stage.value = 'prepare'
  startMs = performance.now()
  void swap(content.value)
  pulse('prepare')
  timer = window.setInterval(tick, 100)
}

function tick(): void {
  const el = (performance.now() - startMs) / 1000
  const prepMs = props.prepSec
  if (el < prepMs) {
    const left = Math.max(1, Math.ceil(prepMs - el))
    if (left !== prepLeft.value) prepLeft.value = left
    return
  }
  const actElapsed = el - prepMs
  const setSec = Math.max(1, props.setSec)
  if (actElapsed < setSec) {
    if (stage.value !== 'act') {
      stage.value = 'act'
      actLeft.value = Math.ceil(setSec - actElapsed)
      void swap(content.value)
      return
    }
    const reps = props.reps ?? 0
    if (reps > 0) {
      const nextRep = Math.min(reps, Math.floor((actElapsed / setSec) * reps) + 1)
      if (nextRep !== repIdx.value) {
        repIdx.value = nextRep
        pulse('act')
      }
    } else {
      const left = Math.max(1, Math.ceil(setSec - actElapsed))
      if (left !== actLeft.value) actLeft.value = left
    }
    return
  }
  if (stage.value !== 'due') {
    stage.value = 'due'
    stopTicker()
    void swap(content.value)
  }
}

/* ---------- 尺寸测量与内容交换（通用方法，见 composables/useContentSwap） ---------- */

/** 气泡高度是定死的 52（量宽层只有一行文字高），宽度完全跟着内容走 —— 不设下限 */
const mover = useContentSwap(
  { container: bubbleEl, ghost: ghostEl, live: liveEl, measure: measureEl },
  { minHeight: 52 },
)

/** 换阶段：旧内容模糊淡出 → spring 宽高 → 新内容淡入（底色跟着 spring 一起换） */
async function swap(next: BubbleContent): Promise<void> {
  await mover.swap({
    stash: () => {
      ghost.value = shown.value
    },
    tint: () => {
      tone.value = next.tone
    },
    commit: () => {
      shown.value = next
      ghost.value = null
    },
  })
}

/** 同一阶段内的数字变化：只 spring 宽度，内容直接换（不做模糊进出，否则每秒都在闪） */
async function resize(next: BubbleContent): Promise<void> {
  await mover.resize(() => {
    shown.value = next
  })
}

/* ---------- 色晕闪光 ---------- */

let lastPulse = 0

function pulse(kind: 'prepare' | 'act' | 'due'): void {
  const el = glowEl.value
  if (!el || !motionOn.value) return
  const now = performance.now()
  if (kind === 'prepare') {
    // 每秒一次：与秒数同频，早到 40ms 以内不重复触发
    if (now - lastPulse < 900) return
    lastPulse = now
  }
  el.animate([{ opacity: 0 }, { opacity: 0.85, offset: 0.16 }, { opacity: 0 }], {
    duration: kind === 'prepare' ? 820 : 360,
    easing: 'ease-out',
  })
}

/* ---------- 生命周期 ---------- */

watch(
  () => [props.token, props.kind, props.active, props.setSec, props.reps] as const,
  () => arm(),
  { immediate: true },
)

/** 准备姿势：每整秒闪一次蓝 */
watch(prepLeft, () => {
  if (stage.value === 'prepare') pulse('prepare')
})

/** 到点：橙色呼吸灯（2s 一轮，比蓝闪慢，表达「等你去按完成」而不是在催） */
let breathe = 0
watch(stage, (s) => {
  if (breathe) {
    window.clearInterval(breathe)
    breathe = 0
  }
  if (s === 'due') {
    pulse('due')
    breathe = window.setInterval(() => pulse('due'), 2000)
  }
})

/** rest 阶段只跟着父级的秒数走（不参与阶段交换动画） */
watch(
  () => [props.restLeft, props.kind] as const,
  () => {
    if (props.kind !== 'rest') return
    void resize(content.value)
  },
)

/** 数字变化（准备秒数 / 次数 / 坚持秒数）：只调宽度 */
watch([prepLeft, repIdx, actLeft], () => {
  if (props.kind === 'rest') return
  if (stage.value === 'due') return
  void resize(content.value)
})

/** 首帧把尺寸对到真实内容（CSS 里的 width 只是防跳动的近似值） */
onMounted(() => {
  void mover.sync()
})

onBeforeUnmount(() => {
  stopTicker()
  if (breathe) window.clearInterval(breathe)
})
</script>

<template>
  <div class="stagewrap">
    <!-- glass-surface：与四条悬浮条 / 提示条同一份全局材质（半透明底 + 受光描边 +
         玻璃落影，档位与「减弱透明度」的退化都由 base.css 统一接管）。
         本组件的 scoped 样式因此**不写 background / box-shadow**——特指度会把
         玻璃整套顶掉（AI 输入条踩过的同一个坑）。 -->
    <div
      ref="bubbleEl"
      class="bubble glass-surface"
      :class="{ tappable: kind === 'rest' }"
      :data-tone="tone"
      :role="kind === 'rest' ? 'button' : 'status'"
      aria-live="off"
      :tabindex="kind === 'rest' ? 0 : undefined"
      :aria-label="`${shown.main}，${shown.sub}`"
      @click="kind === 'rest' && emit('tap')"
      @keydown.enter="kind === 'rest' && emit('tap')"
    >
      <i ref="glowEl" class="glow" aria-hidden="true" />
      <div v-if="ghost" ref="ghostEl" class="layer ghost" aria-hidden="true">
        <span class="main">{{ ghost.main }}</span>
        <span class="sub num">{{ ghost.sub }}</span>
      </div>
      <div ref="liveEl" class="layer live">
        <span class="main">{{ shown.main }}</span>
        <span class="sub num">{{ shown.sub }}</span>
      </div>
      <!-- 量宽层：渲染的是**将由 content 呈现**的新文案；不可见、不参与布局 -->
      <div ref="measureEl" class="measure" aria-hidden="true">
        <span class="main">{{ content.main }}</span>
        <span class="sub num">{{ content.sub }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stagewrap {
  /* 独占一行、居中：气泡宽度会变，左右不能有东西跟它抢位置 */
  display: flex;
  justify-content: center;
  align-items: center;
  height: 52px;
}

.bubble {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 52px;
  padding: 0 var(--sp-18);
  border-radius: var(--radius-full);
  overflow: hidden;
  /* 宽度 / 高度由 JS spring 驱动，初值给一个与首帧内容相近的宽度避免首帧跳动 */
  width: 160px;
  will-change: width, height;
}

/* 三态底色：只换 --glass-fill 这一个变量，玻璃的受光描边 / 落影 / 光学内层
   全部由 .glass-surface 那一份统一供给（与 HistoryDrawer / ToastHost 的
   「就地顶 fill」同一手法）。色相只做分区暗示，文字仍压在 --text-1。
   底色浓度：13%/18% 在浅色下都读成白卡片（实测），28–30% 才一眼看出蓝 / 绿 / 橙；
   黑字压 30% 橙底仍有 15:1。混色基底是 --surface（卡面）—— 曾经写成
   var(--surface-1)，而令牌表里根本没有这一档：整条 color-mix 失效被当无效丢弃，
   三态底色实际从来没画出来过（气泡一直是白玻璃）。 */
.bubble[data-tone='prepare'] {
  --glass-fill: color-mix(in srgb, var(--accent) 28%, var(--surface));
}

.bubble[data-tone='act'] {
  --glass-fill: color-mix(in srgb, var(--c-exercise) 30%, var(--surface));
}

.bubble[data-tone='due'] {
  /* 用 --warn（实底档橙）而不是 --warn-strong（文字档深棕）：后者混出来是米黄，
     在浅色屏上读成「脏白」，看不出它在提醒你结束 */
  --glass-fill: color-mix(in srgb, var(--warn) 28%, var(--surface));
}

/* rest 态不再单独配材质：默认玻璃 + 玻璃落影已经是「一条可点的浮起控件」
   （与四条悬浮条同一读法），副文案「点此跳过」负责把可点性说完整 */

.bubble.tappable {
  cursor: pointer;
}

/* 光晕：色闪光只在这一层，元素不透明度由 Web Animations 驱动 */
.glow {
  position: absolute;
  inset: -40%;
  opacity: 0;
  pointer-events: none;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 55%, transparent), transparent 70%);
}

.bubble[data-tone='act'] .glow {
  background: radial-gradient(closest-side, color-mix(in srgb, var(--c-exercise) 50%, transparent), transparent 70%);
}

.bubble[data-tone='due'] .glow {
  background: radial-gradient(closest-side, color-mix(in srgb, var(--warn) 55%, transparent), transparent 70%);
}

.bubble[data-tone='rest'] .glow {
  display: none;
}

.layer {
  position: absolute;
  inset: 0;
  display: flex;
  /* ⚠️ 必须是 center，不能是 baseline：定高单行 flex 里 baseline 对齐把整行
     钉在 cross-start（顶部）—— 实测上边距 1px / 下边距 30px，文字全程贴顶。
     main 与 sub 差一档字号，center 后 sub 相对基线对齐只低 1.5px，无感。 */
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  white-space: nowrap;
  will-change: opacity, filter, transform;
}

.ghost {
  pointer-events: none;
}

/* 量宽层**不能**用 .layer 的 inset:0 —— 那样量到的就是气泡自己的宽度，
   每一轮交换都会把它撑大一圈（实测 160 → 378）。它必须按内容自然撑开。 */
.measure {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  white-space: nowrap;
  width: max-content;
  visibility: hidden;
  pointer-events: none;
}

.main {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  letter-spacing: 0.2px;
  color: var(--text-1);
}

.sub {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
</style>
