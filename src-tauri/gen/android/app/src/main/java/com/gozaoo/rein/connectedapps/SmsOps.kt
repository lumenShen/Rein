package com.gozaoo.rein.connectedapps

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Telephony
import android.telephony.PhoneNumberUtils
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * 短信（Android Telephony.Sms + SmsManager）。
 *
 * 读写口径（plan §1.2 / §13.1 / §13.2）：
 * - 读：`list_sms_threads`（≤50）、`list_sms_messages`（threadId/address 至少一个，≤100，body ≤500）、
 *   `search_sms`（正文/号码匹配，≤50），需要 READ_SMS；
 * - 写：`send_sms`（单收件人、body 1..2000），需要 SEND_SMS；返回 `submitted + parts`，不承诺送达；
 * - **不做**标记已读、删除会话、MMS、SIM 选择、送达回执。
 */
internal object SmsOps : ConnectedAppOps {
    private const val TELEPHONY_AUTHORITY = "sms"
    private const val MAX_THREADS = 50
    private const val MAX_MESSAGES = 100
    private const val MAX_SEARCH = 50
    private const val MAX_QUERY = 64
    private const val MAX_ADDRESS = 40
    private const val MAX_BODY_SEND = 2_000
    private const val MAX_BODY_LIST = 500
    private const val MAX_SNIPPET = 200

    private val READ_CAPABILITIES = listOf("list_sms_threads", "list_sms_messages", "search_sms")
    private val WRITE_CAPABILITIES = listOf("send_sms")

