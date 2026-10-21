<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Eye, EyeOff, Pencil, Star, Trash2 } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import ExerciseHistoryPanel from '@/components/exercise/ExerciseHistoryPanel.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import MuscleMap from '@/components/exercise/MuscleMap.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import WeightCurve from '@/components/exercise/WeightCurve.vue'
import { EXERCISE_CATEGORY_LABELS, EXERCISE_EQUIPMENT_LABELS, EXERCISE_KIND_LABELS } from '@/config/domain'
import { sessionService } from '@/services/sessionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useToast } from '@/composables/useToast'
import { fmtDateCn, todayStr } from '@/utils/date'
import { libraryMuscles } from '@/utils/libraryMuscles'
import { aggregateStrengthDays, fmtKg, type StrengthDay } from '@/utils/strength'
import { computeTrainingAdvice, type ExerciseAdvice } from '@/utils/trainingAdvice'
import type { ExerciseRecord, PlanExercise } from '@/types'

/**
 * 动作库 · 动作详情。
 * 内容 = 名称与分类 + 激活肌群图 + 今日建议（按库内默认处方 + 历史算） +
 * 重量曲线（按动作库 id）+ 训练参数 + 动作要点 + 自建动作的编辑/删除。
 */
const props = defineProps<{
  open: boolean
  exercise: ExerciseRecord | null
}>()

const emit = defineEmits<{
  close: []
  changed: []
  edit: [exercise: ExerciseRecord]
}>()

const lib = useExerciseLibStore()
const { toast } = useToast()

const curveDays = ref<StrengthDay[]>([])
const advice = ref<ExerciseAdvice | null>(null)
const loading = ref(false)
const confirmDelete = ref(false)

/** 展示用肌群：显式数据优先，空表按动作名兜底（与课程侧口径一致） */
const shownMuscles = computed(() => libraryMuscles(props.exercise))

/** 库内动作 → 建议引擎的输入形状（组数/次数/重量取库内默认处方） */
function asPlanExercise(e: ExerciseRecord): PlanExercise {
  return {
    id: 'preview',
    exerciseId: e.id,
    name: e.name,
    kind: e.kind,
    sets: e.defaultSets,
    reps: e.defaultReps,
    weightKg: e.defaultWeightKg,
    targetSec: e.defaultTargetSec,
    durationMin: e.defaultDurationMin,
    restSec: e.defaultRestSec,
    tips: e.tips,
    muscles: e.muscles,
  }
}

async function load(e: ExerciseRecord): Promise<void> {
  loading.value = true
  advice.value = null
  curveDays.value = []
  try {
    const [rows, recent] = await Promise.all([
      sessionService.strengthHistory(e.id),
      sessionService.strengthRecentSets(42),
    ])
    curveDays.value = aggregateStrengthDays(rows).slice(-10)
    const result = computeTrainingAdvice({
      sets: recent,
      library: lib.list,
      planExercises: [asPlanExercise(e)],
      today: todayStr(),
    })
    advice.value = result.perExercise[e.id] ?? null
  } catch {
    /* 建议与曲线都只是参考：失败静默，页面其余内容照常 */
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.exercise?.id] as const,
  ([open, id]) => {
    if (open && id && props.exercise) void load(props.exercise)
  },
  { immediate: true },
)

const metaLine = computed(() => {
  const e = props.exercise
  if (!e) return ''
  const bits = [EXERCISE_KIND_LABELS[e.kind], EXERCISE_CATEGORY_LABELS[e.category]]
  if (e.equipment) bits.push(EXERCISE_EQUIPMENT_LABELS[e.equipment])
  if (e.sessions > 0) bits.push(`练过 ${e.sessions} 次`)
  return bits.join(' · ')
})

