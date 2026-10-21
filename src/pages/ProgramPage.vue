<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Archive,
  CheckCircle2,
  ChevronRight,
  Circle,
  Info,
  ShoppingBag,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import PillChip from '@/components/common/PillChip.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ProgramCompare from '@/components/program/ProgramCompare.vue'
import ProgramConstraints from '@/components/program/ProgramConstraints.vue'
import ProgramEvidenceSheet from '@/components/program/ProgramEvidenceSheet.vue'
import ProgramReviewSheet from '@/components/program/ProgramReviewSheet.vue'
import { planService } from '@/services/planService'
import { copyText } from '@/utils/clipboard'
import {
  amountText,
  groupShoppingRows,
  shoppingListText,
  type CheckedRow,
} from '@/utils/shoppingList'
import { GOAL_LABELS } from '@/config/domain'
import { useModelsStore } from '@/stores/models'
import { useNutritionStore } from '@/stores/nutrition'
import {
  DEFAULT_PROGRAM_WEEKS,
  defaultStartDate,
  useProgramStore,
} from '@/stores/program'
import { markReviewed, programStatus } from '@/utils/programCycle'
import type {
  ProgramAdjustment,
  ProgramPlan,
  ProgramRecord,
  ProgramStart,
  ProgramTier,
} from '@/types'
import { recordCardOutcome } from '@/ai/cardOutcomes'
import { ADJUSTMENT_LIMITS, parseBlob, type AdjustmentPatch } from '@/utils/programEngine'
import { constraintSnapshotOf, sameConstraint, type ConstraintSnapshot } from '@/utils/programSetup'
import {
  buildReviewPayload,
  buildWeekCompare,
  reviewProgram,
  type WeekCompare,
} from '@/ai/programReview'

/**
 * 健康方案：程序计算三档基线方案（保守/均衡/进取），展开到日程级；
 * AI 只负责基于执行数据的参数复盘，且必须经用户确认、引擎钳制后生效。
 *
 * 页面只做两件事：无方案时「制定」（约束向导 + 三档对比），
 * 有方案时「一屏管理」（状态条 + 复盘 / 采购 / 调参 + 历史）。
 * 执行发生在日常界面：训练在画布（点课程块直接开课），菜单与目标在营养页。
 */
const route = useRoute()
const router = useRouter()
const store = useProgramStore()
const n = useNutritionStore()
const models = useModelsStore()

type Phase = 'loading' | 'setup' | 'active'
const phase = ref<Phase>('loading')

onMounted(async () => {
  await Promise.all([store.load(), n.loadProfile()])
  phase.value = store.active ? 'active' : 'setup'
  // 课程名（首练选择的展示用），失败不影响主流程
  planService
    .list()
    .then((ps) => {
      courseNames.value = Object.fromEntries(ps.map((x) => [x.id, x.name]))
    })
    .catch(() => undefined)
  maybeAutoReview()
})

/** 主页状态卡 / 桌面右栏的「本周复盘」深链：进入即发起；已在页时只变 query，
 *  也要能触发——所以挂在 watcher 上，而不是只在 onMounted 里读一次。
 *  发起后立刻摘掉 query，避免回退或刷新时重跑（一次复盘要调模型）。 */
function maybeAutoReview(): void {
  if (!store.active || route.query.review !== '1') return
  void router.replace({ name: 'program' })
  void startReview()
}

watch(() => route.query.review, () => maybeAutoReview())

/* ---------------- 生成流 ---------------- */

const generating = ref(false)
const drafts = ref<ProgramPlan[] | null>(null)
const selectedTier = ref<ProgramTier>('balanced')
const activating = ref(false)
const confirmOpen = ref(false)

/** 开始日与首练：提前开跑 + 相位平移（接续当前训练节奏）。
 * 状态在向导内维护，经 start-change 即时回传；这里只消费。 */
const start = ref<ProgramStart>({ startMode: 'next', firstCourseId: null, phase: 0, startDate: defaultStartDate() })

const startLabel = computed(() =>
  start.value.startMode === 'today' ? '今天' : start.value.startMode === 'tomorrow' ? '明天' : '下周一',
)

/** 课程 id → 名称（首练选择的展示用） */
const courseNames = ref<Record<string, string>>({})

const selectedPlan = computed(
  () => drafts.value?.find((d) => d.tier === selectedTier.value) ?? null,
)

/** 生成时的约束快照：之后约束又改过 → 提示重新计算 */
const draftSnap = ref<ConstraintSnapshot | null>(null)
const constraintsStale = computed(() => {
  if (!drafts.value || !draftSnap.value || !n.profile) return false
  return !sameConstraint(draftSnap.value, constraintSnapshotOf(n.profile, {
    startMode: start.value.startMode,
    firstCourseId: start.value.firstCourseId,
  }))
})

async function generate(): Promise<void> {
  generating.value = true
  try {
    drafts.value = await store.generateDrafts(start.value.startDate, DEFAULT_PROGRAM_WEEKS, start.value.phase)
    if (n.profile) {
      draftSnap.value = constraintSnapshotOf(n.profile, {
        startMode: start.value.startMode,
        firstCourseId: start.value.firstCourseId,
      })
    }
    if (!drafts.value.some((d) => d.tier === selectedTier.value)) selectedTier.value = 'balanced'
  } finally {
    generating.value = false
  }
}

