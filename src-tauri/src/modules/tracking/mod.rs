//! 跑步采集域：无数据库、无模型。Android 上经 `with_webview` →
//! `PlatformWebview::jni_handle().exec` 调 Kotlin `TrackingBridge`/`RunTrackingService`：
//! **原生前台服务是运动真源**（锁屏后 WebView 会注销 navigator.geolocation），
//! 前端只消费 live/轨迹快照。桌面端全部为空操作。
//! 定位请求本身由 `location.rs` 通过 JNI 持有（fused/GPS 高精度、1s/500ms）；
//! Kotlin 前台服务只负责保活、通知、WakeLock 与 RunCore 记账。
//! 契约见前端 `services/trackingService.ts`；K/L 的数值口径见 `model.rs`。
//!
//! exec 没有返回值通道（wry-0.57.0/src/android/mod.rs:492-501）：Kotlin 的数据经
//! exec 内的 JNI 调用写进下方静态缓存，命令返回**上次缓存**，前端按 400ms 重试收敛。

pub mod commands;
pub mod model;
/// Android 高精度定位采集（Rust 持有 LocationManager 请求；Kotlin 只保留前台服务壳）。
#[cfg(target_os = "android")]
pub mod location;

/// true = 定位权限已授予
#[cfg(target_os = "android")]
static GRANTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// true = 权限弹窗待答，或快照尚未首次同步（避免把「未同步」误判成「用户拒绝」）
#[cfg(target_os = "android")]
static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
/// true = 通知权限已授予（Android 13+ 才有意义；未授予只是通知不显示，不阻断采集）
#[cfg(target_os = "android")]
static NOTIFY_GRANTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// live 快照缓存（Kotlin 侧 live JSON；空 = 还没拉到 → 返回兜底常量）
#[cfg(target_os = "android")]
static LIVE_JSON: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
/// 轨迹分片缓存（`{"lines":n,"data":"..."}`；只被非空结果覆盖，见 commands::tracking_track_take）
#[cfg(target_os = "android")]
static TRACK_JSON: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
/// 冷启动待办（'run'|'course'）：读走即清，避免同一次点击被派发两次
#[cfg(target_os = "android")]
static OPEN_PENDING: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 无缓存 / 桌面端的兜底 live 快照（与前端 FALLBACK_LIVE、mock 返回值逐字一致）
pub const FALLBACK_LIVE_JSON: &str = r#"{"active":false,"autoPaused":false,"elapsedMs":0,"distanceM":0,"paceSecPerKm":null,"lastFixMs":0,"accM":0,"lat":0,"lon":0,"provider":"","gapSlowCount":0,"gapFastCount":0,"gapDropCount":0,"gapSlowMs":0,"gapFastMs":0,"gapDropMs":0,"gapCount":0,"gapMs":0}"#;

/// 空轨迹分片（与前端 trackTake 兜底、mock 返回值逐字一致）
pub const EMPTY_TRACK_JSON: &str = r#"{"lines":0,"data":""}"#;

#[cfg(target_os = "android")]
fn lock_str(m: &std::sync::Mutex<String>) -> std::sync::MutexGuard<'_, String> {
    // 中毒也继续用：这里只存快照字符串，没有需要回滚的不变量
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 读 live 快照缓存（Android）
#[cfg(target_os = "android")]
pub(crate) fn live_cached() -> String {
    lock_str(&LIVE_JSON).clone()
}

/// 读轨迹缓存（Android）
#[cfg(target_os = "android")]
pub(crate) fn track_cached() -> String {
    lock_str(&TRACK_JSON).clone()
}

/// 读走冷启动待办（Android）
#[cfg(target_os = "android")]
pub(crate) fn take_open_pending() -> String {
    std::mem::take(&mut lock_str(&OPEN_PENDING))
}

#[cfg(target_os = "android")]
mod android_imp {
    use jni::objects::{JClass, JObject, JString, JValue};
    use jni::JNIEnv;

