//! shard 命令层：§7.1 的 #1–#15（B 域）。
//!
//! 约定（§7.1）：所有命令隐含 `state: State<AppState>`；读命令 `#[tauri::command(async)]`，
//! 写命令同步并在写后 `hub.notify()`。参数名用 snake_case，前端按 Tauri 的 camelCase 映射。
//!
//! 锁纪律（`worker.rs:1-8`）：embedder 的构建/调用必须在 DB 锁外；任何命令都不得持锁做模型推理。
//! 本文件同时提供 `*_conn` 核心函数，供 `kb/memory.rs` 的兼容适配层复用（同一套语义，
//! 不复制第二份写路径）。

use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use tauri::State;

use crate::error::{ReinError, Result};
use crate::modules::kb::embed;
use crate::modules::kb::index;
use crate::modules::kb::models::MODE_KEYWORD;
use crate::modules::kb::worker::KbHub;
use crate::state::AppState;

use super::anchor;
use super::decay;
use super::history;
use super::inject;
use super::model::{
    MemoryDuplicate, MemoryInjectResult, MemorySearchResult, MemoryShard, MemoryShardDetail,
    MemoryShardEvent, MemoryShardOverview, MemoryShardStats, ShardApplyResult, ShardPatch,
    ShardSweepResult, ShardWriteAction, SHARD_MAX_CHARS, S_MAX,
};
use super::retrieve;
use super::store::{self, NewHistory, NewShard};

const ARCHIVE_REASON_MANUAL: &str = "manual";

/* ---------- 纯解析/规范化（供命令与兼容层共用） ---------- */

/// `memory_shard_list` 的 scope 解析：未知/缺省收敛 `active`（§7.1）。
pub(crate) fn normalize_scope(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some("dormant") => "dormant",
        Some("archived") => "archived",
        Some("all") => "all",
        _ => "active",
    }
}

/// `memory_shard_list` 的 origin 解析：`all`/缺省/未知 = 不过滤；`curated` 原样交给 store。
pub(crate) fn normalize_origin(raw: Option<&str>) -> Option<&str> {
    match raw.map(str::trim) {
        Some("conversation") => Some("conversation"),
        Some("dream_summary") => Some("dream_summary"),
        Some("manual_write") => Some("manual_write"),
        Some("marked_important") => Some("marked_important"),
        Some("curated") => Some("curated"),
        _ => None,
    }
}

