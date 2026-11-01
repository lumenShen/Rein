<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue'
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
import { useMarqueeText } from '@/composables/useMarqueeText'
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

/**
 * 胶囊宽度只认这一句：「已连接设备 N 个」。它是隐藏 sizer 的文本，也是 marquee
 * 视口的宽度来源 —— 设备名再长也只会在视口里滚动，不会把页头标题挤得左右跳。
 * 未连接时退回「设备管理」的自身宽度（那是另一个状态，不预留连接态的宽度）。
 */
const hrSizerText = computed(() =>
  hrConnectedCount.value === 0 ? '设备管理' : `已连接设备 ${hrConnectedCount.value} 个`,
)
/** 跑马灯内容：计数在前、设备名在后（静止时先读到的是完整的状态） */
const hrStatusText = computed(() =>
  hrConnectedCount.value === 0
    ? '设备管理'
    : `${hrSizerText.value} · ${hrDeviceNames.value.join('、')}`,
)

const hrViewEl = useTemplateRef<HTMLElement>('hrView')
const hrInnerEl = useTemplateRef<HTMLElement>('hrInner')
const hrCopyEl = useTemplateRef<HTMLElement>('hrCopy')
const { isOverflow: hrOverflow, isScrolling: hrScrolling } = useMarqueeText(
  hrStatusText,
  motionOn,
  { view: hrViewEl, inner: hrInnerEl, copy: hrCopyEl },
)

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
           未连接 = 「设备管理」；连接后计数与设备名在同一行里跑马灯 —— 宽度由隐藏
           sizer 的「已连接设备 N 个」钉死，长设备名只在视口内滚动，页头不跟着抖。 -->
      <template #action>
        <button
          type="button"
          class="hdr-btn pill hr-pill"
          :class="{ live: hrConnectedCount > 0 }"
          :aria-label="hrAria"
          @click="hrOpen = true"
        >
          <Heart :size="15" :stroke-width="2.1" aria-hidden="true" />
          <span class="hr-text">
            <span class="hr-sizer" aria-hidden="true">{{ hrSizerText }}</span>
            <!-- 视口叠在 sizer 上：宽度取 sizer，内容只做 transform 位移 -->
            <span
              ref="hrView"
              class="hr-view"
              :class="{ 'is-overflow': hrOverflow, 'is-scrolling': hrScrolling }"
            >
              <span ref="hrInner" class="hr-track">
                <span ref="hrCopy" class="hr-copy">{{ hrStatusText }}</span>
                <span v-if="hrOverflow" class="hr-copy" aria-hidden="true">{{ hrStatusText }}</span>
              </span>
            </span>
          </span>
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
   这里补状态色与文本视口。

   **宽度不跟内容走**：.hr-sizer 用一句看不见的「已连接设备 N 个」把胶囊钉在这个尺寸，
   跑马灯视口绝对定位叠在它上面。设备名再长也只改 .hr-track 的内部宽度（由 transform
   平移），胶囊与页头标题的布局一次算好、滚动期间不再重排 —— 这正是换字动画做不到的：
   那条路每次换串都要重新量文本、挤一下标题。 */
.hr-pill svg {
  color: var(--text-2);
  transition: color var(--dur-fast) var(--ease-standard);
}

.hr-pill.live svg {
  color: var(--danger);
}

.hr-text {
  position: relative;
  display: inline-block;
  flex: none;
}

/* 连接态在计数句末留出渐隐带的宽度：静止时「个」字完整可见，不会一上来就糊在半截 */
.hr-pill.live .hr-text {
  padding-right: 10px;
}

.hr-sizer {
  display: block;
  visibility: hidden;
  white-space: nowrap;
}

/* 视口：宽度/高度都取 sizer 的盒子，左右边缘由 mask 渐隐 */
.hr-view {
  position: absolute;
  inset: 0;
  overflow: hidden;
  white-space: nowrap;
}

.hr-track {
  display: inline-block;
  width: max-content;
  white-space: nowrap;
}

/* 副本之间留 24px 空档：循环接缝处两份文本不会连成一个词。
   JS 按这个 margin 算周期，改宽度不用改脚本。 */
.hr-copy {
  display: inline-block;
  white-space: nowrap;
  margin-right: var(--sp-24);
}

/* 溢出：右缘 10px 渐隐 —— 静止时就宣告「后面还有（设备名）」 */
.hr-view.is-overflow {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 10px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 10px), transparent 100%);
}

/* 滚动中补上左缘渐隐：文字从左侧化入，而不是被视口硬切一刀。
   mask-image 是离散属性做不了补间，两态直接切换（发生在开始/停止滚动的那一帧）。 */
.hr-view.is-overflow.is-scrolling {
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 10px,
    #000 calc(100% - 10px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 10px,
    #000 calc(100% - 10px),
    transparent 100%
  );
}

/* 只有真的在滚动时才提升合成层：静止的页头不该常驻一张 will-change 的贴图 */
.hr-view.is-scrolling .hr-track {
  will-change: transform;
}

/* 关闭动效 / 系统减弱动效：不做位移（JS 侧已停），保留右缘渐隐作溢出提示。
   静止时视口恰好停在计数句上，信息不丢。 */

.list {
  margin-top: var(--sp-6);
}
</style>
