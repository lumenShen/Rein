/**
 * 位置工具（只读）。
 *
 * 只返回坐标/精度/时间/来源，不反查地址、不联网、不记录轨迹。
 * 一次定位最长等 15s；超时会回退到最后已知位置（`stale:true`、`timeout:true`），
 * 连最后位置都没有时才报 `connected_app_timeout`。
 */

import { Type } from '@earendil-works/pi-ai'

import { callConnectedApp, withMeta } from './connectedApps'
import { defineTool, type AppTool } from './types'

interface LocationFix {
  latitude: number | null
  longitude: number | null
  accuracy: number | null
  time: string | null
  provider: string | null
  stale: boolean
  timeout?: boolean
  elapsedMs?: number
}

export const tools: AppTool[] = [
  defineTool({
    name: 'get_current_location',
    group: 'appLocation',
    label: '获取当前位置',
    description:
      '获取一次当前位置（只读）。`timeoutMs` 1000..15000（默认 8000），`highAccuracy` 默认 true。' +
      '只返回 lat/lng/accuracy/time/provider；不反查地址、不联网。超时会回退到最后已知位置' +
      '（stale:true, timeout:true）；完全拿不到位置才报连接应用超时错误，可重试一次。',
    parameters: Type.Object({
      timeoutMs: Type.Optional(
        Type.Number({ description: '等待定位的毫秒数 1000..15000，默认 8000' }),
      ),
      highAccuracy: Type.Optional(
        Type.Boolean({ description: '是否优先 GPS 高精度，默认 true；false 时优先网络定位' }),
      ),
    }),
    async execute(args) {
      const timeoutMs = Math.min(Math.max(Math.trunc(args.timeoutMs ?? 8000), 1000), 15000)
      const highAccuracy = args.highAccuracy ?? true
      return withMeta(
        await callConnectedApp<LocationFix>('location', 'get_current_location', {
          timeoutMs,
          highAccuracy,
        }),
      )
    },
  }),

  defineTool({
    name: 'get_last_known_location',
    group: 'appLocation',
    label: '查看最后位置',
    description:
      '读取系统缓存的最后已知位置（只读，可能为 null）。`stale:true` 表示不是刚采集的坐标；' +
      '不反查地址、不记录轨迹。需要实时位置时用 get_current_location。',
    parameters: Type.Object({}),
    async execute() {
      return withMeta(
        await callConnectedApp<LocationFix>('location', 'get_last_known_location', {}),
      )
    },
  }),
]

export const appLocationTools = tools
