//! 桌面端（Windows / Mac / Linux）的状态与 request/invoke 分发。
//!
//! - 状态：7 个桌面文件 app 的根由 `paths::roots_for` 解析（固定系统目录 / `win-local`
//!   的 `app_meta` 根表），权限 `folder_read` / `folder_write` 反映根的真实可读/可写；
//! - request：`folder` 只对 `win-local` 拉起 rfd 选择器，选中后 canonicalize 并写入
//!   `app_meta`（≤5、去重、拒绝磁盘根/主目录）；其它模式不写任何状态；
//! - invoke：交给 `apps::desktop_files`，由它按 opaque root id 解析真实根后调用 `fs_ops`。
//!
//! 终端（`win-terminal` / `mac-terminal`）的执行在 `term_ops`；本文件只把
//! `term_ops::shell_available()` 合并进状态页（shell 是否可用）。

use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::audit;
use super::models::{
    ConnectedAppInvokeReply, ConnectedAppRequestResult, ConnectedAppStatus, NativeAppStatus,
    NativePermission, NativeRoot,
};
use super::state::{self, AppSpec, EnabledMap, FlagMap};
use super::{apps, paths};

pub(crate) use super::paths::is_desktop_file_app;

/// 7 个桌面文件 app 的原生事实（目录探测 + 根表）；终端 app 只探测 shell。
fn native_status(app: &AppHandle, spec: &AppSpec) -> Option<NativeAppStatus> {
    if !paths::is_desktop_file_app(spec.id) {
        // 终端不在本文件实现执行；但状态页需要 shell 是否可用，否则永远停在 unknown。
        if spec.id == "win-terminal" || spec.id == "mac-terminal" {
            let shell = super::term_ops::shell_available();
            return Some(NativeAppStatus {
                supported: Some(true),
                available: Some(shell),
                detail: if shell {
                    None
                } else {
                    Some("没有找到可用的 shell".to_string())
                },
                permissions: vec![
                    NativePermission {
                        key: "shell".to_string(),
                        granted: shell,
                    },
                    NativePermission {
                        key: "terminal_exec".to_string(),
                        granted: shell,
                    },
                ],
                roots: Vec::new(),
                capabilities: vec!["run_terminal_command".to_string()],
            });
        }
        return None;
    }
    let roots = paths::roots_for(app, spec.id).ok()?;
    let readable = roots.iter().any(|r| paths::dir_readable(&r.path));
    let writable = roots
        .iter()
        .any(|r| r.writable && paths::dir_readable(&r.path));
    let fixed_dir = spec.id != "win-local";
    let available = if fixed_dir { readable } else { true };
    let detail = if fixed_dir && !readable {
        Some("系统文件夹不存在或不可读".to_string())
    } else {
        None
    };
    let capabilities = spec
        .read_methods
        .iter()
        .map(|m| m.to_string())
        .collect::<Vec<_>>();

    Some(NativeAppStatus {
        supported: Some(true),
        available: Some(available),
        detail,
        permissions: vec![
            NativePermission {
                key: "folder_read".to_string(),
                granted: readable,
            },
            NativePermission {
                key: "folder_write".to_string(),
                granted: writable,
            },
        ],
        roots: roots
            .iter()
            .map(|r| NativeRoot {
                id: r.id.clone(),
                label: r.label.clone(),
                path: Some(r.display.clone()),
                writable: r.writable,
            })
            .collect(),
        capabilities,
    })
}

fn status_with_native(
    app: &AppHandle,
    spec: &AppSpec,
    enabled: bool,
    ai_intent: bool,
    write_intent: bool,
    now: &str,
) -> ConnectedAppStatus {
    let platform = state::current_platform();
    if spec.platform != platform {
        return state::build_status_for_platform(
            spec,
            None,
            enabled,
            ai_intent,
            write_intent,
            platform,
            None,
        );
    }
    match native_status(app, spec) {
        Some(native) => state::build_status_for_platform(
            spec,
            Some(&native),
            enabled,
            ai_intent,
            write_intent,
            platform,
            Some(now),
        ),
        None => state::build_status_for_platform(
            spec,
            None,
            enabled,
            ai_intent,
            write_intent,
            platform,
            None,
        ),
    }
}

