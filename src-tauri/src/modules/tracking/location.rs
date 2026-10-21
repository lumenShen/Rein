//! Android 高精度定位采集（Rust 持有 LocationManager 请求）。
//!
//! 为什么放在 Rust：
//!  · 采集策略（fused 优先、GPS 兜底、高精度质量、1s/500ms 节拍）与跑步状态机属于同一个
//!    领域，放在 Rust 才能和 K/L 口径一起演进；Kotlin 只保留 Android 必须的前台服务壳。
//!  · 熄屏/切后台由 `RunTrackingService`（location 类型前台服务 + WakeLock）保活，
//!    本模块的 LocationManager 注册在同一个进程里，因此前台、后台都能持续收点。
//!
//! JNI 边界只有两处：
//!  · Kotlin → Rust：`nativeStartLocation` / `nativeStopLocation` / `nativeRestartLocation`
//!  · Java 回调 → Rust → Kotlin：`RustLocationListener.nativeOnLocation` 收到原始 fix，
//!    转交给 `RunTrackingService.handleFixFromRust`（仍由 Kotlin 的 RunCore 记账）。
//!
//! API 31+ 使用 `LocationManager.FUSED_PROVIDER` + `LocationRequest.QUALITY_HIGH_ACCURACY`
//! （1s 间隔、500ms 最小间隔）；旧系统直接请求 GPS，GPS 关闭时退回 NETWORK。所有回调
//! 都投递到主线程，Rust 侧只做一次静态调用转发，不阻塞定位回调。

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::{jboolean, jdouble, jlong};
use jni::JNIEnv;

/// 高精度请求的参数。改这里等于改全平台的取点策略。
const UPDATE_INTERVAL_MS: jlong = 1_000;
const MIN_UPDATE_INTERVAL_MS: jlong = 500;
/// android.location.LocationRequest.QUALITY_HIGH_ACCURACY
const QUALITY_HIGH_ACCURACY: i32 = 100;

struct LocationState {
  manager: GlobalRef,
  listener: GlobalRef,
}

static STATE: Mutex<Option<LocationState>> = Mutex::new(None);
/// 最近一次回调的 Location.time（墙钟毫秒）；只用于诊断，不参与判定。
static LAST_FIX_MS: AtomicI64 = AtomicI64::new(0);

fn clear_error(env: &mut JNIEnv<'_>) {
  let _ = env.exception_clear();
}

/// 用应用自己的 ClassLoader 加载类。裸 `FindClass` 在部分线程会落到系统加载器，
/// 找不到 `com.gozaoo.rein.*`（与 TrackingBridge 的 `getAppClass` 同一理由）。
fn app_class<'a>(
  env: &mut JNIEnv<'a>,
  context: &JObject<'_>,
  name: &str,
) -> jni::errors::Result<JClass<'a>> {
  let class_name = env.new_string(name)?;
  let class = env.call_method(context, "getClass", "()Ljava/lang/Class;", &[])?.l()?;
  let loader = env
    .call_method(&class, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
    .l()?;
  let loaded = env
    .call_method(
      &loader,
      "loadClass",
      "(Ljava/lang/String;)Ljava/lang/Class;",
      &[JValue::Object(&class_name)],
    )?
    .l()?;
  Ok(loaded.into())
}

fn sdk_int(env: &mut JNIEnv<'_>) -> jni::errors::Result<i32> {
  env
    .get_static_field("android/os/Build$VERSION", "SDK_INT", "I")
    .and_then(|v| v.i())
}

fn has_fine_permission(env: &mut JNIEnv<'_>, context: &JObject<'_>) -> bool {
  let permission = match env.new_string("android.permission.ACCESS_FINE_LOCATION") {
    Ok(p) => p,
    Err(_) => return false,
  };
  match env
    .call_method(
      context,
      "checkSelfPermission",
      "(Ljava/lang/String;)I",
      &[JValue::Object(&permission)],
    )
    .and_then(|v| v.i())
  {
    Ok(value) => value == 0,
    Err(_) => {
      clear_error(env);
      false
    }
  }
}

fn location_manager<'a>(
  env: &mut JNIEnv<'a>,
  context: &JObject<'_>,
) -> jni::errors::Result<JObject<'a>> {
  let service = env.new_string("location")?;
  env
    .call_method(
      context,
      "getSystemService",
      "(Ljava/lang/String;)Ljava/lang/Object;",
      &[JValue::Object(&service)],
    )?
    .l()
}

fn provider_enabled(env: &mut JNIEnv<'_>, manager: &JObject<'_>, name: &str) -> bool {
  let provider = match env.new_string(name) {
    Ok(p) => p,
    Err(_) => return false,
  };
  match env
    .call_method(
      manager,
      "isProviderEnabled",
      "(Ljava/lang/String;)Z",
      &[JValue::Object(&provider)],
    )
    .and_then(|v| v.z())
  {
    Ok(value) => value,
    Err(_) => {
      clear_error(env);
      false
    }
  }
}

