//! 安卓 SAF 文件（Android）的 Rust 侧契约护栏。
//!
//! **真实执行在 Kotlin `FileOps`**：`DocumentsContract` 需要 Android `Context`，
//! `commands.rs` 在 Android 上把 invoke 直接交给 `android.rs` 的 JNI，不经过这里
//! （plan §0.2 的架构决定）。本模块保留与 Kotlin 完全一致的边界校验——方法白名单、
//! 根 id、相对路径、写目标父目录、删除非空目录、1MB 文本上限——用于：
//!
//! 1. 非 Android / 误调用时返回明确错误，绝不假成功；
//! 2. 用纯函数单测锁住这些规则，避免 Rust 与 Kotlin 两套实现漂移。
//!
//! 注意：这里**没有** `status` 的运行时实现——Android 的 status 由
//! `android.rs::statuses` 读取 Kotlin 写的 `state.json`（plan §3.2），Rust 不重复
//! 访问 SAF，否则会得到与原生不一致的第二份事实。

use serde_json::{Map, Value};

use crate::error::Result;

use super::super::models::ConnectedAppInvokeReply;

/// 手机文件只有一个 SAF 树；root 是 opaque id，不是 URI/路径。
pub(crate) const ROOT_ID: &str = "filesystem:default";
pub(crate) const MAX_PATH_CHARS: usize = 512;
pub(crate) const MAX_SEGMENT_CHARS: usize = 255;
pub(crate) const MAX_READ_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_WRITE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_LIST_LIMIT: u64 = 200;
pub(crate) const MAX_SEARCH_LIMIT: u64 = 50;
pub(crate) const MAX_SEARCH_DEPTH: u64 = 4;
pub(crate) const MAX_SEARCH_SCAN: usize = 2000;
pub(crate) const MAX_QUERY_CHARS: usize = 64;

/// 校验失败 → 同形 `ConnectedAppInvokeReply::err`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InvalidCall {
    pub code: &'static str,
    pub message: String,
    pub action: Option<&'static str>,
}

impl InvalidCall {
    fn bad(message: impl Into<String>) -> Self {
        Self {
            code: "connected_app_bad_request",
            message: message.into(),
            action: None,
        }
    }

    fn coded(
        code: &'static str,
        message: impl Into<String>,
        action: Option<&'static str>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            action,
        }
    }

    fn no_root(message: impl Into<String>) -> Self {
        Self::coded("connected_app_no_root", message, Some("folder"))
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self::coded("connected_app_too_large", message, None)
    }
}

/// 相对路径（已逐段校验）。空 = 授权树根。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct RelativePath {
    segments: Vec<String>,
}

impl RelativePath {
    /// 解析 `path`/`from` 等字段。
    ///
    /// 拒绝：绝对路径、`.`、`..`、空段、NUL、总长 >512、单段 >255。
    /// 省略/null/空串 = 根；尾部斜杠按 Kotlin 同规则处理。
    pub(crate) fn parse(value: Option<&Value>, field: &str) -> std::result::Result<Self, InvalidCall> {
        let raw = match value {
            None | Some(Value::Null) => "",
            Some(Value::String(s)) => s.as_str(),
            Some(_) => return Err(InvalidCall::bad(format!("{field} 必须是字符串"))),
        };
        let text = raw.trim();
        if text.is_empty() {
            return Ok(Self::default());
        }
        if text.chars().count() > MAX_PATH_CHARS {
            return Err(InvalidCall::bad(format!(
                "{field} 超过 {MAX_PATH_CHARS} 字符"
            )));
        }
        if text.starts_with('/') {
            return Err(InvalidCall::bad(format!("{field} 必须是相对路径")));
        }
        let trimmed = text.trim_end_matches('/');
        if trimmed.is_empty() {
            return Ok(Self::default());
        }
        let mut segments = Vec::new();
        for segment in trimmed.split('/') {
            if segment.is_empty() {
                return Err(InvalidCall::bad(format!("{field} 不能包含空段")));
            }
            if segment == "." || segment == ".." {
                return Err(InvalidCall::bad(format!("{field} 不能包含 . 或 ..")));
            }
            if segment.chars().count() > MAX_SEGMENT_CHARS {
                return Err(InvalidCall::bad(format!(
                    "{field} 单段超过 {MAX_SEGMENT_CHARS} 字符"
                )));
            }
            if segment.contains('\0') {
                return Err(InvalidCall::bad(format!("{field} 包含非法字符")));
            }
            segments.push(segment.to_string());
        }
        Ok(Self { segments })
    }

