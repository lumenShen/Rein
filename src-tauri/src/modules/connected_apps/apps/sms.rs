//! 短信（Android）。真实执行在 Kotlin `SmsOps`。
//!
//! Rust 侧职责（plan §1.2 / §13.2）：
//! - `validate`：query 1..64、threadId/address 至少一个、发送单收件人且 body 1..2000、
//!   列表上限；可在任意 host 单测；
//! - `handle`：非 Android host 返回结构化错误，不假成功；Android 走 `android::invoke`；
//! - `status`：按 app 读取已刷新的 `state.json`（批量 status 仍走 `android::statuses`）。
//!
//! 只读 + 发送：不做已读/删除/MMS/SIM 选择/送达回执。发送前确认在 TS app 工具里弹。

use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::super::models::{ConnectedAppInvokeReply, ConnectedAppStatus};

const MAX_THREADS: i64 = 50;
const MAX_MESSAGES: i64 = 100;
const MAX_SEARCH: i64 = 50;
const MAX_QUERY_CHARS: usize = 64;
const MAX_ADDRESS_CHARS: usize = 40;
const MAX_BODY_CHARS: usize = 2_000;
const MAX_THREAD_ID_CHARS: usize = 64;

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
    let spec = super::super::state::find("sms").expect("sms AppSpec 必须存在");
    super::super::android::status_for(app, spec, enabled, ai_intent, write_intent)
}

/// 执行前的纯 JSON 校验。
pub(crate) fn validate(method: &str, payload: &Value) -> std::result::Result<(), Invalid> {
    match method {
        "list_sms_threads" => {
            optional_int(payload, "limit", 1, MAX_THREADS)?;
            Ok(())
        }
        "list_sms_messages" => validate_list_messages(payload),
        "search_sms" => validate_search(payload),
        "send_sms" => validate_send(payload),
        _ => Err(invalid(
            "connected_app_unknown_method",
            format!("短信不支持方法 {method}"),
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
            "短信能力只在 Android 上执行（真实调用由 Kotlin SmsOps 经 Telephony provider / SmsManager 完成）",
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

fn validate_list_messages(payload: &Value) -> std::result::Result<(), Invalid> {
    let thread_id = optional_str(payload, "threadId", MAX_THREAD_ID_CHARS)?;
    let address = optional_str(payload, "address", MAX_ADDRESS_CHARS)?;
    if thread_id.is_none() && address.is_none() {
        return Err(bad("threadId 或 address 至少提供一个"));
    }
    if let Some(id) = thread_id {
        if !all_digits(id) {
            return Err(bad("threadId 必须是数字"));
        }
    }
    optional_int(payload, "limit", 1, MAX_MESSAGES)?;
    Ok(())
}

fn validate_search(payload: &Value) -> std::result::Result<(), Invalid> {
    required_str(payload, "query", 1, MAX_QUERY_CHARS)?;
    optional_int(payload, "limit", 1, MAX_SEARCH)?;
    Ok(())
}

fn validate_send(payload: &Value) -> std::result::Result<(), Invalid> {
    let to = required_str(payload, "to", 1, MAX_ADDRESS_CHARS)?;
    if to.contains(',') || to.contains(';') {
        return Err(bad("to 只能是单个收件人（不要用逗号/分号分隔）"));
    }
    let body = required_str(payload, "body", 1, MAX_BODY_CHARS)?;
    // 空字符串会被 required_str 的长度检查拒绝；这里再挡一层纯空白，避免发送空短信。
    if body.trim().is_empty() {
        return Err(bad("body 不能只有空白"));
    }
    Ok(())
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

fn all_digits(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_threads_limits() {
        assert!(validate("list_sms_threads", &json!({})).is_ok());
        assert!(validate("list_sms_threads", &json!({ "limit": 50 })).is_ok());
        assert!(validate("list_sms_threads", &json!({ "limit": 51 })).is_err());
    }

    #[test]
    fn list_messages_requires_thread_or_address() {
        assert!(validate("list_sms_messages", &json!({})).is_err());
        assert!(validate("list_sms_messages", &json!({ "threadId": "10" })).is_ok());
        assert!(validate("list_sms_messages", &json!({ "address": "10086" })).is_ok());
        assert!(validate("list_sms_messages", &json!({ "threadId": "abc" })).is_err());
        assert!(validate(
            "list_sms_messages",
            &json!({ "threadId": "10", "limit": 101 })
        )
        .is_err());
    }

    #[test]
    fn search_query_limits() {
        assert!(validate("search_sms", &json!({ "query": "流量" })).is_ok());
        assert!(validate("search_sms", &json!({})).is_err());
        assert!(validate("search_sms", &json!({ "query": "x".repeat(65) })).is_err());
        assert!(validate("search_sms", &json!({ "query": "流量", "limit": 51 })).is_err());
    }

    #[test]
    fn send_requires_single_recipient_and_body() {
        assert!(validate("send_sms", &json!({ "to": "10086", "body": "查询流量" })).is_ok());
        assert!(validate("send_sms", &json!({ "to": "10086" })).is_err());
        assert!(validate("send_sms", &json!({ "to": "", "body": "hi" })).is_err());
        assert!(validate("send_sms", &json!({ "to": "10086,10010", "body": "hi" })).is_err());
        assert!(validate("send_sms", &json!({ "to": "10086", "body": "   " })).is_err());
        assert!(validate(
            "send_sms",
            &json!({ "to": "10086", "body": "x".repeat(MAX_BODY_CHARS + 1) })
        )
        .is_err());
    }

    #[test]
    fn unknown_method_is_rejected() {
        let err = validate("delete_all_sms", &json!({})).unwrap_err();
        assert_eq!(err.code, "connected_app_unknown_method");
    }

    #[test]
    fn handle_never_returns_fake_success() {
        let reply = handle("sms", "send_sms", &json!({ "to": "10086" })).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().unwrap().code,
            "connected_app_bad_request"
        );

        let reply = handle("sms", "list_sms_threads", &json!({})).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().unwrap().code,
            "connected_app_unsupported"
        );
    }
}
