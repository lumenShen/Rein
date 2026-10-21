<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  BookOpen,
  Building2,
  CalendarDays,
  ChevronDown,
  Clock,
  GraduationCap,
  MapPin,
  RefreshCw,
  User,
} from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import { campusService } from '@/services/campusService'
import type { CourseDetail, CoursePeriod } from '@/types'

/**
 * 教务课程详情抽屉。
 *
 * 与 `CourseDetailSheet`（课表派生行的本地只读）是两回事：这一份在**远端可用时**的数据
 * 每次打开现拉，字段直接对齐教务「课程详情」页 —— 容量/已选人数在选课期是活的，
 * 缓存一份「51/52」下一秒就可能过时，所以远端详情不落库、不缓存。
 *
 * 但远端那条路**不是每套教务都有**（正方没有详情接口，树维要现拉整张课表），所以：
 * 打开时先把 `localDetail`（本机同步下来的课程 / 时段，见 `stores/campus.ts`）摆上去 ——
 * 抽屉立刻是可读的一页；远端回来再整份替换（容量那类实时值只有它有）。
 * 远端失败或压根没有接口时，就留着本机那份，而不是把已有档案换成一张报错页。
 *
 * 生命周期（动画与请求必须对齐）：
 * - 打开 / 换课时发起请求，带自增 token；关闭时 token 立刻失效，
 *   挂钩中的旧响应回来会被丢弃，不会在下次打开时「诈尸」把内容盖回旧课；
 * - 关闭期间**保留上一份 detail**：抽屉是滑出而非瞬隐，内容若在同一帧清空，
 *   滑出过程会看到正文塌成空白。数据由下一次成功响应替换。
 *
 * ── 排版原则：字段能被图形承载的就不该再写一行「标签 → 值」 ──
 * 教务详情有 31 个字段，早先全摊成两列网格，其中一半值是 `—`：
 * 读起来是一张Excel 截图，而不是一份课程说明。现在改成四条规则：
 *
 * 1. **有轴的画轴**：上课时段用「节次尺」（第几小节落在一天的第几格），
 *    课程周期用「周次尺」（第几周开课）。两把尺子回答的是「这门课什么时候占我的时间」，
 *    比 `开始小节 3 / 结束小节 4` 这种两行数字快一个数量级。
 * 2. **有量的做成数字瓦片**：学分 / 总学时 / 周学时。
 * 3. **空值不占位**：`courseProperty`、`description`、`experimentBatchNo` 等
 *    在当前教务部署上恒为 null。`DASH` 只在**确实出现过又消失**时才显示占位符，
 *    拉回来就是 null 的字段整行不渲染 —— 一屏里六行「—」比没有这六行更糟。
 * 4. **编号类收进二级**：课号 / 课程代码 / 类型代码是查资料时才用得到的标识，
 *    折起来放在末尾，不占首屏。
 */
const props = defineProps<{
  open: boolean
  semesterId: number | null
  /** **远端教学班 id**（`CampusCourse.remoteLessonId`），不是本地 `campus_courses.id` */
  lessonId: number | null
  weekday?: number | null
  startUnit?: number | null
  /**
   * 首帧、慢网时先顶上课程名。
   *
   * 抽屉标题已回落成通用词「课程详情」（课名只在正文 hero 出现一次），
   * 所以这里兜的是 hero 里课名为空的那个角落，不再是标题。
   */
  fallbackCourseName?: string
  /**
   * **本机快照组装的那份档案**（`stores/campus.ts::offlineCourseDetail`）。
   *
   * 先摆它、再等远端：
   * - 树维那套要现拉一次整张课表（慢），让用户对着骨架等几秒没有道理 ——
   *   本机这份的课名 / 教师 / 地点 / 时间 / 周次与远端完全同源，先读起来更好；
   * - 正方那套教务**没有课程详情接口**，这一份就是最终结果；
   * - 会话过期 / 断网时，远端那个错误不该把「本来就有的一页档案」换成一张报错页。
   */
  localDetail?: CourseDetail | null
}>()

