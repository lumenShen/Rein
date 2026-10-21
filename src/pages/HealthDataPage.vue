<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Component } from 'vue'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Footprints,
  HeartPulse,
  RefreshCw,
  Scale,
  ShieldCheck,
  Stethoscope,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import HealthWorkoutList from '@/components/health/HealthWorkoutList.vue'
import MetricDetailSheet from '@/components/health/MetricDetailSheet.vue'
import { useToast } from '@/composables/useToast'
import { healthSyncService } from '@/services/healthSyncService'
import { nutritionService } from '@/services/nutritionService'
import {
  HEALTH_CATEGORIES,
  HEALTH_METRIC_BY_KEY,
  HEALTH_METRICS,
  formatMetricDay,
  formatMetricValue,
  lastLocalDays,
  type HealthCategoryKey,
  type HealthMetricMeta,
} from '@/config/healthMetrics'
import { todayStr } from '@/utils/date'
import type {
  HealthMetricSeries,
  HealthSyncReport,
  HealthSyncStatus,
  HealthSyncWorkout,
} from '@/types'

/** 每组数据源行的图标（config 里的 key → lucide 组件） */
const CATEGORY_ICONS: Record<HealthCategoryKey, Component> = {
  exercise: HeartPulse,
  activity: Footprints,
  body: Scale,
  vitals: Stethoscope,
}

/**
 * 第三方数据管理（三级页，入口在「设置 › 第三方数据管理」）。
 *
 * 手机厂商的运动 App（小米运动健康 / 华为运动健康 …）把数据写进**系统的 Health Connect**，
 * 本页让 Rein 从那里读进来、也可以把 Rein 自己记的运动回写出去。
 * 厂商差异在系统那一层就被抹平了，所以这一页只跟 Health Connect 打交道，
 * 不去对接任何厂商私有接口（原理见 Rust `modules/healthsync`）。
 *
 * 页面结构是用户要回答的四个问题：
 *   1. 现在是什么状态 —— Health Connect 可不可用、四组读权限各授到哪一步
 *      （运动 / 活动与睡眠 / 身体成分 / 身体机能，分组见 `config/healthMetrics.ts`）
 *   2. 同步一次会发生什么（以及上一次发生了什么）
 *   3. 读到了什么 —— 每个指标最近 14 天的形状 + 最新值
 *   4. 这套「谁能改谁」的规则是什么（双向同步必须有明确的所有权，否则用户不敢点）
 *
 * 授权说明：Health Connect 的权限**不是**系统运行时弹窗，点按钮会跳到它自己的界面，
 * 而且可以按组只授一部分 —— 每组的「去授权」只申请那一组的权限，
 * 回来后本页自动刷新；没有授权的组不影响其它组同步。
 */
const { toast } = useToast()

const status = ref<HealthSyncStatus | null>(null)
const report = ref<HealthSyncReport | null>(null)
/** 每个指标近 14 天的镜像序列（同步后落库的 health_metrics 表） */
const metrics = ref<HealthMetricSeries[]>([])
/** 上一次同步的失败原因：留在页面上，不只闪一条 toast（授权没了这类问题要能反复看） */
const message = ref<string | null>(null)
const loading = ref(true)
const syncing = ref(false)
/** 本机存着的第三方运动记录（导入块 + 缺开始时间块），同步后与进页时各拉一次 */
const syncWorkouts = ref<HealthSyncWorkout[]>([])

/* ---------------- 同步起始日偏好 ----------------
   三态：自动（程序取本机最早导入记录）/ 从头拉全部 / 自定义日期。
   这个偏好**只存本机 localStorage**，不写 app_meta —— 避免与 push 开关那套口径形成双写。
   传值给 Rust：auto → null（Rust 侧解析），all → '2000-01-01'，custom → 所选日期。 */
const WINDOW_KEY = 'rein.healthSync.windowStart'
const WINDOW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 「从头拉全部」的显式起始日：也是 Rust 侧无导入记录时的回退值 */
const WINDOW_ALL_DATE = '2000-01-01'

