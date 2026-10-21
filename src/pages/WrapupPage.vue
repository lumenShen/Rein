<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import PageHeader from '@/components/layout/PageHeader.vue'
import RingProgress from '@/components/common/RingProgress.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import { useProgramStore } from '@/stores/program'
import type { ProgramRecord } from '@/types'
import { fmtRate, fmtWeightDelta, reportSpanDays } from '@/utils/programReport'
import { buildWrapup, wrapupSubtitle, type WrapupData } from '@/utils/programWrapup'

/**
 * 结营成绩单：一份方案结束后的对照与庆祝。
 *
 * 完成度大数字诚实呈现；「开始 → 结束」回答「有没有用」；徽章按数据规则颁发；
 * 底部直接给下一期档位建议——归档不是终点，是中转站。
 */
const router = useRouter()
const store = useProgramStore()

const phase = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const record = ref<ProgramRecord | null>(null)
const data = ref<WrapupData | null>(null)
const loadError = ref('')

onMounted(async () => {
  try {
    await store.load()
    const id = Number(router.currentRoute.value.params.id)
    const rec = store.history.find((r) => r.id === id) ?? null
    if (!rec) {
      phase.value = 'missing'
      return
    }
    record.value = rec
    data.value = await buildWrapup(rec)
    phase.value = 'ready'
  } catch (e) {
    // 方案数据损坏或读取失败时要给出出口，否则永远停在「加载中」
    loadError.value = e instanceof Error ? e.message : '结营数据读取失败'
    phase.value = 'error'
  }
})

const subtitle = computed(() => (record.value ? wrapupSubtitle(record.value) : ''))

const completionText = computed(() =>
  data.value?.completion != null ? `${Math.round(data.value.completion * 100)}%` : '—',
)

/** 完成度标题随实际完成度分档：固定一句「你坚持下来了」在 20% 的环上方与数据互相拆台 */
const heroTitle = computed(() => {
  const c = data.value?.completion
  if (c == null) return '你坚持下来了'
  if (c >= 0.9) return '几乎全部兑现'
  if (c >= 0.6) return '走完了大半'
  return '先把它跑完'
})

const nextTierLabel = computed(() => {
  const t = data.value?.nextTier
  return t === 'conservative' ? '保守' : t === 'aggressive' ? '进取' : '均衡'
})

/** 体重变化的方向色：与目标同向 = good，反向 = bad，持平无色 */
function deltaCls(c: { before: number | null; after: number | null }): string {
  if (c.before == null || c.after == null) return ''
  const move = c.after - c.before
  if (Math.abs(move) < 0.05) return ''
  const goal = record.value?.goal
  if (goal === 'keep') return ''
  const good = goal === 'bulk' ? move > 0 : move < 0
  return good ? 'good' : 'bad'
}

const heroStats = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { em: '坚持', value: d.streakDays, unit: '天' },
    { em: '训练', value: d.report.training.done, unit: '次' },
    { em: '记录', value: d.report.recordedDays, unit: '天' },
    { em: '调整', value: d.report.adjustmentsCount, unit: '次' },
  ]
})

/** 归档状态决定 CTA：历史方案直接开下一期；生效中的先归档 */
const isActive = computed(() => record.value?.status === 'active')
const archiving = ref(false)

async function nextPhase(): Promise<void> {
  if (!record.value) return
  if (isActive.value) {
    archiving.value = true
    try {
      await store.archive(record.value.id)
    } finally {
      archiving.value = false
    }
  }
  void router.push('/program')
}
</script>

