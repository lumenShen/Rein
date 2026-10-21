<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ArrowDownUp, ChevronRight, Pencil, Search, SlidersHorizontal } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import FoodDetailDrawer from '@/components/diet/FoodDetailDrawer.vue'
import FoodPickerSheet from '@/components/diet/FoodPickerSheet.vue'
import FoodFilterSheet, { EMPTY_FOOD_FILTER, countFoodFilter } from '@/components/diet/FoodFilterSheet.vue'
import { dietService } from '@/services/dietService'
import { fmtNutrient } from '@/utils/format'
import { macroEnergyShare } from '@/utils/nutritionCalc'
import type { Food, FoodFilter, FoodUnit } from '@/types'

/**
 * 饮食库：全部食物浏览（搜索 + 分类 + 营养素筛选 + 排序），点行进详情抽屉；右下角「记录」悬浮按钮直接记一笔。
 * 条件面板全走弹层（排序 = AppMenu 菜单，筛选 = SheetModal 抽屉）且抽屉内是草稿态，
 * 列表只依赖已应用的 query/category/sort/applied —— 面板操作期间列表 DOM 零变化；
 * 列表项 v-memo 按 id 记忆，重排/重筛时复用节点跳过 patch。
 */
const all = ref<Food[]>([])
const ready = ref(false)
const query = ref('')
const category = ref<string | null>(null)

/* ---------- 排序（AppMenu bind 式锚定菜单） ---------- */
type SortKey =
  | 'default'
  | 'kcal_desc'
  | 'kcal_asc'
  | 'protein_desc'
  | 'protein_asc'
  | 'carb_desc'
  | 'carb_asc'
  | 'fat_desc'
  | 'fat_asc'

const SORT_LABELS: Record<Exclude<SortKey, 'default'>, string> = {
  kcal_desc: '热量 高→低',
  kcal_asc: '热量 低→高',
  protein_desc: '蛋白质 高→低',
  protein_asc: '蛋白质 低→高',
  carb_desc: '碳水 高→低',
  carb_asc: '碳水 低→高',
  fat_desc: '脂肪 高→低',
  fat_asc: '脂肪 低→高',
}

const SORTERS: Record<Exclude<SortKey, 'default'>, (a: Food, b: Food) => number> = {
  kcal_desc: (a, b) => b.kcal - a.kcal,
  kcal_asc: (a, b) => a.kcal - b.kcal,
  protein_desc: (a, b) => b.protein - a.protein,
  protein_asc: (a, b) => a.protein - b.protein,
  carb_desc: (a, b) => b.carb - a.carb,
  carb_asc: (a, b) => a.carb - b.carb,
  fat_desc: (a, b) => b.fat - a.fat,
  fat_asc: (a, b) => a.fat - b.fat,
}

const sortKey = ref<SortKey>('default')
const sortOpen = ref(false)
const sortBtn = ref<HTMLElement | null>(null)

const sortActions: MenuItem[] = [
  { label: '默认（按库序）', value: 'default' },
  {
    label: '热量',
    value: 'g-kcal',
    children: [
      { label: '高 → 低', value: 'kcal_desc' },
      { label: '低 → 高', value: 'kcal_asc' },
    ],
  },
  {
    label: '蛋白质',
    value: 'g-protein',
    children: [
      { label: '高 → 低', value: 'protein_desc' },
      { label: '低 → 高', value: 'protein_asc' },
    ],
  },
  {
    label: '碳水化合物',
    value: 'g-carb',
    children: [
      { label: '高 → 低', value: 'carb_desc' },
      { label: '低 → 高', value: 'carb_asc' },
    ],
  },
  {
    label: '脂肪',
    value: 'g-fat',
    children: [
      { label: '高 → 低', value: 'fat_desc' },
      { label: '低 → 高', value: 'fat_asc' },
    ],
  },
]

function openSort(e: MouseEvent): void {
  sortBtn.value = e.currentTarget as HTMLElement
  sortOpen.value = true
}

function onSortSelect(v: string): void {
  sortKey.value = v as SortKey
}

const sortLabel = computed(() =>
  sortKey.value === 'default' ? '排序' : SORT_LABELS[sortKey.value],
)

/* ---------- 筛选（SheetModal 抽屉 + 草稿态） ---------- */
const appliedFilter = ref<FoodFilter>({ ...EMPTY_FOOD_FILTER })
const filterOpen = ref(false)
const filterCount = computed(() => countFoodFilter(appliedFilter.value))

function onApplyFilter(f: FoodFilter): void {
  appliedFilter.value = f
}

function onResetFilter(): void {
  appliedFilter.value = { ...EMPTY_FOOD_FILTER }
}

