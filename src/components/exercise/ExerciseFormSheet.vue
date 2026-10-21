<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { EXERCISE_CATEGORY_META, EXERCISE_EQUIPMENT_LABELS, EXERCISE_KIND_LABELS } from '@/config/domain'
import { MUSCLE_GROUPS, MUSCLE_LABELS, normalizeActivation, type ActivationMap, type Level, type MuscleKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useToast } from '@/composables/useToast'
import type { ExerciseCategory, ExerciseEquipment, ExerciseKind, ExerciseRecord } from '@/types'

/**
 * 自建动作表单（新建 / 编辑）。内置动作只读，不走这里（动作库页对内置动作只提供隐藏）。
 * 肌群 chips 点按循环：无 → 主攻 → 辅助 → 稳定 → 无（与激活档位 3/2/1 对应）。
 */
const props = defineProps<{
  open: boolean
  /** null = 新建 */
  exercise?: ExerciseRecord | null
}>()

const emit = defineEmits<{
  close: []
  saved: [exercise: ExerciseRecord]
}>()

const lib = useExerciseLibStore()
const { toast } = useToast()

const name = ref('')
const kind = ref<ExerciseKind>('strength')
const category = ref<ExerciseCategory>('other')
const equipment = ref<ExerciseEquipment | null>(null)
const tips = ref('')
const stepsText = ref('')
const muscles = ref<ActivationMap>({})
const sets = ref(3)
const reps = ref(10)
const weightKg = ref(20)
const targetSec = ref(45)
const durationMin = ref(20)
const restSec = ref(90)
const saving = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const e = props.exercise
    name.value = e?.name ?? ''
    kind.value = e?.kind ?? 'strength'
    category.value = e?.category ?? 'other'
    equipment.value = e?.equipment ?? null
    tips.value = e?.tips ?? ''
    stepsText.value = (e?.steps ?? []).join('\n')
    muscles.value = normalizeActivation(e?.muscles)
    sets.value = e?.defaultSets ?? 3
    reps.value = e?.defaultReps ?? 10
    weightKg.value = e?.defaultWeightKg ?? 20
    targetSec.value = e?.defaultTargetSec ?? 45
    durationMin.value = e?.defaultDurationMin ?? 20
    restSec.value = e?.defaultRestSec ?? 90
  },
  { immediate: true },
)

const isEdit = computed(() => !!props.exercise)

/** 肌群 chips 的当前档位（0 = 未标注） */
function levelOf(m: MuscleKey): Level | 0 {
  return muscles.value[m] ?? 0
}

/** 点按循环：无 → 主攻(3) → 辅助(2) → 稳定(1) → 无 */
function cycleMuscle(m: MuscleKey): void {
  const cur = levelOf(m)
  const next: Level | 0 = cur === 0 ? 3 : cur === 3 ? 2 : cur === 2 ? 1 : 0
  if (next === 0) delete muscles.value[m]
  else muscles.value[m] = next
  muscles.value = { ...muscles.value }
}

const LEVEL_LABEL: Record<number, string> = { 3: '主攻', 2: '辅助', 1: '稳定' }

