//! Android 桥：JNI + `cacheDir/connected_apps/*.json` 文件协议。
//!
//! JNI 签名在 plan 里固定（Kotlin `ConnectedAppsBridge` 必须逐字匹配）：
//! - `status(Context, String): String` —— 入参 `"refresh"`，返回 `state.json` 同形 JSON；
//! - `request(Context, String, String): String` —— app + mode，返回 `{opened,reason,root?}`；
//! - `invoke(Context, String, String, String, String): void` ——
//!   app + method + payloadJson + requestId；Kotlin 把结果写到
//!   `cacheDir/connected_apps/<requestId>.json`；
//! - `revoke(Context, String): void` —— 断开 filesystem 时释放 SAF 持久授权。
//!
//! Rust 只写请求文件（`requests/<requestId>.request.json`），结果文件只由 Kotlin 写；
//! 不共写同一文件。JNI 调用抛出的 Java 异常必须 `exception_clear()`，否则会回到
//! Java 主线程炸掉整个进程（healthsync 的实测教训）。

use std::path::Path;
#[cfg(target_os = "android")]
use std::time::Instant;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::error::Result;

use super::models::{
    ConnectedAppInvokeReply, ConnectedAppMeta, ConnectedAppRequestResult, ConnectedAppStatus,
    NativeInvokeResult, NativeStateFile,
};
#[cfg(target_os = "android")]
use super::models::NativeInvokeRequest;
use super::state::{self, AppSpec, EnabledMap, FlagMap};
#[cfg(target_os = "android")]
use super::{subdir, write_json_atomic, MAX_RESULT_FILE_BYTES};
use super::{bridge_dir, read_json_file, REQUESTS_SUBDIR, STATE_FILE};

/// 桥调用（发起）的等待上限：JNI 只负责「把指令交给主线程」，5s 足够。
const BRIDGE_WAIT: Duration = Duration::from_secs(5);
const RESULT_POLL: Duration = Duration::from_millis(50);
/// `connected_app_status` 等 Kotlin 后台 refresh 写新 state 的轮询次数（10 × 50ms）。
const STATE_POLL_ATTEMPTS: usize = 10;
/// 迟到结果文件的清理期限。
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

fn read_state(app: &AppHandle) -> Option<NativeStateFile> {
    let path = bridge_dir(app).ok()?.join(STATE_FILE);
    // 空 `apps` 视为「还没有原生状态」：首次启动时 Kotlin 尚未写出完整 state，
    // 不能把它当成 8 个 app 都 partial，否则 UI 永远等不到「检测中 → 已授权」。
    read_json_file::<NativeStateFile>(&path).filter(|state| !state.apps.is_empty())
}

#[cfg(target_os = "android")]
fn state_mtime(app: &AppHandle) -> Option<std::time::SystemTime> {
    let path = bridge_dir(app).ok()?.join(STATE_FILE);
    std::fs::metadata(path).ok()?.modified().ok()
}

/// 17 条状态（Android 8 来自 Kotlin 原生事实，其余平台 unsupported）。
///
/// 返回 `(状态, 是否仍在刷新)`。Android 上 Kotlin `status()` 只是**触发**后台
/// `refresh` 并立刻返回旧 state；这里记录调用前的 generation/mtime，再最多轮询
/// 10 × 50ms，等本轮 refresh 写盘完成。没等到就返回旧状态并置 `refreshing`，
/// 避免首屏拿上一轮数据却声称是最新（plan §2.2）。
pub(crate) async fn statuses(
    app: &AppHandle,
    enabled: &EnabledMap,
    ai: &FlagMap,
    write: &FlagMap,
) -> Result<(Vec<ConnectedAppStatus>, bool)> {
    #[cfg(target_os = "android")]
    {
        let before = read_state(app);
        let before_mtime = state_mtime(app);

        let jni_state = {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                // Kotlin `status(context, app)`：`*` = 返回全部 8 个 app 的 state。
                bridge_call(&app, "status", &["*"], true)
                    .ok()
                    .flatten()
                    .and_then(|text| serde_json::from_str::<NativeStateFile>(&text).ok())
                    .filter(|state| !state.apps.is_empty())
            })
            .await
            .ok()
            .flatten()
        };

        let mut latest = None;
        let mut advanced = false;
        for _ in 0..STATE_POLL_ATTEMPTS {
            tokio::time::sleep(RESULT_POLL).await;
            let Some(current) = read_state(app) else {
                continue;
            };
            let generation_advanced = before
                .as_ref()
                .map(|old| current.generation != old.generation)
                .unwrap_or(false);
            let mtime_advanced = before_mtime.is_some() && state_mtime(app) != before_mtime;
            if before.is_none() || generation_advanced || mtime_advanced {
                latest = Some(current);
                advanced = true;
                break;
            }
        }

        let native = latest.or(jni_state).or_else(|| read_state(app));
        let refreshing = !advanced && before.is_some();
        Ok((
            state::build_statuses(native.as_ref(), enabled, ai, write),
            refreshing,
        ))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok((state::build_statuses(None, enabled, ai, write), false))
    }
}

