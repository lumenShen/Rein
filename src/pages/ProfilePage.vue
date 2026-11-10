<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import {
  ChevronRight,
  Crown,
  Database,
  Folder,
  HeartPulse,
  Link2,
  MessageCircle,
  Settings2,
  Upload,
} from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ConstraintsSheet from '@/components/profile/ConstraintsSheet.vue'
import {
  HEALTH_METRIC_BY_KEY,
  formatMetricValue,
  type HealthMetricMeta,
} from '@/config/healthMetrics'
import {
  HEALTH_TILES,
  PROGRAM_DATA_ROOTS,
  PROGRAM_GROUP,
  WORKSPACE_GROUPS,
  countSources,
  type WorkspaceGroup,
  type WorkspaceGroupKey,
} from '@/config/workspaceView'
import { toMs } from '@/files/provider'
import { healthSyncService } from '@/services/healthSyncService'
import { kbService } from '@/services/kbService'
import { useNutritionStore } from '@/stores/nutrition'
import type { HealthMetricSeries, KbCognition, KbMemory, KbMemoryStats } from '@/types'
import { fmtDateCn, toDateStr } from '@/utils/date'
import { bmiBand, bmiOf } from '@/utils/health'

/**
 * 「关于你」= 现有 VFS 的人类可读投影，不新增存储、不移动任何物理路径。
 *
 * 页面回答三件事：
 *   1. Rein 现在知道什么 ——「我对你的了解」读 kb_memories / kb_memory_stats /
 *      kb_cognition（AI 从对话里提炼的长期记忆，不是用户手填的表单）；
 *   2. 这些信息放在哪 —— 健康 / 生活 / 语音笔记 / 笔记与文档 / Rein 的角落，
 *      都是 `config/workspaceView.ts` 里的前端分组，点进去是真实的 `kb_list_dir`；
 *   3. 系统自己生成了哪些文件 —— 最后一张弱化的「程序数据」，只读、按物理目录读。
 *
 * 数据纪律：
 * - 首页只调一次 `kb_list_dir('')` 拿各 root 的 childCount 求和（与逐 root 列举同值，
 *   见 workspaceView.ts 文件头）；`kb_usage.areas` 不算 kb_docs，不能拿来做计数。
 * - 四路请求互不阻塞：记忆 / 目录计数 / 健康指标 / 身体资料各管各的 loading、空态与错误，
 *   任何一路失败都只在它自己的卡片里降级，不打断整页。
 * - 健康指标在桌面与未授权时为空数组：磁贴显示 `--`，不显示 `0`，也不弹错。
 */

const router = useRouter()
const n = useNutritionStore()

/* ============================================================
   身体资料：只为健康大卡底部「身体数据与训练约束」与 BMI 读数服务。
   —— 资料仍来自 nutrition.profile；「编辑」打开现有 ConstraintsSheet。
   ============================================================ */

const profileLoading = ref(true)
const profileError = ref<string | null>(null)
const editOpen = ref(false)

const bmi = computed(() => bmiOf(n.profile?.weightKg ?? null, n.profile?.heightCm ?? null))
const bmiBandInfo = computed(() => (bmi.value == null ? null : bmiBand(bmi.value)))
const bmiText = computed(() => (bmi.value == null ? '' : bmi.value.toFixed(1)))

/** ConstraintsSheet 只在 open 变 true 时把 profile 拷进草稿；资料晚到不会被二次同步，
 *  所以先等 profile 到位再允许打开（与方案 R18 同一条纪律）。 */
const profileReady = computed(() => n.profile !== null)

function openEdit(): void {
  if (!profileReady.value) return
  editOpen.value = true
}

/* ============================================================
   「我对你的了解」
   ============================================================ */

const memories = ref<KbMemory[]>([])
const stats = ref<KbMemoryStats | null>(null)
const cognition = ref<KbCognition | null>(null)
const memLoading = ref(true)
const memError = ref<string | null>(null)
const cogOpen = ref(false)

function formatDay(ms: number): string {
  return fmtDateCn(toDateStr(new Date(ms)))
}

function formatMonthDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

