package com.gozaoo.rein

import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt
import org.json.JSONObject

private val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
private val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

/**
 * 全局沉浸浮窗 · Android 系统浮层（契约 docs/GLOBAL-FLOAT.md §2 / §3 / §5.4）。
 *
 * 为什么必须是一个**前台服务**而不是 Activity 上的 View：浮层要在用户离开 Rein 之后继续
 * 显示（§3.1「应用不在前台」才显示），Activity 一 pause 它的窗口就不再有意义，只有
 * WindowManager 的 TYPE_APPLICATION_OVERLAY 窗口跟着进程/服务活着。前台服务同时给了
 * 「系统不随手回收」和一条可点回应用的常驻通知（进程真被回收后，用户唯一的重启入口）。
 *
 * **原生侧只渲染、不判断**（与 RunTrackingService 的通知同一套分工）：内容、按钮文案、
 * 结束确认的选项全部来自前端压好的 GlobalFloatStatePayload；这里只把 JSON 摊成视图、
 * 把点击摊成 {"action":...} 回传。有没有会话、该不该显示、形态是 bar 还是 blob，
 * 都由主窗口决定；原生不猜，也不做任何「自愈式重启」—— 没有 payload 就不建视图。
 *
 * 视图全部代码构建（不新增 layout xml）：圆角半透明底 / 10dp 状态点（work 呼吸）/
 * 13sp 标题 + 12sp 读数 / 小圆角按钮 / 内联结束确认 / 拖拽吸附 / 64dp blob 态。
 * 尺寸与配色照 tokens.css 手机档取值（亮暗两套，随 uiMode 切换），见 Palette。
 *
 * 所有可能抛的地方（addView 被拒、startForeground 被拒、updateViewLayout）都
 * try/catch + Log：浮层是叠加能力，任何失败只允许「浮层消失」，绝不允许主进程崩。
 */
