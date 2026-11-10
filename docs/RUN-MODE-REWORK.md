# 跑步「退后台/熄屏丢实时数据」根因与改造交付报告

> 版本：0.5.18（versionCode 5018，未发布，工作树状态）
> 日期：2026-10-13
> 范围：跑步后台采集根因复核 + 原生取点/自动暂停/锁屏通知/练够分/视图与计数口径改造
> 证据分级：本报告区分【已跑过】（本会话执行并给出命令与输出）、【已读码】（给出 path:line）、【材料引用】（来自本轮交办材料与 `.zcode/run-ux-shots/`，注明来源）。
> 真机验收本轮**未执行**（手机从 adb 掉线），本报告不声称任何真机项通过——详见 §4。

## 用户入口（2026-11）

自动暂停与两篇后台教程（「后台拿不到数据」/「跑步后台被杀」）已从开跑准备页移到
**运动 › 右上角齿轮 › 跑步设置**（`/sports/settings/run`）；训练准备时长在
**运动 › 右上角齿轮 › 课程设置**（`/sports/settings/course`）。准备页不再放自动暂停开关，
运行态的自动暂停计数与结算文案不变；本文的验收命令与结论也不变。

---

## ① 一句话结论

跑步页取点的唯一消费者是 WebView 里的 `navigator.geolocation`；只要页面不可见（按 HOME、切后台、熄屏锁屏都会让 Activity 走 `onPause` → `mWebView.onPause()`），Chromium 就按**页面可见性机制**主动注销定位注册，系统从此不再投递任何坐标——这不是系统限制，是应用自己把定位撤了，所以「无后台限制」再怎么设也救不了。

真机时间线（本会话从原始 dump 复核）：15:23:34.372 按 HOME 切前台包 → **4 毫秒后**（15:23:34.376，屏幕仍是 ON）定位注册 `E6F4F0F3` 被摘除 → 直到 15:32:42.078 回前台后才重新注册，**后台 9 分 07.7 秒零注册、零投递**（累计计数器四次采样冻结在 `locations=854`）。同一时间窗里 Rein 的定位前台服务 + PARTIAL_WAKE_LOCK 全程健康（无进程死亡/冻结/回收）——「保活成功」与「一个点都收不到」同时成立，且用户界面全程不报错。

---

## ② 根因链（含证据与独立复核结论）

### 2.1 链条

1. **取点唯一消费者是 WebView**。前端 `src/stores/run.ts` 用 `navigator.geolocation.watchPosition(` 取点（web 路径）；修复前全仓无任何 Kotlin/Rust 取点实现（复核材料：`grep -rn "LocationManager|requestLocationUpdates|FusedLocation|getCurrentLocation" src-tauri/...` 输出为空；本轮改造**已把取点搬进 Kotlin**，现在该 grep 有命中，属修复本身）。
2. **wry 模板把页面可见性交给 `onPause`**。生成的 `src-tauri/gen/android/app/src/main/java/com/gozaoo/rein/generated/WryActivity.kt:132-136`：
   ```kotlin
   override fun onPause() {
     super.onPause()
     if (::mWebView.isInitialized) {
       mWebView.onPause()
     }
   }
   ```
   （本会话实读。`onResume` 对称，:139-143。）
3. **WebView 把这一步定义为「暂停 geolocation」**。`WebView.onPause()` javadoc 原文「Does a best-effort attempt to pause any processing that can be paused safely, such as animations and geolocation.」（本机 SDK `sources/android-36.1/android/webkit/WebView.java:1387-1395`，复核材料引用）；`AwContents.onPause()` 注释「Geolocation is paused/resumed via the page visibility mechanism.」随后 `updateWebContentsVisibility(Visibility.HIDDEN)`（`AwContents.java:3110-3117` / `:3962-3975`，复核材料引用，本机无 Chromium 源码可直读）。
4. **真机链条与之一一吻合**（本会话直接读 `.zcode/run-ux-shots/raw/` 原始 dump）：
   - `raw/loc-bg-20s.txt`：`15:22:10.962 =MI LMS= [0]fused provider added registration .../E6F4F0F3 (HIGH_ACCURACY)`；`15:23:34.377 ... removed registration .../E6F4F0F3`；该 dump 最后一条投递 `15:23:33.602`。
   - `raw/logcat-screenoff.txt` 同一秒：`15:23:34.372` 前台包从 `com.gozaoo.rein` 切到 `com.miui.home`；`15:23:34.376` `GnssBackgroundUsageOpt: removeByLmsUser1039520081` + `IMiLocation: remove, loc_info:1039520081fusedWV.t71@...`；而 `15:23:34.344`–`.354` 的 WM 日志全是 `dc:Display{#0 state=ON}`——**摘除发生在屏幕仍然亮着的时候**。
   - `raw/loc-off-15s.txt` / `loc-off-60s.txt` / `loc-off-115s.txt`：计数器全部冻结在 `locations = 854`（加上 `loc-bg-20s.txt` 共四次采样逐字未变），投递记录最后一条仍是 `15:23:33.60x`。
   - `raw/loc-resume.txt`：`15:32:42.060` 起重新注册（BALANCED 探测 → HIGH_ACCURACY），最终 `15:32:42.078 added .../B4275F26`；投递从 `15:32:55.370` 恢复（该 dump 保留的最近 25 条投递为 `15:32:55.370`–`15:33:19.557`），计数器 `854 → 893`。
   - 断层时长：`15:23:34.377 → 15:32:42.078` = **9 分 07.7 秒**。
