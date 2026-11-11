import type { Component } from 'vue'
import {
  AlarmClock,
  Bell,
  CalendarDays,
  Contact,
  Download,
  FileText,
  FolderOpen,
  HeartPulse,
  MapPin,
  MessageSquare,
  Monitor,
  Smartphone,
  Terminal,
} from 'lucide-vue-next'

import type { ToolGroup } from '@/ai/tools/types'
import type {
  ConnectedAppId,
  ConnectedAppPermissionKind,
  ConnectedAppPlatform,
  ConnectedAppRequestMode,
} from '@/types/connectedApps'

/**
 * 连接应用的声明表（纯数据，不 import Pinia / IPC）。
 *
 * 这张表只回答「每个平台下列哪些行、每行是什么能力、需要哪些权限」；
 * **真实状态一律来自 `connected_app_status`（health 来自 `health_sync_status`）**，
 * 不再用 localStorage 的 `+ / ✓` 冒充连接。
 *
 * 18 条 = health（既有路由入口）+ 17 个原生应用：
 * Android 8 + Windows 5 + Mac 2 + Linux 2。iOS 没有构建目标，只有页面级说明。
 * **id 一旦被 e2e / 存储引用就不改名**。
 */

/** 可连接的本机平台：定义在 `types/connectedApps.ts`，这里重新导出以兼容既有 import。 */
export type { ConnectedAppPlatform } from '@/types/connectedApps'

/**
 * 条目类型：`native` = 由 `connected_app_status` 驱动的真实本机应用；
 * `route` = 既有页面入口（health）。
 */
export type ConnectedAppKind = 'native' | 'route'

/** 权限声明：status 里的 `granted` 由原生事实补齐，这里只写静态文案与入口。 */
export interface ConnectedAppPermissionDecl {
  /** 与 Kotlin `PermissionMap` / Rust `state::PermissionSpec` 同名 */
  key: string
  label: string
  /** 连接必需（默认 true） */
  required?: boolean
  kind: ConnectedAppPermissionKind
  /** UI 点「去授权/去开启」时用的 request mode；null = 无系统页可拉 */
  action: ConnectedAppRequestMode | null
}

export interface ConnectedAppPermissions {
  read: readonly ConnectedAppPermissionDecl[]
  write: readonly ConnectedAppPermissionDecl[]
}

export interface ConnectedApp {
  /** 稳定 slug：e2e 的 `connected-app-<id>` 与 store 的 key 都用它 */
  id: ConnectedAppId
  platform: ConnectedAppPlatform
  title: string
  subtitle: string
  icon: Component
  /** 模块色变量前缀，如 `--mod-program`（图标章取 `<accent>-soft` / `<accent>-strong`） */
  accent: string
  kind: ConnectedAppKind
  /** 该 app 的 AI 工具组（health 走既有 health_sync，不挂 AI 工具组） */
  toolGroup?: ToolGroup
  /** 读 / 写权限标签；写权限的 key 与 Rust/Kotlin allowlist 同名 */
  permissions: ConnectedAppPermissions
  /** 是否具备写回能力（决定抽屉是否显示「允许写入」） */
  writes: boolean
  /** 真实落点的路由 name（health）；原生行为 undefined */
  route?: string
  /** 行内的一句状态说明（权限 / 平台限制），没有就省略 */
  statusHint?: string
  /** 抽屉里的权限教程（逐条） */
  tutorial?: readonly string[]
  /** 允许 AI 使用前必须看到的隐私提示 */
  aiWarning?: string
}

/** 平台文案（`browser` 用于浏览器预览的「当前 浏览器」页签，不会出现在连接清单里） */
export const PLATFORM_LABELS: Record<ConnectedAppPlatform | 'browser', string> = {
  android: 'Android',
  ios: 'iOS',
  mac: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  browser: '浏览器',
}

/** 平台级说明：没有行可列的页签（目前只有 iOS）用它交代「为什么这里是空的」 */
export const CONNECTED_APP_PLATFORM_NOTES: Partial<Record<ConnectedAppPlatform, string>> = {
  ios: 'iOS 尚未支持连接本机应用：当前版本没有 iOS 构建目标，健康、日历、提醒等入口都不会出现在这里。',
}

/**
 * @deprecated 旧占位标记键：只允许 store 初始化时 `removeItem` 一次，不再读写。
 * 页面里旧的 MARK_KEYS 分支等授权界面员改造后删除。
 */
