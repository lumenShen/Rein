import { Zap } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 抢课（自动选课）：**课表的子模块，默认关闭**。
 *
 * 为什么单独拆出来、还默认关：
 * - 它比课表激进得多 —— 后台引擎会按设定节奏反复打教务，直到抢到或窗口关闭；
 *   课表同步只是一次只读抓取。两者的风险与音量不在一个量级，不该共用一个开关。
 * - 抢课依赖课表的登录会话与学期，所以 `parent: 'campus'`：关掉课表，它自动失效。
 *
 * 关闭的语义（三层一起生效，缺一层就等于没关）：
 * 1. 入口与路由：`routes` 里的页面被守卫拦回主页，课表页/配置页的入口卡也不显示；
 * 2. 常驻浮条与自动交 AI 排查：`App.vue` 按开关渲染；
 * 3. **后台引擎**：`stores/features.ts` 的开关变化会同步给 Rust（`campus_grab_set_enabled`），
 *    引擎停止探测窗口与开火 —— 只关 UI 不关引擎，等于「关了还在偷偷跑」。
 */
export const campusGrabPlugin = definePlugin({
  id: 'campus-grab',
  name: '抢课',
  desc: '自动选课 · 窗口监听 · 任务队列',
  icon: Zap,
  accent: '--mod-campus',
  toggleable: true,
  defaultEnabled: false,
  parent: 'campus',
  // 任务管理页原先没有归属，直链能绕过课表开关 —— 这里一并认领
  routes: ['campus-course-select', 'campus-grab-tasks'],
})
