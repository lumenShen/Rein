<script lang="ts">
import type { FoodFilter } from '@/types'

/** 全空条件（页面初始化 / 重置共用） */
export const EMPTY_FOOD_FILTER: FoodFilter = {
  kcalMin: null,
  kcalMax: null,
  proteinMin: null,
  carbMax: null,
  fatMax: null,
  sodiumMax: null,
}

/** 激活的条件条数（工具栏「筛选」chip 上的角标） */
export function countFoodFilter(f: FoodFilter): number {
  return [f.kcalMin, f.kcalMax, f.proteinMin, f.carbMax, f.fatMax, f.sodiumMax].filter(
    (v) => v !== null,
  ).length
}
</script>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
/* FoodFilter 类型已在上方普通 <script> 块导入，两个块共享模块作用域 */

/**
 * 筛选条件抽屉：所有改动只落在抽屉内的草稿态，「应用」才一次性提交给页面 ——
 * 列表只依赖已应用的条件对象，面板开着时（拖选、输入）食物列表零重渲染。
 */
const props = defineProps<{
  open: boolean
  /** 当前已应用的条件（打开抽屉时拷贝为草稿） */
  filter: FoodFilter
}>()

const emit = defineEmits<{
  apply: [filter: FoodFilter]
  reset: []
  close: []
}>()

const draft = reactive<FoodFilter>({ ...EMPTY_FOOD_FILTER })

/* 热量区间用文本输入中转：number 输入框清空时 v-model.number 会写 ''，提交时统一归一成 null */
const kcalMinText = ref<string | number>('')
const kcalMaxText = ref<string | number>('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    Object.assign(draft, props.filter)
    kcalMinText.value = props.filter.kcalMin === null ? '' : String(props.filter.kcalMin)
    kcalMaxText.value = props.filter.kcalMax === null ? '' : String(props.filter.kcalMax)
  },
)

interface Opt {
  label: string
  v: number
}

/** 各营养素的预设档：单边界（≥下限 / ≤上限），选中态 = 当前值精确命中 */
const DIMS: {
  key: 'proteinMin' | 'carbMax' | 'fatMax' | 'sodiumMax'
  label: string
  unit: string
  opts: Opt[]
}[] = [
  {
    key: 'proteinMin',
    label: '蛋白质',
    unit: 'g / 100 g',
    opts: [
      { label: '≥10g', v: 10 },
      { label: '≥20g', v: 20 },
      { label: '≥30g', v: 30 },
    ],
  },
  {
    key: 'carbMax',
    label: '碳水化合物',
    unit: 'g / 100 g',
    opts: [
      { label: '≤10g', v: 10 },
      { label: '≤25g', v: 25 },
      { label: '≤50g', v: 50 },
    ],
  },
  {
    key: 'fatMax',
    label: '脂肪',
    unit: 'g / 100 g',
    opts: [
      { label: '≤5g', v: 5 },
      { label: '≤15g', v: 15 },
      { label: '≤30g', v: 30 },
    ],
  },
  {
    key: 'sodiumMax',
    label: '钠',
    unit: 'mg / 100 g',
    opts: [
      { label: '≤120mg', v: 120 },
      { label: '≤600mg', v: 600 },
    ],
  },
]

/* 热量档自带单位（与其它维度同形态），基准口径只在分组头出现一次 */
const KCAL_OPTS: Opt[] = [
  { label: '≤100 大卡', v: 100 },
  { label: '≤200 大卡', v: 200 },
  { label: '≤350 大卡', v: 350 },
]

function setDim(key: 'proteinMin' | 'carbMax' | 'fatMax' | 'sodiumMax', v: number | null): void {
  draft[key] = v
}

function setKcalMax(v: number | null): void {
  draft.kcalMax = v
  kcalMaxText.value = v === null ? '' : String(v)
}

