//! 闹钟/计时器（Android）。真实执行在 Kotlin `AlarmOps`。
//!
//! Rust 侧职责（plan §1.2 / §13.3）：
//! - `validate`：在执行前按 native method 校验 payload（范围、长度、枚举），
//!   纯 JSON 逻辑、不依赖 JNI，可在任意 host 单测；
//! - `handle`：非 Android host（或未经 `android::invoke` 的误用）返回结构化错误，
//!   绝不返回假成功；Android 上的真实调用由 `android::invoke` 走 JNI；
//! - `status`：按 app 读取已刷新的 `state.json`（批量 status 仍走 `android::statuses`）。
//!
//! 闹钟写方法不弹确认（plan §6.3 的产品选择）：确认只由前端 app 工具的 `execute` 决定，
//! 写许可与审计在 `connected_app_invoke` 的统一路径上完成。

use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::super::models::{ConnectedAppInvokeReply, ConnectedAppStatus};

const MAX_LABEL_CHARS: usize = 64;
const MAX_SECONDS: i64 = 86_400;
const MAX_DAYS: usize = 7;

/// 校验失败：只带错误码与中文消息，由 `handle` 组装成 invoke reply。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Invalid {
    pub code: &'static str,
    pub message: String,
}

fn invalid(code: &'static str, message: impl Into<String>) -> Invalid {
    Invalid {
        code,
        message: message.into(),
    }
}

fn bad(message: impl Into<String>) -> Invalid {
    invalid("connected_app_bad_request", message)
}

/// 按 app 读取状态（Kotlin `refresh` 之后调用）。
///
/// 批量状态由 `commands::connected_app_status` → `android::statuses` 提供；
/// 这个入口给未来需要单 app 状态的调用方复用，避免再写一遍合并公式。
#[allow(dead_code)]
pub(crate) fn status(
    app: &AppHandle,
    enabled: bool,
    ai_intent: bool,
    write_intent: bool,
) -> ConnectedAppStatus {
    let spec = super::super::state::find("alarm").expect("alarm AppSpec 必须存在");
    super::super::android::status_for(app, spec, enabled, ai_intent, write_intent)
}

/// 执行前的纯 JSON 校验。
pub(crate) fn validate(method: &str, payload: &Value) -> std::result::Result<(), Invalid> {
    match method {
        "alarm_next" => Ok(()),
        "set_alarm" => validate_set_alarm(payload),
        "set_timer" => validate_set_timer(payload),
        "dismiss_alarm" | "dismiss_timer" => validate_dismiss(payload),
        _ => Err(invalid(
            "connected_app_unknown_method",
            format!("闹钟不支持方法 {method}"),
        )),
    }
}

pub(crate) fn handle(
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    match validate(method, payload) {
        Ok(()) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unsupported",
            "闹钟能力只在 Android 上执行（真实调用由 Kotlin AlarmOps 经系统时钟 intent 完成）",
            None,
        )),
        Err(e) => Ok(ConnectedAppInvokeReply::err(
            app_id, method, e.code, e.message, None,
        )),
    }
}

/// Android 分支的接入点：先 Rust 校验，再交给 `android::invoke`（JNI + 结果文件）。
///
/// 当前主链路是 `apps::validate_android` + `android::invoke`；本封装保留给
/// 直接以 app 模块为入口的调用方，校验口径一致。
#[allow(dead_code)]
pub(crate) async fn invoke(
    app: &AppHandle,
    spec: &super::super::state::AppSpec,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    if let Err(e) = validate(method, payload) {
        return Ok(ConnectedAppInvokeReply::err(
            spec.id, method, e.code, e.message, None,
        ));
    }
    super::super::android::invoke(app, spec, method, payload).await
}

fn validate_set_alarm(payload: &Value) -> std::result::Result<(), Invalid> {
    int_field(payload, "hour", 0, 23)?;
    int_field(payload, "minute", 0, 59)?;
    optional_str(payload, "label", MAX_LABEL_CHARS)?;
    optional_bool(payload, "vibrate")?;
    optional_bool(payload, "skipUi")?;
    if let Some(days) = payload.get("days").filter(|v| !v.is_null()) {
        let array = days.as_array().ok_or_else(|| bad("days 必须是整数数组"))?;
        if array.len() > MAX_DAYS {
            return Err(bad(format!("days 最多 {MAX_DAYS} 个")));
        }
        for (index, day) in array.iter().enumerate() {
            let value = day
                .as_i64()
                .ok_or_else(|| bad(format!("days[{index}] 必须是整数")))?;
            if !(1..=7).contains(&value) {
                return Err(bad("days 只能是 1..7（1=周一，7=周日）"));
            }
        }
    }
    Ok(())
}

fn validate_set_timer(payload: &Value) -> std::result::Result<(), Invalid> {
    int_field(payload, "seconds", 1, MAX_SECONDS)?;
    optional_str(payload, "label", MAX_LABEL_CHARS)?;
    optional_bool(payload, "skipUi")?;
    Ok(())
}

fn validate_dismiss(payload: &Value) -> std::result::Result<(), Invalid> {
    match payload.get("mode").and_then(Value::as_str) {
        Some("next") | Some("all") => Ok(()),
        Some(_) => Err(bad("mode 只能是 next 或 all")),
        None => Err(bad("mode 必填（next 或 all）")),
    }
}

