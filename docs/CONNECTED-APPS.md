# 连接本机应用（connected_apps）

> 状态：已落地（2026-11-10）。范围：`src/config/connectedApps.ts` 的 17 条原生应用
> （Android 8 / Windows 5 / Mac 2 / Linux 2）+ 既有 health 路由入口；health 仍走
> `health_sync_*`，不由本域接管。
>
> 一句话边界：**Rein 只在本机执行、只读写用户明确连接并授权的范围；连接同意、AI 使用、
> 写入许可三者分离；每个写操作逐次确认并落审计。** 系统没有写接口的能力（使用时间 / 位置）
> 保持只读，不补假能力。

---

## 1. 组成与职责

| 层 | 文件 | 职责 |
|---|---|---|
| Rust 契约 | `src-tauri/src/modules/connected_apps/{mod,models,commands,state,store}.rs` | 四个 Tauri 命令、17 条 `APP_SPECS`、`connected/aiEnabled/writeAllowed` 公式、`app_meta` 持久化 |
| Rust Android | `src-tauri/src/modules/connected_apps/android.rs` | JNI 调用、`cacheDir/connected_apps/*.json` 文件协议、轮询与超时、SAF revoke |
| Rust 桌面 | `{desktop,paths,fs_ops,term_ops}.rs` | 根表、相对路径校验、文件读写/建目录/删除/重命名、argv 进程执行 |
| Rust 分发 | `apps/{mod,alarm,usage,calendar,contacts,phone_files,location,notification,sms,desktop_files,terminal}.rs` | app id → handler 的固定 match；Android 参数先做与 Kotlin 同口径的校验 |
| TS 契约 | `src/types/connectedApps.ts`、`src/services/connectedAppService.ts` | 类型与四个 `invoke('connected_app_*')` |
| TS 状态 | `src/stores/connectedApps.ts` | `statuses`、`aiEnabledAppIds()`、连接/AI/写/根、旧 localStorage 键一次性清理 |
| TS 界面 | `src/pages/ConnectedAppsPage.vue`、`src/components/settings/ConnectedAppSheet.vue`、`ToolConfirmSheet.vue` | 平台页签 + 真实状态 pill、详情抽屉、写操作确认层 |
| TS 工具 | `src/ai/tools/app*.ts`、`src/ai/tools/connectedApps.ts`、`src/ai/connectedAppsPrompt.ts` | 44 个 app 工具、门禁/确认/审计 helper、按组提示词 |
| Mock | `src/mock/connectedApps/*` | 与 Rust 同公式的样例状态、读写样例、`__REIN_MOCK_APP_AUDIT__` 钩子 |
| Android 原生 | `src-tauri/gen/android/app/src/main/java/com/gozaoo/rein/ConnectedAppsBridge.kt`、`connectedapps/*.kt` | JNI 入口、launcher、8 个 Ops、通知监听服务 |

四个命令**不是 AI 工具**：AI 工具只经 `connected_app_invoke` 调 native；`__audit` 是
`invoke` 的保留方法，只记拒绝审计，不执行能力。

---

## 2. 四个命令

| 命令 | 调用方 | 作用 | 返回 |
|---|---|---|---|
| `connected_app_status` | 页面 / store / AI helper | 17 个原生 app 的状态快照（不含 health） | `ConnectedAppsSnapshot` |
| `connected_app_request` | 仅 UI | 拉起运行时权限 / 特殊权限设置 / SAF / 文件夹选择器 | `{app, mode, opened, reason?, root?}` |
| `connected_app_invoke` | `connectedAppService.call`（AI 工具） | 按 `app + method` 执行真实能力 | `{ok, app, method, data?, error?, meta?}` |
| `connected_app_update` | 仅 UI | 记录连接同意 / AI 开关 / 写许可 / `win-local` 根 | `ConnectedAppStatus` |

- TS 封装：`src/services/connectedAppService.ts`（`status/request/call/setEnabled/update`）。
- mock：`src/mock/server.ts` 顶层四个 `case 'connected_app_*'`，转调
  `src/mock/connectedApps/index.ts`。
- 可预期失败（未连接、未允许 AI、未允许写入、缺权限、无根、参数非法、超时、越界、
  用户拒绝）一律 `Ok({ok:false,error})`；只有 DB / 序列化 / 线程 panic 才 `Err`。
- 三向同步由 `scripts/check-ipc-contract.mjs` 检查：Rust `generate_handler!`、
  `src/services/*.ts` 的字面量 `invoke('...')`、`src/mock/server.ts` 顶层 case。

### 2.1 状态公式

```
connected   = enabled && supported && availability ∉ {unsupported, unavailable, unknown}
              && 必需权限全 granted && (文件类 roots 非空)
aiEnabled   = enabled && connected && settings.aiEnabled      // AI 使用意图
writeAllowed= enabled && connected && settings.writeAllowed    // 写入意图
              && nativeWriteReady                              // 系统写权限/可写根/shell
```

