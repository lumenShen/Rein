package com.gozaoo.rein.connectedapps

import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * 安卓 SAF 文件读写（单树）。
 *
 * 设计约束（plan §1.2 / §3.10 / §6.1）：
 * - 只有 0/1 个持久授权树，id 固定 `filesystem:default`；更换选择即替换。
 * - 相对路径按 `/` 分段，每段都从树根用 `buildChildDocumentsUriUsingTree` 解析；
 *   永远不把用户字符串拼进 document URI，因此 `../`/绝对路径不可能越出根。
 * - 相对路径拒绝绝对、`..`、`.`、空段、NUL，长度 ≤512；单段 ≤255。
 * - 读 ≤1MB；含 NUL 判二进制（`connected_app_not_text`）；UTF-8 lossy。
 * - 写 ≤1MB（UTF-8 字节）；默认不覆盖；返回 provider 给的**实际** displayName/path。
 * - 删除只删单文件或空目录；非空返回 `connected_app_not_empty`。
 * - 所有可预期失败返回 `Json.err`，SecurityException 统一转
 *   `connected_app_permission_denied` + `action=folder`。
 */
internal object FileOps : ConnectedAppOps {
    private const val ROOT_ID = "filesystem:default"
    private const val DEFAULT_LABEL = "已授权文件夹"
    private const val MAX_PATH_CHARS = 512
    private const val MAX_SEGMENT_CHARS = 255
    private const val MAX_READ_BYTES = 1024 * 1024
    private const val MAX_WRITE_BYTES = 1024 * 1024
    private const val MAX_LIST_LIMIT = 200
    private const val MAX_SEARCH_LIMIT = 50
    private const val MAX_SEARCH_SCAN = 2000
    private const val MAX_SEARCH_DEPTH = 4
    private const val MAX_QUERY_CHARS = 64
    private const val READ_BUFFER = 8192

    private val READ_METHODS = listOf(
        "files_roots",
        "files_list",
        "read_phone_file",
        "search_phone_files",
    )
    private val WRITE_METHODS = listOf(
        "write_phone_file",
        "create_phone_folder",
        "delete_phone_file",
        "rename_phone_file",
    )
    private val ALL_METHODS = READ_METHODS + WRITE_METHODS

