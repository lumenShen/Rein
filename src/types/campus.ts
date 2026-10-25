/**
 * 校园教务域类型 · 与 Rust `modules/campus` 对应。
 *
 * 一条主线：**学校系统 → 账号 → 学期 → 课程 → 上课时段 → 时间线派生日程**。
 * 这里只放后端真实返回的形状；「周次 → 公历日期」的展开在 Rust 完成
 * （见 `modules/campus/commands.rs::expand_entries`），前端拿到的 `ScheduleEntry`
 * 已经带具体日期，不需要再实现一遍周次换算。
 */

/**
 * 该教务系统实际可用的功能位（Rust `adapters::provider::AdapterCapabilities` 镜像）。
 * 入口显隐跟着它走 —— 前端不认识「哪家厂商缺什么」，只认能力。
 */
export interface AdapterCapabilities {
  /** 课程详情（教学班档案） */
  courseDetail: boolean
  /** 培养方案与学分完成度 */
  program: boolean
  /** 全校开课查询 */
  lessonSearch: boolean
  /** 选课与抢课 */
  courseSelect: boolean
}

/** 学校系统选择器的一项（`campus_systems` 返回） */
export interface SchoolSystemInfo {
  /** 稳定键，落库在 `campus_accounts.system_kind` */
  kind: string
  name: string
  /** 简短校名（摘要入口用） */
  shortName: string
  /** 厂商/产品线，帮用户确认自己学校是不是这一套 */
  vendor: string
  defaultBaseUrl: string
  /** 服务地址输入框下面那句话（每所学校的说法不同，由后端声明） */
  baseUrlHint: string
  /**
   * 登录握手标识：`"supwisdom-portal-rsa"`（树维）/ `"zfsoft-login-rsa"`（正方）。
   * UI 据此决定表单文案与验证码入口 —— 两者的失败模式不一样。
   */
  loginStrategy: string
  /** 培养层次（1 研究生 / 2 本科）。正方没有这个概念，为 null */
  bizTypeId: number | null
  /** 登录过程中可能出现图形验证码，UI 预留验证码位 */
  mayRequireCaptcha: boolean
  /** 实际可用的功能位，入口显隐跟着它走 */
  capabilities: AdapterCapabilities
}

/**
 * 账号。后端**不会**把密码与 Cookie 发到前端，只给两个布尔；
 * 明文凭据全程留在 Rust 侧。
 */