/// 内容规范化：trim；超过 `SHARD_MAX_CHARS` 截断并加省略号（§3.3）。
fn normalize_content(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= SHARD_MAX_CHARS {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(SHARD_MAX_CHARS - 1).collect();
    out.push('…');
    out
}

fn non_empty(raw: Option<&String>) -> Option<&str> {
    raw.map(|s| s.trim()).filter(|s| !s.is_empty())
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

fn now_string() -> String {
    Utc::now().to_rfc3339()
}

/// 巡检是机会性任务：失败只记日志，不拖垮列表/统计。
fn sweep_if_due_best_effort(conn: &Connection) {
    if let Err(e) = decay::sweep_if_due(conn, Utc::now()) {
        eprintln!("[memory] 懒巡检失败：{e}");
    }
}

fn birth_stability(conn: &Connection, id: i64) -> Result<Option<f64>> {
    Ok(conn
        .query_row(
            "SELECT stability FROM memory_shard_history
             WHERE shard_id = ?1 ORDER BY seq ASC LIMIT 1",
            [id],
            |r| r.get(0),
        )
        .optional()?)
}

/* ---------- 写入核心（命令与 kb_memory_* 兼容层共用） ---------- */

struct Existing {
    origin: String,
    mem_type: String,
    topic: String,
    category: String,
    content: String,
    confidence: f64,
    stability: f64,
    base_weight: f64,
    floor: f64,
    state: String,
    content_hash: Option<String>,
    consolidated_into: Option<i64>,
}

fn load_existing(conn: &Connection, id: i64) -> Result<Option<Existing>> {
    Ok(conn
        .query_row(
            "SELECT origin, mem_type, topic, category, content, confidence, stability,
                    base_weight, floor, state, content_hash, consolidated_into
             FROM memory_shards WHERE id = ?1",
            [id],
            |r| {
                Ok(Existing {
                    origin: r.get(0)?,
                    mem_type: r.get(1)?,
                    topic: r.get(2)?,
                    category: r.get(3)?,
                    content: r.get(4)?,
                    confidence: r.get(5)?,
                    stability: r.get(6)?,
                    base_weight: r.get(7)?,
                    floor: r.get(8)?,
                    state: r.get(9)?,
                    content_hash: r.get(10)?,
                    consolidated_into: r.get(11)?,
                })
            },
        )
        .optional()?)
}

fn delete_shard_row(tx: &rusqlite::Transaction<'_>, id: i64) -> Result<bool> {
    let n = tx.execute("DELETE FROM memory_shards WHERE id = ?1", [id])?;
    if n == 0 {
        return Ok(false);
    }
    // embed job 指向已消失的 shard 会让 take_embed_batch 取到幽灵行（§2.4 #10）。
    tx.execute(
        "DELETE FROM memory_jobs WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
        [id],
    )?;
    index::delete_doc(tx, "memory", &id.to_string())?;
    Ok(true)
}

/// 从本轮快照里挑「锚点消息」与「用户消息」。
///
/// 前端抽取（memoryExtract / Dream）带的是整个会话的消息 id 快照；以前这里把
/// `anchor_message_id` 固定写 NULL，导致手动写入/抽取出来的记忆永远没有「查看原文」。
/// 这里按快照倒序找第一条能解析出 anchor 的消息（后端 `anchor_id` 派生列）与最后一条
/// user 消息；会话已被清空/消息已撤回时返回 None（记忆本身仍保留）。
fn source_anchor_and_user(
    conn: &Connection,
    chat_id: Option<&str>,
    message_ids: &[String],
) -> Result<(Option<String>, Option<String>)> {
    let Some(chat_id) = chat_id else {
        return Ok((None, None));
    };
    let mut anchor_id: Option<String> = None;
    let mut user_id: Option<String> = None;
    for id in message_ids.iter().rev() {
        if user_id.is_none() {
            let role: Option<String> = conn
                .query_row(
                    "SELECT role FROM ai_chat_messages WHERE id = ?1 AND chat_id = ?2",
                    params![id, chat_id],
                    |r| r.get(0),
                )
                .optional()?;
            if role.as_deref() == Some("user") {
                user_id = Some(id.clone());
            }
        }
        if anchor_id.is_none() {
            anchor_id = anchor::anchor_for_message(conn, chat_id, id)?;
        }
        if anchor_id.is_some() && user_id.is_some() {
            break;
        }
    }
    Ok((anchor_id, user_id))
}

/// 批量写入的共享实现；`kb_memory_apply` 兼容命令也走这里（§3.3 / §7.1 #3）。
///
/// - `add` 按 `(origin, content_hash)` 查重；命中归档行复活，命中活跃行 skipped；
/// - `update` 只改传入的非空字段；content 变化清向量并重投 embed job；
/// - `delete` 删除合并 shard 时先删 `consolidated_into = id` 的旧行；
/// - 每次 apply 仍写一条 `kb_memory_diffs`（旧页面审计依赖）。
pub(crate) fn apply_actions_conn(
    conn: &Connection,
    actions: &[ShardWriteAction],
    chat_id: Option<&str>,
    message_ids: &[String],
) -> Result<ShardApplyResult> {
    let mut result = ShardApplyResult {
        added: 0,
        updated: 0,
        deleted: 0,
        archived: 0,
        restored: 0,
        skipped: 0,
    };
    if actions.is_empty() {
        return Ok(result);
    }

    let tx = conn.unchecked_transaction()?;
    let now = now_string();
    // 快照里的锚点/用户消息只算一次：add 出来的每条记忆都指向同一回合的原文。
    let (source_anchor, source_user) = source_anchor_and_user(&tx, chat_id, message_ids)?;
    for action in actions {
        match action.op.as_str() {
            "add" => {
                let content = normalize_content(action.content.as_deref().unwrap_or(""));
                if content.is_empty() {
                    result.skipped += 1;
                    continue;
                }
                let mem_type = store::normalize_type(action.mem_type.as_deref().unwrap_or(""));
                let topic = action.topic.as_deref().unwrap_or("").trim().to_string();
                let category =
                    store::normalize_category(action.category.as_deref().unwrap_or(""));
                let confidence = action.confidence.unwrap_or(0.7).clamp(0.0, 1.0);
                let hash = store::compute_content_hash(&content);

                let existing: Option<(i64, String)> = tx
                    .query_row(
                        "SELECT id, state FROM memory_shards
                         WHERE origin IN ('manual_write', 'marked_important')
                           AND content_hash = ?1 AND consolidated_into IS NULL
                         ORDER BY id DESC LIMIT 1",
                        [&hash],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((id, state)) = existing {
                    if state == "archived" {
                        // 再次被提到 = 复活，而不是当作重复丢掉（§3.3）。
                        let cur = load_existing(&tx, id)?.ok_or_else(|| {
                            ReinError::Message(format!("记忆不存在：id={id}"))
                        })?;
                        let birth = birth_stability(&tx, id)?.unwrap_or(cur.stability);
                        let stability = cur.stability.max(birth);
                        tx.execute(
                            "UPDATE memory_shards
                             SET state = 'active', archived_at = NULL, archived_reason = NULL,
                                 stability = ?2, last_event_at = ?3, updated_at = ?3
                             WHERE id = ?1",
                            params![id, stability, now],
                        )?;
                        history::append(
                            &tx,
                            id,
                            NewHistory {
                                at: &now,
                                event: "manual_restore",
                                stability,
                                base_weight: cur.base_weight,
                                floor: cur.floor,
                                factor: 1.0,
                                rank: None,
                                hits_30d: None,
                                origin: &cur.origin,
                                run_id: "",
                                note: "duplicate-add",
                            },
                        )?;
                        store::mark_dirty(&tx, id)?;
                        result.restored += 1;
                    } else {
                        result.skipped += 1;
                    }
                    continue;
                }

                let p = store::params_for("manual_write");
                let key = format!("manual:{hash}");
                let provenance = if message_ids.is_empty() {
                    json!({})
                } else {
                    json!({ "messageIds": message_ids })
                };
                let id = store::insert_shard(
                    &tx,
                    NewShard {
                        idempotency_key: &key,
                        origin: "manual_write",
                        mem_type: &mem_type,
                        topic: &topic,
                        category: &category,
                        content: &content,
                        content_hash: Some(&hash),
                        confidence,
                        base_weight: p.base_weight,
                        floor: p.floor,
                        stability: p.s0,
                        last_event_at: &now,
                        state: "active",
                        anchor_message_id: source_anchor.as_deref(),
                        anchor_hash: None,
                        chat_id,
                        user_message_id: source_user.as_deref(),
                        provenance_json: provenance,
                        supersedes: None,
                        dream_action: None,
                        source_chat_id: chat_id,
                        source_message_ids: message_ids.to_vec(),
                        legacy_memory_id: None,
                        legacy_active_count: 0,
                        legacy_last_used_at: None,
                        created_at: &now,
                        updated_at: &now,
                    },
                )?;
                if id == 0 {
                    result.skipped += 1;
                    continue;
                }
                history::append(
                    &tx,
                    id,
                    NewHistory {
                        at: &now,
                        event: "birth",
                        stability: p.s0,
                        base_weight: p.base_weight,
                        floor: p.floor,
                        factor: 1.0,
                        rank: None,
                        hits_30d: None,
                        origin: "manual_write",
                        run_id: "",
                        note: "",
                    },
                )?;
                store::enqueue_embed(&tx, id, &now)?;
                store::mark_dirty(&tx, id)?;
                result.added += 1;
            }
            "update" => {
                let Some(id) = action.id else {
                    result.skipped += 1;
                    continue;
                };
                let Some(cur) = load_existing(&tx, id)? else {
                    result.skipped += 1;
                    continue;
                };
                if cur.consolidated_into.is_some() {
                    result.skipped += 1;
                    continue;
                }
                let new_content = non_empty(action.content.as_ref())
                    .map(normalize_content)
                    .unwrap_or_else(|| cur.content.clone());
                if new_content.is_empty() {
                    result.skipped += 1;
                    continue;
                }
                let content_changed = new_content != cur.content;
                let new_hash = if content_changed {
                    Some(store::compute_content_hash(&new_content))
                } else {
                    cur.content_hash.clone()
                };
                if content_changed {
                    if let Some(hash) = new_hash.as_deref() {
                        let collision: Option<i64> = tx
                            .query_row(
                                "SELECT id FROM memory_shards
                                 WHERE id != ?1 AND origin IN ('manual_write', 'marked_important')
                                   AND content_hash = ?2 AND consolidated_into IS NULL
                                 LIMIT 1",
                                params![id, hash],
                                |r| r.get(0),
                            )
                            .optional()?;
                        if collision.is_some() {
                            return Err(ReinError::Message("内容与已有记忆重复".into()));
                        }
                    }
                }
                let mem_type = non_empty(action.mem_type.as_ref())
                    .map(store::normalize_type)
                    .unwrap_or_else(|| cur.mem_type.clone());
                let topic = non_empty(action.topic.as_ref())
                    .map(str::to_string)
                    .unwrap_or_else(|| cur.topic.clone());
                let category = non_empty(action.category.as_ref())
                    .map(store::normalize_category)
                    .unwrap_or_else(|| cur.category.clone());
                let confidence = action
                    .confidence
                    .unwrap_or(cur.confidence)
                    .clamp(0.0, 1.0);
                let was_archived = cur.state == "archived";

                tx.execute(
                    "UPDATE memory_shards SET
                        mem_type = ?2, topic = ?3, category = ?4, content = ?5,
                        confidence = ?6, content_hash = ?7, updated_at = ?8,
                        embedding = CASE WHEN ?9 THEN NULL ELSE embedding END,
                        embedding_model = CASE WHEN ?9 THEN NULL ELSE embedding_model END,
                        embedding_dim = CASE WHEN ?9 THEN NULL ELSE embedding_dim END,
                        embedding_at = CASE WHEN ?9 THEN NULL ELSE embedding_at END,
                        state = CASE WHEN state = 'archived' THEN 'active' ELSE state END,
                        archived_at = CASE WHEN state = 'archived' THEN NULL ELSE archived_at END,
                        archived_reason = CASE WHEN state = 'archived' THEN NULL ELSE archived_reason END,
                        last_event_at = CASE WHEN state = 'archived' THEN ?8 ELSE last_event_at END
                     WHERE id = ?1",
                    params![
                        id,
                        mem_type,
                        topic,
                        category,
                        new_content,
                        confidence,
                        new_hash,
                        now,
                        content_changed
                    ],
                )?;
                history::append(
                    &tx,
                    id,
                    NewHistory {
                        at: &now,
                        event: "manual_edit",
                        stability: cur.stability,
                        base_weight: cur.base_weight,
                        floor: cur.floor,
                        factor: 1.0,
                        rank: None,
                        hits_30d: None,
                        origin: &cur.origin,
                        run_id: "",
                        note: "",
                    },
                )?;
                if content_changed {
                    store::enqueue_embed(&tx, id, &now)?;
                }
                store::mark_dirty(&tx, id)?;
                if was_archived {
                    result.restored += 1;
                } else {
                    result.updated += 1;
                }
            }
            "delete" => {
                let Some(id) = action.id else {
                    result.skipped += 1;
                    continue;
                };
                let Some(cur) = load_existing(&tx, id)? else {
                    result.skipped += 1;
                    continue;
                };
                if cur.consolidated_into.is_some() {
                    // 旧 shard 已被合并：删除它只会让 consolidated_into 指向空，先跳过。
                    result.skipped += 1;
                    continue;
                }
                let deps: Vec<i64> = {
                    let mut stmt = tx.prepare(
                        "SELECT id FROM memory_shards WHERE consolidated_into = ?1",
                    )?;
                    let rows = stmt.query_map([id], |r| r.get::<_, i64>(0))?;
                    rows.collect::<std::result::Result<Vec<_>, _>>()?
                };
                for dep in deps {
                    delete_shard_row(&tx, dep)?;
                }
                delete_shard_row(&tx, id)?;
                result.deleted += 1;
            }
            "archive" => {
                let Some(id) = action.id else {
                    result.skipped += 1;
                    continue;
                };
                let reason = non_empty(action.reason.as_ref()).unwrap_or(ARCHIVE_REASON_MANUAL);
                if archive_shard_conn(&tx, id, reason, &now)? {
                    result.archived += 1;
                } else {
                    result.skipped += 1;
                }
            }
            other => {
                return Err(ReinError::Message(format!(
                    "记忆操作只支持 add / update / delete / archive，收到：{other}"
                )))
            }
        }
    }

    tx.execute(
        "INSERT INTO kb_memory_diffs(chat_id, at, ops_json) VALUES (?1, datetime('now'), ?2)",
        params![
            chat_id,
            serde_json::to_string(&json!({
                "candidates": actions.len(),
                "added": result.added,
                "updated": result.updated,
                "deleted": result.deleted,
                "archived": result.archived,
                "restored": result.restored,
                "skipped": result.skipped,
            }))?
        ],
    )?;
    tx.commit()?;
    Ok(result)
}

fn archive_shard_conn(
    tx: &rusqlite::Transaction<'_>,
    id: i64,
    reason: &str,
    now: &str,
) -> Result<bool> {
    let Some(cur) = load_existing(tx, id)? else {
        return Ok(false);
    };
    if cur.state == "archived" {
        return Ok(false);
    }
    let reason = if reason.trim().is_empty() {
        ARCHIVE_REASON_MANUAL
    } else {
        reason.trim()
    };
    tx.execute(
        "UPDATE memory_shards
         SET state = 'archived', archived_at = ?2, archived_reason = ?3, updated_at = ?2
         WHERE id = ?1",
        params![id, now, reason],
    )?;
    history::append(
        tx,
        id,
        NewHistory {
            at: now,
            event: "manual_archive",
            stability: cur.stability,
            base_weight: cur.base_weight,
            floor: cur.floor,
            factor: 1.0,
            rank: None,
            hits_30d: None,
            origin: &cur.origin,
            run_id: "",
            note: reason,
        },
    )?;
    index::delete_doc(tx, "memory", &id.to_string())?;
    tx.execute(
        "DELETE FROM memory_jobs WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
        [id],
    )?;
    Ok(true)
}

/// `memory_shard_update` 的共享实现；返回更新后的读模型（§3.3 / §7.1 #4）。
pub(crate) fn update_shard_conn(
    conn: &Connection,
    id: i64,
    patch: &ShardPatch,
) -> Result<MemoryShard> {
    let tx = conn.unchecked_transaction()?;
    let cur = load_existing(&tx, id)?
        .ok_or_else(|| ReinError::Message(format!("记忆不存在：id={id}")))?;
    if cur.consolidated_into.is_some() {
        return Err(ReinError::Message(
            "该记忆已合并，请修改合并后的记忆".into(),
        ));
    }
    let content = non_empty(patch.content.as_ref())
        .map(normalize_content)
        .unwrap_or_else(|| cur.content.clone());
    if content.is_empty() {
        return Err(ReinError::Message("记忆内容不能为空".into()));
    }
    let content_changed = content != cur.content;
    let new_hash = if content_changed {
        Some(store::compute_content_hash(&content))
    } else {
        cur.content_hash.clone()
    };
    if content_changed {
        if let Some(hash) = new_hash.as_deref() {
            let collision: Option<i64> = tx
                .query_row(
                    "SELECT id FROM memory_shards
                     WHERE id != ?1 AND origin IN ('manual_write', 'marked_important')
                       AND content_hash = ?2 AND consolidated_into IS NULL
                     LIMIT 1",
                    params![id, hash],
                    |r| r.get(0),
                )
                .optional()?;
            if collision.is_some() {
                return Err(ReinError::Message("内容与已有记忆重复".into()));
            }
        }
    }
    let mem_type = non_empty(patch.mem_type.as_ref())
        .map(store::normalize_type)
        .unwrap_or_else(|| cur.mem_type.clone());
    let topic = non_empty(patch.topic.as_ref())
        .map(str::to_string)
        .unwrap_or_else(|| cur.topic.clone());
    let category = non_empty(patch.category.as_ref())
        .map(store::normalize_category)
        .unwrap_or_else(|| cur.category.clone());
    let now = now_string();
    let was_archived = cur.state == "archived";
    tx.execute(
        "UPDATE memory_shards SET
            mem_type = ?2, topic = ?3, category = ?4, content = ?5, content_hash = ?6,
            updated_at = ?7,
            embedding = CASE WHEN ?8 THEN NULL ELSE embedding END,
            embedding_model = CASE WHEN ?8 THEN NULL ELSE embedding_model END,
            embedding_dim = CASE WHEN ?8 THEN NULL ELSE embedding_dim END,
            embedding_at = CASE WHEN ?8 THEN NULL ELSE embedding_at END,
            state = CASE WHEN state = 'archived' THEN 'active' ELSE state END,
            archived_at = CASE WHEN state = 'archived' THEN NULL ELSE archived_at END,
            archived_reason = CASE WHEN state = 'archived' THEN NULL ELSE archived_reason END,
            last_event_at = CASE WHEN state = 'archived' THEN ?7 ELSE last_event_at END
         WHERE id = ?1",
        params![id, mem_type, topic, category, content, new_hash, now, content_changed],
    )?;
    history::append(
        &tx,
        id,
        NewHistory {
            at: &now,
            event: "manual_edit",
            stability: cur.stability,
            base_weight: cur.base_weight,
            floor: cur.floor,
            factor: 1.0,
            rank: None,
            hits_30d: None,
            origin: &cur.origin,
            run_id: "",
            note: if was_archived { "restored-by-edit" } else { "" },
        },
    )?;
    if content_changed {
        store::enqueue_embed(&tx, id, &now)?;
    }
    store::mark_dirty(&tx, id)?;
    tx.commit()?;
    store::get_shard(conn, id)?
        .ok_or_else(|| ReinError::Message(format!("记忆不存在：id={id}")))
}

/// `memory_shard_delete` 的共享实现（§2.4 #5 / §3.3）。
pub(crate) fn delete_shard_conn(conn: &Connection, id: i64) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let Some(cur) = load_existing(&tx, id)? else {
        return Ok(false);
    };
    if cur.consolidated_into.is_some() {
        // 合并 shard 本身通常是删除目标；旧行由合并 shard 的删除级联处理。
        let ok = delete_shard_row(&tx, id)?;
        tx.commit()?;
        return Ok(ok);
    }
    let deps: Vec<i64> = {
        let mut stmt =
            tx.prepare("SELECT id FROM memory_shards WHERE consolidated_into = ?1")?;
        let rows = stmt.query_map([id], |r| r.get::<_, i64>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    // 先删旧 shards，再删合并 shard：否则 FK SET NULL 会让旧行重新出现在列表里（§2.4 #5）。
    for dep in deps {
        delete_shard_row(&tx, dep)?;
    }
    let ok = delete_shard_row(&tx, id)?;
    tx.commit()?;
    Ok(ok)
}

/// `memory_shard_archive` 的共享实现。
pub(crate) fn archive_shard(conn: &Connection, id: i64, reason: &str) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let now = now_string();
    let ok = archive_shard_conn(&tx, id, reason, &now)?;
    tx.commit()?;
    Ok(ok)
}

/// `memory_shard_restore` 的共享实现；stability 取 `max(当前, birth)`（§3.3）。
pub(crate) fn restore_shard_conn(conn: &Connection, id: i64) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let Some(cur) = load_existing(&tx, id)? else {
        return Ok(false);
    };
    if cur.state == "active" || cur.consolidated_into.is_some() {
        return Ok(false);
    }
    let birth = birth_stability(&tx, id)?.unwrap_or(cur.stability);
    let stability = cur.stability.max(birth);
    let now = now_string();
    tx.execute(
        "UPDATE memory_shards
         SET state = 'active', archived_at = NULL, archived_reason = NULL,
             stability = ?2, last_event_at = ?3, updated_at = ?3
         WHERE id = ?1",
        params![id, stability, now],
    )?;
    history::append(
        &tx,
        id,
        NewHistory {
            at: &now,
            event: "manual_restore",
            stability,
            base_weight: cur.base_weight,
            floor: cur.floor,
            factor: 1.0,
            rank: None,
            hits_30d: None,
            origin: &cur.origin,
            run_id: "",
            note: "",
        },
    )?;
    store::mark_dirty(&tx, id)?;
    tx.commit()?;
    Ok(true)
}

/// `memory_shard_mark_important` 的共享实现（§3.3）。
pub(crate) fn mark_important_conn(
    conn: &Connection,
    id: i64,
    note: &str,
) -> Result<MemoryShard> {
    let tx = conn.unchecked_transaction()?;
    let cur = load_existing(&tx, id)?
        .ok_or_else(|| ReinError::Message(format!("记忆不存在：id={id}")))?;
    if cur.consolidated_into.is_some() {
        return Err(ReinError::Message(
            "该记忆已合并，请标记合并后的记忆".into(),
        ));
    }
    let p = store::params_for("marked_important");
    let stability = (cur.stability * 2.0).max(90.0).min(S_MAX);
    let now = now_string();
    tx.execute(
        "UPDATE memory_shards
         SET origin = 'marked_important', base_weight = ?2, floor = ?3, stability = ?4,
             state = 'active', archived_at = NULL, archived_reason = NULL,
             last_event_at = ?5, updated_at = ?5
         WHERE id = ?1",
        params![id, p.base_weight, p.floor, stability, now],
    )?;
    history::append(
        &tx,
        id,
        NewHistory {
            at: &now,
            event: "manual_mark",
            stability,
            base_weight: p.base_weight,
            floor: p.floor,
            factor: 1.0,
            rank: None,
            hits_30d: None,
            origin: "marked_important",
            run_id: "",
            note: note.trim(),
        },
    )?;
    store::mark_dirty(&tx, id)?;
    tx.commit()?;
    store::get_shard(conn, id)?
        .ok_or_else(|| ReinError::Message(format!("记忆不存在：id={id}")))
}

/* ---------- 统计核心 ---------- */

/// 三态计数、预算/注入估算、embedding 队列、`atCap`/`sweepTruncated`（§7.1 #12）。
pub(crate) fn compute_stats(conn: &Connection, curated_only: bool) -> Result<MemoryShardStats> {
    // 兼容视图（curated_only）排除 conversation：旧页面只投影 curated 记忆（§10 B）。
    let origin_clause = if curated_only {
        " AND origin != 'conversation'"
    } else {
        ""
    };
    let counts_sql = format!(
        "SELECT
            COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN state = 'dormant' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN state = 'archived' THEN 1 ELSE 0 END), 0),
            COUNT(*)
         FROM memory_shards WHERE consolidated_into IS NULL{origin_clause}"
    );
    let (active, dormant, archived, total): (i64, i64, i64, i64) =
        conn.query_row(&counts_sql, [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;

    // 读时权重平均值：active + dormant，排除已合并。
    let live_sql = format!(
        "SELECT {} FROM memory_shards
         WHERE consolidated_into IS NULL AND state IN ('active', 'dormant'){origin_clause}",
        retrieve::SHARD_COLS
    );
    let mut stmt = conn.prepare(&live_sql)?;
    let now = Utc::now();
    let rows = stmt.query_map([], |r| retrieve::shard_from_row(r, now))?;
    let live: Vec<MemoryShard> = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    let live_count = live.len() as f64;
    let avg = |f: fn(&MemoryShard) -> f64| -> f64 {
        if live.is_empty() {
            0.0
        } else {
            round3(live.iter().map(f).sum::<f64>() / live_count)
        }
    };
    let avg_confidence = avg(|s| s.confidence);
    let avg_effective_weight = avg(|s| s.effective_weight);

    let cognition = inject::select(
        conn,
        None,
        None,
        None,
        inject::INJECT_BUDGET_TOKENS,
        inject::INJECT_MAX_SHARDS,
        false,
    )?;
    let injected = cognition.shards.len() as i64;
    let injected_chars = cognition.text.chars().count() as i64;

    let job_scope = if curated_only {
        " AND ref_id IN (SELECT CAST(id AS TEXT) FROM memory_shards WHERE origin != 'conversation')"
    } else {
        ""
    };
    let embedding_pending: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM memory_jobs WHERE kind = 'embed'{job_scope}"),
        [],
        |r| r.get(0),
    )?;
    let embedding_failed: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memory_jobs
             WHERE kind = 'embed' AND (attempts >= 3 OR last_error IS NOT NULL){job_scope}"
        ),
        [],
        |r| r.get(0),
    )?;

    let last_sweep_at = crate::db::meta_get(conn, decay::LAST_SWEEP_KEY);
    let last_dream_at: Option<String> = conn.query_row(
        "SELECT MAX(finished_at) FROM memory_dream_runs WHERE status = 'done'",
        [],
        |r| r.get(0),
    )?;

    let live_total = active + dormant;
    Ok(MemoryShardStats {
        active,
        dormant,
        archived,
        total,
        limit: inject::INJECT_MAX_SHARDS as i64,
        max_chars: inject::INJECT_MAX_CHARS as i64,
        injected,
        injected_chars,
        estimated_tokens: cognition.estimated_tokens,
        budget_tokens: cognition.budget_tokens,
        avg_confidence,
        avg_effective_weight,
        signal_ratio: if active > 0 {
            round3((injected as f64 / active as f64).min(1.0))
        } else {
            1.0
        },
        noise_ratio: if live_total > 0 {
            round3(dormant as f64 / live_total as f64)
        } else {
            0.0
        },
        embedding_pending,
        embedding_failed,
        last_sweep_at,
        last_dream_at,
        at_cap: total >= store::TOTAL_SHARD_SOFT_CAP,
        sweep_truncated: live_total > decay::SWEEP_MAX_ROWS,
    })
}

