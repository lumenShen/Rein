/** AI 域类型 · 与 Rust `modules/ai` 对应 */

import type { DailyTargets } from './nutrition'
import type { MealType } from './diet'
import type { KbEntry } from './kb'

export interface ParsedFoodItem {
  foodId: number | null
  foodName: string
  grams: number
  kcalEstimate: number
  /** 0~1，关键词解析给低置信度，未来接入视觉/LLM 后提高 */
  confidence: number
  note: string | null
}

/** 可被 AI 调整的目标字段（DailyTargets 的键） */
export type TargetField = keyof DailyTargets

/** 目标调整建议中的单项变更（展示 old → new） */
export interface TargetChange {
  field: TargetField
  label: string
  unit: string
  from: number
  to: number
}

/** AI 目标调整建议：完整新目标 + 变更清单 + 面向用户的解释 */
export interface TargetAdjustProposal {
  targets: DailyTargets
  changes: TargetChange[]
  reply: string
}

export type AiRole = 'user' | 'assistant'

export type AiMessageKind =
  | 'text' // 纯文本气泡（Markdown 渲染）
  | 'photo' // 用户上传的照片气泡（imageBase64 为压缩缩略图）
  | 'doc' // 用户上传的 Office 文档气泡（含解析文本与选中图片）
  | 'food-parse' // 附带可确认的食物解析卡片
  | 'analysis' // 今日饮食分析卡片
  | 'tools' // AI 工具调用过程卡（可折叠）
  | 'voice' // 用户语音轮：转写文本 + 关联纪要（点开语音会话视图回看/重放）

/** 单次工具调用的过程记录（持久化在 payload.calls） */
export interface ToolCallRecord {
  name: string
  /** 中文短名（注册表 label） */
  label: string
  /** 入参摘要（截断 JSON） */
  argsBrief: string
  /** 结果摘要；执行中为 null */
  resultBrief: string | null
  status: 'running' | 'ok' | 'error'
  /** 工具返回的图片（放大镜结果），随过程卡展示 */
  resultImage?: { base64: string; mime: string }
  /** 放大镜结果图的注册 id 与视图尺寸（历史重建时恢复可继续放大） */
  zoomId?: string
  zoomW?: number
  zoomH?: number
  /** 放大区域在根位图坐标中的区域（历史重建时恢复「裁原图」语义） */
  zoomRect?: { x: number; y: number; w: number; h: number }
}

/** kind=doc 消息携带的文档信息（持久化在 payload.doc） */
export interface AiDocMeta {
  name: string
  kind: 'docx' | 'pptx' | 'xlsx' | 'text'
  /** 抽取文本（已截断，随用户轮发给模型） */
  text: string
  /** 全文（未截断，仅本轮内存）：发送时自动归档进知识库 文档/ 命名空间，AI 经分页读全文 */
  fullText?: string
  chars: number
  truncated: boolean
  imagesTotal: number
  skippedImages: number
}

/** 推理过程段里的单次工具调用（照搬 EffiBuddy ToolCallRecord 展示形态） */
export interface ProcessToolCall {
  callId: string
  /** 展示名（注册表中文短名 label）；rawName 为匹配工具结果的原始名 */
  toolName: string
  rawName?: string
  /** 原始 JSON 字符串参数 */
  arguments: string
  /** 执行结果（未到达时为 null） */
  result: string | null
  isError: boolean
  /** 是否正在执行中 */
  pending: boolean
  /** 工具返回的图片（放大镜结果），随详情展示 */
  resultImage?: { base64: string; mime: string }
  /** 放大镜结果图的注册 id 与视图尺寸（历史重建时恢复可继续放大） */
  zoomId?: string
  zoomW?: number
  zoomH?: number
  /** 放大区域在根位图坐标中的区域（历史重建时恢复「裁原图」语义） */
  zoomRect?: { x: number; y: number; w: number; h: number }
}

