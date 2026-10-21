<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight, Dumbbell, Flame } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ExerciseBars from '@/components/exercise/ExerciseBars.vue'
import WorkoutRow from '@/components/exercise/WorkoutRow.vue'
import WorkoutDetailDrawer from '@/components/exercise/WorkoutDetailDrawer.vue'
import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useExerciseStore } from '@/stores/exercise'
import type { Workout } from '@/types'
import { WEEKDAY_LABELS, addDays, addMonths, fmtDateCn, monthKey, parseDate, todayStr, weekDates } from '@/utils/date'

/** 全部运动记录 · 二级页：日 / 周 / 年三视图。
 *  结构沿用本周运动卡的视觉语言：概览卡（周期导航 + 分钟柱状图 + 统计行）+ 分组记录列表。 */
type ViewKey = 'day' | 'week' | 'year'

const viewOptions: { value: ViewKey; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'year', label: '年' },
]

const ex = useExerciseStore()
const view = ref<ViewKey>('week')

// 各视图独立的周期锚点（锚在周期内任一天），默认今天
const today = todayStr()
const dayAnchor = ref(today)
const weekAnchor = ref(today)
const yearAnchor = ref(today)

onMounted(() => {
  void ex.loadAll()
})

/* ---------- 周期边界与导航 ---------- */

const dayRange = computed<[string, string]>(() => [dayAnchor.value, dayAnchor.value])

const weekRange = computed<[string, string]>(() => {
  const days = weekDates(weekAnchor.value)
  return [days[0]!, days[6]!]
})

const yearNum = computed(() => parseDate(yearAnchor.value).getFullYear())

/** 是否处于最新周期（未来不会有记录，故前进键与「回到今天」都以此为准） */
const atCurrent = computed(() => {
  switch (view.value) {
    case 'day':
      return dayAnchor.value === today
    case 'week':
      return weekRange.value[1]! >= today
    case 'year':
      return yearNum.value === Number(today.slice(0, 4))
    default:
      return false
  }
})

function shift(n: number): void {
  switch (view.value) {
    case 'day':
      dayAnchor.value = addDays(dayAnchor.value, n)
      break
    case 'week':
      weekAnchor.value = addDays(weekAnchor.value, n * 7)
      break
    case 'year':
      yearAnchor.value = addMonths(yearAnchor.value, n * 12)
      break
  }
}

function backToCurrent(): void {
  dayAnchor.value = today
  weekAnchor.value = today
  yearAnchor.value = today
}

/* ---------- 周期标签 ---------- */