const activeCount = computed(
  () => stats.value?.active ?? memories.value.filter((m) => !m.archivedAt).length,
)

const latestUpdatedMs = computed<number | null>(() => {
  let max: number | null = null
  for (const m of memories.value) {
    const t = toMs(m.updatedAt)
    if (t != null && (max == null || t > max)) max = t
  }
  return max
})

const updatedText = computed(() =>
  latestUpdatedMs.value == null ? '尚未更新' : formatDay(latestUpdatedMs.value),
)

/** 卡头第二行的完整文案：读不到时说读不到，不把「更新于 尚未更新」拼出来。 */
const updatedLine = computed(() => {
  if (memLoading.value) return '正在读取…'
  if (memError.value) return '暂时读不到'
  return latestUpdatedMs.value == null ? '尚未更新' : `更新于 ${updatedText.value}`
})

/** 「新」徽标：最近 7 天内有记忆更新 —— 只做提示，不参与任何判断。 */
const isFresh = computed(
  () =>
    latestUpdatedMs.value != null &&
    Date.now() - latestUpdatedMs.value < 7 * 24 * 60 * 60 * 1000,
)

/** 摘要取 salience 最高的 5 条；一条记忆都没有时退回 cognition.text 的第一段。 */
const memoryLines = computed<string[]>(() => {
  const top = [...memories.value]
    .sort(
      (a, b) =>
        (b.salience ?? 0) - (a.salience ?? 0) ||
        (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0),
    )
    .slice(0, 5)
    .map((m) => m.content.trim())
    .filter(Boolean)
  if (top.length) return top
  const first = (cognition.value?.text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean)
  return first ? [first] : []
})

const hasMemory = computed(() => memoryLines.value.length > 0)

const cognitionText = computed(() => cognition.value?.text?.trim() ?? '')

const statsLine = computed(() => {
  if (memLoading.value) return ''
  const s = stats.value
  if (s) {
    return `${s.active} 条记忆 · ${s.injected} 条注入 · ${Math.round((s.signalRatio ?? 0) * 100)}% 覆盖率`
  }
  if (memError.value) return ''
  return memories.value.length ? `${memories.value.length} 条记忆` : ''
})

/** 页头副标：记忆数 + 最近更新时间。stats 失败时不要误报「还没有记忆」。 */
const headerSubtitle = computed<string | undefined>(() => {
  if (memLoading.value) return '正在读取记忆…'
  if (memError.value) return undefined
  if (activeCount.value === 0) return '还没有记忆'
  return latestUpdatedMs.value == null
    ? `${activeCount.value} 条记忆`
    : `${activeCount.value} 条记忆 · 更新于 ${formatDay(latestUpdatedMs.value)}`
})

/* ============================================================
   目录计数：一次 listDir('')，按 root 名存 childCount
   ============================================================ */

interface DirStat {
  count: number
  updatedMs: number | null
}

const rootStats = ref<ReadonlyMap<string, DirStat>>(new Map())
const countsLoading = ref(true)
const countsError = ref<string | null>(null)

const countMap = computed<ReadonlyMap<string, number>>(() => {
  const map = new Map<string, number>()
  for (const [root, stat] of rootStats.value) map.set(root, stat.count)
  return map
})

const folderGroups = computed(() => WORKSPACE_GROUPS.filter((g) => g.kind !== 'health'))
const healthGroup = computed(() => WORKSPACE_GROUPS.find((g) => g.key === 'health'))

const healthCount = computed(() =>
  healthGroup.value ? countSources(healthGroup.value.sources, countMap.value) : 0,
)

function groupCount(group: WorkspaceGroup): number {
  return countSources(group.sources, countMap.value)
}

function groupCountText(group: WorkspaceGroup): string {
  if (countsError.value) return '— 项'
  return `${groupCount(group)} 项`
}

/** 分组「最近更新」只在物理 root 自带 updatedAt 时显示；隐式目录没有这列就留空。 */
function groupUpdatedText(group: WorkspaceGroup): string {
  let max: number | null = null
  for (const root of group.sources) {
    const t = rootStats.value.get(root)?.updatedMs ?? null
    if (t != null && (max == null || t > max)) max = t
  }
  return max == null ? '' : `${formatMonthDay(max)}更新`
}

