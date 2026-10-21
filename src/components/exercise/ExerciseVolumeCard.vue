<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRight, Sparkles } from 'lucide-vue-next'
import MuscleMap from '@/components/exercise/MuscleMap.vue'
import MuscleCatchupSheet from '@/components/exercise/MuscleCatchupSheet.vue'
import TrainingScoreSheet from '@/components/exercise/TrainingScoreSheet.vue'
import { loadScoreInput } from '@/services/scoreInput'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { todayStr } from '@/utils/date'
import { computeTrainingScore, groupLevelMap, groupTooltipMap, type TrainingScoreResult } from '@/utils/trainingScore'
import { weakGroups } from '@/utils/weakMuscles'

/**
 * 肌肉热力图卡（运动页）：本周每块肌肉的**练够分**（《练够分 Lite》0–100，100 = 运动充分）。
 *
 * 呈现分两块，一块回答「哪里没练够」、一块回答「为什么、怎么补」：
 *  1. **身体热力图**（MuscleMap 的 heat 模式）：一眼看出分布 —— 正面/背面/侧面三视图，
 *     每块肌肉按所属评估组的练够分上色（低→高：红 / 琥珀 / 浅绿 / 实绿，未练为灰）。
 *     用图而不是只用列表，是因为「背没练够」这种事在列表里要靠读名字，在图上是一眼的事。
 *  2. **练够分说明抽屉**（TrainingScoreSheet）：以图表 + 文字讲清这个分怎么来的
 *     （频率 / 强度 / 体感 三维加权），逐肌群列分，并给出规范里的建议。
 *     点图与点卡头「说明 ›」进的是同一个抽屉。
 *
 * 与旧「本周容量」的区别：旧体系算的是**组数 vs MEV/MAV/MRV 地标**（只看量），
 * 练够分是**多维执行充分度**（频率 + 组数/次数/重量 + 体感，按目标加权），
 * 与《练够分 Lite》规范逐条对应（见 utils/trainingScore）。
 *
 * 输入除了逐组记录，还有近 42 天的运动记录（跑步/快走等按 utils/aerobicLoad 折成等效组）——
 * 纯跑步 / 纯手动补录的用户也能看到热力图，而不是整卡消失。
 * 两条记录一条都没有时整卡隐藏，不占位置。
 */
const exStore = useExerciseStore()
const lib = useExerciseLibStore()
const nutrition = useNutritionStore()

const result = ref<TrainingScoreResult | null>(null)
const loaded = ref(false)
/** 近 42 天是否有训练记录（逐组或运动记录）：都没有 = 这个评估指标对他没意义，整卡隐藏 */
const hasHistory = ref(false)
const sheetOpen = ref(false)
const catchupOpen = ref(false)

/** 热力档位：评估组分数投影到 39 个细肌群（同组同色） */
const heat = computed(() => (result.value ? groupLevelMap(result.value) : {}))

/** 悬停副标：「所属组 + 分数 + 档名」，比单个档名更有信息量 */
const heatRows = computed(() => (result.value ? groupTooltipMap(result.value) : {}))

/** 弱项：本周有记录但练够分 < 60（规范「不够」及以下） */
const weak = computed(() => (result.value ? weakGroups(result.value.groups) : []))

async function load(): Promise<void> {
  try {
    const today = todayStr()
    await lib.ensureLoaded()
    const { sets, workouts } = await loadScoreInput(today)
    hasHistory.value = sets.length > 0 || workouts.length > 0
    // 目标决定权重（增肌 30/50/20，减脂 35/35/30）—— 没有方案时按增肌
    await nutrition.loadProfile()
    result.value = computeTrainingScore({
      sets,
      workouts,
      library: lib.list,
      today,
      goal: nutrition.profile?.goal ?? null,
    })
  } catch (e) {
    console.warn('[score] 练够分统计失败', e)
    result.value = null
    hasHistory.value = false
  } finally {
    loaded.value = true
  }
}

onMounted(() => void load())

/**
 * 刷新：逐组记录落库（结束保存 / 删除训练）→ strengthRev；
 * 手动记 / 删一次运动 → weekWorkouts 变更（运动页本就常驻，不刷新的话新记的快走不进热力图）。
 */
watch(
  [() => exStore.strengthRev, () => exStore.weekWorkouts],
  () => void load(),
)

function openSheet(): void {
  sheetOpen.value = true
}
</script>