function toNum(v: string | number): number | null {
  const s = String(v).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function onApply(): void {
  emit('apply', { ...draft, kcalMin: toNum(kcalMinText.value), kcalMax: toNum(kcalMaxText.value) })
  emit('close')
}

function onReset(): void {
  Object.assign(draft, EMPTY_FOOD_FILTER)
  kcalMinText.value = ''
  kcalMaxText.value = ''
  emit('reset')
}
</script>

<template>
  <SheetModal :open="open" title="筛选条件" @close="emit('close')">
    <div class="fs">
      <!-- 热量：预设 chip + 自定义区间 -->
      <section class="dim">
        <header class="dhead">
          <h3>热量</h3>
          <span class="unit">大卡 / 100 g</span>
        </header>
        <div class="opts">
          <button class="opt" :class="{ on: draft.kcalMax === null }" @click="setKcalMax(null)">
            不限
          </button>
          <button
            v-for="o in KCAL_OPTS"
            :key="o.label"
            class="opt"
            :class="{ on: draft.kcalMax === o.v }"
            @click="setKcalMax(o.v)"
          >
            {{ o.label }}
          </button>
        </div>
        <div class="range">
          <input v-model.number="kcalMinText" type="number" inputmode="decimal" min="0" placeholder="热量下限">
          <span class="sep">至</span>
          <input v-model.number="kcalMaxText" type="number" inputmode="decimal" min="0" placeholder="热量上限">
        </div>
      </section>

      <!-- 营养素预设档 -->
      <section v-for="d in DIMS" :key="d.key" class="dim">
        <header class="dhead">
          <h3>{{ d.label }}</h3>
          <span class="unit">{{ d.unit }}</span>
        </header>
        <div class="opts">
          <button class="opt" :class="{ on: draft[d.key] === null }" @click="setDim(d.key, null)">
            不限
          </button>
          <button
            v-for="o in d.opts"
            :key="o.label"
            class="opt"
            :class="{ on: draft[d.key] === o.v }"
            @click="setDim(d.key, o.v)"
          >
            {{ o.label }}
          </button>
        </div>
      </section>

      <div class="acts">
        <button class="reset" @click="onReset">重置</button>
        <button class="apply" @click="onApply">应用条件</button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.dim + .dim {
  /* 筛选项分组之间 16：两组之间有明显边界（分组标题 + 选项组） */
  margin-top: var(--gap-lg);
}

.dhead {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
}

.dhead h3 {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.unit {
  /* 分组头的单位口径（「≥10」是 10 克还是 10 大卡全看它）：必读信息，不吃 11px 水印档 */
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.opts {
  display: flex;
  flex-wrap: wrap;
  /* 选项胶囊各自带底与影，属「有明确边界」的控件：换行上下 16、同行 8；
     上下这 16 同时给每枚胶囊的 ::after 热区（28 + 8×2 = 44）留出互不重叠的余量。
     与分组标题之间 8（标题与内容）。 */
  gap: var(--gap-lg) var(--gap-sm);
  margin-top: var(--gap-sm);
}

.opt {
  position: relative;
  /* 胶囊：纵向 6 + 12 字 ≈ 28（--control-sm），左右 12 */
  padding: var(--sp-6) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard);
}

/* 28 的胶囊命中区纵向撑到 44：视觉不变，热区补到规范下限（横向由胶囊宽度承担） */
.opt::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.opt.on {
  background: var(--accent);
  color: var(--on-accent);
}

.range {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
}

.range input {
  flex: 1;
  min-width: 0;
  /* 输入框规范：高 40（10 上下 + 14 字），圆角与按钮同档 20 */
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.sep {
  color: var(--text-3);
}

.acts {
  display: flex;
  /* 按钮组 8；与上方最后一组筛选项之间 24（底部操作区是独立区块） */
  gap: var(--gap-sm);
  margin-top: var(--gap-xl);
  padding-bottom: var(--safe-bottom);
}

.reset {
  padding: 0 var(--sp-20);
  /* 高度是尺寸不是间距：底部操作区两枚按钮同为 48 */
  height: var(--row-h);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.apply {
  flex: 1;
  height: var(--row-h);
  border-radius: var(--radius-l);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
  box-shadow: var(--shadow-float);
}
</style>