/** 训练参数：值与单位拆开，给程序页 stats 同款「标签在上 / 值+单位在下」的排法 */
const stats = computed<{ k: string; v: string; unit?: string }[]>(() => {
  const e = props.exercise
  if (!e) return []
  if (e.kind === 'strength') {
    return [
      { k: '默认组数', v: `${e.defaultSets}`, unit: '组' },
      { k: '每组次数', v: e.defaultReps != null ? `${e.defaultReps}` : '—', unit: e.defaultReps != null ? '次' : undefined },
      { k: '默认重量', v: e.defaultWeightKg != null ? fmtKg(e.defaultWeightKg) : '自重', unit: e.defaultWeightKg != null ? 'kg' : undefined },
      { k: '组间休息', v: `${e.defaultRestSec}`, unit: '秒' },
    ]
  }
  if (e.kind === 'timed') {
    return [
      { k: '默认组数', v: `${e.defaultSets}`, unit: '组' },
      { k: '每组时长', v: e.defaultTargetSec != null ? `${e.defaultTargetSec}` : '—', unit: e.defaultTargetSec != null ? '秒' : undefined },
      { k: '组间休息', v: `${e.defaultRestSec}`, unit: '秒' },
    ]
  }
  return [
    { k: '默认时长', v: e.defaultDurationMin != null ? `${e.defaultDurationMin}` : '—', unit: e.defaultDurationMin != null ? '分钟' : undefined },
  ]
})

const lastSetLine = computed(() => {
  const d = curveDays.value[curveDays.value.length - 1]
  if (!d) return ''
  const chips = d.sets.map((s) => `${fmtKg(s.weightKg ?? 0)}×${s.reps ?? '?'}`).join(' · ')
  return `${chips}（${fmtDateCn(d.date)}）`
})

/** 计时 / 有氧动作没有重量建议（trainingAdvice 对非 strength 恒不产建议），
 *  结论行按 kind 分支说清「为什么没有」，不要对计时动作输出「暂无历史记录」——
 *  那会让用户以为再练几次就有建议了。 */
const ADVICE_FALLBACK: Record<string, string> = {
  strength: '暂无历史记录',
  timed: '计时动作不做重量建议',
  cardio: '有氧动作不做重量建议',
}

const adviceLine = computed(() => {
  const a = advice.value
  if (!a) return ''
  if (a.suggestedWeight == null) {
    return a.hasHistory ? '自重动作：按目标次数推进' : ADVICE_FALLBACK[props.exercise?.kind ?? 'strength']
  }
  return `建议 ${fmtKg(a.suggestedWeight)} kg × ${a.suggestedReps ?? '—'} 次 × ${a.suggestedSets} 组`
})

/**
 * 「今日状态」系数降为次要行：它只微调建议重量（约 ±15%），不该和重量建议
 * 同字号并列。恰为 1.00（无历史 / 各项都取基准）时不显示；四个因子的口径
 * 收进标题行右侧 InfoHint。
 */
const readinessText = computed(() => {
  const a = advice.value
  if (!a || a.suggestedWeight == null) return ''
  const r = a.readiness.toFixed(2)
  return r === '1.00' ? '' : `今日状态 ×${r}`
})

async function hideFromLibrary(): Promise<void> {
  const e = props.exercise
  if (!e) return
  try {
    await lib.remove(e.id)
    toast('已从动作库隐藏（历史记录保留）')
    emit('changed')
    emit('close')
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败')
  }
}

async function restoreToLibrary(): Promise<void> {
  const e = props.exercise
  if (!e) return
  try {
    await lib.restore(e.id)
    toast('已恢复显示')
    emit('changed')
    emit('close')
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败')
  }
}

/** 收藏 / 取消收藏（乐观更新在 store 内，失败回滚并提示） */
async function toggleFavorite(): Promise<void> {
  const e = props.exercise
  if (!e) return
  try {
    await lib.setFavorite(e.id, !e.favorite)
  } catch (err) {
    toast(err instanceof Error ? err.message : '收藏失败')
  }
}

async function removeCustom(): Promise<void> {
  const e = props.exercise
  if (!e) return
  confirmDelete.value = false
  try {
    await lib.remove(e.id)
    toast('动作已删除（历史记录保留）')
    emit('changed')
    emit('close')
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败')
  }
}
</script>

