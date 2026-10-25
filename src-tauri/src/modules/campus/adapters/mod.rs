//! 教务系统适配层：把「对接各家教务系统」收拢成一个社区可贡献的单元。
//!
//! # 贡献者地图：把你的学校接进 Rein
//!
//! 按代价从小到大两条路，抓包与提交流程见 `docs/adapters/README.md`：
//!
//! 1. **同厂商的新学校**（最常见，通常不到 20 行）：贵校教务系统与在册某家
//!    同厂商（树维 / 正方），只在 [`provider::REGISTRY`] 末尾加一条
//!    [`provider::SchoolSystemSpec`] —— 前端学校选择器自动多一个选项，
//!    登录表单按 [`provider::LoginStrategy`] 自动渲染，其余代码一行不动。
//! 2. **新厂商**：实现 `base::CampusAdapter` 的全部方法；在
//!    [`provider::LoginStrategy`] 加一个变体（登录握手数据）、
//!    [`base::AnyAdapter::new`] 的穷尽 match 加一臂（漏接编译期报错）、
//!    spec 里声明能力位；并写一份 `docs/adapters/<厂商>.md` 实战说明。
//!
//! # 内部分层
//!
//! - [`base`] —— 适配器统一接口与分派：命令层只认「登录 / 学期 / 课表」这些
//!   动作，谁来干由这里决定。
//! - [`provider`] —— 声明式数据层：哪所学校、哪套登录握手、打哪些接口、有哪些能力。
//! - [`supwisdom`] / [`zfsoft`] —— 厂商适配器实现（树维 EAMS5 / 正方 zftal）。

pub mod base;
pub mod provider;
pub mod supwisdom;
pub mod zfsoft;
