<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FolderPlus, Loader2, RefreshCw, TriangleAlert, X } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import PillChip from '@/components/common/PillChip.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import type { ConnectedApp } from '@/config/connectedApps'
import { connectedAppService } from '@/services/connectedAppService'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import type { ConnectedAppId, ConnectedAppPermission, ConnectedAppRoot } from '@/types'

/**
 * 单个连接应用的详情抽屉。
 *
 * 顺序按 plan §5.2：图标/标题/副标/状态 → 权限（读、写分开）→ 文件根 → 终端风险 →
 * 使用说明 → 「允许 AI 使用」→ 「允许写入」→ 重新检测 → 底部（关闭 / 连接 / 断开）。
 *
 * 三条纪律：
 * 1. **状态只读原生**：`connected/supported/availability/permissions/roots` 来自 store 的
 *    `connected_app_status`（health 不在此抽屉）；抽屉不自己猜「已连接」。
 * 2. **写权限是「意图 + 系统授权」两段**：先 `connected_app_update({writeAllowed})` 存意图，
 *    再 `connected_app_request('permissions_write')` 拉起系统授权；授权没到之前
 *    `status.writeAllowed` 仍是 false，开关不会假装已生效。
 * 3. **不自动要写权限**：连接流程只补读权限/文件夹；日历/通讯录/短信的写权限必须由用户
 *    在这里单独点「允许写入」。
 */

const props = defineProps<{ open: boolean; app: ConnectedApp | null }>()
const emit = defineEmits<{ close: [] }>()

const store = useConnectedAppsStore()
const { toast } = useToast()

/** 抽屉内动作锁：同一时刻只允许一个系统请求/更新，避免授权页叠开。 */
type BusyKind = 'connect' | 'disconnect' | 'refresh' | 'permission' | 'folder' | 'write'
const busy = ref<BusyKind | null>(null)

/** 抽屉内的局部错误；store 的全局错误只在没有局部错误时兜底显示。 */
const sheetError = ref<string | null>(null)

const status = computed(() => (props.app ? store.statusFor(props.app.id) : null))

const iconStyle = computed(() =>
  props.app
    ? { background: `var(${props.app.accent}-soft)`, color: `var(${props.app.accent}-strong)` }
    : undefined,
)

/** 需要先选文件夹的 app：filesystem（SAF 单树）/ win-local（多根）。 */
const needsFolder = computed(() => {
  const id = props.app?.id
  return id === 'filesystem' || id === 'win-local'
})

const isTerminal = computed(
  () => props.app?.id === 'win-terminal' || props.app?.id === 'mac-terminal',
)

/* ---------------- 状态 pill / 说明 ---------------- */

const statusLabel = computed(() => {
  const s = status.value
  if (!s) return '检测中'
  if (s.availability === 'unknown') return '检测中'
  if (s.availability === 'unsupported') return '不支持'
  if (s.availability === 'unavailable') return '不可用'
  if (s.connected) return s.aiEnabled ? '已连接 · AI' : '已连接'
  if (s.enabled) {
    if (needsFolder.value && s.roots.length === 0) return '选文件夹'
    return '去授权'
  }
  return '未连接'
})

const statusTone = computed<'label' | 'muted' | 'action'>(() => {
  const label = statusLabel.value
  if (label === '已连接' || label === '已连接 · AI') return 'label'
  if (label === '选文件夹' || label === '去授权') return 'action'
  if (label === '未连接') return 'action'
  return 'muted'
})

const detailText = computed(() => status.value?.detail ?? status.value?.reason ?? '')

const errorText = computed(() => sheetError.value ?? store.error)

/* ---------------- 权限 ---------------- */

const readPerms = computed(() => status.value?.permissions.filter((p) => !p.write) ?? [])
const writePerms = computed(() => status.value?.permissions.filter((p) => p.write) ?? [])

