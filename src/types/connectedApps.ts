/**
 * 连接本机应用 · 前端类型契约。
 *
 * 这份文件是 TS / Rust / mock 三方的共同语言：
 * - Rust `modules/connected_apps/models.rs` 用 `#[serde(rename_all = "camelCase")]` 产出同名字段；
 * - mock（`src/mock/connectedApps/*`）用同一套字段组装样例；
 * - 页面与 AI 工具只从这里取类型，不再各自声明一份。
 *
 * 平台类型**只有一份定义**（本文件）；`src/config/connectedApps.ts` 重新导出它，
 * 既有的 `import type { ConnectedAppPlatform } from '@/config/connectedApps'` 仍然可用。
 */

import type { PlatformKey } from '@/utils/platform'

/** 可连接的本机平台；`browser` 是运行形态，不承载连接行。 */
export type ConnectedAppPlatform = Exclude<PlatformKey, 'browser'>

/**
 * 稳定 id：e2e 的 `connected-app-<id>`、`app_meta` 键名、mock 文件名都依赖它。
 * **一旦发布就不要改名**。`health` 走既有的 `health_sync_*`，不经过本域的四个命令。
 */
export type ConnectedAppId =
  | 'health'
  | 'alarm'
  | 'usage'
  | 'calendar'
  | 'contacts'
  | 'filesystem'
  | 'location'
  | 'notification'
  | 'sms'
  | 'win-desktop'
  | 'win-documents'
  | 'win-downloads'
  | 'win-local'
  | 'win-terminal'
  | 'mac-desktop'
  | 'mac-terminal'
  | 'linux-desktop'
  | 'linux-documents'

/** 全部 id，顺序与 Rust `state::APP_SPECS` 一致（health 在首位，便于页面合并）。 */
export const CONNECTED_APP_IDS: readonly ConnectedAppId[] = [
  'health',
  'alarm',
  'usage',
  'calendar',
  'contacts',
  'filesystem',
  'location',
  'notification',
  'sms',
  'win-desktop',
  'win-documents',
  'win-downloads',
  'win-local',
  'win-terminal',
  'mac-desktop',
  'mac-terminal',
  'linux-desktop',
  'linux-documents',
]

export function isConnectedAppId(v: unknown): v is ConnectedAppId {
  return typeof v === 'string' && (CONNECTED_APP_IDS as readonly string[]).includes(v)
}

/** 一个原生 app 的状态真值（与 plan §1.6 的 `Availability` 同义）。 */
export type AppAvailability =
  | 'available'
  | 'partial'
  | 'unavailable'
  | 'unsupported'
  | 'unknown'

/** 拉起系统授权的入口类型。`settings` 是权限被永久拒绝后的兜底页。 */
export type ConnectedAppRequestMode =
  | 'permissions'
  | 'permissions_write'
  | 'usage_access'
  | 'notification_access'
  | 'folder'
  | 'settings'

/** 权限/前置条件在状态里的呈现方式。 */
export type ConnectedAppPermissionKind =
  | 'runtime'
  | 'special'
  | 'normal'
  | 'folder'
  | 'consent'

export interface ConnectedAppPermission {
  /** 与 Kotlin `PermissionMap` / Rust `state::PermissionSpec` 同名 */
  key: string
  label: string
  granted: boolean
  /** true = 连接必需；false = 写入等可选能力 */
  required: boolean
  /** true = 写能力（日历 WRITE_CALENDAR / 通讯录 WRITE_CONTACTS / 短信 SEND_SMS / SAF 写…） */
  write: boolean
  kind: ConnectedAppPermissionKind
  /** UI 点「去授权/去开启」时传给 `connected_app_request` 的 mode；null = 无系统页可拉 */
  action: ConnectedAppRequestMode | null
}

/** 一个可用根（桌面绝对路径只给 UI；AI 侧必须剥离 `path`）。 */
export interface ConnectedAppRoot {
  /** 桌面：`<appId>:<localId>`；手机：`filesystem:default` */
  id: string
  label: string
  /** 仅展示/审计；Android SAF 不返回 URI */
  path?: string
  writable: boolean
}