export interface CampusAccount {
  id: number
  systemKind: string
  baseUrl: string
  loginName: string
  /** 是否已保存密码（决定会话过期后能否静默重登） */
  hasPassword: boolean
  /** Cookie jar 里有主票据 */
  loggedIn: boolean
  sessionAt: string | null
  studentId: string | null
  studentCode: string | null
  studentName: string | null
  department: string | null
  major: string | null
  adminclass: string | null
  grade: string | null
  totalCredits: number | null
  savePassword: boolean
  active: boolean
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CampusSemester {
  id: number
  accountId: number
  remoteId: number
  code: string | null
  /** 展示名，如「2026-2027 第一学期」 */
  name: string
  schoolYear: string | null
  season: string | null
  /** `YYYY-MM-DD` —— 周次映射到日历的锚点 */
  startDate: string
  endDate: string
  weekStartOnSunday: boolean
  totalWeeks: number
  currentWeek: number | null
  isCurrent: boolean
}

export interface CampusCourse {
  id: number
  semesterId: number
  remoteLessonId: number
  courseCode: string | null
  courseName: string
  lessonCode: string | null
  lessonName: string | null
  teachers: string[]
  credits: number | null
  courseType: string | null
  /** 教务自带配色（如 `#3B73B6`）；null 时用 `var(--cat-class)` */
  color: string | null
}

/**
 * 一个上课时段（一周里的固定安排）。
 * `weeks` 是**教学周序号**数组，不是公历周；换算成日期由后端的 `ScheduleEntry` 负责。
 */
export interface CampusSession {
  id: number
  courseId: number
  /** 1=周一 … 7=周日（教务口径） */
  weekday: number
  /** 第几节起 / 止 */
  startUnit: number
  endUnit: number
  /** `08:00` —— 教务已算好的真实时刻 */
  startTime: string
  endTime: string
  weeks: number[]
  weeksStr: string | null
  room: string | null
  building: string | null
  campus: string | null
  courseName: string
  courseCode: string | null
  teachers: string[]
  credits: number | null
  courseType: string | null
  color: string | null
}

/** 某一天的调休性质。`off` = 法定放假日（课照上，打「假」标）；`makeup` = 补班日额外挂上的课（打「调」标）。 */
export type HolidayKind = 'off' | 'makeup'

/** 一节课在某个公历日期上的一次发生 */
export interface ScheduleEntry {
  /** `YYYY-MM-DD` */
  date: string
  /** 教学周序号 */
  week: number
  session: CampusSession
  /** 调休性质；普通日 / 功能关闭时为 null */
  holiday: HolidayKind | null
}

/** 调休映射配置（`campus_holiday_config_set` 的入参） */
export interface HolidayConfig {
  /** 总开关，默认开 */
  enabled: boolean
  /** 按日期手动覆盖：日期 → 补星期几（1=周一…7=周日）；值 `0` 表示该日不补课 */
  overrides: Record<string, number>
}

/** 调休映射全貌（`campus_holiday_config_get` 的出参） */
export interface HolidayConfigView extends HolidayConfig {
  /** 当前生效的补班映射（含被覆盖为 `0` 的日期，好让设置页那一行仍在、可改回） */
  makeups: Record<string, number>
  /** 已缓存到本地数据的年份 */
  years: number[]
}

/**
 * 左侧时间轴的一行 —— 由「学校公布的节次表」与「实际排课的节次区间」归一化得到的
 * **互斥片段**（`@/utils/campusTimeAxis` 与 Rust `build_time_axis` 同口径）。
 *
 * 可能是一节（学校给了节次表 → 逐节轴：第1节 08:00-08:40），也可能是若干节的合并
 * （没有节次表时按实际排课区间切）。片段首尾相接、互不重叠：**同一节次只会出现一次**，
 * 课块再按自己占的节次跨行绘制（`grid-row: span N`）。
 *
 * 这是需求里「第几节课那一列要改成实际上课时间」的数据来源：
 * 教务的 `startTime`/`endTime` 已是该片段的真实时刻，不需要前端再维护节次表。
 *
 * 命名避开 `TimeSlot`：nutrition 域已有一个同名类型（运动时段枚举），barrel 会撞。
 */
export interface PeriodSlot {
  /** 片段覆盖的节次区间（行身份） */
  startUnit: number
  endUnit: number
  startTime: string
  endTime: string
  /** 距 00:00 的分钟数，与 `Todo.startMin` 同口径 */
  startMin: number
  /** 真实时长（分钟）—— 行高按它成比例，所以「不对称」看得出来 */
  durationMin: number
}

/** 课表视图（`campus_schedule` 返回）：一次请求带齐渲染所需的一切 */
export interface ScheduleView {
  account: CampusAccount | null
  semester: CampusSemester | null
  entries: ScheduleEntry[]
  timeSlots: PeriodSlot[]
  courses: CampusCourse[]
  /**
   * 库里的时段是**旧规则**写下的（同一门课同一时段的多个周次段被并成了一条），
   * 只有一次真同步能把它们补回来。页面看到它就自动跑那一次（v0.7.4 老库升级用）。
   */
  needsResync: boolean
}

export interface LoginOutcome {
  ok: boolean
  /** 服务端原样返回的提示，失败时展示给用户 */
  message: string | null
  /** 需要图形验证码 */
  needCaptcha: boolean
  /** `change_password` / `reset_password` —— 必须去网页端处理，本地重试无意义 */
  actionRequired: string | null
  account: CampusAccount | null
}

export interface SyncOutcome {
  courses: number
  sessions: number
  /** 写进时间线的派生日程条数 */
  todosWritten: number
  semesterId: number
  semesterName: string
  syncedAt: string
  /** 远端有、但进不了日历的活动数（如纯考试安排） */
  skippedActivities: number
}

export interface CampusLoginInput {
  systemKind: string
  baseUrl: string
  loginName: string
  password?: string
  captcha?: string
  savePassword?: boolean
}

/* ─────────────────── 培养方案（program-info-json 的子集） ───────────────────
 * 那个响应实测 900KB+，我们只取页面真正要用的几段。字段名与教务一致（中文拼音式 camelCase），
 * 不做重命名，方便对照教务页面排查。 */

/** 某个课程模块下按「课程性质」汇总的学分 */
export interface ProgramCreditStat {
  courseProperty: { nameZh: string } | null
  sumCredit: number
  sumPeriod: number
}

/** `creditDistrTable` 是一棵树：一级模块 → 二级模块 →（三级） */
export interface ProgramCreditNode {
  type: { nameZh: string } | null
  /** 本节点自己的学分汇总；一级模块常为空，学分挂在子节点上 */
  courseStatistics: ProgramCreditStat[]
  children?: ProgramCreditNode[] | null
  sumCredit?: number | null
  sumPeriod?: number | null
}

export interface ProgramCourseRef {
  id: number
  nameZh: string
  nameEn?: string | null
  code?: string | null
}

export interface ProgramInfo {
  id: number
  nameZh: string
  grade?: string | null
  department?: { nameZh: string } | null
  major?: { nameZh: string } | null
  education?: { nameZh: string } | null
  cultivateType?: { nameZh: string } | null
  /** 培养方案覆盖的全部课程（实测 100+ 门） */
  courseList?: ProgramCourseRef[] | null
  creditDistrTable?: ProgramCreditNode | null
  printedTime?: string | null
}

export interface ProgramPayload {
  programInfos?: ProgramInfo[] | null
}

/* ─────────────────── 选课（course-selection-api） ───────────────────
 * 注意这一套与课表**不是同一个鉴权**：令牌是拿 EAMS 会话去门户页面换来的 SSO JWT，
 * 详见 modules/campus/course_select.rs 顶部说明。 */

/** 一个选课批次。字段全可选：不同轮次给的不一样，缺字段不该让整个列表挂掉。 */
export interface CourseSelectTurn {
  /** 不透明标识：教务那边可能是数字，路由参数里又是字符串，原样透传 */
  id: unknown
  name?: string | null
  bulletin?: string | null
  /** 当前是否允许进入选课 */
  allowEnter?: boolean
  disallowReasons?: string[]
  openDateTimeText?: string | null
  selectDateTimeText?: string | null
  dropDateTimeText?: string | null
  addRulesText?: string[]
  dropRulesText?: string[]
  /** 精确区间。**抢课的起跑线**：文本字段是给人看的，区间里的 startDateTime 才是机器可读值 */
  openDateTimeRange?: DateTimeRange | null
  selectDateTimeRange?: DateTimeRange | null
  dropDateTimeRange?: DateTimeRange | null
}

/** 教务给的 `{startDateTime, endDateTime}`，形如 `2026-09-17 08:00:00` */
export interface DateTimeRange {
  startDateTime?: string | null
  endDateTime?: string | null
}

export interface LessonCourse {
  id?: unknown
  code?: string | null
  nameZh?: string | null
  nameEn?: string | null
  credits?: number | null
}

export interface LessonSelection {
  status?: string | null
  pinned?: boolean
  needAttend?: boolean
}

export interface ScheduleGroup {
  id?: unknown
  no?: number | null
  default?: boolean
  limitCount?: number | null
  dateTimePlace?: unknown
}

/** 一个教学班。真机上还没有非空样本（批次未开），所以字段一律可选。 */
export interface CourseSelectLesson {
  /** 教学班 id —— 提交选课时的 lessonAssoc */
  id: unknown
  course?: LessonCourse | null
  selectedLesson?: LessonSelection | null
  stdCount?: number | null
  limitCount?: number | null
  teachers?: unknown[]
  /**
   * 教学班名称（如「大学体育1-花江校区-26级（3院、7院、建交院）」）。
   *
   * **院系 / 校区 / 年级只写在这里** —— 课程名是「大学体育1」，
   * 而「3院」在别处一个字段都没有。丢掉它就没法表达「只抢本院系那个班」。
   */
  lessonName?: string | null
  /**
   * 副课程 / 项目名（体育课的「羽毛球」「中华射艺」）。
   *
   * 教务的选课表格正是拿它当上标渲染的：学生嘴里的「我抢羽毛球」，
   * 在字段层面既不是课程名也不是教师 —— 只有这里有。
   */
  minorCourse?: LessonCourse | null
  scheduleGroups?: ScheduleGroup[]
  canSelect?: boolean | null
}

export interface CourseSelectStatus {
  ready: boolean
  reason?: string | null
  /** 教务服务器时间。抢课对时用它，别用本机时钟 */
  serverTime?: string | null
  studentId?: number | null
  studentCode?: string | null
  studentName?: string | null
  /** 开放中的批次；**空数组 = 当前没有选课窗口**，属正常状态 */
  turns: CourseSelectTurn[]
  /** 官方选课页地址（含令牌），出问题时进去核对最省事 */
  entryUrl?: string | null
  /**
   * 当前账号连的是**正式**教务（bkjw）而不是测试域（bkjwtest）。
   * 测试域的风控比正式域松，压出来的速率不能当作正式域的结论。
   */
  production?: boolean
}

/** 一次选课提交的受理回执 */
export interface CourseSelectTicket {
  requestId: string
}

/** 轮询结果：`pending` 时前端隔 2 秒再问，最多 10 次 */
export interface CourseSelectPoll {
  pending: boolean
  success: boolean
  message?: string | null
  /** 与已选课时间冲突，需办理免听 */
  needAttend: boolean
}

/**
 * `query-lesson` 的查询条件对象。
 *
 * 字段来自教务处 SPA 渲染出的表单（由 `query-condition/{turnId}` 定义），
 * **不是随手起的名字** —— 发错键名教务会当成「没有条件」静默返回全量。
 */
export interface LessonQuery {
  courseCode?: string
  courseName?: string
  /**
   * 按**课程名或课程代码**模糊匹配。
   *
   * 注意它与 [`lessonNameOrCode`] 是教务表单里**两个不同的字段** ——
   * 课程（course）与教学班（lesson）在教务那边是两层概念。
   * 界面只有一个搜索框，所以两个都发（外加 `teacherNameOrCode`）。
   */
  courseNameOrCode?: string
  /** 按**教学班名或教学班代码**模糊匹配（与 courseNameOrCode 不是一回事） */
  lessonNameOrCode?: string
  teacherNameOrCode?: string
  campusId?: number
  /** 勾选后每个教学班带回已选人数；抢课要看「满没满」，所以默认带上 */
  hasCount?: boolean
  /** 指定教学班 id 集合时按 id 精确查 */
  ids?: unknown[]
  sortField?: string
  sortType?: string
}

/* ─────────────────── 自动抢课（grab 引擎） ───────────────────
 * 引擎跑在 Rust 后台线程里（见 modules/campus/grab.rs），前端只是**显示器**：
 * 拉一次 `campus_grab_state`，之后靠 `campus://grab` 事件被动更新。
 * 关掉页面不影响任何事 —— 这正是抢课该有的样子。 */

/** 任务的终态集合：到这里引擎就不再碰它了 */
export type GrabTerminalStatus = 'success' | 'failed' | 'conflict' | 'cancelled' | 'needs_ai'
export type GrabStatus = 'waiting' | 'running' | GrabTerminalStatus | 'paused'
/** 过程状态：`status` 说结果如何，`phase` 说现在在干嘛 */
export type GrabPhase = 'idle' | 'submit' | 'poll'
/** 占位优先（推荐）/ 直接提交 */
export type GrabMode = 'predicate' | 'direct'

export interface GrabTask {
  id: number
  /** 列表 / 路径用的批次 id */
  turnId: string
  /**
   * **提交体**用的批次 id（`courseSelectTurnAssoc`）。
   * 来自「进批次」接口的 `options.turn.id`，与 `turnId` 未必相同；
   * 为空时后端会退回 `turnId`（见 Rust `GrabTask::turn_assoc`）。
   */
  turnAssoc?: string | null
  turnName?: string | null
  /** 教学班 id（不透明值） */
  lessonId: unknown
  lessonName?: string | null
  courseName?: string | null
  courseCode?: string | null
  teacher?: string | null
  credits?: number | null
  mode: GrabMode
  virtualCost?: number | null
  scheduleGroupId?: unknown
  /** 教务墙钟时间文本。引擎按服务器偏差换算成本机时刻开火 */
  windowWall?: string | null
  windowEndWall?: string | null
  /** 还不知道窗口什么时候开：引擎会定期去问，而**不会盲撞** */
  awaitWindow: boolean
  /** 占位是否已经交过（占位模式只交一次，之后都是正式请求） */
  predicateDone: boolean
  status: GrabStatus
  phase: GrabPhase
  attempts: number
  polls: number
  /** 连败次数（同类才累加） */
  strikes: number
  strikeKind?: string | null
  requestId?: string | null
  lastMessage?: string | null
  /** 下一次该动它的本机 unix 毫秒 */
  nextAt: number
  /**
   * **开火时刻**（本机 unix 毫秒，已按服务器偏差与提前量校正）。
   * 只读派生值，不落库；倒计时直接用它，前端不要自己再算一遍墙上时间。
   */
  fireAt?: number | null
  queuedAt?: number | null
  finishedAt?: number | null
  /**
   * 志愿组 id。同组是**互斥备选**（时间冲突 / 一轮只能选一门），只会中一个：
   * 任一中选，同组其余立刻取消。没给 / 空串 = 独立任务。
   */
  groupKey?: string | null
  /** 组名（入队时抄一份，纯给人看） */
  groupName?: string | null
  /** 志愿序：1 = 第一志愿，**小的优先**。0 = 不在任何组里 */
  priority?: number
  /**
   * **派生值，不落库**：把它压在待命状态的那个更高优先级任务 id。
   * 界面据此显示「等第 N 志愿」，不要自己再算一遍组内关系。
   */
  heldBy?: number | null
}

/** 批次的轻量摘要 —— 窗口监听的结果 */
export interface GrabTurnBrief {
  id: string
  name?: string | null
  /** 当前是否允许进入 —— 「窗口真的开了」的判据 */
  allowEnter: boolean
  selectText?: string | null
  windowStart?: string | null
  windowEnd?: string | null
}

/** 引擎快照（`campus_grab_state` 的返回，也是 `campus://grab` 事件的负载） */
export interface GrabState {
  alive: boolean
  /** 模块开关：抢课是课表的子模块，默认关闭。关闭时引擎不发任何请求 */
  enabled: boolean
  /** 是否有任务处在非终态 */
  active: boolean
  /** 教务服务器时间（把最近一次采样按偏差推到现在） */
  serverTime?: string | null
  /** 服务器墙钟 − 本机墙钟（秒）。倒计时全靠它校正 */
  skewSec?: number | null
  /** 当前最早的下一次动作时刻（本机 unix 毫秒） */
  nextAt?: number | null
  /** 最近一次开火时刻（本机 unix 毫秒）。界面靠它做倒计时 */
  nextFireAt?: number | null
  /** 引擎级故障（如教务会话失效）：出现时所有任务都会停下等用户处理 */
  lastError?: string | null
  /** 窗口监听的最近结果：教务当前有哪些批次（空 = 窗口还没开） */
  turns?: GrabTurnBrief[]
  /** 最近一次窗口探测的时刻（本机 unix 毫秒） */
  probedAt?: number | null
  /**
   * 抢课计划（意向）。「我想抢什么」写在计划里，「正在抢什么」写在任务里 ——
   * 两者同屏对照，才看得出这条计划现在到底走到哪一步了。
   */
  intents?: GrabIntent[]
  tasks: GrabTask[]
}

/* ─────────────────── 抢课计划（意向） ───────────────────
 * 「提前输入 → 到点全自动抢」的落点：计划只描述意图（一句模糊查询），
 * 具体抢哪个教学班由引擎在能看见名单时解析出来（见 Rust `grab.rs::resolve_intent`）。
 * 所以**窗口开放前就能把计划写好**，不必守着屏幕等批次出现。 */

/** 计划命中的一个教学班（界面靠它回答「会抢哪些班」） */
export interface GrabMatch {
  lessonId: unknown
  courseName?: string | null
  courseCode?: string | null
  teacher?: string | null
  stdCount?: number | null
  limitCount?: number | null
  /** 这门课已经在你名下了（解析时会跳过） */
  picked?: boolean
  /**
   * 命中的字段：`course` / `code` / `teacher` / `place` / `minor`（项目名）/ `lesson`（教学班名），
   * 以及教师的两种强信号：`teacherExact`（**打全了名字 = 指定**）与
   * `teacherNear`（姓对了、其余最多差一个字 = 可能打错了）。
   */
  fields?: string[]
  /**
   * 教学班名称（院系 / 校区 / 年级在里面）。
   *
   * 同门课的几个班**必须能被区分**：体育课 8 个项目的课程名全都叫「大学体育1」，
   * 预览里不写项目名/教学班名，用户看到的是一列认不出来的同一个名字。
   */
  lessonName?: string | null
  /** 项目名（体育课的「羽毛球」这类）—— 候选行优先拿它当标题 */
  minorName?: string | null
}

export type GrabIntentStatus = 'pending' | 'empty' | 'ready' | 'ambiguous'

export interface GrabIntent {
  id: number
  /** 目标批次；null = 用教务当前开放的那个（提前一晚写计划时批次常常还没出现） */
  turnId?: string | null
  turnName?: string | null
  /** 模糊查询：课名 / 课程代码 / 教师，空格分词，每个词都要命中 */
  query: string
  mode: GrabMode
  /** true = 每门课各排一组；false = 全部命中合成一组，只中一个 */
  spread?: boolean
  status: GrabIntentStatus
  /** 解析出来的志愿组 id（任务行靠它归到这条计划下） */
  groupKeys?: string[]
  /** 命中的教学班，**已按志愿序**（前面的先出手） */
  candidates?: GrabMatch[]
  lastMessage?: string | null
  attempts: number
  nextAt: number
  createdAt?: number
  resolvedAt?: number | null
}

/** 一门课的身份（代码 + 课名） */
export interface GrabCourseRef {
  code: string
  name: string
}

/** 输入预览（`campus_grab_intent_preview` 返回） */
export interface GrabPreview {
  turnId: string
  turnName?: string | null
  /** 这个批次教务给了多少教学班 —— 用来区分「教务还没公布」与「没匹配上」 */
  total: number
  /** 模糊匹配命中多少个（**筛选前**）。比 matches 多时说明被「指定教师」筛掉了 */
  matched: number
  /**
   * 真会抢的那些班（顺序就是志愿序）。
   * 注意：**打全了老师名字时这里只剩那位老师的班** —— 那是「指定」而不是「相关」。
   */
  matches: GrabMatch[]
  /**
   * **跨课程的命中**：非空 = 这句查询命中的是好几门课（大一/大二双开的体育课最典型）。
   * 「中一个就够」时引擎**不会排队**，会等你补上课程代码 —— 判定与解析共用同一条规则。
   */
  ambiguous?: GrabCourseRef[]
  /**
   * **放宽匹配的提示**：严格匹到一个都没有、靠丢掉某个词才凑出结果时，这里是那句话。
   * 空 = 严格命中（没放宽）。放宽是为了「零结果」时不白等一个窗口，
   * 但它改动了你写的条件 —— 写「羽毛球 星期四」可能抢到星期一的班，所以必须显示出来。
   */
  relaxNote?: string | null
  /** 为了命中而丢掉的词（原样）。空 = 没丢。 */
  droppedWords?: string[]
  /**
   * 「这份名单是旧的」：教务拉不到时引擎用上一次落盘的那份接着干。
   * 非空 = 名单和名额都可能已经变了。
   */
  lessonsNote?: string | null
}

/** 起飞前自检的一项 —— 每一项都能明确回答「行 / 不行」，`detail` 是证据 */
export interface GrabPreflightItem {
  /** 稳定的键（界面按它归类） */
  key: string
  label: string
  ok: boolean
  /** 证据或原因（总是有内容） */
  detail: string
}

/**
 * 起飞前自检的结果（`campus_grab_preflight` 返回）。
 *
 * 为什么要有它：抢课最贵的一种失败是「**以为在抢，其实早就放弃了**」——
 * 名单没拉到、计划一个班都没匹配上、时钟没测准、窗口已经过去……
 * 这些在任务列表里都长得像「在等待」。
 */
export interface GrabPreflight {
  /** 全部通过才为 true */
  ok: boolean
  items: GrabPreflightItem[]
  /** 一句话总结（给人看的那句） */
  summary: string
}

/** 加入抢课任务单时一门课要带的信息 */
export interface GrabTargetInput {
  lessonId: unknown
  lessonName?: string | null
  courseName?: string | null
  courseCode?: string | null
  teacher?: string | null
  credits?: number | null
  virtualCost?: number | null
  scheduleGroupId?: unknown
  /** 志愿组。三个一起给才成组；不给就是独立任务 */
  groupKey?: string | null
  groupName?: string | null
  priority?: number
}

/**
 * 引擎节奏参数。默认值按「一个学生抢 1–4 门课」标定：
 * 够快（开窗瞬间就出手），又不至于把教务网关打成风控对象。
 * 后端落库前会再收口一次，界面调不出危险值。
 */
export interface GrabSettings {
  /** 两次提交之间的全局最小间隔（毫秒）—— 防封的主要旋钮 */
  minIntervalMs: number
  /** 轮询受理结果的间隔（毫秒） */
  pollIntervalMs: number
  /** 满员后的重试间隔（毫秒）：名额释放是稀疏事件，快没意义 */
  fullRetryMs: number
  /** 出错后的退避基数（毫秒），按连败次数指数增长 */
  backoffMs: number
  maxBackoffMs: number
  /** 提前量（毫秒）：在开窗时刻之前多久出手，用来抵消网络往返 */
  leadMs: number
  /** 单个任务的最大提交次数；0 = 不限（抢课常态） */
  maxAttempts: number
  /** 轮询同一受理单的最大次数，超过就当作结果不明并核对后重投 */
  maxPolls: number
  /**
   * **让贤期限**（毫秒）：当前志愿连续满员超过这么久，就把出手机会让给下一志愿。
   *
   * **0 = 死守（默认）** —— 只有当前志愿进终态或窗口关闭才轮到下一个。
   * 填 `180000` 就是「满员 3 分钟后让贤」。
   */
  cedeAfterMs: number
  /** **窗口监听**：App 开着就每分钟问一次「窗口公布了没有」，即使任务单是空的 */
  watchWindow: boolean
}

/** `campus_grab_task_action` 支持的动作 */
export type GrabAction = 'pause' | 'cancel' | 'retry' | 'remove'

/* ─────────────────── 救援面（AI 的最后补救） ───────────────────
 * 抢课引擎管「一切照常」，这一片管「不照常」：教务改了接口、会话怎么都救不回来、
 * 批次规则换了、任务卡在一个没见过的错误上。对应 Rust `modules/campus/rescue.rs`
 * 与 `commands.rs` 里的 `campus_rescue_state` / `campus_http` / `campus_rescue_note` / `campus_curl_export`。 */

/** AI 对教务/抢课引擎做过的一件事（审计表的一行） */
export interface AiAction {
  id: number
  at: string
  /** `http` / `session` / `grab` / `select` / `script` */
  kind: string
  summary: string
  detail?: unknown
  /** 这条动作对应的可重放 curl（没有请求的动作没有它） */
  curl?: string | null
  status: 'ok' | 'error'
  accountId?: number | null
}

/** 现场快照：一次调用把判读要用到的东西全给出来 */
export interface RescueState {
  account: CampusAccount | null
  /** 会话探针结果；`null` = 没探（probe=false 或没有账号） */
  sessionAlive: boolean | null
  /** 探针本身报错时的原文（区别于「探通了但说会话无效」） */
  sessionError: string | null
  grab: GrabState
  /** 卡住的任务 id —— 只是提示，不是结论（引擎那些刻意等待也会让 nextAt 落在未来） */
  stuckTaskIds: number[]
  recentActions: AiAction[]
}

/** 一条原始请求。相对路径会拼在教务 base 后面 */
export interface RescueRequest {
  url: string
  method?: string
  headers?: [string, string][]
  body?: string | null
  contentType?: string | null
  /** 带教务 Cookie。**只在教务同源生效**：跨域给了也拒（不允许把会话发给第三方） */
  withSession?: boolean
  /** 带选课 SSO 令牌（`Authorization: <JWT>`，裸 token 无 Bearer 前缀） */
  withSelectToken?: boolean
  maxBytes?: number
  /** 人话理由：这条请求想搞清楚什么？写进审计与脚本注释，必填 */
  reason: string
}

export interface RescueResponse {
  url: string
  method: string
  status: number
  ok: boolean
  /** 目标是不是教务同源 —— 决定这条请求带没带凭据 */
  sameOrigin: boolean
  withSession: boolean
  withSelectToken: boolean
  headers: [string, string][]
  body: string
  truncated: boolean
  /** 响应正文字节数（截断前） */
  bytes: number
  elapsedMs: number
  /** 等价 curl（凭据用 `$COOKIE` / `$SELECT_TOKEN` 变量引用） */
  curl: string
  /** 会话失效后已自动重登并重试过一次 */
  healed: boolean
  note?: string | null
}

/** 导出的救援脚本 */
export interface CurlExport {
  path: string
  script: string
  count: number
  generatedAt: string
}

/* ─────────────────────────── 全校开课查询 ─────────────────────────── */

/** 一个候选域名的探测结论（两个域**分别**汇报，不合并） */
export interface SchoolDomainProbe {
  baseUrl: string
  /** 连得上（拿到了 HTTP 状态码，哪怕是 404） */
  reachable: boolean
  /** 开课查询入口在这个域上存在 */
  lessonSearchRoute: boolean
  /** EAMS5 静态资源在这个域上存在 —— 判断「这套系统在不在」最硬的证据 */
  eamsAssets: boolean
  /** 这个域名预期是什么 */
  hint: string
  pageStatus?: number | null
  assetStatus?: number | null
  /** 一句话结论，可直接显示 */
  detail: string
}

/** 开课名单里的一行（字段随教务版本漂移，raw 永远在） */
export interface LessonSearchHit {
  id?: unknown
  course?: { code?: string | null; nameZh?: string | null; credits?: number | null } | null
  nameZh?: string | null
  openDepartment?: unknown
  teacherAssignmentList?: unknown
  timeTableLayout?: unknown
  /** 时间地点的可读文本（教务有时只给结构化数据，那就为空） */
  scheduleText?: string | null
  campus?: unknown
  courseType?: unknown
  examMode?: unknown
  teachLang?: unknown
  roomType?: unknown
  /** 一行原始 JSON —— 教务列名漂移时，靠它当场看出真实列名 */
  raw?: unknown
}

export interface LessonSearchPage {
  hits: LessonSearchHit[]
  page: number
  pageSize: number
  total?: number | null
  /** 响应顶层键名。空列表时靠它区分「教务改了信封」与「确实没开课」 */
  rawKeys: string[]
}

/** 全校开课查询回执：两个域都探测 + 在能用的那个域上查到的名单 */
export interface LessonSearchOutcome {
  domains: SchoolDomainProbe[]
  /** 真正用来查询的域名（null = 两个域都用不了） */
  usedBaseUrl?: string | null
  page: LessonSearchPage
  semesters: CampusSemester[]
}

/* ─────────────────────────── 课程详情 ───────────────────────────
 * 课表上点开一门课看到的完整档案（对应教务网页的「课程详情」页）。
 * 数据由 Rust `modules/campus/detail.rs` 从一次实时拉取的课表组装而成，
 * 字段与教务页面一一对应；教务当前部署不返回的项（说明 / 实验批次号 / 实验名称）为 null。 */

/** 学时构成。各栏缺失即 null，界面按「—」显示 */
export interface CoursePeriod {
  total: number | null
  weeks: number | null
  theory: number | null
  practice: number | null
  test: number | null
  experiment: number | null
  machine: number | null
  design: number | null
  extra: number | null
}

export interface CourseDetail {
  courseName: string
  /** 课程代码（培养方案口径） */
  courseCode: string | null
  /** 课号（教学班代码） */
  lessonCode: string | null
  /** 教学班名（合班时是一长串班级列表） */
  lessonName: string | null
  /** 课程说明。教务当前部署不返回，恒为 null */
  description: string | null
  room: string | null
  /** 教室别名 / 楼名 */
  roomAlias: string | null
  campus: string | null
  /** 1=周一 … 7=周日 */
  weekday: number
  startUnit: number
  endUnit: number
  startTime: string
  endTime: string
  /** 大节节次（2 小节 = 1 大节） */
  bigSection: number
  weeksStr: string | null
  startWeek: number | null
  endWeek: number | null
  teachers: string[]
  credits: number | null
  /** 课程类型代码（如 `BG`） */
  courseTypeCode: string | null
  /** 类型名称（如 `通识必修`） */
  courseTypeName: string | null
  /** 考试类别（如 `考试` / `考查`） */
  examCategory: string | null
  /** 考试方式（如 `统一考试`） */
  examType: string | null
  /** 课程属性（如 `必修`） */
  courseProperty: string | null
  /** 开课院系 */
  openDepartment: string | null
  major: string | null
  grade: string | null
  semesterName: string
  /** 课程容量 */
  capacity: number | null
  /** 已选人数 */
  enrolled: number | null
  hasExperiment: boolean
  /** 实验批次 */
  experimentBatch: number | null
  /** 实验批次号。教务当前部署不返回，恒为 null */
  experimentBatchNo: string | null
  /** 实验名称。教务当前部署不返回，恒为 null */
  experimentName: string | null
  remark: string | null
  period: CoursePeriod | null
}

