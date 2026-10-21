# Rein · 全能生活助理

一个**以 AI 为中枢**的个人生活助理：饮食、营养、运动、待办、专注、记账、课表、知识库，
长在同一条时间线上，并且**都能被 AI 读懂、也能被 AI 操作**。

![Tauri 2](https://img.shields.io/badge/Tauri_2-24C8DB?style=flat-square)
![Vue 3](https://img.shields.io/badge/Vue_3-42B883?style=flat-square)
![Rust](https://img.shields.io/badge/Rust-000000?style=flat-square)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square)
![Windows + Android](https://img.shields.io/badge/Windows_+_Android-0078D6?style=flat-square)
![本地优先](https://img.shields.io/badge/%E6%9C%AC%E5%9C%B0%E4%BC%98%E5%85%88-34C759?style=flat-square)

单机优先、数据留在本地；Windows 与 Android 同一份代码。
观感对齐 Apple 的 Liquid Glass —— 四档画质可选，最高档把折射与多层光学铺到内容层。

![Rein 桌面工作台](docs/screens/desktop-home.png)

## 为什么叫「助理」而不是「工具箱」

同类应用常把功能做成互不相干的模块：记饮食的不知道你今天练了什么，记账的不知道你明天几点有课。
Rein 的差别是**它们共享同一份数据与同一条时间线**，而 AI 是把数据串起来的那个人：

- **读得到**：今日饮食、本周运动与练够分、今天的待办、这个月的开销、明天的课表、你的知识库笔记。
  首页右侧的「试试问」就是入口——*分析今日饮食* / *这周运动量怎么样* / *帮我把明天安排满* / *总结这个月的开销*。
- **能动**：对话里直接调用工具写数据——拍照或一句话记一餐、记一笔账、把某事排进明天的日程。
- **会沉淀**：回答不是消失的气泡，而是可留存、可再问的卡片与文件；知识库里的笔记会长期记住你。

## 功能地图

按「AI / 记录 / 身体 / 时间 / 钱 / 系统」分区，同一模块的功能放在一起。

### AI

| 功能 | 能做什么 | 入口 |
| --- | --- | --- |
| AI 对话与工具 | 问答、工具调用、卡片产物、历史与文件 | AI 页 |
| 知识库 | 笔记 / 文件索引、向量检索、长期记忆 | AI › 知识库 |
| 虚拟文件 | AI 的附件与产物都是文件，可浏览、可引用 | AI › 文件 |

### 记录

| 功能 | 能做什么 | 入口 |
| --- | --- | --- |
| 记饮食 | 拍照、文字、食物库三种记法 | 主页快捷入口、AI 页 |
| 录音 | 录音台、未归档 take 管理、附加到待办 | 我 › 录音 |

### 身体

| 功能 | 能做什么 | 入口 |
| --- | --- | --- |
| 能量与营养 | 目标 / 摄入 / 运动消耗，三大宏量 + 钠与微量元素 | 主页首卡、饮食全览 |
| 食谱库 | 模板浏览、喜欢不喜欢、按目标生成一日菜单 | 主页「食谱库」 |
| 运动 | 有氧与日常活动，MET 估算消耗并计入能量平衡 | 运动页 |
| 力量训练 | 课程模板 → 做组 / 组间休息 / 计时动作 → 汇总；练够分与肌群热力图 | 运动页「今日训练」 |
| 动作库与重量曲线 | 动作的唯一真源，重量曲线按此聚合 | 运动 › 动作库 |
| 健康方案 | 程序算三档基线 → 日程级展开 → AI 复盘调参 | 我 › 健康方案 |

### 时间

| 功能 | 能做什么 | 入口 |
| --- | --- | --- |
| 待办与时间线 | 日 / 周 / 月视图，紧急重要四象限 | 主页待办卡、全部待办 |
| 番茄钟 | 关联待办、会话存档、今日轮次 | 主页番茄钟卡 |
| 课表与教务 | 同步教务课表并写进时间线；课程详情、培养方案、选课与抢课；官方调休映射 | 主页课表卡 |

### 钱

| 功能 | 能做什么 | 入口 |
| --- | --- | --- |
| 记账 | 分类记账、月度预算、分类占比、近六个月趋势 | 主页记账卡 |

### 系统

| 功能 | 能做什么 | 入口 |
| --- | --- | --- |
| 多设备同步 | 同网段直连 / 跨网段打洞 / 中转，三条路都是端到端加密 | 设置 › 多设备同步 |
| 软件更新 | 多源清单、Ed25519 双验签、断点续传、应用内安装 | 设置 › 关于 › 软件更新 |
| 全局浮窗 | 离开应用后，进行中的专注与训练浮在系统最上层（桌面置顶小窗 / Android 系统浮层）；没拿到系统浮窗权限时自动退回程序内浮条 | 设置 › 全局浮窗 |

## AI 系统

| 能力 | 说明 | 入口 |
| --- | --- | --- |
| 自带模型 | 接入你自己的模型服务，多套配置随时切换 | 设置 › AI › 管理模型 |
| 对话即操作 | 工具调用：记饮食 / 记一笔账 / 排日程 / 查运动 / 读课表 | AI 页对话 |
| 卡片式产物 | 回答以卡片落到画布上，可回看、可再问 | AI 页 |
| 知识库 | 笔记 / 文件 / 文件夹 + **本地 embedding 向量检索** | AI › 知识库 |
| 长期记忆 | 会话里自动提取要点并注入后续对话 | AI › 知识库 › 长期记忆 |
| 虚拟文件 | AI 的附件与产物都是文件，可浏览、可引用 | AI › 文件 |
| 语音对话 | 实时转写，结束时自动整理成纪要 | 主页「录音纪要」 |

## 快速开始

桌面端（前端 + Rust 一起跑）：

```bash
npm install          # 安装前端依赖
npm run app:dev      # 开发，自动起 vite + rust，窗口 430×932
npm run app:build    # 打包 NSIS 安装包
```

纯浏览器 UI 开发（无后端，走内存 mock 与演示数据）：

```bash
npm install
npm run dev          # http://localhost:1420
```

其他常用命令：`npm run typecheck`（类型检查）、`npm run build`（类型检查 + 前端构建）、
`npm run contract`（前后端命令一致性校验）、`npm run lint`、`npm run icon`（重新生成图标）。

## 多平台适配

**同一份代码同时跑在手机与电脑上**，靠视口宽度切换形态，而不是两套工程：电脑端（视口 ≥ 900px）切成
桌面壳层——左导航轨 + 主人区，窗口更宽时展开右侧信息栏；`Ctrl+K`（macOS `⌘K`）唤起命令面板直达任意页面。
手机端（430×932，也是桌面窗口的出厂尺寸）是底部页签 + 单列卡片流，手势、抽屉一应俱全；
中间宽度退回单列，但保留全部功能，不做阉割版。

桌面窗口用**程序自绘的标题栏**（原生标题栏与边框已去掉，拖拽 / 双击最大化 / 八向缩放都由前端补回），
全局浮窗的标题栏是同一套组件的高 32 紧凑版；Android 走系统原生标题栏与状态栏。
两端的沉浸浮窗都只在「有专注 / 训练在跑 + 用户离开了应用」时出现，回到应用即收起。

| 手机端 · 今天 | 手机端 · 记账 |
| --- | --- |
| <img src="docs/screens/mobile-home.png" alt="手机端 · 今天" width="300" /> | <img src="docs/screens/mobile-ledger.png" alt="手机端 · 记账" width="300" /> |

| 电脑端 · 营养全览 | 电脑端 · 记账 |
| --- | --- |
| <img src="docs/screens/desktop-nutrition.png" alt="电脑端 · 营养全览" width="480" /> | <img src="docs/screens/desktop-ledger.png" alt="电脑端 · 记账" width="480" /> |

## 画质与动效

四档固定画质（设置 › 性能），手动钉死不自动切：

| 档位 | 做了什么 |
| --- | --- |
| 流畅 | 玻璃顶成实底、关模糊与循环动画，合成成本最低 |
| 高画质 | 玻璃材质铺到卡片 / 抽屉 / 菜单 / 操作面板与页头圆钮 |
| 超高 | 在其上加折射与两道光学层 |
| 极致 | 与超高同一条折射管线，光学层更深一档、外缘层加厚 |

动效可单独关 / 默认 / 丰富：关掉不做任何补间，丰富档再加液态融合、定向光晕与抽屉透镜式进出，
掉帧降级时丰富档自动退回默认。实现口径见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5。

## 平台与发布

打 tag 触发 GitHub Actions：并行构建 Windows NSIS 与 Android APK，再统一签名、组装更新清单，
发到 GitHub Release 与 Rein 在线服务。安装包在下载与安装前各做一次验签。

```bash
git tag v0.5.20 && git push rein v0.5.20
```

本地发布（与服务端 / 更新签名相关）见 [docs/UPDATES.md](docs/UPDATES.md)。

## 官网与宣传片

- 官网源码在 [`site/`](site/)，构建产物 `site/dist/`，可直接静态托管。
- 宣传片源码在 [`promo/`](promo/)，成片 `promo/out/rein-promo.mp4`。

## 文档索引

| 文档 | 讲什么 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、数据流、IPC 契约、数据库 schema、扩展指南 |
| [docs/STANDARDS.md](docs/STANDARDS.md) | 命名、代码风格、提交规范、质量门槛 |
| [docs/SYNC.md](docs/SYNC.md) | 多设备同步：三条传输路径与会话协议 |
| [docs/UPDATES.md](docs/UPDATES.md) | 在线更新与 Rein 在线服务：信任链、发版流程、服务端接口 |
| [docs/SERVER-SECURITY.md](docs/SERVER-SECURITY.md) | 服务器安全审计：服务身份、提权面、已修与待办 |
| [docs/EXTERNAL-API.md](docs/EXTERNAL-API.md) | 对外服务接口：授权模型、会话与方法清单 |
| [docs/ai-workspace.md](docs/ai-workspace.md) | AI 工作台与虚拟文件系统 |
| [docs/MOTION-MODE-EXPERIENCE.md](docs/MOTION-MODE-EXPERIENCE.md) | 运动模式的体验优化流程与判定口径 |
| [docs/PROJECT-2026-10/](docs/PROJECT-2026-10/) | 对外表达层（README / 官网 / 宣传片）的计划、设计简报与工作单 |
| [server/README.md](server/README.md) | 在线服务端的部署与运维 |

## 目录结构

```
├─ docs/                    # 架构与规范文档（先读这两个再动手）
├─ resources/foods.json               # 食物库种子（前端 mock 与 Rust 共用）
├─ resources/workout_plans.json       # 内置课程种子（含器械 meta）
├─ resources/recipe_templates.json    # 食谱模板库（脚本从 foods.json 实算生成）
├─ scripts/                 # 工具脚本 + IPC 契约校验
│  └─ release/              # 更新发布工具链（keygen / publish / verify / e2e / deploy）
├─ server/                  # Rein 在线服务（零依赖 Node：更新分发 + 模型网关）
├─ site/                    # 官网源码（产物 site/dist）
├─ promo/                   # 宣传片源码（成片 promo/out/rein-promo.mp4）
├─ src/                     # Vue 前端
│  ├─ components/           # 按领域分目录：ai / campus / diet / nutrition / todo /
│  │                        #   exercise / program / ledger / voice / workbench / layout / common
│  ├─ pages/                # 页面（四个一级页 + 各自二级/三级内容页）
│  ├─ stores/               # Pinia 状态（按领域一店）
│  ├─ services/             # IPC 封装（唯一出口 transport.ts）
│  ├─ system/               # 画质 / 动效 / 录音与训练运行时等全局单例
│  ├─ types/                # 领域类型（前后端契约镜像）
│  ├─ config/               # 展示元数据 / DRI 参考 / 断点常量
│  ├─ utils/  composables/
│  └─ styles/               # 设计令牌 tokens.css + base.css
└─ src-tauri/               # Rust 后端
   └─ src/modules/          # 按领域分模块：ai/kb/campus/diet/nutrition/todo/exercise/
                            #   exercise_lib/program/ledger/voice/sync/update/session…
```

## 说明

- `resources/foods.json` 营养值为近似参考值（框架演示用），替换权威数据源时保持字段结构即可。
- 课表数据来自学校教务系统，需在「课表配置与设置」里绑定你自己的账号；调休数据取自公开的
  [holiday-cn](https://github.com/NateScarlet/holiday-cn) 校历库，补哪一天由规律推断并可在设置页逐日纠正。
- 数据默认只存在本机 SQLite；多设备同步与更新是仅有的两处联网能力。