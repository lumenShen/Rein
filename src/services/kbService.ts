/** 知识库域 IPC 封装 · 对应 modules/kb/commands.rs */

import type {
  KbArchiveListing,
  KbArchiveReport,
  KbCognition,
  KbDirListing,
  KbDocDetail,
  KbEmbedCatalog,
  KbEmbedModelInfo,
  KbEmbedTestInput,
  KbEmbedTestResult,
  KbFile,
  KbFileInput,
  KbFsMove,
  KbFsMoveResult,
  KbGlobHit,
  KbHit,
  KbInjection,
  KbIndexEvent,
  KbMedia,
  KbMediaInput,
  KbMemory,
  KbMetaInput,
  KbMemoryDiffEntry,
  KbMemoryDuplicate,
  KbMemoryOverview,
  KbMemoryScope,
  KbMemoryStats,
  KbMemoryType,
  KbModelEvent,
  KbQuery,
  KbRootStat,
  KbSettings,
  KbSettingsInput,
  KbStatus,
  KbTrashBatchResult,
  KbTrashEntry,
  KbTrashResult,
  KbUsageCleanResult,
  KbUsageReport,
  DreamAction,
  DreamApplyResult,
  DreamBeginResult,
  MemoryApplyResult,
  MemoryCandidate,
  MemoryDuplicate,
  MemoryInjectResult,
  MemoryMaintainResult,
  MemorySearchResult,
  MemoryShard,
  MemoryShardDetail,
  MemoryShardEvent,
  MemoryShardOrigin,
  MemoryShardOverview,
  MemoryShardState,
  MemoryShardStats,
  ShardApplyResult,
  ShardPatch,
  ShardSweepResult,
  ShardWriteAction,
} from '@/types'
import { invoke, isTauri } from './transport'

