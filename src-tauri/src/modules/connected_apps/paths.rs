//! 桌面文件路径规则、根集合与根解析。
//!
//! 安全要点（plan §6.1）：
//! - `root` 是 **opaque id**，不是路径；严禁 `PathBuf::from(payload.root)`。
//!   `win-desktop:default` 由 `AppSpec` 映射到 `desktop_dir()`；`win-local:local-<n>`
//!   只查 `app_meta` 的根表。
//! - 包含判断用 `Path::starts_with`（组件级），不用字符串前缀。
//! - Windows 额外拒绝保留设备名、结尾 `.`/空格、ADS `:`、控制字符。
//! - 符号链接 / Windows 重解析点不跟随、不读、不写、不列内容。
//! - `win-local` 的根必须 canonicalize 后仍是目录，拒绝磁盘根与用户主目录本身及其祖先。

use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::store;

pub(crate) const MAX_RELATIVE_PATH_LEN: usize = 512;
pub(crate) const MAX_COMPONENT_LEN: usize = 255;
pub(crate) const MAX_LOCAL_ROOTS: usize = store::MAX_LOCAL_ROOTS;
/// Windows `FILE_ATTRIBUTE_REPARSE_POINT`。
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// 桌面文件工具共享的 7 个 app（固定系统目录 + 授权文件夹）。
pub(crate) const DESKTOP_FILE_APPS: &[&str] = &[
    "win-desktop",
    "win-documents",
    "win-downloads",
    "win-local",
    "mac-desktop",
    "linux-desktop",
    "linux-documents",
];

/// 一个已解析的根：`id` 是跨 IPC 的 opaque id，`path` 是 canonical 绝对路径。
#[derive(Debug, Clone)]
pub(crate) struct RootEntry {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    /// 展示/审计用的绝对路径字符串（AI helper 必须剥离）。
    pub display: String,
    pub writable: bool,
}

pub(crate) fn is_desktop_file_app(id: &str) -> bool {
    DESKTOP_FILE_APPS.contains(&id)
}

fn path_denied(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_path_denied", message)
}

/* ---------------- 相对路径校验 ---------------- */

