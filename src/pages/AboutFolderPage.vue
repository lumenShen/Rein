<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChevronRight, Folder, MoreHorizontal, SlidersHorizontal } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import PillChip from '@/components/common/PillChip.vue'
import FileIcon from '@/components/files/FileIcon.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ConstraintsSheet from '@/components/profile/ConstraintsSheet.vue'
import { groupByKey, type WorkspaceGroup, type WorkspaceNestedGroup } from '@/config/workspaceView'
import { toFileItem } from '@/files/provider'
import { formatWhen, kindLabel } from '@/files/sort'
import type { FileItem } from '@/files/types'
import { kbService } from '@/services/kbService'
import { useNutritionStore } from '@/stores/nutrition'
import {
  KB_SOURCE_LABELS,
  type KbDirListing,
  type KbEntry,
  type KbSourceType,
} from '@/types'
import { bmiOf } from '@/utils/health'

/**
 * 文件夹详情（`/me/folder?key=<分组>&path=<可选物理路径>`）。
 *
 * 这是「关于你」的分组投影，不是新的文件管理器：
 * - 分组根：对 `group.sources` 逐个 `kb_list_dir`，合并去重后按「目录在前、最近更新在前」排列；
 * - `path`：只允许落在当前分组的物理 root 之内（不是安全边界，只是防止 URL 把人带到投影之外），
 *   面包屑逐级可回；
 * - 健康分组在根层先给「体测 / 运动 / 方案」三张二级分组卡，再给合并文件；
 * - 写操作一律不在本页：改内容回对应页面，或在文件管理器里打开。
 *
 * 点击文件跳到文件管理器的 `?path=` 深链（阅读器在那边打开）；点击目录在同页下钻。
 * 列表数据只认 `KbEntry`；`FileItem` 只喂 `FileIcon`（它没有 path / system）。
 */

const route = useRoute()
const router = useRouter()
const n = useNutritionStore()

const key = computed(() => (typeof route.query.key === 'string' ? route.query.key : ''))
const group = computed<WorkspaceGroup | undefined>(() => groupByKey(key.value))

const rawPath = computed(() => {
  const raw = route.query.path
  return typeof raw === 'string' ? raw.replace(/^\/+|\/+$/g, '') : ''
})

/** 路径必须落在当前分组的物理 root 内；否则按「不在这个文件夹里」处理。 */
const pathValid = computed(() => {
  const g = group.value
  if (!rawPath.value) return true
  if (!g) return false
  // `..` 会被 kb_list_dir 直接拒绝；先在投影层挡掉，避免把畸形 URL 读成「读取失败」
  if (rawPath.value.split('/').includes('..')) return false
  return g.sources.some(
    (root) => rawPath.value === root || rawPath.value.startsWith(`${root}/`),
  )
})

const currentPath = computed(() => (pathValid.value ? rawPath.value : ''))

const title = computed(() => {
  const g = group.value
  if (!g) return '文件夹'
  if (!currentPath.value) return g.title
  return currentPath.value.split('/').pop() ?? g.title
})

/* ============================================================
   数据
   ============================================================ */

interface FolderRow {
  entry: KbEntry
  /** 只喂 FileIcon —— 不要拿它做导航 / 权限 / 时间判断 */
  iconItem: FileItem
  path: string
  isDir: boolean
  updatedMs?: number
  /** 行副标（来源 · 时间）—— 列表构建时算一次，模板里别再逐次拼 */
  meta: string
  /** 嵌套目录里的父路径提示（根层为空） */
  hint: string
}

type Filter = 'all' | 'folder' | 'file'

const rows = ref<FolderRow[]>([])
const loading = ref(true)
const error = ref('')
const truncated = ref(false)
/** 分组根各物理 root 的直接子项数（健康二级卡用） */
const sourceCounts = ref<ReadonlyMap<string, number>>(new Map())
const excerpts = ref<ReadonlyMap<string, string>>(new Map())

