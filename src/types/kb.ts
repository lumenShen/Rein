/**
 * 知识库与认知层类型 · 与 Rust `modules/kb/models.rs` 对应。
 *
 * 概念上分三层，检索时按需下钻（对应 OpenViking 的 L0/L1/L2）：
 * - L0 摘要：`KbHit.snippet`，列表里判断相关性用
 * - L1 概览：`kbRead(id, 'l1')` 的摘要 + 首块
 * - L2 详情：`kbRead(id, 'l2')` 的全部分块正文
 */

/** 三档检索模式 */
export type KbEmbeddingMode = 'keyword' | 'local' | 'cloud'

/** 可索引的来源类型 */
export type KbSourceType =
  | 'todo'
  | 'todo_attachment'
  | 'workout'
  | 'plan'
  | 'meal'
  | 'body_metric'
  | 'food'
  | 'program'
  | 'program_meal'
  | 'voice_memo'
  | 'chat'
  | 'chat_message'
  | 'chat_attachment'
  | 'memory'
  | 'note'

/** 来源类型的中文短名（设置页与 UI 标签用） */
export const KB_SOURCE_LABELS: Record<KbSourceType, string> = {
  todo: '日程与附件',
  todo_attachment: '待办附件',
  workout: '运动记录',
  plan: '训练课程',
  meal: '饮食记录',
  body_metric: '体测数据',
  food: '自建食物',
  program: '健康方案',
  program_meal: '方案菜单',
  voice_memo: '语音纪要',
  chat: '对话',
  chat_message: '历史聊天',
  chat_attachment: '对话附件',
  memory: '长期记忆',
  note: '笔记',
}

export interface KbSettings {
  embeddingMode: KbEmbeddingMode
  /** 本地嵌入模型 id（见 KbEmbedModelInfo；mode='local' 时生效） */
  localModel: string
  cloudBaseUrl: string | null
  /** 只回尾四位，密钥不回传明文 */
  cloudApiKeyTail: string | null
  cloudModel: string | null
  cloudDim: number | null
  /** 逐类开关，缺省视为开启 */
  sourcesEnabled: Partial<Record<KbSourceType, boolean>>
  autoMemory: boolean
  /** 是否允许周期性的 LLM 记忆整理（合并重叠、统一分类、归档噪声），每天最多一次 */
  autoConsolidate: boolean
  /** 最近一次 LLM 整理的时间（节流依据） */
  lastConsolidateAt: string | null
  lastError: string | null
  updatedAt: string
}

export interface KbSettingsInput {
  embeddingMode?: KbEmbeddingMode
  localModel?: string
  cloudBaseUrl?: string
  cloudApiKey?: string
  cloudModel?: string
  cloudDim?: number
  sourcesEnabled?: Partial<Record<KbSourceType, boolean>>
  autoMemory?: boolean
  autoConsolidate?: boolean
}

export interface KbProgress {
  phase: 'idle' | 'scanning' | 'chunking' | 'embedding' | 'done' | 'error' | string
  done: number
  total: number
}

export interface KbStatus {
  mode: KbEmbeddingMode
  docs: number
  chunks: number
  vectors: number
  pending: number
  indexing: boolean
  progress: KbProgress
  lastError: string | null
  embedderReady: boolean
  vecModel: string | null
  enabledSources: KbSourceType[]
}

/** `kb://index` 事件的载荷（Rust `kb/worker.rs::emit`）：供页面实时更新索引状态条 */
export interface KbIndexEvent {
  phase: KbProgress['phase']
  done: number
  total: number
  pending: number
  indexing: boolean
}

/** 编目/渲染用的内容类型（docs/ai-workspace.md §2） */
export type KbKind = 'text' | 'image' | 'file' | 'audio' | 'video' | 'folder'

export interface KbHit {
  id: number
  sourceType: KbSourceType
  sourceId: string
  /** 虚拟路径，如「日程/2026-09-10/腿部力量训练-42.md」 */
  path: string | null
  /** true = 可编辑（笔记 / 记忆）；false = 只读派生文档 */
  editable: boolean
  /** 系统文件（规范）不可改不可删 */
  system: boolean
  /** 内容类型：text / image / file / audio / video / folder */
  kind: KbKind
  title: string
  /** 命中片段（围绕关键词截取，非全文） */
  snippet: string
  occurredOn: string | null
  tags: string[]
  score: number
  /** 召回路径，便于排查「为什么没搜到」 */
  matched: 'fts' | 'like' | 'fuzzy' | 'vector' | 'hybrid' | 'browse'
}

