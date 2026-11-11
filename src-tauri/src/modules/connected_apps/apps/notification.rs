//! 通知（Android）：读取 + 仅清除。
//!
//! 真实执行在 Kotlin `NotificationOps` / `ReinNotificationListenerService`。
//! Rust 侧保留参数解析与上限校验（与 Kotlin 同口径），并在 host 上单测：
//! `limit ≤ 50`、`app` 过滤 ≤128 字符、`since` 支持 ISO-8601 或毫秒时间戳、
//! `dismiss_notification.key` 1..256 字符。**不支持代发/回复/修改通知内容。**

use serde_json::Value;

use crate::error::Result;

use super::super::models::ConnectedAppInvokeReply;

pub(crate) const MAX_LIST_LIMIT: i64 = 50;
pub(crate) const MAX_FILTER_CHARS: usize = 128;
pub(crate) const MAX_QUERY_CHARS: usize = 64;
pub(crate) const MAX_KEY_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NotificationListQuery {
    pub limit: usize,
    /// 包名 / 应用名子串（Kotlin 侧做 contains，忽略大小写）。
    pub app: Option<String>,
    /// 标题/正文/应用/包名关键词（Kotlin 侧做 contains，忽略大小写）。
    pub query: Option<String>,
    /// 只返回 `postedAt >= since_ms` 的通知；`None` = 不限。
    pub since_ms: Option<i64>,
}

pub(crate) fn parse_list(
    payload: &Value,
) -> std::result::Result<NotificationListQuery, String> {
    let limit = payload
        .get("limit")
        .map(|raw| {
            raw.as_i64()
                .ok_or_else(|| "limit 必须是整数".to_string())
        })
        .transpose()?
        .unwrap_or(20)
        .clamp(1, MAX_LIST_LIMIT) as usize;

    let app = payload
        .get("app")
        .or_else(|| payload.get("package"))
        .or_else(|| payload.get("packageName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(app) = &app {
        if app.chars().count() > MAX_FILTER_CHARS {
            return Err(format!("app 过滤条件最多 {MAX_FILTER_CHARS} 个字符"));
        }
    }

    let query = payload
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(query) = &query {
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(format!("query 最多 {MAX_QUERY_CHARS} 个字符"));
        }
    }

    let since_ms = parse_since(payload)?;
    Ok(NotificationListQuery {
        limit,
        app,
        query,
        since_ms,
    })
}

pub(crate) fn parse_dismiss(payload: &Value) -> std::result::Result<String, String> {
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let len = key.chars().count();
    if len == 0 || len > MAX_KEY_CHARS {
        return Err(format!(
            "key 必须为 1..{MAX_KEY_CHARS} 个字符，且来自 list_recent_notifications"
        ));
    }
    Ok(key.to_string())
}

/// 接受 ISO-8601（`Z` / `+08:00` / 本地无偏移不在这里支持）或毫秒时间戳。
fn parse_since(payload: &Value) -> std::result::Result<Option<i64>, String> {
    let Some(raw) = payload.get("since") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    if let Some(millis) = raw.as_i64() {
        if millis < 0 {
            return Err("since 不能为负数".into());
        }
        return Ok(Some(millis));
    }
    if let Some(text) = raw.as_str() {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        let parsed = chrono::DateTime::parse_from_rfc3339(text)
            .map_err(|_| "since 必须是 ISO-8601 时间或毫秒时间戳".to_string())?;
        return Ok(Some(parsed.timestamp_millis()));
    }
    Err("since 必须是 ISO-8601 时间或毫秒时间戳".into())
}

pub(crate) fn handle(
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    let parsed = match method {
        "list_recent_notifications" => parse_list(payload).map(|_| ()),
        "dismiss_notification" => parse_dismiss(payload).map(|_| ()),
        "dismiss_all_notifications" => Ok(()),
        _ => {
            return Ok(ConnectedAppInvokeReply::err(
                app_id,
                method,
                "connected_app_unknown_method",
                format!("通知不支持方法 {method}"),
                None,
            ))
        }
    };
    match parsed {
        Ok(()) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unsupported",
            "通知只在 Android 设备上由 Kotlin NotificationOps 执行",
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
    fn list_defaults_to_twenty_without_filter() {
        let parsed = parse_list(&json!({})).unwrap();
        assert_eq!(parsed.limit, 20);
        assert_eq!(parsed.app, None);
        assert_eq!(parsed.query, None);
        assert_eq!(parsed.since_ms, None);
    }

    #[test]
    fn list_query_is_trimmed_and_bounded() {
        let parsed = parse_list(&json!({ "query": "  吃饭  " })).unwrap();
        assert_eq!(parsed.query.as_deref(), Some("吃饭"));
        assert_eq!(parse_list(&json!({ "query": "   " })).unwrap().query, None);
        assert!(parse_list(&json!({ "query": "x".repeat(65) })).is_err());
    }

    #[test]
    fn list_clamps_limit_and_supports_app_aliases() {
        let parsed = parse_list(&json!({ "limit": 999, "app": " 微信 " })).unwrap();
        assert_eq!(parsed.limit, MAX_LIST_LIMIT as usize);
        assert_eq!(parsed.app.as_deref(), Some("微信"));

        let parsed = parse_list(&json!({ "packageName": "com.tencent.mm" })).unwrap();
        assert_eq!(parsed.app.as_deref(), Some("com.tencent.mm"));

        let parsed = parse_list(&json!({ "limit": 0 })).unwrap();
        assert_eq!(parsed.limit, 1);
    }

    #[test]
    fn list_rejects_overlong_filter_and_bad_limit() {
        assert!(parse_list(&json!({ "app": "x".repeat(129) })).is_err());
        assert!(parse_list(&json!({ "limit": "20" })).is_err());
    }

    #[test]
    fn since_accepts_iso_with_offset_and_z() {
        let plus8 = parse_list(&json!({ "since": "2026-11-10T12:00:00+08:00" })).unwrap();
        let utc = parse_list(&json!({ "since": "2026-11-10T04:00:00Z" })).unwrap();
        assert_eq!(plus8.since_ms, utc.since_ms);
        assert!(plus8.since_ms.unwrap() > 0);
    }

    #[test]
    fn since_accepts_epoch_millis_and_rejects_invalid() {
        let parsed = parse_list(&json!({ "since": 1762747200000i64 })).unwrap();
        assert_eq!(parsed.since_ms, Some(1762747200000));

        assert!(parse_list(&json!({ "since": "昨天" })).is_err());
        assert!(parse_list(&json!({ "since": -1 })).is_err());
        assert!(parse_list(&json!({ "since": true })).is_err());
        assert_eq!(parse_list(&json!({ "since": null })).unwrap().since_ms, None);
    }

    #[test]
    fn dismiss_key_is_required_and_bounded() {
        assert_eq!(parse_dismiss(&json!({ "key": " mock:1 " })).unwrap(), "mock:1");
        assert!(parse_dismiss(&json!({})).is_err());
        assert!(parse_dismiss(&json!({ "key": "   " })).is_err());
        assert!(parse_dismiss(&json!({ "key": "x".repeat(257) })).is_err());
        assert!(parse_dismiss(&json!({ "key": 1 })).is_err());
    }

    #[test]
    fn unknown_method_is_rejected() {
        let reply = handle("notification", "reply_notification", &json!({})).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("connected_app_unknown_method")
        );
    }
}