const filter = ref<Filter>('all')
const filterOpen = ref(false)
const moreOpen = ref(false)
const constraintsOpen = ref(false)
const profileReady = ref(n.profile !== null)

const FILTER_ACTIONS = [
  { label: '全部', value: 'all' },
  { label: '文件夹', value: 'folder' },
  { label: '文件', value: 'file' },
]

const MORE_ACTIONS = [{ label: '在文件管理器中打开', value: 'files' }]

const visibleRows = computed(() =>
  filter.value === 'all'
    ? rows.value
    : rows.value.filter((row) => (filter.value === 'folder' ? row.isDir : !row.isDir)),
)

const subtitle = computed<string | undefined>(() => {
  if (!group.value) return undefined
  if (loading.value || error.value) return '—'
  return `${visibleRows.value.length} 项`
})

const nestedGroups = computed<readonly WorkspaceNestedGroup[]>(() =>
  currentPath.value || !pathValid.value ? [] : (group.value?.nested ?? []),
)

const showHealthPanel = computed(
  () => group.value?.key === 'health' && !currentPath.value && pathValid.value,
)

const bmiText = computed(() => {
  const bmi = bmiOf(n.profile?.weightKg ?? null, n.profile?.heightCm ?? null)
  return bmi == null ? '' : bmi.toFixed(1)
})

/* ---------- 面包屑 ---------- */

interface Crumb {
  label: string
  path: string
}

const crumbs = computed<Crumb[]>(() => {
  const g = group.value
  if (!g || !currentPath.value) return []
  const out: Crumb[] = [{ label: g.title, path: '' }]
  let acc = ''
  for (const seg of currentPath.value.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg
    out.push({ label: seg, path: acc })
  }
  return out
})

/* ---------- 加载 ---------- */

let loadSeq = 0
let excerptSeq = 0

function compareRows(a: FolderRow, b: FolderRow): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const at = a.updatedMs ?? -1
  const bt = b.updatedMs ?? -1
  if (at !== bt) return bt - at
  return a.entry.name.localeCompare(b.entry.name, 'zh')
}

async function ensureProfile(): Promise<void> {
  if (profileReady.value) return
  try {
    await n.loadProfile()
    profileReady.value = n.profile !== null
  } catch (e) {
    console.warn('[about-folder] 身体资料读取失败', e)
  }
}

/**
 * 文件卡摘要：最多看前 8 个文本文件，每个取 `kb_read('l1')` 的首块截 120 字。
 * 摘要不是必须项 —— 任何一个失败都静默留空，不拖慢列表、不弹错。
 * 超过 8 个的文件只显示来源 / 时间（列表仍然是完整的）。
 *
 * 排队节奏：等首屏空闲再开工（`requestIdleCallback`），并发 2 —— 摘要要发最多 8 次
 * `kb_read`，和列表同时发会挤在同一个 IPC / DB 锁上；而它只是补充信息，晚一两帧
 * 出现完全不影响阅读。
 */
const EXCERPT_LIMIT = 8
const EXCERPT_CHARS = 120
const EXCERPT_WORKERS = 2

/** 空闲时执行；不支持 requestIdleCallback 的 WebView 退回一个短延时。 */
function whenIdle(run: () => void): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  }).requestIdleCallback
  if (ric) ric(run, { timeout: 800 })
  else window.setTimeout(run, 120)
}

async function loadExcerpts(list: FolderRow[], seq: number): Promise<void> {
  const my = ++excerptSeq
  const targets = list
    .filter((row) => !row.isDir && row.entry.kind === 'text')
    .slice(0, EXCERPT_LIMIT)
  if (!targets.length) {
    excerpts.value = new Map()
    return
  }
  const found = new Map<string, string>()
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      if (my !== excerptSeq || seq !== loadSeq) return
      const row = targets[cursor++]
      try {
        let text = ''
        if (row.entry.id > 0) {
          const doc = await kbService.read(row.entry.id, 'l1')
          text = doc.chunks[0]?.text ?? ''
        } else if (row.entry.fileId) {
          const file = await kbService.fileGet(row.entry.fileId)
          text = file.content
        }
        const clean = text.replace(/\s+/g, ' ').trim()
        if (clean) found.set(row.path, clean.slice(0, EXCERPT_CHARS))
      } catch {
        /* 摘要可选，失败静默 */
      }
    }
  }
  await Promise.all(
    Array.from({ length: EXCERPT_WORKERS }, () => worker()),
  )
  if (my === excerptSeq && seq === loadSeq) excerpts.value = found
}

