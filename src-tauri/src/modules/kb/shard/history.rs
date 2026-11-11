//! `memory_shard_history`：唯一真相源（§4.3）。
//!
//! history 不截断；`HISTORY_MAX_ROWS` 是软上限，达到后 `search_hit` 只返回结果、
//! 不再写强化行（§5.2 / §4.3）。所有影响 stability/base_weight/floor 的事件都必须追加一行。
//!
//! 重放纪律（§4.3）：
//! - `birth`（seq=1）的 `stability` 是 s0 快照，重放从它出发；调 `s0` 只影响新 shard；
//! - `search_hit` 的 alpha 由 `hits_30d`/`rank` 现算，所以调 `ALPHA_*` 可重放；
//! - 只有 `search_hit` / `manual_mark` / `manual_restore` / `dream_revive` 改变 stability，
//!   其余事件（manual_edit/archive、dream_consolidate/supersede）只记录不改变它。
//!
//! 本模块不负责更新 `memory_shards` 的缓存列 —— 调用方在同一事务里调
//! `store::touch_shard`，history 与缓存必须一起提交。

use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::error::Result;

use super::model::{MemoryShardHistory, S_MAX};
use super::retrieve::{ALPHA_BASE, ALPHA_REDUCED, REDUCED_AFTER_HITS};
use super::store::NewHistory;

/// 单个 shard 的 history 行数软上限；达到后跳过写强化，但保留历史（§4.3）。
pub const HISTORY_MAX_ROWS: i64 = 512;

/// 追加一条 history；`false` = 幂等跳过（`dream_*` 的 run 内唯一索引命中，§4.3 / 附录 A）。
///
/// `seq` 由本函数取 `MAX(seq)+1`；同一 shard 在单连接上串行写入，不会撞主键。
/// 调用方负责与 `store::touch_shard` 同事务更新 shard 缓存。
pub fn append(tx: &Transaction<'_>, shard_id: i64, ev: NewHistory<'_>) -> Result<bool> {
    let changed = tx.execute(
        "INSERT INTO memory_shard_history
           (shard_id, seq, at, event, stability, base_weight, floor, factor, rank, hits_30d,
            origin, run_id, note)
         VALUES (
           ?1,
           COALESCE((SELECT MAX(seq) FROM memory_shard_history WHERE shard_id = ?1), 0) + 1,
           ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
         )
         ON CONFLICT DO NOTHING",
        rusqlite::params![
            shard_id,
            ev.at,
            ev.event,
            ev.stability,
            ev.base_weight,
            ev.floor,
            ev.factor,
            ev.rank,
            ev.hits_30d,
            ev.origin,
            ev.run_id,
            ev.note,
        ],
    )?;
    Ok(changed > 0)
}

