<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Sparkles,
  Timer,
  X,
} from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import RingProgress from '@/components/common/RingProgress.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import FocusPlanSheet from '@/components/pomodoro/FocusPlanSheet.vue'
import FocusTimePicker from '@/components/pomodoro/FocusTimePicker.vue'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { enterFocusImmersive } from '@/system/focusImmersive'
import { fmtClockSec } from '@/utils/clock'
import { minToHHmm, todayStr } from '@/utils/date'
import { resolveSmartPlan, type FocusPlan } from '@/utils/focusPlan'
import type { PomodoroMode } from '@/types'

/**
 * 番茄钟 · 专注视图主面。
 *
 * 空闲态不再直接暴露「专注 / 休息 / 暂停」三格设置，而是一条**计划条**：
 * 智能读取正在进行的待办 → 算出几颗、末颗多长、预计几点结束；主按钮一键开始。
 * 想换排法点计划条进「安排专注」抽屉（智能 / 到点 / 按颗数 / 正计时）。
 *
 * 读数口径：倒计时用 mm:ss（设置上限 120 分钟，90:00 仍可读）；正计时用 HH:MM:SS
 * （会跨过 59:59）。冒号单独着色，数字保持中性。
 */
const pomo = usePomodoroStore()
const todo = useTodoStore()

/* ---------- 安排抽屉 / 设置抽屉 ---------- */
const planOpen = ref(false)
const settingsOpen = ref(false)

/** 智能计划的「现在」：空闲时每 30 秒走一格，待办时间推进后计划条能跟着变 */
const nowMs = ref(Date.now())
let idleTick: ReturnType<typeof setInterval> | null = null

function openPlan(): void {
  if (pomo.active) return
  planOpen.value = true
}

function openSettings(): void {
  planOpen.value = false
  settingsOpen.value = true
}

const smart = computed(() =>
  resolveSmartPlan(
    { nowMs: nowMs.value, settings: pomo.settings, roundsDone: pomo.completedRounds },
    todo.dayTodos,
    pomo.settings.smartBufferMin,
  ),
)

/** 空闲态展示的计划（正计时 / 进行中不展示） */
const idlePlan = computed<FocusPlan | null>(() =>
  pomo.settings.mode === 'down' && !pomo.active ? smart.value.plan : null,
)

/** 计划条的待办标题：进行中优先，其次下一个 */
const planTodoTitle = computed(
  () => smart.value.chosenTodo?.title ?? smart.value.nextTodo?.title ?? null,
)

