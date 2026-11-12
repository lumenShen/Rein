//! 会话协议：一次同步怎么谈。
//!
//! 两端各自跑同一条流程（`run`），**谁是驱动方**由设备号字典序定死 —— 驱动方先推自己的
//! 改动、被推方先听；轮到对方时反过来。这样两端的开口次序是确定的，不会互相等。
//!
//! ```text
//! 握手（明文 HELLO，带 HMAC 证明持有组密钥）
//!   ↓ 之后每一帧都加密
//! 推方：MANIFEST（一批对象的元信息）→ 收方：WANT（要哪些）
//!      → 推方：DATA×n（大对象分块）→ 收方：WANT（还缺哪些 blob）
//!      → 推方：BLOB×n → 收方：DONE（应用了几条、哪些引用没解开）
//!      → 推方：ACK（推进游标）→ 下一批，直到没有新对象
//! ```
//!
//! 三处刻意的设计：
//!
//! 1. **清单只带元信息**：收方按 `hlc` 就能判断「这条我更新，不要」，省掉整条对象的往返
//!    —— 第二次同步起，绝大多数对象只是清单里的一行。
//! 2. **引用解不开不算失败**：收方在 DONE 里报 `pending`，推方把游标退回到最早那条之前，
//!    下一轮重发。外键指向的对象可能排在日志后面，靠这个环收敛。
//! 3. **blob 第二轮才要**：对象里只有 `{__blob}` 引用，收方拿到对象后才知道缺哪些字节。

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{ReinError, Result};

use super::apply::{self, ApplyStats, RemoteObject};
use super::blobs::BlobStore;
use super::crypto::{self, SessionCrypto};
use super::identity::Identity;

/// 一次同步的链路。实现有三条：局域网 UDP、打洞 UDP、云端中继（HTTP 长轮询）。
/// 帧的可靠性由链路自己负责（UDP 自己 ACK 重传，中继靠 TCP）。
pub trait Link {
    fn send(&mut self, bytes: &[u8]) -> Result<()>;
    /// 收一帧；超时返回 None（调用方决定是重试还是换路）
    fn recv(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>>;
    /// 走成了哪条路：`lan` / `punch` / `relay`
    fn path(&self) -> String;
    /// (上行字节, 下行字节)
    fn stats(&self) -> (i64, i64);
}

/// 收方为一个正在进行的大对象攒的分块：(uuid, kind, hlc, device, deleted, 总长, 缓冲)。
/// 按位置取用只发生在一个函数里，所以用元组而不是结构体。
type ChunkBuf = (String, String, i64, String, i64, usize, Vec<u8>);

/// 对端（配对时记下来的那台）。
#[derive(Debug, Clone)]
pub struct Peer {
    pub device: String,
    /// 对端设备名（配对时从 `sync_peers` 读出来）：协议面字段，界面设备列表已直接读表，
    /// 这里先留着 —— 删掉等于让「对端叫什么」在协议层消失。
    #[allow(dead_code)]
    pub name: String,
    pub public: [u8; 32],
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub path: String,
    pub applied: usize,
    pub conflicts: usize,
    pub unresolved: usize,
    /// 对象里有本机还没有的列（版本错开时如实计数）
    pub skipped_columns: usize,
    pub up: i64,
    pub down: i64,
    pub sent_to: i64,
    pub acked_to: i64,
}

/// 一帧最多这么大（blob 与对象都按它分块）。
///
/// 上限的约束来自中继档：整帧还要再 base64 一层塞进服务端的 256KiB 单帧
/// （明文预算 ≈192KiB），减去 JSON 信封与 AEAD 的固定开销后，分片本体只能取
/// 128KiB —— 再大，中继对任何超过一格的对象都必然报「单帧过大」，而中继是
/// 最后一档，没有更早的链路可退。
const CHUNK: usize = 128 * 1024;
/// 一批清单最多这么多对象。
const BATCH: usize = 256;
/// 远端报来的对象/blob 总长上限：正经数据到不了这个量级，超了就是对面在捣乱。
/// `vec![0u8; total]` 分配失败在 Rust 里是 abort（进程直接死），必须赶在分配前挡住。
const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
/// 引用解不开时最多重试几轮（剩下的留给下一次会话）。
const MAX_RETRY_ROUNDS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ObjMeta {
    u: String,
    k: String,
    h: i64,
    d: String,
    x: i64,
    n: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum Msg {
    Hello {
        device: String,
        name: String,
        #[serde(rename = "pub")]
        key: String,
        epoch: String,
        mac: String,
    },
    Manifest {
        to: i64,
        objects: Vec<ObjMeta>,
    },
    Want {
        #[serde(default)]
        objects: Vec<String>,
        #[serde(default)]
        blobs: Vec<String>,
    },
    Data {
        u: String,
        k: String,
        h: i64,
        d: String,
        x: i64,
        off: usize,
        total: usize,
        data: String,
    },
    Blob {
        b: String,
        off: usize,
        total: usize,
        data: String,
    },
    Done {
        to: i64,
        applied: usize,
        #[serde(default)]
        pending: Vec<String>,
    },
    Ack {
        to: i64,
    },
    Err {
        code: String,
        message: String,
    },
}

fn json<T: Serialize>(v: &T) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(v)?)
}