const detailOpen = ref(false)
const detailFood = ref<Food | null>(null)
const recordOpen = ref(false)
const recordFood = ref<Food | null>(null)

function openFood(f: Food): void {
  detailFood.value = f
  detailOpen.value = true
}

function onAdd(): void {
  recordFood.value = null
  recordOpen.value = true
}

/** 抽屉内「记录这一食物」：关闭抽屉并带上该食物进入数量/餐次 */
function onRecord(): void {
  recordFood.value = detailFood.value
  detailOpen.value = false
  recordOpen.value = true
}

/* 库量级数千：默认只渲染首屏一批，避免一次性建几千个 DOM 节点 */
const CAP = 150
const expanded = ref(false)
watch([query, category, sortKey, appliedFilter], () => (expanded.value = false))

onMounted(async () => {
  all.value = await dietService.listFoods(undefined, null, 9999)
  ready.value = true
})

const categories = computed(() => [...new Set(all.value.map((f) => f.category ?? '其他'))])

const list = computed(() => {
  const q = query.value.trim().toLowerCase()
  const fl = appliedFilter.value
  const res = all.value.filter((f) => {
    if (category.value && (f.category ?? '其他') !== category.value) return false
    if (q && !f.name.toLowerCase().includes(q) && !(f.category ?? '').toLowerCase().includes(q))
      return false
    if (fl.kcalMin !== null && f.kcal < fl.kcalMin) return false
    if (fl.kcalMax !== null && f.kcal > fl.kcalMax) return false
    if (fl.proteinMin !== null && f.protein < fl.proteinMin) return false
    if (fl.carbMax !== null && f.carb > fl.carbMax) return false
    if (fl.fatMax !== null && f.fat > fl.fatMax) return false
    if (fl.sodiumMax !== null && f.sodiumMg > fl.sodiumMax) return false
    return true
  })
  return sortKey.value === 'default' ? res : [...res].sort(SORTERS[sortKey.value])
})

const shown = computed(() => (expanded.value ? list.value : list.value.slice(0, CAP)))

/* 宏量供能占比（蛋白/碳水 ×4、脂肪 ×9）：三段迷你条，口径与详情抽屉同源 */
function macroSegs(f: Food): { color: string; pct: number }[] {
  return macroEnergyShare(f.protein, f.carb, f.fat).map((s) => ({
    color: `var(${s.colorVar})`,
    pct: s.pct,
  }))
}

/** 份量参考：份名与克数必须取自同一档（默认单位按名称匹配，匹配不到退回第一档）——
 *  分别取会渲染出「1 碗 ≈ 150 g」这种碗名对不上克数的组合 */
function unitOf(f: Food): FoodUnit | null {
  if (!f.units.length) return null
  return f.units.find((u) => u.name === f.defaultUnit) ?? f.units[0]!
}
</script>

