import { computed, ref, watch } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { buildFocusSnapshot, buildWorkoutSnapshot } from '@/components/float/snapshot'
import { useToast } from '@/composables/useToast'
import { router } from '@/router'
import { floatService } from '@/services/floatService'
import { isTauri } from '@/services/transport'
import { enterFocusImmersive } from '@/system/focusImmersive'
import { motionEffective } from '@/system/motion'
import { perfMode } from '@/system/perf'
import { openImmersive } from '@/system/sessionImmersive'
import { workoutRuntime } from '@/system/workoutRuntime'
import { usePomodoroStore } from '@/stores/pomodoro'
import type {
  GlobalFloatAction,
  GlobalFloatForm,
  GlobalFloatSnapshot,
  GlobalFloatStatePayload,
  GlobalFloatStatus,
} from '@/types'

/**
 * 全局沉浸浮窗 · 主窗口侧运行时（system 层单例）。
 *
 * 分工：**主窗口是唯一真源** —— 它把正在跑的沉浸会话（训练 > 专注）压成一份
 * `GlobalFloatSnapshot`，推给系统浮窗（桌面第二窗口 / Android 原生浮层）；浮窗只渲染
 * 快照、把用户按下的按钮原样发回来。所以浮窗里没有任何状态机：它永远显示的是主窗口
 * 的真实状态，结束/暂停/放弃全部落在主窗口既有的 store action 上（与程序内浮条同一条路）。
 *
 * 为什么「应用不在前台才显示」：程序内浮条此刻已经不在用户眼前（窗口失焦/最小化，
 * 或手机切到了别的 App），系统浮窗正好补上这一段；主窗口一回到前台，浮条自己就回来了，
 * 两者**永不并存** —— 同时出现两块相同的读数只会让人怀疑哪一块是真的。
 *
 * 降级：`global_float_status()` 说 supported/permitted 为假时（浏览器预览、Android 未授权、
 * 建窗失败），本模块全程空转，程序内浮条与计时**一字不改**。
 *
 * 平台分支只有两处（桌面 / Android），判定在模块装载时算一次：
 *   · 桌面：主窗口失焦 → open（建窗/显示）；回焦 → close（hide）。
 *   · Android：会话在跑就保持前台服务（原生侧按 Activity 前台态自己显隐浮层），
 *     所以这里不跟踪「失焦」，只跟踪有没有会话。
 */

const KEY_ENABLED = 'rein.globalFloat.v1'
const KEY_FORM = 'rein.float.form.v1'

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
/** Android 包（系统浮层走原生，不是桌面第二窗口） */
export const isAndroidShell = /Android/i.test(ua)

/** 桌面端才有自绘标题栏与第二窗口（浏览器预览两者都没有） */
const desktopShell = isTauri && !isAndroidShell

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* 本地存储不可用时用默认值：默认开，浮窗只在离开应用时出现，不会打扰 */
  }
  return fallback
}

function readForm(): GlobalFloatForm {
  try {
    return localStorage.getItem(KEY_FORM) === 'blob' ? 'blob' : 'bar'
  } catch {
    return 'bar'
  }
}

/** 用户开关（默认开：它只在「有会话 + 离开应用」时出现，不存在打扰场景） */
export const floatEnabled = ref(readFlag(KEY_ENABLED, true))
/** 浮窗形态：bar 全宽条 / blob 64×64 泊车方块（与程序内两态同义） */
export const floatForm = ref<GlobalFloatForm>(readForm())
/**
 * 平台能力 / 权限 / 此刻可见性（设置卡片与会话状态共用这一份）。
 * 初值按**平台能力**先给一个合理值（桌面 true / true；Android 支持但未授权；浏览器 false），
 * 免得设置卡片在第一条 IPC 回来之前闪一下「本机不支持」——之后一律以 Rust 快照为准。
 */
export const floatStatus = ref<GlobalFloatStatus>({
  supported: isTauri,
  permitted: isTauri && !isAndroidShell,
  visible: false,
})

/**
 * 能力 / 开关 / 权限的合并状态短语。
 * 设置页入口与三级页共用这一份措辞：两处各写一遍，迟早会出现「入口说已开启、
 * 详情页说未授权」这种自相矛盾的读数。
 */
export const floatStateText = computed(() => {
  if (!isTauri) return '浏览器预览不支持'
  if (!floatStatus.value.supported) return '本机不支持'
  if (!floatEnabled.value) return '已关闭'
  if (!floatStatus.value.permitted) return '未授权'
  return floatStatus.value.visible ? '浮窗显示中' : '待命'
})