export interface KbChunk {
  id: number
  ord: number
  text: string
}

export interface KbDocDetail {
  id: number
  sourceType: KbSourceType
  sourceId: string
  path: string | null
  editable: boolean
  system: boolean
  kind: KbKind
  title: string
  summary: string
  occurredOn: string | null
  tags: string[]
  meta: Record<string, unknown>
  updatedAt: string
  level: 'l1' | 'l2'
  /** 总分块数。l1 只返回首块，据此判断「还有更多」 */
  totalChunks: number
  /** 本次返回的起始块序（分页读取） */
  offset: number
  hasMore: boolean
  chunks: KbChunk[]
  /** 该节点可用模态（如 ['text','audio']）；取本体走 kbService.mediaGet */
  modalities: string[]
}

/* ---------- 模态层（kb_assets，ai-workspace §2） ---------- */

export type KbModal = 'text' | 'image' | 'audio' | 'video' | 'binary'

export interface KbModalInfo {
  modal: KbModal
  mime: string
  bytes: number
  durationMs: number | null
  /** none | pending | done | failed */
  transcriptState: string
  derivedFrom: string | null
  /** asset（上传节点）| voice（语音纪要）| attachment（附件本体）| text（正文） */
  source: string
}

/** 一次模态读取的结果。降级永远发生：请求的模态不可用时回退文本并给原因。 */
export interface KbMedia {
  docId: number
  path: string | null
  title: string
  kind: KbKind
  modalities: KbModalInfo[]
  requested: string | null
  degraded: boolean
  degradeReason: string | null
  mime: string | null
  /** 本体 data URL（≤ 上限时给；超限只给元信息） */
  dataUrl: string | null
  tooLarge: boolean
  text: string | null
  hint: string | null
}

export interface KbMediaInput {
  path: string
  name?: string
  mime: string
  /** base64，可带 data URL 前缀 */
  dataBase64: string
  /** 文本模态（转录 / 描述）；缺省时后端自动生成描述行 */
  text?: string
}

/* ---------- 文件节点（kb_files） ---------- */

export interface KbFile {
  id: number
  path: string
  content: string
  system: boolean
  /** text | multimodal | folder */
  kind: string
  /** 用户钉住后 AI 不再自动移动 */
  pinned: boolean
  /** inbox | filed | manual */
  classifyState: string
  createdAt: string
  updatedAt: string
  modalities: KbModalInfo[]
  /** 用户评分 0..5（0 = 未评） */
  rating: number
  /** 用户标签 */
  tags: string[]
  /** 用户注释（自由文本） */
  note: string
}

/** 改用户元数据：只传要改的字段，缺省不动 */
export interface KbMetaInput {
  /** 文档 id 或文件 id（与其余文件命令一致） */
  id: number
  rating?: number
  tags?: string[]
  note?: string
}

export interface KbFileInput {
  path: string
  content: string
}

/** glob 命中：* 不跨目录、** 跨目录、? 单字符 */
export interface KbGlobHit {
  id: number
  path: string
  sourceType: KbSourceType
  title: string
  kind: KbKind
  editable: boolean
  system: boolean
  occurredOn: string | null
}

/* ---------- 目录列举（kb/listing.rs）：文件管理器的一层视图 ---------- */

/**
 * 目录里的一个条目：一层的完整元数据。
 * 列表 / 网格 / 详情都只吃这一份，不必为每个条目再查一次库。
 */
export interface KbEntry {
  /** kb_docs.id（阅读器要的 id）；目录条目为 0 */
  id: number
  /** kb_files.id（真实文件才有）；派生投影没有文件实体 */
  fileId: number | null
  path: string
  /** 路径末段（真实文件名） */
  name: string
  /** folder | text | image | audio | video | file */
  kind: string
  /** 目录条目为空串；文件条目是来源类别（note / todo / workout…） */
  sourceType: string
  title: string
  system: boolean
  editable: boolean
  /** 字节数：文本按 UTF-8，多模态按本体，目录为自身占用 */
  size: number
  /** 目录的直接子项数（文件恒为 0） */
  childCount: number
  occurredOn: string | null
  updatedAt: string
  pinned: boolean
  /** inbox | filed | manual | ''（派生投影没有归类状态） */
  classifyState: string
  /** 可用模态：text / image / audio / video / binary */
  modalities: string[]
  /** 用户评分 0..5（0 = 未评） */
  rating: number
  /** 用户标签（不进索引：标签是给人看的分类） */
  tags: string[]
  /** 有注释（注释正文走 kb_file_get，不进列表响应） */
  hasNote: boolean
}

