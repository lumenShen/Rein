package com.gozaoo.rein

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import com.gozaoo.rein.connectedapps.ConnectedAppSpecs
import com.gozaoo.rein.connectedapps.FileOps
import com.gozaoo.rein.connectedapps.Json
import com.gozaoo.rein.connectedapps.PermissionMap
import org.json.JSONObject
import java.io.File

/**
 * 连接本机应用的 Android 入口。
 *
 * JNI 签名被 Rust `modules/connected_apps/android.rs` 固定：
 * - `status(Context, String): String` —— 第二个参数是 app（`*`/空 = 全部 8 个）
 * - `request(Context, String, String): String` —— app + mode
 * - `invoke(Context, String, String, String, String): Void` —— app + method + payload + requestId
 * - `revoke(Context, String): Void`
 *
 * 文件协议：`cacheDir/connected_apps/state.json`（Kotlin 写，原子替换）、
 * `<requestId>.json`（Kotlin 写结果）、`requests/<requestId>.request.json`（Rust 写）。
 * 这里只写「原生事实」（权限/根/能力），连接同意与 AI/写入意图由 Rust `app_meta` 合并。
 */
object ConnectedAppsBridge {
    private const val TAG = "ConnectedAppsBridge"
    private const val DIR = "connected_apps"
    private const val STATE_FILE = "state.json"

    private val ANDROID_APPS = listOf(
        "alarm",
        "usage",
        "calendar",
        "contacts",
        "filesystem",
        "location",
        "notification",
        "sms",
    )

    @Volatile
    private var generation = 0L

    private var activityRef: ComponentActivity? = null
    private var permissionLauncher: ActivityResultLauncher<Array<String>>? = null
    private var treeLauncher: ActivityResultLauncher<Uri?>? = null