<template>
  <SheetModal :open="open" title="动作详情" initial-snap="large" @close="emit('close')">
    <template v-if="exercise">
      <div class="titlerow row">
        <h3 class="name">{{ exercise.name }}</h3>
        <span v-if="exercise.isCustom" class="badge">自建</span>
        <span v-else-if="exercise.hidden" class="badge muted">已隐藏</span>
      </div>
      <p class="sub">{{ metaLine }}</p>

      <template v-if="Object.keys(shownMuscles).length">
        <p class="sec">激活肌群</p>
        <div class="mapcard">
          <MuscleMap :activation="shownMuscles" />
        </div>
      </template>

      <p class="sec">
        今日建议<span class="secsub">按库内默认处方与你的历史推算</span>
        <InfoHint
          class="sec-hint"
          title="今日状态系数"
          content="今日状态系数 = 恢复 × 容量 × 趋势 × 自评，四项相乘后夹在 0.85~1.06。

恢复：同一主攻肌群距上次训练的小时数；容量：本周该肌群的组数相对恢复区间的位置；趋势：上次估算极限重量相对基线的偏离；自评：训练页的今日状态自评（没自评按 1.00 计）。

它只微调建议重量（约 ±15%），系数为 1.00 时不显示。"
        />
      </p>
      <div class="advicecard">
        <p class="adviceline num">{{ loading ? '计算中…' : adviceLine }}</p>
        <p v-if="readinessText" class="advicestate">{{ readinessText }}</p>
        <p v-if="advice?.rationale.length" class="advicewhy">{{ advice.rationale[0] }}</p>
      </div>

      <template v-if="curveDays.length">
        <p class="sec">重量曲线<span class="secsub">每次训练的最大重量组</span></p>
        <div class="curvebox">
          <WeightCurve :days="curveDays" :height="130" />
          <p class="lastline num">{{ lastSetLine }}</p>
        </div>
      </template>

      <!-- 口径与术语收进标题行右侧 InfoHint：「正式组」「容量」都是要背景才读得懂的行内术语 -->
      <p class="sec">
        历史与 PR
        <InfoHint
          class="sec-hint"
          title="口径与术语"
          content="训练量 = 组数 × 次数 × 重量，热身组不计入；「最佳单次训练量」是单次训练里的最大值。

1RM（一次最大重量）：某个动作只能标准完成 1 次的重量。本软件不直接测极限，按你练过的组次估算，所以叫 e1RM。"
        />
      </p>
      <ExerciseHistoryPanel :exercise-id="exercise.id" />

      <p class="sec">训练参数</p>
      <div class="stats">
        <div v-for="s in stats" :key="s.k" class="cell">
          <em>{{ s.k }}</em>
          <b class="num">{{ s.v }}<i v-if="s.unit">{{ s.unit }}</i></b>
        </div>
      </div>

      <template v-if="exercise.tips">
        <p class="sec">动作要点</p>
        <p class="tips">{{ exercise.tips }}</p>
      </template>

      <template v-if="exercise.steps.length">
        <p class="sec">动作要领</p>
        <ol class="steps">
          <li v-for="(s, i) in exercise.steps" :key="i">{{ s }}</li>
        </ol>
      </template>

      <div class="ops row">
        <button class="op" @click="void toggleFavorite()">
          <Star :size="14" />{{ exercise.favorite ? '取消收藏' : '收藏这个动作' }}
        </button>
        <template v-if="exercise.isCustom">
          <button class="op" @click="emit('edit', exercise)"><Pencil :size="14" />编辑动作</button>
          <button class="op danger" @click="confirmDelete = true"><Trash2 :size="14" />删除动作</button>
        </template>
        <button v-else-if="exercise.hidden" class="op" @click="void restoreToLibrary()">
          <Eye :size="14" />恢复显示
        </button>
        <button v-else class="op" @click="void hideFromLibrary()">
          <EyeOff :size="14" />从库中隐藏
        </button>
      </div>
    </template>
  </SheetModal>

  <ActionSheet
    :open="confirmDelete"
    title="删除后这个自建动作从动作库移除，无法恢复；用它记录过的训练历史仍在"
    :actions="[{ label: '删除动作', value: 'del', danger: true }]"
    @select="(v: string) => (v === 'del' ? void removeCustom() : (confirmDelete = false))"
    @close="confirmDelete = false"
  />