const emit = defineEmits<{ close: [] }>()

const detail = ref<CourseDetail | null>(null)
/** 当前摆着的是本机那份（远端还没回来 / 这条教务根本不支持详情接口） */
const usingLocal = ref(false)
const loading = ref(false)
const error = ref('')
/** 请求序号：只认最后一次发出的那个，迟到响应一律丢弃 */
let token = 0

async function load(): Promise<void> {
  const { semesterId, lessonId, weekday, startUnit } = props
  if (!props.open) return
  const t = ++token
  const local = props.localDetail ?? null
  // 本机有的先摆上：抽屉里立刻是可读的一页，远端回来再替换（容量这类实时值只有远端有）。
  // 也顺手让「打开」这件事不再依赖网络 —— 课都摆在那儿了，看不看得见详情与网络无关。
  detail.value = local
  usingLocal.value = local !== null
  error.value = ''
  if (semesterId == null || lessonId == null) {
    // 连远端教学班 id 都没有（课表只同步了一半 / 视图是旧快照）：本机那份就是全部
    loading.value = false
    if (!local) error.value = '这门课还没有同步到教务信息，暂时看不了详情'
    return
  }
  loading.value = local === null
  try {
    const d = await campusService.courseDetail({ semesterId, lessonId, weekday, startUnit })
    if (t !== token) return
    detail.value = d
    usingLocal.value = false
  } catch (e) {
    if (t !== token) return
    // 有本机那份就留着：远端这条路不通（正方没有详情接口 / 会话过期 / 网络抖动）
    // 不是用户要处理的错误，把已有档案换成报错页才是。
    if (!local) {
      detail.value = null
      error.value = e instanceof Error ? e.message : '课程详情获取失败'
    }
  } finally {
    if (t === token) loading.value = false
  }
}

watch(
  () => [props.open, props.semesterId, props.lessonId, props.weekday, props.startUnit] as const,
  () => {
    if (!props.open) {
      // 关闭即作废在途请求，并落掉 spinner；detail 留着给离场动画
      token++
      loading.value = false
      return
    }
    void load()
  },
  { immediate: true },
)

/* ---------- 展示层 ---------- */

const DASH = '—'
const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日']

/** null / 空串统一落成占位符 */
function s(v: string | number | null | undefined): string {
  const t = v == null ? '' : String(v).trim()
  return t === '' ? DASH : t
}

