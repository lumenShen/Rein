<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  Archive,
  BookOpen,
  Camera,
  Check,
  Copy,
  FileText,
  Folder,
  FolderUp,
  History,
  Images,
  Plus,
  Quote,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import ComposerBar from '@/components/common/ComposerBar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import HistoryDrawer from '@/components/ai/HistoryDrawer.vue'
import FoodParseSheet from '@/components/ai/FoodParseSheet.vue'
import MemoryCards from '@/components/ai/MemoryCards.vue'
import VoiceInputMask from '@/components/ai/VoiceInputMask.vue'
import ChatSegmentView from '@/components/ai/chat/ChatSegmentView.vue'
import { flushHeights } from '@/components/ai/chat/heightCache'
import { useVirtualChat } from '@/components/ai/chat/useVirtualChat'
import MemoPickerSheet from '@/components/voice/MemoPickerSheet.vue'
import { openMemoById } from '@/system/voiceRuntime'
import { composerFocused, composerMenuOpen } from '@/system/composerFocus'
import {
  aiVoiceInput,
  aiVoiceStart,
  aiVoiceSetContinuous,
  aiVoiceStop,
  aiVoiceCancel,
  appendVoiceText,
  onAiVoiceResult,
  VOICE_TAP_MS,
} from '@/system/aiVoiceInput'
import type { AiVoiceResult } from '@/system/aiVoiceInput'
import PageHeader from '@/components/layout/PageHeader.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import AiBoard from '@/components/ai/AiBoard.vue'
import { DESKTOP_MIN, suggestMeal } from '@/config/domain'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { isTauriDesktopWindow } from '@/system/windowChrome'
import { useToast } from '@/composables/useToast'
import { kbService } from '@/services/kbService'
import { useAiStore } from '@/stores/ai'
import { useChatPagingStore } from '@/stores/chatPaging'
import { useComposerStore } from '@/stores/composer'
import { useMemoryStore } from '@/stores/memory'
import { useModelsStore } from '@/stores/models'
import { copyText } from '@/utils/clipboard'
import { listFoodDrafts, removeFoodDraft, saveFoodDraft, type FoodDraft } from '@/utils/foodDrafts'
import { bitmapToJpeg, decodeBitmap, imageTypeOf, IMAGE_ACCEPT, DEFAULT_IMAGE_EDGE } from '@/utils/image'
import { isHeifBlob } from '@/utils/heif'
import { officeKindOf, parseOffice, parseTextFile, type ParsedDoc } from '@/utils/documentParse'
import { shareInbox } from '@/system/shareInbox'
import type { SendImage } from '@/stores/ai'
import type { VoiceMemo } from '@/types'
import { fmtDateCn, toDateStr } from '@/utils/date'
import { buildChatSegments, segmentIdOfMessage } from '@/ai/chatSegments'
import type { AiMessage, AiDocMeta, KbEmbeddingMode, KbEntry, MealType, ParsedFoodItem } from '@/types'

/** AI 页：拍照直识别（可编辑卡片 + 草稿箱）/ 文字记饮食 / 数据工具对话。 */
const ai = useAiStore()
/** 会话分页状态机（尾页 / 向上加载 / around 跳转）；消息真源仍在 ai.messages */
const paging = useChatPagingStore()
/**
 * 全局输入条的草稿（跨页唯一真源）：文字 / 附图 / 文档 / 引用 / 纪要都在这里，
 * 从本页切走（AIPage 卸载）再回来时原样还在 —— 输入条是全局唯一的，草稿也只有一份。
 */
const composer = useComposerStore()
const { text: draft, attachments, docAtt, quote, memoRefs } = storeToRefs(composer)
const route = useRoute()
const router = useRouter()
const toast = useToast()

/**
 * 输入条是否**并入底栏 Dock**（2026-11-08 用户定稿：AI 页与其他页共用一块大玻璃）。
 * 并入 = .composer Teleport 进 TabBar 的 #dock-ai-composer 宿主（移动端 / 窄浏览器）；
 * 桌面三窗格没有 TabBar，输入条留在页内（贴窗口下缘），与底栏无从合并。
 * 判定与 App 的 deskShell 同源：桌面 Tauri 恒否、浏览器看宽度。
 */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)
const embedInDock = computed(() => !(isTauriDesktopWindow || isDesktop.value))

/** 该消息的气泡元数据（推理过程段 / 思考计时 / 是否被吸收） */
function metaOf(m: AiMessage): ReturnType<typeof ai.getMeta> {
  return ai.getMeta(m.id)
}

/** 整条消息是否有东西可渲染。挡掉空壳（连带省掉它的 10px 间距）：
 *  流式占位气泡在正文到达前是空 text，历史恢复时被吸收的消息只剩 id/kind 空壳。 */
function showMsg(m: AiMessage): boolean {
  const meta = metaOf(m)
  if (meta?.absorbed) return false
  if (meta?.segments.length) return true
  if (m.quoteText) return true
  // 挂出的文件卡片本身就是内容：模型只挂了文件、一个字没说时，这条消息也要在
  if (m.files?.length) return true
  switch (m.kind) {
    case 'text':
      // 流式气泡无论当前是打字点还是正文都可见；**不要在这里读 text 的值** ——
      // 每个 token 都会让 visibleMessages → buildChatSegments 整体重算（万条消息时是 O(n)/token）。
      // 非流式消息的 text 已定稿（空占位在 settle 时被 splice），读取值不会随流式变化。
      return m.streaming === true || !!m.text
    case 'photo':
      // 与模板分支同条件：没有图就没有可渲染的部分（纯文字的照片消息按空壳处理）
      return !!(m.imageBase64 || m.images?.length)
    case 'doc':
      return !!m.doc
    case 'food-parse':
      return !!m.items
    // 纯过程载体：内容就是上面的 segments，没有过程段时自己没有可渲染的部分
    case 'tools':
      return false
    default:
      return true
  }
}

/* ---------- 拍照识别弹层与草稿箱 ---------- */

const foodSheet = ref<InstanceType<typeof FoodParseSheet> | null>(null)
const draftsOpen = ref(false)
const drafts = ref<FoodDraft[]>([])

function refreshDrafts(): void {
  drafts.value = listFoodDrafts()
}

function openDrafts(): void {
  refreshDrafts()
  draftsOpen.value = true
}

function editDraft(d: FoodDraft): void {
  // 先让草稿列表弹层走完关闭 watcher（恢复页面滚动锁），再打开编辑弹层
  draftsOpen.value = false
  void nextTick(() => foodSheet.value?.openDraft(d))
}

/** 看板入口：把现成的那句话放进输入框，**不直接发送** ——
 *  「查我这周练了几次」该由模型决定调哪个工具、查到什么粒度，
 *  前端替它执行就又变成一块设定好的卡片。 */
function askFromBoard(text: string): void {
  draft.value = text
  // 长高由 ComposerBar 监听 modelValue 自己做；这里只管把焦点交回去
  void nextTick(() => composerEl.value?.focus())
}

function deleteDraft(id: string): void {
  removeFoodDraft(id)
  refreshDrafts()
}

/** 识别卡 → 存草稿箱。
 *  缩略图取同一条消息的压缩图（imageBase64 就是压缩后的那一份），
 *  文字解析来的卡没有图，留空即可 —— 草稿箱里那格会显示占位图标。 */
function stashParse(m: AiMessage): void {
  if (!m.items?.length) return
  saveFoodDraft({ thumbBase64: m.imageBase64 ?? undefined, items: m.items })
  refreshDrafts()
  toast.toast('已存入草稿箱，可在「历史 · 食物草稿箱」里继续处理')
}

