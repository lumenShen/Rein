//! Health Connect 双向同步命令。
//!
//! ## 一次同步的四步
//!
//! 1. `health_sync_start`：查授权，清掉上一轮的桥文件，让 Kotlin 去读 HC；
//! 2. 前端每隔几百毫秒调 `health_sync_step`，直到 `phase` 不再是 `pending`；
//! 3. step 里：HC 的记录文件一落地就交给 [`super::adapter`] 翻译，然后落库
//!    （新记录插入、变了的覆盖、HC 里没了的删掉）；
//! 4. 开了「回写 HC」的话，接着把本地记录写出去（新建 / 重写 / 收起已删除的副本），
//!    再等 Kotlin 把 `clientRecordId → recordId` 的结果写回来。
//!
//! 为什么拆成 start + step 而不是一个命令里跑完：HC 的读取是**协程异步**的，
//! 结果只会出现在文件里（见 `super` 的模块说明）。Rust 侧拿不到回调，
//! 只能「轮询文件是否落地」——同步是发后不管的，轮询动作交给前端驱动，
//! 与 `modules/tracking` 的 `tracking_status` 轮询同一个形状。
//!
//! ## 谁能改哪一侧
//!
//! - 导入记录（`source = 'health_connect'`）：**Health Connect 是权威**。
//!   每次同步以 HC 为准覆盖；HC 里没了就跟着删。想在 Rein 里改一条导入记录
//!   而不被下次同步改回去，本期做不到（那需要「转为本地记录」这个动作，见待办）。
//! - 本地记录（`source = 'local'`）：**本机是权威**。只有开了回写开关才会流向 HC，
//!   而且只流一次（靠指纹判断本地改没改过）。
//! - 用户在 Rein 里删掉一条导入记录：本地删 + 记墓碑，**不动 HC 侧那份** ——
//!   那可能是别家 App 写进去的数据，删它等于替用户改了别的 App 的账。
//!   墓碑保证下次同步不会又把它拉回来。

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{meta_get, meta_set};
use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::adapter;
use super::models::{
    Change, HcMetricRow, HcReadPayload, HcWritePayload, HealthMetricPoint, HealthMetricSeries,
    HealthWorkoutRow, LocalWorkout, SyncReport, SyncStatus, WorkoutDraft,
};
use super::{
    read_json, remove_file, write_json, Pending, Stage, PENDING, PULL_FILE, PUSH_FILE, STATE_FILE,
    WRITE_FILE,
};

/// 「把本地记录也写进 HC」的开关（默认关：那是往外写用户系统健康数据的事，得用户点头）
const PUSH_KEY: &str = "health_sync.push_enabled";
const LAST_SYNC_KEY: &str = "health_sync.last_sync_at";

/// 读取下界的兜底值：HC 里不可能有 2000 年以前的运动记录
/// （与 Kotlin `HealthConnectBridge.EPOCH` 同源，两侧口径一致）。
const FLOOR_DATE: &str = "2000-01-01";

/// 单步等待上限：Kotlin 侧异常时文件不会落地，靠它收场而不是无限轮询
const STEP_TIMEOUT: Duration = Duration::from_secs(45);

/* ---------------- 桥文件形状 ---------------- */

/// Kotlin 写的 `state.json`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeState {
    /// `available` / `unavailable` / `update_required`
    availability: String,
    read_granted: bool,
    write_granted: bool,
    /// 四组读权限各自是否齐全（exercise/activity/body/vitals）。
    /// 旧桥没有这份 → 空表，前端按「未授权」引导。
    #[serde(default)]
    granted_categories: HashMap<String, bool>,
    /// 上一轮操作的失败原因（Kotlin 每次开新操作会清掉）
    #[serde(default)]
    error: Option<String>,
}

/// Kotlin 写的 `push-result.json`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushResult {
    #[serde(default)]
    results: Vec<PushLink>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushLink {
    client_record_id: String,
    record_id: String,
}

/* ---------------- 回执 ---------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    /// `unsupported` / `unavailable` / `needs_auth` / `pending` / `done` / `error`
    pub phase: &'static str,
    pub report: Option<SyncReport>,
    pub message: Option<String>,
}

impl SyncStep {
    fn phase(phase: &'static str) -> Self {
        Self {
            phase,
            report: None,
            message: None,
        }
    }
}

/* ---------------- 命令 ---------------- */

