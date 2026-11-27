import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { campusService, onGrabState } from '@/services/campusService'
import { ensureNotifyPermission } from '@/services/notifyService'
import type {
  CourseSelectLesson,
  CourseSelectStatus,
  CourseSelectTurn,
  GrabAction,
  GrabIntent,
  GrabPreview,
  GrabSettings,
  GrabState,
  GrabTargetInput,
  GrabTask,
  LessonQuery,
} from '@/types'

/** 轮询节奏与 SPA 一致：每 2 秒一次、最多 10 次（约 20 秒） */
const POLL_INTERVAL_MS = 2000
const POLL_MAX = 10

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 教学班 id 转成路径/参数能用的字符串（后端是不透明值） */
export function idOf(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * 选课域 store。
 *
 * 与 `stores/campus` 分开：那边是课表（读 `campus_sessions`），这边是选课窗口
 * （打 `course-selection-api`），两者的生命周期与失败模式都不一样，
 * 混在一个 store 里会让「课表好好的但选课令牌过期了」这类状态互相污染。
 *
 * **抢课不由这个 store 驱动。** 引擎跑在 Rust 后台线程里（见 `modules/campus/grab.rs`），
 * 这里只做两件事：把任务单读出来显示、把用户的意图发下去。页面关掉，抢课照常进行 ——
 * 这既是有意的设计，也是抢课唯一说得通的做法（窗口往往在用户没盯着屏幕的时候开）。
 *
 * 因此这里的 `grab` 状态有**两个来源**：进页面时 `loadGrab()` 拉一次，
 * 之后全靠 `campus://grab` 事件推送更新。两者同形，所以渲染逻辑只有一份。
 */
export const useCourseSelectStore = defineStore('courseSelect', () => {
  const status = ref<CourseSelectStatus | null>(null)
  const loading = ref(false)
  const error = ref('')

  /** 当前进入的批次 */
  const activeTurn = ref<CourseSelectTurn | null>(null)
  const lessons = ref<CourseSelectLesson[]>([])
  const lessonsLoading = ref(false)
  const keyword = ref('')

  /** 正在提交的教学班 id（防止连点重复提交） */
  const submitting = ref<string | null>(null)
  /** 最近一次提交的进度文案（「已提交，等待教务处理…」这类） */
  const progress = ref('')

  /* ---------------- 多选预定 ----------------
   * 这两个状态原先住在选课页里，页面一卸载就归零。而「勾选顺序就是志愿序」
   * 是这套交互里**唯一不可恢复**的东西：用户按着顺序点了 5 门课，中途切出去看一眼
   * 课表、或者被一个电话打断，回来排好的志愿序就没了，只能从头再点一遍。
   *
   * 所以它跟任务单同一个生命周期，活在 store 里。
   */
  const selectMode = ref(false)
  const selectedIds = ref<string[]>([])

  /** 选中的教学班（按志愿序）。从 `lessons` 现取 —— 名单刷新后不会拿着一份孤儿数据 */
  const selectedLessons = computed(() =>
    selectedIds.value
      .map((id) => lessons.value.find((l) => idOf(l.id) === id))
      .filter((l): l is CourseSelectLesson => !!l),
  )

  function toggleSelect(l: CourseSelectLesson): void {
    const id = idOf(l.id)
    const i = selectedIds.value.indexOf(id)
    if (i >= 0) selectedIds.value.splice(i, 1)
    else selectedIds.value.push(id)
  }

  /**
   * 上移 / 下移一个志愿。
   *
   * 顺序就是志愿序 —— 那它就必须是**可改**的。原先只能靠点按的先后排出来，
   * 点错一步的唯一补救是取消重排，等于把顺序写成了只读。
   */
  function moveSelected(id: string, dir: -1 | 1): void {
    const i = selectedIds.value.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= selectedIds.value.length) return
    const [moved] = selectedIds.value.splice(i, 1)
    if (moved != null) selectedIds.value.splice(j, 0, moved)
  }

  /** 退出多选并清空选择（返回批次列表、批量预定提交之后调用） */
  function exitSelect(): void {
    selectMode.value = false
    selectedIds.value = []
  }

  /* ---------------- 抢课任务单 ---------------- */
  const grab = ref<GrabState | null>(null)
  const grabSettings = ref<GrabSettings | null>(null)
  const grabBusy = ref(false)
  /** 最近一次读取任务单失败的原因；与引擎自身的 grabError 分开，避免把网络失败当成空任务。 */
  const grabLoadError = ref('')
  /** 订阅取消函数。**由 `subscribers` 计数决定何时真的调用**（见 attachGrab） */
  let unlisten: (() => void) | null = null

  const turns = computed(() => status.value?.turns ?? [])
  const hasTurn = computed(() => turns.value.length > 0)
  const serverTime = computed(() => status.value?.serverTime ?? '')

  const grabTasks = computed<GrabTask[]>(() => grab.value?.tasks ?? [])
  /** 正在抢的任务（未结束、未暂停） */
  const activeTasks = computed(() =>
    grabTasks.value.filter((t) => t.status === 'waiting' || t.status === 'running'),
  )
  const hasGrabWork = computed(() => activeTasks.value.length > 0)

  /**
   * **被教务拒了的任务**（参数错误 / 400 / 422）。
   *
   * 它们停在 `needs_ai`：重试不会改变结果，引擎也不该再拿错的参数去骚扰教务。
   * 界面据此给出一句「为什么停了」和一条「交给 AI 排查」的出路。
   */
  const rejectedTasks = computed(() => grabTasks.value.filter((t) => t.status === 'needs_ai'))

  /** 引擎在跑但教务会话掉了 —— 这类故障要显眼地告诉用户去重登 */
  const grabError = computed(() => grab.value?.lastError ?? '')

  /**
   * 距下一次开火还有多久（毫秒）。
   *
   * 直接用后端算好的 `nextFireAt`：墙上时间换算掺了服务器时钟偏差与提前量，
   * 前端再实现一遍必然会漂 —— 那条换算只该有一份。
   */
  function fireInMs(now = Date.now()): number | null {
    const at = grab.value?.nextFireAt
    if (at == null) return null
    return Math.max(0, at - now)
  }

  /** 本地时间与教务服务器时间的偏差（秒）。优先用引擎实测值，它更准也更新。 */
  const clockSkewSec = computed(() => {
    const measured = grab.value?.skewSec
    if (measured != null) return measured
    const t = status.value?.serverTime
    if (!t) return null
    // 教务给的是 `2026-09-17 07:07:57`，按本地时区解析即可（同一台机器上对时）
    const parsed = new Date(t.replace(' ', 'T'))
    if (Number.isNaN(parsed.getTime())) return null
    return Math.round((parsed.getTime() - Date.now()) / 1000)
  })

  /** 某个教学班是否已经在抢课任务单里（按钮据此变成「已加入」） */
  function taskFor(lesson: CourseSelectLesson): GrabTask | null {
    const want = idOf(lesson.id)
    return (
      grabTasks.value.find(
        (t) => idOf(t.lessonId) === want && t.status !== 'cancelled',
      ) ?? null
    )
  }

  async function loadStatus(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      status.value = await campusService.courseSelectStatus()
      // 原来进入的批次如果已经不在列表里（窗口关了），退回列表
      if (activeTurn.value && !turns.value.some((t) => idOf(t.id) === idOf(activeTurn.value!.id))) {
        activeTurn.value = null
        lessons.value = []
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '获取选课状态失败'
      // 保留上一次成功读取的批次与教学班；瞬时刷新失败不应把整个选课面板变成错误空态。
    } finally {
      loading.value = false
    }
  }

  function enterTurn(turn: CourseSelectTurn): void {
    activeTurn.value = turn
    lessons.value = []
    keyword.value = ''
    // 换一个批次 = 换一批教学班，上一批的勾选不可能再被排进任务单
    exitSelect()
  }

  function leaveTurn(): void {
    activeTurn.value = null
    lessons.value = []
    progress.value = ''
  }

  /**
   * 查询教学班。
   *
   * 教务的查询表单里，**课程名、教学班名、教师是三个独立字段**
   * （`courseNameOrCode` / `lessonNameOrCode` / `teacherNameOrCode`，
   * 见 SPA 的 `catchSearch`），而我们的界面只有一个搜索框。
   * 所以同一个关键词**三个字段都发** —— 只发其中一个会让「搜课程名」这类
   * 最常见的用法悄悄搜不到（课程名与教学班名在教务那边本来就不是一回事）。
   */
  async function loadLessons(): Promise<void> {
    const turn = activeTurn.value
    if (!turn) return
    lessonsLoading.value = true
    try {
      const kw = keyword.value.trim()
      const query: LessonQuery = kw
        ? {
            courseNameOrCode: kw,
            lessonNameOrCode: kw,
            teacherNameOrCode: kw,
            sortField: 'lessonAssoc',
            sortType: 'ASC',
          }
        : {}
      const turnId = idOf(turn.id)
      lessons.value = await campusService.courseSelectLessons(turnId, query)

      // 服务器回空了 → 退一步：把全量拉回来，在**本地**按那几个「教务查询里
      // 根本没有的字段」过滤一遍。这是引擎那条拉取阶梯的同一条教条（空了就上升），
      // 只是这里上升的终点是「全量 + 本地过滤」。
      //
      // 为什么非做不可：**项目名与教学班名不在教务的查询字段里**。
      // 体育课的课程名是「大学体育1」、项目名是「羽毛球」，而学生一定会打「羽毛球」——
      // 服务器只会回一段空列表，界面说一句「没查到」，他根本不知道下一步该干什么。
      if (kw && lessons.value.length === 0) {
        const all = await campusService.courseSelectLessons(turnId, {})
        const tokens = kw.toLowerCase().split(/\s+/).filter(Boolean)
        lessons.value = all.filter((l) => {
          const hay = haystackOf(l)
          return tokens.every((t) => hay.includes(t))
        })
      }
    } finally {
      lessonsLoading.value = false
    }
  }

  /**
   * 一键选课：提交 → 按 SPA 的节奏轮询结果。
   *
   * 这是「我现在就想要」的一次性动作；要**自动反复抢**请走 [`enqueue`]，
   * 那条路在 Rust 后台跑，关掉页面也继续。
   */
  async function apply(
    lesson: CourseSelectLesson,
    opts?: { virtualCost?: number | null; scheduleGroupId?: unknown },
  ): Promise<string> {
    const turn = activeTurn.value
    if (!turn) return '请先进入选课批次'

    const lid = idOf(lesson.id)
    if (!lid) return '这门课没有教学班编号，无法提交'
    submitting.value = lid
    progress.value = '正在提交…'
    try {
      const ticket = await campusService.courseSelectApply(idOf(turn.id), lesson.id, {
        virtualCost: opts?.virtualCost ?? null,
        scheduleGroupId: opts?.scheduleGroupId ?? null,
      })
      progress.value = '教务处理中…'

      for (let i = 0; i < POLL_MAX; i++) {
        const r = await campusService.courseSelectResult(ticket.requestId)
        if (!r.pending) {
          if (r.success) {
            await loadLessons()
            return '选课成功'
          }
          if (r.needAttend) {
            return '与已选课程时间冲突，需要在教务网页端办理免听'
          }
          return r.message || '选课未成功，教务未说明原因'
        }
        await sleep(POLL_INTERVAL_MS)
      }
      return '教务迟迟没有返回结果，请稍后到官方选课页确认'
    } finally {
      submitting.value = null
      progress.value = ''
    }
  }

  /* ---------------- 抢课 ---------------- */

  /**
   * 订阅抢课状态推送。
   *
   * **必须引用计数**：看这份状态的有两个人 —— 选课页和全应用常驻的抢课浮条。
   * 早先这里只有一个 `unlisten` 槽位，于是「进过选课页再离开」会把浮条也在用的
   * 那条订阅一起拆掉：监视器从此再不更新，屏幕上永远停在最后一帧
   * （而它显示的是「还在抢」这种**会骗人的**状态）。
   */
  let subscribers = 0
  /** 正在建立订阅的 Promise：两个调用者同时进来时只建一条 */
  let attaching: Promise<void> | null = null

  async function attachGrab(): Promise<void> {
    subscribers += 1
    await refreshGrab()
    if (unlisten) return
    attaching ??= onGrabState((s) => {
      grab.value = s
      grabLoadError.value = ''
    }).then((fn) => {
      unlisten = fn
      attaching = null
    })
    await attaching
  }

  function detachGrab(): void {
    subscribers = Math.max(0, subscribers - 1)
    // 还有人在看就别拆 —— 谁先走都不能把别人的订阅带走
    if (subscribers > 0) return
    unlisten?.()
    unlisten = null
  }

  async function refreshGrab(): Promise<void> {
    try {
      grab.value = await campusService.grabState()
      grabLoadError.value = ''
    } catch (e) {
      grabLoadError.value = e instanceof Error ? e.message : '读取抢课任务失败'
    }
  }

  async function loadGrabSettings(): Promise<void> {
    try {
      grabSettings.value = await campusService.grabSettingsGet()
    } catch {
      /* 设置读不到就用后端默认值，界面留空即可 */
    }
  }

  /**
   * 把课程加入抢课任务单。
   *
   * `windowWall` 从批次的精确区间里取（`selectDateTimeRange` 优先，退化到开窗区间）。
   * 取不到就传 null —— 引擎会进入「等窗口」状态，每分钟去问一次，**不会盲撞**：
   * 盲撞出来的「不在选课时间」会被判成终态，等于预设白费。
   *
   * `groupKey` 给了就是**志愿组**：同组互斥，只会中一个。批量加入时志愿序按
   * 数组顺序从 `priority` 起递增 —— 一次选中多个教学班排成 1/2/3 志愿是最常见的用法。
   */
  async function enqueue(
    lessonsToGrab: CourseSelectLesson[],
    opts?: {
      mode?: 'predicate' | 'direct'
      virtualCost?: number | null
      scheduleGroupId?: unknown
      groupKey?: string | null
      groupName?: string | null
      priority?: number
      /**
       * 目标批次。默认用「当前进入的那个」，但**任务管理页手上没有 activeTurn** ——
       * 它是从任务自己身上读出 turnId 再重排的，所以这里要能显式指定。
       */
      turnId?: string | null
    },
  ): Promise<number> {
    const turn =
      opts?.turnId != null
        ? (turns.value.find((t) => idOf(t.id) === opts.turnId) ?? null)
        : activeTurn.value
    const turnId = opts?.turnId ?? (turn ? idOf(turn.id) : '')
    if (!turnId) throw new Error('请先进入选课批次')
    if (!lessonsToGrab.length) return 0

    const inSquad = !!opts?.groupKey
    const base = opts?.priority ?? 1
    const targets: GrabTargetInput[] = lessonsToGrab.map((l, i) => ({
      lessonId: l.id,
      // 任务行上那一小段能分辨它的文字（项目名优先）—— 不能是 null：
      // 体育课所有项目的课程名一样，任务行只写课程名就认不出哪个是羽毛球
      lessonName: distinctLabel(l),
      courseName: l.course?.nameZh ?? l.course?.nameEn ?? null,
      courseCode: l.course?.code ?? null,
      teacher: teacherText(l),
      credits: l.course?.credits ?? null,
      virtualCost: opts?.virtualCost ?? null,
      // 只有单个教学班时才有「这一门的上课小组」可选；批量加入时用默认组
      scheduleGroupId: opts?.scheduleGroupId ?? null,
      groupKey: opts?.groupKey ?? null,
      groupName: opts?.groupName ?? null,
      priority: inSquad ? base + i : 0,
    }))

    grabBusy.value = true
    try {
      // 窗口时刻从批次对象里取；任务管理页重排时手上只有 turnId，
      // 查不到就传 null —— 引擎会进「等窗口公布」，**不会盲撞**（与既有语义一致）
      const win = turn ? turnWindow(turn) : { start: null, end: null }
      const ids = await campusService.grabEnqueue({
        turnId,
        turnName: turn?.name ?? null,
        targets,
        mode: opts?.mode ?? 'predicate',
        windowWall: win.start,
        windowEndWall: win.end,
      })
      await refreshGrab()
      // 用户刚刚说了「替我抢这门课」—— 这就是问通知权限最自然的时刻：
      // 抢课是唯一一件「你不在场才需要它」的事，而结果得能追到锁屏上。
      // 不 await：权限弹窗不该拖慢入队，浏览器里它直接返回 false。
      void ensureNotifyPermission()
      return ids.length
    } finally {
      grabBusy.value = false
    }
  }

  async function taskAction(taskId: number, action: GrabAction): Promise<void> {
    await campusService.grabTaskAction(taskId, action)
    await refreshGrab()
  }

  async function clearFinished(): Promise<number> {
    const n = await campusService.grabClearFinished()
    await refreshGrab()
    return n
  }

  async function pauseAll(): Promise<void> {
    await campusService.grabPauseAll()
    await refreshGrab()
  }

  async function resumeAll(): Promise<void> {
    await campusService.grabResumeAll()
    await refreshGrab()
  }

  async function saveGrabSettings(next: GrabSettings): Promise<void> {
    grabSettings.value = await campusService.grabSettingsSet(next)
  }

  /* ---------------- 抢课计划（意向） ----------------
   *
   * 计划是「提前输入」的落点：写下一句模糊查询（课名 / 代码 / 教师），
   * 引擎在能看见教学班名单时自己解析成具体的志愿任务，窗口一开就出手。
   * 所以这里**没有「现在抢」这个动作** —— 计划本身不抢，抢是引擎的事。
   */

  const intents = computed<GrabIntent[]>(() => grab.value?.intents ?? [])

  /** 这条计划派出去的任务（按志愿序）。计划行靠它显示「现在抢到哪一步了」。 */
  function intentTasks(intent: GrabIntent): GrabTask[] {
    const keys = (intent.groupKeys ?? []).filter(Boolean)
    if (!keys.length) return []
    return grabTasks.value
      .filter((t) => keys.includes((t.groupKey ?? '').trim()))
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  }

  /** 写下一条计划。返回落库后的那条（状态由引擎随后推进）。 */
  async function addIntent(input: {
    turnId?: string | null
    turnName?: string | null
    query: string
    mode?: 'predicate' | 'direct'
    spread?: boolean
  }): Promise<GrabIntent> {
    grabBusy.value = true
    try {
      const intent = await campusService.grabIntentAdd(input)
      await refreshGrab()
      return intent
    } finally {
      grabBusy.value = false
    }
  }

  async function intentAction(intentId: number, action: 'remove' | 'now'): Promise<void> {
    await campusService.grabIntentAction(intentId, action)
    await refreshGrab()
  }

  /** 预览：这句查询照教务现在的名单能匹配到哪些班。 */
  async function previewMatches(query: string, turnId?: string | null): Promise<GrabPreview> {
    return campusService.grabIntentPreview(query, turnId)
  }

  return {
    status,
    loading,
    error,
    activeTurn,
    lessons,
    lessonsLoading,
    keyword,
    submitting,
    progress,
    selectMode,
    selectedIds,
    selectedLessons,
    toggleSelect,
    moveSelected,
    exitSelect,
    grab,
    grabSettings,
    grabBusy,
    grabLoadError,
    turns,
    hasTurn,
    serverTime,
    clockSkewSec,
    grabTasks,
    activeTasks,
    hasGrabWork,
    rejectedTasks,
    grabError,
    intents,
    intentTasks,
    loadStatus,
    enterTurn,
    leaveTurn,
    loadLessons,
    apply,
    attachGrab,
    detachGrab,
    refreshGrab,
    loadGrabSettings,
    enqueue,
    taskAction,
    clearFinished,
    pauseAll,
    resumeAll,
    saveGrabSettings,
    addIntent,
    intentAction,
    previewMatches,
    taskFor,
    fireInMs,
  }
})