/** 桌面主窗口是否有焦点（Android 不看这个） */
const appFocused = ref(true)
/** 用户点过「关闭」：本次失焦期不再自动弹，主窗口回焦后清除 */
const dismissed = ref(false)

let pomo: ReturnType<typeof usePomodoroStore> | null = null
let initialized = false
/** 浮窗（桌面窗口 / Android 服务）当前是否已拉起，避免每次快照变化都重复 open */
let shown = false
let pushTimer: ReturnType<typeof setInterval> | null = null
const unlisteners: UnlistenFn[] = []

/**
 * 当前可浮的会话：训练优先、其次专注。
 * 两者在设计上互斥（练的时候不会开番茄），优先级只是兜底 —— 万一同时存在，
 * 训练是更「重」的那个会话，浮出去它更有用。
 */
const currentSnapshot = computed<GlobalFloatSnapshot | null>(() => {
  if (!pomo) return null
  const workout = buildWorkoutSnapshot(workoutRuntime)
  if (workout) return workout
  // 专注：只有「正在进行 / 暂停在半途」才有可浮的东西（与浮条的 active 同一条判据）
  return pomo.active ? buildFocusSnapshot(pomo) : null
})

/** 会话是否存在（设置卡片与显示判定共用；iOS/浏览器下同样可用） */
export const floatHasSession = computed(() => currentSnapshot.value != null)

function buildPayload(): GlobalFloatStatePayload | null {
  const snapshot = currentSnapshot.value
  if (!snapshot) return null
  return {
    snapshot,
    form: floatForm.value,
    // 画质 / 动效档一起下发：浮窗是另一个 webview（或原生浮层），首帧就按同一档渲染，
    // 不然会先闪一帧默认档再被 localStorage 纠正。
    perf: perfMode.value,
    motion: motionEffective.value,
  }
}

/** 此刻应不应该有系统浮窗 */
function wantVisible(): boolean {
  if (!floatEnabled.value) return false
  if (!currentSnapshot.value) return false
  // 用户点过「关闭」→ 本次不再自动出现（桌面：主窗口回焦解除；Android：回到应用解除）
  if (dismissed.value) return false
  // Android：原生侧按 Activity 前台态自己显隐浮层，这里只决定「服务要不要在跑」
  // —— 只要会话在跑就保持服务（服务在前台启动，避免 Android 12+ 后台起前台服务的限制），
  //   手机回到应用时 Kotlin 把浮层藏起来，不重复出现。
  if (isAndroidShell) return true
  return !appFocused.value
}

/**
 * 把「想不想显示」与「实际显示」对齐。幂等，任何状态变化都可以调。
 *
 * push 在 open 之前：Rust 侧会缓存最近一份载荷，窗口是后建的也能在页面载入时用
 * `global_float_latest` 拿到首帧 —— 反过来先建窗会闪一帧空态。
 */
async function sync(): Promise<void> {
  if (!isTauri) return
  const want = wantVisible()
  const payload = buildPayload()
  if (want && payload) {
    try {
      await floatService.push(payload)
      if (!shown) {
        // 先归一窗口形状再显示：上一次可能是确认态的高度，直接 show 会先闪一帧高窗
        try {
          await floatService.setForm(floatForm.value)
        } catch {
          /* 归一失败不影响显示 */
        }
        const st = await floatService.open()
        floatStatus.value = st
        shown = st.visible || (isAndroidShell && st.permitted)
      }
    } catch {
      /* 浮窗拉起失败：保持降级（程序内浮条不受影响），下次状态变化再试 */
      shown = false
    }
    return
  }
  if (!shown) return
  shown = false
  try {
    await floatService.close()
  } catch {
    /* 收不起也不改本地状态：下一次会话结束/开关变化会再收一次 */
  }
}

/** 主动刷新能力状态（设置页进入、Android 授权返回、开关拨动时调用） */
export async function refreshFloatStatus(): Promise<GlobalFloatStatus> {
  if (!isTauri) {
    floatStatus.value = { supported: false, permitted: false, visible: false }
    return floatStatus.value
  }
  try {
    floatStatus.value = await floatService.status()
  } catch {
    floatStatus.value = { supported: false, permitted: false, visible: false }
  }
  return floatStatus.value
}

/** Android：跳系统「在其他应用上显示」授权页（桌面空操作） */
export async function requestFloatPermission(): Promise<GlobalFloatStatus> {
  if (!isTauri) return refreshFloatStatus()
  try {
    floatStatus.value = await floatService.requestPermission()
  } catch {
    /* 跳转失败不改状态：设置卡片照旧显示「未授权」 */
  }
  // 授权页回来是异步的：连查几次收敛（与 tracking 的轮询口径一致）
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400))
    const st = await refreshFloatStatus()
    if (st.permitted) break
  }
  await sync()
  return floatStatus.value
}