/// 校验一个相对路径；失败返回 `connected_app_path_denied`。
///
/// 空串由调用方按「根目录本身」处理（列表/搜索的默认 path），不在这里放行。
pub(crate) fn validate_relative(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > MAX_RELATIVE_PATH_LEN {
        return Err(path_denied("路径为空或过长（上限 512 字符）"));
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Err(path_denied("只接受相对路径，拒绝绝对路径 / 盘符 / UNC"));
    }
    let mut any = false;
    for component in p.components() {
        match component {
            Component::Normal(seg) => {
                any = true;
                let s = seg.to_string_lossy();
                if s.is_empty() || s.contains('\0') || s.chars().any(|c| c.is_control()) {
                    return Err(path_denied("路径包含非法字符（NUL / 控制字符）"));
                }
                if s.len() > MAX_COMPONENT_LEN {
                    return Err(path_denied("路径中的单个文件名过长"));
                }
                #[cfg(target_os = "windows")]
                if is_windows_unsafe_component(&s) {
                    return Err(path_denied(
                        "路径包含 Windows 保留名、结尾点/空格或 ADS 冒号",
                    ));
                }
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(path_denied("路径不能包含 . / .. / 盘符 / UNC"));
            }
        }
    }
    if !any {
        return Err(path_denied("路径为空"));
    }
    Ok(())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_windows_unsafe_component(seg: &str) -> bool {
    if seg.ends_with('.') || seg.ends_with(' ') || seg.contains(':') {
        return true;
    }
    let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// 组件级包含判断（禁止字符串前缀比较）。
pub(crate) fn root_contains(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/* ---------------- 链接 / 重解析点 ---------------- */

/// 元数据是否指向符号链接 / Windows 重解析点（junction、mount point…）。
pub(crate) fn is_link_like(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if attributes_are_reparse_point(meta.file_attributes()) {
            return true;
        }
    }
    false
}

/// 纯函数，便于在任意平台验证 Windows 属性位判断。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn attributes_are_reparse_point(attrs: u32) -> bool {
    attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// 从 `root` 到 `candidate` 逐段检查已存在的节点，拒绝任何链接/重解析点。
///
/// 遇到不存在的段即停止（后面的段也都不存在）；新建逻辑自己逐段创建。
pub(crate) fn ensure_no_links_in_path(root: &Path, candidate: &Path) -> Result<()> {
    let rel = candidate
        .strip_prefix(root)
        .map_err(|_| path_denied("路径不在根目录内"))?;
    let mut cur = root.to_path_buf();
    for component in rel.components() {
        cur.push(component.as_os_str());
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) => {
                if is_link_like(&meta) {
                    return Err(path_denied("拒绝跟随符号链接 / 重解析点"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => {
                return Err(ReinError::coded(
                    "connected_app_native_error",
                    format!("无法检查路径：{e}"),
                ))
            }
        }
    }
    Ok(())
}

fn io_error(e: std::io::Error) -> ReinError {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            ReinError::coded("connected_app_not_found", "文件或文件夹不存在")
        }
        std::io::ErrorKind::PermissionDenied => ReinError::coded(
            "connected_app_permission_denied",
            "没有权限访问该文件或文件夹",
        ),
        std::io::ErrorKind::AlreadyExists => ReinError::coded("connected_app_exists", "目标已存在"),
        _ => ReinError::coded("connected_app_native_error", format!("文件操作失败：{e}")),
    }
}

/// canonicalize 一个**已存在**的相对路径，并保证结果仍在该根内。
pub(crate) fn canonical_existing(root: &Path, path: &str) -> Result<PathBuf> {
    validate_relative(path)?;
    let candidate = root.join(path);
    ensure_no_links_in_path(root, &candidate)?;
    let canon = candidate.canonicalize().map_err(io_error)?;
    if !root_contains(root, &canon) {
        return Err(path_denied("路径越界：解析后不在授权根目录内"));
    }
    Ok(canon)
}

/// 为**可能不存在**的目标解析父目录：父目录必须存在、canonical 且在根内。
/// 返回 `(canonical_parent, file_name)`。
pub(crate) fn canonical_parent(root: &Path, path: &str) -> Result<(PathBuf, std::ffi::OsString)> {
    validate_relative(path)?;
    let candidate = root.join(path);
    ensure_no_links_in_path(root, &candidate)?;
    let parent = candidate
        .parent()
        .ok_or_else(|| path_denied("路径没有父目录"))?;
    let parent_canon = parent.canonicalize().map_err(io_error)?;
    if !root_contains(root, &parent_canon) {
        return Err(path_denied("路径越界：父目录不在授权根目录内"));
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| path_denied("路径没有文件名"))?
        .to_os_string();
    Ok((parent_canon, name))
}

/// canonicalize 根自身；必须是已存在的目录。
pub(crate) fn canonical_root(path: &Path) -> Option<PathBuf> {
    let canon = path.canonicalize().ok()?;
    if canon.is_dir() {
        Some(canon)
    } else {
        None
    }
}

pub(crate) fn dir_readable(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok()
}

pub(crate) fn dir_writable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_dir() || meta.permissions().readonly() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o222 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/* ---------------- 根集合（win-local） ---------------- */

/// 纯函数：把新根并入已有根表。
///
/// - 完全重复 → no-op；
/// - 新根包含旧根 → 用新根替换旧根；
/// - 新根被旧根包含 → no-op（已覆盖）；
/// - 超过上限 → `Err`（调用方转成中文错误）。
pub(crate) fn merge_local_roots(
    existing: &[String],
    new_root: &str,
    cap: usize,
) -> std::result::Result<Vec<String>, String> {
    let new_path = Path::new(new_root);
    let mut out: Vec<String> = Vec::new();
    for old in existing {
        if old == new_root {
            return Ok(existing.to_vec());
        }
        let old_path = Path::new(old);
        if new_path.starts_with(old_path) {
            // 新根在旧根里面：已覆盖，不重复授权。
            return Ok(existing.to_vec());
        }
        if old_path.starts_with(new_path) {
            // 新根包含旧根：旧根被替换。
            continue;
        }
        out.push(old.clone());
    }
    if out.len() >= cap {
        return Err(format!("最多授权 {cap} 个文件夹，请先移除一个"));
    }
    out.push(new_root.to_string());
    Ok(out)
}

/// 磁盘根 / 主目录本身及其祖先都禁止作为授权根。
pub(crate) fn is_forbidden_local_root(candidate: &Path, home: Option<&Path>) -> bool {
    if candidate.parent().is_none() {
        return true;
    }
    if let Some(home) = home {
        // candidate 是 home 本身或 home 的祖先。
        if home.starts_with(candidate) {
            return true;
        }
    }
    false
}

/// 写入 `app_meta` 前的根校验（plan §6.1 第 9 条）：
/// 绝对路径 → canonicalize → 必须是目录 → 拒绝磁盘根/主目录及其祖先 → 去重/≤5。
///
/// 与 `roots_for` 的读取侧过滤同口径；区别是非法根在这里直接报错，而不是静默跳过。
pub(crate) fn normalize_local_roots(roots: &[String], home: Option<&Path>) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in roots {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(ReinError::coded(
                "connected_app_bad_request",
                "授权根不能为空",
            ));
        }
        let path = Path::new(trimmed);
        if !path.is_absolute() {
            return Err(path_denied("授权根必须是绝对路径"));
        }
        let canon = path.canonicalize().map_err(|_| {
            ReinError::coded(
                "connected_app_bad_request",
                format!("授权根不存在或不可访问：{trimmed}"),
            )
        })?;
        if !canon.is_dir() {
            return Err(ReinError::coded(
                "connected_app_bad_request",
                "只能授权文件夹，不能授权单个文件",
            ));
        }
        if is_forbidden_local_root(&canon, home) {
            return Err(path_denied(
                "不能授权磁盘根目录，也不能授权用户主目录本身或其上级目录",
            ));
        }
        let text = canon.to_string_lossy().to_string();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out.truncate(MAX_LOCAL_ROOTS);
    Ok(out)
}

fn home_dir(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    Some(home.canonicalize().unwrap_or(home))
}

/// `app_meta` 里的 `connected_apps.local_roots`（未 canonicalize 的历史值原样返回）。
pub(crate) fn stored_local_roots(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    store::local_roots(&conn)
}

fn persist_local_roots(app: &AppHandle, roots: &[String]) -> Result<()> {
    let json = serde_json::to_string(roots)?;
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    crate::db::meta_set(&conn, store::LOCAL_ROOTS_KEY, &json)
}

/// 展示用路径：Windows 去掉 canonicalize 的 `\\?\` / `\\?\UNC\` 前缀，方便 UI 阅读。
fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    raw
}

