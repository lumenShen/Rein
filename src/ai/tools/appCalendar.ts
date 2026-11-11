/**
 * 安卓日历工具（`appCalendar`，Android CalendarContract）。
 *
 * 能力边界（plan §1.2 / §13.1）：
 * - 读：可见日历、区间日程（≤366 天、≤200 条）、单条事件；
 * - 写：新建/修改/删除，逐个弹确认（`dangerous: true` 只是 UI 红标，触发器是
 *   `callConnectedAppWrite` 里的 `askToolConfirm`）；
 * - 重复日程的修改/删除**作用于整个系列**，确认文案必须写清；
 * - 标题 ≤200、地点 ≤200、描述 ≤2000、单次日程 ≤30 天。
 */

import { Type } from '@earendil-works/pi-ai'

import {
  assertAppReady,
  callConnectedApp,
  callConnectedAppWrite,
  ConnectedAppToolError,
  withMeta,
} from './connectedApps'
import { defineTool, type AppTool } from './types'

const APP = 'calendar'
type JsonObject = Record<string, unknown>

interface CalendarItem {
  calendarId: string
  displayName: string
  accountName?: string
  writable?: boolean
}

interface CalendarEvent {
  eventId: string
  calendarId: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string | null
  description?: string | null
  descriptionPreview?: string | null
  recurring?: boolean
}

const TimeParam = (field: string) =>
  Type.String({
    minLength: 1,
    maxLength: 64,
    description: `${field}：ISO 时间（如 2026-11-11T10:00:00+08:00）或 YYYY-MM-DD`,
  })

async function readCalendarLabel(calendarId?: string): Promise<string> {
  if (!calendarId) return '主可写日历（由系统选择）'
  try {
    const { data } = await callConnectedApp<{ items?: CalendarItem[] }>(APP, 'list_calendars')
    const hit = (data.items ?? []).find((c) => c.calendarId === calendarId)
    return hit ? `${hit.displayName}（#${hit.calendarId}）` : `日历 #${calendarId}`
  } catch {
    return `日历 #${calendarId}`
  }
}

async function getEvent(eventId: string): Promise<CalendarEvent> {
  const { data } = await callConnectedApp<{ event?: CalendarEvent | null }>(
    APP,
    'get_calendar_event',
    { eventId },
  )
  if (!data.event) {
    throw new ConnectedAppToolError(
      'connected_app_not_found',
      `没有找到这条日程（eventId=${eventId}）`,
    )
  }
  return data.event
}

