package com.gozaoo.rein

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * 心率手环 BLE 的 Android 入口，只做两件事：
 *
 * 1. **初始化 droidplug**：btleplug 的 Android Java 后端用 JNI 注册回调、
 *    按 Context ClassLoader 查找自己的类，所以必须在「从 Java 进来的线程」上
 *    init（MainActivity.onCreate），不能放到 Rust 自发创建的采集线程里。
 * 2. **运行时权限**：Android 12+ 要 BLUETOOTH_SCAN / BLUETOOTH_CONNECT，
 *    11 及以下扫描要定位权限。扫描/连接由 Rust(btleplug) 负责，这里不碰 BLE 状态机。
 *
 * 权限结果通过 nativePermissionResult 回传：granted=true 时 Rust 才把暂存的
 * scan/connect 投给采集线程；拒绝则把原因写进心率状态，界面照常显示。
 */
object HeartRateBridge {
  private const val TAG = "HeartRateBridge"

  private var launcher: ActivityResultLauncher<Array<String>>? = null

  /** 权限弹窗未作答时不再重复 launch（系统会直接拒绝第二次请求） */
  @Volatile private var pending = false

  init {
    System.loadLibrary("rein_lib")
  }

  private external fun nativeInit(): Boolean

  private external fun nativePermissionResult(granted: Boolean, message: String?)

  /** MainActivity.onCreate 调一次；launcher 必须在 Activity 创建后注册。 */
  fun register(activity: ComponentActivity) {
    launcher =
      activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        grants ->
        pending = false
        val granted =
          requiredPermissions().all {
            grants[it] == true || hasPermission(activity, it)
          } && bluetoothEnabled(activity)
        nativePermissionResult(
          granted,
          if (granted) null else denialMessage(activity),
        )
      }

    // 必须在 Java 线程上初始化：droidplug 的 init 会按当前线程的 ClassLoader
    // 查找/注册 com.nonpolynomial.* 与 io.github.gedgygedgy.* 的类。
    val ok =
      try {
        nativeInit()
      } catch (e: Throwable) {
        Log.e(TAG, "nativeInit 失败", e)
        false
      }
    Log.i(TAG, "droidplug init: $ok")
  }

  /** Rust 在扫描/连接前调用；已授权会同步回调，未授权则弹系统权限框。 */
  @JvmStatic
  fun ensurePermissions(context: Context) {
    if (hasAll(context) && bluetoothEnabled(context)) {
      nativePermissionResult(true, null)
      return
    }
    if (hasAll(context) && !bluetoothEnabled(context)) {
      nativePermissionResult(false, "手机蓝牙未打开，请先在系统设置里开启蓝牙")
      return
    }
    if (pending) return
    val activity = MainActivity.current
    val l = launcher
    if (activity == null || l == null) {
      nativePermissionResult(false, "无法申请蓝牙权限，请重启应用后再试")
      return
    }
    pending = true
    activity.runOnUiThread { l.launch(requiredPermissions()) }
  }

  private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun hasAll(context: Context): Boolean =
    requiredPermissions().all { hasPermission(context, it) }

  private fun hasPermission(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun bluetoothEnabled(context: Context): Boolean {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return manager?.adapter?.isEnabled == true
  }

  private fun denialMessage(context: Context): String =
    if (hasAll(context)) "手机蓝牙未打开，请先在系统设置里开启蓝牙"
    else "需要蓝牙权限才能连接心率设备，请在系统设置里允许后重试"
}