/** 推理过程段：按流式到达顺序穿插的「思考文字 / 工具调用」片段，
 * 用于把工具执行结果插入到思考文字之间展示，而非与思考文字隔开单独成块。 */
export type ProcessSegment =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; call: ProcessToolCall }

export interface AiMessage {
  id: string
  /** 会话内单调 seq（分页游标；仅从持久化历史恢复时存在，本地新消息为 undefined） */
  seq?: number
  /** 所属回合的锚点消息 id（后端 anchor_id；与 MemoryShard.anchorMessageId 同值） */
  anchorId?: string | null
  role: AiRole
  kind: AiMessageKind
  at: string
  text?: string
  /** kind=food-parse 时的解析结果 */
  items?: ParsedFoodItem[]
  /** 解析结果是否已写入今日饮食 */
  committed?: boolean
  /** 确认写入时选择的餐次（payload 持久化；旧数据没有） */
  mealType?: MealType
  /** 建卡时模型给的条目快照（payload 持久化）：用来判断用户是否改过数值 */
  proposal?: { foodName: string; grams: number }[]
  /** 解析来源（写入饮食记录时使用） */
  source?: 'photo_ai' | 'text_ai'
  /** kind=photo 时的压缩缩略图（base64，无 data: 前缀） */
  imageBase64?: string
  mime?: string
  /** kind=doc 时的文档信息 */
  doc?: AiDocMeta
  /** 多图消息（kind=doc / photo）：随消息发给模型的图片；w/h 为发给模型的视图尺寸，label 为图片清单说明 */
  images?: { base64: string; mime: string; w: number; h: number; label: string }[]
  /** 图片清单文本（含 img-xx 编号与视图尺寸），随用户轮发给模型供放大镜引用 */
  imgNote?: string
  /** LLM 回复的思考内容（气泡上方可折叠展示） */
  thinking?: string
  /** 推理过程段（思考文字与工具调用按到达顺序穿插；持久化在 payload.segments） */
  segments?: ProcessSegment[]
  /** 已完成思考段的累计秒数（跨段累加；持久化在 payload.thinkingSec） */
  thinkingSec?: number
  /** 被引用的消息文本（发送时引用了某条消息） */
  quoteText?: string
  /** kind=tools 时本轮流次的工具调用记录 */
  toolCalls?: ToolCallRecord[]
  /** kind=voice 时关联的纪要信息（payload 持久化；点气泡打开语音会话回看/重放） */
  voiceMeta?: { memoId: string; durationMs: number; words: number }
  /**
   * AI 挂出的工作区文件卡片（`present_file` 的产出；持久化在 payload.files）。
   * 条目形状与文件管理器同一份（KbEntry）：点开就是阅读器 / 文件管理器里的那个文件。
   */
  files?: KbEntry[]
  /** 流式生成中（仅内存占位气泡；定稿/出错即清除，不持久化） */
  streaming?: boolean
}

/* ---------- 模型配置（Rust modules/ai · ai_models） ---------- */

/** 一条用户添加的 AI 模型配置；能力探测结果三态：null=未知 */
export interface AiModel {
  id: number
  name: string
  /** UI 预设标识（deepseek | openai-compatible | rein-online），请求格式按 baseUrl 自动探测 */
  provider: string
  baseUrl: string
  apiKey: string
  modelId: string
  isDefault: boolean
  vision: boolean | null
  thinking: boolean | null
  effort: boolean | null
  /** 发给模型的图片最长边（像素）；null = 用前端默认（DEFAULT_IMAGE_EDGE） */
  imageMaxEdge: number | null
  lastError: string | null
  /** manual = 自己填的（BYOK）；online = 由 Rein 在线服务下发导入 */
  source: string
  /** online 模型的来源服务地址 */
  serviceBase: string | null
  /** 单价（元 / 百万 tokens）；null = 不计模型费（自填 key 的模型默认如此） */
  priceIn: number | null
  priceOut: number | null
  priceCurrency: string | null
  /** 该服务的出方向流量单价（元 / GB），服务端下发 */
  trafficPerGb: number | null
  createdAt: string
  updatedAt: string
}

