/** Rein 多设备同步 IPC 封装 · 对应 modules/sync
 *
 * 分工：这一层只管「按命令收发」，配对码的生成/校验、选路、端到端加密都在 Rust 侧；
 * 界面拿到的永远是已经推好的状态（含这次走了哪条路）。
 */

import type { PairOffer, PairStatus, SyncSettings, SyncSettingsPatch, SyncStatus } from '@/types'
import { invoke } from './transport'

export const syncService = {
  /** 本机同步状态（设备身份 + 已配对设备 + 最近一次结果） */
  status: () => invoke<SyncStatus>('sync_status', {}),

  /** 改本机在这套同步里的显示名 */
  setDeviceName: (name: string) => invoke<SyncStatus>('sync_set_device_name', { name }),

  /** 开一个 5 分钟有效的同步码（另一台输这串码完成配对） */
  pairStart: () => invoke<PairOffer>('sync_pair_start', {}),

  /** 开码侧轮询：有人报码了就完成配对 */
  pairPoll: () => invoke<PairStatus>('sync_pair_poll', {}),

  /** 报码侧：输入另一台设备上的同步码 */
  pairClaim: (code: string) => invoke<PairStatus>('sync_pair_claim', { code }),

  /** 本机的自动同步设置 */
  settings: () => invoke<SyncSettings>('sync_settings_get', {}),

  /** 改自动同步设置（只传要改的字段） */
  setSettings: (patch: SyncSettingsPatch) =>
    invoke<SyncSettings>('sync_set_settings', { patch }),

  /** 跑一轮同步（后台线程；结果通过 `sync://result` 事件回来） */
  run: () => invoke<void>('sync_run', {}),

  /** 解除一台设备的配对（最后一台退掉后整组重置） */
  forget: (device: string) => invoke<SyncStatus>('sync_forget', { device }),
}