<template>
  <div class="page">
    <PageHeader title="结营成绩单" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <section v-if="phase === 'loading'" class="card center empty">
      <span class="t-3">正在汇总执行数据…</span>
    </section>

    <section v-else-if="phase === 'missing'" class="card center empty">
      <span class="t-3">没有找到这份方案</span>
      <button class="primary" @click="router.replace('/program')">回健康方案</button>
    </section>

    <section v-else-if="phase === 'error'" class="card center empty">
      <span class="t-3">{{ loadError }}</span>
      <button class="primary" @click="router.replace('/program')">回健康方案</button>
    </section>

    <template v-else-if="data && record">
      <!-- 完成度 -->
      <section class="pod hero">
        <p class="eyebrow">{{ subtitle }}</p>
        <p class="hero-title">{{ heroTitle }}</p>
        <RingProgress
          :value="data.completion ?? 0"
          color-var="--c-exercise"
          :size="112"
          :stroke="11"
        >
          <b class="num ring-num">{{ completionText }}</b>
          <span class="ring-cap">训练完成率</span>
        </RingProgress>
        <ul class="statgrid num">
          <li v-for="s in heroStats" :key="s.em">
            <em>{{ s.em }}</em>
            <b>{{ s.value }}<i>{{ s.unit }}</i></b>
          </li>
        </ul>
      </section>

      <!-- 开始 → 结束 -->
      <section class="pod compare">
        <header class="pod-head"><b>开始 → 结束</b></header>
        <ul class="rows">
          <li>
            <span class="lbl">体重</span>
            <!-- 真正的起止值（不显示差量；差量与方向色只在报告格「体重变化」里出现一次） -->
            <span class="val num">
              <template v-if="data.compare.weight.before != null">{{ data.compare.weight.before }}<i>kg</i></template>
              <template v-else>—</template>
              →
              <b>
                <template v-if="data.compare.weight.after != null">{{ data.compare.weight.after }}<i>kg</i></template>
                <template v-else>—</template>
              </b>
            </span>
          </li>
          <li>
            <span class="lbl">日均摄入（有记录的日子）</span>
            <span class="val num">
              <template v-if="data.compare.intake.before != null">{{ data.compare.intake.before }}<i>大卡</i></template>
              <template v-else>—</template>
              →
              <b>
                <template v-if="data.compare.intake.after != null">{{ data.compare.intake.after }}<i>大卡</i></template>
                <template v-else>—</template>
              </b>
            </span>
          </li>
          <li>
            <span class="lbl">训练频率</span>
            <span class="val num">
              {{ data.compare.trainingFreq.before }}<i>次/周</i> →
              <b>{{ data.compare.trainingFreq.after }}<i>次/周</i></b>
            </span>
          </li>
          <li>
            <span class="lbl">日程完成</span>
            <span class="val num">
              {{ fmtRate(data.report.schedule.done, data.report.schedule.planned) }}
              <span class="t-3">（{{ data.report.schedule.done }}/{{ data.report.schedule.planned }} 项）</span>
            </span>
          </li>
        </ul>
        <!-- 区间五件事实分层：天数做主读数，日期区间单独一行，次数/时长/消耗各走一枚胶囊 -->
        <p class="span-main num">共 {{ reportSpanDays(data.report.startDate, data.report.endDate) }} 天</p>
        <p class="span-range num">{{ data.report.startDate }} ~ {{ data.report.endDate }}</p>
        <div class="span-facts">
          <PillChip size="md" tone="muted">运动 <span class="num">{{ data.report.actual.count }}</span> 次</PillChip>
          <PillChip size="md" tone="muted"><span class="num">{{ data.report.actual.minutes }}</span> 分钟</PillChip>
          <PillChip size="md" tone="muted">运动消耗 <span class="num">{{ data.report.actual.kcal }}</span> 大卡</PillChip>
        </div>
      </section>

      <!-- 徽章 -->
      <section v-if="data.badges.length" class="pod badges">
        <header class="pod-head">
          <b>获得 {{ data.badges.length }} 枚徽章</b>
        </header>
        <ul class="badges">
          <li v-for="b in data.badges" :key="b.title">
            <i class="bemoji">{{ b.emoji }}</i>
            <div>
              <p class="btitle">{{ b.title }}</p>
              <p class="bsub t-3">{{ b.sub }}</p>
            </div>
          </li>
        </ul>
      </section>

      <!-- 下一期 -->
      <section class="callout">
        <b>下一期建议</b>：{{ data.nextTierText }}
      </section>

      <button class="primary" :disabled="archiving" @click="nextPhase">
        {{ archiving ? '正在归档…' : isActive ? `归档并开启下一期（${nextTierLabel}档起步）` : `开启下一期（${nextTierLabel}档起步）` }}
      </button>

      <!-- 完整报告 -->
      <section class="pod report">
        <header class="pod-head">
          <b>完整报告</b>
          <span class="row head-side">
            <!-- 目标与档位页首 eyebrow 已说过（「28 天 · 减脂 · 均衡档」），这里只留版本 -->
            <span class="t-3 num ver-note">第 {{ record.version }} 版</span>
            <span class="hint-slot">
              <InfoHint title="统计口径">
                <p>计划训练日 = 当天有运动记录，或勾了方案日程；训练完成率按这个口径统计。</p>
                <p>未记录的饮食日不参与平均摄入统计 —— 分母只算记了饮食的日子，所以叫「日均摄入（有记录的日子）」。</p>
              </InfoHint>
            </span>
          </span>
        </header>
        <ul class="rstats num">
          <li><em>日均摄入（有记录的日子）</em><b>{{ data.report.avgIntake ?? '—' }}</b><i>目标 {{ data.report.targetKcal }} 大卡</i></li>
          <li><em>训练完成率</em><b>{{ fmtRate(data.report.training.done, data.report.training.planned) }}</b><i>{{ data.report.training.done }}/{{ data.report.training.planned }} 次（含运动记录与日程勾选）</i></li>
          <li><em>真实运动</em><b>{{ data.report.actual.count }} 次</b><i>含跟课 {{ data.report.actual.sessions }} 次 · 有记录 {{ data.report.recordedDays }} 天饮食</i></li>
          <li>
            <em>体重变化</em>
            <b :class="deltaCls(data.compare.weight)">{{ fmtWeightDelta(data.report.weightDeltaKg) }}</b>
            <i>期内首末两条体重记录之差</i>
          </li>
        </ul>
      </section>
    </template>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.empty {
  padding: var(--sp-40) 0;
  display: grid;
  gap: var(--sp-14);
}