fn int_field(payload: &Value, key: &str, min: i64, max: i64) -> std::result::Result<i64, Invalid> {
    let value = payload.get(key).ok_or_else(|| bad(format!("{key} 必填")))?;
    let number = value
        .as_i64()
        .ok_or_else(|| bad(format!("{key} 必须是整数")))?;
    if number < min || number > max {
        return Err(bad(format!("{key} 必须在 {min}..{max} 之间")));
    }
    Ok(number)
}

fn optional_str<'a>(
    payload: &'a Value,
    key: &str,
    max_chars: usize,
) -> std::result::Result<Option<&'a str>, Invalid> {
    match payload.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            if text.chars().count() > max_chars {
                return Err(bad(format!("{key} 不能超过 {max_chars} 字")));
            }
            Ok(Some(text))
        }
        Some(_) => Err(bad(format!("{key} 必须是字符串"))),
    }
}

fn optional_bool(payload: &Value, key: &str) -> std::result::Result<(), Invalid> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Bool(_)) => Ok(()),
        Some(_) => Err(bad(format!("{key} 必须是布尔值"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn alarm_next_accepts_empty_payload() {
        assert!(validate("alarm_next", &json!({})).is_ok());
    }

    #[test]
    fn set_alarm_requires_hour_and_minute() {
        assert_eq!(
            validate("set_alarm", &json!({})).unwrap_err().code,
            "connected_app_bad_request"
        );
        assert_eq!(
            validate("set_alarm", &json!({ "hour": 7 }))
                .unwrap_err()
                .code,
            "connected_app_bad_request"
        );
    }

    #[test]
    fn set_alarm_rejects_out_of_range_time() {
        assert!(validate("set_alarm", &json!({ "hour": 24, "minute": 0 })).is_err());
        assert!(validate("set_alarm", &json!({ "hour": -1, "minute": 0 })).is_err());
        assert!(validate("set_alarm", &json!({ "hour": 7, "minute": 60 })).is_err());
        assert!(validate("set_alarm", &json!({ "hour": 7.5, "minute": 0 })).is_err());
    }

    #[test]
    fn set_alarm_accepts_full_payload() {
        let payload = json!({
            "hour": 7,
            "minute": 30,
            "label": "起床",
            "days": [1, 2, 3, 4, 5],
            "vibrate": true,
            "skipUi": false,
        });
        assert!(validate("set_alarm", &payload).is_ok());
    }

    #[test]
    fn set_alarm_rejects_bad_days() {
        assert!(validate("set_alarm", &json!({ "hour": 7, "minute": 0, "days": [0] })).is_err());
        assert!(validate("set_alarm", &json!({ "hour": 7, "minute": 0, "days": [8] })).is_err());
        assert!(validate(
            "set_alarm",
            &json!({ "hour": 7, "minute": 0, "days": [1,1,1,1,1,1,1,1] })
        )
        .is_err());
        assert!(validate(
            "set_alarm",
            &json!({ "hour": 7, "minute": 0, "days": "mon" })
        )
        .is_err());
    }

    #[test]
    fn set_alarm_rejects_overlong_label_and_wrong_bool() {
        let long = "a".repeat(MAX_LABEL_CHARS + 1);
        assert!(validate(
            "set_alarm",
            &json!({ "hour": 7, "minute": 0, "label": long })
        )
        .is_err());
        assert!(validate(
            "set_alarm",
            &json!({ "hour": 7, "minute": 0, "skipUi": "yes" })
        )
        .is_err());
    }

    #[test]
    fn set_timer_bounds() {
        assert!(validate("set_timer", &json!({ "seconds": 1 })).is_ok());
        assert!(validate("set_timer", &json!({ "seconds": MAX_SECONDS })).is_ok());
        assert!(validate("set_timer", &json!({ "seconds": 0 })).is_err());
        assert!(validate("set_timer", &json!({ "seconds": MAX_SECONDS + 1 })).is_err());
    }

    #[test]
    fn dismiss_modes() {
        assert!(validate("dismiss_alarm", &json!({ "mode": "next" })).is_ok());
        assert!(validate("dismiss_timer", &json!({ "mode": "all" })).is_ok());
        assert!(validate("dismiss_alarm", &json!({ "mode": "later" })).is_err());
        assert!(validate("dismiss_alarm", &json!({})).is_err());
    }

    #[test]
    fn unknown_method_is_rejected() {
        let err = validate("delete_everything", &json!({})).unwrap_err();
        assert_eq!(err.code, "connected_app_unknown_method");
    }

    #[test]
    fn handle_returns_structured_error_not_fake_success() {
        let bad = handle("alarm", "set_alarm", &json!({ "hour": 99, "minute": 0 })).unwrap();
        assert!(!bad.ok);
        assert_eq!(
            bad.error.as_ref().unwrap().code,
            "connected_app_bad_request"
        );

        let ok = handle("alarm", "alarm_next", &json!({})).unwrap();
        assert!(!ok.ok);
        assert_eq!(ok.error.as_ref().unwrap().code, "connected_app_unsupported");
    }
}
