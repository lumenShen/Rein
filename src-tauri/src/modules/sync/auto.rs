//! 自动同步：打开应用就拉一次，之后按间隔兜底。
//!
//! ---------- 为什么放在 Rust 侧 ----------
//!
//! 同步会话本来就在后台线程里跑（`commands::spawn_session`），与前端页面无关。
//! 如果由前端在 `App.vue` 里发起，用户一开就停在别的页、或者 WebView 还没加载完，
//! 「启动即同步」就会漏掉；而这个功能的承诺恰恰是**用户什么都不用做**。
//!
//! ---------- 什么时候跑 ----------
//!
//! - 启动后先等 1.5 秒：迁移、种子、首帧都在头一两秒，别在这时抢 CPU 与网络；
//! - 起跑后每 30 秒看一次表（设置 / 有没有对端 / 上次同步时间），满足条件才发起会话；
//! - **每次启动必定跑一轮**（不管上次同步多近）—— 这是「每次启动都自动拉取」的承诺；
//! - 之后的最小间隔由 `SyncSettings.interval_min` 决定（默认 15 分钟），手动同步也算
//!   一次「刚同步过」，不会紧接着再自动跑一轮；
//! - 正在跑会话（手动 / 上一轮自动）时礼让，不算一次尝试，下一拍再看。
//!
//! 失败不弹窗、不重试风暴：一次尝试失败就等下一个间隔。网络断开时每 30 秒撞一次
//! 没有意义，用户也看不到任何变化 —— 真正的错误会在下一轮成功后自然消失。
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::state::AppState;

use super::models::SyncSettings;

/// 表每 30 秒看一次：开关拨过去最多半分钟生效，足够「自动」。
const TICK: Duration = Duration::from_secs(30);
/// 首屏让位：迁移 / 种子 / 前端首帧都在这段时间里。
const START_DELAY: Duration = Duration::from_millis(1500);

/// 启动常驻线程（`lib.rs` 的 setup 里调一次）。
pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("rein-sync-auto".into())
        .spawn(move || loop_forever(app));
    if let Err(e) = spawned {
        eprintln!("自动同步线程启动失败：{e}");
    }
}

fn loop_forever(app: AppHandle) {
    std::thread::sleep(START_DELAY);
    let mut last_attempt: Option<Instant> = None;
    let mut first_tick = true;

    loop {
        // 只在这段短锁里读设置与状态；会话本身在另一个线程、另一段锁里跑。
        let (settings, peers, last_at, module_on) = {
            let state = app.state::<AppState>();
            let conn = state.db.lock();
            let settings = SyncSettings::load(&conn);
            let peers: i64 = conn
                .query_row("SELECT COUNT(*) FROM sync_peers", [], |r| r.get(0))
                .unwrap_or(0);
            let last_at: Option<i64> = super::meta_get(&conn, "last_at").and_then(|v| v.parse().ok());
            // 「设备」模块被关掉 → 不主动联网；捕获线程不受影响（见 commands::spawn_session）
            let module_on = crate::modules::gateway::store::is_module_enabled(&conn, "sync");
            (settings, peers, last_at, module_on)
        };

        // 没入组（没有对端）就没什么可连的；关掉开关 / 关掉模块时一律不联网。
        if settings.auto && module_on && peers > 0 && !super::commands::session_running() {
            let interval = Duration::from_secs(settings.interval_min.max(1) as u64 * 60);
            let now = chrono::Utc::now().timestamp_millis();
            let since_last_run = last_at.map(|t| now - t).unwrap_or(i64::MAX);
            let interval_due = last_attempt
                .map(|t| t.elapsed() >= interval)
                .unwrap_or(true)
                && since_last_run >= interval.as_millis() as i64;

            if first_tick || interval_due {
                match super::commands::spawn_session(app.clone(), true) {
                    Ok(()) => last_attempt = Some(Instant::now()),
                    // 极小概率的竞态：检查完就被手动同步抢先了。不算一次尝试，下一拍再来。
                    Err(_) => {}
                }
            }
        }

        first_tick = false;
        std::thread::sleep(TICK);
    }
}
