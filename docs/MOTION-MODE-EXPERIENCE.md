# 运动模式体验优化流程

> 本文是一条用户旅程的完整测绘 + 检验 + 优化路线的合订稿：从主页决定练哪一节，到训练课/跑步跑完、保存落库、下次启动被正确接管。文中的每条判断都带位置（`文件:行`），凡未经真跑验证的一律标注。

---

## 1. 一句话结论

把运动模式收敛成一条「**每一步都有可见回执、失败有出口、现场可回退、记录可核对**」的训练闭环：

- 开课与保存的失败不再沉默——用户点下去没反应、只能反复点或杀进程这件事，是这条旅程最扎眼的系统级缺口；
- 中途换的动作与改过的编排，不会被下次接管抹掉，也不会被算到别的动作头上；
- 总结页能退回补做，而不是只剩「保存错的那份」或「放弃整节课」；
- 时长与组位只反映真正发生的事——挂钟中断的几小时不算训练，跳过组不冒充满分组。

一个佐证结论在检验中被**否证**并已回填：原始发现称「冲突后点『前往继续』会卡在空沉浸层，只能自己退出」，复核证明沉浸层会自愈关层（`SessionOverlay.vue:194-206`），真正残留的是「对已作废会话的伪冲突提示 + 一次开/关闪烁」。本文按复核后的口径写。

---

## 2. 改造后的体验流程

十五个阶段，逐阶段列出「用户做什么 / 系统必须回报什么 / 退出口 / 验收判据」。

| 阶段 | 用户做什么 | 系统必须回报什么 | 退出口 | 验收判据 |
| --- | --- | --- | --- | --- |
| **S1 主页「练」卡决定练哪一节** | 打开主页，读页脚「练」卡的事实行与焦点组，按「立刻练「X」」（无对症课时为「开练弱项加练」）。 | 三级推荐链落地：今天的课 → 方案里补弱项的课 → 课程库对策课 `matchCourse`（`HomeFooter.vue:390-403`、`303-309`）；卡头一句实时事实 + 焦点组五档色点与分数（`HomeFooter.vue:563-587`，与 MuscleMap 同一份色）；按钮文案随之切换。 | 正常结束：按「立刻练」进 S2。<br>收起：不适用（此卡折叠无状态变化）。<br>杀进程：尚无 active 会话、无落库，重启回主页原样。<br>断网：`loadScore` 静默失败（`HomeFooter.vue:465-467`），卡退化为纯入口，不阻塞点击。 | 点按钮时 `startLabel` 与 `startPlan` 指向同一门课（`HomeFooter.vue:400-403`）；连了教务且今天有课，按钮文案为「立刻开练「X」」；库里连对症课都没有时点击打开弱项加练抽屉而非空转。 |
| **S2 从入口开课（多入口 + 冲突检查）** | 点主页「立刻练」、课程详情「开始训练」、运动页最近课程播放键，或弱项加练临时课。 | 按钮 busy 禁用（`startBusy` / `startingId`）；无冲突则准备进沉浸层；有冲突则弹模态给「前往继续」；两类运动分别指到训练课沉浸层或跑步 `/session/run`（`session.ts:473-482`、`run.ts:253-262`）。 | 正常：`openImmersive(origin)` 进 S3（形变锚点 = 被点元素）。<br>冲突：ActionSheet「已有进行中的训练，请先接续」→「前往继续」。<br>杀进程：尚未写库、无残留。<br>断网：`session.start` 抛 IpcError，而 `HomeFooter.vue:421-423` 与 `PlanRecentCard.vue:38-40` 只有 try/finally 无 catch，界面静默无提示、无重试口——**当前缺口，见 R2**。 | 四条入口都先过 `session.start` 的 `getActive` 冲突检测（`session.ts:474`），不静默覆盖进行中会话；失败时用户能看到可见回执（R2 落地前此条不满足）。 |
| **S3 会话建立 + 沉浸层从点击处形变展开** | 点下入口后等待展开。 | 沉浸层从被点元素位置形变到全屏（`EXPAND_MS` 480 / 降级 360，`SessionOverlay.vue:510-513`），不透明底与内容随形变淡入，无 loading 骨架；路由不变（`App.vue` 常驻挂载）。`session.ts:484-511`；`sessionImmersive.ts:64-72`；`SessionOverlay.vue:855-903`。 | 正常：`beginExercise` 分流到 warmup / exercise / timed-ready（`session.ts:523-532`）。<br>收起：展开途中点收起 → `closeImmersive` 打断形变，浮条提前回归。<br>杀进程：`session_start` 已写 active 行，下次启动按 planId 接管（`workoutRuntime.ts:58-72`）。<br>断网：`session_start` 抛错、层不展开且无提示（同 S2 缺口）。 | 形变锚点忠于被点元素（`sessionImmersive.ts:66` explicit 优先，不被「现量浮窗」覆盖）；展开后第一次 push 已完成落库（`session.ts:149-151`、`509` await `persist`）。 |
| **S4 激活热身（力量动作）** | 做大重量的 40–75% 热身组，或点「跳过热身」。 | 眉标「激活热身 · 第 n/N 组」、处方格 wlist（✓/current）、重量大数字 + 唯一候选「热身组」、换算依据 `warmupNote`、肌群激活图 MuscleMap；每完成一组落盘一次。`SessionOverlay.vue:1005-1066`、`1233-1271`；`session.ts:435-440`、`547-577`。 | 正常：完成 → 45s 短休息 → 下一热身组或第 1 正式组。<br>跳过：`skipWarmup` 直接进正式组并切回正式重量（`session.ts:569-577`）。<br>收起：`minimize` → `closeImmersive`。<br>杀进程：快照含 `doneSets`/`restWarmup`，恢复时按 `warmupPending` 校验，避免卡在无组可做的热身相位（`session.ts:1150-1163`）。<br>断网：页顶「⚠ 进度同步失败」（`SessionOverlay.vue:993`），训练不阻塞。 | 完成一组后 wlist 的 ✓ 前进一格、短休息 45s；点「跳过热身」后重量回到正式 `weightFor(ex)`（`session.ts:574`），顶栏 n/N 正确。 |
| **S5 做组（力量）/ 计时动作** | 登记完成本组，或用「建议/上次/计划」一键填入重量次数；计时动作等 3·2·1。 | 顶栏「n/N 组」胶囊、动作 hero 名（库内名优先）、重量/次数大数字 + 一键填入「建议/上次/计划」、坞内「完成本组」；计时动作走 3·2·1 CountdownOverlay。`SessionOverlay.vue:1069-1120`、`1209-1215`、`1284-1292`、`139-176`；`session.ts:534-544`、`721-755`。 | 正常：完成本组 → 休息；最后一组 → 下一动作或 summary。<br>调整：顶栏「结束」→ 二级确认。<br>收起：浮条（会话不断）。<br>杀进程：每个状态事件 `touch()` 落盘（`session.ts:149-151`），计时被打断降级整组重做（`session.ts:1142-1146`）。<br>断网：snapshot 失败仅页顶警示，训练照常。 | 顶栏「n/N 组」与坞内「完成第 k 组」同源（`setIndex`/`effSets`）；每完成一组 `doneCount` 自增且已落快照；计时动作起跑走 CountdownOverlay 3·2·1。 |
| **S6 组间休息 / 临时休息** | 等倒计时，或点跳过、+15s 加时、开临时休息。 | 墙钟推导的休息倒计时、下组/下一动作提示、加时菜单「+15s…」、跳过休息。`session.ts:579-629`、`631-708`；`SessionOverlay.vue:1293-1316`、`1379-1387`。 | 正常：归零自动 `restOver` 推进（含热身组间回热身、临时休息回原相位）。<br>跳过：`skipRest` 立即推进。<br>收起：浮条。<br>杀进程：快照含 `restLeft`，恢复按真实流逝补时（`session.ts:1126-1140`）。<br>断网：同 S5。 | 休息剩余一律由 `restDeadlineMs` 推导、回前台立即校正（`session.ts:592-602`、`1188-1190`）；加时同步推 deadline（`604-609`），不会出现「休息异常变长」。 |
| **S7 沉浸层内的编排调整（全课进度 / 跳至某组 / 临时换动作 / 更多菜单 / 今日状态）** | 开组数胶囊进全课抽屉、跳至某组、临时换动作、开「更多」菜单、填今日状态自评。 | 抽屉逐格状态（完成/跳过/当前，`session.ts:235-264`）、toast 回执（「已更换为「X」」「临时休息 N 分钟」「已记录今日状态…」）、ReadinessDialog 五档各自标 ×系数与预览。`SessionCourseDrawer.vue:122`、`135-145`、`178-180`；`SessionOverlay.vue:1210-1214`、`1360-1365`、`391-401`。 | 正常：关抽屉/菜单回沉浸层。<br>收起：同前。<br>杀进程：`extraSets`/`skippedSets`/`readiness` 全在快照（`session.ts:110-128`）。<br>断网：同前。 | 换动作候选只列动作库同类型、排除隐藏项与本动作（`SessionExerciseSwapSheet.vue:41-43`）；跳转只向后到未做的组（`SessionCourseDrawer.vue:131`）；自评选中后预览「建议重量 ±X%」与「练够分」。 |
| **S8 收起到悬浮运动条** | 点「收起」。 | 收缩形变 400ms / 降级 300ms、落位溶解 130ms、浮条原地恢复、壳导航重新露出。`SessionOverlay.vue:466-469`、`511-513`；`sessionImmersive.ts:75-107`；`ActiveWorkoutBar.vue:88-96`、`166-232`。 | 正常：会话继续、浮条常驻、壳导航重新露出（base.css 由 `html[data-immersive]` 驱动）。<br>恢复沉浸：点条身或 Expand 按钮。<br>杀进程：active 行仍在，下次启动 `workoutRuntime.init` 接管回浮条。<br>断网：本地状态照走，快照失败只置 `persistError`，回到层内才可见。 | `scripts/e2e-immerse-toggle.mjs` 的 T1（hash 不变，不做路由）/ T2（closing 期浮条先就位、收尾无滑入）/ T4（收起途中再展开）通过；浮条一行文案与 `workoutRuntime.view` 同源（`workoutRuntime.ts:91-149`）。 |
| **S9 结束（二级确认）** | 顶栏「结束」→ 选「结束并保存」或「放弃本次训练（不保存）」。 | ActionSheet 两项「结束并保存」/「放弃本次训练（不保存）」。`SessionOverlay.vue:1216-1221`、`1367-1377`、`471-481`。 | 保存 → 进 S10。<br>放弃 → `session_abort` + toast「已放弃本次训练」+ `closeImmersiveNow`、不写记录。<br>关遮罩 → 留在沉浸层继续。<br>杀进程：会话不关闭，下次仍被接管。<br>断网：放弃路径走 abort，失败同样无 catch 提示（缺口，见 R1）。 | 只有 `finishAndSave`/`discard` 关会话（`session.ts:5-10`、`993-1035`）；放弃后无 workouts 记录（`sessionService.ts:59-60`）；关遮罩回到沉浸层而不会话结束。 |
| **S10 看总结成绩** | 看完成环、四项指标、进步、逐动作明细、肌群、下次建议。 | 完成环（跳过占分母不计分子）、容量/用时/消耗/每组耗时、PR 空心（即时）→ 实心（历史校正）、逐动作最高组、肌群、下次建议。`SessionSummaryPane.vue:45-130`、`113-131`。 | 保存 → 进 S11。<br>放弃不保存 → `discard`。<br>收起：summary 是终态，当前状态机只有 finish/discard 关会话，无「回到训练」出口（缺口，见 R11）。<br>杀进程：快照 `phase='summary'`，恢复仍停在总结。<br>断网：PR 历史校正静默失败但即时判定仍在，不空页。 | 分母 − 分子 = 跳过组数（`e2e-session-summary.mjs:244-246`）；PR 两级可信度在文字上带「历史」而不只靠颜色；「每组耗时」在低于 `MIN_SEC_PER_SET` 时显示为不可用而不是「0 秒/组」。 |
| **S11 保存落库（session_finish）** | 在总结页点「保存训练」（或顶栏「结束」→「结束并保存」）。 | toast「已保存 N 组 · 约 X 分钟 · Y 大卡」（`SessionOverlay.vue:489`）；随后 `closeImmersiveNow`（`491`）不做形变动画；周概览/力量曲线/今日营养就地刷新。`session.ts:993-1023`。 | 正常：原地回到底下的原页面（课程层从未改路由），周概览/力量曲线/今日营养就地刷新。<br>杀进程：仅在 finish 未返回时发生，会话未关、下次仍被接管。<br>断网/后端不可用：finish 抛 IpcError，而 `saveNow`（`SessionOverlay.vue:487-492`）无 try/catch，停在 summary 态、无提示、无重试口；且 finish 成功后若 `loadWeek`/`loadSummary` 失败，`endLocal()`（`session.ts:1021`）不执行，本地仍停在 summary 会对已关闭会话重复 finish（缺口，见 R1）。 | `session_finish` 事务内写 workouts + workout_sets + 关会话（`sessionService.ts:47-57`）；失败必须可见、可重试且不重复落库（R1 落地后此条才成立）。 |
| **S12 跑步：目标设置 → 3·2·1 开跑** | 运动页点「跑步」磁贴，设自由跑/目标时间/目标距离，点开跑。 | 目标面板自由跑/目标时间 ±5 分钟/目标距离 ±0.5km；CountdownOverlay「准备开跑」3·2·1；GPS 状态 chip「GPS 已连接 / 定位中… / 无法定位 · 结束后可补填距离」。`RunPage.vue:608-645`、`126-132`；`run.ts:241-284`。 | 正常：开跑（running）。<br>已有训练课：ActionSheet「已有进行中的训练课，请先接续」→「前往继续」开训练课沉浸层（`RunPage.vue:782-788`）。<br>已有跑步 active：`applyRecord` 恢复为暂停态（`run.ts:435`）。<br>收起：`minimize` → `router.push('/sports')`，会话不断。<br>断网：begin 的 `session_start` 抛错且 `onCountdownDone`（`RunPage.vue:492-495`）无 catch → 停在 ready 面板无提示（缺口）。 | begin 前 `getActive` 冲突检测（`run.ts:253-262`）；开跑后 `armKeepalive`/`startGps`/`startTimers` 都启动；已有训练课时不覆盖而是引导前往。 |
| **S13 跑步：计时 / GPS / 暂停续跑** | 跑动、暂停、继续。 | 时长 hero、瞬时/平均配速、里程、目标进度条、轨迹与「我」跟随、「已暂停 · 计时停止」徽标。`run.ts:151-205`、`286-311`；`RunPage.vue:648-686`。 | 正常：暂停 → 继续。<br>收起：回 `/sports`，浮条接管（`ActiveWorkoutBar.vue:140-145`）。<br>杀进程：Android 前台保活（`run.ts:221-236`），恢复强制暂停态、丢弃当前段（`run.ts:433-435`）。<br>断网：本地计时/GPS 照走，snapshot 失败仅置 `persistError`（`RunPage.vue:578` 顶部警示）。 | running 时每 10s 落盘一次（`run.ts:292`）；暂停态顶部显示「已暂停 · 计时停止」徽标（`RunPage.vue:575`）；恢复时被打断的当前段整段丢弃不补时。 |
| **S14 跑步：结束 → 总结（补填距离）→ 保存** | 暂停后「结束」→ 在总结页核对/补填距离 → 保存或放弃。 | 分段配速/爬升与不可用说明；距离可改（改后分段配速整体失效并给原因）；保存 toast「已保存跑步 X 分钟 · Y 大卡 · Z km」+ `router.replace('/sports')`。`RunPage.vue:497-524`、`688-761`、`113-117`；`run.ts:314-360`。 | 正常：保存 → 回 `/sports`。<br>放弃：`doDiscard` → `session_abort` + toast + `replace('/sports')`。<br>收起：`minimize` → `/sports`。<br>杀进程：总结态随快照（`run.ts:435`），恢复仍停总结。<br>断网：save 抛错且 `doSave`（`RunPage.vue:513-524`）无 catch → 停在总结页无提示（与训练课同一缺口，见 R1）。 | 改了距离后分段配速整体撤掉并给出原因（`RunPage.vue:84-90`、`113-117`）；保存时 `sets:[]`（`run.ts:327-360`）；保存 toast 含「X 分钟 · Y 大卡 · Z km」。 |
| **S15 下次启动：接管上次未正常结束的运动** | 重开 App 或冷开直达运动页。 | 无运动 = 整条浮条不渲染；有 = 浮条显示（跑步「户外跑 · 已暂停」，课程按 phase 续跑）。`workoutRuntime.ts:58-72`；`ActiveWorkoutBar.vue:35`、`166-232`；`SessionOverlay.vue:194-206`。 | 正常：点浮条恢复沉浸（课程经 `sessionImmersive` 形变，跑步推 `/session/run`）。<br>课程已删除：`applyRecord` 作废该会话（`session.ts:1099-1103`）。<br>后端不可用：`getActive` 抛错被吞（`workoutRuntime.ts:62-67`），静默不接管；沉浸页 `hydrateFromServer` 再兜一次（`SessionOverlay.vue:199-200`）。<br>列表拉取失败：当前被误当成「课程已删」而作废会话、完成组随会话丢失（缺口，见 R6）。 | `main.ts:18` 在 `app.mount` 之前 init；hydrate 成功即恢复 `doneSets`/重量/相位；课程确删才作废（R6 落地后区分「拉取失败」与「已删除」）。 |

