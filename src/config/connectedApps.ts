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

import type { PlatformKey } from '@/utils/platform'

/**
 * 连接应用的声明表（纯数据，不 import Pinia / IPC）。
 *
 * 一张表回答两件事：**每个平台下列哪些行**（`platform`）、**这一行是不是真入口**
 * （`kind` + `route`）。占位行的 `+` / `✓` 只影响 UI，标记存 `localStorage`，
 * 不调用任何命令、不写 SQLite —— 「先把入口摆出来」不是「假装已经接上了」。
 *
 * 只有 Android 健康数据是真实入口；其余清单（Windows 5 条、Mac 2 条、Linux 2 条）
 * 都是占位。iOS 没有可连接项，只有一条页面级说明（见 `CONNECTED_APP_PLATFORM_NOTES`）。
 * **id 一旦被 e2e / 存储引用就不改名**。
 */

/** 可连接的本机平台：`browser` 是运行形态，不承载任何连接行（页面另有一条「当前 浏览器」页签交代预览形态） */
export type ConnectedAppPlatform = Exclude<PlatformKey, 'browser'>

export interface ConnectedApp {
  /** 稳定 slug：e2e 的 `connected-app-<id>` 与占位标记数组都用它 */
  id: string
  platform: ConnectedAppPlatform
  title: string
  subtitle: string
  icon: Component
  /** 模块色变量前缀，如 `--mod-program`（图标章取 `<accent>-soft` / `<accent>-strong`） */
  accent: string
  kind: 'real' | 'placeholder'
  /** 真实落点的路由 name（`router.push({ name: route })`）；占位行为 undefined */
  route?: string
  /** 行内的一句状态说明（权限 / 平台限制），没有就省略 */
  statusHint?: string
}

/** 平台文案（`browser` 用于浏览器预览的「当前 浏览器」页签，不会出现在连接清单里） */
export const PLATFORM_LABELS: Record<PlatformKey, string> = {
  android: 'Android',
  ios: 'iOS',
  mac: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  browser: '浏览器',
}

/** 平台级说明：没有行可列的页签（目前只有 iOS）用它交代「为什么这里是空的」 */
export const CONNECTED_APP_PLATFORM_NOTES: Partial<Record<ConnectedAppPlatform, string>> = {
  ios: 'iOS 版本暂未接入本机数据：健康、日历、提醒等入口会在后续版本陆续开放。',
}

/** 占位标记的持久化键：值是 id 数组（不是 map），读写都在页面层，失败按空数组降级 */
export const CONNECTED_APPS_PLACEHOLDER_KEY = 'rein.connectedApps.placeholder.v1'

/**
 * 兼容键：历史版本 / 外部检查按 `rein.connectedApps.v1` 读取，与主键写同一份 id 数组。
 * 读取时两处取并集，写入时两边都写 —— 任一来源留下的标记在刷新后都还在。
 */
export const CONNECTED_APPS_COMPAT_KEY = 'rein.connectedApps.v1'

/**
 * 全部行。真实行只有 Android 健康数据一条 —— 其余入口都还没接，
 * 必须保持 `kind: 'placeholder'`，不要为了页面对称把占位写成 `/settings/…` 的假跳转。
 */