export interface KbDirListing {
  path: string
  entries: KbEntry[]
  total: number
  /** 大目录被上限截断 */
  truncated: boolean
}

/**
 * 根层统计（`kb_root_stats`）：顶层目录的直接子项数与节点更新时间。
 *
 * 这是 `kb_list_dir("")` 的「只要数字」版本 —— 关于你首屏只需要 13 个 root 的计数，
 * 不值得把整棵树实例化。`childCount` 与 `KbEntry.childCount` 同口径（根层列举）。
 */
export interface KbRootStat {
  name: string
  childCount: number
  /** 目录节点自身的 updatedAt；隐式目录为空串 */
  updatedAt: string
}

/* ---------- 回收站（kb/files.rs） ---------- */

export interface KbTrashEntry {
  fileId: number
  /** 派生文档删除时已清掉，通常是 0 */
  id: number
  name: string
  /** 回收站内的存放路径 */
  path: string
  /** 删除前的位置（恢复的目标） */
  originalPath: string
  kind: string
  sourceType: string
  size: number
  system: boolean
  trashedAt: string
  updatedAt: string
}

export interface KbTrashResult {
  fileId: number
  /** 影响行数（目录会连带整棵子树） */
  count: number
  path: string
}

export interface KbTrashBatchResult {
  done: number
  freedBytes: number
  /** 逐条失败原因（批量操作不整体失败） */
  failed: string[]
}

/* ---------- 目录治理（ai-workspace §3.3） ---------- */

export interface KbFsMove {
  id: number
  batchId: string
  source: string
  op: string
  pathFrom: string
  pathTo: string
  reason: string
  at: string
  undone: boolean
}

/** 一次归类移动的结果：新节点 + 从哪到哪 + 批次（可整批撤销） */
export interface KbFsMoveResult {
  file: KbFile
  from: string
  to: string
  batchId: string
}

/* ---------- 全量注入区（ai-workspace §3.4） ---------- */

export interface KbInjectionFile {
  path: string
  zone: string
  chars: number
  truncated: boolean
}

export interface KbInjection {
  /** 系统提示词目录拼接结果 */
  system: string
  /** 用户记忆目录拼接结果 */
  memory: string
  files: KbInjectionFile[]
  totalChars: number
  budget: number
  truncated: boolean
}

/** 检索入参。query 为空表示「浏览最近内容」。 */
export interface KbQuery {
  query: string
  sources?: KbSourceType[]
  from?: string
  to?: string
  tags?: string[]
  limit?: number
}

/* ---------- 记忆层 ---------- */

export type KbMemoryType = 'preference' | 'constraint' | 'event' | 'entity' | 'profile' | 'pattern'

export const KB_MEMORY_LABELS: Record<KbMemoryType, string> = {
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  entity: '实体',
  profile: '画像',
  pattern: '规律',
}

export interface KbMemory {
  id: number
  memType: KbMemoryType
  topic: string
  /** 分层分类路径（如「健康/训练」），由模型在抽取/整理时给出，可为空 */
  category: string
  content: string
  confidence: number
  activeCount: number
  sourceChatId: string | null
  createdAt: string
  updatedAt: string
  /** 最近一次被注入（用到）的时间；衰减从这一刻重新计时 */
  lastUsedAt: string | null
  /** 归档时间（软删除）。归档记忆不进注入与检索，可在本页恢复 */
  archivedAt: string | null
  /** 归档原因：decay（自动衰减）/ manual（手动）/ 整理任务给出的原因 */
  archivedReason: string | null
  /** 显著性（读时计算）：置信度 × 时间衰减 × 使用强化 */
  salience: number
}

/** 记忆列表视角：active 仅活跃 / archived 仅归档 / all 全部 */
export type KbMemoryScope = 'active' | 'archived' | 'all'

