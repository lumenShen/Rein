<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Utensils } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import MealDetailSheet from '@/components/diet/MealDetailSheet.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import IntakeDetailSheet from '@/components/nutrition/IntakeDetailSheet.vue'
import IntakeOverview from '@/components/nutrition/IntakeOverview.vue'
import { MEAL_LABELS, MEAL_META, MEAL_ORDER, fmtGrams, mealKcal, mealQtyText } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { dietService } from '@/services/dietService'
import { nutritionService } from '@/services/nutritionService'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { WEEKDAY_LABELS, addDays, fmtDateCn, startOfWeek, todayStr, weekDates } from '@/utils/date'
import type { DailySummary, MealLog } from '@/types'

/** 饮食历史悬浮窗：Dock 式日选栏 + 当日摄入总览 + 分餐次记录列表。
 *  点总览看这一天的营养实际全览（与营养全览页同一套组件），点行进单笔详情（实际营养素 + 删除）。
 *  数据全部落在本地（直调 service），不污染全局 store 的「今天」视图；
   仅删除今天的记录时回流刷新，让首页宽条即时同步。 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const toast = useToast().toast
const diet = useDietStore()
const nutrition = useNutritionStore()

const today = todayStr()
const anchor = ref(today) // 当前显示周的锚点（周内任意一天）
const selected = ref(today)
const logs = ref<MealLog[]>([])
const loading = ref(false)

/* ---------- 当日汇总（摄入总览 / 行占比 / 单笔详情 / 迷你条的分母都用它） ---------- */
/** 看过的日期汇总：来回翻日不必再等一次往返，也就不会先闪一屏空档 */
const summaryCache = new Map<string, DailySummary>()
/** 最近一次到货的汇总（可能属于上一天 —— 行占比与迷你条的分母用它，翻日时不会整片归零） */
const summary = ref<DailySummary | null>(null)
/** 上面那一份属于哪一天 */
const summaryDate = ref('')

/** 选中日的汇总：与 `selected` 不等的这段时间里它是 null。
 *  摄入总览与「营养全览」必须用这一份 —— 拿上一天的数字当这一天的，比空一瞬更糟。 */
const daySummary = computed(() => (summaryDate.value === selected.value ? summary.value : null))

/** 迷你条的分母：当日目标（读最近一次到货的那份汇总） */
const targetKcal = computed(() => Math.round(summary.value?.targets.kcal ?? 0))

/* ---------- 日选栏（Dock 栏目风格） ---------- */
const days = computed(() => weekDates(anchor.value))
const atCurrentWeek = computed(() => anchor.value === startOfWeek(today))

/** 周内每日摄入占目标百分比（迷你条）；目标未设时全为 0（不显示） */
const dayPct = computed(() => {
  const t = targetKcal.value
  const kcalByDay = new Map<string, number>()
  for (const l of logs.value) kcalByDay.set(l.date, (kcalByDay.get(l.date) ?? 0) + (mealKcal(l) ?? 0))
  const pct = new Map<string, number>()
  for (const [d, kcal] of kcalByDay) pct.set(d, t <= 0 ? 0 : Math.min(100, Math.round((kcal / t) * 100)))
  return pct
})

/* ---------- 数据拉取（序号防快翻竞态） ---------- */
let weekSeq = 0
let summarySeq = 0

async function fetchWeek(): Promise<void> {
  const seq = ++weekSeq
  loading.value = true
  try {
    const ws = startOfWeek(anchor.value)
    const list = await dietService.listMealsRange(ws, addDays(ws, 6))
    if (seq === weekSeq) logs.value = list
  } finally {
    if (seq === weekSeq) loading.value = false
  }
}

async function fetchSummary(): Promise<void> {
  const date = selected.value
  const seq = ++summarySeq
  const cached = summaryCache.get(date)
  if (cached) {
    summary.value = cached
    summaryDate.value = date
  }
  const s = await nutritionService.getDailySummary(date)
  summaryCache.set(date, s)
  if (seq === summarySeq && date === selected.value) {
    summary.value = s
    summaryDate.value = date
  }
}

function pickDay(d: string): void {
  if (d === selected.value) return
  selected.value = d
  void fetchSummary()
}

