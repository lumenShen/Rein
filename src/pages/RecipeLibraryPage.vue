<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { LoaderCircle, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { dietService } from '@/services/dietService'
import { useModelsStore } from '@/stores/models'
import { useNutritionStore } from '@/stores/nutrition'
import { generateAiMenu, type AiMenuMeal } from '@/ai/recipeGen'
import type { RecipeTemplate } from '@/utils/recipeFilter'
import { isRestricted, RECIPES } from '@/utils/recipeFilter'

/**
 * 食谱库：浏览内置食谱模板（营养由食物库实算），标记喜欢/不喜欢——
 * 偏好会改进方案引擎选菜；右上「AI 定制」按当日目标生成一日菜单（数值仍实算）。
 */
const n = useNutritionStore()
const models = useModelsStore()

const filter = ref<string>('all')
const prefs = ref<Record<string, 1 | -1>>({})

onMounted(async () => {
  await Promise.all([n.loadProfile(), loadPrefs()])
})

async function loadPrefs(): Promise<void> {
  const list = await dietService.recipePrefsList()
  prefs.value = Object.fromEntries(list.map((p) => [p.recipeId, p.rating]))
}

const MEAL_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
]
const MEAL_TYPE_LABEL: Record<string, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }

const restrictions = computed(() =>
  (n.profile?.dietRestrictions ?? []).map((r) => r.trim()).filter(Boolean),
)

/** 忌口命中（与方案引擎共用 recipeFilter 的双向匹配规则） */
const isRestrictedFor = (r: RecipeTemplate): boolean => isRestricted(r, restrictions.value)

const visible = computed(() =>
  filter.value === 'all' ? RECIPES : RECIPES.filter((r) => r.mealType === filter.value),
)

/** 点按已选标记 = 清除；否则写入（乐观更新） */
async function togglePref(r: RecipeTemplate, rating: 1 | -1): Promise<void> {
  const current = prefs.value[r.id]
  try {
    if (current === rating) {
      prefs.value = { ...prefs.value }
      delete prefs.value[r.id]
      await dietService.recipePrefsClear(r.id)
    } else {
      prefs.value = { ...prefs.value, [r.id]: rating }
      await dietService.setRecipePref(r.id, rating)
    }
  } catch (e) {
    await loadPrefs()
    throw e
  }
}

/* ---- AI 定制菜单 ---- */
const aiOpen = ref(false)
const aiMealsCount = ref('4')
const aiGenerating = ref(false)
const aiMeals = ref<AiMenuMeal[]>([])
const aiWarnings = ref<string[]>([])
const aiError = ref('')
/** 流式过程：已流出餐次的名称预览（工具名与原始入参是开发者日志，不上屏） */
const aiStreamMeals = ref<{ name: string; slotHint: string }[]>([])

async function startAiMenu(): Promise<void> {
  aiOpen.value = true
  aiError.value = ''
  await generateAi()
}

async function generateAi(): Promise<void> {
  const profile = n.profile
  if (!profile) throw new Error('个人资料未加载')
  aiGenerating.value = true
  aiError.value = ''
  aiMeals.value = []
  aiWarnings.value = []
  aiStreamMeals.value = []
  try {
    await models.load()
    const cfg = models.defaultModel()
    if (!cfg) throw new Error('未配置 AI 模型，请先在「AI › 管理模型」添加')
    const likes = Object.entries(prefs.value)
      .filter(([, v]) => v === 1)
      .map(([id]) => RECIPES.find((r) => r.id === id)?.name ?? id)
    const dislikes = Object.entries(prefs.value)
      .filter(([, v]) => v === -1)
      .map(([id]) => RECIPES.find((r) => r.id === id)?.name ?? id)
    const res = await generateAiMenu(
      cfg,
      {
        targets: profile.targets,
        mealsCount: Number(aiMealsCount.value) as 3 | 4 | 5,
        restrictions: restrictions.value,
        likes,
        dislikes,
      },
      {
        onMeals: (meals) => (aiStreamMeals.value = meals),
      },
    )
    aiMeals.value = res.meals
    aiWarnings.value = res.warnings
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiGenerating.value = false
  }
}

const aiTotal = computed(() =>
  aiMeals.value.reduce(
    (s, m) => ({ kcal: s.kcal + m.kcal, protein: s.protein + m.protein }),
    { kcal: 0, protein: 0 },
  ),
)
</script>

