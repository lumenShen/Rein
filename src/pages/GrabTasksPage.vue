<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  Ban,
  Check,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-vue-next'

import GrabTaskEditSheet from '@/components/campus/GrabTaskEditSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import { useToast } from '@/composables/useToast'
import { useTwoStepConfirm } from '@/composables/useTwoStepConfirm'
import { grabStatusMeta, useCourseSelectStore } from '@/stores/courseSelect'
import { grabTaskTitle } from '@/utils/grab'
import type { CourseSelectLesson, GrabTask } from '@/types'

/**
 * 抢课任务（管理面）。
 *
 * 为什么要有这一页：任务单在选课页只是**仪表盘的一部分** —— 它按志愿组渲染、
 * 和倒计时抢位置，抢完之后「哪些没抢到、为什么没抢到、要不要重排」在那儿
 * 得翻着看。这里把它们一屏摊开，并且能编辑、能删。
 *
 * 状态分组按「**用户此刻该做什么**」来切，不按引擎的内部状态名切：
 *   进行中（含重试中）→ 什么都不用做，等
 *   已抢到           → 去课表确认
 *   没抢到           → 要么重排、要么放弃
 */
const store = useCourseSelectStore()
const toast = useToast()

/** 官方选课页（含令牌）—— 需办免听的课只能在那里办 */
const entryUrl = computed(() => store.status?.entryUrl ?? '')

onMounted(() => {
  void store.attachGrab()
})
onBeforeUnmount(() => {
  store.detachGrab()
})

/* ---------------- 分组 ---------------- */
const tasks = computed(() => store.grabTasks)
const won = computed(() => tasks.value.filter((t) => t.status === 'success'))
/** 进行中：引擎正在动它（排队中 / 出手了 / 被暂停） */
const running = computed(() =>
  tasks.value.filter((t) => t.status === 'waiting' || t.status === 'running' || t.status === 'paused'),
)
/**
 * 没抢到。**排序按「要不要你动手」**：被教务拒的、需办免听的排前面 ——
 * 那两条是「停在那里等你做点什么」的；失败与已取消只是记录。
 */
const lost = computed(() => {
  const rank = (t: GrabTask) =>
    t.status === 'needs_ai' ? 0 : t.status === 'conflict' ? 1 : t.status === 'failed' ? 2 : 3
  return tasks.value
    .filter((t) => t.status === 'failed' || t.status === 'conflict' || t.status === 'needs_ai' || t.status === 'cancelled')
    .sort((a, b) => rank(a) - rank(b))
})

/** 页头副标题只留汇总量 —— 各组分数组数在分组头上已经有了，同屏再读一遍只会互相削弱 */
const summary = computed(() => {
  if (!tasks.value.length) return '还没有任务'
  return `共 ${tasks.value.length} 条`
})

/** 行标题：命名规矩在 utils/grab（任务行 / 结果行 / 志愿组共用一份） */
const title = grabTaskTitle

/** 这一秒为什么没在动 / 到底怎么了 —— 引擎的 `lastMessage` 是教务的原话，优先说它 */
function why(t: GrabTask): string {
  // 胶囊已经写着「已暂停」，这里只说增量：暂停之后会发生什么
  if (t.status === 'paused') return '不会自动重试，恢复后从当前节奏继续'
  const wait = (t.nextAt ?? 0) - now.value
  if ((t.status === 'waiting' || t.status === 'running') && wait > 0) {
    return wait < 1000 ? '马上重试' : wait < 60_000 ? `${Math.ceil(wait / 1000)} 秒后重试` : `${Math.ceil(wait / 60_000)} 分钟后重试`
  }
  const msg = t.lastMessage?.trim() ?? ''
  // 教务那句话如果只是在复述徽标，就不必再说一遍（同 GrabResult 的规矩）
  return msg && msg !== grabStatusMeta(t).label ? msg : ''
}