    /** MainActivity.onCreate 调一次；launcher 必须在 Activity 创建后注册。 */
    fun register(activity: ComponentActivity) {
        activityRef = activity
        permissionLauncher =
            activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
                // 权限结果只影响随后的 state.json；UI 回前台后重新拉 status。
                refresh(activity)
            }
        treeLauncher =
            activity.registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
                if (uri != null) {
                    try {
                        val flags =
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        activity.contentResolver.takePersistableUriPermission(uri, flags)
                        FileOps.setTree(
                            activity,
                            uri,
                            uri.lastPathSegment ?: "已授权文件夹",
                        )
                    } catch (e: SecurityException) {
                        // 部分 provider 不支持持久授权：保留状态为 partial，由 UI 引导重选。
                        Log.w(TAG, "SAF 持久授权失败", e)
                    }
                }
                refresh(activity)
            }
    }

    /** 重算 8 个 Android app 的原生事实并写 state.json（后台线程）。 */
    @JvmStatic
    fun refresh(context: Context) {
        Thread {
            try {
                writeState(context.applicationContext)
            } catch (t: Throwable) {
                Log.w(TAG, "refresh 失败", t)
            }
        }.start()
    }

    /**
     * 返回 state.json 同形 JSON；首次没有文件时返回空 apps（Rust 会判 unknown）。
     * `app` 为空 / `*` / `refresh` 时返回全部 8 个 app；否则只返回该 app。
     */
    @JvmStatic
    fun status(context: Context, app: String): String {
        refresh(context)
        val state = readState(context)
            ?: return JSONObject()
                .put("generation", generation)
                .put("apps", JSONObject())
                .toString()
        if (app.isBlank() || app == "*" || app == "refresh") return state.toString()

        val scopedApps = JSONObject()
        state.optJSONObject("apps")?.optJSONObject(app)?.let { scopedApps.put(app, it) }
        return JSONObject()
            .put("generation", state.optLong("generation", generation))
            .put("updatedAt", state.opt("updatedAt") ?: JSONObject.NULL)
            .put("apps", scopedApps)
            .toString()
    }

    /** 拉起运行时权限 / 特殊设置 / SAF 选择器；不写连接同意。 */
    @JvmStatic
    fun request(context: Context, app: String, mode: String): String {
        return try {
            when (mode) {
                "permissions", "permissions_write" -> {
                    val permissions = if (mode == "permissions_write") {
                        PermissionMap.runtimeWritePermissions(app)
                    } else {
                        PermissionMap.runtimePermissions(app)
                    }
                    val launcher = permissionLauncher
                    if (permissions.isEmpty()) {
                        JSONObject()
                            .put("opened", false)
                            .put("reason", "该应用无需运行时权限")
                    } else if (launcher == null) {
                        JSONObject()
                            .put("opened", false)
                            .put("reason", "请先打开 Rein 界面再授权")
                    } else {
                        launcher.launch(permissions)
                        JSONObject().put("opened", true)
                    }
                }
                "folder" -> {
                    if (app != "filesystem") {
                        JSONObject()
                            .put("opened", false)
                            .put("reason", "该应用使用固定系统文件夹")
                    } else {
                        val launcher = treeLauncher
                        if (launcher == null) {
                            JSONObject()
                                .put("opened", false)
                                .put("reason", "请先打开 Rein 界面再选择文件夹")
                        } else {
                            launcher.launch(null)
                            JSONObject().put("opened", true)
                        }
                    }
                }
                "usage_access", "notification_access", "settings" -> {
                    val action = PermissionMap.specialAction(mode)
                    if (action == null) {
                        JSONObject()
                            .put("opened", false)
                            .put("reason", "未知授权模式：$mode")
                    } else {
                        // 系统设置页一律用 applicationContext + NEW_TASK，避免依赖 Activity 栈。
                        val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        if (mode == "settings") {
                            intent.data = Uri.parse("package:${context.packageName}")
                        }
                        context.applicationContext.startActivity(intent)
                        JSONObject().put("opened", true)
                    }
                }
                else -> ConnectedAppSpecs.request(context.applicationContext, app, mode)
            }.toString()
        } catch (t: Throwable) {
            JSONObject()
                .put("opened", false)
                .put("reason", t.javaClass.simpleName)
                .toString()
        }
    }

    /** 结果文件只由 Kotlin 写；请求文件只由 Rust 写，两边不共写同一文件。 */
    @JvmStatic
    fun invoke(
        context: Context,
        app: String,
        method: String,
        payloadJson: String,
        requestId: String,
    ) {
        val appContext = context.applicationContext
        Thread {
            val dir = File(appContext.cacheDir, DIR).apply { mkdirs() }
            val result = try {
                val payload = if (payloadJson.isBlank()) JSONObject() else JSONObject(payloadJson)
                ConnectedAppSpecs.handle(appContext, app, method, payload)
            } catch (t: Throwable) {
                Json.err("connected_app_native_error", t.javaClass.simpleName)
            }
            Json.writeAtomic(File(dir, "$requestId.json"), result)
        }.start()
    }

    /** 断开 filesystem：释放 SAF 持久授权并清树；notification 清缓存。 */
    @JvmStatic
    fun revoke(context: Context, app: String) {
        when (app) {
            "filesystem" -> {
                val tree = FileOps.tree(context)
                if (tree != null) {
                    try {
                        context.contentResolver.releasePersistableUriPermission(
                            Uri.parse(tree),
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                        )
                    } catch (_: SecurityException) {
                        // 授权可能已被系统回收：忽略，继续清 prefs。
                    }
                }
                FileOps.clearTree(context)
            }
            "notification" -> {
                // 断开时同时清 listener 内存 ring 与 notifications.json。
                com.gozaoo.rein.connectedapps.ReinNotificationListenerService.clearCache(
                    context.applicationContext,
                )
            }
        }
        refresh(context)
    }

    @Synchronized
    private fun writeState(context: Context) {
        val apps = JSONObject()
        for (app in ANDROID_APPS) {
            apps.put(app, ConnectedAppSpecs.status(context, app))
        }
        generation += 1
        val state = JSONObject()
            .put("generation", generation)
            .put("updatedAt", Json.isoNow())
            .put("apps", apps)
        val dir = File(context.cacheDir, DIR).apply { mkdirs() }
        Json.writeAtomic(File(dir, STATE_FILE), state)
    }

    private fun readState(context: Context): JSONObject? = try {
        val file = File(File(context.cacheDir, DIR), STATE_FILE)
        if (file.exists()) JSONObject(file.readText()) else null
    } catch (_: Throwable) {
        null
    }
}
