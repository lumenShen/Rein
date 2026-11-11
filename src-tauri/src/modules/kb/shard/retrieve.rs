//! 主动检索：候选、排序、强化与重复对（§5.2–§5.4 / 附录 D）。
//!
//! 与注入的区别：检索是「命中才续命」，会写 `search_hit`；但必须通过 §5.3 的四道硬门控。
//! FTS 必须复用 `search::match_expr` / `search::too_short_for_trigram`（B 域只改可见性）。
//!
//! 降级阶梯（§5.4）：
//! - 有查询向量：余弦 + FTS(0.70) + LIKE(0.55) 并集，同一 shard 取 max；
//! - 无向量：≥3 字走 FTS，2 字走 LIKE，1 字/空查询只按权重；
//! - FTS 构建/执行错误一律降级 LIKE，不让 `memory_shard_search` 整体失败。

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::modules::kb::search::{match_expr, too_short_for_trigram};

use super::history;
use super::model::{MemoryDuplicate, MemorySearchHit, MemoryShard};
use super::store;

/// 关键词命中的最低相关性（FTS 0.70 / LIKE 0.55 之外，强化门槛 0.60）（§4.2 / §5.2）。
pub const RELEVANCE_THRESHOLD: f64 = 0.60;
/// 默认 topK（§4.2 / §7.1）。
pub const SEARCH_TOP_K: usize = 8;
/// FTS/关键词候选上限（§4.2）。
pub const SEARCH_CANDIDATES: i64 = 50;
/// 向量/权重候选上限（§5.1 / §4.2）。
pub const CANDIDATE_LIMIT: i64 = 5000;
/// search_hit 的基础增幅（§5.2）。
pub const ALPHA_BASE: f64 = 0.8;
/// 30 天内命中 ≥ `REDUCED_AFTER_HITS` 后的降档增幅（§5.2）。
pub const ALPHA_REDUCED: f64 = 0.4;
/// 降档阈值（§4.2）。
pub const REDUCED_AFTER_HITS: i64 = 5;
/// 命中统计窗口（天）（§4.2）。
pub const HIT_WINDOW_DAYS: i64 = 30;
/// 30 天内命中硬上限；达到后不再写 search_hit（§5.2）。
pub const MAX_HITS_30D: i64 = 10;
/// 只强化 top 3（§5.3）。
pub const REINFORCE_MAX_HITS: usize = 3;
/// 同一 shard 的强化冷却（秒）（§5.3）。
pub const SEARCH_HIT_COOLDOWN_SECONDS: i64 = 600;
/// 关键词模式写强化所需的最小 query 字符数（§5.2）。
pub const REINFORCE_MIN_QUERY_CHARS: usize = 3;
/// 显式 `reviveArchived=true` 时 archived 复活的最低相关性（§5.2）。
pub const ARCHIVED_REVIVE_RELEVANCE: f64 = 0.75;
/// 查重扫描候选上限（O(400²)）（§4.2 / 附录 D）。
pub const DUP_SCAN_LIMIT: i64 = 400;

/// `memory_shards` 读列表：**顺序固定**，本模块与 `inject` 共用。
///
/// 不用 `SELECT *`：表里还有 embedding 等大列，且列顺序变化不应影响读模型。
pub(crate) const SHARD_COLS: &str = "id, origin, mem_type, topic, category, content, confidence, \
     base_weight, floor, stability, last_event_at, state, anchor_message_id, chat_id, \
     user_message_id, provenance_json, supersedes, consolidated_into, dream_action, \
     source_chat_id, created_at, updated_at, archived_at, archived_reason";

