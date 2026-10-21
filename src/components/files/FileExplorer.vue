<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCheck,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Columns3,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Images,
  Info,
  Layers,
  LayoutGrid,
  Link2,
  List,
  MoreHorizontal,
  MoveRight,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Scissors,
  Search,
  FileArchive,
  Trash2,
  TriangleAlert,
  Upload,
  Wand2,
  X,
} from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { useToast } from '@/composables/useToast'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { kbService } from '@/services/kbService'
import { isTauri } from '@/services/transport'
import { cachedThumbAny } from '@/files/thumbs'
import { humanBytes } from '@/utils/format'

import FileRow from './FileRow.vue'
import FileTile from './FileTile.vue'
import OpQueueBar from './OpQueueBar.vue'
import BatchRenamePanel from './BatchRenamePanel.vue'
import MetaEditor from './MetaEditor.vue'
import ColumnView from './ColumnView.vue'
import ConflictPrompt from './ConflictPrompt.vue'
import FolderTree from './FolderTree.vue'
import { readSystemClipboard, useFileClipboard, writeSystemClipboard } from '@/files/clipboard'
import { useMarquee } from '@/files/marquee'
import { useOpQueue } from '@/files/opQueue'
import { kbProvider, parentOf } from '@/files/provider'
import {
  allColumns,
  menuContributions,
  preferredPreview,
  propertyRows,
  visibleColumns,
} from '@/files/registry'
import { useSelection } from '@/files/selection'
import {
  filterByTags,
  filterItems,
  formatFullWhen,
  groupItems,
  kindLabel,
  sortItems,
  tagCloud,
  withDisplayName,
} from '@/files/sort'
import type {
  ClipMode,
  ConflictPolicy,
  DirListing,
  ExplorerPrefs,
  FileItem,
  GroupKey,
  IconSize,
  SortKey,
  ViewMode,
} from '@/files/types'
import { useVirtualRows, type VRow } from '@/files/virtualRows'
import { KB_SOURCE_LABELS, type KbArchiveListing, type KbHit, type KbSourceType } from '@/types'

/**
 * 文件资源管理器（工作区视图）。
 *
 * 三层分工，改哪一层都不会牵动另两层：
 * - **领域层**（`src/files/*`）：provider（原子操作 + 能力声明）、选择模型、操作队列、
 *   剪贴板、缩略图、虚拟行；
 * - **本组件**：只做编排（导航、快捷键、拖放、菜单、进度、状态栏）；
 * - **宿主**：只有一件事 —— `open` 事件把条目交给阅读器。
 *
 * 三条关键约定：
 * 1. 列表数据只来自 `provider.listDir(path)` 的**一层**结果，过滤/排序/分组都在前端做：
 *    切排序、敲过滤、换视图都不再打 IPC；
 * 2. 写操作一律走操作队列（进度 / 取消 / 逐条失败），完成刷新后按稳定 id 保留选择；
 * 3. 「能不能做」只问 `provider.capability()`，菜单只负责把原因显示出来。
 */
const props = withDefaults(
  defineProps<{
    /** 根目录的「地标」：命名空间 + 一句说明（页面提供；工作区之外不知道这些心智模型） */
    landmarks?: readonly { name: string; hint: string }[]
    initialPath?: string
  }>(),
  { landmarks: () => [], initialPath: '' },
)

const emit = defineEmits<{ open: [item: FileItem] }>()

const toast = useToast()
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/* ---------- 偏好（排序 / 分组 / 视图；跨会话记住） ---------- */

const PREFS_KEY = 'rein.files.prefs.v1'
const DEFAULTS: ExplorerPrefs = {
  sortKey: 'name',
  sortDir: 'asc',
  groupKey: 'none',
  viewMode: 'list',
  iconSize: 'md',
  showHidden: false,
  // 默认**显示**扩展名：工作区里 .md / .wav / .zip 的区别是有意义的
  hideExtension: false,
  foldersFirst: true,
  columns: undefined,
  showTree: false,
}

function loadPrefs(): ExplorerPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ExplorerPrefs>) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

const prefs = ref<ExplorerPrefs>(loadPrefs())
watch(
  prefs,
  () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value))
    } catch {
      /* 隐私模式下写不进去：只是不记忆，不影响使用 */
    }
  },
  { deep: true },
)

/* ---------- 导航状态 ---------- */

const provider = kbProvider
const path = ref(props.initialPath)
const listing = ref<DirListing | null>(null)
const loading = ref(false)
const errText = ref('')
const trashMode = ref(false)
const trashItems = ref<FileItem[]>([])
const trashCount = ref(0)
const keyword = ref('')
/** 标签筛选（多选 = 都要满足） */
const activeTags = ref<string[]>([])

/* ---------- 形态：窄屏（手机）走另一套工具条与底部 dock ---------- */

/** 手机端布局（工具条只留下搜索/添加/更多，底部出 dock）。宽屏维持桌面工作台那套。 */
const narrow = useMediaQuery('(max-width: 640px)')

/* ---------- 虚拟文件系统导航：最近文件 / 目录文件两种模式 ---------- */

type NavMode = 'recent' | 'dir'

const navMode = ref<NavMode>('dir')
const recentItems = ref<FileItem[]>([])
const recentLoading = ref(false)
const recentLoaded = ref(false)

/** KbHit → FileItem：最近模式要跟目录模式用同一个行组件（对齐、手势、勾选框都一样） */
function hitToItem(h: KbHit): FileItem {
  const name = h.path ? (h.path.split('/').pop() ?? h.title) : h.title
  const cut = name.lastIndexOf('.')
  return {
    id: `kb:${h.path ?? `#${h.id}`}`,
    uri: `kb://${h.path ?? ''}`,
    name,
    displayName: name,
    sortName: name.toLowerCase(),
    extension: cut > 0 ? name.slice(cut + 1).toLowerCase() : undefined,
    kind: h.kind === 'folder' ? 'folder' : h.kind,
    isDir: h.kind === 'folder',
    // 最近模式的列表不带体积与 mtime：只有业务日期，把它当时间列显示
    modifiedAt: h.occurredOn ? Date.parse(`${h.occurredOn}T00:00:00Z`) : undefined,
    attributes: { hidden: false, readOnly: !h.editable, system: h.system },
    permissions: {
      canRead: true,
      canWrite: h.editable && !h.system,
      canDelete: h.editable && !h.system,
      canRename: h.editable && !h.system,
    },
    childCount: 0,
    rating: 0,
    tags: h.tags ?? [],
    hasNote: false,
    pinned: false,
    classifyState: '',
    modalities: [],
    cloudState: 'local',
    providerId: 'kb',
    docId: h.id,
    sourceType: h.sourceType,
    title: h.title,
  }
}

/** 最近文件：跨目录的「最近动过」，列不出来（它跨目录），所以单独一种模式 */
async function loadRecent(): Promise<void> {
  if (recentLoading.value) return
  recentLoading.value = true
  try {
    // 空查询 = 按日期倒序浏览最近内容（与后端约定的默认口径）
    const hits = await kbService.search({ query: '', limit: 60 })
    recentItems.value = hits.map(hitToItem)
    recentLoaded.value = true
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    recentLoading.value = false
  }
}

async function setNavMode(mode: NavMode): Promise<void> {
  if (mode === navMode.value) return
  navMode.value = mode
  sel.clear()
  selectMode.value = false
  keyword.value = ''
  activeTags.value = []
  details.value = null
  if (mode === 'recent' && !recentLoaded.value) await loadRecent()
  await nextTick()
  vlist.reset()
}

/* ---------- 多选态（长按菜单进来；勾选框直接画在 item 上） ---------- */

const selectMode = ref(false)

function enterSelectMode(item?: FileItem): void {
  selectMode.value = true
  if (item) sel.selectOnly(item)
}

function exitSelectMode(): void {
  selectMode.value = false
  sel.clear()
}

/** 全选 / 全不选：按当前可见条目算（过滤后的那份，不是整个目录） */
const allSelected = computed(() => {
  const list = ordered.value
  return list.length > 0 && list.every((i) => sel.has(i.id))
})

function toggleSelectAll(): void {
  if (allSelected.value) sel.clear()
  else sel.selectAll(ordered.value)
}

/**
 * 底部功能栏的按钮能不能点：与菜单同一把尺子（provider.capability）。
 * 最近模式里的条目大多没有文件实体（搜索结果只带 doc id），复制/剪切/删除会失败 ——
 * 宁可信 greyed out，也不要「点了才报错」。原因在「更多」菜单里逐项写着。
 */
const dockCan = computed(() => {
  const list = selectedItems.value
  if (!list.length) return { copy: false, cut: false, del: false }
  return {
    copy: list.every((i) => provider.capability(i, 'copy').ok),
    cut: list.every((i) => provider.capability(i, 'move').ok),
    del: list.every((i) => provider.capability(i, 'delete').ok),
  }
})

/* ---------- 新建文件 / 新建目录（手机端「添加」菜单的两个落点） ---------- */

const newOpen = ref<'file' | 'folder' | null>(null)
const newName = ref('')

function startNew(kind: 'file' | 'folder'): void {
  newOpen.value = kind
  // 新建文件预填一个带扩展名的名字：空内容文件没有扩展名就「打不开」
  newName.value = kind === 'file' ? '未命名.md' : ''
}

async function createNew(): Promise<void> {
  const kind = newOpen.value
  const name = newName.value.trim()
  if (!kind || !name) return
  if (kind === 'folder') {
    const target = path.value ? `${path.value}/${name}` : name
    await queue.run('mkdir', `新建目录 ${name}`, 1, async (ctx) => {
      try {
        await provider.mkdir(target)
        ctx.step()
      } catch (e) {
        ctx.fail(errMsg(e))
      }
    })
  } else {
    const target = path.value ? `${path.value}/${name}` : name
    await queue.run('mkdir', `新建文件 ${name}`, 1, async (ctx) => {
      try {
        // 知识库不接受空文件（Rust 与 mock 同判「文件内容不能为空」）：
        // 给一行标题当种子，用户接着写即可
        await kbService.fileWrite({ path: target, content: `# ${name}\n` })
        ctx.step()
      } catch (e) {
        ctx.fail(errMsg(e))
      }
    })
  }
  newOpen.value = null
  newName.value = ''
  await refresh()
  // 新建的文件直接进就地改名：名字本来就是占位的，顺手改成想要的
  if (kind === 'file') {
    const id = `kb:${path.value ? `${path.value}/${name}` : name}`
    if (ordered.value.some((i) => i.id === id)) editingId.value = id
  }
}

/* ---------- 压缩包内浏览（进 zip 看条目、选择性解压；压缩包不是目录，单独一层状态） ---------- */

interface ArchiveState {
  docId: number
  /** 压缩包文件名 */
  name: string
  /** 压缩包所在的目录（返回时回到这里） */
  dir: string
  /** 包内当前路径（'' = 根） */
  inner: string
  listing: KbArchiveListing
}

