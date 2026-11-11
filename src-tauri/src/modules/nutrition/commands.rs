//! 营养域命令 · 命令名与前端 `nutritionService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;

use super::models::{
    BodyMetric, BodyMetricInput, CalcState, DailySummary, DailyTargets, NutrientIntake, Profile,
};
use super::{ensure_found, load_profile, profile_targets};

#[tauri::command]
pub fn get_daily_summary(state: State<AppState>, date: String) -> Result<DailySummary> {
    let conn = state.db.lock();
    daily_summary_on(&conn, &date)
}

/// 汇总本体：收 `&Connection` 而不是 `State`，测试才能在内存库上直接跑。
fn daily_summary_on(conn: &rusqlite::Connection, date: &str) -> Result<DailySummary> {
    let targets = profile_targets(conn)?;

    // 当日摄入：记录 × 每100g 值聚合（单日数据量小，Rust 侧累加足够）
    const NUTRIENT_COLS: &str = "f.kcal, f.protein, f.carb, f.fat, f.fiber, f.sugar, \
         f.sodium_mg, f.potassium_mg, f.calcium_mg, f.iron_mg, f.zinc_mg, f.magnesium_mg, \
         f.vit_a_ug, f.vit_c_mg, f.vit_d_ug, f.vit_e_mg, f.vit_b12_ug, f.folate_ug";
    let sql = format!(
        "SELECT {NUTRIENT_COLS}, ml.grams FROM meal_logs ml JOIN foods f ON f.id = ml.food_id \
         WHERE ml.date = ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut intake = NutrientIntake::default();
    let rows = stmt.query_map([date], |r| {
        Ok((
            r.get::<_, f64>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, f64>(2)?,
            r.get::<_, f64>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, f64>(5)?,
            r.get::<_, f64>(6)?,
            r.get::<_, f64>(7)?,
            r.get::<_, f64>(8)?,
            r.get::<_, f64>(9)?,
            r.get::<_, f64>(10)?,
            r.get::<_, f64>(11)?,
            r.get::<_, f64>(12)?,
            r.get::<_, f64>(13)?,
            r.get::<_, f64>(14)?,
            r.get::<_, f64>(15)?,
            r.get::<_, f64>(16)?,
            r.get::<_, f64>(17)?,
            r.get::<_, f64>(18)?,
        ))
    })?;
    for row in rows {
        let (
            kcal,
            protein,
            carb,
            fat,
            fiber,
            sugar,
            na,
            k,
            ca,
            fe,
            zn,
            mg,
            va,
            vc,
            vd,
            ve,
            b12,
            folate,
            grams,
        ) = row?;
        let x = grams / 100.0;
        intake.kcal += kcal * x;
        intake.protein += protein * x;
        intake.carb += carb * x;
        intake.fat += fat * x;
        intake.fiber += fiber * x;
        intake.sugar += sugar * x;
        intake.sodium_mg += na * x;
        intake.potassium_mg += k * x;
        intake.calcium_mg += ca * x;
        intake.iron_mg += fe * x;
        intake.zinc_mg += zn * x;
        intake.magnesium_mg += mg * x;
        intake.vit_a_ug += va * x;
        intake.vit_c_mg += vc * x;
        intake.vit_d_ug += vd * x;
        intake.vit_e_mg += ve * x;
        intake.vit_b12_ug += b12 * x;
        intake.folate_ug += folate * x;
    }

    let exercise_kcal: f64 = conn.query_row(
        "SELECT COALESCE(SUM(kcal), 0) FROM workouts WHERE date = ?1",
        [date],
        |r| r.get(0),
    )?;

    Ok(DailySummary {
        date: date.to_string(),
        intake,
        targets,
        exercise_kcal,
    })
}

/// `date` 参数为「按天覆盖目标」预留；当前一律返回资料默认目标。
#[tauri::command]
pub fn get_targets(state: State<AppState>, date: Option<String>) -> Result<DailyTargets> {
    let _ = date;
    let conn = state.db.lock();
    profile_targets(&conn)
}

/// `date` 为 null 时写入资料默认目标；按天覆盖为后续扩展预留。
#[tauri::command]
pub fn set_targets(
    state: State<AppState>,
    targets: DailyTargets,
    date: Option<String>,
) -> Result<()> {
    let _ = date;
    let conn = state.db.lock();
    conn.execute(
        "UPDATE profile SET target_kcal = ?1, target_protein = ?2, target_carb = ?3, \
         target_fat = ?4, target_sodium_mg = ?5, target_water_ml = ?6 WHERE id = 1",
        rusqlite::params![
            targets.kcal,
            targets.protein,
            targets.carb,
            targets.fat,
            targets.sodium_mg,
            targets.water_ml
        ],
    )?;
    Ok(())
}

/// `async`：这是「关于你」首屏的四路之一，和其他读命令一样不该占主线程。
#[tauri::command(async)]
pub fn get_profile(state: State<AppState>) -> Result<Profile> {
    let conn = state.db.lock();
    ensure_found(load_profile(&conn))
}

#[tauri::command]
pub fn update_profile(state: State<AppState>, profile: Profile) -> Result<Profile> {
    let conn = state.db.lock();
    // JSON 数组字段以文本列存储（NULL 保持 NULL，不写 "null"）
    let slots = profile
        .preferred_time_slots
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".into()));
    let restrictions = profile
        .diet_restrictions
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".into()));
    conn.execute(
        "UPDATE profile SET nickname = ?1, sex = ?2, birthday = ?3, height_cm = ?4, \
         weight_kg = ?5, target_weight_kg = ?6, activity_level = ?7, goal = ?8, \
         target_kcal = ?9, target_protein = ?10, target_carb = ?11, target_fat = ?12, \
         target_sodium_mg = ?13, target_water_ml = ?14, training_days_per_week = ?15, \
         preferred_time_slots = ?16, equipment = ?17, diet_restrictions = ?18, experience = ?19 \
         WHERE id = 1",
        rusqlite::params![
            profile.nickname,
            profile.sex,
            profile.birthday,
            profile.height_cm,
            profile.weight_kg,
            profile.target_weight_kg,
            profile.activity_level,
            profile.goal,
            profile.targets.kcal,
            profile.targets.protein,
            profile.targets.carb,
            profile.targets.fat,
            profile.targets.sodium_mg,
            profile.targets.water_ml,
            profile.training_days_per_week,
            slots,
            profile.equipment,
            restrictions,
            profile.experience,
        ],
    )?;
    ensure_found(load_profile(&conn))
}

/// 方案计算器参数快照：从未保存过时返回 None，前端回落到资料推导。
#[tauri::command]
pub fn get_calc_state(state: State<AppState>) -> Result<Option<CalcState>> {
    let conn = state.db.lock();
    let res = conn.query_row(
        "SELECT sex, age, height_cm, weight_kg, activity_level, goal, saved_at \
         FROM calc_params WHERE id = 1",
        [],
        |r| {
            Ok(CalcState {
                sex: r.get(0)?,
                age: r.get(1)?,
                height_cm: r.get(2)?,
                weight_kg: r.get(3)?,
                activity_level: r.get(4)?,
                goal: r.get(5)?,
                saved_at: r.get(6)?,
            })
        },
    );
    match res {
        Ok(s) if s.saved_at.is_some() => Ok(Some(s)),
        Ok(_) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn save_calc_state(state: State<AppState>, mut s: CalcState) -> Result<CalcState> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE calc_params SET sex = ?1, age = ?2, height_cm = ?3, weight_kg = ?4, \
         activity_level = ?5, goal = ?6, saved_at = datetime('now') WHERE id = 1",
        rusqlite::params![
            s.sex,
            s.age,
            s.height_cm,
            s.weight_kg,
            s.activity_level,
            s.goal
        ],
    )?;
    s.saved_at = Some(chrono::Utc::now().to_rfc3339());
    Ok(s)
}

/// 追踪记录列表：按日期倒序，最多 `limit` 条。
#[tauri::command]
pub fn list_body_metrics(state: State<AppState>, limit: Option<i64>) -> Result<Vec<BodyMetric>> {
    let conn = state.db.lock();
    let limit = limit.unwrap_or(180).clamp(1, 365);
    let mut stmt = conn.prepare(
        "SELECT id, date, weight_kg, height_cm, created_at FROM body_metrics \
         ORDER BY date DESC LIMIT ?1",
    )?;
    let list = stmt
        .query_map([limit], |r| {
            Ok(BodyMetric {
                id: r.get(0)?,
                date: r.get(1)?,
                weight_kg: r.get(2)?,
                height_cm: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(list)
}

/// 记一笔体重 / 身高：按天 upsert，同日补录只覆盖提供的项；
/// 同时把非空值同步进身体资料，保证计算器与「我」页展示同源。
#[tauri::command]
pub fn record_body_metric(state: State<AppState>, metric: BodyMetricInput) -> Result<BodyMetric> {
    if metric.weight_kg.is_none() && metric.height_cm.is_none() {
        return Err(crate::error::ReinError::Message(
            "体重与身高至少填写一项".into(),
        ));
    }
    let conn = state.db.lock();
    let m = conn.query_row(
        "INSERT INTO body_metrics (date, weight_kg, height_cm, created_at, updated_at) \
             VALUES (?1, ?2, ?3, datetime('now'), datetime('now')) \
             ON CONFLICT(date) DO UPDATE SET \
               weight_kg = COALESCE(excluded.weight_kg, weight_kg), \
               height_cm = COALESCE(excluded.height_cm, height_cm), \
               updated_at = datetime('now') \
             RETURNING id, date, weight_kg, height_cm, created_at",
        rusqlite::params![metric.date, metric.weight_kg, metric.height_cm],
        |r| {
            Ok(BodyMetric {
                id: r.get(0)?,
                date: r.get(1)?,
                weight_kg: r.get(2)?,
                height_cm: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )?;
    conn.execute(
        "UPDATE profile SET weight_kg = COALESCE(?1, weight_kg), \
         height_cm = COALESCE(?2, height_cm) WHERE id = 1",
        rusqlite::params![metric.weight_kg, metric.height_cm],
    )?;
    Ok(m)
}

#[tauri::command]
pub fn delete_body_metric(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM body_metrics WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn daily_summary_scales_by_grams_and_filters_by_day() {
        let conn = fresh();
        conn.execute(
            "INSERT INTO foods (name, kcal, protein, carb, fat, created_at) \
             VALUES ('燕麦', 380, 12, 66, 7, '2026-09-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let fid = conn.last_insert_rowid();

        // 同一天两笔（50g + 30g）+ 前一天一笔 100g（不该计入）
        for (date, grams) in [("2026-09-23", 50.0), ("2026-09-23", 30.0), ("2026-09-22", 100.0)] {
            conn.execute(
                "INSERT INTO meal_logs (food_id, date, meal_type, quantity_mode, grams, source, created_at) \
                 VALUES (?1, ?2, 'breakfast', 'grams', ?3, 'manual', '2026-09-23T08:00:00Z')",
                rusqlite::params![fid, date, grams],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO workouts (name, type, date, duration_min, kcal, created_at) \
             VALUES ('晨跑', 'run', '2026-09-23', 30, 240, '2026-09-23T09:00:00Z')",
            [],
        )
        .unwrap();

        let s = daily_summary_on(&conn, "2026-09-23").unwrap();
        // 80g 燕麦：380/100 × 80 = 304 kcal；蛋白 12 × 0.8 = 9.6g
        assert!((s.intake.kcal - 304.0).abs() < 0.01, "kcal={}", s.intake.kcal);
        assert!(
            (s.intake.protein - 9.6).abs() < 0.01,
            "protein={}",
            s.intake.protein
        );
        assert!((s.exercise_kcal - 240.0).abs() < 0.01);
        assert_eq!(s.date, "2026-09-23");

        // 没有任何记录的一天：全 0，而不是报错
        let empty = daily_summary_on(&conn, "2026-09-01").unwrap();
        assert_eq!(empty.intake.kcal, 0.0);
        assert_eq!(empty.exercise_kcal, 0.0);
    }
}
