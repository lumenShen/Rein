//! 动作详解的覆盖层（迁移 0048）· 命令名与前端 `exerciseLibService.ts` 对应。
//!
//! 职责边界：本模块只负责**存与校验**一段已经组装完整的五段式文案（准备 3 条 / 开始 /
//! 结束 / 注意 1–3 条 / 每次循环秒数）。「当前生效值 = 覆盖 ?? 内置基线」的合成在前端
//! `stores/exerciseLib.ts::guideOf` 里做 —— 基线在 `config/exerciseGuide.ts`（编进包），
//! Rust 侧看不到，也不该为它再抄一份。
//!
//! 所以**局部修改靠前端先读再合并**：模型只想改一条「注意」时，工具层拿当前生效值补齐
//! 其余四段再整体提交；本表永远只存完整行，读侧不必猜哪几段是新的。

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;

/// 单段文案上限（字）。内置 81 条的实测最长 32 字，给到 60 是留出改写的余地，
/// 又不至于让 AI 把一段写成小作文 —— 沉浸页 compact 档只有一行。
const MAX_LINE: usize = 60;
/// 注意条数上限：界面上就是两条（compact 档只显示第一条），第三条留给特殊动作。
const MAX_CAUTIONS: usize = 3;

/// 一条覆盖行 · 前端 `ExerciseGuideOverride`（字段名与 `ExerciseGuide` 对齐）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseGuideRow {
    pub exercise_id: String,
    pub setup: Vec<String>,
    pub start: String,
    pub end: String,
    pub cautions: Vec<String>,
    pub rep_sec: i64,
    /// 最后改动者：`ai` / `user`（只作展示与排查用，不参与合成）
    pub updated_by: String,
    pub updated_at: String,
}

/// 写入入参：五段必须是**完整**的（局部修改由前端合并后提交）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseGuideInput {
    pub exercise_id: String,
    pub setup: Vec<String>,
    pub start: String,
    pub end: String,
    pub cautions: Vec<String>,
    #[serde(default)]
    pub rep_sec: i64,
    #[serde(default)]
    pub updated_by: Option<String>,
}

const SELECT: &str = "\
    SELECT exercise_id, setup, start_text, end_text, cautions, rep_sec, updated_by, updated_at \
    FROM exercise_guides";

