//! shard 持久化：CRUD、异步 jobs、legacy 回填、conversation 抽取与跨设备对账（§2.4 / §3）。
//!
//! 附录 A 把面向 B/C 的关键函数集中列在 `store`；实现上：
//! - 历史追加的实际入口是 `history::append`，`store::append_history` 保留附录 A 的门面签名；
//! - `backfill_missing` 的实现在 `anchor`（§10 A），这里再导出以保持附录 A 的调用路径。
//!
//! 事务与级联纪律：
//! - `memory_shard_history` 的 FK 级联在 `PRAGMA foreign_keys=OFF` 的迁移窗口/测试连接上不生效，
//!   所以删除 shard 时**显式**删 history（与 `index.rs` 显式删 FTS 行同一纪律）；
//! - 删除/归档/合并 shard 都同步清理 `memory_jobs(kind='embed')`，否则 worker 会取到已删 shard；
//! - 写 shard 与写 history、embed job、`index::mark_dirty` 必须在同一事务里。

use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::db;
use crate::error::Result;
use crate::modules::kb::index;
use crate::modules::kb::models::MEMORY_TYPES;

use super::anchor;
use super::decay;
use super::history;
use super::model::MemoryShard;

pub use super::anchor::backfill_missing;
pub use super::model::ShardParams;

/// 全库 shard 软上限；只卡 conversation 写入（§3.2 第 6 步 / §3.5）。
pub const TOTAL_SHARD_SOFT_CAP: i64 = 50000;

/// `app_meta` 里 legacy 回填的一次性标记（§2.3.2）。
pub const LEGACY_BACKFILL_KEY: &str = "memory.legacy_backfill_v1";

/// `memory_shards` 的读取列，顺序与 `row_to_shard` 逐字对应。
pub(crate) const SHARD_COLS: &str = "id, origin, mem_type, topic, category, content, confidence, \
     base_weight, floor, stability, last_event_at, state, anchor_message_id, chat_id, \
     user_message_id, provenance_json, supersedes, consolidated_into, dream_action, \
     source_chat_id, created_at, updated_at, archived_at, archived_reason";

/// 新建 shard 的输入。字段名与 `memory_shards` 列逐字对应（§2.2）；
/// `idempotency_key` 由创建路径先生成（§2.4 #2）。
#[derive(Debug, Clone, Default)]
pub struct NewShard<'a> {
    pub idempotency_key: &'a str,
    pub origin: &'a str,
    pub mem_type: &'a str,
    pub topic: &'a str,
    pub category: &'a str,
    pub content: &'a str,
    pub content_hash: Option<&'a str>,
    pub confidence: f64,
    pub base_weight: f64,
    pub floor: f64,
    pub stability: f64,
    pub last_event_at: &'a str,
    pub state: &'a str,
    pub anchor_message_id: Option<&'a str>,
    pub anchor_hash: Option<&'a str>,
    pub chat_id: Option<&'a str>,
    pub user_message_id: Option<&'a str>,
    pub provenance_json: serde_json::Value,
    pub supersedes: Option<i64>,
    pub dream_action: Option<&'a str>,
    pub source_chat_id: Option<&'a str>,
    pub source_message_ids: Vec<String>,
    pub legacy_memory_id: Option<i64>,
    pub legacy_active_count: i64,
    pub legacy_last_used_at: Option<&'a str>,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

/// 追加一条 history 的输入。字段与附录 A 的 `NewHistory` 注释逐字一致（§4.3）。
#[derive(Debug, Clone, Default)]
pub struct NewHistory<'a> {
    pub at: &'a str,
    pub event: &'a str,
    pub stability: f64,
    pub base_weight: f64,
    pub floor: f64,
    pub factor: f64,
    pub rank: Option<i64>,
    pub hits_30d: Option<i64>,
    pub origin: &'a str,
    pub run_id: &'a str,
    pub note: &'a str,
}

/// `take_embed_batch` 的一行：只带 shard id 与待嵌入文本（§3.4）。
#[derive(Debug, Clone)]
pub struct EmbedJob {
    pub shard_id: i64,
    pub content: String,
}

/* ---------- 参数与规范化 ---------- */

/// 按 origin 取衰减参数（§4.2 参数表；legacy 行用 dream 档先验）。
pub fn params_for(origin: &str) -> ShardParams {
    match origin {
        "conversation" => ShardParams {
            base_weight: 1.0,
            floor: 0.05,
            s0: 3.0,
        },
        "dream_summary" => ShardParams {
            base_weight: 2.0,
            floor: 0.10,
            s0: 10.0,
        },
        "marked_important" => ShardParams {
            base_weight: 4.0,
            floor: 0.35,
            s0: 90.0,
        },
        // manual_write 与未知 origin：地板权重 0.375，永远 active
        _ => ShardParams {
            base_weight: 2.5,
            floor: 0.15,
            s0: 20.0,
        },
    }
}

/// mem_type 规范化；未知收敛 `preference`（附录 A）。
pub fn normalize_type(raw: &str) -> String {
    let t = raw.trim();
    if MEMORY_TYPES.contains(&t) {
        t.to_string()
    } else {
        "preference".to_string()
    }
}

/// 分类路径规范化：按 `/` 分层、逐段净化、最多两层、每段 ≤16 字。
/// 与 `memory::normalize_category` / `source::sanitize` 同一口径，保证
/// `记忆/{类型}/{分类}/…` 虚拟路径永远合法。
pub fn normalize_category(raw: &str) -> String {
    raw.split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(2)
        .map(|s| crate::modules::kb::source::sanitize(s, 16))
        .collect::<Vec<_>>()
        .join("/")
}

/// 内容 hash；复用 `index::content_hash`（FNV-1a 64，跨版本稳定，附录 A）。
pub fn compute_content_hash(content: &str) -> String {
    index::content_hash(&[content])
}

/* ---------- 行映射与读取 ---------- */

/// `memory_shards` 行 → `MemoryShard`，`effective_weight` 按 `now` 读时计算（§4.1 / 附录 A）。
pub fn row_to_shard(row: &rusqlite::Row<'_>, now: DateTime<Utc>) -> rusqlite::Result<MemoryShard> {
    let provenance_raw: String = row.get(15)?;
    let mut shard = MemoryShard {
        id: row.get(0)?,
        origin: row.get(1)?,
        mem_type: row.get(2)?,
        topic: row.get(3)?,
        category: row.get(4)?,
        content: row.get(5)?,
        confidence: row.get(6)?,
        base_weight: row.get(7)?,
        floor: row.get(8)?,
        stability: row.get(9)?,
        last_event_at: row.get(10)?,
        state: row.get(11)?,
        anchor_message_id: row.get(12)?,
        chat_id: row.get(13)?,
        user_message_id: row.get(14)?,
        provenance: serde_json::from_str(&provenance_raw).unwrap_or_else(|_| json!({})),
        supersedes: row.get(16)?,
        consolidated_into: row.get(17)?,
        dream_action: row.get(18)?,
        source_chat_id: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
        archived_at: row.get(22)?,
        archived_reason: row.get(23)?,
        effective_weight: 0.0,
    };
    shard.effective_weight = decay::effective_weight(&shard, now);
    Ok(shard)
}

/// 按 id 取单条 shard；不排除 `consolidated_into`（溯源可查，§2.4 #5）。
pub fn get_shard(conn: &Connection, id: i64) -> Result<Option<MemoryShard>> {
    let sql = format!("SELECT {SHARD_COLS} FROM memory_shards WHERE id = ?1");
    let shard = conn
        .query_row(&sql, [id], |r| row_to_shard(r, Utc::now()))
        .optional()?;
    Ok(shard)
}

