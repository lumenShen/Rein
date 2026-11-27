//! 运动域命令 · 命令名与前端 `exerciseService.ts` 对应。

use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;
use chrono::{Local, NaiveDate, Utc};

use super::models::{Workout, WorkoutUpdateInput};
use super::{workout_by_id, workout_from_row, WORKOUT_COLS};

#[tauri::command]
pub fn list_workouts(
    state: State<AppState>,
    start_date: String,
    end_date: String,
) -> Result<Vec<Workout>> {
    let conn = state.db.lock();
    list_workouts_on(&conn, &start_date, &end_date)
}

/// `list_workouts` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
pub(crate) fn list_workouts_on(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<Workout>> {
    let sql = format!(
        "SELECT {WORKOUT_COLS} FROM workouts WHERE date BETWEEN ?1 AND ?2 \
         ORDER BY date DESC, (start_min IS NULL), start_min"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([start_date, end_date], workout_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 `list_workouts`（contract §6.4「禁止无界全表」）。
pub(crate) fn list_workouts_on_limited(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
    limit: i64,
) -> Result<Vec<Workout>> {
    let sql = format!(
        "SELECT {WORKOUT_COLS} FROM workouts WHERE date BETWEEN ?1 AND ?2 \
         ORDER BY date DESC, (start_min IS NULL), start_min LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map((start_date, end_date, limit), workout_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 全量记录（全部运动记录页）：不分日期范围，日期倒序。
#[tauri::command]
pub fn list_all_workouts(state: State<AppState>) -> Result<Vec<Workout>> {
    let conn = state.db.lock();
    let sql = format!(
        "SELECT {WORKOUT_COLS} FROM workouts \
         ORDER BY date DESC, (start_min IS NULL), start_min"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([], workout_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 新增一条运动记录（手动补录）。
///
/// `effort` 是体感强度 1–5（手动补录专用）；课程/跑步走 `session_finish`，不经过这里。
/// `intensity` 在表上是 NOT NULL，由调用方从 effort 派生后传入（见 db.rs MIGRATION_0035）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_workout(
    state: State<AppState>,
    name: String,
    // 注意：IPC 参数用 workoutType 而非 type（避免原始标识符 r#type 的参数名转换问题）
    workout_type: String,
    date: String,
    start_min: Option<i64>,
    duration_min: f64,
    intensity: Option<String>,
    effort: Option<i64>,
    kcal: f64,
    note: Option<String>,
) -> Result<Workout> {
    let conn = state.db.lock();
    create_workout_on(
        &conn,
        name,
        workout_type,
        date,
        start_min,
        duration_min,
        intensity,
        effort,
        kcal,
        note,
    )
}

/// `create_workout` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_workout_on(
    conn: &rusqlite::Connection,
    name: String,
    workout_type: String,
    date: String,
    start_min: Option<i64>,
    duration_min: f64,
    intensity: Option<String>,
    effort: Option<i64>,
    kcal: f64,
    note: Option<String>,
) -> Result<Workout> {
    conn.execute(
        "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, intensity, effort, note, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            name,
            workout_type,
            date,
            start_min,
            duration_min,
            kcal,
            intensity.unwrap_or_else(|| "moderate".into()),
            effort,
            note,
            Utc::now().to_rfc3339()
        ],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {WORKOUT_COLS} FROM workouts WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], workout_from_row)?)
}

#[tauri::command]
pub fn update_workout(state: State<AppState>, id: i64, input: WorkoutUpdateInput) -> Result<Workout> {
    let conn = state.db.lock();
    update_workout_on(&conn, id, &input)
}

fn update_workout_on(
    conn: &rusqlite::Connection,
    id: i64,
    input: &WorkoutUpdateInput,
) -> Result<Workout> {
    use rusqlite::OptionalExtension;

    let existing: Option<(String, Option<i64>, String)> = conn
        .query_row(
            "SELECT source, session_id, type FROM workouts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((source, session_id, current_type)) = existing else {
        return Err(ReinError::Message("运动记录不存在".into()));
    };
    if source != "local" {
        return Err(ReinError::coded("read_only", "手机同步记录以 Health Connect 为准"));
    }
    if session_id.is_some()
        && (input.workout_type != current_type || input.intensity.is_some() || input.effort.is_some())
    {
        return Err(ReinError::coded(
            "read_only",
            "课程与跑步的类型和强度来自过程记录",
        ));
    }
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ReinError::Message("名称应为 1–80 个字".into()));
    }
    let parsed_date = NaiveDate::parse_from_str(&input.date, "%Y-%m-%d")
        .map_err(|_| ReinError::Message("日期应为 YYYY-MM-DD".into()))?;
    if parsed_date > Local::now().date_naive() {
        return Err(ReinError::Message("运动记录不能记在未来".into()));
    }
    if input.workout_type.trim().is_empty() || input.workout_type.chars().count() > 40 {
        return Err(ReinError::Message("运动类型无效".into()));
    }
    if input.start_min.is_some_and(|v| !(0..1440).contains(&v)) {
        return Err(ReinError::Message("开始时刻无效".into()));
    }
    if !input.duration_min.is_finite() || input.duration_min <= 0.0 || input.duration_min > 1440.0 {
        return Err(ReinError::Message("时长应在 0–1440 分钟之间".into()));
    }
    if !input.kcal.is_finite() || input.kcal < 0.0 || input.kcal > 10000.0 {
        return Err(ReinError::Message("消耗应在 0–10000 大卡之间".into()));
    }
    if input.intensity.as_deref().is_some_and(|v| !["low", "moderate", "high"].contains(&v)) {
        return Err(ReinError::Message("强度档位无效".into()));
    }
    if input.effort.is_some_and(|v| !(1..=5).contains(&v)) {
        return Err(ReinError::Message("体感应为 1–5".into()));
    }
    if input.note.as_deref().is_some_and(|v| v.chars().count() > 500) {
        return Err(ReinError::Message("备注不能超过 500 个字".into()));
    }
    conn.execute(
        "UPDATE workouts SET name = ?1, type = ?2, date = ?3, start_min = ?4, duration_min = ?5, \
         kcal = ?6, intensity = COALESCE(?7, intensity), effort = ?8, note = ?9 WHERE id = ?10",
        rusqlite::params![
            name,
            input.workout_type,
            input.date,
            input.start_min,
            input.duration_min,
            input.kcal,
            input.intensity,
            input.effort,
            input.note,
            id,
        ],
    )?;
    workout_by_id(conn, id)
}

/// 删除一条运动记录。
///
/// 从迁移 0036 起，`workouts` 里可能混着两种记录，删除的语义不同（见
/// `modules/healthsync` 的模块说明）：
/// - 本地记录（`source = 'local'`）：本机说了算。若它已经导出到 Health Connect，
///   顺手把 HC 侧那份也收掉 —— 否则用户的「删除」在两个地方不一致。
/// - 导入记录（`source = 'health_connect'`）：HC 是权威，本机删**不动 HC 侧**
///   （那可能是别家 App 写进去的数据），只记一条墓碑，免得下次同步又拉回来。
#[tauri::command]
pub fn delete_workout(
    app: tauri::AppHandle,
    state: State<AppState>,
    id: i64,
) -> Result<()> {
    use crate::modules::healthsync::commands as health;

    let conn = state.db.lock();
    let propagate = delete_workout_on(&conn, id)?;
    if let Some(external_id) = propagate {
        drop(conn);
        // JNI 必须在锁外发（dispatch 会切到 WebView 主线程）；传 AppHandle，
        // 与网关照到的删除共用同一条传播路径（contract §13.3）。
        health::propagate_delete(&app, &external_id);
    }
    Ok(())
}

/// `delete_workout` 的本体：删行 + 按 `source` 决定 HC 语义，返回**需要传播删除**的
/// `external_id`（`Some` = 本地记录且已导出、且回写开关开）。
///
/// 收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用（contract §6.1 单连接铁律）。
/// **传播在锁外由调用方触发**：网关侧无 `Webview`，只能拿到这个返回值（contract §13.3）。
pub(crate) fn delete_workout_on(
    conn: &rusqlite::Connection,
    id: i64,
) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;

    use crate::modules::healthsync::commands as health;

    let link: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT source, external_id FROM workouts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    conn.execute("DELETE FROM workouts WHERE id = ?1", [id])?;

    if let Some((source, Some(external_id))) = link {
        if source == "health_connect" {
            health::add_tombstone(conn, &external_id)?;
        } else if health::is_push_enabled(conn) {
            // 本地记录 + 回写开：把 externalId 交回调用方，由它在锁外传播删除
            return Ok(Some(external_id));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn update_workout_preserves_source_and_rejects_imported_records() {
        let conn = fresh();
        let created = create_workout_on(
            &conn,
            "晨跑".into(),
            "run".into(),
            "2026-11-25".into(),
            Some(7 * 60),
            30.0,
            Some("moderate".into()),
            None,
            300.0,
            Some("原备注".into()),
        )
        .unwrap();
        let updated = update_workout_on(
            &conn,
            created.id,
            &WorkoutUpdateInput {
                name: "晨跑（修正）".into(),
                workout_type: "run".into(),
                date: "2026-11-26".into(),
                start_min: Some(7 * 60 + 30),
                duration_min: 42.5,
                intensity: None,
                effort: None,
                kcal: 420.0,
                note: Some("手表实测".into()),
            },
        )
        .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "晨跑（修正）");
        assert_eq!(updated.date, "2026-11-26");
        assert_eq!(updated.duration_min, 42.5);
        assert_eq!(updated.kcal, 420.0);
        assert_eq!(updated.intensity, "moderate");
        assert_eq!(updated.source, "local");
        assert_eq!(updated.created_at, created.created_at);

        conn.execute("UPDATE workouts SET source = 'health_connect' WHERE id = ?1", [created.id]).unwrap();
        assert!(update_workout_on(
            &conn,
            created.id,
            &WorkoutUpdateInput {
                name: "不允许修改".into(),
                workout_type: "run".into(),
                date: "2026-11-26".into(),
                start_min: None,
                duration_min: 30.0,
                intensity: None,
                effort: None,
                kcal: 300.0,
                note: None,
            },
        )
        .is_err());
    }

    #[test]
    fn session_workout_rejects_type_and_intensity_changes() {
        let conn = fresh();
        let created = create_workout_on(
            &conn,
            "力量训练".into(),
            "strength".into(),
            "2026-11-26".into(),
            None,
            45.0,
            Some("high".into()),
            None,
            360.0,
            None,
        )
        .unwrap();
        let session = crate::modules::session::commands::session_start_on(
            &conn,
            "plan-1".into(),
            "力量训练".into(),
            "2026-11-26T09:00:00Z".into(),
            serde_json::Value::Null,
        )
        .unwrap();
        conn.execute(
            "UPDATE workouts SET session_id = ?1 WHERE id = ?2",
            rusqlite::params![session.id, created.id],
        )
        .unwrap();

        let blocked = update_workout_on(
            &conn,
            created.id,
            &WorkoutUpdateInput {
                name: "力量训练".into(),
                workout_type: "run".into(),
                date: "2026-11-26".into(),
                start_min: None,
                duration_min: 45.0,
                intensity: Some("low".into()),
                effort: Some(2),
                kcal: 360.0,
                note: None,
            },
        );
        assert!(blocked.is_err());

        let updated = update_workout_on(
            &conn,
            created.id,
            &WorkoutUpdateInput {
                name: "力量训练（修正）".into(),
                workout_type: "strength".into(),
                date: "2026-11-26".into(),
                start_min: Some(9 * 60),
                duration_min: 50.0,
                intensity: None,
                effort: None,
                kcal: 400.0,
                note: Some("手表实测".into()),
            },
        )
        .unwrap();
        assert_eq!(updated.r#type, "strength");
        assert_eq!(updated.intensity, "high");
        assert_eq!(updated.effort, None);
        assert_eq!(updated.duration_min, 50.0);
    }

    /// 对外网关专用的 LIMIT 变体：SQL 侧限行（contract §6.4）。
    #[test]
    fn list_workouts_on_limited_caps_rows_in_sql() {
        let conn = fresh();
        for i in 0..5 {
            create_workout_on(
                &conn,
                format!("w{i}"),
                "run".into(),
                "2026-09-23".into(),
                None,
                30.0,
                None,
                None,
                100.0,
                None,
            )
            .unwrap();
        }
        assert_eq!(
            list_workouts_on(&conn, "2026-09-01", "2026-09-30").unwrap().len(),
            5
        );
        assert_eq!(
            list_workouts_on_limited(&conn, "2026-09-01", "2026-09-30", 2)
                .unwrap()
                .len(),
            2,
            "LIMIT 生效"
        );
    }
}
