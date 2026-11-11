<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Globe, Plus, Search } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import ConnectedAppSheet from '@/components/settings/ConnectedAppSheet.vue'
import { useToast } from '@/composables/useToast'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import {
  CONNECTED_APPS,
  CONNECTED_APP_PLATFORM_NOTES,
  PLATFORM_LABELS,
  type ConnectedApp,
  type ConnectedAppPlatform,
} from '@/config/connectedApps'
import { currentPlatform, type PlatformKey } from '@/utils/platform'

/**
 * 连接应用（`/settings/apps`）。
 *
 * 一页回答三个问题：**这台设备上哪些应用能连**（平台页签 + 分组）、**哪些已经接上**
 * （原生状态快照 `connected_app_status`，health 由 `health_sync_status` 合成）、
 * **接上之后还能让谁读数据**（页底外部访问）。
 *
 * 连接状态只来自原生：页面不读写任何占位标记，也不把 localStorage 当作「已连接」。
 * 旧占位键由 store 初始化时清一次（`stores/connectedApps.ts`）。
 *
 * 行右侧是一枚**状态 pill**（不是开关）：点击整行打开详情抽屉；health 仍进既有健康数据页。
 * 首次 Android 状态 `unknown` 时行显示「检测中」，300ms 后重试一次；仍未知就停在这里，
 * 由用户点「重试」或重新进页面触发再次检测。错误不清空旧状态。
 *
 * 平台判定只用于展示（见 `utils/platform.ts` 的文件头），不作为「这个功能有没有」的真源。
 */

const router = useRouter()
const { toast } = useToast()
const connectedApps = useConnectedAppsStore()

/** 当前运行平台（展示用途，不是能力真源） */
const platform = currentPlatform()

/** 页签状态：默认当前平台；浏览器预览下内容回落到 Windows */
const activeTab = ref<PlatformKey>(platform)
const search = ref('')
const searchEl = ref<HTMLInputElement | null>(null)

/** 平台页签的固定次序：默认页签在最前，其余按 iOS / Mac / Windows / Android / Linux */
const TAB_ORDER: readonly PlatformKey[] = ['ios', 'mac', 'windows', 'android', 'linux']

const tabs = computed<{ id: PlatformKey; label: string }[]>(() => {
  const ids: PlatformKey[] =
    platform === 'browser'
      ? // 浏览器预览先摆 Windows：内容就是它，再往后是其余平台
        ['browser', 'windows', 'ios', 'mac', 'android', 'linux']
      : [platform, ...TAB_ORDER.filter((p) => p !== platform)]
  return ids.map((id) => ({
    id,
    label:
      id === platform && platform !== 'browser'
        ? `当前 ${PLATFORM_LABELS[id]}`
        : PLATFORM_LABELS[id],
  }))
})

/** 页签 → 实际展示的清单：`browser` 回落到 Windows，其余一一对应 */
const contentPlatform = computed<ConnectedAppPlatform>(() =>
  activeTab.value === 'browser' ? 'windows' : activeTab.value,
)

/** 停在真实当前平台的页签上才说「当前 X 可用」；浏览器预览不是真实平台，不加前缀 */
const isRealCurrent = computed(
  () => platform !== 'browser' && activeTab.value === platform,
)

const query = computed(() => search.value.trim().toLowerCase())

const platformNote = computed(() => CONNECTED_APP_PLATFORM_NOTES[contentPlatform.value] ?? '')

const groupTitle = computed(() => {
  const label = PLATFORM_LABELS[contentPlatform.value]
  // 只有一条平台说明、没有行可列的页签（iOS）：标题只写平台名，别用「可用」自相矛盾
  if (platformNote.value) return label
  return `${isRealCurrent.value ? '当前 ' : ''}${label} 可用`
})