/** 落库一次记忆抽取/整理的变更。op=update/delete/archive 时必须带 id。 */
export interface MemoryCandidate {
  op: 'add' | 'update' | 'delete' | 'archive'
  id?: number
  memType?: KbMemoryType
  topic?: string
  category?: string
  content?: string
  confidence?: number
  /** archive 的原因（如 outdated / duplicate / noise） */
  reason?: string
}

export interface MemoryApplyResult {
  added: number
  updated: number
  deleted: number
  /** 被归档（软删除）的条数 */
  archived: number
  /** 从归档中被复活（重复提及 / 更新确认）的条数 */
  restored: number
  skipped: number
}

/** 一次本地维护（衰减 + 自动归档）的结果 */
export interface MemoryMaintainResult {
  /** 本次检查的活跃记忆条数 */
  checked: number
  /** 本次归档的条数（软删除，可恢复） */
  archived: number
}

/** 记忆库信噪比概况（UI 面板用） */
export interface KbMemoryStats {
  active: number
  archived: number
  total: number
  /** 注入条数上限 */
  limit: number
  /** 注入字符上限 */
  maxChars: number
  /** 当前实际会被注入的条数 */
  injected: number
  /** 实际注入文本的字符数 */
  injectedChars: number
  /** 显著性低于阈值的活跃记忆条数 */
  stale: number
  avgConfidence: number
  avgSalience: number
  /** 注入覆盖率 = injected / active */
  signalRatio: number
  /** 噪声占比 = stale / active */
  noiseRatio: number
  autoConsolidate: boolean
  lastConsolidateAt: string | null
  lastMaintainAt: string | null
}

/** 喂给系统提示词的紧凑认知块 */
export interface KbCognition {
  memories: KbMemory[]
  text: string
}

/**
 * 「关于你」首屏聚合（kb_memory_overview）：活跃记忆 + 概况 + 注入块。
 *
 * 三份视图来自 Rust 侧同一次全表读 —— 页面不要再并发发三条命令各读一遍。
 */
export interface KbMemoryOverview {
  memories: KbMemory[]
  stats: KbMemoryStats
  cognition: KbCognition
}

/* ---------- 记忆分片层（kb/shard，方案 §7.3） ---------- */

export type MemoryShardOrigin =
  | 'conversation'
  | 'dream_summary'
  | 'manual_write'
  | 'marked_important'

export type MemoryShardState = 'active' | 'dormant' | 'archived'

export type MemoryShardEventType =
  | 'birth'
  | 'search_hit'
  | 'manual_mark'
  | 'manual_edit'
  | 'manual_archive'
  | 'manual_restore'
  | 'dream_consolidate'
  | 'dream_revive'
  | 'dream_supersede'

export interface MemoryProvenance {
  reasoningDigest?: string
  toolCalls?: { name: string; ok: boolean; brief: string }[]
  userText?: string
  anchorSeq?: number
  messageIds?: string[]
  legacy?: number
  legacyActiveCount?: number
}

export interface MemoryShard {
  id: number
  origin: MemoryShardOrigin
  memType: KbMemoryType
  topic: string
  category: string
  content: string
  confidence: number
  baseWeight: number
  floor: number
  stability: number
  lastEventAt: string
  state: MemoryShardState
  anchorMessageId: string | null
  chatId: string | null
  userMessageId: string | null
  provenance: MemoryProvenance
  supersedes: number | null
  consolidatedInto: number | null
  dreamAction: 'supersede_new' | 'consolidate_merged' | 'digest' | null
  sourceChatId: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  archivedReason: string | null
  /** 读时计算：base_weight × (floor + (1-floor) × e^(-闲置天数/稳定期)) */
  effectiveWeight: number
}

export interface MemoryShardHistory {
  seq: number
  at: string
  event: MemoryShardEventType
  stability: number
  baseWeight: number
  floor: number
  factor: number
  rank: number | null
  hits30d: number | null
  runId: string
  note: string
}

export interface MemoryShardDetail {
  shard: MemoryShard
  history: MemoryShardHistory[]
  sourceMessageIds: string[]
}

/** 抽取/Dream 之外的显式写入动作；update 只改传入字段 */
export interface ShardWriteAction {
  op: 'add' | 'update' | 'delete' | 'archive'
  id?: number
  content?: string
  memType?: KbMemoryType
  topic?: string
  category?: string
  confidence?: number
  reason?: string
}

