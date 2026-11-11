<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Check,
  Clock,
  Flag,
  Hash,
  Infinity as InfinityIcon,
  Info,
  Minus,
  Plus,
  Sparkles,
  X,
} from 'lucide-vue-next'

import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm, todayStr } from '@/utils/date'
import {
  planCount,
  planUntil,
  resolveSmartPlan,
  type FocusPlan,
  type PlanContext,
} from '@/utils/focusPlan'

/**
 * 安排专注抽屉（智能 / 到点 / 按颗数 / 正计时）。
 *
 * 为什么不用 SheetModal：四套参数的内容高度差很多（≈300~560），固定 90% 档会在
 * footer 上方空出半屏。这里按内容自适应高度（上限 88dvh），底部只留一条结果预览 +
 * 开始按钮；内容超高时 body 自己滚。
 *
 * 计划全部由 utils/focusPlan 的纯函数算，抽屉只负责把当前时刻、待办与设置喂进去。
 * 「开始」时重新算一次（抽屉可能停留了几分钟），再交给 store.startPlan 锚定。
 */
type Mode = 'smart' | 'until' | 'count' | 'up'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** 打开时落在哪个模式（番茄钟入口 = smart，正计时入口 = up） */
    initialMode?: Mode
  }>(),
  { initialMode: 'smart' },
)
const emit = defineEmits<{ close: []; settings: [] }>()

const pomo = usePomodoroStore()
const todo = useTodoStore()
const today = todayStr()

const mode = ref<Mode>('smart')
const nowMs = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

const MODES: { id: Mode; label: string; icon: unknown }[] = [
  { id: 'smart', label: '智能', icon: Sparkles },
  { id: 'until', label: '到点', icon: Clock },
  { id: 'count', label: '按颗数', icon: Hash },
  { id: 'up', label: '正计时', icon: InfinityIcon },
]

/* ---------- 到点：日 / 时 / 分 ---------- */

const untilDay = ref<'today' | 'tomorrow'>('today')
const untilHour = ref(21)
const untilMinute = ref(0)
const MINUTE_STEP = 5
const ITEM_H = 44
const minuteValues = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP)
const hourWheel = ref<HTMLElement | null>(null)
const minWheel = ref<HTMLElement | null>(null)
let wheelTimer: ReturnType<typeof setTimeout> | null = null

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 分钟 → HH:mm；跨天（1440）显示 00:00，不显示 24:00 */
function minLabel(min: number): string {
  return minToHHmm(((min % 1440) + 1440) % 1440)
}

/** 打开时的默认到点：从现在起 1 小时，分钟向上取到 5 的倍数（跨天则落到明天） */
function resetUntilDefault(): void {
  const d = new Date(Date.now() + 60 * 60_000)
  d.setSeconds(0, 0)
  d.setMinutes(Math.ceil(d.getMinutes() / MINUTE_STEP) * MINUTE_STEP)
  const now = new Date()
  untilDay.value = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() ? 'today' : 'tomorrow'
  untilHour.value = d.getHours()
  untilMinute.value = d.getMinutes() - (d.getMinutes() % MINUTE_STEP)
}

function untilDeadlineMs(): number {
  const d = new Date(nowMs.value)
  const target = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + (untilDay.value === 'tomorrow' ? 1 : 0),
    untilHour.value,
    untilMinute.value,
    0,
    0,
  )
  return target.getTime()
}

function syncWheel(el: HTMLElement | null, value: number, step = 1): void {
  if (!el) return
  const index = step === 1 ? value : Math.round(value / step)
  el.scrollTo({ top: index * ITEM_H, behavior: 'smooth' })
}

function onWheelScroll(which: 'hour' | 'minute'): void {
  if (wheelTimer) clearTimeout(wheelTimer)
  wheelTimer = setTimeout(() => {
    const el = which === 'hour' ? hourWheel.value : minWheel.value
    if (!el) return
    const index = Math.round(el.scrollTop / ITEM_H)
    if (which === 'hour') untilHour.value = Math.min(23, Math.max(0, index))
    else untilMinute.value = minuteValues[Math.min(minuteValues.length - 1, Math.max(0, index))]!
  }, 80)
}

function pickHour(h: number): void {
  untilHour.value = h
  syncWheel(hourWheel.value, h)
}

function pickMinute(m: number): void {
  untilMinute.value = m
  syncWheel(minWheel.value, m, MINUTE_STEP)
}

function setUntilFromMs(ms: number): void {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  untilDay.value = sameDay ? 'today' : 'tomorrow'
  untilHour.value = d.getHours()
  untilMinute.value = d.getMinutes() - (d.getMinutes() % MINUTE_STEP)
  void nextTick(() => {
    syncWheel(hourWheel.value, untilHour.value)
    syncWheel(minWheel.value, untilMinute.value, MINUTE_STEP)
  })
}

