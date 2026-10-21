<script setup lang="ts">
import { computed, ref } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import type { ProgramTier } from '@/types'
import { TIER_SPECS } from '@/utils/programEngine'
import {
  CURVES,
  FREQ_CURVE,
  JETLAG_CURVE,
  SLEEP_CURVE,
  TIER_JETLAG_TOLERANCE,
  polylinePoints,
  sampleCurve,
  toX,
  toY,
  type CurveBand,
  type CurveSpec,
} from '@/utils/programCurves'

/**
 * 档位科学依据：把三条研究曲线做成可切换的解释视图。
 *
 * 目的不是科普，而是回答「为什么频次这样安排」——研究里的 2~3 次/周
 * 指同一肌群每周被练到的次数，方案用分化（全身×3 / 上下×2 / 推拉腿混排）保证；
 * 01 的对比矩阵给的是数字差异，这里给的是差异背后的证据。
 */
const props = defineProps<{
  open: boolean
  /** 当前选中/生效的档位，用于在曲线与表格上高亮该档的位置 */
  tier: ProgramTier
}>()

const emit = defineEmits<{ close: [] }>()

const TAB_LABEL: Record<string, string> = {
  freq: '训练频次',
  sleep: '睡眠时长',
  jetlag: '社交时差',
}

const tab = ref('freq')
const options = CURVES.map((c) => ({ value: c.key, label: TAB_LABEL[c.key] ?? c.key }))
const curve = computed<CurveSpec>(() => CURVES.find((c) => c.key === tab.value) ?? CURVES[0]!)

/* ---------------- 画布坐标 ---------------- */

const PLOT = { left: 34, top: 14, width: 288, height: 114 }
const Y_MAX = 100

const axis = computed(() => {
  const ticks = curve.value.ticks
  return { xMin: ticks[0] ?? 0, xMax: ticks[ticks.length - 1] ?? 1, yMax: Y_MAX }
})

const xOf = (x: number): number => toX(PLOT, axis.value, x)
const yOf = (v: number): number => toY(PLOT, Y_MAX, v)

const gridLines = computed(() => [100, 75, 50, 25, 0].map((v) => ({ v, y: yOf(v) })))

const strengthPoints = computed(() => polylinePoints(curve.value, PLOT, axis.value, 'strength'))
const musclePoints = computed(() => polylinePoints(curve.value, PLOT, axis.value, 'muscle'))

const markerList = computed(() => curve.value.markers ?? [])

/* ---------------- 图上的标记点 ---------------- */

interface Mark {
  x: number
  label: string
  sub: string
  /** 是否为当前档位（高亮） */
  on: boolean
}

const TIERS: ProgramTier[] = ['conservative', 'balanced', 'aggressive']

const marks = computed<Mark[]>(() => {
  const c = curve.value
  // 频次曲线的横轴是「同一肌群每周被练到的次数」；所有档位的分化设计都落在此窗口内
  if (c.key === 'freq') {
    return [
      { x: 2, label: '设计下限', sub: '每肌群 ≥2 次/周', on: true },
      { x: 3, label: '三练档', sub: '全身×3', on: false },
    ]
  }
  if (c.key === 'sleep') {
    // 与曲线背景分区、要点表同一个区间（7–8h）：原先标记写 7.5-8h、
    // 表格写 7-8h、分区是 7→8，三处对不上，读者不知道该信哪个
    return [{ x: 8, label: '推荐', sub: '7-8h', on: true }]
  }
  return []
})

/* ---------------- 曲线下方的要点表 ---------------- */

type RowTone = CurveBand['tone'] | 'muted'

interface Row {
  label: string
  value: string
  tone: RowTone
}

