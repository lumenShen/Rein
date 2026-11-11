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
import android.os.SystemClock
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Choreographer
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt
import org.json.JSONObject

private val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
private val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

/** 四槽位停靠：顶/底 = 全宽条，左/右 = 64dp 方块（与程序内浮条完全同义） */
private enum class Slot {
  TOP,
  BOTTOM,
  LEFT,
  RIGHT,
}

private fun Slot.prefName(): String = name.lowercase(Locale.US)

private fun parseSlot(raw: String?): Slot? =
  when (raw) {
    "top" -> Slot.TOP
    "bottom" -> Slot.BOTTOM
    "left" -> Slot.LEFT
    "right" -> Slot.RIGHT
    else -> null
  }

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
    // 四槽位停靠（与程序内浮条 rein.wbar.dock.v1 / 桌面浮窗 rein.float.dock.v1 同构）
    private const val KEY_SLOT = "slot"
    private const val KEY_BAR_SLOT = "bar_slot"
    private const val KEY_SIDE_Y = "side_y"

    private const val ACTION_START = "com.gozaoo.rein.FLOAT_START"
    private const val ACTION_UPDATE = "com.gozaoo.rein.FLOAT_UPDATE"
    private const val ACTION_STOP = "com.gozaoo.rein.FLOAT_STOP"

    /**
     * 条形态宽度 = min(屏宽 - 24dp, 456dp)。
     *
     * 456 = tokens.css 的 --frame-max(480) - 24，与程序内浮条 `.dock-body.is-bar`
     * 的 `min(100vw - 24, --frame-max - 24)` 逐字同源 —— 两端在同一台手机上必须一样宽。
     * 高度 52 = 内容 34(按钮) + 上下内距 8×2 + 1px 描边，同样照程序内浮条量出来的值。
     */
    private const val BAR_MAX_DP = 456
    private const val BAR_INSET_DP = 24
    private const val BAR_HEIGHT_DP = 52
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

    /* ---------- 手势参数：与 composables/useDragDock 同一组常量（改一处两处一起看） ---------- */
    /** 点按 / 拖拽判定位移；按钮点击永远达不到 */
    private const val SLOP_DP = 8
    /** 轻弹阈值 ≈350dp/s（换算成 px/ms 时乘 density） */
    private const val FLICK_DP_MS = 0.35f
    /** 慢速释放投影：偏移 = v(px/ms) × 180ms */
    private const val PROJECTION_MS = 180f
    /** 速度采样窗口 */
    private const val VELOCITY_WINDOW_MS = 100L
    /** 橡皮筋刚度，越小越软 */
    private const val RUBBER_C = 0.55f
    /** 顶 / 底 / 侧边停靠距安全区的呼吸边距 */
    private const val EDGE_GAP_DP = 12
    /** settle 弹簧（半隐式欧拉）：ζ≈0.87、ωn≈12.6rad/s ≈ Apple 式 0.48s/bounce0.16 */
    private const val SPRING_STIFFNESS = 160f
    private const val SPRING_DAMPING = 22f

    /** 本地换了形态后，主窗口载荷回声到达前不被旧 payload 回滚（与桌面 FloatApp 的乐观渲染同义） */
    private const val FORM_PIN_MS = 1_200L

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

  private var rootView: DockRoot? = null
  private var params: WindowManager.LayoutParams? = null
  private var payload: JSONObject? = null

  /* ---------- 停靠：与程序内浮条 / 桌面浮窗同一套四槽位模型 ---------- */
  /** 当前槽位（顶/底 = 全宽条，左/右 = 方块）；形态由它派生，不再独立漂移 */
  private var slot: Slot = Slot.BOTTOM
  /** 方块轻点展开回上一次的全宽条槽位 */
  private var barSlot: Slot = Slot.BOTTOM
  /** 侧边停靠时方块中心在可用纵向区间里的比例 0..1 */
  private var sideY = 0.7f
  /** 当前形态：由槽位决定（顶/底=bar，左/右=blob），外部 setForm 会落到对应槽位 */
  private var form = "bar"
  private var confirming = false

  /** 本地换形态后，载荷回声到达前不被旧 payload 回滚（乐观渲染窗口） */
  private var formPinnedUntil = 0L

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

  /* ---------- 拖拽手势状态（坐标一律屏幕 px，与 WindowManager.LayoutParams.x/y 同口径） ---------- */
  private var dragStartX = 0
  private var dragStartY = 0
  private var downRawX = 0f
  private var downRawY = 0f
  /** 本次按下的起点在信息区里（长按泊车 / 轻点「打开」都只看这一条） */
  private var downInInfo = false
  private var dragging = false
  private var longPress: Runnable? = null

  /** 本次按住期间长按已经触发（用来吞掉抬手时的那次轻点） */
  private var longPressFired = false

  /** 速度采样（t 为 uptime ms，x/y 为屏幕坐标）：轻弹阈值与投影都靠它 */
  private val samples = ArrayList<FloatArray>()

  /* ---------- 弹簧落位（可打断；与 useDragDock 同一套半隐式欧拉） ---------- */
  private val choreographer by lazy { Choreographer.getInstance() }
  private var springRunning = false
  private var springVx = 0f
  private var springVy = 0f
  /** 浮点位置：WindowManager 只吃整数，但弹簧必须在小数域里积分，否则永远收敛不到 <0.5px */
  private var springX = 0f
  private var springY = 0f
  private var springTargetX = 0f
  private var springTargetY = 0f
  private var lastFrameNs = 0L

  /** 安全区 / 屏幕尺寸缓存（旋转、系统栏显隐、导航模式切换都会让它失效） */
  private var cachedInsets: IntArray? = null
  private var cachedScreen: Pair<Int, Int>? = null
  /** 上一次的可见性：隐藏期间系统栏可能变了（三键导航 / 全屏手势 / 分屏），显示时要重算 */
  private var wasVisible = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    palette = if (isNight()) Palette.dark() else Palette.light()
    loadDock()
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
    cachedInsets = null
    cachedScreen = null
    // 换配色 / 换屏宽都要按新环境重排：清掉结构指纹强制重建
    structureKey = null
    payload?.optJSONObject("snapshot")?.let { bind(it) }
    // 停靠位置按新屏幕重算（槽位相对安全区表达，与程序内浮条同一条规则）。
    // 拖拽 / 弹簧飞行中不抢：用户的手还在屏幕上。
    if (!dragging && !springRunning) {
      val (w, h) = sizeFor(form)
      val (x, y) = slotPos(slot, w, h)
      writePos(x.toFloat(), y.toFloat())
    }
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
    // 形态以槽位为唯一真源（顶/底=bar、左/右=blob）。payload.form 只在
    // 「本地刚拖完、回声还没到」的乐观窗口之外生效，否则每秒一份心跳载荷会把
    // 用户刚泊好的方块按旧形态弹回横条。
    val f = o.optString("form", "")
    if (SystemClock.uptimeMillis() >= formPinnedUntil) {
      if (f == "bar" || f == "blob") {
        if (f != form) setForm(f)
      } else {
        GlobalFloatBridge.cachedForm()?.let { if (it != form) setForm(it) }
      }
    }
    persistFormIfChanged(form)
    if (!ensureView()) return
    bind(snap)
  }

  /**
   * 形态切换（setForm，主窗口 / 桥调用）：落到对应槽位并走同一套弹簧落位。
   *
   * Android 用同窗内联确认，`confirm` 不改变尺寸（§3.3）。形态与槽位是一体的：
   * bar → 上一次的顶/底槽位，blob → 当前/右侧槽位 —— 不能再出现「form=blob 但
   * 窗口还在屏幕中间」这种半截状态。
   */
  fun setForm(newForm: String) {
    if (newForm == "confirm") return
    if (newForm != "bar" && newForm != "blob") return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { setForm(newForm) }
      return
    }
    if (form == newForm) return
    val target =
      if (newForm == "blob") {
        if (slot == Slot.LEFT || slot == Slot.RIGHT) slot else Slot.RIGHT
      } else {
        barSlot
      }
    dockTo(target, 0f, 0f, emitForm = false)
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
    if ((cachedForm == "bar" || cachedForm == "blob") && cachedForm != form) setForm(cachedForm)
    val cached = GlobalFloatBridge.cachedPayload()
    if (cached != null) renderPayload(cached) else updateVisibility()
  }

  private fun updateVisibility() {
    val root = rootView ?: return
    // 没有会话（payload 空）就没有可显示的内容：视图建了也藏起来，别留一块空白浮窗
    val show = !appForeground && !dismissed && payload != null
    root.visibility = if (show) View.VISIBLE else View.GONE
    // 隐藏期间系统栏可能变过（切导航模式 / 全屏手势），GONE 收不到 inset 回调：
    // 每次从藏到显都作废几何缓存并按当前槽位重算，避免带着旧安全区踏出屏幕。
    if (show && !wasVisible) {
      main.post { refreshDockGeometry() }
    }
    wasVisible = show
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
    val (w, h) = sizeFor(form)
    val (x, y) = slotPos(slot, w, h)
    val p =
      WindowManager.LayoutParams().apply {
        gravity = Gravity.TOP or Gravity.START
        type = overlayType()
        // 不可拿焦点（不抢当前应用的输入焦点、不弹输入法），但触摸照收 —— 按钮要能点。
        // LAYOUT_IN_SCREEN：坐标以**整块屏幕**左上角为原点（不设它时 y=0 是状态栏下沿，
        //   slotPos 按屏幕尺寸算出来的槽位会整体下移一个状态栏高度，底部槽位直接被裁出屏外）。
        // LAYOUT_NO_LIMITS 允许窗口越过常规边界（橡皮筋拖到边缘时不被提前裁切）。
        flags =
          WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        format = PixelFormat.TRANSLUCENT
        width = w
        height = h
        this.x = x
        this.y = y
      }
    // DockRoot 自己接管触摸（onInterceptTouchEvent / onTouchEvent）：整条 bar / 整块 blob
    // 任意位置都能起手拖，按钮区域越过 slop 后被拦截并送 CANCEL —— 与程序内浮条
    // 「pointerdown 绑在 .dock-body 上、拖拽后吞掉那次 click」同一套语义。
    // ⚠ 不要退回 `root.setOnTouchListener { _, ev -> onTouchEvent(ev) }`：在
    //   `LinearLayout(this).apply{}` 里那个未限定调用会解析到 View.onTouchEvent（视图自身），
    //   服务里的拖拽 / 长按逻辑永远不会执行 —— 0.7.18 的「全局浮窗完全拖不动」正是这个。
    val root =
      DockRoot(this).apply {
        // 空白处也要吃 DOWN，否则横条中间那段手势会漏给下层应用、拖不动
        isClickable = true
        isFocusable = false
        // 系统栏 / 刘海 / 导航模式的 inset 变化信号（见 refreshDockGeometry）。
        // 只当信号用：真正的数值一律回 WindowMetrics 取，避免拿到被窗口 fit 后的 0。
        setOnApplyWindowInsetsListener { _, insets ->
          main.post { refreshDockGeometry() }
          insets
        }
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
    stopSpring()
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

  /* ---------- 几何：四槽位（与 useDragDock / useFloatDock 同一套公式） ---------- */

  private fun density(): Float = resources.displayMetrics.density

  private fun dpF(value: Float): Float = value * density()

  /** 屏幕尺寸（px）；API 30+ 用 WindowMetrics，旧系统回退 displayMetrics */
  private fun screenSize(): Pair<Int, Int> {
    cachedScreen?.let { return it }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        val b = wm().currentWindowMetrics.bounds
        if (b.width() > 0 && b.height() > 0) {
          val s = b.width() to b.height()
          cachedScreen = s
          return s
        }
      } catch (e: Exception) {
        Log.w(TAG, "读取 WindowMetrics 失败，回退 displayMetrics", e)
      }
    }
    val s = resources.displayMetrics.widthPixels to resources.displayMetrics.heightPixels
    cachedScreen = s
    return s
  }

  private fun screenW(): Int = screenSize().first

  private fun screenH(): Int = screenSize().second

  /**
   * 安全区（left, top, right, bottom，px）。
   *
   * 程序内浮条用 --safe-*（env() 与 max() 链）；原生浮层读不到 CSS，只能问系统。
   * API 30+ 从 WindowMetrics.windowInsets 取系统栏 + 刘海；旧系统退回状态栏 /
   * 导航栏资源高度（个别横屏把导航栏放侧边的 ROM 会偏保守，最多让浮层多缩 12dp，
   * 不会压住系统栏）。
   */
  private fun safeInsets(): IntArray {
    cachedInsets?.let { return it }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        val i =
          wm().currentWindowMetrics.windowInsets.getInsets(
            WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
          )
        val s = intArrayOf(i.left, i.top, i.right, i.bottom)
        cachedInsets = s
        return s
      } catch (e: Exception) {
        Log.w(TAG, "读取系统栏 inset 失败，回退资源尺寸", e)
      }
    }
    val res = resources
    fun dimen(name: String): Int {
      val id = res.getIdentifier(name, "dimen", "android")
      return if (id > 0) res.getDimensionPixelSize(id) else 0
    }
    val s = intArrayOf(0, dimen("status_bar_height"), 0, dimen("navigation_bar_height"))
    cachedInsets = s
    return s
  }

  private fun edgeGap(): Int = dp(EDGE_GAP_DP)

  private fun sizeFor(targetForm: String): Pair<Int, Int> {
    if (targetForm == "blob") return dp(BLOB_DP) to dp(BLOB_DP)
    // 与程序内浮条 `min(100vw - 24, --frame-max - 24)` 同源；窄屏收口到屏宽 - 24dp
    val maxW = (screenW() - dp(BAR_INSET_DP)).coerceAtLeast(dp(200))
    return minOf(dp(BAR_MAX_DP), maxW) to dp(BAR_HEIGHT_DP)
  }

  private fun slotForm(s: Slot): String = if (s == Slot.LEFT || s == Slot.RIGHT) "blob" else "bar"

  /** 侧边槽位的方块中心可用纵向区间（px，中心点表达） */
  private fun sideYRange(blobH: Int): Pair<Float, Float> {
    val ins = safeInsets()
    val half = blobH / 2f + edgeGap()
    return (ins[1] + half) to (screenH() - ins[3] - half)
  }

  /** 槽位左上角坐标（px）—— 与 useDragDock.slotCenter 逐行对应，只是换成左上角表达 */
  private fun slotPos(s: Slot, w: Int, h: Int): Pair<Int, Int> {
    val ins = safeInsets()
    val gap = edgeGap()
    if (s == Slot.BOTTOM) return ((screenW() - w) / 2) to (screenH() - ins[3] - gap - h)
    if (s == Slot.TOP) return ((screenW() - w) / 2) to (ins[1] + gap)
    val (lo, hi) = sideYRange(h)
    val y = (lo + sideY.coerceIn(0f, 1f) * (hi - lo).coerceAtLeast(0f) - h / 2f).roundToInt()
    val x = if (s == Slot.LEFT) ins[0] else screenW() - ins[2] - w
    return x to y
  }

  /** 拖拽活动范围（左上角表达）；条宽近整屏时横向区间退化 —— 锁死，避免区间倒置 */
  private fun dragBounds(w: Int, h: Int): FloatArray {
    val ins = safeInsets()
    val gap = edgeGap()
    return floatArrayOf(
      ins[0].toFloat(),
      (screenW() - ins[2] - w).toFloat(),
      (ins[1] + gap).toFloat(),
      (screenH() - ins[3] - gap - h).toFloat(),
    )
  }

  /**
   * 系统栏 / 屏幕几何变了之后重落位。
   *
   * 为什么需要这一条：`onConfigurationChanged` 只在 w/h/density 这类配置变化时来。
   * **导航模式切换（手势 ↔ 三键）只改 inset、不改配置** —— 实测三键导航把底部导航栏
   * 从 63px 变成 126px 时服务收不到任何回调，缓存的 inset 一直是旧的，底部停靠的浮条
   * 会压进导航栏里。所以根视图挂 OnApplyWindowInsetsListener 当信号，收到就作废缓存
   * 并按当前槽位重算一次。
   *
   * 拖拽 / 弹簧飞行中不抢（用户的手还在屏幕上）；松手后的 dockTo 会用新度量。
   */
  private fun refreshDockGeometry() {
    cachedInsets = null
    cachedScreen = null
    if (dragging || springRunning) return
    if (rootView == null) return
    val (w, h) = sizeFor(form)
    val (x, y) = slotPos(slot, w, h)
    val p = params ?: return
    if (p.x != x || p.y != y) writePos(x.toFloat(), y.toFloat())
  }

  private fun writePos(x: Float, y: Float) {
    val root = rootView ?: return
    val p = params ?: return
    p.x = x.roundToInt()
    p.y = y.roundToInt()
    try {
      wm().updateViewLayout(root, p)
    } catch (e: Exception) {
      Log.w(TAG, "移动浮层失败", e)
    }
  }

  /** 形态变 → 尺寸变（保持中心，随后由 dockTo 的弹簧把窗口带到新槽位） */
  private fun resize() {
    val root = rootView ?: return
    val p = params ?: return
    val (w, h) = sizeFor(form)
    if (p.width == w && p.height == h) return
    val cx = p.x + p.width / 2f
    val cy = p.y + p.height / 2f
    p.width = w
    p.height = h
    p.x = (cx - w / 2f).roundToInt()
    p.y = (cy - h / 2f).roundToInt()
    try {
      wm().updateViewLayout(root, p)
    } catch (e: Exception) {
      Log.w(TAG, "更新浮层尺寸失败", e)
    }
  }

  /* ---------- 弹簧落位（可打断，与 useDragDock 同一组常量） ---------- */

  private val springFrame =
    object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        if (!springRunning) {
          lastFrameNs = 0L
          return
        }
        val p = params
        if (p == null || rootView == null) {
          springRunning = false
          lastFrameNs = 0L
          return
        }
        val dt =
          if (lastFrameNs == 0L) 1f / 60f
          else ((frameTimeNanos - lastFrameNs) / 1_000_000_000f).coerceIn(0f, 0.032f)
        lastFrameNs = frameTimeNanos
        springVx +=
          (SPRING_STIFFNESS * (springTargetX - springX) - SPRING_DAMPING * springVx) * dt
        springVy +=
          (SPRING_STIFFNESS * (springTargetY - springY) - SPRING_DAMPING * springVy) * dt
        springX += springVx * dt
        springY += springVy * dt
        writePos(springX, springY)
        if (
          abs(springTargetX - springX) < 0.5f &&
            abs(springTargetY - springY) < 0.5f &&
            hypot(springVx, springVy) < 20f
        ) {
          springX = springTargetX
          springY = springTargetY
          writePos(springX, springY)
          springRunning = false
          lastFrameNs = 0L
          persistDock()
          return
        }
        choreographer.postFrameCallback(this)
      }
    }

  private fun startSpring(tx: Float, ty: Float, vx: Float, vy: Float) {
    stopSpring()
    // 系统减弱动效 / 动画器被关掉时直接落位（与程序内 motionOn 同一条降级）
    val animOn = Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled()
    if (!animOn) {
      writePos(tx, ty)
      persistDock()
      return
    }
    val p = params ?: return
    springX = p.x.toFloat()
    springY = p.y.toFloat()
    springTargetX = tx
    springTargetY = ty
    springVx = vx
    springVy = vy
    springRunning = true
    lastFrameNs = 0L
    choreographer.postFrameCallback(springFrame)
  }

  private fun stopSpring() {
    if (!springRunning) return
    springRunning = false
    lastFrameNs = 0L
    try {
      choreographer.removeFrameCallback(springFrame)
    } catch (e: Exception) {
      Log.w(TAG, "停止弹簧失败", e)
    }
  }

  /**
   * 切槽位并飞过去（emitForm=true 时回传 form 让主窗口落偏好）。
   * 形态跟着槽位走：顶/底 = bar，左/右 = blob —— 与程序内浮条 `form = slot` 一致。
   */
  private fun dockTo(
    target: Slot,
    vx: Float,
    vy: Float,
    emitForm: Boolean = true,
  ) {
    stopSpring()
    val prevForm = form
    slot = target
    if (target == Slot.TOP || target == Slot.BOTTOM) barSlot = target
    form = slotForm(target)
    if (form != prevForm) {
      persistFormIfChanged(form)
      formPinnedUntil = SystemClock.uptimeMillis() + FORM_PIN_MS
      if (emitForm) emit(JSONObject().put("action", "form").put("form", form).toString())
      // 先改尺寸（保持中心），再按新形态重建内容
      resize()
      val snap = payload?.optJSONObject("snapshot")
      if (snap != null) bind(snap) else rootView?.removeAllViews()
    }
    val (w, h) = sizeFor(form)
    val (tx, ty) = slotPos(target, w, h)
    // 先落盘再飞：动画途中进程被杀 / 服务被系统收掉，下次也回到用户选的槽位
    persistDock()
    if (rootView == null) {
      // 视图还没建：落状态即可，ensureView 会按槽位建窗
      return
    }
    startSpring(tx.toFloat(), ty.toFloat(), vx, vy)
  }

  /* ---------- 拖拽 + 点击（整壳可拖，按钮区越过 slop 后让位给拖拽） ---------- */

  private fun pushSample(ev: MotionEvent) {
    samples.add(floatArrayOf(ev.eventTime.toFloat(), ev.rawX, ev.rawY))
    val cut = ev.eventTime - VELOCITY_WINDOW_MS
    while (samples.size > 2 && samples[0][0] < cut) samples.removeAt(0)
  }

  /** 松开速度（px/ms）；窗口内样本不足时回 0 */
  private fun sampleVelocity(): Pair<Float, Float> {
    if (samples.size < 2) return 0f to 0f
    val a = samples.first()
    val b = samples.last()
    val dt = b[0] - a[0]
    if (dt <= 0f) return 0f to 0f
    return (b[1] - a[1]) / dt to (b[2] - a[2]) / dt
  }

  /** 橡皮筋：界外位移按 iOS 同式衰减，越拉越紧（与 useDragDock 同一式） */
  private fun resist(x: Float, span: Float): Float {
    val d = span.coerceAtLeast(1f)
    return d * (1f - 1f / ((x * RUBBER_C) / d + 1f))
  }

  private fun rubber(raw: Float, lo: Float, hi: Float): Float {
    if (hi <= lo) return lo
    val span = hi - lo
    return when {
      raw < lo -> lo - resist(lo - raw, span)
      raw > hi -> hi + resist(raw - hi, span)
      else -> raw
    }
  }

  private fun yToSideY(cy: Float): Float {
    val (lo, hi) = sideYRange(dp(BLOB_DP))
    if (hi <= lo) return sideY
    return ((cy - lo) / (hi - lo)).coerceIn(0f, 1f)
  }

  private fun solveRelease(cx: Float, cy: Float, vx: Float, vy: Float): Slot {
    if (hypot(vx, vy) >= dpF(FLICK_DP_MS)) {
      // 轻弹：速度主轴决定去向（横向 → 左/右方块并记住松手高度；纵向 → 顶/底）
      if (abs(vx) > abs(vy)) {
        sideY = yToSideY(cy)
        return if (vx > 0f) Slot.RIGHT else Slot.LEFT
      }
      return if (vy > 0f) Slot.BOTTOM else Slot.TOP
    }
    return nearestSlot(cx, cy, vx, vy)
  }

  /** 慢放：投影 p + v·180ms 后取最近槽位（四槽位都参与，含 bar / blob 的尺寸差） */
  private fun nearestSlot(cx: Float, cy: Float, vx: Float, vy: Float): Slot {
    val jx = cx + vx * PROJECTION_MS
    val jy = cy + vy * PROJECTION_MS
    val candY = yToSideY(jy)
    var best = Slot.BOTTOM
    var bestD = Float.MAX_VALUE
    for (s in Slot.values()) {
      val save = sideY
      if (s == Slot.LEFT || s == Slot.RIGHT) sideY = candY
      val (w, h) = sizeFor(slotForm(s))
      val (x, y) = slotPos(s, w, h)
      sideY = save
      val dx = x + w / 2f - jx
      val dy = y + h / 2f - jy
      val d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    if (best == Slot.LEFT || best == Slot.RIGHT) sideY = candY
    return best
  }

  private fun onDockDown(ev: MotionEvent) {
    val p = params ?: return
    // 飞行途中接住：以当前位置接管为新拖拽（速度交给新的采样）
    stopSpring()
    dragStartX = p.x
    dragStartY = p.y
    downRawX = ev.rawX
    downRawY = ev.rawY
    dragging = false
    longPressFired = false
    samples.clear()
    pushSample(ev)
    // 长按泊车 / 轻点打开都只认「从信息区起手」：按钮自己吃事件，能走到这里的
    // 一定不是按钮；命中测试再把条上其余空白排除掉。
    downInInfo = form == "bar" && isInsideInfo(ev.rawX, ev.rawY)
    if (downInInfo) startLongPress()
  }

  private fun shouldEngage(ev: MotionEvent): Boolean =
    hypot(ev.rawX - downRawX, ev.rawY - downRawY) > dpF(SLOP_DP.toFloat())

  private fun engageDrag(ev: MotionEvent) {
    if (dragging) return
    dragging = true
    cancelLongPress()
    pushSample(ev)
  }

  private fun moveDrag(ev: MotionEvent) {
    pushSample(ev)
    val p = params ?: return
    val b = dragBounds(p.width, p.height)
    val rawX = dragStartX + (ev.rawX - downRawX)
    val rawY = dragStartY + (ev.rawY - downRawY)
    writePos(rubber(rawX, b[0], b[1]), rubber(rawY, b[2], b[3]))
  }

  private fun finishDrag(cancelled: Boolean) {
    cancelLongPress()
    val wasDragging = dragging
    val tapped = !wasDragging && !longPressFired
    val inInfo = downInInfo
    dragging = false
    longPressFired = false
    downInInfo = false
    val p = params ?: return
    if (wasDragging) {
      val cx = p.x + p.width / 2f
      val cy = p.y + p.height / 2f
      if (cancelled) {
        dockTo(nearestSlot(cx, cy, 0f, 0f), 0f, 0f)
        return
      }
      val (vx, vy) = sampleVelocity()
      dockTo(solveRelease(cx, cy, vx, vy), vx, vy)
    } else if (tapped) {
      // 与程序内浮条同一个语义：方块轻点 = 展开；条上信息区轻点 = 打开会话页
      if (form == "blob") onTap() else if (inInfo) openApp(actionJson("open"))
    }
  }

  /**
   * 浮层根视图：把触摸接管放在 View 自己的 onInterceptTouchEvent / onTouchEvent 上。
   *
   * 为什么不是 `setOnTouchListener`：那层监听器只在**整组视图自己**吃到事件时才回调，
   * 而按钮是 clickable 的、会在 DOWN 就吃掉事件；更要命的是在 `LinearLayout(this).apply{}`
   * 里写未限定的 `onTouchEvent(ev)` 会解析到 View 自身的方法（0.7.18 的真 bug：
   * 全局浮窗完全拖不动、长按泊车也不生效）。
   *
   * 拦截策略与程序内浮条同义：DOWN 先给子视图（按钮照常按），位移一旦越过 8dp 就由
   * 根视图拦截（子视图收到 CANCEL，不会误触发点击），整条 / 整块任意位置都能起手拖。
   */
  private inner class DockRoot(context: Context) : LinearLayout(context) {
    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          onDockDown(ev)
          return false
        }
        MotionEvent.ACTION_MOVE -> {
          if (dragging) return true
          if (shouldEngage(ev)) {
            engageDrag(ev)
            return true
          }
          return false
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          if (!dragging) cancelLongPress()
          return false
        }
      }
      return false
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          onDockDown(ev)
          return true
        }
        MotionEvent.ACTION_MOVE -> {
          if (!dragging && shouldEngage(ev)) engageDrag(ev)
          if (dragging) moveDrag(ev)
          return true
        }
        MotionEvent.ACTION_UP -> {
          finishDrag(false)
          return true
        }
        MotionEvent.ACTION_CANCEL -> {
          finishDrag(true)
          return true
        }
      }
      return true
    }
  }

  /** 轻点语义：只有 blob 态有（展开回上一次的全宽条槽位，与程序内方块同一个落点） */
  private fun onTap() {
    if (form != "blob") return
    dockTo(barSlot, 0f, 0f, emitForm = true)
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

  /** 泊车：按当前中心选最近一侧，保留纵向比例，再回传 form 让主窗口的持久形态与本机对齐 */
  private fun park() {
    if (form != "bar") return
    val p = params ?: return
    val cx = p.x + p.width / 2f
    val cy = p.y + p.height / 2f
    sideY = yToSideY(cy)
    dockTo(if (cx < screenW() / 2f) Slot.LEFT else Slot.RIGHT, 0f, 0f, emitForm = true)
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

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

  private fun isNight(): Boolean =
    (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES

  /**
   * 载入停靠槽位（与程序内浮条同一个持久化语义：槽位 / 上次条槽位 / 侧边纵向比例）。
   * 旧版本只存 KEY_SIDE + KEY_X/KEY_Y，这里做一次性迁移，之后一律写四槽位键。
   */
  private fun loadDock() {
    val savedSlot = prefs.getString(KEY_SLOT, null)
    if (savedSlot != null) {
      slot = parseSlot(savedSlot) ?: Slot.BOTTOM
      barSlot = parseSlot(prefs.getString(KEY_BAR_SLOT, null)) ?: Slot.BOTTOM
      sideY = prefs.getFloat(KEY_SIDE_Y, 0.7f).coerceIn(0f, 1f)
    } else {
      val side = prefs.getString(KEY_SIDE, "")
      if (side == "left" || side == "right") {
        slot = if (side == "left") Slot.LEFT else Slot.RIGHT
        barSlot = Slot.BOTTOM
        val (lo, hi) = sideYRange(dp(BLOB_DP))
        val y = prefs.getInt(KEY_Y, -1)
        sideY = if (y >= 0 && hi > lo) ((y - lo) / (hi - lo)).coerceIn(0f, 1f) else 0.7f
      } else {
        val y = prefs.getInt(KEY_Y, -1)
        slot = if (y in 0 until screenH() / 2) Slot.TOP else Slot.BOTTOM
        barSlot = slot
      }
    }
    if (barSlot != Slot.TOP && barSlot != Slot.BOTTOM) barSlot = Slot.BOTTOM
    form = slotForm(slot)
    persistFormIfChanged(form)
  }

  /** 停靠状态落盘（只在手势/弹簧结束时写，不跟着 1s 心跳写） */
  private fun persistDock() {
    try {
      prefs
        .edit()
        .putString(KEY_SLOT, slot.prefName())
        .putString(KEY_BAR_SLOT, barSlot.prefName())
        .putFloat(KEY_SIDE_Y, sideY)
        .apply()
    } catch (e: Exception) {
      Log.w(TAG, "持久化停靠槽位失败", e)
    }
  }

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