package com.gozaoo.rein

import android.location.Location
import android.location.LocationListener
import android.os.Build
import android.os.Bundle

/**
 * 只做一件事：把 Android `LocationManager` 的原始回调交给 Rust。
 *
 * 请求/重注册/高精度参数全部在 Rust（`modules/tracking/location.rs`）；
 * 这个类不判断、不累计、不落盘，避免再出现一份 Kotlin 采集策略。
 *
 * JNI 符号：`Java_com_gozaoo_rein_RustLocationListener_nativeOnLocation`
 * （instance method，Rust 侧第二个参数是 jobject）。
 */
class RustLocationListener : LocationListener {
  override fun onLocationChanged(location: Location) {
    val hasAlt = location.hasAltitude()
    val hasAltAcc =
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy()
    nativeOnLocation(
      location.time,
      location.latitude,
      location.longitude,
      if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0,
      if (hasAlt) location.altitude else 0.0,
      if (hasAltAcc) location.verticalAccuracyMeters.toDouble() else 0.0,
      location.hasAccuracy(),
      hasAlt,
      hasAltAcc,
      location.provider ?: "",
    )
  }

  override fun onProviderEnabled(provider: String) {}

  override fun onProviderDisabled(provider: String) {}

  @Deprecated("Deprecated in API 29")
  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

  private external fun nativeOnLocation(
    t: Long,
    lat: Double,
    lon: Double,
    acc: Double,
    alt: Double,
    altAcc: Double,
    hasAcc: Boolean,
    hasAlt: Boolean,
    hasAltAcc: Boolean,
    provider: String,
  )

  companion object {
    init {
      System.loadLibrary("rein_lib")
    }
  }
}