/* ============================================================
   健康磁贴
   ============================================================ */

const metrics = ref<HealthMetricSeries[]>([])
const metricsLoading = ref(true)
const metricsError = ref<string | null>(null)

interface TileView {
  metric: string
  label: string
  icon: Component
  testid: string
  meta?: HealthMetricMeta
  series?: HealthMetricSeries
}

const metricsByKey = computed(() => {
  const map = new Map<string, HealthMetricSeries>()
  for (const s of metrics.value) map.set(s.metric, s)
  return map
})

const tileViews = computed<TileView[]>(() =>
  HEALTH_TILES.map((tile) => ({
    ...tile,
    meta: HEALTH_METRIC_BY_KEY[tile.metric],
    series: metricsByKey.value.get(tile.metric),
  })),
)

const metricsWithData = computed(
  () => HEALTH_TILES.filter((tile) => metricsByKey.value.has(tile.metric)).length,
)

const healthMetaText = computed(() => {
  if (countsLoading.value || metricsLoading.value) return '正在读取…'
  const count = countsError.value ? '—' : `${healthCount.value}`
  const metricCount = metricsError.value ? '—' : `${metricsWithData.value}`
  return `${healthGroup.value?.hint ?? ''} · ${metricCount} 项指标 · ${count} 项`
})

/** series 不存在才显示 `--`；series.latestValue === 0 是有效数据，照常显示 0。 */
function tileValue(tile: TileView): string {
  if (!tile.series || !tile.meta) return '--'
  return formatMetricValue(tile.meta, tile.series.latestValue)
}

function tileUnit(tile: TileView): string {
  if (!tile.meta || tile.meta.format === 'duration') return ''
  return tile.meta.unit
}

/* ============================================================
   数据加载：四路独立，互不阻塞
   ============================================================ */

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function settle<T>(request: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await request }
  } catch (error) {
    return { ok: false, error }
  }
}

async function loadMemory(): Promise<void> {
  memLoading.value = true
  memError.value = null
  const [mem, stat, cog] = await Promise.all([
    settle(kbService.memories(undefined, 'active')),
    settle(kbService.memoryStats()),
    settle(kbService.cognition()),
  ])
  if (mem.ok) memories.value = mem.value
  else {
    memError.value = '记忆暂时读不到'
    console.warn('[about] kb_memories 读取失败', mem.error)
  }
  if (stat.ok) stats.value = stat.value
  else console.warn('[about] kb_memory_stats 读取失败', stat.error)
  if (cog.ok) cognition.value = cog.value
  else console.warn('[about] kb_cognition 读取失败', cog.error)
  memLoading.value = false
}

async function loadCounts(): Promise<void> {
  countsLoading.value = true
  countsError.value = null
  const result = await settle(kbService.listDir(''))
  if (result.ok) {
    const map = new Map<string, DirStat>()
    for (const entry of result.value.entries) {
      map.set(entry.name, {
        count: entry.childCount,
        updatedMs: toMs(entry.updatedAt) ?? null,
      })
    }
    rootStats.value = map
  } else {
    countsError.value = '工作区目录暂时读不到'
    console.warn('[about] kb_list_dir 读取失败', result.error)
  }
  countsLoading.value = false
}

async function loadMetrics(): Promise<void> {
  metricsLoading.value = true
  metricsError.value = null
  const result = await settle(healthSyncService.metrics())
  if (result.ok) {
    metrics.value = result.value
  } else {
    metrics.value = []
    metricsError.value = '健康数据暂时读不到'
    console.warn('[about] health_metrics_all 读取失败', result.error)
  }
  metricsLoading.value = false
}

async function loadProfile(): Promise<void> {
  profileLoading.value = true
  profileError.value = null
  const result = await settle(n.loadProfile())
  if (!result.ok) {
    profileError.value = '资料暂时读不到'
    console.warn('[about] 身体资料读取失败', result.error)
  }
  profileLoading.value = false
}

onMounted(() => {
  void loadMemory()
  void loadCounts()
  void loadMetrics()
  void loadProfile()
})

