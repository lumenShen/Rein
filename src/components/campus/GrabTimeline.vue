<script setup lang="ts">
import { computed } from 'vue'

import type { GrabSettings } from '@/types'

/**
 * 抢课循环的 timeline。
 *
 * 存在的理由：「最小间隔」和「满员重试」这两个名字，光看是不知道谁在管什么的 ——
 * 用户调完只看到任务开始跑了，却看不出自己刚把哪一段拉长了。所以这里把循环摊开：
 * 每一段可调的延迟画成一根**按真实比例**伸缩的条，再用引导线把「它叫什么、现在是多少」拉出来。
 *
 * 四条泳道，**各有各的刻度**：提前量、重试、退避的量级差着几十倍，
 * 硬塞进一个刻度里要么把小的压成看不见、要么把大的差异抹平。
 * 每条泳道的满宽代表多少时间写在右上角，单位一律是毫秒 —— 和旋钮上一致。
 *
 * 两条互斥的路径（满员 / 出错）**分开画**：它们不会同时发生，
 * 排成一条会让人以为「满员之后还要再退避一次」。
 *
 * 纯展示：不认识 store，也不认识 IPC。加新的可调参数时，在 `lanes` 里补一段就行。
 */
const props = defineProps<{
  settings: GrabSettings
  /** 正在调的那个参数 —— 对应的段高亮，其余淡下去 */
  active?: keyof GrabSettings | null
}>()

const W = 360
const PAD = 10
const LANE_H = 82
/** 一次尝试里最多画这么多轮轮询，多了图就糊成一团 */
const MAX_POLLS_DRAWN = 3

type Tone = 'accent' | 'warn' | 'ok' | 'muted'

interface Seg {
  /** 对应哪个可调参数；纯节点（如「提交」）没有 key */
  key?: keyof GrabSettings
  text: string
  ms: number
  tone: Tone
}

interface Lane {
  id: string
  title: string
  hint: string
  /** 满宽代表的毫秒数（该泳道自己的刻度） */
  span: number
  segs: Seg[]
  marks: { at: number; label: string }[]
  /** 段的**末端**要落在这个时刻上（「提前量」是倒着量的：它结束于开窗那一刻） */
  endAt?: number
}

/**
 * 参数值：一律毫秒，图上也只说毫秒。
 *
 * 参数名自己就带 `Ms`（`leadMs` / `pollIntervalMs` / `minIntervalMs`），
 * 图上写成「2 秒」而下面的旋钮写着「2000 ms」，是在同一屏里给同一件事两种说法 ——
 * 对照着调参数的人会被迫自己做换算。原先东一处 `fmt()`（秒）西一处 `fmtMs()`（ms），
 * 同一张图里混着三种写法；现在只剩这一份，要给人读的秒/分去改旋钮上的单位。
 */
function fmtMs(ms: number): string {
  return `${Math.round(ms)} ms`
}

/**
 * 参数的中文名 —— 与抽屉里旋钮上的标签同一份。
 *
 * 引导线标签原先把字段名原样印在图上（`leadMs` / `minIntervalMs`…）：用户没法把
 * 一整行 camelCase 缩写和刚调过的旋钮对上号。字段名只留在代码里，界面上说人话。
 * 「退避间隔 / 退避上限」两个参数不进旋钮（见 GrabSettingsSheet 的说明），
 * 名字沿用那边注释里的同一套说法。
 */
const KEY_LABEL: Partial<Record<keyof GrabSettings, string>> = {
  minIntervalMs: '两次提交的最小间隔',
  leadMs: '开窗前提前出手',
  pollIntervalMs: '查结果间隔',
  fullRetryMs: '满员后重试间隔',
  backoffMs: '退避间隔',
  maxBackoffMs: '退避上限',
}

function segLabel(seg: Seg): string {
  return (seg.key && KEY_LABEL[seg.key]) || ''
}

const s = computed(() => props.settings)

/** 刻度取 1/2/5/10 × 10ⁿ 这类自然档：图是给人扫的，不是给尺子量的 */
function niceSpan(raw: number): number {
  const v = Math.max(raw, 1)
  const pow = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 5, 10]) if (v <= pow * m) return pow * m
  return pow * 10
}