async function load(): Promise<void> {
  const g = group.value
  const seq = ++loadSeq
  error.value = ''
  truncated.value = false
  excerpts.value = new Map()
  sourceCounts.value = new Map()
  excerptSeq++

  if (!g || !pathValid.value) {
    rows.value = []
    loading.value = false
    return
  }

  if (g.key === 'health') void ensureProfile()

  loading.value = true
  try {
    let listings: KbDirListing[] = []
    if (currentPath.value) {
      listings = [await kbService.listDir(currentPath.value)]
    } else {
      const results = await Promise.allSettled(
        g.sources.map((source) => kbService.listDir(source)),
      )
      const counts = new Map<string, number>()
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          listings.push(result.value)
          counts.set(g.sources[i], result.value.entries.length)
        }
      })
      if (!listings.length) {
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        throw failed?.reason ?? new Error('工作区目录读取失败')
      }
      sourceCounts.value = counts
    }
    if (seq !== loadSeq) return

    truncated.value = listings.some((listing) => listing.truncated)

    const byPath = new Map<string, KbEntry>()
    for (const listing of listings) {
      for (const entry of listing.entries) byPath.set(entry.path, entry)
    }
    const list: FolderRow[] = [...byPath.values()].map((entry) => {
      const iconItem = toFileItem(entry)
      const isDir = entry.kind === 'folder'
      const updatedMs = iconItem.modifiedAt
      return {
        entry,
        iconItem,
        path: entry.path,
        isDir,
        updatedMs,
        meta: rowMetaOf(entry, isDir, updatedMs),
        hint: rowHintOf(entry.path, isDir),
      }
    })
    list.sort(compareRows)
    rows.value = list
    // 列表先落地（首屏行立刻可读），摘要等这一帧画完再去排队
    whenIdle(() => {
      if (seq === loadSeq) void loadExcerpts(list, seq)
    })
  } catch (e) {
    if (seq !== loadSeq) return
    rows.value = []
    error.value = '读取工作区失败'
    console.warn('[about-folder] 目录读取失败', e)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(
  () => [group.value?.key ?? '', currentPath.value, pathValid.value] as const,
  () => {
    filter.value = 'all'
    void load()
  },
  { immediate: true },
)

/* ---------- 行操作 ---------- */

function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : ''
}

function sourceLabel(entry: KbEntry): string {
  const type = entry.sourceType
  if (type && type in KB_SOURCE_LABELS) return KB_SOURCE_LABELS[type as KbSourceType]
  return kindLabel(entry.kind)
}

function rowMetaOf(entry: KbEntry, isDir: boolean, updatedMs?: number): string {
  if (isDir) return `${entry.childCount} 项`
  const parts = [sourceLabel(entry)]
  const when = formatWhen(updatedMs)
  if (when) parts.push(when)
  return parts.join(' · ')
}

/** 只在嵌套目录里显示父路径（根层 `用户记忆/` 这种与面包屑重复）。 */
function rowHintOf(path: string, isDir: boolean): string {
  if (isDir) return ''
  const parent = parentPath(path)
  return parent.includes('/') ? parent : ''
}

function rowExcerpt(row: FolderRow): string {
  return excerpts.value.get(row.path) ?? ''
}

/** 文件卡的稳定 testid：优先 docId（阅读器 id），纯文件节点回退 fileId。 */
function fileTestId(row: FolderRow): string | undefined {
  if (row.isDir) return undefined
  const id = row.entry.id > 0 ? row.entry.id : row.entry.fileId
  return id ? `about-file-${id}` : undefined
}

