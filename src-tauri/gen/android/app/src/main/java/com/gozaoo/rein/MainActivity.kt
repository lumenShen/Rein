package com.gozaoo.rein

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Android 系统 WebView 的 env(safe-area-inset-*) 只报告状态栏、不报告底部导航条，
 * 也不报告左右边缘返回手势带（详见前端 tokens.css --safe-* 注释）。这里监听真实
 * WindowInsets，把四向安全区注入为页面 CSS 变量 --safe-*-native；左右取
 * systemGestures（手势导航的返回手势带宽度，按钮导航时为 0，由前端兜底下限接管）。
 * WebView 在 Activity 布局完成前不存在、页面文档随后才加载，故每次 inset 变化后
 * 以 300ms 间隔重试 12s（写变量是幂等的，落在哪个文档上都无害）。
 */
class MainActivity : TauriActivity() {
  private val handler = Handler(Looper.getMainLooper())
  private val maxRetries = 40
  private var retries = 0
  private var topInset = 0 // 已换算成 CSS px
  private var bottomInset = 0
  private var leftInset = 0
  private var rightInset = 0

  companion object {
    /** 当前 Activity（跑步采集服务推送 live/轨迹点、派发通知事件时要找 WebView） */
    @Volatile var current: MainActivity? = null

    /** 递归查找 WebView（ShareReceiver 派发 rein-share 事件也要用） */
    fun findWebView(view: View?): WebView? {
      if (view == null) return null
      if (view is WebView) return view
      if (view is ViewGroup) {
        for (i in 0 until view.childCount) {
          findWebView(view.getChildAt(i))?.let { return it }
        }
      }
      return null
    }
  }

