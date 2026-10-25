<div align="center">

# 🐎 Rein

**把生活的缰绳，交还给你自己**

*Your Local-First AI Life OS · 本地优先的全能生活管家*

[![Local-First](https://img.shields.io/badge/Local--First-22C55E?style=flat-square)]
[![Local AI](https://img.shields.io/badge/Local%20AI-3B82F6?style=flat-square)]
[![Tauri](https://img.shields.io/badge/Tauri-FF6F00?style=flat-square)]
[![License: MIT](https://img.shields.io/badge/License-MIT-94A3B8?style=flat-square)]

<!-- ══════════ 🎬 TODO：录制 30 秒演示 GIF 后替换下图 ══════════ -->
<img src="https://placehold.co/800x450/0d1117/8b949e?text=Rein+30s+Demo+GIF+%28Coming+Soon%29" width="800" alt="Rein 30 秒演示 GIF（占位）">

**🗣️ 一句话记账　·　📅 一键同步课表　·　💾 数据 100% 留在你的设备上**

**[🚀 立即下载](https://github.com/lumenShen/Rein/releases)** ｜ **[🌐 访问官网](替换为你的链接)** ｜ **[📚 阅读文档](docs/ARCHITECTURE.md)**

</div>

---

## 🤔 为什么是 Rein？

你的生活数据，正被撕碎在十几个 App 里：

- 💸 记账一个 App，🍜 饮食一个，✅ 待办一个，📅 课表又一个 —— **数据孤岛，永远拼不出完整的一天**
- 📶 装一个 App：注册 → 授权 → 上云 —— **你的生活，在给别人的服务器打工**

**Rein 的答案：AI 自然语言中枢 + 模块化引擎 + 本地数据掌控。**

| | 😩 传统生活 App | 🐎 Rein |
| --- | --- | --- |
| 💾 数据归属 | 厂商云端 | **本地 SQLite，完全自主** |
| 🪪 账号体系 | 强制注册 | **无需注册，开箱即用** |
| ✈️ 断网之后 | 基本残废 | **照常使用** |
| ⌨️ 记录成本 | 开 App → 找入口 → 填表单 | **一句话，AI 自动分发** |

> [!TIP]
> 🎛️ **关闭模块 ≠ 删除数据。** 10+ 个功能模块可一键隐藏——不用健身？关掉。不用抢课？关掉。界面瞬间清爽，数据原封不动；哪天想用了再打开，一只字节都不会少。

---

## ✨ 核心亮点

- 🗣️ **一句话，记完所有事** —— 「午餐 28 块，跑步 5 公里」，AI 自动拆解并分发到记账与运动模块。你只管说，归档交给它。
- ⚡ **快得不像桌面应用** —— Rust + Tauri 内核，安装包与内存占用仅为 Electron 系的零头，冷启动秒开。
- 🧊 **苹果级视觉质感** —— Liquid Glass 液态玻璃设计语言 + 四档画质，每一帧都值得截图。
- 🎓 **大学生特供** —— 教务课表一键同步进时间线，选课抢课快人一步（详见下方[适配器共建计划](#-社区共建把你的学校接进-rein)）。
- 🎙️ **能听会写** —— 实时语音转写，说完即成纪要；上课、开会、灵感闪现，张嘴就行。

---

## 🖼️ 眼见为实

<table>
  <tr>
    <td width="50%" align="center">
      <!-- 🎬 TODO：替换为「功能开关页」截图 -->
      <img src="https://placehold.co/640x400/0d1117/8b949e?text=Feature+Toggles" width="100%" alt="功能开关页截图（占位）">
      <br/><b>🎛️ 功能开关页</b><br/>
      <sub>10+ 模块即开即关，你的 Rein 你做主</sub>
    </td>
    <td width="50%" align="center">
      <!-- 🎬 TODO：替换为「主页 / 时间线」截图 -->
      <img src="https://placehold.co/640x400/0d1117/8b949e?text=Home+Timeline" width="100%" alt="主页时间线截图（占位）">
      <br/><b>🏠 主页 · 时间线</b><br/>
      <sub>饮食、运动、待办、课表、账单，一屏尽收</sub>
    </td>
  </tr>
</table>

---

## 🚀 快速开始

### 方式一 · 下载即用（推荐 ✅）

> 无需注册，无需配置，装完即用。

1. 前往 [**Releases**](https://github.com/lumenShen/Rein/releases) 下载对应平台安装包（Windows / Android）
2. 安装并打开 Rein
3. 对它说的第一句话，就是掌控生活的开始 🎉

<details>
<summary><b>🛠️ 方式二 · 从源码编译（开发者）</b></summary>

环境要求：`Node.js ≥ 20`、`Rust 工具链`（[rustup](https://rustup.rs/)）

```bash
git clone https://github.com/lumenShen/Rein.git
cd Rein
npm install        # 安装依赖
npm run app:dev    # 开发调试（Vite + Rust 后端，窗口 430×932）
npm run app:build  # 打包安装包（Windows NSIS / Android APK）
```

纯前端 UI 开发（无后端，走内存 mock）：

```bash
npm run dev        # http://localhost:1420
```

</details>

---

## 🎓 社区共建：把你的学校「接」进 Rein

全国 **3000+ 所高校**，教务系统千奇百怪：正方、强智、URP、青果……我们没法覆盖每一所学校——**但你可以。**

Rein 用 **适配器（Adapter）模式** 把「教务对接」与「核心功能」彻底解耦，并把门槛压到最低——同厂商的学校 20 行声明即可接入，全新厂商也只需要实现一个 Trait。代码放哪、按什么标准写、文档写在哪，全部有章可循：

```text
src-tauri/src/modules/campus/adapters/   # 🧩 ① 适配器代码（Rust）
├── base.rs        #    统一接口 CampusAdapter（Trait）：实现它即可接入
├── provider.rs    #    学校注册表 REGISTRY + 能力位声明
├── supwisdom.rs   #    已接入：树维 Supwisdom EAMS5（桂林电子科技大学）
└── zfsoft.rs      #    已接入：正方 ZFSoft zftal（广西科技大学）

docs/adapters/                           # 📖 ② 贡献文档
├── README.md     #    总指南：如何抓包、如何提 PR、待接入厂商清单
├── supwisdom.md  #    实战记录：树维 EAMS5（盐值 RSA / SSO 选课令牌）
├── zfsoft.md     #    实战记录：正方 zftal（csrftoken / 节次表 / 周次表）
└── template.md   #    新厂商开发模板（复制即用）
```

**🚪 上车两条路：**

- **贵校与在册学校同厂商**（最常见，约 20 行）—— 在 `provider.rs` 的 `REGISTRY` 加一条声明，前端选择器自动出现你的学校，其余代码一行不动
- **全新厂商** —— 按总指南抓包，实现 `base.rs` 的 `CampusAdapter` Trait（漏接分派会在编译期报错，不怕接错），附一份 `docs/adapters/<厂商>.md` 实战记录

> [!NOTE]
> ✋ 不写代码也能参与：直接[提一个 Issue](https://github.com/lumenShen/Rein/issues) 附上你学校的抓包数据（**记得抹去密码与 Cookie**），适配器我们来实现。强智、URP、青果等系统的待接入清单见贡献指南。

<div align="center">

**[📖 查看适配器开发指南 (docs/adapters/README.md)](docs/adapters/README.md)**

</div>

---

## 🏗️ 技术架构

<details>
<summary><b>给极客的展开阅读 ▸</b></summary>

```text
┌─────────────────────────────────────┐
│  前端 · Vue 3 + TypeScript           │  Liquid Glass UI · 四档画质
├─────────────────────────────────────┤
│  IPC 桥（前后端命令契约自动校验）      │
├─────────────────────────────────────┤
│  Rust 后端 · 按领域分模块             │  AI 编排 · 教务适配器 · 录音 · 定位
├─────────────────────────────────────┤
│  本地 SQLite 单文件数据库             │  所有数据，只在这台设备上
└─────────────────────────────────────┘
```

- **Tauri 2 + 系统 WebView**：不捆绑浏览器内核，安装包小、启动快
- **本地 SQLite**：数据永不离开设备；多设备同步走端到端加密直连，是仅有的联网能力之一
- **AI 接你自己的模型**：对话即工具调用直写各模块、本地 embedding 向量检索、长期记忆
- **一份代码，两端运行**：视口自适应，Windows 桌面壳层与 Android 单列卡片流同一套逻辑

更多细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

</details>

---

## 🤝 贡献与支持

- 🐛 [提 Issue](https://github.com/lumenShen/Rein/issues)：Bug 与功能建议，来者不拒
- 🔀 [提 Pull Request](https://github.com/lumenShen/Rein/pulls)：代码、文档、教务适配器，都欢迎
- ⭐ 点个 Star：让更多人的生活数据回到自己手里

> 本仓库 **90%+ 代码由 Vibe Coding（AI 结对编程）完成**。别怕看不懂 Rust——带上你的 AI，一起来。

### ☕ 请开发者喝杯咖啡

如果 Rein 帮到了你，欢迎到 [爱发电](替换为你的链接) 赞助一杯咖啡 —— 你的支持，是这个项目继续奔跑的缰绳。

<div align="center">

---

**Rein · 缰绳在手，生活自主** 🐎

Made with 🧠 & ❤️ · Released under the MIT License

</div>
