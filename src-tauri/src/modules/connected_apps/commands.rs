//! 连接本机应用 · 四个 Tauri 命令。
//!
//! 三向同步（硬约束）：本文件新增/改名的命令必须同时登记到
//! `src-tauri/src/lib.rs` 的 `generate_handler!`、`src/services/connectedAppService.ts`
//! 的 `invoke('...')`、`src/mock/server.ts` 的顶层 `case`。
//!
//! 语义边界：
//! - `status` 只读，17 条固定顺序；health 不在此列。
//! - `request` 只拉起系统 UI/选择器，不写连接同意。
//! - `invoke` 是 AI 工具唯一入口；可预期失败走 `Ok({ok:false,error})`，
//!   并在执行前强制校验 connected / AI 意图 / 写入意图。
//! - `update` 只写 `app_meta` 的连接同意、AI/写入意图与 win-local 根，不弹系统 UI。

use std::time::Instant;

use serde_json::Value;
use tauri::{Manager, State};

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::audit::{self, AuditEntry};
use super::models::{
    ConnectedAppInvokeReply, ConnectedAppPatch, ConnectedAppRequestResult, ConnectedAppStatus,
    ConnectedAppsSnapshot,
};
use super::state as spec_state;
use super::store;
use super::{android, apps, desktop, MAX_IPC_PAYLOAD_BYTES};

const REQUEST_MODES: &[&str] = &[
    "permissions",
    "permissions_write",
    "usage_access",
    "notification_access",
    "folder",
    "settings",
];

fn spec_or_err(app_id: &str) -> Result<&'static spec_state::AppSpec> {
    spec_state::find(app_id).ok_or_else(|| {
        ReinError::coded(
            "connected_app_unsupported",
            format!("未知连接应用：{app_id}"),
        )
    })
}

fn ensure_platform(spec: &spec_state::AppSpec) -> Result<()> {
    if spec.platform == spec_state::current_platform() {
        Ok(())
    } else {
        Err(ReinError::coded(
            "connected_app_unsupported",
            format!("「{}」只能在 {} 上使用", spec.title, spec.platform),
        ))
    }
}

fn log_update(app: &tauri::AppHandle, app_id: &str, ok: bool, code: Option<String>, summary: String) {
    audit::write(
        app,
        &AuditEntry {
            at: audit::now_iso(),
            app: app_id.to_string(),
            method: "update".to_string(),
            kind: "control".to_string(),
            ok,
            code,
            decision: if ok { "allowed" } else { "error" }.to_string(),
            duration_ms: 0,
            summary,
        },
    );
}

/// 前置门禁拒绝也落一行审计：未连接 / 未允许 AI / 未允许写入同样是「拒绝执行」，
/// 不能因为没进执行层就从审计里消失（docs §4.2）。
fn gate_denied(
    app: &tauri::AppHandle,
    app_id: &str,
    method: &str,
    kind: spec_state::MethodKind,
    code: &str,
    message: String,
    action: Option<&str>,
) -> ConnectedAppInvokeReply {
    audit::write(
        app,
        &AuditEntry {
            at: audit::now_iso(),
            app: app_id.to_string(),
            method: method.to_string(),
            kind: match kind {
                spec_state::MethodKind::Read => "read",
                spec_state::MethodKind::Write => "write",
            }
            .to_string(),
            ok: false,
            code: Some(code.to_string()),
            decision: "denied".to_string(),
            duration_ms: 0,
            summary: format!("gate={code}"),
        },
    );
    ConnectedAppInvokeReply::err(app_id, method, code, message, action)
}

/// 17 个原生 app 的状态快照（health 走 `health_sync_status`）。
#[tauri::command]
pub async fn connected_app_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ConnectedAppsSnapshot> {
    let (enabled, ai, write) = {
        let conn = state.db.lock();
        (
            store::enabled_map(&conn),
            store::ai_map(&conn),
            store::write_map(&conn),
        )
    };
    let (apps, refresh_pending) = if cfg!(target_os = "android") {
        android::statuses(&app, &enabled, &ai, &write).await?
    } else {
        (desktop::statuses(&app, &enabled, &ai, &write), false)
    };
    // 本轮 refresh 没在 500ms 内写盘时也标 refreshing，避免把上一轮 state 当最新。
    let refreshing = refresh_pending || apps.iter().any(|a| a.availability == "unknown");
    Ok(ConnectedAppsSnapshot {
        platform: spec_state::current_platform().to_string(),
        mock: false,
        refreshing: if refreshing { Some(true) } else { None },
        apps,
    })
}

