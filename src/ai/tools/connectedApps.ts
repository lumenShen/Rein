/**
 * 连接应用工具 helper（所有 app 工具共用）。
 *
 * 统一约定（plan §4.6 / §13）：
 * - `callConnectedApp` 是唯一 native 入口：`ok:false` **一律抛错**，绝不假成功；
 * - `withMeta` 把 `meta`（含 `mock`）并进工具结果，页面/过程卡才能标「样例数据」；
 * - 多 app 共享组先用 `resolveOneApp` 选出「已连接且允许 AI」的那个；
 * - 写工具统一走 `callConnectedAppWrite`：先本地查有效写许可 → 再弹一次确认 →
 *   拒绝写 `__audit`（denied）并抛 `connected_app_user_denied` → 最后才调 native。
 *
 * 注意：确认触发器是这里的 `askToolConfirm`，**不是**工具定义上的 `dangerous`。
 * 现有 13 个非 app 的 dangerous 工具不会因此多弹一层确认。
 */

import { connectedAppById } from '@/config/connectedApps'
import { connectedAppService } from '@/services/connectedAppService'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import { askToolConfirm, type ToolConfirmRequest } from '@/system/toolConfirm'
import type { ConnectedAppId, ConnectedAppInvokeMeta, ConnectedAppRequestMode } from '@/types'

/** 连接应用调用失败：`code` 与 Rust/mock 的错误码同源，`action` 用于引导用户去授权。 */
export class ConnectedAppToolError extends Error {
  readonly code: string
  readonly action: string | null

  constructor(code: string, message: string, action?: string | null) {
    super(message)
    this.name = 'ConnectedAppToolError'
    this.code = code
    this.action = action ?? null
  }
}

export interface ConnectedAppCallResult<T> {
  data: T
  meta?: ConnectedAppInvokeMeta
}

/** app 的展示名（未知 id 原样返回，不崩）。 */
function appTitle(appId: string): string {
  return connectedAppById(appId)?.title ?? appId
}

/** 给模型/用户的授权引导（错误 message 必须带，见 plan §4.6）。 */
function guidance(appId: string, action?: string | null): string {
  const title = appTitle(appId)
  if (action === 'permissions_write') {
    return `请让用户打开「连接应用 → ${title}」并点「去授权 / 允许写入」`
  }
  return `请让用户打开「连接应用 → ${title}」并检查「去授权 / 允许 AI 使用」`
}

/**
 * 调一个 native method；`ok:false` 一律抛 `ConnectedAppToolError`。
 * 错误 message 会追加授权引导，模型据 action/code 告诉用户去哪里授权。
 */
export async function callConnectedApp<T>(
  appId: string,
  method: string,
  payload: unknown = {},
): Promise<ConnectedAppCallResult<T>> {
  const r = await connectedAppService.call<T>(appId as ConnectedAppId, method, payload)
  if (!r.ok) {
    const code = r.error?.code ?? 'connected_app_native_error'
    const message = r.error?.message ?? '连接应用调用失败'
    throw new ConnectedAppToolError(
      code,
      `${message}（${guidance(appId, r.error?.action)}）`,
      r.error?.action ?? null,
    )
  }
  return { data: (r.data ?? null) as T, meta: r.meta }
}

/**
 * 把 `meta` 并进工具返回对象（样例标记因此能被过程卡/e2e 看到）。
 * 所有 app 工具统一 `return withMeta(await callConnectedApp(...))`。
 */
export function withMeta<T extends object>(
  r: ConnectedAppCallResult<T>,
): T & { meta?: ConnectedAppCallResult<T>['meta'] } {
  return { ...r.data, meta: r.meta }
}

/**
 * 多 app 共享组选一个：先 `ensureLoaded()`，再在「已连接且允许 AI」里找第一个候选。
 * 找不到抛 `connected_app_not_connected`（不猜、不回退到未授权 app）。
 */
export async function resolveOneApp(candidates: readonly string[]): Promise<string> {
  const store = useConnectedAppsStore()
  await store.ensureLoaded()
  const enabled = new Set(store.aiEnabledAppIds())
  const hit = candidates.find((id) => enabled.has(id))
  if (!hit) {
    const names = candidates.map(appTitle).join(' / ')
    throw new ConnectedAppToolError(
      'connected_app_not_connected',
      `没有可用的连接应用（${names}）：${guidance(candidates[0] ?? '', null)}`,
      'settings',
    )
  }
  return hit
}

