//! 长期记忆的**兼容适配层**（§3.3 / §5.6 / §10 B）。
//!
//! 记忆的真相源已经迁到 `memory_shards` + `memory_shard_history`（见 `shard` 模块）。
//! 本文件保留旧 `memory::*` 的函数名与返回形状，供：
//! - `kb/commands.rs` 的 13 条 `kb_memory_*` 兼容命令；
//! - `worker.rs` 的周期维护；
//! - `perf_probe.rs` 的基准；
//! - AI 工具的 `list_memories/remember/edit_memory/forget`。
//!
//! 兼容口径（§10 B 验收）：
//! - `kb_memories / overview / stats / duplicates / cognition` 只投影 **curated**
//!   （`manual_write / dream_summary / marked_important`），不含 `conversation`；
//! - `salience` 字段返回读时 `effective_weight`（不再有旧的「显著性」公式）；
//! - `dormant` 在兼容视图里归入「活跃/休眠」一侧，`stale` 统计映射为 dormant 数；
//! - `bump_active` 是 **no-op**：自动注入只读，不再「注入即续命」；
//! - `kb_cognition` 的文本仍是 `- [类型·分类] 内容`，`chat.ts` 的段落语义不变。
//!
//! 旧 `kb_memories` 表不再写入，只作为回滚源保留（§2.7）。

use rusqlite::Connection;
use serde_json::json;

use crate::error::Result;

use super::models::{
    KbCognition, KbMemory, KbMemoryOverview, KbMemoryStats, MemoryApplyResult, MemoryCandidate,
    MemoryMaintainResult,
};
use super::shard::commands as shard_commands;
use super::shard::decay;
use super::shard::inject::{self, INJECT_BUDGET_TOKENS, INJECT_MAX_SHARDS};
use super::shard::model::{MemoryShard, ShardWriteAction};
use super::shard::retrieve;
use super::shard::store;

pub use super::shard::model::MemoryDuplicate;

/// 查重的默认相似度阈值。低于它的一律不报——报多了模型反而会乱合并。
pub const DUP_THRESHOLD_DEFAULT: f64 = 0.86;

/// 记忆列表的视角：活跃（含 dormant）/ 已归档 / 全部。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryScope {
    Active,
    Archived,
    All,
}

/// 解析命令层传来的 scope 字符串，未知值收敛到 Active（最安全的默认）。
pub fn parse_scope(raw: Option<&str>) -> MemoryScope {
    match raw.map(str::trim) {
        Some("all") => MemoryScope::All,
        Some("archived") => MemoryScope::Archived,
        _ => MemoryScope::Active,
    }
}

/// 分类路径规范化：按 `/` 分层，逐段净化，最多两层、每段 ≤ 16 字。
/// 与虚拟路径共用同一套净化规则（source::sanitize），保证 `记忆/{类型}/{分类}/…` 永远合法。
#[allow(dead_code)] // 新写入路径在 store::normalize_category；这里保留给兼容调用方。
pub fn normalize_category(raw: &str) -> String {
    raw.split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .take(2)
        .map(|s| super::source::sanitize(s, 16))
        .collect::<Vec<_>>()
        .join("/")
}

/// shard → 旧 `KbMemory` 投影（读模型）。
///
/// - `salience` = 读时 `effective_weight`（旧前端仍按它排序/取前 5）；
/// - `active_count` 没有新语义，固定 0（旧字段只用于展示，不再续命）；
/// - `last_used_at` 用 `last_event_at` 近似（最后一次强化/确认时间）。
fn project(s: &MemoryShard) -> KbMemory {
    KbMemory {
        id: s.id,
        mem_type: s.mem_type.clone(),
        topic: s.topic.clone(),
        category: s.category.clone(),
        content: s.content.clone(),
        confidence: s.confidence,
        active_count: 0,
        source_chat_id: s.source_chat_id.clone().or_else(|| s.chat_id.clone()),
        created_at: s.created_at.clone(),
        updated_at: s.updated_at.clone(),
        last_used_at: if s.last_event_at.trim().is_empty() {
            None
        } else {
            Some(s.last_event_at.clone())
        },
        archived_at: s.archived_at.clone(),
        archived_reason: s.archived_reason.clone(),
        salience: s.effective_weight,
    }
}

/// 兼容列表是否包含该 shard（`dormant` 归入 Active 一侧，§4.5）。
fn in_scope(state: &str, scope: MemoryScope) -> bool {
    match scope {
        MemoryScope::Active => state != "archived",
        MemoryScope::Archived => state == "archived",
        MemoryScope::All => true,
    }
}