function askActivate(): void {
  if (selectedPlan.value?.feasible) confirmOpen.value = true
}

async function activate(): Promise<void> {
  if (!selectedPlan.value) return
  activating.value = true
  try {
    await store.activate(selectedPlan.value)
    confirmOpen.value = false
    drafts.value = null
    phase.value = 'active'
  } finally {
    activating.value = false
  }
}

/* ---------------- 生效方案展示 ---------------- */

/**
 * 方案数据可能损坏（params_json 被外部改写 / 版本不兼容）。解析失败不能让整页
 * 崩在 computed 里，降级成明确的错误提示；解析成功与失败成对返回，避免在
 * computed 内写 ref 造成副作用。
 */
const parsedBlob = computed<{ blob: ReturnType<typeof parseBlob> | null; error: string }>(() => {
  if (!store.active) return { blob: null, error: '' }
  try {
    return { blob: parseBlob(store.active), error: '' }
  } catch (e) {
    return { blob: null, error: e instanceof Error ? e.message : '方案数据损坏，无法解析' }
  }
})
const blob = computed(() => parsedBlob.value.blob)
const blobError = computed(() => parsedBlob.value.error)

/** 周期口径：起止 / 周次 / 进度 / 是否结束（主页状态卡同源） */
const status = computed(() =>
  store.active && blob.value ? programStatus(store.active, blob.value) : null,
)
const isEnded = computed(() => status.value?.ended ?? false)

/** 状态条展开（静态参数详情） */
const stripOpen = ref(false)

const activeTierLabel = computed(() =>
  store.active?.tier === 'conservative' ? '保守' : store.active?.tier === 'aggressive' ? '进取' : '均衡',
)

/** 调整历史（倒序展示，最近一次在前） */
const adjustments = computed<ProgramAdjustment[]>(() => {
  if (!store.active) return []
  try {
    const arr = JSON.parse(store.active.adjustmentsJson || '[]') as ProgramAdjustment[]
    return Array.isArray(arr) ? [...arr].reverse() : []
  } catch {
    // 调整历史损坏只影响历史列表，不应连带整页白屏
    return []
  }
})

/** 科学依据（三条研究曲线）弹层 */
const evidenceOpen = ref(false)
/** 弹层里高亮的档位：生效方案优先，setup 阶段跟随当前选中的草稿 */
const evidenceTier = computed<ProgramTier>(() => {
  const active = store.active?.tier
  if (active) return active
  const sel = selectedTier.value
  return sel === 'conservative' || sel === 'aggressive' ? sel : 'balanced'
})

/* ---------------- 手动调整 ---------------- */

const adjustOpen = ref(false)
const adjusting = ref(false)
const patchDelta = ref(-400)
const patchProtein = ref(1.8)
const patchDays = ref(4)
const manualSummary = ref('手动调整')

function openAdjust(): void {
  const p = blob.value?.params
  if (!p) return
  patchDelta.value = p.kcalDelta
  patchProtein.value = p.proteinPerKg
  patchDays.value = p.trainingDays
  adjustOpen.value = true
}

async function applyManual(): Promise<void> {
  if (!store.active) return
  adjusting.value = true
  try {
    await store.adjust(
      store.active,
      { kcalDelta: patchDelta.value, proteinPerKg: patchProtein.value, trainingDays: patchDays.value },
      manualSummary.value.trim() || '手动调整',
      'manual',
    )
    adjustOpen.value = false
  } finally {
    adjusting.value = false
  }
}

/* ---------------- AI 周复盘（卡片流：数据先行 + 单条采纳） ---------------- */

interface ReviewState {
  phase: 'running' | 'done' | 'error'
  diagnosis: string
  advice: string[]
  /** 模型原始建议（未经钳制；钳制在弹层内按勾选子集实时试算） */
  proposed: AdjustmentPatch
  error: string
}
const reviewOpen = ref(false)
const review = ref<ReviewState>({ phase: 'running', diagnosis: '', advice: [], proposed: {}, error: '' })
const reviewCompare = ref<WeekCompare | null>(null)

async function startReview(): Promise<void> {
  if (!store.active) return
  reviewOpen.value = true
  review.value = { phase: 'running', diagnosis: '', advice: [], proposed: {}, error: '' }
  // 数据先行区与 AI 请求并行：模型慢的时候对比条已经在了
  reviewCompare.value = null
  const comparePromise = buildWeekCompare().then(
    (c) => (reviewCompare.value = c),
    () => undefined,
  )
  try {
    await models.load()
    const cfg = models.defaultModel()
    if (!cfg) throw new Error('未配置 AI 模型，请先在「AI › 管理模型」添加')
    const payload = await buildReviewPayload(store.active)
    const sug = await reviewProgram(cfg, payload, (partial) => {
      // 流式：诊断文本边生成边上屏（phase 保持 running）
      review.value = { ...review.value, diagnosis: partial }
    })
    review.value = {
      phase: 'done',
      diagnosis: sug.diagnosis,
      advice: sug.advice,
      proposed: sug.changes,
      error: '',
    }
    // 复盘完成即重新计时，主页的「本周复盘」提醒满 7 天后再出现
    markReviewed(store.active.id)
  } catch (e) {
    review.value = { ...review.value, phase: 'error', error: e instanceof Error ? e.message : String(e) }
  }
  await comparePromise
}

