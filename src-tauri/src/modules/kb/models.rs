//! 知识库域数据模型 · 与前端 `src/types/kb.ts` 对应。

use serde::{Deserialize, Serialize};

/// 可索引的来源类型。与 db.rs 迁移 0019 的触发器写入值必须一致。
/// `memory` 不是源表派生的，而由记忆层直接登记（见 memory.rs）。
pub const SOURCE_TYPES: &[&str] = &[
    "todo",
    "todo_attachment",
    "workout",
    "plan",
    "meal",
    "body_metric",
    "food",
    "program",
    "program_meal",
    "voice_memo",
    "chat",
    "chat_message",
    "chat_attachment",
    "memory",
    "note",
];

/// 附件等非正文内容的类型（kb_docs.kind）。决定前端如何渲染，也决定「本体在源数据里」。
pub const KIND_TEXT: &str = "text";
pub const KIND_IMAGE: &str = "image";
pub const KIND_FILE: &str = "file";
pub const KIND_AUDIO: &str = "audio";
/// 视频编目（本体走模态层，见 docs/ai-workspace.md §2）。
pub const KIND_VIDEO: &str = "video";
/// 目录占位节点（kb_files.kind='folder'），让空目录在文件树里可见。
pub const KIND_FOLDER: &str = "folder";

/// 文件节点类型（kb_files.kind）。
pub const FILE_KIND_TEXT: &str = "text";
pub const FILE_KIND_MULTIMODAL: &str = "multimodal";
pub const FILE_KIND_FOLDER: &str = "folder";

/// 模态枚举（kb_assets.modal）。
pub const MODAL_TEXT: &str = "text";
pub const MODAL_IMAGE: &str = "image";
pub const MODAL_AUDIO: &str = "audio";
pub const MODAL_VIDEO: &str = "video";
pub const MODAL_BINARY: &str = "binary";

/// 转写状态机（kb_assets.transcript_state）：none → pending → done | failed。
pub const TRANSCRIPT_NONE: &str = "none";
pub const TRANSCRIPT_PENDING: &str = "pending";
pub const TRANSCRIPT_DONE: &str = "done";
pub const TRANSCRIPT_FAILED: &str = "failed";

/// 归类状态（kb_files.classify_state）。
pub const CLASSIFY_INBOX: &str = "inbox";
pub const CLASSIFY_FILED: &str = "filed";
pub const CLASSIFY_MANUAL: &str = "manual";

/// 可写命名空间：用户笔记（规范见 docs/kb-vfs.md）。
pub const NOTE_ROOT: &str = "笔记";
/// 可写命名空间：上传文档的全文归档（发送时由前端自动写入）。
pub const DOC_ROOT: &str = "文档";
/// 系统文件命名空间：只读，不可新建/改名/删除。
pub const SPEC_ROOT: &str = "规范";
/// 系统提示词目录：只读，代码播种；每轮对话全量注入（含代码静态段）。
pub const SYSTEM_PROMPT_ROOT: &str = "系统提示词";
/// 用户记忆目录：可写、路径固定；每轮对话全量注入（docs/ai-workspace.md §3.4）。
pub const USER_MEMORY_ROOT: &str = "用户记忆";
/// 收件箱：新内容未归类前先落这里，再由 AI 分类（§3.3）。
pub const INBOX_ROOT: &str = "未分类数据";
/// 语音/视频领域的用户子区（本体与转写产物的默认落点）。
pub const VOICE_ROOT: &str = "语音";
pub const VIDEO_ROOT: &str = "视频";
/// 规范文件路径：播种进知识库，供 AI 随时查阅自身约定。
pub const SPEC_PATH: &str = "规范/知识库规范.md";
/// 系统命名空间（只读）：写入口与治理层都按这份清单拒绝。
/// `回收站` 也在内 —— 否则用户/AI 能建出同名根目录，而浏览侧按前缀把它整棵滤掉
/// （文件在库里却永远看不见、也删不掉）。回收站自身的 trash/restore/purge 走裸 SQL，不受影响。
pub const SYSTEM_ROOTS: &[&str] = &[SPEC_ROOT, SYSTEM_PROMPT_ROOT, TRASH_ROOT];

