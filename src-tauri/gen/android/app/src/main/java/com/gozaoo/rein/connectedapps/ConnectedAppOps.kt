package com.gozaoo.rein.connectedapps

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 连接应用 Ops 的统一接口 + 固定 when(app) 分发。
 *
 * 每个 Ops 都返回真实的系统查询结果；失败抛 [OpsError]（结构化 code），
 * Bridge 统一转成 `{ok:false,error}`，绝不假成功。
 */
internal data class OpsPermission(
    val key: String,
    val write: Boolean = false,
    val required: Boolean = true,
)

internal interface ConnectedAppOps {
    fun status(ctx: Context): JSONObject
    fun request(ctx: Context, mode: String): JSONObject
    fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject
    /** 该 app 的权限声明（含写权限），与 Rust `state::PermissionSpec` 同名。 */
    fun permissions(): List<OpsPermission>
}

/** Ops 主动抛出的结构化错误；Bridge 统一转成 `{ok:false,error}`。 */
internal class OpsError(
    val code: String,
    message: String,
    val action: String? = null,
) : Exception(message)

/** app id → Ops 的固定 when 分发（不动态反射）。 */
internal object ConnectedAppSpecs {
    private fun opsFor(app: String): ConnectedAppOps? = when (app) {
        "alarm" -> AlarmOps
        "usage" -> UsageOps
        "calendar" -> CalendarOps
        "contacts" -> ContactsOps
        "filesystem" -> FileOps
        "location" -> LocationOps
        "notification" -> NotificationOps
        "sms" -> SmsOps
        else -> null
    }

    fun status(ctx: Context, app: String): JSONObject =
        opsFor(app)?.status(ctx)
            ?: baseStatus(supported = false, available = false, detail = "未知应用")

    fun request(ctx: Context, app: String, mode: String): JSONObject =
        opsFor(app)?.request(ctx, mode)
            ?: Json.err("connected_app_bad_request", "未知连接应用：$app")

    fun handle(ctx: Context, app: String, method: String, payload: JSONObject): JSONObject {
        val handler = opsFor(app) ?: return Json.err("connected_app_bad_request", "未知连接应用：$app")
        return try {
            val result = handler.handle(ctx, method, payload)
            // Rust 只认 {ok,data} 信封；个别 Ops 直接返回裸数据，缺 ok 会被当成失败。
            if (result.has("ok")) result else Json.ok(result)
        } catch (e: OpsError) {
            Json.err(e.code, e.message ?: "", e.action)
        } catch (t: Throwable) {
            // 只带异常类名，不带堆栈（plan §3.3）。
            Json.err("connected_app_native_error", t.javaClass.simpleName)
        }
    }
}

internal fun baseStatus(
    permissions: JSONArray = JSONArray(),
    roots: JSONArray = JSONArray(),
    capabilities: JSONArray = JSONArray(),
    supported: Boolean = false,
    available: Boolean = false,
    detail: String? = null,
): JSONObject =
    JSONObject()
        .put("supported", supported)
        .put("available", available)
        .put("detail", detail ?: JSONObject.NULL)
        .put("permissions", permissions)
        .put("roots", roots)
        .put("capabilities", capabilities)

/**
 * 所有需要 `startActivity` 的 Ops 都用它切主线程并把异常带回调用线程。
 */
internal fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
        block()
        return
    }
    val latch = CountDownLatch(1)
    Handler(Looper.getMainLooper()).post {
        try {
            block()
        } finally {
            latch.countDown()
        }
    }
    latch.await(5, TimeUnit.SECONDS)
}
