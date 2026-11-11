//! 17 条原生 app 的静态规格 + 状态合并。
//!
//! 一张 `APP_SPECS` 表集中回答：
//! - 每个 app 在哪个平台、有哪些 native method（读 / 写 allowlist）；
//! - 需要哪些权限/根才能 `connected`；
//! - 原生事实（Kotlin `state.json` 或桌面实时探测）如何合并成 `ConnectedAppStatus`。
//!
//! Rust 不按 app 拆逻辑：Android 的真实执行在 Kotlin；桌面文件/终端另有能力模块。
//! 这里只做「白名单 + 状态公式」，避免 17 份重复的判定散落各处。

use std::collections::HashMap;

use super::models::{
    ConnectedAppPermission, ConnectedAppRoot, ConnectedAppStatus, NativeAppStatus,
    NativeStateFile,
};

/// `app_meta` 的 enabled 映射（键是 app id）。
pub type EnabledMap = HashMap<String, bool>;
/// 同类映射：AI 使用意图 / 写入意图（键是 app id）。
pub type FlagMap = HashMap<String, bool>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodKind {
    Read,
    Write,
}

#[derive(Debug, Clone, Copy)]
pub struct PermissionSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub required: bool,
    pub write: bool,
    /// runtime / special / normal / folder / consent
    pub kind: &'static str,
    pub action: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
pub struct AppSpec {
    pub id: &'static str,
    pub platform: &'static str,
    pub title: &'static str,
    pub read_methods: &'static [&'static str],
    pub write_methods: &'static [&'static str],
    pub permissions: &'static [PermissionSpec],
    /// 文件类：没有根 / 树就不能算 connected
    pub requires_root: bool,
    /// 是否有写能力（决定是否展示「允许写入」与写方法 capability）
    pub writes: bool,
}

/* ---------------- 权限声明（与 config/connectedApps.ts / Kotlin PermissionMap 同名） ---------------- */

const ALARM_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "clock_app",
        label: "系统时钟可用",
        required: true,
        write: false,
        kind: "normal",
        action: None,
    },
    PermissionSpec {
        key: "clock_write",
        label: "修改闹钟和计时器",
        required: false,
        write: true,
        kind: "consent",
        action: None,
    },
];

const USAGE_PERMS: &[PermissionSpec] = &[PermissionSpec {
    key: "usage_access",
    label: "使用情况访问权限",
    required: true,
    write: false,
    kind: "special",
    action: Some("usage_access"),
}];

const CALENDAR_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "read_calendar",
        label: "读取日历（READ_CALENDAR）",
        required: true,
        write: false,
        kind: "runtime",
        action: Some("permissions"),
    },
    PermissionSpec {
        key: "write_calendar",
        label: "写入日历（WRITE_CALENDAR）",
        required: false,
        write: true,
        kind: "runtime",
        action: Some("permissions_write"),
    },
];

const CONTACTS_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "read_contacts",
        label: "读取通讯录（READ_CONTACTS）",
        required: true,
        write: false,
        kind: "runtime",
        action: Some("permissions"),
    },
    PermissionSpec {
        key: "write_contacts",
        label: "写入通讯录（WRITE_CONTACTS）",
        required: false,
        write: true,
        kind: "runtime",
        action: Some("permissions_write"),
    },
];

const PHONE_FILES_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "saf_tree",
        label: "授权文件夹（SAF 读取）",
        required: true,
        write: false,
        kind: "folder",
        action: Some("folder"),
    },
    PermissionSpec {
        key: "saf_tree_write",
        label: "写入授权文件夹（SAF 读写）",
        required: false,
        write: true,
        kind: "folder",
        action: Some("folder"),
    },
];

const LOCATION_PERMS: &[PermissionSpec] = &[PermissionSpec {
    key: "location",
    label: "位置权限（精确 / 大致）",
    required: true,
    write: false,
    kind: "runtime",
    action: Some("permissions"),
}];

const NOTIFICATION_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "notification_access",
        label: "通知使用权",
        required: true,
        write: false,
        kind: "special",
        action: Some("notification_access"),
    },
    PermissionSpec {
        key: "notification_dismiss",
        label: "清除通知",
        required: false,
        write: true,
        kind: "consent",
        action: None,
    },
];

const SMS_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "read_sms",
        label: "读取短信（READ_SMS）",
        required: true,
        write: false,
        kind: "runtime",
        action: Some("permissions"),
    },
    PermissionSpec {
        key: "send_sms",
        label: "发送短信（SEND_SMS）",
        required: false,
        write: true,
        kind: "runtime",
        action: Some("permissions_write"),
    },
];