/** 学分可能是 `3` 也可能是 `3.5`：整数不带小数点，非整数保留一位 */
function credits(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/**
 * 首屏标签：课程属性排第一（「必修 / 选修」是选课时最先要读的），
 * 考试方式跟在考试类别后面 —— 两者常成对出现，拆开反而割裂。
 */
const chips = computed(() => {
  const d = detail.value
  if (!d) return []
  return [d.courseProperty, d.courseTypeName, d.examCategory, d.examType].filter(
    (x): x is string => !!x && x.trim() !== '',
  )
})

const teacherText = computed(() => detail.value?.teachers.filter(Boolean).join('、') ?? '')

const place = computed(() => {
  const d = detail.value
  if (!d) return { room: '', alias: '', campus: '' }
  return {
    room: s(d.room) === DASH ? '' : s(d.room),
    alias: s(d.roomAlias) === DASH ? '' : s(d.roomAlias),
    campus: s(d.campus) === DASH ? '' : s(d.campus),
  }
})

/* ---------- 时间：起止时刻 + 时长 ---------- */

/** `'10:25'` → 625。格式不符 / 越界一律 null，绝不猜 */
function toMin(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

/** 跨零点、倒挂、缺一端都算不出来 —— 那就只显示时刻，不显示时长 */
function spanText(from: string | null, to: string | null): string {
  const a = toMin(from)
  const b = toMin(to)
  if (a == null || b == null || b <= a) return ''
  const mins = b - a
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

const timeText = computed(() => {
  const d = detail.value
  if (!d) return { range: '', span: '' }
  const a = s(d.startTime)
  const b = s(d.endTime)
  const range = a === DASH ? b : b === DASH ? a : a === DASH ? b : `${a} – ${b}`
  return { range: range === DASH ? '' : range, span: spanText(d.startTime, d.endTime) }
})

const weekdayText = computed(() => {
  const w = detail.value?.weekday ?? 0
  return w >= 1 && w <= 7 ? `周${WEEK_CN[w - 1]}` : ''
})

/* ---------- 节次尺 ---------- */

/**
 * 一天按 8 小节铺（4 大节 × 2 小节），第 5 小节前是上午、之后是下午 ——
 * 这只是国内高校课表的通行编排，用作**读数的参照栅格**，不是权威数据；
 * 真有超过 8 节的排法，尺子会自己往后长。
 */
const UNITS_PER_DAY = 8

const unitAxis = computed(() => {
  const d = detail.value
  if (!d) return null
  const from = d.startUnit > 0 ? d.startUnit : 0
  const to = d.endUnit > 0 ? d.endUnit : 0
  if (!from && !to) return null
  const total = Math.max(UNITS_PER_DAY, from, to)
  const lo = from || 1
  const hi = to || total
  return {
    lo,
    hi,
    total,
    cells: Array.from({ length: total }, (_, i) => {
      const n = i + 1
      return { n, on: n >= lo && n <= hi, split: n === 5 }
    }),
  }
})

/* ---------- 周次尺 ---------- */

const weekAxis = computed(() => {
  const d = detail.value
  if (!d) return null
  const hi = d.endWeek ?? 0
  const from = d.startWeek ?? 0
  if (!hi && !from) return null
  const total = Math.max(hi, from)
  const lo = from || 1
  return {
    lo,
    to: hi || total,
    total,
    cells: Array.from({ length: total }, (_, i) => ({ n: i + 1, on: i + 1 >= lo })),
  }
})

/* ---------- 容量 ---------- */

const cap = computed(() => {
  const d = detail.value
  if (!d) return null
  const c = d.capacity ?? null
  const e = d.enrolled ?? null
  if (c == null || c <= 0 || e == null) return null
  const left = c - e
  return {
    text: `${e} / ${c}`,
    pct: Math.max(0, Math.min(100, Math.round((e / c) * 100))),
    label: left <= 0 ? '已满' : `余 ${left} 位`,
    full: left <= 0,
    /** 剩不到一成时提个醒：这种课通常就是「要不要去求个免听」的临界点 */
    tight: left > 0 && left / c <= 0.1,
  }
})

/* ---------- 数字瓦片 ---------- */

const stats = computed(() => {
  const d = detail.value
  if (!d) return []
  const p = d.period
  const out: Array<{ k: string; v: string; unit: string }> = []
  // 单位行只放标签给不出的信息：「分」「学时」与标签同词，是撑卡面的废话；
  // 「学时/周」给了标签没有的频次，才留下
  if (d.credits != null) out.push({ k: '学分', v: credits(d.credits), unit: '' })
  if (p?.total) out.push({ k: '总学时', v: String(p.total), unit: '' })
  if (p?.weeks) out.push({ k: '周学时', v: String(p.weeks), unit: '学时/周' })
  return out
})

/* ---------- 学时构成：堆叠条 ---------- */

/**
 * 组成项的颜色取自既有令牌，**不用新造色**。
 * 实际渲染时通常只有 1–2 段非零（理论课就一段），撞色是理论问题；
 * 万一全满，七段的 ΔE 也已按现有三环标准拉开。
 */
const PERIOD_SEGS: Array<{ k: keyof CoursePeriod; label: string; color: string }> = [
  { k: 'theory', label: '理论', color: 'var(--accent)' },
  { k: 'practice', label: '实践', color: 'var(--c-exercise-deep)' },
  { k: 'experiment', label: '实验', color: 'var(--warn)' },
  { k: 'machine', label: '上机', color: 'var(--c-balance)' },
  { k: 'design', label: '设计', color: 'var(--cat-study)' },
  { k: 'test', label: '测验', color: 'var(--danger)' },
  { k: 'extra', label: '其他', color: 'var(--text-3)' },
]

const period = computed(() => {
  const p = detail.value?.period
  if (!p) return null
  const segs = PERIOD_SEGS.map((seg) => ({ ...seg, v: p[seg.k] ?? 0 })).filter((x) => x.v > 0)
  const sum = segs.reduce((a, b) => a + b.v, 0)
  if (sum <= 0) return null
  return {
    sum,
    segs: segs.map((x) => ({ ...x, pct: (x.v / sum) * 100 })),
  }
})

/* ---------- 归属 / 编号 / 长文本 ---------- */

const owner = computed(() => {
  const d = detail.value
  if (!d) return []
  return [
    { ico: Building2, v: s(d.openDepartment) },
    { ico: GraduationCap, v: s(d.major) },
    { ico: BookOpen, v: s(d.grade) },
    { ico: CalendarDays, v: s(d.semesterName) },
  ].filter((x) => x.v !== DASH)
})

/** 编号是查资料时才用得到的标识，折起来，别占首屏 */
const codesOpen = ref(false)
const codes = computed(() => {
  const d = detail.value
  if (!d) return []
  return [
    { k: '课号', v: s(d.lessonCode) },
    { k: '课程代码', v: s(d.courseCode) },
    { k: '类型代码', v: s(d.courseTypeCode) },
  ].filter((x) => x.v !== DASH)
})

/** 长文本：教学班 / 实验安排 / 课程说明 / 课程备注。空的不渲染 */
const notes = computed(() => {
  const d = detail.value
  if (!d) return []
  // 批次是数字字段，教务用 `0` 表示「没排批次」—— 当成有效值会渲染出「实验安排 0」这种
  // 读起来像 bug 的行。判空要连 0 一起算。
  const exp = d.hasExperiment
    ? [
        d.experimentBatch && d.experimentBatch > 0 ? String(d.experimentBatch) : '',
        s(d.experimentName) === DASH ? '' : s(d.experimentName),
      ]
        .filter(Boolean)
        .join(' · ') || '有实验'
    : ''
  return [
    { k: '教学班', v: s(d.lessonName) },
    { k: '实验安排', v: exp },
    { k: '课程说明', v: s(d.description) },
    { k: '课程备注', v: s(d.remark) },
    // 末位再滤两道：① `DASH` 是 s() 的空值产物；② 教务有一批数字字段用 `0` 表达
    // 「没有」，漏进来会渲染出「实验安排 0」这种读起来像 bug 的行。
    // `exp` 为空串时（hasExperiment=false）也走这里，所以空串一并挡掉 —— 只剩标题
    // 没有值的那张卡比不渲染更糟。
  ].filter((x) => x.v !== DASH && x.v !== '0' && x.v !== '')
})
</script>

<template>
  <SheetModal :open="open" title="课程详情" initial-snap="large" @close="emit('close')">
    <!-- 数据来源与实时口径是背景说明：收进标题行右侧的说明入口，
         卡面末尾那行 11px 免责声明撤掉（结论与数值已经都在卡面上） -->
    <template #action>
      <InfoHint title="数据来源">
        <template v-if="usingLocal">
          <p>这份档案来自本机同步下来的课表快照：课程 / 教师 / 地点 / 时间 / 周次 / 学分。</p>
          <p>
            容量、已选人数、学时构成这些只有教务「课程详情」页才有的字段，需要向教务现取 ——
            取到时会自动补上，取不到就不显示（不拿别的数字充数）。
          </p>
        </template>
        <p v-else>数据取自教务系统课表，容量与已选人数为实时值。</p>
      </InfoHint>
    </template>

    <!-- 加载态：首帧没有可展示的旧数据时给骨架，避免抽屉里一片空。
         已经有本机那份档案时不摆骨架 —— 内容是现成的，没有理由先藏起来再显示 -->
    <div v-if="loading && !detail" class="skeleton" aria-busy="true">
      <div class="sk sk-hero" />
      <div class="sk sk-axis" />
      <div class="sk sk-tiles" />
      <div class="sk sk-line" />
      <div class="sk sk-line short" />
    </div>

    <!-- 失败态：把后端原话端上来，给一条重试 -->
    <div v-else-if="error" class="fail">
      <p class="fail-msg">{{ error }}</p>
      <button class="retry" @click="load">
        <RefreshCw :size="15" /> 重试
      </button>
    </div>

    <div v-else-if="detail" class="detail">
      <!-- ═══ 概况：身份 + 时间 + 地点 + 容量，一条轴都不少 ═══ -->
      <section class="hero">
        <!-- 课名只在 hero 出现一次：抽屉标题是通用词「课程详情」，
             同一句话在上下两行各来一遍正是要消除的 -->
        <h3 class="hero-name">{{ detail.courseName || fallbackCourseName }}</h3>

        <div v-if="chips.length" class="chips">
          <span v-for="c in chips" :key="c" class="chip">{{ c }}</span>
        </div>

        <!-- 起止时刻：这里给的是**时刻**，不是又一行「开始时间 / 结束时间」 -->
        <div v-if="timeText.range" class="when">
          <Clock :size="17" class="when-ico" />
          <b class="when-time num">{{ timeText.range }}</b>
          <span v-if="timeText.span" class="when-span">{{ timeText.span }}</span>
        </div>
        <div v-if="teacherText || weekdayText" class="quick">
          <span v-if="teacherText" class="qi">
            <User :size="13" /> {{ teacherText }}
          </span>
          <span v-if="weekdayText" class="qi"><CalendarDays :size="13" /> {{ weekdayText }}</span>
        </div>

        <!-- 地点：教室是主角（找教室是来这里的目的），别名与校区退成副行 -->
        <div v-if="place.room || place.alias" class="where">
          <i class="where-pin"><MapPin :size="15" /></i>
          <span class="where-txt">
            <b>{{ place.room || place.alias }}</b>
            <em v-if="place.room && place.alias">{{ place.alias }}</em>
            <em v-if="place.campus">{{ place.campus }}</em>
          </span>
        </div>

        <!-- 容量：条 + 余位。满员与将满是两种语气，不能只靠颜色区分 -->
        <div v-if="cap" class="cap">
          <div class="cap-row">
            <span>已选 / 容量</span>
            <b class="num" :class="{ tight: cap.tight }">{{ cap.text }}</b>
          </div>
          <div class="cap-bar">
            <i :style="{ transform: `scaleX(${cap.pct / 100})` }" :class="{ full: cap.full, tight: cap.tight }" />
          </div>
          <span class="cap-note" :class="{ full: cap.full }">{{ cap.label }}</span>
        </div>
      </section>

      <!-- ═══ 两把尺子：这门课什么时候占我的时间 ═══ -->
      <section v-if="unitAxis || weekAxis" class="sec">
        <!-- 「1 大节 = 2 小节」与「尺子只是参照栅格」是读这张图的前提，
             但它们是背景口径 —— 收进标题行右侧的说明入口，
             节次那一格面上只留「3–4 小节」这一个读数 -->
        <h4 class="row">
          时间轴
          <InfoHint title="节次尺怎么读">
            <p>一天按 8 小节铺：上午 4 大节、下午 4 大节，1 大节 = 2 小节，第 5 小节起是下午。</p>
            <p>
              这把尺子只是<strong>读数的参照栅格</strong>，不是教务的权威数据 ——
              看懂第几小节落在一天的第几格就够了。
            </p>
          </InfoHint>
        </h4>

        <div v-if="unitAxis" class="axis">
          <div class="axis-head">
            <span class="axis-k">节次</span>
            <b class="axis-v num">{{ unitAxis.lo }}–{{ unitAxis.hi }} 小节</b>
          </div>
          <ol class="cells">
            <li
              v-for="c in unitAxis.cells"
              :key="c.n"
              class="cell"
              :class="{ on: c.on, split: c.split }"
            >
              {{ c.n }}
            </li>
          </ol>
          <div class="axis-legend">
            <span>上午</span>
            <span>下午</span>
          </div>
        </div>

        <div v-if="weekAxis" class="axis">
          <div class="axis-head">
            <span class="axis-k">周次</span>
            <b class="axis-v num">第 {{ weekAxis.lo }} – {{ weekAxis.to }} 周</b>
          </div>
          <ol class="cells thin">
            <li v-for="c in weekAxis.cells" :key="c.n" class="cell" :class="{ on: c.on }">
              {{ c.n }}
            </li>
          </ol>
        </div>
      </section>

      <!-- ═══ 数字瓦片：量级比等宽正文读得快 ═══ -->
      <section v-if="stats.length" class="sec">
        <h4>学分与学时</h4>
        <div class="tiles">
          <div v-for="t in stats" :key="t.k" class="tile">
            <span class="tile-k">{{ t.k }}</span>
            <b class="tile-v num">{{ t.v }}</b>
            <!-- 单位行只在真带新信息时出现（「学时/周」）；与标签同词的不占这一行 -->
            <span v-if="t.unit" class="tile-u">{{ t.unit }}</span>
          </div>
        </div>
      </section>

      <!-- ═══ 归属：院系 / 专业 / 年级 / 学期 ═══ -->
      <section v-if="owner.length" class="sec">
        <h4>开课归属</h4>
        <ul class="owner">
          <li v-for="o in owner" :key="o.v">
            <component :is="o.ico" :size="13" class="owner-ico" />
            <span class="owner-v">{{ o.v }}</span>
          </li>
        </ul>
      </section>

      <!-- ═══ 学时构成：堆叠条 ═══ -->
      <section v-if="period" class="sec">
        <h4>学时构成</h4>
        <div class="bar-wrap">
          <div class="stack">
            <i
              v-for="g in period.segs"
              :key="g.label"
              :style="{ width: `${g.pct}%`, background: g.color }"
            />
          </div>
          <ul class="legend">
            <li v-for="g in period.segs" :key="g.label">
              <i class="dot" :style="{ background: g.color }" />
              {{ g.label }}
              <b class="num">{{ g.v }}</b>
            </li>
          </ul>
        </div>
      </section>

      <!-- ═══ 长文本 ═══ -->
      <section v-if="notes.length" class="sec">
        <h4>补充</h4>
        <ul class="notes">
          <li v-for="n in notes" :key="n.k">
            <span class="note-k">{{ n.k }}</span>
            <span class="note-v">{{ n.v }}</span>
          </li>
        </ul>
      </section>

      <!-- ═══ 编号：二级，默认折起 ═══ -->
      <section v-if="codes.length" class="sec">
        <button class="disclosure" :aria-expanded="codesOpen" @click="codesOpen = !codesOpen">
          <ChevronDown :size="14" :class="{ flip: codesOpen }" />
          课程编号
          <span class="disclosure-n num">{{ codes.length }}</span>
        </button>
        <ul v-if="codesOpen" class="codes">
          <li v-for="c in codes" :key="c.k">
            <span class="code-k">{{ c.k }}</span>
            <b class="code-v num">{{ c.v }}</b>
          </li>
        </ul>
      </section>
    </div>
  </SheetModal>
</template>

<style scoped>
/* ══════════════ 概况 ══════════════ */
.detail {
  display: flex;
  flex-direction: column;
  /* 半模态内部块之间 12（参照：块与块之间 12，靠嵌套浅井分层、不用分割线） */
  gap: var(--gap-md);
}

.hero {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  /* 内部块配方：radius 16 + padding 12 + 浅井底 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-inset);
}

.hero-name {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: var(--lh-title);
  word-break: break-all;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  /* 同一组胶囊内 4（参照的胶囊分组配方） */
  gap: var(--gap-tight);
}

.chip {
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  /* --accent 压 --surface-2 只有 4.27:1，浅底上的文字蓝得用 strong 档 */
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  /* 胶囊左右 12（--pad-inline）：与全库胶囊一档 —— 10 会让四枚并排的标签读成挤在一起 */
  padding: var(--sp-2) var(--pad-inline);
}

/* 起止时刻：抽屉里最大的一个数字，它回答「几点到几点」 */
.when {
  display: flex;
  align-items: baseline;
  gap: var(--sp-8);
  flex-wrap: wrap;
}

.when-ico {
  align-self: center;
  flex: none;
  color: var(--text-3);
}

.when-time {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  letter-spacing: -0.01em;
  line-height: var(--lh-title);
}

.when-span {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  background: var(--surface);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-8);
}

.quick {
  display: flex;
  flex-wrap: wrap;
  /* 组内 4、行间 12：一排「谁在教 / 在哪 / 多少人」的细项 */
  gap: var(--gap-tight) var(--gap-md);
}

.qi {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-caption);
}

/* 地点：找教室是打开这个抽屉最常见的理由，所以给它一整块 */
.where {
  display: flex;
  align-items: center;
  gap: var(--sp-12);
  /* 四边等距 12：它是 hero 里的一块二级面，边距不对称就只是一块色斑 */
  padding: var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface);
}

