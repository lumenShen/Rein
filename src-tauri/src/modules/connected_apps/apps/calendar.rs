//! 安卓日历（Android）。真实执行在 Kotlin `CalendarOps`。
//!
//! Rust 侧职责（plan §1.2 / §13.3 / §6.5）：
//! - `validate`：纯 JSON 校验 native method 的 payload——时间格式、范围 ≤366 天、
//!   单次日程 ≤30 天、字段长度、eventId/calendarId 形态；可在任意 host 单测；
//! - `handle`：非 Android host 返回结构化错误，不假成功；Android 走 `android::invoke`；
//! - `status`：按 app 读取已刷新的 `state.json`（批量 status 仍走 `android::statuses`）。
//!
//! 审计与写许可由 `connected_app_invoke` 统一处理；`create/update/delete` 的确认
//! 只在 TS app 工具的 `execute` 里弹（`dangerous` 不是触发器）。

use chrono::{DateTime, NaiveDate};
use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::super::models::{ConnectedAppInvokeReply, ConnectedAppStatus};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS: i64 = 366 * DAY_MS;
const MAX_EVENT_MS: i64 = 30 * DAY_MS;
const MAX_LIST: i64 = 200;
const MAX_TITLE_CHARS: usize = 200;
const MAX_LOCATION_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_TIMEZONE_CHARS: usize = 64;
const MAX_ID_CHARS: usize = 64;

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
#[allow(dead_code)]
pub(crate) fn status(
    app: &AppHandle,
    enabled: bool,
    ai_intent: bool,
    write_intent: bool,
) -> ConnectedAppStatus {
    let spec = super::super::state::find("calendar").expect("calendar AppSpec 必须存在");
    super::super::android::status_for(app, spec, enabled, ai_intent, write_intent)
}

/// 执行前的纯 JSON 校验。
pub(crate) fn validate(method: &str, payload: &Value) -> std::result::Result<(), Invalid> {
    match method {
        "list_calendars" => Ok(()),
        "list_calendar_events" => validate_list_events(payload),
        "get_calendar_event" => {
            id_field(payload, "eventId")?;
            Ok(())
        }
        "create_calendar_event" => validate_create(payload),
        "update_calendar_event" => validate_update(payload),
        "delete_calendar_event" => {
            id_field(payload, "eventId")?;
            Ok(())
        }
        _ => Err(invalid(
            "connected_app_unknown_method",
            format!("日历不支持方法 {method}"),
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
            "日历能力只在 Android 上执行（真实调用由 Kotlin CalendarOps 经 CalendarContract 完成）",
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

fn validate_list_events(payload: &Value) -> std::result::Result<(), Invalid> {
    let from = required_time(payload, "from")?;
    let to = required_time(payload, "to")?;
    if to <= from {
        return Err(bad("to 必须晚于 from"));
    }
    if to - from > MAX_RANGE_MS {
        return Err(bad("查询范围不能超过 366 天"));
    }
    optional_int(payload, "limit", 1, MAX_LIST)?;
    if let Some(calendar_id) = optional_str(payload, "calendarId", MAX_ID_CHARS)? {
        if !all_digits(calendar_id) {
            return Err(bad("calendarId 必须是数字"));
        }
    }
    Ok(())
}

fn validate_create(payload: &Value) -> std::result::Result<(), Invalid> {
    required_str(payload, "title", 1, MAX_TITLE_CHARS)?;
    let start = required_time(payload, "start")?;
    let end = required_time(payload, "end")?;
    let all_day = optional_bool(payload, "allDay")?.unwrap_or(false);
    validate_event_range(start, end, all_day)?;
    optional_str(payload, "location", MAX_LOCATION_CHARS)?;
    optional_str(payload, "description", MAX_DESCRIPTION_CHARS)?;
    optional_str(payload, "timezone", MAX_TIMEZONE_CHARS)?;
    if let Some(calendar_id) = optional_str(payload, "calendarId", MAX_ID_CHARS)? {
        if !all_digits(calendar_id) {
            return Err(bad("calendarId 必须是数字"));
        }
    }
    Ok(())
}

fn validate_update(payload: &Value) -> std::result::Result<(), Invalid> {
    id_field(payload, "eventId")?;
    let mut has_field = false;
    for key in [
        "title",
        "start",
        "end",
        "allDay",
        "location",
        "description",
        "timezone",
    ] {
        if payload.get(key).is_some() {
            has_field = true;
        }
    }
    if !has_field {
        return Err(bad("至少提供一个要修改的字段"));
    }
    if payload.get("title").is_some() {
        required_str(payload, "title", 1, MAX_TITLE_CHARS)?;
    }
    optional_str(payload, "location", MAX_LOCATION_CHARS)?;
    optional_str(payload, "description", MAX_DESCRIPTION_CHARS)?;
    optional_str(payload, "timezone", MAX_TIMEZONE_CHARS)?;
    let all_day = optional_bool(payload, "allDay")?.unwrap_or(false);
    let start = optional_time(payload, "start")?;
    let end = optional_time(payload, "end")?;
    if let (Some(start), Some(end)) = (start, end) {
        validate_event_range(start, end, all_day)?;
    }
    Ok(())
}

/// 校验起止：普通事件要求 end > start；全天事件允许同一天（Kotlin 会把 end 推到次日）。
fn validate_event_range(start: i64, end: i64, all_day: bool) -> std::result::Result<(), Invalid> {
    if all_day {
        if end < start {
            return Err(bad("end 不能早于 start"));
        }
        if end - start > MAX_EVENT_MS {
            return Err(bad("单次日程不能超过 30 天"));
        }
        return Ok(());
    }
    if end <= start {
        return Err(bad("end 必须晚于 start"));
    }
    if end - start > MAX_EVENT_MS {
        return Err(bad("单次日程不能超过 30 天"));
    }
    Ok(())
}

fn parse_time(raw: &str) -> Option<i64> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis());
    }
    None
}

fn required_time(payload: &Value, key: &str) -> std::result::Result<i64, Invalid> {
    let text = payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(format!("{key} 必填且必须是 ISO 时间或 YYYY-MM-DD")))?;
    parse_time(text).ok_or_else(|| bad(format!("{key} 不是合法时间：{text}")))
}

