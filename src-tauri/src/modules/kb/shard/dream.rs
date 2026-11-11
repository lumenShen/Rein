//! Dream（离线维护者）：触发门控、上下文、四类动作的事务性 apply（§6 / 附录 C 域）。
//!
//! 纪律：
//! - Rust 不调 LLM；模型由前端 `memoryDream.ts` 调用，本模块只做 gate/context/apply/cancel。
//! - `memory_dream_apply` 整批一个 `unchecked_transaction`，任一动作非法整体回滚。
//! - Dream 动作枚举里没有 `mark_important`；JSON 入口显式拒绝并以 `dream_action_forbidden` 报错。
//! - history 是唯一真相源：新建 shard 写 `birth`，四类动作各写自己的 `dream_*` 行。
//!
//! 关于依赖：A 域的 `store` / `history` / `model::parse_ts` 在 C 域落地时仍是 stub
//! （`todo!()`），直接调用会在运行时 panic。因此这里把 Dream 需要的 SQL 与时间解析收敛在
//! 本文件内（口径与 §4.1 / §4.2 逐字一致）；等 A 域实现完成后可改为
//! `store::insert_shard` / `history::append`，行为不变。

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use tauri::State;

use crate::error::{ReinError, Result};
use crate::modules::kb::index;
use crate::modules::kb::models::MEMORY_TYPES;
use crate::modules::kb::worker::KbHub;
use crate::state::AppState;

use super::model::{
    DreamAction, DreamApplyResult, DreamBeginResult, DreamContext, DreamGate, DreamMessage,
    DreamSession, DreamShardBrief, MemoryDuplicate, S_MAX, SHARD_MAX_CHARS,
};

/// Dream 冷却（小时）（§4.2 / §6.2）。
pub const DREAM_COOLDOWN_HOURS: i64 = 3;
/// 触发所需的最少会话数（§4.2 / §6.2）。
pub const DREAM_MIN_SESSIONS: i64 = 1;
/// 触发所需的最少消息数（§4.2 / §6.2）。
pub const DREAM_MIN_MESSAGES: i64 = 5;
/// 单次 run 允许的最大动作数（§4.2 / §6.4）。
pub const DREAM_MAX_ACTIONS: usize = 12;
/// revive 允许的最小剩余权重 R（§4.2 / §6.4）。
pub const DREAM_REVIVE_MIN_R: f64 = 0.10;
/// revive 允许的最大剩余权重 R（§4.2 / §6.4）。
pub const DREAM_REVIVE_MAX_R: f64 = 0.30;
/// `status='running'` lease 的超时时间（分钟）（§4.2 / §6.2）。
pub const DREAM_LEASE_MINUTES: i64 = 10;

/// 每轮 context 最多带几个会话（§6.3）。
const DREAM_CONTEXT_MAX_SESSIONS: usize = 8;
/// 每轮 context 最多带多少条消息（§6.3）。
const DREAM_CONTEXT_MAX_MESSAGES: usize = 200;
/// 每轮 context 最多带多少条 shard 摘要（§6.3）。
const DREAM_CONTEXT_MAX_SHARDS: usize = 40;
/// 每轮 context 最多带多少条疑似重复对（§6.3）。
const DREAM_CONTEXT_MAX_DUPLICATES: usize = 20;
/// context 里 shard 摘要的正文截断（§6.3）。
const DREAM_SHARD_BRIEF_CHARS: usize = 300;
/// 查重阈值；与 `memory_shard_duplicates` 默认值一致（§7.1 #14）。
const DREAM_DUP_THRESHOLD: f64 = 0.86;

/// Dream 新建 shard 的固定先验（§4.2：dream_summary 2.0 / 0.10 / 10）。
const DREAM_BASE_WEIGHT: f64 = 2.0;
const DREAM_FLOOR: f64 = 0.10;
const DREAM_S0: f64 = 10.0;

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

/// 触发 Dream：清理过期 lease → 检查 running → `auto_consolidate` → 冷却/材料门控（§6.2）。
///
/// 通过时生成 `run_id = "dream-<timestamp_ms>-<pid>"` 并插入 `memory_dream_runs`。
/// 同步命令：只写 gate 所需的状态与 run 行。
#[tauri::command]
pub fn memory_dream_begin(state: State<AppState>, force: Option<bool>) -> Result<DreamBeginResult> {
    let conn = state.db.lock();
    begin(&conn, force.unwrap_or(false))
}

/// 应用 Dream 动作（§6.4）：校验 run/动作 → 单事务执行四类动作 → 写 done/result。
///
/// 入参用 `serde_json::Value` 而不是 `Vec<DreamAction>`：这样 `mark_important` 与未知 type
/// 能在**开事务之前**得到明确的 `dream_action_forbidden` / 未知动作错误，而不是 serde 的
/// 泛化反序列化文案。线上形状与 §7.1 的 `Vec<DreamAction>` 完全一致。
///
/// 幂等：同一 run 重放返回 `alreadyApplied=true`；写后 `hub.notify()`。
#[tauri::command]
pub fn memory_dream_apply(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    run_id: String,
    actions: Vec<Value>,
) -> Result<DreamApplyResult> {
    let parsed = decode_actions(actions)?;
    let conn = state.db.lock();
    let result = apply(&conn, &run_id, &parsed)?;
    drop(conn);
    hub.notify();
    Ok(result)
}

/// 取消/失败一个 run（§6.4）：running → cancelled/failed，写 finished_at/error；幂等。
#[tauri::command]
pub fn memory_dream_cancel(
    state: State<AppState>,
    run_id: String,
    error: Option<String>,
) -> Result<()> {
    let conn = state.db.lock();
    cancel(&conn, &run_id, error.as_deref())
}

// ---------------------------------------------------------------------------
// JSON 动作解码（权限拒绝）
// ---------------------------------------------------------------------------