/// 帧 = `[u32 长度][密文]`；明文那一帧（HELLO 的应答）长度前缀一样，内容不加密。
fn write_frame(link: &mut dyn Link, crypto: Option<&mut SessionCrypto>, plain: &[u8]) -> Result<()> {
    let body = match crypto {
        Some(c) => c.seal(b"rein-sync-v1", plain)?,
        None => plain.to_vec(),
    };
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    link.send(&out)
}

fn read_frame(
    link: &mut dyn Link,
    crypto: Option<&mut SessionCrypto>,
    timeout: Duration,
) -> Result<Option<Vec<u8>>> {
    let raw = match link.recv(timeout)? {
        Some(v) => v,
        None => return Ok(None),
    };
    if raw.len() < 4 {
        return Err(ReinError::Message("帧太短".into()));
    }
    let len = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    if raw.len() < 4 + len {
        return Err(ReinError::Message("帧长度与内容不符".into()));
    }
    let body = &raw[4..4 + len];
    let plain = match crypto {
        Some(c) => c.open(b"rein-sync-v1", body)?,
        None => body.to_vec(),
    };
    Ok(Some(plain))
}

fn send_msg(link: &mut dyn Link, crypto: &mut SessionCrypto, msg: &Msg) -> Result<()> {
    trace("→", msg);
    write_frame(link, Some(crypto), &json(msg)?)
}

fn recv_msg(link: &mut dyn Link, crypto: &mut SessionCrypto, timeout: Duration) -> Result<Msg> {
    match read_frame(link, Some(crypto), timeout)? {
        Some(bytes) => {
            let msg: Msg = serde_json::from_slice(&bytes)?;
            trace("←", &msg);
            Ok(msg)
        }
        None => Err(ReinError::Message("对端没有回应".into())),
    }
}

/// 报文跟踪：`REIN_SYNC_DEBUG=1` 时把每一步打到 stderr。阶段错位这类问题只有
/// 把两端的序列摆在一起才看得清（谁在等谁），所以这条留着，不按临时调试删掉。
fn trace(dir: &str, msg: &Msg) {
    if std::env::var_os("REIN_SYNC_DEBUG").is_none() {
        return;
    }
    let what = match msg {
        Msg::Hello { device, .. } => format!("hello({})", &device[..8.min(device.len())]),
        Msg::Manifest { to, objects } => format!("manifest(to={to}, n={})", objects.len()),
        Msg::Want { objects, blobs } => format!("want(o={}, b={})", objects.len(), blobs.len()),
        Msg::Data { u, off, total, .. } => {
            format!("data({}, {off}/{total})", &u[..8.min(u.len())])
        }
        Msg::Blob { b, off, total, .. } => format!("blob({}, {off}/{total})", &b[..8.min(b.len())]),
        Msg::Done { to, applied, pending } => {
            format!("done(to={to}, applied={applied}, pending={})", pending.len())
        }
        Msg::Ack { to } => format!("ack(to={to})"),
        Msg::Err { code, .. } => format!("err({code})"),
    };
    eprintln!("[sync {:?} {dir}] {what}", std::thread::current().id());
}

