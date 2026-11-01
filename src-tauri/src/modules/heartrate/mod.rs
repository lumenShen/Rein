//! 心率域：标准蓝牙心率服务（0x180D / 0x2A37）采集与运动消耗估算。
//!
//! 为什么整条链路放在 Rust（而不是 JS 逐包处理）：
//! - 蓝牙扫描 / 连接 / notify 由系统事件驱动，采集线程只在本模块内跑；前端只收
//!   1 Hz 节流后的样本事件，界面不被高频 BLE 回调牵着走；
//! - Keytel 热量积分、区间计时、平均 / 最高 / 覆盖率都在 [`calc::Measurement`]
//!   里流式累加，内存与训练时长无关；前端只在开始与结束时各发一条命令；
//! - 训练开始才连接、结束即断开，避免长期占用唯一的中心连接（手环同时只能连一个
//!   中心，手机 App 连着时电脑连不上 —— 这是设备侧限制，UI 会提示）。
//!
//! 平台：桌面（btleplug：Windows / macOS / Linux）。Android 的 droidplug 需要
//! JavaVM 初始化与运行时权限，当前返回 `supported = false`，由 UI 说明桌面可用。

pub mod calc;
pub mod commands;
pub mod models;
#[cfg(not(target_os = "android"))]
pub mod parse;
#[cfg(not(target_os = "android"))]
mod worker;

use std::sync::{Arc, Mutex, MutexGuard};
#[cfg(not(target_os = "android"))]
use std::time::Duration;

use tauri::{AppHandle, Emitter};
#[cfg(not(target_os = "android"))]
use tokio::sync::mpsc::unbounded_channel;
use tokio::sync::mpsc::UnboundedSender;

use calc::{HrProfile, Measurement};
use models::{ConnState, HrDevice, HrStatus};

pub const EVENT_STATUS: &str = "hr://status";
pub const EVENT_SAMPLE: &str = "hr://sample";

/// 扫描多少秒自动停：够用户认出设备，又不让射频一直开着。
#[cfg(not(target_os = "android"))]
const SCAN_SECS: u64 = 15;
/// 样本事件的最小间隔。手环可能 4 Hz 发包，界面 1 Hz 足够，也省 CPU。
#[cfg(not(target_os = "android"))]
const SAMPLE_EVENT_MIN_MS: i64 = 900;

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 采集线程命令。`Sample` / `PumpEnded` 带 generation：连接换代后旧泵的残余消息直接丢弃。
#[cfg_attr(target_os = "android", allow(dead_code))]
pub(crate) enum Cmd {
    ScanStart,
    ScanStop,
    Connect { id: String, name: Option<String> },
    Disconnect,
    Sample { generation: u64, bytes: Vec<u8> },
    PumpEnded { generation: u64 },
}

pub struct HrService {
    shared: Arc<Mutex<Shared>>,
    #[cfg(not(target_os = "android"))]
    cmd_tx: Mutex<Option<UnboundedSender<Cmd>>>,
    app: AppHandle,
}

pub(crate) struct Shared {
    pub supported: bool,
    pub state: ConnState,
    pub device: Option<HrDevice>,
    pub devices: Vec<HrDevice>,
    pub bpm: Option<u16>,
    pub contact: Option<bool>,
    pub last_sample_at: Option<i64>,
    pub error: Option<String>,
    pub profile: HrProfile,
    pub measurement: Option<Measurement>,
    pub last_emit_ms: i64,
}

impl Shared {
    fn status(&self, now: i64) -> HrStatus {
        let measurement = self.measurement.as_ref();
        HrStatus {
            supported: self.supported,
            state: self.state,
            device: self.device.clone(),
            devices: self.devices.clone(),
            bpm: self.bpm,
            contact: self.contact,
            last_sample_at: self.last_sample_at,
            error: self.error.clone(),
            max_hr: self.profile.max_hr(),
            zone: self.bpm.and_then(|bpm| self.profile.zone_of(bpm)),
            workout_active: measurement.is_some(),
            live_avg_bpm: measurement.and_then(Measurement::avg_bpm),
            live_max_bpm: measurement.and_then(Measurement::max_bpm),
            live_kcal: measurement.and_then(Measurement::kcal),
            live_coverage: measurement.map(|m| (m.coverage(now) * 1000.0).round() / 1000.0),
            live_elapsed_sec: measurement.map(|m| m.elapsed_sec(now)),
            live_level: measurement.and_then(Measurement::level),
        }
    }
}