fn has_provider(env: &mut JNIEnv<'_>, manager: &JObject<'_>, name: &str) -> bool {
  let list = match env
    .call_method(manager, "getAllProviders", "()Ljava/util/List;", &[])
    .and_then(|v| v.l())
  {
    Ok(list) if !list.is_null() => list,
    _ => {
      clear_error(env);
      return false;
    }
  };
  let provider = match env.new_string(name) {
    Ok(p) => p,
    Err(_) => return false,
  };
  match env
    .call_method(
      &list,
      "contains",
      "(Ljava/lang/Object;)Z",
      &[JValue::Object(&provider)],
    )
    .and_then(|v| v.z())
  {
    Ok(value) => value,
    Err(_) => {
      clear_error(env);
      false
    }
  }
}

/// API 31+：fused + 高精度。返回值 false 表示 fused 不可用，调用方转 GPS。
fn request_fused(
  env: &mut JNIEnv<'_>,
  context: &JObject<'_>,
  manager: &JObject<'_>,
  listener: &JObject<'_>,
) -> bool {
  let builder_class = match env.find_class("android/location/LocationRequest$Builder") {
    Ok(c) => c,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  let builder = match env.new_object(
    builder_class,
    "(J)V",
    &[JValue::Long(UPDATE_INTERVAL_MS)],
  ) {
    Ok(b) => b,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  let builder = match env
    .call_method(
      &builder,
      "setQuality",
      "(I)Landroid/location/LocationRequest$Builder;",
      &[JValue::Int(QUALITY_HIGH_ACCURACY)],
    )
    .and_then(|v| v.l())
  {
    Ok(b) => b,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  let builder = match env
    .call_method(
      &builder,
      "setMinUpdateIntervalMillis",
      "(J)Landroid/location/LocationRequest$Builder;",
      &[JValue::Long(MIN_UPDATE_INTERVAL_MS)],
    )
    .and_then(|v| v.l())
  {
    Ok(b) => b,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  let request = match env
    .call_method(&builder, "build", "()Landroid/location/LocationRequest;", &[])
    .and_then(|v| v.l())
  {
    Ok(r) => r,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  // API 31+ 上 Service 一定是 Context，getMainExecutor 可用；回调落主线程，
  // Rust 侧只做一次转发，不把定位线程拖进长任务。
  let executor = match env
    .call_method(context, "getMainExecutor", "()Ljava/util/concurrent/Executor;", &[])
    .and_then(|v| v.l())
  {
    Ok(e) => e,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  let provider = match env.new_string("fused") {
    Ok(p) => p,
    Err(_) => return false,
  };
  match env.call_method(
    manager,
    "requestLocationUpdates",
    "(Ljava/lang/String;Landroid/location/LocationRequest;Ljava/util/concurrent/Executor;Landroid/location/LocationListener;)V",
    &[
      JValue::Object(&provider),
      JValue::Object(&request),
      JValue::Object(&executor),
      JValue::Object(listener),
    ],
  ) {
    Ok(_) => true,
    Err(_) => {
      clear_error(env);
      false
    }
  }
}

/// API <31：GPS 优先（高精度），GPS 关闭时退回 NETWORK。
fn request_legacy(
  env: &mut JNIEnv<'_>,
  manager: &JObject<'_>,
  listener: &JObject<'_>,
) -> bool {
  let provider_name = if provider_enabled(env, manager, "gps") {
    "gps"
  } else if provider_enabled(env, manager, "network") {
    "network"
  } else {
    return false;
  };
  let looper_class = match env.find_class("android/os/Looper") {
    Ok(c) => c,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  let looper = match env
    .call_static_method(looper_class, "getMainLooper", "()Landroid/os/Looper;", &[])
    .and_then(|v| v.l())
  {
    Ok(l) => l,
    Err(_) => {
      clear_error(env);
      return false;
    }
  };
  let provider = match env.new_string(provider_name) {
    Ok(p) => p,
    Err(_) => return false,
  };
  match env.call_method(
    manager,
    "requestLocationUpdates",
    "(Ljava/lang/String;JFLandroid/location/LocationListener;Landroid/os/Looper;)V",
    &[
      JValue::Object(&provider),
      JValue::Long(UPDATE_INTERVAL_MS),
      JValue::Float(0.0),
      JValue::Object(listener),
      JValue::Object(&looper),
    ],
  ) {
    Ok(_) => true,
    Err(_) => {
      clear_error(env);
      false
    }
  }
}

fn start(env: &mut JNIEnv<'_>, service: &JObject<'_>) -> Result<(), String> {
  // 整个注册过程持锁：start/stop 可能来自主线程（屏幕/看门狗）或收尾线程，
  // 不加锁会出现「刚注册的 listener 被另一条线程 stop 掉、Kotlin 却以为仍在采」。
  let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
  if state.is_some() {
    return Ok(());
  }
  if !has_fine_permission(env, service) {
    return Err("ACCESS_FINE_LOCATION 未授予".into());
  }
  let manager = location_manager(env, service).map_err(|e| {
    clear_error(env);
    format!("getSystemService(location) 失败：{e}")
  })?;
  if manager.is_null() {
    return Err("LocationManager 不可用".into());
  }
  let listener_class = app_class(env, service, "com.gozaoo.rein.RustLocationListener")
    .map_err(|e| {
      clear_error(env);
      format!("加载 RustLocationListener 失败：{e}")
    })?;
  let listener = env
    .new_object(listener_class, "()V", &[])
    .map_err(|e| {
      clear_error(env);
      format!("构造 RustLocationListener 失败：{e}")
    })?;

  let sdk = sdk_int(env).unwrap_or(24);
  let registered = if sdk >= 31 && has_provider(env, &manager, "fused") {
    request_fused(env, service, &manager, &listener)
  } else {
    request_legacy(env, &manager, &listener)
  };
  if !registered {
    // fused 失败时再给 GPS 一次机会（部分 ROM 注册了 fused 但不接受该重载）。
    if !request_legacy(env, &manager, &listener) {
      return Err("requestLocationUpdates 失败（fused/GPS 均不可用）".into());
    }
  }

  let manager = env.new_global_ref(&manager).map_err(|e| {
    clear_error(env);
    format!("新建 LocationManager 全局引用失败：{e}")
  })?;
  let listener = env.new_global_ref(&listener).map_err(|e| {
    clear_error(env);
    format!("新建 LocationListener 全局引用失败：{e}")
  })?;
  *state = Some(LocationState { manager, listener });
  LAST_FIX_MS.store(0, Ordering::Relaxed);
  eprintln!(
    "[tracking] Rust 定位已启动（sdk={sdk}, interval={}ms, min={}ms）",
    UPDATE_INTERVAL_MS, MIN_UPDATE_INTERVAL_MS
  );
  Ok(())
}

fn stop(env: &mut JNIEnv<'_>) -> bool {
  let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
  let Some(current) = state.take() else {
    return true;
  };
  let result = env.call_method(
    current.manager.as_obj(),
    "removeUpdates",
    "(Landroid/location/LocationListener;)V",
    &[JValue::Object(current.listener.as_obj())],
  );
  match result {
    Ok(_) => {
      eprintln!("[tracking] Rust 定位已停止");
      true
    }
    Err(e) => {
      clear_error(env);
      eprintln!("[tracking] removeUpdates 失败：{e}");
      false
    }
  }
}

/// Kotlin → Rust：启动高精度采集。返回 false 时 Kotlin 负责降级/重试。
#[no_mangle]
pub extern "system" fn Java_com_gozaoo_rein_RunTrackingService_nativeStartLocation(
  mut env: JNIEnv,
  service: JObject,
) -> jboolean {
  match start(&mut env, &service) {
    Ok(()) => 1,
    Err(e) => {
      eprintln!("[tracking] Rust 定位启动失败：{e}");
      clear_error(&mut env);
      0
    }
  }
}

/// Kotlin → Rust：停止采集。幂等。
#[no_mangle]
pub extern "system" fn Java_com_gozaoo_rein_RunTrackingService_nativeStopLocation(
  mut env: JNIEnv,
  _service: JObject,
) -> jboolean {
  if stop(&mut env) {
    1
  } else {
    0
  }
}

/// Kotlin → Rust：亮屏/继续跑时重注册（ROM 可能在熄屏时挂起 provider）。
#[no_mangle]
pub extern "system" fn Java_com_gozaoo_rein_RunTrackingService_nativeRestartLocation(
  mut env: JNIEnv,
  service: JObject,
) -> jboolean {
  let _ = stop(&mut env);
  match start(&mut env, &service) {
    Ok(()) => 1,
    Err(e) => {
      eprintln!("[tracking] Rust 定位重注册失败：{e}");
      clear_error(&mut env);
      0
    }
  }
}

/// Java 回调 → Rust → Kotlin。只做类型转发；记账仍由 RunTrackingService 的 RunCore 完成。
#[no_mangle]
pub extern "system" fn Java_com_gozaoo_rein_RustLocationListener_nativeOnLocation(
  mut env: JNIEnv,
  _listener: JObject,
  t: jlong,
  lat: jdouble,
  lon: jdouble,
  acc: jdouble,
  alt: jdouble,
  alt_acc: jdouble,
  has_acc: jboolean,
  has_alt: jboolean,
  has_alt_acc: jboolean,
  provider: JString,
) {
  LAST_FIX_MS.store(t, Ordering::Relaxed);
  let provider_obj: JObject = provider.into();
  if let Err(e) = env.call_static_method(
    "com/gozaoo/rein/RunTrackingService",
    "handleFixFromRust",
    "(JDDDDDZZZLjava/lang/String;)V",
    &[
      JValue::Long(t),
      JValue::Double(lat),
      JValue::Double(lon),
      JValue::Double(acc),
      JValue::Double(alt),
      JValue::Double(alt_acc),
      JValue::Bool(has_acc),
      JValue::Bool(has_alt),
      JValue::Bool(has_alt_acc),
      JValue::Object(&provider_obj),
    ],
  ) {
    eprintln!("[tracking] 转交 fix 给 RunTrackingService 失败：{e}");
    clear_error(&mut env);
  }
}