/* ---------------- 纯展示辅助 ---------------- */

/** 教师字段教务给的是对象数组，只取中文名 */
export function teacherText(l: CourseSelectLesson): string | null {
  const names = (l.teachers ?? [])
    .map((t) => {
      const o = t as { nameZh?: string; person?: { nameZh?: string } } | null
      return o?.nameZh ?? o?.person?.nameZh ?? ''
    })
    .filter(Boolean)
  return names.length ? names.join('、') : null
}

/**
 * 这个班**怎么和同门课的其他班区分开** —— 任务行上那一小段能分辨它的文字。
 *
 * 体育课是必须这么做的例子：8 个项目的课程名**全都叫「大学体育1」**，
 * 任务行只写课程名，用户看着自己排的 8 条任务认不出哪条是羽毛球。
 *
 * 顺序「项目名 → 教学班名称」与 Rust `matcher::distinct_label` 一致 ——
 * 两边不一致会让「界面显示的」和「引擎记下的」变成两个东西。
 */
export function distinctLabel(l: CourseSelectLesson): string | null {
  const minor = l.minorCourse?.nameZh ?? l.minorCourse?.nameEn
  if (minor && minor.trim()) return minor.trim()
  const name = l.lessonName
  return name && name.trim() ? name.trim() : null
}

