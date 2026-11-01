<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Footprints, Heart, ListChecks, PenLine } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import HeartRateSheet from '@/components/health/HeartRateSheet.vue'
import ExerciseVolumeCard from '@/components/exercise/ExerciseVolumeCard.vue'
import ExerciseWeekCard from '@/components/exercise/ExerciseWeekCard.vue'
import PlanRecentCard from '@/components/exercise/PlanRecentCard.vue'
import StrengthProgressCard from '@/components/exercise/StrengthProgressCard.vue'
import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import TodoListCard from '@/components/todo/TodoListCard.vue'
import { useExerciseStore } from '@/stores/exercise'
import { useHeartRateStore } from '@/stores/heartRate'
import { useNutritionStore } from '@/stores/nutrition'
import { useTodoStore } from '@/stores/todo'
import { motionOn } from '@/system/motion'
import { todayStr } from '@/utils/date'

/** 运动页（训练主页）：周概览（含最近一次）+ 跑步/手动记快速入口 + 课程启动 + 运动负荷 + 运动待办。 */
const router = useRouter()
const ex = useExerciseStore()
const todo = useTodoStore()
const nutrition = useNutritionStore()
const hr = useHeartRateStore()
const today = todayStr()

onMounted(() => {
  void ex.loadWeek(today)
  void todo.loadDay(today)
  void nutrition.loadSummary(today)
  // 心率区间需要年龄（由生日换算）；画像拉回来后同步给采集线程
  void nutrition
    .loadProfile()
    .then(() => hr.configureProfile(nutrition.profile))
    .catch(() => {})
})

const manualOpen = ref(false)
/** 设备管理抽屉：页头入口统一打开它（运动页不再占一张内容卡） */
const hrOpen = ref(false)

/**
 * 已连接设备。当前 BLE 链路只允许一个中心连接（数量恒 0/1），
 * 但文案按「N 个」写 —— 以后支持多设备时这里只换数据源，页头不用改。
 */
const hrConnectedDevices = computed(() => (hr.connected && hr.device ? [hr.device] : []))
const hrConnectedCount = computed(() => hrConnectedDevices.value.length)
const hrDeviceNames = computed(() => hrConnectedDevices.value.map((d) => d.name))

/** 轮播串：未连接只有「设备管理」；连接后「已连接设备 N 个」与各设备名轮流出现 */
const hrTexts = computed(() =>
  hrConnectedCount.value === 0
    ? ['设备管理']
    : [`已连接设备 ${hrConnectedCount.value} 个`, ...hrDeviceNames.value],
)
const hrTextIndex = ref(0)
const hrText = computed(() => {
  if (hrConnectedCount.value === 0) return '设备管理'
  // 关闭动效时不做轮播：把两段并成一句，信息不丢
  if (!motionOn.value) {
    return `已连接设备 ${hrConnectedCount.value} 个 · ${hrDeviceNames.value.join('、')}`
  }
  return hrTexts.value[hrTextIndex.value % hrTexts.value.length] ?? ''
})

let hrRotateTimer: ReturnType<typeof setInterval> | null = null
function stopHrRotate(): void {
  if (hrRotateTimer) {
    clearInterval(hrRotateTimer)
    hrRotateTimer = null
  }
}
/** 连接状态 / 设备名 / 动效开关任一变化：回到第一段，必要时重开轮播 */
function syncHrRotate(): void {
  stopHrRotate()
  hrTextIndex.value = 0
  if (!motionOn.value) return
  if (hrConnectedCount.value === 0 || hrTexts.value.length < 2) return
  hrRotateTimer = setInterval(() => {
    hrTextIndex.value = (hrTextIndex.value + 1) % hrTexts.value.length
  }, 3200)
}
watch([hrConnectedCount, hrDeviceNames, motionOn], syncHrRotate, { immediate: true })
onBeforeUnmount(stopHrRotate)

const hrAria = computed(() =>
  hrConnectedCount.value === 0
    ? '设备管理，打开心率设备'
    : `已连接 ${hrConnectedCount.value} 个设备：${hrDeviceNames.value.join('、')}，打开设备管理`,
)
</script>

<template>
  <div class="page">
    <!-- 页首不留副标题：本周分钟与大卡紧跟在下方的「本周运动」卡里（同一份数据的同一处读数，
         两处各写一遍只会稀释首屏信息密度） -->
    <PageHeader title="运动">
      <!-- 设备管理入口：统一挂在页头（不再占页内一张卡）。
           未连接 = 「设备管理」；连接后「已连接设备 N 个」与设备名轮播，点开是设备抽屉。 -->
      <template #action>
        <button
          type="button"
          class="hdr-btn pill hr-pill"
          :class="{ live: hrConnectedCount > 0 }"
          :aria-label="hrAria"
          @click="hrOpen = true"
        >
          <Heart :size="15" :stroke-width="2.1" aria-hidden="true" />
          <Transition name="hr-swap" mode="out-in">
            <span :key="hrText" class="hrtxt">{{ hrText }}</span>
          </Transition>
        </button>
      </template>
    </PageHeader>
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
        <QuickTile label="跑步" icon-bg="var(--mod-sports-soft)" icon-color="var(--mod-sports-strong)" @click="router.push('/session/run')">
          <Footprints :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="手动记" icon-bg="var(--mod-todo-soft)" icon-color="var(--mod-todo-strong)" @click="manualOpen = true">
          <PenLine :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="动作库" icon-bg="var(--mod-focus-soft)" icon-color="var(--mod-focus-strong)" @click="router.push('/sports/exercises')">
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

    <!-- 页头心率入口的设备抽屉 -->
    <HeartRateSheet :open="hrOpen" @close="hrOpen = false" />
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

/* 设备管理入口：几何与材质沿用 PageHeader 的 .hdr-btn.pill（圆角已在那边重置为胶囊），
   这里补状态色、固定宽度与轮播。固定宽度是为了轮播换字时不把页头标题挤得左右跳：
   14px 下「Xiaomi Smart Band 8」约 141px，留一点余量。 */
.hr-pill svg {
  color: var(--text-2);
  transition: color var(--dur-fast) var(--ease-standard);
}

.hr-pill.live {
  min-width: 196px;
  justify-content: center;
}

.hr-pill.live svg {
  color: var(--danger);
}

/* 文本区：一条单行，超长设备名截断（完整名称在抽屉里） */
.hrtxt {
  display: inline-block;
  max-width: 148px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 轮播换字：轻微上移淡出 / 上移淡入。关闭动效（motion off）时走下面的
   prefers-reduced-motion 兜底，状态直接切换。 */
.hr-swap-enter-active,
.hr-swap-leave-active {
  transition:
    opacity 160ms var(--ease-out),
    transform 160ms var(--ease-out);
}

.hr-swap-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.hr-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .hr-swap-enter-active,
  .hr-swap-leave-active {
    transition: none;
  }
}

.list {
  margin-top: var(--sp-6);
}
</style>
