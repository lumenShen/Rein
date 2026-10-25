import { Target } from 'lucide-vue-next'

import { definePlugin } from '../registry'
import { useProgramStore } from '@/stores/program'

/** 健康方案模块：三档基线、日程展开与 AI 复盘（可开关，见「打开或关闭功能」） */
export const programPlugin = definePlugin({
  id: 'program',
  name: '健康方案',
  desc: '三档方案基线、日程展开与复盘调参',
  icon: Target,
  accent: '--mod-program',
  toggleable: true,
  defaultEnabled: true,
  routes: ['program', 'program-wrapup'],
  tools: [
    {
      id: 'program.open',
      title: '健康方案',
      sub: () => {
        const active = useProgramStore().active
        return active ? `执行中 · v${active.version}` : '三套方案，排进日程'
      },
      icon: Target,
      ic: { background: 'var(--mod-program-soft)', color: 'var(--mod-program-strong)' },
      order: 80,
      to: { name: 'program' },
    },
  ],
})