/**
 * 一个教学班所有**能用来搜的文本**拼成一行（小写）。
 *
 * 与教务那三个查询字段（课程名 / 教学班名 / 教师）的差别正是重点：
 * 这里还包含 **项目名**（体育课的「羽毛球」）与**上课时间地点** ——
 * 它们在服务器的查询里根本不存在，只在本地兜底过滤时用得上。
 */
function haystackOf(l: CourseSelectLesson): string {
  const minor = l.minorCourse?.nameZh ?? l.minorCourse?.nameEn ?? ''
  const place: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') place.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk)
  }
  ;(l.scheduleGroups ?? []).forEach((g) => walk(g.dateTimePlace))
  return [
    minor,
    l.lessonName ?? '',
    l.course?.nameZh ?? '',
    l.course?.nameEn ?? '',
    l.course?.code ?? '',
    teacherText(l) ?? '',
    place.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * 批次的窗口时刻。
 *
 * 优先结构化区间（机器可读），退化才去抠 `selectDateTimeText` 里的波浪线 ——
 * 与 Rust 侧 `CourseSelectTurn::opens_at_text` 同一套优先级，两边必须一致，
 * 否则「界面显示的开窗时间」和「引擎实际开火的时刻」会对不上。
 */
export function turnWindow(turn: CourseSelectTurn): { start: string | null; end: string | null } {
  for (const range of [turn.selectDateTimeRange, turn.openDateTimeRange]) {
    const start = range?.startDateTime?.trim()
    if (start) return { start, end: range?.endDateTime?.trim() ?? null }
  }
  const text = turn.selectDateTimeText?.trim()
  if (!text) return { start: null, end: null }
  const [head, tail] = text.split(/[~至—]/)
  return { start: head?.trim() || null, end: tail?.trim() || null }
}

/** 抢课状态的中文标签与语义色（界面与 e2e 共用一份） */
export function grabStatusMeta(t: GrabTask): { label: string; tone: 'run' | 'ok' | 'warn' | 'bad' | 'idle' } {
  if (t.status === 'success') return { label: '已抢到', tone: 'ok' }
  if (t.status === 'conflict') return { label: '需办免听', tone: 'warn' }
  // 请求被教务拒了（参数错误）：重试不会改变结果，下一步是让 AI 看现场、改请求
  if (t.status === 'needs_ai') return { label: '请求被拒', tone: 'warn' }
  if (t.status === 'failed') return { label: '未成功', tone: 'bad' }
  if (t.status === 'cancelled') return { label: '已取消', tone: 'idle' }
  if (t.status === 'paused') return { label: '已暂停', tone: 'idle' }
  // 没结束的：把「在干嘛」讲清楚。顺序要紧 —— `phase` 必须先判，
  // 否则刚交出占位单、正在等受理的任务会显示成「待开抢」（它明明已经出手了）。
  if (t.awaitWindow && !t.windowWall) return { label: '等窗口公布', tone: 'run' }
  // 限流 / 教务服务器出错：引擎**不退避**，正在按节奏继续打 —— 这句话得说出来，
  // 否则用户看到「第 N 次尝试」会以为卡住了，跑去手动重排反而更慢
  if (t.strikeKind === 'throttled') return { label: '教务限速中', tone: 'run' }
  if (t.strikeKind === 'server') return { label: '教务异常中', tone: 'run' }
  if (t.phase === 'poll') return { label: '等教务结果', tone: 'run' }
  if (t.attempts > 0) return { label: `第 ${t.attempts} 次尝试`, tone: 'run' }
  if (t.fireAt != null) return { label: '待开抢', tone: 'run' }
  return { label: '排队中', tone: 'run' }
}
