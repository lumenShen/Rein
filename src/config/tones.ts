/**
 * 路由 → 模块色调。
 *
 * <html data-tone> 只承载「当前页属于哪个功能域」，配色本身留在 tokens.css
 * （html[data-tone='…'] 把 --accent / --accent-strong / --accent-soft / --tone
 * 改写成该模块的值）。这里不写任何色值：换色只改令牌，换归属只改这张表。
 *
 * 总览 / 我 / 设置不返回色调 —— 它们是壳层，沿用品牌蓝。
 */
export type ModuleTone = 'nutrition' | 'sports' | 'focus' | 'todo' | 'campus' | 'ledger' | 'program' | 'ai' | 'record'

const TONE_BY_ROUTE: Record<string, ModuleTone> = {
  // 运动：含计划、动作库、记录与沉浸跑步
  sports: 'sports',
  'sports-plans': 'sports',
  'sports-plan-detail': 'sports',
  'sports-plan-edit': 'sports',
  'sports-exercises': 'sports',
  'sports-records': 'sports',
  'session-run': 'sports',

  // 饮食
  nutrition: 'nutrition',
  'nutrition-adjust': 'nutrition',
  'nutrition-foods': 'nutrition',
  'nutrition-recipes': 'nutrition',

  focus: 'focus',
  todos: 'todo',
  ledger: 'ledger',

  // 课表：教务、抢课、选课都归这一域
  'campus-schedule': 'campus',
  'campus-settings': 'campus',
  'campus-program': 'campus',
  'campus-course-select': 'campus',
  'campus-grab-tasks': 'campus',

  // 方案
  program: 'program',
  'program-wrapup': 'program',

  // AI：模型、知识库、文件
  ai: 'ai',
  'ai-models': 'ai',
  'ai-knowledge': 'ai',
  'ai-files': 'ai',
  'ai-knowledge-files': 'ai',
  'ai-files-usage': 'ai',
  'ai-files-usage-large': 'ai',

  // 录音 / 语音
  record: 'record',
  'voice-layouts': 'record',
}

export function toneForRoute(name: unknown): ModuleTone | null {
  return typeof name === 'string' ? (TONE_BY_ROUTE[name] ?? null) : null
}
