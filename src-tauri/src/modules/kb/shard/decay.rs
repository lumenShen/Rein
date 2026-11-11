//! 遗忘与状态机：公式、阈值、懒巡检（§4.1 / §4.2 / §4.4）。
//!
//! state 是派生缓存，可由 `base_weight/floor/stability/last_event_at` 重算；
//! sweep 不写 history。所有时间解析走 `model::parse_ts`，SQL 排序用 `julianday(...)`。
//!
//! 公式（§4.1）：
//! ```text
//! dt_days = max(0, (now - last_event_at) / 86400)
//! R       = exp(-dt_days / max(stability, 0.1))
//! W       = base_weight * (floor + (1 - floor) * R)
//! state   = active if W >= 0.25; dormant if W >= 0.08; else archived
//! ```
//!
//! `floor` 是乘数不是最终权重：marked_important 的地板权重是 4.0×0.35=1.4，
//! 永远 ≥ THETA_ACTIVE；conversation 的地板是 1.0×0.05=0.05，最终必定 archived。
//!
//! sweep 是**派生缓存重算**，不是事件：不写 history、不改 last_event_at；
//! 归档/复活只同步 `index::delete_doc` / `index::mark_dirty` 让 kb_docs 镜像跟上（§4.4）。

use chrono::{DateTime, Utc};
use rusqlite::Connection;

use crate::db;
use crate::error::Result;
use crate::modules::kb::index;

use super::model::{parse_ts, MemoryShard, ShardSweepResult};

/// active 阈值：W ≥ 0.25（§4.2）。
pub const THETA_ACTIVE: f64 = 0.25;
/// dormant 阈值：0.08 ≤ W < 0.25；低于它 archived（§4.2）。
pub const THETA_DORMANT: f64 = 0.08;
/// 懒巡检最小间隔（秒）（§4.2 / §4.4）。
pub const SWEEP_INTERVAL_SECS: u64 = 600;
/// 单次 sweep 最多扫描的行数（§4.4）。
pub const SWEEP_MAX_ROWS: i64 = 20000;
/// `app_meta` 里 `last_sweep` 的键（§4.4）。
pub const LAST_SWEEP_KEY: &str = "memory.shard.last_sweep_at";

/// 权重核心公式；`last_event_at` 解析失败按「刚发生」处理（不让坏格式把记忆误判为归档）。
pub fn weight_of(
    base_weight: f64,
    floor: f64,
    stability: f64,
    last_event_at: &str,
    now: DateTime<Utc>,
) -> f64 {
    let dt_days = parse_ts(last_event_at)
        .map(|t| (now - t).num_seconds() as f64 / 86_400.0)
        .unwrap_or(0.0)
        .max(0.0);
    let stability = stability.max(0.1);
    let decay = (-dt_days / stability).exp();
    base_weight * (floor + (1.0 - floor) * decay)
}

/// 读时权重：`W = base_weight * (floor + (1 - floor) * exp(-dt_days / max(stability, 0.1)))`（§4.1）。
pub fn effective_weight(shard: &MemoryShard, now: DateTime<Utc>) -> f64 {
    weight_of(
        shard.base_weight,
        shard.floor,
        shard.stability,
        &shard.last_event_at,
        now,
    )
}

/// 按 W 判定状态（§4.1）：active / dormant / archived。
pub fn state_for(weight: f64) -> &'static str {
    if weight >= THETA_ACTIVE {
        "active"
    } else if weight >= THETA_DORMANT {
        "dormant"
    } else {
        "archived"
    }
}

/// 最近一次 sweep 的时间（`app_meta`，RFC3339；无则 None）。
pub fn last_sweep_at(conn: &Connection) -> Option<String> {
    db::meta_get(conn, LAST_SWEEP_KEY)
}

fn empty_result() -> ShardSweepResult {
    ShardSweepResult {
        checked: 0,
        activated: 0,
        dormant: 0,
        archived: 0,
    }
}

