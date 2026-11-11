//! 索引维护：脏队列消费、文档派生落库、分块重建、向量存取。
//!
//! 同步模型是「触发器登记 → 这里重放」。重放永远是幂等的：删掉重来结果一样，
//! 因为正文每次都由 source.rs 从源表重新派生，而不是增量打补丁。
//!
//! **FTS 一致性靠显式删除保证**：`kb_chunks` 上的 AFTER DELETE 触发器负责把 FTS 索引里的
//! 对应行摘掉。而 SQLite 的外键级联删除**不会**触发子表触发器，所以这里删除文档时
//! 一律先显式 `DELETE FROM kb_chunks WHERE doc_id = ?` 再删 kb_docs，不依赖 `ON DELETE CASCADE`
//! 去维护 FTS。`fts_stays_consistent…` 单测用 FTS5 的 integrity-check 守着这条约束。

use rusqlite::{Connection, OptionalExtension};
#[cfg(test)]
use serde_json::json;

use crate::error::Result;

use super::chunk::{chunk_text, DEFAULT_MAX_CHARS, DEFAULT_OVERLAP};
#[cfg(test)]
use super::models::KIND_TEXT;
use super::source::{self, Derived};

/// 单条派生的落库结果。`doc_id`/`chunks` 供调用方与测试检视，
/// 主流程只消费 `unchanged` 决定是否计入进度。
#[derive(Debug, Default, Clone)]
#[allow(dead_code)]
pub struct ApplyOutcome {
    pub doc_id: Option<i64>,
    pub chunks: usize,
    /// 内容哈希未变，跳过了重建
    pub unchanged: bool,
}

/// FNV-1a 64 位。用它而不是 `DefaultHasher`：后者不保证跨 Rust 版本稳定，
/// 一旦变化会导致升级后全库无谓重建。这里只是变更检测，不需要抗碰撞强度。
pub(crate) fn content_hash(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{h:016x}")
}

/// 写一条文档（含分块）。已存在且内容未变时**什么都不写**，不重建分块与向量。
///
/// 从前这条分支会 `UPDATE kb_docs SET updated_at = datetime('now')`。两个后果都是坏的：
/// 1. 启动对账每次都会重放全部源（生产库 1.7k 条，其中 1.4k 条内容没变），于是每次
///    启动都白写 1.4k 次 + 放大 WAL；
/// 2. `listing` 把 `kb_docs.updated_at` 当「最近更新时间」显示并按它排序 —— 每次启动
///    全库时间戳被刷成「刚刚」，关于你 → 文件夹里所有派生文件的排序与时间都失真。
/// 内容没变就没有「更新」可言，不写才是对的。
pub fn upsert_doc(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    d: &Derived,
    max_chars: usize,
    overlap: usize,
) -> Result<ApplyOutcome> {
    let tags_json = serde_json::to_string(&d.tags)?;
    let meta_json = serde_json::to_string(&d.meta)?;
    let path = d.path.as_deref().unwrap_or("");
    let hash = content_hash(&[
        path,
        &d.title,
        &d.summary,
        &d.body,
        d.occurred_on.as_deref().unwrap_or(""),
        &tags_json,
        if d.editable { "1" } else { "0" },
        &d.kind,
    ]);

    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, content_hash FROM kb_docs WHERE source_type = ?1 AND source_id = ?2",
            [source_type, source_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    if let Some((doc_id, old_hash)) = existing {
        if old_hash == hash {
            return Ok(ApplyOutcome {
                doc_id: Some(doc_id),
                chunks: 0,
                unchanged: true,
            });
        }
        // 先显式清块（触发 kb_chunks_ad 维护 FTS），再重写
        conn.execute("DELETE FROM kb_chunks WHERE doc_id = ?1", [doc_id])?;
        conn.execute(
            "UPDATE kb_docs SET parent_id = ?2, title = ?3, summary = ?4, body = ?5,
                    path = ?6, editable = ?7, system = ?8, kind = ?9,
                    occurred_on = ?10, tags = ?11, meta_json = ?12, content_hash = ?13,
                    byte_len = ?14, vec_model = NULL, updated_at = datetime('now')
             WHERE id = ?1",
            rusqlite::params![
                doc_id,
                d.parent_id,
                d.title,
                d.summary,
                d.body,
                d.path,
                d.editable,
                d.system,
                d.kind,
                d.occurred_on,
                tags_json,
                meta_json,
                hash,
                d.body.len() as i64,
            ],
        )?;
        let n = insert_chunks(conn, doc_id, &d.body, max_chars, overlap)?;
        return Ok(ApplyOutcome {
            doc_id: Some(doc_id),
            chunks: n,
            unchanged: false,
        });
    }

    conn.execute(
        "INSERT INTO kb_docs(source_type, source_id, parent_id, title, summary, body, path,
                             editable, system, kind, occurred_on, tags, meta_json, content_hash,
                             byte_len, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15, datetime('now'))",
        rusqlite::params![
            source_type,
            source_id,
            d.parent_id,
            d.title,
            d.summary,
            d.body,
            d.path,
            d.editable,
            d.system,
            d.kind,
            d.occurred_on,
            tags_json,
            meta_json,
            hash,
            d.body.len() as i64,
        ],
    )?;
    let doc_id = conn.last_insert_rowid();
    let n = insert_chunks(conn, doc_id, &d.body, max_chars, overlap)?;
    Ok(ApplyOutcome {
        doc_id: Some(doc_id),
        chunks: n,
        unchanged: false,
    })
}