/**
 * 本地前提检查：`enabled/connected/aiEnabled`，写工具再加 `writeAllowed`。
 * 在弹确认**之前**调用，避免「用户确认完才发现没权限」。
 */
export async function assertAppReady(
  appId: string,
  opts: { write?: boolean } = {},
): Promise<void> {
  const store = useConnectedAppsStore()
  await store.ensureLoaded()
  const status = store.statusFor(appId)
  if (!status || !status.enabled || !status.connected) {
    const action =
      status?.permissions.find((p) => p.required && p.action)?.action ?? ('settings' as const)
    // 前置门禁拒绝也落 __audit：否则「没连上就调写工具」在审计里完全不可见。
    await auditConnectedAppDenied(appId, 'precheck', `gate=connected_app_not_connected write=${Boolean(opts.write)}`)
    throw new ConnectedAppToolError(
      'connected_app_not_connected',
      `「${appTitle(appId)}」尚未连接或缺少必要权限：${guidance(appId, action)}`,
      action,
    )
  }
  if (!status.aiEnabled) {
    await auditConnectedAppDenied(appId, 'precheck', `gate=connected_app_ai_disabled write=${Boolean(opts.write)}`)
    throw new ConnectedAppToolError(
      'connected_app_ai_disabled',
      `「${appTitle(appId)}」还没有允许 AI 使用：${guidance(appId, null)}`,
      null,
    )
  }
  if (!opts.write) return
  // writeAllowed 已是有效值：enabled && connected && 写入意图 && nativeWriteReady（plan §13.3）。
  // 不再逐条翻 permissions，避免把「原生已就绪但没回填 granted」误判成缺权限。
  if (!status.writeAllowed) {
    await auditConnectedAppDenied(appId, 'precheck', 'gate=connected_app_permission_denied write=true')
    throw new ConnectedAppToolError(
      'connected_app_permission_denied',
      `「${appTitle(appId)}」还没有可用的写入许可：${guidance(appId, 'permissions_write')}`,
      'permissions_write',
    )
  }
}

/** 用户拒绝确认时补一条审计（不要求 enabled/aiEnabled，失败忽略）。 */
export async function auditConnectedAppDenied(
  appId: string,
  method: string,
  summary: string,
): Promise<void> {
  try {
    await connectedAppService.call(appId as ConnectedAppId, '__audit', {
      decision: 'denied',
      method,
      summary: summary.slice(0, 300),
    })
  } catch {
    /* 审计失败不能改变工具结果：拒绝就是拒绝 */
  }
}

export interface ConnectedAppWriteConfirm extends ToolConfirmRequest {
  /** 审计摘要（≤300）：只写动作 + 目标 id/相对路径，不含正文、号码、通知标题、经纬度 */
  summary: string
}

/**
 * 写工具统一入口：本地写许可 → 确认（拒绝则审计 + 抛 `connected_app_user_denied`）→ native。
 *
 * 注意顺序：权限检查在确认之前；拒绝后不调 native，模型收到明确的用户拒绝错误。
 */
export async function callConnectedAppWrite<T>(
  appId: string,
  method: string,
  payload: unknown,
  confirm: ConnectedAppWriteConfirm,
): Promise<ConnectedAppCallResult<T>> {
  await assertAppReady(appId, { write: true })
  const { summary, ...request } = confirm
  const allowed = await askToolConfirm(request)
  if (!allowed) {
    await auditConnectedAppDenied(appId, method, summary)
    throw new ConnectedAppToolError(
      'connected_app_user_denied',
      '用户拒绝了这次操作，已停止；不要换参数重试，等用户明确要求再执行。',
      null,
    )
  }
  return callConnectedApp<T>(appId, method, payload)
}

/** 语义化别名：部分调用点按「写」命名更清楚。 */
export const invokeConnectedAppWrite = callConnectedAppWrite

/** `request` mode 的类型收口（app 工具拼 action 时用得到）。 */
export type ConnectedAppToolAction = ConnectedAppRequestMode | 'settings' | null
