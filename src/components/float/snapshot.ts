/**
 * 沉浸会话 → 浮窗快照的**唯一构造器**（程序内浮条与系统浮窗共用）。
 *
 * 为什么放在 components/float 而不是 system：浮窗是独立 vite 入口，不能 import Pinia /
 * router / App，但它渲染的文案必须与程序内浮条一字不差。于是把「会话状态 → 展示数据」
 * 这段纯映射单独放这里：程序内浮条拿它填 #bar/#blob 插槽，主窗口的 globalFloat 拿它
 * 组装 IPC 载荷，浮窗只消费结果。任何文案 / 按钮集合的改动只改这一处，两条渲染路径
 * 不会漂。
 *
 * 类型依赖全部是 `import type`：本模块在浮窗入口里也会被 import，运行时不得把
 * store / runtime 拖进那个 bundle（那会把 Pinia、路由、整个运动状态机一起带过去）。
 */
import type {
  GlobalFloatClock,
  GlobalFloatEndSheet,
  GlobalFloatPrimary,
  GlobalFloatSnapshot,
  GlobalFloatTone,
} from '@/types'
import type { usePomodoroStore } from '@/stores/pomodoro'
import type { WorkoutBarView, workoutRuntime } from '@/system/workoutRuntime'

/** 「打开」落地路由：专注页 / 跑步沉浸页 / 运动页（与 globalFloat 的落地逻辑同一份名字） */
const FOCUS_ROUTE = 'focus'
const RUN_ROUTE = '/session/run'
const COURSE_ROUTE = 'sports'

/* ---------- 专注（番茄钟） ---------- */

/** 相位文案：与 FocusFloatBar 原实现逐字一致。
 *  正计时只有「在走 / 停着」两态，不冒充倒计时的「专注中 / 休息中」。 */
function focusPhaseLabel(up: boolean, running: boolean, breakPhase: boolean): string {
  if (up) return running ? '正计时中' : '正计时 · 已暂停'
  if (!running) return '已暂停'
  return breakPhase ? '休息中' : '专注中'
}

/** 结束按钮文案随相位换：专注（含正计时）里是「结束」，倒计时的休息里其实是「跳过」 */
function focusEndLabel(pomo: ReturnType<typeof usePomodoroStore>): string {
  return pomo.settings.mode !== 'up' && pomo.phase === 'break' ? '跳过' : '结束'
}

/**
 * 结束确认（与卡片 / ActionSheet 同一套语义，标题说后果不说规定）。
 * 倒计时 · 专注：结束会记录这一轮的投入并进入休息，放弃则不留记录；
 * 倒计时 · 休息：reset() 是「跳过休息」—— 休息不计入记录，跳过不影响已保存的专注；
 * 正计时：永远不进休息 —— 结束只把累计专注收尾，放弃则整段不留记录。
 */
export function focusEndSheet(pomo: ReturnType<typeof usePomodoroStore>): GlobalFloatEndSheet {
  const up = pomo.settings.mode === 'up'
  if (up) {
    return {
      title: '结束正计时会记录这段累计专注；放弃则不留记录',
      actions: [
        { id: 'end', label: '结束并记录' },
        { id: 'reset', label: '放弃（不留记录）', danger: true },
      ],
    }
  }
  if (pomo.phase === 'focus') {
    return {
      title: '现在结束会记录这一轮的专注时长并进入休息；放弃则这一轮不留记录',
      actions: [
        { id: 'end', label: '结束并保留记录' },
        { id: 'reset', label: '放弃这一轮（不保存）', danger: true },
      ],
    }
  }
  return {
    title: '现在是休息 —— 跳过休息会直接回到下一轮专注；休息不计入记录，跳过不影响已保存的专注',
    actions: [{ id: 'reset', label: '跳过休息' }],
  }
}

/**
 * 专注快照。
 *
 * clock 为什么是「基准 + 本地时刻」：浮窗（桌面第二个 webview）在应用失焦后不保证
 * 按秒收到推送，读数必须能自己走；把「剩余秒数」与「算它的那个 Date.now()」一起给，
 * 浮窗和主窗口就用同一只系统时钟各算各的，断流时最多停在最后一秒，不会显示错值。
 * 暂停时 atEpochMs 为 null —— 静止的数字不该被本地秒针继续拨。
 */
