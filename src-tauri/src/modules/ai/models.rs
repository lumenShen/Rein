//! AI 域数据模型 · 与前端 `src/types/ai.ts` 对应。

use serde::{Deserialize, Serialize};

/// 一条从文字/照片解析出的食物估计
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFoodItem {
    /// 命中食物库时的 id；未命中为 null（前端不写入记录）
    pub food_id: Option<i64>,
    pub food_name: String,
    pub grams: f64,
    pub kcal_estimate: f64,
    /// 0~1；关键词解析给低置信度，接入 LLM 后提高
    pub confidence: f64,
    pub note: Option<String>,
}

use crate::modules::nutrition::models::DailyTargets;

/// 目标调整建议中的单项变更（展示 old → new）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetChange {
    pub field: String,
    pub label: String,
    pub unit: String,
    pub from: f64,
    pub to: f64,
}

/// AI 目标调整建议：完整新目标 + 变更清单 + 面向用户的解释
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetAdjustProposal {
    pub targets: DailyTargets,
    pub changes: Vec<TargetChange>,
    pub reply: String,
}

/* ---------- 模型配置（用户添加，前端 pi-ai 运行时使用） ---------- */

/// 一条用户添加的 AI 模型配置，含能力探测结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: i64,
    pub name: String,
    /// UI 预设标识（deepseek | openai-compatible | rein-online），请求格式按 base_url 自动探测
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    pub is_default: bool,
    pub vision: Option<bool>,
    pub thinking: Option<bool>,
    pub effort: Option<bool>,
    /// 发给模型的图片最长边（像素）；NULL 用前端默认
    pub image_max_edge: Option<i64>,
    pub last_error: Option<String>,
    /// manual = 用户自填（BYOK）；online = 由 Rein 在线服务下发导入
    pub source: String,
    /// online 模型的来源服务地址；同步时按 (service_base, model_id) 认领
    pub service_base: Option<String>,
    /// 单价（元 / 百万 tokens），来自服务端；NULL = 不计模型费
    pub price_in: Option<f64>,
    pub price_out: Option<f64>,
    pub price_currency: Option<String>,
    /// 该服务的出方向流量单价（元 / GB）
    pub traffic_per_gb: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

/// 添加/编辑模型表单
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInput {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    pub is_default: bool,
    pub image_max_edge: Option<i64>,
    /// 手动模型的可选单价（元/百万 tokens）；online 模型忽略这两个字段（以服务端为准）
    #[serde(default)]
    pub price_in: Option<f64>,
    #[serde(default)]
    pub price_out: Option<f64>,
}

/// max_tokens=1 探测包结果：三项能力均需两次探测全过才算支持；error 记录整轮失败原因
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProbeResult {
    pub vision: Option<bool>,
    pub thinking: Option<bool>,
    pub effort: Option<bool>,
    pub error: Option<String>,
}

/* ---------- Rein 在线服务（模型由服务端下发 + 密钥鉴权 + 成本） ---------- */

/// 在线服务设置：服务地址 + 服务端签发的密钥。与语音/更新的凭据一样存 app_meta。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineServiceSettings {
    pub base_url: String,
    /// 服务端签发的客户端密钥（rein_sk_…）—— 没有它就换不到模型目录
    pub api_key: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

impl Default for OnlineServiceSettings {
    fn default() -> Self {
        Self {
            base_url: super::super::update::DEFAULT_SERVICE_BASE.to_string(),
            api_key: String::new(),
            saved_at: None,
        }
    }
}

/// 服务端下发的单个模型：能不能用、单价多少都由服务端说了算。
/// Deserialize 也要：目录快照要能从 app_meta 里读回来（冷启动第一眼显示上次的状态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineModel {
    pub id: String,
    pub provider_id: String,
    pub provider_name: String,
    /// 元 / 百万 tokens（官方价，服务端不溢价）
    pub price_in: f64,
    pub price_out: f64,
    /// false = 服务端没登记价格，只计流量费（客户端据此显示「未定价」）
    pub priced: bool,
    pub currency: String,
    pub unit: String,
}

/// 一次「密钥换目录」的结果：能用哪些模型、单价多少、流量怎么计。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineCatalog {
    pub base_url: String,
    pub ok: bool,
    /// ready | not_configured | unauthorized | unreachable
    pub status: String,
    pub models_endpoint: String,
    pub chat_endpoint: String,
    pub currency: String,
    pub traffic_per_gb: f64,
    /// egress | ingress | both
    pub traffic_scope: String,
    pub client_name: Option<String>,
    /// 密钥可见的模型白名单（空 = 全部）
    pub client_models: Vec<String>,
    /// 服务端给的账号状态原文（如「正常」「余额不足」「已限流」）；缺省 = 服务端没报
    pub client_status: Option<String>,
    /// 服务端给的账号备注原文（额度、到期、限流原因…）；缺省 = 没有
    pub client_note: Option<String>,
    pub models: Vec<OnlineModel>,
    pub error: Option<String>,
    pub checked_at: String,
    pub elapsed_ms: u64,
}

