<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Check, Dumbbell, Play, Sparkles } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { sessionService } from '@/services/sessionService'
import { useAiStore } from '@/stores/ai'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { usePlanStore } from '@/stores/plan'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import { openImmersive } from '@/system/sessionImmersive'
import { SCORE_GROUP_LABELS, type ScoreGroupKey } from '@/config/muscles'
import type { WorkoutPlan, WorkoutPlanRecord } from '@/types'
import type { GroupScore } from '@/utils/trainingScore'
import {
  buildCatchupPlan,
  catchupPrompt,
  gapOf,
  matchCourse,
  pickCatchup,
  type CatchupPick,
  type CoursePick,
  type MusclesResolver,
} from '@/utils/weakMuscles'

/**
 * 弱项加练：把「本周练得不够的肌群」变成一节**能直接开练的课**。
 *
 * 三层，按「库里有就先用库里的」排序：
 *  0. **课程库里现成的那节**（`matchCourse`）—— 训练目的与弱项高度一致时直接推荐它。
 *     用户自己配好的课有他的重量、习惯与历史，比现场拼的草稿可信；也没有理由让同一个人
 *     把同一节课排两遍，一遍存进课程库、一遍现场拼。
 *  1. **本地拼的临时课**（纯函数，见 utils/weakMuscles）—— 库里没有对症的课时打开即见，
 *     不依赖模型。补弱这件事的规则本身是确定的（缺多少组 → 用哪个主攻动作 → 补几组），
 *     让模型从零生成反而会引入不可复核的自由度。
 *  2. **再交给 AI 细化** —— 弱项、现成课与草稿一起送过去，模型有得改。
 *     模型没配也不影响前两层：按钮退化成「看一眼我该练什么」。
 *
 * 「临时」是真的临时：临时课只活在内存里，`session.start()` 直接开练，
 * **不写进课程库** —— 它是「今天补一下」，不是「我的训练计划」。
 */
const props = defineProps<{ open: boolean; weak: GroupScore[] }>()
const emit = defineEmits<{ close: [] }>()

const lib = useExerciseLibStore()
const plans = usePlanStore()
const session = useSessionStore()
const ai = useAiStore()
const toast = useToast()
const router = useRouter()

const picks = ref<CatchupPick[]>([])
const course = ref<CoursePick<WorkoutPlanRecord> | null>(null)
const loading = ref(false)
const starting = ref(false)
const conflictOpen = ref(false)

/** 动作 → 肌群表：与主页练卡同一句口径（库内数据优先，课程条目自带其次，名称规则兜底） */
const planMuscles: MusclesResolver = (item) => lib.musclesOf(item)

/** 用户练过的动作 id：优先从这些里挑（不用重新学动作，重量也有底） */
async function loadHistoryIds(): Promise<Set<string>> {
  try {
    const refs = await sessionService.strengthExercises()
    return new Set(refs.map((r) => r.exerciseId).filter((x): x is string => !!x))
  } catch {
    return new Set()
  }
}

async function prepare(): Promise<void> {
  loading.value = true
  try {
    // 课程库与动作库一起等：匹配现成课要前者，挑主攻动作要后者
    await Promise.all([lib.ensureLoaded(), plans.ensureLoaded()])
    const history = await loadHistoryIds()
    picks.value = pickCatchup(props.weak, lib.list, history)
    course.value = matchCourse(props.weak, plans.plans, planMuscles)
  } catch (e) {
    console.warn('[catchup] 组装失败', e)
    picks.value = []
    course.value = null
  } finally {
    loading.value = false
  }
}

// 每次打开重算（训练数据可能刚变），而不是 mounted 一次
watch(
  () => props.open,
  (o) => {
    if (o) void prepare()
  },
)

const plan = computed(() => buildCatchupPlan(picks.value))

/** 该评估组是不是这门课补到的弱项（模板里给 chip 上高亮） */
function isHit(g: ScoreGroupKey): boolean {
  return course.value?.hits.some((h) => h.group === g) ?? false
}

const hitLabels = computed(() => course.value?.hits.map((h) => h.label).join('、') ?? '')