    private val PROJECTION = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_FLAGS,
    )

    private val PERMISSIONS = listOf(
        OpsPermission("saf_tree"),
        OpsPermission("saf_tree_write", write = true, required = false),
    )

    private data class DocRef(
        val uri: Uri,
        val docId: String,
        val name: String,
        val isDir: Boolean,
        val size: Long?,
        val lastModified: Long?,
        val flags: Int?,
    ) {
        /** provider 是否声明该目录支持 createDocument；未提供 FLAGS 时按持久写权限判断。 */
        fun supportsCreate(): Boolean =
            flags == null || (flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) != 0
    }

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        val tree = treeUri(ctx)
        val readGranted = tree != null && hasPersistedPermission(ctx, tree, write = false)
        val writeGranted = tree != null && hasPersistedPermission(ctx, tree, write = true)
        val rootDoc = if (readGranted && tree != null) {
            runCatching {
                queryDocument(ctx, tree, DocumentsContract.getTreeDocumentId(tree))
            }.getOrNull()
        } else {
            null
        }
        val available = when {
            // 没有树 / 权限失效不是「系统能力不可用」：Rust 会按 requires_root + granted
            // 判成 partial，让 UI 显示「去选择文件夹」。只有选了树却访问不到才算 unavailable。
            tree == null -> true
            !readGranted -> true
            else -> rootDoc != null
        }
        val writable = writeGranted && rootDoc?.supportsCreate() == true

        val permissions = JSONArray()
            .put(permission("saf_tree", readGranted, required = true, write = false))
            .put(permission("saf_tree_write", writeGranted, required = false, write = true))

        val roots = JSONArray()
        if (available && rootDoc != null) {
            roots.put(
                JSONObject()
                    .put("id", ROOT_ID)
                    .put("label", PermissionMap.treeLabel(ctx) ?: rootDoc.name.ifBlank { DEFAULT_LABEL })
                    .put("writable", writable),
            )
        }

        val capabilities = JSONArray()
        for (method in READ_METHODS) capabilities.put(method)
        if (writable) {
            for (method in WRITE_METHODS) capabilities.put(method)
        }

        val detail = when {
            tree == null -> "还没有选择文件夹"
            !readGranted -> "文件夹授权已失效，请重新选择"
            !available -> "无法访问已授权的文件夹，请重新选择"
            else -> null
        }
        return baseStatus(
            permissions = permissions,
            roots = roots,
            capabilities = capabilities,
            supported = true,
            available = available,
            detail = detail,
        )
    }

    /**
     * `folder` 由 `ConnectedAppsBridge.treeLauncher` 拉起（需要 Activity），本 Ops 只做
     * 持久化与释放。`disconnect` 释放全部持久授权并清树；其它模式明确不处理。
     */
    override fun request(ctx: Context, mode: String): JSONObject = when (mode) {
        "disconnect" -> {
            val tree = treeUri(ctx)
            if (tree != null) releasePersistedPermissions(ctx, tree)
            clearTree(ctx)
            Json.ok(JSONObject().put("opened", true))
        }
        "folder" -> Json.ok(
            JSONObject()
                .put("opened", false)
                .put("reason", "请回到 Rein 界面选择文件夹"),
        )
        else -> Json.err(
            "connected_app_bad_request",
            "文件系统不支持授权模式：$mode",
            "folder",
        )
    }

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject {
        if (method !in ALL_METHODS) {
            return Json.err(
                "connected_app_unknown_method",
                "文件系统不支持方法 $method",
            )
        }
        val rootId = payload.optString("root").trim()
        if (rootId.isNotEmpty() && rootId != ROOT_ID) {
            return Json.err(
                "connected_app_no_root",
                "未知的文件根：$rootId，请重新调用 list_phone_roots",
                "folder",
            )
        }
        val tree = treeUri(ctx)
            ?: return Json.err(
                "connected_app_no_root",
                "还没有选择文件夹；请先在「连接应用 → 安卓文件系统」选择",
                "folder",
            )

        return try {
            when (method) {
                "files_roots" -> rootsStatus(ctx, tree)
                "files_list" -> list(ctx, tree, payload)
                "read_phone_file" -> readText(ctx, tree, payload)
                "search_phone_files" -> search(ctx, tree, payload)
                "write_phone_file" -> writeText(ctx, tree, payload)
                "create_phone_folder" -> createFolder(ctx, tree, payload)
                "delete_phone_file" -> delete(ctx, tree, payload)
                "rename_phone_file" -> rename(ctx, tree, payload)
                else -> Json.err("connected_app_unknown_method", "文件系统不支持方法 $method")
            }
        } catch (e: SecurityException) {
            Json.err(
                "connected_app_permission_denied",
                "文件夹授权已失效，请重新选择文件夹",
                "folder",
            )
        } catch (e: OpsError) {
            Json.err(e.code, e.message ?: "文件操作失败", e.action)
        } catch (e: Exception) {
            Json.err("connected_app_native_error", e.javaClass.simpleName)
        }
    }

    /** Bridge 的 OpenDocumentTree 回调写入；再兜底申请一次持久读写授权。 */
    fun setTree(ctx: Context, uri: Uri?, label: String?) {
        if (uri == null) {
            clearTree(ctx)
            return
        }
        try {
            ctx.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (_: SecurityException) {
            // 部分 provider 只给读或不允许持久化；URI 仍保存，status 会显示未完全授权。
        }
        PermissionMap.setTree(ctx, uri.toString(), label?.take(120))
    }

    fun tree(ctx: Context): String? = PermissionMap.tree(ctx)

    fun clearTree(ctx: Context) {
        PermissionMap.setTree(ctx, null, null)
    }

    private fun treeUri(ctx: Context): Uri? =
        PermissionMap.tree(ctx)?.let { runCatching { Uri.parse(it) }.getOrNull() }

    private fun permission(key: String, granted: Boolean, required: Boolean, write: Boolean): JSONObject =
        JSONObject()
            .put("key", key)
            .put("granted", granted)
            .put("required", required)
            .put("write", write)

    private fun hasPersistedPermission(ctx: Context, tree: Uri, write: Boolean): Boolean = try {
        ctx.contentResolver.persistedUriPermissions.any { perm ->
            perm.uri == tree && if (write) perm.isWritePermission else perm.isReadPermission
        }
    } catch (_: SecurityException) {
        false
    }

    private fun releasePersistedPermissions(ctx: Context, tree: Uri) {
        // 分开释放：provider 可能只授了其中一种，一次传两个 flag 会整体失败。
        for (flag in listOf(
            Intent.FLAG_GRANT_READ_URI_PERMISSION,
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )) {
            try {
                ctx.contentResolver.releasePersistableUriPermission(tree, flag)
            } catch (_: SecurityException) {
                // 授权已被系统回收：忽略。
            }
        }
    }

    private fun rootsStatus(ctx: Context, tree: Uri): JSONObject {
        val readGranted = hasPersistedPermission(ctx, tree, write = false)
        val writeGranted = hasPersistedPermission(ctx, tree, write = true)
        if (!readGranted) {
            return Json.err(
                "connected_app_permission_denied",
                "文件夹读取授权已失效，请重新选择",
                "folder",
            )
        }
        val root = queryDocument(ctx, tree, DocumentsContract.getTreeDocumentId(tree))
            ?: return Json.err("connected_app_no_root", "无法访问已授权的文件夹，请重新选择", "folder")
        val entries = JSONArray().put(
            JSONObject()
                .put("id", ROOT_ID)
                .put("label", PermissionMap.treeLabel(ctx) ?: root.name.ifBlank { DEFAULT_LABEL })
                .put("writable", writeGranted && root.supportsCreate()),
        )
        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("roots", entries),
        )
    }

    private fun list(ctx: Context, tree: Uri, payload: JSONObject): JSONObject {
        val segments = parseRelative(payload.optString("path"))
        val dir = resolve(ctx, tree, segments)
            ?: return Json.err("connected_app_not_found", "目录不存在：${displayPath(segments)}")
        if (!dir.isDir) {
            return Json.err("connected_app_bad_request", "不是目录：${displayPath(segments)}")
        }
        val limit = clamp(payload.optInt("limit", 100), 1, MAX_LIST_LIMIT)
        val children = queryChildren(ctx, tree, dir.docId)
            .sortedWith(compareBy({ !it.isDir }, { it.name.lowercase() }))
        val items = JSONArray()
        for (child in children.take(limit)) {
            items.put(childJson(child, joinPath(displayPath(segments), child.name)))
        }
        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("path", displayPath(segments))
                .put("items", items)
                .put("truncated", children.size > limit),
        )
    }

    private fun readText(ctx: Context, tree: Uri, payload: JSONObject): JSONObject {
        val segments = parseRelative(payload.optString("path"))
        if (segments.isEmpty()) {
            return Json.err("connected_app_bad_request", "path 不能为空")
        }
        val doc = resolve(ctx, tree, segments)
            ?: return Json.err("connected_app_not_found", "文件不存在：${displayPath(segments)}")
        if (doc.isDir) {
            return Json.err("connected_app_bad_request", "不能读取目录：${displayPath(segments)}")
        }
        // 原生硬上限 1MB；调用方可再传更小的 maxBytes，但不会被放大。
        val maxBytes = payload.optInt("maxBytes", MAX_READ_BYTES).coerceIn(1, MAX_READ_BYTES)
        if (doc.size != null && doc.size > maxBytes) {
            return Json.err("connected_app_too_large", "文件超过读取上限（$maxBytes 字节）：${doc.size} 字节")
        }
        val input = ctx.contentResolver.openInputStream(doc.uri)
            ?: return Json.err("connected_app_not_found", "无法打开文件：${displayPath(segments)}")
        val bytes = input.use { readLimited(it, maxBytes) }
            ?: return Json.err("connected_app_too_large", "文件超过读取上限（$maxBytes 字节）")
        if (bytes.any { it == 0.toByte() }) {
            return Json.err("connected_app_not_text", "文件包含二进制内容（NUL），不是文本")
        }
        val text = String(bytes, Charsets.UTF_8)
        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("path", displayPath(segments))
                .put("displayName", doc.name)
                .put("content", text)
                .put("bytes", bytes.size)
                .put("truncated", false),
        )
    }

    private fun search(ctx: Context, tree: Uri, payload: JSONObject): JSONObject {
        val query = payload.optString("query").trim()
        if (query.isEmpty() || query.length > MAX_QUERY_CHARS) {
            return Json.err("connected_app_bad_request", "query 长度必须为 1..$MAX_QUERY_CHARS")
        }
        val startSegments = parseRelative(payload.optString("path"))
        val maxDepth = clamp(payload.optInt("maxDepth", 2), 1, MAX_SEARCH_DEPTH)
        val limit = clamp(payload.optInt("limit", 20), 1, MAX_SEARCH_LIMIT)
        val start = resolve(ctx, tree, startSegments)
            ?: return Json.err("connected_app_not_found", "目录不存在：${displayPath(startSegments)}")
        if (!start.isDir) {
            return Json.err("connected_app_bad_request", "搜索起点不是目录：${displayPath(startSegments)}")
        }

        data class Pending(val doc: DocRef, val path: String, val depth: Int)

        val queue = ArrayDeque<Pending>()
        queue.add(Pending(start, displayPath(startSegments), 0))
        val items = JSONArray()
        var scanned = 0
        var truncated = false

        loop@ while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            val children = queryChildren(ctx, tree, current.doc.docId)
            scanned += children.size
            if (scanned > MAX_SEARCH_SCAN) {
                truncated = true
            }
            for (child in children) {
                val childPath = joinPath(current.path, child.name)
                if (child.name.contains(query, ignoreCase = true)) {
                    items.put(childJson(child, childPath))
                    if (items.length() >= limit) {
                        truncated = true
                        break@loop
                    }
                }
                val childDepth = current.depth + 1
                if (child.isDir && childDepth < maxDepth) {
                    queue.add(Pending(child, childPath, childDepth))
                }
            }
            if (scanned > MAX_SEARCH_SCAN) break
        }

        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("path", displayPath(startSegments))
                .put("query", query)
                .put("items", items)
                .put("scanned", scanned)
                .put("truncated", truncated),
        )
    }

    private fun writeText(ctx: Context, tree: Uri, payload: JSONObject): JSONObject {
        val segments = parseRelative(payload.optString("path"))
        if (segments.isEmpty()) {
            return Json.err("connected_app_bad_request", "path 不能为空")
        }
        val bytes = payload.optString("content").toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_WRITE_BYTES) {
            return Json.err("connected_app_too_large", "写入内容超过 1MB（${bytes.size} 字节）")
        }
        val overwrite = payload.optBoolean("overwrite", false)
        val name = segments.last()
        val parentSegments = segments.dropLast(1)
        val parent = resolve(ctx, tree, parentSegments)
            ?: return Json.err("connected_app_not_found", "父目录不存在：${displayPath(parentSegments)}")
        if (!parent.isDir) {
            return Json.err("connected_app_bad_request", "父路径不是目录：${displayPath(parentSegments)}")
        }

        val existing = queryChildren(ctx, tree, parent.docId).firstOrNull { it.name == name }
        val target: DocRef
        if (existing != null) {
            if (existing.isDir) {
                return Json.err("connected_app_exists", "同名目录已存在：$name")
            }
            if (!overwrite) {
                return Json.err("connected_app_exists", "文件已存在：$name（需要覆盖请传 overwrite:true）")
            }
            target = existing
        } else {
            val created = DocumentsContract.createDocument(
                ctx.contentResolver,
                parent.uri,
                "text/plain",
                name,
            ) ?: return Json.err("connected_app_native_error", "provider 没有创建文件")
            target = docFromUri(ctx, tree, created)
                ?: DocRef(created, DocumentsContract.getDocumentId(created), name, false, null, null, null)
        }

        ctx.contentResolver.openOutputStream(target.uri, "wt")?.use { it.write(bytes) }
            ?: return Json.err("connected_app_native_error", "无法打开写入流")
        val actualPath = joinPath(displayPath(parentSegments), target.name)
        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("path", actualPath)
                .put("displayName", target.name)
                .put("bytes", bytes.size)
                .put("written", true),
        )
    }

    private fun createFolder(ctx: Context, tree: Uri, payload: JSONObject): JSONObject {
        val segments = parseRelative(payload.optString("path"))
        if (segments.isEmpty()) {
            return Json.err("connected_app_bad_request", "path 不能为空")
        }
        var current = queryDocument(ctx, tree, DocumentsContract.getTreeDocumentId(tree))
            ?: return Json.err("connected_app_no_root", "无法访问已授权的文件夹", "folder")
        val actual = mutableListOf<String>()
        for (segment in segments) {
            val child = queryChildren(ctx, tree, current.docId).firstOrNull { it.name == segment }
            if (child != null) {
                if (!child.isDir) {
                    return Json.err("connected_app_exists", "同名文件已存在：$segment")
                }
                current = child
                actual.add(child.name)
                continue
            }
            val created = DocumentsContract.createDocument(
                ctx.contentResolver,
                current.uri,
                DocumentsContract.Document.MIME_TYPE_DIR,
                segment,
            ) ?: return Json.err("connected_app_native_error", "provider 没有创建文件夹")
            val doc = docFromUri(ctx, tree, created)
                ?: return Json.err("connected_app_native_error", "provider 没有返回新文件夹")
            if (!doc.isDir) {
                return Json.err("connected_app_exists", "同名文件已存在：$segment")
            }
            current = doc
            actual.add(doc.name)
        }
        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("path", actual.joinToString("/"))
                .put("displayName", actual.lastOrNull() ?: "")
                .put("created", true)
                .put("segments", JSONArray(actual)),
        )
    }

    private fun delete(ctx: Context, tree: Uri, payload: JSONObject): JSONObject {
        val segments = parseRelative(payload.optString("path"))
        if (segments.isEmpty()) {
            return Json.err("connected_app_bad_request", "不能删除根目录")
        }
        val doc = resolve(ctx, tree, segments)
            ?: return Json.err("connected_app_not_found", "文件或目录不存在：${displayPath(segments)}")
        if (doc.isDir && queryChildren(ctx, tree, doc.docId).isNotEmpty()) {
            return Json.err(
                "connected_app_not_empty",
                "目录非空，未删除：${displayPath(segments)}",
            )
        }
        val deleted = DocumentsContract.deleteDocument(ctx.contentResolver, doc.uri)
        if (!deleted) {
            return Json.err("connected_app_native_error", "provider 拒绝删除：${displayPath(segments)}")
        }
        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("path", displayPath(segments))
                .put("type", if (doc.isDir) "dir" else "file")
                .put("deleted", true),
        )
    }

    private fun rename(ctx: Context, tree: Uri, payload: JSONObject): JSONObject {
        val fromSegments = parseRelative(payload.optString("from"))
        if (fromSegments.isEmpty()) {
            return Json.err("connected_app_bad_request", "from 不能为空")
        }
        val toName = payload.optString("to").trim()
        if (!isSingleName(toName)) {
            return Json.err("connected_app_bad_request", "to 必须是同目录下的文件名（不能含 /）")
        }
        val doc = resolve(ctx, tree, fromSegments)
            ?: return Json.err("connected_app_not_found", "文件或目录不存在：${displayPath(fromSegments)}")
        val parentSegments = fromSegments.dropLast(1)
        val parentPath = displayPath(parentSegments)
        if (doc.name == toName) {
            return Json.ok(
                JSONObject()
                    .put("root", ROOT_ID)
                    .put("from", displayPath(fromSegments))
                    .put("to", displayPath(fromSegments))
                    .put("displayName", doc.name)
                    .put("renamed", true),
            )
        }
        val parent = resolve(ctx, tree, parentSegments)
            ?: return Json.err("connected_app_not_found", "父目录不存在：$parentPath")
        if (queryChildren(ctx, tree, parent.docId).any { it.name == toName }) {
            return Json.err("connected_app_exists", "目标名称已存在：$toName")
        }
        val renamedUri = DocumentsContract.renameDocument(ctx.contentResolver, doc.uri, toName)
            ?: return Json.err("connected_app_native_error", "该文件夹的 provider 不支持重命名")
        val renamed = docFromUri(ctx, tree, renamedUri) ?: DocRef(
            renamedUri,
            DocumentsContract.getDocumentId(renamedUri),
            toName,
            doc.isDir,
            doc.size,
            doc.lastModified,
            doc.flags,
        )
        val actualPath = joinPath(parentPath, renamed.name)
        return Json.ok(
            JSONObject()
                .put("root", ROOT_ID)
                .put("from", displayPath(fromSegments))
                .put("to", actualPath)
                .put("displayName", renamed.name)
                .put("renamed", true),
        )
    }

    /* ---------------- 路径与文档解析 ---------------- */

    /** 相对路径 → 段；拒绝绝对、`..`、`.`、空段、NUL、超长。空字符串 = 根。 */
    private fun parseRelative(raw: String?): List<String> {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return emptyList()
        if (text.length > MAX_PATH_CHARS) {
            throw OpsError("connected_app_bad_request", "路径超过 $MAX_PATH_CHARS 字符")
        }
        if (text.startsWith("/")) {
            throw OpsError("connected_app_bad_request", "路径必须是相对路径")
        }
        val trimmed = text.trimEnd('/')
        if (trimmed.isEmpty()) return emptyList()
        val segments = trimmed.split('/')
        val result = ArrayList<String>(segments.size)
        for (segment in segments) {
            when {
                segment.isEmpty() -> throw OpsError("connected_app_bad_request", "路径不能包含空段")
                segment == "." || segment == ".." -> throw OpsError(
                    "connected_app_bad_request",
                    "路径不能包含 . 或 ..",
                )
                segment.length > MAX_SEGMENT_CHARS -> throw OpsError(
                    "connected_app_bad_request",
                    "路径单段超过 $MAX_SEGMENT_CHARS 字符",
                )
                segment.indexOf('\u0000') >= 0 -> throw OpsError(
                    "connected_app_bad_request",
                    "路径包含非法字符",
                )
                else -> result.add(segment)
            }
        }
        return result
    }

    private fun isSingleName(name: String): Boolean =
        name.isNotEmpty() &&
            name.length <= MAX_SEGMENT_CHARS &&
            name != "." &&
            name != ".." &&
            !name.contains('/') &&
            !name.contains('\u0000')

    private fun displayPath(segments: List<String>): String = segments.joinToString("/")

    private fun joinPath(parent: String, name: String): String =
        if (parent.isEmpty()) name else "$parent/$name"

    private fun resolve(ctx: Context, tree: Uri, segments: List<String>): DocRef? {
        var current = queryDocument(ctx, tree, DocumentsContract.getTreeDocumentId(tree)) ?: return null
        for (segment in segments) {
            if (!current.isDir) return null
            current = queryChildren(ctx, tree, current.docId).firstOrNull { it.name == segment }
                ?: return null
        }
        return current
    }

    private fun queryDocument(ctx: Context, tree: Uri, docId: String): DocRef? {
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
        val cursor = ctx.contentResolver.query(uri, PROJECTION, null, null, null) ?: return null
        return cursor.use {
            if (!it.moveToFirst()) return null
            rowToDoc(it, tree, docId, uri)
        }
    }

    private fun queryChildren(ctx: Context, tree: Uri, parentDocId: String): List<DocRef> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId)
        val cursor = ctx.contentResolver.query(uri, PROJECTION, null, null, null)
            ?: return emptyList()
        return cursor.use { c ->
            val result = ArrayList<DocRef>(c.count)
            while (c.moveToNext()) {
                val child = rowToDoc(c, tree, parentDocId, null) ?: continue
                result.add(child)
            }
            result
        }
    }

    private fun rowToDoc(
        c: Cursor,
        tree: Uri,
        fallbackDocId: String,
        fallbackUri: Uri?,
    ): DocRef? {
        val docId = c.stringAt(c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID))
            ?: fallbackDocId
        val name = c.stringAt(c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME))
            ?: docId.substringAfterLast('/').takeIf { it.isNotBlank() }
            ?: return null
        val mime = c.stringAt(c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE))
        val size = c.longAt(c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE))
        val modified = c.longAt(c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED))
        val flags = c.intAt(c.getColumnIndex(DocumentsContract.Document.COLUMN_FLAGS))
        val uri = fallbackUri ?: DocumentsContract.buildDocumentUriUsingTree(tree, docId)
        return DocRef(
            uri = uri,
            docId = docId,
            name = name,
            isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR,
            size = size,
            lastModified = modified,
            flags = flags,
        )
    }

    private fun docFromUri(ctx: Context, tree: Uri, uri: Uri): DocRef? {
        val docId = try {
            DocumentsContract.getDocumentId(uri)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return queryDocument(ctx, tree, docId)
    }

    private fun childJson(doc: DocRef, path: String): JSONObject = JSONObject()
        .put("name", doc.name)
        .put("path", path)
        .put("type", if (doc.isDir) "dir" else "file")
        .put("size", doc.size ?: JSONObject.NULL)
        .put("lastModified", doc.lastModified ?: JSONObject.NULL)

    /** 读不超过 max 字节；超出返回 null（调用方报 too_large）。 */
    private fun readLimited(input: InputStream, max: Int): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(READ_BUFFER)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > max) return null
        }
        return out.toByteArray()
    }

    private fun clamp(value: Int, min: Int, max: Int): Int = value.coerceIn(min, max)
}

private fun Cursor.stringAt(index: Int): String? =
    if (index >= 0 && !isNull(index)) getString(index) else null

private fun Cursor.longAt(index: Int): Long? =
    if (index >= 0 && !isNull(index)) getLong(index) else null

private fun Cursor.intAt(index: Int): Int? =
    if (index >= 0 && !isNull(index)) getInt(index) else null
