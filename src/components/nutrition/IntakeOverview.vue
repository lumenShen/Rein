<script setup lang="ts">
import { computed } from 'vue'

import { macroStatsFrom, useNutritionStore, type MacroStat } from '@/stores/nutrition'
import type { DailySummary } from '@/types'

/**
 * 「目标线」的落点（条宽比例）＝ 目标的 100%。
 *
 * 条的总量程取 `目标 ÷ 此值`，于是右边天然空出 `1 - 此值` 一条超标区：
 * 色条越过这条线就是吃超了，不必读数字。调小 = 更早预警，但「还没吃满」时条看着更空。
 * 这是本版式的产品口径，目前只由这一个组件消费，所以就近放在这里；
 * 若将来别处也要画同款条，再提到 config 里共用。
 */
const CAL_LINE_RATIO = 0.7

/**
 * 摄入总览：热量与三大宏量共用一套版式，四根条上都立着一枚「目标线」小胶囊。
 *
 * **线为什么在 70%**：条的总量程取 `目标 ÷ 0.7`，于是目标的 100% 恒落在条宽的 70% 处，
 * 右侧空出来的三成就是超标区 —— 越没越线一眼可见，不必去读数字。改 `CAL_LINE_RATIO`
 * 就是改这条线的宽容度：调小则更早预警，代价是「还没吃满」阶段条看着更空。
 *
 * **两种语义别混**（同一根线，含义相反）：
 *   · 热量是**上限**（目标 + 运动加回）：越线 = 吃超了，主数字与「已超」转危险色；
 *   · 宏量是**目标**：越线 = 达标了，是好事，所以不上任何危险色。
 * 线本身恒为中性灰、不随超标变色 —— 把「超了」交给数据本身（色条压过灰线）去表达，
 * 比让参考线变色更克制，也避免四根条上出现四根红柱子。
 *
 * **为什么用 span 而不是 ul/li**：本组件要嵌进移动端那枚整条可点的 `<button>`，
 * 而 button 只允许短语内容，`ul` 会构成非法 HTML。版式全部由 flex/grid 承担，语义无损失。
 *
 * **数据来源可换**（饮食历史「回看某一天」）：传了 `summary` 就完全按它渲染，
 * 一个字段都不读 store —— **必须区分「没传」与「传了 null」**：没传（undefined）才回落
 * 到 store 的「今天」；传 null 表示这一天还没拿到数据，此时读 store 会串成今天的数字。
 */
const props = defineProps<{
  /** 窄卡（桌面便当的 hero 格只有 4/12 列宽）降一档字号，否则数字会把卡撑破 */
  dense?: boolean
  /** 指定日期的汇总；不传则用 store 的「今天」 */
  summary?: DailySummary | null
}>()

const n = useNutritionStore()

/** 本组件渲染的那一份数据 */
const data = computed(() => (props.summary === undefined ? n.summary : props.summary))

const kcalIntake = computed(() => Math.round(data.value?.intake.kcal ?? 0))
const kcalTarget = computed(() => Math.round(data.value?.targets.kcal ?? 0))
const exerciseKcal = computed(() => Math.round(data.value?.exerciseKcal ?? 0))
const kcalRemaining = computed(() => Math.max(0, kcalTarget.value + exerciseKcal.value - kcalIntake.value))

/** 目标线位置（条宽 %）＝ 目标的 100% */
const LINE = CAL_LINE_RATIO * 100

/** 热量上限 = 目标 + 运动加回（与 store 的 `剩余可吃` 同一口径，不会自相矛盾） */
const ceiling = computed(() => kcalTarget.value + exerciseKcal.value)
/** 条的量程：上限 ÷ 0.7 */
const calDomain = computed(() => Math.max(1, ceiling.value / CAL_LINE_RATIO))

/** 比例 → 条宽 %，并钳到 [0,100]：吃爆时条不该冲出容器 */
const pctOf = (ratio: number): number => Math.max(0, Math.min(1, ratio)) * 100

const eatPct = computed(() => pctOf(kcalIntake.value / calDomain.value))
/** 运动加回：把上限从「目标」抬到「上限」的那一段，正好贴在线前 */
const exLeft = computed(() => pctOf(kcalTarget.value / calDomain.value))
const exWidth = computed(() => pctOf(exerciseKcal.value / calDomain.value))

/** 超出上限的大卡数；0 = 没超 */
const overKcal = computed(() => Math.max(0, kcalIntake.value - ceiling.value))
/** 越线的那一小段（条宽 %）。已封顶在超标区的三成里 */
const overWidth = computed(() => Math.max(0, eatPct.value - LINE))

/** 宏量条与热量条同一套几何：目标恒落在同一根线上 */
function macroPct(m: MacroStat): number {
  return m.target <= 0 ? 0 : pctOf((CAL_LINE_RATIO * m.current) / m.target)
}

/** 顶栏只放三大宏量；钠是限量项、单位不同，留在营养全览里 */
const coreMacros = computed(() => macroStatsFrom(data.value).filter((m) => m.key !== 'sodiumMg'))
</script>

