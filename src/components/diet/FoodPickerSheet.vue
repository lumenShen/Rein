<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, Minus, Plus, Search } from 'lucide-vue-next'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_ORDER } from '@/config/domain'
import { dietService } from '@/services/dietService'
import { useDietStore } from '@/stores/diet'
import { useToast } from '@/composables/useToast'
import { todayStr } from '@/utils/date'
import type { Food, MealType } from '@/types'

/**
 * 食物库选择器：搜索 → 选食物 → 克重 / 份量 → 餐次 → 写入当日记录。
 *  initialFood：外部已选定食物时（如食品详情页）跳过搜索，直接进数量/餐次。
 *  selectOnly：纯选择模式（识别结果换匹配用）——点结果即回传 pick 并关闭，不落库。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    initialFood?: Food | null
    selectOnly?: boolean
    title?: string
    /** 预选餐次（智能添加跟随其餐次选择）；缺省早餐 */
    defaultMeal?: MealType | null
  }>(),
  { initialFood: null, selectOnly: false, title: '添加食物' },
)

const emit = defineEmits<{
  close: []
  /** selectOnly 模式：选中某个食物 */
  pick: [Food]
}>()

const diet = useDietStore()
const { toast } = useToast()

/* 外部带食物打开（详情页「记录」）：隐藏搜索与返回，纯记录面板 */
const external = computed(() => !!props.initialFood)

const query = ref('')
const results = ref<Food[]>([])
const selected = ref<Food | null>(null)

const mode = ref<'grams' | 'unit'>('grams')
const grams = ref(100)
const unitName = ref('')
const unitCount = ref(1)
const mealType = ref<MealType>('breakfast')

