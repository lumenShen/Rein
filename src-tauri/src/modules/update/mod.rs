//! 在线更新（modules/update）：多源清单 → 验签 → 断点下载 → 安装。
//!
//! 与官方 tauri-plugin-updater 的关系：**信任模型一致，能力更宽**。
//! 一样用 Ed25519(minisign) 校验安装包、公钥都是编译进二进制的；但这里还多做了三件事：
//!
//! 1. **多源并行**：内置「Rein 在线服务」与「GitHub Release」两个源，各自可以是
//!    Tauri static JSON 或本服务的扩展清单。任一源挂掉不影响另一个。
//! 2. **清单本身也签名**（`latest.json.sig`）。安装包签名保证「这个包装得上」，
//!    清单签名保证「版本号/摘要没被人改过」——中间人可以把清单换成旧版本，
//!    但换不出一个能通过安装包验签的东西，再加上 last_seen_version 防降级就闭环了。
//! 3. **Android 自更新**：官方插件在移动端是空实现，Rein 是自建 APK 分发，
//!    所以这里直连系统安装器（见 install.rs）。
//!
//! 数据落点：设置存 `app_meta`（界面级偏好，不进知识库索引），下载物落
//! `<app_data>/updates/`，服务端与客户端都不需要额外的状态表。

pub mod commands;
mod download;
mod install;
pub mod keys;
mod manifest;
pub mod online;
mod verify;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 内置的 Rein 在线服务地址（编译期常量：客户端自带默认源，用户不必先配置）。
pub const DEFAULT_SERVICE_BASE: &str = "http://47.100.36.179:8787";
/// GitHub Release 的清单地址（`releases/latest` 永远指向最新正式版）。
pub const GITHUB_MANIFEST_URL: &str =
    "https://github.com/lumenShen/Rein/releases/latest/download/latest.json";

pub const SETTINGS_KEY: &str = "update_settings_v1";
pub const PROGRESS_EVENT: &str = "update://progress";

/// 下载物大小上限（验签要把文件读进内存做 Ed25519，留一道闸门）。
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// 当前平台键，命名与 tauri-plugin-updater 的 target 一致。
pub fn platform_key() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "arm") {
        "armv7"
    } else {
        "i686"
    };
    format!("{os}-{arch}")
}

/// 安装方式是否被本模块支持（其余平台只能给出手动下载指引）。
pub fn install_supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "android"))
}

pub fn install_platform_hint() -> &'static str {
    if cfg!(target_os = "windows") {
        "下载完成后会静默运行安装器并重启应用"
    } else if cfg!(target_os = "android") {
        "下载完成后交给系统安装器确认安装"
    } else {
        "该平台暂不支持应用内安装：请手动下载安装包"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    /// Rein 在线服务：支持清单伴随签名
    Rein,
    /// 任意 Tauri static JSON（GitHub Release 资产、静态托管皆可）
    TauriStatic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSource {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    pub url: String,
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
}

impl UpdateSource {
    fn new(id: &str, name: &str, kind: SourceKind, url: &str, priority: i32) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind,
            url: url.into(),
            enabled: true,
            priority,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    /// 总开关：关掉后连静默检查也不做
    pub enabled: bool,
    pub channel: String,
    /// 启动时静默检查
    pub auto_check: bool,
    pub check_interval_hours: i64,
    pub last_check_at: Option<String>,
    /// 已经见到过的最高版本：低于它的清单一律不提示（防重放旧版本）
    pub last_seen_version: Option<String>,
    /// 用户选择「跳过这个版本」
    pub ignored_version: Option<String>,
    /// 允许 http 源（自建服务器没有证书；安装包签名仍是硬校验）
    pub allow_http: bool,
    /// Windows 安装模式：true = /S 全静默，false = /P 显示进度条（默认）
    pub silent_install: bool,
    pub sources: Vec<UpdateSource>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            channel: "stable".into(),
            auto_check: true,
            check_interval_hours: 12,
            last_check_at: None,
            last_seen_version: None,
            ignored_version: None,
            allow_http: true,
            silent_install: false,
            sources: vec![
                UpdateSource::new(
                    "rein-service",
                    "Rein 在线服务",
                    SourceKind::Rein,
                    &format!("{DEFAULT_SERVICE_BASE}/updates/latest.json"),
                    0,
                ),
                UpdateSource::new(
                    "github",
                    "GitHub Release",
                    SourceKind::TauriStatic,
                    GITHUB_MANIFEST_URL,
                    10,
                ),
            ],
        }
    }
}