const rows = computed<Row[]>(() => {
  const c = curve.value

  if (c.key === 'freq') {
    const at2 = sampleCurve(FREQ_CURVE, 2)
    const at3 = sampleCurve(FREQ_CURVE, 3)
    return [
      {
        label: '分化设计下限 · 每个肌群',
        value: `≥2 次/周 · 肌肉 ${at2.muscle}%`,
        tone: 'best' as RowTone,
      },
      { label: '三练档 · 全身×3', value: `3 次/周 · 肌肉 ${at3.muscle}%`, tone: 'muted' as RowTone },
      { label: '四练及以上 · 上下/推拉腿混排', value: '2~3 次/周', tone: 'muted' as RowTone },
    ]
  }

  if (c.key === 'sleep') {
    const at = (h: number): number => sampleCurve(SLEEP_CURVE, h).strength
    return [
      { label: '< 5h 严重剥夺', value: `力量 ${at(5)}%`, tone: 'risk' },
      { label: '6h 合成代谢抵抗', value: `力量 ${at(6)}%`, tone: 'warn' },
      { label: '7-8h 黄金窗口', value: `力量 ${at(8)}%`, tone: 'best' },
      { label: '10h+ U 型右端', value: `力量 ${at(10)}%`, tone: 'warn' },
    ]
  }

  const at = (h: number): number => sampleCurve(JETLAG_CURVE, h).strength
  return [
    { label: '≤ 1h 规律', value: `力量 ${at(1)}%`, tone: 'best' as RowTone },
    { label: '2h 抑制阈值', value: `力量 ${at(2)}%`, tone: 'warn' as RowTone },
    { label: '3h 中度失调', value: `力量 ${at(3)}%`, tone: 'risk' as RowTone },
    ...TIERS.map((t) => ({
      label: `${TIER_SPECS[t].label}档耐受`,
      value: `≤ ${TIER_JETLAG_TOLERANCE[t]}h`,
      tone: t === props.tier ? ('best' as RowTone) : ('muted' as RowTone),
    })),
  ]
})

const tableTitle = computed(() => {
  if (curve.value.key === 'freq') return '频次设计落点'
  if (curve.value.key === 'sleep') return '关键发现'
  return '时差影响与档位耐受度'
})

const bandFill = (tone: CurveBand['tone']): string => {
  if (tone === 'best') return 'var(--ok)'
  if (tone === 'good') return 'var(--c-exercise)'
  if (tone === 'warn') return 'var(--warn)'
  return 'var(--danger)'
}

const bandX = (b: CurveBand): number => xOf(b.from)
const bandW = (b: CurveBand): number => Math.max(0, xOf(b.to) - xOf(b.from))

/** 曲线上某点的力量值（用于把标记圆点画在曲线上） */
const strengthAt = (x: number): number => sampleCurve(curve.value, x).strength
</script>

<template>
  <SheetModal :open="open" title="为什么是这样" initial-snap="large" @close="emit('close')">
    <div class="ev">
      <SegmentedControl v-model="tab" :options="options" />

      <!-- 切 tab 即整组更换：key 保证旧 tab 先离开再进场（否则同结构复用节点，Transition 不触发） -->
      <Transition name="fade">
        <div :key="tab" class="ev-body">
          <section class="card">
        <header class="card-head">
          <b>{{ curve.title }}</b>
          <div class="head-side">
            <span class="unit">{{ curve.axisLabel }}</span>
            <!-- 「社交时差」的定义与睡眠数据未接入的说明：收进曲线卡标题行右端，
                 卡面只留一行结论 -->
            <InfoHint
              v-if="curve.key === 'jetlag'"
              title="社交时差"
              content="社交时差 = 工作日与休息日「睡眠中点」的差值：两者越接近，曲线越靠左，力量增长损失越小。