function shortDay(date: string): string {
  const d = parseDate(date)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

const periodLabel = computed(() => {
  switch (view.value) {
    case 'day': {
      const d = parseDate(dayAnchor.value)
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY_LABELS[(d.getDay() + 6) % 7]}`
    }
    case 'week': {
      const [s, e] = weekRange.value
      return `${shortDay(s!)} – ${shortDay(e!)}${atCurrent.value ? ' · 本周' : ''}`
    }
    case 'year':
      return `${yearNum.value}年`
    default:
      return ''
  }
})

const currentWord = computed(() => {
  switch (view.value) {
    case 'day':
      return '今天'
    case 'week':
      return '本周'
    case 'year':
      return '今年'
    default:
      return ''
  }
})

/* ---------- 数据切片：统计 / 柱状图 / 分组列表 ---------- */

const periodWorkouts = computed<Workout[]>(() => {
  switch (view.value) {
    case 'day':
      return ex.allWorkouts.filter((w) => w.date === dayRange.value[0])
    case 'week': {
      const [s, e] = weekRange.value
      return ex.allWorkouts.filter((w) => w.date >= s! && w.date <= e!)
    }
    case 'year': {
      const y = String(yearNum.value)
      return ex.allWorkouts.filter((w) => w.date.slice(0, 4) === y)
    }
    default:
      return []
  }
})

const stats = computed(() => ({
  count: periodWorkouts.value.length,
  minutes: periodWorkouts.value.reduce((s, w) => s + w.durationMin, 0),
  kcal: periodWorkouts.value.reduce((s, w) => s + w.kcal, 0),
}))

const bars = computed(() => {
  if (view.value === 'week') {
    return weekDates(weekAnchor.value).map((date) => ({
      label: WEEKDAY_LABELS[(parseDate(date).getDay() + 6) % 7],
      value: periodWorkouts.value.filter((w) => w.date === date).reduce((s, w) => s + w.durationMin, 0),
      highlight: date === today,
    }))
  }
  if (view.value === 'year') {
    const curYear = Number(today.slice(0, 4))
    const curMonth = Number(today.slice(5, 7))
    return Array.from({ length: 12 }, (_, i) => {
      const mk = `${yearNum.value}-${String(i + 1).padStart(2, '0')}`
      return {
        label: String(i + 1),
        value: periodWorkouts.value.filter((w) => monthKey(w.date) === mk).reduce((s, w) => s + w.durationMin, 0),
        highlight: yearNum.value === curYear && i + 1 === curMonth,
      }
    })
  }
  return [] // 日视图无图表，直接看当天明细
})

interface Group {
  key: string
  label: string
  /** 组内次数：年视图按月分组时随组头给出（与月份拆成两层，不用「·」串成一行） */
  count?: number
  items: Workout[]
}

function dayGroupLabel(date: string): string {
  if (date === today) return '今天'
  if (date === addDays(today, -1)) return '昨天'
  return fmtDateCn(date)
}

const groups = computed<Group[]>(() => {
  if (view.value === 'day') {
    return [{ key: dayAnchor.value, label: '', items: periodWorkouts.value }]
  }
  if (view.value === 'week') {
    const byDate = new Map<string, Workout[]>()
    for (const w of periodWorkouts.value) {
      if (!byDate.has(w.date)) byDate.set(w.date, [])
      byDate.get(w.date)!.push(w)
    }
    return [...byDate.entries()].map(([date, items]) => ({ key: date, label: dayGroupLabel(date), items }))
  }
  const byMonth = new Map<string, Workout[]>()
  for (const w of periodWorkouts.value) {
    if (!byMonth.has(monthKey(w.date))) byMonth.set(monthKey(w.date), [])
    byMonth.get(monthKey(w.date))!.push(w)
  }
  return [...byMonth.entries()].map(([mk, items]) => ({
    key: mk,
    label: `${Number(mk.slice(5, 7))}月`,
    count: items.length,
    items,
  }))
})

/* ---------- 记录详情抽屉 ---------- */

const detailOpen = ref(false)
const detailWorkout = ref<Workout | null>(null)

function openDetail(w: Workout): void {
  detailWorkout.value = w
  detailOpen.value = true
}

/* ---------- 删除确认（破坏性操作：先确认再落库） ---------- */

const delOpen = ref(false)
const delTarget = ref<Workout | null>(null)

/** 行尾删除钮唯一入口：只开门，不删除 */
function askDelete(w: Workout): void {
  delTarget.value = w
  delOpen.value = true
}

/** 删除会级联抹掉该次训练的逐组力量记录并令力量曲线失效，
 *  故只有确认层里明确选中「删除」才真正落库。 */
async function confirmDelete(value: string): Promise<void> {
  if (value !== 'delete') return
  const target = delTarget.value
  delOpen.value = false
  delTarget.value = null
  if (!target) return
  await ex.remove(target.id)
}
</script>

<template>
  <div class="page">
    <!-- 页头副标题不写「按日 / 周 / 年」—— 那正是紧随其下的分段控件的三个选项 -->
    <PageHeader title="全部运动记录" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <SegmentedControl v-model="view" :options="viewOptions" class="seg" />

    <main :key="`${view}-${groups[0]?.key ?? periodLabel}`" class="content">
      <!-- 概览卡：周期导航 + 柱状图（周/年）+ 统计行 -->
      <section class="card">
        <header class="row between nav">
          <div class="row arrows">
            <button class="navbtn row center pressable" aria-label="上一周期" @click="shift(-1)">
              <ChevronLeft :size="17" />
            </button>
            <span class="nav-label num">{{ periodLabel }}</span>
            <button class="navbtn row center pressable" :disabled="!atCurrent" aria-label="下一周期" @click="shift(1)">
              <ChevronRight :size="17" />
            </button>
          </div>
          <button v-if="!atCurrent" class="pill row center pressable" @click="backToCurrent">{{ currentWord }}</button>
        </header>

        <ExerciseBars v-if="bars.length > 0" :bars="bars" class="chart" />

        <footer class="stat row">
          <Flame :size="15" style="color: var(--c-exercise)" />
          运动 <b class="num">{{ stats.count }}</b> 次 · <b class="num">{{ stats.minutes }}</b> 分钟 · <b class="num">{{ stats.kcal }}</b> 大卡
        </footer>
      </section>

      <!-- 记录列表：日视图单列；周视图按日分组；年视图按月分组
           （桌面按组摊成两栏，见样式里的桌面段）。
           卡头不另起标题 —— 它紧跟概览卡，与页标题说的是一回事 -->
      <section class="card records-card">
        <EmptyState
          v-if="periodWorkouts.length === 0 && !ex.loading"
          :icon="Dumbbell"
          title="这段时间还没有运动记录"
          hint="去「运动」页开始一次训练吧"
        />
        <template v-else>
          <div v-for="g in groups" :key="g.key" class="group">
            <h3 v-if="g.label" class="grouplabel">
              {{ g.label }}
              <span v-if="g.count" class="num gcount">{{ g.count }} 次</span>
            </h3>
            <ul>
              <WorkoutRow
                v-for="w in g.items"
                :key="w.id"
                :workout="w"
                :show-date="false"
                @detail="openDetail(w)"
                @remove="askDelete(w)"
              />
            </ul>
          </div>
        </template>
      </section>
    </main>

    <!-- 运动详情抽屉（Teleport；保证页面单根） -->
    <WorkoutDetailDrawer :open="detailOpen" :workout="detailWorkout" @close="detailOpen = false" />

    <!-- 删除确认层：行尾删除钮只负责开门，删除本身必须过这一层 -->
    <ActionSheet
      :open="delOpen"
      title="删除后这条训练记录与逐组明细一并移除，力量曲线同步重算，且无法恢复"
      :actions="[{ label: '删除', value: 'delete', danger: true }]"
      @select="confirmDelete"
      @close="delOpen = false"
    />
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.seg {
  /* 分段控件与下方内容 12（卡片间距） */
  margin-bottom: var(--gap-md);
}

/* 视图 / 周期切换的轻过渡 —— 连点翻周会反复重启，时长短到看不出重启 */
.content {
  animation: rise var(--dur-fast) var(--ease-out);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.nav {
  min-height: var(--sp-32);
  /* 周期导航与「回到本期」之间 8（无边界控件间距）；窄屏时下面是截断，不靠它兜底 */
  gap: var(--gap-sm);
}

/* 周期标签吃掉剩余宽度：320px 上「2026年10月1日 周四」+ 两枚 30px 箭头 + 「本周」
   会超出卡片内宽（256px）。给 .arrows flex:1 + .nav-label ellipsis 后，
   窄屏是标签截断而不是整行溢出；宽屏仍是标签居中、两侧箭头等距。 */
.arrows {
  flex: 1;
  min-width: 0;
  gap: var(--sp-10);
}

.navbtn {
  position: relative;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
}

/* 视觉 30 不动，热区撑到 44+（规则 5）：上下 8px 落在卡头 16px 内距里，
   横向 8px 只压到不可点的周期标签。 */
.navbtn::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-8));
}

.navbtn:disabled {
  opacity: var(--disabled-opacity);
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.pill {
  position: relative;
  flex: none;
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 视觉 ~22 高，热区 44+：上下各 12px 落在卡头内距与图表上方 12px 里；
   横向 6px 落在卡片自己的 16px 内距里（不越出卡面）。 */
.pill::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-12)) calc(-1 * var(--sp-6));
}

.chart {
  /* 主读数与图表 12（卡内区块间距） */
  margin-top: var(--gap-md);
}

.stat {
  gap: var(--gap-tight);
  /* 图表与统计行 12 */
  margin-top: var(--gap-md);
  padding-top: var(--sp-12);
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stat b {
  color: var(--text-1);
}

.group + .group {
  /* 记录分组之间 16（区块间距） */
  margin-top: var(--gap-lg);
}

/* 组头：月份/日期是标识（--text-2），次数拆出来降成尾注，不再「·」串成一行 */
.grouplabel {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  margin-bottom: var(--sp-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  letter-spacing: 0.4px;
  color: var(--text-2);
}

/* 组内次数：尾注档，不与组头标识抢层级 */
.gcount {
  font-weight: var(--fw-medium);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .content {
    animation: none;
  }
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   概览卡保持通栏：柱状图本来就是横向的时间轴（7 天 / 12 个月），压进半栏只会把柱子挤在一起。
   记录卡内部改成「一组一格」的多栏栅格 —— 日/周/年的记录都是按天（或按月）分组的，
   一组独占一格，组内不再断开，正好把 970px 的宽度用掉，也不会把「昨天」和「9 月 29 日」分离。

   栏数用 auto-fit 而不是定死两栏：日视图只有一组（当天），auto-fit 会把空轨道收掉，
   这一组就占满整行，不会在右半边留一块空白。 */
/* 日/周/年三段的分段控件跟着内容走：通栏拉到 970px 宽时一段就有 320px，读起来不像控件 */
.desk-main .seg {
  max-width: 280px;
}

.desk-main .records-card {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--desk-gap);
  align-items: start;
}

/* 卡头与空态永远通栏：它们是「整张卡的说明」，不属于某一栏 */
.desk-main .records-card > .head,
.desk-main .records-card > .empty {
  grid-column: 1 / -1;
}

/* 间距交给栅格 gap，否则组与组之间会多出 18px（相邻两格高度还不同，行距看着忽大忽小） */
.desk-main .records-card .group + .group {
  margin-top: 0;
}
</style>
