//! 7 个桌面文件 app 的 handle：根解析 + method 分发 + 参数上限。
//!
//! `payload.root` 是 opaque id（`<appId>:<rootId>`），只通过 `paths::resolve_root_id`
//! 在根表里查真实路径；任何 `PathBuf::from(payload.root)` 都不允许。
//!
//! 写方法在这里先检查根的 native 可写性（`connected_app_write_not_allowed`），
//! 用户「允许写入」的意图由前端 store + 确认层保证（见交付报告的缺口）。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::error::{ReinError, Result};

use super::super::models::ConnectedAppInvokeReply;
use super::super::{fs_ops, paths};

pub(crate) fn is_desktop_file_app(id: &str) -> bool {
    paths::is_desktop_file_app(id)
}

fn bad_request(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_bad_request", message)
}

fn no_root(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_no_root", message)
}

fn write_denied(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_write_not_allowed", message)
}

fn reply(app_id: &str, method: &str, result: Result<Value>) -> ConnectedAppInvokeReply {
    match result {
        Ok(data) => ConnectedAppInvokeReply::ok(app_id, method, data),
        Err(e) => {
            let action = if e.code() == "connected_app_no_root" {
                Some("folder")
            } else {
                None
            };
            ConnectedAppInvokeReply::err(app_id, method, e.code(), e.to_string(), action)
        }
    }
}

fn roots_json(roots: &[paths::RootEntry]) -> Value {
    json!({
        "roots": roots
            .iter()
            .map(|r| json!({
                "id": r.id,
                "label": r.label,
                "path": r.display,
                "writable": r.writable,
            }))
            .collect::<Vec<_>>(),
    })
}

fn with_root(mut value: Value, root_id: &str) -> Value {
    if let Value::Object(map) = &mut value {
        map.insert("root".to_string(), Value::String(root_id.to_string()));
    }
    value
}

fn string_arg(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.to_string())
}

fn required_string(payload: &Value, key: &str, max_chars: usize) -> Result<String> {
    let raw = string_arg(payload, key).unwrap_or_default();
    if raw.is_empty() {
        return Err(bad_request(format!("缺少参数 {key}")));
    }
    if raw.chars().count() > max_chars {
        return Err(bad_request(format!("参数 {key} 超过 {max_chars} 字符上限")));
    }
    Ok(raw)
}

fn int_arg(payload: &Value, key: &str, default: usize, min: usize, max: usize) -> usize {
    let value = payload.get(key).and_then(|v| {
        if let Some(n) = v.as_u64() {
            Some(n as i64)
        } else if let Some(n) = v.as_i64() {
            Some(n)
        } else if let Some(n) = v.as_f64() {
            Some(n as i64)
        } else {
            v.as_str().and_then(|s| s.trim().parse::<i64>().ok())
        }
    });
    value
        .map(|n| n.clamp(min as i64, max as i64) as usize)
        .unwrap_or(default)
}

fn bool_arg(payload: &Value, key: &str, default: bool) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn resolve_root(app: &AppHandle, app_id: &str, payload: &Value) -> Result<paths::RootEntry> {
    let root_id = payload
        .get("root")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if root_id.is_empty() {
        return Err(no_root(
            "缺少 root；请先调用 list_desktop_roots，并从结果里选一个根 id",
        ));
    }
    paths::resolve_root_id(app, app_id, root_id)
}

fn require_writable(root: &paths::RootEntry) -> Result<()> {
    if !root.writable {
        return Err(write_denied(
            "该文件夹当前不可写；请换一个可写的根或检查系统权限",
        ));
    }
    Ok(())
}