impl UpdateSettings {
    /// 按优先级取出启用的源（并保证内置源始终在列，用户手删也能自愈）。
    pub fn active_sources(&self) -> Vec<UpdateSource> {
        let mut list: Vec<UpdateSource> = self.sources.iter().filter(|s| s.enabled).cloned().collect();
        for builtin in UpdateSettings::default().sources {
            if !self.sources.iter().any(|s| s.id == builtin.id) {
                list.push(builtin);
            }
        }
        list.sort_by_key(|s| s.priority);
        list
    }
}

/// 一个源这次检查的结果（好源坏源都记，界面才能解释「为什么没检查到」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    pub url: String,
    pub ok: bool,
    pub version: Option<String>,
    pub manifest_signed: bool,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// 「检查更新」的结果快照。下载/安装都从这份快照里取候选，避免「检查到 A、下载了 B」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub checked_at: String,
    pub current_version: String,
    pub platform: String,
    pub available: bool,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub size_bytes: Option<u64>,
    pub source_id: Option<String>,
    pub source_name: Option<String>,
    pub sources: Vec<SourceReport>,
    pub mandatory: bool,
    pub install_supported: bool,
    pub install_hint: String,
    /// 命中的版本被用户标记为跳过
    pub ignored: bool,
    /// 清单里的版本低于见过的新版本（疑似被换了旧版本）
    pub downgrade_blocked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Preparing,
    Downloading,
    Verifying,
    Ready,
    Installing,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadState {
    pub phase: Phase,
    pub version: Option<String>,
    pub target: String,
    pub url: Option<String>,
    pub source_name: Option<String>,
    pub received: u64,
    pub total: u64,
    pub bytes_per_sec: u64,
    pub percent: f64,
    pub file: Option<String>,
    pub verified: bool,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
}

impl Default for DownloadState {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            version: None,
            target: platform_key(),
            url: None,
            source_name: None,
            received: 0,
            total: 0,
            bytes_per_sec: 0,
            percent: 0.0,
            file: None,
            verified: false,
            error: None,
            started_at: None,
            updated_at: None,
        }
    }
}

/// 候选更新：检查阶段挑出来的「唯一可下载对象」。
#[derive(Debug, Clone)]
pub struct Candidate {
    pub version: String,
    pub url: String,
    pub mirrors: Vec<String>,
    pub signature: String,
    pub sha256: Option<String>,
    pub size: Option<u64>,
    pub name: String,
    pub source_id: String,
    pub source_name: String,
}

struct HubInner {
    state: DownloadState,
    cancel: Option<Arc<AtomicBool>>,
    candidate: Option<Candidate>,
    /// 已下载并通过全部校验的文件（安装只认它）
    verified_file: Option<String>,
}

/// 下载/安装的进程内状态。下载跑在独立线程上，UI 关掉页面也不影响。
pub struct UpdateHub {
    inner: Mutex<HubInner>,
    check: Mutex<Option<UpdateCheck>>,
}

