<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Sparkles } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { mealTypeOfSlot } from '@/config/domain'
import { useModelsStore } from '@/stores/models'
import { useProgramStore } from '@/stores/program'
import { parseBlob } from '@/utils/programEngine'
import { todayStr } from '@/utils/date'
import { macroEnergyShare } from '@/utils/nutritionCalc'
import type { ProgramMeal } from '@/types'
import type { AiMenuMeal } from '@/ai/recipeGen'

/**
 * 方案今日菜单卡（营养页）：聚焦「今天按方案吃什么」。
 *
 * 从方案页搬来——菜单是饮食决策，归营养页；方案页只管方案本身。
 * 供能结构用横向堆叠条（不画大环），餐次列表是唯一事实源，
 * AI 菜单与模板回落共用同一渲染；AI 生成按需触发，生成一次落库稳定。
 */
const emit = defineEmits<{ log: [] }>()

const program = useProgramStore()
const models = useModelsStore()

const parsed = computed(() => {
  if (!program.active) return null
  try {
    return parseBlob(program.active)
  } catch {
    return null
  }
})

/** 今天在方案周期内的那一天；不在周期内（未开跑 / 已结束）整卡不渲染 */
const day = computed(() => parsed.value?.days.find((d) => d.date === todayStr()) ?? null)

const aiMeals = ref<AiMenuMeal[] | null>(null)
const aiLoading = ref(false)
const aiStatus = ref('')
const aiError = ref('')

/** AI 菜单优先、未生成时回落模板菜单；统一成 ProgramMeal 展示结构 */
const meals = computed<ProgramMeal[]>(() => {
  if (aiMeals.value) {
    return aiMeals.value.map((m) => ({
      mealType: mealTypeOfSlot(m.slot),
      slot: m.slot,
      name: m.name,
      items: m.items.map((it) => `${it.label} ${it.grams}g`),
      kcal: m.kcal,
      protein: m.protein,
      carb: m.carb,
      fat: m.fat,
    }))
  }
  return day.value?.meals ?? []
})

const targetProtein = computed(() => Math.round(parsed.value?.params.targets.protein ?? 0))

const totals = computed(() => {
  const sum = (k: 'kcal' | 'protein' | 'carb' | 'fat') => meals.value.reduce((s, m) => s + m[k], 0)
  const kcal = sum('kcal')
  const protein = sum('protein')
  const carb = sum('carb')
  const fat = sum('fat')
  const parts = macroEnergyShare(protein, carb, fat, { minPct: 0 })
  const pctOf = (key: 'protein' | 'carb' | 'fat') =>
    Math.round(parts.find((p) => p.key === key)?.pct ?? 0)
  return {
    kcal,
    protein,
    carb,
    fat,
    share: { p: pctOf('protein'), c: pctOf('carb'), f: pctOf('fat') },
  }
})

const macroBars = computed(() => [
  { key: 'p', label: '蛋白质', color: 'var(--c-protein)', v: totals.value.share.p, g: Math.round(totals.value.protein) },
  { key: 'c', label: '碳水', color: 'var(--c-carb)', v: totals.value.share.c, g: Math.round(totals.value.carb) },
  { key: 'f', label: '脂肪', color: 'var(--c-fat)', v: totals.value.share.f, g: Math.round(totals.value.fat) },
])

/** 目标区间 = 目标 ±10%；刻度右端 = 区间上界 × 1.25，点超出即顶格 */
const proteinScale = computed(() => {
  const target = targetProtein.value
  if (target <= 0) return null
  const lo = Math.round(target * 0.9)
  const hi = Math.round(target * 1.1)
  const max = hi * 1.25
  const pos = Math.min(totals.value.protein / max, 1)
  const loPct = (lo / max) * 100
  const hiPct = (hi / max) * 100
  return { lo, hi, pos, loPct, hiPct, inRange: totals.value.protein >= lo && totals.value.protein <= hi }
})

const verdict = computed(() => {
  const s = totals.value.share
  if (totals.value.kcal <= 0) return ''
  const training = !(day.value?.rest ?? true)
  const pText =
    s.p >= 25 && s.p <= 40
      ? `蛋白供能 ${s.p}%，落在 25–40% 的推荐区间`
      : s.p < 25
        ? `蛋白供能只占 ${s.p}%，低于 25–40% 的推荐区间——优先补足蛋白质再谈其他`
        : `蛋白供能 ${s.p}% 偏高，超出 25–40% 的推荐区间，碳水不足会影响训练表现`
  const cText = training
    ? '碳水集中在练前练后两餐，与训练时间匹配。'
    : '休息日碳水自然回落，属正常安排。'
  return `${pText}；${cText}`
})

/** 读取当天 AI 菜单缓存（未生成返回 null，回落模板） */
async function loadCached(): Promise<void> {
  aiMeals.value = null
  aiError.value = ''
  if (!program.active || !day.value) return
  try {
    aiMeals.value = await program.loadDayMeals(program.active, todayStr())
  } catch {
    /* 缓存读取失败按未生成处理 */
  }
}

