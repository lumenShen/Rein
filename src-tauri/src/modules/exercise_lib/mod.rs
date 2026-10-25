//! 动作库域（迁移 0025）：全部运动动作的唯一真源。
//!
//! - **内置动作**（`is_custom=0`）来自种子 `resources/exercises.json`，只读：
//!   每次启动由 `seed::seed_exercises` 覆盖式刷新内容，用户只能隐藏。
//! - **自建动作**（`is_custom=1`）可改可删。
//! - 课程条目以 `exerciseId` 引用本表；重量曲线以 `workout_sets.exercise_id` 聚合。
//!   名称 → id 的解析与存量数据回填见 `resolve.rs`。
//! - 动作详解（准备 / 轨迹 / 注意 / 节拍）的基线在 `config/exerciseGuide.ts`，
//!   改动落 `exercise_guides` 覆盖表（迁移 0048，见 `guide.rs`）—— 与内置动作的内容列
//!   分开，所以对「内置只读」没有破例：文案被改的是覆盖层，种子的覆盖式刷新不会碰它。

pub mod commands;
pub mod guide;
pub mod models;
pub mod muscles;
pub mod resolve;
pub mod steps;

use rusqlite::Row;

use models::ExerciseRecord;

/// 动作库查询列（含使用统计：做过组的训练次数与最近一次日期）。
/// SELECT 时必须使用，保证行映射下标稳定。
pub(crate) const EXERCISE_SELECT: &str = "\
    SELECT e.id, e.name, e.aliases, e.kind, e.category, e.equipment, e.muscles, e.tips, \
           e.default_sets, e.default_reps, e.default_weight_kg, e.default_target_sec, \
           e.default_duration_min, e.default_rest_sec, e.weight_step, e.is_custom, e.hidden, \
           COALESCE(u.sessions, 0), u.last_date, e.steps, e.favorite \
    FROM exercises e \
    LEFT JOIN ( \
      SELECT s.exercise_id, COUNT(DISTINCT s.workout_id) AS sessions, MAX(w.date) AS last_date \
      FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
      WHERE s.exercise_id IS NOT NULL \
      GROUP BY s.exercise_id \
    ) u ON u.exercise_id = e.id";

pub(crate) fn exercise_from_row(row: &Row<'_>) -> rusqlite::Result<ExerciseRecord> {
    let aliases: String = row.get(2)?;
    let muscles: String = row.get(6)?;
    let steps: String = row.get(19)?;
    Ok(ExerciseRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        aliases: serde_json::from_str(&aliases).unwrap_or_default(),
        kind: row.get(3)?,
        category: row.get(4)?,
        equipment: row.get(5)?,
        muscles: serde_json::from_str(&muscles).unwrap_or(serde_json::Value::Null),
        tips: row.get(7)?,
        default_sets: row.get(8)?,
        default_reps: row.get(9)?,
        default_weight_kg: row.get(10)?,
        default_target_sec: row.get(11)?,
        default_duration_min: row.get(12)?,
        default_rest_sec: row.get(13)?,
        weight_step: row.get(14)?,
        is_custom: row.get::<_, i64>(15)? != 0,
        hidden: row.get::<_, i64>(16)? != 0,
        sessions: row.get(17)?,
        last_used_at: row.get(18)?,
        steps: serde_json::from_str(&steps).unwrap_or_default(),
        favorite: row.get::<_, i64>(20)? != 0,
    })
}
