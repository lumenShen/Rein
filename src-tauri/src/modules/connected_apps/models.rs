//! 连接本机应用 · 跨 IPC / 跨桥的数据结构。
//!
//! 全部 `#[serde(rename_all = "camelCase")]`：TS 类型（`src/types/connectedApps.ts`）
//! 与 Kotlin 写出的 JSON 都用 camelCase，Rust 只在内部用 snake_case。
//! `state.json` / 结果文件也复用这里的 `Native*` 结构，字段名与 plan §3.2/§3.3 一致。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/* ---------------- 前端 ← Rust ---------------- */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppsSnapshot {
    /// `android` / `windows` / `mac` / `linux`；浏览器 mock 才有 `browser`
    pub platform: String,
    /// Tauri 恒 false
    pub mock: bool,
    /// Android 本轮 refresh 尚未落地时为 true
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refreshing: Option<bool>,
    pub apps: Vec<ConnectedAppStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppStatus {
    pub id: String,
    /// app 自身声明的平台，不是当前设备平台
    pub platform: String,
    pub supported: bool,
    /// available / partial / unavailable / unsupported / unknown
    pub availability: String,
    /// 用户是否已在原生侧同意连接
    pub enabled: bool,
    /// enabled && 必需前提齐备
    pub connected: bool,
    /// enabled && connected && `app_meta` 里的 AI 使用意图
    pub ai_enabled: bool,
    /// enabled && connected && 写入意图 && 原生写能力齐备
    pub write_allowed: bool,
    /// 必需权限是否全 granted
    pub granted: bool,
    /// 原生写能力是否就绪
    pub writable: bool,
    #[serde(default)]
    pub permissions: Vec<ConnectedAppPermission>,
    #[serde(default)]
    pub roots: Vec<ConnectedAppRoot>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppPermission {
    pub key: String,
    pub label: String,
    pub granted: bool,
    pub required: bool,
    pub write: bool,
    /// runtime / special / normal / folder / consent
    pub kind: String,
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppRoot {
    pub id: String,
    pub label: String,
    /// 仅桌面展示/审计；手机不返回 URI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppRequestResult {
    pub app: String,
    pub mode: String,
    pub opened: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppInvokeReply {
    pub ok: bool,
    pub app: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ConnectedAppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<ConnectedAppMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mock: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppPatch {
    pub enabled: Option<bool>,
    pub ai_enabled: Option<bool>,
    pub write_allowed: Option<bool>,
    /// 仅 `win-local`：整表替换（≤5）
    pub roots: Option<Vec<String>>,
}

impl ConnectedAppInvokeReply {
    pub fn ok(app: impl Into<String>, method: impl Into<String>, data: Value) -> Self {
        Self {
            ok: true,
            app: app.into(),
            method: method.into(),
            data: Some(data),
            error: None,
            meta: None,
        }
    }

    pub fn ok_meta(
        app: impl Into<String>,
        method: impl Into<String>,
        data: Value,
        meta: ConnectedAppMeta,
    ) -> Self {
        Self {
            ok: true,
            app: app.into(),
            method: method.into(),
            data: Some(data),
            error: None,
            meta: Some(meta),
        }
    }

    pub fn err(
        app: impl Into<String>,
        method: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        action: Option<&str>,
    ) -> Self {
        Self {
            ok: false,
            app: app.into(),
            method: method.into(),
            data: None,
            error: Some(ConnectedAppError {
                code: code.into(),
                message: message.into(),
                action: action.map(|s| s.to_string()),
                hint: None,
            }),
            meta: None,
        }
    }
}

impl ConnectedAppStatus {
    /// 平台不符时的占位状态（17 条固定顺序里，非本机平台也各占一行）。
    pub fn unsupported(spec: &super::state::AppSpec, reason: &str) -> Self {
        Self {
            id: spec.id.to_string(),
            platform: spec.platform.to_string(),
            supported: false,
            availability: "unsupported".to_string(),
            enabled: false,
            connected: false,
            ai_enabled: false,
            write_allowed: false,
            granted: false,
            writable: false,
            permissions: spec
                .permissions
                .iter()
                .map(|p| ConnectedAppPermission {
                    key: p.key.to_string(),
                    label: p.label.to_string(),
                    granted: false,
                    required: p.required,
                    write: p.write,
                    kind: p.kind.to_string(),
                    action: p.action.map(|s| s.to_string()),
                })
                .collect(),
            roots: Vec::new(),
            capabilities: Vec::new(),
            reason: Some(reason.to_string()),
            detail: None,
            last_checked_at: None,
        }
    }
}

/* ---------------- Kotlin 桥文件 ---------------- */

/// `cacheDir/connected_apps/state.json`
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeStateFile {
    #[serde(default)]
    pub generation: u64,
    pub updated_at: Option<String>,
    #[serde(default)]
    pub apps: HashMap<String, NativeAppStatus>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppStatus {
    pub supported: Option<bool>,
    pub available: Option<bool>,
    pub detail: Option<String>,
    #[serde(default)]
    pub permissions: Vec<NativePermission>,
    #[serde(default)]
    pub roots: Vec<NativeRoot>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativePermission {
    pub key: String,
    #[serde(default)]
    pub granted: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeRoot {
    pub id: String,
    pub label: String,
    pub path: Option<String>,
    #[serde(default)]
    pub writable: bool,
}

/// `cacheDir/connected_apps/<requestId>.json`（Kotlin 写的结果文件）
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeInvokeResult {
    #[serde(default)]
    pub ok: bool,
    pub data: Option<Value>,
    pub error: Option<ConnectedAppError>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub count: Option<u64>,
}

/// `cacheDir/connected_apps/<requestId>.request.json`（Rust 写的请求文件，供排查/审计）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInvokeRequest {
    pub app: String,
    pub method: String,
    pub payload: Value,
    pub expires_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_camel_case() {
        let status = ConnectedAppStatus {
            id: "calendar".into(),
            platform: "android".into(),
            last_checked_at: Some("2026-11-10T12:00:00+08:00".into()),
            ..Default::default()
        };
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["lastCheckedAt"], "2026-11-10T12:00:00+08:00");
        assert!(json.get("last_checked_at").is_none());
    }

    #[test]
    fn error_envelope_shape() {
        let reply = ConnectedAppInvokeReply::err(
            "calendar",
            "create_calendar_event",
            "connected_app_permission_denied",
            "缺少日历写入权限",
            Some("permissions_write"),
        );
        let json = serde_json::to_value(reply).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["code"], "connected_app_permission_denied");
        assert_eq!(json["error"]["action"], "permissions_write");
    }
}
