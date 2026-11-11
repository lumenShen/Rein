package com.gozaoo.rein.connectedapps

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.Context
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.RawContacts
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通讯录（Android ContactsContract）。
 *
 * 读写口径（plan §1.2 / §13.1）：
 * - 读：`search_contacts`（姓名/号码/邮箱匹配，每人 ≤5 号 + ≤5 邮箱，≤50 人）、
 *   `get_contact`（号码/邮箱各 ≤10），需要 READ_CONTACTS；
 * - 写：`create/update/delete_contact`，需要 WRITE_CONTACTS + READ_CONTACTS；
 * - 一次一个联系人；`update` 只改给定字段，给了 phones/emails 就整组替换；
 * - 只改本机 raw contact（ACCOUNT_TYPE=null）；云端账户返回 native_error + 提示；
 * - `delete` 删除该聚合联系人的全部 raw contact，会同步到已登录账户（确认文案由前端展示）。
 */
internal object ContactsOps : ConnectedAppOps {
    private const val MAX_QUERY = 64
    private const val MAX_RESULTS = 50
    private const val MAX_NAME = 200
    private const val MAX_PHONE = 40
    private const val MAX_EMAIL = 120
    private const val MAX_ARRAY = 10
    private const val LIST_PHONES = 5
    private const val LIST_EMAILS = 5

    private val READ_CAPABILITIES = listOf("search_contacts", "get_contact")
    private val WRITE_CAPABILITIES = listOf("create_contact", "update_contact", "delete_contact")