    pub(crate) fn is_root(&self) -> bool {
        self.segments.is_empty()
    }

    pub(crate) fn as_string(&self) -> String {
        self.segments.join("/")
    }

    /// 写目标的父目录 + 文件名；根 path（空）没有目标。
    pub(crate) fn write_target(&self) -> std::result::Result<WriteTarget, InvalidCall> {
        let (name, parent) = self
            .segments
            .split_last()
            .ok_or_else(|| InvalidCall::bad("path 不能为空"))?;
        Ok(WriteTarget {
            parent: parent.to_vec(),
            name: name.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WriteTarget {
    pub parent: Vec<String>,
    pub name: String,
}

/// 一次合法调用（字段已过上限/路径校验）。仅用于错误摘要与单测，不直接执行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PhoneFileCall {
    Roots,
    List {
        root: String,
        path: RelativePath,
        limit: usize,
    },
    Read {
        root: String,
        path: RelativePath,
        max_bytes: u64,
    },
    Search {
        root: String,
        path: RelativePath,
        query: String,
        max_depth: usize,
        limit: usize,
    },
    Write {
        root: String,
        target: WriteTarget,
        content_bytes: usize,
        overwrite: bool,
    },
    CreateFolder {
        root: String,
        path: RelativePath,
    },
    Delete {
        root: String,
        path: RelativePath,
    },
    Rename {
        root: String,
        from: RelativePath,
        to: String,
    },
}

impl PhoneFileCall {
    /// 审计/错误摘要：不包含文件正文。
    pub(crate) fn summary(&self) -> String {
        match self {
            Self::Roots => "files_roots".to_string(),
            Self::List {
                root,
                path,
                limit,
            } => format!(
                "files_list root={root} path={} limit={limit}",
                path.as_string()
            ),
            Self::Read {
                root,
                path,
                max_bytes,
            } => format!(
                "read_phone_file root={root} path={} maxBytes={max_bytes}",
                path.as_string()
            ),
            Self::Search {
                root,
                path,
                query,
                max_depth,
                limit,
            } => format!(
                "search_phone_files root={root} path={} queryChars={} maxDepth={max_depth} limit={limit} scanCap={MAX_SEARCH_SCAN}",
                path.as_string(),
                query.chars().count()
            ),
            Self::Write {
                root,
                target,
                content_bytes,
                overwrite,
            } => format!(
                "write_phone_file root={root} path={} bytes={content_bytes} overwrite={overwrite}",
                join(&target.parent, &target.name)
            ),
            Self::CreateFolder { root, path } => format!(
                "create_phone_folder root={root} path={}",
                path.as_string()
            ),
            Self::Delete { root, path } => format!(
                "delete_phone_file root={root} path={}",
                path.as_string()
            ),
            Self::Rename { root, from, to } => format!(
                "rename_phone_file root={root} from={} to={to}",
                from.as_string()
            ),
        }
    }
}

fn join(parent: &[String], name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent.join("/"), name)
    }
}

fn root_of(obj: &Map<String, Value>) -> std::result::Result<String, InvalidCall> {
    match obj.get("root") {
        None | Some(Value::Null) => Ok(ROOT_ID.to_string()),
        Some(Value::String(root)) if root.is_empty() => Ok(ROOT_ID.to_string()),
        Some(Value::String(root)) if root == ROOT_ID => Ok(ROOT_ID.to_string()),
        Some(Value::String(root)) => Err(InvalidCall::no_root(format!(
            "未知的文件根：{root}；请重新调用 list_phone_roots"
        ))),
        Some(_) => Err(InvalidCall::bad("root 必须是字符串")),
    }
}

fn optional_u64(
    obj: &Map<String, Value>,
    key: &str,
) -> std::result::Result<Option<u64>, InvalidCall> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| InvalidCall::bad(format!("{key} 必须是非负整数"))),
        Some(_) => Err(InvalidCall::bad(format!("{key} 必须是整数"))),
    }
}

fn clamp_u64(value: Option<u64>, min: u64, max: u64, default: u64) -> u64 {
    value.unwrap_or(default).clamp(min, max)
}

