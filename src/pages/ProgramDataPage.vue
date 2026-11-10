<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Database } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import { PROGRAM_DATA_ROOTS } from '@/config/workspaceView'
import { kbService } from '@/services/kbService'

/**
 * 程序数据（`/me/program`）。
 *
 * 「关于你」主页按**生活主题**分组；这页按**物理顶层目录**读同一批工作区数据：
 * 系统提示词 / 规范 / 课程 / 食物 / 菜单等配置，以及日程 / 运动 / 记忆等派生投影。
 * 两份视图有意重叠，不是两份数据。
 *
 * 13 行配置永远渲染（目录当前不存在时计数 0），入口不随数据有无而跳动；
 * 点击直接进文件管理器的对应目录，本页不做写操作。
 */

const router = useRouter()

const counts = ref<ReadonlyMap<string, number>>(new Map())
const loading = ref(true)
const error = ref('')

const empty = computed(() => !loading.value && !error.value && counts.value.size === 0)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const listing = await kbService.listDir('')
    const map = new Map<string, number>()
    for (const entry of listing.entries) map.set(entry.name, entry.childCount)
    counts.value = map
  } catch (e) {
    error.value = '读不到目录清单'
    console.warn('[program] kb_list_dir 读取失败', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

function countOf(root: string): number {
  return counts.value.get(root) ?? 0
}

function countText(root: string): string {
  if (error.value) return '— 项'
  return `${countOf(root)} 项`
}

function openDir(root: string): void {
  void router.push({ name: 'ai-files', query: { dir: root } })
}

function openManager(): void {
  void router.push({ name: 'ai-files' })
}
</script>

<template>
  <div class="page" data-testid="program-data-page">
    <PageHeader title="程序数据" back />

    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <section class="card d-full intro" data-testid="program-data-intro">
        <p>
          这些是 Rein 根据你的数据自动生成的投影，以及系统自带的只读文件。
          AI 会查阅，你一般不需要修改；要改内容请回到对应页面。
        </p>
      </section>

      <div class="dirs">
        <button
          v-for="root in PROGRAM_DATA_ROOTS"
          :key="root.id"
          class="card dir"
          :data-testid="`program-data-row-${root.id}`"
          @click="openDir(root.root)"
        >
          <span class="fic"><Database :size="18" /></span>
          <span class="col copy">
            <span class="ttl">
              <b :data-testid="`program-dir-${root.root}`">{{ root.root }}</b>
              <PillChip tone="muted" size="sm">只读</PillChip>
            </span>
            <em>{{ root.hint }}</em>
          </span>
          <span class="count num">
            <span v-if="loading" class="skel count-skel" aria-hidden="true" />
            <template v-else>{{ countText(root.root) }}</template>
          </span>
          <ChevronRight :size="16" class="t-3" />
        </button>
      </div>

      <section v-if="error" class="card error d-full" data-testid="program-data-error">
        <p class="etitle">读不到目录清单</p>
        <p class="ecopy">上面的 13 个目录照常列着，只是这次拿不到每项的条数。</p>
        <button class="retry" @click="load">重试</button>
      </section>

      <p v-if="empty" class="empty" data-testid="program-data-empty">
        工作区还是空的；文件管理器里也看不到目录。
      </p>

      <button class="card manager d-full" data-testid="program-data-open-manager" @click="openManager">
        <span class="col grow">
          <b>打开完整文件管理器</b>
          <em>想看整棵树、上传或整理文件，从这里进。</em>
        </span>
        <ChevronRight :size="16" class="t-3" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.intro p {
  font-size: var(--fs-subhead);
  line-height: 1.55;
  color: var(--text-2);
}

.dirs {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  margin-top: var(--gap-md);
}

/* 栅格 / flex 用 gap 管行距：卡片之间那条全局 12px 兄弟边距要收掉 */
.dirs > .card + .card {
  margin-top: 0;
}

.dir {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  min-width: 0;
  min-height: var(--row-h-double);
  text-align: left;
  font: inherit;
  color: inherit;
}

.dir:active {
  background: var(--surface-2);
}

.fic {
  width: var(--control-icon);
  height: var(--control-icon);
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-3);
}

.copy {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.ttl {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-width: 0;
}

.ttl b {
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.copy em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.count {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.count-skel {
  display: inline-block;
  width: var(--sp-40);
  height: var(--sp-10);
}

.skel {
  border-radius: var(--radius-xs);
  background: var(--surface-2);
}

.error {
  margin-top: var(--gap-md);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-sm);
}

.etitle {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ecopy {
  font-size: var(--fs-subhead);
  line-height: 1.5;
  color: var(--text-2);
}

.retry {
  min-height: var(--hit-min);
  padding: 0 var(--gap-sm);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--accent-strong);
}

.empty {
  margin-top: var(--gap-md);
  padding: 0 var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.manager {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  margin-top: var(--gap-md);
  text-align: left;
  font: inherit;
  color: inherit;
}

.manager:active {
  background: var(--surface-2);
}

.grow {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.grow b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.grow em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 桌面：13 行摊成两栏；移动端单列 */
:global(.desk-main) .dirs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--desk-gap);
  align-items: stretch;
}
</style>
