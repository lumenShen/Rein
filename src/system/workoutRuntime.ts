/**
 * 运动系统运行时 · 应用级单例（main.ts 装载，与组件树生命周期解耦）。
 *
 * 运动的计时 / 步骤 / 开始 / 暂停状态机在 stores/run（跑步）与
 * stores/session（训练课）——两者是 Pinia 应用级单例，组件挂载与卸载
 * 不影响计时、GPS 与落盘。本模块在状态机之上承担四件事：
 *
 * 1. 应用启动时接管服务端未正常结束的会话（原各页「检测到未完成的
 *    训练」恢复卡逻辑收敛于此）：跑步自动接续（轨迹/累计量全继承，
 *    只给一次气泡），课程续跑；
 * 2. 为沉浸页与悬浮运动条（ActiveWorkoutBar）提供统一的数据与动作
 *    入口——两者都只从这里取「当前运动」的展示与控制；
 * 3. whenReady()：沉浸页挂载时先等接管完成，再决定进入哪个阶段，
 *    避免与启动接管竞态（如直接冷开 #/session/run）；
 * 4. 通知数据桥：把「当前运动」组装成前台通知载荷交给原生渲染（锁屏
 *    可见、可点按），并消费通知自身的点按。原生只渲染、不判断 ——
 *    文案、进度、倒计时目标、动作键的语义全在这里。
 *
 * 使用约定：Pinia 在 main.ts 中先于 init() 安装；本模块所有 store
 * 访问都在函数内延迟进行，保证模块顶层 import 无副作用。
 */

import { computed, watch } from 'vue'

import { router } from '@/router'
import { sessionService } from '@/services/sessionService'
import { trackingService } from '@/services/trackingService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { fmtClock, fmtPace, useRunStore } from '@/stores/run'
import { useSessionStore } from '@/stores/session'
import type { SessionFinishResult } from '@/stores/session'
import { openImmersive } from '@/system/sessionImmersive'
import { RUN_PLAN_ID } from '@/types'

export type WorkoutKind = 'none' | 'run' | 'course'

/** 悬浮运动条 / 外部控制用的统一视图（无运动时为 null） */
export interface WorkoutBarView {
  kind: 'run' | 'course'
  /** 正在记录（跑步计时中；课程任意进行阶段） */
  running: boolean
  /** 仅跑步：暂停中（结束前必须先暂停） */
  paused: boolean
  /** 已到总结、待保存 */
  summary: boolean
  title: string
  /** 主统计行：跑步 = 时长 · 配速 · 里程；课程 = 动作名 · 组进度 */
  stat: string
  /** 方块泊车态的一行短统计（64px 方块内只放得下它）：跑步=时长，课程=组/休息进度 */
  blob: string
  /** 课程主动作按钮文案（完成本组 / 完成）；无则为 null */
  completeLabel: string | null
  /** 允许走「结束 → 二级确认」；跑步仅暂停后为 true（必须暂停再结束） */
  canEnd: boolean
}

/* ---------- 启动接管 ---------- */

let takeover: Promise<void> | null = null

/**
 * 应用启动调用（幂等）：服务端存在 active 行 = 上次未正常结束
 * （切页 / 收起 / 关窗 / 崩溃），接管进对应状态机。
 */
function init(): Promise<void> {
  startNotify()
  if (takeover) return takeover
  takeover = (async () => {
    let planId: string | null
    try {
      const rec = await sessionService.getActive()
      planId = rec?.planId ?? null
    } catch {
      planId = null // 后端暂不可用：沉浸页自身的 hydrate 仍会兜底
    }
    if (planId === RUN_PLAN_ID) await useRunStore().hydrateFromServer()
    else if (planId != null) await useSessionStore().hydrateFromServer()
  })()
  // 冷启动兜底：进程被杀后点锁屏通知进来时，Kotlin 只来得及写 pendingOpen
  // （那一刻 WebView 还没载入，事件根本送不到）。先等启动接管完成再读，
  // 否则会路由到一个还没恢复的会话上。
  void takeover
    .catch(() => {}) // 接管失败（后端不可用等）也要把「点通知进来」这条路走完
    .then(() => void consumePendingOpen())
  return takeover
}

/** 等待启动接管完成（沉浸页 onMounted 先 await 此函数） */
function whenReady(): Promise<void> {
  return takeover ?? init()
}

/* ---------- 派生 ---------- */

/** 当前运动类别：两台状态机任一非 idle 即有运动（ready 阶段不算） */
const kind = computed<WorkoutKind>(() => {
  if (useRunStore().isActive) return 'run'
  if (useSessionStore().isActive) return 'course'
  return 'none'
})