5. **保活层真实存在但与取点脱钩**：同窗口 FGS `RunTrackingService` 单起单停（`am_foreground_service_start 15:22:10.893 → stop 15:37:13.063`），无 `am_proc_died`/`am_kill`；Kotlin 侧无任何取点调用（修复前），注释也写明「只负责保活，不自己采集坐标」。所以**保活手段再强也不可能救回 GPS**。
6. **前端对这段空窗既无检测也无标记**（修复前）：距离只在 `(0.5, 100]m` 的单跳内累加、时长走墙上时钟、running 态落盘只有 10s 定时器一条路、恢复一律降级 paused 并丢弃被打断的当前段——于是「分钟数含空窗、公里数不含」，配速/热量/强度/分段被连带拖偏，而 `gpsStatus` 全程未收到 error（回前台时 chip 仍是「GPS 已连接」）。

### 2.2 为什么「无后台限制」救不了

「无后台限制」改变的是**系统对进程的处置**（杀不杀、限不限后台资源）；而这里定位请求是被**应用自己**在页面变不可见的那一刻注销的。真机证据把三种替代解释全部排除：

- 不是熄屏/Doze：摘除发生在 15:23:34.376，屏幕仍为 `state=ON`（同秒 WM 日志）；
- 不是进程冻结/回收：整段窗口 FGS 在跑、进程持续被调度打日志、126ms 内就能重新注册；
- 不是权限/白名单：`dumpsys deviceidle whitelist` 含 `user,com.gozaoo.rein,10395`，appops 的 `FINE_LOCATION: allow`、`RUN_ANY_IN_BACKGROUND: allow`、`START_FOREGROUND: allow`、`SYSTEM_ALLOW_LISTED` 无期限，全部放行（复核材料逐条重查一致）。

### 2.3 独立复核结论（与上一版结论的差异）

上一轮复核清单逐条裁决为 **confirmed**，但有以下修正，本报告按修正后的口径落笔：

| # | 修正 | 依据 |
|---|------|------|
| 1 | 后台空窗应写 **9 分 07.7 秒**（15:23:34.376→15:32:42.059），不是 6 分 42 秒（那只是最后一次采样的时刻）；且**摘除发生在屏幕仍亮时**，「与熄屏/Doze/电池优化无关」由时间线直接证实 | 本会话读 raw dump（见 2.1-4） |
| 2 | `RunTrackingService.kt` 与 v0.5.17 的关系应写「**内容一致、仅行尾 CRLF/LF 不同**」（`git diff --ignore-cr-at-eol v0.5.17..HEAD` 为空），不是严格逐字节 | 复核材料（已给命令与输出） |
| 3 | 主证据从 logcat 的 `registration onInactive` 行改用 **`dumpsys location` 的注册历史**（该 logcat 行已滚出 main buffer；同格式行在 15:37:13.053 可复现） | 本会话读 raw：`loc-*.txt` 的 `=MI LMS=` 注册历史完整保留 |
| 4 | 机制归属：不要把 15:23:34.376 读成「系统强制摘除」。AOSP 的后台压制是「注册保留、转 inactive 状态」（`LocationProviderManager` 只切 appops `OP_MONITOR_LOCATION`），真正删除走客户端 `onUnregister`——真机看到的是**客户端（WebView/Chromium）主动注销** | 复核材料（AOSP 行号）|
| 5 | 保持「未验证」：Blink 侧 `StopUpdating()` 与「隐藏页约 1 分钟冻结」、`IsClientVisible()` 本体均未直读到（镜像缺文件、googlesource 超时），只能靠 WebView 的 Java/C++ 注释与真机时序支撑 | 复核材料 |
| 6 | 表述修正：finding#7 应为「回前台瞬间 chip 仍显示已连接，且 9 分钟内 error 回调未触发」；finding#13 应为「MIUI 锁屏未展示该常驻通知」（通知本身已于 15:22:20.915 创建）；finding#10 需注明参照系（代码事实是「结束键→三选一 sheet、危险项无二次确认」，`run.ts:5` 注释把「结束键+二级确认」定义为该 sheet 本身），且点击时刻自述与实际服务停止有约 1s 偏差 | 复核材料 |
| 7 | **本报告新增修正**：「投递记录首条 15:36:50.187」是**滚动缓冲残留**，不是回前台首投——`raw/loc-abandoned.txt` 只保留最近 22 条投递（15:36:50.187–15:37:12.140），而 `raw/loc-resume.txt` 显示重注册后投递自 `15:32:55.370` 就已恢复。该行不得再作为「零投递」的替代证据；零投递的直接证据是 `loc-off-*` 三份 dump（计数器冻结 854、末条投递 15:23:33.60x） | 本会话读 raw dump |
| 8 | 归因错的两处注释已随本轮改造改写：`src/stores/run.ts:1-27`（新注释写明「原生采集是唯一真源」与两级降级）与 `RunTrackingService.kt:35-38`（删掉「不自己采集坐标/进程冻结」，写明页面不可见会让 WebView 注销 geolocation） | 本会话实读两处文件 |

### 2.4 副产物结论（同样 confirmed）

- 即使删掉 `onPause` 调用也不够：Home/切窗让 WebView 窗口不可见时 `IsClientVisible()` 同样为 false、页面同样 HIDDEN（三个可见性入口同源；`IsClientVisible()` 本体未直读，属间接支撑）。
- `RunTrackingService` 的 location 前台服务 + PARTIAL_WAKE_LOCK 只保证进程存活与 CPU 不睡，不采集坐标（修复前 grep 为空；与注释一致），不可能救回 GPS。
- 三项探针级证据（探针 B/B2、探针 F 的落盘、3 条 FAIL 成因）无法重跑（探针在 %TEMP% 且已删、仓库无测试框架）。本轮交付改用**可复跑的无头 harness**（见 §3.6）替代，全部通过。

---

## ③ 本次已实现（14 条，5 组）

### 3.0 总览