/// 校验并持久化 rfd 选择器返回的文件夹；返回展示用绝对路径。
pub(crate) fn add_local_root(app: &AppHandle, picked: &Path) -> Result<String> {
    let canon = picked.canonicalize().map_err(io_error)?;
    if !canon.is_dir() {
        return Err(ReinError::coded(
            "connected_app_bad_request",
            "只能授权文件夹，不能授权单个文件",
        ));
    }
    let home = home_dir(app);
    if is_forbidden_local_root(&canon, home.as_deref()) {
        return Err(path_denied(
            "不能授权磁盘根目录，也不能授权用户主目录本身或其上级目录",
        ));
    }
    // 持久化用 canonical 原串（Windows 保留 `\\?\`，长路径/UNC 更稳）；
    // 返回给 UI 的才是去掉前缀的展示路径。已有根先 canonicalize，避免手动路径
    // 与 picker 路径的 `\\?\` 前缀差异被当成两个根。
    let stored = canon.to_string_lossy().to_string();
    let existing: Vec<String> = stored_local_roots(app)
        .iter()
        .filter_map(|raw| {
            Path::new(raw)
                .canonicalize()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        })
        .collect();
    let merged = merge_local_roots(&existing, &stored, MAX_LOCAL_ROOTS)
        .map_err(|m| ReinError::coded("connected_app_bad_request", m))?;
    if merged != existing {
        persist_local_roots(app, &merged)?;
    }
    Ok(display_path(&canon))
}