/** 行副信息：课程号 / 教师 / 已尝试次数（志愿序是行首胶囊，不在这行里） */
function facts(t: GrabTask): string {
  const bits: string[] = []
  if (t.courseCode) bits.push(t.courseCode)
  if (t.teacher) bits.push(t.teacher)
  // 状态胶囊已经给出「第 N 次尝试」时这里不再复述；等窗口 / 限速 / 教务异常 / 暂停这些
  // 分支胶囊落空，尝试次数只出现在这一行，必须保留（docs〈复核未决条目的处置〉B 表）
  if (t.attempts > 0 && !grabStatusMeta(t).label.includes('尝试')) {
    bits.push(`已尝试 ${t.attempts} 次`)
  }
  return bits.join('｜')
}

const now = ref(Date.now())
let ticker: number | null = null
onMounted(() => {
  ticker = window.setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (ticker != null) window.clearInterval(ticker)
})

/* ---------------- 行操作 ---------------- */
const busy = ref(false)

async function act(id: number, action: 'pause' | 'cancel' | 'retry' | 'remove'): Promise<void> {
  try {
    await store.taskAction(id, action)
    if (action === 'remove') toast.toast('已移除这条任务')
    if (action === 'retry') toast.toast('已重新排队')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '操作失败')
  }
}

/** 移除是两步的：这些行是「抢到了什么」的唯一本地记录，一次误触就删掉不值 */
const { pending: pendingRemove, ask } = useTwoStepConfirm()
function askRemove(id: number): void {
  ask(id, () => void act(id, 'remove'))
}

/* ---------------- 改设置并重排 ----------------
 * 任务里只存了「提交要用的那几样」，够重建一个教学班对象。
 * `lessonName` 要原样带上：它就是任务行上那个区分标签（项目名优先），
 * 丢掉它重排之后任务行会退回成一门共有的课程名，又认不出来了。
 */
const editing = ref<GrabTask | null>(null)

function lessonOf(t: GrabTask): CourseSelectLesson {
  return {
    id: t.lessonId,
    course: { code: t.courseCode ?? null, nameZh: t.courseName ?? null, credits: t.credits ?? null },
    teachers: t.teacher ? [{ nameZh: t.teacher }] : [],
    lessonName: t.lessonName ?? null,
    scheduleGroups: [],
  }
}

