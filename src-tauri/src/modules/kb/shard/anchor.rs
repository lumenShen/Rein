//! 会话锚点：回合查询与同步消息补锚（§2.5 / §3.2 / 附录 C）。
//!
//! anchor 是 `ai_chat_messages.id`（字符串），不是 shard id；`anchor_message_id`
//! 是跨设备稳定键。0054 回填后由 `ai_chat_append` 维护，本模块只读与对账。
//!
//! 回合定义（与 0054 逐字一致）：
//! - 一条 `role='user'` 消息开始新回合；其后的连续 assistant 归入该回合；
//!   第一条 user 之前的 assistant 归 turn 0；
//! - anchor = 回合内最后一条 terminal assistant（text/analysis 有正文，或 food-parse），
//!   没有 terminal 时退化为该回合最后一条 assistant；没有 assistant 的回合没有 anchor；
//! - 回合内每条消息都写同一个 anchor id，anchor 自身 `anchor_id = id`。
//!
//! 本模块**不**决定 shard 是否生成：`process_extract` 只对可读文本的 terminal 建 shard
//! （food-parse-only / tools fallback 只用于分段、跳转与撤回清理，§3.2）。

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::Result;
use crate::modules::ai::models::AiChatMessage;
use crate::modules::kb::chunk::chunk_text;

use super::model::SHARD_MAX_CHARS;

/// `process_extract` 需要的 anchor 行（§3.2 第 1 步的 SELECT）。
/// 不携带 `image_base64`；`payload` 用于提取 thinking/segments。
#[derive(Debug, Clone)]
pub struct AnchorRow {
    pub id: String,
    pub chat_id: String,
    pub seq: i64,
    pub kind: String,
    pub text: Option<String>,
    pub payload: Option<String>,
    pub created_at: String,
}

/// terminal 判定（§2.5 / §3.2）：text/analysis 必须有正文；food-parse 允许空正文。
/// `voice` 是 user 消息，不在此集合；`tools` 是过程消息，永远不是 terminal。
pub fn is_terminal_assistant(role: &str, kind: &str, text: Option<&str>) -> bool {
    if role != "assistant" {
        return false;
    }
    match kind {
        "text" | "analysis" => text.map(|t| !t.trim().is_empty()).unwrap_or(false),
        "food-parse" => true,
        _ => false,
    }
}

