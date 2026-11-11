<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertCircle,
  Archive,
  Brain,
  Cpu,
  Database,
  Download,
  FilePlus2,
  FlaskConical,
  FolderOpen,
  FolderTree,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { kbService, onKbIndexProgress, onKbModelProgress } from '@/services/kbService'
import { humanBytes } from '@/utils/format'
import { useAiStore } from '@/stores/ai'
import { useMemoryStore } from '@/stores/memory'
import { useToast } from '@/composables/useToast'
import {
  KB_MEMORY_LABELS,
  KB_SOURCE_LABELS,
  type KbChunk,
  type KbEmbedCatalog,
  type KbEmbeddingMode,
  type KbEmbedTestResult,
  type KbHit,
  type KbIndexEvent,
  type KbModelEvent,
  type KbSettings,
  type KbSourceType,
  type KbStatus,
  type MemoryDuplicate,
  type MemoryShard,
  type MemoryShardEvent,
  type MemoryShardOrigin,
  type MemoryShardState,
  type MemoryShardStats,
} from '@/types'

/** 知识库 · 二级页。信息架构按到访频率排布：
 *  主体只有三块 —— 检索（高频入口，置顶）、长期记忆（AI 记住了什么）、文件（新建笔记 + 文件库入口）。
 *  低频的机器层（嵌入模式 / 索引范围 / 索引概况 / 云端配置）收进「检索设置」抽屉；
 *  文档阅读用全高抽屉，不再往页面中段插卡。 */

const toast = useToast()
const ai = useAiStore()
const memory = useMemoryStore()
const router = useRouter()

const status = ref<KbStatus | null>(null)
/** kb://index 订阅的退订句柄（卸载时释放，否则重挂载会重复派发） */
let offIndex: (() => void) | null = null
const settings = ref<KbSettings | null>(null)
const busy = ref(false)
const probing = ref(false)
const settingsOpen = ref(false)

const mode = ref<KbEmbeddingMode>('keyword')
const cloudBaseUrl = ref('')
const cloudApiKey = ref('')
const cloudModel = ref('')
const autoMemory = ref(true)
const autoConsolidate = ref(true)

/* ---------- 本地模型（可选 / 可下载）与自定义嵌入测试 ---------- */

const embedCatalog = ref<KbEmbedCatalog | null>(null)
const localModel = ref('bge-small-zh-v1.5-int8')
/** 正在下载/删除的模型 id（按钮态） */
const modelBusy = ref<string | null>(null)
/** 下载进度：{ id, file, pct }；null = 没有进行中的下载 */
const modelProgress = ref<{ id: string; file: string; pct: number } | null>(null)
let offModel: (() => void) | null = null
/** 组件是否已卸载（订阅是异步建立的，落地前要先看这个再决定退不退订） */
let disposed = false
/** 上一次已渲染的下载百分比：同一个数不重复赋值，省掉整页重渲染 */
let lastModelPct = -1

/** 测试面板：一段查询 + 若干候选（一行一条），可选第二个模型做对比 */
const testTexts = ref('膝盖疼怎么练腿\n膝关节不适时的腿部训练该怎么安排\n今天晚饭吃什么')
const testModelA = ref('')
const testModelB = ref('')
const testRunning = ref(false)
const testA = ref<KbEmbedTestResult | null>(null)
const testB = ref<KbEmbedTestResult | null>(null)

/** 记忆库整理辅助：疑似重复对 + 最近分片事件 */
const duplicates = ref<MemoryDuplicate[]>([])
const events = ref<MemoryShardEvent[]>([])
const dupOpen = ref(false)

const testLines = computed(() =>
  testTexts.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 16),
)

const query = ref('')
const hits = ref<KbHit[] | null>(null)
const searching = ref(false)

const memories = ref<MemoryShard[]>([])
const memoryStats = ref<MemoryShardStats | null>(null)
/** 三态视角（服务端过滤；默认只看活跃） */
const stateFilter = ref<MemoryShardState | 'all'>('active')
/** 来源筛选（默认 curated = 手动/梦境/重要，避免对话分片淹没列表） */
const originFilter = ref<MemoryShardOrigin | 'all' | 'curated'>('curated')
const maintaining = ref(false)
/** 信噪比详情的展开态（默认只给一句结论，数字墙收起来） */
const snrDetail = ref(false)

const stateFilters: { value: MemoryShardState | 'all'; label: string }[] = [
  { value: 'active', label: '活跃' },
  { value: 'dormant', label: '休眠' },
  { value: 'archived', label: '归档' },
  { value: 'all', label: '全部' },
]

const originFilters: { value: MemoryShardOrigin | 'all' | 'curated'; label: string }[] = [
  { value: 'curated', label: '精选' },
  { value: 'manual_write', label: '手动' },
  { value: 'dream_summary', label: '梦境' },
  { value: 'marked_important', label: '重要' },
  { value: 'conversation', label: '对话' },
  { value: 'all', label: '全部' },
]

const visibleMemories = computed(() => memories.value)

const archivedCount = computed(() => memoryStats.value?.archived ?? 0)

/* ---------- 检索设置抽屉 ---------- */

const modeOptions = [
  { value: 'keyword', label: '关键词' },
  { value: 'local', label: '本地模型' },
  { value: 'cloud', label: '云端' },
]

const modeLabel = computed(() => modeOptions.find((o) => o.value === mode.value)?.label ?? '关键词')

/** 抽屉入口的警示点：索引进行中，或当前档位的语义后端没准备好 */
const modeWarn = computed(() => {
  if (!status.value) return false
  if (status.value.indexing) return true
  return mode.value !== 'keyword' && !status.value.embedderReady
})

const allSources: KbSourceType[] = [
  'todo', 'workout', 'plan', 'meal', 'body_metric',
  'food', 'program', 'program_meal', 'voice_memo', 'chat_message', 'memory',
]

/**
 * 索引范围开关分组：11 个来源一次平铺会超出工作记忆上限，按**来源的自然族系**分组
 * （族系从 KB_SOURCE_LABELS 的命名与各源所属模块推断，见 src/types/kb.ts:32）：
 *   · 训练与身体 —— 运动记录 / 训练课程 / 体测数据
 *   · 饮食与方案 —— 饮食记录 / 自建食物 / 健康方案 / 方案菜单
 *   · 日程与任务 —— 日程与附件
 *   · 对话与记忆 —— 语音纪要 / 历史聊天 / 长期记忆
 * 每簇 ≤4 枚；开关本身的 v-model 与逐类点击行为一概不变（additive）。
 */
const sourceGroups: { label: string; items: KbSourceType[] }[] = [
  { label: '训练与身体', items: ['workout', 'plan', 'body_metric'] },
  { label: '饮食与方案', items: ['meal', 'food', 'program', 'program_meal'] },
  { label: '日程与任务', items: ['todo'] },
  { label: '对话与记忆', items: ['voice_memo', 'chat_message', 'memory'] },
]

const sourceEnabled = ref<Record<string, boolean>>({})

const progressPct = computed(() => {
  const p = status.value?.progress
  if (!p || p.total <= 0) return 0
  return Math.min(100, Math.round((p.done / p.total) * 100))
})

/** 记忆分片的服务端过滤参数：列表默认 active + curated，切 chip 时重新拉取。 */
function fetchShards(): Promise<MemoryShard[]> {
  return kbService.memoryShards(
    stateFilter.value === 'all' ? 'all' : stateFilter.value,
    originFilter.value,
    500,
  )
}

async function refresh(): Promise<void> {
  const [s, st, mem, memStats] = await Promise.all([
    kbService.settingsGet(),
    kbService.status(),
    fetchShards(),
    kbService.memoryShardStats(),
  ])
  settings.value = s
  status.value = st
  memories.value = mem
  memoryStats.value = memStats
  mode.value = s.embeddingMode
  localModel.value = s.localModel
  cloudBaseUrl.value = s.cloudBaseUrl ?? ''
  cloudModel.value = s.cloudModel ?? ''
  cloudApiKey.value = ''
  autoMemory.value = s.autoMemory
  autoConsolidate.value = s.autoConsolidate
  sourceEnabled.value = { ...(s.sourcesEnabled as Record<string, boolean>) }
}