/**
 * 单个 app 的状态。
 *
 * `granted` / `writable` 是「原生事实」；`enabled` / `connected` / `aiEnabled` /
 * `writeAllowed` 是 Rust 合并 `app_meta` 意图（enabled/AI/写入）与原生能力后的有效值。
 */
export interface ConnectedAppStatus {
  id: ConnectedAppId
  platform: ConnectedAppPlatform
  supported: boolean
  availability: AppAvailability
  /** 用户是否已在原生侧同意连接（`app_meta` 的 `connected_apps.enabled.<app>`） */
  enabled: boolean
  /** enabled && 平台支持 && 系统能力可用 && 必需权限/根齐备 */
  connected: boolean
  /** enabled && connected && 用户允许 AI（Rust 合并 `app_meta` 意图后的有效值） */
  aiEnabled: boolean
  /** enabled && connected && 写入意图 && 原生写能力齐备 */
  writeAllowed: boolean
  /** 必需权限是否全 granted */
  granted: boolean
  /** 原生写能力是否就绪（WRITE_CALENDAR / SEND_SMS / 可写根 / listener / shell） */
  writable: boolean
  permissions: ConnectedAppPermission[]
  roots: ConnectedAppRoot[]
  /** 当前可调用的 native method（读 + 已就绪的写） */
  capabilities: string[]
  /** 一句可展示的原因（unsupported / partial / unknown 时非空） */
  reason: string | null
  /** 原生侧给出的细节（如「没有找到系统日历」） */
  detail: string | null
  lastCheckedAt: string | null
}

/**
 * `connected_app_status` 的返回。
 * `platform` 在浏览器 mock 下是 `'browser'`；Tauri 恒为本机平台。
 */
export interface ConnectedAppsSnapshot {
  platform: ConnectedAppPlatform | 'browser'
  /** true = 浏览器样例数据；Tauri 恒 false */
  mock: boolean
  /** Android 本轮 refresh 尚未落地（UI 可显示「检测中」并重试） */
  refreshing?: boolean
  apps: ConnectedAppStatus[]
}

export interface ConnectedAppRequestResult {
  app: ConnectedAppId
  mode: ConnectedAppRequestMode
  /** 只表示系统 UI/选择器已拉起或选择完成，不表示权限已授予 */
  opened: boolean
  reason?: string | null
  /** `folder` 模式选中的根（仅提示；根已由 request 自己持久化） */
  root?: string | null
}

export interface ConnectedAppInvokeError {
  /** 见 plan §2.9 的错误码表；message 可直接给模型/用户看 */
  code: string
  message: string
  action?: ConnectedAppRequestMode | 'settings' | null
  hint?: string | null
}

export interface ConnectedAppInvokeMeta {
  truncated?: boolean
  count?: number
  mock?: boolean
  audit?: boolean
}

export interface ConnectedAppInvokeReply<T = unknown> {
  ok: boolean
  app: string
  method: string
  data?: T
  error?: ConnectedAppInvokeError
  meta?: ConnectedAppInvokeMeta
}

/**
 * 连接应用命令的通用返回（`request` / `invoke` 的并集）。
 * 具体调用点优先用 `ConnectedAppInvokeReply<T>` / `ConnectedAppRequestResult`。
 */
export type ConnectedAppResult<T = unknown> =
  | ConnectedAppInvokeReply<T>
  | ConnectedAppRequestResult

/** `connected_app_update` 的补丁；`roots` 只对 `win-local` 有意义。 */
export interface ConnectedAppPatch {
  enabled?: boolean
  aiEnabled?: boolean
  writeAllowed?: boolean
  /** 仅 win-local：移除根或手动输入路径（picker 结果不要走这里） */
  roots?: string[]
}

/** method 的读写分类；`control` 留给「取消闹钟/清除通知」这类控制动作。 */
export type ConnectedAppMethodKind = 'read' | 'write' | 'control'

export interface ConnectedAppMethods {
  read: readonly string[]
  write: readonly string[]
}

/**
 * 每个 app 的 native method 常量表（Rust / Kotlin 只认这些名字）。
 *
 * 注意：
 * - 工具名与 native method 多数同名；`list_phone_roots` / `list_desktop_roots`
 *   在工具层映射到 native `files_roots`。
 * - `health` 不在 `connected_app_invoke` 的分发范围，这里只做「既有能力」的说明表，
 *   实际调用走 `health_sync_*`。
 */