fn insert_chunks(
    conn: &Connection,
    doc_id: i64,
    body: &str,
    max_chars: usize,
    overlap: usize,
) -> Result<usize> {
    let chunks = chunk_text(body, max_chars, overlap);
    if chunks.is_empty() {
        return Ok(0);
    }
    let mut stmt = conn.prepare("INSERT INTO kb_chunks(doc_id, ord, text) VALUES (?1, ?2, ?3)")?;
    for (i, text) in chunks.iter().enumerate() {
        stmt.execute(rusqlite::params![doc_id, i as i64, text])?;
    }
    Ok(chunks.len())
}

/// 删除一条文档。显式删块以触发 FTS 维护（见模块头注释）。
pub fn delete_doc(conn: &Connection, source_type: &str, source_id: &str) -> Result<bool> {
    let doc_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM kb_docs WHERE source_type = ?1 AND source_id = ?2",
            [source_type, source_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(doc_id) = doc_id else {
        return Ok(false);
    };
    conn.execute("DELETE FROM kb_chunks WHERE doc_id = ?1", [doc_id])?;
    // kb_chunks 的删除已级联清掉 kb_vectors（chunk_id 主键外键在 kb_vectors 上，
    // 这里同样是级联；但它不涉及触发器，没有一致性风险）
    conn.execute("DELETE FROM kb_docs WHERE id = ?1", [doc_id])?;
    Ok(true)
}

/// 重放一条脏标记：派生 → 有内容则 upsert，源已消失则删除。
pub fn apply_one(conn: &Connection, source_type: &str, source_id: &str) -> Result<ApplyOutcome> {
    match source::derive(conn, source_type, source_id)? {
        Some(d) => upsert_doc(
            conn,
            source_type,
            source_id,
            &d,
            DEFAULT_MAX_CHARS,
            DEFAULT_OVERLAP,
        ),
        None => {
            delete_doc(conn, source_type, source_id)?;
            Ok(ApplyOutcome::default())
        }
    }
}

/* ---------- 脏队列 ---------- */

/// 取一批脏标记并从队列移除。返回 (source_type, source_id, op)。
/// 先取后删的顺序保证：即使处理中途崩溃，最坏是把已处理的再做一遍（幂等），不会丢。
pub fn take_dirty(conn: &Connection, limit: i64) -> Result<Vec<(String, String, String)>> {
    let mut stmt =
        conn.prepare("SELECT source_type, source_id, op FROM kb_dirty ORDER BY at LIMIT ?1")?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    for (st, sid, _) in &rows {
        conn.execute(
            "DELETE FROM kb_dirty WHERE source_type = ?1 AND source_id = ?2",
            [st, sid],
        )?;
    }
    Ok(rows)
}

pub fn pending_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM kb_dirty", [], |r| r.get(0))?)
}

/// 手动把某条源记录标脏（我们自己维护的表用，如 kb_memories）。
pub fn mark_dirty(conn: &Connection, source_type: &str, source_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO kb_dirty(source_type, source_id, op, at) VALUES (?1, ?2, 'upsert', datetime('now'))
         ON CONFLICT(source_type, source_id) DO UPDATE SET op='upsert', at=excluded.at",
        [source_type, source_id],
    )?;
    Ok(())
}

/* ---------- 全量对账 ---------- */

