<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { emit as emitToMain, listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

import GlassFilter from '@/components/common/GlassFilter.vue'
import FloatTitleBar from '@/components/float/FloatTitleBar.vue'
import FocusFloatBlob from '@/components/float/FocusFloatBlob.vue'
import FocusFloatCard from '@/components/float/FocusFloatCard.vue'
import WorkoutFloatBlob from '@/components/float/WorkoutFloatBlob.vue'
import WorkoutFloatContent from '@/components/float/WorkoutFloatContent.vue'
import { useFloatDock } from '@/composables/useFloatDock'
import { useLiquidGlass } from '@/composables/useLiquidGlass'
import { floatService } from '@/services/floatService'
import { isTauri } from '@/services/transport'
import { liquidGlass, perfMode, type PerfMode } from '@/system/perf'
import { motionLevel, type MotionLevel } from '@/system/motion'
import { isTauriDesktopWindow } from '@/system/windowChrome'
import { fmtClockSec } from '@/utils/clock'
import type {
  GlobalFloatAction,
  GlobalFloatForm,
  GlobalFloatKind,
  GlobalFloatSnapshot,
  GlobalFloatStatePayload,
  GlobalFloatTone,
  GlobalFloatWindowShape,
} from '@/types'

/**
 * 全局浮窗的应用根（独立 vite 入口 float.html，**不含 Pinia / router / App.vue**）。
 *
 * 它只做四件事：
 *  · 收载荷：启动先 `global_float_latest` 拿首帧（主窗口推送可能早于本页载入），
 *    之后听 `rein://float/state`；每次载荷里带形态与画质/动效档，首帧就按主窗口同档渲染。
 *  · 本地走秒：专注的 clock 是「基准读数 + 该读数对应的本地时刻」，本页自己按系统时钟
 *    算 mm:ss（应用失焦后主窗口的推送不保证准时；断流时最多停在最后一秒，不会显示错值）。
 *    训练课的 clock 恒为 null（统计行里已含读数，主窗口每秒推一次心跳）。
 *  · 渲染：外壳用与程序内浮条同一套 .glass-surface + useLiquidGlass；条 / 方块内容与
 *    程序内**是同一批组件**（components/float/*），所以状态点、文案、按钮顺序不会漂。
 *  · 发动作：所有按钮都只把 GlobalFloatAction 发回 `rein://float/action`，真正的状态机
 *    在主窗口的 globalFloat（浮窗不持有任何会话状态，也就不存在两个真源）。
 *  · 拖拽停靠：useFloatDock 持有**窗口位置** —— 与程序内浮条同款手势（整壳拖、轻弹
 *    左右泊车 / 上下停靠、弹簧落位、橡皮筋边界）。形态切换先直接调 set_form 改尺寸
 *    （跟手），再发 form 动作给主窗口落偏好；confirm 长高完全在本地锚定。
 *
 * 窗口形状尺寸（bar 430×92 / blob 64×64 / confirm 430×172）由 Rust 改，位置由本页持有。
 * confirm 只为结束确认临时长高，不进持久化偏好。
 *
 * 浏览器直接打开 float.html（没有 Tauri）时：不启动事件通道、不发动作，渲染「等待会话」
 * 空态 —— 这一页是独立入口，任何未捕获异常都会在桌面端表现为一个空白浮窗。
 */
const { glassFilterId, glassStyle } = useLiquidGlass()

/** 载荷里的快照（主窗口是唯一真源；本页只在 clock 上做本地走秒） */
const snapshot = ref<GlobalFloatSnapshot | null>(null)
/** 持久形态（用户偏好）：payload.form 永远是 bar / blob */
const form = ref<GlobalFloatForm>('bar')
/** 结束确认（本地临时状态）：不改 payload.form，只把窗口临时长高 */
const confirmOpen = ref(false)
/** 本地时钟（每 500ms 取一次 Date.now()；只在 clock 需要走秒时使用） */
const nowMs = ref(Date.now())

/* ---------- 派生 ---------- */

/** 持久形态 → 窗口形状：专注用 360×450 卡面，训练仍是 430×92 条 */
function effectiveShape(next: GlobalFloatForm, snap = displaySnapshot.value): GlobalFloatWindowShape {
  if (next === 'blob') return 'blob'
  return snap?.kind === 'focus' ? 'card' : 'bar'
}

/** 窗口此刻的形状：确认态压过持久形态（confirm 不进偏好） */
const shape = computed<GlobalFloatWindowShape>(() => {
  if (confirmOpen.value) return 'confirm'
  return effectiveShape(form.value)
})
const shapeClass = computed(() => `is-${shape.value}`)

/** 本地走秒后的读数（秒）；静止 / 训练课为 null（不做覆盖） */
const liveSec = computed<number | null>(() => {
  const s = snapshot.value
  const clock = s?.clock
  if (!s || !clock || clock.atEpochMs == null) return null
  // 用整秒取整再算：与主窗口的 Math.round 口径一致，两侧同一秒显示同一个数
  const elapsed = Math.max(0, Math.round((nowMs.value - clock.atEpochMs) / 1000))
  const sec = clock.direction === 'down' ? clock.baseSec - elapsed : clock.baseSec + elapsed
  return Math.max(0, sec)
})

/** 实际渲染的快照：专注在走秒时用本地读数覆盖 stat；其余情况原样透传（引用不变） */
const displaySnapshot = computed<GlobalFloatSnapshot | null>(() => {
  const s = snapshot.value
  if (!s || liveSec.value == null) return s
  return { ...s, stat: fmtClockSec(liveSec.value) }
})

/** 按种类拆成两个非空引用：模板里 v-if 窄化后用，免去逐字段判空 */
const focusSnapshot = computed<GlobalFloatSnapshot | null>(() =>
  displaySnapshot.value?.kind === 'focus' ? displaySnapshot.value : null,
)
const workoutSnapshot = computed<GlobalFloatSnapshot | null>(() =>
  displaySnapshot.value?.kind === 'workout' ? displaySnapshot.value : null,
)

/** 标题栏左边的会话名（浮窗是系统级壳层，叫「专注 / 训练」比重复整句文案更清楚） */
const titleLabel = computed(() => {
  const s = displaySnapshot.value
  if (!s) return '等待会话'
  return s.kind === 'focus' ? '专注' : '训练'
})
const titleKind = computed<GlobalFloatKind | undefined>(() => displaySnapshot.value?.kind)
const titleTone = computed<GlobalFloatTone | undefined>(() => displaySnapshot.value?.tone)

/** 确认态内容（标题 + 动作）：与程序内 ActionSheet 同一份 end.sheet */
const confirmData = computed(() =>
  shape.value === 'confirm' ? (displaySnapshot.value?.end?.sheet ?? null) : null,
)

/** 空态说明：浏览器预览要如实说明「这里不是系统浮窗」 */
const emptyHint = isTauri
  ? '专注或训练进行中时，这里会显示控制条'
  : '浏览器预览：系统浮窗只在桌面 / Android 应用里出现'

/* ---------- 拖拽停靠（窗口位置的唯一持有者） ---------- */

/** 本地发起的形态切换正在等主窗口回声：期间不被旧 payload 的 form 回滚（见 applyPayload） */
let formEchoPending = false
let formEchoAt = 0

const cardMode = computed(() => effectiveShape(form.value) === 'card')

const {
  pressing,
  dragging,
  onPointerDown,
  parkToSide,
  expandToBar,
  redock,
  closeConfirm,
} = useFloatDock({
  form,
  card: cardMode,
  active: computed(() => isTauriDesktopWindow && displaySnapshot.value != null && !confirmOpen.value),
  changeForm: async (next) => {
    formEchoPending = true
    formEchoAt = Date.now()
    // 先改尺寸再渲染新形态：避免 blob 内容先在 430 宽的窗里拉成一帧
    try {
      await floatService.setForm(effectiveShape(next))
    } catch {
      /* 改尺寸失败不影响内容：下一次主窗口归一形状会再改一次 */
    }
    form.value = next
    if (next === 'blob') confirmOpen.value = false
    sendAction({ action: 'form', form: next })
  },
})

/* ---------- 载荷与首帧 ---------- */

const PERF_VALUES = ['low', 'high', 'ultra', 'extreme'] as const
const MOTION_VALUES = ['off', 'default', 'rich'] as const

function isPerfMode(value: unknown): value is PerfMode {
  return typeof value === 'string' && (PERF_VALUES as readonly string[]).includes(value)
}

function isMotionLevel(value: unknown): value is MotionLevel {
  return typeof value === 'string' && (MOTION_VALUES as readonly string[]).includes(value)
}

/** 载荷里的画质 / 动效档：与主窗口同源（localStorage 是同源的，但主窗口可能刚切过档，
 *  以载荷为准校正一次，避免首帧按旧档渲染）。data-perf / data-motion 同步先写，
 *  下一拍模块里的 watcher 会写同一个值。 */
function applyTiers(perf: unknown, motion: unknown): void {
  if (isPerfMode(perf)) {
    perfMode.value = perf
    document.documentElement.dataset.perf = perf
  }
  if (isMotionLevel(motion)) {
    motionLevel.value = motion
    document.documentElement.dataset.motion = motion
  }
}

function isSnapshot(value: unknown): value is GlobalFloatSnapshot {
  if (value === null || typeof value !== 'object') return false
  const s = value as Partial<GlobalFloatSnapshot>
  const toneOk = s.tone === 'work' || s.tone === 'break' || s.tone === 'paused' || s.tone === 'done'
  return (s.kind === 'focus' || s.kind === 'workout') && typeof s.title === 'string' && typeof s.stat === 'string' && toneOk
}

/**
 * 应用一份载荷（启动首帧与事件共用）。
 * 空串 = 主窗口还没推过任何快照（latest 的约定），保持空态等事件。
 * 解析失败 / 形状不对一律忽略：浮窗宁可停在上一帧，也不能因为一条坏载荷白屏。
 */
function applyPayload(raw: unknown): void {
  if (raw === null || raw === undefined) return
  if (typeof raw === 'string' && raw.length === 0) return
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
  }
  if (data === null || typeof data !== 'object') return
  const payload = data as Partial<GlobalFloatStatePayload>
  if (!isSnapshot(payload.snapshot)) return
  snapshot.value = payload.snapshot
  const incoming: GlobalFloatForm = payload.form === 'blob' ? 'blob' : 'bar'
  if (formEchoPending) {
    // 本地刚切过形态：主窗口回声到达前忽略旧 form（心跳可能抢在动作处理前推一帧旧值）；
    // 3s 还没等到回声（主窗口已关等）就放弃保护，照常接受载荷
    if (incoming === form.value || Date.now() - formEchoAt > 3000) {
      formEchoPending = false
      form.value = incoming
    }
  } else {
    form.value = incoming
  }
  applyTiers(payload.perf, payload.motion)
  nowMs.value = Date.now()
  if (form.value === 'blob' && confirmOpen.value) cancelEnd()
  // 结束确认期间会话进入结束（end 消失）：确认已无意义，收回并让窗口恢复 bar 高度
  if (confirmOpen.value && !payload.snapshot.end) cancelEnd()
}

