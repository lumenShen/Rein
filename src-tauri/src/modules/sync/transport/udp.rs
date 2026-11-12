//! UDP 链路：同一段网里点对点，以及跨网段打洞。
//!
//! 三件事共用一套帧格式与一个 socket：
//!   1. 局域网发现：向 255.255.255.255:48991 广播自己的房间与监听端口，同段的另一端
//!      直接单播回来 —— 这条路上不需要云服务器参与。
//!   2. 打洞：周期性给云服务器的 48990 发 `hello`，拿到**自己**的公网映射与**对端**的
//!      映射；然后两端同时向对方的映射连发几个 PING，把各自的 NAT 捅开。
//!   3. 会话：确认双向可达后，同一个 socket 直接跑同步协议。
//!
//! 可靠性是**停等**的：发一帧（拆成 ≤1100 字节的数据报），等它的 ACK，超时重发。
//! 局域网 RTT 是亚毫秒、跨网段也常常 <50ms，配合 192KB 的分片，utils 上足够；
//! 换来的是没有窗口、没有乱序重排、没有拥塞控制这一整套 —— 对一个「偶尔同步一次」
//! 的功能，这个交换是划算的。真要快，下一步该换的是 QUIC，而不是手写窗口。
use std::collections::VecDeque;
use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::error::{ReinError, Result};

use super::super::protocol::Link;
use super::{Endpoint, Path, Ready};

/// 局域网发现端口：固定值，方便两端不用配置就能撞上。
pub const LAN_PORT: u16 = 48991;
/// 云服务器的会合端口（需要在阿里云安全组放行 UDP）。
pub const SYNC_UDP_PORT: u16 = 48990;
/// 单条数据报上限：留足 IPv4/IPv6 头部余量，避免在部分链路上被静默丢弃。
const MTU: usize = 1100;
const HDR: usize = 8;

const K_ACK: u8 = 1;
const K_DATA: u8 = 2;
const K_PING: u8 = 3;
const K_PONG: u8 = 4;
const K_HELLO: u8 = 5; // 局域网发现
const K_FOUND: u8 = 6; // 局域网回应

fn err(msg: impl Into<String>) -> ReinError {
    ReinError::Message(msg.into())
}

fn bind(port: u16, broadcast: bool) -> Result<UdpSocket> {
    let sock = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
        .map_err(|e| err(format!("绑定 UDP 端口 {port} 失败：{e}")))?;
    if broadcast {
        sock.set_broadcast(true).map_err(|e| err(format!("开启广播失败：{e}")))?;
    }
    sock.set_read_timeout(Some(Duration::from_millis(250))).ok();
    Ok(sock)
}

fn encode_tag(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(body.len() + 1);
    buf.push(tag);
    buf.extend_from_slice(body);
    buf
}

/// 局域网广播的载荷：房间 + 设备号 + 会话端口。房间号是配对时交换的随机串，
/// 所以同段网里的陌生设备即使收到也认不出、更进不来。
fn lan_hello(room: &str, device: &str, port: u16) -> Vec<u8> {
    encode_tag(K_HELLO, json!({ "room": room, "device": device, "port": port }).to_string().as_bytes())
}

fn lan_found(room: &str, device: &str, port: u16) -> Vec<u8> {
    encode_tag(K_FOUND, json!({ "room": room, "device": device, "port": port }).to_string().as_bytes())
}

fn parse_lan(room: &str, device: &str, body: &[u8]) -> Option<(String, u16)> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    if v.get("room")?.as_str()? != room {
        return None;
    }
    let other = v.get("device")?.as_str()?.to_string();
    if other == device {
        return None;
    }
    Some((other, v.get("port")?.as_u64()? as u16))
}

/// 一个正在收的分片消息：(起始序号, 分片总数, 各分片, 已收到的字节数)。
type PartsBuf = (u32, usize, Vec<Option<Vec<u8>>>, usize);

/// 停等式可靠 UDP 链路。`handshake` 之后再交给会话用。
pub struct UdpLink {
    sock: UdpSocket,
    peer: SocketAddr,
    kind: Path,
    seq: u32,
    pending: VecDeque<Vec<u8>>,
    parts: Option<PartsBuf>,
    up: i64,
    down: i64,
    tries: u32,
}

