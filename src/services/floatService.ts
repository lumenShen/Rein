/**
 * 全局沉浸浮窗 · IPC 封装（对应 Rust `modules/float/commands.rs`）。
 *
 * 三种环境同一份命令面：
 *   · 桌面（Windows）：第二窗口由 Rust 建/管，push 经 Rust 广播给浮窗；
 *   · Android：`SYSTEM_ALERT_WINDOW` + 前台服务 + 原生浮层，push 经 JNI 下发；
 *   · 浏览器（`npm run dev`）：mock 一律返回「不支持」，上层据此降级为仅程序内浮窗。
 *
 * 命令返回值是**上一次**的原生快照（Android 的 exec 没有回执通道，与 modules/tracking
 * 同一套「缓存 + 轮询收敛」）；调用方不要假设 open 之后 status 立刻为 true。
 * 契约见 docs/GLOBAL-FLOAT.md §5。
 */
import type { GlobalFloatStatePayload, GlobalFloatStatus, GlobalFloatWindowShape } from '@/types'
import { invoke } from './transport'

export const floatService = {
  /** 能力 / 权限 / 显示状态快照 */
  status: () => invoke<GlobalFloatStatus>('global_float_status'),

  /** 请求显示系统浮窗（桌面建窗或显示；Android 有权限时起前台服务） */
  open: () => invoke<GlobalFloatStatus>('global_float_open'),

  /** 收起系统浮窗（桌面 hide、Android stop service；不销毁会话） */
  close: () => invoke<void>('global_float_close'),

  /** 推送内容快照（含形态与画质档）。返回前只保证已交给原生侧 */
  push: (payload: GlobalFloatStatePayload) =>
    invoke<void>('global_float_push', { payload: JSON.stringify(payload) }),

  /** 最近一次推送的载荷（浮窗首帧用；无则空串） */
  latest: () => invoke<string>('global_float_latest'),

  /** 切换浮窗窗口形状：bar 全宽条 / blob 64×64 泊车方块 / confirm 结束确认的临时长高 */
  setForm: (form: GlobalFloatWindowShape) => invoke<void>('global_float_set_form', { form }),

  /** Android：跳「在其他应用上显示」授权页；桌面空操作 */
  requestPermission: () => invoke<GlobalFloatStatus>('global_float_request_permission'),

  /** Android：读走原生浮层产生的动作（读走即清）；桌面恒空串 */
  takeAction: () => invoke<string>('global_float_take_action'),
}