/**
 * 恢复沉浸模式的目标路由。
 *
 * 只有跑步是「路由沉浸页」；训练课的沉浸层与路由早已解耦（收起/展开只换 v-show，
 * 见 SessionOverlay 顶部注释）。课程分支从前返回 `/session`，而那条路由已经移除
 * （ARCHITECTURE §8）——留着一个不存在的路径，就是给后来人准备的一个死值：
 * 谁照着 `immersiveRoute` 写一行 `router.push`，谁就跳进空白页。返回 null，
 * 调用方据此去开沉浸层。
 */
const immersiveRoute = computed(() => (kind.value === 'run' ? '/session/run' : null))

const view = computed<WorkoutBarView | null>(() => {
  if (kind.value === 'run') {
    const r = useRunStore()
    const paused = r.phase === 'paused'
    const pace = r.paceSecPerKm != null ? fmtPace(r.paceSecPerKm) : '—'
    const km = r.km > 0.005 ? r.km.toFixed(2) : '—'
    return {
      kind: 'run',
      running: r.phase === 'running',
      paused,
      summary: r.phase === 'summary',
      title: paused ? '户外跑 · 已暂停' : '户外跑',
      stat: `${fmtClock(r.elapsedSec)} · ${pace}/km · ${km} km`,
      blob: fmtClock(r.elapsedSec),
      completeLabel: null,
      canEnd: paused,
    }
  }
  if (kind.value === 'course') {
    const s = useSessionStore()
    const lib = useExerciseLibStore()
    const ex = s.currentEx
    // 动作名一律取库内名（改名跟随），库里查不到才回落课程条目快照
    const exName = ex ? lib.resolveName(ex) : ''
    const summary = s.phase === 'summary'
    let stat = ''
    let blob = ''
    switch (s.phase) {
      case 'warmup':
        stat = ex ? `${exName} · 激活热身 ${s.warmupDone(ex)}/${s.warmupsFor(ex).length}` : ''
        blob = '热身'
        break
      case 'exercise':
        stat = ex ? `${exName} · 第 ${s.setIndex}/${s.effSets(ex)} 组 × ${ex.reps ?? '—'} 次` : ''
        blob = ex ? `${s.setIndex}/${s.effSets(ex)} 组` : ''
        break
      case 'rest':
        stat =
          `休息 ${s.restLeft}s · ` +
          (s.restWarmup
            ? '热身中'
            : s.restTargetIsNextSet
              ? `第 ${s.setIndex + 1} 组`
              : `下一个 ${s.plan?.exercises[s.exIndex + 1] ? lib.resolveName(s.plan.exercises[s.exIndex + 1]!) : ''}`)
        blob = `${s.restLeft}s`
        break
      case 'timed-ready':
        stat = ex ? `${exName} · 准备中` : ''
        blob = '准备'
        break
      case 'timed-run':
        stat = ex ? `${exName} · ${Math.floor(s.timedElapsed)} / ${s.timedTotal}s` : ''
        blob = `${Math.floor(s.timedElapsed)}s`
        break
      case 'summary':
        stat = `已完成 ${s.doneCount}/${s.totalCount} 组 · 待保存`
        blob = `${s.doneCount} 组`
        break
    }
    return {
      kind: 'course',
      running: !summary,
      paused: false,
      summary,
      title: s.plan?.name ?? '训练课',
      stat,
      blob,
      completeLabel:
        s.phase === 'exercise' ? '完成本组' : s.phase === 'timed-run' ? '完成' : null,
      canEnd: !summary,
    }
  }
  return null
})

/* ---------- 动作（转发到对应状态机） ---------- */

function pauseActive(): void {
  if (kind.value === 'run') useRunStore().pause()
}

function resumeActive(): void {
  if (kind.value === 'run') useRunStore().resume()
}

/** 课程主动作：做组中 = 完成本组（与沉浸页坞内一致）；计时中 = 完成计时 */
function completeCurrentSet(): void {
  if (kind.value !== 'course') return
  const s = useSessionStore()
  if (s.phase === 'exercise') s.completeSet()
  else if (s.phase === 'timed-run') s.finishTimed()
}

/** 跑步「结束并保存」：冻结计时进总结页（距离补填在沉浸页完成） */
function enterRunSummary(): void {
  useRunStore().enterSummary()
}

/** 课程「结束并保存」：直接落库并关闭会话 */
async function finishCourse(): Promise<SessionFinishResult | null> {
  if (kind.value !== 'course') return null
  return useSessionStore().finishAndSave()
}

