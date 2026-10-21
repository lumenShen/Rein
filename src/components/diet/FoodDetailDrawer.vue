<script setup lang="ts">
import { computed } from 'vue'
import { Plus } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import NutritionMicroList from '@/components/diet/NutritionMicroList.vue'
import { useGrowOnOpen } from '@/composables/useGrowOnOpen'
import { fmtNutrient } from '@/utils/format'
import { buildMicroRows, macroEnergyShare } from '@/utils/nutritionCalc'
import type { Food } from '@/types'

/** 食品详情抽屉：每 100g 全营养表 + 宏量供能占比 + 份量换算 + 微量对照 DRI；「记录」交由父层打开 FoodPickerSheet。 */
const props = defineProps<{
  open: boolean
  food: Food | null
}>()

const emit = defineEmits<{
  close: []
  record: []
}>()

/* 宏量供能占比（口径在 utils/nutritionCalc） */
const share = computed(() => {
  const f = props.food
  if (!f) return []
  return macroEnergyShare(f.protein, f.carb, f.fat)
})

/** 微量营养素：每 100g 含量 + 占每日推荐（或上限）摄入的百分比 */
const microRows = computed(() => buildMicroRows(props.food, { onlyPositive: true }))

/* 数据入场：抽屉展开后供能条/微量条从零生长 */
const grown = useGrowOnOpen(() => props.open)
</script>

<template>
  <SheetModal :open="open" :title="food?.name ?? '食品详情'" @close="emit('close')">
    <template v-if="food">
      <div class="anim" :class="{ grown }">
      <!-- 热量 + 宏量 -->
      <section class="card hero">
      <div class="row between top">
        <div>
          <p class="kcal num"><b>{{ fmtNutrient(food.kcal) }}</b><em> 大卡</em></p>
          <p class="per t-3">/ 100 g</p>
        </div>
        <ul class="macros row">
          <li v-for="m in share" :key="m.label">
            <i class="dot" :style="{ background: `var(${m.colorVar})` }" />
            <span class="ml">{{ m.label }}</span>
            <b class="num">{{ fmtNutrient(m.grams) }}g</b>
          </li>
        </ul>
      </div>

      <!-- 供能占比堆叠条 -->
      <div v-if="share.length" class="share" :style="{ '--n': share.length }">
        <span
          v-for="(m, i) in share"
          :key="m.label"
          :style="{ flex: m.pct, background: `var(${m.colorVar})`, '--i': i }"
        />
      </div>
      <!-- 「供能占比」是行话：做行首标签，三项占比各一枚带色点胶囊（色条靠同一色点认色） -->
      <p v-if="share.length" class="share-label">
        <span class="sl-label">供能占比</span>
        <span v-for="m in share" :key="m.label" class="spill">
          <i class="dot" :style="{ background: `var(${m.colorVar})` }" />
          {{ m.label }}<b class="num">{{ Math.round(m.pct) }}%</b>
        </span>
      </p>
    </section>

    <!-- 份量换算 -->
    <section v-if="food.units.length" class="card">
      <header class="head"><h2>份量换算</h2></header>
      <ul class="units">
        <li v-for="u in food.units" :key="u.name" class="row between urow">
          <span>1 {{ u.name }}</span>
          <span class="num t-3">≈ {{ u.grams }}g</span>
          <b class="num">≈ {{ Math.round((food.kcal * u.grams) / 100) }} 大卡</b>
        </li>
      </ul>
    </section>

    <!-- 微量营养素 · 对照每日推荐摄入 -->
    <section v-if="microRows.length" class="card">
      <!-- 口径上提分组头：完整说明（DRI 出处 / 上限语义）收进标题行右侧 InfoHint -->
      <header class="head">
        <h2>微量营养素</h2>
        <InfoHint
          class="hint"
          title="微量营养素：口径"
          content="每 100g 含量占《中国居民膳食营养素参考摄入量》成人每日推荐摄入的比例；标记「上限」的项目（如添加糖、钠）对照的是每日建议上限。"
        />
      </header>
      <NutritionMicroList :rows="microRows" :grown="grown" />
    </section>

    <!-- 记录：交给父层打开 FoodPickerSheet（同页单一弹层）；悬浮吸附在抽屉底部，内容从下方滚过 -->
    <div class="record-dock">
      <button class="record row center" @click="emit('record')">
        <Plus :size="18" /> 记录这一食物
      </button>
    </div>
      </div>
    </template>
    <p v-else class="missing">食物不存在或已下架</p>
  </SheetModal>
