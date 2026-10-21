<script setup lang="ts">
import { computed } from 'vue'

import { fmtDateCn } from '@/utils/date'
import { fmtKg } from '@/utils/format'
import { TREND_WINDOW_DAYS, type StrengthTrend } from '@/utils/strengthTrend'

/**
 * 动作历史卡：**历史最高** + **近 14 天趋势**。
 *
 * 两张卡回答两个不同的问题，必须分开：
 *   历史最高 —— 我的纪录在哪（不限窗口，半年前也算）
 *   14 天趋势 —— 我现在在往哪走（只看两周，样本数与跨度都要摊开说）
 * 混成一个数会同时失真：一次很久以前的高光会永远把趋势线拉成下跌。
 *
 * 趋势线只画窗口内的点，末端那段虚线是**趋势线外推到今天**的值（不是真实记录），
 * 用虚线而不是实线就是为了不冒充数据。置信度与样本数写在脚注里 —— 两个点连出来
 * 的斜线不该被当成结论。
 */
const props = defineProps<{
  /** 历史最高单组重量（kg）与该组次数、日期 */
  bestWeight: number | null
  bestReps: number | null
  bestDate: string | null
  /** 历史最高估算极限 */
  bestE1rm: number | null
  trend: StrengthTrend | null
}>()

const hasBest = computed(() => props.bestWeight != null && props.bestWeight > 0)

/** 置信度措辞：只影响「这话有多硬」，不参与任何数字 */
const confidenceNote = computed(() => {
  const t = props.trend
  if (!t) return ''
  if (t.samples < 2) return '只有一次记录，还看不出走向'
  if (t.confidence >= 0.7) return '趋势明确'
  if (t.confidence >= 0.5) return '趋势初步'
  return '样本还少，仅供参考'
})

const slopeText = computed(() => {
  const t = props.trend
  if (!t || t.samples < 2) return ''
  if (t.direction === 'flat') return '基本走平'
  const v = Math.abs(t.slopePerWeek)
  return `每周 ${t.direction === 'up' ? '+' : '−'}${v.toFixed(1)} kg`
})

const dirTone = computed(() => props.trend?.direction ?? 'flat')

/* ---------- 迷你趋势线 ---------- */

const W = 320
const H = 62
const PAD = { l: 4, r: 6, t: 10, b: 12 }

const chart = computed(() => {
  const t = props.trend
  if (!t || !t.points.length) return null
  const values = t.points.map((p) => p.e1rm)
  if (t.projected != null) values.push(t.projected)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = Math.max(1, hi - lo)
  const y0 = lo - span * 0.15
  const y1 = hi + span * 0.15
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b
  const yOf = (v: number) => PAD.t + innerH * (1 - (v - y0) / (y1 - y0))

  const n = t.points.length
  // n = 1 时贴右端（与「今天」同一侧），否则按样本顺序等距铺满
  const spacedPts = t.points.map((p, i) => ({
    x: n === 1 ? PAD.l + innerW : PAD.l + (innerW * i) / (n - 1),
    y: yOf(p.e1rm),
    date: p.date,
    v: p.e1rm,
  }))
  const line = spacedPts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const lastPt = spacedPts[spacedPts.length - 1]!
  const proj = t.projected != null ? { x: PAD.l + innerW, y: yOf(t.projected) } : null
  const dash =
    proj && n > 1 && Math.abs(proj.y - lastPt.y) > 0.5
      ? `M${lastPt.x.toFixed(1)},${lastPt.y.toFixed(1)} L${proj.x.toFixed(1)},${proj.y.toFixed(1)}`
      : ''
  return { spacedPts, proj, line, dash }
})
</script>