- `settings` 持久化在 SQLite `app_meta`（键 `connected_apps.ai.<app>` /
  `connected_apps.write.<app>`、`connected_apps.local_roots`；行为等价于一份 settings JSON）。
- 断开连接（`enabled=false`）会清 AI / 写意图；Android `filesystem` 释放 SAF 持久授权，
  `win-local` 清根，终端杀掉仍在运行的进程树。运行时权限**不能**被静默撤销，UI 明说
  「系统权限仍保留，可在系统设置撤销」。
- `writeAllowed` 是**有效值**：只存意图但没拿到系统写权限时仍为 false，写工具会被 Rust
  拒绝，不会出现「开关已开但写不进去」的假成功。

---

## 3. 能力矩阵（读 / 写）

> 「确认」列指工具层的 `askToolConfirm`；写许可（`writeAllowed`）对所有写方法都必需，
> 与是否弹确认无关。工具组默认不可见，只有该 app 已连接且允许 AI 后才可 `load_tools`。

| app | 平台 | 读/写 | 关键权限 | native 方法 | 工具组 | 确认 | 状态 |
|---|---|---|---|---|---|---|---|
| `alarm` | Android | 读 1 / 写 4 | `clock_app`；写 `clock_write`（consent） | `alarm_next` / `set_alarm`、`set_timer`、`dismiss_alarm`、`dismiss_timer` | `appAlarm`（5） | 仅取消两个 | 已实现；真机待验 |
| `usage` | Android | 只读 2 | `usage_access`（AppOps 特殊权限） | `get_app_usage`、`get_usage_events` | `appUsage`（2） | 否 | 已实现；OEM 可能空数据 |
| `calendar` | Android | 读 3 / 写 3 | `READ_CALENDAR`；写 `WRITE_CALENDAR` | `list_calendars`、`list_calendar_events`、`get_calendar_event`、`create/update/delete_calendar_event` | `appCalendar`（6） | 3 个写 | 已实现；真机待验 |
| `contacts` | Android | 读 2 / 写 3 | `READ_CONTACTS`；写 `WRITE_CONTACTS` | `search_contacts`、`get_contact`、`create/update/delete_contact` | `appContacts`（5） | 3 个写 | 已实现；真机待验 |
| `filesystem` | Android | 读 4 / 写 4 | SAF 持久树（读/写） | `files_roots`、`files_list`、`read_phone_file`、`search_phone_files`、`write_phone_file`、`create_phone_folder`、`delete_phone_file`、`rename_phone_file` | `appPhoneFiles`（8） | 4 个写 | 已实现；真机待验 |
| `location` | Android | 只读 2 | `ACCESS_FINE/COARSE_LOCATION` | `get_current_location`、`get_last_known_location` | `appLocation`（2） | 否 | 已实现；不反查地址 |
| `notification` | Android | 读 1 / 写 2 | 通知使用权；写 `notification_dismiss` | `list_recent_notifications`、`dismiss_notification`、`dismiss_all_notifications` | `appNotification`（3） | 2 个清除 | 已实现；只能清除 |
| `sms` | Android | 读 3 / 写 1 | `READ_SMS`；写 `SEND_SMS` | `list_sms_threads`、`list_sms_messages`、`search_sms`、`send_sms` | `appSms`（4） | 发送 | 已实现；只发送 |
| `win-desktop` | Windows | 读 4 / 写 4 | 目录存在可读；固定根 | `files_roots`、`files_list`、`read_desktop_file`、`search_desktop_files`、`write_desktop_file`、`create_desktop_folder`、`delete_desktop_file`、`rename_desktop_file` | `appDesktopFiles`（8，共享） | 4 个写 | 已实现；Windows host 单测 |
| `win-documents` | Windows | 读 4 / 写 4 | 同上 | 同上（`document_dir()`） | `appDesktopFiles` | 4 个写 | 已实现 |
| `win-downloads` | Windows | 读 4 / 写 4 | 同上 | 同上（`download_dir()`） | `appDesktopFiles` | 4 个写 | 已实现 |
| `win-local` | Windows | 读 4 / 写 4 | `rfd` 选择器 / 手动根（≤5） | 同上 | `appDesktopFiles` | 4 个写 | 已实现；根有包含/去重/上限 |
| `win-terminal` | Windows | 执行 1 | `shell`；写 `terminal_exec` | `run_terminal_command` | `appTerminal`（1） | 每次 | 已实现；Windows host 单测 |
| `mac-desktop` | Mac | 读 4 / 写 4 | 目录存在可读 | 同桌面文件 | `appDesktopFiles` | 4 个写 | **未在本机验证** |
| `mac-terminal` | Mac | 执行 1 | `shell` | `run_terminal_command` | `appTerminal` | 每次 | **未在本机验证** |
| `linux-desktop` | Linux | 读 4 / 写 4 | 目录存在可读 | 同桌面文件 | `appDesktopFiles` | 4 个写 | **未在本机验证** |
| `linux-documents` | Linux | 读 4 / 写 4 | 目录存在可读 | 同桌面文件 | `appDesktopFiles` | 4 个写 | **未在本机验证** |
| `health` | Android | 读 / 回写 | Health Connect | `health_sync_*`（既有） | 无 AI 组 | 由 HC 自己授权 | 不改既有行为 |