/* 打开时重置；带 initialFood 则直接进入数量/餐次 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    results.value = []
    selected.value = null
    mealType.value = props.defaultMeal ?? 'breakfast'
    if (props.initialFood) pick(props.initialFood)
    else void search()
  },
)

let timer: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void search(), 220)
})

async function search(): Promise<void> {
  const q = query.value.trim()
  // 有输入走 Rust 模糊搜索（按相似度排序），空输入回退常用列表
  results.value = q ? await dietService.searchFoodsFuzzy(q, 30) : await dietService.listFoods()
}

function pick(f: Food): void {
  if (props.selectOnly) {
    emit('pick', f)
    emit('close')
    return
  }
  selected.value = f
  const hasUnits = f.units.length > 0
  mode.value = hasUnits ? 'unit' : 'grams'
  unitName.value = f.defaultUnit ?? f.units[0]?.name ?? ''
  unitCount.value = 1
  grams.value = 100
}

const effGrams = computed(() => {
  if (!selected.value) return 0
  if (mode.value === 'grams') return Math.max(0, grams.value)
  const u = selected.value.units.find((x) => x.name === unitName.value)
  return Math.round(Math.max(0, unitCount.value) * (u?.grams ?? 100))
})

const kcalPreview = computed(() =>
  selected.value ? Math.round((selected.value.kcal * effGrams.value) / 100) : 0,
)

const adding = ref(false)

async function confirmAdd(): Promise<void> {
  const f = selected.value
  if (!f || effGrams.value <= 0 || adding.value) return
  adding.value = true
  try {
    await diet.add({
      foodId: f.id,
      date: todayStr(),
      mealType: mealType.value,
      quantityMode: mode.value,
      grams: effGrams.value,
      units: mode.value === 'unit' ? unitCount.value : null,
      unitName: mode.value === 'unit' ? unitName.value : null,
      source: 'search',
      note: null,
    })
    toast(`已记录 ${f.name} ${kcalPreview.value} 大卡`)
    selected.value = null
    emit('close')
  } finally {
    adding.value = false
  }
}

function bump(delta: number): void {
  if (mode.value === 'grams') grams.value = Math.max(0, grams.value + delta)
  else unitCount.value = Math.max(0, Math.round((unitCount.value + delta) * 2) / 2)
}
</script>

<template>
  <SheetModal :open :title @close="emit('close')">
    <!-- 搜索（外部带食物时隐藏） -->
    <div v-if="!external" class="finder row">
      <Search :size="17" class="t-3" />
      <input v-model="query" type="text" placeholder="搜索食物或分类，如「主食」「牛奶」">
    </div>

    <!-- 结果列表 -->
    <ul v-if="!selected" class="list" data-rubber-self>
      <li v-for="f in results" :key="f.id">
        <button class="row item" @click="pick(f)">
          <span class="flex-1">
            <b>{{ f.name }}</b>
            <small>{{ f.category ?? '其他' }}<template v-if="f.units.length"> · 1{{ f.defaultUnit ?? f.units[0]!.name }}≈{{ f.units[0]!.grams }}g</template></small>
          </span>
          <span class="num kcal">{{ f.kcal }}<em>大卡 / 100 g</em></span>
        </button>
      </li>
      <li v-if="results.length === 0" class="none t-3">没有匹配的食物</li>
    </ul>

    <!-- 数量与餐次 -->
    <div v-else class="detail">
      <button v-if="!external" class="back row" @click="selected = null">
        <ChevronLeft :size="18" /> 返回搜索
      </button>

      <header class="food-head">
        <h3>{{ selected.name }}</h3>
        <!-- 每 100g 口径：热量是主数值，三大宏量降为次要读数，竖线分隔 -->
        <p class="fmacros">
          <b class="num fkcal">{{ selected.kcal }}<em>大卡 / 100 g</em></b>
          <span class="fmitem">蛋白 {{ selected.protein }}g</span>
          <span class="fmitem">碳水 {{ selected.carb }}g</span>
          <span class="fmitem">脂肪 {{ selected.fat }}g</span>
        </p>
      </header>

      <SegmentedControl
        v-if="selected.units.length > 0"
        v-model="mode"
        :options="[
          { value: 'grams', label: '按克重' },
          { value: 'unit', label: '按份' },
        ]"
      />

      <div v-if="mode === 'grams'" class="stepper row between">
        <button aria-label="减少" @click="bump(-50)"><Minus :size="18" /></button>
        <span class="num"><b>{{ grams }}</b><em class="qunit">g</em></span>
        <button aria-label="增加" @click="bump(50)"><Plus :size="18" /></button>
      </div>

      <template v-else>
        <ul class="units row">
          <li v-for="u in selected.units" :key="u.name">
            <button class="uchip" :class="{ on: u.name === unitName }" @click="unitName = u.name">
              {{ u.name }}<small class="num">{{ u.grams }}g</small>
            </button>
          </li>
        </ul>
        <div class="stepper row between">
          <button aria-label="减少" @click="bump(-0.5)"><Minus :size="18" /></button>
          <span class="num"><b>{{ unitCount }}</b><em class="qunit">{{ unitName }}</em></span>
          <button aria-label="增加" @click="bump(0.5)"><Plus :size="18" /></button>
        </div>
      </template>

      <SegmentedControl
        v-model="mealType"
        :options="MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))"
      />

      <div class="row preview between">
        <span>约 <b class="num">{{ kcalPreview }}</b> 大卡</span>
        <button class="add" :disabled="adding || effGrams <= 0" @click="confirmAdd">加入{{ MEAL_LABELS[mealType] }}</button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.finder {
  gap: var(--gap-sm);
  /* 搜索栏当输入框处理：高 40（10 上下 + 14 字），左右 16；
     圆角取控件档 20（与筛选抽屉里的输入框、按钮同档，卡片才是 16） */
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.finder input {
  flex: 1;
  font-size: var(--fs-subhead);
}

.list {
  margin-top: var(--gap-sm);
  max-height: 46dvh;
  overflow-y: auto;
}