| # | id | 一句话 | owner | 主要文件 |
|---|----|--------|-------|----------|
| 1 | native-run-collect | 安卓取点搬出 WebView：前台服务成为运动真源 | native | `RunTrackingService.kt`、`TrackingBridge.kt`、`modules/tracking/*`、`lib.rs`、`trackingService.ts`、`mock/server.ts` |
| 2 | native-autopause | 原生自动暂停：10'00"/km 进入、9'00"/km 退出（独立窗口） | native | `RunAutoPause.kt`、`RunTrackingService.kt`、`modules/tracking/model.rs` |
| 3 | native-notify | 通知渲染层：实时数字 + 课程常驻 + 点击/冷启动回前台 | native | `RunTrackingService.kt`、`TrackingBridge.kt`、`MainActivity.kt`、`AndroidManifest.xml` |
| 4 | core-consume-native | 跑步状态机消费原生真源：双通道 + 两级降级 + 相位同步 + 轨迹生命周期 | run-core | `src/stores/run.ts`、`src/types/session.ts` |
| 5 | core-autopause-gates | web 路径自动暂停 + 距离/配速闸门 + 空窗三分支 | run-core | `src/stores/run.ts` |
| 6 | core-splits-ascent | 分段唯一口径 + 爬升滤波 + 断档标记 | run-core | `src/utils/geo.ts`、`src/utils/runSummary.ts`、`src/types/session.ts` |
| 7 | view-live-hero | 实时页层级与布局基线 | run-view | `RunPage.vue`、`tokens.css`、`SlideToEnd.vue` |
| 8 | view-status-truth | 定位新鲜度 chip + 后台对账 + 恢复核对卡 | run-view | `RunPage.vue` |
| 9 | view-onehand-end | 单手结束：滑动闸门替代顶栏红字 | run-view | `RunPage.vue`、`SlideToEnd.vue` |
| 10 | view-summary-honest | 总结页诚实呈现：有效距离三格、互斥说明卡、分段可信度 | run-view | `RunPage.vue` |
| 11 | view-ready-gate | 准备页：自动暂停开关 + 定位就绪门 + 预检行 | run-view | `RunPage.vue` |
| 12 | notify-push | 通知数据桥：前台推数据、原生只渲染 | notify | `src/system/workoutRuntime.ts` |
| 13 | score-aerobic-engine | 有氧等效组引擎：三类记录进练够分（含夹持） | score | `aerobicLoad.ts`、`trainingScore.ts`、`weakMuscles.ts` |
| 14 | score-aerobic-wiring | 练够分装载与呈现：纯跑步/纯导入用户也能看到热力图卡 | score | `scoreInput.ts`、`ExerciseVolumeCard.vue`、`TrainingScoreSheet.vue`、`HomeFooter.vue` |

### 3.1 native（3 条）

**native-run-collect｜安卓取点搬出 WebView**
- 改了什么：新增 Kotlin 采集器（API≥31 用 `LocationManager.requestLocationUpdates(FUSED_PROVIDER, LocationRequest…)`，否则老 GPS 接口，`RunTrackingService.kt:267-286`）；fix 处理、K/L 判定、轨迹 JSONL 落盘（5 行/5s flush）、live 快照与 `evaluateJavascript` 推送都在服务内（`:350-397`、`:473-491`）。Rust 侧新增 `modules/tracking/{mod,commands,model}.rs`，注册 7 条新命令（`lib.rs:213-219`：run_begin/run_phase/run_end/live/track_take/notify/open_pending，另有原 2 条改签名）；`src/services/trackingService.ts:83-165` 与 mock 同步。命令回读走「缓存 + 非空才覆盖」协议，因为 wry 的 `JniHandle::exec` 是 fire-and-forget（本会话实读 `~/.cargo/registry/src/index.crates.io-*/wry-0.57.0/src/android/mod.rs:495-500`，`MainPipe::send` 无回执）。
- 验收点：真机 `adb logcat -s ReinRunTrack` 每 5 个 fix 一条 `seq=` 行、时间戳断档必有 `gap=` 行；熄屏期间 `dumpsys location` 无 `-registration`；`npm run contract`、typecheck/lint/build、`cargo test --lib tracking` 全绿；关定位权限后 60s 内降级且时长/距离连续。
- 真机证据：**未跑**（无 adb 设备）。契约预期的 287/287/287 实际为 **285/285/285**（见 §6）。

**native-autopause｜10'00"/km 进入、9'00"/km 退出（独立窗口）、无新鲜定位不判定**
- 改了什么：新文件 `RunAutoPause.kt`（纯 Kotlin object，无 Android 依赖）：精度门 30m、单跳上限 `max(40, 8×dt)`、空窗三分支、W10 进入（连成 3 次）/Wrec 退出（连成 2 次 + 最近两步达标 + 离锚点 ≥10m）、>5s 无 fix 不进不出、手动相位复位；`selfTest()` 内置 K 向量表（V1–V6），debug 构建启动时打 `apvector pass/fail`（`RunTrackingService.kt:172-177`）。服务每次判定打 `apcheck` 行（`RunTrackingService.kt:386-395`）。Rust 侧 `model.rs::spec` 是同向量表的**规格验证器**（不参与运行时，`model.rs:1-13`）。
- 验收点：站立不动 8~12s 后 `ap=true` 且通知标题变「· 已自动暂停」、chronometer 停走；**需人工走动 ≥10m**，3.4~6s 后自动恢复并出现 10~60m 一次补距；`apvector pass=6 fail=0`。
- 真机证据：**未跑**。本会话以独立手段复跑了 Kotlin `selfTest()`（见 §3.6-6）：`pass=6 fail=0`，V1 enterDelay=8000ms、V2 exitDelay=6000ms + exitCredit=12.0m、V6 enterDelay=12000ms，与 Rust 单测 `tracking_autopause_vector_table` 同结论。