/// 某个来源类型的全部源主键查询。返回单列 TEXT。
fn id_query(source_type: &str) -> Option<&'static str> {
    Some(match source_type {
        "todo" => "SELECT CAST(id AS TEXT) FROM todos",
        "workout" => "SELECT CAST(id AS TEXT) FROM workouts",
        "plan" => "SELECT id FROM workout_plans",
        "meal" => "SELECT CAST(id AS TEXT) FROM meal_logs",
        "body_metric" => "SELECT CAST(id AS TEXT) FROM body_metrics",
        "food" => "SELECT CAST(id AS TEXT) FROM foods WHERE is_custom = 1",
        "program" => "SELECT CAST(id AS TEXT) FROM programs",
        "program_meal" => "SELECT CAST(program_id AS TEXT) || ':' || date FROM program_meals",
        "voice_memo" => "SELECT id FROM voice_memos",
        "chat_message" => "SELECT id FROM ai_chat_messages",
        "chat" => "SELECT id FROM ai_chats",
        // 附件的身份是复合键（父 id:序号），用 json_each 把数组展开成行（JSON1 已随 bundled 启用）
        "todo_attachment" => {
            "SELECT CAST(t.id AS TEXT) || ':' || j.key \
              FROM todos t, json_each(t.attachments) j WHERE t.attachments IS NOT NULL"
        }
        "chat_attachment" => {
            "SELECT id || ':img' FROM ai_chat_messages WHERE image_base64 IS NOT NULL \
              UNION ALL SELECT id || ':doc' FROM ai_chat_messages \
              WHERE kind = 'doc' AND text LIKE '%附带文档《%'"
        }
        "memory" => "SELECT CAST(id AS TEXT) FROM memory_shards",
        "note" => "SELECT CAST(id AS TEXT) FROM kb_files WHERE trashed_at IS NULL",
        _ => return None,
    })
}

/// 全量对账：把现有源记录全部标脏，并清掉源已消失的孤儿文档。
///
/// 触发器只对**创建之后**的写入生效，所以老库升级到 0019 时必须靠这一趟补齐。
/// 返回标脏的条数。
pub fn scan_all(conn: &Connection, enabled: &[String]) -> Result<i64> {
    let tx = conn.unchecked_transaction()?;
    let mut queued = 0i64;

    for st in enabled {
        let Some(sql) = id_query(st) else { continue };
        let mut stmt = tx.prepare(sql)?;
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        for id in ids {
            tx.execute(
                "INSERT INTO kb_dirty(source_type, source_id, op, at) VALUES (?1, ?2, 'upsert', datetime('now'))
                 ON CONFLICT(source_type, source_id) DO UPDATE SET op='upsert', at=excluded.at",
                [st.as_str(), id.as_str()],
            )?;
            queued += 1;
        }
    }

    // 孤儿清理：kb_docs 里有、源表里已没有的记录
    let mut stmt = tx.prepare("SELECT id, source_type, source_id FROM kb_docs")?;
    let docs: Vec<(i64, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut orphans = Vec::new();
    for (id, st, sid) in docs {
        if !enabled.iter().any(|e| e == &st) {
            continue;
        }
        if source::derive(&tx, &st, &sid)?.is_none() {
            orphans.push(id);
        }
    }
    for id in orphans {
        tx.execute("DELETE FROM kb_chunks WHERE doc_id = ?1", [id])?;
        tx.execute("DELETE FROM kb_docs WHERE id = ?1", [id])?;
    }

    tx.commit()?;
    Ok(queued)
}

/* ---------- 统计 ---------- */

pub fn stats(conn: &Connection) -> Result<(i64, i64, i64)> {
    let docs = conn.query_row("SELECT COUNT(*) FROM kb_docs", [], |r| r.get(0))?;
    let chunks = conn.query_row("SELECT COUNT(*) FROM kb_chunks", [], |r| r.get(0))?;
    let vectors = conn.query_row("SELECT COUNT(*) FROM kb_vectors", [], |r| r.get(0))?;
    Ok((docs, chunks, vectors))
}

/// 当前向量对应的模型（取众数；一般全库一致）。
pub fn active_vec_model(conn: &Connection) -> Result<Option<String>> {
    let v: Option<String> = conn
        .query_row(
            "SELECT model_id FROM kb_vectors GROUP BY model_id ORDER BY COUNT(*) DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v)
}

/* ---------- 向量 ---------- */

/// 取出还需要向量化的块。`model_id` 换掉后，旧模型的向量会被视为缺失而重算。
pub fn chunks_needing_vectors(
    conn: &Connection,
    model_id: &str,
    limit: i64,
) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.text
         FROM kb_chunks c
         LEFT JOIN kb_vectors v ON v.chunk_id = c.id AND v.model_id = ?1
         WHERE v.chunk_id IS NULL
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map([model_id, &limit.to_string()], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 批量写入向量。`items` 为 (chunk_id, 已 L2 归一化的向量)。
pub fn store_vectors(
    conn: &Connection,
    model_id: &str,
    items: &[(i64, Vec<f32>)],
) -> Result<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare(
        "INSERT INTO kb_vectors(chunk_id, model_id, dim, vec, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(chunk_id) DO UPDATE SET model_id=excluded.model_id, dim=excluded.dim,
                                             vec=excluded.vec, updated_at=excluded.updated_at",
    )?;
    for (chunk_id, v) in items {
        stmt.execute(rusqlite::params![
            chunk_id,
            model_id,
            v.len() as i64,
            super::search::vec_to_blob(v),
        ])?;
    }
    drop(stmt);
    tx.commit()?;

    // 标记这些块所属文档的向量模型
    let tx = conn.unchecked_transaction()?;
    for (chunk_id, _) in items {
        tx.execute(
            "UPDATE kb_docs SET vec_model = ?1
             WHERE id = (SELECT doc_id FROM kb_chunks WHERE id = ?2)",
            rusqlite::params![model_id, chunk_id],
        )?;
    }
    tx.commit()?;
    Ok(items.len())
}

/// 换模型时丢弃全部旧向量（按 model_id 精确清理，不动新模型的）。
pub fn clear_vectors(conn: &Connection, keep_model: Option<&str>) -> Result<usize> {
    let n = match keep_model {
        Some(m) => conn.execute("DELETE FROM kb_vectors WHERE model_id <> ?1", [m])?,
        None => conn.execute("DELETE FROM kb_vectors", [])?,
    };
    conn.execute("UPDATE kb_docs SET vec_model = NULL", [])?;
    Ok(n)
}

/// 处于「文档已标记用了某向量模型，但该模型的向量缺失」状态的块数——
/// 换模型或部分失败后用它判断是否需要继续跑。
#[cfg(test)]
pub fn vector_coverage(conn: &Connection, model_id: &str) -> Result<(i64, i64)> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM kb_chunks", [], |r| r.get(0))?;
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM kb_vectors WHERE model_id = ?1",
        [model_id],
        |r| r.get(0),
    )?;
    Ok((done, total))
}