const lanes = computed<Lane[]>(() => {
  const v = s.value

  // ① 开窗前：请求要在开窗**之前**发出去，让它在路上走完，正好落在开窗那一瞬
  const lead = Math.max(v.leadMs, 0)
  const spanA = niceSpan(Math.max(lead * 1.4, 400))
  const windowAt = spanA * 0.78

  // ② 一次尝试：提交 → 按 poll_interval_ms 反复问「选上了吗」
  const polls = Math.max(1, Math.min(MAX_POLLS_DRAWN, v.maxPolls))
  const spanB = niceSpan(v.pollIntervalMs * (polls + 0.5))

  // ③ 满员：匀速守着（名额释放是稀疏事件，快没意义 —— 所以它是一条**平的**节奏）
  const spanC = niceSpan(v.fullRetryMs * 2.6)

  // ④ 出错：按连败次数指数增长，涨到 max_backoff_ms 封顶
  const b1 = v.backoffMs
  const b2 = Math.min(v.backoffMs * 2, v.maxBackoffMs)
  const b3 = v.maxBackoffMs
  const spanD = niceSpan(b1 + b2 + b3)

  // ⑤ 全局闸门：上面每一段**等待**都还要排在这道闸门后面。
  //    它单独占一条泳道，是因为它才是「多久打一次教务」的总开关 ——
  //    如果只把它写在脚注里，用户调完它、图上却没有任何一段亮起来（真踩过这个坑）。
  const spanE = niceSpan(Math.max(v.minIntervalMs * 1.6, 40))

  return [
    {
      id: 'window',
      title: '开窗前',
      hint: '请求在路上要走一会，所以要提前出发',
      span: spanA,
      endAt: windowAt,
      marks: [{ at: windowAt, label: '教务开窗' }],
      segs: [{ key: 'leadMs', text: '提前出手', ms: lead, tone: 'accent' }],
    },
    {
      id: 'attempt',
      title: '一次尝试',
      hint: '提交之后反复问「选上了吗」',
      span: spanB,
      marks: [],
      segs: [
        { text: '提交', ms: 0, tone: 'muted' },
        ...Array.from({ length: polls }, () => ({
          key: 'pollIntervalMs' as const,
          text: '查',
          ms: v.pollIntervalMs,
          tone: 'ok' as Tone,
        })),
      ],
    },
    {
      id: 'full',
      title: '满员时',
      hint: '名额释放是稀疏事件，匀速慢慢守',
      span: spanC,
      marks: [],
      segs: [
        { key: 'fullRetryMs', text: '重试', ms: v.fullRetryMs, tone: 'warn' },
        { key: 'fullRetryMs', text: '重试', ms: v.fullRetryMs, tone: 'warn' },
      ],
    },
    {
      id: 'error',
      title: '出错时',
      // 提示行只留形状（连败多久之后多等一档）；封顶值由下面的刻度标签承载，
      // 同一泳道里同一件事不说两遍
      hint: `连败才退避：${fmtMs(b1)} → ${fmtMs(b2)}`,
      span: spanD,
      marks: [{ at: b1 + b2 + b3, label: `封顶 ${fmtMs(v.maxBackoffMs)}` }],
      segs: [
        { key: 'backoffMs', text: '第 1 次', ms: b1, tone: 'accent' },
        { key: 'backoffMs', text: '第 2 次', ms: b2, tone: 'accent' },
        { key: 'maxBackoffMs', text: '封顶', ms: b3, tone: 'muted' },
      ],
    },
    {
      id: 'gate',
      title: '全局闸门',
      // 第二半句（「上面每段等待都排在它后面」）由下面的 .foot 承担：
      // 这一行要容得下 10px 的正文，长句会撞上右端的刻度标签
      hint: '任意两次请求之间的最小间隔',
      span: spanE,
      marks: [{ at: v.minIntervalMs, label: `${fmtMs(v.minIntervalMs)}` }],
      segs: [{ key: 'minIntervalMs', text: '最小间隔', ms: v.minIntervalMs, tone: 'accent' }],
    },
  ]
})

interface Placed {
  seg: Seg
  x: number
  w: number
  cx: number
  /** 引导线标签的左边界 */
  lx: number
}

