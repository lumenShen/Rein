/**
 * 长期记忆前端状态（方案 §8.1）。
 *
 * - 自动注入（injectForPrompt）只读：调 `memory_shard_inject`，不写 history/stability/state；
 *   60 秒短 TTL 按 query 缓存，失败返回旧缓存/undefined，绝不让对话发不出去。
 * - 记忆卡数据来自同一次注入结果；`dismissed` 只是本地隐藏，不写库。
 * - 主动搜索（search）才会触发 Rust 侧的 `search_hit` 强化。
 * - Dream 调度：5 分钟内存节流 + `ai.busy` 门禁；真正的 gate/冷却在 Rust。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { kbService } from '@/services/kbService'
import { useModelsStore } from '@/stores/models'
import { runMemoryDream } from '@/ai/memoryDream'
import type {
  MemoryInjectShard,
  MemorySearchResult,
  MemoryShardOverview,
  MemoryShardStats,
  ShardSweepResult,
} from '@/types'

/** 注入缓存：同一 query 60 秒内不重复 IPC（与旧 cognition 缓存同档） */
const INJECT_TTL_MS = 60_000
/** 空闲 Dream 检查节流：Rust 侧还有 3 小时冷却，这里只防同一会话反复试探 */
const DREAM_IDLE_THROTTLE_MS = 5 * 60_000

interface InjectCache {
  at: number
  query: string
  text: string
  cards: MemoryInjectShard[]
}