/// FTS 索引自检。返回 Err 表示索引与 kb_chunks 不一致。
/// 排查手段：怀疑索引与正文不一致时在任意连接上跑一次即可。
#[allow(dead_code)]
pub fn fts_integrity_check(conn: &Connection) -> Result<()> {
    conn.execute_batch("INSERT INTO kb_fts(kb_fts) VALUES('integrity-check');")?;
    Ok(())
}

/// 给单测/调试用：直接把一条派生结果塞进去。
#[cfg(test)]
pub fn debug_seed_doc(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    title: &str,
    body: &str,
    occurred_on: Option<&str>,
) -> Result<i64> {
    let d = Derived {
        title: title.to_string(),
        summary: body.chars().take(40).collect(),
        body: body.to_string(),
        path: Some(format!("{source_type}/{source_id}.md")),
        occurred_on: occurred_on.map(|s| s.to_string()),
        tags: vec![],
        parent_id: None,
        meta: json!({}),
        editable: false,
        system: false,
        kind: KIND_TEXT.to_string(),
    };
    let out = upsert_doc(
        conn,
        source_type,
        source_id,
        &d,
        DEFAULT_MAX_CHARS,
        DEFAULT_OVERLAP,
    )?;
    Ok(out.doc_id.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::models::{KbQuery, SOURCE_TYPES};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn all() -> Vec<String> {
        SOURCE_TYPES.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        assert_eq!(content_hash(&["a", "b"]), content_hash(&["a", "b"]));
        assert_ne!(content_hash(&["a", "b"]), content_hash(&["a", "c"]));
        // 「ab」与「a」「b」必须区分（分隔符的存在意义）
        assert_ne!(content_hash(&["ab"]), content_hash(&["a", "b"]));
    }

    /// 内容未变的重放**不写库**。
    ///
    /// 启动对账每次重放全部源（生产库 1.7k 条），未变分支如果刷新 `updated_at`：
    /// ① 每次启动白写 1.4k 行、放大 WAL；② `listing` 拿 `kb_docs.updated_at`
    /// 当「最近更新」显示与排序 —— 于是每次启动全库都变成「刚刚」，关于你 →
    /// 文件夹的时间与排序全部失真。这条把「不写」钉住。
    #[test]
    fn unchanged_upsert_does_not_touch_updated_at() {
        let conn = db();
        let d = super::source::Derived {
            title: "标题".into(),
            summary: "摘要".into(),
            body: "正文".into(),
            path: Some("笔记/测试.md".into()),
            occurred_on: None,
            tags: vec![],
            parent_id: None,
            meta: serde_json::json!({}),
            editable: true,
            system: false,
            kind: "text".into(),
        };
        let first = upsert_doc(&conn, "note", "1", &d, 300, 50).unwrap();
        let doc_id = first.doc_id.unwrap();
        assert!(!first.unchanged);

        conn.execute(
            "UPDATE kb_docs SET updated_at = '2000-01-01 00:00:00' WHERE id = ?1",
            [doc_id],
        )
        .unwrap();

        let again = upsert_doc(&conn, "note", "1", &d, 300, 50).unwrap();
        assert!(again.unchanged);
        let ts: String = conn
            .query_row(
                "SELECT updated_at FROM kb_docs WHERE id = ?1",
                [doc_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            ts, "2000-01-01 00:00:00",
            "内容未变不该刷新 updated_at（每次启动都会重放全部源）"
        );
    }

    #[test]
    fn upsert_is_idempotent_and_skips_unchanged() {
        let conn = db();
        let a = debug_seed_doc(
            &conn,
            "todo",
            "1",
            "深蹲",
            "五组八次，注意膝盖",
            Some("2026-09-10"),
        )
        .unwrap();
        let b = debug_seed_doc(
            &conn,
            "todo",
            "1",
            "深蹲",
            "五组八次，注意膝盖",
            Some("2026-09-10"),
        )
        .unwrap();
        assert_eq!(a, b, "同 source_id 应更新同一行而不是新增");
        let (docs, _, _) = stats(&conn).unwrap();
        assert_eq!(docs, 1);

        let out = apply_one_unchanged(&conn);
        assert!(out, "内容未变时应上报 unchanged");
    }

    fn apply_one_unchanged(conn: &Connection) -> bool {
        // 直接走真实派生路径：种一条 todo 再重放
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at, date)
             VALUES('深蹲', 'workout', 0, 'todo', '2026-09-10T00:00:00Z', '2026-09-10')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid().to_string();
        let first = apply_one(conn, "todo", &id).unwrap();
        assert!(!first.unchanged, "首次派生应重建");
        let second = apply_one(conn, "todo", &id).unwrap();
        second.unchanged
    }

    /// 这条守着模块头注释里那个坑：FTS 索引必须和 kb_chunks 保持一致，
    /// 而一致性靠触发器，不能依赖外键级联（级联不触发子表触发器）。
    #[test]
    fn fts_stays_consistent_across_insert_update_delete() {
        let conn = db();
        let _ = debug_seed_doc(
            &conn,
            "note",
            "n1",
            "第一条",
            "腿部力量训练安排，深蹲五组",
            None,
        );
        fts_integrity_check(&conn).expect("插入后 FTS 应一致");

        // 更新（走派生路径覆盖：内容变化）
        let _ = debug_seed_doc(
            &conn,
            "note",
            "n1",
            "第一条改了",
            "改成练胸，卧推五组",
            None,
        );
        fts_integrity_check(&conn).expect("更新后 FTS 应一致");

        // 删除文档 → 必须显式删块才能维护 FTS
        assert!(delete_doc(&conn, "note", "n1").unwrap());
        fts_integrity_check(&conn).expect("删除后 FTS 应一致");

        let (docs, chunks, _) = stats(&conn).unwrap();
        assert_eq!((docs, chunks), (0, 0));
    }

    #[test]
    fn delete_removes_vectors_too() {
        let conn = db();
        let doc = debug_seed_doc(&conn, "note", "n2", "标题", "正文内容", None).unwrap();
        let chunk_ids: Vec<i64> = {
            let mut s = conn
                .prepare("SELECT id FROM kb_chunks WHERE doc_id = ?1")
                .unwrap();
            s.query_map([doc], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap()
        };
        store_vectors(
            &conn,
            "m1",
            &chunk_ids
                .iter()
                .map(|c| (*c, vec![1.0f32, 0.0]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let (_, _, v) = stats(&conn).unwrap();
        assert_eq!(v, 1);

        delete_doc(&conn, "note", "n2").unwrap();
        let (_, _, v) = stats(&conn).unwrap();
        assert_eq!(v, 0, "删文档必须同时清掉向量");
    }

    #[test]
    fn chunks_needing_vectors_tracks_model_switch() {
        let conn = db();
        let doc = debug_seed_doc(&conn, "note", "n3", "标题", "正文内容", None).unwrap();
        let chunk_ids: Vec<i64> = {
            let mut s = conn
                .prepare("SELECT id FROM kb_chunks WHERE doc_id = ?1")
                .unwrap();
            s.query_map([doc], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            chunks_needing_vectors(&conn, "m1", 10).unwrap().len(),
            chunk_ids.len()
        );

        store_vectors(
            &conn,
            "m1",
            &chunk_ids
                .iter()
                .map(|c| (*c, vec![1.0f32]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(chunks_needing_vectors(&conn, "m1", 10).unwrap().len(), 0);
        // 换模型后同一批块应重新入列
        assert_eq!(
            chunks_needing_vectors(&conn, "m2", 10).unwrap().len(),
            chunk_ids.len()
        );
        assert_eq!(
            vector_coverage(&conn, "m2").unwrap(),
            (0, chunk_ids.len() as i64)
        );
    }

    #[test]
    fn clear_vectors_can_keep_one_model() {
        let conn = db();
        let doc = debug_seed_doc(&conn, "note", "n4", "标题", "正文内容", None).unwrap();
        let chunk_ids: Vec<i64> = {
            let mut s = conn
                .prepare("SELECT id FROM kb_chunks WHERE doc_id = ?1")
                .unwrap();
            s.query_map([doc], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap()
        };
        let items: Vec<(i64, Vec<f32>)> = chunk_ids.iter().map(|c| (*c, vec![1.0f32])).collect();
        store_vectors(&conn, "m1", &items).unwrap();
        assert_eq!(clear_vectors(&conn, Some("m1")).unwrap(), 0);
        assert_eq!(clear_vectors(&conn, None).unwrap(), 1);
    }

    #[test]
    fn take_dirty_drains_and_dedupes() {
        let conn = db();
        // 触发器在每次写入时登记脏标记；同一行改三次仍然只有一条
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at)
             VALUES('a','general',0,'todo','x')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        for _ in 0..3 {
            conn.execute("UPDATE todos SET title = title || '!' WHERE id = ?1", [id])
                .unwrap();
        }
        assert_eq!(
            pending_count(&conn).unwrap(),
            1,
            "主键去重应把同一份记录的多次变更合成一条"
        );

        let taken = take_dirty(&conn, 100).unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].2, "upsert");
        assert_eq!(pending_count(&conn).unwrap(), 0, "取走即出队");
    }

    #[test]
    fn delete_marks_dirty_with_delete_op() {
        let conn = db();
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at)
             VALUES('a','general',0,'todo','x')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        take_dirty(&conn, 100).unwrap();
        conn.execute("DELETE FROM todos WHERE id = ?1", [id])
            .unwrap();
        let taken = take_dirty(&conn, 100).unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].2, "delete");
    }

    /// 内置食物是种子数据（is_custom=0），绝不能入队——否则首启会把整库 2722 条拖进索引。
    #[test]
    fn seed_foods_are_not_queued() {
        let conn = db();
        conn.execute(
            "INSERT INTO foods(name, kcal, protein, carb, fat, is_custom, created_at)
             VALUES('内置食物', 100, 1, 1, 1, 0, 'x')",
            [],
        )
        .unwrap();
        assert_eq!(pending_count(&conn).unwrap(), 0, "内置食物不该登记");

        conn.execute(
            "INSERT INTO foods(name, kcal, protein, carb, fat, is_custom, created_at)
             VALUES('我加的', 100, 1, 1, 1, 1, 'x')",
            [],
        )
        .unwrap();
        assert_eq!(pending_count(&conn).unwrap(), 1, "自建食物应登记");
    }

    /// 逐组明细改动要连带刷新父训练记录，而不是自成一条文档。
    #[test]
    fn workout_set_changes_mark_parent_workout() {
        let conn = db();
        conn.execute(
            "INSERT INTO workouts(name, type, date, duration_min, kcal, intensity, created_at)
             VALUES('腿部','strength','2026-09-10',60,300,'moderate','x')",
            [],
        )
        .unwrap();
        let wid = conn.last_insert_rowid();
        take_dirty(&conn, 100).unwrap();

        conn.execute(
            "INSERT INTO workout_sets(workout_id, exercise_key, exercise_name, set_no, weight_kg, reps, created_at)
             VALUES(?1,'squat','深蹲',1,60,8,'x')",
            [wid],
        )
        .unwrap();
        let taken = take_dirty(&conn, 100).unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].0, "workout", "应登记父训练记录");
        assert_eq!(taken[0].1, wid.to_string());
    }

    #[test]
    fn scan_all_queues_existing_and_prunes_orphans() {
        let conn = db();
        for t in ["a", "b", "c"] {
            conn.execute(
                "INSERT INTO todos(title, category, priority, status, created_at) VALUES(?1,'general',0,'todo','x')",
                [t],
            )
            .unwrap();
        }
        take_dirty(&conn, 100).unwrap();
        // 先把三条都建进知识库
        let ids: Vec<String> = {
            let mut s = conn.prepare("SELECT CAST(id AS TEXT) FROM todos").unwrap();
            s.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap()
        };
        for id in &ids {
            apply_one(&conn, "todo", id).unwrap();
        }
        take_dirty(&conn, 100).unwrap();
        assert_eq!(stats(&conn).unwrap().0, 3);

        // 删掉一条源记录，但不通知知识库（模拟触发器之前就存在的数据 / 外部改动）
        conn.execute("DELETE FROM kb_dirty", []).unwrap();
        conn.execute("DELETE FROM todos WHERE title = 'b'", [])
            .unwrap();
        let queued = scan_all(&conn, &all()).unwrap();
        assert_eq!(queued, 2, "只剩两条源记录");
        assert_eq!(stats(&conn).unwrap().0, 2, "孤儿文档应被对账清掉");
    }

    #[test]
    fn apply_one_deletes_when_source_vanishes() {
        let conn = db();
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at) VALUES('临时','general',0,'todo','x')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid().to_string();
        apply_one(&conn, "todo", &id).unwrap();
        assert_eq!(stats(&conn).unwrap().0, 1);

        conn.execute("DELETE FROM todos", []).unwrap();
        apply_one(&conn, "todo", &id).unwrap();
        assert_eq!(stats(&conn).unwrap().0, 0, "源消失后知识库条目应删除");
    }

    /// 端到端最小闭环：种一条真实待办 → 走派生 → FTS 能搜到。
    #[test]
    fn end_to_end_todo_is_searchable() {
        use super::super::search;
        let conn = db();
        conn.execute(
            "INSERT INTO todos(title, notes, category, priority, status, created_at, date)
             VALUES('腿部力量训练', '深蹲五组，注意膝盖不要内扣', 'workout', 0, 'todo', 'x', '2026-09-10')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid().to_string();
        apply_one(&conn, "todo", &id).unwrap();

        let q = KbQuery {
            query: "膝盖内扣".into(),
            ..Default::default()
        };
        let hits = search::search(&conn, &q, &all(), None, None).unwrap();
        assert_eq!(hits.len(), 1, "应命中那条待办");
        assert_eq!(hits[0].source_type, "todo");
        assert_eq!(hits[0].title, "腿部力量训练");
        assert!(
            hits[0].snippet.contains("膝盖"),
            "片段应含查询词: {}",
            hits[0].snippet
        );

        // 两字查询必须走 LIKE 兜底
        let q2 = KbQuery {
            query: "深蹲".into(),
            ..Default::default()
        };
        let hits2 = search::search(&conn, &q2, &all(), None, None).unwrap();
        assert_eq!(hits2.len(), 1, "两字查询应经 LIKE 兜底命中");
        assert_eq!(hits2[0].matched, "like");
    }

    /// 结构化过滤要真的生效（日期区间 + 来源类别）。
    #[test]
    fn structured_filters_apply() {
        use super::super::search;
        let conn = db();
        for (t, d) in [("九月训练", "2026-09-10"), ("八月训练", "2026-08-10")] {
            conn.execute(
                "INSERT INTO todos(title, category, priority, status, created_at, date)
                 VALUES(?1,'workout',0,'todo','x',?2)",
                rusqlite::params![t, d],
            )
            .unwrap();
            let id = conn.last_insert_rowid().to_string();
            apply_one(&conn, "todo", &id).unwrap();
        }

        let q = KbQuery {
            query: "训练".into(),
            from: Some("2026-09-01".into()),
            to: Some("2026-09-30".into()),
            ..Default::default()
        };
        let hits = search::search(&conn, &q, &all(), None, None).unwrap();
        assert_eq!(hits.len(), 1, "日期过滤后只应剩九月那条");
        assert_eq!(hits[0].occurred_on.as_deref(), Some("2026-09-10"));
    }

    /// 附件编目：每个附件一篇文档；二进制内容绝不进正文（规范 §5）。
    #[test]
    fn todo_attachments_become_catalog_docs() {
        let conn = db();
        let b64 = "QUJD".repeat(2000);
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at, date, attachments)
             VALUES('腿部力量训练','workout',0,'todo','x','2026-09-10', ?1)",
            [format!(
                r#"[{{"kind":"image","name":"膝盖.jpg","content":"data:image/jpeg;base64,{b64}","size":40960}},
                    {{"kind":"text","name":"医嘱.txt","content":"避免深蹲超过 60 公斤"}}]"#
            )],
        )
        .unwrap();
        let tid = conn.last_insert_rowid().to_string();
        take_dirty(&conn, 100).unwrap();

        // scan_all 的复合键枚举必须能把两个附件都列出来
        let queued = scan_all(&conn, &all()).unwrap();
        assert!(queued >= 2, "两个附件都应入队，实际 {queued}");

        for idx in 0..2 {
            let out = apply_one(&conn, "todo_attachment", &format!("{tid}:{idx}")).unwrap();
            assert!(out.doc_id.is_some(), "附件 {idx} 应编目");
        }

        // 图片编目：kind=image，路径在 附件/日程/ 下，正文无 base64
        let (kind, path, body): (String, String, String) = conn
            .query_row(
                "SELECT kind, path, body FROM kb_docs WHERE source_type='todo_attachment' AND source_id = ?1",
                [format!("{tid}:0")],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(kind, "image");
        assert!(path.starts_with("附件/日程/"), "路径 {path}");
        assert!(!body.contains("QUJD"), "base64 泄漏进附件编目正文");
        assert!(
            body.contains("膝盖.jpg") && body.contains("40 KB"),
            "{body}"
        );

        // 文本附件：正文进索引，可按内容检索
        let text_doc: String = conn
            .query_row(
                "SELECT body FROM kb_docs WHERE source_type='todo_attachment' AND body LIKE '%60 公斤%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(text_doc.contains("避免深蹲"));

        // 附件从 JSON 数组里删掉后，越界的编目文档要自愈删除
        conn.execute(
            "UPDATE todos SET attachments = '[]' WHERE id = ?1",
            [tid.parse::<i64>().unwrap()],
        )
        .unwrap();
        take_dirty(&conn, 100).unwrap();
        for idx in 0..2 {
            apply_one(&conn, "todo_attachment", &format!("{tid}:{idx}")).unwrap();
        }
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_docs WHERE source_type='todo_attachment'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "附件清空后编目应自愈清空");
    }

    /// 会话文档：整段对话可按会话回看（规范 §2 的 对话/ 命名空间）。
    #[test]
    fn conversation_doc_contains_transcript() {
        let conn = db();
        conn.execute(
            "INSERT INTO ai_chats(id, title, created_at, updated_at) VALUES('c9','膝盖康复','2026-09-10T08:00:00Z','2026-09-10T09:00:00Z')",
            [],
        )
        .unwrap();
        for (i, (role, kind, text)) in [
            ("user", "text", "深蹲时膝盖疼"),
            ("assistant", "tools", r#"{"kind":"tools","calls":[]}"#),
            (
                "assistant",
                "text",
                r#"{"kind":"chat","text":"建议先降低重量"}"#,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute(
                "INSERT INTO ai_chat_messages(id, chat_id, seq, role, kind, text, created_at)
                 VALUES(?1,'c9',?2,?3,?4,?5,'2026-09-10T08:0'||?2||':00Z')",
                rusqlite::params![format!("m{i}"), i as i64, role, kind, text],
            )
            .unwrap();
        }

        let out = apply_one(&conn, "chat", "c9").unwrap();
        let doc_id = out.doc_id.unwrap();
        let (path, body): (String, String) = conn
            .query_row(
                "SELECT path, body FROM kb_docs WHERE id = ?1",
                [doc_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(path.starts_with("对话/"), "路径 {path}");
        assert!(body.contains("用户：深蹲时膝盖疼"), "用户轮应入转录");
        assert!(body.contains("AI：建议先降低重量"), "AI 轮应拆出正文入转录");
        assert!(!body.contains("calls"), "工具过程卡应被跳过");

        // 会话也必须能被搜到
        let q = KbQuery {
            query: "降低重量".into(),
            sources: vec!["chat".into()],
            ..Default::default()
        };
        let hits = super::super::search::search(&conn, &q, &all(), None, None).unwrap();
        assert_eq!(hits.len(), 1, "会话转录应可检索");
        assert!(hits[0].path.as_deref().unwrap_or("").starts_with("对话/"));
    }

    /// 笔记分页：长文按 300 字切块，L1 只给首块，L2 按 offset/limit 逐页读（规范 §3）。
    #[test]
    fn note_content_is_paginated_by_chunks() {
        let conn = db();
        let long_body: String = "深蹲注意膝盖不要内扣。".repeat(60); // ~660 字 → 3 块
        conn.execute(
            "INSERT INTO kb_files(path, content, system, created_at, updated_at)
             VALUES('笔记/长文.md', ?1, 0, datetime('now'), datetime('now'))",
            [long_body],
        )
        .unwrap();
        let fid: i64 = conn.last_insert_rowid();
        let out = apply_one(&conn, "note", &fid.to_string()).unwrap();
        let doc_id = out.doc_id.unwrap();

        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_chunks WHERE doc_id = ?1",
                [doc_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(total >= 3, "长笔记应切成多块，实际 {total}");

        // 分页取第 2 页（offset=1, limit=1）
        let page: Vec<i64> = {
            let mut stmt = conn
                .prepare(
                    "SELECT ord FROM kb_chunks WHERE doc_id = ?1 ORDER BY ord LIMIT 1 OFFSET 1",
                )
                .unwrap();
            stmt.query_map([doc_id], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(page, vec![1], "第二页应是第 1 块（0 起）");
        assert!(1 + 1 < total, "应还有下一页（has_more 语义）");
    }
}
