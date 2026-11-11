//! 自动注入：选择、预算与渲染（§5.1 / §5.5 / 附录 E）。
//!
//! **严格只读**：不 sweep、不 drain、不写 history/stability/state，本模块没有任何
//! INSERT/UPDATE。新 anchor 的 shard 由 worker 或 `memory_shard_search` 的 drain 产出。
//!
//! 排序分层（§5.1）：
//! 1. `marked_important` 常驻锚点（最多 3 条）；
//! 2. `dream_action='digest'` 摘要（最多 2 条）；
//! 3. 其余 `relevance * effective_weight`。
//!
//! 默认排除 `origin='conversation'`（原始回答不是蒸馏事实）；显式
//! `include_conversation=true` 时最多 2 条、总字符 ≤600。

use std::collections::HashSet;

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::error::Result;
use crate::modules::kb::source::mem_type_label;

use super::decay::THETA_ACTIVE;
use super::model::{MemoryInjectResult, MemoryInjectShard, MemoryShard};
use super::retrieve::{
    cosine, keyword_scores, parse_embedding, shard_from_row, CANDIDATE_LIMIT, SHARD_COLS,
};

/// 默认注入 token 预算（§4.2 / §5.1）。
pub const INJECT_BUDGET_TOKENS: i64 = 2000;
/// 注入总字符硬上限（§4.2 / §5.5）。
pub const INJECT_MAX_CHARS: usize = 3200;
/// 注入条数上限（§4.2 / §5.1）。
pub const INJECT_MAX_SHARDS: usize = 8;
/// marked_important 锚点优先条数上限（§5.1）。
pub const INJECT_ANCHOR_MAX: usize = 3;
/// digest 摘要优先条数上限（§5.1）。
pub const INJECT_DIGEST_MAX: usize = 2;
/// includeConversation 时的条数/字符上限（§5.1）。
pub const INJECT_CONVERSATION_MAX: usize = 2;
pub const INJECT_CONVERSATION_CHARS: usize = 600;

/// 一个候选 + 已落库向量 + 读时 relevance。
struct Cand {
    shard: MemoryShard,
    embedding: Option<Vec<f32>>,
    embedding_model: Option<String>,
    relevance: f64,
}