/// 走完一次会话。任一步失败都直接返回错误，由调用方换下一条链路重试。
pub fn run(
    link: &mut dyn Link,
    conn: &Connection,
    store: &BlobStore,
    me: &Identity,
    peer: &Peer,
    secret: &[u8; 32],
) -> Result<Outcome> {
    // ---- 1 握手 ----
    let epoch = crypto::random_epoch();
    let hello = Msg::Hello {
        device: me.device_id.clone(),
        name: me.name.clone(),
        key: B64.encode(me.public),
        epoch: crypto::epoch_b64(&epoch),
        mac: crypto::hello_mac(secret, &me.device_id, &epoch),
    };
    write_frame(link, None, &json(&hello)?)?;

    let reply = read_frame(link, None, Duration::from_secs(15))?
        .ok_or_else(|| ReinError::Message("等不到对端握手".into()))?;
    let peer_hello: Msg = serde_json::from_slice(&reply)?;
    let (peer_device, peer_name, peer_key, peer_epoch, peer_mac) = match peer_hello {
        Msg::Hello {
            device,
            name,
            key,
            epoch,
            mac,
        } => (device, name, key, crypto::epoch_from_b64(&epoch)?, mac),
        other => {
            return Err(ReinError::Message(format!(
                "握手阶段收到别的消息：{other:?}"
            )))
        }
    };
    if peer_device != peer.device {
        return Err(ReinError::Message(format!(
            "对面自称 {peer_device}，但这台设备配的是 {}",
            peer.device
        )));
    }
    // 公钥钉死：配对时记下的是哪把，现在就必须是哪把（换了 = 冒充，或对面重装过要重新配对）
    let peer_pub: [u8; 32] = B64
        .decode(&peer_key)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ReinError::Message("对端公钥不是 32 字节".into()))?;
    if peer_pub != peer.public {
        return Err(ReinError::Message(
            "对端公钥与配对时记下的不一致，拒绝同步（需要重新配对）".into(),
        ));
    }
    if !crypto::hello_mac_ok(secret, &peer_device, &peer_epoch, &peer_mac) {
        return Err(ReinError::Message(
            "握手校验失败：对面没有组密钥（同步码不对，或有人冒充）".into(),
        ));
    }
    // 配对时只换了公钥，名字是空的；第一次会话握手带来名字，落库后设备页才不用
    // 一直显示「未命名设备」。空名字不覆盖已有名字（对端可能只是没设过）。
    let peer_name = peer_name.trim();
    if !peer_name.is_empty() {
        conn.execute(
            "UPDATE sync_peers SET name = ?2 WHERE device = ?1",
            rusqlite::params![peer.device, peer_name],
        )?;
    }
    let mut c = SessionCrypto::new(secret, &epoch, &peer_epoch);
    let driver = me.device_id < peer.device;
    if std::env::var_os("REIN_SYNC_DEBUG").is_some() {
        eprintln!(
            "[sync {:?}] 角色 {}：{}",
            std::thread::current().id(),
            &me.device_id[..8],
            if driver { "驱动（先推）" } else { "跟随（先收）" }
        );
    }
    let mut out = Outcome {
        path: link.path(),
        ..Default::default()
    };

    // ---- 2 两轮：驱动方先推，被推方先收 ----
    let first = if driver { push } else { pull };
    let second = if driver { pull } else { push };
    for round in 0..2 {
        let stats = if round == 0 { first } else { second }(link, &mut c, conn, store, peer)?;
        merge_stats(&mut out, stats);
    }

    out.sent_to = apply::cursor_sent(conn, &peer.device)?;
    out.acked_to = conn
        .query_row(
            "SELECT last_seq_ack FROM sync_peers WHERE device = ?1",
            [&peer.device],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let (up, down) = link.stats();
    out.up = up;
    out.down = down;
    Ok(out)
}

fn merge_stats(out: &mut Outcome, other: Outcome) {
    out.applied += other.applied;
    out.conflicts += other.conflicts;
    out.unresolved += other.unresolved;
    out.skipped_columns += other.skipped_columns;
}