function actionLabel(p: ConnectedAppPermission): string {
  if (p.write) return '允许写入'
  switch (p.action) {
    case 'usage_access':
    case 'notification_access':
      return '去开启'
    case 'folder':
      return '选择文件夹'
    case 'settings':
      return '去设置'
    default:
      return '去授权'
  }
}

function canAuthorize(p: ConnectedAppPermission): boolean {
  // 写权限没有可拉起的系统页（通知/闹钟/终端）：只有连接后才有意义；
  // 有 action 的写权限可以先单独授予，不必等连接。
  if (p.action !== null) return true
  return p.write && status.value?.connected === true
}

async function authorize(p: ConnectedAppPermission): Promise<void> {
  const app = props.app
  if (!app || busy.value) return
  sheetError.value = null
  // 已连接时，写权限走「意图 + 系统授权」两段；未连接时只申请系统权限、不写意图。
  if (p.write && status.value?.connected === true) {
    await setWrite(true)
    return
  }
  if (!p.action) return
  busy.value = 'permission'
  try {
    // 用户取消系统弹窗不算错误：状态保持 partial，由下面的状态行如实呈现。
    await store.request(app.id, p.action)
  } finally {
    busy.value = null
  }
}

/* ---------------- 文件根 ---------------- */

const roots = computed(() => status.value?.roots ?? [])

const showRoots = computed(() => {
  if (!props.app) return false
  return needsFolder.value || roots.value.length > 0
})

const addFolderLabel = computed(() => {
  if (props.app?.id === 'filesystem') return roots.value.length ? '更换文件夹' : '选择文件夹'
  return '添加文件夹'
})

const addFolderDisabled = computed(
  () =>
    busy.value !== null ||
    (props.app?.id === 'win-local' && roots.value.length >= 5),
)

async function addFolder(): Promise<void> {
  const app = props.app
  if (!app || busy.value) return
  sheetError.value = null
  busy.value = 'folder'
  try {
    // 取消选择器不报错：根列表会保持原样，用户可再点一次。
    await store.request(app.id, 'folder')
  } finally {
    busy.value = null
  }
}

/* 移除根是两段式：点「×」只打开确认，确认后才把剩余根写回原生。 */
const rootToRemove = ref<ConnectedAppRoot | null>(null)

async function removeRoot(): Promise<void> {
  const app = props.app
  const target = rootToRemove.value
  rootToRemove.value = null
  if (!app || !target || busy.value) return
  sheetError.value = null
  busy.value = 'folder'
  try {
    const remaining = roots.value.filter((r) => r.id !== target.id)
    await connectedAppService.update(app.id, {
      roots: remaining.map((r) => r.path ?? r.label),
    })
    await store.refresh()
  } catch (e) {
    sheetError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = null
  }
}

/* ---------------- 终端两段式连接 ---------------- */

const terminalAck = ref(false)

/* ---------------- 连接 / 断开 ---------------- */

const canConnect = computed(() => {
  const s = status.value
  if (!s || s.connected) return false
  if (!s.supported) return false
  if (
    s.availability === 'unknown' ||
    s.availability === 'unsupported' ||
    s.availability === 'unavailable'
  ) {
    return false
  }
  if (isTerminal.value && !terminalAck.value) return false
  return true
})

const connectLabel = computed(() => {
  if (busy.value === 'connect') return '正在连接…'
  const s = status.value
  if (!s) return '正在检测系统授权'
  if (s.availability === 'unknown') return '正在检测系统授权'
  if (s.availability === 'unsupported') return '当前平台不支持'
  if (s.availability === 'unavailable') return '暂不可用'
  if (s.enabled) return '完成授权'
  return '连接'
})