.where-pin {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.where-txt {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-4) var(--sp-8);
  min-width: 0;
}

.where-txt b {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.where-txt em {
  font-size: var(--fs-micro);
  font-style: normal;
  color: var(--text-3);
  line-height: var(--lh-caption);
}

/* ══════════════ 容量 ══════════════ */
.cap {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: var(--sp-4) var(--sp-8);
}

.cap-row {
  display: contents;
}

.cap-row > span {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.cap-row b {
  font-size: var(--fs-caption);
  color: var(--text-1);
  text-align: right;
}

.cap-row b.tight {
  color: var(--warn-strong);
}

.cap-bar {
  grid-column: 1 / -1;
  height: 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-3) 16%, transparent);
  overflow: hidden;
}

.cap-bar i {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: left center;
  border-radius: inherit;
  background: var(--accent);
  transition: transform var(--dur-base) var(--ease-standard);
}

.cap-bar i.tight {
  background: var(--warn);
}

.cap-bar i.full {
  background: var(--danger);
}

/* 余位是「要不要选这门课」的关键读数：11px 可以留，颜色必须读得出来 ——
   --text-3 只有 3.6:1，常态提到 --text-2，与「已满」的 --danger-strong 组成同一条语气 */
.cap-note {
  grid-column: 1 / -1;
  justify-self: end;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.cap-note.full {
  color: var(--danger-strong);
}

/* ══════════════ 区块 ══════════════ */
.sec {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
}

.sec h4 {
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  color: var(--text-3);
  letter-spacing: 0.04em;
  padding: 0 var(--sp-2);
}

/* 标题行带说明入口的：? 贴到行右端，与标题同行居中 */
.sec h4.row {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
}

.sec h4.row .info-hint {
  margin-left: auto;
}

/* ══════════════ 尺子 ══════════════ */
.axis {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-inset);
}

