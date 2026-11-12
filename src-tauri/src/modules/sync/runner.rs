//! 同步执行器：一次会话从「选路」到「记结果」。
//!
//! 选路是**两端各自算出来的、结论必然一致**的：设备号小的那台当拨号侧（局域网广播找人、
//! 打洞、中继都是它先动），大的那台等它上门。这样不需要任何一次额外的「谁先连」协商，
//! 也不会出现两边同时抢连。
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{params, Connection};

use crate::error::{ReinError, Result};
use crate::modules::ai::models::OnlineServiceSettings;

use super::{blobs::BlobStore, crypto, identity::Identity, meta_del, meta_get, meta_set, protocol, transport};

/// 一次会话的结果（写进 sync_peers / sync_meta，也回报给界面）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStats {
    pub peer: String,
    pub peer_name: String,
    pub path: String,
    pub path_label: String,
    pub applied: usize,
    pub conflicts: usize,
    pub unresolved: usize,
    pub up: i64,
    pub down: i64,
    pub ms: i64,
    pub notes: Vec<String>,
}

/// 已配对的一台设备。
#[derive(Debug, Clone)]
pub struct Peer {
    pub device: String,
    pub name: String,
    pub public: [u8; 32],
}

fn err(msg: impl Into<String>) -> ReinError {
    ReinError::Message(msg.into())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 在线服务基地址：与更新、模型网关共用 app_meta 的 online_service_v1。
///
/// 走 `OnlineServiceSettings` 反序列化，而不是手写键名：那份结构体带
/// `#[serde(rename_all = "camelCase")]`，落库的键是 `baseUrl`。这里曾经照着字段名写成
/// `base_url` 去取，结果恒为空串 —— 开码、报码、同步一律报「还没配在线服务地址」。
/// 让键名只有结构体一处定义，这类漂移就不会再发生。
pub fn server_base(conn: &Connection) -> String {
    let raw = crate::db::meta_get(conn, "online_service_v1").unwrap_or_default();
    // 解不出来 = 还没配过（或存的不成形）→ 空串，由调用方报那句指路的话
    let Ok(settings) = serde_json::from_str::<OnlineServiceSettings>(&raw) else {
        return String::new();
    };
    settings.base_url.trim().trim_end_matches('/').to_string()
}

/// 本机所在同步组的房间号（配对时交换；没有就是还没配对）。
pub fn room(conn: &Connection) -> Option<String> {
    meta_get(conn, "group_id").filter(|s| !s.is_empty())
}

/// 组密钥（配对时由两端各自用 X25519 + 一次性同步码推出来，服务器不知道）。
pub fn group_secret(conn: &Connection) -> Option<[u8; 32]> {
    let raw = meta_get(conn, "group_secret")?;
    let bytes = B64.decode(raw.trim()).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// 列出已配对设备。
pub fn peers(conn: &Connection) -> Result<Vec<Peer>> {
    let mut stmt = conn.prepare("SELECT device, name, x25519_pub FROM sync_peers ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (device, name, pub_b64) = row?;
        let bytes = B64.decode(pub_b64.trim()).unwrap_or_default();
        if bytes.len() != 32 {
            continue; // 公钥坏了：跳过这台，别让它把整轮同步带崩
        }
        let mut public = [0u8; 32];
        public.copy_from_slice(&bytes);
        out.push(Peer {
            device,
            name,
            public,
        });
    }
    Ok(out)
}

/// 把一台设备写进对端表（配对成功时调用）。
pub fn remember_peer(conn: &Connection, device: &str, name: &str, public: &[u8; 32], room_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_peers (device, name, x25519_pub, group_id, last_seq_sent, last_seq_ack) \
         VALUES (?1, ?2, ?3, ?4, 0, 0) \
         ON CONFLICT(device) DO UPDATE SET name = ?2, x25519_pub = ?3, group_id = ?4",
        params![device, name, B64.encode(public), room_id],
    )?;
    Ok(())
}

/// 跑一台设备的一次会话。
pub fn run_once(
    conn: &Connection,
    store: &BlobStore,
    me: &Identity,
    peer: &Peer,
    secret: &[u8; 32],
    base_url: &str,
    room_id: &str,
) -> Result<RunStats> {
    // 拨号侧由设备号定死，两端结论一致（见模块头）
    let dial = me.device_id.as_str() < peer.device.as_str();
        let ep = transport::Endpoint::new(base_url.to_string(), room_id.to_string(), me.device_id.clone(), dial);
    let started = Instant::now();
    let (ready, notes) = if dial {
        transport::connect(&ep)?
    } else {
        transport::accept(&ep, Duration::from_millis(2500))?
    };
    let path = ready.path;
    let hint = ready.peer_hint.clone();
    let mut link = ready.link;
    let outcome = protocol::run(
        &mut *link,
        conn,
        store,
        me,
        &protocol::Peer {
            device: peer.device.clone(),
            name: peer.name.clone(),
            public: peer.public,
        },
        secret,
    )?;
    let (up, down) = link.stats();
    let ms = started.elapsed().as_millis() as i64;

    conn.execute(
        "UPDATE sync_peers SET last_seen = ?2, path = ?3, last_seq_sent = ?4 WHERE device = ?1",
        params![peer.device, now_ms(), path.as_str(), outcome.sent_to],
    )?;
    meta_set(conn, "last_path", path.as_str())?;
    meta_set(conn, "last_at", &now_ms().to_string())?;
    meta_set(conn, "last_up", &up.to_string())?;
    meta_set(conn, "last_down", &down.to_string())?;

    let mut notes = notes;
    if hint != "relay" {
        notes.push(format!("对端地址 {hint}"));
    }

    Ok(RunStats {
        peer: peer.device.clone(),
        peer_name: peer.name.clone(),
        path: path.as_str().to_string(),
        path_label: path.label().to_string(),
        applied: outcome.applied,
        conflicts: outcome.conflicts,
        unresolved: outcome.unresolved,
        up,
        down,
        ms,
        notes,
    })
}

/// 跑所有已配对设备（一台失败不影响下一台）。
pub fn run_all(
    conn: &Connection,
    store: &BlobStore,
    me: &Identity,
) -> Result<(Vec<RunStats>, Vec<String>)> {
    let secret = group_secret(conn).ok_or_else(|| err("本机还没有加入同步组（先去配对）"))?;
    let room_id = room(conn).ok_or_else(|| err("缺少房间号（重新配对一次）"))?;
    let base = server_base(conn);
    let mut stats = Vec::new();
    let mut errors = Vec::new();
    for peer in peers(conn)? {
        match run_once(conn, store, me, &peer, &secret, &base, &room_id) {
            Ok(s) => stats.push(s),
            Err(e) => errors.push(format!("{}：{e}", if peer.name.is_empty() { peer.device.clone() } else { peer.name.clone() })),
        }
    }
    if !errors.is_empty() {
        meta_set(conn, "last_error", &errors.join("；"))?;
    } else {
        // 全部对端都成功：清掉上一轮留下的错误，别让旧失败一直挂在设备页上。
        meta_del(conn, "last_error")?;
    }
    Ok((stats, errors))
}

/// 记一次配对：两端各自推出来的组密钥 + 房间号。
pub fn accept_pairing(conn: &Connection, me: &Identity, peer_device: &str, peer_pub_b64: &str, code: &str, room_id: &str) -> Result<Peer> {
    let bytes = B64.decode(peer_pub_b64.trim()).map_err(|_| err("对端公钥不是合法 base64"))?;
    if bytes.len() != 32 {
        return Err(err("对端公钥长度不对"));
    }
    let mut public = [0u8; 32];
    public.copy_from_slice(&bytes);
    let salt = code.trim().to_uppercase();
    let secret = crypto::derive_group_secret(&me.secret, &public, &salt);
    meta_set(conn, "group_secret", &B64.encode(secret))?;
    meta_set(conn, "group_id", room_id)?;
    meta_set(conn, "paired_at", &now_ms().to_string())?;
    // 名字先留空：第一次同步时会话里会互换（HELLO 带 name）
    remember_peer(conn, peer_device, "", &public, room_id)?;
    Ok(Peer {
        device: peer_device.to_string(),
        name: String::new(),
        public,
    })
}

/// 生成一个 128 位房间号（配对时由报码方生成，服务器只转发）。
pub fn new_room() -> String {
    crypto::random_hex(16)
}

// 这里曾有 `rendezvous_addr`（由 base_url 推会合地址）、`last_run`（把 last_* 拼成 JSON）、
// `fingerprint`（转手 identity::fingerprint）—— 三个都没有调用方：
// 会合地址由 `transport::Endpoint` 自己解析，`last_run` 与 `sync_status` 现读的键重复，
// `fingerprint` 只是换个名字转发。2026-09-30 一并删除，避免同一份逻辑留两条实现。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;
    use rusqlite::Connection;

    /// 内存库 + 完整迁移：`server_base` 读的是 app_meta 表，表不存在会静默落回空串，
    /// 那会让下面几条断言全部「通过」得毫无意义。
    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        conn
    }

    /// 契约 1a：从没配过在线服务（app_meta 里没有 online_service_v1）→ 空串。
    /// 调用方（开码、报码、同步）据此报「还没配在线服务地址」，这句指路的话不能丢。
    #[test]
    fn server_base_is_empty_when_never_configured() {
        let conn = conn();
        assert_eq!(server_base(&conn), "");
    }

    /// 契约 1b：存的是非 JSON 文本（历史脏数据 / 手改过的库）→ 也是空串，
    /// 不 panic、不把原文当地址用。
    #[test]
    fn server_base_is_empty_when_stored_value_is_not_json() {
        let conn = conn();
        crate::db::meta_set(&conn, "online_service_v1", "http://1.2.3.4:8787").unwrap();
        assert_eq!(server_base(&conn), "");
    }

    /// 契约 2：真实形态的 JSON（`OnlineServiceSettings` 的 camelCase 落库形态）
    /// → 取回 baseUrl。这条钉的就是那个缺陷：手写 `base_url` 取键时恒为空串，
    /// 而库里的键是 `baseUrl`。
    #[test]
    fn server_base_reads_camel_case_base_url_from_stored_json() {
        let conn = conn();
        crate::db::meta_set(
            &conn,
            "online_service_v1",
            r#"{"baseUrl":"http://1.2.3.4:8787","apiKey":"k","savedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(server_base(&conn), "http://1.2.3.4:8787");
    }

    /// 契约 3：地址末尾带斜杠 → 返回时去掉，免得调用方拼出 `...:8787//v1/...`。
    #[test]
    fn server_base_strips_trailing_slash() {
        let conn = conn();
        crate::db::meta_set(
            &conn,
            "online_service_v1",
            r#"{"baseUrl":"http://1.2.3.4:8787/","apiKey":"k","savedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(server_base(&conn), "http://1.2.3.4:8787");
    }
}