const WINDOW_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'all', label: '从头拉全部' },
  { value: 'custom', label: '自定义' },
]
/** 用户在分段控件里选的模式；与 customDate 分开存，切走再切回不丢已填日期 */
const windowMode = ref<'auto' | 'all' | 'custom'>('auto')
const customDate = ref('')

/** 读回偏好：认 'all' 与日期串，其余（含损坏值）一律按自动 */
function loadWindowPref(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(WINDOW_KEY)
  } catch {
    /* 隐私模式读不到，按自动处理 */
  }
  if (raw === 'all') {
    windowMode.value = 'all'
  } else if (raw && WINDOW_DATE_RE.test(raw)) {
    windowMode.value = 'custom'
    customDate.value = raw
  } else {
    windowMode.value = 'auto'
  }
}

/** 写回偏好：只有落到有效值才写，避免把空日期当成一个假的「自定义」存进去 */
function persistWindowPref(): void {
  const v = windowMode.value === 'custom' ? customDate.value : windowMode.value
  try {
    localStorage.setItem(WINDOW_KEY, v)
  } catch {
    /* 写不进去也不影响本次同步：传参照旧按当前模式算 */
  }
}

function onWindowMode(v: string): void {
  if (v !== 'auto' && v !== 'all' && v !== 'custom') return
  // 刚切到自定义且还没填过日期时给个今天，免得分段控件说「自定义」、实际却按自动传
  if (v === 'custom' && !customDate.value) customDate.value = todayStr()
  windowMode.value = v
}

// 进页即回填上次选择；之后模式或日期一变就写回本机
loadWindowPref()
watch([windowMode, customDate], persistWindowPref)

/** 当前模式对应的 windowStart：null = 自动，'2000-01-01' = 全部，其余 = 自定义日期 */
function windowStartValue(): string | null {
  if (windowMode.value === 'all') return WINDOW_ALL_DATE
  if (windowMode.value === 'custom') {
    return WINDOW_DATE_RE.test(customDate.value) ? customDate.value : null
  }
  return null
}

/** 分段控件下方的一句说明：三态各说清「这一轮会从哪里读」 */
const windowHint = computed(() => {
  if (windowMode.value === 'all') return `将从 ${WINDOW_ALL_DATE} 起读取全部历史（含早于首次导入的记录）`
  if (windowMode.value === 'custom') {
    return customDate.value
      ? `将从 ${customDate.value} 起读取`
      : '请选择起始日期'
  }
  const d = status.value?.autoWindowStart
  return d
    ? `程序按本机最早一条导入记录（${d}）起读`
    : '还没有导入记录，将读取全部历史'
})

/** 导入进来的记录（手机同步） */
const importedWorkouts = computed(() =>
  syncWorkouts.value.filter((w) => w.source === 'health_connect'),
)
/** 没填开始时间、回写时被跳过的本机记录 —— 就是同步报告里「跳过 N」那句话对应的明细 */
const missingStartWorkouts = computed(() =>
  syncWorkouts.value.filter((w) => w.source === 'local' && w.startMin == null),
)

/** 同步要读全部历史，轮询上限给足；超时是异常路径，正常几秒内就结束 */
const POLL_INTERVAL_MS = 400
const POLL_MAX = 120

const supported = computed(() => status.value?.supported ?? false)
const available = computed(() => status.value?.availability === 'available')
const readGranted = computed(() => status.value?.readGranted ?? false)
const writeGranted = computed(() => status.value?.writeGranted ?? false)
const pushEnabled = computed(() => status.value?.pushEnabled ?? false)

/** 每组的授权状态：旧桥没有这份 → 全部按未授权处理，引导用户去补 */
const categories = computed(() =>
  HEALTH_CATEGORIES.map((cat) => ({
    ...cat,
    granted: status.value?.grantedCategories?.[cat.key] === true,
  })),
)