<template>
  <section v-if="!loaded || hasHistory" class="card">
    <header class="row between head">
      <h2>肌肉热力图</h2>
      <!-- 「说明 ›」：与「点图上任意位置」进的是同一个抽屉（练够分说明）。
           两条路都留着 —— 按钮是**可发现**的入口（卡片上没有任何别的地方提示图能点），
           点图是**顺手**的入口（手指本来就在图上）。22px 高的胶囊不占版面。 -->
      <button class="detail row center" type="button" aria-label="查看练够分的计算说明与建议" @click="openSheet">
        说明 <ChevronRight :size="13" :stroke-width="2.6" />
      </button>
    </header>

    <!-- 结论行：左边一句话说清"要不要管"，右边平均分回答"整体多少分"。
         平均分带来源标签（N 群平均）—— 不说清取自几个肌群，会被误读成整块热力图的总分 -->
    <div v-if="result" class="concl row between">
      <p class="headline">{{ result.summary }}</p>
      <span v-if="result.trainedCount" class="avg num">
        <b>{{ result.average }}</b> 分
        <i class="avgsrc">{{ result.trainedCount }} 群平均</i>
      </span>
    </div>

    <!-- 身体热力图：点图进练够分说明抽屉 -->
    <MuscleMap class="bodymap" :heat="heat" :heat-rows="heatRows" interactive @detail="openSheet" />

    <!-- 弱项加练：只在真有弱项时出现（没弱项时这个按钮点了也没内容可给） -->
    <button v-if="weak.length" class="catchup row center" type="button" @click="catchupOpen = true">
      <Sparkles :size="15" />
      弱项加练
      <small>{{ weak.length }} 个肌群练得不够</small>
    </button>

    <TrainingScoreSheet :open="sheetOpen" :result="result" @close="sheetOpen = false" />
    <MuscleCatchupSheet :open="catchupOpen" :weak="weak" @close="catchupOpen = false" />
  </section>
</template>

<style scoped>
/* 卡头：左标题、右「说明 ›」。用 between 把胶囊顶到最右 ——
   「说明」是这张卡唯一的可发现入口（卡片上没有别的地方提示图能点）。 */
.head {
  gap: var(--gap-sm);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

/* 「说明 ›」：与副标同一档字号，形态是胶囊（与画布卡的「详情 ›」同一套语汇）。
   色取 --accent-strong 而不是 --accent —— 后者压在 --surface-2 上实测只有
   4.27:1（亮）/ 3.82:1（暗），够不着 4.5；换成 strong 后是 5.54 / 5.31（量出来的）。 */
.detail {
  position: relative;
  gap: var(--gap-text);
  flex: none;
  /* 胶囊左右同距 12（--pad-inline），原来左右不等 */
  padding: var(--sp-4) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 「说明 ›」视觉 ~22 高不动，热区撑到 44+（规则 5）：
   上下各 12px 落在卡头与结论行之间，横向 8px 只压到不可点的标题。 */
.detail::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-12)) calc(-1 * var(--sp-8));
}

.detail:active {
  opacity: 0.6;
}

.concl {
  margin-top: var(--sp-8);
  gap: var(--sp-10);
}

.headline {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  min-width: 0;
}

/* 平均分：数字用标题档（它是这张卡的第二个焦点），单位小一号压在基线上。
   来源标签（N 群平均）与数字同色系但更浅，回答「这分取自几个肌群」。 */
.avg {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.avg b {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  letter-spacing: -0.3px;
}

.avgsrc {
  font-style: normal;
  margin-left: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 热力图：三视图并排，给足宽度（84px 是 MuscleMap 里定死的单视图宽，
   3 视图 + 间距 ≈ 300px，430 视口下卡片内正好放得下） */
.bodymap {
  /* 结论行与肌群图 8（标题与内容） */
  margin-top: var(--gap-sm);
}

.catchup {
  /* 图标与文字 8，入口与上方肌群图 12（卡内区块） */
  gap: var(--gap-sm);
  width: 100%;
  /* 视觉原本 ~40 高（10px 内距 + 14px 正文），补到 44 的热区下限；
     它是这张卡唯一的加练入口，整行可点，不该比卡头的小胶囊更难按。 */
  min-height: var(--hit-min);
  margin-top: var(--gap-md);
  padding: var(--sp-10) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

/* 按钮内两段字：主标签 700、计数 500 —— 层级靠字重与间距（gap）分，不靠 opacity。
   不用 --text-2 / --text-3：它们压在 --accent 实底上对比不足（见 doc「统一改法」）。 */
.catchup small {
  font-weight: var(--fw-medium);
  margin-left: var(--sp-2);
}
</style>
