//! 训练课会话命令 · 命令名与前端 `sessionService.ts` 对应。

use rusqlite::OptionalExtension;
use serde_json::Value;
use tauri::State;

use crate::error::Result;
use crate::modules::exercise::workout_by_id;
use crate::state::AppState;

use super::models::{
    FinishInput, SessionRecord, SessionSetRow, StrengthExerciseRef, StrengthLastWeight,
    StrengthSetRecord,
};

/// 一行原始数据（state_json 先取字符串，再解析）
type RawRow = (
    i64,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    f64,
    f64,
    String,
);

fn to_record(raw: RawRow) -> Result<SessionRecord> {
    let state = serde_json::from_str(&raw.10).unwrap_or(Value::Null);
    Ok(SessionRecord {
        id: raw.0,
        plan_id: raw.1,
        plan_name: raw.2,
        status: raw.3,
        started_at: raw.4,
        updated_at: raw.5,
        ex_index: raw.6,
        set_index: raw.7,
        weight_kg: raw.8,
        elapsed_sec: raw.9,
        state,
        sets: Vec::new(),
    })
}

fn read_by_id(conn: &rusqlite::Connection, id: i64) -> Result<SessionRecord> {
    let raw = conn.query_row(
        "SELECT id, plan_id, plan_name, status, started_at, updated_at, ex_index, \
         set_index, weight_kg, elapsed_sec, state_json FROM workout_sessions WHERE id = ?1",
        [id],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        },
    )?;
    to_record(raw)
}

/// 开始一场训练课。防御性规则：任何旧 active 会话先标记 aborted（前端正常流程不会出现并发生效会话）。
#[tauri::command]
pub fn session_start(
    state: State<AppState>,
    plan_id: String,
    plan_name: String,
    started_at: String,
    state_json: Value,
) -> Result<SessionRecord> {
    let conn = state.db.lock();
    session_start_on(&conn, plan_id, plan_name, started_at, state_json)
}

/// `session_start` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
pub(crate) fn session_start_on(
    conn: &rusqlite::Connection,
    plan_id: String,
    plan_name: String,
    started_at: String,
    state_json: Value,
) -> Result<SessionRecord> {
    conn.execute(
        "UPDATE workout_sessions SET status = 'aborted' WHERE status = 'active'",
        [],
    )?;
    conn.execute(
        "INSERT INTO workout_sessions (plan_id, plan_name, status, started_at, updated_at, \
         ex_index, set_index, weight_kg, state_json) \
         VALUES (?1, ?2, 'active', ?3, datetime('now'), 0, 1, 0, ?4)",
        rusqlite::params![plan_id, plan_name, started_at, state_json.to_string()],
    )?;
    read_by_id(conn, conn.last_insert_rowid())
}

/// 事件级快照：每个训练事件（做组/休息/计时/重量调整…）调用一次。
/// `elapsed_sec` 在服务端按两次快照的间隔自动累加，前端无需管理。
#[tauri::command]
pub fn session_snapshot(
    state: State<AppState>,
    id: i64,
    ex_index: i64,
    set_index: i64,
    weight_kg: f64,
    state_json: Value,
) -> Result<()> {
    let conn = state.db.lock();
    session_snapshot_on(&conn, id, ex_index, set_index, weight_kg, state_json)
}

/// `session_snapshot` 的本体（见 [`session_start_on`]）。
pub(crate) fn session_snapshot_on(
    conn: &rusqlite::Connection,
    id: i64,
    ex_index: i64,
    set_index: i64,
    weight_kg: f64,
    state_json: Value,
) -> Result<()> {
    conn.execute(
        "UPDATE workout_sessions SET \
           ex_index = ?2, set_index = ?3, weight_kg = ?4, state_json = ?5, \
           elapsed_sec = elapsed_sec + MAX(0.0, (julianday('now') - julianday(updated_at)) * 86400.0), \
           updated_at = datetime('now') \
         WHERE id = ?1 AND status = 'active'",
        rusqlite::params![id, ex_index, set_index, weight_kg, state_json.to_string()],
    )?;
    Ok(())
}