/// update 之后取单条状态（不走 JNI，避免阻塞命令线程）。
pub(crate) fn status_for(
    app: &AppHandle,
    spec: &AppSpec,
    enabled: bool,
    ai_intent: bool,
    write_intent: bool,
) -> ConnectedAppStatus {
    let native = read_state(app);
    let app_state = native.as_ref().and_then(|s| s.apps.get(spec.id));
    state::build_status(
        spec,
        app_state,
        enabled,
        ai_intent,
        write_intent,
        native.as_ref().and_then(|s| s.updated_at.as_deref()),
    )
}

/// 拉起系统授权页 / SAF 选择器；只返回「已打开」，不写连接同意。
pub(crate) async fn request(
    app: &AppHandle,
    spec: &AppSpec,
    mode: &str,
) -> Result<ConnectedAppRequestResult> {
    #[cfg(target_os = "android")]
    {
        let app_id = spec.id.to_string();
        let mode_owned = mode.to_string();
        let app2 = app.clone();
        let raw = tauri::async_runtime::spawn_blocking(move || {
            bridge_call(&app2, "request", &[&app_id, &mode_owned], true)
        })
        .await;

        let text = match raw {
            Ok(Ok(Some(text))) => text,
            Ok(Ok(None)) => {
                return Ok(ConnectedAppRequestResult {
                    app: spec.id.to_string(),
                    mode: mode.to_string(),
                    opened: false,
                    reason: Some("Android 桥没有返回授权结果".into()),
                    root: None,
                })
            }
            Ok(Err(e)) => {
                return Ok(ConnectedAppRequestResult {
                    app: spec.id.to_string(),
                    mode: mode.to_string(),
                    opened: false,
                    reason: Some(format!("Android 桥调用失败：{e}")),
                    root: None,
                })
            }
            Err(e) => {
                return Ok(ConnectedAppRequestResult {
                    app: spec.id.to_string(),
                    mode: mode.to_string(),
                    opened: false,
                    reason: Some(format!("Android 桥线程失败：{e}")),
                    root: None,
                })
            }
        };

        let parsed = serde_json::from_str::<Value>(&text).ok();
        return Ok(ConnectedAppRequestResult {
            app: parsed
                .as_ref()
                .and_then(|v| v.get("app"))
                .and_then(|v| v.as_str())
                .unwrap_or(spec.id)
                .to_string(),
            mode: mode.to_string(),
            opened: parsed
                .as_ref()
                .and_then(|v| v.get("opened"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            reason: parsed
                .as_ref()
                .and_then(|v| v.get("reason"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            root: parsed
                .as_ref()
                .and_then(|v| v.get("root"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(ConnectedAppRequestResult {
            app: spec.id.to_string(),
            mode: mode.to_string(),
            opened: false,
            reason: Some("当前平台不是 Android".into()),
            root: None,
        })
    }
}

/// 按 app + method 执行；Android 上经 JNI 交给 Kotlin，轮询结果文件。
pub(crate) async fn invoke(
    app: &AppHandle,
    spec: &AppSpec,
    method: &str,
    payload: &Value,
) -> Result<ConnectedAppInvokeReply> {
    #[cfg(target_os = "android")]
    {
        let dir = bridge_dir(app)?;
        cleanup_stale(&dir);
        let request_id = uuid::Uuid::new_v4().to_string();
        let result_path = dir.join(format!("{request_id}.json"));
        let request_dir = subdir(app, REQUESTS_SUBDIR)?;
        let request_path = request_dir.join(format!("{request_id}.request.json"));
        let timeout = timeout_for(method);
        let expires_at = chrono::Utc::now().timestamp_millis()
            + timeout.as_millis().min(i64::MAX as u128) as i64;
        write_json_atomic(
            &request_path,
            &NativeInvokeRequest {
                app: spec.id.to_string(),
                method: method.to_string(),
                payload: payload.clone(),
                expires_at,
            },
        )?;
        let _ = std::fs::remove_file(&result_path);

        let payload_json = serde_json::to_string(payload)?;
        let app_id = spec.id.to_string();
        let method_owned = method.to_string();
        let request_id_for_jni = request_id.clone();
        let app2 = app.clone();
        let dispatched = tauri::async_runtime::spawn_blocking(move || {
            bridge_call(
                &app2,
                "invoke",
                &[&app_id, &method_owned, &payload_json, &request_id_for_jni],
                false,
            )
        })
        .await;

        let bridge_result = match dispatched {
            Ok(inner) => inner,
            Err(e) => {
                let _ = std::fs::remove_file(&request_path);
                return Ok(ConnectedAppInvokeReply::err(
                    spec.id,
                    method,
                    "connected_app_bridge_error",
                    format!("Android 桥线程失败：{e}"),
                    None,
                ));
            }
        };
        if let Err(e) = bridge_result {
            let _ = std::fs::remove_file(&request_path);
            return Ok(ConnectedAppInvokeReply::err(
                spec.id,
                method,
                "connected_app_bridge_error",
                format!("Android 桥调用失败：{e}"),
                None,
            ));
        }

        let started = Instant::now();
        loop {
            if started.elapsed() > timeout {
                let _ = std::fs::remove_file(&result_path);
                let _ = std::fs::remove_file(&request_path);
                return Ok(ConnectedAppInvokeReply::err(
                    spec.id,
                    method,
                    "connected_app_timeout",
                    "Android 原生调用超时，可重试一次",
                    None,
                ));
            }
            if let Ok(meta) = std::fs::metadata(&result_path) {
                if meta.len() > MAX_RESULT_FILE_BYTES {
                    let _ = std::fs::remove_file(&result_path);
                    return Ok(ConnectedAppInvokeReply::err(
                        spec.id,
                        method,
                        "connected_app_too_large",
                        "原生结果超过 4MB，已拒绝读取",
                        None,
                    ));
                }
            }
            if let Some(result) = read_json_file::<NativeInvokeResult>(&result_path) {
                let _ = std::fs::remove_file(&result_path);
                let _ = std::fs::remove_file(&request_path);
                return Ok(to_reply(spec.id, method, result));
            }
            tokio::time::sleep(RESULT_POLL).await;
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, payload);
        Ok(ConnectedAppInvokeReply::err(
            spec.id,
            method,
            "connected_app_unsupported",
            "Android 原生调用只在 Android 设备上可用",
            None,
        ))
    }
}

fn to_reply(app_id: &str, method: &str, result: NativeInvokeResult) -> ConnectedAppInvokeReply {
    let meta = ConnectedAppMeta {
        truncated: if result.truncated { Some(true) } else { None },
        count: result.count,
        ..Default::default()
    };
    if result.ok {
        ConnectedAppInvokeReply {
            ok: true,
            app: app_id.to_string(),
            method: method.to_string(),
            data: result.data,
            error: None,
            meta: Some(meta),
        }
    } else {
        ConnectedAppInvokeReply {
            ok: false,
            app: app_id.to_string(),
            method: method.to_string(),
            data: result.data,
            error: Some(result.error.unwrap_or_else(|| super::models::ConnectedAppError {
                code: "connected_app_native_error".into(),
                message: "原生调用失败（没有返回错误详情）".into(),
                action: None,
                hint: None,
            })),
            meta: Some(meta),
        }
    }
}

/// 超时按方法：普通查询 15s、文件搜索 25s、位置 20s（plan §3.1）。
fn timeout_for(method: &str) -> Duration {
    if method.contains("search") {
        Duration::from_secs(25)
    } else if method.contains("location") {
        Duration::from_secs(20)
    } else {
        Duration::from_secs(15)
    }
}

/// 清理迟到结果 / 请求文件（>1h）。
fn cleanup_stale(dir: &Path) {
    for sub in [None, Some(REQUESTS_SUBDIR), Some(super::RESULTS_SUBDIR)] {
        let scan = match sub {
            Some(name) => dir.join(name),
            None => dir.to_path_buf(),
        };
        let Ok(entries) = std::fs::read_dir(scan) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let stale = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|age| age > STALE_AFTER)
                .unwrap_or(false);
            if stale && path.is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// 断开 filesystem 时释放 SAF 持久授权（失败只记日志）。
pub(crate) fn revoke(app: &AppHandle, app_id: &str) {
    #[cfg(target_os = "android")]
    {
        let app = app.clone();
        let app_id = app_id.to_string();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            bridge_call(&app, "revoke", &[&app_id], false)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, app_id);
    }
}

/* ---------------- JNI ---------------- */

#[cfg(target_os = "android")]
fn bridge_class<'local>(
    env: &mut jni::JNIEnv<'local>,
    // activity 来自 `exec` 闭包的另一个局部生命周期；不能与 env 绑成同一个 `'local`。
    activity: &jni::objects::JObject<'_>,
) -> jni::errors::Result<jni::objects::JClass<'local>> {
    let name = env.new_string("com.gozaoo.rein.ConnectedAppsBridge")?;
    let class = env
        .call_method(
            activity,
            "getAppClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )?
        .l()?;
    Ok(jni::objects::JClass::from(class))
}

#[cfg(target_os = "android")]
fn call_signature(argc: usize, want_string: bool) -> &'static str {
    match (argc, want_string) {
        (1, true) => "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
        (2, true) => {
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"
        }
        (1, false) => "(Landroid/content/Context;Ljava/lang/String;)V",
        (4, false) => {
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V"
        }
        _ => "",
    }
}

/// JNI 调用统一出口：切到 WebView 主线程、清 Java 异常、可选带回字符串。
#[cfg(target_os = "android")]
fn bridge_call(
    app: &AppHandle,
    method: &'static str,
    args: &[&str],
    want_string: bool,
) -> Result<Option<String>> {
    use tauri::Manager;

    // 通道里只放 String：jni::errors::Error 可能携带 JThrowable（非 Send），
    // 不能让它在 UI 线程与 async 线程之间传递。
    let (tx, rx) =
        std::sync::mpsc::channel::<std::result::Result<Option<String>, String>>();
    let Some(webview) = app.webview_windows().into_values().next() else {
        return Err(crate::error::ReinError::coded(
            "connected_app_bridge_error",
            "找不到 WebView，无法调用 Android 桥",
        ));
    };
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    webview
        .with_webview(move |platform| {
            platform.jni_handle().exec(move |env, activity, _| {
                let res = (|| -> jni::errors::Result<Option<String>> {
                    use jni::objects::{JString, JValue};
                    let class = bridge_class(env, activity)?;
                    let strings: Vec<JString> = owned
                        .iter()
                        .map(|s| env.new_string(s))
                        .collect::<jni::errors::Result<Vec<_>>>()?;
                    let mut values: Vec<JValue> =
                        Vec::with_capacity(strings.len().saturating_add(1));
                    values.push(JValue::Object(activity));
                    for s in &strings {
                        values.push(JValue::Object(s));
                    }
                    let sig = call_signature(owned.len(), want_string);
                    if sig.is_empty() {
                        return Err(jni::errors::Error::WrongJValueType("不支持的桥签名", ""));
                    }
                    let called = env.call_static_method(class, method, sig, &values);
                    match called {
                        Ok(value) if want_string => {
                            let obj = value.l()?;
                            Ok(Some(env.get_string(&JString::from(obj))?.into()))
                        }
                        Ok(_) => Ok(None),
                        Err(e) => {
                            // Java 异常会挂在 env 上；不清理会在主线程炸掉进程。
                            let _ = env.exception_clear();
                            Err(e)
                        }
                    }
                })()
                .map_err(|e| format!("{e}"));
                let _ = tx.send(res);
            });
        })
        .map_err(|e| {
            crate::error::ReinError::coded(
                "connected_app_bridge_error",
                format!("with_webview 失败：{e}"),
            )
        })?;

    rx.recv_timeout(BRIDGE_WAIT).map_err(|_| {
        crate::error::ReinError::coded("connected_app_bridge_error", "Android 桥响应超时")
    })?
    .map_err(|e| {
        crate::error::ReinError::coded(
            "connected_app_bridge_error",
            format!("Android 桥调用失败：{e}"),
        )
    })
}
