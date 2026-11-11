package com.gozaoo.rein.connectedapps

import android.Manifest
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.function.Consumer

/**
 * 位置（只读）：一次定位 / 最后已知位置。
 *
 * - 只返回 lat/lng/accuracy/time/provider，不做逆地理编码、不联网、不记录轨迹。
 * - API 30+ 用 `getCurrentLocation` + `CancellationSignal`；API 24..29 用
 *   `requestSingleUpdate` + `CountDownLatch`。等待上限 `min(timeoutMs, 15000)`。
 * - 超时先回退 `getLastKnownLocation`（带 `stale:true`、`timeout:true`）；
 *   连最后位置都没有时才返回结构化错误 `connected_app_timeout`。
 * - `handle` 在 Bridge 的 IO 线程执行，阻塞等待不会卡主线程。
 */
internal object LocationOps : ConnectedAppOps {
    private const val MIN_TIMEOUT_MS = 1_000
    private const val MAX_TIMEOUT_MS = 15_000
    private const val DEFAULT_TIMEOUT_MS = 8_000

    private val CAPABILITIES = listOf("get_current_location", "get_last_known_location")

    private val PERMISSIONS = listOf(
        OpsPermission("location"),
    )

    override fun permissions(): List<OpsPermission> = PERMISSIONS

    override fun status(ctx: Context): JSONObject {
        val manager = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        val fine = PermissionMap.hasPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = PermissionMap.hasPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
        val granted = fine || coarse
        val servicesOn = manager != null &&
            (providerEnabled(manager, LocationManager.GPS_PROVIDER) ||
                providerEnabled(manager, LocationManager.NETWORK_PROVIDER))
        val available = manager != null && servicesOn
        val permissions = org.json.JSONArray().put(
            JSONObject().put("key", "location").put("granted", granted),
        )
        val detail = when {
            manager == null -> "设备没有 LocationManager"
            !servicesOn -> "系统定位服务已关闭，请先在系统设置里打开定位"
            !granted -> "位置权限未授予，点「去授权」后在系统弹窗选择允许"
            !fine -> "仅大致位置（COARSE_LOCATION），精度可能较低"
            else -> null
        }
        return baseStatus(
            permissions = permissions,
            capabilities = org.json.JSONArray(CAPABILITIES),
            supported = true,
            available = available,
            detail = detail,
        )
    }

    override fun request(ctx: Context, mode: String): JSONObject {
        // 运行时权限必须由前台 Activity 的 launcher 申请（Bridge 的 permissions 模式），
        // 这里只兜底「去系统设置」。
        if (mode == "settings") {
            return try {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.applicationContext.startActivity(intent)
                JSONObject().put("opened", true)
            } catch (t: Throwable) {
                JSONObject()
                    .put("opened", false)
                    .put("reason", "无法打开应用设置：${t.javaClass.simpleName}")
            }
        }
        return JSONObject()
            .put("opened", false)
            .put("reason", "位置权限需要在前台界面申请（permissions 模式）")
    }