function fmtDraftTime(iso: string): string {
  const d = new Date(iso)
  // 日期与时刻都用本地时区：toISOString() 取的是 UTC，两者混用会出现
  // 「昨天 07:00」这类错位
  return `${fmtDateCn(toDateStr(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 全局唯一的输入条（ComposerBar）：AI 页与底栏是同一个组件 —— 聚焦、长高、锚定都交给它 */
const composerEl = ref<InstanceType<typeof ComposerBar> | null>(null)
const fileEl = ref<HTMLInputElement | null>(null)
const galleryEl = ref<HTMLInputElement | null>(null)
const cameraEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

/* ============================================================
   可变高度虚拟列表（方案 §9）
   ============================================================ */

/** 只把可渲染消息交给分段器：被吸收的空壳/空气泡不占高度 */
const visibleMessages = computed(() => ai.messages.filter(showMsg))
/** user 回合段：`seg:<首条可见消息 id>`，anchor 与 shard 对齐 */
const segments = computed(() => buildChatSegments(visibleMessages.value))

/** 用户手动开合过的过程区（按消息 id；组件被回收后仍保持） */
const processExpanded = reactive<Record<string, boolean>>({})
const expandedIds = computed(() => {
  const set = new Set<string>()
  for (const [id, open] of Object.entries(processExpanded)) if (open) set.add(id)
  return set
})

/** pin：焦点 / 长按菜单 / 工具抽屉打开的段不卸载 */
const focusPinned = reactive(new Set<string>())
const transientPinned = reactive(new Set<string>())
const detailPinned = reactive(new Set<string>())
const pinnedIds = computed(() => [...new Set([...focusPinned, ...transientPinned, ...detailPinned])])

const virtualBodyEl = ref<HTMLElement | null>(null)

const {
  visibleSegments,
  topSpacer,
  bottomSpacer,
  setSegmentEl,
  measure: measureVirtual,
  captureAnchor,
  restoreAnchor,
  scrollToMessage,
  scrollToBottom: scrollVirtualBottom,
  invalidateMessage,
  suspendScroll,
  resumeScroll,
} = useVirtualChat({
  scroller: listEl,
  body: virtualBodyEl,
  segments,
  chatId: computed(() => ai.chatId),
  expandedIds,
  pinnedIds,
  hasMoreBefore: computed(() => paging.hasMoreBefore),
  hasMoreAfter: computed(() => paging.hasMoreAfter),
  onLoadOlder: () => {
    void loadOlder()
  },
  onLoadNewer: () => {
    void loadNewer()
  },
})

/** 段元素 ref 回调（模板里拿到的是 Element | ComponentPublicInstance | null） */
function bindSegmentEl(segmentId: string, el: unknown): void {
  setSegmentEl(segmentId, el instanceof HTMLElement ? el : null)
}

function mealOf(messageId: string): MealType {
  return mealByMsg[messageId] ?? suggestMeal()
}

function expandedOf(messageId: string): boolean | undefined {
  return processExpanded[messageId]
}

/* ---------- 跳转高亮（#msg-<id>.flash，2s 后清） ---------- */

const flashId = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null

function flashMessage(messageId: string | null): void {
  if (!messageId) return
  flashId.value = messageId
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    if (flashId.value === messageId) flashId.value = null
    flashTimer = null
  }, 2000)
}

/* ---------- 顶部记忆卡（E 域：MemoryCards + stores/memory；普通 block，不参与段高度） ---------- */

const memory = useMemoryStore()
const memoryCards = computed(() => memory.cards)
const memoryDreaming = computed(() => memory.dreaming)
const memoryCardsEl = ref<HTMLElement | null>(null)
let memoryCardsRO: ResizeObserver | null = null

const lastUserText = computed(() => {
  for (let i = ai.messages.length - 1; i >= 0; i--) {
    const m = ai.messages[i]!
    if (m.role === 'user' && m.text?.trim()) return m.text.trim()
  }
  return undefined
})

async function loadMemorySurfaces(): Promise<void> {
  if (!ai.chatId) return
  try {
    await memory.loadCardsForChat(ai.chatId, lastUserText.value)
  } catch {
    /* 记忆卡失败静默：不影响聊天 */
  }
}

async function refreshMemoryCards(): Promise<void> {
  await loadMemorySurfaces()
}

function onMemoryJump(payload: { anchorMessageId: string; chatId: string }): void {
  if (!payload?.anchorMessageId) return
  void jumpToMemoryAnchor(payload.anchorMessageId, payload.chatId ?? null)
}

function onMemoryOpen(payload: { shardId: number }): void {
  void router.push({ name: 'ai-knowledge', query: { shard: String(payload.shardId) } })
}

function onMemoryDismiss(shardId: number): void {
  memory.dismissCard(shardId)
}

function observeMemoryCards(): void {
  if (typeof ResizeObserver === 'undefined') return
  const el = memoryCardsEl.value
  if (!el) return
  memoryCardsRO?.disconnect()
  // 卡片内容变化不一定改变条数：用 RO 兜住 bodyOffset 的更新
  memoryCardsRO = new ResizeObserver(() => measureVirtual())
  memoryCardsRO.observe(el)
}

watch(
  [() => memoryCards.value.length, () => memoryDreaming.value],
  () => {
    void nextTick(() => {
      measureVirtual()
      observeMemoryCards()
    })
  },
  { flush: 'post' },
)

/* ---------- 分页加载（吸底由 lastMessageId watcher 负责，前插绝不吸底） ---------- */

/** 跳转期间抑制自动吸底：replaceMessages 会被误判成「尾部追加」而先滚到底 */
const suppressAutoScroll = ref(false)

async function jumpToMemoryAnchor(anchorId: string, chat?: string | null): Promise<void> {
  if (!anchorId || ai.busy) return
  suppressAutoScroll.value = true
  suspendScroll()
  try {
    if (chat && chat !== ai.chatId) {
      await ai.selectChat(chat)
      if (ai.chatId !== chat) return
      await paging.syncChat()
    }
    const target = await paging.jumpToAnchor(anchorId)
    if (!target) return
    await nextTick()
    measureVirtual()
    const found = await scrollToMessage(target, { highlight: true })
    flashMessage(found)
  } finally {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    measureVirtual()
    resumeScroll()
    await nextTick()
    suppressAutoScroll.value = false
  }
}

async function loadOlder(): Promise<void> {
  if (paging.loadingBefore || !paging.hasMoreBefore || ai.busy) return
  const anchor = captureAnchor()
  suspendScroll()
  try {
    const loaded = await paging.loadOlder()
    if (!loaded) return
    await nextTick()
    measureVirtual()
    await restoreAnchor(anchor)
  } finally {
    resumeScroll()
  }
}

/**
 * 键盘/读屏版「加载更早」：哨兵 Tab 到时先加载一页，再把焦点送到新装上的最老一条。
 *
 * 只加载不移动的话，新段在视口上方、虚拟列表不会挂载它们，Tab 依然够不到——
 * 对键盘用户等于没有入口。加载后滚到该条并聚焦，focusin 会把它 pin 在窗口里。
 */
async function loadOlderAndFocus(): Promise<void> {
  const firstBefore = ai.messages[0]?.id
  await loadOlder()
  await nextTick()
  const first = ai.messages[0]
  if (!first || first.id === firstBefore) return
  await scrollToMessage(first.id)
  await nextTick()
  const el = document.getElementById(`msg-${first.id}`)
  if (el instanceof HTMLElement) el.focus()
}

async function loadNewer(): Promise<void> {
  if (paging.loadingAfter || !paging.hasMoreAfter || ai.busy) return
  suspendScroll()
  // 尾部追加会改变 lastMessageId；这里不是「发送新消息」，不能把人拽到新底部
  suppressAutoScroll.value = true
  try {
    const loaded = await paging.loadNewer()
    if (!loaded) return
    await nextTick()
    measureVirtual()
  } finally {
    resumeScroll()
    suppressAutoScroll.value = false
  }
}

/* ---------- pin / 焦点 / 菜单锚点 ---------- */

function pinMessage(messageId: string, bucket: Set<string>): void {
  const segId = segmentIdOfMessage(segments.value, messageId)
  if (segId) bucket.add(segId)
}

function unpinMessage(messageId: string, bucket: Set<string>): void {
  const segId = segmentIdOfMessage(segments.value, messageId)
  if (segId) bucket.delete(segId)
}

function onFocusIn(e: FocusEvent): void {
  const target = e.target
  const seg = target instanceof HTMLElement ? target.closest('[data-seg-id]') : null
  const id = seg instanceof HTMLElement ? seg.dataset.segId : undefined
  if (id) focusPinned.add(id)
}

function onFocusOut(e: FocusEvent): void {
  const target = e.target
  const from = target instanceof HTMLElement ? target.closest('[data-seg-id]') : null
  const to = e.relatedTarget instanceof HTMLElement ? e.relatedTarget.closest('[data-seg-id]') : null
  if (from instanceof HTMLElement && from !== to) {
    const id = from.dataset.segId
    if (id) focusPinned.delete(id)
  }
}

function onUpdateItems(messageId: string, items: ParsedFoodItem[]): void {
  const msg = ai.messages.find((m) => m.id === messageId)
  if (!msg) return
  msg.items = items
  invalidateMessage(messageId)
}

function onUpdateMeal(messageId: string, meal: MealType): void {
  mealByMsg[messageId] = meal
}

function onUpdateProcess(messageId: string, expanded: boolean): void {
  processExpanded[messageId] = expanded
  invalidateMessage(messageId)
}

function onDetailOpen(messageId: string): void {
  pinMessage(messageId, detailPinned)
  invalidateMessage(messageId)
}

function onDetailClose(messageId: string): void {
  unpinMessage(messageId, detailPinned)
}

function onOpenMemo(memoId: string): void {
  if (memoId) void openMemoById(memoId)
}

function onCommit(messageId: string, meal: MealType): void {
  void ai.commitParse(messageId, meal)
}


/** 上传文件的入口要连图片（含 HEIF）带 Office/文本一起收；图库/相机只收图 */
const UPLOAD_ACCEPT = `${IMAGE_ACCEPT},.docx,.pptx,.xlsx,.md,.markdown,.txt,.csv`

/* ---------- 「+」添加菜单（bind 式：锚定按钮弹出，带图标） ---------- */

const camMenuOpen = ref(false)
/** 锚定元素：输入条左侧的 + 按钮（ComposerBar 暴露的 addButton） */
const camBtn = computed(() => composerEl.value?.addButton ?? null)

/** 附图上限：超过后提示，防止消息体撑爆模型上下文 */
const MAX_ATTACHMENTS = 9

/** 发送视图最长边：按视觉模型的配置（imageMaxEdge），未配置用默认值。
 * 视图同时是放大镜的坐标空间与跨重启的精度上限，尽量贴近模型输入分辨率。 */
function imageEdgeCap(): number {
  return useModelsStore().bestVisionModel()?.imageMaxEdge ?? DEFAULT_IMAGE_EDGE
}

/** 添加菜单选项：拍照走系统相机（capture 属性），图库可多选，文件支持图片/Office/文本 */
const camActions: MenuItem[] = [
  { label: '拍照（系统相机）', value: 'camera', icon: Camera },
  { label: '从图库选择', value: 'gallery', icon: Images },
  { label: '上传文件', value: 'file', icon: FolderUp },
]

function openCamMenu(): void {
  camMenuOpen.value = true
}

/** 「+」菜单：只有它本来就是从**聚焦中的**输入条打开时，才让底栏保持收起。
 *  菜单锚在 + 钮上，页签行一展开整行会上移 58px、菜单悬在旧位置；但若打开时输入条
 *  并未聚焦（页签行本来就在），这里就不该凭空收起它 —— 收起反而会让锚点在菜单
 *  定位的过程中移动。 */
watch(camMenuOpen, (open) => {
  composerMenuOpen.value = open && composerFocused.value
})

function onCamSelect(value: string): void {
  if (value === 'camera') cameraEl.value?.click()
  else if (value === 'gallery') galleryEl.value?.click()
  else fileEl.value?.click()
}

/* 待发送附图 / 文档（选图后先挂输入框上方，可移除、配文字，随下一条消息发出）
   住在 stores/composer：跨页唯一真源，切走再回来不会丢。 */

function toggleDocImage(id: string): void {
  const d = docAtt.value
  if (!d) return
  const next = new Set(d.selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  docAtt.value = { ...d, selected: next }
}

/** 打开 AI 挂出的文件卡片：文件进阅读器、目录进文件管理器。
 *  一律**按路径跳**（与空间总览的大文件榜同一条深链）：卡片拿到的是 kb_docs.id 或
 *  只有文件实体，而阅读器要的是 kb_docs.id —— 路径是两个页面都认的键。
 *  都是页内跳转，不唤起系统应用（docs/ai-workspace.md §5 的约定）。 */
function openChatFile(f: KbEntry): void {
  if (f.kind === 'folder') {
    void router.push({ name: 'ai-files', query: { dir: f.path } })
    return
  }
  const cut = f.path.lastIndexOf('/')
  const parent = cut > 0 ? f.path.slice(0, cut) : ''
  void router.push({ name: 'ai-files', query: parent ? { dir: parent, path: f.path } : { path: f.path } })
}

/** 每张解析卡选择的目标餐次，默认按当前时间推荐 */
const mealByMsg = reactive<Record<string, MealType>>({})

/** 历史抽屉 / 长按菜单 / 引用（quote 本身住在 stores/composer，与草稿一同跨页保留） */
const drawerOpen = ref(false)
const menuTarget = ref<AiMessage | null>(null)
/** 长按菜单锚定元素：被长按的那条消息气泡 */
const menuAnchor = ref<HTMLElement | null>(null)

/* ---------- 「历史」菜单（bind 式：锚定左上角那颗圆钮弹出，带图标） ----------
 *  原来左上角是「文件」「历史记录」两颗圆钮，功能都是「回到过去的东西」，
 *  却各占一颗 38px 圆钮 —— 一颗装一个子页面，形态上比同级动作更重。
 *  合并成一颗：点开是五项，第二项（搜索历史）按知识库当前的检索模式给副标，
 *  模式名不是写死的 —— settingsGet 返回什么就显示什么（关键词 / 本地模型 / 云端）。 */

/** 锚点：页头那颗「历史」圆钮 */
const histBtn = ref<HTMLElement | null>(null)
const histMenuOpen = ref(false)

/** 检索模式只用于菜单副标，拿不到就不显示（不影响功能） */
const embedMode = ref<KbEmbeddingMode | null>(null)

onMounted(() => {
  void kbService
    .settingsGet()
    .then((s) => {
      embedMode.value = s.embeddingMode
    })
    .catch(() => {
      /* 索引未初始化等：菜单副标留空 */
    })
})

/** 当前检索模式的中文名（副标用；判不出来时回落到「关键词」——那也是后端默认值） */
const embedModeLabel = computed(() => {
  switch (embedMode.value) {
    case 'local':
      return '本地模型'
    case 'cloud':
      return '云端'
    case 'keyword':
      return '关键词'
    default:
      return '关键词'
  }
})

const histActions = computed<MenuItem[]>(() => [
  { label: '文件', value: 'files', icon: Folder },
  // 检索模式是对「搜索历史」的注解，用括号跟在后面，不再与动作用「·」并成同权一项
  { label: `搜索历史（${embedModeLabel.value}）`, value: 'search', icon: Search },
  { label: '知识库', value: 'knowledge', icon: BookOpen },
  {
    // 与草稿箱抽屉标题、存草稿 toast 统一叫「食物草稿箱」；计数带单位「项」
    label: drafts.value.length ? `食物草稿箱 · ${drafts.value.length} 项` : '食物草稿箱',
    value: 'drafts',
    icon: Archive,
  },
  { label: '历史会话', value: 'chats', icon: History },
])

/** 「搜索历史」：预置一个检索词进输入框，交给对话流里的 search_knowledge 处理。
 *  刻意**不**自己调 kbService —— 那会绕过模型，用户搜到什么、要不要接着问，
 *  都得留在同一条会话里才成立。 */
function onHistSelect(value: string): void {
  if (value === 'files') {
    void router.push({ name: 'ai-files' })
  } else if (value === 'knowledge') {
    void router.push({ name: 'ai-knowledge' })
  } else if (value === 'search') {
    draft.value = '搜一下我的历史记录：'
    void nextTick(() => composerEl.value?.focus())
  } else if (value === 'drafts') {
    openDrafts()
  } else {
    drawerOpen.value = true
  }
}

/* ---------- @纪要引用（输入 @ 弹出选择器，发送时注入纪要总结与逐句转写） ---------- */
const memoPickerOpen = ref(false)

watch(
  () => draft.value,
  (v) => {
    if (v.endsWith('@')) memoPickerOpen.value = true
  },
)

function onPickMemo(m: VoiceMemo): void {
  memoPickerOpen.value = false
  if (memoRefs.value.some((x) => x.id === m.id)) return
  memoRefs.value = [...memoRefs.value, m]
  draft.value = draft.value.slice(0, -1) // 去掉触发的 @
}

function removeMemoRef(id: string): void {
  memoRefs.value = memoRefs.value.filter((m) => m.id !== id)
}

onMounted(() => {
  void (async () => {
    // 分页初始化 = 建/取会话 + 尾页（E 域未合并时沿用旧 init 的全量加载）
    await paging.init()
    await nextTick()
    measureVirtual()
    await scrollToBottom()
    // 底栏在别的页面按了发送、草稿里带着附件 / 文档 / 纪要：等会话就位后用同一套
    // send() 组装并发出（图片视图 / 文档元数据只有本页有）。busy 时 send 自己会拒绝，
    // 草稿原样留在输入框，不丢。
    if (composer.takeSendRequest()) send()
    // 抢课面板「交给 AI 排查」递过来的现场：**直接发**，不再让人按一次发送 ——
    // 那正是抢课窗口里最缺时间的时候。取完即清，回到本页不会重复发。
    const handed = ai.takePendingPrompt()
    if (handed) {
      // 正在生成时不能直接发（sendText 会直接返回，那段现场就没了）：落到输入框里等着，
      // 比默默丢掉强 —— 人至少看得见「有话没发出去」。
      if (ai.busy) draft.value = handed
      else void ai.sendText(handed)
    }
    // 知识库/记忆卡「查看原文」跳进本页：URL 带 anchor + chat，定位并高亮后清参数
    await jumpFromRouteAnchor()
    await loadMemorySurfaces()
  })()
  // 选图压图时要用视觉模型的 imageMaxEdge，提前加载模型配置
  void useModelsStore().load().catch(() => undefined)
  refreshDrafts()
  if (route.query.intent === 'photo') openCamMenu()
  // 底栏「+」不再交接草稿：文字 / 附图 / 文档 / 引用都住在 stores/composer，
  // 导航过来时输入框里原样就是那份草稿（只填不发）。
})

/** 从 KnowledgePage / MemoryCards 深链进来：先切会话，再 around 到消息并高亮。 */
async function jumpFromRouteAnchor(): Promise<void> {
  const anchor = route.query.anchor
  if (typeof anchor !== 'string' || !anchor) return
  const chat = typeof route.query.chat === 'string' ? route.query.chat : null
  await jumpToMemoryAnchor(anchor, chat)
  const query = { ...route.query }
  delete query.anchor
  delete query.chat
  void router.replace({ query })
}

// 分享收件箱：路由带 ?intent=share 时消费预填（冷启动 / 运行中被分享唤起都会走到这里）
watch(
  () => route.query.intent,
  (v) => {
    if (v === 'share') void consumeShare()
  },
  { immediate: true },
)

/* 其他页（桌面信息栏「问点什么」）带来的问题：预填进输入框并清掉 URL 参数 */
watch(
  () => route.query.ask,
  (v) => {
    if (typeof v === 'string' && v) {
      draft.value = v
      void router.replace({ query: { ...route.query, ask: undefined } })
    }
  },
  { immediate: true },
)

/** 空会话看板是否该出现：初始挂载前的骨架期、尾页加载中都不要闪看板。
 *  reset() 之后（新对话/清空）没有尾页请求，也应该直接给看板。 */
const boardVisible = computed(
  () => paging.ready || (paging.started && !paging.loadingTail && !paging.error),
)

/** 最后一条消息 id：只有「尾部追加 / 撤回」才变；前插不触发吸底 */
const lastMessageId = computed(() => ai.messages.at(-1)?.id ?? null)

watch(lastMessageId, (id) => {
  if (!id || suppressAutoScroll.value) return
  void scrollToBottom()
})

// 流式输出：过程段/思考/工具任一事件后跟随滚动（等价 EffiBuddy 的事件级 scrollBottom）。
// 虚拟列表只更新末段（它在窗口内），这里只负责把视口跟到底。
watch(
  () => ai.streamSeq,
  () => {
    // 逐 token 只补 1 帧；定稿/吸底另有 3 帧的收尾路径
    if (!suppressAutoScroll.value) void scrollToBottom(1)
  },
)

// 回合结束后再跟一次：定稿会把流式占位气泡 morph 成食物卡 / 分析卡，**卡片是在最后一条
// 流式事件之后才长高的** —— 那一次事件已经滚过了，这里不补一刀，卡片就停在视口下方。
// 虚拟列表用 spacer 估算高度，需要等 ResizeObserver 实测后再补一帧。
watch(
  () => ai.busy,
  (busy) => {
    if (!busy && !suppressAutoScroll.value) void scrollToBottom()
  },
)

// 切会话：E 域的 selectChat 会自己 loadTail；这里兜住旧路径（直接全量加载）与记忆卡刷新
watch(
  () => ai.chatId,
  () => {
    void (async () => {
      await paging.syncChat()
      await nextTick()
      // 等消息就位后再取注入结果（loadCardsForChat 内部还会再校验一次 chatId）
      await refreshMemoryCards()
    })()
  },
)

async function scrollToBottom(passes = 3): Promise<void> {
  await scrollVirtualBottom(passes)
}

/** 文本是否疑似 Markdown（含至少两种语法特征） */
function looksLikeMarkdown(text: string): boolean {
  let hits = 0
  if (/^#{1,6}\s/m.test(text)) hits++
  if (/^\s*[-*•]\s/m.test(text)) hits++
  if (/^\s*\d+\.\s/m.test(text)) hits++
  if (/\*\*[^*]+\*\*/.test(text)) hits++
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) hits++
  if (/```/.test(text)) hits++
  if (/^\s*>\s/m.test(text)) hits++
  if (/\|.*\|/.test(text)) hits++
  return hits >= 2
}