**native-notify｜通知渲染层（跑步 + 课程 + 冷启动兜底）**
- 改了什么：通知渲染按载荷（G 契约）分支——running 用正计时 chronometer、autopause/paused 停表并显示冻结时长与公里数、rest 倒计时（`RunTrackingService.kt:591-613`）；`contentIntent` 带 `rein_open` extra 回跑步页（`:684-697`）；「继续」动作键走服务内 `RECEIVER_NOT_EXPORTED` 接收器（`:132-138`、`:699-705`）；课程常驻用 `specialUse` 前台服务类型（`startForegroundCompat`，`:507-523`）；`lastPayload` 竞态兜底与 `run_begin` 清空；wakelock 幂等（acquire 前判持有，`:530-539`）；`onTaskRemoved` 写中断标记（`:210-222`）；锁屏只给脱敏 `publicVersion`（`:631-638`）；Android 16 推广常驻只写 extra、不写断言（`:614-620`）。课程存活接线在 `src/system/workoutRuntime.ts:528-529`。
- 验收点：`dumpsys notification --noredact` 见 id=41 / FOREGROUND_SERVICE flag / 数字 5s 刷新 / chronometer 走；点通知回 `/session/run`、杀进程后冷启动也能落回；课程 types 含 `0x40000000` 且结束即消失；新开跑 2s 内必有通知。
- 真机证据：**未跑**。

### 3.2 run-core（3 条）

**core-consume-native｜状态机消费原生真源**
- 改了什么：`source` 由 native/forceWeb/nativeDegraded 三因子决定（`run.ts:277`）；真源判定只在 `preflight()/begin()` 强制读一次；原生段时长/距离/配速/新鲜度都从 live 镜像（push 平滑 + 1Hz pull 为准，`run.ts:811-839`）；两级降级（一级保服务保通知 + 播种 `accumMs/segStartedMs/distanceM`，二级才 `runEnd`，`run.ts:919-941`）；相位同步 `runPhase`（pause/resume）；轨迹生命周期 `trackTake（跑中只读）→ runEnd → trackTake（停后交付并删除）` 并合并回填；落盘挂钩补齐 `visibilitychange→hidden` 立即落盘、每 5 点/≥15s 落盘（原只有 10s 定时器）。
- 验收点：熄屏 3 分钟回前台时长/距离不回退且连续、快照累积时长 >0 且与 live 差 ≤1s、`am force-stop` 后出现恢复核对卡且「继续记录」不回 0、撤权限后一级降级且通知未消失。
- 真机证据：**未跑**。本会话复跑无头 native harness：**28 项 ALL PASS**（含降级播种、二级 `runEnd`、恢复基线 C1–C5、轨迹合并 B4、`runPhase` 相位 A12/A13）。

**core-autopause-gates｜web 路径自动暂停 + 闸门 + 空窗三分支**
- 改了什么：web 采集源可注入 `window.__reinGeoDriver`（`run.ts:447-449`，与 `clearWatch` 同源）用于可复现验证；自动暂停含独立退出窗口 Wrec、hold 链、exitD 补距 `clamp(净位移, 0, 60m)`；空窗三分支 slow/fast/drop（slow/drop 不计时不计距，fast 入账 `min(d, dMax)` 且保留时间，`dMax=max(40,8×dt)`、`vMax` 自适应）；瞬时配速同窗口 EMA、>15s 置 null 且上限 1200s/km；watchPosition 回调写 `lastFixAt/lastFixAccM`；`pauseCause` 区分 manual/auto。
- 验收点：devtools 注入 8 条固定 fix 后 ①消费注入、②8~12s 进入且 count=1、③3.4~6s/≥10m 恢复 + 10~60m 补距、④配速不超 1200、⑤空窗三分支数值正确、⑥fixAgeSec/fixWaitSec 正确。
- 真机证据：**未跑**。本会话复跑无头 web harness：**29 项 ALL PASS**（进入 11s、恢复 3s/补距 12.2m、慢空窗 Δ0/0、快空窗 +499.4m/+180s、drop 不计、fixAge 30s 等）。

**core-splits-ascent｜分段唯一口径 + 爬升滤波 + 断档标记**
- 改了什么：`geo.ts` 新增 `trackAscentFiltered`（丢 `altAcc>20m` → 每 50m 重采样 → 中值窗 5 → 迟滞 5m），`trackAscentM` 委托它（脏抽屉 `WorkoutDetailDrawer.vue` 不改代码也同口径）；`runSummary.ts` 改调 `trackSplits`（唯一分段口径），`SplitRow.suspect` 排除出最快/最慢/`paceSpread`；`types/session.ts` 追加 `acc?/altAcc?/brk?` 与快照计数/`finalKm/autoPauseOn` 等字段（本文件唯一落笔人）。
- 验收点：分段与 trackSplits 误差 0、历史抽屉爬升与总结页同值、平路爬升 ≤10m 或「高程数据不足」、断档公里带 ⚠ 且不被标最慢、`brk` 处两段 M 不连弦。
- 真机证据：**未跑**。本会话复跑 `rein-run-assert.mjs`（仓库自带 esbuild 现打真源码）：**14 项 ALL PASS**（±7m 白噪声 10 种子全部 ≤10m、20m 缓坡=15m、brk 两个 M、两点轨迹 trackAscentM→null、`distanceMismatch` 阈值、`altAcc` 过滤）。

### 3.3 run-view（5 条）

**view-live-hero｜实时页层级与布局基线**
- 改了什么：`tokens.css:310-316` 追加 `--fs-display-l/s/xl/2xl`（44/34/84/56px）；hero 行（左时长 84px、右距离 44px）+ 目标条 + 三列指标卡（34px 值 / 13px 单位）；布局基线 `.live .rubber-layer{align-self:stretch}`；暂停压暗由整层 `filter:brightness()` 改为 `.hero::after` 遮罩（不再压暗胶囊）。
- 验收点：真机 1220×2712 截图核对（时长与距离同行、距离 ≥44 CSS px、暂停后时长墨水左边界与配速卡一致、指标卡内不再出现 10/11/12px）。
- 真机证据：**未跑（无截图）**。代码与 token 我本会话已核对存在。