.item {
  width: 100%;
  text-align: left;
  /* 名称列与右侧热量：12（两列内容要分开读） */
  gap: var(--gap-md);
  /* 双行食物行：12 上下 + 两行文本 ≈ 64 档 */
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
  /* 分类与「每 100g」是选食物时要看的依据 → --text-2 */
  color: var(--text-2);
  font-size: var(--fs-caption);
}

.kcal {
  font-weight: var(--fw-bold);
  font-size: var(--fs-callout);
  /* 选食物时最该比的热量：主数值走最深一档 */
  color: var(--text-1);
}

.kcal em {
  font-style: normal;
  /* 单位是必读信息（「167」读不出是什么量），不吃 11px 水印档；
     数值与单位是同一行内的最小一对，左右留 4（--gap-tight） */
  margin-left: var(--gap-tight);
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-2);
}

.none {
  text-align: center;
  padding: var(--sp-28) 0;
  font-size: var(--fs-subhead);
}

.detail {
  display: flex;
  flex-direction: column;
  /* 详情里的四段（返回 / 头部 / 步进 / 单位）是卡内区块：12 */
  gap: var(--gap-md);
  margin-top: var(--gap-sm);
}

.back {
  position: relative;
  align-self: flex-start;
  gap: var(--gap-text);
  color: var(--accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  /* 负 margin 把「‹ 返回」的字面对齐到内容左缘，符号本身自带空白 */
  margin-left: calc(-1 * var(--sp-6));
}

/* 文字返回键只有一行高：上下各扩 12，命中区补到 44（下方是标题，不会误触控件） */
.back::after {
  content: '';
  position: absolute;
  inset: -12px 0;
}

.food-head h3 {
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.food-head p {
  font-size: var(--fs-caption);
  margin: var(--gap-text) 0 var(--gap-tight);
  color: var(--text-2);
}

/* 详情头：每 100g 热量提为主数值，宏量读数竖线分隔、降一档灰 */
.fkcal {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.fkcal em {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  margin-left: var(--gap-tight);
}

.fmitem {
  margin-left: var(--gap-sm);
}

.fmitem + .fmitem::before {
  content: '|';
  margin-right: var(--gap-sm);
  color: var(--text-3);
}

.stepper {
  padding: var(--gap-sm) var(--sp-6);
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.stepper button {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  display: flex;
  align-items: center;
  justify-content: center;
}

.stepper b {
  font-size: var(--fs-title1);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
}

/* 步进器的单位与被调整的数值分开排：数值 24 bold，单位 14 半粗 + 次档灰。
   此前两者同为继承字号，「1200 g」读起来像一个数，单位也不参与层级。 */
.qunit {
  margin-left: var(--gap-tight);
  font-style: normal;
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.units {
  /* 单位胶囊各自带底：换行上下 16（也是热区余量）、同行 8 */
  gap: var(--gap-lg) var(--gap-sm);
  flex-wrap: wrap;
}

.uchip {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 单字单位（「个」「碗」）也不该缩成一条窄条：视觉至少 44 宽，
     命中区再纵向补 12 到 44（高 34 + 6×2） */
  min-width: var(--hit-min);
  /* 单位胶囊：上下 8、左右 12（与其它胶囊同一档） */
  padding: var(--gap-sm) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.uchip::after {
  content: '';
  position: absolute;
  inset: -6px 0;
}

.uchip small {
  margin-left: var(--gap-tight);
  color: var(--text-3);
  font-weight: var(--fw-regular);
}

.uchip.on {
  background: var(--accent);
  color: var(--on-accent);
}

.uchip.on small {
  color: color-mix(in srgb, var(--on-accent) 75%, transparent);
}

.preview span {
  font-size: var(--fs-body);
  color: var(--text-2);
}

.preview b {
  color: var(--text-1);
  font-weight: var(--fw-bold);
}

.add {
  /* 主操作按钮：高 48 档（12 上下 + 16 字），左右 20 */
  padding: var(--sp-12) var(--sp-20);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.add:disabled {
  opacity: var(--disabled-opacity);
}
</style>
