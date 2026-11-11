//! 桌面文件能力：列表 / 读取 / 搜索 / 写入 / 建目录 / 删除 / 重命名。
//!
//! 所有路径都先经过 `paths::validate_relative`，再 canonicalize 并做组件级根包含；
//! 符号链接 / 重解析点一律拒绝。写入默认不覆盖（`create_new` 保护最终路径），
//! 覆盖时用「同目录临时文件 + rename」，避免半截文件。
//!
//! 返回的 JSON 形状是 AI 工具直接消费的投影（列表 200、读取 1MB、搜索 50 条）。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use crate::error::{ReinError, Result};

use super::paths;

pub(crate) const MAX_READ_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_WRITE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_READ_CHARS: usize = 50_000;
pub(crate) const DEFAULT_READ_CHARS: usize = 20_000;
pub(crate) const MAX_LIST_ITEMS: usize = 200;
pub(crate) const MAX_SEARCH_DEPTH: usize = 4;
pub(crate) const MAX_SEARCH_SCAN: usize = 5000;
pub(crate) const MAX_SEARCH_RESULTS: usize = 50;
const NUL_SCAN_BYTES: usize = 8 * 1024;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn deny(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_path_denied", message)
}

fn bad_request(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_bad_request", message)
}

fn not_found(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_not_found", message)
}

fn not_text(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_not_text", message)
}

fn too_large(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_too_large", message)
}

fn exists(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_exists", message)
}

fn not_empty(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_not_empty", message)
}

fn io_error(e: std::io::Error) -> ReinError {
    match e.kind() {
        std::io::ErrorKind::NotFound => not_found("文件或文件夹不存在"),
        std::io::ErrorKind::PermissionDenied => ReinError::coded(
            "connected_app_permission_denied",
            "没有权限访问该文件或文件夹",
        ),
        std::io::ErrorKind::AlreadyExists => exists("目标已存在"),
        _ => ReinError::coded("connected_app_native_error", format!("文件操作失败：{e}")),
    }
}

/// 把绝对路径转成根内相对路径（统一用 `/`，便于模型回传）。
fn rel_string(root: &Path, path: &Path) -> String {
    let Ok(rel) = path.strip_prefix(root) else {
        return String::new();
    };
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn entry_type(meta: &std::fs::Metadata) -> &'static str {
    if paths::is_link_like(meta) {
        "symlink"
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    }
}

/// 列出目录（非递归）。链接条目只标记、不跟随、不列内容。
pub(crate) fn list(root: &Path, path: &str, limit: usize) -> Result<Value> {
    let dir = if path.trim().is_empty() {
        root.to_path_buf()
    } else {
        paths::canonical_existing(root, path)?
    };
    let meta = std::fs::symlink_metadata(&dir).map_err(io_error)?;
    if paths::is_link_like(&meta) {
        return Err(deny("拒绝对符号链接 / 重解析点列目录"));
    }
    if !meta.is_dir() {
        return Err(bad_request("目标不是文件夹"));
    }

    let limit = limit.clamp(1, MAX_LIST_ITEMS);
    let mut items: Vec<(u8, String, Value)> = Vec::new();
    let mut truncated = false;
    let entries = std::fs::read_dir(&dir).map_err(io_error)?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let full = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&full) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        let kind = entry_type(&meta);
        let size = if kind == "file" { meta.len() } else { 0 };
        let sort_key = if kind == "dir" { 0 } else { 1 };
        let value = json!({
            "name": name,
            "path": rel_string(root, &full),
            "type": kind,
            "size": size,
            "modifiedMs": modified_ms(&meta),
        });
        items.push((sort_key, name.to_lowercase(), value));
        if items.len() > limit {
            truncated = true;
            break;
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let items: Vec<Value> = items.into_iter().take(limit).map(|x| x.2).collect();
    Ok(json!({
        "path": path.replace('\\', "/"),
        "items": items,
        "truncated": truncated,
    }))
}