/// 平台/授权/开关/计数的一次性快照。
///
/// 会顺手让 Kotlin 重算一遍授权（用户在系统里撤销授权时 Rein 不会收到通知），
/// 所以第一次调用可能读到稍旧的值 —— 前端轮询一次就收敛了。
#[tauri::command]
pub fn health_sync_status(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<SyncStatus> {
    if supported() {
        super::dispatch(&app, "refresh", None);
    }
    let bridge: Option<BridgeState> = read_json(&app, STATE_FILE);
    let conn = state.db.lock();
    let imported_count = count(&conn, "source = 'health_connect'")?;
    let exported_count = count(&conn, "external_id IS NOT NULL AND source = 'local'")?;
    let auto_start = auto_window_start(&conn)?;
    Ok(SyncStatus {
        supported: supported(),
        // 读取授权要走 HC 的 binder，只能在协程里算，所以 state.json 是**异步**写出来的。
        // 页面刚进来时它可能还不存在 —— 那时报 `unknown` 而不是 `unavailable`：
        // 把「还没检测」说成「不可用」等于对用户撒谎（实测过，首次进入会误报不可用，
        // 退出再进就正常了）。前端对 `unknown` 轮询几次收敛到真值。
        availability: bridge
            .as_ref()
            .map(|b| b.availability.clone())
            .unwrap_or_else(|| "unknown".into()),
        read_granted: bridge.as_ref().map(|b| b.read_granted).unwrap_or(false),
        write_granted: bridge.as_ref().map(|b| b.write_granted).unwrap_or(false),
        granted_categories: bridge
            .as_ref()
            .map(|b| b.granted_categories.clone())
            .unwrap_or_default(),
        push_enabled: push_enabled(&conn),
        last_sync_at: meta_get(&conn, LAST_SYNC_KEY),
        imported_count,
        exported_count,
        auto_window_start: auto_start,
    })
}

/// 拉起 Health Connect 自己的授权页。
///
/// `mode` = `read` 只要读权限，`write` 要读 + 写。
/// **这里不能用系统运行时权限弹窗**：HC 的权限没有 `requestPermissions` 那条路，
/// 只能在 HC 的界面上授予（这也是「引导用户去授权」这件事在本域必须存在的原因）。
#[tauri::command]
pub fn health_sync_authorize(
    app: tauri::AppHandle,
    mode: String,
) -> Result<()> {
    if !supported() {
        return Err(ReinError::coded("health_unsupported", "桌面端没有 Health Connect"));
    }
    super::dispatch(&app, "requestPermissions", Some(mode));
    Ok(())
}

/// 开关「把本地记录回写进 Health Connect」
#[tauri::command]
pub fn health_sync_set_push(
    app: tauri::AppHandle,
    state: State<AppState>,
    enabled: bool,
) -> Result<()> {
    let conn = state.db.lock();
    meta_set(&conn, PUSH_KEY, if enabled { "1" } else { "0" })?;
    drop(conn);
    // 打开开关时立刻刷一次状态：前端要马上知道还要不要去申请写权限
    if supported() {
        super::dispatch(&app, "refresh", None);
    }
    Ok(())
}

/// 起一轮同步（不阻塞）。返回 `pending` 就表示已经让 Kotlin 去读了。
///
/// `window_start` 是读取下界的三态：`None` = 程序自动（最早导入记录，无则 2000）；
/// `Some("2000-01-01")` = 从头拉全部；其他合法 `YYYY-MM-DD` = 用户自定义。
/// 它只经 JNI 传给 Kotlin 当读取起点，并留在本轮 Pending 里给回收逻辑做 guard；
/// 不进 app_meta（这个偏好只存前端 localStorage，避免死键与双写）。
#[tauri::command]
pub fn health_sync_start(
    app: tauri::AppHandle,
    state: State<AppState>,
    push: bool,
    max_hr: Option<f64>,
    utc_offset_seconds: i64,
    window_start: Option<String>,
) -> Result<SyncStep> {
    if !supported() {
        return Ok(SyncStep::phase("unsupported"));
    }
    // 上一轮没走完就被再点一次：直接丢弃旧态，重新开始
    *PENDING.lock().unwrap() = None;

    let bridge: Option<BridgeState> = read_json(&app, STATE_FILE);
    let Some(bridge) = bridge else {
        return Ok(SyncStep::phase("unavailable"));
    };
    if bridge.availability != "available" {
        return Ok(SyncStep::phase("unavailable"));
    }
    if !bridge.read_granted {
        return Ok(SyncStep::phase("needs_auth"));
    }
    let push = push && bridge.write_granted;

    // 取锁是**无条件**的：关着回写时原来根本不碰连接，窗口就没地方算了。
    // 窗口必须在 remove_file(PULL_FILE) 之前定下来 —— 之后 step 读到的 pull.json
    // 就是按这个下界读的，回收逻辑要与它同口径。
    let window = {
        let conn = state.db.lock();
        if push {
            meta_set(&conn, PUSH_KEY, "1")?;
        }
        resolve_window(&conn, window_start.as_deref())?
    };

    // 文件即信号：清掉旧的，等 Kotlin 写新的那份（见模块说明）
    remove_file(&app, PULL_FILE);
    remove_file(&app, PUSH_FILE);
    *PENDING.lock().unwrap() = Some(Pending {
        stage: Stage::PollPull,
        report: SyncReport {
            pushed: push,
            ..Default::default()
        },
        push,
        max_hr,
        utc_offset_seconds,
        window_start: window.clone(),
        started: Instant::now(),
    });
    super::dispatch(&app, "startRead", Some(window));
    Ok(SyncStep::phase("pending"))
}

/// 推进一轮同步。前端按几百毫秒的间隔轮询，直到 `phase` 不是 `pending`。
#[tauri::command]
pub fn health_sync_step(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<SyncStep> {
    let mut dispatches: Vec<(&'static str, Option<String>)> = Vec::new();
    let outcome;
    {
        let mut guard = PENDING.lock().unwrap();
        let Some(pending) = guard.as_mut() else {
            return Ok(SyncStep::phase("idle"));
        };

        let bridge: Option<BridgeState> = read_json(&app, STATE_FILE);
        if let Some(err) = bridge.as_ref().and_then(|b| b.error.clone()) {
            *guard = None;
            return Ok(SyncStep {
                phase: "error",
                report: None,
                message: Some(err),
            });
        }

        match pending.stage {
            Stage::PollPull => {
                let Some(payload) = read_json::<HcReadPayload>(&app, PULL_FILE) else {
                    if pending.started.elapsed() > STEP_TIMEOUT {
                        *guard = None;
                        return Ok(SyncStep {
                            phase: "error",
                            report: None,
                            message: Some(超时文案()),
                        });
                    }
                    return Ok(SyncStep::phase("pending"));
                };
                remove_file(&app, PULL_FILE);
                // 这一步之后 report 里已经有 imported/updated/removed/scanned
                let (counts, metrics_imported) = {
                    let conn = state.db.lock();
                    // 入库是「清镜像 + 几百行 upsert + 回收删除」的批量写。不开事务时
                    // 每条语句各自提交（各写一次 WAL），90 天窗口下就是几百次提交；
                    // 而且中途失败会把镜像留在「已清空、未填满」的半截状态。
                    let tx = conn.unchecked_transaction()?;
                    let counts = apply_pull(&tx, &payload, pending.max_hr, &pending.window_start)?;
                    let metrics = apply_metrics(&tx, &payload.metrics)?;
                    tx.commit()?;
                    (counts, metrics)
                };
                pending.report.imported = counts.imported;
                pending.report.updated = counts.updated;
                pending.report.removed = counts.removed;
                pending.report.scanned = payload.records.len() as i64;
                pending.report.metrics_imported = metrics_imported;

                if pending.push {
                    let (payload, exported, re_exported, skipped) = {
                        let conn = state.db.lock();
                        build_push(&conn, pending.utc_offset_seconds)?
                    };
                    pending.report.exported = exported;
                    pending.report.re_exported = re_exported;
                    pending.report.skipped = skipped;
                    if payload.records.is_empty() {
                        pending.stage = Stage::Done;
                    } else {
                        write_json(&app, WRITE_FILE, &payload)?;
                        remove_file(&app, PUSH_FILE);
                        pending.started = Instant::now();
                        pending.stage = Stage::PollPush;
                        dispatches.push(("startWrite", None));
                    }
                } else {
                    pending.stage = Stage::Done;
                }
            }
            Stage::PollPush => {
                let Some(result) = read_json::<PushResult>(&app, PUSH_FILE) else {
                    if pending.started.elapsed() > STEP_TIMEOUT {
                        *guard = None;
                        return Ok(SyncStep {
                            phase: "error",
                            report: None,
                            message: Some(超时文案()),
                        });
                    }
                    return Ok(SyncStep::phase("pending"));
                };
                remove_file(&app, PUSH_FILE);
                if let Some(err) = result.error {
                    *guard = None;
                    return Ok(SyncStep {
                        phase: "error",
                        report: None,
                        message: Some(err),
                    });
                }
                {
                    let conn = state.db.lock();
                    apply_push_links(&conn, &result.results)?;
                }
                pending.stage = Stage::Done;
            }
            Stage::Done => {}
        }

        if matches!(pending.stage, Stage::Done) {
            let done = guard.take().unwrap();
            let conn = state.db.lock();
            meta_set(&conn, LAST_SYNC_KEY, &chrono::Utc::now().to_rfc3339())?;
            drop(conn);
            outcome = SyncStep {
                phase: "done",
                report: Some(done.report),
                message: None,
            };
        } else {
            outcome = SyncStep::phase("pending");
        }
    }
    // JNI 一律在锁外发：dispatch 会切到 WebView 主线程，持有 PENDING 锁时切线程
    // 万一撞上重入就是死锁（同 modules/tracking 的取舍）
    for (method, arg) in dispatches {
        super::dispatch(&app, method, arg);
    }
    Ok(outcome)
}

/// 健康数据查询：每个指标的**全量**镜像序列（近 90 天窗口、含空天）。
///
/// 预览卡与指标详情抽屉共用这一份：前者自己切最近 14 天的窗口画条形，
/// 后者把全部行当 raw 数据列表展示。行数 = 指标数 × 有值的天数（≤ 16×90），
/// 量级很小，不分页。
///
/// `async`：这是「关于你」首屏四路中的一路；读数本身很快，但不该和索引线程
/// 抢主线程（同步命令拿不到 DB 锁时会原地阻塞窗口消息泵）。
#[tauri::command(async)]
pub fn health_metrics_all(state: State<AppState>) -> Result<Vec<HealthMetricSeries>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT metric, day, value FROM health_metrics ORDER BY metric, day",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // ORDER BY metric, day → 同一指标必然连续出现，按「相邻同 metric」分桶；
    // latest 取最晚一天（ISO 日期串排序即时间序）
    let mut series: Vec<HealthMetricSeries> = Vec::new();
    for (metric, day, value) in rows {
        match series.last_mut() {
            Some(s) if s.metric == metric => {
                s.latest_day = day.clone();
                s.latest_value = value;
                s.points.push(HealthMetricPoint { day, value });
            }
            _ => series.push(HealthMetricSeries {
                metric,
                latest_day: day.clone(),
                latest_value: value,
                points: vec![HealthMetricPoint { day, value }],
            }),
        }
    }
    Ok(series)
}

/// 本机存的第三方运动记录全量（只读）：导入记录 + 缺开始时间的本机记录。
///
/// 给健康数据页分两块展示：一块是 HC 同步进来的镜像（`source='health_connect'`），
/// 一块是回写 HC 时因缺开始时间被跳过的本机记录（`source='local' AND start_min IS NULL`
/// —— 用户那句「没填开始时间」的字面集）。
///
/// 与 [`build_push`] 的 `skipped` **不是恒等**，两处已知边界（[`missing_start_is_close_to_push_skipped`]
/// 把「现实数据里相等、边界处不等」钉成了测试）：
/// - `start_min` 非空但日期不可解析的本机记录也会被 `to_write_draft` 判 None 进 skipped，
///   却不落在这个 `start_min IS NULL` 集合里；
/// - 导入记录若是越界 epoch（`adapter` 的 `local_parts` 回退 None），会带 NULL `start_min`
///   落进本集合，但 `build_push` 只遍历 `source='local'`，它不进 skipped。
///
/// 复用 [`LOCAL_COLS`] + [`row_to_local`]，不另抄一份列清单 —— 抄了就得跟着
/// `workouts` 表结构一起改。
#[tauri::command]
pub fn health_sync_workouts(state: State<AppState>) -> Result<Vec<HealthWorkoutRow>> {
    let conn = state.db.lock();
    health_sync_workouts_on(&conn)
}

/// 收 `&Connection` 的本体：与 [`crate::modules::exercise::commands::list_workouts_on`] 同形，
/// 让命令层与测试共用同一条 SQL（命令签名带 `State`，测试里拿不到）。
pub(crate) fn health_sync_workouts_on(conn: &rusqlite::Connection) -> Result<Vec<HealthWorkoutRow>> {
    let sql = format!(
        "SELECT {LOCAL_COLS} FROM workouts \
         WHERE source = 'health_connect' OR start_min IS NULL \
         ORDER BY date DESC, (start_min IS NULL), start_min"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_local)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|lw| HealthWorkoutRow {
            id: lw.id,
            name: lw.draft.name,
            r#type: lw.draft.workout_type,
            date: lw.draft.date,
            start_min: lw.draft.start_min,
            duration_min: lw.draft.duration_min,
            kcal: lw.draft.kcal,
            intensity: lw.draft.intensity,
            note: lw.draft.note,
            source: lw.source,
            external_id: lw.external_id,
        })
        .collect())
}

