/**
 * 连接应用状态仓库。
 *
 * 三条纪律：
 * 1. **连接/AI/写许可都只来自原生**：`connected_app_status` 返回的
 *    `enabled/connected/aiEnabled/writeAllowed`（Rust 合并 `app_meta` 意图后计算有效值）
 *    与 `health_sync_status`；localStorage 只用于一次性清理旧键，不冒充任何状态。
 * 2. **health 单独合成**：它不经过 `connected_app_status`，由 `health_sync_status`
 *    映射成同一个 `ConnectedAppStatus`，保持既有健康数据行为。
 * 3. **30 秒缓存**：`ensureLoaded()` 过期才刷；`refresh()` 强制刷。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { CONNECTED_APPS_LEGACY_KEYS } from '@/config/connectedApps'
import { connectedAppService } from '@/services/connectedAppService'
import { healthSyncService } from '@/services/healthSyncService'
import { currentPlatform } from '@/utils/platform'
import type {
  AppAvailability,
  ConnectedAppId,
  ConnectedAppPermission,
  ConnectedAppRequestMode,
  ConnectedAppRequestResult,
  ConnectedAppStatus,
  ConnectedAppsSnapshot,
  HealthSyncStatus,
} from '@/types'

/** status 缓存有效期：页面快速来回切时不重复打原生桥。 */
const STATUS_TTL_MS = 30_000

let legacyKeysCleaned = false

/** 旧占位/AI 前端键只做一次性 removeItem；不做读取/迁移。 */
function cleanupLegacyKeys(): void {
  if (legacyKeysCleaned) return
  legacyKeysCleaned = true
  try {
    for (const key of CONNECTED_APPS_LEGACY_KEYS) localStorage.removeItem(key)
  } catch {
    /* 隐私模式 / 非浏览器环境：没有旧键可清 */
  }
}

/** health_sync 的 availability → 本域的 availability。 */
function healthAvailability(h: HealthSyncStatus): AppAvailability {
  if (!h.supported) return 'unsupported'
  if (h.availability === 'unknown') return 'unknown'
  if (h.availability === 'available') return h.readGranted ? 'available' : 'partial'
  return 'unavailable'
}

/** 把 health_sync_status 映射成统一的 app 状态；没有状态时返回 null（页面显示「检测中」）。 */
function synthesizeHealthStatus(h: HealthSyncStatus | null): ConnectedAppStatus | null {
  if (!h) return null
  const availability = healthAvailability(h)
  const permissions: ConnectedAppPermission[] = [
    {
      key: 'health_read',
      label: 'Health Connect 读取权限',
      granted: h.readGranted,
      required: true,
      write: false,
      kind: 'special',
      action: null,
    },
    {
      key: 'health_write',
      label: 'Health Connect 回写权限',
      granted: h.writeGranted,
      required: false,
      write: true,
      kind: 'consent',
      action: null,
    },
  ]
  const connected = availability === 'available'
  return {
    id: 'health',
    platform: 'android',
    supported: h.supported,
    availability,
    enabled: h.readGranted,
    connected,
    aiEnabled: false,
    writeAllowed: connected && h.writeGranted,
    granted: h.readGranted,
    writable: h.writeGranted,
    permissions,
    roots: [],
    capabilities: ['health_sync_status', 'health_sync_workouts', 'health_metrics_all'],
    reason: connected ? null : h.supported ? '还没有健康数据读取权限' : '当前平台不支持 Health Connect',
    detail: h.availability === 'update_required' ? '需要更新 Health Connect' : null,
    lastCheckedAt: h.lastSyncAt,
  }
}