/* ---------- 命令 ---------- */

/// #1 列表：`scope ∈ active|dormant|archived|all`（未知收敛 active），
/// `origin` 含 `curated`/`all`；排除已合并；排序规则见 §7.1。
#[tauri::command(async)]
pub fn memory_shard_list(
    state: State<AppState>,
    scope: Option<String>,
    origin: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<MemoryShard>> {
    let scope = normalize_scope(scope.as_deref());
    let origin = normalize_origin(origin.as_deref());
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let offset = offset.unwrap_or(0).max(0);
    let conn = state.db.lock();
    sweep_if_due_best_effort(&conn);
    store::list_shards(&conn, scope, origin, limit, offset)
}

/// #2 详情：shard + 全量 history + 溯源消息 id；已合并 shard 仍可查（§2.4 #5）。
#[tauri::command(async)]
pub fn memory_shard_get(state: State<AppState>, id: i64) -> Result<MemoryShardDetail> {
    let conn = state.db.lock();
    let shard = store::get_shard(&conn, id)?
        .ok_or_else(|| ReinError::Message(format!("记忆不存在：id={id}")))?;
    let history = history::load(&conn, id)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT source_message_ids FROM memory_shards WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let source_message_ids: Vec<String> = raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(MemoryShardDetail {
        shard,
        history,
        source_message_ids,
    })
}

/// #3 批量写入：add | update | delete | archive；`chat_id`/`message_ids` 用于补溯源（§3.3）。
///
/// 写后 `hub.notify()`；add/复活/恢复必须 `index::mark_dirty`（§3.3）。
#[tauri::command]
pub fn memory_shard_apply(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    actions: Vec<ShardWriteAction>,
    chat_id: Option<String>,
    message_ids: Option<Vec<String>>,
) -> Result<ShardApplyResult> {
    let ids = message_ids.unwrap_or_default();
    let out = {
        let conn = state.db.lock();
        apply_actions_conn(&conn, &actions, chat_id.as_deref(), &ids)?
    };
    hub.notify();
    Ok(out)
}

/// #4 手动编辑：只改 `Some` 且非空字段；写 `manual_edit`；content 变化清向量（§3.3）。
#[tauri::command]
pub fn memory_shard_update(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    patch: ShardPatch,
) -> Result<MemoryShard> {
    let out = {
        let conn = state.db.lock();
        update_shard_conn(&conn, id, &patch)?
    };
    hub.notify();
    Ok(out)
}

/// #5 删除：history 级联、`delete_doc`、删 embed job；合并 shard 先删旧行（§2.4 #5 / §3.3）。
#[tauri::command]
pub fn memory_shard_delete(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock();
        delete_shard_conn(&conn, id)?
    };
    hub.notify();
    Ok(ok)
}

