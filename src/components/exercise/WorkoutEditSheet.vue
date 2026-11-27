<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Calculator, Check, Clock, LoaderCircle, PencilLine } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import {
  EFFORT_LABELS,
  WORKOUT_GROUPS,
  WORKOUT_META,
  effortToIntensity,
  estimateKcalByEffort,
  workoutTypesInGroup,
} from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { minToHHmm, todayStr } from '@/utils/date'
import { fmtPace } from '@/utils/format'
import { EFFORT_LEVELS, type EffortLevel, type Workout, type WorkoutGroup, type WorkoutType } from '@/types'

const props = defineProps<{ open: boolean; workout: Workout | null; distanceKm?: number | null }>()
const emit = defineEmits<{ close: []; updated: [workout: Workout] }>()
const exercise = useExerciseStore()
const nutrition = useNutritionStore()
const { toast } = useToast()

const name = ref('')
const date = ref(todayStr())
const startTime = ref('')
const durationMin = ref(30)
const kcal = ref(0)
const note = ref('')
const group = ref<WorkoutGroup>('cardio')
const type = ref<WorkoutType>('run')
const effort = ref<EffortLevel>(3)
const distanceInput = ref(0)
const saving = ref(false)

const manual = computed(() => props.workout?.sessionId == null)
const isRunSession = computed(() => props.workout?.sessionId != null && props.workout.type === 'run')
const typeOptions = computed(() => workoutTypesInGroup(group.value))
const effortOptions = EFFORT_LEVELS.map((v) => ({ value: String(v), label: EFFORT_LABELS[v] }))
const weightKg = computed(() => Math.round(nutrition.profile?.weightKg ?? 70))
const startMin = computed<number | null>(() => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(startTime.value)
  if (!m) return null
  const v = Number(m[1]) * 60 + Number(m[2])
  return v >= 0 && v < 1440 ? v : null
})
const canSave = computed(() =>
  name.value.trim().length > 0 && date.value.length > 0 && durationMin.value > 0 && kcal.value >= 0 && !saving.value,
)

watch(
  () => [props.open, props.workout?.id, props.distanceKm] as const,
  ([open, id]) => {
    if (!open || !props.workout || !id) return
    const w = props.workout
    name.value = w.name
    date.value = w.date
    startTime.value = w.startMin != null ? minToHHmm(w.startMin) : ''
    durationMin.value = Math.max(1, w.durationMin)
    kcal.value = Math.max(0, w.kcal)
    note.value = w.note ?? ''
    distanceInput.value = props.distanceKm ?? 0
    group.value = WORKOUT_META[w.type]?.group ?? 'outdoor'
    type.value = w.type
    effort.value = w.effort ?? 3
  },
  { immediate: true },
)

watch(group, () => {
  if (!typeOptions.value.includes(type.value)) type.value = typeOptions.value[0] ?? 'other'
})

function estimate(): void {
  if (!manual.value) return
  kcal.value = estimateKcalByEffort(type.value, effort.value, durationMin.value, weightKg.value)
}

