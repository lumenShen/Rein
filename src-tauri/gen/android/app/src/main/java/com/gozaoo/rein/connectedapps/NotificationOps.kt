package com.gozaoo.rein.connectedapps

import android.content.Context
import android.content.Intent
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * 通知读取 / 清除。
 *
 * - 读：`getActiveNotifications()`（当前还在的通知）+ `ReinNotificationListenerService`
 *   的有界缓存（最近历史），按 postedAt 倒序；`app` 支持包名/应用名子串过滤，
 *   `since` 支持 ISO 时间或毫秒时间戳；limit ≤50。
 * - 写：只提供 `dismiss_notification` / `dismiss_all_notifications`，逐条
 *   `cancelNotification(key)`；ongoing / 不可清除 / 自身包跳过并返回 `skipped`。
 *   不代发、不回复、不修改通知内容。
 */
internal object NotificationOps : ConnectedAppOps {
    private const val MAX_LIST_LIMIT = 50
    private const val MAX_KEY_CHARS = 256
    private const val MAX_FILTER_CHARS = 128
    private const val MAX_QUERY_CHARS = 64

    private val CAPABILITIES = listOf(
        "list_recent_notifications",
        "dismiss_notification",
        "dismiss_all_notifications",
    )

    private val PERMISSIONS = listOf(
        OpsPermission("notification_access"),
        OpsPermission("notification_dismiss", write = true, required = false),
    )

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        val granted = PermissionMap.hasNotificationAccess(ctx)
        if (granted) {
            ReinNotificationListenerService.requestRebindIfNeeded(ctx)
        } else {
            // 权限被撤销 / 从未授予：内存与 notifications.json 都不应继续留着旧内容。
            ReinNotificationListenerService.clearCache(ctx)
        }
        val bound = ReinNotificationListenerService.instance != null
        val permissions = JSONArray()
            .put(JSONObject().put("key", "notification_access").put("granted", granted))
            .put(JSONObject().put("key", "notification_dismiss").put("granted", granted))
        val detail = when {
            !granted -> "通知使用权未开启，点「去授权」后在系统列表里允许 Rein"
            !bound -> "通知使用权已开启，等待系统绑定监听服务（可点重新检测）"
            else -> null
        }
        return baseStatus(
            permissions = permissions,
            capabilities = JSONArray(CAPABILITIES),
            supported = true,
            available = true,
            detail = detail,
        )
    }

    override fun request(ctx: Context, mode: String): JSONObject {
        // Bridge 对 notification_access 有统一入口；这里只作为直接调用时的兜底。
        if (mode != "notification_access") {
            return JSONObject()
                .put("opened", false)
                .put("reason", "通知只支持 notification_access 授权模式")
        }
        return try {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.applicationContext.startActivity(intent)
            JSONObject().put("opened", true)
        } catch (t: Throwable) {
            JSONObject()
                .put("opened", false)
                .put("reason", "无法打开通知使用权设置页：${t.javaClass.simpleName}")
        }
    }

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject {
        if (!PermissionMap.hasNotificationAccess(ctx)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少通知使用权，请到「连接应用 → 通知」开启",
                "notification_access",
            )
        }
        return when (method) {
            "list_recent_notifications", "recent", "search" -> listRecent(ctx, payload)
            "dismiss_notification", "dismiss" -> dismiss(payload)
            "dismiss_all_notifications", "dismiss_all" -> dismissAll()
            else -> throw OpsError(
                "connected_app_unknown_method",
                "通知不支持方法 $method",
            )
        }
    }

    /* ---------------- 读 ---------------- */

    private fun listRecent(ctx: Context, payload: JSONObject): JSONObject {
        val limit = payload.optInt("limit", 20).coerceIn(1, MAX_LIST_LIMIT)
        val filter = filterText(payload)
        val query = queryText(payload)
        val since = parseSince(payload)
        ensureListener(ctx)

        val merged = LinkedHashMap<String, ReinNotificationListenerService.Entry>()
        for (entry in ReinNotificationListenerService.recentSnapshot()) {
            merged[entry.key] = entry
        }
        // 以系统当前 active 列表为准覆盖缓存（内容可能已更新）。
        for (entry in ReinNotificationListenerService.activeSnapshot()) {
            merged[entry.key] = entry
        }

        val matched = merged.values
            .asSequence()
            .filter { since <= 0L || it.postedAt >= since }
            .filter { entry ->
                filter == null ||
                    entry.packageName.contains(filter, ignoreCase = true) ||
                    entry.appLabel.contains(filter, ignoreCase = true) ||
                    // `app` 是既有工具唯一暴露的过滤参数；同时匹配标题/正文，
                    // 这样「查找张三的通知」也能命中，而不必新增一个 schema 参数。
                    entry.title.contains(filter, ignoreCase = true) ||
                    entry.text.contains(filter, ignoreCase = true)
            }
            .filter { entry ->
                query.isEmpty() ||
                    entry.title.contains(query, ignoreCase = true) ||
                    entry.text.contains(query, ignoreCase = true) ||
                    entry.appLabel.contains(query, ignoreCase = true) ||
                    entry.packageName.contains(query, ignoreCase = true)
            }
            .sortedByDescending { it.postedAt }
            .toList()

        val items = JSONArray()
        for (entry in matched.take(limit)) {
            items.put(
                JSONObject()
                    .put("key", entry.key)
                    .put("packageName", entry.packageName)
                    .put("appLabel", entry.appLabel)
                    .put("title", entry.title)
                    .put("text", entry.text)
                    .put("postedAt", isoTime(entry.postedAt))
                    .put("ongoing", entry.ongoing)
                    .put("clearable", entry.clearable)
                    .put("category", entry.category ?: JSONObject.NULL)
                    .put("active", entry.active),
            )
        }
        return Json.ok(
            JSONObject()
                .put("items", items)
                .put("count", items.length())
                .put("truncated", matched.size > items.length()),
        )
    }

    /* ---------------- 写（只清除） ---------------- */

    private fun dismiss(payload: JSONObject): JSONObject {
        val key = payload.optString("key", "").trim()
        if (key.isEmpty() || key.length > MAX_KEY_CHARS) {
            throw OpsError(
                "connected_app_bad_request",
                "key 必须为 1..$MAX_KEY_CHARS 个字符，且来自 list_recent_notifications",
            )
        }
        val result = ReinNotificationListenerService.dismiss(key)
        if (!result.listenerConnected) {
            throw OpsError(
                "connected_app_listener_not_connected",
                "通知监听服务尚未连接，请确认通知使用权已开启后重新检测",
                "notification_access",
            )
        }
        if (!result.found) {
            throw OpsError("connected_app_not_found", "通知不存在或已被清除")
        }
        return Json.ok(
            JSONObject()
                .put("cleared", result.cleared)
                .put("skipped", result.skipped),
        )
    }

    private fun dismissAll(): JSONObject {
        val result = ReinNotificationListenerService.dismissAll()
        if (!result.listenerConnected) {
            throw OpsError(
                "connected_app_listener_not_connected",
                "通知监听服务尚未连接，请确认通知使用权已开启后重新检测",
                "notification_access",
            )
        }
        return Json.ok(
            JSONObject()
                .put("cleared", result.cleared)
                .put("skipped", result.skipped),
        )
    }

    /* ---------------- 小工具 ---------------- */

    private fun ensureListener(ctx: Context) {
        if (ReinNotificationListenerService.instance != null) return
        ReinNotificationListenerService.requestRebindIfNeeded(ctx)
        if (ReinNotificationListenerService.instance == null) {
            throw OpsError(
                "connected_app_listener_not_connected",
                "通知监听服务尚未连接，请确认通知使用权已开启后重新检测",
                "notification_access",
            )
        }
    }

    private fun filterText(payload: JSONObject): String? {
        val raw = when {
            payload.has("app") -> payload.optString("app", "")
            payload.has("package") -> payload.optString("package", "")
            payload.has("packageName") -> payload.optString("packageName", "")
            else -> ""
        }.trim()
        if (raw.isEmpty()) return null
        if (raw.length > MAX_FILTER_CHARS) {
            throw OpsError(
                "connected_app_bad_request",
                "app 过滤条件过长（最多 $MAX_FILTER_CHARS 个字符）",
            )
        }
        return raw
    }

    private fun queryText(payload: JSONObject): String {
        val raw = payload.optString("query", "").trim()
        if (raw.length > MAX_QUERY_CHARS) {
            throw OpsError(
                "connected_app_bad_request",
                "query 最多 $MAX_QUERY_CHARS 个字符",
            )
        }
        return raw
    }

    /** `since` 支持 ISO-8601（带 Z/偏移/本地时间）或毫秒时间戳；缺省 0。 */
    private fun parseSince(payload: JSONObject): Long {
        if (!payload.has("since") || payload.isNull("since")) return 0L
        val raw = payload.opt("since")
        val millis = when (raw) {
            is Number -> raw.toLong()
            is String -> parseIso(raw)
            else -> throw OpsError(
                "connected_app_bad_request",
                "since 必须是 ISO 时间字符串或毫秒时间戳",
            )
        }
        if (millis < 0L) {
            throw OpsError("connected_app_bad_request", "since 不能为负数")
        }
        return millis
    }

    private fun parseIso(raw: String): Long {
        val text = raw.trim()
        if (text.isEmpty()) return 0L
        try {
            return Instant.parse(text).toEpochMilli()
        } catch (_: Throwable) {
            // 继续尝试带偏移的 ISO。
        }
        try {
            return OffsetDateTime.parse(text).toInstant().toEpochMilli()
        } catch (_: Throwable) {
            // 继续尝试不带时区的本地时间。
        }
        try {
            return LocalDateTime.parse(text)
                .atZone(ZoneId.systemDefault())
                .toInstant()
                .toEpochMilli()
        } catch (_: Throwable) {
            throw OpsError(
                "connected_app_bad_request",
                "since 不是合法的 ISO 时间：$text",
            )
        }
    }

    private fun isoTime(millis: Long): String =
        if (millis <= 0L) "" else Instant.ofEpochMilli(millis).toString()
}
