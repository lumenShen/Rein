/** 位置 · mock 样例（只给坐标，不反查地址）。 */
import { ok, sampleIso, type MockAppHandler } from './shared'

const POINT = {
  latitude: 31.2304,
  longitude: 121.4737,
  accuracy: 25,
  time: null as string | null,
  provider: 'mock',
}

export const locationMock: MockAppHandler = (app, method, payload) => {
  switch (method) {
    case 'get_current_location': {
      const raw = Number(payload.timeoutMs ?? payload.timeout_ms ?? 8000)
      const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1000), 15000) : 8000
      const highAccuracy = payload.highAccuracy ?? payload.high_accuracy ?? true
      return ok(app, method, {
        ...POINT,
        time: sampleIso(),
        stale: false,
        timeout: false,
        elapsedMs: 0,
        timeoutMs,
        highAccuracy: Boolean(highAccuracy),
      })
    }
    case 'get_last_known_location':
      return ok(app, method, { ...POINT, time: sampleIso(-30 * 60 * 1000), stale: true, timeout: false, elapsedMs: 0 })
    default:
      return ok(app, method, {})
  }
}
