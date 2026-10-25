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

/**
 * 回到本段的快捷标签 —— 只在**已经离开本段**时出现。
 * 三个视图的「本段」不是同一个词：日视图回今天、周视图回本周、月视图回本月，
 * 写成一句「回到本周」放在日视图里会读成「跳到本周的某一天」，语义是错的。
 */
const backLabel = computed(() => (view.value === 'day' ? '今天' : view.value === 'month' ? '本月' : '本周'))

/** 学期是否真的落在当前浏览区间内 —— 区间外不必提示“没课”，那只是寒假/暑假 */
const semesterCovers = computed(() => {
  const s = store.semester
  if (!s) return false
  const [from, to] = range.value
  return from <= s.endDate && to >= s.startDate
})

const showEmpty = computed(() => !store.hasAccount)
const showNoData = computed(() => store.hasAccount && store.entries.length === 0)

/**
 * 「没课」有三种，说法必须分开 —— 用户下一步要做的事完全不同：
 * 1. 不在本学期内：翻错日期了 → 回本周；
 * 2. 本学期没有排课：教务还没出课表 / 同步没跑 → 去配置页重同步；
 * 3. 这一段没有：学期有课，只是这一周/这一天没排 → 换个日期看看。
 * 判据取「本学期课程表是否为空」（courses 是整学期清单，不受当前区间过滤）。
 */
const emptyCase = computed<'outOfTerm' | 'noCourses' | 'noEntries'>(() => {
  if (!semesterCovers.value) return 'outOfTerm'
  return store.courses.length === 0 ? 'noCourses' : 'noEntries'
})

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
  /** 这一格的教学周：同一门课按周次段换教师时，抽屉要跟着格子走 */
  week: number
  name: string
  local: CourseDetail
} | null>(null)

