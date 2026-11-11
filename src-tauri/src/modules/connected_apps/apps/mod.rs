//! app id → handler 的固定 match（不动态分发）。
//!
//! Android 8 个 app 的真实执行在 Kotlin（`android.rs` 只负责 JNI/文件协议）；
//! 这里的 `validate_android` 在 JNI 之前做同一套参数/上限校验，`handle` 给
//! 非 Android 的桌面文件/终端提供真实入口（Android app 误走这里时返回结构化错误）。

pub(crate) mod alarm;
pub(crate) mod calendar;
pub(crate) mod contacts;
pub(crate) mod desktop_files;
pub(crate) mod location;
pub(crate) mod notification;
pub(crate) mod phone_files;
pub(crate) mod sms;
pub(crate) mod terminal;
pub(crate) mod usage;

use serde_json::Value;
use tauri::AppHandle;

use crate::error::{ReinError, Result};

use super::models::ConnectedAppInvokeReply;

/// 固定 match：新增 app 必须同时补 `state::APP_SPECS` 与这里，避免「工具可见但不可达」。
pub(crate) fn handle(
    app: &AppHandle,
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    match app_id {
        "alarm" => alarm::handle(app_id, method, payload),
        "usage" => usage::handle(app_id, method, payload),
        "calendar" => calendar::handle(app_id, method, payload),
        "contacts" => contacts::handle(app_id, method, payload),
        "filesystem" => phone_files::handle(app_id, method, payload),
        "location" => location::handle(app_id, method, payload),
        "notification" => notification::handle(app_id, method, payload),
        "sms" => sms::handle(app_id, method, payload),
        "win-desktop" | "win-documents" | "win-downloads" | "win-local" | "mac-desktop"
        | "linux-desktop" | "linux-documents" => {
            super::desktop::invoke(app, app_id, method, payload)
        }
        "win-terminal" | "mac-terminal" => terminal::handle(app, app_id, method, payload),
        _ => Err(ReinError::coded(
            "connected_app_bad_request",
            format!("未知连接应用：{app_id}"),
        )),
    }
}

/// Android 分支在交给 JNI 之前先跑 Rust 侧纯校验（与 Kotlin 同口径）。
///
/// 返回 `Some(reply)` = 参数非法，直接回给调用方；`None` = 交给 `android::invoke`。
pub(crate) fn validate_android(
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Option<ConnectedAppInvokeReply> {
    let invalid = |code: &str, message: String, action: Option<&str>| {
        Some(ConnectedAppInvokeReply::err(
            app_id, method, code, message, action,
        ))
    };

    match app_id {
        "alarm" => alarm::validate(method, payload)
            .err()
            .map(|e| invalid(e.code, e.message, None))
            .unwrap_or(None),
        "calendar" => calendar::validate(method, payload)
            .err()
            .map(|e| invalid(e.code, e.message, None))
            .unwrap_or(None),
        "contacts" => contacts::validate(method, payload)
            .err()
            .map(|e| invalid(e.code, e.message, None))
            .unwrap_or(None),
        "sms" => sms::validate(method, payload)
            .err()
            .map(|e| invalid(e.code, e.message, None))
            .unwrap_or(None),
        "filesystem" => phone_files::validate(method, payload)
            .err()
            .map(|e| invalid(e.code, e.message, e.action))
            .unwrap_or(None),
        "usage" => {
            let parsed = match method {
                "get_app_usage" => usage::parse_app_usage(payload).map(|_| ()),
                "get_usage_events" => usage::parse_usage_events(payload).map(|_| ()),
                _ => return None,
            };
            parsed
                .err()
                .map(|message| invalid("connected_app_bad_request", message, None))
                .unwrap_or(None)
        }
        "location" => {
            if method != "get_current_location" {
                return None;
            }
            location::parse_current(payload)
                .err()
                .map(|message| invalid("connected_app_bad_request", message, None))
                .unwrap_or(None)
        }
        "notification" => {
            let parsed = match method {
                "list_recent_notifications" => notification::parse_list(payload).map(|_| ()),
                "dismiss_notification" => notification::parse_dismiss(payload).map(|_| ()),
                "dismiss_all_notifications" => Ok(()),
                _ => return None,
            };
            parsed
                .err()
                .map(|message| invalid("connected_app_bad_request", message, None))
                .unwrap_or(None)
        }
        _ => None,
    }
}

pub(crate) fn is_android_app(app_id: &str) -> bool {
    matches!(
        app_id,
        "alarm" | "usage" | "calendar" | "contacts" | "filesystem" | "location" | "notification" | "sms"
    )
}
