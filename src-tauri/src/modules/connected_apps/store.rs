//! `app_meta` 持久化：连接同意、AI 使用意图、写入意图与 win-local 根；不新增表/迁移。
//!
//! 键名（与 plan §2.4/§13.3 一致）：
//! - `connected_apps.enabled.<app>` → `"true"` / `"false"`
//! - `connected_apps.ai.<app>` → AI 使用意图
//! - `connected_apps.write.<app>` → 写入意图（有效值还要看原生写能力）
//! - `connected_apps.local_roots` → JSON 字符串数组（仅 win-local，≤5）
//!
//! 有效值（`aiEnabled` / `writeAllowed`）由 `state::build_status` 计算，这里只存意图。

use rusqlite::Connection;

use crate::db::{meta_get, meta_set};
use crate::error::Result;

use super::models::ConnectedAppPatch;
use super::state::{self, EnabledMap, FlagMap};

pub(crate) const ENABLED_KEY_PREFIX: &str = "connected_apps.enabled.";
pub(crate) const AI_KEY_PREFIX: &str = "connected_apps.ai.";
pub(crate) const WRITE_KEY_PREFIX: &str = "connected_apps.write.";
pub(crate) const LOCAL_ROOTS_KEY: &str = "connected_apps.local_roots";
pub(crate) const MAX_LOCAL_ROOTS: usize = 5;

pub(crate) fn enabled_map(conn: &Connection) -> EnabledMap {
    state::APP_SPECS
        .iter()
        .map(|spec| {
            let key = format!("{ENABLED_KEY_PREFIX}{}", spec.id);
            let on = meta_get(conn, &key).as_deref() == Some("true");
            (spec.id.to_string(), on)
        })
        .collect()
}

fn flag_map(conn: &Connection, prefix: &str) -> FlagMap {
    state::APP_SPECS
        .iter()
        .map(|spec| {
            let key = format!("{prefix}{}", spec.id);
            let on = meta_get(conn, &key).as_deref() == Some("true");
            (spec.id.to_string(), on)
        })
        .collect()
}

pub(crate) fn ai_map(conn: &Connection) -> FlagMap {
    flag_map(conn, AI_KEY_PREFIX)
}

pub(crate) fn write_map(conn: &Connection) -> FlagMap {
    flag_map(conn, WRITE_KEY_PREFIX)
}

pub(crate) fn is_enabled(conn: &Connection, id: &str) -> bool {
    let key = format!("{ENABLED_KEY_PREFIX}{id}");
    meta_get(conn, &key).as_deref() == Some("true")
}

pub(crate) fn is_ai_enabled(conn: &Connection, id: &str) -> bool {
    let key = format!("{AI_KEY_PREFIX}{id}");
    meta_get(conn, &key).as_deref() == Some("true")
}

pub(crate) fn is_write_allowed(conn: &Connection, id: &str) -> bool {
    let key = format!("{WRITE_KEY_PREFIX}{id}");
    meta_get(conn, &key).as_deref() == Some("true")
}

pub(crate) fn set_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
    let key = format!("{ENABLED_KEY_PREFIX}{id}");
    meta_set(conn, &key, if enabled { "true" } else { "false" })
}

pub(crate) fn set_ai_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
    let key = format!("{AI_KEY_PREFIX}{id}");
    meta_set(conn, &key, if enabled { "true" } else { "false" })
}

pub(crate) fn set_write_allowed(conn: &Connection, id: &str, allowed: bool) -> Result<()> {
    let key = format!("{WRITE_KEY_PREFIX}{id}");
    meta_set(conn, &key, if allowed { "true" } else { "false" })
}

