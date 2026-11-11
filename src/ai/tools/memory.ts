/**
 * 记忆工具：查看 / 主动回忆 / 显式记住 / 忘掉长期记忆。
 *
 * 数据层已迁到 `memory_shards`（分片 + history 唯一真相源）：
 * - 查看与检索走 `memoryShards` / `memorySearch`（主动检索命中才强化）；
 * - 写入 / 编辑 / 删除走 `memoryShardApply` / `memoryShardUpdate` / `memoryShardDelete`。
 * 旧的 `kb_memory_*` 命令仍保留为兼容适配层，但新工具不再依赖它们。
 */

import { Type } from '@earendil-works/pi-ai'

import { kbService } from '@/services/kbService'
import type { KbMemoryType, MemoryShard, ShardPatch, ShardWriteAction } from '@/types'
import { defineTool, type AppTool } from './types'

const MEMORY_TYPES: KbMemoryType[] = [
  'preference',
  'constraint',
  'event',
  'entity',
  'profile',
  'pattern',
]

const TYPE_ENUM = Type.Optional(
  Type.Union(
    MEMORY_TYPES.map((t) => Type.Literal(t)),
    {
      description:
        '记忆类型：preference=偏好（喜欢/讨厌）、constraint=约束（伤病/禁忌/时间限制）、event=事件（做过什么及其原因）、entity=实体（人/地点/器械/课程）、profile=稳定画像（作息/经验水平）、pattern=反复出现的规律。不传默认 preference',
    },
  ),
)

/** 只回给模型看的投影：带 id 便于后续 forget，内容截断防撑上下文。 */
function brief(m: MemoryShard) {
  return {
    id: m.id,
    type: m.memType,
    topic: m.topic || undefined,
    content: m.content.slice(0, 200),
    confidence: Number(m.confidence.toFixed(2)),
    state: m.state,
  }
}