    const BRIDGE_CLASS: &str = "com.gozaoo.rein.TrackingBridge";

    /// 在 WebView 主线程执行一段 JNI 调用。exec 是发后不管的，错误只能记日志。
    pub(super) fn dispatch<F>(webview: &tauri::Webview<tauri::Wry>, f: F)
    where
        F: FnOnce(&mut JNIEnv, &JObject, &JObject) + Send + 'static,
    {
        if let Err(e) = webview.with_webview(move |platform| platform.jni_handle().exec(f)) {
            eprintln!("[tracking] with_webview 失败：{e}");
        }
    }

    /// 通过 Activity.getAppClass 找应用类（Android 上裸 FindClass 可能落在
    /// 系统类加载器上找不到应用类，wry 自己也走这条路）。
    fn find_app_class<'a>(
        env: &mut JNIEnv<'a>,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<JClass<'a>> {
        let name = env.new_string(BRIDGE_CLASS)?;
        let class = env
            .call_method(
                activity,
                "getAppClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )?
            .l()?;
        Ok(class.into())
    }

    /// 调一个返回 String 的静态方法（null → 空串，方便缓存层统一判空）
    pub(super) fn call_string(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        method: &str,
        sig: &str,
        args: &[JValue],
    ) -> jni::errors::Result<String> {
        let class = find_app_class(env, activity)?;
        let v = env.call_static_method(class, method, sig, args)?.l()?;
        if v.is_null() {
            return Ok(String::new());
        }
        Ok(env.get_string(&JString::from(v))?.into())
    }

    pub(super) fn call_str_arg(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        method: &str,
        sig: &str,
        arg: &str,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        let j_arg = env.new_string(arg)?;
        env.call_static_method(class, method, sig, &[JValue::Object(activity), (&j_arg).into()])?;
        Ok(())
    }

    pub(super) fn call_enable_disable(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        enable: bool,
        mode: &str,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        // enable 吃 (Context, mode)，disable 只吃 Context —— 两者的 JNI 描述串不同，
        // 不能共用一份：写错编译期发现不了，运行期就是 NoSuchMethodError 崩进程。
        if enable {
            let j_mode = env.new_string(mode)?;
            env.call_static_method(
                class,
                "enable",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::Object(activity), (&j_mode).into()],
            )?;
        } else {
            env.call_static_method(
                class,
                "disable",
                "(Landroid/content/Context;)V",
                &[JValue::Object(activity)],
            )?;
        }
        refresh_state(env, activity)
    }

    /// run_begin：sanitize 过的 runId + 归一化阈值 + 恢复基线
    pub(super) fn call_run_begin(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        run_id: &str,
        enter_sec_per_km: i32,
        exit_sec_per_km: i32,
        baseline_elapsed_ms: i64,
        baseline_distance_m: f64,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        let j_run = env.new_string(run_id)?;
        env.call_static_method(
            class,
            "runBegin",
            "(Landroid/content/Context;Ljava/lang/String;IIJD)V",
            &[
                JValue::Object(activity),
                (&j_run).into(),
                JValue::Int(enter_sec_per_km),
                JValue::Int(exit_sec_per_km),
                JValue::Long(baseline_elapsed_ms),
                JValue::Double(baseline_distance_m),
            ],
        )?;
        Ok(())
    }

    pub(super) fn call_run_phase(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        phase: &str,
    ) -> jni::errors::Result<()> {
        call_str_arg(
            env,
            activity,
            "runPhase",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            phase,
        )
    }

    pub(super) fn call_run_end(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        env.call_static_method(
            class,
            "runEnd",
            "(Landroid/content/Context;)V",
            &[JValue::Object(activity)],
        )?;
        Ok(())
    }

    pub(super) fn call_notify(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        payload: &str,
    ) -> jni::errors::Result<()> {
        call_str_arg(
            env,
            activity,
            "updateNotification",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            payload,
        )
    }