impl Default for UpdateHub {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HubInner {
                state: DownloadState::default(),
                cancel: None,
                candidate: None,
                verified_file: None,
            }),
            check: Mutex::new(None),
        }
    }

    pub fn state(&self) -> DownloadState {
        self.inner.lock().unwrap().state.clone()
    }

    pub fn last_check(&self) -> Option<UpdateCheck> {
        self.check.lock().unwrap().clone()
    }

    pub fn set_last_check(&self, check: UpdateCheck) {
        *self.check.lock().unwrap() = Some(check);
    }

    pub fn candidate(&self) -> Option<Candidate> {
        self.inner.lock().unwrap().candidate.clone()
    }

    pub fn set_candidate(&self, candidate: Candidate) {
        self.inner.lock().unwrap().candidate = Some(candidate);
    }

    pub fn verified_file(&self) -> Option<String> {
        self.inner.lock().unwrap().verified_file.clone()
    }

    pub fn clear_verified(&self) {
        let mut g = self.inner.lock().unwrap();
        g.verified_file = None;
        g.state = DownloadState::default();
    }

    pub fn is_busy(&self) -> bool {
        matches!(
            self.inner.lock().unwrap().state.phase,
            Phase::Preparing | Phase::Downloading | Phase::Verifying | Phase::Installing
        )
    }

    pub fn update_state<F: FnOnce(&mut DownloadState)>(&self, f: F) -> DownloadState {
        let mut g = self.inner.lock().unwrap();
        f(&mut g.state);
        g.state.updated_at = Some(chrono::Utc::now().to_rfc3339());
        g.state.clone()
    }

    pub fn set_verified(&self, file: String) {
        let mut g = self.inner.lock().unwrap();
        g.verified_file = Some(file.clone());
        g.state.file = Some(file);
        g.state.verified = true;
        g.state.phase = Phase::Ready;
        g.state.updated_at = Some(chrono::Utc::now().to_rfc3339());
    }

    pub fn begin_download(&self, version: &str, url: &str, source_name: &str, cancel: Arc<AtomicBool>) {
        let mut g = self.inner.lock().unwrap();
        g.cancel = Some(cancel);
        g.verified_file = None;
        g.state = DownloadState {
            phase: Phase::Preparing,
            version: Some(version.to_string()),
            target: platform_key(),
            url: Some(url.to_string()),
            source_name: Some(source_name.to_string()),
            started_at: Some(chrono::Utc::now().to_rfc3339()),
            ..DownloadState::default()
        };
    }

    pub fn request_cancel(&self) -> bool {
        let g = self.inner.lock().unwrap();
        match g.cancel.as_ref() {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn clear_cancel(&self) {
        self.inner.lock().unwrap().cancel = None;
    }
}

/// 设置读写：`app_meta` 单键存 JSON。读不出来就回落默认值，绝不让一条坏记录卡住启动。
pub fn load_settings(conn: &rusqlite::Connection) -> UpdateSettings {
    match crate::db::meta_get(conn, SETTINGS_KEY) {
        Some(text) => serde_json::from_str::<UpdateSettings>(&text).unwrap_or_default(),
        None => UpdateSettings::default(),
    }
}

pub fn save_settings(conn: &rusqlite::Connection, settings: &UpdateSettings) -> Result<()> {
    crate::db::meta_set(conn, SETTINGS_KEY, &serde_json::to_string(settings)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_key_matches_updater_target_naming() {
        let key = platform_key();
        assert!(key.contains('-'), "平台键应形如 windows-x86_64，实际 {key}");
        let (os, arch) = key.split_once('-').unwrap();
        assert!(["windows", "android", "darwin", "linux"].contains(&os));
        assert!(["x86_64", "aarch64", "armv7", "i686"].contains(&arch));
    }

    #[test]
    fn active_sources_keeps_builtins_even_if_user_removed_them() {
        let mut s = UpdateSettings::default();
        s.sources.retain(|x| x.id == "github");
        let list = s.active_sources();
        assert!(list.iter().any(|x| x.id == "rein-service"), "内置源应自愈");
        assert!(list.iter().any(|x| x.id == "github"));
        // 优先级排序：Rein 在线服务在前
        assert_eq!(list[0].id, "rein-service");
    }

    #[test]
    fn active_sources_respects_disabled() {
        let mut s = UpdateSettings::default();
        for src in s.sources.iter_mut() {
            if src.id == "github" {
                src.enabled = false;
            }
        }
        let list = s.active_sources();
        assert!(!list.iter().any(|x| x.id == "github"));
        assert!(list.iter().any(|x| x.id == "rein-service"));
    }

    #[test]
    fn settings_round_trip_through_json() {
        let s = UpdateSettings::default();
        let text = serde_json::to_string(&s).unwrap();
        let back: UpdateSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.channel, s.channel);
        assert_eq!(back.sources.len(), s.sources.len());
    }

    #[test]
    fn tuning_defaults_are_conservative() {
        let s = UpdateSettings::default();
        assert!(s.enabled && s.auto_check);
        assert_eq!(s.channel, "stable");
        assert!(s.ignored_version.is_none());
    }
}
