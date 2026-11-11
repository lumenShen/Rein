//! 通讯录（Android）。真实执行在 Kotlin `ContactsOps`。
//!
//! Rust 侧职责（plan §1.2 / §13.1 / §6.5）：
//! - `validate`：纯 JSON 校验——query/姓名长度、一次一个联系人、phones/emails 各 ≤10、
//!   号码/邮箱长度、contactId 形态；可在任意 host 单测；
//! - `handle`：非 Android host 返回结构化错误，不假成功；Android 走 `android::invoke`；
//! - `status`：按 app 读取已刷新的 `state.json`（批量 status 仍走 `android::statuses`）。
//!
//! 写确认在 TS app 工具里弹；审计与写许可由 `connected_app_invoke` 统一处理。
//! 删除会同步到已登录账户、云端 raw contact 可能改不动——这是能力边界，不在这里假装成功。

use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::super::models::{ConnectedAppInvokeReply, ConnectedAppStatus};

const MAX_QUERY_CHARS: usize = 64;
const MAX_RESULTS: i64 = 50;
const MAX_NAME_CHARS: usize = 200;
const MAX_PHONE_CHARS: usize = 40;
const MAX_EMAIL_CHARS: usize = 120;
const MAX_ENTRIES: usize = 10;
const MAX_TYPE_CHARS: usize = 16;
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
    let spec = super::super::state::find("contacts").expect("contacts AppSpec 必须存在");
    super::super::android::status_for(app, spec, enabled, ai_intent, write_intent)
}

