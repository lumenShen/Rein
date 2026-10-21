<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronRight, Folder } from 'lucide-vue-next'

import { kbProvider } from '@/files/provider'
import type { FileItem } from '@/files/types'

/**
 * 目录树（侧栏）：只列目录，按需展开。
 *
 * 与列表的差别在**职责**：列表回答「这一层有什么」，树回答「我在哪、能去哪」——
 * 所以树里不显示文件（显示文件会让它在几十个条目后彻底失去导航价值）。
 *
 * 展开过的子目录缓存在 `children` 里，收起不清（再展开不重读）；但**当前路径所在的
 * 祖先链会自动展开**，所以从面包屑/深链进来时，树也会把当前位置亮出来。
 */
const props = defineProps<{
  /** 当前目录（'' = 根） */
  path: string
  /** 根层的名字与说明（工作区的命名空间） */
  roots?: readonly { name: string; hint: string }[]
}>()

const emit = defineEmits<{ navigate: [path: string] }>()

interface Node {
  name: string
  path: string
  count: number
}

const expanded = ref<Set<string>>(new Set(['']))
const children = ref<Map<string, Node[]>>(new Map())
const loading = ref<Set<string>>(new Set())

async function ensure(dir: string): Promise<void> {
  if (children.value.has(dir) || loading.value.has(dir)) return
  loading.value = new Set(loading.value).add(dir)
  try {
    const l = await kbProvider.listDir(dir)
    const dirs = l.items
      .filter((i) => i.isDir)
      .map((i) => ({ name: i.name, path: dirPath(i), count: i.childCount }))
    children.value = new Map(children.value).set(dir, dirs)
  } catch {
    children.value = new Map(children.value).set(dir, [])
  } finally {
    const next = new Set(loading.value)
    next.delete(dir)
    loading.value = next
  }
}

function dirPath(item: FileItem): string {
  return item.uri.split('://')[1] ?? item.name
}

/** 根层：命名空间（有说明的那批）+ 数据里真实存在的其他顶层目录 */
const rootNodes = computed<Node[]>(() => {
  const listed = children.value.get('') ?? []
  const known = new Set(props.roots?.map((r) => r.name) ?? [])
  const fromProps: Node[] = (props.roots ?? []).map((r) => ({
    name: r.name,
    path: r.name,
    count: listed.find((l) => l.name === r.name)?.count ?? 0,
  }))
  const extra = listed.filter((l) => !known.has(l.name))
  return [...fromProps, ...extra]
})

function toggle(dir: string): void {
  const next = new Set(expanded.value)
  if (next.has(dir)) next.delete(dir)
  else {
    next.add(dir)
    void ensure(dir)
  }
  expanded.value = next
}

/** 当前路径的祖先链全部展开（进来就能看到自己在哪） */
function revealCurrent(): void {
  if (!props.path) {
    void ensure('')
    return
  }
  const segs = props.path.split('/')
  const next = new Set(expanded.value)
  next.add('')
  for (let i = 1; i <= segs.length; i++) {
    const p = segs.slice(0, i).join('/')
    next.add(p)
    void ensure(p)
  }
  expanded.value = next
}

watch(() => props.path, revealCurrent, { immediate: true })
watch(
  () => props.roots?.length,
  () => void ensure(''),
)

/** 递归渲染用：某一层的子节点 */
function nodesOf(dir: string): Node[] {
  return dir === '' ? rootNodes.value : (children.value.get(dir) ?? [])
}

const depthOf = (p: string): number => (p ? p.split('/').length : 0)
</script>

<template>
  <aside class="tree" aria-label="目录树">
    <p class="head t-3">目录</p>
    <ul class="nodes">
      <li v-for="n in rootNodes" :key="n.path">
        <div class="row node" :class="{ cur: n.path === path }">
          <button class="twist" :aria-label="`展开 ${n.name}`" @click="toggle(n.path)">
            <ChevronRight :size="12" :class="{ open: expanded.has(n.path) }" />
          </button>
          <button class="label" :class="{ cur: n.path === path }" @click="emit('navigate', n.path)">
            <Folder :size="13" class="ic" />
            <span class="nm">{{ n.name }}</span>
            <i v-if="n.count" class="cnt">{{ n.count }}</i>
          </button>
        </div>
        <!-- 一层层往下画：目录树不深（治理上限 4 层），递归展开比虚拟化更划算 -->
        <ul v-if="expanded.has(n.path)" class="nodes">
          <li v-for="c in nodesOf(n.path)" :key="c.path">
            <div
              class="row node"
              :class="{ cur: c.path === path }"
              :style="{ paddingLeft: `${depthOf(c.path) * 10}px` }"
            >
              <button class="twist" :aria-label="`展开 ${c.name}`" @click="toggle(c.path)">
                <ChevronRight :size="12" :class="{ open: expanded.has(c.path) }" />
              </button>
              <button class="label" :class="{ cur: c.path === path }" @click="emit('navigate', c.path)">
                <Folder :size="13" class="ic" />
                <span class="nm">{{ c.name }}</span>
                <i v-if="c.count" class="cnt">{{ c.count }}</i>
              </button>
            </div>
            <!-- 第三层起用同一个递归片段（Vue 模板不能自引用，这里手写两层 + 后端深度上限 4） -->
            <ul v-if="expanded.has(c.path)" class="nodes">
              <li v-for="g in nodesOf(c.path)" :key="g.path">
                <div class="row node" :style="{ paddingLeft: `${depthOf(g.path) * 10}px` }">
                  <span class="twist" />
                  <button class="label" :class="{ cur: g.path === path }" @click="emit('navigate', g.path)">
                    <Folder :size="13" class="ic" />
                    <span class="nm">{{ g.name }}</span>
                  </button>
                </div>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.tree {
  flex: none;
  width: 190px;
  max-height: min(58vh, 540px);
  padding: var(--sp-8);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  overflow: auto;
}

.head {
  padding: var(--sp-2) var(--sp-6) var(--sp-8);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.nodes {
  margin: 0;
  padding: 0;
  list-style: none;
}

.node {
  align-items: center;
  gap: var(--gap-tight);
  border-radius: var(--radius-s);
}

.node.cur {
  background: var(--accent-soft);
}

.twist {
  flex: none;
  display: inline-flex;
  width: 16px;
  padding: var(--sp-2);
  color: var(--text-2);
}

.twist svg {
  transition: transform var(--dur-fast) var(--ease-standard);
}

.twist svg.open {
  transform: rotate(90deg);
}

.label {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex: 1;
  min-width: 0;
  min-height: var(--sp-32);
  padding: var(--sp-4) var(--sp-8);
  text-align: left;
  color: var(--text-1);
  font-size: var(--fs-callout);
}

.label.cur {
  color: var(--accent-strong);
  font-weight: var(--fw-semibold);
}

.ic {
  flex: none;
  color: var(--accent);
}

.nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cnt {
  flex: none;
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
}
</style>
