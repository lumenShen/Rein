/** 校园教务域 IPC 封装 · 对应 modules/campus/commands.rs */
import type {
  CampusAccount,
  CampusLoginInput,
  CampusSemester,
  CourseDetail,
  CourseSelectLesson,
  CourseSelectPoll,
  CourseSelectStatus,
  CourseSelectTicket,
  CurlExport,
  GrabAction,
  GrabIntent,
  GrabPreflight,
  GrabPreview,
  GrabSettings,
  GrabState,
  GrabTargetInput,
  HolidayConfig,
  HolidayConfigView,
  LessonQuery,
  LessonSearchOutcome,
  LoginOutcome,
  ProgramPayload,
  RescueRequest,
  RescueResponse,
  RescueState,
  ScheduleView,
  SchoolDomainProbe,
  SchoolSystemInfo,
  SyncOutcome,
} from '@/types'
import { invoke, isTauri } from './transport'

export const campusService = {
  /** 学校系统选择器的数据源（目前在册：桂电 · 树维 EAMS5） */
  systems: () => invoke<SchoolSystemInfo[]>('campus_systems'),

  accountGet: () => invoke<CampusAccount | null>('campus_account_get'),

  /**
   * 取图形验证码，返回**裸 base64**（不带 `data:` 前缀）。
   * 后端会把本次会话的 Cookie 暂存起来，紧接着的 `login` 必须复用，否则验证码对不上。
   */
  captcha: (systemKind: string, baseUrl: string, loginName: string) =>
    invoke<string>('campus_captcha', { systemKind, baseUrl, loginName }),

  /** 登录。`password` 留空时会回落到账号里已保存的密码（会话过期后的静默重登） */
  login: (input: CampusLoginInput) => invoke<LoginOutcome>('campus_login', { ...input }),

  sessionProbe: () => invoke<boolean>('campus_session_probe'),

  /** 只清会话，保留课表快照与已生成的时间线 */
  logout: () => invoke<void>('campus_logout'),

  /** 删账号：课表快照与派生日程一并清除 */
  accountDelete: () => invoke<void>('campus_account_delete'),

  semesters: () => invoke<CampusSemester[]>('campus_semesters'),

  setCurrentSemester: (semesterId: number) =>
    invoke<void>('campus_set_current_semester', { semesterId }),

  /** 全量同步：校验/恢复会话 → 拉课表 → 落库 → 重建时间线派生行 */
  sync: (semesterId?: number | null) =>
    invoke<SyncOutcome>('campus_sync', { semesterId: semesterId ?? null }),

  /**
   * 读课表。顺带把时间线物化窗口对齐到今天，所以「打开课表」就等于「时间线也是最新的」。
   * 不传 from/to 时后端给「过去一周 + 未来五周」。
   */
  schedule: (opts?: { semesterId?: number | null; from?: string; to?: string }) =>
    invoke<ScheduleView>('campus_schedule', {
      semesterId: opts?.semesterId ?? null,
      from: opts?.from ?? null,
      to: opts?.to ?? null,
    }),

  /** 培养方案原始 JSON（响应很大，后端落 app_meta 缓存；refresh 强制重拉） */
  program: (refresh?: boolean) =>
    invoke<ProgramPayload>('campus_program', { refresh: refresh ?? false }),

  /**
   * 课程详情。**每次实时拉一次课表**组装，不是读库 ——
   * 容量 / 已选人数会随选课进程变化，缓存下来的「已选 51/52」下一秒就可能变成「52/52」。
   *
   * **不是每套教务都有这个接口**（正方直接返回「暂不支持」），所以调用方要先摆上本机
   * 同步下来的那份档案（`stores/campus.ts::offlineCourseDetail`），远端只当加分项 ——
   * 命令本身没有本机兜底能力：它只认教务。
   *
   * `weekday` / `startUnit` 用于同一门课一周上多次时定位到用户点的那一格；
   * `week` 再往前一步：同一门课同一个格子按**周次段**换教师换教室时（健康教育四位老师
   * 轮着上），它决定抽屉里显示「这一周实际上是谁上」。都省略时给该课的第一个时段。
   */
  courseDetail: (input: {
    semesterId: number
    lessonId: number
    weekday?: number | null
    startUnit?: number | null
    week?: number | null
  }) =>
    invoke<CourseDetail>('campus_course_detail', {
      semesterId: input.semesterId,
      lessonId: input.lessonId,
      weekday: input.weekday ?? null,
      startUnit: input.startUnit ?? null,
      week: input.week ?? null,
    }),

  /* ---------------- 官方调休映射（课表 / 时间线共用） ---------------- */

  /**
   * 读调休映射配置与当前生效的映射。顺带补齐缺失年份的官方数据缓存（联网），
   * 所以「进设置页」就等于「数据已就绪」，之后打开课表只读缓存、不发请求。
   */
  holidayConfigGet: () => invoke<HolidayConfigView>('campus_holiday_config_get'),

  /** 写调休映射配置。开关或覆盖一变，后端会立刻重建时间线里的派生行。 */
  holidayConfigSet: (config: HolidayConfig) =>
    invoke<void>('campus_holiday_config_set', { config }),

  /* ---------------- 选课（令牌走 EAMS 会话换取的 SSO JWT） ---------------- */


  /* ---------------- 全校开课查询（与选课批次无关） ---------------- */

  /**
   * **两个域都检测**：分别探明每个域名上有什么。
   *
   * 只打不需要登录的探测点，所以没登录也能问「另一个域到底是什么」。
   * 结果按域名分别汇报，不合并 —— 两个域不是同一套系统。
   */
  lessonSearchProbe: () => invoke<SchoolDomainProbe[]>('campus_lesson_search_probe'),

  /**
   * **全校开课查询**：先在两个域上找这条路，再用找得到的那个域查名单。
   *
   * 与选课的关键区别：**不依赖选课批次** —— 批次没开也能查全校开了哪些课，
   * 这正是提前规划抢什么的依据。
   */
  lessonSearch: (semesterId: number, opts?: { page?: number; pageSize?: number }) =>
    invoke<LessonSearchOutcome>('campus_lesson_search', {
      semesterId,
      page: opts?.page ?? null,
      pageSize: opts?.pageSize ?? null,
    }),
  /** 选课子系统状态：令牌 + 服务器时间 + 学生 + 开放中的批次 */
  courseSelectStatus: () => invoke<CourseSelectStatus>('campus_course_select_status'),

  /** 查询教学班。`query` 省略即全部。字段名见 `LessonQuery`（对齐教务，别改）。 */
  courseSelectLessons: (turnId: string, query?: LessonQuery) =>
    invoke<CourseSelectLesson[]>('campus_course_select_lessons', {
      turnId,
      query: query ?? null,
    }),

  /** 快速抢课用的轻量课程列表（比 query-lesson 少一堆渲染字段） */
  courseSelectSimplestLessons: (turnId: string) =>
    invoke<CourseSelectLesson[]>('campus_course_select_simplest_lessons', { turnId }),

  /** 该批次的查询表单定义。纯展示用，拿不到就当没有，不该挡住查课 */
  courseSelectQueryCondition: (turnId: string) =>
    invoke<unknown>('campus_course_select_query_condition', { turnId }),

  /** 提交选课 → 拿受理回执，结果要轮询 */
  courseSelectApply: (
    turnId: string,
    lessonId: unknown,
    opts?: { virtualCost?: number | null; scheduleGroupId?: unknown },
  ) =>
    invoke<CourseSelectTicket>('campus_course_select_apply', {
      turnId,
      lessonId,
      virtualCost: opts?.virtualCost ?? null,
      scheduleGroupId: opts?.scheduleGroupId ?? null,
    }),

  /**
   * 提交占位（`add-predicate`）：开窗瞬间先占住队列位次，不花意愿值。
   * 结果与正式提交共用同一条轮询命令。
   */
  courseSelectPredicate: (
    turnId: string,
    lessonId: unknown,
    opts?: { scheduleGroupId?: unknown },
  ) =>
    invoke<CourseSelectTicket>('campus_course_select_predicate', {
      turnId,
      lessonId,
      scheduleGroupId: opts?.scheduleGroupId ?? null,
    }),

  /** 轮询选课结果 */
  courseSelectResult: (requestId: string) =>
    invoke<CourseSelectPoll>('campus_course_select_result', { requestId }),

  /** 轮询占位结果 */
  courseSelectPredicateResult: (requestId: string) =>
    invoke<CourseSelectPoll>('campus_course_select_predicate_result', { requestId }),

  /**
   * 退课：意向 → 正式，两条腿在**一次调用**里走完。
   *
   * 与选课不同，这里不把受理号抛给前端：退课是用户明确按下的一个按钮，
   * 中间那个「已登记意向、还没正式退」的状态对用户没有意义，暴露出来只会让人误以为退掉了。
   */
  courseSelectDrop: (
    turnId: string,
    lessonIds: unknown[],
    confirmMidtermRetake?: boolean,
  ) =>
    invoke<CourseSelectPoll>('campus_course_select_drop', {
      turnId,
      lessonIds,
      confirmMidtermRetake: confirmMidtermRetake ?? false,
    }),

  /* ---------------- 自动抢课（后台引擎） ---------------- */

  /**
   * 抢课模块开关（课表的子模块，默认关闭）。
   *
   * 前端的功能开关是权威（`stores/features.ts`），这里把它同步给 Rust 引擎：
   * 关闭后引擎不再探测窗口、不再发任何请求。**开机时也要同步一次**
   * （`App.vue` 里做），否则「上次关着」与「引擎启动时读到什么」可能不一致。
   */
  grabSetEnabled: (enabled: boolean) => invoke<void>('campus_grab_set_enabled', { enabled }),

  grabState: () => invoke<GrabState>('campus_grab_state'),

  /**
   * 加入抢课任务单。
   *
   * `windowWall` 传 `null` 表示「还不知道窗口什么时候开」—— 引擎不会盲撞，
   * 而是每分钟去问一次，拿到时间再精确开火。
   */
  grabEnqueue: (input: {
    turnId: string
    turnName?: string | null
    targets: GrabTargetInput[]
    mode?: 'predicate' | 'direct'
    windowWall?: string | null
    windowEndWall?: string | null
  }) =>
    invoke<number[]>('campus_grab_enqueue', {
      turnId: input.turnId,
      turnName: input.turnName ?? null,
      targets: input.targets,
      mode: input.mode ?? null,
      windowWall: input.windowWall ?? null,
      windowEndWall: input.windowEndWall ?? null,
    }),

  grabTaskAction: (taskId: number, action: GrabAction) =>
    invoke<void>('campus_grab_task_action', { taskId, action }),

  grabClearFinished: () => invoke<number>('campus_grab_clear_finished'),

  grabPauseAll: () => invoke<void>('campus_grab_pause_all'),

  grabResumeAll: () => invoke<void>('campus_grab_resume_all'),

  grabSettingsGet: () => invoke<GrabSettings>('campus_grab_settings_get'),

  grabSettingsSet: (settings: GrabSettings) =>
    invoke<GrabSettings>('campus_grab_settings_set', { settings }),

  /* ---------------- 抢课计划（意向） ----------------
   * 「提前输入 → 到点全自动抢」：计划只是一句模糊查询，解析成具体教学班是引擎的事。 */

  /**
   * 记下一条计划。`turnId` 可以不给（= 用教务当前开放的那个批次）——
   * 提前一晚写计划时，批次往往还没在列表里出现。
   */
  grabIntentAdd: (input: {
    turnId?: string | null
    turnName?: string | null
    query: string
    mode?: 'predicate' | 'direct'
    spread?: boolean
  }) =>
    invoke<GrabIntent>('campus_grab_intent_add', {
      turnId: input.turnId ?? null,
      turnName: input.turnName ?? null,
      query: input.query,
      mode: input.mode ?? null,
      spread: input.spread ?? null,
    }),

  /** 计划的动作：`remove`（移除，连它派出去的任务一起收）/ `now`（立刻重新解析） */
  grabIntentAction: (intentId: number, action: 'remove' | 'now') =>
    invoke<void>('campus_grab_intent_action', { intentId, action }),

  /** 输入预览：这句查询照**教务现在的名单**能匹配到哪些班（顺序就是志愿序） */
  grabIntentPreview: (query: string, turnId?: string | null) =>
    invoke<GrabPreview>('campus_grab_intent_preview', { query, turnId: turnId ?? null }),

  /**
   * 起飞前自检：登录/令牌/批次/时钟/名单/计划逐项给「行不行」+ 证据。
   * 会打几次网络（和预览一个量级），所以是**用户按需触发**的动作。
   */
  grabPreflight: () => invoke<GrabPreflight>('campus_grab_preflight'),

  /* ---------------- 救援面（AI 的最后补救） ----------------
   * 引擎管「一切照常」，这几个命令管「不照常」：教务改了接口、会话怎么都救不回来、
   * 任务卡在一个没见过的错误上。审计与脚本导出都在 Rust 侧一次做掉。 */

  /**
   * 现场快照：账号 + 会话探针 + 抢课引擎整份状态 + 卡住的任务 + 最近 AI 动作。
   * `probe=false` 跳过网络探针（只想看落库状态时用）。
   */
  rescueState: (probe?: boolean) =>
    invoke<RescueState>('campus_rescue_state', { probe: probe ?? true }),

  /**
   * 带会话打一条任意请求。相对路径（`/student/home`）会拼在教务 base 后面。
   *
   * 两条边界（都在 Rust 侧强制）：带凭据的请求只打教务同源；公网地址一律不带凭据、
   * 但过 SSRF 白名单（拒私网/环回）。同一条请求 1 分钟内超过 20 次会熔断。
   */
  rescueHttp: (req: RescueRequest) => invoke<RescueResponse>('campus_http', { req }),

  /** 把一次不带请求的动作写进审计（加任务、重试、改节奏、退课……） */
  rescueNote: (input: { kind: string; summary: string; detail?: unknown }) =>
    invoke<number>('campus_rescue_note', {
      kind: input.kind,
      summary: input.summary,
      detail: input.detail ?? null,
    }),

  /** 导出救援脚本：把这段时间里打过的请求渲染成一份能脱离 App 运行的 `.sh` */
  curlExport: (opts?: { hours?: number; limit?: number }) =>
    invoke<CurlExport>('campus_curl_export', {
      hours: opts?.hours ?? null,
      limit: opts?.limit ?? null,
    }),
}

/* ---------------- 抢课引擎的事件桥 ----------------
 * 与 `voiceService.onAsr` 同一套路：Tauri 里用 `listen`，浏览器里挂到 mock 对象上。
 * 事件名 `campus://grab` 由 Rust 侧 `grab::GRAB_EVENT` 定义，两边必须一致。 */

const grabListeners = new Set<(s: GrabState) => void>()
let grabBridged = false

function dispatchGrab(payload: GrabState): void {
  for (const l of grabListeners) l(payload)
}

async function bridgeGrabEvents(): Promise<void> {
  if (grabBridged) return
  grabBridged = true
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<GrabState>('campus://grab', (e) => dispatchGrab(e.payload))
    return
  }
  const { mockCampus } = await import('@/mock/server')
  mockCampus.onGrab = dispatchGrab
}

/**
 * 订阅抢课引擎的推送。返回取消订阅函数。
 *
 * 页面**必须**在卸载时取消订阅，否则同一份事件会被多次派发（热重载时尤其明显）。
 */
export async function onGrabState(cb: (s: GrabState) => void): Promise<() => void> {
  await bridgeGrabEvents()
  grabListeners.add(cb)
  return () => grabListeners.delete(cb)
}
