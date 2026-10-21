<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Camera, Dumbbell, GripVertical, LayoutGrid, Plus, Sparkles, Timer, Utensils, Wallet } from 'lucide-vue-next'

import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import BentoLayoutSheet from '@/components/workbench/BentoLayoutSheet.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import DietHistorySheet from '@/components/diet/DietHistorySheet.vue'
import EnergySummary from '@/components/nutrition/EnergySummary.vue'
import HomeTodoCard from '@/components/todo/HomeTodoCard.vue'
import PomodoroCard from '@/components/pomodoro/PomodoroCard.vue'
import { useBentoDrag, useBentoLayout, type BentoItemId } from '@/composables/useBentoLayout'
import { MEAL_LABELS, MEAL_META, MEAL_ORDER, mealKcal } from '@/config/domain'
import { categoryOf, fmtCents } from '@/config/ledger'
import { useDietStore } from '@/stores/diet'
import { useExerciseStore } from '@/stores/exercise'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePomodoroStore } from '@/stores/pomodoro'
import { todayStr } from '@/utils/date'

/**
 * 桌面主页 · 便当总览：能量三环磁贴 + 待办 + 番茄/AI + 快捷入口 + 饮食/记账/运动概览。
 *
 * 布局不再是写死的 12 栏命名区域，而是「稳定 id 的独立项 + 一份可持久化的顺序/尺寸」
 * （顺序、尺寸、拖动、落盘、键盘替代路径都在 composables/useBentoLayout）。
 * 这里只负责：把每张卡的内容画进自己的项里、把抓手柄挂上、把容器断点写对。
 */
const today = todayStr()
const router = useRouter()

const exercise = useExerciseStore()
const ledger = useLedgerStore()
const diet = useDietStore()
const nutrition = useNutritionStore()
const pomo = usePomodoroStore()

/**
 * 专注快捷磁贴：与 ⌘K 的「开始专注」一致 —— 真起跑再跳转（从前只 push 到 /focus，
 * 磁贴写着「专注」点进去却没有计时在跑）。start() 幂等，已在跑时再点等于只跳转。
 */
function startFocus(): void {
  pomo.start()
  void router.push({ name: 'focus' })
}

/* 记运动入口与「本周运动」概览都属运动插件：模块关掉时两块一起从排布里消失
   （由 useBentoLayout 决定哪些项可用，模板只渲染 cells）。 */

const quickOpen = ref(false)
const workoutOpen = ref(false)
const historyOpen = ref(false)
const layoutOpen = ref(false)

/* ---------- 布局：顺序 / 尺寸 / 拖动 ---------- */
const { cells, move, snapshot, restore } = useBentoLayout()
const bentoEl = ref<HTMLElement | null>(null)
const { dragId, settleId, onHandleDown } = useBentoDrag({
  listEl: bentoEl,
  orderIds: () => cells.value.map((c) => c.id),
  move,
  snapshot,
  restore,
})

/**
 * 项上的旧类名（t-hero / t-todo / t-qa / t-wk …）：形状、颜色、以及
 * 「运动关掉后 .t-wk 整块消失」这类既有契约都挂在它们身上，改名等于把外围全改一遍。
 * 注意 t-qa 现在贴在**每一项**快捷磁贴上（从前是一个 4 列的容器），
 * 选择器 `.t-qa button` 的语义不变。
 */
const ITEM_CLASS: Record<BentoItemId, string> = {
  hero: 't-hero',
  todo: 't-todo',
  pomodoro: 't-pomodoro',
  ai: 't-ai',
  'qa-food': 't-qa',
  'qa-workout': 't-qa',
  'qa-focus': 't-qa',
  'qa-ai': 't-qa',
  led: 't-led',
  wk: 't-wk',
  diet: 't-diet',
}

onMounted(() => {
  void exercise.loadWeek(today)
  // 饮食/营养不再依赖 HomePage 挂载链，桌面端直接进入总览时也需自备数据
  void diet.load(today)
  void nutrition.loadSummary(today)
})

const topCats = computed(() => ledger.expenseByCategory.slice(0, 2))
/** 本周已练次数：与同卡「分钟」同为本周口径（从前次数取当日、分钟取本周，读成「本周一次练了 320 分钟」） */
const weekWorkoutCount = computed(() => exercise.weekWorkouts.length)
const budgetPct = computed(() => {
  const budget = ledger.settings?.monthlyBudgetCents ?? 0
  return budget <= 0 ? 0 : Math.min(100, Math.round((ledger.monthExpenseCents / budget) * 100))
})