const archive = ref<ArchiveState | null>(null)
const archiveBusy = ref(false)
/** 包内面包屑（当前内层路径的逐级切分） */
const archiveCrumbs = computed(() => (archive.value?.inner ? archive.value.inner.split('/') : []))
/** 选中条目对应的包内路径（解压「只要这些」用） */
const selectionPaths = computed(() =>
  selectedItems.value
    .filter((i) => i.providerId === 'zip' && !i.isDir)
    .map((i) => i.uri.replace(/^zip:\/\/\d+\//, '')),
)
/** 解压目标目录（留空 = 后端默认 未分类数据/解压/包名） */
const extractTo = ref('')
const globalHits = ref<FileItem[] | null>(null)
const globalKeyword = ref('')
const searching = ref(false)
const editingId = ref<string | null>(null)
const details = ref<FileItem | null>(null)
const batchOpen = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
/** 拖拽中的条目（内部拖放；从系统拖入文件不在本期范围） */
const dragItems = ref<FileItem[]>([])
const dropTarget = ref<string | null>(null)
const hostWidth = ref(0)

const history = ref<string[]>([''])
const histIdx = ref(0)
const canBack = computed(() => histIdx.value > 0)
const canForward = computed(() => histIdx.value < history.value.length - 1)
const crumbs = computed(() => (path.value ? path.value.split('/') : []))

/* ---------- 选择 / 剪贴板 / 队列 ---------- */

const sel = useSelection()
const clip = useFileClipboard()
const queue = useOpQueue()
const marquee = useMarquee()

/* ---------- 冲突策略（粘贴 / 导入时问一次，可记住） ---------- */

/** 本会话记住的策略（null = 每次都问） */
const conflictPolicy = ref<ConflictPolicy | null>(null)
interface PendingConflict {
  label: string
  names: string[]
  total: number
  /** 用户做出选择后要跑的那件事 */
  run: (policy: ConflictPolicy) => void
}
const pendingConflict = ref<PendingConflict | null>(null)

/** 冲突里该用哪个名字：保留两者就往后找 -v2、-v3…（与后端让位规则同名同形） */
function keepBothName(name: string, taken: Set<string>): string {
  const cut = name.lastIndexOf('.')
  const stem = cut > 0 ? name.slice(0, cut) : name
  const ext = cut > 0 ? name.slice(cut) : ''
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-v${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/** 目标目录里已有的名字（冲突检查） */
async function takenNames(dir: string): Promise<Set<string>> {
  try {
    const l = await provider.listDir(dir)
    return new Set(l.items.map((i) => i.name))
  } catch {
    return new Set()
  }
}

/**
 * 统一入口：先算冲突，有冲突且没记住策略就问一次，然后把策略交给 run。
 * 三种策略的落点在执行处（见 doPaste / importFiles）——这里只管「问不问」。
 */
async function withConflictPolicy(
  label: string,
  incoming: string[],
  targetDir: string,
  run: (policy: ConflictPolicy) => void,
): Promise<void> {
  const taken = await takenNames(targetDir)
  const names = incoming.filter((n) => taken.has(n))
  if (!names.length) {
    run('keepBoth')
    return
  }
  if (conflictPolicy.value) {
    run(conflictPolicy.value)
    return
  }
  pendingConflict.value = { label, names, total: incoming.length, run }
}

/* ---------- 数据 → 行 ---------- */

/** 根目录的目录由「地标」卡片承担，列表里就不再重复列一遍 */
const atRoot = computed(() => !path.value && !trashMode.value && !globalHits.value && navMode.value === 'dir')

const sourceItems = computed<FileItem[]>(() => {
  if (archive.value) return archiveRows.value
  // 最近模式：跨目录的最近内容，一层目录概念不适用
  if (navMode.value === 'recent') return recentItems.value
  const base = trashMode.value
    ? trashItems.value
    : globalHits.value
      ? globalHits.value
      : atRoot.value
        ? (listing.value?.items ?? []).filter((i) => !i.isDir)
        : (listing.value?.items ?? [])
  // 显示名按用户偏好改写（数据层只给真名，不替用户决定要不要看扩展名）
  const hide = prefs.value.hideExtension
  return hide ? base.map((i) => withDisplayName(i, true)) : base
})

/** 隐藏项默认不显示；「显示隐藏文件」是一个开关，不是一个藏在菜单深处的彩蛋 */
/** 画廊模式只看图片/视频（它的用途就是扫素材；其它条目在列表/网格里看） */
const galleryFiltered = computed(() => {
  if (prefs.value.viewMode !== 'gallery') return { items: null as FileItem[] | null, hidden: 0 }
  const all = sourceItems.value
  const keep = all.filter((i) => i.isDir || i.kind === 'image' || i.kind === 'video')
  return { items: keep, hidden: all.length - keep.length }
})

const visibleItems = computed(() => {
  const src = galleryFiltered.value.items ?? sourceItems.value
  const base = prefs.value.showHidden ? src : src.filter((i) => !i.attributes.hidden)
  return filterByTags(filterItems(base, keyword.value), activeTags.value)
})

/**
 * 压缩包内的一层条目 → FileItem。
 * 身份用 `zip:{docId}:{包内路径}`（稳定、唯一），**没有 docId**：包内条目还没进工作区，
 * 要读就得先解压 —— 菜单因此只给「解压」这一条真正的动作。
 */
const archiveRows = computed<FileItem[]>(() => {
  const a: ArchiveState | null = archive.value
  if (!a) return []
  const prefix = a.inner
  const dirSeen = new Map<string, number>()
  const files: FileItem[] = []
  for (const e of a.listing.entries) {
    if (prefix && !e.path.startsWith(`${prefix}/`)) continue
    const rel = prefix ? e.path.slice(prefix.length + 1) : e.path
    if (!rel) continue
    const slash = rel.indexOf('/')
    if (slash >= 0) {
      const name = rel.slice(0, slash)
      dirSeen.set(name, (dirSeen.get(name) ?? 0) + 1)
      continue
    }
    if (e.isDir) {
      if (!dirSeen.has(rel)) dirSeen.set(rel, 0)
      continue
    }
    const items = e.path.split('/')
    const name = items[items.length - 1]
    const cut = name.lastIndexOf('.')
    files.push({
      id: `zip:${a.docId}:${e.path}`,
      uri: `zip://${a.docId}/${e.path}`,
      name,
      displayName: prefs.value.hideExtension && cut > 0 ? name.slice(0, cut) : name,
      sortName: name.toLowerCase(),
      extension: cut > 0 ? name.slice(cut + 1).toLowerCase() : undefined,
      kind: e.text ? 'text' : 'file',
      isDir: false,
      size: e.size,
      modifiedAt: undefined,
      attributes: { hidden: false, readOnly: true, system: false },
      permissions: { canRead: true, canWrite: false, canDelete: false, canRename: false },
      childCount: 0,
      rating: 0,
      tags: [],
      hasNote: false,
      pinned: false,
      classifyState: '',
      modalities: [],
      readOnlyReason: '压缩包里的条目：先解压才能读写',
      cloudState: 'local',
      providerId: 'zip',
      title: name,
    })
  }
  for (const [name, count] of dirSeen) {
    files.push({
      id: `zip:${a.docId}:${prefix ? `${prefix}/${name}` : name}/`,
      uri: `zip://${a.docId}/${prefix ? `${prefix}/${name}` : name}`,
      name,
      displayName: name,
      sortName: name.toLowerCase(),
      kind: 'folder',
      isDir: true,
      modifiedAt: undefined,
      attributes: { hidden: false, readOnly: true, system: false },
      permissions: { canRead: true, canWrite: false, canDelete: false, canRename: false },
      childCount: count,
      rating: 0,
      tags: [],
      hasNote: false,
      pinned: false,
      classifyState: '',
      modalities: [],
      readOnlyReason: '压缩包里的目录',
      cloudState: 'local',
      providerId: 'zip',
      title: name,
    })
  }
  return files
})

/** 导出到本地：桌面端落到「下载/Rein」，浏览器直接触发下载 */
async function exportToLocal(item: FileItem): Promise<void> {
  const fid = item.fileId ?? item.docId
  if (fid === undefined) {
    toast.toast('该条目没有可导出的本体')
    return
  }
  if (isTauri) {
    try {
      const path = await kbService.exportFile(fid)
      toast.toast(`已导出到 ${path}`)
    } catch (e) {
      toast.toast(errMsg(e))
    }
    return
  }
  // 浏览器：把本体（或正文）当文件下载
  try {
    let blob: Blob
    let name = item.name
    const modal = item.modalities.find((m) => m !== 'text')
    if (modal && item.docId !== undefined) {
      const media = await kbService.mediaGet(item.docId, modal)
      if (!media.dataUrl) throw new Error('本体没有内联数据')
      blob = await (await fetch(media.dataUrl)).blob()
      if (media.mime && !name.includes('.')) name = `${name}.bin`
    } else if (item.docId !== undefined) {
      const d = await kbService.read(item.docId, 'l2', 0, 64)
      blob = new Blob([d.chunks.map((c) => c.text).join('\n')], { type: 'text/markdown' })
    } else {
      throw new Error('该条目没有可导出的内容')
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

/** 打开压缩包：列出条目，进入「包内浏览」层 */
async function openArchive(item: FileItem): Promise<void> {
  if (item.docId === undefined || archiveBusy.value) return
  archiveBusy.value = true
  try {
    const listing = await kbService.archiveList(item.docId)
    archive.value = {
      docId: item.docId,
      name: item.name,
      dir: parentOf(dirPathOf(item)),
      inner: '',
      listing,
    }
    sel.clear()
    keyword.value = ''
    activeTags.value = []
    await nextTick()
    vlist.reset()
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    archiveBusy.value = false
  }
}

/** 进入 / 退出包内目录（'' = 包根） */
function archiveGo(inner: string): void {
  const a = archive.value
  if (!a) return
  a.inner = inner
  sel.clear()
  void nextTick().then(() => vlist.reset())
}

function closeArchive(): void {
  const dir = archive.value?.dir ?? ''
  archive.value = null
  sel.clear()
  void nextTick().then(() => {
    void navigate(dir)
  })
}

/** 解压：`only` 为空 = 全部；否则只解压包内路径匹配的条目 */
async function extractArchive(only?: string[]): Promise<void> {
  const a = archive.value
  if (!a || archiveBusy.value) return
  archiveBusy.value = true
  try {
    const rep = await kbService.archiveExtract(a.docId, extractTo.value.trim() || undefined, only)
    toast.toast(rep.message)
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    archiveBusy.value = false
  }
}

/** 当前一层里出现过的标签（筛选条只在有标签时出现，不占没标签的人的版面） */
const tagOptions = computed(() => tagCloud(sourceItems.value))

function toggleTag(tag: string): void {
  activeTags.value = activeTags.value.includes(tag)
    ? activeTags.value.filter((t) => t !== tag)
    : [...activeTags.value, tag]
}

const ordered = computed(() =>
  sortItems(visibleItems.value, prefs.value.sortKey, prefs.value.sortDir, prefs.value.foldersFirst),
)

/**
 * 虚拟行的数据。刻意做成「一个接口 + 可空字段」而不是判别联合：
 * 模板里的类型收窄靠不住，宁可在这里多几个问号，也不要在模板里写 `!`。
 */
interface RowData {
  kind: 'header' | 'item' | 'tiles'
  label?: string
  count?: number
  item?: FileItem
  items?: FileItem[]
}

/** 单行列表行高：48 = 控件规范的列表行档（48/56/64/72/96）。
 *  FileRow 是「18 图标 + 16 名称 + 12 元信息同基线」的单行结构，48 正好；
 *  此前的 52 不在任何一档上，一屏还会少排一行。 */
const LIST_ROW_H = 48
const HEADER_ROW_H = 34

/** 画廊强制大档（它就是「大图块」这个视图） */
const effectiveIconSize = computed<IconSize>(() =>
  prefs.value.viewMode === 'gallery' ? 'lg' : prefs.value.iconSize,
)

const tileW = computed(() =>
  effectiveIconSize.value === 'sm' ? 96 : effectiveIconSize.value === 'md' ? 116 : 140,
)
const tileH = computed(() =>
  effectiveIconSize.value === 'sm' ? 112 : effectiveIconSize.value === 'md' ? 130 : 152,
)
const perRow = computed(() =>
  Math.max(2, Math.floor((Math.max(hostWidth.value, 320) - 20) / tileW.value)),
)

const rows = computed<VRow<RowData>[]>(() => {
  const out: VRow<RowData>[] = []
  const groups = groupItems(ordered.value, prefs.value.groupKey)
  const grid = prefs.value.viewMode === 'grid' || prefs.value.viewMode === 'gallery'
  for (const g of groups) {
    if (prefs.value.groupKey !== 'none') {
      out.push({
        key: `h:${g.key}`,
        h: HEADER_ROW_H,
        data: { kind: 'header', label: g.label, count: g.items.length },
      })
    }
    if (grid) {
      const n = perRow.value
      for (let i = 0; i < g.items.length; i += n) {
        out.push({
          key: `t:${g.key}:${i}`,
          h: tileH.value,
          data: { kind: 'tiles', items: g.items.slice(i, i + n) },
        })
      }
    } else {
      for (const item of g.items) {
        out.push({ key: item.id, h: LIST_ROW_H, data: { kind: 'item', item } })
      }
    }
  }
  return out
})

const vlist = useVirtualRows<RowData>(rows, { overscan: 6 })
const scrollEl = ref<HTMLElement | null>(null)
watch(scrollEl, (el) => vlist.attach(el), { immediate: true })

/** 条目 id → 所在虚拟行（键盘滚动定位） */
const rowIndexOfItem = computed(() => {
  const m = new Map<string, number>()
  rows.value.forEach((r, i) => {
    if (r.data.item) m.set(r.data.item.id, i)
    for (const it of r.data.items ?? []) m.set(it.id, i)
  })
  return m
})

const wide = computed(() => hostWidth.value >= 640)
/** 宽屏列（来自列注册表 + 用户选择） */
const columns = computed(() => visibleColumns(prefs.value.columns))
/** 详情里的附加属性行（属性 provider 提供） */
const detailRows = computed(() => (details.value ? propertyRows(details.value) : []))
const selectedItems = computed(() => sel.list(ordered.value))
const selectedBytes = computed(() => selectedItems.value.reduce((n, i) => n + (i.size ?? 0), 0))

/* ---------- 列头排序（宽屏；窄屏用工具条的排序菜单） ---------- */

function sortBy(key: SortKey): void {
  if (prefs.value.sortKey === key) {
    prefs.value.sortDir = prefs.value.sortDir === 'asc' ? 'desc' : 'asc'
    return
  }
  prefs.value.sortKey = key
  // 名称默认升序，时间/大小默认降序（「最近/最大」通常才是要看的那一端）
  prefs.value.sortDir = key === 'name' || key === 'kind' ? 'asc' : 'desc'
}

function sortMark(key: SortKey): 'asc' | 'desc' | null {
  return prefs.value.sortKey === key ? prefs.value.sortDir : null
}

/* ---------- 危险操作的二次确认（第一次点只是「上膛」） ---------- */

/** 「彻底删除 / 清空」是不可逆的：菜单一点即走太轻，改成 6 秒内的第二次点击才算确认 */
const armed = ref<{ act: 'purge' | 'empty'; at: number; count: number } | null>(null)

function armOrRun(act: 'purge' | 'empty', count: number, run: () => void): void {
  const a = armed.value
  if (a && a.act === act && Date.now() - a.at < 6000) {
    armed.value = null
    run()
    return
  }
  armed.value = { act, at: Date.now(), count }
  toast.toast(
    act === 'empty'
      ? `再点一次「清空回收站」即永久删除这 ${count} 项`
      : `再点一次即永久删除这 ${count} 项（回收站里也找不回来）`,
  )
}

const armedSuffix = computed(() => (armed.value ? ' · 再点一次确认' : ''))

/* ---------- 读取与刷新 ---------- */

/** 请求序号：切目录 / 刷新并发时，先发后到的旧响应不许覆盖新目录的列表 */
let refreshSeq = 0

async function refresh(): Promise<void> {
  const my = ++refreshSeq
  loading.value = true
  try {
    // 最近模式也要跟着刷新：刚刚新建/删除的文件，这一屏就是它的家
    if (navMode.value === 'recent' && recentLoaded.value) {
      recentLoaded.value = false
      await loadRecent()
    }
    if (trashMode.value) {
      const items = await provider.listTrash()
      if (my !== refreshSeq) return
      trashItems.value = items
      trashCount.value = items.length
    } else {
      const l = await provider.listDir(path.value)
      if (my !== refreshSeq) return
      listing.value = l
      // 刷新后保留仍然存在的选择 —— 稳定 id 的意义就在这里
      sel.prune(l.items)
    }
    errText.value = ''
  } catch (e) {
    if (my === refreshSeq) errText.value = errMsg(e)
  } finally {
    if (my === refreshSeq) loading.value = false
  }
}

async function loadTrashCount(): Promise<void> {
  try {
    trashCount.value = (await provider.listTrash()).length
  } catch {
    /* 计数拿不到不影响浏览 */
  }
}

async function navigate(next: string, push = true): Promise<void> {
  if (next === path.value && !trashMode.value && !globalHits.value) return
  trashMode.value = false
  globalHits.value = null
  globalKeyword.value = ''
  keyword.value = ''
  activeTags.value = []
  details.value = null
  editingId.value = null
  sel.clear()
  // 换目录就回到「目录文件」模式：刚从最近模式点进来一个文件夹，
  // 停留在这个模式会让「上一步」与面包屑都指着一个看不见的目录
  navMode.value = 'dir'
  selectMode.value = false
  path.value = next
  await refresh()
  if (push) {
    history.value = [...history.value.slice(0, histIdx.value + 1), next]
    histIdx.value = history.value.length - 1
  }
  await nextTick()
  vlist.reset()
}

async function goHistory(delta: number): Promise<void> {
  const i = histIdx.value + delta
  if (i < 0 || i >= history.value.length) return
  histIdx.value = i
  await navigate(history.value[i], false)
}

async function toggleTrash(): Promise<void> {
  trashMode.value = !trashMode.value
  globalHits.value = null
  keyword.value = ''
  sel.clear()
  selectMode.value = false
  navMode.value = 'dir'
  await refresh()
  await nextTick()
  vlist.reset()
}

/** 本地过滤没有结果时，把过滤提升成「在整个工作区里按文件名找」 */
async function runGlobalSearch(): Promise<void> {
  const kw = keyword.value.trim()
  if (!kw) return
  searching.value = true
  try {
    globalKeyword.value = kw
    globalHits.value = await provider.search(kw, 200)
    sel.clear()
    await nextTick()
    vlist.reset()
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    searching.value = false
  }
}

function exitGlobalSearch(): void {
  globalHits.value = null
  globalKeyword.value = ''
}

/* ---------- 打开 / 进入 ---------- */

function dirPathOf(item: FileItem): string {
  return item.uri.split('://')[1] ?? item.name
}

function focusList(): void {
  scrollEl.value?.focus({ preventScroll: true })
}

/**
 * 指针能力：有 hover 的设备走桌面语义（单击选中、双击打开），
 * 触屏走移动语义 —— 触屏上没有 hover，「单击只选中」在手指下像点了没反应，
 * 所以移动端的单击/dblclick 语义在行组件里按 `touch` 分开处理（见 FileRow）。
 */
const hoverFine = ref(true)
let hoverMq: MediaQueryList | null = null

/** 触屏语义：长按菜单、单击选中（文件夹单击直接打开）、双击打开 */
const touch = computed(() => !hoverFine.value)

/**
 * 一次「激活」（单击）怎么算，按端分开：
 *
 * - **触屏多选态**：单击 = 切换选中（勾选框已经画出来了，点哪行都是选）；
 * - **触屏最近模式**：单击 = 打开（那一屏全是文件，没有「进去」这个概念）；
 * - **触屏目录模式**：文件夹单击直接打开；文件单击只选中（打开靠双击/菜单）；
 * - **桌面**：单选（Shift 范围、Ctrl/Cmd 切换），打开一律靠双击。
 */
function activate(item: FileItem, ev: MouseEvent): void {
  if (touch.value && narrow.value) {
    if (selectMode.value) {
      // 多选态：单击 = **切换**选中（不是单选 —— 勾选框都画出来了，点哪行都是加/减）
      if (ev.shiftKey) sel.click(item, ordered.value, { shift: true, toggle: false })
      else sel.toggle(item)
      return
    }
    if (navMode.value === 'recent' || item.isDir) {
      openItem(item)
      return
    }
    sel.selectOnly(item)
    details.value = null
    return
  }
  const tag = (ev.target as HTMLElement | null)?.tagName
  if (tag !== 'INPUT') focusList()
  sel.click(item, ordered.value, { shift: ev.shiftKey, toggle: ev.ctrlKey || ev.metaKey })
  details.value = null
}

function openItem(item: FileItem): void {
  if (trashMode.value) {
    details.value = item
    return
  }
  if (archive.value) {
    // 包内：目录往里走，文件提示先解压（读不到就是读不到，不做假预览）
    if (item.isDir) void archiveGo(dirPathOf(item))
    else toast.toast('压缩包里的文件：先「解压选中」再打开')
    return
  }
  if (item.isDir) {
    void navigate(dirPathOf(item))
    return
  }
  // 预览偏好由注册表决定：压缩包进压缩包浏览，其余交给宿主（阅读器）
  if (item.docId && preferredPreview(item) === 'reader') emit('open', item)
  else if (item.docId) void openArchive(item)
  else toast.toast('该条目没有可阅读的内容')
}

function up(): void {
  void navigate(parentOf(path.value))
}

/** 手机端唯一那颗「上一步」：先退目录层级，到根了就退历史，再没有就什么也不做 */
function backOrUp(): void {
  if (navMode.value === 'recent') {
    void setNavMode('dir')
    return
  }
  if (path.value) {
    up()
    return
  }
  if (canBack.value) void goHistory(-1)
}

/* ---------- 选择与剪贴板命令 ---------- */

function doCopy(): void {
  const list = selectedItems.value
  if (!list.length) return
  clip.copy(list)
  // 顺带写系统剪贴板：贴到别的应用至少能拿到 kb:// 路径；失败也不影响应用内复制
  void writeSystemClipboard(list, 'copy')
  toast.toast(`已复制 ${list.length} 项 · 粘贴时才真正写入`)
}

function doCut(): void {
  const list = selectedItems.value
  const ok = list.filter((i) => provider.capability(i, 'move').ok)
  if (!ok.length) {
    toast.toast(list[0]?.readOnlyReason ?? '这些条目不能剪切')
    return
  }
  clip.cut(ok)
  void writeSystemClipboard(ok, 'cut')
  toast.toast(`已剪切 ${ok.length} 项`)
}

async function doPaste(targetDir = path.value, mode = clip.mode.value): Promise<void> {
  let list = clip.items.value
  // 应用内没有待粘贴的东西时，看一眼系统剪贴板里有没有本应用的路径
  //（跨进程粘贴：在另一个窗口复制，在这里粘贴）
  if (!list.length) {
    const fromSystem = await readSystemClipboard()
    if (fromSystem?.items.length) {
      clip.copy(fromSystem.items)
      list = fromSystem.items
      mode = fromSystem.mode
    }
  }
  if (!mode || !list.length) return
  // 剪切到原地没有意义（也不会改动任何东西）
  if (mode === 'cut' && list.every((i) => parentOf(dirPathOf(i)) === targetDir)) {
    toast.toast('这些条目已经在这个目录里了')
    return
  }
  const label = `${mode === 'cut' ? '移动' : '复制'} ${list.length} 项到 ${targetDir || '根目录'}`
  await withConflictPolicy(label, list.map((i) => i.name), targetDir, (policy) => {
    void runPaste(list, mode, targetDir, policy)
  })
}

/** 「移动到…」菜单：搬的是被右键选中的那些条目，与剪贴板无关（剪贴板可能是空的） */
async function doMove(list: FileItem[], targetDir: string): Promise<void> {
  const movable = list.filter((i) => provider.capability(i, 'move').ok)
  if (!movable.length) {
    toast.toast(list[0]?.readOnlyReason ?? '这些条目不能移动')
    return
  }
  if (movable.every((i) => parentOf(dirPathOf(i)) === targetDir)) {
    toast.toast('这些条目已经在这个目录里了')
    return
  }
  const label = `移动 ${movable.length} 项到 ${targetDir || '根目录'}`
  await withConflictPolicy(label, movable.map((i) => i.name), targetDir, (policy) => {
    void runPaste(movable, 'cut', targetDir, policy, true)
  })
}

/** 按冲突策略真正执行一批粘贴。`keepClip = true` 供「移动到…」用（不碰剪贴板）。 */
async function runPaste(
  list: FileItem[],
  mode: ClipMode,
  targetDir: string,
  policy: ConflictPolicy,
  keepClip = false,
): Promise<void> {
  const taken = await takenNames(targetDir)
  const label = `${mode === 'cut' ? '移动' : '复制'} ${list.length} 项到 ${targetDir || '根目录'}`
  const usedNames = new Set<string>()
  const res = await queue.runBatch('paste', label, list, async (item, ctx) => {
    const clash = taken.has(item.name)
    if (clash && policy === 'skip') {
      ctx.step()
      return
    }
    // 「保留两者」的目标名：避开目标目录已有 + 本批已占用的名字
    const asName =
      clash && policy === 'keepBoth' ? keepBothName(item.name, new Set([...taken, ...usedNames])) : undefined
    if (mode === 'cut') {
      if (clash && policy === 'replace') {
        // 替换 = 先把挡路的那个送进回收站（可恢复），再把源移过来
        const victim = (await provider.listDir(targetDir)).items.find((i) => i.name === item.name)
        if (victim?.fileId !== undefined) await kbService.trash(victim.fileId)
      }
      await provider.move(item, targetDir, asName)
    } else {
      await provider.duplicate(item, targetDir, asName)
    }
    usedNames.add(asName ?? item.name)
    ctx.step()
  })
  // 剪切态只在整批搬完之后才摘：中途取消/失败时源条目还得留着半透明标记（可「继续未完成」）
  if (mode === 'cut' && !keepClip && res.remaining === 0) clip.clear()
  await afterBatch()
}

/* ---------- 命名 / 删除 / 恢复 ---------- */

function startRename(item: FileItem): void {
  const cap = provider.capability(item, 'rename')
  if (!cap.ok) {
    toast.toast(cap.reason ?? '不能改名')
    return
  }
  editingId.value = item.id
}

async function commitRename(item: FileItem, name: string): Promise<void> {
  editingId.value = null
  await queue.run('rename', `重命名 ${item.name}`, 1, async (ctx) => {
    try {
      await provider.rename(item, name)
      ctx.step()
    } catch (e) {
      ctx.fail(errMsg(e))
    }
  })
  await refresh()
}

async function doTrash(list: FileItem[]): Promise<void> {
  const targets = list.filter((i) => provider.capability(i, 'delete').ok)
  if (!targets.length) {
    toast.toast(list[0]?.readOnlyReason ?? '没有可删除的条目')
    return
  }
  const ids: number[] = []
  await queue.runBatch('trash', `删除 ${targets.length} 项`, targets, async (item, ctx) => {
    await provider.trash(item)
    if (item.fileId !== undefined) ids.push(item.fileId)
    ctx.step()
  })
  await afterBatch()
  if (ids.length) {
    toast.toast(`已移入回收站 ${ids.length} 项`, {
      action: {
        label: '撤销',
        run: () => {
          void queue
            .run('restore', `恢复 ${ids.length} 项`, 1, async (ctx) => {
              const r = await kbService.trashRestore(ids)
              ctx.step()
              for (const f of r.failed) ctx.fail(f)
            })
            .then(async () => {
              await refresh()
              await loadTrashCount()
            })
        },
      },
    })
  }
}

async function doRestore(list: FileItem[]): Promise<void> {
  const ids = list.map((i) => i.fileId).filter((v): v is number => v !== undefined)
  if (!ids.length) return
  await queue.run('restore', `恢复 ${ids.length} 项`, 1, async (ctx) => {
    const r = await kbService.trashRestore(ids)
    ctx.step()
    for (const f of r.failed) ctx.fail(f)
  })
  await refresh()
  await loadTrashCount()
  toast.toast(`已恢复 ${ids.length} 项`)
}

async function doPurge(list: FileItem[]): Promise<void> {
  const ids = list.map((i) => i.fileId).filter((v): v is number => v !== undefined)
  if (!ids.length) return
  await queue.run('purge', `彻底删除 ${ids.length} 项`, 1, async (ctx) => {
    const r = await kbService.trashPurge(ids)
    ctx.step()
    for (const f of r.failed) ctx.fail(f)
  })
  await refresh()
  await loadTrashCount()
}

async function doEmptyTrash(): Promise<void> {
  await queue.run('emptyTrash', '清空回收站', 1, async (ctx) => {
    const r = await kbService.trashEmpty()
    ctx.step()
    toast.toast(
      r.freedBytes > 0 ? `回收站已清空，释放 ${humanBytes(r.freedBytes)}` : '回收站已清空',
    )
  })
  await refresh()
  await loadTrashCount()
}

async function togglePin(list: FileItem[]): Promise<void> {
  const item = list[0]
  if (!item) return
  const cap = provider.capability(item, 'pin')
  if (!cap.ok) {
    toast.toast(cap.reason ?? '不能钉住')
    return
  }
  const target = item.docId ?? item.fileId
  if (target === undefined) return
  try {
    const f = await kbService.fsPin(target, !item.pinned, 'user')
    toast.toast(f.pinned ? '已钉住：AI 不会再自动移动它' : '已取消钉住')
    await refresh()
  } catch (e) {
    toast.toast(errMsg(e))
  }
}

/* ---------- 批量重命名 ---------- */

/** 打开批量重命名面板（选择 ≥1 项且都允许改名） */
function startBatchRename(): void {
  const list = selectedItems.value
  if (!list.length) {
    toast.toast('先选要改名的条目')
    return
  }
  const blocked = list.find((i) => !provider.capability(i, 'rename').ok)
  if (blocked) {
    toast.toast(`${blocked.name}：${provider.capability(blocked, 'rename').reason ?? '不能改名'}`)
    return
  }
  batchOpen.value = true
}

/** 面板算好「谁改成什么」之后，逐条走队列（每步可取消、失败逐条报告） */
async function applyBatchRename(pairs: { item: FileItem; name: string }[]): Promise<void> {
  batchOpen.value = false
  if (!pairs.length) return
  await queue.runBatch('rename', `批量重命名 ${pairs.length} 项`, pairs, async (p, ctx) => {
    await provider.rename(p.item, p.name)
    ctx.step()
  })
  await refresh()
}

/* ---------- 新建目录 / 导入 ---------- */

function pickUpload(): void {
  fileInput.value?.click()
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(f)
  })
}

/** 客户端导入上限：base64 走 IPC，超过这个体积就不再考虑 */
const UPLOAD_CAP = 32 * 1024 * 1024

/** 导入是「系统文件 → 工作区」的入口操作，不属于 VFS 自身的移动/复制语义 */
async function onUploadPicked(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  const dir = trashMode.value ? '' : path.value
  await withConflictPolicy(`导入 ${files.length} 个文件`, files.map((f) => f.name), dir, (policy) => {
    void runImport(files, dir, policy)
  })
}

/** 按冲突策略导入一批本地文件 */
async function runImport(files: File[], dir: string, policy: ConflictPolicy): Promise<void> {
  const taken = await takenNames(dir)
  const used = new Set<string>()
  let skipped = 0
  await queue.runBatch('upload', `导入 ${files.length} 个文件`, files, async (file, ctx) => {
    const clash = taken.has(file.name)
    if (clash && policy === 'skip') {
      skipped += 1
      ctx.step()
      return
    }
    if (file.size > UPLOAD_CAP) {
      ctx.fail(`${file.name}：超过 ${UPLOAD_CAP / 1024 / 1024}MB`)
      return
    }
    const name = clash && policy === 'keepBoth' ? keepBothName(file.name, new Set([...taken, ...used])) : file.name
    const dataUrl = await readAsDataUrl(file)
    await kbService.mediaWrite({
      path: dir ? `${dir}/${name}` : name,
      name,
      mime: file.type || '',
      dataBase64: dataUrl,
    })
    used.add(name)
    ctx.step()
  })
  if (skipped) toast.toast(`按你的选择跳过了 ${skipped} 个同名文件`)
  await refresh()
}

/* ---------- 拖放（内部） ---------- */

/** 拖到回收站按钮上 = 删除（拖放语义里最自然的「丢掉」） */
const TRASH_DROP = '__trash__'

function onDragStart(item: FileItem, ev: DragEvent): void {
  // 拖未选中的条目 = 拖它自己（先选上，视觉上才不会「拖着别人走」）
  if (!sel.has(item.id)) sel.selectOnly(item)
  dragItems.value = selectedItems.value
  const dt = ev.dataTransfer
  if (dt) {
    dt.effectAllowed = 'copyMove'
    dt.setData('text/plain', dragItems.value.map((i) => i.name).join('\n'))
    // 拖出到系统：Chromium 认 DownloadURL（字节必须**同步**给出，所以只对已缓存缩略图的图片生效）。
    // 其余情况走「导出到本地」菜单项 —— 那是各端都成立的一条路。
    const first = dragItems.value[0]
    if (first) {
      const thumb = cachedThumbAny(first)
      if (thumb) dt.setData('DownloadURL', `image/jpeg:${first.name}:${thumb}`)
    }
  }
}

function onDragEnd(): void {
  dragItems.value = []
  dropTarget.value = null
}

/** 目标目录能不能接住这一拖：得是目录、不在回收站/压缩包视图、且至少有一个源不在该目录里。
 *  压缩包视图里的「目录」是包内条目（路径形如 `3/子目录`），不是工作区目录 ——
 *  接住这一拖会把真实文件写进磁盘上一个名叫 `3` 的目录里。 */
function acceptsDrop(item: FileItem): boolean {
  if (!dragItems.value.length || !item.isDir || trashMode.value || archive.value) return false
  const target = dirPathOf(item)
  return dragItems.value.some((i) => parentOf(dirPathOf(i)) !== target)
}

function onDragOverRow(item: FileItem, ev: DragEvent): void {
  if (!acceptsDrop(item)) return
  // 必须 preventDefault，否则浏览器认为「这里不接受放置」，drop 永远不会来
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = ev.ctrlKey || ev.metaKey ? 'copy' : 'move'
  dropTarget.value = item.id
}

/**
 * 落下：**只有 drop 事件走这里**。dragenter/dragover 是高频事件，
 * 挂上同一个处理器会让一次拖拽触发几十次操作（每条 dragover 一次粘贴）。
 */
function onDrop(item: FileItem, ev: DragEvent): void {
  if (!acceptsDrop(item)) return
  ev.preventDefault()
  dropTarget.value = null
  void doPaste(dirPathOf(item), ev.ctrlKey || ev.metaKey ? 'copy' : 'cut')
}

function onDropOnPath(target: string, ev: DragEvent): void {
  // 从系统拖进来的文件（HTML5 通道：浏览器与部分平台会走这里）
  const files = [...(ev.dataTransfer?.files ?? [])]
  if (files.length) {
    ev.preventDefault()
    dropTarget.value = null
    const dir = target === TRASH_DROP ? '' : target
    void withConflictPolicy(`拖入 ${files.length} 个文件`, files.map((f) => f.name), dir, (policy) => {
      void runImport(files, dir, policy)
    })
    return
  }
  if (!dragItems.value.length) return
  ev.preventDefault()
  dropTarget.value = null
  if (target === TRASH_DROP) {
    if (!trashMode.value) void doTrash(selectedItems.value)
    return
  }
  void doPaste(target, ev.ctrlKey || ev.metaKey ? 'copy' : 'cut')
}

/** 桌面端：Tauri 把系统拖放事件交给我们（WebView 会拦截原生 drop，HTML5 那一路收不到） */
async function bindTauriDrop(): Promise<void> {
  if (!isTauri) return
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload
      if (p.type !== 'drop' || !p.paths?.length) return
      void importPaths(p.paths)
    })
  } catch {
    /* 拿不到拖放通道不影响其它功能（还可以用「导入文件」按钮） */
  }
}

/** 按路径导入一批本地文件（桌面端拖入的落点） */
async function importPaths(paths: string[]): Promise<void> {
  const dir = trashMode.value ? '' : path.value
  const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p)
  await withConflictPolicy(`拖入 ${paths.length} 个文件`, names, dir, (policy) => {
    void runImportPaths(paths, dir, policy)
  })
}

async function runImportPaths(paths: string[], dir: string, policy: ConflictPolicy): Promise<void> {
  const taken = await takenNames(dir)
  const used = new Set<string>()
  await queue.runBatch('upload', `导入 ${paths.length} 个文件`, paths, async (path, ctx) => {
    const raw = path.split(/[\\/]/).pop() ?? path
    const clash = taken.has(raw)
    if (clash && policy === 'skip') {
      ctx.step()
      return
    }
    const name = clash && policy === 'keepBoth' ? keepBothName(raw, new Set([...taken, ...used])) : raw
    await kbService.importPath(path, dir || undefined, name)
    used.add(name)
    ctx.step()
  })
  await refresh()
}

/** 批量操作跑完（或继续跑完）之后的共同收尾：目录与回收站计数都重新读一次 */
async function afterBatch(): Promise<void> {
  await refresh()
  await loadTrashCount()
}

/* ---------- 框选（细指针；触屏让位给滚动） ---------- */

function onBandStart(ev: PointerEvent): void {
  if (batchOpen.value || pendingConflict.value) return
  marquee.start(
    ev,
    scrollEl.value,
    (ids, additive) => sel.setMany(ids, additive),
    () => sel.clear(),
  )
}

/* ---------- 冲突策略选择 ---------- */

function choosePolicy(policy: ConflictPolicy, remember: boolean): void {
  const pending = pendingConflict.value
  pendingConflict.value = null
  if (remember) conflictPolicy.value = policy
  pending?.run(policy)
}

function cancelPolicy(): void {
  pendingConflict.value = null
}

/* ---------- 快捷键 ---------- */

/** 打字跳转的缓冲（连续字母 800ms 内算一个前缀） */
let typeBuffer = ''
let lastTypedAt = 0

function scrollToItem(item: FileItem | null): void {
  if (!item) return
  const idx = rowIndexOfItem.value.get(item.id)
  if (idx !== undefined) vlist.scrollToIndex(idx)
}

function onKeydown(ev: KeyboardEvent): void {
  const order = ordered.value
  const mod = ev.ctrlKey || ev.metaKey
  const key = ev.key
  const grid = prefs.value.viewMode === 'grid' || prefs.value.viewMode === 'gallery'
  const cols = grid ? perRow.value : 1
  const step = (delta: number, extend: boolean) => {
    ev.preventDefault()
    scrollToItem(sel.moveFocus(order, delta, extend))
  }
  const edge = (last: boolean, extend: boolean) => {
    ev.preventDefault()
    scrollToItem(sel.focusEdge(order, last, extend))
  }

  if (mod) {
    switch (key.toLowerCase()) {
      case 'a':
        ev.preventDefault()
        return sel.selectAll(order)
      case 'c':
        ev.preventDefault()
        return doCopy()
      case 'x':
        ev.preventDefault()
        return doCut()
      case 'v':
        ev.preventDefault()
        return void doPaste()
      case 'i':
        if (ev.shiftKey) {
          ev.preventDefault()
          sel.invert(order)
        }
        return
    }
    return
  }

  switch (key) {
    case 'ArrowDown':
      return step(cols, ev.shiftKey)
    case 'ArrowUp':
      return step(-cols, ev.shiftKey)
    case 'ArrowRight':
      if (grid) return step(1, ev.shiftKey)
      return
    case 'ArrowLeft':
      if (grid) return step(-1, ev.shiftKey)
      return
    case 'Home':
      return edge(false, ev.shiftKey)
    case 'End':
      return edge(true, ev.shiftKey)
    case 'PageDown':
    case 'PageUp': {
      ev.preventDefault()
      const from = order.findIndex((i) => i.id === sel.focusedId.value)
      const cur = from < 0 ? 0 : from
      const page = Math.max(1, vlist.pageSize.value) * cols
      scrollToItem(sel.focusIndex(order, key === 'PageDown' ? cur + page : cur - page, ev.shiftKey))
      return
    }
    case 'Enter': {
      const one = selectedItems.value[0]
      if (one) {
        ev.preventDefault()
        openItem(one)
      }
      return
    }
    case 'F2': {
      const one = selectedItems.value[0]
      if (one) {
        ev.preventDefault()
        startRename(one)
      }
      return
    }
    case 'Delete': {
      ev.preventDefault()
      if (trashMode.value) void doPurge(selectedItems.value)
      else void doTrash(selectedItems.value)
      return
    }
    case 'Backspace': {
      if (keyword.value) return
      ev.preventDefault()
      up()
      return
    }
    case 'Escape': {
      if (keyword.value) keyword.value = ''
      else if (details.value) details.value = null
      else if (trashMode.value) void toggleTrash()
      else sel.clear()
      return
    }
    case ' ': {
      const one = selectedItems.value[0]
      if (one && !one.isDir) {
        ev.preventDefault()
        openItem(one)
      }
      return
    }
  }

  if (key.length === 1 && /\S/.test(key) && !ev.altKey) {
    const now = Date.now()
    const prefix = now - lastTypedAt < 800 ? typeBuffer + key : key
    typeBuffer = prefix
    lastTypedAt = now
    const hit = order.find((i) => i.sortName.toLowerCase().startsWith(prefix.toLowerCase()))
    if (hit) {
      ev.preventDefault()
      sel.selectOnly(hit)
      scrollToItem(hit)
    }
  }
}

/* ---------- 上下文菜单 ---------- */

const menuOpen = ref(false)
const menuAnchor = ref<HTMLElement | null>(null)
const menuTargets = ref<FileItem[]>([])

/** 打开条目菜单：锚点是**那一行本身**（触屏长按没有坐标，右键才有），未选中项先选中 */
function openMenu(item: FileItem | null, anchor: HTMLElement | null): void {
  if (item && !sel.has(item.id)) sel.selectOnly(item)
  menuTargets.value = item ? selectedItems.value : []
  menuAnchor.value = anchor ?? scrollEl.value
  menuOpen.value = true
}

/** 带原因地禁用：菜单项不可点时把「为什么」写在标签里，而不是让用户点了才报错 */
function item(
  label: string,
  value: string,
  opts: {
    icon?: MenuItem['icon']
    ok?: { ok: boolean; reason?: string }
    danger?: boolean
    children?: MenuItem[]
  } = {},
): MenuItem {
  const cap = opts.ok
  const disabled = cap ? !cap.ok : false
  return {
    label: disabled && cap?.reason ? `${label}（${cap.reason}）` : label,
    value,
    icon: opts.icon,
    danger: opts.danger,
    disabled,
    children: opts.children,
  }
}

const MOVE_TARGETS = ['运动', '饮食', '日程', '笔记', '文档', '语音', '视频', '用户记忆', '未分类数据']

const menuActions = computed<MenuItem[]>(() => {
  const list = menuTargets.value
  // 包内浏览：条目还没进工作区，能做的只有解压与看详情
  if (archive.value) {
    const pick = list[0]
    if (!pick) return [{ label: '全部解压到工作区', value: 'extractAll', icon: FileArchive }]
    return [
      item(
        pick.isDir ? '解压这个目录里的内容' : `解压 ${list.length} 项`,
        'extract',
        { icon: FileArchive, ok: { ok: true } },
      ),
      { label: '全部解压到工作区', value: 'extractAll', icon: FileArchive },
      { label: '详情', value: 'details', icon: Info },
    ]
  }
  const one = list.length === 1 ? list[0] : null
  const many = list.length > 1
  const pasteOk = clip.count.value > 0 ? { ok: true } : { ok: false, reason: '剪贴板是空的' }

  if (trashMode.value) {
    const pick = one ?? list[0]
    const suffix = armedSuffix.value
    if (!pick)
      return [
        { label: `清空回收站（${trashCount.value} 项）${suffix}`, value: 'empty', icon: Trash2, danger: true },
      ]
    return [
      item(many ? `恢复 ${list.length} 项` : '恢复', 'restore', {
        icon: RotateCcw,
        ok: provider.capability(pick, 'restore'),
      }),
      item(many ? `彻底删除 ${list.length} 项${suffix}` : `彻底删除${suffix}`, 'purge', {
        icon: Trash2,
        danger: true,
        ok: provider.capability(pick, 'purge'),
      }),
      item(`清空回收站（${trashCount.value} 项）${suffix}`, 'empty', { icon: Trash2, danger: true }),
    ]
  }

  // 空白处右键：只给与选择无关的动作
  if (!list.length) {
    return [
      item('粘贴', 'paste', { icon: ClipboardPaste, ok: pasteOk }),
      { label: '全选', value: 'selectAll' },
      { label: '新建目录', value: 'mkdir', icon: FolderPlus },
      { label: '刷新', value: 'refresh', icon: RefreshCw },
    ]
  }

  const targets: MenuItem[] = MOVE_TARGETS.map((t) => ({ label: t, value: `move:${t}` }))
  const out: MenuItem[] = []
  // 「多选」排在最前：触屏上这是进勾选态的正门（进去之后单击=选中，
  // 底部功能栏给出全选/全不选/复制/剪切）
  out.push({
    label: '多选',
    value: 'multiSelect',
    icon: CheckCheck,
  })
  if (one) {
    out.push(
      item(one.isDir ? '打开' : '在阅读器里打开', 'open', {
        icon: one.isDir ? FolderOpen : Eye,
        ok: provider.capability(one, 'open'),
      }),
    )
    if (!one.isDir) out.push({ label: '详情', value: 'details', icon: Info })
  }
  out.push(
    item(many ? `复制 ${list.length} 项` : '复制', 'copy', {
      icon: Copy,
      ok: provider.capability(one ?? list[0], 'copy'),
    }),
  )
  out.push(
    item(many ? `剪切 ${list.length} 项` : '剪切', 'cut', {
      icon: Scissors,
      ok: provider.capability(one ?? list[0], 'move'),
    }),
  )
  if (one) {
    out.push({ label: '复制路径', value: 'copyPath', icon: Link2 })
    out.push({ label: '导出到本地', value: 'exportLocal', icon: Download })
  }
  out.push(item(clip.count.value ? `粘贴 ${clip.count.value} 项` : '粘贴', 'paste', { icon: ClipboardPaste, ok: pasteOk }))
  {
    const blocked = list.find((i) => !provider.capability(i, 'rename').ok)
    out.push(
      item(many ? `批量重命名 ${list.length} 项…` : '批量重命名…', 'batchRename', {
        icon: Wand2,
        ok: blocked ? { ok: false, reason: `${blocked.name} 不能改名` } : { ok: true },
      }),
    )
  }
  if (one) {
    out.push(item('重命名', 'rename', { icon: Pencil, ok: provider.capability(one, 'rename') }))
    out.push(
      item('移动到…', 'move', {
        icon: MoveRight,
        ok: provider.capability(one, 'move'),
        children: targets,
      }),
    )
    out.push(
      item(one.pinned ? '取消钉住' : '钉住（AI 不再自动移动）', 'pin', {
        icon: one.pinned ? PinOff : Pin,
        ok: provider.capability(one, 'pin'),
      }),
    )
  }
  // 扩展点：插件型 provider 往菜单里加项（如「在压缩包里浏览」）
  for (const c of menuContributions(one, { many, trashMode: false })) {
    out.push({ label: c.label, value: c.value, icon: c.icon, danger: c.danger })
  }
  out.push(
    item(many ? `删除 ${list.length} 项` : '删除', 'del', {
      icon: Trash2,
      danger: true,
      ok: provider.capability(one ?? list[0], 'delete'),
    }),
  )
  return out
})

function onMenuSelect(value: string): void {
  menuOpen.value = false
  const list = menuTargets.value
  const one = list.length === 1 ? list[0] : null
  if (value.startsWith('move:')) {
    void doMove(list, value.slice(5))
    return
  }
  switch (value) {
    case 'multiSelect':
      // 从菜单进多选：把当前这一行（或整批选中）带上，进去就能直接批量操作
      enterSelectMode(one ?? undefined)
      return
    case 'open':
      if (one) openItem(one)
      return
    case 'details':
      details.value = one
      return
    case 'copy':
      return doCopy()
    case 'cut':
      return doCut()
    case 'paste':
      return void doPaste()
    case 'exportLocal':
      if (one) void exportToLocal(one)
      return
    case 'copyPath': {
      const paths = list.map((i) => `kb://${i.uri.split('://')[1] ?? i.name}`).join('\n')
      void navigator.clipboard
        .writeText(paths)
        .then(() => toast.toast(list.length > 1 ? `已复制 ${list.length} 条路径` : '已复制路径'))
        .catch(() => toast.toast('系统剪贴板不可用'))
      return
    }
    case 'rename':
      if (one) startRename(one)
      return
    case 'batchRename':
      return startBatchRename()
    case 'browseArchive': {
      const it = one ?? menuTargets.value[0]
      if (it) void openArchive(it)
      return
    }
    case 'extract':
      return void extractArchive(
        selectionPaths.value.length ? selectionPaths.value : undefined,
      )
    case 'extractAll':
      return void extractArchive()
    case 'pin':
      return void togglePin(list)
    case 'del':
      return void doTrash(list)
    case 'restore':
      return void doRestore(list)
    case 'purge':
      // 不可逆动作：第一次点只是上膛，第二次才真的删
      return armOrRun('purge', list.length || 1, () => void doPurge(list))
    case 'empty':
      return armOrRun('empty', trashItems.value.length, () => void doEmptyTrash())
    case 'selectAll':
      return sel.selectAll(ordered.value)
    case 'mkdir':
      startNew('folder')
      return
    case 'refresh':
      return void refresh()
  }
}

/* ---------- 工具栏菜单 ---------- */

const sortMenuOpen = ref(false)
const groupMenuOpen = ref(false)
const moreMenuOpen = ref(false)
/** 手机端「添加」菜单（新建文件 / 新建文件夹 / 上传文件） */
const addMenuOpen = ref(false)
const sortBtn = ref<HTMLElement | null>(null)
const groupBtn = ref<HTMLElement | null>(null)
const moreBtn = ref<HTMLElement | null>(null)
const addBtn = ref<HTMLElement | null>(null)

/** 手机端「添加」：三个入口，按用户给的顺序 */
const addActions = computed<MenuItem[]>(() => [
  { label: '新建文件', value: 'newFile', icon: FilePlus2 },
  { label: '新建文件夹', value: 'newFolder', icon: FolderPlus },
  { label: '上传文件', value: 'upload', icon: Upload },
])

const sortActions = computed<MenuItem[]>(() => {
  const mark = (k: SortKey) => (prefs.value.sortKey === k ? '✓ ' : '')
  return [
    { label: `${mark('name')}名称`, value: 'sort:name' },
    { label: `${mark('modified')}修改时间`, value: 'sort:modified' },
    { label: `${mark('size')}大小`, value: 'sort:size' },
    { label: `${mark('kind')}类型`, value: 'sort:kind' },
    { label: `${mark('rating')}评分`, value: 'sort:rating' },
    {
      label: prefs.value.sortDir === 'asc' ? '升序（当前）' : '降序（当前）',
      value: 'sort:toggleDir',
      icon: prefs.value.sortDir === 'asc' ? ArrowUp : ArrowDown,
    },
    { label: `${prefs.value.foldersFirst ? '✓ ' : ''}目录排在最前`, value: 'sort:foldersFirst' },
  ]
})

const groupActions = computed<MenuItem[]>(() => {
  const mark = (k: GroupKey) => (prefs.value.groupKey === k ? '✓ ' : '')
  return [
    { label: `${mark('none')}不分组`, value: 'group:none' },
    { label: `${mark('kind')}按类型`, value: 'group:kind' },
    { label: `${mark('day')}按日期`, value: 'group:day' },
    { label: `${mark('size')}按大小`, value: 'group:size' },
    { label: `${prefs.value.showHidden ? '✓ ' : ''}显示隐藏文件`, value: 'group:hidden' },
    { label: `${prefs.value.hideExtension ? '✓ ' : ''}隐藏已知扩展名`, value: 'group:ext' },
  ]
})

function onSortSelect(value: string): void {
  sortMenuOpen.value = false
  groupMenuOpen.value = false
  const [ns, k] = value.split(':')
  if (ns === 'sort') {
    if (k === 'toggleDir') prefs.value.sortDir = prefs.value.sortDir === 'asc' ? 'desc' : 'asc'
    else if (k === 'foldersFirst') prefs.value.foldersFirst = !prefs.value.foldersFirst
    else prefs.value.sortKey = k as SortKey
    return
  }
  if (k === 'hidden') prefs.value.showHidden = !prefs.value.showHidden
  else if (k === 'ext') prefs.value.hideExtension = !prefs.value.hideExtension
  else prefs.value.groupKey = k as GroupKey
}

const moreActions = computed<MenuItem[]>(() => [
  { label: '刷新', value: 'refresh', icon: RefreshCw },
  {
    label: prefs.value.viewMode === 'list' ? '切到网格视图' : '切到列表视图',
    value: 'view',
    icon: LayoutGrid,
  },
  { label: '回到工作区根目录', value: 'root', icon: FolderOpen },
  {
    label: '显示哪些列',
    value: 'columns',
    icon: Columns3,
    children: allColumns().map((c) => ({
      label: `${(prefs.value.columns ?? allColumns().filter((x) => x.defaultVisible !== false).map((x) => x.key)).includes(c.key) ? '✓ ' : ''}${c.label}`,
      value: `col:${c.key}`,
    })),
  },
  {
    label: `同名冲突：${conflictPolicy.value ? policyLabel(conflictPolicy.value) : '每次都问'}`,
    value: 'conflict',
    icon: TriangleAlert,
  },
])

/**
 * 手机端「更多」：视图控制、排序、分组**只在这里**（顶部工具条不放它们，太挤）。
 * 子菜单复用同一批 computed（排序/分组/列都是现成的），所以两端永远同一份规则。
 */
const VIEW_LABEL: Record<ViewMode, string> = {
  list: '列表',
  grid: '网格',
  gallery: '画廊',
  columns: '分栏',
}

const ICON_LABEL: Record<IconSize, string> = { sm: '小', md: '中', lg: '大' }

const viewModeActions = computed<MenuItem[]>(() => {
  const mark = (m: ViewMode) => (prefs.value.viewMode === m ? '✓ ' : '')
  const items: MenuItem[] = [
    { label: `${mark('list')}列表`, value: 'view:list', icon: List },
    { label: `${mark('grid')}网格`, value: 'view:grid', icon: LayoutGrid },
    { label: `${mark('gallery')}画廊（图片与视频）`, value: 'view:gallery', icon: Images },
    { label: `${mark('columns')}分栏`, value: 'view:columns', icon: Columns3 },
  ]
  if (prefs.value.viewMode === 'grid' || prefs.value.viewMode === 'gallery') {
    const mk = (s: IconSize) => (prefs.value.iconSize === s ? '✓ ' : '')
    items.push({
      label: `图标大小（当前${ICON_LABEL[prefs.value.iconSize]}）`,
      value: 'icon',
      icon: Rows3,
      children: [
        { label: `${mk('sm')}小`, value: 'icon:sm' },
        { label: `${mk('md')}中`, value: 'icon:md' },
        { label: `${mk('lg')}大`, value: 'icon:lg' },
      ],
    })
  }
  return items
})

const mobileMoreActions = computed<MenuItem[]>(() => [
  {
    label: `视图：${VIEW_LABEL[prefs.value.viewMode]}`,
    value: 'view',
    icon: LayoutGrid,
    children: viewModeActions.value,
  },
  { label: '排序', value: 'sort', icon: ArrowUpDown, children: sortActions.value },
  { label: '分组与显示', value: 'group', icon: Layers, children: groupActions.value },
  // 根目录在手机上只看得到文件（地标卡不展示），目录树是进子目录的正门 —— 桌面是工具条那颗 PanelLeft
  {
    label: `${prefs.value.showTree ? '✓ ' : ''}目录树`,
    value: 'tree',
    icon: PanelLeft,
  },
  // 桌面「更多」里的视图切换（切到网格/列表）在这里由上面的「视图」子菜单承担，剔掉避免重复
  ...moreActions.value.filter((a) => a.value !== 'view'),
  {
    label: trashMode.value ? '退出回收站' : `回收站（${trashCount.value}）`,
    value: 'trash',
    icon: Trash2,
  },
])

/**
 * 「更多」菜单的总入口：子菜单的值各自路由回原来的处理器。
 * 宽窄两档共用这一个函数（手机菜单的值是桌面集合的超集）——
 * **不要**在模板里写成 `@select="narrow ? a : b"`：Vue 会把三元编译成
 * `$event => (三元式)`，只求值出函数却从不调用，两档菜单会一起失灵。
 */
function onMoreMenuSelect(value: string): void {
  if (value.startsWith('sort:') || value.startsWith('group:')) return onSortSelect(value)
  if (value === 'trash') {
    moreMenuOpen.value = false
    return void toggleTrash()
  }
  if (value === 'tree') {
    moreMenuOpen.value = false
    prefs.value.showTree = !prefs.value.showTree
    return
  }
  return onMoreSelect(value)
}

/** 列的显示开关（至少留一列，否则列表就空了） */
function toggleColumn(key: string): void {
  const current =
    prefs.value.columns ?? allColumns().filter((c) => c.defaultVisible !== false).map((c) => c.key)
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
  if (!next.length) {
    toast.toast('至少保留一列')
    return
  }
  // 按注册顺序归一化，避免开关顺序把列排乱
  const order = allColumns().map((c) => c.key)
  prefs.value.columns = next.sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/** 手机端「添加」菜单：新建文件 / 新建文件夹 / 上传文件 */
function onAddSelect(value: string): void {
  addMenuOpen.value = false
  switch (value) {
    case 'newFile':
      return startNew('file')
    case 'newFolder':
      return startNew('folder')
    case 'upload':
      return pickUpload()
  }
}

function policyLabel(p: ConflictPolicy): string {
  return p === 'replace' ? '总是替换' : p === 'skip' ? '总是跳过' : '总是保留两者'
}

function onMoreSelect(value: string): void {
  moreMenuOpen.value = false
  if (value.startsWith('col:')) return toggleColumn(value.slice(4))
  // 手机端「更多」的子菜单值：视图模式与图标大小也走这里
  if (value.startsWith('view:')) return setView(value.slice(5) as ViewMode)
  if (value.startsWith('icon:')) return setIconSize(value.slice(5) as IconSize)
  switch (value) {
    case 'refresh':
      return void refresh()
    case 'view':
      return setView(prefs.value.viewMode === 'list' ? 'grid' : 'list')
    case 'root':
      return void navigate('')
    case 'columns':
      return
    case 'conflict':
      // 循环切换：总是替换 → 总是跳过 → 总是保留两者 → 每次都问
      conflictPolicy.value =
        conflictPolicy.value === null
          ? 'replace'
          : conflictPolicy.value === 'replace'
            ? 'skip'
            : conflictPolicy.value === 'skip'
              ? 'keepBoth'
              : null
      toast.toast(`同名冲突：${conflictPolicy.value ? policyLabel(conflictPolicy.value) : '每次都问'}`)
      return
  }
}

function setView(mode: ViewMode): void {
  prefs.value.viewMode = mode
  void nextTick().then(() => vlist.reset())
}

function setIconSize(size: IconSize): void {
  prefs.value.iconSize = size
}

/* ---------- 地标（根目录的命名空间） ---------- */

const landmarkRows = computed(() => {
  if (!atRoot.value || keyword.value) return []
  const dirs = (listing.value?.items ?? []).filter((i) => i.isDir)
  const counts = new Map(dirs.map((d) => [d.name, d.childCount]))
  const known = new Set(props.landmarks.map((l) => l.name))
  const out = props.landmarks.map((l) => ({
    name: l.name,
    hint: l.hint,
    count: counts.get(l.name) ?? 0,
  }))
  // 数据里存在、但不在命名空间清单里的顶层目录也要能进入
  for (const d of dirs) {
    if (!known.has(d.name)) out.push({ name: d.name, hint: '用户目录', count: d.childCount })
  }
  return out
})

/** 元数据改完：列表行就地替换，不重读目录（位置、选择、滚动都不动） */
function onMetaChanged(next: FileItem): void {
  details.value = next
  const l = listing.value
  if (l) {
    listing.value = { ...l, items: l.items.map((i) => (i.id === next.id ? next : i)) }
  }
}

/* ---------- 尺寸测量（虚拟化需要容器宽度） ---------- */

let ro: ResizeObserver | null = null
watch(scrollEl, (el) => {
  ro?.disconnect()
  ro = null
  if (!el) return
  hostWidth.value = el.clientWidth
  ro = new ResizeObserver(() => {
    hostWidth.value = el.clientWidth
  })
  ro.observe(el)
})

onMounted(async () => {
  // 指针能力只判一次 + 跟随变化（接外接鼠标的平板上要能切回桌面语义）
  hoverMq = window.matchMedia('(hover: hover) and (pointer: fine)')
  hoverFine.value = hoverMq.matches
  const onHoverChange = () => (hoverFine.value = hoverMq?.matches ?? true)
  hoverMq.addEventListener('change', onHoverChange)
  onBeforeUnmount(() => hoverMq?.removeEventListener('change', onHoverChange))

  void bindTauriDrop()
  await refresh()
  void loadTrashCount()
})

/** 宿主（页面）通过实例引用做三件事：刷新、深链跳目录、判断是否停在根目录 */
defineExpose({ refresh, navigate, path })
</script>

<template>
  <div class="fx">
    <!-- 工具条：导航 + 过滤 + 视图 + 操作。
         手机端只留四样：上一步、搜索、添加、更多 —— 视图/排序/分组全部收进「更多」，
         屏幕才放得下一行真实的文件。宽屏维持桌面工作台那套（前进/后退/视图/树/回收站都在）。 -->
    <div class="bar row" :class="{ mbar: narrow }">
      <template v-if="!narrow">
        <button class="icon" :disabled="!canBack" aria-label="后退" @click="goHistory(-1)">
          <ChevronRight :size="16" class="flip" />
        </button>
        <button class="icon" :disabled="!canForward" aria-label="前进" @click="goHistory(1)">
          <ChevronRight :size="16" />
        </button>
        <button class="icon" aria-label="上一级" :disabled="!path" @click="up">
          <ArrowUp :size="16" />
        </button>
      </template>
      <button
        v-else
        class="icon"
        aria-label="上一步"
        :disabled="navMode !== 'recent' && !path && !canBack"
        @click="backOrUp"
      >
        <ArrowUp :size="16" />
      </button>

      <span class="find">
        <Search :size="15" class="t-3" />
        <input
          v-model="keyword"
          type="search"
          :placeholder="trashMode ? '在回收站里过滤' : navMode === 'recent' ? '过滤最近文件' : '过滤当前目录（回车在整个工作区找）'"
          aria-label="过滤文件"
          @keydown.enter.prevent="runGlobalSearch"
        >
        <button v-if="keyword" class="clear" aria-label="清空搜索" @click="keyword = ''">
          <X :size="13" />
        </button>
      </span>

      <!-- 添加（手机端）：菜单给 新建文件 / 新建文件夹 / 上传文件 -->
      <template v-if="narrow">
        <button ref="addBtn" class="icon" aria-label="添加" @click="addMenuOpen = true">
          <Plus :size="16" />
        </button>
      </template>
      <template v-else>
        <button class="icon" aria-label="新建目录" @click="startNew('folder')">
          <FolderPlus :size="16" />
        </button>
        <button class="icon" aria-label="导入文件" @click="pickUpload">
          <Upload :size="16" />
        </button>
      </template>
      <input ref="fileInput" type="file" multiple class="hidden-input" @change="onUploadPicked">

      <template v-if="!narrow">
        <span class="seg">
          <button class="segb" :class="{ on: prefs.viewMode === 'list' }" aria-label="列表视图" @click="setView('list')">
            <List :size="15" />
          </button>
          <button class="segb" :class="{ on: prefs.viewMode === 'grid' }" aria-label="网格视图" @click="setView('grid')">
            <LayoutGrid :size="15" />
          </button>
          <button class="segb" :class="{ on: prefs.viewMode === 'gallery' }" aria-label="画廊视图" @click="setView('gallery')">
            <Images :size="15" />
          </button>
          <button class="segb" :class="{ on: prefs.viewMode === 'columns' }" aria-label="分栏视图" @click="setView('columns')">
            <Columns3 :size="15" />
          </button>
        </span>
        <button
          class="icon"
          :class="{ on: prefs.showTree }"
          aria-label="目录树"
          @click="prefs.showTree = !prefs.showTree"
        >
          <PanelLeft :size="16" />
        </button>

        <button ref="sortBtn" class="icon" aria-label="排序" @click="sortMenuOpen = true">
          <ArrowUpDown :size="16" />
        </button>
        <button ref="groupBtn" class="icon" aria-label="分组" @click="groupMenuOpen = true">
          <Layers :size="16" />
        </button>
      </template>
      <button ref="moreBtn" class="icon" aria-label="更多" @click="moreMenuOpen = true">
        <MoreHorizontal :size="16" />
      </button>
      <button
        v-if="!narrow"
        class="icon trash-entry"
        :class="{ on: trashMode }"
        :aria-label="`回收站（${trashCount} 项）`"
        @click="toggleTrash"
        @dragover.prevent
        @drop="onDropOnPath(TRASH_DROP, $event)"
      >
        <Trash2 :size="16" />
        <i v-if="trashCount" class="dot">{{ trashCount }}</i>
      </button>
    </div>

    <!-- 图标尺寸档（只在网格里出现；手机端这一档收在「更多」里）。
         拖放规则是背景知识（试一次就会），收进行尾一枚 InfoHint，工具条上只留控件。 -->
    <div v-if="prefs.viewMode === 'grid' && !trashMode && !narrow" class="bar row sizing">
      <span class="t-3 label">图标</span>
      <span class="seg">
        <button class="segb" :class="{ on: prefs.iconSize === 'sm' }" @click="setIconSize('sm')">小</button>
        <button class="segb" :class="{ on: prefs.iconSize === 'md' }" @click="setIconSize('md')">中</button>
        <button class="segb" :class="{ on: prefs.iconSize === 'lg' }" @click="setIconSize('lg')">大</button>
      </span>
      <span class="sizing-hint">
        <InfoHint
          title="拖动与复制"
          content="把条目拖到左侧边栏的目录、面包屑的某一级或另一个文件夹上，即可移动它；拖动时按住 Ctrl 是复制。拖到「回收站」则是删除。"
        />
      </span>
    </div>

    <!-- 新建文件 / 新建目录（就地，不做弹窗） -->
    <div v-if="newOpen" class="card newfolder">
      <input
        v-model="newName"
        :placeholder="newOpen === 'folder' ? '新目录名，如「知识」' : '新文件名，如「课程笔记.md」'"
        :aria-label="newOpen === 'folder' ? '新目录名' : '新文件名'"
        @keyup.enter="createNew"
      >
      <button class="btn" :disabled="!newName.trim()" @click="createNew">
        {{ newOpen === 'folder' ? '创建目录' : '创建文件' }}
      </button>
      <button class="btn ghost" @click="newOpen = null">取消</button>
    </div>

    <!-- 压缩包内浏览：条数与返回一起给，包内路径可逐级点回 -->
    <div v-if="archive" class="card banner row arcbar">
      <FileArchive :size="14" class="t-3" />
      <span class="flex-1">
        <b>{{ archive.name }}</b>
        <small class="t-3">
          <b class="arc-num num">{{ archive.listing.total }}</b><span class="arc-n"> 项</span>
          <span class="arc-sep">·</span>
          <span class="arc-dim">解压后 {{ humanBytes(archive.listing.totalBytes) }}</span>
        </small>
        <StatusChip class="arc-fmt" tone="neutral" size="sm">{{ archive.listing.format }} 格式</StatusChip>
      </span>
      <!-- 解压目标目录：默认去处写进 placeholder，怕文件丢的人不必先猜该填什么 -->
      <input v-model="extractTo" class="arcto" placeholder="解压到（留空 → 未分类数据/解压）" aria-label="解压目标目录">
      <button class="btn ghost tiny" :disabled="archiveBusy" @click="extractArchive(selectionPaths)">
        解压选中（{{ sel.count.value }}）
      </button>
      <button class="btn ghost tiny" :disabled="archiveBusy" @click="extractArchive()">全部解压</button>
      <button class="btn ghost tiny" @click="closeArchive">返回目录</button>
    </div>

    <!-- 面包屑：条目拖到这里可以移入；包内模式走包内面包屑 -->
    <div v-if="archive" class="crumbs row">
      <button class="crumb" @click="archiveGo('')">{{ archive.name }}</button>
      <template v-for="(c, k) in archiveCrumbs" :key="k">
        <ChevronRight :size="13" class="t-3" />
        <button
          class="crumb"
          :class="{ cur: k === archiveCrumbs.length - 1 }"
          @click="archiveGo(archiveCrumbs.slice(0, k + 1).join('/'))"
        >
          {{ c }}
        </button>
      </template>
    </div>
    <div v-else-if="navMode === 'recent' && !trashMode" class="crumbs row">
      <button class="crumb cur" @click="setNavMode('dir')">最近文件</button>
      <!-- 排序口径做成中性胶囊；「跨目录」这类背景说明收进 InfoHint。
           .crumb-note 仍是这一组的挂点（e2e 读它的文本确认提示在），胶囊与
           帮助入口都放进这一组，文字不重复、类名不失效。 -->
      <span class="crumb-note">
        <StatusChip class="crumb-sort" tone="neutral" size="sm">按最近修改</StatusChip>
        <InfoHint
          title="最近文件"
          content="这一屏跨出当前目录，把整个工作区里最近动过的文件列在一起，所以上方不显示目录层级；要一级一级看，点左侧「文件」面包屑切回目录文件。"
        />
      </span>
    </div>
    <div v-else-if="!trashMode && !globalHits" class="crumbs row">
      <button class="crumb" :class="{ cur: !crumbs.length }" @click="navigate('')">文件</button>
      <template v-for="(c, k) in crumbs" :key="k">
        <ChevronRight :size="13" class="t-3" />
        <button
          class="crumb"
          :class="{ cur: k === crumbs.length - 1, over: dropTarget === `crumb:${k}` }"
          @click="navigate(crumbs.slice(0, k + 1).join('/'))"
          @dragover.prevent="dropTarget = `crumb:${k}`"
          @dragleave="dropTarget = null"
          @drop="onDropOnPath(crumbs.slice(0, k + 1).join('/'), $event)"
        >
          {{ c }}
        </button>
      </template>
    </div>

    <!-- 搜索 / 回收站态横幅 -->
    <div v-if="globalHits" class="card banner row">
      <Search :size="14" class="t-3" />
      <span class="flex-1">
        整个工作区里，名字含「{{ globalKeyword }}」的有 <b>{{ globalHits.length }}</b> 个
      </span>
      <button class="btn ghost tiny" @click="exitGlobalSearch">回到目录</button>
    </div>
    <!-- 搜索 / 回收站态横幅：回收站只留「占磁盘」这一行结论，恢复与删除的取舍收进 InfoHint -->
    <div v-if="trashMode" class="card banner row">
      <Trash2 :size="14" class="t-3" />
      <span class="flex-1">回收站条目仍占磁盘空间</span>
      <InfoHint
        title="回收站"
        content="回收站只是把条目移出了目录，磁盘空间还占着：恢复会把条目放回原来的位置，彻底删除才会释放空间。清空会一次性删掉回收站里的全部条目。"
      />
      <button class="btn ghost tiny" :disabled="!trashItems.length" @click="doEmptyTrash">清空</button>
      <button class="btn ghost tiny" @click="toggleTrash">退出</button>
    </div>

    <!-- 地标：根目录的命名空间（数据里没有对应目录也照样显示，这就是心智模型）。
         手机端不展示：主内容区只留面包屑 + 功能 + 当前目录（用户要求）。 -->
    <section v-if="!narrow && landmarkRows.length" class="card list landmarks">
      <h3 class="sec">工作区</h3>
      <ul>
        <li v-for="l in landmarkRows" :key="l.name">
          <button class="row item" @click="navigate(l.name)">
            <FolderOpen :size="16" class="fic" />
            <span class="flex-1">
              <b>{{ l.name }}</b>
              <small>{{ l.hint }}</small>
            </span>
            <span class="t-3 count"><span class="num">{{ l.count }}</span> 项</span>
            <ChevronRight :size="15" class="t-3" />
          </button>
        </li>
      </ul>
    </section>

    <p v-if="!narrow && landmarkRows.length && ordered.length" class="sec files-sec">根目录文件</p>

    <!-- 列头（宽屏=表格式）：列来自列注册表（可在「列」菜单里增删），点列头排序 -->
    <div v-if="wide && prefs.viewMode === 'list' && !trashMode" class="thead row">
      <span class="th-spacer" aria-hidden="true" />
      <button
        v-for="c in columns"
        :key="c.key"
        class="th"
        :class="{ flex: c.flex, end: c.align === 'end', sortable: !!c.sortKey }"
        :style="c.width ? { width: `${c.width}px` } : undefined"
        :title="c.hint"
        :disabled="!c.sortKey"
        @click="c.sortKey && sortBy(c.sortKey)"
      >
        {{ c.label }}
        <template v-if="c.sortKey">
          <ArrowUp v-if="sortMark(c.sortKey) === 'asc'" :size="11" />
          <ArrowDown v-else-if="sortMark(c.sortKey) === 'desc'" :size="11" />
        </template>
      </button>
    </div>

    <!-- 标签筛选条：只在这一层出现过标签时出现（手机端收进「更多 → 分组与显示」的理念，
         这一条是数据筛选不是视图筛选，留在页面上但只宽屏显示） -->
    <div v-if="!narrow && tagOptions.length" class="bar row tagbar">
      <span class="t-3 label">标签</span>
      <button
        v-for="t in tagOptions.slice(0, 12)"
        :key="t.tag"
        class="tagchip"
        :class="{ on: activeTags.includes(t.tag) }"
        :aria-pressed="activeTags.includes(t.tag)"
        @click="toggleTag(t.tag)"
      >
        {{ t.tag }}<i>{{ t.count }}</i>
      </button>
      <button v-if="activeTags.length" class="tagchip clear" @click="activeTags = []">清除</button>
    </div>

    <!-- 分栏视图（Finder 式栏链）：不参与虚拟滚动与多选，点目录往右加一栏 -->
    <ColumnView
      v-if="prefs.viewMode === 'columns' && !trashMode && !archive"
      :path="path"
      :roots="landmarks"
      @navigate="navigate"
      @open="openItem"
    />

    <!-- 画廊只收图片/视频：把「还有 N 项没显示」说清楚，别让人以为文件丢了 -->
    <p v-if="prefs.viewMode === 'gallery' && galleryFiltered.hidden > 0" class="t-3 galnote">
      画廊只显示图片与视频；另有 {{ galleryFiltered.hidden }} 项在列表 / 网格视图里。
    </p>

    <div class="body" :class="{ withTree: prefs.showTree }">
      <!-- 目录树侧栏（可选）：宽屏在左，窄屏在列表上方（同一组件，两种摆法） -->
      <FolderTree
        v-if="prefs.showTree && !trashMode && !archive"
        :path="path"
        :roots="landmarks"
        @navigate="navigate"
      />

    <!-- 列表 / 网格 / 画廊（虚拟滚动） -->
    <section
      v-show="prefs.viewMode !== 'columns'"
      ref="scrollEl"
      class="scroll"
      :class="{ gridmode: (prefs.viewMode === 'grid' || prefs.viewMode === 'gallery') && !trashMode }"
      role="listbox"
      :aria-multiselectable="true"
      aria-label="文件列表"
      tabindex="0"
      @keydown="onKeydown"
      @pointerdown="onBandStart"
      @contextmenu.self.prevent="openMenu(null, $event.target as HTMLElement)"
      @dragover.self.prevent
      @drop.self.prevent="onDropOnPath(path, $event)"
    >
      <div class="pad" :style="{ height: `${vlist.totalPx.value}px` }" />

      <!-- 框选方框：内容坐标，跟着滚动一起走 -->
      <div
        v-if="marquee.rect.value"
        class="band"
        :style="{
          left: `${marquee.rect.value.left}px`,
          top: `${marquee.rect.value.top}px`,
          width: `${marquee.rect.value.width}px`,
          height: `${marquee.rect.value.height}px`,
        }"
        aria-hidden="true"
      />

      <div
        v-for="v in vlist.visible.value"
        :key="v.row.key"
        class="vrow"
        :style="{ transform: `translateY(${v.top}px)`, height: `${v.row.h}px` }"
      >
        <div v-if="v.row.data.kind === 'header'" class="ghead row">
          <span class="gh-label">{{ v.row.data.label }}</span>
          <span class="t-3 gh-count">{{ v.row.data.count }}</span>
        </div>

        <ul v-else-if="v.row.data.kind === 'item' && v.row.data.item" class="list">
          <FileRow
            :item="v.row.data.item"
            :selected="sel.has(v.row.data.item.id)"
            :focused="sel.isFocused(v.row.data.item.id)"
            :cut="clip.isCut(v.row.data.item.id)"
            :drag-over="dropTarget === v.row.data.item.id"
            :editing="editingId === v.row.data.item.id"
            :wide="wide && !trashMode"
            :columns="columns"
            :paste-target="clip.count.value > 0 && v.row.data.item.isDir"
            :touch="touch"
            :select-mode="selectMode"
            @activate="activate"
            @open="openItem"
            @menu="openMenu"
            @drag-start="onDragStart"
            @drag-end="onDragEnd"
            @drag-over="onDragOverRow"
            @drop="onDrop"
            @rename-commit="commitRename"
            @rename-cancel="editingId = null"
          />
        </ul>

        <div
          v-else-if="v.row.data.items"
          class="tiles"
          :style="{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }"
        >
          <FileTile
            v-for="it in v.row.data.items"
            :key="it.id"
            :item="it"
            :icon-size="effectiveIconSize"
            :selected="sel.has(it.id)"
            :focused="sel.isFocused(it.id)"
            :cut="clip.isCut(it.id)"
            :drag-over="dropTarget === it.id"
            :editing="false"
            :paste-target="clip.count.value > 0 && it.isDir"
            :touch="touch"
            :select-mode="selectMode"
            @activate="activate"
            @open="openItem"
            @menu="openMenu"
            @drag-start="onDragStart"
            @drag-end="onDragEnd"
            @drag-over="onDragOverRow"
            @drop="onDrop"
          />
        </div>
      </div>

      <p v-if="!rows.length && !loading" class="empty t-3">
        {{
          trashMode
            ? '回收站是空的'
            : navMode === 'recent'
              ? (recentLoading ? '正在读最近文件…' : '最近没有动过的文件')
              : keyword
                ? `当前目录没有名字含「${keyword}」的条目`
                : path
                  ? '此目录还没有文件'
                  : '工作区还是空的'
        }}
        <!-- 过滤无果时的出路就放在空态里：一句话说清「没有」，紧跟着一个动作 -->
        <button
          v-if="keyword && !globalHits && !trashMode"
          class="btn ghost tiny empty-esc"
          :disabled="searching"
          @click="runGlobalSearch"
        >
          {{ searching ? '搜索中…' : '在整个工作区找' }}
        </button>
      </p>
      <p v-if="loading" class="empty t-3">加载中…</p>
      <p v-if="errText" class="empty err">{{ errText }}</p>
    </section>
    </div>

    <!-- 操作进度 / 结果 -->
    <OpQueueBar
      :ops="queue.ops.value"
      :on-cancel="queue.cancel"
      :on-resume="(id) => void queue.resume(id).then(() => afterBatch())"
      :on-dismiss="queue.dismiss"
    />

    <!-- 同名冲突：问一次（可记住本次会话的选择） -->
    <ConflictPrompt
      v-if="pendingConflict"
      :label="pendingConflict.label"
      :names="pendingConflict.names"
      :total="pendingConflict.total"
      @choose="choosePolicy"
      @cancel="cancelPolicy"
    />

    <!-- 批量重命名：先预览再执行 -->
    <BatchRenamePanel
      v-if="batchOpen"
      :items="selectedItems"
      :sibling-names="ordered.filter((i) => !sel.has(i.id)).map((i) => i.name)"
      @apply="applyBatchRename"
      @close="batchOpen = false"
    />

    <!-- 详情（属性页的轻量版：常驻卡片，不弹窗） -->
    <section v-if="details" class="card detail">
      <div class="row dhead">
        <span class="flex-1"><b>{{ details.name }}</b></span>
        <button class="btn ghost tiny" @click="details = null">关闭</button>
      </div>
      <dl class="dgrid">
        <dt>路径</dt>
        <dd class="mono">{{ details.uri.split('://')[1] }}</dd>
        <dt>类型</dt>
        <dd>
          {{ details.isDir ? '文件夹' : kindLabel(details.kind) }}
          <template v-if="details.sourceType && details.sourceType !== 'note'">
            · {{ KB_SOURCE_LABELS[details.sourceType as KbSourceType] ?? details.sourceType }}
          </template>
        </dd>
        <dt>大小</dt>
        <dd>{{ details.isDir ? `${details.childCount} 项` : humanBytes(details.size ?? 0) }}</dd>
        <dt>修改</dt>
        <dd>{{ formatFullWhen(details.modifiedAt) || '—' }}</dd>
        <template v-if="details.occurredOn">
          <dt>业务日期</dt>
          <dd>{{ details.occurredOn }}</dd>
        </template>
        <dt>属性</dt>
        <!-- 三个状态互不相关，各给一枚胶囊：中性档承载读写权限，其余走语义色 -->
        <dd class="attrs">
          <template v-if="details.attributes.system">系统文件（只读）</template>
          <template v-else-if="details.attributes.readOnly">{{ details.readOnlyReason }}</template>
          <template v-else><StatusChip tone="neutral" size="sm">可读写</StatusChip></template>
          <template v-if="details.pinned">
            <StatusChip tone="accent" size="sm">已钉住</StatusChip>
          </template>
          <template v-if="details.classifyState">
            <StatusChip
              :tone="details.classifyState === 'manual' ? 'neutral' : 'warn'"
              size="sm"
            >
              {{
                details.classifyState === 'inbox'
                  ? '待归类'
                  : details.classifyState === 'filed'
                    ? '已归类'
                    : '手动放置'
              }}
            </StatusChip>
          </template>
        </dd>
      </dl>

      <dl v-if="detailRows.length" class="dgrid extra">
        <template v-for="r in detailRows" :key="r.label">
          <dt>{{ r.label }}</dt>
          <dd>{{ r.value }}</dd>
        </template>
      </dl>

      <!-- 用户元数据：只有真实文件有（派生投影没有可承载的行） -->
      <MetaEditor
        v-if="details.fileId !== undefined && !trashMode"
        :item="details"
        @changed="onMetaChanged"
      />
    </section>

    <!-- 状态栏：条目数 / 选中 / 体积。路径的唯一出处是面包屑，这里不再重印（recent 模式
         本就没有面包屑层级， Dock 上另有当前位置，删后不丢信息）。 -->
    <p v-if="!narrow" class="status t-3">
      <template v-if="trashMode">
        <span>回收站 · {{ trashItems.length }} 项</span>
      </template>
      <template v-else>
        <span><b class="num">{{ ordered.length }}</b> 项</span>
        <span v-if="sel.count.value" class="selnote">
          · 选中 <b class="num">{{ sel.count.value }}</b>（<span class="num">{{ humanBytes(selectedBytes) }}</span>）
        </span>
        <span v-if="listing?.truncated">· 目录过大，仅列出一部分</span>
      </template>
    </p>

    <!-- 底部悬浮 dock（手机端）：虚拟文件系统导航 + 按需出现的功能栏。
          Teleport 到 body：页面滚动层在超范围平移时带 transform，fixed 后代会跑位。 -->
    <Teleport to="body">
      <div v-if="narrow" class="fdock" :class="{ sel: selectMode }">
        <!-- 导航：最近文件 / 目录文件 -->
        <div v-if="!selectMode" class="fseg">
          <button
            type="button"
            class="fseg-b"
            :class="{ on: navMode === 'recent' }"
            :aria-pressed="navMode === 'recent'"
            @click="setNavMode('recent')"
          >
            <Clock :size="13" />
            最近文件
          </button>
          <button
            type="button"
            class="fseg-b"
            :class="{ on: navMode === 'dir' }"
            :aria-pressed="navMode === 'dir'"
            @click="setNavMode('dir')"
          >
            <FolderOpen :size="13" />
            目录文件
          </button>
        </div>

        <!-- 功能栏（多选态）：全选/全不选 + 复制/剪切/删除/更多，收尾「完成」 -->
        <div v-else class="facts">
          <button type="button" class="fact" @click="toggleSelectAll">
            <CheckCheck :size="15" />
            {{ allSelected ? '全不选' : '全选' }}
          </button>
          <button type="button" class="fact" :disabled="!dockCan.copy" @click="doCopy()">
            <Copy :size="15" />
            复制
          </button>
          <button type="button" class="fact" :disabled="!dockCan.cut" @click="doCut()">
            <Scissors :size="15" />
            剪切
          </button>
          <button type="button" class="fact danger" :disabled="!dockCan.del" @click="doTrash(selectedItems)">
            <Trash2 :size="15" />
            删除
          </button>
          <button
            v-if="sel.count.value"
            type="button"
            class="fact"
            @click="menuTargets = selectedItems; menuAnchor = null; menuOpen = true"
          >
            <MoreHorizontal :size="15" />
          </button>
          <button type="button" class="fact done" @click="exitSelectMode">完成</button>
        </div>
      </div>
    </Teleport>

    <!-- 菜单（bind 模式，各自锚定触发按钮/行） -->
    <AppMenu
      :open="menuOpen"
      :actions="menuActions"
      :anchor="menuAnchor"
      title="文件操作"
      @close="menuOpen = false"
      @select="onMenuSelect"
    />
    <AppMenu
      :open="addMenuOpen"
      :actions="addActions"
      :anchor="addBtn"
      title="添加"
      @close="addMenuOpen = false"
      @select="onAddSelect"
    />
    <AppMenu
      :open="sortMenuOpen"
      :actions="sortActions"
      :anchor="sortBtn"
      title="排序"
      @close="sortMenuOpen = false"
      @select="onSortSelect"
    />
    <AppMenu
      :open="groupMenuOpen"
      :actions="groupActions"
      :anchor="groupBtn"
      title="分组与显示"
      @close="groupMenuOpen = false"
      @select="onSortSelect"
    />
    <AppMenu
      :open="moreMenuOpen"
      :actions="narrow ? mobileMoreActions : moreActions"
      :anchor="moreBtn"
      title="更多"
      @close="moreMenuOpen = false"
      @select="onMoreMenuSelect"
    />

    <!-- dock 遮罩：给页面底部留出等量空白，最后一行不会被 dock 压住 -->
    <div v-if="narrow" class="fdock-space" aria-hidden="true" />
  </div>
</template>

<style scoped>
.fx {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
}

/* ---------- 手机端工具条：只留 上一步 / 搜索 / 添加 / 更多 ---------- */

/* 窄屏取消换行：四样东西必须一行装下，谁换行谁把列表顶出屏外 */
.bar.mbar {
  flex-wrap: nowrap;
  gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-8);
}