.pod {
  margin-bottom: var(--gap-md);
  /* 成绩单的分段容器按卡片几何：内距 16、半径 16（原来 14 / 20 让它比同页卡片大一号） */
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
  /* 标题行与内容 8（卡内标题与内容 8） */
  margin-bottom: var(--gap-sm);
}

/* 卡头右侧一组：版本注 + 帮助入口 */
.head-side {
  gap: var(--gap-sm);
}

.hint-slot {
  display: inline-flex;
  flex: none;
}

.ver-note {
  font-size: var(--fs-caption);
}

.pod-head b {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

/* 完成度英雄区 */
.hero {
  text-align: center;
  /* 英雄区内距取 24（区块级），与下方四条数字的分组拉开一档 */
  padding: var(--sp-24) var(--sp-16);
}

.eyebrow {
  font-size: var(--fs-micro);
  letter-spacing: 0.1em;
  color: var(--text-3);
  font-weight: var(--fw-semibold);
}

.hero-title {
  /* 眉标与标题是一组（8），标题与完成环之间 16 */
  margin: var(--gap-sm) 0 var(--sp-16);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.4px;
}

.ring-num {
  display: block;
  font-size: var(--fs-title1);
  font-weight: var(--fw-bold);
}

.ring-cap {
  display: block;
  margin-top: var(--gap-text);
  /* 环下说明按摘要卡口径 12：10px 只在真正的角标上出现 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.statgrid {
  /* 完成环与四格之间 16（区块间距），原来 18 在格点外 */
  margin-top: var(--gap-lg);
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--gap-sm);
}

.statgrid em {
  display: block;
  font-style: normal;
  /* 四格的字段标签是读数的必要部分：按摘要卡口径统一 12（原来 10 踩在字号下限） */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.statgrid b {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.statgrid i {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: var(--fw-regular);
  margin-left: var(--sp-2);
}

/* 对照行 */
.rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 对照行是单行行：高 48（--row-h），左右两端对齐 */
  min-height: var(--row-h);
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-subhead);
}

.rows li:first-child {
  border-top: none;
}

.lbl {
  color: var(--text-2);
}

.val b {
  font-weight: var(--fw-bold);
}

.val b.good {
  color: var(--ok-strong);
}

.val b.bad {
  color: var(--danger);
}

