package com.gozaoo.rein

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.reflect.KClass

/**
 * Rust(JNI) ↔ Kotlin 的 Health Connect 桥。**只做 HC 的读/写/授权与时间窗聚合**，
 * 不懂 Rein 的业务字段 —— 两侧语义的翻译全在 Rust 的 modules/healthsync/adapter.rs。
 *
 * 为什么数据走文件而不是 JNI 返回值：`jni_handle().exec` 是发后不管的，
 * 而 HC 的读写在协程里完成，结果不可能在调用栈里返回。所以沿用分享收件箱
 * （ShareReceiver）那套：本桥把结果写进 `cacheDir` 下的 `health_sync` 目录里，
 * Rust 读同一个目录。JNI 只用来下达指令。
 *
 * （注意别在这个块注释里写通配路径：Kotlin 的块注释**可以嵌套**，
 * 「目录名斜杠星号」会被当成开了一个新的注释，然后整个文件都成了注释。）
 *
 * 文件即信号（这点很重要）：Rust 在发起操作**之前**先删掉对应的结果文件，
 * 然后「文件出现」就等于「这次操作成功了」。所以：
 * - 只有成功才写结果文件（失败只写 state.json 的 error，Rust 据此立刻收场，
 *   不必等超时）；
 * - 每次开始新操作先把上一次的 error 清掉。
 *
 * 授权：HC 的权限**没有**系统运行时弹窗那条路，只能在 HC 自己的界面上授予，
 * 所以这里注册 `PermissionController.createRequestPermissionResultContract()`。
 * 那个 launcher 必须在 Activity 创建时注册（见 MainActivity.onCreate）。
 *
 * 权限分四组（运动 / 活动与睡眠 / 身体成分 / 身体机能，见 CATEGORY_*）：
 * - 用户可以只授其中几组；授权页由前端按组发起（`requestPermissions` 的 mode）；
 * - 读取按权限**逐项放行** —— 没授权的类型不读（HC 对未授权类型的 readRecords
 *   直接抛 SecurityException，逐项放行才能让「只授运动组」的用户正常同步）；
 * - state.json 带回每组是否齐全（`grantedCategories`），前端据此引导补授权。
 */
object HealthConnectBridge {
  private const val TAG = "HealthConnectBridge"
  private const val SELF_PACKAGE = "com.gozaoo.rein"

  private const val DIR = "health_sync"
  private const val STATE_FILE = "state.json"
  private const val PULL_FILE = "pull.json"
  private const val PUSH_REQUEST_FILE = "push-request.json"
  private const val PUSH_RESULT_FILE = "push-result.json"

  /** 数据起点：运动会话读「有记录以来」。HC 里不可能有 2000 年以前的运动记录。 */
  private val EPOCH: Instant = Instant.parse("2000-01-01T00:00:00Z")

  /**
   * 会话读取下界的前移量。Rust 传来的下界是「本地日期」，而 HC 的时间是 UTC 瞬时 ——
   * 一条本地日期刚好等于下界的记录，其瞬时最多可能早于该日 UTC 零点 18 小时
   * （java.time.ZoneOffset 的偏移上限 +18:00）。前移 24h（> 18h）保证
   * 「本地日期 ≥ 下界」的记录一定落在读取窗口内，于是 Rust 侧「窗口内镜像不被误删」
   * 的不变量成立。⚠ 调到 18h 以内会重新引入跨时区记录被误判删除的问题；
   * 改这里必须连带复核 Rust 侧 commands.rs 里 seen_superset 的同一不变量。
   */
  private val WINDOW_MARGIN: Duration = Duration.ofHours(24)

  /** 体征指标的回看窗口：按天聚合的镜像值，90 天对预览与状态计算都够用 */
  private val METRICS_WINDOW = Duration.ofDays(90)

  /**
   * 读权限，按四组组织。权限串直接写常量而不是 `HealthPermission.getReadPermission(KClass)`：
   * 常量值就是 `android.permission.health.READ_<RECORD>`（HC 的 PERMISSION_PREFIX
   * + 记录类型名），小米运动健康在它的清单里声明的也是这几个同名字符串，
   * 写死比多引一层 API 更清楚。
   */