---

## 3. 检验发现的真问题

按环节分组。每条给出**位置 / 现象 / 复核结论**。`【verified】` 表示独立复核已逐行确认；`【unconfirmed】` 表示复核部分成立、有一处或多处结论需要收窄或修正（已注明是哪些）。

### 3.1 开课与恢复

**F1 · 开课失败完全静默**【verified】medium · `src/components/home/HomeFooter.vue:405-424`（414-423 的 try/finally）；`src/components/exercise/PlanRecentCard.vue:31-41`
- 现象：点主页「立刻练」或课程卡的播放键后，按钮只是变灰一瞬又恢复，什么都没发生：没有错误提示、没有重试入口、沉浸层也不出现，用户会以为自己没点到、或以为已开始。
- 证据：`HomeFooter.vue:415` `const r = await session.start(plan)` 之后直接 `420 openImmersive(origin)`，`421-423` 只有 `finally { startBusy.value = false }`，没有 catch；`PlanRecentCard.vue:34-40` 同形。`session.start` 里会抛的 await 有三处：`src/stores/session.ts:474` `sessionService.getActive()`、`:501` `sessionService.start(...)`、`:496-499` 的 `Promise.all`；`services/transport.ts:48-49` 把失败归一为 IpcError 后原样再抛（无全局提示），`src/main.ts:1-24` 全篇也没有 unhandledrejection 兜底，所以拒绝只落在 console。对照同仓既有纪律：`session.ts:130-146` 的快照失败会写 `persistError` 并由 `src/components/exercise/SessionOverlay.vue:993` 显示「⚠ 进度同步失败」。
- 复核结论：confirmed。逐处核对 `startNow`/`quickStart` 的 try/finally 无 catch、`start()` 内三处可抛 await、`transport.ts:43-51` 归一为 IpcError 后原样再抛；全仓 grep `unhandledrejection|window.onerror|app.config.errorHandler`（`src/`）输出为空。契约：`docs/ARCHITECTURE.md:62`「store 决定提示方式，service 层不吞错」、`:209`「失败显示页顶警示不阻塞训练」。复核补充：材料里一处引用瑕疵——发现的 evidence 写「SessionOverlay.vue:993」未带目录，实际为 `src/components/exercise/SessionOverlay.vue:993`，行号准确，不影响结论。

**F2 · 已作废会话仍被弹「请先接续」**【unconfirmed】medium · `src/stores/session.ts:473-482`（start 的冲突分支）与 `src/stores/session.ts:1099-1103`（applyRecord 的作废）
- 现象（原始）：用户刚在「全部课程」里删掉一门正在上的课，回主页点开练时被弹窗拦住「已有进行中的训练，请先接续」；点「前往继续」后打开的是一个空的沉浸层。
- 证据：`start()` 里 `474-481`：`getActive` 有值且不是跑步时 `await applyRecord(existing)` 之后**无条件** `return 'conflict'`；而 `applyRecord` `1099-1103` 是 `if (!p) { await discardById(rec.id); return }`——会话已被作废，start 仍回 'conflict'。消费端 `HomeFooter.vue:416-417` 据此弹 conflictOpen，`goConflict`（`HomeFooter.vue:426-430`）见 `foreignRoute` 为 null 就 `openImmersive()`。
- 复核结论：**partial**。机制与归因成立——删课不清理活跃会话（`plan/commands.rs:133-137` 只 `DELETE FROM workout_plans`、`db.rs:226-240` `workout_sessions.plan_id` 无外键级联、`session/commands.rs:119-147` `session_active` 仍按 `status='active'` 返回孤儿会话），于是命中冲突分支、`applyRecord` 因 planId 查不到而作废会话，却仍无条件 `return 'conflict'`，用户被弹「请先接续」。
- **对不上的是最终结果描述**：发现说「打开的是一个空的沉浸层、唯一出口指向空沉浸层、需要自己退出再点一次」——实际不会卡在空层：`SessionOverlay.vue:194-206` 在每次开层时自检，phase 为 idle 就调 `hydrateFromServer()`，而此时孤儿会话已被 start() 内 `discardById` abort 掉，`getActive` 返回 null → hydrate 返回 false → 立即 `closeImmersiveNow()` 自行关层，用户被带回主页。真正残留的缺陷是：弹出一条对本已作废会话的伪冲突提示「请先接续」，且「前往继续」只换来一次开/关闪烁，用户需再点一次「立刻练」才开成——比原述轻，但提示语义确实错。
- 另：本条标注 `runtimeOnly`，其点名的真跑路径（mock 开课→收起→全部课程删课→回主页点立刻练）本环境为 Tauri 桌面应用、未运行，故该运行时验证 **not run**；以上结论均来自静态读码。

**F3 · foreignRoute 陈旧，把人送到跑步页**【verified】low · `src/stores/session.ts:473-482`（课程冲突分支未清 foreignRoute；唯一清零点 `:1076` 在 hydrateFromServer）；消费端 `src/components/home/HomeFooter.vue:426-430`、`src/components/exercise/PlanRecentCard.vue:44-48`
- 现象：跑步用过一次之后，训练课进行中点课程卡的播放键，弹「已有进行中的训练，请先接续」，「前往继续」却把人带到跑步全屏页，而不是回到正在上的训练课。
- 证据：全仓 `foreignRoute` 赋值只有三处：`session.ts:477`（start 找到跑步 active 时置 `/session/run`）、`:1073`（hydrate 找到跑步 active）、`:1076`（hydrate 找到非跑步 active 时清空）。跑步正常结束走的是 run store 的 finish/discard（不碰 session store），所以 `477` 留下的值会一直保留到下一次 hydrate。此后开一门训练课（`handleActive` 已无 active 行，start 走正常分支，`foreignRoute` 不动），课程进行中再触发 conflict（`479-481` 的 applyRecord 分支同样不清它），`goConflict` 读到的就是陈旧的 `/session/run`。
- 复核结论：confirmed。grep 全仓写入点与上述一致；`stores/run.ts` grep `foreignRoute/useSessionStore` 零命中（跑步收尾只调 `sessionService.finish(run.ts:342)`/`abort(:365)`，不碰 session store）；消费端两处均为 `if (session.foreignRoute) router.push(...) else openImmersive()`，陈旧值会 push 到 `router.ts:269` 的真实路由 `/session/run`；契约 `docs/ARCHITECTURE.md:212` 原文含「run.courseConflict / session.foreignRoute 区分训练课沉浸层与跑步 /session/run」。复核补充：一处未核——发现自陈未读 `src/pages/RunPage.vue`，其「到跑步页后被二次拦截并放行到训练课」半句不予背书；主结论成立。

### 3.2 现场做组

**F4 · 保存/放弃失败静默、且会重复落库**【verified】medium · `src/components/exercise/SessionOverlay.vue:1345`（并见 `471-481`、`487-492`）
- 现象：在总结页点「保存训练」（顶栏「结束」→「结束并保存」同理），若这一次写库失败（断网 / 后端不可用），按钮像没反应：没有提示、没有失败原因、覆盖层也不关，人停在总结页只能反复点或直接杀进程。点「放弃不保存」失败时同样没有任何动静。
- 证据：`SessionOverlay.vue:487-492` `async function saveNow(){ const r = await s.finishAndSave(); if (r) toast(...); closeImmersiveNow() }`——没有 try/catch，失败时 toast 不发、`closeImmersiveNow()` 不执行；`:1345` 直接 `@click="saveNow"`（Vue 事件回调里被拒的 promise 只落控制台）。`:475-479` 的放弃路径是 `void s.discard().then(() => { toast(...); closeImmersiveNow() })`，reject 时 then 整段不跑。`grep -rn "errorHandler" src/` 无输出、也无 unhandledrejection 兜底，故失败完全不可见。store 侧同样只有成功路径会收尾（`src/stores/session.ts:1013` 之后才 `endLocal()`）。同族的 `ActiveWorkoutBar.vue:154-160`（浮条「结束并保存」`await rt.finishCourse()`）也一样。
- 复核结论：confirmed。逐行核对 `saveNow` 无 try/catch、`:1345` 事件回调不 await、放弃分支 `.then` 无 `.catch`；`session.ts:993-1023` `finishAndSave` 在 `:1003` await finish 成功后才 `:1021 endLocal()`；`persistError` 只在 `persist()` 里写（`session.ts:141-145`），`finishAndSave`/`discard` 全程不碰它。`grep -rn "errorHandler|unhandledrejection|onErrorCaptured" src/` 无输出（exit 1）。同族 `ActiveWorkoutBar.vue:147-161`、`workoutRuntime.ts:190-193` 同样无捕获。