/// #6 归档：`state='archived'` + `archived_reason` + `manual_archive`；`delete_doc`（§3.3）。
#[tauri::command]
pub fn memory_shard_archive(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    reason: Option<String>,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock();
        archive_shard(&conn, id, reason.as_deref().unwrap_or(ARCHIVE_REASON_MANUAL))?
    };
    hub.notify();
    Ok(ok)
}

/// #7 恢复：state 重算；stability 用 `max(当前, birth history)`（§3.3）。
#[tauri::command]
pub fn memory_shard_restore(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock();
        restore_shard_conn(&conn, id)?
    };
    hub.notify();
    Ok(ok)
}

/// #8 标记重要：origin 改 `marked_important`（4.0/0.35），`S=max(S*2,90)`，清 archived（§3.3）。
#[tauri::command]
pub fn memory_shard_mark_important(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    note: Option<String>,
) -> Result<MemoryShard> {
    let out = {
        let conn = state.db.lock();
        mark_important_conn(&conn, id, note.as_deref().unwrap_or(""))?
    };
    hub.notify();
    Ok(out)
}

/// #9 主动检索：命中才续命（§5.2）。
///
/// 锁内 `sweep_if_due` + `resolve_config/model_id_of` + `drain_extract`；放锁嵌入 query；
/// 再锁 `retrieve::rank` + `retrieve::reinforce_opts`。绝不能持锁建 embedder（§7.1）。
#[tauri::command(async)]
pub fn memory_shard_search(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    query: String,
    top_k: Option<i64>,
    include_dormant: Option<bool>,
    include_archived: Option<bool>,
    revive_archived: Option<bool>,
) -> Result<MemorySearchResult> {
    let started = Instant::now();
    let top_k = top_k.unwrap_or(retrieve::SEARCH_TOP_K as i64).clamp(1, 20) as usize;
    let include_dormant = include_dormant.unwrap_or(true);
    let revive_archived = revive_archived.unwrap_or(false);
    // 显式挖坟必然要先把 archived 放进结果集；否则 revive 永远没有命中。
    let include_archived = include_archived.unwrap_or(false) || revive_archived;
    let query_text = query.trim().to_string();

    // 锁 1：巡检 + 追赶抽取 + 读嵌入配置。模型加载/推理绝不在锁内。
    let (cfg, model_id) = {
        let conn = state.db.lock();
        sweep_if_due_best_effort(&conn);
        if let Err(e) = store::drain_extract(&conn, 50) {
            eprintln!("[memory] 检索前抽取追赶失败（忽略）：{e}");
        }
        let cfg = embed::resolve_config(&conn)?;
        let model_id = embed::model_id_of(&cfg);
        (cfg, model_id)
    };

    let query_vec = embed_query(
        try_embedder(hub.inner(), &cfg),
        &query_text,
        &model_id,
    );

    // 锁 2：召回、排序、强化（写 search_hit 在短事务里）。
    let conn = state.db.lock();
    let (hits, mode) = retrieve::rank(
        &conn,
        Some(&query_text),
        query_vec.as_deref(),
        model_id.as_deref(),
        include_dormant,
        include_archived,
        revive_archived,
        top_k,
    )?;

    let mut reinforced = 0i64;
    let mut revived = 0i64;
    // 关键词模式必须 query ≥3 字；空查询/1 字只是浏览，不写强化（§5.4）。
    let can_reinforce = !query_text.is_empty()
        && (mode == "vector" || query_text.chars().count() >= retrieve::REINFORCE_MIN_QUERY_CHARS);
    if can_reinforce {
        let ranked: Vec<(i64, f64, usize)> = hits
            .iter()
            .enumerate()
            .map(|(rank, h)| (h.shard_id, h.relevance, rank))
            .collect();
        match retrieve::reinforce_opts(&conn, &ranked, mode == "keyword", revive_archived) {
            Ok((r, v)) => {
                reinforced = r;
                revived = v;
            }
            Err(e) => eprintln!("[memory] 检索强化失败（结果照常返回）：{e}"),
        }
    }

    Ok(MemorySearchResult {
        hits,
        mode: mode.to_string(),
        reinforced,
        revived,
        took_ms: started.elapsed().as_millis() as i64,
    })
}