export function buildFocusSnapshot(pomo: ReturnType<typeof usePomodoroStore>): GlobalFloatSnapshot {
  const up = pomo.settings.mode === 'up'
  const running = pomo.running
  const breakPhase = !up && pomo.phase === 'break'
  // 状态点：在走 = work / break，停着 = paused（与浮条 .dot 的类名一一对应）
  const tone: GlobalFloatTone = running ? (breakPhase ? 'break' : 'work') : 'paused'
  const clock: GlobalFloatClock = {
    direction: up ? 'up' : 'down',
    baseSec: up ? pomo.upElapsedSec : pomo.remainingSec,
    atEpochMs: running ? Date.now() : null,
  }
  return {
    kind: 'focus',
    tone,
    title: focusPhaseLabel(up, running, breakPhase),
    stat: pomo.displayTime,
    clock,
    primary: { id: running ? 'pause' : 'resume', label: running ? '暂停' : '继续' },
    end: { label: focusEndLabel(pomo), sheet: focusEndSheet(pomo) },
    route: FOCUS_ROUTE,
    // 专注的「进入沉浸」是全局沉浸层（不走路由），两种形态都有入口
    canImmersive: true,
  }
}

/* ---------- 训练（课程 / 跑步） ---------- */

/**
 * 训练结束确认（与 ActiveWorkoutBar 原实现逐字一致）。
 * 跑步先冻结进总结页（距离核对在沉浸页完成），课程直接落库。
 */
export function workoutEndSheet(view: WorkoutBarView): GlobalFloatEndSheet {
  if (view.kind === 'run') {
    return {
      title: '现在结束会进入总结页，核对距离与时长后再保存；放弃则这次跑步不会留下记录',
      actions: [
        { id: 'finish', label: '结束并保存' },
        { id: 'discard', label: '放弃本次跑步（不保存）', danger: true },
      ],
    }
  }
  return {
    title: '现在结束会保存这次训练已完成的组数；放弃则一条记录都不留',
    actions: [
      { id: 'finish', label: '结束并保存' },
      { id: 'discard', label: '放弃本次训练（不保存）', danger: true },
    ],
  }
}

/** 主动作：跑步按相位给暂停 / 继续，课程给「完成本组 / 完成」（与浮条按钮同一句文案） */
function workoutPrimary(view: WorkoutBarView): GlobalFloatPrimary | null {
  if (view.kind === 'run') {
    if (view.running) return { id: 'pause', label: '暂停' }
    if (view.paused) return { id: 'resume', label: '继续' }
    return null
  }
  if (!view.completeLabel) return null
  return { id: 'complete', label: view.completeLabel }
}

/**
 * 训练快照；无进行中的运动时返回 null（浮条 / 浮窗都据此整条收起）。
 *
 * clock 恒为 null：训练的统计行里本来就带着计时读数（跑步时长 / 休息倒数 / 计时组），
 * 主窗口每秒推一次心跳载荷，浮窗直接换 stat 即可 —— 再给一条本地秒针反而会和主窗口
 * 的统计口径打架（例如休息倒数同时出现在 stat 与 clock 里，两处四舍五入不一定同拍）。
 * blob 取 view.blob（组进度 / 时长），与程序内 #blob 插槽同一份文案。
 */
export function buildWorkoutSnapshot(rt: typeof workoutRuntime): GlobalFloatSnapshot | null {
  const view = rt.view.value
  if (!view) return null
  const tone: GlobalFloatTone = view.summary ? 'done' : view.paused ? 'paused' : 'work'
  return {
    kind: 'workout',
    tone,
    title: view.title,
    stat: view.stat,
    clock: null,
    blob: view.blob,
    primary: workoutPrimary(view),
    end: view.canEnd ? { label: '结束', sheet: workoutEndSheet(view) } : null,
    // 跑步是路由沉浸页（/session/run）；课程没有路由（沉浸层已与路由解耦），回运动页
    route: rt.immersiveRoute.value ?? (view.kind === 'run' ? RUN_ROUTE : COURSE_ROUTE),
    canImmersive: true,
  }
}
