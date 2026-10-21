<script setup lang="ts">
import SheetModal from '@/components/common/SheetModal.vue'
import IntakeOverview from '@/components/nutrition/IntakeOverview.vue'
import MacroDetailCard from '@/components/nutrition/MacroDetailCard.vue'
import MicrosCard from '@/components/nutrition/MicrosCard.vue'
import { fmtDateCn } from '@/utils/date'
import type { DailySummary } from '@/types'

/**
 * 某一天的「营养实际全览」抽屉 —— 饮食历史里点那枚摄入总览进来。
 *
 * 它**不新建任何一套营养版式**：摄入总览 / 宏量营养素 / 微量元素三个组件与营养全览页
 * （/nutrition）、主页是同一份实现，只是各自多了一个可选的 `summary` prop ——
 * 页面级组件读 store 的「今天」，这里读选中的那一天。历史回看因此与今天逐像素同构，
 * 也就不存在「两套口径各画一遍、改一处漏一处」。
 *
 * 只有外壳要换：这三张在页面里是 `.card`（不透明白底 + 卡片落影），而抽屉面板在玻璃档
 * 本身就是半透明的 —— 页面级的底铺上去会跟着面板一起变薄，与面板糊成一片。所以统一换成
 * 抽屉白卡那一档材质（--sheet-card-fill / --sheet-card-shadow，见 tokens.css 那段注释），
 * 光学层跟着画质档位走，这里一行都不用改。
 */
defineProps<{
  open: boolean
  /** 查看的日期（YYYY-MM-DD） */
  date: string
  /** 该日汇总；null = 还没拿到（卡片会以 0 值渲染，不会串成今天的数字） */
  summary: DailySummary | null
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <SheetModal
    :open="open"
    initial-snap="large"
    :title="`营养全览 · ${fmtDateCn(date)}`"
    @close="emit('close')"
  >
    <section class="scard">
      <IntakeOverview :summary="summary" />
    </section>

    <div class="cards">
      <MacroDetailCard :summary="summary" />
      <MicrosCard :summary="summary" />
    </div>
  </SheetModal>
</template>

<style scoped>
/* ---------- 白卡：抽屉每一段内容的载体（与 TrainingScoreSheet / WeightAdviceSheet 同一份做法） ---------- */
.scard {
  /* 卡片内距 16；圆角取卡片档 16 —— 32 是半模态自己的圆角，里面再套一张 32 的卡
     会读成「两层同级的浮层」 */
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--sheet-card-fill);
  box-shadow: var(--sheet-card-shadow);
}

/* 首张卡与抽屉标题之间留一点呼吸（body 自身只有 4px 顶内边距） */
.scard:first-child {
  margin-top: var(--gap-sm);
}

/* ---------- 两张页面级卡片（宏量 / 微量元素）搬进抽屉 ----------
   传 class 改不动子组件根上的 .card（那是它自己 scope 的样式），所以用 :deep 换掉外壳；
   选择器带上 .cards 这一层：:deep 编译成「[本组件 scope] .card」，而子组件根才是那个
   带 scope 的元素，必须有本组件自己的祖先才匹配得上。 */
.cards {
  margin-top: var(--gap-md);
}

.cards :deep(.card) {
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--sheet-card-fill);
  box-shadow: var(--sheet-card-shadow);
}

.cards :deep(.card + .card) {
  margin-top: var(--gap-md);
}
</style>
