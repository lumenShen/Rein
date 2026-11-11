//! 种子数据：启动时把 `resources/foods.json`（前后端共用的单一来源）导入食物库，
//! 把 `resources/workout_plans.json` 导入课程库。食物按 name 幂等补齐
//! （UNIQUE 约束 + INSERT OR IGNORE：老库保留原 id 与份量，新增种子自动追加）；
//! 内置课程按 id 幂等补齐（不覆盖已有行，删除的内置课会补回）。

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use crate::error::Result;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedFile {
    foods: Vec<SeedFood>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedFood {
    name: String,
    category: String,
    kcal: f64,
    protein: f64,
    carb: f64,
    fat: f64,
    fiber: f64,
    sugar: f64,
    sodium_mg: f64,
    potassium_mg: f64,
    calcium_mg: f64,
    iron_mg: f64,
    zinc_mg: f64,
    magnesium_mg: f64,
    vit_a_ug: f64,
    vit_c_mg: f64,
    vit_d_ug: f64,
    vit_e_mg: f64,
    vit_b12_ug: f64,
    folate_ug: f64,
    default_unit: Option<String>,
    units: Vec<SeedUnit>,
}

#[derive(Deserialize)]
struct SeedUnit {
    name: String,
    grams: f64,
}

const FOODS_JSON: &str = include_str!("../../../resources/foods.json");

/// 0003 起课程表启用：内置课程种子（与前端 mock 共用同一 JSON 单一来源）
const WORKOUT_PLANS_JSON: &str = include_str!("../../../resources/workout_plans.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedFile {
    plans: Vec<PlanSeed>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeed {
    id: String,
    name: String,
    subtitle: String,
    workout_type: String,
    exercises: Value,
    /// 器械要求：gym / home / 缺省 = NULL（通用）
    #[serde(default)]
    equipment: Option<String>,
    /// 预估时长（分钟）；缺省 = NULL
    #[serde(default)]
    est_duration_min: Option<i64>,
}

/// 食物种子：按 name 幂等补齐（见模块注释）。
///
/// 快速路径：种子文件指纹 + 内置行数都吻合时**整段跳过**，而且**连 JSON 都不解**。
/// 启动时 `db::init` 会在主线程跑它：种子 JSON 有 700 KB（解析本身 ~25ms），
/// `INSERT OR IGNORE` 即便一条都不插入，也要为每一条种子走一次唯一索引冲突
/// （生产库实测 2722 条 / 34.7ms / debug，安卓闪存上只会更慢）。指纹只在种子
/// 文件变化时才变，行数则兜住「库被手工删过一行」这种极端情况。
pub fn seed_foods(conn: &Connection) -> Result<()> {
    let builtin: i64 = conn.query_row(
        "SELECT COUNT(*) FROM foods WHERE is_custom = 0",
        [],
        |r| r.get(0),
    )?;
    let fingerprint = seed_fingerprint(FOODS_JSON);
    // 存的形态是 `指纹:条数`；读不出来（老版本只存了指纹）就走完整种子
    let done = crate::db::meta_get(conn, SEED_FOODS_KEY).and_then(|raw| {
        let (fp, n) = raw.rsplit_once(':')?;
        Some((fp.to_string(), n.parse::<i64>().ok()?))
    });
    if let Some((fp, n)) = done {
        if fp == fingerprint && builtin >= n {
            return Ok(());
        }
    }
    let seed: SeedFile = serde_json::from_str(FOODS_JSON)?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO foods (name, category, kcal, protein, carb, fat, fiber, sugar, \
             sodium_mg, potassium_mg, calcium_mg, iron_mg, zinc_mg, magnesium_mg, \
             vit_a_ug, vit_c_mg, vit_d_ug, vit_e_mg, vit_b12_ug, folate_ug, default_unit, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
        )?;
        for f in &seed.foods {
            let inserted = stmt.execute(rusqlite::params![
                f.name,
                f.category,
                f.kcal,
                f.protein,
                f.carb,
                f.fat,
                f.fiber,
                f.sugar,
                f.sodium_mg,
                f.potassium_mg,
                f.calcium_mg,
                f.iron_mg,
                f.zinc_mg,
                f.magnesium_mg,
                f.vit_a_ug,
                f.vit_c_mg,
                f.vit_d_ug,
                f.vit_e_mg,
                f.vit_b12_ug,
                f.folate_ug,
                f.default_unit,
                now
            ])?;
            if inserted == 0 {
                continue; // 老库已有同名食物：保留原行（id/份量不变）
            }
            let food_id = conn.last_insert_rowid();
            for u in &f.units {
                conn.execute(
                    "INSERT INTO food_units (food_id, name, grams) VALUES (?1, ?2, ?3)",
                    rusqlite::params![food_id, u.name, u.grams],
                )?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    // 记下「这版种子已经完整落过库」，下次启动走快速路径（连 JSON 都不解）
    crate::db::meta_set(
        conn,
        SEED_FOODS_KEY,
        &format!("{fingerprint}:{}", seed.foods.len()),
    )?;
    Ok(())
}

/// 食物种子的指纹键（app_meta）。值 = 种子 JSON 的 FNV-1a 64 位十六进制。
const SEED_FOODS_KEY: &str = "seed.foods.fingerprint.v1";

/// FNV-1a 64：只做「同一个二进制里的同一份种子」比对，不需要抗碰撞强度。
fn seed_fingerprint(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// 内置课程种子内容版本：种子里的课程内容（exercises/subtitle）变更时 +1。
/// 首次安装直接按最新版本导入；老库升级后不自动刷新内容，而是返回
/// `PlanSeedStatus::Pending`，由前端发起三选一（兼容合并 / 使用新版本 / 保留我的）。
const PLAN_SEED_CONTENT_VERSION: i64 = 5;

/// 课程种子升级决策（持久化在 app_meta）：兼容合并已把种子内容吸收进用户数据。
const META_APPLIED: &str = "plan_seed_applied";
/// 课程种子升级决策：用户选择「使用新版本」，本地内置课内容已被新种子覆盖。
const META_OVERRIDE: &str = "plan_seed_override";
/// 课程种子升级决策：用户选择「保留我的」，本版本不再打扰，下个种子版本再问。
const META_KEEP: &str = "plan_seed_keep";

/// 读 app_meta 键（存数值）。
fn meta_int(conn: &Connection, key: &str) -> i64 {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = ?1",
        [key],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 内置课程种子升级状态（前端课程库页据此决定是否弹出「新版本」横幅）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSeedStatus {
    /// 当前内置课程种子版本（已合入 / 决策后的版本）
    pub current_version: i64,
    /// 资源文件里的最新种子版本
    pub latest_version: i64,
}

impl PlanSeedStatus {
    fn pending() -> PlanSeedStatus {
        PlanSeedStatus {
            current_version: 0,
            latest_version: PLAN_SEED_CONTENT_VERSION,
        }
    }

    fn settled(v: i64) -> PlanSeedStatus {
        PlanSeedStatus {
            current_version: v,
            latest_version: PLAN_SEED_CONTENT_VERSION,
        }
    }
}

/// 读种子升级状态：current_version 落后于 latest_version 即表示「有新版本待决策」。
/// 决策标识只用来区分是应用了（migrate/override）还是忽略了（keep），
/// 避免每次启动重复弹窗；三种都记在 current_version。
pub fn plan_seed_status(conn: &Connection) -> Result<PlanSeedStatus> {
    let applied = meta_int(conn, META_APPLIED);
    let override_ = meta_int(conn, META_OVERRIDE);
    let keep = meta_int(conn, META_KEEP);
    let stored = meta_int(conn, "plan_seed_version");

    let settled = match stored {
        s if s > 0 => Some(s),
        _ => [applied, override_, keep].into_iter().find(|&v| v > 0),
    };
    Ok(match settled {
        Some(v) => PlanSeedStatus::settled(v),
        None => PlanSeedStatus::pending(),
    })
}

/// 写入决策：统一在 `plan_seed_version` 记目标版本，并清掉其它决策标识，
/// 保证三种决策互斥、幂等（重复调用无害）。
fn settle_seed_decision(conn: &Connection, version: i64, applied: bool) -> Result<()> {
    let overridden = !applied;
    crate::db::meta_set(conn, "plan_seed_version", &version.to_string())?;
    crate::db::meta_set(conn, META_APPLIED, &(if applied { version } else { 0 }).to_string())?;
    crate::db::meta_set(
        conn,
        META_OVERRIDE,
        &(if overridden { version } else { 0 }).to_string(),
    )?;
    crate::db::meta_set(conn, META_KEEP, "0")?;
    Ok(())
}

/// 兼容合并：把新种子内容合并进本地课程，**绝不覆盖用户设置过的任何值**。
///  - 按动作 id 对齐：本地缺失的字段补上新种子值（激活热身组、肌群标注等结构改进）；
///    用户已设置的字段一律保留。
///  - 本地缺失的动作整条补上（`kind` 相同才补，防止换过动作的 id 被错放）。
///  - 名称 / 副标题 / 类型 / 组数 / 次数 / 重量：始终尊重用户数据，不合并。
pub fn plan_seed_migrate(conn: &Connection) -> Result<()> {
    let seed: PlanSeedFile = serde_json::from_str(WORKOUT_PLANS_JSON)?;
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut update = conn.prepare(
            "UPDATE workout_plans SET exercises_json = ?2, updated_at = ?3 WHERE id = ?1",
        )?;
        for p in &seed.plans {
            let current: Option<String> = conn
                .query_row(
                    "SELECT exercises_json FROM workout_plans WHERE id = ?1",
                    [&p.id],
                    |r| r.get(0),
                )
                .ok();
            let Some(cur) = current else { continue };
            let merged = merge_plan_exercises(&cur, p.exercises.as_array().unwrap_or(&vec![]));
            update.execute(rusqlite::params![
                p.id,
                merged,
                chrono::Utc::now().to_rfc3339()
            ])?;
        }
        drop(update);
        settle_seed_decision(conn, PLAN_SEED_CONTENT_VERSION, true)?;
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/// 「使用新版本」：按 id 把本地内置课内容整体覆盖为新种子（用户对该内置课的编辑
/// 会被替换 —— 用户明确选择了新版本，语义一致）。
pub fn plan_seed_override(conn: &Connection) -> Result<()> {
    let seed: PlanSeedFile = serde_json::from_str(WORKOUT_PLANS_JSON)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare(
            "UPDATE workout_plans SET subtitle = ?2, exercises_json = ?3, updated_at = ?4 WHERE id = ?1",
        )?;
        for p in &seed.plans {
            stmt.execute(rusqlite::params![
                p.id,
                p.subtitle,
                p.exercises.to_string(),
                now
            ])?;
        }
        drop(stmt);
        settle_seed_decision(conn, PLAN_SEED_CONTENT_VERSION, false)?;
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/// 「保留我的」：本版本不再刷新内置课内容，只结清版本提示（下个种子版本再问）。
pub fn plan_seed_keep(conn: &Connection) -> Result<()> {
    conn.execute_batch("BEGIN")?;
    let result = settle_seed_decision(conn, PLAN_SEED_CONTENT_VERSION, true);
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    result.map(|_| ())
}

/// 把 `stored_json`（本地已存的内置课动作数组）与新种子动作数组做字段级合并。
/// 不依赖具体 schema，字段名一致即吸收新值；本地缺该动作时补整条（同 kind）。
fn merge_plan_exercises(stored_json: &str, seed: &[Value]) -> String {
    let stored: Value = serde_json::from_str(stored_json).unwrap_or(Value::Null);
    let arr = stored.as_array();
    // 本地不是数组（异常数据）或种子为空：保留本地，安全兜底
    let Some(local) = arr else {
        return stored_json.to_string();
    };
    if seed.is_empty() {
        return stored_json.to_string();
    }

    let mut map: std::collections::HashMap<&str, Value> = std::collections::HashMap::new();
    for e in local {
        if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
            map.insert(id, e.clone());
        }
    }

    let mut out: Vec<Value> = Vec::new();
    for e in seed {
        let Some(id) = e.get("id").and_then(|v| v.as_str()) else {
            out.push(e.clone()); // 种子动作无 id：按整条补上
            continue;
        };
        match map.get(id) {
            Some(local_ex) => {
                // 只补本地缺失的字段；本地已有的字段（含用户改过的）一律保留
                let mut merged = local_ex.clone();
                let obj = merged.as_object_mut();
                if let (Some(o), Some(s)) = (obj, e.as_object()) {
                    for (k, sv) in s {
                        o.entry(k.to_string()).or_insert_with(|| sv.clone());
                    }
                }
                out.push(merged);
            }
            None => {
                // 新动作：仅当类型与本地同 id 动作一致才补（防御换过动作的 id 冲突）
                if let Some(kind) = e.get("kind").and_then(|v| v.as_str()) {
                    let conflict = local
                        .iter()
                        .any(|x| x.get("kind").and_then(|v| v.as_str()) == Some(kind));
                    if !conflict {
                        out.push(e.clone());
                    }
                } else {
                    out.push(e.clone());
                }
            }
        }
    }
    // 本地独有的动作（用户新增的自定义动作）保留
    let seed_ids: std::collections::HashSet<&str> = seed
        .iter()
        .filter_map(|e| e.get("id").and_then(|v| v.as_str()))
        .collect();
    for e in local {
        let id = e.get("id").and_then(|v| v.as_str());
        if let Some(id) = id {
            if !seed_ids.contains(id) {
                out.push(e.clone());
            }
        }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| stored_json.to_string())
}

/// 内置课程种子：启动时按 id **增量**补种（INSERT OR IGNORE）。
/// 缺失的内置课补入（含老库 0003 前从未导入的旧版课程）；已有行（含用户改过的）
/// 永不覆盖；内容版本升级不再自动刷新，见 `plan_seed_status` 与三选一命令。
/// 代价：用户删除的内置课程会在下次启动时补回——内置课程始终可用优先。
pub fn seed_builtin_plans(conn: &Connection) -> Result<()> {
    let seed: PlanSeedFile = serde_json::from_str(WORKOUT_PLANS_JSON)?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO workout_plans (id, name, subtitle, workout_type, exercises_json, equipment, est_duration_min, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        )?;
        for p in &seed.plans {
            stmt.execute(rusqlite::params![
                p.id,
                p.name,
                p.subtitle,
                p.workout_type,
                p.exercises.to_string(),
                p.equipment,
                p.est_duration_min,
                now
            ])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/* ---------- 动作库种子（0025） ---------- */

/// 动作库种子（与前端 mock 共用同一 JSON 单一来源）。
const EXERCISES_JSON: &str = include_str!("../../../resources/exercises.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExerciseSeedFile {
    /// 生成器写出的全部合法肌群键（与 `exercise_lib::muscles::MUSCLE_KEYS` 必须一致）。
    ///
    /// **只给漂移单测用**（见本文件末尾的 `muscle_keys_match_backend`）——
    /// 生产代码不读它：写入路径走 `exercise_lib::muscles::sanitize_muscles` 的白名单，
    /// 那里已经拦住了未知键。clippy 的 `dead_code` 因此要显式放行。
    #[serde(default)]
    #[allow(dead_code)]
    muscle_keys: Vec<String>,
    exercises: Vec<ExerciseSeed>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExerciseSeed {
    id: String,
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    kind: String,
    category: String,
    #[serde(default)]
    equipment: Option<String>,
    #[serde(default)]
    muscles: Value,
    #[serde(default)]
    tips: String,
    #[serde(default)]
    steps: Value,
    default_sets: i64,
    #[serde(default)]
    default_reps: Option<i64>,
    #[serde(default)]
    default_weight_kg: Option<f64>,
    #[serde(default)]
    default_target_sec: Option<i64>,
    #[serde(default)]
    default_duration_min: Option<i64>,
    default_rest_sec: i64,
    weight_step: f64,
}

/// 内置动作种子：与课程种子相反，内置动作是**只读**的，所以每次启动**覆盖式刷新**
/// 内容列（种子改名/补肌群/改要点自动生效，无需版本三选一），只保留用户自己的
/// `hidden` 隐藏标记；`is_custom=1` 的自建动作永不触碰。
pub fn seed_exercises(conn: &Connection) -> Result<()> {
    let seed: ExerciseSeedFile = serde_json::from_str(EXERCISES_JSON)?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare(
            "INSERT INTO exercises \
             (id, name, aliases, kind, category, equipment, muscles, tips, steps, default_sets, default_reps, \
              default_weight_kg, default_target_sec, default_duration_min, default_rest_sec, weight_step, \
              is_custom, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, ?17, ?17) \
             ON CONFLICT(id) DO UPDATE SET \
               name = excluded.name, aliases = excluded.aliases, kind = excluded.kind, \
               category = excluded.category, equipment = excluded.equipment, muscles = excluded.muscles, \
               tips = excluded.tips, steps = excluded.steps, default_sets = excluded.default_sets, \
               default_reps = excluded.default_reps, default_weight_kg = excluded.default_weight_kg, \
               default_target_sec = excluded.default_target_sec, \
               default_duration_min = excluded.default_duration_min, \
               default_rest_sec = excluded.default_rest_sec, weight_step = excluded.weight_step, \
               updated_at = excluded.updated_at \
             WHERE exercises.is_custom = 0",
        )?;
        for e in &seed.exercises {
            stmt.execute(rusqlite::params![
                e.id,
                e.name,
                serde_json::to_string(&e.aliases)?,
                e.kind,
                e.category,
                e.equipment,
                crate::modules::exercise_lib::muscles::sanitize_muscles(&e.muscles).to_string(),
                e.tips,
                serde_json::to_string(&crate::modules::exercise_lib::steps::sanitize_steps_value(
                    &e.steps
                ))?,
                e.default_sets,
                e.default_reps,
                e.default_weight_kg,
                e.default_target_sec,
                e.default_duration_min,
                e.default_rest_sec,
                e.weight_step,
                now,
            ])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不变量：课程种子里出现的每个动作名，动作库种子必须能覆盖
    /// （否则内置课的动作在打开时就解析不到库内条目，回填会把它当成自建动作）。
    #[test]
    fn exercise_seed_covers_all_plan_movements() {
        let plans: PlanSeedFile = serde_json::from_str(WORKOUT_PLANS_JSON).unwrap();
        let lib: ExerciseSeedFile = serde_json::from_str(EXERCISES_JSON).unwrap();

        let mut known: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for e in &lib.exercises {
            known.insert(e.name.as_str());
            for a in &e.aliases {
                known.insert(a.as_str());
            }
        }

        let mut missing = Vec::new();
        for p in &plans.plans {
            for ex in p.exercises.as_array().into_iter().flatten() {
                let Some(name) = ex.get("name").and_then(|v| v.as_str()) else {
                    continue;
                };
                if !known.contains(name) {
                    missing.push(name.to_string());
                }
            }
        }
        assert!(
            missing.is_empty(),
            "课程种子里的动作没有进动作库：{missing:?}"
        );
    }

    /// 动作库种子的 id 唯一（重量曲线按 id 聚合，重复 id 会让两条曲线合并）。
    #[test]
    fn exercise_seed_ids_are_unique() {
        let lib: ExerciseSeedFile = serde_json::from_str(EXERCISES_JSON).unwrap();
        let mut seen = std::collections::HashSet::new();
        for e in &lib.exercises {
            assert!(seen.insert(e.id.as_str()), "重复的动作 id：{}", e.id);
        }
    }

    /// 肌群键白名单不漂移：种子里的 `muscleKeys` 必须与 Rust 常量完全一致
    /// （前端 `MUSCLE_KEYS` 就是生成 `muscleKeys` 的来源）。
    #[test]
    fn exercise_seed_muscle_keys_match_const() {
        use crate::modules::exercise_lib::muscles::MUSCLE_KEYS;
        let lib: ExerciseSeedFile = serde_json::from_str(EXERCISES_JSON).unwrap();
        assert_eq!(
            lib.muscle_keys, MUSCLE_KEYS,
            "resources/exercises.json 的 muscleKeys 与 Rust MUSCLE_KEYS 不一致：请重跑 scripts/gen-exercises.mjs 并同步 muscles.rs"
        );
    }

    /// 每条内置动作的肌群表都必须是合法键 + 1~3 档（清洗后不得丢内容）。
    #[test]
    fn exercise_seed_muscles_are_valid() {
        use crate::modules::exercise_lib::muscles::{is_muscle_key, sanitize_muscles};
        let lib: ExerciseSeedFile = serde_json::from_str(EXERCISES_JSON).unwrap();
        for e in &lib.exercises {
            let Some(map) = e.muscles.as_object() else {
                panic!("动作「{}」的肌群表不是对象：{}", e.name, e.muscles);
            };
            for (key, level) in map {
                assert!(
                    is_muscle_key(key),
                    "动作「{}」含未知肌群键：{key}",
                    e.name
                );
                assert!(
                    matches!(level.as_i64(), Some(1..=3)),
                    "动作「{}」的「{key}」档位非法：{level}",
                    e.name
                );
            }
            assert_eq!(
                sanitize_muscles(&e.muscles),
                e.muscles.clone(),
                "动作「{}」的肌群表被清洗后发生了变化（生成器写入了非法值）",
                e.name
            );
        }
    }

    /// 种子刷新不能覆盖用户态列（favorite / hidden），只刷新内容列。
    #[test]
    fn seed_refresh_preserves_user_state_columns() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        seed_exercises(&conn).unwrap();
        conn.execute("UPDATE exercises SET favorite = 1 WHERE id = 'plank'", [])
            .unwrap();
        conn.execute("UPDATE exercises SET hidden = 1 WHERE id = 'crunch'", [])
            .unwrap();
        conn.execute("UPDATE exercises SET steps = '[\"用户改过的要领\"]' WHERE id = 'pull-up'", [])
            .unwrap();
        seed_exercises(&conn).unwrap();
        let (fav, hid): (i64, i64) = conn
            .query_row(
                "SELECT favorite, hidden FROM exercises WHERE id = 'plank'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(fav, 1, "favorite 被种子刷新覆盖了");
        let hidden: i64 = conn
            .query_row("SELECT hidden FROM exercises WHERE id = 'crunch'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(hid, 0, "plank 的 hidden 不应受影响");
        assert_eq!(hidden, 1, "hidden 被种子刷新覆盖了");
        // steps 是内容列：内置动作的修改会被种子覆盖回去
        let steps: String = conn
            .query_row("SELECT steps FROM exercises WHERE id = 'pull-up'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_ne!(steps, "[\"用户改过的要领\"]", "内置动作的 steps 应随种子刷新");
    }
}