  /** 运动：导入课程与记录的根基；新桥按分组授权放行其它组 */
  private val CATEGORY_EXERCISE =
    setOf(
      "android.permission.health.READ_EXERCISE",
      "android.permission.health.READ_TOTAL_CALORIES_BURNED",
      "android.permission.health.READ_DISTANCE",
      "android.permission.health.READ_HEART_RATE",
    )

  /** 活动与睡眠：每日步数、睡眠时长与深睡/REM 明细 */
  private val CATEGORY_ACTIVITY =
    setOf(
      "android.permission.health.READ_STEPS",
      "android.permission.health.READ_SLEEP",
    )

  /** 身体成分：体重、体脂、身高、基础代谢（用真实测量替代手填档案） */
  private val CATEGORY_BODY =
    setOf(
      "android.permission.health.READ_WEIGHT",
      "android.permission.health.READ_BODY_FAT",
      "android.permission.health.READ_HEIGHT",
      "android.permission.health.READ_BASAL_METABOLIC_RATE",
    )

  /** 身体机能：心肺与恢复状态（静息心率、HRV、血氧、呼吸率、体温、摄氧量、血压） */
  private val CATEGORY_VITALS =
    setOf(
      "android.permission.health.READ_RESTING_HEART_RATE",
      "android.permission.health.READ_HEART_RATE_VARIABILITY",
      "android.permission.health.READ_OXYGEN_SATURATION",
      "android.permission.health.READ_RESPIRATORY_RATE",
      "android.permission.health.READ_BODY_TEMPERATURE",
      "android.permission.health.READ_VO2_MAX",
      "android.permission.health.READ_BLOOD_PRESSURE",
    )

  private val READ_PERMS = CATEGORY_EXERCISE + CATEGORY_ACTIVITY + CATEGORY_BODY + CATEGORY_VITALS

  private val WRITE_PERMS = setOf("android.permission.health.WRITE_EXERCISE")

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val main = Handler(Looper.getMainLooper())

  /** HC 授权界面的 launcher（Activity 创建时注册） */
  private var launcher: ActivityResultLauncher<Set<String>>? = null

