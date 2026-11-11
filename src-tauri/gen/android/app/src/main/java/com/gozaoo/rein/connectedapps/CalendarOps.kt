package com.gozaoo.rein.connectedapps

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeParseException
import java.util.TimeZone

/**
 * 日历（Android CalendarContract）。
 *
 * 读写口径（plan §1.2 / §13.1）：
 * - 读：`list_calendars` / `list_calendar_events` / `get_calendar_event`，需要 READ_CALENDAR；
 * - 写：`create/update/delete_calendar_event`，需要 WRITE_CALENDAR + READ_CALENDAR；
 * - 列表上限 200、范围 ≤366 天；单次日程时长 ≤30 天；标题 ≤200、地点 ≤200、描述 ≤2000；
 * - 重复日程的修改/删除**作用于整个系列**（结果里带 `recurring`，确认文案由前端展示）。
 */
internal object CalendarOps : ConnectedAppOps {
    private const val DAY_MS = 24L * 60 * 60 * 1000
    private const val MAX_RANGE_MS = 366L * DAY_MS
    private const val MAX_EVENT_MS = 30L * DAY_MS
    private const val MAX_LIST = 200
    private const val MAX_TITLE = 200
    private const val MAX_LOCATION = 200
    private const val MAX_DESCRIPTION = 2_000
    private const val MAX_TIMEZONE = 64

    private val READ_CAPABILITIES = listOf(
        "list_calendars",
        "list_calendar_events",
        "get_calendar_event",
    )
    private val WRITE_CAPABILITIES = listOf(
        "create_calendar_event",
        "update_calendar_event",
        "delete_calendar_event",
    )
    private val CAPABILITIES = READ_CAPABILITIES + WRITE_CAPABILITIES

