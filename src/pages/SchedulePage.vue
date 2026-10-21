<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CalendarOff, CalendarX2, ChevronLeft, ChevronRight, GraduationCap, RefreshCw, Settings2, Zap } from 'lucide-vue-next'

import CampusCourseDetailSheet from '@/components/campus/CampusCourseDetailSheet.vue'
import ScheduleDayView from '@/components/campus/ScheduleDayView.vue'
import ScheduleMonthView from '@/components/campus/ScheduleMonthView.vue'
import ScheduleWeekView from '@/components/campus/ScheduleWeekView.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import { useFeaturesStore } from '@/stores/features'
import type { CourseDetail, ScheduleEntry } from '@/types'
import { addDays, addMonths, endOfMonth, fmtDateCn, startOfMonth, todayStr, weekDates } from '@/utils/date'

type ViewKey = 'day' | 'week' | 'month'

const store = useCampusStore()
const router = useRouter()
const toast = useToast()
// 抢课是课表的子模块（默认关闭）：入口卡的显隐问功能开关，不在页面里写死
const features = useFeaturesStore()

const view = ref<ViewKey>('week')
const anchor = ref(todayStr())

const viewOptions: { value: ViewKey; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

/** 当前视图对应的日期区间 —— 只请求要显示的那一段，避免整学期数据来回传 */
const range = computed<[string, string]>(() => {
  const a = anchor.value
  if (view.value === 'day') return [a, a]
  if (view.value === 'week') {
    const days = weekDates(a)
    return [days[0]!, days[6]!]
  }
  return [startOfMonth(a), endOfMonth(a)]
})

const periodLabel = computed(() => {
  const a = anchor.value
  if (view.value === 'day') return fmtDateCn(a)
  if (view.value === 'week') {
    const days = weekDates(a)
    const [s, e] = [days[0]!, days[6]!]
    return `${fmtDateCn(s).replace(/ 周.$/, '')} – ${fmtDateCn(e).replace(/ 周.$/, '')}`
  }
  const d = new Date(a)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
})

const isThisPeriod = computed(() => {
  const t = todayStr()
  const [from, to] = range.value
  return t >= from && t <= to
})

/** 学期是否真的落在当前浏览区间内 —— 区间外不必提示“没课”，那只是寒假/暑假 */
const semesterCovers = computed(() => {
  const s = store.semester
  if (!s) return false
  const [from, to] = range.value
  return from <= s.endDate && to >= s.startDate
})

const showEmpty = computed(() => !store.hasAccount)
const showNoData = computed(() => store.hasAccount && store.entries.length === 0)

async function reload(): Promise<void> {
  const [from, to] = range.value
  await store.loadRange(from, to)
}

function step(dir: -1 | 1): void {
  const a = anchor.value
  if (view.value === 'day') anchor.value = addDays(a, dir)
  else if (view.value === 'week') anchor.value = addDays(a, dir * 7)
  else anchor.value = addMonths(a, dir)
}

function goToday(): void {
  anchor.value = todayStr()
}

function goDay(date: string): void {
  anchor.value = date
  view.value = 'day'
}

/**
 * 打开某一格的教务课程详情。
 *
 * 关键映射：课表格子带的是**本地课程 id**（`campus_courses.id`），而详情命令要的是
 * **远端教学班 id**（`campus_courses.remote_lesson_id`）。两者不是一套编号，
 * 不做这一步映射就会拿着本地自增 id 去教务里问课。
 *
 * 但它**不再是开抽屉的前提**：本机同步下来的课程 / 时段本身就够撑起一页档案
 * （`store.localCourseDetail`），远端详情只负责把容量、已选人数这类实时值补上 ——
 * 正方那套教务根本没有详情接口，少了这份兜底，点课程只能得到一句「不支持」。
 *
 * `weekday`/`startUnit` 一起带上：同一门课一周上多次时，用它定位到用户点的这一格。
 */
const detail = ref<{
  /** 远端教学班 id；本机没有这条映射（课表只同步了一半）时为 null，那就只看本机那份 */
  lessonId: number | null
  weekday: number
  startUnit: number
  name: string
  local: CourseDetail
} | null>(null)

function openDetail(e: ScheduleEntry): void {
  detail.value = {
    lessonId: store.courses.find((c) => c.id === e.session.courseId)?.remoteLessonId ?? null,
    weekday: e.session.weekday,
    startUnit: e.session.startUnit,
    name: e.session.courseName,
    local: store.localCourseDetail(e),
  }
}

async function onSync(): Promise<void> {
  try {
    const r = await store.sync()
    await reload()
    const extra = r.skippedActivities > 0 ? `（${r.skippedActivities} 条考试/非排课已跳过）` : ''
    toast.toast(`${r.semesterName}：${r.courses} 门课 / ${r.sessions} 个时段${extra}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '同步失败'
    // 会话过期且自动重登也没成（多半是没存密码）：直接把入口递到手上，
    // 而不是丢一句「请重新登录」让用户自己找路。传错误对象而非 msg —— 判据优先看错误码
    if (isSessionLostMessage(e)) {
      toast.toast(msg, {
        action: { label: '去重新登录', run: () => void router.push({ name: 'campus-settings' }) },
      })
    } else {
      toast.toast(msg)
    }
  }
}

onMounted(async () => {
  await store.init()
  await reload()
})

watch([view, anchor], reload)
</script>

<template>
  <div class="page">
    <PageHeader title="我的课表" :subtitle="store.headerSubtitle" back>
      <template #action>
        <button
          class="hdr-btn"
          :disabled="store.syncing || !store.hasAccount"
          aria-label="同步课程"
          @click="onSync"
        >
          <RefreshCw :size="19" :class="{ spin: store.syncing }" />
        </button>
        <button class="hdr-btn" aria-label="课表配置与设置" @click="router.push({ name: 'campus-settings' })">
          <Settings2 :size="19" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 空态：还没绑定学校教务系统 -->
    <EmptyState
      v-if="showEmpty"
      :icon="CalendarOff"
      title="还没有课表数据"
      hint="绑定学校教务系统后，课表会自动同步到这里，并写进时间线"
    >
      <template #action>
        <button class="cta" @click="router.push({ name: 'campus-settings' })">去配置</button>
      </template>
    </EmptyState>

    <template v-else>
      <div class="bar">
        <SegmentedControl v-model="view" :options="viewOptions" class="seg" />
        <div class="nav">
          <button class="nv" aria-label="上一段" @click="step(-1)">
            <ChevronLeft :size="17" :stroke-width="2.4" />
          </button>
          <button class="label" :disabled="isThisPeriod" @click="goToday">
            <span class="label-txt">{{ periodLabel }}</span>
          </button>
          <button class="nv" aria-label="下一段" @click="step(1)">
            <ChevronRight :size="17" :stroke-width="2.4" />
          </button>
        </div>
      </div>

      <EmptyState
        v-if="showNoData"
        :icon="CalendarX2"
        :title="semesterCovers ? '这段时间没有课' : '不在本学期内'"
        :hint="semesterCovers ? '换个日期看看，或者回本周' : `当前学期：${store.semester?.name ?? '未设置'}`"
      >
        <template #action>
          <button class="cta" @click="goToday">回到今天</button>
        </template>
      </EmptyState>

      <ScheduleDayView
        v-else-if="view === 'day'"
        :entries="store.entries"
        :date="anchor"
        @select="openDetail"
      />
      <ScheduleWeekView
        v-else-if="view === 'week'"
        :entries="store.entries"
        :time-slots="store.timeSlots"
        :anchor="anchor"
        @select="openDetail"
      />
      <ScheduleMonthView v-else :entries="store.entries" :anchor="anchor" @select="goDay" />

      <!-- 课表下方的常驻入口。
           放在这里而不是只留在「课表配置」里：这两个是**学期尺度**的东西
           （培养方案看四年、抢课看这一两周），用户想起它们的时候多半正看着课表，
           而不是在配置页里找开关。
           「选课 · 抢课」是课表的**子模块**且默认关闭，所以入口跟着开关走。 -->
      <nav class="links">
        <button
          v-if="features.isEnabled('campus-grab')"
          class="link-row"
          @click="router.push({ name: 'campus-course-select' })"
        >
          <i class="pic grab"><Zap :size="17" /></i>
          <span class="col flex-1">
            <b>选课 · 抢课</b>
            <em class="t-3">排好任务单，到点自动抢</em>
          </span>
          <ChevronRight :size="16" class="t-3" />
        </button>
        <button class="link-row" @click="router.push({ name: 'campus-program' })">
          <i class="pic prog"><GraduationCap :size="17" /></i>
          <span class="col flex-1">
            <b>培养方案与学分</b>
            <em class="t-3">学分完成度、课程清单</em>
          </span>
          <ChevronRight :size="16" class="t-3" />
        </button>
      </nav>
    </template>

    <!-- 课程详情抽屉。挂在页面根下而不是 v-else 里：空态/有数据的切换不该让它
         跟着卸载重建 —— 关闭是滑出动画，重建会把「滑到一半的面板」直接抹掉。 -->
    <CampusCourseDetailSheet
      :open="detail !== null"
      :semester-id="store.currentSemesterId"
      :lesson-id="detail?.lessonId ?? null"
      :weekday="detail?.weekday ?? null"
      :start-unit="detail?.startUnit ?? null"
      :fallback-course-name="detail?.name ?? ''"
      :local-detail="detail?.local ?? null"
      @close="detail = null"
    />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶距走 --page-pad-top（手机 12 / 桌面 40），与全库页面同一处来源 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
  display: flex;
  flex-direction: column;
  /* 工具栏、课表、底部入口是三个各自成块的区域，块间取有明显边界的一档（16） */
  gap: var(--gap-lg);
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   这一页是宽形态（desk: 'wide'），构图自负。课表周视图本来就按时段铺满整宽，
   所以只做三件事：把画布收到 --desk-wide（再宽，一周七天就散成一条条细缝）、
   收掉顶部那条被拉长的工具栏、把底部两个入口并排。
   ============================================================ */
.desk-main .page {
  max-width: var(--desk-wide);
  margin-inline: auto;
  gap: var(--desk-gap);
}

/* 顶部工具栏：手机上是「分段控件 132px | 日期导航吃掉剩余」——桌面上那条导航
   会被拉成一条 900px 长的空槽，日期反而挤在正中。改成左分段、右导航，
   导航给 --desk-aside（320px）宽：左右箭头之间正好装下一句「9月1日 – 9月7日」 */
.desk-main .seg {
  margin-right: auto;
}

.desk-main .nav {
  flex: none;
  width: var(--desk-aside);
}

/* 底部两个入口：手机上是一列整宽行（一行只有十来字），桌面上并排成两栏 */
.desk-main .links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--desk-gap);
  margin-top: 0;
}

.bar {
  display: flex;
  align-items: center;
  /* 分段控件与日期导航两块控件相邻，取卡片间一档，窄屏不挤 */
  gap: var(--gap-md);
}

/* ---------- 课表下方的常驻入口 ---------- */
.links {
  display: flex;
  flex-direction: column;
  /* 两行入口本身就是卡片，行间按卡片间距 12，比原来的 8 分得开 */
  gap: var(--gap-md);
  margin-top: var(--gap-tight);
}

.link-row {
  display: flex;
  align-items: center;
  /* 图标 / 文字 / 箭头三段横向间距统一 12 */
  gap: var(--gap-md);
  width: 100%;
  /* 双行入口：左右用列表行的 16，高度对齐双行行高 64 —— 图标 34 不再顶满，
     整行读起来才是一件「可点的行」而不是一个被撑大的按钮 */
  padding: var(--pad-card-tight) var(--pad-card);
  min-height: var(--row-h-double);
  /* 卡片档 16：与页面其它卡片同层级，20 在这里会读成按钮 */
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.link-row:active {
  transform: scale(0.985);
}

.links .pic {
  flex: none;
  width: 34px;
  height: 34px;
  /* 图标底是小尺寸容器，收在小圆角档（原来与卡片同 8，视觉上噪） */
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
}

.links .pic.grab {
  color: var(--accent);
  background: var(--accent-soft);
}

.links .pic.prog {
  color: var(--cat-study, var(--accent));
  background: color-mix(in srgb, var(--cat-study, var(--accent)) 12%, transparent);
}

.links b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.links em {
  font-size: var(--fs-micro);
  font-style: normal;
  /* 主次文本上下 2：1px 在 100% 缩放下等于没有间隙 */
  margin-top: var(--gap-text);
}

.seg {
  flex: none;
  width: 132px;
}

.nav {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  background: var(--surface);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-card);
  padding: var(--sp-2);
  min-width: 0;
}

.nv {
  position: relative;
  flex: none;
  width: 30px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 命中区 44×44，视觉尺寸不动：左右各外扩 7px 刚好吃掉 4px 间隙、
   再压进日期按钮的 4px 内距（文字不从那里开始），不会抢走文字上的点击 */
.nv::after {
  content: '';
  position: absolute;
  inset: -8px -7px;
}

.nv:active {
  transform: scale(0.9);
}

.label {
  position: relative;
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  padding: 0 var(--sp-4);
  text-align: center;
}

/* 省略号必须落在内层：按钮自己若 overflow:hidden，::after 撑出的命中区会被裁掉 */
.label-txt {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 日期按钮只有 28 高：纵向撑到 44，横向本就被整段占满 */
.label::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.label:disabled {
  color: var(--accent-strong);
}

.cta {
  position: relative;
  /* 常规按钮一档：文字 14 + 高 40 + 胶囊，与选课页 / 抢课页的空态出口同一个形状 */
  min-height: var(--control-md);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: var(--sp-8) var(--sp-24);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 40 是按钮视觉档，命中区补到 44（只差 2px，不改变任何布局） */
.cta::after {
  content: '';
  position: absolute;
  inset: -2px 0;
}

.cta:active {
  transform: scale(0.95);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}
</style>
