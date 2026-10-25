//! 校园教务域：把学校教务系统的课表接进 Rein。
//!
//! 分层（自下而上）：
//! - [`adapters`] —— **教务适配层**（社区共建入口，贡献指南见 `docs/adapters/`）：
//!   - [`adapters::provider`] —— 学校系统选择器。哪所学校、用哪套登录握手、打哪些接口，
//!     全是声明式数据。新增一所学校 = 在 `REGISTRY` 里加一条，前端选择器自动出现。
//!   - [`adapters::base`] —— 适配器统一接口与分派：按 [`adapters::provider::LoginStrategy`]
//!     把调用转给对应的厂商适配器。
//!   - [`adapters::supwisdom`] / [`adapters::zfsoft`] —— 两家厂商的适配器：登录握手、
//!     页面变量解析、课表归一化。前者是树维 Supwisdom EAMS5（桂电在册），
//!     后者是正方 ZFSoft zftal（广西科技大学在册）。
//! - [`http`] —— 带 Cookie 会话的 HTTP 层（项目其它域都是一次性请求，没有会话概念）。
//! - [`dates`] —— 学期口径的换算与命名（周次 ↔ 公历日期、节次 ↔ 时刻、学期显示名）。厂商无关。
//! - [`course_select`] —— 选课/抢课子系统（`/course-selection-api`）客户端，鉴权走门户发的 SSO 令牌。
//! - [`models`] —— 远端 JSON 映射 + 本地落库形状 + IPC 契约。
//! - [`detail`] —— **课程详情组装**：把一次课表拉取的原始 `vm` 压成前端要的 `CourseDetail`
//!   （纯函数、零 IO，可脱离网络单测）。仅树维那套系统有这条路。
//! - [`lesson_search`] —— **全校开课查询**（与选课批次无关）+ 两个域名分别探测。
//!   批次没开的时候靠它看清开课时间地点，再去排志愿。仅树维那套系统有这条路。
//! - [`grab`] —— **自动抢课引擎**（课表的子模块，默认关闭，见 `plugins/builtin/campusGrab.ts`）
//! - [`rescue`] —— **救援面**：把一次任意请求渲染成可重放的 curl、写审计、导出脱机脚本。
//!   引擎管「一切照常」，它管「不照常」——教务改接口、会话被踢、批次规则变了的时候。
//! - [`commands`] —— Tauri 命令 + SQL，以及**周次 → 公历日期**这条全链路唯一的换算。
//!
//! 课表与时间线的关系：`campus_sessions` 是真源，`todos` 里 `course_session_id` 非空的行
//! 是它的**派生只读投影**；切换学期 / 刷新 / 注销时的生命周期见 `commands::materialize_todos`
//! 的文档与 `docs/ARCHITECTURE.md`。
//!
//! **时间轴（动态时间段适配层）**：周视图左列的行轴由 `commands::build_time_axis` 产出 ——
//! 把「学校公布的节次表」（正方单独开了一个接口，落在 `campus_period_slots`）与「实际排课的
//! 节次区间」归一化成一组**互斥片段**，前端据此跨行绘制课块、并按真实时长定行高。
//! 各校作息不一样（有的四十分钟一节、有的一上两节），轴因此是**派生**的而不是写死的节次表；
//! 没有节次表的学校（树维）自动退化为只用排课区间，绝不插值编时刻。

pub mod adapters;
pub mod commands;
pub mod course_select;
pub mod dates;
pub mod detail;
pub mod grab;
pub mod holiday;
pub mod http;
pub mod lesson_search;
pub mod matcher;
pub mod models;
pub mod rescue;