function openRow(row: FolderRow): void {
  if (row.isDir) {
    goPath(row.path)
    return
  }
  void router.push({ name: 'ai-files', query: { path: row.path } })
}

function goPath(target: string): void {
  const g = group.value
  if (!g) return
  void router.push({
    name: 'me-folder',
    query: target ? { key: g.key, path: target } : { key: g.key },
  })
}

function managerPath(): string {
  return currentPath.value || group.value?.sources[0] || ''
}

function openInManager(): void {
  const dir = managerPath()
  void router.push({ name: 'ai-files', query: dir ? { dir } : {} })
}

function goUpload(): void {
  void router.push({ name: 'ai-files', query: { upload: '1' } })
}

function goHealthData(): void {
  void router.push({ name: 'settings-health' })
}

function openConstraints(): void {
  if (!profileReady.value) return
  constraintsOpen.value = true
}

function onFilter(value: string): void {
  filter.value = value === 'folder' || value === 'file' ? value : 'all'
}

function onMore(value: string): void {
  if (value === 'files') openInManager()
}

function nestedCount(nested: WorkspaceNestedGroup): number {
  return nested.sources.reduce(
    (sum, source) => sum + (sourceCounts.value.get(source) ?? 0),
    0,
  )
}

function nestedCountText(nested: WorkspaceNestedGroup): string {
  if (loading.value) return ''
  if (error.value) return '— 项'
  return `${nestedCount(nested)} 项`
}
</script>