/**
 * 把一段泳道排成具体的几何。
 *
 * `endAt` 是给「提前量」用的：它量的不是「从某点往后多久」，而是「比开窗早多久」，
 * 所以整条要从开窗线**往回**推，否则图上会画成「先提前、再等一会才开窗」—— 那是错的。
 */
function layout(lane: Lane): Placed[] {
  const usable = W - PAD * 2
  const widths = lane.segs.map((seg) =>
    seg.ms === 0 ? 16 : Math.max(5, (seg.ms / lane.span) * usable),
  )
  const total = widths.reduce((a, b) => a + b, 0)
  const anchor = lane.endAt != null ? markX(lane, lane.endAt) : PAD
  let cursor = lane.endAt != null ? Math.max(PAD, anchor - total) : PAD

  const out = lane.segs.map((seg, i) => {
    const w = widths[i]!
    const x = cursor
    cursor += w
    return { seg, x, w, cx: x + w / 2, lx: 0 }
  })

  // 标签从左到右铺，挤在一起就往后推，避免叠字
  const LABEL_W = 96
  let last = -Infinity
  for (const b of out) {
    let x = b.cx - LABEL_W / 2
    if (x < last + 4) x = last + 4
    b.lx = Math.max(0, Math.min(x, W - LABEL_W))
    last = b.lx + LABEL_W
  }
  return out
}

function markX(lane: Lane, at: number): number {
  return PAD + (Math.min(at, lane.span) / lane.span) * (W - PAD * 2)
}

/** 同一条泳道里的段共用一个参数时，引导线只画第一条，免得同名的线叠在一起 */
function isFirstOfKey(list: Placed[], i: number): boolean {
  const k = list[i]!.seg.key
  return k != null && list.findIndex((b) => b.seg.key === k) === i
}

/** 几何只算一次：模板里每根条都要用到它，边渲染边算会白算好几遍 */
const board = computed(() => lanes.value.map((lane) => ({ lane, placed: layout(lane) })))

const perSec = computed(() => 1000 / Math.max(s.value.minIntervalMs, 1))
const rateTone = computed(() => (perSec.value >= 20 ? 'bad' : perSec.value >= 5 ? 'warn' : 'ok'))
const rateText = computed(() =>
  perSec.value < 10 ? perSec.value.toFixed(1) : String(Math.round(perSec.value)),
)
/**
 * 速率档位的**文字**。
 *
 * 原先这里只有颜色（绿/橙/红），而这是整个抽屉里唯一在说「你现在的节奏有多冒险」的地方 ——
 * 色觉障碍、或者只是没记住颜色含义的人，看到的就只是一个数字。
 */
const rateWord = computed(() =>
  rateTone.value === 'bad' ? '过密' : rateTone.value === 'warn' ? '偏快' : '稳妥',
)
</script>