/* ---------- 底部悬浮 dock（虚拟文件系统导航 + 按需功能栏） ---------- */

/* 位置与 AI 页输入条同一套公式：让开底部 Dock 导航（--dock-top）+ 一点空气，
   别自己拼 safe-area / tabbar 高度。Teleport 到 body，所以这里等于视口底部。 */
.fdock {
  position: fixed;
  left: var(--page-pad-x);
  right: var(--page-pad-x);
  bottom: calc(var(--dock-top) + 10px + var(--wbar-reserve, 0px));
  z-index: 40;
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  min-height: 46px;
  padding: var(--sp-6);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--surface) 86%, transparent);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  box-shadow: var(--shadow-float);
  overflow-x: auto;
  scrollbar-width: none;
}

.fdock::-webkit-scrollbar {
  display: none;
}

/* 导航：最近文件 / 目录文件（分段胶囊） */
.fseg {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex: 1;
  min-width: 0;
  padding: var(--sp-4);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.fseg-b {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  min-width: 0;
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  white-space: nowrap;
}

.fseg-b.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-thumb);
}

/* 功能栏（多选态）：按需出现；选项多的时候横向滚，不换行挤成一团 */
.facts {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex: 1;
  min-width: 0;
}

.fact {
  flex: 1;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--gap-text);
  min-width: 44px;
  padding: var(--sp-6) var(--sp-4);
  border-radius: var(--radius-m);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  white-space: nowrap;
}