export const CONNECTED_APP_METHODS: Record<ConnectedAppId, ConnectedAppMethods> = {
  health: {
    read: ['health_sync_status', 'health_sync_workouts', 'health_metrics_all'],
    write: ['health_sync_set_push'],
  },
  alarm: {
    read: ['alarm_next'],
    write: ['set_alarm', 'set_timer', 'dismiss_alarm', 'dismiss_timer'],
  },
  usage: {
    read: ['get_app_usage', 'get_usage_events'],
    write: [],
  },
  calendar: {
    read: ['list_calendars', 'list_calendar_events', 'get_calendar_event'],
    write: ['create_calendar_event', 'update_calendar_event', 'delete_calendar_event'],
  },
  contacts: {
    read: ['search_contacts', 'get_contact'],
    write: ['create_contact', 'update_contact', 'delete_contact'],
  },
  filesystem: {
    read: ['files_roots', 'files_list', 'read_phone_file', 'search_phone_files'],
    write: ['write_phone_file', 'create_phone_folder', 'delete_phone_file', 'rename_phone_file'],
  },
  location: {
    read: ['get_current_location', 'get_last_known_location'],
    write: [],
  },
  notification: {
    read: ['list_recent_notifications'],
    write: ['dismiss_notification', 'dismiss_all_notifications'],
  },
  sms: {
    read: ['list_sms_threads', 'list_sms_messages', 'search_sms'],
    write: ['send_sms'],
  },
  'win-desktop': {
    read: ['files_roots', 'files_list', 'read_desktop_file', 'search_desktop_files'],
    write: [
      'write_desktop_file',
      'create_desktop_folder',
      'delete_desktop_file',
      'rename_desktop_file',
    ],
  },
  'win-documents': {
    read: ['files_roots', 'files_list', 'read_desktop_file', 'search_desktop_files'],
    write: [
      'write_desktop_file',
      'create_desktop_folder',
      'delete_desktop_file',
      'rename_desktop_file',
    ],
  },
  'win-downloads': {
    read: ['files_roots', 'files_list', 'read_desktop_file', 'search_desktop_files'],
    write: [
      'write_desktop_file',
      'create_desktop_folder',
      'delete_desktop_file',
      'rename_desktop_file',
    ],
  },
  'win-local': {
    read: ['files_roots', 'files_list', 'read_desktop_file', 'search_desktop_files'],
    write: [
      'write_desktop_file',
      'create_desktop_folder',
      'delete_desktop_file',
      'rename_desktop_file',
    ],
  },
  'win-terminal': {
    read: [],
    write: ['run_terminal_command'],
  },
  'mac-desktop': {
    read: ['files_roots', 'files_list', 'read_desktop_file', 'search_desktop_files'],
    write: [
      'write_desktop_file',
      'create_desktop_folder',
      'delete_desktop_file',
      'rename_desktop_file',
    ],
  },
  'mac-terminal': {
    read: [],
    write: ['run_terminal_command'],
  },
  'linux-desktop': {
    read: ['files_roots', 'files_list', 'read_desktop_file', 'search_desktop_files'],
    write: [
      'write_desktop_file',
      'create_desktop_folder',
      'delete_desktop_file',
      'rename_desktop_file',
    ],
  },
  'linux-documents': {
    read: ['files_roots', 'files_list', 'read_desktop_file', 'search_desktop_files'],
    write: [
      'write_desktop_file',
      'create_desktop_folder',
      'delete_desktop_file',
      'rename_desktop_file',
    ],
  },
}

/** method → 读/写分类；未知 method 返回 null（Rust / mock 都据此拒绝）。 */
export function connectedAppMethodKind(
  appId: ConnectedAppId,
  method: string,
): ConnectedAppMethodKind | null {
  const table = CONNECTED_APP_METHODS[appId]
  if (!table) return null
  if (table.read.includes(method)) return 'read'
  if (table.write.includes(method)) return 'write'
  return null
}

export function isKnownConnectedAppMethod(appId: ConnectedAppId, method: string): boolean {
  return connectedAppMethodKind(appId, method) !== null
}
