package com.gozaoo.rein

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log

/**
 * Rust(jni_handle.exec) ↔ Kotlin 的 Android 系统浮层桥（契约 docs/GLOBAL-FLOAT.md §5.4）。
 *
 * exec 是**发后不管**的（没有返回值通道，见 modules/tracking 的文件头），所以状态全走
 * 「查询方法 + Rust 侧缓存」：snapshot() 每次返回值，takeAction() 读走即清；动作回传前端
 * 优先 evaluateJavascript，WebView 不在场时才靠缓存兜底。
 *
 * 三个设计取舍值得写下来：
 *  · **无权限不拉起服务**。前台服务一旦 startForeground 就留下一条常驻通知，而用户从
 *    「在其他应用上显示」页面返回时可能并没有授权。enable 这里只记日志/缓存，真正的
 *    先后顺序由前端掌握（requestPermission → 轮询 status → enable），系统设置页返回后
 *    不替用户做决定。
 *  · **动作派发成功就清缓存**。同一条动作若被 DOM 事件与 take_action 各执行一次，
 *    「结束并保留记录」这类不幂等操作会落两次；只有 Activity 已销毁（派发不出去）才把
 *    缓存留给冷启动的 take_action。契约要求「同时写缓存」，这里保留的是它的兜底语义。
 *  · **缓存所有权在桥**。服务被系统杀掉后实例为空，update 只更新缓存；服务重新 start 时
 *    在 onStartCommand 里按缓存补推首帧（与 TrackingBridge.lastPayload 同一套做法），
 *    避免「先 start 后 push」的竞态里闪一帧空浮层。
 */
object GlobalFloatBridge {
  private const val TAG = "ReinGlobalFloat"

  /** 浮层动作 intent 的 extra 名（MainActivity 侧 getStringExtra） */
  const val EXTRA_ACTION = "rein_float_action"

  /** 浮层侧的持久化（拖拽停靠位 / 形态 / 动作兜底），键名与契约里的 prefs 名一致 */
  private const val PREFS = "rein_float"
  private const val KEY_ACTION = "pending_action"

  /** 载荷上限：快照只有标题/读数/两三个按钮文案，正常不到 2KB；超限说明上游传错了东西 */
  private const val PAYLOAD_MAX = 32 * 1024

  private val main = Handler(Looper.getMainLooper())

  /** 最近一份完整载荷（服务不在跑时只缓存，服务 startForeground 后补推） */
  @Volatile private var lastPayload: String? = null

  /** 最近一次显式形态（setForm 是独立通道，先于/晚于 payload 到达都得记住） */
  @Volatile private var lastForm: String? = null

  /** 应用是否在前台（Activity resumed）：服务据此隐藏/显示浮层，二者永不并存 */
  @Volatile private var appForeground = true

  /** 动作兜底缓存：读走即清（内存优先，进程被杀后落回 SharedPreferences） */
  @Volatile private var pendingAction = ""

  /** 契约 §5.2 global_float_open：有权限才起服务，没权限只返回状态（前端走授权流程） */
  @JvmStatic
  fun enable(context: Context) {
    val app = context.applicationContext
    if (!supported()) {
      Log.w(TAG, "API < 23 没有 TYPE_APPLICATION_OVERLAY，浮层不支持")
      return
    }
    if (!canDrawOverlays(app)) {
      // 用户还没授权：不擅自拉起服务，否则会留下一条点不掉的常驻通知。
      // 前端会先 requestPermission → 用户返回后轮询 snapshot → 再 enable 到这里。
      Log.i(TAG, "无「在其他应用上显示」权限，暂不拉起浮层服务")
      return
    }
    main.post {
      try {
        GlobalFloatService.start(app)
      } catch (e: Exception) {
        // 后台启动前台服务在 Android 12+ 会被系统拒绝（ForegroundServiceStartNotAllowed）；
        // 浮层是叠加能力，起不来就降级为仅程序内浮窗，绝不让主进程崩
        Log.w(TAG, "拉起浮层服务失败（降级为程序内浮窗）", e)
      }
    }
  }

