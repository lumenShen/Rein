/**
 * 连接应用 mock 分发出口。
 *
 * `src/mock/server.ts` 的四个顶层 case 只转调这里；具体样例在各 app 文件。
 * 门禁与 Rust 同序：未知 app → 未连接 → 未知 method → 写许可 → 写权限拒绝钩子。
 */

import {
  connectedAppMethodKind,
  isConnectedAppId,
  type ConnectedAppId,
  type ConnectedAppInvokeReply,
} from '@/types'
import { alarmMock } from './alarm'
import { calendarMock } from './calendar'
import { contactsMock } from './contacts'
import { desktopFilesMock } from './desktopFiles'
import { locationMock } from './location'
import { notificationMock } from './notification'
import { phoneFilesMock } from './phoneFiles'
import { smsMock } from './sms'
import {
  asPayload,
  fail,
  mockWriteDenied,
  ok,
  pushMockAudit,
  text,
  type MockAppHandler,
  type MockPayload,
} from './shared'
import {
  mockConnectedAppRequest,
  mockConnectedAppSetEnabled,
  mockConnectedAppStatus,
  mockConnectedAppUpdate,
  mockStatusFor,
  resetMockConnectedApps,
} from './status'
import { terminalMock } from './terminal'
import { usageMock } from './usage'

export {
  mockConnectedAppRequest,
  mockConnectedAppSetEnabled,
  mockConnectedAppStatus,
  mockConnectedAppUpdate,
  mockStatusFor,
  resetMockConnectedApps,
}

const HANDLERS: Record<string, MockAppHandler> = {
  alarm: alarmMock,
  usage: usageMock,
  calendar: calendarMock,
  contacts: contactsMock,
  filesystem: phoneFilesMock,
  location: locationMock,
  notification: notificationMock,
  sms: smsMock,
  'win-desktop': desktopFilesMock,
  'win-documents': desktopFilesMock,
  'win-downloads': desktopFilesMock,
  'win-local': desktopFilesMock,
  'win-terminal': terminalMock,
  'mac-desktop': desktopFilesMock,
  'mac-terminal': terminalMock,
  'linux-desktop': desktopFilesMock,
  'linux-documents': desktopFilesMock,
}

/** `connected_app_invoke` 的 mock 实现。 */
export function mockConnectedAppInvoke(
  app: string,
  method: string,
  payload: unknown,
): ConnectedAppInvokeReply {
  const body: MockPayload = asPayload(payload)

  // `__audit` 在任何门禁之前处理：用户在确认期间断开连接，拒绝也必须落盘。
  if (method === '__audit') {
    if (!isConnectedAppId(app) || app === 'health') {
      return fail(app, method, 'connected_app_bad_request', `未知连接应用：${app}`)
    }
    if (method.length > 64 || text(body.summary).length > 300) {
      return fail(app, method, 'connected_app_bad_request', '审计摘要过长')
    }
    pushMockAudit({
      at: new Date().toISOString(),
      app,
      method: text(body.method, 'unknown'),
      decision: text(body.decision) === 'denied' ? 'denied' : 'allowed',
      summary: text(body.summary).slice(0, 300),
    })
    return ok(app, '__audit', { recorded: true }, { audit: true })
  }

  const status = mockStatusFor(app)
  if (!status) {
    return fail(app, method, 'connected_app_bad_request', `未知连接应用：${app}`)
  }

  // 与 Rust 同序：先 method allowlist，再连接/AI/写入门禁。
  const appId = app as ConnectedAppId
  const kind = connectedAppMethodKind(appId, method)
  if (!kind) {
    return fail(app, method, 'connected_app_unknown_method', `「${app}」不支持方法 ${method}`)
  }

  if (!status.enabled || !status.connected) {
    const action = status.permissions.find((p) => p.required && p.action)?.action ?? null
    return fail(
      app,
      method,
      'connected_app_not_connected',
      `连接应用「${app}」尚未连接或缺少必要权限`,
      action,
    )
  }
  if (!status.aiEnabled) {
    return fail(
      app,
      method,
      'connected_app_ai_disabled',
      `连接应用「${app}」还没有允许 AI 使用`,
    )
  }

  if (kind === 'write') {
    if (mockWriteDenied()) {
      pushMockAudit({ at: new Date().toISOString(), app, method, decision: 'denied', summary: 'mock 写权限被拒' })
      return fail(
        app,
        method,
        'connected_app_permission_denied',
        'mock 写权限被拒绝（__REIN_MOCK_APP_WRITE_DENIED__）',
        'permissions_write',
      )
    }
    if (!status.writeAllowed) {
      return fail(app, method, 'connected_app_write_not_allowed', '还没有允许写入；请在连接应用里打开「允许写入」')
    }
  }

  const handler = HANDLERS[app]
  if (!handler) {
    return fail(app, method, 'connected_app_native_error', `没有 ${app} 的 mock 实现`)
  }

  const reply = handler(app, method, body)
  if (kind === 'write') {
    pushMockAudit({
      at: new Date().toISOString(),
      app,
      method,
      decision: reply.ok ? 'allowed' : 'error',
      summary: method,
    })
  }
  return reply
}

/* ---- plan §7.1 约定的短名别名（其它线/测试可直接用） ---- */

export const mockStatus = mockStatusFor
export const mockRequest = mockConnectedAppRequest
export const mockSetEnabled = mockConnectedAppSetEnabled
export const mockUpdate = mockConnectedAppUpdate
export const mockInvokeApp = mockConnectedAppInvoke