**F5 · 坞内组格把跳过组挪成「已完成」**【verified】medium · `src/components/exercise/SessionOverlay.vue:1260`（配合 `275-278`）
- 现象：跳过一组之后，坞里那排组格上的 ✓ 会整体往前挪一格：被跳过的那一格（格上就写着它的组号）显示成已完成，而真正做完的那一组反而还是个数字。于是「哪几组做了」在训练时唯一一眼可见的读数上是错的，只有点进全课抽屉才对。
- 证据：组格纯按完成数定位：`:278` `workingDone = s.exDoneSets.filter(d => !d.warmup).length`，`:1260-1264` `:class="{ done: i <= workingDone, cur: i === curTile }"` / `v-if="i <= workingDone">✓` / `v-else>{{ i }}`——全程不读 `s.skippedSets`。同一份数据在 store 里是按组号判的：`src/stores/session.ts:248` `state = skipped?.includes(setNo) ? 'skipped' : 'done'`，且「跳过 = 未做 = 不统计、不写 doneSets」（`:74` 注释、`skipCurrentSet :878-887`）。推演：跳第 1 组后完成第 2 组，此时 `workingDone=1`、`curTile=3` → 坞内渲染为「✓ / 2 / [3] / 4」（✓ 落在写着「1」的格上），而抽屉与顶栏胶囊（`:1209-1215`）口径是「1 跳过 / 2 完成 / 3 当前」、分母 4 分子 1。
- 复核结论：confirmed。`curTile`（`:275`）与 `workingDone`（`:278`）均为纯数量对齐，`:1255-1266` 组格不引用任何 `skippedSets`/`setSlots`；store 侧 `markSkipped:840-843` 只写 `skippedSets`、`skipCurrentSet:878-887` 不写 `doneSets`；`setSlots`（`session.ts:235-264`，`:248` 按组号判）唯一消费者是抽屉 `SessionCourseDrawer.vue:77`，顶栏 `doneCount/totalCount`（`session.ts:181-189`）亦不计跳过。推演复算成立：跳第 1 组 `setIndex=1` 时 `skipCurrentSet→startRest(false)`→`restOver :672-681` `setIndex++=2` 且 `doneSets` 仍空；再完成第 2 组后 `workingDone=1`、`curTile=3` → 组格渲染「✓(在写着 1 的格)/2/[3]/4」，同刻 `setSlots` 给出 slot0=skipped、slot1=done、slot2=current。

**F6 · 收起后倒计时遮罩仍全屏压制**【verified】medium · `src/components/common/CountdownOverlay.vue:80`（配合 `src/components/exercise/SessionOverlay.vue:1351-1357`）
- 现象：做完一组后收起到悬浮条（或直接点浮条的「完成本组」）继续休息，休息归零那一刻整个屏幕会被一张「开始第 N 组 / 下一个：X」的覆盖层压住约 1.2 秒，期间点什么都没反应；若在计时动作的 3·2·1 倒数中途收起，压制时间约 3.8 秒。
- 证据：CountdownOverlay 整体 `<Teleport to="body">`（`:80-88`），遮罩是 `position: fixed; inset: 0; z-index: 105`（`:92-98`）且没有 `pointer-events` 兜底——它逃出了 `.session-layer` 收起时的 `opacity: 0; pointer-events: none`（`SessionOverlay.vue:1431-1432`；收起走 `closeImmersive`，只摘 `is-open` 类，见 `src/system/sessionImmersive.ts:75-83`），而调用处没有任何门禁（`SessionOverlay.vue:1351-1357` 只有 `:show="s.overlay.show"`）。触发路径在 store：休息归零 `restOver → flashOverlay`（`src/stores/session.ts:667`、`678`，`flashOverlay :710-712`），倒计时 `prepareTimed`（`:721-726`）→ CountdownOverlay 的 GO 之后再 `finishAfter(800)`（`:66`）；浮条「完成本组」也走同一条 `completeSet → startRest`（`ActiveWorkoutBar.vue:215` → `system/workoutRuntime.ts:177-182`）。z 序实测：覆盖层 105 高于浮条 59/70（`ActiveWorkoutBar.vue:264/269`）与 TabBar 60。
- 复核结论：confirmed。逐处核对 Teleport、`z-index:105` 无 `pointer-events`、`finishAfter(1200)`（`:72`）与 GO 后 `finishAfter(800)`（`:66`）；全库 grep `overlay.value` 赋值仅在 `session.ts:711/716/725/1040`；浮条路径经 `workoutRuntime.ts:177-182 → session.ts:534-544 completeSet → startRest` 成立；z 序浮条 59/70、TabBar 60 均低于 105。

### 3.3 课程引导与换动作

**F7 · 换动作身份不进快照，恢复时回退且把组算到原动作头上**【verified】**high** · `src/stores/session.ts:110-128`（snapshotState）、`:947-953`（swapExercise 只改内存 plan）、`:958`、`:1088-1106`（applyRecord 从 planStore 重建 plan）
- 现象：训练途中换了动作（抽屉里点「更换」，或让 AI 换），随后锁屏被系统杀进程 / 切到别的课点「开始」被接管——回到页面时那个动作又变回了原来那个；而之前按新动作做完的每一组，被算到原来动作的头上（重量曲线里长在原来动作身上）。
- 证据：`snapshotState()` 只导出 `doneSets/exIndex/setIndex/weight/phase/restLeft/restTargetIsNextSet/timedTotal/restIsTemp/resumePhase/restWarmup/reps/extraSets/skippedSets/readiness`，没有任何字段承载被换掉的动作身份（`src/types/session.ts:94-119` 同）；`sessionService.snapshot` 的载荷也只有 `id/exIndex/setIndex/weightKg/state`（`src/services/sessionService.ts:28-41`）。`swapExercise` 只写 `p.exercises[exIdx] = {...cur, exerciseId, name, tips, muscles}` 然后 `touch()`（`:947-959`），而 `applyRecord` 用 `plan.value = {...p, exercises: p.exercises.map(cloneExercise)}` 从课程库重建（`:1106`）——换动作在恢复时被抹掉。因为 swap 保留了 `ex.id`，`doneSets[ex.id]` 里的记录仍在，`buildSetRows` 又按 plan 里的 `ex.exerciseId/ex.name` 出行（`:974-983`），于是被换动作的组以原动作的 `exerciseId` 落进 `workout_sets`（`ARCHITECTURE §4:112` 明确 `exercise_id` 是曲线聚合键）。`applyRecord` 的三条进入路径：start 冲突分支（`:480`）、`hydrateFromServer`（`:1078`）、`workoutRuntime` 启动接管。`ai/tools/session.ts:7,10-11` 的注释自称「store 的 action 内部会 `touch()` 落快照」「写操作先落地、再回话，断流也不丢改动」，`swap_exercise` 是其一——该承诺对本动作不成立。
- 复核结论：confirmed。`snapshotState:110-128` 无换动作身份字段；`types/session.ts:94-119` 同；`sessionService.ts:28-41` 载荷仅 5 字段；后端 `session/commands.rs:49-50,103-112` 只存 `ex_index/set_index/weight_kg/state_json`，无计划快照；`swapExercise:947-959` 只写内存 plan 并 `touch()`、保留 `cur.id`；`applyRecord:1106` 用 `planStore.byId(rec.planId)` 重建 plan；`buildSetRows:965-990` 按 plan 的 `ex.exerciseId/ex.name` 出行（`:975-978`）；`canSwapExercise`（`:931-933`）要求 `exDoneCount===0`；`docs/ARCHITECTURE.md:112`。

**F8 · 换动作后沿用旧动作的处方重量与建议**【verified】medium · `src/stores/session.ts:941-960`（swapExercise 只 touch，不重算建议）、`:379-383`（adviceFor 按 exerciseId/名字查表）、`:413-425`（weightFor 三级回落）、`:356-376`（loadAdvice）
- 现象：刚换成的那个动作，重量框里是「被换掉那个动作」的计划重量（卧推 60kg 换成划船，划船也是 60kg），而且「今日建议」那一行连同依据一起消失——想改的人反而失去了系统给的下一步，只能自己猜重量。
- 证据：`swapExercise` 里的对象展开 `{...cur}` 把被换动作的 `weightKg`（课程处方重量，`src/types/session.ts:33`）一并留在新动作上——而该函数上方注释 `:936-940` 只声明「组数、次数、休息、热身组等编排全部沿用」，未列重量，属于未登记副作用。`advice.perExercise` 只对传入的 planExercises 建键（`src/utils/trainingAdvice.ts:306-319`，key = `item.exerciseId || item.name`），换完动作后新 `exerciseId` 不在表里，`adviceFor` 返回 null → `weightFor` 回落到 `lastWeights[新 id]`（start 时按原动作 ids 批量取的，`:498`/`:394-406`）也取不到 → 最终回落到 `e.weightKg`，即旧动作的处方重量。全仓 grep 确认 `loadAdvice` 只在 start（`:497`）、applyRecord（`:1121`）、setReadiness（`:389`）三处调用，换动作后没有任何一次重算；消费方 `SessionOverlay.vue:95` 的 `curAdvice` 与 `SessionSummaryPane.vue:82` 因此同时拿到 null。此外 `warmupsFor` 以 `weightFor` 为唯一真源（`:435-440`），新动作的热身处方也是按旧动作重量换算出来的。
- 复核结论：confirmed。逐条成立：`{...cur}` 未列 `weightKg` 故继承旧处方重量，注释未登记；`adviceFor:379-383` 查 `perExercise[e.exerciseId] ?? perExercise[e.name]`，键在 `trainingAdvice.ts:306-319` 按换前 planExercises 建立→null；`weightFor:413-417` 三级回落最终落 `e.weightKg`；grep 确认 `loadAdvice` 三处调用、`swapExercise` 内只有 `touch()`；消费方 `SessionOverlay.vue:95`、`SessionSummaryPane.vue:79-83` 同源变 null；`warmupsFor:435-440` 以 `weightFor` 为唯一真源；`SwapCandidate.exerciseId` 非空（`SessionExerciseSwapSheet.vue:81`），不走 name 兜底歧路。

**F9 · 抽屉菜单标题 / 跳转提示用旧动作名**【verified】low · `src/components/exercise/SessionCourseDrawer.vue:241`（菜单标题）、`:126-127`（跳转 toast）对比 `:186`（行内名）
- 现象：同一行同一组，动作名在两处显示得不一样：抽屉行内是新名字，点开该组的「···」菜单标题和跳转后的提示却是旧名字。
- 证据：行内用 `lib.resolveName(g.ex)`（`:186`），而菜单标题 `:241` 与跳转提示 `:126-127` 直接取 `SessionSetSlot.exName`，后者是课程条目里的名称快照（`src/stores/session.ts:257` `exName: ex.name`，来自 `PlanExercise.name`「库内名缺失时展示用」，`src/types/session.ts:25-26`）。
- 复核结论：confirmed。`SessionCourseDrawer.vue:186` 行内名与 `:194` aria-label 走 `resolveName`；`openMenu:111-115` 传入的 slot 即 `SessionSetSlot`，其 `exName` 来源 `session.ts:255`（正式）/`:288`（热身）均为 `ex.name`（PlanExercise.name 快照）；`resolveName` 定义 `src/stores/exerciseLib.ts:85-87` `get(item.exerciseId)?.name ?? item.name`，库内名优先、快照回落。契约 `docs/ARCHITECTURE.md §4` 不变量 2：前端一律经 `resolveName()` 取库内名。复核补充：唯一偏差——发现写 `session.ts:257` 为 `exName: ex.name`，实际在 `:255`（热身 `:288`），系行号微偏移，不影响结论。

### 3.4 收尾与落盘

**F10 · 隔夜中断把挂钟时间算成训练时长**【verified】**high** · `src/stores/session.ts:316-319`（durationMin）、`:327-332`（durationSec）、`:334-343`（estimateKcalValue）、`:995-996` + `1008-1010`（finishAndSave 取用并落库）、`:1104-1124`（applyRecord 原样沿用 rec.startedAt，只对休息倒计时补时，对时长不做任何扣除）
- 现象：昨天练到一半来电/锁屏或进程被杀，今天接着练完，总结页「用时」显示的是从昨天开课到现在（可能十几个小时），「消耗」和「每组耗时」跟着一起放大；保存后这条记录带着这个时长进周概览/结伴成绩单。
- 证据：`durationMin/durationSec/estimateKcalValue` 三者都从 `startedAtIso` 单调推导：`Math.max(1, Math.round((Date.now() - Date.parse(startedAtIso.value)) / 60_000))`；`applyRecord` 在 `session.ts:1105` 写回 `startedAtIso.value = rec.startedAt`（原始开课时刻），而它只处理了休息（`1126-1140` 按真实流逝补时）与计时组（`1142-1146`「整组重做」丢弃间隔），对会话总时长没有任何扣除点；`finishAndSave` 把它写进 `durationMin`（`1008`）与 `kcal`（`996` → `estimateKcal`）。旁证 `src-tauri/src/modules/session/commands.rs:106-113` 的 `elapsed_sec` 同样按「上次快照到现在」累加，中断间隔一样被算进去，所以库里也没有一个更诚实的时长可回落。
- 复核结论：confirmed。`durationMin:316-319`、`durationSec:327-332`、`estimateKcalValue:334-343` 均同源墙钟；`applyRecord:1105` 写回原始开课时刻，`:1126-1140` 仅休息补时、`:1142-1146` 计时组整组重做，全文无时长扣除（`grep startedAtIso` 仅 `:1043` 清空/`:1105` 恢复两处）；消费侧 `SessionSummaryPane.vue:162`「用时」用 `s.durationMin`、`:93` 每组耗时经 `utils/sessionSummary.ts:433` `perSet=round(durationSec/done)`、`WorkoutRecordsPage.vue:142/161` 对 `w.durationMin` 求和；后端 `session/commands.rs:157-170` 原样写 `input.duration_min`、`:109` `elapsed_sec` 亦含中断间隔。对照跑步 `run.ts:71-73` `elapsedMs` 只累计 running 段，跑步侧契约成立。复核补充：fix 中「恢复后越快继续练放大倍数越大」措辞略含糊（越接近原开课时刻即中断间隔越大、真实训练越少，比值才越大），不影响结论。