  /** 契约 §5.2 global_float_close：关开关 = 停服务 + 移除视图 + 作废缓存 */
  @JvmStatic
  fun disable(context: Context) {
    val app = context.applicationContext
    // 缓存必须一起清：否则下次 enable 时服务会先按旧载荷补推一帧过期会话（闪旧帧）
    lastPayload = null
    lastForm = null
    main.post {
      try {
        GlobalFloatService.stop(app)
      } catch (e: Exception) {
        Log.w(TAG, "停止浮层服务失败", e)
      }
    }
  }

  /**
   * 跳「在其他应用上显示」系统页。
   *
   * 不用 ActivityResultLauncher：该页是系统 Activity，返回时没有可靠的 result 回调，
   * 而「用户到底授没授权」只有 Settings.canDrawOverlays 说得准 —— 由前端在
   * visibilitychange / 轮询里重新查 snapshot 收敛，比在这里猜更可靠。
   */
  @JvmStatic
  fun requestPermission(context: Context) {
    val app = context.applicationContext
    if (!supported()) {
      Log.w(TAG, "API < 23 没有「在其他应用上显示」页面")
      return
    }
    if (canDrawOverlays(app)) return

    val uri = Uri.parse("package:${app.packageName}")
    try {
      app.startActivity(
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, uri)
          // 从 applicationContext 起 Activity 必须带 NEW_TASK
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    } catch (e: Exception) {
      // 个别 ROM 裁掉了这个页面：退到应用详情页，至少让用户能找到「显示在其他应用上层」
      Log.w(TAG, "跳转「在其他应用上显示」失败，退回应用详情页", e)
      try {
        app.startActivity(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (e2: Exception) {
        Log.w(TAG, "跳转应用详情页也失败", e2)
      }
    }
  }

  /** 契约 §5.2 global_float_push：缓存 + 转发给服务；服务不在跑就等它 start 后补推 */
  @JvmStatic
  fun update(context: Context, payload: String) {
    // 形状先粗筛（Rust 侧已校验，这里防的是 JNI 串被拼坏）：非法载荷只丢弃，不抛给 JNI
    if (payload.isEmpty() || payload.length > PAYLOAD_MAX || !payload.trimStart().startsWith("{")) {
      Log.w(TAG, "浮层载荷不合法（${payload.length} 字节），丢弃")
      return
    }
    lastPayload = payload
    main.post {
      // 实例在 post 里读而不是外面读：调用方可能在服务 onCreate 之前进来
      val svc = GlobalFloatService.instance
      if (svc == null) {
        Log.i(TAG, "浮层服务未在跑：载荷已缓存待补推")
        return@post
      }
      svc.renderPayload(payload)
    }
  }

  /** 契约 §5.2 global_float_set_form：bar / blob 两态，服务不在跑时同样先缓存 */
  @JvmStatic
  fun setForm(context: Context, form: String) {
    if (form != "bar" && form != "blob") {
      Log.w(TAG, "未知浮层形态 $form，忽略")
      return
    }
    lastForm = form
    main.post { GlobalFloatService.instance?.setForm(form) }
  }

  /**
   * Activity resumed/paused：程序内浮条在场时系统浮层必须让位（§3.1「二者永不并存」）。
   * 只转发可见性，不管服务启停 —— 服务生命周期由 enable/disable 掌握。
   */
  @JvmStatic
  fun onAppForeground(context: Context, foreground: Boolean) {
    appForeground = foreground
    main.post { GlobalFloatService.instance?.setAppForeground(foreground) }
  }

  /** [已获「在其他应用上显示」权限, 浮层服务在跑]，供 Rust 侧缓存刷新 */
  @JvmStatic
  fun snapshot(context: Context): BooleanArray {
    val app = context.applicationContext
    return booleanArrayOf(canDrawOverlays(app), GlobalFloatService.instance != null)
  }

  /** 冷启动兜底：浮层按钮产生的动作（读走即清；没派发出去的那条才会留在这里） */
  @JvmStatic
  fun takeAction(context: Context): String {
    val mem = pendingAction
    pendingAction = ""
    val stored =
      try {
        prefs(context).getString(KEY_ACTION, "") ?: ""
      } catch (e: Exception) {
        Log.w(TAG, "读动作缓存失败", e)
        ""
      }
    if (mem.isNotEmpty() || stored.isNotEmpty()) clearPendingAction(context)
    return if (mem.isNotEmpty()) mem else stored
  }

  /* ---------- 供 GlobalFloatService 使用（不在 JNI 表里，不走 exec） ---------- */

  /** 服务 onStartCommand 补推首帧用；null = 还没有任何会话 */
  fun cachedPayload(): String? = lastPayload

  /** 服务启动时的初始形态；null = 还没人指定过 */
  fun cachedForm(): String? = lastForm

  fun isAppForeground(): Boolean = appForeground

  /**
   * 浮层按钮 → 前端：先落缓存（冷启动/页面未就绪的兜底），再派发 DOM 事件。
   * 脚本**真的执行完**才清缓存（见 clearPendingActionIfCurrent）：结束 / 完成本组
   * 这类不幂等动作，绝不能被 DOM 事件与 take_action 各执行一次。
   */
  fun emitAction(context: Context, action: String) {
    if (action.isEmpty()) return
    stashAction(context, action)
    dispatch(context, action, clearAfterExec = true)
  }

  /**
   * Activity 的 intent extra 带进来的动作（系统浮层点「打开」）。
   *
   * 与 [emitAction] 的唯一差别是**执行后不清缓存**：冷启动时 WebView 可能还在加载空文档，
   * 脚本在空页上执行成功却没人听，清掉缓存就等于把动作弄丢。留给前端 init /
   * visibilitychange 的 take_action 取走才是可靠的。这条通道目前只承载 'open'，
   * 重复执行最多是再跳一次同一路由，代价远小于「冷启动点了没反应」。
   */
  fun deliverIntentAction(context: Context, action: String) {
    if (action.isEmpty()) return
    stashAction(context, action)
    dispatch(context, action, clearAfterExec = false)
  }

  private fun dispatch(context: Context, action: String, clearAfterExec: Boolean) {
    main.post {
      try {
        val act = MainActivity.current ?: return@post
        val wv = MainActivity.findWebView(act.window.decorView) ?: return@post
        // evaluateJavascript 的回调只在脚本执行完之后回来；页面不存在时它根本不会回来，
        // 调用本身也会抛 —— 两种情况缓存都留着，前端 take_action 仍能捞回（§5.3）。
        wv.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('rein-float-action',{detail:$action}))",
        ) { if (clearAfterExec) clearPendingActionIfCurrent(context, action) }
      } catch (e: Exception) {
        // 页面未就绪 / 已销毁：缓存留着，前端启动或 visibilitychange 时 take_action 取回
        Log.w(TAG, "派发浮层动作失败（留缓存兜底）", e)
      }
    }
  }

