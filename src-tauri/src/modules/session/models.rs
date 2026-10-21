//! 训练课会话数据模型 · 与前端 `src/types/session.ts` 对应。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: i64,
    pub plan_id: String,
    pub plan_name: String,
    /// active | finished | aborted
    pub status: String,
    pub started_at: String,
    /// SQLite datetime('now')，UTC
    pub updated_at: String,
    pub ex_index: i64,
    pub set_index: i64,
    pub weight_kg: f64,
    /// 快照间自动累加的真实流逝秒数（服务端计算）
    pub elapsed_sec: f64,
    /// 前端状态快照（doneSets / phase 等，见 stores/session.ts）
    pub state: Value,
    /// 逐组落库明细（`workout_sets`，按落库顺序）。仅 `session_for_workout` 填充，
    /// 其它返回路径为空 —— 见 [`SessionSetRow`] 的说明。
    pub sets: Vec<SessionSetRow>,
}

/// 一场训练已落库的逐组明细（`workout_sets` 的一行）。
///
/// **为什么详情页要读它、而不是只读 `state.doneSets`**：`doneSets` 的键是
/// **课程条目 id**（`PlanExercise.id`，前端 `crypto.randomUUID()` 生成的），
/// 而课程可以事后被整体覆盖（AI 的 `upsert_plan` 老版本每次都重建 id、手动编辑也可能
/// 增删重排）。键一变，历史记录的每一组都匹配不到课程条目 —— 详情页于是把真实数据
/// 摊成十几条「其他动作」，而课程动作全部显示「未完成」，完成组数分母还虚增一倍。
/// 本表在保存训练时就把**当时的动作名 + 动作库 id** 固化了，是详情页唯一稳定的真源。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetRow {
    /// 当时课程条目 id（可能已不存在于课程里，仅作参考）
    pub exercise_key: String,
    /// 当时登记的动作名（课程改名 / 动作被删也不追溯，与重量曲线同一口径）
    pub exercise_name: String,
    /// 动作库 id（重量曲线聚合键）；老记录可能为空
    pub exercise_id: Option<String>,
    pub kind: String,
    /// 正式组与热身组各从 1 计
    pub set_no: i64,
    pub weight_kg: Option<f64>,
    pub reps: Option<i64>,
    pub sec: Option<i64>,
    pub warmup: bool,
}

/// 正常结束（用户确认保存）时的提交体
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishInput {
    pub id: i64,
    pub name: String,
    pub workout_type: String,
    pub date: String,
    pub duration_min: f64,
    pub intensity: Option<String>,
    pub kcal: f64,
    pub note: Option<String>,
    /// 逐组做组明细（session_finish 事务内展开写入 workout_sets）；旧客户端缺省 = 空
    #[serde(default)]
    pub sets: Vec<FinishSet>,
}

/// 一行逐组记录 · 与前端 `StrengthSetRow` 对应
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishSet {
    pub exercise_key: String,
    pub exercise_name: String,
    /// 动作库 id（课程条目携带）；缺省时服务端按名称兜底解析
    #[serde(default)]
    pub exercise_id: Option<String>,
    pub kind: String,
    pub set_no: i64,
    pub weight_kg: Option<f64>,
    pub reps: Option<i64>,
    pub sec: Option<i64>,
    #[serde(default)]
    pub warmup: bool,
}

/// 逐组记录查询行（JOIN workouts 取日期）· 重量曲线与训练建议引擎的数据源。
/// `exerciseId` 是聚合键；`exerciseName` 只是历史快照（动作库改名不追溯）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthSetRecord {
    pub workout_id: i64,
    pub date: String,
    pub exercise_key: String,
    pub exercise_id: Option<String>,
    pub exercise_name: String,
    pub kind: String,
    pub set_no: i64,
    pub weight_kg: Option<f64>,
    pub reps: Option<i64>,
    pub sec: Option<i64>,
    pub warmup: bool,
    /// 该组所属训练会话的「今日状态自评」1..5（workout_sessions.state_json 里的 readiness）。
    /// 未自评 / 手动补录的记录为 None。
    /// 本来是会话级字段，这里按组拍平返回：一次查询就能同时喂「重量曲线」与「练够分」。
    pub readiness: Option<i64>,
    /// 该组所属训练会话的**训练后体感**三档（`state_json.postFeeling`）：
    /// `better`（比预期好）/ `as_expected`（和预期差不多）/ `worse`（比预期差）。
    ///
    /// 这是练够分「体感」维度的**首选**输入：它问的是「这次练得怎么样」，
    /// 而 `readiness` 问的是「今天开始前状态如何」——「体感」从前一直吃的是后者，
    /// 语义对不上（练到一半崩掉、或反而很轻松，都不进分）。
    /// 没有它的记录（0.6.1 之前）由前端兼容层 0.0.1 回退用 readiness，并如实标注来源。
    pub post_feeling: Option<String>,
}

/// 有力量记录的动作引用（按最近训练在前）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthExerciseRef {
    /// 动作库 id；老库未回填时为空字符串（前端回落 name 作键）
    pub exercise_id: String,
    /// 展示名：库内名优先（动作库改名后曲线卡跟着变）
    pub name: String,
    pub last_date: String,
    pub sessions: i64,
}

/// 某动作最近一次做组重量（沉浸页「上次重量」预填）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthLastWeight {
    pub exercise_id: String,
    pub name: String,
    pub weight_kg: f64,
    pub reps: Option<i64>,
    pub date: String,
}