const groupApps = computed(() =>
  CONNECTED_APPS.filter((app) => {
    if (app.platform !== contentPlatform.value) return false
    if (!query.value) return true
    return (
      app.title.toLowerCase().includes(query.value) ||
      app.subtitle.toLowerCase().includes(query.value)
    )
  }),
)

/** 浏览器预览的说明行：e2e 不要据此断言「能连本机应用」 */
const isBrowserPreview = platform === 'browser'

function focusSearch(): void {
  searchEl.value?.focus()
}

/* ---------------- 状态：health 由 health_sync_status 合成，其余读原生快照 ---------------- */

const healthStatus = computed(() => connectedApps.statusFor('health'))

const healthConnected = computed(
  () => platform === 'android' && healthStatus.value?.connected === true,
)

/** 健康数据在桌面 / 浏览器上不可用：给一句明确原因，不要把人送进一个全灰的页面 */
const healthUnavailable = computed(
  () => platform !== 'android' || healthStatus.value?.supported === false,
)

/** 需要授权文件夹才能连接的 app：没有根时行显示「选文件夹」而不是「去授权」 */
function needsRoot(id: string): boolean {
  return id === 'filesystem' || id === 'win-local'
}

/** 行右侧状态文字：不支持 / 检测中 / 连接 / 去授权 / 选文件夹 / 已连接 */
function rowLabel(app: ConnectedApp): string {
  // health 保持既有真实入口语义：桌面 / 浏览器上只有说明，安卓上给「管理 / 已连接」
  if (app.route) {
    if (healthUnavailable.value) return '仅安卓'
    return healthConnected.value ? '已连接' : '管理'
  }

  const s = connectedApps.statusFor(app.id)
  if (!s) return '检测中'
  if (s.availability === 'unknown') return '检测中'
  if (s.availability === 'unsupported') return '不支持'
  if (s.availability === 'unavailable') return '不可用'
  if (s.connected) return s.aiEnabled ? '已连接 · AI' : '已连接'
  if (!s.enabled) return '连接'
  if (needsRoot(app.id) && s.roots.length === 0) return '选文件夹'
  return '去授权'
}

/** 状态 pill 的语气：可行动项用强调色，其余保持中性。 */
function rowTone(app: ConnectedApp): 'label' | 'muted' | 'action' {
  const label = rowLabel(app)
  if (label === '已连接' || label === '已连接 · AI') return 'label'
  if (label === '连接' || label === '去授权' || label === '选文件夹') return 'action'
  return 'muted'
}

/** 某一行是否可点开详情（health 走路由，其余打开抽屉） */
function rowAria(app: ConnectedApp): string {
  return `${app.title}：${rowLabel(app)}`
}

function subtitleFor(app: ConnectedApp): string {
  if (app.route && platform !== 'android') return app.statusHint ?? app.subtitle
  return app.subtitle
}

/* ---------------- 抽屉 ---------------- */

const sheetApp = ref<ConnectedApp | null>(null)
const sheetOpen = ref(false)

function onRow(app: ConnectedApp): void {
  if (app.route) {
    if (healthUnavailable.value) {
      // 桌面 / 不支持时先给一句原因，再照旧进页：健康数据页自己是说明性禁用态，
      // 用户能在那儿看清「为什么这里没有 Health Connect」，而不是被一个 toast 挡在门外。
      toast('健康数据只在安卓上可用')
    }
    void router.push({ name: app.route })
    return
  }
  sheetApp.value = app
  sheetOpen.value = true
}

function closeSheet(): void {
  sheetOpen.value = false
}

/* ---------------- 加载 / 重试 / 回到前台刷新 ---------------- */

/** Android 首次 state.json 还没落地时只重试一次，避免无限轮询。 */
let retriedUnknown = false
let retryTimer: number | null = null

function hasUnknownStatus(): boolean {
  const list = Object.values(connectedApps.statuses)
  if (list.length === 0) return true
  return list.some((s) => s.availability === 'unknown')
}

