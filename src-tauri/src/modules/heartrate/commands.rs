//! 心率域命令 · 与前端 `src/services/heartRateService.ts` 对应。
//!
//! 命令只做「改共享状态 + 投递采集线程」，不在 IPC 线程里等待蓝牙操作；
//! 前端拿到的状态通过 `hr://status` 事件继续更新。

use tauri::State;

use super::calc::HrProfile;
use super::models::{HrStatus, HrWorkoutSummary};
use super::HrService;

#[tauri::command]
pub fn hr_state(service: State<'_, HrService>) -> HrStatus {
    service.status()
}

/// 训练前同步身体数据：区间与 Keytel 公式都吃年龄 / 性别 / 体重。
#[tauri::command]
pub fn hr_set_profile(
    service: State<'_, HrService>,
    age_years: Option<f64>,
    sex: Option<String>,
    weight_kg: Option<f64>,
) -> HrStatus {
    service.set_profile(HrProfile::new(age_years, sex, weight_kg))
}

#[tauri::command]
pub fn hr_scan_start(service: State<'_, HrService>) -> HrStatus {
    service.scan_start()
}

#[tauri::command]
pub fn hr_scan_stop(service: State<'_, HrService>) -> HrStatus {
    service.scan_stop()
}

#[tauri::command]
pub fn hr_connect(service: State<'_, HrService>, id: String, name: Option<String>) -> HrStatus {
    service.connect(id, name)
}

#[tauri::command]
pub fn hr_disconnect(service: State<'_, HrService>) -> HrStatus {
    service.disconnect()
}

/// 开始测量。`started_at_ms` 让恢复的会话把上半场也算进覆盖率；
/// `device_id` / `device_name` 是用户上次成功连接的那台，训练开始时自动连它。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn hr_workout_start(
    service: State<'_, HrService>,
    age_years: Option<f64>,
    sex: Option<String>,
    weight_kg: Option<f64>,
    started_at_ms: Option<i64>,
    device_id: Option<String>,
    device_name: Option<String>,
    paused: Option<bool>,
) -> HrStatus {
    service.workout_start(
        HrProfile::new(age_years, sex, weight_kg),
        started_at_ms,
        device_id,
        device_name,
        paused.unwrap_or(false),
    )
}

/// 结束并取回测量总结。未收到任何样本时返回 null（前端回退到 MET / ACSM 估算）。
#[tauri::command]
pub fn hr_workout_finish(service: State<'_, HrService>) -> Option<HrWorkoutSummary> {
    service.workout_finish()
}

#[tauri::command]
pub fn hr_workout_cancel(service: State<'_, HrService>) -> HrStatus {
    service.workout_cancel()
}

/// 跑步暂停：暂停期间的心率样本不计热量、不计覆盖率。
#[tauri::command]
pub fn hr_workout_pause(service: State<'_, HrService>) -> HrStatus {
    service.workout_pause()
}

#[tauri::command]
pub fn hr_workout_resume(service: State<'_, HrService>) -> HrStatus {
    service.workout_resume()
}