/** 弹层「应用」：只提交勾选的子集（钳制在 store.adjust 内仍会再走一遍） */
async function applyReview(patch: AdjustmentPatch, summary: string): Promise<void> {
  if (!store.active) return
  await store.adjust(store.active, patch, summary, 'ai')
  // 逐条采纳的结果落在 adjustments_json（模型查得到），查不到的是「刚采纳了复盘建议」这条因果。
  // 只记这条界面链路；聊天工具 adjust_program 那条不记（模型自己刚做完，再报一遍是噪音）
  recordCardOutcome('program-review', `方案复盘采纳调整 —— ${summary}`)
  reviewOpen.value = false
}

/* ---------------- 本周采购清单（未来 7 天菜单食材聚合 + 勾选已买） ---------------- */

const SHOP_HORIZON_DAYS = 7

const shoppingOpen = ref(false)
const shoppingLoading = ref(false)
const shoppingError = ref('')
const shoppingRows = ref<CheckedRow[]>([])
const shoppingRangeLabel = ref('')
const shoppingAiDays = ref(0)
const shoppingTemplateDays = ref(0)
const shoppingCopied = ref(false)
const shoppingCopyErr = ref('')

/**
 * 区间段：`rangeLabel` 形如「1月6日 – 1月12日 · 7 天」（真源在 stores/program.ts）。
 * 总天数与来源在卡面上拆成独立读数（主数值胶囊 + 两颗来源胶囊），所以这里只取日期段 ——
 * 尾部的「 · N 天」由 shop-total 承担，同一屏不再把总数说两遍。
 */
const shoppingRangeOnly = computed(() => shoppingRangeLabel.value.split(' · ')[0])
/** 覆盖天数 = AI 菜单天数 + 模板菜单天数（与 store 里 rangeLabel 的加法同一把尺） */
const shoppingTotalDays = computed(() => shoppingAiDays.value + shoppingTemplateDays.value)
const shoppingGroups = computed(() => groupShoppingRows(shoppingRows.value))
const shoppingHasTemplate = computed(() => shoppingTemplateDays.value > 0)
const shoppingCheckedCount = computed(() => shoppingRows.value.filter((r) => r.checked).length)

async function openShopping(): Promise<void> {
  if (!store.active) return
  shoppingOpen.value = true
  shoppingLoading.value = true
  shoppingError.value = ''
  shoppingCopied.value = false
  shoppingCopyErr.value = ''
  try {
    const res = await store.buildShopping(store.active, SHOP_HORIZON_DAYS)
    shoppingRows.value = res.rows
    shoppingRangeLabel.value = res.rangeLabel
    shoppingAiDays.value = res.aiDays
    shoppingTemplateDays.value = res.templateDays
  } catch (e) {
    shoppingError.value = e instanceof Error ? e.message : String(e)
  } finally {
    shoppingLoading.value = false
  }
}

/** 勾选/取消一个采购项（乐观更新，失败回滚）；已勾行从复制全文剔除 */
async function toggleCheck(row: CheckedRow): Promise<void> {
  const next = !row.checked
  row.checked = next
  try {
    await store.setShoppingCheck(row.key, next)
  } catch {
    row.checked = !next
  }
}

async function clearChecks(): Promise<void> {
  try {
    await store.clearShoppingChecks()
    for (const r of shoppingRows.value) r.checked = false
  } catch {
    /* 清空失败保持原状，下一次打开会重新对齐 */
  }
}

async function copyShopping(): Promise<void> {
  shoppingCopied.value = false
  shoppingCopyErr.value = ''
  try {
    await copyText(
      shoppingListText({
        rows: shoppingRows.value,
        rangeLabel: shoppingRangeLabel.value,
        aiDays: shoppingAiDays.value,
        templateDays: shoppingTemplateDays.value,
      }),
    )
    shoppingCopied.value = true
    setTimeout(() => (shoppingCopied.value = false), 1800)
  } catch {
    shoppingCopyErr.value = '复制失败，请重试'
  }
}

/* ---------------- 归档 / 删除 ---------------- */

const deleteArmed = ref(false)

async function archiveCurrent(): Promise<void> {
  if (!store.active) return
  await store.archive(store.active.id)
  phase.value = 'setup'
}

async function deleteCurrent(): Promise<void> {
  if (!store.active) return
  if (!deleteArmed.value) {
    deleteArmed.value = true
    return
  }
  await store.remove(store.active.id)
  deleteArmed.value = false
  phase.value = 'setup'
}

/* ---------------- 历史方案（结营成绩单入口） ---------------- */

const archivedList = computed(() => store.history.filter((r) => r.status === 'archived'))

function tierLabel(tier: ProgramRecord['tier']): string {
  return tier === 'conservative' ? '保守' : tier === 'aggressive' ? '进取' : '均衡'
}

