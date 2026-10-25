<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue'
import { ChevronRight, Dumbbell, Scale, Timer, TrendingUp, Wallet } from 'lucide-vue-next'

import WorkoutSourceTag from '@/components/exercise/WorkoutSourceTag.vue'
import { CATEGORY_META, MEAL_LABELS, MEAL_META, mealKcal } from '@/config/domain'
import { categoryOf, fmtCents } from '@/config/ledger'
import { useDietStore } from '@/stores/diet'
import { useExerciseStore } from '@/stores/exercise'
import { useFeaturesStore } from '@/stores/features'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm, nowMin, todayStr } from '@/utils/date'
import type { WorkoutSource } from '@/types'

/** 桌面主页 · 一日脊柱：把今天已发生的记录按时间轴纵向陈列，未来安排用虚线标示。 */

interface SpineEvent {
  key: string
  /** 距 00:00 的分钟数；无确切时间的记录不参与排序，排在末尾 */
  min: number | null
  label: string
  sub: string
  value: string | null
  colorVar: string
  icon: Component
  /** 运动记录的来源；非运动条目没有。只用来决定要不要打「手机同步」标签 */
  source?: WorkoutSource
  done?: boolean
  planned?: boolean
  live?: boolean
}

const today = todayStr()
/* 挂载时算一次会随时间失真：每 30s 刷新，保证「现在」分界与计划/已发生判定始终成立 */
const now = ref(nowMin())
let clockTimer: ReturnType<typeof setInterval> | null = null

const nutrition = useNutritionStore()
const diet = useDietStore()
const exercise = useExerciseStore()
const pomo = usePomodoroStore()
const ledger = useLedgerStore()
const todo = useTodoStore()
const features = useFeaturesStore()

/* 关掉的模块不必拉数据（插件层的收益之一：关掉的功能不产生请求）；
   脊柱把这些域的事件并进同一条时间轴，域不在就自然没有条目，不留空洞 */
const nutritionOn = computed(() => features.isEnabled('nutrition'))