async function connect(): Promise<void> {
  const app = props.app
  if (!app || busy.value || !canConnect.value) return
  busy.value = 'connect'
  sheetError.value = null
  try {
    const ok = await store.setEnabled(app.id, true)
    if (!ok) {
      sheetError.value = store.error ?? '连接失败，请稍后重试'
      return
    }

    let current = store.statusFor(app.id)
    if (!current?.connected) {
      // 缺少的必需前提按优先级补：先文件夹（SAF / win-local），再系统权限。
      const missingRoot = needsFolder.value && (current?.roots.length ?? 0) === 0
      const missingPermission = current?.permissions.find(
        (p) => p.required && !p.granted && p.action,
      )
      if (missingRoot) {
        await store.request(app.id, 'folder')
      } else if (missingPermission?.action) {
        await store.request(app.id, missingPermission.action)
      }
    }

    current = store.statusFor(app.id)
    // 用户取消系统弹窗/选择器时保持 partial，不报成功；只有真正 connected 才 toast。
    if (current?.connected) toast('已连接')
  } catch (e) {
    sheetError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = null
  }
}

const disconnectOpen = ref(false)
const disconnectTitle = computed(() =>
  props.app ? `断开「${props.app.title}」？` : '断开连接？',
)
const disconnectActions = [{ label: '断开连接', value: 'disconnect', danger: true }]

async function disconnect(): Promise<void> {
  const app = props.app
  disconnectOpen.value = false
  if (!app || busy.value) return
  busy.value = 'disconnect'
  sheetError.value = null
  try {
    const ok = await store.setEnabled(app.id, false)
    if (!ok) {
      sheetError.value = store.error ?? '断开失败，请稍后重试'
      return
    }
    writeChecked.value = false
    toast('已断开连接')
  } finally {
    busy.value = null
  }
}

/* ---------------- 重新检测 ---------------- */

async function reconnect(): Promise<void> {
  if (busy.value) return
  busy.value = 'refresh'
  sheetError.value = null
  try {
    await store.refresh()
  } finally {
    busy.value = null
  }
}

/* ---------------- 允许 AI 使用 ---------------- */

const aiOn = computed(() => status.value?.aiEnabled === true)
const aiDisabled = computed(() => status.value?.connected !== true || busy.value !== null)

async function setAi(on: boolean): Promise<void> {
  const app = props.app
  if (!app) return
  const ok = await store.setAiEnabled(app.id, on)
  if (!ok) {
    if (!store.isConnected(app.id)) {
      toast('请先连接该应用')
    } else {
      toast(store.error ?? '保存 AI 使用开关失败')
    }
    return
  }
  toast(on ? '已允许 AI 使用' : '已停止 AI 使用')
}

/* ---------------- 允许写入 ---------------- */

const writeChecked = ref(false)
const writePending = ref(false)

const writeLabel = computed(() => {
  switch (props.app?.id) {
    case 'calendar':
      return '允许写入日程'
    case 'contacts':
      return '允许写入联系人'
    case 'sms':
      return '允许发送短信'
    case 'notification':
      return '允许清除通知'
    case 'alarm':
      return '允许修改闹钟和计时器'
    case 'win-terminal':
    case 'mac-terminal':
      return '允许执行命令'
    case 'filesystem':
    case 'win-local':
    case 'win-desktop':
    case 'win-documents':
    case 'win-downloads':
    case 'mac-desktop':
    case 'linux-desktop':
    case 'linux-documents':
      return '允许写入文件'
    default:
      return '允许写入'
  }
})

const writeHint = computed(() => {
  if (!writePending.value) return '写操作每次都会单独确认；拒绝后不会改动数据。'
  return writeChecked.value ? '正在关闭写入许可…' : '等待系统授权…'
})

const writeDisabled = computed(
  () => status.value?.connected !== true || busy.value !== null,
)

/**
 * 写开关：先存写入意图，再拉系统写权限。
 *
 * 权限没到之前有效值 `status.writeAllowed` 仍是 false（见 plan §13.3），所以这里在
 * 刷新后回读一次有效值；仍为 false 就把开关回到关，不做「看起来已生效」的假象。
 * 意图本身保留：之后在系统设置里补授权，下次检测会直接生效。
 */
