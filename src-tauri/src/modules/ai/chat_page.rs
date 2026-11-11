//! 会话分页与锚点（方案 §8 / §9.2 / §10 D）。
//!
//! 边界规则：
//! - **回合** = 一条 `role='user'` + 其后连续的 `role='assistant'`，直到下一条 user；
//!   第一条 user 之前的 assistant 归入 turn 0。
//! - 分页按**完整回合**切；游标是数值 `seq` 边界（exclusive），不要求对应消息仍存在。
//!   `ai_chat_cut` 留下的 seq 空洞是稳定边界：`ai_chat_seq` 只增不减，撤回后不会复用旧 seq。
//! - `before_seq` 与 `after_seq` 互斥；`limit_turns` 默认 16、clamp 1..50。
//! - 没有 user 消息的 legacy 会话返回全部（超过 `LEGACY_PAGE_MAX_MESSAGES` 时只回最后 1000 条，
//!   `has_more_before=true`），这是极端存量会话的兜底。
//!
//! 历史 `anchor_id` 的主回填路径是 0054 迁移；本模块的 `backfill_chat_anchors` 是
//! 「列已加、数据未回填」旧库的**懒回填**兜底（幂等、只补 NULL、只动当前会话）。
//! 规则与迁移一致：terminal assistant 优先（text/analysis 有正文或 food-parse 无论正文），
//! 没有 terminal 时退化为回合最后一条 assistant；没有 assistant 的回合保持 NULL。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{ReinError, Result};

use super::models::{AiChatMessage, AiChatPage};

/// 默认每页回合数（≥12 才能覆盖 16 条历史上下文 / 24 条抽取 / 6 张食物卡 / 3 条纪要）。
pub const DEFAULT_PAGE_TURNS: i64 = 16;
/// 单页回合数上限。
pub const MAX_PAGE_TURNS: i64 = 50;
/// 无 user 消息的 legacy 会话单页消息上限。
pub const LEGACY_PAGE_MAX_MESSAGES: i64 = 1000;

/// `ai_chat_messages` 的公共列清单（与 `AiChatMessage` 字段顺序一致）。
const MSG_COLS: &str = "id, chat_id, seq, role, kind, text, image_base64, mime, payload, created_at, anchor_id";

fn message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiChatMessage> {
    Ok(AiChatMessage {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        seq: row.get(2)?,
        role: row.get(3)?,
        kind: row.get(4)?,
        text: row.get(5)?,
        image_base64: row.get(6)?,
        mime: row.get(7)?,
        payload: row.get(8)?,
        created_at: row.get(9)?,
        anchor_id: row.get(10)?,
    })
}

fn clamp_turns(limit_turns: Option<i64>) -> i64 {
    limit_turns
        .unwrap_or(DEFAULT_PAGE_TURNS)
        .clamp(1, MAX_PAGE_TURNS)
}

fn fetch_messages(
    conn: &Connection,
    chat_id: &str,
    start_inclusive: i64,
    end_exclusive: i64,
) -> Result<Vec<AiChatMessage>> {
    let sql = format!(
        "SELECT {MSG_COLS} FROM ai_chat_messages \
         WHERE chat_id = ?1 AND seq >= ?2 AND seq < ?3 ORDER BY seq ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![chat_id, start_inclusive, end_exclusive], message_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn exists_seq_before(conn: &Connection, chat_id: &str, seq: i64) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_chat_messages WHERE chat_id = ?1 AND seq < ?2)",
        params![chat_id, seq],
        |r| r.get(0),
    )?)
}

fn exists_seq_at_or_after(conn: &Connection, chat_id: &str, seq: i64) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_chat_messages WHERE chat_id = ?1 AND seq >= ?2)",
        params![chat_id, seq],
        |r| r.get(0),
    )?)
}

fn exists_seq_at_or_before(conn: &Connection, chat_id: &str, seq: i64) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_chat_messages WHERE chat_id = ?1 AND seq <= ?2)",
        params![chat_id, seq],
        |r| r.get(0),
    )?)
}

