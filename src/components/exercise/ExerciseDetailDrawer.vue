<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ExerciseGuideBlock from '@/components/exercise/ExerciseGuideBlock.vue'
import ExerciseHistoryPanel from '@/components/exercise/ExerciseHistoryPanel.vue'
import ExerciseTrendCard from '@/components/exercise/ExerciseTrendCard.vue'
import MuscleMap from '@/components/exercise/MuscleMap.vue'
import WeightCurve from '@/components/exercise/WeightCurve.vue'
import { sessionService } from '@/services/sessionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { fmtDateCn, todayStr } from '@/utils/date'
import { buildExerciseHistory } from '@/utils/strengthStats'
import { computeStrengthTrend, type StrengthTrend } from '@/utils/strengthTrend'
import { aggregateStrengthDays, fmtKg, type StrengthDay } from '@/utils/strength'
import type { PlanExercise } from '@/types'
import { exerciseBadge } from '@/utils/plan'

/** 动作详情抽屉：课程详情页点击动作唤起。
 *  顺序按「训练前怎么读」排：**动作详解（准备/轨迹/注意）在最上面** —— 它是用户
 *  打开这个抽屉的第一诉求；肌群图与参数是背景信息；历史最高与趋势回答「我现在什么水平」；
 *  曲线与逐项成绩是存档。 */
const props = defineProps<{
  open: boolean
  exercise: PlanExercise | null
}>()

defineEmits<{ close: [] }>()

const lib = useExerciseLibStore()

/** 展示名：库内名优先（内置动作随种子更新），缺失回落课程条目快照 */
const displayName = computed(() => (props.exercise ? lib.resolveName(props.exercise) : ''))

/** 激活肌群：库内显式数据优先，其次课程条目，最后按名关键词识别 */
const activation = computed(() => (props.exercise ? lib.musclesOf(props.exercise) : null))

/** 结构化动作详解（内置动作）；自建动作回落库里那句 tips */
const guide = computed(() => (props.exercise ? lib.guideOf(props.exercise) : null))

/** 库内要点：自建动作没有详解数据时的兜底 */
const tips = computed(() => (props.exercise ? lib.tipsOf(props.exercise) : ''))

/* ---------- 历史：曲线 / 历史最高 / 14 天趋势 ---------- */

const curveDays = ref<StrengthDay[]>([])
const trend = ref<StrengthTrend | null>(null)
const best = ref<{ weight: number | null; reps: number | null; date: string | null; e1rm: number | null }>({
  weight: null,
  reps: null,
  date: null,
  e1rm: null,
})
const curveLoadedFor = ref('')

watch(
  () => [props.open, props.exercise?.exerciseId, props.exercise?.name] as const,
  ([open, exerciseId, name]) => {
    const key = exerciseId || name || ''
    if (!open || !key || curveLoadedFor.value === key) return
    curveLoadedFor.value = key
    curveDays.value = []
    trend.value = null
    best.value = { weight: null, reps: null, date: null, e1rm: null }
    void sessionService
      .strengthHistory(key)
      .then((rows) => {
        curveDays.value = aggregateStrengthDays(rows).slice(-10)
        // 历史最高与趋势走 strengthStats 的同一份聚合（PR 口径全端只有一份）
        const hist = buildExerciseHistory(rows)
        const w = hist.prs.weight
        best.value = {
          weight: w?.value ?? null,
          reps: w?.reps ?? null,
          date: w?.date ?? null,
          e1rm: hist.prs.e1rm?.value ?? null,
        }
        trend.value = computeStrengthTrend(
          hist.sessions.map((s) => ({ date: s.date, e1rm: s.bestE1rm })),
          todayStr(),
        )
      })
      .catch(() => {
        curveDays.value = []
        trend.value = null
      })
  },
  { immediate: true },
)

/** 最近一次做组的结论行：带标签与单位（kg × 次），日期降为次要 */
const lastSetLine = computed(() => {
  const d = curveDays.value[curveDays.value.length - 1]
  if (!d) return ''
  return `${fmtKg(d.top)} kg × ${d.topReps ?? '—'} 次`
})