<template>
  <div class="ov" :class="{ dense }">
    <div class="head">
      <span class="eyebrow">摄入总览</span>
      <span class="head-act"><slot name="action" /></span>
    </div>

    <div class="hero">
      <b class="big num" :class="{ over: overKcal > 0 }">{{ kcalIntake }}</b>
      <span class="target num">/ {{ kcalTarget }} 大卡</span>
      <span class="rest" :class="{ over: overKcal > 0 }">
        <span class="rest-k">{{ overKcal > 0 ? '已超' : '剩余可吃' }}</span>
        <b class="rest-v num">{{ overKcal > 0 ? overKcal : kcalRemaining }}</b>
      </span>
    </div>

    <div class="bar lg">
      <div class="track">
        <span class="seg ex" :style="{ left: `${exLeft}%`, width: `${exWidth}%` }" />
        <span class="seg eat" :style="{ width: `${eatPct}%` }" />
        <span v-if="overKcal > 0" class="seg over" :style="{ left: `${LINE}%`, width: `${overWidth}%` }" />
      </div>
      <span class="ref" :style="{ left: `${LINE}%` }" />
    </div>

    <!-- 图例只说配色归属：数字在上方主读数里（同一 kcalIntake 在图例里再报一遍，
         会被误读成另一件事） -->
    <div class="legend">
      <span class="li"><i class="dot" style="background: var(--c-intake)" />已吃</span>
      <span v-if="exerciseKcal > 0" class="li"><i class="dot" style="background: var(--c-exercise)" />运动加回</span>
      <span class="li"><span class="glyph" />目标线</span>
    </div>

    <!-- 三大宏量是卡内的二级分组：用浅井 + 12 圆角收成一组（施工单 §1「卡内分组面」），
         不再用一条分隔线把卡片切成两半 —— 线只能表达「这里断开」，
         井还能表达「这三项属于同一组、且比上方总览低一档」。 -->
    <div class="well">
      <div class="macros">
        <div v-for="m in coreMacros" :key="m.key" class="mc">
          <span class="m-label">{{ m.label }}</span>
          <div class="bar sm">
            <div class="track">
              <span class="seg" :style="{ width: `${macroPct(m)}%`, background: `var(${m.colorVar})` }" />
            </div>
            <span class="ref" :style="{ left: `${LINE}%` }" />
          </div>
          <span class="m-val">
            <b class="m-cur num">{{ Math.round(m.current) }}</b>
            <span class="m-tgt num">/{{ Math.round(m.target) }}<i class="m-unit">{{ m.unit }}</i></span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ov {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* ── 标头 ── */
.head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-width: 0;
}

/* 卡片标题：与「今日画布」「宏量营养素」等全站 36 个卡片同一规格
   （即各卡 `.head h2` 那套：--fs-title3 / 700 / 字距 -0.3px）。
   此前这里是 14px 的小标签，与同级卡片标题排在一屏里明显矮一截。 */
.eyebrow {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-1);
}

/* 右侧动作（桌面卡的「详情」角标）：推到行尾，不受标题宽度影响 */
.head-act {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

/* ── 主数字 ── */
.hero {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  /* 数值与单位是同一行的主次文本：左右 8、上距标题 8（标题与内容一档） */
  gap: var(--gap-text-inline);
  margin-top: var(--gap-sm);
}

.big {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -1.2px;
  line-height: 1;
  /* 摄入量是数值：数值一律中性色（色彩配额，STANDARDS §4）。
     一屏只留一个英雄数字（就是它）；「吃超了」由条上那段红（.seg.over）与
     「已超」文案表达，不再让英雄数字本身翻红 —— 彩色数字互相争注意力，
     而颜色一旦从图元泄漏到文字上，就没有任何东西能再当强调。 */
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.target {
  font-size: var(--fs-callout);
  color: var(--text-2);
}

.rest {
  margin-left: auto;
  display: flex;
  align-items: baseline;
  gap: var(--gap-tight);
}

/* 「剩余可吃」组降一级：它不是这一屏的英雄（英雄是左边的摄入量），
   数值降到 title3、标签退到 caption + text-2 —— 参考实现里英雄值:标签 ≈ 3.2:1，
   两个同等字号的英雄数字会让读者不知道先看哪个。 */
.rest-k {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.rest-v {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  line-height: 1;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

/* ── 条 + 目标线 ──
   线要上下探出条身，所以它必须待在裁切容器（.track）之外，
   否则会被 overflow:hidden 切平，120% 的高度就白给了。 */
.bar {
  position: relative;
  height: 12px;
  /* 主读数与条之间 12（卡内区块）：此前是裸值，改用语义令牌 */
  margin-top: var(--gap-md);
}

.bar.sm {
  height: 8px;
  margin-top: 0;
}

/* 空槽必须用**半透明深色薄涂**，不能用 --surface-2：
   移动端这条 banner 没有卡片壳、直接贴页面底色，而 --surface-2 (#f2f2f4) 与页面底
   几乎同一个灰 —— 空条会整根隐形（0 摄入时只剩目标线那几枚胶囊浮着，像贴歪的装饰）。
   半透明涂会按底下是什么自动加深：贴浅灰页面一档、落白卡里又一档，两处都立得住。 */
.track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 18%, transparent);
  overflow: hidden;
}

.seg {
  position: absolute;
  top: 0;
  bottom: 0;
  display: block;
}

.bar.lg .seg.eat {
  left: 0;
  background: var(--c-intake);
}

.bar.lg .seg.ex {
  background: var(--c-exercise);
}

/* 越线那一小段：红条压在灰线上的部分，语义即「吃超了」 */
.bar.lg .seg.over {
  background: var(--danger);
}

.ref {
  position: absolute;
  top: -10%;
  height: 120%;
  width: 3px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 34%, transparent);
  transform: translateX(-50%);
}

/* ── 图例 ── */
.legend {
  display: flex;
  flex-wrap: wrap;
  /* 图例项之间 12（同一组要读得清归属），与上方条之间 8 */
  gap: var(--gap-md);
  margin-top: var(--gap-sm);
}

.li {
  display: flex;
  align-items: center;
  /* 色点与图例文字：图标 + 文字左右 8 太松，取同一行最小呼吸 4 */
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  color: var(--text-2);
  white-space: nowrap;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.glyph {
  position: relative;
  width: 3px;
  height: 12px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 34%, transparent);
  flex: none;
}

/* 宏量分组面：内距 12（二级分组比母卡收一档）、块间 12、圆角 12。
   底色用 --surface-inset 而不是 --surface-2：这块也会出现在没有卡片壳的首页横幅上，
   实色灰压在页面底（#f5f5f7）上几乎不可见；混色井跟着底下那层走，两种底都成立。 */
.well {
  margin-top: var(--gap-md);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
}

/* ── 三大宏量 ── */
.macros {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap-md);
}

