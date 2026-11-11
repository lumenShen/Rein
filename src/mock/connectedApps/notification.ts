/** 通知 · mock 样例（读取 + 清除；不能代发/回复）。 */
import {
  clampInt,
  fail,
  ok,
  sampleIso,
  text,
  type MockAppHandler,
  type MockPayload,
} from './shared'

interface MockNotification {
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

const MAX_FIELD_CHARS = 500
const MAX_FILTER_CHARS = 128
const MAX_KEY_CHARS = 256

let notifications: MockNotification[] = [
  {
    key: 'mock:1',
    packageName: 'com.android.deskclock',
    appLabel: '时钟',
    title: '闹钟',
    text: '明天 07:30',
    postedAt: sampleIso(-5 * 60 * 1000),
    ongoing: false,
    clearable: true,
    category: 'alarm',
    active: true,
  },
  {
    key: 'mock:2',
    packageName: 'com.tencent.mm',
    appLabel: '微信',
    title: '张三',
    text: '晚上一起吃饭吗？',
    postedAt: sampleIso(-2 * 60 * 1000),
    ongoing: false,
    clearable: true,
    category: 'msg',
    active: true,
  },
  {
    key: 'mock:3',
    packageName: 'com.android.systemui',
    appLabel: '系统界面',
    title: '正在运行',
    text: '常驻通知不可清除',
    postedAt: sampleIso(-60 * 1000),
    ongoing: true,
    clearable: false,
    category: 'service',
    active: true,
  },
]

function parseSince(raw: unknown): number | null | 'bad' {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : 'bad'
  }
  if (typeof raw === 'string') {
    const millis = Date.parse(raw)
    return Number.isFinite(millis) ? millis : 'bad'
  }
  return 'bad'
}

export const notificationMock: MockAppHandler = (app, method, payload: MockPayload) => {
  switch (method) {
    case 'list_recent_notifications': {
      const limit = clampInt(payload.limit, 1, 50, 20)
      const filter = text(payload.app ?? payload.package ?? payload.packageName).trim()
      if (filter.length > MAX_FILTER_CHARS) {
        return fail(app, method, 'connected_app_bad_request', 'app 过滤条件过长')
      }
      const query = text(payload.query).trim()
      if (query.length > 64) {
        return fail(app, method, 'connected_app_bad_request', 'query 最多 64 个字符')
      }
      const since = parseSince(payload.since)
      if (since === 'bad') {
        return fail(app, method, 'connected_app_bad_request', 'since 不是合法的时间')
      }
      const matched = notifications
        .filter((n) => since === null || Date.parse(n.postedAt) >= since)
        .filter(
          (n) =>
            !filter ||
            n.packageName.toLowerCase().includes(filter.toLowerCase()) ||
            n.appLabel.toLowerCase().includes(filter.toLowerCase()) ||
            n.title.toLowerCase().includes(filter.toLowerCase()) ||
            n.text.toLowerCase().includes(filter.toLowerCase()),
        )
        .filter(
          (n) =>
            !query ||
            n.title.toLowerCase().includes(query.toLowerCase()) ||
            n.text.toLowerCase().includes(query.toLowerCase()) ||
            n.appLabel.toLowerCase().includes(query.toLowerCase()) ||
            n.packageName.toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt))
      const items = matched.slice(0, limit).map((n) => ({
        ...n,
        title: n.title.slice(0, MAX_FIELD_CHARS),
        text: n.text.slice(0, MAX_FIELD_CHARS),
      }))
      return ok(app, method, {
        items,
        count: items.length,
        truncated: matched.length > items.length,
      })
    }
    case 'dismiss_notification': {
      const key = text(payload.key).trim()
      if (!key || key.length > MAX_KEY_CHARS) {
        return fail(app, method, 'connected_app_bad_request', 'key 必须为 1..256 个字符')
      }
      const target = notifications.find((n) => n.key === key)
      if (!target) {
        return fail(app, method, 'connected_app_not_found', '通知不存在或已被清除')
      }
      if (target.ongoing || !target.clearable) {
        return ok(app, method, { cleared: false, skipped: 1 })
      }
      notifications = notifications.filter((n) => n.key !== key)
      return ok(app, method, { cleared: true, skipped: 0 })
    }
    case 'dismiss_all_notifications': {
      let cleared = 0
      let skipped = 0
      notifications = notifications.filter((n) => {
        if (n.ongoing || !n.clearable) {
          skipped += 1
          return true
        }
        cleared += 1
        return false
      })
      return ok(app, method, { cleared, skipped })
    }
    default:
      return ok(app, method, {})
  }
}