/* 对照行的单位：两侧对称（原先单位只写在右侧），单位降一档、数值保持原字号 */
.val i {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-3);
}

/* 区间五件事实：天数做主读数，日期区间单独一行，次数/时长/消耗各走胶囊 */
.span-main {
  /* 标题与主读数 8 */
  margin-top: var(--gap-sm);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.span-range {
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.span-facts {
  display: flex;
  flex-wrap: wrap;
  /* 五枚事实胶囊是一组：组内 4（--gap-tight），与标题行 8 */
  gap: var(--gap-tight);
  margin-top: var(--gap-sm);
}

/* 徽章 */
.badges {
  display: grid;
  /* 徽章之间 12（卡片间距档），与 .badges li 的行内间距分开 */
  gap: var(--gap-md);
}

.badges li {
  display: flex;
  align-items: center;
  /* 徽章图标与文字：左右 8（--gap-text-inline） */
  gap: var(--gap-text-inline);
}

.bemoji {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--c-exercise-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-callout);
  font-style: normal;
}

.btitle {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.bsub {
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
}

.callout {
  margin-bottom: var(--gap-md);
  /* 提示块四边同距 12，正文行高走 --lh-body */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.callout b {
  color: var(--text-1);
}

.primary {
  width: 100%;
  margin-bottom: var(--gap-md);
  /* 页脚主按钮高 40（--control-md 一档）走按钮圆角 20 */
  min-height: var(--control-md);
  padding: var(--sp-12) 0;
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

/* 完整报告 */
.rstats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  /* 完整报告的两栏格之间 12（卡片间距） */
  gap: var(--gap-md);
}

.rstats li {
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.rstats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.rstats b {
  display: block;
  /* 标签与数值 2（主次文本上下），原来 4 读起来像两段 */
  margin-top: var(--gap-text);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
}

.rstats i {
  display: block;
  margin-top: var(--sp-2);
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   .pod / .callout / .primary 不是 .card，壳层缺省已经让它们通栏；
   这里只补两件事：空态卡片也要通栏，以及把成绩单排成「通栏英雄区 + 左右两栏」。
   选择器里带上 section/button 元素名是为了压过壳层给 .page 子项定的栅格位。
   ============================================================ */

/* 页头钉在第 1 行：它是 sticky 的，如果不显式给行号，自动排布会绕开
   下面这些被显式占位的行，把它挤到最后一行的位置（页头跑到页脚去） */
.desk-main .page > .page-header {
  grid-row: 1;
  grid-column: 1 / -1;
}

/* 单张空态卡片在半栏里右半屏全空 —— 它本来就该是整屏一句话 */
.desk-main .rubber-layer > section.card.empty {
  grid-row: 1;
  grid-column: 1 / -1;
}

/* 完成度英雄区：一个环 + 四条数字，通栏居中才撑得住这页的气势 */
.desk-main .rubber-layer > section.pod.hero {
  grid-row: 1;
  grid-column: 1 / -1;
}

/* 对照与报告是这页的正文：并排两栏，一屏读完「有没有用」 */
.desk-main .rubber-layer > section.pod.compare {
  grid-row: 2;
  grid-column: 1;
}

.desk-main .rubber-layer > section.pod.report {
  grid-row: 2 / span 2;
  grid-column: 2;
}

/* 徽章是短列表，落在左栏对照下方 */
.desk-main .rubber-layer > section.pod.badges {
  grid-row: 3;
  grid-column: 1;
}

/* 下一期建议与 CTA 保持通栏：一条结论 + 一枚决定下一步的按钮，
   横跨整屏读起来才是「结论 → 行动」的顺序 */
.desk-main .rubber-layer > section.callout {
  grid-row: 4;
  grid-column: 1 / -1;
}

.desk-main .rubber-layer > button.primary {
  grid-row: 5;
  grid-column: 1 / -1;
}

/* 栅格用 gap 管行距，卡片自身那 12px 的下边距要收掉 */
.desk-main .rubber-layer > .pod,
.desk-main .rubber-layer > .callout,
.desk-main .rubber-layer > .primary {
  margin-bottom: 0;
}
</style>