/** 今日饮食宽条：总摄入 / 目标 + 四餐打卡点 */
const todayIntake = computed(() => diet.meals.reduce((s, m) => s + (mealKcal(m) ?? 0), 0))
const kcalTarget = computed(() => Math.round(nutrition.summary?.targets.kcal ?? 0))
const mealChips = computed(() =>
  MEAL_ORDER.map((type) => {
    const items = diet.meals.filter((m) => m.mealType === type)
    return {
      type,
      label: MEAL_LABELS[type],
      on: items.length > 0,
      kcal: items.reduce((s, m) => s + (mealKcal(m) ?? 0), 0),
    }
  }),
)
</script>

<template>
  <div class="bento-wrap">
    <!-- 键盘 / 读屏用户的入口：抓手柄够不着时（触屏、纯键盘）从这里改顺序与尺寸 -->
    <div class="b-head">
      <button class="b-layout pressable" type="button" aria-label="调整便当布局" @click="layoutOpen = true">
        <LayoutGrid :size="15" :stroke-width="2.2" />
        布局
      </button>
    </div>

    <div ref="bentoEl" class="bento" :class="{ 'is-dragging': dragId !== null }">
      <div
        v-for="c in cells"
        :key="c.id"
        class="b-item"
        :class="[ITEM_CLASS[c.id], { 'is-drag': dragId === c.id, 'is-settle': settleId === c.id }]"
        :data-bento-id="c.id"
        :data-span="c.span"
        :data-rows="c.rows"
      >
        <!-- 抓手柄：右下角……右上角那枚圆钮，hover / 键盘聚焦时显形。
             点按（没拖动）= 打开布局面板，键盘 Enter 同一条路 —— 拖不动的用户不必无路可走。 -->
        <button
          class="b-grab"
          type="button"
          :aria-label="`调整「${c.label}」的位置与尺寸`"
          title="拖动换位（点按打开布局面板）"
          @pointerdown="onHandleDown($event, c.id)"
          @click="layoutOpen = true"
        >
          <GripVertical :size="13" :stroke-width="2.2" />
        </button>

        <!-- 能量与营养 -->
        <EnergySummary v-if="c.id === 'hero'" class="b-surf" link-to="/nutrition" />

        <!-- 待办 -->
        <HomeTodoCard v-else-if="c.id === 'todo'" class="b-surf" :date="today" :limit="6" />

        <!-- 番茄钟 -->
        <PomodoroCard v-else-if="c.id === 'pomodoro'" class="b-surf" />

        <!-- AI 入口 -->
        <section v-else-if="c.id === 'ai'" class="card b-surf b-ai">
          <div class="row" style="gap: var(--sp-10)">
            <i class="qic" style="background: color-mix(in srgb, var(--cat-study) 14%, transparent); color: var(--cat-study)"><Sparkles :size="19" /></i>
            <div class="col">
              <b style="font-size: var(--fs-headline)">AI 助手</b>
              <span class="t-3" style="font-size: var(--fs-caption); font-weight: var(--fw-semibold)">提问 · 拍照记饮食 · 生成周计划</span>
            </div>
          </div>
          <button class="ask pressable" @click="router.push({ name: 'ai' })">
            问点什么…
          </button>
        </section>

        <!-- 快捷入口：每块自己是一项，尺寸/顺序各自可调 -->
        <QuickTile
          v-else-if="c.id === 'qa-food'"
          class="b-surf"
          label="记饮食"
          icon-bg="color-mix(in srgb, var(--c-intake) 12%, transparent)"
          icon-color="var(--c-intake)"
          @click="quickOpen = true"
        >
          <Camera :size="20" />
        </QuickTile>
        <QuickTile
          v-else-if="c.id === 'qa-workout'"
          class="b-surf"
          label="记运动"
          icon-bg="var(--c-exercise-soft)"
          icon-color="var(--c-exercise-deep)"
          @click="workoutOpen = true"
        >
          <Dumbbell :size="20" />
        </QuickTile>
        <QuickTile
          v-else-if="c.id === 'qa-focus'"
          class="b-surf"
          label="专注"
          icon-bg="color-mix(in srgb, var(--cat-work) 12%, transparent)"
          icon-color="var(--cat-work)"
          @click="startFocus"
        >
          <Timer :size="20" />
        </QuickTile>
        <QuickTile
          v-else-if="c.id === 'qa-ai'"
          class="b-surf"
          label="问 AI"
          icon-bg="color-mix(in srgb, var(--cat-study) 14%, transparent)"
          icon-color="var(--cat-study)"
          @click="router.push({ name: 'ai' })"
        >
          <Sparkles :size="20" />
        </QuickTile>

        <!-- 记账概览 -->
        <section v-else-if="c.id === 'led'" class="b-surf b-bar">
          <div
            class="pressable inner"
            role="button"
            tabindex="0"
            aria-label="打开记账"
            @click="router.push({ name: 'ledger' })"
            @keydown.enter.prevent="router.push({ name: 'ledger' })"
            @keydown.space.prevent="router.push({ name: 'ledger' })"
          >
            <i class="qic"><Wallet :size="21" /></i>
            <div class="col" style="gap: var(--gap-text); min-width: 0">
              <b>记账</b>
              <!-- 支出与预算各占一行（各自 nowrap）：挤在一行时「预算」会被右栏类目拦腰折断 -->
              <span class="num t-2" style="white-space: nowrap">本月支出 ¥{{ fmtCents(ledger.monthExpenseCents) }}</span>
              <span class="num t-2" style="white-space: nowrap">预算已用 {{ budgetPct }}%</span>
              <div class="mtrack" style="margin-top: var(--gap-sm); max-width: 300px">
                <i :style="{ width: budgetPct + '%', background: 'var(--accent)' }" />
              </div>
            </div>
            <div class="col" style="margin-left: auto; align-items: flex-end; gap: var(--gap-tight); flex: none">
              <span
                v-for="cc in topCats"
                :key="cc[0]"
                class="num"
                style="font-size: var(--fs-caption); color: var(--text-3)"
              >
                <i class="cat-dot" :style="{ background: 'var(' + (categoryOf(cc[0])?.colorVar ?? '--cat-general') + ')' }" />
                {{ categoryOf(cc[0])?.label ?? cc[0] }} ¥{{ fmtCents(cc[1]) }}
              </span>
            </div>
          </div>
        </section>

        <!-- 运动概览 -->
        <section v-else-if="c.id === 'wk'" class="b-surf b-bar">
          <div
            class="pressable inner"
            role="button"
            tabindex="0"
            aria-label="打开运动"
            @click="router.push({ name: 'sports' })"
            @keydown.enter.prevent="router.push({ name: 'sports' })"
            @keydown.space.prevent="router.push({ name: 'sports' })"
          >
            <i class="qic" style="background: var(--c-exercise-soft); color: var(--c-exercise-deep)"><Dumbbell :size="21" /></i>
            <div class="col" style="gap: var(--gap-text); min-width: 0">
              <b class="nowrap">本周运动</b>
              <span class="t-2 nowrap">已练 <span class="num">{{ weekWorkoutCount }}</span> 次 · <span class="num">{{ exercise.weekMinutes }}</span> 分钟</span>
            </div>
            <!-- 「记运动」的可见文字只在快捷磁贴上出现一次：卡内这颗降为图标钮，
                 aria-label 补回语义（与磁贴同一个 AddWorkoutSheet） -->
            <button
              class="go pressable icon"
              style="margin-left: auto; flex: none"
              aria-label="记运动"
              title="记运动"
              @click.stop="workoutOpen = true"
            >
              <Plus :size="16" />
            </button>
          </div>
        </section>

        <!-- 今日饮食：点条开历史，右侧快捷记一笔 -->
        <section v-else-if="c.id === 'diet'" class="b-surf b-bar">
          <div
            class="pressable inner"
            role="button"
            tabindex="0"
            aria-label="查看饮食历史"
            @click="historyOpen = true"
            @keydown.enter.prevent="historyOpen = true"
            @keydown.space.prevent="historyOpen = true"
          >
            <i class="qic"><Utensils :size="21" /></i>
            <div class="col" style="gap: var(--sp-6); min-width: 0">
              <b>今日饮食</b>
              <span class="num t-2">
                已记 {{ diet.meals.length }} 笔 · {{ todayIntake }}{{ kcalTarget ? ` / ${kcalTarget}` : '' }} kcal
              </span>
              <div class="chips">
                <span v-for="ch in mealChips" :key="ch.type" class="chip" :class="{ on: ch.on }">
                  <i class="cdot" :style="{ background: ch.on ? MEAL_META[ch.type].colorVar : 'var(--line-strong)' }" />
                  {{ ch.label }}<template v-if="ch.on"> {{ ch.kcal }}</template>
                </span>
              </div>
            </div>
            <div class="acts">
              <button class="ghost pressable" @click.stop="historyOpen = true">历史</button>
              <button class="go pressable" @click.stop="quickOpen = true">记一笔</button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 弹层 -->
    <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
    <AddWorkoutSheet :open="workoutOpen" @close="workoutOpen = false" />
    <DietHistorySheet :open="historyOpen" @close="historyOpen = false" />
    <BentoLayoutSheet :open="layoutOpen" @close="layoutOpen = false" />
  </div>