pub(crate) fn lock_shared(shared: &Arc<Mutex<Shared>>) -> MutexGuard<'_, Shared> {
    // 小型状态锁：采集线程或命令线程 panic 过后，取回内层数据继续用，
    // 不让一条坏样本把整个心率功能永久锁死（与 state::Db 的中毒自愈同一条理由）。
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl HrService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                supported: cfg!(not(target_os = "android")),
                state: ConnState::Idle,
                device: None,
                devices: Vec::new(),
                bpm: None,
                contact: None,
                last_sample_at: None,
                error: None,
                profile: HrProfile::default(),
                measurement: None,
                last_emit_ms: 0,
            })),
            #[cfg(not(target_os = "android"))]
            cmd_tx: Mutex::new(None),
            app,
        }
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn shared(&self) -> Arc<Mutex<Shared>> {
        Arc::clone(&self.shared)
    }

    pub fn status(&self) -> HrStatus {
        let shared = lock_shared(&self.shared);
        shared.status(now_ms())
    }

    pub fn emit_status(&self) {
        let status = self.status();
        let _ = self.app.emit(EVENT_STATUS, status);
    }

    pub fn set_profile(&self, profile: HrProfile) -> HrStatus {
        {
            let mut shared = lock_shared(&self.shared);
            shared.profile = profile.clone();
            if let Some(m) = shared.measurement.as_mut() {
                m.set_profile(profile);
            }
        }
        self.emit_status();
        self.status()
    }

    pub fn scan_start(&self) -> HrStatus {
        {
            let mut shared = lock_shared(&self.shared);
            if !shared.supported {
                shared.error = Some("当前平台暂不支持蓝牙心率采集，请在桌面端使用".into());
                shared.state = ConnState::Idle;
                drop(shared);
                self.emit_status();
                return self.status();
            }
            // 已连接 / 正在连接时扫描会把状态覆盖成 scanning，也会白耗射频：
            // 换设备必须先断开（UI 同样只在这时给「重新扫描」）。
            if matches!(
                shared.state,
                ConnState::Connected | ConnState::Connecting | ConnState::Reconnecting
            ) {
                drop(shared);
                return self.status();
            }
            shared.devices.clear();
            shared.state = ConnState::Scanning;
            shared.error = None;
        }
        self.dispatch(Cmd::ScanStart);
        self.emit_status();
        self.status()
    }

    pub fn scan_stop(&self) -> HrStatus {
        self.dispatch(Cmd::ScanStop);
        {
            let mut shared = lock_shared(&self.shared);
            if shared.state == ConnState::Scanning {
                shared.state = ConnState::Idle;
            }
        }
        self.emit_status();
        self.status()
    }

    pub fn connect(&self, id: String, name: Option<String>) -> HrStatus {
        {
            let mut shared = lock_shared(&self.shared);
            if !shared.supported {
                shared.error = Some("当前平台暂不支持蓝牙心率采集，请在桌面端使用".into());
                drop(shared);
                self.emit_status();
                return self.status();
            }
            shared.state = ConnState::Connecting;
            shared.device = Some(HrDevice {
                id: id.clone(),
                name: name.clone().unwrap_or_else(|| "心率设备".into()),
                rssi: None,
                has_heart_rate: true,
            });
            shared.bpm = None;
            shared.contact = None;
            shared.last_sample_at = None;
            shared.error = None;
        }
        self.dispatch(Cmd::Connect { id, name });
        self.emit_status();
        self.status()
    }

    pub fn disconnect(&self) -> HrStatus {
        {
            let mut shared = lock_shared(&self.shared);
            shared.state = ConnState::Idle;
            shared.device = None;
            shared.bpm = None;
            shared.contact = None;
            shared.last_sample_at = None;
            shared.error = None;
        }
        self.dispatch(Cmd::Disconnect);
        self.emit_status();
        self.status()
    }

    /// 开始一次测量。已有同一 started_at 的测量时不重置（恢复会话会重复调用）。
    /// `paused` 用于恢复到暂停态的跑步：测量从暂停开始，暂停时长不计入覆盖率。
    pub fn workout_start(
        &self,
        profile: HrProfile,
        started_at_ms: Option<i64>,
        device_id: Option<String>,
        device_name: Option<String>,
        paused: bool,
    ) -> HrStatus {
        let started = started_at_ms.unwrap_or_else(now_ms);
        {
            let mut shared = lock_shared(&self.shared);
            shared.profile = profile.clone();
            if !shared.supported {
                drop(shared);
                return self.status();
            }
            let same = shared
                .measurement
                .as_ref()
                .is_some_and(|m| m.started_ms() == started);
            if !same {
                let mut measurement = Measurement::new(started, profile);
                if paused {
                    measurement.set_paused(true, now_ms());
                }
                shared.measurement = Some(measurement);
            } else if let Some(m) = shared.measurement.as_mut() {
                m.set_profile(profile);
                m.set_paused(paused, now_ms());
            }
        }
        if let Some(id) = device_id {
            // 已连接 / 正在连同一台就不重复发起连接；换设备或未连接才连接
            let should_connect = {
                let shared = lock_shared(&self.shared);
                match (&shared.state, shared.device.as_ref()) {
                    (ConnState::Connected | ConnState::Connecting | ConnState::Reconnecting, Some(d)) => {
                        d.id != id
                    }
                    _ => true,
                }
            };
            if should_connect {
                self.connect(id, device_name);
            }
        }
        self.emit_status();
        self.status()
    }

    pub fn workout_finish(&self) -> Option<models::HrWorkoutSummary> {
        let summary = {
            let mut shared = lock_shared(&self.shared);
            shared
                .measurement
                .take()
                .and_then(|m| m.summary(now_ms()))
        };
        self.emit_status();
        summary
    }

    pub fn workout_cancel(&self) -> HrStatus {
        {
            let mut shared = lock_shared(&self.shared);
            shared.measurement = None;
        }
        self.emit_status();
        self.status()
    }

    /// 暂停测量积分（跑步暂停 / 自动暂停 / 进入总结）。暂停期间的样本不计热量。
    pub fn workout_pause(&self) -> HrStatus {
        self.set_measurement_paused(true)
    }

    pub fn workout_resume(&self) -> HrStatus {
        self.set_measurement_paused(false)
    }

    fn set_measurement_paused(&self, paused: bool) -> HrStatus {
        {
            let mut shared = lock_shared(&self.shared);
            if let Some(m) = shared.measurement.as_mut() {
                m.set_paused(paused, now_ms());
            }
        }
        self.emit_status();
        self.status()
    }

    fn set_error(&self, message: String) {
        {
            let mut shared = lock_shared(&self.shared);
            shared.state = ConnState::Error;
            shared.error = Some(message);
        }
        self.emit_status();
    }

    fn dispatch(&self, cmd: Cmd) {
        match self.ensure_worker() {
            Ok(tx) => {
                if tx.send(cmd).is_err() {
                    self.set_error("蓝牙采集线程不可用，请重启应用后再试".into());
                }
            }
            Err(message) => self.set_error(message),
        }
    }

    #[cfg(not(target_os = "android"))]
    fn ensure_worker(&self) -> Result<UnboundedSender<Cmd>, String> {
        let mut guard = self
            .cmd_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(tx) = guard.as_ref() {
            return Ok(tx.clone());
        }
        let (tx, rx) = unbounded_channel();
        worker::spawn(self.app.clone(), self.shared(), tx.clone(), rx);
        *guard = Some(tx.clone());
        Ok(tx)
    }

    #[cfg(target_os = "android")]
    fn ensure_worker(&self) -> Result<UnboundedSender<Cmd>, String> {
        Err("当前平台暂不支持蓝牙心率采集，请在桌面端使用".into())
    }
}

/// 扫描状态与设备列表的共享时间参数（worker 与命令层共用）。
#[cfg(not(target_os = "android"))]
pub(crate) const SCAN_TIMEOUT: Duration = Duration::from_secs(SCAN_SECS);
#[cfg(not(target_os = "android"))]
pub(crate) const SAMPLE_THROTTLE_MS: i64 = SAMPLE_EVENT_MIN_MS;