<template>
  <div class="page">
    <PageHeader
      title="食谱库"
      :subtitle="`${RECIPES.length} 个模板 · 营养由食物库实算`"
      back
    />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- AI 定制入口（桌面上这条横幅通栏，理由见样式里的桌面段） -->
    <section class="card d-full ai-card">
      <div class="row" style="gap: var(--gap-md)">
        <i class="ai-ic center"><Sparkles :size="18" /></i>
        <div class="col flex-1" style="gap: var(--gap-text)">
          <div class="ai-head">
            <b>AI 定制一日菜单</b>
            <InfoHint
              title="AI 菜单的营养口径"
              content="菜单里的热量与蛋白、碳水、脂肪，按 AI 选中的食材从食物库逐项实算得出，不是按经验公式估算。

这套口径与页头说明一致：食谱库的全部数值都实算自食物库。"
            />
          </div>
          <span class="t-3 ai-sub">按你的目标与偏好生成</span>
        </div>
        <button class="ai-go pressable" @click="startAiMenu">生成</button>
      </div>
    </section>

    <!-- 餐次过滤 -->
    <SegmentedControl v-model="filter" :options="MEAL_FILTERS" class="seg" />

    <!-- 食谱列表（d-grid：桌面上按 2 栏摊开，栏数缺省就是 2） -->
    <ul class="rlist d-grid">
      <li v-for="r in visible" :key="r.id" class="row rrow" :class="{ off: isRestrictedFor(r) }">
        <div class="col flex-1" style="gap: var(--gap-tight); min-width: 0">
          <p class="rname">
            {{ r.name }}<em class="slot">{{ MEAL_TYPE_LABEL[r.mealType] }}</em>
            <span v-if="isRestrictedFor(r)" class="badge">忌口</span>
          </p>
          <p class="rmeta num">
            <b class="rkcal">{{ r.baseKcal }}<span>大卡</span></b>
            <span class="rmac">蛋白 {{ r.baseProtein }}g</span>
            <span class="rmac">碳水 {{ r.baseCarb }}g</span>
            <span class="rmac">脂肪 {{ r.baseFat }}g</span>
          </p>
          <p class="tags t-2">
            <span v-for="a in r.allergens" :key="a" class="tag">{{ a }}</span>
            <span v-if="!r.allergens.length" class="tag">无常见过敏原</span>
          </p>
        </div>
        <div class="row prefs">
          <button
            class="pf pressable"
            :class="{ on: prefs[r.id] === 1 }"
            :aria-label="`喜欢 ${r.name}`"
            @click="togglePref(r, 1)"
          >
            <ThumbsUp :size="15" />
          </button>
          <button
            class="pf pressable"
            :class="{ on: prefs[r.id] === -1 }"
            :aria-label="`不喜欢 ${r.name}`"
            @click="togglePref(r, -1)"
          >
            <ThumbsDown :size="15" />
          </button>
        </div>
      </li>
    </ul>

    <!-- AI 菜单弹层 -->
    <SheetModal :open="aiOpen" title="AI 定制一日菜单" initial-snap="large" @close="aiOpen = false">
      <div class="ai-panel">
        <div class="row between">
          <p class="t-2">每日餐次</p>
          <SegmentedControl
            v-model="aiMealsCount"
            :options="[
              { value: '3', label: '3 餐' },
              { value: '4', label: '4 餐' },
              { value: '5', label: '5 餐' },
            ]"
            class="seg-sm"
          />
        </div>

        <template v-if="aiError">
          <p class="ai-err">{{ aiError }}</p>
          <button class="ai-go wide pressable" @click="generateAi">重试</button>
        </template>

        <template v-else-if="aiGenerating">
          <p class="t-2 center ai-wait">正在按你的目标设计菜单并实算营养…</p>
          <!-- 流式：只说人话状态（工具名 + 原始 JSON 入参是开发者日志，不上屏），
               已流出的餐次逐个上屏 -->
          <p class="t-3 center ai-tool">
            <LoaderCircle :size="13" class="spin" /> 正在从食物库匹配食材…
          </p>
          <ul v-if="aiStreamMeals.length" class="ai-meals">
            <li v-for="(m, i) in aiStreamMeals" :key="i">
              <p class="ai-mhead">
                <em>{{ m.slotHint || '餐次' }}</em>{{ m.name }}<span class="caret" aria-hidden="true" />
              </p>
            </li>
          </ul>
        </template>

        <template v-else-if="aiMeals.length">
          <div class="ai-total-row">
            <p class="ai-total num">
              <span class="ai-total-lab">全天合计</span><b>{{ aiTotal.kcal }}</b>大卡
            </p>
            <PillChip v-if="n.profile" size="sm">目标 {{ n.profile.targets.kcal }} 大卡</PillChip>
            <span class="ai-protein num">蛋白 {{ aiTotal.protein }}g</span>
          </div>
          <ul class="ai-meals">
            <li v-for="(m, i) in aiMeals" :key="i">
              <p class="ai-mhead">
                <em>{{ m.slot }}</em>{{ m.name }}<b class="num"> 约{{ m.kcal }} 大卡</b>
              </p>
              <p class="t-3 ai-items">{{ m.items.map((it) => `${it.label} ${it.grams}g`).join('、') }}</p>
            </li>
          </ul>
          <p v-for="w in aiWarnings" :key="w" class="t-3 ai-warn">{{ w }}</p>
          <div class="row" style="gap: var(--gap-md)">
            <button class="ai-go wide pressable" style="flex: 1" @click="generateAi">换一批</button>
            <button class="ai-done pressable" style="flex: 1" @click="aiOpen = false">完成</button>
          </div>
        </template>
      </div>
    </SheetModal>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部沿用全站页头节奏的一格 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.ai-card {
  background: var(--accent-soft);
}