/** 添加/编辑模型表单 */
export interface AiModelInput {
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  modelId: string
  isDefault: boolean
  /** 图片发送分辨率上限；缺省/null 用前端默认 */
  imageMaxEdge?: number | null
  /** 单价（元/百万 tokens），可空；online 模型忽略（以服务端为准） */
  priceIn?: number | null
  priceOut?: number | null
}

/** max_tokens=1 探测包结果 */
export interface AiProbeResult {
  vision: boolean | null
  thinking: boolean | null
  effort: boolean | null
  error: string | null
}

/* ---------- AI 内核（Rust agent，见 src-tauri/src/modules/ai/agent） ---------- */

/** 消息里的图片（base64 无 data: 前缀） */
export interface AgentImage {
  data: string
  mime: string
}

/** 发给内核的 LlmMessage（历史回灌与本轮输入共用形状） */
export interface AgentMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string | null
  toolCalls?: { id: string; name: string; arguments: unknown }[]
  images?: AgentImage[]
  reasoning?: string | null
}

/** 工具定义（JSON Schema；过渡期由前端注册表提供，Phase 4 起内核自带） */
export interface AgentToolDef {
  name: string
  description: string
  parameters: unknown
}

/** ai_agent_run 入参 */
export interface AgentRunParams {
  /** ai_models 主键（baseUrl / apiKey / modelId 由 Rust 读库） */
  modelId: number
  systemPrompt: string | null
  messages: AgentMessageInput[]
  prompt: string
  images?: AgentImage[]
  tools?: AgentToolDef[]
  toolGroups?: string[]
  thinkingLevel?: string | null
  temperature?: number | null
  maxTokens?: number | null
}

/** 工具执行结果（过渡期由前端回传） */
export interface AgentToolOutcome {
  content: string
  isError: boolean
  images?: AgentImage[]
}

/** 内核流式事件（ai://agent） */
export type AgentEvent =
  | { type: 'started'; runId: string }
  | { type: 'textDelta'; runId: string; delta: string }
  | { type: 'thinkingDelta'; runId: string; delta: string }
  | { type: 'thinkingEnd'; runId: string; content: string }
  | { type: 'stepRetry'; runId: string; attempt: number; delayMs: number }
  /** `kernel` = 由 Rust 注册表执行：前端不要再跑 TS 侧同名工具（重复执行＝副作用做两遍） */
  | { type: 'toolStarted'; runId: string; callId: string; name: string; args: unknown; kernel: boolean }
  | {
      type: 'toolCompleted'
      runId: string
      callId: string
      name: string
      isError: boolean
      content: string
      /** 同 toolStarted.kernel：内核工具才由前端补发 tool_execution_end */
      kernel: boolean
    }
  | { type: 'usage'; runId: string; usage: AgentUsage }
  | {
      type: 'done'
      runId: string
      text: string
      thinking: string | null
      usage: AgentUsage | null
      stopReason: string
      steps: number
      tools: number
      durationMs: number
    }
  | { type: 'error'; runId: string; message: string }

/** 终稿 assistant 消息（入口读 content 块与 usage；形状对齐 pi 的 AssistantMessage） */
export interface AgentFinalMessage {
  role: string
  content: unknown
  /** 历史回灌时携带的时间戳（内核忽略，保留以兼容既有历史构造代码） */
  timestamp?: number
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }
  stopReason?: string
}

/** token 用量（input 已扣除缓存命中/写入，口径与 pi-ai 一致） */
export interface AgentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

/* ---------- Rein 在线服务（模型由服务端下发 · 密钥 · 成本） ---------- */

export interface OnlineServiceSettings {
  baseUrl: string
  /** 服务端签发的客户端密钥（rein_sk_…） */
  apiKey: string
  savedAt: string | null
}