/// 把 [`SHARD_COLS`] 选出来的一行映射成读模型（`effective_weight` 按 `now` 读时计算）。
pub(crate) fn shard_from_row(
    r: &rusqlite::Row<'_>,
    now: DateTime<Utc>,
) -> rusqlite::Result<MemoryShard> {
    let provenance_raw: String = r.get(15)?;
    let mut shard = MemoryShard {
        id: r.get(0)?,
        origin: r.get(1)?,
        mem_type: r.get(2)?,
        topic: r.get(3)?,
        category: r.get(4)?,
        content: r.get(5)?,
        confidence: r.get(6)?,
        base_weight: r.get(7)?,
        floor: r.get(8)?,
        stability: r.get(9)?,
        last_event_at: r.get(10)?,
        state: r.get(11)?,
        anchor_message_id: r.get(12)?,
        chat_id: r.get(13)?,
        user_message_id: r.get(14)?,
        provenance: serde_json::from_str(&provenance_raw).unwrap_or_else(|_| serde_json::json!({})),
        supersedes: r.get(16)?,
        consolidated_into: r.get(17)?,
        dream_action: r.get(18)?,
        source_chat_id: r.get(19)?,
        created_at: r.get(20)?,
        updated_at: r.get(21)?,
        archived_at: r.get(22)?,
        archived_reason: r.get(23)?,
        effective_weight: 0.0,
    };
    shard.effective_weight = super::decay::effective_weight(&shard, now);
    Ok(shard)
}

/// 候选 shard + 已落库向量（有则参与余弦）。
pub(crate) struct Candidate {
    pub shard: MemoryShard,
    pub embedding: Option<Vec<f32>>,
    pub embedding_model: Option<String>,
}

