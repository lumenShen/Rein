//! AI 域：文字食物解析（本地关键词）/ 模型配置存储 / 聊天历史 / Rein 在线服务接入。
//!
//! - 文字解析仍为「关键词 + 数量词」本地解析器（无网络依赖）。
//! - 模型配置（`ai_models`）与聊天历史（`ai_chats` / `ai_chat_messages`）
//!   仅做持久化，模型请求和 max_tokens=1 能力探测都在前端 WebView 内执行。
//!   （正在迁移：`agent` 模块把这些下沉到 Rust，迁移完成前两者并存。）
//! - `online.rs` 是 Rein 在线服务的客户端：用服务密钥换模型目录、按服务端清单落库、
//!   与服务端对账成本；本机账本（`ai_usage`）由前端按单价记，服务端账本为权威口径。
//! - `providers.rs` 是「服务商账号 + 模型目录」：静态适配器注册表 + 拉 `/models` 清单；
//!   启用某个模型时才落到真正的执行位（LLM → `ai_models`；ASR → 语音配置；向量 → 知识库设置）。
//! - `agent` 是 AI 内核（自 EffiBuddy kernel 移植）：OpenAI 兼容流式后端 +
//!   agent 工具循环 + 能力探测，LLM 流量与探测请求由 Rust 直发。

pub mod agent;
pub mod chat_page;
pub mod commands;
pub mod models;
pub mod online;
pub mod providers;