**F11 · summary 页面无「回到训练」入口**【unconfirmed】medium · `src/components/exercise/SessionSummaryPane.vue:266-340`、`src/stores/session.ts:684-688`、`:785`、`:798-831`、`:1026-1035`、`src/services/sessionService.ts:59-60`
- 现象（原始）：在总结页发现少做/错做了一组，想回去补练或撤销最后一组——界面上只有「保存训练 / 放弃不保存」。保存会把错的那份记进历史；想改只能「放弃本次训练」，而放弃会把整节课已登记的做组全部丢掉（不是只丢那一组）。
- 证据：`restOver` 在最后一组后 `if (isLastExercise.value) { phase.value = 'summary'; return }`（`684-688`）自动落到终态；`addExtraSet` 明确 `if (!ex || phase.value === 'summary') return`（`785`）挡住加练；`redoLastSet`（`798-831`）没有 phase 门槛、逻辑上能从 summary 回退，但 `SessionSummaryPane` 整块模板（`266-340`）没有任何按钮调用它；扩展坞里的两个按钮（保存/放弃）不提供撤销。`sessionService.ts:59-60` 的注释与 Rust 侧一致：abort 不写 `workouts/workout_sets`。
- 复核结论：**partial**。现象与机制成立（summary UI 仅保存/放弃、加练被封、`redoLastSet` 在 UI 无入口、放弃丢全课做组）。两处需收窄：
  1. 「本环节没有任何入口／想改只能放弃／唯一路径」被**夸大**——AI 工具 `update_active_session` 的 `redo_last_set`（现位于 `src/ai/tools/session/adjust.ts`）无 phase 门槛、session 工具组常驻（`registry.ts` 的 `GROUP_POLICY.session`），summary 下可回退（`add_set` 除外，同文件拒绝）；因此是「缺界面入口」而非绝对无路可走。
  2. **契约归因错误**：`docs/ARCHITECTURE.md:95` 的 §4 不变量 5 只约束 `workout_sessions.status='active'` 行的离开方式；进入 summary 不调用 finish/abort、会话仍 active，该不变量未受违反，不应挂在「违反不变量 5 的意图」上。
- 复核另注：全课抽屉「跳至该组」也回不去（`session.ts:903` `targetIdx<cursorIndex→false`，summary 下 `cursorIndex=totalCount`，`:218-219`）。

**F12 · 保存成功后统计刷新失败会卡在 summary，重复 finish**【verified】medium · `src/stores/session.ts:993-1023`（finishAndSave）、`:1015-1021`（落库成功后先做无关刷新再 endLocal）、`src/stores/run.ts:341-360`（save 同构）、对照 `src/stores/session.ts:130-146` 与 `src/stores/run.ts:130-140`（persist 会记 persistError）
- 现象：点「保存训练」后界面停在总结页、什么提示都没有（训练其实已经写进库，或压根没写成功）；再点一次仍然没反应，用户不知道到底存没存。
- 证据：`finishAndSave` 里 `await sessionService.finish(...)` 之后是 `await Promise.all([exStore.loadWeek(...), useNutritionStore().loadSummary(...)])`，`endLocal()` 排在这两个刷新之后（`1015-1021`）；`finishAndSave`/`save` 内部既没有 try/catch 也不写任何错误状态——而同一批文件里的 `persist()` 每次失败都会 `persistError.value = e.message`（`session.ts:142-145`、`run.ts:136-139`）。落库成功后任一刷新抛错，本地就不会 `endLocal`/`resetLocal`：phase 停在 summary、`sessionId` 还在，界面无任何反馈。
- 复核结论：confirmed。`session.ts:1003-1022`：await finish 之后 `Promise.all`（`1015-1019`）、`bumpStrength()`（`1020`）与 `endLocal()`（`1021`）都在刷新之后，函数内无 try/catch；`run.ts:341-358` 同构；对照 `session.ts:130-146` 与 `run.ts:130-140` 的 `persistError`。调用方也无兜底：`SessionOverlay.vue:487-492` `saveNow`、`RunPage.vue:513-524` `doSave` 都仅成功路径给 toast/跳转。

### 3.5 状态机与异常

**F13 · 拉课程列表失败被当成「课程已删」，整场会话静默作废**【verified】**high** · `src/stores/session.ts:1091-1103`
- 现象：训练做到一半切走/被杀，重开 App 后悬浮运动条根本不出现：刚才那场训练连同已完成的组一起没了，没有任何提示或确认。用户以为记录还在，其实后端会话已被关掉，完成组的唯一副本（session `state_json`）再也读不回来。
- 证据：`applyRecord` 里 `if (!p) { try { await planStore.ensureLoaded(); p = planStore.byId(rec.planId) } catch { p = undefined } }`，紧接着 `if (!p) { await discardById(rec.id); return }`（`1091-1103`），`discardById` 走 `sessionService.abort`（`1032-1035`）。`plan.ts:40-42` 的 `ensureLoaded` 只是 `if (!loaded.value) await load()`，`load` 里 `plans.value = await planService.list()`（`plan.ts:21`）不吞错，所以拉课程列表失败会原样抛到这里，被当成「课程已被删除」。触发面：`main.ts:18` 在 `app.mount` 之前就 `workoutRuntime.init()` → `workoutRuntime.ts:69` `await useSessionStore().hydrateFromServer()` → `session.ts:1078` `applyRecord`，此时 planStore 尚未 loaded。作废后 `applyRecord` 正常返回，`hydrateFromServer` 仍 `return true`（`1085`），调用方会以为「已接续」。
- 复核结论：confirmed。`session.ts:1091-1098` 的 `try/catch` 把 `ensureLoaded` 抛错吞为 `p=undefined`；`:1099-1103` 把「列表没拉起」与「课程已删」并入同一作废分支；`plan.ts:18-21` `load()` 不吞错；`session.ts:1032-1035 discardById → sessionService.abort`；`session/commands.rs:223-229` 将 status 置 `'aborted'`，而 `commands.rs:119-124 session_active` 只 `WHERE status='active'`，此后无 App 路径可取回该会话。触发链、`return true` 与契约 `docs/ARCHITECTURE.md:213` 均核对一致。复核补充（不影响定性）：后端 `session_abort`（`commands.rs:225-228`）是标记 `status='aborted'` 而非物理删除，`state_json` 字节仍在库中；但无任何读取 aborted 会话的恢复路径，故「完成组再也读不回来、训练静默丢失」的功能性结论成立。走一遍即可复现：让 `session_active` 有记录而 `plan_list` 返回一次 Err，重开 App 观察浮条与会话行。

**F14 · 恢复时组号不封顶、计数与落库遍历不一致**【verified】medium · `src/stores/session.ts:1104-1113`
- 现象：训练中课程被改过（删掉一个动作、或把某动作组数减了）之后再重开：进度胶囊可能出现「第 5/1 组」这种越界组号，抽屉里原本做完的组凭空消失；最后保存出来的记录里那几组也丢了，但提示与总结环的「n/N 组完成」分子还把它们算着。
- 证据：恢复时只对动作下标钳制、对组号不钳制：`exIndex.value = Math.min(rec.exIndex, p.exercises.length - 1)` 与 `setIndex.value = Math.max(1, rec.setIndex)`（`1107-1108`）——同一处的不对称。`doneSets/skippedSets` 原样接收（`1111/1113`）。计数与落库用的却不是同一批数据：`doneCount` 遍历 `doneSets` 的全部键（`for (const arr of Object.values(doneSets.value))`，`181-185`），`buildSetRows` 只遍历当前课程的动作（`for (const ex of plan.value?.exercises ?? [])`，`967-968`），`totalVolume` 同样只遍历课程（`192-201`）。课程恢复是重新按 planId 取库（`1090-1098` + `ARCHITECTURE.md:213`），所以「会话建立后被编辑过」的课程会走进这个缺口。
- 复核结论：confirmed。`exIndex` `Math.min`（`:1107`）对比 `setIndex` 只 `Math.max`（`:1108`）；越界组号显示于 `SessionOverlay.vue:1070`、`workoutRuntime.ts:124-125`（`effSets=sets+extraSets`，`session.ts:166-168`）；遍历集合不一致——`doneCount:181-185` 全键 vs `buildSetRows:965-989`（`967-968`）只遍历 plan.exercises，`totalVolume:191-201`；分子用 `doneCount`（`session.ts:998-1000`、`SessionOverlay.vue:1211`、`SessionCourseDrawer.vue:178`），落库用 `buildSetRows`（`session.ts:1012`）；全库无「训练中禁改课程」守卫。抽屉侧 `SessionCourseDrawer.vue:47-75` 由 `courseSlots` 按 `plan.exercises/effSets` 生成，删动作整段消失、减组数可视组被截断。

**F15 · 墙钟时长（状态机视角复述）**【verified】medium · `src/stores/session.ts:316-319`
- 现象：开始训练后把手机放一边、切后台或被杀，隔几小时甚至隔天回来接着做完再保存——记录里的用时和消耗是「整段挂钟」，中间没练的那几小时全算成训练时间（例如做 40 分钟却存出 3 小时、上千大卡）。同一台设备上的跑步遇到同样情况反而只算真正跑的时间。
- 证据：`durationMin = Math.max(1, Math.round((Date.now() - Date.parse(startedAtIso.value)) / 60_000))`（`317-319`），纯墙钟、无上限；`estimateKcalValue` 直接用它算热量（`334-343`）；`finishAndSave` 把它写进训练记录与提示（`995`、`1000-1001`）。恢复路径不重设 `startedAtIso`：`applyRecord` 只 `startedAtIso.value = rec.startedAt`（`1105`），且 Rust 的 `session_active` 不按年龄过滤（`commands.rs:122` 只筛 `status='active'`），隔夜会话照样被接管续跑。对照跑步：恢复强制暂停态、被中断的那一段整段丢弃不补时（`run.ts:428-435`），保存时 `durationMin` 取 `elapsedMs`（`run.ts:330`，只累计 running 段）。AI 工具也读它：`ai/tools/session.ts:83` `elapsedSec: s.durationSec`。
- 复核结论：confirmed。`durationMin:316-319`（注释即称「会话墙钟时长」、无上限）、`estimateKcalValue:334-343`、`finishAndSave:995/1000-1001/1008`；Rust `commands.rs:158-164` 原样 INSERT `input.duration_min` 无钳制；恢复路径 `session.ts:1105` 只回写 `rec.startedAt`、`:1126-1140` 只对 `restLeft` 补时不回写 `startedAt`；Rust `session_active:119-124` 无年龄过滤；对照跑步 `run.ts:330/428-435`；AI 工具 `ai/tools/session.ts:83`。**与 F10 是同一处代码的两种观察角度**（F10 从「落盘口径」看，F15 从「状态机恢复」看），整改同一条（见 R5）。

### 3.6 动效与掉帧

**F16 · 收起形变期浮条折射未真正摘掉（超高/极致）**【verified】medium · `src/components/exercise/ActiveWorkoutBar.vue:324-331`（配 `58-63` / `173-178`）
- 现象：在「超高/极致」画质档下点「收起」，悬浮运动条虽然被形变壳整个盖住，但它那一整条全宽玻璃仍在逐帧重算折射——本该在这一段摘掉的背景滤镜还在付钱。屏幕越宽、设备越弱，越容易在收起那 400ms 里掉帧。
- 证据：`.dock-body` 的 `backdrop-filter` 是内联样式：`glassStyle`（`59-63`）在 liquidGlass 时生成 `url(#${glassFilterId}) saturate(...)`，绑在 `:style="glassStyle"`（`178` 行所在的 `.dock-body`）。而 `328-331` 的 `.wdock-root.immersive-measuring .dock-body { backdrop-filter: none; -webkit-backdrop-filter: none; }` 没有 `!important`，内联普通声明优先级高于作者普通规则 → 这条规则恒不生效。同仓同一意图的反例是 `SessionOverlay.vue:1453-1460` 的 `.session-layer.is-morphing :deep(.sgbtn)`，它带 `!important` 才压得住 GlassSurface 的内联 `url()`；组件注释 `52-54` 也明写「内联样式它压不过」。所以 `320-323` 注释声称的「只摘掉折射与交互…白付一次全条重采样」没有兑现。
- 复核结论：confirmed。`glassStyle:59-63`、内联绑定 `:176`；`.immersive-measuring` 规则 `:324-331` 无 `!important`，内联普通声明恒胜作者普通规则；对照 `SessionOverlay.vue:1453-1460` 带 `backdrop-filter: none !important`；`src/styles/base.css:622-629` 原文明写「折射那一支的 backdrop-filter 是内联样式…普通声明压不过内联」故带 `!important`；`grep immersive-measuring` 全库仅 `ActiveWorkoutBar.vue:95/324/328`。契约 `docs/ARCHITECTURE.md:133`「折射是有预算的…成本随 面积 × 每帧重算次数 涨」。复核补充：唯一小出入——`glassStyle` 绑定行是 `176`，发现括注写 `173-178`（仍在 `.dock-body` 范围内），不影响结论；该规则对 high 档（无内联）本可生效，问题仅限 ultra/extreme 的 liquidGlass 分支，与发现限定一致。发现的运行核验（超高档点收起、读 `.dock-body` 的 computed `backdropFilter` 是否仍含 `url(`）**未执行**，结论来自静态阅读与 `base.css` 既有注释佐证。