function applyOffset(min: number): void {
  setUntilFromMs(Date.now() + min * 60_000)
}

function jumpToNextTodo(): void {
  const next = smart.value.nextTodo
  if (!next || next.startMin == null) return
  const d = new Date(nowMs.value)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, next.startMin, 0, 0)
  setUntilFromMs(target.getTime())
}

/* ---------- 计划计算 ---------- */

function ctx(now = Date.now()): PlanContext {
  return { nowMs: now, settings: pomo.settings, roundsDone: pomo.completedRounds }
}

const smart = computed(() =>
  resolveSmartPlan(ctx(nowMs.value), todo.dayTodos, pomo.settings.smartBufferMin),
)
const untilPlan = computed(() => planUntil(ctx(nowMs.value), untilDeadlineMs()))
const count = ref(4)
const countPlan = computed(() => planCount(ctx(nowMs.value), count.value))

const activePlan = computed<FocusPlan | null>(() => {
  if (mode.value === 'smart') return smart.value.plan
  if (mode.value === 'until') return untilPlan.value
  if (mode.value === 'count') return countPlan.value
  return null
})

const hint = computed(() => {
  if (mode.value === 'until') return '你告诉我「专注到几点」，我来排能塞下的番茄。'
  if (mode.value === 'count') return '自己定几颗，结束时间跟着算。'
  if (mode.value === 'up') return '不限时：由你决定什么时候收尾。'
  if (smart.value.kind === 'gap') return '当前没有进行中的待办：排到下一个待办之前，并留一段缓冲。'
  if (smart.value.kind === 'fallback') return '今天没有后续待办：按 4 颗标准番茄安排。'
  return '自动读取正在进行的待办，按它的结束时间排满一整套番茄。'
})

/* ---------- 智能卡片 ---------- */

const chosen = computed(() => smart.value.chosenTodo)
const others = computed(() =>
  smart.value.coveredTodos.filter((t) => t.id !== chosen.value?.id),
)
const nowMin = computed(() => {
  const d = new Date(nowMs.value)
  return d.getHours() * 60 + d.getMinutes()
})
const coverFill = computed(() => {
  const t = chosen.value
  if (!t || t.startMin == null || !t.durationMin) return 0
  return Math.max(0, Math.min(1, (nowMin.value - t.startMin) / t.durationMin)) * 100
})
const chosenRange = computed(() => {
  const t = chosen.value
  if (!t || t.startMin == null || !t.durationMin) return ''
  return `${minLabel(t.startMin)} – ${minLabel(t.startMin + t.durationMin)}`
})

const nextTodo = computed(() => smart.value.nextTodo)
const nextRange = computed(() => {
  const t = nextTodo.value
  if (!t || t.startMin == null || !t.durationMin) return ''
  return `${minLabel(t.startMin)} – ${minLabel(t.startMin + t.durationMin)}`
})
const gapFill = computed(() => {
  const p = smart.value.plan
  if (!p || smart.value.availableMin <= 0) return 0
  return Math.max(0, Math.min(100, (p.totalMin / smart.value.availableMin) * 100))
})
const bufferValue = computed({
  get: () => pomo.settings.smartBufferMin,
  set: (v: number) => {
    pomo.settings.smartBufferMin = Math.max(0, Math.min(60, Math.round(v / 5) * 5))
  },
})

/* ---------- 到点可用时间 ---------- */

const untilAvailableMin = computed(() =>
  Math.max(0, Math.floor((untilDeadlineMs() - nowMs.value) / 60_000)),
)
const untilAvailableText = computed(() => {
  const m = untilAvailableMin.value
  if (m <= 0) return '时间已过'
  const h = Math.floor(m / 60)
  const mm = m % 60
  return h > 0 ? `${h} 小时${mm > 0 ? ` ${mm} 分` : ''}` : `${mm} 分钟`
})
const untilRangeText = computed(() => {
  const now = new Date(nowMs.value)
  return `${pad(now.getHours())}:${pad(now.getMinutes())} → ${pad(untilHour.value)}:${pad(untilMinute.value)}`
})

/* ---------- 计划文案 ---------- */