fn row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExerciseGuideRow> {
    let setup: String = row.get(1)?;
    let cautions: String = row.get(4)?;
    Ok(ExerciseGuideRow {
        exercise_id: row.get(0)?,
        setup: serde_json::from_str(&setup).unwrap_or_default(),
        start: row.get(2)?,
        end: row.get(3)?,
        cautions: serde_json::from_str(&cautions).unwrap_or_default(),
        rep_sec: row.get(5)?,
        updated_by: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// 单段文案：去首尾空白 → 非空 → 不超长。超长直接报错而不是静默截断：
/// 截断会得到一个读起来断句的句子，模型还以为写进去了。
fn line(text: &str, field: &str) -> Result<String> {
    let t = text.trim();
    if t.is_empty() {
        return Err(ReinError::Message(format!("{field}不能为空")));
    }
    if t.chars().count() > MAX_LINE {
        return Err(ReinError::Message(format!(
            "{field}最多 {MAX_LINE} 字，当前 {} 字；请压缩后重试",
            t.chars().count()
        )));
    }
    Ok(t.to_string())
}

/// 准备必须**恰好** 3 条：界面按 1/2/3 编号排（摆位 → 躯干 → 呼吸绷紧），
/// 少一条会露出空号，多一条编号规则就不成立了。
fn setup_lines(v: &[String]) -> Result<Vec<String>> {
    if v.len() != 3 {
        return Err(ReinError::Message(format!(
            "setup 必须恰好 3 条（摆位 → 躯干 → 呼吸/绷紧），当前 {} 条",
            v.len()
        )));
    }
    v.iter()
        .enumerate()
        .map(|(i, s)| line(s, &format!("setup 第 {} 条", i + 1)))
        .collect()
}

fn caution_lines(v: &[String]) -> Result<Vec<String>> {
    if v.is_empty() {
        return Err(ReinError::Message(
            "cautions 至少 1 条：这个动作最容易犯的错，不能空着".into(),
        ));
    }
    if v.len() > MAX_CAUTIONS {
        return Err(ReinError::Message(format!(
            "cautions 最多 {MAX_CAUTIONS} 条，当前 {} 条",
            v.len()
        )));
    }
    v.iter()
        .enumerate()
        .map(|(i, s)| line(s, &format!("cautions 第 {} 条", i + 1)))
        .collect()
}

/// 全部覆盖行（量极小：只含被改过的动作，全量拉给前端合成）
#[tauri::command]
pub fn list_exercise_guides(state: State<AppState>) -> Result<Vec<ExerciseGuideRow>> {
    list_impl(&state.db.lock())
}

fn list_impl(conn: &rusqlite::Connection) -> Result<Vec<ExerciseGuideRow>> {
    let sql = format!("{SELECT} ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_from)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 写一条覆盖（整行）。动作必须已存在 —— 否则覆盖层会指向一条永远不展示的 id。
#[tauri::command]
pub fn upsert_exercise_guide(
    state: State<AppState>,
    input: ExerciseGuideInput,
) -> Result<ExerciseGuideRow> {
    upsert_impl(&state.db.lock(), input)
}

fn upsert_impl(
    conn: &rusqlite::Connection,
    input: ExerciseGuideInput,
) -> Result<ExerciseGuideRow> {
    let setup = setup_lines(&input.setup)?;
    let start = line(&input.start, "start（开始/轨迹）")?;
    let end = line(&input.end, "end（结束/回位）")?;
    let cautions = caution_lines(&input.cautions)?;
    if !(0..=120).contains(&input.rep_sec) {
        return Err(ReinError::Message(format!(
            "repSec（每次循环秒数）应在 0–120，当前 {}；计时/有氧动作给 0",
            input.rep_sec
        )));
    }
    let by = match input.updated_by.as_deref() {
        Some("user") => "user",
        _ => "ai",
    };

    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM exercises WHERE id = ?1", [&input.exercise_id], |r| {
            r.get(0)
        })
        .optional()?;
    if exists.is_none() {
        return Err(ReinError::Message(format!(
            "动作不存在：{}（先用 list_exercises 拿 id，或按名称精确定位）",
            input.exercise_id
        )));
    }

    conn.execute(
        "INSERT INTO exercise_guides \
         (exercise_id, setup, start_text, end_text, cautions, rep_sec, updated_by, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now')) \
         ON CONFLICT(exercise_id) DO UPDATE SET \
           setup = excluded.setup, start_text = excluded.start_text, \
           end_text = excluded.end_text, cautions = excluded.cautions, \
           rep_sec = excluded.rep_sec, updated_by = excluded.updated_by, \
           updated_at = excluded.updated_at",
        params![
            input.exercise_id,
            serde_json::to_string(&setup)?,
            start,
            end,
            serde_json::to_string(&cautions)?,
            input.rep_sec,
            by,
        ],
    )?;

    let sql = format!("{SELECT} WHERE exercise_id = ?1");
    Ok(conn.query_row(&sql, [&input.exercise_id], row_from)?)
}

/// 删掉覆盖 = 恢复内置基线（覆盖层只存差异，所以恢复不需要备份）
#[tauri::command]
pub fn delete_exercise_guide(state: State<AppState>, exercise_id: String) -> Result<()> {
    let conn = state.db.lock();
    conn.execute(
        "DELETE FROM exercise_guides WHERE exercise_id = ?1",
        [&exercise_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn.execute(
            "INSERT INTO exercises (id, name) VALUES ('barbell-bench-press', '杠铃卧推')",
            [],
        )
        .unwrap();
        conn
    }

    fn input() -> ExerciseGuideInput {
        ExerciseGuideInput {
            exercise_id: "barbell-bench-press".into(),
            setup: vec!["躺平".into(), "握距".into(), "收肩胛".into()],
            start: "沿斜线下落到下胸".into(),
            end: "推回肩上方".into(),
            cautions: vec!["要有人保护".into()],
            rep_sec: 4,
            updated_by: Some("ai".into()),
        }
    }

    #[test]
    fn setup_must_be_three() {
        let two = vec!["a".to_string(), "b".to_string()];
        assert!(setup_lines(&two).is_err());
        let three = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(setup_lines(&three).unwrap().len(), 3);
    }

    #[test]
    fn cautions_one_to_three() {
        assert!(caution_lines(&[]).is_err());
        let four = vec!["a".into(), "b".into(), "c".into(), "d".into()];
        assert!(caution_lines(&four).is_err());
    }

    #[test]
    fn long_line_rejected_not_truncated() {
        let s = "很".repeat(MAX_LINE + 1);
        assert!(line(&s, "start").is_err());
    }

    #[test]
    fn blank_line_rejected() {
        assert!(line("   ", "end").is_err());
    }

    /// 前端发的就是这套字段名（`services/exerciseLibService.ts`）：camelCase。
    /// 拼错一个键会是「静默空值」，所以这条断言比任何界面测试都值。
    #[test]
    fn input_deserializes_camel_case() {
        let j = r#"{"exerciseId":"x","setup":["a","b","c"],"start":"s","end":"e",
                    "cautions":["c"],"repSec":3,"updatedBy":"user"}"#;
        let parsed: ExerciseGuideInput = serde_json::from_str(j).unwrap();
        assert_eq!(parsed.exercise_id, "x");
        assert_eq!(parsed.rep_sec, 3);
        assert_eq!(parsed.updated_by.as_deref(), Some("user"));
        assert_eq!(parsed.setup.len(), 3);
    }

    /// 覆盖写语义：同一个动作写两次只有一行（否则界面会读到旧的或重复的）
    #[test]
    fn upsert_overwrites_single_row() {
        let conn = test_db();
        upsert_impl(&conn, input()).unwrap();
        let mut second = input();
        second.cautions = vec!["改过的注意".into(), "第二条".into()];
        second.updated_by = Some("user".into());
        let row = upsert_impl(&conn, second).unwrap();
        assert_eq!(row.cautions.len(), 2);
        assert_eq!(row.updated_by, "user");
        let all = list_impl(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].rep_sec, 4);
    }

    /// 自建动作真删时覆盖层跟着走（外键 ON DELETE CASCADE）：
    /// 不级联的话会留下指向空 id 的行，`list_exercise_guides` 永远返回一条幽灵。
    #[test]
    fn cascade_on_exercise_delete() {
        let conn = test_db();
        upsert_impl(&conn, input()).unwrap();
        conn.execute("DELETE FROM exercises WHERE id = 'barbell-bench-press'", [])
            .unwrap();
        assert!(list_impl(&conn).unwrap().is_empty());
    }

    #[test]
    fn unknown_exercise_rejected() {
        let conn = test_db();
        let mut bad = input();
        bad.exercise_id = "no-such-exercise".into();
        assert!(upsert_impl(&conn, bad).is_err());
    }
}