/// 读取 UTF-8 文本（≤1MB）；前 8KB 含 NUL 或 UTF-8 解码失败 → `not_text`。
/// `offset` / `max_chars` 按字符分页，返回 `nextOffset`。
pub(crate) fn read_text(root: &Path, path: &str, offset: usize, max_chars: usize) -> Result<Value> {
    let file_path = paths::canonical_existing(root, path)?;
    let meta = std::fs::symlink_metadata(&file_path).map_err(io_error)?;
    if paths::is_link_like(&meta) {
        return Err(deny("拒绝读取符号链接 / 重解析点"));
    }
    if meta.is_dir() {
        return Err(bad_request("目标是文件夹，不能按文本读取"));
    }
    if !meta.is_file() {
        return Err(bad_request("目标不是普通文件"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(too_large("文件超过 1MB 读取上限"));
    }

    let mut buf = Vec::new();
    File::open(&file_path)
        .map_err(io_error)?
        .take(MAX_READ_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(io_error)?;
    if buf.len() as u64 > MAX_READ_BYTES {
        return Err(too_large("文件超过 1MB 读取上限"));
    }
    if buf.iter().take(NUL_SCAN_BYTES).any(|b| *b == 0) {
        return Err(not_text("文件包含 NUL 字节，不是可读文本"));
    }
    let content = String::from_utf8(buf).map_err(|_| not_text("文件不是 UTF-8 文本"))?;
    let max_chars = max_chars.clamp(1, MAX_READ_CHARS);
    let total_chars = content.chars().count();
    let offset = offset.min(total_chars);
    let page: String = content.chars().skip(offset).take(max_chars).collect();
    let taken = page.chars().count();
    let next = offset + taken;
    let truncated = next < total_chars;
    Ok(json!({
        "path": path.replace('\\', "/"),
        "content": page,
        "offset": offset,
        "nextOffset": if truncated { Value::from(next) } else { Value::Null },
        "bytes": meta.len(),
        "totalChars": total_chars,
        "truncated": truncated,
    }))
}

/// 按文件名搜索（深度 ≤4、扫描 ≤5000、结果 ≤50）；链接一律跳过。
pub(crate) fn search(
    root: &Path,
    path: &str,
    query: &str,
    max_depth: usize,
    limit: usize,
) -> Result<Value> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 64 {
        return Err(bad_request("搜索词需为 1..64 个字符"));
    }
    let start = if path.trim().is_empty() {
        root.to_path_buf()
    } else {
        paths::canonical_existing(root, path)?
    };
    let start_meta = std::fs::symlink_metadata(&start).map_err(io_error)?;
    if paths::is_link_like(&start_meta) {
        return Err(deny("拒绝在符号链接 / 重解析点内搜索"));
    }
    if !start_meta.is_dir() {
        return Err(bad_request("搜索起点不是文件夹"));
    }

    let max_depth = max_depth.clamp(1, MAX_SEARCH_DEPTH);
    let limit = limit.clamp(1, MAX_SEARCH_RESULTS);
    let needle = query.to_lowercase();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((start, 0));
    let mut scanned = 0usize;
    let mut items: Vec<Value> = Vec::new();
    let mut truncated = false;

    'outer: while let Some((dir, depth)) = queue.pop_front() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if dir.as_path() == root => return Err(io_error(e)),
            Err(_) => continue,
        };
        for entry in entries {
            if scanned >= MAX_SEARCH_SCAN {
                truncated = true;
                break 'outer;
            }
            let Ok(entry) = entry else { continue };
            scanned += 1;
            let full = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&full) else {
                continue;
            };
            if paths::is_link_like(&meta) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.to_lowercase().contains(&needle) {
                items.push(json!({
                    "name": name,
                    "path": rel_string(root, &full),
                    "type": entry_type(&meta),
                    "size": if meta.is_file() { meta.len() } else { 0 },
                }));
                if items.len() >= limit {
                    truncated = true;
                    break 'outer;
                }
            }
            if meta.is_dir() && depth < max_depth {
                queue.push_back((full, depth + 1));
            }
        }
    }

    Ok(json!({
        "path": path.replace('\\', "/"),
        "query": query,
        "items": items,
        "scanned": scanned,
        "truncated": truncated,
    }))
}

