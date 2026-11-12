//! 传输阶梯：**同一网段直连 → 跨网段打洞 → 云服务器中继**。
//!
//! 顺序不是随便排的：同一段网里两端本来就互相可达，走局域网最省事也最快；跨网段时
//! 先用云服务器换到彼此的公网映射、直接打洞，数据不经过服务器；只有打洞被对称 NAT
//! 之类挡住时，才退回服务器中继 —— 那一条上跑的仍然是端到端加密的密文。
//!
//! 每一档的失败原因都收集下来交给调用方（界面要能告诉用户「这次为什么走了中继」），
//! 而不是把前半段的尝试吞掉。
use std::net::SocketAddr;
use std::time::Duration;

use crate::error::Result;

use super::protocol::Link;

pub mod relay;
pub mod udp;

use udp::LAN_PORT;

/// 这次同步实际走的哪条路。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Path {
    Lan,
    Punch,
    Relay,
}

impl Path {
    /// 存进库/上报的稳定标识。
    pub fn as_str(self) -> &'static str {
        match self {
            Path::Lan => "lan",
            Path::Punch => "punch",
            Path::Relay => "relay",
        }
    }

    /// 界面上给用户看的说法。
    pub fn label(self) -> &'static str {
        match self {
            Path::Lan => "局域网直连",
            Path::Punch => "打洞直连",
            Path::Relay => "云端中继",
        }
    }
}

/// 一次连接尝试需要的全部信息。
pub struct Endpoint {
    /// 在线服务的基地址（与更新、模型网关共用同一台）
    pub base_url: String,
    /// 会合用的 UDP 地址
    pub udp: SocketAddr,
    /// 配对时交换的房间号（128 位随机，同时是中继的凭证）
    pub room: String,
    /// 本机设备号
    pub device: String,
    /// 是不是拨号侧（设备号小的那台拨，避免两边同时抢连）。
    /// 选路在 `runner` 里现算，这个字段暂时只作为「一次连接尝试的全貌」留在模型里。
    #[allow(dead_code)]
    pub dial: bool,
    /// 局域网发现用的本地端口
    pub lan_port: u16,
}

impl Endpoint {
    /// `base_url` 形如 `http://1.2.3.4:8787`：会合端口固定用 48990，只从里面取主机名。
    pub fn new(base_url: impl Into<String>, room: impl Into<String>, device: impl Into<String>, dial: bool) -> Self {
        let base_url = base_url.into();
        let host = base_url
            .split("//")
            .nth(1)
            .unwrap_or(base_url.as_str())
            .split(['/', ':'])
            .next()
            .unwrap_or("")
            .to_string();
        let port = udp::SYNC_UDP_PORT;
        let udp = format!("{host}:{port}")
            .parse()
            .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], port)));
        Self {
            base_url,
            udp,
            room: room.into(),
            device: device.into(),
            dial,
            lan_port: LAN_PORT,
        }
    }
}

/// 连接成功：一条可用的链路 + 走的哪条路 + 对端地址（写进日志与界面）。
pub struct Ready {
    pub link: Box<dyn Link>,
    pub path: Path,
    pub peer_hint: String,
}

/// 拨号侧：局域网 → 打洞 → 中继。
pub fn connect(ep: &Endpoint) -> Result<(Ready, Vec<String>)> {
    let mut notes = Vec::new();

    if !ep.room.is_empty() {
        match udp::lan_connect(ep) {
            Ok(ready) => return Ok((ready, notes)),
            Err(e) => notes.push(format!("局域网：{e}")),
        }
    }

    match udp::punch_connect(ep) {
        Ok(ready) => return Ok((ready, notes)),
        Err(e) => notes.push(format!("打洞：{e}")),
    }

    let link = relay::RelayLink::new(&ep.base_url, &ep.room, &ep.device)?;
    notes.push("已改用云端中继".to_string());
    Ok((
        Ready {
            link: Box::new(link),
            path: Path::Relay,
            peer_hint: "relay".to_string(),
        },
        notes,
    ))
}

/// 被动侧：等局域网广播或打洞上门，超时后落到中继。
pub fn accept(ep: &Endpoint, lan_wait: Duration) -> Result<(Ready, Vec<String>)> {
    let mut notes = Vec::new();

    if !ep.room.is_empty() {
        match udp::lan_listen(ep, lan_wait) {
            Ok(ready) => return Ok((ready, notes)),
            Err(e) => notes.push(format!("局域网：{e}")),
        }
        match udp::punch_connect(ep) {
            Ok(ready) => return Ok((ready, notes)),
            Err(e) => notes.push(format!("打洞：{e}")),
        }
    }

    let link = relay::RelayLink::new(&ep.base_url, &ep.room, &ep.device)?;
    notes.push("已改用云端中继".to_string());
    Ok((
        Ready {
            link: Box::new(link),
            path: Path::Relay,
            peer_hint: "relay".to_string(),
        },
        notes,
    ))
}