const DESKTOP_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "folder_read",
        label: "读取系统文件夹",
        required: true,
        write: false,
        kind: "folder",
        action: None,
    },
    PermissionSpec {
        key: "folder_write",
        label: "写入系统文件夹",
        required: false,
        write: true,
        kind: "folder",
        action: None,
    },
];

const LOCAL_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "folder_read",
        label: "读取授权文件夹（选择器）",
        required: true,
        write: false,
        kind: "folder",
        action: Some("folder"),
    },
    PermissionSpec {
        key: "folder_write",
        label: "写入授权文件夹",
        required: false,
        write: true,
        kind: "folder",
        action: Some("folder"),
    },
];

const TERMINAL_PERMS: &[PermissionSpec] = &[
    PermissionSpec {
        key: "shell",
        label: "系统 shell 可用",
        required: true,
        write: false,
        kind: "normal",
        action: None,
    },
    PermissionSpec {
        key: "terminal_exec",
        label: "执行命令（每次确认）",
        required: false,
        write: true,
        kind: "consent",
        action: None,
    },
];

/* ---------------- 17 条规格（顺序固定：Android → Windows → Mac → Linux） ---------------- */

pub const APP_SPECS: &[AppSpec] = &[
    AppSpec {
        id: "alarm",
        platform: "android",
        title: "闹钟和计时器",
        read_methods: &["alarm_next"],
        write_methods: &["set_alarm", "set_timer", "dismiss_alarm", "dismiss_timer"],
        permissions: ALARM_PERMS,
        requires_root: false,
        writes: true,
    },
    AppSpec {
        id: "usage",
        platform: "android",
        title: "安卓使用时间",
        read_methods: &["get_app_usage", "get_usage_events"],
        write_methods: &[],
        permissions: USAGE_PERMS,
        requires_root: false,
        writes: false,
    },
    AppSpec {
        id: "calendar",
        platform: "android",
        title: "安卓日历",
        read_methods: &["list_calendars", "list_calendar_events", "get_calendar_event"],
        write_methods: &[
            "create_calendar_event",
            "update_calendar_event",
            "delete_calendar_event",
        ],
        permissions: CALENDAR_PERMS,
        requires_root: false,
        writes: true,
    },
    AppSpec {
        id: "contacts",
        platform: "android",
        title: "通讯录",
        read_methods: &["search_contacts", "get_contact"],
        write_methods: &["create_contact", "update_contact", "delete_contact"],
        permissions: CONTACTS_PERMS,
        requires_root: false,
        writes: true,
    },
    AppSpec {
        id: "filesystem",
        platform: "android",
        title: "安卓文件系统",
        read_methods: &["files_roots", "files_list", "read_phone_file", "search_phone_files"],
        write_methods: &[
            "write_phone_file",
            "create_phone_folder",
            "delete_phone_file",
            "rename_phone_file",
        ],
        permissions: PHONE_FILES_PERMS,
        requires_root: true,
        writes: true,
    },
    AppSpec {
        id: "location",
        platform: "android",
        title: "安卓位置",
        read_methods: &["get_current_location", "get_last_known_location"],
        write_methods: &[],
        permissions: LOCATION_PERMS,
        requires_root: false,
        writes: false,
    },
    AppSpec {
        id: "notification",
        platform: "android",
        title: "通知",
        read_methods: &["list_recent_notifications"],
        write_methods: &["dismiss_notification", "dismiss_all_notifications"],
        permissions: NOTIFICATION_PERMS,
        requires_root: false,
        writes: true,
    },
    AppSpec {
        id: "sms",
        platform: "android",
        title: "短信",
        read_methods: &["list_sms_threads", "list_sms_messages", "search_sms"],
        write_methods: &["send_sms"],
        permissions: SMS_PERMS,
        requires_root: false,
        writes: true,
    },
    AppSpec {
        id: "win-desktop",
        platform: "windows",
        title: "Windows 桌面",
        read_methods: &["files_roots", "files_list", "read_desktop_file", "search_desktop_files"],
        write_methods: &[
            "write_desktop_file",
            "create_desktop_folder",
            "delete_desktop_file",
            "rename_desktop_file",
        ],
        permissions: DESKTOP_PERMS,
        requires_root: true,
        writes: true,
    },
    AppSpec {
        id: "win-documents",
        platform: "windows",
        title: "Windows 文稿",
        read_methods: &["files_roots", "files_list", "read_desktop_file", "search_desktop_files"],
        write_methods: &[
            "write_desktop_file",
            "create_desktop_folder",
            "delete_desktop_file",
            "rename_desktop_file",
        ],
        permissions: DESKTOP_PERMS,
        requires_root: true,
        writes: true,
    },
    AppSpec {
        id: "win-downloads",
        platform: "windows",
        title: "Windows 下载",
        read_methods: &["files_roots", "files_list", "read_desktop_file", "search_desktop_files"],
        write_methods: &[
            "write_desktop_file",
            "create_desktop_folder",
            "delete_desktop_file",
            "rename_desktop_file",
        ],
        permissions: DESKTOP_PERMS,
        requires_root: true,
        writes: true,
    },
    AppSpec {
        id: "win-local",
        platform: "windows",
        title: "Windows 本地文件",
        read_methods: &["files_roots", "files_list", "read_desktop_file", "search_desktop_files"],
        write_methods: &[
            "write_desktop_file",
            "create_desktop_folder",
            "delete_desktop_file",
            "rename_desktop_file",
        ],
        permissions: LOCAL_PERMS,
        requires_root: true,
        writes: true,
    },
    AppSpec {
        id: "win-terminal",
        platform: "windows",
        title: "Windows 命令行",
        read_methods: &[],
        write_methods: &["run_terminal_command"],
        permissions: TERMINAL_PERMS,
        requires_root: false,
        writes: true,
    },
    AppSpec {
        id: "mac-desktop",
        platform: "mac",
        title: "Mac 桌面",
        read_methods: &["files_roots", "files_list", "read_desktop_file", "search_desktop_files"],
        write_methods: &[
            "write_desktop_file",
            "create_desktop_folder",
            "delete_desktop_file",
            "rename_desktop_file",
        ],
        permissions: DESKTOP_PERMS,
        requires_root: true,
        writes: true,
    },
    AppSpec {
        id: "mac-terminal",
        platform: "mac",
        title: "Mac 命令行",
        read_methods: &[],
        write_methods: &["run_terminal_command"],
        permissions: TERMINAL_PERMS,
        requires_root: false,
        writes: true,
    },
    AppSpec {
        id: "linux-desktop",
        platform: "linux",
        title: "Linux 桌面",
        read_methods: &["files_roots", "files_list", "read_desktop_file", "search_desktop_files"],
        write_methods: &[
            "write_desktop_file",
            "create_desktop_folder",
            "delete_desktop_file",
            "rename_desktop_file",
        ],
        permissions: DESKTOP_PERMS,
        requires_root: true,
        writes: true,
    },
    AppSpec {
        id: "linux-documents",
        platform: "linux",
        title: "Linux 文稿",
        read_methods: &["files_roots", "files_list", "read_desktop_file", "search_desktop_files"],
        write_methods: &[
            "write_desktop_file",
            "create_desktop_folder",
            "delete_desktop_file",
            "rename_desktop_file",
        ],
        permissions: DESKTOP_PERMS,
        requires_root: true,
        writes: true,
    },
];

