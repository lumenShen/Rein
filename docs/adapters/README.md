# 教务系统适配器 · 贡献指南

全国 3000+ 所高校的教务系统千奇百怪（正方、树维、强智、URP、青果……），我们没法覆盖每一所——**但你可以**。
本文是把你学校接进 Rein 的总指南：先判断走哪条路，再照着做。

## 代码地图

```text
src-tauri/src/modules/campus/adapters/   # 适配层（Rust）
├── mod.rs          # 入口：贡献者地图 + 子模块导出
├── base.rs         # 统一接口 CampusAdapter（trait）+ AnyAdapter 分派
├── provider.rs     # SchoolSystemSpec / LoginStrategy / REGISTRY / 能力位
├── supwisdom.rs    # 树维（Supwisdom EAMS5）适配器 · 实战见 supwisdom.md
└── zfsoft.rs       # 正方（ZFSoft zftal）适配器 · 实战见 zfsoft.md

docs/adapters/                           # 你正在读的目录
├── README.md       # 总指南（本文）
├── supwisdom.md    # 树维 EAMS5 实战记录
├── zfsoft.md       # 正方 zftal 实战记录
└── template.md     # 新厂商开发模板（复制即用）
```

两条铁的分层原则：

- **命令层只认动作**（登录 / 学期 / 课表），不认识任何厂商——厂商差异全部收在 `adapters/` 里。
- **声明优先于代码**：能用一条 `SchoolSystemSpec` 说清的事（学校、域名、接口路径、能力位），绝不写成 if/else。

## 路径 A：同厂商的新学校（最常见的 PR，通常 20 行以内）

贵校用的教务系统与在册某家**同厂商**（比如也是树维 EAMS5，只是换了域名/公钥/菜单路径），
那么只需要在 `provider.rs` 的 `REGISTRY` 末尾加一条 spec：

```rust
const YOUR_SCHOOL: SchoolSystemSpec = SchoolSystemSpec {
    kind: "yourschool-supwisdom-eams5",          // 稳定键：厂商口径命名，落库后不再改
    name: "某某大学 · 本科生教学信息平台",
    short_name: "某某大学",
    vendor: "树维 Supwisdom EAMS5 · 学生端 · jwzx.yourschool.edu.cn",
    default_base_url: "https://jwzx.yourschool.edu.cn",
    base_url_hint: "学校正式教务地址；除非学校另行通知，不要改。",
    login: LoginStrategy::SupwisdomPortalRsa { /* 抓包所得，见下 */ },
    endpoints: EndpointSpec { /* 同厂商：接口表与在册那条一致就照抄 */ },
    term: TermSpec { biz_type_id: Some(2), week_start_on_sunday: false },
    capabilities: SUPWISDOM_CAPS,                // 同厂商：能力位照抄
};
```

改完两处即生效，**前端零改动**：`REGISTRY` 数组加上它；`src/mock/server.ts` 的
`campus_systems` 加同形一条（浏览器 mock 与 Rust 必须同序同形）。

> 同厂商不等于同配置：域名、登录页公钥、验证码路径、周起点都可能不同，逐项对照抓包，别照抄域名。

## 路径 B：新厂商（全新一套系统）

如果贵校的系统在册厂商都对不上（登录页长得不一样、接口路径风格不同），走这条。
完整步骤与代码骨架见 [template.md](template.md)，概要：

1. **抓包**（见下节），弄清登录握手与数据接口；
2. 新建 `adapters/<vendor>.rs`，实现 `base.rs::CampusAdapter` 的全部必需方法
   （可选能力不实现，自动得到「不支持」回执）；
3. `provider.rs`：`LoginStrategy` 加一个变体（登录握手数据）、`EndpointSpec` 加该厂商的
   接口表、新建能力位常量；
4. `base.rs::AnyAdapter::new` 的穷尽 match 加一臂——**漏了这步编译不过**，这是刻意的；
5. 真机测试用例（`#[ignore]` + 环境变量凭据，见下）+ `docs/adapters/<vendor>.md` 实战记录。

## 抓包指南

用浏览器 DevTools（F12 → Network），登录教务并打开课表页，然后按请求清单逐条核对：

| 要抓什么 | 怎么认 |
| --- | --- |
| 登录链 | 从打开登录页到登录成功的**全部**请求：有没有先取 salt / 公钥 / csrftoken？提交是 JSON 还是表单？密码是否被加密（搜 `encrypt`、页面 JS 里的 RSA）？ |
| 验证码 | 什么时候要（随时 / 错几次后）？图片接口路径？答案绑会话吗？ |
| 会话判据 | 登录后哪个页面能当「还在线」的探针（200 = 在线，302 = 被踢）？Cookie 叫什么？ |
| 学期列表 | 有没有独立接口？很多系统学期列表只藏在课表页 HTML 的 JS 变量里。 |
| 课表数据 | 主数据接口的 URL、参数（学期怎么传）、返回形状（截一份脱敏 JSON）。 |
| 加分项 | 节次时间表、课程详情、培养方案、全校开课查询、选课接口。 |

**脱敏铁律（PR / Issue 都一样）**：

- ❌ 密码、Cookie、验证码答案 —— 永远不出现；
- ⚠️ 学号、姓名打码（`2600******` / `张*`）；
- ✅ 接口路径、参数名、返回字段名、公钥（公钥本来就在登录页源码里公开）可以写全。

## 质量门（PR 前在本地跑）

```bash
cd src-tauri
cargo check --lib          # 编译（新厂商漏接分派在这里就会红）
cargo test --lib           # 单测；真机用例默认 ignore，不会误打教务
cd ..
npm run typecheck          # 前端类型
npm run lint
npm run contract           # IPC 契约三方比对（本层重构不应引起任何变化）
```

真机测试的规矩（照 `supwisdom.rs::live_supwisdom_roundtrip` 的样子）：
`#[test] #[ignore = "打真实教务系统，需要 REIN_XXX_USER / REIN_XXX_PASS"]`，
凭据只从环境变量读、绝不进仓库，CI 永远不跑它。

## 待接入清单（欢迎认领）

| 系统 | 状态 | 说明 |
| --- | --- | --- |
| 强智 Qiangzhi（湘教通） | 🔍 待抓包 | 覆盖面广，多家「今日校园」配套 |
| URP（高校教研平台） | 🔍 待抓包 | 老牌系统，版本多 |
| 青果 Qingguo | 🔍 待抓包 | |
| 金智 / 新版正方（wfw） | 🔍 待抓包 | 与老正方不同代 |

认领方式：先[提一个 Issue](https://github.com/lumenShen/Rein/issues) 写明学校与系统名，附上脱敏抓包，避免撞车。

## 不写代码也能贡献

直接[提 Issue](https://github.com/lumenShen/Rein/issues)，附上：

1. 学校名 + 教务系统名/版本（登录页底部一般有厂商署名）；
2. 上面「抓包指南」表格里的脱敏记录（HAR 导出后先删掉 Cookie 头与密码字段）；
3. 一份脱敏的课表返回 JSON。

适配器实现由维护者完成，你在 PR 合入后负责真机验证一次即可。