/* ============================================================
   导航与展示辅助
   ============================================================ */

function goFolder(key: WorkspaceGroupKey): void {
  void router.push({ name: 'me-folder', query: { key } })
}

function goProgram(): void {
  void router.push({ name: 'me-program' })
}

function goSettings(): void {
  void router.push({ name: 'settings' })
}

function goApps(): void {
  void router.push({ name: 'settings-apps' })
}

function goHealthData(): void {
  void router.push({ name: 'settings-health' })
}

function goChat(): void {
  void router.push({ name: 'ai' })
}

/** 上传落点：文件管理器读到 `?upload=1` 后显示一次性提示条，按钮点击才打开选择器。
 *  不在这里或落地页的 onMounted 自动点 —— 无用户手势的选择器会被浏览器静默拒绝。 */
function goUpload(): void {
  void router.push({ name: 'ai-files', query: { upload: '1' } })
}

function goKnowledge(): void {
  void router.push({ name: 'ai-knowledge' })
}

function openMemoryFile(name: string): void {
  void router.push({ name: 'ai-files', query: { path: `用户记忆/${name}` } })
}

/** 图标章的模块色：accent 是 `--mod-*` 变量名，soft/strong 是它的两支派生色。 */
function accentStyle(accent: string): string {
  return `--fic-bg: var(${accent}-soft); --fic-fg: var(${accent}-strong)`
}
</script>