fn optional_time(payload: &Value, key: &str) -> std::result::Result<Option<i64>, Invalid> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => parse_time(text)
            .map(Some)
            .ok_or_else(|| bad(format!("{key} 不是合法时间：{text}"))),
        Some(_) => Err(bad(format!("{key} 必须是 ISO 时间或 YYYY-MM-DD 字符串"))),
    }
}

fn id_field(payload: &Value, key: &str) -> std::result::Result<u64, Invalid> {
    let text = match payload.get(key) {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Null) | None => return Err(bad(format!("{key} 必填"))),
        Some(_) => return Err(bad(format!("{key} 必须是数字"))),
    };
    if text.is_empty() || text.chars().count() > MAX_ID_CHARS || !all_digits(&text) {
        return Err(bad(format!("{key} 必须是 1..{MAX_ID_CHARS} 位数字")));
    }
    let id: u64 = text
        .parse()
        .map_err(|_| bad(format!("{key} 必须是正整数")))?;
    if id == 0 {
        return Err(bad(format!("{key} 必须大于 0")));
    }
    Ok(id)
}

fn required_str<'a>(
    payload: &'a Value,
    key: &str,
    min_chars: usize,
    max_chars: usize,
) -> std::result::Result<&'a str, Invalid> {
    match payload.get(key) {
        Some(Value::String(text)) => {
            let len = text.chars().count();
            if len < min_chars || len > max_chars {
                return Err(bad(format!(
                    "{key} 长度必须在 {min_chars}..{max_chars} 字之间"
                )));
            }
            Ok(text)
        }
        Some(_) => Err(bad(format!("{key} 必须是字符串"))),
        None => Err(bad(format!("{key} 必填"))),
    }
}

fn optional_str<'a>(
    payload: &'a Value,
    key: &str,
    max_chars: usize,
) -> std::result::Result<Option<&'a str>, Invalid> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            if text.chars().count() > max_chars {
                return Err(bad(format!("{key} 不能超过 {max_chars} 字")));
            }
            Ok(Some(text))
        }
        Some(_) => Err(bad(format!("{key} 必须是字符串"))),
    }
}

fn optional_int(
    payload: &Value,
    key: &str,
    min: i64,
    max: i64,
) -> std::result::Result<Option<i64>, Invalid> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let number = value
                .as_i64()
                .ok_or_else(|| bad(format!("{key} 必须是整数")))?;
            if number < min || number > max {
                return Err(bad(format!("{key} 必须在 {min}..{max} 之间")));
            }
            Ok(Some(number))
        }
    }
}

fn optional_bool(payload: &Value, key: &str) -> std::result::Result<Option<bool>, Invalid> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(bad(format!("{key} 必须是布尔值"))),
    }
}

