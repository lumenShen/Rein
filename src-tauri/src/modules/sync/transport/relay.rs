//! 中继链路：打洞不成时，帧借云服务器的**内存邮箱**过一趟。
//!
//! 服务器看到的只是密文（会话层已经端到端加密），而且不落盘：房间是内存里的环形
//! 缓存，10 分钟没人碰就消失。取件是长轮询（有新帧立刻唤醒），所以在「有来有回」
//! 的同步节奏下延迟是可接受的；真正的带宽需求（大图、语音）优先走前两档。
//!
//! 有一个坑：邮箱**按 seq 从 0 重放**，取过的帧并不删除 —— 新会话一律从 0 取起，
//! 上一轮投进来的帧（包括两端的握手帧）只要还在环形缓存里就会再次取到。拿旧握手
//! 当本轮握手接上，MAC 能验过（组密钥没变），但后面的密文帧计数对不上，整轮报
//! 「解密失败」。所以本链路投**第一帧**时会捎带一条 `resetBefore`，让服务端把
//! 早于 30 秒前的旧帧清掉：上一轮的残留无论多老都会被清走，而刚投进来的对端
//! 握手帧（两端连接只差几秒）不受影响。
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};

use crate::error::{ReinError, Result};

use super::super::protocol::Link;

/// 一次长轮询最多挂多久（与服务端的 25s 上限对齐）。
const LONG_POLL_MS: u64 = 20_000;
/// 单帧上限，与服务端一致；超了是调用方分片没做好，直接报错比静默截断好。
const MAX_FRAME_BYTES: usize = 256 * 1024;
/// 第一帧捎带的清理线：早于这条线的帧都是上一轮（或更早）的残留。取 30 秒 ——
/// 比两端的连接间隔宽（自动同步两端也只差几秒），又远小于自动同步的最小间隔。
const RESIDUAL_TTL_MS: i64 = 30_000;

fn err(msg: impl Into<String>) -> ReinError {
    ReinError::Message(msg.into())
}

pub struct RelayLink {
    agent: ureq::Agent,
    url: String,
    /// 本机设备号：中继房间是**两端共用的**邮箱，取件时靠它跳过自己投的帧。
    device: String,
    /// 还没投过帧：第一帧随信捎带 `resetBefore`，把上一轮的残留清掉。
    primed: bool,
    cursor: i64,
    pending: VecDeque<Vec<u8>>,
    up: i64,
    down: i64,
}

impl RelayLink {
    pub fn new(base_url: &str, room: &str, device: &str) -> Result<Self> {
        let base = base_url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err(err("没有配置在线服务地址，无法用中继"));
        }
        if room.is_empty() {
            return Err(err("还没有配对（缺房间号），无法用中继"));
        }
        Ok(Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(6))
                .timeout(Duration::from_secs(LONG_POLL_MS / 1000 + 20))
                .user_agent(concat!("Rein/", env!("CARGO_PKG_VERSION")))
                .build(),
            url: format!("{base}/api/v1/sync/relay/{room}"),
            device: device.to_string(),
            primed: false,
            cursor: 0,
            pending: VecDeque::new(),
            up: 0,
            down: 0,
        })
    }

    /// 给帧加一个「谁投的」前缀：`[长度][设备号][原帧]`。
    ///
    /// 中继房间是两端共用的环形邮箱，服务端只转发字节、不认发送者；不标记的话，
    /// 两端都会取到**自己刚投进去的帧**，握手时看到「对面自称是我」，直接判失败。
    /// 前缀放在密文帧外面、但仍在客户端这一侧处理 —— 服务端不需要任何改动。
    fn stamp(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        let device = self.device.as_bytes();
        if device.is_empty() || device.len() > u8::MAX as usize {
            return Err(err("设备号长度不合法，无法走中继"));
        }
        let mut out = Vec::with_capacity(1 + device.len() + bytes.len());
        out.push(device.len() as u8);
        out.extend_from_slice(device);
        out.extend_from_slice(bytes);
        Ok(out)
    }

    /// 拆前缀。没有前缀（对端是更老的客户端）时按「对端原帧」处理 —— 不丢。
    fn sender<'a>(&self, data: &'a [u8]) -> Option<(&'a str, &'a [u8])> {
        let len = *data.first()? as usize;
        if len == 0 || data.len() < 1 + len {
            return None;
        }
        let device = std::str::from_utf8(&data[1..1 + len]).ok()?;
        Some((device, &data[1 + len..]))
    }
}

