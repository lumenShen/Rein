<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Archive,
  BookOpen,
  Camera,
  ChartPie,
  Check,
  Copy,
  FileText,
  Folder,
  FolderUp,
  History,
  Images,
  Mic,
  Plus,
  Quote,
  RotateCcw,
  Search,
  SendHorizontal,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import GlassSurface from '@/components/common/GlassSurface.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import HistoryDrawer from '@/components/ai/HistoryDrawer.vue'
import FoodParseSheet from '@/components/ai/FoodParseSheet.vue'
import ProcessSection from '@/components/ai/ProcessSection.vue'
import ChatFileCard from '@/components/ai/ChatFileCard.vue'
import VoiceInputMask from '@/components/ai/VoiceInputMask.vue'
import MdText from '@/components/common/MdText.vue'
import MemoPickerSheet from '@/components/voice/MemoPickerSheet.vue'
import { openMemoById } from '@/system/voiceRuntime'
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
import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import AiBoard from '@/components/ai/AiBoard.vue'
import { MEAL_LABELS, MEAL_ORDER, suggestMeal } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { kbService } from '@/services/kbService'
import { useAiStore } from '@/stores/ai'
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
import { fmtMmSs } from '@/utils/format'
import type { AiMessage, AiDocMeta, KbEmbeddingMode, KbEntry, MealType } from '@/types'

/** AI 页：拍照直识别（可编辑卡片 + 草稿箱）/ 文字记饮食 / 数据工具对话。 */
const ai = useAiStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()

/** 该消息的气泡元数据（推理过程段 / 思考计时 / 是否被吸收） */
function metaOf(m: AiMessage): ReturnType<typeof ai.getMeta> {
  return ai.getMeta(m.id)
}

/** 正文气泡是否有东西可渲染：有正文，或流式中且还没有过程区（此时显示打字点）。
 *  流式占位气泡在推理/工具阶段是空 text——内容全在 ProcessSection 里，气泡本体不该出现：
 *  它的 padding/底色/阴影会渲染成一个什么都没有的「空气泡」，挂在过程区上方。 */
function showTextBubble(m: AiMessage): boolean {
  if (m.kind !== 'text') return false
  if (m.text) return true
  return !!m.streaming && !metaOf(m)?.segments.length
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
      return showTextBubble(m)
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
  void nextTick(() => {
    autoGrow()
    inputEl.value?.focus()
  })
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

const draft = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const fileEl = ref<HTMLInputElement | null>(null)
const galleryEl = ref<HTMLInputElement | null>(null)
const cameraEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

/** 上传文件的入口要连图片（含 HEIF）带 Office/文本一起收；图库/相机只收图 */
const UPLOAD_ACCEPT = `${IMAGE_ACCEPT},.docx,.pptx,.xlsx,.md,.markdown,.txt,.csv`

/* ---------- 「+」添加菜单（bind 式：锚定按钮弹出，带图标） ---------- */

const camMenuOpen = ref(false)
/** 锚定元素：输入栏左侧的 + 按钮 */
const camBtn = ref<HTMLElement | null>(null)

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

function onCamSelect(value: string): void {
  if (value === 'camera') cameraEl.value?.click()
  else if (value === 'gallery') galleryEl.value?.click()
  else fileEl.value?.click()
}

/** 待发送附图：选图后先挂输入框上方（可移除/配文字），随下一条消息一起发出。
    数组化以支持「连拍几张 + 图库多选」一起发（相机每次拍一张，可累积）。 */
interface AttImage {
  full: string
  small: string | null
  w: number
  h: number
  source: File
}
const attachments = ref<AttImage[]>([])
/** 待发送 Office 文档：解析结果 + 勾选要发给 AI 的内嵌图（可多选，随消息一起发出） */
const docAtt = ref<{
  file: File
  doc: ParsedDoc
  /** 各图片的发送视图（≤模型图片上限的 JPEG） */
  views: Map<string, { base64: string; w: number; h: number }>
  selected: Set<string>
} | null>(null)

function toggleDocImage(id: string): void {
  const d = docAtt.value
  if (!d) return
  const next = new Set(d.selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  docAtt.value = { ...d, selected: next }
}

/** 消息图片列表（photo 单图/多图、doc 多图统一） */
function msgImages(m: AiMessage): { base64: string; mime: string }[] {
  if (m.images?.length) return m.images.map((im) => ({ base64: im.base64, mime: im.mime }))
  return m.imageBase64 ? [{ base64: m.imageBase64, mime: m.mime ?? 'image/jpeg' }] : []
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

/** 历史抽屉 / 长按菜单 / 引用 */
const drawerOpen = ref(false)
const menuTarget = ref<AiMessage | null>(null)
/** 长按菜单锚定元素：被长按的那条消息气泡 */
const menuAnchor = ref<HTMLElement | null>(null)
const quote = ref<AiMessage | null>(null)

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
    void nextTick(() => {
      autoGrow()
      inputEl.value?.focus()
    })
  } else if (value === 'drafts') {
    openDrafts()
  } else {
    drawerOpen.value = true
  }
}

/* ---------- @纪要引用（输入 @ 弹出选择器，发送时注入纪要总结与逐句转写） ---------- */
const memoPickerOpen = ref(false)
const memoRefs = ref<VoiceMemo[]>([])

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
  void nextTick(() => autoGrow())
}

