//! 多设备同步：本机 SQLite 里的用户数据，在几台设备之间对齐。
//!
//! ---------- 一条会话是怎么走的 ----------
//!
//! 三条传输路径，**同一套会话协议**（清单 → 索取 → 帧传输），差别只在帧怎么走：
//!
//! 1. **局域网直连**：UDP 广播发现同一网段里的对端（组 id 的哈希，不广播任何密钥），
//!    发现后直接在 UDP 单播上跑帧协议。同一网段的两台设备因此完全不经过云。
//! 2. **UDP 打洞**：跨网段时向云服务器的会合端口发一个 HELLO —— 关键是用**即将打洞的
//!    同一个 socket** 发，服务器才看得到正确的 NAT 映射；两端拿到对方的公网 ip:port
//!    后同时互打。打通后同一 socket 继续跑帧协议，服务器从此不参与。
//! 3. **云端中继**：打洞 15 秒不通就落这一档 —— 帧装进 HTTP 请求体，服务器只在**内存**里
//!    转发（不落盘、不解析），载荷是端到端加密的密文。
//!
//! ---------- 为什么服务器看不到内容 ----------
//!
//! 配对靠一串人读的同步码：两台设备各自 X25519 ECDH 出同一个组密钥，服务器全程只见过
//! 公钥与那串码（5 分钟过期、只在内存里）。业务帧一律 ChaCha20-Poly1305 加密，
//! AAD 里绑了会话 epoch 与序号，防重放。这条与服务器的既有约定一致 ——
//! `docs/ARCHITECTURE.md` 写着「服务器不放业务数据」，中继是纯转发，配对槽是临时的。
//!
//! ---------- 冲突怎么办 ----------
//!
//! 按 (毫秒时间戳, 设备 id) 取胜（LWW）：简单、可预期、两端跑出来的结果一致。
//! 落败的那一版不丢，进 `sync_conflicts` 供人回看 —— 但**不自动合并**：
//! 逐字段合并要为每张表写字段级规则，那是另一个量级的复杂度，这一版不做（见 docs/SYNC.md）。
//!
//! ---------- 不进同步的东西 ----------
//!
//! 教务账号（含密码与 Cookie）、模型 API key 这两类是**凭证**，复制到第二台设备是安全
//! 决定，不该由「同步」默认替用户做；内置食物/动作/计划是种子数据，两端各自播种即可；
//! 知识库的索引与向量是派生物，本机重建。名单见 `tables.rs`。

pub mod apply;
pub mod auto;
pub mod blobs;
pub mod commands;
pub mod crypto;
pub mod engine;
pub mod identity;
pub mod media;
pub mod models;
pub mod protocol;
pub mod runner;
pub mod tables;
pub mod transport;

use rusqlite::Connection;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::error::Result;

/// 待处理的本地改动数（脏队列积压）。变更捕获线程每轮更新它，`sync_status` 直接读 ——
/// 状态查询因此不必去碰队列的锁。里程碑 2 之前恒为 0（如实报，不编数字）。
static PENDING: AtomicI64 = AtomicI64::new(0);

pub(crate) fn pending_count() -> i64 {
    PENDING.load(Ordering::Relaxed)
}

/// 变更捕获线程用它回报积压。
pub(crate) fn set_pending(n: i64) {
    PENDING.store(n, Ordering::Relaxed);
}

/// `sync_meta` 读（与 `app_meta` 分开：同步状态整份可重置，应用设置不行）。
pub(crate) fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT v FROM sync_meta WHERE k = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

/// `sync_meta` 写。
pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (k, v) VALUES (?1, ?2) \
         ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// `sync_meta` 删（比如错误已随下一次成功消失，状态里不该再挂着旧的）。
pub(crate) fn meta_del(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM sync_meta WHERE k = ?1", [key])?;
    Ok(())
}
