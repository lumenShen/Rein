<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AlertCircle } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import WorkoutSourceTag from '@/components/exercise/WorkoutSourceTag.vue'
import { sessionService } from '@/services/sessionService'
import { EFFORT_LABELS, WORKOUT_META } from '@/config/domain'
import { SCORE_GROUP_LABELS, SCORE_GROUP_OF, type Level, type MuscleKey, type ScoreGroupKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { usePlanStore } from '@/stores/plan'
import { todayStr, fmtDateCn, minToHHmm } from '@/utils/date'
import { fmtClock, fmtKg, fmtPace } from '@/utils/format'
import { projectTrack, trackAscentM, trackSplits } from '@/utils/geo'
import { libraryMuscles } from '@/utils/libraryMuscles'
import { buildDetailRows, detailTotals, type DetailExRow } from '@/utils/sessionDetail'
import { ACTIVATION_WEIGHT } from '@/utils/trainingAdvice'
import { computeTrainingScore, type GroupScore, type TrainingScoreResult } from '@/utils/trainingScore'
import type { DoneSet, PlanExercise, RunSnapshot, SessionSetRow, Workout } from '@/types'

/**
 * 运动详情抽屉：按记录来源渲染真实数据。
 *  - 跑步会话（state.kind='run'）：轨迹图 + 距离/配速/爬升 + 每公里分段；
 *  - 训练课会话：逐动作做组明细（重量×次数 / 计时秒）+ 总量统计；
 *  - 手动添加或快照不可用：概要视图（时长 / 强度 / 卡路里 / 时间 / 备注）。
 * 早期快照缺时间戳的轨迹不显示分段；无海拔数据不显示爬升——不做任何虚构。
 */
const props = defineProps<{
  open: boolean
  workout: Workout | null
}>()

const emit = defineEmits<{ close: [] }>()

/* ---------- 删除这次训练（抽屉内的显式入口） ----------
 * 第一轮把行尾删除钮改成了 ActionSheet 确认层，且触态下 .del 整个隐藏 ——
 * 触屏用户在列表里失去了删除路径。详情抽屉是他们看完这次训练后的自然落点，
 * 所以这里给一条显式、可见的「删除这次训练」入口，并接同一套确认层。
 *
 * 接线方式：**抽屉自管 + emit close**。父级（WorkoutRecordsPage）只绑了 @close，
 * 没有 @remove 这类契约，删父文件不在本次改动范围内；而删除落的是同一个
 * store（useExerciseStore.remove），父级列表由它驱动，删完自动刷新。
 * 因此抽屉自己开确认层、自己落库，成功后关掉自己即可。 */
const exerciseStore = useExerciseStore()
const delOpen = ref(false)

/** 只开门，不删除 —— 破坏性操作必须过确认层 */
function askDelete(): void {
  if (props.workout) delOpen.value = true
}

async function confirmDelete(value: string): Promise<void> {
  if (value !== 'delete') return
  const id = props.workout?.id
  delOpen.value = false
  if (id == null) return
  await exerciseStore.remove(id)
  emit('close')
}

type Detail =
  | { source: 'run'; startedAt: string; snap: RunSnapshot }
  | {
      source: 'course'
      planName: string
      startedAt: string
      doneSets: Record<string, DoneSet[]>
      /** 逐组落库明细（workout_sets）：做组明细的权威来源，见 utils/sessionDetail */
      sets: SessionSetRow[]
      /** null = 课程已被删除，动作退化为序号展示 */
      exercises: PlanExercise[] | null
    }
  | { source: 'summary'; fromSession: { planName: string; startedAt: string } | null }

const detail = ref<Detail | null>(null)
const loadFailed = ref(false)

/* ---------- 肌群练够分提醒 ----------
 * 练完一次力量课，下一个问题是「这次练的肌群，本周练够了吗」——
 * 做组明细回答的是「练了什么」，这里回答「练够了没有」。
 * 数据全部来自既有的纯函数层（trainingScore 的练够分 + 激活折算），
 * 不新造口径：本次各评估组组数按激活档位折算（主攻 1 / 辅助 0.5 / 稳定 0.25），
 * 周分数与「本周练够分」卡同一份算法，所以两处数字永远对得上。 */
const lib = useExerciseLibStore()
const weeklyLoad = ref<TrainingScoreResult | null>(null)

/**
 * 本次训练各评估组的加权组数（只算正式组 —— 热身不计入，与全局口径一致）。
 * 折叠到评估组：细肌群先经 SCORE_GROUP_OF 归组，同一动作同一次里同一组只按组内
 * 最高激活档计一次，避免卧推那种「胸 + 三头 + 前束」各记一份的虚高组数。
 */
const sessionMuscles = computed<{ group: ScoreGroupKey; label: string; sets: number }[]>(() => {
  if (detail.value?.source !== 'course') return []
  const exById = new Map((detail.value.exercises ?? []).map((e) => [e.id, e]))
  const acc = new Map<ScoreGroupKey, number>()
  for (const row of courseRows.value) {
    if (row.kind !== 'strength' || row.done.length === 0) continue
    // 课程被删过的动作取不到肌群表，libraryMuscles 会按名称规则兜底（同一口径）
    const planId = row.planExerciseId ?? row.key
    const map = libraryMuscles({ name: row.name, muscles: exById.get(planId)?.muscles ?? {} })
    const byGroup = new Map<ScoreGroupKey, Level>()
    for (const [m, lv] of Object.entries(map) as [MuscleKey, Level][]) {
      const g = SCORE_GROUP_OF[m]
      if (!g) continue
      const cur = byGroup.get(g)
      if (!cur || lv > cur) byGroup.set(g, lv)
    }
    for (const [g, lv] of byGroup) {
      acc.set(g, (acc.get(g) ?? 0) + (ACTIVATION_WEIGHT[lv] ?? 0.5) * row.done.length)
    }
  }
  return [...acc.entries()]
    .map(([group, sets]) => ({ group, label: SCORE_GROUP_LABELS[group], sets: Math.round(sets * 10) / 10 }))
    .sort((a, b) => b.sets - a.sets)
})

/** 提醒内容：本次练到的组 × 该组的本周练够分。取贡献最大的 5 个，再多就不是「提醒」了 */
const muscleReminder = computed(() => {
  if (!sessionMuscles.value.length || !weeklyLoad.value) return null
  const byGroup = new Map(weeklyLoad.value.groups.map((g) => [g.group, g]))
  const rows = sessionMuscles.value
    .map((s) => ({ group: s.group, label: s.label, sets: s.sets, score: byGroup.get(s.group) }))
    .filter((x): x is typeof x & { score: GroupScore } => !!x.score)
    .slice(0, 5)
  if (!rows.length) return null
  return { rows, low: rows.filter((x) => x.score.score < 60).length }
})

/** 直接给规范的六段档名（运动充分…明显不足） */
function statusLabel(g: GroupScore): string {
  return g.band
}

/**
 * 练够分条：**满格 = 100 分（运动充分）**，与旁边的 `NN 分` 同源。
 *
 * 分数本身就是 0–100 的最终结论，不再拿别的量表来换算 —— 条走到哪、
 * 数字写到哪、档名说到哪，三处永远一致（不再另设量表基准）。
 */
function loadPct(g: GroupScore): number {
  return Math.round(Math.max(0, Math.min(1, g.score / 100)) * 100)
}

watch(
  () => [props.open, props.workout?.id] as const,
  ([open]) => {
    if (!open || !props.workout) {
      detail.value = null
      loadFailed.value = false
      weeklyLoad.value = null
      return
    }
    void load(props.workout)
    void loadWeeklyLoad()
  },
  { immediate: true },
)

/**
 * 本周各肌群练够分（「肌群练够分提醒」用）。与「本周练够分」卡同一份算法与同一窗口
 * （42 天记录，引擎内部再切本周 7 天）。目标取自营养档案（cut → 减脂，其余 → 增肌）。
 * 失败时置 null、整块提醒不渲染 —— 这条是补充信息，不能因为它把详情抽屉带崩。
 */
async function loadWeeklyLoad(): Promise<void> {
  try {
    await lib.ensureLoaded()
    const sets = await sessionService.strengthRecentSets(42)
    const nutrition = useNutritionStore()
    await nutrition.loadProfile()
    const goal = nutrition.profile?.goal ?? null
    weeklyLoad.value = computeTrainingScore({ sets, library: lib.list, today: todayStr(), goal })
  } catch (e) {
    console.warn('[workout-detail] 本周练够分加载失败', e)
    weeklyLoad.value = null
  }
}

async function load(w: Workout): Promise<void> {
  detail.value = null
  loadFailed.value = false
  if (w.sessionId == null) {
    detail.value = { source: 'summary', fromSession: null }
    return
  }
  try {
    const rec = await sessionService.forWorkout(w.id)
    if (!rec || !props.workout || props.workout.id !== w.id) return // 抽屉已切换/关闭
    const st = rec.state as unknown
    if (st && typeof st === 'object' && (st as RunSnapshot).kind === 'run') {
      detail.value = { source: 'run', startedAt: rec.startedAt, snap: st as RunSnapshot }
      return
    }
    if (st && typeof st === 'object' && 'doneSets' in st) {
      const courseState = st as { doneSets?: Record<string, DoneSet[]> }
      let exercises: PlanExercise[] | null = null
      try {
        const planStore = usePlanStore()
        let p = planStore.byId(rec.planId)
        if (!p) await planStore.ensureLoaded()
        p = planStore.byId(rec.planId)
        exercises = p ? p.exercises : null
      } catch {
        exercises = null
      }
      detail.value = {
        source: 'course',
        planName: rec.planName,
        startedAt: rec.startedAt,
        doneSets: courseState.doneSets ?? {},
        sets: rec.sets ?? [],
        exercises,
      }
      return
    }
    detail.value = { source: 'summary', fromSession: { planName: rec.planName, startedAt: rec.startedAt } }
  } catch {
    loadFailed.value = true
  }
}

/* ---------- 公共展示 ---------- */

const typeLabel = computed(() =>
  props.workout ? WORKOUT_META[props.workout.type]?.label ?? props.workout.type : '',
)

const INTENSITY_LABELS = { low: '低强度', moderate: '中等强度', high: '高强度' } as const

/**
 * 强度格展示：有体感就显示体感（那是用户自己说的），没有才退回客观档位。
 * 键名也跟着换 —— 「强度：挺累」读起来别扭，而这一格在手动补录的记录上
 * 本来就不该再讲 MET 档位（那是内部折算用的中间量）。
 */
const effortCell = computed(() => {
  const w = props.workout
  if (!w) return { value: '', key: '强度' }
  if (w.effort != null) return { value: EFFORT_LABELS[w.effort], key: '体感' }
  return { value: INTENSITY_LABELS[w.intensity] ?? w.intensity, key: '强度' }
})

/** 开始时刻：手动记录用 startMin，会话记录用 startedAt */
function startTimeText(startedAt: string): string {
  const d = new Date(startedAt)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * meta 行三段：日期 / 开始时刻 / 类型。
 *
 * 时长与热量**不在这行**——它们被提为统计格里的主数值（--fs-title1 + .num），
 * 不再和日期时刻摊平在同一行灰字里（「这次练了多久/消耗多少」是首屏真正要看的数）。
 * 类型也只在统计格没有「类型」那一格时才出现：概要视图的格子已写了一遍，
 * 同行再写就是同一事实在抽屉首屏说两次。
 */
const metaParts = computed(() => {
  const w = props.workout
  if (!w) return { date: '', time: '', type: '' }
  let time = ''
  if (w.startMin != null) time = minToHHmm(w.startMin)
  else if (detail.value && detail.value.source !== 'summary') {
    time = startTimeText(detail.value.startedAt)
  } else if (detail.value?.fromSession) {
    time = startTimeText(detail.value.fromSession.startedAt)
  }
  return {
    date: fmtDateCn(w.date),
    time,
    type: detail.value?.source === 'summary' ? '' : typeLabel.value,
  }
})

/* ---------- 跑步视图 ---------- */

const ROUTE_W = 480
const ROUTE_H = 260
const ROUTE_PAD = 26

const runRoute = computed(() => {
  if (detail.value?.source !== 'run') return null
  return projectTrack(detail.value.snap.points ?? [], ROUTE_W, ROUTE_H, ROUTE_PAD)
})

/** 距离 km：优先取总结页确认后的值（note 首段即最终距离），无则用快照 GPS 距离 */
const runKm = computed<number | null>(() => {
  if (detail.value?.source !== 'run' || !props.workout) return null
  const m = props.workout.note?.match(/^([\d.]+)\s*km(?:\s|$)/)
  if (m) {
    const v = Number(m[1])
    if (Number.isFinite(v) && v > 0) return v
  }
  const dm = detail.value.snap.distanceM ?? 0
  return dm > 5 ? Math.round(dm) / 1000 : null
})

const runDurationSec = computed(() => {
  if (detail.value?.source !== 'run') return 0
  return Math.round((detail.value.snap.accumMs ?? 0) / 1000)
})

const runAvgPace = computed(() => {
  const dur = runDurationSec.value
  if (dur < 10 || runKm.value == null || runKm.value < 0.05) return null
  return Math.round(dur / runKm.value)
})

/** 骑行等类型显示均速而不是配速 */
const isCycle = computed(() => props.workout?.type === 'cycle')

const runAvgSpeedKmh = computed(() => {
  if (runAvgPace.value == null) return null
  return Math.round((3600 / runAvgPace.value) * 10) / 10
})

const goalLine = computed(() => {
  if (detail.value?.source !== 'run') return ''
  const s = detail.value.snap
  if (s.goalKind === 'time') {
    const hit = runDurationSec.value >= s.goalTimeMin * 60
    return `目标 ${s.goalTimeMin} 分钟 · ${hit ? '已达成' : `实际 ${Math.round(runDurationSec.value / 60)} 分钟`}`
  }
  if (s.goalKind === 'distance') {
    const km = runKm.value
    const hit = km != null && km >= s.goalDistanceKm
    return `目标 ${s.goalDistanceKm} km · ${hit ? '已达成' : km != null ? `实际 ${km.toFixed(2)} km` : '未记录距离'}`
  }
  return '自由跑'
})

interface SplitRow {
  label: string
  text: string
  widthPct: number
  color: string
}

/**
 * 快→慢从绿渐变到红（Apple 配速色带的简化版）。
 *
 * 两端取 `--pace-fast` / `--pace-slow` 两个**配速专用**令牌，在 CSS 里用 color-mix 插值 ——
 * 从前是两个十进制三元组写死在 JS 里（`[146,232,42]` / `[250,17,79]`，值恰好等于
 * `--c-exercise` / `--c-intake`，但那只是巧合）：配速色带与三环是两个语义，绑在一起会让
 * 「给运动环换色」顺带改掉配速色带，这也是全仓魔法色的收编点之一。
 */
function splitColor(norm: number): string {
  const t = Math.round(Math.max(0, Math.min(1, norm)) * 100)
  return `color-mix(in srgb, var(--pace-slow) ${t}%, var(--pace-fast))`
}

const splitRows = computed<SplitRow[]>(() => {
  if (detail.value?.source !== 'run') return []
  const km = runKm.value
  const splits = trackSplits(detail.value.snap.points ?? [], km != null ? km * 1000 : 0)
  if (!splits) return []
  const paces = splits.map((s) => s.paceSec)
  const min = Math.min(...paces)
  const max = Math.max(...paces)
  const span = Math.max(1e-6, max - min)
  return splits.map((s) => {
    const norm = (s.paceSec - min) / span
    return {
      label: s.label,
      text: isCycle.value ? `${(3600 / s.paceSec).toFixed(1)}` : fmtPace(s.paceSec),
      widthPct: Math.round(58 + (1 - norm) * 34),
      color: splitColor(norm),
    }
  })
})

const ascentM = computed(() => {
  if (detail.value?.source !== 'run') return null
  return trackAscentM(detail.value.snap.points ?? [])
})

/* ---------- 课程视图 ---------- */

/**
 * 逐动作做组明细：由 `utils/sessionDetail` 的纯函数派生。
 *
 * 从前这里直接拿快照的 `doneSets` 按课程条目 id 对齐 —— 课程一旦被整体覆盖
 * （AI 的 `upsert_plan` 早期版本每次都重建动作 id、手动编辑也可能重排），
 * 键就对不上，于是课程动作全部「未完成」、真实数据被摊成十几条「其他动作」、
 * 完成组数分母虚增一倍。现在以 `workout_sets` 的落库明细为准（带当时的动作名与
 * 动作库 id），`doneSets` 只在老记录缺明细时兜底。
 */
const courseRows = computed<DetailExRow[]>(() => {
  if (detail.value?.source !== 'course') return []
  const d = detail.value
  return buildDetailRows(d.exercises, d.sets, d.doneSets)
})

/**
 * 做组芯片：次数优先取该组完成瞬间登记的 reps（课程可能事后被编辑/删除，
 * 回读定义会失真）；课程定义也没有时只显示重量，绝不拼出「× ?」。
 */
function setChip(ex: DetailExRow, d: DoneSet): string {
  if (ex.kind === 'strength') {
    if (d.weight == null) return '完成'
    const reps = d.reps ?? ex.reps
    return reps != null ? `${fmtWeight(d.weight)} × ${reps}` : fmtWeight(d.weight)
  }
  return d.sec != null ? fmtClock(d.sec) : '完成'
}

/** 热身组芯片：重量 × 热身次数（次数取逐组登记，旧数据回落课程定义；都没有只显示重量） */
function warmupChip(row: DetailExRow, d: DoneSet, i: number): string {
  const reps = d.reps ?? row.warmupDefs?.[i]?.reps
  if (d.weight == null) return '热身'
  return `热身 ${fmtWeight(d.weight)}${reps != null ? ` × ${reps}` : ''}`
}

function fmtWeight(w: number): string {
  return `${fmtKg(w)}kg`
}

const courseTotals = computed(() => detailTotals(courseRows.value))
</script>

<template>
  <SheetModal :open="open" title="运动详情" initial-snap="large" @close="$emit('close')">
    <!-- 抽屉内的帮助入口统一走 #action 槽（与关闭钮同一行右端） -->
    <template #action>
      <InfoHint v-if="workout?.source === 'health_connect'" title="同步规则">
        <p>这条是从手机同步进来的，以 Health Connect 为准。</p>
        <p>在这里改了会被下次同步覆盖回去；删除也只从 Rein 移除、不动 Health Connect 里那份。</p>
      </InfoHint>
    </template>
    <template v-if="workout">
      <p class="name">
        <span class="nm">{{ workout.name }}</span>
        <WorkoutSourceTag :source="workout.source" />
      </p>
      <!-- meta 行只留日期·时刻·类型：时长/热量已提进统计格当主数值 ——
           五项同字重平铺在一行时，「练了多久/消耗多少」读不出来是本屏主角 -->
      <p class="meta">
        <span>{{ metaParts.date }}</span>
        <span v-if="metaParts.time" class="num">{{ metaParts.time }}</span>
        <StatusChip v-if="metaParts.type" tone="neutral" size="sm">{{ metaParts.type }}</StatusChip>
      </p>
      <!-- 手机同步进来的记录，归属是 Health Connect：这句话非有不得不留 ——
           抽屉是用户改/删这次训练的落点，而这条记录改不回去、删也不动那份。
           面上只留一行结论（胶囊），完整规则收进标题栏右侧的 InfoHint ——
           首屏最靠上的位置要留给数据，这段几乎没人逐字读。
           注意别和下面的 detail.source 混：那个是「详情种类」（run/strength/…），
           这个 workout.source 是「这条记录是谁的」。 -->
      <p v-if="workout.source === 'health_connect'" class="srcline">
        <StatusChip tone="neutral" size="md">手机同步 · 以 Health Connect 为准</StatusChip>
      </p>

      <!-- 失败态单独一档：错误提示必须可见、且与说明文字形态有别 ——
           从前它和上面的来源说明共用同一枚 .hint，整屏对比度最低的一行灰字，
           容易被当成普通说明划过去 -->
      <p v-if="loadFailed" class="failrow">
        <AlertCircle :size="14" class="failic" />
        <span>详情数据加载失败，请稍后重试。</span>
      </p>

      <!-- 跑步：轨迹 + 真实指标 -->
      <template v-else-if="detail?.source === 'run'">
        <div class="routebox">
          <svg :viewBox="`0 0 ${ROUTE_W} ${ROUTE_H}`" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <path v-if="runRoute?.d" class="routeline" :d="runRoute.d" />
            <circle v-if="runRoute?.start" class="mk-start" :cx="runRoute.start.x" :cy="runRoute.start.y" r="5" />
            <circle v-if="runRoute?.last" class="mk-end" :cx="runRoute.last.x" :cy="runRoute.last.y" r="6" />
          </svg>
          <p v-if="!runRoute?.d" class="route-empty">该次跑步未记录轨迹</p>
          <p class="goal num">{{ goalLine }}</p>
        </div>

        <div class="dgrid">
          <div v-if="runKm != null" class="cell"><div class="v num">{{ runKm.toFixed(2) }}</div><div class="k">距离 km</div></div>
          <div class="cell"><div class="v num">{{ fmtClock(runDurationSec) }}</div><div class="k">运动时长</div></div>
          <!-- 消耗跟着时长走：这行原本摊在 meta 灰字串里，是首屏真正要看的数之一 -->
          <div class="cell"><div class="v num">{{ workout.kcal }}</div><div class="k">消耗 大卡</div></div>
          <div v-if="isCycle" class="cell"><div class="v num">{{ runAvgSpeedKmh ?? '--' }}</div><div class="k">平均时速 km/h</div></div>
          <div v-else-if="runAvgPace != null" class="cell"><div class="v num">{{ fmtPace(runAvgPace) }}</div><div class="k">平均配速</div></div>
          <div v-if="ascentM != null" class="cell"><div class="v num">{{ ascentM }}</div><div class="k">累计爬升 m</div></div>
        </div>

        <template v-if="splitRows.length > 0">
          <!-- 骑行列头跟着值走：行内值是 km/h 时速，写「用时」会把量纲读反 -->
          <p class="sec">每公里{{ isCycle ? '时速' : '配速' }}</p>
          <div v-for="(row, i) in splitRows" :key="i" class="splitrow row">
            <!-- 左侧是第几公里：裸数字「1」「2」没有单位，补成「1 km」 -->
            <span class="k num">{{ row.label }} km</span>
            <div class="bar">
              <i :style="{ '--p': `${row.widthPct}%`, background: row.color }" />
            </div>
            <span class="v num">{{ row.text }}<b v-if="isCycle" class="unit">km/h</b></span>
          </div>
        </template>
      </template>

      <!-- 训练课：逐动作做组明细 -->
      <template v-else-if="detail?.source === 'course'">
        <!-- 时长/消耗排在最前：这行原本摊在 meta 灰字串里 —— 对一个课程记录来说，
             「这次练了多久/消耗多少」与组数容量同级重要，不能只做灰字 -->
        <div class="dgrid">
          <div class="cell"><div class="v num">{{ workout.durationMin }}</div><div class="k">时长 分钟</div></div>
          <div class="cell"><div class="v num">{{ workout.kcal }}</div><div class="k">消耗 大卡</div></div>
          <div class="cell"><div class="v num">{{ courseTotals.doneCount }}<span class="sub">/{{ courseTotals.totalCount }}</span></div><div class="k">完成组数</div></div>
          <div v-if="courseTotals.volume > 0" class="cell"><div class="v num">{{ courseTotals.volume }}</div><div class="k">总容量 kg</div></div>
          <div v-if="courseTotals.timedSec > 0" class="cell"><div class="v num">{{ fmtClock(courseTotals.timedSec) }}</div><div class="k">计时合计</div></div>
          <div v-if="courseTotals.volume <= 0 && courseTotals.timedSec <= 0" class="cell"><div class="v num">--</div><div class="k">暂无明细数据</div></div>
        </div>

        <!-- 肌群练够分提醒：紧接统计格 —— 上面那两个数字说的是「这次练了多少」，
             这里说的是「这次练的肌群，本周练够了没有」。数据与「本周练够分」卡同源。 -->
        <div v-if="muscleReminder" class="mvol">
          <div class="row between mvol-head">
            <span class="mv-t">肌群练够分 · 本周</span>
            <span class="mv-s" :class="{ low: muscleReminder.low > 0 }">
              {{ muscleReminder.low > 0 ? `${muscleReminder.low} 个仍不足` : '均已练够' }}
            </span>
          </div>
          <div v-for="m in muscleReminder.rows" :key="m.group" class="mv-row row">
            <span class="mv-n">{{ m.label }}</span>
            <span class="mv-barwrap"><i class="mv-bar" :class="m.score.score < 60 ? 'low' : m.score.score < 75 ? 'mid' : 'ok'" :style="{ '--p': `${loadPct(m.score)}%` }" /></span>
            <span class="mv-num num">{{ m.score.score }}<small> 分</small></span>
            <span class="mv-st" :class="m.score.score < 60 ? 'low' : m.score.score < 75 ? 'mid' : 'ok'">{{ statusLabel(m.score) }}</span>
          </div>
          <p class="mv-note">
            数字 = 本周练够分（0–100，满分即「运动充分」）· 条满格 = 100 分。分数按 频率/强度/体感 加权，间接刺激按激活档位折算，只取本周既有训练记录计算。
          </p>
        </div>

        <!-- 「提前结束」移出节标题做 warn 胶囊：它与节标题同字重时只靠颜色区分，
             而硬编码 #fa114f 正是令牌纪律要收编的那类魔法色 -->
        <div class="sec-wrap row between">
          <p class="sec">做组明细</p>
          <StatusChip v-if="courseTotals.earlyEnd" tone="warn" size="sm">提前结束</StatusChip>
        </div>
        <div v-for="row in courseRows" :key="row.key" class="excard">
          <div class="row exhead">
            <span class="exname">{{ row.name }}</span>
            <span class="num excount">{{ row.done.length }}/{{ row.plannedSets }} 组</span>
          </div>
          <div class="chips">
            <span v-for="(d, i) in row.warmups" :key="'w' + i" class="chip warm num">{{ warmupChip(row, d, i) }}</span>
            <span v-for="(d, i) in row.done" :key="i" class="chip num">{{ setChip(row, d) }}</span>
            <span v-for="i in Math.max(0, row.plannedSets - row.done.length)" :key="'miss' + i" class="chip miss">未完成</span>
          </div>
        </div>
      </template>

      <!-- 手动添加 / 快照不可用：概要 -->
      <template v-else-if="detail?.source === 'summary'">
        <div class="dgrid">
          <div class="cell"><div class="v num">{{ workout.durationMin }}</div><div class="k">时长 分钟</div></div>
          <div class="cell"><div class="v num">{{ workout.kcal }}</div><div class="k">消耗 大卡</div></div>
          <div class="cell"><div class="v">{{ effortCell.value }}</div><div class="k">{{ effortCell.key }}</div></div>
          <div class="cell"><div class="v">{{ typeLabel }}</div><div class="k">类型</div></div>
        </div>
        <p v-if="detail.fromSession" class="hint">
          该记录来自「{{ detail.fromSession.planName }}」，但没有可用的过程快照。
        </p>
      </template>

      <p v-if="workout.note" class="note t-3">{{ workout.note }}</p>

      <!-- 删除入口：触态下列表行尾的删除钮是隐藏的，这里是可见的那一条。
           不加图标只留文字，放在内容末尾（不占首屏），不与上面的数据抢层级。 -->
      <button type="button" class="del-row" @click="askDelete">删除这次训练</button>
    </template>
  </SheetModal>

  <!-- 删除确认层：与 WorkoutRecordsPage 行尾删除钮同一套（ActionSheet + danger 项） -->
  <ActionSheet
    :open="delOpen"
    title="删除后这条训练记录与逐组明细一并移除，力量曲线同步重算，且无法恢复"
    :actions="[{ label: '删除', value: 'delete', danger: true }]"
    @select="confirmDelete"
    @close="delOpen = false"
  />
</template>

<style scoped>
/* 标题行：名字 + 来源标签（只有手机同步的才有标签）。
   名字可截断，标签不吃压缩 —— 与 WorkoutRow 同一套排法 */
.name {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
}

.nm {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* meta 行：日期 / 时刻 / 类型三段一列排开，类型交给中性胶囊承载 ——
   同一行不许再用同一个「·」串起同权信息（那正是全清单最高频的写法问题） */
.meta {
  /* 标题与副信息 2（主次文本上下），行内三段信息之间 8 */
  margin-top: var(--gap-text);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 来源结论行：胶囊承载一行结论，口径说明已收进标题栏 InfoHint */
.srcline {
  margin-top: var(--sp-8);
}

/* 失败态：独立告警块，不用中性胶囊 —— 错误必须可见、且与说明文字形态有别。
   底走 --danger-soft、字走 --danger-strong（实底档 --danger 不当文字用） */
.failrow {
  margin-top: var(--sp-10);
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-m);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.failic {
  flex: none;
}

.sec {
  margin: var(--sp-18) 0 var(--sp-10);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  letter-spacing: 0.4px;
  color: var(--text-3);
}

/* 节标题行：结论胶囊与标题同行右端。胶囊不塞进 <p class="sec"> ——
   .sec 的 letter-spacing 会漏进胶囊，且标题是块级元素、胶囊要跟着它同行 */
.sec-wrap {
  margin: var(--sp-18) 0 var(--sp-10);
}

.sec-wrap .sec {
  margin: 0;
}

.hint {
  margin-top: var(--sp-12);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 轨迹块沿用跑步沉浸页的暗色语言 */
.routebox {
  position: relative;
  /* 轨迹图容器按二级分组面：半径 16、四边同距 12（原来三边 10/8 不等） */
  margin-top: var(--gap-md);
  border-radius: var(--radius-m);
  padding: var(--pad-card-tight);
  background: var(--hero-bg);
  background-image:
    linear-gradient(var(--hero-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-grid) 1px, transparent 1px);
  background-size: 28px 28px;
}

.routebox svg {
  display: block;
  width: 100%;
}

.routeline {
  fill: none;
  stroke: var(--hero-route-line);
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 6px var(--hero-route-glow));
}

.mk-start {
  fill: var(--hero-text);
}

.mk-end {
  fill: var(--hero-bg);
  stroke: var(--hero-route-line);
  stroke-width: 3;
}

.route-empty {
  padding: var(--sp-44) 0;
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--hero-text-dim);
}

.goal {
  margin: var(--sp-4) var(--sp-4) var(--sp-2);
  /* 「目标 5 km · 已达成」是用户自己定的目标与结论，不吃 11px */
  font-size: var(--fs-caption);
  color: var(--hero-text-dim);
}

.splitrow {
  gap: var(--sp-10);
  margin: var(--sp-8) 0;
}

.splitrow .k {
  width: 52px;
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-align: right;
}

.bar {
  flex: 1;
  height: 14px;
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  overflow: hidden;
}

.bar i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.splitrow .v {
  width: 64px;
  text-align: right;
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.splitrow .v .unit {
  margin-left: var(--sp-2);
  /* 配速值后的单位后缀（km/h），装饰性微字 */
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.dgrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-md);
  margin-top: var(--sp-16);
}

/* ---------- 肌群练够分提醒 ----------
   与统计格同一块「次级底」（--surface-2），但用圆角 + 行内条把它读成"一组数据"
   而不是又一张卡：这一块是解释性的补充，不该和上面的完成组数/总容量抢层级。 */
.mvol {
  margin-top: var(--gap-md);
  /* 四边同距 12，与 .routebox / .cell 同一套内距 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.mvol-head {
  gap: var(--gap-sm);
  margin-bottom: var(--sp-8);
}

.mv-t {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.mv-s {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  /* 「均已练够」是状态词：次要标签走中性色（色彩配额，STANDARDS §4） */
  color: var(--text-2);
}

/* 有不足（练够分 < 60）时提到主字色一档 —— 「N 个仍不足」是数值 + 告警；
   颜色只落在下方的条上（.mv-bar.low），文字保持中性 */
.mv-s.low {
  color: var(--text-1);
}

.mv-row {
  display: grid;
  grid-template-columns: 74px 1fr 52px 30px;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-4) 0;
}

.mv-n {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mv-barwrap {
  height: 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  overflow: hidden;
}

.mv-bar {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--heat-enough);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

/* 练够分条的底与 MuscleMap 同源（红 / 琥珀 / 绿）：
   < 60 = 红（该补），60–74 = 琥珀（基本够），≥ 75 = 绿（足够）。
   此前只有「不足」上青色（--c-balance）—— 青是方案/均衡的识别色，不是告警色，
   与运动橙也没有语义关系；条长已经表达分数，颜色只表达「过没过线」。 */
.mv-bar.low {
  background: var(--heat-low);
}

.mv-bar.mid {
  background: var(--heat-near);
}

.mv-bar.ok {
  background: var(--heat-enough);
}

.mv-num {
  text-align: right;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.mv-num small {
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.mv-st {
  /* 「运动充分」这类档名是练够分的结论词，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  text-align: right;
  color: var(--text-3);
}

.mv-st.low {
  /* 「不足」是告警档名：提到主字色一档，告警色相留在 .mv-bar 上 */
  color: var(--text-1);
}

.mv-note {
  margin-top: var(--sp-6);
  /* 分数口径说明，是「怎么读这个数」的解释文字 */
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-3);
}

.cell {
  background: var(--surface-2);
  border-radius: var(--radius-m);
  /* 参数格四边同距 16（--pad-card） */
  padding: var(--pad-card);
}

.cell .v {
  font-size: var(--fs-title1);
  /* 字重阶梯下限 300（--fw-light）：200 是阶梯外裸值 */
  font-weight: var(--fw-light);
  letter-spacing: -0.5px;
}

.cell .v .sub {
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.cell .k {
  /* 统计格字段名（「完成组数」）不吃 11px；同格的单位后缀（.v .sub）已在 callout 档。
     颜色走 --text-2：统计格的字段名是「这个数字是什么」的**必读**标签，
     与动作详解抽屉的 `.cell .k` 同档（决策见 docs/exercise-quality-review-2026-10-17.md §8 D3）。 */
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-top: var(--sp-2);
}

.excard {
  padding: var(--sp-12) 0;
}

.excard:not(:first-of-type) {
  border-top: 0.5px solid var(--line);
}

.exhead {
  gap: var(--gap-sm);
}

.exname {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.excount {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  margin-top: var(--sp-8);
}

.chip {
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  /* 「60×8」是登记值：数值中性色，色相留在 soft 底的色块上（色彩配额，STANDARDS §4） */
  background: var(--c-exercise-soft);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 热身组：中性描边样式与正式组区分 */
.chip.warm {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong, var(--line));
  color: var(--text-3);
  font-weight: var(--fw-medium);
}

.chip.miss {
  background: var(--surface-2);
  color: var(--text-3);
  font-weight: var(--fw-regular);
}

.note {
  margin-top: var(--sp-14);
  font-size: var(--fs-caption);
}

/* 删除入口：一条独立的危险动作行。放在内容流末尾而不是钉底 —— 抽屉内容可滚动，
   钉底会一直占着一块；这里是「看完再决定」的位置，也远离上面的数据区，不易误触。
   文案用「删除」两字 + danger 色，不说「确定」「移除」这类含糊词。
   字色走 --danger-strong：实底档 --danger 当小字文字只有约 3.55:1，过不了 AA
   （tokens.css:163-168 的两档分工：文字一律用 --*-strong）。 */
.del-row {
  display: block;
  width: 100%;
  margin-top: var(--sp-20);
  padding: var(--sp-12) 0;
  border-top: 0.5px solid var(--line);
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--danger-strong);
}

.del-row:active {
  opacity: 0.55;
}
</style>