- 10 个 AI 组，共 44 个工具：`appAlarm` 5、`appUsage` 2、`appCalendar` 6、`appContacts` 5、
  `appPhoneFiles` 8、`appLocation` 2、`appNotification` 3、`appSms` 4、`appDesktopFiles` 8、
  `appTerminal` 1。
- `appDesktopFiles` 是 7 个桌面文件 app 共享组；`appTerminal` 是 Windows / Mac 两个终端
  共享组。共享组由 `root` id 前缀 `<appId>:<rootId>` 路由，TS 只把前缀当路由提示，
  Rust 按该 app 的根表重新解析；**任何 `PathBuf::from(payload.root)` 都不存在**。
- 工具名与 native method 多数同名；两个根工具例外：`list_phone_roots` → `files_roots`
  （app=`filesystem`），`list_desktop_roots` → 对每个已连接+允许 AI 的桌面文件 app 调
  `files_roots` 后合并，并**剥离绝对路径**（只给模型 `id/label/writable`）。

---

## 4. 写回：确认 / 审计 / 上限

### 4.1 工具与确认（20 个）

| app | 写工具 | 确认 |
|---|---|---|
| 闹钟 | `dismiss_alarm`、`dismiss_timer` | 是 |
| 日历 | `create_calendar_event`、`update_calendar_event`、`delete_calendar_event` | 是 |
| 通讯录 | `create_contact`、`update_contact`、`delete_contact` | 是 |
| 短信 | `send_sms` | 是 |
| 通知 | `dismiss_notification`、`dismiss_all_notifications` | 是 |
| 手机文件 | `write_phone_file`、`create_phone_folder`、`delete_phone_file`、`rename_phone_file` | 是 |
| 桌面文件 | `write_desktop_file`、`create_desktop_folder`、`delete_desktop_file`、`rename_desktop_file` | 是 |
| 终端 | `run_terminal_command` | 每次 |

- `set_alarm` / `set_timer` 是写（需 `writeAllowed` + 审计），但按产品选择**不弹确认**；
  `skipUi` 默认 true，部分 OEM 时钟 app 仍可能弹出界面，结果只承诺「已向系统时钟发出请求」。
- 工具定义上的 `dangerous: true` 只是过程卡红标，**不是确认触发器**。确认只在 app 工具的
  `execute` 里显式 `askToolConfirm`；仓库既有 13 个非 app 的 `dangerous` 工具行为不变。
- 确认顺序：先 `assertAppReady({write:true})`（本地查 `enabled/connected/aiEnabled/writeAllowed`），
  再弹确认；用户拒绝 → 不调 native → 前端 `__audit` 记 `denied` → 抛
  `connected_app_user_denied`。确认层 60s 未选择、关闭、Esc、页面转后台都按拒绝。
- 确认文案必须让用户看清：终端 program/args/cwd/timeout；日历动作/标题/起止/重复系列警告；
  通讯录动作/姓名/电话邮箱/删除同步警告；短信收件人/正文前 200 字/费用与不可撤回警告；
  通知应用或「全部通知」/不可恢复；文件动作/root 标签 + 相对路径/覆盖或删除警告；闹钟取消模式。

### 4.2 审计

- 文件：`db::data_dir(app)/connected_apps/audit.jsonl`（Android 为应用私有数据目录；
  `REIN_DATA_DIR` 隔离）。
- 记录字段：`at`、`app`、`method`、`kind`（read/write/control）、`ok`、`code`、`decision`
  （allowed/denied/error）、`durationMs`、`summary`（≤300）。
- 落盘范围：`connected_app_invoke` **进入执行层后**写一行（成功与执行失败都写）；
  前置门禁（未连接 / 未允许 AI / 未允许写入）也写一行 `decision:"denied"`，`summary`
  只记 `gate=<code>`；用户拒绝由 TS 调 `__audit` 落 `denied`；TS `assertAppReady`
  的本地门禁失败同样尽力写 `__audit`。`connected_app_request` 写一行；
  `connected_app_update` 成功时写一行（失败返回 `Err`，不落审计）。
- 脱敏：`audit::redact` 是结构化 payload 的通用脱敏函数（键名匹配
  `api[-_]?key|token|secret|password|passwd|authorization|bearer` 的值替换 `***`），
  当前主要由单测覆盖；实际摘要由调用方构造——短信/通讯录/通知不记正文、号码、标题；
  位置不记经纬度；文件只记 root id + 相对路径/计数；终端参数走 `term_ops::redact_args`
  （敏感键的下一个参数、`KEY=value`、`Authorization: Bearer x`）。