**view-status-truth｜chip 新鲜度 + 后台对账 + 恢复核对卡 + 自动暂停分叉**
- 改了什么：`RunPage.vue:917-918` 的 GPS chip 四态（定位中…/GPS 良好 ±Nm/定位中断 Ns/无定位 · 距离已停止累加）；`gapNotice` 横幅（`:933-934`）；恢复核对卡 `rcard`（`:972-978`，「继续记录 / 结束并保存这 12:30」）；暂停分叉按 `pauseCause` 输出「自动暂停 · 继续移动即自动恢复」或「已暂停 · 手动」（`:441`）；通知权限提示。
- 验收点：熄屏 2 分钟回前台 chip 先「定位中断」再回「GPS 良好」、后台对账文案、`fixWaitSec`、恢复核对卡两按钮。
- 真机证据：**未跑**。

**view-onehand-end｜单手结束**
- 改了什么：新增 `src/components/run/SlideToEnd.vue`（138×56、把手 ≥56、滑过 60% 提交、未过弹回），进行中底部行 = [暂停 200×56] + [滑动结束 138×56]（`RunPage.vue:1096`）；删顶栏结束红字（进行中）；`.min` 补 `position: relative` 防命中区扩到整条顶栏。
- 验收点：单手控件下沿 ≤864 CSS px；「滑过 60% 提交 / 短滑不提交」各一次（`adb shell input swipe`）；命中区不越界（开发者选项「显示点按操作反馈」截图）。
- 真机证据：**未跑**。已知 `.mseg` 命中区约 25px，未达 44px（见 §6-4）。

**view-summary-honest｜总结页诚实呈现**
- 改了什么：有效距离 `effectiveKm` 驱动三格（距离 / 配速 / 热量），手动改填加「手动」小标（`:1126`）；记录说明卡逐行互斥（慢/丢归「未计入」、快归「已按直线补记」、自动暂停单独行）；`suspect` 分段带 ⚠ 且不参与最快/最慢；放弃确认带损失（标题含时长与距离）；爬升改「累计爬升（GPS 估算）」；<1km 不显示假分段。
- 验收点：三格随改填变、说明卡各行不重复、断档公里带 ⚠、放弃弹窗含时长距离。
- 真机证据：**未跑**。

**view-ready-gate｜准备页**
- 改了什么：自动暂停开关（`ToggleSwitch`，默认开、localStorage 保持，`RunPage.vue:1022-1024`）；`onGo` 先 `await r.preflight()` 显示「正在准备定位…」再进 3·2·1（`:817-825`、`:1033-1035`）；预检行按 `tracking_status`（busy 时 400ms 重试 ≤5 次）显示「后台记录：已就绪 · 锁屏也继续记录」/「未授权 · 锁屏后可能中断」（`:198-204`）。
- 验收点：冷启动直开准备页也显示就绪行；撤权限后改文案且仍能开跑；桌面 mock 下不显示。
- 真机证据：**未跑**。目标记忆（`rein.run.goal.v1`）与 NumberStepper 按契约**降级未做**。

### 3.4 notify（1 条）

**notify-push｜通知数据桥**
- 改了什么：`src/system/workoutRuntime.ts`（唯一文件，+337/-3）内的推送器：2s tick，结构指纹（相位/自动暂停/组进度等）变化立即推、数字指纹（两位小数公里、配速 5s/km 粒度）受 5s 最小间隔约束、15s 心跳重推；跑步与课程文案（含 `nativeDegraded → 「定位已回退 · 可能被系统中断」`）；「继续」动作；`rein-open-workout` / `rein-workout-resume` 消费；冷启动 `openPending()` 兜底（400ms 重试 ≤5 次）；桌面 native=false 整体 no-op。
- 验收点：锁屏数字 5s 内反映距离/配速、自动暂停标题同步、点通知/动作键分别回跑步页/续跑、冷启动落回、课程三态与结束消失、桌面无 warn。
- 真机证据：**未跑**。

### 3.5 score（2 条）

**score-aerobic-engine｜有氧等效组引擎**
- 改了什么：新文件 `src/utils/aerobicLoad.ts`——`U = min(6, durationMin/10) × {low 0.8, moderate 1.0, high 1.2} × ACTIVATION_WEIGHT`，每肌群每周封顶 6；30 类型解析结果表（16 命中 + hike→walk / martial→boxing 显式复用 = 18 进分，12 不计）原样写入文件头（`aerobicLoad.ts:14-40`）；`trainingScore.ts` 追加 `workouts?` 输入、按 workoutId 去重、`setsForScore=max(acc.sets, min(acc.sets+aeroSets, SETS_SWEET[goal][0]))`，`setsScoreOf/heatLevelOf/idle` 改用它；`weakMuscles.gapOf` 同改。
- 验收点：3×40min 跑步 → 五组 71 分·档位 2；1×40min → 51 分·档位 1；力量 20 组 → 88 分且不因夹持掉档；有氧单独最高「基本够」。
- 真机证据：**未跑**。本会话用 esbuild 现打真源码复跑探针，数值逐项复现：1×40min=51/level 1、3×40min=71/level 2（aeroSets 6、freq 3）、cut 3×40=73、力量 20 组=88（setsForScore 20）、快走 30min→腿前 1.5/小腿 3/臀 1.5、徒步 60min→小腿 6 组/57 分、跳舞→整卡空、骑行 40min→腿前 4 组、同 id 去重→aeroSets 0、无 workouts 旧口径=88（零回归）、窗口外记录不进本周。