/** 放弃当前运动（已经过二级确认）：关闭会话、不写记录 */
async function discardActive(): Promise<void> {
  if (kind.value === 'run') await useRunStore().discard()
  else if (kind.value === 'course') await useSessionStore().discard()
}

/* ---------- 通知数据桥（原生只渲染，判断全在这里） ---------- */

/**
 * 通知载荷。Android 侧 RunTrackingService 只按字段渲染，不做任何判断：
 * 标题 / 正文 / 副文、进度条、倒计时目标、动作键全部由这里决定
 * （原生拿不到语义时用默认文案兜底）。
 * 纯时间锚点（updatedAt / whenMs / elapsedMs）每次推送按当下重算，
 * 不进变化指纹。
 */
interface NotifyPayload {
  kind: 'run' | 'course' | 'none'
  phase: 'running' | 'autopause' | 'paused' | 'summary' | 'warmup' | 'exercise' | 'rest' | 'timed'
  title: string
  text: string
  sub: string
  elapsedMs: number
  countdown: boolean
  whenMs: number
  progress: { max: number; cur: number } | null
  later: { whenMs: number; text: string; sub: string } | null
  action: { resume: boolean } | null
  updatedAt: number
}

/** 一次推送的草稿：载荷 + 两个变化指纹（决定「要不要重推」） */
interface NotifyDraft {
  payload: NotifyPayload
  /** 结构指纹：相位与文案骨架。变了立刻推——锁屏上要「同步」看到暂停/换组 */
  frame: string
  /** 数字指纹：两位小数公里、配速 5s/km 粒度、休息与计时秒。变了按节流窗口推 */
  digits: string
  /** 终态文案只推一次（课程总结），心跳不必反复刷同一条 */
  once?: boolean
}

const RUN_TITLE = 'Rein · 户外跑'
/** 比较节拍：1s 对一次状态；秒级跳动交给原生的 chronometer，不推 */
const TICK_MS = 1000
/** 数字类变化的最小推送间隔（结构类变化不受它约束） */
const PUSH_MIN_MS = 1000
/** 心跳兜底：用户把通知划掉后，靠它把通知带回来 */
const PUSH_HEARTBEAT_MS = 15_000
/** 收敛重试：原生状态是「缓存 + 异步刷新」，一次读到的可能还是旧值 */
const RETRY_MAX = 5
const RETRY_MS = 400

let notifyStarted = false
/** 原生采集侧判定（= 有没有前台服务可以渲染通知）；null 未判定 */
let nativePromise: Promise<boolean> | null = null
let lastFrame = ''
let lastContent = ''
let lastPushAt = 0
let notifyWarned = false

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 是否有原生采集侧：桌面/浏览器没有前台服务，整个推送器空转
 * （不是「发出去失败了」，而是根本不该发）。
 * status 读法照契约：busy 期间 400ms 重试 ≤5 次再落状态。
 */
async function resolveNative(): Promise<boolean> {
  let native = false
  for (let i = 0; i <= RETRY_MAX; i++) {
    const st = await trackingService.status()
    native = st.native === true
    if (!st.busy) break
    if (i < RETRY_MAX) await sleep(RETRY_MS)
  }
  return native
}

function nativeAvailable(): Promise<boolean> {
  nativePromise ??= resolveNative()
  return nativePromise
}

/**
 * 跑步通知：没有相位推进，只有「跑 / 自动暂停 / 手动暂停」三态 + GPS 新鲜度。
 * 时长交给原生 chronometer 正计时（文本不写字面时长）；暂停时 chronometer 停摆，
 * 冻结值改写进文本。
 */
function buildRunDraft(): NotifyDraft | null {
  const r = useRunStore()
  if (r.phase === 'summary') return null // 跑步不推 summary：收通知交给 runEnd()/setKeepalive(false)
  const autopause = r.pauseCause === 'auto'
  const paused = r.phase === 'paused'
  const phase: NotifyPayload['phase'] = autopause ? 'autopause' : paused ? 'paused' : 'running'
  const km = r.km.toFixed(2)
  const pace = r.paceSecPerKm
  const now = Date.now()
  const title =
    phase === 'autopause' ? `${RUN_TITLE} · 已自动暂停` : phase === 'paused' ? `${RUN_TITLE} · 已暂停` : RUN_TITLE
  const text =
    phase === 'running'
      ? `${km} km · ${pace != null ? fmtPace(pace) : '—'}/km`
      : `${fmtClock(r.elapsedSec)} · ${km} km`
  // 副文优先级：降级 > 相位 > GPS 新鲜度——降级是此刻最该让用户知道的一件事
  let sub = 'GPS 良好'
  if (r.nativeDegraded) sub = '定位已回退 · 可能被系统中断'
  else if (phase === 'autopause') sub = '恢复跑动后自动继续'
  else if (phase === 'paused') sub = '手势点按返回可继续'
  else if (r.gpsStatus === 'unavailable' || r.fixWaitSec > 20) sub = `GPS 未更新 · 距离停在 ${km} km`
  return {
    payload: {
      kind: 'run',
      phase,
      title,
      text,
      sub,
      elapsedMs: Math.round(r.elapsedMs),
      countdown: false,
      whenMs: now,
      progress: null,
      later: null,
      action: phase === 'paused' ? { resume: true } : null,
      updatedAt: now,
    },
    frame: JSON.stringify(['run', phase, title, sub]),
    // 配速按 5s/km 取粒度：跳一下数字不值得重推，但 5s 内一定反映得过来
    digits: JSON.stringify([km, pace != null ? Math.round(pace / 5) : -1]),
  }
}