/** 服务端下发的单个模型 */
export interface OnlineModel {
  id: string
  providerId: string
  providerName: string
  /** 元 / 百万 tokens（官方价） */
  priceIn: number
  priceOut: number
  /** false = 服务端未登记价格，只计流量费 */
  priced: boolean
  currency: string
  unit: string
}

/** 用密钥换来的模型目录 */
export interface OnlineCatalog {
  baseUrl: string
  ok: boolean
  /** ready | not_configured | unauthorized | forbidden | error | unreachable */
  status: string
  modelsEndpoint: string
  chatEndpoint: string
  currency: string
  trafficPerGb: number
  /** egress | ingress | both */
  trafficScope: string
  clientName: string | null
  /** 密钥可见的模型白名单（空 = 全部） */
  clientModels: string[]
  /** 服务端给的账号状态原文（如「正常」「余额不足」）；缺省 = 服务端没报 */
  clientStatus: string | null
  /** 服务端给的账号备注原文（额度、限流原因…）；缺省 = 没有 */
  clientNote: string | null
  models: OnlineModel[]
  error: string | null
  checkedAt: string
  elapsedMs: number
}

/** 服务端记的账（与本机账本对账用） */
export interface OnlineUsage {
  ok: boolean
  baseUrl: string
  days: number
  calls: number
  promptTokens: number
  completionTokens: number
  bytesIn: number
  bytesOut: number
  costTokens: number
  costTraffic: number
  costTotal: number
  currency: string
  error: string | null
}

export interface OnlineSyncResult {
  added: number
  updated: number
  removed: number
  models: AiModel[]
}

/* ---------- 提供商：服务商账号 + 模型目录（Rust modules/ai/providers.rs） ---------- */

/** 模型类别（决定「启用」落到哪个执行位） */
export type ProviderModelKind = 'llm' | 'vision' | 'asr' | 'embedding' | 'tts'

/** 适配器支持的一种接入方式（表单里的「API 计划」选项） */
export interface ProviderAdapterStyle {
  id: string
  label: string
  /** 默认网关地址（可改；改错能一键恢复） */
  baseUrl: string
  note: string
}

/** 适配器专属凭据字段（按 secret 决定用密钥输入还是普通输入） */
export interface ProviderAdapterField {
  key: string
  label: string
  hint: string
  secret: boolean
  placeholder: string
}

/** 内置参考目录里的一条模型（接口不可用时兜底显示） */
export interface ProviderPresetModel {
  id: string
  kind: ProviderModelKind
  dim: number | null
  note: string
}

/** 一个提供商适配器（静态注册表，Rust 是唯一真源，前端不另抄一份） */
export interface ProviderAdapter {
  id: string
  label: string
  /** 默认昵称：模型名前缀与折叠分组都用它 */
  nickname: string
  hint: string
  docs: string
  keyHint: string
  /** 模型清单接口路径；空 = 该适配器没有 /models 接口 */
  modelsPath: string
  styles: ProviderAdapterStyle[]
  kinds: ProviderModelKind[]
  extraFields: ProviderAdapterField[]
  preset: ProviderPresetModel[]
}

/** 提供商目录里的一条模型；启用状态由前端按执行位现算（见 stores/modelRoles） */
export interface AiProviderModel {
  providerId: number
  modelId: string
  kind: ProviderModelKind
  /** api = /models 拉到；preset = 适配器内置参考；manual = 手填 */
  origin: 'api' | 'preset' | 'manual'
  /** 元信息 JSON（dim / priceInPerToken / priceOutPerToken / note） */
  meta: string | null
  fetchedAt: string
}

/** 解析后的元信息 */
export interface ProviderModelMeta {
  dim?: number
  priceInPerToken?: number
  priceOutPerToken?: number
  note?: string
}