async function setWrite(on: boolean): Promise<void> {
  const app = props.app
  if (!app || busy.value) return
  busy.value = 'write'
  writePending.value = on
  sheetError.value = null
  try {
    await store.setWriteAllowed(app.id, on)
    if (on) await store.request(app.id, 'permissions_write')
    await store.refresh()
    // 开关始终画**有效值**：系统授权没回来之前 status.writeAllowed 仍是 false，
    // 开关就保持关（或保持原值），只由 writeHint 显示「等待系统授权…」。
    writeChecked.value = store.statusFor(app.id)?.writeAllowed === true
  } catch (e) {
    writeChecked.value = store.statusFor(app.id)?.writeAllowed === true
    sheetError.value = e instanceof Error ? e.message : String(e)
  } finally {
    writePending.value = false
    busy.value = null
  }
}

/** 有效值变化时同步开关；写入请求进行中不覆盖本地「等待授权」态。 */
watch(
  () => [props.open, props.app?.id, status.value?.connected, status.value?.writeAllowed] as const,
  () => {
    if (!props.open || writePending.value) return
    writeChecked.value = status.value?.writeAllowed === true
  },
  { immediate: true },
)

/* ---------------- 使用说明：写回口径 ---------------- */

const FILE_APPS: readonly ConnectedAppId[] = [
  'filesystem',
  'win-local',
  'win-desktop',
  'win-documents',
  'win-downloads',
  'mac-desktop',
  'linux-desktop',
  'linux-documents',
]

const DELETE_BOUNDARY = '删除只支持单文件或空目录（不进回收站）。'

/**
 * 教程以 config 的 `tutorial` 为准；config 里尚未写全「删除边界」的文件类 app
 * 在这里补一行（已写过的按同一句式去重，不重复展示）。
 */
const tutorialLines = computed(() => {
  const app = props.app
  if (!app) return []
  const lines = [...(app.tutorial ?? [])]
  if (
    FILE_APPS.includes(app.id) &&
    !lines.some((line) => line.includes('删除只支持单文件或空目录'))
  ) {
    lines.push(DELETE_BOUNDARY)
  }
  return lines
})

/* ---------------- 打开时复位 ---------------- */

watch(
  () => props.open,
  (open) => {
    if (!open) return
    busy.value = null
    sheetError.value = null
    terminalAck.value = false
    disconnectOpen.value = false
    rootToRemove.value = null
    writePending.value = false
    writeChecked.value = status.value?.writeAllowed === true
    // 每次打开都重新判定一次：用户可能刚从系统设置里回来。
    void store.refresh()
  },
)
</script>

