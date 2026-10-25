<script setup lang="ts">
import { computed } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ExerciseTrendCard from '@/components/exercise/ExerciseTrendCard.vue'
import type { ExerciseAdvice } from '@/utils/trainingAdvice'

/**
 * 重量建议说明抽屉（沉浸页「建议依据」行唤起）。可视化优先，文字只做注脚：
 *
 *  1. **建议**：建议重量大字 + RIR 点阵（做 8 次留 2 次余力 = 6 实 2 空，一眼看懂「不是力竭」）；
 *  2. **计算链**：上次 → 基线 → 今日极限 → 建议 的四节点竖向流程，数字即节点；
 *     「今日极限」节点里把今日状态四因子画成**带 1.0 刻度线的迷你条**——低于线的就是
 *     今天拖后腿的那项，只对最差的那项配一句文字解释；
 *  3. **RM · e1RM · RIR**：三个术语各一行。
 *
 * 全部数字取自 `ExerciseAdvice` 现成字段（因子明细也由引擎逐动作给出），本组件
 * 不重算任何口径 —— 与练够分抽屉同一纪律。
 */
const props = defineProps<{
  open: boolean
  /** 当前动作的建议结果；null = 引擎还没给出 */
  advice: ExerciseAdvice | null
  /** 动作名（库内名优先，与沉浸页标题一致） */
  exerciseName: string
}>()

const emit = defineEmits<{ close: [] }>()

