package com.gozaoo.rein.connectedapps

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 通知监听服务：有界缓存 + 清除（不代发、不回复、不改内容）。
 *
 * - `onNotificationPosted` 跳过自身包、`FLAG_SECURE` 与 group summary，记录
 *   package/appLabel/title/text/postedAt/ongoing/category/key，内存 ring ≤200 条且
 *   ≤256KB；1s 防抖写 `cacheDir/connected_apps/notifications.json`。
 * - `onNotificationRemoved` 只把记录标 `active=false`，保留最近历史，供「最近通知」查询。
 * - 清除只走 `cancelNotification(key)`；ongoing / 不可清除 / 自身包一律跳过，绝不
 *   调用 `cancelAllNotifications`（避免误清系统与 Rein 自己的常驻通知）。
 */
class ReinNotificationListenerService : NotificationListenerService() {

    data class Entry(
        val key: String,
        val packageName: String,
        val appLabel: String,
        val title: String,
        val text: String,
        val postedAt: Long,
        val ongoing: Boolean,
        val clearable: Boolean,
        val category: String?,
        val active: Boolean,
    )

    data class DismissResult(
        val listenerConnected: Boolean,
        val found: Boolean,
        val cleared: Boolean,
        val skipped: Int,
    )

    data class DismissAllResult(
        val listenerConnected: Boolean,
        val cleared: Int,
        val skipped: Int,
    )

