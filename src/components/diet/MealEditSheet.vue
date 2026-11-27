<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, LoaderCircle, Utensils } from 'lucide-vue-next'

import FoodPickerSheet from '@/components/diet/FoodPickerSheet.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_ORDER, fmtGrams } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { dietService } from '@/services/dietService'
import { todayStr } from '@/utils/date'
import type { Food, MealLog, MealType, QuantityMode } from '@/types'

const props = defineProps<{ open: boolean; log: MealLog | null }>()
const emit = defineEmits<{ close: []; updated: [log: MealLog] }>()
const { toast } = useToast()

const food = ref<Food | null>(null)
const date = ref(todayStr())
const mealType = ref<MealType>('breakfast')
const mode = ref<QuantityMode>('grams')
const grams = ref(100)
const unitName = ref('')
const unitCount = ref(1)
const note = ref('')
const pickerOpen = ref(false)
const saving = ref(false)

watch(
  () => [props.open, props.log?.id] as const,
  ([open, id]) => {
    if (!open || !props.log || !id) return
    const log = props.log
    const validUnit = log.food?.units.find((u) => u.name === log.unitName)
    food.value = log.food ?? null
    date.value = log.date
    mealType.value = log.mealType
    mode.value = log.quantityMode === 'unit' && validUnit ? 'unit' : 'grams'
    grams.value = Math.max(0.1, log.grams)
    unitName.value = validUnit?.name ?? log.food?.defaultUnit ?? log.food?.units[0]?.name ?? ''
    unitCount.value = log.units ?? 1
    note.value = log.note ?? ''
  },
  { immediate: true },
)

const unit = computed(() => food.value?.units.find((u) => u.name === unitName.value) ?? null)
const effectiveGrams = computed(() => {
  if (!food.value) return 0
  if (mode.value === 'grams') return grams.value
  return Math.max(0, Math.round(unitCount.value * (unit.value?.grams ?? 100)))
})
const kcal = computed(() => food.value ? Math.round(food.value.kcal * effectiveGrams.value / 100) : 0)
const canSave = computed(() => !!food.value && date.value.length > 0 && effectiveGrams.value > 0 && !saving.value)

function pickFood(next: Food): void {
  food.value = next
  const hasUnits = next.units.length > 0
  mode.value = hasUnits ? 'unit' : 'grams'
  unitName.value = next.defaultUnit ?? next.units[0]?.name ?? ''
  unitCount.value = 1
  grams.value = 100
}

async function save(): Promise<void> {
  const f = food.value
  if (!f || !canSave.value) return
  saving.value = true
  try {
    const updated = await dietService.updateMeal(props.log!.id, {
      foodId: f.id,
      date: date.value,
      mealType: mealType.value,
      quantityMode: mode.value,
      grams: effectiveGrams.value,
      units: mode.value === 'unit' ? unitCount.value : null,
      unitName: mode.value === 'unit' ? unitName.value : null,
      note: note.value.trim() || null,
    })
    toast(`已更新 ${f.name} · ${kcal.value} 大卡`)
    emit('updated', updated)
  } catch (e) {
    toast(e instanceof Error ? e.message : '更新失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="编辑饮食记录" initial-snap="large" @close="emit('close')">
    <div class="edit-form">
      <section class="card food-card">
        <div class="row between">
          <span class="food-icon"><Utensils :size="20" /></span>
          <button type="button" class="change" @click="pickerOpen = true">更换食物</button>
        </div>
        <h3>{{ food?.name ?? '请选择食物' }}</h3>
        <p v-if="food" class="food-meta num">
          {{ food.kcal }} 大卡 / 100g · 蛋白 {{ fmtGrams(food.protein) }}g · 碳水 {{ fmtGrams(food.carb) }}g · 脂肪 {{ fmtGrams(food.fat) }}g
        </p>
      </section>

      <section class="card">
        <label class="field">
          <span>日期</span>
          <input v-model="date" type="date" :max="todayStr()" aria-label="记录日期" />
        </label>
        <div class="field">
          <span>餐次</span>
          <SegmentedControl
            v-model="mealType"
            :options="MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))"
          />
        </div>
      </section>

      <section v-if="food" class="card">
        <div class="field">
          <span>数量</span>
          <SegmentedControl
            v-if="food.units.length"
            v-model="mode"
            :options="[{ value: 'grams', label: '按克重' }, { value: 'unit', label: '按份' }]"
          />
          <NumberStepper
            v-if="mode === 'grams'"
            v-model="grams"
            :step="10"
            :decimals="1"
            :min="0.1"
            :max="5000"
            label="克重"
            unit="g"
          />
          <template v-else>
            <div class="units">
              <button
                v-for="u in food.units"
                :key="u.name"
                type="button"
                class="unit"
                :class="{ on: u.name === unitName }"
                @click="unitName = u.name"
              >
                {{ u.name }}<small class="num">{{ u.grams }}g</small>
              </button>
            </div>
            <NumberStepper
              v-model="unitCount"
              :step="0.5"
              :decimals="1"
              :min="0.5"
              :max="100"
              label="份量"
              :unit="unitName"
            />
          </template>
        </div>
        <p class="preview num">约 <b>{{ kcal }}</b> 大卡 · {{ effectiveGrams }}g</p>
      </section>

      <section class="card">
        <label class="field">
          <span>备注（可选）</span>
          <textarea v-model="note" rows="3" maxlength="300" placeholder="例如：少油、外食、品牌包装…" />
        </label>
      </section>
    </div>

    <template #footer>
      <div class="actions">
        <button type="button" class="cancel" @click="emit('close')">取消</button>
        <button type="button" class="save" data-testid="meal-edit-save" :disabled="!canSave" @click="save">
          <LoaderCircle v-if="saving" :size="16" class="spin" />
          <Check v-else :size="16" />
          保存修改
        </button>
      </div>
    </template>
  </SheetModal>

  <FoodPickerSheet
    :open="pickerOpen"
    select-only
    title="选择食物"
    @close="pickerOpen = false"
    @pick="pickFood"
  />
</template>

<style scoped>
.edit-form {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.card {
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.food-card h3 {
  margin-top: var(--gap-md);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
}

.food-meta {
  margin-top: var(--gap-sm);
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.food-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface);
  color: var(--accent);
}

.change {
  min-height: var(--hit-min);
  color: var(--accent-strong);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.field + .field {
  margin-top: var(--gap-lg);
}

.field > span {
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.field input,
.field textarea {
  width: 100%;
  min-height: var(--row-h);
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface);
  font-size: var(--fs-body);
  color: var(--text-1);
}

.field textarea {
  resize: vertical;
  line-height: var(--lh-body);
}

.units {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}

.unit {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--control-md);
  padding: var(--gap-sm) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.unit small {
  color: var(--text-3);
  font-weight: var(--fw-regular);
}

.unit.on {
  background: var(--accent);
  color: var(--on-accent);
}

.preview {
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 0.5px solid var(--line);
  color: var(--text-2);
  font-size: var(--fs-subhead);
}

.preview b {
  color: var(--text-1);
  font-size: var(--fs-title3);
}

.actions {
  display: flex;
  gap: var(--gap-md);
}

.actions button {
  flex: 1;
  min-height: var(--row-h);
  border-radius: var(--radius-l);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.cancel {
  background: var(--surface-2);
  color: var(--text-1);
}

.save {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  background: var(--accent);
  color: var(--on-accent);
}

.save:disabled {
  opacity: var(--disabled-opacity);
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
