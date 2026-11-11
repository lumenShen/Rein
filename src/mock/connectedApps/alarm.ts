/**
 * 闹钟和计时器 · mock 样例。
 *
 * 只返回「已向系统时钟发出请求」（`dispatched`），不冒充时钟应用真的设置成功；
 * `set_alarm`/`set_timer` 是写方法，写许可/权限拒绝由 `index.ts` 的统一门禁处理。
 */
import { clampInt, fail, ok, sampleIso, text, type MockAppHandler } from './shared'

export const alarmMock: MockAppHandler = (app, method, payload) => {
  switch (method) {
    case 'alarm_next':
      return ok(app, method, {
        at: sampleIso(8 * 60 * 60 * 1000),
        package: 'com.android.deskclock',
        label: '起床',
      })
    case 'set_alarm': {
      const hour = clampInt(payload.hour, 0, 23, 7)
      const minute = clampInt(payload.minute, 0, 59, 30)
      const days = Array.isArray(payload.days)
        ? payload.days
            .map((d) => clampInt(d, 1, 7, 1))
            .filter((d, i, arr) => arr.indexOf(d) === i)
            .slice(0, 7)
        : []
      return ok(app, method, {
        dispatched: true,
        hour,
        minute,
        label: text(payload.label) || null,
        days,
        vibrate: payload.vibrate !== false,
        skipUi: payload.skipUi !== false,
      })
    }
    case 'set_timer':
      return ok(app, method, {
        dispatched: true,
        seconds: clampInt(payload.seconds, 1, 86400, 300),
        label: text(payload.label) || null,
        skipUi: payload.skipUi !== false,
      })
    case 'dismiss_alarm':
    case 'dismiss_timer':
      return ok(app, method, {
        dispatched: true,
        mode: text(payload.mode) === 'all' ? 'all' : 'next',
      })
    default:
      return fail(app, method, 'connected_app_unknown_method', `闹钟不支持方法 ${method}`)
  }
}
