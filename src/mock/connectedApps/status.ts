/**
 * 浏览器 mock 的状态机：17 条样例状态 + 开关 + 根 + 授权入口。
 *
 * 与 Rust `state::build_status` 用同一套公式复算
 * `connected / aiEnabled / writeAllowed`（意图 × 原生前提到位）。
 * 这里不做「假连接」：`enabled` 默认 false，点连接（`connected_app_update`）后才变 true。
 */

import { CONNECTED_APPS } from '@/config/connectedApps'
import type {
  AppAvailability,
  ConnectedAppPermission,
  ConnectedAppRequestMode,
  ConnectedAppRequestResult,
  ConnectedAppRoot,
  ConnectedAppStatus,
  ConnectedAppsSnapshot,
  ConnectedAppPatch,
} from '@/types'
import { CONNECTED_APP_METHODS } from '@/types'

/** 文件类 app 的写能力取决于根是否可写；其它 app 取决于写权限。 */
const FILE_APPS = new Set([
  'filesystem',
  'win-desktop',
  'win-documents',
  'win-downloads',
  'win-local',
  'mac-desktop',
  'linux-desktop',
  'linux-documents',
])

/** 浏览器预览里所有 app 都「系统能力可用」；授权结果也预先给足，便于 UI 迭代。 */
const enabled = new Map<string, boolean>()
const granted = new Map<string, boolean>()
const roots = new Map<string, ConnectedAppRoot[]>()
const aiIntent = new Map<string, boolean>()
const writeIntent = new Map<string, boolean>()

function defaultRoots(id: string): ConnectedAppRoot[] {
  switch (id) {
    case 'filesystem':
      return [{ id: 'filesystem:default', label: 'Demo 文档', writable: true }]
    case 'win-desktop':
      return [{ id: 'win-desktop:default', label: '桌面', path: 'C:\\Users\\Mock\\Desktop', writable: true }]
    case 'win-documents':
      return [{ id: 'win-documents:default', label: '文稿', path: 'C:\\Users\\Mock\\Documents', writable: true }]
    case 'win-downloads':
      return [{ id: 'win-downloads:default', label: '下载', path: 'C:\\Users\\Mock\\Downloads', writable: true }]
    case 'win-local':
      return [{ id: 'win-local:default', label: 'C:\\Users\\Mock\\Projects', path: 'C:\\Users\\Mock\\Projects', writable: true }]
    case 'mac-desktop':
      return [{ id: 'mac-desktop:default', label: '桌面', path: '/Users/mock/Desktop', writable: true }]
    case 'linux-desktop':
      return [{ id: 'linux-desktop:default', label: '桌面', path: '/home/mock/Desktop', writable: true }]
    case 'linux-documents':
      return [{ id: 'linux-documents:default', label: '文稿', path: '/home/mock/Documents', writable: true }]
    default:
      return []
  }
}

for (const app of CONNECTED_APPS) {
  if (app.id !== 'health') roots.set(app.id, defaultRoots(app.id))
}

function appConfig(id: string) {
  return CONNECTED_APPS.find((a) => a.id === id)
}

function isGranted(appId: string, key: string): boolean {
  return granted.get(`${appId}:${key}`) ?? true
}

function permissionsFor(appId: string): ConnectedAppPermission[] {
  const app = appConfig(appId)
  if (!app) return []
  const read = app.permissions.read.map((p) => ({
    key: p.key,
    label: p.label,
    granted: isGranted(appId, p.key),
    required: p.required ?? true,
    write: false,
    kind: p.kind,
    action: p.action,
  }))
  const write = app.permissions.write.map((p) => ({
    key: p.key,
    label: p.label,
    granted: isGranted(appId, p.key),
    required: p.required ?? false,
    write: true,
    kind: p.kind,
    action: p.action,
  }))
  return [...read, ...write]
}

export function mockStatusFor(appId: string): ConnectedAppStatus | null {
  const app = appConfig(appId)
  if (!app || app.id === 'health') return null
  const perms = permissionsFor(appId)
  const requiredOk = perms.filter((p) => p.required).every((p) => p.granted)
  const appRoots = roots.get(appId) ?? []
  const needsRoot = appId === 'filesystem' || appId === 'win-local'
  let availability: AppAvailability = 'available'
  if (!requiredOk) availability = 'partial'
  else if (needsRoot && appRoots.length === 0) availability = 'partial'

  const supported = true
  const isEnabled = enabled.get(appId) === true
  const connected = isEnabled && supported && availability === 'available'
  // 原生写能力：文件类看可写根，其它看写权限是否授予。
  const writeGranted = perms.filter((p) => p.write).every((p) => p.granted)
  const writable =
    app.writes && (FILE_APPS.has(app.id) ? appRoots.some((r) => r.writable) : writeGranted)
  const aiEnabled = connected && aiIntent.get(appId) === true
  const writeAllowed = connected && writeIntent.get(appId) === true && writable
  const methods = CONNECTED_APP_METHODS[app.id]
  return {
    id: app.id,
    platform: app.platform,
    supported,
    availability,
    enabled: isEnabled,
    connected,
    aiEnabled,
    writeAllowed,
    granted: requiredOk,
    writable,
    permissions: perms,
    roots: appRoots,
    capabilities: [...methods.read, ...(writeAllowed ? methods.write : [])],
    reason: availability === 'partial' ? '缺少必要权限或文件夹（mock 可点「去授权」）' : null,
    detail: null,
    lastCheckedAt: new Date().toISOString(),
  }
}