function hm(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function breakdown(plan: FocusPlan): string {
  return plan.rounds
    .map((r, i) =>
      i < plan.rounds.length - 1 ? `${r.focusMin} + ${r.breakAfterMin}` : `${r.focusMin}`,
    )
    .join(' · ')
}

const footPlan = computed(() => (mode.value === 'up' ? null : activePlan.value))
const canStart = computed(() => mode.value === 'up' || footPlan.value != null)
const ctaLabel = computed(() => (mode.value === 'up' ? '开始正计时' : '开始专注'))
const footTitle = computed(() => {
  if (mode.value === 'up') return '正计时'
  if (!footPlan.value) return '时间不足'
  return `共 ${footPlan.value.rounds.length} 颗`
})
const footSub = computed(() => {
  if (mode.value === 'up') return '不限时 · 由你结束'
  const p = footPlan.value
  if (!p) return '至少留 10 分钟'
  return `专注 ${p.focusMin} · 休息 ${p.breakMin}${p.lastFocusMin ? ` · 末颗 ${p.lastFocusMin}` : ''}`
})
const footEnd = computed(() => (footPlan.value ? hm(footPlan.value.endAtMs) : '—'))
/* ---------- 开始 / 关闭 ---------- */

function close(): void {
  emit('close')
}

function openSettings(): void {
  emit('settings')
}

function start(): void {
  if (mode.value === 'up') {
    pomo.setMode('up')
    pomo.start()
    emit('close')
    return
  }
  // 抽屉可能开了几分钟：按点击这一刻重新算一份
  const plan =
    mode.value === 'smart'
      ? resolveSmartPlan(ctx(), todo.dayTodos, pomo.settings.smartBufferMin).plan
      : mode.value === 'until'
        ? planUntil(ctx(), untilDeadlineMs())
        : planCount(ctx(), count.value)
  if (!plan) return
  pomo.startPlan(plan)
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) close()
}

/* ---------- 生命周期 ---------- */

watch(
  () => props.open,
  (open) => {
    if (open) {
      mode.value = props.initialMode
      nowMs.value = Date.now()
      void todo.loadDay(today)
      resetUntilDefault()
      window.addEventListener('keydown', onKeydown)
      tickTimer ??= setInterval(() => {
        nowMs.value = Date.now()
      }, 15_000)
      void nextTick(() => {
        if (mode.value === 'until') {
          syncWheel(hourWheel.value, untilHour.value)
          syncWheel(minWheel.value, untilMinute.value, MINUTE_STEP)
        }
      })
    } else {
      window.removeEventListener('keydown', onKeydown)
      if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = null
      }
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (tickTimer) clearInterval(tickTimer)
  if (wheelTimer) clearTimeout(wheelTimer)
})

watch(mode, async (m) => {
  if (m === 'until' && props.open) {
    await nextTick()
    syncWheel(hourWheel.value, untilHour.value)
    syncWheel(minWheel.value, untilMinute.value, MINUTE_STEP)
  }
})