</template>

<style scoped>
.bento-wrap {
  min-width: 0;
}

/* 布局入口：便当的右上角。桌面专属组件，所以不占手机版的版面 */
.b-head {
  display: flex;
  justify-content: flex-end;
  /* 布局入口与便当之间 12（--gap-md） */
  margin-bottom: var(--gap-md);
}

.b-layout {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  /* 入口是一枚胶囊：左右 12（--pad-inline），原来 13 落在两档之间 */
  padding: var(--sp-6) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

/* 视觉仍是一枚 29px 的小胶囊，命中区用伪元素补到 44（--hit-min）。 */
.b-layout::after {
  content: '';
  position: absolute;
  inset: -8px 0;
  border-radius: var(--radius-full);
}

.b-layout:active {
  opacity: 0.7;
}

/* 12 栏 + 150px 行高基准：尺寸档（3/4/6/12 列、1/2 行）都落在这一套单位上。
   dense 回填是**缺省排布的一部分**——右上角 4 列里番茄钟在上、AI 在下，
   就是靠它把「大砖」旁边空出来的那半格还给下一项（否则 ai 会被甩到第三行，行中留洞）。

   container-type: inline-size 是这一轮的关键：主人区宽度**不等于**视口宽度
   （导航轨 64 + 信息栏 298 + 页面留白 68，900 宽时只剩 768）。按视口写断点，
   这一档永远踩不到；按容器写，900–1512 之间每一档都在自己该在的形态上。 */
.bento {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-rows: minmax(150px, auto);
  grid-auto-flow: row dense;
  /* 便当格之间 12（--gap-md）：与卡片间距同档。原来 14 与页面那圈 --desk-gap
     比起来少 4、与卡片规范比又多 2，是第三种节奏 */
  gap: var(--gap-md);
  align-items: stretch;
  container-type: inline-size;
  min-width: 0;
}

/* ---------- 项（网格格子的占位盒）+ 卡面（真正被拖走的那个） ---------- */
.b-item {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* 格子是卡片的占位盒，圆角必须与卡面（16）一致，拖拽时边缘才不会露馅 */
  border-radius: var(--radius-m);
}

/* 卡面填满格子：否则矮一截的卡下面会漏出一块灰底画布，整行读成「没画完」 */
.b-item > .b-surf {
  flex: 1 1 auto;
  min-width: 0;
}

/* 尺寸档：列宽由 data-span 决定（而不是行内样式）——容器查询要能覆盖它 */
.b-item[data-span='3'] { grid-column: span 3; }
.b-item[data-span='4'] { grid-column: span 4; }
.b-item[data-span='6'] { grid-column: span 6; }
.b-item[data-span='12'] { grid-column: 1 / -1; }
.b-item[data-rows='2'] { grid-row: span 2; }

/* 容器窄于 980（约 = 主人区 768 那一档起）：三栏会把卡片挤成 214px，
   改成「半栏 / 通栏」两栏——3、4 列宽的卡各占一半，6、12 列的通栏。
   这一档的上下界都由**容器**自己说了算，页级列的上限（P3）改多宽都不用跟着动。 */
@container (max-width: 980px) {
  .b-item[data-span='3'],
  .b-item[data-span='4'] {
    grid-column: span 6;
  }
}

/* ---------- 抓手柄 ---------- */
/* 位置贴在格子右上角、**横向完全收在格子里、纵向半个钮探到格外**：
   · 探出的那半个钮落在栅格间距里，不压卡内容 —— 卡内右上角常有「详情」「记一笔」
     这类按钮，钮完全压进卡里会挡住它们（横向 8..32px 的位置正压在这些按钮上）；
   · 横向不许越界：`.bento` 是普通盒子，子元素往右探 1px 就会进它的 scrollWidth
     （e2e-feature-toggles 有一条「便当没有横向溢出」的断言），往**上**探则不计入。
   静止时 opacity:0 且 pointer-events:none（不挡点、不进 T2 的小靶统计），
   hover / 键盘聚焦才显形可点。 */
.b-grab {
  position: absolute;
  top: -9px;
  right: 8px;
  z-index: 3;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--surface);
  border: 0.5px solid var(--line-strong);
  box-shadow: var(--shadow-thumb);
  color: var(--text-2);
  /* 触屏抓柄自管手势：rubberScroll 判定滚动链时遇到 touch-action:none 会整场让手 */
  touch-action: none;
  cursor: grab;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 刻意不套 @media (hover: hover)：触屏没有悬停，而这里「按一下先亮出抓手柄、
   再按住拖动」是可用路径（触屏上 :hover 会在点按后就粘住）。 */
.b-item:hover > .b-grab,
.b-item:focus-within > .b-grab {
  opacity: 1;
  pointer-events: auto;
}

.b-grab:focus-visible {
  opacity: 1;
  pointer-events: auto;
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* 主指针没有悬停的设备（平板/触屏本在触屏模式下）：抓手柄常显。
   没有 hover 这个动作，藏起来的抓手柄等于不存在 —— 第一次点按还会被卡片自己的
   按钮吃掉（卡的右上角常是「详情」）。指针设备上它照旧 hover 才显形。 */
@media (hover: none) {
  .b-grab {
    opacity: 1;
    pointer-events: auto;
  }
}

.b-grab:active {
  cursor: grabbing;
}

/* 静态顶一下：抓手柄是 24px 的视觉规格，命中区撑到 44 的惯用法这里**不适用** ——
   它要贴角、要能拖动，44px 的热区会把卡片右上角整块吃掉。 */
.b-grab::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: var(--radius-full);
}

/* ---------- 拖动进行中 ---------- */
/* 被拖的是卡面，项自己的盒子留在网格里当占位（虚线框 + 一层薄底）——空洞会跟着
   手指在网格里走，松手时卡面正好落回它。 */
.b-item.is-drag {
  pointer-events: none;
  outline: 1.5px dashed var(--line-strong);
  outline-offset: -1.5px;
  background: color-mix(in srgb, var(--text-1) 4%, transparent);
  z-index: 4;
}

.b-item.is-drag > .b-grab {
  opacity: 0;
}

.b-item.is-drag > .b-surf {
  box-shadow: var(--shadow-float-lift);
}

/* 松手回位：只有这一段走位移补间（拖动中挂着 transition 会拖手） */
.b-item.is-settle > .b-surf {
  transition: transform var(--dur-fast) var(--ease-out);
}

/* ---------- 各卡自己的填满规则 ---------- */
.t-todo > .b-surf {
  display: flex;
  flex-direction: column;
}

/* 填满之后把汇总脚注锚到卡底：列表贴上、汇总贴下，中间留白是结构而不是洞 */
.t-todo > .b-surf :deep(.foot) {
  margin-top: auto;
  padding-top: var(--sp-12);
}

/* 快捷磁贴：格子是 150px 一档的行高，磁贴自己撑不满就会读成「上下多出两条缝」；
   撑满 + 内容居中，图标与文字才落在格子正中 */
.t-qa > .b-surf {
  height: 100%;
  justify-content: center;
}

/* ---------- 摄入总览（hero 格）：把「被拉高」变成结构 ----------
   hero 与「待办」并排、同跨两行（实测 ≈690 高），而营养域的 dense 版式只会把
   标题/主数值/条/图例堆在上部约 150 —— 中间空出 400 多，整张卡读成「没画完」。
   施工单第 1 条要求「拉伸后内容要重新排版」，所以只在这一颗调用点上重排高度：
   · 上半区：主数值与热量条放大（同一屏里它的主读数地位不变，只是不再挤成一条）；
   · 下半区：三大宏量从「三列小条」改成一整块浅井（--radius-m-nest + --surface-inset）
     里的三行分解 —— 行自己吸收高度、条加粗，空间被结构吃掉，而不是靠
     justify-content 摊成几道等宽的缝。
   组件内部的实现（nutrition 域）不动，避免与营养页那套共用实现分叉。 */
.t-hero :deep(.ov) {
  height: 100%;
  /* 卡内三块（主读数 / 图例 / 宏量井）之间恒为 12（卡内区块档），
     不再各处各写一个 margin-top */
  gap: var(--gap-md);
}

.t-hero :deep(.big) {
  /* 主数值是这一格唯一的英雄数字：回到 display-s（dense 为塞进窄卡压到 18） */
  font-size: var(--fs-display-s);
  letter-spacing: -1.2px;
}

.t-hero :deep(.rest-v) {
  font-size: var(--fs-title2);
}

/* 条加粗一档：12 在 690 高的卡里是一根线，读不出「已经吃到这里了」 */
.t-hero :deep(.bar.lg) {
  height: var(--sp-20);
  margin-top: var(--gap-sm);
}

/* 图例与上方条、与下方宏量井各 8 / 12：图例是条的注解，不单独成块 */
.t-hero :deep(.legend) {
  margin-top: 0;
}

/* 分隔线由宏量井自己承担（浅井 + 圆角就是分界），不再叠一根发丝线 */
.t-hero :deep(.hr) {
  display: none;
}

.t-hero :deep(.macros) {
  flex: 1 1 auto;
  margin-top: 0;
  display: flex;
  flex-direction: column;
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
}

/* 一行宏量 = 标签 + 数值同一行、条在下方整行跨满：
   行高随卡片剩余高度伸缩，条也就不必再压成 8px 的细线 */
.t-hero :deep(.mc) {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr auto;
  align-content: center;
  align-items: center;
  column-gap: var(--gap-md);
  row-gap: var(--gap-sm);
  padding-block: var(--gap-tight);
}

.t-hero :deep(.mc > .m-label) {
  grid-column: 1;
  grid-row: 1;
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.t-hero :deep(.mc > .m-val) {
  grid-column: 2;
  grid-row: 1;
  justify-content: flex-end;
}

/* 条在第二行跨满两列：与上面那行标签同宽，读数与图元才对得上 */
.t-hero :deep(.mc > .bar) {
  grid-column: 1 / -1;
  grid-row: 2;
  height: var(--sp-12);
}

.t-hero :deep(.m-cur) {
  font-size: var(--fs-title2);
}

.t-hero :deep(.m-tgt) {
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-2);
}

.b-ai {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  background: linear-gradient(135deg, var(--accent-soft), transparent 60%), var(--surface);
}

/* 记账 / 本周运动 / 今日饮食：整条就是一张卡，`.inner` 负责内部那一圈 20px */
.b-bar {
  display: flex;
  align-items: center;
  background: var(--surface);
  /* 整条就是一张卡：与其它卡片同档 16 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
}

.chips {
  display: flex;
  /* 餐次胶囊之间无边界 → 8（--gap-sm） */
  gap: var(--gap-sm);
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  /* 圆点与文字 4（--gap-tight）；胶囊高 24（--chip-h）、左右 10 ——
     便当卡里比全站胶囊窄一档，一排四颗才塞得进行内 */
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.chip.on {
  color: var(--text-1);
}

.cdot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: var(--radius-full);
}

.acts {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-left: auto;
  flex: none;
}

/* 卡头两颗按钮：同一组、同一几何（8×16 内距 / 全圆），只换底与前景。
   常规按钮高 40（--control-md）：从前只有内距撑出来的 ~36，两枚并排时高度也不齐。 */
.ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.inner {
  display: flex;
  width: 100%;
  align-items: center;
  gap: var(--gap-md);
  min-width: 0;
  /* 整条就是一张卡：内距走 --pad-card 16（原来 20 比卡片规范多 4，
     这条通栏卡与同屏其它卡的内缘会对不齐） */
  padding: var(--pad-card);
}

.qic {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.ask {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 形似输入框的入口：与常规按钮同高 40，不再靠 8px 内距撑出 33 的小条 */
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-14);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  overflow: hidden;
}

.cat-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  margin-right: var(--sp-4);
  vertical-align: 1px;
}

.mtrack {
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.mtrack i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
}

.nowrap {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.go {
  /* 与 .ghost 同一几何：两颗按钮并排，只有底与前景不同 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

/* 图标档（「记运动」）：与文字档同高，去掉左右内边距、图标居中 */
.go.icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-md);
  height: var(--control-md);
  padding: 0;
}

/* 40 的圆形图标钮把命中区补到 44，视觉直径不动 */
.go.icon::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: var(--radius-full);
}
</style>