async function onSaveEdit(payload: {
  mode: 'predicate' | 'direct'
  virtualCost: number
  priority: number
}): Promise<void> {
  const t = editing.value
  if (!t || busy.value) return
  busy.value = true
  try {
    // 先撤掉旧的再排新的：不留一条已取消的垃圾在列表里（引擎里 remove 是无状态守卫的纯删除）
    await store.taskAction(t.id, 'remove')
    await store.enqueue([lessonOf(t)], {
      mode: payload.mode,
      virtualCost: payload.virtualCost > 0 ? payload.virtualCost : null,
      scheduleGroupId: t.scheduleGroupId ?? null,
      groupKey: t.groupKey ?? null,
      groupName: t.groupName ?? null,
      priority: payload.priority,
      turnId: t.turnId,
    })
    editing.value = null
    toast.toast('已按新设置重新排队')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '重排失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="抢课任务" :subtitle="summary" back>
      <template #action>
        <button
          v-if="running.some((t) => t.status !== 'paused')"
          class="hdr-btn"
          aria-label="全部暂停"
          title="全部暂停"
          @click="store.pauseAll()"
        >
          <Pause :size="19" />
        </button>
        <button
          v-else-if="running.length"
          class="hdr-btn"
          aria-label="全部恢复"
          title="全部恢复"
          @click="store.resumeAll()"
        >
          <Play :size="19" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <EmptyState
      v-if="!tasks.length"
      :icon="ListChecks"
      title="还没有抢课任务"
      hint="在选课页挑一门课加入抢课，或者写一条抢课计划 —— 之后它们都会出现在这里。"
    >
      <template #action>
        <RouterLink :to="{ name: 'campus-course-select' }" class="cta">去选课</RouterLink>
      </template>
    </EmptyState>

    <template v-else>
      <!-- 引擎级故障：这一页也要说，否则用户只会看到一串「不动」的任务 -->
      <p v-if="store.grabError" class="fault" role="status">
        <Ban :size="14" />
        <span>{{ store.grabError }}</span>
      </p>

      <!-- 桌面看板：三组任务是三个并列的状态列（进行中 / 已抢到 / 没抢到），
           宽形态页面由这一层 d-grid 摊开。手机端它只是个普通 div，
           卡片还是那条 margin-bottom: 14px 的一列 -->
      <div class="grab-board">
      <!-- 进行中 -->
      <section v-if="running.length" class="card">
        <h2 class="head">
          <Play :size="14" />
          进行中
          <span class="cnt num">{{ running.length }}</span>
        </h2>
        <ul class="list">
          <li v-for="t in running" :key="t.id" class="row task" :class="grabStatusMeta(t).tone">
            <span class="col flex-1 body">
              <span class="line1">
                <b class="name">{{ title(t) }}</b>
                <span class="chip" :class="grabStatusMeta(t).tone">{{ grabStatusMeta(t).label }}</span>
                <PillChip v-if="t.groupKey && t.priority" tone="label" size="sm">第 {{ t.priority }} 志愿</PillChip>
              </span>
              <span v-if="facts(t)" class="meta facts">{{ facts(t) }}</span>
              <span v-if="why(t)" class="meta">{{ why(t) }}</span>
            </span>
            <span class="ops">
              <button
                v-if="t.status === 'paused'"
                class="op"
                aria-label="恢复"
                title="恢复"
                @click="act(t.id, 'retry')"
              >
                <Play :size="14" />
              </button>
              <button v-else class="op" aria-label="暂停" title="暂停" @click="act(t.id, 'pause')">
                <Pause :size="14" />
              </button>
              <button class="op" aria-label="取消" title="取消" @click="act(t.id, 'cancel')">
                <Ban :size="14" />
              </button>
            </span>
          </li>
        </ul>
      </section>

      <!-- 已抢到 -->
      <section v-if="won.length" class="card">
        <h2 class="head">
          <CheckCircle2 :size="14" />
          已抢到
          <span class="cnt num">{{ won.length }}</span>
        </h2>
        <ul class="list">
          <li v-for="t in won" :key="t.id" class="row task ok">
            <span class="col flex-1 body">
              <span class="line1">
                <b class="name">{{ title(t) }}</b>
                <PillChip v-if="t.groupKey && t.priority" tone="label" size="sm">第 {{ t.priority }} 志愿</PillChip>
              </span>
              <span v-if="facts(t)" class="meta facts">{{ facts(t) }}</span>
            </span>
            <span class="ops">
              <button
                class="op"
                :class="{ danger: pendingRemove === t.id }"
                :title="
                  pendingRemove === t.id
                    ? `再点一次确认移除「${title(t)}」：这条抢课记录将不再显示，也无法恢复（已同步进课表的课程不受影响）`
                    : '移除'
                "
                :aria-label="pendingRemove === t.id ? '确认移除' : '移除'"
                @click="askRemove(t.id)"
              >
                <Check v-if="pendingRemove === t.id" :size="14" />
                <Trash2 v-else :size="14" />
              </button>
            </span>
          </li>
        </ul>
        <p class="foot-hint">抢到不等于课表里有 —— 回选课页「把结果同步到课表」。</p>
      </section>

      <!-- 没抢到 -->
      <section v-if="lost.length" class="card">
        <h2 class="head">
          <RotateCcw :size="14" />
          没抢到
          <span class="cnt num">{{ lost.length }}</span>
          <!-- 「参数错误」是教务拒了请求的写法，与「名额满了」完全不是一回事：
               重试不会改变结果，收进帮助入口说清差别，卡面只留结论 -->
          <InfoHint
            title="没抢到的两种原因"
            content="名额满了 = 没赶上，等下一轮可能还有机会，可以重新排队。参数错误 = 教务拒了这条请求的写法（比如课程参数变了），重试一万次也是同一个结果 —— 那一行要交给 AI 去教务那边核对，或按行内提示去办免听。"
          />
        </h2>
        <ul class="list">
          <li v-for="t in lost" :key="t.id" class="row task" :class="grabStatusMeta(t).tone">
            <span class="col flex-1 body">
              <span class="line1">
                <b class="name">{{ title(t) }}</b>
                <span class="chip" :class="grabStatusMeta(t).tone">{{ grabStatusMeta(t).label }}</span>
                <PillChip v-if="t.groupKey && t.priority" tone="label" size="sm">第 {{ t.priority }} 志愿</PillChip>
              </span>
              <span v-if="facts(t)" class="meta facts">{{ facts(t) }}</span>
              <span v-if="why(t)" class="meta">{{ why(t) }}</span>
            </span>
            <span class="ops">
              <!-- 需办免听的重试没有意义（引擎说得很清楚：得先去教务办免听），
                   所以那一行的第一个动作换成「去办理」——那才是它的下一步 -->
              <a
                v-if="t.status === 'conflict' && entryUrl"
                class="op"
                :href="entryUrl"
                target="_blank"
                rel="noreferrer"
                aria-label="去教务办理免听"
                title="去教务办理免听"
              >
                <ExternalLink :size="14" />
              </a>
              <button v-else class="op" aria-label="重试" title="重新排队，按现有节奏再抢" @click="act(t.id, 'retry')">
                <RotateCcw :size="14" />
              </button>
              <button class="op" aria-label="改设置并重排" title="改设置并重排" @click="editing = t">
                <Settings2 :size="14" />
              </button>
              <button
                class="op"
                :class="{ danger: pendingRemove === t.id }"
                :title="
                  pendingRemove === t.id
                    ? `再点一次确认移除「${title(t)}」：这条抢课记录将不再显示，也无法恢复`
                    : '移除'
                "
                :aria-label="pendingRemove === t.id ? '确认移除' : '移除'"
                @click="askRemove(t.id)"
              >
                <Check v-if="pendingRemove === t.id" :size="14" />
                <Trash2 v-else :size="14" />
              </button>
            </span>
          </li>
        </ul>
      </section>
      </div>

      <div class="bulk">
        <button class="link" @click="store.clearFinished()">
          <CheckCircle2 :size="13" /> 清掉已结束的 {{ won.length + lost.length }} 条
        </button>
        <RouterLink :to="{ name: 'campus-course-select' }" class="link">
          去选课页
        </RouterLink>
      </div>

      <!-- 引擎处理不了的那些（教务改了接口/参数），交给 AI 是唯一有用的下一步 -->
      <p class="hint">
        <Sparkles :size="13" />
        <span>
          卡在「请求被拒」这类引擎自己修不了的问题上时，把现场交给 AI 去教务那边核对
          <RouterLink :to="{ name: 'campus-course-select' }" class="inline-link">（在选课页底部）</RouterLink>。
        </span>
      </p>
    </template>

    <GrabTaskEditSheet
      :open="!!editing"
      :task="editing"
      :busy="busy"
      @close="editing = null"
      @save="onSaveEdit"
    />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶距走 --page-pad-top（手机 12 / 桌面 40），与全库页面同一处来源 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.card {
  background: var(--surface);
  /* 卡片档 16：这一页的三张卡是同级的内容容器，原先用 32（半模态档）
     把它们抬到了比抽屉还高的层级 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--pad-card);
  margin-bottom: var(--gap-md);
}

.head {
  display: flex;
  align-items: center;
  /* 图标 / 标题 / 计数同一行：无边界控件之间取 8 */
  gap: var(--gap-sm);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  /* 卡内标题与列表之间 8 */
  margin-bottom: var(--gap-sm);
}

.head svg {
  color: var(--accent);
}

.cnt {
  margin-left: auto;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  /* 正文区与右侧操作钮之间 12：三颗钮是实心圆，需要比普通间距多一档 */
  gap: var(--gap-md);
  padding: var(--sp-12) 0;
}

.row + .row {
  border-top: 0.5px solid var(--line);
}

.body {
  display: flex;
  flex-direction: column;
  /* 课名 / 事实 / 原因三级文本，行间距 2 —— 3 会让三行各自浮开、读不成一段 */
  gap: var(--gap-text);
  min-width: 0;
}

.line1 {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-width: 0;
}

.name {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow-wrap: anywhere;
}

/* 终态行压暗：已经结束的事不该和还在抢的争注意力 */
.task.ok .name,
.task.bad .name,
.task.idle .name {
  color: var(--text-2);
}

.meta {
  font-size: var(--fs-micro);
  line-height: var(--lh-caption);
  color: var(--text-2);
  overflow-wrap: anywhere;
}

/* 行副信息里的课程号 / 教师 / 尝试次数：比 why() 低一档的元数据，竖线分隔 */
.meta.facts {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  /* 角标上下留出 2，不再贴到字形的边界上；左右 8 与间距令牌同档 */
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

.chip.run {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.chip.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.chip.warn {
  color: var(--warn-strong);
  background: var(--warn-soft);
}

.chip.bad {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.chip.idle {
  color: var(--text-2);
  background: var(--surface-2);
}

.ops {
  flex: none;
  display: flex;
  align-items: center;
  /* 14 档：每颗按钮命中区外扩 7px 后正好相接，谁也不偷谁的边缘
     （改成 12 会让两个 44 命中区重叠 2px，改大则整组右移） */
  gap: var(--sp-14);
}

.op {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 命中区撑到 44×44，视觉尺寸不动 —— 这一页上「移除」紧挨着「重试」，拇指最容易点错 */
.op::after {
  content: '';
  position: absolute;
  inset: -7px;
}

.op:active {
  transform: scale(0.9);
}

.op.danger {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.foot-hint {
  margin-top: var(--gap-sm);
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.fault {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--warn-strong);
  background: var(--warn-soft);
  border-radius: var(--radius-m);
  padding: var(--sp-8) var(--pad-inline);
  margin-bottom: var(--gap-md);
  line-height: var(--lh-caption);
}

.bulk {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: var(--sp-4) var(--sp-2) 0;
}

.link {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.link:active {
  transform: scale(0.96);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: var(--lh-body);
  margin-top: var(--gap-md);
}

.hint svg {
  flex: none;
  /* 图标对齐正文首行的基线，2 是主次文本上下那一档 */
  margin-top: var(--gap-text);
}

.inline-link {
  color: var(--accent-strong);
  font-weight: var(--fw-semibold);
}

.cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  /* 与课表页 / 选课页的空态出口同一形状：高 40、左右 24、胶囊 */
  min-height: var(--control-md);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: var(--sp-8) var(--sp-24);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cta:active {
  transform: scale(0.96);
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   这一页是宽形态（desk: 'wide'），构图自负。
   三组任务是三个并列的**状态列**，一列读完之后最该看见的是另外两列 ——
   手机上竖着排是顺序（先看进行中、再看抢到了什么），桌面上并排才是看板。
   栏宽下限用 --desk-aside（320px）：再窄，「课名 + 状态徽标」与右边那三颗
   操作钮（暂停/取消/移除）会挤到同一行里打架；窄桌面自动退回两栏。
   ============================================================ */
.desk-main .page {
  max-width: var(--desk-wide);
  margin-inline: auto;
}

.desk-main .grab-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--desk-aside), 1fr));
  gap: var(--desk-gap);
  align-items: start;
  margin-bottom: var(--desk-gap);
}

/* 栅格用 gap 管列间距，卡片自带的那条 margin-bottom 会把它撑成两倍 */
.desk-main .grab-board > .card {
  margin-bottom: 0;
}
</style>
