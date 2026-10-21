<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Footprints, ListChecks, PenLine } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import ExerciseVolumeCard from '@/components/exercise/ExerciseVolumeCard.vue'
import ExerciseWeekCard from '@/components/exercise/ExerciseWeekCard.vue'
import PlanRecentCard from '@/components/exercise/PlanRecentCard.vue'
import StrengthProgressCard from '@/components/exercise/StrengthProgressCard.vue'
import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import TodoListCard from '@/components/todo/TodoListCard.vue'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { useTodoStore } from '@/stores/todo'
import { todayStr } from '@/utils/date'

/** 运动页（训练主页）：周概览（含最近一次）+ 跑步/手动记快速入口 + 课程启动 + 运动负荷 + 运动待办。 */
const router = useRouter()
const ex = useExerciseStore()
const todo = useTodoStore()
const nutrition = useNutritionStore()
const today = todayStr()

onMounted(() => {
  void ex.loadWeek(today)
  void todo.loadDay(today)
  void nutrition.loadSummary(today)
  void nutrition.loadProfile()
})

const manualOpen = ref(false)
</script>

<template>
  <div class="page">
    <!-- 页首不留副标题：本周分钟与大卡紧跟在下方的「本周运动」卡里（同一份数据的同一处读数，
         两处各写一遍只会稀释首屏信息密度） -->
    <PageHeader title="运动" />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 整卡可点 → 全部运动记录二级页 -->
    <ExerciseWeekCard link-to="/sports/records" />

    <!-- 异常中断恢复提示已由导航栏上方的悬浮运动条（ActiveWorkoutBar）接管 -->

    <!-- 训练启动：跑步（沉浸 GPS）＋ 手动记（快速补录）＋ 动作库（动作唯一真源）。
         桌面加 d-half：三个磁贴并进右半栏，正好与左边「本周运动」那张周图配成一行 ——
         通栏铺开时每个磁贴会宽到 230px，读起来像把手机上的四列网格拉变了形。 -->
    <ul class="quick d-half">
      <li>
        <QuickTile label="跑步" icon-bg="var(--c-exercise-soft)" icon-color="var(--c-exercise-deep)" @click="router.push('/session/run')">
          <Footprints :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="手动记" icon-bg="var(--accent-soft)" icon-color="var(--accent-strong)" @click="manualOpen = true">
          <PenLine :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="动作库" icon-bg="var(--warn-soft)" icon-color="var(--warn-strong)" @click="router.push('/sports/exercises')">
          <ListChecks :size="20" />
        </QuickTile>
      </li>
    </ul>

    <!-- 训练启动：最近使用的三个课程（全部课程在二级页） -->
    <PlanRecentCard />

    <!-- 训练负荷：本周各肌群做组数 vs 科学建议区间（有力量记录才显示） -->
    <ExerciseVolumeCard />

    <!-- 力量进步：按动作查看重量变化曲线（有逐组记录才显示） -->
    <StrengthProgressCard />

    <!-- 运动类待办（与待办域联动） -->
    <TodoListCard :date="today" title="运动计划" filter-category="workout" />

    <!-- 最近运动已并入上方「本周运动」卡的一行提示（只显示一条）。
         原来这里是一整张卡（标题 + 记录列表 + 每行删除按钮），而它要说的只是
         「你最近练了这一次」—— 让它单独占一张卡，等于用列表的形态承载一句话。
         要看完整记录：走「本周运动」卡的「详情 ›」→ 全部运动记录（那里才有列表与详情抽屉）。 -->

    <!-- 手动记运动 -->
    <AddWorkoutSheet :open="manualOpen" @close="manualOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 快速入口：与主页同款四列磁贴网格 */
.quick {
  display: grid;
  /* 三颗磁贴（跑步/手动记/动作库）：列数跟着条目走，4 列会在右缘空出一格灰底 */
  grid-template-columns: repeat(3, 1fr);
  /* 磁贴之间与上下卡片之间都取 12（规范卡片间距），
     原来 10 / 14 两档混用，三颗磁贴与上方周卡看着比下方卡更近。 */
  gap: var(--gap-md);
  margin: var(--gap-md) 0;
}

/* 桌面：磁贴并进栅格后，上下那 14px 会变成行内错位（栅格已经用 gap 管间距） */
.desk-main .quick {
  margin: 0;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.list {
  margin-top: var(--sp-6);
}
</style>