function send(): void {
  if (ai.busy) return
  let t = draft.value.trim()
  const doc = docAtt.value
  if (!t && attachments.value.length === 0 && !doc) return
  // 粘贴/输入的文本疑似 Markdown 时，告知模型按 Markdown 理解
  if (t && looksLikeMarkdown(t)) {
    t = `（以下内容为 Markdown 格式）\n${t}`
  }
  draft.value = ''
  const atts = attachments.value
  attachments.value = []
  docAtt.value = null
  const q = quote.value
  quote.value = null
  // 组装待发送图片：附图（原图高分辨率保留给放大镜）+ 文档勾选的内嵌图
  const images: SendImage[] = atts.map((a, i) => ({
    base64: a.full,
    mime: 'image/jpeg',
    w: a.w,
    h: a.h,
    label: atts.length > 1 ? `附图 ${i + 1}` : '附图',
    source: a.source,
  }))
  let docMeta: AiDocMeta | undefined
  if (doc) {
    for (const im of doc.doc.images) {
      if (!doc.selected.has(im.id)) continue
      const v = doc.views.get(im.id)
      if (v) {
        images.push({
          base64: v.base64,
          mime: 'image/jpeg',
          w: v.w,
          h: v.h,
          label: `文档《${doc.file.name}》${im.where}`,
          source: new Blob([im.bytes as BlobPart], { type: im.mime }),
        })
      }
    }
    docMeta = {
      name: doc.file.name,
      kind: doc.doc.kind,
      text: doc.doc.text,
      fullText: doc.doc.fullText,
      chars: doc.doc.chars,
      truncated: doc.doc.truncated,
      imagesTotal: doc.doc.images.length,
      skippedImages: doc.doc.skippedImages,
    }
  }
  const refs = memoRefs.value
  memoRefs.value = []
  void ai.sendText(t, { quoteText: q?.text, images: images.length > 0 ? images : undefined, doc: docMeta, memoRefs: refs })
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  await prepareFile(file)
}

