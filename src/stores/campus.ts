import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { campusService } from '@/services/campusService'
import { useTodoStore } from '@/stores/todo'
import type {
  AdapterCapabilities,
  CampusAccount,
  CampusCourse,
  CampusLoginInput,
  CampusSemester,
  CampusSession,
  CourseDetail,
  LoginOutcome,
  ScheduleEntry,
  ScheduleView,
  SchoolSystemInfo,
  SyncOutcome,
} from '@/types'
import { todayStr, addDays } from '@/utils/date'

/**
 * 校园教务域 store。
 *
 * 只做三件事：持有课表视图、驱动同步、在同步后让时间线重新加载
 * （课表会写 `todos` 的派生行，不刷新的话首页时间线要等下次进页面才更新）。
 */
export const useCampusStore = defineStore('campus', () => {
  const systems = ref<SchoolSystemInfo[]>([])
  const account = ref<CampusAccount | null>(null)
  const semesters = ref<CampusSemester[]>([])
  const view = ref<ScheduleView | null>(null)

  const loading = ref(false)
  const syncing = ref(false)
  const loggingIn = ref(false)
  /** 最近一次同步的结果，配置页用来展示「18 门课 / 42 个时段」这类回执 */
  const lastSync = ref<SyncOutcome | null>(null)

  const hasAccount = computed(() => account.value !== null)

  /**
   * 当前账号那套教务系统的**能力位**（入口显隐跟着它走，前端不认识厂商）。
   * 未登录 / 系统未知时按「全有」兜底，保持旧客户端行为不变。
   */
  const capabilities = computed<AdapterCapabilities>(() => {
    const kind = account.value?.systemKind
    const sys = kind ? systems.value.find((s) => s.kind === kind) : null
    return (
      sys?.capabilities ?? {
        courseDetail: true,
        program: true,
        lessonSearch: true,
        courseSelect: true,
      }
    )
  })
  const semester = computed(() => view.value?.semester ?? null)
  const courses = computed(() => view.value?.courses ?? [])
  const timeSlots = computed(() => view.value?.timeSlots ?? [])
  const entries = computed(() => view.value?.entries ?? [])

  /** 日期 → 当天所有课（已按开始时间升序，后端保证） */
  const byDate = computed(() => {
    const map = new Map<string, ScheduleEntry[]>()
    for (const e of entries.value) {
      const list = map.get(e.date)
      if (list) list.push(e)
      else map.set(e.date, [e])
    }
    return map
  })

  const currentSemesterId = computed(() => semester.value?.id ?? null)

  function entriesOn(date: string): ScheduleEntry[] {
    return byDate.value.get(date) ?? []
  }

  /**
   * 这一格的**本机档案**（课名 / 代码 / 教师 / 学分 / 类型 / 时间 / 地点 / 周次）。
   *
   * 点开课程格时先把这份交给抽屉，远端详情回来再替换 —— 远端那条路不是每套教务都有：
   * 正方没有「课程详情」接口，树维要现拉整张课表。没有它，点课程要么弹一句「不支持」，
   * 要么对着骨架等一次慢网络，而屏幕上的数据本来就够撑起同一页。
   */
  function localCourseDetail(entry: ScheduleEntry): CourseDetail {
    return offlineCourseDetail(
      entry.session,
      courses.value.find((c) => c.id === entry.session.courseId),
      semester.value?.name ?? '',
    )
  }

  /** 当前学期名 + 第几周，给页头副标题用 */
  const headerSubtitle = computed(() => {
    const s = semester.value
    if (!s) return ''
    return s.currentWeek ? `${s.name} · 第${s.currentWeek}周` : s.name
  })

  async function init(): Promise<void> {
    if (systems.value.length === 0) {
      systems.value = await campusService.systems()
    }
    account.value = await campusService.accountGet()
    if (account.value) {
      semesters.value = await campusService.semesters()
    }
  }

  /** 读一段日期区间的课表。区间由调用方按当前视图算好。 */
  async function loadRange(from: string, to: string, semesterId?: number | null): Promise<void> {
    loading.value = true
    try {
      view.value = await campusService.schedule({ from, to, semesterId: semesterId ?? null })
      account.value = view.value.account
      if (view.value.semester) {
        semesters.value = await campusService.semesters()
      }
    } finally {
      loading.value = false
    }
  }

  async function login(input: CampusLoginInput): Promise<LoginOutcome> {
    loggingIn.value = true
    try {
      const outcome = await campusService.login(input)
      if (outcome.ok) {
        account.value = outcome.account
        semesters.value = await campusService.semesters()
      }
      return outcome
    } finally {
      loggingIn.value = false
    }
  }

  /** 同步课表。成功后刷新时间线 —— 派生日程是写进 todos 的。 */
  async function sync(semesterId?: number | null): Promise<SyncOutcome> {
    syncing.value = true
    try {
      const outcome = await campusService.sync(semesterId ?? currentSemesterId.value)
      lastSync.value = outcome
      account.value = await campusService.accountGet()
      semesters.value = await campusService.semesters()
      await useTodoStore().loadAll()
      return outcome
    } finally {
      syncing.value = false
    }
  }

  /**
   * 会话过期后的静默重登：密码留空，后端会回落到账号里存的那份。
   *
   * 后端自己也会在联网命令里做这件事（见 Rust `commands::recover_session`），
   * 所以这里失败基本只剩两种情况：**没存密码**，或者存的那份也登不上了 ——
   * 两种都必须把用户请到表单里，而不是丢一句「请重新登录」让他自己找。
   */
  async function relogin(): Promise<LoginOutcome> {
    const a = account.value
    if (!a) {
      return {
        ok: false,
        message: '还没有绑定教务系统账号，请先登录一次',
        needCaptcha: false,
        actionRequired: null,
        account: null,
      }
    }
    return login({
      systemKind: a.systemKind,
      baseUrl: a.baseUrl,
      loginName: a.loginName,
      password: '',
      savePassword: a.savePassword,
    })
  }

  async function setCurrentSemester(semesterId: number): Promise<void> {
    await campusService.setCurrentSemester(semesterId)
    await sync(semesterId)
  }

  /** 只清会话；课表快照与已生成的时间线保留为只读快照 */
  async function logout(): Promise<void> {
    await campusService.logout()
    account.value = await campusService.accountGet()
  }

  /** 删账号：课表与派生日程一起清掉 */
  async function removeAccount(): Promise<void> {
    await campusService.accountDelete()
    account.value = null
    semesters.value = []
    view.value = null
    lastSync.value = null
    await useTodoStore().loadAll()
  }

  /** 会话是否还有效；供配置页显示「已过期」状态、同步前预检 */
  async function probeSession(): Promise<boolean> {
    try {
      return await campusService.sessionProbe()
    } catch {
      return false
    }
  }

  return {
    systems,
    account,
    semesters,
    view,
    loading,
    syncing,
    loggingIn,
    lastSync,
    hasAccount,
    capabilities,
    semester,
    courses,
    timeSlots,
    entries,
    byDate,
    currentSemesterId,
    headerSubtitle,
    entriesOn,
    localCourseDetail,
    init,
    loadRange,
    login,
    relogin,
    sync,
    setCurrentSemester,
    logout,
    removeAccount,
    probeSession,
  }
})

