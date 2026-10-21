<script setup lang="ts">
/**
 * ProcessSection —— 推理过程 + 工具调用的合并展示区块（照搬 EffiBuddy 同名组件）
 *
 * 设计目标：让 agent 回复像文档一样简洁——
 * - 推理与工具调用合并为单行摘要标题（"已思考 8 秒 · 使用了 3 个工具"）
 * - 进行中（思考中 / 工具执行中）自动展开；仅在过程彻底结束
 *   （正文已输出 / 流已结束）后自动折叠一次。
 *   连续多轮思考+工具（期间无正文）保持展开，避免每轮结束折叠、
 *   下一轮思考又重新展开的抖动——直到输出一次正文才合并一次。
 * - 展开后：按流式到达顺序穿插展示思考文字与工具执行结果（segments），
 *   工具结果直接嵌在思考文字之间，而非与思考文字隔开单独成块；
 *   点击工具行可弹出完整参数与返回结果
 * - 点击标题行可随时手动展开/折叠
 */
import { ref, computed, watch, nextTick, onUnmounted, useId } from 'vue'
import { Brain, ChevronDown } from 'lucide-vue-next'
import ToolCallGroup from './ToolCallGroup.vue'
import type { ProcessSegment } from '@/types'

const props = withDefaults(
  defineProps<{
    /** 推理过程段（思考文字与工具调用按到达顺序穿插） */
    segments?: ProcessSegment[]
    /** 是否仍在思考中 */
    isThinking?: boolean
    /** 已完成思考段的累计秒数（由数据层持有，跨组件重建存活） */
    thinkingSec?: number
    /** 过程是否已彻底结束（正文已输出 / 流已结束）。
     *  仅在此为 true 且空闲时才自动折叠；连续多轮思考+工具（无正文）
     *  期间保持展开，避免每轮结束折叠、下一轮思考又重新展开的抖动。 */
    final?: boolean
  }>(),
  {
    segments: () => [],
    isThinking: false,
    thinkingSec: 0,
    final: false,
  },
)

// 工具调用记录（从 segments 提取，供忙碌判定与标题统计）
const toolCalls = computed(() =>
  props.segments.filter((s) => s.kind === 'tool').map((s) => s.call),
)

/** 展开区的 id：**每条消息各一个**。
 *  原先写死 "process-body"，而同一会话里用过工具的回复往往不止一条 ——
 *  页面上同时存在两个以上同名 id 时，aria-controls 指到的是文档里的第一个，
 *  后面那些的展开开关与内容就对不上（读屏读错、页内跳转也跳错）。
 *  useId() 由实例自己生成，无需父组件传参，也不用把消息 id 一路透下来。 */
const bodyId = `process-body-${useId()}`

// 是否忙碌：思考中或仍有工具在执行
const busy = computed(
  () => props.isThinking || toolCalls.value.some((c) => c.pending),
)

// 历史消息（加载时已全部完成）默认折叠；进行中默认展开
const collapsed = ref(!busy.value)
const bodyRef = ref<HTMLElement | null>(null)

// 已思考时长（秒）：基准 props.thinkingSec 由数据层按消息 id 持有（跨组件重建存活），
// 思考中叠加本地实时秒数 liveElapsed（仅展示用；权威累计在数据层按时间戳进行）
const thinkStart = ref<number>(0)
const liveElapsed = ref<number>(0)
let tickTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.isThinking,
  (thinking) => {
    if (thinking) {
      thinkStart.value = Date.now()
      liveElapsed.value = 0
      startTicker()
    } else {
      stopTicker()
      thinkStart.value = 0
      liveElapsed.value = 0
    }
  },
  { immediate: true },
)

// 思考中每秒刷新"思考中 X 秒"文案
function startTicker(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    if (props.isThinking && thinkStart.value) {
      liveElapsed.value = Math.max(
        1,
        Math.round((Date.now() - thinkStart.value) / 1000),
      )
    }
  }, 1000)
}

