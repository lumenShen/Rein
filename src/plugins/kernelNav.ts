import { House, Sparkles, User } from 'lucide-vue-next'

import type { NavContribution, NavSurface } from './types'

/**
 * 内核导航目录：主页（总览）与「关于你」两枚条目的**纯数据**清单。
 *
 * 为什么不经 definePlugin（与 registry.ts 同一条分层纪律，这里也不 import Pinia/router）：
 * 若给 home/me 造一个「shell 插件」，`plugins` 数组会多出一个 id —— App.vue 的
 * `enabledModuleIds` 快照（推给 Rust 网关，EXTERNAL-API §4.7）与 routeOwner 语义都会被波及，
 * 收益为零、风险面一整条。内核条目只经 navLayout 的 resolve 进入渲染（§2.3），
 * 路由所有权（router.ts 守卫）完全不动。
 *
 * order 沿用 types.ts 的约定：内核占 0~99 与末档，插件用 100 起步。
 */

/** 内核条目：在 fixed 列出的容器里是固定件（不可移除、不可拖、位置由容器定） */
export interface KernelNavEntry extends NavContribution {
  fixed: NavSurface[]
}

/**
 * 内核条目只有两枚，三个刻意决定：
 * 1. `labels` 按容器覆盖 —— Dock 药丸显示「主页」、左栏显示「总览」，从前是两份硬编码，
 *    收进目录后是同一枚条目的两个投影；
 * 2. `me` 只投 `tabbar` —— 左栏的「关于你」保持为 DesktopRail 模板里的壳层固定件（与
 *    logo/命令面板/信息栏同簇），桌面始终有一个位置固定的个人入口；将来要放开，
 *    把 `me` 加投 `rail` 并摘掉 `fixed` 即可，容器无需改结构；
 * 3. AI 曾是 Dock 的右独立圆钮槽位（不进布局）；2026-11 底栏合并重构（输入行 + 页签行
 *    一块玻璃）后右钮退役，AI 改为 tabbar 的**固定布局条目**照常入列 —— 「不可移除」
 *    依旧由 fixed 保证（无徽标、不可拖），导航轨的 AI 仍由 core 插件照常投 `rail`。
 */
export const KERNEL_NAV: readonly KernelNavEntry[] = [
  {
    route: 'home',
    label: '主页',
    labels: { rail: '总览' },
    icon: House,
    surfaces: ['tabbar', 'rail'],
    order: 0,
    fixed: ['tabbar', 'rail'],
  },
  {
    route: 'me',
    label: '关于你',
    icon: User,
    surfaces: ['tabbar'],
    order: 990,
    fixed: ['tabbar'],
  },
  {
    route: 'ai',
    label: 'AI',
    icon: Sparkles,
    surfaces: ['tabbar'],
    order: 995,
    fixed: ['tabbar'],
  },
]

/** 某个导航容器需要的内核条目（按声明 order 升序） */
export function kernelNav(surface: NavSurface): KernelNavEntry[] {
  return KERNEL_NAV.filter((e) => e.surfaces.includes(surface)).sort((a, b) => a.order - b.order)
}