function openDetail(e: ScheduleEntry): void {
  detail.value = {
    lessonId: store.courses.find((c) => c.id === e.session.courseId)?.remoteLessonId ?? null,
    weekday: e.session.weekday,
    startUnit: e.session.startUnit,
    week: e.week,
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

/**
 * 老库自愈（v0.7.4）。
 *
 * 修之前「同一门课 + 同一个星期几 + 同一个节次」只存得下一条：桂电会把一门课按**周次段**
 * 拆成多条（教师、教室跟着段走），后写的那条把先写的周次/教师覆盖掉 —— 课表上就少课、
 * 教师张冠李戴。被并掉的那些周次**只能从教务重新拉一遍**才补得回来，所以后端在迁移时
 * 留了个标记（`needsResync`），这里替用户跑那一次；同步落库后标记自动清掉，再来就只有一遍。
 *
 * 三条自律：
 * 1. **只做一次**：标记是后端的，跑成功就没了，不存在反复联网；
 * 2. **不挡渲染**：现有课表先画出来，同步在后台跑，结束后 `onSync` 自己重读；
 * 3. **失败不弹框**：没网 / 会话过期且没存密码时标记留着，下次进页面再试，
 *    用户不该为一次自愈看一眼对话框。
 */
async function healLegacyData(): Promise<void> {
  if (!store.view?.needsResync || !store.hasAccount || store.syncing) return
  toast.toast('课表按教务的新规则重新同步中…')
  await onSync()
}

onMounted(async () => {
  await store.init()
  await reload()
  await healLegacyData()
})

watch([view, anchor], reload)
</script>

<template>
  <!-- 周视图是「一屏一张表」：页面高度锁一屏，网格才分得到剩余高度（见 .fit-h）。
       日 / 月视图是普通内容流，跟着内容长，装不下时整页滚。 -->
  <div class="page" :class="{ 'fit-h': view === 'week' && !showEmpty && !showNoData }">
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
      <!-- 一条工具行：视图切换在左、日期步进在右，同高（32）同圆角。
           它们改的是同一件事（在看哪一段），分成两个高度、两套圆角的控件时，
           读起来像两组互不相干的东西。回到本段的快捷键只在离开本段后出现 ——
           已经在本段时它没有可做的事，占着位置只会挤掉日期。 -->
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
          <button v-if="!isThisPeriod" class="back" @click="goToday">{{ backLabel }}</button>
        </div>
      </div>

      <EmptyState
        v-if="showNoData"
        :icon="CalendarX2"
        :title="
          emptyCase === 'outOfTerm'
            ? '不在本学期内'
            : emptyCase === 'noCourses'
              ? '本学期还没有课表'
              : '这段时间没有课'
        "
        :hint="
          emptyCase === 'outOfTerm'
            ? `当前学期：${store.semester?.name ?? '未设置'}`
            : emptyCase === 'noCourses'
              ? '教务那边还没排课，或者同步没跑完 —— 去配置页重新同步一次'
              : '换个日期看看，或者回本周'
        "
      >
        <template #action>
          <button v-if="emptyCase === 'noCourses'" class="cta" @click="router.push({ name: 'campus-settings' })">
            去重新同步
          </button>
          <button v-else class="cta" @click="goToday">回到今天</button>
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
           「选课 · 抢课」是课表的**子模块**且默认关闭，所以入口跟着开关走；
           两个入口都按教务系统的能力位显隐（正方那套没有这两个接口）。 -->
      <nav
        v-if="store.capabilities.program || (features.isEnabled('campus-grab') && store.capabilities.courseSelect)"
        class="links"
      >
        <button
          v-if="features.isEnabled('campus-grab') && store.capabilities.courseSelect"
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
        <button v-if="store.capabilities.program" class="link-row" @click="router.push({ name: 'campus-program' })">
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
      :week="detail?.week ?? null"
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
  /* 手机壳是**文档滚动**：页面至少一屏高，空态与短内容也把底部入口压到该在的位置 */
  min-height: calc(100dvh - var(--safe-top));
}

/* 周视图专用：高度**确定**才谈得上「把剩余高度分给课表」。
   用 min-height 时页面高度由内容反推，弹性子项分不到剩余空间，
   课表会撑成两倍高、底部两条入口被 Dock 压住；定高后网格吃剩余，入口落在它之后。 */
.page.fit-h {
  height: calc(100dvh - var(--safe-top));
}

/* 内容层继承 .page 的弹性列，还要自己吃满剩余高度（base.css 只镜像布局，不给弹性系数） */
.rubber-layer {
  flex: 1;
  min-height: 0;
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
  /* 桌面主人区（.desk-main）自己就是滚动容器：页面撑满它的可视高度即可，
     不必再把 100dvh 当参照（那样会多算一层窗口标题栏） */
  min-height: 100%;
}

/* 桌面周视图同样要一个**确定高度**，课表才分得到剩余空间。
   这里不能用 100%：页面的父级是壳层那个 [data-rubber-shell] 空壳（高度 auto），
   百分比会退化成 auto。改从视口算，并扣掉无边框窗口里那条自绘标题栏（--titlebar-h，
   浏览器预览里没有它，页面会矮 40 —— 那 40 是底色，不承载内容）。 */
.desk-main .page.fit-h {
  height: calc(100dvh - var(--titlebar-h));
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
  /* 同高（32）是这一行唯一的几何约束：两块控件都锁在这个高度上 */
  height: var(--sp-32);
}

/* ---------- 课表下方的常驻入口 ---------- */
.links {
  display: flex;
  flex-direction: column;
  /* 两行入口本身就是卡片，行间按卡片间距 12，比原来的 8 分得开 */
  gap: var(--gap-md);
  /* 与课表之间由 .page 的块间间距给出（16），这里不再叠一层边距 */
  margin-top: 0;
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
  /* 三段单字（日 / 周 / 月）：108 = 36 一段，比原来的 132 省下 24 给日期读数 */
  width: calc(var(--sp-36) * 3);
  /* 与右侧日期导航同圆角 —— 两个容器一左一右贴着，圆角不同就会读成两组控件 */
  border-radius: var(--radius-s);
}

/* 日期导航与分段控件同高同圆角：32 / 8。内缩 2 让箭头与容器边缘等距，
   与分段控件轨道里滑块的内缩是同一档 */
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
  height: var(--sp-32);
}

.nv {
  position: relative;
  flex: none;
  width: var(--sp-28);
  height: var(--sp-28);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 圆形箭头钮：与胶囊容器里的「一格」区分开，它是一次步进而不是一个选项 */
  border-radius: var(--radius-full);
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 命中区 44×44，视觉尺寸不动：左右各外扩 8 刚好吃掉 4px 间隙、
   再压进日期按钮的 4px 内距（文字不从那里开始），不会抢走文字上的点击 */
.nv::after {
  content: '';
  position: absolute;
  inset: -8px;
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

/* 已经在本段时：日期按钮刷 accent，充当「你在这里」的锚点（此时右侧的
   「回到本段」胶囊不显示，工具行里只有这一处强调色，不会打架）。 */
.label:disabled {
  color: var(--accent-strong);
}

/* 回到本段的胶囊：24 高（--chip-h）、full 圆角，落在导航轨的 28 内高里。
   accent-soft 上的文字走 accent-strong —— --accent 压浅蓝底达不到 AA。 */
.back {
  flex: none;
  position: relative;
  height: var(--chip-h);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
  background: var(--accent-soft);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 24 高的胶囊：纵向补到 44 的命中区（导航轨本身只有 32，热区溢出去不改变布局） */
.back::after {
  content: '';
  position: absolute;
  inset: -10px -4px;
}

.back:active {
  transform: scale(0.94);
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