impl UdpLink {
    pub fn new(sock: UdpSocket, peer: SocketAddr, kind: Path) -> Self {
        Self {
            sock,
            peer,
            kind,
            seq: 0,
            pending: VecDeque::new(),
            parts: None,
            up: 0,
            down: 0,
            tries: 3,
        }
    }

    fn raw(&self, buf: &[u8]) -> Result<()> {
        self.sock.send_to(buf, self.peer).map_err(|e| err(format!("UDP 发送失败：{e}")))?;
        Ok(())
    }

    /// 收一条数据报；忽略不属于本次会话的来源（同段网里可能有别的设备在广播）。
    fn datagram(&self, timeout: Duration) -> Option<(u8, Vec<u8>)> {
        self.sock.set_read_timeout(Some(timeout.max(Duration::from_millis(20)))).ok();
        let mut buf = [0u8; MTU + 64];
        loop {
            match self.sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    if from.ip() != self.peer.ip() || from.port() != self.peer.port() {
                        continue;
                    }
                    if n == 0 {
                        continue;
                    }
                    return Some((buf[0], buf[1..n].to_vec()));
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => return None,
                Err(e) if e.kind() == ErrorKind::ConnectionReset => continue, // Windows：ICMP 回执
                Err(_) => return None,
            }
        }
    }

    fn pong(&self) -> Result<()> {
        self.raw(&[K_PONG])
    }

    /// 双向可达性确认：先连发几个 PING，再等对端的 PING 或 PONG。
    /// 打洞场景下这一步就是「捅洞」本身 —— 双方都在往外发，NAT 映射才立得住。
    pub fn handshake(&mut self, wait: Duration) -> Result<()> {
        let deadline = Instant::now() + wait;
        let mut got = false;
        while Instant::now() < deadline {
            let _ = self.raw(&[K_PING]);
            for _ in 0..4 {
                match self.datagram(Duration::from_millis(120)) {
                    Some((K_PING, _)) => {
                        self.pong()?;
                        got = true;
                    }
                    Some((K_PONG, _)) => got = true,
                    // 对方手快、已经开讲：收下来（absorb 会回 ACK），别让这一帧丢掉
                    Some((K_DATA, body)) => self.absorb(&body),
                    Some(_) => {}
                    None => {}
                }
                if got && Instant::now() + Duration::from_millis(150) > deadline {
                    break;
                }
            }
            if got {
                // 再确认一次往返，避免只收到单向
                let _ = self.raw(&[K_PING]);
                if let Some((K_PING, _)) = self.datagram(Duration::from_millis(400)) {
                    self.pong()?;
                }
                return Ok(());
            }
        }
        Err(err("对端没有应答（可能不在同一网段，或都被 NAT 挡住）"))
    }

    fn send_frame(&mut self, frame: &[u8]) -> Result<()> {
        self.seq = self.seq.wrapping_add(1);
        let seq = self.seq;
        let payload = MTU - HDR;
        let parts = frame.len().div_ceil(payload).max(1);
        if parts > u16::MAX as usize {
            return Err(err("单帧过大"));
        }
        let mut offset = 0usize;
        for idx in 0..parts {
            let end = (offset + payload).min(frame.len());
            let slice = &frame[offset..end];
            let mut buf = Vec::with_capacity(slice.len() + HDR);
            buf.push(K_DATA);
            buf.extend_from_slice(&seq.to_be_bytes());
            buf.extend_from_slice(&(idx as u16).to_be_bytes());
            buf.extend_from_slice(&(parts as u16).to_be_bytes());
            buf.extend_from_slice(slice);
            self.raw(&buf)?;
            self.up += slice.len() as i64;
            offset = end;
        }

        // 等 ACK：期间收到的数据帧先收着，别丢
        let deadline = Instant::now() + Duration::from_millis(900);
        while Instant::now() < deadline {
            match self.datagram(Duration::from_millis(200)) {
                Some((K_ACK, body)) if body.len() >= 4 => {
                    if u32::from_be_bytes([body[0], body[1], body[2], body[3]]) == seq {
                        return Ok(());
                    }
                }
                Some((K_PING, _)) => {
                    let _ = self.pong();
                }
                Some((K_DATA, body)) => self.absorb(&body),
                _ => {}
            }
            // 超时重发（同 seq，接收侧按 seq 去重）
            if Instant::now() >= deadline {
                break;
            }
        }
        for _ in 0..self.tries {
            let mut offset = 0usize;
            for idx in 0..parts {
                let end = (offset + payload).min(frame.len());
                let slice = &frame[offset..end];
                let mut buf = Vec::with_capacity(slice.len() + HDR);
                buf.push(K_DATA);
                buf.extend_from_slice(&seq.to_be_bytes());
                buf.extend_from_slice(&(idx as u16).to_be_bytes());
                buf.extend_from_slice(&(parts as u16).to_be_bytes());
                buf.extend_from_slice(slice);
                self.raw(&buf)?;
                offset = end;
            }
            let deadline = Instant::now() + Duration::from_millis(700);
            while Instant::now() < deadline {
                match self.datagram(Duration::from_millis(200)) {
                    Some((K_ACK, body)) if body.len() >= 4 => {
                        if u32::from_be_bytes([body[0], body[1], body[2], body[3]]) == seq {
                            return Ok(());
                        }
                    }
                    Some((K_PING, _)) => {
                        let _ = self.pong();
                    }
                    Some((K_DATA, body)) => self.absorb(&body),
                    _ => {}
                }
            }
        }
        Err(err("对端确认超时（链路不稳）"))
    }

    /// 攒一个数据帧的分片；收齐后回 ACK 并放进待取队列。
    fn absorb(&mut self, body: &[u8]) {
        if body.len() < 8 {
            return;
        }
        let seq = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
        let idx = u16::from_be_bytes([body[4], body[5]]) as usize;
        let parts = u16::from_be_bytes([body[6], body[7]]) as usize;
        let data = &body[8..];
        match &mut self.parts {
            Some((s, p, slots, _)) if *s == seq && *p == parts => {
                if idx < slots.len() && slots[idx].is_none() {
                    slots[idx] = Some(data.to_vec());
                }
            }
            _ => {
                let mut slots = vec![None; parts.max(1)];
                if idx < slots.len() {
                    slots[idx] = Some(data.to_vec());
                }
                self.parts = Some((seq, parts, slots, 0));
            }
        }
        let done = match &self.parts {
            Some((s, p, slots, _)) if *s == seq && *p == parts => slots.iter().all(|x| x.is_some()),
            _ => false,
        };
        if !done {
            return;
        }
        let (_, _, slots, _) = self.parts.take().unwrap();
        let mut frame = Vec::new();
        for slot in slots.into_iter().flatten() {
            frame.extend_from_slice(&slot);
        }
        self.down += frame.len() as i64;
        let mut ack = Vec::with_capacity(5);
        ack.push(K_ACK);
        ack.extend_from_slice(&seq.to_be_bytes());
        let _ = self.raw(&ack);
        self.pending.push_back(frame);
    }
}