**F17 · 保存/放弃失败静默（动效视角复述）**【unconfirmed】medium · `src/components/exercise/SessionOverlay.vue:487-492`（saveNow；调用点 `474`、`1345`）
- 现象：总结页点「保存训练」，若落库失败，界面毫无动静：不弹 toast、不关层、也没有任何报错，用户会以为已经保存、或反复点同一个按钮。
- 证据：`saveNow` 只有 `if (r) toast(...)`，没有 try/catch；`s.finishAndSave()`（`src/stores/session.ts:993-1023`）在 `await sessionService.finish({...})`（`1010-1022`）上不吞错，后端不可用会直接抛 → `saveNow` 的 Promise reject，toast 与 `closeImmersiveNow()` 都不执行。更甚：finish 成功但紧随的 `exStore.loadWeek / nutrition.loadSummary`（`session.ts:1015-1019`）失败时，会话在后端已关闭、`endLocal()`（`1020`）却未执行，本地仍停在 summary 且 `sessionId` 未清，用户再点保存会对一个已关闭会话重复 finish。
- 复核结论：**partial**。两条机制（`saveNow` 静默、finish 成功后刷新失败跳过 `endLocal` 致重复 finish）经逐行核对全部属实，`symptom/where/evidence/contract/fix` 也属实。**唯一被否的是范围表述**：impact 中「这是训练旅程里唯一没有失败出口的写路径」不成立——`SessionOverlay.vue:476-479` 的放弃路径（`discard→sessionService.abort`，`session.ts:1026-1035`）结构完全相同，只有 `.then` 无 `.catch`，失败同样静默、层不关。
- 与 F4 是同一处代码的两种观察角度，整改同一条（见 R1）。

**F18 · 沉浸页滚动反馈接错容器，浮起反馈等于没接上**【verified】low · `src/components/exercise/SessionOverlay.vue:508`（`useScrolled(scrollEl)`），配 `507` / `981` / `999` / `1621-1624` / `1940-1949`
- 现象：训练中上下滚动沉浸页内容时，压在内容上的顶栏/底簇玻璃不会出现「内容滑到玻璃底下、影子变重」的浮起反馈——这条滚动态反馈在训练里等于没接上。
- 证据：`useScrolled` 的 `bindScroller` 从 `el.value?.parentElement` 起沿父链找第一个 `overflow-y:auto|scroll`（`src/composables/useScrolled.ts:38-48`）。这里传入的 `scrollEl` 就是滚动框本身 `.scrollbody`（模板 `999`；样式 `1621-1624` 是 `overflow-y:auto`），它的父 `.session-page`（`1470 overflow:hidden`）与 `.session-layer`（`1428 overflow:hidden`）都不可滚，再往上 SessionOverlay 挂在 App 根部、`.app-frame` 之外（`App.vue:272`）→ resolve 落到 window。于是 `bodyScrolled`（`508`）跟踪的是文档滚动，而训练中的滚动全部发生在 `.scrollbody`、`window.scrollY` 不变；模板里 `is-scrolled` 由 `bodyScrolled && immersiveOpen` 驱动（`981`），`1940` 那条「影子变重」规则永不生效。
- 复核结论：confirmed。`useScrolled.ts:38-44` 不检查传入元素自身，无匹配返回 window；`scrollEl` 即 `.scrollbody`（`:999`，`:1621-1624` `overflow-y:auto`）；父链 `.session-page:1465-1475`（`:1471 overflow:hidden`）→ `.session-layer:1424-1435`（`:1428 overflow:hidden`）→ App 根；`.desk-main` 的 `overflow-y:auto` 不在 `.session-layer` 祖先链上；驱动路径 `:981` 与唯一效果规则 `:1940-1949` 只由 `bodyScrolled` 驱动。契约 `docs/ARCHITECTURE.md:128`「沿父链解析出真正的滚动容器…约定传入的是容器内的后代元素，如 PageHeader 传 header 自身」；`PageHeader.vue:36-37` 符合约定。复核补充：一处措辞出入（不改结论）——`:508` 的 `bodyScrolled` 并非严格「恒 false」：若展开时底页已被滚动使 `window.scrollY>4`，它会冻结在 true 让 `is-scrolled` 常亮；两种情况都不是「随训练滚动自适应」。另发现里「`.app-frame` 也是 overflow hidden」不准确（`App.vue:283-291` 无 overflow 声明），但 SessionOverlay 在该盒之外（`App.vue:272`），不影响结论。发现的运行核验（沉浸层内设 `.scrollbody.scrollTop=200` 后读 `.session-page` 是否带 `is-scrolled`）**未执行**：当前 1420 端口无 dev server。

---

## 4. 已经做对、不许改坏的部分

这些是本轮优化绝不能顺手碰掉的既有正确设计。按主题归拢，引用照抄。

**入口与冲突防护**
- 四条开课入口都先走 `session.start` 的 `getActive` 冲突检测（`session.ts:473-482`），不会静默覆盖进行中的会话，冲突文案与「前往继续」语义一致（`docs/ARCHITECTURE.md:212`）。
- 双开与冲突防护成体系：课程与跑步都在开赛前 `getActive` 检查、区分后把用户指到正确的一侧（`session.ts:473-482` 设 `foreignRoute='/session/run'`；`run.ts:253-262` 设 `courseConflict`）；`RunPage` 挂载时先 `whenReady` 再 hydrate、冲突时弹「前往继续」而不是覆盖（`RunPage.vue:47-63`、`782-788`）。

**形变与收起/恢复**
- 收起/恢复的形变链路是契约钉死的，实现与注释自洽：显式锚点优先于「现量浮窗」（`sessionImmersive.ts:63-72`），浮窗尚未落位时 provider 返回 null 而不是量到 (0,0)（`ActiveWorkoutBar.vue:67-76`），收起期浮条保持原位不播位移动画、由落成溶解显形（`ActiveWorkoutBar.vue:78-79/88-96`；`sessionImmersive.ts:74-107`）；`scripts/e2e-immerse-toggle.mjs` 的 T1（hash 不变）/T2（closing 期 Dock/浮条先就位、收尾无滑入）/T3/T4（收起途中再展开）逐条钉住。
- 形变用自管 rAF 逐帧插值、`cur` 是唯一真源（`SessionOverlay.vue:527-701`），收起再展开从现值接续；`closeImmersive` 用 `!immersiveOpen || immersiveClosing` 挡住重复收起（`sessionImmersive.ts:75-77`），可打断性成立。
- 课程沉浸层不走路由、由 `App.vue` 常驻挂载（`App.vue:270-271`；`router.ts:274-276`），收起/恢复零重建。

**中断恢复与阶段自愈**
- 恢复现场的阶段自愈做得细：休息按墙钟补真实流逝并在归零后自动推进（`session.ts:1126-1140`、`590-602`），回到前台瞬间立即校正（`session.ts:1186-1190`），计时动作被打断降级为整组重做、热身被打断时按 `warmupPending` 校验避免卡在无组可做的相位（`session.ts:1142-1164`，`scripts/e2e-session-timed.mjs` S11 钉「脏快照阶段归一」），已删除课程按 `ARCHITECTURE.md:213` 作废而不是卡死。
- 恢复后建议引擎异步重算、且只在还没做过热身时才对齐预填，避免抹掉现场登记值（`session.ts:1120-1121`、`456-462`）。
- 冷开兜底存在：沉浸页自身也会再 hydrate 一次（`SessionOverlay.vue:199-200`），所以启动时 `getActive` 抛错被吞（`workoutRuntime.ts:62-67`）并不会让恢复彻底失去机会。
- 恢复路径守住了「不作废用户数据」：课程被删才作废会话（`session.ts:1099-1103`）；热身相位恢复时用 `warmupPending` 重新校验（`session.ts:1150-1163`）。
- 休息倒计时的补时做对了：剩余秒一律由墙钟 deadline 推导（`session.ts:97-99`、`592`、`597-602`），恢复时按 `updatedAt` 的真实流逝补偿一次（`1126-1140`），回到可见瞬间再校一次（`1188-1190`）；两端时间格式一致——mock 写 ISO（`mock/server.ts:5766`）、Rust 写 `datetime('now')` 的 UTC（`commands.rs:109-110`），`updatedAtMs`（`session.ts:1174-1180`）两种都能解析，无时区偏移。
- 计时动作被打断与 `ARCHITECTURE.md:210` 一致：快照 `phase='timed-run'/'timed-ready'` 一律回准备页整组重做（`session.ts:1142-1146`），临时休息中断把 `resumePhase` 从 `timed-run` 降级成 `timed-ready`（`1134-1138`）。
- 只有课程真被删、快照真损坏才作废（`session.ts:1099-1103`、`run.ts:407-413`）。

**落盘与提示纪律**
- 「每个状态事件都落盘」在全部推进路径成立：做组/热身/起步休息/计时完成/重量与次数调整/跳过/跳至某组/回退/自评都走到 `touch()`（`session.ts:149-151`、`534-577`、`721-755`、`767-792`、`878-926`、`386-391`），失败只置 `persistError` 不阻塞训练（`142-145`，`RunPage.vue:578` 页顶警示）。
- 同步失败是可见且不阻塞的：`persistError` 排在页流首位，顶簇用 ResizeObserver 量它的实际占高再整块让位（`SessionOverlay.vue:993`、`230-245`、`1585-1594`），注释写明不写死像素。
- 结束语义在代码层是唯一的：只有 `finishAndSave`/`discard` 关会话（`session.ts:5-10`、`993-1035`），服务端同语义只认 `session_finish`/`session_abort` 并把行标 `finished`/`aborted` 保留（`commands.rs:140-200`）。
- 落库契约清楚且被机器守：`session_finish` 事务内写 `workouts + workout_sets`（含 `exercise_id` 解析）+ 关会话，放弃不写记录（`sessionService.ts:46-60`；`scripts/e2e-strength.mjs:289-348` 钉住逐组落库与无 active 残留）；训练课与跑步的 kcal/强度口径各自成文、不混用（`session.ts:334-343`；`run.ts:84-93`）。

**建议引擎与输入**
- AI 写路径的失败面是收敛的：所有分支返回 `{updated:false, reason}` 或 outcome 回执，最外层还有 catch-all（`ai/tools/session.ts:123-130`、`349-352`），swap 的前置条件（已做过不能换、必须是同类、必须来自动作库）都在工具层显式校验（`:325-334`）；`scripts/e2e-session-warmup.mjs:222-243` 把越界 `goto_set` / 非法 action / 非法重量 / 缺参 `set_reps` / 无会话时写入钉成结构化拒绝（该脚本本次未运行，仅阅读）。
- 今日状态自评给的是数字不是空话：五档各自标出 ×系数、选中后预览「建议重量 ±X%」与「练够分 · 体感项 N 分」，未选时「就绪」禁用，Esc 被隔离在卡片内（`ReadinessDialog.vue:64-81`、`162-206`、`211`、`98-112`）。
- 输入侧不写脏值：`SessionBigNumberInput` 全角数字 / 中文句号 / 千分位逗号归一化后再解析（`:63-75`），按 `min/max/precision` 钳制；重量清空时组件给 null，调用方保留原值不让重量凭空变 0（`SessionOverlay.vue:178-184`）；重量回写一律走 store action（`:767-780`），保证 `touch()` 落盘。

**反馈与回退**
- 完成/打勾后的主反馈链是即时的：`completeSet` 一落库就整屏切到休息环（`SessionOverlay.vue:1155-1161`，环值由 `restProgress` 派生 `:445-447`），下一组该做几组几次几公斤写在 `restMetaText`（`:306-316`），顶栏 n/N 胶囊同步（`:1209-1215`）。
- 「按错了能改回来」有真出口：更多菜单的「上一组（重做）」（`redoLastSet`，`src/stores/session.ts:798-831`）在休息相位也能用，回退时会一并清掉被回退区间的跳过登记（`clearSkippedFrom :857-871`，注释写明与「游标之前的格子非完成即跳过」对齐），并弹「X · 重做」的闪现提示；失败时有「还没有已完成的组」的明文 toast（`SessionOverlay.vue:428-429`）。
- 跳过类的动作都有回执：`skipCurrentSet` 成功弹「已跳过当前组 · 不计入统计」、无组可跳弹「当前没有可跳过的组」（`SessionOverlay.vue:419-422`）；换动作、加练、今日状态各自都有对应 toast（`:427`、`:435`、`:441`）。
- 「跳过 = 未做 = 不统计」在 store 与界面两侧对齐：store 既不写 `doneSets` 也保留分母（`session.ts:76`、`840-887`），抽屉页脚、头部「已完成 X/Y · 跳过 N」、逐格 `is-skipped` 压暗+划掉全部读同一份 `setSlots`/`courseSlots`（`SessionCourseDrawer.vue:77-79`、`178-180`、`236`）。
- 热身组的格子单独拼装、不进游标（`session.ts:271-314`），避免热身污染「跳至该组」的下标语义。
- 换动作候选池口径正确且不关抽屉：只列动作库同类型（`kind` 相等）、排除隐藏项与被替换动作本身（`SessionExerciseSwapSheet.vue:41-43`），换完不关抽屉、用户当场看到新名字（`SessionCourseDrawer.vue:139-145`）。
- 临时换动作把 store 里那份课程深拷贝后才改（`session.ts:483-484`、`515-521`、`947-953`），并保留 `ex.id`，因此 `doneSets/skippedSets` 的键不漂移、全课组位下标不被打乱（配合 `:857-871` 的 `clearSkippedFrom` 不变量）。