现在还没有记录睡眠数据，所以曲线只展示它与档位选择的关系，不标你的位置；接入睡眠记录后即可把你的位置标到曲线上。"
            />
          </div>
        </header>

        <svg class="chart" viewBox="0 0 330 176" role="img" :aria-label="curve.title">
          <!-- 背景分区 -->
          <rect
            v-for="(b, i) in curve.bands"
            :key="`b${i}`"
            :x="bandX(b)"
            :y="PLOT.top"
            :width="bandW(b)"
            :height="PLOT.height"
            :fill="bandFill(b.tone)"
            :opacity="b.tone === 'best' ? 0.18 : 0.1"
          />

          <!-- 网格与坐标轴 -->
          <line
            v-for="g in gridLines"
            :key="`g${g.v}`"
            :x1="PLOT.left"
            :y1="g.y"
            :x2="PLOT.left + PLOT.width"
            :y2="g.y"
            stroke="var(--line-strong)"
            stroke-width="0.5"
            stroke-dasharray="2 3"
          />
          <line
            :x1="PLOT.left"
            :y1="PLOT.top"
            :x2="PLOT.left"
            :y2="PLOT.top + PLOT.height"
            stroke="var(--line-strong)"
            stroke-width="0.5"
          />
          <line
            :x1="PLOT.left"
            :y1="PLOT.top + PLOT.height"
            :x2="PLOT.left + PLOT.width"
            :y2="PLOT.top + PLOT.height"
            stroke="var(--line-strong)"
            stroke-width="0.5"
          />

          <!-- 阈值 / 峰值竖线 -->
          <template v-for="m in markerList" :key="`k${m.at}`">
            <line
              :x1="xOf(m.at)"
              :y1="PLOT.top"
              :x2="xOf(m.at)"
              :y2="PLOT.top + PLOT.height"
              stroke="var(--warn)"
              stroke-width="1"
              stroke-dasharray="3 3"
              opacity="0.7"
            />
            <text
              :x="xOf(m.at)"
              :y="PLOT.top + 9"
              text-anchor="middle"
              font-size="9"
              font-weight="700"
              fill="var(--warn)"
            >
              {{ m.label }}
            </text>
          </template>

          <!-- 两条曲线 -->
          <polyline
            :points="strengthPoints"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <polyline
            :points="musclePoints"
            fill="none"
            stroke="var(--c-protein)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.85"
          />

          <!-- 档位 / 推荐标记 -->
          <template v-for="mk in marks" :key="`m${mk.label}`">
            <line
              :x1="xOf(mk.x)"
              :y1="PLOT.top"
              :x2="xOf(mk.x)"
              :y2="PLOT.top + PLOT.height"
              :stroke="mk.on ? 'var(--accent)' : 'var(--line-strong)'"
              :stroke-width="mk.on ? 2 : 1"
              :stroke-dasharray="mk.on ? '3 2' : '2 2'"
            />
            <circle
              :cx="xOf(mk.x)"
              :cy="yOf(strengthAt(mk.x))"
              :r="mk.on ? 4.5 : 3.5"
              :fill="mk.on ? 'var(--accent)' : 'var(--text-3)'"
              :stroke="mk.on ? 'var(--surface)' : 'none'"
              :stroke-width="mk.on ? 1.5 : 0"
            />
          </template>

          <!-- 纵轴刻度 -->
          <text
            v-for="g in gridLines"
            :key="`y${g.v}`"
            :x="PLOT.left - 5"
            :y="g.y + 3"
            text-anchor="end"
            font-size="8"
            fill="var(--text-3)"
          >
            {{ g.v }}
          </text>

          <!-- 横轴刻度 -->
          <text
            v-for="t in curve.ticks"
            :key="`x${t}`"
            :x="xOf(t)"
            :y="PLOT.top + PLOT.height + 14"
            text-anchor="middle"
            font-size="8"
            fill="var(--text-3)"
          >
            {{ t }}
          </text>

          <!-- 标记文字 -->
          <template v-for="mk in marks" :key="`mt${mk.label}`">
            <text
              :x="xOf(mk.x)"
              :y="PLOT.top + PLOT.height + 29"
              text-anchor="middle"
              font-size="9"
              :font-weight="mk.on ? 700 : 600"
              :fill="mk.on ? 'var(--accent)' : 'var(--text-2)'"
            >
              {{ mk.label }}
            </text>
            <text
              :x="xOf(mk.x)"
              :y="PLOT.top + PLOT.height + 40"
              text-anchor="middle"
              font-size="8"
              :font-weight="mk.on ? 600 : 400"
              :fill="mk.on ? 'var(--accent)' : 'var(--text-3)'"
            >
              {{ mk.sub }}
            </text>
          </template>
        </svg>

        <ul class="legend">
          <li><i class="sw" style="background: var(--accent)" />力量</li>
          <li><i class="sw" style="background: var(--c-protein)" />肌肉</li>
          <li v-for="(b, i) in curve.bands" :key="`l${i}`">
            <i class="sw" :style="{ background: bandFill(b.tone), opacity: 0.5 }" />{{ b.label }}
          </li>
        </ul>
      </section>

      <section class="card">
        <header class="card-head">
          <b>{{ tableTitle }}</b>
        </header>
        <ul class="rows num">
          <li v-for="r in rows" :key="r.label" :class="r.tone">
            <span class="rl">{{ r.label }}</span>
            <span class="rv">{{ r.value }}</span>
          </li>
        </ul>
      </section>

      <p class="note">{{ curve.conclusion }}</p>

      <!-- 睡眠数据未接入前的一行结论；完整定义收进曲线卡标题行右端的 InfoHint -->
      <p v-if="curve.key === 'jetlag'" class="note concl">
        暂未记录睡眠数据，先看档位耐受度
      </p>
        </div>
      </Transition>

      <button class="primary" @click="emit('close')">明白了</button>
    </div>
  </SheetModal>