/* ---------- 动作：全部经事件回灌主窗口 ---------- */

function sendAction(action: GlobalFloatAction): void {
  if (!isTauri) return
  void emitToMain('rein://float/action', action).catch(() => {
    /* 主窗口没在听（刚启动 / 已关闭）：窗口状态不变，下一次载荷会把它纠正 */
  })
}

function onPrimary(): void {
  const primary = displaySnapshot.value?.primary
  if (!primary) return
  sendAction({ action: primary.id })
}

/** 训练条的第二颗按钮：跳过动作 / 总结态去保存（专注浮窗没有次级动作） */
function onSecondary(): void {
  const secondary = displaySnapshot.value?.secondary
  if (!secondary) return
  sendAction({ action: secondary.id === 'skip' ? 'skip' : 'open' })
}

function cancelEnd(): void {
  if (!confirmOpen.value) return
  confirmOpen.value = false
  void closeConfirm()
}

/** 确认某个结束选项：先发会话动作，再收回确认高度（位置还原由 useFloatDock 落实） */
function pickEnd(option: string): void {
  confirmOpen.value = false
  sendAction({ action: 'end', option })
  void closeConfirm()
}

function onOpen(): void {
  sendAction({ action: 'open' })
}

function onImmerse(): void {
  sendAction({ action: 'immerse' })
}