**结算与数字口径**
- 总结页的数字不自己重算：完成环/容量/最高组/PR/肌群全部走 `utils/sessionSummary` 纯函数，分母分子与 store 的 `courseSlots` 同源（`SessionSummaryPane.vue:50-55`、`86-98`、`186-221`；`sessionSummary.ts:64-87` 跳过占分母不计分子、热身不进两者），e2e 还钉住「分母−分子 = 跳过组数」（`e2e-session-summary.mjs:244-246`）。
- PR 的两级可信度做得干净：即时档空心、历史校正后 `mergeHistoryPr` 严格大于（避免把本次自己当历史），且**文字**上也带「历史」而不只靠颜色（`SessionSummaryPane.vue:144-154`、`256-263`；`sessionSummary.ts:311-351`）；历史拉取失败静默但保留即时判定，绝不空页（`SessionSummaryPane.vue:122-137`、`145`）。
- 「取不到就不编」贯彻到底：`durationSec` 未开始时返回 0 而不是 60，`secPerSet` 低于 `MIN_SEC_PER_SET=5` 返回 null 而不是「0 秒/组」（`session.ts:321-332`；`sessionSummary.ts:413-437`），e2e 也钉了「无差异不制造差异」（`e2e-run-summary.mjs:325-327`）。
- `StrengthProgressCard` 的定时器与监听器成对收尾（`clearTimer / onBeforeUnmount`，`:56-68`、`96-102`），切后台就停轮播（`:88-91`），抽屉打开时也暂停（`:141-144`）。

**弹层、滚动与性能**
- 嵌套弹层不会互相踩：`AppMenu` 的 z-index 114 高于 `SheetModal` 的 100，抽屉里「跳至该组」菜单不会被抽屉面板盖住（`AppMenu.vue:21,488` vs `SheetModal.vue:445`）；`SheetModal` 有打开的抽屉栈，Esc 只关最上层，换动作面板会先于全课抽屉退出（`SheetModal.vue:27-28,128-132,145-146`）。
- 全课浏览的「打开即滚到当前组」写了两拍（`nextTick` + 入场 transform 落定后的 rAF 重新校准），且 `data-current` 同时标在热身行与正式行上（`SessionCourseDrawer.vue:81-100,208,219`）。
- 悬浮条的折射按预算名单走：只有 `liquidGlass`（超高/极致 + 内核画得出来）才把 blur 换成 `url(#f)`，量尺是浮条自身（`ActiveWorkoutBar.vue:43-63`），与 `ARCHITECTURE.md:133`「四条悬浮条」名单一致；减弱动效下动画被媒体查询压掉（`ActiveWorkoutBar.vue:505-520`）。
- 手机掉帧三根因都被正面处理：内容在非 1:1 缩放下不可见（展开 `p≥0.92` 才浮现、收起第一帧即隐藏，`SessionOverlay.vue:648-664 / 896-901`）；圆角逐帧写被节流到每 3 帧并末帧精确补写（`RADIUS_WRITE_EVERY`、`573-602`、`659`）；离场刻意绕开 animejs FLIP、只用 WAAPI 合成属性以避开肌群图子树强制布局（`799-829`）。
- 折射在形变期确实被摘掉——控制层的 `.sgbtn` 规则带 `!important` 压住 GlassSurface 的内联 `url()`（`1453-1460`，且 `scripts/e2e-perf-glass.mjs:1204-1209` 断言 `is-morphing` 收尾即摘），单条滤镜链、贴图指纹去重 + `MAP_CACHE`、ResizeObserver 与拖参合并到一帧一次（`GlassFilter.vue:80-95`、`186-259`）。
- 沉浸页滚动区走 item 型超伸（`.rubber-layer[data-rubber-content]`，`SessionOverlay.vue:1003`），符合 `rubberScroll` 文件头「页面级滚动区一律走 A」；`rubberScroll` 动效关时不接管、弹簧用 `isConnected` 守卫并清理 `will-change`（`rubberScroll.ts:339-344`、`285-294`）。
- `perf/motion` 的 `data-perf / data-glass / data-motion` 各自单写入点、旧档位有迁移、系统减弱动效与应用档位取「或」（`perf.ts:163-173`、`motion.ts:76-108`）。
- `CountdownOverlay` 的定时器有始有终：`show` 变化先 `stopTimer`，done 用可撤销的 `doneTimer`（`:26-46`、`48-76`），配合 immediate watch；Store 侧 `onOverlayDone` 才把「倒数结束→开跑」接上（`src/stores/session.ts:714-719`）。

**跑步侧与外围**
- 跑步侧对「被打断」的处理与总结页的诚实呈现：恢复强制暂停且丢弃当前段（`run.ts:433-435`）、总结页改填距离后分段配速整体撤掉并说明原因（`run.ts:326-360` + `e2e-run-summary.mjs:361-375`）、轨迹按 800 点抽稀控制 `state_json` 体积（`run.ts:105-113`）、总结停留时停掉前台保活（`run.ts:322`）。
- 跑步落盘节奏与体积有意识控制：10s 一次（`run.ts:291-292`）、轨迹抽稀上限 800 点（`105-113`），恢复时强制暂停并丢弃被打断的段（`428-435`），Android 侧另有前台保活/授权降级（`221-236`）。
- `WrapupPage` 虽是方案结营、不在这条旅程链路上（入口仅 `/program`，`ARCHITECTURE.md:189`），但四态各有出口、不会停在「加载中」（`WrapupPage.vue:117-129`）——不该被改坏。
- AI 写工具的越界防护成体系且失败不抛错：相位前置、数值区间、加练上限 10、跳组只允许向后、换动作限同类且未开始，失败统一 `{updated:false, reason}`（`ai/tools/session.ts:229-344` 与 `8-11/127-130` 的注释一致）。

---

## 5. 优化路线图

按 P0 / P1 / P2 排序。每项写清**为什么**（rationale）、**怎么改**（how）、**风险**（risk），并列出涉及文件。所有 `files` 均落在本轮允许清单可解释的范围内，清单边界见 6.3。

### P0

#### R1 · 保存 / 放弃失败要可见、可重试，且不重复落库
- **文件**：`src/components/exercise/SessionOverlay.vue`、`src/components/exercise/ActiveWorkoutBar.vue`、`src/stores/session.ts`、`src/system/workoutRuntime.ts`、`src/stores/run.ts`、`src/pages/RunPage.vue`
- **为什么**：verified——`SessionOverlay.vue:487-492` `saveNow` 无 try/catch，`await s.finishAndSave()` 抛出即整段中断，toast 与 `closeImmersiveNow` 都不执行；`:471-481` 放弃分支 `void s.discard().then(...)` 无 `.catch`；同族 `ActiveWorkoutBar.vue:147-161` / `workoutRuntime.ts:190-193`、`RunPage.vue:513-524` 同形；全仓无 `errorHandler`/`unhandledrejection` 兜底（grep 退出 1）。另 verified——`session.ts:1015-1021` 刷新排在 `endLocal` 之前，刷新失败会停在 summary 且 `sessionId` 未清，再点会对已关闭会话重复 finish。这是用户感知最强的一类「点了没反应、只能杀进程」。
- **怎么改**：分两类失败分别处理。① **finish/abort 本身失败**：`finishAndSave/discard` 不吞错，把失败写成独立状态（`finishError`，与 `persistError` 同族）后原样抛；调用点 `saveNow`/`onEndPick`/`doSave`/`finishCourse` try/catch，失败 toast 原因、保留层与总结态、按钮可再点（重试用同一 `sessionId`）。② **finish 已成功但随后的 `loadWeek`/`loadSummary` 刷新失败**：结束语义已达成，必须让 `endLocal()` 照常执行（把 `Promise.all` 包进 try/catch，刷新失败只写一条非阻塞提示）——**不要**把 `endLocal` 提前到刷新之前，提前会让 `sessionId` 清空、phase→idle，恰好丧失「重试用同一 `sessionId`」的能力；这两种失败不能共用一个 catch 语义。
- **风险**：触碰 `docs/ARCHITECTURE.md:209`「session_snapshot 失败不阻塞训练」的快照纪律与 `:212` 结束语义；后端 `session_finish` 不校验 status，重复 finish 会再插 workout（复核已指出），端到端重复保护必须靠本地 phase/sessionId 把关。必须明确区分「finish 失败」与「finish 成功后刷新失败」两条路径，否则两条 how 互相排斥。

#### R2 · 开课失败给用户可见回执（含补齐四处调用点的 catch）
- **文件**：`src/stores/session.ts`、`src/components/exercise/PlanRecentCard.vue`、`src/components/exercise/MuscleCatchupSheet.vue`
- **为什么**：verified——`session.start` 可抛的三处 await 是 `session.ts:474 getActive`、`:496-499 Promise.all`、`:501 sessionService.start`；四处调用点无 catch：`HomeFooter.vue:421-423`、`PlanRecentCard.vue:38-40`、`PlanDetailPage.vue:39-45`（整段无 try/catch/finally）、`MuscleCatchupSheet.vue:168-175`（try/finally 无 catch）；`transport.ts:43-51` 归一为 IpcError 后原样再抛，拒绝只落 console。复核点名要求把这四处都列入。
- **怎么改**：`session.start` 内把可抛的 await 包进 try/catch：catch 里经 `useToast().toast` 发一条「开课失败：<原因>」的可见回执（`useToast` 是模块级单例，store 可直接调用），然后原样 rethrow（保持既有语义、不改 IPC）；`PlanRecentCard.quickStart` 与 `MuscleCatchupSheet.begin` 补 catch 让按钮复位、可重试、不再产生 unhandled rejection。`PlanDetailPage.vue` 与 `HomeFooter.vue` 不在本轮允许清单，其可见性仅由 store 的 toast 兜住，本轮不改它们。
- **风险**：`docs/ARCHITECTURE.md:62`「store 决定提示方式，service 层不吞错」——提示放 store 合规，但必须保证成功路径不发 toast、失败只发一次，且 rethrow 后各调用点行为不变（`HomeFooter` 的 try/finally 不受影响，避免误开空沉浸层）。允许清单边界：`CountdownOverlay.vue` 与 `exercise` 组件在允许清单内；`PlanDetailPage.vue`、`HomeFooter.vue`、`composables/useScrolled.ts`、`types/session.ts` 不在。

### P1

#### R3 · 换动作后重算建议与重量，别沿用被换动作的处方
- **文件**：`src/stores/session.ts`
- **为什么**：verified——`swapExercise`（`session.ts:941-960`）用 `{...cur}` 覆写，未列 `weightKg`，把被换动作的课程处方重量一并留下；`advice.perExercise` 的键在 `trainingAdvice.ts:306-319` 按换动作前的 planExercises 建立，换完新 id 查不到 → `adviceFor` 返回 null → `weightFor`（`session.ts:413-417`）三级回落到 `e.weightKg`（旧处方重量）；`loadAdvice` 全仓只在 start/applyRecord/setReadiness 三处调用，换动作后无重算，`SessionOverlay.vue:95/158` 与 `SessionSummaryPane.vue:82` 的「今日建议」同源变 null。
- **怎么改**：`swapExercise` 成功后：显式给当前动作设一个基于新动作的重量，并 `void loadAdvice()` 重算建议；刷新 `lastWeights` 时**不能**直接复用 `loadLastWeights([新 id])`（`session.ts:394-406` 是 `lastWeights.value = map` 整表替换，会把其它动作的上次重量全清空，导致 advice 为 null 时后续动作的预填退化成课程重量）——改为合并写入（`lastWeights.value = { ...lastWeights.value, [新 id]: row }`）或新增一个定向补键的内部小函数。仅当前动作被换时同步 `weightForPhase`/`syncReps`。
- **风险**：触碰 `ARCHITECTURE.md:219` 训练建议引擎「只读预填」契约——重算只改本地预填、不写库、不改课程；须对齐 `resyncWarmupPrefill` 的「未做过才对齐」原则，避免覆盖用户已手改的当前重量，也不能让定向刷新误清 `lastWeights` 其余键。