function openWrapup(r: ProgramRecord): void {
  void router.push(`/program/wrapup/${r.id}`)
}

function reportSpanOf(r: ProgramRecord): string {
  try {
    const b = parseBlob(r)
    const s = b.days[0]?.date ?? r.activatedAt.slice(0, 10)
    const e = b.days.at(-1)?.date ?? s
    return `${s} ~ ${e}`
  } catch {
    return ''
  }
}

function adjustmentsOf(r: ProgramRecord): number {
  try {
    const arr = JSON.parse(r.adjustmentsJson) as unknown
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}

</script>

<template>
  <div class="page">
    <PageHeader title="健康方案" subtitle="程序算基线 · 日程级安排 · AI 只复盘调参" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 加载 -->
    <section v-if="phase === 'loading'" class="card center empty">
      <span class="t-3">加载中…</span>
    </section>

    <!-- 方案数据损坏：给明确出口，而不是白屏或静默回落到向导 -->
    <section v-else-if="blobError" class="card center empty">
      <span class="t-3">{{ blobError }}</span>
    </section>

    <!-- 生成流：约束向导内联在方案页上，改完当场重算 -->
    <template v-else-if="phase === 'setup'">
      <!-- phase 分支整体随 v-else-if 挂载/卸载，包 <Transition> 永远不会触发：
           Vue 只在 Transition 常驻、其子元素 v-if 翻转时才播过渡，不陪跑死代码。
           阶段切换的观感保持瞬时（旧行为），淡入只留在真正会翻转的子结构上。 -->
      <ProgramConstraints
        :stale="constraintsStale"
        :generating="generating"
        :has-drafts="!!drafts"
        :course-names="courseNames"
        @start-change="start = $event"
        @generate="generate"
      />

      <template v-if="drafts">
        <section v-if="!drafts.every((d) => d.feasible)" class="card warn t-2">
          {{ drafts[0]?.issues.join('；') }}
          <button class="linkbtn" @click="router.push('/me')">去补全<ChevronRight :size="13" /></button>
        </section>

        <!-- 01 对比矩阵 + 02 强度预览：分段双视图，点列选中 -->
        <ProgramCompare
          :plans="drafts"
          :selected-tier="selectedTier"
          :goal="n.profile?.goal ?? 'cut'"
          @select="selectedTier = $event"
          @activate="askActivate"
        />

        <button class="why-link" @click="evidenceOpen = true">
          <Info :size="13" style="vertical-align:-2px;margin-right:var(--gap-tight)" />为什么每个肌群要练 2~3 次？看研究曲线
        </button>

        <!-- 启用确认 -->
        <SheetModal :open="confirmOpen" title="启用这套方案？" @close="confirmOpen = false">
          <div v-if="selectedPlan" class="form">
            <p class="t-2">「{{ selectedPlan.tierLabel }}」· {{ DEFAULT_PROGRAM_WEEKS }} 周，从{{ startLabel }}（{{ start.startDate }}）开始。</p>
            <ul class="confirm-list t-2">
              <li>未来 {{ DEFAULT_PROGRAM_WEEKS }} 周的训练课写入日程表（画布上点课块直接开练）；</li>
              <li>每日营养目标同步为方案值（主页摄入条与营养页同源）；</li>
              <li v-if="start.startMode !== 'next' || start.firstCourseId">
                从{{ startLabel }}起按你选的节奏循环{{ start.firstCourseId ? `，首个训练日是「${courseNames[start.firstCourseId] ?? ''}」` : '' }}{{ start.startMode !== 'next' ? '；今天若已练过，直接勾掉当天课程即可' : '' }}；
              </li>
              <li>已有生效方案会被自动归档，可随时手动调整或让 AI 复盘微调。</li>
            </ul>
            <button class="primary" :disabled="activating" @click="activate">
              {{ activating ? '正在启用…' : '确认启用' }}
            </button>
          </div>
        </SheetModal>
      </template>
    </template>

    <!-- 生效中：一屏管理（状态条 + 操作 + 调整历史） -->
    <template v-else-if="blob && store.active && status">
      <!-- 状态条：一行概要（目标·档位·周次·截止），点开展开静态参数 -->
      <section class="head-strip">
        <button class="strip" :aria-expanded="stripOpen" @click="stripOpen = !stripOpen">
          <span class="grow">
            <b class="strip-week num">第 {{ status.week }} 周 / {{ status.weeks }}</b>
            <span class="strip-tags">{{ GOAL_LABELS[store.active.goal] }}<PillChip size="sm">{{ activeTierLabel }} v{{ store.active.version }}</PillChip></span>
          </span>
          <span class="end num">{{ status.endDate.slice(5) }} 结束</span>
          <ChevronRight :size="12" class="chev" :class="{ open: stripOpen }" />
        </button>
        <div class="strip-bar" aria-hidden="true"><i :style="{ transform: `scaleX(${status.progress})` }" /></div>
        <div class="strip-detail" :class="{ open: stripOpen }">
          <div class="strip-detail-inner">
            <ul class="stats num">
              <li><em>每日热量</em><b>{{ Math.round(blob.params.targets.kcal) }}<i>大卡</i></b></li>
              <li><em>蛋白</em><b>{{ Math.round(blob.params.targets.protein) }}<i>g</i></b></li>
              <li>
                <em>每日热量偏移</em>
                <b>{{ blob.params.kcalDelta > 0 ? '+' : '' }}{{ blob.params.kcalDelta }}<i>大卡</i><span v-if="blob.params.kcalDelta !== 0" class="s-dir">{{ blob.params.kcalDelta > 0 ? '多吃' : '少吃' }}</span></b>
              </li>
              <li class="stat-pair">
                <em>基础代谢</em><b>{{ blob.params.bmr }}<i>大卡</i></b>
                <em>每日消耗</em><b>{{ blob.params.tdee }}<i>大卡</i></b>
              </li>
            </ul>
            <p class="strip-meta num">
              <span>{{ status.startDate }} ~ {{ status.endDate }} · {{ blob.params.mealsCount }}餐{{ blob.params.trainingDays }}练</span>
              <InfoHint
                title="基础代谢 / 每日消耗"
                content="基础代谢（BMR）：安静状态下维持生命所需的热量，按身高、体重、年龄与性别估算。

每日消耗（TDEE）：基础代谢加上日常活动与训练消耗后的总热量。每日热量目标以它为基准，再按「热量偏移」做增减。"
              />
            </p>
          </div>
        </div>
      </section>

      <section class="card acts">
        <button v-if="isEnded" class="primary" @click="openWrapup(store.active!)">
          生成本期成绩单<span class="primary-sub">方案期已结束 · 对照与下一期建议</span>
        </button>
        <div class="acts-grid">
          <button class="act" @click="startReview">
            <Wand2 :size="17" />AI 本周复盘<span>看数据调下一周</span>
          </button>
          <button v-if="!isEnded" class="act" @click="openShopping">
            <ShoppingBag :size="17" />本周采购清单<span>未来 7 天食材汇总</span>
          </button>
          <button class="act" @click="openAdjust">
            <Sparkles :size="17" />手动调参<span>缺口 / 蛋白 / 频率</span>
          </button>
          <button class="act" @click="evidenceOpen = true">
            <Info :size="17" />为什么是这样<span>3 条研究曲线</span>
          </button>
        </div>
        <div class="acts-minor">
          <button v-if="!isEnded" class="cap" @click="archiveCurrent">
            <Archive :size="14" />归档方案
          </button>
          <button
            class="cap danger"
            :class="{ armed: deleteArmed }"
            :title="
              deleteArmed
                ? '再点一次：方案与它排的日程待办一并移除，无法恢复'
                : '删除后方案与它排的日程待办一并移除，无法恢复'
            "
            @click="deleteCurrent"
          >
            <Trash2 :size="14" />
            {{ deleteArmed ? '再点一次确认删除' : '删除方案' }}
          </button>
        </div>
      </section>

      <!-- 调整历史：复盘闭环的账本（最近在前），点开看每次改了哪些参数 -->
      <section v-if="adjustments.length" class="card log">
        <header class="row between">
          <h2>调整历史</h2>
          <span class="t-3 num">{{ adjustments.length }} 次</span>
        </header>
        <ul class="log-list">
          <li v-for="a in adjustments" :key="a.version">
            <p class="log-head">
              <b class="num">v{{ a.version }}</b>
              <span class="t-3">{{ a.source === 'ai' ? 'AI 复盘' : '手动' }} · {{ a.at.slice(0, 10) }}</span>
            </p>
            <p class="log-sum t-2">{{ a.summary }}</p>
            <ul v-if="a.changes.length" class="log-changes num">
              <li v-for="(c, ci) in a.changes" :key="ci">
                <span class="ch-lab">{{ c.label }}</span>
                <span class="ch-from">{{ c.before }} →</span>
                <b class="ch-to">{{ c.after }}</b>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <!-- 手动调参 -->
      <SheetModal :open="adjustOpen" title="手动调参" @close="adjustOpen = false">
        <div class="form">
          <!-- 上下界一律取 ADJUSTMENT_LIMITS，避免与引擎的钳制口径漂移 -->
          <NumberStepper
            v-model="patchDelta"
            label="每日热量偏移（大卡）"
            :step="50"
            :min="ADJUSTMENT_LIMITS.kcalDeltaMin"
            :max="ADJUSTMENT_LIMITS.kcalDeltaMax"
          />
          <NumberStepper
            v-model="patchProtein"
            label="蛋白质（g/kg 体重）"
            :step="0.1"
            :decimals="1"
            :min="ADJUSTMENT_LIMITS.proteinPerKgMin"
            :max="ADJUSTMENT_LIMITS.proteinPerKgMax"
          />
          <NumberStepper
            v-model="patchDays"
            label="每周训练天数"
            :min="0"
            :max="ADJUSTMENT_LIMITS.trainingDaysMax"
          />
          <input v-model="manualSummary" class="sumin" placeholder="一句话原因（可选）">
          <button class="primary" :disabled="adjusting" @click="applyManual">
            {{ adjusting ? '应用中…' : '应用并重排今日起的日程' }}
          </button>
        </div>
      </SheetModal>

      <!-- AI 复盘：数据先行 + 建议逐条采纳 -->
      <ProgramReviewSheet
        :open="reviewOpen"
        :phase="review.phase"
        :error="review.error"
        :diagnosis="review.diagnosis"
        :advice="review.advice"
        :proposed="review.proposed"
        :current="blob?.params ?? null"
        :compare="reviewCompare"
        @apply="applyReview"
        @retry="startReview"
        @close="reviewOpen = false"
      />

      <!-- 本周采购清单：未来 7 天菜单食材按类聚合（AI 菜单按 id、模板菜单解析展示串） -->
      <SheetModal :open="shoppingOpen" title="本周采购清单" @close="shoppingOpen = false">
        <template #action>
          <InfoHint
            title="估算份量"
            content="模板菜单的份量按常见份量估算，不是按你的目标算出来的。

在营养页生成当天菜单后，可以按目标校准。"
          />
        </template>
        <div v-if="shoppingLoading" class="shop-state center"><span class="t-3">正在汇总菜单食材…</span></div>
        <div v-else-if="shoppingError" class="shop-state center"><span class="ai-err">{{ shoppingError }}</span></div>
        <template v-else>
          <div class="shop-head">
            <p class="shop-note num">
              <b class="shop-total">{{ shoppingTotalDays }}<span>天</span></b>{{ shoppingRangeOnly }}
            </p>
            <span class="shop-src">
              <PillChip v-if="shoppingAiDays" size="sm">{{ shoppingAiDays }} 天 AI 菜单</PillChip>
              <PillChip v-if="shoppingTemplateDays" size="sm">{{ shoppingTemplateDays }} 天模板菜单</PillChip>
              <button v-if="shoppingCheckedCount" class="linkbtn" @click="clearChecks">清空勾选</button>
            </span>
          </div>
          <p v-if="!shoppingRows.length" class="shop-state center"><span class="t-3">范围内没有可汇总的菜单</span></p>
          <div v-for="g in shoppingGroups" :key="g.name" class="shop-group">
            <p class="g-name">{{ g.name }}</p>
            <ul class="shop-list">
              <li v-for="r in g.rows" :key="r.key">
                <button class="s-row" :class="{ done: r.checked }" @click="toggleCheck(r)">
                  <CheckCircle2 v-if="r.checked" :size="15" class="s-check on" />
                  <Circle v-else :size="15" class="s-check" />
                  <span class="s-label">{{ r.label }}</span>
                  <span class="s-days t-3 num">{{ r.days }}天</span>
                  <b class="s-amt num">{{ amountText(r) }}</b>
                </button>
              </li>
            </ul>
          </div>
          <p v-if="shoppingRows.length && shoppingHasTemplate" class="shop-hint t-3">模板菜单为估算份量</p>
          <button v-if="shoppingRows.length" class="primary shop-copy" @click="copyShopping">
            {{ shoppingCopyErr || (shoppingCopied ? '已复制到剪贴板' : '复制全文') }}
          </button>
        </template>
      </SheetModal>
    </template>

    <!-- 历史方案（归档）：点开看结营成绩单 -->
    <section v-if="archivedList.length" class="card hist">
      <header class="row between">
        <h2>历史方案</h2>
        <span class="t-3 num">{{ archivedList.length }} 份</span>
      </header>
      <ul class="hist-list">
        <li v-for="r in archivedList" :key="r.id">
          <button class="hist-item pressable row between center" @click="openWrapup(r)">
            <span class="col" style="gap: var(--gap-text); min-width: 0">
              <b>{{ GOAL_LABELS[r.goal] }} · {{ tierLabel(r.tier) }} · v{{ r.version }}</b>
              <em class="t-3 num">{{ reportSpanOf(r) }} · 调整 {{ adjustmentsOf(r) }} 次</em>
            </span>
            <span class="hist-cta">结营成绩单 ›</span>
          </button>
        </li>
      </ul>
    </section>

    <!-- 档位科学依据：setup 与生效态共用，档位随上下文切换 -->
    <ProgramEvidenceSheet
      :open="evidenceOpen"
      :tier="evidenceTier"
      @close="evidenceOpen = false"
    />
    </div>
  </div>
</template>

<style scoped>
/* flex + gap 统一卡片间距：卡片来自多个子组件（.card / .pod 混排），
   全局 .card + .card 的相邻选择器跨组件会断链，这里由页面容器统一负责 */
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
  display: flex;
  flex-direction: column;
  /* 卡片之间 12（卡片间距）：原来 14 与卡内 12 的节奏对不上 */
  gap: var(--gap-md);
}

