//! 同步域的数据结构（跨 IPC 的那些）。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::Result;

use super::{meta_get, meta_set};

/// 一台已配对的设备。`path` 是上次同步走成的传输路径（`lan` / `punch` / `relay`）——
/// 界面上如实显示它，用户才看得到「打洞到底通没通」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPeerInfo {
    pub device: String,
    pub short: String,
    pub name: String,
    pub fingerprint: String,
    pub path: Option<String>,
    pub last_seen: Option<i64>,
    pub seq_sent: i64,
    pub seq_ack: i64,
}

/// 配对第一步的回执：念给另一台设备的短码。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairOffer {
    pub code: String,
    pub expires_at: i64,
}

/// 配对过程中的状态（开码侧轮询、报码侧一次性拿到对端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStatus {
    pub pending: bool,
    pub peer: Option<SyncPeerInfo>,
    pub room: Option<String>,
}

/// 本机同步状态：设置页那一张卡片的全部输入。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub device_id: String,
    pub device_short: String,
    pub device_name: String,
    /// 公钥指纹（8 字节 hex，给人核对两台设备是不是同一对）
    pub fingerprint: String,
    /// 是否已经入组（入组 = 至少配过一台设备）
    pub in_group: bool,
    pub group_id: Option<String>,
    pub peers: Vec<SyncPeerInfo>,
    /// 对象总数 / 墓碑数 / 复制日志长度
    pub objects: i64,
    pub tombstones: i64,
    pub log_len: i64,
    /// 待处理的本地改动（脏队列积压）
    pub pending: i64,
    /// 还差几张表没补录存量（首次运行或表结构刚变过；0 = 已补齐）
    pub stale_tables: i64,
    pub conflicts: i64,
    pub last_at: Option<i64>,
    pub last_path: Option<String>,
    pub last_up: i64,
    pub last_down: i64,
}

/// 同步设置（存 `sync_meta`，与业务数据一起同步没有意义，因此只在本机）。
///
/// 「打开应用时自动同步」由 `sync/auto.rs` 的常驻线程读取；间隔是**两次自动同步之间
/// 的最小时间**，不是精确的定时器（线程每 30 秒看一次表，省电，也不跟手动同步抢）。
/// 目前实际生效的是 `auto` 与 `interval_min`；`media_over_cellular` / `auto_over_relay`
/// 是给媒体与中继策略预留的字段，默认值就是当前行为（大块照传、打洞不通落中继）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettings {
    /// 打开应用时自动同步
    pub auto: bool,
    /// 自动同步的最小间隔（分钟）
    pub interval_min: i64,
    /// 允许走蜂窝网络同步媒体（大块）
    pub media_over_cellular: bool,
    /// 打洞失败时自动落云端中继（关掉则只在局域网/打洞可用时同步）
    pub auto_over_relay: bool,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            auto: true,
            interval_min: 15,
            media_over_cellular: false,
            auto_over_relay: true,
        }
    }
}

/// `sync_set_settings` 的入参：只带要改的字段。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettingsPatch {
    pub auto: Option<bool>,
    pub interval_min: Option<i64>,
    pub media_over_cellular: Option<bool>,
    pub auto_over_relay: Option<bool>,
}

/// 设置落在 `sync_meta` 的这把键下（整个对象一个 JSON）。
const K_SETTINGS: &str = "settings";

/// 自动同步的最小间隔上限：一天。再长就不叫「自动」了，而失控的 0 / 负数会让线程
/// 每 30 秒都跑一轮同步 —— 在入口处夹住，别让坏值变成网络风暴。
const MAX_INTERVAL_MIN: i64 = 24 * 60;

impl SyncSettings {
    /// 读设置；没存过 / 存坏了都用默认值（默认 `auto = true`，与用户预期一致）。
    pub fn load(conn: &Connection) -> Self {
        meta_get(conn, K_SETTINGS)
            .and_then(|raw| serde_json::from_str::<Self>(&raw).ok())
            .unwrap_or_default()
    }

    /// 合并补丁并落库，返回合并后的完整设置（前端拿它对齐开关状态）。
    pub fn apply(conn: &Connection, patch: SyncSettingsPatch) -> Result<Self> {
        let mut next = Self::load(conn);
        if let Some(v) = patch.auto {
            next.auto = v;
        }
        if let Some(v) = patch.interval_min {
            next.interval_min = v.clamp(1, MAX_INTERVAL_MIN);
        }
        if let Some(v) = patch.media_over_cellular {
            next.media_over_cellular = v;
        }
        if let Some(v) = patch.auto_over_relay {
            next.auto_over_relay = v;
        }
        meta_set(conn, K_SETTINGS, &serde_json::to_string(&next)?)?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        conn
    }

    /// 默认值得是「启动就自动同步」：没存过设置的用户升级上来就生效。
    #[test]
    fn settings_default_to_auto_sync() {
        let s = SyncSettings::load(&conn());
        assert!(s.auto);
        assert_eq!(s.interval_min, 15);
    }

    /// 补丁只改传了的字段；间隔在入口处夹到 1 分钟..24 小时，坏值不会变成每次 30 秒的网络风暴。
    #[test]
    fn settings_patch_only_touches_given_fields_and_clamps_interval() {
        let conn = conn();
        let s = SyncSettings::apply(
            &conn,
            SyncSettingsPatch {
                auto: Some(false),
                interval_min: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!s.auto);
        assert_eq!(s.interval_min, 1);
        assert!(s.auto_over_relay, "没传的字段保持默认");

        let s = SyncSettings::apply(
            &conn,
            SyncSettingsPatch {
                interval_min: Some(99_999),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.interval_min, MAX_INTERVAL_MIN);
        assert!(!s.auto, "第二次补丁没提 auto，不该把它翻回默认值");

        // 落库的是整个对象：重新 load 与返回的一致
        let again = SyncSettings::load(&conn);
        assert_eq!(again.interval_min, MAX_INTERVAL_MIN);
        assert!(!again.auto);
    }
}
