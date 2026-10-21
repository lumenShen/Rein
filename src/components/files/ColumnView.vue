<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRight, File as FileGeneric, FileText, Folder, Image as ImageIcon } from 'lucide-vue-next'

import { kbProvider } from '@/files/provider'
import { naturalCompare } from '@/files/sort'
import type { FileItem } from '@/files/types'
import { humanBytes } from '@/utils/format'

/**
 * 分栏视图（Finder 那套）：从根到当前目录一条栏链，点目录往右加一栏、点文件交给宿主。
 *
 * 与列表的关系：**它不是另一个列表**，而是「路径的横向展开」——
 * 左边每一栏都留着来路，所以「从 A 跳到隔壁 B」不需要先回上一级。
 * 因此它自己持有每一栏的列举结果（`panes`），并跟着外部的 `path` 增删栏。
 *
 * 选择/多选/拖放不在这一视图里做（那是列表与网格的活）：分栏的用途是「快速穿目录」，
 * 要批量操作切回列表即可 —— 少一层「每种视图都得实现一遍多选」的复杂度。
 */
const props = defineProps<{
  /** 当前目录（'' = 根） */
  path: string
  /** 根层的名字（工作区命名空间） */
  roots?: readonly { name: string; hint: string }[]
}>()

const emit = defineEmits<{
  navigate: [path: string]
  open: [item: FileItem]
}>()

interface Pane {
  path: string
  items: FileItem[]
}

/** 栏链：第 0 栏是根，其后依次是路径的每一级 */
const panes = ref<Pane[]>([])
const busy = ref(false)

function dirPath(item: FileItem): string {
  return item.uri.split('://')[1] ?? item.name
}

/** 根栏：命名空间按顺序排在真实目录前面（与地标卡同一套心智模型） */
function orderRoot(items: FileItem[]): FileItem[] {
  const order = props.roots?.map((r) => r.name) ?? []
  const dirs = items.filter((i) => i.isDir).sort((a, b) => {
    const ia = order.indexOf(a.name)
    const ib = order.indexOf(b.name)
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
    return naturalCompare(a.sortName, b.sortName)
  })
  const files = items.filter((i) => !i.isDir).sort((a, b) => naturalCompare(a.sortName, b.sortName))
  return [...dirs, ...files]
}

async function loadPane(dir: string): Promise<FileItem[]> {
  const l = await kbProvider.listDir(dir)
  return dir === '' ? orderRoot(l.items) : l.items
}

async function sync(): Promise<void> {
  busy.value = true
  try {
    const segs = props.path ? props.path.split('/') : []
    const wanted = ['', ...segs.map((_, i) => segs.slice(0, i + 1).join('/'))]
    const next: Pane[] = []
    for (const p of wanted) {
      // 已有的栏不重读（切目录时左边那些栏的内容没变）
      const old = panes.value.find((x) => x.path === p)
      next.push(old ?? { path: p, items: await loadPane(p) })
    }
    panes.value = next
  } finally {
    busy.value = false
  }
}

onMounted(() => void sync())
watch(() => props.path, () => void sync())

/** 每一栏只显示「下一级是否被选中」：子项是目录且当前路径以它开头 */
function isOnPath(item: FileItem): boolean {
  const p = dirPath(item)
  return props.path === p || props.path.startsWith(`${p}/`)
}

const activePane = computed(() => panes.value.length - 1)

function pick(item: FileItem): void {
  if (item.isDir) {
    emit('navigate', dirPath(item))
    return
  }
  emit('open', item)
}

function iconOf(item: FileItem) {
  if (item.isDir) return Folder
  if (item.kind === 'image') return ImageIcon
  if (item.kind === 'text') return FileText
  return FileGeneric
}
</script>

<template>
  <div class="cols" :class="{ busy }">
    <section v-for="(pane, i) in panes" :key="pane.path || 'root'" class="pane" :class="{ deep: i > 0 }">
      <p v-if="i === 0" class="pt t-3">根目录</p>
      <p v-else class="pt t-3">{{ pane.path.split('/').pop() }}</p>
      <ul class="list">
        <li v-for="it in pane.items" :key="it.id">
          <button
            class="row item"
            :class="{ on: isOnPath(it), file: !it.isDir, cur: i === activePane && it.isDir }"
            @click="pick(it)"
          >
            <component :is="iconOf(it)" :size="14" class="ic" />
            <span class="nm">{{ it.displayName }}</span>
            <!-- 大小列与 FileRow 同一套数字口径：等宽数字，位数不齐也不再左右跳 -->
            <span v-if="!it.isDir && it.size !== undefined" class="sz t-3 num">{{ humanBytes(it.size) }}</span>
            <ChevronRight v-if="it.isDir" :size="13" class="t-3" />
          </button>
        </li>
        <li v-if="!pane.items.length" class="t-3 empty">空</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* 列间距 8、外框内距 8：分栏浏览器的栏与栏之间只隔一道线，不该有缝 */
.cols {
  display: flex;
  gap: var(--gap-sm);
  height: min(58vh, 540px);
  min-height: 240px;
  overflow-x: auto;
  overflow-y: hidden;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  padding: var(--sp-8);
}

.busy {
  opacity: 0.72;
}

.pane {
  flex: none;
  display: flex;
  flex-direction: column;
  width: 196px;
  max-height: 100%;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  overflow: hidden;
}

.pane.deep {
  background: var(--surface);
  box-shadow: inset 0 0 0 0.5px var(--line);
}

.pt {
  padding: var(--sp-8) var(--sp-8) var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.list {
  flex: 1;
  margin: 0;
  padding: 0 var(--sp-4) var(--sp-8);
  list-style: none;
  overflow: auto;
}

.item {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  width: 100%;
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-s);
  text-align: left;
  color: var(--text-1);
  font-size: var(--fs-caption);
}

/* 悬停只在真悬停设备生效：触屏点一下也会留下 :hover 底色 */
@media (hover: hover) {
  .item:hover {
    background: var(--surface-2);
  }

  .pane.deep .item:hover {
    background: var(--surface-2);
  }
}

.item.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

/* transform:none 显式关掉全局 button:active 的 scale —— 分栏行是横条，
   缩回去会压扁行内文字 */
.item:active {
  background: var(--surface-2);
  transform: none;
}

.item.file {
  color: var(--text-2);
}

.ic {
  flex: none;
  color: var(--accent);
}

.item.file .ic {
  color: var(--text-2);
}

.nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sz {
  flex: none;
  font-size: var(--fs-caption);
}

.empty {
  padding: var(--sp-8);
  font-size: var(--fs-caption);
}
</style>
