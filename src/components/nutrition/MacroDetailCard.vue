<script setup lang="ts">
import { computed } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import { MACRO_GUIDES } from '@/config/dri'
import { macroStatsFrom, useNutritionStore } from '@/stores/nutrition'
import type { DailySummary } from '@/types'

/** 宏量营养素详解：当日进度数值（色点 + 名称 + 当前 / 目标）；作用与来源说明收进标题行 InfoHint。
 *  钠不进这张卡：它是上限类营养素，与其它微量元素一同在「微量元素」卡对照（那边有进度条
 *  与「上限」标注，且宏量卡只留三大宏量，与摄入总览过滤钠的域惯例一致）。
 *  默认读 nutrition store 的「今天」；传了 `summary` 就按那一份渲染（饮食历史回看某一天），
 *  与「摄入总览 / 微量元素」用的是同一份汇总。 */
const props = defineProps<{
  /** 指定日期的汇总；不传则用 store 的「今天」 */
  summary?: DailySummary | null
}>()

const n = useNutritionStore()

/** 区分「没传」与「传了 null」：前者回落 store，后者是「这天还没拿到数据」 */
const data = computed(() => (props.summary === undefined ? n.summary : props.summary))

const rows = computed(() =>
  // 钠只留在「微量元素」卡（那边有进度条与「上限」标注）：一张屏里同一个营养素只出现一处分母
  MACRO_GUIDES.map((g) => {
    const m = macroStatsFrom(data.value).find((x) => x.key === g.key)
    return {
      ...g,
      current: Math.round(m?.current ?? 0),
      target: Math.round(m?.target ?? 0),
      unit: m?.unit ?? 'g',
    }
  }).filter((r) => r.key !== 'sodiumMg'),
)
</script>

<template>
  <section class="card">
    <header class="head">
      <h2>宏量营养素</h2>
      <!-- 目标口径与科普全文收进标题行右侧一枚 InfoHint；卡面每行只留色点 + 名称 + 当前 / 目标 -->
      <InfoHint class="hint" title="宏量营养素">
        <p>行内「当前 / 目标」的目标取每日营养目标（在「饮食调整」页调整）。钠是上限类营养素，与其它微量元素一同放在「微量元素」卡对照。</p>
        <ul class="hint-list">
          <li v-for="r in rows" :key="r.key"><b>{{ r.label }}</b>：{{ r.desc }}</li>
        </ul>
      </InfoHint>
    </header>

    <ul class="list">
      <li v-for="r in rows" :key="r.key" class="item">
        <div class="row between">
          <span class="name row center">
            <i class="dot" :style="{ background: `var(${r.colorVar})` }" />
            {{ r.label }}
          </span>
          <span class="num val">
            {{ r.current }}<em>/ {{ r.target }}</em><i class="unit">{{ r.unit }}</i>
          </span>
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

/* InfoHint 插槽：科普全文（config/dri 的 desc）走列表 */
.hint-list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin: 0;
  /* 列表符号缩进：18 是 4/8 栅格外的排版值，取同值令牌（不是间距语义） */
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
  /* 单行数值行按 48 档：12 上下 + 16 字（行高 24）= 48。
     用 min-height + 居中而不是靠 padding 撑：三条的行高必须严格相等，
     否则右列数值每行基线差 1px，「一列对齐」就不成立。 */
  display: flex;
  align-items: center;
  min-height: var(--row-h);
  padding: var(--sp-12) 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

/* 名称 / 数值两端对齐：内层行必须吃满整行宽 */
.item > .row {
  width: 100%;
}

.name {
  /* 色点 + 名称：图标与文字左右 8 */
  gap: var(--gap-text-inline);
  font-size: var(--fs-subhead);
  /* 名称是标签不是读数：降一档到 semibold，把 bold 留给右侧的当前值 */
  font-weight: var(--fw-semibold);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.val {
  /* 当前 / 目标是这张卡的读数：16 bold，与名称（14 semibold）拉开一档；
     --fs-headline 在桌面档仍是 16（--fs-body 会降到 14，与名称同号就只剩字重差）。
     行高随之到 48（12×2 + 24），落在列表行规范的单行档上 */
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}

.val em {
  font-style: normal;
  /* 目标值是要读的依据（判断达没达标），不退到 --text-3；
     与当前值靠字重 + 字号两档拉开，不靠再压一档灰 */
  font-weight: var(--fw-regular);
  color: var(--text-2);
  font-size: var(--fs-caption);
  /* 数值与「/ 目标」是同一行内的最小一对：4（--gap-tight） */
  margin-left: var(--gap-tight);
}

/* 单位再降一档（micro + 三级灰）：它是量纲，不是第二个读数 */
.unit {
  margin-left: var(--gap-text);
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-regular);
  color: var(--text-3);
}
</style>