/// 知识区：用户/AI 可直接写的根目录（docs/ai-workspace.md §3.2）。
pub const WRITABLE_ROOTS: &[&str] = &[
    NOTE_ROOT,
    DOC_ROOT,
    USER_MEMORY_ROOT,
    INBOX_ROOT,
    VOICE_ROOT,
    VIDEO_ROOT,
];

/// 投影区：应用数据的只读投影所在的领域根目录。
/// 这些目录**本身**不是只读的——目录里的派生路径是保留区（日期目录 / `-id` 后缀），
/// 其余子路径是用户子区，可写（§3.2）。
pub const DOMAIN_ROOTS: &[&str] = &[
    "日程", "运动", "饮食", "体测", "课程", "食物", "方案", "菜单", "对话", "附件", "记忆", "纪要",
];

/// 三档检索模式。
/// - `keyword`：纯 FTS5(trigram) + 结构化过滤，零依赖、全平台、默认。
/// - `local`：进程内 ONNX Runtime + 按需下载的本地模型，数据不出设备。
/// - `cloud`：OpenAI 兼容 `/v1/embeddings`，走 Rust 侧 ureq（不受 WebView CSP 约束）。
pub const MODE_KEYWORD: &str = "keyword";
pub const MODE_LOCAL: &str = "local";
pub const MODE_CLOUD: &str = "cloud";

/// 读侧设置。`cloud_api_key` 不回传明文，只回尾四位供辨认。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbSettings {
    pub embedding_mode: String,
    /// 本地嵌入模型 id（注册表 embed_models::MODELS；mode=local 时生效）
    pub local_model: String,
    pub cloud_base_url: Option<String>,
    pub cloud_api_key_tail: Option<String>,
    pub cloud_model: Option<String>,
    pub cloud_dim: Option<i64>,
    /// 逐类开关，缺省视为开启。形如 `{"chat_message": false}`
    pub sources_enabled: serde_json::Value,
    pub auto_memory: bool,
    /// 是否允许周期性的 LLM 记忆整理（合并重叠、统一分类、归档噪声），每天最多一次
    pub auto_consolidate: bool,
    /// 最近一次 LLM 整理的时间（节流依据）
    pub last_consolidate_at: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

/// 写侧设置：只传要改的字段，缺省不动。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KbSettingsInput {
    pub embedding_mode: Option<String>,
    pub local_model: Option<String>,
    pub cloud_base_url: Option<String>,
    pub cloud_api_key: Option<String>,
    pub cloud_model: Option<String>,
    pub cloud_dim: Option<i64>,
    pub sources_enabled: Option<serde_json::Value>,
    pub auto_memory: Option<bool>,
    pub auto_consolidate: Option<bool>,
}

/// 索引进度快照（后台线程写入，status/命令读取）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbProgress {
    /// idle | scanning | chunking | embedding | done | error
    pub phase: String,
    pub done: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbStatus {
    pub mode: String,
    pub docs: i64,
    pub chunks: i64,
    pub vectors: i64,
    /// 待处理脏标记数
    pub pending: i64,
    pub indexing: bool,
    pub progress: KbProgress,
    pub last_error: Option<String>,
    /// 本地模型是否可用（keyword 模式恒为 true；cloud 模式看配置是否齐全）
    pub embedder_ready: bool,
    /// 当前向量由哪个模型算出
    pub vec_model: Option<String>,
    pub enabled_sources: Vec<String>,
}

/// 检索命中。只回 L0 摘要级信息——正文要走 `kb_read` 显式取，避免工具结果撑爆上下文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbHit {
    pub id: i64,
    pub source_type: String,
    pub source_id: String,
    /// 虚拟路径，如 `日程/2026-09-10/腿部力量训练-42.md`
    pub path: Option<String>,
    /// 1 = 可编辑（笔记 / 记忆），0 = 只读派生文档
    pub editable: bool,
    /// 系统文件（规范）不可改不可删
    pub system: bool,
    /// 内容类型：text / image / file / audio（附件编目用）
    pub kind: String,
    pub title: String,
    /// 命中片段（围绕关键词截取，非全文）
    pub snippet: String,
    pub occurred_on: Option<String>,
    pub tags: Vec<String>,
    pub score: f64,
    /// fts | like | vector | hybrid —— 便于排查「为什么没搜到」
    pub matched: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbChunk {
    pub id: i64,
    pub ord: i64,
    pub text: String,
}