export interface ShardPatch {
  content?: string
  memType?: KbMemoryType
  topic?: string
  category?: string
}

export interface ShardApplyResult {
  added: number
  updated: number
  deleted: number
  archived: number
  restored: number
  skipped: number
}

export interface ShardSweepResult {
  checked: number
  activated: number
  dormant: number
  archived: number
}

export interface MemorySearchHit {
  shardId: number
  content: string
  memType: KbMemoryType
  topic: string
  category: string
  origin: MemoryShardOrigin
  state: MemoryShardState
  anchorMessageId: string | null
  chatId: string | null
  relevance: number
  effectiveWeight: number
  createdAt: string
}

export interface MemorySearchResult {
  hits: MemorySearchHit[]
  mode: 'vector' | 'keyword' | 'weight'
  reinforced: number
  revived: number
  tookMs: number
}

export interface MemoryInjectShard {
  shardId: number
  content: string
  memType: KbMemoryType
  topic: string
  category: string
  origin: MemoryShardOrigin
  anchorMessageId: string | null
  chatId: string | null
  effectiveWeight: number
  reason: 'anchor' | 'digest' | 'relevant' | 'weight'
}

export interface MemoryInjectResult {
  text: string
  shards: MemoryInjectShard[]
  estimatedTokens: number
  budgetTokens: number
  mode: 'vector' | 'keyword' | 'weight'
}

export interface MemoryShardStats {
  active: number
  dormant: number
  archived: number
  total: number
  limit: number
  maxChars: number
  injected: number
  injectedChars: number
  estimatedTokens: number
  budgetTokens: number
  avgConfidence: number
  avgEffectiveWeight: number
  signalRatio: number
  noiseRatio: number
  embeddingPending: number
  embeddingFailed: number
  lastSweepAt: string | null
  lastDreamAt: string | null
  atCap: boolean
  sweepTruncated: boolean
}

export interface MemoryShardOverview {
  shards: MemoryShard[]
  stats: MemoryShardStats
  cognition: MemoryInjectResult
}

export interface MemoryDuplicate {
  aId: number
  bId: number
  score: number
  aContent: string
  bContent: string
}

export interface MemoryShardEvent {
  at: string
  shardId: number
  event: MemoryShardEventType
  content: string
  runId: string
  note: string
}

export type DreamGateReason =
  | 'ok'
  | 'cooldown'
  | 'insufficient_material'
  | 'running'
  | 'no_material'
  | 'disabled'

export interface DreamGate {
  eligible: boolean
  reason: DreamGateReason
  lastRunAt: string | null
  sessionsSince: number
  messagesSince: number
  cooldownHours: number
  minSessions: number
  minMessages: number
}

export interface DreamMessage {
  id: string
  seq: number
  role: 'user' | 'assistant'
  /** 直接存后端 kind 字符串，避免 kb.ts ↔ ai.ts 的类型循环依赖 */
  kind: string
  text: string | null
  anchorId: string | null
  createdAt: string
}

export interface DreamSession {
  chatId: string
  title: string
  updatedAt: string
  messages: DreamMessage[]
}

export interface DreamShardBrief {
  id: number
  content: string
  memType: KbMemoryType
  topic: string
  category: string
  origin: MemoryShardOrigin
  state: MemoryShardState
  stability: number
  effectiveWeight: number
  anchorMessageId: string | null
  chatId: string | null
  updatedAt: string
}

export interface DreamContext {
  since: string | null
  sessions: DreamSession[]
  shards: DreamShardBrief[]
  duplicatePairs: MemoryDuplicate[]
  totalSessions: number
  totalMessages: number
}

export type DreamAction =
  | {
      type: 'supersede'
      oldShardId: number
      content: string
      memType?: KbMemoryType
      topic?: string
      category?: string
      reason?: string
    }
  | {
      type: 'consolidate'
      shardIds: number[]
      content: string
      memType?: KbMemoryType
      topic?: string
      category?: string
      reason?: string
    }
  | { type: 'digest'; content: string; topic?: string; category?: string }
  | { type: 'revive'; shardId: number; reason?: string }

export interface DreamBeginResult {
  gate: DreamGate
  runId: string | null
  context: DreamContext | null
}

export interface DreamApplyResult {
  created: number
  superseded: number
  consolidated: number
  revived: number
  skipped: number
  alreadyApplied: boolean
}

/* ---------- 压缩包（kb/archive.rs） ---------- */

