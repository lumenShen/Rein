<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ChevronRight, Flame } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import ExerciseBars from '@/components/exercise/ExerciseBars.vue'
import WorkoutSourceTag from '@/components/exercise/WorkoutSourceTag.vue'
import { WORKOUT_META } from '@/config/domain'
import { useExerciseStore } from '@/stores/exercise'
import { fmtDateCn, minToHHmm, WEEKDAY_LABELS } from '@/utils/date'
import type { WorkoutType } from '@/types'

/** 本周运动概览：分钟柱状图 + 汇总 + 最近一次，并说明与能量平衡的联动。
 *  linkTo 传入二级页路径时整卡可点，右侧显示「详情」角标（与 EnergySummary 同款）。 */
const props = defineProps<{ linkTo?: string }>()

const ex = useExerciseStore()
const router = useRouter()

onMounted(() => {
  if (ex.weekWorkouts.length === 0) void ex.loadWeek()
})

/** 最近一次运动（store 的 recent 已按 id 倒序，[0] 就是最新那条） */
const latest = computed(() => ex.recent[0] ?? null)

/** 类型标签：行首那枚字章取它的首字（与 WorkoutRow 同一套语汇） */
const latestTypeLabel = computed(() =>
  latest.value ? WORKOUT_META[latest.value.type as WorkoutType].label : '',
)

/** 行首字章 */
const latestInitial = computed(() => latestTypeLabel.value.slice(0, 1))

/**
 * 副信息 = 日期（有开始时刻就带上）。
 * **刻意不再拼类型标签**：类型已经由图章那一个字表达了，而训练记录的名字常常
 * 本身就带类型（「力量训练 · 下肢」），再拼一遍会读出「力量训练 … · 力量训练」。
 */
const latestMeta = computed(() => {
  const w = latest.value
  if (!w) return ''
  const date = fmtDateCn(w.date)
  return w.startMin != null ? `${date} · ${minToHHmm(w.startMin)}` : date
})

const bars = computed(() =>
  ex.minutesByDay.map((d) => ({
    label: WEEKDAY_LABELS[(new Date(d.date).getDay() + 6) % 7],
    value: d.minutes,
    highlight: d.isToday,
  })),
)

function goDetail(): void {
  if (props.linkTo) void router.push(props.linkTo)
}
</script>

<template>
  <section
    class="card"
    :class="{ pressable: !!linkTo }"
    :role="linkTo ? 'button' : undefined"
    :tabindex="linkTo ? 0 : undefined"
    @click="goDetail"
    @keydown.enter="goDetail"
  >
    <header class="row between head">
      <h2>本周运动</h2>
      <div class="row head-right">
        <span class="sum num"><b>{{ ex.weekMinutes }}</b> 分钟 · {{ ex.weekKcal }} 大卡</span>
        <button v-if="linkTo" class="more row center pressable" aria-label="查看全部运动记录" @click.stop="goDetail">
          详情<ChevronRight :size="14" />
        </button>
      </div>
    </header>

    <ExerciseBars class="chart" :bars="bars" />

    <footer class="row foot">
      <Flame :size="15" style="color: var(--c-exercise)" />
      今日消耗 <b class="num">{{ ex.todayKcal }}</b> 大卡，已计入「能量与营养」
    </footer>

    <!-- 最近一次：原来首页底部有一整张「最近运动」卡（标题 + 列表 + 删除按钮），
         而它真正要说的只有一件事 ——「你最近练了这一次」。收成概览卡里的一行。
         行本身**不可点**：整张卡已经是「去全部运动记录」的入口，这里再挂一个点击区
         只会让人不知道点哪；要看细节就顺着卡走下去（用户要求「仅仅作为提示」）。
         只显示一条也是同一条理由：这是提示，不是列表。 -->
    <p v-if="latest" class="latest row">
      <i class="l-ic col center">{{ latestInitial }}</i>
      <span class="l-txt">
        <b>{{ latest.name }}</b>
        <!-- 最近一次的来源：手机同步进来的要标出来（本机的不标，见组件说明） -->
        <WorkoutSourceTag :source="latest.source" />
        <em class="num">{{ latestMeta }}</em>
      </span>
      <span class="l-num num">{{ latest.durationMin }} 分钟</span>
    </p>
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.head-right {
  gap: var(--gap-sm);
}

.sum {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.sum b {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 「详情」角标：与 EnergySummary 的 more 胶囊同款。
   26px 的视觉高度保持不动，热区用 ::after 撑到 44（落在卡头空白里）。 */
.more {
  position: relative;
  gap: var(--gap-text);
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.more::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: calc(100% + 12px);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
}

.chart {
  /* 卡内区块之间 12（规范），与 .foot 的 padding-top 同一档 */
  margin-top: var(--gap-md);
}

.foot {
  /* 卡内两组之间 12、组内图标与文字 8：原来 6/14 两处都不在一档上 */
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  padding-top: var(--sp-12);
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.foot b {
  color: var(--text-1);
}

/* 最近一次：一行，不做卡片。分割线比 .foot 那条浅一档 ——
   同一张卡里两条等重的分隔线会把这块切得像两个独立区域，
   而它是挂在概览下面的补充信息。 */
.latest {
  gap: var(--gap-sm);
  /* 分隔线两侧各留 12，与卡内其它区块同一条节奏（原来 10）。 */
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 0.5px solid var(--line);
  min-width: 0;
}

.l-ic {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--radius-s);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.l-txt {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
  min-width: 0;
  flex: 1;
}

.l-txt b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.l-txt em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
  white-space: nowrap;
}

.l-num {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  /* 整卡按压缩放交由全局 .pressable 过渡，这里仅关闭图表高度动画 */
  .chart :deep(.track i) {
    transition: none;
  }
}
</style>
