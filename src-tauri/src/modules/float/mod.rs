//! 全局沉浸浮窗域：系统级浮窗的 Rust 侧（桌面第二窗口 + Android 原生浮层桥）。
//!
//! 契约见 `docs/GLOBAL-FLOAT.md` §5/§6 与前端 `services/floatService.ts`。分工是
//! **主窗口是唯一真源**：它把正在跑的沉浸会话（专注 / 训练）压成一份快照 JSON 推过来，
//! 浮窗只消费快照、把用户按下的按钮原样发回主窗口。所以本模块**不解析业务字段** ——
//! push / latest 只搬字符串，加一种沉浸会话时 Rust 零改动。
//!
//! 平台实现一分为二，命令面完全同名同形（见 `commands.rs`，那是薄壳）：
//!
//! - **Windows**：`WebviewWindowBuilder` 建 label=`float`、URL=`float.html` 的第二窗口，
//!   push 走 `emit_to` 事件；窗口只 hide 不销毁，页面状态（滚动、本地计时）全留着。
//! - **Android**：经 `with_webview` → `PlatformWebview::jni_handle().exec` 调 Kotlin
//!   `GlobalFloatBridge`（§5.4 的方法表）。exec **没有回执通道**，所以权限 / 运行态 /
//!   动作全部走「静态缓存 + 命令返回上次快照」，前端按轮询收敛（与 `modules/tracking`
//!   同一套做法）—— 这里的每条命令都只是「扔一次 JNI + 读缓存」，不要指望同步返回值。
//!
//! 为什么 8 条命令全是同步 `fn`：Tauri 的同步命令跑在主线程，建窗 / 改尺寸 / 挪位置
//! 这些 Win32 窗口操作只有主线程安全。改成 `async` 会被丢到线程池，建窗时直接 panic。
//!
//! JNI 字符串是**运行期契约**：方法名 / 描述串写错编译期发现不了，运行期就是
//! NoSuchMethodError 崩进程。§5.4 的每一行都逐字抄在 `android_imp` 里，改 Kotlin 时
//! 两边必须一起改。**Android 分支本机没有 NDK 交叉编译环境，未经真机编译验证**。

pub mod commands;

/// 浮窗最近一次收到的载荷（JSON 文本）。桌面与 Android 共用一份：
/// 前端刻意先 `push` 再 `open`（浮窗页面载入后要先 `global_float_latest` 拿首帧），
/// 有这份缓存才不会闪一帧空态；也顺带兜住「窗口还没建时就推送」的时序。
#[cfg(any(target_os = "windows", target_os = "android"))]
static LAST_PAYLOAD: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[cfg(any(target_os = "windows", target_os = "android"))]
fn lock_str(
    m: &std::sync::Mutex<String>,
) -> std::sync::MutexGuard<'_, String> {
    // 中毒也继续用：这里只存快照字符串，没有需要回滚的不变量（与 tracking 一致）
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(any(target_os = "windows", target_os = "android"))]
pub(crate) fn store_payload(payload: String) {
    *lock_str(&LAST_PAYLOAD) = payload;
}

#[cfg(any(target_os = "windows", target_os = "android"))]
pub(crate) fn latest_payload() -> String {
    lock_str(&LAST_PAYLOAD).clone()
}

/// 浮窗窗口形状（逻辑像素尺寸见 §6.2）。
///
/// `bar` / `blob` 是两种**持久形态**（用户在标题栏里切，偏好存前端 localStorage）；
/// `confirm` 不是形态，是结束确认时窗口临时长高的一档 —— 430 宽一行放不下
/// 「结束会拿走什么」那句话与两个动作文案，所以确认期间把窗口撑到 430×172。
#[cfg(any(target_os = "windows", target_os = "android"))]
#[derive(Clone, Copy)]
pub(crate) enum FloatShape {
    Bar,
    Blob,
    Confirm,
}