/// 选出一批可注入 shard 并渲染成提示词文本（附录 E）。
///
/// 候选 SQL 必须 `ORDER BY julianday(last_event_at) DESC LIMIT 5000`；默认排除
/// `origin='conversation'`（include_conversation 时最多 2 条 / 600 字符）。
/// 排序：marked_important → digest → `relevance * effective_weight`；
/// 预算：`estimate_tokens` ≤ budget_tokens、总字符 ≤ `INJECT_MAX_CHARS`、条数 ≤ max_shards；
/// 某条放不下跳过并继续尝试后面的小条目（§5.1）。
///
/// **本函数没有任何写操作**。它也不调用 sweep：state 缓存最多滞后 10 分钟，
/// 这里只用读时 `effective_weight` 过滤掉「缓存还标 active 但已经该休眠」的条目。
pub fn select(
    conn: &Connection,
    query: Option<&str>,
    query_vec: Option<&[f32]>,
    active_model: Option<&str>,
    budget_tokens: i64,
    max_shards: usize,
    include_conversation: bool,
) -> Result<MemoryInjectResult> {
    let now = Utc::now();
    let trimmed = query.map(str::trim).filter(|q| !q.is_empty());
    // 1 字查询不扫全表（§5.4）：与空查询一样按权重注入。
    let use_query = trimmed.map(|q| q.chars().count() >= 2).unwrap_or(false);
    let conversation_clause = if include_conversation {
        ""
    } else {
        " AND origin != 'conversation'"
    };
    let sql = format!(
        "SELECT {SHARD_COLS}, embedding, embedding_model
         FROM memory_shards
         WHERE consolidated_into IS NULL AND state = 'active'{conversation_clause}
         ORDER BY julianday(last_event_at) DESC, id DESC
         LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut cands: Vec<Cand> = stmt
        .query_map(params![CANDIDATE_LIMIT], |r| {
            let shard = shard_from_row(r, now)?;
            Ok(Cand {
                embedding: parse_embedding(r.get::<_, Option<Vec<u8>>>(24)?),
                embedding_model: r.get(25)?,
                relevance: 0.0,
                shard,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // 读时兜底：state 缓存滞后时，W 已跌破 THETA_ACTIVE 的条目不注入。
    cands.retain(|c| c.shard.effective_weight >= THETA_ACTIVE);

    let keywords = match trimmed {
        Some(q) if use_query => Some(keyword_scores(conn, q)?),
        _ => None,
    };
    let mut vector_used = false;
    for c in &mut cands {
        let mut relevance = 0.0_f64;
        if use_query {
            if let (Some(qv), Some(model), Some(emb), Some(emb_model)) = (
                query_vec,
                active_model,
                c.embedding.as_deref(),
                c.embedding_model.as_deref(),
            ) {
                if emb_model == model {
                    if let Some(cos) = cosine(qv, emb) {
                        relevance = relevance.max(cos);
                        vector_used = true;
                    }
                }
            }
            if let Some(kw) = keywords.as_ref() {
                if let Some(score) = kw.scores.get(&c.shard.id) {
                    relevance = relevance.max(*score);
                }
            }
        }
        c.relevance = if use_query { relevance } else { 1.0 };
    }

    // 第一层：marked_important 锚点，按权重降序。
    let mut anchor_idx: Vec<usize> = (0..cands.len())
        .filter(|&i| cands[i].shard.origin == "marked_important")
        .collect();
    anchor_idx.sort_by(|&a, &b| {
        cands[b]
            .shard
            .effective_weight
            .partial_cmp(&cands[a].shard.effective_weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| cands[b].shard.updated_at.cmp(&cands[a].shard.updated_at))
    });
    anchor_idx.truncate(INJECT_ANCHOR_MAX);

    // 第二层：Dream 摘要（digest）。
    let mut digest_idx: Vec<usize> = (0..cands.len())
        .filter(|&i| cands[i].shard.dream_action.as_deref() == Some("digest"))
        .collect();
    digest_idx.sort_by(|&a, &b| {
        cands[b]
            .shard
            .effective_weight
            .partial_cmp(&cands[a].shard.effective_weight)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    digest_idx.truncate(INJECT_DIGEST_MAX);

    // 第三层：其余候选按 relevance × weight。
    let mut rest_idx: Vec<usize> = (0..cands.len())
        .filter(|&i| {
            cands[i].shard.origin != "marked_important"
                && cands[i].shard.dream_action.as_deref() != Some("digest")
        })
        .collect();
    rest_idx.sort_by(|&a, &b| {
        let sa = cands[a].relevance * cands[a].shard.effective_weight;
        let sb = cands[b].relevance * cands[b].shard.effective_weight;
        sb.partial_cmp(&sa)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| cands[b].shard.id.cmp(&cands[a].shard.id))
    });

    let mut order: Vec<(usize, &'static str)> = Vec::with_capacity(cands.len());
    order.extend(anchor_idx.into_iter().map(|i| (i, "anchor")));
    order.extend(digest_idx.into_iter().map(|i| (i, "digest")));
    order.extend(rest_idx.into_iter().map(|i| {
        let reason = if trimmed.is_some() {
            "relevant"
        } else {
            "weight"
        };
        (i, reason)
    }));

    let budget_tokens = budget_tokens.max(0);
    let mut lines: Vec<String> = Vec::new();
    let mut shards: Vec<MemoryInjectShard> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut chars_used = 0usize;
    let mut tokens_used = 0i64;
    let mut conversation_count = 0usize;
    let mut conversation_chars = 0usize;

    for (idx, reason) in order {
        if shards.len() >= max_shards {
            break;
        }
        let c = &cands[idx];
        let content = c.shard.content.trim();
        if content.is_empty() {
            continue;
        }
        let line = render_line(&c.shard);
        let line_chars = line.chars().count();
        let line_tokens = estimate_tokens(&line);

        // includeConversation 的独立上限：2 条 / 600 字符。
        if c.shard.origin == "conversation" {
            if conversation_count >= INJECT_CONVERSATION_MAX
                || conversation_chars + line_chars > INJECT_CONVERSATION_CHARS
            {
                continue;
            }
        }
        // 按内容去重（锚点优先：它先进入 seen）。
        if !seen.insert(content.to_string()) {
            continue;
        }
        // 放不下就跳过，继续尝试后面的小条目；不直接 break。
        if chars_used + line_chars + usize::from(!lines.is_empty()) > INJECT_MAX_CHARS {
            continue;
        }
        if tokens_used + line_tokens > budget_tokens {
            continue;
        }

        if c.shard.origin == "conversation" {
            conversation_count += 1;
            conversation_chars += line_chars;
        }
        chars_used += line_chars + usize::from(!lines.is_empty());
        tokens_used += line_tokens;
        lines.push(line);
        shards.push(MemoryInjectShard {
            shard_id: c.shard.id,
            content: c.shard.content.clone(),
            mem_type: c.shard.mem_type.clone(),
            topic: c.shard.topic.clone(),
            category: c.shard.category.clone(),
            origin: c.shard.origin.clone(),
            anchor_message_id: c.shard.anchor_message_id.clone(),
            chat_id: c.shard.chat_id.clone(),
            effective_weight: round3(c.shard.effective_weight),
            reason: reason.to_string(),
        });
    }

    let mode = if vector_used {
        "vector"
    } else if use_query {
        "keyword"
    } else {
        "weight"
    };

    Ok(MemoryInjectResult {
        text: lines.join("\n"),
        shards,
        estimated_tokens: tokens_used,
        budget_tokens,
        mode: mode.to_string(),
    })
}

/// 注入行格式：`- [类型·分类] 内容`；分类为空时 `- [类型] 内容`（§5.1 / `kb_cognition` 兼容）。
fn render_line(s: &MemoryShard) -> String {
    let label = if s.category.trim().is_empty() {
        mem_type_label(&s.mem_type).to_string()
    } else {
        format!("{}·{}", mem_type_label(&s.mem_type), s.category.trim())
    };
    format!("- [{label}] {}", s.content.trim())
}

/// token 估算：`ceil(chars / 1.6) + 6`（§5.5）。
pub fn estimate_tokens(text: &str) -> i64 {
    ((text.chars().count() as f64) / 1.6).ceil() as i64 + 6
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
        base_weight: f64,
        floor: f64,
        dream_action: Option<&str>,
    ) -> i64 {
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO memory_shards(
                idempotency_key, origin, mem_type, topic, category, content, content_hash,
                confidence, base_weight, floor, stability, last_event_at, state,
                dream_action, provenance_json, source_message_ids, created_at, updated_at
             ) VALUES (?1, ?2, 'preference', '', '', ?3, ?4, 0.8, ?5, ?6, 20.0, ?7, ?8,
                       ?9, '{}', '[]', ?7, ?7)",
            params![
                key,
                origin,
                content,
                format!("h-{key}"),
                base_weight,
                floor,
                now,
                state,
                dream_action
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn inject_is_strictly_read_only() {
        let conn = db();
        let id = insert_shard(
            &conn,
            "ro",
            "用户不吃香菜",
            "manual_write",
            "active",
            2.5,
            0.15,
            None,
        );
        conn.execute(
            "INSERT INTO memory_shard_history(
                shard_id, seq, at, event, stability, base_weight, floor, factor,
                origin, run_id, note
             ) VALUES (?1, 1, ?2, 'birth', 20.0, 2.5, 0.15, 1.0, 'manual_write', '', '')",
            params![id, Utc::now().to_rfc3339()],
        )
        .unwrap();
        let before = (
            count(&conn, "memory_shards"),
            count(&conn, "memory_shard_history"),
            count(&conn, "memory_jobs"),
            conn.query_row(
                "SELECT stability, state FROM memory_shards WHERE id = ?1",
                [id],
                |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?)),
            )
            .unwrap(),
        );

        let out = select(&conn, Some("饮食"), None, None, 2000, 8, false).unwrap();
        assert!(!out.shards.is_empty());

        let after = (
            count(&conn, "memory_shards"),
            count(&conn, "memory_shard_history"),
            count(&conn, "memory_jobs"),
            conn.query_row(
                "SELECT stability, state FROM memory_shards WHERE id = ?1",
                [id],
                |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?)),
            )
            .unwrap(),
        );
        assert_eq!(before, after, "自动注入不得写任何行或改 stability/state");
    }

    #[test]
    fn inject_prefers_marked_important_and_digest() {
        let conn = db();
        insert_shard(
            &conn,
            "normal",
            "普通记忆",
            "manual_write",
            "active",
            2.5,
            0.15,
            None,
        );
        insert_shard(
            &conn,
            "marked",
            "膝盖有旧伤",
            "marked_important",
            "active",
            4.0,
            0.35,
            None,
        );
        insert_shard(
            &conn,
            "digest",
            "最近在调整训练量",
            "dream_summary",
            "active",
            2.0,
            0.10,
            Some("digest"),
        );

        let out = select(&conn, None, None, None, 2000, 8, false).unwrap();
        assert_eq!(out.shards[0].reason, "anchor");
        assert_eq!(out.shards[0].content, "膝盖有旧伤");
        assert_eq!(out.shards[1].reason, "digest");
        assert_eq!(out.shards[1].content, "最近在调整训练量");
    }

    #[test]
    fn inject_respects_token_budget_and_max_shards() {
        let conn = db();
        for i in 0..6 {
            let content = format!("偏好编号 {i}：{}", "内容".repeat(40));
            insert_shard(
                &conn,
                &format!("budget-{i}"),
                &content,
                "manual_write",
                "active",
                2.5,
                0.15,
                None,
            );
        }
        // 每条约 (85/1.6)+6 ≈ 60 token；预算 130 只容得下 2 条。
        let out = select(&conn, None, None, None, 130, 8, false).unwrap();
        assert!(out.estimated_tokens <= 130, "{}", out.estimated_tokens);
        assert!(out.shards.len() <= 2, "实际 {} 条", out.shards.len());

        let out = select(&conn, None, None, None, 2000, 1, false).unwrap();
        assert_eq!(out.shards.len(), 1);
    }

    #[test]
    fn inject_falls_back_to_weight_without_query() {
        let conn = db();
        insert_shard(
            &conn,
            "w1",
            "低权重记忆",
            "manual_write",
            "active",
            2.5,
            0.15,
            None,
        );
        let out = select(&conn, None, None, None, 2000, 8, false).unwrap();
        assert_eq!(out.mode, "weight");
        assert_eq!(out.shards[0].reason, "weight");
        assert!(out.shards[0].effective_weight >= 0.25);
    }

    #[test]
    fn inject_excludes_conversation_by_default() {
        let conn = db();
        insert_shard(
            &conn,
            "conv",
            "助手在对话里的一段回答",
            "conversation",
            "active",
            1.0,
            0.05,
            None,
        );
        insert_shard(
            &conn,
            "curated",
            "用户偏好晨跑",
            "manual_write",
            "active",
            2.5,
            0.15,
            None,
        );
        let out = select(&conn, None, None, None, 2000, 8, false).unwrap();
        assert!(
            out.shards.iter().all(|s| s.origin != "conversation"),
            "默认注入只含 curated"
        );
        assert!(out.shards.iter().any(|s| s.origin == "manual_write"));
    }

    #[test]
    fn inject_include_conversation_is_capped() {
        let conn = db();
        for i in 0..4 {
            insert_shard(
                &conn,
                &format!("conv-{i}"),
                &format!("对话片段 {i} {}", "内容".repeat(10)),
                "conversation",
                "active",
                1.0,
                0.05,
                None,
            );
        }
        let out = select(&conn, None, None, None, 4000, 8, true).unwrap();
        let conv: Vec<&MemoryInjectShard> = out
            .shards
            .iter()
            .filter(|s| s.origin == "conversation")
            .collect();
        assert!(conv.len() <= INJECT_CONVERSATION_MAX, "实际 {}", conv.len());
        let conv_chars: usize = out
            .shards
            .iter()
            .filter(|s| s.origin == "conversation")
            .map(|s| render_line_for_test(s).chars().count())
            .sum();
        assert!(conv_chars <= INJECT_CONVERSATION_CHARS, "实际 {conv_chars}");
    }

    fn render_line_for_test(s: &MemoryInjectShard) -> String {
        let label = if s.category.is_empty() {
            mem_type_label(&s.mem_type).to_string()
        } else {
            format!("{}·{}", mem_type_label(&s.mem_type), s.category)
        };
        format!("- [{label}] {}", s.content)
    }

    #[test]
    fn estimate_tokens_uses_char_ratio() {
        // ceil(16/1.6)+6 = 16
        assert_eq!(estimate_tokens(&"中".repeat(16)), 16);
        assert_eq!(estimate_tokens(""), 6);
    }
}
