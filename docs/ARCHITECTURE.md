# Rein 架构

> 修改本文档是改动架构的前置条件：代码与文档不一致 = bug。

## 1. 技术栈与分层

```
┌────────────────────────── Vue 3 + TypeScript（src/）──────────────────────────┐
│ pages/      一级页面，只做装配与数据加载                                        │
│ components/ 按领域分目录；通用件在 common/、layout/                              │
│ stores/     Pinia 按领域一店；写操作后联动刷新关联 store                          │
│ system/     应用级运行时单例（运动系统 workoutRuntime，main.ts 装载）             │
│ services/   IPC 封装层 —— 组件/store 禁止直接 import '@tauri-apps/api'          │
│ types/      领域类型（Rust models 的 TS 镜像，camelCase）                        │
│ config/     展示元数据（标签/颜色/MET 表/DRI）                                   │
│ mock/       内存后端，实现同一套命令契约（仅浏览器开发模式）                       │
└───────────────────────────────────┬───────────────────────────────────────────┘
                          invoke(cmd, args)  ← 唯一通道：services/transport.ts
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ modules/<域>/commands.rs   #[tauri::command]，参数校验 + SQL                    │
│ modules/<域>/models.rs     serde camelCase 结构体（= types/ 的镜像）             │
│ modules/<域>/mod.rs        列常量 / 行映射等模块内共享辅助                       │
│ db.rs  迁移（只追加）  state.rs  Db（连接锁，带中毒恢复）  seed.rs  首启种子   │
└──────────────────────────────── SQLite（应用数据目录/rein.db）─────────────────┘
```

## 2. 目录职责速查

| 路径 | 职责 | 不该出现的东西 |
| --- | --- | --- |
| `src/styles/tokens.css` | 全部设计令牌（颜色 / 圆角 / 间隔 / 排版 / 阴影 / 动效）。几何与排版对齐 HarmonyOS 设计规范，施工依据与逐条理由见 `docs/design/huawei/ALIGNMENT.md`：间隔走 4/8 栅格（`--sp-*` 数值档 + `--gap-*`/`--pad-*` 语义档），圆角层级正相关（4/8/12/16/20/32），字号 `--fs-*`。**组件里禁止再写裸 px** | 业务选择器；裸 5/7/9/11/13 这类非栅格值
| `src/components/common` | 与领域无关的通用组件 | 领域 store 依赖 |
| `src/system/*` | 应用级运行时单例（`workoutRuntime` 运动接管、`recorderRuntime` 录音、`voiceRuntime` 语音会话、`micBus` 麦克风互斥仲裁、`sessionImmersive` 沉浸层显隐、`globalFloat` 全局浮窗的显示时机 / 快照推送 / 浮窗动作、`perf` 掉帧判定与降级档） | 组件渲染逻辑、IPC 直连 |
| `src/services/*` | 命令名 → 类型化函数 | 业务逻辑 |
| `src/stores/exerciseLib.ts` | 动作库缓存与解析：`byId` / `resolveName(item)` / `musclesOf(item)` / `tipsOf(item)` / `forKind` / `search`。课程的展示名一律先查它，查不到才回落课程条目里的名称快照 | 写业务数据（增删改一律经 service）；认识页面组件 |
| `src/plugins/*` | 功能插件声明与注册表：`builtin/` 一个模块一个文件（`definePlugin`），`registry.ts` 纯数据（不认识 Pinia），`types.ts` 扩展点形状 | 启用状态（在 `stores/features.ts`）；直接 import router |
| `src/stores/features.ts` | 插件启用态（localStorage `rein.features.v1`）+ 派生列表：`tools` / `nav(surface)` / `isEnabled`（含**父关子关**的继承判定） | 业务逻辑；认识具体页面组件 |
| `src/mock/server.ts` | 与 Rust 相同的命令契约（**只在纯浏览器构建里存在**：Tauri 构建经 vite alias 换成 `src/mock/disabled.ts` 空实现，见 §15） | 生产分支逻辑 |
| `src/ai/*` | AI 推理层（pi-ai / pi-agent-core）：`runtime.ts` 模型装配、`probe.ts` max_tokens=1 能力探测、`vision.ts` 照片食物识别。模型请求由 WebView 直连 provider，不经 Rust | 直接 import '@tauri-apps/api'；**被 App/main 的静态 import 链够到**（`stores/ai` 一次静态 import 就把工具注册表与全部工具域拖进首屏主包 —— 入口侧一律函数内动态 import，见 §15） |
| `src/components/program/*` | 健康方案 UI（2026-10-04「溶解」重构后只剩向导与管理）：`ProgramConstraints`（内联约束向导，chips 写回 profile）、`ProgramCompare`（三档对比矩阵 + 4 周强度预览双视图）、`ProgramEvidenceSheet`（三条研究曲线）、`ProgramReviewSheet`（AI 复盘：数据先行 + 建议逐条采纳 + 实时汇总）、`ProgramStatusCard`（主页常驻状态卡：周次 / 今日动作 / 复盘到期入口）。执行发生在日常界面：训练课在画布（`CanvasTimeline` 的 `.blk.prog` + 点块直达开课），今日菜单在营养页 `components/nutrition/ProgramMenuCard.vue` | 直连 IPC；方案参数的写入 |
| `src/utils/trainingAdvice.ts` | **训练建议引擎**（纯数据 + 纯函数，无 IPC、不落库）：动作库默认处方 × 历史做组的 e1RM 基线（平均状态）× 今日状态（恢复间隔 / 周容量 / 趋势 / 自评）= 逐动作建议重量×次数×组数；另出每肌群周组数地标（MEV/MAV/MRV）对照。科学依据逐条写在文件头（Epley/Brzycki、Zourdos RPE 表、Schoenfeld 剂量反应、Damas 恢复窗口） | 任何 IPC / store 依赖；写库（建议只做预填与解释） |
| `src/components/exercise/*` | 训练课与动作库 UI：`SessionOverlay`（沉浸训练层：今日建议 chip + 依据 + 今日状态自评）、`SessionCourseDrawer` / `SessionExerciseSwapSheet`（全课浏览、换动作 = 从动作库同类型动作里选）、`ExercisePickerSheet` / `ExerciseFormSheet`（课程编辑的动作库选择器与自建动作表单）、`ExerciseLibrarySheet`（动作详情：肌群 / 曲线 / 今日建议 / 隐藏）、`ExerciseVolumeCard`（本周容量看板）、`StrengthProgressCard` / `WeightCurve` / `ExerciseDetailDrawer`（按库 id 的重量曲线） | 直连 IPC（一律走 services）；把建议写回课程 |
| `src/utils/programCurves.ts` | 档位科学依据的**纯数据 + 纯函数**：训练频次 / 睡眠时长 / 社交时差三条曲线、线性插值 `sampleCurve`、档位耐受度判定、SVG 坐标映射。不落库、不参与方案计算 | 任何 IPC / store 依赖；把它当作方案参数来源（唯一事实仍是 `TIER_SPECS`） |
| `src/utils/programCycle.ts` | 方案周期的展示口径（纯函数）：`programStatus`（起止 / 周次 / 进度 / 未开始 / 已结束）、`courseOnDate`（某天的课程）、`reviewDue` / `markReviewed`（复盘到期，localStorage 计时）。主页状态卡与方案页共用 | 写操作（除 `markReviewed` 的本地计时标记） |
| `src/utils/programExec.ts` | 方案执行口径（纯函数）：`trainingExec`（计划训练日 ⟷ 兑现日并集：有运动记录 ∪ 勾了日程）、`aggregateWorkouts`（次数 / 天数 / 课程会话数 / 分钟 / 消耗）、`trainedDates`、`plannedTrainingDates`。复盘、执行报告、结营成绩单共用 | 任何 IPC / store 依赖 |
| `src/utils/programSetup.ts` | setup 阶段纯函数：约束快照对比（`constraintSnapshotOf`/`sameConstraint`）、三档矩阵行 `matrixRows`、月度预期 `monthlyDeltaKg`、档位差异解说、4 周强度预览 `weekPreview`、约束即时预览 `constraintSummary` | 写操作 |
| `src/utils/programWrapup.ts` | 结营成绩单聚合：`buildWrapup`（复用 buildProgramReport 口径，补起点对照/最长连续打卡/徽章判定/下一期档位建议，纯前端规则） | 新增持久化 |
| `resources/foods.json` | 种子数据单一来源 | 运行时可变数据 |
| `resources/exercises.json` | 动作库种子（0025）：内置动作的唯一来源，由 `scripts/gen-exercises.mjs` 生成 —— 手写 SPEC（处方、要点、别名为手写；**肌群表必须显式给 `m`**，不再按名推导）+ `scripts/catalog/dataset.mjs`（exercises-dataset 精选子集，见 `resources/exercises.SOURCE.md`），禁止手改 | 运行时可变数据（用户自建动作落库，不回写种子） |
| `src-tauri/src/modules/update/*` | 在线更新：多源清单（自建服务 + GitHub）+ 清单/安装包**双验签** + 断点续传 + 平台安装（Windows NSIS · Android APK）。设置在 `app_meta`（`update_settings_v1`），下载物落 `<app_data>/updates/`，进度走 `update://progress` 事件 | 把签名校验做成可选项；在前端推算下载进度；在 Rust 侧装配模型配置 |
| `src-tauri/src/modules/maintenance/*` | 数据维护：分层清除软件数据（设置 › 数据 › 清除软件数据，`DataClearSheet` 两段确认：统计清单 + 长按 1.5s）。四档深度 cache / ai / business / factory，**档与档互不包含**；preview 与 clear 共用同一份分组定义（确认页清单 = 真删范围）；factory 动态枚举全库用户表（FTS5 走 delete-all，清空期间关外键、结束即还原），磁盘上只留数据库本件；除缓存档外清完由前端调 `data_app_restart` 重启（报告先回包再退进程，与 update_install 同纪律） | 按静态清单追迁移新表（factory 靠动态枚举自跟上）；清空事务里动连接级 pragma 不还原 |
| `src-tauri/src/modules/gateway/*` | 对外服务网关（设置 › 外部访问，`ExternalAccessSection` + `GatewayAuthSheet`）：`tokio-tungstenite` WS 服务，六条握手闸门（绑回环/Origin/Host/首帧令牌/逐次 scope/参数收紧），四态授权（本次会话内存 `conn_id→ConnGrant`、始终允许落 `ext_clients` + `sha256` 令牌、忽略限频、拒绝），28 条 `schedule.*`/`workout.*`/`pomodoro.*` 方法由 WS 私有 router 分发（**不注册成 tauri 命令**）。**模块门禁**：前端把「已启用模块 id」快照推给 Rust（`gateway_set_enabled_modules` → `app_meta:gateway.enabledModules`），`Method::plugin()` 逐方法给归属，关掉的模块其对外方法回 `module_disabled`（见 docs/EXTERNAL-API.md §4.7）—— 与 AI 工具组同一条纪律：关了开关，对外接口跟着关。设置与运行态只写 `app_meta`（`gateway.*`）；凭据/审计落 `ext_clients`/`ext_audit`（**不进同步白名单**）。变更推送复用同步已装的**唯一** `update_hook`（`sync/engine.rs`），网关**绝不**自己再装钩子 | 自己 `Connection::open`（会绕过同步钩子）；注册第二个 update_hook（顶掉同步捕获）；把 `ext_*` 放进 `sync/tables.rs` |
| `server/*` | **Rein 在线服务**（部署在阿里云 ECS，systemd `rein-services`）：更新清单与安装包分发、发布/回滚/镜像管理接口、（预留）OpenAI 兼容模型网关。零依赖 Node，无构建步骤 | 持有更新签名私钥（服务端只能分发别人签过名的字节）；把业务数据放进这个进程 |
| `scripts/release/*` | 发布工具链：`keygen`（生成 Ed25519 密钥对并同步公钥到三处）/ `publish`（签名 + 组装两套清单 + 推服务端/发 GitHub Release）/ `verify`（以客户端视角复核）/ `e2e`（本地起服务端跑完整链路）/ `deploy-server`（部署到 ECS） | 被前端或 Rust 代码 import；把私钥或管理令牌写进源码 |
| `src-tauri/gen/android/.../RunTrackingService.kt` · `TrackingBridge.kt` · `GlobalFloatService.kt` · `GlobalFloatBridge.kt` | 跑步前台保活 + 全局浮窗系统浮层（Android 原生侧，与 MainActivity 同为手工维护；`tauri android init` 重新生成会丢） | 业务逻辑、SQL |
| `src-tauri/src/modules/media/*` | HEIF/HEIC → JPEG（`image_decode_heif`）：Android 经 JNI 直调框架的 `BitmapFactory`（只碰框架类，不必加 Kotlin 桥接文件），Windows 经 WIC（依赖系统装了「HEIF 图片扩展」）。**原生优先**，失败由前端降级到 `src/utils/heif.ts` 的内置解码器（动态 import，2MB 的 wasm 分包不进主包） | 让 HEIF 混进「浏览器自己能解」的那一类；在第二个地方再实现一次解码 |

## 3. IPC 契约

- **命令命名**：动词开头 snake_case（`list_foods` / `log_meal` / `get_daily_summary`）。前端 service 函数同名 camelCase。
- **参数**：Rust 参数 snake_case ⇄ JS 键 camelCase（Tauri 自动转换）。结构体一律 `#[serde(rename_all = "camelCase")]`。
- **例外**：运动类型参数统一叫 `workoutType`，不用 `type`（避免原始标识符转换坑）。
- **错误**：后端 `ReinError` 序列化为结构化对象 `{ code, message }`（`error.rs`；`code` 是机器可读判据，现有语义码：`session_lost`（教务会话失效）、`heif_unsupported`（平台没有原生 HEIF 解码，前端降级））。前端在 `services/transport.ts` 归一为 `IpcError`（Error 子类，带 `code`）—— `e.message` / `String(e)` 的老写法照旧，需要分派时看 `code`，**任何一侧都不许解析文案**。store 决定提示方式，service 层不吞错。
- **新增命令三同步**：`modules/x/commands.rs` ↔ `lib.rs generate_handler!` ↔ `src/services/xService.ts`（mock 同步补同名实现）。这四条现在由 `npm run contract` 机器比对，CI 跑；漏一处即红。
- **WebView 面**：`tauri.conf.json` 的 `security.csp` 是白名单（`default-src 'self'` + 明确的 asset/data/blob 例外；Tauri 会为自己的注入脚本自动补 nonce），配合 `capabilities/default.json` 只授 `core:default`。**自定义命令不受 capability 约束**，所以 CSP 是这条边界上唯一的硬闸门 —— 改它要上真机确认不白屏（`npm run app:dev`）。

### AI 域说明（2026-08 起）