export const useMemoryStore = defineStore('memory', () => {
  /** 当前一轮注入的记忆卡（顶部展示；不参与聊天虚拟滚动） */
  const cards = ref<MemoryInjectShard[]>([])
  const overview = ref<MemoryShardOverview | null>(null)
  const stats = ref<MemoryShardStats | null>(null)
  const searchResult = ref<MemorySearchResult | null>(null)
  const dreaming = ref(false)
  /** 最近一次 Dream 的跳过原因（gate/no_model/error），供 UI 解释按钮结果 */
  const dreamError = ref<string | null>(null)
  const dismissed = ref<Set<number>>(new Set())

  let injectCache: InjectCache | null = null
  let inflight: { query: string; promise: Promise<string | undefined> } | null = null
  /** 失效代际：invalidate 之后晚到的注入响应不能写回缓存 */
  let generation = 0
  let lastIdleCheck = 0

  function applyCards(source: MemoryInjectShard[]): void {
    cards.value = source.filter((s) => !dismissed.value.has(s.shardId))
  }

  /**
   * 取喂给系统提示词的「用户认知」块。
   * 严格只读；失败时返回旧缓存（同 query）或 undefined。
   *
   * `expectChatId`：调用方发起时的会话。注入是一次 IPC，跨会话切换/晚到的响应
   * 不能把上一会话的卡片写到新会话顶部（卡片上的「查看原文」带的是旧 chatId）。
   */
  async function injectForPrompt(
    query?: string,
    expectChatId?: string,
  ): Promise<string | undefined> {
    const q = (query ?? '').trim()
    const expect = expectChatId ?? null
    const stillOnChat = async (): Promise<boolean> => {
      if (!expect) return true
      const { useAiStore } = await import('@/stores/ai')
      return useAiStore().chatId === expect
    }
    const now = Date.now()
    if (injectCache && injectCache.query === q && now - injectCache.at < INJECT_TTL_MS) {
      if (await stillOnChat()) applyCards(injectCache.cards)
      return injectCache.text || undefined
    }
    if (inflight && inflight.query === q) return inflight.promise

    const gen = generation
    const promise = (async () => {
      try {
        const result = await kbService.memoryInject(q || undefined, 2000, 8, false)
        if (gen === generation && (await stillOnChat())) {
          injectCache = { at: Date.now(), query: q, text: result.text, cards: result.shards }
          applyCards(result.shards)
        }
        return result.text || undefined
      } catch {
        if (gen === generation && injectCache && injectCache.query === q) {
          if (await stillOnChat()) applyCards(injectCache.cards)
          return injectCache.text || undefined
        }
        return undefined
      } finally {
        if (inflight?.query === q) inflight = null
      }
    })()

    inflight = { query: q, promise }
    return promise
  }

  /**
   * 为当前会话准备顶部记忆卡：取已加载消息里最后一条用户文本作为 query。
   * 会话已切换/没有消息时不显示（避免把上一轮的卡片带到新会话）。
   */
  async function loadCardsForChat(chatId: string, lastUserText?: string): Promise<void> {
    const { useAiStore } = await import('@/stores/ai')
    const ai = useAiStore()
    if (ai.chatId && ai.chatId !== chatId) return
    if (ai.messages.length === 0) {
      cards.value = []
      return
    }
    let text = lastUserText?.trim()
    if (!text) {
      for (let i = ai.messages.length - 1; i >= 0; i--) {
        const m = ai.messages[i]
        if (m?.role === 'user' && (m.text ?? '').trim()) {
          text = (m.text as string).trim()
          break
        }
      }
    }
    const injected = await injectForPrompt(text, chatId)
    // await 期间可能已切会话：晚到的卡片不能留在新会话顶部；注入失败/空结果也不留旧卡。
    if (ai.chatId !== chatId || !injected) {
      cards.value = []
    }
  }

  /** 刷新分片聚合（列表 + 统计 + 当前注入块）。失败时保留旧值。 */
  async function loadOverview(): Promise<void> {
    try {
      const result = await kbService.memoryShardOverview()
      overview.value = result
      stats.value = result.stats
    } catch {
      /* 页面自己有错误态；store 的旧快照继续可用 */
    }
  }

  /** 主动检索：这是唯一会写 search_hit 的读路径（Rust 侧做阈值/冷却/上限门控） */
  async function search(
    query: string,
    opts: { topK?: number; includeArchived?: boolean } = {},
  ): Promise<MemorySearchResult> {
    const result = await kbService.memorySearch(
      query,
      opts.topK ?? 8,
      true,
      opts.includeArchived ?? false,
      false,
    )
    searchResult.value = result
    return result
  }

  async function markImportant(id: number): Promise<void> {
    await kbService.memoryShardMarkImportant(id)
    const next = new Set(dismissed.value)
    next.delete(id)
    dismissed.value = next
    invalidate()
    await loadOverview()
  }

  async function archive(id: number): Promise<void> {
    await kbService.memoryShardArchive(id)
    dismissCard(id)
    invalidate()
    await loadOverview()
  }

  async function restore(id: number): Promise<void> {
    await kbService.memoryShardRestore(id)
    // 归档时本地隐藏过这张卡；恢复后允许它重新出现
    const next = new Set(dismissed.value)
    next.delete(id)
    dismissed.value = next
    invalidate()
    await loadOverview()
  }

  async function remove(id: number): Promise<void> {
    await kbService.memoryShardDelete(id)
    dismissCard(id)
    if (searchResult.value) {
      searchResult.value = {
        ...searchResult.value,
        hits: searchResult.value.hits.filter((h) => h.shardId !== id),
      }
    }
    invalidate()
    await loadOverview()
  }

  async function sweep(): Promise<ShardSweepResult> {
    const result = await kbService.memoryShardSweep()
    invalidate()
    await loadOverview()
    return result
  }

  /** 手动/空闲触发一次 Dream；返回实际改动数（0 表示 gate/无模型/无需调整）。 */
  async function dreamNow(force = false): Promise<number> {
    if (dreaming.value) return 0
    dreaming.value = true
    dreamError.value = null
    try {
      const outcome = await runMemoryDream({ force })
      if (outcome.skipped) {
        // no_model 用稳定 token，避免依赖 memoryDream 的中文提示语气
        dreamError.value =
          outcome.skipped === 'no_model' ? 'no_model' : (outcome.reason ?? outcome.skipped)
        return 0
      }
      invalidate()
      await loadOverview()
      return outcome.changes
    } catch (e) {
      dreamError.value = e instanceof Error ? e.message : String(e)
      return 0
    } finally {
      dreaming.value = false
    }
  }

  /** 空闲时检查 Dream：busy/正在 Dream 时跳过；5 分钟内存节流；无模型不产生 run。 */
  async function maybeDreamOnIdle(): Promise<void> {
    if (dreaming.value) return
    const { useAiStore } = await import('@/stores/ai')
    if (useAiStore().busy) return
    const now = Date.now()
    if (now - lastIdleCheck < DREAM_IDLE_THROTTLE_MS) return
    lastIdleCheck = now
    const models = useModelsStore()
    if (!models.loaded) await models.load()
    if (!models.defaultModel()) return
    void dreamNow(false)
  }

  /** 本地隐藏一张卡（不写库；下一轮重新注入时仍会按 dismiss 过滤） */
  function dismissCard(id: number): void {
    const next = new Set(dismissed.value)
    next.add(id)
    dismissed.value = next
    cards.value = cards.value.filter((c) => c.shardId !== id)
  }

  /** 记忆被写入/删除/标记后调它：下一轮注入与卡片立即重新取数 */
  function invalidate(): void {
    generation++
    injectCache = null
    inflight = null
  }

  return {
    cards,
    overview,
    stats,
    searchResult,
    dreaming,
    dreamError,
    dismissed,
    injectForPrompt,
    loadCardsForChat,
    loadOverview,
    search,
    markImportant,
    archive,
    restore,
    remove,
    sweep,
    dreamNow,
    maybeDreamOnIdle,
    dismissCard,
    invalidate,
  }
})