const suggested = computed(() => {
  const v = pomo.suggestedFocusMin
  return v != null && v !== pomo.settings.focusMin ? v : null
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fps">
      <div v-if="open" class="fps-overlay">
        <div class="fps-scrim" @click="close" />
        <section class="fps-panel" role="dialog" aria-label="安排专注">
          <div class="fps-grabber-zone"><i class="fps-grabber" /></div>
          <header class="fps-head">
            <h2>安排专注</h2>
            <div class="fps-head-actions">
              <button class="fps-settings" type="button" @click="openSettings">设置</button>
              <button class="fps-x" type="button" aria-label="关闭" @click="close">
                <X :size="15" :stroke-width="2.5" />
              </button>
            </div>
          </header>

          <div class="fps-body">
            <div class="fps-modes" role="tablist" aria-label="安排方式">
              <button
                v-for="m in MODES"
                :key="m.id"
                type="button"
                role="tab"
                :aria-selected="mode === m.id"
                class="fps-mode"
                :class="{ on: mode === m.id }"
                @click="mode = m.id"
              >
                <component :is="m.icon" :size="17" :stroke-width="2" />
                <span>{{ m.label }}</span>
              </button>
            </div>
            <p class="fps-hint">{{ hint }}</p>

            <!-- ═══ 智能 ═══ -->
            <template v-if="mode === 'smart'">
              <div v-if="chosen" class="fps-cover">
                <div class="fps-cover-top">
                  <span class="fps-tag-live"><i class="fps-dot live" />正在做</span>
                  <span class="fps-cover-src">按最晚结束</span>
                </div>
                <div class="fps-cover-title">{{ chosen.title }}</div>
                <div class="fps-cover-meta">{{ chosenRange }} · 还剩 {{ smart.availableMin }} 分钟</div>
                <div class="fps-track">
                  <i class="fps-track-fill" :style="{ width: `${coverFill}%` }" />
                  <i class="fps-track-now" :style="{ left: `${coverFill}%` }" />
                </div>
                <div class="fps-track-axis">
                  <span>{{ chosen.startMin != null ? minLabel(chosen.startMin) : '' }}</span>
                  <span class="now">现在 {{ minToHHmm(nowMin) }}</span>
                  <span>{{ chosen.startMin != null && chosen.durationMin ? minLabel(chosen.startMin + chosen.durationMin) : '' }}</span>
                </div>
              </div>

              <div v-else-if="nextTodo" class="fps-cover">
                <div class="fps-cover-top">
                  <span class="fps-tag-next"><i class="fps-dot" />接下来</span>
                  <span class="fps-cover-src">{{ nextTodo.startMin != null ? minLabel(nextTodo.startMin) : '' }} 开始</span>
                </div>
                <div class="fps-cover-title">{{ nextTodo.title }}</div>
                <div class="fps-cover-meta">{{ nextRange }}<template v-if="nextTodo.durationMin"> · {{ nextTodo.durationMin }} 分钟</template></div>
                <div class="fps-free-line">
                  <span>现在 {{ minToHHmm(nowMin) }}</span>
                  <i class="fps-free-bar"><b :style="{ width: `${gapFill}%` }" /></i>
                  <span>{{ smart.deadlineMs ? hm(smart.deadlineMs) : '' }} 收手</span>
                </div>
              </div>

              <div v-else class="fps-cover">
                <div class="fps-cover-top">
                  <span class="fps-tag-next"><i class="fps-dot" />今天没有后续安排</span>
                  <span class="fps-cover-src">{{ smart.plan ? `${smart.plan.rounds.length} 颗` : '时间不足' }}</span>
                </div>
                <div class="fps-cover-title">按 4 颗标准番茄安排</div>
                <div class="fps-cover-meta">也可以切到「正计时」，不限时</div>
              </div>

              <div v-if="others.length" class="fps-overlap">
                <div class="fps-overlap-h">同时覆盖 {{ others.length + 1 }} 个待办</div>
                <div class="fps-overlap-row">
                  <span v-for="t in others" :key="t.id" class="fps-ochip">
                    {{ t.title }}
                    <em v-if="t.startMin != null && t.durationMin">{{ minLabel(t.startMin) }}–{{ minLabel(t.startMin + t.durationMin) }}</em>
                  </span>
                </div>
                <p class="fps-overlap-note">有重复时以最晚结束的《{{ chosen?.title }}》为准。</p>
              </div>

              <div v-if="smart.kind === 'gap'" class="fps-buffer-card">
                <div class="fps-buffer-row">
                  <div class="fps-buffer-l">
                    <span class="fps-lbl">提前收手</span>
                    <span class="fps-sub">给下一个待办留一段缓冲</span>
                  </div>
                  <div class="fps-stepper">
                    <button type="button" @click="bufferValue -= 5"><Minus :size="13" /></button>
                    <b class="num">{{ bufferValue }}</b>
                    <em>分钟</em>
                    <button type="button" @click="bufferValue += 5"><Plus :size="13" /></button>
                  </div>
                </div>
                <p class="fps-remember"><Check :size="12" />已记住，下次自动沿用 {{ bufferValue }} 分钟</p>
              </div>

              <div class="fps-param">
                <div class="fps-pcell">
                  <span class="fps-lbl">专注时长</span>
                  <span class="fps-pval">{{ pomo.settings.focusMin }} <em>分钟</em></span>
                  <span class="fps-sub">整颗不变 · 末颗可缩短</span>
                </div>
                <div class="fps-pcell">
                  <span class="fps-lbl">休息时长</span>
                  <div class="fps-stepper sm">
                    <button type="button" @click="pomo.settings.breakMin = Math.max(5, pomo.settings.breakMin - 1)"><Minus :size="13" /></button>
                    <b class="num">{{ pomo.settings.breakMin }}</b>
                    <em>分钟</em>
                    <button type="button" @click="pomo.settings.breakMin = Math.min(30, pomo.settings.breakMin + 1)"><Plus :size="13" /></button>
                  </div>
                  <span class="fps-sub">最少 5 分钟</span>
                </div>
              </div>

              <div class="fps-note">
                <Info :size="14" />
                <span v-if="smart.plan">
                  {{ smart.availableMin }} 分钟排 {{ smart.plan.rounds.length }} 颗<template v-if="smart.plan.lastFocusMin">，末颗缩到 {{ smart.plan.lastFocusMin }} 分钟</template>。
                </span>
                <span v-else>可用时间不足 10 分钟，换一个更晚的到点或正计时吧。</span>
              </div>
            </template>

            <!-- ═══ 到点 ═══ -->
            <template v-else-if="mode === 'until'">
              <div class="fps-until-top">
                <span class="fps-lbl">专注到</span>
                <div class="fps-dayseg">
                  <button type="button" :class="{ on: untilDay === 'today' }" @click="untilDay = 'today'">今天</button>
                  <button type="button" :class="{ on: untilDay === 'tomorrow' }" @click="untilDay = 'tomorrow'">明天</button>
                </div>
              </div>

              <div class="fps-timebox">
                <i class="fps-wheel-band" />
                <div
                  ref="hourWheel"
                  class="fps-wheel"
                  @scroll.passive="onWheelScroll('hour')"
                >
                  <button
                    v-for="h in 24"
                    :key="h - 1"
                    type="button"
                    class="fps-wheel-item"
                    :class="{ on: untilHour === h - 1 }"
                    @click="pickHour(h - 1)"
                  >
                    {{ pad(h - 1) }}
                  </button>
                </div>
                <span class="fps-tcolon">:</span>
                <div
                  ref="minWheel"
                  class="fps-wheel"
                  @scroll.passive="onWheelScroll('minute')"
                >
                  <button
                    v-for="m in minuteValues"
                    :key="m"
                    type="button"
                    class="fps-wheel-item"
                    :class="{ on: untilMinute === m }"
                    @click="pickMinute(m)"
                  >
                    {{ pad(m) }}
                  </button>
                </div>
              </div>

              <div class="fps-avail">
                <b>可用 {{ untilAvailableText }}</b>
                <span>{{ untilRangeText }}</span>
              </div>
              <div class="fps-quickrow">
                <button type="button" @click="applyOffset(30)">+30 分</button>
                <button type="button" @click="applyOffset(45)">+45 分</button>
                <button type="button" @click="applyOffset(60)">+1 小时</button>
                <button v-if="nextTodo && nextTodo.startMin != null" type="button" @click="jumpToNextTodo">
                  下一待办 {{ minLabel(nextTodo.startMin) }}
                </button>
              </div>

              <div v-if="untilPlan" class="fps-result">
                <div class="fps-result-top">
                  <span>可排</span><b>{{ untilPlan.rounds.length }} 颗</b>
                  <span v-if="untilPlan.lastFocusMin" class="fps-rtag">最后一颗 {{ untilPlan.lastFocusMin }} 分钟</span>
                </div>
                <div class="fps-plan-bar">
                  <template v-for="(r, i) in untilPlan.rounds" :key="i">
                    <i class="pf" :style="{ flex: r.focusMin }" />
                    <i v-if="r.breakAfterMin" class="pb" :class="{ long: r.longBreak }" :style="{ flex: r.breakAfterMin }" />
                  </template>
                </div>
                <div class="fps-result-meta">
                  <span>{{ breakdown(untilPlan) }}</span>
                  <span>{{ hm(untilPlan.endAtMs) }} 结束</span>
                </div>
              </div>
              <div v-else class="fps-result empty">
                可用时间不足 10 分钟，至少留一颗番茄的时间。
              </div>
            </template>

            <!-- ═══ 按颗数 ═══ -->
            <template v-else-if="mode === 'count'">
              <div class="fps-count-hero">
                <button type="button" class="fps-round-step" @click="count = Math.max(1, count - 1)"><Minus :size="20" /></button>
                <div class="fps-cnum"><b class="num">{{ count }}</b><span>颗番茄</span></div>
                <button type="button" class="fps-round-step" @click="count = Math.min(24, count + 1)"><Plus :size="20" /></button>
              </div>
              <div class="fps-quickrow center">
                <button
                  v-for="n in [1, 2, 3, 4, 6]"
                  :key="n"
                  type="button"
                  :class="{ on: count === n }"
                  @click="count = n"
                >
                  {{ n }}
                </button>
              </div>

              <div class="fps-param">
                <div class="fps-pcell">
                  <span class="fps-lbl">专注</span>
                  <div class="fps-stepper sm">
                    <button type="button" @click="pomo.settings.focusMin = Math.max(5, pomo.settings.focusMin - 5)"><Minus :size="13" /></button>
                    <b class="num">{{ pomo.settings.focusMin }}</b>
                    <em>分钟</em>
                    <button type="button" @click="pomo.settings.focusMin = Math.min(120, pomo.settings.focusMin + 5)"><Plus :size="13" /></button>
                  </div>
                  <span class="fps-sub">每颗</span>
                </div>
                <div class="fps-pcell">
                  <span class="fps-lbl">休息</span>
                  <div class="fps-stepper sm">
                    <button type="button" @click="pomo.settings.breakMin = Math.max(5, pomo.settings.breakMin - 1)"><Minus :size="13" /></button>
                    <b class="num">{{ pomo.settings.breakMin }}</b>
                    <em>分钟</em>
                    <button type="button" @click="pomo.settings.breakMin = Math.min(30, pomo.settings.breakMin + 1)"><Plus :size="13" /></button>
                  </div>
                  <span class="fps-sub">颗与颗之间</span>
                </div>
              </div>

              <button v-if="suggested" type="button" class="fps-suggest" @click="pomo.settings.focusMin = suggested">
                试试 {{ suggested }} 分钟
                <span>近 7 天的完成段中位数</span>
              </button>

              <div v-if="countPlan" class="fps-estimate">
                <div class="fps-est-label"><Flag :size="13" />预计结束</div>
                <div class="fps-est-time num">{{ hm(countPlan.endAtMs) }}</div>
                <div class="fps-est-sub">从 {{ hm(nowMs) }} 起 · 共 {{ Math.floor(countPlan.totalMin / 60) }} 小时 {{ countPlan.totalMin % 60 }} 分（含 {{ Math.max(0, countPlan.rounds.length - 1) }} 次休息）</div>
                <div class="fps-plan-bar">
                  <template v-for="(r, i) in countPlan.rounds" :key="i">
                    <i class="pf" :style="{ flex: r.focusMin }" />
                    <i v-if="r.breakAfterMin" class="pb" :class="{ long: r.longBreak }" :style="{ flex: r.breakAfterMin }" />
                  </template>
                </div>
              </div>
            </template>

            <!-- ═══ 正计时 ═══ -->
            <template v-else>
              <div class="fps-up-hero">
                <div class="fps-up-clock">00<span class="colon">:</span>00<span class="colon">:</span>00</div>
                <p>做多久算多久，不自动跳休息</p>
              </div>
              <div class="fps-param">
                <div class="fps-pcell">
                  <span class="fps-lbl">每颗番茄</span>
                  <div class="fps-stepper sm">
                    <button type="button" @click="pomo.settings.focusMin = Math.max(5, pomo.settings.focusMin - 5)"><Minus :size="13" /></button>
                    <b class="num">{{ pomo.settings.focusMin }}</b>
                    <em>分钟</em>
                    <button type="button" @click="pomo.settings.focusMin = Math.min(120, pomo.settings.focusMin + 5)"><Plus :size="13" /></button>
                  </div>
                  <span class="fps-sub">每满 {{ pomo.settings.focusMin }} 分钟记一颗</span>
                </div>
                <div class="fps-pcell">
                  <span class="fps-lbl">休息</span>
                  <span class="fps-pval">不进入</span>
                  <span class="fps-sub">结束后零头记为中断段</span>
                </div>
              </div>
              <div class="fps-note">
                <Info :size="14" />
                <span>适合「做多久算多久」的深工作；结束后最后一段零头按中断段记账。</span>
              </div>
            </template>
          </div>

          <footer class="fps-foot">
            <div class="fps-foot-sum">
              <div class="fps-fs-left">
                <b>{{ footTitle }}</b>
                <span>{{ footSub }}</span>
              </div>
              <div class="fps-fs-right">
                <span>预计结束</span>
                <b class="num">{{ footEnd }}</b>
              </div>
            </div>
            <button type="button" class="fps-cta" :disabled="!canStart" @click="start">{{ ctaLabel }}</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fps-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
}

.fps-scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim);
}