.rubber-layer > .card + .card {
  margin-top: 0; /* 全局规则的 14px 已由 gap 提供，避免叠加 */
}

.empty {
  /* 模板里与 .center 成对使用：center 只给对齐属性，display 在这里补上，
     否则「加载中…」这类单行文案会贴在卡左上角而不是居中 */
  display: flex;
  padding: var(--sp-40) 0;
}

.card h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.primary {
  width: 100%;
  /* 页脚主按钮高 40（--control-md），圆角走按钮档 20 */
  min-height: var(--control-md);
  padding: var(--sp-8) 0;
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

.linkbtn {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-text);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 科学依据入口：选档时最需要「为什么」，做成文字链不抢主按钮 */
.why-link {
  display: block;
  width: 100%;
  margin: var(--sp-4) 0 var(--sp-12);
  text-align: center;
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 引导与档位卡样式已随 01/02/03 组件化移除 */

.warn {
  background: var(--danger-soft);
  color: var(--text-1);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--gap-sm);
}

/* 320 档：卡内可用的 260px 分给四列只剩 59px，而「每日热量偏移」六个 10px 汉字
   正好 60px —— 标签是 nowrap，会从格子里溢出去。收到两列，标签保持整行。 */
@media (max-width: 359px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.stats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.stats b {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.stats i {
  font-style: normal;
  font-weight: var(--fw-regular);
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: var(--sp-2);
}

/* 偏移量的方向词（多吃 / 少吃）：把 +/− 号翻成人话，与数值同行不抢层级 */
.s-dir {
  margin-left: var(--sp-4);
  font-size: var(--fs-micro);
  font-weight: var(--fw-regular);
  color: var(--text-3);
}

/* BMR/TDEE 拆成两组「标签 + 值」竖排：缩写不解释没人读得懂，中文名各带单位 */
.stat-pair {
  display: grid;
  gap: var(--gap-text);
  align-content: center;
}

.stat-pair em + b {
  margin-bottom: var(--sp-6);
}

/* 状态条：一行概要 + 周期进度 + 可展开参数详情 */
.head-strip {
  flex: none;
}

.strip {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 四边同距 12，与 .act / .stats 的内距同档 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  /* accent-soft 底上的文字走 strong 档（tokens.css:181）：实底档 --accent 在这层浅蓝上不够稳 */
  color: var(--accent-strong);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  text-align: left;
}

.strip .grow {
  display: flex;
  align-items: center;
  /* 320 档：周次 + 目标/档位胶囊放不进一行时让胶囊换行，而不是被 overflow 切掉半个「v2」 */
  flex-wrap: wrap;
  gap: var(--gap-sm);
  flex: 1;
  min-width: 0;
}

/* 周次是这一屏的主数值：19px + 等宽，与同行的目标/档位拉开层次 */
.strip-week {
  flex: none;
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-1);
}

.strip-tags {
  display: inline-flex;
  align-items: center;
  /* 目标与档位胶囊是主次文本左右的关系：8（--gap-text-inline） */
  gap: var(--gap-text-inline);
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--accent-strong);
  white-space: nowrap;
}

.strip .end {
  flex: none;
  font-size: var(--fs-caption);
}

.strip .chev {
  flex: none;
  transition: transform var(--dur-fast) var(--ease-sheet);
}

.strip .chev.open {
  transform: rotate(90deg);
  transition: transform var(--dur-base) var(--ease-sheet);
}

/* 周期进度：细条替代被删掉的周期地图，「走到哪了」一眼可见 */
.strip-bar {
  height: 3px;
  margin-top: var(--sp-6);
  border-radius: var(--radius-full);
  /* 轨道用 --ring-track 而不是 --surface-2：进度条落在画布上，
     surface-2 与页面底色几乎同值，轨道会整条消失（tokens.css:158-161） */
  background: var(--ring-track);
  overflow: hidden;
}

.strip-bar i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  transform-origin: left center;
}