onMounted(() => {
  if (nutritionOn.value) {
    void nutrition.loadSummary(today)
    void nutrition.loadMetrics(30)
  }
  void diet.load(today)
  void exercise.loadWeek(today)
  if (features.isEnabled('focus')) void pomo.loadToday()
  if (features.isEnabled('ledger')) void ledger.loadMonth()
  void todo.loadDay(today)
  clockTimer = setInterval(() => {
    now.value = nowMin()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer)
})

const events = computed<SpineEvent[]>(() => {
  const out: SpineEvent[] = []

  // 晨重（无准确时刻，固定排首）
  const metrics = nutrition.metrics
  const m0 = metrics.find((m) => m.date === today && m.weightKg != null)
  if (m0) {
    const prev = metrics.find((m) => m.date < today && m.weightKg != null)
    // 副行不再复述「体重记录」（标题「晨重 x kg」+ 左侧 Scale 图标已表态）；
    // 只留变化量，并补上单位
    let sub = ''
    if (prev?.weightKg != null && prev.weightKg !== 0) {
      const d = m0.weightKg! - prev.weightKg
      sub = `较前次 ${d >= 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(1)} kg`
    }
    out.push({ key: 'weight', min: 0, label: `晨重 ${m0.weightKg} kg`, sub, value: null, colorVar: 'var(--accent)', icon: Scale })
  }

  // 饮食记录
  for (const m of diet.meals) {
    const food = m.food
    const kcal = mealKcal(m)
    out.push({
      key: `meal-${m.id}`,
      min: minFromIso(m.createdAt),
      label: food?.name ?? MEAL_LABELS[m.mealType],
      sub: `${MEAL_LABELS[m.mealType]} · ${m.grams} g`,
      value: kcal != null ? `${kcal} kcal` : null,
      colorVar: MEAL_META[m.mealType].colorVar,
      icon: MEAL_META[m.mealType].icon,
    })
  }

  // 今日运动
  for (const w of exercise.weekWorkouts.filter((x) => x.date === today)) {
    out.push({
      key: `workout-${w.id}`,
      min: w.startMin,
      label: w.name,
      sub: `运动 · ${w.durationMin} 分钟`,
      value: `${w.kcal} kcal`,
      colorVar: 'var(--c-exercise)',
      icon: Dumbbell,
      source: w.source,
    })
  }

  // 番茄会话
  for (const s of pomo.todaySessions) {
    out.push({
      key: `pomo-${s.id}`,
      min: minFromIso(s.startedAt),
      label: '番茄 · 专注',
      sub: `${s.focusMin} 分钟`,
      value: null,
      colorVar: 'var(--mod-focus-tone)',
      icon: Timer,
    })
  }

  // 进行中的番茄（实时呼吸点）
  if (pomo.running) {
    out.push({
      key: 'pomo-live',
      min: now.value,
      label: pomo.phase === 'focus' ? '专注进行中' : '休息中',
      sub: pomo.displayTime,
      value: null,
      colorVar: 'var(--mod-focus-tone)',
      icon: Timer,
      live: true,
    })
  }

  // 今日收支
  for (const e of ledger.entries.filter((x) => x.date === today)) {
    const cat = categoryOf(e.category)
    const income = e.kind === 'income'
    out.push({
      key: `ledger-${e.id}`,
      min: minFromIso(e.createdAt),
      label: cat?.label ?? e.category,
      sub: e.note ?? (income ? '收入' : '支出'),
      value: `${income ? '+' : '-'}¥${fmtCents(e.amountCents)}`,
      colorVar: income ? 'var(--led-income)' : (cat?.colorVar ?? 'var(--led-expense)'),
      icon: income ? TrendingUp : Wallet,
    })
  }

  // 有时间安排的待办（未来 = 计划，虚线）
  for (const t of todo.dayTodos) {
    if (t.startMin == null) continue
    const done = t.status === 'done'
    out.push({
      key: `todo-${t.id}`,
      min: t.startMin,
      label: t.title,
      sub: CATEGORY_META[t.category].label + (t.durationMin ? ` · 约 ${t.durationMin} 分钟` : ''),
      value: null,
      colorVar: CATEGORY_META[t.category].colorVar,
      icon: ChevronRight,
      done,
      planned: !done && t.startMin > now.value,
    })
  }

  // 排序：有时间按分钟；无时间排在末尾（按是否有则后置）
  return [...out].sort((a, b) => {
    const am = a.min ?? 9999
    const bm = b.min ?? 9999
    return am - bm
  })
})

/** 展示行序列：在第一个未来事件前插入「现在」呼吸点（全部已发生则置于末尾） */
type Row = { type: 'ev'; e: SpineEvent } | { type: 'now' }
const rows = computed<Row[]>(() => {
  const arr: Row[] = []
  let inserted = false
  for (const e of events.value) {
    if (!inserted && e.min != null && e.min > now.value) {
      arr.push({ type: 'now' })
      inserted = true
    }
    arr.push({ type: 'ev', e })
  }
  if (!inserted && events.value.length) arr.push({ type: 'now' })
  return arr
})

function minFromIso(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function fmtMin(min: number | null): string {
  return min == null ? '—' : minToHHmm(min)
}
</script>

<template>
  <div class="spine">
    <div v-if="events.length" class="tl">
      <template v-for="row in rows" :key="row.type === 'now' ? 'now' : row.e.key">
        <div v-if="row.type === 'now'" class="nowrow">
          <span class="nowchip num">现在<br />{{ fmtMin(now) }}</span>
          <i class="nowdot" />
        </div>
        <div
          v-else
          class="ev"
          :class="{ plan: row.e.planned, live: row.e.live, done: row.e.done }"
          :style="{ '--ec': row.e.colorVar }"
        >
          <span class="time num">{{ fmtMin(row.e.min) }}</span>
          <i class="node" />
          <section class="ecard">
            <i class="eic"><component :is="row.e.icon" :size="19" /></i>
            <div class="col flex-1">
              <span class="ett-line">
                <span class="ett" :class="{ done: row.e.done }">{{ row.e.label }}</span>
                <WorkoutSourceTag v-if="row.e.source" :source="row.e.source" />
              </span>
              <span class="esb">{{ row.e.sub }}</span>
            </div>
            <b v-if="row.e.value" class="eval_ num">{{ row.e.value }}</b>
          </section>
        </div>
      </template>
    </div>
    <p v-else class="t-3 empty">今天还没有记录，从记一笔饮食或待办开始吧</p>
  </div>
</template>

<style scoped>
/* 在工作台列（--frame-max-wide 1240，居中）里再收一档并自己居中：
   时间轴整条走在列的中间，右侧不再单边空一截（1512 信息栏开时 222px，1920 收起 928px）。
   900 而不是 1240：卡面行拉得再宽，时间的纵轴就读不出来了。 */
.spine {
  max-width: 900px;
  margin-inline: auto;
  /* 底部留白 40（--sp-40）：与页面 PC 档的边距同档 */
  padding-bottom: var(--sp-40);
}

/* 72 是时间轴的**坐标几何**（时间列宽 54 + 卡与轴的缝 18），
   .tl::before 的 left: 0 与 .ev .time 的 left: -72px 都按它对齐 ——
   这不是页面间距，不参与 4/8 体系令牌，保持原值。 */
.tl {
  position: relative;
  padding-left: 72px;
}

.tl::before {
  content: '';
  position: absolute;
  left: 0;
  /* 纵轴两端各缩 8（--sp-8），不让线头从第一 / 最后一条卡里冒出来 */
  top: var(--sp-8);
  bottom: var(--sp-8);
  width: 2px;
  /* 2px 的线看不到圆角，统一收到最小一档 */
  border-radius: var(--radius-xs);
  background: var(--line);
}

.ev {
  position: relative;
  display: flex;
  /* 卡内图标 / 文本 / 读数三组之间 16（有明显边界） */
  gap: var(--gap-lg);
  /* 事件卡之间 12（--gap-md）：与页面卡片节奏一致（原来 10 让时间轴读成一串散块） */
  margin-bottom: var(--gap-md);
}

.ev .time {
  position: absolute;
  left: -72px;
  top: 14px;
  width: 54px;
  text-align: right;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.ev .node {
  position: absolute;
  left: -6.5px;
  top: 18px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: inset 0 0 0 2.5px var(--ec, var(--text-3));
  z-index: 1;
}

.ev .ecard {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  /* 时间轴卡片：内距 12×16（紧凑卡），圆角 16（--radius-m）——
     32 的圆角在 60 高的行上读成「被切掉一块」，卡片档统一 16 */
  padding: var(--pad-card-tight) var(--pad-card);
  background: var(--surface);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
}

.ev .eic {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--ec) 14%, transparent);
  color: var(--ec);
}

/* 标题行：名字 + 来源标签（只有手机同步进来的才有标签）。
   名字自己可截断，标签不吃压缩 —— 与 WorkoutRow 同一套排法 */
.ev .ett-line {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  min-width: 0;
}

.ev .ett {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ev .esb {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  /* 主次文本上下 2（--gap-text） */
  margin-top: var(--gap-text);
}

.ev .eval_ {
  margin-left: auto;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  white-space: nowrap;
  padding-left: var(--sp-12);
}

.ev.done .ett {
  color: var(--text-3);
  text-decoration: line-through;
}

/* 未来计划：虚线卡 */
.ev.plan .ecard {
  border: 1.6px dashed var(--line-strong);
  box-shadow: none;
  background: transparent;
}

/* 进行中：呼吸点 */
.ev.live .node {
  background: var(--accent);
  box-shadow: inset 0 0 0 2.5px var(--accent);
  animation: pulse 1.6s var(--ease-standard) infinite;
}

.nowrow {
  position: relative;
  height: 34px;
  margin-bottom: var(--sp-6);
}

.nowchip {
  position: absolute;
  left: -72px;
  top: 4px;
  width: 54px;
  text-align: right;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  color: var(--accent);
  line-height: var(--lh-caption);
}

.nowdot {
  position: absolute;
  left: -9px;
  top: 10px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.nowdot::after {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.6s var(--ease-standard) infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.empty {
  padding: var(--sp-40) 0;
  text-align: center;
  font-size: var(--fs-callout);
}

@media (prefers-reduced-motion: reduce) {
  .ev.live .node,
  .nowdot::after {
    animation: none;
  }
}
</style>
