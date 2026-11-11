//! 两个终端 app（`win-terminal` / `mac-terminal`）的 handle 委托。
//!
//! 这里只做四件事：
//! 1. 平台与 app id 匹配（Windows 只能走 `win-terminal`，Mac 只能走 `mac-terminal`）；
//! 2. 方法白名单（只有 `run_terminal_command`）；
//! 3. shell 可用性门禁；
//! 4. 把 payload 解析成 `TerminalRequest`，交给 `term_ops::run`。
//!
//! 真正的 argv / cwd / 环境 / 超时 / 进程树 / 输出截断 / 审计都在 `term_ops`。

use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::super::models::{ConnectedAppInvokeReply, ConnectedAppMeta};
use super::super::paths;
use super::super::term_ops::{self, TerminalOptions, TerminalRequest};

const METHOD: &str = "run_terminal_command";

pub(crate) fn handle(
    app: &AppHandle,
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    if method != METHOD {
        return Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unknown_method",
            format!("终端不支持方法 {method}"),
            None,
        ));
    }

    let expected = platform_app_id();
    if expected.is_empty() || app_id != expected {
        return Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unsupported",
            "当前平台没有命令行能力",
            None,
        ));
    }

    if !term_ops::shell_available() {
        return Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unavailable",
            "没有可用的系统 shell",
            None,
        ));
    }

    let request = match TerminalRequest::parse(payload) {
        Ok(request) => request,
        Err(error) => {
            return Ok(ConnectedAppInvokeReply::err(
                app_id,
                method,
                error.code(),
                error.to_string(),
                None,
            ))
        }
    };

    // win-local 授权根：从 `app_meta` 读根表并 canonicalize，作为 cwd 白名单的一部分。
    // 读不到的根直接跳过（与 paths::roots_for 的容错一致），不把非法路径带进执行层。
    let extra_roots = paths::stored_local_roots(app)
        .into_iter()
        .filter_map(|raw| std::fs::canonicalize(raw).ok())
        .collect();
    let options = TerminalOptions {
        app_id: app_id.to_string(),
        extra_roots,
        audit_path: term_ops::default_audit_path(),
    };

    match term_ops::run(&request, &options) {
        Ok(outcome) => {
            let meta = ConnectedAppMeta {
                truncated: Some(outcome.truncated),
                audit: if outcome.audited { Some(true) } else { None },
                ..Default::default()
            };
            Ok(ConnectedAppInvokeReply::ok_meta(
                app_id,
                METHOD,
                outcome.to_json(),
                meta,
            ))
        }
        Err(error) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            error.code(),
            error.to_string(),
            None,
        )),
    }
}

fn platform_app_id() -> &'static str {
    if cfg!(target_os = "windows") {
        "win-terminal"
    } else if cfg!(target_os = "macos") {
        "mac-terminal"
    } else {
        ""
    }
}