export interface KbArchiveEntry {
  path: string
  size: number
  packed: number
  isDir: boolean
  /** 解压时会作为可检索文本入库 */
  text: boolean
  /** 非空表示该条目会被跳过（附原因） */
  skipped: string | null
}

export interface KbArchiveListing {
  format: string
  entries: KbArchiveEntry[]
  /** 包内条目总数（可能大于 entries.length） */
  total: number
  totalBytes: number
  packedBytes: number
  truncated: boolean
  notes: string[]
}

export interface KbArchiveItem {
  id: number
  path: string
  bytes: number
  /** 解压产物的落地形态（text = 进了检索的笔记；binary = 本体落盘的多模态节点） */
  kind: 'text' | 'binary'
}

export interface KbArchiveReport {
  format: string
  target: string
  extracted: KbArchiveItem[]
  skipped: string[]
  bytes: number
  truncated: boolean
  message: string
}

/* ---------- 空间管理（kb/usage.rs） ---------- */

export interface KbUsageSlice {
  name: string
  bytes: number
  count: number
}

export interface KbUsageFile {
  id: number
  path: string
  kind: string
  bytes: number
  textBytes: number
  assetBytes: number
  updatedAt: string
}

export interface KbUsageReport {
  totalBytes: number
  textBytes: number
  assetBytes: number
  indexBytes: number
  dbBytes: number
  fileCount: number
  docCount: number
  assetCount: number
  /** 按工作区一级目录 */
  areas: KbUsageSlice[]
  /** 按来源类型（索引口径） */
  sources: KbUsageSlice[]
  /** 按模态（本体口径） */
  modals: KbUsageSlice[]
  largest: KbUsageFile[]
  orphanCount: number
  orphanBytes: number
  missingCount: number
  summary: string
}

export interface KbUsageCleanResult {
  removed: number
  bytes: number
  dryRun: boolean
  message: string
}

/* ---------- 本地嵌入模型（kb/embed_models.rs） ---------- */

/** 档位（与 Rust 注册表 embed_models::MODELS 的 tier 字段一一对应） */
export type KbModelTier = 'light' | 'standard' | 'high' | 'multi'

export interface KbEmbedModelInfo {
  id: string
  label: string
  /** 档位；UI 按它排版与配色 */
  tier: KbModelTier
  dim: number
  /** 注册表声明的下载体积 */
  bytes: number
  note: string
  /** 是否已下载到本机（未下载时不可选用） */
  installed: boolean
  diskBytes: number
  downloading: boolean
}

export interface KbEmbedCatalog {
  models: KbEmbedModelInfo[]
  current: string
  mode: KbEmbeddingMode
  /** 模型目录路径（排查用） */
  dir: string
}

/** `kb://model` 事件载荷（下载进度） */
export interface KbModelEvent {
  id: string
  /** model.onnx | tokenizer.json | ''（阶段事件） */
  file: string
  done: number
  total: number
  /** 下载阶段 */
  phase: 'start' | 'downloading' | 'done' | 'error'
  message?: string
}

/* ---------- 自定义嵌入测试（kb/embed.rs::test） ---------- */

export interface KbEmbedTestVector {
  text: string
  dim: number
  /** 前 8 维预览 */
  preview: number[]
  norm: number
  ms: number
}

export interface KbEmbedTestRank {
  text: string
  score: number
}

export interface KbEmbedTestResult {
  modelId: string
  dim: number
  vectors: KbEmbedTestVector[]
  ranking: KbEmbedTestRank[]
  buildMs: number
  totalMs: number
  note: string
}

export interface KbEmbedTestInput {
  /** 第一段当查询，其余为候选 */
  texts: string[]
  /** 临时换本地模型对比（不落库） */
  localModel?: string
  /** 临时用云端端点测（不落库；apiKey 留空则用已保存的） */
  cloud?: { baseUrl: string; apiKey?: string; model: string; dim?: number }
}

/* ---------- 记忆整理：查重提示与审计（kb/memory.rs） ---------- */

export interface KbMemoryDuplicate {
  aId: number
  bId: number
  score: number
  aContent: string
  bContent: string
}

export interface KbMemoryDiffEntry {
  at: string
  /** 变更计数（candidates/added/updated/deleted/archived/restored/skipped 或 maintain 记录） */
  payload: Record<string, unknown>
}
