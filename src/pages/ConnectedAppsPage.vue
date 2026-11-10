<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Globe, Plus, Search } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import { useToast } from '@/composables/useToast'
import { healthSyncService } from '@/services/healthSyncService'
import {
  CONNECTED_APPS,
  CONNECTED_APPS_COMPAT_KEY,
  CONNECTED_APPS_PLACEHOLDER_KEY,
  CONNECTED_APP_PLATFORM_NOTES,
  PLATFORM_LABELS,
  type ConnectedApp,
  type ConnectedAppPlatform,
} from '@/config/connectedApps'
import { currentPlatform, type PlatformKey } from '@/utils/platform'
import type { HealthSyncStatus } from '@/types'

/**
 * 连接应用（`/settings/apps`）。
 *
 * 一页回答三个问题：**这台设备上哪些应用能连**（平台页签 + 分组）、**哪些已经接上**
 * （真实行「管理」/「已连接」+ 占位行 ✓ / +）、**接上之后还能让谁读数据**（页底外部访问）。
 *
 * 只有 Android 的健康数据是真入口，其余行都是占位：点一下只在本机记一个标记
 * （`localStorage` 的 id 数组），不调 IPC、不写库。占位行做成「能点、能看见状态变了」，
 * 是为了让入口先立得住；footer 明说「带 + 的应用是占位入口」，不让 ✓ 冒充已接入。
 *
 * 浏览器预览不是真实平台：页签如实写「浏览器」且不加「当前」前缀，内容按 Windows 展示
 * （参考图的主目标平台），页顶另给一行「无法连接本机应用」的说明；健康数据行则在
 * 桌面 / 浏览器下提示「只在安卓上可用」。
 *
 * 平台判定只用于展示（见 `utils/platform.ts` 的文件头），不作为「这个功能有没有」的真源。
 */

const router = useRouter()
const { toast } = useToast()

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

/* ---------------- 健康数据：真实状态来自 health_sync_status ---------------- */

const healthStatus = ref<HealthSyncStatus | null>(null)

const healthConnected = computed(() => {
  const s = healthStatus.value
  return (
    platform === 'android' &&
    !!s &&
    s.supported &&
    s.availability === 'available' &&
    s.readGranted
  )
})

async function loadHealthStatus(): Promise<void> {
  // 桌面 / 浏览器没有 Health Connect，没必要为一条状态发请求
  if (platform !== 'android') return
  try {
    healthStatus.value = await healthSyncService.status()
  } catch (e) {
    console.warn('[connected-apps] 读取健康数据状态失败', e)
  }
}

onMounted(() => {
  void loadHealthStatus()
})

/* ---------------- 占位行的本机标记 ---------------- */

/** 主键 + 兼容键：值都是 id 数组，读取取并集、写入两边同步 */
const MARK_KEYS = [CONNECTED_APPS_PLACEHOLDER_KEY, CONNECTED_APPS_COMPAT_KEY] as const

function readMarkedKey(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function loadMarked(): string[] {
  const ids = new Set<string>()
  for (const key of MARK_KEYS) {
    for (const id of readMarkedKey(key)) ids.add(id)
  }
  return [...ids]
}

const marked = ref<string[]>(loadMarked())

function toggleMark(id: string): void {
  const wasMarked = marked.value.includes(id)
  marked.value = wasMarked
    ? marked.value.filter((v) => v !== id)
    : [...marked.value, id]
  const raw = JSON.stringify(marked.value)
  for (const key of MARK_KEYS) {
    try {
      localStorage.setItem(key, raw)
    } catch {
      // 隐私模式写不进去：本次点击仍然生效，只是刷新后回到空数组
    }
  }
  toast(wasMarked ? '已取消占位标记' : '占位功能，稍后接入')
}

function isConnected(app: ConnectedApp): boolean {
  if (app.kind === 'placeholder') return marked.value.includes(app.id)
  return app.id === 'health' ? healthConnected.value : false
}

/** 真实行的右侧标签：不可用时明说「仅安卓」，可用了才是「管理」/「已连接」 */
function realRowLabel(app: ConnectedApp): string {
  if (app.id !== 'health') return '管理'
  if (healthUnavailable()) return '仅安卓'
  return healthConnected.value ? '已连接' : '管理'
}

/** 健康数据在桌面 / 浏览器上不可用：给一句明确原因，不要把人送进一个全灰的页面 */
function healthUnavailable(): boolean {
  return platform !== 'android' || healthStatus.value?.supported === false
}

function onRow(app: ConnectedApp): void {
  if (app.kind === 'placeholder') {
    toggleMark(app.id)
    return
  }
  if (app.id === 'health' && healthUnavailable()) {
    // 桌面 / 不支持时先给一句原因，再照旧进页：健康数据页自己是说明性禁用态，
    // 用户能在那儿看清「为什么这里没有 Health Connect」，而不是被一个 toast 挡在门外。
    toast('健康数据只在安卓上可用')
  }
  if (app.route) void router.push({ name: app.route })
}

/** 健康数据行的副标在非 Android 上直接说清限制；其余行沿用声明表 */
function subtitleFor(app: ConnectedApp): string {
  if (app.id === 'health' && platform !== 'android') return app.statusHint ?? app.subtitle
  return app.subtitle
}

/** 外部访问入口的副标：桌面端是真实场景，Android 上补一句可用范围 */
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
          @click="toast('占位功能，稍后接入')"
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
        浏览器预览无法连接本机应用，以下是占位清单。
      </p>

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
              :aria-label="`${app.title}：${isConnected(app) ? '已连接' : '未连接'}`"
              :aria-pressed="app.kind === 'placeholder' ? isConnected(app) : undefined"
              @click="onRow(app)"
            >
              <template v-if="app.kind === 'real'">
                <PillChip tone="muted" size="sm">{{ realRowLabel(app) }}</PillChip>
                <ChevronRight :size="16" class="chev" />
              </template>
              <span
                v-else
                class="mark"
                :class="{ on: isConnected(app) }"
                :data-testid="`apps-toggle-${app.id}`"
                aria-hidden="true"
              >{{ isConnected(app) ? '✓' : '+' }}</span>
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
        带 + 的应用是占位入口，接入后会变成 ✓；先把入口摆出来，具体接入在后续版本实现。
      </p>
    </div>
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

/* 参考图是「一行一张卡」：白卡之间留 8，不用分隔线把整组切成一条长列表。
   .card 提供底 / 圆角 / 落影（高画质及以上同一份玻璃材质），这里只把默认内距
   换成行内距 —— 行高由 SettingsRow 自己按有没有副标给 64 / 48。 */
.list {
  margin-top: var(--gap-sm);
}

.app-row {
  padding: 0 var(--pad-card);
}

.list .app-row + .app-row {
  margin-top: var(--gap-sm);
}

/* 右侧圆形标记：未连接是中性 +，已连接是浅绿 ✓（与占位 footer 的口径一致） */
.mark {
  width: var(--control-sm);
  height: var(--control-sm);
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  line-height: 1;
}

.mark.on {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.chev {
  flex: none;
  color: var(--text-3);
}

.external {
  margin-top: var(--gap-lg);
}

/* 页底小字：说明 + / ✓ 的语义，不抢外部访问入口的注意力 */
.foot {
  margin-top: var(--gap-md);
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  text-align: center;
}
</style>