fn all_digits(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_create() -> Value {
        json!({
            "title": "周会",
            "start": "2026-11-11T10:00:00+08:00",
            "end": "2026-11-11T11:00:00+08:00",
            "location": "会议室 A",
            "description": "同步进度",
        })
    }

    #[test]
    fn list_calendars_accepts_empty_payload() {
        assert!(validate("list_calendars", &json!({})).is_ok());
    }

    #[test]
    fn list_events_requires_from_and_to() {
        assert_eq!(
            validate("list_calendar_events", &json!({}))
                .unwrap_err()
                .code,
            "connected_app_bad_request"
        );
        assert!(validate(
            "list_calendar_events",
            &json!({ "from": "2026-11-01", "to": "2026-11-30" })
        )
        .is_ok());
    }

    #[test]
    fn list_events_rejects_bad_range() {
        assert!(validate(
            "list_calendar_events",
            &json!({ "from": "2026-11-30", "to": "2026-11-01" })
        )
        .is_err());
        assert!(validate(
            "list_calendar_events",
            &json!({ "from": "2025-01-01", "to": "2026-11-01" })
        )
        .is_err());
        assert!(validate(
            "list_calendar_events",
            &json!({ "from": "not-a-date", "to": "2026-11-01" })
        )
        .is_err());
        assert!(validate(
            "list_calendar_events",
            &json!({ "from": "2026-11-01", "to": "2026-11-02", "limit": 201 })
        )
        .is_err());
    }

    #[test]
    fn create_event_validates_shape_and_duration() {
        assert!(validate("create_calendar_event", &valid_create()).is_ok());
        assert!(validate("create_calendar_event", &json!({ "title": "x", "start": "2026-11-11T10:00:00+08:00", "end": "2026-11-11T09:00:00+08:00" })).is_err());
        assert!(validate("create_calendar_event", &json!({ "title": "", "start": "2026-11-11T10:00:00+08:00", "end": "2026-11-11T11:00:00+08:00" })).is_err());
        assert!(validate("create_calendar_event", &json!({ "title": "x", "start": "2026-01-01T00:00:00+08:00", "end": "2026-03-01T00:00:00+08:00" })).is_err());
    }

    #[test]
    fn create_event_all_day_allows_same_day() {
        let payload = json!({
            "title": "生日",
            "start": "2026-11-11",
            "end": "2026-11-11",
            "allDay": true,
        });
        assert!(validate("create_calendar_event", &payload).is_ok());
    }

    #[test]
    fn create_event_rejects_overlong_fields() {
        let long_title = "x".repeat(MAX_TITLE_CHARS + 1);
        assert!(validate(
            "create_calendar_event",
            &json!({ "title": long_title, "start": "2026-11-11T10:00:00+08:00", "end": "2026-11-11T11:00:00+08:00" })
        )
        .is_err());
        let long_loc = "x".repeat(MAX_LOCATION_CHARS + 1);
        assert!(validate(
            "create_calendar_event",
            &json!({
                "title": "x",
                "start": "2026-11-11T10:00:00+08:00",
                "end": "2026-11-11T11:00:00+08:00",
                "location": long_loc
            })
        )
        .is_err());
    }

    #[test]
    fn update_event_requires_event_id_and_a_field() {
        assert!(validate("update_calendar_event", &json!({ "eventId": "1" })).is_err());
        assert!(validate("update_calendar_event", &json!({ "title": "x" })).is_err());
        assert!(validate(
            "update_calendar_event",
            &json!({ "eventId": "1", "title": "x" })
        )
        .is_ok());
        assert!(validate(
            "update_calendar_event",
            &json!({ "eventId": "1", "start": "2026-11-11T10:00:00+08:00" })
        )
        .is_ok());
    }

    #[test]
    fn event_id_rejects_zero_and_non_numeric() {
        assert!(validate("get_calendar_event", &json!({ "eventId": "0" })).is_err());
        assert!(validate("get_calendar_event", &json!({ "eventId": "abc" })).is_err());
        assert!(validate("delete_calendar_event", &json!({ "eventId": 12 })).is_ok());
    }

    #[test]
    fn unknown_method_is_rejected() {
        let err = validate("calendar_destroy", &json!({})).unwrap_err();
        assert_eq!(err.code, "connected_app_unknown_method");
    }

    #[test]
    fn handle_never_returns_fake_success() {
        let reply = handle("calendar", "list_calendar_events", &json!({})).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().unwrap().code,
            "connected_app_bad_request"
        );

        let reply = handle("calendar", "list_calendars", &json!({})).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().unwrap().code,
            "connected_app_unsupported"
        );
    }
}