/** 设置开关 */
export function setFloatEnabled(on: boolean): void {
  floatEnabled.value = on
  try {
    localStorage.setItem(KEY_ENABLED, on ? '1' : '0')
  } catch {
    /* 存不下就只留内存态 */
  }
  void sync()
}

/** 切换形态（浮窗标题栏的泊车键 / blob 轻点） */
export function setFloatForm(form: GlobalFloatForm): void {
  floatForm.value = form
  try {
    localStorage.setItem(KEY_FORM, form)
  } catch {
    /* 同上 */
  }
  // 形态由主窗口决定：先让原生侧改窗口尺寸，再把新载荷推过去（顺序不能反，
  // 否则浮窗会先按旧尺寸渲染一帧）
  void (async () => {
    if (!isTauri) return
    try {
      await floatService.setForm(form)
    } catch {
      /* 改尺寸失败不影响内容：下一次 push 仍带新形态 */
    }
    await sync()
  })()
}

/** 桌面：把主窗口叫到前台并落到该会话的页面（浮窗上的「打开」） */
async function bringApp(route?: string): Promise<void> {
  if (route) {
    try {
      await router.push(route.includes('/') ? route : { name: route })
    } catch {
      /* 路由不存在（会话已结束等）不该把动作链打断 */
    }
  }
  if (!isTauri || isAndroidShell) return
  try {
    const w = getCurrentWindow()
    await w.show()
    await w.setFocus()
  } catch {
    /* 无法聚焦时保持现状：浮窗动作已经生效，用户手动切回即可 */
  }
}