fn label_for(app_id: &str) -> &'static str {
    match app_id {
        "win-desktop" | "mac-desktop" | "linux-desktop" => "桌面",
        "win-documents" | "linux-documents" => "文稿",
        "win-downloads" => "下载",
        _ => "文件夹",
    }
}

fn system_dir(app: &AppHandle, app_id: &str) -> Option<PathBuf> {
    // `PathResolver::desktop_dir/document_dir/download_dir` 在 Android 目标上不存在；
    // 桌面文件 app 在 Android 上会在平台校验处直接 unsupported，这里返回 None 即可。
    #[cfg(target_os = "android")]
    {
        let _ = (app, app_id);
        None
    }
    #[cfg(not(target_os = "android"))]
    {
        let p = app.path();
        match app_id {
            "win-desktop" | "mac-desktop" | "linux-desktop" => p.desktop_dir().ok(),
            "win-documents" | "linux-documents" => p.document_dir().ok(),
            "win-downloads" => p.download_dir().ok(),
            _ => None,
        }
    }
}

/// 某个桌面文件 app 当前可用的根（不存在/不可 canonicalize 的根会被跳过）。
pub(crate) fn roots_for(app: &AppHandle, app_id: &str) -> Result<Vec<RootEntry>> {
    let spec = super::state::find(app_id).ok_or_else(|| {
        ReinError::coded(
            "connected_app_bad_request",
            format!("未知连接应用：{app_id}"),
        )
    })?;
    if !is_desktop_file_app(app_id) {
        return Err(ReinError::coded(
            "connected_app_bad_request",
            format!("「{}」不是桌面文件应用", spec.title),
        ));
    }
    if spec.platform != super::state::current_platform() {
        return Err(ReinError::coded(
            "connected_app_unsupported",
            format!("「{}」只能在 {} 上使用", spec.title, spec.platform),
        ));
    }

    let mut out = Vec::new();
    if app_id == "win-local" {
        let home = home_dir(app);
        for (index, raw) in stored_local_roots(app).iter().enumerate() {
            // 只认绝对路径：相对路径会按进程 CWD 解析，可能把仓库目录变成授权根。
            if !Path::new(raw).is_absolute() {
                continue;
            }
            let Some(canon) = canonical_root(Path::new(raw)) else {
                continue;
            };
            // 防御纵深：即使 app_meta 里被手动写入磁盘根/主目录祖先，也不让它成为可用根。
            if is_forbidden_local_root(&canon, home.as_deref()) {
                continue;
            }
            // 给模型的 label 不能是绝对路径：用最后一段目录名（UI 另有 display 路径）。
            let label = canon
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("授权文件夹 {}", index + 1));
            out.push(RootEntry {
                id: format!("win-local:local-{}", index + 1),
                label,
                path: canon.clone(),
                display: display_path(&canon),
                writable: dir_writable(&canon),
            });
        }
    } else if let Some(dir) = system_dir(app, app_id) {
        if let Some(canon) = canonical_root(&dir) {
            out.push(RootEntry {
                id: format!("{app_id}:default"),
                label: label_for(app_id).to_string(),
                path: canon.clone(),
                display: display_path(&canon),
                writable: dir_writable(&canon),
            });
        }
    }
    Ok(out)
}