fn temp_path(parent: &Path) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".rein-tmp-{}-{seq}", std::process::id()))
}

/// 写入文本（≤1MB）。`overwrite:false` 用 `create_new` 保护最终路径；
/// `overwrite:true` 用同目录临时文件 + rename。
pub(crate) fn write_text(root: &Path, path: &str, content: &str, overwrite: bool) -> Result<Value> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(too_large("写入内容超过 1MB 上限"));
    }
    let (parent, name) = paths::canonical_parent(root, path)?;
    let target = parent.join(&name);
    if !paths::root_contains(root, &parent) {
        return Err(deny("写入目标不在授权根目录内"));
    }

    let existing = match std::fs::symlink_metadata(&target) {
        Ok(meta) => {
            if paths::is_link_like(&meta) {
                return Err(deny("拒绝写入符号链接 / 重解析点"));
            }
            if meta.is_dir() {
                return Err(exists("同名文件夹已存在，不能按文件写入"));
            }
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(io_error(e)),
    };
    if existing && !overwrite {
        return Err(exists("文件已存在；如需覆盖请显式传 overwrite:true"));
    }

    let rel = path.replace('\\', "/");
    if !existing {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    exists("文件已存在；如需覆盖请显式传 overwrite:true")
                } else {
                    io_error(e)
                }
            })?;
        if let Err(e) = file.write_all(content.as_bytes()) {
            drop(file);
            let _ = std::fs::remove_file(&target);
            return Err(io_error(e));
        }
        return Ok(json!({
            "path": rel,
            "bytes": content.len(),
            "overwritten": false,
        }));
    }

    let tmp = temp_path(&parent);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(io_error)?;
    if let Err(e) = file.write_all(content.as_bytes()) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(io_error(e));
    }
    drop(file);
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(io_error(e));
    }
    Ok(json!({
        "path": rel,
        "bytes": content.len(),
        "overwritten": true,
    }))
}

