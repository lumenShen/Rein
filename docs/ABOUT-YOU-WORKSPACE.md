# 「关于你」工作区投影（2026-11）

> 这份文档说明 `/me`（关于你）、`/me/folder`（分组详情）、`/me/program`（程序数据）
> 三页**怎么读工作区**。它描述的是前端投影层，不是新的存储层。

## 1. 一句话

「关于你」是现有虚拟文件系统（VFS）的**人类可读投影**：物理目录一个都没动、没复制，
AI 看到的工作区与索引结果也完全不变；页面只是按「用户能认出来的生活主题」把同一批
目录重新分组，再给一个按物理目录读的入口。

实现只有两份前端声明：

- `src/config/workspaceView.ts` —— 6 个分组 `WORKSPACE_GROUPS`、13 个程序目录
  `PROGRAM_DATA_ROOTS`、4 个健康指标 `HEALTH_TILES`；
- 页面：`ProfilePage.vue`、`AboutFolderPage.vue`、`ProgramDataPage.vue`。

## 2. 物理 VFS 不变

- 不新增表、不新增 IPC、不新增 localStorage 真源；页面只调既有只读命令
  `kb_list_dir` / `kb_memories` / `kb_memory_stats` / `kb_cognition` /
  `health_metrics_all`。
- 目录、路径、写入时机全部保持原样。投影页**不提供写操作**：点文件跳到文件管理器
  （`/ai/files?path=`）打开阅读器，要改内容回对应页面，或「在文件管理器中打开」。
- 同一批文件可以同时出现在人类分组与程序数据：前者是「按主题读」，后者是「按物理
  目录读」，不是两份数据。
- 显式排除 `视频/` 与 `纪要/`：两者目前都没有活跃写入（`视频` 只有根声明，`纪要`
  是旧版语音目录），不为凑数做成空卡；它们仍可从高级文件管理器 `/ai/files` 看到。

## 3. 分组映射

| key | 首页卡片 | 物理根目录（`sources`） | 详情页 | testid |
| --- | --- | --- | --- | --- |
| `about` | 关于你 | `用户记忆` | 两份可编辑的 markdown（角色设定 / 全局规范） | `about-folder-about` |
| `health` | 健康（整宽大卡） | `体测`、`运动`、`方案` | 三个二级分组卡 + 合并文件 | `about-folder-health`（卡头「查看」） |
| `life` | 生活 | `日程`、`饮食` | 合并文件 | `about-folder-life` |
| `voice` | 语音笔记 | `语音` | 合并文件 | `about-folder-voice` |
| `notes` | 笔记与文档 | `笔记`、`文档`、`未分类数据` | 合并文件 | `about-folder-notes` |
| `corner` | Rein 的角落 | `记忆`、`对话`、`附件` | 合并文件 | `about-folder-corner` |

投影判据（不是按可写性、也不是按 `kb_docs` / `kb_files` 分）：

1. **人类分组**：用户能认出「这是我的」——记忆文件、健康记录、日程饮食、语音、笔记、
   对话附件。健康 / 生活 / 角落本身是只读派生投影，仍进人类分组：它们是生活记录，
   不是程序配置。
2. **程序数据**：系统提示词、规范、课程 / 食物 / 菜单等配置，以及全部派生投影的物理
   索引。只读、弱化、放在最后一页。
3. **`文档/` 留在「笔记与文档」**：它是用户上传文档的全文归档；写入由程序触发，但
   内容所有权是用户的文档，不是系统配置。
4. **`视频/` 与 `纪要/` 不进任何一组**（见 §2）。

### 3.1 计数口径

- 首页的**目录计数**只发一次 `kb_list_dir('')`：用根目录 `KbEntry.childCount`（直接子项数）
  按 root 名建索引，分组计数 = 声明里各 root 的 `childCount` 之和。
- 不要改用 `kb_usage.areas[].count`：那条 SQL 只统计 `kb_files`，而 `体测/运动/方案/
  日程/饮食/记忆/对话/附件` 等投影只写 `kb_docs`，用 areas 会让这些分组系统性显示 0。
- `childCount` 与详情页 `entries.length` 同规则（都把派生文档算进去）。某个 root
  不存在时按 0，卡片仍显示「0 项」，点进去是空态；不伪造目录。
- 详情页合并多个 root 后按 `path` 去重，目录在前、最近更新在前；`truncated` 时列表
  底部提示「只显示前 N 项 · 在文件管理器中查看全部」。

### 3.2 深链参数

| 参数 | 页面 | 含义 |
| --- | --- | --- |
| `?key=<WorkspaceGroupKey>` | `/me/folder` | 必填；未知 key 显示「没有这个文件夹」 |
| `?path=<物理路径>` | `/me/folder` | 可选；必须落在当前分组的某个 root 内（`path === root` 或 `root/` 前缀），否则按不在投影里处理 |
| `?dir=<物理目录>` | `/ai/files` | 文件管理器打开该目录（程序数据每行的落点） |
| `?path=<物理路径>` | `/ai/files` | 文件管理器按路径打开文件（聊天文件卡与文件夹详情的「在文件管理器中打开」同一链路） |
| `?upload=1`（兼容 `?import=1`） | `/ai/files` | 显示一次性「选择文件」提示条；按钮点击才唤起选择器，不在挂载时自动点（关于你 › 上传文件的落点） |

