<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from 'lucide-vue-next'

import { useToast } from '@/composables/useToast'
import { useCampusStore } from '@/stores/campus'
import { grabStatusMeta, useCourseSelectStore } from '@/stores/courseSelect'
import { askAiForGrabRescue } from '@/utils/campusAi'
import type { GrabTask } from '@/types'

/**
 * 抢课结果 —— 这条链路的**终点**。
 *
 * 为什么它必须存在：引擎的整个前提是「用户不在场」（睡觉、上课、把 App 扔一边），
 * 所以结果不能只表现为任务行上换了一个 11px 的徽标 —— 那是「过程」的语言。
 * 醒过来的人要的是三个答案，而且要在几秒内给完：
 *
 * 1. **拿到了什么**（几门、哪几门、哪个教学班/老师）
 * 2. **还欠什么**（没抢到的原因：一直满员 / 时间冲突 / 连败停手）
 * 3. **我现在要做什么**（去教务办免听 / 把结果同步进课表 / 再抢一次）
 *
 * 第 3 条是原先整条链路最缺的一环：**引擎从不写课表**（它只核对 `verify_picked`），
 * 所以「抢到了」和「课表里有」之间隔着一次同步 —— 而那次同步原本没有任何地方提示。
 */
const props = defineProps<{
  /** 已结束的任务（引擎不再动它们） */
  tasks: GrabTask[]
}>()

const emit = defineEmits<{
  /** 重新排队某个任务 */
  retry: [id: number]
  /** 清掉这些记录 */
  clean: []
}>()

const store = useCourseSelectStore()
const campus = useCampusStore()
const toast = useToast()

/** 被教务拒绝的请求：把现场（含那条失败的原文）交给 AI，由它查清教务现在要什么参数 */
function handToAi(): void {
  askAiForGrabRescue(store.grab)
}

const syncing = ref(false)
/** 同步回执：用真实数字说话（「18 门课 / 42 个时段」），不写「同步成功」这种空话 */
const syncNote = ref('')

const won = computed(() => props.tasks.filter((t) => t.status === 'success'))
const conflict = computed(() => props.tasks.filter((t) => t.status === 'conflict'))
const failed = computed(() => props.tasks.filter((t) => t.status === 'failed'))
const cancelled = computed(() => props.tasks.filter((t) => t.status === 'cancelled'))
/** 被教务拒绝的请求（参数错误）：引擎停手了，等 AI 查明教务现在要什么参数 */
const rejected = computed(() => props.tasks.filter((t) => t.status === 'needs_ai'))

/** 汇总结论。顺序固定：抢到 → 未抢到 → 需办免听 → 被拒，已取消只在后面补一句 */
const headline = computed(() => {
  if (!won.value.length && !failed.value.length && !conflict.value.length && !rejected.value.length) {
    return `${cancelled.value.length} 条抢课任务已取消`
  }
  const bits: string[] = []
  if (won.value.length) bits.push(`抢到 ${won.value.length} 门`)
  else bits.push('这一轮没有抢到')
  if (failed.value.length) bits.push(`未抢到 ${failed.value.length} 门`)
  if (conflict.value.length) bits.push(`需办免听 ${conflict.value.length} 门`)
  if (rejected.value.length) bits.push(`请求被拒 ${rejected.value.length} 门`)
  const tail = cancelled.value.length ? `（另有 ${cancelled.value.length} 条已取消）` : ''
  return bits.join(' · ') + tail
})

/**
 * 结论行的图标与颜色跟着结论切档。
 *
 * 原先固定挂一枚绿对勾：没抢到、全取消时第一眼收到的还是「成功」的信号 ——
 * 而这块板是给**不在场、只扫一眼**的人看的，图标先于文字被读到。
 * 抢到 → 绿对勾；有没抢到/免听/被拒 → 黄三角；全是取消 → 中性图标。
 */
const leadIcon = computed(() => {
  if (won.value.length) return CheckCircle2
  if (failed.value.length || conflict.value.length || rejected.value.length) return AlertTriangle
  return Ban
})
const leadTone = computed(() => {
  if (won.value.length) return 'ok'
  if (failed.value.length || conflict.value.length || rejected.value.length) return 'warn'
  return 'idle'
})