/** 专注卡面的「跳到休息 / 跳过休息」：走 store 的 endPhase 分流 */
function onSkipPhase(): void {
  sendAction({ action: 'skip-phase' })
}

/** 专注卡面内的结束确认：选项 id 来自 snapshot.end.sheet */
function onEndOption(option: string): void {
  sendAction({ action: 'end', option })
}

function closeWindow(): void {
  // 窗口马上要被主窗口收走：本地先退出确认态，避免下次显示时还挂着一行「确认」
  if (confirmOpen.value) {
    confirmOpen.value = false
    void closeConfirm()
  }
  sendAction({ action: 'close' })
}

/** 确认态点空白处 / 按 Esc = 取消（与 ActionSheet 的遮罩点击同义） */
function onBackdrop(): void {
  cancelEnd()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') cancelEnd()
}

/**
 * 浮窗失焦 / 被隐藏时收回结束确认。
 *
 * 关键在「也要还原窗口高度与位置」：确认态把窗口临时长高了，如果只把本地状态改回 bar，
 * 下次显示时窗口仍是 172 高、而内容只有一条浮条，底部会空出一大块。closeConfirm 会把
 * 尺寸归一回 92 并还原确认前的位置（即使此刻窗口是隐藏的，下次 show 前也会再归一一次）。
 */