class GlobalFloatService : Service() {
  companion object {
    /** logcat tag：adb logcat -s ReinGlobalFloat */
    const val TAG = "ReinGlobalFloat"

    private const val CHANNEL_ID = "rein_global_float"

    /** 与 RunTrackingService 的 41 错开：两条常驻通知不能互相覆盖 */
    private const val NOTIFICATION_ID = 42

    private const val PREFS = "rein_float"
    private const val KEY_X = "x"
    private const val KEY_Y = "y"
    private const val KEY_SIDE = "side"
    private const val KEY_FORM = "form"

    private const val ACTION_START = "com.gozaoo.rein.FLOAT_START"
    private const val ACTION_UPDATE = "com.gozaoo.rein.FLOAT_UPDATE"
    private const val ACTION_STOP = "com.gozaoo.rein.FLOAT_STOP"

    /** 条形态 430dp 上限、左右共让 24dp；照程序内浮条「430 宽窗口里 406 宽」的口径 */
    private const val BAR_MAX_DP = 430
    private const val BAR_INSET_DP = 24
    private const val BAR_HEIGHT_DP = 56
    private const val BLOB_DP = 64
    private const val DOT_DP = 10
    private const val BTN_HEIGHT_DP = 34
    private const val CLOSE_BTN_DP = 34
    private const val PAD_INLINE_DP = 12
    private const val RADIUS_DP = 20f
    private const val BTN_RADIUS_DP = 16f

    /** 状态点呼吸：与 tokens.css 的 --dur-pulse 1.6s 同节律 */
    private const val BREATH_MS = 1_600L

    /** 长按泊车：与系统长按同档 500ms（按住不动才生效，越界即让位给拖拽） */
    private const val LONG_PRESS_MS = 500L

    /** 服务实例（桥转发 update/setForm/前台态的对象；空 = 没在跑，桥只缓存） */
    @Volatile
    var instance: GlobalFloatService? = null
      private set

    fun start(context: Context) {
      ContextCompat.startForegroundService(
        context,
        Intent(context, GlobalFloatService::class.java).setAction(ACTION_START),
      )
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, GlobalFloatService::class.java))
    }
  }

  private val main = Handler(Looper.getMainLooper())

  private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

  /** 亮暗两套颜色；每次渲染重取（深色模式可能在服务存活期间切换） */
  private var palette: Palette = Palette.light()

  private var rootView: LinearLayout? = null
  private var params: WindowManager.LayoutParams? = null
  private var payload: JSONObject? = null
  private var form = "bar"
  private var confirming = false

  /** 本次「离开应用」期间用户已点过关闭：浮层保持隐藏，回前台后复位 */
  private var dismissed = false

  /** 应用在前台（Activity resumed）：前台时视图 GONE，回后台再 VISIBLE */
  private var appForeground = true

  private var foregroundStarted = false

  /** 最近一次渲染的会话语气/种类（喂状态点颜色与呼吸；与 payload 同源） */
  private var tone = "work"
  private var kind = "focus"

  private var titleView: TextView? = null
  private var statView: TextView? = null
  private var dotView: View? = null

  /** 条形态的信息区（状态点 + 标题/读数）：长按泊车的命中区，按钮不算在内 */
  private var infoView: View? = null

  /** 上次渲染的「结构指纹」：内容每秒都变，结构只在换形态 / 确认态 / 按钮集合时变 */
  private var structureKey: String? = null

  /** 已落盘的形态：心跳每秒一份载荷，不能每秒写一次 SharedPreferences */
  private var persistedForm: String? = null
  private var breath: ValueAnimator? = null
  private var clockTick: Runnable? = null

  private var touchSlop = 0
  private var dragStartX = 0f
  private var dragStartY = 0f
  private var downRawX = 0f
  private var downRawY = 0f
  private var dragging = false
  private var longPress: Runnable? = null

  /** 本次按住期间长按已经触发（用来吞掉抬手时的那次轻点） */
  private var longPressFired = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    palette = if (isNight()) Palette.dark() else Palette.light()
    touchSlop = ViewConfiguration.get(this).scaledTouchSlop
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        shutdown()
        return START_NOT_STICKY
      }
      ACTION_START, ACTION_UPDATE, null -> Unit
      else -> Log.w(TAG, "未知浮层指令，按 START 处理")
    }
    // 顺序有讲究：只要被 startForegroundService 拉起，就必须在 5s 内 startForeground，
    // 否则系统抛 RemoteServiceException。所以先起前台，再做权限 / 内容判断。
    ensureForeground()
    if (!canOverlay()) {
      // 权限在服务存活期间被用户撤销：没有任何合法途径继续显示，收掉服务与通知（不留常驻 UI）
      Log.w(TAG, "无「在其他应用上显示」权限，浮层服务退出")
      shutdown()
      return START_NOT_STICKY
    }
    appForeground = GlobalFloatBridge.isAppForeground()
    applyCached()
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // 用户从最近任务划掉应用：会话状态在 WebView 里、随应用一起死，浮层只剩过期读数。
    // 留着比消失更糟（用户会以为专注还在跑），所以直接收场。
    Log.i(TAG, "任务被划掉，收掉浮层服务")
    shutdown()
    super.onTaskRemoved(rootIntent)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // 旋转 / 深色切换：宽度与配色都得重算，否则会按旧屏宽排版、按旧主题取色
    palette = if (isNight()) Palette.dark() else Palette.light()
    // 换配色 / 换屏宽都要按新环境重排：清掉结构指纹强制重建
    structureKey = null
    payload?.optJSONObject("snapshot")?.let { bind(it) }
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    main.removeCallbacksAndMessages(null)
    detach()
    foregroundStarted = false
    super.onDestroy()
  }

  /* ---------- 外部入口（GlobalFloatBridge 在主线程调用） ---------- */

  /** 渲染一份完整载荷（update）：视图不在就先建 */
  fun renderPayload(json: String) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { renderPayload(json) }
      return
    }
    val o =
      try {
        JSONObject(json)
      } catch (e: Exception) {
        Log.w(TAG, "浮层载荷解析失败，忽略", e)
        return
      }
    val snap = o.optJSONObject("snapshot")
    if (snap == null) {
      Log.w(TAG, "浮层载荷缺 snapshot，忽略")
      return
    }
    payload = o
    // 结束确认是本地临时态：只在 end 消失时撤销。心跳每秒一份载荷，若每份都重置，
    // 用户还没来得及点，确认行就被下一帧擦掉了。
    val hasEnd = snap.optJSONObject("end")?.optJSONObject("sheet")?.optJSONArray("actions") != null
    if (!hasEnd) confirming = false
    // 形态以 payload.form 为准（主窗口是唯一真源）；没有就沿用桥里显式 setForm 的缓存
    val f = o.optString("form", "")
    if (f == "bar" || f == "blob") form = f else GlobalFloatBridge.cachedForm()?.let { form = it }
    persistFormIfChanged(form)
    if (!ensureView()) return
    bind(snap)
  }

  /** 形态切换（setForm）：尺寸与排版一起变，先量后排避免按旧宽度排一帧 */
  fun setForm(newForm: String) {
    // confirm 是桌面浮窗「长高」后的临时形态；Android 用同窗内联确认，不改变尺寸（§3.3）
    if (newForm == "confirm") return
    if (newForm != "bar" && newForm != "blob") return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { setForm(newForm) }
      return
    }
    if (form == newForm) return
    form = newForm
    persistFormIfChanged(form)
    payload?.optJSONObject("snapshot")?.let { bind(it) } ?: resize()
  }

  /** 应用前台态：前台时程序内浮条在场，系统浮层必须让位（二者永不并存） */
  fun setAppForeground(foreground: Boolean) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { setAppForeground(foreground) }
      return
    }
    appForeground = foreground
    if (foreground) {
      // 回到应用 = 本次「离开期」结束：用户点过的关闭、没做完的结束确认都复位（§3.1）
      dismissed = false
      if (confirming) {
        confirming = false
        structureKey = null
        payload?.optJSONObject("snapshot")?.let { bind(it) }
      }
    }
    updateVisibility()
  }

  /* ---------- 载荷 → 视图 ---------- */

  private fun applyCached() {
    val cachedForm = GlobalFloatBridge.cachedForm() ?: prefs.getString(KEY_FORM, null)
    if (cachedForm == "bar" || cachedForm == "blob") form = cachedForm
    val cached = GlobalFloatBridge.cachedPayload()
    if (cached != null) renderPayload(cached) else updateVisibility()
  }

  private fun updateVisibility() {
    val root = rootView ?: return
    // 没有会话（payload 空）就没有可显示的内容：视图建了也藏起来，别留一块空白浮窗
    val show = !appForeground && !dismissed && payload != null
    root.visibility = if (show) View.VISIBLE else View.GONE
    applyBreath()
  }

  private fun bind(snap: JSONObject) {
    val root = rootView ?: return
    palette = if (isNight()) Palette.dark() else Palette.light()
    kind = snap.optString("kind", "focus")
    tone = snap.optString("tone", "work")
    val key = structureKeyOf(snap)
    if (key != structureKey) {
      // 结构变了才重建。心跳每秒一份载荷，每份都 removeAllViews 会在用户按住按钮的
      // 那一帧把视图抽走（点击就此丢失），也会打断 1.6s 的呼吸节律。
      resize()
      root.removeAllViews()
      root.background = panelBackground()
      if (form == "blob") fillBlob(root, snap) else fillBar(root, snap)
      structureKey = key
    } else {
      // 只是读数 / 标题变了：就地改文本，触摸目标保持不动
      updateTexts(snap)
    }
    updateVisibility()
    startClock(snap)
  }

  /** 标题位：结束确认期显示「说明后果」那句话，其余显示相位 / 会话标题 */
  private fun titleText(snap: JSONObject): String {
    val sheet = snap.optJSONObject("end")?.optJSONObject("sheet")
    return if (confirming && sheet != null) sheet.optString("title") else snap.optString("title")
  }

  /** 内容级更新（不重建视图树） */
  private fun updateTexts(snap: JSONObject) {
    titleView?.text = titleText(snap)
    statView?.text = reading(snap)
  }

  /**
   * 结构指纹：形态 / 确认态 / 会话语气 / 按钮集合（含文案与 danger 标记）/ 是否有读数时钟。
   * 只影响文本的字段（title、stat、clock 数值）刻意不进键 —— 它们走 [updateTexts]。
   */
  private fun structureKeyOf(snap: JSONObject): String {
    val sb = StringBuilder()
    sb.append(form).append('|').append(confirming).append('|').append(kind).append('|').append(tone)
    val primary = snap.optJSONObject("primary")
    sb.append("|p=").append(primary?.optString("id")).append(':').append(primary?.optString("label"))
    val end = snap.optJSONObject("end")
    sb.append("|e=").append(end?.optString("label"))
    val actions = end?.optJSONObject("sheet")?.optJSONArray("actions")
    if (actions != null) {
      for (i in 0 until actions.length()) {
        val a = actions.optJSONObject(i) ?: continue
        sb
          .append("|a=")
          .append(a.optString("id"))
          .append(':')
          .append(a.optString("label"))
          .append(':')
          .append(a.optBoolean("danger"))
      }
    }
    sb.append("|c=").append(snap.optJSONObject("clock") != null)
    return sb.toString()
  }

  /** 条形态：状态点 + 标题/读数 + 按钮组（结束确认时按钮组整体换掉） */
  private fun fillBar(root: LinearLayout, snap: JSONObject) {
    root.orientation = LinearLayout.HORIZONTAL
    root.gravity = Gravity.CENTER_VERTICAL
    root.setPadding(dp(PAD_INLINE_DP), 0, dp(PAD_INLINE_DP), 0)
    root.contentDescription = null

    // 信息区单独成组（状态点 + 标题/读数）：既是内容主体，也是长按泊车的命中区。
    // 成组而不是逐个子 View 判定，是因为长按要排除右侧按钮——按钮自己吃事件，
    // 真正落到 root 触摸分发的只有这一块。
    val info =
      LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
      }
    val dot = makeDot()
    dotView = dot
    info.addView(dot, LinearLayout.LayoutParams(dp(DOT_DP), dp(DOT_DP)).apply { marginEnd = dp(8) })

    val texts =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_VERTICAL
      }
    val title =
      TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setTypeface(Typeface.DEFAULT, Typeface.BOLD)
        setTextColor(palette.text1)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        includeFontPadding = false
      }
    val stat =
      TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(palette.text2)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        includeFontPadding = false
      }
    texts.addView(title, LinearLayout.LayoutParams(MATCH, WRAP))
    texts.addView(stat, LinearLayout.LayoutParams(MATCH, WRAP))
    titleView = title
    statView = stat
    // 标题列吃信息区剩余宽度并允许压缩：按钮再长也不能把读数顶出浮层
    info.addView(texts, LinearLayout.LayoutParams(0, WRAP, 1f))
    infoView = info
    root.addView(info, LinearLayout.LayoutParams(0, WRAP, 1f))

    val acts =
      LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
      }
    fillActions(acts, snap)
    root.addView(acts, LinearLayout.LayoutParams(WRAP, WRAP))

    bindTexts(snap, title, stat)
  }

  /** blob 形态：64dp 方块 = 状态点 + 读数，轻点展开回条（§3.4 泊车态） */
  private fun fillBlob(root: LinearLayout, snap: JSONObject) {
    root.orientation = LinearLayout.VERTICAL
    root.gravity = Gravity.CENTER
    root.setPadding(0, 0, 0, 0)
    root.contentDescription = "展开专注浮窗"
    titleView = null
    infoView = null

    val dot = makeDot()
    dotView = dot
    root.addView(dot, LinearLayout.LayoutParams(dp(DOT_DP), dp(DOT_DP)))

    val stat =
      TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD))
        setTextColor(palette.text1)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        gravity = Gravity.CENTER
        includeFontPadding = false
      }
    statView = stat
    root.addView(
      stat,
      LinearLayout.LayoutParams(WRAP, WRAP).apply {
        topMargin = dp(6)
        marginStart = dp(4)
        marginEnd = dp(4)
      },
    )
    stat.text = reading(snap)
  }

  private fun bindTexts(snap: JSONObject, title: TextView, stat: TextView) {
    // 结束确认时标题位换成「说明后果」那句话（§3.3）：它是用户判断点哪个的唯一依据，
    // 按钮文案只说明动作本身。长文会截断，但动作与取消先保证完整可读。
    title.text = titleText(snap)
    stat.text = reading(snap)
    // 读数等宽：秒针每跳一次不该让整行抖一下（--num 的 tabular-nums 在原生侧的等价物）
    val clock = snap.optJSONObject("clock")
    if (clock != null && !clock.isNull("atEpochMs")) {
      stat.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    } else {
      stat.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
    }
  }

  private fun fillActions(acts: LinearLayout, snap: JSONObject) {
    if (confirming) {
      val actions = snap.optJSONObject("end")?.optJSONObject("sheet")?.optJSONArray("actions")
      if (actions != null) {
        // 最多两条（§3.3）：ActionSheet 的会话语义本来只给两个选项，多的放不下也不该出现
        for (i in 0 until minOf(actions.length(), 2)) {
          val a = actions.optJSONObject(i) ?: continue
          val id = a.optString("id")
          if (id.isEmpty()) continue
          val label = a.optString("label").ifEmpty { "确定" }
          acts.addView(
            makeButton(label, if (a.optBoolean("danger", false)) Style.DANGER else Style.MAIN) {
              pickEnd(id)
            },
            buttonLp(),
          )
        }
      }
      acts.addView(makeButton("取消", Style.PLAIN) { toggleConfirm(false) }, buttonLp())
      return
    }

    val primary = snap.optJSONObject("primary")
    if (primary != null) {
      val id = primary.optString("id")
      if (id.isNotEmpty()) {
        acts.addView(
          makeButton(primary.optString("label").ifEmpty { "暂停" }, Style.MAIN) {
            emit(actionJson(id))
          },
          buttonLp(),
        )
      }
    }
    val end = snap.optJSONObject("end")
    if (end != null && end.optJSONObject("sheet") != null) {
      acts.addView(
        makeButton(end.optString("label").ifEmpty { "结束" }, Style.DANGER) { toggleConfirm(true) },
        buttonLp(),
      )
    }
    acts.addView(makeButton("打开", Style.PLAIN) { openApp(actionJson("open")) }, buttonLp())
    // 关闭：后台没有别的收起入口（通知点开只是回应用）。语义由主窗口解释 —— 本次离开期
    // 不再弹，并停服务；回前台后复位，下次离开照常出现（§3.1）。
    acts.addView(
      makeButton("✕", Style.PLAIN, "关闭浮窗", compact = true) { closeFloat() },
      LinearLayout.LayoutParams(dp(CLOSE_BTN_DP), dp(BTN_HEIGHT_DP)).apply {
        marginStart = dp(8)
      },
    )
  }

  private fun toggleConfirm(open: Boolean) {
    confirming = open
    payload?.optJSONObject("snapshot")?.let { bind(it) } ?: updateVisibility()
  }

  private fun pickEnd(id: String) {
    // 先回到常态（确认行只在用户还没决定时有意义），再把结果回传；
    // 真正的状态变化由主窗口下一帧 payload 推进，这里不做乐观更新。
    confirming = false
    emit(JSONObject().put("action", "end").put("option", id).toString())
    payload?.optJSONObject("snapshot")?.let { bind(it) } ?: updateVisibility()
  }

  private fun closeFloat() {
    // 先本地隐藏：主窗口收到 close 会调 global_float_close 停服务，但那条路要经过
    // WebView → Rust，任何一环慢了都不该让浮层继续压在别的应用上。
    dismissed = true
    updateVisibility()
    emit(JSONObject().put("action", "close").toString())
  }

  /* ---------- 时钟：payload.clock 在场时自己走秒 ---------- */

  private fun reading(snap: JSONObject): String {
    val clock = snap.optJSONObject("clock") ?: return snap.optString("stat")
    if (clock.isNull("atEpochMs")) return snap.optString("stat")
    return clockText(clock)
  }

  private fun clockText(clock: JSONObject): String {
    val at = clock.optLong("atEpochMs", 0L)
    if (at <= 0L) return ""
    val base = clock.optLong("baseSec", 0L)
    val elapsed = ((System.currentTimeMillis() - at) / 1000L).coerceAtLeast(0L)
    val sec =
      if (clock.optString("direction", "down") == "up") base + elapsed else base - elapsed
    return fmtClock(sec.coerceAtLeast(0L))
  }

  private fun fmtClock(totalSec: Long): String =
    "%02d:%02d".format(Locale.US, totalSec / 60, totalSec % 60)

  private fun startClock(snap: JSONObject) {
    stopClock()
    val clock = snap.optJSONObject("clock") ?: return
    if (clock.isNull("atEpochMs")) return
    // 首帧已在 bind 里算好，这里只负责之后每秒重算一次（断流时最多停在最后一秒，不会显示错值）
    val r =
      object : Runnable {
        override fun run() {
          val cur = payload?.optJSONObject("snapshot")
          if (cur != null) statView?.text = reading(cur)
          main.postDelayed(this, 1000L)
        }
      }
    clockTick = r
    main.postDelayed(r, 1000L)
  }

  private fun stopClock() {
    clockTick?.let { main.removeCallbacks(it) }
    clockTick = null
  }

  /* ---------- 状态点 / 呼吸 ---------- */

  private fun makeDot(): View = View(this).apply { background = circle(dotColor()) }

  private fun dotColor(): Int =
    when (tone) {
      // 专注的 work 与训练的 live 在程序内是两支不同的色（--cat-work 橙 / --c-exercise 绿），
      // 而快照里只有一个 tone='work'，所以按 kind 分色才能和浮条同观感
      "work" -> if (kind == "workout") palette.live else palette.work
      "break" -> palette.breakColor
      "paused" -> palette.paused
      else -> palette.done
    }

  private fun circle(color: Int): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(color)
    }

  /**
   * 呼吸：只在可见且 work 时跑。动画器**跨视图重建复用** —— 监听器每帧读当前 dotView，
   * 否则每来一份载荷就从头开始呼吸，1.6s 的节律会被切成一秒一跳。
   * GONE 还转 ValueAnimator 是白耗电（浮层常驻，这点更明显），所以不可见时一律停。
   */
  private fun applyBreath() {
    val should = dotView != null && !appForeground && !dismissed && payload != null && tone == "work"
    if (!should) {
      stopBreath()
      return
    }
    if (breath != null) return
    val anim =
      ValueAnimator.ofFloat(1f, 0.35f).apply {
        duration = BREATH_MS
        repeatCount = ValueAnimator.INFINITE
        repeatMode = ValueAnimator.REVERSE
        addUpdateListener { dotView?.alpha = it.animatedValue as Float }
        start()
      }
    breath = anim
  }

  private fun stopBreath() {
    breath?.cancel()
    breath = null
    dotView?.alpha = 1f
  }

  /* ---------- WindowManager 窗口 ---------- */

  private fun ensureView(): Boolean {
    if (rootView != null) return true
    val p =
      WindowManager.LayoutParams().apply {
        gravity = Gravity.TOP or Gravity.START
        type = overlayType()
        // 不可拿焦点（不抢当前应用的输入焦点、不弹输入法），但触摸照收 —— 按钮要能点。
        // LAYOUT_NO_LIMITS 让坐标按整块屏幕算，拖到状态栏/导航栏附近不被裁。
        flags =
          WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        format = PixelFormat.TRANSLUCENT
        val (w, h) = sizeFor(form)
        width = w
        height = h
        x = restoreX(w)
        y = restoreY(h)
      }
    val root =
      LinearLayout(this).apply {
        setOnTouchListener { _, ev -> onTouchEvent(ev) }
        // 空白处也要吃 DOWN，否则横条中间那段手势会漏给下层应用、拖不动
        isClickable = true
        isFocusable = false
      }
    return try {
      wm().addView(root, p)
      rootView = root
      params = p
      structureKey = null
      true
    } catch (e: Exception) {
      // 权限刚被撤销 / 系统拒绝窗口：不留半截状态，直接收场
      Log.w(TAG, "添加浮层窗口失败，浮层服务退出（降级为程序内浮窗）", e)
      rootView = null
      params = null
      shutdown()
      false
    }
  }

  private fun detach() {
    cancelLongPress()
    stopClock()
    stopBreath()
    val root = rootView
    rootView = null
    params = null
    structureKey = null
    if (root != null) {
      try {
        wm().removeView(root)
      } catch (e: Exception) {
        Log.w(TAG, "移除浮层视图失败", e)
      }
    }
  }

  /** 形态变 → 尺寸变；x 按当前中心重新贴边，y 夹回屏内（旋转后旧 y 可能越界） */
  private fun resize() {
    val root = rootView ?: return
    val p = params ?: return
    val (w, h) = sizeFor(form)
    if (p.width == w && p.height == h) return
    p.width = w
    p.height = h
    p.x = snapX(p.x + w / 2, w)
    p.y = p.y.coerceIn(0, (screenH() - h).coerceAtLeast(0))
    try {
      wm().updateViewLayout(root, p)
    } catch (e: Exception) {
      Log.w(TAG, "更新浮层尺寸失败", e)
    }
  }

  private fun sizeFor(targetForm: String): Pair<Int, Int> {
    if (targetForm == "blob") return dp(BLOB_DP) to dp(BLOB_DP)
    // 430dp 是程序内浮条的设计宽；窄屏收口到屏宽 - 24dp，左右各留 12dp 呼吸
    val maxW = (screenW() - dp(BAR_INSET_DP)).coerceAtLeast(dp(200))
    return minOf(dp(BAR_MAX_DP), maxW) to dp(BAR_HEIGHT_DP)
  }

  private fun restoreX(width: Int): Int =
    when (prefs.getString(KEY_SIDE, "")) {
      "left" -> 0
      "right" -> (screenW() - width).coerceAtLeast(0)
      else -> {
        val saved = prefs.getInt(KEY_X, -1)
        if (saved >= 0) saved.coerceIn(0, (screenW() - width).coerceAtLeast(0))
        else (screenW() - width).coerceAtLeast(0)
      }
    }

  private fun restoreY(height: Int): Int {
    val saved = prefs.getInt(KEY_Y, -1)
    // 第一次出现：落在屏幕上三分之一，避开状态栏、键盘与底部导航
    val fallback = screenH() / 3
    return (if (saved >= 0) saved else fallback).coerceIn(0, (screenH() - height).coerceAtLeast(0))
  }

  private fun snapX(centerX: Int, width: Int): Int =
    if (centerX < screenW() / 2) 0 else (screenW() - width).coerceAtLeast(0)

  /* ---------- 拖拽 + 点击 ---------- */

  private fun onTouchEvent(ev: MotionEvent): Boolean {
    val root = rootView ?: return false
    val p = params ?: return false
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        dragStartX = p.x.toFloat()
        dragStartY = p.y.toFloat()
        downRawX = ev.rawX
        downRawY = ev.rawY
        dragging = false
        longPressFired = false
        // 长按泊车只认「从信息区起手、且按住不动」：按钮自己吃事件，能走到这里的
        // 一定不是按钮；命中测试再把条上其余空白排除掉。
        if (form == "bar" && isInsideInfo(ev.rawX, ev.rawY)) startLongPress()
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = ev.rawX - downRawX
        val dy = ev.rawY - downRawY
        if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
          // 一动就让位给拖拽：长按只在按住不动时成立，两者不互相抢
          dragging = true
          cancelLongPress()
        }
        if (dragging) {
          p.x = (dragStartX + dx).toInt().coerceIn(0, (screenW() - p.width).coerceAtLeast(0))
          p.y = (dragStartY + dy).toInt().coerceIn(0, (screenH() - p.height).coerceAtLeast(0))
          try {
            wm().updateViewLayout(root, p)
          } catch (e: Exception) {
            Log.w(TAG, "拖动浮层失败", e)
          }
        }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        cancelLongPress()
        // 长按已经触发过的那次抬手不算轻点，否则泊车后会被同一次抬手立刻展开回去
        val tapped = !dragging && !longPressFired
        val wasDragging = dragging
        dragging = false
        longPressFired = false
        if (ev.actionMasked == MotionEvent.ACTION_UP) {
          if (wasDragging) settle() else if (tapped) onTap()
        }
        return true
      }
    }
    return false
  }

  /** 抬手吸附：中心跨过屏幕三分之一才换边，否则回弹到最近边（避免手一抖就左右横跳） */
  private fun settle() {
    val root = rootView ?: return
    val p = params ?: return
    val side =
      when {
        p.x + p.width / 2 < screenW() / 3 -> "left"
        p.x + p.width / 2 > screenW() * 2 / 3 -> "right"
        // 中间三分之一：留在原来那一侧（没有记录时按最近边算）
        else -> if (p.x + p.width / 2 < screenW() / 2) "left" else "right"
      }
    p.x = if (side == "left") 0 else (screenW() - p.width).coerceAtLeast(0)
    p.y = p.y.coerceIn(0, (screenH() - p.height).coerceAtLeast(0))
    prefs.edit().putString(KEY_SIDE, side).putInt(KEY_X, p.x).putInt(KEY_Y, p.y).apply()
    try {
      wm().updateViewLayout(root, p)
    } catch (e: Exception) {
      Log.w(TAG, "吸附落位失败", e)
    }
  }

  private fun onTap() {
    // 只有 blob 态有「轻点」语义：展开回条。形态归主窗口所有，展开要回传 form，
    // 否则下一次 push 会按旧形态（blob）又把它收回去。
    if (form != "blob") return
    form = "bar"
    persistFormIfChanged(form)
    payload?.optJSONObject("snapshot")?.let { bind(it) } ?: updateVisibility()
    emit(JSONObject().put("action", "form").put("form", "bar").toString())
  }

  /**
   * 长按 500ms 泊车成 64dp 方块（与桌面标题栏的「泊车为方块」同一语义）。
   * 起手必须在信息区，中途越过 touch slop 会被 MOVE 取消（拖拽优先）。
   */
  private fun startLongPress() {
    cancelLongPress()
    val r =
      object : Runnable {
        override fun run() {
          longPress = null
          if (dragging || form != "bar") return
          longPressFired = true
          // 隐式手势没有可见提示：必须给触感确认，否则用户不知道「松手会变方块」
          rootView?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
          park()
        }
      }
    longPress = r
    main.postDelayed(r, LONG_PRESS_MS)
  }

  private fun cancelLongPress() {
    longPress?.let { main.removeCallbacks(it) }
    longPress = null
  }

  /** 泊车：本地先切 blob 并落持久化，再回传 form 让主窗口的持久形态与本机对齐 */
  private fun park() {
    if (form != "bar") return
    form = "blob"
    persistFormIfChanged(form)
    payload?.optJSONObject("snapshot")?.let { bind(it) } ?: resize()
    emit(JSONObject().put("action", "form").put("form", "blob").toString())
  }

  /** 长按命中区 = 信息组在屏幕上的矩形（rawX/rawY 是屏幕坐标） */
  private fun isInsideInfo(rawX: Float, rawY: Float): Boolean {
    val info = infoView ?: return false
    if (info.width <= 0 || info.height <= 0) return false
    val loc = IntArray(2)
    info.getLocationOnScreen(loc)
    return rawX >= loc[0] &&
      rawX <= loc[0] + info.width &&
      rawY >= loc[1] &&
      rawY <= loc[1] + info.height
  }

  /* ---------- 控件构造 ---------- */

  private fun makeButton(
    label: String,
    style: Int,
    description: String = label,
    compact: Boolean = false,
    onClick: () -> Unit,
  ): TextView =
    TextView(this).apply {
      text = label
      setTextSize(TypedValue.COMPLEX_UNIT_SP, if (compact) 14f else 12f)
      setTypeface(Typeface.DEFAULT, Typeface.BOLD)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      // 两枚确认按钮 + 取消写在 406dp 里，长文案必须允许截断，否则会把读数挤没
      if (!compact) maxWidth = dp(120)
      gravity = Gravity.CENTER
      includeFontPadding = false
      val pad = if (compact) 0 else dp(PAD_INLINE_DP)
      setPadding(pad, 0, pad, 0)
      background = buttonBackground(style)
      setTextColor(
        when (style) {
          Style.MAIN -> palette.bg // 实底反色：底用 text-1，字用画布色（与浮条 .abtn.main 同源）
          Style.DANGER -> palette.dangerStrong
          else -> palette.text1
        },
      )
      isClickable = true
      isFocusable = true
      contentDescription = description
      setOnClickListener { onClick() }
    }

  private fun buttonBackground(style: Int): Drawable {
    val fill =
      when (style) {
        Style.MAIN -> palette.text1
        Style.DANGER -> palette.dangerSoft
        else -> palette.surface2
      }
    val shape =
      GradientDrawable().apply {
        cornerRadius = dpF(BTN_RADIUS_DP)
        setColor(fill)
      }
    return RippleDrawable(ColorStateList.valueOf(palette.ripple), shape, null)
  }

  private fun buttonLp() =
    LinearLayout.LayoutParams(WRAP, dp(BTN_HEIGHT_DP)).apply { marginStart = dp(8) }

  private fun panelBackground(): Drawable =
    GradientDrawable().apply {
      // 底下是谁的界面不可知：半透明底必须自带足够的实色，否则白字/黑字会随背景乱跳
      setColor(palette.panel)
      cornerRadius = dpF(RADIUS_DP)
      setStroke(dp(1).coerceAtLeast(1), palette.stroke)
    }

  /* ---------- 前台通知 ---------- */

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel =
      NotificationChannel(CHANNEL_ID, "全局浮窗", NotificationManager.IMPORTANCE_LOW).apply {
        // 低优先级：浮层本身已经占着屏幕，通知不该再响/震/亮（与 RunTrackingService 同档）
        description = "专注 / 训练的浮层控制"
        setShowBadge(false)
        enableVibration(false)
      }
    nm.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val open =
      PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java)
          .setAction(Intent.ACTION_MAIN)
          .addCategory(Intent.CATEGORY_LAUNCHER)
          .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_recent_history)
      .setContentTitle("专注浮窗")
      .setContentText("浮窗运行中 · 回到 Rein")
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
  }

  private fun ensureForeground() {
    if (foregroundStarted) return
    try {
      // Android 14+ 的 specialUse 型必须在 manifest 声明用途子类（见 AndroidManifest 的 <property>），
      // 类型传 0 只会退化成「无类型」，在 Android 14 上反而被拒。
      val type =
        if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
      ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
      foregroundStarted = true
    } catch (e: Exception) {
      // 通知被禁 / 后台启动被拦 / 类型不匹配：没有前台服务就没有常驻浮层的资格，收场
      Log.w(TAG, "startForeground 被拒，浮层服务退出（降级为程序内浮窗）", e)
      shutdown()
    }
  }

  /** 收场：先撤窗口与通知，再停服务（顺序反了会留一帧通知或一帧视图） */
  private fun shutdown() {
    detach()
    foregroundStarted = false
    try {
      stopForeground(Service.STOP_FOREGROUND_REMOVE)
    } catch (e: Exception) {
      Log.w(TAG, "取消前台状态失败", e)
    }
    try {
      getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    } catch (e: Exception) {
      Log.w(TAG, "取消浮层通知失败", e)
    }
    stopSelf()
  }

  /* ---------- 动作回传 ---------- */

  private fun emit(json: String) {
    GlobalFloatBridge.emitAction(this, json)
  }

  private fun actionJson(name: String): String = JSONObject().put("action", name).toString()

  /** 「打开」：带动作 extra 拉起 MainActivity，由它复用现有 evaluateJavascript 通道派发 */
  private fun openApp(action: String) {
    try {
      startActivity(
        Intent(this, MainActivity::class.java)
          .setAction(Intent.ACTION_MAIN)
          .addCategory(Intent.CATEGORY_LAUNCHER)
          .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
          .putExtra(GlobalFloatBridge.EXTRA_ACTION, action),
      )
    } catch (e: Exception) {
      Log.w(TAG, "打开主界面失败", e)
    }
  }

  /* ---------- 环境 ---------- */

  private fun wm(): WindowManager = getSystemService(WindowManager::class.java)

  private fun screenW(): Int = resources.displayMetrics.widthPixels

  private fun screenH(): Int = resources.displayMetrics.heightPixels

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

  private fun dpF(value: Float): Float = value * resources.displayMetrics.density

  private fun isNight(): Boolean =
    (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES

  /** 形态只在真正变化时落盘：心跳每秒一份载荷，不能每秒写一次 SharedPreferences */
  private fun persistFormIfChanged(target: String) {
    if (persistedForm == target) return
    persistedForm = target
    try {
      prefs.edit().putString(KEY_FORM, target).apply()
    } catch (e: Exception) {
      Log.w(TAG, "持久化浮层形态失败", e)
    }
  }

  /** minSdk 24：TYPE_APPLICATION_OVERLAY 是 API 26 起的，老系统退回 TYPE_PHONE（同样要悬浮窗权限） */
  @Suppress("DEPRECATION")
  private fun overlayType(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      WindowManager.LayoutParams.TYPE_PHONE
    }

  private fun canOverlay(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Settings.canDrawOverlays(this)

  /**
   * 浮层配色 —— tokens.css 手机档取值的镜像（亮 / 暗两套，随 uiMode 切换）。
   * 原生侧读不到 CSS 变量，改令牌时这里要一起改；否则系统浮层会和程序内浮条
   * 在同一个屏幕上显示成两种材质。
   */
  private class Palette(
    val panel: Int,
    val stroke: Int,
    val text1: Int,
    val text2: Int,
    val bg: Int,
    val surface2: Int,
    val dangerSoft: Int,
    val dangerStrong: Int,
    val work: Int,
    val breakColor: Int,
    val paused: Int,
    val done: Int,
    val live: Int,
    val ripple: Int,
  ) {
    companion object {
      fun light() =
        Palette(
          panel = Color.argb(0xF0, 255, 255, 255), // 半透明白玻璃（--surface + 透出背景）
          stroke = Color.argb(0x12, 0, 0, 0), // --line
          text1 = 0xFF1D1D1F.toInt(),
          text2 = 0xFF6E6E73.toInt(),
          bg = 0xFFF5F5F7.toInt(), // --bg
          surface2 = 0xFFF2F2F4.toInt(),
          dangerSoft = Color.argb(0x1F, 255, 59, 48), // --danger-soft 12%
          dangerStrong = 0xFFC1271D.toInt(),
          work = 0xFFFF9500.toInt(), // --cat-work = --warn
          breakColor = 0xFF8E8E93.toInt(), // --cat-general
          paused = 0xFFFF9500.toInt(), // --warn
          done = 0xFF86868B.toInt(), // --text-3 中性
          live = 0xFF92E82A.toInt(), // --c-exercise
          ripple = Color.argb(0x1A, 0, 0, 0),
        )

      fun dark() =
        Palette(
          panel = Color.argb(0xF0, 28, 28, 30), // --surface #1c1c1e
          stroke = Color.argb(0x14, 255, 255, 255), // --line
          text1 = 0xFFF5F5F7.toInt(),
          text2 = Color.argb(0x99, 235, 235, 245),
          bg = 0xFF000000.toInt(),
          surface2 = 0xFF2C2C2E.toInt(),
          dangerSoft = Color.argb(0x2E, 255, 105, 97),
          dangerStrong = 0xFFFF6961.toInt(),
          work = 0xFFFF9500.toInt(),
          breakColor = 0xFF8E8E93.toInt(),
          paused = 0xFFFF9500.toInt(),
          done = Color.argb(0x73, 235, 235, 245),
          live = 0xFFA4F04B.toInt(), // 暗色提亮一档
          ripple = Color.argb(0x24, 255, 255, 255),
        )
    }
  }

  /** 按钮视觉档：主操作实底反色 / 结束 danger-soft / 次级中性（对应浮条 .abtn.main/.end/.ico） */
  private object Style {
    const val MAIN = 0
    const val DANGER = 1
    const val PLAIN = 2
  }
}