async function regenerate(): Promise<void> {
  if (!program.active || !day.value) return
  aiLoading.value = true
  aiError.value = ''
  aiStatus.value = ''
  try {
    await models.load()
    aiMeals.value = await program.generateDayMeals(program.active, todayStr(), (s) => {
      aiStatus.value = s
    })
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiLoading.value = false
    aiStatus.value = ''
  }
}

onMounted(() => {
  void loadCached()
})

// 方案切换 / 调整重建后，当天菜单缓存可能已作废，重新读一次
watch(
  () => [program.active?.id, program.active?.version],
  () => void loadCached(),
)
</script>

<template>
  <section v-if="program.active && day" class="card menu-card" data-testid="program-menu">
    <header class="head">
      <b class="title">今日菜单</b>
      <StatusChip :tone="day.rest ? 'neutral' : 'accent'" size="md">
        {{ day.rest ? '休息日' : '训练日' }}
      </StatusChip>
      <!-- 两个「区间」的口径、AI 菜单的实算说明都收进这里：卡面只留结论 -->
      <InfoHint
        title="今日菜单"
        content="「今日菜单合计」是这份菜单的总热量，不等于今天已摄入的量（已吃的看上方「摄入总览」）。

蛋白结论里的「25–40% 推荐区间」指供能占比：蛋白质、碳水每克 4 大卡，脂肪每克 9 大卡，蛋白产热占三者之和的比例。

「蛋白目标区间」是另一个口径：蛋白目标 ±10%，单位是克。两个区间一个看比例、一个看克数，别混读。

AI 菜单的份量与营养数值按食物库实算，不是模型估算。"
      />
    </header>

    <!-- 菜单合计热量：本卡唯一主数值，单独成行 -->
    <div class="menu-total">
      <span class="mt-label">今日菜单合计</span>
      <span class="num mt-val">{{ Math.round(totals.kcal) }} 大卡</span>
    </div>

    <!-- 供能结构：横向堆叠条 + 三行宏量，标签只贴色条本身 -->
    <div class="stack-head">
      <span>供能结构</span>
    </div>
    <div class="stack" role="img" aria-label="三大营养素供能占比">
      <i
        v-for="m in macroBars"
        :key="m.key"
        :style="{ flex: Math.max(m.v, 1), background: m.color }"
        :title="`${m.label} ${m.v}%`"
      />
    </div>
    <div class="macros">
      <div v-for="m in macroBars" :key="`l${m.key}`" class="macro-row">
        <span class="macro-name">
          <i class="dot" :style="{ background: m.color }" />
          {{ m.label }}
        </span>
        <span class="num macro-val"><b>{{ m.g }}g</b> · {{ m.v }}%</span>
      </div>
    </div>

    <!-- 蛋白目标对照 -->
    <div v-if="proteinScale" class="ptarget">
      <div class="ptarget-head">
        <span>蛋白目标区间</span>
        <span class="num">{{ proteinScale.lo }}–{{ proteinScale.hi }}g</span>
      </div>
      <div class="ptarget-track">
        <i class="range" :style="{ left: `${proteinScale.loPct}%`, width: `${proteinScale.hiPct - proteinScale.loPct}%` }" />
        <i class="marker" :class="{ off: !proteinScale.inRange }" :style="{ left: `calc(${proteinScale.pos * 100}% - 4.5px)` }" />
      </div>
    </div>

    <p v-if="verdict" class="verdict">{{ verdict }}</p>

    <div class="split" />

    <!-- 来源标注：模板 / AI 各一枚胶囊；解释性口径收进标题行 InfoHint -->
    <p v-if="!aiMeals" class="menu-fallback menu-src">
      <PillChip size="sm" tone="muted">模板菜单</PillChip>
    </p>
    <p v-else class="ai-tag menu-src">
      <PillChip size="sm" tone="action">
        <Sparkles :size="12" />AI 菜单
      </PillChip>
    </p>
    <ul class="menu">
      <li v-for="m in meals" :key="m.slot">
        <em>{{ m.slot }}</em>
        <div>
          <p>{{ m.name }}<b class="num"> 约{{ Math.round(m.kcal) }}大卡 · 蛋白{{ Math.round(m.protein) }}g</b></p>
          <p class="items">{{ m.items.join('、') }}</p>
        </div>
      </li>
    </ul>

    <div class="menu-acts">
      <button class="linkbtn" @click="emit('log')">＋ 记一笔</button>
      <button class="linkbtn" :disabled="aiLoading" @click="regenerate">
        <template v-if="aiLoading">正在按你的目标与偏好生成…</template>
        <template v-else>
          <Sparkles v-if="!aiMeals" :size="13" style="margin-right:3px" />
          {{ aiMeals ? '换一批' : 'AI 生成今日菜单' }}
        </template>
      </button>
      <span v-if="aiLoading && aiStatus" class="ai-status num">{{ aiStatus }}</span>
      <span v-if="aiError" class="ai-err">{{ aiError }}</span>
    </div>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