.fps-panel {
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--frame-max);
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.16);
  overflow: hidden;
}

.fps-grabber-zone {
  flex: none;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fps-grabber {
  width: 36px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--surface-3);
}

.fps-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--pad-sheet) var(--sp-10);
}

.fps-head h2 {
  margin: 0;
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.fps-head-actions { display: inline-flex; align-items: center; gap: var(--sp-6); }

.fps-settings {
  height: 30px;
  padding: 0 var(--sp-10);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  font-family: inherit;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fps-x {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
}

.fps-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 var(--pad-sheet);
}

/* ---------- 模式滑轨 ---------- */
.fps-modes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
  padding: 4px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.fps-mode {
  height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 0;
  border-radius: var(--radius-m-nest);
  background: transparent;
  color: var(--text-2);
  font-family: inherit;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.fps-mode.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-thumb);
}

.fps-mode.on svg { color: var(--mod-focus-strong); }

.fps-hint {
  margin: var(--sp-10) var(--sp-2) var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--text-2);
  text-wrap: balance;
}

/* ---------- 智能卡片 ---------- */
.fps-cover {
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
}

.fps-cover-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
}

.fps-tag-live,
.fps-tag-next {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.fps-tag-live { color: var(--mod-focus-strong); }
.fps-tag-next { color: var(--text-2); }

.fps-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
}