/// 分层读取结果。level: `l1` = 概览（摘要 + 块首），`l2` = 分块正文全文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbDocDetail {
    pub id: i64,
    pub source_type: String,
    pub source_id: String,
    pub path: Option<String>,
    pub editable: bool,
    pub system: bool,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub occurred_on: Option<String>,
    pub tags: Vec<String>,
    pub meta: serde_json::Value,
    pub updated_at: String,
    pub level: String,
    /// 该文档的总分块数。l1 只返回首块，据此让调用方知道「还有更多」。
    pub total_chunks: i64,
    /// 本次返回的起始块序（分页读取）
    pub offset: i64,
    pub has_more: bool,
    pub chunks: Vec<KbChunk>,
    /// 该节点可用的模态清单（如 ["text","audio"]）；拿本体走 kb_media_get（§2.2）
    pub modalities: Vec<String>,
}

/// 检索入参（由 AI 工具或前端构造）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbQuery {
    pub query: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/* ---------- 记忆层 ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbMemory {
    pub id: i64,
    pub mem_type: String,
    pub topic: String,
    /// 分层分类路径（如 `健康/训练`），由模型在抽取/整理时给出，可为空
    pub category: String,
    pub content: String,
    pub confidence: f64,
    pub active_count: i64,
    pub source_chat_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 最近一次被注入（用到）的时间；衰减从这一刻重新计时
    pub last_used_at: Option<String>,
    /// 归档时间（软删除）。归档记忆不进注入与检索，可在 UI 恢复
    pub archived_at: Option<String>,
    /// 归档原因：decay（自动衰减）/ manual（手动）/ 整理任务给出的原因
    pub archived_reason: Option<String>,
    /// 显著性（读时计算，不落库）：置信度 × 时间衰减 × 使用强化，见 memory.rs::salience_of
    pub salience: f64,
}

/// 记忆类型。对齐 OpenViking 的类型学，但收敛到健康场景真正用得上的六类。
pub const MEMORY_TYPES: &[&str] = &[
    "preference", // 偏好：喜欢/讨厌、风格倾向
    "constraint", // 约束：伤病、禁忌、时间限制
    "event",      // 事件：做过/发生过的事及其原因
    "entity",     // 实体：人、地点、器械、课程
    "profile",    // 稳定画像：作息、经验水平
    "pattern",    // 模式：反复出现的行为规律
];

/// 记忆抽取/整理产出的单条变更，由前端（pi-ai）调用模型生成后交回 Rust 落库。
/// `op`: add | update | delete | archive；update/delete/archive 必须带 id。
/// archive 的 `reason` 说明为什么归档（如 outdated / duplicate / noise）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidate {
    pub op: String,
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub mem_type: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryApplyResult {
    pub added: i64,
    pub updated: i64,
    pub deleted: i64,
    /// 被归档（软删除）的条数
    pub archived: i64,
    /// 从归档中被复活（重复提及 / 更新确认）的条数
    pub restored: i64,
    /// 因与已有记忆完全重复而跳过的条数（幂等性体现）
    pub skipped: i64,
}

/// 一次本地维护（自动归档）的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMaintainResult {
    /// 本次检查的活跃记忆条数
    pub checked: i64,
    /// 本次归档的条数（软删除，可恢复）
    pub archived: i64,
}

/// 记忆库的信噪比指标与概况（UI 面板与整理决策共用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbMemoryStats {
    pub active: i64,
    pub archived: i64,
    pub total: i64,
    /// 注入条数上限（COGNITION_LIMIT）
    pub limit: i64,
    /// 注入字符上限（COGNITION_MAX_CHARS）
    pub max_chars: i64,
    /// 当前按显著性排序后、实际会被注入的条数
    pub injected: i64,
    /// 实际注入文本的字符数
    pub injected_chars: i64,
    /// 显著性低于阈值的活跃记忆条数
    pub stale: i64,
    pub avg_confidence: f64,
    pub avg_salience: f64,
    /// 注入覆盖率 = injected / active（信号有多少真的进了提示词）
    pub signal_ratio: f64,
    /// 噪声占比 = stale / active（该整理的比例）
    pub noise_ratio: f64,
    pub auto_consolidate: bool,
    /// 最近一次 LLM 整理的时间
    pub last_consolidate_at: Option<String>,
    /// 最近一次本地维护（自动归档）的时间
    pub last_maintain_at: Option<String>,
}

/// 供 prompt 注入的紧凑认知块。刻意做得很短：它每轮都要进系统提示词。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbCognition {
    pub memories: Vec<KbMemory>,
    pub text: String,
}

/* ---------- 真实文件（kb_files，可写） ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFile {
    pub id: i64,
    pub path: String,
    pub content: String,
    pub system: bool,
    /// text | multimodal | folder（见 FILE_KIND_*）
    pub kind: String,
    /// 用户钉住后 AI 不再自动移动
    pub pinned: bool,
    /// inbox | filed | manual
    pub classify_state: String,
    pub created_at: String,
    pub updated_at: String,
    /// 该节点的模态清单（含可用状态）。文本笔记恒有 text，多模态节点另有本体模态。
    pub modalities: Vec<KbModalInfo>,
    /// 用户评分 0..5（0 = 未评）
    pub rating: i64,
    /// 用户标签（不进索引：标签是给人看的分类，不是内容）
    pub tags: Vec<String>,
    /// 用户注释（自由文本）
    pub note: String,
}

/// 改一个文件的用户元数据：评分 / 标签 / 注释。只传要改的字段，缺省不动。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbMetaInput {
    /// `id` 可以是文档 id 或文件 id（与其余文件命令一致）
    pub id: i64,
    #[serde(default)]
    pub rating: Option<i64>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 新建 / 覆盖一个文件。路径会按规范净化与归位（见 files.rs::normalize_path）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFileInput {
    pub path: String,
    #[serde(default)]
    pub content: String,
}

/// glob 命中。`*` 不跨目录、`**` 跨目录、`?` 单字符。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbGlobHit {
    pub id: i64,
    pub path: String,
    pub source_type: String,
    pub title: String,
    pub kind: String,
    pub editable: bool,
    pub system: bool,
    pub occurred_on: Option<String>,
}

/* ---------- 目录列举（文件管理器的「一层」视图，kb/listing.rs） ---------- */