/// 移除传播：删掉某条导出记录的 HC 副本（由 `delete_workout` **与对外网关**调用）。
///
/// 入参是 `&AppHandle`（contract §13.3）：网关服务层拿不到 `Webview`，只能给 `AppHandle`，
/// 由 `super::dispatch` 内部取 webview。`tauri` 命令路径经 `webview.app_handle()` 传同一份。
///
/// 泛型只为「调用方不绑死运行时」：网关的 `handle_connection` 是 `R: Runtime` 泛型
/// （单元测试用 `tauri::test::MockRuntime`），这里跟着泛型就不必为测试改道。
pub(crate) fn propagate_delete<R: tauri::Runtime>(app: &tauri::AppHandle<R>, record_id: &str) {
    super::dispatch(app, "deleteRecord", Some(record_id.to_string()));
}

/// 打开回写开关了吗
pub(crate) fn is_push_enabled(conn: &rusqlite::Connection) -> bool {
    push_enabled(conn)
}

/// 记一条墓碑：用户在本机删掉的导入记录，下次同步别再拉回来
pub(crate) fn add_tombstone(conn: &rusqlite::Connection, external_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO health_sync_tombstones (external_id, deleted_at) VALUES (?1, ?2) \
         ON CONFLICT(external_id) DO UPDATE SET deleted_at = excluded.deleted_at",
        rusqlite::params![external_id, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/* ---------------- 算法 ---------------- */

/// 体征镜像整表替换：表的内容 = 本次 pull 里按天聚合的行。
///
/// 为什么不做增量合并：Kotlin 每轮都全窗口（90 天）重读，收到的集合就是
/// HC 侧「现在该有什么」的完整答案 —— 直接替换，撤销授权的那组、用户在
/// HC 里删掉的某天数据，下一次同步自然消失，不必另立一套墓碑。
/// 表里也可能有 `metric`/`day` 相同的重复行（Kotlin 聚合的兜底），upsert 收口。
fn apply_metrics(conn: &rusqlite::Connection, rows: &[HcMetricRow]) -> Result<i64> {
    conn.execute("DELETE FROM health_metrics", [])?;
    let now = chrono::Utc::now().to_rfc3339();
    for row in rows {
        conn.execute(
            "INSERT INTO health_metrics (metric, day, value, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(metric, day) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![row.metric, row.day, row.value, now],
        )?;
    }
    Ok(rows.len() as i64)
}

/// 自动模式的下界：本机最早一条导入记录的日期。
///
/// **只查 workouts，绝不查 health_metrics**：那张表每轮整表替换、只含近 90 天
/// （apply_metrics 全量 DELETE + 重插，Kotlin 侧 METRICS_WINDOW=90 天），
/// `MIN(day)` 永远落在近 90 天内 —— 拿它当「最早数据」会把默认下界从 2000
/// 悄悄收到约 90 天。`workouts.date` 是导入记录自带的本地日期，才是对的锚。
fn auto_window_start(conn: &rusqlite::Connection) -> Result<Option<String>> {
    Ok(conn.query_row(
        "SELECT MIN(date) FROM workouts WHERE source = 'health_connect'",
        [],
        |r| r.get::<_, Option<String>>(0),
    )?)
}

/// 本轮读取下界：用户自定义优先 → 自动（最早导入记录）→ 兜底 [`FLOOR_DATE`]。
///
/// 自定义串用 chrono 校验 `YYYY-MM-DD`，非法一律按自动处理 ——
/// 宁可多读，也别让一个手滑的输入把窗口收到错的地方。
fn resolve_window(conn: &rusqlite::Connection, custom: Option<&str>) -> Result<String> {
    if let Some(s) = custom {
        if chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() {
            return Ok(s.to_string());
        }
    }
    Ok(auto_window_start(conn)?.unwrap_or_else(|| FLOOR_DATE.to_string()))
}

fn supported() -> bool {
    cfg!(target_os = "android")
}

fn 超时文案() -> String {
    "Health Connect 没有在预期时间内返回结果，请重试".to_string()
}

fn push_enabled(conn: &rusqlite::Connection) -> bool {
    meta_get(conn, PUSH_KEY).as_deref() == Some("1")
}

fn count(conn: &rusqlite::Connection, filter: &str) -> Result<i64> {
    let sql = format!("SELECT COUNT(*) FROM workouts WHERE {filter}");
    Ok(conn.query_row(&sql, [], |r| r.get(0))?)
}

/// 只在导入方向动的三个计数
#[derive(Debug, Default)]
struct PullCounts {
    imported: i64,
    updated: i64,
    removed: i64,
}

/// 读出来的 HC 记录怎么落到 `workouts`。
///
/// 三条规则，对应三种「变化」：
/// - 本地没有 → 插入（`imported`）
/// - 本地有、内容变了 → 覆盖（`updated`）
/// - HC 里没有了、本地却还有镜像 → 删掉（`removed`）
///
/// 最后一条的前提是「`seen` 就是 HC 侧该有的完整集合」。用户可配读取下界之后，
/// 这个前提要补一句：只对**窗口内**成立 —— 窗口外的记录本轮根本没读，
/// 所以回收（[`seen_superset`]）与断链都必须按 `window_start` 收窄，
/// 否则会把窗口外的旧镜像全判成「HC 里已删」而误删。
///
/// `window_start` 之前的记录在主循环里直接跳过：不导入、**也不进 seen**
/// （进 seen 就等于宣称「HC 里这条还在窗口内」，但事实是没读）。于是 24h 的
/// 读取前移只会让 Kotlin 多读几条回来、不会多导，镜像也不受牵连。
fn apply_pull(
    conn: &rusqlite::Connection,
    payload: &HcReadPayload,
    max_hr: Option<f64>,
    window_start: &str,
) -> Result<PullCounts> {
    let mut counts = PullCounts::default();
    let local = load_by_external_id(conn)?;
    let tombstones = load_tombstones(conn)?;
    let mut seen: HashSet<String> = HashSet::new();

    for rec in &payload.records {
        // 自己写进去的那份不算第三方数据（否则导出方向会变成回环）
        if adapter::is_own_export(rec) {
            continue;
        }
        let draft = adapter::to_draft(rec, max_hr);
        // 窗口下界之前的记录：用户要的是这个起点之后的数据，直接跳过。
        // 这里比的是**记录自带的本地日期**，与回收 guard 同口径。
        // 注意跳过发生在 tombstones/seen 之前 —— 既不导入也不进 seen。
        if draft.date.as_str() < window_start {
            continue;
        }
        if tombstones.contains(&rec.id) {
            continue;
        }
        seen.insert(rec.id.clone());

        match adapter::classify(local.get(&rec.id), &draft, rec.last_modified_epoch_ms) {
            Change::Insert => {
                insert_imported(conn, &rec.id, rec.last_modified_epoch_ms, &draft)?;
                counts.imported += 1;
            }
            Change::Update => {
                let existing = local.get(&rec.id).expect("classify 说 Update，本地必然有");
                update_workout(conn, existing.id, &draft)?;
                conn.execute(
                    "UPDATE workouts SET external_updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![rec.last_modified_epoch_ms, existing.id],
                )?;
                counts.updated += 1;
            }
            Change::Unchanged => {}
        }
    }

    // 镜像回收：HC 侧已经删掉的记录，本地这份也收掉
    for id in seen_superset(&local, &seen, window_start) {
        conn.execute("DELETE FROM workouts WHERE id = ?1", [id])?;
        counts.removed += 1;
    }

    // 断链：本地记录（已导出过）在 HC 侧的那份被删了 —— 用户在小米运动健康里删掉、
    // 或换了健康 App —— 把外键清掉，让它下一轮重新导出去，
    // 而不是永远指着一个不存在的 id（那条记录此后既更新不了也删不掉）。
    // 这里要用**未过滤**的全集：自己写出去的那份也在里面（它排在 seen 之外）。
    let all_hc_ids: HashSet<&str> = payload.records.iter().map(|r| r.id.as_str()).collect();
    for lw in local.values() {
        if lw.source != "local" {
            continue;
        }
        // 窗口外的导出记录不受本轮影响：本轮没读那一段，判不出它的 HC 副本
        // 是真被删了还是只是没读到 —— 不加这个 guard 会把窗口外的外键全清掉，
        // 让它们下一轮重复导出。
        if lw.draft.date.as_str() < window_start {
            continue;
        }
        // 残余边界（有意不处理）：本机记录的日期在窗口内、而它在 HC 侧那份的日期
        // 被用户在别家 App 里改到了窗口外时，这里仍会判成断链、把外键清掉。
        // 不修的理由是**它自愈且无副作用**：清掉后下一轮重新导出，而导出的幂等键是
        // `rein-workout-<本机 id>`（客户端 id 不随 HC 侧改动变化），Kotlin 的 startWrite
        // 每次都先按它把自己写过的那条删掉再插 —— 所以不会在 HC 里留下两条，
        // 代价只是一次多余的重写。要「修」它就得去猜一份读不到的记录还在不在，
        // 那比这个残余边界更危险。
        let dangling = lw
            .external_id
            .as_deref()
            .map(|ext| !all_hc_ids.contains(ext))
            .unwrap_or(false);
        if dangling {
            conn.execute(
                "UPDATE workouts SET external_id = NULL, external_updated_at = NULL, \
                 external_fingerprint = NULL WHERE id = ?1",
                [lw.id],
            )?;
        }
    }
    Ok(counts)
}

/// 需要回收的本地镜像 id 列表（只碰 `source = 'health_connect'` 的行）。
///
/// `window_start` 之外的一律不动：本轮读取是从这个下界起的，那段 HC 数据
/// 根本没读到，`seen` 里没有它们不代表「HC 里没了」。
fn seen_superset(
    local: &HashMap<String, LocalWorkout>,
    seen: &HashSet<String>,
    window_start: &str,
) -> Vec<i64> {
    local
        .values()
        .filter(|lw| {
            lw.source == "health_connect"
                && lw.draft.date.as_str() >= window_start
                && lw
                    .external_id
                    .as_deref()
                    .map(|ext| !seen.contains(ext))
                    .unwrap_or(false)
        })
        .map(|lw| lw.id)
        .collect()
}

/// 本地要往 HC 写哪些记录：没导出过的（新建）+ 指纹变了的（重写）。
///
/// 返回 `(载荷, 新建数, 重写数, 跳过数)`。跳过的是没有开始时间的记录 ——
/// HC 必须有起止时刻，与其编一个假时刻，不如不写并如实告诉用户跳了几条。
///
/// ⚠ 跳过的**不只**手动补录（这句注释原来只写了补录，是错的）：`session_finish`
/// 给课程与跑步落库时也硬写 `start_min = NULL`（见 `modules/session/commands.rs`），
/// 所以课程与跑步记录同样永远导不出去 —— 回写 HC 目前实际只能导出「填了时间的本机补录」。
/// 这是数据口径问题（那两条路要不要带上真实开始时刻），不是这里能改的取舍；
/// 改口径时记得同步改前端那句「跳过 N（没填开始时间）」的措辞。
fn build_push(
    conn: &rusqlite::Connection,
    utc_offset_seconds: i64,
) -> Result<(HcWritePayload, i64, i64, i64)> {
    let locals = load_local_only(conn)?;
    let mut records = Vec::new();
    let mut exported = 0;
    let mut re_exported = 0;
    let mut skipped = 0;
    for lw in &locals {
        let fingerprint = adapter::fingerprint_of(&lw.draft);
        let is_new = lw.external_id.is_none();
        if !is_new && lw.external_fingerprint.as_deref() == Some(fingerprint.as_str()) {
            continue; // 本地没动过，HC 侧那份也就不用重写
        }
        match adapter::to_write_draft(lw, utc_offset_seconds) {
            Some(draft) => {
                records.push(draft);
                if is_new {
                    exported += 1;
                } else {
                    re_exported += 1;
                }
            }
            None => skipped += 1,
        }
    }
    Ok((HcWritePayload { records }, exported, re_exported, skipped))
}

/// 把 Kotlin 写回来的 recordId 记到本地记录上（连同内容指纹）
fn apply_push_links(conn: &rusqlite::Connection, links: &[PushLink]) -> Result<()> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    for link in links {
        // `rein-workout-<id>` → id
        let Some(id) = link
            .client_record_id
            .strip_prefix("rein-workout-")
            .and_then(|s| s.parse::<i64>().ok())
        else {
            continue;
        };
        let fingerprint: Option<String> = conn
            .query_row(
                &format!("SELECT {LOCAL_COLS} FROM workouts WHERE id = ?1"),
                [id],
                |row| row_to_local(row).map(|lw| adapter::fingerprint_of(&lw.draft)),
            )
            .ok();
        let Some(fingerprint) = fingerprint else {
            continue;
        };
        conn.execute(
            "UPDATE workouts SET external_id = ?1, external_updated_at = ?2, external_fingerprint = ?3 \
             WHERE id = ?4",
            rusqlite::params![link.record_id, now_ms, fingerprint, id],
        )?;
    }
    Ok(())
}

/* ---------------- 落库 ---------------- */

/// `LocalWorkout` 的 SELECT 列清单（顺序必须与 [`row_to_local`] 一致）
const LOCAL_COLS: &str = "name, type, date, start_min, duration_min, kcal, intensity, note, \
                          source, external_id, external_updated_at, external_fingerprint, id";

fn row_to_local(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalWorkout> {
    // `external_updated_at` 在表上是 TEXT 列（见 db.rs MIGRATION_0036），而本模块
    // 写入的是毫秒数 —— SQLite 的 TEXT 亲和性会把整数转成文本存进去。所以读它
    // **必须**按 String 读再自己 parse：直接按 Option<i64> 读，第二次同步就会
    // 抛 InvalidColumnType(Text)（第一次同步这些列还是 NULL，所以第一次永远
    // 是好的，坏在第二次 —— 实测过一次，极难当场想到往类型亲和性上想）。
    let external_updated_at: Option<i64> = row
        .get::<_, Option<String>>(10)?
        .and_then(|s| s.parse::<i64>().ok());
    Ok(LocalWorkout {
        draft: WorkoutDraft {
            name: row.get(0)?,
            workout_type: row.get(1)?,
            date: row.get(2)?,
            start_min: row.get(3)?,
            duration_min: row.get(4)?,
            kcal: row.get(5)?,
            intensity: row.get(6)?,
            note: row.get(7)?,
        },
        source: row.get(8)?,
        external_id: row.get(9)?,
        external_updated_at,
        external_fingerprint: row.get(11)?,
        id: row.get(12)?,
    })
}

fn load_by_external_id(conn: &rusqlite::Connection) -> Result<HashMap<String, LocalWorkout>> {
    let sql = format!("SELECT {LOCAL_COLS} FROM workouts WHERE external_id IS NOT NULL");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_local)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|lw| lw.external_id.clone().map(|ext| (ext, lw)))
        .collect())
}