/// 按状态过滤并取最近 `limit` 条候选。
///
/// 排序用 `julianday(last_event_at)`：兼容 RFC3339 与 SQLite `YYYY-MM-DD HH:MM:SS`
/// 两种格式（字符串比较会把 'T' 排到空格之后，§4.1）。
pub(crate) fn load_candidates(
    conn: &Connection,
    include_dormant: bool,
    include_archived: bool,
    limit: i64,
) -> Result<Vec<Candidate>> {
    let state_clause = match (include_archived, include_dormant) {
        (true, true) => "1 = 1",
        (true, false) => "state IN ('active', 'archived')",
        (false, true) => "state IN ('active', 'dormant')",
        (false, false) => "state = 'active'",
    };
    let sql = format!(
        "SELECT {SHARD_COLS}, embedding, embedding_model
         FROM memory_shards
         WHERE consolidated_into IS NULL AND {state_clause}
         ORDER BY julianday(last_event_at) DESC, id DESC
         LIMIT ?1"
    );
    let now = Utc::now();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(Candidate {
            shard: shard_from_row(r, now)?,
            embedding: parse_embedding(r.get::<_, Option<Vec<u8>>>(24)?),
            embedding_model: r.get(25)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// f32 LE BLOB → 向量；空/长度不是 4 的倍数视为无向量。
pub(crate) fn parse_embedding(blob: Option<Vec<u8>>) -> Option<Vec<f32>> {
    let blob = blob?;
    if blob.is_empty() || blob.len() % 4 != 0 {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// 余弦相似度。Embedder 的输出已 L2 归一化，点积即余弦；负相关按 0 处理。
pub(crate) fn cosine(a: &[f32], b: &[f32]) -> Option<f64> {
    if a.is_empty() || a.len() != b.len() {
        return None;
    }
    let dot: f64 = a.iter().zip(b).map(|(x, y)| (*x as f64) * (*y as f64)).sum();
    Some(dot.clamp(0.0, 1.0))
}

/// 关键词候选（id → relevance）。
pub(crate) struct KeywordHits {
    pub scores: HashMap<i64, f64>,
}

/// FTS trigram → LIKE 的召回；任何 FTS 错误都降级 LIKE。
///
/// 1 字查询不扫全表（§5.4）；空查询返回空表。
pub(crate) fn keyword_scores(conn: &Connection, query: &str) -> Result<KeywordHits> {
    let q = query.trim();
    let mut out = KeywordHits {
        scores: HashMap::new(),
    };
    if q.is_empty() {
        return Ok(out);
    }
    let chars = q.chars().count();
    if chars >= 3 && !too_short_for_trigram(q) {
        let expr = match_expr(q);
        if !expr.is_empty() {
            // prepare 失败（FTS 表缺失/语法问题）也必须降级，不能 `?` 掉整个检索。
            match conn.prepare(
                "SELECT s.id FROM memory_shard_fts
                 JOIN memory_shards s ON s.id = memory_shard_fts.rowid
                 WHERE memory_shard_fts MATCH ?1
                 LIMIT ?2",
            ) {
                Ok(mut stmt) => match stmt.query_map(params![expr, SEARCH_CANDIDATES], |r| {
                    r.get::<_, i64>(0)
                }) {
                    Ok(rows) => {
                        for row in rows {
                            if let Ok(id) = row {
                                out.scores.insert(id, 0.70);
                            }
                        }
                    }
                    Err(e) => eprintln!("[memory] FTS 查询失败，降级 LIKE：{e}"),
                },
                Err(e) => eprintln!("[memory] FTS 不可用，降级 LIKE：{e}"),
            }
        }
    }
    if chars >= 2 {
        let pattern = format!("%{}%", escape_like(q));
        let mut stmt = conn.prepare(
            "SELECT id FROM memory_shards
             WHERE content LIKE ?1 ESCAPE '\\'
             ORDER BY julianday(last_event_at) DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, SEARCH_CANDIDATES], |r| r.get::<_, i64>(0))?;
        for row in rows {
            let id = row?;
            // 同一 shard 取 max：FTS 0.70 优先于 LIKE 0.55。
            out.scores.entry(id).or_insert(0.55);
        }
    }
    Ok(out)
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// 召回 + 排序，返回 `(hits, mode)`；mode = vector | keyword | weight（附录 D）。
///
/// - 有 query embedding：暴力余弦 top 5000，并集 FTS/LIKE 候选；
/// - 无 embedding：FTS trigram → LIKE → 权重三级降级；
/// - 只返回 `state` 符合 `include_*` 且未合并的 shard；`includeArchived` 只扩结果集。
pub fn rank(
    conn: &Connection,
    query: Option<&str>,
    query_vec: Option<&[f32]>,
    active_model: Option<&str>,
    include_dormant: bool,
    include_archived: bool,
    revive_archived: bool,
    top_k: usize,
) -> Result<(Vec<MemorySearchHit>, &'static str)> {
    let _ = revive_archived; // 复活只发生在 reinforce；rank 只决定结果集。
    let trimmed = query.map(str::trim).filter(|q| !q.is_empty());
    // 1 字查询不扫全表（§5.4）：与空查询一样只按权重浏览。
    let browse_only = trimmed.map(|q| q.chars().count() < 2).unwrap_or(true);
    let candidates = load_candidates(conn, include_dormant, include_archived, CANDIDATE_LIMIT)?;
    let keywords = match trimmed {
        Some(q) => keyword_scores(conn, q)?,
        None => KeywordHits {
            scores: HashMap::new(),
        },
    };

    let mut vector_scored = false;
    let mut scored: Vec<(f64, MemorySearchHit)> = Vec::new();
    for c in candidates {
        let mut relevance = 0.0_f64;
        if !browse_only {
            if let (Some(qv), Some(model), Some(emb), Some(emb_model)) = (
                query_vec,
                active_model,
                c.embedding.as_deref(),
                c.embedding_model.as_deref(),
            ) {
                if emb_model == model {
                    if let Some(cos) = cosine(qv, emb) {
                        relevance = relevance.max(cos);
                        vector_scored = true;
                    }
                }
            }
        }
        if let Some(score) = keywords.scores.get(&c.shard.id) {
            relevance = relevance.max(*score);
        }
        if trimmed.is_some() && !browse_only {
            // 有查询但既没语义命中也没关键词命中：不是候选。
            if relevance <= 0.0 {
                continue;
            }
        } else {
            // 空查询 / 1 字 = 浏览：按权重排序（relevance 统一 1.0）。
            relevance = 1.0;
        }
        let score = relevance * c.shard.effective_weight;
        scored.push((
            score,
            MemorySearchHit {
                shard_id: c.shard.id,
                content: c.shard.content,
                mem_type: c.shard.mem_type,
                topic: c.shard.topic,
                category: c.shard.category,
                origin: c.shard.origin,
                state: c.shard.state,
                anchor_message_id: c.shard.anchor_message_id,
                chat_id: c.shard.chat_id,
                relevance: round3(relevance),
                effective_weight: round3(c.shard.effective_weight),
                created_at: c.shard.created_at,
            },
        ));
    }

    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.1.shard_id.cmp(&a.1.shard_id))
    });
    scored.truncate(top_k);

    let mode = if vector_scored {
        "vector"
    } else if trimmed.is_some() && !browse_only {
        "keyword"
    } else {
        "weight"
    };
    Ok((scored.into_iter().map(|(_, hit)| hit).collect(), mode))
}

/// 命中强化（单事务、best-effort）：返回 `(reinforced, revived)`（附录 D）。
///
/// 内部执行 top3 / 600s 冷却 / 30 天 ≤10 次 / FTS-only（query ≥3 字）门控；
/// dormant 通过门控后复活，archived 只有显式 revive 且 relevance ≥0.75 才复活。
///
/// 参数里的 `hits` 是 `(shard_id, relevance, rank)`，`rank` 从 0 起。
/// `keyword_mode=true` 时调用方必须已保证 query ≥ [`REINFORCE_MIN_QUERY_CHARS`] 且
/// `hits` 只来自 FTS（LIKE 的 0.55 本来也过不了 [`RELEVANCE_THRESHOLD`]）。
pub fn reinforce(
    conn: &Connection,
    hits: &[(i64, f64, usize)],
    keyword_mode: bool,
) -> Result<(i64, i64)> {
    reinforce_opts(conn, hits, keyword_mode, false)
}

/// 同 [`reinforce`]，但允许显式挖坟：`revive_archived=true` 时 relevance ≥0.75 的
/// archived 命中才会被复活；否则绝不静默撤销用户的手动归档（§5.2 / §5.3）。
pub fn reinforce_opts(
    conn: &Connection,
    hits: &[(i64, f64, usize)],
    keyword_mode: bool,
    revive_archived: bool,
) -> Result<(i64, i64)> {
    let _ = keyword_mode; // 硬门控由 relevance 阈值 + 调用方的 query 长度检查完成。
    let tx = conn.unchecked_transaction()?;
    let now = Utc::now();
    let now_s = now.to_rfc3339();
    let mut reinforced = 0i64;
    let mut revived = 0i64;

    for &(id, relevance, rank) in hits {
        if rank >= REINFORCE_MAX_HITS || relevance < RELEVANCE_THRESHOLD {
            continue;
        }
        let row: Option<(String, String, f64, f64, f64)> = tx
            .query_row(
                "SELECT state, origin, stability, base_weight, floor
                 FROM memory_shards
                 WHERE id = ?1 AND consolidated_into IS NULL",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, f64>(2)?,
                        r.get::<_, f64>(3)?,
                        r.get::<_, f64>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((state, origin, stability, base_weight, floor)) = row else {
            continue;
        };
        let archived = state == "archived";
        if archived && (!revive_archived || relevance < ARCHIVED_REVIVE_RELEVANCE) {
            // includeArchived 只扩结果集；没有显式 revive 就只返回、不改状态。
            continue;
        }
        if history::count_rows(&tx, id)? >= history::HISTORY_MAX_ROWS {
            // 软上限：继续返回结果，只是不再追加强化行（§4.3）。
            continue;
        }
        let hits_30d = history::count_hits(&tx, id, HIT_WINDOW_DAYS)?;
        if hits_30d >= MAX_HITS_30D {
            continue;
        }
        // 冷却：同 shard 10 分钟内不重复强化。用 SQL 的 julianday 兼容两种时间格式。
        let since_last_hit_secs: f64 = tx.query_row(
            "SELECT COALESCE((julianday('now') - MAX(julianday(at))) * 86400.0, 1e9)
             FROM memory_shard_history
             WHERE shard_id = ?1 AND event = 'search_hit'",
            [id],
            |r| r.get(0),
        )?;
        if since_last_hit_secs < SEARCH_HIT_COOLDOWN_SECONDS as f64 {
            continue;
        }

        let alpha = if hits_30d >= REDUCED_AFTER_HITS {
            ALPHA_REDUCED
        } else {
            ALPHA_BASE
        };
        let factor = 1.0 + alpha / (1.0 + rank as f64);
        let new_stability = (stability * factor).min(super::model::S_MAX);

        history::append(
            &tx,
            id,
            store::NewHistory {
                at: &now_s,
                event: "search_hit",
                stability: new_stability,
                base_weight,
                floor,
                factor,
                rank: Some(rank as i64),
                hits_30d: Some(hits_30d),
                origin: &origin,
                run_id: "",
                note: "",
            },
        )?;
        store::touch_shard(&tx, id, &now_s, new_stability, &now_s, "active")?;
        if state != "active" {
            tx.execute(
                "UPDATE memory_shards
                 SET state = 'active', archived_at = NULL, archived_reason = NULL
                 WHERE id = ?1",
                [id],
            )?;
            store::mark_dirty(&tx, id)?;
        }
        if archived {
            revived += 1;
        }
        reinforced += 1;
    }

    tx.commit()?;
    Ok((reinforced, revived))
}

/// 相似重复对：只扫当前 `embedding_model` 的 active/dormant、未合并 shard（附录 D）。
///
/// 按 `julianday(last_event_at) DESC` 取前 `DUP_SCAN_LIMIT` 条后两两点积，再截 `limit`；
/// `model_id=None`（keyword 模式）返回空表。
pub fn duplicate_pairs(
    conn: &Connection,
    model_id: Option<&str>,
    threshold: f64,
    limit: i64,
) -> Result<Vec<MemoryDuplicate>> {
    duplicate_pairs_scoped(conn, model_id, threshold, limit, false)
}

/// 同 [`duplicate_pairs`]，`curated_only=true` 时排除 conversation（旧整理器/兼容命令口径）。
pub fn duplicate_pairs_scoped(
    conn: &Connection,
    model_id: Option<&str>,
    threshold: f64,
    limit: i64,
    curated_only: bool,
) -> Result<Vec<MemoryDuplicate>> {
    let Some(model_id) = model_id else {
        return Ok(Vec::new());
    };
    let limit = limit.max(0);
    let origin_clause = if curated_only {
        " AND origin != 'conversation'"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, content, embedding
         FROM memory_shards
         WHERE consolidated_into IS NULL
           AND state IN ('active', 'dormant')
           AND embedding_model = ?1
           AND embedding IS NOT NULL{origin_clause}
         ORDER BY julianday(last_event_at) DESC, id DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![model_id, DUP_SCAN_LIMIT], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<Vec<u8>>>(2)?,
        ))
    })?;
    let mut shards: Vec<(i64, String, Vec<f32>)> = Vec::new();
    for row in rows {
        let (id, content, blob) = row?;
        if let Some(v) = parse_embedding(blob) {
            shards.push((id, content, v));
        }
    }

    let mut out: Vec<MemoryDuplicate> = Vec::new();
    for i in 0..shards.len() {
        for j in (i + 1)..shards.len() {
            let (a_id, a_text, av) = &shards[i];
            let (b_id, b_text, bv) = &shards[j];
            let Some(score) = cosine(av, bv) else {
                continue;
            };
            if score < threshold {
                continue;
            }
            out.push(MemoryDuplicate {
                // 对内定序：同一对不因扫描顺序不同而换个写法。
                a_id: (*a_id).min(*b_id),
                b_id: (*a_id).max(*b_id),
                score: round3(score),
                a_content: a_text.chars().take(120).collect(),
                b_content: b_text.chars().take(120).collect(),
            });
        }
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if limit > 0 {
        out.truncate(limit as usize);
    }
    Ok(out)
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_shard(
        conn: &Connection,
        key: &str,
        content: &str,
        origin: &str,
        state: &str,
        stability: f64,
        base_weight: f64,
        floor: f64,
        last_event_at: &str,
    ) -> i64 {
        conn.execute(
            "INSERT INTO memory_shards(
                idempotency_key, origin, mem_type, topic, category, content, content_hash,
                confidence, base_weight, floor, stability, last_event_at, state,
                provenance_json, source_message_ids, created_at, updated_at
             ) VALUES (?1, ?2, 'event', '', '', ?3, ?4, 0.7, ?5, ?6, ?7, ?8, ?9,
                       '{}', '[]', ?8, ?8)",
            params![
                key,
                origin,
                content,
                format!("h-{key}"),
                base_weight,
                floor,
                stability,
                last_event_at,
                state
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn insert_hit_history(conn: &Connection, id: i64, seq: i64, at_sql: &str) {
        conn.execute(
            &format!(
                "INSERT INTO memory_shard_history(
                    shard_id, seq, at, event, stability, base_weight, floor, factor,
                    rank, hits_30d, origin, run_id, note
                 ) VALUES (?1, ?2, {at_sql}, 'search_hit', 10.0, 2.5, 0.15, 1.0,
                           0, 1, 'manual_write', '', '')"
            ),
            params![id, seq],
        )
        .unwrap();
    }

    fn history_rows(conn: &Connection, id: i64, event: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_shard_history WHERE shard_id = ?1 AND event = ?2",
            params![id, event],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn now_rfc3339() -> String {
        Utc::now().to_rfc3339()
    }

    #[test]
    fn search_writes_search_hit_only_above_threshold() {
        let conn = db();
        let id = insert_shard(
            &conn,
            "t1",
            "膝盖不适，深蹲不宜过深",
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now_rfc3339(),
        );

        // 0.59 < RELEVANCE_THRESHOLD：只返回结果，不续命。
        let (n, _) = reinforce(&conn, &[(id, 0.59, 0)], false).unwrap();
        assert_eq!(n, 0);
        assert_eq!(history_rows(&conn, id, "search_hit"), 0);

        let (n, _) = reinforce(&conn, &[(id, 0.70, 0)], false).unwrap();
        assert_eq!(n, 1);
        assert_eq!(history_rows(&conn, id, "search_hit"), 1);
    }

    #[test]
    fn search_hit_alpha_decreases_with_rank() {
        let conn = db();
        let now = now_rfc3339();
        let ids: Vec<i64> = (0..3)
            .map(|i| {
                insert_shard(
                    &conn,
                    &format!("rank{i}"),
                    &format!("记忆内容 {i}"),
                    "manual_write",
                    "active",
                    20.0,
                    2.5,
                    0.15,
                    &now,
                )
            })
            .collect();
        let hits: Vec<(i64, f64, usize)> =
            ids.iter().enumerate().map(|(i, id)| (*id, 0.9, i)).collect();
        let (n, _) = reinforce(&conn, &hits, false).unwrap();
        assert_eq!(n, 3);

        let factor = |id: i64| -> f64 {
            conn.query_row(
                "SELECT factor FROM memory_shard_history
                 WHERE shard_id = ?1 AND event = 'search_hit' ORDER BY seq DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        // alpha/(1+rank)：0.8/1、0.8/2、0.8/3
        assert!((factor(ids[0]) - 1.8).abs() < 1e-9);
        assert!((factor(ids[1]) - 1.4).abs() < 1e-9);
        assert!((factor(ids[2]) - (1.0 + 0.8 / 3.0)).abs() < 1e-9);
        assert!(factor(ids[0]) > factor(ids[1]));
        assert!(factor(ids[1]) > factor(ids[2]));
    }

    #[test]
    fn search_hit_alpha_reduces_after_five_hits_in_30_days() {
        let conn = db();
        let id = insert_shard(
            &conn,
            "reduce",
            "热门记忆",
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now_rfc3339(),
        );
        // 5 次历史命中，但最后一次在 20 分钟前（绕过 600s 冷却）。
        for seq in 1..=5 {
            insert_hit_history(&conn, id, seq, "datetime('now', '-20 minutes')");
        }
        let (n, _) = reinforce(&conn, &[(id, 0.9, 0)], false).unwrap();
        assert_eq!(n, 1);
        let factor: f64 = conn
            .query_row(
                "SELECT factor FROM memory_shard_history
                 WHERE shard_id = ?1 AND event = 'search_hit' ORDER BY seq DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        // hits_30d=5 → alpha 降档 0.4，rank 0 → 1.4。
        assert!((factor - 1.4).abs() < 1e-9, "factor = {factor}");
    }

    #[test]
    fn search_hit_requires_top3_and_cooldown() {
        let conn = db();
        let id = insert_shard(
            &conn,
            "top3",
            "只强化前三",
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now_rfc3339(),
        );
        assert_eq!(reinforce(&conn, &[(id, 0.9, 3)], false).unwrap().0, 0);
        assert_eq!(history_rows(&conn, id, "search_hit"), 0);

        assert_eq!(reinforce(&conn, &[(id, 0.9, 0)], false).unwrap().0, 1);
        // 同一 shard 600s 内不重复。
        assert_eq!(reinforce(&conn, &[(id, 0.9, 0)], false).unwrap().0, 0);
        assert_eq!(history_rows(&conn, id, "search_hit"), 1);
    }

    #[test]
    fn search_revives_dormant_shard() {
        let conn = db();
        let id = insert_shard(
            &conn,
            "dormant",
            "休眠记忆",
            "manual_write",
            "dormant",
            20.0,
            2.5,
            0.15,
            &now_rfc3339(),
        );
        assert_eq!(reinforce(&conn, &[(id, 0.9, 0)], false).unwrap().0, 1);
        let state: String = conn
            .query_row("SELECT state FROM memory_shards WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "active");
    }

    #[test]
    fn search_include_archived_can_walk_archived() {
        let conn = db();
        let id = insert_shard(
            &conn,
            "arch",
            "已归档的旧记忆",
            "manual_write",
            "archived",
            20.0,
            2.5,
            0.15,
            &now_rfc3339(),
        );
        conn.execute(
            "UPDATE memory_shards SET archived_at = ?1, archived_reason = 'manual' WHERE id = ?2",
            params![now_rfc3339(), id],
        )
        .unwrap();

        let (hits, _) = rank(&conn, None, None, None, true, true, false, 8).unwrap();
        assert!(hits.iter().any(|h| h.shard_id == id), "includeArchived 应能挖坟");

        // 没有显式 revive：只返回，不改状态、不写 history。
        assert_eq!(reinforce(&conn, &[(id, 0.9, 0)], false).unwrap().0, 0);
        assert_eq!(history_rows(&conn, id, "search_hit"), 0);
        let state: String = conn
            .query_row("SELECT state FROM memory_shards WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "archived");

        // 显式 revive + relevance ≥0.75 → 复活。
        let (n, revived) = reinforce_opts(&conn, &[(id, 0.75, 0)], false, true).unwrap();
        assert_eq!((n, revived), (1, 1));
        let state: String = conn
            .query_row("SELECT state FROM memory_shards WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "active");
    }

    #[test]
    fn search_keyword_fallback_does_not_reinforce_like_hits() {
        let conn = db();
        // 2 字查询走 LIKE（trigram 下限 3 字），relevance 0.55。
        let id = insert_shard(
            &conn,
            "like",
            "膝盖不适时的替代动作",
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now_rfc3339(),
        );
        let (hits, mode) = rank(&conn, Some("膝盖"), None, None, true, false, false, 8).unwrap();
        assert_eq!(mode, "keyword");
        let hit = hits
            .iter()
            .find(|h| h.shard_id == id)
            .expect("LIKE 应召回");
        assert!((hit.relevance - 0.55).abs() < 1e-9);
        assert_eq!(reinforce(&conn, &[(id, 0.55, 0)], true).unwrap().0, 0);
        assert_eq!(history_rows(&conn, id, "search_hit"), 0);
    }

    #[test]
    fn search_without_embedding_uses_keyword_and_weight_modes() {
        let conn = db();
        insert_shard(
            &conn,
            "mode",
            "无向量时走关键词",
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now_rfc3339(),
        );
        let (hits, keyword_mode) =
            rank(&conn, Some("关键词"), None, None, true, false, false, 8).unwrap();
        assert_eq!(keyword_mode, "keyword");
        assert!(!hits.is_empty());

        let (_, weight_mode) = rank(&conn, None, None, None, true, false, false, 8).unwrap();
        assert_eq!(weight_mode, "weight");
    }

    #[test]
    fn search_fts_escapes_special_chars() {
        let conn = db();
        // FTS5 语法字符不能把检索整体打挂：失败也降级 LIKE。
        for q in ["foo\"bar", "*", "a:b", "膝盖\"不适", "foo*"] {
            assert!(
                rank(&conn, Some(q), None, None, true, false, false, 8).is_ok(),
                "query {q} 不应报错"
            );
        }
    }

    fn embedding_blob(values: &[f32]) -> Vec<u8> {
        let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
        values
            .iter()
            .flat_map(|v| (v / norm).to_le_bytes())
            .collect()
    }

    #[test]
    fn duplicate_pairs_reads_shard_embeddings() {
        let conn = db();
        let now = now_rfc3339();
        let a = insert_shard(
            &conn, "dup-a", "避免深蹲", "manual_write", "active", 20.0, 2.5, 0.15, &now,
        );
        let b = insert_shard(
            &conn, "dup-b", "深蹲不宜过深", "manual_write", "active", 20.0, 2.5, 0.15, &now,
        );
        let c = insert_shard(
            &conn, "dup-c", "喜欢香菜", "manual_write", "active", 20.0, 2.5, 0.15, &now,
        );
        for (id, v) in [
            (a, vec![1.0f32, 0.05, 0.0]),
            (b, vec![1.0f32, 0.0, 0.02]),
            (c, vec![0.0f32, 0.0, 1.0]),
        ] {
            conn.execute(
                "UPDATE memory_shards
                 SET embedding = ?1, embedding_model = 'test-model', embedding_dim = 3,
                     embedding_at = ?2
                 WHERE id = ?3",
                params![embedding_blob(&v), now, id],
            )
            .unwrap();
        }
        let pairs = duplicate_pairs(&conn, Some("test-model"), 0.9, 10).unwrap();
        assert_eq!(pairs.len(), 1, "只有 a↔b 该被判为重复：{pairs:?}");
        assert_eq!((pairs[0].a_id, pairs[0].b_id), (a, b));
        assert!(pairs[0].score > 0.99);
        assert!(duplicate_pairs(&conn, None, 0.5, 10).unwrap().is_empty());
        assert!(
            duplicate_pairs(&conn, Some("other-model"), 0.5, 10)
                .unwrap()
                .is_empty(),
            "只算当前 embedding_model"
        );
    }
}