export const CONNECTED_APPS: readonly ConnectedApp[] = [
  /* ---------- Android ---------- */
  {
    id: 'health',
    platform: 'android',
    title: '健康数据',
    subtitle: '手环 / 运动 App 的记录，经 Health Connect 读写',
    icon: HeartPulse,
    accent: '--danger',
    kind: 'real',
    route: 'settings-health',
    statusHint: '仅在安卓手机上可用',
  },
  {
    id: 'alarm',
    platform: 'android',
    title: '闹钟和计时器',
    subtitle: '设置闹钟，开始倒计时',
    icon: AlarmClock,
    accent: '--mod-sports',
    kind: 'placeholder',
  },
  {
    id: 'usage',
    platform: 'android',
    title: '安卓使用时间',
    subtitle: '分析时间花在哪些应用上',
    icon: Smartphone,
    accent: '--mod-ai',
    kind: 'placeholder',
  },
  {
    id: 'calendar',
    platform: 'android',
    title: '安卓日历',
    subtitle: '查询日程，安排时间',
    icon: CalendarDays,
    accent: '--danger',
    kind: 'placeholder',
  },
  {
    id: 'contacts',
    platform: 'android',
    title: '通讯录',
    subtitle: '找到联系人和联系方式',
    icon: Contact,
    accent: '--mod-program',
    kind: 'placeholder',
  },
  {
    id: 'filesystem',
    platform: 'android',
    title: '安卓文件系统',
    subtitle: '查找手机文件，梳理内容',
    icon: FolderOpen,
    accent: '--mod-ledger',
    kind: 'placeholder',
  },
  {
    id: 'location',
    platform: 'android',
    title: '安卓位置',
    subtitle: '获取当前位置，作为参考',
    icon: MapPin,
    accent: '--mod-campus',
    kind: 'placeholder',
  },
  {
    id: 'notification',
    platform: 'android',
    title: '通知',
    subtitle: '查看通知，梳理重要信息',
    icon: Bell,
    accent: '--mod-ai',
    kind: 'placeholder',
  },
  {
    id: 'sms',
    platform: 'android',
    title: '短信',
    subtitle: '从短信中找到所需信息',
    icon: MessageSquare,
    accent: '--ok',
    kind: 'placeholder',
  },

  /* ---------- Windows ---------- */
  {
    id: 'win-desktop',
    platform: 'windows',
    title: 'Windows 桌面',
    subtitle: '查找桌面文件，梳理内容',
    icon: Monitor,
    accent: '--mod-campus',
    kind: 'placeholder',
  },
  {
    id: 'win-documents',
    platform: 'windows',
    title: 'Windows 文稿',
    subtitle: '查找文档，读懂其中内容',
    icon: FileText,
    accent: '--mod-sports',
    kind: 'placeholder',
  },
  {
    id: 'win-downloads',
    platform: 'windows',
    title: 'Windows 下载',
    subtitle: '查找下载文件，提取重点',
    icon: Download,
    accent: '--mod-ai',
    kind: 'placeholder',
  },
  {
    id: 'win-local',
    platform: 'windows',
    title: 'Windows 本地文件',
    subtitle: '阅读授权文件，梳理内容',
    icon: FolderOpen,
    accent: '--mod-ledger',
    kind: 'placeholder',
  },
  {
    id: 'win-terminal',
    platform: 'windows',
    title: 'Windows 命令行',
    subtitle: '运行命令和脚本，处理任务',
    icon: Terminal,
    accent: '--mod-focus',
    kind: 'placeholder',
  },

  /* ---------- Mac ---------- */
  {
    id: 'mac-terminal',
    platform: 'mac',
    title: 'Mac 命令行',
    subtitle: '运行命令和脚本，处理任务',
    icon: Terminal,
    accent: '--mod-ai',
    kind: 'placeholder',
  },
  {
    id: 'mac-desktop',
    platform: 'mac',
    title: 'Mac 桌面',
    subtitle: '查找桌面文件，梳理内容',
    icon: Monitor,
    accent: '--mod-campus',
    kind: 'placeholder',
  },

  /* ---------- Linux ---------- */
  {
    id: 'linux-desktop',
    platform: 'linux',
    title: 'Linux 桌面',
    subtitle: '查找桌面文件，梳理内容',
    icon: Monitor,
    accent: '--ok',
    kind: 'placeholder',
  },
  {
    id: 'linux-documents',
    platform: 'linux',
    title: 'Linux 文稿',
    subtitle: '查找文档，梳理内容',
    icon: FileText,
    accent: '--mod-sports',
    kind: 'placeholder',
  },
]