.strip-detail {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--dur-fast) var(--ease-sheet),
    opacity var(--dur-fast) var(--ease-standard);
}

.strip-detail.open {
  grid-template-rows: 1fr;
  opacity: 1;
  transition:
    grid-template-rows var(--dur-base) var(--ease-sheet),
    opacity var(--dur-base) var(--ease-standard);
}

.strip-detail-inner {
  overflow: hidden;
  min-height: 0;
}

.strip-detail .stats {
  margin: var(--sp-10) 0 0;
  padding: var(--sp-10) var(--sp-14);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.strip-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-10);
  margin: var(--sp-6) var(--sp-2) 0;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .strip-detail,
  .strip .chev {
    transition: none;
  }
}

/* 操作区：高频操作 2 列网格，归档 / 删除降级为胶囊 */
.acts {
  display: grid;
  gap: var(--gap-md);
}

.acts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-sm);
}

.act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-tight);
  /* 动作磁贴四边同距 12（二级分组面），原来三边 14/8/12 不等 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  text-align: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.act:active {
  transform: scale(0.97);
}

.act span {
  font-weight: var(--fw-regular);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.acts-minor {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 两枚描边胶囊是有明确边界的控件：16（--gap-lg），不是无边界的那一档 8 */
  gap: var(--gap-lg);
}

