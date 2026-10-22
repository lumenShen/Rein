package com.gozaoo.rein

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.io.File

/**
 * Rust(jni_handle.exec) ↔ Kotlin 的跑步采集桥。
 *
 * exec 是发后不管的（无返回值通道），所以状态与快照都走「查询方法 + Rust 侧缓存」：
 * snapshot()/liveJson()/trackTake()/openPending() 每次调用返回值，Rust 命令把上次读到的
 * 值缓存进静态变量，前端轮询收敛到真值。
 *
 * - enable：已持定位权限 → 直接拉起前台服务；否则发起系统授权弹窗，授权后自动补拉；
 *   弹窗期间 snapshot 的 busy=true，用户拒绝后立即回 false（前端据此降级为 web 取点）。
 * - 'specialUse'（训练课常驻通知）不需要定位权限。
 * - 通知权限（POST_NOTIFICATIONS）单独申请：它只决定通不通知，不该拖累定位授权。
 * - lastPayload：通知载荷最近一份（服务不在跑时只缓存，等 startForeground 补推）。
 * - pendingOpen：点通知进应用时落下的 'run'|'course'（MainActivity 写，这里读走即清）。
 *
 * 权限弹窗 launch 与服务的启停都必须在主线程执行（exec 本身就在 WebView 所在的主线程
 * 上回调，post 只是保险）。
 */
object TrackingBridge {
  /** 通知点击意图里的 extra 名（服务侧 put、MainActivity 侧 get） */
  const val EXTRA_OPEN = "rein_open"
  private const val TAG = "TrackingBridge"
  private const val PREFS = "rein"
  private const val KEY_OPEN = "rein_open"
  private const val PAYLOAD_MAX = 8192
  private const val TRACK_DIR = "rein-run"

  private val main = Handler(Looper.getMainLooper())
  private var permissionLauncher: ActivityResultLauncher<Array<String>>? = null
  private var notifyLauncher: ActivityResultLauncher<String>? = null

  /** true = 已发起权限弹窗且用户尚未作答 */
  private var pendingRequest = false

  /** 权限未就绪时暂存的一次 run_begin（授权回来直接用它起服务，省掉一轮降级） */
  private var pendingRun: Intent? = null
  private var pendingMode = RunTrackingService.MODE_LOCATION

  @Volatile private var lastPayloadValue: String? = null

  /** 冷启动待办：读走即清 */
  @Volatile var pendingOpen: String = ""

  fun lastPayload(): String? = lastPayloadValue