#[cfg(any(target_os = "windows", target_os = "android"))]
impl FloatShape {
    /// 未知值返回 None，调用方保持现场（不放宽成「按 bar 处理」：
    /// 前端拼错形态名时，静默改尺寸比原样不动更难排查）
    pub(crate) fn parse(form: &str) -> Option<Self> {
        match form {
            "bar" => Some(Self::Bar),
            "blob" => Some(Self::Blob),
            "confirm" => Some(Self::Confirm),
            _ => None,
        }
    }

    #[cfg(target_os = "windows")]
    fn size(self) -> (f64, f64) {
        match self {
            // bar 与 430 宽应用窗口里的程序内浮条逐像素同宽；高度 = 标题栏 32 + 浮条 56 + 余量
            Self::Bar => (430.0, 92.0),
            // blob 是泊车方块：只留状态点与读数
            Self::Blob => (64.0, 64.0),
            // confirm = 两行确认文案 + 动作行，固定高度避免文字换行时窗口抖动
            Self::Confirm => (430.0, 172.0),
        }
    }

    /// 下发给 Kotlin `setForm(Context, String)` 的形态串（§5.4）
    #[cfg(target_os = "android")]
    fn as_str(self) -> &'static str {
        match self {
            Self::Bar => "bar",
            Self::Blob => "blob",
            Self::Confirm => "confirm",
        }
    }
}

/* ==========================================================================
 * Windows 桌面：第二窗口
 * ========================================================================== */

#[cfg(target_os = "windows")]
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[cfg(target_os = "windows")]
const WINDOW_LABEL: &str = "float";
#[cfg(target_os = "windows")]
const WINDOW_URL: &str = "float.html";
#[cfg(target_os = "windows")]
const STATE_EVENT: &str = "rein://float/state";
/// 初始位置：主屏工作区右下角的边距（逻辑像素，§6.2）
#[cfg(target_os = "windows")]
const CORNER_MARGIN: f64 = 24.0;

/// 当前形状。窗口可能还没建（前端先 setForm 再 open），所以形状得在 Rust 侧记着，
/// 建窗时直接按它定尺寸，避免「先按 bar 建出来、再改 blob」闪一帧。
#[cfg(target_os = "windows")]
static SHAPE: std::sync::Mutex<FloatShape> = std::sync::Mutex::new(FloatShape::Bar);

#[cfg(target_os = "windows")]
fn lock_shape() -> std::sync::MutexGuard<'static, FloatShape> {
    SHAPE.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(target_os = "windows")]
pub(crate) fn desktop_visible(webview: &tauri::Webview<tauri::Wry>) -> bool {
    webview
        .app_handle()
        .get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 显示浮窗（不存在就建）。返回 false = 建窗失败，命令层据此回 `supported: false`
/// 让前端降级为程序内浮条 —— **降级铁律**：任何一步失败都不得影响程序内浮条与计时。
#[cfg(target_os = "windows")]
pub(crate) fn desktop_open(webview: &tauri::Webview<tauri::Wry>) -> bool {
    let app = webview.app_handle();
    let window = match app.get_webview_window(WINDOW_LABEL) {
        Some(window) => window,
        None => match create_window(app) {
            Ok(window) => window,
            Err(e) => {
                eprintln!("[float] 浮窗创建失败，前端将降级为程序内浮条：{e}");
                return false;
            }
        },
    };
    // 已存在的窗口只 show（不重建）：页面里的表单、事件监听与已渲染的读数都还在
    if let Err(e) = window.show() {
        eprintln!("[float] 浮窗显示失败：{e}");
    }
    true
}

#[cfg(target_os = "windows")]
fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let (width, height) = (*lock_shape()).size();
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(WINDOW_URL.into()))
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        // 先不显示：位置算好再 show，否则会在系统默认位置闪一帧再跳到右下角
        .visible(false)
        .focused(false)
        .build()?;
    place_bottom_right(&window, width, height);
    Ok(window)
}