    override fun handle(ctx: Context, method: String, payload: JSONObject): JSONObject {
        if (!hasLocationPermission(ctx)) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少位置权限，请到「连接应用 → 安卓位置」点「去授权」",
                "permissions",
            )
        }
        val manager = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: throw OpsError("connected_app_unavailable", "设备没有 LocationManager")
        return when (method) {
            "get_current_location" -> currentLocation(ctx, manager, payload)
            "get_last_known_location" -> lastKnownLocation(manager)
            else -> throw OpsError(
                "connected_app_unknown_method",
                "位置不支持方法 $method",
            )
        }
    }

    /* ---------------- 当前定位 ---------------- */

    private fun currentLocation(
        ctx: Context,
        manager: LocationManager,
        payload: JSONObject,
    ): JSONObject {
        val timeoutMs = payload.optInt("timeout_ms", payload.optInt("timeoutMs", DEFAULT_TIMEOUT_MS))
            .coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
        val highAccuracy = if (payload.has("highAccuracy")) {
            payload.optBoolean("highAccuracy", true)
        } else if (payload.has("high_accuracy")) {
            payload.optBoolean("high_accuracy", true)
        } else {
            true
        }
        val provider = chooseProvider(manager, highAccuracy)
            ?: throw OpsError(
                "connected_app_unavailable",
                "系统定位服务已关闭（GPS 与网络定位都不可用）",
            )

        val started = SystemClock.elapsedRealtime()
        val location = if (Build.VERSION.SDK_INT >= 30) {
            currentApi30(ctx, manager, provider, timeoutMs)
        } else {
            currentLegacy(manager, provider, timeoutMs)
        }
        val elapsed = (SystemClock.elapsedRealtime() - started).toInt()

        if (location != null) {
            return Json.ok(locationJson(location, stale = false, timeout = false, elapsedMs = elapsed))
        }

        // 超时回退：最后已知位置仍然有参考价值，明确标 stale/timeout。
        val last = lastKnown(manager)
            ?: throw OpsError(
                "connected_app_timeout",
                "定位超时（${timeoutMs}ms），且系统没有可用的最后位置",
            )
        return Json.ok(locationJson(last, stale = true, timeout = true, elapsedMs = elapsed))
    }

    private fun currentApi30(
        ctx: Context,
        manager: LocationManager,
        provider: String,
        timeoutMs: Int,
    ): Location? {
        val signal = CancellationSignal()
        val latch = CountDownLatch(1)
        var result: Location? = null
        val consumer = Consumer<Location> { location ->
            result = location
            latch.countDown()
        }
        return try {
            manager.getCurrentLocation(provider, signal, ContextCompat.getMainExecutor(ctx), consumer)
            if (latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) result else {
                signal.cancel()
                null
            }
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少位置权限，请到「连接应用 → 安卓位置」点「去授权」",
                "permissions",
            )
        } catch (t: Throwable) {
            // 部分 ROM 的 fused provider 会抛 IllegalArgumentException；交给超时回退。
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun currentLegacy(
        manager: LocationManager,
        provider: String,
        timeoutMs: Int,
    ): Location? {
        val latch = CountDownLatch(1)
        var result: Location? = null
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                result = location
                latch.countDown()
            }

            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
            override fun onProviderEnabled(provider: String) = Unit
            override fun onProviderDisabled(provider: String) = Unit
        }
        return try {
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            val arrived = latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            manager.removeUpdates(listener)
            if (arrived) result else null
        } catch (e: SecurityException) {
            throw OpsError(
                "connected_app_permission_denied",
                "缺少位置权限，请到「连接应用 → 安卓位置」点「去授权」",
                "permissions",
            )
        } catch (t: Throwable) {
            null
        }
    }

    /* ---------------- 最后已知位置 ---------------- */

    private fun lastKnownLocation(manager: LocationManager): JSONObject {
        val location = lastKnown(manager)
            ?: return Json.ok(
                JSONObject()
                    .put("latitude", JSONObject.NULL)
                    .put("longitude", JSONObject.NULL)
                    .put("accuracy", JSONObject.NULL)
                    .put("time", JSONObject.NULL)
                    .put("provider", JSONObject.NULL)
                    .put("stale", true)
                    .put("timeout", false)
                    .put("elapsedMs", 0),
            )
        return Json.ok(locationJson(location, stale = true, timeout = false, elapsedMs = 0))
    }

    private fun lastKnown(manager: LocationManager): Location? {
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        )
        var best: Location? = null
        for (provider in providers) {
            val candidate = try {
                manager.getLastKnownLocation(provider)
            } catch (_: SecurityException) {
                throw OpsError(
                    "connected_app_permission_denied",
                    "缺少位置权限，请到「连接应用 → 安卓位置」点「去授权」",
                    "permissions",
                )
            } catch (_: Throwable) {
                null
            } ?: continue
            if (best == null || candidate.time > best.time) best = candidate
        }
        return best
    }

    /* ---------------- 小工具 ---------------- */

    private fun hasLocationPermission(ctx: Context): Boolean =
        PermissionMap.hasPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ||
            PermissionMap.hasPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun providerEnabled(manager: LocationManager, provider: String): Boolean = try {
        manager.isProviderEnabled(provider)
    } catch (_: Throwable) {
        false
    }

    private fun chooseProvider(manager: LocationManager, highAccuracy: Boolean): String? {
        val gps = providerEnabled(manager, LocationManager.GPS_PROVIDER)
        val network = providerEnabled(manager, LocationManager.NETWORK_PROVIDER)
        return when {
            highAccuracy && gps -> LocationManager.GPS_PROVIDER
            network -> LocationManager.NETWORK_PROVIDER
            gps -> LocationManager.GPS_PROVIDER
            else -> null
        }
    }

    private fun locationJson(
        location: Location,
        stale: Boolean,
        timeout: Boolean,
        elapsedMs: Int,
    ): JSONObject = JSONObject()
        .put("latitude", location.latitude)
        .put("longitude", location.longitude)
        .put("accuracy", if (location.hasAccuracy()) location.accuracy.toDouble() else JSONObject.NULL)
        .put("time", if (location.time > 0L) isoTime(location.time) else JSONObject.NULL)
        .put("provider", location.provider ?: JSONObject.NULL)
        .put("stale", stale)
        .put("timeout", timeout)
        .put("elapsedMs", elapsedMs)

    private fun isoTime(millis: Long): String = Instant.ofEpochMilli(millis).toString()
}