/// 列表：`scope ∈ active|dormant|archived|all`（未知收敛 active），
/// `origin` 含 `curated`/`all`/四类；排除 `consolidated_into IS NOT NULL`。
///
/// 排序（§7.1）：`state` 优先级 active→dormant→archived，组内
/// `julianday(updated_at) DESC, id DESC`（兼容旧行的 SQLite 空格时间格式）。
pub fn list_shards(
    conn: &Connection,
    scope: &str,
    origin: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<MemoryShard>> {
    let scope_clause = match scope.trim() {
        "all" => "",
        "dormant" => "AND state = 'dormant'",
        "archived" => "AND state = 'archived'",
        _ => "AND state = 'active'",
    };
    // origin 只接受固定枚举（curated/all/四类）；不把任意字符串拼进 SQL。
    let origin_clause = match origin.map(str::trim) {
        None | Some("") | Some("all") => "",
        Some("curated") => "AND origin IN ('manual_write','dream_summary','marked_important')",
        Some("conversation") => "AND origin = 'conversation'",
        Some("dream_summary") => "AND origin = 'dream_summary'",
        Some("manual_write") => "AND origin = 'manual_write'",
        Some("marked_important") => "AND origin = 'marked_important'",
        _ => "",
    };
    let sql = format!(
        "SELECT {SHARD_COLS} FROM memory_shards
         WHERE consolidated_into IS NULL {scope_clause} {origin_clause}
         ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'dormant' THEN 1 ELSE 2 END,
                  julianday(updated_at) DESC, id DESC
         LIMIT ?1 OFFSET ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params![limit, offset], |r| {
            row_to_shard(r, Utc::now())
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/* ---------- 写入 ---------- */

/// 插入 shard；`ON CONFLICT DO NOTHING` 命中（idempotency_key 或 manual 局部唯一索引）
/// 时返回 0（§2.4 #2 / 附录 A）。
pub fn insert_shard(tx: &Transaction<'_>, new: NewShard<'_>) -> Result<i64> {
    let provenance = serde_json::to_string(&new.provenance_json)?;
    let message_ids = serde_json::to_string(&new.source_message_ids)?;
    let changed = tx.execute(
        "INSERT INTO memory_shards (
           idempotency_key, origin, mem_type, topic, category, content, content_hash,
           confidence, base_weight, floor, stability, last_event_at, state,
           anchor_message_id, anchor_hash, chat_id, user_message_id, provenance_json,
           supersedes, dream_action, source_chat_id, source_message_ids,
           legacy_memory_id, legacy_active_count, legacy_last_used_at,
           created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
           ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
         )
         ON CONFLICT DO NOTHING",
        rusqlite::params![
            new.idempotency_key,
            new.origin,
            new.mem_type,
            new.topic,
            new.category,
            new.content,
            new.content_hash,
            new.confidence,
            new.base_weight,
            new.floor,
            new.stability,
            new.last_event_at,
            new.state,
            new.anchor_message_id,
            new.anchor_hash,
            new.chat_id,
            new.user_message_id,
            provenance,
            new.supersedes,
            new.dream_action,
            new.source_chat_id,
            message_ids,
            new.legacy_memory_id,
            new.legacy_active_count,
            new.legacy_last_used_at,
            new.created_at,
            new.updated_at,
        ],
    )?;
    if changed == 0 {
        return Ok(0);
    }
    Ok(tx.last_insert_rowid())
}

/// 删除单条 shard（CRUD 的 delete）。返回 `false` = 不存在。
///
/// 语义（§2.4 #5）：
/// - 若该 shard 是合并目标，**先**删除 `consolidated_into = id` 的旧 shards，
///   否则 FK `ON DELETE SET NULL` 会把旧 shards 的 `consolidated_into` 清空，
///   让它们重新出现在列表/检索里；
/// - history、embed job、`kb_docs` 镜像都显式清理（FK 级联在 `foreign_keys=OFF` 时不生效）。
pub fn delete_shard(conn: &Connection, id: i64) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let exists: Option<i64> = tx
        .query_row("SELECT 1 FROM memory_shards WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    if exists.is_none() {
        tx.commit()?;
        return Ok(false);
    }

    let children: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM memory_shards WHERE consolidated_into = ?1")?;
        let rows = stmt
            .query_map([id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for child in children {
        delete_one_shard_tx(&tx, child)?;
    }
    delete_one_shard_tx(&tx, id)?;
    tx.commit()?;
    Ok(true)
}

fn delete_one_shard_tx(tx: &Transaction<'_>, id: i64) -> Result<()> {
    tx.execute(
        "DELETE FROM memory_jobs WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
        [id],
    )?;
    index::delete_doc(tx, "memory", &id.to_string())?;
    tx.execute(
        "DELETE FROM memory_shard_history WHERE shard_id = ?1",
        [id],
    )?;
    // 不依赖 FK：显式清掉其它行对本行的单向引用
    tx.execute(
        "UPDATE memory_shards SET supersedes = NULL WHERE supersedes = ?1",
        [id],
    )?;
    tx.execute(
        "UPDATE memory_shards SET consolidated_into = NULL WHERE consolidated_into = ?1",
        [id],
    )?;
    tx.execute("DELETE FROM memory_shards WHERE id = ?1", [id])?;
    Ok(())
}

/// 三态计数 `(active, dormant, archived, total)`，不含已合并 shard（stats 用）。
pub fn state_counts(conn: &Connection) -> Result<(i64, i64, i64, i64)> {
    let counts = conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN state = 'dormant' THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN state = 'archived' THEN 1 ELSE 0 END), 0),
           COUNT(*)
         FROM memory_shards WHERE consolidated_into IS NULL",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok(counts)
}

/// 追加 history（birth/search_hit/manual_*/dream_*）；`false` = 幂等跳过（§4.3 / 附录 A）。
///
/// 实现转调 `history::append`；签名保留附录 A 的 `store` 门面。
pub fn append_history(tx: &Transaction<'_>, shard_id: i64, ev: NewHistory<'_>) -> Result<bool> {
    history::append(tx, shard_id, ev)
}

/// 与 history 同事务更新 shard 的 stability / last_event_at / state 缓存（§4.3 / 附录 A）。
///
/// `now` 同时写 `updated_at`：事件发生即「最近更新」，列表排序据此刷新。
pub fn touch_shard(
    tx: &Transaction<'_>,
    id: i64,
    now: &str,
    stability: f64,
    last_event_at: &str,
    state: &str,
) -> Result<()> {
    tx.execute(
        "UPDATE memory_shards
         SET stability = ?2, last_event_at = ?3, state = ?4, updated_at = ?5
         WHERE id = ?1",
        rusqlite::params![id, stability, last_event_at, state, now],
    )?;
    Ok(())
}

/// 标记检索镜像脏：`index::mark_dirty("memory", id)`（附录 A）。
pub fn mark_dirty(conn: &Connection, id: i64) -> Result<()> {
    index::mark_dirty(conn, "memory", &id.to_string())
}

/* ---------- 时间与 jobs ---------- */

fn plus_secs(raw: &str, secs: i64) -> String {
    super::model::parse_ts(raw)
        .map(|t| (t + Duration::seconds(secs)).to_rfc3339())
        .unwrap_or_else(|| raw.to_string())
}

/// 投递 extract job（`ref_id = anchor_id`，not_before = now + 3s）；按 anchor 去重（§2.5 / §3.1）。
///
/// 同一 chat 的多个 terminal 各有 job，**不能按 chat 去重**，否则 3 秒内连续两个
/// terminal 会互相覆盖，前一轮永远不生成 shard。
pub fn enqueue_extract(conn: &Connection, chat_id: &str, anchor_id: &str, now: &str) -> Result<()> {
    let not_before = plus_secs(now, 3);
    conn.execute(
        "INSERT INTO memory_jobs(kind, ref_id, chat_id, attempts, not_before, created_at, updated_at)
         VALUES ('extract', ?1, ?2, 0, ?3, ?4, ?4)
         ON CONFLICT(kind, ref_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           not_before = excluded.not_before,
           updated_at = excluded.updated_at",
        rusqlite::params![anchor_id, chat_id, not_before, now],
    )?;
    Ok(())
}

/// 投递 embed job（`ref_id = CAST(shard_id AS TEXT)`，not_before = now；§3.4）。
/// 显式重投会清空失败计数与错误（内容变化后旧 backoff 不应继续压制）。
pub fn enqueue_embed(conn: &Connection, shard_id: i64, now: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_jobs(kind, ref_id, not_before, created_at, updated_at)
         VALUES ('embed', CAST(?1 AS TEXT), ?2, ?2, ?2)
         ON CONFLICT(kind, ref_id) DO UPDATE SET
           attempts = 0,
           last_error = NULL,
           not_before = excluded.not_before,
           updated_at = excluded.updated_at",
        rusqlite::params![shard_id, now],
    )?;
    Ok(())
}

/// 在 `budget_ms` 内消费 extract jobs（不调模型）；返回处理数（§3.1 / 附录 A）。
///
/// 失败不 poison 队列：`attempts++` + 指数退避；5 次后删除 job，避免坏行永远占队头。
pub fn drain_extract(conn: &Connection, budget_ms: u64) -> Result<i64> {
    let started = std::time::Instant::now();
    let mut processed = 0i64;
    loop {
        if started.elapsed().as_millis() as u64 >= budget_ms {
            break;
        }
        let job: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, ref_id FROM memory_jobs
                 WHERE kind = 'extract' AND julianday(not_before) <= julianday('now')
                 ORDER BY id LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((job_id, anchor_id)) = job else { break };

        match process_extract(conn, &anchor_id) {
            Ok(_) => {
                conn.execute("DELETE FROM memory_jobs WHERE id = ?1", [job_id])?;
            }
            Err(e) => {
                let attempts: i64 = conn
                    .query_row(
                        "SELECT attempts FROM memory_jobs WHERE id = ?1",
                        [job_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                if attempts + 1 >= 5 {
                    conn.execute("DELETE FROM memory_jobs WHERE id = ?1", [job_id])?;
                } else {
                    let delay = (30i64 << attempts.min(6)).min(3600);
                    let at = Utc::now().to_rfc3339();
                    conn.execute(
                        "UPDATE memory_jobs
                         SET attempts = attempts + 1, last_error = ?2, not_before = ?3, updated_at = ?4
                         WHERE id = ?1",
                        rusqlite::params![job_id, e.to_string(), plus_secs(&at, delay), at],
                    )?;
                }
            }
        }
        processed += 1;
    }
    Ok(processed)
}

/// 取一批 embed job，JOIN `memory_shards` 过滤已删 shard（§3.4 / 附录 A）。
pub fn take_embed_batch(conn: &Connection, limit: i64) -> Result<Vec<EmbedJob>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.content
         FROM memory_jobs j
         JOIN memory_shards s ON s.id = CAST(j.ref_id AS INTEGER)
         WHERE j.kind = 'embed' AND julianday(j.not_before) <= julianday('now')
         ORDER BY j.id
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(EmbedJob {
                shard_id: r.get(0)?,
                content: r.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 写回向量（模型在锁外算完）；同时写 embedding_model/dim/at 并删 job（§3.4）。
///
/// 存储格式与 `kb_vectors.vec` 一致：f32 小端拼接。
pub fn store_embeddings(conn: &Connection, model_id: &str, rows: &[(i64, Vec<f32>)]) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    for (shard_id, vec) in rows {
        if vec.is_empty() {
            // 空向量不是有效语义；保留 job，等下一轮/模型修复
            continue;
        }
        let mut blob = Vec::with_capacity(vec.len() * 4);
        for f in vec {
            blob.extend_from_slice(&f.to_le_bytes());
        }
        tx.execute(
            "UPDATE memory_shards
             SET embedding = ?2, embedding_model = ?3, embedding_dim = ?4, embedding_at = ?5
             WHERE id = ?1",
            rusqlite::params![shard_id, blob, model_id, vec.len() as i64, now],
        )?;
        tx.execute(
            "DELETE FROM memory_jobs WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
            [shard_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// embed 失败：attempts++、last_error、指数退避（§3.4）。
///
/// `not_before = now + min(3600, 30 * 2^attempts)` 秒（attempts 是**本次之前**的次数）。
pub fn fail_embed_jobs(conn: &Connection, ids: &[i64], error: &str, now: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        let old: Option<i64> = tx
            .query_row(
                "SELECT attempts FROM memory_jobs WHERE kind='embed' AND ref_id = CAST(?1 AS TEXT)",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(old) = old else { continue };
        let delay = (30i64 << old.min(7)).min(3600);
        tx.execute(
            "UPDATE memory_jobs
             SET attempts = attempts + 1, last_error = ?2, not_before = ?3, updated_at = ?4
             WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
            rusqlite::params![id, error, plus_secs(now, delay), now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 按当前模型补投缺失/模型不匹配的 embed job；返回投递数（§3.4）。
///
/// 已有 job 的 shard 不重投：否则失败 backoff 会被每轮重置，永远打不到「3 次后保留供 stats」。
pub fn enqueue_missing_embeddings(
    conn: &Connection,
    model_id: &str,
    limit: i64,
) -> Result<i64> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT s.id FROM memory_shards s
             WHERE (s.embedding IS NULL OR s.embedding_model IS NULL OR s.embedding_model != ?1)
               AND s.consolidated_into IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM memory_jobs j
                 WHERE j.kind = 'embed' AND j.ref_id = CAST(s.id AS TEXT)
               )
             ORDER BY julianday(s.last_event_at) DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![model_id, limit], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let now = Utc::now().to_rfc3339();
    for id in &ids {
        enqueue_embed(conn, *id, &now)?;
    }
    Ok(ids.len() as i64)
}

/* ---------- conversation 抽取 ---------- */


/// 软上限判断：只在**替换/新建之后**的总量超限时停写（§3.2 第 6 步）。
pub(crate) fn exceeds_soft_cap(total: i64, old_count: i64, new_chunks: i64) -> bool {
    total - old_count + new_chunks > TOTAL_SHARD_SOFT_CAP
}

fn delete_extract_job(conn: &Connection, anchor_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM memory_jobs WHERE kind = 'extract' AND ref_id = ?1",
        [anchor_id],
    )?;
    Ok(())
}

/// 删除指定 anchor 的 conversation shard（级联 history、删 embed job、`delete_doc`）。
///
/// `chat_id = None` 表示「不知道 chat / 跨会话按 anchor 删」（anchor 消息已被撤回时）。
/// 只删 `origin='conversation'`；curated 不删。返回删除数。
fn delete_anchor_shards_tx(
    tx: &Transaction<'_>,
    chat_id: Option<&str>,
    anchor_ids: &[String],
) -> Result<i64> {
    if anchor_ids.is_empty() {
        return Ok(0);
    }
    let ids_json = serde_json::to_string(anchor_ids)?;
    let where_chat = if chat_id.is_some() {
        "AND chat_id = ?2"
    } else {
        ""
    };
    let select_sql = format!(
        "SELECT id FROM memory_shards
         WHERE origin = 'conversation'
           AND anchor_message_id IN (SELECT value FROM json_each(?1)) {where_chat}"
    );
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare(&select_sql)?;
        if let Some(chat) = chat_id {
            stmt.query_map(rusqlite::params![ids_json, chat], |r| r.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([ids_json.as_str()], |r| r.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    if ids.is_empty() {
        return Ok(0);
    }

    for id in &ids {
        tx.execute(
            "DELETE FROM memory_jobs WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
            [id],
        )?;
        index::delete_doc(tx, "memory", &id.to_string())?;
    }
    // FK 级联在 foreign_keys=OFF 时不生效，显式删（与 index.rs 显式删 FTS 同一纪律）
    tx.execute(
        "DELETE FROM memory_shard_history
         WHERE shard_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1))",
        [&ids_json],
    )?;
    let deleted = match chat_id {
        Some(chat) => tx.execute(
            &format!(
                "DELETE FROM memory_shards
                 WHERE origin = 'conversation'
                   AND anchor_message_id IN (SELECT value FROM json_each(?1)) {where_chat}"
            ),
            rusqlite::params![ids_json, chat],
        )?,
        None => tx.execute(
            &format!(
                "DELETE FROM memory_shards
                 WHERE origin = 'conversation'
                   AND anchor_message_id IN (SELECT value FROM json_each(?1)) {where_chat}"
            ),
            rusqlite::params![ids_json],
        )?,
    };
    Ok(deleted as i64)
}

/// 删除指定 anchor 的 conversation shard（公开门面；附录 A / §2.5）。
pub fn delete_conversation_shards_for_anchors(
    tx: &Transaction<'_>,
    chat_id: &str,
    anchor_ids: &[String],
) -> Result<i64> {
    delete_anchor_shards_tx(tx, Some(chat_id), anchor_ids)
}

/// 按 anchor id 处理 conversation 抽取：anchor_hash 重建 + 总 cap 判断（§3.2）。
///
/// 按 anchor 处理，不按 chat 取最新；空文本/food-parse-only 删除旧 shard 并返回 0。
/// 全程一个事务：先算 chunk + cap 判断，**绝不先删旧再发现建不出**。
pub fn process_extract(conn: &Connection, anchor_id: &str) -> Result<i64> {
    let tx = conn.unchecked_transaction()?;
    let now = Utc::now().to_rfc3339();

    // 1. 取 anchor（消息被撤回 / 锚点已移动 → 清旧 shard）
    let Some(anchor) = anchor::anchor_row(&tx, anchor_id)? else {
        delete_anchor_shards_tx(&tx, None, &[anchor_id.to_string()])?;
        delete_extract_job(&tx, anchor_id)?;
        tx.commit()?;
        return Ok(0);
    };

    // 2. 可读文本判定：结构化 food 卡/过程气泡不是可读结论，不建 shard
    let text = anchor.text.as_deref().unwrap_or("").trim().to_string();
    let readable = match anchor.kind.as_str() {
        "text" | "analysis" | "food-parse" => !text.is_empty(),
        _ => false,
    };
    if !readable {
        delete_anchor_shards_tx(&tx, Some(&anchor.chat_id), &[anchor.id.clone()])?;
        delete_extract_job(&tx, anchor_id)?;
        tx.commit()?;
        return Ok(0);
    }

    // 3. anchor_hash：文本/类型变了必须重建
    let anchor_hash = index::content_hash(&[&text, &anchor.kind]);
    let existing_hashes: Vec<Option<String>> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT anchor_hash FROM memory_shards
             WHERE origin = 'conversation' AND anchor_message_id = ?1",
        )?;
        let rows = stmt
            .query_map([anchor.id.as_str()], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let old_count = existing_hashes.len() as i64;
    if old_count > 0
        && existing_hashes
            .iter()
            .all(|h| h.as_deref() == Some(anchor_hash.as_str()))
    {
        // 幂等：同 anchor 同文本
        delete_extract_job(&tx, anchor_id)?;
        tx.commit()?;
        return Ok(0);
    }

    // 4–5. 回合消息 + provenance
    let messages = anchor::turn_messages(&tx, &anchor.chat_id, &anchor.id)?;
    let provenance = anchor::build_provenance(&anchor, &messages, &anchor_hash);
    let message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let user_message_id = messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.id.clone());

    // 6. 先算 chunk，再做软上限判断
    let chunks = anchor::semantic_chunks(&text);
    if chunks.is_empty() {
        delete_extract_job(&tx, anchor_id)?;
        tx.commit()?;
        return Ok(0);
    }
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM memory_shards", [], |r| r.get(0))?;
    let old_shard_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM memory_shards
         WHERE origin = 'conversation' AND anchor_message_id = ?1",
        [anchor.id.as_str()],
        |r| r.get(0),
    )?;
    if exceeds_soft_cap(total, old_shard_count, chunks.len() as i64) {
        // 保留旧 shard 不删，停止新建；stats 由 B 报 atCap（§3.2）
        delete_extract_job(&tx, anchor_id)?;
        tx.commit()?;
        return Ok(0);
    }

    // 7. 替换才删旧；新建直接插
    if old_shard_count > 0 {
        delete_anchor_shards_tx(&tx, Some(&anchor.chat_id), &[anchor.id.clone()])?;
    }

    let params = params_for("conversation");
    let mut created = 0i64;
    for (i, chunk) in chunks.iter().enumerate() {
        let key = format!("conv:{}:{}:{}", anchor.id, i, anchor_hash);
        let content_hash = compute_content_hash(chunk);
        let shard_id = insert_shard(
            &tx,
            NewShard {
                idempotency_key: &key,
                origin: "conversation",
                mem_type: "event",
                topic: "",
                category: "",
                content: chunk,
                content_hash: Some(&content_hash),
                confidence: 0.7,
                base_weight: params.base_weight,
                floor: params.floor,
                stability: params.s0,
                last_event_at: &anchor.created_at,
                state: "active",
                anchor_message_id: Some(&anchor.id),
                anchor_hash: Some(&anchor_hash),
                chat_id: Some(&anchor.chat_id),
                user_message_id: user_message_id.as_deref(),
                provenance_json: provenance.clone(),
                supersedes: None,
                dream_action: None,
                source_chat_id: Some(&anchor.chat_id),
                source_message_ids: message_ids.clone(),
                legacy_memory_id: None,
                legacy_active_count: 0,
                legacy_last_used_at: None,
                created_at: &now,
                updated_at: &now,
            },
        )?;
        if shard_id == 0 {
            // 幂等键已存在（并发 drain）：不重复写 history / job
            continue;
        }
        history::append(
            &tx,
            shard_id,
            NewHistory {
                at: &now,
                event: "birth",
                stability: params.s0,
                base_weight: params.base_weight,
                floor: params.floor,
                factor: 1.0,
                rank: None,
                hits_30d: None,
                origin: "conversation",
                run_id: "",
                note: "",
            },
        )?;
        enqueue_embed(&tx, shard_id, &now)?;
        // conversation shard 也进 kb_docs 镜像：search_knowledge(sources=['memory']) 可见
        index::mark_dirty(&tx, "memory", &shard_id.to_string())?;
        created += 1;
    }

    delete_extract_job(&tx, anchor_id)?;
    tx.commit()?;
    Ok(created)
}

/// 跨设备对账（§3.2）：
/// 1. `anchor::backfill_missing(recent_days)` 给同步进来的新消息补 anchor；
/// 2. 删 anchor 不存在/已移动的 conversation shard；
/// 3. curated 的悬空锚点置 NULL（「查看原文」不再跳到不存在的消息）；
/// 4. 最近 N 天、有可读文本、没有 shard 或 anchor_hash 不一致的 anchor 各投一个 extract job。
///
/// 返回「删除的 shard 数 + 补投的 job 数」。
pub fn reconcile_conversation_shards(conn: &Connection, recent_days: i64) -> Result<i64> {
    let _backfilled = anchor::backfill_missing(conn, recent_days)?;

    let tx = conn.unchecked_transaction()?;
    let mut affected = 0i64;

    // 2. 孤儿 / 锚点已移动
    let pairs: Vec<(String, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT s.anchor_message_id, s.chat_id
             FROM memory_shards s
             LEFT JOIN ai_chat_messages m ON m.id = s.anchor_message_id
             WHERE s.origin = 'conversation'
               AND s.anchor_message_id IS NOT NULL
               AND (m.id IS NULL OR m.anchor_id IS NULL OR m.anchor_id != m.id)",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for (anchor_id, chat_id) in pairs {
        affected += delete_anchor_shards_tx(&tx, chat_id.as_deref(), &[anchor_id])?;
    }

    // 3. curated 悬空锚点置 NULL
    affected += tx.execute(
        "UPDATE memory_shards
         SET anchor_message_id = NULL, user_message_id = NULL
         WHERE origin != 'conversation'
           AND anchor_message_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM ai_chat_messages m WHERE m.id = memory_shards.anchor_message_id
           )",
        [],
    )? as i64;

    // 4. 最近 N 天可读 anchor：没 shard 或 hash 不一致 → 补投 extract
    let anchors: Vec<(String, String, String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT m.id, m.chat_id, m.kind, COALESCE(m.text,'')
             FROM ai_chat_messages m
             WHERE m.anchor_id = m.id AND m.role = 'assistant'
               AND julianday(m.created_at) >= julianday('now', ?1)
               AND (
                 (m.kind IN ('text','analysis') AND TRIM(COALESCE(m.text,'')) <> '')
                 OR (m.kind = 'food-parse' AND TRIM(COALESCE(m.text,'')) <> '')
               )",
        )?;
        let rows = stmt
            .query_map([format!("-{recent_days} days")], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let now = Utc::now().to_rfc3339();
    for (anchor_id, chat_id, kind, text) in anchors {
        let hash = index::content_hash(&[text.trim(), &kind]);
        let hashes: Vec<Option<String>> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT anchor_hash FROM memory_shards
                 WHERE origin = 'conversation' AND anchor_message_id = ?1",
            )?;
            let rows = stmt
                .query_map([anchor_id.as_str()], |r| r.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let needs = hashes.is_empty()
            || hashes
                .iter()
                .any(|h| h.as_deref() != Some(hash.as_str()));
        if needs {
            enqueue_extract(&tx, &chat_id, &anchor_id, &now)?;
            affected += 1;
        }
    }

    tx.commit()?;
    Ok(affected)
}

/* ---------- 维护与 legacy ---------- */

/// 维护页清空长期记忆：jobs/dream_runs/history/shards +
/// kb_vectors/kb_chunks/kb_docs(source_type='memory') + kb_dirty（附录 A）。
///
/// 该层用原始 DELETE，维护页路径 `foreign_keys OFF`，所以 kb_docs 及其派生必须显式删。
pub fn clear_all(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM memory_jobs", [])?;
    tx.execute("DELETE FROM memory_dream_runs", [])?;
    tx.execute("DELETE FROM memory_shard_history", [])?;
    tx.execute("DELETE FROM memory_shards", [])?;
    tx.execute(
        "DELETE FROM kb_vectors WHERE chunk_id IN (
           SELECT c.id FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
           WHERE d.source_type = 'memory'
         )",
        [],
    )?;
    tx.execute(
        "DELETE FROM kb_chunks WHERE doc_id IN (
           SELECT id FROM kb_docs WHERE source_type = 'memory'
         )",
        [],
    )?;
    tx.execute("DELETE FROM kb_docs WHERE source_type = 'memory'", [])?;
    tx.execute("DELETE FROM kb_dirty WHERE source_type = 'memory'", [])?;
    tx.commit()?;
    Ok(())
}

/// 旧 `kb_memories` → shard 的一次性回填（content_hash + anchor 解析；app_meta 幂等）（§2.3 / 附录 A）。
///
/// 0054 已做纯列映射并把 `content_hash` 留 NULL；这里补 hash（`UPDATE OR IGNORE`：
/// 与已有 manual shard 撞唯一索引时保持 NULL，不阻塞启动），并从 `source_message_ids`
/// 里倒序找最后一条 assistant 消息填 `anchor_message_id`。`app_meta` 标记保证只跑一次。
pub fn backfill_legacy(conn: &Connection) -> Result<()> {
    if db::meta_get(conn, LEGACY_BACKFILL_KEY).as_deref() == Some("1") {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;

    let need_hash: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, content FROM memory_shards
             WHERE legacy_memory_id IS NOT NULL AND content_hash IS NULL",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for (id, content) in need_hash {
        let hash = compute_content_hash(&content);
        tx.execute(
            "UPDATE OR IGNORE memory_shards SET content_hash = ?2 WHERE id = ?1",
            rusqlite::params![id, hash],
        )?;
    }

    let need_anchor: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, source_message_ids FROM memory_shards
             WHERE legacy_memory_id IS NOT NULL
               AND anchor_message_id IS NULL
               AND source_message_ids IS NOT NULL
               AND source_message_ids <> '[]'",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for (shard_id, raw) in need_anchor {
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let candidates: Vec<&str> = items.iter().filter_map(|v| v.as_str()).collect();
        for cand in candidates.iter().rev() {
            let is_assistant: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM ai_chat_messages WHERE id = ?1 AND role = 'assistant'",
                    [cand],
                    |r| r.get(0),
                )
                .optional()?;
            if is_assistant.is_some() {
                tx.execute(
                    "UPDATE memory_shards SET anchor_message_id = ?2 WHERE id = ?1",
                    rusqlite::params![shard_id, cand],
                )?;
                break;
            }
        }
    }

    db::meta_set(&tx, LEGACY_BACKFILL_KEY, "1")?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn seed_chat(conn: &Connection) -> &'static str {
        conn.execute(
            "INSERT INTO ai_chats(id, title, created_at, updated_at)
             VALUES ('chat','t','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();
        "chat"
    }

    fn ins_msg(conn: &Connection, id: &str, seq: i64, role: &str, kind: &str, text: Option<&str>) {
        conn.execute(
            "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, payload, created_at)
             VALUES (?1,'chat',?2,?3,?4,?5,NULL,'2026-01-02T00:00:00+00:00')",
            rusqlite::params![id, seq, role, kind, text],
        )
        .unwrap();
    }

    fn set_anchor(conn: &Connection, anchor: &str, from: i64, to: i64) {
        conn.execute(
            "UPDATE ai_chat_messages SET anchor_id = ?1 WHERE seq >= ?2 AND seq <= ?3",
            rusqlite::params![anchor, from, to],
        )
        .unwrap();
    }

    fn new_manual<'a>(key: &'a str, content: &'a str, now: &'a str) -> NewShard<'a> {
        let params = params_for("manual_write");
        NewShard {
            idempotency_key: key,
            origin: "manual_write",
            mem_type: "preference",
            topic: "",
            category: "",
            content,
            content_hash: None,
            confidence: 0.7,
            base_weight: params.base_weight,
            floor: params.floor,
            stability: params.s0,
            last_event_at: now,
            state: "active",
            anchor_message_id: None,
            anchor_hash: None,
            chat_id: None,
            user_message_id: None,
            provenance_json: json!({}),
            supersedes: None,
            dream_action: None,
            source_chat_id: None,
            source_message_ids: Vec::new(),
            legacy_memory_id: None,
            legacy_active_count: 0,
            legacy_last_used_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn insert(conn: &Connection, new: NewShard<'_>) -> i64 {
        let tx = conn.unchecked_transaction().unwrap();
        let id = insert_shard(&tx, new).unwrap();
        tx.commit().unwrap();
        id
    }

    #[test]
    fn params_bind_per_origin_and_floor_weight_is_base_times_floor() {
        assert_eq!(
            params_for("conversation"),
            ShardParams {
                base_weight: 1.0,
                floor: 0.05,
                s0: 3.0
            }
        );
        assert_eq!(
            params_for("dream_summary"),
            ShardParams {
                base_weight: 2.0,
                floor: 0.10,
                s0: 10.0
            }
        );
        assert_eq!(
            params_for("manual_write"),
            ShardParams {
                base_weight: 2.5,
                floor: 0.15,
                s0: 20.0
            }
        );
        assert_eq!(
            params_for("marked_important"),
            ShardParams {
                base_weight: 4.0,
                floor: 0.35,
                s0: 90.0
            }
        );
        // 未知 origin 收敛 manual 档
        assert_eq!(params_for("whatever").base_weight, 2.5);
        assert_eq!(params_for("whatever").floor, 0.15);

        // 地板权重：manual 0.375、marked 1.4、dream 0.20、conversation 0.05
        assert!((2.5f64 * 0.15 - 0.375).abs() < 1e-12);
        assert!((4.0f64 * 0.35 - 1.4).abs() < 1e-12);
        assert!((2.0f64 * 0.10 - 0.20).abs() < 1e-12);
        assert!((1.0f64 * 0.05 - 0.05).abs() < 1e-12);
    }

    #[test]
    fn normalize_type_and_category_follow_memory_rules() {
        assert_eq!(normalize_type("preference"), "preference");
        assert_eq!(normalize_type(" event "), "event");
        assert_eq!(normalize_type("自造类型"), "preference");
        assert_eq!(normalize_category(" 健康 / 训练 "), "健康/训练");
        assert_eq!(normalize_category("a/b/c"), "a/b", "最多两层");
        assert_eq!(normalize_category(""), "");
    }

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        let a = compute_content_hash("喜欢浅烘咖啡");
        let b = compute_content_hash("喜欢浅烘咖啡");
        let c = compute_content_hash("喜欢深烘咖啡");
        assert_eq!(a, b, "同内容 hash 必须稳定");
        assert_ne!(a, c, "改一个字 hash 必须变");
        assert_eq!(a.len(), 16, "FNV-1a 64 hex");
        assert_eq!(a, index::content_hash(&["喜欢浅烘咖啡"]));
    }

    #[test]
    fn insert_get_list_roundtrip_binds_quotes_and_unicode() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let id = insert(
            &conn,
            new_manual("manual:1", "O'Reilly 说：\"咖啡\" 要 90℃", now),
        );
        assert!(id > 0);

        let got = get_shard(&conn, id).unwrap().unwrap();
        assert_eq!(got.content, "O'Reilly 说：\"咖啡\" 要 90℃");
        assert_eq!(got.origin, "manual_write");
        assert!(get_shard(&conn, 9999).unwrap().is_none());

        let list = list_shards(&conn, "active", None, 50, 0).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert!(list_shards(&conn, "dormant", None, 50, 0).unwrap().is_empty());

        // 内容里带引号/反斜杠也必须能再次写入（参数绑定不是字符串拼接）
        let id2 = insert(
            &conn,
            new_manual("manual:2", "path\\to\\file 'x' -- ; DROP", now),
        );
        assert!(id2 > 0);
    }

    #[test]
    fn insert_shard_is_idempotent_on_key_and_manual_hash() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let mut a = new_manual("manual:same", "同一条", now);
        a.content_hash = Some("h1");
        assert!(insert(&conn, a) > 0);

        // 同 key：直接 0
        let mut again = new_manual("manual:same", "同一条", now);
        again.content_hash = Some("h1");
        assert_eq!(insert(&conn, again), 0);

        // 不同 key、同 origin+content_hash（未合并）：manual 局部唯一索引命中 → 0
        let mut dup = new_manual("manual:other", "同一条", now);
        dup.content_hash = Some("h1");
        assert_eq!(insert(&conn, dup), 0, "manual 按内容幂等");

        // conversation 允许同文重复（不同 anchor 各自有溯源）
        let mut c1 = new_manual("conv:1", "同一条", now);
        c1.origin = "conversation";
        c1.mem_type = "event";
        c1.content_hash = Some("h1");
        let mut c2 = c1.clone();
        c2.idempotency_key = "conv:2";
        assert!(insert(&conn, c1) > 0);
        assert!(insert(&conn, c2) > 0);
    }

    #[test]
    fn list_filters_scope_origin_and_excludes_consolidated() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let active = insert(&conn, new_manual("a", "活跃", now));
        let mut dormant = new_manual("d", "休眠", now);
        dormant.state = "dormant";
        dormant.origin = "dream_summary";
        let dormant = insert(&conn, dormant);
        let mut archived = new_manual("z", "归档", now);
        archived.state = "archived";
        let archived = insert(&conn, archived);
        let mut conv = new_manual("c", "会话", now);
        conv.origin = "conversation";
        conv.mem_type = "event";
        let conv_id = insert(&conn, conv);
        let mut merged = new_manual("m", "已合并", now);
        merged.origin = "dream_summary";
        let merged = insert(&conn, merged);
        conn.execute(
            "UPDATE memory_shards SET consolidated_into=?1 WHERE id=?1",
            [merged],
        )
        .unwrap();

        let ids = |v: Vec<MemoryShard>| v.into_iter().map(|s| s.id).collect::<Vec<_>>();
        // 两条 active 的 updated_at 相同，组内 id DESC → 后插入的 conversation 在前
        assert_eq!(
            ids(list_shards(&conn, "active", None, 50, 0).unwrap()),
            vec![conv_id, active]
        );
        assert_eq!(ids(list_shards(&conn, "dormant", None, 50, 0).unwrap()), vec![dormant]);
        assert_eq!(ids(list_shards(&conn, "archived", None, 50, 0).unwrap()), vec![archived]);
        assert_eq!(
            ids(list_shards(&conn, "all", Some("curated"), 50, 0).unwrap()),
            vec![active, dormant, archived],
            "curated 排除 conversation 与已合并"
        );
        let conv_ids = ids(list_shards(&conn, "active", Some("conversation"), 50, 0).unwrap());
        assert_eq!(conv_ids, vec![conv_id], "origin 过滤只看 conversation");
        assert_eq!(
            ids(list_shards(&conn, "active", Some("dream_summary"), 50, 0).unwrap()),
            Vec::<i64>::new(),
            "dream_summary 的那条是 dormant，不在 active 里"
        );
        len_is(&ids(list_shards(&conn, "all", None, 50, 0).unwrap()), 4);
        // 未知 scope 收敛 active
        assert_eq!(
            ids(list_shards(&conn, "bogus", None, 50, 0).unwrap()),
            vec![conv_id, active]
        );
    }

    fn len_is(v: &[i64], n: usize) {
        assert_eq!(v.len(), n);
    }

    #[test]
    fn delete_shard_removes_merged_children_and_state_counts() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let parent = insert(&conn, new_manual("parent", "合并后", now));
        let mut child = new_manual("child", "被合并", now);
        child.content_hash = Some("hc");
        let child = insert(&conn, child);
        conn.execute(
            "UPDATE memory_shards SET consolidated_into=?1 WHERE id=?2",
            [parent, child],
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        history::append(
            &tx,
            child,
            NewHistory {
                at: now,
                event: "birth",
                stability: 2.0,
                base_weight: 1.0,
                floor: 0.10,
                factor: 1.0,
                origin: "dream_summary",
                ..Default::default()
            },
        )
        .unwrap();
        enqueue_embed(&tx, child, now).unwrap();
        tx.commit().unwrap();

        // state_counts 不含已合并 child
        assert_eq!(state_counts(&conn).unwrap(), (1, 0, 0, 1));

        assert!(delete_shard(&conn, parent).unwrap());
        assert!(get_shard(&conn, parent).unwrap().is_none());
        assert!(
            get_shard(&conn, child).unwrap().is_none(),
            "合并目标删除时必须先删 children，不能让他们被 ON DELETE SET NULL 复活"
        );
        assert_eq!(history::count_rows(&conn, child).unwrap(), 0);
        let jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE kind='embed' AND ref_id=CAST(?1 AS TEXT)",
                [child],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jobs, 0);
        assert!(!delete_shard(&conn, parent).unwrap(), "不存在的 id 返回 false");
        assert_eq!(state_counts(&conn).unwrap(), (0, 0, 0, 0));
    }

    #[test]
    fn state_counts_splits_three_states() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let _a = insert(&conn, new_manual("a", "活跃", now));
        let mut d = new_manual("d", "休眠", now);
        d.state = "dormant";
        let _d = insert(&conn, d);
        let mut z = new_manual("z", "归档", now);
        z.state = "archived";
        let _z = insert(&conn, z);
        assert_eq!(state_counts(&conn).unwrap(), (1, 1, 1, 3));
    }

    #[test]
    fn shard_delete_cascades_history_and_embed_job() {
        let conn = fresh();
        seed_chat(&conn);
        let now = "2026-01-02T00:00:00+00:00";
        ins_msg(&conn, "u1", 1, "user", "text", Some("问"));
        ins_msg(&conn, "a1", 2, "assistant", "text", Some("答"));
        set_anchor(&conn, "a1", 1, 2);

        let mut conv = new_manual("conv:1", "会话记忆", now);
        conv.origin = "conversation";
        conv.mem_type = "event";
        conv.anchor_message_id = Some("a1");
        conv.chat_id = Some("chat");
        let id = insert(&conn, conv);
        let mut tx = conn.unchecked_transaction().unwrap();
        history::append(
            &tx,
            id,
            NewHistory {
                at: now,
                event: "birth",
                stability: 3.0,
                base_weight: 1.0,
                floor: 0.05,
                factor: 1.0,
                origin: "conversation",
                ..Default::default()
            },
        )
        .unwrap();
        enqueue_embed(&tx, id, now).unwrap();
        let deleted = delete_conversation_shards_for_anchors(&tx, "chat", &["a1".to_string()]).unwrap();
        tx.commit().unwrap();
        assert_eq!(deleted, 1);
        assert!(get_shard(&conn, id).unwrap().is_none());
        assert_eq!(history::count_rows(&conn, id).unwrap(), 0, "history 必须被级联清理");
        let jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE kind='embed' AND ref_id=CAST(?1 AS TEXT)",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jobs, 0, "embed job 必须一起删");
    }

    #[test]
    fn history_fts_triggers_follow_content_updates() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let id = insert(&conn, new_manual("fts", "膝盖不舒服不要深蹲", now));
        let hit = |q: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM memory_shard_fts WHERE memory_shard_fts MATCH ?1",
                [q],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(hit("\"膝盖不舒服\""), 1);
        assert_eq!(hit("\"肩膀疼\""), 0);

        conn.execute(
            "UPDATE memory_shards SET content='肩膀疼不要推举' WHERE id=?1",
            [id],
        )
        .unwrap();
        assert_eq!(hit("\"膝盖不舒服\""), 0, "旧正文必须从 FTS 摘掉");
        assert_eq!(hit("\"肩膀疼\""), 1, "新正文必须进 FTS");

        conn.execute("DELETE FROM memory_shards WHERE id=?1", [id])
            .unwrap();
        assert_eq!(hit("\"肩膀疼\""), 0, "删除必须维护 FTS");
    }

    #[test]
    fn backfill_legacy_hash_anchor_and_once() {
        let conn = fresh();
        seed_chat(&conn);
        ins_msg(&conn, "m1", 1, "user", "text", Some("旧问"));
        ins_msg(&conn, "m2", 2, "assistant", "text", Some("旧答"));
        ins_msg(&conn, "m3", 3, "assistant", "text", Some("最后答"));
        // 模拟 0054 已映射、content_hash 待补、anchor 待解析的行
        conn.execute(
            "INSERT INTO memory_shards
               (idempotency_key, origin, mem_type, content, base_weight, floor, stability,
                last_event_at, state, provenance_json, source_chat_id, source_message_ids,
                legacy_memory_id, legacy_active_count, created_at, updated_at)
             VALUES ('legacy:7','manual_write','preference','旧记忆',2.0,0.10,10.0,
                     '2026-01-01 00:00:00','active','{\"legacy\":1}','chat',
                     '[\"m1\",\"m2\",\"m3\",\"gone\"]',7,3,
                     '2026-01-01 00:00:00','2026-01-01 00:00:00')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        backfill_legacy(&conn).unwrap();
        let (hash, anchor): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT content_hash, anchor_message_id FROM memory_shards WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(hash.as_deref(), Some(compute_content_hash("旧记忆").as_str()));
        assert_eq!(
            anchor.as_deref(),
            Some("m3"),
            "倒序找 source_message_ids 里最后一条 assistant"
        );
        assert_eq!(
            db::meta_get(&conn, LEGACY_BACKFILL_KEY).as_deref(),
            Some("1")
        );

        // 第二次调用直接返回：改掉 content 也不会被重新 hash
        conn.execute(
            "UPDATE memory_shards SET content='改过', content_hash=NULL WHERE id=?1",
            [id],
        )
        .unwrap();
        backfill_legacy(&conn).unwrap();
        let hash: Option<String> = conn
            .query_row("SELECT content_hash FROM memory_shards WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(hash, None, "app_meta 幂等标记保证只跑一次");
    }

    #[test]
    fn enqueue_extract_is_per_anchor_and_drain_processes_multiple_terminals() {
        let conn = fresh();
        seed_chat(&conn);
        ins_msg(&conn, "u1", 1, "user", "text", Some("第一问"));
        ins_msg(&conn, "a1", 2, "assistant", "text", Some("第一答"));
        set_anchor(&conn, "a1", 1, 2);
        ins_msg(&conn, "u2", 3, "user", "text", Some("第二问"));
        ins_msg(&conn, "a2", 4, "assistant", "text", Some("第二答"));
        set_anchor(&conn, "a2", 3, 4);

        let now = "2026-01-02T00:00:00+00:00";
        enqueue_extract(&conn, "chat", "a1", now).unwrap();
        enqueue_extract(&conn, "chat", "a2", now).unwrap();
        let jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE kind='extract'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jobs, 2, "同一 chat 的多个 terminal 必须各有 job");

        // 把 3 秒防抖拨到过去，再 drain
        conn.execute(
            "UPDATE memory_jobs SET not_before='2000-01-01T00:00:00+00:00'",
            [],
        )
        .unwrap();
        let processed = drain_extract(&conn, 5000).unwrap();
        assert_eq!(processed, 2);

        let shards: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_shards WHERE origin='conversation'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(shards, 2, "两个 terminal 各生成一条 shard");
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_jobs WHERE kind='extract'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn process_extract_builds_chunks_birth_provenance_and_jobs() {
        let conn = fresh();
        seed_chat(&conn);
        let long = "很长的回答。".repeat(400); // 2400 字 → 2 chunk
        ins_msg(&conn, "u1", 1, "user", "text", Some("我的偏好"));
        conn.execute(
            "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, payload, created_at)
             VALUES ('a1','chat',2,'assistant','text',?1,?2,'2026-01-02T00:00:00+00:00')",
            rusqlite::params![
                long,
                json!({
                    "thinking": "用户喜欢浅烘",
                    "segments": [
                        {"kind":"reasoning","text":"先回忆"},
                        {"kind":"tool","call":{"toolName":"search_memories","result":"ok","pending":false,"isError":false,"arguments":"{}"}},
                        {"kind":"tool","call":{"toolName":"broken","pending":false,"isError":true,"result":"boom","arguments":"{}"}}
                    ]
                })
                .to_string()
            ],
        )
        .unwrap();
        set_anchor(&conn, "a1", 1, 2);

        let created = process_extract(&conn, "a1").unwrap();
        assert_eq!(created, 2, "2400 字按 1800 字切成 2 块");

        let rows: Vec<(i64, String, String, f64, f64, f64, String, Option<String>, Option<String>, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, origin, mem_type, base_weight, floor, stability, state,
                            anchor_message_id, user_message_id, provenance_json
                     FROM memory_shards ORDER BY id",
                )
                .unwrap();
            stmt.query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };
        assert_eq!(rows.len(), 2);
        for (id, origin, mem_type, base, floor, stability, state, anchor, user, prov) in &rows {
            assert_eq!(origin, "conversation");
            assert_eq!(mem_type, "event");
            assert_eq!((*base, *floor, *stability), (1.0, 0.05, 3.0));
            assert_eq!(state, "active");
            assert_eq!(anchor.as_deref(), Some("a1"));
            assert_eq!(user.as_deref(), Some("u1"));
            assert_eq!(history::count_rows(&conn, *id).unwrap(), 1, "每条 shard 一条 birth");
            let p: Value = serde_json::from_str(prov).unwrap();
            assert!(p["reasoningDigest"].as_str().unwrap().contains("用户喜欢浅烘"));
            assert_eq!(p["toolCalls"].as_array().unwrap().len(), 2);
            assert_eq!(p["toolCalls"][0]["ok"], true);
            assert_eq!(p["toolCalls"][1]["ok"], false);
            assert_eq!(p["anchorSeq"], 2);
            assert_eq!(p["userText"], "我的偏好");
            assert_eq!(p["messageIds"].as_array().unwrap().len(), 2);
        }
        let births: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_shard_history WHERE event='birth'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(births, 2);
        let embed_jobs: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_jobs WHERE kind='embed'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(embed_jobs, 2);
        let dirty: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_dirty WHERE source_type='memory'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dirty, 2, "conversation shard 也要进 kb_docs 镜像");
        let extract: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_jobs WHERE kind='extract'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(extract, 0);
    }

    #[test]
    fn process_extract_is_idempotent_on_same_anchor_hash() {
        let conn = fresh();
        seed_chat(&conn);
        ins_msg(&conn, "u1", 1, "user", "text", Some("问"));
        ins_msg(&conn, "a1", 2, "assistant", "text", Some("答"));
        set_anchor(&conn, "a1", 1, 2);

        assert_eq!(process_extract(&conn, "a1").unwrap(), 1);
        assert_eq!(process_extract(&conn, "a1").unwrap(), 0, "同 hash 不重建");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_shards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn process_extract_rebuilds_when_anchor_text_changes() {
        let conn = fresh();
        seed_chat(&conn);
        ins_msg(&conn, "u1", 1, "user", "text", Some("问"));
        ins_msg(&conn, "a1", 2, "assistant", "text", Some("第一版回答"));
        set_anchor(&conn, "a1", 1, 2);
        assert_eq!(process_extract(&conn, "a1").unwrap(), 1);
        let old_id: i64 = conn
            .query_row("SELECT id FROM memory_shards", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "UPDATE ai_chat_messages SET text='第二版回答' WHERE id='a1'",
            [],
        )
        .unwrap();
        assert_eq!(process_extract(&conn, "a1").unwrap(), 1, "hash 变了必须重建");
        let (id, content): (i64, String) = conn
            .query_row("SELECT id, content FROM memory_shards", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_ne!(id, old_id, "旧 shard 必须被删，新 shard 是新行");
        assert_eq!(content, "第二版回答");
        let old_embed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE kind='embed' AND ref_id=CAST(?1 AS TEXT)",
                [old_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_embed, 0, "旧 shard 的 embed job 必须清掉");
    }

    #[test]
    fn process_extract_skips_food_parse_only_and_cleans_old_shards() {
        let conn = fresh();
        seed_chat(&conn);
        ins_msg(&conn, "u1", 1, "user", "text", Some("吃了什么"));
        ins_msg(&conn, "a1", 2, "assistant", "text", Some("食物卡正文"));
        set_anchor(&conn, "a1", 1, 2);
        assert_eq!(process_extract(&conn, "a1").unwrap(), 1);

        // 正文被 morph 成 food-parse 且 text=undefined：结构化卡片不是可读结论
        conn.execute(
            "UPDATE ai_chat_messages SET kind='food-parse', text=NULL WHERE id='a1'",
            [],
        )
        .unwrap();
        assert_eq!(process_extract(&conn, "a1").unwrap(), 0);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_shards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "旧 conversation shard 必须被删除");
    }

    #[test]
    fn process_extract_handles_missing_anchor_and_job() {
        let conn = fresh();
        seed_chat(&conn);
        // 消息存在但 anchor 已移动（anchor_id != id）
        ins_msg(&conn, "a1", 2, "assistant", "text", Some("答"));
        conn.execute("UPDATE ai_chat_messages SET anchor_id='other' WHERE id='a1'", [])
            .unwrap();
        enqueue_extract(&conn, "chat", "a1", "2026-01-02T00:00:00+00:00").unwrap();
        assert_eq!(process_extract(&conn, "a1").unwrap(), 0);
        let jobs: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_jobs WHERE kind='extract'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(jobs, 0, "无法处理的 anchor 必须删掉 job");
    }

    #[test]
    fn soft_cap_counts_replacement_not_double_delete() {
        assert!(!exceeds_soft_cap(TOTAL_SHARD_SOFT_CAP, 0, 0));
        assert!(!exceeds_soft_cap(TOTAL_SHARD_SOFT_CAP - 1, 0, 1));
        assert!(exceeds_soft_cap(TOTAL_SHARD_SOFT_CAP, 0, 1));
        // 替换：旧 2 条换成 2 条不增长
        assert!(!exceeds_soft_cap(TOTAL_SHARD_SOFT_CAP, 2, 2));
        // 替换：旧 2 条换成 3 条增长 1
        assert!(exceeds_soft_cap(TOTAL_SHARD_SOFT_CAP, 2, 3));
    }

    #[test]
    fn take_store_and_fail_embed_jobs() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let id = insert(&conn, new_manual("embed", "待嵌入", now));
        enqueue_embed(&conn, id, now).unwrap();

        let batch = take_embed_batch(&conn, 16).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].shard_id, id);
        assert_eq!(batch[0].content, "待嵌入");

        store_embeddings(&conn, "model-x", &[(id, vec![0.5, -1.25, 2.0])]).unwrap();
        let (dim, model, blob): (i64, String, Vec<u8>) = conn
            .query_row(
                "SELECT embedding_dim, embedding_model, embedding FROM memory_shards WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(dim, 3);
        assert_eq!(model, "model-x");
        let floats: Vec<f32> = blob
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        assert_eq!(floats, vec![0.5, -1.25, 2.0], "f32 LE BLOB");
        assert!(take_embed_batch(&conn, 16).unwrap().is_empty());

        // 失败退避：attempts=1、not_before=now+30s、last_error 写入
        enqueue_embed(&conn, id, now).unwrap();
        fail_embed_jobs(&conn, &[id], "onnx boom", now).unwrap();
        let (attempts, err, not_before): (i64, String, String) = conn
            .query_row(
                "SELECT attempts, last_error, not_before FROM memory_jobs
                 WHERE kind='embed' AND ref_id=CAST(?1 AS TEXT)",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(err, "onnx boom");
        assert_eq!(not_before, "2026-01-02T00:00:30+00:00");
    }

    #[test]
    fn enqueue_missing_embeddings_skips_pending_and_model_matches() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let a = insert(&conn, new_manual("a", "无向量", now));
        let mut b = new_manual("b", "旧模型", now);
        b.content_hash = Some("hb");
        let b = insert(&conn, b);
        conn.execute(
            "UPDATE memory_shards SET embedding=X'00', embedding_model='old', embedding_dim=1 WHERE id=?1",
            [b],
        )
        .unwrap();
        let mut c = new_manual("c", "当前模型", now);
        c.content_hash = Some("hc");
        let _c = insert(&conn, c);
        conn.execute(
            "UPDATE memory_shards SET embedding=X'00', embedding_model='model-x', embedding_dim=1 WHERE id=?1",
            [_c],
        )
        .unwrap();

        let n = enqueue_missing_embeddings(&conn, "model-x", 100).unwrap();
        assert_eq!(n, 2, "只补 NULL/模型不匹配的两条");
        let jobs: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT ref_id FROM memory_jobs WHERE kind='embed' ORDER BY ref_id")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(jobs, vec![a.to_string(), b.to_string()]);

        // 已有 job 的 shard 不重复投递（不重置失败退避）
        assert_eq!(enqueue_missing_embeddings(&conn, "model-x", 100).unwrap(), 0);
    }

    #[test]
    fn clear_all_removes_memory_layer_and_mirror() {
        let conn = fresh();
        let now = "2026-01-02T00:00:00+00:00";
        let id = insert(&conn, new_manual("a", "清空我", now));
        let mut tx = conn.unchecked_transaction().unwrap();
        history::append(
            &tx,
            id,
            NewHistory {
                at: now,
                event: "birth",
                stability: 20.0,
                base_weight: 2.5,
                floor: 0.15,
                factor: 1.0,
                origin: "manual_write",
                ..Default::default()
            },
        )
        .unwrap();
        enqueue_embed(&tx, id, now).unwrap();
        tx.commit().unwrap();
        conn.execute(
            "INSERT INTO memory_dream_runs(id, started_at, status) VALUES ('r1', ?1, 'done')",
            [now],
        )
        .unwrap();
        // 模拟 kb_docs 镜像 + 分块 + 向量 + 脏标记
        conn.execute(
            "INSERT INTO kb_docs(source_type, source_id, title, summary, body, content_hash, updated_at)
             VALUES ('memory', CAST(?1 AS TEXT), 'x', '', '清空我', 'h', ?2)",
            rusqlite::params![id, now],
        )
        .unwrap();
        let doc = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO kb_chunks(doc_id, ord, text) VALUES (?1, 0, '清空我')",
            [doc],
        )
        .unwrap();
        let chunk = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO kb_vectors(chunk_id, model_id, dim, vec, updated_at)
             VALUES (?1, 'm', 1, X'00000000', ?2)",
            rusqlite::params![chunk, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO kb_dirty(source_type, source_id, op, at)
             VALUES ('memory', CAST(?1 AS TEXT), 'upsert', ?2)",
            rusqlite::params![id, now],
        )
        .unwrap();

        clear_all(&conn).unwrap();

        for (table, sql) in [
            ("memory_shards", "SELECT COUNT(*) FROM memory_shards"),
            ("memory_shard_history", "SELECT COUNT(*) FROM memory_shard_history"),
            ("memory_jobs", "SELECT COUNT(*) FROM memory_jobs"),
            ("memory_dream_runs", "SELECT COUNT(*) FROM memory_dream_runs"),
            ("kb_docs(memory)", "SELECT COUNT(*) FROM kb_docs WHERE source_type='memory'"),
            ("kb_chunks(memory)", "SELECT COUNT(*) FROM kb_chunks c JOIN kb_docs d ON d.id=c.doc_id WHERE d.source_type='memory'"),
            ("kb_vectors(memory)", "SELECT COUNT(*) FROM kb_vectors v JOIN kb_chunks c ON c.id=v.chunk_id JOIN kb_docs d ON d.id=c.doc_id WHERE d.source_type='memory'"),
            ("kb_dirty(memory)", "SELECT COUNT(*) FROM kb_dirty WHERE source_type='memory'"),
        ] {
            let n: i64 = conn.query_row(sql, [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table} 清空后不应有残留");
        }
    }

    #[test]
    fn reconcile_removes_orphan_and_nulls_dangling_curated_anchor() {
        let conn = fresh();
        seed_chat(&conn);
        let now = "2026-01-02T00:00:00+00:00";
        ins_msg(&conn, "u1", 1, "user", "text", Some("问"));
        ins_msg(&conn, "a1", 2, "assistant", "text", Some("答"));
        // 落在 30 天窗口外：reconcile 的 backfill_missing 不应把它重新补锚
        conn.execute(
            "UPDATE ai_chat_messages SET created_at = datetime('now','-60 days')",
            [],
        )
        .unwrap();
        set_anchor(&conn, "a1", 1, 2);

        let mut conv = new_manual("conv:1", "会话记忆", now);
        conv.origin = "conversation";
        conv.mem_type = "event";
        conv.anchor_message_id = Some("a1");
        conv.chat_id = Some("chat");
        let conv_id = insert(&conn, conv);
        let mut curated = new_manual("cur:1", "手工记忆", now);
        curated.anchor_message_id = Some("a1");
        curated.chat_id = Some("chat");
        let _curated_id = insert(&conn, curated);

        // 另一台设备撤回 a1 的回合：消息还在但 anchor 已移动；再加一条完全不存在的 anchor
        conn.execute("UPDATE ai_chat_messages SET anchor_id=NULL WHERE id='a1'", [])
            .unwrap();
        let mut orphan = new_manual("conv:2", "孤儿", now);
        orphan.origin = "conversation";
        orphan.mem_type = "event";
        orphan.anchor_message_id = Some("missing");
        orphan.chat_id = Some("chat");
        let orphan_id = insert(&conn, orphan);
        // curated 指向不存在的消息
        conn.execute(
            "UPDATE memory_shards SET anchor_message_id='missing' WHERE id=?1",
            [_curated_id],
        )
        .unwrap();

        reconcile_conversation_shards(&conn, 30).unwrap();

        assert!(get_shard(&conn, conv_id).unwrap().is_none(), "锚点已移动的 conversation shard 必须删");
        assert!(get_shard(&conn, orphan_id).unwrap().is_none(), "孤儿 conversation shard 必须删");
        let curated = get_shard(&conn, _curated_id).unwrap().unwrap();
        assert_eq!(curated.anchor_message_id, None, "curated 悬空锚点置 NULL");
        assert_eq!(curated.user_message_id, None);
    }

    #[test]
    fn reconcile_enqueues_extract_for_recent_anchor_without_shard() {
        let conn = fresh();
        seed_chat(&conn);
        ins_msg(&conn, "u1", 1, "user", "text", Some("新同步的问题"));
        conn.execute(
            "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, created_at)
             VALUES ('a1','chat',2,'assistant','text','新同步的回答',datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute("UPDATE ai_chat_messages SET anchor_id='a1' WHERE seq IN (1,2)", [])
            .unwrap();

        let affected = reconcile_conversation_shards(&conn, 30).unwrap();
        assert!(affected >= 1);
        let jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE kind='extract' AND ref_id='a1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jobs, 1, "最近 30 天、有可读文本、没有 shard 的 anchor 应补投 extract");
    }

    #[test]
    fn time_ordering_uses_julianday_for_mixed_formats() {
        let conn = fresh();
        let a = insert(
            &conn,
            new_manual("a", "A", "2026-01-01T23:00:00+00:00"),
        );
        let b = insert(&conn, new_manual("b", "B", "2026-01-01 23:30:00"));
        // A 的 RFC3339 在字典序上更大（'T' 0x54 > 空格 0x20），但真实时间更早。
        conn.execute(
            "UPDATE memory_shards SET updated_at='2026-01-01T23:00:00+00:00' WHERE id=?1",
            [a],
        )
        .unwrap();
        conn.execute(
            "UPDATE memory_shards SET updated_at='2026-01-01 23:30:00' WHERE id=?1",
            [b],
        )
        .unwrap();

        let list = list_shards(&conn, "active", None, 50, 0).unwrap();
        assert_eq!(list[0].id, b, "真实时间更新的 B 必须排在字典序更大的 A 前面");
        assert_eq!(list[1].id, a);

        // 字符串排序会选错的场景：MAX(last_event_at) 选 A，julianday 排序选 B。
        let string_max: String = conn
            .query_row(
                "SELECT MAX(last_event_at) FROM memory_shards",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(string_max, "2026-01-01T23:00:00+00:00");
        let real_max: String = conn
            .query_row(
                "SELECT last_event_at FROM memory_shards
                 ORDER BY julianday(last_event_at) DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(real_max, "2026-01-01 23:30:00", "时间截断必须用 julianday");
    }
}
