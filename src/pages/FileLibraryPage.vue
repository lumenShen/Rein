<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertCircle,
  Archive,
  ChevronLeft,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Lock,
  MoveRight,
  Paperclip,
  Pencil,
  Pin,
  PackageOpen,
  PinOff,
  Trash2,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import FileExplorer from '@/components/files/FileExplorer.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { kbService, invalidateUsage, usageCached } from '@/services/kbService'
import { isTauri } from '@/services/transport'
import { humanBytes } from '@/utils/format'
import { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'
import {
  KB_SOURCE_LABELS,
  type KbArchiveListing,
  type KbArchiveReport,
  type KbChunk,
  type KbFile,
  type KbHit,
  type KbMedia,
  type KbModal,
  type KbSourceType,
  type KbUsageReport,
} from '@/types'

/** 文件库页（docs/ai-workspace.md §5）：**阅读器 + 文件管理器**两态。
 *
 *  - 浏览交给 `<FileExplorer>`（组件化：虚拟滚动、多选、拖放、回收站、操作队列都在它里面）；
 *  - 本页只剩「打开一个条目之后」的事：完整阅读（note 源直读 kb_files 真源，派生文档按 L2
 *    分块渐进加载）、本体预览（音频/视频/图片）、压缩包解压、编辑/钉住/归类/删除。
 *  - 一切操作 = 一条 kb 命令，不读物理路径、不调用系统文件管理器。 */

const ai = useAiStore()
const toast = useToast()
/** 手机端（与文件管理器同一断点）：那里「最近内容」由底部 dock 的最近文件模式承担 */
const narrowPhone = useMediaQuery('(max-width: 640px)')
/** 「去原页面」用：派生投影只是索引，正文要看真身就得回它自己的页面 */
const router = useRouter()
/** 深链参数（`?dir=` 目录 / `?path=` 文件）：空间总览页的目录行与大文件行带着它们跳进来 */
const route = useRoute()

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 阅读器每次加载的块数（kb_read 上限 64） */
const PAGE_CHUNKS = 24

/** 根目录的「地标」：系统区 → 知识区 → 投影区，顺序即规范里的心智模型（§3.1）。
 *  文件管理器不认识这些名字，由本页作为工作区的领域知识传进去。 */
const NAMESPACES: readonly { name: string; hint: string }[] = [
  { name: '系统提示词', hint: '只读 · 每轮注入' },
  { name: '用户记忆', hint: '长期设定与规范' },
  { name: '未分类数据', hint: '收件箱 · 待归类' },
  { name: '笔记', hint: '手写笔记' },
  { name: '文档', hint: '上传文档全文' },
  { name: '语音', hint: '语音纪要与本音' },
  { name: '视频', hint: '视频与转写' },
  { name: '日程', hint: '待办与安排' },
  { name: '附件', hint: '图片·音频·文件' },
  { name: '对话', hint: '会话转录' },
  { name: '运动', hint: '训练记录' },
  { name: '课程', hint: '训练课程' },
  { name: '饮食', hint: '饮食记录' },
  { name: '体测', hint: '体重身高' },
  { name: '食物', hint: '自建食物' },
  { name: '方案', hint: '健康方案' },
  { name: '菜单', hint: '方案菜单' },
  { name: '记忆', hint: '长期记忆' },
  { name: '规范', hint: '系统规范' },
]

/* ---------- 文件管理器（浏览态） ---------- */

const explorer = ref<{ refresh: () => Promise<void>; navigate: (p: string) => Promise<void>; path: string } | null>(null)
/** 文件管理器当前所在目录（根目录时展示「最近内容」卡片，别的目录不展示） */
const explorerPath = computed(() => explorer.value?.path ?? '')

const recent = ref<KbHit[]>([])
const recentLoaded = ref(false)


/* ---------- 阅读器 ---------- */

interface ReaderState {
  docId: number
  title: string
  path: string | null
  sourceType: KbSourceType
  kind: string
  editable: boolean
  system: boolean
  occurredOn: string | null
  tags: string[]
  summary: string
  /** note 源直读的真源原文（完整）；派生文档为 null 走分块 */
  raw: string | null
  fileId: number | null
  chunks: KbChunk[]
  totalChunks: number
  hasMore: boolean
  chars: number
  loadingMore: boolean
  editing: boolean
  editContent: string
  busy: boolean
  /** 文件节点的归类状态与模态清单 */
  classifyState: string
  pinned: boolean
  modalities: string[]
  /** 当前预览的模态与其内容（本体按需取，不预载） */
  viewing: KbModal | 'text'
  media: KbMedia | null
  mediaBusy: boolean
  moveOpen: boolean
  moveTarget: string
  /** 压缩包清单（打开后才有值）；null = 还没打开或不是压缩包 */
  archive: KbArchiveListing | null
  archiveErr: string
  /** 解压产物与进度的**阅读器级**状态：页面级的会在切换文档时把结果挂错面板 */
  archiveReport: KbArchiveReport | null
  archiveBusy: boolean
  archiveToDir: string
  archiveOnly: string
}

const reader = ref<ReaderState | null>(null)

/** 归类时的常用目标（快速 chips；文件管理器里的「移动到…」用的是同一份清单） */
const MOVE_TARGETS = ['运动', '饮食', '日程', '笔记', '文档', '语音', '视频', '用户记忆', '未分类数据']

/* ---------- 空间占用（只留页头右侧那颗胶囊，明细都在空间总览页） ---------- */

const usage = ref<KbUsageReport | null>(null)

async function loadUsage(force = false): Promise<void> {
  try {
    // 走会话级备忘：report 是全表聚合 + 目录遍历 + 逐本体 stat，
    // 每次进页面都重扫一遍没必要；动了工作区的地方显式 invalidateUsage()。
    // **不传 top**：与空间总览页取的是同一个键，两页共享同一份 report（来回切页零重扫）。
    usage.value = await usageCached(undefined, force)
  } catch {
    /* 胶囊是锦上添花：取不到就整颗不显示，不打扰浏览 */
    usage.value = null
  }
}

function openUsage(): void {
  void router.push({ name: 'ai-files-usage' })
}

/* ---------- 压缩包（zip / tar / gz） ---------- */

// 解压的面板状态全都挂在 `reader` 上（见 ReaderState）：解压是异步的，切了文档再回来
// 写页面级 ref 会把 A 包的报告挂到 B 文档的面板上；busy 也会挡住新文档的按钮。

/** 是不是「可能能打开」的压缩包：按扩展名给出入口，真实格式由后端按魔数判 */
const archiveCandidate = computed(() => /\.(zip|tar|gz|tgz)$/i.test(reader.value?.path ?? ''))

async function openArchive(): Promise<void> {
  const r = reader.value
  if (!r || r.archiveBusy) return
  r.archiveBusy = true
  r.archiveErr = ''
  try {
    r.archive = await kbService.archiveList(r.docId)
  } catch (e) {
    r.archive = null
    r.archiveErr = errMsg(e)
  } finally {
    r.archiveBusy = false
  }
}

async function doExtract(): Promise<void> {
  const r = reader.value
  if (!r || r.archiveBusy) return
  const only = r.archiveOnly
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
  r.archiveBusy = true
  r.archiveErr = ''
  try {
    const rep = await kbService.archiveExtract(
      r.docId,
      r.archiveToDir.trim() || undefined,
      only.length ? only : undefined,
    )
    // 期间可能已经切走：结果只写回它自己那份 reader
    if (reader.value === r) r.archiveReport = rep
    toast.toast(rep.message)
    invalidateUsage()
    await refreshExplorer()
    await loadUsage()
  } catch (e) {
    r.archiveErr = errMsg(e)
    toast.toast(errMsg(e))
  } finally {
    r.archiveBusy = false
  }
}

function kindIcon(kind: string) {
  if (kind === 'folder') return Folder
  if (kind === 'image') return ImageIcon
  if (kind === 'audio') return FileAudio
  if (kind === 'video') return FileVideo
  if (kind === 'file') return Paperclip
  return FileText
}

const sourceLabel = computed(() => {
  const r = reader.value
  if (!r) return ''
  if (r.sourceType !== 'note') return KB_SOURCE_LABELS[r.sourceType] ?? r.sourceType
  // 归档文档 / 系统文件 / 普通笔记同为 note 源，用路径前缀区分展示
  if (r.system) return r.path?.startsWith('系统提示词/') ? '系统提示词' : '规范'
  return r.path?.startsWith('文档/') ? '文档归档' : '笔记'
})

const sizeLabel = computed(() => {
  const r = reader.value
  if (!r) return ''
  return r.raw !== null ? `${r.chars.toLocaleString()} 字` : `共 ${r.totalChunks} 段`
})

const classifyLabel = computed(() => {
  switch (reader.value?.classifyState) {
    case 'inbox':
      return '待归类'
    case 'filed':
      return '已归类'
    case 'manual':
      return '手动放置'
    default:
      return ''
  }
})

/**
 * 正文文本（**首行去重后**）。
 *
 * 后端每个派生文档的正文第一段恒等于它的标题（source.rs 里 `parts = vec![title]`），
 * 而标题已经在卡片顶部大号显示 —— 原样渲染就是「标题 / 标题」两行，
 * 正文区读起来像空的。这里统一取「raw 优先，其次分块拼接」，再剔掉开头等于标题的段。
 *
 * 剔完可能是空串：那说明这条记录真的只有标题（源记录没有备注/子任务/明细），
 * 由模板走 .thin 分支讲清楚，而不是留一片空白让用户以为文件坏了。
 */
const bodyText = computed(() => {
  const r = reader.value
  if (!r) return ''
  const full = r.raw !== null ? r.raw : r.chunks.map((c) => c.text).join('\n')
  const paras = full.split('\n').filter((s) => s.trim().length > 0)
  if (paras.length && paras[0].trim() === r.title.trim()) paras.shift()
  return paras.join('\n').trim()
})

/** 是否还有后续分块可加载（raw 直读的真源没有分页概念） */
const canPageMore = computed(() => reader.value !== null && reader.value.raw === null)

/**
 * 摘要：**与标题相同时不显示**。派生文档的 summary 多数就是标题本身
 * （投影只有标题与结构化字段），原样渲染会在标题下再重复一行同样的字。
 * 只有摘要确实包含额外信息（如笔记的首句）时才值得占一行。
 */
const summaryText = computed(() => {
  const r = reader.value
  if (!r?.summary) return ''
  const s = r.summary.trim()
  return s && s !== r.title.trim() ? s : ''
})

/**
 * 「这条记录本就这么短」的补充说明：把该源类型实际会展开的字段列出来。
 * 目的是让用户明白这不是加载失败 —— 原来只有一片空白，读起来就是「坏了」。
 */
const structuredHint = computed(() => {
  const t = reader.value?.sourceType
  switch (t) {
    case 'todo':
      return '备注、子任务、附件摘要'
    case 'workout':
      return '训练组数、次数、重量、容量、备注'
    case 'meal':
      return '各食物克重与营养'
    case 'plan':
      return '动作、组次与强度'
    case 'body_metric':
      return '各项体测数值'
    case 'voice_memo':
      return '转写与要点'
    default:
      return ''
  }
})

/** 原始内容所在页面（派生投影只是给人看的索引，该去看真身）。
 *  只列**确实有独立页面**的源类型 —— 语音纪要走 voiceRuntime 浮层、没有路由可推，
 *  硬凑一个链接只会点出 404。 */
const ORIGIN: Partial<Record<KbSourceType, { path: string; label: string }>> = {
  todo: { path: '/todos', label: '待办' },
  workout: { path: '/sports/records', label: '运动记录' },
  meal: { path: '/nutrition', label: '营养' },
  body_metric: { path: '/nutrition', label: '营养' },
  food: { path: '/nutrition/foods', label: '食物库' },
  plan: { path: '/sports/plans', label: '课程库' },
  program: { path: '/program', label: '健康方案' },
  chat_message: { path: '/ai', label: 'AI 会话' },
}

const origin = computed(() => (reader.value ? ORIGIN[reader.value.sourceType] : undefined))
const originRoute = computed(() => origin.value?.path ?? null)
const originLabel = computed(() => origin.value?.label ?? '原页面')

/** 模态展示名（chips）。text / 图片 / 音频 / 视频 之外的模态（原始二进制）落到「附件」 */
function modalLabel(m: string): string {
  return m === 'text' ? '文本' : m === 'image' ? '图片' : m === 'audio' ? '音频' : m === 'video' ? '视频' : '附件'
}

/** 打开本体（data URL 预览）。过大时只展示元信息与提示。 */
async function viewModal(modal: KbModal | 'text'): Promise<void> {
  const r = reader.value
  if (!r) return
  r.viewing = modal
  r.mediaBusy = true
  try {
    r.media = await kbService.mediaGet(r.docId, modal)
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.mediaBusy = false
  }
}

/** 本体过大未内联时导出到本地：与文件管理器同一条路（桌面端落盘，浏览器走下载）。 */
async function exportMedia(): Promise<void> {
  const r = reader.value
  if (!r) return
  if (r.fileId === null) {
    toast.toast('该条目没有可导出的文件')
    return
  }
  if (isTauri) {
    try {
      const path = await kbService.exportFile(r.fileId)
      toast.toast(`已导出到 ${path}`)
    } catch (e) {
      toast.toast(errMsg(e))
    }
    return
  }
  // 浏览器：本体（或正文）当文件下载
  try {
    let blob: Blob
    let name = r.title
    const modal = r.modalities.find((m) => m !== 'text')
    if (modal) {
      const media = await kbService.mediaGet(r.docId, modal as KbModal)
      if (!media.dataUrl) throw new Error('文件没有内联数据')
      blob = await (await fetch(media.dataUrl)).blob()
      if (media.mime && !name.includes('.')) name = `${name}.bin`
    } else {
      const d = await kbService.read(r.docId, 'l2', 0, 64)
      blob = new Blob([d.chunks.map((c) => c.text).join('\n')], { type: 'text/markdown' })
      if (!name.includes('.')) name = `${name}.md`
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
    toast.toast(`已下载 ${name}`)
  } catch (e) {
    toast.toast(errMsg(e))
  }
}

function applyFile(r: ReaderState, f: KbFile): void {
  r.raw = f.content
  r.fileId = f.id
  r.chars = f.content.length
  r.system = f.system
  r.editable = !f.system && f.kind !== 'folder'
  r.classifyState = f.classifyState
  r.pinned = f.pinned
  r.modalities = [...new Set(['text', ...f.modalities.map((m) => m.modal)])]
  r.path = f.path
}

async function openDoc(docId: number): Promise<void> {
  try {
    const d = await kbService.read(docId, 'l2', 0, PAGE_CHUNKS)
    const r: ReaderState = {
      docId: d.id,
      title: d.title,
      path: d.path,
      sourceType: d.sourceType,
      kind: d.kind,
      editable: d.editable,
      system: d.system,
      occurredOn: d.occurredOn,
      tags: d.tags,
      summary: d.summary,
      raw: null,
      fileId: null,
      chunks: d.chunks,
      totalChunks: d.totalChunks,
      hasMore: d.hasMore,
      chars: d.chunks.reduce((n, c) => n + c.text.length, 0),
      loadingMore: false,
      editing: false,
      editContent: '',
      busy: false,
      classifyState: 'manual',
      pinned: false,
      modalities: d.modalities,
      viewing: 'text',
      media: null,
      archive: null,
      archiveErr: '',
      archiveReport: null,
      archiveBusy: false,
      archiveToDir: '',
      archiveOnly: '',
      mediaBusy: false,
      moveOpen: false,
      moveTarget: '',
    }
    if (d.sourceType === 'note') {
      // 真源直读：kb_docs.body 是带截断上限的检索缓存，原文才完整
      const f = await kbService.fileGet(d.id)
      applyFile(r, f)
    }
    reader.value = r
    // 多模态节点：默认直接开主模态预览（视频 > 音频 > 图片）
    const primary =
      r.modalities.find((m) => m === 'video') ??
      r.modalities.find((m) => m === 'audio') ??
      r.modalities.find((m) => m === 'image')
    if (primary && r.modalities.length > 1) void viewModal(primary as KbModal)
  } catch (e) {
    toast.toast(errMsg(e))
  }
}

/** 按虚拟路径打开一个文件（空间总览页的大文件榜深链）。
 *
 *  **为什么要多一次 glob**：那边给的是 `kb_files.id`，而这边的阅读器要 `kb_docs.id`
 *  —— 两个 id 空间，直接当 doc id 用会把别的文档读出来。路径是两页都认的键，
 *  这里解析一次；解析不到（文件已被删）就安静地留在列表，不弹错。 */
async function openPath(path: string): Promise<void> {
  try {
    const hits = await kbService.glob(path, 5)
    const hit = hits.find((h) => h.path === path)
    if (hit) await openDoc(hit.id)
  } catch (e) {
    toast.toast(errMsg(e))
  }
}

async function loadMore(): Promise<void> {
  const r = reader.value
  if (!r || !r.hasMore || r.loadingMore || r.busy) return
  r.loadingMore = true
  try {
    const d = await kbService.read(r.docId, 'l2', r.chunks.length, PAGE_CHUNKS)
    r.chunks.push(...d.chunks)
    r.totalChunks = d.totalChunks
    r.hasMore = d.hasMore
    r.chars += d.chunks.reduce((n, c) => n + c.text.length, 0)
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.loadingMore = false
  }
}

/** 一次读完：连续拉取直到末尾（kb_read 单次上限 64 块，循环翻页） */
async function loadAll(): Promise<void> {
  const r = reader.value
  if (!r || r.raw !== null || r.busy) return
  r.busy = true
  try {
    while (r.hasMore) {
      const d = await kbService.read(r.docId, 'l2', r.chunks.length, 64)
      if (!d.chunks.length) break
      r.chunks.push(...d.chunks)
      r.totalChunks = d.totalChunks
      r.hasMore = d.hasMore
      r.chars += d.chunks.reduce((n, c) => n + c.text.length, 0)
    }
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

/* ---------- 编辑 / 删除 / 钉住 / 归类 ---------- */

function startEdit(): void {
  const r = reader.value
  if (!r || r.raw === null) return
  r.editing = true
  r.editContent = r.raw
}

async function saveEdit(): Promise<void> {
  const r = reader.value
  if (!r || r.fileId === null) return
  r.busy = true
  try {
    // fileWrite 按路径幂等覆盖，路径不变即原地更新
    const f = await kbService.fileWrite({ path: r.path ?? '', content: r.editContent })
    applyFile(r, f)
    r.editing = false
    ai.invalidateCognitionCache()
    invalidateUsage()
    toast.toast('已保存')
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

/** 删除 = 移进回收站（与文件管理器同一条路径，可撤销）。
 *  彻底删除是回收站里的第二个动作——「删除」不该是不可逆的。 */
async function removeFile(): Promise<void> {
  const r = reader.value
  if (!r || r.fileId === null) return
  r.busy = true
  try {
    const id = r.fileId
    await kbService.trash(id)
    ai.invalidateCognitionCache()
    invalidateUsage()
    reader.value = null
    await refreshExplorer()
    toast.toast('已移入回收站', {
      action: {
        label: '撤销',
        run: () => {
          void kbService
            .trashRestore([id])
            .then(() => refreshExplorer())
            .catch((e) => toast.toast(errMsg(e)))
        },
      },
    })
  } catch (e) {
    toast.toast(errMsg(e))
    r.busy = false
  }
}

async function togglePin(): Promise<void> {
  const r = reader.value
  if (!r) return
  r.busy = true
  try {
    const f = await kbService.fsPin(r.docId, !r.pinned, 'user')
    r.pinned = f.pinned
    r.classifyState = f.classifyState
    toast.toast(f.pinned ? '已钉住：AI 不会再自动移动它' : '已取消钉住')
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

function openMovePanel(): void {
  const r = reader.value
  if (!r) return
  r.moveOpen = true
  r.moveTarget = ''
}

async function doMove(target?: string): Promise<void> {
  const r = reader.value
  if (!r) return
  const to = (target ?? r.moveTarget).trim()
  if (!to) return
  r.busy = true
  try {
    const res = await kbService.fsMove(r.docId, to, '用户在文件管理器归类', 'user')
    r.path = res.to
    r.classifyState = res.file.classifyState
    r.moveOpen = false
    toast.toast(`已移到 ${res.to}`)
    invalidateUsage()
    await refreshExplorer()
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

/** 让文件管理器重读当前目录（编辑 / 解压 / 移动之后调；
 *  选择与滚动位置由它自己按稳定 id 保留，不用宿主操心） */
async function refreshExplorer(): Promise<void> {
  await explorer.value?.refresh()
}

onMounted(async () => {
  // 深链只消费一次：进来时看 query，页面内的浏览都不再读它
  const q = route.query
  const qdir = typeof q.dir === 'string' ? q.dir : ''
  const qpath = typeof q.path === 'string' ? q.path : ''
  void loadUsage()
  // 子组件的实例要等挂载完才拿得到，深链目录因此晚一拍下发
  if (qdir) void nextTick().then(() => explorer.value?.navigate(qdir))
  if (qpath) void openPath(qpath)
  try {
    // 空查询 = 按日期倒序浏览最近内容
    recent.value = await kbService.search({ query: '', limit: 8 })
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    recentLoaded.value = true
  }
})
</script>

<template>
  <div class="page">
    <PageHeader back title="AI工作区">
      <!-- 空间总览的入口：**只在页头**（曾占页内第一张卡）。只显示总大小 ——
           分类明细在总览页里讲，这一颗的职责就是「一眼看到占了多少」。 -->
      <template #action>
        <button
          v-if="usage"
          class="hdr-btn pill"
          :aria-label="`空间总览 · ${humanBytes(usage.totalBytes)}`"
          @click="openUsage"
        >
          <HardDrive :size="15" />
          {{ humanBytes(usage.totalBytes) }}
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 阅读器 -->
    <section v-if="reader" class="card reader">
      <div class="row rhead">
        <button class="back" aria-label="返回列表" @click="reader = null">
          <ChevronLeft :size="18" />
        </button>
        <div class="col flex-1">
          <h2 class="rtitle">{{ reader.title }}</h2>
          <p v-if="reader.path" class="rpath">{{ reader.path }}</p>
        </div>
        <!-- 分段加载 / 空正文投影 / 解压口径三处说明合并成标题行右侧这一枚入口 -->
        <span class="rhint">
          <InfoHint title="文档说明">
            <p>长文档按段分批读入：读完一段点「继续加载」，全部读完会显示字数与「已到末尾」。</p>
            <p v-if="structuredHint">
              有的记录只是「标题 + 结构化字段」的投影，本身没有长文，上面的标签就是它的全部信息；要改这条记录的{{ structuredHint }}，请回到它自己的页面。
            </p>
            <p v-if="archiveCandidate">解压按文件内容真解压：文本会成为可检索的笔记。</p>
          </InfoHint>
        </span>
      </div>

      <!-- 主状态（待归类 / 已归类）单独一颗强调胶囊；日期与大小降为次要读数，竖线隔开 -->
      <div class="meta row">
        <span class="pill">{{ sourceLabel }}</span>
        <StatusChip v-if="classifyLabel" tone="accent">{{ classifyLabel }}</StatusChip>
        <span v-if="reader.system" class="pill"><Lock :size="11" /> 系统文件</span>
        <span v-if="reader.pinned" class="pill"><Pin :size="11" /> 已钉住</span>
        <span v-if="reader.occurredOn" class="mtext">{{ reader.occurredOn }}</span>
        <span class="mtext">{{ sizeLabel }}</span>
      </div>
      <div v-if="reader.tags.length" class="tags row">
        <span v-for="t in reader.tags" :key="t" class="tag">{{ t }}</span>
      </div>
      <!-- 摘要块：**标题型记录的摘要就等于标题**，再渲染一次又是重复的一行。
           只在摘要确实带来新信息时才显示（与正文首行去重同一条理由）。 -->
      <p v-if="summaryText" class="summary">{{ summaryText }}</p>

      <!-- 模态切换：一个节点可以有多种模态（§2.2） -->
      <div v-if="reader.modalities.length > 1" class="modals row">
        <button
          v-for="m in reader.modalities"
          :key="m"
          class="chip"
          :class="{ cur: reader.viewing === m }"
          @click="viewModal(m as KbModal)"
        >
          {{ modalLabel(m) }}
        </button>
        <span v-if="reader.mediaBusy" class="t-3 chip-busy">读取中…</span>
      </div>

      <!-- 压缩包：打开看内容 / 解压进工作区 -->
      <div v-if="archiveCandidate" class="archive">
        <div class="row actions">
          <button class="btn ghost" :disabled="reader.archiveBusy" @click="openArchive">
            <PackageOpen :size="14" />
            {{ reader.archive ? '重新读取' : '打开压缩包' }}
          </button>
        </div>
        <p v-if="reader.archiveErr" class="err"><AlertCircle :size="13" /> {{ reader.archiveErr }}</p>

        <template v-if="reader.archive">
          <div class="meta row">
            <span class="pill">{{ reader.archive.format }}</span>
            <span class="pill">{{ reader.archive.total }} 项</span>
            <span class="pill">解压后 {{ humanBytes(reader.archive.totalBytes) }}</span>
            <span v-if="reader.archive.packedBytes > 0" class="pill">
              压缩包 {{ humanBytes(reader.archive.packedBytes) }}
            </span>
          </div>
          <p v-for="(n, i) in reader.archive.notes" :key="`${i}-${n}`" class="t-2 hint-inline">{{ n }}</p>

          <ul class="arc-list">
            <li
              v-for="(e, i) in reader.archive.entries.slice(0, 80)"
              :key="`${i}-${e.path}`"
              :class="{ dim: e.isDir }"
            >
              <span class="arc-ic">
                <Folder v-if="e.isDir" :size="13" class="fic dim" />
                <FileText v-else-if="e.text" :size="13" class="fic" />
                <Paperclip v-else :size="13" class="fic dim" />
              </span>
              <span class="arc-path">{{ e.path }}</span>
              <span class="arc-size">{{ e.isDir ? '' : humanBytes(e.size) }}</span>
              <span v-if="e.skipped" class="arc-skip" :title="e.skipped">跳过</span>
            </li>
          </ul>
          <p v-if="reader.archive.total > 80" class="t-3 hint-inline">
            只显示前 80 项（共 {{ reader.archive.total }} 项），解压仍按全部执行。
          </p>

          <div class="arc-extract">
            <label class="arc-field">
              <span>解压到（留空 = 未分类数据/解压/包名）</span>
              <input v-model="reader.archiveToDir" placeholder="笔记/课程资料" aria-label="解压目标目录">
            </label>
            <label class="arc-field">
              <span>只解压路径包含（逗号分隔，留空 = 全部）</span>
              <input v-model="reader.archiveOnly" placeholder="复习, docx" aria-label="只解压匹配项">
            </label>
            <div class="row">
              <button class="btn" :disabled="reader.archiveBusy" @click="doExtract">
                <Archive :size="14" /> {{ reader.archiveBusy ? '处理中…' : '解压到工作区' }}
              </button>
            </div>
          </div>

          <div v-if="reader.archiveReport" class="arc-report">
            <p class="arc-ok">{{ reader.archiveReport.message }}</p>
            <ul>
              <li v-for="f in reader.archiveReport.extracted.slice(0, 12)" :key="f.id">
                <button class="link" @click="openDoc(f.id)">{{ f.path }}</button>
                <span class="t-3">{{ humanBytes(f.bytes) }}</span>
              </li>
            </ul>
            <p
              v-for="(n, i) in reader.archiveReport.skipped.slice(0, 5)"
              :key="`${i}-${n}`"
              class="t-2 hint-inline"
            >
              {{ n }}
            </p>
          </div>
        </template>
      </div>

      <!-- 文本模态 -->
      <template v-if="reader.viewing === 'text'">
        <template v-if="reader.editing">
          <textarea v-model="reader.editContent" rows="16" class="editbox" />
          <div class="row actions">
            <button class="btn" :disabled="reader.busy" @click="saveEdit">保存</button>
            <button class="btn ghost" :disabled="reader.busy" @click="reader.editing = false">取消</button>
          </div>
        </template>
        <template v-else>
          <!-- 正文（已剔掉与标题重复的首段）。空 = 这条记录真的只有标题，
               走下面的 .thin 说明，而不是留白。 -->
          <div v-if="bodyText" class="doc">{{ bodyText }}</div>
          <div v-else class="thin">
            <p class="thin-t">这条记录没有更多正文</p>
            <button v-if="originRoute" class="btn" @click="router.push(originRoute)">
              去{{ originLabel }}
            </button>
          </div>

          <!-- 分页读取：只有走分块（非 note 真源直读）的文档才有"下一页" -->
          <div v-if="canPageMore && reader.hasMore" class="row more-row">
            <button class="btn ghost" :disabled="reader.loadingMore || reader.busy" @click="loadMore">
              {{ reader.loadingMore ? '加载中…' : `继续加载（${reader.chunks.length}/${reader.totalChunks} 段）` }}
            </button>
            <button class="btn ghost" :disabled="reader.busy" @click="loadAll">一次读完</button>
          </div>
          <!-- 读到底：状态词交给胶囊，字数升为主数值（--fs-title3 + .num） -->
          <div v-else-if="canPageMore && bodyText && reader.totalChunks > 1" class="finrow row">
            <StatusChip tone="ok">已到末尾</StatusChip>
            <span class="finnum num">约 {{ reader.chars.toLocaleString() }} 字</span>
          </div>
        </template>
      </template>

      <!-- 非文本模态（图片 / 音频 / 视频 / 二进制附件） -->
      <template v-else>
        <p v-if="reader.media?.degraded" class="degrade">
          已降级为文本：{{ reader.media.degradeReason }}
        </p>
        <img
          v-if="reader.viewing === 'image' && reader.media?.dataUrl"
          class="preview-img"
          :src="reader.media.dataUrl"
          :alt="reader.title"
        >
        <audio
          v-else-if="reader.viewing === 'audio' && reader.media?.dataUrl"
          class="preview-audio"
          controls
          :src="reader.media.dataUrl"
        />
        <video
          v-else-if="reader.viewing === 'video' && reader.media?.dataUrl"
          class="preview-video"
          controls
          :src="reader.media.dataUrl"
        />
        <!-- 未内联时给出真实的导出入口（与文件管理器的「导出到本地」同一条路） -->
        <div v-if="reader.media?.tooLarge" class="row toobig">
          <span class="t-3">文件较大，未在页面内联</span>
          <button class="btn ghost" @click="exportMedia">导出到本地</button>
        </div>
        <p v-if="reader.media?.hint" class="t-3 fin">{{ reader.media.hint }}</p>
        <blockquote v-if="reader.media && !reader.media.dataUrl && !reader.media.tooLarge" class="doc fallback">
          {{ reader.media.text ?? '（该模态没有可展示的内容）' }}
        </blockquote>
      </template>

      <!-- 归类面板 -->
      <div v-if="reader.moveOpen" class="movebox">
        <div class="row moveq">
          <input v-model="reader.moveTarget" placeholder="目标目录，如「运动/知识」" aria-label="目标目录">
          <button class="btn" :disabled="reader.busy" @click="doMove()">移动</button>
        </div>
        <div class="row chips">
          <button v-for="t in MOVE_TARGETS" :key="t" class="chip" @click="doMove(t)">{{ t }}</button>
        </div>
      </div>

      <div class="row actions">
        <button
          v-if="reader.raw !== null && reader.editable && !reader.editing"
          class="btn ghost"
          :disabled="reader.busy"
          @click="startEdit"
        >
          <Pencil :size="14" /> 编辑
        </button>
        <button v-if="!reader.system" class="btn ghost" :disabled="reader.busy" @click="togglePin">
          <component :is="reader.pinned ? PinOff : Pin" :size="14" />
          {{ reader.pinned ? '取消钉住' : '钉住' }}
        </button>
        <button
          v-if="!reader.system"
          class="btn ghost"
          :disabled="reader.busy"
          @click="reader.moveOpen ? (reader.moveOpen = false) : openMovePanel()"
        >
          <MoveRight :size="14" /> 归类
        </button>
        <button
          v-if="reader.fileId !== null && !reader.system"
          class="btn ghost danger"
          :disabled="reader.busy"
          @click="removeFile"
        >
          <Trash2 :size="14" /> 删除
        </button>
      </div>
    </section>

    <!-- 浏览：文件管理器（虚拟滚动 / 多选 / 拖放 / 回收站 / 操作队列都在组件里） -->
    <template v-else>
      <FileExplorer ref="explorer" :landmarks="NAMESPACES" @open="(it) => it.docId && openDoc(it.docId)" />

      <!-- 最近内容：跨工作区的「最近动过」，列不出来（它跨目录），所以单列一张卡。
           手机端不展示：那里由文件管理器底部 dock 的「最近文件」模式承担，
           主内容区只留面包屑 + 功能 + 当前目录。 -->
      <section v-if="!narrowPhone && recent.length && !explorerPath" class="card list list-recent">
        <h3 class="sec">最近内容</h3>
        <ul>
          <li v-for="h in recent" :key="`${h.sourceType}-${h.id}`">
            <button class="row item" @click="openDoc(h.id)">
              <component :is="kindIcon(h.kind)" :size="15" class="fic" :class="{ dim: h.system }" />
              <span class="flex-1">
                <b>{{ h.title }}</b>
                <small>{{ h.path ?? KB_SOURCE_LABELS[h.sourceType] ?? h.sourceType }}</small>
              </span>
              <span class="t-3 date">{{ h.occurredOn ?? '' }}</span>
            </button>
          </li>
        </ul>
      </section>
    </template>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开，
     这里只剩页头与内容之间那一档呼吸 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}








/* 列表卡片：行式布局，压掉全局卡片的大内边距 */
/* 列表卡片：行式布局，压掉全局卡片的大内边距（左右仍与页边距同档 16） */
.card.list {
  margin-top: var(--gap-md);
  padding: var(--sp-6) var(--pad-card);
}

.sec {
  padding: var(--sp-12) 0 var(--sp-4);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.item {
  width: 100%;
  text-align: left;
  gap: var(--gap-md);
  min-height: var(--row-h-double);
  padding: 0;
}

.item + .item,
li + li .item {
  border-top: 0.5px solid var(--line);
}

.item b {
  display: block;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item small {
  color: var(--text-2);
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.fic {
  flex: none;
  color: var(--accent);
}

.fic.dim {
  color: var(--text-2);
}

.date {
  flex: none;
  font-size: var(--fs-caption);
}




.rhead {
  gap: var(--sp-8);
}

/* 标题行右侧的帮助入口：InfoHint 是多根组件，类要落在包裹元素上 */
.rhint {
  margin-left: auto;
  flex: none;
}

.back {
  position: relative;
  flex: none;
  padding: var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

/* 阅读器左上角「返回列表」：18px 图标 + 6px 内距只有 30，命中区撑到 44。
   横向上扩 7px —— 右边是标题（flex 1），外扩不会碰到别的钮。 */
.back::after {
  content: '';
  position: absolute;
  inset: -7px;
}

.rtitle {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: var(--lh-title);
}

.rpath {
  margin-top: var(--gap-text);
  font-family: ui-monospace, monospace;
  font-size: var(--fs-caption);
  color: var(--text-2);
  word-break: break-all;
}

.meta {
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  flex-wrap: wrap;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
}

/* 日期与大小是次要读数：不进胶囊，降一档字色，两项之间竖线隔开 */
.mtext {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mtext + .mtext {
  padding-left: var(--sp-12);
  border-left: 0.5px solid var(--line);
}

.tags {
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  flex-wrap: wrap;
}

.tag {
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  border: 1px solid var(--line);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.summary {
  margin-top: var(--gap-md);
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-2);
}

/* 行内提示：字号降一档，字色由 t-2 / t-3 决定（解压跳过原因与档案 notes 走 t-2，
   80 项截断脚注保持 t-3） */
.hint-inline {
  font-size: var(--fs-caption);
}

/* 压缩包面板 */
.archive {
  display: grid;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}
.arc-list {
  display: grid;
  gap: var(--gap-tight);
  max-height: 260px;
  overflow-y: auto;
  list-style: none;
  font-size: var(--fs-caption);
}
.arc-list li {
  display: grid;
  grid-template-columns: 18px 1fr auto auto;
  gap: var(--gap-sm);
  align-items: center;
  color: var(--text-1);
}
.arc-list li.dim {
  color: var(--text-2);
}
.arc-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: var(--fs-caption);
}
.arc-size {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.arc-skip {
  color: var(--danger-strong);
  font-size: var(--fs-caption);
}
.arc-extract {
  display: grid;
  gap: var(--gap-sm);
  padding-top: var(--gap-sm);
  border-top: 1px dashed var(--line);
}
.arc-field {
  display: grid;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.arc-field input {
  /* 表单输入走常规控件档 40（--control-md），与页面里的其它输入框同高 */
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text-1);
  font-size: var(--fs-subhead);
}
.arc-report {
  display: grid;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
}
.arc-ok {
  color: var(--accent);
}
.arc-report ul {
  display: grid;
  gap: var(--sp-4);
  list-style: none;
}
.arc-report li {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-8);
}

.modals {
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  flex-wrap: wrap;
}

.chip,
.chip-busy {
  min-height: var(--chip-h);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.chip:active {
  transform: scale(0.96);
}

.chip.cur {
  background: var(--accent-soft);
  /* 选中态文字走 --accent-strong：soft 底上的实底档主色不够读 */
  color: var(--accent-strong);
  font-weight: var(--fw-semibold);
}

.chips {
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  flex-wrap: wrap;
}

/* 模态预览 */
.preview-img,
.preview-video {
  width: 100%;
  margin-top: var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.preview-audio {
  width: 100%;
  margin-top: var(--sp-12);
}

.degrade {
  margin-top: var(--gap-md);
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--accent-soft);
  /* accent-soft 底上的文字走 --accent-strong（实底档 --accent 在该底上不足 4.5:1） */
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.doc {
  margin-top: var(--gap-md);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}

.doc p + p {
  margin-top: var(--sp-8);
}

/* 「这条记录没有更多正文」：派生文档只带标题与结构化字段，而那些字段已经在
   上面的 pills 里说过了 —— 正文区于是常常是空的。原先直接留白，用户读到的是
   「文件坏了」；现在卡面只留结论 + 回真身的按钮，完整原因在标题行右侧的
   帮助入口里（投影口径一次说清）。 */
.thin {
  margin-top: var(--gap-md);
  padding: var(--sp-16);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  text-align: center;
}

.thin-t {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.thin .btn {
  margin-top: var(--sp-12);
}

/* 兜底正文块：强调改走整面 soft tint（中性色的对应档就是 --surface-2），
   不再靠左边框（side-tab 收编） */
.fallback {
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  color: var(--text-2);
}

.more-row {
  gap: var(--sp-8);
  margin-top: var(--sp-12);
}

.more-row .btn {
  flex: 1;
}

/* 读到底：状态词与字数各占其位，字数是这一行的主数值 */
.finrow {
  gap: var(--sp-8);
  margin-top: var(--sp-12);
  justify-content: center;
}

.finnum {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 文件过大：提示 + 真实导出入口同行 */
.toobig {
  gap: var(--sp-8);
  margin-top: var(--sp-12);
  flex-wrap: wrap;
  font-size: var(--fs-caption);
}

.fin {
  margin-top: var(--sp-10);
  text-align: center;
  font-size: var(--fs-caption);
}

/* 归类面板 */
.movebox {
  margin-top: var(--gap-md);
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}

.moveq {
  gap: var(--sp-8);
}

.moveq input {
  flex: 1;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-1);
  font-size: var(--fs-subhead);
}

.editbox {
  width: 100%;
  margin-top: var(--gap-md);
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  line-height: 1.6;
  font-family: ui-monospace, monospace;
  resize: vertical;
}

.actions {
  gap: var(--sp-8);
  margin-top: var(--sp-12);
  flex-wrap: wrap;
}

/* 阅读器动作按钮：走常规按钮档 40（--control-md），左右 16，胶囊。
   此前是 28 的小按钮档 —— 这些是「保存 / 编辑 / 钉住 / 归类 / 删除」这类主操作，
   又不是行尾小胶囊；40 同时把命中区直接做够 44 的触控底线（不再靠伪元素外扩，
   窄屏上动作行会换行，外扩会与下一行叠在一起）。 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.btn.ghost {
  background: var(--surface-2);
  color: var(--text-1);
}

/* surface-2 上的危险动作文字：实底档 --danger 对比度不够，走文字档 */
.btn.ghost.danger {
  color: var(--danger-strong);
}

.btn:disabled {
  opacity: var(--disabled-opacity);
}

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   这页是 wide 路由：主人区整宽自负 —— 浏览宽度由文件管理器组件自己负责
   （它在宽容器里自动切表格式多列），页面这边只剩「最近内容」卡与阅读卡。
   ============================================================ */

/* 宽形态页面的内容上限，超过就不再拉长行 */
.desk-main .page {
  max-width: var(--desk-wide);
}

/* 列表卡内部多栏流：「最近内容」的条目高度参差，
   用 columns 而不是 grid —— grid 会把同行撑到最高的那条，留下锯齿状空白。 */
.desk-main .card.list > ul {
  columns: var(--b-cols, 2);
  column-gap: var(--desk-gap);
}

.desk-main .card.list > ul > li {
  break-inside: avoid;
}

/* 阅读器：正文一行 80+ 字就没人读得下去。这页没有侧栏可放元信息，
   所以把阅读卡收成一张居中的定宽卡（≈ 820px，约 55 字/行），
   两侧留白是对称的——看上去是「一张阅读卡」，不是「右边空着」。 */
.desk-main .rubber-layer > .card.reader {
  max-width: 820px;
  margin-inline: auto;
}
</style>
