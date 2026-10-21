<script setup lang="ts">
import { computed } from 'vue'
import { Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import NutritionMicroList from '@/components/diet/NutritionMicroList.vue'
import { useGrowOnOpen } from '@/composables/useGrowOnOpen'
import { MEAL_LABELS, fmtGrams, mealKcal, mealQtyText } from '@/config/domain'
import { buildMicroRows, macroEnergyShare } from '@/utils/nutritionCalc'
import type { DailyTargets, MealLog, NutrientIntake } from '@/types'

/** 单笔饮食记录详情：按记录克重把「每 100g」营养折成实际摄入量，
 *  宏量对照当日目标、微量对照 DRI；删除交回父层二次确认。 */
const props = defineProps<{
  open: boolean
  log: MealLog | null
  /** 所选日期的每日目标；为 null 或某项为 0 时该处不画占比 */
  targets: DailyTargets | null
}>()

const emit = defineEmits<{ close: []; delete: [] }>()

/** Food 与 NutrientIntake 同名同义的字段（均为每 100g 的数值列） */
const NUTRIENT_KEYS: (keyof NutrientIntake)[] = [
  'kcal',
  'protein',
  'carb',
  'fat',
  'fiber',
  'sugar',
  'sodiumMg',
  'potassiumMg',
  'calciumMg',
  'ironMg',
  'zincMg',
  'magnesiumMg',
  'vitAUg',
  'vitCMg',
  'vitDUg',
  'vitEMg',
  'vitB12Ug',
  'folateUg',
]

/** 实际摄入量 = 每 100g 值 × 克重 ÷ 100 */
const scaled = computed(() => {
  const out = {} as Record<keyof NutrientIntake, number>
  const f = props.log?.food
  if (!f) return out
  const k = props.log!.grams / 100
  for (const key of NUTRIENT_KEYS) out[key] = (f[key] as number) * k
  return out
})

const kcal = computed(() => {
  if (!props.log) return 0
  return mealKcal(props.log) ?? Math.round(scaled.value.kcal)
})

/* 宏量供能占比：比例与克重无关，直接用每 100g 值算（与食品详情同口径） */
const share = computed(() => {
  const f = props.log?.food
  if (!f) return []
  return macroEnergyShare(f.protein, f.carb, f.fat)
})

/** 占本日：热量 + 三大宏量 + 钠，对照当日目标；目标未设（≤0）只给实际量 */
const dayRows = computed(() => {
  const t = props.targets
  const rows = [
    { label: '热量', unit: '大卡', actual: scaled.value.kcal, target: t?.kcal ?? 0, colorVar: '--c-intake' },
    { label: '蛋白质', unit: 'g', actual: scaled.value.protein, target: t?.protein ?? 0, colorVar: '--c-protein' },
    { label: '碳水', unit: 'g', actual: scaled.value.carb, target: t?.carb ?? 0, colorVar: '--c-carb' },
    { label: '脂肪', unit: 'g', actual: scaled.value.fat, target: t?.fat ?? 0, colorVar: '--c-fat' },
    { label: '钠', unit: 'mg', actual: scaled.value.sodiumMg, target: t?.sodiumMg ?? 0, colorVar: '--c-sodium' },
  ]
  return rows.map((r) => {
    const pct = r.target > 0 ? (r.actual / r.target) * 100 : null
    return {
      ...r,
      pct,
      fill: pct == null ? 0 : Math.min(100, pct),
      valueText: r.unit === 'g' ? fmtGrams(r.actual) : String(Math.round(r.actual)),
    }
  })
})

/** 微量营养素：按实际克重折算后对照 DRI，含量为 0 的不列 */
const microRows = computed(() => buildMicroRows(scaled.value, { onlyPositive: true }))

const timeText = computed(() => {
  const iso = props.log?.createdAt
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

/* 数据入场：抽屉展开后供能条/进度条从零生长 */
const grown = useGrowOnOpen(() => props.open)
</script>

<template>
  <SheetModal :open="open" :title="log?.food?.name ?? '记录详情'" @close="emit('close')">
    <template v-if="log?.food">
      <div class="anim" :class="{ grown }">
        <!-- 热量 + 宏量供能占比 -->
        <section class="card hero">
          <div class="row between top">
            <div>
              <p class="kcal num"><b>{{ kcal }}</b><em> 大卡</em></p>
            </div>
            <ul class="macros row">
              <li v-for="m in share" :key="m.key">
                <i class="dot" :style="{ background: `var(${m.colorVar})` }" />
                <span class="ml">{{ m.label }}</span>
                <b class="num">{{ fmtGrams(scaled[m.key]) }}g</b>
                <em class="mpct num">· {{ Math.round(m.pct) }}%</em>
              </li>
            </ul>
          </div>
          <!-- 元信息单独占行：挤在数字旁边会被右侧宏量列表压到折行 -->
          <p class="meta t-3 num">
            {{ MEAL_LABELS[log.mealType] }}<template v-if="timeText"> · {{ timeText }}</template>
            · {{ mealQtyText(log) }}
          </p>

          <div v-if="share.length" class="share">
            <span
              v-for="(m, i) in share"
              :key="m.key"
              :style="{ flex: m.pct, background: `var(${m.colorVar})`, '--i': i }"
            />
          </div>
          <!-- 占比已并进右上宏量列表（克数 + 占比同项），色条只留一行标签 -->
          <p v-if="share.length" class="share-label">供能占比</p>
        </section>

        <!-- 占本日：这一笔在当日目标里的分量 -->
        <section class="card">
          <header class="head"><h2>占本日</h2><p class="t-3">这一笔计入当天目标的分量</p></header>
          <ul class="daylist">
            <li v-for="r in dayRows" :key="r.label">
              <div class="row between drow">
                <span class="dlabel">
                  <i class="dot" :style="{ background: `var(${r.colorVar})` }" />{{ r.label }}
                </span>
                <span class="dval num">
                  {{ r.valueText }}<span class="dunit">{{ r.unit }}</span>
                  <template v-if="r.target > 0">
                    <em>/ {{ Math.round(r.target) }}{{ r.unit }}</em>
                    <b class="dpct">{{ Math.round(r.pct!) }}%</b>
                  </template>
                </span>
              </div>
              <div v-if="r.target > 0" class="bar">
                <div
                  class="fill"
                  :style="{ '--p': `${r.fill}%`, background: `var(${r.colorVar})` }"
                />
              </div>
            </li>
          </ul>
        </section>

        <!-- 微量营养素 · 实际摄入量对照 DRI -->
        <section v-if="microRows.length" class="card">
          <!-- 折算口径与 DRI 出处收进标题行右侧 InfoHint，卡面只留唯一图例 -->
          <header class="head row">
            <h2>微量营养素</h2>
            <InfoHint
              class="hint"
              title="微量营养素：折算口径"
              content="含量按这一笔的实际克重折算（每 100g 营养 × 克重 ÷ 100）。百分比以《中国居民膳食营养素参考摄入量》成人数值为基准：标记「上限」的项目对照每日建议上限，其余对照每日推荐摄入量。"
            />
          </header>
          <p class="legend">百分比 = 这一笔实际含量占每日推荐摄入的比例；上限项对照建议上限</p>
          <NutritionMicroList :rows="microRows" :grown="grown" />
        </section>
      </div>
    </template>
    <p v-else class="missing">这条记录缺少食物详情</p>

    <template v-if="log?.food" #footer>
      <button class="del" @click="emit('delete')">
        <Trash2 :size="17" /> 删除这条记录
      </button>
    </template>
  </SheetModal>
</template>

<style scoped>
.missing {
  text-align: center;
  padding: var(--sp-40) 0;
  font-size: var(--fs-subhead);
  color: var(--text-3);
}

.card {
  /* 抽屉里的分组面：卡间距 12、内距 16、圆角取卡片档 16 */
  margin-top: var(--gap-md);
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.card:first-child {
  margin-top: var(--gap-tight);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

/* 卡头行：标题 + 帮助入口同行（该卡唯一的图例说明在下方 .legend） */
.head .hint {
  margin-left: auto;
}

/* 唯一图例：解释行末百分比是什么（真实读得出的信息，不吃 11px 水印档） */
.legend {
  /* 标题与图例说明：主次文本上下 2 */
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.hero .top {
  align-items: flex-start;
}

.kcal b {
  font-size: var(--fs-display-m);
  font-weight: var(--fw-bold);
  letter-spacing: -1px;
}

.kcal em {
  font-style: normal;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.meta {
  margin-top: var(--gap-sm);
  font-size: var(--fs-footnote);
}

.macros {
  gap: var(--gap-md);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.macros li {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.ml {
  color: var(--text-2);
}

.macros b {
  font-weight: var(--fw-bold);
}

.share {
  display: flex;
  /* 三段之间 2 的缝：再大就断成三根条 */
  gap: var(--gap-text);
  height: 10px;
  margin-top: var(--gap-lg);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.share span:first-child {
  border-radius: var(--radius-full) 0 0 var(--radius-full);
}

.share span:last-child {
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
}

/* 入场：供能段从左向右逐个展开（30ms stagger），其余条同步生长 */
.anim:not(.grown) .share span {
  transform: scaleX(0);
}

.share span {
  transform-origin: left center;
  transition: transform var(--dur-base) var(--ease-standard);
  transition-delay: calc(var(--i, 0) * 30ms);
}

.share-label {
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 供能占比并进宏量列表：克数是主、占比是次（色点与堆叠条同色） */
.macros .mpct {
  font-style: normal;
  /* 克数与占比是同一项的两半：4 就够，不再分出一档灰 */
  margin-left: var(--gap-tight);
  color: var(--text-2);
}

/* 占本日 */
.daylist {
  margin-top: var(--gap-tight);
}

.daylist li {
  /* 双行（标签行 + 条）行：10 上下 + 两行 ≈ 48 */
  padding: var(--sp-10) 0;
}

.daylist li + li {
  border-top: 0.5px solid var(--line);
}

.drow {
  /* 标签行与下方进度条之间 8 */
  margin-bottom: var(--gap-sm);
}

.dlabel {
  display: flex;
  align-items: center;
  /* 色点与名称：图标与文字左右 8 */
  gap: var(--gap-sm);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

/* 数字走中性色、颜色留给条：四个指标色当文字用对比度全不达标（同摄入总览的取舍） */
.dval {
  display: flex;
  align-items: baseline;
  /* 数值与单位：同一行最小呼吸 2 */
  gap: var(--gap-text);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.dunit {
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-3);
}

.dval em {
  font-style: normal;
  font-weight: var(--fw-regular);
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-left: var(--gap-tight);
}

.dpct {
  margin-left: var(--gap-tight);
  color: var(--text-2);
}

.bar {
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--line);
  overflow: hidden;
}

.fill {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.anim:not(.grown) .fill {
  clip-path: inset(0 100% 0 0 round var(--radius-full));
}

/* 删除入口：抽屉固定操作区，内容从下方滚过时不被顶走 */
.del {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  width: 100%;
  /* 高度是尺寸：底部操作区按钮统一 48（--row-h） */
  height: var(--row-h);
  border-radius: var(--radius-l);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
}
</style>