fn load_local_only(conn: &rusqlite::Connection) -> Result<Vec<LocalWorkout>> {
    let sql = format!("SELECT {LOCAL_COLS} FROM workouts WHERE source = 'local'");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_local)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn load_tombstones(conn: &rusqlite::Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT external_id FROM health_sync_tombstones")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().collect())
}

/// 插入一条导入记录。
///
/// `effort` 留空：那是「用户自己说的累不累」，第三方数据里没有这一项，
/// 而 `intensity` 是适配层从心率/配速算出来的客观档位 —— 两者不混。
fn insert_imported(
    conn: &rusqlite::Connection,
    external_id: &str,
    last_modified_epoch_ms: Option<i64>,
    draft: &WorkoutDraft,
) -> Result<()> {
    conn.execute(
        "INSERT INTO workouts \
         (name, type, date, start_min, duration_min, kcal, intensity, effort, note, \
          source, external_id, external_updated_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, 'health_connect', ?9, ?10, ?11)",
        rusqlite::params![
            draft.name,
            draft.workout_type,
            draft.date,
            draft.start_min,
            draft.duration_min,
            draft.kcal,
            draft.intensity,
            draft.note,
            external_id,
            last_modified_epoch_ms,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn update_workout(conn: &rusqlite::Connection, id: i64, draft: &WorkoutDraft) -> Result<()> {
    conn.execute(
        "UPDATE workouts SET name = ?1, type = ?2, date = ?3, start_min = ?4, duration_min = ?5, \
         kcal = ?6, intensity = ?7, note = ?8 WHERE id = ?9",
        rusqlite::params![
            draft.name,
            draft.workout_type,
            draft.date,
            draft.start_min,
            draft.duration_min,
            draft.kcal,
            draft.intensity,
            draft.note,
            id,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::models::HcExerciseRecord;
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn draft() -> WorkoutDraft {
        WorkoutDraft {
            name: "跑步".into(),
            workout_type: "run".into(),
            date: "2026-10-03".into(),
            start_min: Some(12 * 60 + 24),
            duration_min: 30.0,
            kcal: 422.0,
            intensity: "moderate".into(),
            note: None,
        }
    }

    /// 回归：`external_updated_at` 列亲和性是 TEXT，而本模块写入的是整数毫秒
    /// —— SQLite 会把它转成文本存。按 i64 读，第二次同步必抛
    /// InvalidColumnType(Text)（第一次这些列还是 NULL，所以第一次永远没事，
    /// 坏在第二次）。正确读法是按 String 读再 parse。
    #[test]
    fn external_updated_at_survives_the_text_column() {
        let conn = db();
        // 一条本地补录记录（source 走默认 'local'，与 create_workout 同形）
        conn.execute(
            "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, \
             intensity, effort, note, created_at) \
             VALUES ('跑步', 'run', '2026-10-03', 744, 30, 422, 'moderate', NULL, NULL, ?1)",
            rusqlite::params![chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();

        // 导出回填（apply_push_links 写入的是 i64 毫秒）
        apply_push_links(
            &conn,
            &[PushLink {
                client_record_id: "rein-workout-1".into(),
                record_id: "rec-1".into(),
            }],
        )
        .unwrap();

        // **下一次**同步的读取必须成功，且毫秒数原样取回
        let local = load_local_only(&conn).unwrap();
        assert_eq!(local.len(), 1, "本地记录应仍可读");
        // apply_push_links 写的是「当前时刻」，断言它被取回且是合理的毫秒数
        let ms = local[0].external_updated_at.expect("应写入了回填时刻");
        assert!(ms > 1_700_000_000_000, "毫秒数不合理：{ms}");
        assert_eq!(local[0].draft.start_min, Some(12 * 60 + 24));

        let by_ext = load_by_external_id(&conn).unwrap();
        let lw = by_ext.get("rec-1").expect("应按 external_id 找到记录");
        assert_eq!(lw.external_updated_at, Some(ms));
    }

    /// 导入记录同样走 TEXT 列：插入（带整数 lastModified）→ 再读必须成功
    #[test]
    fn imported_rows_survive_the_text_column() {
        let conn = db();
        insert_imported(&conn, "hc-1", Some(1_790_900_000_000_i64), &draft()).unwrap();
        let by_ext = load_by_external_id(&conn).unwrap();
        let lw = by_ext.get("hc-1").expect("应按 external_id 找到导入记录");
        assert_eq!(lw.external_updated_at, Some(1_790_900_000_000));
        assert_eq!(lw.source, "health_connect");
    }

    /// 墓碑 + 幂等键的落库往返
    #[test]
    fn tombstones_round_trip() {
        let conn = db();
        add_tombstone(&conn, "hc-9").unwrap();
        let set = load_tombstones(&conn).unwrap();
        assert!(set.contains("hc-9"));
    }

    /// 体征镜像是整表替换：上一轮的行不能混进下一轮
    /// （撤销授权的组、HC 侧删掉的某天，靠替换自然收敛）
    #[test]
    fn metrics_mirror_fully_replaces_each_sync() {
        let conn = db();
        let round1 = vec![
            HcMetricRow { metric: "steps".into(), day: "2026-10-05".into(), value: 8421.0 },
            HcMetricRow { metric: "sleep_min".into(), day: "2026-10-05".into(), value: 432.0 },
        ];
        apply_metrics(&conn, &round1).unwrap();
        // 第二轮只读到体重（其余被撤销/删除）
        let round2 = vec![
            HcMetricRow { metric: "weight_kg".into(), day: "2026-10-05".into(), value: 72.5 },
        ];
        apply_metrics(&conn, &round2).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM health_metrics", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "上一轮的两行不该留下来");

        let (metric, value): (String, f64) = conn
            .query_row(
                "SELECT metric, value FROM health_metrics WHERE day = '2026-10-05'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(metric, "weight_kg");
        assert!((value - 72.5).abs() < f64::EPSILON);
    }

    /// 旧桥的 pull.json 没有 metrics 字段，serde default 必须兜住
    #[test]
    fn pull_payload_metrics_are_optional() {
        let payload: HcReadPayload = serde_json::from_str(r#"{"records":[]}"#).unwrap();
        assert!(payload.records.is_empty());
        assert!(payload.metrics.is_empty());

        let with: HcReadPayload = serde_json::from_str(
            r#"{"records":[],"metrics":[{"metric":"steps","day":"2026-10-05","value":100.0}]}"#,
        )
        .unwrap();
        assert_eq!(with.metrics.len(), 1);
        assert_eq!(with.metrics[0].metric, "steps");
    }

    /// 一条 HC 运动会话记录（偏移固定 +8h，与 adapter 测试里的 rec() 同口径）
    fn hc_rec(id: &str, start_ms: i64) -> HcExerciseRecord {
        HcExerciseRecord {
            id: id.into(),
            exercise_type: 56,
            title: None,
            notes: None,
            start_epoch_ms: start_ms,
            end_epoch_ms: start_ms + 60 * 60_000,
            utc_offset_seconds: 8 * 3600,
            last_modified_epoch_ms: Some(1_700_000_000_000),
            data_origin: Some("com.mi.health".into()),
            kcal: None,
            distance_m: None,
            avg_heart_rate: None,
        }
    }

    /// (本地日期, 时) → epoch 毫秒，偏移固定 +8h
    fn epoch_ms(y: i32, mo: u32, d: u32, hour: u32) -> i64 {
        use chrono::TimeZone;
        let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let naive = chrono::NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_opt(hour, 0, 0)
            .unwrap();
        offset.from_local_datetime(&naive).unwrap().timestamp_millis()
    }

    /// 窗口外的旧镜像不受回收影响：本轮从 2024-01-01 起读，2023 那条的
    /// 「HC 里已删」判定不成立，必须原样留着。
    #[test]
    fn window_reclamation_spares_rows_before_the_window() {
        let conn = db();
        let mut inside = draft();
        inside.date = "2024-06-01".into();
        insert_imported(&conn, "hc-inside", Some(1), &inside).unwrap();
        let mut before = draft();
        before.date = "2023-06-01".into();
        insert_imported(&conn, "hc-before", Some(2), &before).unwrap();

        // 本轮什么都没读到（seen 为空）：只有窗口内的镜像该被回收
        let payload = HcReadPayload {
            records: vec![],
            metrics: vec![],
        };
        let counts = apply_pull(&conn, &payload, None, "2024-01-01").unwrap();

        assert_eq!(counts.removed, 1, "只该回收窗口内那一条");
        let dates: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT date FROM workouts WHERE source = 'health_connect'")
                .unwrap();
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows
        };
        assert_eq!(
            dates,
            vec!["2023-06-01".to_string()],
            "窗口外那条必须原样留着"
        );
    }

    /// 窗口下界之前的记录既不落库也不进 seen —— 24h 前移只多读、不多导。
    #[test]
    fn pre_window_records_are_not_imported() {
        let conn = db();
        let payload = HcReadPayload {
            records: vec![hc_rec("hc-old", epoch_ms(2023, 12, 31, 10))],
            metrics: vec![],
        };
        // 记录本地日期 2023-12-31，下界 2024-01-01：应整个跳过
        let counts = apply_pull(&conn, &payload, None, "2024-01-01").unwrap();
        assert_eq!(counts.imported, 0, "窗口下界之前的记录不导入");
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workouts WHERE source = 'health_connect'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "窗口下界之前不落库");
    }

    /// 一条本机记录（source 走默认 'local'，与 create_workout 同形）
    fn insert_local(conn: &rusqlite::Connection, name: &str, date: &str, start_min: Option<i64>) {
        conn.execute(
            "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, \
             intensity, effort, note, created_at) \
             VALUES (?1, 'run', ?2, ?3, 30, 300, 'moderate', NULL, NULL, ?4)",
            rusqlite::params![name, date, start_min, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    }

    /// 「缺开始时间」展示块与 `build_push` 的 `skipped` 的关系：**现实数据里大多数相等，边界处不等**。
    ///
    /// 这条把两处边界钉成断言（只写在注释里的话，改动时没人会想起它）：
    /// - 手动补录没填时间 → 既进 skipped 也进展示块（相等的那部分）；
    /// - `start_min` 非空但日期不可解析 → 进 skipped、**不进**展示块；
    /// - 导入记录带 NULL `start_min`（越界 epoch 才会）→ 进展示块、**不进** skipped。
    #[test]
    fn missing_start_is_close_to_push_skipped() {
        let conn = db();
        // ① 补录没填开始时间：两边都算
        insert_local(&conn, "补录没填时间", "2024-05-01", None);
        // ② 补录填了时间：两边都不算
        insert_local(&conn, "补录有填时间", "2024-05-02", Some(600));
        // ③ start_min 有值但日期不可解析：to_write_draft 解不出 epoch → 进 skipped，
        //    可 start_min 非空、source 又是 local，所以**不在**展示块里（边界一）
        insert_local(&conn, "日期坏了", "not-a-date", Some(600));
        // ④ 导入记录带 NULL start_min（越界 epoch 才会）：在展示块里，但 build_push
        //    只遍历 source='local'，所以不进 skipped（边界二）
        let mut broken = draft();
        broken.name = "导入但无开始时间".into();
        broken.date = "2024-05-03".into();
        broken.start_min = None;
        insert_imported(&conn, "hc-broken", None, &broken).unwrap();

        let (_payload, exported, re_exported, skipped) = build_push(&conn, 8 * 3600).unwrap();
        assert_eq!((exported, re_exported), (1, 0), "只有那条填了时间的补录导得出去");
        assert_eq!(skipped, 2, "①与③进 skipped");

        let rows = health_sync_workouts_on(&conn).unwrap();
        let mut names: Vec<&str> = rows.iter().map(|w| w.name.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            vec!["导入但无开始时间", "补录没填时间"],
            "展示块 = ① + ④；②填了时间、③日期坏了但 start_min 非空，两者都不该出现"
        );
        assert!(
            rows.iter()
                .any(|w| w.source == "health_connect" && w.external_id.is_some()),
            "导入块必须带 source 与 external_id（前端靠它分块）"
        );
    }
}