/// 推：把本机游标之后的对象发给对方。
fn push(
    link: &mut dyn Link,
    c: &mut SessionCrypto,
    conn: &Connection,
    store: &BlobStore,
    peer: &Peer,
) -> Result<Outcome> {
    if std::env::var_os("REIN_SYNC_DEBUG").is_some() {
        eprintln!("[sync {:?}] 进入推阶段", std::thread::current().id());
    }
    let mut out = Outcome {
        path: link.path(),
        ..Default::default()
    };
    let mut cursor = apply::cursor_sent(conn, &peer.device)?;
    let mut retry: Vec<String> = Vec::new();
    let mut rounds = 0;
    loop {
        rounds += 1;
        let (mut objects, last) = apply::outbox(conn, cursor, BATCH)?;
        if !retry.is_empty() {
            // 上一轮对方说引用解不开的：这一轮带上（可能已经被跳过，那就再取一次）
            for uuid in &retry {
                if objects.iter().any(|o| &o.uuid == uuid) {
                    continue;
                }
                if let Some(obj) = apply::object_by_uuid(conn, uuid)? {
                    objects.push(obj);
                }
            }
        }
        if objects.is_empty() {
            // 没有更多要发的：退出循环，由下面的统一出口发阶段终止
            break;
        }

        let metas: Vec<ObjMeta> = objects
            .iter()
            .map(|o| ObjMeta {
                u: o.uuid.clone(),
                k: o.kind.clone(),
                h: o.hlc,
                d: o.device.clone(),
                x: i64::from(o.deleted),
                n: o.blob.len(),
            })
            .collect();
        send_msg(
            link,
            c,
            &Msg::Manifest {
                to: last,
                objects: metas,
            },
        )?;

        // 对方要哪些对象
        let want = match recv_msg(link, c, Duration::from_secs(30))? {
            Msg::Want { objects, blobs } if blobs.is_empty() => objects,
            Msg::Want { objects, .. } => objects,
            Msg::Err { message, .. } => return Err(ReinError::Message(message)),
            other => return Err(ReinError::Message(format!("等 WANT 收到 {other:?}"))),
        };
        for uuid in &want {
            let obj = match objects.iter().find(|o| &o.uuid == uuid) {
                Some(o) => o.clone(),
                None => continue,
            };
            let bytes = obj.blob.as_bytes();
            let total = bytes.len();
            let mut off = 0;
            while off < total.max(1) {
                let end = (off + CHUNK).min(total);
                send_msg(
                    link,
                    c,
                    &Msg::Data {
                        u: obj.uuid.clone(),
                        k: obj.kind.clone(),
                        h: obj.hlc,
                        d: obj.device.clone(),
                        x: i64::from(obj.deleted),
                        off,
                        total,
                        data: B64.encode(&bytes[off..end]),
                    },
                )?;
                off = end;
                if total == 0 {
                    break;
                }
            }
        }

        // 对方可能还缺 blob
        let blob_want = match recv_msg(link, c, Duration::from_secs(60))? {
            Msg::Want { blobs, .. } => blobs,
            Msg::Done { to, applied, pending } => {
                // 没有 blob 需求：直接完成这一轮
                finish_round(link, c, conn, peer, to, &mut cursor, &pending, &mut retry)?;
                out.applied += 0; // 应用条数由收方那一侧统计
                let _ = applied;
                if pending.is_empty() && cursor >= last && rounds > 1 && retry.is_empty() {
                    break;
                }
                continue;
            }
            other => return Err(ReinError::Message(format!("等 blob 需求收到 {other:?}"))),
        };
        for hash in &blob_want {
            if let Some(bytes) = store.get(hash)? {
                let total = bytes.len();
                let mut off = 0;
                while off < total.max(1) {
                    let end = (off + CHUNK).min(total);
                    send_msg(
                        link,
                        c,
                        &Msg::Blob {
                            b: hash.clone(),
                            off,
                            total,
                            data: B64.encode(&bytes[off..end]),
                        },
                    )?;
                    off = end;
                    if total == 0 {
                        break;
                    }
                }
            }
        }
        let done = match recv_msg(link, c, Duration::from_secs(60))? {
            Msg::Done { to, applied, pending } => (to, applied, pending),
            other => return Err(ReinError::Message(format!("等 DONE 收到 {other:?}"))),
        };
        finish_round(link, c, conn, peer, done.0, &mut cursor, &done.2, &mut retry)?;
        let _ = done.1;
        if retry.is_empty() && cursor >= last {
            break;
        }
        if rounds > MAX_RETRY_ROUNDS {
            break;
        }
    }
    // 阶段终止（推方说「我没有要发的了」）**必须等回执**：
    // 不等的话那条 ACK 会漏进下一个阶段，对方在等清单、这边在等 WANT，两边一起卡住。
    send_msg(
        link,
        c,
        &Msg::Done {
            to: cursor,
            applied: 0,
            pending: Vec::new(),
        },
    )?;
    // 阶段末尾的这点迂回不值得让整次同步失败：对方已经退出它的接收循环了，
    // ACK 没收到、或收到别的，都直接往下走（原先写成 match 两个空臂，语义相同）。
    let _ = recv_msg(link, c, Duration::from_secs(30));
    Ok(out)
}