/** 课表页默认的时间窗口，与 Rust 侧物化窗口一致（过去一周 + 未来五周） */
export function defaultRange(today = todayStr()): { from: string; to: string } {
  return { from: addDays(today, -7), to: addDays(today, 35) }
}

/**
 * 同步下来的课程 / 时段 → 与远端 `CourseDetail` **同形**的一份档案。
 *
 * 存在的理由：`campus_course_detail` 依赖教务的「课程详情」接口 —— 正方那套没有
 * （适配器直接返回「不支持」），树维那套要现拉一次整张课表（慢，且会话一过期连本机
 * 已有的数据都看不到）。而课表本身同步下来的 `campus_courses` + `campus_sessions`
 * 已经带着课名 / 代码 / 教师 / 学分 / 类型 / 时间 / 地点 / 周次，足够撑起同一页档案。
 *
 * **只填本机真有的字段**：容量、已选人数、学时构成、考试方式这些只有详情接口才给得出，
 * 一律留 null —— 抽屉的排版原则是「空值不占位」，编一个值比留空糟得多。
 * 同理不拿学生自己的院系专业去冒充「开课归属」，那是两个概念。
 */
export function offlineCourseDetail(
  session: CampusSession,
  course: CampusCourse | undefined,
  semesterName: string,
): CourseDetail {
  const weeks = [...session.weeks].sort((a, b) => a - b)
  // **时段级教师优先**：一门课按周换人时（桂电的健康教育四位老师轮着上），课程级那份
  // 是各时段教师的并集 —— 放进「这一节」的档案里会被读成「这一节他们一起上」。
  const teachers = (session.teachers.length > 0 ? session.teachers : (course?.teachers ?? [])).filter(
    Boolean,
  )
  const startUnit = session.startUnit > 0 ? session.startUnit : 0
  return {
    courseName: course?.courseName ?? session.courseName,
    courseCode: course?.courseCode ?? session.courseCode,
    lessonCode: course?.lessonCode ?? null,
    lessonName: course?.lessonName ?? null,
    description: null,
    room: session.room,
    // 楼名落在远端详情里的「教室别名」那一格 —— 抽屉里它正是教室的副行
    roomAlias: session.building,
    campus: session.campus,
    weekday: session.weekday,
    startUnit,
    endUnit: session.endUnit,
    startTime: session.startTime,
    endTime: session.endTime,
    // 与 Rust `detail.rs::big_section_of` 同口径：2 小节 = 1 大节
    bigSection: startUnit > 0 ? Math.ceil(startUnit / 2) : 0,
    weeksStr: session.weeksStr,
    startWeek: weeks[0] ?? null,
    endWeek: weeks[weeks.length - 1] ?? null,
    teachers,
    credits: course?.credits ?? session.credits,
    courseTypeCode: null,
    courseTypeName: course?.courseType ?? session.courseType,
    examCategory: null,
    examType: null,
    courseProperty: null,
    openDepartment: null,
    major: null,
    grade: null,
    semesterName,
    capacity: null,
    enrolled: null,
    hasExperiment: false,
    experimentBatch: null,
    experimentBatchNo: null,
    experimentName: null,
    remark: null,
    period: null,
  }
}

/**
 * 这条错误是不是「教务会话过期」。
 *
 * 判据以 IPC 错误码为准（Rust `ReinError::code = "session_lost"`，后端所有
 * 「需要重新登录」的出口都带着它）；关键词只作兜底 —— 错误被二次包装后码会丢，
 * mock/浏览器模式下的普通 Error 也没有码。前端认它只为一件事：
 * 把「去重新登录」这个动作直接递给用户，而不是让他自己去配置页里找。
 */
export function isSessionLostMessage(err: unknown): boolean {
  const obj = typeof err === 'object' && err !== null ? (err as { code?: unknown; message?: unknown }) : null
  if (obj?.code === 'session_lost') return true
  const msg = obj ? String(obj.message ?? '') : String(err ?? '')
  return (
    msg.includes('会话已过期') ||
    msg.includes('重新登录') ||
    msg.includes('登录已过期')
  )
}
