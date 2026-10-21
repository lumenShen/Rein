<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Camera, SlidersHorizontal, Sparkles } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import EnergySummary from '@/components/nutrition/EnergySummary.vue'
import MacroDetailCard from '@/components/nutrition/MacroDetailCard.vue'
import DietChecksCard from '@/components/nutrition/DietChecksCard.vue'
import MicrosCard from '@/components/nutrition/MicrosCard.vue'
import ProgramMenuCard from '@/components/nutrition/ProgramMenuCard.vue'
import { useDietStore } from '@/stores/diet'
import { useFeaturesStore } from '@/stores/features'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import { todayStr } from '@/utils/date'

/** 营养全览 · 二级页：能量总览 + 宏量/微量元素详解 + 记饮食/改目标快捷入口。
 *  方案生效时多一张「今日菜单」卡（菜单归营养，方案页只管方案）。 */
const router = useRouter()
const today = todayStr()

const nutrition = useNutritionStore()
const diet = useDietStore()
const program = useProgramStore()
const features = useFeaturesStore()

onMounted(() => {
  void nutrition.loadSummary(today)
  void diet.load(today)
  // 关掉方案模块时不产生请求（与主页同一条纪律）
  if (features.isEnabled('program')) void program.load()
})

const quickOpen = ref(false)
</script>

<template>
  <div class="page">
    <PageHeader title="营养全览" subtitle="能量 · 宏量与微量元素详解" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 快捷入口：三个一级动作收成一组。外框用 .card.sub（base.css：surface-inset 浅井 /
         radius-l / 14px 内距 / 无影）—— 三格各自仍是白面磁贴（QuickTile 自带），
         浅井只负责把它们读成「一组快捷入口」，而不是三张互不相干的卡。 -->
    <ul class="card sub quick">
      <li>
        <QuickTile label="记饮食" icon-bg="color-mix(in srgb, var(--c-intake) 12%, transparent)" icon-color="var(--c-intake)" @click="quickOpen = true">
          <Camera :size="20" />
        </QuickTile>
      </li>
      <li>
        <!-- --warn-soft 与手写 rgba 同值同色相；--cat-study 是待办分类色里的学习紫，
             图标本色就在 soft 底上，不另起一份 rgba -->
        <QuickTile label="改目标" icon-bg="var(--warn-soft)" icon-color="var(--warn)" @click="router.push('/nutrition/adjust')">
          <SlidersHorizontal :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="AI 助手" icon-bg="var(--accent-soft)" icon-color="var(--cat-study)" @click="router.push('/ai')">
          <Sparkles :size="20" />
        </QuickTile>
      </li>
    </ul>

    <!-- 能量与宏量进度（复用首页卡片） -->
    <EnergySummary />

    <!-- 方案生效时的今日菜单：吃什么归营养页；生成按需，未生成回落模板 -->
    <ProgramMenuCard @log="quickOpen = true" />

    <!-- 宏量详解：与左侧「能量与营养」配成一行（两张都是纵向长卡，高度也接近）。

         类别打卡与微量元素**通栏**：微量元素卡展开后有 1300px 高，跟一张 227px 的
         打卡卡并排，右半边会空出一整屏；它们的内容本来就是「左标签 + 右数值」的
         宽行，铺满一行反而更好读。 -->
    <MacroDetailCard class="block-start" />
    <DietChecksCard class="d-full" />
    <MicrosCard class="d-full" />

    <!-- 弹层 -->
    <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部沿用全站页头节奏的一格（--page-pad-top 36 目前全库没有页面在用） */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 快捷三格：外框是 .card.sub（base.css），这里只管「三列等宽 + 间隙」。
   三格是同一组无边界磁贴：组内取 8（--gap-sm），比卡片间距小一档才读得成「一组」。
   与下方卡片的间距交给全局 `.card + .card`（12px）—— 它现在也是 .card 了，
   原来的 margin-bottom 收掉，否则会叠成两倍卡间距 */
.quick {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap-sm);
  /* 三格是同一个浅井里的三枚磁贴：内距收到 12（二级分组面）、圆角 12。
     base.css 的 .card.sub 还是上一版手感（20 圆角 / 14 内距）—— 页面上只有这一处
     用到它，就在这里按施工单的口径收口，不去动共享样式。 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m-nest);
}

/* 分组之间 24（施工单 §1「区块之间」）：「今日状态」这一组（快捷入口 / 摄入总览 /
   今日菜单）与下方「详解」这一组（宏量 / 打卡 / 微量元素）不是同级卡片，
   12 会让六张卡读成一条没有段落的流水。特指度压过 base.css 的 `.card + .card`。 */
.page .block-start {
  margin-top: var(--gap-xl);
}
</style>