export const kbService = {
  /** 索引概况：文档/分块/向量数、待处理脏标记、进度、最近错误 */
  status: () => invoke<KbStatus>('kb_status', {}),

  /**
   * 混合检索。结构化过滤（来源类别/日期区间/标签）+ FTS5 + 向量召回，RRF 融合后返回 L0 摘要。
   * query 为空时退化为「按日期倒序浏览」。
   */
  search: (query: KbQuery) => invoke<KbHit[]>('kb_search', { query }),

  /**
   * 分层读取：l1 = 摘要 + 首块（概览）；l2 = 分块正文，支持 offset/limit 分页
   * （docs/kb-vfs.md §3）。响应带 totalChunks / offset / hasMore。
   */
  read: (docId: number, level: 'l1' | 'l2' = 'l1', offset?: number, limit?: number) =>
    invoke<KbDocDetail>('kb_read', { docId, level, offset, limit }),

  /** 全量对账：把现有源记录重新入队并清理孤儿文档。返回入队条数 */
  reindex: (sources?: string[]) => invoke<number>('kb_reindex', { sources }),

  settingsGet: () => invoke<KbSettings>('kb_settings_get', {}),

  settingsSet: (input: KbSettingsInput) => invoke<KbSettings>('kb_settings_set', { input }),

  /** 嵌入后端自检：返回向量维度 */
  probeEmbedder: () => invoke<number>('kb_probe_embedder', {}),

  /** 清空全部向量并按当前模型重算 */
  rebuildVectors: () => invoke<number>('kb_rebuild_vectors', {}),

  /** 记忆列表。scope: active（默认）/ archived / all */
  memories: (memType?: KbMemoryType, scope?: KbMemoryScope) =>
    invoke<KbMemory[]>('kb_memories', { memType, scope }),

  /**
   * 「关于你」首屏聚合：活跃记忆 + 概况 + 注入块。
   *
   * 从同一次全表读算出三份视图 —— 页面不要再并发发 memories / memoryStats /
   * cognition 三条命令各读一遍（那等于三次全表扫描 + 三次 salience 计算）。
   */
  memoryOverview: () => invoke<KbMemoryOverview>('kb_memory_overview', {}),

  /* ---------- 记忆分片（kb/shard，方案 §7.4） ---------- */

  /** 记忆分片列表；scope 默认 active，origin 传 curated = 手动/梦境/重要三类 */
  memoryShards: (
    scope?: MemoryShardState | 'all',
    origin?: MemoryShardOrigin | 'all' | 'curated',
    limit = 200,
    offset = 0,
  ) => invoke<MemoryShard[]>('memory_shard_list', { scope, origin, limit, offset }),

  memoryShard: (id: number) => invoke<MemoryShardDetail>('memory_shard_get', { id }),

  memoryShardApply: (actions: ShardWriteAction[], chatId?: string, messageIds?: string[]) =>
    invoke<ShardApplyResult>('memory_shard_apply', { actions, chatId, messageIds }),

  memoryShardUpdate: (id: number, patch: ShardPatch) =>
    invoke<MemoryShard>('memory_shard_update', { id, patch }),

  memoryShardDelete: (id: number) => invoke<boolean>('memory_shard_delete', { id }),

  memoryShardArchive: (id: number, reason?: string) =>
    invoke<boolean>('memory_shard_archive', { id, reason }),

  memoryShardRestore: (id: number) => invoke<boolean>('memory_shard_restore', { id }),

  memoryShardMarkImportant: (id: number, note?: string) =>
    invoke<MemoryShard>('memory_shard_mark_important', { id, note }),

  /** 主动检索：命中且 relevance 达标才写 search_hit；这是唯一会「续命」的读路径 */
  memorySearch: (
    query: string,
    topK = 8,
    includeDormant = true,
    includeArchived = false,
    reviveArchived = false,
  ) =>
    invoke<MemorySearchResult>('memory_shard_search', {
      query,
      topK,
      includeDormant,
      includeArchived,
      reviveArchived,
    }),

  /** 自动注入：严格只读，不写 history/stability/state；默认不含对话分片 */
  memoryInject: (query?: string, budgetTokens = 2000, maxShards = 8, includeConversation = false) =>
    invoke<MemoryInjectResult>('memory_shard_inject', {
      query,
      budgetTokens,
      maxShards,
      includeConversation,
    }),

  memoryShardOverview: () => invoke<MemoryShardOverview>('memory_shard_overview', {}),

  memoryShardStats: () => invoke<MemoryShardStats>('memory_shard_stats', {}),

  memoryShardSweep: () => invoke<ShardSweepResult>('memory_shard_sweep', {}),

  memoryShardDuplicates: (threshold?: number, limit = 30) =>
    invoke<MemoryDuplicate[]>('memory_shard_duplicates', { threshold, limit }),

  memoryShardEvents: (limit = 20) => invoke<MemoryShardEvent[]>('memory_shard_events', { limit }),

  memoryDreamBegin: (force = false) => invoke<DreamBeginResult>('memory_dream_begin', { force }),

  memoryDreamApply: (runId: string, actions: DreamAction[]) =>
    invoke<DreamApplyResult>('memory_dream_apply', { runId, actions }),

  memoryDreamCancel: (runId: string, error?: string) =>
    invoke<void>('memory_dream_cancel', { runId, error }),

  /** 落库一次记忆抽取/整理结果（抽取与整理本身在前端调模型完成） */
  memoryApply: (candidates: MemoryCandidate[], chatId?: string, messageIds?: string[]) =>
    invoke<MemoryApplyResult>('kb_memory_apply', { candidates, chatId, messageIds }),

  memoryDelete: (id: number) => invoke<boolean>('kb_memory_delete', { id }),

  /** 归档一条记忆（软删除，可恢复） */
  memoryArchive: (id: number, reason?: string) =>
    invoke<boolean>('kb_memory_archive', { id, reason }),

  /** 恢复一条已归档记忆 */
  memoryRestore: (id: number) => invoke<boolean>('kb_memory_restore', { id }),

  /** 立即跑一次本地维护（衰减 + 自动归档） */
  memoryMaintain: () => invoke<MemoryMaintainResult>('kb_memory_maintain', {}),

  /** 记忆库信噪比概况（注入覆盖率 / 噪声占比 / 归档数 / 上次整理时间） */
  memoryStats: () => invoke<KbMemoryStats>('kb_memory_stats', {}),

  /**
   * 上报「刚完成一次 LLM 整理」，用于周期任务的节流。
   * @deprecated 分片层已降为 no-op；保留一版，下一版删除。
   */
  memoryConsolidated: () => invoke<void>('kb_memory_consolidated', {}),

  /** 按路径模式列文档：* 不跨目录、** 跨目录、? 单字符 */
  glob: (pattern: string, limit = 100) => invoke<KbGlobHit[]>('kb_glob', { pattern, limit }),

  /** 新建或覆盖笔记（内容真源在 kb_files，自动进检索编目） */
  fileWrite: (input: KbFileInput) => invoke<KbFile>('kb_file_write', { input }),

  fileRename: (id: number, path: string) => invoke<KbFile>('kb_file_rename', { id, path }),

  fileDelete: (id: number) => invoke<void>('kb_file_delete', { id }),

  /** 取文件原文（编辑用；kb_read 走分块管线会丢原始换行） */
  fileGet: (id: number) => invoke<KbFile>('kb_file_get', { id }),

  /** 改用户元数据：评分 / 标签 / 注释（只传要改的字段）。元数据不进索引 */
  metaSet: (input: KbMetaInput) => invoke<KbFile>('kb_meta_set', { input }),

  /** 导入磁盘上的本地文件（从系统文件管理器拖进来的路径；桌面端专用） */
  importPath: (path: string, dir?: string, name?: string) =>
    invoke<KbFile>('kb_import_path', { path, dir, name }),

  /** 导出到本地（下载/Rein 下），返回绝对路径（桌面端专用） */
  exportFile: (id: number) => invoke<string>('kb_export_file', { id }),

  /**
   * 上传 / 产出一个多模态节点（ai-workspace §2）：本体落盘 + 文本模态入索引。
   * `dataBase64` 可带 data URL 前缀；文本模态缺省时后端生成描述行（保证可检索）。
   */
  mediaWrite: (input: KbMediaInput) => invoke<KbFile>('kb_media_write', { input }),

  /**
   * 读一次模态。给了 modal 就取本体（不可用则降级为文本并给原因），不给只回模态清单。
   * 本体超过内联上限时返回 tooLarge，只给元信息。
   */
  mediaGet: (docId: number, modal?: string) => invoke<KbMedia>('kb_media_get', { docId, modal }),

  /* ---------- 目录治理（ai-workspace §3.3） ---------- */

  /** 把文件移进目标目录（分类）。source='ai' 时有防抖与 pin 保护 */
  fsMove: (id: number, toDir: string, reason?: string, source: 'ai' | 'user' = 'user') =>
    invoke<KbFsMoveResult>('kb_fs_move', { id, toDir, reason, source }),

  /** 建目录（空目录也会在文件树里可见） */
  fsMkdir: (path: string, reason?: string, source: 'ai' | 'user' = 'user') =>
    invoke<KbFile>('kb_fs_mkdir', { path, reason, source }),

  /** 钉住 / 取消钉住（钉住后 AI 不再自动移动） */
  fsPin: (id: number, pinned: boolean, source: 'ai' | 'user' = 'user') =>
    invoke<KbFile>('kb_fs_pin', { id, pinned, source }),

  /** 整理审计流水（最近的在前） */
  fsMoves: (limit = 50) => invoke<KbFsMove[]>('kb_fs_moves', { limit }),

  /** 整批撤销一批整理，返回撤销条数 */
  fsUndo: (batchId: string) => invoke<number>('kb_fs_undo', { batchId }),

  /* ---------- 文件管理器：目录列举 + 回收站 ---------- */

  /**
   * 列一层目录（文件管理器的 `ls`）。一次带回大小 / 时间 / 模态 / 钉住 / 归类 / 子项数，
   * 所以排序、分组、状态列都不用再逐个查询；`path` 为空 = 根目录。
   */
  listDir: (path: string) => invoke<KbDirListing>('kb_list_dir', { path }),

  /**
   * 根层统计：每个顶层目录的直接子项数 + 节点更新时间。
   * 关于你首屏用它代替 `listDir('')` —— 只回几十行数字，不扫 assets、不建条目。
   */
  rootStats: () => invoke<KbRootStat[]>('kb_root_stats', {}),

  /** 删除 = 移进回收站（目录连整棵子树一起走）。可撤销：trashRestore */
  trash: (id: number) => invoke<KbTrashResult>('kb_trash', { id }),

  /** 回收站清单（最近删除的在前） */
  trashList: (limit = 200) => invoke<KbTrashEntry[]>('kb_trash_list', { limit }),

  /** 从回收站恢复（批量，逐条报告失败） */
  trashRestore: (ids: number[]) => invoke<KbTrashBatchResult>('kb_trash_restore', { ids }),

  /** 彻底删除（批量，本体文件一并从磁盘清掉） */
  trashPurge: (ids: number[]) => invoke<KbTrashBatchResult>('kb_trash_purge', { ids }),

  /** 清空回收站 */
  trashEmpty: () => invoke<KbTrashBatchResult>('kb_trash_empty', {}),

  /* ---------- 全量注入区（ai-workspace §3.4） ---------- */

  /** 取「系统提示词 + 用户记忆」注入块（前端带 TTL 缓存，不必每轮都取） */
  injection: () => invoke<KbInjection>('kb_injection_get', {}),

  /* ---------- 压缩包（打开 / 解压） ---------- */

  /** 打开压缩包：列出包内条目（不解压）。docId 用 glob 查 */
  archiveList: (docId: number) => invoke<KbArchiveListing>('kb_archive_list', { docId }),

  /** 解压进工作区：文本进检索、二进制落本体；同名自动让位 */
  archiveExtract: (docId: number, toDir?: string, only?: string[]) =>
    invoke<KbArchiveReport>('kb_archive_extract', { docId, toDir, only }),

  /* ---------- 空间管理 ---------- */

  /** 占用总览（文本 / 本体 / 索引 / 数据库 + 大文件榜 + 孤儿统计）；minBytes 给榜单下限 */
  usage: (top = 20, minBytes = 0) => invoke<KbUsageReport>('kb_usage', { top, minBytes }),

  /** 清理磁盘上无人引用的本体碎片（dryRun 只统计） */
  usageClean: (dryRun = false) => invoke<KbUsageCleanResult>('kb_usage_clean', { dryRun }),

  /* ---------- 本地嵌入模型（多档可选 / 按需下载） ---------- */

  /** 可选模型目录 + 安装状态 + 当前选择 */
  embedModels: () => invoke<KbEmbedCatalog>('kb_embed_models', {}),

  /** 下载一个本地模型（进度走 kb://model 事件）；已安装则直接返回 */
  embedModelDownload: (modelId: string) =>
    invoke<KbEmbedModelInfo>('kb_embed_model_download', { modelId }),

  /** 取消进行中的下载 */
  embedModelCancel: (modelId: string) => invoke<void>('kb_embed_model_cancel', { modelId }),

  /** 删除已下载的模型（当前正在用的会被拒绝），返回释放字节数 */
  embedModelRemove: (modelId: string) => invoke<number>('kb_embed_model_remove', { modelId }),

  /** 自定义嵌入测试：自己的文本 → 维度 / 延迟 / 相似度排序（可临时换模型对比） */
  embedTest: (input: KbEmbedTestInput) => invoke<KbEmbedTestResult>('kb_embed_test', { input }),

  /* ---------- 记忆整理：查重提示与审计 ---------- */

  /** 疑似重复的记忆对（本地向量算余弦，零模型成本；keyword 模式返回空） */
  memoryDuplicates: (threshold?: number, limit = 30) =>
    invoke<KbMemoryDuplicate[]>('kb_memory_duplicates', { threshold, limit }),

  /** 最近的记忆变更记录（抽取 / 整理 / 维护都写在同一张审计表） */
  memoryDiffs: (limit = 5) => invoke<KbMemoryDiffEntry[]>('kb_memory_diffs', { limit }),

  /** 取喂给系统提示词的紧凑认知块 */
  cognition: () => invoke<KbCognition>('kb_cognition', {}),

  /**
   * 上报「这些记忆被注入过」，用于后续排序。
   * @deprecated 自动注入已改为严格只读；保留一版，下一版删除。
   */
  memoryBump: (ids: number[]) => invoke<void>('kb_memory_bump', { ids }),
}