/// 拉起系统授权页 / SAF / 文件夹选择器；不写连接同意。
#[tauri::command]
pub async fn connected_app_request(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    app_id: String,
    mode: String,
) -> Result<ConnectedAppRequestResult> {
    let spec = spec_or_err(&app_id)?;
    ensure_platform(spec)?;
    if !REQUEST_MODES.contains(&mode.as_str()) {
        return Err(ReinError::coded(
            "connected_app_bad_request",
            format!("未知授权模式：{mode}"),
        ));
    }
    let result = if cfg!(target_os = "android") {
        android::request(&app, spec, &mode).await?
    } else {
        desktop::request(&app, spec, &mode).await?
    };
    audit::write(
        &app,
        &AuditEntry {
            at: audit::now_iso(),
            app: app_id,
            method: format!("request:{mode}"),
            kind: "control".to_string(),
            ok: result.opened,
            code: None,
            decision: if result.opened { "allowed" } else { "denied" }.to_string(),
            duration_ms: 0,
            summary: format!("mode={mode}"),
        },
    );
    Ok(result)
}

/// 按 app + native method 执行；所有可预期失败返回 `Ok({ok:false,error})`。
#[tauri::command]
pub async fn connected_app_invoke(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    method: String,
    payload_json: String,
) -> Result<ConnectedAppInvokeReply> {
    let spec = spec_or_err(&app_id)?;

    // `__audit` 在任何门禁之前处理：确认期间断开连接，拒绝也要落盘。
    if method == "__audit" {
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
        return Ok(audit::handle_audit(&app, &app_id, &payload));
    }

    if payload_json.len() > MAX_IPC_PAYLOAD_BYTES {
        return Ok(ConnectedAppInvokeReply::err(
            &app_id,
            &method,
            "connected_app_bad_request",
            "payload 超过 2MB 上限",
            None,
        ));
    }
    let payload: Value = if payload_json.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        match serde_json::from_str(&payload_json) {
            Ok(v) => v,
            Err(_) => {
                return Ok(ConnectedAppInvokeReply::err(
                    &app_id,
                    &method,
                    "connected_app_bad_request",
                    "payload 不是合法 JSON",
                    None,
                ))
            }
        }
    };

    if spec.platform != spec_state::current_platform() {
        return Ok(ConnectedAppInvokeReply::err(
            &app_id,
            &method,
            "connected_app_unsupported",
            format!("「{}」只能在 {} 上使用", spec.title, spec.platform),
            None,
        ));
    }

    let kind = match spec_state::method_kind(spec, &method) {
        Some(kind) => kind,
        None => {
            return Ok(ConnectedAppInvokeReply::err(
                &app_id,
                &method,
                "connected_app_unknown_method",
                format!("「{}」不支持方法 {method}", spec.title),
                None,
            ))
        }
    };

    let (enabled, ai_intent, write_intent) = {
        let conn = state.db.lock();
        (
            store::is_enabled(&conn, spec.id),
            store::is_ai_enabled(&conn, spec.id),
            store::is_write_allowed(&conn, spec.id),
        )
    };
    if !enabled {
        let action = spec
            .permissions
            .iter()
            .find(|p| p.required)
            .and_then(|p| p.action);
        return Ok(gate_denied(
            &app,
            &app_id,
            &method,
            kind,
            "connected_app_not_connected",
            format!("请先在「连接应用 → {}」完成连接", spec.title),
            action,
        ));
    }

    // 有效状态：Android 读 Kotlin state.json；桌面实时探测。所有 app 工具都要求
    // 「已连接 + 允许 AI」，写方法再要求有效 writeAllowed（意图 + 原生写能力）。
    let status = if cfg!(target_os = "android") && apps::is_android_app(spec.id) {
        android::status_for(&app, spec, enabled, ai_intent, write_intent)
    } else {
        desktop::status_for(&app, spec, enabled, ai_intent, write_intent)
    };
    if !status.connected {
        let action = spec
            .permissions
            .iter()
            .find(|p| p.required)
            .and_then(|p| p.action);
        return Ok(gate_denied(
            &app,
            &app_id,
            &method,
            kind,
            "connected_app_not_connected",
            format!(
                "「{}」尚未连接或系统前提未齐{}",
                spec.title,
                status
                    .reason
                    .as_deref()
                    .map(|r| format!("（{r}）"))
                    .unwrap_or_default()
            ),
            action,
        ));
    }
    if !status.ai_enabled {
        return Ok(gate_denied(
            &app,
            &app_id,
            &method,
            kind,
            "connected_app_ai_disabled",
            format!("「{}」还没有允许 AI 使用", spec.title),
            None,
        ));
    }
    if kind == spec_state::MethodKind::Write && !status.write_allowed {
        if !write_intent {
            return Ok(gate_denied(
                &app,
                &app_id,
                &method,
                kind,
                "connected_app_write_not_allowed",
                format!("「{}」还没有允许写入；请让用户在连接应用里打开「允许写入」", spec.title),
                None,
            ));
        }
        let action = status
            .permissions
            .iter()
            .find(|p| p.write && !p.granted)
            .and_then(|p| p.action.clone())
            .or(Some("permissions_write".to_string()));
        return Ok(gate_denied(
            &app,
            &app_id,
            &method,
            kind,
            "connected_app_permission_denied",
            format!("「{}」缺少系统写入权限或可写根", spec.title),
            action.as_deref(),
        ));
    }

    let started = Instant::now();
    let reply = if cfg!(target_os = "android") && apps::is_android_app(spec.id) {
        match apps::validate_android(spec.id, &method, &payload) {
            Some(invalid) => invalid,
            None => android::invoke(&app, spec, &method, &payload).await?,
        }
    } else if desktop::is_desktop_file_app(spec.id) {
        desktop::invoke(&app, spec.id, &method, &payload)?
    } else {
        // 终端执行最长 90s 的同步子进程：放 blocking 线程，别占住 async worker。
        let app2 = app.clone();
        let app_id2 = spec.id.to_string();
        let method2 = method.clone();
        let payload2 = payload.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            apps::handle(&app2, &app_id2, &method2, &payload2)
        })
        .await
        {
            Ok(result) => result?,
            Err(e) => {
                return Ok(ConnectedAppInvokeReply::err(
                    &app_id,
                    &method,
                    "connected_app_bridge_error",
                    format!("执行线程失败：{e}"),
                    None,
                ))
            }
        }
    };
    let kind_label = match kind {
        spec_state::MethodKind::Read => "read",
        spec_state::MethodKind::Write => "write",
    };
    audit::write(
        &app,
        &AuditEntry {
            at: audit::now_iso(),
            app: app_id,
            method,
            kind: kind_label.to_string(),
            ok: reply.ok,
            code: reply.error.as_ref().map(|e| e.code.clone()),
            decision: if reply.ok { "allowed" } else { "error" }.to_string(),
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            summary: format!("method={}", reply.method),
        },
    );
    Ok(reply)
}