/// 收方报完成：推进游标（有 pending 就退回到最早那条之前），回一条 ACK。
///
/// 参数刻意平铺：它们全是「这一轮的状态」，塞进一个 context 结构体只是把同样的东西
/// 换个地方摆，却让调用点与生命周期都变复杂。
#[allow(clippy::too_many_arguments)]
fn finish_round(
    link: &mut dyn Link,
    c: &mut SessionCrypto,
    conn: &Connection,
    peer: &Peer,
    to: i64,
    cursor: &mut i64,
    pending: &[String],
    retry: &mut Vec<String>,
) -> Result<()> {
    *retry = pending.to_vec();
    if pending.is_empty() {
        // 全部落地：游标推到这一批的末尾
        *cursor = to;
    } else {
        // 有解不开的引用：游标退到最早那条之前，下一轮重发
        let mut min_seq = i64::MAX;
        for uuid in pending {
            if let Some(seq) = apply::seq_of_uuid(conn, uuid)? {
                min_seq = min_seq.min(seq);
            }
        }
        if min_seq != i64::MAX {
            *cursor = (min_seq - 1).max(0);
        }
    }
    apply::set_cursor(conn, &peer.device, *cursor, *cursor)?;
    send_msg(link, c, &Msg::Ack { to: *cursor })
}

