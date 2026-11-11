//! 知识库与认知层。
//!
//! 一个库装下多种来源：日程/附件、运动、饮食体测、方案/语音/历史聊天，以及 AI 从对话中提炼的
//! 长期记忆（source_type='memory'）。设计要点与取舍见各子文件头部注释，总览：
//!
//! - `source.rs`  源表 → 可检索文档的派生（只读源表，派生结果作为缓存）
//! - `chunk.rs`   文本切块与规范化
//! - `index.rs`   脏队列消费、文档/分块落库、向量存取
//! - `search.rs`  结构化过滤 + FTS5(trigram) + 向量召回 → RRF 融合
//! - `listing.rs` 目录列举：文件管理器的一层 `ls`（完整元数据，走路径索引的前缀范围）
//! - `settings.rs` 三档检索模式与逐类开关
//! - `memory.rs`  长期记忆的增删改与 prompt 注入块
//! - `files.rs`   真实文件（kb_files）：文本笔记 / 多模态节点 / 目录 / 回收站
//! - `assets.rs`  模态层（kb_assets）：本体引用、转写状态与降级链（ai-workspace §2）
//! - `archive.rs` 压缩包：列内容 + 解压进工作区（zip / tar / gz，含 zip-slip 与体积护栏）
//! - `usage.rs`   空间管理：占用总览、大文件排序、孤儿本体清理
//! - `governance.rs` 目录治理：保留区、分类移动、审计与撤销（§3.3）
//! - `injection.rs` 全量注入区：系统提示词 + 用户记忆（§3.4）
//! - `embed.rs`   三种 embedding 后端（本地 ORT / 云端 / 纯关键词）
//! - `embed_models.rs` 本地模型注册表与按需下载（多档可选，见 docs/kb-embed-benchmark.md）
//! - `worker.rs`  后台索引线程（消费脏队列、补算向量、上报进度）

pub mod archive;
pub mod assets;
pub mod chunk;
pub mod commands;
pub mod embed;
pub mod embed_models;
pub mod files;
pub mod governance;
pub mod index;
pub mod injection;
pub mod listing;
pub mod memory;
pub mod models;
pub mod search;
pub mod settings;
pub mod shard;
pub mod source;
pub mod usage;
pub mod worker;