- 审计单文件 1MB；追加前超限则 `audit.jsonl` → `audit.1.jsonl`（覆盖旧备份），总占用 ≤2MB；
- 写失败不阻断能力（log 到 stderr），但风险清单里注明。

### 4.3 结果上限

| 能力 | 上限 |
|---|---|
| 日历查询 | 366 天、200 条；列表描述预览 200；单条描述 2000 |
| 日历写入 | 标题 200、描述 2000、地点 200、单次日程 ≤30 天 |
| 通讯录 | query 1..64、50 人、每人 5 号 + 5 邮箱；姓名 200 |
| 短信 | threads 50、messages 100、列表 body 500；发送 body 2000、单收件人 |
| 通知 | 列表 50、title/text 500；缓存 200 条 / 256KB |
| 使用时间 | 31 天、50 app；事件 7 天 / 200 条 |
| 位置 | 一次、15s 超时（默认 8s） |
| 文件列表 | 200 条 |
| 文件读取 | 1MB；工具层默认 20k 字符 / 上限 50k，带 `nextOffset` |
| 文件搜索 | 深度 4、扫描 5000（手机 2000）、结果 50 |
| 文件写入 | 1MB |
| 终端 | args 64 / 单参 4096 / 总长 16384；超时默认 30s、上限 90s；stdout/stderr 各 64KB |
| IPC payload | 2MB；Android 结果文件 >4MB 视为异常 |
| 审计 | 1MB/文件、保留 1 份 |

---

## 5. 系统只读边界（不补假能力）

- `usage`：系统 API 只读；只有 `get_app_usage` / `get_usage_events`。OEM 可能返回空数据，
  空结果只代表读不到，不代表没有使用。
- `location`：系统 API 只读；只返回 lat/lng/accuracy/time/provider，**不反地理编码、不记录轨迹**。
- `notification`：只能读 + 清除；`ongoing`/系统常驻/自身包会跳过；**不能代发、回复或修改通知内容**。
- `sms`：只能读 + 发送；**不标记已读、不删除会话、不读 MMS**；发送返回 `submitted + parts`，
  **不承诺送达**；双卡 / SIM 选择 / 送达回执未实现。
- `alarm`：Android 没有公开 API 列出全部闹钟；只能读「下一个」+ 设置/取消。
- `health`：保持既有 `health_sync` 读 + `health_sync_set_push` 回写，本次不改、不加 health AI 工具。
- iOS：没有构建目标，不加任何 app 行 / native / 工具组。

---

## 6. AI 挂载流程

1. 用户在「连接应用 → 某个 app」点连接，`connected_app_update({enabled:true})` 记录同意；
   需要系统权限/文件夹时 `connected_app_request` 拉起系统 UI。
2. 连接成功后打开「允许 AI 使用」→ `connected_app_update({aiEnabled:true})`（要求 connected）。
3. store 的 `aiEnabledAppIds()` 是唯一门禁入口，固定返回
   `statuses.filter(s => s.aiEnabled).map(s => s.app)`；`stores/ai.ts` 发送前
   `await ensureLoaded()`，并把 `apps` 传给 `resolveToolPlan` 与 `buildAgentToolsForGroups`。
4. `GROUP_POLICY` 里 10 个 app 组都声明了 `apps`，**没有 keywords**；缺省不传 `apps`
   时 app 组既不在 `loaded` 也不在 `available`（安全默认）。
5. 模型看到【工具装载】目录里的 app 组后，调 `load_tools` 显式装载；一次最多 4 组。
   `load_tools` 只接受 `ctx.loadable`（已装载 ∪ 可装载）里的组；不带 ctx 的旧直调里
   app 组一律 `blocked(reason:'app_unavailable')`。
6. 工具执行统一走 `callConnectedApp`：`ok:false` 一律抛 `ConnectedAppToolError`，不假成功；
   写工具走 `callConnectedAppWrite`（本地写许可 → 确认 → 拒绝审计 → native）。
7. `src/ai/connectedAppsPrompt.ts` 只对**已装载**的 app 组注入段落：权限失败不要重试、
   写操作确认后不换参重试、文件路径相对 root、隐私与能力边界。`chat.ts` 把它作为
   `buildChatSystemPrompt` 的第 6 个可选参数（在 `cardState` 之后）插入，没有 app 组时为空串。
8. 浏览器 mock 的所有结果带 `meta.mock=true`；页面横幅与工具结果标注「样例数据」。
   终端 mock 只模拟 `echo/pwd/hostname/whoami/ls`，其它程序返回
   `connected_app_mock_unavailable`，不冒充本机执行。

---

## 7. 权限教程（抽屉内文案）

- **使用时间**：Android 不会弹权限框。点「去开启」后在系统列表里找到 Rein，打开
  「使用情况访问权限」。
- **通知**：点「去开启」后在「通知使用权」里允许 Rein；只能读开启之后收到的通知，
  之前的读不到。清除通知需要单独打开「允许清除通知」。