const lastSetDate = computed(() => {
  const d = curveDays.value[curveDays.value.length - 1]
  return d ? fmtDateCn(d.date) : ''
})

const stats = computed<{ k: string; v: string }[]>(() => {
  const e = props.exercise
  if (!e) return []
  if (e.kind === 'strength') {
    const rows = [
      { k: '组数', v: `${e.sets} 组` },
      { k: '每组次数', v: e.reps != null ? `${e.reps} 次` : '—' },
      { k: '建议重量', v: e.weightKg != null ? `${e.weightKg} kg` : '自重' },
      { k: '组间休息', v: `${e.restSec} 秒` },
    ]
    if (e.warmups?.length) {
      rows.push({
        k: '激活热身',
        v: e.warmups.map((w) => `${fmtKg(w.weightKg)} kg × ${w.reps}`).join(' / '),
      })
    }
    return rows
  }
  if (e.kind === 'timed') {
    return [
      { k: '组数', v: `${e.sets} 组` },
      { k: '每组时长', v: e.targetSec != null ? `${e.targetSec} 秒` : '—' },
      { k: '组间休息', v: `${e.restSec} 秒` },
    ]
  }
  return [{ k: '时长', v: e.durationMin != null ? `${e.durationMin} 分钟` : '—' }]
})
</script>

<template>
  <SheetModal :open="open" title="动作详情" @close="$emit('close')">
    <template v-if="exercise">
      <div class="titlerow row">
        <h3 class="name">{{ displayName }}</h3>
        <span v-if="exerciseBadge(exercise)" class="badge">{{ exerciseBadge(exercise) }}</span>
      </div>
      <!-- 摘要行删去：参数格（组数/次数/重量/休息）是同一组事实的更全写法 -->

      <!-- 动作详解放在最顶：用户点开这个抽屉，第一诉求是「这个动作怎么做」，
           而不是先看肌群图与参数格。三段（准备 / 开始·结束 / 注意）的顺序
           就是一次动作的时间顺序。 -->
      <template v-if="guide">
        <p class="sec">动作详解</p>
        <ExerciseGuideBlock :guide="guide" />
      </template>
      <template v-else-if="tips">
        <p class="sec">动作要点</p>
        <p class="tips">{{ tips }}</p>
      </template>

      <template v-if="activation">
        <p class="sec">激活肌群</p>
        <div class="mapcard">
          <MuscleMap :activation="activation" />
        </div>
      </template>
      <p v-else class="unknown">暂无「{{ displayName }}」的肌群数据</p>

      <p class="sec">训练参数</p>
      <div class="stats">
        <div v-for="s in stats" :key="s.k" class="cell">
          <div class="v num">{{ s.v }}</div>
          <div class="k">{{ s.k }}</div>
        </div>
      </div>

      <!-- 历史最高与 14 天趋势：与「重量建议说明」抽屉同一份口径（strengthStats + strengthTrend），
           两处数字必须能对上 —— 建议抽屉里说「历史最高 80kg」，这里不能是 78 -->
      <template v-if="best.weight != null || trend">
        <p class="sec">
          历史最高与趋势
          <InfoHint
            class="sec-hint"
            title="两个数字的口径"
            content="历史最高：所有记录里最重的那一组，不限时间，是该动作的个人纪录。

近 14 天趋势：只看最近两周，每次训练取当天最好的 e1RM 连成线，按「越近权重越高」拟合一条直线，外推到今天。虚线是预测，不是已经做到的成绩。"
          />
        </p>
        <ExerciseTrendCard
          :best-weight="best.weight"
          :best-reps="best.reps"
          :best-date="best.date"
          :best-e1rm="best.e1rm"
          :trend="trend"
        />
      </template>

      <template v-if="curveDays.length">
        <p class="sec">
          重量曲线
          <!-- 曲线口径与「正式组」统计口径收进标题行右侧 InfoHint，标题行只留标题 -->
          <InfoHint
            class="sec-hint"
            title="曲线与历史口径"
            content="曲线连的是每次训练里的最大重量组。