/** 现成课的规模：动作数 +（有标注才说的）预估时长 */
const courseMeta = computed(() => {
  const c = course.value?.course
  if (!c) return ''
  return `${c.exercises.length} 个动作${c.estDurationMin ? ` · 约 ${c.estDurationMin} 分钟` : ''}`
})

/** 开场白：说清这次优先走哪条路（有现成课就优先它） */
const lede = computed(() =>
  course.value
    ? '课程库里有一节现成的课，训练目的与你的弱项高度一致 —— 优先练它；不想练它，就用下面的临时草稿。'
    : '本周练得不够的肌群，已按缺口排好一节临时课程。它不会存进课程库 —— 开练即用，练完即弃。',
)

/** 面上结论：有现成课优先它，没有就明说临时课不入库 */
const routeChip = computed(() => (course.value ? '优先练它（课程库现成课）' : '临时课 · 不入库'))

/** 「交给 AI 调整」的说明：有现成课时送去的是「核对这节课」，不是「从零重排」 */
const hint = computed(() =>
  course.value
    ? '「交给 AI 调整」会把弱项、这节课与备选草稿一起送进对话，由模型判断现成的课要不要动 —— 那句话在 AI 页是直接发出的（与「交给 AI 排查」同一条路径），不需要再点一次发送。'
    : '「交给 AI 调整」会把弱项与上面的草稿一起送进对话，由模型重新排一遍并说明理由 —— 那句话在 AI 页是直接发出的（与「交给 AI 排查」同一条路径），不需要再点一次发送。',
)

/**
 * 开场白与「交给 AI 调整」的说明都收进标题行右侧那枚 InfoHint（同一屏只有一枚 ?）。
 * 面上只留两行胶囊结论：走哪条路、AI 按钮点什么效果。
 */
const hintContent = computed(() => `${lede.value}\n\n${hint.value}`)

/**
 * 弱项 + 跳过的，**合成一个列表**。
 *
 * 不是为了绕开什么 bug（两个相邻 v-for 在 Vue 3 里是合法的），
 * 而是两件事确实属于同一个序列：「已经排到动作的」与「动作库缺主攻动作、跳过的」
 * 都是这次判定的一部分。分两组渲染会让「跳过」那几条沉到列表末尾、
 * 读起来像附注；合起来才能按同一规则（缺口降序）排在它们该在的位置。
 */
interface WeakRow {
  group: ScoreGroupKey
  label: string
  gap: number
  /** 已排到的动作名；空 = 动作库缺主攻动作，跳过了 */
  exercises: string
  skipped: boolean
}

const rows = computed<WeakRow[]>(() => {
  const done = picks.value.map((p) => ({
    group: p.group,
    label: p.label,
    gap: p.gap,
    exercises: p.exercises.map((e) => e.name).join(' · '),
    skipped: false,
  }))
  const rest = props.weak
    .filter((w) => !picks.value.some((p) => p.group === w.group))
    .map((w) => ({ group: w.group, label: w.label, gap: gapOf(w), exercises: '', skipped: true }))
  // 缺口降序：最该补的排最前，跳过的也按同一条规则落在它该在的位置
  return [...done, ...rest].sort((a, b) => b.gap - a.gap)
})

const totalSets = computed(() => plan.value.exercises.reduce((n, e) => n + e.sets, 0))

/** 冲突（已有进行中的训练）走同一条出路：说清楚 + 去接续 */
async function begin(p: WorkoutPlan): Promise<void> {
  if (starting.value) return
  starting.value = true
  try {
    const r = await session.start(p)
    if (r === 'conflict') {
      conflictOpen.value = true
      return
    }
    emit('close')
    openImmersive(null)
  } catch {
    // 开课失败的可视回执由 store 内的 toast 负责（session.start 原样抛）；
    // 这里只吞掉拒绝，避免 unhandled rejection，finally 复位按钮供重试。
  } finally {
    starting.value = false
  }
}

/** 开练现成课：与开临时课同一条路，只是课来自课程库（session.start 里会维护「最近使用」） */
async function startCourse(): Promise<void> {
  const c = course.value?.course
  if (!c) return
  await begin(c)
}

async function startTraining(): Promise<void> {
  if (!plan.value.exercises.length) return
  await begin(plan.value)
}

