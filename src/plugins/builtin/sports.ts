import { Dumbbell } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/** 运动模块：训练主页、课程库、运动记录与跑步模式（可开关，见「打开或关闭功能」） */
export const sportsPlugin = definePlugin({
  id: 'sports',
  name: '运动',
  desc: '训练课程、跑步模式与运动记录',
  icon: Dumbbell,
  accent: '--mod-sports',
  toggleable: true,
  defaultEnabled: true,
  routes: [
    'sports',
    'sports-plans',
    'sports-plan-detail',
    'sports-plan-edit',
    'sports-exercises',
    'sports-records',
    'session-run',
  ],
  nav: [{ route: 'sports', label: '运动', icon: Dumbbell, surfaces: ['tabbar', 'rail'], order: 120 }],
  tools: [
    {
      id: 'sports.log',
      title: '记运动',
      sub: '力量 / 有氧 · MET 估算',
      icon: Dumbbell,
      ic: { background: 'var(--mod-sports-soft)', color: 'var(--mod-sports-strong)' },
      order: 20,
      action: 'add-workout',
    },
  ],
})