- **短信 / 通讯录 / 日历 / 位置**：点「去授权」后在系统弹窗选择允许；如果之前选过
  「不再询问」，到系统设置 → 应用 → Rein → 权限里开启。
- **文件**：选择一个文件夹；Rein 只能读写该文件夹及子文件夹，不能越过根。可随时断开。
- **终端**：命令以你的用户身份运行，能访问你有权限的任何文件；Rein 不能沙箱隔离。
  每次执行都会显示完整命令并单独确认，并写入审计日志。
- **闹钟**：Android 没有公开的闹钟读取接口；只能读「下一个闹钟」和设置/取消，不能列出全部。
- **日历**：查询只读；新建/修改/删除前弹确认。重复日程的修改/删除作用于整个系列。
- **通讯录**：写操作逐次确认；删除会同步到已登录账户；云端账户可能改不动。
- **短信**：只能读取和发送；不会标记已读或删除。发送前确认收件人和正文，可能产生运营商费用。
- **桌面文件**：只能读写你选中的文件夹；删除只支持单文件或空目录，不进回收站。
- **隐私**：允许 AI 使用后，相关数据会发送给你配置的模型服务商；审计只记操作摘要，
  不记正文/号码/通知内容。

---

## 8. 桌面沙箱与命令执行安全

### 8.1 文件路径

1. 只接受相对 `path`（拒绝绝对路径、盘符、UNC、NUL、`..` 段；长度 ≤512）。
   Windows 额外拒绝：保留设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9，含带扩展名）、
   组件结尾的 `.` 或空格、组件里的 `:`（ADS）、控制字符（0x00..0x1F）。
2. `root = canonicalize(root)`；`candidate = canonicalize(root.join(path))`；
   **用 `Path::starts_with` 做组件级包含判断，禁止字符串前缀比较**
   （`C:/data2/x` 不能被判成在 `C:/data` 内）。
3. `symlink_metadata` 检查最终节点；符号链接 / Windows 重解析点不跟随、不读、不写、不列内容。
4. 读取：`take(maxBytes+1)`；>1MB → `too_large`；UTF-8 失败或前 8KB 含 NUL → `not_text`。
5. 写入：父目录必须存在且在根内；`overwrite:false` 用
   `OpenOptions::create_new(true)` 保护最终路径（已存在 → `exists`）；`overwrite:true`
   用同目录临时文件 + rename；内容 ≤1MB。
6. 删除：只删单文件或空目录；非空 → `not_empty`；不递归。
7. 建目录：`create_dir_all` 逐段创建；已存在目录跳过；遇同名文件 → `exists`；
   每段都做 canonicalize / 根包含 / 不跟随链接。
8. 重命名：同根同目录；目标不存在（否则 `exists`）；不跨根。
9. 根集合：系统目录每个 app 一个固定根；`win-local` ≤5 个，拒绝盘符根、用户主目录本身
   及其祖先（防止一键授权整个用户目录）；新根包含旧根则替换旧根，被旧根包含则 no-op。
10. `root` 是 **opaque id**，不是路径：固定目录由 `AppSpec` 映射到
    `desktop_dir()` / `document_dir()` 等；`win-local` 查 `app_meta` 根表；Android 查
    Kotlin SAF 树表。`ConnectedAppRoot.path` 只给 UI；`list_desktop_roots` 给模型前剥离。
11. 残余风险：`canonicalize` 与 `open` 之间存在 TOCTOU；写入场景风险更高；不引入 `cap-std`。

### 8.2 命令执行