function buildRunNote(raw: string, km: number, minutes: number): string | null {
  const parts = raw
    .split(/\s*·\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^[\d.]+\s*km(?:\s|$)/.test(part) && !/^配速\s+\d+'[\d"]+"$/.test(part))
  if (km > 0) {
    parts.unshift(`${km.toFixed(2)} km`)
    if (minutes > 0) parts.splice(1, 0, `配速 ${fmtPace(Math.round(minutes * 60 / km))}`)
  }
  return parts.length ? parts.join(' · ') : null
}

async function save(): Promise<void> {
  const w = props.workout
  if (!w || !canSave.value) return
  saving.value = true
  try {
    const updated = await exercise.update(w.id, {
      name: name.value.trim(),
      type: type.value,
      date: date.value,
      startMin: startMin.value,
      durationMin: durationMin.value,
      intensity: manual.value ? effortToIntensity(effort.value) : null,
      effort: manual.value ? effort.value : null,
      kcal: kcal.value,
      note: isRunSession.value ? buildRunNote(note.value, distanceInput.value, durationMin.value) : (note.value.trim() || null),
    }, w.date)
    toast('运动记录已更新')
    emit('updated', updated)
  } catch (e) {
    toast(e instanceof Error ? e.message : '更新失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="编辑运动记录" initial-snap="large" @close="emit('close')">
    <div class="edit-form">
      <section class="card">
        <label class="field">
          <span>名称</span>
          <span class="input-wrap">
            <PencilLine :size="15" class="t-3" />
            <input v-model="name" type="text" maxlength="80" aria-label="运动名称" />
          </span>
        </label>
        <label class="field">
          <span>日期</span>
          <input v-model="date" type="date" :max="todayStr()" aria-label="运动日期" />
        </label>
        <label class="field">
          <span>开始时刻（可选）</span>
          <span class="input-wrap">
            <Clock :size="15" class="t-3" />
            <input v-model="startTime" type="time" aria-label="开始时刻，可选" />
          </span>
        </label>
      </section>

      <section v-if="manual" class="card">
        <div class="field">
          <span>运动类型</span>
          <div class="groups">
            <button
              v-for="g in WORKOUT_GROUPS"
              :key="g.key"
              type="button"
              class="group"
              :class="{ on: g.key === group }"
              @click="group = g.key"
            >{{ g.label }}</button>
          </div>
          <div class="types">
            <button
              v-for="t in typeOptions"
              :key="t"
              type="button"
              class="type"
              :class="{ on: t === type }"
              @click="type = t"
            >{{ WORKOUT_META[t].label }}</button>
          </div>
        </div>
        <div class="field">
          <span>这次累不累</span>
          <SegmentedControl
            :model-value="String(effort)"
            :options="effortOptions"
            @update:model-value="effort = Number($event) as EffortLevel"
          />
        </div>
      </section>
      <section v-else class="card readonly-type">
        <span>运动类型</span>
        <b>{{ WORKOUT_META[workout!.type]?.label ?? workout!.type }}</b>
        <p>课程与跑步的类型、客观强度来自过程记录，不在历史详情里改写。</p>
      </section>

      <section class="card">
        <div class="field">
          <span>运动时长</span>
          <NumberStepper
            v-model="durationMin"
            :step="5"
            :decimals="1"
            :min="1"
            :max="1440"
            label="时长"
            unit="分钟"
          />
        </div>
        <div class="field kcal-field">
          <div class="row between">
            <span>消耗</span>
            <button v-if="manual" type="button" class="estimate" @click="estimate">
              <Calculator :size="14" /> 重新估算
            </button>
          </div>
          <NumberStepper
            v-model="kcal"
            :step="10"
            :min="0"
            :max="10000"
            label="消耗"
            unit="大卡"
          />
          <InfoHint title="消耗怎么改">
            <p>可直接填写手表或运动 App 的实测值。手动补录也可以按类型、体感、时长和体重重新估算。</p>
          </InfoHint>
        </div>
      </section>

      <section v-if="isRunSession" class="card">
        <div class="field">
          <span>距离</span>
          <NumberStepper
            v-model="distanceInput"
            :step="0.5"
            :decimals="2"
            :min="0"
            :max="999"
            label="距离"
            unit="km"
          />
          <p class="field-note">距离与配速会自动写回跑步摘要，备注里不用重复填写。</p>
        </div>
      </section>

      <section class="card">
        <label class="field">
          <span>{{ isRunSession ? '补充备注（可选）' : '备注（可选）' }}</span>
          <textarea v-model="note" rows="3" :maxlength="isRunSession ? 450 : 500" placeholder="这次训练的感受、环境或实测来源…" />
        </label>
      </section>
    </div>

    <template #footer>
      <div class="actions">
        <button type="button" class="cancel" @click="emit('close')">取消</button>
        <button type="button" class="save" data-testid="workout-edit-save" :disabled="!canSave" @click="save">
          <LoaderCircle v-if="saving" :size="16" class="spin" />
          <Check v-else :size="16" />
          保存修改
        </button>
      </div>
    </template>
  </SheetModal>
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

.field {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.field + .field {
  margin-top: var(--gap-lg);
}

.field > span,
.readonly-type > span {
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

.field-note {
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.input-wrap {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding-left: var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface);
}

.input-wrap input {
  padding-left: 0;
  background: transparent;
}

.groups,
.types {
  display: grid;
  gap: var(--gap-sm);
}

.groups {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.types {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.group,
.type {
  position: relative;
  min-height: var(--control-md);
  padding: var(--gap-sm) var(--sp-4);
  border-radius: var(--radius-m);
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.group::after,
.type::after {
  content: '';
  position: absolute;
  inset: -2px 0;
  border-radius: inherit;
}

.group.on,
.type.on {
  background: var(--accent);
  color: var(--on-accent);
}

.readonly-type b {
  margin-top: var(--gap-sm);
  font-size: var(--fs-headline);
}

.readonly-type p {
  margin-top: var(--gap-sm);
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.kcal-field {
  padding-top: var(--gap-lg);
  border-top: 0.5px solid var(--line);
}

.estimate {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--hit-min);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
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