</template>

<style scoped>
.ev {
  display: grid;
  gap: var(--gap-md);
  padding-bottom: var(--sp-20);
}

/* tab 内容组沿用 .ev 的间距：曲线卡 / 表格卡 / 结论文本之间由它接管 */
.ev-body {
  display: grid;
  gap: var(--gap-md);
}

/* 切 tab 的进出场：内容整体更换，只走不透明度且进出同向 */
.fade-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.fade-enter-from {
  opacity: 0;
}
.fade-leave-active {
  transition: none;
}

.card {
  /* 证据卡四边同距 12（二级分组面 --pad-card-tight），原来左右多 2 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
  margin-bottom: var(--sp-8);
}

/* 标题行右端：轴标 + 说明入口 */
.card-head .head-side {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.card-head b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.chart {
  display: block;
  width: 100%;
  height: auto;
}

.legend {
  /* 图与图例 8（标题与内容），原来 6 */
  margin-top: var(--gap-sm);
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-tight) var(--sp-10);
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.sw {
  width: 9px;
  height: 9px;
  border-radius: var(--radius-xs);
  flex: none;
}

.rows {
  display: grid;
  /* 证据行之间 8：同一组信息内部保持一档，不与卡间 12 混 */
  gap: var(--gap-sm);
}

.rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-caption);
}

.rows li.best {
  background: var(--accent-soft);
}

.rl {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.rv {
  color: var(--text-2);
  white-space: nowrap;
}

/* soft 底上的字一律走对应 --*-strong：实底档（--accent/--warn/--danger）
   直接当文字对比度只有 2:1 上下 */
.rows li.best .rv {
  color: var(--accent-strong);
  font-weight: var(--fw-bold);
}

.rows li.risk .rv {
  color: var(--danger-strong);
  font-weight: var(--fw-semibold);
}

.rows li.warn .rv {
  color: var(--warn-strong);
  font-weight: var(--fw-semibold);
}

.note {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  line-height: var(--lh-body);
}

/* 睡眠数据未接入的一行结论：比 .note 重一档，不再是 11px 三级灰 */
.note.concl {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-weight: var(--fw-semibold);
}

.primary {
  width: 100%;
  padding: var(--sp-12) 0;
  /* 页脚主按钮走按钮档 20 */
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}
</style>