.fps-dot.live {
  background: var(--mod-focus-tone);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--mod-focus-tone) 14%, transparent);
}

.fps-cover-src {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fps-cover-title {
  margin-top: var(--sp-6);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.2px;
}

.fps-cover-meta {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.fps-track {
  position: relative;
  height: 6px;
  margin-top: var(--sp-12);
  border-radius: 3px;
  background: var(--surface-3);
}

.fps-track-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: var(--mod-focus-tone);
  opacity: 0.65;
}

.fps-track-now {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 0 0 2.5px var(--mod-focus-tone);
  transform: translate(-50%, -50%);
}

.fps-track-axis {
  display: flex;
  justify-content: space-between;
  margin-top: var(--sp-6);
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.fps-track-axis .now { color: var(--mod-focus-strong); font-weight: var(--fw-semibold); }

.fps-free-line {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  margin-top: var(--sp-12);
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.fps-free-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--surface-3);
  overflow: hidden;
}

.fps-free-bar b {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--mod-focus-tone);
  opacity: 0.55;
}

.fps-overlap { margin-top: var(--gap-md); }

.fps-overlap-h {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fps-overlap-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-6);
  margin-top: var(--sp-6);
}

.fps-ochip {
  display: inline-flex;
  align-items: baseline;
  gap: var(--sp-6);
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.fps-ochip em {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-regular);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.fps-overlap-note {
  margin: var(--sp-6) 0 0;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.fps-buffer-card {
  margin-top: var(--gap-md);
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
}

.fps-buffer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
}

.fps-buffer-l { display: flex; flex-direction: column; gap: 2px; }

.fps-remember {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  margin: var(--sp-10) 0 0;
  padding-top: var(--sp-8);
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.fps-remember svg { color: var(--mod-focus-strong); }

/* ---------- 参数 ---------- */
.fps-param {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin-top: var(--gap-md);
  padding: var(--sp-10) 0;
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
}

.fps-pcell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 var(--sp-12);
  min-width: 0;
}

.fps-pcell + .fps-pcell { border-left: 0.5px solid var(--line-strong); }

.fps-lbl { font-size: var(--fs-caption); color: var(--text-2); }

.fps-pval {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.fps-pval em,
.fps-stepper em {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-regular);
  color: var(--text-3);
}

.fps-sub { font-size: var(--fs-micro); color: var(--text-3); }

.fps-stepper {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  align-self: flex-start;
  padding: 2px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.fps-stepper button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-2);
  box-shadow: var(--shadow-thumb);
}