<template>
  <div class="page">
    <PageHeader back title="饮食库" :subtitle="`共 ${all.length} 种食物`">
      <!-- 「数值为每 100 克」是口径不是计数：收进页头帮助入口，副标题只留库量 -->
      <template #action>
        <span class="hdr-btn">
          <InfoHint
            title="数值口径"
            content="本页与食物详情里的热量、蛋白、碳水、脂肪都按每 100 克计（/100 g）。列表中的「1 个 ≈ 150 g」是常见份量参考，不是推荐摄入量。"
          />
        </span>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <div class="finder row">
      <Search :size="17" class="t-3" />
      <input v-model="query" type="text" placeholder="搜索食物或分类，如「主食」「牛奶」">
    </div>

    <!-- 分类筛选 -->
    <ul v-if="categories.length" class="cats row">
      <li>
        <button class="chip" :class="{ on: category === null }" @click="category = null">全部</button>
      </li>
      <li v-for="c in categories" :key="c">
        <button class="chip" :class="{ on: category === c }" @click="category = c">{{ c }}</button>
      </li>
    </ul>

    <!-- 排序 / 筛选工具行：面板本身都是弹层，这里只留两颗触发 chip -->
    <div class="tools row">
      <button class="chip tool" :class="{ on: sortKey !== 'default' }" @click="openSort">
        <ArrowDownUp :size="13" :stroke-width="2.2" />
        {{ sortLabel }}
      </button>
      <button class="chip tool" :class="{ on: filterCount > 0 }" @click="filterOpen = true">
        <SlidersHorizontal :size="13" :stroke-width="2.2" />
        筛选<template v-if="filterCount"> · {{ filterCount }} 项条件</template>
      </button>
      <span v-if="filterCount > 0" class="meta num t-3">符合 {{ list.length }} 项</span>
    </div>

    <!-- d-full：这张卡通栏（壳层默认把 .page 的直接子级 .card 压成半栏）；列表在卡**内部**摊成多栏 -->
    <section class="card d-full foods-card">
      <ul v-if="list.length" class="foods d-list">
        <!-- v-memo：条目内容只依赖 f，重排/重筛时同 id 节点直接复用、跳过 patch -->
        <li v-for="f in shown" :key="f.id" v-memo="[f.id]">
          <button class="row item" @click="openFood(f)">
            <span class="flex-1">
              <b>{{ f.name }}</b>
              <small>
                <PillChip tone="muted" size="sm">{{ f.category ?? '其他' }}</PillChip>
                <template v-if="unitOf(f)">份量 1 {{ unitOf(f)!.name }} ≈ {{ unitOf(f)!.grams }} g</template>
              </small>
            </span>
            <span class="nutr">
              <span class="num kcal">{{ Math.round(f.kcal) }}<em>大卡</em></span>
              <span v-if="macroSegs(f).length" class="mbar">
                <i v-for="(s, i) in macroSegs(f)" :key="i" :style="{ flex: s.pct, background: s.color }" />
              </span>
              <span class="num mline">
                <span><i class="dot" style="background: var(--c-protein)" />{{ fmtNutrient(f.protein) }}g</span>
                <span><i class="dot" style="background: var(--c-carb)" />{{ fmtNutrient(f.carb) }}g</span>
                <span><i class="dot" style="background: var(--c-fat)" />{{ fmtNutrient(f.fat) }}g</span>
              </span>
            </span>
            <ChevronRight :size="16" class="t-3 chev" />
          </button>
        </li>
      </ul>
      <p v-if="list.length > shown.length" class="count-line t-3">
        已显示 <span class="num">{{ shown.length }}</span> / <span class="num">{{ list.length }}</span>
      </p>
      <button v-if="list.length > shown.length" class="more t-2" @click="expanded = true">
        显示全部 {{ list.length }} 项
      </button>
      <EmptyState v-else-if="ready" :icon="Search" title="没有匹配的食物" hint="换个关键词或筛选条件试试" />
    </section>

    <!-- 排序菜单：bind 式锚定弹出（Teleport 到 body），选中后 AppMenu 自行收起 -->
    <AppMenu
      :open="sortOpen"
      :actions="sortActions"
      :anchor="sortBtn"
      title="排序方式"
      @close="sortOpen = false"
      @select="onSortSelect"
    />

    <!-- 筛选抽屉：草稿态，「应用」才写回 appliedFilter（列表一次性重算） -->
    <FoodFilterSheet
      :open="filterOpen"
      :filter="appliedFilter"
      @apply="onApplyFilter"
      @reset="onResetFilter"
      @close="filterOpen = false"
    />

    <!-- 右下角悬浮按钮：快速记一笔（Teleport 出页面层：translate 会改 fixed 后代的包含块） -->
    <Teleport to="body">
      <button class="fab row center" aria-label="记录食物" @click="onAdd">
        <Pencil :size="18" :stroke-width="2.4" />
        <span>记录</span>
      </button>
    </Teleport>

    <!-- 详情抽屉（Teleport；保证页面单根） -->
    <FoodDetailDrawer :open="detailOpen" :food="detailFood" @close="detailOpen = false" @record="onRecord" />

    <!-- 记录弹层：无食物 = 搜索选择；抽屉记录 = 带入食物直接进数量/餐次 -->
    <FoodPickerSheet :open="recordOpen" :initial-food="recordFood" @close="recordOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部沿用全站页头节奏的一格 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.finder {
  gap: var(--gap-sm);
  /* 搜索栏当输入框：上下 10（40 档）、左右 16 */
  padding: var(--sp-10) var(--pad-card);
  /* 输入框是**控件层**不是卡片层：《圆角参数》20vp 给按钮/菜单/输入，
     16 是通知卡与内容容器那一档。与筛选抽屉里的输入框（--radius-l）同档。 */
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.finder input {
  flex: 1;
  font-size: var(--fs-subhead);
}

.cats {
  /* 分类胶囊是**有明确边界**的控件（各自带底与影）：换行时上下 16、同一行内 8。
     上下留 16 也是给每枚胶囊的 ::after 热区留出互不重叠的余量（28 + 8×2 = 44）。 */
  gap: var(--gap-lg) var(--gap-sm);
  flex-wrap: wrap;
  margin-top: var(--sp-12);
}

