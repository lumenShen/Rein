/**
 * 连接应用 mock 的公共小工具。
 *
 * 浏览器预览不是真机：所有结果都带 `meta.mock = true`，页面横幅与工具结果必须
 * 标注「样例数据」。写方法返回样例成功，但支持两个 e2e 钩子：
 * - `__REIN_MOCK_APP_WRITE_DENIED__ = true`（或 localStorage 同名键为 `'1'`）
 *   → 写方法返回 `connected_app_permission_denied`；
 * - `window.__REIN_MOCK_APP_AUDIT__`：`__audit` 与拒绝记录落在这里，供 e2e 断言。
 */

import type {
  ConnectedAppInvokeMeta,
  ConnectedAppInvokeReply,
  ConnectedAppRequestMode,
} from '@/types'

export type MockPayload = Record<string, unknown>

/** 每个 app 的 mock 处理器：只负责该 app 的读/写样例，不认识连接门禁。 */
export type MockAppHandler = (
  app: string,
  method: string,
  payload: MockPayload,
) => ConnectedAppInvokeReply

export function ok<T>(
  app: string,
  method: string,
  data: T,
  meta?: ConnectedAppInvokeMeta,
): ConnectedAppInvokeReply<T> {
  return { ok: true, app, method, data, meta: { mock: true, ...meta } }
}

export function fail(
  app: string,
  method: string,
  code: string,
  message: string,
  action?: ConnectedAppRequestMode | 'settings' | null,
  hint?: string,
): ConnectedAppInvokeReply<never> {
  return {
    ok: false,
    app,
    method,
    error: { code, message, action: action ?? null, hint: hint ?? null },
    meta: { mock: true },
  }
}

export function asPayload(v: unknown): MockPayload {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as MockPayload) : {}
}

export function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(num(v, fallback))
  return Math.min(max, Math.max(min, n))
}

export function text(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function sampleIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

/** e2e 的「写权限被拒」开关；查询只读，不弹确认。 */
export function mockWriteDenied(): boolean {
  const g = globalThis as unknown as { __REIN_MOCK_APP_WRITE_DENIED__?: unknown }
  if (g.__REIN_MOCK_APP_WRITE_DENIED__ === true) return true
  try {
    return localStorage.getItem('__REIN_MOCK_APP_WRITE_DENIED__') === '1'
  } catch {
    return false
  }
}

export interface MockAuditEntry {
  at: string
  app: string
  method: string
  decision: 'allowed' | 'denied' | 'error'
  summary?: string
}

/** `__audit` / 用户拒绝的落点；e2e 读 `window.__REIN_MOCK_APP_AUDIT__`。 */
export function pushMockAudit(entry: MockAuditEntry): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __REIN_MOCK_APP_AUDIT__?: MockAuditEntry[] }
  if (!Array.isArray(w.__REIN_MOCK_APP_AUDIT__)) w.__REIN_MOCK_APP_AUDIT__ = []
  w.__REIN_MOCK_APP_AUDIT__.push(entry)
}