<template>
  <div class="wrap">
    <!-- 历史最高 -->
    <section v-if="hasBest" class="card">
      <div class="head">
        <h3>历史最高</h3>
        <span v-if="bestDate" class="date num">{{ fmtDateCn(bestDate) }}</span>
      </div>
      <p class="big num">
        {{ fmtKg(bestWeight!) }}<span class="u">kg</span>
        <span class="x num">× {{ bestReps ?? '—' }} 次</span>
      </p>
      <p v-if="bestE1rm" class="cap">按这一组估算的极限 e1RM ≈ {{ fmtKg(bestE1rm) }} kg</p>
    </section>

    <!-- 近 14 天趋势 -->
    <section class="card">
      <div class="head">
        <h3>近 {{ TREND_WINDOW_DAYS }} 天趋势</h3>
        <span v-if="slopeText" class="slope num" :class="dirTone">{{ slopeText }}</span>
      </div>

      <template v-if="trend && trend.points.length">
        <svg
          class="spark"
          :viewBox="`0 0 ${W} ${H}`"
          preserveAspectRatio="none"
          role="img"
          :aria-label="`近 ${TREND_WINDOW_DAYS} 天估算极限走势，最近一次 ${fmtKg(trend.latest ?? 0)} kg`"
        >
          <line class="axis" :x1="0" :y1="H - 1" :x2="W" :y2="H - 1" />
          <path class="line" :d="chart?.line ?? ''" />
          <path v-if="chart?.dash" class="dash" :d="chart.dash" />
          <circle
            v-for="(p, i) in chart?.spacedPts ?? []"
            :key="i"
            class="pt"
            :cx="p.x"
            :cy="p.y"
            r="3.2"
          />
          <circle v-if="chart?.proj" class="pt proj" :cx="chart.proj.x" :cy="chart.proj.y" r="2.8" />
        </svg>

        <div class="nums">
          <div class="ncell">
            <b class="num">{{ fmtKg(trend.latest ?? 0) }}</b>
            <span>最近一次</span>
          </div>
          <div class="ncell">
            <b class="num">{{ trend.projected != null ? fmtKg(trend.projected) : '—' }}</b>
            <span>趋势预测</span>
          </div>
          <div class="ncell">
            <b class="num">{{ trend.samples }}</b>
            <span>次训练</span>
          </div>
        </div>
        <p class="cap">
          {{ confidenceNote }} · 预测 = 窗口内每次训练最好 e1RM 的加权直线外推到今天，不代表一定能做到
        </p>
      </template>

      <p v-else class="empty">这个动作还没有可画趋势的记录，完成两次训练后这里会出现走势。</p>
    </section>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.card {
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
}

.head h3 {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  letter-spacing: 0.4px;
  color: var(--text-3);
}

.date {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* 趋势方向：语义落在这一枚小字上（涨=运动绿，跌=橙），不染整张卡 */
.slope {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.slope.up {
  color: var(--ok-strong);
}

.slope.down {
  color: var(--warn-strong);
}

.big {
  margin-top: var(--sp-6);
  display: flex;
  align-items: baseline;
  gap: var(--sp-4);
  font-size: var(--fs-title1);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  color: var(--text-1);
}

.big .u {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.big .x {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.cap {
  margin-top: var(--sp-6);
  font-size: var(--fs-micro);
  line-height: var(--lh-body);
  color: var(--text-3);
}

.spark {
  display: block;
  width: 100%;
  height: 62px;
  margin-top: var(--sp-8);
  overflow: visible;
}

.axis {
  stroke: var(--line);
  stroke-width: 1;
}

.line {
  fill: none;
  stroke: var(--c-exercise-deep);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 外推段：虚线，明确它不是我练出来的数据 */
.dash {
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.4;
  stroke-dasharray: 3 3;
  opacity: 0.8;
}

.pt {
  fill: var(--c-exercise-deep);
}

.pt.proj {
  /* 空心点：填卡面底色（曾经写成不存在的 --surface-1，fill 失效成黑点） */
  fill: var(--surface);
  stroke: var(--text-3);
  stroke-width: 1.4;
}

.nums {
  display: flex;
  gap: var(--gap-md);
  margin-top: var(--sp-8);
}

.ncell {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.ncell b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.ncell span {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.empty {
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-3);
}
</style>
