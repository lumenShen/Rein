//! 安卓使用时间（Android，只读）。
//!
//! 真实执行在 Kotlin `UsageOps`（`UsageStatsManager` 只能在 Android 进程里调）。
//! 这里保留 Rust 侧的**纯参数解析与上限**，用途有两个：
//! 1. 未来若把结果桥接进 Rust 侧工具，参数口径与 Kotlin 保持一致；
//! 2. 在不启动 Android 的 host 环境用 `cargo test` 覆盖口径（744h / 50 条等）。
//!
//! 消费方不要依赖本模块返回数据：Android 上 `connected_app_invoke` 直接走 JNI。

use serde_json::Value;

use crate::error::Result;

use super::super::models::ConnectedAppInvokeReply;

/// 使用时长汇总最多回看 31 天（744 小时）；plan §1.2 的 days 1..31。
pub(crate) const MAX_SINCE_HOURS: i64 = 31 * 24;
/// 按天查询最多 31 天。
pub(crate) const MAX_DAYS: i64 = 31;
/// 汇总最多返回 50 个应用（plan §1.2；Kotlin 同值）。
pub(crate) const MAX_SUMMARY_LIMIT: i64 = 50;
/// 事件最多回看 7 天。
pub(crate) const MAX_EVENT_DAYS: i64 = 7;
/// 事件最多返回 200 条。
pub(crate) const MAX_EVENT_LIMIT: i64 = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppUsageQuery {
    pub since_hours: i64,
    pub limit: usize,
    /// `Some` = 单包明细；`None` = 汇总 top apps。
    pub package: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UsageEventsQuery {
    pub days: i64,
    pub limit: usize,
}

pub(crate) fn parse_app_usage(payload: &Value) -> std::result::Result<AppUsageQuery, String> {
    let since_hours = parse_since_hours(payload)?;
    let limit = parse_limit(payload, "limit", 20, MAX_SUMMARY_LIMIT)?;
    let package = payload
        .get("package")
        .or_else(|| payload.get("packageName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(package) = &package {
        if package.chars().count() > 128 {
            return Err("package 最多 128 个字符".into());
        }
    }
    Ok(AppUsageQuery {
        since_hours,
        limit,
        package,
    })
}

pub(crate) fn parse_usage_events(payload: &Value) -> std::result::Result<UsageEventsQuery, String> {
    let days = parse_limit(payload, "days", 1, MAX_EVENT_DAYS)? as i64;
    let limit = parse_limit(payload, "limit", 100, MAX_EVENT_LIMIT)?;
    Ok(UsageEventsQuery { days, limit })
}

/// `since_hours` 优先；否则 `days`（1..31，默认 7）换算成小时，最后统一收口到 744h。
fn parse_since_hours(payload: &Value) -> std::result::Result<i64, String> {
    let hours = if let Some(raw) = payload.get("since_hours") {
        raw.as_i64()
            .ok_or_else(|| "since_hours 必须是整数".to_string())?
    } else {
        let days = payload
            .get("days")
            .map(|raw| {
                raw.as_i64()
                    .ok_or_else(|| "days 必须是整数".to_string())
            })
            .transpose()?
            .unwrap_or(7)
            .clamp(1, MAX_DAYS);
        days * 24
    };
    Ok(hours.clamp(1, MAX_SINCE_HOURS))
}

/// 缺省 / 下限 / 上限统一在这里；`limit` 与 `days` 共用。
fn parse_limit(
    payload: &Value,
    key: &str,
    default: i64,
    max: i64,
) -> std::result::Result<usize, String> {
    let value = payload
        .get(key)
        .map(|raw| {
            raw.as_i64()
                .ok_or_else(|| format!("{key} 必须是整数"))
        })
        .transpose()?
        .unwrap_or(default);
    Ok(value.clamp(1, max) as usize)
}

pub(crate) fn handle(
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    let parsed = match method {
        "get_app_usage" => parse_app_usage(payload).map(|_| ()),
        "get_usage_events" => parse_usage_events(payload).map(|_| ()),
        _ => {
            return Ok(ConnectedAppInvokeReply::err(
                app_id,
                method,
                "connected_app_unknown_method",
                format!("使用时间不支持方法 {method}"),
                None,
            ))
        }
    };
    match parsed {
        Ok(()) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unsupported",
            "使用时间只在 Android 设备上由 Kotlin UsageOps 执行",
            None,
        )),
        Err(message) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_bad_request",
            message,
            None,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_usage_defaults_to_seven_days_and_twenty_apps() {
        let parsed = parse_app_usage(&json!({})).unwrap();
        assert_eq!(parsed.since_hours, 168);
        assert_eq!(parsed.limit, 20);
        assert_eq!(parsed.package, None);
    }

    #[test]
    fn app_usage_clamps_since_hours_and_limit() {
        let parsed = parse_app_usage(&json!({ "since_hours": 999, "limit": 999 })).unwrap();
        assert_eq!(parsed.since_hours, MAX_SINCE_HOURS);
        assert_eq!(parsed.limit, MAX_SUMMARY_LIMIT as usize);

        let parsed = parse_app_usage(&json!({ "since_hours": 0, "limit": 0 })).unwrap();
        assert_eq!(parsed.since_hours, 1);
        assert_eq!(parsed.limit, 1);
    }

    #[test]
    fn app_usage_days_are_converted_and_capped() {
        let parsed = parse_app_usage(&json!({ "days": 3 })).unwrap();
        assert_eq!(parsed.since_hours, 72);

        let parsed = parse_app_usage(&json!({ "days": 31 })).unwrap();
        assert_eq!(parsed.since_hours, MAX_SINCE_HOURS);

        let parsed = parse_app_usage(&json!({ "days": 99 })).unwrap();
        assert_eq!(parsed.since_hours, MAX_SINCE_HOURS);
    }

    #[test]
    fn app_usage_supports_package_alias_and_trims() {
        let parsed = parse_app_usage(&json!({ "packageName": "  com.tencent.mm  " })).unwrap();
        assert_eq!(parsed.package.as_deref(), Some("com.tencent.mm"));

        let parsed = parse_app_usage(&json!({ "package": "   " })).unwrap();
        assert_eq!(parsed.package, None);
    }

    #[test]
    fn app_usage_rejects_bad_types_and_overlong_package() {
        assert!(parse_app_usage(&json!({ "since_hours": "168" })).is_err());
        assert!(parse_app_usage(&json!({ "days": 1.5 })).is_err());
        assert!(parse_app_usage(&json!({ "limit": "20" })).is_err());
        assert!(parse_app_usage(&json!({ "package": "x".repeat(129) })).is_err());
    }

    #[test]
    fn usage_events_defaults_and_caps() {
        let parsed = parse_usage_events(&json!({})).unwrap();
        assert_eq!(parsed.days, 1);
        assert_eq!(parsed.limit, 100);

        let parsed = parse_usage_events(&json!({ "days": 99, "limit": 999 })).unwrap();
        assert_eq!(parsed.days, MAX_EVENT_DAYS);
        assert_eq!(parsed.limit, MAX_EVENT_LIMIT as usize);

        let parsed = parse_usage_events(&json!({ "days": 0, "limit": 0 })).unwrap();
        assert_eq!(parsed.days, 1);
        assert_eq!(parsed.limit, 1);
    }

    #[test]
    fn unknown_method_is_rejected_before_parsing() {
        let reply = handle("usage", "delete_usage", &json!({})).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("connected_app_unknown_method")
        );
    }

    #[test]
    fn bad_payload_maps_to_bad_request() {
        let reply = handle("usage", "get_app_usage", &json!({ "limit": "x" })).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("connected_app_bad_request")
        );
    }
}
