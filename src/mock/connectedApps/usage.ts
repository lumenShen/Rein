/** 安卓使用时间 · mock 样例（只读；approx 表示按天聚合）。 */
import { clampInt, ok, sampleIso, text, type MockAppHandler } from './shared'

interface MockUsageApp {
  packageName: string
  appLabel: string
  totalTimeInForegroundMs: number
  lastTimeUsed: string
}

const APPS: MockUsageApp[] = [
  {
    packageName: 'com.tencent.mm',
    appLabel: '微信',
    totalTimeInForegroundMs: 3_600_000,
    lastTimeUsed: sampleIso(-2 * 60 * 60 * 1000),
  },
  {
    packageName: 'com.android.chrome',
    appLabel: 'Chrome',
    totalTimeInForegroundMs: 1_800_000,
    lastTimeUsed: sampleIso(-5 * 60 * 60 * 1000),
  },
  {
    packageName: 'com.android.deskclock',
    appLabel: '时钟',
    totalTimeInForegroundMs: 120_000,
    lastTimeUsed: sampleIso(-6 * 60 * 60 * 1000),
  },
]

export const usageMock: MockAppHandler = (app, method, payload) => {
  switch (method) {
    case 'get_app_usage': {
      const days = clampInt(payload.days, 1, 31, 7)
      const sinceHours =
        payload.since_hours === undefined
          ? Math.min(days * 24, 744)
          : clampInt(payload.since_hours, 1, 744, Math.min(days * 24, 744))
      const packageName = text(payload.package ?? payload.packageName).trim()

      if (packageName) {
        const found = APPS.find(
          (item) =>
            item.packageName === packageName || item.appLabel === packageName,
        )
        return ok(app, method, {
          packageName,
          appLabel: found?.appLabel ?? packageName,
          found: Boolean(found),
          sinceHours,
          since: sampleIso(-sinceHours * 60 * 60 * 1000),
          totalTimeInForegroundMs: found?.totalTimeInForegroundMs ?? 0,
          lastTimeUsed: found?.lastTimeUsed ?? null,
        })
      }

      const limit = clampInt(payload.limit, 1, 50, 20)
      const apps = APPS.slice(0, limit)
      return ok(app, method, {
        sinceHours,
        since: sampleIso(-sinceHours * 60 * 60 * 1000),
        approx: true,
        totalTimeInForegroundMs: APPS.reduce(
          (sum, item) => sum + item.totalTimeInForegroundMs,
          0,
        ),
        apps,
        count: apps.length,
        truncated: APPS.length > apps.length,
      })
    }
    case 'get_usage_events': {
      const days = clampInt(payload.days, 1, 7, 1)
      const limit = clampInt(payload.limit, 1, 200, 100)
      const events = [
        {
          packageName: 'com.tencent.mm',
          appLabel: '微信',
          type: 'ACTIVITY_RESUMED',
          at: sampleIso(-10 * 60 * 1000),
        },
        {
          packageName: 'com.tencent.mm',
          appLabel: '微信',
          type: 'ACTIVITY_PAUSED',
          at: sampleIso(-9 * 60 * 1000),
        },
        {
          packageName: 'com.android.chrome',
          appLabel: 'Chrome',
          type: 'ACTIVITY_RESUMED',
          at: sampleIso(-8 * 60 * 1000),
        },
      ]
      const items = events.slice(0, limit)
      return ok(app, method, {
        days,
        since: sampleIso(-days * 24 * 60 * 60 * 1000),
        events: items,
        count: items.length,
        truncated: events.length > items.length,
      })
    }
    default:
      return ok(app, method, {})
  }
}