/** 翻周：锚点平移一周；选中日跟随平移并钳制在本周内、不越过今天 */
function shiftWeek(delta: number): void {
  const ws = startOfWeek(addDays(anchor.value, delta * 7))
  const we = addDays(ws, 6)
  const limit = we < today ? we : today
  let next = addDays(selected.value, delta * 7)
  if (next < ws) next = ws
  if (next > limit) next = limit
  anchor.value = ws
  pickDay(next)
  void fetchWeek()
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    anchor.value = startOfWeek(today)
    selected.value = today
    void fetchWeek()
    void fetchSummary()
  },
)

/* ---------- 当日列表 ---------- */
const dayLogs = computed(() => logs.value.filter((l) => l.date === selected.value))

/** 行内四格指标：本笔占当日目标的百分比；目标未设（≤0）回落显示实际量（热量用大卡，其余用克） */
const ROW_METRICS = [
  { key: 'kcal', label: '热量', unit: '大卡', colorVar: '--c-intake' },
  { key: 'protein', label: '蛋白', unit: 'g', colorVar: '--c-protein' },
  { key: 'carb', label: '碳水', unit: 'g', colorVar: '--c-carb' },
  { key: 'fat', label: '脂肪', unit: 'g', colorVar: '--c-fat' },
] as const

function rowMetrics(l: MealLog) {
  const f = l.food
  if (!f) return null
  const k = l.grams / 100
  const t = summary.value?.targets
  const actual = {
    kcal: f.kcal * k,
    protein: f.protein * k,
    carb: f.carb * k,
    fat: f.fat * k,
  }
  const target = {
    kcal: t?.kcal ?? 0,
    protein: t?.protein ?? 0,
    carb: t?.carb ?? 0,
    fat: t?.fat ?? 0,
  }
  return ROW_METRICS.map((m) => {
    const pct = target[m.key] > 0 ? Math.round((actual[m.key] / target[m.key]) * 100) : null
    return { ...m, pct, fill: pct == null ? 0 : Math.min(100, pct), gramsText: fmtGrams(actual[m.key]) }
  })
}

const groups = computed(() =>
  MEAL_ORDER.map((type) => ({
    type,
    items: dayLogs.value
      .filter((l) => l.mealType === type)
      .map((l) => ({ log: l, metrics: rowMetrics(l) })),
  })).filter((g) => g.items.length > 0),
)

function groupKcal(items: { log: MealLog }[]): number {
  return items.reduce((s, it) => s + (mealKcal(it.log) ?? 0), 0)
}

/* ---------- 营养全览（这一天） ---------- */
const ovOpen = ref(false)

/* ---------- 详情与删除 ---------- */
const detail = ref<MealLog | null>(null)
const delTarget = ref<MealLog | null>(null)
const busy = ref(false)

/** 详情页里的删除：带上这条记录打开既有二次确认 */
function askDelete(): void {
  if (!detail.value) return
  delTarget.value = detail.value
}

async function onDelete(): Promise<void> {
  const t = delTarget.value
  if (!t || busy.value) return
  busy.value = true
  try {
    await dietService.deleteMeal(t.id)
    logs.value = logs.value.filter((x) => x.id !== t.id)
    void fetchSummary()
    // 删的是今天的记录 → 回流刷新首页的能量汇总与时间轴
    if (t.date === today) {
      void diet.load(today)
      void nutrition.loadSummary(today)
    }
    toast('已删除')
  } finally {
    busy.value = false
    delTarget.value = null
    detail.value = null
  }
}
</script>

