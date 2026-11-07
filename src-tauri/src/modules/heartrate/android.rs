//! Android 侧的 droidplug 初始化与运行时权限。
//!
//! 采集状态机不在这里：扫描 / 连接 / 重连仍由 `worker.rs` 统一处理。本模块负责
//! 两件 Android 特有的事：
//!
//! 1. **在 Java 线程上初始化 droidplug**。btleplug 的 Android 后端会按当前线程的
//!    ClassLoader 查找并注册 `com.nonpolynomial.*` / `io.github.gedgygedgy.*` 的类，
//!    Rust 自己 spawn 的线程看不到应用的类。`HeartRateBridge.nativeInit()` 由
//!    `MainActivity.onCreate` 调用，正好满足这个前提。
//! 2. **扫描 / 连接前的权限闸门**。未授权时先弹系统框，把命令暂存在 [`PENDING`]；
//!    授权回调 `nativePermissionResult(granted=true)` 再把命令投给采集线程。
//!    拒绝则把原因写进心率状态，界面照常显示，不会卡在「扫描中」。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use jni::objects::{JClass, JObject, JString, JValue};
use jni::JNIEnv;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedSender;

use super::models::ConnState;
use super::{lock_shared, now_ms, Cmd, Shared, EVENT_STATUS};

struct Ctx {
    app: AppHandle,
    shared: Arc<Mutex<Shared>>,
    tx: UnboundedSender<Cmd>,
}

/// 采集线程创建后写入；JNI 回调靠它更新状态并投递暂存命令。
static CTX: OnceLock<Ctx> = OnceLock::new();

/// 等待系统权限框作答的命令（扫描 / 连接）。同一时刻只保留最新一条。
static PENDING: Mutex<Option<Cmd>> = Mutex::new(None);

/// droidplug 初始化是否成功；worker 在拿 adapter 前检查，避免 `global_adapter()` panic。
static READY: AtomicBool = AtomicBool::new(false);

fn pending() -> MutexGuard<'static, Option<Cmd>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

/// 采集线程启动时登记上下文。
pub(super) fn install(app: AppHandle, shared: Arc<Mutex<Shared>>, tx: UnboundedSender<Cmd>) {
    let _ = CTX.set(Ctx { app, shared, tx });
}

pub(super) fn platform_ready() -> bool {
    READY.load(Ordering::Acquire)
}

/// 停扫 / 断开时丢掉还在等权限的命令，避免用户关掉抽屉后权限回来又自动开扫。
pub(super) fn clear_pending() {
    let _ = pending().take();
}

fn fail(message: String) {
    let Some(ctx) = CTX.get() else {
        eprintln!("[heartrate] {message}");
        return;
    };
    {
        let mut shared = lock_shared(&ctx.shared);
        shared.state = ConnState::Error;
        shared.error = Some(message);
    }
    let status = lock_shared(&ctx.shared).status(now_ms());
    let _ = ctx.app.emit(EVENT_STATUS, status);
}

/// 扫描 / 连接前调 Kotlin `HeartRateBridge.ensurePermissions`。
/// 已授权时 Kotlin 会在同一个 JNI 调用栈里立刻回调 `nativePermissionResult`。
pub(super) fn request_permissions(app: &AppHandle, cmd: Cmd) {
    *pending() = Some(cmd);
    let Some(window) = app.get_webview_window("main") else {
        let _ = pending().take();
        fail("找不到主窗口，无法申请蓝牙权限".into());
        return;
    };
    let posted = window.with_webview(|platform| {
        platform.jni_handle().exec(|env, activity, _webview| {
            if let Err(e) = call_ensure_permissions(env, activity) {
                eprintln!("[heartrate] 申请蓝牙权限失败：{e}");
                let _ = pending().take();
                fail("无法申请蓝牙权限，请重启应用后再试".into());
            }
        });
    });
    if let Err(e) = posted {
        let _ = pending().take();
        fail(format!("无法申请蓝牙权限：{e}"));
    }
}

fn call_ensure_permissions(
    env: &mut JNIEnv<'_>,
    activity: &JObject<'_>,
) -> jni::errors::Result<()> {
    // 与 tracking/healthsync 同一套：裸 FindClass 可能落在系统类加载器上，应用类
    // 要经 Activity.getAppClass 从应用的 ClassLoader 找。
    let name = env.new_string("com.gozaoo.rein.HeartRateBridge")?;
    let class = env
        .call_method(
            activity,
            "getAppClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )?
        .l()?;
    env.call_static_method(
        JClass::from(class),
        "ensurePermissions",
        "(Landroid/content/Context;)V",
        &[JValue::Object(activity)],
    )?;
    Ok(())
}

fn on_permission_result(granted: bool, message: Option<String>) {
    if !granted {
        let _ = pending().take();
        fail(message.unwrap_or_else(|| "需要蓝牙权限才能连接心率设备".into()));
        return;
    }

    let Some(ctx) = CTX.get() else {
        return;
    };
    let Some(cmd) = pending().take() else {
        // 用户只是补授权，没有等着的动作：清掉上一次的权限错误即可。
        let mut shared = lock_shared(&ctx.shared);
        if shared.state == ConnState::Error {
            shared.state = ConnState::Idle;
            shared.error = None;
            drop(shared);
            let status = lock_shared(&ctx.shared).status(now_ms());
            let _ = ctx.app.emit(EVENT_STATUS, status);
        }
        return;
    };
    if ctx.tx.send(cmd).is_err() {
        fail("蓝牙采集线程不可用，请重启应用后再试".into());
    }
}

/// Kotlin → Rust：在 Java 线程上初始化 droidplug（见 HeartRateBridge.register）。
#[no_mangle]
pub extern "system" fn Java_com_gozaoo_rein_HeartRateBridge_nativeInit(
    env: JNIEnv,
    _this: JObject,
) -> jni::sys::jboolean {
    // 项目其余 JNI 桥是 jni 0.21，droidplug 内部是 0.22；两边拿到的是同一根
    // JNIEnv 指针，这里只把指针借给 0.22 用一次，不交换任何对象。
    let raw = env.get_raw();
    let mut unowned = unsafe { jni22::EnvUnowned::from_raw(raw.cast()) };
    let outcome = unowned.with_env(|env22| -> Result<(), Box<dyn std::error::Error>> {
        btleplug::platform::init(env22)?;
        Ok(())
    });
    match outcome.into_outcome() {
        jni22::Outcome::Ok(()) => {
            READY.store(true, Ordering::Release);
            eprintln!("[heartrate] droidplug 初始化完成");
            1
        }
        jni22::Outcome::Err(e) => {
            eprintln!("[heartrate] droidplug 初始化失败：{e}");
            0
        }
        jni22::Outcome::Panic(_) => {
            eprintln!("[heartrate] droidplug 初始化 panic");
            0
        }
    }
}

/// Kotlin → Rust：系统权限框结果。
#[no_mangle]
pub extern "system" fn Java_com_gozaoo_rein_HeartRateBridge_nativePermissionResult(
    mut env: JNIEnv,
    _this: JObject,
    granted: jni::sys::jboolean,
    message: JString,
) {
    let msg: JObject = message.into();
    let denied = if msg.is_null() {
        None
    } else {
        env.get_string(&JString::from(msg))
            .ok()
            .map(|s| s.into())
    };
    on_permission_result(granted != 0, denied);
}