/// 按 opaque root id 查真实根；查不到一律 `connected_app_no_root`。
pub(crate) fn resolve_root_id(app: &AppHandle, app_id: &str, root_id: &str) -> Result<RootEntry> {
    if root_id.is_empty() || root_id.len() > 128 {
        return Err(ReinError::coded(
            "connected_app_no_root",
            "缺少有效的根 id；请先调用 list_desktop_roots",
        ));
    }
    if root_id.contains('/') || root_id.contains('\\') || root_id.contains("..") {
        return Err(path_denied("根 id 不能是路径"));
    }
    let roots = roots_for(app, app_id)?;
    roots.into_iter().find(|r| r.id == root_id).ok_or_else(|| {
        ReinError::coded(
            "connected_app_no_root",
            format!("根「{root_id}」不存在或不可用；请重新列出桌面文件根"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_segments() {
        assert!(validate_relative("../secret.txt").is_err());
        assert!(validate_relative("a/../b").is_err());
        assert!(validate_relative("./a").is_err());
    }

    #[test]
    fn rejects_absolute() {
        assert!(validate_relative("/etc/passwd").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_drive() {
        assert!(validate_relative("C:\\Windows\\win.ini").is_err());
        assert!(validate_relative("\\\\server\\share\\x").is_err());
    }

    #[test]
    fn rejects_nul_and_control_chars() {
        assert!(validate_relative("a\0b").is_err());
        assert!(validate_relative("a\u{1}b").is_err());
    }

    #[test]
    fn component_prefix_not_string_prefix() {
        assert!(!root_contains(
            Path::new("C:/data"),
            Path::new("C:/data2/x")
        ));
        assert!(root_contains(Path::new("C:/data"), Path::new("C:/data/x")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_windows_reserved_names() {
        assert!(validate_relative("CON").is_err());
        assert!(validate_relative("nul.txt").is_err());
        assert!(validate_relative("notes.txt:stream").is_err());
        assert!(validate_relative("secret.txt.").is_err());
        assert!(validate_relative("trailing ").is_err());
        assert!(validate_relative("COM1.log").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reparse_attribute_detected() {
        assert!(attributes_are_reparse_point(0x400));
        assert!(attributes_are_reparse_point(0x420));
        assert!(!attributes_are_reparse_point(0x20));
    }

    #[test]
    fn root_set_dedupes_and_caps() {
        let existing = vec!["root-a".to_string(), "root-b".to_string()];
        // 完全重复 / 新根被旧根包含 → no-op
        assert_eq!(
            merge_local_roots(&existing, "root-a", 5).unwrap(),
            existing.clone()
        );
        assert_eq!(
            merge_local_roots(&existing, "root-a/sub", 5).unwrap(),
            existing.clone()
        );
        // 新根包含旧根 → 旧根被替换
        let contained = vec!["root-a/sub-x".to_string()];
        assert_eq!(
            merge_local_roots(&contained, "root-a", 5).unwrap(),
            vec!["root-a".to_string()]
        );
        // 上限
        let full: Vec<String> = (0..5).map(|i| format!("r{i}")).collect();
        assert!(merge_local_roots(&full, "r-new", 5).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_home_root_and_ancestors() {
        let home = Path::new("C:/Users/me");
        assert!(is_forbidden_local_root(Path::new("C:/"), Some(home)));
        assert!(is_forbidden_local_root(Path::new("C:/Users"), Some(home)));
        assert!(is_forbidden_local_root(
            Path::new("C:/Users/me"),
            Some(home)
        ));
        assert!(!is_forbidden_local_root(
            Path::new("C:/Users/me/Projects"),
            Some(home)
        ));
    }

    #[test]
    fn containment_rejects_outside() {
        let base = std::env::temp_dir();
        let root = base.join("rein-connected-root");
        assert!(!root_contains(&root, &base.join("rein-connected-other/x")));
        assert!(root_contains(&root, &root.join("x")));
    }

    #[cfg(unix)]
    fn create_dir_link(link: &Path, target: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_dir_link(link: &Path, target: &Path) -> std::io::Result<()> {
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(
                String::from_utf8_lossy(&out.stderr).to_string(),
            ))
        }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "rein-ca-paths-{}-{}-{}",
                std::process::id(),
                tag,
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn symlink_escape_rejected() {
        let root = TempDir::new("root");
        let outside = TempDir::new("outside");
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        let link = root.path().join("link");
        if let Err(e) = create_dir_link(&link, outside.path()) {
            // 创建失败才跳过，并记录原因（plan §9.2 允许）。
            eprintln!("跳过 symlink_escape_rejected：无法创建目录链接：{e}");
            return;
        }
        let root_canon = root.path().canonicalize().unwrap();
        let err = canonical_existing(&root_canon, "link/secret.txt").unwrap_err();
        assert_eq!(err.code(), "connected_app_path_denied");
    }
}