<template>
  <SheetModal
    :open="open"
    title="连接应用"
    initial-snap="large"
    @close="emit('close')"
  >
    <div v-if="app" class="wrap" data-testid="connected-app-sheet">
      <header class="hero">
        <i class="hero-ic" :style="iconStyle" aria-hidden="true">
          <component :is="app.icon" :size="22" />
        </i>
        <div class="hero-txt">
          <div class="hero-line">
            <h3 class="hero-title">{{ app.title }}</h3>
            <PillChip :tone="statusTone" size="sm" data-testid="connected-app-status">
              {{ statusLabel }}
            </PillChip>
          </div>
          <p class="hero-sub">{{ app.subtitle }}</p>
        </div>
      </header>

      <p v-if="detailText" class="detail">{{ detailText }}</p>
      <p v-if="!status" class="hint">正在检测系统授权…</p>

      <div v-if="errorText" class="err" role="alert" data-testid="connected-app-error">
        <span class="err-txt">{{ errorText }}</span>
        <button
          type="button"
          class="err-retry"
          :disabled="busy !== null"
          data-testid="connected-app-error-retry"
          @click="reconnect"
        >
          重试
        </button>
      </div>

      <!-- 权限：读 / 写分开展示；granted 只表示系统已允许，写入开关表示用户意图 -->
      <section v-if="readPerms.length || writePerms.length" class="block">
        <h3 class="btitle">权限</h3>

        <div v-if="readPerms.length" class="perm-group">
          <h4 class="ptitle">读取</h4>
          <div class="card sub rows">
            <div
              v-for="p in readPerms"
              :key="p.key"
              class="prow"
              :data-testid="`connected-app-permission-${p.key}`"
            >
              <span class="ptxt">
                <b>{{ p.label }}</b>
                <em v-if="!p.required">可选</em>
              </span>
              <PillChip v-if="p.granted" tone="label" size="sm">已允许</PillChip>
              <button
                v-else-if="canAuthorize(p)"
                type="button"
                class="mini"
                :disabled="busy !== null"
                :data-testid="`connected-app-authorize-${p.key}`"
                @click="authorize(p)"
              >
                {{ actionLabel(p) }}
              </button>
              <PillChip v-else tone="muted" size="sm">未允许</PillChip>
            </div>
          </div>
        </div>

        <div v-if="writePerms.length" class="perm-group">
          <h4 class="ptitle">写入</h4>
          <div class="card sub rows">
            <div
              v-for="p in writePerms"
              :key="p.key"
              class="prow"
              :data-testid="`connected-app-permission-${p.key}`"
            >
              <span class="ptxt">
                <b>{{ p.label }}</b>
                <em v-if="!p.required">可选</em>
              </span>
              <PillChip v-if="p.granted" tone="label" size="sm">已允许</PillChip>
              <button
                v-else-if="canAuthorize(p)"
                type="button"
                class="mini"
                :disabled="busy !== null"
                :data-testid="`connected-app-authorize-${p.key}`"
                @click="authorize(p)"
              >
                {{ actionLabel(p) }}
              </button>
              <PillChip v-else tone="muted" size="sm">未允许</PillChip>
            </div>
          </div>
        </div>
      </section>

      <!-- 文件根：filesystem 单树可更换；win-local 可添加/移除；固定目录只展示 -->
      <section v-if="showRoots" class="block">
        <h3 class="btitle">文件范围</h3>
        <div class="card sub roots" data-testid="connected-app-roots">
          <p v-if="roots.length === 0" class="root-empty">
            还没有选择文件夹；连接时需要先选一个。
          </p>
          <div v-for="root in roots" :key="root.id" class="root">
            <span class="root-txt">
              <b>{{ root.label }}</b>
              <em v-if="root.path && root.path !== root.label" class="path">{{ root.path }}</em>
            </span>
            <span class="root-chip" :class="{ rw: root.writable }">
              {{ root.writable ? '可读写' : '只读' }}
            </span>
            <button
              v-if="app.id === 'win-local'"
              type="button"
              class="root-remove"
              :aria-label="`移除 ${root.label}`"
              :data-testid="`connected-app-remove-root-${root.id}`"
              @click="rootToRemove = root"
            >
              <X :size="14" />
            </button>
          </div>
          <button
            v-if="needsFolder"
            type="button"
            class="mini add-folder"
            :disabled="addFolderDisabled"
            data-testid="connected-app-add-folder"
            @click="addFolder"
          >
            <FolderPlus :size="14" />
            {{ addFolderLabel }}
          </button>
        </div>
        <p v-if="roots.some((r) => !r.writable)" class="hint">
          只读文件夹不能写入；需要写回时请换一个可写文件夹。
        </p>
        <p v-if="app.id === 'win-local'" class="hint">最多 5 个根；移除只是撤销 Rein 的访问，不会删除文件。</p>
      </section>

      <!-- 终端：命令以用户身份运行，必须先勾选风险确认才能连接 -->
      <section v-if="isTerminal" class="block">
        <h3 class="btitle">风险说明</h3>
        <div class="warn" data-testid="connected-app-terminal-risk">
          <TriangleAlert :size="16" class="warn-ic" />
          <div class="warn-body">
            <p>命令以你的用户身份运行，能访问你有权限的任何文件；Rein 不能沙箱隔离。</p>
            <p>每次执行都会显示完整命令并单独确认，并写入审计日志。</p>
          </div>
        </div>
        <label v-if="!status?.connected" class="ack">
          <input v-model="terminalAck" type="checkbox" data-testid="connected-app-terminal-ack" />
          <span>我了解命令以我的用户身份运行</span>
        </label>
      </section>

      <!-- 使用说明：权限教程 + 写回边界（文件类会补「删除只支持单文件或空目录」） -->
      <section v-if="tutorialLines.length" class="block">
        <h3 class="btitle">使用说明</h3>
        <ul class="card tutorial" data-testid="connected-app-tutorial">
          <li v-for="line in tutorialLines" :key="line">{{ line }}</li>
        </ul>
      </section>

      <!-- 允许 AI 使用：只在已连接时可用；意图持久化在 app_meta（connected_app_update） -->
      <section class="block">
        <div class="card sub toggle-row">
          <span class="toggle-txt">
            <b>允许 AI 使用</b>
            <em>
              开启后，该应用的工具组会出现在 AI 的【工具装载】目录里，由模型按需装载；
              相关数据会发送给你配置的模型服务商。
            </em>
            <em v-if="app.aiWarning" class="warn-text">{{ app.aiWarning }}</em>
          </span>
          <ToggleSwitch
            :model-value="aiOn"
            label="允许 AI 使用"
            :disabled="aiDisabled"
            data-testid="connected-app-ai-toggle"
            @update:model-value="setAi"
          />
        </div>
      </section>

      <!-- 允许写入：只显示在有写回能力的 app；系统授权与意图分开 -->
      <section v-if="app.writes" class="block">
        <div class="card sub toggle-row">
          <span class="toggle-txt">
            <b>{{ writeLabel }}</b>
            <em>{{ writeHint }}</em>
          </span>
          <ToggleSwitch
            :model-value="writeChecked"
            :label="writeLabel"
            :disabled="writeDisabled"
            data-testid="connected-app-write-toggle"
            @update:model-value="setWrite"
          />
        </div>
        <p v-if="status?.connected && !status.writeAllowed && !writePending" class="hint">
          写入尚未生效：打开开关并完成系统授权后，AI 才能写回。
        </p>
      </section>

      <div class="refresh-row">
        <button
          type="button"
          class="mini"
          :disabled="busy !== null"
          data-testid="connected-app-reconnect"
          @click="reconnect"
        >
          <RefreshCw :size="14" :class="{ spin: busy === 'refresh' }" />
          重新检测
        </button>
        <span class="refresh-note">状态由系统授权与原生能力实时判定</span>
      </div>
    </div>

    <template #footer>
      <div v-if="app" class="footer">
        <div class="footer-btns">
          <button
            type="button"
            class="secondary"
            data-testid="connected-app-sheet-close"
            @click="emit('close')"
          >
            关闭
          </button>
          <button
            v-if="status?.connected"
            type="button"
            class="danger-btn"
            :disabled="busy !== null"
            data-testid="connected-app-disconnect"
            @click="disconnectOpen = true"
          >
            断开连接
          </button>
          <button
            v-else
            type="button"
            class="primary"
            :disabled="!canConnect || busy !== null"
            data-testid="connected-app-connect"
            @click="connect"
          >
            <Loader2 v-if="busy === 'connect'" :size="16" class="spin" />
            {{ connectLabel }}
          </button>
        </div>
        <p v-if="status?.connected" class="foot-note">
          断开后会收回 AI 与写入许可；系统权限仍保留，可在系统设置里撤销。
        </p>
      </div>
    </template>
  </SheetModal>

  <ActionSheet
    :open="disconnectOpen"
    :title="disconnectTitle"
    :actions="disconnectActions"
    @close="disconnectOpen = false"
    @select="disconnect"
  />

  <ActionSheet
    :open="rootToRemove !== null"
    title="移除这个文件夹？"
    :actions="[{ label: '移除', value: 'remove', danger: true }]"
    @close="rootToRemove = null"
    @select="removeRoot"
  />
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