/** 17 条样例状态（不含 health）。 */
export function mockConnectedAppStatus(): ConnectedAppsSnapshot {
  const apps = CONNECTED_APPS.filter((a) => a.id !== 'health')
    .map((a) => mockStatusFor(a.id))
    .filter((s): s is ConnectedAppStatus => s !== null)
  return { platform: 'browser', mock: true, apps }
}

export function mockConnectedAppSetEnabled(
  appId: string,
  isEnabled: boolean,
): ConnectedAppStatus {
  const app = appConfig(appId)
  if (!app || app.id === 'health') throw new Error(`未知连接应用：${appId}`)
  enabled.set(appId, isEnabled)
  return mockStatusFor(appId) as ConnectedAppStatus
}

/** 对应 `connected_app_update`；enabled/AI/写意图与 Rust 的 app_meta 同口径。 */
export function mockConnectedAppUpdate(
  appId: string,
  patch: ConnectedAppPatch,
): ConnectedAppStatus {
  const app = appConfig(appId)
  if (!app || app.id === 'health') throw new Error(`未知连接应用：${appId}`)
  if (patch.enabled !== undefined) {
    enabled.set(appId, patch.enabled)
    if (!patch.enabled) {
      aiIntent.set(appId, false)
      writeIntent.set(appId, false)
    }
  }
  if (patch.aiEnabled !== undefined) {
    if (patch.aiEnabled && enabled.get(appId) !== true) {
      throw new Error('请先连接该应用，再开启 AI 使用')
    }
    aiIntent.set(appId, patch.aiEnabled)
  }
  if (patch.writeAllowed !== undefined) {
    if (patch.writeAllowed && enabled.get(appId) !== true) {
      throw new Error('请先连接该应用，再开启写入许可')
    }
    writeIntent.set(appId, patch.writeAllowed)
  }
  if (patch.roots !== undefined) {
    if (appId !== 'win-local') throw new Error('roots 只用于 win-local')
    roots.set(
      appId,
      patch.roots.slice(0, 5).map((p, i) => ({
        id: `win-local:${i}`,
        label: p,
        path: p,
        writable: true,
      })),
    )
  }
  const status = mockStatusFor(appId)
  if (!status) throw new Error(`未知连接应用：${appId}`)
  return status
}

/** 对应 `connected_app_request`；mock 直接返回「已打开/已选择」，并把结果反映到状态。 */
export function mockConnectedAppRequest(
  appId: string,
  mode: ConnectedAppRequestMode,
): ConnectedAppRequestResult {
  const app = appConfig(appId)
  if (!app || app.id === 'health') throw new Error(`未知连接应用：${appId}`)

  if (mode === 'folder') {
    if (appId === 'filesystem') {
      const root: ConnectedAppRoot = { id: 'filesystem:default', label: 'Demo 文档（已选择）', writable: true }
      roots.set(appId, [root])
      return { app: app.id, mode, opened: true, root: root.label }
    }
    if (appId === 'win-local') {
      const index = (roots.get(appId) ?? []).length
      const path = `C:\\Users\\Mock\\Picked${index + 1}`
      const root: ConnectedAppRoot = { id: `win-local:${index}`, label: path, path, writable: true }
      roots.set(appId, [...(roots.get(appId) ?? []), root].slice(0, 5))
      return { app: app.id, mode, opened: true, root: path }
    }
    return { app: app.id, mode, opened: false, reason: '该应用使用固定系统文件夹，无需选择' }
  }

  if (mode === 'permissions') {
    for (const p of app.permissions.read) {
      if (p.kind === 'runtime') granted.set(`${appId}:${p.key}`, true)
    }
    return { app: app.id, mode, opened: true }
  }

  if (mode === 'permissions_write') {
    for (const p of app.permissions.write) granted.set(`${appId}:${p.key}`, true)
    return { app: app.id, mode, opened: true }
  }

  if (mode === 'usage_access' || mode === 'notification_access') {
    return { app: app.id, mode, opened: true }
  }

  if (mode === 'settings') {
    return { app: app.id, mode, opened: true }
  }

  return { app: app.id, mode, opened: false, reason: '浏览器 mock 不会打开系统页面' }
}

/** e2e / 单元测试复位。 */
export function resetMockConnectedApps(): void {
  enabled.clear()
  granted.clear()
  aiIntent.clear()
  writeIntent.clear()
  for (const app of CONNECTED_APPS) {
    if (app.id !== 'health') roots.set(app.id, defaultRoots(app.id))
  }
}
