//! 长期记忆分片层的共享类型、参数常量与序列化结构（方案 §2 / §4.2 / §5 / §6 / §7.2）。
//!
//! 约定：
//! - 所有跨域返回结构体统一 `#[serde(rename_all = "camelCase")]`；
//! - 字段名与方案 §7.2 / §5.1 / §5.2 / §6.2–6.4 逐字一致，B/C 域不得在本文件增删字段；
//! - `origin` / `state` 在行结构里仍是 `String`（与 SQLite 列一致），
//!   `SourceType` / `ShardState` 只作为取值集合的枚举投影供新代码做类型约束。

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 取值集合（§2.4 #3 / §2.2 CHECK）
// ---------------------------------------------------------------------------

/// `memory_shards.origin` 的取值集合（§2.4 #3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    Conversation,
    DreamSummary,
    ManualWrite,
    MarkedImportant,
}

/// `memory_shards.state` 的取值集合（三态，§2.2 / §4.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShardState {
    Active,
    Dormant,
    Archived,
}

// ---------------------------------------------------------------------------
// 常量（§4.2 参数表；按表里「位置」列归属）
// ---------------------------------------------------------------------------

/// 单个 shard 内容的 token 上限（§4.2）。
pub const SHARD_MAX_TOKENS: i64 = 1024;
/// 单个 shard 内容的字符硬上限，≈1024 中文 token（§4.2 / §3.3 / §5.5）。
pub const SHARD_MAX_CHARS: usize = 1800;
/// stability 的全局上限（天），防止无限强化（§4.2）。
pub const S_MAX: f64 = 3650.0;

// ---------------------------------------------------------------------------
// 时间解析（§4.1）
// ---------------------------------------------------------------------------

/// 解析 `last_event_at` / `created_at` 等时间列。
///
/// 必须兼容两种格式（§4.1）：
/// 1. 新写入的 RFC3339（`2026-11-10T12:34:56+00:00`）；
/// 2. 旧 `kb_memories` 回填的 SQLite `YYYY-MM-DD HH:MM:SS`（按 UTC 解释）。
///
/// `effective_weight` / `sweep` / `dream gate` 全部走它，不要直接 `parse_from_rfc3339`。
pub fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    // 旧库的 SQLite 文本（含 datetime('now') 的秒级格式；带小数秒的老行也认）
    for fmt in [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, fmt) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 参数表（§4.2；ShardParams 由 §10 A 放在 model.rs）
// ---------------------------------------------------------------------------

/// 新建 shard 的衰减参数（§4.2 参数表）。
///
/// `base_weight` / `floor` / `s0` 按 origin 取值；legacy 迁移行
/// 用 dream 档先验（2.0 / 0.10 / 10.0），但 origin 仍记 `manual_write`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShardParams {
    pub base_weight: f64,
    pub floor: f64,
    pub s0: f64,
}

// ---------------------------------------------------------------------------
// 行结构与序列化返回（§7.2）
// ---------------------------------------------------------------------------

/// `memory_shards` 的读模型。`effective_weight` 是读时按 §4.1 算出来的，不落库。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryShard {
    pub id: i64,
    pub origin: String, // conversation | dream_summary | manual_write | marked_important
    pub mem_type: String,
    pub topic: String,
    pub category: String,
    pub content: String,
    pub confidence: f64,
    pub base_weight: f64,
    pub floor: f64,
    pub stability: f64,
    pub last_event_at: String,
    pub state: String, // active | dormant | archived
    pub anchor_message_id: Option<String>,
    pub chat_id: Option<String>,
    pub user_message_id: Option<String>,
    pub provenance: serde_json::Value,
    pub supersedes: Option<i64>,
    pub consolidated_into: Option<i64>,
    pub dream_action: Option<String>,
    pub source_chat_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub archived_reason: Option<String>,
    pub effective_weight: f64, // 读时计算
}

/// `memory_shard_history` 的一行（唯一真相源，§4.3）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryShardHistory {
    pub seq: i64,
    pub at: String,
    pub event: String,
    pub stability: f64,
    pub base_weight: f64,
    pub floor: f64,
    pub factor: f64,
    pub rank: Option<i64>,
    pub hits_30d: Option<i64>,
    pub run_id: String,
    pub note: String,
}