.fact:active {
  background: var(--surface-2);
}

/* 禁用浓度全站同一档（tokens.css），不再各写各的裸值 */
.fact:disabled {
  opacity: var(--disabled-opacity);
}

.fact.danger {
  color: var(--danger-strong);
}

.fact.done {
  flex: none;
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
}

/* 给 dock 留白：页面滚到底时最后一行不被压住。
   只加 dock 自身高度 + 间距 —— 页面自己的 --page-pad-bottom 已经让开了底部导航，
   这里再把 --dock-top 加一遍会让页面底部多出一屏空白。 */
.fdock-space {
  height: 68px;
}

/* 工具条：内部控件之间 8（无边界），外框内距 8 */
.bar {
  gap: var(--gap-sm);
  padding: var(--sp-8);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  flex-wrap: wrap;
}

.bar.sizing {
  padding: var(--sp-4) var(--sp-8);
}

/* 拖放规则收进行尾 InfoHint，工具条本身只留「图标」+ 小/中/大 */
.sizing-hint {
  margin-left: auto;
  display: inline-flex;
}

.label {
  font-size: var(--fs-caption);
}

.icon {
  position: relative;
  flex: none;
  padding: var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

/* 工具条图标钮：视觉 28×28（6px 内距 + 16px 图标）一个像素都不动，只把命中区撑到 44 高。
   横向各外扩 3px：同排钮之间只隔 5–6px（.mbar 5px），外扩多了会互相吃掉点击。 */
.icon::after {
  content: '';
  position: absolute;
  inset: -8px -3px;
}

/* 禁用浓度全站同一档（tokens.css），不再各写各的裸值 */
.icon:disabled {
  opacity: var(--disabled-opacity);
}

.icon.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.flip {
  transform: rotate(180deg);
}

.find {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex: 1;
  min-width: 150px;
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.find input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.find input::-webkit-search-cancel-button {
  display: none;
}

.clear {
  position: relative;
  flex: none;
  padding: var(--sp-2);
  border-radius: var(--radius-full);
  color: var(--text-2);
}

/* 清空搜索：13px 图标 + 2px 内距只有约 17px，是整条工具栏里最难点的钮。
   纵向撑到 33；向左外扩 6px（往右是 .find 的圆角边，再扩就出条了）。 */
.clear::after {
  content: '';
  position: absolute;
  inset: -8px -6px;
}

.seg {
  display: inline-flex;
  flex: none;
  padding: var(--sp-2);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.segb {
  position: relative;
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 分段钮自身只有约 23 高（图标 + 4px 内距）：纵向各扩 9px，
   连同 .seg 的 2px 内距，整块分段控件达到 44 —— 拇指不用瞄着图标按。 */
.segb::after {
  content: '';
  position: absolute;
  inset: -9px 0;
}

.segb.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-thumb);
}

.trash-entry .dot {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-full);
  background: var(--danger);
  color: var(--on-accent);
  /* 回收站项数：原为 9px，缩在任何一档缩放下都读不出来 —— 数字是这条的唯一信息量，
     提到 caption 一档，章子跟着从 14 长到 18 */
  font-size: var(--fs-caption);
  font-style: normal;
  font-weight: var(--fw-bold);
  line-height: 18px;
  text-align: center;
}

.hidden-input {
  display: none;
}

.newfolder {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-12);
}

