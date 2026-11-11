//! 位置（Android，只读）。
//!
//! 真实执行在 Kotlin `LocationOps`。Rust 侧只做参数解析与上限校验：
//! `timeoutMs` 1000..15000（默认 8000），`highAccuracy` 默认 true。
//! **不反查地址、不联网、不记录轨迹。**

use serde_json::Value;

use crate::error::Result;

use super::super::models::ConnectedAppInvokeReply;

pub(crate) const MIN_TIMEOUT_MS: i64 = 1_000;
pub(crate) const MAX_TIMEOUT_MS: i64 = 15_000;
pub(crate) const DEFAULT_TIMEOUT_MS: i64 = 8_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CurrentLocationQuery {
    pub timeout_ms: i64,
    pub high_accuracy: bool,
}

pub(crate) fn parse_current(
    payload: &Value,
) -> std::result::Result<CurrentLocationQuery, String> {
    let timeout_raw = payload
        .get("timeoutMs")
        .or_else(|| payload.get("timeout_ms"));
    let timeout_ms = timeout_raw
        .map(|raw| {
            raw.as_i64()
                .ok_or_else(|| "timeoutMs 必须是整数".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

    let high_raw = payload
        .get("highAccuracy")
        .or_else(|| payload.get("high_accuracy"));
    let high_accuracy = high_raw
        .map(|raw| {
            raw.as_bool()
                .ok_or_else(|| "highAccuracy 必须是布尔值".to_string())
        })
        .transpose()?
        .unwrap_or(true);

    Ok(CurrentLocationQuery {
        timeout_ms,
        high_accuracy,
    })
}

pub(crate) fn handle(
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    let parsed = match method {
        "get_current_location" => parse_current(payload).map(|_| ()),
        "get_last_known_location" => Ok(()),
        _ => {
            return Ok(ConnectedAppInvokeReply::err(
                app_id,
                method,
                "connected_app_unknown_method",
                format!("位置不支持方法 {method}"),
                None,
            ))
        }
    };
    match parsed {
        Ok(()) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unsupported",
            "位置只在 Android 设备上由 Kotlin LocationOps 执行",
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
    fn current_defaults_to_eight_seconds_and_high_accuracy() {
        let parsed = parse_current(&json!({})).unwrap();
        assert_eq!(parsed.timeout_ms, DEFAULT_TIMEOUT_MS);
        assert!(parsed.high_accuracy);
    }

    #[test]
    fn current_clamps_timeout() {
        assert_eq!(
            parse_current(&json!({ "timeoutMs": 200 })).unwrap().timeout_ms,
            MIN_TIMEOUT_MS
        );
        assert_eq!(
            parse_current(&json!({ "timeout_ms": 1 })).unwrap().timeout_ms,
            MIN_TIMEOUT_MS
        );
        assert_eq!(
            parse_current(&json!({ "timeoutMs": 99_999 })).unwrap().timeout_ms,
            MAX_TIMEOUT_MS
        );
        assert_eq!(
            parse_current(&json!({ "timeoutMs": 5000 })).unwrap().timeout_ms,
            5000
        );
    }

    #[test]
    fn current_reads_both_camel_and_snake_keys() {
        let parsed = parse_current(&json!({ "highAccuracy": false })).unwrap();
        assert!(!parsed.high_accuracy);

        let parsed = parse_current(&json!({ "high_accuracy": false })).unwrap();
        assert!(!parsed.high_accuracy);
    }

    #[test]
    fn current_rejects_bad_types() {
        assert!(parse_current(&json!({ "timeoutMs": "8000" })).is_err());
        assert!(parse_current(&json!({ "highAccuracy": "true" })).is_err());
    }

    #[test]
    fn last_known_accepts_empty_payload_and_unknown_method_fails() {
        assert!(handle("location", "get_last_known_location", &json!({})).unwrap().ok == false);

        let reply = handle("location", "track_location", &json!({})).unwrap();
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("connected_app_unknown_method")
        );
    }
}