  /** 只有缓存里还是这条动作时才清：连点时不能被上一条的回调把下一条吞掉 */
  private fun clearPendingActionIfCurrent(context: Context, action: String) {
    if (pendingAction == action) clearPendingAction(context)
  }

  /** intent 已经把动作亲手送到 Activity 时清掉缓存，避免前端 take_action 再执行一遍 */
  fun clearPendingAction(context: Context) {
    pendingAction = ""
    try {
      prefs(context).edit().remove(KEY_ACTION).apply()
    } catch (e: Exception) {
      Log.w(TAG, "清空动作缓存失败", e)
    }
  }

  /* ---------- 内部 ---------- */

  private fun stashAction(context: Context, action: String) {
    pendingAction = action
    try {
      // 落盘是为了进程被杀后冷启动还能捞回（与 TrackingBridge.openPending 同一套兜底）
      prefs(context).edit().putString(KEY_ACTION, action).apply()
    } catch (e: Exception) {
      Log.w(TAG, "写动作缓存失败", e)
    }
  }

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** API < 23 没有 SYSTEM_ALERT_WINDOW 的可用实现（Settings.canDrawOverlays 也是 23 起） */
  private fun supported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M

  private fun canDrawOverlays(context: Context): Boolean =
    supported() && Settings.canDrawOverlays(context)
}