/// 当前是否有进行中（含异常中断）的训练
#[tauri::command]
pub fn session_active(state: State<AppState>) -> Result<Option<SessionRecord>> {
    let conn = state.db.lock();
    session_active_on(&conn)
}

/// `session_active` 的本体（见 [`session_start_on`]）。
pub(crate) fn session_active_on(conn: &rusqlite::Connection) -> Result<Option<SessionRecord>> {
    let res = conn.query_row(
        "SELECT id, plan_id, plan_name, status, started_at, updated_at, ex_index, \
         set_index, weight_kg, elapsed_sec, state_json \
         FROM workout_sessions WHERE status = 'active' ORDER BY id DESC LIMIT 1",
        [],
        |r| -> rusqlite::Result<RawRow> {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        },
    );
    match res {
        Ok(raw) => Ok(Some(to_record(raw)?)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 正常结束（保存）：同一事务内写入训练记录 + 逐组做组明细 + 关闭会话。
#[tauri::command]
pub fn session_finish(
    state: State<AppState>,
    input: FinishInput,
) -> Result<crate::modules::exercise::models::Workout> {
    let mut conn = state.db.lock();
    session_finish_on(&mut conn, input)
}

/// `session_finish` 的本体：内部用可变事务（`transaction()` 需要 `&mut Connection`，
/// contract §6.3）。命令体用 `let mut conn = state.db.lock();` 取锁后转调。
pub(crate) fn session_finish_on(
    conn: &mut rusqlite::Connection,
    input: FinishInput,
) -> Result<crate::modules::exercise::models::Workout> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, intensity, note, session_id, created_at) \
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
        rusqlite::params![
            input.name,
            input.workout_type,
            input.date,
            input.duration_min,
            input.kcal,
            input.intensity.clone().unwrap_or_else(|| "moderate".into()),
            input.note,
            input.id
        ],
    )?;
    let workout_id = tx.last_insert_rowid();
    {
        // 动作库 id 缺失时按名称兜底解析（旧客户端 / AI 提交）：逐组记录必须挂上库 id，
        // 否则这条记录不会进入该动作的重量曲线。
        let mut index = crate::modules::exercise_lib::resolve::NameIndex::load(&tx)?;
        let mut stmt = tx.prepare(
            "INSERT INTO workout_sets (workout_id, plan_id, exercise_key, exercise_name, exercise_id, set_no, kind, weight_kg, reps, sec, warmup, created_at) \
             VALUES (?1, (SELECT plan_id FROM workout_sessions WHERE id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))",
        )?;
        for s in &input.sets {
            let exercise_id = match s.exercise_id.as_deref().filter(|v| !v.is_empty()) {
                Some(id) => id.to_string(),
                None => {
                    let hint = crate::modules::exercise_lib::resolve::ExerciseHint {
                        kind: Some(s.kind.clone()),
                        reps: s.reps,
                        weight_kg: s.weight_kg,
                        ..Default::default()
                    };
                    crate::modules::exercise_lib::resolve::ensure_for_name(
                        &tx,
                        &mut index,
                        &s.exercise_name,
                        &hint,
                    )?
                }
            };
            stmt.execute(rusqlite::params![
                workout_id,
                input.id,
                s.exercise_key,
                s.exercise_name,
                exercise_id,
                s.set_no,
                s.kind,
                s.weight_kg,
                s.reps,
                s.sec,
                s.warmup,
            ])?;
        }
    }
    tx.execute(
        "UPDATE workout_sessions SET status = 'finished', updated_at = datetime('now') WHERE id = ?1",
        [input.id],
    )?;
    tx.commit()?;
    workout_by_id(conn, workout_id)
}

/// 正常结束（放弃）：只关闭会话，不写训练记录。
#[tauri::command]
pub fn session_abort(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock();
    session_abort_on(&conn, id)
}