  /** MainActivity.onCreate 调用一次 */
  fun register(activity: ComponentActivity) {
    launcher =
      activity.registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
      ) {
        // 用户从 HC 界面回来了：立刻重算一遍授权状态写进 state.json
        Log.i(TAG, "授权页返回")
        scope.launch { writeState(activity.applicationContext) }
      }
    Log.i(TAG, "register 完成")
  }

  /* ---------------- 指令入口（Rust 经 JNI 调这些） ---------------- */

  /** 重算可用性与授权，写 state.json */
  // @JvmStatic 是必须的：Rust 侧用 call_static_method 按名字找方法，
  // 而 Kotlin object 的成员默认是**单例上的实例方法**（要经 INSTANCE 调用）。
  // 漏掉的后果实测过一次：NoSuchMethodError 抛在主线程 → 点开这一页就闪退。
  @JvmStatic
  fun refresh(context: Context) {
    val app = context.applicationContext
    scope.launch { writeState(app) }
  }

  /**
   * 拉起 HC 的授权页。
   *
   * `mode` 决定这次要哪些权限：
   * - `read`：全部读权限；`write`：全部读 + 写；
   * - `exercise` / `activity` / `body` / `vitals`：只要那一组（前端按组引导补授权），
   *   分组口径与前端 `src/config/healthMetrics.ts` 的 HEALTH_CATEGORIES 一一对应。
   */
  @JvmStatic
  fun requestPermissions(context: Context, mode: String) {
    val app = context.applicationContext
    val wanted =
      when (mode) {
        "write" -> READ_PERMS + WRITE_PERMS
        "exercise" -> CATEGORY_EXERCISE
        "activity" -> CATEGORY_ACTIVITY
        "body" -> CATEGORY_BODY
        "vitals" -> CATEGORY_VITALS
        else -> READ_PERMS
      }
    Log.i(TAG, "requestPermissions(mode=$mode, perms=${wanted.size}, launcher=${launcher != null})")
    main.post {
      val l = launcher
      if (l == null) {
        // 理论不可达（register 在 onCreate 里）。写入原因让前端能给出可操作的提示。
        Log.w(TAG, "授权 launcher 为空，register 没有执行过")
        scope.launch {
          writeState(app, error = "授权入口未就绪，请重开应用")
        }
        return@post
      }
      try {
        l.launch(wanted)
        Log.i(TAG, "已发起 HC 授权页")
      } catch (e: Exception) {
        Log.e(TAG, "发起授权失败，退回 HC 设置页", e)
        // 兜底：直接打开 Health Connect 自己的设置页，用户在那里也能把权限授予 Rein。
        // 为什么值得有这条：授权弹窗是 HC 模块在系统侧生成的 intent，各家 ROM 上
        // 能解析到什么程度不一致 —— 有兜底就不会出现「点了没反应」这种最糟的结果。
        val opened = openHealthConnectSettings(app)
        scope.launch {
          writeState(
            app,
            error = if (opened) null else "无法打开健康数据授权页：${e.message}",
          )
        }
      }
    }
  }

  /**
   * 打开系统的 Health Connect 设置页（授权弹窗拉不起来时的兜底落点）。
   *
   * 这里用字面量 action 而不是库里的 `getHealthConnectSettingsAction()`：
   * 这个串在目标机型上**实测能解析**（落到 `com.android.healthconnect.controller/
   * .navigation.TrampolineActivity`），而成员名在同一版本里叫法不一，
   * 有实测值就别去赌 API 名。
   */
  private fun openHealthConnectSettings(context: Context): Boolean =
    try {
      context.startActivity(
        Intent("android.health.connect.action.HEALTH_HOME_SETTINGS")
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
      Log.i(TAG, "已打开 HC 设置页")
      true
    } catch (e: Exception) {
      Log.w(TAG, "打开 HC 设置页也失败", e)
      false
    }

  /**
   * 读 HC 的运动会话（含配对出的消耗/距离/心率）+ 体征指标，写 pull.json。
   *
   * `since` 是 Rust 传来的读取下界（`YYYY-MM-DD`）—— 用户可配「同步起始日期」，
   * 或由程序自动取本机最早导入记录。空串或不可解析一律回退 [`EPOCH`]：
   * 宁可多读，也别让一个坏参数把窗口收到错的起点。
   *
   * 注意体征指标的 90 天窗口**不受** `since` 影响：那是每轮整表替换的本地预览镜像，
   * 放开到全历史只会让它无界增长（见 Rust 侧 outOfScope）。
   */
  @JvmStatic
  fun startRead(context: Context, since: String) {
    val app = context.applicationContext
    scope.launch {
      try {
        val client = clientOrNull(app) ?: return@launch fail(app, "Health Connect 不可用")
        val now = Instant.now()
        // 会话读取下界：把日期锚到 UTC 零点再前移 WINDOW_MARGIN，且不早于 EPOCH
        val readFrom = windowStartOf(since)
        // 授权集合一次取齐，后面每个读取按自己的权限独立放行：
        // 只授了「运动」组的用户照常导课，体征部分留空 —— 而不是让一个
        // SecurityException 炸掉整轮同步。
        val granted =
          try {
            client.permissionController.getGrantedPermissions()
          } catch (e: Exception) {
            Log.w(TAG, "读取授权集合失败，按空集处理", e)
            emptySet<String>()
          }
        val sessions =
          if ("android.permission.health.READ_EXERCISE" in granted) {
            readAll(client, ExerciseSessionRecord::class, readFrom, now)
          } else {
            emptyList()
          }

        // 三类附加记录：HC 里它们与运动会话没有外键，只能按时间重叠配对
        val from = sessions.minOfOrNull { it.startTime } ?: now
        val to = sessions.maxOfOrNull { it.endTime } ?: now
        val energy =
          if ("android.permission.health.READ_TOTAL_CALORIES_BURNED" !in granted || sessions.isEmpty()) emptyList()
          else readAll(client, TotalCaloriesBurnedRecord::class, from, to)
        val distance =
          if ("android.permission.health.READ_DISTANCE" !in granted || sessions.isEmpty()) emptyList()
          else readAll(client, DistanceRecord::class, from, to)
        val heart =
          if ("android.permission.health.READ_HEART_RATE" !in granted || sessions.isEmpty()) emptyList()
          else readAll(client, HeartRateRecord::class, from, to)

        val kcal = assignByOverlap(sessions, energy) { _, r -> r.energy.inKilocalories }
        val meters = assignByOverlap(sessions, distance) { _, r -> r.distance.inMeters }
        val avgHr = averageHeartRate(sessions, heart)

        val records = JSONArray()
        sessions.forEachIndexed { index, s ->
          val offset = s.startZoneOffset ?: ZoneOffset.UTC
          val obj = JSONObject()
          obj.put("id", s.metadata.id)
          obj.put("exerciseType", s.exerciseType)
          obj.put("title", s.title ?: JSONObject.NULL)
          obj.put("notes", s.notes ?: JSONObject.NULL)
          obj.put("startEpochMs", s.startTime.toEpochMilli())
          obj.put("endEpochMs", s.endTime.toEpochMilli())
          obj.put("utcOffsetSeconds", offset.totalSeconds)
          obj.put("lastModifiedEpochMs", s.metadata.lastModifiedTime.toEpochMilli())
          obj.put("dataOrigin", s.metadata.dataOrigin.packageName)
          obj.put("kcal", kcal[index] ?: JSONObject.NULL)
          obj.put("distanceM", meters[index] ?: JSONObject.NULL)
          obj.put("avgHeartRate", avgHr[index] ?: JSONObject.NULL)
          records.put(obj)
        }
        val metrics = readMetrics(client, granted, now)
        writeFile(
          app,
          PULL_FILE,
          JSONObject().put("records", records).put("metrics", metrics).toString(),
        )
        writeState(app)
      } catch (e: Exception) {
        Log.e(TAG, "读取健康数据失败", e)
        fail(app, "读取健康数据失败：${e.message}")
      }
    }
  }

  /**
   * 体征指标：近 [`METRICS_WINDOW`]，按天聚合成 `(metric, day, value)` 行。
   *
   * 每个类型只在自己授权到位时才读（见 startRead 顶部的说明）。聚合口径：
   * - 累加类：步数（手环一小时同步一次，一天几十条）、睡眠（分段时长求和）；
   * - 当天最后一次：体重/体脂/身高（「这天上秤值」）、血压（两条成对取同一末值）、
   *   最大摄氧量与基础代谢（写入方按天给估计值）；
   * - 平均：静息心率、HRV、血氧、呼吸率、体温（一晚打几十个点的密集采样，
   *   平均才是「这一天的状态」）。
   *
   * metric id 与前端 `src/config/healthMetrics.ts` 的 `HEALTH_METRICS` 一一对应，
   * 两边改一边就得改另一边。
   */
  private suspend fun readMetrics(
    client: HealthConnectClient,
    granted: Set<String>,
    now: Instant,
  ): JSONArray {
    val from = now.minus(METRICS_WINDOW)
    val metrics = JSONArray()
    fun put(metric: String, day: String, value: Double) {
      metrics.put(JSONObject().put("metric", metric).put("day", day).put("value", value))
    }

    // 瞬时类指标的统一通道：读 → (时刻, 时区, 数值) → 按天聚合。
    // `lastWins` = 当天多次读数取最后一次（上秤体重以最新一次为准），
    // 否则取平均（一晚几十个心率点，平均才是「这一天的状态」）。
    fun daily(
      metric: String,
      rows: List<Triple<Instant, ZoneOffset?, Double>>,
      lastWins: Boolean,
    ) {
      val perDay = LinkedHashMap<String, MutableList<Double>>()
      rows.sortedBy { it.first }.forEach { (time, offset, value) ->
        val day = time.atZone(offset ?: ZoneId.systemDefault()).toLocalDate().toString()
        perDay.getOrPut(day) { mutableListOf() }.add(value)
      }
      perDay.forEach { (day, values) ->
        put(metric, day, if (lastWins) values.last() else values.average())
      }
    }

    if ("android.permission.health.READ_STEPS" in granted) {
      val byDay = HashMap<String, Long>()
      readAll(client, StepsRecord::class, from, now).forEach { s ->
        val day =
          s.startTime.atZone(s.startZoneOffset ?: ZoneId.systemDefault()).toLocalDate().toString()
        byDay[day] = (byDay[day] ?: 0L) + s.count
      }
      byDay.forEach { (day, count) -> put("steps", day, count.toDouble()) }
    }

    if ("android.permission.health.READ_SLEEP" in granted) {
      // 归属日按「醒来那天」算：23 点睡、早上 7 点起，这一晚属于 7 点那天
      val byDay = HashMap<String, LongArray>() // [总睡眠, 深睡, REM]
      val asleepStages =
        setOf(
          SleepSessionRecord.STAGE_TYPE_SLEEPING,
          SleepSessionRecord.STAGE_TYPE_LIGHT,
          SleepSessionRecord.STAGE_TYPE_DEEP,
          SleepSessionRecord.STAGE_TYPE_REM,
        )
      readAll(client, SleepSessionRecord::class, from, now).forEach { s ->
        val day =
          s.endTime.atZone(s.endZoneOffset ?: ZoneId.systemDefault()).toLocalDate().toString()
        val bucket = byDay.getOrPut(day) { LongArray(3) }
        val minutes = { a: Instant, b: Instant -> Duration.between(a, b).toMinutes().coerceAtLeast(0) }
        if (s.stages.isEmpty()) {
          // 有的写入方不给分段，只有整段会话 —— 那就把整段时长当睡眠时长
          bucket[0] += minutes(s.startTime, s.endTime)
        } else {
          bucket[0] += s.stages.filter { it.stage in asleepStages }.sumOf { minutes(it.startTime, it.endTime) }
          bucket[1] += s.stages.filter { it.stage == SleepSessionRecord.STAGE_TYPE_DEEP }.sumOf { minutes(it.startTime, it.endTime) }
          bucket[2] += s.stages.filter { it.stage == SleepSessionRecord.STAGE_TYPE_REM }.sumOf { minutes(it.startTime, it.endTime) }
        }
      }
      byDay.forEach { (day, b) ->
        if (b[0] > 0) put("sleep_min", day, b[0].toDouble())
        if (b[1] > 0) put("sleep_deep_min", day, b[1].toDouble())
        if (b[2] > 0) put("sleep_rem_min", day, b[2].toDouble())
      }
    }

    if ("android.permission.health.READ_WEIGHT" in granted) {
      daily(
        "weight_kg",
        readAll(client, WeightRecord::class, from, now).map { Triple(it.time, it.zoneOffset, it.weight.inKilograms) },
        lastWins = true,
      )
    }
    if ("android.permission.health.READ_BODY_FAT" in granted) {
      daily(
        "body_fat_pct",
        readAll(client, BodyFatRecord::class, from, now).map { Triple(it.time, it.zoneOffset, it.percentage.value) },
        lastWins = true,
      )
    }
    if ("android.permission.health.READ_HEIGHT" in granted) {
      // HC 的身高是米，Rein 全库口径是厘米
      daily(
        "height_cm",
        readAll(client, HeightRecord::class, from, now).map { Triple(it.time, it.zoneOffset, it.height.inMeters * 100.0) },
        lastWins = true,
      )
    }
    if ("android.permission.health.READ_BASAL_METABOLIC_RATE" in granted) {
      daily(
        "bmr_kcal",
        readAll(client, BasalMetabolicRateRecord::class, from, now)
          .map { Triple(it.time, it.zoneOffset, it.basalMetabolicRate.inKilocaloriesPerDay) },
        lastWins = true,
      )
    }
    if ("android.permission.health.READ_RESTING_HEART_RATE" in granted) {
      daily(
        "resting_hr_bpm",
        readAll(client, RestingHeartRateRecord::class, from, now)
          .map { Triple(it.time, it.zoneOffset, it.beatsPerMinute.toDouble()) },
        lastWins = false,
      )
    }
    if ("android.permission.health.READ_HEART_RATE_VARIABILITY" in granted) {
      daily(
        "hrv_rmssd_ms",
        readAll(client, HeartRateVariabilityRmssdRecord::class, from, now)
          .map { Triple(it.time, it.zoneOffset, it.heartRateVariabilityMillis) },
        lastWins = false,
      )
    }
    if ("android.permission.health.READ_OXYGEN_SATURATION" in granted) {
      daily(
        "spo2_pct",
        readAll(client, OxygenSaturationRecord::class, from, now).map { Triple(it.time, it.zoneOffset, it.percentage.value) },
        lastWins = false,
      )
    }
    if ("android.permission.health.READ_RESPIRATORY_RATE" in granted) {
      daily(
        "resp_rate_bpm",
        readAll(client, RespiratoryRateRecord::class, from, now).map { Triple(it.time, it.zoneOffset, it.rate) },
        lastWins = false,
      )
    }
    if ("android.permission.health.READ_BODY_TEMPERATURE" in granted) {
      daily(
        "temp_c",
        readAll(client, BodyTemperatureRecord::class, from, now)
          .map { Triple(it.time, it.zoneOffset, it.temperature.inCelsius) },
        lastWins = false,
      )
    }
    if ("android.permission.health.READ_VO2_MAX" in granted) {
      daily(
        "vo2max_ml_kg_min",
        readAll(client, Vo2MaxRecord::class, from, now)
          .map { Triple(it.time, it.zoneOffset, it.vo2MillilitersPerMinuteKilogram) },
        lastWins = true,
      )
    }
    if ("android.permission.health.READ_BLOOD_PRESSURE" in granted) {
      // 收缩压/舒张压来自同一条记录：各自聚合成两行指标
      val bp = readAll(client, BloodPressureRecord::class, from, now)
      daily(
        "bp_sys_mmhg",
        bp.map { Triple(it.time, it.zoneOffset, it.systolic.inMillimetersOfMercury) },
        lastWins = true,
      )
      daily(
        "bp_dia_mmhg",
        bp.map { Triple(it.time, it.zoneOffset, it.diastolic.inMillimetersOfMercury) },
        lastWins = true,
      )
    }
    return metrics
  }

  /**
   * 把 push-request.json 里的记录写进 HC。
   *
   * 幂等靠 `clientRecordId`：先读出「本 App 写过的」记录，凡 clientRecordId 已在的
   * 先删再插（改一条已导出记录 = 重写）。这样即使上一次写到一半被杀，
   * 下一次也不会在 HC 里留下两条同样的记录。
   *
   * **签名必须是无参的**（除 Context 外）：Rust 按文件位置约定（cacheDir 下的
   * 固定文件名）把要写的内容先落盘，JNI 只需要喊一声「开始写」。这里要是一个
   * 带 path 的签名，Rust 的无参 JNI 调用就会 NoSuchMethodError —— 而且它被
   * 异常兜底吞掉之后，前端只会看到「超时」，极难排查（实测过一次）。
   */
  @JvmStatic
  fun startWrite(context: Context) {
    val app = context.applicationContext
    scope.launch {
      try {
        val client = clientOrNull(app) ?: return@launch fail(app, "Health Connect 不可用")
        val requestFile = File(File(app.cacheDir, DIR), PUSH_REQUEST_FILE)
        val request = JSONObject(requestFile.readText())
        val drafts = request.getJSONArray("records")
        if (drafts.length() == 0) {
          writeFile(app, PUSH_RESULT_FILE, JSONObject().put("results", JSONArray()).toString())
          writeState(app)
          return@launch
        }

        val own = readAll(
          client,
          ExerciseSessionRecord::class,
          EPOCH,
          Instant.now(),
          dataOrigin = setOf(DataOrigin(SELF_PACKAGE)),
        )
        val existing = HashMap<String, String>()
        own.forEach { r ->
          val crid = r.metadata.clientRecordId
          if (!crid.isNullOrEmpty()) existing[crid] = r.metadata.id
        }

        val toDelete = mutableListOf<String>()
        drafts.length().let { n ->
          for (i in 0 until n) {
            existing[drafts.getJSONObject(i).getString("clientRecordId")]?.let { toDelete.add(it) }
          }
        }
        if (toDelete.isNotEmpty()) {
          client.deleteRecords(ExerciseSessionRecord::class, toDelete, emptyList())
        }

        val zone = ZoneId.systemDefault()
        val records = mutableListOf<ExerciseSessionRecord>()
        for (i in 0 until drafts.length()) {
          val d = drafts.getJSONObject(i)
          val start = Instant.ofEpochMilli(d.getLong("startEpochMs"))
          val end = Instant.ofEpochMilli(d.getLong("endEpochMs"))
          records.add(
            ExerciseSessionRecord(
              startTime = start,
              startZoneOffset = zone.rules.getOffset(start),
              endTime = end,
              endZoneOffset = zone.rules.getOffset(end),
              metadata = Metadata.manualEntryWithId(d.getString("clientRecordId")),
              exerciseType = d.getInt("exerciseType"),
              title = if (d.isNull("title")) null else d.getString("title"),
              notes = if (d.isNull("notes")) null else d.getString("notes"),
            )
          )
        }

        val response = client.insertRecords(records)
        val results = JSONArray()
        response.recordIdsList.forEachIndexed { i, recordId ->
          results.put(
            JSONObject()
              .put("clientRecordId", drafts.getJSONObject(i).getString("clientRecordId"))
              .put("recordId", recordId)
          )
        }
        writeFile(app, PUSH_RESULT_FILE, JSONObject().put("results", results).toString())
        writeState(app)
      } catch (e: Exception) {
        Log.e(TAG, "写入健康数据失败", e)
        fail(app, "写入健康数据失败：${e.message}")
      }
    }
  }

  /** 删掉一条 Rein 写出去的记录（用户在 Rein 里删了那条运动记录） */
  @JvmStatic
  fun deleteRecord(context: Context, recordId: String) {
    val app = context.applicationContext
    scope.launch {
      try {
        val client = clientOrNull(app) ?: return@launch
        client.deleteRecords(ExerciseSessionRecord::class, listOf(recordId), emptyList())
      } catch (e: Exception) {
        // 删不掉不阻塞用户：本地已经删了，这里只记日志（下次同步还会断链重试）
        Log.w(TAG, "删除 HC 记录失败：$recordId", e)
      }
    }
  }

  /* ---------------- 内部 ---------------- */

  private fun clientOrNull(context: Context): HealthConnectClient? {
    val status = HealthConnectClient.getSdkStatus(context)
    if (status != HealthConnectClient.SDK_AVAILABLE) return null
    return try {
      HealthConnectClient.getOrCreate(context)
    } catch (e: Exception) {
      Log.e(TAG, "获取 HealthConnectClient 失败", e)
      null
    }
  }

  /**
   * Rust 传来的窗口下界（`YYYY-MM-DD`）→ 会话读取的 UTC 下界 Instant。
   *
   * 空串或不可解析回退 [`EPOCH`]；前移后若早于 EPOCH 也夹回 EPOCH ——
   * 「从头拉全部」用的就是 2000-01-01，前移 24h 会越过 EPOCH。
   */
  private fun windowStartOf(since: String): Instant =
    try {
      val anchor =
        LocalDate.parse(since).atStartOfDay(ZoneOffset.UTC).toInstant().minus(WINDOW_MARGIN)
      maxOf(EPOCH, anchor)
    } catch (e: Exception) {
      EPOCH
    }

  /** 失败路径：只写 state.json 的 error，**不写结果文件**（Rust 据此立刻收场） */
  private suspend fun fail(context: Context, message: String) {
    writeState(context, error = message)
  }

  /** 分页读完一个记录类型的全部记录（HC 单页上限 1000 条） */
  private suspend fun <T : Record> readAll(
    client: HealthConnectClient,
    recordType: KClass<T>,
    from: Instant,
    to: Instant,
    dataOrigin: Set<DataOrigin> = emptySet(),
  ): List<T> {
    val out = mutableListOf<T>()
    var token: String? = null
    do {
      val response =
        client.readRecords(
          ReadRecordsRequest(
            recordType,
            TimeRangeFilter.between(from, to),
            dataOriginFilter = dataOrigin,
            pageToken = token,
          )
        )
      out.addAll(response.records)
      token = response.pageToken
    } while (token != null)
    return out
  }

  /**
   * 按「与哪个会话重叠最多」把附加记录配给会话。
   *
   * 为什么不做按比例分摊：HC 里一条消耗记录通常就是一个会话写的一条，
   * 重叠最多的那个会话几乎总是它的主人；分摊只会引入一个更复杂、
   * 也更难解释的数字，而单位换算本身已经带了足够的误差。
   */
  private fun <T : Record> assignByOverlap(
    sessions: List<ExerciseSessionRecord>,
    records: List<T>,
    value: (Int, T) -> Double,
  ): List<Double?> {
    val sums = arrayOfNulls<Double>(sessions.size)
    records.forEach { r ->
      val (rs, re) = intervalOf(r) ?: return@forEach
      var best = -1
      var bestOverlap = 0L
      sessions.forEachIndexed { i, s ->
        val overlap = minOf(re, s.endTime.toEpochMilli()) - maxOf(rs, s.startTime.toEpochMilli())
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          best = i
        }
      }
      if (best >= 0) sums[best] = (sums[best] ?: 0.0) + value(best, r)
    }
    return sums.toList()
  }

  /**
   * 会话内的平均心率：把样本按「落在哪个会话里」归组再平均。
   * 样本本来就是密集的时序点，按重叠配给会话反而会把间隙算进去。
   */
  private fun averageHeartRate(
    sessions: List<ExerciseSessionRecord>,
    records: List<HeartRateRecord>,
  ): List<Double?> {
    val sum = DoubleArray(sessions.size)
    val count = IntArray(sessions.size)
    records.forEach { r ->
      r.samples.forEach { sample ->
        val t = sample.time.toEpochMilli()
        val i = sessions.indexOfFirst { t >= it.startTime.toEpochMilli() && t <= it.endTime.toEpochMilli() }
        if (i >= 0) {
          sum[i] += sample.beatsPerMinute.toDouble()
          count[i] += 1
        }
      }
    }
    return sessions.indices.map { if (count[it] > 0) sum[it] / count[it] else null }
  }

  /** 取一个区间记录的起止（毫秒）；认不出来的类型返回 null */
  private fun intervalOf(record: Record): Pair<Long, Long>? =
    when (record) {
      is TotalCaloriesBurnedRecord ->
        record.startTime.toEpochMilli() to record.endTime.toEpochMilli()
      is DistanceRecord -> record.startTime.toEpochMilli() to record.endTime.toEpochMilli()
      is HeartRateRecord -> record.startTime.toEpochMilli() to record.endTime.toEpochMilli()
      else -> null
    }

  private suspend fun writeState(context: Context, error: String? = null) {
    val availability =
      when (HealthConnectClient.getSdkStatus(context)) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
        else -> "unavailable"
      }
    var readGranted = false
    var writeGranted = false
    var categories = JSONObject()
    if (availability == "available") {
      try {
        val granted =
          HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
        // readGranted 保留旧语义（READ_EXERCISE）；Rust 会同时看 grantedCategories，
        // 任一组已授权即可开始同步，逐项读取会跳过没授权的类型。
        readGranted = "android.permission.health.READ_EXERCISE" in granted
        writeGranted = granted.containsAll(WRITE_PERMS)
        // 每组是否齐全：前端据此在数据源卡里逐组显示「已授权 / 去授权」
        categories =
          JSONObject()
            .put("exercise", granted.containsAll(CATEGORY_EXERCISE))
            .put("activity", granted.containsAll(CATEGORY_ACTIVITY))
            .put("body", granted.containsAll(CATEGORY_BODY))
            .put("vitals", granted.containsAll(CATEGORY_VITALS))
      } catch (e: Exception) {
        Log.w(TAG, "读取授权状态失败", e)
      }
    }
    val obj =
      JSONObject()
        .put("availability", availability)
        .put("readGranted", readGranted)
        .put("writeGranted", writeGranted)
        .put("grantedCategories", categories)
        .put("error", error ?: JSONObject.NULL)
    writeFile(context, STATE_FILE, obj.toString())
  }

  private fun writeFile(context: Context, name: String, text: String) {
    try {
      val dir = File(context.cacheDir, DIR)
      dir.mkdirs()
      val target = File(dir, name)
      // 先写 .part 再改名：Rust 用「文件存在」判断本轮完成，
      // 半截文件被读到会当成一次成功的解析失败（json 解析失败 → 被当成还没准备好）
      val part = File(dir, "$name.part")
      part.writeText(text)
      if (!part.renameTo(target)) {
        part.delete()
        Log.e(TAG, "改名失败：$part -> $target")
      }
    } catch (e: Exception) {
      Log.e(TAG, "写 $name 失败", e)
    }
  }
}