/// 一页消息。`before_seq` 与 `after_seq` 互斥；两者都不传 = 最新一页（tail）。
///
/// 返回的 `next_before_seq` / `next_after_seq` 只在对应方向还有更多消息时非空，
/// 且都是**数值边界**，可以直接传给下一次调用，即使它指向的消息已经被撤回。
pub(crate) fn chat_page_conn(
    conn: &Connection,
    chat_id: &str,
    before_seq: Option<i64>,
    after_seq: Option<i64>,
    limit_turns: Option<i64>,
) -> Result<AiChatPage> {
    if before_seq.is_some() && after_seq.is_some() {
        return Err(ReinError::Message(
            "before_seq 与 after_seq 不能同时使用".into(),
        ));
    }
    let limit = clamp_turns(limit_turns);
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ai_chat_messages WHERE chat_id = ?1",
        [chat_id],
        |r| r.get(0),
    )?;

    let has_user: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_chat_messages WHERE chat_id = ?1 AND role = 'user')",
        [chat_id],
        |r| r.get(0),
    )?;
    if !has_user {
        return page_without_users(conn, chat_id, before_seq, after_seq, total);
    }

    let (messages, has_more_before, has_more_after) = if let Some(after) = after_seq {
        // 向后翻：从 after 之后最早的 limit 个回合起点开始。
        let starts = conn
            .prepare(
                "SELECT seq FROM ai_chat_messages \
                 WHERE chat_id = ?1 AND role = 'user' AND seq > ?2 \
                 ORDER BY seq ASC LIMIT ?3",
            )?
            .query_map(params![chat_id, after, limit + 1], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut has_more_after = false;
        let end = if starts.len() as i64 > limit {
            has_more_after = true;
            starts[limit as usize]
        } else {
            i64::MAX
        };
        // 下界取「严格大于 after 的最小 seq」，这样 after 指向的消息被撤回、
        // 或 after 落在回合内部时都不会漏消息。
        let start: Option<i64> = conn.query_row(
            "SELECT MIN(seq) FROM ai_chat_messages WHERE chat_id = ?1 AND seq > ?2",
            params![chat_id, after],
            |r| r.get(0),
        )?;
        let messages = match start {
            Some(start) if start < end => fetch_messages(conn, chat_id, start, end)?,
            _ => Vec::new(),
        };
        let has_more_before = exists_seq_at_or_before(conn, chat_id, after)?;
        (messages, has_more_before, has_more_after)
    } else {
        // 最新页 / 向前翻：取 bound 之前最晚的 limit 个回合起点。
        let bound = before_seq.unwrap_or(i64::MAX);
        let mut starts = conn
            .prepare(
                "SELECT seq FROM ai_chat_messages \
                 WHERE chat_id = ?1 AND role = 'user' AND seq < ?2 \
                 ORDER BY seq DESC LIMIT ?3",
            )?
            .query_map(params![chat_id, bound, limit + 1], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let (start, has_more_before) = if starts.len() as i64 > limit {
            starts.truncate(limit as usize);
            // DESC：截断后最后一行就是本页最老的回合起点。
            (*starts.last().expect("limit >= 1"), true)
        } else {
            // 没有更多：从 0 开始，把第一条 user 之前的 legacy assistant 一并带回。
            (0, false)
        };
        let messages = fetch_messages(conn, chat_id, start, bound)?;
        let has_more_after = if before_seq.is_some() {
            exists_seq_at_or_after(conn, chat_id, bound)?
        } else {
            false
        };
        (messages, has_more_before, has_more_after)
    };

    let next_before_seq = if has_more_before {
        messages.first().map(|m| m.seq)
    } else {
        None
    };
    let next_after_seq = if has_more_after {
        messages.last().map(|m| m.seq)
    } else {
        None
    };

    Ok(AiChatPage {
        messages,
        total,
        has_more_before,
        has_more_after,
        next_before_seq,
        next_after_seq,
    })
}

/// 无 user 消息的 legacy 会话：整段视为一个回合（不再按 user 切页）。
fn page_without_users(
    conn: &Connection,
    chat_id: &str,
    before_seq: Option<i64>,
    after_seq: Option<i64>,
    total: i64,
) -> Result<AiChatPage> {
    let max = LEGACY_PAGE_MAX_MESSAGES as usize;
    let (messages, has_more_before, has_more_after) = if let Some(after) = after_seq {
        let sql = format!(
            "SELECT {MSG_COLS} FROM ai_chat_messages \
             WHERE chat_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt
            .query_map(params![chat_id, after, LEGACY_PAGE_MAX_MESSAGES + 1], message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more_after = rows.len() > max;
        rows.truncate(max);
        let has_more_before = exists_seq_at_or_before(conn, chat_id, after)?;
        (rows, has_more_before, has_more_after)
    } else {
        let bound = before_seq.unwrap_or(i64::MAX);
        let sql = format!(
            "SELECT {MSG_COLS} FROM ai_chat_messages \
             WHERE chat_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt
            .query_map(params![chat_id, bound, LEGACY_PAGE_MAX_MESSAGES + 1], message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more_before = rows.len() > max;
        rows.truncate(max);
        rows.reverse();
        let has_more_after = if before_seq.is_some() {
            exists_seq_at_or_after(conn, chat_id, bound)?
        } else {
            false
        };
        (rows, has_more_before, has_more_after)
    };

    let next_before_seq = if has_more_before {
        messages.first().map(|m| m.seq)
    } else {
        None
    };
    let next_after_seq = if has_more_after {
        messages.last().map(|m| m.seq)
    } else {
        None
    };
    Ok(AiChatPage {
        messages,
        total,
        has_more_before,
        has_more_after,
        next_before_seq,
        next_after_seq,
    })
}

/// 「查看原文」定位：目标消息所属回合必须落在页尾，`has_more_after` 由后续消息决定。
///
/// 实现上以「目标回合之后第一条 user 的 seq」作为 exclusive 上界调用 `chat_page_conn`，
/// 因此返回页天然以目标回合收尾；目标消息不存在时报「消息不存在」。
pub(crate) fn chat_page_around_conn(
    conn: &Connection,
    chat_id: &str,
    message_id: &str,
    limit_turns: Option<i64>,
) -> Result<AiChatPage> {
    let target_seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM ai_chat_messages WHERE chat_id = ?1 AND id = ?2",
            params![chat_id, message_id],
            |r| r.get(0),
        )
        .optional()?;
    let target_seq =
        target_seq.ok_or_else(|| ReinError::Message("消息不存在".into()))?;

    let next_turn: Option<i64> = conn.query_row(
        "SELECT MIN(seq) FROM ai_chat_messages \
         WHERE chat_id = ?1 AND role = 'user' AND seq > ?2",
        params![chat_id, target_seq],
        |r| r.get(0),
    )?;
    // 目标在最后一个回合时用 i64::MAX 作 exclusive 上界（不要 MAX(seq)+1，避免溢出）。
    chat_page_conn(
        conn,
        chat_id,
        Some(next_turn.unwrap_or(i64::MAX)),
        None,
        limit_turns,
    )
}

/// 旧库 anchor 懒回填（幂等）：只补当前会话里 `anchor_id IS NULL` 的行。
///
/// 只在分页命令进入时调用；0054 迁移已完成时它不会命中任何行。规则与迁移一致：
/// 回合内 terminal assistant 优先（text/analysis 有正文，或 food-parse 无论正文），
/// 同优先级取 seq 最大；没有 terminal 时取回合最后一条 assistant；没有 assistant 的
/// 回合保持 NULL。`rowid` 顺序不影响结果。
pub(crate) fn backfill_chat_anchors(conn: &Connection, chat_id: &str) -> Result<i64> {
    let changed = conn.execute(
        r#"
        WITH turns AS (
          SELECT id, seq, role, kind, text,
                 SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) OVER (
                   PARTITION BY chat_id ORDER BY seq
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS turn_no
          FROM ai_chat_messages
          WHERE chat_id = ?1
        ),
        chosen AS (
          SELECT id, turn_no FROM (
            SELECT id, turn_no,
                   ROW_NUMBER() OVER (
                     PARTITION BY turn_no
                     ORDER BY
                       CASE WHEN role = 'assistant'
                             AND ((kind IN ('text','analysis')
                                   AND TRIM(COALESCE(text,'')) <> '')
                                  OR kind = 'food-parse')
                            THEN 0 ELSE 1 END,
                       seq DESC
                   ) AS rn
            FROM turns
            WHERE role = 'assistant'
          )
          WHERE rn = 1
        )
        UPDATE ai_chat_messages
        SET anchor_id = (
          SELECT c.id
          FROM chosen c JOIN turns t ON t.turn_no = c.turn_no
          WHERE t.id = ai_chat_messages.id
        )
        WHERE chat_id = ?1
          AND anchor_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM chosen c JOIN turns t ON t.turn_no = c.turn_no
            WHERE t.id = ai_chat_messages.id
          )
        "#,
        [chat_id],
    )?;
    Ok(changed as i64)
}

/// 测试用 schema 兜底：A 域 0053/0054 迁移尚未合入时，让 D 域单测能独立跑；
/// 迁移已存在时是空操作。生产路径永远由 `db::migrate` 建列建表。
#[cfg(test)]
pub(crate) fn ensure_anchor_schema_for_tests(conn: &Connection) {
    let has_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('ai_chat_messages') WHERE name = 'anchor_id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    if has_column == 0 {
        conn.execute_batch(
            "ALTER TABLE ai_chat_messages ADD COLUMN anchor_id TEXT;
             CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_anchor \
               ON ai_chat_messages(anchor_id);",
        )
        .unwrap();
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_chat_seq (
           chat_id TEXT PRIMARY KEY,
           next_seq INTEGER NOT NULL DEFAULT 0
         );",
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::migrate_for_test;

    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        ensure_anchor_schema_for_tests(&conn);
        conn.execute(
            "INSERT INTO ai_chats (id, title, created_at, updated_at) \
             VALUES ('c', 't', '2026-11-10T00:00:00+00:00', '2026-11-10T00:00:00+00:00')",
            [],
        )
        .unwrap();
        conn
    }

    fn msg(conn: &Connection, id: &str, seq: i64, role: &str, kind: &str, text: Option<&str>) {
        conn.execute(
            "INSERT INTO ai_chat_messages \
             (id, chat_id, seq, role, kind, text, created_at, anchor_id) \
             VALUES (?1, 'c', ?2, ?3, ?4, ?5, '2026-11-10T00:00:00+00:00', NULL)",
            params![id, seq, role, kind, text],
        )
        .unwrap();
    }

    fn ids(page: &AiChatPage) -> Vec<&str> {
        page.messages.iter().map(|m| m.id.as_str()).collect()
    }

    fn anchor(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT anchor_id FROM ai_chat_messages WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// 一页只包含完整回合：user + 其后全部 assistant（含 tools 过程消息）。
    #[test]
    fn chat_page_returns_whole_turns() {
        let conn = fresh();
        msg(&conn, "u1", 1, "user", "text", Some("一"));
        msg(&conn, "a1", 2, "assistant", "text", Some("一答"));
        msg(&conn, "p1", 3, "assistant", "tools", None);
        msg(&conn, "u2", 4, "user", "text", Some("二"));
        msg(&conn, "a2", 5, "assistant", "text", Some("二答"));

        let tail = chat_page_conn(&conn, "c", None, None, Some(1)).unwrap();
        assert_eq!(ids(&tail), vec!["u2", "a2"], "整回合切页");
        assert_eq!(tail.total, 5, "total 是会话消息总数，不是本页条数");
        assert!(tail.has_more_before);
        assert!(!tail.has_more_after);
        assert_eq!(tail.next_before_seq, Some(4));

        let older = chat_page_conn(&conn, "c", tail.next_before_seq, None, Some(1)).unwrap();
        assert_eq!(ids(&older), vec!["u1", "a1", "p1"], "过程消息跟回合走");
        assert_eq!(older.total, 5);
        assert!(!older.has_more_before);
        assert!(older.has_more_after, "后面还有第二回合");
        assert_eq!(older.next_before_seq, None);
        assert_eq!(older.next_after_seq, Some(3));
    }

    /// 游标是数值边界：before_seq 可以指向已被撤回、当前不存在的 seq。
    #[test]
    fn chat_page_cursor_handles_seq_gaps() {
        let conn = fresh();
        msg(&conn, "u1", 1, "user", "text", Some("一"));
        msg(&conn, "a1", 2, "assistant", "text", Some("一答"));
        // seq 3/4 已被 cut 掉，留下空洞
        msg(&conn, "u2", 5, "user", "text", Some("二"));
        msg(&conn, "a2", 6, "assistant", "text", Some("二答"));
        msg(&conn, "u3", 9, "user", "text", Some("三"));
        msg(&conn, "a3", 10, "assistant", "text", Some("三答"));

        // 游标 8 不指向任何现存消息，但作为上界仍然有效：取到第二回合为止。
        let page = chat_page_conn(&conn, "c", Some(8), None, Some(1)).unwrap();
        assert_eq!(ids(&page), vec!["u2", "a2"]);
        assert!(page.has_more_before);
        assert!(page.has_more_after);
        assert_eq!(page.next_before_seq, Some(5));
        assert_eq!(page.next_after_seq, Some(6));

        // 用上一页的 next_after_seq 向后翻，拿到第三回合，不重不漏。
        let newer = chat_page_conn(&conn, "c", None, page.next_after_seq, Some(1)).unwrap();
        assert_eq!(ids(&newer), vec!["u3", "a3"]);
        assert!(!newer.has_more_after);
        assert_eq!(newer.next_after_seq, None);
    }

    /// 最新一页没有「更后面」；before/after 游标都从实际返回的消息边界取值。
    #[test]
    fn chat_page_tail_has_no_more_after() {
        let conn = fresh();
        msg(&conn, "u1", 1, "user", "text", Some("一"));
        msg(&conn, "a1", 2, "assistant", "text", Some("一答"));

        let tail = chat_page_conn(&conn, "c", None, None, None).unwrap();
        assert_eq!(ids(&tail), vec!["u1", "a1"]);
        assert!(!tail.has_more_before);
        assert!(!tail.has_more_after);
        assert_eq!(tail.next_before_seq, None);
        assert_eq!(tail.next_after_seq, None);
    }

    /// 没有 user 消息的 legacy 会话：返回全部，不按回合切。
    #[test]
    fn chat_page_without_user_messages_returns_all() {
        let conn = fresh();
        msg(&conn, "a1", 1, "assistant", "text", Some("欢迎"));
        msg(&conn, "a2", 2, "assistant", "tools", None);
        msg(&conn, "a3", 3, "assistant", "analysis", Some("分析"));

        let page = chat_page_conn(&conn, "c", None, None, Some(1)).unwrap();
        assert_eq!(ids(&page), vec!["a1", "a2", "a3"], "limit_turns 不切 legacy 会话");
        assert!(!page.has_more_before);
        assert!(!page.has_more_after);
        assert_eq!(page.next_before_seq, None);
        assert_eq!(page.next_after_seq, None);
    }

    /// around：目标回合在页尾，前面按 limit 带上下文，后面还有消息时 has_more_after=true。
    #[test]
    fn chat_page_around_ends_at_target_turn() {
        let conn = fresh();
        msg(&conn, "u1", 1, "user", "text", Some("一"));
        msg(&conn, "a1", 2, "assistant", "text", Some("一答"));
        msg(&conn, "u2", 4, "user", "text", Some("二"));
        msg(&conn, "a2", 5, "assistant", "text", Some("二答"));
        msg(&conn, "u3", 7, "user", "text", Some("三"));
        msg(&conn, "a3", 8, "assistant", "text", Some("三答"));

        let page = chat_page_around_conn(&conn, "c", "a2", Some(1)).unwrap();
        assert_eq!(ids(&page), vec!["u2", "a2"], "目标回合在页尾");
        assert!(page.has_more_before);
        assert!(page.has_more_after);
        assert_eq!(page.next_before_seq, Some(4));
        assert_eq!(page.next_after_seq, Some(5));

        let newer = chat_page_conn(&conn, "c", None, page.next_after_seq, Some(1)).unwrap();
        assert_eq!(ids(&newer), vec!["u3", "a3"]);
    }

    /// 目标消息不存在时必须报错，而不是返回一个看似正常的空页。
    #[test]
    fn chat_page_around_missing_message_errors() {
        let conn = fresh();
        msg(&conn, "u1", 1, "user", "text", Some("一"));
        let err = chat_page_around_conn(&conn, "c", "nope", None).unwrap_err();
        assert!(err.to_string().contains("消息不存在"));
    }

    /// before 与 after 同时传是调用错误。
    #[test]
    fn chat_page_rejects_both_cursors() {
        let conn = fresh();
        let err = chat_page_conn(&conn, "c", Some(10), Some(1), None).unwrap_err();
        assert!(err.to_string().contains("不能同时使用"));
    }

    /// 懒回填：terminal 优先（food-parse 允许 text=NULL），无 terminal 退化为最后一条
    /// assistant，无 assistant 的回合保持 NULL；重复执行幂等。
    #[test]
    fn backfill_anchors_includes_food_parse_and_is_idempotent() {
        let conn = fresh();
        // 回合 1：user → tools → food-parse（text=NULL，仍是 terminal，且优先于 tools）
        msg(&conn, "u1", 1, "user", "text", Some("吃了什么"));
        msg(&conn, "p1", 2, "assistant", "tools", None);
        msg(&conn, "f1", 3, "assistant", "food-parse", None);
        // 回合 2：user → 空白 text（不是 terminal）→ 退化到最后一条 assistant
        msg(&conn, "u2", 4, "user", "text", Some("继续"));
        msg(&conn, "e1", 5, "assistant", "text", Some("   "));
        // 回合 3：只有 user，没有 assistant → 保持 NULL
        msg(&conn, "u3", 6, "user", "text", Some("没回复"));

        let changed = backfill_chat_anchors(&conn, "c").unwrap();
        assert_eq!(changed, 5, "回合 1 的 3 条 + 回合 2 的 2 条");
        assert_eq!(anchor(&conn, "u1").as_deref(), Some("f1"));
        assert_eq!(anchor(&conn, "p1").as_deref(), Some("f1"));
        assert_eq!(anchor(&conn, "f1").as_deref(), Some("f1"));
        assert_eq!(anchor(&conn, "u2").as_deref(), Some("e1"));
        assert_eq!(anchor(&conn, "e1").as_deref(), Some("e1"));
        assert_eq!(anchor(&conn, "u3"), None);

        assert_eq!(backfill_chat_anchors(&conn, "c").unwrap(), 0, "幂等");
    }

    /// 第一条 user 之前的 assistant 归 turn 0；turn 0 自己是一个独立回合，anchor 就是它。
    #[test]
    fn backfill_anchors_handles_leading_assistant() {
        let conn = fresh();
        msg(&conn, "greet", 1, "assistant", "text", Some("你好"));
        msg(&conn, "u1", 2, "user", "text", Some("一"));
        msg(&conn, "a1", 3, "assistant", "text", Some("一答"));

        assert_eq!(backfill_chat_anchors(&conn, "c").unwrap(), 3);
        assert_eq!(anchor(&conn, "greet").as_deref(), Some("greet"), "turn 0 自成回合");
        assert_eq!(anchor(&conn, "u1").as_deref(), Some("a1"));
        assert_eq!(anchor(&conn, "a1").as_deref(), Some("a1"));
    }

    /// 只补当前会话，别把别的会话一起改了。
    #[test]
    fn backfill_anchors_is_scoped_to_one_chat() {
        let conn = fresh();
        conn.execute(
            "INSERT INTO ai_chats (id, title, created_at, updated_at) \
             VALUES ('other', 't', '2026-11-10T00:00:00+00:00', '2026-11-10T00:00:00+00:00')",
            [],
        )
        .unwrap();
        msg(&conn, "u1", 1, "user", "text", Some("一"));
        msg(&conn, "a1", 2, "assistant", "text", Some("一答"));
        conn.execute(
            "INSERT INTO ai_chat_messages \
             (id, chat_id, seq, role, kind, text, created_at, anchor_id) \
             VALUES ('ou', 'other', 1, 'user', 'text', 'x', '2026-11-10T00:00:00+00:00', NULL)",
            [],
        )
        .unwrap();

        assert_eq!(backfill_chat_anchors(&conn, "c").unwrap(), 2);
        assert_eq!(anchor(&conn, "ou"), None, "其它会话不在本次回填范围");
    }
}