/* ---------------- 查询 / 合并 ---------------- */

pub fn current_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "browser"
    }
}

pub fn find(id: &str) -> Option<&'static AppSpec> {
    APP_SPECS.iter().find(|s| s.id == id)
}

pub fn enabled_for(enabled: &EnabledMap, id: &str) -> bool {
    enabled.get(id).copied().unwrap_or(false)
}

pub fn flag_for(flags: &FlagMap, id: &str) -> bool {
    flags.get(id).copied().unwrap_or(false)
}

pub fn method_kind(spec: &AppSpec, method: &str) -> Option<MethodKind> {
    if spec.read_methods.contains(&method) {
        Some(MethodKind::Read)
    } else if spec.write_methods.contains(&method) {
        Some(MethodKind::Write)
    } else {
        None
    }
}

/// 17 条固定顺序的状态（非本机平台 → unsupported；本机但没有原生事实 → unknown）。
///
/// `enabled` / `ai` / `write` 是 `app_meta` 里的三份意图；有效值在这里统一计算。
pub fn build_statuses(
    native: Option<&NativeStateFile>,
    enabled: &EnabledMap,
    ai: &FlagMap,
    write: &FlagMap,
) -> Vec<ConnectedAppStatus> {
    let updated_at = native.and_then(|s| s.updated_at.as_deref());
    APP_SPECS
        .iter()
        .map(|spec| {
            let app = native.and_then(|s| s.apps.get(spec.id));
            build_status(
                spec,
                app,
                enabled_for(enabled, spec.id),
                flag_for(ai, spec.id),
                flag_for(write, spec.id),
                updated_at,
            )
        })
        .collect()
}