function onWindowBlur(): void {
  cancelEnd()
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') cancelEnd()
  else void redock() // 重新显示：按持久化槽位落位（hide/show 不丢位，换屏后重算）
}

/* ---------- 生命周期 ---------- */

let unlisten: UnlistenFn | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null

async function bootstrap(): Promise<void> {
  // 首帧：主窗口可能在本页载入前就推过（latest 是它的缓存）；空串 = 等事件
  try {
    applyPayload(await invoke<string>('global_float_latest'))
  } catch {
    /* 命令不可用（旧版本 / 非浮窗窗口）：保持空态 */
  }
  try {
    unlisten = await listen<string>('rein://float/state', (event) => applyPayload(event.payload))
  } catch {
    /* 事件通道不可用：空态已能自证，不抛未捕获异常 */
  }
  // 首帧形态已知后按持久化槽位落位（Rust 建窗只给默认槽，这里纠正到用户停的位置）
  await redock()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)
  // 只在本页真的持有会走动的读秒时才需要本地时钟；订阅一个 500ms 心跳足够，
  // 读数本身按 Date.now() 计算，不累加，所以定时器抖动不会让读数漂
  tickTimer = setInterval(() => {
    if (snapshot.value?.clock?.atEpochMs != null) nowMs.value = Date.now()
  }, 500)
  if (isTauri) void bootstrap()
})

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  unlisten?.()
  unlisten = null
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div
    class="float-app"
    :class="[shapeClass, { 'is-preview': !isTauri }]"
    @click.self="onBackdrop"
  >
    <!-- 空态：浏览器预览 / 尚未收到任何载荷。用同一条玻璃壳，避免出现"白屏" -->
    <section
      v-if="!displaySnapshot"
      class="float-shell glass-surface is-empty"
      :style="glassStyle"
    >
      <GlassFilter
        :id="glassFilterId"
        :enabled="liquidGlass"
      />
      <FloatTitleBar
        title="Rein 浮窗"
        :show-actions="false"
        :native-drag="false"
      />
      <div class="float-empty">
        <p class="fe-title">等待会话</p>
        <p class="fe-hint">{{ emptyHint }}</p>
      </div>
    </section>

    <!-- 泊车形态：64×64 玻璃方块（轻点展开回条，整块可拖；手势与条同源，见 useFloatDock） -->
    <div
      v-else-if="shape === 'blob'"
      class="float-blob glass-surface"
      :class="{ pressing, dragging }"
      :style="glassStyle"
      role="button"
      tabindex="0"
      aria-label="展开浮条"
      @pointerdown="onPointerDown"
      @click="expandToBar"
      @keydown.enter="expandToBar"
      @keydown.space.prevent="expandToBar"
    >
      <GlassFilter
        :id="glassFilterId"
        :enabled="liquidGlass"
      />
      <FocusFloatBlob
        v-if="focusSnapshot"
        :snapshot="focusSnapshot"
      />
      <WorkoutFloatBlob
        v-else-if="workoutSnapshot"
        :snapshot="workoutSnapshot"
      />
    </div>

    <!-- 专注卡面：360×450。头部 / 刻度环 / 读数 / 菜单 / 结束确认都在卡内，
         窗口尺寸由 Rust 的 card 形状给；这里只提供玻璃壳与整壳拖拽。 -->
    <section
      v-else-if="shape === 'card' && focusSnapshot"
      class="float-shell glass-surface is-card"
      :class="{ pressing, dragging }"
      :style="glassStyle"
      @pointerdown="onPointerDown"
    >
      <GlassFilter
        :id="glassFilterId"
        :enabled="liquidGlass"
      />
      <FocusFloatCard
        :snapshot="focusSnapshot"
        :live-sec="liveSec"
        @primary="onPrimary"
        @park="parkToSide"
        @close="closeWindow"
        @immerse="onImmerse"
        @skip-phase="onSkipPhase"
        @end="onEndOption"
      />
    </section>

    <!-- 条 / 确认形态：同一块玻璃壳 + 常驻紧凑标题栏。
         整壳自定义拖拽（useFloatDock）：不挂原生 drag region —— 它会吞掉指针事件，
         轻弹测速与按钮点击就都没了。确认态 active=false，手势自动让位。 -->
    <section
      v-else
      class="float-shell glass-surface"
      :class="{ pressing, dragging }"
      :style="glassStyle"
      @pointerdown="onPointerDown"
    >
      <GlassFilter
        :id="glassFilterId"
        :enabled="liquidGlass"
      />
      <FloatTitleBar
        :title="titleLabel"
        :kind="titleKind"
        :tone="titleTone"
        :native-drag="false"
        @park="parkToSide"
        @close="closeWindow"
      />

      <div
        v-if="shape === 'bar'"
        class="float-stage"
      >
        <div class="float-row">
          <WorkoutFloatContent
            v-if="workoutSnapshot"
            :snapshot="workoutSnapshot"
            @primary="onPrimary"
            @secondary="onSecondary"
            @open="onOpen"
            @immerse="onImmerse"
          />
        </div>
      </div>

      <!-- 内联结束确认：窗口临时长高（430×172）后，上半整段标题、下半一行等宽按钮。
           Rust 长高失败时本块按 flex-end 布局：标题被裁，按钮仍完整可点。 -->
      <div
        v-else
        class="float-confirm"
      >
        <p
          v-if="confirmData"
          class="c-title"
        >
          {{ confirmData.title }}
        </p>
        <div
          v-if="confirmData"
          class="c-acts"
        >
          <button
            type="button"
            class="cbtn cancel"
            @click="cancelEnd"
          >
            取消
          </button>
          <button
            v-for="a in confirmData.actions"
            :key="a.id"
            type="button"
            class="cbtn"
            :class="{ danger: a.danger }"
            @click="pickEnd(a.id)"
          >
            {{ a.label }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