.ai-ic {
  width: 38px;
  height: 38px;
  flex: none;
  /* 图标容器是**小容器**档 8：《圆角参数》16 给内容容器，卡片里再套一张同级圆角
     会读成「又一张卡」而不是一枚图标底板 */
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
}

.ai-card b {
  font-size: var(--fs-callout);
}

/* 标题行右端挂说明入口（与生成键同行不同元素，卡头是标题所在行的右端） */
.ai-head {
  display: flex;
  align-items: center;
  /* 标题与说明入口：4·8 表里的一格 6 */
  gap: var(--sp-6);
}

.ai-sub {
  font-size: var(--fs-caption);
}

.ai-go {
  position: relative;
  flex: none;
  /* 胶囊按钮：上下 6 + 14 字 ≈ 32（小号档），左右 12 */
  padding: var(--sp-6) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

/* 32 的胶囊「生成」键：命中区纵向补到 44（横向由按钮宽度承担） */
.ai-go::after {
  content: '';
  position: absolute;
  inset: -6px 0;
}

.ai-go.wide {
  /* 通栏按钮高 40 档（12 上下 + 14 字），圆角取按钮档 20 */
  padding: var(--sp-12) 0;
  border-radius: var(--radius-l);
}

.ai-done {
  padding: var(--sp-12) 0;
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.seg {
  margin-top: var(--gap-md);
}

.rlist {
  /* 分段控件与列表之间 12；食谱卡之间 12（卡间距） */
  margin-top: var(--gap-md);
  display: grid;
  gap: var(--gap-md);
}

.rrow {
  /* 列间 12；卡片内距 16、圆角取卡片档 16（20 是按钮/入口那一档） */
  gap: var(--gap-md);
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.rrow.off {
  /* 忌口行整行降级走禁用浓度令牌，不写裸值 —— 0.45 会把该读的数值一起压掉 */
  opacity: var(--disabled-opacity);
}

.rname {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  /* 名称与「早/午/晚」小标、忌口角标：无边界 6 */
  gap: var(--sp-6);
}

.rname .slot {
  font-style: normal;
  font-weight: var(--fw-medium);
  font-size: var(--fs-micro);
  color: var(--text-3);
  /* 迷你角标：上下 2、左右 8 */
  padding: var(--sp-2) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.badge {
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  /* soft 底上的文字走 strong 档（--danger 压 soft 底不够 AA，STANDARDS §4） */
  color: var(--danger-strong);
}

/* 营养行：热量是主数值（19px + 等宽），三项宏量降为次要项 ——
   一行四个同字号数字要扫读的人逐个读完才有结论 */
.rmeta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  /* 行内 4、换行后 10：热量与三项宏量是四项并列读数 */
  gap: var(--gap-tight) var(--sp-10);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.rmeta .rkcal {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.rmeta .rkcal span {
  margin-left: var(--gap-tight);
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-2);
}

.rmeta .rmac {
  color: var(--text-2);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  /* 过敏原标签一组：组内 4，与营养行之间 4 */
  gap: var(--gap-tight);
  margin-top: var(--gap-tight);
}

.tag {
  font-size: var(--fs-micro);
  padding: var(--sp-2) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.prefs {
  flex: none;
  /* 两颗圆形图标钮各自带底，属「有明确边界」的控件：组内 16。
     这 16 同时是热区余量 —— 每颗 32 + 6×2 = 44，两个热区刚好相接、不互相吃掉。 */
  gap: var(--gap-lg);
}

.pf {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-3);
  display: grid;
  place-items: center;
}

/* 32 的圆形图标钮命中区撑到 44：视觉不变，热区补到规范下限 */
.pf::after {
  content: '';
  position: absolute;
  inset: -6px;
}

.pf.on[aria-label*='喜欢'] {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.pf.on[aria-label*='不喜欢'] {
  background: var(--danger-soft);
  /* soft 底上的文字走 strong 档（STANDARDS §4） */
  color: var(--danger-strong);
}

/* AI 弹层 */
.ai-panel {
  display: grid;
  /* 弹层里的六块内容：区块之间 16，底部留 20 的收尾呼吸 */
  gap: var(--gap-lg);
  padding-bottom: var(--sp-20);
}

.seg-sm {
  width: 210px;
}

.ai-wait {
  /* 等待态上下 32（吸附到令牌档） */
  padding: var(--sp-32) 0;
}

/* 流式过程：人话状态行（工具细节是开发者日志，已不上屏）+ 打字光标 */
.ai-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-6);
}

.spin {
  animation: rein-spin 1.1s linear infinite;
}

.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: var(--gap-text);
  vertical-align: -0.12em;
  background: var(--text-2);
  animation: rein-caret-blink 1s steps(2, start) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .spin,
  .caret {
    animation: none;
  }
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   AI 定制是一条横幅（图标 + 一句话 + 生成键），占半栏只会把右半屏留给空气，所以通栏。
   通栏由模板上的 .d-full 声明。 */

/* 22 个食谱模板在桌面上摊成两栏卡片（.rlist 本来就是 grid，这里只改栏数）。
   .d-grid 给的是 `repeat(var(--d-cols, 2), ...)`，两栏足够 —— 每张卡里是
   名称 + 四项营养 + 过敏原标签 + 两个偏好键，再窄就会换行换得很难看。 */
.desk-main .rlist {
  --d-cols: 2;
}

.ai-err {
  /* 错误是必须读出来的状态词：走文字档 --danger-strong（实底档当文字不够 AA） */
  color: var(--danger-strong);
  font-size: var(--fs-subhead);
}

/* 全天合计：热量做主角（19px + 等宽），旁边挂目标值胶囊对照，蛋白降为次要行 */
.ai-total-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-6) var(--sp-10);
}

.ai-total {
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.ai-total .ai-total-lab {
  margin-right: var(--gap-tight);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.ai-total b {
  margin-right: var(--gap-text);
  font-size: var(--fs-title3);
  color: var(--text-1);
}

.ai-protein {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.ai-meals {
  display: grid;
  /* 餐次卡之间 12（卡间距） */
  gap: var(--gap-md);
}

.ai-meals li {
  padding: var(--sp-12) var(--pad-card);
  /* 弹层里的二级分组面：收一档 12（母层是面板，不是卡片） */
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}

.ai-mhead {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.ai-mhead em {
  font-style: normal;
  /* 餐次胶囊与菜名 8；胶囊上下 2、左右 8 */
  margin-right: var(--gap-sm);
  padding: var(--sp-2) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  /* soft 底上的文字蓝走 --accent-strong（实底档 --accent 压 soft 底不够 AA） */
  color: var(--accent-strong);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
}

.ai-mhead b {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.ai-items {
  /* 餐次名与下方菜名：4 */
  margin-top: var(--gap-tight);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.ai-warn {
  font-size: var(--fs-caption);
}
</style>