function stopTicker(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

onUnmounted(() => {
  stopTicker()
  // 只清理自动折叠定时器：开合是纯 CSS transition，组件卸载时随之消失，
  // 不存在要继续打断的 JS 动画
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
})

// 进行中 → 展开；全部完成 → 短暂延迟后自动折叠
let collapseTimer: ReturnType<typeof setTimeout> | null = null

watch(
  busy,
  (b, was) => {
    if (collapseTimer) {
      clearTimeout(collapseTimer)
      collapseTimer = null
    }
    if (b && !was) {
      // 进行中 → 立即展开。CSS transition 天然可打断，不需要手动 pause 残留动画
      collapsed.value = false
    } else if (!b && was) {
      // 空闲：仅当过程彻底结束（正文已输出 / 流已结束）才自动折叠。
      // 连续多轮思考+工具（无正文）之间 busy 会短暂回落，此时不折叠，
      // 避免每轮结束收起、下一轮思考又重新展开的反复抖动。
      if (props.final) {
        collapseTimer = setTimeout(() => {
          collapseNow()
        }, 600)
      }
    }
  },
)

// 过程彻底结束（正文输出 / 流结束）且当前空闲：补一次自动折叠。
// 覆盖 busy 未再变化（如工具结果后正文到来，busy 早已为 false）的场景。
watch(
  () => props.final,
  (f, was) => {
    if (f && !was) {
      if (collapseTimer) {
        clearTimeout(collapseTimer)
        collapseTimer = null
      }
      collapseTimer = setTimeout(() => {
        collapseNow()
      }, 600)
    }
  },
)

function toggle(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  if (collapsed.value) expandNow()
  else collapseNow()
}

// 展开：高度过渡改走 CSS grid 轨道（1fr ↔ 0fr），JS 只翻状态并把内容定位到底部
function expandNow(): void {
  collapsed.value = false
  nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 闭合：只翻状态。不再补 maxHeight —— 动画终点是内容自然高度，完成后清除
// 内联样式会当场跳回 .process-scroll 的 320px 上限，CSS 轨道没有这个问题
function collapseNow(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  collapsed.value = true
}

// 内容签名：思考文字 / 工具状态变化时滚动到底部（流式跟随）
const contentSig = computed(() =>
  props.segments
    .map((s) =>
      s.kind === 'reasoning'
        ? s.text
        : `${s.call.toolName}:${s.call.result ?? ''}:${s.call.pending}`,
    )
    .join('\u0000'),
)
watch(contentSig, () => {
  if (collapsed.value) return
  nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

// 标题摘要文案：推理时长 + 工具数量合并
const titleText = computed(() => {
  const parts: string[] = []
  if (props.isThinking) {
    // 累计已思考时长(数据层) + 当前段实时秒数：工具调用后新一轮思考不归零，连续递增
    const total = props.thinkingSec + liveElapsed.value
    parts.push(total > 0 ? `思考中 ${total} 秒` : '思考中')
  } else if (props.segments.some((s) => s.kind === 'reasoning' && s.text)) {
    parts.push(
      props.thinkingSec > 0 ? `已思考 ${props.thinkingSec} 秒` : '推理过程',
    )
  }
  if (toolCalls.value.length) {
    const pending = toolCalls.value.filter((c) => c.pending).length
    parts.push(
      // 分母说总数、分子说剩余：原来「2/3」会被读成「正在执行第 2 个」或「进度 2/3」
      pending > 0
        ? `工具执行中 · 还剩 ${pending} 个`
        : toolCalls.value.length === 1
          ? '使用了工具'
          : `使用了 ${toolCalls.value.length} 个工具`,
    )
  }
  return parts.join(' · ')
})
</script>

<template>
  <div class="process-section" :class="{ collapsed }">
    <!-- 合并标题行：点击切换折叠。用 button 而不是 div —— 折叠开关是纯键盘可达的控件 -->
    <button
      type="button"
      class="process-header"
      :aria-expanded="!collapsed"
      :aria-controls="bodyId"
      @click="toggle"
    >
      <span class="process-icon"><Brain :size="14" /></span>
      <span class="process-title">{{ titleText }}</span>
      <span v-if="busy" class="process-dots">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </span>
      <span class="process-arrow" :class="{ collapsed }">
        <ChevronDown :size="12" />
      </span>
    </button>

    <!-- 展开内容：grid 壳只收轨道，视觉与滚动全在中层。id 与标题行的 aria-controls 同源 -->
    <div :id="bodyId" class="process-body">
      <div ref="bodyRef" class="process-scroll">
        <!-- 超范围平移层：到边拖动时内容位移；包裹层镜像弹性列布局，只承载 transform -->
        <div class="rubber-layer" data-rubber-content>
          <template v-for="(seg, i) in segments" :key="i">
            <div v-if="seg.kind === 'reasoning'" class="process-reasoning">{{ seg.text }}</div>
            <ToolCallGroup v-else :calls="[seg.call]" />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 无卡片外观：以文档流形式融入 assistant 回复；
   左侧缩进与正文形成明确的层级区分 */
/* 思考 / 工具流整块的基色：展开时这些行是要读的（哪一步做了什么），
   落 --text-2；--text-3 只留给「可以略过」的补充。 */
.process-section {
  padding-left: var(--sp-2);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

/* 折叠头是一枚 28 高的行内胶囊（--control-sm），负外边距抵掉内距好与正文左缘对齐。
   它是可点的开合控件，热区再用 ::after 上下各补 8 到 44（视觉高度不变）。 */
.process-header {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  max-width: 100%;
  height: var(--control-sm);
  padding: 0 var(--gap-sm);
  margin-left: calc(-1 * var(--gap-sm));
  border-radius: var(--radius-full);
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  /* 必须带 transform：scoped transition 会整条覆盖 base.css 里 button 的全局过渡，
     少了这项按压反馈（:active 的 scale(0.96)）就变成瞬贴 */
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.process-header::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

@media (hover: hover) {
  .process-header:hover {
    background: var(--surface-2);
  }
}

.process-icon {
  line-height: 1;
  color: var(--text-2);
}

.process-title {
  min-width: 0;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 进行中跳动的点 */
.process-dots {
  display: inline-flex;
  flex: none;
  gap: var(--gap-tight);
}

.process-dots .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-3);
  animation: process-fade 1.2s infinite ease-in-out;
}

.process-dots .dot:nth-child(2) {
  animation-delay: 0.15s;
}

.process-dots .dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes process-fade {
  0%, 80%, 100% {
    opacity: 0.4;
  }
  40% {
    opacity: 1;
  }
}

.process-arrow {
  line-height: 1;
  flex: none;
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 折叠时箭头由下转右（chevron-down 旋转 -90°），带过渡 */
.process-arrow.collapsed {
  transform: rotate(-90deg);
}

/* 折叠壳：grid 轨道从 1fr 收到 0fr。用轨道过渡而不是补 maxHeight ——
   动画终点是内容自然高度，完成后清除内联样式会当场跳回 320px 上限 */
.process-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--dur-base) var(--ease-out);
}

.process-section.collapsed .process-body {
  grid-template-rows: 0fr;
}

/* 低性能档：每帧重排的轨道过渡直接关掉，开合退化为瞬时 */
html[data-perf='low'] .process-body {
  transition: none;
}

/* 滚动层：原 .process-body 的全部视觉都搬到这里 ——
   左侧细线标识层级，缩进与上下 margin 加大，与标题行/正文明确区分；
   整块可滚动（思考 + 工具穿插后统一滚动），overflow-y:auto 供流式跟随 */
/* 轨道项自己不带任何 margin/padding/border：grid 的 0fr 折叠以轨道项的
   **外尺寸**为下限，间距画在它身上会剩一截收不掉（经典 0fr 手势的坑）。
   缩进、层级细线与上下间距全部下沉到滚动内容层 .rubber-layer —— 它在
   滚动容器内、随内容滚，不参与轨道尺寸计算。 */
.process-scroll {
  min-height: 0;
  max-height: 320px;
  overflow-y: auto;
  overflow-x: hidden;
  visibility: visible;
  transition: visibility 0s;
}

/* 折叠到终点才隐藏：内容仍完整参与轨道过渡，只是收起后不再可聚焦、不被读到 */
.process-section.collapsed .process-scroll {
  visibility: hidden;
  transition: visibility 0s var(--dur-base);
}

/* 超范围平移层：镜像 .process-scroll 的弹性列布局（只承载 transform，不改观感）。
   缩进 / 层级细线 / 上下间距也在这里：轨道项 .process-scroll 必须保持「裸壳」
   才能让 0fr 收到 0（见 .process-scroll 注释）。 */
.rubber-layer {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  margin: var(--gap-sm) 0 var(--gap-sm) var(--gap-sm);
  padding: var(--sp-2) 0 var(--sp-2) var(--sp-12);
  border-left: 2px solid var(--line);
  min-width: 0;
}

.process-reasoning {
  padding: var(--sp-2) var(--sp-6) var(--sp-2) 0;
  min-width: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.process-scroll::-webkit-scrollbar {
  width: 6px;
}

.process-scroll::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: var(--radius-s);
}

/* 无障碍：reduce 下禁用位移类动效（箭头旋转、圆点跳动） */
@media (prefers-reduced-motion: reduce) {
  .process-arrow {
    transition: none;
  }
  .process-dots .dot {
    animation: none;
  }
  /* 折叠时 visibility 的延时要跟着归零：reduce 下轨道过渡已是瞬时的，
     留着 delay 会让内容晚一个 --dur-base 才消失 */
  .process-section.collapsed .process-scroll {
    transition-delay: 0s;
  }
}
</style>