<template>
  <div class="page" data-testid="about-page">
    <PageHeader title="关于你" :subtitle="headerSubtitle">
      <template #action>
        <button
          class="hdr-btn"
          data-testid="about-settings-entry"
          aria-label="设置"
          @click="goSettings"
        >
          <span data-testid="about-settings"><Settings2 :size="18" /></span>
        </button>
      </template>
    </PageHeader>

    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <!-- 引导卡：告诉用户能补什么、补了会发生什么 -->
      <section class="card d-full" data-testid="about-guide-card">
        <header class="hero-head" data-testid="about-hero">
          <h2>让 Rein 更了解你</h2>
          <p class="hero-lead">给 Rein 一些可参考的信息。它知道得越多，就越能帮到你。</p>
        </header>
        <div class="card sub guide">
          <button class="guide-row" data-testid="about-guide-upload" @click="goUpload">
            <span class="fic" :style="accentStyle('--mod-focus')" data-testid="about-import">
              <Upload :size="18" />
            </span>
            <span class="gtext col">
              <b>上传文件</b>
              <em>文档、图片或录音都可以</em>
            </span>
            <ChevronRight :size="16" class="t-3" />
          </button>
          <button class="guide-row" data-testid="about-guide-connect" @click="goApps">
            <span class="fic" :style="accentStyle('--mod-campus')">
              <Link2 :size="18" />
            </span>
            <span class="gtext col">
              <b>设置连接应用</b>
              <em>安卓与 Windows 的数据入口</em>
            </span>
            <ChevronRight :size="16" class="t-3" />
          </button>
          <button class="guide-row" data-testid="about-guide-chat" @click="goChat">
            <span class="fic" :style="accentStyle('--mod-ai')">
              <MessageCircle :size="18" />
            </span>
            <span class="gtext col">
              <b>和 Rein 聊聊</b>
              <em>说得越多，这里越像你</em>
            </span>
            <ChevronRight :size="16" class="t-3" />
          </button>
        </div>
      </section>

      <!-- 「我对你的了解」：AI 提炼的长期记忆，不是表单 -->
      <section class="card d-full" data-testid="about-memory-card" :aria-busy="memLoading">
        <header class="row between chead" data-testid="about-memory">
          <div class="row chead-title">
            <span class="fic mem-ic"><Crown :size="18" /></span>
            <h2>我对你的了解</h2>
            <PillChip v-if="isFresh && hasMemory" tone="action" size="sm">新</PillChip>
          </div>
          <span class="hint-slot">
            <InfoHint
              title="我对你的了解"
              content="这些是 AI 从对话里提炼的长期记忆；点「查看 AI 实际读到的版本」能看到它这一轮真正注入的文本。"
            />
          </span>
        </header>
        <p class="mtime">{{ updatedLine }}</p>

        <div v-if="memLoading" class="mskel" aria-hidden="true">
          <span v-for="i in 3" :key="i" class="skel" />
        </div>

        <div v-else-if="memError" class="mfail">
          <p>{{ memError }}</p>
          <button class="textlink" @click="loadMemory">重试</button>
        </div>

        <div v-else-if="!hasMemory" class="mempty" data-testid="about-memory-empty">
          <p class="mempty-title">我还不太了解你</p>
          <p class="mempty-copy">多聊聊、上传一些资料，我会慢慢记住。</p>
          <div class="mempty-btns">
            <PillChip as="button" tone="action" @click="openMemoryFile('角色设定.md')">
              填写角色设定
            </PillChip>
            <PillChip as="button" tone="muted" @click="openMemoryFile('全局规范.md')">
              填写全局规范
            </PillChip>
          </div>
        </div>

        <div v-else class="mbody">
          <div class="mlines" data-testid="about-memory-body">
            <p v-for="(line, i) in memoryLines" :key="i" class="mline">{{ line }}</p>
          </div>
          <p v-if="statsLine" class="mstats num">{{ statsLine }}</p>
        </div>

        <footer v-if="!memLoading && !memError && hasMemory" class="mfoot">
          <button class="mlink" data-testid="about-memory-manage" @click="goKnowledge">
            <span>查看全部 {{ activeCount }} 条记忆</span>
            <ChevronRight :size="14" />
          </button>
          <button
            v-if="cognitionText"
            class="mlink muted"
            data-testid="about-memory-cognition"
            @click="cogOpen = true"
          >
            查看 AI 实际读到的版本
          </button>
        </footer>
      </section>

      <!-- 全部文件夹：健康大卡跨满，其余双列 -->
      <section class="workspace d-full">
        <h2 class="workspace-title" data-testid="about-all-title">全部</h2>

        <div class="folders">
          <section
            class="card health-card fwide"
            data-testid="about-health-card"
            :aria-busy="metricsLoading"
          >
            <header class="row between chead">
              <div class="row chead-title">
                <span class="fic health-ic"><HeartPulse :size="18" /></span>
                <div class="col health-head">
                  <h2>健康</h2>
                  <p class="health-sub" data-testid="about-health-meta">{{ healthMetaText }}</p>
                </div>
              </div>
              <PillChip
                as="button"
                tone="muted"
                data-testid="about-folder-health"
                @click="goFolder('health')"
              >
                查看
                <ChevronRight :size="13" :stroke-width="2.6" />
              </PillChip>
            </header>

            <div class="tiles">
              <div
                v-for="tile in tileViews"
                :key="tile.metric"
                class="tile"
                :data-testid="tile.testid"
              >
                <span class="tile-label">
                  <component :is="tile.icon" :size="14" />
                  {{ tile.label }}
                </span>
                <span v-if="metricsLoading" class="skel tile-skel" aria-hidden="true" />
                <span v-else class="tile-value num">
                  {{ tileValue(tile) }}<i v-if="tileUnit(tile)">{{ tileUnit(tile) }}</i>
                </span>
              </div>
            </div>
            <div v-if="metricsError && !metricsLoading" class="health-note">
              <span>{{ metricsError }} · 仅 Android 可同步 Health Connect</span>
              <button class="textlink" @click="loadMetrics">重试</button>
            </div>

            <div class="hrows">
              <button
                class="hrow"
                data-testid="about-constraints-edit"
                :disabled="!profileReady"
                @click="openEdit"
              >
                <span class="hrow-main">
                  <b>身体数据与训练约束</b>
                  <em v-if="bmiText">
                    BMI {{ bmiText }}<template v-if="bmiBandInfo"> · {{ bmiBandInfo.label }}</template>
                  </em>
                  <em v-else>
                    {{
                      profileLoading
                        ? '正在读取资料…'
                        : profileError
                          ? '资料暂时读不到'
                          : '还没填身体数据'
                    }}
                  </em>
                </span>
                <span class="hrow-action">{{ profileReady ? '编辑' : '稍候' }}</span>
                <ChevronRight :size="14" class="t-3" />
              </button>
              <button class="hrow" data-testid="about-health-auth" @click="goHealthData">
                <span class="hrow-main">
                  <b>健康数据授权</b>
                  <em>仅 Android 有 Health Connect</em>
                </span>
                <ChevronRight :size="14" class="t-3" />
              </button>
            </div>
          </section>

          <button
            v-for="g in folderGroups"
            :key="g.key"
            class="card fcard"
            :data-testid="g.testid"
            @click="goFolder(g.key)"
          >
            <span class="fic folder-ic" :style="accentStyle(g.accent)">
              <Folder :size="20" />
            </span>
            <span class="fname">{{ g.title }}</span>
            <span class="fmeta num">
              <span v-if="countsLoading" class="skel fmeta-skel" aria-hidden="true" />
              <template v-else>
                {{ groupCountText(g) }}<template v-if="groupUpdatedText(g)"> · {{ groupUpdatedText(g) }}</template>
              </template>
            </span>
          </button>
        </div>

        <p v-if="countsError" class="workspace-note" data-testid="about-workspace-error">
          <span>{{ countsError }}</span>
          <button class="textlink" @click="loadCounts">重试</button>
        </p>

        <button class="card prog" data-testid="about-program-card" @click="goProgram">
          <span class="fic prog-ic"><Database :size="18" /></span>
          <span class="col prog-copy">
            <b>{{ PROGRAM_GROUP.title }}</b>
            <em>{{ PROGRAM_GROUP.hint }}</em>
          </span>
          <span class="prog-count num">{{ PROGRAM_DATA_ROOTS.length }} 个目录</span>
          <ChevronRight :size="16" class="t-3" />
        </button>
      </section>

      <ConstraintsSheet :open="editOpen" @close="editOpen = false" />
    </div>

    <SheetModal
      :open="cogOpen"
      title="AI 实际读到的版本"
      initial-snap="large"
      @close="cogOpen = false"
    >
      <pre v-if="cognitionText" class="cog">{{ cognitionText }}</pre>
      <p v-else class="t-2">还没有可注入的记忆。</p>
    </SheetModal>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 引导卡 ---------- */