.newfolder input {
  flex: 1;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}

.crumbs {
  gap: var(--gap-tight);
  flex-wrap: wrap;
}

.crumb {
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

/* 排序口径（按最近修改）与「最近文件」并列：一枚中性胶囊，不跟面包屑抢同一个字档 */
.crumb-sort {
  flex: none;
}

/* 「最近文件」行的提示组：排序胶囊 + InfoHint 同一组挂点，胶囊与帮助入口之间留缝 */
.crumb-note {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-8);
}

.crumb.cur {
  background: var(--accent-soft);
  /* soft 底上的文字走 --accent-strong（实底档 --accent 在该底上不足 4.5:1） */
  color: var(--accent-strong);
  font-weight: var(--fw-semibold);
}

.arcbar {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  padding: var(--sp-8) var(--sp-12);
  font-size: var(--fs-footnote);
}

.arcbar b {
  font-weight: var(--fw-semibold);
}

.arcbar small {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
}

/* 包内条目数是这一屏的读数：主档字 + 等宽，其余两项退成元数据 */
.arcbar .arc-num {
  font-size: var(--fs-callout);
  color: var(--text-1);
}

.arcbar .arc-sep {
  padding: 0 var(--sp-4);
}

.arcbar .arc-dim {
  font-size: var(--fs-caption);
}