export interface AiProvider {
  id: number
  adapter: string
  name: string
  baseUrl: string
  apiKey: string
  apiStyle: string
  /** 适配器专属字段 JSON（如 {"appId":"…"}） */
  extra: string | null
  lastError: string | null
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
  models: AiProviderModel[]
}

export interface AiProviderInput {
  id?: number | null
  adapter: string
  name: string
  baseUrl: string
  apiKey: string
  apiStyle: string
  extra?: string | null
}

/** 一次拉取模型清单的结果（fromPreset = 接口没通、列的是内置参考） */
export interface ProviderCatalog {
  ok: boolean
  /** ready | unauthorized | forbidden | not_found | unreachable | error | preset_only */
  status: string
  endpoint: string
  error: string | null
  models: AiProviderModel[]
  elapsedMs: number
  fromPreset: boolean
  fetchedAt: string
}

/** 界面偏好：角色绑定 + 模型列表渲染声明（provider name display / folder） */
export interface AiModelPrefs {
  /** 多模态备选：auto | off | model:<ai_models.id> */
  visionRef: string
  /** ASR 绑定：voice | provider:<providerId>:<modelId> */
  asrRef: string
  /** 向量绑定：'' | local:<模型 id> | cloud:<providerId>:<modelId> */
  embeddingRef: string
  /** true = 模型名前加提供商昵称 */
  providerNameDisplay: boolean
  /** true = 按提供商折叠分组 */
  providerNameFolder: boolean
}

/** 服务模型角色（模型页「服务模型」卡的四行） */
export type ModelRole = 'llm' | 'vision' | 'asr' | 'embedding'

/** 角色选择抽屉里的一行候选 */
export interface ModelCandidate {
  ref: string
  label: string
  sub: string
  /** 提供商昵称（前缀与折叠分组用） */
  provider: string
  kind: ProviderModelKind
  /** 行尾小胶囊（如「未探测」「需下载」） */
  badge?: string
  disabled?: boolean
}

/* ---------- 本机成本账本（金额一律纳元：1e-9 元） ---------- */

export interface AiUsageInput {
  chatId?: string | null
  modelPk?: number | null
  modelName: string
  modelId: string
  provider?: string
  source?: string
  promptTokens?: number
  completionTokens?: number
  requestBytes?: number
  responseBytes?: number
  costModelNano?: number
  costTrafficNano?: number
  note?: string | null
}

export interface AiUsageTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  requestBytes: number
  responseBytes: number
  costModelNano: number
  costTrafficNano: number
  costTotalNano: number
}

export interface AiUsageDay extends AiUsageTotals {
  date: string
}

export interface AiUsageByModel extends AiUsageTotals {
  modelPk: number | null
  modelName: string
  modelId: string
  source: string
}

export interface AiUsageSummary {
  days: number
  since: string
  today: AiUsageTotals
  total: AiUsageTotals
  byDay: AiUsageDay[]
  byModel: AiUsageByModel[]
}

/* ---------- 聊天历史（Rust modules/ai · ai_chats / ai_chat_messages） ---------- */

export interface AiChat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** 持久化消息；food-parse 的 items 序列化在 payload 里 */
export interface AiChatMessage {
  id: string
  chatId: string
  seq: number
  role: AiRole
  kind: AiMessageKind
  text: string | null
  imageBase64: string | null
  mime: string | null
  payload: string | null
  createdAt: string
  /** 所属回合的锚点消息 id（后端派生列；无 assistant 的回合、旧 mock 数据为 null/缺省） */
  anchorId?: string | null
}

export interface AiChatMessageInput {
  id: string
  role: AiRole
  kind: AiMessageKind
  text: string | null
  imageBase64: string | null
  mime: string | null
  payload: string | null
}

/** 跨会话搜索命中（AI 工具「搜索全部上下文」用） */
export interface ChatSearchHit {
  chatId: string
  chatTitle: string
  seq: number
  role: AiRole
  kind: AiMessageKind
  text: string | null
  createdAt: string
}