fn sweep_if_due_best_effort(conn: &Connection) {
    if let Err(e) = decay::sweep_if_due(conn, chrono::Utc::now()) {
        eprintln!("[memory] 兼容层懒巡检失败：{e}");
    }
}

/// 兼容列表：curated shard 投影；`dormant` 显示为活跃，`archived` 在归档页。
pub fn list(
    conn: &Connection,
    mem_type: Option<&str>,
    scope: MemoryScope,
) -> Result<Vec<KbMemory>> {
    sweep_if_due_best_effort(conn);
    let shards = store::list_shards(conn, "all", Some("curated"), 5000, 0)?;
    let mut out: Vec<KbMemory> = shards
        .into_iter()
        .filter(|s| in_scope(&s.state, scope))
        .filter(|s| {
            mem_type
                .filter(|t| !t.is_empty())
                .map(|t| s.mem_type == t)
                .unwrap_or(true)
        })
        .map(|s| project(&s))
        .collect();
    // 活跃永远排在归档前面；组内按最近修改（与旧 kb_memories 一致）。
    out.sort_by(|a, b| {
        (a.archived_at.is_some())
            .cmp(&b.archived_at.is_some())
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(out)
}

/// 把旧 `MemoryCandidate` 翻译成 shard 写入动作。
///
/// 关键修正（§2.4 既有缺陷）：
/// - update 的空字符串表示「没传」，不能回落成空串把 mem_type 重置为 preference；
/// - archive/delete 不需要 content 等字段。
fn to_action(c: &MemoryCandidate) -> ShardWriteAction {
    let non_empty = |s: &str| -> Option<String> {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    };
    ShardWriteAction {
        op: c.op.trim().to_lowercase(),
        id: c.id,
        content: non_empty(&c.content),
        mem_type: non_empty(&c.mem_type),
        topic: non_empty(&c.topic),
        category: non_empty(&c.category),
        confidence: c.confidence,
        reason: non_empty(&c.reason),
    }
}

/// 落库记忆变更。整体一个事务；继续写 `kb_memory_diffs` 审计（页面仍在读）。
pub fn apply(
    conn: &Connection,
    candidates: &[MemoryCandidate],
    chat_id: Option<&str>,
    source_message_ids: &[String],
) -> Result<MemoryApplyResult> {
    if candidates.is_empty() {
        return Ok(MemoryApplyResult {
            added: 0,
            updated: 0,
            deleted: 0,
            archived: 0,
            restored: 0,
            skipped: 0,
        });
    }
    let actions: Vec<ShardWriteAction> = candidates.iter().map(to_action).collect();
    let r = shard_commands::apply_actions_conn(conn, &actions, chat_id, source_message_ids)?;
    Ok(MemoryApplyResult {
        added: r.added,
        updated: r.updated,
        deleted: r.deleted,
        archived: r.archived,
        restored: r.restored,
        skipped: r.skipped,
    })
}

/// 删除一条记忆（AI 的 forget 工具与设置页的手动清理都用它）。
pub fn delete(conn: &Connection, id: i64) -> Result<bool> {
    shard_commands::delete_shard_conn(conn, id)
}

/// 归档一条记忆（软删除）。退出注入与检索，但保留可恢复。
pub fn archive(conn: &Connection, id: i64, reason: &str) -> Result<bool> {
    shard_commands::archive_shard(conn, id, reason)
}

/// 恢复一条已归档/休眠记忆：回到 active 并重新进入注入与检索范围。
pub fn restore(conn: &Connection, id: i64) -> Result<bool> {
    shard_commands::restore_shard_conn(conn, id)
}

/// 定期维护 = shard 状态巡检（active → dormant → archived）。
///
/// `checked` 是巡检行数，`archived` 是本轮归档数；`last_maintain_at` 继续刷新，
/// 供设置页展示。巡检本身不写 history（state 是派生缓存）。
pub fn maintain(conn: &Connection) -> Result<MemoryMaintainResult> {
    let out = decay::sweep(conn, chrono::Utc::now(), true)?;
    conn.execute(
        "UPDATE kb_settings SET last_maintain_at = datetime('now') WHERE id = 1",
        [],
    )?;
    if out.archived > 0 {
        conn.execute(
            "INSERT INTO kb_memory_diffs(chat_id, at, ops_json) VALUES (NULL, datetime('now'), ?1)",
            [serde_json::to_string(&json!({
                "maintain": true,
                "checked": out.checked,
                "dormant": out.dormant,
                "archived": out.archived,
            }))?],
        )?;
    }
    Ok(MemoryMaintainResult {
        checked: out.checked,
        archived: out.archived,
    })
}

/// 最近几次记忆变更的审计记录（谁在什么时候动了多少条）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDiffEntry {
    pub at: String,
    /// 变更计数（payload 里的字段原样透出，前端按需展示）
    pub payload: serde_json::Value,
}

/// 读最近 N 条记忆变更审计（抽取、整理、维护都写在同一张表）。
pub fn recent_diffs(conn: &Connection, limit: i64) -> Result<Vec<MemoryDiffEntry>> {
    let mut stmt =
        conn.prepare("SELECT at, ops_json FROM kb_memory_diffs ORDER BY id DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit.clamp(1, 50)], |r| {
        Ok(MemoryDiffEntry {
            at: r.get(0)?,
            payload: serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or(json!({})),
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 显式的信噪比指标与记忆库概况（UI 面板与整理决策共用）。
///
/// 新口径：
/// - `stale` = dormant 条数（休眠但可被主动检索）；
/// - `avg_salience` = 平均 `effective_weight`（兼容字段名，语义已换）；
/// - `signal_ratio` = 实际注入条数 / active 条数。
pub fn stats(conn: &Connection) -> Result<KbMemoryStats> {
    let s = shard_commands::compute_stats(conn, true)?;
    let (auto_consolidate, last_consolidate_at, last_maintain_at) = conn.query_row(
        "SELECT auto_consolidate, last_consolidate_at, last_maintain_at FROM kb_settings WHERE id = 1",
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)? != 0,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )?;
    Ok(KbMemoryStats {
        active: s.active,
        archived: s.archived,
        total: s.total,
        limit: s.limit,
        max_chars: s.max_chars,
        injected: s.injected,
        injected_chars: s.injected_chars,
        stale: s.dormant,
        avg_confidence: s.avg_confidence,
        avg_salience: s.avg_effective_weight,
        signal_ratio: s.signal_ratio,
        noise_ratio: s.noise_ratio,
        auto_consolidate,
        last_consolidate_at,
        last_maintain_at,
    })
}

/// 「关于你」首屏聚合：列表 / 概况 / 注入块三份视图来自同一套 shard 读。
pub fn overview(conn: &Connection) -> Result<KbMemoryOverview> {
    sweep_if_due_best_effort(conn);
    let memories = list(conn, None, MemoryScope::Active)?;
    let stats = stats(conn)?;
    let cognition = cognition(conn, None)?;
    Ok(KbMemoryOverview {
        memories,
        stats,
        cognition,
    })
}

/// 构建喂给系统提示词的紧凑认知块。
///
/// 内部走 `memory_shard_inject` 的同一套选择/预算/渲染（严格只读，不写 history）。
/// 文本格式保持 `- [类型·分类] 内容`，`chat.ts` 只认这个段落。
pub fn cognition(conn: &Connection, limit: Option<usize>) -> Result<KbCognition> {
    let max_shards = limit.unwrap_or(INJECT_MAX_SHARDS).clamp(1, 20);
    let out = inject::select(
        conn,
        None,
        None,
        None,
        INJECT_BUDGET_TOKENS,
        max_shards,
        false,
    )?;
    let mut memories = Vec::with_capacity(out.shards.len());
    for item in &out.shards {
        if let Some(s) = store::get_shard(conn, item.shard_id)? {
            memories.push(project(&s));
        } else {
            // 并发删除的兜底：文本仍来自注入结果，不丢行格式。
            memories.push(KbMemory {
                id: item.shard_id,
                mem_type: item.mem_type.clone(),
                topic: item.topic.clone(),
                category: item.category.clone(),
                content: item.content.clone(),
                confidence: 0.0,
                active_count: 0,
                source_chat_id: item.chat_id.clone(),
                created_at: String::new(),
                updated_at: String::new(),
                last_used_at: None,
                archived_at: None,
                archived_reason: None,
                salience: item.effective_weight,
            });
        }
    }
    Ok(KbCognition {
        memories,
        text: out.text,
    })
}

/// **no-op**：自动注入只读（§0 决策 #5 / §5.1）。保留命令与函数一个版本，
/// 前端删除 `memoryBump` 调用后再删。
pub fn bump_active(_conn: &Connection, _ids: &[i64]) -> Result<()> {
    Ok(())
}

/// **no-op**：Dream 已取代旧整理编排（§0 决策 #7）。
pub fn mark_consolidated(_conn: &Connection) -> Result<()> {
    Ok(())
}

/// 疑似重复的 shard 对（只读已落库向量，零模型成本）。
pub fn duplicate_pairs(
    conn: &Connection,
    model_id: Option<&str>,
    threshold: f64,
    limit: i64,
) -> Result<Vec<MemoryDuplicate>> {
    // 兼容口径只看 curated，不把原始对话片段当「记忆重复」报给整理器。
    retrieve::duplicate_pairs_scoped(conn, model_id, threshold, limit, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::models::MEMORY_TYPES;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn cand(op: &str, t: &str, topic: &str, content: &str) -> MemoryCandidate {
        MemoryCandidate {
            op: op.into(),
            id: None,
            mem_type: t.into(),
            topic: topic.into(),
            category: String::new(),
            content: content.into(),
            confidence: None,
            reason: String::new(),
        }
    }

    fn shard_id_of(conn: &Connection, content: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM memory_shards WHERE content = ?1",
            [content],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn compat_add_then_duplicate_is_skipped() {
        let conn = db();
        let c = vec![cand("add", "constraint", "膝盖", "避免深蹲过深")];
        let r1 = apply(&conn, &c, Some("c1"), &[]).unwrap();
        assert_eq!((r1.added, r1.skipped), (1, 0));

        let r2 = apply(&conn, &c, Some("c2"), &[]).unwrap();
        assert_eq!((r2.added, r2.skipped), (0, 1));
        assert_eq!(count(&conn, "memory_shards"), 1);
    }

    #[test]
    fn compat_update_is_partial() {
        let conn = db();
        let mut add = cand("add", "constraint", "膝盖", "旧描述");
        add.category = "健康/训练".into();
        apply(&conn, &[add], None, &[]).unwrap();
        let id = shard_id_of(&conn, "旧描述");

        // 只传 content：mem_type/topic/category 必须保留（旧实现会把类型重置成 preference）。
        let mut upd = cand("update", "", "", "新描述");
        upd.id = Some(id);
        let r = apply(&conn, &[upd], None, &[]).unwrap();
        assert_eq!(r.updated, 1);
        let rows = list(&conn, None, MemoryScope::Active).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "新描述");
        assert_eq!(rows[0].mem_type, "constraint");
        assert_eq!(rows[0].topic, "膝盖");
        assert_eq!(rows[0].category, "健康/训练");
    }

    #[test]
    fn compat_add_is_idempotent_and_restores_archived() {
        let conn = db();
        let c = cand("add", "constraint", "膝盖", "避免深蹲过深");
        apply(&conn, std::slice::from_ref(&c), None, &[]).unwrap();
        let id = shard_id_of(&conn, "避免深蹲过深");
        assert!(archive(&conn, id, "decay").unwrap());

        let r = apply(&conn, std::slice::from_ref(&c), None, &[]).unwrap();
        assert_eq!((r.added, r.restored, r.skipped), (0, 1, 0));
        let rows = list(&conn, None, MemoryScope::Active).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].archived_at.is_none());
    }

    #[test]
    fn compat_update_unarchives() {
        let conn = db();
        apply(&conn, &[cand("add", "event", "训练", "旧描述")], None, &[]).unwrap();
        let id = shard_id_of(&conn, "旧描述");
        archive(&conn, id, "decay").unwrap();

        let mut upd = cand("update", "", "", "新描述");
        upd.id = Some(id);
        let r = apply(&conn, &[upd], None, &[]).unwrap();
        assert_eq!(r.restored, 1, "归档中编辑应复活，且不再误报 updated=0");
        assert_eq!(list(&conn, None, MemoryScope::Active).unwrap().len(), 1);
    }

    #[test]
    fn compat_cognition_keeps_line_format() {
        let conn = db();
        let mut c = cand("add", "constraint", "膝盖", "深蹲不宜超过 60kg");
        c.category = "健康/训练".into();
        apply(&conn, &[c], None, &[]).unwrap();
        let cog = cognition(&conn, None).unwrap();
        assert!(
            cog.text.contains("- [约束·健康/训练] 深蹲不宜超过 60kg"),
            "兼容文本格式不能变：{}",
            cog.text
        );
        assert_eq!(cog.memories.len(), 1);
        assert!(MEMORY_TYPES.contains(&cog.memories[0].mem_type.as_str()));
    }

    #[test]
    fn compat_list_scopes_include_dormant() {
        let conn = db();
        apply(&conn, &[cand("add", "event", "t", "会休眠的记忆")], None, &[]).unwrap();
        let id = shard_id_of(&conn, "会休眠的记忆");
        conn.execute(
            "UPDATE memory_shards SET state = 'dormant' WHERE id = ?1",
            [id],
        )
        .unwrap();

        assert_eq!(list(&conn, None, MemoryScope::Active).unwrap().len(), 1);
        assert_eq!(list(&conn, None, MemoryScope::Archived).unwrap().len(), 0);
        assert_eq!(list(&conn, None, MemoryScope::All).unwrap().len(), 1);
    }

    #[test]
    fn compat_stats_maps_dormant_to_stale() {
        let conn = db();
        for i in 0..3 {
            apply(
                &conn,
                &[cand("add", "preference", &format!("t{i}"), &format!("内容 {i}"))],
                None,
                &[],
            )
            .unwrap();
        }
        let id = shard_id_of(&conn, "内容 0");
        conn.execute(
            "UPDATE memory_shards SET state = 'dormant' WHERE id = ?1",
            [id],
        )
        .unwrap();

        let s = stats(&conn).unwrap();
        assert_eq!(s.active, 2);
        assert_eq!(s.stale, 1, "dormant 映射到兼容 stale");
        assert_eq!(s.total, 3);
        assert!(s.avg_salience > 0.0);
        assert!(s.injected <= 3);
    }

    #[test]
    fn compat_bump_is_noop() {
        let conn = db();
        apply(&conn, &[cand("add", "event", "t", "不会被注入续命")], None, &[]).unwrap();
        let id = shard_id_of(&conn, "不会被注入续命");
        let before: (f64, String, i64) = conn
            .query_row(
                "SELECT stability, state, (SELECT COUNT(*) FROM memory_shard_history WHERE shard_id = ?1)
                 FROM memory_shards WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        bump_active(&conn, &[id]).unwrap();
        let after: (f64, String, i64) = conn
            .query_row(
                "SELECT stability, state, (SELECT COUNT(*) FROM memory_shard_history WHERE shard_id = ?1)
                 FROM memory_shards WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn compat_audit_and_duplicate_commands_are_available() {
        let conn = db();
        apply(
            &conn,
            &[cand("add", "preference", "饮食", "不喜欢香菜")],
            Some("c9"),
            &[],
        )
        .unwrap();
        let diffs = recent_diffs(&conn, 5).unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].payload["added"], 1);

        // keyword 模式（没有 model_id）→ 空表，调用方自然降级。
        assert!(duplicate_pairs(&conn, None, 0.86, 10).unwrap().is_empty());

        // 兼容命令全套可用（overview/stats/cognition 共用同一份 shard 读）。
        let ov = overview(&conn).unwrap();
        assert_eq!(ov.memories.len(), 1);
        assert_eq!(ov.stats.active, 1);
        assert!(ov.cognition.text.contains("不喜欢香菜"));

        // 删除后三个视图都清空。
        let id = shard_id_of(&conn, "不喜欢香菜");
        assert!(delete(&conn, id).unwrap());
        assert!(list(&conn, None, MemoryScope::All).unwrap().is_empty());
        assert_eq!(count(&conn, "memory_shards"), 0);
    }

    #[test]
    fn compat_unknown_op_is_rejected() {
        let conn = db();
        let e = apply(&conn, &[cand("upsert", "event", "t", "x")], None, &[]);
        assert!(e.is_err(), "只允许 add/update/delete/archive");
    }

    #[test]
    fn compat_empty_content_is_not_stored() {
        let conn = db();
        let r = apply(&conn, &[cand("add", "event", "t", "   ")], None, &[]).unwrap();
        assert_eq!((r.added, r.skipped), (0, 1));
        assert_eq!(count(&conn, "memory_shards"), 0);
    }

    #[test]
    fn compat_mark_consolidated_is_noop() {
        let conn = db();
        let read = |conn: &Connection| -> Option<String> {
            conn.query_row(
                "SELECT last_consolidate_at FROM kb_settings WHERE id = 1",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap()
        };
        let before = read(&conn);
        mark_consolidated(&conn).unwrap();
        let after = read(&conn);
        assert_eq!(before, after);
    }
}