/// 回收站命名空间：被删除的文件整体挪到这里（path 是 UNIQUE，必须先腾开原路径）。
/// 它不在任何已知根目录里，正常浏览路径永远不会走到。
pub const TRASH_ROOT: &str = "回收站";

/// 目录里的一个条目。**一层的完整元数据**：文件管理器的列表/网格只需要这一份，
/// 不必再去 glob 整棵子树。目录条目用 `path` 做身份（`doc_id` 为 0）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbEntry {
    /// kb_docs.id —— 目录节点为 0（它没有可阅读的派生文档）
    pub id: i64,
    /// kb_files.id —— 派生投影没有真实文件行为 None
    pub file_id: Option<i64>,
    pub path: String,
    /// 路径末段（真实文件名，如 `晨会录音.wav`）
    pub name: String,
    /// folder | text | image | audio | video | file
    pub kind: String,
    /// 目录条目恒为 ""；文件条目给出来源类别，UI 用它在只读派生文档上标注原因
    pub source_type: String,
    pub title: String,
    pub system: bool,
    pub editable: bool,
    /// 字节数：文本按其 UTF-8 长度；多模态取本体字节；目录为子树占用
    pub size: i64,
    /// 目录的直接子项数（文件条目恒为 0）
    pub child_count: i64,
    pub occurred_on: Option<String>,
    pub updated_at: String,
    pub pinned: bool,
    /// inbox | filed | manual | ""（派生投影没有归类状态）
    pub classify_state: String,
    /// 该节点的可用模态（text / image / audio / video / binary）
    pub modalities: Vec<String>,
    /// 用户评分 0..5（0 = 未评）
    pub rating: i64,
    /// 用户标签
    pub tags: Vec<String>,
    /// 用户注释（列表不带，避免一层的响应被长文本撑肥；详情走 kb_file_get）
    pub has_note: bool,
}

/// 一次目录列举的结果。`truncated` 表示条目或聚合被上限截断（大目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbDirListing {
    pub path: String,
    pub entries: Vec<KbEntry>,
    /// 条目总数（未截断时等于 entries.len()）
    pub total: i64,
    pub truncated: bool,
}