/**
 * 课程通知：热身 / 做组 / 休息（原生倒计时）/ 计时 / 总结。
 * 组进度走 progress；休息的结束时刻同时给 whenMs（倒计时锚点）与 later
 * （原生 postDelayed 一次性替换文案）。
 */
function buildCourseDraft(): NotifyDraft | null {
  const s = useSessionStore()
  const plan = s.plan
  if (!plan || s.phase === 'idle') return null
  const lib = useExerciseLibStore()
  const ex = s.currentEx
  const exName = ex ? lib.resolveName(ex) : ''
  const now = Date.now()
  // 休息截止时刻：store 里那根 deadline 是私有的，这里按当前剩余秒重算
  // （秒级量化，误差 ≤1s）。不为了一个通知去动别人的 store。
  const restEndsAt = now + Math.max(0, s.restLeft) * 1000
  const nextEx = plan.exercises[s.exIndex + 1]
  const nextName = nextEx ? lib.resolveName(nextEx) : ''
  const warmupStep = ex ? `${s.warmupDone(ex)}/${s.warmupsFor(ex).length}` : ''
  let phase: NotifyPayload['phase']
  let text: string
  let countdown = false
  let later: NotifyPayload['later'] = null
  switch (s.phase) {
    case 'warmup':
      phase = 'warmup'
      text = ex ? `${exName} · 激活热身 ${s.warmupDone(ex)}/${s.warmupsFor(ex).length}` : ''
      break
    case 'exercise':
      phase = 'exercise'
      text = ex ? `${exName} · 第 ${s.setIndex}/${s.effSets(ex)} 组 × ${ex.reps ?? '—'} 次` : ''
      break
    case 'rest': {
      phase = 'rest'
      countdown = true
      const target = s.restWarmup
        ? '继续激活热身'
        : s.restTargetIsNextSet
          ? `第 ${s.setIndex + 1} 组`
          : `下一个 ${nextName}`
      text = `休息 ${s.restLeft}s · ${target}`
      later = { whenMs: restEndsAt, text: `休息结束 · ${target}`, sub: '' }
      break
    }
    case 'timed-ready':
      phase = 'timed'
      text = ex ? `${exName} · 准备中` : ''
      break
    case 'timed-run':
      phase = 'timed'
      text = ex ? `${exName} · ${Math.floor(s.timedElapsed)} / ${s.timedTotal}s` : ''
      break
    case 'summary':
      phase = 'summary'
      text = `已完成 ${s.doneCount}/${s.totalCount} 组 · 待保存`
      break
    default:
      return null // 不可达：idle 已在上面挡掉
  }
  return {
    payload: {
      kind: 'course',
      phase,
      title: plan.name,
      text,
      sub: '',
      elapsedMs: s.durationSec * 1000, // 总时长走墙钟推导，跨重启仍准确
      countdown,
      whenMs: countdown ? restEndsAt : now,
      progress: { max: s.totalCount, cur: s.doneCount },
      later,
      action: null,
      updatedAt: now,
    },
    // 结构指纹照契约列：相位 / 文案骨架 / 组进度 / 热身步 / 休息目标
    frame: JSON.stringify([
      'course',
      s.phase, // timed-ready 与 timed-run 同为 timed：靠它区分「准备中」与「计时中」
      phase,
      plan.name,
      countdown,
      s.totalCount,
      s.doneCount,
      warmupStep,
      later?.text ?? '',
    ]),
    digits: JSON.stringify([text]),
    once: phase === 'summary',
  }
}