/// 把前端传来的 JSON 动作解成 `DreamAction`；`mark_important` 明确拒绝。
///
/// `DreamAction` 本身没有该变体，所以即使绕过这里，`serde_json::from_value` 也会失败；
/// 这里提前拦截只是为了给出可判定的错误码与中文文案（前端按 code 分派）。
pub(crate) fn decode_actions(raw: Vec<Value>) -> Result<Vec<DreamAction>> {
    let mut out = Vec::with_capacity(raw.len());
    for value in raw {
        let ty = value.get("type").and_then(Value::as_str).unwrap_or("");
        if ty == "mark_important" {
            return Err(ReinError::coded(
                "dream_action_forbidden",
                "Dream 不能标记重要：DreamAction 只有 supersede / consolidate / digest / revive",
            ));
        }
        let action = serde_json::from_value::<DreamAction>(value)
            .map_err(|e| ReinError::Message(format!("无法识别的 Dream 动作：{e}")))?;
        out.push(action);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 门控
// ---------------------------------------------------------------------------

fn gate(
    eligible: bool,
    reason: &str,
    last_run_at: Option<String>,
    sessions_since: i64,
    messages_since: i64,
) -> DreamGate {
    DreamGate {
        eligible,
        reason: reason.to_string(),
        last_run_at,
        sessions_since,
        messages_since,
        cooldown_hours: DREAM_COOLDOWN_HOURS,
        min_sessions: DREAM_MIN_SESSIONS,
        min_messages: DREAM_MIN_MESSAGES,
    }
}

fn not_eligible(
    reason: &str,
    last_run_at: Option<String>,
    sessions_since: i64,
    messages_since: i64,
) -> DreamBeginResult {
    DreamBeginResult {
        gate: gate(false, reason, last_run_at, sessions_since, messages_since),
        run_id: None,
        context: None,
    }
}

/// 门控 + 建 run + 组装 context（§6.2 / §6.3）。
pub(crate) fn begin(conn: &Connection, force: bool) -> Result<DreamBeginResult> {
    let now = Utc::now();

    // 1. 清理过期 lease：running 超过 10 分钟视为 timeout。
    conn.execute(
        "UPDATE memory_dream_runs \
            SET status = 'failed', finished_at = ?1, error = 'timeout' \
          WHERE status = 'running' \
            AND julianday(started_at) < julianday('now', ?2)",
        params![now.to_rfc3339(), format!("-{DREAM_LEASE_MINUTES} minutes")],
    )?;

    // 2. 已有未过期的 running → 第二个窗口不能再起一轮。
    let running: i64 = conn.query_row(
        "SELECT COUNT(*) FROM memory_dream_runs WHERE status = 'running'",
        [],
        |r| r.get(0),
    )?;
    if running > 0 {
        return Ok(not_eligible("running", None, 0, 0));
    }

    // 3. 上次成功结束时间与窗口内素材量。
    let last_finished: Option<String> = conn.query_row(
        "SELECT MAX(finished_at) FROM memory_dream_runs WHERE status = 'done'",
        [],
        |r| r.get(0),
    )?;
    let (sessions_since, messages_since) = counts_since(conn, last_finished.as_deref())?;

    // 4. auto_consolidate 开关（force 跳过）。
    let auto: i64 = conn
        .query_row(
            "SELECT (SELECT auto_consolidate FROM kb_settings WHERE id = 1)",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or(1);
    if !force && auto == 0 {
        return Ok(not_eligible(
            "disabled",
            last_finished,
            sessions_since,
            messages_since,
        ));
    }

    // 5. 3 小时冷却（force 跳过）。
    if !force {
        if let Some(last) = last_finished.as_deref() {
            if let Some(ts) = parse_ts(last) {
                if now.signed_duration_since(ts) < Duration::hours(DREAM_COOLDOWN_HOURS) {
                    return Ok(not_eligible(
                        "cooldown",
                        last_finished,
                        sessions_since,
                        messages_since,
                    ));
                }
            }
        }
    }

    // 6. 最小素材门控：force 也不跳过（没有新对话时整理只会重排旧数据）。
    if sessions_since < DREAM_MIN_SESSIONS || messages_since < DREAM_MIN_MESSAGES {
        let reason = if messages_since == 0 {
            "no_material"
        } else {
            "insufficient_material"
        };
        return Ok(not_eligible(
            reason,
            last_finished,
            sessions_since,
            messages_since,
        ));
    }

    // 7. 建 run + 组装 context：同一事务，context 组装失败不留下孤儿 running。
    //    `dream-<ms>-<pid>` 在同一毫秒内重复触发时追加 `-n`，保证主键不撞。
    let base = format!("dream-{}-{}", now.timestamp_millis(), std::process::id());
    let mut run_id = base.clone();
    let mut suffix = 1;
    loop {
        let exists = conn
            .query_row(
                "SELECT 1 FROM memory_dream_runs WHERE id = ?1",
                [&run_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            break;
        }
        run_id = format!("{base}-{suffix}");
        suffix += 1;
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO memory_dream_runs \
            (id, started_at, status, session_count, message_count) \
         VALUES (?1, ?2, 'running', ?3, ?4)",
        params![run_id, now.to_rfc3339(), sessions_since, messages_since],
    )?;
    let context = build_context(&tx, last_finished.as_deref(), sessions_since, messages_since)?;
    tx.commit()?;

    Ok(DreamBeginResult {
        gate: gate(true, "ok", last_finished, sessions_since, messages_since),
        run_id: Some(run_id),
        context: Some(context),
    })
}

/// 窗口内（严格晚于 `since`）的会话数与消息数（§6.2 第 5/6 步）。
fn counts_since(conn: &Connection, since: Option<&str>) -> Result<(i64, i64)> {
    let (sessions, messages) = match since {
        Some(since) => (
            conn.query_row(
                "SELECT COUNT(DISTINCT chat_id) FROM ai_chat_messages \
                  WHERE julianday(created_at) > julianday(?1)",
                [since],
                |r| r.get(0),
            )?,
            conn.query_row(
                "SELECT COUNT(*) FROM ai_chat_messages \
                  WHERE julianday(created_at) > julianday(?1)",
                [since],
                |r| r.get(0),
            )?,
        ),
        None => (
            conn.query_row(
                "SELECT COUNT(DISTINCT chat_id) FROM ai_chat_messages",
                [],
                |r| r.get(0),
            )?,
            conn.query_row("SELECT COUNT(*) FROM ai_chat_messages", [], |r| r.get(0))?,
        ),
    };
    Ok((sessions, messages))
}

// ---------------------------------------------------------------------------
// Context（§6.3）
// ---------------------------------------------------------------------------

struct SessionAcc {
    chat_id: String,
    title: String,
    updated_at: String,
    last_at: String,
    messages: Vec<DreamMessage>,
}

/// 组装 Dream 上下文：最近会话 + 分片样本 + 疑似重复对。
///
/// 不读 `image_base64` / `payload`（Dream 是维护，不是重放推理）；消息只保留有正文的
/// `text` / `food-parse` / `analysis` / `voice`，其中 voice 只收 user（§6.3）。
fn build_context(
    conn: &Connection,
    since: Option<&str>,
    total_sessions: i64,
    total_messages: i64,
) -> Result<DreamContext> {
    let mut stmt = conn.prepare(
        "SELECT m.chat_id, c.title, c.updated_at, m.id, m.seq, m.role, m.kind, m.text, \
                m.anchor_id, m.created_at \
           FROM ai_chat_messages m \
           JOIN ai_chats c ON c.id = m.chat_id \
          WHERE (?1 IS NULL OR julianday(m.created_at) > julianday(?1)) \
            AND m.kind IN ('text','food-parse','analysis','voice') \
            AND m.text IS NOT NULL AND TRIM(m.text) <> '' \
            AND (m.kind <> 'voice' OR m.role = 'user') \
          ORDER BY julianday(m.created_at) ASC, m.seq ASC",
    )?;
    let rows = stmt
        .query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                DreamMessage {
                    id: r.get(3)?,
                    seq: r.get(4)?,
                    role: r.get(5)?,
                    kind: r.get(6)?,
                    text: r.get(7)?,
                    anchor_id: r.get(8)?,
                    created_at: r.get(9)?,
                },
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    // 只保留最近的消息，避免旧会话把预算吃光。
    let skip = rows.len().saturating_sub(DREAM_CONTEXT_MAX_MESSAGES);
    let mut sessions: Vec<SessionAcc> = Vec::new();
    for (chat_id, title, updated_at, msg) in rows.into_iter().skip(skip) {
        let last_at = msg.created_at.clone();
        match sessions.iter_mut().find(|s| s.chat_id == chat_id) {
            Some(s) => {
                s.messages.push(msg);
                s.last_at = last_at;
            }
            None => sessions.push(SessionAcc {
                chat_id,
                title,
                updated_at,
                last_at,
                messages: vec![msg],
            }),
        }
    }

    // 最近活跃的会话优先；最多 8 个。
    sessions.sort_by(|a, b| match (parse_ts(&a.last_at), parse_ts(&b.last_at)) {
        (Some(a), Some(b)) => b.cmp(&a),
        _ => b.last_at.cmp(&a.last_at),
    });
    sessions.truncate(DREAM_CONTEXT_MAX_SESSIONS);

    let sessions: Vec<DreamSession> = sessions
        .into_iter()
        .map(|s| DreamSession {
            chat_id: s.chat_id,
            title: s.title,
            updated_at: s.updated_at,
            messages: s.messages,
        })
        .collect();

    // 分片样本：未合并的 active/dormant，策展条目优先，按最近事件倒序。
    let mut stmt = conn.prepare(
        "SELECT id, content, mem_type, topic, category, origin, state, stability, \
                base_weight, floor, last_event_at, anchor_message_id, chat_id, updated_at \
           FROM memory_shards \
          WHERE consolidated_into IS NULL AND state IN ('active','dormant') \
          ORDER BY (origin = 'conversation') ASC, julianday(last_event_at) DESC \
          LIMIT ?1",
    )?;
    let shards = stmt
        .query_map([DREAM_CONTEXT_MAX_SHARDS as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, f64>(7)?,
                r.get::<_, f64>(8)?,
                r.get::<_, f64>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, Option<String>>(11)?,
                r.get::<_, Option<String>>(12)?,
                r.get::<_, String>(13)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let now = Utc::now();
    let briefs: Vec<DreamShardBrief> = shards
        .iter()
        .map(|s| {
            let dt_days = parse_ts(&s.10)
                .map(|ts| (now.signed_duration_since(ts).num_seconds() as f64 / 86400.0).max(0.0))
                .unwrap_or(0.0);
            let eff = s.8 * (s.9 + (1.0 - s.9) * (-dt_days / s.7.max(0.1)).exp());
            DreamShardBrief {
                id: s.0,
                content: truncate_chars(&s.1, DREAM_SHARD_BRIEF_CHARS),
                mem_type: s.2.clone(),
                topic: s.3.clone(),
                category: s.4.clone(),
                origin: s.5.clone(),
                state: s.6.clone(),
                stability: s.7,
                effective_weight: eff,
                anchor_message_id: s.11.clone(),
                chat_id: s.12.clone(),
                updated_at: s.13.clone(),
            }
        })
        .collect();

    let ids: Vec<i64> = briefs.iter().map(|b| b.id).collect();
    let duplicate_pairs = if ids.len() < 2 {
        Vec::new()
    } else {
        duplicates_for(conn, &ids)?
    };

    Ok(DreamContext {
        since: since.map(str::to_string),
        sessions,
        shards: briefs,
        duplicate_pairs,
        total_sessions,
        total_messages,
    })
}

/// 从已落库向量里取疑似重复对（本地余弦，零模型成本）。
///
/// 只比较同一个 `embedding_model` 的行；没有向量时返回空数组，prompt 会明说「没有向量提示」。
fn duplicates_for(conn: &Connection, ids: &[i64]) -> Result<Vec<MemoryDuplicate>> {
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT id, content, embedding, embedding_model \
           FROM memory_shards \
          WHERE id IN ({placeholders}) \
            AND embedding IS NOT NULL AND embedding_model IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    // 选行数最多的模型；混模型时只比较同一模型的行。
    let mut counts: HashMap<String, usize> = HashMap::new();
    for r in &rows {
        *counts.entry(r.3.clone()).or_default() += 1;
    }
    let model = counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(m, _)| m)
        .unwrap_or_default();
    let picked: Vec<(i64, String, Vec<f32>)> = rows
        .into_iter()
        .filter(|r| r.3 == model)
        .map(|r| (r.0, r.1, decode_f32(&r.2)))
        .filter(|r| !r.2.is_empty())
        .collect();

    let mut pairs: Vec<MemoryDuplicate> = Vec::new();
    for i in 0..picked.len() {
        for j in (i + 1)..picked.len() {
            let (a_id, a_text, a_vec) = &picked[i];
            let (b_id, b_text, b_vec) = &picked[j];
            if a_vec.len() != b_vec.len() {
                continue;
            }
            let mut dot = 0.0f64;
            let mut na = 0.0f64;
            let mut nb = 0.0f64;
            for (x, y) in a_vec.iter().zip(b_vec.iter()) {
                let x = *x as f64;
                let y = *y as f64;
                dot += x * y;
                na += x * x;
                nb += y * y;
            }
            if na <= f64::EPSILON || nb <= f64::EPSILON {
                continue;
            }
            let score = dot / (na.sqrt() * nb.sqrt());
            if score >= DREAM_DUP_THRESHOLD {
                pairs.push(MemoryDuplicate {
                    a_id: *a_id,
                    b_id: *b_id,
                    score,
                    a_content: truncate_chars(a_text, DREAM_SHARD_BRIEF_CHARS),
                    b_content: truncate_chars(b_text, DREAM_SHARD_BRIEF_CHARS),
                });
            }
        }
    }
    pairs.sort_by(|a, b| b.score.total_cmp(&a.score));
    pairs.truncate(DREAM_CONTEXT_MAX_DUPLICATES);
    Ok(pairs)
}

fn decode_f32(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

// ---------------------------------------------------------------------------
// Apply（§6.4）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ShardRow {
    id: i64,
    origin: String,
    state: String,
    stability: f64,
    base_weight: f64,
    floor: f64,
    last_event_at: String,
    consolidated_into: Option<i64>,
}

/// 应用一批动作：整批一个事务；任一失败整体回滚，run 保持 running。
pub(crate) fn apply(
    conn: &Connection,
    run_id: &str,
    actions: &[DreamAction],
) -> Result<DreamApplyResult> {
    let (status, result_json): (String, Option<String>) = conn
        .query_row(
            "SELECT status, result_json FROM memory_dream_runs WHERE id = ?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| ReinError::Message(format!("Dream run 不存在：{run_id}")))?;

    match status.as_str() {
        // 同一 run 重放：返回第一次的结果，不重复写。
        "done" => return Ok(result_from_json(result_json.as_deref())),
        "running" => {}
        other => {
            return Err(ReinError::Message(format!(
                "Dream run 状态为 {other}，不能应用动作"
            )))
        }
    }

    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    validate_actions(&tx, actions)?;

    let mut result = DreamApplyResult {
        created: 0,
        superseded: 0,
        consolidated: 0,
        revived: 0,
        skipped: 0,
        already_applied: false,
    };

    for action in actions {
        apply_one(&tx, run_id, action, &now, &mut result)?;
    }

    let actions_json = Value::Array(actions.iter().map(action_to_json).collect());
    let result_json = serde_json::to_string(&result)?;
    tx.execute(
        "UPDATE memory_dream_runs \
            SET status = 'done', finished_at = ?1, actions_json = ?2, result_json = ?3, error = NULL \
          WHERE id = ?4",
        params![now, actions_json.to_string(), result_json, run_id],
    )?;
    tx.commit()?;
    Ok(result)
}

/// 取消/失败一个 run；已 done/failed/cancelled 直接返回（幂等）。
pub(crate) fn cancel(conn: &Connection, run_id: &str, error: Option<&str>) -> Result<()> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM memory_dream_runs WHERE id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(status) = status else {
        return Err(ReinError::Message(format!("Dream run 不存在：{run_id}")));
    };
    if status != "running" {
        return Ok(());
    }
    let (next, err): (&str, &str) = match error.map(str::trim).filter(|e| !e.is_empty()) {
        Some(e) => ("failed", e),
        None => ("cancelled", ""),
    };
    conn.execute(
        "UPDATE memory_dream_runs \
            SET status = ?1, finished_at = ?2, error = ?3 \
          WHERE id = ?4 AND status = 'running'",
        params![next, Utc::now().to_rfc3339(), err, run_id],
    )?;
    Ok(())
}

fn validate_actions(tx: &Transaction<'_>, actions: &[DreamAction]) -> Result<()> {
    if actions.len() > DREAM_MAX_ACTIONS {
        return Err(ReinError::Message(format!(
            "Dream 单次最多 {DREAM_MAX_ACTIONS} 个动作，收到 {}",
            actions.len()
        )));
    }
    for action in actions {
        match action {
            DreamAction::Supersede {
                old_shard_id,
                content,
                ..
            } => {
                check_content(content)?;
                require_shard(tx, *old_shard_id)?;
            }
            DreamAction::Consolidate {
                shard_ids,
                content,
                ..
            } => {
                check_content(content)?;
                let mut ids = shard_ids.clone();
                ids.sort_unstable();
                ids.dedup();
                if ids.len() < 2 {
                    return Err(ReinError::Message(
                        "consolidate 至少需要 2 个不同的 shard".into(),
                    ));
                }
                for id in ids {
                    require_shard(tx, id)?;
                }
            }
            DreamAction::Digest { content, .. } => check_content(content)?,
            DreamAction::Revive { shard_id, .. } => {
                require_shard(tx, *shard_id)?;
            }
        }
    }
    Ok(())
}

fn check_content(content: &str) -> Result<()> {
    if content.trim().is_empty() {
        return Err(ReinError::Message("Dream 动作的 content 不能为空".into()));
    }
    if content.chars().count() > SHARD_MAX_CHARS {
        return Err(ReinError::Message(format!(
            "Dream 动作的 content 超过 {SHARD_MAX_CHARS} 字"
        )));
    }
    Ok(())
}

fn apply_one(
    tx: &Transaction<'_>,
    run_id: &str,
    action: &DreamAction,
    now: &str,
    result: &mut DreamApplyResult,
) -> Result<()> {
    match action {
        DreamAction::Supersede {
            old_shard_id,
            content,
            mem_type,
            topic,
            category,
            reason,
        } => {
            let old = require_shard(tx, *old_shard_id)?;
            let key = format!(
                "dream:{run_id}:supersede:{old_shard_id}:{}",
                content_hash(content)
            );
            let mem_type = mem_type_for(mem_type.as_deref());
            let topic = normalize_topic(topic.as_deref());
            let category = normalize_category(category.as_deref());
            let Some(new_id) = insert_dream_shard(
                tx,
                &key,
                content,
                &mem_type,
                &topic,
                &category,
                Some(*old_shard_id),
                "supersede_new",
                now,
            )?
            else {
                result.skipped += 1;
                return Ok(());
            };

            tx.execute(
                "UPDATE memory_shards \
                    SET state = 'archived', archived_at = ?1, archived_reason = 'superseded', updated_at = ?1 \
                  WHERE id = ?2",
                params![now, old.id],
            )?;
            append_event(
                tx,
                old.id,
                "dream_supersede",
                now,
                old.stability,
                old.base_weight,
                old.floor,
                1.0,
                &old.origin,
                run_id,
                reason,
            )?;
            drop_doc_and_embed(tx, old.id)?;
            mark_doc_dirty(tx, new_id)?;
            result.created += 1;
            result.superseded += 1;
            Ok(())
        }
        DreamAction::Consolidate {
            shard_ids,
            content,
            mem_type,
            topic,
            category,
            reason,
        } => {
            let mut ids = shard_ids.clone();
            ids.sort_unstable();
            ids.dedup();
            let id_part = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
            let key = format!(
                "dream:{run_id}:consolidate:{}:{}",
                content_hash(&id_part),
                content_hash(content)
            );
            let mem_type = mem_type_for(mem_type.as_deref());
            let topic = normalize_topic(topic.as_deref());
            let category = normalize_category(category.as_deref());
            let Some(merged_id) = insert_dream_shard(
                tx,
                &key,
                content,
                &mem_type,
                &topic,
                &category,
                None,
                "consolidate_merged",
                now,
            )?
            else {
                result.skipped += 1;
                return Ok(());
            };

            for id in ids {
                let old = require_shard(tx, id)?;
                // 已合并过的旧 shard 不再二次减半；它的 base_weight 只被减一次。
                if old.consolidated_into.is_some() {
                    continue;
                }
                let halved = old.base_weight * 0.5;
                tx.execute(
                    "UPDATE memory_shards SET consolidated_into = ?1, base_weight = ?2, updated_at = ?3 \
                      WHERE id = ?4",
                    params![merged_id, halved, now, old.id],
                )?;
                append_event(
                    tx,
                    old.id,
                    "dream_consolidate",
                    now,
                    old.stability,
                    halved,
                    old.floor,
                    1.0,
                    &old.origin,
                    run_id,
                    reason,
                )?;
                drop_doc_and_embed(tx, old.id)?;
                result.consolidated += 1;
            }
            mark_doc_dirty(tx, merged_id)?;
            result.created += 1;
            Ok(())
        }
        DreamAction::Digest {
            content,
            topic,
            category,
        } => {
            let key = format!("dream:{run_id}:digest:{}", content_hash(content));
            let topic = normalize_topic(topic.as_deref());
            let category = normalize_category(category.as_deref());
            let Some(new_id) = insert_dream_shard(
                tx, &key, content, "event", &topic, &category, None, "digest", now,
            )?
            else {
                result.skipped += 1;
                return Ok(());
            };
            mark_doc_dirty(tx, new_id)?;
            result.created += 1;
            Ok(())
        }
        DreamAction::Revive { shard_id, reason } => {
            let old = require_shard(tx, *shard_id)?;
            // archived 不救；已合并的 shard 不参与排序，也不救。
            if old.state != "dormant" || old.consolidated_into.is_some() {
                result.skipped += 1;
                return Ok(());
            }
            let now_dt = parse_ts(now).unwrap_or_else(Utc::now);
            let dt_days = parse_ts(&old.last_event_at)
                .map(|ts| {
                    (now_dt.signed_duration_since(ts).num_seconds() as f64 / 86400.0).max(0.0)
                })
                .unwrap_or(0.0);
            let r = (-dt_days / old.stability.max(0.1)).exp();
            if !(DREAM_REVIVE_MIN_R..=DREAM_REVIVE_MAX_R).contains(&r) {
                result.skipped += 1;
                return Ok(());
            }

            let stability = (old.stability * 1.25).min(S_MAX);
            tx.execute(
                "UPDATE memory_shards \
                    SET state = 'active', stability = ?1, last_event_at = ?2, updated_at = ?2, \
                        archived_at = NULL, archived_reason = NULL \
                  WHERE id = ?3",
                params![stability, now, old.id],
            )?;
            append_event(
                tx,
                old.id,
                "dream_revive",
                now,
                stability,
                old.base_weight,
                old.floor,
                1.25,
                &old.origin,
                run_id,
                reason,
            )?;
            mark_doc_dirty(tx, old.id)?;
            result.revived += 1;
            Ok(())
        }
    }
}

/// 新建一条 Dream shard + birth history；idempotency_key 冲突返回 `None`。
#[allow(clippy::too_many_arguments)]
fn insert_dream_shard(
    tx: &Transaction<'_>,
    key: &str,
    content: &str,
    mem_type: &str,
    topic: &str,
    category: &str,
    supersedes: Option<i64>,
    dream_action: &str,
    now: &str,
) -> Result<Option<i64>> {
    let hash = content_hash(content);
    let changed = tx.execute(
        "INSERT INTO memory_shards \
            (idempotency_key, origin, mem_type, topic, category, content, content_hash, confidence, \
             base_weight, floor, stability, last_event_at, state, provenance_json, supersedes, \
             dream_action, source_message_ids, created_at, updated_at) \
         VALUES (?1, 'dream_summary', ?2, ?3, ?4, ?5, ?6, 0.7, \
                 ?7, ?8, ?9, ?10, 'active', '{}', ?11, ?12, '[]', ?10, ?10) \
         ON CONFLICT(idempotency_key) DO NOTHING",
        params![
            key,
            mem_type,
            topic,
            category,
            content,
            hash,
            DREAM_BASE_WEIGHT,
            DREAM_FLOOR,
            DREAM_S0,
            now,
            supersedes,
            dream_action
        ],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    let id = tx.last_insert_rowid();
    append_event(
        tx,
        id,
        "birth",
        now,
        DREAM_S0,
        DREAM_BASE_WEIGHT,
        DREAM_FLOOR,
        1.0,
        "dream_summary",
        "",
        "",
    )?;
    Ok(Some(id))
}

/// 追加 history；同 (shard, run, event) 已存在时返回 false（幂等）。
#[allow(clippy::too_many_arguments)]
fn append_event(
    tx: &Transaction<'_>,
    shard_id: i64,
    event: &str,
    at: &str,
    stability: f64,
    base_weight: f64,
    floor: f64,
    factor: f64,
    origin: &str,
    run_id: &str,
    note: &str,
) -> Result<bool> {
    let seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM memory_shard_history WHERE shard_id = ?1",
        [shard_id],
        |r| r.get(0),
    )?;
    let changed = tx.execute(
        "INSERT INTO memory_shard_history \
            (shard_id, seq, at, event, stability, base_weight, floor, factor, rank, hits_30d, \
             origin, run_id, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, ?10, ?11) \
         ON CONFLICT(shard_id, run_id, event) WHERE run_id <> '' DO NOTHING",
        params![
            shard_id, seq, at, event, stability, base_weight, floor, factor, origin, run_id, note
        ],
    )?;
    Ok(changed > 0)
}

fn require_shard(tx: &Transaction<'_>, id: i64) -> Result<ShardRow> {
    tx.query_row(
        "SELECT id, origin, state, stability, base_weight, floor, last_event_at, consolidated_into \
           FROM memory_shards WHERE id = ?1",
        [id],
        |r| {
            Ok(ShardRow {
                id: r.get(0)?,
                origin: r.get(1)?,
                state: r.get(2)?,
                stability: r.get(3)?,
                base_weight: r.get(4)?,
                floor: r.get(5)?,
                last_event_at: r.get(6)?,
                consolidated_into: r.get(7)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| ReinError::Message(format!("记忆分片不存在：{id}")))
}

/// 旧 shard 不再派生：删镜像文档 + 清掉指向它的 embed job（§6.4 第 5 步）。
fn drop_doc_and_embed(tx: &Transaction<'_>, id: i64) -> Result<()> {
    index::delete_doc(tx, "memory", &id.to_string())?;
    tx.execute(
        "DELETE FROM memory_jobs WHERE kind = 'embed' AND ref_id = CAST(?1 AS TEXT)",
        [id],
    )?;
    Ok(())
}

/// 新建/复活：标脏让镜像重建（§6.4 第 5 步）。
fn mark_doc_dirty(tx: &Transaction<'_>, id: i64) -> Result<()> {
    index::mark_dirty(tx, "memory", &id.to_string())
}

fn result_from_json(raw: Option<&str>) -> DreamApplyResult {
    let v: Value = raw
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);
    let n = |key: &str| v.get(key).and_then(Value::as_i64).unwrap_or(0);
    DreamApplyResult {
        created: n("created"),
        superseded: n("superseded"),
        consolidated: n("consolidated"),
        revived: n("revived"),
        skipped: n("skipped"),
        already_applied: true,
    }
}

fn action_to_json(action: &DreamAction) -> Value {
    match action {
        DreamAction::Supersede {
            old_shard_id,
            content,
            mem_type,
            topic,
            category,
            reason,
        } => json!({
            "type": "supersede",
            "oldShardId": old_shard_id,
            "content": content,
            "memType": mem_type,
            "topic": topic,
            "category": category,
            "reason": reason,
        }),
        DreamAction::Consolidate {
            shard_ids,
            content,
            mem_type,
            topic,
            category,
            reason,
        } => json!({
            "type": "consolidate",
            "shardIds": shard_ids,
            "content": content,
            "memType": mem_type,
            "topic": topic,
            "category": category,
            "reason": reason,
        }),
        DreamAction::Digest {
            content,
            topic,
            category,
        } => json!({
            "type": "digest",
            "content": content,
            "topic": topic,
            "category": category,
        }),
        DreamAction::Revive { shard_id, reason } => json!({
            "type": "revive",
            "shardId": shard_id,
            "reason": reason,
        }),
    }
}

// ---------------------------------------------------------------------------
// 小工具（§4.1 / §4.2 口径）
// ---------------------------------------------------------------------------

/// `mem_type`：缺省 `event`；给了未知值按 store 口径收敛 `preference`。
fn mem_type_for(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) if MEMORY_TYPES.contains(&t) => t.to_string(),
        Some(_) => "preference".to_string(),
        None => "event".to_string(),
    }
}

fn normalize_topic(raw: Option<&str>) -> String {
    raw.map(str::trim)
        .unwrap_or("")
        .chars()
        .take(40)
        .collect()
}

fn normalize_category(raw: Option<&str>) -> String {
    crate::modules::kb::memory::normalize_category(raw.unwrap_or(""))
}

/// FNV-1a 64 位（与 `index::content_hash` 同一算法）；只用于 idempotency key，不要求抗碰撞。
fn content_hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{h:016x}")
}

/// 兼容 RFC3339 与 SQLite `YYYY-MM-DD HH:MM:SS` 两种时间（§4.1）。
fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.and_utc())
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;

    const SCHEMA: &str = r#"
CREATE TABLE ai_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'AI 对话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE ai_chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  created_at TEXT NOT NULL,
  anchor_id TEXT,
  UNIQUE(chat_id, seq)
);
CREATE TABLE kb_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_consolidate INTEGER NOT NULL DEFAULT 1
);
INSERT INTO kb_settings (id) VALUES (1);

CREATE TABLE memory_shards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  mem_type TEXT NOT NULL DEFAULT 'preference',
  topic TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_hash TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  base_weight REAL NOT NULL,
  floor REAL NOT NULL,
  stability REAL NOT NULL,
  last_event_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  anchor_message_id TEXT,
  anchor_hash TEXT,
  chat_id TEXT,
  user_message_id TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  embedding BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER,
  embedding_at TEXT,
  supersedes INTEGER,
  consolidated_into INTEGER,
  dream_action TEXT,
  source_chat_id TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  legacy_memory_id INTEGER UNIQUE,
  legacy_active_count INTEGER NOT NULL DEFAULT 0,
  legacy_last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  archived_reason TEXT
);
CREATE TABLE memory_shard_history (
  shard_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  stability REAL NOT NULL,
  base_weight REAL NOT NULL,
  floor REAL NOT NULL,
  factor REAL NOT NULL DEFAULT 1.0,
  rank INTEGER,
  hits_30d INTEGER,
  origin TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (shard_id, seq)
);
CREATE UNIQUE INDEX uq_memory_shard_history_run_event
  ON memory_shard_history(shard_id, run_id, event) WHERE run_id <> '';