<template>
  <SheetModal :open="open" initial-snap="large" title="饮食历史" @close="emit('close')">
    <div class="hist">
      <!-- 日选栏：Dock 栏目风格（两侧独立圆钮 + 中间药丸），吸顶，翻周切换查看日期 -->
      <div class="weekbar">
        <button class="dock-side pressable" aria-label="上一周" @click="shiftWeek(-1)">
          <ChevronLeft :size="18" />
        </button>

        <div class="dock-pill" role="group" aria-label="选择日期">
          <button
            v-for="(d, i) in days"
            :key="d"
            class="dock-day"
            :class="{ on: d === selected }"
            :disabled="d > today"
            :aria-label="fmtDateCn(d)"
            :aria-current="d === selected ? 'date' : undefined"
            @click="pickDay(d)"
          >
            <span class="dd num">{{ Number(d.slice(8)) }}</span>
            <span class="dw">{{ WEEKDAY_LABELS[i] }}</span>
            <i class="mbar"><i class="fill" :style="{ width: (dayPct.get(d) ?? 0) + '%' }" /></i>
          </button>
        </div>

        <button class="dock-side pressable" aria-label="下一周" :disabled="atCurrentWeek" @click="shiftWeek(1)">
          <ChevronRight :size="18" />
        </button>
      </div>

      <!-- 当日摄入总览：与主页、营养全览页同一个组件（传这一天的汇总）；整块是按钮，
           点开这一天的营养实际全览。壳用抽屉白卡材质，理由见 IntakeDetailSheet。 -->
      <button class="ovcard pressable" aria-label="查看当日营养全览" @click="ovOpen = true">
        <IntakeOverview :summary="daySummary">
          <template #action>
            <span class="ovgo">
              <span>{{ fmtDateCn(selected) }}</span>
              <ChevronRight :size="14" />
            </span>
          </template>
        </IntakeOverview>
      </button>

      <!-- 分餐次列表 -->
      <section v-for="g in groups" :key="g.type" class="meal">
        <header class="mhead">
          <i
            class="mic"
            :style="{
              background: `color-mix(in srgb, ${MEAL_META[g.type].colorVar} 14%, transparent)`,
              color: MEAL_META[g.type].colorVar,
            }"
          >
            <component :is="MEAL_META[g.type].icon" :size="17" />
          </i>
          <b>{{ MEAL_LABELS[g.type] }}</b>
          <span class="num ksum">{{ groupKcal(g.items) }} kcal</span>
        </header>
        <button v-for="it in g.items" :key="it.log.id" class="row pressable" @click="detail = it.log">
          <span class="rcol">
            <span class="rname">{{ it.log.food?.name ?? MEAL_LABELS[it.log.mealType] }}</span>
            <span class="rsub">
              {{ mealQtyText(it.log) }}<template v-if="it.log.note"> · {{ it.log.note }}</template>
            </span>
            <span v-if="it.metrics" class="nutgrid">
              <span v-for="m in it.metrics" :key="m.key" class="ncell">
                <span class="nlab">
                  {{ m.label }}
                  <b class="num nval">{{ m.pct != null ? `${m.pct}%` : `${m.gramsText}${m.unit}` }}</b>
                </span>
                <i class="nbar" :class="{ 'notgt': m.pct == null }">
                  <i class="nfill" :style="{ width: m.fill + '%', background: `var(${m.colorVar})` }" />
                </i>
              </span>
            </span>
          </span>
          <b class="num rkcal">{{ mealKcal(it.log) != null ? `${mealKcal(it.log)} kcal` : '—' }}</b>
        </button>
      </section>

      <EmptyState
        v-if="!loading && dayLogs.length === 0"
        :icon="Utensils"
        title="这一天还没有饮食记录"
        hint="从首页「记一笔」或 AI 助手添加"
      />
    </div>

    <!-- 这一天的营养实际全览（Teleport 到 body） -->
    <IntakeDetailSheet :open="ovOpen" :date="selected" :summary="daySummary" @close="ovOpen = false" />

    <!-- 单笔详情（Teleport 到 body）：点行看这份实际吃进去的营养素 -->
    <MealDetailSheet
      :open="detail !== null"
      :log="detail"
      :targets="summary?.targets ?? null"
      @close="detail = null"
      @delete="askDelete"
    />

    <!-- 删除确认（Teleport 到 body） -->
    <ActionSheet
      :open="delTarget !== null"
      :title="`删除「${delTarget?.food?.name ?? '记录'}」后，这条饮食记录从当日摄入与统计中移除，无法恢复`"
      :actions="[{ label: '删除这条记录', value: 'delete', danger: true }]"
      @close="delTarget = null"
      @select="onDelete"
    />
  </SheetModal>
</template>

<style scoped>
.hist {
  padding-bottom: var(--gap-sm);
}