export const memoryTools: AppTool[] = [
  defineTool({
    name: 'list_memories',
    group: 'memory',
    label: '查看长期记忆',
    description:
      '列出已经记住的关于用户的长期记忆（偏好、约束、事件、实体、画像、规律）。' +
      '用户问「你记得我什么」「你了解我哪些」时调用。系统提示词里已经带了最相关的若干条，所以一般不必先调它。',
    parameters: Type.Object({
      memType: TYPE_ENUM,
    }),
    async execute(args) {
      // scope=all 再在本地滤掉 archived：dormant 仍应被「你记得什么」看到。
      const items = await kbService.memoryShards('all', 'curated', 120, 0)
      const visible = items
        .filter((m) => m.state !== 'archived')
        .filter((m) => !args.memType || m.memType === args.memType)
      return {
        total: visible.length,
        items: visible.slice(0, 50).map(brief),
      }
    },
  }),

  defineTool({
    name: 'recall_memory',
    group: 'memory',
    label: '回忆长期记忆',
    description:
      '主动检索长期记忆（比 list_memories 更广：含休眠记忆与对话中提炼的片段）。' +
      '用户问「我之前是不是说过…」「我以前提过…」，或你需要找旧对话里的细节/来源时用它。' +
      '返回 content、relevance，以及 anchorMessageId/chatId 供界面跳回原对话。' +
      '命中会轻微强化记忆，不要对同一话题高频重复调用。',
    parameters: Type.Object({
      query: Type.String({
        description: '检索词，用 2~6 个字的简短关键词（如「膝盖」「睡眠」）；越长越依赖语义向量',
      }),
      topK: Type.Optional(
        Type.Number({ description: '最多返回几条（默认 8，范围 1~20）' }),
      ),
      includeDormant: Type.Optional(
        Type.Boolean({ description: '是否包含休眠记忆（默认 true）' }),
      ),
      includeArchived: Type.Optional(
        Type.Boolean({ description: '是否挖坟已归档记忆（默认 false；只返回，不自动复活）' }),
      ),
    }),
    async execute(args) {
      const query = args.query.trim()
      if (!query) throw new Error('检索词不能为空')
      // reviveArchived 固定 false：工具只读回忆，复活/恢复必须由用户显式操作。
      const r = await kbService.memorySearch(
        query,
        args.topK ?? 8,
        args.includeDormant ?? true,
        args.includeArchived ?? false,
        false,
      )
      return {
        total: r.hits.length,
        mode: r.mode,
        reinforced: r.reinforced,
        items: r.hits.map((h) => ({
          id: h.shardId,
          content: h.content.slice(0, 300),
          type: h.memType,
          topic: h.topic || undefined,
          category: h.category || undefined,
          origin: h.origin,
          state: h.state,
          relevance: Number(h.relevance.toFixed(3)),
          effectiveWeight: Number(h.effectiveWeight.toFixed(3)),
          anchorMessageId: h.anchorMessageId,
          chatId: h.chatId,
        })),
        hint: '命中只是摘要；要展开原对话把 anchorMessageId/chatId 交给界面。',
      }
    },
  }),

  defineTool({
    name: 'remember',
    group: 'memory',
    label: '记住一件事',
    description:
      '把一条关于用户的长期信息写进记忆。**仅当用户明确要求记住时调用**（如「记住我不吃香菜」）；' +
      '日常对话里的偏好由系统在会话结束时自动提炼，不要主动调用本工具刷记忆。',
    parameters: Type.Object({
      content: Type.String({
        description: '要记住的内容，写成一句完整、自洽、脱离上下文也能读懂的话，如「膝盖不适，深蹲不宜超过 60kg」',
      }),
      memType: TYPE_ENUM,
      topic: Type.Optional(Type.String({ description: '主题短标签，如「膝盖」「饮食」，便于分组与去重' })),
    }),
    async execute(args) {
      const content = args.content.trim()
      if (!content) throw new Error('要记住的内容不能为空')
      const action: ShardWriteAction = {
        op: 'add',
        content,
        memType: (args.memType as KbMemoryType | undefined) ?? 'preference',
        topic: args.topic?.trim() || undefined,
      }
      const r = await kbService.memoryShardApply([action])
      // skipped 表示已存在同一条；restored 表示此前归档、这次又提到而复活。
      if (r.added > 0) return { ok: true, message: `已记住：${content}` }
      if (r.restored > 0) return { ok: true, message: `已重新记住：${content}` }
      return { ok: true, message: `这条已经记过了：${content}` }
    },
  }),

  defineTool({
    name: 'edit_memory',
    group: 'memory',
    label: '修改记忆',
    description:
      '修改一条已有长期记忆的内容/主题/类型（先 list_memories 拿 id）。' +
      '用户说「我改主意了/这条不对/更新一下」时用它；只传要改的字段。',
    parameters: Type.Object({
      memoryId: Type.Number({ description: 'list_memories 返回的 id' }),
      content: Type.Optional(Type.String({ description: '改后的内容（一句话、自洽）' })),
      topic: Type.Optional(Type.String({ description: '改后的主题短标签' })),
      memType: TYPE_ENUM,
    }),
    async execute(args) {
      const patch: ShardPatch = {}
      if (args.content?.trim()) patch.content = args.content.trim()
      if (args.topic?.trim()) patch.topic = args.topic.trim()
      if (args.memType) patch.memType = args.memType
      if (!patch.content && !patch.topic && !patch.memType) {
        throw new Error('没有要修改的字段：content / topic / memType 至少传一个')
      }
      // 部分更新：后端只改传入字段；归档中的条会被复活（不再误报「不存在」）。
      await kbService.memoryShardUpdate(args.memoryId, patch)
      return { ok: true, message: '已更新该条记忆' }
    },
  }),

  defineTool({
    name: 'forget',
    group: 'memory',
    label: '忘掉一条记忆',
    description:
      '按 id 删除一条长期记忆。**仅当用户明确要求忘掉/删掉某条记忆时调用**，先用 list_memories 拿到 id。',
    parameters: Type.Object({
      memoryId: Type.Number({ description: 'list_memories 返回的 id' }),
    }),
    dangerous: true,
    async execute(args) {
      const ok = await kbService.memoryShardDelete(args.memoryId)
      if (!ok) {
        throw new Error(`记忆不存在：id=${args.memoryId}（先用 list_memories 查 id）`)
      }
      return { ok: true, message: '已删除该条记忆' }
    },
  }),
]