.hero-head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-1);
}

.hero-lead {
  margin-top: var(--gap-sm);
  font-size: var(--fs-subhead);
  line-height: 1.5;
  color: var(--text-2);
}

.guide {
  margin-top: var(--gap-md);
}

.guide-row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h-double);
  padding: 0;
  border-radius: var(--radius-s);
  text-align: left;
  font: inherit;
  color: inherit;
}

.guide-row + .guide-row {
  border-top: 0.5px solid var(--line);
  border-radius: 0;
}

.guide-row:active {
  /* 行整条按压：用底色而不是整行缩放（缩放会把发丝线一起挤歪） */
  transform: none;
  background: var(--surface-3);
}

.gtext {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.gtext b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.gtext em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* ---------- 图标章（34：与设置页 .fic 同一档几何） ---------- */

.fic {
  width: var(--control-icon);
  height: var(--control-icon);
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-s);
  background: var(--fic-bg, var(--surface-2));
  color: var(--fic-fg, var(--text-2));
}

.mem-ic {
  background: var(--mod-ledger-soft);
  color: var(--mod-ledger-strong);
}

.health-ic {
  background: var(--mod-program-soft);
  color: var(--mod-program-strong);
}

/* ---------- 卡头 ---------- */

.chead {
  gap: var(--gap-sm);
}

.chead-title {
  flex: 1;
  gap: var(--gap-sm);
  min-width: 0;
}

.chead h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-1);
}