</template>

<style scoped>
.titlerow {
  gap: var(--sp-10);
  align-items: center;
}

.name {
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.badge {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  /* 「自建 / 已隐藏」是来源标签，不是类型字章：文字走中性色，
     色相留在 soft 底的色块上（色彩配额，STANDARDS §4） */
  background: var(--c-exercise-soft);
  color: var(--text-1);
}

.badge.muted {
  background: var(--surface-2);
  color: var(--text-3);
}

.sub {
  margin-top: var(--sp-4);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

/* 小节标题行：右侧留帮助入口位（sec-hint 用 margin-left:auto 顶到行尾） */
.sec {
  margin: var(--sp-18) 0 var(--sp-10);
  display: flex;
  align-items: center;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  letter-spacing: 0.4px;
  color: var(--text-3);
}

.sec-hint {
  margin-left: auto;
}

/* 动作要领：分步说明（有序列表 + 序号圆点） */
.steps {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  padding-left: 0;
  list-style: none;
  counter-reset: step;
}

.steps li {
  position: relative;
  padding-left: var(--sp-26);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-1);
  counter-increment: step;
}

.steps li::before {
  content: counter(step);
  position: absolute;
  left: 0;
  top: 1px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  /* 序号是数值：走中性色。色相只留在圆点底上（色点/标记图元，STANDARDS §4） */
  background: var(--c-exercise-soft);
  color: var(--text-1);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  line-height: 18px;
  text-align: center;
}

.secsub {
  margin-left: var(--sp-8);
  font-weight: var(--fw-medium);
  letter-spacing: 0;
}

.mapcard,
.advicecard,
.curvebox {
  border-radius: var(--radius-m);
  background: var(--surface-2);
  padding: var(--sp-14) var(--sp-12) var(--sp-10);
}

.advicecard {
  padding: var(--sp-12) var(--sp-14);
}

.adviceline {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

/* 「今日状态 ×…」是次要行：系数只微调重量，不能和重量建议同字号并列 */
.advicestate {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.advicewhy {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.lastline {
  margin-top: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 训练参数：程序页 stats 语言——micro 标签在上，subhead 加粗值在下（单位降级为 micro） */
.stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-10);
}

.cell {
  background: var(--surface-2);
  border-radius: var(--radius-m);
  padding: var(--sp-10) var(--sp-14);
}

.cell em {
  display: block;
  font-style: normal;
  /* 标签轴统一：caption + --text-2。这里从前是 micro + --text-3，而动作详解抽屉
     （`.cell .k`）与运动详情抽屉都明文写过「micro/text-3 会把『4 是组数还是次数』
     变成猜谜」—— 三处同一种统计格，只有这一处落在另两处反对的那一档。
     数值档（.cell b 的 subhead/700）不动：它随格子宽度变化是合理的。
     （决策见 docs/exercise-quality-review-2026-10-17.md §8 D3） */
  font-size: var(--fs-caption);
  color: var(--text-2);
  white-space: nowrap;
}

.cell b {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.cell i {
  font-style: normal;
  font-weight: var(--fw-regular);
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: var(--sp-2);
}

.tips {
  font-size: var(--fs-callout);
  color: var(--text-1);
  line-height: var(--lh-body);
  white-space: pre-line;
}

/* 操作区：程序页 .cap 胶囊语言（描边白底、危险项红字），居中收成一排 */
.ops {
  margin-top: var(--sp-18);
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-10);
}

.op {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 实底文字约 33px 高，命中区撑到 44（仿 common/SheetModal 的 `.close::after`）——
   这三枚是「编辑 / 隐藏 / 删除」的唯一入口，删除还是不可逆的。 */
.op::after {
  content: '';
  position: absolute;
  inset: -6px -4px;
}

/* 走文字档而不是实底档：tokens.css 的契约写明「实底档（--danger）当小字文字对比度不够」，
   而这里正是 12px 小字压白底（#ff3b30 实测约 3.55:1，过不了 AA）。 */
.op.danger {
  color: var(--danger-strong);
}
</style>