/// 全量巡检（§4.4）：重算非 archived、未合并 shard 的 state；归档/复活同步镜像。
///
/// 不写 history；`archived_at/archived_reason='decay'`；超过 `SWEEP_MAX_ROWS` 时只扫最近
/// 20000 条并由 stats 报 `sweepTruncated=true`。`force=false` 时受 `SWEEP_INTERVAL_SECS`
/// 节流（未到期返回空结果）。
pub fn sweep(conn: &Connection, now: DateTime<Utc>, force: bool) -> Result<ShardSweepResult> {
    if !force {
        if let Some(raw) = last_sweep_at(conn) {
            if let Some(last) = parse_ts(&raw) {
                let elapsed = (now - last).num_seconds();
                // 时钟被往回拨（elapsed < 0）时视为到期：否则一次系统改时会让巡检停摆。
                if (0..SWEEP_INTERVAL_SECS as i64).contains(&elapsed) {
                    return Ok(empty_result());
                }
            }
        }
    }

    let tx = conn.unchecked_transaction()?;
    let mut result = empty_result();
    let now_s = now.to_rfc3339();

    // 只扫未归档、未合并的行；按 julianday 排序兼容两种时间格式（§4.1）。
    let rows: Vec<(i64, f64, f64, f64, String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, base_weight, floor, stability, last_event_at, state
             FROM memory_shards
             WHERE state != 'archived' AND consolidated_into IS NULL
             ORDER BY julianday(last_event_at) DESC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([SWEEP_MAX_ROWS], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    for (id, base, floor, stability, last_event_at, old_state) in rows {
        result.checked += 1;
        let w = weight_of(base, floor, stability, &last_event_at, now);
        let new_state = state_for(w);
        if new_state == old_state {
            continue;
        }
        match new_state {
            "dormant" => {
                tx.execute(
                    "UPDATE memory_shards SET state='dormant' WHERE id = ?1",
                    [id],
                )?;
                result.dormant += 1;
            }
            "active" => {
                // dormant → active（缓存滞后/命中复活后权重回升）。sweep 不是事件，不改 updated_at。
                tx.execute(
                    "UPDATE memory_shards
                     SET state='active', archived_at=NULL, archived_reason=NULL
                     WHERE id = ?1",
                    [id],
                )?;
                index::mark_dirty(&tx, "memory", &id.to_string())?;
                result.activated += 1;
            }
            _ => {
                tx.execute(
                    "UPDATE memory_shards
                     SET state='archived', archived_at=?2, archived_reason='decay'
                     WHERE id = ?1",
                    rusqlite::params![id, now_s],
                )?;
                // 归档退出 kb_search 镜像；与旧 archive_in_tx 同形（memory.rs:375-391）
                index::delete_doc(&tx, "memory", &id.to_string())?;
                result.archived += 1;
            }
        }
    }

    // last_sweep_at 与 state 更新同事务提交，避免两个读路径同时扫（§4.4）
    db::meta_set(&tx, LAST_SWEEP_KEY, &now_s)?;
    tx.commit()?;
    Ok(result)
}

/// 到点才巡检；未到期返回 `None`（读 `app_meta` 键 `memory.shard.last_sweep_at`，§4.4）。
///
/// `memory_shard_inject` 绝不调用本函数：自动注入是严格只读路径。
pub fn sweep_if_due(conn: &Connection, now: DateTime<Utc>) -> Result<Option<ShardSweepResult>> {
    if let Some(raw) = last_sweep_at(conn) {
        if let Some(last) = parse_ts(&raw) {
            let elapsed = (now - last).num_seconds();
            if (0..SWEEP_INTERVAL_SECS as i64).contains(&elapsed) {
                return Ok(None);
            }
        }
    }
    sweep(conn, now, true).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 11, 0, 0, 0).unwrap()
    }

    fn shard(base: f64, floor: f64, stability: f64, last_event_at: &str) -> MemoryShard {
        MemoryShard {
            id: 1,
            origin: "conversation".into(),
            mem_type: "event".into(),
            topic: String::new(),
            category: String::new(),
            content: "x".into(),
            confidence: 0.7,
            base_weight: base,
            floor,
            stability,
            last_event_at: last_event_at.into(),
            state: "active".into(),
            anchor_message_id: None,
            chat_id: None,
            user_message_id: None,
            provenance: serde_json::json!({}),
            supersedes: None,
            consolidated_into: None,
            dream_action: None,
            source_chat_id: None,
            created_at: "2026-01-01T00:00:00+00:00".into(),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
            archived_at: None,
            archived_reason: None,
            effective_weight: 0.0,
        }
    }

    fn seed(
        conn: &Connection,
        key: &str,
        base: f64,
        floor: f64,
        stability: f64,
        last_event_at: &str,
        state: &str,
    ) -> i64 {
        conn.execute(
            "INSERT INTO memory_shards
               (idempotency_key, origin, mem_type, content, base_weight, floor, stability,
                last_event_at, state, created_at, updated_at)
             VALUES (?1,'conversation','event','x',?2,?3,?4,?5,?6,
                     '2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')",
            rusqlite::params![key, base, floor, stability, last_event_at, state],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn state_of(conn: &Connection, id: i64) -> String {
        conn.query_row("SELECT state FROM memory_shards WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn effective_weight_matches_ebbinghaus_formula() {
        let s = shard(2.5, 0.15, 20.0, "2026-01-01T00:00:00+00:00");
        // dt=10 天，R=exp(-0.5)
        let expected = 2.5 * (0.15 + 0.85 * (-10.0f64 / 20.0).exp());
        let got = effective_weight(&s, now());
        assert!((got - expected).abs() < 1e-12);
        assert!(got < 2.5 && got > 2.5 * 0.15);
    }

    #[test]
    fn effective_weight_parses_both_time_formats() {
        let rfc = shard(1.0, 0.05, 3.0, "2026-01-01T00:00:00+00:00");
        let sql = shard(1.0, 0.05, 3.0, "2026-01-01 00:00:00");
        let a = effective_weight(&rfc, now());
        let b = effective_weight(&sql, now());
        assert!((a - b).abs() < 1e-12, "SQLite 空格格式必须按 UTC 解析");
    }

    #[test]
    fn effective_weight_is_monotonic_in_elapsed_time() {
        let mut last = f64::INFINITY;
        for days in [0i64, 1, 3, 7, 30, 365, 3650] {
            let at = now() - chrono::Duration::days(days);
            let s = shard(2.5, 0.15, 20.0, &at.to_rfc3339());
            let w = effective_weight(&s, now());
            assert!(w < last, "dt={days} 天时权重应严格下降（{w} < {last}）");
            assert!(
                w >= 2.5 * 0.15 - 1e-12,
                "权重永远不应低于 base×floor（地板）"
            );
            last = w;
        }
    }

    #[test]
    fn state_threshold_switch_is_inclusive_at_active() {
        assert_eq!(state_for(0.25), "active", "W = THETA_ACTIVE 属于 active");
        assert_eq!(state_for(0.249_999), "dormant");
        assert_eq!(state_for(0.08), "dormant", "W = THETA_DORMANT 属于 dormant");
        assert_eq!(state_for(0.079_999), "archived");
    }

    #[test]
    fn sweep_transitions_active_dormant_archived() {
        let conn = conn();
        let fresh = seed(
            &conn,
            "fresh",
            1.0,
            0.05,
            3.0,
            "2026-01-11T00:00:00+00:00",
            "active",
        );
        let quiet = seed(
            &conn,
            "quiet",
            1.0,
            0.05,
            3.0,
            "2026-01-01T00:00:00+00:00",
            "active",
        );
        let ancient = seed(
            &conn,
            "ancient",
            1.0,
            0.05,
            3.0,
            "2025-10-01T00:00:00+00:00",
            "active",
        );
        // 缓存滞后：状态还写着 dormant，但权重早已回升
        let stale_cache = seed(
            &conn,
            "stale",
            1.0,
            0.05,
            3.0,
            "2026-01-11T00:00:00+00:00",
            "dormant",
        );

        let r = sweep(&conn, now(), true).unwrap();
        assert_eq!(r.checked, 4);
        assert_eq!(r.dormant, 1, "10 天前的 conversation shard 应休眠");
        assert_eq!(r.archived, 1, "100 天前的 conversation shard 应归档");
        assert_eq!(r.activated, 1, "缓存滞后的 dormant 应复活");

        assert_eq!(state_of(&conn, fresh), "active");
        assert_eq!(state_of(&conn, quiet), "dormant");
        assert_eq!(state_of(&conn, ancient), "archived");
        assert_eq!(state_of(&conn, stale_cache), "active");

        let reason: Option<String> = conn
            .query_row(
                "SELECT archived_reason FROM memory_shards WHERE id=?1",
                [ancient],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(reason.as_deref(), Some("decay"));
        let archived_at: Option<String> = conn
            .query_row(
                "SELECT archived_at FROM memory_shards WHERE id=?1",
                [ancient],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(archived_at.as_deref(), Some(now().to_rfc3339().as_str()));

        // archived 不再参与下一次 sweep
        let again = sweep(&conn, now(), true).unwrap();
        assert_eq!(again.checked, 3);
        assert_eq!(again.archived, 0);
    }

    #[test]
    fn marked_important_floor_never_archives() {
        let conn = conn();
        let id = seed(
            &conn,
            "important",
            4.0,
            0.35,
            3650.0,
            "1970-01-01 00:00:00",
            "active",
        );
        let r = sweep(&conn, now(), true).unwrap();
        assert_eq!(state_of(&conn, id), "active", "floor 权重 1.4 永远 ≥ 0.25");
        assert_eq!(r.archived, 0);

        // 读时权重也必须是地板权重，而不是 0
        let w: f64 = {
            let mut stmt = conn
                .prepare("SELECT base_weight, floor, stability, last_event_at FROM memory_shards WHERE id=?1")
                .unwrap();
            let (b, f, s, at) = stmt
                .query_row([id], |r| {
                    Ok((
                        r.get::<_, f64>(0)?,
                        r.get::<_, f64>(1)?,
                        r.get::<_, f64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .unwrap();
            weight_of(b, f, s, &at, now())
        };
        // floor 是乘数：base×floor = 1.4 是渐近下界；56 年后仍只剩极小的衰减余量
        assert!(w >= 1.4 && w < 1.42, "marked_important 权重应贴着 1.4 的地板：{w}");
    }

    #[test]
    fn sweep_is_noop_for_consolidated_shards() {
        let conn = conn();
        let keeper = seed(
            &conn,
            "keeper",
            1.0,
            0.05,
            3.0,
            "2026-01-11T00:00:00+00:00",
            "active",
        );
        let merged = seed(
            &conn,
            "merged",
            1.0,
            0.05,
            3.0,
            "2025-01-01T00:00:00+00:00",
            "dormant",
        );
        conn.execute(
            "UPDATE memory_shards SET consolidated_into=?1 WHERE id=?2",
            [keeper, merged],
        )
        .unwrap();

        let r = sweep(&conn, now(), true).unwrap();
        assert_eq!(r.checked, 1, "已合并 shard 不参与 sweep");
        assert_eq!(state_of(&conn, merged), "dormant");
    }

    #[test]
    fn sweep_if_due_throttles_for_ten_minutes() {
        let conn = conn();
        let first = sweep_if_due(&conn, now()).unwrap();
        assert!(first.is_some(), "没有 last_sweep 时应立即巡检");
        assert_eq!(
            last_sweep_at(&conn).as_deref(),
            Some(now().to_rfc3339().as_str())
        );

        let second = sweep_if_due(&conn, now() + chrono::Duration::seconds(599)).unwrap();
        assert!(second.is_none(), "10 分钟内不重复巡检");

        let third = sweep_if_due(&conn, now() + chrono::Duration::seconds(600)).unwrap();
        assert!(third.is_some(), "满 10 分钟应再次巡检");
    }

    #[test]
    fn sweep_without_force_respects_throttle() {
        let conn = conn();
        assert_eq!(sweep(&conn, now(), false).unwrap().checked, 0);
        let first = last_sweep_at(&conn).expect("第一次没有 last_sweep，应真的巡检并写键");
        // 10 分钟内 force=false 直接返回空结果，不改 last_sweep
        assert_eq!(
            sweep(&conn, now() + chrono::Duration::seconds(60), false)
                .unwrap()
                .checked,
            0
        );
        assert_eq!(last_sweep_at(&conn).unwrap(), first);
    }
}
