/**
 * heightCache —— 聊天虚拟列表的段高缓存（localStorage）。
 *
 * 为什么是 localStorage 而不是 IndexedDB：仓库当前没有任何 IndexedDB 使用，
 * 引入它等于新增一套存储子系统；高度缓存是纯缓存（丢失无害）、数据量小
 * （2000 段 × ~30B ≈ 60KB/会话），而且同步读取能让首屏直接拿到高度，
 * 不会先按估算渲染再跳一下。
 *
 * key 含 chatId + **宽度桶** + **字体档**：气泡高度随可用宽度与根字号变化，
 * 换桶后旧值不再可信，由 ResizeObserver 重新实测。
 * LRU 3 个会话，与 imageZoom 的 CHAT_KEEP=3 同一思路。
 */

const VERSION = 1
const PREFIX = `rein.chat.heights.v${VERSION}.`
const INDEX_KEY = `${PREFIX}index`
const MAX_PER_CHAT = 2000
const LRU_CHATS = 3
const WRITE_THROTTLE_MS = 500

interface HeightRecord {
  v: number
  at: string
  heights: Record<string, number>
}

/** 已解析的记录（避免每次 setHeight 都 JSON.parse） */
const records = new Map<string, HeightRecord>()
/** 待写盘的 key */
const dirty = new Set<string>()
let writeTimer: ReturnType<typeof setTimeout> | null = null
let chatOrder: string[] | null = null

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    // 隐私模式 / 被策略禁用：降级为纯内存
    return null
  }
}

function widthBucket(): number {
  const vv = typeof window !== 'undefined' ? window.visualViewport?.width : undefined
  const w = vv ?? (typeof window !== 'undefined' ? window.innerWidth : 360)
  return Math.max(320, Math.round((w || 360) / 80) * 80)
}

function fontScale(): number {
  if (typeof document === 'undefined') return 16
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return Math.round(fs * 100) / 100
}

/** `rein.chat.heights.v1.<bucket>x<font>.<chatId>` */
function keyOf(chatId: string): string {
  return `${PREFIX}${widthBucket()}x${fontScale()}.${chatId}`
}

function loadOrder(): string[] {
  if (chatOrder) return chatOrder
  const ls = storage()
  if (!ls) {
    chatOrder = []
    return chatOrder
  }
  try {
    const raw = ls.getItem(INDEX_KEY)
    if (!raw) {
      chatOrder = []
      return chatOrder
    }
    const parsed = JSON.parse(raw) as { order?: unknown }
    chatOrder = Array.isArray(parsed.order) ? parsed.order.filter((x): x is string => typeof x === 'string') : []
  } catch {
    chatOrder = []
  }
  return chatOrder
}

function writeOrder(order: string[]): void {
  const ls = storage()
  if (!ls) return
  try {
    ls.setItem(INDEX_KEY, JSON.stringify({ order }))
  } catch {
    /* 配额已满时索引写不进去也不影响本会话的高度语义 */
  }
}

/** 把一个会话提到 LRU 首位；返回需要淘汰的会话。 */
function touch(chatId: string): void {
  const order = loadOrder()
  if (order[0] === chatId) return
  const next = [chatId, ...order.filter((x) => x !== chatId)]
  const evicted = next.slice(LRU_CHATS)
  chatOrder = next.slice(0, LRU_CHATS)
  writeOrder(chatOrder)
  for (const c of evicted) clearChat(c)
}

function readRecord(key: string): HeightRecord | null {
  const cached = records.get(key)
  if (cached) return cached
  const ls = storage()
  if (!ls) return null
  try {
    const raw = ls.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HeightRecord>
    if (parsed.v !== VERSION || !parsed.heights || typeof parsed.heights !== 'object') return null
    const heights: Record<string, number> = {}
    for (const [id, h] of Object.entries(parsed.heights)) {
      if (typeof h === 'number' && Number.isFinite(h) && h > 0) heights[id] = h
    }
    const rec: HeightRecord = { v: VERSION, at: typeof parsed.at === 'string' ? parsed.at : '', heights }
    records.set(key, rec)
    return rec
  } catch {
    return null
  }
}