/** 结束会话（选项 id 来自快照的 end.sheet.actions，与程序内 ActionSheet 同源） */
async function endSession(option?: string): Promise<void> {
  const snapshot = currentSnapshot.value
  if (!snapshot || !option) return
  const { toast } = useToast()
  if (snapshot.kind === 'focus') {
    if (option === 'end') void pomo?.endRound()
    else if (option === 'reset') pomo?.reset()
    return
  }
  // 训练：与程序内浮条同一条语义（跑步必须先冻结进总结页再核对保存）
  if (option === 'finish') {
    if (workoutRuntime.kind.value === 'run') {
      workoutRuntime.enterRunSummary()
      await bringApp('/session/run')
      return
    }
    try {
      const r = await workoutRuntime.finishCourse()
      if (r) toast(`已保存 ${r.done} 组 · 约 ${r.durationMin} 分钟 · ${r.kcal} 大卡`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败，请重试')
    }
    return
  }
  if (option === 'discard') {
    const wasRun = workoutRuntime.kind.value === 'run'
    try {
      await workoutRuntime.discardActive()
      toast(wasRun ? '已放弃本次跑步' : '已放弃本次训练')
    } catch (e) {
      toast(e instanceof Error ? e.message : '放弃失败，请重试')
    }
  }
}

/** 浮窗动作统一入口（桌面事件 / Android DOM 事件 / 冷启动 takeAction 都汇到这里） */
async function handleAction(raw: GlobalFloatAction | null | undefined): Promise<void> {
  if (!raw || typeof raw.action !== 'string') return
  const snapshot = currentSnapshot.value
  switch (raw.action) {
    case 'pause':
      if (snapshot?.kind === 'workout') workoutRuntime.pauseActive()
      else pomo?.pause()
      break
    case 'resume':
      if (snapshot?.kind === 'workout') workoutRuntime.resumeActive()
      else pomo?.start()
      break
    case 'complete':
      workoutRuntime.completeCurrentSet()
      break
    case 'end':
      await endSession(raw.option)
      break
    case 'open':
      // 「打开」= 把应用叫回来并落在会话上：专注去专注页；跑步回路由沉浸页；
      // 训练课没有路由（沉浸层已与路由解耦），直接开沉浸层（与程序内浮条的点击同一落点）
      if (snapshot?.kind === 'focus') await bringApp('focus')
      else if (workoutRuntime.kind.value === 'run') await bringApp('/session/run')
      else {
        await bringApp('sports')
        openImmersive()
      }
      break
    case 'immerse':
      if (snapshot?.kind === 'focus') {
        await bringApp('focus')
        enterFocusImmersive()
      } else if (workoutRuntime.kind.value === 'run') await bringApp('/session/run')
      else {
        await bringApp('sports')
        openImmersive()
      }
      break
    case 'close':
      dismissed.value = true
      shown = false
      try {
        await floatService.close()
      } catch {
        /* 收不起也不改本地状态：主窗口回焦时会再对齐一次 */
      }
      break
    case 'form':
      // bar / blob 是持久形态（用户偏好）；confirm 只是结束确认期的临时长高，
      // 不进偏好 —— 也正因为如此，它只改窗口形状，不动已下发的载荷。
      if (raw.form === 'confirm') {
        try {
          await floatService.setForm('confirm')
        } catch {
          /* 长高失败就挤在 bar 高度里渲染：内容可截断，动作仍然可点 */
        }
      } else if (raw.form === 'bar' || raw.form === 'blob') {
        setFloatForm(raw.form)
      }
      break
  }
  // 动作改变状态后立即刷新一次（不必等 1s 心跳）：open/close 之外，暂停/结束都会改快照
  if (raw.action !== 'close' && raw.action !== 'form') void sync()
}

/** Android：原生浮层按钮走 DOM 事件；冷启动/冻结期丢掉的点击由 takeAction 兜底 */
async function consumeNativeAction(): Promise<void> {
  try {
    const raw = await floatService.takeAction()
    if (!raw) return
    await handleAction(JSON.parse(raw) as GlobalFloatAction)
  } catch {
    /* 没有缓存动作 / JSON 损坏：正常情况，不必上报 */
  }
}

/** 桌面主窗口焦点：失焦 → 显示浮窗；回焦 → 收起并解除「用户关掉了」的抑制 */
async function trackFocus(): Promise<void> {
  if (!desktopShell) return
  try {
    const w = getCurrentWindow()
    appFocused.value = await w.isFocused()
    unlisteners.push(
      await w.onFocusChanged(({ payload }) => {
        appFocused.value = payload
        if (payload) dismissed.value = false
        void sync()
      }),
    )
  } catch {
    /* 读不到焦点就当一直有焦点：浮窗不显示，不会出现「关不掉」的浮窗 */
  }
}

/** 应用启动调用（幂等，main.ts 里与其他运行时并列） */
function init(): void {
  if (initialized) return
  initialized = true
  if (!isTauri) return // 浏览器预览：没有系统浮窗，设置卡片读到 mock 的 supported=false
  pomo = usePomodoroStore()
  void refreshFloatStatus()
  void trackFocus()
  void listen<GlobalFloatAction>('rein://float/action', (e) => void handleAction(e.payload))
    .then((un) => unlisteners.push(un))
    .catch(() => {
      /* 事件通道不可用：动作还能经 takeAction 兜底 */
    })
  window.addEventListener('rein-float-action', onNativeAction)
  document.addEventListener('visibilitychange', onVisibilityChange)
  unlisteners.push(() => window.removeEventListener('rein-float-action', onNativeAction))
  unlisteners.push(() => document.removeEventListener('visibilitychange', onVisibilityChange))

  // 快照一变就对齐一次：开新会话 / 暂停 / 切相位 / 训练换动作都走这条
  watch(currentSnapshot, () => void sync(), { flush: 'post' })
  watch([floatEnabled, appFocused, dismissed], () => void sync())

  // 心跳：训练课的 stat 含计时读数、专注的 clock 也要保持新鲜；推送很便宜（一条 IPC）
  pushTimer = setInterval(() => {
    if (shown) void sync()
  }, 1000)

  void consumeNativeAction()
  void sync()
}

function onNativeAction(e: Event): void {
  void handleAction((e as CustomEvent<GlobalFloatAction>).detail)
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return
  // 回到应用：解除「本次不再显示」的抑制（与桌面「主窗口回焦即解除」同一语义），
  // 并处理 Android 授权页返回 / 冻结期积压的原生动作
  dismissed.value = false
  void refreshFloatStatus().then(() => sync())
  void consumeNativeAction()
}

export const globalFloat = {
  init,
  enabled: floatEnabled,
  form: floatForm,
  status: floatStatus,
  hasSession: floatHasSession,
  setEnabled: setFloatEnabled,
  setForm: setFloatForm,
  requestPermission: requestFloatPermission,
  refreshStatus: refreshFloatStatus,
  handleAction,
}

/** 单例卸载（仅测试/hot reload 用；应用生命周期内不调用） */
export function disposeGlobalFloat(): void {
  if (pushTimer) clearInterval(pushTimer)
  pushTimer = null
  for (const un of unlisteners.splice(0)) {
    try {
      un()
    } catch {
      /* 卸载失败不影响进程退出 */
    }
  }
  initialized = false
}