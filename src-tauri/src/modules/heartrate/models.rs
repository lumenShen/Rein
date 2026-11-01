//! 心率域对外模型（serde camelCase，与 `src/types/heartRate.ts` 互为镜像）。

use serde::Serialize;

/// 连接状态机。字符串值与前端 `HrState` 一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnState {
    Idle,
    Scanning,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

/// 扫描到的设备。`has_heart_rate` 表示广播里带了 0x180D（不代表一定连得上）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HrDevice {
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
    pub has_heart_rate: bool,
}

/// 一条心率样本（0x2A37 解码后）。`at` 是 Unix 毫秒。
///
/// 除了 bpm，还带测量会话的实时读数：前端只在事件里更新这几项，不必每秒再
/// 调一次 `hr_state`（省掉一轮 IPC，也让浏览器 mock 与真机走同一套字段）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HrSample {
    pub bpm: u16,
    pub contact: Option<bool>,
    pub at: i64,
    pub rr_ms: Vec<u16>,
    pub zone: Option<u8>,
    pub pct_max: Option<u8>,
    pub workout_active: bool,
    pub live_avg_bpm: Option<u16>,
    pub live_max_bpm: Option<u16>,
    pub live_kcal: Option<f64>,
    pub live_coverage: Option<f64>,
    pub live_elapsed_sec: Option<u32>,
    pub live_level: Option<u8>,
}

/// 一次测量会话的最终读数。只有收到过样本才会产生。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HrWorkoutSummary {
    /// 从开始测量到现在（墙钟）。
    pub duration_sec: u32,
    /// 样本覆盖到的秒数（间隔 > 10s 的空档不计入）。
    pub measured_sec: u32,
    /// measured_sec / duration_sec，0..1。
    pub coverage: f64,
    pub samples: u32,
    pub avg_bpm: Option<u16>,
    pub max_bpm: Option<u16>,
    pub min_bpm: Option<u16>,
    /// Keytel 公式积分；样本不足或心率过低时可能为 0。
    pub kcal: Option<f64>,
    pub zones: Vec<HrZoneTime>,
    /// 平均心率落点所在的 5 分区（1..5）。
    pub level: Option<u8>,
    /// 由平均心率反推的强度档（low / moderate / high），与 healthsync 的阈值一致。
    pub intensity: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HrZoneTime {
    pub zone: u8,
    pub seconds: u32,
}

/// 前端轮询 / 事件共用的完整状态快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HrStatus {
    pub supported: bool,
    pub state: ConnState,
    pub device: Option<HrDevice>,
    pub devices: Vec<HrDevice>,
    pub bpm: Option<u16>,
    pub contact: Option<bool>,
    pub last_sample_at: Option<i64>,
    pub error: Option<String>,
    pub max_hr: Option<u16>,
    pub zone: Option<u8>,
    pub workout_active: bool,
    pub live_avg_bpm: Option<u16>,
    pub live_max_bpm: Option<u16>,
    pub live_kcal: Option<f64>,
    /// 当前测量会话的样本覆盖率（0..1）；未在测量时为 null。
    pub live_coverage: Option<f64>,
    pub live_elapsed_sec: Option<u32>,
    /// 当前平均心率落在的 5 分区。
    pub live_level: Option<u8>,
}