    private val PERMISSIONS = listOf(
        OpsPermission("read_contacts"),
        OpsPermission("write_contacts", write = true, required = false),
    )

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        val provider =
            ctx.packageManager.resolveContentProvider(ContactsContract.AUTHORITY, 0) != null
        val read = PermissionMap.hasPermission(ctx, Manifest.permission.READ_CONTACTS)
        val write = PermissionMap.hasPermission(ctx, Manifest.permission.WRITE_CONTACTS)
        val permissions = JSONArray()
            .put(JSONObject().put("key", "read_contacts").put("granted", read))
            .put(JSONObject().put("key", "write_contacts").put("granted", write))
        val capabilities = ArrayList<String>(5)
        capabilities.addAll(READ_CAPABILITIES)
        if (write) capabilities.addAll(WRITE_CAPABILITIES)
        return baseStatus(
            permissions = permissions,
            capabilities = JSONArray(capabilities),
            supported = true,
            available = provider,
            detail = if (provider) null else "没有找到通讯录",
        )
    }

    override fun request(ctx: Context, mode: String): JSONObject = JSONObject()
        .put("opened", false)
        .put("reason", "通讯录权限由系统的运行时权限弹窗授予，请在 Rein 界面点「去授权」")

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject = when (method) {
        "search_contacts" -> {
            requireRead(ctx)
            searchContacts(ctx, payload)
        }
        "get_contact" -> {
            requireRead(ctx)
            getContactReply(ctx, payload)
        }
        "create_contact" -> {
            requireRead(ctx)
            requireWrite(ctx)
            createContact(ctx, payload)
        }
        "update_contact" -> {
            requireRead(ctx)
            requireWrite(ctx)
            updateContact(ctx, payload)
        }
        "delete_contact" -> {
            requireRead(ctx)
            requireWrite(ctx)
            deleteContact(ctx, payload)
        }
        else -> throw OpsError("connected_app_unknown_method", "通讯录不支持方法 $method")
    }

    /* ---------------- 权限 ---------------- */

    private fun requireRead(ctx: Context) {
        if (!PermissionMap.hasPermission(ctx, Manifest.permission.READ_CONTACTS)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少通讯录读取权限（READ_CONTACTS）",
                "permissions",
            )
        }
    }

    private fun requireWrite(ctx: Context) {
        if (!PermissionMap.hasPermission(ctx, Manifest.permission.WRITE_CONTACTS)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少通讯录写入权限（WRITE_CONTACTS）",
                "permissions_write",
            )
        }
    }

    /* ---------------- 读 ---------------- */

    private fun searchContacts(ctx: Context, payload: JSONObject): JSONObject {
        val query = payload.optString("query", "").trim()
        if (query.isEmpty() || query.length > MAX_QUERY) {
            throw OpsError("connected_app_bad_request", "query 必填且不能超过 $MAX_QUERY 字")
        }
        val limit = payload.optInt("limit", 20).coerceIn(1, MAX_RESULTS)
        val like = "%${escapeLike(query)}%"
        val ids = LinkedHashSet<Long>()

        collectContactIds(
            ctx,
            ContactsContract.Contacts.CONTENT_URI,
            "${ContactsContract.Contacts.DISPLAY_NAME} LIKE ? ESCAPE '\\'",
            like,
            ids,
            limit,
        )
        collectContactIds(
            ctx,
            Phone.CONTENT_URI,
            "${Phone.NUMBER} LIKE ? ESCAPE '\\'",
            like,
            ids,
            limit,
        )
        collectContactIds(
            ctx,
            Email.CONTENT_URI,
            "${Email.ADDRESS} LIKE ? ESCAPE '\\'",
            like,
            ids,
            limit,
        )

        val items = JSONArray()
        for (id in ids) {
            if (items.length() >= limit) break
            val contact = contactJson(ctx, id, LIST_PHONES, LIST_EMAILS) ?: continue
            items.put(contact)
        }
        return JSONObject().put("items", items).put("count", items.length())
    }

    private fun collectContactIds(
        ctx: Context,
        uri: android.net.Uri,
        selection: String,
        like: String,
        out: MutableSet<Long>,
        limit: Int,
    ) {
        if (out.size >= limit) return
        ctx.contentResolver.query(uri, arrayOf("_id"), selection, arrayOf(like), "_id ASC")?.use { c ->
            while (c.moveToNext() && out.size < limit) {
                out.add(c.getLong(0))
            }
        }
    }

    private fun getContactReply(ctx: Context, payload: JSONObject): JSONObject {
        val contactId = contactIdOf(payload)
        val contact = contactJson(ctx, contactId, MAX_ARRAY, MAX_ARRAY)
            ?: throw OpsError("connected_app_not_found", "没有找到这个联系人（contactId=$contactId）")
        return JSONObject().put("contact", contact)
    }

    private fun contactJson(
        ctx: Context,
        contactId: Long,
        maxPhones: Int,
        maxEmails: Int,
    ): JSONObject? {
        var exists = false
        val displayName = ctx.contentResolver.query(
            ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, contactId),
            arrayOf(ContactsContract.Contacts.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { c ->
            if (c.moveToFirst()) {
                exists = true
                c.getString(0) ?: ""
            } else {
                ""
            }
        } ?: return null
        if (!exists) return null

        val phones = JSONArray()
        ctx.contentResolver.query(
            Phone.CONTENT_URI,
            arrayOf(Phone.NUMBER, Phone.TYPE),
            "${Phone.CONTACT_ID}=?",
            arrayOf(contactId.toString()),
            "${Phone.IS_PRIMARY} DESC, ${Phone._ID} ASC",
        )?.use { c ->
            while (c.moveToNext() && phones.length() < maxPhones) {
                val number = Json.truncate(c.getString(0), MAX_PHONE)
                if (number.isNotBlank()) {
                    phones.put(
                        JSONObject()
                            .put("number", number)
                            .put("type", phoneTypeLabel(c.getInt(1))),
                    )
                }
            }
        }

        val emails = JSONArray()
        ctx.contentResolver.query(
            Email.CONTENT_URI,
            arrayOf(Email.ADDRESS, Email.TYPE),
            "${Email.CONTACT_ID}=?",
            arrayOf(contactId.toString()),
            "${Email.IS_PRIMARY} DESC, ${Email._ID} ASC",
        )?.use { c ->
            while (c.moveToNext() && emails.length() < maxEmails) {
                val address = Json.truncate(c.getString(0), MAX_EMAIL)
                if (address.isNotBlank()) {
                    emails.put(
                        JSONObject()
                            .put("address", address)
                            .put("type", emailTypeLabel(c.getInt(1))),
                    )
                }
            }
        }

        return JSONObject()
            .put("contactId", contactId.toString())
            .put("displayName", displayName ?: "")
            .put("phones", phones)
            .put("emails", emails)
    }

    /* ---------------- 写 ---------------- */

    private fun createContact(ctx: Context, payload: JSONObject): JSONObject {
        val name = payload.optString("name", "").trim()
        validateName(name)
        val phones = parsePhones(optionalArray(payload, "phones"))
        val emails = parseEmails(optionalArray(payload, "emails"))

        val ops = ArrayList<ContentProviderOperation>()
        ops.add(
            ContentProviderOperation.newInsert(RawContacts.CONTENT_URI)
                .withValue(RawContacts.ACCOUNT_TYPE, null)
                .withValue(RawContacts.ACCOUNT_NAME, null)
                .build(),
        )
        ops.add(
            ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValueBackReference(Data.RAW_CONTACT_ID, 0)
                .withValue(Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
                .withValue(StructuredName.DISPLAY_NAME, name)
                .build(),
        )
        for (phone in phones) {
            ops.add(
                ContentProviderOperation.newInsert(Data.CONTENT_URI)
                    .withValueBackReference(Data.RAW_CONTACT_ID, 0)
                    .withValue(Data.MIMETYPE, Phone.CONTENT_ITEM_TYPE)
                    .withValue(Phone.NUMBER, phone.number)
                    .withValue(Phone.TYPE, phoneTypeCode(phone.type))
                    .build(),
            )
        }
        for (email in emails) {
            ops.add(
                ContentProviderOperation.newInsert(Data.CONTENT_URI)
                    .withValueBackReference(Data.RAW_CONTACT_ID, 0)
                    .withValue(Data.MIMETYPE, Email.CONTENT_ITEM_TYPE)
                    .withValue(Email.ADDRESS, email.address)
                    .withValue(Email.TYPE, emailTypeCode(email.type))
                    .build(),
            )
        }

        val results = try {
            ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少通讯录写入权限（WRITE_CONTACTS）",
                "permissions_write",
            )
        } catch (e: Exception) {
            throw OpsError(
                "connected_app_native_error",
                "无法在本机账户创建联系人（${e.javaClass.simpleName}）",
            )
        }
        val rawUri = results.firstOrNull()?.uri
            ?: throw OpsError("connected_app_native_error", "通讯录插入失败（没有返回 raw contact）")
        val rawId = ContentUris.parseId(rawUri)
        val contactId = contactIdForRaw(ctx, rawId)
            ?: throw OpsError("connected_app_native_error", "联系人已写入但聚合失败（rawContactId=$rawId）")
        val contact = contactJson(ctx, contactId, MAX_ARRAY, MAX_ARRAY)
            ?: throw OpsError("connected_app_native_error", "联系人已写入但读不回来（contactId=$contactId）")
        return JSONObject().put("contactId", contactId.toString()).put("contact", contact)
    }

    private fun updateContact(ctx: Context, payload: JSONObject): JSONObject {
        val contactId = contactIdOf(payload)
        val rawId = findLocalRawContact(ctx, contactId)
            ?: throw OpsError(
                "connected_app_native_error",
                "该联系人属于云端账户，当前版本只能修改本机创建的联系人",
            )

        val ops = ArrayList<ContentProviderOperation>()
        if (payload.has("name")) {
            val name = payload.optString("name", "").trim()
            validateName(name)
            if (hasDataRow(ctx, rawId, StructuredName.CONTENT_ITEM_TYPE)) {
                ops.add(
                    ContentProviderOperation.newUpdate(Data.CONTENT_URI)
                        .withSelection(
                            "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?",
                            arrayOf(rawId.toString(), StructuredName.CONTENT_ITEM_TYPE),
                        )
                        .withValue(StructuredName.DISPLAY_NAME, name)
                        .build(),
                )
            } else {
                ops.add(
                    ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValue(Data.RAW_CONTACT_ID, rawId)
                        .withValue(Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
                        .withValue(StructuredName.DISPLAY_NAME, name)
                        .build(),
                )
            }
        }

        if (payload.has("phones")) {
            val phones = parsePhones(optionalArray(payload, "phones"))
            ops.add(
                ContentProviderOperation.newDelete(Data.CONTENT_URI)
                    .withSelection(
                        "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?",
                        arrayOf(rawId.toString(), Phone.CONTENT_ITEM_TYPE),
                    )
                    .build(),
            )
            for (phone in phones) {
                ops.add(
                    ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValue(Data.RAW_CONTACT_ID, rawId)
                        .withValue(Data.MIMETYPE, Phone.CONTENT_ITEM_TYPE)
                        .withValue(Phone.NUMBER, phone.number)
                        .withValue(Phone.TYPE, phoneTypeCode(phone.type))
                        .build(),
                )
            }
        }

        if (payload.has("emails")) {
            val emails = parseEmails(optionalArray(payload, "emails"))
            ops.add(
                ContentProviderOperation.newDelete(Data.CONTENT_URI)
                    .withSelection(
                        "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?",
                        arrayOf(rawId.toString(), Email.CONTENT_ITEM_TYPE),
                    )
                    .build(),
            )
            for (email in emails) {
                ops.add(
                    ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValue(Data.RAW_CONTACT_ID, rawId)
                        .withValue(Data.MIMETYPE, Email.CONTENT_ITEM_TYPE)
                        .withValue(Email.ADDRESS, email.address)
                        .withValue(Email.TYPE, emailTypeCode(email.type))
                        .build(),
                )
            }
        }

        if (ops.isEmpty()) {
            throw OpsError("connected_app_bad_request", "至少提供一个要修改的字段")
        }

        try {
            ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少通讯录写入权限（WRITE_CONTACTS）",
                "permissions_write",
            )
        } catch (e: Exception) {
            throw OpsError(
                "connected_app_native_error",
                "无法修改这个联系人（云端账户可能不允许修改）：${e.javaClass.simpleName}",
            )
        }

        val contact = contactJson(ctx, contactId, MAX_ARRAY, MAX_ARRAY)
            ?: throw OpsError("connected_app_native_error", "修改后读不到这个联系人（contactId=$contactId）")
        return JSONObject().put("updated", true).put("contact", contact)
    }

    private fun deleteContact(ctx: Context, payload: JSONObject): JSONObject {
        val contactId = contactIdOf(payload)
        val rows = try {
            ctx.contentResolver.delete(
                RawContacts.CONTENT_URI,
                "${RawContacts.CONTACT_ID}=?",
                arrayOf(contactId.toString()),
            )
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少通讯录写入权限（WRITE_CONTACTS）",
                "permissions_write",
            )
        }
        if (rows <= 0) {
            throw OpsError("connected_app_not_found", "没有找到这个联系人（contactId=$contactId）")
        }
        return JSONObject().put("deleted", true).put("contactId", contactId.toString())
    }

    /* ---------------- 数据小工具 ---------------- */

    private data class PhoneEntry(val number: String, val type: String)
    private data class EmailEntry(val address: String, val type: String)

    private fun contactIdOf(payload: JSONObject): Long {
        val raw = payload.optString("contactId", "").trim()
        val id = raw.toLongOrNull()
            ?: throw OpsError("connected_app_bad_request", "contactId 必须是数字")
        if (id <= 0) throw OpsError("connected_app_bad_request", "contactId 必须大于 0")
        return id
    }

    private fun findLocalRawContact(ctx: Context, contactId: Long): Long? =
        ctx.contentResolver.query(
            RawContacts.CONTENT_URI,
            arrayOf(RawContacts._ID),
            "${RawContacts.CONTACT_ID}=? AND ${RawContacts.ACCOUNT_TYPE} IS NULL",
            arrayOf(contactId.toString()),
            "${RawContacts._ID} ASC",
        )?.use { c -> if (c.moveToFirst()) c.getLong(0) else null }

    private fun hasDataRow(ctx: Context, rawId: Long, mimeType: String): Boolean =
        ctx.contentResolver.query(
            Data.CONTENT_URI,
            arrayOf(Data._ID),
            "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?",
            arrayOf(rawId.toString(), mimeType),
            null,
        )?.use { it.moveToFirst() } ?: false

    private fun contactIdForRaw(ctx: Context, rawId: Long): Long? =
        ctx.contentResolver.query(
            ContentUris.withAppendedId(RawContacts.CONTENT_URI, rawId),
            arrayOf(RawContacts.CONTACT_ID),
            null,
            null,
            null,
        )?.use { c -> if (c.moveToFirst()) c.getLong(0) else null }

    private fun validateName(name: String) {
        if (name.isEmpty() || name.length > MAX_NAME) {
            throw OpsError("connected_app_bad_request", "name 必填且不能超过 $MAX_NAME 字")
        }
    }

    private fun optionalArray(payload: JSONObject, key: String): JSONArray? = when (val v = payload.opt(key)) {
        null, JSONObject.NULL -> null
        is JSONArray -> v
        else -> throw OpsError("connected_app_bad_request", "$key 必须是数组")
    }

    private fun parsePhones(array: JSONArray?): List<PhoneEntry> {
        if (array == null) return emptyList()
        if (array.length() > MAX_ARRAY) {
            throw OpsError("connected_app_bad_request", "号码最多 $MAX_ARRAY 个")
        }
        val out = ArrayList<PhoneEntry>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i)
                ?: throw OpsError("connected_app_bad_request", "phones[$i] 必须是对象")
            val number = item.optString("number", "").trim()
            if (number.isEmpty() || number.length > MAX_PHONE) {
                throw OpsError("connected_app_bad_request", "phones[$i].number 必填且不能超过 $MAX_PHONE 字")
            }
            out.add(PhoneEntry(number, normalizePhoneType(item.optString("type", "mobile"))))
        }
        return out
    }

    private fun parseEmails(array: JSONArray?): List<EmailEntry> {
        if (array == null) return emptyList()
        if (array.length() > MAX_ARRAY) {
            throw OpsError("connected_app_bad_request", "邮箱最多 $MAX_ARRAY 个")
        }
        val out = ArrayList<EmailEntry>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i)
                ?: throw OpsError("connected_app_bad_request", "emails[$i] 必须是对象")
            val address = item.optString("address", "").trim()
            if (address.isEmpty() || address.length > MAX_EMAIL) {
                throw OpsError(
                    "connected_app_bad_request",
                    "emails[$i].address 必填且不能超过 $MAX_EMAIL 字",
                )
            }
            out.add(EmailEntry(address, normalizeEmailType(item.optString("type", "home"))))
        }
        return out
    }

    private fun escapeLike(value: String): String = value
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")

    private fun normalizePhoneType(type: String): String = when (type.trim().lowercase()) {
        "mobile", "cell" -> "mobile"
        "home" -> "home"
        "work" -> "work"
        "fax" -> "fax"
        else -> "other"
    }

    private fun phoneTypeCode(type: String): Int = when (type) {
        "mobile" -> Phone.TYPE_MOBILE
        "home" -> Phone.TYPE_HOME
        "work" -> Phone.TYPE_WORK
        "fax" -> Phone.TYPE_FAX_HOME
        else -> Phone.TYPE_OTHER
    }

    private fun phoneTypeLabel(type: Int): String = when (type) {
        Phone.TYPE_MOBILE -> "mobile"
        Phone.TYPE_HOME -> "home"
        Phone.TYPE_WORK -> "work"
        Phone.TYPE_FAX_HOME, Phone.TYPE_FAX_WORK -> "fax"
        else -> "other"
    }

    private fun normalizeEmailType(type: String): String = when (type.trim().lowercase()) {
        "home" -> "home"
        "work" -> "work"
        else -> "other"
    }

    private fun emailTypeCode(type: String): Int = when (type) {
        "home" -> Email.TYPE_HOME
        "work" -> Email.TYPE_WORK
        else -> Email.TYPE_OTHER
    }

    private fun emailTypeLabel(type: Int): String = when (type) {
        Email.TYPE_HOME -> "home"
        Email.TYPE_WORK -> "work"
        else -> "other"
    }
}
