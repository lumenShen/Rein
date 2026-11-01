//! BLE 采集线程（btleplug）。只在桌面目标编译。
//!
//! 一个专用线程 + current_thread tokio 运行时：蓝牙回调与重连退避都在这里阻塞 /
//! 等待，不占 Tauri 主线程，也不让 WebView 每帧处理 GATT 事件。
//!
//! 线程内的状态机只做四件事：扫描、连接并订阅 0x2A37、把样本交给 Shared、
//! 断线后按 0/1/2/4s 退避重连（最多 4 次）。重连失败把状态置为 error，等用户
//! 重新连接——手环关机 / 被手机抢占时无止境重试只会更费电。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{Central, CharPropFlags, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::task::JoinHandle;

use super::models::{ConnState, HrDevice, HrSample};
use super::parse;
use super::{
    lock_shared, now_ms, Cmd, Shared, EVENT_SAMPLE, EVENT_STATUS, SAMPLE_THROTTLE_MS, SCAN_TIMEOUT,
};

const HEART_RATE_SERVICE: u16 = 0x180D;
const HEART_RATE_MEASUREMENT: u16 = 0x2A37;
const TICK: Duration = Duration::from_secs(2);
const RECONNECT_DELAYS: [u64; 4] = [0, 1, 2, 4];
/** 连接 + 发现服务 + 订阅的硬上限。Windows/WinRT 在设备被手机占用时会一直挂起
 *  （connect 不返回也不报错），没有这段超时界面就会永远停在「正在连接」。 */
const ATTACH_TIMEOUT: Duration = Duration::from_secs(15);
/** 失败清场时最多等这么久：信道已经坏了，disconnect 也可能挂。 */
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) fn spawn(
    app: AppHandle,
    shared: Arc<Mutex<Shared>>,
    tx: UnboundedSender<Cmd>,
    rx: UnboundedReceiver<Cmd>,
) {
    let fallback_app = app.clone();
    let fallback_shared = Arc::clone(&shared);
    let builder = std::thread::Builder::new().name("rein-heartrate".into());
    let spawned = builder.spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                fail_shared(&shared, &app, format!("心率线程启动失败：{e}"));
                return;
            }
        };
        runtime.block_on(async move {
            Worker::new(app, shared, tx).run(rx).await;
        });
    });
    if let Err(e) = spawned {
        fail_shared(
            &fallback_shared,
            &fallback_app,
            format!("心率线程启动失败：{e}"),
        );
    }
}

fn fail_shared(shared: &Arc<Mutex<Shared>>, app: &AppHandle, message: String) {
    {
        let mut s = lock_shared(shared);
        s.state = ConnState::Error;
        s.error = Some(message);
    }
    let status = lock_shared(shared).status(now_ms());
    let _ = app.emit(EVENT_STATUS, status);
}

struct Worker {
    app: AppHandle,
    shared: Arc<Mutex<Shared>>,
    tx: UnboundedSender<Cmd>,
    adapter: Option<Adapter>,
    scanned: HashMap<String, Peripheral>,
    scan_until: Option<Instant>,
    peripheral: Option<Peripheral>,
    pump: Option<JoinHandle<()>>,
    generation: u64,
    intent: bool,
}

impl Worker {
    fn new(app: AppHandle, shared: Arc<Mutex<Shared>>, tx: UnboundedSender<Cmd>) -> Self {
        Self {
            app,
            shared,
            tx,
            adapter: None,
            scanned: HashMap::new(),
            scan_until: None,
            peripheral: None,
            pump: None,
            generation: 0,
            intent: false,
        }
    }