/** 结果行：抢到的在前，**需要行动的**（免听 / 被拒）紧随，其余按原顺序 */
const rows = computed(() => {
  const rank = (t: GrabTask) =>
    t.status === 'success' ? 0 : t.status === 'conflict' || t.status === 'needs_ai' ? 1 : 2
  return [...props.tasks].sort((a, b) => rank(a) - rank(b))
})

/**
 * 结果行的标题 —— 与任务行同一条规矩。
 *
 * `lessonName` 里存的是「这个班怎么和同门课其他班区分」（项目名优先）：
 * 体育课 8 个项目的课程名全都叫「大学体育1」，只写课程名，
 * 用户看着结果里那几行认不出抢到的到底是羽毛球还是匹克球。
 * 只在真有新信息时才拼上去（教学班名常以课程名开头，那种就不重复）。
 */
function title(t: GrabTask): string {
  const course = t.courseName?.trim()
  const label = t.lessonName?.trim()
  if (!course) return label || `教学班 ${String(t.lessonId)}`
  if (!label || label === course || label.startsWith(course)) return course
  return `${course} · ${label}`
}

function detail(t: GrabTask): string {
  const bits: string[] = []
  if (t.courseCode) bits.push(t.courseCode)
  if (t.teacher) bits.push(t.teacher)
  // 「已尝试 N 次」与进行中的任务行**用同一句话**：同一个数字在两处换词，
  // 用户会以为是两件事（这一条是 e2e 撞出来的）
  if (t.attempts > 0) bits.push(`已尝试 ${t.attempts} 次`)
  return bits.join(' · ')
}

/**
 * 教务最近那句话 —— 但**它如果只是在复述徽标，就不必再说一遍**。
 *
 * 抢到之后 `lastMessage` 常常就是「已抢到」，而左边那枚徽标已经写着同样的三个字，
 * 于是同一行上把同一件事说了两遍（真正的新信息是上面那行「已尝试 N 次」）。
 * 这条规矩在本模块的余量文案里已经用过一次：「满员不写余 0」。
 */
function message(t: GrabTask): string {
  const m = t.lastMessage?.trim() ?? ''
  if (!m) return ''
  return m === grabStatusMeta(t).label ? '' : m
}

/** 官方选课页（含令牌）—— 出问题时去那里核对最省事 */
const entryUrl = computed(() => store.status?.entryUrl ?? '')

/**
 * 清掉记录是**两步**的：先变成「确认清空？」，再点一次才真删。
 * 这些行是「抢到了什么」的唯一本地记录，一次误触就没了实在不值。
 */
const confirmClean = ref(false)
let cleanTimer: number | null = null

function askClean(): void {
  if (confirmClean.value) {
    if (cleanTimer != null) window.clearTimeout(cleanTimer)
    confirmClean.value = false
    emit('clean')
    return
  }
  confirmClean.value = true
  cleanTimer = window.setTimeout(() => (confirmClean.value = false), 4000)
}