#[allow(dead_code)]
pub(crate) fn local_roots(conn: &Connection) -> Vec<String> {
    meta_get(conn, LOCAL_ROOTS_KEY)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn set_local_roots(conn: &Connection, roots: &[String]) -> Result<()> {
    let capped: Vec<String> = roots.iter().take(MAX_LOCAL_ROOTS).cloned().collect();
    let json = serde_json::to_string(&capped)?;
    meta_set(conn, LOCAL_ROOTS_KEY, &json)
}

/// 应用 `connected_app_update` 的补丁。
///
/// - `enabled:false`：清 AI/写入意图；`win-local` 清根（Android SAF 的释放由
///   `android::revoke` 负责）。
/// - `roots`：仅 `win-local`；整表替换（≤5）。picker 结果不要走这里。
///   写库前统一 canonicalize / 去重 / 拒绝磁盘根与主目录祖先（`paths::normalize_local_roots`）。
/// - `ai_enabled` / `write_allowed`：只落意图；有效值由 status 计算。
pub(crate) fn apply_patch(
    conn: &Connection,
    app_id: &str,
    patch: &ConnectedAppPatch,
    home: Option<&std::path::Path>,
) -> Result<()> {
    if patch.roots.is_some() && app_id != "win-local" {
        return Err(crate::error::ReinError::coded(
            "connected_app_bad_request",
            "roots 只适用于 win-local",
        ));
    }
    // 先校验再写任何键：非法根不能留下半份 patch。
    let normalized_roots = match &patch.roots {
        Some(roots) => Some(super::paths::normalize_local_roots(roots, home)?),
        None => None,
    };
    if let Some(enabled) = patch.enabled {
        set_enabled(conn, app_id, enabled)?;
        if !enabled {
            // plan §1.6：断开连接时清 AI/写意图（运行时权限保留）。
            set_ai_enabled(conn, app_id, false)?;
            set_write_allowed(conn, app_id, false)?;
            if app_id == "win-local" {
                set_local_roots(conn, &[])?;
            }
        }
    }
    if let Some(roots) = normalized_roots {
        set_local_roots(conn, &roots)?;
    }
    if let Some(ai) = patch.ai_enabled {
        set_ai_enabled(conn, app_id, ai)?;
    }
    if let Some(write) = patch.write_allowed {
        set_write_allowed(conn, app_id, write)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn temp_root(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "rein-connected-apps-store-{tag}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn disconnect_clears_local_roots() {
        let conn = conn();
        let root = temp_root("disconnect");
        apply_patch(
            &conn,
            "win-local",
            &ConnectedAppPatch {
                enabled: Some(true),
                roots: Some(vec![root.clone()]),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(is_enabled(&conn, "win-local"));
        assert_eq!(local_roots(&conn), vec![root]);

        apply_patch(
            &conn,
            "win-local",
            &ConnectedAppPatch {
                enabled: Some(false),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(!is_enabled(&conn, "win-local"));
        assert!(local_roots(&conn).is_empty());
    }

    #[test]
    fn intents_are_persisted_and_cleared_on_disconnect() {
        let conn = conn();
        apply_patch(
            &conn,
            "calendar",
            &ConnectedAppPatch {
                enabled: Some(true),
                ai_enabled: Some(true),
                write_allowed: Some(true),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(is_enabled(&conn, "calendar"));
        assert!(is_ai_enabled(&conn, "calendar"));
        assert!(is_write_allowed(&conn, "calendar"));

        apply_patch(
            &conn,
            "calendar",
            &ConnectedAppPatch {
                enabled: Some(false),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(!is_enabled(&conn, "calendar"));
        assert!(!is_ai_enabled(&conn, "calendar"));
        assert!(!is_write_allowed(&conn, "calendar"));
    }

    #[test]
    fn intent_maps_cover_all_apps_and_default_false() {
        let conn = conn();
        let ai = ai_map(&conn);
        let write = write_map(&conn);
        assert_eq!(ai.len(), state::APP_SPECS.len());
        assert_eq!(write.len(), state::APP_SPECS.len());
        assert!(!state::flag_for(&ai, "calendar"));
        assert!(!state::flag_for(&write, "calendar"));
    }

    #[test]
    fn roots_are_capped() {
        let conn = conn();
        let roots: Vec<String> = (0..8).map(|i| temp_root(&format!("cap-{i}"))).collect();
        apply_patch(
            &conn,
            "win-local",
            &ConnectedAppPatch {
                roots: Some(roots),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(local_roots(&conn).len(), MAX_LOCAL_ROOTS);
    }

    #[test]
    fn rejects_home_ancestor_before_persisting() {
        let conn = conn();
        let root = std::env::temp_dir().canonicalize().unwrap();
        let home = root.join("rein-fake-home");
        let err = apply_patch(
            &conn,
            "win-local",
            &ConnectedAppPatch {
                roots: Some(vec![root.to_string_lossy().to_string()]),
                ..Default::default()
            },
            Some(&home),
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_path_denied");
        assert!(local_roots(&conn).is_empty());
    }

    #[test]
    fn rejects_missing_root_before_persisting() {
        let conn = conn();
        let missing = std::env::temp_dir().join("rein-connected-apps-missing-root");
        let err = apply_patch(
            &conn,
            "win-local",
            &ConnectedAppPatch {
                roots: Some(vec![missing.to_string_lossy().to_string()]),
                ..Default::default()
            },
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_bad_request");
        assert!(local_roots(&conn).is_empty());
    }

    #[test]
    fn corrupt_json_falls_back_to_empty() {
        let conn = conn();
        meta_set(&conn, LOCAL_ROOTS_KEY, "{not json").unwrap();
        assert!(local_roots(&conn).is_empty());
    }
}