- `program`：裸可执行名（1..128，不含 `/`、`\`、`:`、空白、NUL、shell 元字符）——
  **不接受绝对/相对路径**；拒绝提权程序 `sudo/su/doas/runas/gsudo/pkexec`，拒绝
  `cmd/wscript/cscript/mshta` 与脚本/安装包扩展名（`.bat/.cmd/.ps1/.vbs/.js/...`）。
  `powershell/pwsh/bash/sh` 只允许 `-File <允许目录内脚本>` / 脚本路径，禁止
  `-Command` / `-c` / `-EncodedCommand`。`env` 也在拒绝表里：`env sudo ...` /
  `env sh -c ...` 会绕过上面的提权与 `-c` 检查。
- `args`：字符串数组，≤64 个、单个 ≤4096、总长 ≤16384；原样传给 `Command::arg`，
  不做 shell 解析，Rein 不拼 shell 字符串。
- `cwd`：省略 = `std::env::temp_dir()/rein-terminal`（自动创建；不用数据目录，
  避免一条已确认的 `rm -rf ..` 删到 Rein 的数据库/审计）；支持别名
  `sandbox/desktop/documents/downloads`；绝对路径 canonicalize 后必须在 sandbox / desktop /
  documents / downloads / `win-local` 根内；用户主目录本身不在白名单里。
- **`cwd` 只是起始目录，不是沙箱**：命令仍可访问用户有权限的任何路径。真正的闸门是
  「每次确认 + argv 无 Rein 拼接 + 拒绝提权程序 + 审计」。
- 环境：`env_clear()` + 白名单（Windows：PATH/PATHEXT/SystemRoot/SystemDrive/TEMP/TMP/
  USERPROFILE/HOMEDRIVE/HOMEPATH/APPDATA/LOCALAPPDATA/NUMBER_OF_PROCESSORS/OS/
  PROCESSOR_ARCHITECTURE；Unix：PATH/HOME/USER/LOGNAME/TMPDIR/LANG/LC_ALL/TERM/TZ）。
  不传任何 `*_API_KEY` / `TOKEN` / `SECRET` / `PASSWORD` / `AUTH` / `REIN_*`。
- 进程：stdin=null；stdout/stderr piped；Windows `CREATE_NO_WINDOW`；Unix `process_group(0)`。
- 超时：默认 30s，上限 **90s**；超时杀进程树：Windows `taskkill /PID <pid> /T /F`
  （失败回退 `child.kill()`），Unix `libc::kill(-pgid, SIGTERM)` → 1s 后 `SIGKILL`。
- 输出：stdout/stderr 各 ≤64KB（继续排空管道但不保留），带 `truncated` 与
  `…[输出已截断]`；`from_utf8_lossy`（Windows GBK 输出可能乱码）。
- 并发：允许并行调用；`ACTIVE_PIDS` 记录运行中的 pid；断开终端时全部杀掉。不申请提权，
  不调用 UAC/runas，不写系统目录。
- 工具桥超时：`TOOL_RESULT_TIMEOUT` 覆盖「确认 60s + 命令 90s + 余量」；当前
  `src-tauri/src/modules/ai/agent/commands.rs` 为 **180s**。

### 8.3 服务端 URL 约束

本次**不新增任何服务端联网抓取 / HTTP 请求**；`connected_app_*` 只读本机数据、执行本机程序，
`location` 不反地理编码。未来若加联网能力，必须：只允许 `http/https`；发请求前解析并校验
host，拒绝 `localhost`、环回、私有（10/8、172.16/12、192.168/16、169.254/16、fc00::/7 等）
和保留地址。

终端是唯一例外：`run_terminal_command` 以用户身份执行任意 argv，模型可以 `curl
http://127.0.0.1/...`。这不是 Rein 服务端在抓取；确认层显示完整命令、用户逐次授权。
如果验收把「任何 AI 触发的出站请求」都算进 URL 约束，终端无法用 host 白名单满足，
只能显式豁免终端或禁用终端里的联网程序——本实现选择「显式豁免 + 逐次确认 + 审计」，
不假装终端受 URL 白名单保护。

---

## 9. Android 桥与系统集成

### 9.1 文件协议

`cacheDir/connected_apps/`（Tauri `app_cache_dir()` 即 Android `cacheDir`）：

```
connected_apps/
  state.json                    // Kotlin 写：8 个 Android app 的原生事实
  requests/<requestId>.json     // Rust 写：{app, method, payload, expiresAt}
  results/<requestId>.json      // Kotlin 写：{ok, data} 或 {ok:false, error}
  notifications.json            // NotificationListenerService 写：最近通知（有界缓存）
```

- `requestId` 用 UUID；每次调用先删同 id 结果文件，再写请求（tmp + rename），再 JNI `invoke`。
- Kotlin 原子写（`.tmp` → rename）；Rust 解析失败按「还没好」重试。
- Rust 轮询 50ms；超时按方法：普通查询 15s、文件搜索 25s、位置 20s；结果文件只由 Kotlin 写，
  请求文件只由 Rust 写；>4MB 结果拒绝读取。
- Rust 优先通过 JNI `status(context, "*")` 触发 Kotlin 后台 refresh 并取状态 JSON；JNI 不可用时
  回退读 `state.json`。`state.json` 每次 refresh 自增 `generation` + 写 `updatedAt`（Kotlin 侧）；
  Rust 记录调用前的 generation/mtime，再最多轮询 10 × 50ms（500ms）等本轮写盘完成。
  没前进时返回旧状态并置 `refreshing:true`，不再把上一轮数据当最新。真机刷新时序仍需复核。
- Kotlin 不写 `enabled/aiEnabled/writeAllowed`，这些由 Rust 合并。
- 首次没有 `state.json` / 空 `apps` → `availability:'unknown'`、`refreshing:true`；页面在
  Android 上只自动重试一次（300ms），仍未知就停在「检测中」+「重新检测」，不无限轮询，
  也不冒充「未连接」。

### 9.2 JNI 与注册

`com.gozaoo.rein.ConnectedAppsBridge` 全部 `@JvmStatic`：

| 方法 | 说明 |
|---|---|
| `refresh(Context)` | 后台重算 8 个 Android app 的原生事实，写 `state.json` |
| `request(Context, String): String` | 主线程拉起权限/设置/SAF，返回 `{opened, reason}` |
| `invoke(Context, String)` | 入参 requestId；读请求文件，IO 线程分发，写结果文件 |
| `revoke(Context, String)` | `filesystem` 释放全部 SAF 持久 URI 权限并清树；`notification` 清缓存 |

