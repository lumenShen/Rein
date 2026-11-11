package com.gozaoo.rein.connectedapps

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.AlarmClock
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 闹钟 / 计时器（Android）。
 *
 * 能力边界（plan §1.2 / §13.1）：
 * - `alarm_next` 只读系统「下一个闹钟」（AlarmManager.getNextAlarmClock），没有列全部的公开 API；
 * - 设置/取消一律通过系统时钟应用的 intent（AlarmClock.ACTION_*），**不静默创建 AlarmManager 闹钟**；
 * - 结果只承诺 `dispatched`（已发出 intent），不承诺时钟应用真的设置成功；
 * - 所有 intent 都带 NEW_TASK；从后台发起也走主线程，避免 ActivityNotFound 直接打崩。
 *
 * 写权限由 Rust 的 `writeAllowed` + `clock_app` 判定；Kotlin 侧只校验系统时钟是否存在。
 */
internal object AlarmOps : ConnectedAppOps {
    private val CAPABILITIES = listOf(
        "alarm_next",
        "set_alarm",
        "set_timer",
        "dismiss_alarm",
        "dismiss_timer",
    )

    private val PERMISSIONS = listOf(
        OpsPermission("clock_app"),
        OpsPermission("clock_write", write = true, required = false),
    )

    private const val MAX_LABEL = 64
    private const val MAX_SECONDS = 86_400
    private const val MAX_DAYS = 7
    private const val WAIT_MS = 5_000L

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        // plan：alarm 的 supported 恒 true；available 取决于有没有能处理 SET_ALARM 的时钟应用。
        val clock = hasClockApp(ctx)
        val permissions = JSONArray()
            .put(JSONObject().put("key", "clock_app").put("granted", clock))
            // clock_write 是「允许写入」的 consent 标记；Rust 只用 clock_app 判 native write ready。
            .put(JSONObject().put("key", "clock_write").put("granted", clock))
        val capabilities = if (clock) CAPABILITIES else listOf("alarm_next")
        return baseStatus(
            permissions = permissions,
            capabilities = JSONArray(capabilities),
            supported = true,
            available = clock,
            detail = if (clock) null else "没有找到可用的系统时钟应用",
        )
    }

    /** 闹钟没有运行时权限；Bridge 会把 permissions/permissions_write 直接变成 no-op。 */
    override fun request(ctx: Context, mode: String): JSONObject = JSONObject()
        .put("opened", false)
        .put("reason", "闹钟不需要系统权限；设置/取消由系统时钟应用处理")

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject = when (method) {
        "alarm_next" -> nextAlarm(ctx)
        "set_alarm" -> setAlarm(ctx, payload)
        "set_timer" -> setTimer(ctx, payload)
        "dismiss_alarm" -> dismissAlarm(ctx, payload)
        "dismiss_timer" -> dismissTimer(ctx, payload)
        else -> throw OpsError("connected_app_unknown_method", "闹钟不支持方法 $method")
    }

    private fun nextAlarm(ctx: Context): JSONObject {
        val manager = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            ?: throw OpsError("connected_app_unavailable", "系统没有闹钟服务")
        val next = manager.nextAlarmClock
        val at = next?.triggerTime?.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).toString() }
        // AlarmClockInfo.getCreator 不是公开 API；showIntent 的 creatorPackage 是公开可读的替代。
        val pkg = next?.showIntent?.creatorPackage
        return JSONObject()
            .put("at", at ?: JSONObject.NULL)
            .put("package", pkg ?: JSONObject.NULL)
    }

    private fun setAlarm(ctx: Context, payload: JSONObject): JSONObject {
        val hour = payload.optInt("hour", -1)
        val minute = payload.optInt("minute", -1)
        if (hour !in 0..23) throw OpsError("connected_app_bad_request", "hour 必须是 0..23 的整数")
        if (minute !in 0..59) throw OpsError("connected_app_bad_request", "minute 必须是 0..59 的整数")
        val label = Json.truncate(payload.optString("label", ""), MAX_LABEL).ifBlank { null }
        val skipUi = payload.optBoolean("skipUi", true)
        val vibrate = payload.optBoolean("vibrate", true)

        val days = ArrayList<Int>()
        val rawDays = payload.optJSONArray("days")
        if (rawDays != null) {
            if (rawDays.length() > MAX_DAYS) {
                throw OpsError("connected_app_bad_request", "days 最多 $MAX_DAYS 个")
            }
            for (i in 0 until rawDays.length()) {
                val day = rawDays.optInt(i, -1)
                if (day !in 1..MAX_DAYS) {
                    throw OpsError("connected_app_bad_request", "days 只能是 1..7（1=周一，7=周日）")
                }
                if (!days.contains(day)) days.add(day)
            }
        }

        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
            .putExtra(AlarmClock.EXTRA_VIBRATE, vibrate)
        if (label != null) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label)
        if (days.isNotEmpty()) {
            val calendarDays = ArrayList<Int>(days.size)
            for (day in days) calendarDays.add(dayOfWeekToCalendar(day))
            intent.putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, calendarDays)
        }
        dispatch(ctx, intent)

        return JSONObject()
            .put("dispatched", true)
            .put("hour", hour)
            .put("minute", minute)
            .put("label", label ?: JSONObject.NULL)
            .put("days", JSONArray(days))
            .put("skipUi", skipUi)
    }

    private fun setTimer(ctx: Context, payload: JSONObject): JSONObject {
        val seconds = payload.optInt("seconds", -1)
        if (seconds !in 1..MAX_SECONDS) {
            throw OpsError("connected_app_bad_request", "seconds 必须是 1..86400 的整数")
        }
        val label = Json.truncate(payload.optString("label", ""), MAX_LABEL).ifBlank { null }
        val skipUi = payload.optBoolean("skipUi", true)

        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
        if (label != null) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label)
        dispatch(ctx, intent)

        return JSONObject()
            .put("dispatched", true)
            .put("seconds", seconds)
            .put("label", label ?: JSONObject.NULL)
            .put("skipUi", skipUi)
    }

    private fun dismissAlarm(ctx: Context, payload: JSONObject): JSONObject {
        // ACTION_DISMISS_ALARM 是 API 23+；minSdk 24 已满足。
        val mode = searchMode(payload)
        val intent = Intent(AlarmClock.ACTION_DISMISS_ALARM)
            .putExtra(
                AlarmClock.EXTRA_ALARM_SEARCH_MODE,
                if (mode == "all") AlarmClock.ALARM_SEARCH_MODE_ALL else AlarmClock.ALARM_SEARCH_MODE_NEXT,
            )
        dispatch(ctx, intent)
        return JSONObject().put("dispatched", true).put("mode", mode)
    }

    private fun dismissTimer(ctx: Context, payload: JSONObject): JSONObject {
        if (Build.VERSION.SDK_INT < 26) {
            throw OpsError(
                "connected_app_unsupported",
                "系统版本低于 Android 8.0，无法通过系统接口取消计时器；请到系统时钟应用里取消",
            )
        }
        val mode = searchMode(payload)
        // 公开 API 只有 EXTRA_ALARM_SEARCH_MODE；ACTION_DISMISS_TIMER 复用它传 next/all。
        val intent = Intent(AlarmClock.ACTION_DISMISS_TIMER)
            .putExtra(
                AlarmClock.EXTRA_ALARM_SEARCH_MODE,
                if (mode == "all") AlarmClock.ALARM_SEARCH_MODE_ALL else AlarmClock.ALARM_SEARCH_MODE_NEXT,
            )
        dispatch(ctx, intent)
        return JSONObject().put("dispatched", true).put("mode", mode)
    }

    private fun searchMode(payload: JSONObject): String {
        val mode = payload.optString("mode", "next").trim()
        if (mode != "next" && mode != "all") {
            throw OpsError("connected_app_bad_request", "mode 只能是 next 或 all")
        }
        return mode
    }

    /** 1=周一 … 7=周日 → Calendar.MONDAY(2) … Calendar.SUNDAY(1)。 */
    private fun dayOfWeekToCalendar(day: Int): Int = (day % 7) + 1

    private fun hasClockApp(ctx: Context): Boolean =
        Intent(AlarmClock.ACTION_SET_ALARM).resolveActivity(ctx.packageManager) != null

    /**
     * 统一 dispatch：校验系统能处理、切主线程 startActivity、把异常带回调用线程。
     * 不用共享 `runOnMain`，因为它在超时/异常时无法把失败传回来（会变成假成功）。
     */
    private fun dispatch(ctx: Context, intent: Intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(ctx.packageManager) == null) {
            throw OpsError("connected_app_unavailable", "没有找到可用的系统时钟应用")
        }
        var failure: Throwable? = null
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try {
                ctx.startActivity(intent)
            } catch (t: Throwable) {
                failure = t
            }
        } else {
            val latch = CountDownLatch(1)
            Handler(Looper.getMainLooper()).post {
                try {
                    ctx.startActivity(intent)
                } catch (t: Throwable) {
                    failure = t
                } finally {
                    latch.countDown()
                }
            }
            if (!latch.await(WAIT_MS, TimeUnit.MILLISECONDS)) {
                throw OpsError("connected_app_bridge_error", "打开系统时钟应用超时")
            }
        }
        val error = failure ?: return
        if (error is SecurityException) {
            throw OpsError("connected_app_permission_denied", "没有权限打开系统时钟应用", "permissions")
        }
        throw OpsError("connected_app_unavailable", "无法打开系统时钟应用（${error.javaClass.simpleName}）")
    }
}