/// 收：把对方推来的对象落到本地。
fn pull(
    link: &mut dyn Link,
    c: &mut SessionCrypto,
    conn: &Connection,
    store: &BlobStore,
    peer: &Peer,
) -> Result<Outcome> {
    if std::env::var_os("REIN_SYNC_DEBUG").is_some() {
        eprintln!("[sync {:?}] 进入收阶段", std::thread::current().id());
    }
    let mut out = Outcome {
        path: link.path(),
        ..Default::default()
    };
    // 收下的对象先攒着：blob 到齐之后再统一应用（`media::decode` 依赖 blob 在位）
    let mut staged: Vec<RemoteObject> = Vec::new();
    loop {
        let msg = recv_msg(link, c, Duration::from_secs(60))?;
        let (to, metas) = match msg {
            Msg::Manifest { to, objects } => (to, objects),
            Msg::Done { to, .. } => {
                // 推方这一阶段结束。**只能回 ACK**：回 Done 会让对方以为「我这边也发完了」，
                // 两边的阶段就错位了（推方会直接进接收阶段，而这边还在等清单）。
                send_msg(link, c, &Msg::Ack { to })?;
                break;
            }
            Msg::Err { message, .. } => return Err(ReinError::Message(message)),
            other => return Err(ReinError::Message(format!("等清单收到 {other:?}"))),
        };

        // 只要「比本机新」的（清单里就有 hlc，够了）
        let mut want: Vec<String> = Vec::new();
        for m in &metas {
            let local: Option<(i64, String)> = conn
                .query_row(
                    "SELECT hlc, device FROM sync_objects WHERE uuid = ?1",
                    [&m.u],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            let newer = match local {
                Some((hlc, dev)) => (m.h, m.d.as_str()) > (hlc, dev.as_str()),
                None => true,
            };
            if newer {
                want.push(m.u.clone());
            }
        }
        send_msg(
            link,
            c,
            &Msg::Want {
                objects: want.clone(),
                blobs: Vec::new(),
            },
        )?;

        // 收数据（大对象分块）
        let mut chunks: Vec<ChunkBuf> = Vec::new();
        let mut wanted = want.len();
        while wanted > 0 {
            match recv_msg(link, c, Duration::from_secs(60))? {
                Msg::Data {
                    u,
                    k,
                    h,
                    d,
                    x,
                    off,
                    total,
                    data,
                } => {
                    let bytes = B64
                        .decode(&data)
                        .map_err(|_| ReinError::Message("数据块不是合法 base64".into()))?;
                    // off/total 是对端报来的：离谱的总量与越界的偏移直接拒绝
                    if total > MAX_PAYLOAD_BYTES || off.saturating_add(bytes.len()) > total {
                        return Err(ReinError::Message("数据块长度越界".into()));
                    }
                    match chunks.iter_mut().find(|c| c.0 == u) {
                        Some(slot) => {
                            let end = off + bytes.len();
                            if slot.6.len() < end {
                                slot.6.resize(end, 0);
                            }
                            slot.6[off..end].copy_from_slice(&bytes);
                        }
                        None => {
                            let mut buf = vec![0u8; total];
                            let end = off + bytes.len();
                            buf[off..end].copy_from_slice(&bytes);
                            chunks.push((u.clone(), k, h, d, x, total, buf));
                            wanted -= 1;
                        }
                    }
                }
                Msg::Done { .. } => break,
                other => return Err(ReinError::Message(format!("等数据收到 {other:?}"))),
            }
        }
        for (u, k, h, d, x, total, buf) in chunks {
            staged.push(RemoteObject {
                uuid: u,
                kind: k,
                hlc: h,
                device: d,
                deleted: x != 0,
                blob: String::from_utf8_lossy(&buf[..total]).to_string(),
            });
        }

        // 还缺哪些 blob
        let mut missing: Vec<String> = Vec::new();
        for obj in &staged {
            for hash in referenced_blobs(&obj.blob) {
                if !store.has(&hash)? && !missing.contains(&hash) {
                    missing.push(hash);
                }
            }
        }
        send_msg(
            link,
            c,
            &Msg::Want {
                objects: Vec::new(),
                blobs: missing.clone(),
            },
        )?;
        for _ in &missing {
            // 一个 hash 可能要多块，收到「不在 missing 里的 hash」时说明上一批完了
        }
        let mut got: Vec<String> = Vec::new();
        while got.len() < missing.len() {
            match recv_msg(link, c, Duration::from_secs(120))? {
                Msg::Blob {
                    b,
                    off,
                    total,
                    data,
                } => {
                    let bytes = B64
                        .decode(&data)
                        .map_err(|_| ReinError::Message("blob 块不是合法 base64".into()))?;
                    // hash 与长度都是对端可控的：write_chunk 会按 hash 拼路径、按 total
                    // 撑文件，必须在碰文件系统之前把两边都挡住
                    if total > MAX_PAYLOAD_BYTES || off.saturating_add(bytes.len()) > total {
                        return Err(ReinError::Message("blob 块长度越界".into()));
                    }
                    // 写 `.part`、收齐校验摘要后改名就位：不能直接写最终路径（见 blobs.rs）
                    store.write_chunk(&b, off, total, &bytes)?;
                    if off + bytes.len() >= total {
                        store.finish_chunked(conn, &b, total)?;
                        if !got.contains(&b) {
                            got.push(b);
                        }
                    }
                }
                Msg::Done { .. } => break,
                other => return Err(ReinError::Message(format!("等 blob 收到 {other:?}"))),
            }
        }

        // 统一应用
        let stats: ApplyStats = apply::apply_batch(conn, store, &staged)?;
        staged.clear();
        out.applied += stats.applied;
        out.conflicts += stats.conflicts;
        out.unresolved += stats.unresolved;
        out.skipped_columns += stats.skipped_columns;
        send_msg(
            link,
            c,
            &Msg::Done {
                to,
                applied: stats.applied,
                pending: stats.pending.clone(),
            },
        )?;
        // 等 ACK（推方据此推进游标）
        match recv_msg(link, c, Duration::from_secs(30))? {
            Msg::Ack { .. } => {}
            Msg::Done { .. } => break,
            other => return Err(ReinError::Message(format!("等 ACK 收到 {other:?}"))),
        }
        let _ = peer;
    }
    Ok(out)
}

/// 对象里引用了哪些 blob（只认 `__blob` 标记，不猜别的）。
fn referenced_blobs(blob: &str) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(blob) else {
        return out;
    };
    fn walk(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(h)) = map.get("__blob") {
                    if !out.contains(h) {
                        out.push(h.clone());
                    }
                }
                for (_, val) in map {
                    walk(val, out);
                }
            }
            serde_json::Value::Array(items) => {
                for it in items {
                    walk(it, out);
                }
            }
            _ => {}
        }
    }
    walk(&value, &mut out);
    out
}

#[cfg(test)]
mod tests;
