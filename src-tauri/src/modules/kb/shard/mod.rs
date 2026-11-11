//! 长期记忆分片层（方案 §2–§7）。
//!
//! 目录职责（§10 施工域 A）：
//! - `model`    共享类型、参数常量、序列化结构（§7.2）
//! - `store`    shard CRUD、jobs、backfill、conversation extract（A）
//! - `history`  history 追加/读取/重放/命中计数（A）
//! - `decay`    遗忘公式、状态判定、sweep（A）
//! - `anchor`   回合锚点查询与同步消息补锚（A）
//! - `retrieve` 主动检索与强化（B）
//! - `inject`   自动注入选择/预算/渲染（B）
//! - `dream`    Dream gate/context/apply/cancel 命令（C）
//! - `commands` §7.1 #1–#15 的 shard 命令（B）
//!
//! 本文件由 A 域独占；B/C 只填各自文件，不改这里（§12 合并纪律）。

pub mod anchor;
pub mod commands;
pub mod decay;
pub mod dream;
pub mod history;
pub mod inject;
pub mod model;
pub mod retrieve;
pub mod store;

pub use model::*;