- **AI 域的职责边界**：Rust 只持久化**模型配置**（`ai_models`）与**聊天历史**（`ai_chats` / `ai_chat_messages`）；所有模型请求（照片识别、能力探测）在前端 WebView 内由 `@earendil-works/pi-ai` / `pi-agent-core` 直连 provider（DeepSeek 等 CORS 回显任意 Origin，已验证）。
- **模型装配**：pi 内置目录无视觉模型（deepseek-v4-flash-vision-exp 不在其中），`src/ai/runtime.ts` 用 `createProvider` 为每条配置自建单模型 provider（`openai-completions` 线路），thinking 的 deepseek 写法与 `max_tokens` 字段按 baseUrl 自动探测（URL 含 deepseek.com 即命中）。
- **能力探测 `probe.ts`**：六发 max_tokens=1（文本 / 文本+1×1 图 / thinking on / off / effort low / high）；200=支持，错误消息关键词分类（不支持→false、token 预算抱怨=参数已接受→true、鉴权错误→中止、其余→未知 null），原始错误落 `ai_models.last_error` 供复核。
- **照片识别 `vision.ts`**：已下线（识别统一走聊天流：附件图片随消息发模型，模型带工具看图出 food 卡）。
- **食物匹配与自动补录（2026-08-25）**：foodId 一律由模型自己调 `search_food`（Rust `search_foods_fuzzy` 按字包含/顺序相似度打分排序）选定；`ai/foodMatch.ts::toParsedItems` 对幻觉/缺省 foodId **直接自动补录**（create_food 同名幂等，营养取模型输出的 `nutrition` 字段，缺省回退 kcalEstimate）——解析卡不再出现"未匹配不可写入"。无模型时的本地关键词解析兜底保持只读不写入。
- **智能添加统一抽屉 `SmartAddSheet`（2026-08-25）**：替代原 `TodoAddSheet` 与 `QuickLogSheet`（均已删除）。`mode: 'todo'|'food'` 决定标题与手动入口（待办表单 / 食物库选择器），智能添加与 AI 聊天同款交互——选图先进草稿区（附件芯片可移除），可同时粘贴文字，点「生成」由 `ai/smartGen.ts` 单轮 Agent（挂 search_food/create_food/get_food 最小工具集）后台解析，任务类内容→待办草稿、吃吃喝喝→食物卡（估算重量），分区出卡供确认编辑后添加。
- **AI 联网工具（2026-08-25，2026-10-04 强化）**：Rust `modules/web`（ureq + html2text）提供 `web_search`（默认必应，`setmkt=zh-CN`）/ `web_fetch`（任意 URL→纯文本，SSRF 私网防护、15s 超时、6000 字符截断）。`web_search` 先把结果页抽成「标题 / 真实链接 / 摘要」清单（`extract_search_results`：扫 `li.b_algo` 块；链接是必应 `…/ck/a?…&u=a1<base64url>` 跳转地址时解回真身），一条都抽不到才回退整页转文本 —— 模型因此能把链接直接交给 `web_fetch` 读正文。前端 `ai/tools/web.ts` 注册进统一工具层（常驻组），聊天提示词有【联网】段：应用之外的事实先搜再答，营养 / 配料 / 菜谱 / 品牌规格尤其靠它，搜不到就说不知道。WebView 内 JS fetch 会被 CORS 拦，抓取必须走 Rust。
- **语音对话（2026-09-10）**：会议纪要式语音会话——持续说话，豆包流式 ASR（`bigmodel_async` + enable_nonstream 二遍识别，utterances/definite 驱动逐句落库）实时转写；停止后 `ai/memoGen.ts` 整理为纪要（AI 自动起标题 + 总结条目带引用角标 refs + 待办/饮食提取可写入），纪要可重放（音频增量落盘 app_data/voice_sessions/*.wav，asset 协议回放）与 TTS 朗读（seed-tts-2.0 HTTP）。**ASR 适配器层（2026-09-10）**：`modules/voice/asr.rs` 定义 `AsrAdapter` trait（connect/next_frame/send_audio/finish_input/on_frame → NormEvent）+ 枚举分发，豆包与 Qwen/DashScope（run-task/continue-task/finish-task JSON 控制消息 + Bearer 头，`sentence.end_time` 判句终，官方 SDK 1.27.4 核对）各一实现，两家协议互不通用；配置 `asr_adapter = auto|doubao|qwen`（+ `asr_adapter_user_picked` 区分程序替选/用户手选），auto 由 baseURL/模型名关键词识别（词表 Rust `AsrAdapterKind::detect` 与前端 `VoiceConfigSheet.detectAdapter` 一致）。前端双层选择：未手选 → 程序自动替选并跟随关键词换向/撤回；已手选 → 仅弹推荐气泡不强改。豆包 WS 需 `X-Api-*` 自定义鉴权头 → 连接在 Rust `modules/voice`（tokio-tungstenite + gzip 二进制协议，协议结论见 memory rein-voice-memo-asr）；前端 `system/voiceRuntime`（状态机 + AudioWorklet 16k PCM 200ms 包 + 3 分钟自动结算窗口）经 `voice_asr_*` 命令与 `voice://asr` 事件对接。纪要存 `voice_memos`（0016），语音轮是 kind='voice' 的普通聊天消息（与文字同会话）；AI 页输入 `@` 可引用纪要（memoRefs 注入消息文本）。麦克风经 `micBus` 与录音系统互斥；会话视图/浮条挂 App 根部不走路由。聊天与纪要总结的 AI 输出统一 Markdown 渲染（`utils/markdown.ts` 白名单 + `MdText` 流式按块增量；**表格（2026-10-08）**：GFM 表头 + 分隔行才升格为 `<table>`，分隔行没到之前按段落显示——流式中不猜；列对齐由分隔行的 `:` 决定，窄屏由 `.md-table-wrap` 表内横滚，样式与全应用的表（`.wtable` / `.matrix`）同一套语言）。
- **HEIF/HEIC 图片支持（2026-10-03）**：iPhone 拍的原图是 HEIC，Chrome 家族（含 WebView2 与 Android System WebView） 一律没有 HEVC 解码器 —— 系统相册打得开，`<img>` 打不开。分层解决： ①选图框的 `accept` 显式补 `.heic/.heif`（`IMAGE_ACCEPT`），`image/*` 并不含它； ②`utils/image.ts` 按**魔数**（ftyp 品牌，不信 MIME —— Windows 上 File.type 常为空）识别 HEIF， 先走**原生** `image_decode_heif`（Android BitmapFactory / Windows WIC，见 `modules/media`）， 任一步失败再退到 `utils/heif.ts` 的动态 import 软件解码（libheif + libde265，2MB 分包按需加载）； ③同一张图的结果按源 Blob 缓存，发送视图 / 缩略图 / 放大镜复用一次解码。 Windows 侧不自己处理旋转（HEIF 的 irot 由解码器应用），Android 侧必须自己补（`BitmapFactory` 不看 EXIF Orientation）。
- **待办智能解析 `todoGen.ts`**：与聊天同款前端 pi-ai 单轮 Agent（粘贴文本 / 图片 → 提示词约束 JSON 数组 → `TodoDraft[]`），草稿必须先经用户确认/编辑（现由 `SmartAddSheet` 承载）才落库；头像/文本共用 `src/ai/json.ts` 的 JSON 提取工具。`SmartAddSheet` 右上角提供「管理模型 ›」入口（`components/ai/ManageModelsButton.vue`，经 SheetModal `#action` 插槽放入）。`list_all_todos` 返回全部待办（含收件箱 date IS NULL），供主页紧急列表、待办页与虚拟时间线（`VirtualTimeline`，虚拟化渲染 + 双指/Ctrl+滚轮缩放）使用，排序：未完成 → 日期 → 时间 → 优先级；主页底部的「全部待办」信息流不走它——单独走分页读路径 `query_todo_feed`（见 §8 移动端主页）。
- **今日画布（2026-08-28）**：`/todos` = 未安排池（date=今天且 start_min 为空）+ 单日时间轴（`CanvasTimeline`：重叠贪心分列、指针拖拽改位、现在线、过去块降透明）+ 桌面右栏详情（`DayDetailPanel`，子任务可勾选）；移动端点块直接进编辑抽屉。智能排程 `autoSchedule.ts`：AI（单轮 pi-agent）产出建议槽位 → 幽灵块预览 → 用户确认才落库（L2 契约），无模型回落启发式（优先级×时长装填最早空档）。每日规划仪式 `DailyRitual`（当天首次打开，localStorage 打标）。周段 = `WeekTimeline`（7 列甘特时间线：横轴 7 日、纵轴 0-24 时、块按 date+startMin+durationMin 定位，长按 320ms 武装拖拽跨天改时、今天列现在线、过去列压暗、无时间待办收进底部池点击快排、Ctrl+滚轮缩放；布局复用 `utils/timelineLayout.ts` 与日画布同一分列算法）+ `WeekSummary`（完成率环 + 按天分布 + 本地洞察）。清单段 = `AllTodoList`（原分组列表）。前端每次 `loadAll` 先调 `sync_recurrences` 物化重复实例（幂等，失败静默跳过）。
- **聊天历史**：多会话（`ai_chats`，前端 `chatId` 指向当前会话，启动打开最近会话，历史抽屉 `HistoryDrawer` 切换/新建）；消息按 id 幂等 upsert（commit 状态变更不产生新行、不改变原 seq）；food-parse 的 items/source/committedAt 与 text 的 thinking/quote 序列化在 `payload`；图片存 1600px 压缩图（识别与追问复用同一张）。**照片静默入会话**（不自动识别、不输出内容，识别由用户提问触发，模型经历史图片块看图）。撤回 = `ai_chat_cut`（按消息 id 删该条及其后全部，级联）；清空上下文 = `ai_chat_clear` + 重写欢迎语；会话首条用户消息后自动把标题"AI 对话"改为前 16 字（`ai_chat_rename`）。
- **AI 工具与消息操作**：`chat.ts` 给 Agent 注入 `search_context` 工具（TypeBox schema，后端 `ai_chat_search` 跨会话 LIKE 搜索、命中含会话标题），模型可自主调用回忆历史。长按消息（450ms，移动 8px 取消）或右键 → AppMenu 的 bind 菜单（贴着气泡弹，图标 + 文字）：复制 / 引用 / 撤回（仅用户消息，级联）；引用以 payload 持久化、气泡内引用块渲染、发给模型时作为消息前缀上下文。
- **工具按需装载（2026-09-20）**：此前是「全量常挂」——83 个工具的 schema（约 42k 字符，每轮、每次工具回灌后的下一轮都重发）无条件塞给模型，且关掉课表/运动/方案后工具照旧全带。现在按**分组**装载（`ai/tools/registry.ts` 的 `GROUP_POLICY`）：常驻 9 组（饮食 / 营养 / 待办 / 知识库 / 记忆 / 历史检索 / 联网 / 看图 / 训练会话 = 39 个工具、15.6k 字符，实测降 63%）+ 按需 8 组（记账 / 运动记录 / 训练课程 / 健康方案 / 专注 / 模型配置 / 语音服务 / 校园教务）。按需组的装载有三条来路：本轮消息命中该组关键词、会话内已装过（粘住，`stores/ai.ts` 的 `chatToolGroups`；切会话按历史重播，撤回/清空/新对话归零）、模型自己调元工具 `load_tools`。粒度是**组而不是单个工具**——装载就给全（含 delete/update），半截组会让模型计划一个做不完的任务。三条配套约束：① **提示词段落与工具同进同出**：【模型配置】【语音】【校园教务】三段随各自分组出现/消失，未装载的组只在【工具装载】段留一行组目录（`toolGroupCatalog`），否则模型读得到用法却调不到工具、只能空转；② 功能插件（课表 / 运动 / 健康方案）关掉后**整组不给也不可装载**——修复了 AI 工具与插件开关此前完全脱钩的问题；③ 扩载走 `prepareNextTurnWithContext` 替换 context，**同一次 run 内**即可调用（`AgentToolResult.addedToolNames` 只是声明，plain Agent 不会自己激活，所以扩载靠这个钩子），不必让用户再说一遍。纪要认真整理这类非聊天链路可用 `opts.routeText` 另传判定文本。回归：`node scripts/e2e-ai-tools.mjs`。
- **卡片状态回灌（2026-09-26）**：回灌给模型的历史只挑 text/analysis/voice/photo/doc（`stores/ai.ts::sendText`），**卡片本身**（食物卡 `kind='food-parse'`、语音纪要卡 `kind='voice'`）与工具过程被整体丢弃——模型对自己出过的卡、用户有没有确认、最终写了什么一无所知，于是「用户已经确认了饮食，它还按没记录继续聊、甚至再出一张卡」。`src/ai/cardState.ts::buildCardStateBlock` 每轮现拼一段注入（经 `chatWithModel({ cardState })`，与【用户认知】同一条链路，不是又一个工具），**两条来源**：① **派生**——聊天里的卡从既有数据现算：食物卡（最近 6 张：已确认写入今日X / 未确认；用户改过则标「修改后确认」）与语音纪要卡（本会话纪要的总结条目「已写入 / 未写入」待办·饮食，状态在 `voice_memos.summaryJson`，`stores/ai.ts::memosForChat` 只在会话真有语音轮时查一次、不缓存）；② **记录**——跨页面的 AI 提议卡（智能添加出卡 / 目标建议 / 智能排程 / 方案复盘）的采纳·放弃由调用点在动作发生时记一条（`src/ai/cardOutcomes.ts`，localStorage `rein.aiCards.v1`，上限 10 条 / 24h 过期；它是「给下一轮模型看的一次性信号」而不是用户数据，故不进 SQLite、也不进知识库索引），渲染成【AI 提议处理记录】段。段落名从【食物卡状态】改成【卡片状态】（现在同时装食物卡与纪要），**未确认 ≠ 已记录**这条语义写进提示词【分寸】。食物卡另有两个字段进 `payload`（不透明文本列，Rust/mock/contract 零改动）：`mealType`（`commitParse` 时写，界面「已写入今日午餐」与回灌文案共用）与 `proposal`（建卡时模型原始条目的快照，用来判断用户改没改）。回归：`node scripts/e2e-ai-card-state.mjs`。
- **健康方案与 AI 调参（2026-08-26；2026-10-04「溶解」重构）**：方案基线由纯函数引擎 `src/utils/programEngine.ts` 确定性生成（三档参数表 × Mifflin-St Jeor 计算 × `resources/recipe_templates.json` 食谱模板装配 × 周计划模板组合），食谱模板营养值由 `scripts/gen-recipes.mjs` 从 foods.json 实算生成、禁止手填。**训练频率以用户设置的「每周可训练天数」为权威**（未设置时用档位默认；周模板覆盖 3~7 练，1~2 练从最低频模板裁剪）。2026-10-04 起方案**不再是独立大页面**：`/program` 只留「向导（约束 + 三档对比）+ 一屏管理（状态条 / 周期进度 / 复盘 / 采购 / 调参 / 调整历史）」，执行落在日常界面——计划训练课以 `program_id` 待办铺进画布（`category='workout'`，标题「方案·课程名」，**不再写饮食锚点**；点块直达课程开课），档位目标经 `saveTargets` 进入全应用目标管线（主页摄入条 / 营养页），今日菜单在 `components/nutrition/ProgramMenuCard.vue`（AI 按需生成 → `program_meals` 缓存 → 模板回落）。主页 `ProgramStatusCard` 是执行期常驻落点（周次 / 今日动作 / 复盘到期入口 → `/program?review=1`）。归档 / 删除当前方案时目标还原为档案默认值；旧版锚点由 `stores/program.migrateScheduleOnce` 一次性重排清除（localStorage 标记 `rein.program.sched2`）。AI 侧入口：聊天工具 `get_program`（只读）/ `generate_program`（生成并启用新方案，与页面同一引擎与激活链路，dangerous：会归档现有方案）/ `adjust_program`（调参，走 store.adjust 同一钳制链路）；周复盘经方案页发起或主页深链（`src/ai/programReview.ts` 汇总近 7 天执行数据 → 无工具单轮分析 → 结构化建议 → 用户确认后应用），AI 不生成新计划结构。
- **AI 定制菜单（2026-08-27）**：`src/ai/recipeGen.ts` —— 模型只出「结构」（餐次 + 库内食物 + 克重，经 search_food 选 id），营养一律由前端用食物库每 100g 数据实算，再按目标热量整体缩放（钳制 0.6~1.5，越界提示）。两个入口共用核心 `generateDayMenu`：食谱库的一日菜单、营养页「今日菜单」卡的**按需生成**（上下文含日期/训练日/近期已吃避免重复/忌口与偏好）。**每日菜单不再是模板写死、也不落日程**：未生成时回落模板菜单，生成一次即落 `program_meals` 缓存（可「换一批」重新生成）；方案调整后从当天起清缓存按新参数重生成；无模型用户始终回落模板菜单。**食谱偏好闭环**：`recipe_prefs` 表存喜欢(1)/不喜欢(-1)，食谱库页标记 → 方案引擎选菜（喜欢优先、不喜欢排除）与 AI 生成提示词共用。
- **体重趋势自动提醒（2026-08-27）**：`src/utils/weightTrend.ts` 纯函数按目标分带判定（减脂掉秤过快/反向增重/停滞、增肌同理、保持期波动过大），主页出现可忽略的提醒卡，直达方案页复盘。
- **归档执行报告（2026-08-27；2026-10-04 口径升级）**：`src/utils/programReport.ts` 汇总归档方案的执行数据，完成率改为**计划训练兑现并集**（`utils/programExec.ts`：当天有运动记录——课程会话 / 手动补录 / 手环同步都算——或方案日程已勾），并单列真实运动记录（次数 / 天数 / 课程会话 / 分钟 / 消耗）；「历史方案」区点开结营成绩单查看。
- **流式气泡的渲染不变量（2026-09-19）**：`agg.openBubble()` 预建的占位气泡是空 `text`，推理/工具阶段内容全在 `ProcessSection` 里——`.bubble` 有 padding/底色/阴影，若无条件渲染就会在过程区上方留一个什么都没有的「空气泡」。约定：AIPage 用 `showMsg`（整条消息有没有可渲染内容，顺带省掉它的间距）与 `showTextBubble`（正文气泡该不该出现）两道守卫做渲染判定，`stores/ai.ts` 侧不再留下空壳（`applyLlmReply` 空正文一律撤掉，且解析出的空串要保住流式已显示的正文）；回归见 `scripts/e2e-ai-bubbles.mjs`。

### 数据不变量

1. `meal_logs.grams` 恒为换算后的克重（unit 模式由前端换算后传入）；`units/unit_name` 仅展示。聚合只信 grams。
2. 日期一律本地时区 `YYYY-MM-DD` 字符串；时间戳一律 ISO-8601（UTC）。
3. 时间用「距 00:00 的分钟数」（`start_min`），不用 `HH:mm` 字符串存储。
4. `profile` 恒有一行（id=1），迁移里插入；目标字段以它为准。
5. **训练课会话**：`workout_sessions` 存在 `status='active'` 行 = 有未正常结束的训练。只有用户经「结束键 → 二级确认」调用 `session_finish/session_abort` 才会离开 active；其余一切（切页/收起/关机/崩溃）都视为**异常中断**，启动时由运动系统运行时（`system/workoutRuntime`）自动接管续跑，悬浮运动条（`ActiveWorkoutBar`）提示接续。前端每个训练事件调用 `session_snapshot` 落盘（`elapsed_sec` 由服务端按快照间隔累加）。
6. **训练课程**：课程是用户数据，存 `workout_plans` 表；内置课程种子来自根目录 `resources/workout_plans.json`（与前端 mock 共用的单一来源），启动时**按 id 幂等补齐缺失项**（Rust `seed_builtin_plans` 用 `INSERT OR IGNORE`，mock 用种子版本标记 `PLAN_SEED_VERSION`），已有行永不覆盖；代价是被用户删除的内置课会在下次启动补回。**种子内容版本**（Rust `app_meta` 三键 `plan_seed_applied` / `plan_seed_override` / `plan_seed_keep` = `PLAN_SEED_CONTENT_VERSION`，mock = `PLAN_SEED_VERSION`，当前 **5**）：种子里的课程内容（exercises/subtitle）变更时 +1，但**新版本不再自动覆盖存量内置课**——启动补种只做增量，版本落后时由课程库页横幅触发用户三选一：**兼容合并**（`plan_seed_migrate`，按动作 id 字段级合并，只补本地缺失字段、保留用户设置，推荐）/ **使用新版本**（`plan_seed_override`，整体覆盖）/ **保留我的**（`plan_seed_keep`，本版本不再刷新，下个版本再问）。前端在 `stores/plan.ts` 读 `seedStatus` 判断是否弹横幅。`last_used_at` 在每次开始训练时由 `touch_workout_plan` 更新，「最近使用的三个课程」按它倒序取前三。
7. **跑步会话**：复用 `workout_sessions`，约定 `plan_id='__run__'`（常量 `RUN_PLAN_ID`）；跑步专属状态（目标/累计时长/GPS 距离）全部放在 `state_json`，恢复时强制进入暂停态由用户手动继续。
8. **健康方案**：`programs` 同一时刻至多一行 `status='active'`（`program_create` 事务内自动归档旧方案）；方案内容由前端引擎确定性生成并整体存 `params_json`（Rust 不做计算），调整历史存 `adjustments_json`、每次调参版本自增。方案日程 = 带 `program_id` 的 todos，**只铺训练日课程条目**（`category='workout'`，标题「方案·课程名」）：`program_schedule_replace` 在事务内「删 fromDate 起未完成 → 整批写入」，删除方案时未完成日程一并清除、已完成的保留为普通待办。方案启用 / 调参时档位目标经 `saveTargets` 写入 profile（全应用目标同源），归档 / 删除当前方案时还原为档案默认值。AI 的角色被限制为参数复盘（缺口/蛋白配比/训练天数），任何建议必须经 `clampAdjustment` 钳制与用户确认，禁止生成新计划结构。复盘与完成率的口径统一为「计划训练兑现并集」（见 `utils/programExec.ts`），不数单一日志的勾选。

## 4. 数据库

迁移规则：`db.rs::MIGRATIONS` 数组下标即版本号，**只追加不改历史**。新迁移 = 末尾加一条 SQL。

**连接级 pragma 只在 `db.rs::tune()` 设一次**，各域不许再各自 `pragma_update`：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`（顺序固定，`journal_mode` 必须最先 —— `synchronous` 的语义由日志模式决定）。三条都有理由，改动前先读 `tune` 的注释与 `db::tests::tune_locks_connection_pragmas`：`synchronous` 是**写路径上最贵的一处**（WAL 下默认 FULL = 每次提交 fsync 一次；实测 2000 次单语句自动提交 2342.8 ms vs NORMAL 95.5 ms，**差 24.5 倍**），而它只影响性能不影响正确性 —— 把它删掉不会有任何功能测试变红；`foreign_keys` 反过来，默认关，漏了级联删除会静默失效。

表：`foods` / `food_units` / `meal_logs` / `profile` / `todos` / `workouts` / `pomodoro_sessions`（MIGRATION_0001）、`workout_sessions`（0002）、`workout_plans`（0003）、`ledger_entries` / `ledger_settings`（0004）、`calc_params` / `body_metrics`（0005）、`ai_models` / `ai_chats` / `ai_chat_messages`（0006）、`workouts.session_id`（0007）、profile 个性化约束五列 + `workout_plans.equipment/est_duration_min` + `programs` + `todos.program_id`（0008）、`recipe_prefs`（0009）、`program_meals`（0010，方案每日 AI 菜单缓存，PK(program_id,date)，随方案级联删除）、`todos.rec_rule/rec_key/subtasks`（0011，重复规则/实例键/子任务 JSON 列，rec_key 部分唯一索引保证物化幂等）、`shopping_checks`（0012，采购清单勾选）、`workout_sets` + `app_meta`（0013，逐组做组记录与通用键值元数据）、`todos.attachments`（0014）、`ai_models.image_max_edge`（0015）、`voice_memos`（0016，语音纪要：句子/总结存 JSON 文本列，音频为磁盘文件路径）、**`exercises` + `workout_sets.exercise_id`（0025，动作库与重量曲线聚合键）**、`exercises.favorite/steps`（0033，收藏与动作要领）、`ai_providers` + `ai_provider_models`（0040，提供商账号与其模型目录；目录 origin 三态 api/preset/manual）。营养值单位约定：宏量与纤维/糖为 g，钠钾钙等为 mg，维生素 A/D/B12/叶酸为 μg，C/E 为 mg。记账金额一律整数分（`amount_cents`）、恒为正，正负由 `kind`（expense/income）表达；`ledger_settings` 单行（id=1）存月度总预算。`calc_params` 单行快照方案计算器的身体参数（含手输年龄；改动静默自动落库）；`body_metrics` 体重身高按天一条、同日补录 COALESCE 合并，非空值同步写回 `profile` 保持计算器与「我」页同源。AI：`ai_models` 含能力探测三态（vision/thinking/effort 可空）、部分唯一索引保证至多一个默认；`ai_chat_messages` 的 `(chat_id, seq)` 唯一，`ai_chat_append` 按消息 id 幂等 upsert。健康方案：`programs.params_json` 存前端引擎的完整内容快照 `{params, days}`；`profile` 新列中 `preferred_time_slots`/`diet_restrictions` 为 JSON 数组文本列（NULL=未设置）；`workout_plans.equipment/est_duration_min` 是内置课程 meta（用户编辑不感知，upsert COALESCE 保留原值）。逐组记录：`workout_sets` 在 `session_finish` 事务内由前端提交的做组明细展开落行（workout_id 外键随 workouts 级联删除；**`exercise_id` 是重量曲线的聚合键**，`exercise_name` 只是历史快照；warmup=1 的行不计入正式组）；查询命令 `strength_history`（单动作全部做组行，入参可传库 id 或动作名）/ `strength_exercises`（有记录的动作清单，按库 id 聚合）/ `strength_last_weights`（批量取各动作最近一次做组重量，沉浸页预填「上次重量」）/ `strength_recent_sets`（近 N 天全部做组行，训练建议引擎的一次性原料）。

**动作库（0025 + 0033）**：`exercises` 是全部运动动作的**唯一真源**，内置动作来自种子 `resources/exercises.json`（`scripts/gen-exercises.mjs` 生成：处方与要点取自课程种子、**肌群激活表在 SPEC 里逐条显式手写**（缺失即生成失败），另有 `scripts/catalog/dataset.mjs` 的精选导入条目），`is_custom=0` 只读、每次启动覆盖式刷新**内容列**（含 `steps`）、用户态列（`hidden` / `favorite`）不被覆盖；用户自建动作 `is_custom=1`，可改可删。四条不变量：

1. **课程条目只存处方**：`workout_plans.exercises_json` 的每一项 = `{exerciseId, 处方…}`。写入路径（`upsert_workout_plan` / 课程种子覆盖与合并 / `session_finish`）统一经 `exercise_lib::resolve` 解析：缺 `exerciseId` 的按名（含别名）挂库，库里没有就**自动建成自建动作**——所以任何历史自由命名都不会丢，也不会出现「没有库 id 的动作」。自动建库时**课程条目上已标的肌群会清洗后带进库记录**（此前写死 `{}`，导致同一动作在课程里有肌群图、在动作库里空白）。
2. **展示名动态解析**：前端一律经 `stores/exerciseLib.resolveName()` 取库内名（内置动作随种子改名全端跟随），库里查不到（老库未回填 / 自建动作被删）才回落课程条目里的名称快照；`workout_sets.exercise_name` 是历史快照，永不追溯改写。
3. **曲线按 id 聚合**：`workout_sets.exercise_id` 刻意**不加外键**（自建动作删除后历史记录必须保留），查询时 `exercise_id = ?` 或回落到 `exercise_name`（未回填的老行）。
4. **回填幂等**：`db::init` 在种子之后跑一次 `backfill_exercise_refs`（只填 NULL、只补字段），老库升级即完成归一。

**肌群模型（39 键）**：`config/muscles.ts` 的 `MUSCLE_KEYS` = 26 个浅/深层分区 + 13 个深层结构与补充肌束（大圆肌 / 菱形肌 / 肩袖 / 前锯肌 / 髂腰肌 / 臀小肌 / 股中间肌 / 肩胛提肌 / 胫骨后肌 / 腓骨肌群 / 跖肌 / 腘肌 / 股方肌）。三视图 SVG（BodyParts3D 投影）里这 39 个分区**都已画好**：浅层直接可见，深层默认折叠、激活时以 `.overlay` 再叠画一遍（否则会被浅层盖住，出现「标了看不见」）。`MUSCLE_LABELS` / `MUSCLE_DESCS` / `MUSCLE_GROUPS`（表单分组）/ `MUSCLE_VOLUME_TARGETS`（容量地标，`Record<MuscleKey>` 编译期查全）四处必须同步；`normalizeActivation()` 是**全端唯一的肌群校验入口**（白名单 + 1~3 档），Rust 侧 `exercise_lib::muscles::sanitize_muscles` 与 mock 同语义，漂移由 `seed.rs` 的单测（对比种子里的 `muscleKeys`）把守。

**动作要领（`steps`）**：内置动作可分步说明（`steps` JSON 数组，最多 12 步、单步 200 字），详情页渲染成编号列表；自建动作可在表单里逐行填写（导入来源见 `resources/exercises.SOURCE.md`）。清洗在 Rust `exercise_lib::steps` 与 mock 各一份等价实现。

**AI 动作库工具**：`list_exercises`（读，回**完整档位表**）、`upsert_exercise`（写自建动作，`muscles` 为 39 键枚举 + 1~3 档）、`set_exercise_muscles`（只改肌群，内置动作拒绝）。三个工具的 schema 共用 `ai/tools/muscleSchema.ts`，描述里写明档位语义与「先查库、与库内同名动作保持一致」。

校园教务：`campus_accounts` / `campus_semesters` / `campus_courses` / `campus_sessions` + `todos.course_session_id`（0021，见 §12）；`campus_grab_tasks`（0022，自动抢课任务单，见 §12）；`campus_grab_intents`（0029，抢课计划/意向，见 §12）；`campus_period_slots`（0045，学校公布的节次时间表 → 周视图行轴的逐节真读数，见 §12）。

## 5. 设计系统

- 一切视觉值引用 `tokens.css` 令牌；暗色模式只改 tokens 的 dark 块。
- **页头图标按钮统一规范**：PageHeader 通过 `:slotted(.hdr-btn)` 提供标准样式（38px 圆钮、surface 底、卡片阴影；`.accent` 变体为主操作 CTA），各页 lead/action 插槽内的图标按钮一律挂 `hdr-btn` 类，不再各自写样式。**带数值的入口用文字胶囊变体 `.hdr-btn.pill`**（宽度随内容、字号 14、tabular-nums；材质/玻璃/按压反馈仍由那一条 `hdr-btn` 规则提供）—— 38px 圆钮装不下一句话，而「空间总览 · 12.3 MB」这类入口本身就是一句话，当前唯一调用方是文件页。
- **命令菜单一律走 `common/AppMenu.vue` 的 bind 模式（图标 + 文字）**：贴着触发元素弹出的锚定面板是默认形态 —— 页头「⋯」（健康方案）、底栏左钮长按换落点、消息长按/右键、课程组操作、休息加时与「更多」、内置课程升级三选一都走这一份（Teleport 到 body，不受父容器 overflow 裁剪）。**参数**：宽 200–300px（窄屏 `100vw−16` 兜底）、行高 ≥44、图标 19 / 图标列定宽 20（列表里只要有一项带图标，缺图标的项渲染等宽空位，标签左缘对齐）、锚点间隙 8、横向留白并上 `--safe-left/right`（手机手势返回带）、空间不足自动翻到锚点上方；桌面有 hover 反馈、键盘焦点内描边、标签不折行。**只有破坏性确认**（删除 / 放弃 / 覆盖 / 重置）继续用 `ActionSheet` / `SheetModal` 的模态弹层：确认需要遮罩压场，做成锚定菜单等于把确认降级成「菜单里点一下」。dialog 形态（`mode="dialog"` 底部操作面板）保留给「没有锚点、必须在底部出现」的场景，当前无调用方。回归：`node scripts/e2e-feature-toggles.mjs`（长按换落点）、`node scripts/e2e-cdp.mjs`（方案操作菜单）。
- **页头固定与渐进模糊遮罩**：每个非 fullscreen 页面都必须有 PageHeader，它 `position: sticky; top: 0` 顶住**最近滚动容器**——移动端滚文档、桌面工作台滚 `.desk-main`，两种壳同一份 CSS 都成立（`fixed` 在桌面壳里会跑到导航轨与信息栏底下）。滚动状态由 `composables/useScrolled` 沿父链解析出真正的滚动容器后监听，不写死 `window`。页面滚起来后页头背后压一层遮罩：正常档是多层 `backdrop-filter` + `mask` 梯度叠出的渐进模糊（越靠上被模糊的次数越多，向下递减到零，避免硬切边），降级档换成「`--bg` → 透明」的渐变底色遮罩。遮罩向上多铺 `--safe-top` 盖住状态栏、向下多铺 `--ph-tail` 让模糊化开、左右按 `--ph-bleed`（缺省 `--page-pad-x`，页面可覆写）铺满整帧。回归：`node scripts/e2e-page-header.mjs`（sticky 归属、遮罩显隐、层数与模糊量、降级档换底色、逐页标题）。
- **滚动容器按规范会裁掉溢出**（一个轴不是 `visible` 时另一个轴也变 `auto`）：气泡/卡片的 `--shadow-card` 会被自己的滚动区切出直边。聊天区 `.msgs` 用「负外边距拉满整帧 + 等值内边距推回内容」留出影子扩散位，新增滚动容器同理。
- **超范围回弹分两类层**（`system/rubberScroll.ts`，模块头有曲线与逐 move 判定的完整推导）：**item 超伸** = 滚动框站住、只有内部内容层位移（`data-rubber-content`；文档页层 `data-rubber-page`），**容器自身超伸** = 滚动框整体位移（`data-rubber-self`）。**页面级滚动区一律走 item 型**（ModelsPage `.page`、KnowledgePage `.scroll`、AIPage `.msgs`、RunPage `.pane`、SessionOverlay `.scrollbody`、VoiceSessionView `.body`/`.tr`）：页面框与吸顶页头必须站住，动的只能是 item；自身型只留给横向条 / 纯文本盒这类「位移的就是它本身」的小容器。带定位 / 入场动画的元素不能当层（会与动画抢同一个 `transform`），包一层镜像布局的 `.rubber-layer` 承载位移。组件自己接管触摸时（抽屉拖高度、待办芯片），touchmove 必须挂**窗口捕获阶段**并 preventDefault：本模块在窗口冒泡上监听，冒泡里的拦截晚一步 —— 同一段位移会被两边各吃一份（抽屉曾因此出现「容器下移 offsetY + item 又叠 offsetY」的 2× 位移）。
- **运行时画质档位**：`system/perf.ts` 提供四个**手动固定**档 `low|high|ultra|extreme`，存 localStorage `rein.perf.v1`；旧值迁移 `auto → high`、「超高＋」`ultra-opt → ultra`。UI 在「设置 › 性能」与「画质预览 › 档位」，档位清单 `PERF_MODES` 由两页共用一份。不再有掉帧自动判定与常驻 rAF 采样。`low` 落 `<html data-perf="low">`，`base.css` 据此关掉 `backdrop-filter` 与循环动画（一次性过渡保留），并把 `--surface-translucent` 顶成实底。
- **超高 / 极致与液态玻璃**：`ultra` 与 `extreme` 在 `high` 之上再开 `components/common/GlassSurface.vue` 的折射表面（移植自 vue-bits 的 GlassSurface：SVG 位移贴图 + 一次位移，经 `backdrop-filter: url(#f)` 作用在元素自身，折射的是**它背后的真实内容**）。两道门缺一不可：用户选了这两档、且内核认 `backdrop-filter: url()`（Safari / Firefox 会静默忽略整条声明，故有 `supportsSvgBackdrop()` 探测与「普通毛玻璃」退化分支）。`data-perf` 写 `ultra|extreme`，实际管线另写 `data-glass`：折射为 `collapsed`、不折射为 `off`。回归：`scripts/e2e-perf-glass.mjs`（预览页逐档 + 真实 Dock：三块玻璃逐块折射 / 不参与布局 / 页签对比度真图采像素 + 参数调节面板 + 两档玻璃带逐像素一致）。
- **折射是有预算的：只给离散小控件**。`backdrop-filter: url(#f)` 每挂一块就是一次独立的背景滤镜，成本随**面积 × 每帧重算次数**涨，所以铺给谁不是"哪个更显眼"，而是"面积够不够小"。当前名单：底部 Dock 的三块玻璃、ToastHost 的提示条（它的 `fill` 单独给 `--surface` 的 86% 而不是 `--glass-fill` —— 提示条压在任意内容上、文字还是 nowrap 的一行短句，底越薄越过一句就看不清一句；这是 `fill` 这个口子存在的意义：同一套材质、不同浓度）、运动沉浸页的控制层、**页头的圆钮（返回键自己一片 + 动作区相邻的并成一壳，见下条）**、**四条悬浮条（运动 / 录音 / 语音 / 抢课）**、**AI 底栏的输入条（2026-09-28 从「贴底一整条 tab 栏」改成悬浮 dock 样式后收进来的：先按三块收，实测这台机上 AI 页在超高下变成 9 块折射面 / 57,062px²、底栏自己占掉一半，于是只留输入条这一块挂 `url()` —— 两块芯片退回令牌材质，有材质升级、没有位移；底栏整组同时**不在滚动容器里**（`.msgs` 的兄弟，自己占一行）：放进滚动区时正文会从它背后滚过去、在芯片与输入条之间的缝里露出被切断的行，挪出来之后正文永远在它上面）**。那四条悬浮条是 2026-09-25 收进来的，页头圆钮与 AI 底栏的输入条是 2026-09-28，同一条判据：「它是不是浮在内容之上、底下有没有东西会动」（浮条底下正文照常滚过，页头圆钮背后是滚动的页面内容）；页头圆钮 2026-10-09 起按「相邻并壳」收成本，见下条—— 而只挂 `blur()` 的版本在超高下与高画质档读起来是同一层糊，名字在、材质不在。**大面积表面仍一律走 `.glass-surface` 的材质升级**：导航轨 / 信息栏 / 抽屉 / 会话面板不做折射（信息栏更明确 —— 它是一条可滚动的大面板，自己带 `backdrop-filter` 就会变成后代的 backdrop root，里面的问句条会退化成"只采到信息栏自己的内容"）。**扩大的是材质覆盖，不是折射名单 —— 而且从 `high` 起就铺开了**（2026-10-03）：高画质及以上，卡片 / 抽屉 / 菜单 / 操作面板 / 快捷磁贴 / 页头圆钮改用同源的 `--glass-*` 材质（承载正文的表面走更实的 `--glass-panel-fill`），仍然不做 `url()` 折射；超高 / 极致只是在同一批表面上把光学层加深。
  > **页头圆钮 2026-10-09 改成「相邻并壳」**：仍是折射件，但动作区相邻的圆钮共用一个壳、只挂一次 `url()`。实测背景：课表页超高档下「每挂一块 url() 就是一次独立的背景滤镜」，三颗圆钮占 0.36ms/帧，而超高相对高画质的全部增量只有 0.4ms 上下 —— 撤下折射不是办法（页头背后是滚动的页面内容，换成 blur 后页头带 33% 的像素变了两级、最大差 135/255，折射看得见）。合并之后合成净成本 **+0.45 → +0.125ms/帧**（同页同负载），而页头按钮带的像素差最大 5/255、变化像素 ≤0.26% —— 白拿的。壳自己什么都不画（没有底、没有命中区），只决定背后被采样几次；壳的尺寸由 GlassFilter 量自己，圆钮加减自动跟上。`:has(> .hdr-btn:not(.accent))` 是净网：action 插槽里只有 accent 主操作钮（模型页）或根本不是玻璃钮（记账的月份导航）时，壳不挂滤镜 —— 没有圆钮要为它付钱。返回键仍在名单里自己一片（它左边没有别的圆钮可合并）。回归：`scripts/e2e-perf-glass.mjs` 第 10 节（壳挂 url() / 壳内圆钮 bf=none 且材质不动 / 两份滤镜定义已烘 / accent 与月份导航不误挂）。

## 6. Mock 模式

`transport.ts` 探测 `__TAURI_INTERNALS__`：非 Tauri 环境动态加载 `mock/server.ts`（内存数据 + 演示记录）。
约束：mock 必须与 Rust 实现同一套命令名与参数键（含 `workoutType` 这类例外）；演示数据只在 mock 中存在，真实库只种食物库与 profile。

## 7. 扩展指南

**新增一个页面**：`pages/X.vue` → `router.ts` 登记（meta.tab）→ 若属一级导航，在对应插件的 `nav` 里加一条（`surfaces: ['tabbar']` 落在移动端 Dock 的药丸、`['rail']` 落在桌面导航轨）；路由若归属于某个功能模块，写进该插件的 `routes` → 本文件登记路由清单。

**新增一个功能模块（插件）**：
1. `src/plugins/builtin/<模块>.ts`：`definePlugin({ id, name, desc, icon, accent, routes, tools, nav })`；可被用户开关的模块加 `toggleable: true`（列表自动出现在「设置 › 打开或关闭功能」）；是某个模块的子模块就加 `parent: '<父模块 id>'`（父关子关、设置页缩进显示）
2. `src/plugins/builtin/index.ts` 加一行 import（导入即注册）
3. 页面 / store / service 仍照常分层（插件只声明入口与路由归属，不代替分层）
4. **若它还带着后台任务（引擎、定时器、常驻浮条），必须给后端一个真门闩**：开关变化同步过去（如 `campus_grab_set_enabled`），让引擎在不该跑的时候一个请求都不发 —— 只关 UI 等于没关
5. 工具卡二选一：`to`（跳转）或 `action`（就地动作 —— 需先在 `plugins/types.ts` 的 `ToolAction` 加字面量，再由承载工具格的页面在 ACTIONS 表里实现）
6. 补 `scripts/e2e-feature-toggles.mjs` 断言（含默认开关状态与父子联动），并更新本文件

**新增一个领域模块（后端）**：
1. `src-tauri/src/modules/<域>/`：`mod.rs` + `models.rs` + `commands.rs`
2. `db.rs` 追加迁移 SQL
3. `lib.rs` 注册命令
4. 前端：`types/<域>.ts` → `services/<域>Service.ts` → `stores/<域>.ts` → 组件/页面
5. `mock/server.ts` 补齐同名命令
6. 更新本文档模块清单

**接入真实 LLM / 视觉模型**：AI 推理层已在前端 `src/ai/`（pi-ai / pi-agent-core），Rust 侧只存配置与聊天历史。新增 AI 能力（如文字走 LLM、目标调整走 LLM）沿用 `src/ai/` 的模式：`runtime.ts` 装配模型 → 调用方动态 import 对应模块；如需 Service Worker 式后台执行再考虑 Node sidecar（届时可换 pi 官方会话后端）。

## 8. 路由清单

| path | name | 页面 |
| --- | --- | --- |
| `/` | home | 主页（今天） |
| `/sports` | sports | 运动（训练主页：周概览 + 跑步/手动记快速入口 + 最近三个课程 + 运动待办 + 最近运动） |
| `/ai` | ai | AI（拍照 / 文字记饮食 · 会话消息流 SQLite 持久化；右上角「管理模型」入口） |
| `/ai/models` | ai-models | 管理模型（二级内容页：服务模型四槽位 / Rein 在线服务入口 / 提供商账号与模型目录；模型增删改与 max_tokens=1 探测徽章在「全部模型」抽屉里） |
| `/ai/knowledge` | ai-knowledge | 知识库（二级内容页：检索模式三档切换 / 索引概况与重建 / 索引范围逐类开关 / 检索试跑 / 长期记忆审阅删除；入口在「我 › 知识库」） |
| `/ai/files` | ai-files | 文件管理器（二级内容页：**AI 页左上角「文件」入口**，也是「知识库 › 文件」的落点。虚拟文件系统真实视图：系统区/知识区/投影区命名空间网格 + 目录下钻面包屑 + 文件名搜索 + 新建目录/导入本体；阅读器支持模态切换（文本分块渐进加载、图片/音频/视频本体预览、不可用模态降级为文本），可编辑/删除/钉住/归类（移动），全部走 kb 命令，不读物理路径） |
| `/ai/knowledge/files` | ai-knowledge-files | 文件库（同上页面的别名路由，保留旧入口与历史深链） |
| `/ai/files/space` | ai-files-usage | 空间总览（二级内容页：**入口是文件页页头右侧那颗「总大小」文字胶囊**，不占页内位置。真源构成条（文本 / 本体）与派生缓存（索引 / 数据库，单列一组且不计入总量 —— 它们的字节本来就在数据库文件内部）各一条；目录占用（文本 + 本体，按一级目录，可点进对应目录）/ 大文件前三名摘要（可点开阅读器，完整榜单在下一级页）/ 索引来源 / 本体模态四张分布卡；维护卡做碎片回收（两段确认）与丢失本体提示。数据来自 `kb_usage`，走 `usageCached` 会话级备忘） |
| `/ai/files/space/large` | ai-files-usage-large | 大文件（三级页：**完整榜单**，最多 100 条，按体积倒序，行渲染与大文件摘要共用 `components/kb/UsageFileList.vue`（条长 = 相对最大文件、颜色 = 文本 / 本体）；点一行按路径深链进文件管理器打开阅读器。总览页只留前三名，榜单本身不挤在总览里） |
| `/me` | me | 我 |
| `/settings` | settings | 设置（二级内容页：功能分组入口 + 番茄钟完整配置 + 数据（清除软件数据：四档深度两段确认）+ 关于；入口在「我 › 设置」，原设置抽屉已升级为页面） |
| `/settings/features` | settings-features | 打开或关闭功能（三级页：插件层的逐项开关，列表来自 `src/plugins` 里 `toggleable` 的声明。**自身不属于任何插件**，任何组合下都可达） |
| `/settings/sync` | settings-sync | 多设备同步（三级页：本机是谁 / 连了谁 / 怎么再加一台；入口在「设置 › 多设备同步」。**归 `sync` 插件所有**，关闭时那张卡与直链一起收） |
| `/settings/update` | settings-update | 软件更新（三级页：版本/多源状态/下载进度/安装/更新源与通道设置 + Rein 在线服务探测；入口在「设置 › 关于 › 软件更新」，启动时也会静默检查并在有新版本时 toast 一次） |
| `/settings/perf` | settings-perf | 画质预览（三级页：超高档的液态玻璃长什么样 —— 仅图标按钮 / 图标+文字按钮 / 底部栏（圆 + 药丸 + 圆，并列留缝；**与应用里的 Dock 共用同一份样式**，逐项一致）；可就地切档看折射与退化的差别；**动效档位也在这里就地切**（关闭 / 默认 / 丰富，台上标本跟着变 —— 丰富档下点页签能看见活动底的融合与形变，另有「试一下」按钮让底栏走一格）；台下入口拉开**液态玻璃参数调节面板**（12 项可调参数 + 自带暗场预览）；入口在「设置 › 性能 › 液态玻璃预览」） |
| `/settings/health` | settings-health | 第三方数据管理（三级页：与 Android **Health Connect** 双向同步运动记录 —— 手机运动 App（小米运动健康等）把数据写进系统 HC，Rein 从那里读进来；可选把 Rein 自己记的运动回写出去。授权不走系统运行时弹窗，点按钮跳到 HC 自己的界面；「同步规则」卡讲清所有权：导入记录以 HC 为准（那边改了覆盖、删了跟着删），本地记录以本机为准。仅 Android 可用，桌面端是说明性禁用态；入口在「设置 › 第三方数据管理」；实现见 `src-tauri/src/modules/healthsync` 与 `HealthConnectBridge.kt`） |
| `/focus` | focus | 专注（二级内容页：番茄钟 + 待办 + 日程时间线预览；完整时间线、超量待办收抽屉） |
| `/todos` | todos | 待办 · 今日画布（二级内容页：未安排池 + 单日时间轴 + 详情联动 + 智能排程；周视图为 7 列时间线（WeekTimeline）含周回顾；清单保留原分组列表；桌面端宽栏三窗格） |
| `/nutrition` | nutrition | 营养全览（二级内容页：能量/宏量/微量元素详解 + 记饮食、改目标快捷入口） |
| `/nutrition/adjust` | nutrition-adjust | 饮食调整（二级内容页：目标计算器（参数快照持久化） · 体重身高追踪 · AI 目标建议 · 手动微调） |
| `/nutrition/foods` | nutrition-foods | 饮食库（二级内容页：全部食物浏览，搜索 + 分类筛选，点行弹详情抽屉；右下角「记录」悬浮按钮直接记一笔） |
| `/nutrition/recipes` | nutrition-recipes | 食谱库（二级内容页：22 个内置食谱模板，餐次筛选 + 忌口灰标 + 喜欢/不喜欢标记，偏好实时影响方案选菜；AI 定制一日菜单，营养由食物库实算并整体缩放） |
| `/program` | program | 健康方案（二级内容页：无方案时是内联约束向导 → 三档对比矩阵/强度预览双视图 → 日程级展开；生效后是一屏管理——状态条 + 周期进度 + AI 复盘 / 采购清单 / 手动调参 / 科学依据 + 调整历史 + 归档删除，执行落在主页状态卡、画布课程块与营养页今日菜单；入口在主页工具格、主页状态卡、我页个人约束卡与桌面右栏） |
| `/program/wrapup/:id` | program-wrapup | 结营成绩单（二级内容页：完成度环 + 开始→结束对照 + 数据徽章 + 下一期档位建议 + 完整报告；`:id`=方案记录 id，生效中的方案查看时提供归档入口；入口为方案页「生成本期成绩单」与历史方案列表） |
| `/ledger` | ledger | 记账（二级内容页：月度统计 + 预算跟踪 + 流水列表 + 记一笔） |
| `/sports/plans` | sports-plans | 全部课程（二级内容页：课程列表 + 新建入口） |
| `/sports/plans/:id` | sports-plan-detail | 课程详情（二级内容页：动作明细 + 开始训练 + 删除） |
| `/sports/plans/:id/edit` | sports-plan-edit | 课程编辑（二级内容页；`:id='new'` 表示新建；动作从动作库选择器里选，`exerciseId` 是课程与曲线的关联键） |
| `/sports/exercises` | sports-exercises | 动作库（二级内容页：全部运动动作的唯一真源——搜索 + 分类筛选 + 逐条详情（肌群图 / 重量曲线 / 今日建议）；内置动作只读可隐藏，自建动作可增删改；入口在运动页快捷磁贴） |
| `/sports/records` | sports-records | 全部运动记录（二级内容页：日/周/年三视图，概览卡=周期导航+分钟柱状图+统计行，列表按日/月分组；入口为本周运动卡「详情」角标） |
| `/campus/schedule` | campus-schedule | 我的课表（**一级入口：底部 Dock 左键的默认落点**，同时保留页头返回键；日/周/月三视图 + 顶栏同步刷新 + 课表配置入口。周视图为 7 列 × 节次网格，双向冻结窗格，左列显示实际上课时间） |
| `/campus/settings` | campus-settings | 课表配置与设置（二级内容页：学校系统选择器 + 教务登录（含验证码）+ 学期切换与同步 + 培养方案与选课入口 + 账号管理） |
| `/campus/program` | campus-program | 培养方案（二级内容页：方案档案 + 学分进度 + 学分分布树 + 课程清单；数据源 900KB+，后端缓存） |
| `/campus/course-select` | campus-course-select | 选课·抢课（二级内容页：教务服务器时间 + 抢课任务单 + 批次列表 → 教学班搜索/加入抢课；批次未开放时是「等待窗口开放」态）。**归 `campus-grab` 插件所有（课表的子模块，默认关闭）**：入口只在课表页/配置页且开关打开时出现，直链被守卫拦回主页 |
| `/session/run` | session-run | 运动模式·跑步（沉浸二级页：目标设置 → GPS/计时 → 暂停/继续 → 总结保存） |
| `/record` | record | 录音（二级内容页：录音台 + 未归档 take 管理（回放 / 删除 / 附加到待办）；录音中由录音悬浮条跨页接管。**归 `record` 插件所有**） |

页面分级约定：一级页 `meta.tab`（页签条目由插件层贡献，见 §13）；二级内容页 `meta.title`（保留 TabBar，`PageHeader back` 提供返回键）；沉浸页 `meta.fullscreen`。**训练课沉浸层不再走路由**（2026-09-03）：`components/exercise/SessionOverlay.vue` 由 `App.vue` 常驻挂载，显隐与 container transform 形变动画由 `system/sessionImmersive.ts` 驱动——收起/恢复零重建，原 `/session` 路由已移除。每日目标的编辑入口收敛在「饮食调整」二级页，「我」页只展示摘要。训练课程的全部管理动作收敛在「全部课程」及其详情/编辑二级页，运动主页只放跑步/手动记快速入口与最近使用的三个课程。

**桌面工作台（2026-08-24）**：视口 ≥ `config/domain.ts::DESKTOP_MIN`（1100px）时 `App.vue` 切换到三窗格壳——左侧导航轨 `layout/DesktopRail.vue`（替代底部 TabBar）、主人区 `RouterView`、右侧信息栏 `layout/DesktopInspector.vue`（**全部页面常驻**，保证构图平衡：三环小结 + 今日待办快切 + AI 问句）。主页本身提供两个可切换视图（页头分段控件，选择持久化 `localStorage:'rein.homeView.v1'`）：`workbench/BentoOverview.vue`（便当总览：能量磁贴 + 待办 + 番茄/AI + 快捷入口 + 记账/运动概览）与 `workbench/DaySpine.vue`（一日脊柱：体重/饮食/运动/番茄/收支/待办按分钟聚合的纵向时间线，未来安排虚线 + 「现在」呼吸点）。移动端（< DESKTOP_MIN）保持底部 Dock（左独立圆钮=自定义落点，默认课表 / 中药丸=内核两格「主页 / 我」+ 插件条目 / 右独立圆钮=AI，见 §13），主页为「状态条 + 主页画布 + 常用工具栏」（2026-08-26 起：无壳能量状态条 → 2026-08-29 升级为 `home/HomeCanvas.vue` **主页画布**：未安排池 chips（点卡片进编辑抽屉快排）+ 紧凑版 `todo/CanvasTimeline.vue`（现在线/打勾/拖拽改位，与 /todos 画布同组件同数据，216px 视窗锚定「现在」）+ 餐次摘要 chips → `home/HomeFooter.vue` **页脚动作区**（2026-10-04：课程条——正在上的课/还剩几分钟/下一节倒计时，**未连教务整条不渲染**（入口由 Dock 左钮兜着），连了没课才显示「最近没有课」；「吃 / 练」两张**记录域卡**——卡头一句实时事实（吃：已记 N/3 餐 · 晚餐未记，不用段状痕迹；练：练够分找最弱肌群 + 方案日程合出「今天该练哪节」的推荐，再退到**课程库里训练目的与弱项高度相似的那一节**（`utils/weakMuscles.matchCourse`：命名课优先于现场拼临时课，判据 = 命中数 / 主攻组数 ≥ 2/3 且最该补的组在其主攻组里、只收 strength 课），**卡头带热力档位色点、分数按档位着色**，与肌肉热力图同一份五档色），卡里是该族**同权成员** chip（吃＝记饮食/饮食库/食谱库/饮食历史，练＝记运动/健康方案）；专注/钱两格状态（一个数 + 一句事实）；末尾工具 chip 行（录音纪要/AI 助手）——成员仍全部来自 `stores/features.tools` 按 id 取，没落进任何区的工具进工具行，见 §13）→ `home/HomeTodoFeed.vue` **「全部待办」信息流**（2026-10-13：页脚之后的常驻长列表，读 `query_todo_feed` 分页而非 `list_all_todos`——页大小 30、每批挂 10，哨兵 + IntersectionObserver 600px 预取带；首屏第一页就是全部则一次挂完，否则滚到底边逐批追加；分组 = 未安排 → 已逾期 → 今天 → 未来日期（升序）→ 已完成整段沉底；勾选就地生效不重排，「已完成沉底」由下一次重进主页收敛），桌面端其他页面内容以 560px 窄栏居中（`App.vue` `.desk-main:not(.wide)` 约束）。断点检测用 `composables/useMediaQuery.ts`（matchMedia 响应式），不依赖窗口 resize 监听。沉浸页（`meta.fullscreen`）在两形态下都隐藏导航。

## 9. 训练课会话与跑步（stores/session.ts · stores/run.ts · system/workoutRuntime.ts）

- 纯前端状态机 + 后端会话持久化：状态事件 → `session_snapshot`（fire-and-forget，失败显示页顶警示不阻塞训练）。两台状态机都是 Pinia 应用级单例，**组件卸载不影响计时/GPS/落盘**。
- 中断恢复：`hydrateFromServer()` 读 `session_active`，恢复 doneSets/重量/阶段；**休息倒计时按快照间隔的真实流逝补时**，计时动作被打断则整组重做。
- **录音系统运行时**（`system/recorderRuntime.ts`，模块级单例）：MediaRecorder 与计时在模块状态上，编辑抽屉「录音」、录音页、录音悬浮条（`components/record/RecordFloatBar.vue`，useDragDock 独立持久化 key `rein.rbar.dock.v1`）发起的是同一次录音，录音中可跨页；录完的 take 统一进内存 takes 列表，「附加到待办」写 `todos.attachments` 持久化，未附加的关应用即失。Android 需 Manifest 声明 `RECORD_AUDIO`（RustWebChromeClient 已把 web 的 AUDIO_CAPTURE 映射为运行时权限请求）。
- **运动系统运行时**（`system/workoutRuntime.ts`，main.ts 装载）：应用启动即接管 active 会话（原各页「检测到未完成的训练」恢复卡逻辑收敛于此）；沉浸页挂载先 `whenReady()` 防竞态。导航栏上方的悬浮运动条（`components/exercise/ActiveWorkoutBar.vue`，沉浸形态隐藏）与沉浸层共用运行时的数据与动作：跑步 = 配速/里程/暂停（**必须暂停再结束**），课程 = 动作名/当前组数/完成本组；两者都提供「恢复沉浸」（训练课经 `system/sessionImmersive` 从浮窗位置形变展开，不走路由；跑步推 `/session/run`）。开始前发现 active 会话 → 提示「前往继续」（`run.courseConflict` / `session.foreignRoute` 区分训练课沉浸层与跑步 `/session/run`）防止覆盖。
- **课程数据不再来自静态配置**：`stores/plan.ts` 从 `workout_plans` 表加载；会话恢复按 `planId` 查库，查不到（已删除）则作废该会话。开始训练时调用 `touch_workout_plan` 维护「最近使用」。
- **这一场可以被现场改编排（2026-10-21）**：`swapExercise` / `insertExercise` / `removeExercise` / `setExercisePrescription` 全部只改内存里的这一场，课程库一个字不动。四条硬约束：① **插入只能落在当前动作之后**（插到游标之前会让 `setSlots` 把新格子判成「已完成」，而它一组都没做）；② **删除只能删还没开始做、也没完成过组的动作**（当前动作删掉要同时挪相位 / 组号 / 休息流向，已完成组删掉等于悄悄丢数据）；③ **换动作连处方一起换**（组数 / 次数 / 休息取新动作的库内默认值，并清掉旧动作的 `warmups` 与热身记录 —— 沿用旧处方会让建议引擎的「做满即加档」判据失真，旧热身重量会套到新动作上）；④ 三种改动之后都要重算 `loadAdvice` + 补 `strength_last_weights`，否则新动作的建议与预填停在库内通用值。
  **快照因此带上 `state_json.sessionPlan`**（这一场的完整条目清单）：恢复不再按 `planId` 从课程库重建，插入的动作不会凭空消失、删掉的动作不会回来、改过的组数不会退回库里那份；`planRefs` 键迁移只剩「老快照」这一条退路。AI 侧对应**独立工具集** `src/ai/tools/session/`（`ToolGroup='session'`，常驻）：`read.ts`（现场）· `adjust.ts`（`update_active_session`：这一组与流程）· `arrange.ts`（`edit_session_plan`：换 / 插 / 删 / 改处方），与课程库的 `upsert_plan` 严格分开。
- **动作与重量曲线（0025）**：课程条目引用动作库 `exerciseId`；逐组记录落 `workout_sets.exercise_id`，曲线/清单/上次重量全部按它聚合（展示名走 `stores/exerciseLib`，改名全端跟随）。细节见 §4 的「动作库」四条不变量。
- **训练建议引擎**（`src/utils/trainingAdvice.ts`，纯函数；数据来自 `strength_recent_sets` + 动作库 + 今日课程）：
  - **平均状态** = 近 3 次训练 e1RM（Epley，次数 >12 换 Brzycki）加权基线 [0.2, 0.3, 0.5]；**今日状态** = 恢复间隔（同肌群 <24h 0.90 / <48h 0.95 / <72h 1.00 / <120h 1.02 / 更久 0.98，Damas 恢复窗口）× 本周该肌群组数 / 目标区间（超 MRV 0.92、超 MAV 0.97）× 近期趋势 × 自评（1–5 → 0.90/0.95/1.00/1.02/1.04），最终钳制 [0.85, 1.06]。
  - **建议重量是负荷锚定而不是 e1RM 反推**：历史没有 RPE，e1RM 只能当相对趋势用（当它是「该组若力竭的理论 1RM」，反推绝对重量会系统性低于用户实际做过的重量）。所以以上次正式组重量为锚：做满计划次数就加一档（双重渐进，今日状态 ≥1.03 时加两档）；状态明显偏低（<0.95）按系数降载（下限 85%）；今日极限（基线 × 今日状态）只用于封顶，且不低于上次已完成过的重量。
  - **周容量看板**：每肌群近 7 天加权组数（主攻 1 / 辅助 0.5 / 稳定 0.25 组）对比 MEV/MAV/MRV 地标（Israetel；按每周可训练天数缩放，有生效方案时取方案的 `trainingDays`），超上限提示减量。
  - **只读契约**：引擎只做预填与解释（沉浸页「建议」chip + 依据行 + 今日状态自评），不写库、不改课程；用户随时可以改成别的重量，训练记录也只登记实际完成值。
- **回归**：`node scripts/e2e-strength.mjs`（热身/做组/建议 chip/按库 id 落库与曲线更新）、`node scripts/e2e-exercise-library.mjs`（动作库页浏览与检索、自建动作增改、内置动作隐藏与恢复、课程编辑选择器落 id、沉浸页今日建议与自评、本周容量卡、命令契约）、`node scripts/e2e-immerse-toggle.mjs`（沉浸层与悬浮条互切）。
- **跑步**（`stores/run.ts`）：`plan_id='__run__'` 复用会话落盘；GPS 用 `navigator.geolocation.watchPosition` 累加距离（精度过滤），不可用时总结页手动填距离（跑步机场景）；卡路里按配速分档取 run 的 MET；恢复时强制暂停态。
- **跑步保活**（2026-08-24）：安卓锁屏后 WebView 的 GPS/计时随进程冻结停摆（用户感知「定位丢失后崩溃」）。开跑（`begin`）/续跑前经 `trackingService.setKeepalive(true)` 拉起 Android `RunTrackingService`（location 类型前台服务 + WakeLock），首次未授权先弹系统授权框（轮询 `tracking_status` 收敛，拒绝或超时则降级为无 GPS）；总结/重置时停服务。命令：`tracking_keepalive` / `tracking_status`（JNI 经 `Webview::jni_handle().exec` 发后不管，状态走 Kotlin snapshot 静态缓存）。桌面端空操作。

## 10. 知识库与认知层（src-tauri/src/modules/kb · stores/ai.ts · ai/tools/knowledge.ts）

一个库装下多种来源：日程与附件、运动记录与逐组明细、训练课程、饮食与体测、健康方案、语音纪要、历史聊天，以及 AI 从对话中提炼的长期记忆。**长期记忆不是独立系统**，它是 `kb_docs` 的一类来源（`source_type='memory'`），因此天然进入同一套检索；反过来，全部来源又都是 LLM 的检索目标。

- **检索三档**（`kb_settings.embedding_mode`，默认 `keyword`）：`keyword` 纯 FTS5 trigram + 结构化过滤，零依赖全平台可用；`local` 进程内 ONNX Runtime + 内置 int8 模型（bge-small-zh-v1.5），数据不出设备；`cloud` 走 OpenAI 兼容 `/v1/embeddings`（Rust 侧 ureq，不受 WebView CSP 约束）。三档共用同一个 `Embedder` trait 与同一套检索流程，`keyword` 即「无 embedder」。性能实测见 `docs/kb-embed-benchmark.md`。
- **召回阶梯**（`kb/search.rs`）：FTS5 bm25 → 整串 LIKE（trigram 不支持少于 3 字符的查询，中文两字词如「膝盖」必须走这层）→ 二字窗口模糊（中文无分词器时唯一能兜住「膝盖内扣」→「膝盖不要内扣」的手段）。各层结果用 RRF(k=60) 融合，再与向量召回并轨。向量是**暴力扫描**：万级块 × 512 维约 20 MB、单次 5–15 ms，因此不引入任何向量索引库。
- **分层读取**（对应 OpenViking 的 L0/L1/L2）：检索只回摘要级命中（L0），`kb_read` 默认给概览（L1），确需全文才用 `level:'l2'`。工具返回值的分层纪律直接修掉了 `list_all_workouts` 无分页、`get_plan` 全量返回这类上下文失控问题。
- **同步靠触发器而非命令层挂点**（迁移 0019）：`todos`/`workouts`/`workout_sets`/`workout_plans`/`meal_logs`/`body_metrics`/`foods`(仅 `is_custom=1`)/`programs`/`program_meals`/`voice_memos`/`ai_chat_messages` 的增改删都会写一行 `kb_dirty`。这样连 `program_schedule_replace` 这种批量直写 `todos` 的旁路也被覆盖，未来新增写入路径同样自动生效。`foods` 只在自建时登记——内置 2722 条种子每次启动都 `INSERT OR IGNORE`，无条件登记会拖垮首启。
- **索引线程**（`kb/worker.rs`，`std::thread` + `recv_timeout`）：三段落法——持锁取文本 → **放锁嵌入** → 持锁写回。全应用共用同一个 `Mutex<Connection>`，嵌入若在持锁期间执行会直接卡住界面。空闲约 60 秒后释放 embedder（重建仅 50–130 ms），因为进程峰值工作集实测 157 MB，安卓上会被低内存杀手盯上。
- **记忆抽取**（`ai/memoryExtract.ts` + `kb_memory_apply`）：会话结束（切会话/新建/清空）时后台跑一次，**不 await**。把「现有记忆清单」一并放进上下文，让模型一次调用同时完成抽取与去重合并，比原有的「抽取 + 向量预筛 + LLM 去重」两轮省一半成本。落库留 `kb_memory_diffs` 审计。编排在前端是因为模型请求由 WebView 里的 pi-ai 直连 provider。
- **认知注入**：`kb_cognition` 产出一段紧凑文本，由 `stores/ai.ts` 在每轮请求前取（60 秒 TTL 缓存）并经 `chatWithModel(cfg, …, { cognition })` 传进系统提示词的【用户认知】段。做成预注入而非又一个工具，是因为模型每轮都该直接知道自己面对的是谁。
- **两个必须守住的约束**：① 附件里 image/file/audio 的 `content` 是 base64 data URL，**绝不能进索引正文**，只索引文件名与体积（`source.rs::attachments_digest`，有单测硬断言）；② `kb_fts` 用 external content 指回 `kb_chunks`，一致性靠 `kb_chunks` 上的三触发器，而 SQLite 的外键级联删除**不触发**子表触发器，所以删除文档一律先显式删块（`fts_stays_consistent…` 单测用 FTS5 integrity-check 守着）。
- 命令：`kb_status` / `kb_search` / `kb_read` / `kb_reindex` / `kb_settings_get` / `kb_settings_set` / `kb_probe_embedder` / `kb_rebuild_vectors` / `kb_memories` / `kb_memory_apply` / `kb_memory_delete` / `kb_cognition` / `kb_memory_bump` / `kb_glob` / `kb_file_write` / `kb_file_rename` / `kb_file_delete` / `kb_file_get` / `kb_media_write` / `kb_media_get` / `kb_fs_move` / `kb_fs_mkdir` / `kb_fs_pin` / `kb_fs_moves` / `kb_fs_undo` / `kb_injection_get`。
- **索引进度走事件**：worker 每推进一轮 emit `kb://index`（`worker.rs::emit`，载荷 = phase/done/total/pending/indexing，与 `kb_status` 同源）；前端 `services/kbService.ts::onKbIndexProgress` 订阅，知识库页就地更新状态条（浏览器 mock 无索引线程，不产事件，靠进入时的一次快照兜底）。
- **模态层（2026-09-19，迁移 0024）**：一条数据可以有多种模态，它们是**同一节点**的不同表示——`kb_assets` 存模态表示（modal / mime / storage / ref / 字节 / 时长 / 转写状态），本体三来源：上传进工作区的 `workspace/media/*`、语音纪要的 wav（`voice_memos.audio_path`）、附件里的 data URL。`kb_media_get(docId, modal)` 走**降级链**：有本体返回值（前端可播放，字节不进模型上下文；超 16MB 只回元信息 `tooLarge`），没有就降级为文本并给 `degraded`/`degradeReason`，**永不报错**。一个节点同一模态只有一份表示（`assets::add` 按 (file, modal) 替换）。AI 侧工具是 `read_modal`。
- **目录治理（2026-09-19）**：`kb_files.kind`（text/multimodal/folder）+ `pinned` + `classify_state`（inbox/filed/manual）；`kb_fs_moves` 是整理审计（谁/何时/从哪到哪/为什么，可按 batchId 整批撤销）。规则：系统区（`规范/`、`系统提示词/`）只读；**保留区**（`附件/` 全树、日期目录、`-数字` 后缀）由 `governance::free_path` 自动让位（加 `-v2`）；AI 自动移动有 24h 防抖（同路径 AI 刚放好就不再挪）且不碰 `pinned`；深度 ≤4、同级 ≤50、单批 ≤200。AI 侧工具是 `classify_move` / `pin_file` / `make_folder`。
- **文件卡片（2026-10-08）**：AI 用 `present_file` 把一个工作区文件挂到聊天里当卡片（用户点开 = 阅读器 / 文件管理器，都是页内深链 `?dir=&path=`，不唤起系统应用）。条目元数据与文件管理器**同一份投影**：`kb/listing.rs::find_entry` 走 `list_dir(父目录)` 挑出同路径那条，所以大小 / 模态 / 只读态与文件页永远一致；路径认三种写法（原样 / 省 `.md` / 省 `笔记/` 根，与 `write_note` 的归位规则同约定）。前端链路：工具结果 JSON → `agentProtocol::toolDetailsFromResult` 剥出结构化载荷 → `ai/chatFiles.ts::fileAttachmentOf` 认「工具名 + file 字段」→ 轮级攒着、定稿时挂到正文气泡（`payload.files` 持久化，历史可恢复）。浏览器 mock 模式的镜像是 `ai/tools/workspace.ts` 的同名工具（同一套候选规则）。
- **全量注入区（2026-09-19）**：`系统提示词/*.md`（代码播种，随版本更新）+ `用户记忆/*.md`（用户可写，模板只在缺失时创建）**每轮全量进系统提示词**，由 `kb_injection_get` 组装（预算 12,000 字符，按「系统提示词 > 角色设定 > 全局规范 > 其他」截断并置 `truncated`）；`stores/ai.ts` 带 60 秒 TTL 缓存取一次，`chat.ts` 拼成【系统提示词】【用户记忆】段。纯 HTML 注释的模板文件不占预算。其余内容一律靠工具按需检索——这是「注入」与「检索」的分界。
- **虚拟文件系统**（规范见 `docs/kb-vfs.md`，同文档会播种为只读系统文件 `规范/知识库规范.md` 供 AI 自查）：迁移 0020 给每篇文档加 `path`，统一规则在 `source.rs::build_path`（系统提示词/规范/用户记忆/未分类数据/笔记/文档/语音/日程/运动/课程/饮食/体测/食物/方案/菜单/对话/附件/记忆）。`editable`/`system`/`kind` 做成列；派生文档只读，可写的是知识区（`笔记/`、`文档/`、`未分类数据/`、`语音/`、`视频/`、`用户记忆/` 与领域目录下的用户子目录，kb_files 内容即真源）与记忆（经记忆 API）。`kb_files` 的编辑/改名/删除走 files.rs，id 可传文档 id 或文件 id（`resolve_file_id`）。`read_knowledge` 按 L1/L2 分块分页（`offset`/`limit`/`hasMore`/`nextOffset`），`glob_knowledge` 用 git 语义 glob（`*` 不跨目录、`**` 跨、`a/**/b` 匹配零层目录）。**上传文档时前端把抽取全文自动归档进 `文档/`**（prompt 只带 6000 字截断版并注明归档路径，AI 靠分页读全文）——真机验证：docx 训练安排表 → AI 逐条 `create_todo` 67 条，60 秒完成。**阅读以真源为准（2026-09-12）**：`kb_read` 对 note 源直读 `kb_files.content` 即时切块——`kb_docs.body` 是带 8000 字上限的检索缓存，此前全文超限的 Word 归档会被截断，AI 分页到头也读不到剩余内容；用户侧完整浏览走文件管理器（`FileLibraryPage.vue`，AI 页左上角入口，目录下钻 + 直读原文/分块渐进加载 + 模态预览）。
- **启动对账**（`worker.rs::reconcile`）：每次启动先播种系统文件（`规范/知识库规范.md` 随版本更新；`系统提示词/*` 随版本更新；`用户记忆/角色设定.md`、`用户记忆/全局规范.md` 只在缺失时建；`未分类数据/` 目录），再把既有源记录全部入队并清孤儿（触发器只对之后的写入生效，老库升级必须靠它），内容未变的条目按 `content_hash` 跳过。
- **构建前置**：端侧模型与 ORT 运行库不入库，克隆后先跑 `node scripts/fetch-embed-model.mjs` 与 `node scripts/fetch-ort-runtime.mjs --target all`；`src-tauri/build.rs` 会校验并在缺失时给出提示。三端交叉编译不需要任何原生链接配置（`ort` 用 `load-dynamic`、`tokenizers` 用纯 Rust 的 `fancy-regex`，整棵依赖树零 C 代码）。

## 11. 已知边界（框架阶段的有意取舍）

- 单窗口单连接（Mutex<Connection>）：桌面场景足够，出现并发瓶颈再引入连接池/rusqlite pool。
- 目标按天覆盖（daily_targets）未启用：`get_targets/set_targets` 的 date 参数已预留。
- 重复任务为轻量规则（每天/每周几/间隔 N 天 + 结束日期），模板行持有规则、实例按 `rec_key="模板id:日期"` 物化到滚动窗口 [今天-1, 今天+7]，`sync_recurrences` 幂等（改规则后未来未完成实例自动重建）；仅支持改单条实例，无"整个系列"编辑。删除语义：**删实例 = 跳过这一次**（日期记进模板的 `rec_exdates`，物化不再补回 —— 不记就会被下一次物化按规则当场建回来），**删模板行 = 整条下线**（当天及以后未完成的实例一并收走，更早的与已完成的行保留）。子任务为单层 checklist（JSON 列，无嵌套/指派）。饮食自定义食物目前仅经 AI `create_food` / 智能添加自动补录落库（手动新建 UI 未做，表结构与命令已就绪）。
- 记账为轻量单账本模型：支出/收入两类（无转账/多账户/多币种）、预设分类（自定义分类与层级未启用）、单一月度总预算（无分类预算/结转/提醒）、无周期账与 CSV 导出；流水搜备注 + 分类筛选。
- 跑步 GPS 依赖系统定位服务：桌面端常不可用或漂移大，此时自动退化为纯计时模式，距离在总结页手动补填（跑步机场景同理）。
- AI：`ai_models.api_key` 目前明文存 SQLite（单机单用户应用可接受，未上系统钥匙串）。
- 校园教务：登录 + 课表 + 培养方案 + **自动抢课（引擎、任务单、互斥志愿组、窗口监听、文件投递口均已实现并通过浏览器 e2e；提交链路与窗口对时待真机验证，见 §12 末）**。教务账号当前**登录不上**（库里那份 Cookie 已过期，且保存的密码被教务拒绝）—— 监控脚本与真机联调都卡在这一步，需要先在 App 里重新登录一次。教务密码与 `ai_models.api_key` 同样明文存 SQLite，但读路径统一投影为 `has_password` 布尔，明文不出 Rust。

## 12. 校园教务（src-tauri/src/modules/campus · stores/campus.ts · stores/courseSelect.ts）

把学校教务系统的课表接进 Rein，并投影到时间线。**在册两所**：桂林电子科技大学 · 本科生教学信息平台学生端（树维 Supwisdom `eams5-student`）与广西科技大学 · 教学管理信息平台（正方 ZFSoft `zftal-ui-v5`）—— 两套是**完全不同的系统**（登录握手、数据形状、字段命名没有一处相同），差异全部收在各自的适配器里，命令层只认「登录 / 学期 / 课表」这几个动作。

**分层**（自下而上，每层职责单一）：

| 文件 | 职责 |
| --- | --- |
| `provider.rs` | **学校系统选择器**。`SchoolSystemSpec` 把「哪所学校 + 哪套登录握手 + 打哪些接口」声明成数据；新增一所学校 = 在 `REGISTRY` 加一条，前端选择器自动出现。`LoginStrategy` 抽象登录握手（树维门户 RSA / 正方表单 RSA 两种），`EndpointSpec` 按厂商分表（`eams5` / `zfsoft`，互斥，不支持的能力留 `None` 而不是空串）。 |
| `http.rs` | 带 Cookie 会话的 HTTP 层。项目其它域都是一次性请求（API Key 头），**只有教务需要会话**，所以这里补了 `CookieJar`、浏览器伪装头、以及「不跟随重定向」（靠 302 判定会话过期，而不是被静默跳到登录页拿到 200）。同文件含两种登录加密（`rsa_encrypt_password` / `rsa_encrypt_password_with_key`）与会话判定 `guard`。 |
| `dates.rs` | 学期口径的换算与命名（周次 ↔ 公历日期、节次 ↔ 时刻、学期显示名）。**厂商无关**：两家适配器共用，所以从 `guet.rs` 提了出来。 |
| `adapter.rs` | **适配器分派**：按 `LoginStrategy` 把调用转给对应厂商适配器。命令层原先有 8 处直接 `GuetAdapter::new(...)`，第二家进来后收口到这一处。 |
| `guet.rs` | 桂电（树维 EAMS5）适配器：登录握手、课表页面变量解析、课表归一化。 |
| `zfsoft.rs` | 广科大（正方 zftal）适配器：表单登录（csrftoken + 运行时公钥）、学年/学期下拉解析、课表归一化（节次表 + 周次表 + 位掩码）。 |
| `course_select.rs` | **抢课**子系统（`/course-selection-api`）客户端。独立鉴权（见下），信封约定与其余接口相反，只在这一处判断。所有请求体都抽成纯函数并逐个加了单测。**只有树维那套系统有这条路**。 |
| `grab.rs` | **自动抢课引擎**：后台线程 + `campus_grab_tasks` 任务表 + `campus://grab` 事件流。时钟校正、错误分级重试、结果不明时的核对、崩溃续跑、**互斥志愿组**、**窗口监听**、**文件投递口**、**抢课计划的解析**全在这里。**带模块开关**（默认关，见 §13）。 |
| `matcher.rs` | **模糊匹配**：把「高数 张」这类人的说法落成具体的教学班。纯函数（无网络无库），计划解析与输入预览共用同一份实现与同一套排序。 |
| `models.rs` | 远端 JSON 映射（两家各自的形状）+ 本地落库形状 + IPC 契约 + 归一化快照 `TimetableSnapshot`。 |
| `commands.rs` | Tauri 命令 + SQL，以及**周次 → 公历日期**这条全链路唯一的换算、**时间轴归一化**（`build_time_axis`）。 |

**两套登录握手**（都以真实站点实测为准）：

- **树维**（`guet.rs`，对齐登录页 `main.js::submit`）：`GET /student/ldap/login-salt` → `RSA_PKCS1_v1_5(salt + "-" + password)` → `POST /student/ldap/login {username, password, captcha}` → Cookie 会话。
- **正方**（`zfsoft.rs`，对齐登录页 `login.js` 的 `#dl`）：`GET /xtgl/login_slogin.html`（拿 `csrftoken`，同时建会话）→ `GET /xtgl/login_getPublicKey.html`（modulus/exponent，**每次登录现取**）→ `RSA_PKCS1_v1_5(裸口令)` → `POST` 同一地址（`yhm` / `mm` / `csrftoken`）。判定与直觉相反、实测两次确认：**200 = 被拒**（登录页就地重渲染，原因在 `#tips` 里），**302 = 通过**（重定向回登录页本身，该页对已登录会话会再跳到菜单页）。

RSA 用 `rsa` crate（纯 Rust，四端交叉编译零原生依赖），填充与登录页的 `encrypt()` 等价。树维的图形验证码答案绑在**会话**上，所以「取验证码」与「提交登录」必须共用同一个 Cookie —— 用 `CampusHub` 暂存这一次握手的 jar；正方的验证码（`/kaptcha`）只在该校「错够几次」后才要，失败页里看不出来，所以配置页给了一个人工取图的入口。

**会话自愈**（`commands.rs`：`is_session_lost` / `relogin` / `persist_session` / `recover_session`）。教务会话的寿命不归我们管（服务端 TTL、在别处登了一次都会让它失效），而失效的信号只有一个：**302 回登录页**（HTTP 层不跟随重定向，就是为了把 302 留作判据），文案统一是「…会话已过期，请重新登录…」。于是：

- **凡是撞上这句话的联网命令，都用存下的密码静默重登一次再重试**：`campus_sync` 的课表抓取（302 可能出现在抓取的任何一步，所以整段重跑，而不是只在开头探一次针）、`campus_program`、以及 `select_context` —— 后者一条覆盖全部选课命令与抢课引擎。抢课窗口就那么几小时，「会话掉了要等用户手动重登」是这里最不能接受的失败。
- **重登成功后立刻落库**（`persist_session`），不等整个流程跑完。否则后半程一失败新会话就白换了，用户下次看到的还是「请重新登录」，只能手动再同步一遍 —— 这正是「常出现会话过期、要手动重同步」的根因。
- **会话一换，选课 SSO 令牌同时作废**（`forget_select_token`）：那张 JWT 是拿旧会话换的。
- `select_context` 收的是 `&Mutex<Connection>` 而不是 `&Connection`（锁的边界由它自己安排），就是为了让重登这段慢网络永远落在锁外 —— 与「三条铁律」第 1 条同源。

没存密码是唯一修不了的情况，那就把话说清楚并给出下一步：「该账号没有保存密码 —— 请到「课表配置」重新登录一次，勾上保存密码以后过期就能自动恢复」。前端认同一套关键词（`stores/campus.ts::isSessionLostMessage`），在 toast 里直接挂「去重新登录」按钮；配置页还会把登录表单重新摆出来（此时 `account.loggedIn` 可能仍为 true，光看它会把表单藏起来，那就成了用户口中的「没反应」）。存了密码的账号在配置页可以**空着密码一键重登**（`store.relogin()`，后端回落到库里那份）。

登录失败同样**必须有话说**（`guet.rs::login_failure`）：教务对「账号密码不对」并不总给 `message`，以前会吐「登录失败，教务系统未返回原因」，用户无从下手。现在按情形兜底 —— 要验证码却没说原因 → 「需要输入验证码」；填了验证码仍被拒 → 「验证码不正确」；什么都没有 → 「登录被拒绝：请核对学号与密码」。`login_first` / `weak_password` 这类必须去网页端处理的，带 `actionRequired` 透出，配置页据此给一句带链接的引导。前端把失败原因**留在表单里**（toast 两秒就没了，而它要提醒你去解决的问题不会），而不是只弹一下就消失。

**三条铁律**：

1. **慢网络与 DB 锁不许同时持有**。`AppState.db` 是全局 `Mutex<Connection>`，教务又是慢站点（大响应数十秒）。所有联网命令都是「短锁读 → 无锁联网 → 短锁写」三段式，与 `kb` 的「embeddings 绝不持锁」同规矩。
2. **周次换算只有一处**。教务只给「第 N 教学周 + 星期几」，`commands.rs::occurrence_date` 负责用学期 `start_date` 锚定成公历日期；课表视图与时间线物化共用它，避免两边公式漂移。
3. **课表派生行是只读投影**。见下。

**时间轴（动态时间段适配层）**。周视图左列的行轴由 `commands.rs::build_time_axis` 产出（前端同口径实现在 `src/utils/campusTimeAxis.ts`，mock 用它造轴）。各校作息并不一致 —— 有的一上就是两节（第1-2节 08:00-09:25），有的是四十分钟一节（第1节 08:00-08:40、第2节 08:45-09:25），节间休息也长短不一 —— 所以行轴是**派生**的，不能拿 `(startUnit, endUnit)` 去重当行：第1-2节 与 第2-3节 并存时那样会画出两行，第2节被画两遍，一周的视觉长度也不再等于真实时间。口径：

- **候选区间 = 节次表 ∪ 实际排课的节次区间**，取断点（每个区间的 `start` 与 `end + 1`）后相邻断点构成片段 —— 片段天然互斥、首尾相接，**同一节次只可能出现一次**；没课的片段不画（第5节没课就没有第5节那一行）。
- **时刻只读教务给的数，绝不插值**：片段内每一节都能在节次表里查到 → 用逐节真读数；否则用覆盖它的**最紧封套**（覆盖者里最晚的开始 / 最早的结束）。片段内部的课间休息猜不出来，猜出来的「08:42」比老实给封套更糟。
- **节次表是抓下来的**：正方为「第 N 节 → 几点」单独开了一个接口（`zfsoft.rs::fetch_slot_times`，`/kbcx/xskbcx_cxRjc.html`），而课表正文只有节次号；它随快照落进 `campus_period_slots`（账号 × 学期，同步时整表替换）。读课表那条路只查库、不联网。树维没有这张表 → 空表 → 轴自动退化为只用排课区间，绝不编时刻；老数据无需迁移（没同步过就没有表，显示与旧实现等价）。
- **前端按片段跨行画**：每门课映射到 `(起行, 跨几行)`，`grid-row: <起行> / span <跨几行>` —— 三节连排的课因此占三行，和「三节单排」在视觉上分得开；同一天重叠的课并成一个冲突组、并排画。每个格子都**显式落位**（自动排布遇到跨行会把后续格子挤到别的列上）；行高按真实时长成比例（`minmax(56px, N fr)`），节次少时 `fr` 把高度铺满、多时滚动。

**课程详情有两个来源**。远端（`campus_course_detail` → 教务「课程详情」页：容量 / 已选人数是实时值）与本机快照（`stores/campus.ts::offlineCourseDetail`：课名 / 教师 / 地点 / 时间 / 周次 / 学分，全部来自已同步的 `campus_courses` + `campus_sessions`）。点课程格时**先摆本机那份**，远端可用时整份替换：正方那套教务没有详情接口，本机那份就是最终结果；树维那套要现拉一次整张课表，先摆本机那份也省掉了对着骨架干等。远端失败（没接口 / 会话过期 / 断网）一律留着本机那份，不把已有档案换成报错页；只有两边都没有时才报错。远端才有的字段（容量、学时构成…）留空而不编 —— 抽屉的排版原则是「空值不占位」。

**课表日程对象的生命周期**。真源是 `campus_sessions`；`todos` 里 `course_session_id` 非空的行是它的派生投影，由 `materialize_todos` 以**先删后建**（幂等）方式维护：

| 事件 | 时间线动作 | 不变量 |
| --- | --- | --- |
| 首次同步 / 手动刷新 | 删掉本账号全部未完成派生行 → 按窗口重建 | 可重复执行，结果幂等 |
| 切换学期 | 只清「非当前学期」的未完成派生行 → 重建当前学期 | 切学期不丢已打卡历史 |
| 下课（时间已过） | `auto_complete_past_courses`：把未完成派生行翻成 `done` | 只翻未完成；已打卡原样保留，幂等 |
| 退课 / 换课（远端时段消失） | `delete_stale_sessions`：未完成行直接删；**已完成行摘掉 `course_session_id` 但保留行**；最后才删时段 | `status='done'` 的历史行永不删除 |
| 注销 | 只清 Cookie，课表快照与派生行保留为只读快照 | 注销 ≠ 删数据 |
| 删除账号 | 显式删派生行 → 级联删课表（`todos` 未开外键级联，必须显式） | 彻底移除 |

物化窗口是 **过去一周 + 未来五周** 的滚动区间，不做整学期：一门课带 `weekIndexes` 展开后一学期轻松上百条，会明显拖重 `list_all_todos` 与知识库索引。窗口漂移由 `campus_schedule` 每次调用时重建一次兜住 —— 所以「打开课表」就等于「时间线也是最新的」，不必额外同步。

派生行在时间线上只读，且**只读的粒度是「改」而不是「用」**：`CanvasTimeline` / `WeekTimeline` 只关掉长按武装（点选与抛滚照旧），点开进的是 `components/campus/CourseDetailSheet.vue`（只读详情 + 「在课表中查看」），不是待办编辑器 —— 派生行由同步**先删后建**，用户若在编辑器里改了标题，下一次同步就把它抹掉重建，看起来像「App 把修改吃了」。桌面右栏 `DayDetailPanel` 同理收起编辑/删除按钮。完成态不靠手勾：**下课即自动打卡**（`auto_complete_past_courses`，以 `date + startMin + durationMin` 为下课时刻，只翻未完成的行），前端每条加载路径都会经 `sync_recurrences` 触发它，所以不打开课表页也会打上；已下课的课在 `CourseDetailSheet` 里只展示「已自动打卡」，不再给「撤销打卡」——撤销会被下一次自动打卡立刻翻回来。未下课的课仍可手动打勾，那是用户自己的考勤，而 `done` 行有「永不删除」的不变量兜着，不会被同步覆盖。

**课表 UI**（`pages/SchedulePage.vue` + `components/campus/Schedule*View.vue`）：日/周/月三视图。周视图行 = 教务的真实节次区间，**左侧列显示实际上课时间**（`startTime`/`endTime` 由教务直接给出，不需要维护节次表），表头在星期几下方标注具体日期。滚动体验的三个决定：单一滚动容器同时承担 x/y（斜向滑动自然）、双向冻结窗格（表头 sticky top + 时间列 sticky left）、`overscroll-behavior: contain`；**刻意不用 `scroll-snap`** —— 吸附会在纵向滚动时劫持手势。**冻结窗格三者（表头 / 左上角 / 时间列）与卡片底同一种材质（`--surface`）**：曾让表头走 `.glass-surface`（半透明 + blur）而角与时间列走实底，亮色下两色本来就接近、看不出，暗色下就是两块深浅不同的灰拼在一起（而八个格子还各自背一层 `backdrop-filter`）；数据表的冻结区属于内容面，玻璃留给悬浮控件。列边界那道封边阴影走 `--glass-scroll-edge`（亮 0.16 / 暗 0.44 的黑）而不用 `--text-1` —— 暗色下 `--text-1` 是近白，整列会被铺开一条白雾。

**命令**：`campus_systems` / `campus_account_get` / `campus_captcha` / `campus_login` / `campus_session_probe` / `campus_logout` / `campus_account_delete` / `campus_semesters` / `campus_set_current_semester` / `campus_sync` / `campus_schedule` / `campus_program`。
选课：`campus_course_select_status` / `_lessons` / `_simplest_lessons` / `_query_condition` / `_apply` / `_predicate` / `_result` / `_predicate_result` / `_drop`。
自动抢课：`campus_grab_state` / `campus_grab_set_enabled`（模块开关，默认关；落 `app_meta` 并停/启引擎） / `_enqueue` / `_task_action` / `_clear_finished` / `_pause_all` / `_resume_all` / `_settings_get` / `_settings_set`。
抢课计划：`campus_grab_intent_add` / `_action`（`remove` 移除并收掉它派出去的任务 / `now` 立刻重新解析） / `_preview`（这句查询照当前名单能匹配到哪些班）。
起飞前自检：`campus_grab_preflight`（登录 / 令牌 / 批次 / 时钟 / 名单 / 每条计划逐项 GO·NO-GO + 证据一句话；按需触发，不自动跑）。

**志愿组没有新命令**：`groupKey` / `groupName` / `priority` 是 `GrabTargetInput` 上的字段（`_enqueue` 原样透传），组名冗余存在任务行上（0027），所以既不新增表也不新增命令 —— 少两处会漂的东西。同理，投递口由引擎自己轮询文件，没有 IPC 命令。

**课表 UI 回归**：`node scripts/e2e-campus-schedule.mjs`（需 `npm run dev` 在 1420）。覆盖未登录空态、配置页选校 + 登录 + 自动同步、周视图表头/左列实际时间/课程块落格、双向冻结窗格、双轴滚动、日/月视图。**与视口高度有关**：容器矮于内容时（小屏 / 远程桌面窗口被压扁）「铺满容器」无从谈起，脚本会改判「照常可滚动」，不会误报。

**真机联调**：`cargo test --lib campus::guet::tests::live -- --ignored --nocapture`（需 `REIN_GUET_USER` / `REIN_GUET_PASS` 环境变量）。教务改版通常先坏「登录握手 / 课表页面解析 / 课表归一化」这三处，联调先跑它。**学期列表只内嵌在课表页面 HTML 里**（`var semesters = JSON.parse('…')`，单引号字面量 + `\"` 转义，实测没有独立 API），改版时这里最先需要复核。培养方案也在同一次联调里核实（941KB、含 `creditDistrTable`）。

**抢课**：独立体系 `/course-selection/` + `/course-selection-api/`，**与课表不是同一套鉴权**。

- **令牌怎么来**：选课系统自带的 `/login`（`SHA1(salt + "-" + password)`）对桂电账号不可用（服务端回「credentials did not match」，`/evaluation/login-captcha/{token}` 还要另一套鉴权、401）。真正的入口是 EAMS 门户发放的 SSO 令牌——`GET /student/for-std/course-select` 页面里写死了 `var url = '…/course-selection/?token=<JWT>'`（载荷 `{iss,exp,username}`，HS256）。拿到后**直接当凭据用**：`Authorization: <JWT>`，裸 token 无 `Bearer` 前缀。
  这条链路的收益是**零新增凭据**：完全复用 `campus_accounts.cookies` 里那份 EAMS 会话，不碰密码也不碰验证码；反过来，教务会话过期时这里只会得到 302，命令会提示回配置页重新登录。令牌按 `exp` 缓存并留 5 分钟余量（抢课要连续轮询，卡在过期边界上很难查），`exp` 解不出就退化成每次重取。**服务端回 401 时要立刻清掉进程内缓存**（`CampusHub::cached_select_token` 只看 `exp`，它不知道服务端已经不认了），否则下一轮还会拿着死令牌撞上去。
- **信封反直觉**：`{result, message, data}` 里 **`result` 为真是出错**（成功是 `result:0`）。整个项目只有这里相反，所以判断只写在 `CourseSelectClient::call` 一处。
- **接口全貌**：`open-turns/{sid}` 拿批次 → `query-condition/{turnId}` 拿查询表单（可选）→ `query-lesson/{sid}/{turnId}` 查教学班 / `simplest-lessons/{turnId}` 拿轻量列表（**路径里没有 sid**）→ 提交 → 轮询。
  提交有两条路：`add-request`（正式，体 = `{studentAssoc, courseSelectTurnAssoc, requestMiddleDtos:[{lessonAssoc, virtualCost, scheduleGroupAssoc, needAttend}], coursePackAssoc}`）与 `add-predicate`（**占位**，体完全相同、只有 `virtualCost` 恒为 0）。占位的结果走 `predicate-response/{sid}/{rid}`，正式的结果走 `add-drop-response/{sid}/{rid}`。
  退课是两段式：`drop-predicate`（体用 **`lessonAssocSet`**）→ `predicate-response` → `drop-request`（体用 **`lessonAssocs`** + `coursePackAssoc` + `confirmMidtermRetake`）→ `add-drop-response`。两个键名不同是抄自 SPA 两处独立的构造点，**统一命名就会 400**。对时用 `getCurrentDateTime`（**别用本机时钟**）。
- **请求体靠单测钉住**：字段名逐字对齐 SPA 的构造代码，抽成纯函数（`add_request_body` / `predicate_body` / `drop_predicate_body` / `drop_request_body` / `LessonQuery`）并逐个加了单测——因为本校选课窗口还没开，提交链路拿不到真机样本，这是唯一能钉住它的手段。同理，批次/教学班结构解析失败时**宁可吵**（把原始片段带进错误信息），也不给个空列表让用户误以为「没批次」。
- **批次为空是常态，不是故障**：窗口由教务处统一开放，在那之前 `open-turns` 一直返回 `[]`。所以 UI 把「等待窗口开放」做成一等状态（含「打开官方选课页」出口），而不是报错。

### 自动抢课引擎（`grab.rs`）

抢课不是「点一下等结果」，是**跟时间赛跑**：窗口由教务处定时开放，开的那一刻几百人同时点。赢的条件只有两条——出手够准（贴着开窗那一秒）、够有耐心（满员了就守着，等别人退）。这两件事都不能交给页面，所以引擎跑在 Rust 后台线程里，形状与 `kb::worker` 一致：**SQLite 任务表 + 一个 worker 线程 + 一条推给前端的事件流**。页面只是显示器，关掉页面不影响任何事。

理由不是「优雅」，是实用：页面会被切走、被系统回收、被 WebView 节流（后台标签页的定时器普遍降到 1 次/分钟），而**抢课恰恰发生在用户放下手机去干别的时候**；用户也可能提前一晚把课排好，第二天开机它得接着抢。

| 模块 | 职责 |
| --- | --- |
| `campus_grab_tasks`（0022） | 任务单。**刻意冗余存课名/课程号/教师/学分**：抢课期间教务可能已把课撤下，而任务单上总得有个名字给人看 |
| `GrabHub::start` | 启动线程 + 启动对账（把上次中断在 `running` 的任务放回队列，**不重置受理号**——那张单子可能已经把事情办了） |
| `step` | 一轮心跳：算「现在最该动哪个任务的哪一步」，做掉它，返回该睡多久。**一轮只发一个请求** |
| `act` → `submit` / `poll` | 状态机：占位 → 轮询 → 正式提交 → 轮询结果 |
| `verdict_of` | 错误分级：换令牌 / 会话失效 / 满员 / 冲突 / 终态 / 可重试 |

**几条不肯让步的规矩**（每一条都有对应的单测或 e2e）：

1. **永不信任本机时钟。** 开火时刻一律用「教务墙上时间 − 实测偏差」换算（`fire_at_ms`）。学生电脑的时间经常偏几分钟，而窗口只开几小时——偏了就是白等。偏差 30 秒重采一次，界面上的时钟按偏差推到现在（不会停在采样那一刻）。
2. **窗口闸门只管第一枪。** 交过占位或正式提交过之后，任务完全由重试节奏支配——不能因为「开窗时刻已经过去」就卡住重试。
3. **提前量（`lead_ms`）。** 在开窗时刻**之前**就出手，让**请求本身**落在开窗那一瞬间，而不是排在开窗之后。默认 800ms。
4. **结果不明时先核对，再重投。** 轮询超上限只说明没拿到回执，不说明没选上。重投前先用 `simplest-lessons` 问一句「这门课现在在我名下吗」，是就收工。（重投可能把到手的名额当成失败再来一次，而教务对重复提交的反应我们没有样本。）
5. **换令牌不算失败。** 令牌过期是最常见的中途故障，换一张就能接着干，绝不能让它吃掉任务的重试次数。会话失效同理：**不判死任何任务**，整批降速后每分钟重试一次——用户去重登一下，引擎自己就活过来。
6. **占位只交一次**（`needs_predicate`）。这个判据必须显式落库（`predicate_done`），**不能拿 `attempts == 0` 反推**：占位落定到正式提交之间 `attempts` 恰好是 0，那样的推断会让任务在「占位 → 轮询 → 占位」里转圈，正式请求一辈子发不出去。真出过这个 bug，是 e2e 逮到的。
7. **满员 ≠ 已选过。** 满员的文案里常常带「已选」（「已选人数已达上限」），关键词顺序写反了就会把满员判成终态——那是抢课里最贵的 bug：你以为在守着，其实早就放弃了。
8. **窗口一关就收手。** 不靠「教务回一句选课已结束」来停手（那句话的措辞我们没样本），用教务自己给的窗口闭区间。
9. **单线程 + 全局节流。** 不管任务单上有几门课，打向教务的请求速率由一个最小间隔闸门唯一决定（`GrabHub::pace_gap_ms`）。并发提交在这里是负收益：对面是同一台服务器，并发既抢不到更多，又最容易触发风控，还会让「为什么被拒」无法解释。
10. **互斥志愿组：同组只主攻当前志愿，中选即收组。** 同组课程是**备选**（时间冲突 / 一轮只能选一门），所以一次只推进「当前志愿」（组内 `(priority, id)` 最小的非终态成员，`group_lead`），其余**不出手也不参与「谁最急」**。任一中选，`close_group` 立刻把同组其余取消（`last_message` 写明被谁抢先）—— 这是「不会同时抢到两门冲突课」的唯一保证。「当前志愿」**不是状态机**而是每轮算出来的派生量：第 1 志愿一进终态，第 2 志愿下一轮自动接手，没有需要同步的中间状态。

**让贤期限（`cede_after_ms`，默认 0 = 死守）。** 0 时**只有**当前志愿进终态（冲突/连败/超出次数）或窗口关闭才轮到下一个 —— 满员是等得到名额的稀疏事件，所以默认不受满员影响。设成 >0 时，当前志愿**连续满员**（`stuck_since` 起算）超过期限就退居待命、把出手机会让给下一志愿；它仍是非终态，后面志愿进了终态它还会回到出手位。这条是**唯一的**「因满员而换志愿」开关，界面上写成「让贤期限（0 = 死守）」。

**窗口监听。** 引擎**不再只在「有人排队等窗口」时才探测** `open-turns`：只要账号在、`watch_window` 开着，就每分钟问一次（照旧走全局节流），把结果落 `app_meta` 并带进 `GrabState.turns`。理由是**大一在窗口开放前连该排什么课都不知道**，而「窗口开了」必须让没停在选课页面上的人也马上知道 —— `GrabFloatBar` 会在「没开 → 开了」那一下全局播报一次。这也是开机自启监控脚本（见 §12 末）在 App 内的对应物。

**文件投递口 `campus_intake.json`。** 外部（监控脚本、或人）把「想抢什么」写成 JSON 放在 App 数据目录，引擎每轮心跳开头（以及启动对账时）`drain_intake` 落库，然后把它改名成 `.done`（幂等 + 可追溯）；解析不了的挪成 `.bad.json` 并挂到 `hub.last_error` 上让人看见。
**为什么不让脚本直接写 SQLite**：任务表的列会继续长（0022 → 0023 → 0027…），在 JS 里抄一份列名就是等着腐烂 —— App 是唯一写者，脚本只投递意图，它也就不必知道 `next_at` / `phase` / `await_window` 这些内务。同一 `(turn_id, lesson_id)` 已在抢的会被跳过（`active_task_exists`），因为「同一份内容投两次」太容易发生，而重复抢同一门课的代价是真实的。

**预设（提前一晚排课）能成立的关键**是「闸门未知」这个状态：入队时如果给不出窗口时刻，任务会被标成 `await_window` 并**挡住不出手**——盲撞出来的「不在选课时间」会被判终态，预设就白费了。引擎改为每分钟去 `open-turns` 安静地问一次，拿到时间就转成精确开火。

### 抢课计划（`matcher.rs` + `grab.rs::resolve_intent`）

任务单回答「正在抢哪个教学班」，计划回答**「我想抢什么」** —— 中间那次翻译由引擎在能看见名单时自己做：

```text
「高数 张」  →  教务此刻的教学班名单  →  模糊匹配 + 抢课语义排序  →  志愿组任务  →  到点开火
```

**为什么要有这一层**（顺序就是重要性）：

1. **可以还没有批次。** 提前一晚写计划时，`open-turns` 往往是空的、教学班更查不到。计划照样落库（`turn_id` 允许为空 = 用当前开放的批次），引擎每分钟试一次，批次一出现就自己接上。**这是「提前输入」唯一说得通的实现方式** —— 让用户在窗口开放那一秒守在屏幕前选课，本身就是把最难的事留给了最忙的时刻。
2. **解析看的是当时的名单。** 哪个班还有空位是开窗那一刻才知道的事；提前抄下来的 `lessonAssoc` 赌的是「名单没变过」，那是拿抢课去赌。所以计划存的是**查询**，不是教学班 id。
3. **解析结果仍然给人确认。** 命中了哪几个班、谁是第一志愿、谁满员，都写在计划行上（`candidates`），任务单里再列一遍。用户不需要相信一个黑盒。

匹配语义（`matcher.rs`，全部有单测）：**空格分词、每个词都要命中**，词可以落在课程名 / 课程代码 / 教师 / 上课时间地点上；一个词命中连续子串即算，退一步允许**散落子序列**（「高数」→「高等数学」，这是「模糊」的全部含义，也是窗口前只来得及打两个字时的唯一选择）。排序是**抢课语义**而不是相关性：没选过的在前 → **精确指定了老师的在前** → 匹配分高的在前 → 有空位的在前 → 剩余名额多的在前 → id 稳定兜底。

**教师命中分三档**，这一档是「去抢谁的课」的唯一判据：

| 档位 | 判据 | 意义 |
| --- | --- | --- |
| **精确**（`teacherExact`） | 全名全等（规范化后） | **指定**：计划只抢这位老师的班（`preferred`），名字沾边的另一位老师不再进候选 —— 「张伟」不该把「张伟明」的班也拖进志愿组 |
| 普通（`teacher`） | 子串 / 子序列命中 | 只打姓氏（`张`）、或名字只是名字的一部分时走这里：那是「匹配上了」，不是「指定」 |
| **近似**（`teacherNear`） | 姓相同、其余**最多差一个字**（LCS ≥ 长度 − 1），且查询 ≥ 2 字 | 名字打错时的退路（`张玮` → `张伟`）：只加分、**不独占**，界面必须说明「这是猜的，核对一下名字」 |

三条刻意的边界：**单字查询不放行近似**（只打姓氏该走子串匹配，放宽它会让「张」去命中「李娜」）；**姓氏必须对上**（否则「张伟」会命中「李伟」——那是两个人）；**精确优先于通用**（`张伟` 落在 `张伟明` 上是一次正经子串命中，不该被降级成「可能打错了」）。

> 排序里 **匹配分在空位之前**是这轮踩出来的：查「张玮」时满员的「张伟」原本会被有余量的「张伟明」挤到后面 —— 那等于因为一个错字换了目标老师。满员是等得到的（守着就是），认错人不是。只有当两边分不出高下时（同一门课的两个班）才轮到空位说话。

分堆（`plan_groups`）：默认**全部命中合成一组**（互为备选，只中一个）；`spread = true` 时**按课程分堆**（每门课各中一个班，同一门课的多个班仍互斥），课程之间互不影响。已在你名下的班一律排除。

引擎侧（`step` 里排在任务之前）：`load_due_intent` 取一条到点的计划 → `turn_briefs`（**与窗口监听共用同一份一分钟缓存**，不为计划多打一次 `open-turns`）→ `lessons_cached`（名单 60 秒缓存，解析与预览共用）→ `match_lessons` → 建任务（`group_key = intent-{id}`，`priority` 就是志愿序）→ 写回 `candidates` + 一句能看懂的话。任何「现在做不了」（批次还没出现 / 名单拉不到 / 一个都没匹配上 / 窗口已结束）都走 `park_intent`：**记原因 + 定重试时刻，绝不删计划**。

几个不显眼但要紧的细节：

- **`hasCount` 发不出去就退回不带它再查一遍**：名额只是排序的加分项，**宁可没有名额也不能拿不到名单**（会话 / 令牌类错误不重试，直接抛）。
- **一轮心跳最多解析一条计划**，且与任务共用同一个全局节流闸门 —— 「一轮一个请求」这条规矩对解析同样成立。
- **`ready` 的计划不自动重解析**（重来是用户按「重新解析」）：它已经排出任务了，再解析一遍只会对着同一批班重排。`pending` / `empty` 才会被 `load_due_intent` 捞起来重试。
- **移除计划会连它派出去的任务一起收**（`delete_intent` 顺手取消同 `group_key` 的非终态任务）。只删计划会留下一个说不通的局面：界面上计划没了，抢课却还在跑。
- **预览与解析共用同一条链路**（`resolve_turn` + `lessons_cached` + `match_lessons` + `preferred`）：预览里看到的顺序，就是解析后排出来的志愿序；被「指定教师」筛掉的班不会出现在任何一处，两边口径永远一致。界面自己不做匹配 —— 匹配只有一份实现。

**重试策略**：满员 → 按 `full_retry_ms`（默认 5s）慢慢守着（名额释放是稀疏事件，打快了只是白费力气）；一般错误 → 按 `strikes` 指数退避（上限 30s）；认不出来的错误 → 也当可重试，但连败 8 次就停，把原始文案交给用户（抢课里误停的代价远大于多试几次，但也确实存在「一直撞同一个未知错误」）。

**节流下限是刻意放开的（2026-09）**：拿真账号对教务压过，**80 次/秒无异常**，所以钳位（`GrabSettings::sanitized`）只留了「不许是 0/负数」这条硬边界 —— 最小间隔 10ms、轮询 50ms、满员重试 100ms、退避基数 50ms；`0` 在 `max_attempts` / `cede_after_ms` 上仍是「不限 / 死守」这些有意义的值。**但默认值一个都没动**（最小间隔仍是 700ms）：放开钳位回答的是「能调到多少」，不是「默认多快」，所以有一条单测专门盯着这件事（`loosening_the_floor_does_not_speed_up_the_default`）。

> 压测打的是 `bkjwtest`（**测试域**），生产域的风控策略未必一样。而且抢课的胜负手是**对时**（`lead_ms` 打得准，让请求正好落在开窗那一瞬）与**占位优先**，不是把请求数堆上去 —— 名额满了就是满了，再多打也只是空转。所以界面上把档位写成「保守 / 偏快 / 压测档」，每档都标着它的代价，而不是只给一个数字让人自己猜。
>
> 还有个**配套的坑**：`step()` 干完活原来固定睡 `BUSY_WAIT_MS`（30ms），等于把速率硬压在 ~33 次/秒 —— 那样「最小间隔调成 10ms」在界面上看着生效、实际完全不起作用。现在改成按节流闸门睡（`pace_gap_ms().max(1)`），配置多少就是多少。**参数放开却没人读它，比不放开的危害更大**：用户会以为自己已经很快了。

**循环的时间轴（`components/campus/GrabTimeline.vue`）**：这几个旋钮光看名字是不知道谁在管什么的，所以设置抽屉最上面画了一张循环图 —— 五条泳道（开窗前 / 一次尝试 / 满员时 / 出错时 / 全局闸门），每段可调的延迟画成**按真实比例**伸缩的条，再用**引导线**把「它叫什么、现在是多少」拉出来（`leadMs = 800 ms` 这种）。几条不肯妥协的细节：

- **各泳道各有各的刻度**（满宽多少写在右上角）：提前量是毫秒级、重试是秒级，塞进一个刻度里要么把毫秒压没、要么把秒级的差异抹平。
- **「提前出手」的条是从开窗线往回推的**（`endAt`），不是从左边顺排 —— 它量的不是「从某点往后多久」而是「比开窗早多久」；顺排会画成「先提前、再等一会才开窗」，那是错的。
- **满员与出错分开画**：它们不会同时发生，排成一条会让人以为「满员之后还要再退避一次」。
- **全局闸门单独占一条**：它才是「多久打一次教务」的总开关。这条是踩出来的 —— 起初它只写在脚注里，于是「点一下预设、整张图全灰、没有任何一段亮起来」，看着像坏了。
- 调整中的那一段点亮（`active`）、其余淡下去，这就是「让用户明确知道自己在调哪个参数」的那一下。参数名与泳道段的对应只写在 `GrabTimeline` 里一份。

`NumberStepper` 顺带补了**点数值直接输入**：只有 +/- 时，区间一旦拉开（最小间隔 10ms ~ 10s）要么点几十下才到低档、要么在低档迈不开步。设置里再配三档预设（一次点击把三个数字一起调好）。

**UI**（`pages/CourseSelectPage.vue` + `components/campus/Grab*.vue`）：心智模型是**抢课任务单**——你把课排进去，引擎负责时钟。五处界面：

- `GrabPlan` = **抢课计划**：一句模糊查询 + 「中一个就够 / 每门课都要」，按下去就交给引擎（计划面板在**批次列表之上**，所以窗口还没开、连批次都没有的时候，这里也是有事可做的）。它回答的是「我会抢到哪些课」：预览先把「这句查询照**此刻**的名单能匹配到哪些班、按什么顺序出手」摆出来（命中字段也标出来 —— 用户有权知道为什么是它），写进计划后再由引擎把解析结果写在计划行上，任务单里同步出现对应的志愿。**移除计划连它派出去的任务一起收**；「重新解析」把状态退回 `pending` 让引擎按新名单重排。
   > 老师名字是这套匹配里唯一带「语气」的东西，所以界面必须把两种语气分开说：**打全了名字** → 标「教师精确」并写明「按指定处理，只抢这位老师的班」；**打错一个字** → 标「教师近似」并写明「这是猜的，核对一下老师姓名」。两者都不能只靠颜色——用户在窗口前没时间猜颜色。
   > 两处踩过的坑：① 状态徽标**解析状态优先于任务进展** —— 重新解析时旧任务还挂着「已抢到」，先看任务就会显示着「已抢到」而引擎正在重排，那是在骗人；② 输入框**提交前就清空**（失败再把原文放回去）—— 等一个来回再清，「按了没反应」的几百毫秒里用户敲的下一门课会被悄悄吃掉（这条是 e2e 逮到的）。
- 行按钮 = 「抢课」，打开 `GrabSheet`：选**上课小组**（`scheduleGroupAssoc` 决定你在和谁竞争，一门课 3 个组时第 2 组满了而第 1 组还有位置）、填**意愿值**（启用虚拟钱包的轮次里它是硬门槛，普通轮次必须留 0）、选模式（占位优先 / 直接提交）、选**志愿组**（见上：独立抢 / 加入某一组 / 新建一组 + 第几志愿，抽屉里顺带把该组成员的次序摆出来，冲突看得见）。另有「立即试一次」走一次性提交 + 轮询。
- **多选预定**：教学班列表可切到多选，底部「加入抢课」一次把选中的排好 —— **勾选顺序就是志愿序**（用数组而不是 Set 存，就是为了这件事），批量抽屉里再选「各抢各的」还是「排成志愿组」（多选时默认后者）。一门课挂着 5 个教学班时，逐个点开抽屉加 5 遍还得自己记住谁排第几，那条路走不通。
- `GrabPanel` = 引擎仪表盘：它要在**不盯着屏幕**时也能回答三件事——在抢什么（任务行 + 状态标签）、什么时候出手（按服务器时钟校正的倒计时）、出事了吗（引擎级故障横幅 / 失败原因原文）。志愿组按**组**渲染（组头写「第 N 志愿在抢」，被压住的成员写「等第 N 志愿」），散任务照旧平铺；没有任务时这里显示**窗口监听**的状态，让「它还在盯着」这件事看得见。
- `GrabSettingsSheet` = 只暴露**真正需要动的旋钮**（最小间隔 / 提前量 / 查结果间隔 / 满员重试 / 次数上限 / **让贤期限** / **窗口监听**），每个旁边写清「调大调小会怎样」。不摆一屏工程参数：调错了只会让人以为程序坏了。后端落库前再收口一次（`GrabSettings::sanitized`），界面调不出「每 50ms 打一次教务」。

**自动刷新**（`CourseSelectPage.vue`）：抢课上「界面旧了」是有代价的 —— 窗口开放、名额释放都发生在你没点按钮的时候。所以批次 + 服务器时间 60s 一次、已进入批次时教学班 30s 一次，`visibilitychange` / `focus` 切回来立刻补一次（**这条比定时器值钱**：后台标签页的定时器会被 WebView 节流到 1 次/分钟）。有请求在飞或正在提交就跳过本轮，不叠请求。手动按钮降级成「立即刷新」，页面上显示上次刷新时刻。

> 两个派生值只在快照这一层算，前端不重算：`fire_at`（要实测偏差与提前量）与 `held_by`（要组内志愿序）。后者**只标给还在场上的成员** —— 给终态的也标上「等第 N 志愿」，界面上一条已经出局的任务看起来就还在排队（这个 bug 是在浏览器里看出来的，单测补在 `held_by_skips_tasks_that_are_out_of_play`）。
>
> `GrabFloatBar` 的两个播报都挂在**快照 watcher** 上：任务进终态播一次，以及「窗口没开 → 开了」播一次（后者是跨页面最有用的那条信息）。早先它只在 `setup` 里裸调了一次 `watchTerminal()`，于是「挂载那一刻恰好是终态」才会响，之后抢到了也不吭声。

页面与引擎的桥是 `campusService.onGrabState`（事件名 `campus://grab`），套路与 `voiceService.onAsr` 一致：Tauri 里用 `listen`，浏览器里挂到 `mockCampus.onGrab`。store 里的任务单有**两个来源**——进页面 `campus_grab_state` 拉一次，之后全靠事件推送；两者同形，所以渲染逻辑只有一份。

- **真机联调**：`cargo test --lib campus::course_select::tests::live -- --ignored --nocapture`（需 `REIN_GUET_USER` / `REIN_GUET_PASS`），或者**只读**的 `node scripts/probe-course-select.mjs`（账号从 App 库读、不需要环境变量，只打查询类接口，从不提交）。
- **2026-09-21 窗口开放后已核实**（批次 `1921`「2026-2027学年第一学期新生选课」，窗口 `09-21 10:00 ~ 09-30 23:00`）：EAMS 会话 → SSO 令牌 → 服务器时间 → 学生档案 → `open-turns` → `turn/{id}/select` → `query-condition` → `query-lesson`（395 行、一次给全，`pageInfo: null`）→ `simplest-lessons`（1013 行，**顶层就是数组**，不是 `{lessons}`）→ `selected-lessons`（14 行，含置课）。三处与代码假设不同、已按实测修正：**批次 id 在顶层 `turn.id`**（旧写法找的 `options.turn.id` 不存在，只是恰好与列表 id 相等才蒙对）；**`turnMode.showCount: false` 时 `stdCount` 一行都不返回**（「满没满」判不出来，只能靠提交结果说话）；我们发的 `sortField` / `sortType` 被忽略（响应 `sort__: {field: null, type: null}`，要排序得按 SPA 的真实参数名来）。
- **仍未验证**：`add-request` / `add-predicate` 的真实响应结构 —— **没有真提交过**。窗口里每一次提交都是真实的占位/选课，不能拿它当联调靶子；要验它得在明确同意下提交一门真实课程，或者等第一次真实抢课留下回执。
- **UI 回归**：`node scripts/e2e-course-select.mjs`（一次性选课链路：批次空/开两态 → 搜索过滤 → 提交轮询 → 成功与冲突两条收尾）、`node scripts/e2e-auto-grab.mjs`（引擎链路：加入抢课 → 自动占位/受理/确认 → 满员重试后抢到 → 冲突 → 等窗口 → 暂停恢复 → 清空 → 节奏设置 → 离开页面再回来）与 `node scripts/e2e-grab-squads.mjs`（志愿组链路：多选顺序成志愿序 → 组头/志愿序渲染 → 被压住的显示「等第 N 志愿」→ 中选即收组 → 第 1 志愿进终态后第 2 志愿自动接手 → 出局的条目不再显示「等第 N 志愿」→ 「各抢各的」不产生组关系）与 `node scripts/e2e-grab-plan.mjs`（**计划链路**：模糊匹配「高数 张」命中同一个班且解释命中字段 → 按代码列出同门课全部教学班且**同分时有余量的排在满员之前** → **打全老师名字只留那位老师的班**（名字沾边的「张伟明」被滤掉）→ **打错一个字退回模糊、且更像的那位先出手**（哪怕它满员）→ 没匹配到与「教务还没公布」两种空分开说 → 写出计划后引擎自己解析成志愿任务并抢到 → 重新解析 / 移除（连任务一起收）→ **批次还没出现时写好计划，批次一出现自动接上并抢到** → 「每门课都要」写在计划行上）。定位用的 mock 钩子：`window.__REIN_MOCK_NO_SELECT_TURN__ = true` 把批次置空、`window.__REIN_MOCK_GRAB_NO_WINDOW__ = true` 让引擎进入「等窗口公布」、`window.__REIN_MOCK_GRAB_TURNS__ = [...]` 直接把窗口监听的结果摆出来。浏览器里没有 Rust 那条线程，所以 `mock/server.ts` 自己实现了一份模拟引擎（`grabTick`），**状态序列与真引擎一致**、只压缩时间尺度，**志愿组那套规则也照做了一份**（`grabLead` / `grabArmed` / `grabCloseGroup`，与 Rust 同名同序）、**计划的匹配与分堆也照做了一份**（`grabMatchLessons` / `grabPlanGroups` / `grabPreferred`，与 `matcher.rs` 同规则同序，含教师的精确 / 近似两档）；不打折的是「开窗前不出手」那条闸门与「中选即收组」那条互斥。**匹配只有一份生产实现**（Rust）；mock 那份是测试替身，两边一旦分叉，`e2e-grab-plan` 就什么都证明不了 —— 所以它的规则是逐条对着 `matcher.rs` 写的。

### AI 救援面（`rescue.rs` + `ai/tools/campus.ts`）

引擎管「一切照常」，这一片管「不照常」：教务改了接口、返回了 HTML 回退、多了个没见过的报错、会话怎么都救不回来、任务卡在一个词都没见过的错误上。那些时刻唯一能救回来的动作是**带会话打一条任意请求 + 看清它到底回了什么**，所以这部分能力的形状就是围绕这件事定的。

`campus/commands.rs` 出四个命令，纯逻辑与审计在 `campus/rescue.rs`（可单测，不碰网络）：`campus_rescue_state`（一次给全现场：账号、会话探针、服务器时间与偏差、批次窗口、计划解析状态、每个任务卡在哪个阶段、引擎级故障原文、以及**AI 自己最近做过什么**）、`campus_http`（任意请求，返回状态码 / 响应头 / 正文 / 等价 curl）、`campus_rescue_note`（不带请求的动作也进审计）、`campus_curl_export`（把这一路的请求渲染成可脱离 App 重放的 `.sh`）。表 `campus_ai_actions`（0030）。

**五条不变量**（写操作是不弹确认的 —— 抢课窗口里每一次确认都是拖延 —— 所以约束落在别处）：

1. **带凭据只去同源**：Cookie 与选课 JWT 只在教务 base 同源时附加，跨域给了直接报错（不是安静地降级：模型会以为自己拿到的是「带会话的结果」）。理由不是洁癖 —— 这条链路的上游是**模型的输出**，而模型的输入里混着远程响应，「把 Cookie 发到这个地址」这种注入必须从一开始就不可能成立。`rescue::check_target` 是唯一执行点。
2. **任意公网可打，但不带任何凭据**：教务改接口时要去读它自己的 SPA 包、核公开文档，这条路连门户的 `Origin`/`Referer` 都不带（来源信息也是信息），且仍过 `web::validate_url` 那道 SSRF 白名单（拒私网/环回）。
3. **每一步留痕**：`campus_ai_actions` 记 kind/summary/detail/curl/status + 人话 `reason`（必填 —— 「为什么打这条请求」是事后最缺的一栏）。它同时喂三个消费方：设置页的操作记录、导出脚本、熔断。
4. **熔断**：同一条请求 60 秒内 ≥20 次直接拒绝（判据是**不含凭据**的请求指纹，会话刷新绕不过去）。救援工具自己不能变成新的故障 —— 模型在一个错误上原地转圈是它最典型的失败模式。
5. **自愈立即落库**：门户 302 / 选课 401 时静默重登并重试一次，新 Cookie 马上写回（与既有约定一致），响应里标 `healed` 并在注里说清「上面是重试后的响应」。

**渲染出来的 curl 一律用 `$COOKIE` / `$SELECT_TOKEN` 变量引用**：凭据只在脚本头部出现一次，审计表里因此不逐行存 Cookie（库里那份账号密码已经够扎眼了）。脚本行尾固定 LF（Windows 上 CRLF 的 `.sh` 会让 bash 报 `$'\r': command not found`）。

**AI 侧**（`src/ai/tools/campus.ts`，8 个工具）：`campus_status` / `campus_lessons` / `campus_grab_plan` / `campus_grab_control` / `campus_select` / `campus_session` / `campus_http` / `campus_export_script`。它们调的是**与页面同一批 Tauri 命令**（`campusService`），所以 AI 排出来的任务与人在页面上排出来的完全同形 —— 用户回到抢课页看到的就是同一份任务单。教学班 → 抢课目标的字段映射也刻意与 `stores/courseSelect.ts::enqueue` 逐字段对齐（两处映射一旦分叉，AI 排的任务与用户自己排的就会长得不一样）。系统提示词里给了排障剧本与几条判据，其中最要紧的一条：**探针说会话有效、但接口回的是 HTML 回退而不是 `{result,…}` 信封 —— 那是教务改了接口，不是会话问题**。

入口两处：`GrabPanel` 的故障横幅与底部常驻按钮「交给 AI 排查」，把当前现场（引擎故障原文、卡住的任务、计划与批次）压成一段话递进 AI 页并直接发出（着急的时候不该还要人复述一遍）；设置页的「AI 操作记录」列出最近二十条动作并可一键导出脚本。

> 浏览器里没有真模型可调，而这条链上真正会坏的是**参数形状与命令名**，不是模型的措辞。所以注册表在浏览器直连模式（`!isTauri`）下把工具直调挂到 `window.__REIN_TOOL__` 供 e2e 使用；真机上（桌面 / Android）永远不存在这个钩子。

**救援面回归**：`node scripts/e2e-campus-ai.mjs`。覆盖：面板入口 → 现场被作为一条消息递过去；`campus_status` 一次给全现场；相对路径自动补全并带上会话；**带会话打外部地址被拒**（硬边界）而外部地址不带凭据可打；**「接口返回 HTML 回退」与「会话被踢回 302」两种故障能被分开认出**（这是最要紧的一条：判错就白折腾一整轮）；卡住的任务被识别 → `retry_stuck` 真的把连败与次数清零；动作进审计；导出脚本的骨架 / 凭据变量 / 每请求一条 curl / LF 行尾 / 知识库副本；设置页的记录区。mock 侧的剧本与钩子：`__REIN_MOCK_CAMPUS_BREAK__`（选课接口返回 SPA 回退页）、`__REIN_MOCK_CAMPUS_SESSION_DEAD__`（门户 302）、`__REIN_MOCK_CAMPUS_STUCK__`（把在场任务按成「连败到该被救」且按在等窗口上，否则 mock 引擎会在一两百毫秒内把它抢到手，这件事就无从演练）。

**真机联调**：`cargo test --lib campus::rescue` 是不打网络的纯逻辑单测（渲染 / 同源判定 / 截断 / 熔断 / 审计往返）；真机上要验的是「同源请求带上会话能拿到 200、选课接口在窗口开放时回的是 JSON 信封而不是 HTML」，那把 `campus_http` 当探针使即可。

### AI 约课面（`ai/tools/campusProgram.ts`）

救援面管「不照常」，这一片管**照常**：用户说「我还差多少学分 / 这学期该选什么 / 提前把那几门排好」时要走的路。两个工具（`campus_program` / `campus_reserve`）与救援面共用 `campus.ts::note` 的审计入口，做的却是另一件事。

**为什么不能把培养方案直接丢给模型**：`program-info-json` 实测 900KB+，原样进上下文既撑爆预算又没信息量。所以压成四种投影：`overview`（档案 + 学分要求/已修/缺口 + 顶层模块）、`modules`（学分分布树摊平，带 depth —— 逐级列出**不跨层求和**，父节点的数字不含子节点，这一条写进了返回里的 tip）、`courses`（课程清单，可搜可翻页）、`crosscheck`（**本批次的教学班与方案课程逐门对照**）。课程清单里搜不到 = 不在你方案里，而教务是按**教学条件组**放课的：`grab.rs::verdict_of` 把带「培养方案」字样的驳回判成**终态**（重试无用、引擎停手）。所以「在不在方案里」必须在**排课之前**就标出来，而不是排完一轮等教务拒 —— 这正是 `crosscheck` 与预约单里 `inProgram` 那一列的由来。

判定顺序刻意是**先课程代码、再课程全名、最后才是一方包含另一方**（「大学物理（含实验）」落在方案里的「大学物理」上）。包含式匹配最容易误伤，所以放最后，并把 `takenBy`（`code` / `name` / `nameLike`）一起返回，让模型知道这次判定有多硬。课程清单按代码（退化到课名）去重 —— 同一门课在方案里出现多次会把「搜到几门」这类判断带偏。

`campus_reserve` 不新造机制：落库落的还是 `grab_intent`（计划），引擎照旧在能看见名单时自己解析成志愿任务、守着窗口开火。**新增的只有「先出预约单、再落库」这条分寸**：`dryRun` 默认 `true`，只回「会抢哪些班、还剩多少位置、在不在方案里、什么时候开抢」，并明确要求模型把这单子念给用户、**拿到一句明确同意**才用 `dryRun:false` 落库。批次还没公布（`open-turns` 为空）时预览必然失败，这**不是故障**：预约照样能落库，引擎每分钟看一次窗口，一出现就自己排班 —— 提示词与工具回执里都把这句话写死了，免得模型把「窗口没开」当成错误反复重试。

**约课面回归**：`node scripts/e2e-campus-reserve.mjs`。覆盖：学分缺口（162 − 18.75 = 143.25）与模块树的层级/口径；课程清单搜得到（带回代码）与搜不到（附「教学条件组会拒」的解释）；`crosscheck` 把本批次分成「方案内（4）/ 方案外（2：线性代数、计算机科学导论）/ 方案里有但本学期没开（2）」；预约单的余量算法（上限 − 已选）、命中判据、`inProgram` 判定依据；**`dryRun` 不写审计**；批次未公布时如实说明「不影响预约」；`dryRun:false` 才落库并留审计（`预约了 1 门课`）；最后**不再操作任何东西**，由引擎把这条计划解析成志愿任务并抢到。这条链路在浏览器里跑的是 mock 引擎（`mock/server.ts::grabTick`），所以它证明的是「工具 → service → 命令 → 引擎」这条链的形状，而不是真教务的行为。

**时间线集成回归**：`node scripts/e2e-campus-timeline.mjs`。钉的是「同步之后时间线上多了什么、又能对它们做什么」——派生行出现并按 `--cat-class` 着色、长按不武装（普通待办对照）、点开是只读详情、打卡、再同步行数不增（幂等）且 done 行不被重建、删账号后一并清除。这条链路的 UI 行为在 Rust 单测里一个都反映不出来。

**培养方案回归**：`node scripts/e2e-campus-program.mjs`。覆盖未登录空态、从配置页入口进入、方案档案、学分进度条宽度 = 已修/需修、学分分布树的层级、课程清单搜索（按名/按码/无结果）、顶栏强制重拉。**mock 需要自己物化时间线**（`campusMaterializeTodos`）—— 否则「课表进 TimeLine」在浏览器里根本看不见，也就无从回归。

### 开机自启的窗口监控（`scripts/course-watch.mjs`）

App 里的窗口监听只救「App 开着」的情况；**窗口在 App 没开时开放 = 完全错过**，而这恰恰是最可能发生的一种：抢课窗口按教务处的钟点开，人在上课。所以本机另有一个独立的守护进程。

它不碰 App 的内部，只做四件事：读本地库的账号 → 轮询教务 → 比指纹 → 有**有意义的变化**就拉起一个 headless Command Code 会话去核对，那个会话再通过投递口把要抢的课交给 App 引擎。分层与 App 内一致：**脚本给意图，引擎负责时钟与重试**。

| 关注点 | 决定 |
| --- | --- |
| 账号来源 | 只读 `%APPDATA%/com.gozaoo.rein/rein.db` 的 active 账号。**先用库里那份 Cookie 恢复会话，失败才走密码** —— 密码可能已经改了而库里还是旧的，那份 EAMS 会话却常常还有效 |
| 轮询节奏 | 默认 60s；批次已开（`allowEnter`）时 20s；登录失败退避到 10 分钟（登不上的账号反复打会被风控） |
| 什么算「有意义」 | 批次从无到有 / `allowEnter` 翻真 / 教学班 `canSelect` 翻真 / 由满变有空位。**座位数抖动（20→19）不算** —— 抢课期间它会一直跳，认它就等于把会话刷成连珠炮 |
| 拉起什么 | `cmdc -p "<prompt>" --yolo --trust --output-format json`，首次不带 `--resume`、从 result 行取 `sessionId` 存下来，之后一直 `--resume` 同一个会话（上下文累积） |
| **用 `cmdc` 不用 `cmd`** | 本机 `cmd` 会被 `C:\WINDOWS\system32\cmd.exe` 抢先解析（实测 `Get-Command cmd` 就是 cmd.exe）。脚本直接定位 `command-code/dist/index.mjs` 用 node 跑，顺带绕开 Windows 上 `.cmd` 必须有 shell 的坑 |
| 状态与日志 | `%LOCALAPPDATA%\ReinCourseWatch\`（`state.json` / `watch.log` 轮转 / `reports/` 每次触发的会话结论） |
| 单实例 | `watch.lock` 存 PID + 启动时间，陈旧锁自动接管。**必须有** —— 开机自启装了两处（任务计划程序 + 启动文件夹），没锁就会跑两份，两份都会拉起会话、都会投递任务 |

**运维**：`node scripts/course-watch.mjs --status` 看装没装 / 跑没跑 / 上次检查与上次拉起；`--once --dry-run` 手跑一轮但不真的拉起会话；`--selftest` 跑一组变化检测的断言（不需要教务账号）；`--enqueue @payload.json` 手投一单；`--install` / `--uninstall` 注册与卸载开机自启（任务计划程序 `ReinCourseWatch` + 启动文件夹里的 `.vbs`，两者都指向同一个隐藏窗口启动器）。

> **提示词注入面**：远程响应里的文本会进到一个 `--yolo`（可写文件、可跑命令）的会话。提示词里把 diff 明确标成**不可信数据**、只带白名单字段并截断长度、只让会话跑两条命令（probe / enqueue）。想更紧就把 `--yolo` 换成权限规则白名单。
>
> 登录登不上时的行为是被刻意设计过的：库里那句「教务拒绝了这次登录」**不替教务编原因**（实测它可能只回 `{result:true,needCaptcha:false}`，什么都不说）—— 编出来的「密码错误」会把「其实会话还能救」的线索带偏。

`scripts/lib/guet-session.mjs` 是它与 `probe-course-select.mjs` 共用的会话层（登录握手 / Cookie / SSO 令牌 / 信封约定）。**公钥仍然从 `provider.rs` 正则读**，不在这里抄一份 —— 抄错一个字符就是 `digital envelope routines::decode error`，很难一眼看出。

## 13. 功能插件层（src/plugins · stores/features.ts）

把「一个功能模块」声明成数据，而不是散落在导航栏、主页工具格、路由守卫里的三份硬编码：元数据（名称/说明/图标/主题色）+ 扩展点贡献（导航条目、主页工具卡）+ **路由所有权** + **父子关系**。**十个开关**是它的消费者（设置页一行一个、一个模块一个文件）：

| 模块 | id | 关闭时一起收起的表面 | 默认 |
| --- | --- | --- | --- |
| 营养 | `nutrition` | 四条营养路由 · 导航轨条目 · 四张工具卡（吃卡随之整块不渲染）· 主页摄入总览 · 便当三块 · ⌘K「记饮食」· 「我」页每日目标栏 | 开 |
| 记账 | `ledger` | `/ledger` · 导航轨条目 · 工具卡 · 便当记账块 · ⌘K「记一笔账」· 「我」页本月结余栏 · AI「记账」工具组 | 开 |
| 专注 | `focus` | `/focus` · 导航轨条目 · 工具卡 · 便当番茄钟与快捷磁贴 · 设置页番茄钟配置卡 · AI「专注」工具组 · **对外 `pomodoro.*` 六条**（含 start/pause/stop 下行控制） | 开 |
| 语音 | `voice` | 「录音纪要」工具卡 · 语音会话浮层与转写浮条（`App.vue`）· AI「语音服务」工具组与提示词段落 | 开 |
| 录音 | `record` | `/record` · 录音浮条 · 待办编辑抽屉的录音附件钮 · ⌘K 页面项 | 开 |
| 多设备同步 | `sync` | `/settings/sync` · 设置页那张卡 · ⌘K 与桌面信息栏的入口 | 开 |
| 运动 | `sports` | 七条运动路由 · Dock 页签与导航轨 · 工具卡 · 便当两块 · **对外 `workout.*` 十四条** | 开 |
| 课表 | `campus` | 三条教务路由 · 导航轨条目 · 工具卡 · 主页课程条 · AI「校园教务」工具组 · **对外 `schedule.campus`** | 开 |
| 抢课 | `campus-grab` | 两条选课路由 · 抢课浮条 · 自动交 AI 排查 · AI「抢课」工具组 · **Rust 引擎（真门闩）** | **关** |
| 健康方案 | `program` | 两条方案路由 · 工具卡与主页状态卡 · AI「健康方案」工具组 · **对外 `schedule.programs` / `schedule.programActive`** | 开 |

内核只剩两个（不可关，但同样走这套声明）：**待办**（画布 / 时间线 / 主页信息流的宿主，AI 的 `todo` 组是常驻组）与 **AI**（右独立圆钮的落点、知识库检索面、`diet`/`nutrition` 等常驻工具组的宿主）。

- **声明**：`src/plugins/builtin/<模块>.ts` 调 `definePlugin`；`builtin/index.ts` 导入即注册（新增模块 = 加一行 import）。`definition` 是纯数据——不认识 Pinia、不 import router、不持有组件状态。
- **注册表**：`src/plugins/registry.ts`。`routeOwner(routeName)` 供路由守卫查「这条路由归谁」，`toggleablePlugins()` 供设置页取开关清单。
- **启用态**：`stores/features.ts`，唯一事实来源。`tools`（主页工具卡，已过滤未开模块并按 order 排好）、`nav(surface)`（`tabbar` / `rail` 两种导航容器的条目）、`isEnabled(id)`（守卫与条件渲染）。持久化在 localStorage `rein.features.v1`：它与番茄钟设置同属**界面级偏好**，不进 SQLite、不进知识库索引；只存用户改过的项，未覆盖的回落声明里的 `defaultEnabled`，所以新增插件不需要迁移旧数据。
- **子模块（`parent`）**：声明 `parent: '<父模块 id>'` 即成为它的子模块。两个效果都在 `isEnabled` 里：父模块关掉时**子模块一律视为关闭**（子模块吃的是父模块的会话与数据，父的不在它开着只会撞墙），设置页则把它缩进挂在父模块下面并写明「父模块关闭时不可用」。当前唯一一例：**抢课（`campus-grab`）是课表的子模块且 `defaultEnabled: false`** —— 它比课表激进得多（后台引擎会按节奏反复打教务），两者的风险不在一个量级，不该共用一个开关。
- **带后台引擎的模块必须给引擎真门闩**：关闭不能只关 UI。抢课的开关变化会同步给 Rust（`campus_grab_set_enabled` → `GrabHub::set_enabled_flag` + 落 `app_meta`），引擎在 `step` 开头就返回，**关着时一个请求都不发**（连窗口探测都停），重启后也按上次的开关来。只关界面不关引擎，等于「用户以为关了，它还在每分钟问教务」。
- **没有后台引擎的模块就不该造门闩**（这一轮的判据，两种情况都踩过）：
  - **语音 / 录音是「按需连」**：ASR 的 WS 与 MediaRecorder 都只在用户按下开始时建立，关掉它们的开关只要收掉浮层与入口，没有进程在偷偷跑 —— 加一个 Rust 开关反而是多余的接线。
  - **多设备同步恰恰相反，但结论一样**：`SyncHub` 线程（`engine.rs::loop_forever`）全程**零网络请求**，它只在本地写入发生时把改动捕获进 blob 仓库，联网只发生在用户按下「立即同步」那一刻；而它还是**网关变更推送的唯一来源**（`SyncHub::set_feed`，见 §12）—— 按同步开关停掉它，会把外部访问的推送一起掐死。判据是「它会不会在用户不知情时自己发请求」，不是「它有没有线程」。
- **扩展点（当前两处）**：
  - `nav`（`NavContribution`）：`surfaces: ['tabbar' | 'rail']` 决定落点，`TabBar.vue` / `DesktopRail.vue` 只渲染「内核条目 + 插件条目」，没有第二份清单。移动端 Dock 里：`tabbar` 的条目落在**中药丸**；内核落点（主页 / 我 / AI）由 TabBar 自己声明 —— AI 是右独立圆钮，所以插件层的 AI 只投 `rail`；**左独立圆钮是用户自定义落点**（`stores/dock.ts`，候选 = `nav('rail')` 去掉 Dock 已有的项），关掉模块后候选自然消失、存量落点回落到候选第一项。
  - `tools`（`ToolContribution`）：主页页脚的成员与工具（2026-10-04 起，移动端页脚按 id 把它们领进「课程条 / 吃 / 练 / 专注·钱 / 工具」各 slot）。跳转用 `to`；就地交互用 `action`（`ToolAction` 联合类型）——动作由**承载页脚的组件**实现（`home/HomeFooter.vue` 的 ACTIONS 表，开弹层 / 唤起运行时），插件不 import router，页面也不反过来认识插件内部。
- **关闭一个模块的连锁效果**（入口的清单是**同一个开关的多个投影**，漏一处就是「半关」）：工具卡与导航条目消失（响应式）、其名下路由被 `router.beforeEach` 拦回主页并 toast 说明、页面按 `isEnabled` 跳过该模块的数据加载（主页不再 `program.load()` / `nutrition.loadSummary()`）、桌面便当总览收起对应的块（`useBentoLayout` 的 `MODULE_ITEMS`，按 id 分组而不是再写一份 `.no-sports` 区域表）、`App.vue` 按开关渲染常驻浮条（录音 / 语音 / 抢课）、挂在其它模块里的入口也各自收手（待办抽屉的录音附件钮、设置页的番茄钟与同步卡、主页页脚由成员缺失自然空掉、`CommandPalette` 的显式动作、`DesktopInspector` 的同步行、「我」页的目标/结余栏）。
- **AI 工具组跟着模块开关走**：`registry.ts` 的 `GROUP_POLICY` 里带 `plugin` 的组（运动 / 训练课程 / 健康方案 / 教务 / 抢课 / 记账 / 专注 / 语音）在该模块关闭后整组不装载、`load_tools` 也装不上（`groupAllowed`），提示词段落与工具同进同出（见 §10）。**`diet` / `nutrition` 两组刻意不挂营养插件**：食物卡协议的分寸、约定与输出三段是 AI 域无条件下发的核心链路，摘掉工具只会让模型读得到用法却调不到工具；营养插件管的是营养界面与入口，不是「AI 能不能记饮食」。
- **对外接口同样跟着模块开关走**：网关的 28 条方法里，`workout.*`（运动）/ `pomodoro.*`（专注）/ `schedule.campus`（课表）/ `schedule.programs`（方案）各自挂模块，关掉即回 `module_disabled`（`Method::plugin()` + `store::module_gate`，见 `docs/EXTERNAL-API.md` §4.7）。快照由 `App.vue` 推给 Rust（`gateway_set_enabled_modules` → `app_meta:gateway.enabledModules`），与抢课的引擎门闩同一条纪律 —— **只关 UI 等于没关**：`pomodoro.start` 足以启一个前端界面已经不显示的计时器。
- **模块关掉时会跑着的会话要收手**（`App.vue` 的 watcher）：浮层与浮条都是 `v-if` 挂的，语音会话或录音进行中去关掉模块，UI 会整个消失而 runtime 还在采（麦克风占着、界面上再没有能停它的按钮）。两条都按**不丢数据**收尾：语音走 `finishSpeaking()` 正常结算（不是 `cancelSession()`，那会丢转写），录音走 `stopRecording()` 把 take 留在内存列表里（模块再打开就看得见）。
- **不变量**：开关页 `/settings/features` 自身不属于任何插件，任何组合下都可达；关闭**只影响入口、路由与对外接口，不删任何数据**（记住「关掉 ≠ 删掉」）—— 所以会话进行中被关掉时是「收尾」而不是「丢弃」（见上一条）。
- **回归**：`node scripts/e2e-feature-toggles.mjs`（需 `npm run dev` 在 1420）。覆盖「我 › 设置」入口、设置页分组、**十个开关的显隐联动**（逐模块关掉后工具卡 / 底栏页签 / 导航轨 / 便当块 / 设置页配置卡一起消失，直链被拦回主页并提示）、**抢课默认关 + 子模块缩进 + 父关子失效 + 打开后直链放行**、**网关模块快照（关掉的模块一个都不在里面 —— 门禁的前端那一半）**、刷新后持久化，以及桌面端的导航轨与便当布局自检（`grid-template-areas` 少写一行会凭空多出隐式轨道——这条断言就是为那次事故留的）。Rust 侧门禁另有确定性单测：`cargo test --lib gateway`（`Method::plugin()` 的覆盖面 + `store::module_gate` 的三条契约）。
  抢课/选课类的其它剧本（`e2e-course-select` / `e2e-auto-grab` / `e2e-grab-*` / `e2e-campus-*` / `e2e-layout-guard`）**必须在导航前把开关预置为开**，否则守卫会把它们全拦回主页：用 `scripts/lib/features.mjs` 的 `presetFeatureFlags(cdp)`（走 CDP 的 `Page.addScriptToEvaluateOnNewDocument` —— pinia 的 features store 在应用启动时就读了 localStorage，进页面后再写不生效）。

## 14. 在线更新与 Rein 在线服务（modules/update · server · scripts/release）

完整规范见 [`docs/UPDATES.md`](UPDATES.md)，这里只记架构约束与「为什么不那样做」。

**信任模型：三道门，缺一不可。** ①清单本身带 Ed25519 签名（`latest.json.sig`）——
没有它，中间人可以改写版本号与摘要；②`sha256` + `size` 挡下载损坏与截断；
③安装包本体的 minisign 签名，用**编译进二进制**的公钥（`modules/update/keys.rs`）验，
不过就拒绝安装。第 ③ 条是唯一不可协商的一条：另外两条都在可被改写的清单里。

**为什么不用 `tauri-plugin-updater`。** 它的信任模型是对的，我们照搬（连 `minisign-verify` 都是同一个 crate）；
但它做不到两件 Rein 需要的事：**Android 自更新**（官方插件在移动端是空实现，而 Rein 是自建 APK 分发）、
**多源择优**（它按 endpoints 顺序取第一个能用的，我们要「两个源都问、取最高版本、逐个显示状态」）。

**服务端不持有私钥。** 签名发生在发布方（本机或 CI），服务端只做「校验 + 存储 + 原样分发」。
它被拿下最坏是拒绝服务，不是投毒。同理，自建源允许走明文 http：安全性来自签名而不是 TLS
（没有域名与证书；要上 TLS 就在前面加 nginx，客户端换个 https 地址即可）。

**几个不显然的决定**：

- `signature` 字段是 `.sig` **文件原文**，不再套 base64。新版 tauri CLI 的 `.sig` 已经是
  `base64(minisign 文本)`，老版本是明文四行 —— 「原样搬运」是唯一在两代之间都正确的做法，
  客户端解析器两种都认（`verify.rs::decode_signature` 先按明文解，失败再解一层 base64）。
- **安装前重验一次**：下载时验过不等于装的时候还是那个文件（磁盘上的东西可以被换）。
  它多花几秒，但那是真正的安全边界。
- **防降级靠 `lastSeenVersion`**：见过 0.3.0 之后再收到 0.2.0 的清单，会标 `downgradeBlocked`
  并提示，而不是安静地降级。
- **通道不符的源直接跳过**：清单里声明了 `channel` 的，与用户所选通道不一致就不参与择优。
- 下载进度走事件（`update://progress`）+ **下载期间 500~700ms 兜底轮询**：WebView 被系统挂起过
  或页面刚挂载时会漏事件，只靠事件会让进度条停住；只靠轮询又会让进度一跳一跳。
- 设置存 `app_meta`（单键 `update_settings_v1`）而不是新表：它是界面级偏好，
  与番茄钟设置同类，进知识库索引反而是污染。

**命令**（三处同步：`modules/update/commands.rs` ↔ `lib.rs` ↔ `services/updateService.ts`）：
`update_status` / `update_settings_set` / `update_check` / `update_download` / `update_cancel` /
`update_discard` / `update_install` / `update_progress` / `update_prune_cache` /
`online_service_status`（Rein 在线服务探测）。

**Android 安装桥**（`gen/android/.../UpdateBridge.kt`，与 `TrackingBridge.kt` 同款手工维护）：
Rust 验签通过 → Kotlin 把包复制进 `cacheDir/rein-update/` → FileProvider 出 `content://` →
`ACTION_VIEW` 交给系统安装器。**为什么要复制**：APK 在 `getDataDir()`，而 FileProvider 的
`<files-path>`/`<cache-path>` 只覆盖各自子树，路径映射不确定；复制到 `cacheDir` 后 URI 的合法性是确定的。
Android 8+ 未授予「安装未知应用」时先跳系统设置页（`REQUEST_INSTALL_PACKAGES`）。

**发布链路**：`scripts/release/` 是本地与 CI 共用的同一份代码（CI 只是环境变量来自 Secrets），
所以「本地能发、CI 发出来不一样」这类事故不会发生。发一版 = 签名 → 组装两套清单
（服务端版 URL 指向自建服务，GitHub 版指向 Release 资产，互为 `mirrors`）→ 推服务端 + 发 Release。
CI 在 tag 上跑（`.github/workflows/release.yml`），Android 缺 keystore secret 时会降级为「只验证可编译」。

**在线模型网关**：服务端实现 OpenAI 兼容的 `/v1/chat/completions`（流式 SSE 透传）、`/v1/models`
与 `/api/v1/ai/usage`。客户端密钥（只存 sha256 摘要）**决定能用哪些模型**：白名单外的模型返回
`403 model_not_allowed`，清单连同官方单价、流量单价一起下发（`rein` 扩展字段），
客户端不需要也不允许手填模型 ID。Agent 侧对应 `modules/ai/online.rs`（设置 / 目录 / 同步 / 对账）
与前端「管理模型 → Rein 在线服务」入口（点开是状态抽屉：地址 / 密钥 / 目录 / **账号调用条件** /
双端对账 / 使用说明）；同步落库的行标记 `source='online'`，
服务端撤下的模型在下次同步时清掉，自己填 key 的模型不受影响。
`rein.client` 里的 `status` / `note`（如「余额不足」「已限流」）原样透出到「调用条件」那一行，
服务端没报时前端按状态码与白名单自己说人话（`stores/onlineService.ts::accountText`）。

**提供商（服务商账号 + 模型目录）**：`modules/ai/providers.rs` + `ai_providers` /
`ai_provider_models`（0040）。真实世界的最小单位是**账号**而不是单个模型：一个提供商 =
适配器 + 接入方式 + 凭据，模型只是这个账号下 `/models` 返回的清单。适配器是 Rust 侧静态注册表
（`ADAPTERS`：火山方舟 / 阿里云百炼 / DeepSeek / 硅基流动 / 自定义 OpenAI 兼容），声明接入方式
（方舟的「模型 API / Agent Plan API」）、默认地址、支持哪几类模型、专属凭据字段（火山语音的
App ID / Access Token）与内置参考目录；前端用 `ai_provider_adapters` 拿它渲染，**不在 TS 里再抄一份**。
目录行分三态来源（`origin`：`api` = 接口拉到、`preset` = 内置参考、`manual` = 手填）：拉取成功时
以接口清单为准清掉过期的 `api` 行、把 `preset` 提升成 `api`，`manual` 行永不被同步清掉；
拉取失败只补参考目录（一次网络抖动不该清空目录）。类别按模型 ID + 接口提示字段推断，
适配器不提供的类别直接丢弃（不能把 `tts-1` 当对话模型列出来）。

**启用 = 写到执行位**（`stores/modelRoles.ts`）：对话/视觉模型 → `ai_models`（`provider` = 适配器 id，
启用后自动探测能力）；识别模型 → 语音配置（适配器映射：火山方舟 → 豆包 WS、百炼 → Qwen WS，
凭据取提供商的 Key / App ID）；向量模型 → 知识库设置（`embeddingMode='cloud'` + 端点 + 模型 + 维度）。
没有中间表，也不存在「启用了但没生效」的中间态 —— 写完那三处，聊天 / 语音 / 检索立刻按新配置跑。

**四个服务模型槽位**（模型页第一张卡）：主 LLM = `ai_models.is_default`（真源即全应用选模读的那一个）；
多模态备选 = 界面偏好 `ai_model_prefs_v1.visionRef`（`auto | off | model:<id>`），由
`stores/models.ts::bestVisionModel()` 消费，**只在主模型没有视觉能力时才可点**（有视觉时这一行暗着并说明）；
ASR / 向量 = 从语音配置与知识库设置**现算**（不另存一份，避免与实配不一致）。
界面偏好还带两条**模型列表渲染声明**：`providerNameDisplay`（模型名前加提供商昵称）与
`providerNameFolder`（按提供商折叠分组），所有模型列表（选择抽屉 / 全部模型 / 提供商目录 / 在线目录）
共用同一条工具栏，开关当场可切并落库。列表一律「页面放摘要、全部另开抽屉」：目录动辄几十条，
在页面里展开会把下方内容一路推下去（DOM 重排 + 丢滚动位置）。

**AI 自管理（按需装载）**：`ai/tools/providers.ts` 与 `models.ts` 同在 `models` 分组（按需装载：
命中「模型 / 密钥 / 提供商 / 向量 / 语音识别 / 方舟 / 百炼」等词或模型自己 `load_tools` 时才挂上）——
`list_providers` / `save_provider` / `fetch_provider_models` / `add_provider_model` /
`remove_provider` / `list_model_roles` / `set_model_role` / `activate_provider_model`。
于是「我拿了火山方舟的 Key，帮我配上并把向量模型换过去」这类请求可以在聊天里一次做完；
密钥一律只回末 4 位（与模型配置工具同一隐私约定）。

**回归**：`node scripts/e2e-model-providers.mjs`（服务模型四槽位 / 渲染声明 / 提供商增改拉启用 / 工具层）；
`node scripts/e2e-online-cost.mjs`（在线服务抽屉与双端对账）。

**成本两端各算一份**：服务端按真实 usage + 真实字节数记账（权威，`logs/ai-usage-*.jsonl` +
`GET /api/v1/ai/usage` 与 `/admin/api/ai/usage`），客户端按同一公式记本机账本
（`ai_usage` 表，纳元整数），UI 并排展示以便对账：模型费 = tokens × 官方页价，
流量费 = 出方向字节 / 1GB × `ai.pricing.traffic.perGb`（默认 0.8 元/GB，只算出方向）。

**回归**：`node scripts/release/e2e.mjs`（47 项：起临时服务端 + 假上游 provider，跑完发布/验签/下载/篡改必拒/Range/回滚/AI 未配置态/模型下发/白名单 403/计价与用量对账）；
Rust 侧 `cargo test --lib update::`（37 项，含**官方 CLI 签名必须验得过**的跨实现互操作夹具）；
`node scripts/e2e-update.mjs`（浏览器 UI：检查 → 下载 → 安装的状态机与更新源开关）。

## 15. 构建产物与首屏预算（2026-09-30）

首屏主包（`dist/assets/index-*.js`）是**唯一阻塞启动**的 JS：Tauri 窗口起来后要先解析它才谈得上渲染。
所以它的体积是架构约束，不是打包口味。三条硬规则，动入口之前先看这一节。

**规则一：桌面端不带内存 mock 后端。** `tauri build` 会在跑 `beforeBuildCommand`（= `npm run build`）
之前注入 `TAURI_ENV_PLATFORM`，`vite.config.ts` 据此把 `@/mock/server` alias 到 `src/mock/disabled.ts`。
理由：mock 是纯浏览器直连用的后端（6800 行实现 + `resources/foods.json` 全量，打包约 1.05 MB），
而 Tauri 里 `transport.isTauri` 恒为真、那条分支永远不可达。替身必须与真实现**同名导出**
（`mockInvoke` / `mockCampus` / `mockVoice`）—— 接口对不上是运行时炸，不是编译期炸。
纯浏览器 `npm run dev` / `npm run preview`（没有该环境变量）不受影响。

**规则二：App 根部的常驻组件不许静态 import AI 栈。** `stores/ai` 一旦静态可达，工具注册表与
全部工具域（约 140 KB）就进了主包。App 根部常驻的有 `SessionOverlay` / `VoiceSessionView` /
三条悬浮条 / `DesktopInspector`，它们对 AI 能力的引用一律写成**函数内的动态 `import()`**：

- `system/voiceRuntime.ts` 的 `aiStore()`（草稿落盘 / 结算一段 / 写入纪要条目三处）；
- `components/voice/VoiceSessionView.vue` 的 `ensureAiStore()`（打开会话视图时预热，
  键盘回退与「最近一条助手回复」用它，未加载时该 computed 返回 null）；
- `App.vue` 的抢课救援 `import('@/utils/campusAi')`。

**规则三：重资产明细按需加载。** 肌群三视图是 160 KB 的解剖 SVG（`?raw` 内联成 JS 字符串），
它只出现在沉浸层 `v-if="activation"` 的卡片与动作详情抽屉里 —— 所以 `SessionOverlay` 用
`defineAsyncComponent` 引入 `MuscleMap` 与 `ExerciseDetailDrawer`，两者都不在开屏路径上。

**实测**（`npm run build`）：

| 产物 | 优化前 | 优化后 |
| --- | --- | --- |
| 首屏 `index-*.js` | 796,947 B | 394,459 B（−50%） |
| mock chunk | 1,052,085 B | 0（Tauri 构建） |
| `dist/` 合计（Tauri） | ≈3.38 MB | 2.34 MB（−31%） |
| 新出现的懒加载 chunk | — | AI 工具注册表 166 KB · MuscleMap 164 KB |

**回归**：`node scripts/e2e-voice.mjs`（语音链路 + 按需 AI store）、`node scripts/e2e-ai-tools.mjs`
（分组装载与功能门禁）、`node scripts/e2e-muscle-map.mjs`（异步之后的肌群图）、
`node scripts/e2e-layout-guard.mjs`（27 条路由的布局不变量）。



## 16. 全局沉浸浮窗与自绘标题栏（2026-10-20）

### 16.1 为什么是「另一扇窗」而不是「把浮条画大」

程序内已经有四条底部浮条（`components/common/FloatDock.vue`）。用户离开应用（桌面失焦 / 最小化、
手机切到别的 App）时，这些浮条随窗口一起消失，而「正在专注」和「正在训练」恰好是**用户不在看这个
应用时最需要看见**的两种状态。所以这一轮不是重画一套 UI，而是把**同一份内容**搬到系统级浮窗：

- **内容同源**：`components/float/*` 是程序内浮条与浮窗共用的内容组件；`components/float/snapshot.ts`
  的构造器把 store 状态压成 `GlobalFloatSnapshot`，程序内浮条与主窗口运行时都读它 —— 文案、按钮顺序、
  色点语义只在构造器里改一次。
- **状态只有一个真源**：主窗口 `system/globalFloat.ts`。浮窗只收快照、只回动作（`GlobalFloatAction`），
  没有任何状态机 —— 不会出现「浮窗说暂停、程序内还在跑」。
- **两端实现不同、协议相同**：桌面 = 第二 Tauri 窗口（`float.html`，transparent + 无边框 + 置顶 +
  不进任务栏）；Android = `SYSTEM_ALERT_WINDOW` 前台服务 + `WindowManager` 原生浮层（Kotlin 用原生
  视图重建同一套排版，玻璃与字体按系统能力近似）。协议是 8 条命令 + 2 个事件（见 docs/GLOBAL-FLOAT.md §5）。
- **显示时机**：只在「有沉浸会话 + 应用不在前台」时出现，回到应用即收起 —— 浮窗与程序内浮条**永不并存**。
  用户点关闭后本次失焦期不再弹（主窗口回焦后解除）。

### 16.2 降级

全局浮窗是**叠加能力**，任何一步失败都退回现有行为（程序内浮条），判断只看 `global_float_status()`：
浏览器预览 `supported=false`、Android 未授权 `permitted=false`、桌面建窗失败 `supported=false`。
计时 / 落库 / 程序内浮条都不经过这条链路，所以降级没有数据风险。

### 16.3 自绘标题栏

`decorations: false` 之后原生标题栏与缩放边框一起消失，两件事都要由前端补回来：

- `components/layout/TitleBarBase.vue` 是唯一外壳（高度 `--titlebar-h`，整条 `data-tauri-drag-region`）；
  `AppTitleBar`（主窗口：品牌 + 最小化 / 最大化 / 关闭）与 `FloatTitleBar`（浮窗：会话标题 + 泊车 / 关闭）
  共用它；窗口按钮视觉落在 base.css 的 `.wbtn` / `.wbtn-danger`（scoped 样式够不到 slot 内容，
  这是唯一一块非局部样式）。
- **双击最大化**：Tauri 2.11 注入的 drag.js 已在第二次 mousedown 上自己切一次；组件若再监听 dblclick
  就会切两次（窗口闪一下回原状）。所以 TitleBarBase 在第二次 mousedown 前把拖拽属性临时摘掉，
  双击只由组件切一次。
- **八向缩放**：`WindowResizeHandles`（6px 隐形热区）→ `startResizeDragging(direction)`。
- 只在「Tauri 且非 Android」渲染：浏览器预览与手机保持原样，既有 e2e 的布局断言不受影响。

### 16.4 验证

- `scripts/e2e-global-float.mjs`：mock 降级 + 真机（WebView2 CDP）标题栏 DOM、窗口 ex-style、
  浮窗出现 / 隐藏 / 动作回灌。
- 真机开调试端口的坑见 docs/GLOBAL-FLOAT.md §10 末尾：wry 总是显式设置 WebView2 的
  `AdditionalBrowserArguments`，环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGS` 不生效，
  必须用 `tauri dev --config <临时配置>` 合并 `additionalBrowserArgs`。
