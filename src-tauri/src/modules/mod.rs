//! 业务模块。每个子模块 = 一个领域，内部固定三件套：
//! `models.rs`（数据结构）/ `commands.rs`（Tauri 命令 + SQL）/ 可选共享辅助放 `mod.rs`。

pub mod ai;
pub mod campus;
pub mod diet;
pub mod exercise;
pub mod exercise_lib;
pub mod float;
pub mod gateway;
pub mod healthsync;
pub mod kb;
pub mod ledger;
pub mod maintenance;
pub mod media;
pub mod nutrition;
pub mod plan;
pub mod pomodoro;
pub mod program;
pub mod seed;
pub mod session;
pub mod share;
pub mod sync;
pub mod todo;
pub mod tracking;
pub mod update;
pub mod voice;
pub mod web;