impl Link for RelayLink {
    fn send(&mut self, bytes: &[u8]) -> Result<()> {
        let stamped = self.stamp(bytes)?;
        if stamped.len() > MAX_FRAME_BYTES {
            return Err(err("单帧过大，中继不接受（应该走分片）"));
        }
        let mut body = json!({ "frames": [B64.encode(&stamped)] });
        if !self.primed {
            self.primed = true;
            // 邮箱按 seq 从 0 重放：把上一轮的残留清掉，别让本轮握手接上旧帧。
            body["resetBefore"] = json!(Utc::now().timestamp_millis() - RESIDUAL_TTL_MS);
        }
        let resp = self
            .agent
            .post(&self.url)
            .set("content-type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| err(format!("中继投递失败：{e}")))?;
        let v: Value = serde_json::from_str(&resp.into_string().map_err(|e| err(format!("中继回执无法读取：{e}")))?)
            .map_err(|e| err(format!("中继回执无法解析：{e}")))?;
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            return Err(err(format!("中继拒绝了这次的帧：{v}")));
        }
        self.up += bytes.len() as i64;
        Ok(())
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
            let wait = left.min(Duration::from_millis(LONG_POLL_MS)).as_millis();
            let url = format!("{}?after={}&wait={}", self.url, self.cursor, wait);
            let resp = self.agent.get(&url).call().map_err(|e| err(format!("中继取件失败：{e}")))?;
            let v: Value = serde_json::from_str(&resp.into_string().map_err(|e| err(format!("中继取件无法读取：{e}")))?)
                .map_err(|e| err(format!("中继取件无法解析：{e}")))?;
            if let Some(frames) = v.get("frames").and_then(|f| f.as_array()) {
                for f in frames {
                    if let Some(data) = f.get("data").and_then(|x| x.as_str()) {
                        match B64.decode(data) {
                            Ok(bytes) => {
                                self.down += bytes.len() as i64;
                                // 自己投的帧跳过：房间是两端共用的，服务端不认发送者。
                                match self.sender(&bytes) {
                                    Some((device, _)) if device == self.device => {}
                                    Some((_, body)) => self.pending.push_back(body.to_vec()),
                                    None => self.pending.push_back(bytes),
                                }
                            }
                            Err(_) => return Err(err("中继来的帧不是合法 base64")),
                        }
                    }
                    if let Some(seq) = f.get("seq").and_then(|x| x.as_i64()) {
                        self.cursor = self.cursor.max(seq);
                    }
                }
            }
            if let Some(frame) = self.pending.pop_front() {
                return Ok(Some(frame));
            }
        }
    }

    fn path(&self) -> String {
        "relay".to_string()
    }

    fn stats(&self) -> (i64, i64) {
        (self.up, self.down)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(device: &str) -> RelayLink {
        RelayLink::new("http://127.0.0.1:1", "a".repeat(32).as_str(), device).unwrap()
    }

    /// 前缀能原样拆回来；没有前缀的老帧按「对端原帧」返回，不丢。
    #[test]
    fn relay_stamp_round_trips_and_tolerates_old_frames() {
        let a = link("dev-a");
        let stamped = a.stamp(b"hello").unwrap();
        let (device, body) = a.sender(&stamped).unwrap();
        assert_eq!(device, "dev-a");
        assert_eq!(body, b"hello");

        // 老客户端的裸帧：没有合法前缀 → None，调用方按原帧处理
        assert!(a.sender(b"hello").is_none());
        // 长度字节超出数据长度：同样不 panic
        assert!(a.sender(&[200, 1, 2]).is_none());
    }

    /// 取件时自己的帧必须被跳过，否则握手会看到「对面自称是我」。
    #[test]
    fn relay_own_frames_are_filtered_before_pending() {
        let a = link("dev-a");
        let b = link("dev-b");
        let mine = a.stamp(b"mine").unwrap();
        let theirs = b.stamp(b"theirs").unwrap();

        // 模拟 recv 里那段过滤：a 看到两帧，只应留下 b 的
        let mut kept = Vec::new();
        for bytes in [mine, theirs] {
            match a.sender(&bytes) {
                Some((device, _)) if device == a.device => {}
                Some((_, body)) => kept.push(body.to_vec()),
                None => kept.push(bytes),
            }
        }
        assert_eq!(kept, vec![b"theirs".to_vec()]);
    }
}