function scheduleUnknownRetry(): void {
  if (platform !== 'android' || retriedUnknown) return
  if (!hasUnknownStatus()) return
  retriedUnknown = true
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    void connectedApps.refresh()
  }, 300)
}

async function bootstrap(): Promise<void> {
  // 强制重读：从健康数据页授权后返回时，30 秒缓存会让人看到旧的「管理」。
  // health 也在这次 refresh 里由 store 合成（Android / 浏览器）。
  await connectedApps.refresh()
  scheduleUnknownRetry()
}

function retry(): void {
  void connectedApps.refresh()
}

/** 回到前台 / 窗口重新聚焦：原生授权可能已在系统设置里改过，重读一次。 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void connectedApps.refresh()
}

function onWindowFocus(): void {
  void connectedApps.refresh()
}

onMounted(() => {
  void bootstrap()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onWindowFocus)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('focus', onWindowFocus)
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
})

/* ---------------- 页底外部访问入口 ---------------- */

const externalSubtitle = computed(() =>
  platform === 'android'
    ? '让外部程序读取数据、触发操作（桌面端可用）'
    : '让外部程序读取数据、触发操作 · 桌面端可读写日程、番茄钟与运动',
)
</script>

<template>
  <div class="page" data-testid="connected-apps-page">
    <PageHeader
      title="连接应用"
      subtitle="连接服务与数据，让 Rein 更好地帮助你"
      back
    >
      <template #action>
        <button
          type="button"
          class="hdr-btn"
          aria-label="添加连接应用"
          data-testid="apps-add"
          @click="toast('当前平台的可连接应用都已列在下方；连接后可在详情里允许 AI 使用')"
        >
          <Plus :size="18" />
        </button>
        <button
          type="button"
          class="hdr-btn"
          aria-label="搜索应用"
          data-testid="apps-search-toggle"
          @click="focusSearch"
        >
          <Search :size="18" />
        </button>
      </template>
    </PageHeader>

    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <p v-if="isBrowserPreview" class="preview-note">
        浏览器预览使用样例数据，不会读写本机文件、通讯录或执行命令。
      </p>

      <div v-if="connectedApps.error" class="err card" role="alert" data-testid="apps-error">
        <span class="err-txt">读取本机状态失败：{{ connectedApps.error }}</span>
        <button type="button" class="err-retry" data-testid="apps-error-retry" @click="retry">
          重试
        </button>
      </div>

      <div class="tabs" role="tablist" aria-label="平台">
        <span
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-slot"
          role="presentation"
          :class="{ active: activeTab === tab.id }"
          :data-testid="`platform-tab-${tab.id}`"
        >
          <button
            type="button"
            role="tab"
            class="tab"
            :class="{ active: activeTab === tab.id }"
            :aria-selected="activeTab === tab.id"
            :data-testid="`apps-tab-${tab.id}`"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </span>
      </div>

      <label class="search card">
        <Search :size="16" class="search-ic" aria-hidden="true" />
        <input
          ref="searchEl"
          v-model="search"
          type="search"
          class="search-input"
          placeholder="搜索应用"
          autocomplete="off"
          spellcheck="false"
          data-testid="apps-search"
        />
      </label>

      <section class="group">
        <h2 class="gtitle">{{ groupTitle }}</h2>

        <p v-if="platformNote" class="note card">{{ platformNote }}</p>
        <div v-if="groupApps.length" class="list">
          <div
            v-for="app in groupApps"
            :key="app.id"
            class="app-row card"
            :data-testid="`apps-row-${app.id}`"
          >
            <SettingsRow
              :title="app.title"
              :subtitle="subtitleFor(app)"
              :icon="app.icon"
              :accent="app.accent"
              :testid="`connected-app-${app.id}`"
              :aria-label="rowAria(app)"
              @click="onRow(app)"
            >
              <PillChip
                :tone="rowTone(app)"
                size="sm"
                :data-testid="`apps-toggle-${app.id}`"
              >{{ rowLabel(app) }}</PillChip>
              <ChevronRight v-if="app.route" :size="16" class="chev" />
            </SettingsRow>
          </div>
        </div>
        <p v-else-if="!platformNote" class="note card" data-testid="apps-empty">
          没有匹配的应用
        </p>
      </section>

      <section class="card external">
        <SettingsRow
          title="外部访问"
          :subtitle="externalSubtitle"
          :icon="Globe"
          accent="--mod-campus"
          testid="apps-external-entry"
          :to="{ name: 'settings-apps-external' }"
        >
          <PillChip tone="muted" size="sm">桌面端</PillChip>
          <ChevronRight :size="16" class="chev" />
        </SettingsRow>
      </section>

      <p class="foot">
        连接后，AI 只在你允许的应用与权限范围内工作；写操作会逐次确认，并写入本地审计。
      </p>
    </div>

    <ConnectedAppSheet :open="sheetOpen" :app="sheetApp" @close="closeSheet" />
  </div>