/* ---------- 本地模型：目录 / 下载 / 删除 / 切换 ---------- */

async function loadCatalog(): Promise<void> {
  try {
    embedCatalog.value = await kbService.embedModels()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

async function downloadModel(id: string): Promise<void> {
  if (modelBusy.value) return
  modelBusy.value = id
  modelProgress.value = { id, file: '', pct: 0 }
  try {
    await kbService.embedModelDownload(id)
    toast.toast('模型已就绪')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    modelBusy.value = null
    modelProgress.value = null
    await loadCatalog()
  }
}

async function cancelDownload(): Promise<void> {
  const id = modelProgress.value?.id
  if (!id) return
  await kbService.embedModelCancel(id).catch(() => undefined)
}

async function removeModel(id: string): Promise<void> {
  if (modelBusy.value) return
  modelBusy.value = id
  try {
    const freed = await kbService.embedModelRemove(id)
    toast.toast(`已删除，释放 ${humanBytes(freed)}`)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    modelBusy.value = null
    await loadCatalog()
  }
}

/** 换本地模型：落库（后端会作废旧向量并按新模型重算） */
async function pickModel(id: string): Promise<void> {
  if (id === localModel.value || busy.value) return
  const prev = localModel.value
  localModel.value = id
  const ok = await saveSettings(true)
  if (!ok) {
    // 没落库就别把面板留在「已切换」上：后端还会校验注册表，失败是可能的
    localModel.value = prev
    return
  }
  await loadCatalog()
  toast.toast('已切换本地模型，向量会在后台按新模型重算')
}

/* ---------- 自定义嵌入测试 ---------- */

async function runEmbedTest(): Promise<void> {
  if (!testLines.value.length) {
    toast.toast('先写几行文本：第一行是查询，后面是候选')
    return
  }
  if (mode.value === 'keyword' && !testModelA.value) {
    toast.toast('当前是纯关键词模式：上面选一个本地模型再测（或先切到本地/云端模式）')
    return
  }
  testRunning.value = true
  testA.value = null
  testB.value = null
  try {
    const base = { texts: testLines.value }
    testA.value = await kbService.embedTest({
      ...base,
      localModel: testModelA.value || undefined,
    })
    if (testModelB.value) {
      testB.value = await kbService.embedTest({
        ...base,
        localModel: testModelB.value,
      })
    }
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    testRunning.value = false
  }
}

/* ---------- 记忆整理辅助 ---------- */

async function loadMemoryAudit(): Promise<void> {
  try {
    const [dups, evts] = await Promise.all([
      kbService.memoryShardDuplicates(undefined, 12),
      kbService.memoryShardEvents(12),
    ])
    duplicates.value = dups
    events.value = evts
  } catch {
    /* 审计是锦上添花，取不到就不显示 */
  }
}

/** 事件的一句话描述（history 是分片的唯一真相源） */
function eventLabel(e: MemoryShardEvent): string {
  const label: Record<MemoryShardEvent['event'], string> = {
    birth: '诞生',
    search_hit: '检索命中',
    manual_mark: '标记重要',
    manual_edit: '手动编辑',
    manual_archive: '归档',
    manual_restore: '恢复',
    dream_consolidate: '梦境合并',
    dream_revive: '梦境唤醒',
    dream_supersede: '梦境替换',
  }
  const name = label[e.event] ?? e.event
  return e.content ? `${name}：${e.content}` : name
}

function originLabel(origin: MemoryShardOrigin): string {
  const labels: Record<MemoryShardOrigin, string> = {
    conversation: '对话',
    dream_summary: '梦境',
    manual_write: '手动',
    marked_important: '重要',
  }
  return labels[origin] ?? origin
}

function stateLabel(state: MemoryShardState): string {
  return state === 'active' ? '活跃' : state === 'dormant' ? '休眠' : '归档'
}

function formatStability(days: number): string {
  if (!Number.isFinite(days)) return '—'
  if (days >= 365) return `${(days / 365).toFixed(1)} 年`
  return `${days.toFixed(days >= 10 ? 0 : 1)} 天`
}

/** 查看原文：带会话 id 跳到 AI 页，由 AIPage 读 query 后定位 anchor。 */
function openAnchor(m: MemoryShard): void {
  if (!m.anchorMessageId || !m.chatId) return
  void router.push({
    name: 'ai',
    query: { anchor: m.anchorMessageId, chat: m.chatId },
  })
}

/** 只刷新记忆区（记忆操作后调用；不必整页重来）——按当前 chip 的服务端过滤重取 */
async function refreshMemories(): Promise<void> {
  const [mem, stats] = await Promise.all([
    fetchShards(),
    kbService.memoryShardStats(),
  ])
  memories.value = mem
  memoryStats.value = stats
}

async function setStateFilter(value: MemoryShardState | 'all'): Promise<void> {
  if (stateFilter.value === value) return
  stateFilter.value = value
  try {
    await refreshMemories()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

async function setOriginFilter(value: MemoryShardOrigin | 'all' | 'curated'): Promise<void> {
  if (originFilter.value === value) return
  originFilter.value = value
  try {
    await refreshMemories()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 索引进度推送：worker 每推进一轮推一条，就地更新状态条（不必等下一次 kb_status 快照） */
function onIndexProgress(e: KbIndexEvent): void {
  if (!status.value) return
  status.value.progress = { phase: e.phase, done: e.done, total: e.total }
  status.value.pending = e.pending
  status.value.indexing = e.indexing
}

onMounted(() => {
  void refresh().catch((e) => toast.toast(e instanceof Error ? e.message : String(e)))
  void loadCatalog()
  void loadMemoryAudit()
  // 订阅失败（listen 抛错）不该冒成未处理拒绝：丢掉 .catch 会让整个 onMounted 变成
  // unhandled rejection；卸载途中才 resolve 的话当场退订，别把监听留在已销毁的组件上。
  void onKbIndexProgress(onIndexProgress)
    .then((off) => {
      if (disposed) off()
      else offIndex = off
    })
    .catch(() => {})
  void onKbModelProgress(onModelProgress)
    .then((off) => {
      if (disposed) off()
      else offModel = off
    })
    .catch(() => {})
})

onBeforeUnmount(() => {
  disposed = true
  offIndex?.()
  offModel?.()
})

/**
 * 下载进度：Rust 侧已按 1% 节流，前端再把「同一个百分比」合并掉——
 * 赋值是一次组件重渲染，这个页面很大，白渲染几千次就是卡顿。
 */
function onModelProgress(e: KbModelEvent): void {
  if (e.phase === 'error') {
    lastModelPct = -1
    modelProgress.value = null
    if (e.message) toast.toast(e.message)
    return
  }
  if (e.phase === 'done') {
    lastModelPct = -1
    modelProgress.value = null
    return
  }
  const pct = e.total > 0 ? Math.min(100, Math.round((e.done / e.total) * 100)) : 0
  const cur = modelProgress.value
  if (pct === lastModelPct && cur?.id === e.id && cur?.file === e.file) return
  lastModelPct = pct
  modelProgress.value = { id: e.id, file: e.file, pct }
}

/** silent：开关/chips 这类即时生效的小改动不出声，别让「已保存」toast 打断操作节奏。
 *  返回是否落库成功——乐观更新的调用方（如换模型）要拿它决定回不回滚。 */
async function saveSettings(silent = false): Promise<boolean> {
  busy.value = true
  try {
    const input: Record<string, unknown> = {
      embeddingMode: mode.value,
      localModel: localModel.value,
      sourcesEnabled: sourceEnabled.value,
      autoMemory: autoMemory.value,
      autoConsolidate: autoConsolidate.value,
    }
    if (mode.value === 'cloud') {
      input.cloudBaseUrl = cloudBaseUrl.value.trim()
      input.cloudModel = cloudModel.value.trim()
      // 留空 = 不改动已存的密钥（后端拿不到明文，无法回传）
      if (cloudApiKey.value.trim()) input.cloudApiKey = cloudApiKey.value.trim()
    }
    settings.value = await kbService.settingsSet(input)
    cloudApiKey.value = ''
    status.value = await kbService.status()
    if (!silent) toast.toast('已保存')
    return true
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
    return false
  } finally {
    busy.value = false
  }
}

/** 分段控件切档即生效（旧版「点了不保存不生效」的分裂提交模型已废） */
function onModeChange(v: string): void {
  if (v === mode.value) return
  mode.value = v as KbEmbeddingMode
  void saveSettings(true)
}

/** 逐类开关：即时保存但不出声 */
async function toggleSource(t: KbSourceType): Promise<void> {
  const next = !(sourceEnabled.value[t] ?? true)
  sourceEnabled.value = { ...sourceEnabled.value, [t]: next }
  await saveSettings(true)
}

/** 全选 / 清空：一次把 11 个来源整族置开或置关（省得逐枚点 11 下）。
 *  落库口径与逐类开关完全一致（缺省视为开启，所以「关」要显式写 false）。 */
async function setAllSources(on: boolean): Promise<void> {
  const next: Record<string, boolean> = {}
  for (const t of allSources) next[t] = on
  sourceEnabled.value = next
  await saveSettings(true)
}

async function probe(): Promise<void> {
  probing.value = true
  try {
    const dim = await kbService.probeEmbedder()
    toast.toast(`嵌入后端可用，向量维度 ${dim}`)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    probing.value = false
  }
}

async function rebuild(): Promise<void> {
  busy.value = true
  try {
    const n = await kbService.reindex()
    toast.toast(`已重新入队 ${n} 条`)
    status.value = await kbService.status()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

/* ---------- 检索 ---------- */

async function runSearch(): Promise<void> {
  searching.value = true
  try {
    hits.value = await kbService.search({ query: query.value.trim(), limit: 12 })
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    searching.value = false
  }
}

/* ---------- 阅读抽屉：概览 / 全文（滚动加载 + 一次读完） ---------- */

interface ReaderState {
  docId: number
  level: 'l1' | 'l2'
  hasMore: boolean
  totalChunks: number
  chunks: KbChunk[]
  title: string
  path: string | null
  /** 「继续加载」进行中：防重复点、按钮文案读它 */
  loadingMore: boolean
  /** 「一次读完」进行中：这一趟循环期间不许再点任何拉取 */
  busy: boolean
}
const reader = ref<ReaderState | null>(null)
const reading = ref(false)

async function openReader(docId: number, level: 'l1' | 'l2' = 'l1', offset = 0): Promise<void> {
  reading.value = true
  try {
    const d = await kbService.read(docId, level, offset, level === 'l1' ? 1 : 8)
    reader.value = {
      docId: d.id,
      level: d.level as 'l1' | 'l2',
      hasMore: d.hasMore,
      totalChunks: d.totalChunks,
      chunks: d.chunks,
      title: d.title,
      path: d.path,
      loadingMore: false,
      busy: false,
    }
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    reading.value = false
  }
}

function switchLevel(v: string): void {
  const r = reader.value
  if (!r || v === r.level) return
  void openReader(r.docId, v as 'l1' | 'l2', 0)
}

async function loadMore(): Promise<void> {
  const r = reader.value
  if (!r || !r.hasMore || r.loadingMore || r.busy) return
  r.loadingMore = true
  try {
    const d = await kbService.read(r.docId, 'l2', r.chunks.length, 24)
    r.chunks.push(...d.chunks)
    r.totalChunks = d.totalChunks
    r.hasMore = d.hasMore
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    r.loadingMore = false
  }
}

/** 一次读完：kb_read 单次上限 64 块，循环拉到末尾 */
async function readAll(): Promise<void> {
  const r = reader.value
  if (!r || r.busy) return
  r.busy = true
  try {
    while (r.hasMore) {
      const d = await kbService.read(r.docId, 'l2', r.chunks.length, 64)
      if (!d.chunks.length) break
      r.chunks.push(...d.chunks)
      r.totalChunks = d.totalChunks
      r.hasMore = d.hasMore
    }
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    r.busy = false
  }
}

/* ---------- 长期记忆 ---------- */

async function removeMemory(id: number): Promise<void> {
  try {
    await memory.remove(id)
    confirmDel.value = null
    await refreshMemories()
    toast.toast('已删除该条记忆')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 归档：软删除，退出注入与检索，可在「归档」视角里恢复 */
async function archiveMemory(id: number): Promise<void> {
  try {
    await memory.archive(id)
    await refreshMemories()
    toast.toast('已归档（可在「归档」里恢复）')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

async function restoreMemory(id: number): Promise<void> {
  try {
    await memory.restore(id)
    await refreshMemories()
    toast.toast('已恢复到活跃记忆')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 标记重要：origin 改为 marked_important，强度地板更高，自动注入优先 */
async function markImportantMemory(id: number): Promise<void> {
  try {
    await memory.markImportant(id)
    await refreshMemories()
    toast.toast('已标记为重要记忆')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 删除的两段确认：第一段点亮「删除?」，3 秒内再点才真删（防拇指误触永久丢失） */
const confirmDel = ref<number | null>(null)
let confirmDelTimer: ReturnType<typeof setTimeout> | null = null

function tapDeleteMemory(id: number): void {
  if (confirmDel.value === id) {
    void removeMemory(id)
    return
  }
  confirmDel.value = id
  if (confirmDelTimer) clearTimeout(confirmDelTimer)
  confirmDelTimer = setTimeout(() => {
    confirmDel.value = null
  }, 3000)
}

/** 本地维护：按记忆强度重算 active/dormant/archived（无模型调用） */
async function runMaintain(): Promise<void> {
  maintaining.value = true
  try {
    const r = await memory.sweep()
    await refreshMemories()
    await loadMemoryAudit()
    toast.toast(
      r.archived > 0
        ? `检查 ${r.checked} 条：活跃 ${r.activated}、休眠 ${r.dormant}、归档 ${r.archived}`
        : `检查 ${r.checked} 条：活跃 ${r.activated}、休眠 ${r.dormant}，没有新归档`,
    )
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    maintaining.value = false
  }
}

/** AI 整理（Dream）：四类维护动作（合并/替换/摘要/唤醒），一次模型调用 */
async function runConsolidate(): Promise<void> {
  try {
    const changed = await memory.dreamNow(true)
    await refreshMemories()
    await loadMemoryAudit()
    if (changed > 0) {
      // 成功 toast 由 memoryDream（force 且 changes>0）统一发出，这里不再重复
      return
    }
    const reason = memory.dreamError
    if (reason === 'no_model') toast.toast('还没有配置默认模型，已跳过整理')
    else if (reason === 'cooldown') toast.toast('距离上次整理还不到 3 小时')
    else if (reason === 'insufficient_material') toast.toast('最近对话太少，暂时不用整理')
    else if (reason === 'no_material') toast.toast('最近没有可整理的会话')
    else if (reason === 'running') toast.toast('另一次整理正在进行')
    else if (reason === 'disabled') toast.toast('定期整理已关闭')
    else if (reason) toast.toast(`本次未整理：${reason}`)
    else toast.toast('记忆库很健康，无需调整')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 记忆健康度的一句话结论（数字墙收进详情） */
const memorySummary = computed(() => {
  const s = memoryStats.value
  if (!s) return ''
  const parts = [`${s.active} 条活跃、${s.dormant} 条休眠记忆（含对话分片）`]
  if (s.injected > 0) {
    parts.push(`${s.injected} 条会注入对话（预算 ${s.budgetTokens} tokens）`)
  }
  if (s.noiseRatio > 0.3) {
    parts.push(`${Math.round(s.noiseRatio * 100)}% 处于休眠，建议整理`)
  }
  if (s.atCap) parts.push('分片总量已达软上限，对话分片暂停新建')
  return parts.join('；')
})

/** 长期记忆的解释：衰减公式 / 三态可见性 / 注入预算，只在标题行 InfoHint 里讲一次 */
const memoryHint = [
  '记忆按分片保存，记忆强度 = base_weight × (floor + (1-floor) × e^(-闲置天数/稳定期))。稳定期越长，衰减越慢。',
  '活跃会进入自动注入；休眠不进自动注入，但可被主动检索命中并唤醒；归档只保留溯源，可手动恢复。',
  '自动注入严格只读：不会因为「被读到」而续命。注入预算 2000 tokens、最多 8 条；数字墙统计含对话分片，列表默认只显示精选来源。',
].join('\n\n')

/* ---------- 新建笔记（已有笔记的浏览与编辑在文件库） ---------- */

const editor = ref<{ path: string; content: string } | null>(null)
const saving = ref(false)
const closeConfirm = ref(false)

function openNewNote(): void {
  editor.value = { path: '', content: '' }
  closeConfirm.value = false
}

async function createNote(): Promise<void> {
  const ed = editor.value
  if (!ed) return
  saving.value = true
  try {
    const f = await kbService.fileWrite({ path: ed.path.trim(), content: ed.content })
    ai.invalidateCognitionCache()
    toast.toast(`已创建 ${f.path}`)
    editor.value = null
    await refresh()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}

/** 关闭守卫：有未保存内容时第一次点只提醒，3 秒内再点才放弃 */
function requestCloseEditor(): void {
  const ed = editor.value
  if (!closeConfirm.value && ed && (ed.path.trim() || ed.content.trim())) {
    closeConfirm.value = true
    setTimeout(() => {
      closeConfirm.value = false
    }, 3000)
    return
  }
  editor.value = null
}
</script>

<template>
  <!-- 标准文档滚动页（与 FileLibraryPage 同壳）：横内边距必须走 --page-pad-x，
       PageHeader 的模糊遮罩会向两侧铺同宽的 --ph-bleed，页头缩在它里面遮罩才正好
       铺满整帧 —— 曾经自造壳让页头顶在 x=0，遮罩超出视口 18px，整页能横向拖动。 -->
  <div class="page">
    <PageHeader title="知识库" subtitle="让 AI 记得住你" back>
      <template #action>
        <button class="hdr-btn" aria-label="检索设置" @click="settingsOpen = true">
          <Settings2 :size="18" />
          <i v-if="modeWarn" class="dot" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <div class="cards" :class="{ 'is-editing': !!editor }">
      <!-- 检索：这页 90% 的到访是搜一下 / 看看最近内容，放第一卡（桌面右栏上格） -->
      <section class="card card-search">
        <div class="card-head">
          <Search :size="16" />
          <h2>检索</h2>
          <button class="mode-chip" aria-label="打开检索设置" @click="settingsOpen = true">
            {{ modeLabel }}
            <i v-if="modeWarn" class="dot" />
          </button>
        </div>
        <div class="searchbar">
          <input
            v-model="query"
            type="search"
            placeholder="关键词，留空看最近内容"
            @keyup.enter="runSearch"
          />
          <button class="btn" :disabled="searching" @click="runSearch">
            {{ searching ? '…' : '搜索' }}
          </button>
        </div>
        <ul v-if="hits?.length" class="hits">
          <li v-for="h in hits" :key="`${h.sourceType}-${h.id}`" class="clickable" @click="openReader(h.id)">
            <div class="hit-head">
              <span class="src">{{ KB_SOURCE_LABELS[h.sourceType] ?? h.sourceType }}</span>
              <span v-if="h.path" class="hpath">{{ h.path }}</span>
              <span class="date">{{ h.occurredOn ?? '' }}</span>
            </div>
            <p class="hit-title">{{ h.title }}</p>
            <p class="hit-snippet">{{ h.snippet }}</p>
          </li>
        </ul>
        <EmptyState
          v-else-if="hits"
          :icon="Search"
          title="没有命中"
          hint="换个更短的关键词再试"
        />
      </section>

      <!-- 长期记忆（桌面右栏下格，条目按多栏流铺开） -->
      <section class="card card-memory" data-testid="kb-memory-card">
        <div class="card-head">
          <Brain :size="16" />
          <h2>长期记忆</h2>
          <span class="chip num">{{ visibleMemories.length }}</span>
          <!-- 衰减 / 三态可见性 / 注入预算只讲一次：收进标题行 InfoHint -->
          <InfoHint title="长期记忆怎么运转" :content="memoryHint" />
        </div>

        <!-- 三态 + 来源筛选：过滤在服务端做，切 chip 重新拉取 -->
        <div class="mem-filters" role="group" aria-label="记忆状态">
          <button
            v-for="f in stateFilters"
            :key="f.value"
            class="chip"
            :class="{ on: stateFilter === f.value }"
            @click="setStateFilter(f.value)"
          >
            {{ f.label }}<span v-if="f.value === 'archived' && archivedCount" class="num"> {{ archivedCount }}</span>
          </button>
        </div>
        <div class="mem-filters" role="group" aria-label="记忆来源">
          <span class="filter-label">来源</span>
          <button
            v-for="f in originFilters"
            :key="f.value"
            class="chip"
            :class="{ on: originFilter === f.value }"
            @click="setOriginFilter(f.value)"
          >
            {{ f.label }}
          </button>
        </div>

        <!-- 健康度：一句结论 + 可展开的详情（数字墙默认收起） -->
        <div v-if="memoryStats" class="snr">
          <p class="snr-sum">{{ memorySummary }}</p>
          <button class="snr-toggle" @click="snrDetail = !snrDetail">
            {{ snrDetail ? '收起详情' : '详情' }}
          </button>
          <div v-show="snrDetail" class="snr-detail">
            <div class="snr-grid">
              <div><b class="num">{{ memoryStats.active }}</b><span>活跃</span></div>
              <div><b class="num">{{ memoryStats.dormant }}</b><span>休眠</span></div>
              <div><b class="num">{{ memoryStats.archived }}</b><span>归档</span></div>
              <div><b class="num">{{ memoryStats.injected }}</b><span>注入（预算 {{ memoryStats.budgetTokens }} tokens）</span></div>
            </div>
            <p class="snr-line">
              最近维护：{{ memoryStats.lastSweepAt ?? '从未' }} · 最近 AI 整理：{{ memoryStats.lastDreamAt ?? '从未' }}
            </p>
            <p class="snr-line">数字墙统计含对话分片；列表默认只看精选来源。</p>
          </div>
          <div class="mem-actions">
            <button class="btn ghost" :disabled="maintaining" @click="runMaintain">
              <RefreshCw :size="14" /> {{ maintaining ? '维护中…' : '衰减维护' }}
            </button>
            <button class="btn ghost" :disabled="memory.dreaming" @click="runConsolidate">
              <Sparkles :size="14" /> {{ memory.dreaming ? 'AI 整理中…' : 'AI 整理' }}
            </button>
          </div>
        </div>

        <ul v-if="visibleMemories.length" class="mems">
          <li
            v-for="m in visibleMemories"
            :key="m.id"
            :class="{ 'is-archived': m.state === 'archived' }"
            data-testid="kb-memory-item"
          >
            <div class="mem-head">
              <span class="type">{{ KB_MEMORY_LABELS[m.memType] ?? m.memType }}</span>
              <span v-if="m.topic" class="topic">{{ m.topic }}</span>
              <span v-if="m.category" class="cat">{{ m.category }}</span>
              <span class="badge origin">{{ originLabel(m.origin) }}</span>
              <span class="badge state" :class="m.state">{{ stateLabel(m.state) }}</span>
              <span class="metric num">
                稳定期 {{ formatStability(m.stability) }} · 强度 {{ m.effectiveWeight.toFixed(2) }}
              </span>
            </div>
            <p class="mem-text">{{ m.content }}</p>
            <div class="mem-ops">
              <button
                v-if="m.anchorMessageId && m.chatId"
                class="op wide"
                aria-label="查看记忆原文"
                @click="openAnchor(m)"
              >
                查看原文
              </button>
              <button
                v-if="m.state === 'archived'"
                class="op"
                aria-label="恢复该条记忆"
                @click="restoreMemory(m.id)"
              >
                <RotateCcw :size="16" />
              </button>
              <button v-else class="op" aria-label="归档该条记忆" @click="archiveMemory(m.id)">
                <Archive :size="16" />
              </button>
              <button
                v-if="m.origin !== 'marked_important'"
                class="op"
                aria-label="标记为重要记忆"
                title="标记重要：提高强度地板，自动注入优先"
                @click="markImportantMemory(m.id)"
              >
                <Star :size="16" />
              </button>
              <button
                v-if="confirmDel === m.id"
                class="op del-arm"
                aria-label="确认删除"
                title="再点一次即永久删除：这条记忆不再参与检索与 AI 整理，无法恢复"
                @click="tapDeleteMemory(m.id)"
              >
                确认删除
              </button>
              <button
                v-else
                class="op del"
                aria-label="删除该条记忆（需确认）"
                @click="tapDeleteMemory(m.id)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Brain"
          title="还没有长期记忆"
          hint="默认会在每次会话结束时自动提炼。也可以直接对 AI 说「记住……」"
        />
        <!-- 整理线索：疑似重复（本地向量算出，喂给 AI 整理当重点怀疑对象）+ 最近分片事件 -->
        <div v-if="duplicates.length || events.length" class="audit">
          <div v-if="duplicates.length" class="dup">
            <button class="dup-head" @click="dupOpen = !dupOpen">
              <Sparkles :size="13" />
              <span>疑似重复 {{ duplicates.length }} 对</span>
              <span class="dup-hint">{{ dupOpen ? '收起' : '看看' }}</span>
            </button>
            <ul v-show="dupOpen" class="dup-list">
              <li v-for="d in duplicates" :key="`${d.aId}-${d.bId}`">
                <span class="dup-score">相似度 <span class="num">{{ d.score.toFixed(2) }}</span></span>
                <span class="dup-text">{{ d.aContent }}<br /><i>{{ d.bContent }}</i></span>
              </li>
            </ul>
            <p v-if="dupOpen" class="hint">
              点「AI 整理」会把它们当重点：能合的合并成一条，措辞更全的留下。
            </p>
          </div>
          <div v-if="events.length" class="diffs">
            <span class="diffs-head">最近事件</span>
            <p v-for="(e, i) in events.slice(0, 3)" :key="`${i}-${e.at}-${e.shardId}`" class="diff-line">
              <span class="mono">{{ e.at.slice(0, 16) }}</span> {{ eventLabel(e) }}
            </p>
          </div>
        </div>
        <!-- 衰减与归档的完整解释在标题行 InfoHint 里，卡面只留一行结论 -->
        <p v-if="visibleMemories.length" class="foot">
          <StatusChip tone="neutral" size="sm">休眠不进自动注入，归档可恢复</StatusChip>
        </p>
      </section>

      <!-- 文件：入口 + 新建笔记；浏览与编辑在文件库（桌面左栏，开编辑器时画布切单栏） -->
      <section class="card card-files">
        <div class="card-head">
          <FolderTree :size="16" />
          <h2>文件</h2>
          <button class="mini" @click="router.push('/ai/knowledge/files')">
            <FolderOpen :size="13" /> 文件库
          </button>
          <button class="mini" @click="openNewNote"><FilePlus2 :size="13" /> 新建笔记</button>
        </div>
        <!-- 这句话有按钮标签没有的增量（存储位置在 AI 工作区）：保留，收敛成一行结论 -->
        <p v-if="!editor" class="hint">
          <StatusChip tone="neutral" size="sm">笔记、文档与记录都存在 AI 工作区</StatusChip>
        </p>

        <!-- 新建笔记编辑器 -->
        <div v-if="editor" class="editor">
          <label class="epath">
            <span>路径</span>
            <input v-model="editor.path" type="text" placeholder="笔记/训练笔记.md" />
          </label>
          <textarea
            v-model="editor.content"
            rows="10"
            placeholder="markdown 正文"
          />
          <div class="row">
            <button class="btn" :disabled="saving" @click="createNote">
              {{ saving ? '创建中…' : '创建' }}
            </button>
            <button class="btn ghost" :class="{ danger: closeConfirm }" @click="requestCloseEditor">
              {{ closeConfirm ? '放弃内容?' : '关闭' }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- 检索设置抽屉：索引概况 / 模式 / 范围 —— 低频的机器层全在这里 -->
    <SheetModal :open="settingsOpen" title="检索设置" initial-snap="large" @close="settingsOpen = false">
      <!-- 索引概况 -->
      <section class="set-block">
        <div class="set-head">
          <Database :size="15" />
          <h3>索引概况</h3>
          <span v-if="status" class="chip" :class="{ on: status.indexing }">
            {{ status.indexing ? '索引中' : '空闲' }}
          </span>
        </div>
        <div v-if="status" class="stats">
          <div><b class="num">{{ status.docs }}</b><span>条目</span></div>
          <div><b class="num">{{ status.chunks }}</b><span>分段</span></div>
          <div><b class="num">{{ status.vectors }}</b><span>向量</span></div>
          <div><b class="num">{{ status.pending }}</b><span>待更新</span></div>
        </div>
        <div v-if="status?.indexing" class="bar"><i :style="{ transform: `scaleX(${progressPct / 100})` }" /></div>
        <p v-if="status?.lastError" class="err">
          <AlertCircle :size="14" /> {{ status.lastError }}
        </p>
        <p v-if="status && !status.embedderReady && mode !== 'keyword'" class="hint">
          语义模型还没准备好，检索暂时按关键词匹配，不影响使用。
        </p>
      </section>

      <!-- 检索模式 -->
      <section class="set-block">
        <div class="set-head">
          <Search :size="15" />
          <h3>检索模式</h3>
        </div>
        <SegmentedControl :options="modeOptions" :model-value="mode" @update:model-value="onModeChange" />
        <p class="hint">
          <template v-if="mode === 'keyword'">
            按字面关键词匹配，零配置、所有设备可用，改完立即生效。
          </template>
          <template v-else-if="mode === 'local'">
            在设备上运行本地语义模型（需先下载），意思相近也能搜到，数据不出设备。首次启用会先在后台建一段时间的索引。
          </template>
          <template v-else>
            调用兼容 OpenAI 的云端服务，速度快；索引文本会发送给该服务商。
          </template>
        </p>

        <div v-if="mode === 'cloud'" class="fields">
          <label>
            <span>服务地址</span>
            <input v-model="cloudBaseUrl" type="url" placeholder="https://api.example.com/v1" />
          </label>
          <label>
            <span>密钥</span>
            <input
              v-model="cloudApiKey"
              type="password"
              :placeholder="settings?.cloudApiKeyTail ? `已保存 ${settings.cloudApiKeyTail}（留空不改）` : 'sk-...'"
            />
          </label>
          <label>
            <span>模型名</span>
            <input v-model="cloudModel" type="text" placeholder="bge-m3" />
          </label>
          <div class="row">
            <button class="btn" :disabled="busy" @click="saveSettings()">应用</button>
            <button class="btn ghost" :disabled="probing" @click="probe">
              {{ probing ? '测试中…' : '测试连接' }}
            </button>
          </div>
        </div>

        <div v-if="mode !== 'keyword'" class="row">
          <button class="btn ghost" :disabled="probing" @click="probe">
            {{ probing ? '测试中…' : '测试嵌入' }}
          </button>
          <button class="btn ghost" :disabled="busy" @click="rebuild">
            <RefreshCw :size="14" /> 重建索引
          </button>
        </div>
      </section>

      <!-- 本地模型：多档可选、按需下载（换模型即重建向量） -->
      <section v-if="mode === 'local'" class="set-block">
        <!-- 维度不在这行重复：模型行那处带着「使用中」标记，信息更全 -->
        <div class="set-head">
          <Cpu :size="15" />
          <h3>本地模型</h3>
        </div>
        <p class="hint">
          模型不随安装包分发，按需下载，可随时换、可删除。换模型后旧向量会作废，
          后台会按新模型重算；没下载模型时检索会自动按关键词进行。
        </p>
        <ul class="models">
          <li
            v-for="m in embedCatalog?.models ?? []"
            :key="m.id"
            class="model"
            :class="{ on: m.id === localModel }"
          >
            <button
              class="model-main"
              :disabled="!m.installed || Boolean(modelBusy)"
              @click="pickModel(m.id)"
            >
              <span class="model-label">
                {{ m.label }}
                <i v-if="m.id === localModel" class="in-use">使用中</i>
                <i v-else-if="!m.installed" class="need-dl">未下载</i>
              </span>
              <span class="model-note">{{ m.note }}</span>
              <span class="model-meta">{{ m.dim }} 维 · {{ humanBytes(m.bytes) }}</span>
            </button>
            <div class="model-ops">
              <button
                v-if="!m.installed"
                class="btn ghost tiny"
                :disabled="Boolean(modelBusy)"
                @click="downloadModel(m.id)"
              >
                <Download :size="13" /> 下载
              </button>
              <button
                v-else
                class="btn ghost tiny"
                :disabled="m.id === localModel || Boolean(modelBusy)"
                :title="m.id === localModel ? '正在使用中：先换一个模型再删' : '删除已下载的模型文件'"
                @click="removeModel(m.id)"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </li>
        </ul>
        <div v-if="modelProgress" class="dl">
          <div class="dl-head">
            <span>{{ modelProgress.file || '准备中' }} · {{ modelProgress.pct }}%</span>
            <button class="link" @click="cancelDownload"><X :size="12" /> 取消</button>
          </div>
          <div class="bar"><i :style="{ transform: `scaleX(${modelProgress.pct / 100})` }" /></div>
        </div>
      </section>

      <!-- 自定义嵌入测试：用自己的中文文本看维度 / 延迟 / 相似度排序 -->
      <section class="set-block">
        <div class="set-head">
          <FlaskConical :size="15" />
          <h3>自定义嵌入测试</h3>
        </div>
        <p class="hint">
          一行一条：<b>第一行是查询</b>，其余当候选。可以另选一个模型对比同一批文本，再决定要不要换
          （只测不存，不动当前设置）。
        </p>
        <textarea
          v-model="testTexts"
          rows="4"
          class="test-input"
          placeholder="膝盖疼怎么练腿&#10;膝关节不适时的腿部训练安排&#10;今天晚饭吃什么"
        />
        <div class="row">
          <label class="test-pick">
            <span>被测模型</span>
            <select v-model="testModelA">
              <option value="">当前模型</option>
              <option v-for="m in embedCatalog?.models ?? []" :key="m.id" :value="m.id">
                {{ m.label }}{{ m.installed ? '' : '（未下载）' }}
              </option>
            </select>
          </label>
          <label class="test-pick">
            <span>对比模型（可选）</span>
            <select v-model="testModelB">
              <option value="">不比</option>
              <option v-for="m in embedCatalog?.models ?? []" :key="m.id" :value="m.id">
                {{ m.label }}{{ m.installed ? '' : '（未下载）' }}
              </option>
            </select>
          </label>
        </div>
        <div class="row">
          <button class="btn" :disabled="testRunning" @click="runEmbedTest">
            <FlaskConical :size="14" /> {{ testRunning ? '测试中…' : '运行测试' }}
          </button>
          <span class="hint">当前模式：{{ modeLabel }}</span>
        </div>

        <div v-if="testA || testB" class="test-results">
          <div v-for="(res, idx) in [testA, testB]" :key="idx" class="test-col">
            <template v-if="res">
              <p class="test-head">
                <b>{{ idx === 0 ? '模型 A' : '模型 B' }}</b>
                <span class="mono">{{ res.modelId }}</span>
              </p>
              <p class="test-meta">
                <b class="test-dim num">{{ res.dim }}</b><span class="test-dim-unit"> 维</span>
                <span class="test-cost">
                  模型加载 <span class="num">{{ res.buildMs }} ms</span> · 本次测试 <span class="num">{{ res.totalMs }} ms</span>
                </span>
              </p>
              <ol class="ranks">
                <li v-for="(r, i) in res.ranking" :key="`${i}-${r.text}`">
                  <span class="rank-score">{{ r.score.toFixed(3) }}</span>
                  <span class="rank-bar">
                    <i :style="{ transform: `scaleX(${Math.max(0, Math.min(1, r.score))})` }" />
                  </span>
                  <span class="rank-text">{{ r.text }}</span>
                </li>
              </ol>
              <p class="hint">{{ res.note }}</p>
            </template>
          </div>
        </div>
      </section>

      <!-- 索引范围 -->
      <section class="set-block">
        <div class="set-head">
          <FolderTree :size="15" />
          <h3>索引范围</h3>
        </div>
        <p class="hint">告诉 AI 可以从哪些记录里找知识，点一下即生效。</p>
        <!-- 批量操作：11 枚逐个点太啰嗦；只用整族开关的用户仍可回到下面逐枚微调 -->
        <div class="src-actions">
          <button type="button" class="src-act" @click="setAllSources(true)">全选</button>
          <button type="button" class="src-act" @click="setAllSources(false)">清空</button>
          <span class="hint">关闭的来源不建索引、不参与检索</span>
        </div>
        <div class="toggles">
          <!-- 组头占满一行，把 11 枚开关拆成几簇；开关本身一字未改 -->
          <template v-for="g in sourceGroups" :key="g.label">
            <span class="src-grp">{{ g.label }}</span>
            <button
              v-for="t in g.items"
              :key="t"
              type="button"
              class="toggle"
              :class="{ on: sourceEnabled[t] ?? true }"
              @click="toggleSource(t)"
            >
              {{ KB_SOURCE_LABELS[t] }}
            </button>
          </template>
        </div>
        <div class="switch-row">
          <span>会话结束时自动提炼长期记忆</span>
          <ToggleSwitch v-model="autoMemory" label="会话结束时自动提炼长期记忆" @update:model-value="saveSettings(true)" />
        </div>
        <div class="switch-row">
          <span>定期整理记忆库（合并重复、归档噪声，每天最多一次）</span>
          <ToggleSwitch v-model="autoConsolidate" label="定期整理记忆库" @update:model-value="saveSettings(true)" />
        </div>
      </section>
    </SheetModal>

    <!-- 阅读抽屉 -->
    <SheetModal
      :open="reader !== null"
      :title="reader?.title ?? '阅读'"
      initial-snap="large"
      @close="reader = null"
    >
      <!-- 「段」是索引单位：文档被切成小段来索引，一次加载一段；说明收进抽屉帮助入口 -->
      <template #action>
        <InfoHint
          title="文档为什么分段"
          content="长文档会被切成小段来建立索引，阅读时一段一段加载；「继续加载」会再取一批，「一次读完」则直接把剩下的全部取来。"
        />
      </template>
      <template v-if="reader">
        <p v-if="reader.path" class="hpath big">{{ reader.path }}</p>
        <div class="reader-bar">
          <SegmentedControl
            :options="[{ value: 'l1', label: '概览' }, { value: 'l2', label: '全文' }]"
            :model-value="reader.level"
            @update:model-value="switchLevel"
          />
        </div>
        <div v-if="reader.level === 'l2'" class="doc-body">
          <p v-for="c in reader.chunks" :key="c.id">{{ c.text }}</p>
        </div>
        <p v-else class="doc-body sum">{{ reader.chunks[0]?.text }}</p>
        <div v-if="reader.level === 'l2' && reader.hasMore" class="row more-row">
          <button class="btn ghost" :disabled="reading || reader.busy" @click="loadMore">
            <span v-if="reader.loadingMore">加载中…</span>
            <span v-else>继续加载（<span class="num">{{ reader.chunks.length }}</span>/<span class="num">{{ reader.totalChunks }}</span> 段）</span>
          </button>
          <button class="btn ghost" :disabled="reader.busy" @click="readAll">一次读完</button>
        </div>
        <p v-else-if="reader.level === 'l2' && reader.totalChunks > 1" class="fin">
          已到末尾 · 共 <span class="num">{{ reader.totalChunks }}</span> 段
        </p>
      </template>
    </SheetModal>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 标准文档滚动页内边距：底部 --page-pad-bottom 已含 TabBar 的 --dock-top
     与悬浮条预留 —— 只留固定 24px 时最后一张卡片会压进标签栏 */
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
}
.cards {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

/* 页头设置钮上的警示点（索引中 / 语义后端未就绪） */
.hdr-btn .dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--accent);
}
.mode-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}
.mode-chip .dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--accent);
}
/* 模式胶囊本身是打开检索设置的按钮：24 的视觉高 + 上下各 10 的 ::after = 44 热区 */
.mode-chip::after {
  content: '';
  position: absolute;
  inset: -10px 0;
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  /* 圆角沿用全局 .card（--radius-m 16 / 桌面 14），内距同样走卡片档 16 */
  padding: var(--pad-card);
}
.card-head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-bottom: var(--gap-md);
}
.card-head h2 {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  flex: 1;
}
.chip {
  display: inline-flex;
  align-items: center;
  font-size: var(--fs-caption);
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 记忆三态 / 来源筛选：chip 变成按钮后补回触控高度与无边框 */
.mem-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-6);
  margin-top: var(--sp-8);
}
.mem-filters .chip {
  border: none;
  cursor: pointer;
  min-height: var(--control-sm);
}
.filter-label {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 检索 */
.searchbar {
  display: flex;
  gap: var(--gap-sm);
}
.searchbar input {
  flex: 1;
  min-width: 0;
}
input {
  width: 100%;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  /* 16px 起才不触发 iOS 聚焦自动放大：走 --fs-headline（手机档 16 / 桌面档 16），
     比正文大一档，既守住 iOS 的聚焦阈值，又不出字号阶梯 */
  font-size: var(--fs-headline);
}
.hits {
  margin-top: var(--gap-md);
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}
.hits li {
  border-top: 1px solid var(--line);
  padding-top: var(--sp-10);
}
.hit-head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.src {
  flex: none;
  color: var(--accent);
}
.hpath {
  font-family: ui-monospace, monospace;
  font-size: var(--fs-caption);
  color: var(--text-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hpath.big {
  margin-bottom: var(--sp-8);
  white-space: normal;
  word-break: break-all;
}
.date {
  flex: none;
  margin-left: auto;
}
.hit-title {
  margin-top: var(--sp-4);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}
.hit-snippet {
  margin-top: var(--sp-4);
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-2);
}
.clickable {
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}
/* 悬停只在真悬停设备生效：触屏点一下也会留下 :hover 底色 */
@media (hover: hover) {
  .clickable:hover {
    background: var(--surface-2);
  }
}
/* li 吃不到全局按压；cursor:pointer 已承诺可点，:active 兑成反馈 */
.clickable:active {
  background: var(--surface-2);
}

/* 长期记忆 */
.snr {
  display: grid;
  gap: var(--sp-8);
  margin-top: var(--sp-4);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.snr-sum {
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-1);
}
.snr-toggle {
  position: relative;
  justify-self: start;
  min-height: var(--control-sm);
  font-size: var(--fs-caption);
  color: var(--accent);
}
.snr-toggle::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}
.snr-detail {
  display: grid;
  gap: var(--sp-8);
}
.snr-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-8);
}
.snr-grid > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
}
.snr-grid b {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}
.snr-grid b.bad {
  color: var(--danger);
}
.snr-grid span {
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-align: center;
}
.snr-line {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.5;
}
.mem-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-8);
}
.link {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: var(--control-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-decoration: underline;
  text-underline-offset: 3px;
}
/* 文字链接视觉保持 12px 一行，热区上下补到 44 */
.link::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}
.mems {
  display: flex;
  flex-direction: column;
  gap: var(--sp-10);
}
.mems li {
  position: relative;
  border-top: 1px solid var(--line);
  padding-top: var(--sp-10);
}
.mems li.is-archived .mem-text {
  color: var(--text-3);
}
.mem-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  /* 给右侧操作钮让位，避免长 topic 塞到按钮底下（96 = 64 + 32，两档拼出来不写裸值） */
  padding-right: calc(var(--sp-64) + var(--sp-32));
}
.type {
  color: var(--accent);
}
.topic,
.cat {
  color: var(--text-3);
}
.badge {
  padding: 1px var(--sp-8);
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
}
.badge.arch {
  background: var(--surface-2);
  color: var(--text-2);
}
.badge.stale {
  background: var(--danger-soft);
  color: var(--danger-strong);
}
/* 分片来源 / 三态徽标 */
.badge.origin {
  background: var(--surface-2);
  color: var(--text-2);
}
.badge.state.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.badge.state.dormant {
  background: var(--danger-soft);
  color: var(--danger-strong);
}
.badge.state.archived {
  background: var(--surface-2);
  color: var(--text-3);
}
.metric {
  color: var(--text-3);
}
.mem-text {
  margin-top: var(--sp-4);
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-1);
}
.mem-ops {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-8);
  margin-top: var(--sp-4);
}
.op {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: var(--sp-6);
  border: none;
  border-radius: var(--radius-s);
  background: none;
  color: var(--text-3);
}
/* 命中区撑到 44×44（同 PageHeader 圆钮的 ::after 扩展法） */
.op::after {
  content: '';
  position: absolute;
  inset: -6px;
}
.op:active {
  opacity: 0.6;
}
/* 「查看原文」是文字按钮，仍沿用 .op 的 32px 热区 */
.op.wide {
  width: auto;
  padding: var(--sp-6) var(--sp-10);
  color: var(--accent);
  font-size: var(--fs-caption);
}
.op.del-arm {
  padding: var(--sp-6) var(--sp-12);
  background: var(--danger);
  color: var(--on-accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}
.foot {
  margin-top: var(--sp-10);
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--text-2);
}

/* 文件 / 编辑器 */
.mini {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}
/* 两枚小按钮横向只隔 8：热区只上下补 8，不做左右扩张 */
.mini::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}
.hint {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--text-2);
}
.editor {
  margin-top: var(--sp-12);
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
  border-top: 1px solid var(--line);
  padding-top: var(--sp-12);
}
.epath {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.epath span {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
textarea {
  width: 100%;
  padding: var(--sp-10);
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  line-height: 1.6;
  font-family: ui-monospace, monospace;
  resize: vertical;
}

/* 抽屉里的设置块 */
.set-block {
  display: grid;
  gap: var(--sp-10);
  padding-bottom: var(--sp-18);
  margin-bottom: var(--sp-6);
  border-bottom: 1px solid var(--line);
}
.set-block:last-child {
  border-bottom: none;
  margin-bottom: 0;
}
.set-head {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  color: var(--text-1);
}
.set-head h3 {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  flex: 1;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-8);
}
.stats div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
}
.stats b {
  font-size: var(--fs-headline);
  color: var(--text-1);
}
.stats span {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.bar {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transform-origin: 0 50%;
  /* 索引进度连续推进：150ms 会跳，250ms 是肉眼连续的最小平滑值，与 OpQueueBar 同档 */
  transition: transform var(--dur-base) var(--ease-standard);
}
.err {
  font-size: var(--fs-caption);
  color: var(--danger);
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}
.fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
}
.fields label {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.fields span {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.row {
  display: flex;
  gap: var(--sp-8);
  flex-wrap: wrap;
}
.btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  /* flex 内不被输入框（width:100%）挤成竖排字；窄屏也不折行 */
  flex: none;
  white-space: nowrap;
  /* 按钮常规档 40、圆角走大圆角 20（HarmonyOS 按钮规格） */
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-14);
  border-radius: var(--radius-l);
  border: none;
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}
/* 40 的按钮热区补到 44：只外扩 2，与相邻按钮的 8px 间距互不侵占 */
.btn::after {
  content: '';
  position: absolute;
  inset: -2px;
}
.btn.ghost {
  background: var(--surface-2);
  color: var(--text-1);
}
.btn.ghost.danger {
  color: var(--danger);
}
.btn:disabled {
  opacity: var(--disabled-opacity);
}
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}
.toggle {
  position: relative;
  min-height: var(--control-sm);
  padding: var(--sp-6) var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
}
/* 11 枚来源标签视觉保持小按钮档 28；热区上下补 8 到 44。
   横向不扩（同一行相邻标签只隔 8），避免把邻枚的点击吃进来。 */
.toggle::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}
.toggle.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
}

/* 全选 / 清空一行：沿用抽屉里按钮的语言但不抢主色（批量操作，不是主行动） */
.src-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-8);
}
.src-actions .hint {
  /* 挤不下时整行换行，别让说明文字把两个按钮压扁 */
  margin-top: 0;
  margin-left: auto;
  text-align: right;
}
.src-act {
  position: relative;
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}
.src-act::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

