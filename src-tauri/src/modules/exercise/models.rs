//! 运动域数据模型 · 与前端 `src/types/exercise.ts` 对应。

use serde::{Deserialize, Serialize};

use crate::modules::heartrate::models::HrWorkoutSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workout {
    pub id: i64,
    pub name: String,
    pub r#type: String,
    pub date: String,
    pub start_min: Option<i64>,
    pub duration_min: f64,
    pub kcal: f64,
    /// 客观档位（配速/逐组重量反推）。手动补录写入的是从 `effort` 派生的档位，
    /// 见 db.rs MIGRATION_0035 的说明。
    pub intensity: String,
    /// 体感强度 1–5：手动补录由用户口述；课程/跑步路径为 None
    pub effort: Option<i64>,
    pub note: Option<String>,
    /// 来源会话（session_finish 落关联）；手动添加为 NULL
    pub session_id: Option<i64>,
    /// 这条记录是谁的：`local` = Rein 自己记的（补录 / 课程 / 跑步），
    /// `health_connect` = 从系统 Health Connect 同步进来的第三方数据。
    ///
    /// 为什么要露给前端与对外网关：两者的**归属不同** —— `local` 以本机为准
    /// （会回写 HC、删除时连带收掉 HC 那份副本），`health_connect` 以 HC 为准
    /// （在 Rein 里改了会被下次同步覆盖、删了只写墓碑不动 HC 那份）。
    /// 界面不标出来，用户就解释不了「为什么这条改不回去」。
    ///
    /// 列有默认值 `local`（db.rs MIGRATION_0036），同步白名单也没有跳过它，
    /// 所以它在跨设备同步后仍然保持原值。
    pub source: String,
    pub created_at: String,
    /// 整场心率摘要（无样本 / 手动补录 / 手机同步为 None）。
    /// 落库是 `workouts.hr_json` 一整份 JSON：历史详情与结果页读的是同一份读数，
    /// 不另在记录上摊七八个列。
    pub hr: Option<HrWorkoutSummary>,
}
