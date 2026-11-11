/**
 * 安卓使用时间工具（只读）。
 *
 * 系统没有写接口：这里只有按包汇总的 `get_app_usage` 与前后台切换事件
 * `get_usage_events`。汇总上限按 plan §1.2：`since_hours ≤ 744`、`limit ≤ 50`；
 * 事件 `days ≤ 7`、`limit ≤ 200`。OEM 可能返回空数据——空结果只代表读不到。
 */

import { Type } from '@earendil-works/pi-ai'

import { callConnectedApp, withMeta } from './connectedApps'
import { defineTool, type AppTool } from './types'

interface AppUsageSummary {
  sinceHours: number
  since: string
  approx: boolean
  totalTimeInForegroundMs: number
  apps: Array<{
    packageName: string
    appLabel: string
    totalTimeInForegroundMs: number
    lastTimeUsed: string | null
  }>
  count: number
  truncated?: boolean
}

interface AppUsageDetail {
  packageName: string
  appLabel: string
  found: boolean
  sinceHours: number
  since: string
  totalTimeInForegroundMs: number
  lastTimeUsed: string | null
}

interface UsageEventsResult {
  days: number
  since: string
  events: Array<{
    packageName: string
    appLabel: string
    type: string
    at: string
  }>
  count: number
  truncated?: boolean
}

/** 单包模式与汇总模式共用 native `get_app_usage`，由 payload.package 分流。 */
const PACKAGE = Type.Optional(
  Type.String({
    description: '可选：只查这个包名（如 com.tencent.mm），返回单应用明细而不是 top 列表',
    maxLength: 128,
  }),
)

export const tools: AppTool[] = [
  defineTool({
    name: 'get_app_usage',
    group: 'appUsage',
    label: '查看使用时间',
    description:
      '查看安卓应用前台使用时长（只读）。按包聚合 `totalTimeInForeground`，结果 `approx:true`；' +
      '`since_hours` 最多 744（31 天），`limit` 最多 50，默认回看 7 天、返回 20 个应用。' +
      '传 `package` 时只返回该应用的最近使用时间与前台时长。OEM 可能返回空数据；' +
      '空结果只代表系统读不到，不等于没有使用。',
    parameters: Type.Object({
      days: Type.Optional(
        Type.Number({ description: '回看天数 1..31，默认 7；与 since_hours 同时给时以 since_hours 为准' }),
      ),
      since_hours: Type.Optional(
        Type.Number({ description: '回看小时数 1..744（31 天）；给出时优先于 days' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: '返回应用数 1..50，默认 20（汇总模式）' }),
      ),
      package: PACKAGE,
    }),
    async execute(args) {
      const days = Math.min(Math.max(Math.trunc(args.days ?? 7), 1), 31)
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 50)
      const sinceHours =
        args.since_hours === undefined
          ? undefined
          : Math.min(Math.max(Math.trunc(args.since_hours), 1), 744)
      const packageName = args.package?.trim()
      const payload: Record<string, unknown> = { days, limit }
      if (sinceHours !== undefined) payload.since_hours = sinceHours
      if (packageName) payload.package = packageName
      return withMeta(
        await callConnectedApp<AppUsageSummary | AppUsageDetail>('usage', 'get_app_usage', payload),
      )
    },
  }),

  defineTool({
    name: 'get_usage_events',
    group: 'appUsage',
    label: '查看使用事件',
    description:
      '查看最近的应用切换前台/后台事件（只读）。`days` 1..7（默认 1），`limit` 1..200（默认 100）；' +
      '事件类型为 ACTIVITY_RESUMED/ACTIVITY_PAUSED（旧系统为 MOVE_TO_FOREGROUND/BACKGROUND）。' +
      '只返回时间点与包名，不含页面内容；隐私敏感，按需查询不要一次拉全量。',
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: '回看天数 1..7，默认 1' })),
      limit: Type.Optional(Type.Number({ description: '最多返回条数 1..200，默认 100' })),
    }),
    async execute(args) {
      const days = Math.min(Math.max(Math.trunc(args.days ?? 1), 1), 7)
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 100), 1), 200)
      return withMeta(
        await callConnectedApp<UsageEventsResult>('usage', 'get_usage_events', { days, limit }),
      )
    },
  }),
]

export const appUsageTools = tools