/** 图库多选：逐张压入附图列表 */
async function onGallery(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  for (const f of files) await prepareFile(f, f.type || 'image/*')
}

/** 系统相机拍摄：每次拍一张并累积，可连续点菜单多拍几张 */
async function onCamera(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  const before = attachments.value.length
  await prepareFile(file, file.type || 'image/*')
  if (attachments.value.length > before) {
    toast.toast(attachments.value.length > 1 ? `已添加第 ${attachments.value.length} 张，可继续拍摄` : '已添加，可继续拍摄或直接发送')
  }
}

/** 统一文件预填：Office/文本 → 文档芯片（解析+图片勾选）；图片 → 附图芯片（可多张累积） */
async function prepareFile(file: File, mimeHint?: string): Promise<void> {
  // HEIF 在 Windows 上常常没有 MIME（File.type 是空串），推不出 image/* 就会被当成不支持的类型
  const mime = mimeHint || imageTypeOf(file)
  const kind = officeKindOf(file.name)
  try {
    if (kind === 'text' || (!kind && (mime.startsWith('text/') || /\.(md|txt|markdown|csv)$/i.test(file.name)))) {
      const doc = await parseTextFile(file)
      attachDoc(file, doc)
      return
    }
    if (kind) {
      const doc = await parseOffice(file, file.name)
      attachDoc(file, doc)
      return
    }
    if (mime.startsWith('image/')) {
      if (attachments.value.length >= MAX_ATTACHMENTS) {
        toast.toast(`附图最多 ${MAX_ATTACHMENTS} 张`)
        return
      }
      if (await isHeifBlob(file)) toast.toast('正在转换 HEIC 图片…')
      // 压出发送视图（≤模型上限，坐标空间）与缩略图；原始文件保留给放大镜
      const bm = await decodeBitmap(file)
      const [view, small] = await Promise.all([
        bitmapToJpeg(bm, imageEdgeCap(), 0.85),
        bitmapToJpeg(bm, 240, 0.6).catch(() => null),
      ])
      attachments.value = [...attachments.value, { full: view.base64, small: small?.base64 ?? null, w: view.width, h: view.height, source: file }]
      bm.close()
      return
    }
    toast.toast('不支持的文件类型，仅支持图片 / 文本 / Markdown / Office 文档')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 解析完成 → 挂文档芯片（默认勾选前 3 张内嵌图） */
async function attachDoc(file: File, doc: ParsedDoc): Promise<void> {
  const cap = imageEdgeCap()
  const views = new Map<string, { base64: string; w: number; h: number }>()
  for (const im of doc.images) {
    const blob = new Blob([im.bytes as BlobPart], { type: im.mime })
    const bm = await decodeBitmap(blob)
    const r = await bitmapToJpeg(bm, cap)
    views.set(im.id, { base64: r.base64, w: r.width, h: r.height })
    bm.close()
  }
  docAtt.value = {
    file,
    doc,
    views,
    selected: new Set(doc.images.slice(0, 3).map((im) => im.id)),
  }
}

/** 消费分享收件箱预填（系统分享/打开的文件，见 system/shareInbox） */
async function consumeShare(): Promise<void> {
  const p = shareInbox.takePending()
  if (!p) return
  const bytes = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))
  const file = new File([bytes], p.name, { type: p.mime })
  await prepareFile(file, p.mime)
}

/* ---------- 长按菜单（复制 / 引用 / 撤回；桌面右键同款） ---------- */

let pressTimer: number | undefined
let pressStart: { x: number; y: number } | null = null
/** 长按开始时把菜单要锚定的元素**先存下来**：450ms 后 event.currentTarget 已是 null */
let pressEl: HTMLElement | null = null

function onPressStart(e: PointerEvent, m: AiMessage, el: HTMLElement): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  pressStart = { x: e.clientX, y: e.clientY }
  pressEl = el
  // 长按期间行不能被虚拟窗口回收：pin 住所在段（菜单关闭/短按时释放）
  transientPinned.clear()
  pinMessage(m.id, transientPinned)
  pressTimer = window.setTimeout(() => {
    pressTimer = undefined
    menuAnchor.value = pressEl
    menuTarget.value = m
  }, 450)
}

function onPressMove(e: PointerEvent): void {
  // 手指移动超过 8px 视为滚动，取消长按
  if (pressTimer === undefined || !pressStart) return
  if (Math.abs(e.clientX - pressStart.x) > 8 || Math.abs(e.clientY - pressStart.y) > 8) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
    transientPinned.clear()
  }
}

function onPressEnd(): void {
  if (pressTimer !== undefined) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
  // 长按已开菜单时保留 pin（菜单锚点还在被长按的行上）；短按/滑动则释放
  if (menuTarget.value === null) transientPinned.clear()
}

/* ---------- 语音输入（麦克风按钮：按住说话 / 轻点连听，链路见 system/aiVoiceInput） ---------- */

/** 按下中的本地状态：松开结算挂窗口级 pointerup —— 手指滑出按钮也能收住 */
let voicePressing = false
let voiceDownAt = 0

function onVoiceWindowUp(): void {
  if (!voicePressing) return
  voicePressing = false
  window.removeEventListener('pointerup', onVoiceWindowUp)
  window.removeEventListener('pointercancel', onVoiceWindowUp)
  if (!aiVoiceInput.active) return
  if (Date.now() - voiceDownAt < VOICE_TAP_MS) {
    // 轻点 → 转入连听：等「停止信号」（音量占优的发言人停顿）自动结束，或再点一次手动结束
    aiVoiceSetContinuous()
  } else {
    // 按住松开 → 结束并把识别文字送进输入框
    void aiVoiceStop()
  }
}

function onVoiceDown(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault() // 不抢焦点：文本域光标与软键盘保持原状
  voiceDownAt = Date.now()
  voicePressing = true
  window.addEventListener('pointerup', onVoiceWindowUp)
  window.addEventListener('pointercancel', onVoiceWindowUp)
  void aiVoiceStart('hold').then((ok) => {
    if (!ok) {
      onVoiceWindowUp() // 起播失败：先复位本地按压状态再提示
      if (aiVoiceInput.lastError) toast.toast(aiVoiceInput.lastError)
    }
  })
}

/** 识别结果上屏：非空追加进输入框（中英文邻接自动补空格），空结果按原因提示 */
function onVoiceDone({ text, reason }: AiVoiceResult): void {
  if (text) {
    draft.value = appendVoiceText(draft.value, text)
    void nextTick(() => composerEl.value?.focus())
  } else if (reason === 'error') {
    toast.toast(aiVoiceInput.lastError || '识别失败')
  } else if (reason !== 'cancel') {
    toast.toast('没有识别到内容')
  }
}

onAiVoiceResult(onVoiceDone)

// 语音输入是页面手势：离开本页即取消（不把半截话留在运行时里）；
// 按压中的窗口监听一并拆掉，别留跨页的悬空回调
onBeforeUnmount(() => {
  voicePressing = false
  window.removeEventListener('pointerup', onVoiceWindowUp)
  window.removeEventListener('pointercancel', onVoiceWindowUp)
  if (aiVoiceInput.active) void aiVoiceCancel()
  // 本页卸载时菜单随之消失：别把「保持收起」的请求留在单例里
  composerMenuOpen.value = false
  // 长按定时器不能在页面卸载后补一次 menuTarget 赋值（虚拟化下更容易遇到）
  if (pressTimer !== undefined) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
  if (flashTimer) {
    clearTimeout(flashTimer)
    flashTimer = null
  }
  memoryCardsRO?.disconnect()
  memoryCardsRO = null
  // 节流中的高度缓存最后一批落盘
  flushHeights()
})

function onCtxMenu(e: MouseEvent, m: AiMessage, el: HTMLElement): void {
  e.preventDefault()
  transientPinned.clear()
  pinMessage(m.id, transientPinned)
  menuAnchor.value = el
  menuTarget.value = m
}

function onMenuClose(): void {
  menuTarget.value = null
  transientPinned.clear()
}

const menuActions = computed<MenuItem[]>(() => {
  const m = menuTarget.value
  if (!m) return []
  const acts: MenuItem[] = []
  if (m.text) acts.push({ label: '复制', value: 'copy', icon: Copy })
  acts.push({ label: '引用', value: 'quote', icon: Quote })
  if (m.role === 'user') acts.push({ label: '撤回（连同其后对话）', value: 'retract', icon: RotateCcw, danger: true })
  return acts
})

async function onMenuSelect(value: string, target: AiMessage | null = menuTarget.value): Promise<void> {
  const m = target
  menuTarget.value = null
  transientPinned.clear()
  if (!m) return
  if (value === 'copy' && m.text) {
    const ok = await copyText(m.text)
    toast.toast(ok ? '已复制' : '复制失败')
  } else if (value === 'quote') {
    quote.value = m
  } else if (value === 'retract') {
    void ai.retract(m.id)
  }
}