历史成绩按正式组统计，热身组不计入训练量。训练量 = 组数 × 次数 × 重量。"
          />
        </p>
        <div class="curvebox">
          <WeightCurve :days="curveDays" :height="130" />
          <p class="lastline num">
            最近一次 {{ lastSetLine }}
            <span v-if="lastSetDate" class="ldate t-3">（{{ lastSetDate }}）</span>
          </p>
        </div>
      </template>

      <template v-if="exercise.exerciseId">
        <p class="sec">
          历史成绩
          <!-- PR / 1RM / 训练量都是圈内缩写与黑话：定义收进 InfoHint，卡面只留结论 -->
          <InfoHint
            class="sec-hint"
            title="术语与口径"
            content="1RM（一次最大重量）：某个动作只能标准完成 1 次的重量。本软件不直接测极限，按你练过的组次估算，所以叫 e1RM。

训练量 = 组数 × 次数 × 重量，热身组不计入；「最佳单次训练量」是单次训练里的最大值。"
          />
        </p>
        <ExerciseHistoryPanel :exercise-id="exercise.exerciseId" />
      </template>
    </template>
  </SheetModal>
</template>

<style scoped>
.titlerow {
  /* 标题 + 类型字章：左右 8（--gap-sm），标题行不该比正文块更松。 */
  gap: var(--gap-sm);
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
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-xs);
  /* 类型字章（「计时 / 有氧」＝这是哪一类）：色相保留的少数例外之一，
     但仅限 ≤ --fs-caption 且整屏只出现一枚 —— 本抽屉标题行正是如此。
     列表里的同款徽标（PlanDetailPage 逐动作行）不满足「只出现一次」，已改中性色。
     文字必须走 strong 层：tone 层（--c-balance）是给环和色块的高饱和档，
     压在同色 14% 的浅底上只有 3.2:1，小字读不清。 */
  background: var(--mod-program-soft);
  color: var(--mod-program-strong);
}

/* 小节标题行：右侧留帮助入口位（sec-hint 用 margin-left:auto 顶到行尾） */
.sec {
  /* 小节与上一段 16、与本节内容 8：这是「标题 ↔ 内容」的固定关系 */
  margin: var(--sp-16) 0 var(--gap-sm);
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

.curvebox {
  /* 抽屉内的分组面统一「圆角 16 / 内距 12」（--radius-m + --pad-card-tight）：
     图表四周留白一致，坐标轴不再一边 14 一边 10。 */
  border-radius: var(--radius-m);
  background: var(--surface-2);
  padding: var(--pad-card-tight);
}

.lastline {
  margin-top: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 最近一次的日期：结论的注脚，压到三级灰 */
.ldate {
  margin-left: var(--sp-6);
}

.mapcard {
  /* 与 .curvebox 同一档：两张图在同一个抽屉里，外框与内距必须一样。 */
  border-radius: var(--radius-m);
  background: var(--surface-2);
  padding: var(--pad-card-tight);
}

.unknown {
  margin: var(--sp-14) 0 0;
  padding: var(--sp-12) var(--sp-14);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

.stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  /* 参数格之间 12（卡片间距），与曲线框的外距一致 */
  gap: var(--gap-md);
}

.cell {
  background: var(--surface-2);
  border-radius: var(--radius-m);
  /* 四边同距 12（二级分组面 --pad-card-tight），原来左右比上下多 2。 */
  padding: var(--pad-card-tight);
}

.cell .v {
  font-size: var(--fs-title2);
  font-weight: var(--fw-light);
  letter-spacing: -0.5px;
}

/* 参数格标签：caption + text-2 —— 全抽屉最浅档（micro/text-3）会把
   「4 是组数还是次数」变成猜谜；值保持 .num 与 title2 不动 */
.cell .k {
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-top: var(--sp-2);
}

.tips {
  font-size: var(--fs-callout);
  color: var(--text-1);
  line-height: var(--lh-body);
  white-space: pre-line;
}
</style>