**score-aerobic-wiring｜装载与呈现**
- 改了什么：新 `src/services/scoreInput.ts:22` `loadScoreInput`（42 天窗口：`strengthRecentSets(42)` + `listWorkouts(addDays(today,-41), today)`）；三处调用点统一（`ExerciseVolumeCard.vue:58`、`HomeFooter.vue:483`、说明抽屉宿主）；`hasHistory` 改 `sets.length>0 || workouts.length>0`，热力图卡对纯跑步/纯导入用户不再整卡隐藏；训练说明抽屉补有氧换算与置信度分叉。
- 验收点：删掉全部力量记录、只手动记「自行车 40 分钟 · 强度中」→ 运动页热力图卡有分数、主页「练」卡有分数；点「说明」能看到有氧换算来源与「有氧单独最高基本够」；删除后复原。
- 真机证据：**未跑**（无真机；纯函数面已由探针覆盖）。第三方导入数据（健康同步导入的 workouts）走同一 `listWorkouts` 路径，但**无真实导入样本验证**——见 §6。

### 3.6 本会话实际跑过的确认（命令 + 输出）

| # | 命令 | 结果 |
|---|------|------|
| 1 | `npm run contract` | 「命令数：Rust 285 / services 285 / mock 285」「IPC 契约一致 ✓」（契约预期 287，见 §6-3） |
| 2 | `npm run typecheck` | 退出码 0，无输出 |
| 3 | `npm run lint` | 退出码 0；0 errors / 10 warnings（全部 `no-explicit-any`，位于 `src/mock/server.ts:4555-4826`，非本轮文件） |
| 4 | `npm run build` | `✓ built in 9.08s` |
| 5 | `cd src-tauri && cargo test --lib tracking` | `7 passed; 0 failed`（sanitize_run_id / normalize_auto_pause / validate_notify_payload / K 向量表 / 三分支空窗 / 精度门+跳变丢弃 / 自动暂停结账） |
| 6 | 独立复跑 Kotlin `RunAutoPause.selfTest()`（Gradle 发行版内 kotlin-compiler-embeddable 2.0.21 + JBR21 编译 `RunAutoPause.kt` + 桩 main 后运行） | `pass V1…V6` 全绿、`apvector pass=6 fail=0`；V1 enterDelay=8000ms、V2 exitDelay=6000ms/exitCredit=12.0m、V3 不进不出、V4 不进、V5 enters=1/exits=0、V6 enterDelay=12000ms —— 与 Rust 单测向量表同结论 |
| 7 | `node %TEMP%/rein-run-assert.mjs` | 14 项 ALL PASS（splits 缩放、suspect 排除、噪声/缓坡爬升、brk 两段、two-point null 等） |
| 8 | `node %TEMP%/rein-harness-web.mjs` | 29 项 ALL PASS（注入驱动、自动暂停 11s、补距 12.2m、空窗三分支、fixAge 等） |
| 9 | `node %TEMP%/rein-harness-native.mjs` | 28 项 ALL PASS（真源镜像、降级两级、恢复基线、轨迹合并、相位） |
| 10 | 复跑有氧探针（esbuild 现打 `score.ts/score2.ts/score3.ts` 后 node） | 数值与实现报告逐项一致（见 3.5） |
| 11 | 复跑 `m0.mjs` 30 类型探针 | 「命中 16 / 共 30」与文件头表逐项一致 |
| 12 | read-only 复核 | `WryActivity.kt:132-136`、wry `exec`、`RunTrackingService.kt` 全文、`run.ts` 头部/关键函数、`RunPage.vue` 关键行、`tokens.css:310-316`、`lib.rs:210-219`、`aerobicLoad.ts:1-40`、`scoreInput.ts:22`、APK metadata、raw 真机 dump |

> 说明：harness 与探针均为**临时文件**（`%TEMP%`），不在仓库内；本报告给出的命令在任何同事机器上需要先由对应实现重建（脚本本身是「esbuild 现打真源码 + node 断言」的形态，源码在仓库里）。

---

## ④ 真机验收记录（含没验到的）

### 4.1 闸门状态（原样）

- 闸门：`gatesGreen=true`；完整 Rust 单测 exit=0；构建成功；**安装：未安装（构建失败或手机不在场）**。
- 真机验收字段：`backgroundOk=false`、`autoPauseOk=null`、`notificationOk=null`、`scoreOk=null`；`shots=[]`。
- 事故：**手机在验收阶段从 adb 掉线**——多次 `adb devices` 无设备，重启 adb server 后仍无（物理断开或手机侧守护进程死亡，主机侧无法恢复）。build 成功、签名 APK 已产出，但装不上、验不了。
- 影响：**本轮 14 条条目里的全部真机 accept 项均未执行**。凡「后台采集连续性、自动暂停进入与恢复、锁屏通知实时数据、练够分/热力图点亮、改造后视图截图」都**没有**实测证据。

### 4.2 没验到的清单（对照各条 accept）

1. `native-run-collect`：`adb logcat -s ReinRunTrack` 的 `seq=` 行与时间戳断档、`gap=` 行、熄屏期间 `dumpsys location` 无 `-registration`；撤权限后 60s 内降级且时长/距离连续。
2. `native-autopause`：`apcheck` 的 in=3/3 → `ap=true`、通知「· 已自动暂停」+ chronometer 停走、`apvector` logcat 行、**人工走动 ≥10m** 后 out=2/2 与 10~60m 补距、静止 0 次误恢复。
3. `native-notify`：id=41/FOREGROUND_SERVICE flag/锁屏可见/点通知回 `/session/run`/杀进程冷启动落回、课程 `types` 含 `0x40000000`、结束课程通知与 service 一起消失、`lastPayload` 清后 2s 内出新通知。
4. `core-consume-native`：熄屏 3 分钟连续性、`am force-stop` 后恢复核对卡、撤权限一级降级。
5. 视图五条：全部截图/`adb swipe`/字号审计未做。
6. `notify-push`：真机渲染、点击、冷启动、课程三态。
7. `score` 两条：真机手动记快走/删除记录/热力图点亮。