/**
 * 消息行的键盘路径：长按菜单原先只有指针能开（触屏长按 / 桌面右键），键盘用户一条都碰不到。
 * 给 .msg 一个可聚焦的组：Enter 开同一份菜单，c / q / Backspace 直通 onMenuSelect 里
 * 已有的三个动作 —— 同一套语义、同一条实现，不另起一份逻辑。
 * 只在焦点落在消息行自身时响应：行内按钮（折叠推理块等）继续用自己的键。
 */
function onMsgKey(e: KeyboardEvent, m: AiMessage, el: HTMLElement): void {
  if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'Enter') {
    e.preventDefault()
    transientPinned.clear()
    pinMessage(m.id, transientPinned)
    menuAnchor.value = el
    menuTarget.value = m
    return
  }
  const k = e.key.toLowerCase()
  if (k === 'c' && m.text) {
    e.preventDefault()
    void onMenuSelect('copy', m)
  } else if (k === 'q') {
    e.preventDefault()
    void onMenuSelect('quote', m)
  } else if (e.key === 'Backspace' && m.role === 'user') {
    e.preventDefault()
    void onMenuSelect('retract', m)
  }
}
</script>

<template>
  <div class="page">
    <!-- 消息区是唯一的滚动容器：页头与底栏都粘在它内部（sticky）。
         页头仍是「内容从渐进模糊里滚过」（遮罩见 ProgressiveBlur/PageHeader）；
         底栏不是 —— 它是一组悬浮玻璃，正文从它们背后与两侧滚过。 -->
    <div ref="listEl" class="msgs">
      <!-- 无标题页头：左右都是 38px 圆钮，中间不再放「AI」两个字的悬空标签。
           页面身份由内容（看板 / 消息流）与 Dock 的选中态表达。 -->
      <PageHeader compact>
        <template #lead>
          <!-- 左上角唯一入口：「历史」。原来分列「文件」「历史记录」两颗圆钮，
               右下角又一枚「新建对话」圆钮 + 一枚「管理模型」胶囊 —— 四个控件里
               三种形态（圆钮 / 圆钮 / 圆钮 / 胶囊），重要性却与形态相反：
               真正每天要用的「记一笔」藏在最左边，而形态最重的胶囊是配置。
               现在按「频率」重排：历史（合并入口，收起四项）· 新建对话（主操作，实底）
               · 管理模型（降级为次要圆钮，形态与其余两枚一致）。 -->
          <button
            ref="histBtn"
            class="hdr-btn"
            aria-label="历史"
            :aria-expanded="histMenuOpen"
            @click="histMenuOpen = !histMenuOpen"
          >
            <History :size="18" :stroke-width="2.2" />
          </button>
        </template>
        <template #action>
          <button class="hdr-btn accent" aria-label="新建对话" @click="ai.newChat()">
            <Plus :size="18" :stroke-width="2.6" />
          </button>
          <button class="hdr-btn" aria-label="管理模型" @click="router.push({ name: 'ai-models' })">
            <SlidersHorizontal :size="17" :stroke-width="2.2" />
          </button>
        </template>
      </PageHeader>

      <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 吸顶页头与底栏都留在层外，
           超伸时只有消息位移（system/rubberScroll） -->
      <div class="rubber-layer" data-rubber-content>
        <!-- 顶部记忆卡（E 域创建）：虚拟体之前的普通块，不进入段高度模型。
             卡片内容变化时用 ResizeObserver 重算 bodyOffset（见 observeMemoryCards）。 -->
        <div v-if="memoryCards.length || memoryDreaming" ref="memoryCardsEl" class="memory-cards-host">
          <MemoryCards
            :cards="memoryCards"
            :dreaming="memoryDreaming"
            @jump="onMemoryJump"
            @open="onMemoryOpen"
            @dismiss="onMemoryDismiss"
          />
        </div>

        <!-- 空会话：会话看板取代原来那条「你好，我是 Rein AI……」。
             看板只在尾页就绪后出现，加载中不闪。 -->
        <AiBoard v-if="ai.messages.length === 0 && boardVisible" @ask="askFromBoard" @drafts="openDrafts" />

        <div
          v-else-if="ai.messages.length === 0 && !boardVisible && !paging.error"
          class="chat-loading"
          aria-busy="true"
        >
          <span /><span /><span />
        </div>

        <div v-if="paging.error && ai.messages.length === 0" class="chat-error">
          <p>{{ paging.error }}</p>
          <button type="button" @click="paging.loadTail(ai.chatId)">重试</button>
        </div>

        <!-- 键盘可达的「加载更早」哨兵：视觉隐藏、可 Tab 到；滚到顶部也会触发 -->
        <button
          v-if="paging.hasMoreBefore"
          type="button"
          class="load-sentinel"
          aria-label="加载更早的消息"
          @focus="loadOlderAndFocus()"
          @click="loadOlderAndFocus()"
        >
          加载更早的消息
        </button>

        <!-- 虚拟体：上 spacer + 可见段 + 下 spacer。DOM 里只有视口段 + overscan + pinned，
             高度由前缀和给出，与总消息数无关（一万条消息也只渲染 15–25 段）。 -->
        <div ref="virtualBodyEl" class="virtual-body" @focusin="onFocusIn" @focusout="onFocusOut">
          <div class="v-spacer" :style="{ height: `${topSpacer}px` }" aria-hidden="true" />
          <div
            v-for="seg in visibleSegments"
            :key="seg.id"
            class="virtual-seg"
            :ref="(el) => bindSegmentEl(seg.id, el)"
          >
            <ChatSegmentView
              :segment="seg"
              :streaming-bubble-id="ai.streamingBubbleId"
              :meal-of="mealOf"
              :expanded-of="expandedOf"
              :flash-id="flashId"
              @press-start="onPressStart"
              @press-move="onPressMove"
              @press-end="onPressEnd"
              @ctx-menu="onCtxMenu"
              @message-key="onMsgKey"
              @open-memo="onOpenMemo"
              @commit="onCommit"
              @stash="stashParse"
              @update-items="onUpdateItems"
              @update-meal="onUpdateMeal"
              @update-process="onUpdateProcess"
              @detail-open="onDetailOpen"
              @detail-close="onDetailClose"
              @open-file="openChatFile"
              @height-dirty="invalidateMessage"
            />
          </div>
          <div class="v-spacer" :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />
        </div>

        <!-- 键盘可达的「加载更新」哨兵：around 跳转后用户可继续往下读 -->
        <button
          v-if="paging.hasMoreAfter"
          type="button"
          class="load-sentinel"
          aria-label="加载更新的消息"
          @focus="loadNewer()"
          @click="loadNewer()"
        >
          加载更新的消息
        </button>
      </div>
    </div>

    <!-- 底栏：**页内悬浮、独占一行** —— 不在滚动容器里（.msgs 的兄弟）。
         放进滚动区里时，正文会从它背后滚过去：芯片与输入行之间的缝里露出被切断的行
         （用户报的「下面被挡住了」）。挪出来之后：正文永远在它上面，不露半截字。
         2026-11-09：输入条不再是独立玻璃，而是 ComposerBar 的一层薄底；
         移动端整块 Teleport 进 Dock（与页签行同一块玻璃），桌面留在页内贴窗下缘。 -->
    <!-- 输入条并入底栏（embedInDock）：.composer 整块 Teleport 进 TabBar 的
         #dock-ai-composer 宿主 —— 引用 / @纪要 / 附图 / 文档芯片与输入行一起住进
         那块大玻璃，与其他页面的合成 Dock 同一构图；桌面（:disabled）留在页内贴窗下缘。
         Teleport disabled 时内容原位渲染，样式零拷贝。 -->
    <Teleport to="#dock-ai-composer" :disabled="!embedInDock">
    <div class="composer" :class="{ embedded: embedInDock }">
      <!-- 快捷操作条已撤掉：原来这里是两颗玻璃药丸「分析今日饮食」「草稿箱」。
           两颗都有问题：
             · 「分析今日饮食」—— analyzeToday 是三句**写死**的话（看 nutrition store
               的实现：把 kcal / 蛋白质缺口 / 钠 / 纤维拼成三行字符串），不走模型；
               而营养子页与主页状态条本来就在展示同一份数据。放在输入栏上方、
               做成「点一下就出一张设定好的卡片」，等于让用户点了才发现得到的是
               模板句 —— 已移除，改成看板上「拍照识食 / 看体重」这类真提问。
             · 「草稿箱」—— 在存草稿动作补上之前（见解析卡），这个入口永远空着；
               现在存草稿在解析卡上，而查看入口并进了左上角「历史」菜单。 -->

      <!-- 引用条 -->
      <Transition name="pop">
        <div v-if="quote" class="quote-bar row">
          <p class="q-text flex-1">引用：{{ quote.text ?? '[图片]' }}</p>
          <button class="q-x" aria-label="取消引用" @click="quote = null">
            <X :size="14" />
          </button>
        </div>
      </Transition>

      <!-- @纪要 chips（发送时注入纪要内容） -->
      <TransitionGroup name="pop" tag="div" class="memo-refs">
        <span v-for="m in memoRefs" :key="m.id" class="memo-chip">
          @ {{ m.title }}<button class="mx" aria-label="移除纪要引用" @click="removeMemoRef(m.id)"><X :size="10" :stroke-width="3" /></button>
        </span>
      </TransitionGroup>

      <!-- 待发送附图芯片（可多张累积：相机连拍 + 图库多选，随下一条消息发出） -->
      <TransitionGroup v-if="attachments.length > 0" name="pop" tag="div" class="attach-row">
        <div v-for="(a, i) in attachments" :key="i" class="attach-chip" :style="{ '--i': i }">
          <img
            :src="`data:image/jpeg;base64,${a.small ?? a.full}`"
            alt="待发送图片"
          >
          <button class="attach-x" aria-label="移除图片" @click="attachments = attachments.filter((_, j) => j !== i)">
            <X :size="11" :stroke-width="3" />
          </button>
        </div>
      </TransitionGroup>

      <!-- 待发送文档芯片（解析结果 + 内嵌图勾选，随下一条消息发出） -->
      <div v-if="docAtt" class="attach-row doc-attach">
        <div class="doc-chip">
          <FileText :size="18" />
          <div class="dc-info">
            <p class="dc-name">{{ docAtt.file.name }}</p>
            <p class="dc-meta"><span class="num">{{ docAtt.doc.chars }}</span> 字{{ docAtt.doc.truncated ? '（已截断）' : '' }} · 图片 <span class="num">{{ docAtt.doc.images.length }}</span> 张<span v-if="docAtt.doc.skippedImages > 0">（跳过 <span class="num">{{ docAtt.doc.skippedImages }}</span> 张图）</span></p>
          </div>
          <button class="attach-x" aria-label="移除文档" @click="docAtt = null">
            <X :size="11" :stroke-width="3" />
          </button>
        </div>
        <div v-if="docAtt.doc.images.length > 0" class="doc-imgs">
          <button
            v-for="im in docAtt.doc.images"
            :key="im.id"
            class="doc-img"
            :class="{ on: docAtt.selected.has(im.id) }"
            :aria-label="`${docAtt.selected.has(im.id) ? '取消发送' : '发送'}${im.where}的图片`"
            @click="toggleDocImage(im.id)"
          >
            <img :src="`data:image/jpeg;base64,${docAtt.views.get(im.id)?.base64 ?? ''}`" alt="文档内嵌图片">
            <small>{{ im.where }}</small>
            <span v-if="docAtt.selected.has(im.id)" class="doc-check"><Check :size="11" :stroke-width="3" /></span>
          </button>
        </div>
        <!-- 面上只留要做的动作；「默认勾选哪几张、发出去能干什么」收进行尾 InfoHint -->
        <p class="doc-hint">
          点选要发给 AI 的图片
          <InfoHint title="随文档发送的图片" content="发送文档时会默认勾选前 3 张内嵌图，点按可以增删，随下一条消息一起发出。发出后可以让 AI 放大查看细节。" />
        </p>
      </div>

      <!-- 输入栏：全局唯一的 ComposerBar（2026-11-09 统一）—— 与其余页面**同一个组件、
           同一层薄底、同一道同心圆角**；AI 页只是多带一串待发送芯片（引用 / 纪要 /
           附图 / 文档）。不再有独立的 .cbar 玻璃：输入框不再自成一块表面。
           flush：行本体的外边距归 .composer.embedded 管，芯片与输入行落在同一条内缩线上。 -->
      <ComposerBar
        ref="composerEl"
        v-model="draft"
        class="cbar"
        flush
        :placeholder="docAtt ? '问问这份文档，或让 AI 放大看图' : attachments.length > 1 ? `问问这 ${attachments.length} 张图，或直接记录饮食` : attachments.length === 1 ? '问问这张图，或直接记录饮食' : undefined"
        :sendable="composer.hasContent"
        :busy="ai.busy"
        add-label="添加附件"
        voice-testid="ai-voice-btn"
        @add="openCamMenu"
        @send="send"
        @voice-down="onVoiceDown"
      />
    </div>
    </Teleport>

    <!-- 三个隐藏入口：系统相机 / 图库多选 / 文件（图片+Office+文本/Markdown） -->
    <input ref="fileEl" type="file" :accept="UPLOAD_ACCEPT" hidden @change="onFile">
    <input ref="galleryEl" type="file" :accept="IMAGE_ACCEPT" multiple hidden @change="onGallery">
    <input ref="cameraEl" type="file" :accept="IMAGE_ACCEPT" capture="environment" hidden @change="onCamera">

    <!-- 「+」添加菜单（bind 式锚定弹出：拍照 / 图库 / 上传文件） -->
    <AppMenu
      :open="camMenuOpen"
      :actions="camActions"
      :anchor="camBtn"
      title="添加内容"
      @close="camMenuOpen = false"
      @select="onCamSelect"
    />

    <!-- 「历史」菜单（bind：依附页头那颗圆钮弹出。文件 / 搜索历史 / 饮食草稿箱 / 历史会话） -->
    <AppMenu
      :open="histMenuOpen"
      :actions="histActions"
      :anchor="histBtn"
      title="历史"
      @close="histMenuOpen = false"
      @select="onHistSelect"
    />

    <HistoryDrawer :open="drawerOpen" @close="drawerOpen = false" />
    <MemoPickerSheet :open="memoPickerOpen" @close="memoPickerOpen = false" @pick="onPickMemo" />

    <!-- 拍照直识别弹层（识别 → 编辑 → 写入 / 存草稿） -->
    <FoodParseSheet ref="foodSheet" @committed="refreshDrafts" @saved-draft="refreshDrafts" />

    <!-- 语音输入全屏遮罩（按住/轻点说话时渐入，结束时渐出回收） -->
    <VoiceInputMask />

    <!-- 食物草稿箱 -->
    <SheetModal :open="draftsOpen" title="食物草稿箱" initial-snap="medium" @close="draftsOpen = false">
      <EmptyState
        v-if="drafts.length === 0"
        :icon="Archive"
        title="暂无草稿"
        hint="拍照识别后点「存草稿箱」，稍后可以回来继续改重量再写入。"
      />
      <ul v-else class="dlist">
        <li v-for="d in drafts" :key="d.id" class="drow">
          <button class="drow-main" @click="editDraft(d)">
            <img
              v-if="d.thumbBase64"
              :src="`data:image/jpeg;base64,${d.thumbBase64}`"
              alt="草稿缩略图"
              class="dthumb"
            >
            <div v-else class="dthumb ph"><Camera :size="16" /></div>
            <div class="dinfo flex-1">
              <p class="dtitle">{{ d.items.map((it) => it.foodName).join('、') }}</p>
              <p class="dmeta">{{ fmtDraftTime(d.createdAt) }} · <span class="num">{{ d.items.length }}</span> 项</p>
            </div>
          </button>
          <button class="ddel" aria-label="删除草稿" @click="deleteDraft(d.id)">
            <Trash2 :size="15" />
          </button>
        </li>
      </ul>
    </SheetModal>

    <!-- 长按/右键菜单 -->
    <AppMenu
      :open="menuTarget !== null"
      :actions="menuActions"
      :anchor="menuAnchor"
      @close="onMenuClose"
      @select="onMenuSelect"
    />
  </div>