/// 服务端记的账（客户端拿它跟本机账本对账）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineUsage {
    pub ok: bool,
    pub base_url: String,
    pub days: i64,
    pub calls: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub bytes_in: i64,
    pub bytes_out: i64,
    pub cost_tokens: f64,
    pub cost_traffic: f64,
    pub cost_total: f64,
    pub currency: String,
    pub error: Option<String>,
}

/// 同步结果：服务端清单之外的同源模型会被清掉，所以三类计数都要回给用户看。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSyncResult {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub models: Vec<AiModel>,
}

/* ---------- 本机成本账本（金额一律纳元：1e-9 元） ---------- */

/// 记一笔用量：token 数来自模型返回的 usage，成本由前端按单价算好（服务端为权威口径）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageInput {
    pub chat_id: Option<String>,
    pub model_pk: Option<i64>,
    pub model_name: String,
    pub model_id: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub request_bytes: i64,
    #[serde(default)]
    pub response_bytes: i64,
    #[serde(default)]
    pub cost_model_nano: i64,
    #[serde(default)]
    pub cost_traffic_nano: i64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageTotals {
    pub calls: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub request_bytes: i64,
    pub response_bytes: i64,
    pub cost_model_nano: i64,
    pub cost_traffic_nano: i64,
    pub cost_total_nano: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageDay {
    pub date: String,
    #[serde(flatten)]
    pub totals: AiUsageTotals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageByModel {
    pub model_pk: Option<i64>,
    pub model_name: String,
    pub model_id: String,
    pub source: String,
    #[serde(flatten)]
    pub totals: AiUsageTotals,
}

/// 本机累计成本：总账 + 今日 + 按天 + 按模型（服务端另有权威账本，两者可对账）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSummary {
    pub days: i64,
    pub since: String,
    pub today: AiUsageTotals,
    pub total: AiUsageTotals,
    pub by_day: Vec<AiUsageDay>,
    pub by_model: Vec<AiUsageByModel>,
}

/* ---------- 聊天历史 ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChat {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 一条聊天消息；图片保存为压缩缩略图（前端渲染与多轮上下文复用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub id: String,
    pub chat_id: String,
    pub seq: i64,
    pub role: String,
    /// text | photo | food-parse | analysis
    pub kind: String,
    pub text: Option<String>,
    pub image_base64: Option<String>,
    pub mime: Option<String>,
    /// food-parse 等结构化消息的 JSON
    pub payload: Option<String>,
    pub created_at: String,
    /// 所属回合的锚点消息 id（= 回合内最后一条 terminal assistant，或没有 terminal 时的最后一条 assistant）。
    /// 派生列：由 `ai_chat_append` 维护，历史行由 0054 迁移 / 分页前的懒回填补齐。
    pub anchor_id: Option<String>,
}

/// 一页会话消息：按完整回合切页，游标是数值 seq 边界（不要求对应消息仍存在）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatPage {
    /// 按 seq 升序；整回合，不跨页切分 user 回合。
    pub messages: Vec<AiChatMessage>,
    /// 该会话的消息总数（不受本页截断影响），供虚拟列表估算总高度。
    pub total: i64,
    pub has_more_before: bool,
    pub has_more_after: bool,
    /// 上一页的 exclusive 上界（`has_more_before=false` 时为 None）。
    pub next_before_seq: Option<i64>,
    /// 下一页的 exclusive 下界（`has_more_after=false` 时为 None）。
    pub next_after_seq: Option<i64>,
}

/// 追加消息（id 为前端生成的唯一串，重复调用幂等）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessageInput {
    pub id: String,
    pub role: String,
    pub kind: String,
    pub text: Option<String>,
    pub image_base64: Option<String>,
    pub mime: Option<String>,
    pub payload: Option<String>,
}

/// 跨会话搜索命中（含所属会话标题，供 AI 工具「搜索全部上下文」）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchHit {
    /// 命中消息 id：供 `ai_chat_page_around` 跳转并高亮。
    pub message_id: String,
    pub chat_id: String,
    pub chat_title: String,
    pub seq: i64,
    pub role: String,
    pub kind: String,
    pub text: Option<String>,
    pub created_at: String,
}