.axis-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-8);
}

.axis-k {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.axis-v {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.cells {
  display: flex;
  gap: var(--sp-4);
  list-style: none;
  margin: 0;
  padding: 0;
}

.cell {
  flex: 1 1 0;
  min-width: 0;
  display: grid;
  place-items: center;
  height: 24px;
  border-radius: var(--radius-xs);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  background: color-mix(in srgb, var(--text-3) 9%, transparent);
}

/* 上午 / 下午之间留一道缝：分界是读数的一部分，不能只靠序号 4→5 隐含 */
.cell.split {
  margin-left: var(--sp-8);
}

.cells.thin .cell {
  height: 18px;
  font-size: var(--fs-micro);
}

.cell.on {
  font-weight: var(--fw-bold);
  color: var(--on-accent);
  background: var(--accent);
}

.axis-legend {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ══════════════ 数字瓦片 ══════════════ */
/* 瓦片按内容宽度排，**不为了填空把孤零零的一格拉成整行**：本机那份档案通常只有
   「学分」一个读数（总学时 / 周学时只有教务详情页给得出），拉满整行看起来像渲染坏了；
   而三格时它们仍然铺满一行。 */
.tiles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-8);
}

.tile {
  flex: 1 1 84px;
  max-width: 132px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  /* 上下 12 / 左右 8：三枚瓦片并排时左右 6 会让数字贴到边上 */
  padding: var(--sp-12) var(--sp-8);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.tile-k {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.tile-v {
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
  line-height: var(--lh-display);
  color: var(--text-1);
}

.tile-u {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ══════════════ 归属 ══════════════ */
.owner {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  list-style: none;
  margin: 0;
  padding: 0;
  /* 抽屉内的一组行：容器 16，行与行之间 1px 分隔线（下面那条） */
  border-radius: var(--radius-m);
  overflow: hidden;
  background: var(--line);
}

.owner li {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  /* 行内距 12：这一组是「同一张卡里的行」，四边等距 */
  padding: var(--sp-12);
  background: var(--surface-2);
  min-width: 0;
}

.owner-ico {
  flex: none;
  color: var(--text-3);
}

.owner-v {
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  line-height: var(--lh-caption);
  word-break: break-all;
}

/* ══════════════ 学时构成 ══════════════ */
.bar-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-inset);
}

.stack {
  display: flex;
  height: 10px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: color-mix(in srgb, var(--text-3) 12%, transparent);
}

.stack i {
  height: 100%;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4) var(--sp-12);
  list-style: none;
  margin: 0;
  padding: 0;
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.legend .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.legend b {
  color: var(--text-1);
  font-weight: var(--fw-bold);
}

/* ══════════════ 长文本 ══════════════ */
.notes {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  list-style: none;
  margin: 0;
  padding: 0;
  border-radius: var(--radius-m);
  overflow: hidden;
  background: var(--line);
}

.notes li {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  /* 行内距 12：这一组是「同一张卡里的行」，四边等距 */
  padding: var(--sp-12);
  background: var(--surface-2);
}

.note-k {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.note-v {
  font-size: var(--fs-caption);
  color: var(--text-1);
  line-height: var(--lh-body);
  word-break: break-all;
}

/* ══════════════ 编号折叠 ══════════════ */
.disclosure {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  padding: 0 var(--sp-2);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.disclosure svg {
  transition: transform var(--dur-fast) var(--ease-standard);
}

.disclosure svg.flip {
  transform: rotate(180deg);
}

.disclosure-n {
  margin-left: auto;
  font-weight: var(--fw-semibold);
  letter-spacing: 0;
}

.codes {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  list-style: none;
  margin: 0;
  padding: 0;
  border-radius: var(--radius-m);
  overflow: hidden;
  background: var(--line);
}

.codes li {
  display: flex;
  align-items: baseline;
  gap: var(--sp-12);
  padding: var(--sp-8) var(--sp-12);
  background: var(--surface-2);
}

.code-k {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.code-v {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  word-break: break-all;
}

.src {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-body);
  padding: 0 var(--sp-2);
}

/* ══════════════ 骨架 ══════════════ */
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
}

.sk {
  border-radius: var(--radius-m);
  background: linear-gradient(
    100deg,
    var(--surface-2) 30%,
    color-mix(in srgb, var(--text-3) 12%, var(--surface-2)) 50%,
    var(--surface-2) 70%
  );
  background-size: 220% 100%;
  animation: shimmer 1.3s linear infinite;
}

.sk-hero {
  height: 168px;
}

.sk-axis {
  height: 106px;
}

.sk-tiles {
  height: 72px;
  border-radius: var(--radius-m);
}

.sk-line {
  height: 34px;
}

.sk-line.short {
  width: 62%;
}

@keyframes shimmer {
  from {
    background-position: 140% 0;
  }
  to {
    background-position: -40% 0;
  }
}

/* ══════════════ 失败 ══════════════ */
.fail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-12);
  padding: var(--sp-40) var(--sp-20);
}

.fail-msg {
  font-size: var(--fs-callout);
  color: var(--text-2);
  text-align: center;
  line-height: var(--lh-body);
}

.retry {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: var(--sp-12) var(--sp-24);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.retry:active {
  transform: scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
  .sk {
    animation: none;
  }

  .cap-bar i {
    transition: none;
  }

  .disclosure svg {
    transition: none;
  }
}
</style>