.fps-stepper b {
  min-width: 22px;
  text-align: center;
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.fps-stepper.sm { padding: 1px; }
.fps-stepper.sm button { width: 26px; height: 26px; }

.fps-note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-6);
  margin: var(--gap-md) 0 var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
  text-wrap: balance;
}

.fps-note svg { margin-top: 2px; color: var(--text-3); flex: none; }

/* ---------- 到点 ---------- */
.fps-until-top {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  margin-bottom: var(--sp-8);
}

.fps-until-top .fps-lbl { font-size: var(--fs-footnote); font-weight: var(--fw-semibold); }

.fps-dayseg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.fps-dayseg button {
  height: 26px;
  padding: 0 var(--sp-12);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  font-family: inherit;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fps-dayseg button.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-thumb);
}

.fps-timebox {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-12);
  height: 132px;
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
  overflow: hidden;
}

.fps-wheel-band {
  position: absolute;
  left: var(--sp-8);
  right: var(--sp-8);
  top: 44px;
  height: 44px;
  border-radius: var(--radius-m-nest);
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  pointer-events: none;
}

.fps-wheel {
  position: relative;
  z-index: 1;
  width: 92px;
  height: 132px;
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  scrollbar-width: none;
  padding: 44px 0;
}

.fps-wheel::-webkit-scrollbar { display: none; }

.fps-wheel-item {
  display: block;
  width: 100%;
  height: 44px;
  border: 0;
  background: transparent;
  scroll-snap-align: center;
  font-family: inherit;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  opacity: 0.5;
}

.fps-wheel-item.on {
  font-size: 34px;
  font-weight: var(--fw-semibold);
  letter-spacing: -0.5px;
  color: var(--text-1);
  opacity: 1;
}

.fps-tcolon {
  position: relative;
  z-index: 1;
  font-size: 30px;
  font-weight: var(--fw-light);
  color: var(--mod-focus-tone);
  transform: translateY(-2px);
}

.fps-avail {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--sp-8);
  margin-top: var(--sp-10);
}

