//! 连接应用审计：`data_dir/connected_apps/audit.jsonl`。
//!
//! - 单文件 1MB 轮转（`audit.1.jsonl` 覆盖旧备份），总占用 ≤2MB；
//! - 追加串行（`AUDIT_LOCK`）；
//! - 写失败只记 stderr，不阻断能力（plan §10.1 第 17 条）；
//! - 脱敏：键名含 api key/token/secret/password/authorization/bearer 的值替换 `***`；
//!   调用方只传摘要，正文/号码/通知标题/经纬度不进入审计。

use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::models::{ConnectedAppInvokeReply, ConnectedAppMeta};
use super::state;

const AUDIT_DIR: &str = "connected_apps";
const AUDIT_FILE: &str = "audit.jsonl";
const AUDIT_BACKUP: &str = "audit.1.jsonl";
const MAX_AUDIT_BYTES: u64 = 1024 * 1024;

static AUDIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: String,
    pub app: String,
    pub method: String,
    /// read / write / control
    pub kind: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// allowed / denied / error
    pub decision: String,
    pub duration_ms: u64,
    pub summary: String,
}

fn audit_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = crate::db::data_dir(app)?.join(AUDIT_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(AUDIT_FILE))
}

fn rotate_if_needed(path: &PathBuf) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() > MAX_AUDIT_BYTES)
        .unwrap_or(false);
    if !too_big {
        return;
    }
    let backup = path.with_file_name(AUDIT_BACKUP);
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(path, &backup);
}

/// 追加一条审计；错误只写 stderr。
pub fn write(app: &AppHandle, entry: &AuditEntry) {
    let _guard = AUDIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = match audit_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[connected_apps] 审计目录不可用：{e}");
            return;
        }
    };
    rotate_if_needed(&path);
    let line = match serde_json::to_string(entry) {
        Ok(json) => json,
        Err(e) => {
            eprintln!("[connected_apps] 审计序列化失败：{e}");
            return;
        }
    };
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{line}") {
                eprintln!("[connected_apps] 审计写入失败：{e}");
            }
        }
        Err(e) => eprintln!("[connected_apps] 审计文件打开失败：{e}"),
    }
}

pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

/// 键名脱敏（值替换 `***`）；只处理对象/数组的浅层递归。
pub fn redact(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let lower = k.to_ascii_lowercase();
                let secret = ["api_key", "apikey", "token", "secret", "password", "passwd", "authorization", "bearer"]
                    .iter()
                    .any(|needle| lower.contains(needle));
                out.insert(k.clone(), if secret { Value::String("***".into()) } else { redact(v) });
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact).collect()),
        other => other.clone(),
    }
}

/// `connected_app_invoke(app, '__audit', {...})`：只写拒绝/审计，不执行能力。
pub fn handle_audit(app: &AppHandle, app_id: &str, payload: &Value) -> ConnectedAppInvokeReply {
    let Some(spec) = state::find(app_id) else {
        return ConnectedAppInvokeReply::err(
            app_id,
            "__audit",
            "connected_app_bad_request",
            format!("未知连接应用：{app_id}"),
            None,
        );
    };
    if payload.get("method").and_then(|v| v.as_str()).map(|m| m.len() > 64).unwrap_or(false) {
        return ConnectedAppInvokeReply::err(app_id, "__audit", "connected_app_bad_request", "method 过长", None);
    }
    if payload
        .get("summary")
        .and_then(|v| v.as_str())
        .map(|s| s.len() > 300)
        .unwrap_or(false)
    {
        return ConnectedAppInvokeReply::err(app_id, "__audit", "connected_app_bad_request", "summary 过长", None);
    }
    let method = payload
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("__audit");
    let decision = match payload.get("decision").and_then(|v| v.as_str()) {
        Some("denied") => "denied",
        Some("error") => "error",
        _ => "allowed",
    };
    let summary = payload
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(300)
        .collect::<String>();
    write(
        app,
        &AuditEntry {
            at: now_iso(),
            app: spec.id.to_string(),
            method: method.to_string(),
            kind: "control".to_string(),
            ok: decision != "error",
            code: None,
            decision: decision.to_string(),
            duration_ms: 0,
            summary,
        },
    );
    ConnectedAppInvokeReply::ok_meta(
        spec.id,
        "__audit",
        serde_json::json!({ "recorded": true }),
        ConnectedAppMeta {
            audit: Some(true),
            ..Default::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_secret_keys() {
        let value = json!({
            "apiKey": "abc",
            "Authorization": "Bearer x",
            "nested": { "access_token": "t", "name": "ok" }
        });
        let out = redact(&value);
        assert_eq!(out["apiKey"], "***");
        assert_eq!(out["Authorization"], "***");
        assert_eq!(out["nested"]["access_token"], "***");
        assert_eq!(out["nested"]["name"], "ok");
    }
}