function preview(value: string | null | undefined, max = 120): string {
  const text = (value ?? '').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export const calendarTools: AppTool[] = [
  defineTool({
    name: 'list_calendars',
    group: 'appCalendar',
    label: '列出日历',
    description:
      '只读：列出本机可见日历（calendarId、显示名、账户、是否可写）。写日程前先用它确认目标日历。',
    parameters: Type.Object({}),
    async execute() {
      await assertAppReady(APP)
      return withMeta(await callConnectedApp<JsonObject>(APP, 'list_calendars'))
    },
  }),

  defineTool({
    name: 'list_calendar_events',
    group: 'appCalendar',
    label: '查询日程',
    description:
      '只读：按时间区间列出日程（事件 id、日历 id、标题、起止、全天、地点、描述预览、是否重复）。区间 ≤366 天，结果 ≤200 条；只返回可见日历里的事件。',
    parameters: Type.Object({
      from: TimeParam('开始'),
      to: TimeParam('结束'),
      calendarId: Type.Optional(
        Type.String({ maxLength: 64, description: '只查某个日历（来自 list_calendars）' }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, description: '最多返回多少条，默认 50' }),
      ),
    }),
    async execute(args) {
      await assertAppReady(APP)
      return withMeta(
        await callConnectedApp<JsonObject>(APP, 'list_calendar_events', {
          from: args.from,
          to: args.to,
          ...(args.calendarId ? { calendarId: args.calendarId } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      )
    },
  }),

  defineTool({
    name: 'get_calendar_event',
    group: 'appCalendar',
    label: '查看日程',
    description: '只读：按 eventId 读取单条日程（描述 ≤2000 字）；事件不存在时返回 connected_app_not_found。',
    parameters: Type.Object({
      eventId: Type.String({ minLength: 1, maxLength: 64, description: '日程 id（来自 list）' }),
    }),
    async execute(args) {
      await assertAppReady(APP)
      return withMeta(
        await callConnectedApp<JsonObject>(APP, 'get_calendar_event', { eventId: args.eventId }),
      )
    },
  }),

  defineTool({
    name: 'create_calendar_event',
    group: 'appCalendar',
    label: '新建日程',
    description:
      '写：在指定或主可写日历里新建日程。标题 ≤200、地点 ≤200、描述 ≤2000、单次日程 ≤30 天；calendarId 缺省由系统选择主可写日历。执行前会弹一次确认；返回 eventId 与写入后的事件。',
    parameters: Type.Object({
      calendarId: Type.Optional(
        Type.String({ maxLength: 64, description: '目标日历 id；不传 = 主可写日历' }),
      ),
      title: Type.String({ minLength: 1, maxLength: 200, description: '标题（≤200 字）' }),
      start: TimeParam('开始'),
      end: TimeParam('结束'),
      allDay: Type.Optional(Type.Boolean({ description: '是否全天事件' })),
      location: Type.Optional(Type.String({ maxLength: 200, description: '地点（≤200 字）' })),
      description: Type.Optional(
        Type.String({ maxLength: 2_000, description: '描述/备注（≤2000 字）' }),
      ),
      timezone: Type.Optional(
        Type.String({ maxLength: 64, description: '时区 id，如 Asia/Shanghai；不传 = 系统时区' }),
      ),
    }),
    dangerous: true,
    async execute(args) {
      await assertAppReady(APP, { write: true })
      const calendarLabel = await readCalendarLabel(args.calendarId)
      const body = [
        '动作：新建日程',
        `日历：${calendarLabel}`,
        `标题：${args.title}`,
        `时间：${args.start} → ${args.end}${args.allDay ? '（全天）' : ''}`,
        args.location ? `地点：${args.location}` : '',
        args.description ? `描述：${preview(args.description)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      return withMeta(
        await callConnectedAppWrite<JsonObject>(
          APP,
          'create_calendar_event',
          args,
          {
            title: '新建日程',
            body,
            summary: `create_calendar_event calendar=${args.calendarId ?? 'default'}`,
          },
        ),
      )
    },
  }),

  defineTool({
    name: 'update_calendar_event',
    group: 'appCalendar',
    label: '修改日程',
    description:
      '写：只修改给定字段（标题/起止/全天/地点/描述/时区）；只给 start 时保持原时长。重复日程的修改作用于整个系列。执行前会弹一次确认。',
    parameters: Type.Object({
      eventId: Type.String({ minLength: 1, maxLength: 64, description: '要修改的日程 id' }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      start: Type.Optional(TimeParam('新的开始')),
      end: Type.Optional(TimeParam('新的结束')),
      allDay: Type.Optional(Type.Boolean()),
      location: Type.Optional(Type.String({ maxLength: 200 })),
      description: Type.Optional(Type.String({ maxLength: 2_000 })),
      timezone: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    dangerous: true,
    async execute(args) {
      await assertAppReady(APP, { write: true })
      const current = await getEvent(args.eventId)
      const changes: string[] = []
      if (args.title !== undefined) changes.push(`标题 → ${args.title}`)
      if (args.start !== undefined) changes.push(`开始 → ${args.start}`)
      if (args.end !== undefined) changes.push(`结束 → ${args.end}`)
      if (args.allDay !== undefined) changes.push(`全天 → ${args.allDay ? '是' : '否'}`)
      if (args.location !== undefined) changes.push(`地点 → ${args.location || '（清空）'}`)
      if (args.description !== undefined) {
        changes.push(`描述 → ${preview(args.description) || '（清空）'}`)
      }
      if (args.timezone !== undefined) changes.push(`时区 → ${args.timezone}`)
      if (changes.length === 0) {
        throw new ConnectedAppToolError(
          'connected_app_bad_request',
          '至少提供一个要修改的字段（title/start/end/allDay/location/description/timezone）',
        )
      }
      const lines = [
        '动作：修改日程',
        `日程：${current.title || '（无标题）'}（#${current.eventId}）`,
        `当前：${current.start} → ${current.end}`,
        '修改：',
        ...changes.map((line) => `- ${line}`),
      ]
      if (current.recurring) {
        lines.push('', '警告：这是重复日程，修改会作用于整个系列。')
      }
      return withMeta(
        await callConnectedAppWrite<JsonObject>(APP, 'update_calendar_event', args, {
          title: '修改日程',
          body: lines.join('\n'),
          danger: Boolean(current.recurring),
          summary: `update_calendar_event event=${current.eventId} fields=${changes.length}`,
        }),
      )
    },
  }),

  defineTool({
    name: 'delete_calendar_event',
    group: 'appCalendar',
    label: '删除日程',
    description:
      '写：删除单条日程；重复日程的删除作用于整个系列，无法恢复。执行前会弹一次确认。',
    parameters: Type.Object({
      eventId: Type.String({ minLength: 1, maxLength: 64, description: '要删除的日程 id' }),
    }),
    dangerous: true,
    async execute(args) {
      await assertAppReady(APP, { write: true })
      const current = await getEvent(args.eventId)
      const lines = [
        '动作：删除日程',
        `日程：${current.title || '（无标题）'}（#${current.eventId}）`,
        `时间：${current.start} → ${current.end}`,
      ]
      if (current.recurring) {
        lines.push('', '警告：这是重复日程，删除会作用于整个系列，无法恢复。')
      } else {
        lines.push('', '警告：删除后无法恢复。')
      }
      return withMeta(
        await callConnectedAppWrite<JsonObject>(
          APP,
          'delete_calendar_event',
          { eventId: args.eventId },
          {
            title: '删除日程',
            body: lines.join('\n'),
            danger: true,
            summary: `delete_calendar_event event=${current.eventId} recurring=${Boolean(current.recurring)}`,
          },
        ),
      )
    },
  }),
]

export const tools = calendarTools
export const appCalendarTools = calendarTools
