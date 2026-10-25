# 新厂商适配器 · 开发模板

复制本文件为 `docs/adapters/<vendor>.md`，照着填。下面以虚构的「示例教务」为例给出全部骨架；
每一步都有「做什么 / 放哪里 / 怎么验」。先读 [README.md](README.md) 的路径 B 概要与抓包指南。

## 0. 前置：抓包结论表（先填这个，再动代码）

| 项 | 结论（实测） |
| --- | --- |
| 登录页 URL | `https://jwzx.example.edu.cn/login` |
| 登录前置请求 | （取 salt / 公钥 / csrftoken？各是什么） |
| 口令处理 | （明文 / RSA(salt+口令) / RSA(裸口令) / 自定义哈希） |
| 提交方式 | （JSON / 表单；字段名） |
| 成功判据 | （200+JSON 标志 / 302 跳转，**反直觉的写清楚**） |
| 会话载体 | （Cookie 名 / header） |
| 会话探针 | （哪个页面 200=在线、302=过期） |
| 验证码 | （路径、何时要、绑不绑会话） |
| 学期列表 | （独立接口 / 藏在页面 JS 变量） |
| 课表接口 | （URL、参数、返回形状，附脱敏样本） |

## 1. `provider.rs`：声明登录握手

```rust
/// 示例教务的登录握手：一句「流程是什么、凭据怎么混」。
ExampleFormRsa {
    login_path: &'static str,
    public_key_path: &'static str,   // 公钥运行时现取时才需要
    captcha_path: &'static str,
    probe_path: &'static str,
},
```

- `LoginStrategy` 的取值方法（`login_path` / `captcha_path` / `probe_path` / `salt_path` /
  `public_key` / `public_key_path`）按新厂商的实际流程补齐：有就 Some，没有就 None，
  **不要用空串占位**（空串会被当有效路径打出去）。
- 新厂商的接口表加一个 `ExampleEndpoints` struct + `EndpointSpec` 新字段（`Option`，
  与 `eams5` / `zfsoft` 互斥）。
- 能力位新建常量（打通了哪些就开哪些，其余 `false`——trait 默认回执会与它互为印证）：

```rust
const EXAMPLE_CAPS: AdapterCapabilities = AdapterCapabilities {
    course_detail: false,
    program: false,
    lesson_search: false,
    course_select: false,
};
```

## 2. `adapters/<vendor>.rs`：实现统一接口

```rust
//! 示例教务（Example EAMS）适配器 —— 在册学校：某某大学。
//! 每个函数对应一次实测验证过的真实请求（实测口径：…，日期）。

use super::base::CampusAdapter;
use super::provider::SchoolSystemSpec;
use super::super::http::{guard, Session};           // 会话层与厂商无关，直接复用
use super::super::models::{LoginOutcome, PageVars, TimetableSnapshot};
use crate::error::{ReinError, Result};

pub struct ExampleAdapter<'a> {
    pub spec: &'static SchoolSystemSpec,
    pub session: &'a mut Session,
}

impl<'a> ExampleAdapter<'a> {
    pub fn new(spec: &'static SchoolSystemSpec, session: &'a mut Session) -> Self {
        Self { spec, session }
    }
    // 厂商私有辅助（接口表取用、解析纯函数…）放 inherent impl 里
}

impl<'a> CampusAdapter for ExampleAdapter<'a> {
    fn spec(&self) -> &'static SchoolSystemSpec { self.spec }

    fn warm_login_session(&mut self) -> Result<()> { /* 需要预热的写；不需要就 Ok(()) */ }
    fn probe_session(&mut self) -> Result<bool> { /* 200=true，302=false */ }
    fn fetch_captcha(&mut self) -> Result<String> { /* base64 图 */ }
    fn login(&mut self, login_name: &str, password: &str, captcha: &str) -> Result<LoginOutcome> { … }
    fn fetch_page_vars(&mut self, wanted: Option<i64>) -> Result<PageVars> { … }
    fn fetch_timetable(&mut self, semester_id: i64) -> Result<TimetableSnapshot> { … }
    // fetch_course_detail / fetch_program_info 是可选能力：不实现 = 「不支持」，
    // 但 spec 的能力位开了就必须实现（两层互为印证）。
}
```

写法上的仓库惯例：

- **解析全用纯函数 + 单测**（手写解析，不引 regex/scraper 依赖），真实样本逐字照抄进测试；
- 请求失败必须**有话说**：对齐 `supwisdom.rs::login_failure` 的情形兜底风格；
- 归一化只产出 `TimetableSnapshot`：没有的数据留空，**绝不编**（树维没有节次表就空着）。

## 3. `base.rs`：接上分派（漏了编译不过——这是刻意的）

```rust
pub enum AnyAdapter<'a> {
    Supwisdom(SupwisdomAdapter<'a>),
    Zfsoft(ZfsoftAdapter<'a>),
    Example(ExampleAdapter<'a>),          // ← 新增变体
}

// AnyAdapter::new 的穷尽 match 加一臂：
LoginStrategy::ExampleFormRsa { .. } => Self::Example(ExampleAdapter::new(spec, session)),
```

`AnyAdapter` 的 trait 委托是均匀的（每臂同型），不需要按厂商分支。

## 4. `adapters/mod.rs` 与 `campus/mod.rs`

- `adapters/mod.rs`：`pub mod example;` + 分层文档里补一行。
- `campus/mod.rs` 的分层地图注释同步。

## 5. 前端与 mock（能力位开着的才需要动 UI）

- 入口显隐已按能力位自动化（`stores/campus.ts::capabilities`），**不需要为新厂商写任何
  厂商判断**；登录表单若握手差异大（验证码时机等），在 `CampusSettingsPage.vue` 按
  `loginStrategy` 处理（先例：正方的人工取验证码入口）。
- `src/mock/server.ts` 的 `campus_systems` 加同形一条（与 REGISTRY 同序同形，含能力位），
  不支持的命令在 mock 里照 Rust 的口径失败。

## 6. 真机测试 + 文档

```rust
#[test]
#[ignore = "打真实教务系统，需要 REIN_EXAMPLE_USER / REIN_EXAMPLE_PASS"]
fn live_example_roundtrip() {
    // 登录 → 探针 → 学期 → 课表，四段各一个断言 + println 进度
}
```

凭据只从环境变量读。最后把本模板填成 `docs/adapters/<vendor>.md` 放进同一 PR。

## 7. 提 PR 前自查

- [ ] `cargo check --lib` / `cargo test --lib` 全绿（分派漏接在这里就会红）；
- [ ] `npm run typecheck` / `lint` / `contract` 全绿；
- [ ] 抓包材料脱敏（无密码 / Cookie / 验证码答案，学号姓名打码）；
- [ ] 能力位与 trait 实现互为印证（位开 = 已实现；位关 = 吃默认回执）；
- [ ] mock 的 `campus_systems` 与 REGISTRY 同序同形；
- [ ] `docs/adapters/<vendor>.md` 实战记录随 PR 附上；
- [ ] 真机用例 `-- --ignored` 手动跑过一次。