/**
 * 交给 AI：带上弱项、（有现成课时的）现成课与草稿，跳到 AI 页让模型重排一遍。
 *
 * `askFrom` 递过去的那句话在 AI 页是**直接发送**的（与抢课「交给 AI 排查」同一条路径：
 * 那个场景下最缺的就是时间，不该再让人按一次发送）。这里同理 ——
 * 用户点「交给 AI 调整」的意图就是「让它去做」，所以文案也按"已开始生成"写，
 * 不承诺一个不存在的确认步骤。
 */
function handToAi(): void {
  ai.askFrom(catchupPrompt(picks.value, plan.value, course.value?.course ?? null))
  emit('close')
  void router.push({ name: 'ai' })
  toast.toast(course.value ? '已交给 AI，正在核对这节课…' : '已交给 AI，正在按弱项重排…')
}

function goConflict(): void {
  conflictOpen.value = false
  emit('close')
  if (session.foreignRoute) void router.push(session.foreignRoute)
  else openImmersive(null)
}
</script>

<template>
  <SheetModal :open="open" title="弱项加练" initial-snap="large" @close="emit('close')">
    <!-- 两条路的分工与「交给 AI 调整」的行为：收进标题行右侧 InfoHint，面上只留结论 -->
    <template #action>
      <InfoHint title="弱项加练怎么走" :content="hintContent" />
    </template>

    <p class="lede">
      <StatusChip :tone="course ? 'accent' : 'neutral'" size="md">{{ routeChip }}</StatusChip>
    </p>

    <!-- 弱项清单：先说清「缺什么」，再说「练什么」 -->
    <ul class="weaklist">
      <li v-for="r in rows" :key="r.group" class="wrow" :class="{ muted: r.skipped }">
        <span class="wname">{{ r.label }}</span>
        <span class="wgap num">差 {{ r.gap }} 组</span>
        <span v-if="r.skipped" class="wex t-3">动作库没有以它为主攻的动作（只能靠复合动作间接补）</span>
        <span v-else class="wex t-2">{{ r.exercises }}</span>
      </li>
    </ul>

    <!-- 现成课程：课程库里已配置好的那一节，训练目的（= 主攻的评估组）与弱项高度一致。
         命中的组高亮并打勾 —— 不写「相似度 0.67」这种数，课程冲谁排的一眼就能看出来。 -->
    <section v-if="course" class="rc" data-testid="catchup-course">
      <div class="rc-head row between">
        <span class="rc-k">课程库里正好有</span>
        <span class="rc-meta num">{{ courseMeta }}</span>
      </div>
      <p class="rc-name">{{ course.course.name }}</p>
      <div class="rc-groups">
        <span v-for="g in course.groups" :key="g" class="rc-g" :class="{ on: isHit(g) }">
          <Check v-if="isHit(g)" :size="11" :stroke-width="3.2" aria-hidden="true" />{{ SCORE_GROUP_LABELS[g] }}
        </span>
      </div>
      <p class="rc-why">主攻 {{ course.groups.length }} 个部位，其中 <b>{{ hitLabels }}</b> 正是你的弱项</p>
    </section>

    <!-- 临时课程草稿 -->
    <div class="draft">
      <div class="dhead row between">
        <span class="dt">临时课程草稿<template v-if="course">（备选）</template></span>
        <span class="ds num">{{ plan.exercises.length }} 个动作 · 共 {{ totalSets }} 组</span>
      </div>
      <ul v-if="plan.exercises.length" class="dlist">
        <li v-for="e in plan.exercises" :key="e.id" class="drow">
          <i class="dic"><Dumbbell :size="14" /></i>
          <span class="dname flex-1">{{ e.name }}</span>
          <span class="dsets num">{{ e.sets }} × {{ e.reps ?? '—' }}</span>
        </li>
      </ul>
      <p v-else class="dhint t-3">
        {{ loading ? '正在挑动作…' : course ? '这一节的弱项都由上面的课覆盖了，不必再拼草稿。' : '没有可补的肌群，或动作库里缺少对应的主攻动作。' }}
      </p>
    </div>

    <!-- 有现成课时它是主操作（开课），临时草稿退成备选 —— 一次只有一枚实底按钮 -->
    <div class="acts">
      <button
        v-if="course"
        class="primary row center"
        type="button"
        data-testid="catchup-start-course"
        :disabled="starting"
        @click="startCourse"
      >
        <Play :size="16" fill="currentColor" />
        {{ starting ? '准备中…' : `开练「${course.course.name}」` }}
      </button>
      <button
        v-if="!course || plan.exercises.length"
        class="row center"
        :class="course ? 'ghost' : 'primary'"
        type="button"
        data-testid="catchup-start-draft"
        :disabled="!plan.exercises.length || starting"
        @click="startTraining"
      >
        <Play v-if="!course" :size="16" fill="currentColor" />
        {{ starting ? '准备中…' : course ? '按临时草稿练' : '开始训练' }}
      </button>
      <button
        class="ghost row center"
        type="button"
        :disabled="!course && !plan.exercises.length"
        @click="handToAi"
      >
        <Sparkles :size="15" />
        交给 AI 调整
      </button>
    </div>
    <!-- AI 按钮的行为一句话结论；「送什么进对话、直接发送」的细节在标题 InfoHint 里 -->
    <p class="hint"><StatusChip tone="neutral" size="sm">点一下就去 AI，无需再发送</StatusChip></p>

    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练"
      :actions="[{ label: '前往接续', value: 'go' }]"
      @close="conflictOpen = false"
      @select="goConflict"
    />
  </SheetModal>
