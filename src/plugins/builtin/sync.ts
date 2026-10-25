import { Cloud } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 多设备同步模块（可开关，见「打开或关闭功能」）。
 *
 * 它没有导航条目与工具卡 —— 唯一的入口是「设置 › 多设备同步」那张卡，所以关闭的
 * 效果是：那张卡与 `settings-sync` 路由一起收起，命令面板与桌面信息栏里的入口同时消失。
 *
 * **不给 Rust 侧加门闩**，理由与抢课恰好相反：`SyncHub` 那条线程不做任何网络轮询，
 * 它只在本地写入发生时把改动捕获进 blob 仓库（`engine.rs::loop_forever` 全程零请求），
 * 联网只发生在用户按下「立即同步」的那一刻。而捕获线程还是**网关变更推送的唯一来源**
 * （`SyncHub::set_feed`，见 §12），按同步开关停掉它反而会把外部访问的推送一起掐死。
 */
export const syncPlugin = definePlugin({
  id: 'sync',
  name: '多设备同步',
  desc: '设备间端到端加密同步',
  icon: Cloud,
  accent: '--mod-campus',
  toggleable: true,
  defaultEnabled: true,
  routes: ['settings-sync'],
})