function removeMemoRef(id: string): void {
  memoRefs.value = memoRefs.value.filter((m) => m.id !== id)
}

onMounted(() => {
  void ai.init()
  // 选图压图时要用视觉模型的 imageMaxEdge，提前加载模型配置
  void useModelsStore().load().catch(() => undefined)
  refreshDrafts()
  void scrollToBottom()
  if (route.query.intent === 'photo') openCamMenu()
  // 抢课面板「交给 AI 排查」递过来的现场：**直接发**，不再让人按一次发送 ——
  // 那正是抢课窗口里最缺时间的时候。取完即清，回到本页不会重复发。
  const handed = ai.takePendingPrompt()
  if (handed) {
    // 正在生成时不能直接发（sendText 会直接返回，那段现场就没了）：落到输入框里等着，
    // 比默默丢掉强 —— 人至少看得见「有话没发出去」。
    if (ai.busy) {
      draft.value = handed
      void nextTick(() => autoGrow())
    } else {
      void ai.sendText(handed)
    }
  }
})

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
      void nextTick(() => autoGrow())
    }
  },
  { immediate: true },
)

watch(
  () => ai.messages.length,
  () => void scrollToBottom(),
)

// 流式输出：过程段/思考/工具任一事件后跟随滚动（等价 EffiBuddy 的事件级 scrollBottom）
watch(
  () => ai.streamSeq,
  () => void scrollToBottom(),
)

// 回合结束后再跟一次：定稿会把流式占位气泡 morph 成食物卡 / 分析卡，**卡片是在最后一条
// 流式事件之后才长高的** —— 那一次事件已经滚过了，这里不补一刀，卡片就停在视口下方。
// （用户报的「AI 已经出卡，切页回来才弹出来」：回来时 onMounted 的 scrollToBottom 把它带进视野。）
watch(
  () => ai.busy,
  (busy) => {
    if (!busy) void scrollToBottom()
  },
)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight })
}

/** 文本域自适应高度：随内容增高，上限 5 行，发送后复位 */
function autoGrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = '0'
  const max = 5 * 22 // 5 行 × line-height 约 22px
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
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

function fmtVoiceDur(ms: number): string {
  return fmtMmSs(ms)
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
  // 复位输入框高度
  if (inputEl.value) inputEl.value.style.height = ''
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

function onPressStart(e: PointerEvent, m: AiMessage): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  pressStart = { x: e.clientX, y: e.clientY }
  pressTimer = window.setTimeout(() => {
    pressTimer = undefined
    menuAnchor.value = (e.currentTarget as HTMLElement) ?? null
    menuTarget.value = m
  }, 450)
}

function onPressMove(e: PointerEvent): void {
  // 手指移动超过 8px 视为滚动，取消长按
  if (pressTimer === undefined || !pressStart) return
  if (Math.abs(e.clientX - pressStart.x) > 8 || Math.abs(e.clientY - pressStart.y) > 8) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
}