/// 记录连接同意 / 根；不弹系统 UI。
#[tauri::command]
pub fn connected_app_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    patch: ConnectedAppPatch,
) -> Result<ConnectedAppStatus> {
    let spec = spec_or_err(&app_id)?;
    ensure_platform(spec)?;
    if patch.roots.is_some() && spec.id != "win-local" {
        return Err(ReinError::coded(
            "connected_app_bad_request",
            "roots 只适用于 win-local",
        ));
    }

    // `aiEnabled/writeAllowed` 是 `enabled` 的下游：同一次 patch 里 enabled=true 允许。
    if patch.ai_enabled == Some(true) || patch.write_allowed == Some(true) {
        let will_be_enabled = {
            let conn = state.db.lock();
            patch.enabled.unwrap_or_else(|| store::is_enabled(&conn, spec.id))
        };
        if !will_be_enabled {
            return Err(ReinError::coded(
                "connected_app_not_connected",
                format!("请先连接「{}」，再开启 AI/写入许可", spec.title),
            ));
        }
    }

    // 写库前校验 roots：canonicalize / 去重 / 拒绝磁盘根与主目录祖先。
    let home = app
        .path()
        .home_dir()
        .ok()
        .map(|path| path.canonicalize().unwrap_or(path));
    {
        let conn = state.db.lock();
        store::apply_patch(&conn, spec.id, &patch, home.as_deref())?;
    }

    // 断开：释放 SAF / 清通知缓存；终端杀掉仍在运行的进程树。
    if patch.enabled == Some(false) {
        if spec.id == "filesystem" || spec.id == "notification" {
            android::revoke(&app, spec.id);
        }
        if spec.id == "win-terminal" || spec.id == "mac-terminal" {
            super::term_ops::kill_all();
        }
    }

    let (enabled, ai_intent, write_intent) = {
        let conn = state.db.lock();
        (
            store::is_enabled(&conn, spec.id),
            store::is_ai_enabled(&conn, spec.id),
            store::is_write_allowed(&conn, spec.id),
        )
    };
    let status = if cfg!(target_os = "android") {
        android::status_for(&app, spec, enabled, ai_intent, write_intent)
    } else {
        desktop::status_for(&app, spec, enabled, ai_intent, write_intent)
    };
    log_update(
        &app,
        spec.id,
        true,
        None,
        format!("enabled={enabled} ai={ai_intent} write={write_intent}"),
    );
    Ok(status)
}
