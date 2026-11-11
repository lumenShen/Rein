package com.gozaoo.rein.connectedapps

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * 安卓使用时间（只读）。
 *
 * 系统没有写接口：这里只有 `get_app_usage`（汇总 / 单包）与 `get_usage_events`。
 * - 权限判定走 `AppOpsManager.checkOpNoThrow(OPSTR_GET_USAGE_STATS)`（API 29+ 用
 *   `unsafeCheckOpNoThrow`），再用一次真实查询兜底：部分 OEM 的 appop 与实际可查询
 *   状态不一致，只信 appop 会误报「已开启但读不到」。
 * - 查询在 Bridge 的 IO 线程上执行，不碰主线程。
 * - 汇总口径：`since_hours` 1..744（缺省按 `days` 1..31 换算，默认 7 天）、
 *   `limit` 1..50；按包聚合 `totalTimeInForeground`，按前台时长倒序。
 * - 单包模式：payload 带 `package`/`packageName` 时只返回该包（不要求它出现在前
 *   `limit` 名里）；查不到时返回 `found:false`，不把「系统不给数据」误报成错误。
 */
internal object UsageOps : ConnectedAppOps {
    private const val MAX_SINCE_HOURS = 31L * 24L
    private const val MAX_DAYS = 31
    private const val MAX_SUMMARY_LIMIT = 50
    private const val MAX_EVENT_DAYS = 7
    private const val MAX_EVENT_LIMIT = 200

    private val CAPABILITIES = listOf("get_app_usage", "get_usage_events")