/// 桌面端 17 条状态：桌面文件 app 用真实目录探测，其它平台 unsupported。
pub(crate) fn statuses(
    app: &AppHandle,
    enabled: &EnabledMap,
    ai: &FlagMap,
    write: &FlagMap,
) -> Vec<ConnectedAppStatus> {
    let now = audit::now_iso();
    state::APP_SPECS
        .iter()
        .map(|spec| {
            let on = state::enabled_for(enabled, spec.id);
            status_with_native(
                app,
                spec,
                on,
                state::flag_for(ai, spec.id),
                state::flag_for(write, spec.id),
                &now,
            )
        })
        .collect()
}

pub(crate) fn status_for(
    app: &AppHandle,
    spec: &AppSpec,
    enabled: bool,
    ai_intent: bool,
    write_intent: bool,
) -> ConnectedAppStatus {
    status_with_native(app, spec, enabled, ai_intent, write_intent, &audit::now_iso())
}

/// 桌面 request：只有 `win-local + folder` 会拉起选择器并持久化根。
pub(crate) async fn request(
    app: &AppHandle,
    spec: &AppSpec,
    mode: &str,
) -> Result<ConnectedAppRequestResult> {
    if mode != "folder" {
        return Ok(ConnectedAppRequestResult {
            app: spec.id.to_string(),
            mode: mode.to_string(),
            opened: false,
            reason: Some(
                "桌面端无需系统权限；连接同意与 AI/写入开关由 connected_app_update 记录".into(),
            ),
            root: None,
        });
    }
    if spec.id != "win-local" {
        return Ok(ConnectedAppRequestResult {
            app: spec.id.to_string(),
            mode: mode.to_string(),
            opened: false,
            reason: Some("该应用使用固定系统文件夹，无需选择".into()),
            root: None,
        });
    }

    #[cfg(target_os = "windows")]
    {
        let picked = tauri::async_runtime::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("选择要授权给 Rein 的文件夹")
                .pick_folder()
        })
        .await
        .ok()
        .flatten();

        let Some(path) = picked else {
            return Ok(ConnectedAppRequestResult {
                app: spec.id.to_string(),
                mode: mode.to_string(),
                opened: false,
                reason: Some("用户取消".into()),
                root: None,
            });
        };

        match paths::add_local_root(app, &path) {
            Ok(display) => Ok(ConnectedAppRequestResult {
                app: spec.id.to_string(),
                mode: mode.to_string(),
                opened: true,
                reason: None,
                root: Some(display),
            }),
            Err(e)
                if e.code() == "connected_app_path_denied"
                    || e.code() == "connected_app_bad_request" =>
            {
                // 选到了磁盘根/主目录祖先等非法根：不落库，明确告诉用户原因。
                Ok(ConnectedAppRequestResult {
                    app: spec.id.to_string(),
                    mode: mode.to_string(),
                    opened: false,
                    reason: Some(e.to_string()),
                    root: None,
                })
            }
            Err(e) => Err(e),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(ConnectedAppRequestResult {
            app: spec.id.to_string(),
            mode: mode.to_string(),
            opened: false,
            reason: Some(
                "当前平台没有可选择文件夹的桌面文件应用（Mac/Linux 使用固定系统目录）".into(),
            ),
            root: None,
        })
    }
}

/// 桌面 invoke：交给固定 match 的 `desktop_files`，由它解析根并调用 `fs_ops`。
pub(crate) fn invoke(
    app: &AppHandle,
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    apps::desktop_files::handle_with_app(app, app_id, method, payload)
}