### 4.3 截图与素材现状

- `.zcode/run-ux-shots/pre/`：12 张**改造前**截图（`entry-sports.png`、`ready.png`、`acquiring.png`、`running.png`、`lock-notify.png`、`background-return.png`、`paused.png`、`end-dialog.png`、`post-abandon.png`、`final-state.png`、`history-detail.png`、`history-run-detail.png`）。
- `.zcode/run-ux-shots/raw/`：16 份原始 dump/logcat（`loc-*.txt` 9 份、`svc-*.txt`、`pkg-dump.txt`、`logcat-screenoff.txt`、`logcat-excerpt-location.txt`、`bg-home.png`）。
- `.zcode/run-ux-shots/post/`：**不存在**（本会话 `ls` 报 No such file or directory）——改造后截图一张都没有。

---

## ⑤ 专家团建议与被推迟项（later，按价值排序）

按「用户可见价值 / 阻塞程度」排序：

1. **历史详情与列表侧**（另一会话脏文件，本轮未碰）：历史列表跑步副行（km+配速）、详情页「与练够分呼应」、配速曲线与断档虚线、末段配色。**爬升不一致已解决**（`trackAscentM` 已委托 `trackAscentFiltered`，脏抽屉不改代码也同口径）。
2. **自动暂停阈值四档（10'/11'/12'/关）与「运行中改开关」**：本轮只冻结 600/540 单档 + 准备页开/关，四档等真机手感跑过再上。
3. **屏幕常亮（`FLAG_KEEP_SCREEN_ON`）**：原生采集落地后熄屏不再中断采集，只剩观感价值。已定形状：命令 `tracking_screen_keepon(enable)`（MainActivity addFlags/clearFlags）+ run-core 在 `begin()/enterSummary()/resetLocal()` 三个现有 `setKeepalive` 调用点旁各调一次。
4. **每公里反馈（横幅+震动）**：震动需真机验 WebView Vibration API；manifest 的 `VIBRATE` 权限本轮已顺手加。语音播报**不做**（speechSynthesis 在 WebView 不可靠且抢音频焦点）。
5. **练够分三件**：跑后体感自评写 `RunSnapshot.readiness`（需小 Rust 查询 + RunPage）、workouts 结构化距离/配速列（现只活在 note，正则解析在脏文件）、手动「力量训练」部位多选（需改 `exercise/commands.rs` 的 note 写入）。
6. **锁屏通知不可见的真实原因**未定论（候选：通知权限 / IMPORTANCE_LOW 归锁屏静默区 / 用户关了本应用锁屏通知）：本轮只落 A 档（PRIVATE + publicVersion 脱敏）；**B 档**（新渠道 `rein_workout` + IMPORTANCE_DEFAULT + `deleteNotificationChannel('rein_tracking')` + `setSilent`）保留为条件步骤，需真机确认仍不可见后再切。
7. **不做的**：`session.ts restEndsAtMs` 只读导出（脏文件，改用 `Date.now()+restLeft*1000` 推导）；`ActionSheet` 长按 800ms 二次确认（共用组件无归属，用滑动闸门防误触替代）；Android 16 Live Updates 只写 extra、不写断言（`developer.android.com` 在本沙箱不可达，行为类判断未核实）。

---

## ⑥ 未覆盖与后续建议

1. **真机验收 = 0**（§4）；插上手机后的重跑清单见 §7。
2. **Kotlin/Rust 双实现漂移风险**：K 口径在 `RunAutoPause.kt`（真机运行时）与 `model.rs::spec`（规格验证器）各一份；CI 只自动跑 Rust 侧。本轮我用独立 kotlinc 编译复跑 Kotlin `selfTest()` 与 Rust 同结论（§3.6-6），但这条链路只能靠「debug 启动 logcat + 人工」，没有 CI 归属。
3. **契约的 287 与实际 285**：`npm run contract` 实测 285/285/285 三方一致；`git show HEAD:src-tauri/src/lib.rs` 中 tracking 命令 2 条，现 9 条（+7），278+7=285。契约文本的「+9」疑似把既有 `tracking_keepalive/tracking_status` 也计了数。**285 是三侧一致的有效值**，不是缺 2 条命令。
4. **`.mseg`（固定/全览）真实命中区约 25px，未达 44px**：`::before` 的 ±8px 外扩被 `overflow:hidden`（为裁 goo 模糊外溢而设）裁掉；去掉裁切会带回模糊光晕，长高又会改 GlassThumb 几何。需要产品侧决定接受 25px 还是允许改 blob 几何。
5. **二级降级是产品折中**：仅前台有效、无实时通知、熄屏返回原诊断场景；代码路径已存在（`runEnd` → 服务 `stopSelf` + 通知消失），**无真机取证**。
6. **Android 10~13 课程常驻通知**：平台没有 `specialUse` 型，无定位权限时 `startForeground` 会抛 `SecurityException`，实现为 `type=0` + try/catch 降级为普通通知（不崩，但进程不受前台保护）。契约未覆盖该边界。
7. **轨迹只支持一次取走**：Rust 侧「采集未在跑 + 读到非空」即删文件；进程重启后的第二次调用会拿到空分片。24h GC 只在 `run_begin` 触发。
8. **爬升收紧界**：how 清单的「±7m 噪声平地 ≤6m」不是所有种子可达（10 个白噪声种子 8 个 ≤5m、2 个 =10m）；accept 级判据（≤10m 或高程数据不足）满足。
9. **恢复时的轨迹文件合并是后台非阻塞**（不 await）：核对卡数字来自快照立即显示，轨迹在文件读回后补上。
10. **`gaps` 明细只在内存**（不落盘）：恢复后 per-class 计数保留、明细为空。
11. **第三方导入数据进练够分**：代码路径存在（`listWorkouts` 42 天窗口），但**没有真实导入样本**做过端到端验证——「第三方导入都进练够分」目前只有代码依据、无数据实测。
12. **仓内垃圾文件**：`src-tauri/nul`（64 字节 ASCII，Windows 重定向事故产物，untracked），建议删除并加 `.gitignore` 兜底。
13. **未验证的机制细节**（保持未验证，别当已证）：Blink `StopUpdating()` / 隐藏页 1 分钟冻结 / `IsClientVisible()` 本体。
14. **安卓构建与浏览器 e2e 本轮未跑**：APK 来自闸门构建（成功），我未重跑；`scripts/e2e-run.mjs` 等未执行。

