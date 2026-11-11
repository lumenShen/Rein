//! 连接本机应用域：状态 / 授权 / 调用 / 同意 四个通用命令。
//!
//! ## 分层
//!
//! - `models`：前端 / Kotlin 桥共用的 serde 结构；
//! - `state`：17 条 `AppSpec` 白名单与 `connected` 公式；
//! - `store`：`app_meta` 的启用状态与 win-local 根；
//! - `commands`：四个 Tauri 命令；
//! - `android`：JNI + `cacheDir/connected_apps/*.json` 文件协议；
//! - `desktop` / `paths` / `fs_ops` / `term_ops`：桌面文件与命令行的真实执行；
//! - `apps`：app id → handler 的固定 match。
//!
//! health 不在这里：它继续走 `health_sync_*`，页面把两份状态合成同一个注册表。

pub mod android;
pub mod apps;
pub mod audit;
pub mod commands;
pub mod desktop;
pub mod fs_ops;
pub mod models;
pub mod paths;
pub mod state;
pub mod store;
pub mod term_ops;

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::error::Result;

/// 与 Kotlin 交换文件的目录名（`cacheDir/connected_apps/`）。
pub(crate) const BRIDGE_DIR: &str = "connected_apps";
/// Kotlin 写的 8 个 Android app 原生事实。
pub(crate) const STATE_FILE: &str = "state.json";
/// 请求文件子目录（Rust 写，供排查/审计）。
pub(crate) const REQUESTS_SUBDIR: &str = "requests";
/// 结果文件子目录（Kotlin 写）。
pub(crate) const RESULTS_SUBDIR: &str = "results";
/// NotificationListenerService 的有界缓存。
pub(crate) const NOTIFICATIONS_FILE: &str = "notifications.json";

/// IPC payload 上限（2MB）。
pub(crate) const MAX_IPC_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
/// 结果文件上限（>4MB 视为异常，拒绝读取）。
pub(crate) const MAX_RESULT_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// 桥目录（不存在则建）。与 `healthsync::bridge_dir` 同一先例：
/// Tauri 的 `app_cache_dir()` 就是 Android `cacheDir`。
pub(crate) fn bridge_dir(app: &AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::error::ReinError::Message(format!("无法定位应用缓存目录：{e}")))?
        .join(BRIDGE_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub(crate) fn subdir(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let dir = bridge_dir(app)?.join(name);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 读 JSON 文件；不存在 / 解析失败一律 `None`（调用方按「还没准备好」处理）。
pub(crate) fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 小文件原子写：先写 `.tmp` 再 rename（Windows 先删目标）。
pub(crate) fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string(value)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// 当前构建是否可能支持连接应用（四个平台；iOS 不在此列）。
pub(crate) fn platform_has_connected_apps() -> bool {
    cfg!(any(
        target_os = "android",
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    ))
}