</template>

<style scoped>
/* 三级页骨架：.page 管画布留白，页头与内容都吃同一份 --page-pad-x */
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 浏览器预览的说明：只说事实，不与后面的分组标题抢层级 */
.preview-note {
  margin: var(--sp-4) 0 0;
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

/* 读取失败：保留旧状态，只在顶部加一条可重试的错误条 */
.err {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  margin-top: var(--sp-4);
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.err-txt {
  flex: 1;
  min-width: 0;
}

.err-retry {
  flex: none;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 平台页签：横向可滚，当前平台用实底卡片抬起来（参考图里是白胶囊压在淡色底上） */
.tabs {
  display: flex;
  gap: var(--gap-sm);
  overflow-x: auto;
  padding: var(--sp-4) 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

/* 每枚页签的定位壳：让「方案 testid」与任务书 testid 都能落在页签上 */
.tab-slot {
  display: flex;
  flex: none;
}

.tab {
  flex: none;
  min-height: var(--control-md);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.tab.active {
  background: var(--surface);
  color: var(--text-1);
  font-weight: var(--fw-semibold);
  box-shadow: var(--shadow-card);
}

.tab:active {
  transform: scale(0.97);
}

/* 搜索：与页签同一档胶囊，单独一行；图标只做提示，输入框占满剩余宽度 */
.search {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
  padding: 0 var(--pad-inline);
  min-height: var(--control-md);
  border-radius: var(--radius-full);
}

/* 输入框自己的矩形轮廓收掉，聚焦环画在外层胶囊上（全局 :focus-visible 的同一档 2px） */
.search:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.search-ic {
  flex: none;
  color: var(--text-3);
}

.search-input {
  flex: 1;
  min-width: 0;
  height: var(--control-md);
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: var(--fs-subhead);
  -webkit-appearance: none;
  appearance: none;
}

.search-input::placeholder {
  color: var(--text-3);
}

/* 搜索框的原生清除钮在深色下是一块白，交给输入法自己的删除键 */
.search-input::-webkit-search-cancel-button {
  display: none;
}

.group {
  margin-top: var(--gap-lg);
}

/* 分组标签与卡片左缘对齐；比设置页的卡内标题低一档，读成「一组」而不是「一张卡」 */
.gtitle {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.note {
  margin-top: var(--gap-sm);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
}

/* 参考图是「一行一张卡」：白卡之间留 8，不用分隔线把整组切成一条长列表。 */
.list {
  margin-top: var(--gap-sm);
}

.app-row {
  padding: 0 var(--pad-card);
}

.list .app-row + .app-row {
  margin-top: var(--gap-sm);
}

.chev {
  flex: none;
  color: var(--text-3);
}

.external {
  margin-top: var(--gap-lg);
}

/* 页底小字：说明连接边界，不抢外部访问入口的注意力 */
.foot {
  margin-top: var(--gap-md);
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  text-align: center;
}
</style>
