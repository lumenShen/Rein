/**
 * 通知工具（读取 + 仅清除）。
 *
 * 边界：不代发、不回复、不修改通知内容。清除是写操作，逐次弹确认；
 * 常驻/不可清除/自身包的通知会跳过并计入 skipped。key 必须来自
 * `list_recent_notifications`，不要自己拼。
 */

import { Type } from '@earendil-works/pi-ai'

import { callConnectedApp, callConnectedAppWrite, withMeta } from './connectedApps'
import { defineTool, type AppTool } from './types'

interface NotificationItem {
  key: string
  packageName: string
  appLabel: string
  title: string
  text: string
  postedAt: string
  ongoing: boolean
  clearable: boolean
  category: string | null
  active: boolean
}

interface NotificationListResult {
  items: NotificationItem[]
  count: number
  truncated?: boolean
}

interface DismissResult {
  cleared: boolean
  skipped: number
}

interface DismissAllResult {
  cleared: number
  skipped: number
}

const SINCE = Type.Optional(
  Type.Union(
    [
      Type.String({ description: 'ISO-8601 时间，如 2026-11-10T12:00:00+08:00' }),
      Type.Number({ description: '毫秒时间戳' }),
    ],
    { description: '只返回这个时间之后发布的通知' },
  ),
)

export const tools: AppTool[] = [
  defineTool({
    name: 'list_recent_notifications',
    group: 'appNotification',
    label: '查看最近通知',
    description:
      '查看当前还在展示的通知与最近历史（只读）。`limit` 1..50（默认 20），`app` 可按包名或应用名' +
      '过滤（≤128 字符），`since` 接受 ISO 时间或毫秒时间戳。标题/正文各截断 500 字；' +
      '已跳过 Rein 自身通知、FLAG_SECURE 与 group summary。通知内容隐私敏感，按需查询。',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: '最多返回条数 1..50，默认 20' })),
      app: Type.Optional(
        Type.String({ description: '按包名或应用名过滤，如 com.tencent.mm / 微信', maxLength: 128 }),
      ),
      since: SINCE,
    }),
    async execute(args) {
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 50)
      const app = args.app?.trim()
      const payload: Record<string, unknown> = { limit }
      if (app) payload.app = app
      if (args.since !== undefined && args.since !== null) payload.since = args.since
      return withMeta(
        await callConnectedApp<NotificationListResult>(
          'notification',
          'list_recent_notifications',
          payload,
        ),
      )
    },
  }),

  defineTool({
    name: 'dismiss_notification',
    group: 'appNotification',
    label: '清除一条通知',
    description:
      '清除一条通知（写操作，逐次确认）。key 必须来自 list_recent_notifications；' +
      '常驻或不可清除的通知会被跳过（cleared:false, skipped:1）。清除后无法恢复；' +
      '不能代发或回复通知。用户拒绝确认就停手，不要换 key 重试。',
    parameters: Type.Object({
      key: Type.String({
        description: '通知 key，必须原样来自 list_recent_notifications',
        minLength: 1,
        maxLength: 256,
      }),
    }),
    dangerous: true,
    async execute(args) {
      const key = args.key.trim()
      return withMeta(
        await callConnectedAppWrite<DismissResult>(
          'notification',
          'dismiss_notification',
          { key },
          {
            title: '清除通知',
            body: `将清除这条通知：${key}\n清除后无法恢复；常驻/不可清除的通知会跳过。`,
            danger: true,
            summary: `dismiss_notification key=${key}`,
          },
        ),
      )
    },
  }),

  defineTool({
    name: 'dismiss_all_notifications',
    group: 'appNotification',
    label: '清除全部通知',
    description:
      '清除当前所有可清除的通知（写操作，逐次确认）。只清非 ongoing、可清除、非 Rein 自身的通知；' +
      '返回 cleared/skipped 计数。清除后无法恢复；不能代发或回复通知。',
    parameters: Type.Object({}),
    dangerous: true,
    async execute() {
      return withMeta(
        await callConnectedAppWrite<DismissAllResult>(
          'notification',
          'dismiss_all_notifications',
          {},
          {
            title: '清除全部通知',
            body: '将清除当前所有可清除的通知。\n常驻/不可清除的通知会跳过；清除后无法恢复。',
            danger: true,
            summary: 'dismiss_all_notifications',
          },
        ),
      )
    },
  }),
]

export const appNotificationTools = tools