export const useConnectedAppsStore = defineStore('connectedApps', () => {
  cleanupLegacyKeys()

  /** 17 个原生 app 的状态（不含 health；health 走 healthStatus 合成）。 */
  const statuses = ref<Record<string, ConnectedAppStatus>>({})
  /** health_sync_status 的原始快照（只在 Android / 浏览器 mock 下拉取）。 */
  const healthStatus = ref<HealthSyncStatus | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  let lastLoadedAt = 0
  let inflight: Promise<void> | null = null

  const healthAppStatus = computed(() => synthesizeHealthStatus(healthStatus.value))

  const allStatuses = computed<ConnectedAppStatus[]>(() => {
    const list = Object.values(statuses.value)
    return healthAppStatus.value ? [healthAppStatus.value, ...list] : list
  })

  /** 某个 app 的统一状态；未知 id / 尚未加载返回 null。 */
  function statusFor(id: string): ConnectedAppStatus | null {
    if (id === 'health') return healthAppStatus.value
    return statuses.value[id] ?? null
  }

  /** 已连接 = 原生侧 enabled 且必需前提齐备。 */
  function isConnected(id: string): boolean {
    return statusFor(id)?.connected === true
  }

  /** 允许 AI 使用的**有效值**：直接读原生合成的 `status.aiEnabled`。 */
  function aiEnabled(id: string): boolean {
    return statusFor(id)?.aiEnabled === true
  }

  /**
   * AI 工具组门禁唯一入口：只返回 `status.aiEnabled` 对应的 app。
   * 不要另造 `enabledAppIds()`（会把「已连接但未允许 AI」放进来）。
   */
  function aiEnabledAppIds(): string[] {
    return Object.values(statuses.value)
      .filter((s) => s.aiEnabled)
      .map((s) => s.id)
  }

  /** 切换 AI 使用开关（写 app_meta）；未连接时不允许打开。 */
  async function setAiEnabled(id: string, on: boolean): Promise<boolean> {
    if (on && !isConnected(id)) return false
    try {
      const status = await connectedAppService.update(id as ConnectedAppId, { aiEnabled: on })
      statuses.value = { ...statuses.value, [status.id]: status }
      return status.aiEnabled === on
    } catch (e) {
      setError(e)
      return false
    }
  }

  /** 切换写入意图（有效值由原生根据权限/根计算）；未连接时不允许打开。 */
  async function setWriteAllowed(id: string, on: boolean): Promise<ConnectedAppStatus | null> {
    if (on && !isConnected(id)) return null
    try {
      const status = await connectedAppService.update(id as ConnectedAppId, { writeAllowed: on })
      statuses.value = { ...statuses.value, [status.id]: status }
      return status
    } catch (e) {
      setError(e)
      return null
    }
  }

  function setError(e: unknown): void {
    error.value = e instanceof Error ? e.message : String(e)
  }

  /** 强制刷新：同时拉原生状态与 health 状态；失败保留旧状态并写 error。 */
  function refresh(): Promise<void> {
    if (inflight) return inflight
    loading.value = true
    error.value = null
    const withHealth = currentPlatform() === 'android' || currentPlatform() === 'browser'
    inflight = (async () => {
      try {
        const [snapshot, health] = await Promise.all([
          connectedAppService.status(),
          withHealth ? healthSyncService.status().catch(() => null) : Promise.resolve(null),
        ])
        const next: Record<string, ConnectedAppStatus> = {}
        for (const status of (snapshot as ConnectedAppsSnapshot).apps) {
          // aiEnabled/writeAllowed 已由 Rust 合并 app_meta 意图与原生能力计算。
          next[status.id] = { ...status }
        }
        statuses.value = next
        if (health) healthStatus.value = health
        lastLoadedAt = Date.now()
      } catch (e) {
        setError(e)
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  /** 只在缓存过期或还没加载时刷新；页面 onMounted / AI 发送前都可安全调用。 */
  async function ensureLoaded(): Promise<void> {
    if (lastLoadedAt > 0 && Date.now() - lastLoadedAt < STATUS_TTL_MS) return
    await refresh()
  }

  /** 记录连接同意；成功后同步本地状态并强刷。 */
  async function setEnabled(id: string, enabled: boolean): Promise<boolean> {
    if (id === 'health') return false
    try {
      const status = await connectedAppService.setEnabled(id as ConnectedAppId, enabled)
      statuses.value = { ...statuses.value, [status.id]: status }
      // 断开时原生已清 AI/写意图；仍强刷一次拿最新权限/根状态。
      await refresh()
      return true
    } catch (e) {
      setError(e)
      return false
    }
  }

  /** 拉起系统授权页/选择器；不写连接同意。 */
  async function request(
    id: string,
    mode: ConnectedAppRequestMode,
  ): Promise<ConnectedAppRequestResult | null> {
    if (id === 'health') return null
    try {
      const result = await connectedAppService.request(id as ConnectedAppId, mode)
      await refresh()
      return result
    } catch (e) {
      setError(e)
      return null
    }
  }

  return {
    statuses,
    healthStatus,
    loading,
    error,
    allStatuses,
    statusFor,
    isConnected,
    aiEnabled,
    aiEnabledAppIds,
    setAiEnabled,
    setWriteAllowed,
    refresh,
    ensureLoaded,
    setEnabled,
    request,
  }
})
