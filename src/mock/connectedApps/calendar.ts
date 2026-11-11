/**
 * 安卓日历 · mock 样例（读 + 写会改动内存事件表）。
 *
 * 与 Kotlin `CalendarOps` 对齐的边界：
 * - 列表按 from/to 过滤，范围 ≤366 天、结果 ≤200；
 * - 单条事件不存在 → `connected_app_not_found`（不返回假成功）；
 * - update 只改给定字段；只给 start 时保持原时长；重复日程作用于整个系列（`recurring`）。
 */
import {
  clampInt,
  fail,
  ok,
  text,
  type MockAppHandler,
  type MockPayload,
} from './shared'

interface MockEvent {
  eventId: string
  calendarId: string
  title: string
  start: string
  end: string
  allDay: boolean
  location: string | null
  description: string | null
  recurring: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RANGE_MS = 366 * DAY_MS
const MAX_EVENT_MS = 30 * DAY_MS

const events: MockEvent[] = [
  {
    eventId: '1',
    calendarId: '1',
    title: '周会',
    start: '2026-11-11T10:00:00+08:00',
    end: '2026-11-11T11:00:00+08:00',
    allDay: false,
    location: '会议室 A',
    description: '同步本周进度',
    recurring: true,
  },
  {
    eventId: '2',
    calendarId: '1',
    title: '午饭',
    start: '2026-11-10T12:00:00+08:00',
    end: '2026-11-10T13:00:00+08:00',
    allDay: false,
    location: null,
    description: null,
    recurring: false,
  },
]

let eventSeq = events.length

function parseTime(raw: unknown): number | null {
  const value = text(raw).trim()
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function findIndex(eventId: unknown): number {
  return events.findIndex((event) => event.eventId === text(eventId).trim())
}

function eventView(event: MockEvent): MockEvent {
  return { ...event }
}

export const calendarMock: MockAppHandler = (app, method, payload: MockPayload) => {
  switch (method) {
    case 'list_calendars':
      return ok(app, method, {
        items: [
          { calendarId: '1', displayName: '本机日历', accountName: 'local', writable: true },
          { calendarId: '2', displayName: '工作日程', accountName: 'mock@example.com', writable: false },
        ],
        count: 2,
      })

    case 'list_calendar_events': {
      const from = parseTime(payload.from)
      const to = parseTime(payload.to)
      if (from === null || to === null) {
        return fail(app, method, 'connected_app_bad_request', 'from/to 必填且必须是合法时间')
      }
      if (to <= from) {
        return fail(app, method, 'connected_app_bad_request', 'to 必须晚于 from')
      }
      if (to - from > MAX_RANGE_MS) {
        return fail(app, method, 'connected_app_bad_request', '查询范围不能超过 366 天')
      }
      const limit = clampInt(payload.limit, 1, 200, 50)
      const calendarId = text(payload.calendarId).trim()
      const filtered = events.filter((event) => {
        if (calendarId && event.calendarId !== calendarId) return false
        const start = Date.parse(event.start)
        const end = Date.parse(event.end)
        return end > from && start < to
      })
      const limited = filtered.slice(0, limit)
      return ok(app, method, {
        events: limited.map((event) => ({
          eventId: event.eventId,
          calendarId: event.calendarId,
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          location: event.location,
          descriptionPreview: (event.description ?? '').slice(0, 200),
          recurring: event.recurring,
        })),
        count: limited.length,
        truncated: filtered.length > limited.length,
      })
    }

    case 'get_calendar_event': {
      const index = findIndex(payload.eventId)
      if (index < 0) {
        return fail(app, method, 'connected_app_not_found', '没有找到这条日程')
      }
      return ok(app, method, {
        event: { ...eventView(events[index]), description: (events[index].description ?? '').slice(0, 2000) },
        recurring: events[index].recurring,
      })
    }

    case 'create_calendar_event': {
      const title = text(payload.title).trim()
      if (!title || title.length > 200) {
        return fail(app, method, 'connected_app_bad_request', 'title 必填且不能超过 200 字')
      }
      const start = parseTime(payload.start)
      const end = parseTime(payload.end)
      if (start === null || end === null) {
        return fail(app, method, 'connected_app_bad_request', 'start/end 必须是合法时间')
      }
      if (end <= start) {
        return fail(app, method, 'connected_app_bad_request', 'end 必须晚于 start')
      }
      if (end - start > MAX_EVENT_MS) {
        return fail(app, method, 'connected_app_bad_request', '单次日程不能超过 30 天')
      }
      const event: MockEvent = {
        eventId: String(++eventSeq),
        calendarId: text(payload.calendarId).trim() || '1',
        title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        allDay: payload.allDay === true,
        location: text(payload.location).trim() || null,
        description: text(payload.description).trim() || null,
        recurring: false,
      }
      events.push(event)
      return ok(app, method, {
        eventId: event.eventId,
        calendarId: event.calendarId,
        event: eventView(event),
      })
    }

    case 'update_calendar_event': {
      const index = findIndex(payload.eventId)
      if (index < 0) {
        return fail(app, method, 'connected_app_not_found', '没有找到这条日程')
      }
      const current = events[index]
      const next: MockEvent = { ...current }
      let changed = false

      if (payload.title !== undefined) {
        const title = text(payload.title).trim()
        if (!title || title.length > 200) {
          return fail(app, method, 'connected_app_bad_request', 'title 必填且不能超过 200 字')
        }
        next.title = title
        changed = true
      }
      if (payload.calendarId !== undefined) {
        next.calendarId = text(payload.calendarId, current.calendarId)
        changed = true
      }

      const hasStart = payload.start !== undefined
      const hasEnd = payload.end !== undefined
      if (hasStart || hasEnd) {
        const currentStart = Date.parse(current.start)
        const currentEnd = Date.parse(current.end)
        const start = hasStart ? parseTime(payload.start) : currentStart
        const end = hasEnd
          ? parseTime(payload.end)
          : start !== null
            ? start + Math.max(currentEnd - currentStart, DAY_MS)
            : null
        if (start === null || end === null) {
          return fail(app, method, 'connected_app_bad_request', 'start/end 必须是合法时间')
        }
        if (end <= start) {
          return fail(app, method, 'connected_app_bad_request', 'end 必须晚于 start')
        }
        if (end - start > MAX_EVENT_MS) {
          return fail(app, method, 'connected_app_bad_request', '单次日程不能超过 30 天')
        }
        next.start = new Date(start).toISOString()
        next.end = new Date(end).toISOString()
        changed = true
      }

      if (payload.allDay !== undefined) {
        next.allDay = payload.allDay === true
        changed = true
      }
      if (payload.location !== undefined) {
        next.location = text(payload.location).trim() || null
        changed = true
      }
      if (payload.description !== undefined) {
        next.description = text(payload.description).trim() || null
        changed = true
      }
      if (!changed) {
        return fail(app, method, 'connected_app_bad_request', '至少提供一个要修改的字段')
      }

      events[index] = next
      return ok(app, method, {
        updated: true,
        event: eventView(next),
        recurring: next.recurring,
      })
    }

    case 'delete_calendar_event': {
      const index = findIndex(payload.eventId)
      if (index < 0) {
        return fail(app, method, 'connected_app_not_found', '没有找到这条日程')
      }
      const [removed] = events.splice(index, 1)
      return ok(app, method, {
        deleted: true,
        eventId: removed.eventId,
        recurring: removed.recurring,
      })
    }

    default:
      return fail(app, method, 'connected_app_unknown_method', `日历不支持方法 ${method}`)
  }
}
