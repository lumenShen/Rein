# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ---------------------------------------------------------------------------
# 手工维护的 Kotlin 桥接类：只被 Rust 经 JNI 反射调用（modules/tracking 的
# call_static_method），R8 静态分析看不到 JNI 引用，release 混淆会把方法裁掉，
# 运行时 NoSuchMethodError 闪退（如打开跑步页崩溃）。必须整类保留。
# ---------------------------------------------------------------------------
-keep class com.gozaoo.rein.TrackingBridge { *; }
-keep class com.gozaoo.rein.RunTrackingService { *; }
# UpdateBridge 同理：Rust 经 JNI 反射调 install/snapshot（modules/update 的
# call_static_method）。漏了这条的后果实测就是「点安装并更新 → 闪退」：
# release 包把 install 方法裁掉，JNI 调用抛 NoSuchMethodError。
-keep class com.gozaoo.rein.UpdateBridge { *; }
# HealthConnectBridge 同理：Rust 经 JNI 反射调 refresh / requestPermissions /
# startRead / startWrite / deleteRecord（modules/healthsync 的 call_static_method）。
# 漏了它的后果和前两个一样，只是触发点更靠后：点「立即同步」才闪退。
-keep class com.gozaoo.rein.HealthConnectBridge { *; }
# GlobalFloatBridge：Rust 经 JNI 反射调 enable / disable / requestPermission / update /
# setForm / onAppForeground / snapshot / takeAction（modules/float 的 call_static_method）。
# 漏了它 = 系统浮窗开关一拨就闪退（NoSuchMethodError），且只在 release 包复现。
-keep class com.gozaoo.rein.GlobalFloatBridge { *; }
# GlobalFloatService：前台服务由 manifest 按类名实例化，且经 GlobalFloatBridge 静态实例
# 转发 update / setForm / 前台态（同 RunTrackingService 的保留理由）。
-keep class com.gozaoo.rein.GlobalFloatService { *; }