    private val PERMISSIONS = listOf(
        OpsPermission("read_sms"),
        OpsPermission("send_sms", write = true, required = false),
    )

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        val telephony = ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
        val provider = ctx.packageManager.resolveContentProvider(TELEPHONY_AUTHORITY, 0) != null
        val read = PermissionMap.hasPermission(ctx, Manifest.permission.READ_SMS)
        val write = PermissionMap.hasPermission(ctx, Manifest.permission.SEND_SMS)
        val permissions = JSONArray()
            .put(JSONObject().put("key", "read_sms").put("granted", read))
            .put(JSONObject().put("key", "send_sms").put("granted", write))
        val capabilities = ArrayList<String>(4)
        capabilities.addAll(READ_CAPABILITIES)
        if (write) capabilities.addAll(WRITE_CAPABILITIES)
        val detail = when {
            !telephony -> "设备没有短信硬件"
            !provider -> "没有找到短信数据库"
            else -> null
        }
        return baseStatus(
            permissions = permissions,
            capabilities = JSONArray(capabilities),
            supported = true,
            available = telephony && provider,
            detail = detail,
        )
    }

    override fun request(ctx: Context, mode: String): JSONObject = JSONObject()
        .put("opened", false)
        .put("reason", "短信权限由系统的运行时权限弹窗授予，请在 Rein 界面点「去授权」")

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject = when (method) {
        "list_sms_threads" -> {
            requireRead(ctx)
            listThreads(ctx, payload)
        }
        "list_sms_messages" -> {
            requireRead(ctx)
            listMessages(ctx, payload)
        }
        "search_sms" -> {
            requireRead(ctx)
            searchMessages(ctx, payload)
        }
        "send_sms" -> {
            requireSend(ctx)
            sendSms(ctx, payload)
        }
        else -> throw OpsError("connected_app_unknown_method", "短信不支持方法 $method")
    }

    /* ---------------- 权限 ---------------- */

    private fun requireRead(ctx: Context) {
        if (!PermissionMap.hasPermission(ctx, Manifest.permission.READ_SMS)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少短信读取权限（READ_SMS）",
                "permissions",
            )
        }
    }

    private fun requireSend(ctx: Context) {
        if (!PermissionMap.hasPermission(ctx, Manifest.permission.SEND_SMS)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少短信发送权限（SEND_SMS）",
                "permissions_write",
            )
        }
    }

    /* ---------------- 读 ---------------- */

    private fun listThreads(ctx: Context, payload: JSONObject): JSONObject {
        val limit = payload.optInt("limit", 20).coerceIn(1, MAX_THREADS)
        val items = JSONArray()
        val seen = HashSet<Long>()
        ctx.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf(
                Telephony.Sms.THREAD_ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.DATE,
                Telephony.Sms.BODY,
            ),
            null,
            null,
            "${Telephony.Sms.DATE} DESC",
        )?.use { c ->
            while (items.length() < limit && c.moveToNext()) {
                val threadId = c.getLong(0)
                if (!seen.add(threadId)) continue
                items.put(
                    JSONObject()
                        .put("threadId", threadId.toString())
                        .put("address", c.getString(1) ?: "")
                        .put("snippet", Json.truncate(c.getString(3), MAX_SNIPPET))
                        .put("at", isoOrNull(c.getLong(2))),
                )
            }
        }
        return JSONObject().put("items", items).put("count", items.length())
    }

    private fun listMessages(ctx: Context, payload: JSONObject): JSONObject {
        val threadId = payload.optString("threadId", "").trim()
        val address = payload.optString("address", "").trim()
        if (threadId.isEmpty() && address.isEmpty()) {
            throw OpsError("connected_app_bad_request", "threadId 或 address 至少提供一个")
        }
        val limit = payload.optInt("limit", 30).coerceIn(1, MAX_MESSAGES)
        val clauses = ArrayList<String>()
        val args = ArrayList<String>()
        if (threadId.isNotEmpty()) {
            if (threadId.toLongOrNull() == null) {
                throw OpsError("connected_app_bad_request", "threadId 必须是数字")
            }
            clauses.add("${Telephony.Sms.THREAD_ID}=?")
            args.add(threadId)
        }
        if (address.isNotEmpty()) {
            if (address.length > MAX_ADDRESS) {
                throw OpsError("connected_app_bad_request", "address 不能超过 $MAX_ADDRESS 字")
            }
            clauses.add("${Telephony.Sms.ADDRESS}=?")
            args.add(address)
        }
        // 只返回收件箱/已发送；不碰草稿/失败/队列，也不改已读。
        clauses.add("${Telephony.Sms.TYPE} IN (${Telephony.Sms.MESSAGE_TYPE_INBOX}, ${Telephony.Sms.MESSAGE_TYPE_SENT})")

        val items = JSONArray()
        ctx.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.THREAD_ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.TYPE,
                Telephony.Sms.DATE,
            ),
            clauses.joinToString(" AND "),
            args.toTypedArray(),
            "${Telephony.Sms.DATE} DESC",
        )?.use { c ->
            while (items.length() < limit && c.moveToNext()) {
                items.put(messageJson(c))
            }
        }
        return JSONObject().put("items", items).put("count", items.length())
    }

    private fun searchMessages(ctx: Context, payload: JSONObject): JSONObject {
        val query = payload.optString("query", "").trim()
        if (query.isEmpty() || query.length > MAX_QUERY) {
            throw OpsError("connected_app_bad_request", "query 必填且不能超过 $MAX_QUERY 字")
        }
        val limit = payload.optInt("limit", 20).coerceIn(1, MAX_SEARCH)
        val like = "%${escapeLike(query)}%"
        val items = JSONArray()
        ctx.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.THREAD_ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.TYPE,
                Telephony.Sms.DATE,
            ),
            "(${Telephony.Sms.BODY} LIKE ? ESCAPE '\\' OR " +
                "${Telephony.Sms.ADDRESS} LIKE ? ESCAPE '\\')",
            arrayOf(like, like),
            "${Telephony.Sms.DATE} DESC",
        )?.use { c ->
            while (items.length() < limit && c.moveToNext()) {
                items.put(messageJson(c))
            }
        }
        return JSONObject().put("items", items).put("count", items.length())
    }

    private fun messageJson(c: android.database.Cursor): JSONObject = JSONObject()
        .put("id", c.getLong(0).toString())
        .put("threadId", c.getLong(1).toString())
        .put("address", c.getString(2) ?: "")
        .put("body", Json.truncate(c.getString(3), MAX_BODY_LIST))
        .put("type", if (c.getInt(4) == Telephony.Sms.MESSAGE_TYPE_SENT) "sent" else "inbox")
        .put("at", isoOrNull(c.getLong(5)))

    /* ---------------- 写 ---------------- */

    @Suppress("DEPRECATION")
    private fun sendSms(ctx: Context, payload: JSONObject): JSONObject {
        val to = payload.optString("to", "").trim()
        if (to.isEmpty() || to.length > MAX_ADDRESS || to.contains(',') || to.contains(';')) {
            throw OpsError(
                "connected_app_bad_request",
                "to 必填、单个收件人且不能超过 $MAX_ADDRESS 字",
            )
        }
        if (!PhoneNumberUtils.isGlobalPhoneNumber(to)) {
            throw OpsError("connected_app_bad_request", "收件人号码格式不正确：$to")
        }
        val body = payload.optString("body", "")
        if (body.isEmpty() || body.length > MAX_BODY_SEND) {
            throw OpsError("connected_app_bad_request", "body 必填且不能超过 $MAX_BODY_SEND 字")
        }
        if (!ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) {
            throw OpsError("connected_app_unavailable", "设备没有短信硬件")
        }

        val manager = ctx.getSystemService(SmsManager::class.java)
            ?: SmsManager.getDefault()
        val parts = manager.divideMessage(body)
        try {
            manager.sendMultipartTextMessage(to, null, parts, null, null)
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少短信发送权限（SEND_SMS）",
                "permissions_write",
            )
        } catch (e: IllegalArgumentException) {
            throw OpsError("connected_app_bad_request", "短信内容或号码不被系统接受")
        }
        return JSONObject()
            .put("submitted", true)
            .put("parts", parts.size)
            .put("to", to)
    }

    /* ---------------- 小工具 ---------------- */

    private fun isoOrNull(millis: Long): Any =
        if (millis > 0) Instant.ofEpochMilli(millis).toString() else JSONObject.NULL

    private fun escapeLike(value: String): String = value
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
}