export const CONNECTED_APPS_PLACEHOLDER_KEY = 'rein.connectedApps.placeholder.v1'

/** @deprecated 同上：历史兼容键，只做一次性清理。 */
export const CONNECTED_APPS_COMPAT_KEY = 'rein.connectedApps.v1'

/**
 * @deprecated 早期版本的 AI 开关键；现在 AI 意图存 `app_meta`（`connected_app_update`），
 * 该键只在 store 初始化时清理一次。
 */
export const CONNECTED_APPS_AI_KEY = 'rein.connectedApps.ai.v1'

/** store 初始化时要清掉的旧键（含早期 AI 前端键）。 */
export const CONNECTED_APPS_LEGACY_KEYS = [
  CONNECTED_APPS_PLACEHOLDER_KEY,
  CONNECTED_APPS_COMPAT_KEY,
  CONNECTED_APPS_AI_KEY,
] as const

/* ---------------- 可复用的权限声明 ---------------- */

const HEALTH_READ: readonly ConnectedAppPermissionDecl[] = [
  {
    key: 'health_read',
    label: 'Health Connect 读取权限',
    kind: 'special',
    action: null,
  },
]

const HEALTH_WRITE: readonly ConnectedAppPermissionDecl[] = [
  {
    key: 'health_write',
    label: 'Health Connect 回写权限',
    required: false,
    kind: 'consent',
    action: null,
  },
]

const DESKTOP_READ_FIXED: readonly ConnectedAppPermissionDecl[] = [
  { key: 'folder_read', label: '读取系统文件夹', kind: 'folder', action: null },
]

const DESKTOP_WRITE_FIXED: readonly ConnectedAppPermissionDecl[] = [
  {
    key: 'folder_write',
    label: '写入系统文件夹',
    required: false,
    kind: 'folder',
    action: null,
  },
]

const LOCAL_READ: readonly ConnectedAppPermissionDecl[] = [
  { key: 'folder_read', label: '读取授权文件夹（SAF / 选择器）', kind: 'folder', action: 'folder' },
]

const LOCAL_WRITE: readonly ConnectedAppPermissionDecl[] = [
  {
    key: 'folder_write',
    label: '写入授权文件夹（SAF 读写）',
    required: false,
    kind: 'folder',
    action: 'folder',
  },
]

const TERMINAL_READ: readonly ConnectedAppPermissionDecl[] = [
  { key: 'shell', label: '系统 shell 可用', kind: 'normal', action: null },
]

const TERMINAL_WRITE: readonly ConnectedAppPermissionDecl[] = [
  {
    key: 'terminal_exec',
    label: '执行命令（每次确认）',
    required: false,
    kind: 'consent',
    action: null,
  },
]

/* ---------------- 全部行 ---------------- */