#### R4 · 换动作身份随快照持久化，防止接管后回退并把组算到原动作头上
- **文件**：`src/stores/session.ts`
- **为什么**：verified（severity high）——`snapshotState`（`session.ts:110-128`）没有任何字段承载被换掉的动作身份，`sessionService.snapshot` 载荷只有 `id/exIndex/setIndex/weightKg/state`；`swapExercise:947-959` 只写内存 plan；`applyRecord:1106` 用 `planStore.byId(rec.planId)` 重建 plan，换动作被抹掉。因 swap 保留 `ex.id`，`doneSets[ex.id]` 仍在，而 `buildSetRows:974-983` 按重建后 plan 的 `ex.exerciseId` 出行——新动作做完的组以原动作 `exerciseId` 落 `workout_sets`，与 §4「`exercise_id` 是曲线聚合键」（`ARCHITECTURE.md:112`）冲突。
- **怎么改**：在 `session.ts` 内定义局部交叉类型 `SessionSnapshotState & { exerciseOverrides?: Record<string, {exerciseId;name;tips;muscles}> }`（不改 `types/session.ts`），`snapshotState` 带上该覆盖表（换动作时登记、换回原动作时删除）；`applyRecord` 重建 plan 后**必须把重放插在 `:1106` 重建 plan 之后、`:1111` 恢复 `doneSets` 之前**——public `swapExercise` 有 `canSwapExercise = exDoneCount(ex.id)===0` 的门槛（`:931-934/945`），`doneSets` 一旦先赋值，已有完成组的槽位会被静默拒绝，恰好在「换过动作且已做组后接管」的主场景失效；如不能提前，则走一个绕过该门槛的内部重放路径。
- **风险**：`src/types/session.ts` 不在本轮允许清单，只能用局部交叉类型 + 断言；后端 `state_json` 是通用列、无需新 IPC；重放顺序错误会静默失效（复核已指出须插在 `doneSets` 恢复前），且要处理「换完 → 恢复 → 再换」的幂等与覆盖表清理。

#### R6 · 恢复时区分「课程列表拉取失败」与「课程已删除」，别把整场会话作废
- **文件**：`src/stores/session.ts`
- **为什么**：verified（severity high）——`applyRecord:1091-1098` 里 `try { await planStore.ensureLoaded(); p = planStore.byId(...) } catch { p = undefined }` 把拉列表失败吞成 undefined，紧接着 `1099-1103` `if (!p) { await discardById(rec.id); return }`，把「网络/后端暂时不可用」与「课程确删」并入同一作废分支；`plan.ts:18-21` 的 `load()` 不吞错；触发链是 `main.ts:18 → workoutRuntime.init → hydrateFromServer → applyRecord`。作废后完成组的唯一副本（`state_json`）再无恢复路径。
- **怎么改**：`applyRecord` 改为返回明确结果（如 `'restored' | 'deleted' | 'retry'`）：`ensureLoaded` 抛错 → `'retry'`，**不 discard、不落本地态、保留 active 行**；加载成功且 `byId` 确无此课 → `'deleted'`，才 `discardById`。`hydrateFromServer` 据 `'retry'` 保持会话并等待下一轮（visibilitychange / 下次启动）再试。关键约定：`'retry'` 时 phase 仍可能是 idle，所以**调用方不得用 `phase==='idle'` 当作「会话已作废」的判据**（R12 依赖此返回值而非 idle）。
- **风险**：触碰 `ARCHITECTURE.md:213`「课程恢复按 planId 查库，查不到（已删除）则作废」——需把「查不到」收窄为「加载成功且确无此课」；同时要防止真被删的会话因反复重试永久留在 active。返回值信号是 R12 判定「确已作废」的唯一依据。

#### R7 · 恢复时组号封顶、记录口径与当前课程对齐
- **文件**：`src/stores/session.ts`
- **为什么**：verified——`applyRecord:1107` 对 `exIndex` 钳制却对 `setIndex` 只保底不封顶（`:1108 Math.max(1, rec.setIndex)`）；`doneSets/skippedSets` 原样接收（`1111/1113`）。计数用 `doneCount` 遍历 `doneSets` 全部键（`181-185`），落库 `buildSetRows` 只遍历当前课程动作（`965-989`）——课程在一个会话中途被编辑（删动作/减组数）后恢复，会出现越界组号、抽屉里做完的组凭空消失、记录丢组但总结环仍把分子算着。
- **怎么改**：`applyRecord` 把 `setIndex` 钳制到 `effSets(currentEx)`；对不属于当前课程动作的 `doneSets/skippedSets` 键显式处理（丢弃或计入一个明示的「已删动作」提示），使 `doneCount`/`totalCount` 与 `buildSetRows` 遍历同一批动作；钳制后重算 `cursorIndex`/`setSlots`。
- **风险**：触碰「跳过 = 未做 = 不统计」口径与 §4 逐组落库契约；钳制与丢弃会改变总结分母，必须与 `courseSlots`/`setSlots` 保持同源，避免坞内、抽屉、顶栏三处再次分叉。

#### R8 · 收起后倒计时遮罩不再全屏压制（store 侧可见性门）
- **文件**：`src/components/exercise/SessionOverlay.vue`、`src/components/common/CountdownOverlay.vue`、`src/stores/session.ts`
- **为什么**：verified——`CountdownOverlay` `<Teleport to="body">`（`:80-88`），遮罩 `position:fixed; inset:0; z-index:105`（`:92-98`）且无 `pointer-events` 兜底，逃出 `.session-layer` 收起态（`SessionOverlay.vue:1431-1432`）；调用处无门禁（`SessionOverlay.vue:1351-1357` 只有 `:show="s.overlay.show"`）。休息归零 `flashOverlay`（`session.ts:667/678/710-712`）或 `prepareTimed`（`:721-726`）触发时，收起态下整屏被压约 1.2s（3·2·1 中收起约 3.8s），期间点什么都没反应。`CountdownOverlay.vue` 在允许清单内。
- **怎么改**：采用 store 侧可见性门，而不是仅靠模板相与：`SessionOverlay` 依据 `immersiveOpen` 调 store 的 `setImmersiveVisible(bool)`；store 的 `flashOverlay` 在不可见时**不置 show**（语义推进照常），`prepareTimed` 在不可见时跳过 3·2·1 直接 `runTimed()`，`minimize`/`close` 时清除任何未消费的 overlay。仅用 `:show="show && immersiveOpen"` 不够——`flashOverlay` 在收起期间仍置 `show=true`，再展开会被 `CountdownOverlay.vue:48-76` 的 `watch(props.show)` 重新触发、补播一次陈旧闪现。
- **风险**：初一稿列的「模板相与」有陈旧补播问题：`flashOverlay` 在收起期间仍置 `show=true`，`CountdownOverlay` 的 watch 只在 `props.show` 变化时执行，展开时 `immersiveOpen` 变 true 会补播 1.2s（复核已指出）；本版改为 store 门，并须保证休息归零/计时起跑等 `onOverlayDone` 语义不丢。
- **复核意见（minor）**：定稿初版用 `immersiveOpen` 作为「可见」信号比实际窗口宽——收起动画期间 `immersiveOpen` 仍为 true（`sessionImmersive.ts:75-83` `closeImmersive` 只置 `immersiveClosing`，`:96-106 settleClosed` 才把 `immersiveOpen` 置 false），整个 400ms 里可见性门是开的；若休息归零恰落在这 400ms 内，仍会全屏压制 1.2s。信号应取「层已就位打开」（如 `immersiveOpen && !immersiveClosing`）而非裸 `immersiveOpen`。**落地时按此修正。**

#### R9 · 坞内组格按真实组位显示，跳过不再挪格
- **文件**：`src/components/exercise/SessionOverlay.vue`
- **为什么**：verified——组格纯按完成数定位——`SessionOverlay.vue:278 workingDone = 非热身已完成数`，`:1260 :class="{ done: i <= workingDone, cur: i === curTile }"`、`:1264 v-if="i <= workingDone">✓`，全程不读 `s.skippedSets`。推演：跳第 1 组后做第 2 组，坞内渲染成「✓/2/[3]/4」，✓ 落在写着「1」的格上，而抽屉与顶栏胶囊口径是「1 跳过 / 2 完成 / 3 当前」。训练时唯一一眼可见的读数因此是错的。
- **怎么改**：组格改为读 store 的 `setSlots`/`courseSlots` 同源数据判 done/skipped/current（跳过格显示 skipped 态、不显示 ✓），不再用 `i <= workingDone` 数量对齐；保持纯展示，不引入新写路径。
- **风险**：触碰「跳过占分母不计分子」口径与抽屉/顶栏一致性（`setSlots` 由 `courseSlots` 生成）；组格点击仍走 `completeSet`，不得改变既有命令。

#### R11 · 总结页提供「撤销最后一组 / 回到训练」
- **文件**：`src/components/exercise/SessionSummaryPane.vue`、`src/components/exercise/SessionOverlay.vue`
- **为什么**：verified（复核将范围收窄为「缺界面入口」）——`SessionSummaryPane.vue:266-340` 模板只有完成环/指标/进步/明细/肌群/建议，无任何返回训练的控件；`session.ts:684-688` 最后一组后自动进 summary、`:785 addExtraSet` 在 summary 直接 return；`redoLastSet`（`:798-831`）无 phase 门槛、逻辑上能从 summary 回退，但 UI 无入口（AI 工具 `redo_last_set` 常驻可达，反证「无路可走」不成立）。用户发现少做一组时只剩「保存错的那份」或「放弃整节课」。
- **怎么改**：在 summary 坞或总结内容顶部加一个次按钮调用 `s.redoLastSet()`（已存在），成功后 phase 回到 exercise 可继续；`add_set` 保持现状拒绝（避免与已进终态冲突）；按钮仅在确有已完成正式组时可用。
- **风险**：触碰 §4 不变量 5（active 行的离开方式）与结束语义——回到训练不调用 finish/abort，会话仍 active，合法；须保证按钮不误清用户不想回退的登记，并与 `clearSkippedFrom` 的游标不变量对齐。

#### R12 · 冲突分支按显式信号判定，且不清掉跑步指引
- **文件**：`src/stores/session.ts`
- **为什么**：verified（`foreignRoute` 陈旧）——全仓 `foreignRoute` 写入点只有 `session.ts:477/1073/1076`，跑步正常结束走 run store 不碰它，故 `:477` 留下的 `/session/run` 会一直保留；此后开训练课再触发 conflict，`goConflict`（`HomeFooter.vue:426-430` / `PlanRecentCard.vue:44-48`）会把人 push 到跑步路由。另 unconfirmed（复核判 partial，机制成立但「卡在空层」被证伪）——`start()` 冲突分支 `:480-481` 无条件 `return 'conflict'`，即使 `applyRecord`（`:1099-1103`）已把课程已删的会话作废、store 回到 idle，仍弹出对已作废会话的「请先接续」——纳入因风险低，且本版已把判定从 idle 改到 R6 的显式返回值。
- **怎么改**：判据用 R6 的返回值，**不用 `phase==='idle'`**（R6 的 `'retry'` 也会让 phase 停在 idle，会被误判为已作废）。仅当 `applyRecord` 返回 `'deleted'`（会话确已作废）时，`start()` 不再 `return 'conflict'` 而是继续走正常开课。清 `foreignRoute` 只在「非跑步的 conflict 分支（applyRecord 后）」与「正常开课路径」做；`session.ts:476-479` 的跑步分支刚写入 `/session/run`，属于冲突分支但**不能**清。
- **风险**：两条复核阻断点——① 不得用 idle 作判据，否则 transient `plan_list` 失败（R6 的 `'retry'`，phase 同样 idle）会被当成已作废，`start()` 继续调 `sessionService.start`，而 Rust `session_start` 会 `UPDATE workout_sessions SET status='aborted' WHERE status='active'`，正好销毁 R6 想保留的会话；② `:476-479` 跑步分支是冲突分支之一，按「冲突分支都清」的字面会把刚设的跑步指引清掉，使 `goConflict` 走 `openImmersive` 开训练课层，与 `ARCHITECTURE.md:212` 相悖。**若本轮不做 R6，则 R12 不可单独落地。**

### P2

#### R10 · 收起形变期真正摘掉浮条折射（超高/极致）
- **文件**：`src/components/exercise/ActiveWorkoutBar.vue`
- **为什么**：verified——`.dock-body` 的 `backdrop-filter` 是内联样式 `glassStyle`（`:59-63` 生成 `url(#…) saturate`，绑定 `:176`），而 `.wdock-root.immersive-measuring .dock-body { backdrop-filter: none }`（`:328-331`）没有 `!important`，内联普通声明优先，这条规则恒不生效——收起那 400ms 里全宽玻璃仍在逐帧重算折射。同仓同意图的 `SessionOverlay.vue:1453-1460` 带 `!important` 才压得住内联 `url()`。仅影响 ultra/extreme，用户感知为弱机上的收起掉帧。
- **怎么改**：给 `.wdock-root.immersive-measuring .dock-body` 的 `backdrop-filter` / `-webkit-backdrop-filter` 两条加 `!important`，与 `SessionOverlay.vue:1453-1460` 同做法；high 及以下无内联，规则自然不误伤。
- **风险**：触碰 `ARCHITECTURE.md:133`「折射是有预算的」与「内联样式压不过」的既有坑；须验证减弱动效媒体查询与正常档不受影响。

#### R13 · 抽屉菜单标题 / 跳转提示改用库内名
- **文件**：`src/components/exercise/SessionCourseDrawer.vue`
- **为什么**：verified（low）——行内名用 `lib.resolveName(g.ex)`（`:186`），而菜单标题 `:241` `${menuTarget.exName} · 第 N 组` 与跳转 toast `:126-127` 直接取 `SessionSetSlot.exName`，后者是课程条目名称快照（`session.ts:255/288`）。同一行同一组，抽屉行内显示新名、菜单与跳转提示显示旧名。
- **怎么改**：菜单标题与跳转 toast 不再取 `slot.exName`，改由 `slot.exIdx` 经 `lib.resolveName(s.plan.exercises[slot.exIdx])` 解析，与行内名同源；`exIdx` 越界时回落 `exName`。
- **风险**：触碰 §4 不变量 2「展示名一律经 `resolveName()`」；只改展示，不碰跳转逻辑与 `setSlots` 语义。