/// 任务书里的名字；与 §7.2 的 `MemoryShardHistory` 是同一个类型。
pub type ShardHistoryEntry = MemoryShardHistory;

/// `memory_shard_get` 的返回：shard + 全量历史 + 溯源消息 id。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryShardDetail {
    pub shard: MemoryShard,
    pub history: Vec<MemoryShardHistory>,
    pub source_message_ids: Vec<String>,
}

/// `memory_shard_apply` 的单条写入动作（§3.3 / §7.2）。
///
/// 所有可选字段用 `Option`：update 只改 `Some` 的字段；缺失不能反序列化成空串
/// 再把类型重置成 preference。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardWriteAction {
    pub op: String, // add | update | delete | archive
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub mem_type: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `memory_shard_update` 的部分更新（§3.3 / §7.2）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardPatch {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub mem_type: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

/// `memory_shard_apply` 的批量结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardApplyResult {
    pub added: i64,
    pub updated: i64,
    pub deleted: i64,
    pub archived: i64,
    pub restored: i64,
    pub skipped: i64,
}

/// `memory_shard_sweep` 的巡检结果（§4.4）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardSweepResult {
    pub checked: i64,
    pub activated: i64,
    pub dormant: i64,
    pub archived: i64,
}

/// `memory_shard_stats` 的统计（§7.3 契约）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryShardStats {
    pub active: i64,
    pub dormant: i64,
    pub archived: i64,
    pub total: i64,
    pub limit: i64,
    pub max_chars: i64,
    pub injected: i64,
    pub injected_chars: i64,
    pub estimated_tokens: i64,
    pub budget_tokens: i64,
    pub avg_confidence: f64,
    pub avg_effective_weight: f64,
    pub signal_ratio: f64,
    pub noise_ratio: f64,
    pub embedding_pending: i64,
    pub embedding_failed: i64,
    pub last_sweep_at: Option<String>,
    pub last_dream_at: Option<String>,
    pub at_cap: bool,
    pub sweep_truncated: bool,
}

/// `memory_shard_overview` 的返回（active + dormant 列表 + stats + 认知投影）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryShardOverview {
    pub shards: Vec<MemoryShard>,      // active + dormant，按 updated_at DESC
    pub stats: MemoryShardStats,
    pub cognition: MemoryInjectResult, // query=None，不写 history
}

/// `memory_shard_duplicates` 的一条重复对（§5.2 / §6.3）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDuplicate {
    pub a_id: i64,
    pub b_id: i64,
    pub score: f64,
    pub a_content: String,
    pub b_content: String,
}

/// `memory_shard_events` 的审计行（§7.1 #15）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryShardEvent {
    pub at: String,
    pub shard_id: i64,
    pub event: String,
    pub content: String, // 截 120
    pub run_id: String,
    pub note: String,
}

// ---------------------------------------------------------------------------
// 注入（§5.1）
// ---------------------------------------------------------------------------

/// `memory_shard_inject` 的返回。严格只读（§5.1）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInjectResult {
    pub text: String,
    pub shards: Vec<MemoryInjectShard>,
    pub estimated_tokens: i64,
    pub budget_tokens: i64,
    pub mode: String, // "vector" | "keyword" | "weight"
}

/// 注入选中单条 shard 的投影；`reason` = anchor | digest | relevant | weight。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInjectShard {
    pub shard_id: i64,
    pub content: String,
    pub mem_type: String,
    pub topic: String,
    pub category: String,
    pub origin: String,
    pub anchor_message_id: Option<String>,
    pub chat_id: Option<String>,
    pub effective_weight: f64,
    pub reason: String, // "anchor" | "digest" | "relevant" | "weight"
}

// ---------------------------------------------------------------------------
// 主动检索（§5.2）
// ---------------------------------------------------------------------------