impl Link for UdpLink {
    fn send(&mut self, bytes: &[u8]) -> Result<()> {
        self.send_frame(bytes)
    }

    fn recv(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
        if let Some(frame) = self.pending.pop_front() {
            return Ok(Some(frame));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            match self.datagram(left.min(Duration::from_millis(300))) {
                Some((K_DATA, body)) => {
                    self.absorb(&body);
                    if let Some(frame) = self.pending.pop_front() {
                        return Ok(Some(frame));
                    }
                }
                Some((K_PING, _)) => {
                    let _ = self.pong();
                }
                Some((K_ACK, _)) => {}
                _ => {}
            }
        }
    }

    fn path(&self) -> String {
        self.kind.as_str().to_string()
    }

    fn stats(&self) -> (i64, i64) {
        (self.up, self.down)
    }
}

/// 局域网：广播找人 → 双向 ping → 交给会话。
pub fn lan_connect(ep: &Endpoint) -> Result<Ready> {
    let sock = bind(ep.lan_port, true)?;
    let target = SocketAddrV4::new(Ipv4Addr::BROADCAST, LAN_PORT);
    let deadline = Instant::now() + Duration::from_millis(1200);
    let mut peer: Option<SocketAddr> = None;
    while Instant::now() < deadline && peer.is_none() {
        let _ = sock.send_to(&lan_hello(&ep.room, &ep.device, ep.lan_port), target);
        sock.set_read_timeout(Some(Duration::from_millis(300))).ok();
        let mut buf = [0u8; 1024];
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if n > 1 {
                match buf[0] {
                    K_FOUND => {
                        if let Some((_, port)) = parse_lan(&ep.room, &ep.device, &buf[1..n]) {
                            peer = Some(SocketAddr::new(from.ip(), port));
                        }
                    }
                    K_HELLO => {
                        if let Some((_, port)) = parse_lan(&ep.room, &ep.device, &buf[1..n]) {
                            // 对方也在广播：回一声，让两边都拿到落点
                            let _ = sock.send_to(&lan_found(&ep.room, &ep.device, ep.lan_port), SocketAddr::new(from.ip(), port));
                            peer = Some(SocketAddr::new(from.ip(), port));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let peer = peer.ok_or_else(|| err("同一网段里没有找到已配对的设备"))?;
    let mut link = UdpLink::new(sock, peer, Path::Lan);
    link.handshake(Duration::from_millis(1500))?;
    Ok(Ready {
        link: Box::new(link),
        path: Path::Lan,
        peer_hint: peer.to_string(),
    })
}

/// 被动侧等广播（或等打洞的 PING）上门；超时就报错交给下一档。
pub fn lan_listen(ep: &Endpoint, wait: Duration) -> Result<Ready> {
    let sock = bind(ep.lan_port, true)?;
    let mut peer: Option<SocketAddr> = None;
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline && peer.is_none() {
        sock.set_read_timeout(Some(Duration::from_millis(300))).ok();
        let mut buf = [0u8; 1024];
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if n > 1 && buf[0] == K_HELLO {
                if let Some((_, port)) = parse_lan(&ep.room, &ep.device, &buf[1..n]) {
                    let _ = sock.send_to(&lan_found(&ep.room, &ep.device, ep.lan_port), SocketAddr::new(from.ip(), port));
                    peer = Some(SocketAddr::new(from.ip(), port));
                }
            }
        }
    }
    let peer = peer.ok_or_else(|| err("没有同网段的设备来过"))?;
    let mut link = UdpLink::new(sock, peer, Path::Lan);
    link.handshake(Duration::from_millis(1500))?;
    Ok(Ready {
        link: Box::new(link),
        path: Path::Lan,
        peer_hint: peer.to_string(),
    })
}

/// 打洞：向云服务器要双方的公网映射，然后同时向对方捅。
pub fn punch_connect(ep: &Endpoint) -> Result<Ready> {
    let sock = bind(0, false)?;
    // 会合服务端只认**裸 JSON**（不是帧协议的 tag + JSON）：它会直接 JSON.parse 整个数据报。
    // 这里曾经套了 `encode_tag(K_PING, …)`，服务端解析失败后一个 hello 都看不到，
    // 打洞于是永远超时、落中继 —— 两端格式必须与 server/src/sync.mjs 的 attachUdp 一致。
    let hello = json!({ "t": "hello", "room": ep.room, "device": ep.device })
        .to_string()
        .into_bytes();
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut peer: Option<SocketAddr> = None;
    while Instant::now() < deadline && peer.is_none() {
        let _ = sock.send_to(&hello, ep.udp);
        sock.set_read_timeout(Some(Duration::from_millis(600))).ok();
        let mut buf = [0u8; 2048];
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if from.ip() != ep.udp.ip() || n == 0 {
                continue;
            }
            // 服务端回的是裸 JSON。第二个分支兼容「带 tag 的回执」——老版本服务端或
            // 未来加 tag 时不至于又是一场静默失败。
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[..n])
                .or_else(|_| serde_json::from_slice::<serde_json::Value>(&buf[1..n]))
            {
                if let Some(p) = v.get("peer") {
                    let ip = p.get("ip").and_then(|x| x.as_str()).unwrap_or_default().parse::<Ipv4Addr>();
                    let port = p.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                    if let Ok(ip) = ip {
                        if port > 0 && ip != Ipv4Addr::UNSPECIFIED {
                            peer = Some(SocketAddr::new(std::net::IpAddr::V4(ip), port));
                        }
                    }
                }
            }
        }
    }
    let peer = peer.ok_or_else(|| err("云服务器没有给出对端的映射"))?;
    let mut link = UdpLink::new(sock, peer, Path::Punch);
    link.handshake(Duration::from_secs(3))?;
    Ok(Ready {
        link: Box::new(link),
        path: Path::Punch,
        peer_hint: peer.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    /// 两个回环 socket 上的链路：A 发（小帧 / 300KB 分片 / 小帧），B 收齐后回一句。
    #[test]
    fn frames_round_trip_over_udp() {
        let sa = UdpSocket::bind("127.0.0.1:0").unwrap();
        let sb = UdpSocket::bind("127.0.0.1:0").unwrap();
        let a_addr = sa.local_addr().unwrap();
        let b_addr = sb.local_addr().unwrap();
        let mut a = UdpLink::new(sa, b_addr, Path::Lan);
        let mut b = UdpLink::new(sb, a_addr, Path::Lan);

        let big = vec![7u8; 300 * 1024];
        let big_for_b = big.clone();
        let handle = thread::spawn(move || -> Result<(Vec<Vec<u8>>, i64, i64)> {
            b.handshake(Duration::from_secs(3))?;
            let mut got = Vec::new();
            for _ in 0..3 {
                match b.recv(Duration::from_secs(10))? {
                    Some(frame) => got.push(frame),
                    None => return Err(err("等帧超时")),
                }
            }
            b.send(b"pong")?;
            let (up, down) = b.stats();
            Ok((got, up, down))
        });

        a.handshake(Duration::from_secs(3)).unwrap();
        a.send(b"hello-1").unwrap();
        a.send(&big).unwrap();
        a.send(b"hello-2").unwrap();
        let reply = a.recv(Duration::from_secs(10)).unwrap().expect("应收到 pong");
        let (got, b_up, b_down) = handle.join().unwrap().unwrap();

        assert_eq!(reply, b"pong".to_vec());
        assert_eq!(got[0], b"hello-1".to_vec());
        assert_eq!(got[1], big_for_b, "300KB 那一帧分片后应逐字节还原");
        assert_eq!(got[2], b"hello-2".to_vec());
        assert_eq!(b_up, 4, "只有 pong 的 4 字节算负载（ACK 不计入）");
        assert_eq!(b_down as usize, 7 + big_for_b.len() + 7);
    }

    /// 只认对端地址：同段网里的陌生 UDP 包不该把链路带偏。
    #[test]
    fn ignores_datagrams_from_strangers() {
        let sa = UdpSocket::bind("127.0.0.1:0").unwrap();
        let sb = UdpSocket::bind("127.0.0.1:0").unwrap();
        let stranger = UdpSocket::bind("127.0.0.1:0").unwrap();
        let a_addr = sa.local_addr().unwrap();
        let b_addr = sb.local_addr().unwrap();
        let mut a = UdpLink::new(sa, b_addr, Path::Lan);
        let b = UdpLink::new(sb, a_addr, Path::Lan);

        let mut junk = vec![K_DATA];
        junk.extend_from_slice(&1u32.to_be_bytes());
        junk.extend_from_slice(&0u16.to_be_bytes());
        junk.extend_from_slice(&1u16.to_be_bytes());
        junk.extend_from_slice(b"from nobody");
        stranger.send_to(&junk, a_addr).unwrap();

        assert!(a.recv(Duration::from_millis(300)).unwrap().is_none(), "陌生来源的帧必须被丢掉");
        drop(b);
    }
}