export const CONNECTED_APPS: readonly ConnectedApp[] = [
  /* ---------- Android ---------- */
  {
    id: 'health',
    platform: 'android',
    title: '健康数据',
    subtitle: '手环 / 运动 App 的记录，经 Health Connect 读写',
    icon: HeartPulse,
    accent: '--danger',
    kind: 'route',
    permissions: { read: HEALTH_READ, write: HEALTH_WRITE },
    writes: true,
    route: 'settings-health',
    statusHint: '仅在安卓手机上可用',
    tutorial: [
      '健康数据由 Health Connect 管理：授权页由 Health Connect 自己弹出，不在 Rein 里申请。',
      '打开「回写 Health Connect」后，Rein 里新建的记录也会写进系统健康数据。',
    ],
    aiWarning: '允许 AI 使用后，健康数据摘要会发送给你配置的模型服务商。',
  },
  {
    id: 'alarm',
    platform: 'android',
    title: '闹钟和计时器',
    subtitle: '设置闹钟，开始倒计时',
    icon: AlarmClock,
    accent: '--mod-sports',
    kind: 'native',
    toolGroup: 'appAlarm',
    permissions: {
      read: [{ key: 'clock_app', label: '系统时钟可用', kind: 'normal', action: null }],
      write: [
        {
          key: 'clock_write',
          label: '修改闹钟和计时器',
          required: false,
          kind: 'consent',
          action: null,
        },
      ],
    },
    writes: true,
    tutorial: [
      'Android 没有公开的闹钟读取接口；Rein 只能读「下一个闹钟」和设置/取消，不能列出全部。',
      '设置结果以系统时钟为准；部分厂商的时钟 App 会忽略「不显示界面」。',
    ],
    aiWarning: '允许 AI 使用后，闹钟/计时器操作会发送给你配置的模型服务商。',
  },
  {
    id: 'usage',
    platform: 'android',
    title: '安卓使用时间',
    subtitle: '分析时间花在哪些应用上',
    icon: Smartphone,
    accent: '--mod-ai',
    kind: 'native',
    toolGroup: 'appUsage',
    permissions: {
      read: [
        {
          key: 'usage_access',
          label: '使用情况访问权限',
          kind: 'special',
          action: 'usage_access',
        },
      ],
      write: [],
    },
    writes: false,
    tutorial: [
      '使用时间没有系统权限弹窗：点「去开启」后在系统列表里找到 Rein，打开「使用情况访问权限」。',
      '不同厂商可能返回空数据；空结果只代表读不到，不代表没有使用。',
    ],
    aiWarning: '允许 AI 使用后，应用使用时长会发送给你配置的模型服务商。',
  },
  {
    id: 'calendar',
    platform: 'android',
    title: '安卓日历',
    subtitle: '查询日程，安排时间',
    icon: CalendarDays,
    accent: '--danger',
    kind: 'native',
    toolGroup: 'appCalendar',
    permissions: {
      read: [
        {
          key: 'read_calendar',
          label: '读取日历（READ_CALENDAR）',
          kind: 'runtime',
          action: 'permissions',
        },
      ],
      write: [
        {
          key: 'write_calendar',
          label: '写入日历（WRITE_CALENDAR）',
          required: false,
          kind: 'runtime',
          action: 'permissions_write',
        },
      ],
    },
    writes: true,
    tutorial: [
      '点「去授权」后在系统弹窗选择允许；如果之前选过「不再询问」，请到系统设置 → 应用 → Rein → 权限里开启。',
      '查询只读；新建/修改/删除前会弹确认。重复日程的修改/删除会作用于整个系列。',
    ],
    aiWarning: '允许 AI 使用后，日程标题、时间与描述会发送给你配置的模型服务商。',
  },
  {
    id: 'contacts',
    platform: 'android',
    title: '通讯录',
    subtitle: '找到联系人和联系方式',
    icon: Contact,
    accent: '--mod-program',
    kind: 'native',
    toolGroup: 'appContacts',
    permissions: {
      read: [
        {
          key: 'read_contacts',
          label: '读取通讯录（READ_CONTACTS）',
          kind: 'runtime',
          action: 'permissions',
        },
      ],
      write: [
        {
          key: 'write_contacts',
          label: '写入通讯录（WRITE_CONTACTS）',
          required: false,
          kind: 'runtime',
          action: 'permissions_write',
        },
      ],
    },
    writes: true,
    tutorial: [
      '写操作逐次确认；新建一次一个联系人，修改数组会整组替换。',
      '删除会同步到已登录账户；云端账户的联系人可能改不动。',
    ],
    aiWarning: '允许 AI 使用后，联系人姓名、电话与邮箱会发送给你配置的模型服务商。',
  },
  {
    id: 'filesystem',
    platform: 'android',
    title: '安卓文件系统',
    subtitle: '查找手机文件，梳理内容',
    icon: FolderOpen,
    accent: '--mod-ledger',
    kind: 'native',
    toolGroup: 'appPhoneFiles',
    permissions: {
      read: [
        {
          key: 'saf_tree',
          label: '授权文件夹（SAF 读取）',
          kind: 'folder',
          action: 'folder',
        },
      ],
      write: [
        {
          key: 'saf_tree_write',
          label: '写入授权文件夹（SAF 读写）',
          required: false,
          kind: 'folder',
          action: 'folder',
        },
      ],
    },
    writes: true,
    tutorial: [
      '选择一个文件夹；Rein 只能读写该文件夹及子文件夹，不能越过根。',
      '断开连接会释放系统持久授权；需要重新选择文件夹。',
    ],
    aiWarning: '允许 AI 使用后，授权文件夹里的文件内容会发送给你配置的模型服务商。',
  },
  {
    id: 'location',
    platform: 'android',
    title: '安卓位置',
    subtitle: '获取当前位置，作为参考',
    icon: MapPin,
    accent: '--mod-campus',
    kind: 'native',
    toolGroup: 'appLocation',
    permissions: {
      read: [
        {
          key: 'location',
          label: '位置权限（精确 / 大致）',
          kind: 'runtime',
          action: 'permissions',
        },
      ],
      write: [],
    },
    writes: false,
    tutorial: [
      '点「去授权」后在系统弹窗选择允许；只授大致位置时仍可使用，但精度较低。',
      'Rein 只返回坐标与精度，不反查地址、不记录轨迹。',
    ],
    aiWarning: '允许 AI 使用后，当前位置坐标会发送给你配置的模型服务商。',
  },
  {
    id: 'notification',
    platform: 'android',
    title: '通知',
    subtitle: '查看通知，梳理重要信息',
    icon: Bell,
    accent: '--mod-ai',
    kind: 'native',
    toolGroup: 'appNotification',
    permissions: {
      read: [
        {
          key: 'notification_access',
          label: '通知使用权',
          kind: 'special',
          action: 'notification_access',
        },
      ],
      write: [
        {
          key: 'notification_dismiss',
          label: '清除通知',
          required: false,
          kind: 'consent',
          action: null,
        },
      ],
    },
    writes: true,
    tutorial: [
      '点「去开启」后在「通知使用权」里允许 Rein；只能读开启之后收到的通知。',
      '清除通知逐次确认；常驻/不可清除的通知会跳过。Rein 不能代发或回复通知。',
    ],
    aiWarning: '允许 AI 使用后，通知标题与正文会发送给你配置的模型服务商。',
  },
  {
    id: 'sms',
    platform: 'android',
    title: '短信',
    subtitle: '从短信中找到所需信息',
    icon: MessageSquare,
    accent: '--ok',
    kind: 'native',
    toolGroup: 'appSms',
    permissions: {
      read: [
        {
          key: 'read_sms',
          label: '读取短信（READ_SMS）',
          kind: 'runtime',
          action: 'permissions',
        },
      ],
      write: [
        {
          key: 'send_sms',
          label: '发送短信（SEND_SMS）',
          required: false,
          kind: 'runtime',
          action: 'permissions_write',
        },
      ],
    },
    writes: true,
    tutorial: [
      '只能读取和发送；不会标记已读、不会删除会话，也不读 MMS。',
      '发送前会确认收件人和正文，可能产生运营商费用；不承诺送达。',
    ],
    aiWarning: '允许 AI 使用后，短信正文与号码会发送给你配置的模型服务商。',
  },

  /* ---------- Windows ---------- */
  {
    id: 'win-desktop',
    platform: 'windows',
    title: 'Windows 桌面',
    subtitle: '查找桌面文件，梳理内容',
    icon: Monitor,
    accent: '--mod-campus',
    kind: 'native',
    toolGroup: 'appDesktopFiles',
    permissions: { read: DESKTOP_READ_FIXED, write: DESKTOP_WRITE_FIXED },
    writes: true,
    tutorial: ['只读写系统桌面目录；删除只支持单文件或空目录，不进回收站。'],
    aiWarning: '允许 AI 使用后，桌面文件内容会发送给你配置的模型服务商。',
  },
  {
    id: 'win-documents',
    platform: 'windows',
    title: 'Windows 文稿',
    subtitle: '查找文档，读懂其中内容',
    icon: FileText,
    accent: '--mod-sports',
    kind: 'native',
    toolGroup: 'appDesktopFiles',
    permissions: { read: DESKTOP_READ_FIXED, write: DESKTOP_WRITE_FIXED },
    writes: true,
    tutorial: ['只读写系统文稿目录；写操作逐次确认。'],
    aiWarning: '允许 AI 使用后，文稿内容会发送给你配置的模型服务商。',
  },
  {
    id: 'win-downloads',
    platform: 'windows',
    title: 'Windows 下载',
    subtitle: '查找下载文件，提取重点',
    icon: Download,
    accent: '--mod-ai',
    kind: 'native',
    toolGroup: 'appDesktopFiles',
    permissions: { read: DESKTOP_READ_FIXED, write: DESKTOP_WRITE_FIXED },
    writes: true,
    tutorial: ['只读写系统下载目录；写操作逐次确认。'],
    aiWarning: '允许 AI 使用后，下载文件内容会发送给你配置的模型服务商。',
  },
  {
    id: 'win-local',
    platform: 'windows',
    title: 'Windows 本地文件',
    subtitle: '阅读授权文件，梳理内容',
    icon: FolderOpen,
    accent: '--mod-ledger',
    kind: 'native',
    toolGroup: 'appDesktopFiles',
    permissions: { read: LOCAL_READ, write: LOCAL_WRITE },
    writes: true,
    tutorial: [
      '只能读写你选中的文件夹；最多 5 个根，可随时移除。',
      '不会授权整个用户目录或磁盘根；删除只支持单文件或空目录。',
    ],
    aiWarning: '允许 AI 使用后，授权文件夹里的文件内容会发送给你配置的模型服务商。',
  },
  {
    id: 'win-terminal',
    platform: 'windows',
    title: 'Windows 命令行',
    subtitle: '运行命令和脚本，处理任务',
    icon: Terminal,
    accent: '--mod-focus',
    kind: 'native',
    toolGroup: 'appTerminal',
    permissions: { read: TERMINAL_READ, write: TERMINAL_WRITE },
    writes: true,
    tutorial: [
      '命令以你的用户身份运行，能访问你有权限的任何文件；Rein 不能沙箱隔离。',
      '每次执行都会显示完整命令并单独确认，并写入审计日志。',
    ],
    aiWarning: '允许 AI 使用后，命令与输出会发送给你配置的模型服务商。',
  },

  /* ---------- Mac ---------- */
  {
    id: 'mac-desktop',
    platform: 'mac',
    title: 'Mac 桌面',
    subtitle: '查找桌面文件，梳理内容',
    icon: Monitor,
    accent: '--mod-campus',
    kind: 'native',
    toolGroup: 'appDesktopFiles',
    permissions: { read: DESKTOP_READ_FIXED, write: DESKTOP_WRITE_FIXED },
    writes: true,
    tutorial: ['只读写系统桌面目录；Mac 行为尚未在本机验证。'],
    aiWarning: '允许 AI 使用后，桌面文件内容会发送给你配置的模型服务商。',
  },
  {
    id: 'mac-terminal',
    platform: 'mac',
    title: 'Mac 命令行',
    subtitle: '运行命令和脚本，处理任务',
    icon: Terminal,
    accent: '--mod-ai',
    kind: 'native',
    toolGroup: 'appTerminal',
    permissions: { read: TERMINAL_READ, write: TERMINAL_WRITE },
    writes: true,
    tutorial: ['命令以你的用户身份运行；Mac 行为尚未在本机验证。'],
    aiWarning: '允许 AI 使用后，命令与输出会发送给你配置的模型服务商。',
  },

  /* ---------- Linux ---------- */
  {
    id: 'linux-desktop',
    platform: 'linux',
    title: 'Linux 桌面',
    subtitle: '查找桌面文件，梳理内容',
    icon: Monitor,
    accent: '--ok',
    kind: 'native',
    toolGroup: 'appDesktopFiles',
    permissions: { read: DESKTOP_READ_FIXED, write: DESKTOP_WRITE_FIXED },
    writes: true,
    tutorial: ['只读写系统桌面目录；Linux 行为尚未在本机验证。'],
    aiWarning: '允许 AI 使用后，桌面文件内容会发送给你配置的模型服务商。',
  },
  {
    id: 'linux-documents',
    platform: 'linux',
    title: 'Linux 文稿',
    subtitle: '查找文档，梳理内容',
    icon: FileText,
    accent: '--mod-sports',
    kind: 'native',
    toolGroup: 'appDesktopFiles',
    permissions: { read: DESKTOP_READ_FIXED, write: DESKTOP_WRITE_FIXED },
    writes: true,
    tutorial: ['只读写系统文稿目录；Linux 行为尚未在本机验证。'],
    aiWarning: '允许 AI 使用后，文稿内容会发送给你配置的模型服务商。',
  },
]

/** 按平台取行（页面页签用）。 */
export function connectedAppsForPlatform(platform: ConnectedAppPlatform): ConnectedApp[] {
  return CONNECTED_APPS.filter((app) => app.platform === platform)
}

/** 按 id 取声明；未知 id 返回 undefined（native 返回脏数据时不要崩）。 */
export function connectedAppById(id: string): ConnectedApp | undefined {
  return CONNECTED_APPS.find((app) => app.id === id)
}