/* ---------- 日选栏：Dock 栏目风格 ----------
   两侧独立圆钮 + 中间药丸，与底部 Dock 的三块装配同一种构型；七格等分、**共享一条连续容器**
   （这正是它与标签栏最直观的差别：标签栏是七个各自带底的块，选中那块实心主色）。
   选中态因此是一枚**中性提亮的小药丸**（--glass-tab-fill，与 Dock 活动底同一个令牌）+
   --accent-strong 的文字 —— 主色实心块是「切到哪个页签」的语言，会把「看哪一天」读错。

   材质走 --glass-* 令牌而**不**挂 GlassSurface：抽屉是滚动容器，一屏三块 svg 折射
   与 tokens.css「抽屉不挂折射」那条取舍相冲（折射按元素尺寸现烘位移贴图）。
   要的只是「毛玻璃 + 光学令牌」，自己写一条 backdrop-filter 就够 —— 挂在哪一层
   （条上还是块上）见下面那两条规则。 */

/* 流畅档的抽屉是实底：条用同一个 --surface，观感与历史一致。
   高画质及以上抽屉本体是半透明玻璃 —— 条**不能再铺自己的玻璃底**：
   两层 0.86~0.66 的白叠起来是 0.96，条带会比面板亮出一档（白带以弱化形式回来）。
   所以玻璃档下条自身不铺底色，滚过的记录行交给每一块玻璃自己磨（见下面那条规则）。
   负 margin 全宽出血：否则内容会从条两侧 18px 的沟里滚过去。 */
.weekbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 这里是「全宽出血」而不是页面留白：负 margin 与侧内距都取 --pad-sheet
     （抽屉内容区的左右内距），两边永远同源，抽屉内距改档时不会错位 */
  margin: 0 calc(-1 * var(--pad-sheet));
  background: var(--surface);
  padding: var(--gap-tight) var(--pad-sheet) var(--sp-10);
}

/* 玻璃档（高画质及以上）：条**整条什么都不画** —— 底色透明，连整宽的模糊也不挂。
   面板自己那层 backdrop-filter 只作用于「面板背后的页面」，而条这层整宽模糊会在条的
   位置铺出一条横贯全宽的霜带、上下各留一道硬边，与「一枚悬浮在内容之上的 Dock」
   不是一回事。**高画质 / 超高 / 极致三档一致** —— 换画质档不换这个构件的观感。 */
html[data-perf]:not([data-perf='low']) .weekbar {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* 从条底下滚过的记录行改由**每一块玻璃自己**吃自己的 backdrop：霜只落在块身上，
   条上不留任何横向痕迹 —— 与底部 Dock 的材质做法一致（那边也是每块玻璃各管各的背影）。
   块本身是半透明的（--glass-fill 一档 0.4~0.52），少了这层模糊，滚过的记录行会**穿过**
   胶囊与日期数字叠成一片，两边都读不出来。 */
html[data-perf]:not([data-perf='low']) .dock-side,
html[data-perf]:not([data-perf='low']) .dock-pill {
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
}

/* 减弱透明度：面板被 base.css 顶回实底（该媒体查询覆盖不到组件内的自定义表面），
   条同样回实底、去模糊，与面板同材质。
   选择器与上面那条玻璃档规则**同权重**（0,3,1）、源码更晚，才压得住它；
   流畅档不必列（那条规则本来就不覆盖它，且 low 已全局关掉 backdrop-filter）。 */
@media (prefers-reduced-transparency: reduce) {
  html[data-perf]:not([data-perf='low']) .weekbar {
    background: var(--surface);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  /* 日选栏那三块玻璃同样退回实底（--glass-fill 不在上面那份令牌里，就地顶掉），
     活动底一并换成实心次级灰：胶囊已经是不透明白，再叠一层半透明白等于没有 */
  html[data-perf]:not([data-perf='low']) .dock-side,
  html[data-perf]:not([data-perf='low']) .dock-pill {
    background: var(--surface);
    border-color: var(--line-strong);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    --glass-tab-fill: var(--surface-2);
  }
}

/* 侧钮：Dock 两侧那两块独立圆玻璃的几何（直径 ≈ 药丸高），翻周用 */
.dock-side {
  position: relative;
  width: 38px;
  height: 38px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--glass-fill);
  border: 1px solid var(--line);
  color: var(--text-2);
  box-shadow: var(--shadow-thumb);
}

/* 38 的翻周钮命中区补到 44：两侧各扩 3，与中间药丸隔 8，不会互相吃掉 */
.dock-side::after {
  content: '';
  position: absolute;
  inset: -3px;
}

.dock-side:disabled {
  opacity: var(--disabled-opacity);
}

/* 药丸：七格等分的一整条容器。内边距 3px 就是选中药丸与容器之间那道缝 */
.dock-pill {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  /* 格间 2（同一容器内最小缝），容器内距 4 */
  gap: var(--gap-text);
  padding: var(--gap-tight);
  border-radius: var(--radius-full);
  background: var(--glass-fill);
  border: 1px solid var(--line);
}

/* 一格：数字（主角）在上、周几在下，第三行是这一天的摄入痕迹 —— 与 Dock 页签
   「图标在上、标签在下」同一套竖排；选中不换布局，只换底与字色 */
.dock-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-text);
  min-width: 0;
  /* 竖排三行（数字 / 周几 / 摄入痕迹）：上 4、下 6 */
  padding: var(--gap-tight) 0 var(--sp-6);
  border-radius: var(--radius-full);
  color: var(--text-3);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.dock-day:disabled {
  opacity: var(--disabled-opacity);
}