.arc-fmt {
  flex: none;
  text-transform: uppercase;
}

.arcto {
  flex: none;
  width: 150px;
  min-height: var(--control-sm);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}

.tagbar {
  padding: var(--sp-4) var(--sp-8);
  gap: var(--gap-sm);
}

.tagchip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
}

.tagchip i {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.tagchip.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.tagchip.on i {
  color: var(--accent-strong);
}

.crumb.over {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

/* 横幅（回收站态）：条目仍占磁盘的结论 + 两个动作，同一行 flex */
.banner {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-8) var(--sp-12);
  font-size: var(--fs-footnote);
}

/* 分区标题：14 Semibold（工具条/列表里的小节标题），与行标题同档但靠上下留白分层 */
.sec {
  padding: var(--sp-10) 0 var(--sp-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.files-sec {
  padding: var(--sp-4) var(--sp-2) 0;
}

/* 地标卡片 */
.card.list {
  padding: var(--sp-6) var(--pad-card);
}

.item {
  width: 100%;
  text-align: left;
  gap: var(--gap-md);
  min-height: var(--row-h);
  padding: 0;
}

li + li .item {
  border-top: 0.5px solid var(--line);
}

.item b {
  display: block;
  font-size: var(--fs-body);
  font-weight: var(--fw-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item small {
  display: block;
  color: var(--text-2);
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fic {
  flex: none;
  color: var(--accent);
}

.count {
  flex: none;
  font-size: var(--fs-caption);
}

@media (hover: hover) {
  .item:hover {
    background: var(--surface-2);
    border-radius: var(--radius-m);
  }
}

/* 列头：与 FileRow 的列一一对应（行里图标 18 + gap 10 = 28 的缩进，这里用占位条对齐） */
.thead {
  gap: var(--gap-md);
  padding: 0 var(--sp-12);
  margin-bottom: calc(-1 * var(--sp-4));
  flex-wrap: nowrap;
}

.th-spacer {
  flex: none;
  width: 18px;
}

.th {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.th:disabled {
  opacity: 1;
}

.th.sortable:hover {
  color: var(--text-1);
}

.th.flex {
  flex: 1;
  min-width: 0;
  justify-content: flex-start;
}

.th.end {
  justify-content: flex-end;
}

.body {
  display: block;
}

/* 宽屏把目录树放左边，列表吃剩余宽度；窄屏树在上方（触屏竖排更适合上下看） */
.body.withTree {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: var(--sp-8);
  align-items: start;
}

@media (max-width: 640px) {
  .body.withTree {
    grid-template-columns: minmax(0, 1fr);
  }
  .body.withTree :deep(.tree) {
    width: auto;
    max-height: 220px;
  }
}

.galnote {
  padding: var(--sp-2) var(--sp-2) 0;
  font-size: var(--fs-caption);
}

/* 虚拟滚动容器 */
.scroll {
  position: relative;
  height: min(58vh, 540px);
  min-height: 220px;
  overflow: auto;
  overscroll-behavior: contain;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.scroll:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.pad {
  width: 100%;
}

/* 框选方框 */
.band {
  position: absolute;
  z-index: 2;
  border: 1px solid var(--accent);
  border-radius: var(--radius-xs);
  background: var(--accent-soft);
  pointer-events: none;
}

/* 框选时别让文字被拖蓝（拖拽中浏览器默认会选文本） */
.scroll.banding {
  user-select: none;
}

.vrow {
  position: absolute;
  inset-inline: 0;
  will-change: transform;
}

.list {
  height: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tiles {
  display: grid;
  gap: var(--gap-sm);
  height: 100%;
  padding: 0 var(--sp-8);
}

.ghead {
  align-items: center;
  gap: var(--gap-sm);
  height: 100%;
  padding: 0 var(--sp-12);
  border-top: 0.5px solid var(--line);
  background: var(--surface-2);
}

.gh-label {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.gh-count {
  font-size: var(--fs-caption);
}

.empty {
  position: absolute;
  inset-inline: 0;
  top: var(--sp-28);
  padding: 0 var(--pad-card);
  font-size: var(--fs-footnote);
  text-align: center;
}

.empty.err {
  color: var(--danger-strong);
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-tight) var(--gap-sm);
  padding: var(--sp-2) var(--sp-2) 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mono {
  font-family: ui-monospace, monospace;
  overflow-wrap: anywhere;
}

.detail {
  padding: var(--sp-12);
}

.dhead {
  align-items: center;
  gap: var(--gap-sm);
}

.dhead b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.dgrid {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: var(--gap-sm) var(--gap-md);
  margin-top: var(--gap-md);
  font-size: var(--fs-footnote);
}

.dgrid dt {
  color: var(--text-2);
}

.dgrid.extra {
  margin-top: var(--sp-6);
  padding-top: var(--sp-6);
  border-top: 0.5px solid var(--line);
}

.dgrid dd {
  color: var(--text-1);
  overflow-wrap: anywhere;
}

/* 「属性」行的三枚状态胶囊：互不相干，各占一个胶囊，不再用「·」串成一行平文 */
.dgrid dd.attrs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  align-items: center;
}

/* 过滤无果时的出路：跟着空态那句「没有」走，不再另起一张卡片说第二遍 */
.empty-esc {
  display: block;
  margin: var(--gap-md) auto 0;
}

/* 状态栏：条目数是主角，选中数是会变的次要项 */
.status .selnote {
  font-size: var(--fs-caption);
}

.btn.tiny {
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  font-size: var(--fs-caption);
}

/* ---------- 桌面（.desk-main 只在壳层 ≥ --desk-min 时渲染，所以这里不写断点）----------
   三处「手机尺寸直接搬过来」的硬伤在这里收，移动端一行也不碰。 */

/* 1 地标卡（根目录的工作区命名空间）：19 条单列排到 1240 高，把根目录文件整个挤出第一屏。
     桌面改三栏（每格约 350），名字与提示靠 .flex-1 的 min-width:0 + 自带 ellipsis 收尾。
     columns 会把 `li + li` 的分隔线一并搬到每栏第一条的头顶（第二、三栏各多一条悬空横线），
     所以桌面形态撤掉横线：栏间留白由 column-gap 给，行内靠行距 + hover 分层。 */
.desk-main .landmarks > ul {
  columns: 3;
  column-gap: var(--desk-gap);
}

.desk-main .landmarks > ul > li {
  break-inside: avoid;
}

.desk-main .landmarks .item {
  border-top: 0;
}

/* 2 列头钮：caption + 11px 箭头只有约 19 高，指针视口下够不着（MIN_TAP 24）。撑到 24 ——
     视觉只多出上下各 2.5 的空档，标签本身仍是居中一行。 */
.desk-main .th {
  min-height: 24px;
}

/* 3 目录搜索框：input 自身 19 高（--fs-subhead 的行高），撑到 24；
     .find 的内距不变，跟着长 5px —— 工具条是 flex 行，旁边没有定高的兄弟。 */
.desk-main .find input {
  min-height: 24px;
}
</style>