CREATE TABLE memory_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  chat_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE(kind, ref_id)
);
CREATE TABLE memory_dream_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  actions_json TEXT,
  result_json TEXT,
  error TEXT
);
CREATE TABLE kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE kb_chunks (doc_id INTEGER, ord INTEGER, text TEXT);
CREATE TABLE kb_dirty (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  op TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id)
);
"#;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn now() -> String {
        Utc::now().to_rfc3339()
    }

    /// 建一条测试 shard，返回 id。
    #[allow(clippy::too_many_arguments)]
    fn seed_shard(
        conn: &Connection,
        origin: &str,
        state: &str,
        stability: f64,
        base: f64,
        floor: f64,
        last_event_at: &str,
        content: &str,
    ) -> i64 {
        conn.execute(
            "INSERT INTO memory_shards \
                (idempotency_key, origin, mem_type, topic, category, content, content_hash, \
                 base_weight, floor, stability, last_event_at, state, created_at, updated_at) \
             VALUES (?1, ?2, 'preference', '', '', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                format!("seed:{}", content_hash(content)),
                origin,
                content,
                content_hash(content),
                base,
                floor,
                stability,
                last_event_at,
                state,
                now()
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn seed_run(conn: &Connection, run_id: &str) {
        conn.execute(
            "INSERT INTO memory_dream_runs (id, started_at, status) VALUES (?1, ?2, 'running')",
            params![run_id, now()],
        )
        .unwrap();
    }

    fn run_status(conn: &Connection, run_id: &str) -> String {
        conn.query_row(
            "SELECT status FROM memory_dream_runs WHERE id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn shard_state(conn: &Connection, id: i64) -> (String, Option<i64>, Option<String>) {
        conn.query_row(
            "SELECT state, consolidated_into, dream_action FROM memory_shards WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    fn history_count(conn: &Connection, event: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_shard_history WHERE event = ?1",
            [event],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn shard_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM memory_shards", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn supersede_archives_old_and_creates_new_with_history() {
        let conn = test_db();
        let old_id = seed_shard(
            &conn,
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now(),
            "膝盖深蹲不超过 60kg",
        );
        // 旧 shard 的镜像与 embed job：supersede 后都应消失。
        conn.execute(
            "INSERT INTO kb_docs (source_type, source_id) VALUES ('memory', ?1)",
            [old_id.to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_jobs (kind, ref_id, not_before, created_at, updated_at) \
             VALUES ('embed', ?1, ?2, ?2, ?2)",
            params![old_id.to_string(), now()],
        )
        .unwrap();

        seed_run(&conn, "run-supersede");
        let result = apply(
            &conn,
            "run-supersede",
            &[DreamAction::Supersede {
                old_shard_id: old_id,
                content: "膝盖有旧伤，深蹲上限调整为 40kg".into(),
                mem_type: Some("constraint".into()),
                topic: Some("膝盖".into()),
                category: Some("健康/训练".into()),
                reason: "用户更新了限制".into(),
            }],
        )
        .unwrap();

        assert_eq!(result.created, 1);
        assert_eq!(result.superseded, 1);
        assert!(!result.already_applied);
        assert_eq!(shard_state(&conn, old_id).0, "archived");

        let (origin, supersedes, dream_action, base, floor, stability): (
            String,
            Option<i64>,
            Option<String>,
            f64,
            f64,
            f64,
        ) = conn
            .query_row(
                "SELECT origin, supersedes, dream_action, base_weight, floor, stability \
                   FROM memory_shards WHERE supersedes = ?1",
                [old_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(origin, "dream_summary");
        assert_eq!(supersedes, Some(old_id));
        assert_eq!(dream_action.as_deref(), Some("supersede_new"));
        assert_eq!((base, floor, stability), (2.0, 0.10, 10.0));

        assert_eq!(history_count(&conn, "dream_supersede"), 1);
        assert_eq!(history_count(&conn, "birth"), 1);
        assert_eq!(run_status(&conn, "run-supersede"), "done");

        // 镜像同步：旧文档/旧 embed job 清掉，新 shard 标脏。
        let docs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_docs WHERE source_type='memory' AND source_id=?1",
                [old_id.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(docs, 0);
        let jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE kind='embed' AND ref_id=?1",
                [old_id.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jobs, 0);
        let dirty: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_dirty WHERE source_type='memory'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dirty, 1);
    }

    #[test]
    fn consolidate_merges_and_halves_base_weight() {
        let conn = test_db();
        let a = seed_shard(
            &conn,
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now(),
            "偏好早上训练",
        );
        let b = seed_shard(
            &conn,
            "conversation",
            "active",
            3.0,
            1.0,
            0.05,
            &now(),
            "通常 7 点去健身房",
        );
        seed_run(&conn, "run-merge");

        let result = apply(
            &conn,
            "run-merge",
            &[DreamAction::Consolidate {
                shard_ids: vec![b, a, b], // 去重后仍需 ≥2
                content: "偏好早上训练，通常 7 点去健身房".into(),
                mem_type: Some("pattern".into()),
                topic: Some("训练时间".into()),
                category: Some("健康/训练".into()),
                reason: "同义合并".into(),
            }],
        )
        .unwrap();
        assert_eq!(result.created, 1);
        assert_eq!(result.consolidated, 2);

        let merged: i64 = conn
            .query_row(
                "SELECT id FROM memory_shards WHERE dream_action = 'consolidate_merged'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for (id, expected_base) in [(a, 1.25), (b, 0.5)] {
            let (into, base): (Option<i64>, f64) = conn
                .query_row(
                    "SELECT consolidated_into, base_weight FROM memory_shards WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(into, Some(merged));
            assert!((base - expected_base).abs() < 1e-9);
        }
        assert_eq!(history_count(&conn, "dream_consolidate"), 2);
        // 合并后的 shard 也是 dream_summary。
        let origin: String = conn
            .query_row(
                "SELECT origin FROM memory_shards WHERE id = ?1",
                [merged],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(origin, "dream_summary");
    }

    #[test]
    fn digest_creates_dream_summary() {
        let conn = test_db();
        seed_run(&conn, "run-digest");
        let result = apply(
            &conn,
            "run-digest",
            &[DreamAction::Digest {
                content: "用户最近两周在调整睡眠，平均 23:30 入睡".into(),
                topic: Some("睡眠".into()),
                category: Some("生活/作息".into()),
            }],
        )
        .unwrap();
        assert_eq!(result.created, 1);
        let (origin, action, state): (String, Option<String>, String) = conn
            .query_row("SELECT origin, dream_action, state FROM memory_shards", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(origin, "dream_summary");
        assert_eq!(action.as_deref(), Some("digest"));
        assert_eq!(state, "active");
        assert_eq!(history_count(&conn, "birth"), 1);
    }

    #[test]
    fn revive_only_dormant_within_window() {
        let conn = test_db();
        let recent = (Utc::now() - ChronoDuration::days(16)).to_rfc3339();
        let too_recent = (Utc::now() - ChronoDuration::days(1)).to_rfc3339();
        let dormant = seed_shard(
            &conn,
            "conversation",
            "dormant",
            10.0,
            1.0,
            0.05,
            &recent,
            "旧偏好：晨跑",
        );
        let active = seed_shard(
            &conn,
            "conversation",
            "active",
            10.0,
            1.0,
            0.05,
            &recent,
            "仍在用",
        );
        let hot = seed_shard(
            &conn,
            "conversation",
            "dormant",
            10.0,
            1.0,
            0.05,
            &too_recent,
            "刚休眠",
        );
        let archived = seed_shard(
            &conn,
            "conversation",
            "archived",
            10.0,
            1.0,
            0.05,
            &recent,
            "已归档",
        );

        seed_run(&conn, "run-revive");
        let result = apply(
            &conn,
            "run-revive",
            &[
                DreamAction::Revive {
                    shard_id: dormant,
                    reason: "仍有价值".into(),
                },
                DreamAction::Revive {
                    shard_id: active,
                    reason: String::new(),
                },
                DreamAction::Revive {
                    shard_id: hot,
                    reason: String::new(),
                },
                DreamAction::Revive {
                    shard_id: archived,
                    reason: String::new(),
                },
            ],
        )
        .unwrap();

        assert_eq!(result.revived, 1);
        assert_eq!(result.skipped, 3);
        let (state, stability): (String, f64) = conn
            .query_row(
                "SELECT state, stability FROM memory_shards WHERE id = ?1",
                [dormant],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "active");
        assert!((stability - 12.5).abs() < 1e-9);
        assert_eq!(history_count(&conn, "dream_revive"), 1);
        let factor: f64 = conn
            .query_row(
                "SELECT factor FROM memory_shard_history WHERE event = 'dream_revive'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!((factor - 1.25).abs() < 1e-9);
    }

    #[test]
    fn mark_important_is_forbidden_and_unknown_type_errors() {
        let err = decode_actions(vec![json!({
            "type": "mark_important",
            "shardId": 7,
            "note": "很重要"
        })])
        .unwrap_err();
        assert_eq!(err.code(), "dream_action_forbidden");
        assert!(err.to_string().contains("不能标记重要"));

        let err = decode_actions(vec![json!({"type": "forge", "content": "x"})]).unwrap_err();
        assert!(err.to_string().contains("无法识别"));

        // 即使绕过 decode，类型层也不接受 mark_important。
        let typed = serde_json::from_value::<DreamAction>(json!({
            "type": "mark_important",
            "shardId": 7
        }));
        assert!(typed.is_err());
    }

    #[test]
    fn replay_same_run_is_idempotent() {
        let conn = test_db();
        seed_run(&conn, "run-idem");
        let action = DreamAction::Digest {
            content: "一条梦境摘要".into(),
            topic: None,
            category: None,
        };
        let first = apply(&conn, "run-idem", &[action.clone()]).unwrap();
        assert_eq!(first.created, 1);
        assert!(!first.already_applied);

        let second = apply(&conn, "run-idem", &[action]).unwrap();
        assert!(second.already_applied);
        assert_eq!(second.created, 1);
        assert_eq!(shard_count(&conn), 1);
        assert_eq!(history_count(&conn, "birth"), 1);
    }

    #[test]
    fn duplicate_idempotency_key_is_skipped() {
        let conn = test_db();
        let content = "重复的摘要";
        let key = format!("dream:run-dup:digest:{}", content_hash(content));
        conn.execute(
            "INSERT INTO memory_shards \
                (idempotency_key, origin, content, base_weight, floor, stability, \
                 last_event_at, created_at, updated_at) \
             VALUES (?1, 'dream_summary', ?2, 2.0, 0.1, 10.0, ?3, ?3, ?3)",
            params![key, content, now()],
        )
        .unwrap();
        seed_run(&conn, "run-dup");

        let result = apply(
            &conn,
            "run-dup",
            &[DreamAction::Digest {
                content: content.into(),
                topic: None,
                category: None,
            }],
        )
        .unwrap();
        assert_eq!(result.created, 0);
        assert_eq!(result.skipped, 1);
        assert_eq!(shard_count(&conn), 1);
    }

    #[test]
    fn invalid_action_rolls_back_whole_batch() {
        let conn = test_db();
        let _old_id = seed_shard(
            &conn,
            "manual_write",
            "active",
            20.0,
            2.5,
            0.15,
            &now(),
            "旧记忆",
        );
        seed_run(&conn, "run-rollback");

        let err = apply(
            &conn,
            "run-rollback",
            &[
                DreamAction::Digest {
                    content: "本应被回滚的摘要".into(),
                    topic: None,
                    category: None,
                },
                DreamAction::Supersede {
                    old_shard_id: 999_999,
                    content: "指向不存在的 shard".into(),
                    mem_type: None,
                    topic: None,
                    category: None,
                    reason: String::new(),
                },
            ],
        )
        .unwrap_err();
        assert!(err.to_string().contains("999999"));
        // 整批回滚：digest 没有落库，history 没有多行，run 仍可重试。
        assert_eq!(shard_count(&conn), 1);
        assert_eq!(history_count(&conn, "birth"), 0);
        assert_eq!(run_status(&conn, "run-rollback"), "running");

        // 修正后同一 run 可以继续用。
        let ok = apply(
            &conn,
            "run-rollback",
            &[DreamAction::Digest {
                content: "修正后的摘要".into(),
                topic: None,
                category: None,
            }],
        )
        .unwrap();
        assert_eq!(ok.created, 1);
        assert_eq!(run_status(&conn, "run-rollback"), "done");
    }

    #[test]
    fn gate_enforces_cooldown_material_and_lease() {
        let conn = test_db();
        // 空库：没有素材。
        let empty = begin(&conn, false).unwrap();
        assert!(!empty.gate.eligible);
        assert_eq!(empty.gate.reason, "no_material");

        // 1 个会话 + 4 条消息：素材不足，force 也不能跳过。
        conn.execute(
            "INSERT INTO ai_chats (id, created_at, updated_at) VALUES ('c1', ?1, ?1)",
            [now()],
        )
        .unwrap();
        for i in 0..4 {
            conn.execute(
                "INSERT INTO ai_chat_messages (id, chat_id, seq, role, kind, text, created_at) \
                 VALUES (?1, 'c1', ?2, 'user', 'text', ?3, ?4)",
                params![format!("m{i}"), i + 1, format!("消息 {i}"), now()],
            )
            .unwrap();
        }
        let low = begin(&conn, true).unwrap();
        assert!(!low.gate.eligible);
        assert_eq!(low.gate.reason, "insufficient_material");

        // 第 5 条 → 可触发。
        conn.execute(
            "INSERT INTO ai_chat_messages (id, chat_id, seq, role, kind, text, created_at) \
             VALUES ('m5', 'c1', 5, 'user', 'text', '第五条', ?1)",
            [now()],
        )
        .unwrap();
        let ok = begin(&conn, false).unwrap();
        assert!(ok.gate.eligible);
        assert_eq!(ok.gate.reason, "ok");
        let run_id = ok.run_id.unwrap();
        let ctx = ok.context.unwrap();
        assert_eq!(ctx.sessions.len(), 1);
        assert_eq!(ctx.sessions[0].messages.len(), 5);

        // running lease 挡住第二轮。
        let blocked = begin(&conn, true).unwrap();
        assert!(!blocked.gate.eligible);
        assert_eq!(blocked.gate.reason, "running");

        cancel(&conn, &run_id, Some("测试结束")).unwrap();
        assert_eq!(run_status(&conn, &run_id), "failed");

        // 手动把上一次 run 标记为 done（5 分钟前）→ 冷却，但素材仍在窗口内。
        conn.execute(
            "UPDATE memory_dream_runs SET status='done', finished_at=?1, error=NULL WHERE id=?2",
            params![
                (Utc::now() - ChronoDuration::minutes(5)).to_rfc3339(),
                run_id
            ],
        )
        .unwrap();
        let cooled = begin(&conn, false).unwrap();
        assert!(!cooled.gate.eligible);
        assert_eq!(cooled.gate.reason, "cooldown");
        // force 跳过冷却。
        let forced = begin(&conn, true).unwrap();
        assert!(forced.gate.eligible);
        cancel(&conn, forced.run_id.as_deref().unwrap(), None).unwrap();

        // 把 done 时间推回 4 小时前，让窗口内仍能看到这 5 条消息。
        conn.execute(
            "UPDATE memory_dream_runs SET finished_at=?1 WHERE id=?2",
            params![(Utc::now() - ChronoDuration::hours(4)).to_rfc3339(), run_id],
        )
        .unwrap();

        // 开关关闭 → disabled（force 仍可跑）。
        conn.execute("UPDATE kb_settings SET auto_consolidate = 0 WHERE id = 1", [])
            .unwrap();
        let disabled = begin(&conn, false).unwrap();
        assert_eq!(disabled.gate.reason, "disabled");
        let forced = begin(&conn, true).unwrap();
        assert!(forced.gate.eligible);
        cancel(&conn, forced.run_id.as_deref().unwrap(), None).unwrap();
    }

    #[test]
    fn context_caps_sessions_messages_and_strips_images() {
        let conn = test_db();
        let t0 = (Utc::now() - ChronoDuration::minutes(30)).to_rfc3339();
        for c in 0..12 {
            let chat = format!("chat{c}");
            conn.execute(
                "INSERT INTO ai_chats (id, title, created_at, updated_at) VALUES (?1, ?1, ?2, ?2)",
                params![chat, t0],
            )
            .unwrap();
            for m in 0..20 {
                let (role, kind) = if m % 3 == 0 {
                    ("user", "text")
                } else {
                    ("assistant", "analysis")
                };
                conn.execute(
                    "INSERT INTO ai_chat_messages \
                        (id, chat_id, seq, role, kind, text, created_at, anchor_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                    params![
                        format!("{chat}-m{m}"),
                        chat,
                        m + 1,
                        role,
                        kind,
                        format!("{chat}-{m}"),
                        (Utc::now() - ChronoDuration::minutes(30 - c as i64)).to_rfc3339()
                    ],
                )
                .unwrap();
            }
        }
        let begin = begin(&conn, true).unwrap();
        let ctx = begin.context.unwrap();
        assert_eq!(ctx.sessions.len(), DREAM_CONTEXT_MAX_SESSIONS);
        // 240 条里只取最近 200 条（chat0/1 被截掉），再按会话上限留 8 个 ×20。
        let total: usize = ctx.sessions.iter().map(|s| s.messages.len()).sum();
        assert_eq!(total, 160);
        // 会话按最近活跃倒序，chat11 在最前。
        assert_eq!(ctx.sessions[0].chat_id, "chat11");
    }
}