/* ---------- 占用总览的会话级备忘 ---------- */

// report 是全表聚合 + 目录遍历 + 逐本体 stat，属于重读；而入口在页面挂载时就会取一次
// （来回切页 = 反复扫库）。这里给个短 TTL 备忘：同一会话里切页不再重复扫，
// 动了文件（解压 / 清理 / 移动 / 删除）时由调用方显式 invalidate。
//
// **按 top 分别记**：三个入口要的榜单长度不同（文件页胶囊与总览页 12 条、大文件页 100 条），
// 单条备忘会让「总览 ↔ 大文件」来回切时每次都落空、每次重扫一遍库。留最近三份即可 ——
// 再多也没有第四个入口，只会白占内存。
const USAGE_TTL_MS = 5 * 60 * 1000
const USAGE_MEMO_MAX = 3
const usageMemo = new Map<string, { at: number; data: KbUsageReport }>()

/** 让下次 usageCached 重新扫库（任何会改动工作区内容的操作之后调它） */
export function invalidateUsage(): void {
  usageMemo.clear()
}

/** 取占用总览（带会话级备忘）；`force` 跳过备忘强制刷新 */
export async function usageCached(top = 12, force = false): Promise<KbUsageReport> {
  const key = `top:${top}`
  const hit = usageMemo.get(key)
  if (!force && hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.data
  const data = await kbService.usage(top)
  usageMemo.delete(key)
  usageMemo.set(key, { at: Date.now(), data })
  while (usageMemo.size > USAGE_MEMO_MAX) {
    // Map 迭代顺序 = 插入顺序：删最旧的那份
    const oldest = usageMemo.keys().next()
    if (oldest.done) break
    usageMemo.delete(oldest.value)
  }
  return data
}

/* ---------- 事件桥（惰性 / 单飞 / 失败可重试） ---------- */

/**
 * 惰性建一次 Tauri 事件订阅，并派发给一组监听者。
 *
 * 三个要点（都是踩过的坑）：
 * 1. **单飞**：并发调用只建一次订阅 —— 旧写法「先置位再 await」，并发时两个调用
 *    都会通过检查，事件被派发两次；
 * 2. **失败不缓存**：`listen()` 抛错时清掉缓存的 promise，下次订阅还能重试。
 *    旧写法一旦失败就把标志留在 true，本会话里进度事件永久失效；
 * 3. 浏览器 mock 模式没有 Tauri（也没有索引线程/下载），直接当就绪，不建订阅。
 */
function makeEventBridge<T>(event: string, listeners: Set<(e: T) => void>): () => Promise<void> {
  let ready: Promise<void> | null = null
  return () => {
    if (!ready) {
      ready = (async () => {
        if (!isTauri) return
        const { listen } = await import('@tauri-apps/api/event')
        await listen<T>(event, (e) => {
          for (const l of listeners) l(e.payload)
        })
      })().catch((e) => {
        ready = null
        throw e
      })
    }
    return ready
  }
}

/* ---------- 索引进度事件（kb://index，对应 Rust worker.rs::INDEX_EVENT） ---------- */

const indexListeners = new Set<(e: KbIndexEvent) => void>()
const bridgeIndexEvents = makeEventBridge<KbIndexEvent>('kb://index', indexListeners)

/**
 * 订阅索引进度推送（页面必须在卸载时取消订阅，否则重挂载会重复派发）。
 * 事件与 `kb_status` 的 progress/pending/indexing 同源，直接就地覆盖即可。
 */
export async function onKbIndexProgress(cb: (e: KbIndexEvent) => void): Promise<() => void> {
  await bridgeIndexEvents()
  indexListeners.add(cb)
  return () => indexListeners.delete(cb)
}

/* ---------- 模型下载进度事件（kb://model，对应 Rust commands.rs 的 MODEL_EVENT） ---------- */

const modelListeners = new Set<(e: KbModelEvent) => void>()
const bridgeModelEvents = makeEventBridge<KbModelEvent>('kb://model', modelListeners)

export async function onKbModelProgress(cb: (e: KbModelEvent) => void): Promise<() => void> {
  await bridgeModelEvents()
  modelListeners.add(cb)
  return () => modelListeners.delete(cb)
}