    async fn run(mut self, mut rx: UnboundedReceiver<Cmd>) {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                Some(cmd) = rx.recv() => self.handle(cmd).await,
                _ = tick.tick() => self.on_tick().await,
            }
        }
    }

    async fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::ScanStart => self.start_scan().await,
            Cmd::ScanStop => self.stop_scan().await,
            Cmd::Connect { id, name } => self.connect(id, name).await,
            Cmd::Disconnect => self.disconnect().await,
            Cmd::Sample { generation, bytes } => {
                if generation == self.generation {
                    self.on_sample(&bytes);
                }
            }
            Cmd::PumpEnded { generation } => {
                if generation == self.generation && self.intent {
                    self.recover().await;
                }
            }
        }
    }

    /* ---------- 状态与事件 ---------- */

    fn update(&self, f: impl FnOnce(&mut Shared)) {
        let mut shared = lock_shared(&self.shared);
        f(&mut shared);
    }

    fn emit(&self) {
        let status = lock_shared(&self.shared).status(now_ms());
        let _ = self.app.emit(EVENT_STATUS, status);
    }

    fn fail(&self, message: String) {
        self.update(|s| {
            s.state = ConnState::Error;
            s.error = Some(message);
        });
        self.emit();
    }

    /* ---------- 扫描 ---------- */

    async fn ensure_adapter(&mut self) -> Result<Adapter, String> {
        if let Some(adapter) = &self.adapter {
            return Ok(adapter.clone());
        }
        let manager = Manager::new()
            .await
            .map_err(|e| format!("无法初始化蓝牙：{e}"))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|e| format!("无法读取蓝牙适配器：{e}"))?;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| "没有可用的蓝牙适配器".to_string())?;
        self.adapter = Some(adapter.clone());
        Ok(adapter)
    }

    async fn start_scan(&mut self) {
        let adapter = match self.ensure_adapter().await {
            Ok(a) => a,
            Err(e) => return self.fail(e),
        };
        if let Err(e) = adapter.start_scan(ScanFilter::default()).await {
            return self.fail(format!("无法启动蓝牙扫描：{e}"));
        }
        self.scanned.clear();
        self.scan_until = Some(Instant::now() + SCAN_TIMEOUT);
        self.update(|s| {
            s.state = ConnState::Scanning;
            s.error = None;
            s.devices.clear();
        });
        self.emit();
        self.refresh_devices(&adapter).await;
    }

    async fn stop_scan(&mut self) {
        if let Some(adapter) = self.adapter.clone() {
            let _ = adapter.stop_scan().await;
        }
        self.scan_until = None;
        self.update(|s| {
            if s.state == ConnState::Scanning {
                s.state = ConnState::Idle;
            }
        });
        self.emit();
    }

    async fn refresh_devices(&mut self, adapter: &Adapter) {
        let peripherals = match adapter.peripherals().await {
            Ok(list) => list,
            Err(_) => return,
        };
        let mut devices = Vec::new();
        for peripheral in peripherals {
            let properties = match peripheral.properties().await {
                Ok(Some(p)) => p,
                _ => continue,
            };
            let has_heart_rate = properties
                .services
                .iter()
                .any(|uuid| *uuid == uuid_from_u16(HEART_RATE_SERVICE));
            let raw_name = properties
                .local_name
                .clone()
                .or_else(|| properties.advertisement_name.clone())
                .unwrap_or_default();
            let name = raw_name.trim().to_string();
            if name.is_empty() && !has_heart_rate {
                continue;
            }
            let id = peripheral.id().to_string();
            let display_name = if name.is_empty() {
                format!("心率设备 {}", tail(&id))
            } else {
                name
            };
            devices.push(HrDevice {
                id: id.clone(),
                name: display_name,
                rssi: properties.rssi,
                has_heart_rate,
            });
            self.scanned.insert(id, peripheral);
        }
        devices.sort_by(|a, b| {
            b.has_heart_rate
                .cmp(&a.has_heart_rate)
                .then_with(|| b.rssi.unwrap_or(i16::MIN).cmp(&a.rssi.unwrap_or(i16::MIN)))
        });
        devices.truncate(24);
        let changed = {
            let shared = lock_shared(&self.shared);
            shared.devices != devices
        };
        if changed {
            self.update(|s| s.devices = devices);
            self.emit();
        }
    }

    /* ---------- 连接 ---------- */

    async fn find_peripheral(&mut self, id: &str) -> Result<Peripheral, String> {
        if let Some(found) = self.scanned.get(id) {
            return Ok(found.clone());
        }
        let adapter = self.ensure_adapter().await?;
        if let Some(found) = find_in(&adapter, id).await {
            self.scanned.insert(id.to_string(), found.clone());
            return Ok(found);
        }
        let _ = adapter.start_scan(ScanFilter::default()).await;
        let mut found = None;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if !self.intent {
                break;
            }
            if let Some(p) = find_in(&adapter, id).await {
                found = Some(p);
                break;
            }
        }
        let _ = adapter.stop_scan().await;
        match found {
            Some(p) => {
                self.scanned.insert(id.to_string(), p.clone());
                Ok(p)
            }
            None => Err("没有找到设备。请确认手环在附近，且已开启心率广播".to_string()),
        }
    }

    async fn connect(&mut self, id: String, name: Option<String>) {
        self.intent = true;
        self.generation = self.generation.wrapping_add(1);
        self.abort_pump();
        if let Some(adapter) = self.adapter.clone() {
            let _ = adapter.stop_scan().await;
        }
        self.scan_until = None;
        if let Some(old) = self.peripheral.take() {
            if old.is_connected().await.unwrap_or(false) {
                let _ = old.disconnect().await;
            }
        }
        self.update(|s| {
            s.state = ConnState::Connecting;
            s.device = Some(HrDevice {
                id: id.clone(),
                name: name.unwrap_or_else(|| "心率设备".into()),
                rssi: None,
                has_heart_rate: true,
            });
            s.error = None;
            s.bpm = None;
            s.contact = None;
        });
        self.emit();
        let peripheral = match self.find_peripheral(&id).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[heartrate] find peripheral failed: {e}");
                return self.fail(e);
            }
        };
        self.peripheral = Some(peripheral.clone());
        if let Err(e) = self.attach(&peripheral).await {
            self.fail(format!("连接失败：{e}"));
        }
    }

    /// 连接 → 发现服务 → 订阅 0x2A37 → 起通知泵。成功时把状态置 connected。
    /// 整段带超时：任何一步挂住都按失败收尾，并尽力把半开的连接清掉。
    async fn attach(&mut self, peripheral: &Peripheral) -> Result<(), String> {
        let result = match tokio::time::timeout(ATTACH_TIMEOUT, self.attach_inner(peripheral)).await {
            Ok(result) => result,
            Err(_) => Err("连接超时（15 秒）：手环可能仍连着手机 App，或没有开启心率广播".into()),
        };
        if let Err(e) = &result {
            eprintln!("[heartrate] attach failed: {e}");
            let _ = tokio::time::timeout(CLEANUP_TIMEOUT, peripheral.disconnect()).await;
        }
        result
    }

    async fn attach_inner(&mut self, peripheral: &Peripheral) -> Result<(), String> {
        if !peripheral.is_connected().await.unwrap_or(false) {
            peripheral
                .connect()
                .await
                .map_err(|e| format!("{e}（手环可能仍连着手机）"))?;
        }
        peripheral
            .discover_services()
            .await
            .map_err(|e| format!("读取服务失败：{e}"))?;
        let characteristics = peripheral.characteristics();
        let target = characteristics
            .iter()
            .find(|c| c.uuid == uuid_from_u16(HEART_RATE_MEASUREMENT))
            .cloned()
            .ok_or_else(|| "该设备没有标准心率测量特征（0x2A37）".to_string())?;
        if !target
            .properties
            .intersects(CharPropFlags::NOTIFY | CharPropFlags::INDICATE)
        {
            return Err("该设备的心率特征不支持通知".into());
        }
        peripheral
            .subscribe(&target)
            .await
            .map_err(|e| format!("订阅心率通知失败：{e}"))?;
        let mut stream = peripheral
            .notifications()
            .await
            .map_err(|e| format!("监听心率通知失败：{e}"))?;
        let generation = self.generation;
        let tx = self.tx.clone();
        let pump = tokio::spawn(async move {
            while let Some(notification) = stream.next().await {
                if tx
                    .send(Cmd::Sample {
                        generation,
                        bytes: notification.value,
                    })
                    .is_err()
                {
                    return;
                }
            }
            let _ = tx.send(Cmd::PumpEnded { generation });
        });
        self.pump = Some(pump);

        let properties = peripheral.properties().await.ok().flatten();
        let id = peripheral.id().to_string();
        let name = properties
            .as_ref()
            .and_then(|p| p.local_name.clone().or_else(|| p.advertisement_name.clone()))
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| "心率设备".into());
        let rssi = properties.and_then(|p| p.rssi);
        self.peripheral = Some(peripheral.clone());
        self.update(|s| {
            s.state = ConnState::Connected;
            s.error = None;
            s.device = Some(HrDevice {
                id,
                name,
                rssi,
                has_heart_rate: true,
            });
        });
        self.emit();
        eprintln!("[heartrate] connected and subscribed 0x2A37");
        Ok(())
    }

    async fn disconnect(&mut self) {
        self.intent = false;
        self.generation = self.generation.wrapping_add(1);
        self.abort_pump();
        if let Some(adapter) = self.adapter.clone() {
            let _ = adapter.stop_scan().await;
        }
        self.scan_until = None;
        if let Some(peripheral) = self.peripheral.take() {
            if peripheral.is_connected().await.unwrap_or(false) {
                let _ = peripheral.disconnect().await;
            }
        }
        self.update(|s| {
            s.state = ConnState::Idle;
            s.device = None;
            s.bpm = None;
            s.contact = None;
            s.last_sample_at = None;
            s.error = None;
        });
        self.emit();
    }

    /* ---------- 断线重连 ---------- */

    async fn recover(&mut self) {
        if !self.intent {
            return;
        }
        let Some(peripheral) = self.peripheral.clone() else {
            return;
        };
        self.abort_pump();
        self.generation = self.generation.wrapping_add(1);
        self.update(|s| {
            s.state = ConnState::Reconnecting;
            s.error = Some("连接中断，正在重连…".into());
        });
        self.emit();
        for (i, delay) in RECONNECT_DELAYS.iter().enumerate() {
            if !self.intent {
                return;
            }
            if *delay > 0 {
                tokio::time::sleep(Duration::from_secs(*delay)).await;
            }
            if !self.intent {
                return;
            }
            if peripheral.is_connected().await.unwrap_or(false) {
                let _ = peripheral.disconnect().await;
            }
            match self.attach(&peripheral).await {
                Ok(()) => return,
                Err(e) => {
                    if i + 1 == RECONNECT_DELAYS.len() {
                        self.fail(format!("连接已断开，重连失败：{e}"));
                    }
                }
            }
        }
    }

    fn abort_pump(&mut self) {
        if let Some(pump) = self.pump.take() {
            pump.abort();
        }
    }

    /* ---------- 样本 ---------- */

    fn on_sample(&self, bytes: &[u8]) {
        let Some(parsed) = parse::parse_measurement(bytes) else {
            return;
        };
        let at = now_ms();
        let sample = {
            let mut shared = lock_shared(&self.shared);
            shared.bpm = Some(parsed.bpm);
            shared.contact = parsed.contact;
            shared.last_sample_at = Some(at);
            // 样本恢复：清掉「15 秒未收到心率」这类过时提示（连接类错误已在 attach 时清）
            if shared.state == ConnState::Connected {
                shared.error = None;
            }
            let (zone, pct_max) = {
                let profile = shared
                    .measurement
                    .as_ref()
                    .map_or(&shared.profile, |m| m.profile());
                let zone = profile.zone_of(parsed.bpm);
                let pct_max = profile.max_hr().map(|max| {
                    ((f64::from(parsed.bpm) / f64::from(max)) * 100.0).round() as u8
                });
                (zone, pct_max)
            };
            if let Some(active) = shared.measurement.as_mut() {
                active.push(at, parsed.bpm);
            }
            if at - shared.last_emit_ms < SAMPLE_THROTTLE_MS {
                return;
            }
            shared.last_emit_ms = at;
            let measurement = shared.measurement.as_ref();
            HrSample {
                bpm: parsed.bpm,
                contact: parsed.contact,
                at,
                rr_ms: parsed.rr_ms,
                zone,
                pct_max,
                workout_active: measurement.is_some(),
                live_avg_bpm: measurement.and_then(super::calc::Measurement::avg_bpm),
                live_max_bpm: measurement.and_then(super::calc::Measurement::max_bpm),
                live_kcal: measurement.and_then(super::calc::Measurement::kcal),
                live_coverage: measurement
                    .map(|m| (m.coverage(at) * 1000.0).round() / 1000.0),
                live_elapsed_sec: measurement.map(|m| m.elapsed_sec(at)),
                live_level: measurement.and_then(super::calc::Measurement::level),
            }
        };
        let _ = self.app.emit(EVENT_SAMPLE, sample);
    }

    /* ---------- 周期检查 ---------- */

    async fn on_tick(&mut self) {
        if let Some(deadline) = self.scan_until {
            if Instant::now() >= deadline {
                if let Some(adapter) = self.adapter.clone() {
                    let _ = adapter.stop_scan().await;
                }
                self.scan_until = None;
                self.update(|s| {
                    if s.state == ConnState::Scanning {
                        s.state = ConnState::Idle;
                    }
                });
                self.emit();
            } else if let Some(adapter) = self.adapter.clone() {
                self.refresh_devices(&adapter).await;
            }
        }
        if !self.intent {
            return;
        }
        let connected_state = {
            let shared = lock_shared(&self.shared);
            shared.state == ConnState::Connected
        };
        if !connected_state {
            return;
        }
        if let Some(peripheral) = &self.peripheral {
            if matches!(peripheral.is_connected().await, Ok(false)) {
                self.recover().await;
                return;
            }
        }
        // 连接还在但 15 秒没有样本：部分固件退后台后会停播。清掉旧读数并在
        // 状态里说明原因，别让界面一直挂着一个早就过时的心率。
        let stale = {
            let shared = lock_shared(&self.shared);
            shared.bpm.is_some()
                && shared
                    .last_sample_at
                    .is_some_and(|at| now_ms() - at > 15_000)
        };
        if stale {
            self.update(|s| {
                s.bpm = None;
                s.contact = None;
                s.error = Some("15 秒未收到心率，请在手环上确认心率广播仍开启".into());
            });
            self.emit();
        }
    }
}

async fn find_in(adapter: &Adapter, id: &str) -> Option<Peripheral> {
    let peripherals = adapter.peripherals().await.ok()?;
    peripherals
        .into_iter()
        .find(|p| p.id().to_string() == id)
}

/// 取 id 的尾部几位，给无广播名的设备一个可区分的占位名。
fn tail(id: &str) -> String {
    let chars: Vec<char> = id.chars().rev().take(5).collect();
    chars.into_iter().rev().collect()
}