pub fn build_status(
    spec: &AppSpec,
    native: Option<&NativeAppStatus>,
    enabled: bool,
    ai_intent: bool,
    write_intent: bool,
    updated_at: Option<&str>,
) -> ConnectedAppStatus {
    build_status_for_platform(
        spec,
        native,
        enabled,
        ai_intent,
        write_intent,
        current_platform(),
        updated_at,
    )
}

/// 平台显式传入的版本：单测可在任意 host 上验证 Android/桌面公式（不依赖 current_platform）。
pub fn build_status_for_platform(
    spec: &AppSpec,
    native: Option<&NativeAppStatus>,
    enabled: bool,
    ai_intent: bool,
    write_intent: bool,
    platform: &str,
    updated_at: Option<&str>,
) -> ConnectedAppStatus {
    let platform_ok = spec.platform == platform;
    if !platform_ok {
        return ConnectedAppStatus::unsupported(spec, "当前平台不支持");
    }

    let supported = native.and_then(|n| n.supported).unwrap_or(true);
    let available = native.and_then(|n| n.available).unwrap_or(true);
    let detail = native.and_then(|n| n.detail.clone());

    let permissions: Vec<ConnectedAppPermission> = spec
        .permissions
        .iter()
        .map(|p| ConnectedAppPermission {
            key: p.key.to_string(),
            label: p.label.to_string(),
            granted: native_granted(native, p.key),
            required: p.required,
            write: p.write,
            kind: p.kind.to_string(),
            action: p.action.map(|s| s.to_string()),
        })
        .collect();

    let roots: Vec<ConnectedAppRoot> = native
        .map(|n| {
            n.roots
                .iter()
                .map(|r| ConnectedAppRoot {
                    id: r.id.clone(),
                    label: r.label.clone(),
                    path: r.path.clone(),
                    writable: r.writable,
                })
                .collect()
        })
        .unwrap_or_default();

    let granted = spec
        .permissions
        .iter()
        .filter(|p| p.required)
        .all(|p| native_granted(native, p.key));

    let availability = if native.is_none() {
        "unknown"
    } else if !available {
        "unavailable"
    } else if !granted || (spec.requires_root && roots.is_empty()) {
        "partial"
    } else {
        "available"
    };

    let connected = enabled && supported && availability == "available";
    let writable = native
        .map(|n| native_write_ready(spec, n, &roots))
        .unwrap_or(false);
    let ai_enabled = connected && ai_intent;
    // plan §13.3：意图只是意图，有效值还要求原生写能力齐备。
    let write_allowed = connected && write_intent && writable;

    let mut capabilities: Vec<String> = spec.read_methods.iter().map(|m| m.to_string()).collect();
    if write_allowed {
        capabilities.extend(spec.write_methods.iter().map(|m| m.to_string()));
    }

    let reason = match availability {
        "unavailable" => Some(
            detail
                .clone()
                .unwrap_or_else(|| "系统能力不可用".to_string()),
        ),
        "unknown" => Some("正在检测系统授权".to_string()),
        "partial" => Some(if !granted {
            "缺少必要权限".to_string()
        } else {
            "还没有可用的文件夹".to_string()
        }),
        _ => None,
    };

    ConnectedAppStatus {
        id: spec.id.to_string(),
        platform: spec.platform.to_string(),
        supported,
        availability: availability.to_string(),
        enabled,
        connected,
        ai_enabled,
        write_allowed,
        granted,
        writable,
        permissions,
        roots,
        capabilities,
        reason,
        detail,
        last_checked_at: if native.is_some() {
            updated_at.map(|s| s.to_string())
        } else {
            None
        },
    }
}

fn native_granted(native: Option<&NativeAppStatus>, key: &str) -> bool {
    native
        .map(|n| n.permissions.iter().any(|p| p.key == key && p.granted))
        .unwrap_or(false)
}