/* 分组小头：占满一行断开 flex 换行，把 11 枚开关分成几簇；视觉重量比 .toggle 低一档 */
.src-grp {
  flex-basis: 100%;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-3);
}
.src-grp:first-child {
  margin-top: 0;
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-12);
  font-size: var(--fs-footnote);
  color: var(--text-1);
}

/* 本地模型列表（设置抽屉） */
.models {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  list-style: none;
}
.model {
  display: flex;
  align-items: stretch;
  gap: var(--sp-8);
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-m);
  border: 1px solid var(--line);
  background: var(--surface-2);
}
.model.on {
  border-color: transparent;
  box-shadow: inset 0 0 0 1px var(--accent);
  background: var(--accent-soft);
}
.model-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  text-align: left;
  color: var(--text-1);
  min-width: 0;
}
.model-main:disabled {
  opacity: var(--disabled-opacity);
}
.model-label {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}
.model-label i {
  font-style: normal;
  font-size: var(--fs-caption);
  padding: 1px var(--sp-6);
  border-radius: var(--radius-full);
}
.model-label .in-use {
  background: var(--accent);
  color: var(--on-accent);
}
.model-label .need-dl {
  background: var(--surface-3);
  color: var(--text-2);
  border: 1px solid var(--line-strong);
}
.model-note {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.5;
}
.model-meta {
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.model-ops {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  flex: none;
}
.btn.tiny {
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--sp-8);
  font-size: var(--fs-caption);
}
/* 小按钮视觉 28，热区四边各补 8 到 44（模型行里每行只有一枚，横向不会撞邻居） */
.btn.tiny::after {
  inset: -8px;
}
.dl {
  display: grid;
  gap: var(--sp-4);
}
.dl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--accent);
}