/* ---------- 头部：图标 / 标题 / 副标 / 状态 ---------- */
.hero {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
}

.hero-ic {
  width: 44px;
  height: 44px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-m);
}

.hero-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.hero-line {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex-wrap: wrap;
}

.hero-title {
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
  line-height: var(--lh-title);
}

.hero-sub {
  color: var(--text-2);
  font-size: var(--fs-footnote);
  line-height: var(--lh-caption);
}

.detail {
  color: var(--text-2);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
}

.hint {
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.err {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
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

/* ---------- 分组标题 ---------- */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.btitle {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.ptitle {
  margin-bottom: var(--sp-4);
  padding-left: var(--sp-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.perm-group + .perm-group {
  margin-top: var(--gap-sm);
}

/* 行间细线，首行不留线 */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

.prow {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  min-height: var(--row-h);
  padding: var(--sp-8) 0;
}

.ptxt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.ptxt b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.ptxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 行尾小按钮：视觉 28，热区撑到 44 */
.mini {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.mini::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--hit-min);
  transform: translateY(-50%);
  border-radius: var(--radius-full);
}

.mini:active:not(:disabled) {
  transform: scale(0.97);
}

.mini:disabled {
  opacity: var(--disabled-opacity);
}

/* ---------- 文件根 ---------- */
.roots {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.root {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-height: var(--row-h);
}

.root + .root {
  border-top: 0.5px solid var(--line);
}

.root-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.root-txt b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  overflow-wrap: anywhere;
}

.path {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.root-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.root-chip.rw {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.root-remove {
  position: relative;
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
}

.root-remove::after {
  content: '';
  position: absolute;
  inset: calc(50% - var(--hit-min) / 2) 0;
}

.root-empty {
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.add-folder {
  align-self: flex-start;
  margin-top: var(--sp-4);
}

/* ---------- 终端风险 ---------- */
.warn {
  display: flex;
  gap: var(--gap-sm);
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.warn-ic {
  flex: none;
  margin-top: var(--sp-2);
}

.warn-body p + p {
  margin-top: var(--gap-tight);
}

/* 勾选行：整行可点，热区高度 ≥44 */
.ack {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-height: var(--hit-min);
  font-size: var(--fs-footnote);
  color: var(--text-1);
  cursor: pointer;
}

.ack input {
  flex: none;
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

/* ---------- 教程 ---------- */
.tutorial {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin: 0;
  padding-left: var(--sp-24);
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* ---------- 开关行 ---------- */
.toggle-row {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-md);
  padding: var(--sp-12) var(--pad-inline);
}

.toggle-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.toggle-txt b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.toggle-txt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--text-2);
}

.toggle-txt .warn-text {
  color: var(--text-3);
}

/* ---------- 重新检测 ---------- */
.refresh-row {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex-wrap: wrap;
}

.refresh-note {
  color: var(--text-3);
  font-size: var(--fs-caption);
}

/* ---------- 底栏 ---------- */
.footer {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.footer-btns {
  display: flex;
  gap: var(--gap-sm);
}

.footer-btns > * {
  flex: 1;
}

.secondary,
.primary,
.danger-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-l);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.secondary:active,
.primary:active,
.danger-btn:active {
  transform: scale(0.985);
}

.secondary {
  background: var(--surface-2);
  color: var(--text-1);
}

.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.danger-btn {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.primary:disabled,
.danger-btn:disabled {
  opacity: var(--disabled-opacity);
}

.foot-note {
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  text-align: center;
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}
</style>
