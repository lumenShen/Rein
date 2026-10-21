<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue'

import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import AiTargetAdjustCard from '@/components/nutrition/AiTargetAdjustCard.vue'
import BodyTrackerCard from '@/components/nutrition/BodyTrackerCard.vue'
import TargetCalculator from '@/components/nutrition/TargetCalculator.vue'
import TargetsEditor from '@/components/nutrition/TargetsEditor.vue'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import type { DailyTargets } from '@/types'

/** 饮食调整 · 二级页：方案计算 / AI 智能调整 / 手动微调。 */
const n = useNutritionStore()
const { toast } = useToast()

/* ---- 手动微调（本地副本，防抖自动保存） ---- */
const targets = reactive<DailyTargets>({ kcal: 2000, protein: 80, carb: 250, fat: 65, sodiumMg: 1500, waterMl: 1700 })

onMounted(async () => {
  if (!n.profile) await n.loadProfile()
})

watch(
  () => n.profile?.targets,
  (t) => {
    if (t) Object.assign(targets, t)
  },
  { immediate: true },
)

let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(targets, () => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    await n.saveTargets({ ...targets })
    toast('每日目标已更新')
  }, 600)
})
</script>

<template>
  <div class="page">
    <!-- 桌面这几张卡要显式排一遍，所以每个根元素上都挂一个定位用的类（类会合并到组件根元素上） -->
    <PageHeader class="lp-head" title="饮食调整" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 方案计算器 -->
    <TargetCalculator class="lp-calc" />

    <!-- 体重 · 身高追踪 -->
    <BodyTrackerCard class="lp-body" />

    <!-- AI 智能调整 -->
    <AiTargetAdjustCard class="lp-ai" />

    <!-- 手动微调 -->
    <section class="card lp-targets">
      <header class="head">
        <h2>手动微调</h2>
        <PillChip tone="muted">自动保存</PillChip>
      </header>
      <TargetsEditor v-model="targets" />
    </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部沿用全站页头节奏的一格 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

/* 「自动保存」是界面推不出的那半句（六行步进器已明说「直接改」），
   做成中性胶囊与周围 --text-3 正文分层 */
.head .chip {
  margin-top: var(--gap-tight);
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   壳层已经把这页四张卡铺成两栏，但它是「逐行等高」的：方案计算器 ≈735px 旁边是
   体重·身高追踪 ≈540px，右列下方会空掉近 200px，下一行才继续。

   所以这里显式排一遍：
     · 方案计算器（最高的那张）吃掉左列两行；
     · 右列把「体重·身高追踪 + AI 智能调整」叠起来 —— 两列收尾高度 ≈735 / ≈785，基本齐平；
     · 「手动微调」退到最后通栏，六个步进器在桌面上摊成两列，
       免得一行从「能量」一路拉到卡片右缘的「−/+」。

   行号必须连页头一起写死：栅格一旦出现显式行，自动排布会从第一行起找空位，
   而页头这种占满整行的子项会一路找到最后一行才落地（页头被挤到卡片下面去）。

   本页是**显式排布**，所以列位置自己写死（不用 .d-full 那套缺省）。 */
.desk-main .rubber-layer > .lp-head {
  grid-row: 1;
}

.desk-main .rubber-layer > .lp-calc {
  grid-column: 1 / 2;
  grid-row: 2 / span 2;
}

.desk-main .rubber-layer > .lp-body {
  grid-column: 2 / 3;
  grid-row: 2;
}

.desk-main .rubber-layer > .lp-ai {
  grid-column: 2 / 3;
  grid-row: 3;
}

.desk-main .rubber-layer > .lp-targets {
  grid-column: 1 / -1;
  grid-row: 4;
}

/* 手动微调通栏后，六个步进器摊成两列（NumberStepper 自己的行内布局不动，只是两两并排）。
   分隔线只画在第二行往后：栅格是两列三行，原规则 `.grid > * + *` 会给右列顶格也画一条，
   悬在卡片顶上很突兀。 */
.desk-main .rubber-layer > .lp-targets :deep(.grid) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--desk-gap);
}

.desk-main .rubber-layer > .lp-targets :deep(.grid > * + *) {
  border-top: 0;
}

.desk-main .rubber-layer > .lp-targets :deep(.grid > *:nth-child(n + 3)) {
  border-top: 0.5px solid var(--line);
}
</style>
