import { Timer } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 专注模块：番茄钟与专注记录（可开关，见「打开或关闭功能」）。
 *
 * 关闭后 `/focus` 被守卫拦回主页、导航轨条目与工具卡消失、主页页脚的「专注」格
 * 随工具卡缺失而收起、桌面便当的番茄钟与快捷磁贴一起隐藏、设置页的番茄钟配置卡
 * 不再出现；AI 的「专注」工具组同时停止装载（`plugin: 'focus'`）。
 */
export const focusPlugin = definePlugin({
  id: 'focus',
  name: '专注',
  desc: '番茄计时常驻 · 专注记录',
  icon: Timer,
  accent: '--mod-focus',
  toggleable: true,
  defaultEnabled: true,
  routes: ['focus'],
  nav: [{ route: 'focus', label: '专注', icon: Timer, surfaces: ['rail'], order: 140 }],
  tools: [
    {
      id: 'focus.open',
      title: '专注',
      sub: '常驻计时 · 待办 · 日程',
      icon: Timer,
      ic: {
        background: 'var(--mod-focus-soft)',
        color: 'var(--mod-focus-strong)',
      },
      order: 60,
      to: { name: 'focus' },
    },
  ],
})