#### R14 · 沉浸页滚动反馈接上真正的滚动容器
- **文件**：`src/components/exercise/SessionOverlay.vue`
- **为什么**：verified——`useScrolled` 的 resolve 从传入元素的 `parentElement` 起沿父链找第一个可滚祖先（`useScrolled.ts:37-45`），而 `SessionOverlay.vue:507-508` 传入的 `scrollEl` 就是滚动框 `.scrollbody` 自身（`:999`，样式 `overflow-y:auto`），父链一路不可滚 → 落到 window。于是训练中滚动 `.scrollbody` 时 `bodyScrolled` 不随动，`:981` 的 `is-scrolled` 恒假，`:1940` 那条「内容滑到玻璃底下、影子变重」的浮起反馈在训练里等于没接上。
- **怎么改**：把 `useScrolled` 传入的 ref 改为 `.scrollbody` 的**后代**（如内部的 `.rubber-layer`），使父链解析命中 `.scrollbody` 而非 window；`useScrolled` 本身不改（不在允许清单）。
- **风险**：触碰 §5「沿父链解析最近滚动容器，约定传入的是容器内后代元素」；`.rubber-layer` 带 transform、不能当滚动容器本身，只作为解析起点，须确认订阅的是 `.scrollbody` 的 scroll 事件。

#### R15 · 主页开课入口的失败重试面（本轮暂缓）
- **文件**：`src/components/home/HomeFooter.vue`
- **为什么**：同上 R2 的 verified 缺口：`HomeFooter.vue:405-424 startNow` 与 `:426-430 goConflict` 无 catch，失败静默。R2 用 store 的 toast 给出可见性，但「按钮级重试 / 行内错误行」这一层只能在主页组件做，而 `src/components/home/**` 不在本轮允许清单。无需新增 IPC。
- **怎么改**：待清单放开后——`startNow` 补 catch，在「练」卡行内显示失败原因与「重试」按钮；`goConflict` 在 `foreignRoute` 为空时不要盲目 `openImmersive`，改为提示并复位。
- **风险**：`src/components/home/HomeFooter.vue` 不在本轮允许清单 → 本轮暂缓，仅由 R2 的 store toast 兜住可见性；落地时须与 R2 的「失败只发一次」约定去重，避免双重提示。

---

## 6. 本轮落地了什么、没落地什么

### 6.1 已落地

**R1（已落地）** —— `src/stores/session.ts`、`src/stores/run.ts`、`src/components/exercise/SessionOverlay.vue`、`src/components/exercise/ActiveWorkoutBar.vue`、`src/pages/RunPage.vue`、`scripts/e2e-session-summary.mjs`
- 变更：把「写库本身失败」与「写库成功后刷新失败」分成两条路径——新增 `finishError` 状态（与 `persistError` 同族），`finishAndSave`/`discard`/`save` 在 `sessionService.finish`/`abort` 抛错时记态并原样抛、不做 `endLocal`/`resetLocal`（层与总结态保留、`sessionId` 不变、按钮可再点、重试用同一 `sessionId`）；随后的 `loadWeek`/`loadSummary` 刷新单独 try/catch，失败只 `console.warn` + toast「已保存，但统计刷新失败」，`endLocal()`/`resetLocal()` 照常在其后执行；五个调用点（`saveNow`、`SessionOverlay.onEndPick` 放弃分支、`ActiveWorkoutBar.onEndPick`、`RunPage.doSave/doDiscard`）补 catch toast 原因；`finishError` 在 `SessionOverlay`/`RunPage` 顶部警示条优先展示，并在 `start()`/`endLocal()`/`resetLocal()` 清除。
- 改动复核（未参与实现者逐项核对 diff）：**delivered yes**。`session.ts:1022-1052 finishAndSave` 把 `sessionService.finish` 包进 try/catch（catch 里 `finishError.value=消息` 并原样 throw、不调 `endLocal`），成功后 `1042-1052` 才单独 try/catch 刷新，`endLocal()` 在 `1053` 照常执行；`discardById` 同构 `session.ts:1064-1072`；`run.ts:345-378 save()` 与 `run.ts:381-405 discard/discardById` 同构；`finishError` 在 `start()(session.ts:509)` 与 `endLocal()(1089)`/`resetLocal()(run.ts:419)` 清除并导出（`session.ts:1252`/`run.ts:480`）；警示条 `SessionOverlay.vue:1000-1006`、`RunPage.vue:588-589`；调用点 `SessionOverlay.vue:473-502`、`ActiveWorkoutBar.vue:151-172`、`RunPage.vue:507-533` 均补 catch。e2e 新增 S7a/S7b（`scripts/e2e-session-summary.mjs:427-447`），**实跑 26/26 通过**。
- 复核指出的遗留问题：① 失败注入分支仍只经静态核对（见 6.4、7.3），R1 的核心保证未被运行时验证；② 自述称「五个调用点补 catch」，实际为 6 处（`ActiveWorkoutBar` 的 save 与 discard 分支各一处），文字略有出入，不影响实现。

**R2（已落地）** —— `src/stores/session.ts`、`src/components/exercise/PlanRecentCard.vue`、`src/components/exercise/MuscleCatchupSheet.vue`、`scripts/e2e-immerse-toggle.mjs`
- 变更：`session.start` 整体包 try/catch——catch 里 `useToast().toast(\`开课失败：<原因>\`)` 后原样 throw（成功路径与 `'conflict'` 路径均不发 toast，语义与 IPC 不变）；`PlanRecentCard.quickStart` 与 `MuscleCatchupSheet.begin` 补空 catch（store 已提示，此处只吞拒绝避免 unhandled rejection，`finally` 复位按钮供重试）。
- 改动复核：**delivered yes**。`session.ts:485-533 start()` 整体 try/catch，catch 内 toast 后原样 throw；成功/conflict 路径（含 `505-512` 提前 return）在 try 内、不经过 catch，故不发 toast、返回值语义不变。`PlanRecentCard.vue:35-41`、`MuscleCatchupSheet.vue:172-178` 均补 catch 并 `finally` 复位。e2e 新增 T1b（`scripts/e2e-immerse-toggle.mjs:115-117`），**实跑 14/14 通过**（含 T1b，成功开课未误发「开课失败」）。
- 复核指出的遗留问题：① 只有 2/4 个 `session.start` 调用点处理了拒绝——`PlanDetailPage.vue:42 onStart` 无 try/catch，`HomeFooter.vue:415` 只有 try/finally 无 catch，这两处仍会产生 unhandled rejection（store 的 toast 仍给用户可见性）；这是改动前既有行为、非本次引入的回归，R2「避免 unhandled rejection」的意图只覆盖了被改的两个调用点。② 失败分支同样无运行时注入证据（见 6.4、7.3）。

### 6.2 未落地

- **R3、R4、R6、R7、R8、R9、R11、R12（P1）本轮均未落地**，仅完成设计。其中 R12 依赖 R6（见 R12 风险条），**若本轮不做 R6，R12 不可单独落地**。
- **R10、R13、R14（P2）未落地**。
- **R15（P2）本轮明确暂缓**——`src/components/home/HomeFooter.vue` 不在本轮允许清单，仅由 R2 的 store toast 兜住可见性。
- 复核结论栏 **regressions: []**（本轮未发现回归）。

### 6.3 允许清单边界（复核未获独立证据的点）

复核意见指出：任务材料未提供「本轮允许清单」本身，新版仅在 R2/R8 的 risk 里断言「`CountdownOverlay.vue` 与 exercise 组件在允许清单内；`PlanDetailPage.vue`、`HomeFooter.vue`、`composables/useScrolled.ts`、`types/session.ts` 不在」。复核已核对到 `PlanRecentCard.vue` 与 `MuscleCatchupSheet.vue` 确实位于 `src/components/exercise/` 目录下，`HomeFooter.vue` 在 `src/components/home/`、`useScrolled.ts` 在 `src/composables/`、`types/session.ts` 位置属实，但**无法独立证明「允许清单」这个枚举本身**，只能确认各 R 未点名为禁改项。这条不确定性随 R3–R15 的落地一并需要澄清。

### 6.4 落地过程中的已知不完整

- **失败分支无法注入**：`src/mock/server.ts` 不在允许清单、也不新增 IPC，故「让 `session_finish`/`session_abort`/`getActive`/`session_start` 在 mock 下 reject」这条注入路径不可用。因此：
  - R1 的「层/总结态不关、重试用同一 sessionId、不产生第二条 workout」；
  - R2 的「失败时恰好发一次 toast、按钮复位可再点、无 unhandled rejection」；
  两条链**只经 typecheck/lint/静态核对与成功路径 e2e**，未获运行时证据（详见 7.3）。要真跑须在 Tauri dev 或临时改 mock 令这些命令 reject。

---

## 7. 这份文档里的结论是怎么被验证的、还有什么没验证

### 7.1 本轮真正跑过的检查（命令与结果）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node_modules/vue-tsc` | 退出码 0 |
| IPC 契约 | `node scripts/check-ipc-contract.mjs` | 退出码 0 |
| ESLint | `node_modules/eslint` | 退出码 0 |
| 生产构建 | `node_modules/vite` | 退出码 0 |
| e2e 脚本语法 | `node --check` | 检查 2 个，失败 0 个 |

另据改动复核：新增的 `scripts/e2e-session-summary.mjs:427-447`（S7a/S7b）**实跑 26/26 通过**；`scripts/e2e-immerse-toggle.mjs:115-117`（T1b）**实跑 14/14 通过**（含「成功开课未误发『开课失败』」）。

### 7.2 结论的证据来源

- 第 2 节「体验流程」的每一行都取自**旅程测绘**给出的阶段表，其 `path`/`feedback`/`exits`/验收判据引用的 `文件:行` 照抄材料，未自行补行号。
- 第 3 节「真问题」来自**逐环节检验发现**与**独立复核结论**：每条 `verified` 都对应复核里逐行读码的结果（含 grep 输出、行号核对、z 序/访问性/遍历集合等推演）；每条 `unconfirmed` 都标注了复核驳回或收窄了哪一句。
- 第 4 节「不许改坏的部分」取自**已确认做对的部分**清单，仅做主题归拢、保留引用。
- 第 5 节「路线图」取自**定稿的体验流程与优化路线图**，并把 `设计过程：复审意见与最终定稿` 中针对 R8 的信号口径修正（改用 `immersiveOpen && !immersiveClosing`）如实附回 R8。
- 第 6 节「落地结果」取自**本轮落地结果**与**改动复核结论**。

### 7.3 没有验证的部分（如实声明）

1. **浏览器端到端回归未执行**：`scripts/e2e-session-*.mjs`、`e2e-strength.mjs`、`e2e-immerse-*.mjs` 等本轮没有执行——本机跑它们要另起 vite 与 Chrome，按既有约定要经用户同意再开浏览器。第 3、4 节中凡引用这些脚本「钉住某条行为」的地方，都是**读契约**而非本次真跑。
2. **Android 真机的中断恢复未验证**：锁屏/来电/后台被杀这三类中断只有在真机上才能验证；本文涉及「杀进程后按 `planId` 接管」「Android 前台保活」「恢复强制暂停」的结论均为静态阅读。
3. **运行时注入缺口未补**：R1/R2 的失败注入分支、F2 的删课冲突真跑路径、F16 的 computed `backdropFilter` 实测、F18 的 `.scrollbody.scrollTop=200` 实测，全部 **not run**（原因见 6.4 与各 finding 的复核补充）。
4. **`runtimeOnly` 的发现未被运行时确认**：F2（删课冲突，Tauri 桌面应用未运行）、F17（保存失败，含「唯一写路径」被证伪）两条带 `runtimeOnly` 标注，最终 status 为 `unconfirmed`。
5. **材料缺口**：任务点名的 `docs/STANDARDS.md §9` 无法阅读——`docs/STANDARDS.md` 全文 75 行、只有 §1–§8，不存在 §9，已按不存在处理并如实记录。
6. **另有两处「读到但未单列为 finding」的埋点**（供后续排查参考，非现行缺陷）：`src/system/workoutRuntime.ts:89` 的 `immersiveRoute` 课程分支仍返回已删除的 `/session`（`router.ts:274-275`、`ARCHITECTURE.md:203` 都写明原 `/session` 已移除），目前唯一调用方 `ActiveWorkoutBar.vue:141-145` 按 `kind` 分流绕开了它，属埋着的死串；`src/ai/tools/session.ts:272-275` 的 `redo_last_set` 无 summary 相位前置校验（同文件 `session.ts:785` 的 `addExtraSet` 有），能把「待保存」会话拉回训练——触发面窄，未占 finding 名额，但正是 R11「缺界面入口」的另一面。

---

### 附：本轮的验证环境说明

- 未运行任何构建/测试/回归脚本（本轮具体跑了哪些见 7.1；旅程测绘与逐环节检验阶段任务均未指定命令）。
- 本机没有可用的浏览器自动化通道；第 3 节全部结论来自上列代码行与文档行的静态阅读与 grep。
- 凡需真跑才能定论处，已在 finding 的 `runtimeOnly` / `evidence` / 复核补充里逐条写明「该跑什么」。
