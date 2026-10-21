<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { emit as emitToMain, listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

import GlassFilter from '@/components/common/GlassFilter.vue'
import FloatTitleBar from '@/components/float/FloatTitleBar.vue'
import FocusFloatBlob from '@/components/float/FocusFloatBlob.vue'
import FocusFloatContent from '@/components/float/FocusFloatContent.vue'
import WorkoutFloatBlob from '@/components/float/WorkoutFloatBlob.vue'
import WorkoutFloatContent from '@/components/float/WorkoutFloatContent.vue'
import { useLiquidGlass } from '@/composables/useLiquidGlass'
import { isTauri } from '@/services/transport'
import { liquidGlass, perfMode, type PerfMode } from '@/system/perf'
import { motionLevel, type MotionLevel } from '@/system/motion'
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
 *    在主窗口的 globalFloat（浮窗不持有任何状态，也就不存在两个真源）。
 *
 * 窗口形态（bar 430×92 / blob 64×64 / confirm 430×172）由 Rust 改，本页只发
 * `{ action: 'form', form }`。confirm 只为结束确认临时长高，不进持久化偏好。
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

/** 窗口此刻的形状：确认态压过持久形态（confirm 不进偏好） */
const shape = computed<GlobalFloatWindowShape>(() => (confirmOpen.value ? 'confirm' : form.value))
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
  form.value = payload.form === 'blob' ? 'blob' : 'bar'
  applyTiers(payload.perf, payload.motion)
  nowMs.value = Date.now()
  if (form.value === 'blob') confirmOpen.value = false
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

/** 结束按钮：进入内联确认，并请主窗口把窗口临时长高（放得下完整标题与两条动作文案） */
function startEnd(): void {
  if (!displaySnapshot.value?.end) return
  confirmOpen.value = true
  sendAction({ action: 'form', form: 'confirm' })
}

function cancelEnd(): void {
  if (!confirmOpen.value) return
  confirmOpen.value = false
  sendAction({ action: 'form', form: 'bar' })
}

/** 确认某个结束选项：先发会话动作，再请窗口回到 bar 高度（顺序与主窗口的预期一致） */
function pickEnd(option: string): void {
  confirmOpen.value = false
  sendAction({ action: 'end', option })
  sendAction({ action: 'form', form: 'bar' })
}

function onOpen(): void {
  sendAction({ action: 'open' })
}

function onImmerse(): void {
  sendAction({ action: 'immerse' })
}

function park(): void {
  sendAction({ action: 'form', form: 'blob' })
}

function expandFromBlob(): void {
  sendAction({ action: 'form', form: 'bar' })
}

function closeWindow(): void {
  // 窗口马上要被主窗口收走：本地先退出确认态，避免下次显示时还挂着一行「确认」
  confirmOpen.value = false
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
 * 关键在「也要发 form bar」：确认态把窗口临时长高了，如果只把本地状态改回 bar，
 * 下次显示时窗口仍是 172 高、而内容只有一条浮条，底部会空出一大块。主窗口收到
 * form bar 会把窗口归一回 92 高（即使此刻窗口是隐藏的，下次 show 前也会再归一一次）。
 */
function onWindowBlur(): void {
  cancelEnd()
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') cancelEnd()
}

/* ---------- blob 拖动 + 轻点展开 ----------
 * blob 整块既是「拖窗口」又是「轻点展开」，不能直接用 data-tauri-drag-region：
 * 原生 drag region 在 mousedown 时就把点击让给系统移动循环，点击事件不再回到 webview，
 * 于是「轻点展开」永远收不到。这里自己判位移：超过 4px 才调 startDragging（原生接管移动），
 * 没超过就是一次轻点。
 */
let dragOrigin: { x: number; y: number } | null = null
let blobDragging = false

function onBlobPointerDown(e: PointerEvent): void {
  if (!isTauri || e.button !== 0) return
  dragOrigin = { x: e.clientX, y: e.clientY }
  blobDragging = false
  window.addEventListener('pointermove', onBlobPointerMove)
  window.addEventListener('pointerup', onBlobPointerUp, { once: true })
  window.addEventListener('pointercancel', onBlobPointerUp, { once: true })
}

function onBlobPointerMove(e: PointerEvent): void {
  if (!dragOrigin || blobDragging) return
  if (Math.hypot(e.clientX - dragOrigin.x, e.clientY - dragOrigin.y) < 4) return
  blobDragging = true
  void startWindowDrag()
}

async function startWindowDrag(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().startDragging()
  } catch {
    /* 拖不动（权限缺失 / 非桌面）就留在原地：内容仍然可点 */
  }
  // 原生移动循环会吞掉 pointerup：主动收掉监听，别留下悬空的全局 handler
  cleanupBlobDrag()
}

function onBlobPointerUp(): void {
  const wasDragging = blobDragging
  cleanupBlobDrag()
  if (!wasDragging) expandFromBlob()
}

function cleanupBlobDrag(): void {
  dragOrigin = null
  blobDragging = false
  window.removeEventListener('pointermove', onBlobPointerMove)
  window.removeEventListener('pointerup', onBlobPointerUp)
  window.removeEventListener('pointercancel', onBlobPointerUp)
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
  cleanupBlobDrag()
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
      />
      <div class="float-empty">
        <p class="fe-title">等待会话</p>
        <p class="fe-hint">{{ emptyHint }}</p>
      </div>
    </section>

    <!-- 泊车形态：64×64 玻璃方块（轻点展开回条，拖动整窗移动） -->
    <div
      v-else-if="shape === 'blob'"
      class="float-blob glass-surface"
      :style="glassStyle"
      role="button"
      tabindex="0"
      aria-label="展开浮条"
      @pointerdown="onBlobPointerDown"
      @keydown.enter="expandFromBlob"
      @keydown.space.prevent="expandFromBlob"
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

    <!-- 条 / 确认形态：同一块玻璃壳 + 常驻紧凑标题栏 -->
    <section
      v-else
      class="float-shell glass-surface"
      :style="glassStyle"
      data-tauri-drag-region="deep"
    >
      <GlassFilter
        :id="glassFilterId"
        :enabled="liquidGlass"
      />
      <FloatTitleBar
        :title="titleLabel"
        :kind="titleKind"
        :tone="titleTone"
        @park="park"
        @close="closeWindow"
      />

      <div
        v-if="shape === 'bar'"
        class="float-stage"
      >
        <div class="float-row">
          <FocusFloatContent
            v-if="focusSnapshot"
            :snapshot="focusSnapshot"
            @primary="onPrimary"
            @end="startEnd"
            @open="onOpen"
            @immerse="onImmerse"
          />
          <WorkoutFloatContent
            v-else-if="workoutSnapshot"
            :snapshot="workoutSnapshot"
            @primary="onPrimary"
            @end="startEnd"
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