    companion object {
        private const val TAG = "ReinNotifListener"
        private const val MAX_RECENT = 200
        private const val MAX_CACHE_BYTES = 256 * 1024
        private const val MAX_FIELD_CHARS = 500
        /**
         * `Notification.FLAG_SECURE` 是系统隐藏常量（1 shl 7），公开 SDK 里没有；
         * 语义与系统一致：带此 flag 的通知内容不得出现在锁屏/外部界面，我们也不缓存。
         */
        private const val FLAG_SECURE = 0x00000080

        private val lock = Any()
        private val recent = ArrayDeque<Entry>()

        @Volatile
        var instance: ReinNotificationListenerService? = null
            private set

        /** 供 NotificationOps 读取的 bounded 快照（按 postedAt 倒序）。 */
        @JvmStatic
        fun recentSnapshot(): List<Entry> = synchronized(lock) { recent.toList() }

        /** 当前系统仍在展示的通知（以 `getActiveNotifications()` 为准）。 */
        @JvmStatic
        fun activeSnapshot(): List<Entry> {
            val service = instance ?: return emptyList()
            val active = try {
                service.activeNotifications ?: return emptyList()
            } catch (t: Throwable) {
                Log.w(TAG, "读取 active notifications 失败", t)
                return emptyList()
            }
            return active.mapNotNull { service.entryFor(it, active = true) }
        }

        /** 清除一条；只清 active、可清除且非自身包的通知。 */
        @JvmStatic
        fun dismiss(key: String): DismissResult {
            val service = instance
                ?: return DismissResult(listenerConnected = false, found = false, cleared = false, skipped = 0)
            val target = try {
                service.activeNotifications.firstOrNull { it.key == key }
            } catch (t: Throwable) {
                Log.w(TAG, "清除前读取 active notifications 失败", t)
                null
            } ?: return DismissResult(listenerConnected = true, found = false, cleared = false, skipped = 0)

            if (!service.canCancel(target)) {
                return DismissResult(listenerConnected = true, found = true, cleared = false, skipped = 1)
            }
            return try {
                service.cancelNotification(key)
                markInactive(key)
                service.schedulePersist()
                DismissResult(listenerConnected = true, found = true, cleared = true, skipped = 0)
            } catch (t: Throwable) {
                Log.w(TAG, "清除通知失败", t)
                DismissResult(listenerConnected = true, found = true, cleared = false, skipped = 1)
            }
        }

        /** 清除全部可清除的通知；逐条 cancel，不用 cancelAllNotifications。 */
        @JvmStatic
        fun dismissAll(): DismissAllResult {
            val service = instance
                ?: return DismissAllResult(listenerConnected = false, cleared = 0, skipped = 0)
            val active = try {
                service.activeNotifications ?: return DismissAllResult(
                    listenerConnected = true,
                    cleared = 0,
                    skipped = 0,
                )
            } catch (t: Throwable) {
                Log.w(TAG, "清除全部前读取 active notifications 失败", t)
                return DismissAllResult(listenerConnected = true, cleared = 0, skipped = 0)
            }

            var cleared = 0
            var skipped = 0
            for (sbn in active) {
                val key = sbn.key ?: continue
                if (!service.canCancel(sbn)) {
                    skipped += 1
                    continue
                }
                try {
                    service.cancelNotification(key)
                    cleared += 1
                    markInactive(key)
                } catch (t: Throwable) {
                    Log.w(TAG, "批量清除单条通知失败", t)
                    skipped += 1
                }
            }
            if (cleared > 0) service.schedulePersist()
            return DismissAllResult(listenerConnected = true, cleared = cleared, skipped = skipped)
        }

        /** 通知使用权被撤销/断开连接时清空内存 ring 与磁盘缓存。 */
        @JvmStatic
        fun clearCache(ctx: Context) {
            synchronized(lock) { recent.clear() }
            instance?.let { service ->
                service.mainHandler.removeCallbacks(service.persistRunnable)
            }
            try {
                cacheFile(ctx).delete()
            } catch (t: Throwable) {
                Log.w(TAG, "清空通知缓存失败", t)
            }
        }

        /** 通知使用权已开但服务还没被绑定时，主动请求系统重新绑定。 */
        @JvmStatic
        fun requestRebindIfNeeded(ctx: Context) {
            if (instance != null) return
            try {
                NotificationListenerService.requestRebind(
                    ComponentName(ctx, ReinNotificationListenerService::class.java),
                )
            } catch (t: Throwable) {
                Log.w(TAG, "requestRebind 失败", t)
            }
        }

        private fun markInactive(key: String) {
            synchronized(lock) {
                val index = recent.indexOfFirst { it.key == key }
                if (index >= 0) {
                    val entry = recent[index]
                    if (entry.active) recent[index] = entry.copy(active = false)
                }
            }
        }

        private fun cacheFile(ctx: Context): File =
            File(File(ctx.applicationContext.cacheDir, "connected_apps"), "notifications.json")
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val persistRunnable = Runnable { persistNow() }
    @Volatile
    private var cacheLoaded = false

    override fun onCreate() {
        super.onCreate()
        loadCache()
    }

    override fun onListenerConnected() {
        instance = this
        loadCache()
        Log.i(TAG, "notification listener connected")
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
        mainHandler.removeCallbacks(persistRunnable)
        persistNow(blocking = true)
        Log.i(TAG, "notification listener disconnected")
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(persistRunnable)
        persistNow(blocking = true)
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val entry = entryFor(sbn ?: return, active = true) ?: return
        synchronized(lock) {
            recent.removeAll { it.key == entry.key }
            recent.addFirst(entry)
            trimLocked()
        }
        schedulePersist()
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        val key = sbn?.key ?: return
        markInactive(key)
        schedulePersist()
    }

    /* ---------------- 缓存 ---------------- */

    private fun entryFor(sbn: StatusBarNotification, active: Boolean): Entry? {
        if (sbn.packageName == packageName) return null
        val notification = sbn.notification ?: return null
        val flags = notification.flags
        // FLAG_SECURE：内容不允许出现在锁屏/外部界面，缓存也不碰。
        if (flags and FLAG_SECURE != 0) return null
        // group summary 只有聚合信息，重复且噪音大；子通知才是用户看到的内容。
        if (flags and Notification.FLAG_GROUP_SUMMARY != 0) return null

        val key = sbn.key ?: return null
        val extras = notification.extras
        val title = Json.truncate(extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(), MAX_FIELD_CHARS)
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        val bodyText = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        val subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()
        val text = Json.truncate(
            listOf(bodyText, bigText, subText).firstOrNull { !it.isNullOrBlank() },
            MAX_FIELD_CHARS,
        )
        val pkg = sbn.packageName ?: return null
        return Entry(
            key = key,
            packageName = pkg,
            appLabel = appLabel(pkg),
            title = title,
            text = text,
            postedAt = sbn.postTime.coerceAtLeast(0L),
            ongoing = sbn.isOngoing || (flags and Notification.FLAG_ONGOING_EVENT != 0),
            clearable = sbn.isClearable,
            category = notification.category,
            active = active,
        )
    }

    private fun canCancel(sbn: StatusBarNotification): Boolean {
        if (sbn.packageName == packageName) return false
        if (sbn.isOngoing) return false
        if (!sbn.isClearable) return false
        return true
    }

    private fun appLabel(pkg: String): String = try {
        val info = packageManager.getApplicationInfo(pkg, 0)
        packageManager.getApplicationLabel(info).toString().ifBlank { pkg }
    } catch (_: Throwable) {
        pkg
    }

    private fun trimLocked() {
        while (recent.size > MAX_RECENT) recent.removeLast()
        while (recent.size > 1 && approximateBytesLocked() > MAX_CACHE_BYTES) recent.removeLast()
    }

    private fun approximateBytesLocked(): Int {
        var total = 0
        for (entry in recent) {
            total += entry.key.toByteArray(Charsets.UTF_8).size +
                entry.packageName.toByteArray(Charsets.UTF_8).size +
                entry.appLabel.toByteArray(Charsets.UTF_8).size +
                entry.title.toByteArray(Charsets.UTF_8).size +
                entry.text.toByteArray(Charsets.UTF_8).size +
                (entry.category?.toByteArray(Charsets.UTF_8)?.size ?: 0) + 48
            if (total > MAX_CACHE_BYTES) break
        }
        return total
    }

    private fun loadCache() {
        if (cacheLoaded) return
        cacheLoaded = true
        val text = try {
            cacheFile(applicationContext).readText()
        } catch (_: Throwable) {
            return
        }
        val items = try {
            JSONObject(text).optJSONArray("items")
        } catch (_: Throwable) {
            null
        } ?: return
        val loaded = ArrayList<Entry>()
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            val key = item.optString("key", "")
            if (key.isBlank()) continue
            loaded.add(
                Entry(
                    key = key,
                    packageName = item.optString("packageName", ""),
                    appLabel = item.optString("appLabel", ""),
                    title = Json.truncate(item.optString("title", ""), MAX_FIELD_CHARS),
                    text = Json.truncate(item.optString("text", ""), MAX_FIELD_CHARS),
                    postedAt = item.optLong("postedAt", 0L),
                    ongoing = item.optBoolean("ongoing", false),
                    clearable = item.optBoolean("clearable", true),
                    category = item.optString("category", "").ifBlank { null },
                    active = false,
                ),
            )
        }
        loaded.sortByDescending { it.postedAt }
        synchronized(lock) {
            recent.clear()
            for (entry in loaded.take(MAX_RECENT)) recent.addLast(entry)
            trimLocked()
        }
    }

    private fun schedulePersist() {
        mainHandler.removeCallbacks(persistRunnable)
        mainHandler.postDelayed(persistRunnable, 1000L)
    }

    private fun persistNow(blocking: Boolean = false) {
        val items = synchronized(lock) { recent.toList() }
        val array = JSONArray()
        for (entry in items) {
            array.put(
                JSONObject()
                    .put("key", entry.key)
                    .put("packageName", entry.packageName)
                    .put("appLabel", entry.appLabel)
                    .put("title", entry.title)
                    .put("text", entry.text)
                    .put("postedAt", entry.postedAt)
                    .put("ongoing", entry.ongoing)
                    .put("clearable", entry.clearable)
                    .put("category", entry.category ?: JSONObject.NULL)
                    .put("active", entry.active),
            )
        }
        val root = JSONObject()
            .put("updatedAt", Json.isoNow())
            .put("items", array)
        val file = cacheFile(applicationContext)
        val write = Runnable {
            try {
                Json.writeAtomic(file, root)
            } catch (t: Throwable) {
                Log.w(TAG, "通知缓存写入失败", t)
            }
        }
        if (blocking) write.run() else Thread(write, "rein-notif-cache").start()
    }
}