/** kg 展示：整数不带小数，其余保留一位 */
function fmt(v: number | null): string {
  if (v == null) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

const isStrength = computed(() => !!props.advice && props.advice.kind === 'strength')

/** 计算链只在有历史的力量动作下展开 */
const hasChain = computed(() => !!props.advice && props.advice.hasHistory && props.advice.baselineE1rm != null)

/** 因子条映射：因子值域 0.85–1.06 → 0–100%，1.00 刻度线落在 71.4% */
const FACTOR_LO = 0.85
const FACTOR_HI = 1.06

function factorPct(v: number): number {
  const t = (v - FACTOR_LO) / (FACTOR_HI - FACTOR_LO)
  return Math.round(Math.max(0, Math.min(1, t)) * 100)
}

const FACTOR_TICK_PCT = Math.round(((1 - FACTOR_LO) / (FACTOR_HI - FACTOR_LO)) * 100)

const factors = computed(() => props.advice?.factors ?? [])

/** 拖后腿最狠的因子：条形图已表达"谁低于线"，文字只解释最差的那一条 */
const worstFactor = computed(() =>
  factors.value.filter((f) => f.value < 1).sort((a, b) => a.value - b.value)[0] ?? null,
)

/** RIR 点阵：建议次数里前段实心（有效次数）、末段空心（留的余力）；次数太多点阵就不画了 */
const repDots = computed(() => {
  const a = props.advice
  if (!a?.suggestedReps || !a.targetRir || a.suggestedReps > 15) return null
  return { total: a.suggestedReps, effective: a.suggestedReps - a.targetRir }
})

/** 上次训练日期：YYYY-MM-DD → M/D */
const lastDateShort = computed(() => {
  const d = props.advice?.lastDate
  if (!d) return ''
  const [, m, day] = d.split('-')
  return `${Number(m)}/${Number(day)}`
})
</script>

<template>
  <SheetModal :open="open" title="重量建议说明" initial-snap="large" @close="emit('close')">
    <template v-if="advice">
      <!-- ---------- 1. 建议 + RIR 点阵 ---------- -->
      <header v-if="advice.suggestedWeight != null" class="scard hero">
        <div class="row between">
          <span class="hero-name">{{ exerciseName }}</span>
          <span class="htag">今日建议</span>
        </div>
        <div class="hero-score row">
          <b class="big num">{{ fmt(advice.suggestedWeight) }}</b>
          <span class="unit num">kg</span>
          <span class="band num">× {{ advice.suggestedReps }} 次 × {{ advice.suggestedSets }} 组</span>
        </div>

        <div v-if="repDots" class="rirdots" role="img" :aria-label="`每组 ${repDots.total} 次，做完应还剩 ${advice.targetRir} 次余力`">
          <i
            v-for="i in repDots.total"
            :key="i"
            class="rirdot"
            :class="{ left: i > repDots!.effective }"
          />
        </div>
        <!-- 这一行只说点阵自身怎么读。RIR 的定义只在底部「三个名词」出现一次 ——
             同一个词在两条相距很远的位置各解释一遍、措辞还不同，
             用户要读第二遍才发现说的是同一件事 -->
        <p v-if="advice.targetRir" class="rircap">
          实心 = 实际做的次数，空心 = 留的余力。<StatusChip tone="accent" size="sm">不是力竭</StatusChip>
        </p>
      </header>

      <!-- ---------- 1.5 历史最高 + 近 14 天趋势 ----------
           用户点开「建议说明」时第二个问题几乎总是「我以前最多做到多少、最近在涨还是掉」。
           这两个数字与建议重量同源（同一次训练聚合），不需要再点一次抽屉。 -->
      <section v-if="advice.bestWeight != null || advice.trend" class="scard">
        <ExerciseTrendCard
          :best-weight="advice.bestWeight"
          :best-reps="advice.bestReps"
          :best-date="advice.bestDate"
          :best-e1rm="advice.bestE1rm"
          :trend="advice.trend"
        />
      </section>

      <!-- ---------- 2. 计算链 ---------- -->
      <section v-if="isStrength" class="scard">
        <div class="bhead row between">
          <h3>这个数怎么来的</h3>
          <span v-if="hasChain" class="btag">四步</span>
        </div>

        <div v-if="hasChain" class="chain">
          <!-- 上次 -->
          <div class="cnode">
            <i class="ndot num">1</i>
            <div class="ntop row between">
              <span class="ntit">上次训练 <span class="ndate num">{{ lastDateShort }}</span></span>
              <span class="nval num">{{ fmt(advice!.lastWeight) }} kg × {{ advice!.lastReps }} 次</span>
            </div>
          </div>

          <!-- 基线 -->
          <div class="cnode">
            <i class="ndot num">2</i>
            <div class="ntop row between">
              <span class="ntit">基线（平均状态）</span>
              <span class="nval num">≈ {{ fmt(advice!.baselineE1rm) }} kg</span>
            </div>
            <p class="ncap">近 3 次训练的 e1RM 加权平均，越近权重越高。</p>
          </div>

          <!-- 今日极限 + 状态因子条 -->
          <div class="cnode">
            <i class="ndot num">3</i>
            <div class="ntop row between">
              <span class="ntit">今日极限</span>
              <span class="nval num">≈ {{ fmt(advice!.todayCeiling) }} kg</span>
            </div>
            <div class="fbars" role="img" aria-label="今日状态因子：恢复、容量、趋势、自评">
              <div v-for="f in factors" :key="f.key" class="fbar">
                <span class="flab">{{ f.label }}</span>
                <span class="ftrack">
                  <i class="ffill" :class="{ low: f.value < 1 }" :style="{ '--p': `${factorPct(f.value)}%` }" />
                  <i class="ftick" :style="{ left: `${FACTOR_TICK_PCT}%` }" />
                </span>
                <span class="fval num" :class="{ low: f.value < 1 }">×{{ f.value.toFixed(2) }}</span>
              </div>
            </div>
            <p v-if="worstFactor" class="fwrap">{{ worstFactor.label }}拖了后腿 —— {{ worstFactor.note }}</p>
          </div>

          <!-- 建议 -->
          <div class="cnode final">
            <i class="ndot num">4</i>
            <div class="ntop row between">
              <span class="ntit">今天建议</span>
              <span class="nval final num">{{ fmt(advice!.suggestedWeight) }} kg</span>
            </div>
            <p class="ncap">
              {{ advice!.anchorNote ?? '以上次重量为锚：做满加一档，状态差降载（不低于上次的 85%），今日极限封顶。' }}
            </p>
          </div>
        </div>

        <p v-else class="mnote">
          这个动作还是首次记录：先按建议值起步，完成几组后这里会画出完整的计算链。
        </p>
      </section>

      <!-- ---------- 3. RM · e1RM · RIR ---------- -->
      <section class="scard">
        <div class="bhead row between">
          <h3>三个名词</h3>
        </div>
        <dl class="terms">
          <div class="term">
            <dt>RM</dt>
            <dd>能标准完成 n 次的最大重量；1RM 是单次极限，力量上限的度量。</dd>
          </div>
          <div class="term">
            <dt>e1RM</dt>
            <dd>按公式 w×(1+r÷30) 从正常组反推的 1RM —— 不用真冲力竭，每条记录都带一个。</dd>
          </div>
          <div class="term">
            <dt>RIR</dt>
            <dd>每组留的余力次数；RIR 2 = 做完还能再做 2 次，约为当日极限的 95%。</dd>
          </div>
        </dl>
      </section>
    </template>

    <p v-else class="empty">还没有可说明的建议。</p>
  </SheetModal>
</template>

<style scoped>
/* ---------- 白卡：与练够分抽屉同一套承载（tokens.css 的 --sheet-card-*） ---------- */
.scard {
  padding: var(--sp-16);
  /* 与练够分抽屉的白卡同档：卡片 16，容器才是 32 */
  border-radius: var(--radius-m);
  background: var(--sheet-card-fill);
  box-shadow: var(--sheet-card-shadow);
}

.scard + .scard {
  margin-top: var(--sp-12);
}

.scard:first-child {
  margin-top: var(--sp-6);
}

.row {
  display: flex;
  align-items: center;
}

.between {
  justify-content: space-between;
}

/* ---------- 1. 建议 ---------- */
.hero-name {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.htag {
  padding: var(--sp-4) var(--sp-8) var(--sp-4) var(--sp-18);
  border-radius: var(--radius-full);
  position: relative;
  /* 「今日建议」是这块的结论标签，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  /* 绿字压浅灰底实测只有约 2.7:1，读不清 —— 文字回 --text-1，
     语义交给左侧那枚绿点（与逐动作明细行 .expr 徽标同一处理） */
  color: var(--text-1);
  background: var(--surface-2);
}

.htag::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 50%;
  width: 5px;
  height: 5px;
  margin-top: calc(-1 * var(--sp-2));
  border-radius: 50%;
  background: var(--c-exercise-deep);
}

.hero-score {
  margin-top: var(--sp-6);
  align-items: baseline;
  gap: var(--gap-sm);
}

.big {
  /* 展示级读数走令牌：44px 就是 --fs-display-l 这一档，
     桌面壳整体降一档字号阶梯时这处要跟随 */
  font-size: var(--fs-display-l);
  font-weight: var(--fw-bold);
  letter-spacing: -1.5px;
  color: var(--text-1);
  line-height: 1.05;
}

.unit {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.band {
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  background: var(--surface-2);
}

/* RIR 点阵：实心 = 有效次数，空心 = 留的余力 */
.rirdots {
  display: flex;
  gap: var(--gap-tight);
  margin-top: var(--sp-12);
}

.rirdot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--c-exercise-deep);
}