function onPressEnd(): void {
  if (pressTimer !== undefined) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
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
    void nextTick(() => {
      autoGrow()
      inputEl.value?.focus()
    })
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
})

function onCtxMenu(e: MouseEvent, m: AiMessage): void {
  e.preventDefault()
  menuAnchor.value = (e.currentTarget as HTMLElement) ?? null
  menuTarget.value = m
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
function onMsgKey(e: KeyboardEvent, m: AiMessage): void {
  if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'Enter') {
    e.preventDefault()
    menuAnchor.value = e.currentTarget as HTMLElement
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
        <!-- 空会话：会话看板取代原来那条「你好，我是 Rein AI……」。
             那条字是纯文字气泡，与下面第一条真实消息形态完全一样（都居左、都一个气泡），
             分不清哪条是机器说的；而且它答的是「我是谁」，
             用户真正要问的是「我现在能干什么」—— 看板给的是后者。 -->
        <AiBoard v-if="ai.messages.length === 0" @ask="askFromBoard" @drafts="openDrafts" />

        <template v-for="m in ai.messages" :key="m.id">
          <!-- 键盘可达：整行是一个可聚焦组，Enter 开长按同款菜单，c/q/Backspace 直通三个动作 -->
          <div
            v-if="showMsg(m)"
            :id="`msg-${m.id}`"
            class="msg"
            :class="[m.role]"
            role="group"
            tabindex="0"
            :aria-label="`${m.role === 'user' ? '我' : 'AI'} 的消息（回车打开操作菜单）`"
            @keydown="onMsgKey($event, m)"
            @pointerdown="onPressStart($event, m)"
            @pointermove="onPressMove($event)"
            @pointerup="onPressEnd"
            @pointerleave="onPressEnd"
            @pointercancel="onPressEnd"
            @contextmenu.prevent="onCtxMenu($event, m)"
          >
            <div class="msg-col">
              <!-- 推理过程 + 工具调用合并区块：单行摘要标题，进行中展开、完成后自动折叠 -->
              <ProcessSection
                v-if="metaOf(m)?.segments.length"
                :segments="metaOf(m)?.segments ?? []"
                :is-thinking="metaOf(m)?.isThinking ?? false"
                :thinking-sec="metaOf(m)?.thinkingSec ?? 0"
                :final="m.id !== ai.streamingBubbleId"
              />

              <!-- 引用块 -->
              <p v-if="m.quoteText" class="qblock">{{ m.quoteText }}</p>

              <!-- 照片（可多图；可带随图文字，图与文分气泡，同属一条消息） -->
              <template v-if="m.kind === 'photo' && (m.imageBase64 || m.images?.length)">
                <div class="photo-bubble" :class="{ multi: (m.images?.length ?? 0) > 1 }">
                  <img
                    v-for="(im, i) in msgImages(m)"
                    :key="i"
                    :src="`data:${im.mime};base64,${im.base64}`"
                    alt="用户上传的照片"
                  >
                </div>
                <p v-if="m.text" class="bubble">{{ m.text }}</p>
              </template>

              <!-- 文档消息（解析文本随消息发给模型，气泡展示卡片与勾选的内嵌图） -->
              <template v-else-if="m.kind === 'doc' && m.doc">
                <div class="doc-card">
                  <FileText :size="16" />
                  <div class="dc-info">
                    <p class="dc-name">{{ m.doc.name }}</p>
                    <p class="dc-meta dc-meta-row">
                      <span class="dc-facts"><span class="num">{{ m.doc.chars }}</span> 字{{ m.doc.truncated ? '（已截断）' : '' }} · 图片 <span class="num">{{ m.doc.imagesTotal }}</span> 张</span>
                      <template v-if="m.doc.skippedImages > 0">
                        <StatusChip tone="warn">跳过 <span class="num">{{ m.doc.skippedImages }}</span> 张图</StatusChip>
                        <InfoHint title="被跳过的图片" content="文档里的内嵌图只有一部分会发给 AI：不支持的格式、体积过小的图标或装饰图、重复出现的图，以及超出数量上限的图会被跳过。跳过的图不参与推理，正文不受影响。" />
                      </template>
                    </p>
                  </div>
                </div>
                <div v-if="m.images?.length" class="photo-bubble multi">
                  <img
                    v-for="(im, i) in m.images"
                    :key="i"
                    :src="`data:image/jpeg;base64,${im.base64}`"
                    alt="文档内嵌图片"
                  >
                </div>
                <p v-if="m.text" class="bubble">{{ m.text }}</p>
              </template>

              <!-- 纯文本（Markdown 渲染，流式按块增量；正文还没到就显示打字点）。
                   showTextBubble 已挡掉「有过程区但没正文」的空壳——那正是空气泡的来源 -->
              <div v-else-if="showTextBubble(m)" class="bubble">
                <MdText v-if="m.text" :text="m.text" :streaming="m.streaming" />
                <span v-if="m.text && m.streaming" class="caret" aria-hidden="true" />
                <span v-else-if="!m.text" class="tdots" aria-hidden="true"><i /><i /><i /></span>
              </div>

              <!-- 语音轮（转写 + 关联纪要，点开语音会话回看/重放） -->
              <button v-else-if="m.kind === 'voice'" class="voice-bub" @click="m.voiceMeta && openMemoById(m.voiceMeta.memoId)">
                <span class="vb-head"><Mic :size="13" /> 语音<span v-if="m.voiceMeta" class="num">&nbsp;{{ fmtVoiceDur(m.voiceMeta.durationMs) }}</span> · 会议纪要</span>
                <span class="vb-txt">{{ (m.text ?? '').slice(0, 72) }}{{ (m.text ?? '').length > 72 ? '…' : '' }}</span>
                <span class="vb-go">查看纪要 ›</span>
              </button>

              <!-- 食物解析卡（行内改重量 / 删行，未匹配项不会写入） -->
              <div v-else-if="m.kind === 'food-parse' && m.items" class="parse">
                <p class="parse-title">识别到 <span class="num">{{ m.items.length }}</span> 项食物</p>
                <FoodParseEditor v-model="m.items" />

                <template v-if="!m.committed">
                  <SegmentedControl
                    class="meal"
                    :model-value="mealByMsg[m.id] ?? suggestMeal()"
                    :options="MEAL_ORDER.map((x) => ({ value: x, label: MEAL_LABELS[x] }))"
                    @update:model-value="mealByMsg[m.id] = $event as MealType"
                  />
                  <!-- 两个去向。原先只有「加入记录」，于是底部那个「草稿箱」入口
                       永远是空的 —— saveFoodDraft 只在草稿箱自己的弹层里被调用过，
                       也就是「先进草稿箱、再从草稿箱写入」这条唯一路径没法从聊天流起步。
                       现在两条路并排：当场记，或留到稍后（改重量 / 补匹配）。 -->
                  <div class="row actions">
                    <button
                      class="stash"
                      :disabled="m.items.length === 0"
                      @click="stashParse(m)"
                    >
                      <Archive :size="14" /> 存草稿箱
                    </button>
                    <button
                      class="commit"
                      :disabled="m.items.every((it) => it.foodId == null)"
                      @click="ai.commitParse(m.id, mealByMsg[m.id] ?? suggestMeal())"
                    >
                      加入记录
                    </button>
                  </div>
                  <!-- 写入按钮点不动时，用户最容易漏读的正是这一行：抬到 --text-2（4.9:1），
                       不再吃 .t-3 那档三级灰（白底 3.6:1）。错误原因一律留在卡面上 -->
                  <p v-if="m.items.every((it) => it.foodId == null)" class="parse-hint">
                    全部未匹配到食物库，无法直接写入 —— 可先存草稿，稍后调整。
                  </p>
                </template>
                <p v-else class="committed">
                  <Check :size="14" />
                  {{ m.mealType ? `已写入今日${MEAL_LABELS[m.mealType]}` : '已写入今日饮食' }}
                </p>
              </div>

              <!-- 分析卡 -->
              <div v-else-if="m.kind === 'analysis'" class="analysis">
                <p class="a-title row center"><ChartPie :size="15" /> 今日饮食分析</p>
                <p class="a-body">{{ m.text }}</p>
              </div>

              <!-- AI 挂出的工作区文件（present_file）：点在聊天里，开在文件页里。
                   放在所有正文分支之后 —— 它是「这条回复的产物」，与正文同属一条消息，
                   所以模型只挂了文件没说话时也照常出现。 -->
              <div v-if="m.files?.length" class="msg-files">
                <ChatFileCard
                  v-for="f in m.files"
                  :key="f.path"
                  :file="f"
                  @open="openChatFile"
                />
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 底栏：**悬浮的 dock 栏外观，但它自己占一行** —— 不在滚动容器里（.msgs 的兄弟）。
         放进滚动区里时，正文会从它背后滚过去：芯片之间、芯片与输入条之间的缝里露出被
         切断的行（用户报的「下面被挡住了」），而把它改成 overflow:visible 又会让它按
         视口底部定位、直接压到 Dock 上（超出安全区）。挪出来之后：正文永远在它上面，
         玻璃仍然浮在页面上（两侧页边距 + 与 Dock 之间 10px 空气），只是没有东西从它
         下面穿过 —— 这也正是「挡住」的来源。折射名单见 .chips / .cbar 的注释。 -->
    <div class="composer">
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

      <!-- 输入栏（dock 栏本体，这一组里**唯一**折射的一块）：底比 Dock 的页签厚一档
           （--surface-translucent）—— 这里承载占位文字与用户输入，底太薄时底下的正文
           会把它压到读不清（实测：0.52 的玻璃底上占位只有 3.2:1；这一档把底线拉到
           4.7:1 以上）。两侧圆钮是它内部的浅色层，命中区整块可点。 -->
      <GlassSurface class="cbar" border-radius="var(--radius-full)" fill="var(--surface-translucent)">
        <div class="inbar row">
          <button ref="camBtn" class="cam" aria-label="添加附件" @click="openCamMenu">
            <Plus :size="21" :stroke-width="2.4" />
          </button>
          <textarea
            ref="inputEl"
            v-model="draft"
            rows="1"
            :placeholder="docAtt ? '问问这份文档，或让 AI 放大看图' : attachments.length > 1 ? `问问这 ${attachments.length} 张图，或直接记录饮食` : attachments.length === 1 ? '问问这张图，或直接记录饮食' : '吃了什么？例如：一碗米饭'"
            @keydown.enter.exact.prevent="send"
            @input="autoGrow"
          />
          <!-- 语音输入：按住说话（松开上屏）/ 轻点连听（停顿自动结束，再点即停）。
               持续手势：touch-action 关掉浏览器把按压当滚动起点的默认处理 -->
          <button
            class="vbtn"
            aria-label="语音输入：按住说话，轻点连听"
            data-testid="ai-voice-btn"
            @pointerdown="onVoiceDown"
            @contextmenu.prevent
          >
            <Mic :size="19" :stroke-width="2.2" />
          </button>
          <button
            class="send"
            :class="{ ready: !!draft.trim() || attachments.length > 0 || !!docAtt || memoRefs.length > 0 }"
            aria-label="发送"
            :disabled="ai.busy || (!draft.trim() && attachments.length === 0 && !docAtt && memoRefs.length === 0)"
            @click="send"
          >
            <SendHorizontal :size="18" />
          </button>
        </div>
      </GlassSurface>
    </div>

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
      @close="menuTarget = null"
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
}

/* 页头自己让开状态栏：margin-top = 安全区高度（其余页面由 .app-frame 的 padding-top 给同一段），
   粘滞位保持 PageHeader 默认的 --safe-top，滚动后正好压在状态栏下缘、遮罩起点落在 0。
   别改成给滚动容器加 padding-top：sticky 的粘滞位会**叠加**在容器的上内边距之上 ——
   实测 `.msgs` padding-top:52 + --ph-stick:42 时页头落在 94（而不是 52），
   页头被顶下去一整段，遮罩起点也跟着错位，越调越乱。 */
.msgs :deep(.page-header) {
  margin-top: var(--safe-top);
}

/* 底栏：**悬浮在滚动区之上**，内容从玻璃下方走过。
   （此前它被特意移出滚动容器、独占一行，理由是那两颗 chips 之间的缝会漏出
   被切断的行 —— 见上方「快捷操作条已撤掉」那段。chips 一撤，这个阻塞点就不存在了：
   剩下的唯一一块玻璃是输入条 `.cbar`，它是整幅药丸、没有缝，内容从它背后走
   只会整块被模糊/折射盖住，不会露出半截字。所以改回 overlay ——
   这才是液态玻璃该有的样子：玻璃浮在内容上，内容在它下面流。）

   位置用 --cb-bottom 而不是写死：移动端要让开 Dock（--dock-top + --cb-gap），
   桌面没有 Dock（TabBar 只在移动端渲染），取页面自己的 padding-bottom。
   这条间距是 e2e-layout-guard.mjs 的断言之一（输入栏底 → Dock 顶 = 10）。 */
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

/* 输入条内部：底与描边由 GlassSurface 给（`.cbar`），这里只排布控件 ——
   8px 内边距 + 40px 圆钮 = 56px 高，与 Dock 的 58px 同档。
   （圆钮 40 是**尺寸**几何，与 34 的通用图标钮不同档：输入条要贴着 Dock 的
   58px 读成同一条底栏，缩到 34 就成了「细一号的输入框」。） */
.inbar {
  width: 100%;
  gap: var(--gap-sm);
  padding: var(--sp-8);
}

.cam {
  position: relative;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  /* 玻璃上的图标钮：与卡面角标同一配方（--text-1 的 9%），不再是实底灰 */
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-1);
  /* transform 必须显式带上：scoped transition 会覆盖 base.css 里 button 的全局过渡，
     少了它 :active 的 scale(0.96) 就变成瞬贴 */
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

/* 输入条三颗圆钮的视觉是 40，热区补到 44：外扩 2px 落在 8px 间距里，
   不会互相压住，也不改输入条 56px 的高度。 */
.cam::after,
.vbtn::after,
.send::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.cam:active {
  background: color-mix(in srgb, var(--text-1) 16%, transparent);
}

/* 语音输入钮（与 .cam 同配方）。按住说话是持续手势：
   touch-action 关掉滚动/长按的浏览器默认处理，长按不弹系统菜单也不起滚动 */
.vbtn {
  position: relative;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.vbtn:active {
  background: color-mix(in srgb, var(--text-1) 16%, transparent);
}

.inbar textarea {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  font-family: inherit;
  border: none;
  outline: none;
  background: transparent;
  resize: none;
  /* 22px 是行盒几何（5 行 × 22 = 110 的 max-height 跟它同源），不是间距 */
  line-height: 22px;
  padding: var(--sp-8) 0;
  max-height: 110px; /* 5 行 × 22px */
  overflow-y: auto;
  scrollbar-width: none;
}

.inbar textarea::-webkit-scrollbar {
  display: none;
}

/* 占位文字按正文档读：--text-3 在亮色只有 3.2:1、暗色约 3.6:1（实测），够不着 AA。
   这里按 --text-1 的 64% 合成而不是直接取某个灰：同一个 alpha 在两色下都落在
   「亮 ≈4.7:1 / 暗 ≈6.9:1」—— 因为它是与输入框底色合成的，底越暗前景就越亮。
   正在输入的正文是 --text-1，两色下都在 13:1 以上（亮色实测 13.76:1，底 232/232/234）。 */
.inbar textarea::placeholder {
  color: color-mix(in srgb, var(--text-1) 64%, transparent);
}

.send {
  position: relative;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-1) 9%, transparent);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 同 .cam：transform 不能不写，否则覆盖掉全局 button 的按压过渡 */
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

/* 有文字或附图时点亮（Kimi 式：灰 → 主色）。主操作不玻璃化 —— 与 Dock 的 .accent、
   页头的主操作钮同一条约定：实底主色才是「点这里」的那一个。 */
.send.ready {
  background: var(--accent);
  color: var(--on-accent);
}

.send:disabled {
  opacity: var(--disabled-opacity);
}

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
