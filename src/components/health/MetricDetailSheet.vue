<script setup lang="ts">
import { computed } from 'vue'
import { Activity, TrendingDown, TrendingUp } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import {
  formatMetricDay,
  formatMetricValue,
  lastLocalDays,
  type HealthMetricMeta,
} from '@/config/healthMetrics'
import { trendGeometry } from '@/utils/chart'
import type { HealthMetricSeries } from '@/types'

/**
 * 体征指标详情抽屉（预览卡点某个指标行打开）。
 *
 * 上半是趋势图 + 窗口统计，下半是**raw 数据列表** —— 镜像表里这个指标的
 * 全部按天聚合行（近 90 天窗口），一天一行、含较前一天的增量。
 * 趋势图画法与历史列表语言沿用 BodyTrackerCard（体重追踪）那套既定口径，
 * 数据形状换成通用的 `(day, value)` 序列。
 */
const props = defineProps<{
  open: boolean
  meta: HealthMetricMeta | null
  series: HealthMetricSeries | null
}>()

const emit = defineEmits<{ close: [] }>()

/* ---- 窗口统计 ---- */
const stats = computed(() => {
  const pts = props.series?.points ?? []
  if (!pts.length || !props.meta) return null
  const vs = pts.map((p) => p.value)
  const fmt = (v: number) => formatMetricValue(props.meta!, v)
  return {
    count: pts.length,
    latest: fmt(props.series!.latestValue),
    latestDay: formatMetricDay(props.series!.latestDay),
    min: fmt(Math.min(...vs)),
    max: fmt(Math.max(...vs)),
    avg: fmt(vs.reduce((a, b) => a + b, 0) / vs.length),
  }
})

/* ---- 趋势图（与 BodyTrackerCard 同一画法：折线 + 渐变面积 + 末点） ---- */
const CHART_W = 320
const CHART_H = 96
const PAD_X = 5
const PAD_Y = 14

const trendGeom = computed(() => {
  const pts = props.series?.points ?? []
  const geom = trendGeometry(
    pts.map((p) => p.value),
    { width: CHART_W, height: CHART_H, padX: PAD_X, padY: PAD_Y },
  )
  if (!geom) return null
  return {
    ...geom,
    from: formatMetricDay(pts[0]!.day),
    to: formatMetricDay(pts[pts.length - 1]!.day),
  }
})

/* ---- raw 数据列表：新 → 旧，每行带较前一天的增量 ---- */
interface RawRow {
  day: string
  display: string
  today: boolean
  delta: number | null
}

const rawRows = computed<RawRow[]>(() => {
  const pts = props.series?.points ?? []
  const today = lastLocalDays(1)[0]!
  return [...pts]
    .reverse()
    .map((p, i) => {
      const prev = pts[pts.length - 1 - i - 1] // 升序里它前一个 = 更早的一天
      const delta =
        prev != null ? Math.round((p.value - prev.value) * 10) / 10 : null
      return {
        day: p.day,
        display: formatMetricValue(props.meta!, p.value),
        today: p.day === today,
        delta: delta != null && delta !== 0 ? delta : null,
      }
    })
})
</script>