.fps-avail b {
  padding: 4px 10px;
  border-radius: var(--radius-full);
  background: var(--mod-focus-soft);
  color: var(--mod-focus-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.fps-avail span {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.fps-quickrow {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-8);
  margin-top: var(--sp-10);
}

.fps-quickrow.center { justify-content: center; }

.fps-quickrow button {
  height: 32px;
  padding: 0 var(--sp-12);
  border: 0;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-family: inherit;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fps-quickrow button.on {
  background: var(--text-1);
  color: var(--bg);
}

.fps-quickrow.center button {
  min-width: 52px;
  font-variant-numeric: tabular-nums;
}

.fps-result {
  margin: var(--gap-md) 0;
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
}

.fps-result.empty {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.fps-result-top {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.fps-result-top b { font-size: var(--fs-title2); font-weight: var(--fw-bold); color: var(--text-1); }

.fps-rtag {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.fps-result-meta {
  display: flex;
  justify-content: space-between;
  margin-top: var(--sp-8);
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* ---------- 计划条 ---------- */
.fps-plan-bar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 6px;
  margin-top: var(--sp-8);
}

.fps-plan-bar .pf {
  display: block;
  border-radius: 3px;
  background: var(--mod-focus-tone);
}

.fps-plan-bar .pb {
  display: block;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
}

.fps-plan-bar .pb.long { background: color-mix(in srgb, var(--text-1) 14%, transparent); }

/* ---------- 按颗数 ---------- */
.fps-count-hero {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-24);
  padding: var(--sp-8) 0;
}

.fps-round-step {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
}

.fps-cnum { display: flex; align-items: baseline; gap: var(--sp-6); }

.fps-cnum b {
  font-size: var(--fs-display-l);
  font-weight: var(--fw-light);
  letter-spacing: -1px;
  line-height: 1;
  color: var(--text-1);
}

.fps-cnum span { font-size: var(--fs-caption); color: var(--text-2); }

.fps-suggest {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
  margin: var(--gap-md) auto 0;
  padding: 6px 12px;
  border: 0;
  border-radius: var(--radius-full);
  background: var(--mod-focus-soft);
  color: var(--mod-focus-strong);
  font-family: inherit;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.fps-suggest span { font-size: var(--fs-micro); font-weight: var(--fw-regular); color: var(--text-2); }

.fps-estimate {
  margin: var(--gap-md) 0;
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--mod-focus-soft);
}

.fps-est-label {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--mod-focus-strong);
}

.fps-est-time {
  margin-top: 2px;
  font-size: var(--fs-title1);
  font-weight: var(--fw-bold);
  letter-spacing: -0.6px;
  line-height: 1.2;
  color: var(--text-1);
}

.fps-est-sub { font-size: var(--fs-caption); color: var(--text-2); }

/* ---------- 正计时 ---------- */
.fps-up-hero {
  margin-top: var(--sp-8);
  padding: var(--sp-24) var(--sp-16);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
  text-align: center;
}

.fps-up-clock {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-light);
  letter-spacing: -1px;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
}

.fps-up-clock .colon { padding: 0 1px; color: var(--mod-focus-tone); }

.fps-up-hero p { margin: var(--sp-8) 0 0; font-size: var(--fs-caption); color: var(--text-2); }

/* ---------- 底部 ---------- */
.fps-foot {
  flex: none;
  padding: var(--sp-12) var(--pad-sheet) calc(var(--sp-12) + 10px);
  border-top: 0.5px solid var(--line);
  background: var(--surface);
}

.fps-foot-sum {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--gap-md);
  margin-bottom: var(--sp-10);
}

.fps-fs-left { display: flex; flex-direction: column; gap: 1px; }
.fps-fs-left b { font-size: var(--fs-headline); font-weight: var(--fw-bold); letter-spacing: -0.2px; }
.fps-fs-left span { font-size: var(--fs-caption); color: var(--text-2); }

.fps-fs-right { display: flex; align-items: baseline; gap: var(--sp-6); }
.fps-fs-right span { font-size: var(--fs-caption); color: var(--text-2); }
.fps-fs-right b { font-size: var(--fs-title3); font-weight: var(--fw-bold); color: var(--text-1); }

.fps-cta {
  width: 100%;
  height: 52px;
  border: 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent, #fff);
  font-family: inherit;
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  letter-spacing: 0.2px;
  box-shadow: var(--shadow-float);
}

.fps-cta:disabled {
  opacity: var(--disabled-opacity);
  box-shadow: none;
}

.fps-cta:active:not(:disabled) { transform: scale(0.98); }

/* ---------- 进出场 ---------- */
.fps-enter-active,
.fps-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}

.fps-enter-active .fps-panel,
.fps-leave-active .fps-panel {
  transition: transform var(--dur-base) var(--ease-sheet);
}

.fps-enter-from,
.fps-leave-to { opacity: 0; }

.fps-enter-from .fps-panel,
.fps-leave-to .fps-panel { transform: translate(-50%, 100%); }

@media (prefers-reduced-motion: reduce) {
  .fps-enter-active,
  .fps-leave-active,
  .fps-enter-active .fps-panel,
  .fps-leave-active .fps-panel { transition: none; }
}
</style>