`?path` 的 root 校验**不是安全边界**：文件管理器本身仍可打开任意路径（高级视图）。
它只是防止一个畸形 URL 把投影页带到分组之外的目录。

### 3.3 健康分组的附加入口

`/me` 的健康大卡与 `/me/folder?key=health` 都保留两个真实入口：

- 「身体数据与训练约束」→ 打开 `ConstraintsSheet`（等 `nutrition.profile` 到位后
  才可点，避免用户把默认草稿保存回去）；
- 「健康数据授权」→ `/settings/health`（仅 Android 有 Health Connect，桌面端是
  说明性禁用态）。

健康磁贴固定 4 个：`sleep_min` / `resting_hr_bpm` / `hrv_rmssd_ms` / `steps`；
series 不存在才显示 `--`，当天步数为 0 时照常显示 0。

## 4. 程序数据页（`/me/program`）

- 按 `PROGRAM_DATA_ROOTS` 的固定顺序渲染 **13 行**，即使目录当前不存在也渲染
  （计数 0），入口不随数据有无而跳动。
- 每行只按物理目录读：`系统提示词`、`规范`、`课程`、`食物`、`菜单`、`体测`、`运动`、
  `方案`、`日程`、`饮食`、`对话`、`附件`、`记忆`。
- 计数来自一次 `kb_list_dir('')` 的 `childCount`；点击进 `/ai/files?dir=<root>`。
- 页底「打开完整文件管理器」→ `/ai/files`。

## 5. 如何新增一组

1. 在 `src/config/workspaceView.ts` 的 `WORKSPACE_GROUPS` 里加一条
   `defineGroup({ key, title, hint, icon, accent, sources, kind })`：
   - `key` 是 URL 与 testid 的稳定 slug，**一旦发布不要改名**；
   - `sources` 只写现有物理顶层目录名，不移动、不复制；
   - `kind: 'health'` 才会在详情页渲染二级分组与健康附加行；普通分组用 `'folder'`。
2. `testid` 由 `defineGroup` 自动生成 `about-folder-<key>`，页面不需要再注册。
3. 首页计数会自动包含新分组的 `sources`（一次根目录列举已经覆盖全部顶层目录）；
   详情页会自动合并 `sources`，无需改页面。
4. 若要给新分组加专属入口（类似健康大卡），在 `ProfilePage.vue` 里单独渲染，
   并把入口 testid 写进本文件与 e2e；普通分组不用改代码。
5. 更新本文档 §3 的表格与 `docs/ARCHITECTURE.md` 的路由说明。
6. e2e：在 `scripts/e2e-about-settings-apps.mjs` 的文件夹网格断言里加 testid；
   `scripts/e2e-layout-guard.mjs` / `scripts/e2e-desktop-audit.mjs` 的路由矩阵按需
   加 `#/me/folder?key=<key>`。
7. 若这个目录也属于「程序数据」，在 `PROGRAM_DATA_ROOTS` 加一行（`id` 是英文 slug、
   `root` 是物理目录名）；否则不要加——两份清单有意允许重叠，但不要求重叠。

## 6. 不要做的事

- 不要把投影页当文件管理器：没有上传 / 新建目录 / 删除 / 改名，写操作一律回文件管理器。
- 不要为了「首页 0、详情有货」去改用 `kb_usage.areas`；那是口径错误，不是性能优化。
- 不要把 `toFileItem(entry)` 的结果用于导航、权限或时间判断：`FileItem` 没有
  `path`、`system`，`modifiedAt` 与 `KbEntry.updatedAt` 也不是同一种时间表示。
- 不要在 `onMounted` 里自动 `pickUpload()`：没有用户手势，浏览器/WebView 会静默拒绝。
- 不要复制 `ExternalAccessSection` 或 `GatewayAuthSheet` 到投影页；外部访问只有
  「设置 › 连接应用 › 外部访问」一个落点。

## 7. 回归

```bash
node scripts/e2e-about-settings-apps.mjs   # 关于你 / 设置三组 / 运动设置 / 连接应用
node scripts/e2e-feature-toggles.mjs       # 模块开关与「设备」行
node scripts/e2e-focus.mjs                 # 专注页「专注设置」抽屉
node scripts/e2e-layout-guard.mjs          # 新路由不拆行 / 不裁切
node scripts/e2e-desktop-audit.mjs         # 桌面宽度、触控目标、字号
```

前置：`npm run dev` 已在 1420（或 `REIN_E2E_URL` 指向其它实例）。