/// 逐段创建目录（mkdir -p 语义）；已存在目录跳过，遇同名文件报错，
/// 每一段都 canonicalize + 根包含 + 不跟随链接。
pub(crate) fn create_folder(root: &Path, path: &str) -> Result<Value> {
    paths::validate_relative(path)?;
    let mut cur = root.to_path_buf();
    let mut created = false;
    for component in Path::new(path).components() {
        cur.push(component.as_os_str());
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) => {
                if paths::is_link_like(&meta) {
                    return Err(deny("拒绝经过符号链接 / 重解析点创建目录"));
                }
                if !meta.is_dir() {
                    return Err(exists("同名文件已存在，无法创建文件夹"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let parent_canon = cur
                    .parent()
                    .ok_or_else(|| deny("路径没有父目录"))?
                    .canonicalize()
                    .map_err(io_error)?;
                if !paths::root_contains(root, &parent_canon) {
                    return Err(deny("创建目录的父目录不在授权根目录内"));
                }
                std::fs::create_dir(&cur).map_err(io_error)?;
                created = true;
            }
            Err(e) => return Err(io_error(e)),
        }
        let canon = cur.canonicalize().map_err(io_error)?;
        if !paths::root_contains(root, &canon) {
            return Err(deny("创建目录后越界：不在授权根目录内"));
        }
        cur = canon;
    }
    Ok(json!({
        "path": path.replace('\\', "/"),
        "created": created,
    }))
}

/// 删除单文件或空目录；非空目录返回 `not_empty`，不递归、不进回收站。
pub(crate) fn delete(root: &Path, path: &str) -> Result<Value> {
    let target = paths::canonical_existing(root, path)?;
    let meta = std::fs::symlink_metadata(&target).map_err(io_error)?;
    if paths::is_link_like(&meta) {
        return Err(deny("拒绝删除符号链接 / 重解析点"));
    }
    let kind;
    if meta.is_file() {
        std::fs::remove_file(&target).map_err(io_error)?;
        kind = "file";
    } else if meta.is_dir() {
        let mut entries = std::fs::read_dir(&target).map_err(io_error)?;
        if entries.next().is_some() {
            return Err(not_empty("文件夹非空；请先清空后再删除"));
        }
        std::fs::remove_dir(&target).map_err(io_error)?;
        kind = "dir";
    } else {
        return Err(bad_request("目标不是普通文件或文件夹"));
    }
    Ok(json!({
        "path": path.replace('\\', "/"),
        "deleted": true,
        "type": kind,
    }))
}

/// 同根同目录重命名；目标必须不存在。
pub(crate) fn rename(root: &Path, from: &str, to: &str) -> Result<Value> {
    let from_path = paths::canonical_existing(root, from)?;
    let from_parent = from_path
        .parent()
        .ok_or_else(|| deny("源路径没有父目录"))?
        .canonicalize()
        .map_err(io_error)?;
    let (to_parent, to_name) = paths::canonical_parent(root, to)?;
    if from_parent != to_parent {
        return Err(bad_request("只能在同一个文件夹内重命名"));
    }
    let target = to_parent.join(&to_name);
    match std::fs::symlink_metadata(&target) {
        Ok(_) => return Err(exists("重命名目标已存在")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_error(e)),
    }

    let meta = std::fs::symlink_metadata(&from_path).map_err(io_error)?;
    if paths::is_link_like(&meta) {
        return Err(deny("拒绝重命名符号链接 / 重解析点"));
    }
    if meta.is_file() {
        match std::fs::hard_link(&from_path, &target) {
            Ok(()) => {
                if let Err(e) = std::fs::remove_file(&from_path) {
                    let _ = std::fs::remove_file(&target);
                    return Err(io_error(e));
                }
            }
            Err(_) => {
                // 跨卷 / 文件系统不支持硬链接：先确认目标仍不存在再 rename。
                if target.exists() {
                    return Err(exists("重命名目标已存在"));
                }
                std::fs::rename(&from_path, &target).map_err(io_error)?;
            }
        }
    } else if meta.is_dir() {
        std::fs::rename(&from_path, &target).map_err(io_error)?;
    } else {
        return Err(bad_request("目标不是普通文件或文件夹"));
    }

    Ok(json!({
        "from": from.replace('\\', "/"),
        "to": to.replace('\\', "/"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "rein-ca-fs-{}-{}-{}",
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

    fn canon(dir: &TempDir) -> PathBuf {
        dir.path().canonicalize().unwrap()
    }

    #[test]
    fn list_returns_files_and_dirs() {
        let dir = TempDir::new("list");
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let v = list(&canon(&dir), "", 100).unwrap();
        let items = v["items"].as_array().unwrap();
        let names: Vec<&str> = items.iter().map(|i| i["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"sub"));
        assert_eq!(items[0]["type"], "dir");
        assert_eq!(v["truncated"], false);
    }

    #[test]
    fn read_text_ok_and_pages() {
        let dir = TempDir::new("read");
        std::fs::write(dir.path().join("a.txt"), "你好世界 hello").unwrap();
        let v = read_text(&canon(&dir), "a.txt", 0, 2).unwrap();
        assert_eq!(v["content"], "你好");
        assert_eq!(v["nextOffset"], 2);
        assert_eq!(v["truncated"], true);
        let v = read_text(&canon(&dir), "a.txt", 2, 20).unwrap();
        assert_eq!(v["content"], "世界 hello");
        assert_eq!(v["nextOffset"], Value::Null);
    }

    #[test]
    fn read_binary_is_not_text() {
        let dir = TempDir::new("binary");
        std::fs::write(dir.path().join("a.bin"), [0u8, 1, 2, 3]).unwrap();
        let err = read_text(&canon(&dir), "a.bin", 0, 100).unwrap_err();
        assert_eq!(err.code(), "connected_app_not_text");
    }

    #[test]
    fn read_over_1mb_is_too_large() {
        let dir = TempDir::new("large");
        std::fs::write(
            dir.path().join("big.txt"),
            vec![b'a'; (MAX_READ_BYTES + 1) as usize],
        )
        .unwrap();
        let err = read_text(&canon(&dir), "big.txt", 0, 100).unwrap_err();
        assert_eq!(err.code(), "connected_app_too_large");
    }

    #[test]
    fn search_caps_depth_and_results() {
        let dir = TempDir::new("search");
        std::fs::create_dir_all(dir.path().join("d1/d2/d3/hit-deep")).unwrap();
        std::fs::write(dir.path().join("hit-0.txt"), "x").unwrap();
        std::fs::write(dir.path().join("d1/hit-1.txt"), "x").unwrap();
        let v = search(&canon(&dir), "", "hit", 1, 50).unwrap();
        let paths: Vec<&str> = v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"hit-0.txt"));
        assert!(paths.contains(&"d1/hit-1.txt"));
        assert!(!paths.iter().any(|p| p.contains("hit-deep")));

        let v = search(&canon(&dir), "", "hit", 4, 1).unwrap();
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["truncated"], true);
    }

    #[test]
    fn write_creates_and_overwrites_only_when_allowed() {
        let dir = TempDir::new("write");
        let root = canon(&dir);
        let v = write_text(&root, "new.txt", "v1", false).unwrap();
        assert_eq!(v["overwritten"], false);
        assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "v1");

        let err = write_text(&root, "new.txt", "v2", false).unwrap_err();
        assert_eq!(err.code(), "connected_app_exists");
        assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "v1");

        let v = write_text(&root, "new.txt", "v2", true).unwrap();
        assert_eq!(v["overwritten"], true);
        assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "v2");
    }

    #[test]
    fn write_parent_missing_returns_not_found() {
        let dir = TempDir::new("write-parent");
        let err = write_text(&canon(&dir), "missing/a.txt", "x", false).unwrap_err();
        assert_eq!(err.code(), "connected_app_not_found");
    }

    #[test]
    fn write_rejects_parent_segment_and_absolute_path() {
        let dir = TempDir::new("write-escape");
        let root = canon(&dir);
        for path in ["../escape.txt", "a/../../escape.txt", "/etc/escape.txt"] {
            let err = write_text(&root, path, "x", false).unwrap_err();
            assert_eq!(err.code(), "connected_app_path_denied", "{path}");
        }
        assert!(!root.join("escape.txt").exists());
    }

    #[test]
    fn delete_non_empty_dir_is_rejected() {
        let dir = TempDir::new("delete");
        let root = canon(&dir);
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), "x").unwrap();
        let err = delete(&root, "sub").unwrap_err();
        assert_eq!(err.code(), "connected_app_not_empty");
        std::fs::remove_file(root.join("sub/a.txt")).unwrap();
        let v = delete(&root, "sub").unwrap();
        assert_eq!(v["deleted"], true);
    }

    #[test]
    fn rename_same_dir_only() {
        let dir = TempDir::new("rename");
        let root = canon(&dir);
        std::fs::write(root.join("a.txt"), "x").unwrap();
        std::fs::create_dir(root.join("dst")).unwrap();
        let v = rename(&root, "a.txt", "b.txt").unwrap();
        assert_eq!(v["to"], "b.txt");
        let err = rename(&root, "b.txt", "dst/c.txt").unwrap_err();
        assert_eq!(err.code(), "connected_app_bad_request");
    }

    #[test]
    fn rename_target_exists_returns_exists() {
        let dir = TempDir::new("rename-exists");
        let root = canon(&dir);
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        let err = rename(&root, "a.txt", "b.txt").unwrap_err();
        assert_eq!(err.code(), "connected_app_exists");
    }

    #[test]
    fn create_folder_recursive_and_rejects_existing_file() {
        let dir = TempDir::new("mkdir");
        let root = canon(&dir);
        let v = create_folder(&root, "a/b/c").unwrap();
        assert_eq!(v["created"], true);
        assert!(root.join("a/b/c").is_dir());
        std::fs::write(root.join("f.txt"), "x").unwrap();
        let err = create_folder(&root, "f.txt").unwrap_err();
        assert_eq!(err.code(), "connected_app_exists");
    }
}