#[cfg(target_os = "windows")]
fn place_bottom_right(window: &WebviewWindow, width: f64, height: f64) {
    // 用主屏**工作区**（已扣掉任务栏）而不是整块屏幕：任务栏在底部时浮窗才不会压住它
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        eprintln!("[float] 读不到显示器信息，浮窗留在系统默认位置");
        return;
    };
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let physical_width = (width * scale).round() as i32;
    let physical_height = (height * scale).round() as i32;
    let margin = (CORNER_MARGIN * scale).round() as i32;
    let x = work.position.x + work.size.width as i32 - physical_width - margin;
    let y = work.position.y + work.size.height as i32 - physical_height - margin;
    if let Err(e) = window.set_position(PhysicalPosition::new(x, y)) {
        eprintln!("[float] 浮窗定位失败：{e}");
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn desktop_close(webview: &tauri::Webview<tauri::Wry>) {
    // 只 hide 不 close：浮窗页面不重载，下次 show 立刻是最后一份状态，不闪空帧
    let Some(window) = webview.app_handle().get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if let Err(e) = window.hide() {
        eprintln!("[float] 浮窗隐藏失败：{e}");
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn desktop_push(webview: &tauri::Webview<tauri::Wry>, payload: String) {
    // 先入缓存再广播：广播失败也不丢首帧（浮窗启动时读 latest）
    store_payload(payload.clone());
    let app = webview.app_handle();
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        // 窗口还没建：没有监听者，emit 必然失败。载荷已在缓存里，等浮窗首帧自己取。
        return;
    }
    // 载荷以**字符串原样**发出（不转成 Rust 结构体再序列化）：前后端共用同一份
    // JSON 契约，Rust 多解析一层只会多一个漂移点。
    if let Err(e) = app.emit_to(WINDOW_LABEL, STATE_EVENT, payload) {
        eprintln!("[float] 浮窗状态推送失败：{e}");
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn desktop_set_form(webview: &tauri::Webview<tauri::Wry>, form: &str) {
    let Some(shape) = FloatShape::parse(form) else {
        eprintln!("[float] 未知窗口形状 {form}，保持当前尺寸");
        return;
    };
    *lock_shape() = shape;
    let Some(window) = webview.app_handle().get_webview_window(WINDOW_LABEL) else {
        // 窗口还没建：形状已记下，open 建窗时按它定尺寸（前端就是先 setForm 再 open）
        return;
    };
    if let Err(e) = resize_anchored(&window, shape) {
        eprintln!("[float] 浮窗改尺寸失败：{e}");
    }
}

/// 改尺寸但保持右 / 下边钉在原处。
///
/// 右下角定位的浮窗如果只 set_size，左上角不动 → 视觉上整块往右下「长」，
/// 泊车/展开时会甩出去一截。所以按「旧尺寸 - 新尺寸」把窗口位置补回去，
/// 只让左 / 上边收缩（bar → blob 时正好往右下角收）。
#[cfg(target_os = "windows")]
fn resize_anchored(window: &WebviewWindow, shape: FloatShape) -> tauri::Result<()> {
    let (width, height) = shape.size();
    let scale = window.scale_factor()?;
    let current = window.inner_size()?;
    let target_width = (width * scale).round();
    let target_height = (height * scale).round();
    if (current.width as f64 - target_width).abs() < 1.0
        && (current.height as f64 - target_height).abs() < 1.0
    {
        return Ok(()); // 已经是目标形状：不重复 set_size，免得闪一下
    }
    let delta_x = (current.width as f64 - target_width).round() as i32;
    let delta_y = (current.height as f64 - target_height).round() as i32;
    let position = window.outer_position()?;
    window.set_size(LogicalSize::new(width, height))?;
    window.set_position(PhysicalPosition::new(
        position.x + delta_x,
        position.y + delta_y,
    ))
}

/* ==========================================================================
 * Android：JNI 桥（方法表逐字抄 docs/GLOBAL-FLOAT.md §5.4）
 * ========================================================================== */

/// true = 「在其他应用上显示」（SYSTEM_ALERT_WINDOW）已授予 —— 最近一次 snapshot 的值
#[cfg(target_os = "android")]
static PERMITTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// true = 前台服务在跑（原生浮层的生命周期跟着服务；显隐由 Kotlin 按 Activity 前台态决定）
#[cfg(target_os = "android")]
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 原生浮层按钮产生的动作 JSON（读走即清；冷启动 / 进程冻结期的点击靠它兜底）
#[cfg(target_os = "android")]
static PENDING_ACTION: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 触发一次权限 / 运行态刷新（exec 发后不管，缓存随后收敛）
#[cfg(target_os = "android")]
pub(crate) fn android_refresh(webview: &tauri::Webview<tauri::Wry>) {
    android_dispatch(webview, "snapshot", |env, activity| {
        android_imp::call_snapshot(env, activity)
    });
}

/// 读缓存快照：(permitted, running)。命令返回的是**上一次** exec 的结果，不是实时值。
#[cfg(target_os = "android")]
pub(crate) fn android_status() -> (bool, bool) {
    use std::sync::atomic::Ordering;
    (
        PERMITTED.load(Ordering::Relaxed),
        RUNNING.load(Ordering::Relaxed),
    )
}

#[cfg(target_os = "android")]
pub(crate) fn android_open(webview: &tauri::Webview<tauri::Wry>) {
    // enable 只做「有权限才起前台服务」这一半（Kotlin 侧 §5.4 的约定）：没权限时它只记日志，
    // 既不擅自拉服务、也不自动跳授权页 —— 授权入口是另一个命令 request_permission，
    // 从前端设置卡片显式触发（用户只是想开开关，不该被甩到系统设置页）。
    // 同一 exec 里补一次 snapshot：服务启动是异步的，这一枪通常还是旧值，前端轮询收敛。
    android_dispatch(webview, "open", |env, activity| {
        android_imp::call_void(env, activity, "enable")?;
        android_imp::call_snapshot(env, activity)
    });
}

#[cfg(target_os = "android")]
pub(crate) fn android_close(webview: &tauri::Webview<tauri::Wry>) {
    android_dispatch(webview, "close", |env, activity| {
        android_imp::call_void(env, activity, "disable")?;
        android_imp::call_snapshot(env, activity)
    });
}

#[cfg(target_os = "android")]
pub(crate) fn android_request_permission(webview: &tauri::Webview<tauri::Wry>) {
    // 跳系统授权页后 Activity 会 pause/resume；返回后的状态由前端的 visibilitychange 再刷
    android_dispatch(webview, "request_permission", |env, activity| {
        android_imp::call_void(env, activity, "requestPermission")?;
        android_imp::call_snapshot(env, activity)
    });
}

#[cfg(target_os = "android")]
pub(crate) fn android_push(webview: &tauri::Webview<tauri::Wry>, payload: String) {
    // 先写缓存再下发：原生浮层首帧与 latest 命令读的都是这一份
    store_payload(payload.clone());
    android_dispatch(webview, "push", move |env, activity| {
        android_imp::call_str_arg(env, activity, "update", payload)
    });
}

#[cfg(target_os = "android")]
pub(crate) fn android_set_form(webview: &tauri::Webview<tauri::Wry>, form: String) {
    let Some(shape) = FloatShape::parse(&form) else {
        eprintln!("[float] 未知窗口形状 {form}，保持当前形态");
        return;
    };
    let form = shape.as_str().to_string();
    android_dispatch(webview, "set_form", move |env, activity| {
        android_imp::call_str_arg(env, activity, "setForm", form)
    });
}

#[cfg(target_os = "android")]
pub(crate) fn android_take_action(webview: &tauri::Webview<tauri::Wry>) {
    // Kotlin 的 takeAction 是读走即清；拿到非空才覆盖缓存（空值不能盖掉还没被取走的动作）
    android_dispatch(webview, "take_action", |env, activity| {
        let action = android_imp::call_take_action(env, activity)?;
        if !action.is_empty() {
            *lock_str(&PENDING_ACTION) = action;
        }
        Ok(())
    });
}

/// 读走缓存里的原生动作（与 tracking 的 openPending 同形）
#[cfg(target_os = "android")]
pub(crate) fn take_pending_action() -> String {
    std::mem::take(&mut lock_str(&PENDING_ACTION))
}

#[cfg(target_os = "android")]
fn android_dispatch<F>(webview: &tauri::Webview<tauri::Wry>, what: &'static str, f: F)
where
    F: FnOnce(&mut jni::JNIEnv, &jni::objects::JObject<'_>) -> jni::errors::Result<()>
        + Send
        + 'static,
{
    android_imp::dispatch(webview, move |env, activity, _| {
        if let Err(e) = f(env, activity) {
            eprintln!("[float] {what} 失败：{e}");
            // JNI 抛出的 Java 异常会一直挂起；带着未处理异常返回 Java 主线程会直接
            // FATAL（方法名/签名对不上的 NoSuchMethodError 就是这么炸整个进程的）。
            // 记完日志就清掉：让「一个功能失效」和「App 崩掉」彻底分开。
            if let Err(clear_err) = env.exception_clear() {
                eprintln!("[float] 清理挂起异常失败：{clear_err}");
            }
        }
    });
}

#[cfg(target_os = "android")]
mod android_imp {
    use jni::objects::{JClass, JObject, JString, JValue};
    use jni::JNIEnv;

    /// Kotlin 侧桥类（`com.gozaoo.rein.GlobalFloatBridge`，§5.4）。下面每个方法名 /
    /// 描述串都是**运行期契约**：写错编译期无感，运行期 NoSuchMethodError 崩进程。
    const BRIDGE_CLASS: &str = "com.gozaoo.rein.GlobalFloatBridge";

    /// 在 WebView 主线程执行一段 JNI 调用。exec 是发后不管的，错误只能记日志。
    pub(super) fn dispatch<F>(webview: &tauri::Webview<tauri::Wry>, f: F)
    where
        F: FnOnce(&mut JNIEnv, &JObject, &JObject) + Send + 'static,
    {
        if let Err(e) = webview.with_webview(move |platform| platform.jni_handle().exec(f)) {
            eprintln!("[float] with_webview 失败：{e}");
        }
    }

    /// 通过 Activity.getAppClass 找应用类：Android 上裸 FindClass 可能落在系统类加载器上
    /// 找不到应用类，wry 自己也走这条路（与 modules/tracking 一致）。
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

    fn call_string(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        method: &str,
        sig: &str,
        args: &[JValue],
    ) -> jni::errors::Result<String> {
        let class = find_app_class(env, activity)?;
        let value = env.call_static_method(class, method, sig, args)?.l()?;
        if value.is_null() {
            return Ok(String::new());
        }
        Ok(env.get_string(&JString::from(value))?.into())
    }

    /// 调 `xxx(Context)` 静态方法（enable / disable / requestPermission）
    pub(super) fn call_void(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        method: &str,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        env.call_static_method(
            class,
            method,
            "(Landroid/content/Context;)V",
            &[JValue::Object(activity)],
        )?;
        Ok(())
    }

    /// 调 `xxx(Context, String)` 静态方法（update / setForm）
    pub(super) fn call_str_arg(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        method: &str,
        arg: String,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        let j_arg = env.new_string(arg)?;
        env.call_static_method(
            class,
            method,
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[JValue::Object(activity), (&j_arg).into()],
        )?;
        Ok(())
    }

    /// snapshot(Context): BooleanArray = [permitted, running]（API < 23 两位皆 false）。
    /// 把结果写回 Rust 侧静态缓存 —— exec 没有回执通道，命令只能返回上次缓存。
    pub(super) fn call_snapshot(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        let array = env
            .call_static_method(
                class,
                "snapshot",
                "(Landroid/content/Context;)[Z",
                &[JValue::Object(activity)],
            )?
            .l()?;
        let array: jni::objects::JBooleanArray = array.into();
        let mut buf = [0u8; 2]; // jboolean 即 u8
        env.get_boolean_array_region(&array, 0, &mut buf)?;
        use std::sync::atomic::Ordering;
        super::PERMITTED.store(buf[0] != 0, Ordering::Relaxed);
        super::RUNNING.store(buf[1] != 0, Ordering::Relaxed);
        Ok(())
    }

    /// takeAction(Context): String（Kotlin 侧读走即清；null → 空串）
    pub(super) fn call_take_action(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<String> {
        call_string(
            env,
            activity,
            "takeAction",
            "(Landroid/content/Context;)Ljava/lang/String;",
            &[JValue::Object(activity)],
        )
    }
}