<template>
  <div class="page" data-testid="about-folder-page" :data-group-key="group?.key">
    <PageHeader :title="title" :subtitle="subtitle" back>
      <template v-if="group" #action>
        <button
          class="hdr-btn"
          data-testid="about-folder-filter"
          aria-label="筛选"
          @click="filterOpen = true"
        >
          <SlidersHorizontal :size="17" />
        </button>
        <button
          class="hdr-btn"
          data-testid="about-folder-more"
          aria-label="更多"
          @click="moreOpen = true"
        >
          <MoreHorizontal :size="17" />
        </button>
      </template>
    </PageHeader>

    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <div v-if="!group" class="card d-full state" data-testid="about-folder-empty">
        <p class="stitle">没有这个文件夹</p>
        <p class="scopy">它可能已经被移走，或者链接不完整。</p>
        <PillChip as="button" tone="action" @click="router.replace('/me')">
          回到关于你
        </PillChip>
      </div>

      <template v-else>
        <!-- 面包屑：分组根可点回合并视图，其余逐级回；当前层不可点 -->
        <nav v-if="crumbs.length" class="crumbs" data-testid="about-folder-crumb" aria-label="当前路径">
          <ol class="crumb-list" data-testid="about-breadcrumb">
            <li v-for="(crumb, i) in crumbs" :key="crumb.path || 'root'">
              <button
                v-if="i < crumbs.length - 1"
                class="crumb"
                @click="goPath(crumb.path)"
              >
                {{ crumb.label }}
              </button>
              <span v-else class="crumb current" aria-current="page">{{ crumb.label }}</span>
              <ChevronRight
                v-if="i < crumbs.length - 1"
                :size="12"
                class="crumb-sep"
                aria-hidden="true"
              />
            </li>
          </ol>
        </nav>

        <!-- 健康分组：身体数据与授权的两个真实入口 -->
        <section v-if="showHealthPanel" class="card hpanel d-full">
          <button
            class="hrow"
            data-testid="about-folder-constraints"
            :disabled="!profileReady"
            @click="openConstraints"
          >
            <span class="hrow-main">
              <b>身体数据与训练约束</b>
              <em v-if="bmiText">BMI {{ bmiText }}</em>
              <em v-else>{{ profileReady ? '还没填身体数据' : '正在读取资料…' }}</em>
            </span>
            <span class="hrow-action">{{ profileReady ? '编辑' : '稍候' }}</span>
            <ChevronRight :size="14" class="t-3" />
          </button>
          <button class="hrow" data-testid="about-folder-health-auth" @click="goHealthData">
            <span class="hrow-main">
              <b>健康数据授权</b>
              <em>仅 Android 有 Health Connect</em>
            </span>
            <ChevronRight :size="14" class="t-3" />
          </button>
        </section>

        <!-- 健康分组根层：先给三个物理二级分组 -->
        <div v-if="nestedGroups.length" class="nested">
          <button
            v-for="(nested, i) in nestedGroups"
            :key="nested.title"
            class="card ncard"
            :data-testid="`about-nested-${i}`"
            @click="goPath(nested.sources[0] ?? '')"
          >
            <Folder :size="20" class="n-ic" />
            <b>{{ nested.title }}</b>
            <span class="nmeta num">
              <span v-if="loading" class="skel nskel" aria-hidden="true" />
              <template v-else>{{ nestedCountText(nested) }}</template>
            </span>
          </button>
        </div>

        <div class="entries" data-testid="about-folder-list">
          <template v-if="loading">
            <div v-for="i in 3" :key="i" class="card entry skel-entry" aria-hidden="true">
              <span class="skel skel-icon" />
              <span class="skel skel-line" />
            </div>
          </template>

          <div v-else-if="error" class="card state" data-testid="about-folder-error">
            <p class="stitle">读取工作区失败</p>
            <p class="scopy">文件还在，只是这次没读到。</p>
            <PillChip as="button" tone="action" @click="load">重试</PillChip>
          </div>

          <div v-else-if="!visibleRows.length" class="card state" data-testid="about-folder-empty">
            <template v-if="rows.length">
              <p class="stitle">没有{{ filter === 'folder' ? '文件夹' : '文件' }}</p>
              <p class="scopy">这个文件夹里的其它条目被筛选藏起来了。</p>
              <PillChip as="button" tone="muted" @click="filter = 'all'">显示全部</PillChip>
            </template>
            <template v-else-if="!pathValid">
              <p class="stitle">这个目录不在「{{ group.title }}」里</p>
              <p class="scopy">它可能已经被移动或删除。</p>
              <PillChip as="button" tone="action" @click="goPath('')">
                回到{{ group.title }}
              </PillChip>
            </template>
            <template v-else-if="currentPath">
              <p class="stitle">空文件夹</p>
              <p class="scopy">这个目录下还没有文件。</p>
              <PillChip as="button" tone="muted" @click="openInManager">
                在文件管理器中打开
              </PillChip>
            </template>
            <template v-else>
              <p class="stitle">这里还没有内容</p>
              <p class="scopy">上传资料，或和 Rein 聊聊 —— 它会按内容归类到这里。</p>
              <div class="sbtns">
                <PillChip as="button" tone="action" @click="goUpload">上传文件</PillChip>
                <PillChip as="button" tone="muted" @click="openInManager">
                  打开文件管理器
                </PillChip>
              </div>
            </template>
          </div>

          <template v-else>
            <button
              v-for="(row, i) in visibleRows"
              :key="row.path"
              class="card entry"
              :data-testid="`about-folder-item-${i}`"
              :data-item-id="row.path"
              @click="openRow(row)"
            >
              <FileIcon :item="row.iconItem" :size="34" />
              <span class="ecol">
                <span class="etop">
                  <b class="ename" :data-testid="fileTestId(row)">{{ row.entry.name }}</b>
                  <PillChip v-if="row.entry.system" tone="muted" size="sm">只读</PillChip>
                </span>
                <span class="emeta num">
                  {{ row.meta
                  }}<template v-if="row.hint"> · {{ row.hint }}</template>
                </span>
                <span v-if="rowExcerpt(row)" class="eexcerpt">{{ rowExcerpt(row) }}</span>
              </span>
              <ChevronRight :size="16" class="t-3" />
            </button>
          </template>
        </div>

        <p v-if="truncated && !loading && !error" class="trunc">
          只显示前 {{ visibleRows.length }} 项 ·
          <button class="trunc-link" @click="openInManager">在文件管理器中查看全部</button>
        </p>
      </template>
    </div>

    <ActionSheet
      :open="filterOpen"
      title="筛选"
      :actions="FILTER_ACTIONS"
      @select="onFilter"
      @close="filterOpen = false"
    />
    <ActionSheet
      :open="moreOpen"
      title="更多"
      :actions="MORE_ACTIONS"
      @select="onMore"
      @close="moreOpen = false"
    />
    <ConstraintsSheet :open="constraintsOpen" @close="constraintsOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 面包屑 ---------- */

