<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AlertTriangle, LoaderCircle } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_ORDER } from '@/config/domain'
import { dietService } from '@/services/dietService'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import { todayStr } from '@/utils/date'
import type { Food, MealType } from '@/types'
import type { RecipeItem, RecipeTemplate } from '@/utils/recipeFilter'

const props = defineProps<{ open: boolean; recipe: RecipeTemplate | null }>()
const emit = defineEmits<{ close: []; logged: [] }>()

const diet = useDietStore()
const nutrition = useNutritionStore()
const { toast } = useToast()

interface Ingredient {
  item: RecipeItem
  food: Food | null
  baseGrams: number
}

const ingredients = ref<Ingredient[]>([])
const loading = ref(false)
const loadError = ref('')
let loadSeq = 0
const servings = ref(1)
const mealType = ref<MealType>('breakfast')
const adding = ref(false)
const addError = ref('')

function gramsOf(item: RecipeItem, food: Food | null): number {
  if (item.grams != null) return item.grams
  if (item.unitGrams != null) return item.unitGrams * (item.count ?? 1)
  const unit = food?.units.find((u) => u.name === item.unit)
  return (unit?.grams ?? 100) * (item.count ?? 1)
}

async function load(): Promise<void> {
  const recipe = props.recipe
  const seq = ++loadSeq
  if (!recipe) {
    ingredients.value = []
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  addError.value = ''
  servings.value = 1
  mealType.value = recipe.mealType
  ingredients.value = recipe.items.map((item) => ({ item, food: null, baseGrams: gramsOf(item, null) }))
  const loaded = await Promise.all(
    recipe.items.map(async (item): Promise<Ingredient> => {
      try {
        const hits = await dietService.searchFoodsFuzzy(item.food, 5)
        const food = hits.find((f) => f.name === item.food) ?? hits[0] ?? null
        return { item, food, baseGrams: gramsOf(item, food) }
      } catch {
        return { item, food: null, baseGrams: gramsOf(item, null) }
      }
    }),
  )
  if (seq !== loadSeq) return
  ingredients.value = loaded
  if (loaded.some((it) => !it.food)) loadError.value = '有食材没匹配到食物库，请先补全后再加入饮食'
  loading.value = false
}

watch(
  () => [props.open, props.recipe?.id] as const,
  ([open]) => {
    if (open) void load()
  },
  { immediate: true },
)

const totalKcal = computed(() =>
  Math.round((props.recipe?.baseKcal ?? 0) * servings.value),
)
const totalProtein = computed(() =>
  Math.round((props.recipe?.baseProtein ?? 0) * servings.value),
)
const canAdd = computed(
  () => !loading.value && !adding.value && !loadError.value && ingredients.value.length > 0 && ingredients.value.every((it) => it.food && it.baseGrams > 0),
)

function requestClose(): void {
  if (!adding.value) emit('close')
}

async function addToDiet(): Promise<void> {
  const recipe = props.recipe
  if (!recipe || !canAdd.value) return
  adding.value = true
  addError.value = ''
  const date = todayStr()
  const created: number[] = []
  try {
    try {
      for (const ing of ingredients.value) {
        if (!ing.food) continue
        const meal = await dietService.logMeal({
          foodId: ing.food.id,
          date,
          mealType: mealType.value,
          quantityMode: 'grams',
          grams: Math.max(1, Math.round(ing.baseGrams * servings.value)),
          units: null,
          unitName: null,
          source: 'manual',
          note: `食谱：${recipe.name}`,
        })
        created.push(meal.id)
      }
    } catch (e) {
      const failed: number[] = []
      for (const id of created.reverse()) {
        try {
          await dietService.deleteMeal(id)
        } catch {
          failed.push(id)
        }
      }
      await Promise.allSettled([diet.load(date), nutrition.loadSummary(date)])
      addError.value = failed.length
        ? `加入失败；已写入 ${created.length} 项，其中 ${failed.length} 项撤回失败，请到饮食历史检查`
        : created.length
          ? '加入失败，本次写入已撤回，可以重试'
          : e instanceof Error
            ? e.message
            : '加入失败，请重试'
      return
    }

    const refreshed = await Promise.allSettled([diet.load(date), nutrition.loadSummary(date)])
    const ok = refreshed.every((r) => r.status === 'fulfilled')
    toast(
      ok
        ? `已把「${recipe.name}」加入${MEAL_LABELS[mealType.value]}`
        : `已把「${recipe.name}」加入${MEAL_LABELS[mealType.value]}，但摘要刷新失败`,
    )
    emit('logged')
    emit('close')
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" :title="recipe?.name ?? '食谱详情'" initial-snap="large" @close="requestClose">
    <div v-if="recipe" class="recipe">
      <div class="summary row between">
        <div class="col">
          <b class="num">{{ totalKcal }}<small>大卡</small></b>
          <span class="t-3">蛋白 {{ totalProtein }}g · 碳水 {{ Math.round(recipe.baseCarb * servings) }}g · 脂肪 {{ Math.round(recipe.baseFat * servings) }}g</span>
        </div>
        <span class="tag">{{ MEAL_LABELS[recipe.mealType] }}</span>
      </div>

      <p v-if="recipe.allergens.length" class="allergens t-3">
        过敏原：{{ recipe.allergens.join('、') }}
      </p>

      <h3 class="sec">食材</h3>
      <p v-if="loading" class="state row">
        <LoaderCircle :size="15" class="spin" /> 正在匹配食物库…
      </p>
      <ul v-else class="items">
        <li v-for="(ing, i) in ingredients" :key="`${ing.item.food}-${i}`" class="item row between">
          <span class="col">
            <b>{{ ing.item.food }}</b>
            <small class="t-3">{{ ing.food?.name ?? '未匹配到食物库' }}</small>
          </span>
          <span class="num">{{ Math.round(ing.baseGrams * servings) }}g</span>
        </li>
      </ul>

      <p v-if="loadError" class="error" role="alert">
        <AlertTriangle :size="15" />{{ loadError }}
      </p>
      <p v-if="addError" class="error" role="alert" data-testid="recipe-add-error">
        <AlertTriangle :size="15" />{{ addError }}
      </p>

      <NumberStepper v-model="servings" label="份数" unit="份" :step="0.5" :min="0.5" :max="10" :decimals="1" />
      <SegmentedControl
        v-model="mealType"
        :options="MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))"
      />
    </div>

    <template #footer>
      <button class="primary wide" :disabled="!canAdd" data-testid="recipe-add" @click="addToDiet">
        {{ adding ? '正在加入…' : `加入${MEAL_LABELS[mealType]}` }}
      </button>
    </template>
  </SheetModal>
</template>

<style scoped>
.recipe {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.summary {
  align-items: flex-start;
  gap: var(--gap-md);
}

.summary b {
  display: block;
  font-size: var(--fs-title2);
  line-height: 1;
}

.summary b small {
  margin-left: var(--sp-4);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.tag {
  flex: none;
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
}

.allergens,
.state,
.error {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.allergens,
.state {
  color: var(--text-2);
}

.error {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.error svg {
  flex: none;
  margin-top: var(--sp-2);
}

.sec {
  margin: var(--sp-4) 0 0;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.items {
  display: flex;
  flex-direction: column;
}

.item {
  gap: var(--gap-md);
  min-height: var(--row-h-double);
  border-bottom: 0.5px solid var(--line);
}

.item:last-child {
  border-bottom: 0;
}

.item b {
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
}

.item small {
  display: block;
  margin-top: var(--gap-text);
}

.item > .num {
  flex: none;
  color: var(--text-2);
  font-size: var(--fs-caption);
}

.wide {
  width: 100%;
}
</style>