.rirdot.left {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--c-exercise-deep);
  opacity: 0.5;
}

.rircap {
  margin-top: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* ---------- 通用块头 ---------- */
.bhead h3 {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.btag {
  /* 「四步」是计算链的段首计数 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* ---------- 2. 计算链：竖线把四个数字节点串成因果 ---------- */
.chain {
  margin-top: var(--sp-14);
}

.cnode {
  position: relative;
  padding: 0 0 var(--sp-18) var(--sp-32);
}

/* 节点间连线：最后一个节点不画 */
.cnode::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 24px;
  bottom: 2px;
  width: 2px;
  border-radius: var(--radius-xs);
  background: var(--line);
}

.cnode:last-child {
  padding-bottom: var(--sp-2);
}

.cnode:last-child::before {
  display: none;
}

.ndot {
  position: absolute;
  left: 0;
  top: 0;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  /* 节点序号圆点：12px 就是 --fs-caption 这一档，走令牌不写死 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.ntop {
  align-items: baseline;
  gap: var(--gap-sm);
}

.ntit {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.ndate {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.nval {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  white-space: nowrap;
}

.ncap {
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-3);
}

/* 终点节点：建议重量是整条链的结论，加重 */
.cnode.final .ndot {
  background: var(--c-exercise-deep);
  color: var(--on-tone);
}

.nval.final {
  font-size: var(--fs-title3);
  /* 终点建议值是数值：中性色（色彩配额，STANDARDS §4）；「结论」地位由字号抬档表达 */
  color: var(--text-1);
}

/* 因子条：低于 1.0 刻度线的就是今天拖后腿的那项 */
.fbars {
  margin-top: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.fbar {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.flab {
  flex: none;
  width: 30px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.ftrack {
  position: relative;
  flex: 1;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.ffill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 100%;
  border-radius: var(--radius-full);
  background: var(--c-exercise-deep);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

/* 拖后腿的因子是「该补」的判断，用语义红；不是运动身份橙。
   正常因子保持橙（只是条的长度在表达数值），低因子才变色。 */
.ffill.low {
  background: var(--heat-low);
}

/* 1.0 刻度线：条没够到它 = 这个因子在往下压 */
.ftick {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 1.5px;
  border-radius: var(--radius-xs);
  background: var(--text-3);
  opacity: 0.45;
}

.fval {
  flex: none;
  width: 42px;
  text-align: right;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fval.low {
  color: var(--warn-strong);
}

.fwrap {
  margin-top: var(--sp-6);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--warn-strong);
}

.mnote {
  margin-top: var(--sp-12);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-3);
}

/* ---------- 3. 名词 ---------- */
.terms {
  margin-top: var(--sp-10);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.term {
  display: flex;
  gap: var(--sp-10);
}

.term dt {
  flex: none;
  width: 46px;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.term dd {
  flex: 1;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.empty {
  padding: var(--sp-24) var(--sp-2);
  text-align: center;
  font-size: var(--fs-footnote);
  color: var(--text-3);
}
</style>