/* 嵌入测试 */
.test-input {
  width: 100%;
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  line-height: 1.6;
  resize: vertical;
}
.test-pick {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  flex: 1;
  min-width: 140px;
}
.test-pick span {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.test-pick select {
  padding: var(--sp-8) var(--sp-8);
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}
.test-results {
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
}
.test-col {
  display: grid;
  gap: var(--sp-4);
}
.test-head {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  font-size: var(--fs-footnote);
}
.test-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-10);
  font-size: var(--fs-caption);
  color: var(--text-3);
}
/* 维度是这组数里的主角：19px 等宽主数值；两项耗时降成说明档 */
.test-dim {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}
.test-dim-unit {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.ranks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  list-style: none;
}
.ranks li {
  display: grid;
  grid-template-columns: 42px 1fr;
  grid-template-areas: 'score bar' 'text text';
  gap: var(--sp-2) var(--sp-8);
  align-items: center;
}
.rank-score {
  grid-area: score;
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.rank-bar {
  grid-area: bar;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}
.rank-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transform-origin: 0 50%;
}
.rank-text {
  grid-area: text;
  font-size: var(--fs-caption);
  color: var(--text-1);
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 记忆卡：整理线索 */
.audit {
  display: grid;
  gap: var(--sp-8);
  margin-top: var(--sp-10);
  padding-top: var(--sp-10);
  border-top: 1px dashed var(--line);
}
.dup-head {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  width: 100%;
  font-size: var(--fs-caption);
  color: var(--text-1);
}
.dup-hint {
  margin-left: auto;
  color: var(--accent);
}
.dup-list {
  display: grid;
  gap: var(--sp-6);
  margin-top: var(--sp-6);
  list-style: none;
}
.dup-list li {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: var(--sp-8);
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.dup-score {
  color: var(--accent-strong);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dup-text i {
  color: var(--text-3);
  font-style: normal;
}
.diffs {
  display: grid;
  gap: var(--sp-4);
}
.diffs-head {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.diff-line {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 阅读抽屉 */
.reader-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  margin-bottom: var(--sp-10);
}
/* 分段控件吃满抽屉宽度（根节点 .seg 默认收缩到内容宽） */
.reader-bar :deep(.seg) {
  flex: 1;
  width: 100%;
}
.doc-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
  font-size: var(--fs-footnote);
  line-height: 1.7;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}
.doc-body.sum {
  color: var(--text-2);
}
.more-row {
  margin-top: var(--sp-12);
}
.more-row .btn {
  flex: 1;
}
.fin {
  margin-top: var(--sp-10);
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   这页是 wide 路由，没有壳层的两栏栅格，构图全在这里定：
   左栏是「目录」—— 进工作区的门（文件入口）；右栏是「正文」——
   检索命中的文档与 AI 记住的长期记忆。
   ============================================================ */

/* 宽形态页面的内容上限，超过就不再拉长行 */
.desk-main .page {
  max-width: var(--desk-wide);
}

/* 左目录 + 右正文：左栏是「进得去工作区的门」（文件卡，本身就短，
   适合待在侧栏里）；右栏才是正文 —— 检索命中的文档与长期记忆。
   为什么长列表不进侧栏：命中列表和记忆列表都可能很长，它们需要宽度才能摊成
   多栏；压进 320px 的侧栏只会变成一条又长又窄的列表，同时把另一半屏空出来。
   所以侧栏只放短的入口卡，凡是会长的一律进主区。 */
.desk-main .cards {
  display: grid;
  grid-template-columns: minmax(260px, var(--desk-aside)) minmax(0, 1fr);
  gap: var(--desk-gap);
  /* stretch：文件卡（跨两行）填满右列两卡的总高，别让灰底从左栏下面漏出来 */
  align-items: stretch;
}

.desk-main .cards > .card-files {
  grid-column: 1;
  grid-row: 1 / span 2;
}

.desk-main .cards > .card-search {
  grid-column: 2;
  grid-row: 1;
}

.desk-main .cards > .card-memory {
  grid-column: 2;
  grid-row: 2;
}

/* 新建笔记的编辑区（路径 + 正文）在 320px 的侧栏里写不了字：
   编辑器一打开，整个画布切成单栏，编辑器排到最上面（点「新建笔记」的地方
   就在左栏顶部，编辑器出现在它下方才是可预期的），检索与记忆顺次下移。
   关掉编辑器立刻回到左目录 + 右正文。 */
.desk-main .cards.is-editing {
  grid-template-columns: minmax(0, 1fr);
}

.desk-main .cards.is-editing > .card-files {
  grid-column: 1;
  grid-row: 1;
}

.desk-main .cards.is-editing > .card-search {
  grid-column: 1;
  grid-row: 2;
}

.desk-main .cards.is-editing > .card-memory {
  grid-column: 1;
  grid-row: 3;
}

/* 检索命中摊成两栏：一条命中是「来源 + 路径 + 日期 + 标题 + 摘要」，
   单栏排下来一屏看不了几条。
   注意要显式 display:block —— 这两个列表原本是 flex 列（靠 gap 排版），
   而多栏容器必须是块容器，不改 display 的话 columns 会被整条忽略。
   间距改由条目的 margin-top 承担（多栏容器里 gap 不生效）。 */
.desk-main .hits {
  display: block;
  columns: 2;
  column-gap: var(--desk-gap);
}

.desk-main .hits > li {
  break-inside: avoid;
  margin-top: var(--sp-10); /* 顶替原来的 flex gap */
}

/* 记忆条目同理：一列排到 700px 宽、一条只有两三行字，两栏才看得完 */
.desk-main .mems {
  display: block;
  columns: 2;
  column-gap: var(--desk-gap);
}

.desk-main .mems > li {
  break-inside: avoid;
  margin-top: var(--sp-10); /* 顶替原来的 flex gap */
}
</style>