/// 回收站里的一条。`path` 是回收站内的存放路径，`original_path` 是删除前的位置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbTrashEntry {
    pub file_id: i64,
    /// kb_docs.id（回收后派生文档已删，通常为 0）
    pub id: i64,
    pub name: String,
    pub path: String,
    pub original_path: String,
    pub kind: String,
    pub source_type: String,
    pub size: i64,
    pub system: bool,
    pub trashed_at: String,
    pub updated_at: String,
}

/// 单条回收站操作的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbTrashResult {
    pub file_id: i64,
    /// 影响的行数（目录会连带子树）
    pub count: i64,
    pub path: String,
}

/// 批量回收站操作的结果：成功条数与逐条失败原因（前端逐条报告，不整体失败）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbTrashBatchResult {
    pub done: i64,
    pub freed_bytes: i64,
    pub failed: Vec<String>,
}

/* ---------- 模态层（kb_assets，docs/ai-workspace.md §2） ---------- */

/// 一条模态表示。`storage='fs'` 时 `ref` 是应用数据目录内的相对路径；
/// `storage='inline'` 时 `ref` 就是文本本体（仅用于小段文本）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbAsset {
    pub id: i64,
    pub file_id: i64,
    pub modal: String,
    pub mime: String,
    pub storage: String,
    #[serde(rename = "ref")]
    pub ref_: String,
    pub bytes: i64,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub transcript_state: String,
    pub derived_from: Option<String>,
    pub created_at: String,
}

/// 给读取结果看的模态摘要：能拿到什么、什么状态、本体在哪。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbModalInfo {
    pub modal: String,
    pub mime: String,
    pub bytes: i64,
    pub duration_ms: Option<i64>,
    pub transcript_state: String,
    pub derived_from: Option<String>,
    /// asset（kb_assets 行）| voice（语音纪要本体）| attachment（附件里的本体）| text（正文）
    pub source: String,
}

/// 一次模态读取的结果。**降级永远发生**：请求的模态不可用时回退到文本并给出原因。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbMedia {
    pub doc_id: i64,
    pub path: Option<String>,
    pub title: String,
    pub kind: String,
    /// 该节点实际可用的模态清单
    pub modalities: Vec<KbModalInfo>,
    /// 调用方请求的模态（未请求时为 None）
    pub requested: Option<String>,
    /// 发生了降级（请求的模态不可用，或用的是派生文本）
    pub degraded: bool,
    pub degrade_reason: Option<String>,
    pub mime: Option<String>,
    /// 本体字节的 data URL（≤ 上限时给；超限只给元信息）
    pub data_url: Option<String>,
    /// 本体存在但过大，未内联
    pub too_large: bool,
    /// 文本模态内容（请求 text，或降级到文本时）
    pub text: Option<String>,
    pub hint: Option<String>,
}

/// 写入一个多模态节点的本体 + 文本模态。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbMediaInput {
    pub path: String,
    /// 原始文件名（决定存储名；缺省取 path 末段）
    #[serde(default)]
    pub name: Option<String>,
    pub mime: String,
    /// base64（可带 data URL 前缀）
    pub data_base64: String,
    /// 文本模态：摘要 / 转录 / 描述。缺省时自动生成描述行，保证可检索（§2.3）
    #[serde(default)]
    pub text: Option<String>,
}

/* ---------- 目录治理（kb_fs_moves，§3.3） ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFsMove {
    pub id: i64,
    pub batch_id: String,
    pub source: String,
    pub op: String,
    pub path_from: String,
    pub path_to: String,
    pub reason: String,
    pub at: String,
    pub undone: bool,
}

/// 一次归类移动的结果：新节点 + 从哪到哪 + 批次（可整批撤销）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFsMoveResult {
    pub file: KbFile,
    pub from: String,
    pub to: String,
    pub batch_id: String,
}

/* ---------- 全量注入区（§3.4） ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbInjectionFile {
    pub path: String,
    pub zone: String,
    pub chars: i64,
    /// 该文件被预算截断（只注入了一部分）
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbInjection {
    /// 系统提示词目录（系统区）拼接结果
    pub system: String,
    /// 用户记忆目录（记忆区）拼接结果
    pub memory: String,
    pub files: Vec<KbInjectionFile>,
    pub total_chars: i64,
    pub budget: i64,
    pub truncated: bool,
}