/* 归档 / 删除：胶囊按钮——低频但有引导性，危险项 armed 态红底强化。
   视觉走常规按钮 40（--control-md），命中区由 ::after 补到 44。 */
.cap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.cap::after {
  content: '';
  position: absolute;
  inset: -2px 0;
  border-radius: var(--radius-full);
}

.cap:active {
  transform: scale(0.96);
}

/* 危险动作的文字走 strong 档：--danger 压白底只有 3.55:1，12px 文字读不清 */
.cap.danger {
  color: var(--danger-strong);
}

.cap.danger.armed {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger-strong);
  font-weight: var(--fw-bold);
}

.acts .primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-6);
}

/* 主按钮里的副行走 --on-accent：这颗是 .primary（底 --accent），
   灰字压蓝底实测只有 1.56:1，降字号与字重来分层次，不靠 opacity 手调 */
.acts .primary .primary-sub {
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--on-accent);
}

/* 调整历史 */
.log-list li {
  /* 日志行是单行行：高度 48（--row-h） */
  min-height: var(--row-h);
  padding: var(--sp-8) 0;
  border-top: 0.5px solid var(--line);
}

.log-list li:first-child {
  border-top: none;
}

.log-head {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  font-size: var(--fs-subhead);
}

.log-sum {
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
}