  private val inject = object : Runnable {
    override fun run() {
      if (topInset + bottomInset + leftInset + rightInset > 0) {
        findWebView(window.decorView)?.evaluateJavascript(
          "(function(){var s=document.documentElement.style;" +
            "s.setProperty('--safe-top-native','${topInset}px');" +
            "s.setProperty('--safe-bottom-native','${bottomInset}px');" +
            "s.setProperty('--safe-left-native','${leftInset}px');" +
            "s.setProperty('--safe-right-native','${rightInset}px')})()",
          null,
        )
      }
      if (--retries > 0) handler.postDelayed(this, 300L)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    current = this
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 注册跑步保活桥的权限弹窗回调（ActivityResultLauncher 必须在 Activity 创建后注册）
    TrackingBridge.register(this)
    // 注册 Health Connect 授权界面的回调（同上，必须在 onCreate 注册）。
    // 版本闸：Health Connect 是 API 26+ 才有的东西，Android 7 的机器连这个类都别去碰
    // （它引用的 java.time 靠 desugaring 兜着，能不加载就不加载）。
    if (android.os.Build.VERSION.SDK_INT >= 26) HealthConnectBridge.register(this)
    // 系统分享/打开的文件（冷启动 intent 可能自带）：落收件箱 + 通知前端
    ShareReceiver.handle(this, intent)
    // 点通知进应用（冷启动）：落待办 + 尽量当场派发 DOM 事件
    handleOpenIntent(intent)
    // 系统浮层点「打开」进应用（冷启动）：动作随 intent 一起来，交给桥统一派发
    handleFloatAction(intent)
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      // WindowInsets 是物理像素；CSS 像素 = 物理像素 / density，直接塞会放大 2~3 倍
      val density = resources.displayMetrics.density
      topInset = (insets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout(),
      ).top / density).toInt()
      bottomInset = (insets.getInsets(
        WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout(),
      ).bottom / density).toInt()
      val gesture = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
      leftInset = (gesture.left / density).toInt()
      rightInset = (gesture.right / density).toInt()
      // 每次安全区变化（旋转/键盘等）重新推一轮，也覆盖页面重载后变量丢失的情况
      retries = maxRetries
      handler.removeCallbacks(inject)
      handler.post(inject)
      insets
    }
  }

  /** Android 12+ 的系统级 overscroll 效果由 glow 改为 stretch（WebView 走 Chromium 的实现，
   *  只作用在根滚动容器上，表现为滚动到边界时整页 scaleY 拉伸）。它是原生 View 的 EdgeEffect，
   *  CSS（overscroll-behavior / touch-action）管不到——只有把 WebView 的 overScrollMode 置为
   *  NEVER 才能关掉。超范围手感改由 Web 层自绘：src/system/rubberScroll.ts（对数阻尼 + 平移，
   *  f(0)=0 且 f'(0)=1，与原生滚动交接无速度突变）。
   *
   *  另外在这里关掉 WebView 自己的缩放（双指捏合 / 双击 / 缩放控件）：这套界面的尺寸
   *  全部按 430×932 的视口标定成绝对像素（触区 44、Dock 58、页签 38），整页放大不会
   *  触发重排，只会把已经画好的东西连同固定定位的 Dock / 悬浮条一起撑出错位。
   *  前端那两条（index.html 的 viewport、base.css 的 touch-action）是同一件事的另外两道：
   *  `user-scalable=no` 在部分内核上会被忽略，`touch-action` 管不到内核自带的缩放控件，
   *  所以内核这一层必须自己关。setSupportZoom(false) 同时管住捏合与双击；它是
   *  **WebView 的页面缩放**，不影响无障碍字号（textZoom 跟系统字体设置走）。 */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false
  }

  /** 运行中被分享唤起（singleTask，不重建）：把新 intent 交给分享接收 */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    ShareReceiver.handle(this, intent)
    // 点通知回前台（Activity 已在）：同样落待办 + 当场派发
    handleOpenIntent(intent)
    // 系统浮层点「打开」回前台（singleTask 不重建）：动作同样派发
    handleFloatAction(intent)
  }

  /**
   * 前台态是「全局浮窗该不该显示」的唯一边界（契约 §3.1）：
   * Activity resumed = 程序内浮条在场 → 系统浮层 GONE；pause（切后台/锁屏/去别的应用）
   * → 浮层 VISIBLE。服务本身不启停，会话状态因此不会被一次切后台打断。
   */
  override fun onResume() {
    super.onResume()
    GlobalFloatBridge.onAppForeground(this, true)
  }

  override fun onPause() {
    super.onPause()
    GlobalFloatBridge.onAppForeground(this, false)
  }

  override fun onDestroy() {
    if (current === this) current = null
    super.onDestroy()
  }

  /**
   * 点通知进应用：写 SharedPreferences（进程被杀后仍能落回跑步页）**与**
   * TrackingBridge 的静态 pendingOpen（页面还没载入时唯一能读到的地方），
   * 再尽量当场派发 rein-open-workout（WebView 未就绪则静默，由 tracking_open_pending 兜底）。
   */
  private fun handleOpenIntent(intent: Intent?) {
    val kind = intent?.getStringExtra(TrackingBridge.EXTRA_OPEN) ?: return
    if (kind != "run" && kind != "course") return
    getSharedPreferences("rein", MODE_PRIVATE).edit().putString("rein_open", kind).apply()
    TrackingBridge.pendingOpen = kind
    handler.post {
      try {
        val wv = findWebView(window.decorView) ?: return@post
        wv.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('rein-open-workout',{detail:{kind:'$kind'}}))",
          null,
        )
      } catch (e: Exception) {
        // 页面未就绪/已销毁：待办已经落下，前端轮询 tracking_open_pending 会拿到
        android.util.Log.w("MainActivity", "派发 rein-open-workout 失败", e)
      }
    }
  }

  /**
   * 系统浮层 → WebView 的动作通道（intent extra）。
   *
   * 走 GlobalFloatBridge.deliverIntentAction 而不是在这里再写一份 evaluateJavascript：
   * 桥统一负责「先落缓存 → 派发 DOM 事件」，缓存留给前端启动时的 take_action
   * —— 冷启动这一拍 WebView 往往还在加载空文档，只靠 evaluateJavascript 会把动作弄丢。
   *
   * 读完立刻把 extra 摘掉：Activity 重建/进程恢复时同一个 intent 会被重放，
   * 动作不能因此执行第二次。
   */
  private fun handleFloatAction(intent: Intent?) {
    val raw = intent?.getStringExtra(GlobalFloatBridge.EXTRA_ACTION) ?: return
    intent.removeExtra(GlobalFloatBridge.EXTRA_ACTION)
    if (!raw.trimStart().startsWith("{")) {
      android.util.Log.w("MainActivity", "浮层动作不是 JSON 对象，丢弃")
      return
    }
    GlobalFloatBridge.deliverIntentAction(this, raw)
  }

  private fun findWebView(view: View?): WebView? {
    return Companion.findWebView(view)
  }
}