/** 阻塞操作的原因（没有原因 = 可以点「立即同步」） */
const blockedReason = computed(() => {
  if (!supported.value) return '桌面端没有 Health Connect，这个功能只在 Android 手机上可用'
  if (status.value?.availability === 'unknown') return '正在检测本机的 Health Connect…'
  if (status.value?.availability === 'update_required') return '系统的 Health Connect 需要更新后才能使用'
  if (status.value?.availability !== 'available') return '本机没有 Health Connect（Android 14 起才内置）'
  if (!readGranted.value) return '还没有拿到「运动」组的读取授权 —— 导入运动记录从这一组开始'
  return ''
})

const canSync = computed(() => blockedReason.value === '' && !syncing.value)

const availabilityText: Record<string, string> = {
  available: '可用',
  unavailable: '不可用',
  update_required: '需要更新',
  unknown: '检测中',
}

/** 收敛首次进入时的状态：只在 `unknown` 上继续等，拿到确定答案就停 */
const FIRST_POLL_ATTEMPTS = 10
const FIRST_POLL_INTERVAL_MS = 400

async function refresh() {
  try {
    status.value = await healthSyncService.status()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

/**
 * 把状态读到「真值」为止。
 *
 * 为什么一次读不够：`health_sync_status` 会顺带让原生侧重算授权，但那是**异步**
 * 写文件的，而命令本身读的是文件的现状 —— 也就是说每次读到的是上一轮的答案。
 * 连续问几次就收敛了（真机上两轮以内）。任何「用户可能刚在别处改了授权」的
 * 时机都要走这个循环，而不是单次 refresh。
 */
async function converge() {
  for (let i = 0; i < FIRST_POLL_ATTEMPTS; i++) {
    await refresh()
    const a = status.value?.availability
    if (a !== 'unknown' && a !== undefined) {
      // 可用性已定；授权状态与可用性同一份文件，再补一拍等它写完
      await new Promise((r) => setTimeout(r, FIRST_POLL_INTERVAL_MS))
      await refresh()
      return
    }
    await new Promise((r) => setTimeout(r, FIRST_POLL_INTERVAL_MS))
  }
}

/** 首次进入：原生侧可能还没写过状态文件 */
async function firstLoad() {
  await converge()
  await loadMetrics()
  await loadSyncWorkouts()
}

/** 拉预览：桌面端没有数据源，跳过；失败不阻塞本页（卡片按空态展示） */
async function loadMetrics() {
  if (!supported.value) return
  try {
    metrics.value = await healthSyncService.metrics()
  } catch {
    /* 空态即可 */
  }
}

/** 拉本机第三方运动记录：与预览同款门控（桌面端没有数据源就跳过） */
async function loadSyncWorkouts() {
  if (!supported.value) return
  try {
    syncWorkouts.value = await healthSyncService.workouts()
  } catch {
    /* 空态即可 */
  }
}

/** 用户手机当前时区偏移（秒）：导出方向要把「本地日期 + 分钟」折算成 HC 的瞬时时刻 */
function utcOffsetSeconds(): number {
  return -new Date().getTimezoneOffset() * 60
}

/**
 * 估算最大心率：适配层拿它把第三方给的运动心率反推成强度档（`220 - 年龄`）。
 *
 * 两条来源按可信度排：方案计算器里的 `age` 是用户自己填的；`profile.birthday`
 * 是出生年份折算出来的。都没有就返回 null —— 适配层会退回按配速判断，
 * 不会因为缺年龄就写一个编出来的强度。
 */
async function resolveMaxHr(): Promise<number | null> {
  try {
    const calc = await nutritionService.getCalcState()
    if (calc?.age) return 220 - calc.age
  } catch {
    /* 读不到就走下一条 */
  }
  try {
    const profile = await nutritionService.getProfile()
    if (profile.birthday) {
      const born = new Date(profile.birthday)
      const years = (Date.now() - born.getTime()) / (365.25 * 24 * 3600 * 1000)
      if (Number.isFinite(years) && years > 0 && years < 120) return 220 - Math.round(years)
    }
  } catch {
    /* 忽略：拿不到年龄就不按心率判断强度 */
  }
  return null
}

async function authorize(mode: 'read' | 'write' | HealthCategoryKey) {
  try {
    await healthSyncService.authorize(mode)
    toast('已打开健康数据授权页，授权后返回本页即可')
    // 兜底再补两次延时刷新：授权结果也可能不是经 ActivityResult 回来的
    // （例如用户在 HC 设置页里手动授予），那走不到原生侧的回调，只能靠这里重读
    setTimeout(refresh, 1200)
    setTimeout(refresh, 4000)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

/**
 * 回到前台就重读一次状态。
 *
 * 为什么必须有：授权这一步会把用户**带离**本页（去 Health Connect 的界面），
 * 而回来的路不止一条 —— 系统回调、用户自己从设置页授予、从小米运动健康那边回来。
 * 只靠回调在实现上不可靠，靠 visibilitychange 才是「用户回来了」这件事本身。
 */
function onVisibility() {
  if (document.visibilityState === 'visible') {
    void converge()
    void loadMetrics()
    void loadSyncWorkouts()
  }
}

async function togglePush(next: boolean) {
  try {
    await healthSyncService.setPush(next)
    await refresh()
    if (next && !writeGranted.value) toast('回写还需要「写入」授权，点上面的按钮补一下')
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

async function runSync() {
  if (!canSync.value) return
  syncing.value = true
  report.value = null
  message.value = null
  try {
    const maxHr = await resolveMaxHr()
    const started = await healthSyncService.start(
      pushEnabled.value,
      maxHr,
      utcOffsetSeconds(),
      windowStartValue(),
    )
    let step = started
    for (let i = 0; i < POLL_MAX && step.phase === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      step = await healthSyncService.step()
    }
    message.value = step.message
    if (step.message) toast(step.message)
    if (step.report) {
      report.value = step.report
      const total =
        step.report.imported + step.report.updated + step.report.removed +
        step.report.exported + step.report.reExported
      toast(total > 0 ? `同步完成，共处理 ${total} 条` : '同步完成，没有变化')
      // 体征镜像刚被整表替换，预览跟着重拉一次；导入/回写也变了，记录列表同拉
      await loadMetrics()
      await loadSyncWorkouts()
    } else if (step.phase === 'pending') {
      message.value = '同步超时，请重试'
      toast(message.value)
    }
    await refresh()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    syncing.value = false
  }
}

/* ---------------- 预览卡的展示逻辑 ---------------- */

const PREVIEW_DAYS = 14

/** 分组 key → 组内排列顺序（config 数组的顺序就是页面顺序） */
const METRIC_ORDER = new Map(HEALTH_METRICS.map((m, i) => [m.key, i]))

/** 有数据的分组 + 组内按固定顺序排列的指标行（没数据的分组整个不出现） */
const metricGroups = computed(() =>
  HEALTH_CATEGORIES.map((cat) => ({
    key: cat.key,
    label: cat.label,
    rows: metrics.value
      .map((series) => ({ meta: HEALTH_METRIC_BY_KEY[series.metric], series }))
      .filter(
        (r): r is { meta: HealthMetricMeta; series: HealthMetricSeries } =>
          !!r.meta && r.meta.category === cat.key,
      )
      .sort(
        (a, b) =>
          (METRIC_ORDER.get(a.meta.key) ?? 99) - (METRIC_ORDER.get(b.meta.key) ?? 99),
      ),
  })).filter((g) => g.rows.length > 0),
)

/** 预览空态该说哪句话：没授权和授权了但没数据是两件事 */
const previewEmptyText = computed(() =>
  readGranted.value
    ? '同步一次后，这里会显示从 Health Connect 读到的每日数据'
    : '先在上方完成「运动」组的授权，再同步一次即可',
)

/** 同步规则全文：四条「谁能改谁」收进「同步规则」卡面的 InfoHint，卡面只留一行结论 */
const syncRules = [
  '从手机同步进来的记录：以 Health Connect 为准，那边改了会覆盖这边，那边删了这边也跟着删。',
  '每日体征数据：只是 Health Connect 的镜像，每次同步整表刷新，不会动你手填的体重等档案。',
  'Rein 自己记的运动：以本机为准，删除时会连带收掉回写出去的那一份。',
  '在这里删掉一条同步记录：只从 Rein 移除，不删 Health Connect 里那份（它可能是别的 App 写的）。',
].join('\n\n')

/* ---- 指标详情抽屉 ---- */
const detailOpen = ref(false)
const detail = ref<{ meta: HealthMetricMeta; series: HealthMetricSeries } | null>(null)

function openDetail(meta: HealthMetricMeta, series: HealthMetricSeries): void {
  detail.value = { meta, series }
  detailOpen.value = true
}

/**
 * 一根指标 14 天的条形：缺失的天是空位（灰点底），有值的天按**窗口内**最大值
 * 归一化高度（镜像序列现在是 90 天全量，不能拿 90 天的 max 压扁最近两周），
 * 最高不过顶（留 6% 余量），最低不低于 10% —— 让「有但很小」与「没有」一眼分得开。
 */
function barsFor(series: HealthMetricSeries): { pct: number; empty: boolean }[] {
  const window = new Set(lastLocalDays(PREVIEW_DAYS))
  const pts = series.points.filter((p) => window.has(p.day))
  const byDay = new Map(pts.map((p) => [p.day, p.value]))
  const max = Math.max(...pts.map((p) => p.value), 0)
  return lastLocalDays(PREVIEW_DAYS).map((day) => {
    const v = byDay.get(day)
    if (v == null) return { pct: 0, empty: true }
    if (max <= 0) return { pct: 10, empty: false }
    return { pct: Math.min(Math.max((v / max) * 94 + 6, 10), 100), empty: false }
  })
}

function fmtTime(iso: string | null): string {
  if (!iso) return '从未同步'
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(() => {
  void firstLoad()
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibility))
</script>

<template>
  <div class="page">
    <PageHeader title="第三方数据管理" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 1. 状态与授权 -->
    <section class="card">
      <h2 class="gtitle">数据源</h2>
      <div class="rows">
        <div class="frow row">
          <i class="fic"><HeartPulse :size="17" /></i>
          <span class="col ftxt">
            <b>Health Connect</b>
            <small>系统健康数据中转站 · 手机厂商的运动 App 都在往这里写</small>
          </span>
          <span class="pill" :class="{ ok: available }">
            {{ availabilityText[status?.availability ?? 'unavailable'] ?? '未知' }}
          </span>
        </div>

        <!-- 四组读权限：HC 允许按类型只授一部分，所以每组单独引导、单独补授权。
             「去授权」只申请这一组的权限，回来后本页自动刷新。 -->
        <template v-if="available">
          <div v-for="cat in categories" :key="cat.key" class="frow row">
            <i class="fic">
              <component :is="CATEGORY_ICONS[cat.key]" :size="17" />
            </i>
            <span class="col ftxt">
              <b>{{ cat.label }}</b>
              <small>{{ cat.desc }}</small>
            </span>
            <span v-if="cat.granted" class="pill ok"><Check :size="13" /> 已授权</span>
            <button v-else class="act" type="button" @click="authorize(cat.key)">去授权</button>
          </div>

          <div v-if="pushEnabled" class="frow row">
            <i class="fic"><ShieldCheck :size="17" /></i>
            <span class="col ftxt">
              <b>写入授权</b>
              <small>把 Rein 记的运动回写给其他 App</small>
            </span>
            <span v-if="writeGranted" class="pill ok"><Check :size="13" /> 已授权</span>
            <button v-else class="act" type="button" @click="authorize('write')">去授权</button>
          </div>
        </template>
      </div>
    </section>

    <!-- 2. 同步 -->
    <section class="card">
      <h2 class="gtitle">同步</h2>
      <div class="rows">
        <div class="frow row">
          <span class="col ftxt">
            <b class="num">{{ fmtTime(status?.lastSyncAt ?? null) }}</b>
            <!-- 累计导入/回写：两枚胶囊各自成形，不用「·」串成一句；「本次」的分项在下方报告行 -->
            <span class="cum">
              <PillChip tone="muted" size="sm">
                累计已导入 <span class="num">{{ status?.importedCount ?? 0 }}</span> 条
              </PillChip>
              <PillChip tone="muted" size="sm">
                累计已回写 <span class="num">{{ status?.exportedCount ?? 0 }}</span> 条
              </PillChip>
            </span>
          </span>
          <button class="act" type="button" :disabled="!canSync" @click="runSync">
            <RefreshCw :size="14" :class="{ spin: syncing }" />
            {{ syncing ? '同步中' : '立即同步' }}
          </button>
        </div>

        <div class="frow row">
          <span class="col ftxt">
            <b>把 Rein 的运动回写出去</b>
            <small>关闭时只读不写；打开后本机补录/课程/跑步也会出现在其他健康 App 里</small>
          </span>
          <ToggleSwitch
            :model-value="pushEnabled"
            label="把 Rein 的运动回写到 Health Connect"
            :disabled="!available || syncing"
            @update:model-value="togglePush"
          />
        </div>

        <!-- 同步起始日：只作用于从手机读取运动记录的起点（体征镜像窗口不动）。
             三态里「从头拉全部」是用过窄窗口后回到全量的唯一恢复出口。 -->
        <div class="frow window">
          <span class="col ftxt">
            <b>同步起始日期</b>
            <small>从这一天之后开始读取手机里的运动记录；设置只存在本机</small>
          </span>
          <SegmentedControl
            :options="WINDOW_OPTIONS"
            :model-value="windowMode"
            @update:model-value="onWindowMode"
          />
          <input
            v-if="windowMode === 'custom'"
            v-model="customDate"
            type="date"
            class="date-input"
            aria-label="同步起始日期"
          />
          <p class="sub">{{ windowHint }}</p>
        </div>

        <p v-if="blockedReason" class="hint">
          <AlertTriangle :size="14" /> {{ blockedReason }}
        </p>
        <!-- 与 blockedReason 并排显示而不是二选一：授权失败的原因必须看得见，
             否则用户只会看到「还没有拿到授权」却不知道刚才那一下为什么没反应 -->
        <p v-if="message" class="hint">
          <AlertTriangle :size="14" /> {{ message }}
        </p>

        <div v-if="report" class="rep">
          <!-- 「本次」二字把报告行与上方的累计行分开：同一个数在两处指的不是一回事 -->
          <StatusChip tone="accent" size="sm">本次</StatusChip>
          <span v-if="report.imported">导入 <span class="num">{{ report.imported }}</span></span>
          <span v-if="report.updated">更新 <span class="num">{{ report.updated }}</span></span>
          <span v-if="report.removed">移除 <span class="num">{{ report.removed }}</span></span>
          <span v-if="report.metricsImported">体征 <span class="num">{{ report.metricsImported }}</span> 天</span>
          <span v-if="report.exported">回写 <span class="num">{{ report.exported }}</span></span>
          <span v-if="report.reExported">重写 <span class="num">{{ report.reExported }}</span></span>
          <span v-if="report.skipped">跳过 <span class="num">{{ report.skipped }}</span>（没填开始时间，见下方）</span>
          <span v-if="!report.imported && !report.updated && !report.removed && !report.exported && !report.reExported">
            读到 <span class="num">{{ report.scanned }}</span> 条，没有变化
          </span>
        </div>
      </div>
    </section>

    <!-- 3. 数据预览：读到了什么。只有授权过的组、同步过的数据才会出现。 -->
    <section class="card">
      <h2 class="gtitle">健康数据</h2>
      <p v-if="!available" class="empty">
        在 Android 手机上接入 Health Connect 后，这里会显示读到的每日数据
      </p>
      <p v-else-if="!metricGroups.length" class="empty">{{ previewEmptyText }}</p>
      <template v-else>
        <p class="empty">每行是近 14 天的形状，点开看趋势与原始数据</p>
        <div v-for="group in metricGroups" :key="group.key" class="mgroup">
          <h3 class="mtitle">{{ group.label }}</h3>
          <div
            v-for="row in group.rows"
            :key="row.series.metric"
            class="mrow"
            role="button"
            tabindex="0"
            :aria-label="`查看${row.meta.label}的趋势与原始数据`"
            @click="openDetail(row.meta, row.series)"
            @keydown.enter.prevent="openDetail(row.meta, row.series)"
            @keydown.space.prevent="openDetail(row.meta, row.series)"
          >
            <span class="col mtxt">
              <b>{{ row.meta.label }}</b>
              <small>{{ formatMetricDay(row.series.latestDay) }}</small>
            </span>
            <span class="bars">
              <i
                v-for="(bar, i) in barsFor(row.series)"
                :key="i"
                class="bar"
                :class="{ empty: bar.empty }"
                :style="{ height: bar.pct + '%' }"
              />
            </span>
            <span class="mval">
              <b>{{ formatMetricValue(row.meta, row.series.latestValue) }}</b>
              <small v-if="row.meta.unit">{{ row.meta.unit }}</small>
            </span>
            <ChevronRight :size="14" class="mchev" />
          </div>
        </div>
      </template>
    </section>

    <!-- 3.5 本机第三方运动记录：进口块（手机同步进来的）+ 缺开始时间块（回写被跳过的本机记录）。
         只读展示 —— 补填与删除仍在「全部运动记录」页。 -->
    <section class="card">
      <h2 class="gtitle">本机第三方运动记录</h2>

      <template v-if="!supported">
        <p class="empty">接入 Health Connect 后，这里会列出从手机同步进来的运动记录</p>
      </template>
      <template v-else>
        <h3 class="mtitle">从手机同步进来的</h3>
        <HealthWorkoutList v-if="importedWorkouts.length" :items="importedWorkouts" />
        <p v-else class="empty">
          {{ readGranted ? '还没有导入记录 —— 在上面同步一次即可' : '「运动」组授权后，这里会列出从手机同步进来的运动记录' }}
        </p>

        <h3 class="mtitle">没填开始时间的本机记录</h3>
        <p class="empty">这些是回写 Health Connect 时被跳过的本机记录（Health Connect 里没有开始时间就没处安放）</p>
        <HealthWorkoutList
          v-if="missingStartWorkouts.length"
          :items="missingStartWorkouts"
          :show-source="false"
        />
        <p v-else class="empty">没有这一类记录</p>
      </template>
    </section>

    <!-- 4. 规则说明：双向同步必须把「谁能改谁」讲清楚，否则用户不敢点同步。
         四条归属规则收进标题行 InfoHint，卡面只留一行结论 -->
    <section class="card">
      <h2 class="gtitle rules-head">
        同步规则
        <InfoHint title="同步规则" :content="syncRules" />
      </h2>
      <!-- 两个方向各一枚胶囊：nowrap 的单枚装不下整句，拆开才不在窄屏溢出 -->
      <StatusChip tone="neutral" size="sm">手机导入以 Health Connect 为准</StatusChip>
      <StatusChip tone="neutral" size="sm">本机记录以 Rein 为准</StatusChip>
    </section>

    <!-- 指标详情：趋势 + raw 数据（预览卡点行打开） -->
    <MetricDetailSheet
      :open="detailOpen"
      :meta="detail?.meta ?? null"
      :series="detail?.series ?? null"
      @close="detailOpen = false"
    />
    </div>
  </div>
</template>

<style scoped>
/* 三级页的标准骨架（与设置页 / 同步页同一套）：
   .page 管画布留白，.gtitle 是卡内分组标题 —— 两者都是页面私有的 scoped 类，
   全局没有兜底，漏写就会退化成浏览器默认的 h2 大黑标题。 */
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 卡内分区标题：与设置页 / 同步页 / 特征设置同一档 18 Medium（Subtitle_L）。
   此前是 12/700 的「眉标」写法，同属设置链路却比别的二级页弱一档，
   读起来像一条批注而不是一节的标题。 */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.rows {
  display: flex;
  flex-direction: column;
  margin-top: var(--sp-4);
}

.frow {
  display: flex;
  align-items: center;
  /* 表单行按单行行高 48（--row-h）：与下方指标行同一档 */
  min-height: var(--row-h);
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
}

.frow + .frow {
  border-top: 0.5px solid var(--line);
}

.fic {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-s);
  background: var(--accent-soft);
  color: var(--accent);
}

.ftxt {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  min-width: 0;
  flex: 1;
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ftxt small {
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

/* 累计导入 / 回写：两枚胶囊并列，替代原先「·」串成的一句 */
.cum {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-tight);
  margin-top: var(--sp-4);
}

/* 同步规则标题行：整卡收进 InfoHint，只剩一枚「?」在标题右端 */
.rules-head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.rules-head :deep(.info-hint) {
  margin-left: auto;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  flex: none;
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-caption);
}

.pill.ok {
  background: var(--ok-soft);
  /* soft 底上的文字走 --ok-strong：实底档 --ok 压在同名 soft 底上只有 1.95:1 */
  color: var(--ok-strong);
}

/* 行尾小按钮：高 28（--control-sm 小按钮档），视觉不放大，
   命中区撑到 44（规范：可点元素热区 ≥44）。行高 48，上下各外扩 8 不叠行。 */
.act {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  flex: none;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border: none;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  cursor: pointer;
}

.act::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--hit-min);
  transform: translateY(-50%);
}

.act:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

.spin {
  animation: rein-spin 900ms linear infinite;
}

.hint {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  margin: var(--sp-10) 0 var(--sp-2);
  /* 这是要读的阻塞原因：--warn 实底档当文字用压在白卡上不足 3:1，走文字档 */
  color: var(--warn-strong);
  font-size: var(--fs-caption);
}

.rep {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-6) var(--sp-14);
  margin-top: var(--sp-10);
  padding-top: var(--sp-10);
  border-top: 1px solid var(--line);
  color: var(--text-2);
  font-size: var(--fs-caption);
}

/* ---- 同步起始日期 ---- */

/* 与普通 .frow 并排不同：这行是竖排的（标题在上、分段控件与说明在下），
   分段控件要占满整行宽度，不能被标题挤成窄条 */
.window {
  flex-direction: column;
  align-items: stretch;
  gap: var(--gap-sm);
}

/* 竖排里标题块按内容高，不参与纵向伸缩 */
.window .ftxt {
  flex: none;
}

.sub {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.date-input {
  align-self: flex-start;
  padding: var(--sp-6) var(--sp-10);
  border: none;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}

/* ---- 健康数据预览 ---- */

.empty {
  margin: var(--sp-8) 0 var(--sp-4);
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.mgroup + .mgroup {
  /* 指标组之间 12（卡片间距） */
  margin-top: var(--gap-md);
}

.mtitle {
  margin: var(--sp-8) 0 var(--sp-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.mrow {
  display: flex;
  align-items: center;
  /* 指标行高 48（--row-h），数值等宽右对齐 */
  min-height: var(--row-h);
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
  cursor: pointer;
}

.mrow:active {
  background: var(--surface-2);
}

.mrow + .mrow {
  border-top: 0.5px solid var(--line);
}

.mchev {
  flex: none;
  color: var(--text-3);
}

.mtxt {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  flex: none;
  min-width: 72px;
}

.mtxt b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.mtxt small {
  color: var(--text-3);
  font-size: var(--fs-caption);
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: var(--gap-text);
  height: 26px;
  flex: 1;
  min-width: 0;
}

.bar {
  flex: 1;
  max-width: 9px;
  border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  background: var(--accent);
  opacity: 0.75;
}

.bar.empty {
  height: 2px !important;
  border-radius: var(--radius-xs);
  background: var(--line);
  opacity: 1;
}

.mval {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--gap-text);
  flex: none;
  min-width: 64px;
}

.mval b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.mval small {
  color: var(--text-3);
  font-size: var(--fs-caption);
}
</style>