/// `memory_shard_search` 的返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResult {
    pub hits: Vec<MemorySearchHit>,
    pub mode: String, // "vector" | "keyword" | "weight"
    pub reinforced: i64,
    pub revived: i64,
    pub took_ms: i64,
}

/// 检索命中的单条 shard；`relevance` 是 cosine / FTS / LIKE 的分数。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchHit {
    pub shard_id: i64,
    pub content: String,
    pub mem_type: String,
    pub topic: String,
    pub category: String,
    pub origin: String,
    pub state: String,
    pub anchor_message_id: Option<String>,
    pub chat_id: Option<String>,
    pub relevance: f64,
    pub effective_weight: f64,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Dream（§6.2 / §6.3 / §6.4）
// ---------------------------------------------------------------------------

/// `memory_dream_begin` 的门控结果（§6.2）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamGate {
    pub eligible: bool,
    pub reason: String, // ok | cooldown | insufficient_material | running | no_material | disabled
    pub last_run_at: Option<String>,
    pub sessions_since: i64,
    pub messages_since: i64,
    pub cooldown_hours: i64,
    pub min_sessions: i64,
    pub min_messages: i64,
}

/// `memory_dream_begin` 的返回；`runId` / `context` 只在 eligible 时非空。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamBeginResult {
    pub gate: DreamGate,
    pub run_id: Option<String>,
    pub context: Option<DreamContext>,
}

/// Dream 的输入上下文（§6.3）；不含图片/base64/process payload。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamContext {
    pub since: Option<String>,
    pub sessions: Vec<DreamSession>,           // 最多 8
    pub shards: Vec<DreamShardBrief>,          // 最多 40
    pub duplicate_pairs: Vec<MemoryDuplicate>, // 最多 20
    pub total_sessions: i64,
    pub total_messages: i64,
}

/// Dream 上下文里的一个会话。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSession {
    pub chat_id: String,
    pub title: String,
    pub updated_at: String,
    pub messages: Vec<DreamMessage>, // 只含有 text 的 text/food-parse/analysis/voice（voice 是 user），最多 200 条总量
}

/// Dream 上下文里的一条消息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamMessage {
    pub id: String,
    pub seq: i64,
    pub role: String,
    pub kind: String,
    pub text: Option<String>,
    pub anchor_id: Option<String>,
    pub created_at: String,
}

/// Dream 上下文里的一条 shard 摘要；`content` 截 300。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamShardBrief {
    pub id: i64,
    pub content: String, // 截 300
    pub mem_type: String,
    pub topic: String,
    pub category: String,
    pub origin: String,
    pub state: String,
    pub stability: f64,
    pub effective_weight: f64,
    pub anchor_message_id: Option<String>,
    pub chat_id: Option<String>,
    pub updated_at: String,
}

/// `memory_dream_apply` 的四类动作（§6.4）。
///
/// `rename_all` 作用于 variant（supersede/consolidate/digest/revive）；
/// `rename_all_fields` 让 `old_shard_id` / `shard_ids` 接受 TS 的 `oldShardId` / `shardIds`
/// （serde 1.0.229 支持）。
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DreamAction {
    Supersede {
        old_shard_id: i64,
        content: String,
        #[serde(default)]
        mem_type: Option<String>,
        #[serde(default)]
        topic: Option<String>,
        #[serde(default)]
        category: Option<String>,
        #[serde(default)]
        reason: String,
    },
    Consolidate {
        shard_ids: Vec<i64>,
        content: String,
        #[serde(default)]
        mem_type: Option<String>,
        #[serde(default)]
        topic: Option<String>,
        #[serde(default)]
        category: Option<String>,
        #[serde(default)]
        reason: String,
    },
    Digest {
        content: String,
        #[serde(default)]
        topic: Option<String>,
        #[serde(default)]
        category: Option<String>,
    },
    Revive {
        shard_id: i64,
        #[serde(default)]
        reason: String,
    },
}

/// `memory_dream_apply` 的返回（§6.4）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamApplyResult {
    pub created: i64,
    pub superseded: i64,
    pub consolidated: i64,
    pub revived: i64,
    pub skipped: i64,
    pub already_applied: bool,
}