.hint-slot {
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

/* ---------- 记忆卡 ---------- */

.mtime {
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mskel {
  margin-top: var(--gap-md);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.skel {
  display: block;
  height: var(--sp-12);
  border-radius: var(--radius-xs);
  background: linear-gradient(
    100deg,
    var(--surface-2) 30%,
    color-mix(in srgb, var(--text-3) 12%, var(--surface-2)) 50%,
    var(--surface-2) 70%
  );
  background-size: 220% 100%;
  animation: about-shimmer 1.3s linear infinite;
}

@keyframes about-shimmer {
  from {
    background-position: 140% 0;
  }
  to {
    background-position: -40% 0;
  }
}

.mbody {
  margin-top: var(--gap-md);
}

.mlines {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.mline {
  font-size: var(--fs-subhead);
  line-height: 1.55;
  color: var(--text-1);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.mstats {
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mfoot {
  margin-top: var(--gap-md);
  padding-top: var(--gap-sm);
  border-top: 0.5px solid var(--line);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.mlink {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--hit-min);
  padding: 0;
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--accent-strong);
}

.mlink.muted {
  color: var(--text-2);
  font-weight: var(--fw-regular);
}

.mfail {
  margin-top: var(--gap-md);
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.textlink {
  min-height: var(--hit-min);
  padding: 0 var(--gap-sm);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--accent-strong);
}

.mempty {
  margin-top: var(--gap-md);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.mempty-title {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.mempty-copy {
  font-size: var(--fs-subhead);
  line-height: 1.5;
  color: var(--text-2);
}

.mempty-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  margin-top: var(--gap-tight);
}

/* ---------- 全部文件夹 ---------- */

.workspace {
  margin-top: var(--gap-lg);
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.workspace-title {
  padding: 0 var(--sp-4);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-1);
}

.folders {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gap-md);
  align-items: stretch;
}

/* 栅格用 gap 管行距：卡片之间那条全局 12px 兄弟边距要收掉，否则行距翻倍 */
.folders > .card + .card {
  margin-top: 0;
}

.fwide {
  grid-column: 1 / -1;
}

.fcard {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-sm);
  min-width: 0;
  padding: var(--pad-card-tight);
  text-align: left;
  font: inherit;
  color: inherit;
}

.fcard:active {
  background: var(--surface-2);
}

.folder-ic {
  width: var(--control-md);
  height: var(--control-md);
  border-radius: var(--radius-m-nest);
}

.fname {
  max-width: 100%;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.fmeta {
  max-width: 100%;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.fmeta-skel {
  display: inline-block;
  vertical-align: middle;
  width: var(--sp-56);
  height: var(--sp-10);
}

/* ---------- 健康大卡 ---------- */

.health-head {
  min-width: 0;
  gap: var(--gap-text);
}

.health-sub {
  font-size: var(--fs-caption);
  line-height: 1.4;
  color: var(--text-2);
}

.tiles {
  margin-top: var(--gap-md);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gap-sm);
}

.tile {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  min-width: 0;
  padding: var(--gap-md);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
}

.tile-label {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.tile-value {
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
  letter-spacing: -0.4px;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile-value i {
  margin-left: var(--sp-4);
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  letter-spacing: 0;
  color: var(--text-3);
}

.tile-skel {
  width: 70%;
  height: var(--sp-16);
  margin-top: var(--sp-4);
}

.health-note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.workspace-note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.hrows {
  margin-top: var(--gap-md);
  padding-top: var(--gap-sm);
  border-top: 0.5px solid var(--line);
  display: flex;
  flex-direction: column;
}

.hrow {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  width: 100%;
  min-height: var(--row-h-double);
  padding: 0;
  text-align: left;
  font: inherit;
  color: inherit;
}

.hrow + .hrow {
  border-top: 0.5px solid var(--line);
}

.hrow:active {
  transform: none;
  background: var(--surface-inset);
}

.hrow:disabled {
  opacity: 0.6;
}

.hrow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.hrow-main b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.hrow-main em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.hrow-action {
  flex: none;
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--accent-strong);
}

/* ---------- 程序数据（弱化、整宽、最后一张） ---------- */

.prog {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
}

.prog:active {
  background: var(--surface-2);
}

.prog-ic {
  background: var(--surface-2);
  color: var(--text-3);
}

.prog-copy {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.prog-copy b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.prog-copy em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: 1.4;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.prog-count {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* ---------- 认知块抽屉 ---------- */

.cog {
  margin: 0;
  font-family: inherit;
  font-size: var(--fs-subhead);
  line-height: 1.6;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
