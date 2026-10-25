import { CalendarDays } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/** 课表模块：教务同步、课表三视图、培养方案（可开关，见「打开或关闭功能」）。
 *  抢课是它的**子模块**（`campusGrab.ts`，默认关闭）—— 那部分激进得多，单独一个开关。 */
export const campusPlugin = definePlugin({
  id: 'campus',
  name: '课表',
  desc: '教务课表同步与时间线投影',
  icon: CalendarDays,
  accent: '--mod-campus',
  toggleable: true,
  defaultEnabled: true,
  routes: ['campus-schedule', 'campus-settings', 'campus-program'],
  nav: [{ route: 'campus-schedule', label: '课表', icon: CalendarDays, surfaces: ['rail'], order: 130 }],
  tools: [
    {
      id: 'campus.schedule',
      title: '课表',
      sub: '日 / 周 / 月 · 同步教务',
      icon: CalendarDays,
      ic: {
        background: 'var(--mod-campus-soft)',
        color: 'var(--mod-campus-strong)',
      },
      order: 30,
      to: { name: 'campus-schedule' },
    },
  ],
})