/// 原生写能力是否就绪（plan §13.3 的 nativeWriteReady）。
fn native_write_ready(
    spec: &AppSpec,
    native: &NativeAppStatus,
    roots: &[ConnectedAppRoot],
) -> bool {
    if !spec.writes {
        return false;
    }
    let has = |key: &str| native_granted(Some(native), key);
    match spec.id {
        "calendar" => has("write_calendar"),
        "contacts" => has("write_contacts"),
        "sms" => has("send_sms"),
        "notification" => has("notification_access"),
        "filesystem" => roots.iter().any(|r| r.writable),
        "alarm" => has("clock_app"),
        "win-desktop" | "win-documents" | "win-downloads" | "win-local" | "mac-desktop"
        | "linux-desktop" | "linux-documents" => roots.iter().any(|r| r.writable),
        "win-terminal" | "mac-terminal" => native.available.unwrap_or(false),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::connected_apps::models::{NativePermission, NativeRoot};

    fn native_with(perms: &[(&str, bool)], roots: Vec<NativeRoot>) -> NativeAppStatus {
        NativeAppStatus {
            supported: Some(true),
            available: Some(true),
            detail: None,
            permissions: perms
                .iter()
                .map(|(key, granted)| NativePermission {
                    key: (*key).to_string(),
                    granted: *granted,
                })
                .collect(),
            roots,
            capabilities: Vec::new(),
        }
    }

    #[test]
    fn app_specs_cover_all_17_ids() {
        assert_eq!(APP_SPECS.len(), 17);
        let mut ids: Vec<&str> = APP_SPECS.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 17);
    }

    #[test]
    fn disabled_is_not_connected() {
        let spec = find("calendar").unwrap();
        let native = native_with(&[("read_calendar", true)], Vec::new());
        let status = build_status_for_platform(spec, Some(&native), false, true, true, "android", None);
        assert_eq!(status.availability, "available");
        assert!(!status.connected);
        assert!(!status.ai_enabled);
        assert!(!status.write_allowed);
    }

    #[test]
    fn missing_required_permission_is_partial() {
        let spec = find("calendar").unwrap();
        let native = native_with(&[("read_calendar", false)], Vec::new());
        let status = build_status_for_platform(spec, Some(&native), true, true, false, "android", None);
        assert_eq!(status.availability, "partial");
        assert!(!status.connected);
    }

    #[test]
    fn optional_write_missing_still_connected() {
        let spec = find("calendar").unwrap();
        let native = native_with(&[("read_calendar", true), ("write_calendar", false)], Vec::new());
        let status = build_status_for_platform(spec, Some(&native), true, true, true, "android", None);
        assert!(status.connected);
        assert!(status.ai_enabled);
        assert!(!status.write_allowed);
        assert!(!status.capabilities.contains(&"create_calendar_event".to_string()));
    }

    #[test]
    fn ai_requires_connected_and_intent() {
        // 有效值 = enabled && connected && AI 意图；缺权限时即使意图为 true 也是 false。
        let spec = find("calendar").unwrap();
        let native = native_with(&[("read_calendar", false)], Vec::new());
        let status = build_status_for_platform(spec, Some(&native), true, true, true, "android", None);
        assert!(!status.ai_enabled);
        assert!(!status.connected);
    }

    #[test]
    fn write_requires_intent_even_when_native_ready() {
        let spec = find("calendar").unwrap();
        let native = native_with(
            &[("read_calendar", true), ("write_calendar", true)],
            Vec::new(),
        );
        let without_intent =
            build_status_for_platform(spec, Some(&native), true, true, false, "android", None);
        assert!(without_intent.writable);
        assert!(!without_intent.write_allowed);
        assert!(!without_intent
            .capabilities
            .contains(&"create_calendar_event".to_string()));

        let with_intent =
            build_status_for_platform(spec, Some(&native), true, true, true, "android", None);
        assert!(with_intent.write_allowed);
        assert!(with_intent
            .capabilities
            .contains(&"create_calendar_event".to_string()));
    }

    #[test]
    fn filesystem_needs_root() {
        let spec = find("filesystem").unwrap();
        let no_root = native_with(&[("saf_tree", true)], Vec::new());
        let status = build_status_for_platform(spec, Some(&no_root), true, true, true, "android", None);
        assert_eq!(status.availability, "partial");
        assert!(!status.connected);

        let with_root = native_with(
            &[("saf_tree", true), ("saf_tree_write", true)],
            vec![NativeRoot {
                id: "filesystem:default".into(),
                label: "Demo".into(),
                path: None,
                writable: true,
            }],
        );
        let status = build_status_for_platform(spec, Some(&with_root), true, true, true, "android", None);
        assert!(status.connected);
        assert!(status.ai_enabled);
        assert!(status.write_allowed);
    }

    #[test]
    fn unknown_method_rejected() {
        let spec = find("calendar").unwrap();
        assert!(method_kind(spec, "create_calendar_event").is_some());
        assert!(method_kind(spec, "not_a_method").is_none());
    }
}