- `MainActivity.onCreate` 在 `TrackingBridge.register` / `HealthRateBridge.register` 之后
  `ConnectedAppsBridge.register(this)`；`onResume` 调 `refresh(this)`。
- `register` 注册 `RequestMultiplePermissions` 与 `OpenDocumentTree`；SAF 回调
  `takePersistableUriPermission(READ|WRITE)`、释放旧树、存 `SharedPreferences("rein_connected_apps")`
  （键 `saf_tree`）。
- `ReinNotificationListenerService`：`onListenerConnected` 设置静态 instance；
  `onNotificationPosted` 跳过自身包/group summary、字段截断 500、内存 ring ≤200 条 / ≤256KB、
  1s 防抖写 `notifications.json`；`onNotificationRemoved` 只标记 `active=false`。
- `PermissionMap` 是 app → 运行时权限 / 特殊设置 / SAF 的唯一映射，`status` 与 `request` 共用。
- Manifest 权限：`READ/WRITE_CALENDAR`、`READ/WRITE_CONTACTS`、`READ_SMS`、`SEND_SMS`、
  `com.android.alarm.permission.SET_ALARM`、`PACKAGE_USAGE_STATS`（`tools:ignore`）；
  `<queries>` 声明六条闹钟 intent（SET/DISMISS/SHOW）+ launcher；`<service>` 声明通知监听
  （`BIND_NOTIFICATION_LISTENER_SERVICE`）。
  不申请 `READ_EXTERNAL_STORAGE` / `MANAGE_EXTERNAL_STORAGE` / `SCHEDULE_EXACT_ALARM` /
  `QUERY_ALL_PACKAGES`；文件走 SAF，闹钟走系统 Clock intent。
- ProGuard / R8：`src-tauri/gen/android/app/proguard-rules.pro` 的
  `-keep class com.gozaoo.rein.ConnectedAppsBridge { *; }` 与
  `-keep class com.gozaoo.rein.connectedapps.** { *; }`。Rust 经 JNI 按类名/方法名调用，
  静态分析看不到引用；漏掉 = release 包 `NoSuchMethodError` 闪退。
- API level 守卫（minSdk 24）：`ACTION_DISMISS_TIMER` 26+、`getCurrentLocation` 30+、
  `unsafeCheckOpNoThrow` 29+、`UsageEvents.ACTIVITY_RESUMED/PAUSED` 29+；低版本走回退或
  `connected_app_unsupported`。

---

## 10. 错误码

| code | 含义 | action |
|---|---|---|
| `connected_app_unsupported` | 当前平台/OS 不支持 | 无 |
| `connected_app_unavailable` | 系统能力缺失（无时钟/日历 provider/目录/短信硬件/shell） | 无 |
| `connected_app_not_connected` | 未连接/必需权限未齐 | `permissions` / `usage_access` / `notification_access` / `folder` |
| `connected_app_ai_disabled` | 未允许 AI 使用 | 无（让用户去开） |
| `connected_app_write_not_allowed` | 未允许写入 / 无可写根 | 无（让用户去开） |
| `connected_app_permission_denied` | 缺必需/写权限 | `permissions` / `permissions_write` / `settings` |
| `connected_app_no_root` | 文件类没有可用根 | `folder` |
| `connected_app_path_denied` | 路径越界/绝对路径/`..`/符号链接逃逸/非法 program | 无 |
| `connected_app_not_found` | 文件/联系人/事件/消息/通知不存在 | 无 |
| `connected_app_exists` | 目标已存在（不覆盖 / rename 目标存在 / 建目录遇同名文件） | 要覆盖请显式 `overwrite:true` |
| `connected_app_not_text` | 文件不是可读文本 | 无 |
| `connected_app_not_empty` | 目录非空 | 先清空 |
| `connected_app_too_large` | 文件/结果超过上限 | 无 |
| `connected_app_bad_request` | payload 非法/超长/日期格式错/参数越界 | 无 |
| `connected_app_timeout` | 原生桥/进程超时 | 可重试一次 |
| `connected_app_unknown_method` | app 不认这个方法 | 无 |
| `connected_app_no_writable_calendar` | 没有可写日历 | 让用户加账户 |
| `connected_app_listener_not_connected` | 通知监听未连上 | `notification_access` |
| `connected_app_user_denied` | 用户拒绝确认（TS 侧） | 无 |
| `connected_app_bridge_error` | 原生桥/状态文件/JNI 失败 | 刷新/重开 |
| `connected_app_native_error` | 原生内部异常 | 无 |
| `connected_app_mock_unavailable` | 浏览器 mock 不能模拟该操作 | 无 |

所有 message 中文、可直接给模型/用户看；AI helper 把 `action` 翻成
「请让用户打开『连接应用 → X』并点『去授权 / 允许写入』」。

---

## 11. 平台验证状态（必须如实阅读）