.chip {
  position: relative;
  /* 胶囊：上下 6 + 12 字 ≈ 28（--control-sm），左右 12 */
  padding: var(--sp-6) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 28 的胶囊命中区纵向撑到 44（横向由胶囊自身宽度承担，均 ≥ 44）：
   视觉尺寸不变，只把看不见的热区补到规范下限。 */
.chip::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.chip.on {
  background: var(--accent);
  color: var(--on-accent);
}

.tools {
  /* 排序 / 筛选两颗胶囊同样是「有明确边界」的控件：换行 16、同行 8（热区理由见 .chip） */
  gap: var(--gap-lg) var(--gap-sm);
  flex-wrap: wrap;
  margin-top: var(--gap-sm);
}

.tool {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
}

.meta {
  margin-left: auto;
  font-size: var(--fs-caption);
}

.card {
  /* 与筛选区 12（卡间距）；行自带上下内距，卡只留 6 的顶底余量 + 16 左右 */
  margin-top: var(--gap-md);
  padding: var(--sp-6) var(--pad-card);
}

.item {
  width: 100%;
  text-align: left;
  /* 名称列与右侧营养块：12 */
  gap: var(--gap-md);
  /* 双行食物行（名称 + 分类/单位）按 64 档：12 上下 + 两行文本 */
  padding: var(--sp-12) 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.item b {
  display: block;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.item small {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-tight) var(--sp-6);
  /* 分类与单位是选食物时的核对依据 → --text-2 */
  color: var(--text-2);
  font-size: var(--fs-caption);
}

/* 右侧营养块：大卡 + 供能占比迷你条 + 宏量点阵，纵向右对齐 */
.nutr {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--gap-tight);
}

.kcal {
  /* 每 100 克热量是这一行的主数值：与食物名同档（16）但更重，单位仍落 12 档。
     此前 14 比名字（16）还小，扫读时先看到名字、最后才看到「多少大卡」。 */
  font-weight: var(--fw-bold);
  font-size: var(--fs-headline);
  line-height: var(--lh-title);
}

.kcal em {
  font-style: normal;
  /* 「大卡」是单位、决定这个数的量级，必须读出来：落 caption 档、浅一色，
     与 16 的数值拉开两档（数值主、单位辅） */
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-2);
  margin-left: var(--gap-tight);
}

.mbar {
  display: flex;
  /* 三段供能条之间 2（同一根条上的缝，再大会断成三根） */
  gap: var(--gap-text);
  width: 84px;
  height: 4px;
  border-radius: var(--radius-full);
  overflow: hidden;
}

.mbar i {
  display: block;
  height: 100%;
}

.mline {
  display: flex;
  gap: var(--gap-sm);
  /* 三段宏量克数是「这一份含多少蛋白/碳水/脂肪」，是要读的数，不吃 11px */
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mline span {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: none;
}

.chev {
  flex: none;
}

.more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  /* 加载更多是整行文字按钮：上下内距之外再保 44 的命中区（--hit-min），
     否则 12 字一行只有约 36px 高，贴着列表最后一行时容易点空。 */
  min-height: var(--hit-min);
  padding: var(--sp-12) 0 var(--sp-6);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

/* 进度单独一行：按钮只留动作，计数不掺进按钮文案（已显示 N / 总数） */
.count-line {
  padding-top: var(--sp-12);
  text-align: center;
  font-size: var(--fs-caption);
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   这张卡装着整个饮食库（2722 条）。壳层「.page 的直接子级 .card 占半栏」的规则会把它
   压成 480px，右半屏整块空着 —— 所以要通栏的**是卡片**，多栏摊到卡**内部**去。

   通栏由模板上的 .d-full 声明（规则在 base.css 的「桌面工作台 · 栅格」里）。 */


/* 卡内摊成三栏流：一条只有「食物名 + 分类/单位 + 每 100 克热量」，480px 宽度是浪费。
   用多栏流（columns）而不是 grid —— 分类/单位那行长短不一，grid 会按最高的一条撑行。
   栏数交给 .d-list 的 --d-cols。 */
.desk-main .foods {
  --d-cols: 3;
}

/* 栏变窄之后，行与行之间只剩留白，扫读时容易串行：桌面给每条加一条发丝下边线
   （移动端维持原来的纯留白分隔，观感不变）。 */
.desk-main .foods .item {
  border-bottom: 0.5px solid var(--line);
}

/* 「记录」悬浮按钮（TabBar 之上，锚定页面右缘） */
.fab {
  position: fixed;
  /* 右缘跟随页面留白（手机 16 / 桌面 40），底部让开悬浮 Dock 再收一格 14：
     与页面四边的留白同源，换壳（窄栏 → 桌面）时自动对齐 */
  right: max(var(--page-pad-x), calc(50% - var(--frame-max) / 2 + var(--page-pad-x)));
  bottom: calc(var(--dock-top) + var(--sp-14));
  z-index: 50;
  gap: var(--sp-6);
  padding: var(--sp-12) var(--sp-20);
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  box-shadow: var(--shadow-float);
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.fab:active {
  transform: scale(0.95);
}
</style>