// 保持原有的挂载加载：今日记录 + 今日待办（待办为空时才拉，避免与 FocusPage 重复请求）
onMounted(() => {
  void pomo.loadToday()
  if (todo.dayTodos.length === 0) void todo.loadDay(todayStr())
  idleTick = setInterval(() => {
    if (!pomo.active) nowMs.value = Date.now()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (idleTick) clearInterval(idleTick)
  idleTick = null
})

/* ---------- 页头 · 计时方向 ---------- */

/** 标题就是当前方向名：切到正计时后整块读数的算法都变了，标题必须跟着走 */
const modeTitle = computed(() => (pomo.settings.mode === 'down' ? '番茄钟' : '正计时'))

const modeOptions = [
  { value: 'down', label: '番茄钟' },
  { value: 'up', label: '正计时' },
]

/**
 * 进行中不换向。SegmentedControl 没有 disabled 属性，所以禁用分两路兜：
 * 视觉/鼠标一路是 `.mode-switch.locked` 的 pointer-events（连按压反馈一起断掉），
 * 键盘一路是这里的守卫（分段控件用方向键也能改选项，只挡鼠标会漏）。
 * 两路都不能省：只挡一路，用户就能在计时中途把方向改掉。
 */
function onModeChange(value: string): void {
  if (pomo.active) return
  pomo.setMode(value as PomodoroMode)
}

/* ---------- 环内读数 ---------- */

/** 环色：专注相位与正计时都走专注模块自己的 --mod-focus-tone；只有「倒计时的休息相位」
 *  才退回中性的 --cat-general（休息不属于专注，硬塞一支有域语义的彩是错配）。 */
const ringColorVar = computed(() =>
  pomo.phase === 'break' && pomo.settings.mode === 'down' ? '--cat-general' : '--mod-focus-tone',
)

/**
 * 读数上一行的说明。四态各自不同：
 * 未起跑给引导、暂停态如实说「停着」（读数冻在那里，不点明会被读成还在走）、
 * 专注中给第几颗番茄、休息中给休息文案。第 N 颗的 N 取 `completedRounds + 1`：
 * completedRounds 是「今天已完成的整轮」，+1 才是「正在做的这一颗」。
 */
const caption = computed(() => {
  if (!pomo.active) {
    if (pomo.settings.mode === 'up') return '开始专注吧'
    if (!idlePlan.value) return '可用时间不足 10 分钟'
    return `智能安排 · 共 ${idlePlan.value.rounds.length} 颗`
  }
  if (!pomo.running) return pomo.phase === 'break' ? '休息已暂停' : '专注已暂停'
  if (pomo.phase === 'break') return '休息一下'
  if (pomo.plan) return `第 ${pomo.planRoundNo} 颗 / 共 ${pomo.planRounds} 颗`
  return `第 ${pomo.completedRounds + 1} 颗番茄`
})

/** 空闲态展示计划的第一颗时长（末颗可能被压缩 → 18:00 这种）；正计时仍用三段式 */
const cardClock = computed(() => {
  if (!pomo.active && pomo.settings.mode === 'down' && idlePlan.value) {
    return fmtClockSec((idlePlan.value.rounds[0]?.focusMin ?? pomo.settings.focusMin) * 60)
  }
  return pomo.settings.mode === 'up' ? pomo.clockTime : pomo.displayTime
})

/** 按冒号切段：模板把 `:` 单独渲染成带色相的 span，数字保持中性 */
const clockParts = computed(() => cardClock.value.split(':'))

/** 双击环 / 读数 = 进沉浸。手势只挂在这一层：不进菜单、不占按钮位 ——
 *  沉浸层是整个专注面的「放大」，手势比按钮更贴它的语义。 */
function onEnterImmersive(): void {
  enterFocusImmersive()
}

/** 暂停累计读作 m:ss —— 上限虽是分钟级，但头一分钟里显示「0 分钟」等于什么都没说 */
const pausedText = computed(() => {
  const t = pomo.pausedAccumSec
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
})

/* ---------- 关联待办 ---------- */

const linkedTodo = computed(() => todo.dayTodos.find((t) => t.id === pomo.linkedTodoId) ?? null)
/** 空闲时优先显示智能计划覆盖的待办；进行中显示本轮关联的待办 */
const pickLabel = computed(
  () =>
    (pomo.active ? linkedTodo.value?.title : planTodoTitle.value ?? linkedTodo.value?.title) ??
    '在做哪件',
)

/** 菜单项：done 的待办不可选；已关联时补一条「不关联」 */
const todoMenu = computed<MenuItem[]>(() => {
  const items: MenuItem[] = todo.dayTodos
    .filter((t) => t.status !== 'done')
    .map((t) => ({ label: t.title, value: String(t.id) }))
  if (pomo.linkedTodoId != null) items.push({ label: '不关联待办', value: '' })
  return items
})
const todoMenuOpen = ref(false)
const pickBtn = ref<HTMLButtonElement | null>(null)

function onPickTodo(value: string): void {
  pomo.setLinkedTodo(value === '' ? null : Number(value))
}

/* ---------- 控制簇 ---------- */

/** 回到本番茄钟初只在「本相位已经有投入」时可点：刚起跑的那一秒回退是空操作，
 *  留一颗点了没反应的按钮比留一颗灰按钮更容易被当成 bug。 */
const canRewind = computed(() =>
  pomo.settings.mode === 'up' ? pomo.upElapsedSec > 0 : pomo.remainingSec < pomo.phaseTotalSec,
)

/** 暂停 / 继续。start() 幂等（已在跑就直接返回），暂停态再点即续走 */
function toggleRun(): void {
  if (pomo.running) pomo.pause()
  else pomo.start()
}

/** 提前结束本阶段：专注相位走下面那条 ActionSheet（记录 / 放弃各有代价，文案即代价）；
 *  休息相位就是「跳过休息」—— 直接交给 store 的 endPhase()（它在这个相位里等价于
 *  reset()）。休息不计入记录，跳过没有任何数据损失，不必再弹确认。 */
function onEndPhase(): void {
  if (pomo.phase === 'break') {
    void pomo.endPhase()
    return
  }
  endOpen.value = true
}

/** 放弃本轮 / 跳过休息：单独一条确认。它是**破坏性**动作（专注相位里放弃 = 这一轮不留
 *  任何记录），与「提前结束」的入口分开摆，避免误触。 */
const giveUpOpen = ref(false)
const giveUpTitle = computed(() =>
  pomo.phase === 'break'
    ? '跳过休息会直接回到下一轮专注；休息不计入记录，跳过不影响已保存的专注'
    : '放弃则这一轮不留记录',
)
const giveUpActions = computed<{ label: string; value: string; danger?: boolean }[]>(() =>
  pomo.phase === 'break'
    ? [{ label: '跳过休息', value: 'yes' }]
    : [{ label: '放弃本轮（不留记录）', value: 'yes', danger: true }],
)
function onGiveUpPick(value: string): void {
  if (value === 'yes') pomo.reset()
}

/* ---------- 结束流程（保留原有语义与文案） ---------- */

const endOpen = ref(false)

/** 本段已投入的秒数。正计时的真源是 upElapsedSec；倒计时用「冻结总秒数 − 剩余秒数」，
 *  两者同源，不能混算（正计时下 phaseTotalSec 是计划时长、remainingSec 停在总秒数上，
 *  相减恒为 0 —— 那会把「已投入 12 分钟」误报成「还不到 1 分钟」）。 */
const endElapsedSec = computed(() =>
  pomo.settings.mode === 'up' ? pomo.upElapsedSec : Math.max(0, pomo.phaseTotalSec - pomo.remainingSec),
)
/** 是否够写一条中断记录：与 store 的 60 秒门槛同源，避免文案许下做不到的承诺 */
const endWillRecord = computed(() => endElapsedSec.value >= 60)
const endElapsedMin = computed(() => Math.max(1, Math.round(endElapsedSec.value / 60)))

/** 文案即代价（同 ActiveWorkoutBar）：说清记录 / 放弃各会拿走什么、留下什么。
 *  不足 1 分钟时 store 按误触处理、不写记录 —— 文案要如实说，不能让用户以为「记录了」。
 *  正计时没有「进入休息」这一步（它不自动休息），收尾只把最后不满一颗的零头按中断口径记账。 */
const endTitle = computed(() => {
  if (pomo.settings.mode === 'up') {
    return endWillRecord.value
      ? `现在结束会把最后这 ${endElapsedMin.value} 分钟零头记成中断段；放弃则这一轮不留记录`
      : '最后这段不足 1 分钟：结束不会留下记录。可以结束，或直接放弃'
  }
  return endWillRecord.value
    ? `现在结束会把这一段记下来（${endElapsedMin.value} 分钟），然后进入休息；放弃则不留记录`
    : '还不到 1 分钟：结束不会留下记录。可以进入休息，或直接放弃这一轮'
})
const endActions = computed<{ label: string; value: string; danger?: boolean }[]>(() => {
  if (pomo.settings.mode === 'up') {
    return endWillRecord.value
      ? [
          { label: '结束并保留零头', value: 'record' },
          { label: '放弃（不留记录）', value: 'discard', danger: true },
        ]
      : [
          { label: '结束这一段', value: 'record' },
          { label: '放弃这一轮', value: 'discard', danger: true },
        ]
  }
  return endWillRecord.value
    ? [
        { label: '记录这一段，进入休息', value: 'record' },
        { label: '放弃本轮（不留记录）', value: 'discard', danger: true },
      ]
    : [
        { label: '进入休息', value: 'record' },
        { label: '放弃这一轮', value: 'discard', danger: true },
      ]
})

function onEndPick(value: string): void {
  if (value === 'discard') pomo.reset()
  else void pomo.endRound()
}

/* ---------- 计划条 / 开始 ---------- */

function hm(ms: number): string {
  const d = new Date(ms)
  return minToHHmm(d.getHours() * 60 + d.getMinutes())
}

const planEndLabel = computed(() => (idlePlan.value ? hm(idlePlan.value.endAtMs) : ''))
const planModeLabel = computed(() => (pomo.settings.mode === 'up' ? '正计时' : '智能'))
const nowMinOfDay = computed(() => {
  const d = new Date(nowMs.value)
  return d.getHours() * 60 + d.getMinutes()
})

function formatRemain(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h} 小时${m > 0 ? ` ${m} 分` : ''}` : `${m} 分钟`
}

/** 空档 / 没有待办时的原因行；进行中时由 store 的计划说话 */
const planHeadline = computed(() => {
  if (pomo.settings.mode === 'up') return '正计时 · 不限时'
  if (smart.value.kind === 'ongoing' && smart.value.chosenTodo) {
    return `正在做《${smart.value.chosenTodo.title}》`
  }
  if (smart.value.kind === 'gap' && smart.value.nextTodo) {
    return `接下来《${smart.value.nextTodo.title}》`
  }
  if (smart.value.kind === 'fallback') return '今天没有后续安排'
  return '可用时间不足 10 分钟'
})

/** 运行中计划还剩多少分钟（含后续颗/休息；暂停不实时累加） */
const planRemainMin = computed(() => {
  const end = pomo.estimatedEndAt
  if (!end) return null
  return Math.max(0, Math.round((end.getTime() - nowMs.value) / 60_000))
})

/** 主按钮：有计划直接开；没计划（时间不够）进抽屉调整；正计时直接开始 */
function onStart(): void {
  if (pomo.settings.mode === 'up') {
    pomo.start()
    return
  }
  if (idlePlan.value) {
    pomo.startPlan(idlePlan.value)
    return
  }
  planOpen.value = true
}

/* ---------- 今日番茄计数 ---------- */

/** 显示上限：番茄可以攒到几十颗，一列摆满会溢出卡片，超出的折成 +N（完整数字在右侧 × N 里） */
const MAX_FIGS = 8
const figCount = computed(() => Math.min(pomo.todayCompletedCount, MAX_FIGS))
const figMore = computed(() => Math.max(0, pomo.todayCompletedCount - MAX_FIGS))

/* ---------- 卡底口径 ---------- */

/** 完整段分钟数。store 只暴露了段数计数，分钟从唯一真源 todaySessions 派生，
 *  保证「完整段」与「中断段」两组分钟各自独立、不被混算 */
const doneMin = computed(() =>
  pomo.todaySessions.filter((s) => s.completed).reduce((a, s) => a + s.focusMin, 0),
)
const interruptedMin = computed(() =>
  pomo.todaySessions.filter((s) => !s.completed).reduce((a, s) => a + s.focusMin, 0),
)
const hasToday = computed(() => pomo.todayCompletedCount > 0 || pomo.todayInterruptedCount > 0)
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>{{ modeTitle }}</h2>
      <span class="head-right">
        <!-- 方向开关：切的是读数口径，不是显示偏好 —— 起跑后锁死（理由见脚本 onModeChange） -->
        <span class="mode-switch" :class="{ locked: pomo.active }">
          <SegmentedControl
            :options="modeOptions"
            :model-value="pomo.settings.mode"
            @update:model-value="onModeChange"
          />
        </span>
        <InfoHint title="计时方向">
          <p>番茄钟 = 倒计时：从设定时长往下走，走满进入休息。</p>
          <p>正计时 = 往上累加：每满一个设定的专注时长记一颗番茄并继续走，不进休息，由你主动结束。</p>
          <p>计时进行中不能换方向 —— 已投入的时间是按当前方向记账的。想换向，先结束或放弃本轮。</p>
        </InfoHint>
      </span>
    </header>

    <div class="col center body">
      <!-- 双击进沉浸：手势面覆盖环与读数，但不含下面的关联待办（那一颗有自己的单击语义） -->
      <div class="ring-wrap" title="双击时间进入沉浸模式" @dblclick="onEnterImmersive">
        <RingProgress
          :value="pomo.active ? pomo.progress : 1"
          :color-var="pomo.active ? ringColorVar : '--mod-focus-soft'"
          :size="200"
          :stroke="12"
        >
          <div class="hero">
            <span class="cap">
              <!-- 运行态色点：色相只在点上，文案保持中性；暂停时不呼吸（它不在计数） -->
              <i
                v-if="pomo.running"
                class="cdot"
                :class="pomo.phase === 'break' ? 'rest' : 'live'"
                aria-hidden="true"
              />
              {{ caption }}
            </span>
            <!-- 展示级读数：--fs-display-m + 轻字重（与 CountdownOverlay 的 hero 读数同族）。
                 letter-spacing -1px 是裸值、tokens.css 无对应令牌，保留原样、不自造令牌。 -->
            <b class="readout num">
              <template v-for="(part, i) in clockParts" :key="i">
                <span v-if="i" class="colon">:</span>{{ part }}
              </template>
            </b>
            <!-- 关联待办：触发钮 + AppMenu 绑定式菜单（换掉原生 <select>）；
                 一条待办都没有时不渲染为控件，降为一句引导、不阻塞起跑 -->
            <button
              v-if="todoMenu.length"
              ref="pickBtn"
              type="button"
              class="pick"
              aria-haspopup="menu"
              :aria-expanded="todoMenuOpen"
              :aria-label="`在做哪件：${pickLabel}`"
              @click="todoMenuOpen = true"
              @dblclick.stop
            >
              <span class="pick-t">{{ pickLabel }}</span>
              <ChevronDown :size="12" class="pick-c" />
            </button>
            <span v-else class="pick pick-idle">
              <span class="pick-t">{{ pickLabel }}</span>
            </span>
          </div>
        </RingProgress>
      </div>

      <AppMenu
        v-if="todoMenu.length"
        :open="todoMenuOpen"
        :anchor="pickBtn"
        :actions="todoMenu"
        title="在做哪件"
        @select="onPickTodo"
        @close="todoMenuOpen = false"
      />

      <!-- 休息相位：非屏幕恢复引导（注意力恢复理论），一句短提示、可跳过、不弹窗不强制 -->
      <p v-if="pomo.phase === 'break' && pomo.running && pomo.settings.mode === 'down'" class="tip">
        离开一下屏幕：站起来，看看远处，接杯水。
      </p>
      <!-- 暂停态：最长暂停会到点自动结束本段，得让用户看见这条看门狗在走 -->
      <p v-else-if="pomo.active && !pomo.running && pomo.settings.maxPauseMin > 0" class="tip">
        已暂停 <span class="num">{{ pausedText }}</span> · 累计超过
        <span class="num">{{ pomo.settings.maxPauseMin }}</span> 分钟会自动结束本段
      </p>

      <!-- ═══ 空闲：计划条 + 一键开始 ═══ -->
      <template v-if="!pomo.active">
        <button type="button" class="plan" aria-label="调整专注安排" @click="openPlan">
          <div class="plan-top">
            <span class="plan-now">
              <i
                class="cdot"
                :class="{ live: pomo.settings.mode === 'down' && smart.kind === 'ongoing' }"
                aria-hidden="true"
              />
              <span class="plan-now-t">{{ planHeadline }}</span>
            </span>
            <span class="mode-chip">
              <component
                :is="pomo.settings.mode === 'up' ? Timer : Sparkles"
                :size="11"
                :stroke-width="2.2"
              />
              {{ planModeLabel }}
            </span>
            <span class="plan-edit">调整</span>
          </div>

          <div v-if="pomo.settings.mode === 'down' && idlePlan" class="plan-nums">
            <span>专注 <b class="num">{{ idlePlan.focusMin }}</b></span>
            <span>休息 <b class="num">{{ idlePlan.breakMin }}</b></span>
            <span>共 <b class="num">{{ idlePlan.rounds.length }}</b> 颗</span>
            <span v-if="idlePlan.lastFocusMin">末颗 <b class="num">{{ idlePlan.lastFocusMin }}</b></span>
            <span class="end">预计 <b class="num">{{ planEndLabel }}</b> 结束</span>
          </div>
          <div v-else-if="pomo.settings.mode === 'up'" class="plan-nums">
            <span>每满 <b class="num">{{ pomo.settings.focusMin }}</b> 分钟记一颗</span>
            <span class="end">不限时 · 由你结束</span>
          </div>
          <div v-else class="plan-nums">
            <span>先选一个更晚的结束时间，或切到正计时</span>
            <span class="end">至少 10 分钟</span>
          </div>

          <template v-if="pomo.settings.mode === 'down' && idlePlan">
            <div class="plan-bar" aria-hidden="true">
              <template v-for="(r, i) in idlePlan.rounds" :key="i">
                <i class="pf" :style="{ flex: r.focusMin }" />
                <i
                  v-if="r.breakAfterMin"
                  class="pb"
                  :class="{ long: r.longBreak }"
                  :style="{ flex: r.breakAfterMin }"
                />
              </template>
            </div>
            <div class="plan-axis">
              <span>现在 {{ minToHHmm(nowMinOfDay) }}</span>
              <span v-if="idlePlan.deadlineMs">
                {{ smart.kind === 'gap' ? `${hm(idlePlan.deadlineMs)} 收手` : `待办结束 ${hm(idlePlan.deadlineMs)}` }}
              </span>
              <span v-else>{{ planEndLabel }} 结束</span>
            </div>
          </template>
        </button>

        <button type="button" class="cta" @click="onStart">
          {{ pomo.settings.mode === 'up' || idlePlan ? '开始专注' : '调整安排' }}
        </button>
      </template>

      <!-- ═══ 进行中：预计结束 + 控制簇 + 下一段 ═══ -->
      <template v-else>
        <div v-if="pomo.estimatedEndAt" class="run-est">
          <Timer :size="13" :stroke-width="2.2" />
          预计 <b class="num">{{ hm(pomo.estimatedEndAt.getTime()) }}</b> 结束
          <span v-if="planRemainMin != null">· 还剩 {{ formatRemain(planRemainMin) }}</span>
        </div>

        <div class="acts">
          <button
            type="button"
            class="ibtn"
            :disabled="!canRewind"
            aria-label="回到本番茄钟初"
            @click="pomo.rewindPhase()"
          >
            <RotateCcw :size="20" />
          </button>
          <button
            type="button"
            class="ibtn main"
            :aria-label="pomo.running ? '暂停' : '继续'"
            @click="toggleRun"
          >
            <Pause v-if="pomo.running" :size="24" />
            <Play v-else :size="24" style="margin-left: 3px" />
          </button>
          <button type="button" class="ibtn" aria-label="提前结束本阶段" @click="onEndPhase">
            <RotateCw :size="20" />
          </button>
          <button type="button" class="ibtn danger" aria-label="放弃本轮" @click="giveUpOpen = true">
            <X :size="20" />
          </button>
        </div>

        <div v-if="pomo.nextPhaseLabel" class="next-line">
          <span>下一个：{{ pomo.nextPhaseLabel }}</span>
          <span v-if="pomo.plan">
            专注 {{ pomo.plan.focusMin }} · 休息 {{ pomo.plan.breakMin }} · 共
            {{ pomo.planRounds }} 颗<template v-if="pomo.plan.lastFocusMin"> · 末颗 {{ pomo.plan.lastFocusMin }}</template>
          </span>
        </div>
      </template>

      <!-- 今日番茄：左侧一排番茄图形（超出上限折成 +N），右侧是完整计数。
           番茄是内联 SVG（currentColor）而不是 emoji —— emoji 在不同平台是另一套字形，
           会脱离卡片的字重与配色。 -->
      <div class="tomatos">
        <div class="row between trow">
          <span class="figs" aria-hidden="true">
            <svg v-for="i in figCount" :key="i" class="tfig" viewBox="0 0 24 24">
              <path
                d="M12 21c-4.3 0-7.6-2.8-7.6-6.6C4.4 10.4 7.7 8 12 8s7.6 2.4 7.6 6.4C19.6 18.2 16.3 21 12 21Z"
                fill="currentColor"
              />
              <path
                d="M12 8.4V5.2M12 7.6 9.3 6M12 7.6 14.7 6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            <span v-if="figMore > 0" class="more num">+{{ figMore }}</span>
          </span>
          <span class="tcount">× <b class="num">{{ pomo.todayCompletedCount }}</b> 颗</span>
        </div>
        <!-- 轮次圆点（唯一真源是 store 的 roundDots）：长休周期的进度不能只藏在抽屉里 -->
        <p class="roundhint">
          <span class="dots" aria-hidden="true">
            <span v-for="(on, i) in pomo.roundDots" :key="i" class="rdot" :class="{ on }" />
          </span>
          <span>本轮进度</span>
          <InfoHint title="轮次圆点">
            <p>每 {{ pomo.settings.roundsBeforeLongBreak }} 次专注后进入一次长休息。</p>
            <p>圆点记录本轮进度：点亮的是本轮已完成的次数，点满即进入长休息，之后重新开始点亮。</p>
            <p>轮数可以在设置里调整。</p>
          </InfoHint>
        </p>
      </div>

      <!-- 卡底：有记录时诚实分账（完整段 / 中断段），空白时给一句中性引导 -->
      <template v-if="hasToday">
        <div class="stat">
          <p v-if="pomo.todayCompletedCount > 0" class="stat-main">
            <span>完整 <span class="num">{{ pomo.todayCompletedCount }}</span> 段 ·</span>
            <b class="num hero">{{ doneMin }}</b>
            <span>分钟</span>
          </p>
          <p v-if="pomo.todayInterruptedCount > 0" class="stat-sub">
            另有 <span class="num">{{ pomo.todayInterruptedCount }}</span> 段中途停下，共
            <span class="num">{{ interruptedMin }}</span> 分钟
          </p>
        </div>
      </template>
      <EmptyState
        v-else
        :icon="Timer"
        title="今天还没有专注记录"
        hint="开始一段，第一段就会记在这里。"
      />
    </div>

    <!-- 提前结束（专注相位）：记录进入休息 / 放弃不留记录，文案即代价 -->
    <ActionSheet
      :open="endOpen"
      :title="endTitle"
      :actions="endActions"
      @select="onEndPick"
      @close="endOpen = false"
    />

    <!-- 放弃本轮 / 跳过休息：与「提前结束」分开的破坏性入口，必须二次确认 -->
    <ActionSheet
      :open="giveUpOpen"
      :title="giveUpTitle"
      :actions="giveUpActions"
      @select="onGiveUpPick"
      @close="giveUpOpen = false"
    />

    <FocusPlanSheet
      :open="planOpen"
      :initial-mode="pomo.settings.mode === 'up' ? 'up' : 'smart'"
      @close="planOpen = false"
      @settings="openSettings"
    />
    <FocusTimePicker :open="settingsOpen" @close="settingsOpen = false" />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.head-right {
  display: inline-flex;
  align-items: center;
  /* 标题行右端的模式开关与帮助入口：无边界控件 6（4·8 表里的一格） */
  gap: var(--sp-6);
}

.mode-switch {
  display: inline-flex;
  flex: none;
}

/* 两段各 3 个汉字：定宽 126px 放得下，且不跟标题抢横向空间（标题是这一行的主体） */
.mode-switch :deep(.seg) {
  width: 126px;
}

/* 进行中锁死方向：断掉分段控件的鼠标路径（键盘路径由脚本守卫兜住）。
   用整体降透明度而不是逐段禁用 —— 这里禁用的是「这个开关整件事」，不是某一个选项。 */
.mode-switch.locked {
  pointer-events: none;
  opacity: var(--disabled-opacity);
}

.body {
  /* 计时环 / 主操作簇 / 设置摘要 / 番茄计数四块：块间 16（有明显边界的区块） */
  gap: var(--gap-lg);
  margin-top: var(--gap-md);
}

/* 双击目标层：手势面必须自己吃掉双击的文本选择，否则连点两下会选中读数、冒出一条蓝底 */
.ring-wrap {
  user-select: none;
  -webkit-user-select: none;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 状态行 / 读数 / 关联待办：卡内主次文本上下 2 */
  gap: var(--gap-text);
  padding: 0 var(--pad-inline);
}

/* 说明行 + 左侧状态色点：必读信息，从三级灰提到 --text-2 */
.cap {
  display: inline-flex;
  align-items: center;
  /* 状态色点与说明文字：图标与文字 6 */
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.cdot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--text-3);
}

.cdot.live {
  background: var(--mod-focus-tone);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.cdot.rest {
  background: var(--cat-general);
}



/* 读数：展示级字号 + 轻字重。数字全部中性（--text-1），色相只落在冒号上 */
.readout {
  display: inline-flex;
  align-items: baseline;
  font-size: var(--fs-display-m);
  font-weight: var(--fw-light);
  letter-spacing: -1px;
  /* 展示级行高走令牌（--lh-display 1.16）；原先裸 1.05 会把读数行压得比环心排版更紧 */
  line-height: var(--lh-display);
  color: var(--text-1);
}

/* 只有冒号带色相：分隔符着色让读数有落点，又不会把数值染成彩色（数值要能扫读） */
.colon {
  /* 分隔符两侧各 2：够把两段数字分开，又不至于让读数散成三段 */
  padding: 0 var(--gap-text);
  color: var(--mod-focus-tone);
}

/* 环内关联待办：做成一颗矮胶囊 —— 环心横向只有 176px 可用，撑满会把读数挤变形 */
.pick {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  max-width: 150px;
  margin-top: var(--gap-text);
  /* 环内矮胶囊：纵向 4、左右 10（环心横向只有 176px，不能按 12 撑） */
  padding: var(--gap-tight) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  text-align: left;
}

/* 矮胶囊的视觉高度保持 ~26，命中区补到 44：环心只有这一颗可点控件，
   拇指点「在做哪件」不该点空 */
.pick:not(.pick-idle)::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: calc(100% + var(--gap-sm));
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
}

/* 按压态：环内没有 hover 可用，按下时整颗胶囊沉一档表面色 */
.pick:not(.pick-idle):active {
  background: var(--surface-3);
}

/* 无待办时的静态引导：不再是控件，不做按压/悬停，只降一档色 */
.pick-idle {
  color: var(--text-3);
  cursor: default;
}

.pick-t {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pick-c {
  flex: none;
  color: var(--text-3);
}

.tip {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-align: center;
  text-wrap: balance;
}

/* ---------- 计划条（空闲态） ---------- */
.plan {
  width: 100%;
  padding: var(--sp-12);
  border: 0;
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
  color: var(--text-1);
  font-family: inherit;
  text-align: left;
}

.plan:active { background: var(--surface-2); }

.plan-top {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  min-width: 0;
}

.plan-now {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  min-width: 0;
  flex: 1;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.plan-now-t {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  padding: 2px 7px 2px 5px;
  border-radius: var(--radius-full);
  background: var(--mod-focus-soft);
  color: var(--mod-focus-strong);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
}

.plan-edit {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.plan-nums {
  display: flex;
  align-items: baseline;
  gap: var(--sp-10);
  margin-top: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.plan-nums .num {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.plan-nums .end { margin-left: auto; color: var(--text-2); }
.plan-nums .end .num { color: var(--mod-focus-strong); }

.plan-bar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 6px;
  margin-top: var(--sp-8);
}

.plan-bar .pf {
  display: block;
  border-radius: 3px;
  background: var(--mod-focus-tone);
}

.plan-bar .pb {
  display: block;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
}

.plan-bar .pb.long { background: color-mix(in srgb, var(--text-1) 14%, transparent); }

.plan-axis {
  display: flex;
  justify-content: space-between;
  margin-top: var(--sp-4);
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* ---------- 进行中：预计结束 / 下一段 ---------- */
.run-est {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.run-est svg { color: var(--text-3); }
.run-est b { font-size: var(--fs-footnote); font-weight: var(--fw-bold); color: var(--text-1); }
.run-est span { color: var(--text-3); }

.next-line {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--sp-10);
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-align: center;
}

.next-line span + span { color: var(--text-3); }

/* 空闲态主操作：满宽胶囊。实底主色档（--accent + --on-accent）是项目里主操作的统一写法，
   也是唯一能同时保证白字对比度的实底档。 */
.cta {
  width: 100%;
  height: 52px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  letter-spacing: 0.2px;
  box-shadow: var(--shadow-float);
}

/* 进行中控制簇：一条圆角药丸托着四颗圆钮。
   中间那颗是暂停/继续（最常按、也最该是第一眼看到的），用实底反色 + 更大直径拉出主次。 */
.acts {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 四颗圆钮之间 12：它们之间有空隙而不是分隔线，得比 8 大一档才不粘连 */
  gap: var(--gap-md);
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.ibtn {
  position: relative;
  width: 44px;
  height: 44px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--text-2);
}

.ibtn.main {
  width: 56px;
  height: 56px;
  background: var(--text-1);
  color: var(--bg);
  box-shadow: var(--shadow-float);
}

.ibtn.danger {
  color: var(--danger);
}

/* 看得到却点不动最糟：本相位没有投入时「回到本番茄钟初」是空操作，直接禁用 */
.ibtn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

.tomatos {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  width: 100%;
}

.figs {
  display: inline-flex;
  align-items: center;
  /* 番茄图形挨着排：同一行最小呼吸 4 */
  gap: var(--gap-tight);
  min-width: 0;
}

/* 番茄图形：实底走专注域色相（--mod-focus-tone），与环、冒号同源 */
.tfig {
  width: 20px;
  height: 20px;
  flex: none;
  color: var(--mod-focus-tone);
}

.more {
  /* 图形组与「+N」之间 4 */
  margin-left: var(--gap-tight);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.tcount {
  flex: none;
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.tcount b {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.roundhint {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.dots {
  display: inline-flex;
  align-items: center;
  /* 轮次圆点之间 4：7px 的点用 4 才不会连成一串 */
  gap: var(--gap-tight);
}

/* 圆点。未点亮态用 --surface-3 —— 它直接坐在白卡面（--surface）上，
   只有 0.5px 描边、不填一档灰度的话，未点亮的圆点在浅色主题下基本看不见。 */
.rdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--surface-3);
  border: 0.5px solid var(--line-strong);
}

/* 点亮色随专注 accent（--mod-focus-tone），与环、状态点同源 */
.rdot.on {
  background: var(--mod-focus-tone);
  border-color: transparent;
}

/* 桌面（有悬停）：让「能不能点」有反馈 */
@media (hover: hover) {
  .ibtn:not(.main):not(:disabled):hover {
    background: var(--surface-3);
  }

  .ibtn.main:hover {
    opacity: 0.9;
  }

  .cta:hover {
    opacity: 0.92;
  }

  .pick:not(.pick-idle):hover {
    color: var(--text-1);
  }
}

.stat {
  display: flex;
  flex-direction: column;
  /* 主行与副行：主次文本上下 2 */
  gap: var(--gap-text);
  width: 100%;
  text-align: center;
}

.stat-main {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--gap-tight);
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 卡底唯一主数值：完整段分钟数提到主档（数值走中性 --text-1，不带色相） */
.stat-main .hero {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.stat-sub {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-wrap: balance;
}

/* 减弱动效：保留状态色点，去掉呼吸动画与按钮过渡 */
@media (prefers-reduced-motion: reduce) {
  .cdot.live {
    animation: none;
  }

  .cta,
  .ibtn {
    transition: none;
  }
}
</style>