  /** MainActivity.onCreate 调用一次：注册权限申请回调（必须在 Activity 创建后注册） */
  fun register(activity: ComponentActivity) {
    permissionLauncher =
      activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        grants ->
        pendingRequest = false
        val granted =
          grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        grantedNow(activity, granted)
      }
    notifyLauncher =
      activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        // 结果只影响通知能否显示（snapshot 的 notify 位会跟上），不阻断采集
      }
  }

  @JvmStatic
  fun enable(context: Context, mode: String) {
    val app = context.applicationContext
    val m =
      if (mode == RunTrackingService.MODE_SPECIAL_USE) RunTrackingService.MODE_SPECIAL_USE
      else RunTrackingService.MODE_LOCATION
    requestNotifyPermission(app)
    if (m == RunTrackingService.MODE_SPECIAL_USE || hasFineLocationPermission(app)) {
      main.post { RunTrackingService.start(app, serviceIntent(app, m)) }
      return
    }
    pendingRequest = true
    pendingMode = m
    main.post { requestLocationPermission() }
  }

  @JvmStatic
  fun disable(context: Context) {
    pendingRequest = false
    pendingRun = null
    main.post { RunTrackingService.stop(context.applicationContext) }
  }

  /**
   * 开跑：确保授权 → 清 lastPayload（防上一次的 kind='none' 拖到新一次）→ 起服务
   * （服务在 startForeground 之后由 notify 侧补推首帧）→ 采集器按基线/阈值初始化。
   */
  @JvmStatic
  fun runBegin(
    context: Context,
    runId: String,
    enterSecPerKm: Int,
    exitSecPerKm: Int,
    baselineElapsedMs: Long,
    baselineDistanceM: Double,
  ) {
    val app = context.applicationContext
    lastPayloadValue = null
    requestNotifyPermission(app)
    val intent =
      serviceIntent(app, RunTrackingService.MODE_LOCATION)
        .putExtra(RunTrackingService.EXTRA_RUN_ID, runId)
        .putExtra(RunTrackingService.EXTRA_ENTER_SEC, enterSecPerKm)
        .putExtra(RunTrackingService.EXTRA_EXIT_SEC, exitSecPerKm)
        .putExtra(RunTrackingService.EXTRA_BASE_ELAPSED, baselineElapsedMs)
        .putExtra(RunTrackingService.EXTRA_BASE_DIST, baselineDistanceM)
    if (!hasFineLocationPermission(app)) {
      pendingRequest = true
      pendingRun = intent
      main.post { requestLocationPermission() }
      return
    }
    main.post { RunTrackingService.start(app, intent) }
  }

  @JvmStatic
  fun runPhase(context: Context, phase: String) {
    main.post { RunTrackingService.instance?.setPhase(phase) }
  }

  @JvmStatic
  fun runEnd(context: Context) {
    val app = context.applicationContext
    main.post {
      val svc = RunTrackingService.instance
      if (svc != null) svc.finishRun() else RunTrackingService.stop(app)
    }
  }

  /** live 快照（无服务 → 空串；Rust 侧用兜底常量） */
  @JvmStatic fun liveJson(): String = RunTrackingService.liveJson ?: ""

  /** 轨迹文件原文（不存在 → 空串）；服务不在跑时直接读文件（进程被杀但文件还在） */
  @JvmStatic
  fun trackTake(context: Context, runId: String): String {
    val svc = RunTrackingService.instance
    if (svc != null) return svc.trackText(runId)
    return try {
      val f = File(File(context.applicationContext.filesDir, TRACK_DIR), "$runId.jsonl")
      if (f.exists()) f.readText() else ""
    } catch (e: Exception) {
      Log.w(TAG, "读轨迹文件失败", e)
      ""
    }
  }

  /** 采集在跑？（交付轨迹后能否删文件的判据） */
  @JvmStatic fun collecting(): Boolean = RunTrackingService.collecting

  @JvmStatic
  fun dropTrack(context: Context, runId: String) {
    val svc = RunTrackingService.instance
    if (svc != null) {
      svc.dropTrack(runId)
      return
    }
    try {
      File(File(context.applicationContext.filesDir, TRACK_DIR), "$runId.jsonl").delete()
    } catch (e: Exception) {
      Log.w(TAG, "删轨迹文件失败", e)
    }
  }

  /** 通知载荷：形状先粗筛（Rust 侧已校验 JSON 对象与 8192 字节），再交服务渲染 */
  @JvmStatic
  fun updateNotification(context: Context, payload: String) {
    if (payload.isEmpty() || payload.length > PAYLOAD_MAX || !payload.trimStart().startsWith("{")) {
      Log.w(TAG, "通知载荷不合法（${payload.length} 字节），丢弃")
      return
    }
    lastPayloadValue = payload
    val svc = RunTrackingService.instance
    if (svc == null) {
      // 服务还没起来：只缓存，startForeground 时按 lastPayload 补推
      Log.i(TAG, "服务未在跑：载荷已缓存待补推")
      return
    }
    main.post { svc.renderNotification(payload) }
  }

  /** 冷启动待办（读走即清）：内存优先，其次 SharedPreferences（进程被杀后仍能落回跑步页） */
  @JvmStatic
  fun openPending(context: Context): String {
    val v = pendingOpen
    if (v.isNotEmpty()) {
      pendingOpen = ""
      return v
    }
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val stored = prefs.getString(KEY_OPEN, "") ?: ""
    if (stored.isNotEmpty()) prefs.edit().remove(KEY_OPEN).apply()
    return stored
  }

  /** [定位权限已授予, 弹窗待答, 通知权限已授予]，供 Rust 侧缓存刷新。
   *  定位位只认 FINE —— 与 Rust `location.rs` start() 同口径；COARSE-only（Android 12+
   *  弹窗里选「大致位置」）算未授权，前端据此走 web 取点降级，避免服务空转。 */
  @JvmStatic
  fun snapshot(context: Context): BooleanArray {
    val app = context.applicationContext
    return booleanArrayOf(hasFineLocationPermission(app), pendingRequest, hasNotifyPermission(app))
  }

  /* ---------- 内部 ---------- */

  private fun serviceIntent(app: Context, mode: String): Intent =
    Intent(app, RunTrackingService::class.java).putExtra(RunTrackingService.EXTRA_MODE, mode)

  /** 授权结果：有暂存的 run_begin 就按它起服务，否则只拉起保活。
   *  起服务前再验一次 FINE：弹窗回调的 granted 是 FINE||COARSE，用户选「大致位置」时
   *  不起采集服务（Rust start() 只认 FINE，起了也是零采集空转）。 */
  private fun grantedNow(activity: ComponentActivity, granted: Boolean) {
    if (!granted) {
      pendingRun = null
      return
    }
    val app = activity.applicationContext
    val pending = pendingRun
    pendingRun = null
    if (!hasFineLocationPermission(app)) return
    if (pending != null) {
      RunTrackingService.start(app, pending)
      return
    }
    RunTrackingService.start(app, serviceIntent(app, pendingMode))
  }

  private fun requestLocationPermission() {
    val launcher = permissionLauncher
    if (launcher == null) {
      // register 未执行（理论不可达）：放弃申请，前端按超时降级为 web 取点
      pendingRequest = false
      Log.w(TAG, "permissionLauncher 未注册，无法申请定位权限")
      return
    }
    launcher.launch(
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
    )
  }

  /** 通知权限独立申请：与定位授权解耦（只影响通知是否显示） */
  private fun requestNotifyPermission(context: Context) {
    if (Build.VERSION.SDK_INT < 33) return
    if (hasNotifyPermission(context.applicationContext)) return
    val launcher = notifyLauncher
    if (launcher == null) {
      Log.w(TAG, "notifyLauncher 未注册，跳过通知权限申请")
      return
    }
    launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
  }

  /** 原生采集只认 FINE：Rust `location.rs` 的 start() 检查的是 ACCESS_FINE_LOCATION，
   *  「大致位置」(COARSE-only) 在它那里会启动失败。判定必须同口径，否则会出现
   *  服务在跑、通知在、却零采集的空转状态（Android 12+ 用户可在弹窗里降级授权）。 */
  private fun hasFineLocationPermission(context: Context): Boolean =
    isGranted(context, Manifest.permission.ACCESS_FINE_LOCATION)

  /** 未授予只影响通知可见性；Android 13 以下视为已授予 */
  private fun hasNotifyPermission(context: Context): Boolean =
    Build.VERSION.SDK_INT < 33 || isGranted(context, Manifest.permission.POST_NOTIFICATIONS)

  private fun isGranted(context: Context, perm: String): Boolean =
    ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
}
