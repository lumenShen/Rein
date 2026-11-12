import { Cloud } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 设备（同步）模块（可开关，见「打开或关闭功能」）。
 *
 * 它没有导航条目与工具卡 —— 唯一的入口是「设置 › 能力与连接 › 设备」那张卡，所以关闭的
 * 效果是：那张卡与 `settings-sync` 路由一起收起，命令面板与桌面信息栏里的入口同时消失。
 *
 * **捕获线程不给 Rust 侧加门闩**，理由与抢课恰好相反：`SyncHub` 那条线程不做任何网络
 * 轮询，它只在本地写入发生时把改动捕获进 blob 仓库（`engine.rs::loop_forever` 全程零
 * 请求），而且它还是**网关变更推送的唯一来源**（`SyncHub::set_feed`，见 §12）—— 按开关
 * 停掉它反而会把外部访问的推送一起掐死。**联网**那一半（自动 / 手动同步会话）会看这个
 * 功能开关的快照：模块关掉后 `spawn_session` 直接拒绝，自动同步也不再发起。
 */
export const syncPlugin = definePlugin({
  id: 'sync',
  name: '设备',
  desc: '设备间端到端加密同步',
  icon: Cloud,
  accent: '--mod-campus',
  toggleable: true,
  defaultEnabled: true,
  routes: ['settings-sync'],
})