.crumbs {
  margin-bottom: var(--gap-sm);
}

.crumb-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gap-tight);
  list-style: none;
}

.crumb-list li {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  min-width: 0;
}

.crumb {
  min-height: var(--hit-min);
  padding: 0 var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--accent-strong);
  white-space: nowrap;
}

.crumb.current {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

.crumb-sep {
  flex: none;
  color: var(--text-3);
}

/* ---------- 健康附加行 ---------- */

.hpanel {
  margin-bottom: var(--gap-md);
  display: flex;
  flex-direction: column;
}

.hrow {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h-double);
  padding: 0;
  text-align: left;
  font: inherit;
  color: inherit;
}

.hrow + .hrow {
  border-top: 0.5px solid var(--line);
}

.hrow:active {
  transform: none;
  background: var(--surface-inset);
}

.hrow:disabled {
  opacity: 0.6;
}

.hrow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.hrow-main b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.hrow-main em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.hrow-action {
  flex: none;
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--accent-strong);
}

/* ---------- 健康二级分组 ---------- */

.nested {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap-sm);
  margin-bottom: var(--gap-md);
}

.ncard {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-tight);
  min-width: 0;
  padding: var(--pad-card-tight);
  text-align: left;
  font: inherit;
  color: inherit;
}

.ncard:active {
  background: var(--surface-2);
}

.n-ic {
  color: var(--mod-program-strong);
}

.ncard b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.nmeta {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.nskel {
  display: inline-block;
  width: var(--sp-40);
  height: var(--sp-10);
}

/* ---------- 条目 ---------- */

.entries {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.entries > .card + .card {
  margin-top: 0;
}

.entry {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  min-width: 0;
  min-height: var(--row-h-double);
  padding: var(--pad-card-tight) var(--pad-card);
  text-align: left;
  font: inherit;
  color: inherit;
  /* 长目录一次挂全部行（生产库「Rein 的角落」实测 184 项）。离屏行跳过布局与绘制，
     滚动时不再为看不见的卡片付排版钱；`auto` 记住渲染过一次的真实高度，
     不会因为占位高度猜小了而抖动。 */
  content-visibility: auto;
  contain-intrinsic-size: auto var(--row-h-double);
}

.entry:active {
  background: var(--surface-2);
}

.ecol {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.etop {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-width: 0;
}

.ename {
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.emeta {
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.eexcerpt {
  font-size: var(--fs-caption);
  line-height: 1.45;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* ---------- 骨架 / 空态 / 错误 ---------- */

.skel {
  display: block;
  border-radius: var(--radius-xs);
  background: var(--surface-2);
}

.skel-entry {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  min-height: var(--row-h-double);
}

.skel-icon {
  width: var(--control-icon);
  height: var(--control-icon);
  flex: none;
  border-radius: var(--radius-s);
}

.skel-line {
  flex: 1;
  height: var(--sp-12);
}

.state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-sm);
}

.stitle {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.scopy {
  font-size: var(--fs-subhead);
  line-height: 1.5;
  color: var(--text-2);
}

.sbtns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  margin-top: var(--gap-tight);
}

.trunc {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.trunc-link {
  min-height: var(--hit-min);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--accent-strong);
}

/* ---------- 桌面：条目两栏（手机单列由上面的 flex 承担） ---------- */

:global(.desk-main) .entries {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--desk-gap);
  align-items: stretch;
}

/* 空态 / 错误态是整段说明，不该被切成半栏 */
:global(.desk-main) .entries > .state {
  grid-column: 1 / -1;
}
</style>