| 平台 | 状态 |
|---|---|
| Windows | 文件引擎 / 终端 / 根表 / 审计均有 host 单测；`cargo test --lib connected_apps` 通过。 |
| Android | Rust `cargo check --lib --target aarch64-linux-android` 通过（本次修复后）；Kotlin 代码已按 Ops 分文件实现，但**本次改动后未重跑 `./gradlew :app:compileUniversalDebugKotlin`，也未做真机 debug/release(R8) 验证**：权限拒绝/撤销、SAF 持久树、通知监听、短信/日历/通讯录、闹钟 intent、`connected_app_status` 的 generation 刷新时序均需设备复核。 |
| Mac | **未在本机验证**（无 Mac 构建条件）：`mac-desktop` / `mac-terminal` 的 `cfg(unix)` 分支未编译、未运行。 |
| Linux | **未在本机验证**：`linux-desktop` / `linux-documents` 未编译、未运行。 |
| iOS | **未支持**：没有 iOS 构建目标；页面只保留说明，不加任何 app 行 / native / 工具组。 |

其他未验证 / 边界：

- **终端不是沙箱**：见 §8.2；这是能力边界，不是实现遗漏。
- **闹钟不能列出全部**：Android 公开 API 不支持；只能读「下一个」+ 设置/取消。
- **通知清除**：只能清可清除的；ongoing/系统常驻会跳过；不能代发/回复。
- **短信**：只读 Inbox/Sent + 发送；不做已读/删除/MMS/双卡/SIM 选择/送达回执。
  注意：plan §1.2 明确提供 `list_sms_threads` / `list_sms_messages` / `search_sms`，
  实现遵循 plan；若验收按「短信只发、不读不改不删」的字面口径，这组读工具需产品确认后下架。
- **终端 argv 包装器**：`env` 已进拒绝表；`timeout` / `xargs` / `find -exec` 等仍可能作为
  普通程序转调其它可执行文件——终端不是沙箱，逐次确认 + 审计仍是最终闸门。
- **通讯录**：一次一个联系人；删除会同步到已登录账户；云端 raw contact 可能改不动。
- **日历**：重复日程的修改/删除作用于整个系列；不做单次实例编辑；不做 RRULE 创建。
- **文件写入**：Android SAF 没有跨 provider 的原子 rename 保证，写入可能半写；桌面用临时文件 + rename。
- **审计 UI**：本次只落盘 JSONL，不提供页面查看。
- **审计覆盖**：`connected_app_invoke` 的前置门禁（未连接 / AI 未开 / 写许可未开）现在也落
  Rust 审计（`decision:"denied"`）；用户拒绝与 TS 本地门禁依赖 `__audit`，前端在调用前
  崩溃则这条拒绝仍可能漏记（尽力而为）。
- **工具桥超时**：`src-tauri/src/modules/ai/agent/commands.rs` 的 `TOOL_RESULT_TIMEOUT`
  已提到 180s，覆盖确认层 60s + 终端上限 90s 的最坏路径。
- **`connected_app_status` 不含 health**：页面合并两份状态；health 行为不变。
- **AI 隐私**：模型服务商会收到通知/短信/通讯录/文件内容；这是功能固有边界，UI 已提示，
  审计不能消除。
- **写入前根校验**：`connected_app_update({roots})` 在写 `app_meta` 前统一
  canonicalize / 去重 / 拒绝磁盘根与主目录祖先（`paths::normalize_local_roots`）；
  不存在的根直接返回 `connected_app_bad_request`，不留下半份 patch。
- **AI/写入意图的持久化键**：当前是 `connected_apps.ai.<app>` / `connected_apps.write.<app>`
  的分散键，而不是单份 `connected_apps.settings.v1` JSON；行为等价，schema 与早期方案不同。

---

## 12. 回归脚本

> 都需要先起 dev server（`npm run dev`，默认 1420；或 `REIN_E2E_URL` 指向其它实例）。
> 无头浏览器里的 `window.__REIN_TOOL__` 与聊天链路使用同一份 `src/ai/tools/registry.ts`。

| 脚本 | 覆盖 |
|---|---|
| `node scripts/e2e-ai-tools.mjs` | 默认 9 个按需组 / 常驻 41（含 `load_tools`）；传 apps 后 app 组才进 available；`load_tools` 装载读+写工具；写工具不在初始清单 |
| `node scripts/e2e-about-settings-apps.mjs` | `/settings/apps` 页签、真实状态 pill、日历抽屉、连接 → AI、旧 localStorage 键清除、健康行跳转、外部访问入口 |
| `node scripts/e2e-connected-apps-real.mjs` | 行状态（已连接/去授权/不支持）、抽屉权限读写分行、AI/写入开关、文件根可读写/只读、重新检测、工具读、写确认允许/拒绝、`__audit` denied、终端 simulated 输出、零 console error |

静态检查：

```bash
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.app.json
node scripts/check-ipc-contract.mjs
cd src-tauri && cargo test --lib connected_apps
```
