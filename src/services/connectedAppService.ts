/**
 * 连接本机应用 · IPC 封装（三向同步之二）。
 *
 * 四个通用命令，不按 app 膨胀：
 * - `connected_app_status`：17 个原生 app 的状态快照（health 不在此列）
 * - `connected_app_request`：拉起系统授权页 / SAF / 文件夹选择器
 * - `connected_app_invoke`：按 app + method 执行原生能力（AI 工具的唯一入口）
 * - `connected_app_update`：记录连接同意 / AI 开关 / 写许可 / win-local 根
 *
 * 约束：`invoke('...')` 的命令名必须是字面量，`scripts/check-ipc-contract.mjs`
 * 只认这种写法；命令名也不能出现在模板字符串里。
 */

import type {
  ConnectedAppId,
  ConnectedAppInvokeReply,
  ConnectedAppPatch,
  ConnectedAppRequestMode,
  ConnectedAppRequestResult,
  ConnectedAppStatus,
  ConnectedAppsSnapshot,
} from '@/types'
import { invoke } from './transport'

export const connectedAppService = {
  /** 全部 17 个原生 app 的状态；Android 首次可能带 `refreshing` / `unknown`。 */
  status: () => invoke<ConnectedAppsSnapshot>('connected_app_status'),

  /** 只负责拉起系统 UI/选择器，不写连接同意。 */
  request: (appId: ConnectedAppId, mode: ConnectedAppRequestMode) =>
    invoke<ConnectedAppRequestResult>('connected_app_request', { appId, mode }),

  /**
   * 按 app + native method 执行能力。
   * 命名避开 import 的 `invoke`：服务层叫 `call`，Rust 命令仍是 `connected_app_invoke`。
   */
  call: <T = unknown>(
    appId: ConnectedAppId,
    method: string,
    payload?: unknown,
  ) =>
    invoke<ConnectedAppInvokeReply<T>>('connected_app_invoke', {
      appId,
      method,
      payloadJson: JSON.stringify(payload ?? {}),
    }),

  /** 记录连接同意（`{enabled}`）；断开时原生侧同时清 AI/写许可与 SAF/根。 */
  setEnabled: (appId: ConnectedAppId, enabled: boolean) =>
    invoke<ConnectedAppStatus>('connected_app_update', {
      appId,
      patch: { enabled },
    }),

  /** 完整补丁入口：AI 开关 / 写许可 / win-local 根；语义见 plan §2.7。 */
  update: (appId: ConnectedAppId, patch: ConnectedAppPatch) =>
    invoke<ConnectedAppStatus>('connected_app_update', { appId, patch }),
}