</template>

<style scoped>
.lede {
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.weaklist {
  margin-top: var(--sp-14);
  display: flex;
  flex-direction: column;
}

.wrow {
  display: grid;
  grid-template-columns: 84px 62px 1fr;
  align-items: baseline;
  gap: var(--gap-sm);
  padding: var(--sp-8) 0;
  border-bottom: 0.5px solid var(--line);
}

.wrow.muted .wname,
.wrow.muted .wgap {
  color: var(--text-3);
}

.wname {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.wgap {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  /* 「差 N 组」是数值：中性色（色彩配额，STANDARDS §4） */
  color: var(--text-1);
}

.wex {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  min-width: 0;
}

/* 现成课程：这张抽屉里唯一的**推荐**块，用 accent-soft 底与草稿的中性底分开。
   色相交给前景（--accent-strong），底保持同色低透明 —— 与 tokens 里那条语义色约定一致。 */
.rc {
  margin-top: var(--sp-14);
  padding: var(--sp-12) var(--sp-14);
  border-radius: var(--radius-m);
  background: var(--accent-soft);
}

.rc-head {
  gap: var(--gap-sm);
}

.rc-k {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--accent-strong);
}

.rc-meta {
  flex: none;
  font-size: var(--fs-micro);
  /* 压在 accent-soft 上，比 text-3 提一档（text-3 在这层蓝底上只剩 ~3:1） */
  color: var(--text-2);
}

.rc-name {
  margin-top: var(--sp-4);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
}

/* 主攻组 chip：命中的那几枚打勾 + 实底，其余保持素底 —— 一眼看出这门课冲谁排的 */
.rc-groups {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-tight);
  margin-top: var(--sp-8);
}

.rc-g {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.rc-g.on {
  background: var(--accent);
  color: var(--on-accent);
}

.rc-why {
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.rc-why b {
  color: var(--text-1);
}

.draft {
  margin-top: var(--sp-16);
  padding: var(--sp-12) var(--sp-14);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.dhead {
  margin-bottom: var(--sp-8);
}

.dt {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
}

.ds {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.dlist {
  display: flex;
  flex-direction: column;
}

.drow {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-6) 0;
}

.drow + .drow {
  border-top: 0.5px solid var(--line);
}

.dic {
  width: 24px;
  height: 24px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.dname {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsets {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.dhint {
  padding: var(--sp-8) 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.acts {
  margin-top: var(--sp-16);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.primary {
  gap: var(--sp-6);
  padding: var(--sp-12) var(--sp-18);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.ghost {
  gap: var(--sp-6);
  padding: var(--sp-12) var(--sp-18);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.primary:disabled,
.ghost:disabled {
  opacity: var(--disabled-opacity);
}

.hint {
  margin-top: var(--sp-10);
  font-size: var(--fs-micro);
  line-height: var(--lh-body);
  color: var(--text-3);
}
</style>
