<script setup lang="ts">
import { computed } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { useNutritionStore } from '@/stores/nutrition'
import { buildMicroRows } from '@/utils/nutritionCalc'
import type { DailySummary } from '@/types'

/** 微量元素全览：逐项对照 DRI 的数值与进度条；作用与来源说明收进标题行 InfoHint。
 *  默认读 nutrition store 的「今天」；传了 `summary` 就按那一份渲染（饮食历史回看某一天）。 */
const props = defineProps<{
  /** 指定日期的汇总；不传则用 store 的「今天」 */
  summary?: DailySummary | null
}>()

const n = useNutritionStore()

/** 区分「没传」与「传了 null」：前者回落 store，后者是「这天还没拿到数据」 */
const data = computed(() => (props.summary === undefined ? n.summary : props.summary))

const cells = computed(() =>
  buildMicroRows(data.value?.intake, { clampPct: true, roundValue: true }),
)
</script>

<template>
  <section class="card">
    <header class="head">
      <h2>微量元素</h2>
      <!-- 口径（DRI 出处 / 「上限」语义）与 14 项科普全文收进标题行右侧一枚 InfoHint -->
      <InfoHint class="hint" title="微量元素">
        <p>数值对照《中国居民膳食营养素参考摄入量》（DRI）的成人每日推荐量；标「上限」的项目（如添加糖、钠）是每天不要超过的量。</p>
        <ul class="hint-list">
          <li v-for="c in cells" :key="c.key"><b>{{ c.label }}</b>：{{ c.desc }}</li>
        </ul>
      </InfoHint>
    </header>

    <ul class="list">
      <li v-for="c in cells" :key="c.key" class="item" :class="{ over: c.over }">
        <div class="row between top">
          <span class="name">
            {{ c.label }}
            <StatusChip v-if="c.isLimit" tone="warn" size="sm">上限</StatusChip>
          </span>
          <span class="num val">
            {{ c.value }}<em>/ {{ c.dri }}</em><i class="unit">{{ c.unit }}</i>
          </span>
        </div>
        <div class="bar">
          <i :style="{ '--p': `${c.pct}%`, background: `var(${c.over ? '--danger' : '--accent'})` }" />
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 卡头是 flex 行：标题 + 帮助入口同行（入口在标题右端） */
.head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.head .hint {
  margin-left: auto;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

/* InfoHint 插槽：14 条科普全文（config/dri 的 desc）走列表 */
.hint-list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin: 0;
  /* 列表符号缩进：取同值令牌（不是间距语义） */
  padding-left: var(--sp-18);
}

.hint-list li {
  line-height: var(--lh-body);
}

.hint-list b {
  font-weight: var(--fw-semibold);
}

.list {
  /* 标题与内容之间 8 */
  margin-top: var(--gap-sm);
}

.item {
  /* 双行数值行（名称·数值 + 进度条）按 64 档：12 上下 + 一行 24 + 条 4 + 间距 8 ≈ 60。
     用 min-height 钉住，14 行扫读时每根进度条落在同一节拍上；多出的 4 由居中均分，
     不堆在行底（否则条会贴着下一条的发丝线）。 */
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: var(--row-h-double);
  padding: var(--sp-12) 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.top {
  /* 数值行与下方进度条之间 8：条要读得出属于哪一行，但不能与行间分隔线混为一谈 */
  margin-bottom: var(--gap-sm);
}

.item.over .val {
  /* 超标是状态词，要读得清：实底档 --danger 当文字只有约 3.4:1，
     文字档 --danger-strong 才过 AA（STANDARDS §4 的 soft/实底分档同一条理由） */
  color: var(--danger-strong);
}

.name {
  font-size: var(--fs-subhead);
  /* 名称是标签不是读数：semibold 让位给右侧 bold 的当前值 */
  font-weight: var(--fw-semibold);
  /* 行名 + 「上限」胶囊同一行居中：文字与胶囊左右 8（--gap-text-inline） */
  display: inline-flex;
  align-items: center;
  gap: var(--gap-text-inline);
}

.val {
  /* 当前 / DRI 是这张卡的读数：16 bold（与宏量卡同一档；--fs-headline 桌面档不降，
     保证与 14 的名称始终差一档） */
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}

.val em {
  font-style: normal;
  font-weight: var(--fw-regular);
  /* DRI 对照值是判断「够没够」的另一半，必须读得出来 → --text-2（原 --text-3 只有 3:1） */
  color: var(--text-2);
  font-size: var(--fs-caption);
  /* 数值与「/ DRI」是同一行内的最小一对：4 */
  margin-left: var(--gap-tight);
}

/* 单位：micro + 三级灰，和数字不同粗也不同档（量纲不是读数） */
.unit {
  margin-left: var(--gap-text);
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-regular);
  color: var(--text-3);
}

.bar {
  height: 4px;
  border-radius: var(--radius-full);
  /* 底槽必须看得见：--surface-2 (#f2f2f4) 压在白卡 (#ffffff) 上只差 3 阶，
     截图里 14 根条像悬空的一截蓝线。--surface-3 是「贴白卡、必须被读出来」那一档。 */
  background: var(--surface-3);
  overflow: hidden;
}

.bar i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}
</style>
