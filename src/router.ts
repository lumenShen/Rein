import { createRouter, createWebHashHistory } from 'vue-router'

import { useToast } from '@/composables/useToast'
import { routeOwner } from '@/plugins'
import { useFeaturesStore } from '@/stores/features'

/**
 * 路由表 = 底部导航的四个一级页面 + 二级页。
 * 约定：新增页面必须在 docs/ARCHITECTURE.md 的路由清单中登记。
 */
export const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/pages/HomePage.vue'),
    // desk: 'wide' —— 便当总览本身就是一整块画布，内容自己决定怎么分栏
    meta: { tab: '今天', desk: 'wide' },
  },
  {
    path: '/sports',
    name: 'sports',
    component: () => import('@/pages/SportsPage.vue'),
    meta: { tab: '运动' },
  },
  {
    path: '/ai',
    name: 'ai',
    component: () => import('@/pages/AIPage.vue'),
    meta: { tab: 'AI', desk: 'wide' },
  },
  {
    path: '/ai/models',
    name: 'ai-models',
    component: () => import('@/pages/ModelsPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '管理模型' },
  },
  {
    path: '/ai/knowledge',
    name: 'ai-knowledge',
    component: () => import('@/pages/KnowledgePage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '知识库', desk: 'wide' },
  },
  {
    path: '/ai/files',
    name: 'ai-files',
    component: () => import('@/pages/FileLibraryPage.vue'),
    // 文件管理器：AI 页左上角「历史」菜单里的「文件」一项（虚拟文件系统的真实视图，docs/ai-workspace.md §5）
    meta: { title: '文件', desk: 'wide' },
  },
  {
    path: '/ai/knowledge/files',
    name: 'ai-knowledge-files',
    component: () => import('@/pages/FileLibraryPage.vue'),
    // 文件库：知识库页的旧入口，保留为别名（与 /ai/files 同一个页面）
    meta: { title: '文件库', desk: 'wide' },
  },
  {
    path: '/ai/files/space',
    name: 'ai-files-usage',
    component: () => import('@/pages/SpaceUsagePage.vue'),
    // 空间总览：入口是文件页页头右侧那颗「总大小」胶囊（不占页内位置）
    meta: { title: '空间总览' },
  },
  {
    path: '/ai/files/space/large',
    name: 'ai-files-usage-large',
    component: () => import('@/pages/LargeFilesPage.vue'),
    // 大文件完整榜单：空间总览只留前三名做摘要，完整榜单单独一页（会长到 100 条）
    meta: { title: '大文件' },
  },
  {
    path: '/me',
    name: 'me',
    component: () => import('@/pages/ProfilePage.vue'),
    meta: { tab: '我' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/pages/SettingsPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键（入口在「我 › 设置」）
    meta: { title: '设置' },
  },
  {
    path: '/settings/features',
    name: 'settings-features',
    component: () => import('@/pages/FeatureSettingsPage.vue'),
    // 三级页：功能插件开关（入口在「设置 › 打开或关闭功能」）
    meta: { title: '打开或关闭功能' },
  },
  {
    path: '/settings/float',
    name: 'settings-float',
    component: () => import('@/pages/GlobalFloatPage.vue'),
    // 三级页：全局浮窗开关 + 权限开关教程（入口在「设置 › 功能 › 全局浮窗」）
    meta: { title: '全局浮窗' },
  },
  {
    path: '/settings/sync',
    name: 'settings-sync',
    component: () => import('@/pages/SyncPage.vue'),
    // 三级页：多设备同步（入口在「设置 › 多设备同步」）
    meta: { title: '多设备同步' },
  },
  {
    path: '/settings/health',
    name: 'settings-health',
    component: () => import('@/pages/HealthDataPage.vue'),
    // 三级页：第三方数据管理（入口在「设置 › 第三方数据管理」）。
    // 只有 Android 有 Health Connect，桌面端进得来但整页是说明性的禁用态。
    meta: { title: '第三方数据管理' },
  },
  {
    path: '/settings/update',
    name: 'settings-update',
    component: () => import('@/pages/UpdatePage.vue'),
    // 三级页：软件更新（入口在「设置 › 关于 › 检查更新」）
    meta: { title: '软件更新' },
  },
  {
    path: '/settings/perf',
    name: 'settings-perf',
    component: () => import('@/pages/SettingsPerfPage.vue'),
    // 三级页：画质预览（入口在「设置 › 性能 › 液态玻璃预览」）
    meta: { title: '画质预览', desk: 'wide' },
  },
  {
    path: '/focus',
    name: 'focus',
    component: () => import('@/pages/FocusPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '专注' },
  },
  {
    path: '/todos',
    name: 'todos',
    component: () => import('@/pages/TodosPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    // desk: 'wide' —— 一天画布（时间轴 + 侧边卡片网格）是桌面专属构图，不能被两栏栅格切开
    meta: { title: '全部待办', desk: 'wide' },
  },
  {
    path: '/nutrition',
    name: 'nutrition',
    component: () => import('@/pages/NutritionPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '营养全览' },
  },
  {
    path: '/nutrition/adjust',
    name: 'nutrition-adjust',
    component: () => import('@/pages/DietAdjustPage.vue'),
    meta: { title: '饮食调整' },
  },
  {
    path: '/nutrition/foods',
    name: 'nutrition-foods',
    component: () => import('@/pages/FoodLibraryPage.vue'),
    meta: { title: '饮食库' },
  },
  {
    path: '/nutrition/recipes',
    name: 'nutrition-recipes',
    component: () => import('@/pages/RecipeLibraryPage.vue'),
    meta: { title: '食谱库' },
  },
  {
    path: '/program',
    name: 'program',
    component: () => import('@/pages/ProgramPage.vue'),
    // 二级内容页：健康方案（程序计算基线 + AI 复盘调参，日程级展开）
    meta: { title: '健康方案' },
  },
  {
    path: '/program/wrapup/:id',
    name: 'program-wrapup',
    component: () => import('@/pages/WrapupPage.vue'),
    // :id = 方案记录 id；生效中的方案也可查看（成绩单页内提供归档入口）
    meta: { title: '结营成绩单' },
  },
  {
    path: '/ledger',
    name: 'ledger',
    component: () => import('@/pages/LedgerPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '记账' },
  },
  {
    path: '/sports/plans',
    name: 'sports-plans',
    component: () => import('@/pages/PlansPage.vue'),
    meta: { title: '全部课程' },
  },
  {
    path: '/sports/plans/:id',
    name: 'sports-plan-detail',
    component: () => import('@/pages/PlanDetailPage.vue'),
    meta: { title: '课程详情' },
  },
  {
    path: '/sports/plans/:id/edit',
    name: 'sports-plan-edit',
    component: () => import('@/pages/PlanEditPage.vue'),
    // :id = 'new' 表示新建课程
    meta: { title: '编辑课程' },
  },
  {
    path: '/sports/exercises',
    name: 'sports-exercises',
    component: () => import('@/pages/ExerciseLibraryPage.vue'),
    // 二级内容页：全部运动动作的唯一真源（课程从这里选动作，重量曲线按这里聚合）
    meta: { title: '动作库' },
  },
  {
    path: '/sports/records',
    name: 'sports-records',
    component: () => import('@/pages/WorkoutRecordsPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '全部运动记录' },
  },
  {
    path: '/campus/schedule',
    name: 'campus-schedule',
    component: () => import('@/pages/SchedulePage.vue'),
    // 二级内容页：入口在主页「常用工具栏」的课表卡（不占底部导航），页头提供返回键
    meta: { title: '我的课表', desk: 'wide' },
  },
  {
    path: '/campus/settings',
    name: 'campus-settings',
    component: () => import('@/pages/CampusSettingsPage.vue'),
    // 二级内容页：保留底部导航，页头提供返回键
    meta: { title: '课表配置与设置' },
  },
  {
    path: '/campus/program',
    name: 'campus-program',
    component: () => import('@/pages/CampusProgramPage.vue'),
    // 二级内容页：培养方案与学分完成度（入口在课表配置页）
    meta: { title: '培养方案' },
  },
  {
    path: '/campus/course-select',
    name: 'campus-course-select',
    component: () => import('@/pages/CourseSelectPage.vue'),
    // 二级内容页：抢课（入口在课表配置页）。批次未开放时显示等待态。
    meta: { title: '选课', desk: 'wide' },
  },
  {
    path: '/campus/grab-tasks',
    name: 'campus-grab-tasks',
    component: () => import('@/pages/GrabTasksPage.vue'),
    // 三级内容页：抢课任务的**管理**面（入口在选课页页头）。
    // 为什么要有这一页：任务单在选课页只是仪表盘的一部分，抢完之后
    // 「哪些没抢到、为什么、要不要重排」需要一屏看全 + 能编辑能删。
    meta: { title: '抢课任务', desk: 'wide' },
  },
  {
    path: '/record',
    name: 'record',
    component: () => import('@/pages/RecordPage.vue'),
    // 二级内容页：录音台 + 未归档 take 管理（附加到待办 / 回放 / 删除）
    meta: { title: '录音' },
  },
  {
    path: '/voice-layouts',
    name: 'voice-layouts',
    component: () => import('@/pages/VoiceLayoutsPage.vue'),
    // 设计探索页：10 种语音会话版式对照，不进导航（`?v=3` 直开某一版）。
    // fullscreen：对照页要独占窗口，否则宽屏下会被桌面三窗格壳挤成中间一窄条。
    meta: { title: '语音版式对照', fullscreen: true },
  },
  {
    path: '/session/run',
    name: 'session-run',
    component: () => import('@/pages/RunPage.vue'),
    meta: { fullscreen: true },
  },
  // 训练课沉浸层不再走路由：SessionOverlay 由 App.vue 常驻挂载，
  // 显隐与形变动画由 system/sessionImmersive 驱动（原 /session 路由已移除）
] as const

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

/**
 * 插件守卫：被关闭的功能模块，其名下全部路由拦回主页并说明原因。
 * 正常路径下入口（页签/导航轨/工具卡）已经随开关消失，只有直链与历史前进会走到这里。
 */
router.beforeEach((to) => {
  const name = typeof to.name === 'string' ? to.name : null
  if (!name) return true
  const owner = routeOwner(name)
  if (!owner || useFeaturesStore().isEnabled(owner.id)) return true
  useToast().toast(`「${owner.name}」已关闭：设置 › 打开或关闭功能`)
  return { name: 'home' }
})

router.afterEach((to) => {
  const t = (to.meta.tab ?? to.meta.title) as string | undefined
  document.title = t ? `Rein · ${t}` : 'Rein'
})