fn validate_single_name(name: &str) -> std::result::Result<(), InvalidCall> {
    if name.is_empty() {
        return Err(InvalidCall::bad("to 不能为空"));
    }
    if name.chars().count() > MAX_SEGMENT_CHARS {
        return Err(InvalidCall::bad(format!("to 超过 {MAX_SEGMENT_CHARS} 字符")));
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(InvalidCall::bad("to 必须是同目录下的文件名（不能含 /）"));
    }
    Ok(())
}

/// 读路径的文件大小上限（调用方已知大小时使用；与 Kotlin 的 1MB 硬上限一致）。
#[allow(dead_code)]
pub(crate) fn ensure_read_size(size: u64, max_bytes: u64) -> std::result::Result<(), InvalidCall> {
    let cap = max_bytes.clamp(1, MAX_READ_BYTES);
    if size > cap {
        Err(InvalidCall::too_large("文件超过 1MB 上限"))
    } else {
        Ok(())
    }
}

/// 删除规则：只允许单文件或空目录（Kotlin 侧同样先查 children）。
#[allow(dead_code)]
pub(crate) fn ensure_delete_allowed(
    is_dir: bool,
    child_count: usize,
) -> std::result::Result<(), InvalidCall> {
    if is_dir && child_count > 0 {
        Err(InvalidCall::coded(
            "connected_app_not_empty",
            "目录非空，未删除",
            None,
        ))
    } else {
        Ok(())
    }
}

/// 参数校验 + 上限裁剪。错误码与 Kotlin `FileOps` 对齐。
pub(crate) fn validate(
    method: &str,
    payload: &Value,
) -> std::result::Result<PhoneFileCall, InvalidCall> {
    let obj = payload
        .as_object()
        .ok_or_else(|| InvalidCall::bad("payload 必须是对象"))?;
    match method {
        "files_roots" => Ok(PhoneFileCall::Roots),
        "files_list" => {
            let root = root_of(obj)?;
            let path = RelativePath::parse(obj.get("path"), "path")?;
            let limit = clamp_u64(optional_u64(obj, "limit")?, 1, MAX_LIST_LIMIT, 100) as usize;
            Ok(PhoneFileCall::List { root, path, limit })
        }
        "read_phone_file" => {
            let root = root_of(obj)?;
            let path = RelativePath::parse(obj.get("path"), "path")?;
            if path.is_root() {
                return Err(InvalidCall::bad("path 不能为空"));
            }
            let max_bytes = clamp_u64(
                optional_u64(obj, "maxBytes")?,
                1,
                MAX_READ_BYTES,
                MAX_READ_BYTES,
            );
            Ok(PhoneFileCall::Read {
                root,
                path,
                max_bytes,
            })
        }
        "search_phone_files" => {
            let root = root_of(obj)?;
            let path = RelativePath::parse(obj.get("path"), "path")?;
            let query = match obj.get("query").and_then(Value::as_str).map(str::trim) {
                Some(q) if !q.is_empty() && q.chars().count() <= MAX_QUERY_CHARS => q.to_string(),
                _ => {
                    return Err(InvalidCall::bad(format!(
                        "query 长度必须为 1..{MAX_QUERY_CHARS}"
                    )))
                }
            };
            let max_depth =
                clamp_u64(optional_u64(obj, "maxDepth")?, 1, MAX_SEARCH_DEPTH, 2) as usize;
            let limit = clamp_u64(optional_u64(obj, "limit")?, 1, MAX_SEARCH_LIMIT, 20) as usize;
            Ok(PhoneFileCall::Search {
                root,
                path,
                query,
                max_depth,
                limit,
            })
        }
        "write_phone_file" => {
            let root = root_of(obj)?;
            let path = RelativePath::parse(obj.get("path"), "path")?;
            let target = path.write_target()?;
            let content = obj
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| InvalidCall::bad("content 必须是字符串"))?;
            let content_bytes = content.as_bytes().len();
            if content_bytes > MAX_WRITE_BYTES {
                return Err(InvalidCall::too_large(format!(
                    "写入内容超过 1MB（{content_bytes} 字节）"
                )));
            }
            let overwrite = match obj.get("overwrite") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(v)) => *v,
                Some(_) => return Err(InvalidCall::bad("overwrite 必须是布尔值")),
            };
            Ok(PhoneFileCall::Write {
                root,
                target,
                content_bytes,
                overwrite,
            })
        }
        "create_phone_folder" => {
            let root = root_of(obj)?;
            let path = RelativePath::parse(obj.get("path"), "path")?;
            if path.is_root() {
                return Err(InvalidCall::bad("path 不能为空"));
            }
            Ok(PhoneFileCall::CreateFolder { root, path })
        }
        "delete_phone_file" => {
            let root = root_of(obj)?;
            let path = RelativePath::parse(obj.get("path"), "path")?;
            if path.is_root() {
                return Err(InvalidCall::bad("不能删除根目录"));
            }
            Ok(PhoneFileCall::Delete { root, path })
        }
        "rename_phone_file" => {
            let root = root_of(obj)?;
            let from = RelativePath::parse(obj.get("from"), "from")?;
            if from.is_root() {
                return Err(InvalidCall::bad("from 不能为空"));
            }
            let to = obj
                .get("to")
                .and_then(Value::as_str)
                .map(str::trim)
                .ok_or_else(|| InvalidCall::bad("to 必须是字符串"))?;
            validate_single_name(to)?;
            Ok(PhoneFileCall::Rename {
                root,
                from,
                to: to.to_string(),
            })
        }
        _ => Err(InvalidCall::coded(
            "connected_app_unknown_method",
            format!("文件系统不支持方法 {method}"),
            None,
        )),
    }
}