.mc {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  min-width: 0;
}

.m-label {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  /* 宏量名是要读的信息（不是补充注脚），退到 --text-2；--text-3 只留给真正可略的注 */
  color: var(--text-2);
}

.m-val {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  /* 「当前值」与「/目标值」是同一行里最小的一对主次文本：
     至少留 4（--gap-tight），否则 20/80g 会粘成一个数 */
  gap: var(--gap-tight);
}

/* 宏量数字走中性色，**不**用各自的指标色：
   四个指标色都是给「色块」设计的，当文字用在浅底上全部不达标
   （#34C759 ≈1.7:1、#FF9F0A ≈2.0:1、#FFCC00 ≈1.4:1，AA 要 4.5:1），脂肪那档几乎糊没。
   颜色留在条上，数字回中性 —— 整屏的数字（摄入、剩余可吃、三大宏量）至此全部中性，
   色相只出现在色点、进度条与图例上（色彩配额，STANDARDS §4）。 */
.m-cur {
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  line-height: 1;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.m-tgt {
  font-size: var(--fs-caption);
  /* 「/ 目标值」是判断达没达标的另一半依据，必须读得出来 */
  color: var(--text-2);
}

/* 单位再降一档：目标值是数、g 只是量纲。三列里「67 /80 g」曾读成两个 20 号大字，
   就是因为单位和目标数同字号；单位落 micro + --text-3，数字才是这行的落点。 */
.m-unit {
  margin-left: var(--gap-text);
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ── 窄卡（桌面便当 hero 格）降一档 ──
   注意选择器必须写成 `.ov.dense …`：`dense` 与 `ov` 是**同一个元素上的两个类**，
   写成 `.dense .ov` 是后代选择器，永远匹配不到（这里踩过一次）。
   标题两处一致（都是卡片标题规格），所以这里不再覆写它；
   要降的是大数字，否则 4/12 列宽装不下。
   另外那张卡被 bento 拉满整格高（不填满就会漏出灰底，整行读成没画完），
   用 `min-height` 而不是 `height`：内容变多时照常往下长。

   **不写 justify-content: space-between**：desktop 上这一格被拉到与「待办」同高时，
   均匀铺开会在标题／数字／条／图例之间同时张开四道大缝，读起来像四个互不相干的块。
   改成「上组（标题+数字+条+图例）贴顶、下组（分隔线+三大宏量）贴底」——
   只留**一道**缝，且那道缝正好落在分隔线上，层级关系反而更清楚。 */
.ov.dense {
  min-height: 100%;
}

.ov.dense .hero {
  /* 窄卡再收一档：6 是 4/8 表里的一格，保住「标题—主数字」不散开 */
  margin-top: var(--sp-6);
}

/* 下组（宏量井）贴底：缝隙全部落在井的上边距里，只此一道 */
.ov.dense .well {
  margin-top: auto;
}

.ov.dense .big {
  font-size: var(--fs-title2);
  letter-spacing: -0.8px;
}

.ov.dense .rest-v {
  font-size: var(--fs-headline);
}

.ov.dense .m-cur {
  font-size: var(--fs-headline);
}
</style>
