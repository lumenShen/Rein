# 跑步定位采集 · Rust↔Kotlin JNI 契约

> 真源：`src-tauri/src/modules/tracking/location.rs`（采集请求）+ `src-tauri/gen/android/.../RunTrackingService.kt`（前台保活壳）+ `RustLocationListener.kt`（回调转发）。
> 本文是这三个文件之间 JNI 边界的**现行契约**（2026-10-22 审查后定稿）；`RUN-DEBOUNCE-REWORK.md` 里的采集间隔行号口径已过时（采集当时还在 Kotlin，现已搬去 Rust）。

## 1. 职责分层（改代码前先读）

| 层 | 文件 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| Rust 采集 | `modules/tracking/location.rs` | 持有 LocationManager 请求（fused/GPS、高精度参数、1s/500ms）、注册/摘除/重注册 | 不记账、不落盘、不做精度判定 |
| Kotlin 回调壳 | `RustLocationListener.kt` | 把 Location 原始值转交 Rust | 不判断、不累计 |
| Kotlin 前台服务 | `RunTrackingService.kt` | 前台保活、WakeLock、通知渲染、轨迹文件、`RunCore` 记账、把 Rust 转来的 fix 串行投到 HandlerThread | 不发起定位请求（那 Rust 还留着一份采集策略） |
| Rust 命令层 | `modules/tracking/mod.rs` | `with_webview` → JNI 调 TrackingBridge；live/轨迹走静态缓存 + 前端轮询 | 不直接碰 LocationManager |

## 2. JNI 符号表（逐字对齐，签名写错运行期崩进程）

### 2.1 Kotlin → Rust（external，`System.loadLibrary("rein_lib")` 在两个类的 static init 各一次）

| Kotlin 声明 | Rust 符号 | 返回 |
| --- | --- | --- |
| `RunTrackingService.nativeStartLocation(): Boolean` | `Java_com_gozaoo_rein_RunTrackingService_nativeStartLocation` | 1=已注册；0=失败（权限/Provider），Kotlin 负责降级 |
| `RunTrackingService.nativeStopLocation(): Boolean` | `…_nativeStopLocation` | 幂等；state 为 None 直接返回 1 |
| `RunTrackingService.nativeRestartLocation(): Boolean` | `…_nativeRestartLocation` | **先 stop 后 start；stop 失败立即返回 0**（旧注册可能还挂着，叠加新注册会双路投递） |
| `RustLocationListener.nativeOnLocation(t, lat, lon, acc, alt, altAcc, hasAcc, hasAlt, hasAltAcc, provider)` | `Java_com_gozaoo_rein_RustLocationListener_nativeOnLocation` | 只转发 |

### 2.2 Rust → Kotlin（`call_static_method`，签名串）

| Kotlin 方法 | JNI 签名（Rust 侧调用串） |
| --- | --- |
| `RunTrackingService.handleFixFromRust(Long, Double×5, Boolean×3, String)` `@JvmStatic` | `(JDDDDDZZZLjava/lang/String;)V` |

`nativeOnLocation` 里对 `com/gozaoo/rein/RunTrackingService` 的 `call_static_method` 走裸类名 FindClass——**依赖「从 app 类的 Java 帧里被调」这条规则**（回调来自 `RustLocationListener.onLocationChanged` 的帧，成立）。若把回调 executor 换成 Rust 自有线程，这处会踩系统加载器找不到应用类的坑（同 `app_class()` 注释）。

## 3. 线程模型

- 定位回调全部落**主线程**：API 31+ 用 `getMainExecutor`；legacy 路径传 `getMainLooper`。
- 回调路径不碰 Rust `STATE` 锁：`nativeOnLocation` 只做一次静态转发 → Kotlin `handleFixFromRust` → post 到 HandlerThread（`rein-run-loc`）串行记账。
- `STATE`（`Mutex<Option<LocationState>>`）串行 start/stop/restart；Kotlin 侧这三个 native 的调用点全在主线程，唯一例外是 `finishRun` 的收尾闭包投在 HandlerThread 上——锁无交集、持锁时间短，无死锁面。
- `GlobalRef` 进程级存活；`start()` **先建全局引用、后注册**（顺序不能换：注册成功后建引用失败会留下 STATE 摸不到的孤儿注册，GPS 常开到进程死）。

## 4. 权限口径（FINE-only，2026-10-22 收紧）

- **Rust `start()` 只认 `ACCESS_FINE_LOCATION`**（`checkSelfPermission == 0`），COARSE 一律不放。
- **Kotlin 侧全部入口同口径**（`TrackingBridge.hasFineLocationPermission`）：`enable(MODE_LOCATION)` / `runBegin` / `grantedNow` 起服务前验 FINE；`snapshot()` 的 granted 位也只报 FINE。
- 弹窗仍同时申请 FINE+COARSE（Android 要求成对）；用户在 Android 12+ 弹窗里选「大致位置」→ 服务**不起**，`snapshot.granted=false` → 前端 `armKeepalive`（`run.ts`）立即降级 web 取点、RunPage 显示「未授权」。**不要**放宽任何一侧到 FINE||COARSE——那会复活「服务在跑、通知在、却零采集」的空转状态。
- FGS 类型选择（`startForegroundCompat`，Android 10~13 借 location 型）仍看 FINE||COARSE：那是前台服务合法性判定，与采集无关，保持原样。

## 5. 自愈链路（ROM 熄屏挂起 provider 的对策）

| 触发 | 动作 | 限频 |
| --- | --- | --- |
| `ACTION_SCREEN_ON` / `USER_PRESENT` | `nudgeUpdates()` → 未在采则 `startUpdates`，在采则 `restartUpdates`（Rust 先 remove 后 request） | 20s |
| fix 看门狗（10s tick） | 亮屏且 `lastFixWall` 落后 >20s → `restartUpdates` | 同上共享限频 |
| 手动暂停后继续（`setPhase`） | 暂停跨熄屏 → 主动 `nudgeUpdates` | — |

`restartUpdates` 失败（Rust 返 0）→ Kotlin `stopUpdates` 清处理线程，等下一次触发重试；`fixWatchdog` 只在 `lastFixWall > 0`（收到过回调）后才生效，无 GPS 环境不空转。

## 6. 采集参数（`location.rs` 常量，改这里=改全平台取点策略）

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `UPDATE_INTERVAL_MS` | 1000 | fused Builder 间隔 / legacy minTime |
| `MIN_UPDATE_INTERVAL_MS` | 500 | 仅 API 31+ |
| `QUALITY_HIGH_ACCURACY` | 100 | `LocationRequest.QUALITY_HIGH_ACCURACY` |
| Provider 选择 | API 31+ 且有 fused → fused；否则 GPS（关闭再退 NETWORK） | fused 注册失败也回退 legacy 一次 |

返回值约定：`nativeStartLocation` 失败（0）时 Kotlin `collecting=false` 并清处理线程——**不要**在 Rust 失败后仍让 Kotlin 认为在采（两端状态必须同源）。
