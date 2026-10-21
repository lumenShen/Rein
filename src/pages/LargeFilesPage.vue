<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { HardDrive, RefreshCw } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import UsageFileList from '@/components/kb/UsageFileList.vue'
import { usageCached } from '@/services/kbService'
import { useToast } from '@/composables/useToast'
import { humanBytes } from '@/utils/format'
import type { KbUsageFile, KbUsageReport } from '@/types'

/** 大文件榜（空间总览 › 大文件，路由 /ai/files/space/large）。
 *
 *  总览页只留前三名做摘要，完整榜单在这一页 —— 榜单会长（服务端上限 100 条），
 *  它要的是一个能按体积读下来的浏览面，而不是挤在总览卡里的一段列表。
 *  数据仍是同一条 `kb_usage`（只是 top 更大），口径与总览页完全一致。 */
const TOP = 100

const router = useRouter()
const toast = useToast()

const usage = ref<KbUsageReport | null>(null)
const loading = ref(false)
/** 首次加载失败的原因（已有数据时失败只 toast，不把页面换成错误态） */
const failed = ref('')

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const files = computed<KbUsageFile[]>(() => usage.value?.largest ?? [])
/** 榜单合计：这些「大头」一共占了多少（与工作区总量的对比在总览页） */
const listedBytes = computed(() => files.value.reduce((n, f) => n + f.bytes, 0))
/** 撞到服务端上限（TOP_MAX=100）就说明只列了最大的 100 个，更小的未列出 */
const capped = computed(() => files.value.length >= TOP)

/** `force` 跳过备忘（页头那颗刷新钮）；正常进入吃缓存，切页回来不再重扫库 */
async function load(force = false): Promise<void> {
  loading.value = true
  try {
    usage.value = await usageCached(TOP, force)
    failed.value = ''
  } catch (e) {
    if (usage.value) toast.toast(errMsg(e))
    else failed.value = errMsg(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

/** 打开文件：**按路径跳**，不按 id —— 榜单给的是 `kb_files.id`，阅读器要 `kb_docs.id`，
 *  两个 id 空间（理由详见总览页的同名函数）。 */
function openFile(f: KbUsageFile): void {
  const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  void router.push({ name: 'ai-files', query: parent ? { dir: parent, path: f.path } : { path: f.path } })
}
</script>

<template>
  <div class="page">
    <PageHeader back title="大文件" subtitle="文本 + 图片 / 音视频等文件 · 按体积倒序">
      <template #action>
        <button class="hdr-btn" aria-label="重新统计" :disabled="loading" @click="load(true)">
          <RefreshCw :size="18" :class="{ spin: loading }" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <EmptyState
      v-if="failed && !usage"
      :icon="HardDrive"
      title="读不到榜单"
      :hint="failed"
    >
      <template #action>
        <button class="btn" @click="load(true)">重试</button>
      </template>
    </EmptyState>

    <section v-else-if="!usage" class="card d-full" aria-hidden="true">
      <div class="sk sk-l" />
      <div class="sk sk-m" />
      <div class="sk sk-s" />
    </section>

    <section v-else class="card d-full" :class="{ 'card-empty': !files.length }">
      <div class="card-head">
        <div class="head-main">
          <h2>占用最多的文件</h2>
          <InfoHint title="榜单怎么读" content="条长 = 相对最大文件的体积占比：第一名总是满格，其余按与它的比例缩短，读的是「比第一名小多少」。

蓝 = 文本，即笔记正文抽取出的文字；紫 = 图片 / 音视频等文件，即导入的原始文件。两段相加就是这一行的体积。" />
        </div>
        <span class="sub num">{{ files.length }} 个 · 合计 {{ humanBytes(listedBytes) }}</span>
      </div>

      <UsageFileList v-if="files.length" :files="files" @open="openFile" />
      <EmptyState
        v-else
        :icon="HardDrive"
        title="还没有文件"
        hint="写进工作区的笔记与导入的图片 / 音视频等文件会按体积排在这里"
      />

      <p v-if="files.length" class="foot">
        蓝 = 文本，紫 = 图片 / 音视频等文件。点一行进文件管理器打开它。
      </p>
      <p v-if="capped" class="foot">只列最大的 {{ TOP }} 个，更小的未列出。</p>
    </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开，
     这里只剩页头与内容之间那一档呼吸 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 骨架（首屏） ---------- */
.sk {
  height: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.sk-l {
  width: 46%;
  height: 34px;
}
.sk-m {
  width: 72%;
  margin-top: var(--sp-14);
}
.sk-s {
  width: 32%;
  margin-top: var(--sp-10);
}

/* 统计卡卡头：与容量总览页同一套内距与间距（两页是同一族的读数页） */
.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-md);
  margin-bottom: var(--gap-md);
}
/* 标题行：标题与帮助入口同一行居中（落点：卡头图标按钮放标题行右端） */
.head-main {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-width: 0;
}
.card-head h2 {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}
.card-head .sub {
  text-align: right;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.foot {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

/* 空态吃掉剩余高度（桌面栅格会把卡拉到与同行一样高；移动端无影响） */
.card-empty {
  display: flex;
  flex-direction: column;
}
.card-empty :deep(.empty) {
  flex: 1;
  justify-content: center;
}

/* 空态里的「重试」是这一屏唯一的主操作：走常规按钮档 40（--control-md），
   不再借用行尾小按钮的 28。 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  flex: none;
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}
.btn:disabled {
  opacity: var(--disabled-opacity);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