/// Android 运行时不会走到这里（`android.rs` 直接 JNI）；这里只做校验兜底。
pub(crate) fn handle(
    app_id: &str,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    match validate(method, payload) {
        Ok(call) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            "connected_app_unsupported",
            format!(
                "安卓 SAF 文件由 Kotlin FileOps 执行；Rust 侧不直接访问 DocumentsContract（{}）",
                call.summary()
            ),
            Some("folder"),
        )),
        Err(invalid) => Ok(ConnectedAppInvokeReply::err(
            app_id,
            method,
            invalid.code,
            invalid.message,
            invalid.action,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_parent_segments_and_absolute_paths() {
        for bad in ["../secret", "a/../../b", "/data", "a//b", "./a", "a/./b"] {
            let err = RelativePath::parse(Some(&json!(bad)), "path").unwrap_err();
            assert_eq!(err.code, "connected_app_bad_request", "path={bad}");
        }
        assert!(RelativePath::parse(Some(&json!("")), "path").unwrap().is_root());
        assert!(RelativePath::parse(None, "path").unwrap().is_root());
    }

    #[test]
    fn rejects_nul_and_overlong_segments() {
        let err = RelativePath::parse(Some(&json!("a\u{0000}b")), "path").unwrap_err();
        assert_eq!(err.code, "connected_app_bad_request");

        let long = "a".repeat(MAX_SEGMENT_CHARS + 1);
        let err = RelativePath::parse(Some(&json!(long)), "path").unwrap_err();
        assert_eq!(err.code, "connected_app_bad_request");

        let long_path = "a/".repeat(MAX_PATH_CHARS);
        let err = RelativePath::parse(Some(&json!(long_path)), "path").unwrap_err();
        assert_eq!(err.code, "connected_app_bad_request");
    }

    #[test]
    fn root_must_be_the_known_saf_tree() {
        let err = validate(
            "files_list",
            &json!({ "root": "filesystem:other", "path": "" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "connected_app_no_root");
        assert_eq!(err.action, Some("folder"));

        let ok = validate(
            "files_list",
            &json!({ "root": ROOT_ID, "path": "notes" }),
        )
        .unwrap();
        assert_eq!(
            ok,
            PhoneFileCall::List {
                root: ROOT_ID.to_string(),
                path: RelativePath {
                    segments: vec!["notes".to_string()]
                },
                limit: 100,
            }
        );
    }

    #[test]
    fn write_target_keeps_parent_inside_root() {
        let path = RelativePath::parse(Some(&json!("notes/2026/today.md")), "path").unwrap();
        let target = path.write_target().unwrap();
        assert_eq!(target.parent, vec!["notes", "2026"]);
        assert_eq!(target.name, "today.md");

        // 根路径没有可写目标。
        assert!(RelativePath::default().write_target().is_err());
        // `..` 在解析阶段就被拒绝，父目录不可能越出根。
        assert!(RelativePath::parse(Some(&json!("notes/../secret.txt")), "path").is_err());
    }

    #[test]
    fn delete_rejects_non_empty_directory() {
        let err = ensure_delete_allowed(true, 1).unwrap_err();
        assert_eq!(err.code, "connected_app_not_empty");
        assert!(ensure_delete_allowed(true, 0).is_ok());
        assert!(ensure_delete_allowed(false, 3).is_ok());
    }

    #[test]
    fn read_and_write_limits_are_enforced() {
        assert!(ensure_read_size(MAX_READ_BYTES, MAX_READ_BYTES).is_ok());
        let err = ensure_read_size(MAX_READ_BYTES + 1, MAX_READ_BYTES).unwrap_err();
        assert_eq!(err.code, "connected_app_too_large");
        // 传更大的 maxBytes 也会被 1MB 钳住。
        let err = ensure_read_size(MAX_READ_BYTES + 1, u64::MAX).unwrap_err();
        assert_eq!(err.code, "connected_app_too_large");

        let content = "x".repeat(MAX_WRITE_BYTES);
        assert!(validate(
            "write_phone_file",
            &json!({ "root": ROOT_ID, "path": "a.txt", "content": content })
        )
        .is_ok());

        let too_big = "x".repeat(MAX_WRITE_BYTES + 1);
        let err = validate(
            "write_phone_file",
            &json!({ "root": ROOT_ID, "path": "a.txt", "content": too_big }),
        )
        .unwrap_err();
        assert_eq!(err.code, "connected_app_too_large");
    }

    #[test]
    fn list_and_search_limits_are_clamped() {
        let call = validate(
            "files_list",
            &json!({ "root": ROOT_ID, "limit": 9999 }),
        )
        .unwrap();
        assert!(matches!(call, PhoneFileCall::List { limit: 200, .. }));

        let call = validate(
            "search_phone_files",
            &json!({ "root": ROOT_ID, "query": "report", "maxDepth": 99, "limit": 999 }),
        )
        .unwrap();
        assert!(matches!(
            call,
            PhoneFileCall::Search {
                max_depth: 4,
                limit: 50,
                ..
            }
        ));

        let err = validate(
            "search_phone_files",
            &json!({ "root": ROOT_ID, "query": "" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "connected_app_bad_request");

        let too_long = "q".repeat(MAX_QUERY_CHARS + 1);
        let err = validate(
            "search_phone_files",
            &json!({ "root": ROOT_ID, "query": too_long }),
        )
        .unwrap_err();
        assert_eq!(err.code, "connected_app_bad_request");
    }

    #[test]
    fn rename_target_must_be_single_name() {
        for bad in ["a/b", "..", "."] {
            let err = validate(
                "rename_phone_file",
                &json!({ "root": ROOT_ID, "from": "notes/a.txt", "to": bad }),
            )
            .unwrap_err();
            assert_eq!(err.code, "connected_app_bad_request", "to={bad}");
        }
        let ok = validate(
            "rename_phone_file",
            &json!({ "root": ROOT_ID, "from": "notes/a.txt", "to": "b.txt" }),
        )
        .unwrap();
        assert!(matches!(ok, PhoneFileCall::Rename { .. }));
    }

    #[test]
    fn read_requires_a_file_path_and_folder_requires_path() {
        assert!(validate("read_phone_file", &json!({ "root": ROOT_ID })).is_err());
        assert!(validate("create_phone_folder", &json!({ "root": ROOT_ID })).is_err());
        assert!(validate("delete_phone_file", &json!({ "root": ROOT_ID })).is_err());
        assert!(validate("files_roots", &json!({})).is_ok());
    }

    #[test]
    fn valid_calls_never_report_fake_success() {
        let reply = handle(
            "filesystem",
            "write_phone_file",
            &json!({ "root": ROOT_ID, "path": "a.txt", "content": "hi" }),
        )
        .unwrap();
        assert!(!reply.ok);
        assert!(reply.data.is_none());
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("connected_app_unsupported")
        );

        let reply = handle(
            "filesystem",
            "files_list",
            &json!({ "root": "filesystem:other", "path": "" }),
        )
        .unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("connected_app_no_root")
        );
    }

    #[test]
    fn unknown_method_is_rejected() {
        let reply = handle("filesystem", "rm_rf", &json!({})).unwrap();
        assert!(!reply.ok);
        assert_eq!(
            reply.error.as_ref().map(|e| e.code.as_str()),
            Some("connected_app_unknown_method")
        );
    }
}