/// #10 自动注入：严格只读（§5.1）。
///
/// 没有 drain_extract、没有 sweep、没有任何写；锁内读配置+候选，放锁嵌入 query，
/// 再锁排序/渲染。
#[tauri::command(async)]
pub fn memory_shard_inject(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    query: Option<String>,
    budget_tokens: Option<i64>,
    max_shards: Option<i64>,
    include_conversation: Option<bool>,
) -> Result<MemoryInjectResult> {
    let budget_tokens = budget_tokens.unwrap_or(inject::INJECT_BUDGET_TOKENS).clamp(200, 8000);
    let max_shards = max_shards
        .unwrap_or(inject::INJECT_MAX_SHARDS as i64)
        .clamp(1, 20) as usize;
    let include_conversation = include_conversation.unwrap_or(false);
    let query_text = query.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(str::to_string);

    let (cfg, model_id) = {
        let conn = state.db.lock();
        let cfg = embed::resolve_config(&conn)?;
        let model_id = embed::model_id_of(&cfg);
        (cfg, model_id)
    };
    let query_vec = match query_text.as_deref() {
        Some(q) => embed_query(try_embedder(hub.inner(), &cfg), q, &model_id),
        None => None,
    };

    let conn = state.db.lock();
    inject::select(
        &conn,
        query_text.as_deref(),
        query_vec.as_deref(),
        model_id.as_deref(),
        budget_tokens,
        max_shards,
        include_conversation,
    )
}

