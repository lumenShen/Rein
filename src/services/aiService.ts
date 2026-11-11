/** AI 域 IPC 封装 · 对应 modules/ai/commands.rs */

import type {
  AiChat,
  AiChatMessage,
  AiChatMessageInput,
  AiModel,
  AiModelInput,
  AiProbeResult,
  AiUsageInput,
  AiUsageSummary,
  ChatSearchHit,
  DailyTargets,
  ParsedFoodItem,
  TargetAdjustProposal,
} from '@/types'
import { invoke } from './transport'

/**
 * 会话分页结果（`ai_chat_page` / `ai_chat_page_around`）。
 *
 * 形状与 Rust `AiChatPage` 逐字段对齐（camelCase）；这里先本地声明，
 * 等 D 域把同一个接口加进 `types/ai.ts` 后仍保持结构兼容。
 * 游标是 **seq 数值边界**，不要求对应消息仍然存在（撤回会留下 seq 空洞，
 * 由 `ai_chat_seq` 保证不复用）。
 */
export interface AiChatPage {
  /** 升序，整回合；首条 user 之前的 legacy assistant 也会带回来 */
  messages: AiChatMessage[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  /** 下一页 exclusive 上界（向上翻） */
  nextBeforeSeq: number | null
  /** 下一页 exclusive 下界（向下翻） */
  nextAfterSeq: number | null
}

export const aiService = {
  /** 文字描述 → 食物列表（如："一个苹果和一碗米饭"） */
  parseFoodText: (text: string) => invoke<ParsedFoodItem[]>('ai_parse_food_text', { text }),

  /** 自然语言 → 每日目标调整建议（不直接生效，由用户确认） */
  parseTargetAdjust: (text: string, current: DailyTargets) =>
    invoke<TargetAdjustProposal>('ai_parse_target_adjust', { text, current }),

  /* ---- 模型配置 ---- */

  aiModelList: () => invoke<AiModel[]>('ai_model_list', {}),
  aiModelAdd: (input: AiModelInput) => invoke<AiModel>('ai_model_add', { input }),
  aiModelUpdate: (id: number, input: AiModelInput) => invoke<void>('ai_model_update', { id, input }),
  aiModelDelete: (id: number) => invoke<void>('ai_model_delete', { id }),
  aiModelSetDefault: (id: number) => invoke<void>('ai_model_set_default', { id }),
  aiModelSaveProbe: (id: number, result: AiProbeResult) =>
    invoke<void>('ai_model_save_probe', { id, result }),

  /* ---- 聊天历史 ---- */

  aiChatEnsure: (id: string, title?: string | null) =>
    invoke<AiChat>('ai_chat_ensure', { id, title: title ?? null }),
  aiChatMessages: (chatId: string) => invoke<AiChatMessage[]>('ai_chat_messages', { chatId }),
  /** 按完整回合分页（D 域命令）。`beforeSeq` / `afterSeq` 互斥，均为 exclusive。 */
  aiChatPage: (chatId: string, beforeSeq?: number | null, afterSeq?: number | null, limitTurns?: number | null) =>
    invoke<AiChatPage>('ai_chat_page', {
      chatId,
      beforeSeq: beforeSeq ?? null,
      afterSeq: afterSeq ?? null,
      limitTurns: limitTurns ?? null,
    }),
  /** 以某条消息所在回合收尾的一页（记忆卡「查看原文」跳转用）。 */
  aiChatPageAround: (chatId: string, messageId: string, limitTurns?: number | null) =>
    invoke<AiChatPage>('ai_chat_page_around', {
      chatId,
      messageId,
      limitTurns: limitTurns ?? null,
    }),
  aiChatAppend: (chatId: string, input: AiChatMessageInput) =>
    invoke<void>('ai_chat_append', { chatId, input }),
  aiChatClear: (chatId: string) => invoke<void>('ai_chat_clear', { chatId }),
  aiChatCut: (chatId: string, messageId: string) =>
    invoke<void>('ai_chat_cut', { chatId, messageId }),
  aiChatList: () => invoke<AiChat[]>('ai_chat_list', {}),
  aiChatRename: (id: string, title: string) => invoke<void>('ai_chat_rename', { id, title }),
  aiChatSearch: (keyword: string, limit?: number) =>
    invoke<ChatSearchHit[]>('ai_chat_search', { keyword, limit: limit ?? null }),

  /* ---- 本机成本账本（服务端另有权威账本，可对账） ---- */

  aiUsageRecord: (input: AiUsageInput) => invoke<void>('ai_usage_record', { input }),
  aiUsageSummary: (days?: number) => invoke<AiUsageSummary>('ai_usage_summary', { days: days ?? null }),
  aiUsageClear: () => invoke<void>('ai_usage_clear', {}),
}