</template>

<style scoped>
.page {
  /* 整帧：页面盒恒为 100dvh × 100vw，安全区不从高度里扣。
     顶部让开交给消息区的 padding-top（页头因此落在安全区之下，与其余页面同观感），
     底部让开交给 padding-bottom（输入栏胶囊的底边正好落在 Dock 顶）。
     从前这里是 height: calc(100dvh - safe-top - tabbar-h - safe-bottom - wbar-reserve)：
     高度一缩，页头与底栏就被挤进「视口减安全区」的盒子里，表现自然与别处不同 ——
     挪进内边距后，盒子的尺寸只由视口决定，安全区成了各自的内边距，两者不再互相污染。 */
  height: 100dvh;
  /* 抵掉 .app-frame 的 padding-top（那一层是给整页滚动的内容让开状态栏的）；
     页面自己要占满整帧，安全区由页头与底栏各自让开 */
  margin-top: calc(-1 * var(--safe-top));
  display: flex;
  flex-direction: column;
  /* 底栏占一行（.msgs 的兄弟），底部让开 = Dock 顶 + 它下面这段空气：
     输入条底边因此落在 Dock 顶上方 10px
     （间距不变量：AI 输入栏底→底栏顶 = --cb-gap，见 scripts/e2e-layout-guard.mjs）。
     悬浮运动条停靠在底部时写入的 --wbar-reserve 一并计进来。 */
  --cb-gap: var(--sp-10);
  /* 底栏（输入条）底边到视口底的距离。移动端让开 Dock；--wbar-reserve 是
     悬浮运动条停靠底部时由组件写入的高度预留，一并计进来，否则两者会叠。 */
  --cb-bottom: calc(var(--dock-top) + var(--cb-gap) + var(--wbar-reserve, 0px));
  /* ⚠️ 这里**不再**给底部留内边距（原为 `padding-bottom: var(--cb-bottom)`）。
     留了它，消息区就被截在输入条底边（实测 850），而 Dock 在 860 ——
     于是本页成了全应用唯一「内容够不到主导航」的页面。别的页面（记账 / 首页 / 运动…）
     的滚动容器 `.scrollbody` 一律铺满整个视口，内容从 Dock 底下穿过、透过玻璃看得见
     （见 docs/ARCHITECTURE.md 的 Dock 一条；实测记账页滚到底时最后一行正压在 Dock 下面）。
     AI 页因为自带内层滚动区（.msgs）才要单独对齐。
     输入条是 absolute 定位（`bottom: var(--cb-bottom)`），不依赖这段内边距 ——
     去掉它只改滚动区高度，不动输入条与 Dock 之间的 10px（e2e-layout-guard 守着）。 */
  padding: 0 var(--page-pad-x);
  position: relative;
  /* 滚动区的底部留白 = 让开**输入条** + 一点呼吸。
     它和上面那行内边距是两件事：内边距决定「滚动区能铺到哪」，
     留白决定「最后一行内容能停在哪」。输入条顶边距视口底 = --cb-bottom + 条高(58)，
     所以留白取这个值再 +10 —— 滚到底时最后一条正文停在输入条上方 10px，
     既不会被压住半行，也不会在底部留出一块读不出意义的空白。
     引用条 / 附图芯片出现时 composer 会往上长，那是**正在输入**的瞬时状态，
     用户此刻的注意力在输入栏，不必为它们预留。 */
  --cb-reserve: calc(var(--cb-bottom) + 68px);
}

/* 桌面：没有底部 Dock（TabBar 只在移动端渲染），底栏贴着窗口下缘 */
.desk-main .page {
  --cb-bottom: 26px;
  /* 页面盒高度改吃 .desk-main（= 100dvh - 标题栏）：100dvh 是手机构图
     （页面 = 整窗），桌面下多出标题栏那一截，输入条（bottom:26）会整个沉到
     可视区外 —— 真机截图里发送键被窗口底边切掉一半，就是这 40px。 */
  height: 100%;
}