---

## ⑦ 如何自己复看

### 7.1 手机上现在装的是什么

- 最近一次真机取证的装机版本是 **0.5.17（versionCode 5017，`pre-evidence.md` 基线事实）**；本轮闸门记录「安装 未安装」——**新包 0.5.18 已构建但没装上去**（手机掉线）。插上手机后先覆盖安装同签名新包（数据保留）：
  ```bat
  adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk
  ```

### 7.2 重建与校验命令

```bat
:: 完整签名 APK（arm64-v8a, release；--check 只验环境）
.zcode\build-android-apk.cmd
:: 或 .zcode\build-android-apk.cmd --check

:: 前端与契约
npm run contract        :: 期望 285/285/285 + IPC 契约一致 ✓
npm run typecheck
npm run lint
npm run build

:: Rust 单测（tracking 段）
cd src-tauri && cargo test --lib tracking    :: 期望 7 passed
```
产物：`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`（0.5.18 / versionCode 5018 / minSdk 24）。

### 7.3 真机取证命令

```bat
:: 采集器日志（tag 定义在 RunTrackingService.kt:50）
adb logcat -s ReinRunTrack
:: 关键行：seq=（每 5 个 fix 一条）、gap=slow|fast|drop、apcheck in=/3 out=/2、apvector pass/fail、ap-settle

:: 注册历史（本次根因的主证据类型）
adb shell dumpsys location > dump.txt   :: 找 "=MI LMS=" 的 added/removed registration 段
:: 通知
adb shell dumpsys notification --noredact | findstr /C:"com.gozaoo.rein"
:: 服务类型（课程 specialUse = 0x40000000）
adb shell dumpsys activity services com.gozaoo.rein
:: 前台服务/进程
adb shell dumpsys activity oom | findstr rein
adb shell dumpsys power | findstr "rein:run_tracking"
```

### 7.4 截图路径与验收清单

- 改造前素材：`.zcode/run-ux-shots/pre/`（12 张）+ `.zcode/run-ux-shots/raw/`（16 份原始 dump）。
- 改造后素材：放 `.zcode/run-ux-shots/post/`（**当前不存在**，本轮没跑验收，所以是空的）。
- 最小验收清单（建议按序）：
  1. 开跑 → 熄屏/退后台 2 分钟 → 回前台：时长与距离**不回退且连续**；chip 出现「定位中断 Ns」后回「GPS 良好 ±Nm」。
  2. 站立不动 8~12s：通知标题变「· 已自动暂停」、chronometer 停走；走起来（≥10m）3.4~6s 自动恢复、距离出现 10~60m 补距。
  3. 锁屏看通知：有实时数字；点通知回跑步页；点「继续」动作键续跑；杀进程后点锁屏通知也落回跑步页。
  4. 手动记一条「自行车 40 分钟 · 强度中」：运动页热力图卡与主页「练」卡出现分数；删除后复原。
  5. 跑完进总结页：记录说明卡各行互斥、断档公里带 ⚠、三格随改填联动。
  6. 桌面上（`npm run dev`）：行为不回归；可在 devtools 注入 `window.__reinGeoDriver`（形状见 `run.ts` A4 契约）离线复现自动暂停/空窗三分支。

### 7.5 代码入口索引

| 主题 | 入口 |
|------|------|
| 原生采集/通知/轨迹文件 | `src-tauri/gen/android/app/src/main/java/com/gozaoo/rein/RunTrackingService.kt` |
| K/L 判定（自动暂停/闸门/空窗） | `.../RunAutoPause.kt` |
| JNI 桥与 pendingOpen | `.../TrackingBridge.kt` |
| 命令族与纯逻辑 | `src-tauri/src/modules/tracking/{mod,commands,model}.rs`、`src-tauri/src/lib.rs:210-219` |
| 前端服务封装 | `src/services/trackingService.ts` |
| 跑步状态机 | `src/stores/run.ts`（头部注释 1-27 行有真源与降级总览） |
| 通知推送器 | `src/system/workoutRuntime.ts` |
| 实时页 | `src/pages/RunPage.vue`、`src/components/run/SlideToEnd.vue` |
| 练够分有氧等效 | `src/utils/aerobicLoad.ts`、`src/utils/trainingScore.ts`、`src/services/scoreInput.ts` |
| 本轮真机原始证据 | `.zcode/run-ux-shots/raw/`、`.zcode/run-ux-shots/pre-evidence.md` |

---

## 附：本报告的诚实边界

- 真机相关的一切（后台连续性、自动暂停、锁屏通知、练够分真机点亮、改造后截图）**本轮都没有验**，原因只有一个：手机掉线，没有设备。
- 本报告中「已实现」的判定依据 = 代码在仓库里（本会话读码）+ 可在无设备环境下复跑的检查全绿（§3.6）。凡标注「真机证据：未跑」的，就是没跑，不要当成通过。
- §2 的根因链中，凡 Chromium 内部行为（Blink `StopUpdating`、`IsClientVisible` 合成）均标注为未直读；定案依据是「Android/WebView 公开注释 + 真机时间线一致」。