<template>
  <div class="wrap">
    <header class="top">
      <b>抢课循环</b>
      <span class="rate" :class="rateTone">≈ {{ rateText }} 次/秒 · {{ rateWord }}</span>
    </header>
    <p class="sub">
      每一段的长短都按<b>真实比例</b>画。调下面的数字，这里会跟着变 —— 调整中的那一段会被点亮。
    </p>

    <svg
      :viewBox="`0 0 ${W} ${lanes.length * LANE_H + 4}`"
      class="tl"
      role="img"
      aria-label="抢课循环时间轴：开窗前、一次尝试、满员时、出错时四段延迟"
    >
      <g v-for="({ lane, placed }, li) in board" :key="lane.id" :transform="`translate(0 ${li * LANE_H})`">
        <text class="lane-title" :x="PAD" y="11">{{ lane.title }}</text>
        <text class="lane-hint" :x="PAD" y="23">{{ lane.hint }}</text>
        <text class="lane-scale num" :x="W - PAD" y="11" text-anchor="end">
          满宽 = {{ fmtMs(lane.span) }}
        </text>

        <line class="base" :x1="PAD" :y1="34" :x2="W - PAD" :y2="34" />

        <g v-for="m in lane.marks" :key="m.label">
          <line class="mark" :x1="markX(lane, m.at)" :y1="26" :x2="markX(lane, m.at)" :y2="64" />
          <text class="mark-label" :x="markX(lane, m.at) + 3" y="27">{{ m.label }}</text>
        </g>

        <g
          v-for="(b, bi) in placed"
          :key="`${lane.id}-${bi}`"
          :class="{ dim: !!active && !!b.seg.key && b.seg.key !== active }"
        >
          <rect
            class="seg"
            :class="[b.seg.tone, { hot: !!b.seg.key && b.seg.key === active }]"
            :x="b.x"
            :y="26"
            :width="b.w"
            height="16"
            rx="4"
          />
          <text v-if="b.seg.text && b.w > 30" class="seg-text" :x="b.cx" y="37" text-anchor="middle">
            {{ b.seg.text }}
          </text>

          <template v-if="b.seg.key && isFirstOfKey(placed, bi)">
            <circle class="dot" :cx="b.cx" cy="42" r="2" />
            <line class="leader" :x1="b.cx" :y1="42" :x2="b.cx" :y2="56" />
            <line class="leader" :x1="b.cx" :y1="56" :x2="b.lx + 5" :y2="56" />
            <text class="seg-label num" :class="{ hot: b.seg.key === active }" :x="b.lx" y="70">
              {{ segLabel(b.seg) }} = {{ fmtMs(b.seg.ms) }}
            </text>
          </template>
        </g>
      </g>
    </svg>

    <p class="foot">
      上面每段等待都要和<b>全局闸门</b>取较大者：闸门是
      {{ fmtMs(s.minIntervalMs) }}，所以把轮询调得比它还小是没用的 —— 实际间隔仍是
      {{ fmtMs(Math.max(s.minIntervalMs, s.pollIntervalMs)) }}。
    </p>
  </div>
</template>

<style scoped>
.wrap {
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  margin-bottom: var(--sp-10);
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-8);
}

.top b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.rate {
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  font-variant-numeric: tabular-nums;
}

.rate.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.rate.warn {
  color: var(--warn-strong);
  background: var(--warn-soft);
}

.rate.bad {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.sub {
  font-size: var(--fs-micro);
  line-height: var(--lh-caption);
  margin: var(--sp-4) 0 var(--sp-4);
  color: var(--text-2);
}

.tl {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

/* SVG 里的文字用 class 上色：`fill="var(--x)"` 这种写法不会被解析。
   字号一律走阶梯：图内最小 10（--fs-micro），8px 在手机上是一层灰雾 ——
   刻度是**数字**，读不出来这张图就白画了。 */
.lane-title {
  fill: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

/* 图里的三种小字（提示 / 刻度 / 引导线标签）都在 10px —— 这是字号下限，
   层次交给字重与颜色（标题 12 / 700），不再靠「再小一号」分档 */
.lane-hint {
  fill: var(--text-2);
  font-size: var(--fs-micro);
}

.lane-scale {
  fill: var(--text-2);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}

.base {
  stroke: var(--line);
  stroke-width: 1;
}

.mark {
  stroke: var(--line-strong);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.mark-label {
  fill: var(--text-2);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}

.seg {
  stroke-width: 0;
  transition: fill-opacity var(--dur-fast) var(--ease-standard);
}

.seg.accent {
  fill: var(--accent);
  fill-opacity: 0.7;
}

.seg.ok {
  fill: var(--ok);
  fill-opacity: 0.55;
}

.seg.warn {
  fill: var(--warn);
  fill-opacity: 0.6;
}

.seg.muted {
  fill: var(--text-3);
  fill-opacity: 0.5;
}

/* 正在调的那一段：描一圈让它跳出来 */
.seg.hot {
  stroke: var(--text-1);
  stroke-width: 1.5;
  fill-opacity: 1;
}

.seg-text {
  fill: var(--on-accent);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
}

.leader {
  stroke: var(--line-strong);
  stroke-width: 0.8;
}

.dot {
  fill: var(--line-strong);
}

.seg-label {
  fill: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}

.seg-label.hot {
  fill: var(--text-1);
  font-weight: var(--fw-bold);
}

/* 没在调的那几段淡下去：一眼看出这次动的是谁 */
.dim {
  opacity: 0.3;
}

.foot {
  font-size: var(--fs-micro);
  line-height: var(--lh-body);
  margin-top: var(--sp-4);
  color: var(--text-2);
}

.foot b {
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .seg {
    transition: none;
  }
}
</style>