/* 消息长按菜单：长按窗口内禁用原生文本选择，避免与「长按弹菜单」抢手势。
   只压 :active 这一拍 —— 原先整行 user-select:none 把常规拖选复制也一起禁了，
   而复制本来就是浏览器原生就能做的事（菜单里的「复制」只是同一条路更短一截）。
   **再限定到 coarse**：鼠标这一路「按下」同时就是拖选的起点，:active 期间禁掉选择
   会让跨消息拖选整段失效（对照：1512 上按下横拖 300px，选中为空字符串；
   去掉后同样一拖选中整句）。触屏上「长按 = 开菜单」才是主手势，抑制照旧。
   桌面鼠标的复制路径是右键（onCtxMenu → AppMenu 的「复制」），不经过这里；
   已知取舍：Windows 触屏笔记本（主指针 fine）会走右键那条路。
   键盘焦点沿用全局那条 :focus-visible 焦点环：整行可聚焦，焦点一眼能看见。 */
@media (pointer: coarse) {
  .msg:active {
    user-select: none;
    -webkit-user-select: none;
  }
}

/* 引用块（气泡内）：强调改走整面 accent soft tint，不再靠左边框（side-tab 收编） */
.qblock {
  max-width: 82%;
  padding: var(--sp-6) var(--sp-10);
  background: var(--accent-soft);
  border-radius: var(--radius-m);
  color: var(--text-1);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg.user .qblock {
  align-self: flex-end;
}

/* 引用条（输入条上方）：悬浮的一小块，底走 --surface-translucent ——
   它和芯片不同，下面没有玻璃垫着，太薄的底会被背后的正文压穿。 */
.quote-bar {
  gap: var(--gap-sm);
  padding: var(--sp-8) var(--sp-12);
  margin-bottom: var(--gap-sm);
  border-radius: var(--radius-m);
  background: var(--surface-translucent);
}

.q-text {
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.q-x {
  position: relative;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 50%;
  /* 引用条自身是一层悬浮面，这条里的钮就再深一档，而不是又垫一块实底 */
  background: color-mix(in srgb, var(--text-1) 10%, var(--surface-translucent));
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 26 的圆钮命中区撑到 44：接头像位置不动，只把可点范围放大 */
.q-x::after {
  content: '';
  position: absolute;
  inset: -9px;
}

/* 照片气泡 */
.photo-bubble {
  max-width: 74%;
  border-radius: var(--radius-l);
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
}

.photo-bubble img {
  display: block;
  width: 100%;
  max-height: 220px;
  object-fit: cover;
}

/* 多图：两列网格 */
.photo-bubble.multi {
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.photo-bubble.multi img {
  width: calc(50% - 1px);
  max-height: 150px;
}

/* 文档消息卡（用户发过的文档） */
.doc-card {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  max-width: 86%;
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
}

.dc-info {
  min-width: 0;
}

.dc-name {
  font-weight: var(--fw-medium);
  font-size: var(--fs-footnote);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-meta {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 消息里的文档卡 meta 行：字数/图片数的事实、结论胶囊、说明入口排成一行
   （窄气泡里放不下就整行换行，不像纯文字那样从中间截断） */
.dc-meta-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-tight) var(--gap-sm);
}

/* AI 挂出的文件卡片列：跟着消息列左对齐（.msg-col 的 align-items 已经管了），
   多张之间比消息间距再紧一档 —— 它们是一组「产物」，不是几条独立消息。
   宽度撑到消息列满宽：卡片自己按内容收缩，长路径由卡片内的省略号收住。 */
.msg-files {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--gap-tight);
  width: 100%;
  max-width: 100%;
}

/* 消息滚动区。
   负外边距把滚动区拉成整帧宽（镜像 .page 的横向内边距），再用同值内边距把内容推回去：
   滚动容器按 CSS 规范会裁掉溢出——只要有一个轴不是 visible，另一个轴也会变成 auto——
   于是气泡的 --shadow-card（12px 偏移 + 32/80px 模糊）被自己的滚动区硬切出直边。
   留出这段横向余量，影子才有地方扩散；气泡内容宽度与之前一致。
   flex 列：页头是子项（sticky），内容从它下面滚过。
   底部 padding 给底栏留出 --cb-reserve：底栏是 overlay，正文要从它下面走过，
   但**最后一条必须能滚出玻璃下方**（留白就是为此，见 .page 里的同名变量）。 */
.msgs {
  flex: 1;
  display: flex;
  flex-direction: column;
  margin: 0 calc(-1 * var(--page-pad-x));
  overflow-y: auto;
  padding: 0 var(--page-pad-x) var(--cb-reserve);
  scrollbar-width: none;
  /* 虚拟列表自己做前插/高度回写锚定；浏览器原生 scroll anchoring 会与
     手动 scrollTop += delta 叠加成双倍位移（spacer 布局下触发时机也不可控） */
  overflow-anchor: none;
}

/* 页头自己让开状态栏：margin-top = 安全区高度（其余页面由 .app-frame 的 padding-top 给同一段），
   粘滞位保持 PageHeader 默认的 --safe-top，滚动后正好压在状态栏下缘、遮罩起点落在 0。
   别改成给滚动容器加 padding-top：sticky 的粘滞位会**叠加**在容器的上内边距之上 ——
   实测 `.msgs` padding-top:52 + --ph-stick:42 时页头落在 94（而不是 52），
   页头被顶下去一整段，遮罩起点也跟着错位，越调越乱。 */
.msgs :deep(.page-header) {
  margin-top: var(--safe-top);
}

/* 底栏：**悬浮在滚动区之上**，内容从它下方走过。
   （此前它被特意移出滚动容器、独占一行，理由是那两颗 chips 之间的缝会漏出
   被切断的行 —— 见上方「快捷操作条已撤掉」那段。chips 一撤，这个阻塞点就不存在了：
   底栏只剩输入条本体，整幅、没有缝。2026-11-09 起输入条也不再是一块玻璃，
   而是 ComposerBar 的一层薄底（--field-fill）：在页内它是贴着窗口下缘的一条输入行，
   在移动端则整块并入 Dock —— 两种落点都不会露出半截字。）

   位置用 --cb-bottom 而不是写死：移动端并入 Dock 后本段定位作废（见 .embedded），
   桌面没有 Dock（TabBar 只在移动端渲染），取页面自己的 padding-bottom。 */
/* 并入底栏（.embedded，Teleport 进 TabBar 的宿主）：页内 absolute 的定位与宽度
   全部作废 —— 在 Dock 玻璃里做一根普通列，左右内缩与页签行同档（--gap-tight），
   输入行自身 flush（外边距归这里管）：芯片行与输入行落在同一条内缩线上，
   底边直接与页签行衔接（与其余页面同一个构图）。芯片行 / 引用条的自身间距不动。 */
.composer.embedded {
  position: static;
  left: auto;
  right: auto;
  bottom: auto;
  width: auto;
  margin: var(--gap-tight) var(--gap-tight) 0;
}

.composer {
  position: absolute;
  left: var(--page-pad-x);
  right: var(--page-pad-x);
  bottom: var(--cb-bottom);
  z-index: 30;
  display: flex;
  flex-direction: column;
  /* 不用 .page 的横向内边距了（自己写 left/right），故宽度即 .msgs 的内容宽 */
  pointer-events: none;
}

/* 只有输入条本体吃指针事件：.composer 整块铺满（含 chips / 引用条 / 附图区），
   那些区域是「看得见但不挡」—— 否则它们上方那半张内容会点不到。 */
.composer > * {
  pointer-events: auto;
}

.msgs::-webkit-scrollbar {
  display: none;
}

/* 气泡之间 8：同一屏里每条消息的独立性靠这条固定节奏读出来 */
.msg {
  margin-bottom: var(--gap-sm);
  display: flex;
  /* 长按期间的按压反馈。只换底色不缩放：消息行是通栏容器，
     transform 会把正文宽度一起改掉 */
  transition: background-color var(--dur-fast) var(--ease-standard);
}

/* 悬停反馈：整行铺一层浅底（行宽 = 阅读栏，鼠标落在哪条消息上一眼可见）。
   底取 --surface-inset（文字色 4% 的半透明井）而不是 --surface-2：这一层压在
   画布的环境光渐变上，实色灰在渐变偏亮的那半幅会**比底还亮**，反而读成高光；
   半透明黑在渐变任何一档都稳定深一档，暗色档同一支公式自动翻成提亮。
   放在 .msg:active 之前：两者同特异性，后写的按下态在点住时接管 ——
   悬停更浅、按下更深，两档分得开。 */
@media (hover: hover) {
  .msg:hover {
    background-color: var(--surface-inset);
    border-radius: var(--radius-m);
  }
}

.msg:active {
  background-color: var(--surface-2);
  border-radius: var(--radius-m);
}

.msg.user {
  justify-content: flex-end;
}

.msg.assistant {
  justify-content: flex-start;
}

/* 文本消息容器（可带思考折叠框） */
.msg-col {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  max-width: 82%;
}

.msg.user .msg-col {
  align-items: flex-end;
}

.msg.assistant .msg-col {
  align-items: flex-start;
}

.msg-col .bubble {
  max-width: 100%;
}

/* 气泡：内距 12（竖向）/ 16（横向），行高走正文档。
   overflow-wrap 兜住长串（URL / 路径 / 哈希）：气泡是定宽列，长串不能把它撑出横向滚动。 */
.bubble {
  max-width: 82%;
  padding: var(--sp-12) var(--sp-16);
  border-radius: var(--radius-l);
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.msg.user .bubble {
  background: var(--accent);
  color: var(--on-accent);
  border-bottom-right-radius: var(--radius-xs);
}

.msg.assistant .bubble {
  background: var(--surface);
  box-shadow: var(--shadow-card);
  border-bottom-left-radius: var(--radius-xs);
}

/* 流式打字光标与打字点（仅流式占位气泡） */
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: var(--sp-2);
  vertical-align: -0.12em;
  background: var(--text-2);
  animation: rein-caret-blink 1s steps(2, start) infinite;
}

.tdots {
  display: inline-flex;
  gap: var(--gap-tight);
  padding: var(--sp-2) 0;
}

.tdots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-3);
  animation: tdots-pulse 1.2s ease-in-out infinite;
}

.tdots i:nth-child(2) { animation-delay: 0.15s; }
.tdots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes tdots-pulse {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

@media (prefers-reduced-motion: reduce) {
  .caret,
  .tdots i {
    animation: none;
  }
}

/* 解析卡 */
.parse,
.analysis {
  width: 92%;
  max-width: 360px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  border-radius: var(--radius-m);
  border-bottom-left-radius: var(--radius-xs);
  padding: var(--pad-card);
}

.parse-title {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  margin-bottom: var(--gap-sm);
}

/* 食物草稿箱 */
.dlist {
  display: flex;
  flex-direction: column;
}

.drow {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: 0;
  min-height: var(--row-h-double);
}

/* 编辑入口铺满整行：行本身不再是 click 目标，键盘焦点与读屏都落在这颗按钮上 */
.drow-main {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  flex: 1;
  min-width: 0;
  text-align: left;
}

.drow + .drow {
  border-top: 0.5px solid var(--line);
}

.dthumb {
  width: 46px;
  height: 46px;
  flex: none;
  /* 缩略图走小尺寸容器档 8，不跟母卡抢 16 */
  border-radius: var(--radius-s);
  object-fit: cover;
  background: var(--surface-2);
}

.dthumb.ph {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

.dinfo {
  min-width: 0;
}

.dtitle {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dmeta {
  /* 主次文本上下 2：标题与下面那行时间/项数走语义间隔 */
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.ddel {
  position: relative;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-3);
}

/* 删除是草稿行唯一带破坏性的钮：纵向撑到 44，横向不外扩（左边就是「打开草稿」那一大片，
   外扩会把落在行尾的点击从打开改成删除） */
.ddel::after {
  content: '';
  position: absolute;
  inset: -6px 0;
}

.ddel:active {
  background: var(--surface-2);
  color: var(--danger);
}

.meal {
  margin-top: var(--sp-10);
}

/* 解析卡的两个去向：存草稿（次要）/ 加入记录（主操作）。
   两个都排右侧、主操作在最后 —— 与弹层里 FoodParseSheet 的那条同一条约定。 */
.actions {
  margin-top: var(--gap-md);
  gap: var(--gap-sm);
  justify-content: flex-end;
}

.stash {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.stash:disabled {
  opacity: var(--disabled-opacity);
}

/* 匹配情况说明：卡面上要读出来的原因，不用 --text-3（见模板注释） */
.parse-hint {
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.commit {
  min-height: var(--control-md);
  padding: 0 var(--sp-20);
  border-radius: var(--radius-full);
  background: var(--ok);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.committed {
  margin-top: var(--gap-md);
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  /* 状态词当文字用：实底档 --ok 压白底只有 ~2.2:1，走 --ok-strong */
  color: var(--ok-strong);
}

/* 分析卡 */
.a-title {
  gap: var(--gap-sm);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--accent);
  margin-bottom: var(--gap-tight);
}

.a-body {
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

/* 「快捷操作」药丸（.chips / .chip）已随那两颗 chip 一起撤掉，样式不再有引用。 */

/* 待发送附图芯片（Kimi 式：缩略图 + 右上角移除钮，多张自动换行） */
.attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  padding: 0 var(--sp-2) var(--sp-8);
}

.attach-chip {
  position: relative;
  width: 56px;
  height: 56px;
}

.attach-chip img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 图片走小圆角档 8（不是母卡的 16） */
  border-radius: var(--radius-s);
  background: var(--surface-2);
}

.attach-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-2);
}

/* 20px 的移除角标是最容易点空的钮：外扩 12 到 44×44。它压在缩略图上，
   而缩略图本身没有别的动作（芯片只负责「看 + 移除」），不会抢走任何点击。 */
.attach-x::after {
  content: '';
  position: absolute;
  inset: -12px;
}

/* 待发送文档芯片（文档卡 + 内嵌图勾选网格） */
.doc-attach {
  flex-direction: column;
  gap: var(--gap-sm);
}

.doc-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-m);
  /* 待发送文档芯片也是悬浮的一块：与引用条同档的底（下面没有玻璃垫着） */
  background: var(--surface-translucent);
  color: var(--text-1);
  width: 100%;
}

.doc-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}