    private val PERMISSIONS = listOf(
        OpsPermission("usage_access"),
    )

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        val manager = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
        val available = manager != null
        val granted = available && hasUsageAccess(ctx) && canQuery(ctx)
        val permissions = JSONArray().put(
            JSONObject()
                .put("key", "usage_access")
                .put("granted", granted),
        )
        val detail = when {
            !available -> "系统没有 UsageStatsManager（设备不支持使用时间统计）"
            !granted -> "使用情况访问权限未开启，点「去授权」后在系统设置里允许 Rein"
            else -> null
        }
        return baseStatus(
            permissions = permissions,
            capabilities = JSONArray(CAPABILITIES),
            supported = true,
            available = available,
            detail = detail,
        )
    }

    override fun request(ctx: Context, mode: String): JSONObject {
        // Bridge 对 usage_access 有统一入口；这里只作为直接调用时的兜底。
        return if (mode == "usage_access") {
            try {
                val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.applicationContext.startActivity(intent)
                JSONObject().put("opened", true)
            } catch (t: Throwable) {
                JSONObject()
                    .put("opened", false)
                    .put("reason", "无法打开使用情况访问设置页：${t.javaClass.simpleName}")
            }
        } else {
            JSONObject()
                .put("opened", false)
                .put("reason", "使用时间只支持 usage_access 授权模式")
        }
    }

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject {
        if (!hasUsageAccess(ctx) || !canQuery(ctx)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少使用情况访问权限，请到「连接应用 → 安卓使用时间」开启",
                "usage_access",
            )
        }
        return when (method) {
            "get_app_usage" -> getAppUsage(ctx, payload)
            "get_usage_events" -> getUsageEvents(ctx, payload)
            // 直接调用时的语义别名（Rust allowlist 只认上面两个方法名）。
            "summary" -> getAppUsage(ctx, payload, forceSummary = true)
            "app" -> getAppUsage(ctx, payload, forceSummary = false)
            else -> throw OpsError(
                "connected_app_unknown_method",
                "使用时间不支持方法 $method",
            )
        }
    }

    /* ---------------- 使用时长 ---------------- */

    private fun getAppUsage(
        ctx: Context,
        payload: JSONObject,
        forceSummary: Boolean? = null,
    ): JSONObject {
        val packageName = packageFilter(payload)
        val summary = forceSummary ?: packageName.isNullOrBlank()
        val sinceHours = sinceHours(payload)
        val end = System.currentTimeMillis()
        val start = end - sinceHours * 60L * 60L * 1000L
        val manager = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: throw OpsError("connected_app_unavailable", "设备不支持使用时间统计")

        val stats = try {
            manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end).orEmpty()
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少使用情况访问权限，请到「连接应用 → 安卓使用时间」开启",
                "usage_access",
            )
        }

        val aggregated = LinkedHashMap<String, Aggregate>()
        for (stat in stats) {
            val pkg = stat.packageName ?: continue
            if (pkg.isBlank() || pkg == ctx.packageName) continue
            val total = stat.totalTimeInForeground.coerceAtLeast(0L)
            val last = stat.lastTimeUsed.coerceAtLeast(0L)
            if (total == 0L && last == 0L) continue
            val current = aggregated[pkg]
            if (current == null) {
                aggregated[pkg] = Aggregate(pkg, total, last)
            } else {
                current.totalMs += total
                if (last > current.lastUsedMs) current.lastUsedMs = last
            }
        }

        val sorted = aggregated.values.sortedByDescending { it.totalMs }
        val totalForegroundMs = sorted.sumOf { it.totalMs }
        val labels = HashMap<String, String>()
        fun label(pkg: String): String = labels.getOrPut(pkg) { appLabel(ctx, pkg) }

        if (!summary) {
            val requested = packageName ?: throw OpsError(
                "connected_app_bad_request",
                "单包查询缺少 package",
            )
            val target = aggregated[requested]
            return Json.ok(
                JSONObject()
                    .put("packageName", requested)
                    .put("appLabel", label(requested))
                    .put("found", target != null)
                    .put("sinceHours", sinceHours)
                    .put("since", isoTime(start))
                    .put("totalTimeInForegroundMs", target?.totalMs ?: 0L)
                    .put(
                        "lastTimeUsed",
                        target?.lastUsedMs?.takeIf { it > 0L }?.let { isoTime(it) }
                            ?: JSONObject.NULL,
                    ),
            )
        }

        val limit = clamp(payload.optInt("limit", 20), 1, MAX_SUMMARY_LIMIT)
        val apps = JSONArray()
        for (item in sorted.take(limit)) {
            apps.put(
                JSONObject()
                    .put("packageName", item.packageName)
                    .put("appLabel", label(item.packageName))
                    .put("totalTimeInForegroundMs", item.totalMs)
                    .put(
                        "lastTimeUsed",
                        item.lastUsedMs.takeIf { it > 0L }?.let { isoTime(it) }
                            ?: JSONObject.NULL,
                    ),
            )
        }
        return Json.ok(
            JSONObject()
                .put("sinceHours", sinceHours)
                .put("since", isoTime(start))
                .put("approx", true)
                .put("totalTimeInForegroundMs", totalForegroundMs)
                .put("apps", apps)
                .put("count", apps.length())
                .put("truncated", sorted.size > apps.length()),
        )
    }

    /* ---------------- 使用事件 ---------------- */

    private fun getUsageEvents(ctx: Context, payload: JSONObject): JSONObject {
        val days = clamp(payload.optInt("days", 1), 1, MAX_EVENT_DAYS)
        val limit = clamp(payload.optInt("limit", 100), 1, MAX_EVENT_LIMIT)
        val end = System.currentTimeMillis()
        val start = end - days * 24L * 60L * 60L * 1000L
        val manager = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: throw OpsError("connected_app_unavailable", "设备不支持使用时间统计")

        val events = ArrayList<EventItem>()
        val labels = HashMap<String, String>()
        try {
            val cursor = manager.queryEvents(start, end)
                ?: throw OpsError("connected_app_native_error", "系统没有返回使用事件")
            val event = UsageEvents.Event()
            while (cursor.hasNextEvent()) {
                if (!cursor.getNextEvent(event)) continue
                val type = eventTypeName(event.eventType) ?: continue
                val pkg = event.packageName ?: continue
                if (pkg.isBlank() || pkg == ctx.packageName) continue
                val label = labels.getOrPut(pkg) { appLabel(ctx, pkg) }
                events.add(EventItem(pkg, label, type, event.timeStamp))
            }
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少使用情况访问权限，请到「连接应用 → 安卓使用时间」开启",
                "usage_access",
            )
        }

        events.sortByDescending { it.atMs }
        val items = JSONArray()
        for (item in events.take(limit)) {
            items.put(
                JSONObject()
                    .put("packageName", item.packageName)
                    .put("appLabel", item.appLabel)
                    .put("type", item.type)
                    .put("at", isoTime(item.atMs)),
            )
        }
        return Json.ok(
            JSONObject()
                .put("days", days)
                .put("since", isoTime(start))
                .put("events", items)
                .put("count", items.length())
                .put("truncated", events.size > items.length()),
        )
    }

    /* ---------------- 小工具 ---------------- */

    private data class Aggregate(val packageName: String, var totalMs: Long, var lastUsedMs: Long)
    private data class EventItem(
        val packageName: String,
        val appLabel: String,
        val type: String,
        val atMs: Long,
    )

    private fun packageFilter(payload: JSONObject): String? {
        val raw = when {
            payload.has("package") -> payload.optString("package", "")
            payload.has("packageName") -> payload.optString("packageName", "")
            else -> ""
        }.trim()
        if (raw.isEmpty()) return null
        if (raw.length > 128) {
            throw OpsError("connected_app_bad_request", "package 过长（最多 128 个字符）")
        }
        return raw
    }

    /** 缺省 7 天；`since_hours` 优先，`days` 会在 1..31 内收口后换算成小时。 */
    private fun sinceHours(payload: JSONObject): Long {
        val explicit = if (payload.has("since_hours")) {
            payload.optLong("since_hours", 24L)
        } else {
            clamp(payload.optInt("days", 7), 1, MAX_DAYS) * 24L
        }
        return clamp(explicit, 1L, MAX_SINCE_HOURS)
    }

    /** 使用情况访问：appop 是系统真源。 */
    private fun hasUsageAccess(ctx: Context): Boolean {
        val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
        return try {
            val mode = if (Build.VERSION.SDK_INT >= 29) {
                appOps.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    ctx.packageName,
                )
            } else {
                @Suppress("DEPRECATION")
                appOps.checkOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    ctx.packageName,
                )
            }
            mode == AppOpsManager.MODE_ALLOWED
        } catch (_: Throwable) {
            false
        }
    }

    /** 「普通权限自检」：真查一次，拦住 appop 说 allowed、查询却 SecurityException 的 ROM。 */
    private fun canQuery(ctx: Context): Boolean {
        val manager = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return false
        return try {
            val end = System.currentTimeMillis()
            manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, end - 60_000L, end)
            true
        } catch (_: Throwable) {
            false
        }
    }

    private fun appLabel(ctx: Context, packageName: String): String = try {
        val info = ctx.packageManager.getApplicationInfo(packageName, 0)
        ctx.packageManager.getApplicationLabel(info).toString().ifBlank { packageName }
    } catch (_: Throwable) {
        packageName
    }

    /** 事件类型 1/2 在各版本稳定：29+ 是 RESUMED/PAUSED，旧系统是前后台切换。 */
    private fun eventTypeName(type: Int): String? = when (type) {
        1 -> if (Build.VERSION.SDK_INT >= 29) "ACTIVITY_RESUMED" else "MOVE_TO_FOREGROUND"
        2 -> if (Build.VERSION.SDK_INT >= 29) "ACTIVITY_PAUSED" else "MOVE_TO_BACKGROUND"
        else -> null
    }

    private fun clamp(value: Int, min: Int, max: Int): Int = value.coerceIn(min, max)

    private fun clamp(value: Long, min: Long, max: Long): Long = value.coerceIn(min, max)

    private fun isoTime(millis: Long): String = Instant.ofEpochMilli(millis).toString()
}