/// `session_abort` 的本体（见 [`session_start_on`]）。
pub(crate) fn session_abort_on(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE workout_sessions SET status = 'aborted', updated_at = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// 一场训练已落库的逐组明细（按 `workout_sets.id` 升序 = 当时的登记顺序）。
fn sets_for_workout(conn: &rusqlite::Connection, workout_id: i64) -> Result<Vec<SessionSetRow>> {
    let mut stmt = conn.prepare(
        "SELECT exercise_key, exercise_name, exercise_id, kind, set_no, weight_kg, reps, sec, warmup \
         FROM workout_sets WHERE workout_id = ?1 ORDER BY id ASC",
    )?;
    let list = stmt
        .query_map([workout_id], |r| {
            Ok(SessionSetRow {
                exercise_key: r.get(0)?,
                exercise_name: r.get(1)?,
                exercise_id: r.get(2)?,
                kind: r.get(3)?,
                set_no: r.get(4)?,
                weight_kg: r.get(5)?,
                reps: r.get(6)?,
                sec: r.get(7)?,
                warmup: r.get::<_, i64>(8)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 按训练记录反查其来源会话（含最后一帧快照：轨迹 / 做组明细）。
/// 手动添加的记录没有来源会话，返回 None。
///
/// 同时把 `workout_sets` 的逐组明细一并返回：`state.doneSets` 的键是**课程条目 id**，
/// 课程被整体覆盖（AI 重写 / 手动增删）后键就失效，只有落库明细带着当时的动作名与
/// 动作库 id，是详情页唯一稳定的真源。见 `SessionSetRow` 的说明。
#[tauri::command]
pub fn session_for_workout(
    state: State<AppState>,
    workout_id: i64,
) -> Result<Option<SessionRecord>> {
    let conn = state.db.lock();
    let res = conn.query_row(
        "SELECT s.id, s.plan_id, s.plan_name, s.status, s.started_at, s.updated_at, \
         s.ex_index, s.set_index, s.weight_kg, s.elapsed_sec, s.state_json \
         FROM workout_sessions s JOIN workouts w ON w.session_id = s.id WHERE w.id = ?1",
        [workout_id],
        |r| -> rusqlite::Result<RawRow> {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        },
    );
    match res {
        Ok(raw) => {
            let mut rec = to_record(raw)?;
            rec.sets = sets_for_workout(&conn, workout_id)?;
            Ok(Some(rec))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/* ---------- 重量曲线（逐组记录查询，聚合键 = 动作库 id） ---------- */

/// 把「动作库 id 或动作名」解析成库 id。前端新调用一律传 id；
/// 动作名（AI 工具、旧调用）也能命中；库里都没有时原样返回（老库未回填的兜底）。
fn resolve_exercise_id(conn: &rusqlite::Connection, key: &str) -> Result<String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(crate::error::ReinError::Message("动作标识不能为空".into()));
    }
    let hit: Option<String> = conn
        .query_row("SELECT id FROM exercises WHERE id = ?1", [key], |r| r.get(0))
        .optional()?;
    if let Some(id) = hit {
        return Ok(id);
    }
    let index = crate::modules::exercise_lib::resolve::NameIndex::load(conn)?;
    Ok(index
        .get(key)
        .map(|s| s.to_string())
        .unwrap_or_else(|| key.to_string()))
}

/// 某动作的全部做组记录（按日期升序；含热身组，前端按需过滤/聚合）。
/// 入参可以传动作库 id 或动作名（旧调用兼容）。
#[tauri::command]
pub fn strength_history(
    state: State<AppState>,
    exercise_id: String,
) -> Result<Vec<StrengthSetRecord>> {
    let conn = state.db.lock();
    strength_history_on(&conn, &exercise_id)
}

/// `strength_history` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
pub(crate) fn strength_history_on(
    conn: &rusqlite::Connection,
    exercise_id: &str,
) -> Result<Vec<StrengthSetRecord>> {
    let id = resolve_exercise_id(conn, exercise_id)?;
    let raw = exercise_id.trim().to_string();
    let mut stmt = conn.prepare(
        "SELECT s.workout_id, w.date, s.exercise_key, s.exercise_id, s.exercise_name, s.kind, \
                s.set_no, s.weight_kg, s.reps, s.sec, s.warmup, \
                CAST(json_extract(ss.state_json, '$.readiness') AS INTEGER), \
                json_extract(ss.state_json, '$.postFeeling') \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         LEFT JOIN workout_sessions ss ON ss.id = w.session_id \
         WHERE s.exercise_id = ?1 OR (s.exercise_id IS NULL AND s.exercise_name = ?2) \
         ORDER BY w.date ASC, s.workout_id ASC, s.id ASC",
    )?;
    let list = stmt
        .query_map(rusqlite::params![id, raw], strength_set_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 [`strength_history_on`]（contract §6.4「禁止无界全表」）。
/// 顺序与无 LIMIT 版逐字一致，所以「取前 N 条」与网关侧 `cap_rows` 截断的结果相同 ——
/// 差别只在有没有把整表读出来。
pub(crate) fn strength_history_on_limited(
    conn: &rusqlite::Connection,
    exercise_id: &str,
    limit: i64,
) -> Result<Vec<StrengthSetRecord>> {
    let id = resolve_exercise_id(conn, exercise_id)?;
    let raw = exercise_id.trim().to_string();
    let mut stmt = conn.prepare(
        "SELECT s.workout_id, w.date, s.exercise_key, s.exercise_id, s.exercise_name, s.kind, \
                s.set_no, s.weight_kg, s.reps, s.sec, s.warmup, \
                CAST(json_extract(ss.state_json, '$.readiness') AS INTEGER), \
                json_extract(ss.state_json, '$.postFeeling') \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         LEFT JOIN workout_sessions ss ON ss.id = w.session_id \
         WHERE s.exercise_id = ?1 OR (s.exercise_id IS NULL AND s.exercise_name = ?2) \
         ORDER BY w.date ASC, s.workout_id ASC, s.id ASC LIMIT ?3",
    )?;
    let list = stmt
        .query_map(rusqlite::params![id, raw, limit], strength_set_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

fn strength_set_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StrengthSetRecord> {
    Ok(StrengthSetRecord {
        workout_id: r.get(0)?,
        date: r.get(1)?,
        exercise_key: r.get(2)?,
        exercise_id: r.get(3)?,
        exercise_name: r.get(4)?,
        kind: r.get(5)?,
        set_no: r.get(6)?,
        weight_kg: r.get(7)?,
        reps: r.get(8)?,
        sec: r.get(9)?,
        warmup: r.get::<_, i64>(10)? != 0,
        readiness: r.get(11)?,
        post_feeling: r.get(12)?,
    })
}

/// 有力量记录的动作清单（按最近一次训练的日期倒序）。
/// 聚合键是动作库 id；展示名优先取库内名（改名/跨课程合并都跟随）。
#[tauri::command]
pub fn strength_exercises(state: State<AppState>) -> Result<Vec<StrengthExerciseRef>> {
    let conn = state.db.lock();
    strength_exercises_on(&conn)
}

/// `strength_exercises` 的本体（见 [`strength_history_on`]）。
pub(crate) fn strength_exercises_on(
    conn: &rusqlite::Connection,
) -> Result<Vec<StrengthExerciseRef>> {
    // 自重动作只有次数、没有重量：`weight_kg IS NOT NULL` 会把引体/俯卧撑整条挡在
    // 「练过的动作」列表之外 —— 用户练了，App 说不认识这个动作。次数在场即为有效记录。
    let mut stmt = conn.prepare(
        "SELECT COALESCE(NULLIF(s.exercise_id, ''), ''), \
                COALESCE(e.name, MAX(s.exercise_name)) AS display_name, \
                MAX(w.date) AS last_date, COUNT(DISTINCT s.workout_id) AS sessions \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         LEFT JOIN exercises e ON e.id = s.exercise_id \
         WHERE s.warmup = 0 AND (s.weight_kg IS NOT NULL OR s.reps IS NOT NULL) \
         GROUP BY COALESCE(NULLIF(s.exercise_id, ''), s.exercise_name) \
         ORDER BY last_date DESC",
    )?;
    let list = stmt
        .query_map([], |r| {
            Ok(StrengthExerciseRef {
                exercise_id: r.get(0)?,
                name: r.get(1)?,
                last_date: r.get(2)?,
                sessions: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 [`strength_exercises_on`]（见 [`strength_history_on_limited`]）。
pub(crate) fn strength_exercises_on_limited(
    conn: &rusqlite::Connection,
    limit: i64,
) -> Result<Vec<StrengthExerciseRef>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(NULLIF(s.exercise_id, ''), ''), \
                COALESCE(e.name, MAX(s.exercise_name)) AS display_name, \
                MAX(w.date) AS last_date, COUNT(DISTINCT s.workout_id) AS sessions \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         LEFT JOIN exercises e ON e.id = s.exercise_id \
         WHERE s.warmup = 0 AND (s.weight_kg IS NOT NULL OR s.reps IS NOT NULL) \
         GROUP BY COALESCE(NULLIF(s.exercise_id, ''), s.exercise_name) \
         ORDER BY last_date DESC LIMIT ?1",
    )?;
    let list = stmt
        .query_map([limit], |r| {
            Ok(StrengthExerciseRef {
                exercise_id: r.get(0)?,
                name: r.get(1)?,
                last_date: r.get(2)?,
                sessions: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 一批动作各自的「最近一次做组重量」（取该动作最近一次训练里最后一组正式组）。
/// 沉浸页开始课程时批量预填「上次重量」；查不到的动作不出现在返回里。
/// 入参可以传动作库 id 或动作名。
#[tauri::command]
pub fn strength_last_weights(
    state: State<AppState>,
    exercise_ids: Vec<String>,
) -> Result<Vec<StrengthLastWeight>> {
    let conn = state.db.lock();
    strength_last_weights_on(&conn, &exercise_ids)
}

/// `strength_last_weights` 的本体（见 [`strength_history_on`]）。
pub(crate) fn strength_last_weights_on(
    conn: &rusqlite::Connection,
    exercise_ids: &[String],
) -> Result<Vec<StrengthLastWeight>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT s.weight_kg, s.reps, w.date, COALESCE(e.name, s.exercise_name) \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         LEFT JOIN exercises e ON e.id = s.exercise_id \
         WHERE s.warmup = 0 AND s.weight_kg IS NOT NULL \
           AND (s.exercise_id = ?1 OR (s.exercise_id IS NULL AND s.exercise_name = ?2)) \
         ORDER BY w.date DESC, s.workout_id DESC, s.id DESC LIMIT 1",
    )?;
    for key in exercise_ids {
        let id = resolve_exercise_id(conn, key)?;
        let raw = key.trim().to_string();
        let res = stmt.query_row(rusqlite::params![id, raw], |r| {
            Ok(StrengthLastWeight {
                exercise_id: id.clone(),
                name: r.get(3)?,
                weight_kg: r.get(0)?,
                reps: r.get(1)?,
                date: r.get(2)?,
            })
        });
        if let Ok(row) = res {
            out.push(row);
        }
    }
    Ok(out)
}

/// 近 N 天的全部做组记录（含热身标记）——训练建议引擎的一次性原料。
/// 逐动作查询会让一堂课发出 N 条命令，这里一次取回由前端纯函数引擎计算。
#[tauri::command]
pub fn strength_recent_sets(
    state: State<AppState>,
    days: Option<i64>,
) -> Result<Vec<StrengthSetRecord>> {
    let conn = state.db.lock();
    strength_recent_sets_on(&conn, days)
}

/// `strength_recent_sets` 的本体（见 [`strength_history_on`]）。
pub(crate) fn strength_recent_sets_on(
    conn: &rusqlite::Connection,
    days: Option<i64>,
) -> Result<Vec<StrengthSetRecord>> {
    let days = days.unwrap_or(42).clamp(1, 365);
    let mut stmt = conn.prepare(
        "SELECT s.workout_id, w.date, s.exercise_key, s.exercise_id, s.exercise_name, s.kind, \
                s.set_no, s.weight_kg, s.reps, s.sec, s.warmup, \
                CAST(json_extract(ss.state_json, '$.readiness') AS INTEGER), \
                json_extract(ss.state_json, '$.postFeeling') \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         LEFT JOIN workout_sessions ss ON ss.id = w.session_id \
         WHERE w.date >= date('now', 'localtime', '-' || ?1 || ' days') \
         ORDER BY w.date ASC, s.workout_id ASC, s.id ASC",
    )?;
    let list = stmt
        .query_map([days], strength_set_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 [`strength_recent_sets_on`]（见 [`strength_history_on_limited`]）。
pub(crate) fn strength_recent_sets_on_limited(
    conn: &rusqlite::Connection,
    days: Option<i64>,
    limit: i64,
) -> Result<Vec<StrengthSetRecord>> {
    let days = days.unwrap_or(42).clamp(1, 365);
    let mut stmt = conn.prepare(
        "SELECT s.workout_id, w.date, s.exercise_key, s.exercise_id, s.exercise_name, s.kind, \
                s.set_no, s.weight_kg, s.reps, s.sec, s.warmup, \
                CAST(json_extract(ss.state_json, '$.readiness') AS INTEGER), \
                json_extract(ss.state_json, '$.postFeeling') \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         LEFT JOIN workout_sessions ss ON ss.id = w.session_id \
         WHERE w.date >= date('now', 'localtime', '-' || ?1 || ' days') \
         ORDER BY w.date ASC, s.workout_id ASC, s.id ASC LIMIT ?2",
    )?;
    let list = stmt
        .query_map(rusqlite::params![days, limit], strength_set_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::session::models::{FinishInput, FinishSet};
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    /// `session_start_on`：新开一场 active；旧的 active 自动标 aborted（行为与原命令一致）。
    #[test]
    fn session_start_on_aborts_previous_and_returns_active_row() {
        let conn = fresh();
        let a = session_start_on(
            &conn,
            "p1".into(),
            "胸推日".into(),
            "2026-01-01T09:00:00Z".into(),
            Value::Null,
        )
        .unwrap();
        assert_eq!(a.status, "active");
        assert_eq!(a.plan_name, "胸推日");

        let b = session_start_on(
            &conn,
            "p2".into(),
            "腿日".into(),
            "2026-01-01T10:00:00Z".into(),
            Value::Null,
        )
        .unwrap();
        assert!(b.id > a.id);
        let a_status: String = conn
            .query_row("SELECT status FROM workout_sessions WHERE id = ?1", [a.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(a_status, "aborted", "旧 active 会话被防御性中止");
        assert_eq!(session_active_on(&conn).unwrap().unwrap().id, b.id);
    }

    /// `session_snapshot_on`：把事件级快照写进行内（相位 / 索引 / 重量）。
    #[test]
    fn session_snapshot_on_updates_the_active_row() {
        let conn = fresh();
        let s = session_start_on(
            &conn,
            "p1".into(),
            "胸推日".into(),
            "2026-01-01T09:00:00Z".into(),
            Value::Null,
        )
        .unwrap();
        session_snapshot_on(
            &conn,
            s.id,
            1,
            3,
            40.0,
            serde_json::json!({ "phase": "exercise" }),
        )
        .unwrap();
        let rec = session_active_on(&conn).unwrap().unwrap();
        assert_eq!(rec.ex_index, 1);
        assert_eq!(rec.set_index, 3);
        assert_eq!(rec.weight_kg, 40.0);
        assert_eq!(rec.state["phase"], "exercise");
    }

    /// `session_abort_on`：只关会话，不写训练记录（放弃）。
    #[test]
    fn session_abort_on_closes_without_writing_a_workout() {
        let conn = fresh();
        let s = session_start_on(
            &conn,
            "p1".into(),
            "胸推日".into(),
            "2026-01-01T09:00:00Z".into(),
            Value::Null,
        )
        .unwrap();
        session_abort_on(&conn, s.id).unwrap();
        assert!(session_active_on(&conn).unwrap().is_none(), "abort 后无活跃会话");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workouts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "放弃不写训练记录");
    }

    /// `session_finish_on`：同一事务写训练记录 + 逐组明细 + 关会话（可变事务本体）。
    #[test]
    fn session_finish_on_writes_workout_and_closes_the_session() {
        let mut conn = fresh();
        let s = session_start_on(
            &conn,
            "p1".into(),
            "胸推日".into(),
            "2026-01-01T09:00:00Z".into(),
            Value::Null,
        )
        .unwrap();
        let workout = session_finish_on(
            &mut conn,
            FinishInput {
                id: s.id,
                name: "胸推日".into(),
                workout_type: "strength".into(),
                date: "2026-01-01".into(),
                duration_min: 42.0,
                intensity: None,
                kcal: 300.0,
                note: None,
                sets: vec![FinishSet {
                    exercise_key: "bench".into(),
                    exercise_name: "卧推".into(),
                    exercise_id: None,
                    kind: "strength".into(),
                    set_no: 1,
                    weight_kg: Some(40.0),
                    reps: Some(8),
                    sec: None,
                    warmup: false,
                }],
            },
        )
        .unwrap();
        assert_eq!(workout.name, "胸推日");
        let status: String = conn
            .query_row(
                "SELECT status FROM workout_sessions WHERE id = ?1",
                [s.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "finished");
        let sets: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workout_sets WHERE workout_id = ?1",
                [workout.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sets, 1, "逐组明细落库");
        assert!(session_active_on(&conn).unwrap().is_none(), "结束后无活跃会话");
    }

    /// 网关专用的三个 LIMIT 变体：`LIMIT` 必须落在 **SQL 侧**（contract §6.4「禁止无界全表」），
    /// 且占位符个数/位置要对得上（写错会当场炸「参数个数不符」）。
    #[test]
    fn strength_limited_variants_cap_rows_in_sql() {
        let conn = fresh();
        // 两堂课 × 3 组，同一个动作：无 LIMIT 版给 6 行，限行版按 limit 裁
        for wid in 1..=2i64 {
            conn.execute(
                "INSERT INTO workouts (id, name, type, date, duration_min, kcal, created_at) \
                 VALUES (?1, '胸推日', 'strength', date('now', 'localtime', '-' || ?1 || ' days'), 60, 300, '2026-01-01T00:00:00Z')",
                [wid],
            )
            .unwrap();
            for set_no in 1..=3i64 {
                conn.execute(
                    "INSERT INTO workout_sets (workout_id, exercise_key, exercise_id, exercise_name, \
                     set_no, kind, weight_kg, reps, warmup, created_at) \
                     VALUES (?1, 'bench', 'ex-bench', '卧推', ?2, 'strength', 60, 8, 0, '2026-01-01T00:00:00Z')",
                    rusqlite::params![wid, set_no],
                )
                .unwrap();
            }
        }

        assert_eq!(strength_history_on(&conn, "ex-bench").unwrap().len(), 6);
        assert_eq!(strength_history_on_limited(&conn, "ex-bench", 2).unwrap().len(), 2);
        assert_eq!(strength_recent_sets_on(&conn, Some(7)).unwrap().len(), 6);
        assert_eq!(strength_recent_sets_on_limited(&conn, Some(7), 4).unwrap().len(), 4);
        assert_eq!(strength_exercises_on(&conn).unwrap().len(), 1, "只有一个动作");
        assert_eq!(strength_exercises_on_limited(&conn, 0).unwrap().len(), 0);
    }
}