async function save(): Promise<void> {
  const finalName = name.value.trim()
  if (!finalName) {
    toast('请填写动作名称')
    return
  }
  saving.value = true
  try {
    const rec = await lib.upsert({
      id: props.exercise?.id,
      name: finalName,
      kind: kind.value,
      category: category.value,
      equipment: equipment.value,
      muscles: normalizeActivation(muscles.value),
      tips: tips.value.trim(),
      steps: stepsText.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      defaultSets: sets.value,
      defaultReps: kind.value === 'strength' ? reps.value : null,
      defaultWeightKg: kind.value === 'strength' ? weightKg.value : null,
      defaultTargetSec: kind.value === 'timed' ? targetSec.value : null,
      defaultDurationMin: kind.value === 'cardio' ? durationMin.value : null,
      defaultRestSec: restSec.value,
    })
    toast(isEdit.value ? '动作已更新' : '动作已创建')
    emit('saved', rec)
    emit('close')
  } catch (e) {
    toast(e instanceof Error ? e.message : '保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" :title="isEdit ? '编辑动作' : '新建动作'" initial-snap="large" @close="emit('close')">
    <label class="field">
      <span class="flabel">动作名称</span>
      <input v-model="name" type="text" maxlength="20" placeholder="如：反向飞鸟" />
    </label>

    <div class="field">
      <span class="flabel">类型</span>
      <SegmentedControl
        :options="(['strength', 'timed', 'cardio'] as ExerciseKind[]).map((k) => ({ value: k, label: EXERCISE_KIND_LABELS[k] }))"
        :model-value="kind"
        @update:model-value="kind = $event as ExerciseKind"
      />
    </div>

    <div class="field">
      <span class="flabel">分类</span>
      <div class="chips row">
        <button
          v-for="c in EXERCISE_CATEGORY_META"
          :key="c.key"
          class="chip"
          :class="{ on: category === c.key }"
          @click="category = c.key"
        >
          {{ c.label }}
        </button>
      </div>
    </div>

    <div class="field">
      <span class="flabel">器材</span>
      <div class="chips row">
        <button class="chip" :class="{ on: equipment === null }" @click="equipment = null">未指定</button>
        <button
          v-for="(label, key) in EXERCISE_EQUIPMENT_LABELS"
          :key="key"
          class="chip"
          :class="{ on: equipment === key }"
          @click="equipment = key as ExerciseEquipment"
        >
          {{ label }}
        </button>
      </div>
    </div>

    <div class="field">
      <span class="flabel">肌群<span class="fsub">点按切换：主攻 → 辅助 → 稳定 → 无</span></span>
      <div v-for="g in MUSCLE_GROUPS" :key="g.label" class="mgroup">
        <span class="ghead">{{ g.label }}</span>
        <div class="chips row">
          <button
            v-for="m in g.keys"
            :key="m"
            class="chip"
            :class="[`lv${levelOf(m)}`, { on: levelOf(m) > 0 }]"
            @click="cycleMuscle(m)"
          >
            {{ MUSCLE_LABELS[m] }}<b v-if="levelOf(m)">{{ LEVEL_LABEL[levelOf(m)] }}</b>
          </button>
        </div>
      </div>
    </div>

    <template v-if="kind === 'strength'">
      <NumberStepper v-model="sets" :step="1" :min="1" :max="20" label="默认组数" unit="组" />
      <NumberStepper v-model="reps" :step="1" :min="1" :max="100" label="默认次数" unit="次" />
      <NumberStepper v-model="weightKg" :step="2.5" :min="0" :max="500" label="默认重量" unit="kg" />
    </template>
    <template v-else-if="kind === 'timed'">
      <NumberStepper v-model="sets" :step="1" :min="1" :max="20" label="默认组数" unit="组" />
      <NumberStepper v-model="targetSec" :step="5" :min="10" :max="3600" label="每组目标" unit="秒" />
    </template>
    <template v-else>
      <NumberStepper v-model="durationMin" :step="5" :min="5" :max="300" label="默认时长" unit="分钟" />
    </template>
    <NumberStepper v-model="restSec" :step="15" :min="0" :max="300" label="组间休息" unit="秒" />

    <label class="field">
      <span class="flabel">动作要点</span>
      <textarea v-model="tips" rows="2" maxlength="120" placeholder="发力细节、注意事项（训练中展示，一句话）" />
    </label>

    <label class="field">
      <span class="flabel">动作要领<span class="fsub">每行一步（最多 12 步，可在详情页分步查看）</span></span>
      <textarea
        v-model="stepsText"
        rows="4"
        maxlength="1200"
        placeholder="如：&#10;肩胛后收下沉，双脚踩实&#10;杠铃下放至触胸，不弹震&#10;沿斜上方推起，肘不完全锁死"
      />
    </label>

    <button class="save row center" :disabled="saving" @click="void save()">
      {{ saving ? '保存中…' : isEdit ? '保存修改' : '创建动作' }}
    </button>
  </SheetModal>
</template>

<style scoped>
.field {
  display: block;
  padding: var(--sp-10) 0;
}

.field + .field {
  border-top: 0.5px solid var(--line);
}

.flabel {
  display: block;
  margin-bottom: var(--sp-6);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fsub {
  margin-left: var(--sp-8);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

/* 肌群芯片按部位分组（39 键平铺太长） */
.mgroup + .mgroup {
  margin-top: var(--sp-8);
}

.ghead {
  display: block;
  margin-bottom: var(--sp-4);
  font-size: var(--fs-micro);
  letter-spacing: 1px;
  color: var(--text-3);
}

.field input,
.field textarea {
  width: 100%;
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-body);
  color: var(--text-1);
}

.field textarea {
  resize: vertical;
  line-height: var(--lh-body);
}

.field input::placeholder,
.field textarea::placeholder {
  color: var(--text-3);
}

.chips {
  gap: var(--sp-6);
  flex-wrap: wrap;
}

/* 与动作库页/方案向导同一套 chips：描边白底，选中实底 accent */
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-6) var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-bold);
}

/* 档位文字（主攻/辅助/稳定）不用 opacity 压层级：它在 --text-2 上再乘 0.75，
   亮暗两档都更接近看不见，而这行字正是「我标了哪几块肌肉」的凭据。
   层级靠字号（micro）/ 字重（700）区分；选中态实色继承 --on-accent。 */
.chip b {
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
}

.chip.on b {
  color: var(--on-accent);
}

.save {
  width: 100%;
  margin-top: var(--sp-16);
  gap: var(--sp-6);
  padding: var(--sp-12) 0;
  /* 通栏主操作统一胶囊：另一个 `.primary`（MuscleCatchupSheet）本就是 --radius-full，
     同一角色两个形状是命名同族、形状分道。iOS 的通栏主操作也是胶囊。
     （决策见 docs/exercise-quality-review-2026-10-17.md §8 D5） */
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

.save:disabled {
  opacity: var(--disabled-opacity);
}
</style>
