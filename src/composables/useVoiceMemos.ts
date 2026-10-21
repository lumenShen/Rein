import { computed, ref, watch, type WatchSource } from 'vue'

import { voiceService } from '@/services/voiceService'
import type { VoiceMemo } from '@/types'

/** 纪要 → 缩略脊的段落（两个纪要列表共用同一形状） */
export function memoSpine(m: VoiceMemo) {
  return m.sentences.map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  }))
}

/**
 * 纪要列表的加载 / 搜索 / 删除（「全部纪要」与「引用纪要」共用）。
 *
 * 两个抽屉此前各写一份「打开即加载 + 标题/正文关键字过滤 + 空态」，差异只在
 * 条数上限与失败时要不要清空/提示 —— 用参数显式表达，避免过滤口径哪天只改一边。
 */
export function useVoiceMemos(
  open: WatchSource<boolean>,
  opts: { limit?: number; clearOnError?: boolean; onError?: (e: unknown) => void } = {},
) {
  const loading = ref(false)
  const memos = ref<VoiceMemo[]>([])
  const keyword = ref('')

  async function load(): Promise<void> {
    loading.value = true
    try {
      memos.value = await voiceService.memoList(opts.limit)
    } catch (e) {
      if (opts.clearOnError) memos.value = []
      opts.onError?.(e)
    } finally {
      loading.value = false
    }
  }

  watch(open, (isOpen) => {
    if (isOpen) void load()
  })

  const filtered = computed(() => {
    const kw = keyword.value.trim().toLowerCase()
    if (!kw) return memos.value
    return memos.value.filter(
      (m) =>
        m.title.toLowerCase().includes(kw) ||
        m.sentences.some((s) => s.text.toLowerCase().includes(kw)),
    )
  })

  function remove(id: string): void {
    memos.value = memos.value.filter((m) => m.id !== id)
  }

  return { loading, memos, keyword, filtered, load, remove }
}