/// #11 总览：active + dormant 列表 + stats + 认知投影（query=None，不写 history）。
#[tauri::command(async)]
pub fn memory_shard_overview(state: State<AppState>) -> Result<MemoryShardOverview> {
    let conn = state.db.lock();
    sweep_if_due_best_effort(&conn);
    let mut shards = store::list_shards(&conn, "all", None, 5000, 0)?;
    shards.retain(|s| s.state != "archived");
    shards.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    let stats = compute_stats(&conn, false)?;
    let cognition = inject::select(
        &conn,
        None,
        None,
        None,
        inject::INJECT_BUDGET_TOKENS,
        inject::INJECT_MAX_SHARDS,
        false,
    )?;
    Ok(MemoryShardOverview {
        shards,
        stats,
        cognition,
    })
}

/// #12 统计：三态计数、预算/注入估算、embedding 队列、`atCap`/`sweepTruncated`。
#[tauri::command(async)]
pub fn memory_shard_stats(state: State<AppState>) -> Result<MemoryShardStats> {
    let conn = state.db.lock();
    sweep_if_due_best_effort(&conn);
    compute_stats(&conn, false)
}

/// #13 手动衰减维护：`sweep(force=true)`；写后 `hub.notify()`（§4.4 / #7.1）。
#[tauri::command]
pub fn memory_shard_sweep(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
) -> Result<ShardSweepResult> {
    let out = {
        let conn = state.db.lock();
        decay::sweep(&conn, Utc::now(), true)?
    };
    hub.notify();
    Ok(out)
}