    /// 轨迹文件原文（不存在 → 空串）
    pub(super) fn call_track_take(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        run_id: &str,
    ) -> jni::errors::Result<String> {
        let j_run = env.new_string(run_id)?;
        call_string(
            env,
            activity,
            "trackTake",
            "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(activity), (&j_run).into()],
        )
    }

    /// 冷启动待办（读走即清）
    pub(super) fn call_open_pending(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<String> {
        call_string(
            env,
            activity,
            "openPending",
            "(Landroid/content/Context;)Ljava/lang/String;",
            &[JValue::Object(activity)],
        )
    }

    /// 采集是否在跑（决定交付后能否删文件）
    pub(super) fn call_collecting(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<bool> {
        let class = find_app_class(env, activity)?;
        Ok(env.call_static_method(class, "collecting", "()Z", &[])?.z()?)
    }

    /// 交付后删除轨迹文件
    pub(super) fn call_drop_track(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        run_id: &str,
    ) -> jni::errors::Result<()> {
        call_str_arg(
            env,
            activity,
            "dropTrack",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            run_id,
        )
    }

    /// 调用 Kotlin snapshot() -> [granted, busy, notifyGranted]，刷新静态缓存
    pub(super) fn refresh_state(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        let arr = env
            .call_static_method(
                class,
                "snapshot",
                "(Landroid/content/Context;)[Z",
                &[JValue::Object(activity)],
            )?
            .l()?;
        let arr: jni::objects::JBooleanArray = arr.into();
        let mut buf = [0u8; 3]; // jboolean 即 u8
        env.get_boolean_array_region(&arr, 0, &mut buf)?;
        use std::sync::atomic::Ordering;
        super::GRANTED.store(buf[0] != 0, Ordering::Relaxed);
        super::BUSY.store(buf[1] != 0, Ordering::Relaxed);
        super::NOTIFY_GRANTED.store(buf[2] != 0, Ordering::Relaxed);
        Ok(())
    }
}

/// 统一的异步派发口：exec 内出错的只剩日志一条路
#[cfg(target_os = "android")]
fn android_dispatch<F>(webview: &tauri::Webview<tauri::Wry>, what: &'static str, f: F)
where
    F: FnOnce(&mut jni::JNIEnv, &jni::objects::JObject<'_>) -> jni::errors::Result<()> + Send + 'static,
{
    android_imp::dispatch(webview, move |env, activity, _| {
        if let Err(e) = f(env, activity) {
            eprintln!("[tracking] {what} 失败：{e}");
            // JNI 抛出的 Java 异常会一直挂起；带着未处理异常返回 Java 主线程会直接
            // FATAL（方法名/签名对不上的 NoSuchMethodError 就是这么炸整个进程的）。
            // 记完日志就清掉：让「一个功能失效」和「App 崩掉」彻底分开。
            if let Err(clear_err) = env.exception_clear() {
                eprintln!("[tracking] 清理挂起异常失败：{clear_err}");
            }
        }
    });
}

/// 拉起/停掉前台服务（顺带刷新一次状态缓存）
#[cfg(target_os = "android")]
pub(crate) fn android_keepalive(
    webview: &tauri::Webview<tauri::Wry>,
    enable: bool,
    mode: String,
) {
    android_dispatch(webview, "keepalive", move |env, activity| {
        android_imp::call_enable_disable(env, activity, enable, &mode)
    });
}

/// run_begin：初始化原生采集器（阈值已归一化，runId 已 sanitize）
#[cfg(target_os = "android")]
pub(crate) fn android_run_begin(
    webview: &tauri::Webview<tauri::Wry>,
    run_id: String,
    enter_sec_per_km: i32,
    exit_sec_per_km: i32,
    baseline_elapsed_ms: i64,
    baseline_distance_m: f64,
) {
    android_dispatch(webview, "run_begin", move |env, activity| {
        android_imp::call_run_begin(
            env,
            activity,
            &run_id,
            enter_sec_per_km,
            exit_sec_per_km,
            baseline_elapsed_ms,
            baseline_distance_m,
        )
    });
}

/// 相位同步（'running'|'paused'；取值已在命令层过滤）
#[cfg(target_os = "android")]
pub(crate) fn android_run_phase(webview: &tauri::Webview<tauri::Wry>, phase: String) {
    android_dispatch(webview, "run_phase", move |env, activity| {
        android_imp::call_run_phase(env, activity, &phase)
    });
}

/// 结束：停定位更新 + 结账自动暂停段 + 停服务（通知消失）；轨迹文件保留
#[cfg(target_os = "android")]
pub(crate) fn android_run_end(webview: &tauri::Webview<tauri::Wry>) {
    android_dispatch(webview, "run_end", |env, activity| {
        android_imp::call_run_end(env, activity)
    });
}

/// 拉取 live 快照（非空才覆盖缓存：服务已停时不要用空串盖掉上一份好数据）
#[cfg(target_os = "android")]
pub(crate) fn android_live(webview: &tauri::Webview<tauri::Wry>) {
    android_dispatch(webview, "live", |env, activity| {
        let s = android_imp::call_string(env, activity, "liveJson", "()Ljava/lang/String;", &[])?;
        if !s.is_empty() {
            *lock_str(&LIVE_JSON) = s;
        }
        Ok(())
    });
}

/// 取轨迹文件：读到非空才覆盖缓存；只有「采集未在跑 + 本次读到非空且已入缓存」才删文件
#[cfg(target_os = "android")]
pub(crate) fn android_track_take(webview: &tauri::Webview<tauri::Wry>, run_id: String) {
    android_dispatch(webview, "track_take", move |env, activity| {
        let data = android_imp::call_track_take(env, activity, &run_id)?;
        let lines = data.lines().filter(|l| !l.trim().is_empty()).count();
        if lines == 0 {
            return Ok(());
        }
        let payload = serde_json::json!({ "lines": lines, "data": data }).to_string();
        let collecting = android_imp::call_collecting(env, activity)?;
        *lock_str(&TRACK_JSON) = payload;
        if !collecting {
            // 交付后删除：下一次开跑会重新建文件，留着只会让 trackTake 取到旧轨迹
            android_imp::call_drop_track(env, activity, &run_id)?;
        }
        Ok(())
    });
}

/// 推送通知载荷（Kotlin 侧只渲染不判断）
#[cfg(target_os = "android")]
pub(crate) fn android_notify(webview: &tauri::Webview<tauri::Wry>, payload: String) {
    android_dispatch(webview, "notify", move |env, activity| {
        android_imp::call_notify(env, activity, &payload)
    });
}

/// 取冷启动待办（Kotlin 读走即清）
#[cfg(target_os = "android")]
pub(crate) fn android_open_pending(webview: &tauri::Webview<tauri::Wry>) {
    android_dispatch(webview, "open_pending", |env, activity| {
        let s = android_imp::call_open_pending(env, activity)?;
        if !s.is_empty() {
            *lock_str(&OPEN_PENDING) = s;
        }
        Ok(())
    });
}

/// 异步触发一次状态快照刷新
#[cfg(target_os = "android")]
pub(crate) fn android_refresh_status(webview: &tauri::Webview<tauri::Wry>) {
    android_dispatch(webview, "snapshot", |env, activity| {
        android_imp::refresh_state(env, activity)
    });
}

/// 读缓存快照：(granted, busy, notifyGranted)
#[cfg(target_os = "android")]
pub(crate) fn android_status() -> (bool, bool, bool) {
    use std::sync::atomic::Ordering;
    (
        GRANTED.load(Ordering::Relaxed),
        BUSY.load(Ordering::Relaxed),
        NOTIFY_GRANTED.load(Ordering::Relaxed),
    )
}