/// 当前会话的 anchor（每回合一条；`anchor_id = id` 的 assistant 消息）（附录 C）。
///
/// 返回 seq 最大的那条：即最近一个回合的 anchor。
pub fn current_anchor(conn: &Connection, chat_id: &str) -> Result<Option<AnchorRow>> {
    let row = conn
        .query_row(
            "SELECT id, chat_id, seq, kind, text, payload, created_at
             FROM ai_chat_messages
             WHERE chat_id = ?1 AND role = 'assistant' AND anchor_id = id
             ORDER BY seq DESC LIMIT 1",
            [chat_id],
            |r| {
                Ok(AnchorRow {
                    id: r.get(0)?,
                    chat_id: r.get(1)?,
                    seq: r.get(2)?,
                    kind: r.get(3)?,
                    text: r.get(4)?,
                    payload: r.get(5)?,
                    created_at: r.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// 取指定 anchor 的行（`process_extract` 第 1 步；要求 `anchor_id = id`）。
///
/// 找不到（消息被撤回 / anchor 已移动）返回 `None`。
pub fn anchor_row(conn: &Connection, anchor_id: &str) -> Result<Option<AnchorRow>> {
    let row = conn
        .query_row(
            "SELECT id, chat_id, seq, kind, text, payload, created_at
             FROM ai_chat_messages
             WHERE id = ?1 AND anchor_id = id AND role = 'assistant'",
            [anchor_id],
            |r| {
                Ok(AnchorRow {
                    id: r.get(0)?,
                    chat_id: r.get(1)?,
                    seq: r.get(2)?,
                    kind: r.get(3)?,
                    text: r.get(4)?,
                    payload: r.get(5)?,
                    created_at: r.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// 查某条消息所属回合的 anchor id；消息不存在/无 anchor 返回 `None`（附录 C）。
pub fn anchor_for_message(
    conn: &Connection,
    chat_id: &str,
    message_id: &str,
) -> Result<Option<String>> {
    let row: Option<Option<String>> = conn
        .query_row(
            "SELECT anchor_id FROM ai_chat_messages WHERE id = ?1 AND chat_id = ?2",
            rusqlite::params![message_id, chat_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row.flatten())
}

/// 取某 anchor 回合的全部消息（按 seq 升序，含 payload）（§3.2 第 4 步 / 附录 C）。
///
/// `image_base64` 一律返回 `None`：提取只需要文本与 payload，整回合读 base64 会
/// 在长会话/多图回合里占几十 MB 内存（方案 §6.3 的同一纪律）。
pub fn turn_messages(
    conn: &Connection,
    chat_id: &str,
    anchor_id: &str,
) -> Result<Vec<AiChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, seq, role, kind, text, payload, created_at, anchor_id
         FROM ai_chat_messages
         WHERE chat_id = ?1 AND anchor_id = ?2
         ORDER BY seq ASC",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![chat_id, anchor_id], |r| {
            Ok(AiChatMessage {
                id: r.get(0)?,
                chat_id: r.get(1)?,
                seq: r.get(2)?,
                role: r.get(3)?,
                kind: r.get(4)?,
                text: r.get(5)?,
                image_base64: None,
                mime: None,
                payload: r.get(6)?,
                created_at: r.get(7)?,
                anchor_id: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// conversation shard 的语义切块（§3.2 第 6 步）：复用 `chunk.rs` 的预算切分。
///
/// `SHARD_MAX_CHARS=1800` 是单条注入预算的硬上限；重叠 100 字保证跨块短语仍可检索。
pub fn semantic_chunks(text: &str) -> Vec<String> {
    chunk_text(text, SHARD_MAX_CHARS, 100)
}

fn truncate_chars(raw: &str, max: usize) -> String {
    let mut out: String = raw.chars().take(max).collect();
    if raw.chars().count() > max {
        out.push('…');
    }
    out
}

fn payload_of(raw: &Option<String>) -> Option<Value> {
    raw.as_deref().and_then(|s| serde_json::from_str(s).ok())
}

/// 从回合消息提取 provenance（§3.2 第 5 步）：
/// - `reasoningDigest`：assistant 的 `payload.thinking` + `payload.segments(kind=reasoning)`
///   拼接，截 500 字（旧格式 `payload.reasoning` 也认）；
/// - `toolCalls`：`payload.segments(kind=tool)` 的 `{name, ok, brief}`，最多 8 条；
///   旧格式 `payload.calls` 兜底；
/// - `userText`：回合第一条 user 文本，截 500 字；
/// - `anchorSeq` / `messageIds` / `anchorHash`。
pub fn build_provenance(
    anchor: &AnchorRow,
    messages: &[AiChatMessage],
    anchor_hash: &str,
) -> Value {
    let mut reasoning = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut legacy_calls: Vec<Value> = Vec::new();

    for m in messages.iter().filter(|m| m.role == "assistant") {
        let Some(p) = payload_of(&m.payload) else { continue };
        if let Some(t) = p.get("thinking").and_then(|v| v.as_str()) {
            if !t.trim().is_empty() {
                reasoning.push_str(t);
                reasoning.push('\n');
            }
        }
        if let Some(t) = p.get("reasoning").and_then(|v| v.as_str()) {
            if !t.trim().is_empty() {
                reasoning.push_str(t);
                reasoning.push('\n');
            }
        }
        if let Some(segments) = p.get("segments").and_then(|v| v.as_array()) {
            for seg in segments {
                match seg.get("kind").and_then(|v| v.as_str()) {
                    Some("reasoning") => {
                        if let Some(t) = seg.get("text").and_then(|v| v.as_str()) {
                            reasoning.push_str(t);
                            reasoning.push('\n');
                        }
                    }
                    Some("tool") => {
                        let Some(call) = seg.get("call") else { continue };
                        let name = call
                            .get("rawName")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .or_else(|| call.get("toolName").and_then(|v| v.as_str()))
                            .unwrap_or("tool");
                        let pending = call.get("pending").and_then(|v| v.as_bool()).unwrap_or(false);
                        let is_error = call.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
                        let brief = call
                            .get("result")
                            .and_then(|v| v.as_str())
                            .or_else(|| call.get("arguments").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        tool_calls.push(json!({
                            "name": name,
                            "ok": !pending && !is_error,
                            "brief": truncate_chars(brief, 200),
                        }));
                    }
                    _ => {}
                }
            }
        }
        // 旧格式（无 segments）：payload.calls
        if let Some(calls) = p.get("calls").and_then(|v| v.as_array()) {
            for call in calls {
                let name = call
                    .get("name")
                    .and_then(|v| v.as_str())
                    .or_else(|| call.get("label").and_then(|v| v.as_str()))
                    .unwrap_or("tool");
                let ok = call.get("status").and_then(|v| v.as_str()) == Some("ok");
                let brief = call
                    .get("resultBrief")
                    .and_then(|v| v.as_str())
                    .or_else(|| call.get("argsBrief").and_then(|v| v.as_str()))
                    .unwrap_or("");
                legacy_calls.push(json!({
                    "name": name,
                    "ok": ok,
                    "brief": truncate_chars(brief, 200),
                }));
            }
        }
    }
    if tool_calls.is_empty() {
        tool_calls = legacy_calls;
    }
    tool_calls.truncate(8);

    let user_text = messages
        .iter()
        .find(|m| m.role == "user")
        .and_then(|m| m.text.clone())
        .unwrap_or_default();
    let user_message_id = messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.id.clone());

    json!({
        "reasoningDigest": truncate_chars(reasoning.trim(), 500),
        "toolCalls": tool_calls,
        "userText": truncate_chars(&user_text, 500),
        "userMessageId": user_message_id,
        "anchorSeq": anchor.seq,
        "messageIds": messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        "anchorHash": anchor_hash,
    })
}

struct BackfillMsg {
    id: String,
    seq: i64,
    role: String,
    kind: String,
    text: Option<String>,
    anchor_id: Option<String>,
}

/// 只对最近 N 天、`anchor_id IS NULL` 的消息按回合补 anchor（terminal/fallback 规则，§3.2）。
///
/// 不做全表 UPDATE，避免 sync 副作用；返回更新行数。
///
/// 跨设备同步进来的消息不会经过 `ai_chat_append`，anchor_id 是 NULL；worker 启动/6h 调
/// 本函数补齐，之后 `reconcile_conversation_shards` 才能据此清理/补投 conversation shard。
/// 只处理「含最近 NULL 消息」的会话，且只在回合内已有 anchor 时继承它（不移动 anchor），
/// 否则按 terminal/fallback 规则选出 anchor —— 与 0054 的回填口径一致。
pub fn backfill_missing(conn: &Connection, recent_days: i64) -> Result<i64> {
    let chats: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT chat_id FROM ai_chat_messages
             WHERE anchor_id IS NULL
               AND julianday(created_at) >= julianday('now', ?1)
             ORDER BY chat_id",
        )?;
        let rows = stmt
            .query_map([format!("-{recent_days} days")], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    if chats.is_empty() {
        return Ok(0);
    }

    let tx = conn.unchecked_transaction()?;
    let mut updated = 0i64;
    for chat_id in chats {
        let messages: Vec<BackfillMsg> = {
            let mut stmt = tx.prepare(
                "SELECT id, seq, role, kind, text, anchor_id
                 FROM ai_chat_messages WHERE chat_id = ?1 ORDER BY seq ASC",
            )?;
            let rows = stmt
                .query_map([chat_id.as_str()], |r| {
                    Ok(BackfillMsg {
                        id: r.get(0)?,
                        seq: r.get(1)?,
                        role: r.get(2)?,
                        kind: r.get(3)?,
                        text: r.get(4)?,
                        anchor_id: r.get(5)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };

        // 按回合切分：每条 user 开启新回合；第一条 user 之前的 assistant 归 turn 0。
        let mut turns: Vec<Vec<&BackfillMsg>> = Vec::new();
        let mut current: Vec<&BackfillMsg> = Vec::new();
        for m in &messages {
            if m.role == "user" && !current.is_empty() {
                turns.push(std::mem::take(&mut current));
            }
            current.push(m);
        }
        if !current.is_empty() {
            turns.push(current);
        }

        for turn in turns {
            if !turn.iter().any(|m| m.anchor_id.is_none()) {
                continue;
            }
            let existing = turn
                .iter()
                .filter(|m| m.anchor_id.as_deref() == Some(m.id.as_str()))
                .last()
                .map(|m| m.id.clone());
            let anchor = if let Some(existing) = existing {
                // 回合已有 anchor（live 路径打过标）：新同步进来的 NULL 行继承它，不移动 anchor。
                Some(existing)
            } else {
                let terminal = turn
                    .iter()
                    .filter(|m| is_terminal_assistant(&m.role, &m.kind, m.text.as_deref()))
                    .max_by_key(|m| m.seq)
                    .map(|m| m.id.clone());
                terminal.or_else(|| {
                    turn.iter()
                        .filter(|m| m.role == "assistant")
                        .max_by_key(|m| m.seq)
                        .map(|m| m.id.clone())
                })
            };
            let Some(anchor) = anchor else { continue };
            let start = turn.first().map(|m| m.seq).unwrap_or(0);
            let end = turn.last().map(|m| m.seq).unwrap_or(0);
            updated += tx.execute(
                "UPDATE ai_chat_messages SET anchor_id = ?1
                 WHERE chat_id = ?2 AND seq >= ?3 AND seq <= ?4 AND anchor_id IS NULL",
                rusqlite::params![anchor, chat_id, start, end],
            )? as i64;
        }
    }
    tx.commit()?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn.execute(
            "INSERT INTO ai_chats(id, title, created_at, updated_at)
             VALUES ('c','t',datetime('now'),datetime('now'))",
            [],
        )
        .unwrap();
        conn
    }

    /// `at_sql` 是 SQLite 时间表达式（如 `datetime('now','-60 days')`），便于窗口测试。
    fn ins(conn: &Connection, id: &str, seq: i64, role: &str, kind: &str, text: Option<&str>, at_sql: &str) {
        conn.execute(
            &format!(
                "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, created_at)
                 VALUES (?1, 'c', ?2, ?3, ?4, ?5, {at_sql})"
            ),
            rusqlite::params![id, seq, role, kind, text],
        )
        .unwrap();
    }

    fn anchor_of(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT anchor_id FROM ai_chat_messages WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn backfill_missing_fills_synced_messages_by_turn() {
        let conn = fresh();
        ins(&conn, "a0", 0, "assistant", "text", Some("开场"), "datetime('now')");
        ins(&conn, "u1", 1, "user", "text", Some("问"), "datetime('now')");
        ins(&conn, "a1", 2, "assistant", "text", Some("答"), "datetime('now')");
        ins(&conn, "u2", 3, "user", "text", Some("再问"), "datetime('now')");
        ins(&conn, "a2", 4, "assistant", "tools", None, "datetime('now')");
        ins(&conn, "a3", 5, "assistant", "text", Some("再答"), "datetime('now')");

        let n = backfill_missing(&conn, 30).unwrap();
        assert_eq!(n, 6, "六条 NULL 消息都应被补上");

        assert_eq!(anchor_of(&conn, "a0").as_deref(), Some("a0"));
        assert_eq!(anchor_of(&conn, "u1").as_deref(), Some("a1"));
        assert_eq!(anchor_of(&conn, "a1").as_deref(), Some("a1"));
        // terminal a3 优先于其后的过程消息（这里 a2 在 a3 前，仍是 a3）
        assert_eq!(anchor_of(&conn, "u2").as_deref(), Some("a3"));
        assert_eq!(anchor_of(&conn, "a2").as_deref(), Some("a3"));
        assert_eq!(anchor_of(&conn, "a3").as_deref(), Some("a3"));
    }

    #[test]
    fn backfill_missing_falls_back_to_last_assistant() {
        let conn = fresh();
        ins(&conn, "u1", 1, "user", "text", Some("问"), "datetime('now')");
        ins(&conn, "a1", 2, "assistant", "tools", None, "datetime('now')");
        ins(&conn, "a2", 3, "assistant", "analysis", Some("   "), "datetime('now')");

        assert_eq!(backfill_missing(&conn, 30).unwrap(), 3);
        assert_eq!(
            anchor_of(&conn, "u1").as_deref(),
            Some("a2"),
            "没有 terminal 时退化为最后一条 assistant"
        );
        assert_eq!(anchor_of(&conn, "a2").as_deref(), Some("a2"));
    }

    #[test]
    fn backfill_missing_skips_turn_without_assistant() {
        let conn = fresh();
        ins(&conn, "u1", 1, "user", "text", Some("问"), "datetime('now')");
        assert_eq!(backfill_missing(&conn, 30).unwrap(), 0);
        assert_eq!(anchor_of(&conn, "u1"), None);
    }

    #[test]
    fn backfill_missing_ignores_old_messages() {
        let conn = fresh();
        ins(
            &conn,
            "u1",
            1,
            "user",
            "text",
            Some("旧"),
            "datetime('now','-60 days')",
        );
        ins(
            &conn,
            "a1",
            2,
            "assistant",
            "text",
            Some("旧答"),
            "datetime('now','-60 days')",
        );
        assert_eq!(backfill_missing(&conn, 30).unwrap(), 0);
        assert_eq!(anchor_of(&conn, "u1"), None);
        assert_eq!(anchor_of(&conn, "a1"), None);
    }

    #[test]
    fn backfill_missing_inherits_existing_anchor_and_does_not_move_it() {
        let conn = fresh();
        ins(&conn, "u1", 1, "user", "text", Some("问"), "datetime('now')");
        ins(&conn, "a1", 2, "assistant", "text", Some("答"), "datetime('now')");
        // live 路径已经把回合 anchor 打成 a1
        conn.execute(
            "UPDATE ai_chat_messages SET anchor_id='a1' WHERE seq IN (1,2)",
            [],
        )
        .unwrap();
        // 同步晚到的一条过程消息（NULL），它不该把 anchor 移到自己身上
        ins(&conn, "a2", 3, "assistant", "tools", None, "datetime('now')");

        assert_eq!(backfill_missing(&conn, 30).unwrap(), 1);
        assert_eq!(anchor_of(&conn, "a2").as_deref(), Some("a1"));
        assert_eq!(anchor_of(&conn, "u1").as_deref(), Some("a1"));
    }

    #[test]
    fn current_anchor_and_anchor_for_message() {
        let conn = fresh();
        ins(&conn, "u1", 1, "user", "text", Some("一"), "datetime('now')");
        ins(&conn, "a1", 2, "assistant", "text", Some("答一"), "datetime('now')");
        ins(&conn, "u2", 3, "user", "text", Some("二"), "datetime('now')");
        ins(&conn, "a2", 4, "assistant", "text", Some("答二"), "datetime('now')");
        conn.execute(
            "UPDATE ai_chat_messages SET anchor_id = CASE seq WHEN 1 THEN 'a1' WHEN 2 THEN 'a1'
                                                             WHEN 3 THEN 'a2' ELSE 'a2' END",
            [],
        )
        .unwrap();

        let cur = current_anchor(&conn, "c").unwrap().unwrap();
        assert_eq!(cur.id, "a2");
        assert_eq!(cur.seq, 4);
        assert_eq!(cur.kind, "text");

        assert_eq!(
            anchor_for_message(&conn, "c", "u1").unwrap().as_deref(),
            Some("a1")
        );
        assert_eq!(anchor_for_message(&conn, "c", "missing").unwrap(), None);
        assert_eq!(anchor_for_message(&conn, "other", "u1").unwrap(), None);
    }

    #[test]
    fn turn_messages_returns_seq_order_and_omits_base64() {
        let conn = fresh();
        ins(&conn, "u1", 1, "user", "text", Some("问"), "datetime('now')");
        conn.execute(
            "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, image_base64, payload, created_at)
             VALUES ('p1','c',2,'user','photo',NULL,'QUFBQUFB','{\"k\":1}',datetime('now'))",
            [],
        )
        .unwrap();
        ins(&conn, "a1", 3, "assistant", "text", Some("答"), "datetime('now')");
        conn.execute("UPDATE ai_chat_messages SET anchor_id='a1'", [])
            .unwrap();

        let msgs = turn_messages(&conn, "c", "a1").unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert!(msgs.iter().all(|m| m.image_base64.is_none()), "不能把 base64 带进提取上下文");
        assert_eq!(msgs[1].payload.as_deref(), Some("{\"k\":1}"));
    }

    #[test]
    fn semantic_chunks_respect_shard_max_chars() {
        // 4000 个无标点字符：不能靠句读断，按 max_chars=1800 切成 3 块
        let text = "长".repeat(4000);
        let chunks = semantic_chunks(&text);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.chars().count() <= SHARD_MAX_CHARS));
        assert!(semantic_chunks("   ").is_empty(), "空文本不产生块");
    }

    #[test]
    fn provenance_captures_reasoning_tools_and_user_text() {
        let anchor = AnchorRow {
            id: "a1".into(),
            chat_id: "c".into(),
            seq: 4,
            kind: "text".into(),
            text: Some("回答".into()),
            payload: None,
            created_at: "2026-01-02T00:00:00+00:00".into(),
        };
        let msg = |id: &str, seq: i64, role: &str, payload: Option<&str>| AiChatMessage {
            id: id.into(),
            chat_id: "c".into(),
            seq,
            role: role.into(),
            kind: "text".into(),
            text: Some("正文".into()),
            image_base64: None,
            mime: None,
            payload: payload.map(str::to_string),
            created_at: "2026-01-02T00:00:00+00:00".into(),
            anchor_id: Some("a1".into()),
        };
        let payload = json!({
            "thinking": "用户偏好浅烘",
            "segments": [
                {"kind":"reasoning","text":"先回忆旧结论"},
                {"kind":"tool","call":{"toolName":"search_memories","rawName":"search_memories","arguments":"{}","result":"ok","pending":false,"isError":false}},
                {"kind":"tool","call":{"toolName":"remember","rawName":"remember","arguments":"{}","result":"boom","pending":false,"isError":true}}
            ]
        })
        .to_string();
        let msgs = vec![
            msg("u1", 3, "user", None),
            msg("a1", 4, "assistant", Some(&payload)),
        ];

        let p = build_provenance(&anchor, &msgs, "hash-1");
        assert!(p["reasoningDigest"]
            .as_str()
            .unwrap()
            .contains("用户偏好浅烘"));
        assert!(p["reasoningDigest"]
            .as_str()
            .unwrap()
            .contains("先回忆旧结论"));
        let tools = p["toolCalls"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "search_memories");
        assert_eq!(tools[0]["ok"], true);
        assert_eq!(tools[1]["ok"], false, "isError 的工具调用不能标 ok");
        assert_eq!(p["userText"], "正文", "取回合第一条 user 文本");
        assert_eq!(p["userMessageId"], "u1");
        assert_eq!(p["anchorSeq"], 4);
        assert_eq!(p["anchorHash"], "hash-1");
        assert_eq!(p["messageIds"].as_array().unwrap().len(), 2);
    }
}