.dd {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  /* 数字用展示级紧行高，药丸高度靠它压住 */
  line-height: var(--lh-display);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.dw {
  /* 周几标签是「哪天练了」的读法依据，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  /* 与数字同一档紧行高：三行竖排总高不因这行多出 2px */
  line-height: var(--lh-display);
}

.mbar {
  width: 58%;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--line);
  overflow: hidden;
}

.mbar .fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
}

/* 选中：中性提亮的药丸 + --accent-strong 的文字（它正是「压在浅底上的文字蓝」那一档）。
   数字在未选中时是 --text-1（主角），选中时并入同一支蓝，不再比周几更重。 */
.dock-day.on {
  background: var(--glass-tab-fill);
}

.dock-day.on .dd,
.dock-day.on .dw {
  color: var(--accent-strong);
}

/* ---------- 当日摄入总览 ----------
   与主页那条同一个组件、同一个「整块可点」的做法（那边是 .card.strip）：壳在这里
   换成抽屉白卡材质（--sheet-card-fill / --sheet-card-shadow），与「营养全览」抽屉里的
   那张是同一份 —— 页面级 .card 的底在玻璃档会跟着面板一起变薄。 */
.ovcard {
  display: block;
  width: 100%;
  margin-top: var(--gap-md);
  padding: var(--pad-card);
  text-align: left;
  /* 抽屉里的白卡是卡片层级：16（32 是半模态自己的圆角） */
  border-radius: var(--radius-m);
  background: var(--sheet-card-fill);
  box-shadow: var(--sheet-card-shadow);
}

/* 角标：这一天 + 一个「进得去」的箭头。不给它加 chip 底 —— 整块本来就是按钮 */
.ovgo {
  display: flex;
  align-items: center;
  gap: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 餐次小节 */
.meal {
  /* 餐次小节之间 16（有明显边界的区块） */
  margin-top: var(--gap-lg);
}

.mhead {
  display: flex;
  align-items: center;
  /* 餐次图标与名称：图标与文字左右 8 */
  gap: var(--gap-sm);
}

.mic {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mhead b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.ksum {
  margin-left: auto;
  font-size: var(--fs-caption);
  /* 这一餐的总热量是要读的数 → --text-2 */
  color: var(--text-2);
  font-weight: var(--fw-semibold);
}

/* 记录行：高频列表，不加过渡 */
.row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  /* 行与行之间 8；行本身是卡片式条目：内距 12/16 */
  margin-top: var(--gap-sm);
  padding: var(--sp-12) var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
}

.rcol {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.rname {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.rsub {
  font-size: var(--fs-caption);
  /* 份量与克数是这条记录的可核对依据 → --text-2 */
  color: var(--text-2);
}

/* 行内指标格：本笔四大指标占当日目标（颜色留在条上，数字走中性） */
.nutgrid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  /* 四格指标：格间 8，与明细文字之间 8 */
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
}

.ncell {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  min-width: 0;
}

.nlab {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-tight);
  /* 营养素名 + 数值，是要读的数，不吃 11px、也不落 --text-3 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  white-space: nowrap;
}

.nval {
  font-weight: var(--fw-bold);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.nbar {
  display: block;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--line);
  overflow: hidden;
}

/* 目标未设：不画空槽，克数文案就是全部信息 */
.nbar.notgt {
  background: transparent;
}

.nfill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
}

.rkcal {
  flex: none;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}
</style>