/* 标题行右端的帮助入口（落点约定见 InfoHint 注释） */
.head .info-hint {
  margin-left: auto;
}

.title {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

/* 菜单合计：本卡唯一主数值（19px + .num + --text-1），
   与「摄入总览」报的今日已摄入热量分两句说 */
.menu-total {
  /* 与上方标题 8（标题与内容一档）；右侧数值与左标签之间至少 8 才不粘连 */
  margin-top: var(--gap-sm);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
}

.mt-label {
  font-size: var(--fs-caption);
  /* 它是主数值的标签，属于要读的信息 → --text-2 */
  color: var(--text-2);
}

.mt-val {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 供能堆叠条 */
.stack-head {
  /* 卡内区块之间 12；标签与它标注的条之间 8 */
  margin-top: var(--gap-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stack {
  display: flex;
  height: 10px;
  border-radius: var(--radius-full);
  overflow: hidden;
  /* 三段供能条之间 2（同一根条上的缝，再大会断成三根） */
  gap: var(--gap-text);
}

.stack i {
  display: block;
  height: 100%;
  opacity: 0.9;
  min-width: 4px;
}

.macros {
  margin-top: var(--gap-md);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap-sm);
}

.macro-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  /* 名称与数值是主次文本：上下 2 */
  gap: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.macro-name {
  display: inline-flex;
  align-items: center;
  /* 色点与名称：同一行最小呼吸 4 */
  gap: var(--gap-tight);
}

.dot {
  width: 8px;
  height: 8px;
  /* 色点走最小圆角档（4 的 4px 圆角落在 8px 方块上已经接近圆形，与图例点同一形态） */
  border-radius: var(--radius-xs);
}

.macro-val b {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

/* 蛋白对照刻度 */
.ptarget {
  margin-top: var(--gap-md);
}

.ptarget-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.ptarget-track {
  position: relative;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.ptarget-track .range {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--ok-soft);
}

.ptarget-track .marker {
  position: absolute;
  top: -0.5px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ok);
}

.ptarget-track .marker.off {
  background: var(--warn);
}

.verdict {
  margin-top: var(--gap-md);
  padding: var(--pad-card-tight);
  /* 落在白卡上的二级分组面：12（比母卡收一档） */
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.split {
  height: 0.5px;
  /* 分隔线两侧：上方区块 12、下方列表 4 */
  margin: var(--gap-md) 0 var(--gap-tight);
  background: var(--line);
}

/* 来源标注：胶囊承载「模板菜单 / AI 菜单」，说明口径收进标题行 InfoHint */
.menu-src {
  margin-top: var(--gap-md);
}

/* 餐次列表 */
.menu {
  margin-top: var(--gap-tight);
  display: grid;
}

.menu li {
  display: grid;
  grid-template-columns: 62px 1fr;
  /* 餐次名与菜名两列：12（有明显分栏，比同行间距大一档） */
  gap: var(--gap-md);
  /* 双行菜单行：10 上下 + 两行文本 ≈ 64 档 */
  padding: var(--sp-10) 0;
  border-top: 0.5px solid var(--line);
}

.menu li:first-child {
  border-top: none;
}

.menu em {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  /* 与右侧菜名的首行基线对齐：1px 是 12 字上的一格微调，取 2（--gap-text） */
  padding-top: var(--gap-text);
}

.menu p {
  font-size: var(--fs-subhead);
}

.menu p b {
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-left: var(--gap-tight);
  font-weight: var(--fw-regular);
}

.items {
  margin-top: var(--gap-text);
  line-height: var(--lh-body);
}

.menu-acts {
  display: flex;
  align-items: center;
  /* 文字链按钮组：无边界 8 */
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
}

.linkbtn {
  position: relative;
  display: inline-flex;
  align-items: center;
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 文字链按钮只有一行高（约 18）：上下各扩 13 把命中区补到 44。
   两枚按钮隔 8、且下方没有可点元素，扩出去不会吃掉别人的点击。 */
.linkbtn::after {
  content: '';
  position: absolute;
  inset: -13px -4px;
}

.linkbtn:disabled {
  opacity: var(--disabled-opacity);
}

.ai-err {
  font-size: var(--fs-caption);
  /* 错误是必须读出来的状态词：走文字档 --danger-strong */
  color: var(--danger-strong);
}

/* 生成中的流式活动摘要（匹配食材…） */
.ai-status {
  /* 生成中的活动摘要（「匹配食材…」）是状态播报，要读得出来 → --text-2 */
  font-size: var(--fs-caption);
  color: var(--text-2);
}
</style>