/** 推送（尽力而为）：原生侧缺失/失败只影响通知，绝不影响训练本身 */
async function push(draft: NotifyDraft): Promise<void> {
  // 先记指纹再 await：推送在途时来的下一拍不该把同一条重发一遍
  lastFrame = draft.frame
  lastContent = `${draft.frame}|${draft.digits}`
  lastPushAt = Date.now()
  try {
    await trackingService.notify(JSON.stringify(draft.payload))
  } catch (e) {
    if (!notifyWarned) {
      notifyWarned = true
      console.warn('[notify] 通知推送不可用，本次运行期间不再提示', e)
    }
  }
}

async function tick(): Promise<void> {
  if (kind.value === 'none') {
    // 无运动：不推 kind='none'——通知的收走由 runEnd()/setKeepalive(false) 负责。
    // 清指纹，下一次开跑的第一帧立刻能出去。
    lastFrame = ''
    lastContent = ''
    return
  }
  const draft = kind.value === 'run' ? buildRunDraft() : buildCourseDraft()
  if (!draft) return // 跑步总结态：通知此刻已由 run store 收走
  if (!(await nativeAvailable())) return
  const content = `${draft.frame}|${draft.digits}`
  const since = Date.now() - lastPushAt
  if (content === lastContent) {
    // 内容没变：只有心跳到期才重推（通知被划掉时靠它带回来），终态连心跳都省
    if (draft.once || since < PUSH_HEARTBEAT_MS) return
  } else {
    // 结构变了（相位/自动暂停/文案骨架）立刻推，锁屏上要「同步」看到；
    // 只是数字变了（公里/配速/休息秒）则等节流窗口，下一拍再推
    const structural = draft.frame !== lastFrame
    if (!structural && since < PUSH_MIN_MS) return
  }
  await push(draft)
}

/**
 * 「点通知进来」的落点：跑步回路由沉浸页；课程开沉浸层（课程不走路由）。
 * 先等启动接管：后台唤起时 store 可能还没恢复，路由过去会看到空页。
 */
async function openWorkout(target: 'run' | 'course'): Promise<void> {
  await init()
  try {
    if (target === 'run') await router.push('/session/run')
    else if (kind.value === 'course') openImmersive() // 陈旧通知不至于把用户扔进空壳
  } catch (e) {
    // 跳转失败不该把异常抛回通知点按这条链（原生推送是无返回值的）
    console.warn('[notify] 打开运动页失败', e)
  }
}

function onOpenWorkout(e: Event): void {
  const target = (e as CustomEvent<{ kind?: string }>).detail?.kind
  if (target === 'run' || target === 'course') void openWorkout(target)
}

/**
 * 通知「继续」键：WebView 冻结期间 Chromium 会把 evaluateJavascript 排队，
 * 解冻后按序执行到这里——此刻 store 已经活着，直接续跑即可。
 * 迟到的点击（已结束/已进总结）由 run store 自身的相位守卫吞掉。
 */
function onResumeWorkout(): void {
  void init().then(() => useRunStore().resume())
}

/**
 * 冷启动兜底：读一次「通知点进来的目标」（原生是「缓存 + 异步刷新」的
 * 收敛读法，读到空不代表没有），空则 400ms 重试。
 */
async function consumePendingOpen(): Promise<void> {
  for (let i = 0; i <= RETRY_MAX; i++) {
    let target: string
    try {
      target = await trackingService.openPending()
    } catch {
      return // 命令不可用（桌面/浏览器）：本就没有通知入口
    }
    if (target === 'run' || target === 'course') {
      await openWorkout(target)
      return
    }
    if (i < RETRY_MAX) await sleep(RETRY_MS)
  }
}

/** 通知运行时启动（main.ts 装载 init() 时一并挂上，幂等） */
function startNotify(): void {
  if (notifyStarted) return
  notifyStarted = true
  window.addEventListener('rein-open-workout', onOpenWorkout)
  window.addEventListener('rein-workout-resume', onResumeWorkout)
  // 课程没有原生采集，用不需要定位权限的 specialUse 前台服务挡住「切走就被冻结」；
  // 跑步的 location 保活由 run store 自己管（开跑/恢复时拉起，结束即停）
  watch(kind, (k, prev) => {
    if (k === 'course') void trackingService.setKeepalive(true, 'specialUse')
    else if (prev === 'course') void trackingService.setKeepalive(false, 'specialUse')
    void tick() // 起跑/开课的第一帧不等节拍（契约要求 2s 内通知上屏）
  })
  setInterval(() => void tick(), TICK_MS)
}

export const workoutRuntime = {
  init,
  whenReady,
  kind,
  view,
  immersiveRoute,
  pauseActive,
  resumeActive,
  completeCurrentSet,
  enterRunSummary,
  finishCourse,
  discardActive,
}