async function onSync(): Promise<void> {
  syncing.value = true
  syncNote.value = ''
  try {
    const out = await campus.sync()
    syncNote.value = `已同步：${out.semesterName} · ${out.courses} 门课 · ${out.sessions} 个时段`
    toast.toast('课表已更新，抢到的课现在在课表与时间线里')
  } catch (e) {
    // 同步失败要说清是「抢课没成」还是「只是课表没拉下来」——这两件事的处置完全不同
    syncNote.value = `课表同步失败：${e instanceof Error ? e.message : '未知原因'} —— 抢课结果本身不受影响，稍后再同步一次即可`
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <div class="result">
    <!-- 结论是这条链路上最该被读出来的一句话：用户不在场时它是唯一的"结果播报" -->
    <p class="lead" role="status">
      <component :is="leadIcon" :size="14" class="ico" :class="leadTone" />
      <b>{{ headline }}</b>
    </p>

    <ul class="rows">
      <!-- `task` 是沿用板上的语义钩子：结果行本来就是任务行，只是换了一种排法。
           留着它，界面之外读这块板的东西（e2e、调试脚本）不必知道"现在是哪种模式" -->
      <li v-for="t in rows" :key="t.id" class="row task" :class="grabStatusMeta(t).tone">
        <span class="chip" :class="grabStatusMeta(t).tone">{{ grabStatusMeta(t).label }}</span>
        <span class="col flex-1 body">
          <b class="name">{{ title(t) }}</b>
          <em v-if="detail(t)" class="meta">{{ detail(t) }}</em>
          <em v-if="t.status === 'conflict'" class="why">
            与已选课程时间冲突 —— 要在教务网页端办理免听，这门课才会留下
          </em>
          <em v-else-if="t.status === 'needs_ai'" class="why">
            教务说这条请求的参数不对 —— 重试不会成功，已经交给 AI 去查明教务现在要什么参数
          </em>
          <em v-else-if="message(t)" class="meta">{{ message(t) }}</em>
        </span>
        <button
          v-if="t.status === 'failed'"
          class="mini"
          title="重新排队，按现有节奏再抢"
          @click="emit('retry', t.id)"
        >
          <RotateCcw :size="13" /> 再抢一次
        </button>
        <button
          v-else-if="t.status === 'needs_ai'"
          class="mini"
          title="把现场交给 AI：查清教务要的参数再重排"
          @click="handToAi"
        >
          <Sparkles :size="13" /> 交给 AI
        </button>
        <a
          v-else-if="t.status === 'conflict' && entryUrl"
          class="mini"
          :href="entryUrl"
          target="_blank"
          rel="noreferrer"
        >
          去办理 <ExternalLink :size="12" />
        </a>
      </li>
    </ul>

    <!-- 下一步：结果要落到课表上才算真的完事（引擎不写课表，这一步只能由用户触发） -->
    <div class="acts">
      <button class="primary" :disabled="syncing" @click="onSync">
        <RefreshCw :size="15" :class="{ spin: syncing }" />
        {{ syncing ? '正在同步…' : '把结果同步到课表' }}
      </button>
      <div class="sub">
        <a v-if="entryUrl" class="link" :href="entryUrl" target="_blank" rel="noreferrer">
          打开官方选课页核对 <ExternalLink :size="12" />
        </a>
        <button class="link" :class="{ danger: confirmClean }" @click="askClean">
          <!-- 武装态说后果不说规定：这几条是「抢到了什么」的唯一本地记录，清掉即无法恢复 -->
          {{ confirmClean ? `确认清空：这 ${tasks.length} 条记录是本地唯一记录，清掉后无法恢复` : `清掉这 ${tasks.length} 条记录` }}
        </button>
      </div>
    </div>

    <p v-if="syncNote" class="note">{{ syncNote }}</p>
  </div>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  gap: var(--sp-10);
}

.lead {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

/* 图标色随结论切档：抢到的绿、出事的黄、全取消的中性 */
.ico.ok {
  color: var(--ok);
}

.ico.warn {
  color: var(--warn-strong);
}

.ico.idle {
  color: var(--text-2);
}

.rows {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  padding: var(--sp-10) 0;
}

.row + .row {
  border-top: 0.5px solid var(--line);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

.name {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.meta {
  font-size: var(--fs-micro);
  font-style: normal;
  line-height: var(--lh-caption);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  /* 课程号 · 教师 · 已尝试 N 次 —— 结果行里唯一说明「它经历了什么」的一行 */
  color: var(--text-2);
}

/* 免听不是「一条失败」，是一件今天就要去办的事 —— 给它正文级权重。
   字号也必须到正文下限 12：10px 的「去教务办免听」读不出来，权重就只是说说 */
.why {
  font-size: var(--fs-caption);
  font-style: normal;
  color: var(--warn-strong);
  line-height: var(--lh-caption);
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  /* 中性档（已取消）也是状态词：--text-3 压 --surface-2 只有 2.3:1 */
  color: var(--text-2);
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

.mini {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 命中区撑到 44 高（34 → 48）。行与行之间靠 .row 的 9px 内边距隔开，
   纵向各外扩 7px 正好落在自己的行里，不会压到上下两行 */
.mini::after {
  content: '';
  position: absolute;
  inset: -7px 0;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
  padding-top: var(--sp-10);
  border-top: 0.5px solid var(--line);
}

.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-6);
  padding: var(--sp-12);
  /* 按钮档 20：这是结果面板唯一的主操作，与卡片（16）拉开一层 */
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

.sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-10);
  flex-wrap: wrap;
}

.link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
}

.link.danger {
  color: var(--danger-strong);
}

.note {
  font-size: var(--fs-micro);
  line-height: var(--lh-body);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