/* 调整历史：每条变更独立成行 —— 账本要逐行读，
   标签与旧值次要、新值（after）加粗提亮，不再用「·」串成一行 */
.log-changes {
  margin-top: var(--sp-4);
  display: grid;
  gap: var(--gap-tight);
  padding: 0;
  list-style: none;
  font-size: var(--fs-caption);
}

.log-changes li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--gap-tight);
}

.ch-lab {
  color: var(--text-2);
}

.ch-from {
  color: var(--text-3);
}

.ch-to {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

/* 采购清单弹层 */
.shop-state {
  padding: var(--sp-36) 0;
}

.shop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--gap-sm) var(--sp-10);
}

.shop-note {
  flex: 1;
  min-width: 0;
  margin: 0 0 var(--sp-12);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

/* 覆盖天数做成主数值胶囊（accent-soft 底 + accent-strong 字）置前，
   来源拆成两颗中性胶囊靠右 —— 四个数字并列要读者自己做加法的排法不再有 */
.shop-total {
  display: inline-flex;
  align-items: baseline;
  gap: var(--gap-tight);
  margin-right: var(--sp-8);
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
}

.shop-total span {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.shop-src {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  /* 来源胶囊是一组无边界控件：8 */
  gap: var(--gap-sm);
}

.shop-group {
  margin-bottom: var(--sp-16);
}

.shop-group .g-name {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-3);
}

.shop-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.s-row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-10);
  width: 100%;
  /* 采购清单是单行列表：行高 48（--row-h），勾选行之间节奏一致 */
  min-height: var(--row-h);
  padding: var(--sp-8) 0;
  background: none;
  border: none;
  border-top: 0.5px solid var(--line);
  text-align: left;
  font: inherit;
  color: inherit;
}

.shop-group .shop-list li:first-child .s-row {
  border-top: none;
}

.s-check {
  flex: none;
  align-self: center;
  color: var(--text-3);
}

.s-check.on {
  color: var(--accent);
}

.s-row.done .s-label,
.s-row.done .s-amt {
  color: var(--text-3);
}

.s-row.done .s-label {
  text-decoration: line-through;
}

.s-label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.s-days {
  white-space: nowrap;
  /* 显式字号：不写就从 body 继承 17px，比同行的食材名与分量（14px）还大 */
  font-size: var(--fs-caption);
}

.s-amt {
  min-width: 64px;
  text-align: right;
  font-size: var(--fs-subhead);
}

.shop-hint {
  margin: var(--sp-4) 0 0;
}

.shop-copy {
  width: 100%;
  margin-top: var(--sp-14);
}

/* 历史方案列表 */
.hist-list li + li {
  border-top: 0.5px solid var(--line);
}

.hist-item {
  width: 100%;
  gap: var(--sp-10);
  padding: var(--sp-10) 0;
  text-align: left;
}

.hist-item b {
  font-size: var(--fs-subhead);
}

.hist-item em {
  font-style: normal;
  font-size: var(--fs-caption);
}

.hist-cta {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent);
}

/* 执行报告样式已随结营成绩单页移除 */

/* 弹层表单 */
.form {
  display: grid;
  gap: var(--gap-lg);
  padding-bottom: var(--sp-20);
}

.confirm-list {
  display: grid;
  gap: var(--sp-6);
  list-style: disc inside;
  line-height: var(--lh-body);
}

.sumin {
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   这页在桌面上是「通栏状态条 + 通栏操作区 + 两条并排清单」，每块内部都有自己的
   栅格，不需要壳层再分栏；选择器带上 section 元素名压过 .rubber-layer > .card 的半栏规则。
   ============================================================ */

.desk-main .rubber-layer > section.card.warn,
.desk-main .rubber-layer > section.card.acts,
.desk-main .rubber-layer > section.card.hist,
.desk-main .rubber-layer > section.card.log,
.desk-main .rubber-layer > section.card.empty,
.desk-main .rubber-layer > section.head-strip {
  grid-column: 1 / -1;
}

/* 操作区通栏后，高频动作排成一行（窄屏的 2×2 是拇指够得着的版本） */
.desk-main .acts-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

/* 调整历史与历史方案都是可长清单：通栏后按两栏流铺开 */
.desk-main .log-list,
.desk-main .hist-list {
  columns: 2;
  column-gap: var(--desk-gap);
}

.desk-main .log-list > li,
.desk-main .hist-list > li {
  break-inside: avoid;
}
</style>