    private val PERMISSIONS = listOf(
        OpsPermission("read_calendar"),
        OpsPermission("write_calendar", write = true, required = false),
    )

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        val provider =
            ctx.packageManager.resolveContentProvider(CalendarContract.AUTHORITY, 0) != null
        val read = PermissionMap.hasPermission(ctx, Manifest.permission.READ_CALENDAR)
        val write = PermissionMap.hasPermission(ctx, Manifest.permission.WRITE_CALENDAR)
        val permissions = JSONArray()
            .put(JSONObject().put("key", "read_calendar").put("granted", read))
            .put(JSONObject().put("key", "write_calendar").put("granted", write))
        val capabilities = ArrayList<String>(CAPABILITIES.size)
        capabilities.addAll(READ_CAPABILITIES)
        if (write) capabilities.addAll(WRITE_CAPABILITIES)
        return baseStatus(
            permissions = permissions,
            capabilities = JSONArray(capabilities),
            supported = true,
            available = provider,
            detail = if (provider) null else "没有找到系统日历",
        )
    }

    /** 运行时权限由 Bridge 的 RequestMultiplePermissions launcher 申请；这里只解释原因。 */
    override fun request(ctx: Context, mode: String): JSONObject = JSONObject()
        .put("opened", false)
        .put("reason", "日历权限由系统的运行时权限弹窗授予，请在 Rein 界面点「去授权」")

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject = when (method) {
        "list_calendars" -> {
            requireRead(ctx)
            listCalendars(ctx)
        }
        "list_calendar_events" -> {
            requireRead(ctx)
            listEvents(ctx, payload)
        }
        "get_calendar_event" -> {
            requireRead(ctx)
            getEventReply(ctx, payload)
        }
        "create_calendar_event" -> {
            requireRead(ctx)
            requireWrite(ctx)
            createEvent(ctx, payload)
        }
        "update_calendar_event" -> {
            requireRead(ctx)
            requireWrite(ctx)
            updateEvent(ctx, payload)
        }
        "delete_calendar_event" -> {
            requireRead(ctx)
            requireWrite(ctx)
            deleteEvent(ctx, payload)
        }
        else -> throw OpsError("connected_app_unknown_method", "日历不支持方法 $method")
    }

    /* ---------------- 权限 ---------------- */

    private fun requireRead(ctx: Context) {
        if (!PermissionMap.hasPermission(ctx, Manifest.permission.READ_CALENDAR)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少日历读取权限（READ_CALENDAR）",
                "permissions",
            )
        }
    }

    private fun requireWrite(ctx: Context) {
        if (!PermissionMap.hasPermission(ctx, Manifest.permission.WRITE_CALENDAR)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少日历写入权限（WRITE_CALENDAR）",
                "permissions_write",
            )
        }
    }

    /* ---------------- 读 ---------------- */

    private fun listCalendars(ctx: Context): JSONObject {
        val projection = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
        )
        val items = JSONArray()
        ctx.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            projection,
            "${CalendarContract.Calendars.VISIBLE}=1",
            null,
            "${CalendarContract.Calendars.CALENDAR_DISPLAY_NAME} ASC",
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val level = cursor.getInt(3)
                items.put(
                    JSONObject()
                        .put("calendarId", cursor.getLong(0).toString())
                        .put("displayName", cursor.getString(1) ?: "")
                        .put("accountName", cursor.getString(2) ?: "")
                        .put("writable", level >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR),
                )
            }
        }
        return JSONObject().put("items", items).put("count", items.length())
    }

    private fun listEvents(ctx: Context, payload: JSONObject): JSONObject {
        val fromRaw = payload.optString("from", "").trim()
        val toRaw = payload.optString("to", "").trim()
        if (fromRaw.isEmpty() || toRaw.isEmpty()) {
            throw OpsError("connected_app_bad_request", "from/to 必填（ISO 时间或 YYYY-MM-DD）")
        }
        val from = parseTime(fromRaw)
            ?: throw OpsError("connected_app_bad_request", "from 不是合法时间：$fromRaw")
        val to = parseTime(toRaw)
            ?: throw OpsError("connected_app_bad_request", "to 不是合法时间：$toRaw")
        if (to <= from) throw OpsError("connected_app_bad_request", "to 必须晚于 from")
        if (to - from > MAX_RANGE_MS) {
            throw OpsError("connected_app_bad_request", "查询范围不能超过 366 天")
        }
        val limit = payload.optInt("limit", 50).coerceIn(1, MAX_LIST)
        val calendarId = payload.optString("calendarId", "").trim()

        val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
        ContentUris.appendId(builder, from)
        ContentUris.appendId(builder, to)
        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.CALENDAR_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION,
            CalendarContract.Instances.RRULE,
        )
        val selection = if (calendarId.isNotEmpty()) {
            "${CalendarContract.Instances.CALENDAR_ID}=?"
        } else {
            null
        }
        val args = if (calendarId.isNotEmpty()) arrayOf(calendarId) else null

        val events = JSONArray()
        var total = 0
        ctx.contentResolver.query(
            builder.build(),
            projection,
            selection,
            args,
            "${CalendarContract.Instances.BEGIN} ASC",
        )?.use { cursor ->
            total = cursor.count
            while (events.length() < limit && cursor.moveToNext()) {
                val description = cursor.getString(7) ?: ""
                val rrule = cursor.getString(8)
                events.put(
                    JSONObject()
                        .put("eventId", cursor.getLong(0).toString())
                        .put("calendarId", cursor.getLong(1).toString())
                        .put("title", Json.truncate(cursor.getString(2), MAX_TITLE))
                        .put("start", iso(cursor.getLong(3)))
                        .put("end", iso(cursor.getLong(4)))
                        .put("allDay", cursor.getInt(5) == 1)
                        .put("location", cursor.getString(6) ?: JSONObject.NULL)
                        .put("descriptionPreview", Json.truncate(description, 200))
                        .put("recurring", !rrule.isNullOrEmpty()),
                )
            }
        }
        return JSONObject()
            .put("events", events)
            .put("count", events.length())
            .put("truncated", total > events.length())
    }

    private fun getEventReply(ctx: Context, payload: JSONObject): JSONObject {
        val eventId = eventIdOf(payload)
        val row = readEvent(ctx, eventId)
            ?: throw OpsError("connected_app_not_found", "没有找到这条日程（eventId=$eventId）")
        return JSONObject().put("event", eventJson(row)).put("recurring", row.recurring)
    }

    /* ---------------- 写 ---------------- */

    private fun createEvent(ctx: Context, payload: JSONObject): JSONObject {
        val title = payload.optString("title", "").trim()
        validateTitle(title)
        val startRaw = payload.optString("start", "").trim()
        val endRaw = payload.optString("end", "").trim()
        val start = parseTime(startRaw)
            ?: throw OpsError("connected_app_bad_request", "start 不是合法时间：$startRaw")
        val end = parseTime(endRaw)
            ?: throw OpsError("connected_app_bad_request", "end 不是合法时间：$endRaw")
        val allDay = payload.optBoolean("allDay", false)
        val (dtStart, dtEnd) = normalizeRange(start, end, allDay)
        val location = Json.truncate(payload.optString("location", ""), MAX_LOCATION).ifBlank { null }
        val description =
            Json.truncate(payload.optString("description", ""), MAX_DESCRIPTION).ifBlank { null }
        val timezone = Json.truncate(payload.optString("timezone", ""), MAX_TIMEZONE)
            .ifBlank { TimeZone.getDefault().id }

        val calendarId = payload.optString("calendarId", "").trim().ifEmpty { null }
            ?.let { raw ->
                val id = raw.toLongOrNull()
                    ?: throw OpsError("connected_app_bad_request", "calendarId 必须是数字")
                ensureWritableCalendar(ctx, id)
            }
            ?: pickWritableCalendar(ctx)

        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId)
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.DTSTART, dtStart)
            put(CalendarContract.Events.DTEND, dtEnd)
            put(CalendarContract.Events.ALL_DAY, if (allDay) 1 else 0)
            put(CalendarContract.Events.EVENT_TIMEZONE, if (allDay) "UTC" else timezone)
            if (location != null) put(CalendarContract.Events.EVENT_LOCATION, location)
            if (description != null) put(CalendarContract.Events.DESCRIPTION, description)
        }
        val uri = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            ?: throw OpsError("connected_app_native_error", "日历插入失败（没有返回事件 ID）")
        val eventId = ContentUris.parseId(uri)
        val row = readEvent(ctx, eventId)
            ?: throw OpsError("connected_app_native_error", "日程已写入但读不回来（eventId=$eventId）")
        return JSONObject()
            .put("eventId", eventId.toString())
            .put("calendarId", calendarId.toString())
            .put("event", eventJson(row))
    }

    private fun updateEvent(ctx: Context, payload: JSONObject): JSONObject {
        val eventId = eventIdOf(payload)
        val current = readEvent(ctx, eventId)
            ?: throw OpsError("connected_app_not_found", "没有找到这条日程（eventId=$eventId）")

        val values = ContentValues()
        var changed = false

        if (payload.has("title")) {
            val title = payload.optString("title", "").trim()
            validateTitle(title)
            values.put(CalendarContract.Events.TITLE, title)
            changed = true
        }

        val hasStart = payload.has("start")
        val hasEnd = payload.has("end")
        val hasAllDay = payload.has("allDay")
        val allDay = if (hasAllDay) payload.optBoolean("allDay", current.allDay) else current.allDay
        if (hasStart || hasEnd || hasAllDay) {
            val start = if (hasStart) {
                val raw = payload.optString("start", "").trim()
                parseTime(raw) ?: throw OpsError("connected_app_bad_request", "start 不是合法时间：$raw")
            } else {
                current.start
            }
            val end = if (hasEnd) {
                val raw = payload.optString("end", "").trim()
                parseTime(raw) ?: throw OpsError("connected_app_bad_request", "end 不是合法时间：$raw")
            } else if (hasStart) {
                // 只改 start 时保持原时长（plan §1.2）。
                start + (current.end - current.start).coerceAtLeast(DAY_MS)
            } else {
                current.end
            }
            val (dtStart, dtEnd) = normalizeRange(start, end, allDay)
            values.put(CalendarContract.Events.DTSTART, dtStart)
            values.put(CalendarContract.Events.DTEND, dtEnd)
            values.put(CalendarContract.Events.ALL_DAY, if (allDay) 1 else 0)
            if (allDay) values.put(CalendarContract.Events.EVENT_TIMEZONE, "UTC")
            changed = true
        }

        if (payload.has("location")) {
            values.put(
                CalendarContract.Events.EVENT_LOCATION,
                Json.truncate(payload.optString("location", ""), MAX_LOCATION).ifBlank { null },
            )
            changed = true
        }
        if (payload.has("description")) {
            values.put(
                CalendarContract.Events.DESCRIPTION,
                Json.truncate(payload.optString("description", ""), MAX_DESCRIPTION).ifBlank { null },
            )
            changed = true
        }
        if (payload.has("timezone") && !allDay) {
            val timezone = Json.truncate(payload.optString("timezone", ""), MAX_TIMEZONE).ifBlank {
                current.timezone ?: TimeZone.getDefault().id
            }
            values.put(CalendarContract.Events.EVENT_TIMEZONE, timezone)
            changed = true
        }
        if (!changed) {
            throw OpsError("connected_app_bad_request", "至少提供一个要修改的字段")
        }

        val rows = ctx.contentResolver.update(
            ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
            values,
            null,
            null,
        )
        if (rows <= 0) {
            throw OpsError("connected_app_native_error", "无法修改这条日程（日历可能只读）")
        }
        val updated = readEvent(ctx, eventId)
            ?: throw OpsError("connected_app_not_found", "修改后读不到这条日程（eventId=$eventId）")
        return JSONObject()
            .put("updated", true)
            .put("event", eventJson(updated))
            .put("recurring", current.recurring)
    }

    private fun deleteEvent(ctx: Context, payload: JSONObject): JSONObject {
        val eventId = eventIdOf(payload)
        val current = readEvent(ctx, eventId)
            ?: throw OpsError("connected_app_not_found", "没有找到这条日程（eventId=$eventId）")
        val rows = ctx.contentResolver.delete(
            ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
            null,
            null,
        )
        if (rows <= 0) {
            throw OpsError("connected_app_native_error", "无法删除这条日程（日历可能只读）")
        }
        return JSONObject()
            .put("deleted", true)
            .put("eventId", eventId.toString())
            .put("recurring", current.recurring)
    }

    /* ---------------- 数据读写小工具 ---------------- */

    private data class EventRow(
        val id: Long,
        val calendarId: Long,
        val title: String,
        val start: Long,
        val end: Long,
        val allDay: Boolean,
        val location: String?,
        val description: String?,
        val recurring: Boolean,
        val timezone: String?,
    )

    private fun readEvent(ctx: Context, eventId: Long): EventRow? {
        val projection = arrayOf(
            CalendarContract.Events._ID,
            CalendarContract.Events.CALENDAR_ID,
            CalendarContract.Events.TITLE,
            CalendarContract.Events.DTSTART,
            CalendarContract.Events.DTEND,
            CalendarContract.Events.ALL_DAY,
            CalendarContract.Events.EVENT_LOCATION,
            CalendarContract.Events.DESCRIPTION,
            CalendarContract.Events.RRULE,
            CalendarContract.Events.EVENT_TIMEZONE,
        )
        val cursor = ctx.contentResolver.query(
            ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
            projection,
            null,
            null,
            null,
        ) ?: return null
        return cursor.use { c ->
            if (!c.moveToFirst()) {
                null
            } else {
                val start = if (c.isNull(3)) 0L else c.getLong(3)
                val end = if (c.isNull(4) || c.getLong(4) <= start) start else c.getLong(4)
                val rrule = c.getString(8)
                EventRow(
                    id = c.getLong(0),
                    calendarId = c.getLong(1),
                    title = c.getString(2) ?: "",
                    start = start,
                    end = end,
                    allDay = c.getInt(5) == 1,
                    location = c.getString(6),
                    description = c.getString(7),
                    recurring = !rrule.isNullOrEmpty(),
                    timezone = c.getString(9),
                )
            }
        }
    }

    private fun eventJson(row: EventRow): JSONObject = JSONObject()
        .put("eventId", row.id.toString())
        .put("calendarId", row.calendarId.toString())
        .put("title", Json.truncate(row.title, MAX_TITLE))
        .put("start", iso(row.start))
        .put("end", iso(row.end))
        .put("allDay", row.allDay)
        .put("location", row.location ?: JSONObject.NULL)
        .put("description", Json.truncate(row.description, MAX_DESCRIPTION))
        .put("recurring", row.recurring)
        .put("timezone", row.timezone ?: JSONObject.NULL)

    private fun pickWritableCalendar(ctx: Context): Long {
        val selection = "${CalendarContract.Calendars.VISIBLE}=1 AND " +
            "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=" +
            CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR
        val order = "${CalendarContract.Calendars.IS_PRIMARY} DESC, ${CalendarContract.Calendars._ID} ASC"
        ctx.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID),
            selection,
            null,
            order,
        )?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getLong(0)
        }
        throw OpsError(
            "connected_app_no_writable_calendar",
            "没有可写的日历；请先在系统日历应用里添加一个账户",
        )
    }

    private fun ensureWritableCalendar(ctx: Context, calendarId: Long): Long {
        val selection = "${CalendarContract.Calendars._ID}=? AND " +
            "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=" +
            CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR
        ctx.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID),
            selection,
            arrayOf(calendarId.toString()),
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) return calendarId
        }
        throw OpsError(
            "connected_app_no_writable_calendar",
            "指定的日历不存在或不可写（calendarId=$calendarId）",
        )
    }

    private fun validateTitle(title: String) {
        if (title.isEmpty() || title.length > MAX_TITLE) {
            throw OpsError("connected_app_bad_request", "title 必填且不能超过 $MAX_TITLE 字")
        }
    }

    private fun eventIdOf(payload: JSONObject): Long {
        val raw = payload.optString("eventId", "").trim()
        val id = raw.toLongOrNull()
            ?: throw OpsError("connected_app_bad_request", "eventId 必须是数字")
        if (id <= 0) throw OpsError("connected_app_bad_request", "eventId 必须大于 0")
        return id
    }

    /** 全天事件按 UTC 零点对齐；end 为排他边界，至少比 start 晚一天。 */
    private fun normalizeRange(start: Long, end: Long, allDay: Boolean): Pair<Long, Long> {
        var dtStart = start
        var dtEnd = end
        if (allDay) {
            val zone = ZoneId.systemDefault()
            dtStart = Instant.ofEpochMilli(start).atZone(zone).toLocalDate()
                .atStartOfDay(ZoneOffset.UTC)
                .toInstant()
                .toEpochMilli()
            dtEnd = Instant.ofEpochMilli(end).atZone(zone).toLocalDate()
                .atStartOfDay(ZoneOffset.UTC)
                .toInstant()
                .toEpochMilli()
            if (dtEnd <= dtStart) dtEnd = dtStart + DAY_MS
        }
        if (dtEnd <= dtStart) throw OpsError("connected_app_bad_request", "end 必须晚于 start")
        if (dtEnd - dtStart > MAX_EVENT_MS) {
            throw OpsError("connected_app_bad_request", "单次日程不能超过 30 天")
        }
        return dtStart to dtEnd
    }

    /** 支持 RFC3339（带时区）、UTC ISO 与 YYYY-MM-DD（按本地零点）。 */
    private fun parseTime(raw: String): Long? {
        val value = raw.trim()
        if (value.isEmpty()) return null
        try {
            return OffsetDateTime.parse(value).toInstant().toEpochMilli()
        } catch (_: DateTimeParseException) {
            // 继续尝试其它格式
        }
        try {
            return Instant.parse(value).toEpochMilli()
        } catch (_: DateTimeParseException) {
            // 继续尝试日期
        }
        try {
            return LocalDate.parse(value)
                .atStartOfDay(ZoneId.systemDefault())
                .toInstant()
                .toEpochMilli()
        } catch (_: DateTimeParseException) {
            return null
        }
    }

    private fun iso(millis: Long): String = Instant.ofEpochMilli(millis).toString()
}