</template>

<style scoped>
.missing {
  text-align: center;
  padding: var(--sp-40) 0;
  font-size: var(--fs-subhead);
  color: var(--text-3);
}

.card {
  /* 抽屉里的分组面：卡间距 12、内距 16、圆角取卡片档 16（20 是按钮档） */
  margin-top: var(--gap-md);
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.card:first-child {
  margin-top: var(--gap-tight);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

/* 卡头是 flex 行：帮助入口放标题行右端（与标题同一行居中） */
.head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.head .hint {
  margin-left: auto;
}

.hero .top {
  align-items: flex-start;
}

.kcal b {
  font-size: var(--fs-display-m);
  font-weight: var(--fw-bold);
  letter-spacing: -1px;
}

.kcal em {
  font-style: normal;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.per {
  /* 负值是「把单位行拉回大数字基线」的补偿，必须与 --gap-text 同步 */
  margin-top: calc(-1 * var(--gap-text));
  font-size: var(--fs-footnote);
}

.macros {
  gap: var(--gap-md);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.macros li {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.ml {
  color: var(--text-2);
}

.macros b {
  font-weight: var(--fw-bold);
}

.share {
  display: flex;
  /* 三段之间有 2 的缝：再大就断成三根条而不是一条占比 */
  gap: var(--gap-text);
  height: 10px;
  margin-top: var(--gap-lg);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.share span:first-child {
  border-radius: var(--radius-full) 0 0 var(--radius-full);
}

.share span:last-child {
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
}

/* 入场：供能段从左向右逐个展开（30ms stagger），微量条同步生长 */
.anim:not(.grown) .share span {
  transform: scaleX(0);
}

.share span {
  transform-origin: left center;
  transition: transform var(--dur-base) var(--ease-standard);
  transition-delay: calc(var(--i, 0) * 30ms);
}

.share-label {
  margin-top: var(--gap-sm);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  /* 行首标签与三枚占比胶囊是一组无边界元素：组内 8 */
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 「供能占比」是行话：做行首标签（比占比读数重一档） */
.sl-label {
  color: var(--text-2);
}

/* 三项占比各一枚胶囊：前导色点与堆叠条同色，认色不靠文字 */
.spill {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 迷你占比胶囊：上下 2、左右 8 */
  padding: var(--gap-text) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-2);
}

.spill b {
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.units {
  margin-top: var(--gap-sm);
}

.urow {
  /* 换算行：12 上下 + 一行 18 ≈ 42；行间用发丝线分隔，不再另加间距 */
  padding: var(--sp-12) 0;
}

.urow + .urow {
  border-top: 0.5px solid var(--line);
}

/* 悬浮记录按钮：sticky 吸附在抽屉底部；负 margin 抵消 .body 的内边距贴到边缘，
   渐变遮罩保证内容滚过时按钮可读；遮罩区不拦截触摸（pointer-events），滚动手势可穿透。
   出血量与侧内距都取 --pad-sheet（SheetModal 内容区的左右内距）—— 写死 18 是 SheetModal
   还没收编成 16 时的旧值，硬编码会在抽屉内距改档时悄悄错位 2px。 */
.record-dock {
  position: sticky;
  bottom: 0;
  z-index: 1;
  margin: var(--sp-16) calc(-1 * var(--pad-sheet)) calc(-1 * var(--pad-sheet) - var(--safe-bottom));
  padding: var(--sp-12) var(--pad-sheet) calc(var(--sp-16) + var(--safe-bottom));
  background: linear-gradient(to top, var(--surface) 55%, transparent);
  pointer-events: none;
}

.record {
  width: 100%;
  /* 图标与文字 8；高度取底部操作区同档的 48（--row-h）：
     与「删除这条记录」等抽屉底部按钮同高，52 高出这一档 4px */
  gap: var(--gap-sm);
  height: var(--row-h);
  /* 按钮圆角档 20：32 是半模态自己的圆角，按钮套用会读成第二层浮层 */
  border-radius: var(--radius-l);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
  box-shadow: var(--shadow-float);
  pointer-events: auto;
}
</style>