function persist(key: string): void {
  const rec = records.get(key)
  const ls = storage()
  if (!rec || !ls) return
  try {
    ls.setItem(key, JSON.stringify(rec))
  } catch {
    // 配额满：清掉非当前会话的高度桶后重试一次（纯缓存，删了无害）
    try {
      const currentChat = key.slice(key.lastIndexOf('.') + 1)
      const keys: string[] = []
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i)
        if (k && k.startsWith(PREFIX) && k !== INDEX_KEY && !k.endsWith(`.${currentChat}`)) keys.push(k)
      }
      for (const k of keys) ls.removeItem(k)
      ls.setItem(key, JSON.stringify(rec))
    } catch {
      /* 仍然写不进去：本会话继续用内存值 */
    }
  }
}

function scheduleFlush(): void {
  if (writeTimer !== null) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    flushHeights()
  }, WRITE_THROTTLE_MS)
}

/** 读取某会话在当前宽度桶/字体档下的全部段高。 */
export function loadHeights(chatId: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!chatId) return out
  touch(chatId)
  const rec = readRecord(keyOf(chatId))
  if (!rec) return out
  for (const [id, h] of Object.entries(rec.heights)) out.set(id, h)
  return out
}

/** 写一条段高（500ms 节流落盘；纯内存更新立即生效）。 */
export function setHeight(chatId: string, segmentId: string, h: number): void {
  if (!chatId || !segmentId || !Number.isFinite(h) || h <= 0) return
  touch(chatId)
  const key = keyOf(chatId)
  const rec = readRecord(key) ?? { v: VERSION, at: '', heights: {} }
  rec.heights[segmentId] = Math.round(h * 100) / 100
  rec.at = new Date().toISOString()
  // 每会话最多 2000 条：超出按插入顺序删最旧（更新已有 key 不改顺序）
  const ids = Object.keys(rec.heights)
  if (ids.length > MAX_PER_CHAT) {
    for (const id of ids.slice(0, ids.length - MAX_PER_CHAT)) delete rec.heights[id]
  }
  records.set(key, rec)
  dirty.add(key)
  scheduleFlush()
}

export function deleteHeight(chatId: string, segmentId: string): void {
  if (!chatId || !segmentId) return
  const key = keyOf(chatId)
  const rec = readRecord(key)
  if (!rec || !(segmentId in rec.heights)) return
  delete rec.heights[segmentId]
  records.set(key, rec)
  dirty.add(key)
  scheduleFlush()
}

/** 删除一个会话在所有宽度桶/字体档下的缓存（旋转屏幕会留下多个桶）。 */
export function clearChat(chatId: string): void {
  if (!chatId) return
  const suffix = `.${chatId}`
  const ls = storage()
  if (ls) {
    const keys: string[] = []
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k && k.startsWith(PREFIX) && k !== INDEX_KEY && k.endsWith(suffix)) keys.push(k)
    }
    for (const k of keys) {
      ls.removeItem(k)
      records.delete(k)
      dirty.delete(k)
    }
  }
  for (const k of [...records.keys()]) {
    if (k.startsWith(PREFIX) && k !== INDEX_KEY && k.endsWith(suffix)) records.delete(k)
  }
  if (chatOrder) {
    chatOrder = chatOrder.filter((x) => x !== chatId)
    writeOrder(chatOrder)
  }
}

/** 把节流中的最后一批高度立即写盘（页面卸载前调用）。 */
export function flushHeights(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  for (const key of dirty) persist(key)
  dirty.clear()
}

/** 调试/测试用：当前 key 形状（不含具体值）。 */
export function heightCacheKey(chatId: string): string {
  return keyOf(chatId)
}