.doc-img {
  position: relative;
  width: 72px;
  border-radius: var(--radius-s);
  overflow: hidden;
  background: var(--surface-2);
  padding: 0;
}

.doc-img img {
  display: block;
  width: 100%;
  height: 56px;
  object-fit: cover;
  opacity: 0.45;
}

.doc-img small {
  display: block;
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-align: center;
  padding: var(--sp-2) 0 var(--sp-4);
}

.doc-img.on img {
  opacity: 1;
}

.doc-img.on small {
  color: var(--text-1);
}

.doc-check {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-card);
}

.doc-hint {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 语音轮气泡（用户侧，点开语音会话回看纪要/重放） */
.voice-bub {
  max-width: 82%;
  padding: var(--sp-12) var(--sp-16);
  border-radius: var(--radius-l);
  border-bottom-right-radius: var(--radius-xs);
  background: var(--accent);
  color: var(--on-accent);
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
}

.voice-bub .vb-head {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  opacity: 0.92;
}

.voice-bub .vb-txt {
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
}

.voice-bub .vb-go {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

/* @纪要引用 chips */
.memo-refs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  padding: 0 var(--sp-2) var(--sp-8);
}

/* 空态不占位：TransitionGroup 没有 chip 时也渲染这层壳，壳的 8px 下内距会把
   输入行顶下去 —— AI 页的 Dock 因此比其余页面高 8px（统一输入条后是显眼的错位）。
   :empty 只管「没有元素子节点」这一态，chip 进出动效不受影响（注释节点不算）。 */
.memo-refs:empty {
  display: none;
}

.memo-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: 0 var(--gap-sm);
  border-radius: var(--radius-full);
  /* 纪要芯片也浮在正文上：底色取主色的 16% 并与 --surface-translucent 合成，
     而不是 12% 的主色直接铺在半透明层上（那样正文会透上来） */
  background: color-mix(in srgb, var(--accent) 16%, var(--surface-translucent));
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  max-width: 70%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.memo-chip .mx {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(0, 122, 255, 0.18);
}

/* 14px 的移除钮：横向扩 6（往左是 chip 的圆角边）、纵向扩 15，凑到 44 一档 */
.memo-chip .mx::after {
  content: '';
  position: absolute;
  inset: -15px 0 -15px -6px;
}

/* 气泡内 Markdown（MdText 渲染的内容不带 pre-line，由块级元素控制行距） */
.bubble :deep(.md) {
  font-size: inherit;
  line-height: inherit;
}

/* 输入条内部（控件排布 / 圆钮 / 文本域 / 发送态）统一在 common/ComposerBar.vue ——
   AI 页与其余页面是**同一个组件**，这里不再保留第二份 .inbar / .cam / .vbtn / .send
   样式（两份定义必然漂，是这个仓付过代价的教训）。 */

/* 引用条 / 纪要 chips / 附图 chips 的入场：可打断的 CSS transition，不用 @keyframes ——
   连拍、连选时会连续插入，transition 能被下一次进入直接接管而不会各播各的。
   延迟按 --i 递增，附图多张时依次落位。 */
.pop-enter-active {
  transition:
    opacity var(--dur-fast) var(--ease-out) calc(var(--i, 0) * var(--enter-stagger, 40ms)),
    transform var(--dur-fast) var(--ease-out) calc(var(--i, 0) * var(--enter-stagger, 40ms));
}

.pop-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

/* ============================================================
   虚拟列表外壳
   ============================================================ */

/* 记忆卡是虚拟体之前的普通块：滚动不参与段高度，content 变化由 RO 触发 measure */
.memory-cards-host {
  margin-bottom: var(--gap-md);
}

/* 上 spacer + 可见段 + 下 spacer；高度由前缀和给出，容器自身不设固定高 */
.virtual-body {
  display: block;
  min-height: 1px;
}

.v-spacer {
  width: 100%;
  pointer-events: none;
}

/* 段外壳：flow-root 让段内最后一条消息的 margin-bottom 计入实测高度；
   不给 transform/contain:paint，避免气泡阴影与 sticky 页头被裁 */
.virtual-seg {
  display: flow-root;
}

/* 「加载更早」哨兵：视觉上只有 1px，键盘 Tab 得到、滚到顶部也会触发 */
.load-sentinel {
  display: block;
  width: 100%;
  height: 1px;
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  color: transparent;
  font-size: 1px;
  line-height: 1px;
  cursor: default;
}

.load-sentinel:focus-visible {
  /* 不改变高度：哨兵在虚拟体之前，长高会把所有段整体下移 27px */
  background: var(--accent);
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 加载中骨架（只在尾页未就绪时出现，避免 AiBoard 先闪一下） */
.chat-loading {
  display: flex;
  justify-content: center;
  gap: var(--gap-sm);
  padding: var(--sp-20) 0;
}

.chat-loading span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  animation: tdots-pulse 1.2s ease-in-out infinite;
}

.chat-loading span:nth-child(2) { animation-delay: 0.15s; }
.chat-loading span:nth-child(3) { animation-delay: 0.3s; }

.chat-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.chat-error button {
  min-height: var(--control-sm);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}

@media (prefers-reduced-motion: reduce) {
  .chat-loading span {
    animation: none;
  }
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   对话在宽屏上仍是一条**阅读栏**：主人区整宽铺开会让每行正文长到读不下去
   （.msg-col / .bubble 的 82% 上限是相对容器算的，容器一宽，气泡跟着一起失控）。
   所以整块 —— 页头 + 消息区 + 输入条 —— 收到 --chat-col 宽居中：
   滚动容器与吸顶页头照旧，只是它们的“整帧”变窄了，两侧留白正好是这条栏的呼吸。
   ============================================================ */
.desk-main .page {
  --chat-col: 760px;
  /* 整帧 = 阅读栏 + 两侧页边距；.msgs 的负外边距镜像 --page-pad-x，
     于是滚动区仍与 .page 同宽，气泡的影子不会被裁。 */
  max-width: calc(var(--chat-col) + 2 * var(--page-pad-x));
  margin-inline: auto;
}
</style>

<style>
/* [data-rubber-shell] 是壳层元素（App 自己的 div），AI 的 scoped 属性够不着它 ——
   height:100% 的父链断在这里（shell 高度 auto，页面 100% 退化成内容高，实测 611），
   输入条因此悬在半空 / 沉出可视区。桌面壳下把 shell 撑满 desk-main：AI 页的
   height:100% 才有确定的父高。只命中桌面壳（data-shell=desk），移动壳不受影响；
   其余桌面页不受扰（页面各自的高度声明在 shell 之内照常生效，超高照旧走 desk-main 滚动）。 */
html[data-shell='desk'] main.desk-main > [data-rubber-shell] {
  height: 100%;
}
</style>