/// #14 相似重复对：async（O(400²) 不能阻塞主线程）；只读已落库 embedding（§7.1）。
#[tauri::command(async)]
pub fn memory_shard_duplicates(
    state: State<AppState>,
    threshold: Option<f64>,
    limit: Option<i64>,
) -> Result<Vec<MemoryDuplicate>> {
    let threshold = threshold.unwrap_or(0.86).clamp(0.5, 0.99);
    let limit = limit.unwrap_or(30).max(0);
    let conn = state.db.lock();
    let cfg = embed::resolve_config(&conn)?;
    let model_id = embed::model_id_of(&cfg);
    retrieve::duplicate_pairs(&conn, model_id.as_deref(), threshold, limit)
}

/// #15 事件审计：按 `julianday(at) DESC, shard_id, seq` 返回最近事件（§7.1）。
#[tauri::command(async)]
pub fn memory_shard_events(
    state: State<AppState>,
    limit: Option<i64>,
) -> Result<Vec<MemoryShardEvent>> {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT h.at, h.shard_id, h.event, s.content, h.run_id, h.note
         FROM memory_shard_history h
         JOIN memory_shards s ON s.id = h.shard_id
         ORDER BY julianday(h.at) DESC, h.shard_id DESC, h.seq DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        let content: String = r.get(3)?;
        Ok(MemoryShardEvent {
            at: r.get(0)?,
            shard_id: r.get(1)?,
            event: r.get(2)?,
            content: content.chars().take(120).collect(),
            run_id: r.get(4)?,
            note: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/* ---------- 嵌入（锁外） ---------- */

/// 取 embedder；keyword/无模型直接 None。调用方必须已经放掉 DB 锁。
fn outside_lock_embedder(
    hub: &KbHub,
    cfg: &embed::EmbedConfig,
) -> Result<Option<Arc<dyn embed::Embedder>>> {
    if cfg.mode == MODE_KEYWORD {
        return Ok(None);
    }
    hub.embedder(cfg)
}

/// 模型加载失败不拖垮检索/注入：记录原因后降级为关键词（§5.4）。
fn try_embedder(hub: &KbHub, cfg: &embed::EmbedConfig) -> Option<Arc<dyn embed::Embedder>> {
    match outside_lock_embedder(hub, cfg) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[memory] embedder 构建失败，降级关键词：{e}");
            None
        }
    }
}

fn embed_query(
    embedder: Option<Arc<dyn embed::Embedder>>,
    query: &str,
    model_id: &Option<String>,
) -> Option<Vec<f32>> {
    let embedder = embedder?;
    if query.trim().is_empty() || model_id.is_none() {
        return None;
    }
    match embedder.embed(std::slice::from_ref(&query.to_string())) {
        Ok(mut v) => v.pop().filter(|x| !x.is_empty()),
        Err(e) => {
            eprintln!("[memory] 查询嵌入失败，降级关键词：{e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_and_origin_are_normalized() {
        assert_eq!(normalize_scope(None), "active");
        assert_eq!(normalize_scope(Some("dormant")), "dormant");
        assert_eq!(normalize_scope(Some("archived")), "archived");
        assert_eq!(normalize_scope(Some("all")), "all");
        assert_eq!(normalize_scope(Some("bogus")), "active");

        assert_eq!(normalize_origin(None), None);
        assert_eq!(normalize_origin(Some("all")), None);
        assert_eq!(normalize_origin(Some("curated")), Some("curated"));
        assert_eq!(
            normalize_origin(Some("marked_important")),
            Some("marked_important")
        );
        assert_eq!(normalize_origin(Some("bogus")), None);
    }

    #[test]
    fn content_is_trimmed_and_capped() {
        assert_eq!(normalize_content("  你好  "), "你好");
        let long = "中".repeat(SHARD_MAX_CHARS + 10);
        let got = normalize_content(&long);
        assert_eq!(got.chars().count(), SHARD_MAX_CHARS);
        assert!(got.ends_with('…'));
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn add_manual(conn: &Connection, content: &str) -> i64 {
        let r = apply_actions_conn(
            conn,
            &[ShardWriteAction {
                op: "add".into(),
                id: None,
                content: Some(content.into()),
                mem_type: Some("constraint".into()),
                topic: Some("膝盖".into()),
                category: None,
                confidence: None,
                reason: None,
            }],
            None,
            &[],
        )
        .unwrap();
        assert_eq!(r.added, 1);
        conn.query_row(
            "SELECT id FROM memory_shards WHERE content = ?1",
            [content],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn apply_add_links_source_anchor_and_user() {
        let conn = db();
        conn.execute(
            "INSERT INTO ai_chats(id, created_at, updated_at) VALUES('c1','t','t')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, created_at, anchor_id) \
             VALUES('u1','c1',1,'user','text','膝盖疼', 't', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, created_at, anchor_id) \
             VALUES('a1','c1',2,'assistant','text','避免深蹲','t','a1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, created_at, anchor_id) \
             VALUES('u2','c1',3,'user','text','那替代动作呢','t',NULL)",
            [],
        )
        .unwrap();

        let ids = vec!["u1".to_string(), "a1".to_string(), "u2".to_string()];
        let r = apply_actions_conn(
            &conn,
            &[ShardWriteAction {
                op: "add".into(),
                id: None,
                content: Some("膝盖旧伤，避免深蹲过深".into()),
                mem_type: Some("constraint".into()),
                topic: Some("膝盖".into()),
                category: None,
                confidence: None,
                reason: None,
            }],
            Some("c1"),
            &ids,
        )
        .unwrap();
        assert_eq!(r.added, 1);
        let (anchor, user): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT anchor_message_id, user_message_id FROM memory_shards \
                 WHERE content = '膝盖旧伤，避免深蹲过深'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        // 锚点取快照里最后一条能解析出 anchor 的 assistant（a1），user 取最后一条 user（u2）。
        assert_eq!(anchor.as_deref(), Some("a1"), "记忆应能跳回原文");
        assert_eq!(user.as_deref(), Some("u2"));
    }

    #[test]
    fn archive_restore_and_mark_important_round_trip() {
        let conn = db();
        let id = add_manual(&conn, "膝盖旧伤，避免深蹲过深");

        let marked = mark_important_conn(&conn, id, "用户强调").unwrap();
        assert_eq!(marked.origin, "marked_important");
        assert!((marked.base_weight - 4.0).abs() < 1e-9);
        assert!((marked.floor - 0.35).abs() < 1e-9);
        assert!(marked.stability >= 90.0, "manual_mark 至少 90 天");
        assert_eq!(marked.state, "active");
        let mark_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_shard_history
                 WHERE shard_id = ?1 AND event = 'manual_mark'",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mark_rows, 1);

        assert!(archive_shard(&conn, id, "test").unwrap());
        let state: String = conn
            .query_row("SELECT state FROM memory_shards WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "archived");

        assert!(restore_shard_conn(&conn, id).unwrap());
        let (state, stability): (String, f64) = conn
            .query_row(
                "SELECT state, stability FROM memory_shards WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "active");
        assert!(stability >= 90.0, "恢复取 max(当前, birth)");
        assert!(
            !restore_shard_conn(&conn, id).unwrap(),
            "重复恢复是 no-op"
        );
    }

    #[test]
    fn update_content_clears_embedding_and_requeues() {
        let conn = db();
        let id = add_manual(&conn, "旧内容");
        let now = now_string();
        conn.execute(
            "UPDATE memory_shards
             SET embedding = X'00000000', embedding_model = 'test-model',
                 embedding_dim = 1, embedding_at = ?2
             WHERE id = ?1",
            params![id, now],
        )
        .unwrap();
        // 模拟 worker 已经把旧向量消费掉：只剩内容变更触发的重投。
        conn.execute("DELETE FROM memory_jobs WHERE kind = 'embed'", [])
            .unwrap();

        let updated = update_shard_conn(
            &conn,
            id,
            &ShardPatch {
                content: Some("新内容".into()),
                mem_type: None,
                topic: None,
                category: None,
            },
        )
        .unwrap();
        assert_eq!(updated.content, "新内容");
        assert_eq!(updated.mem_type, "constraint", "未传字段保持原值");
        assert_eq!(updated.topic, "膝盖");

        let (embedding, model, dim, at): (
            Option<Vec<u8>>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT embedding, embedding_model, embedding_dim, embedding_at
                 FROM memory_shards WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert!(embedding.is_none(), "content 变化必须清旧向量");
        assert!(model.is_none() && dim.is_none() && at.is_none());
        let jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs
                 WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jobs, 1, "content 变化要重投 embed job");
    }

    #[test]
    fn stats_can_be_scoped_to_curated() {
        let conn = db();
        add_manual(&conn, "用户偏好晨跑");
        let now = now_string();
        conn.execute(
            "INSERT INTO memory_shards(
                idempotency_key, origin, mem_type, topic, category, content, content_hash,
                confidence, base_weight, floor, stability, last_event_at, state,
                provenance_json, source_message_ids, created_at, updated_at
             ) VALUES ('conv:1', 'conversation', 'event', '', '', '助手的一段回答', 'h-conv',
                       0.7, 1.0, 0.05, 3.0, ?1, 'active', '{}', '[]', ?1, ?1)",
            [now],
        )
        .unwrap();

        let all = compute_stats(&conn, false).unwrap();
        assert_eq!((all.total, all.active), (2, 2));
        let curated = compute_stats(&conn, true).unwrap();
        assert_eq!((curated.total, curated.active), (1, 1), "兼容统计排除 conversation");
    }
}