/// 读取某个 shard 的全量 history（按 seq 升序；birth 在首行）（§4.3）。
pub fn load(conn: &Connection, shard_id: i64) -> Result<Vec<MemoryShardHistory>> {
    let mut stmt = conn.prepare(
        "SELECT seq, at, event, stability, base_weight, floor, factor, rank, hits_30d,
                run_id, note
         FROM memory_shard_history
         WHERE shard_id = ?1
         ORDER BY seq ASC",
    )?;
    let rows = stmt
        .query_map([shard_id], |r| {
            Ok(MemoryShardHistory {
                seq: r.get(0)?,
                at: r.get(1)?,
                event: r.get(2)?,
                stability: r.get(3)?,
                base_weight: r.get(4)?,
                floor: r.get(5)?,
                factor: r.get(6)?,
                rank: r.get(7)?,
                hits_30d: r.get(8)?,
                run_id: r.get(9)?,
                note: r.get(10)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 按 §4.3 的重放公式从 history 重建 stability（birth 的 `stability` 是 s0 快照）。
///
/// `search_hit` 用 `rank`/`hits_30d` 重算 alpha，所以调 `ALPHA_*` 可重放；
/// 调 `s0` 只影响新 shard。空 history 返回 0（调用方不应把 0 当合法 stability）。
pub fn replay(history: &[MemoryShardHistory]) -> f64 {
    let Some(birth) = history.first() else {
        return 0.0;
    };
    let birth_stability = birth.stability;
    let mut s = birth_stability;

    for row in &history[1..] {
        match row.event.as_str() {
            "search_hit" => {
                let hits = row.hits_30d.unwrap_or(0);
                let alpha = if hits >= REDUCED_AFTER_HITS {
                    ALPHA_REDUCED
                } else {
                    ALPHA_BASE
                };
                let rank = row.rank.unwrap_or(0).max(0) as f64;
                s *= 1.0 + alpha / (1.0 + rank);
            }
            // §4.3：mark 是 `max(old*2, 90)`，不是纯乘 2
            "manual_mark" => s = (s * 2.0).max(90.0),
            // 恢复的基准是 birth 快照：legacy=10 / manual_write=20 / marked=90。
            // 用 origin 默认值会把 legacy 行错误抬到 20（§3.3 最后一颗星）。
            "manual_restore" => s = s.max(birth_stability),
            "dream_revive" => s *= 1.25,
            // manual_edit / manual_archive / dream_consolidate / dream_supersede：不改变 stability
            _ => {}
        }
        s = s.min(S_MAX);
    }
    s
}

/// 近 `window_days` 天内 `search_hit` 的次数（§5.2 强化门控）。
///
/// SQL 用 `julianday(at)` 而不是字符串比较：history 里混有 RFC3339 与 SQLite 空格格式，
/// 按字符串比较会把 'T' 排在空格之后，窗口边界算错（§4.1）。
pub fn count_hits(conn: &Connection, shard_id: i64, window_days: i64) -> Result<i64> {
    let n = conn.query_row(
        "SELECT COUNT(*) FROM memory_shard_history
         WHERE shard_id = ?1 AND event = 'search_hit'
           AND julianday(at) >= julianday('now', ?2)",
        rusqlite::params![shard_id, format!("-{window_days} days")],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 某个 shard 的 history 总行数（`HISTORY_MAX_ROWS` 软上限判断，§5.2 / §4.3）。
pub fn count_rows(conn: &Connection, shard_id: i64) -> Result<i64> {
    let n = conn.query_row(
        "SELECT COUNT(*) FROM memory_shard_history WHERE shard_id = ?1",
        [shard_id],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 某条事件是否存在（例如 `manual_archive` 是否已经写过）。供命令层做幂等提示。
pub fn has_event(conn: &Connection, shard_id: i64, event: &str) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM memory_shard_history WHERE shard_id = ?1 AND event = ?2 LIMIT 1",
            rusqlite::params![shard_id, event],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn seed_shard(conn: &Connection, s0: f64) -> i64 {
        conn.execute(
            "INSERT INTO memory_shards
               (idempotency_key, origin, mem_type, content, base_weight, floor, stability,
                last_event_at, state, created_at, updated_at)
             VALUES ('test:1','manual_write','preference','测试',2.5,0.15,?1,
                     '2026-01-01T00:00:00+00:00','active',
                     '2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')",
            [s0],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn row(
        seq: i64,
        event: &str,
        stability: f64,
        rank: Option<i64>,
        hits: Option<i64>,
    ) -> MemoryShardHistory {
        MemoryShardHistory {
            seq,
            at: "2026-01-01T00:00:00+00:00".to_string(),
            event: event.to_string(),
            stability,
            base_weight: 2.5,
            floor: 0.15,
            factor: 1.0,
            rank,
            hits_30d: hits,
            run_id: String::new(),
            note: String::new(),
        }
    }

    #[test]
    fn replay_stability_reconstructs_cached_value() {
        let history = vec![
            row(1, "birth", 20.0, None, None),
            row(2, "search_hit", 0.0, Some(0), Some(0)),
            row(3, "search_hit", 0.0, Some(2), Some(1)),
            row(4, "manual_mark", 0.0, None, None),
            row(5, "dream_revive", 0.0, None, None),
            row(6, "manual_edit", 0.0, None, None),
        ];

        // 手算：20 * 1.8 = 36；* (1 + 0.8/3) = 45.6；mark → max(91.2, 90) = 91.2；
        // revive → 114.0；edit 不变。
        let expected = (20.0f64 * 1.8 * (1.0 + 0.8 / 3.0) * 2.0).max(90.0) * 1.25;
        let got = replay(&history);
        assert!(
            (got - expected).abs() < 1e-9,
            "重放应等于手算值 {expected}，实际 {got}"
        );
    }

    #[test]
    fn replay_reduces_alpha_after_five_hits_in_window() {
        let history = vec![
            row(1, "birth", 20.0, None, None),
            row(2, "search_hit", 0.0, Some(0), Some(REDUCED_AFTER_HITS)),
        ];
        let got = replay(&history);
        let expected = 20.0 * (1.0 + ALPHA_REDUCED);
        assert!(
            (got - expected).abs() < 1e-9,
            "30 天内 ≥5 次命中应使用 ALPHA_REDUCED"
        );
    }

    #[test]
    fn replay_manual_restore_uses_birth_snapshot_not_origin_default() {
        // legacy 行 birth s0 = 10；restore 不能把它抬到 manual_write 的 20
        let history = vec![
            row(1, "birth", 10.0, None, None),
            row(2, "manual_archive", 10.0, None, None),
            row(3, "manual_restore", 10.0, None, None),
        ];
        assert_eq!(
            replay(&history),
            10.0,
            "restore 的基准是 birth history 的 stability"
        );
    }

    #[test]
    fn replay_caps_at_s_max() {
        let mut history = vec![row(1, "birth", 3000.0, None, None)];
        for i in 0..10 {
            history.push(row(2 + i, "dream_revive", 0.0, None, None));
        }
        assert_eq!(replay(&history), S_MAX);
    }

    #[test]
    fn append_assigns_monotonic_seq_and_load_orders_rows() {
        let conn = conn();
        let id = seed_shard(&conn, 20.0);
        let tx = conn.unchecked_transaction().unwrap();
        assert!(append(
            &tx,
            id,
            NewHistory {
                at: "2026-01-01T00:00:00+00:00",
                event: "birth",
                stability: 20.0,
                base_weight: 2.5,
                floor: 0.15,
                factor: 1.0,
                origin: "manual_write",
                ..Default::default()
            }
        )
        .unwrap());
        assert!(append(
            &tx,
            id,
            NewHistory {
                at: "2026-01-02T00:00:00+00:00",
                event: "search_hit",
                stability: 36.0,
                base_weight: 2.5,
                floor: 0.15,
                factor: 1.8,
                rank: Some(0),
                hits_30d: Some(0),
                origin: "manual_write",
                ..Default::default()
            }
        )
        .unwrap());
        tx.commit().unwrap();

        let history = load(&conn, id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!((history[0].seq, history[0].event.as_str()), (1, "birth"));
        assert_eq!(
            (history[1].seq, history[1].event.as_str()),
            (2, "search_hit")
        );
        assert_eq!(history[1].rank, Some(0));
        assert_eq!(count_rows(&conn, id).unwrap(), 2);
        assert_eq!(replay(&history), 36.0);
    }

    #[test]
    fn manual_mark_floors_stability_at_ninety() {
        // s=20 → max(40, 90) = 90；s=60 → 120（不被 90 压回去）
        let low = vec![
            row(1, "birth", 20.0, None, None),
            row(2, "manual_mark", 0.0, None, None),
        ];
        assert_eq!(replay(&low), 90.0);
        let high = vec![
            row(1, "birth", 60.0, None, None),
            row(2, "manual_mark", 0.0, None, None),
        ];
        assert_eq!(replay(&high), 120.0);
    }

    #[test]
    fn append_is_idempotent_for_same_run_and_event() {
        let conn = conn();
        let id = seed_shard(&conn, 20.0);
        let tx = conn.unchecked_transaction().unwrap();
        let ev = || NewHistory {
            at: "2026-01-01T00:00:00+00:00",
            event: "dream_consolidate",
            stability: 20.0,
            base_weight: 1.25,
            floor: 0.15,
            factor: 1.0,
            run_id: "run-1",
            ..Default::default()
        };
        assert!(append(&tx, id, ev()).unwrap());
        assert!(
            !append(&tx, id, ev()).unwrap(),
            "同 run 同事件必须幂等跳过"
        );
        tx.commit().unwrap();

        assert_eq!(count_rows(&conn, id).unwrap(), 1);
        assert!(has_event(&conn, id, "dream_consolidate").unwrap());
    }

    #[test]
    fn count_hits_only_counts_recent_search_hits() {
        let conn = conn();
        let id = seed_shard(&conn, 20.0);
        conn.execute(
            "INSERT INTO memory_shard_history
               (shard_id, seq, at, event, stability, base_weight, floor)
             VALUES
               (?1, 1, datetime('now'), 'search_hit', 20.0, 2.5, 0.15),
               (?1, 2, datetime('now','-40 days'), 'search_hit', 20.0, 2.5, 0.15),
               (?1, 3, datetime('now'), 'manual_edit', 20.0, 2.5, 0.15)",
            [id],
        )
        .unwrap();
        assert_eq!(count_hits(&conn, id, 30).unwrap(), 1);
        assert_eq!(count_hits(&conn, id, 60).unwrap(), 2);
    }
}