/// 执行前的纯 JSON 校验。
pub(crate) fn validate(method: &str, payload: &Value) -> std::result::Result<(), Invalid> {
    match method {
        "search_contacts" => validate_search(payload),
        "get_contact" => {
            id_field(payload, "contactId")?;
            Ok(())
        }
        "create_contact" => validate_create(payload),
        "update_contact" => validate_update(payload),
        "delete_contact" => {
            id_field(payload, "contactId")?;
            Ok(())
        }
        _ => Err(invalid(
            "connected_app_unknown_method",
            format!("通讯录不支持方法 {method}"),
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
            "通讯录能力只在 Android 上执行（真实调用由 Kotlin ContactsOps 经 ContactsContract 完成）",
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

fn validate_search(payload: &Value) -> std::result::Result<(), Invalid> {
    required_str(payload, "query", 1, MAX_QUERY_CHARS)?;
    optional_int(payload, "limit", 1, MAX_RESULTS)?;
    Ok(())
}

fn validate_create(payload: &Value) -> std::result::Result<(), Invalid> {
    required_str(payload, "name", 1, MAX_NAME_CHARS)?;
    optional_entries(payload, "phones", "number", MAX_PHONE_CHARS)?;
    optional_entries(payload, "emails", "address", MAX_EMAIL_CHARS)?;
    Ok(())
}

fn validate_update(payload: &Value) -> std::result::Result<(), Invalid> {
    id_field(payload, "contactId")?;
    let mut has_field = false;
    if payload.get("name").is_some() {
        has_field = true;
        required_str(payload, "name", 1, MAX_NAME_CHARS)?;
    }
    if payload.get("phones").is_some() {
        has_field = true;
        optional_entries(payload, "phones", "number", MAX_PHONE_CHARS)?;
    }
    if payload.get("emails").is_some() {
        has_field = true;
        optional_entries(payload, "emails", "address", MAX_EMAIL_CHARS)?;
    }
    if !has_field {
        return Err(bad("至少提供一个要修改的字段（name/phones/emails）"));
    }
    Ok(())
}

/// 校验 `phones` / `emails` 数组：≤10 项、每项是对象、必填字段是字符串且有长度上限。
fn optional_entries(
    payload: &Value,
    key: &str,
    field: &str,
    max_field_chars: usize,
) -> std::result::Result<(), Invalid> {
    let Some(value) = payload.get(key) else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let array = value
        .as_array()
        .ok_or_else(|| bad(format!("{key} 必须是数组")))?;
    if array.len() > MAX_ENTRIES {
        return Err(bad(format!("{key} 最多 {MAX_ENTRIES} 项")));
    }
    for (index, entry) in array.iter().enumerate() {
        let object = entry
            .as_object()
            .ok_or_else(|| bad(format!("{key}[{index}] 必须是对象")))?;
        match object.get(field) {
            Some(Value::String(text)) => {
                let len = text.chars().count();
                if len == 0 || len > max_field_chars {
                    return Err(bad(format!(
                        "{key}[{index}].{field} 长度必须在 1..{max_field_chars} 字之间"
                    )));
                }
            }
            _ => return Err(bad(format!("{key}[{index}].{field} 必填且必须是字符串"))),
        }
        if let Some(kind) = object.get("type") {
            if !kind.is_null() {
                let text = kind
                    .as_str()
                    .ok_or_else(|| bad(format!("{key}[{index}].type 必须是字符串")))?;
                if text.chars().count() > MAX_TYPE_CHARS {
                    return Err(bad(format!(
                        "{key}[{index}].type 不能超过 {MAX_TYPE_CHARS} 字"
                    )));
                }
            }
        }
    }
    Ok(())
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
    fn search_requires_query() {
        assert_eq!(
            validate("search_contacts", &json!({})).unwrap_err().code,
            "connected_app_bad_request"
        );
        assert!(validate("search_contacts", &json!({ "query": "张" })).is_ok());
        assert!(validate("search_contacts", &json!({ "query": "x".repeat(65) })).is_err());
        assert!(validate("search_contacts", &json!({ "query": "张", "limit": 51 })).is_err());
    }

    #[test]
    fn create_requires_name_and_caps_arrays() {
        assert!(validate("create_contact", &json!({ "name": "张三" })).is_ok());
        assert!(validate("create_contact", &json!({})).is_err());
        let phones: Vec<Value> = (0..11)
            .map(|i| json!({ "number": format!("1380000000{i}") }))
            .collect();
        assert!(validate(
            "create_contact",
            &json!({ "name": "张三", "phones": phones })
        )
        .is_err());
        assert!(validate(
            "create_contact",
            &json!({ "name": "张三", "phones": [{ "number": "" }] })
        )
        .is_err());
        assert!(validate(
            "create_contact",
            &json!({ "name": "张三", "emails": [{ "address": "a@b.com", "type": "home" }] })
        )
        .is_ok());
    }

    #[test]
    fn update_requires_a_field() {
        assert!(validate("update_contact", &json!({ "contactId": "1" })).is_err());
        assert!(validate(
            "update_contact",
            &json!({ "contactId": "1", "name": "李四" })
        )
        .is_ok());
        assert!(validate("update_contact", &json!({ "contactId": "1", "phones": [] })).is_ok());
    }

    #[test]
    fn ids_must_be_positive_numbers() {
        assert!(validate("get_contact", &json!({ "contactId": "0" })).is_err());
        assert!(validate("get_contact", &json!({ "contactId": "abc" })).is_err());
        assert!(validate("get_contact", &json!({ "contactId": 12 })).is_ok());
        assert!(validate("delete_contact", &json!({ "contactId": "12" })).is_ok());
    }

    #[test]
    fn entry_field_limits() {
        let long_number = "1".repeat(MAX_PHONE_CHARS + 1);
        assert!(validate(
            "create_contact",
            &json!({ "name": "张三", "phones": [{ "number": long_number }] })
        )
        .is_err());
        let long_email = format!("{}@example.com", "a".repeat(MAX_EMAIL_CHARS));
        assert!(validate(
            "create_contact",
            &json!({ "name": "张三", "emails": [{ "address": long_email }] })
        )
        .is_err());
        assert!(validate(
            "create_contact",
            &json!({ "name": "张三", "phones": [{ "number": "138", "type": "x".repeat(17) }] })
        )
        .is_err());
    }

    #[test]
    fn unknown_method_is_rejected() {
        let err = validate("wipe_contacts", &json!({})).unwrap_err();
        assert_eq!(err.code, "connected_app_unknown_method");
    }

    #[test]
    fn handle_never_returns_fake_success() {
        let reply = handle("contacts", "search_contacts", &json!({})).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().unwrap().code,
            "connected_app_bad_request"
        );

        let reply = handle("contacts", "search_contacts", &json!({ "query": "张" })).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().unwrap().code,
            "connected_app_unsupported"
        );
    }
}