<template>
  <SheetModal
    :open="open"
    :title="meta?.label ?? '指标详情'"
    initial-snap="large"
    @close="emit('close')"
  >
    <!-- 同步口径：抽屉内走 #action 槽，完整解释收进 InfoHint，脚注只留一句结论 -->
    <template #action>
      <InfoHint title="体征数据来源" content="这里的每日体征只来自 Health Connect：每次同步都会整体重来，历史读数按当次同步结果重建。手填的档案数据不走这条链路，因此不会被同步覆盖。" />
    </template>
    <EmptyState
      v-if="!stats"
      :icon="Activity"
      title="还没有数据"
      hint="先同步一次，这里会显示读到的原始数据"
    />
    <div v-else class="detail">
      <!-- 窗口统计：主格 2×2，右侧四格 -->
      <ul class="stats">
        <li class="main">
          <em>最新 · {{ stats.latestDay }}</em>
          <b class="num">{{ stats.latest }}<i v-if="meta?.unit">{{ meta.unit }}</i></b>
        </li>
        <li><em>最低</em><b class="num">{{ stats.min }}</b></li>
        <li><em>最高</em><b class="num">{{ stats.max }}</b></li>
        <li><em>平均</em><b class="num">{{ stats.avg }}</b></li>
        <li><em>有数据</em><b class="num">{{ stats.count }} 天</b></li>
      </ul>

      <!-- 趋势 -->
      <figure v-if="trendGeom" class="trend">
        <!-- 计数留在 figcaption，起止日期由图下轴标承载（同一段时间不写两遍） -->
        <figcaption class="num">
          <span>近 {{ stats.count }} 天有数据</span>
        </figcaption>
        <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="hm-trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path :d="trendGeom.area" fill="url(#hm-trend-fill)" />
          <polyline
            :points="trendGeom.points"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <circle :cx="trendGeom.last.x" :cy="trendGeom.last.y" r="3.2" fill="var(--accent)" />
        </svg>
        <span class="axis num"><i>{{ trendGeom.from }}</i><i>{{ trendGeom.to }}</i></span>
      </figure>
      <p v-else class="trend-note">只有一天数据，还画不出趋势</p>

      <!-- raw 数据 -->
      <h3 class="rtitle">原始数据</h3>
      <ul class="raw">
        <li v-for="row in rawRows" :key="row.day">
          <span class="date num">
            {{ formatMetricDay(row.day) }}
            <i v-if="row.today">今天</i>
          </span>
          <span class="delta num">
            <template v-if="row.delta !== null">
              <TrendingDown v-if="row.delta < 0" :size="12" />
              <TrendingUp v-else :size="12" />
              {{ row.delta > 0 ? '+' : '' }}{{ row.delta }}
            </template>
          </span>
          <span class="val num">
            {{ row.display }}<i v-if="meta?.unit"> {{ meta.unit }}</i>
          </span>
        </li>
      </ul>
      <!-- 「整表刷新」是开发者术语：说结果的普通话收进标题行 InfoHint，脚注只留结论 -->
      <p class="fnote">每日体征来自 Health Connect；你手填的资料不受影响</p>
    </div>
  </SheetModal>
</template>

<style scoped>
/* 窗口统计（BodyTrackerCard 同款四格） */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--gap-sm);
}

.stats li {
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  min-width: 0;
}

.stats li.main {
  grid-column: span 2;
  grid-row: span 2;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--accent-soft);
}

.stats em {
  display: block;
  font-style: normal;
  /* 统计格的字段小帽，不吃 11px */
  font-size: var(--fs-caption);
  color: var(--text-3);
  white-space: nowrap;
}

.stats li.main em {
  color: var(--accent);
}

.stats b {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stats li.main b {
  font-size: var(--fs-title1);
}

.stats b i {
  font-style: normal;
  font-weight: var(--fw-regular);
  /* 大数后的单位后缀，装饰性微字 */
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: var(--sp-2);
}

/* 趋势图 */
.trend {
  /* 趋势图与上方四格 12（卡内区块间距），图表区上下留白一致 */
  margin: var(--gap-md) 0 0;
}

.trend figcaption {
  display: flex;
  justify-content: space-between;
  gap: var(--gap-sm);
  /* 「近 N 次 · 最低/最高」是趋势摘要，是要读的数 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.trend svg {
  display: block;
  width: 100%;
  height: 96px;
  /* 图例与图之间 8（标题与内容），原来 6 比同一抽屉里其它组更紧 */
  margin-top: var(--gap-sm);
}

.axis {
  display: flex;
  justify-content: space-between;
  /* 趋势图左右两个日期刻度 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.axis i {
  font-style: normal;
}

.trend-note {
  margin-top: var(--sp-12);
  color: var(--text-3);
  font-size: var(--fs-caption);
}

/* raw 数据列表（BodyTrackerCard 历史列表同款语言） */
.rtitle {
  margin-top: var(--sp-16);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.raw {
  margin-top: var(--sp-2);
}

.raw > * + * {
  border-top: 0.5px solid var(--line);
}

.raw li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  /* 指标行是单行行：高度 48（--row-h），行间用分隔线连成一组 */
  min-height: var(--row-h);
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
}

.raw .date {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.raw .date i {
  font-style: normal;
  margin-left: var(--sp-6);
  padding: var(--sp-2) var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  /* 段首状态词（「已记录」），必须读得出 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.raw .delta {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
  justify-self: end;
}

.raw .val {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  min-width: 72px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.raw .val i {
  font-style: normal;
  font-weight: var(--fw-regular);
  /* 数值后的单位后缀，装饰性微字 */
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.fnote {
  margin-top: var(--sp-10);
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