/// 统一的 method 分发。未知 method 由 `commands` 的白名单先行拦截，这里再兜一层。
pub(crate) fn handle_with_app(
    app: &AppHandle,
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    if !paths::is_desktop_file_app(app_id) {
        return Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_bad_request",
            format!("「{app_id}」不是桌面文件应用"),
            None,
        ));
    }

    match method {
        "files_roots" => Ok(reply(
            app_id,
            method,
            paths::roots_for(app, app_id).map(|roots| roots_json(&roots)),
        )),
        "files_list" => Ok(reply(
            app_id,
            method,
            (|| {
                let root = resolve_root(app, app_id, payload)?;
                let path = string_arg(payload, "path").unwrap_or_default();
                let limit = int_arg(payload, "limit", 100, 1, 200);
                let value = fs_ops::list(&root.path, &path, limit)?;
                Ok(with_root(value, &root.id))
            })(),
        )),
        "read_desktop_file" => Ok(reply(
            app_id,
            method,
            (|| {
                let root = resolve_root(app, app_id, payload)?;
                let path = required_string(payload, "path", 512)?;
                let offset = int_arg(payload, "offset", 0, 0, usize::MAX / 2);
                let max_chars = int_arg(
                    payload,
                    "maxChars",
                    fs_ops::DEFAULT_READ_CHARS,
                    1,
                    fs_ops::MAX_READ_CHARS,
                );
                let value = fs_ops::read_text(&root.path, &path, offset, max_chars)?;
                Ok(with_root(value, &root.id))
            })(),
        )),
        "search_desktop_files" => Ok(reply(
            app_id,
            method,
            (|| {
                let root = resolve_root(app, app_id, payload)?;
                let query = required_string(payload, "query", 64)?;
                let path = string_arg(payload, "path").unwrap_or_default();
                let max_depth = int_arg(payload, "maxDepth", fs_ops::MAX_SEARCH_DEPTH, 1, 4);
                let limit = int_arg(payload, "limit", 20, 1, 50);
                let value = fs_ops::search(&root.path, &path, &query, max_depth, limit)?;
                Ok(with_root(value, &root.id))
            })(),
        )),
        "write_desktop_file" => Ok(reply(
            app_id,
            method,
            (|| {
                let root = resolve_root(app, app_id, payload)?;
                require_writable(&root)?;
                let path = required_string(payload, "path", 512)?;
                let content = string_arg(payload, "content")
                    .ok_or_else(|| bad_request("缺少参数 content"))?;
                if content.len() > fs_ops::MAX_WRITE_BYTES {
                    return Err(ReinError::coded(
                        "connected_app_too_large",
                        "写入内容超过 1MB 上限",
                    ));
                }
                let overwrite = bool_arg(payload, "overwrite", false);
                let value = fs_ops::write_text(&root.path, &path, &content, overwrite)?;
                Ok(with_root(value, &root.id))
            })(),
        )),
        "create_desktop_folder" => Ok(reply(
            app_id,
            method,
            (|| {
                let root = resolve_root(app, app_id, payload)?;
                require_writable(&root)?;
                let path = required_string(payload, "path", 512)?;
                let value = fs_ops::create_folder(&root.path, &path)?;
                Ok(with_root(value, &root.id))
            })(),
        )),
        "delete_desktop_file" => Ok(reply(
            app_id,
            method,
            (|| {
                let root = resolve_root(app, app_id, payload)?;
                require_writable(&root)?;
                let path = required_string(payload, "path", 512)?;
                let value = fs_ops::delete(&root.path, &path)?;
                Ok(with_root(value, &root.id))
            })(),
        )),
        "rename_desktop_file" => Ok(reply(
            app_id,
            method,
            (|| {
                let root = resolve_root(app, app_id, payload)?;
                require_writable(&root)?;
                let from = required_string(payload, "from", 512)?;
                let to = required_string(payload, "to", 512)?;
                let value = fs_ops::rename(&root.path, &from, &to)?;
                Ok(with_root(value, &root.id))
            })(),
        )),
        _ => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unknown_method",
            format!("桌面文件应用不支持方法 {method}"),
            None,
        )),
    }
}
