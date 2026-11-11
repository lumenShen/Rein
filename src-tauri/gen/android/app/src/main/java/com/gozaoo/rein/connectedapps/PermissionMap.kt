package com.gozaoo.rein.connectedapps

import android.Manifest
import android.app.AppOpsManager
import android.app.SearchManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.AlarmClock
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * app → 运行时权限 / 特殊设置 / SAF 的唯一映射。
 *
 * `status` 与 `request` 共用这一份，避免「页面说要授权、桥却申请另一组权限」。
 * key 必须与 Rust `state::PermissionSpec`、TS `config/connectedApps.ts` 同名。
 */
internal data class PermissionDecl(
    val key: String,
    val androidPermission: String? = null,
    val kind: String = "runtime",
    val action: String? = null,
    val required: Boolean = true,
)

internal object PermissionMap {
    private const val PREFS = "rein_connected_apps"
    private const val TREE_KEY = "saf_tree"
    private const val TREE_LABEL_KEY = "saf_tree_label"

    fun declarations(app: String): List<PermissionDecl> = when (app) {
        "alarm" -> listOf(
            PermissionDecl("clock_app", kind = "normal"),
            PermissionDecl("clock_write", kind = "consent", required = false),
        )
        "usage" -> listOf(
            PermissionDecl("usage_access", kind = "special", action = "usage_access"),
        )
        "calendar" -> listOf(
            PermissionDecl("read_calendar", Manifest.permission.READ_CALENDAR, action = "permissions"),
            PermissionDecl(
                "write_calendar",
                Manifest.permission.WRITE_CALENDAR,
                action = "permissions_write",
                required = false,
            ),
        )
        "contacts" -> listOf(
            PermissionDecl("read_contacts", Manifest.permission.READ_CONTACTS, action = "permissions"),
            PermissionDecl(
                "write_contacts",
                Manifest.permission.WRITE_CONTACTS,
                action = "permissions_write",
                required = false,
            ),
        )
        "filesystem" -> listOf(
            PermissionDecl("saf_tree", kind = "folder", action = "folder"),
            PermissionDecl("saf_tree_write", kind = "folder", action = "folder", required = false),
        )
        "location" -> listOf(
            PermissionDecl("location", Manifest.permission.ACCESS_FINE_LOCATION, action = "permissions"),
        )
        "notification" -> listOf(
            PermissionDecl("notification_access", kind = "special", action = "notification_access"),
            PermissionDecl("notification_dismiss", kind = "consent", required = false),
        )
        "sms" -> listOf(
            PermissionDecl("read_sms", Manifest.permission.READ_SMS, action = "permissions"),
            PermissionDecl(
                "send_sms",
                Manifest.permission.SEND_SMS,
                action = "permissions_write",
                required = false,
            ),
        )
        else -> emptyList()
    }

    fun granted(ctx: Context, app: String, decl: PermissionDecl): Boolean = when (decl.key) {
        "clock_app", "clock_write" -> hasClockApp(ctx)
        "saf_tree", "saf_tree_write" -> tree(ctx) != null
        "usage_access" -> hasUsageAccess(ctx)
        "notification_access", "notification_dismiss" -> hasNotificationAccess(ctx)
        "location" ->
            hasPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ||
                hasPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
        else -> decl.androidPermission?.let { hasPermission(ctx, it) } ?: false
    }

    /** `permissions` 模式：只申请连接必需的读权限（位置按 FINE+COARSE 一起要）。 */
    fun runtimePermissions(app: String): Array<String> = when (app) {
        "calendar" -> arrayOf(Manifest.permission.READ_CALENDAR)
        "contacts" -> arrayOf(Manifest.permission.READ_CONTACTS)
        "sms" -> arrayOf(Manifest.permission.READ_SMS)
        "location" -> arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        else -> emptyArray()
    }

    /** `permissions_write` 模式：只申请写权限；其它 app 无 OS 写权限（no-op）。 */
    fun runtimeWritePermissions(app: String): Array<String> = when (app) {
        "calendar" -> arrayOf(Manifest.permission.WRITE_CALENDAR)
        "contacts" -> arrayOf(Manifest.permission.WRITE_CONTACTS)
        "sms" -> arrayOf(Manifest.permission.SEND_SMS)
        else -> emptyArray()
    }

    /** 特殊权限设置页；runtime 权限 / SAF 返回 null（由 Bridge 的 launcher 负责）。 */
    fun specialAction(mode: String): String? = when (mode) {
        "usage_access" -> Settings.ACTION_USAGE_ACCESS_SETTINGS
        "notification_access" -> Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS
        "settings" -> Settings.ACTION_APPLICATION_DETAILS_SETTINGS
        else -> null
    }

    fun tree(ctx: Context): String? =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(TREE_KEY, null)

    fun treeLabel(ctx: Context): String? =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(TREE_LABEL_KEY, null)

    fun setTree(ctx: Context, uri: String?, label: String?) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (uri == null) {
            prefs.edit().remove(TREE_KEY).remove(TREE_LABEL_KEY).apply()
        } else {
            prefs.edit().putString(TREE_KEY, uri).putString(TREE_LABEL_KEY, label).apply()
        }
    }

    fun hasClockApp(ctx: Context): Boolean {
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
        return intent.resolveActivity(ctx.packageManager) != null
    }

    fun hasPermission(ctx: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

    fun hasUsageAccess(ctx: Context): Boolean {
        val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
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
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun hasNotificationAccess(ctx: Context): Boolean =
        NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

    /** 供未来搜索/短信 intent 使用，避免 IDE 认为 SearchManager 未被引用。 */
    @Suppress("unused")
    fun searchIntent(query: String): Intent =
        Intent(SearchManager.INTENT_ACTION_GLOBAL_SEARCH).putExtra(SearchManager.QUERY, query)
}
