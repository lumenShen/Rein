import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

/** 导航容器：移动端底部页签 / 桌面导航轨 */
export type NavSurface = 'tabbar' | 'rail'

/**
 * 布局容器键：navLayout 存储 / 编辑态 / mask 的 scope。
 * 为什么不复用 NavSurface：topbar 不是插件 nav 贡献面（它有自己的 TopbarContribution），
 * 把它塞进 NavSurface 会让 NavContribution.surfaces 出现永远不该填的值。
 */
export type NavEditScope = 'tabbar' | 'rail' | 'topbar'

/**
 * 工具卡的就地动作名。插件声明「做什么」，由承载工具格的页面实现「怎么做」——
 * 这样插件保持纯声明（不持有组件状态、不 import router），页面保留自己的弹层与路由。
 * 新增动作 = 这里加一个字面量 + 承载页面在 ACTIONS 里实现。
 */
export type ToolAction = 'smart-add' | 'add-workout' | 'voice-session' | 'diet-history'

/**
 * 顶栏功能按钮的就地动作名。语义同 ToolAction（上面的注释原样适用）：
 * 插件声明「做什么」，壳层宿主 TopbarActions.vue 实现「怎么做」——
 * 这样插件保持纯声明（不持有组件状态、不 import router），宿主保留自己的运行时接线。
 * 新增动作 = 这里加一个字面量 + 宿主在 ACTIONS 表里实现。
 */
export type TopbarAction = 'focus-toggle' | 'record-toggle' | 'voice-session'

/**
 * 顶栏功能按钮贡献：纯数据，不 import router、不持有组件状态。
 * 与 ToolContribution.id 是**两个独立的命名空间**，但统一用 `<模块>.topbar` 前缀 ——
 * ToolContribution.id 与渲染 key / 开关埋点共用，前缀错开才不会在埋点里把
 * 「顶栏按钮」读成「工具卡」，也避免与既有 'voice.session' 这类工具卡 id 撞字符串。
 */
export interface TopbarContribution {
  /** 全局唯一 id，顶栏布局存储（navLayout 的 topbar 字段）用它 */
  id: string
  label: string
  icon: Component
  /** 就地动作（优先于 to） */
  action?: TopbarAction
  /** 纯跳转（与 action 二选一，同 ToolContribution.to） */
  to?: RouteLocationRaw
  /** 同容器内升序排列；插件贡献用 100 起步留出插入空间 */
  order: number
  /** 用户从未编辑过顶栏时的缺省显隐（缺省 true） */
  defaultOn?: boolean
}

/** 导航贡献：一个条目可同时出现在两种容器里（surfaces 决定落点） */
export interface NavContribution {
  /** 目标路由名。关闭插件后该路由被守卫拦回主页 */
  route: string
  label: string
  icon: Component
  surfaces: NavSurface[]
  /** 同容器内升序排列；内核条目占用 0~99，插件用 100 起步留出插入空间 */
  order: number
  /** 按容器覆盖标签（缺省回落 label）：Dock 药丸显示「主页」、左栏显示「总览」——
      这枚差别从前由 TabBar / DesktopRail 两份硬编码各自维护，收进目录后是同一枚
      条目在两个容器上的投影 */
  labels?: Partial<Record<NavSurface, string>>
}

/** 主页「常用工具」格里的动作卡 */
export interface ToolContribution {
  /** 全局唯一 id（跨插件不重复，渲染 key 与开关埋点共用） */
  id: string
  title: string
  /** 副标题；函数形式可读实时数据（如记账本月支出） */
  sub: string | (() => string)
  icon: Component
  /** 图标章配色：底色为同色相 12~14% 淡彩，前景为同色相深档（与全局约定一致） */
  ic: { background: string; color: string }
  order: number
  /** 跳转目标（与 action 二选一） */
  to?: RouteLocationRaw
  /** 就地动作（开抽屉 / 唤起运行时），优先于 to */
  action?: ToolAction
}

/**
 * 功能插件：一个功能模块的完整声明 = 元数据（设置页开关行）+ 扩展点贡献 + 路由所有权。
 * 关闭开关的效果：工具卡与导航条目消失、路由被守卫拦回主页、数据原样保留。
 */
export interface PluginSpec {
  id: string
  name: string
  /** 设置页开关行里的一行说明 */
  desc: string
  icon: Component
  /** 主题色令牌名（如 --c-exercise），开关行图标章从这里取色 */
  accent: string
  /** 是否允许用户开关；false（默认）= 内核功能，恒开且不进设置页 */
  toggleable?: boolean
  /** 首次运行的默认开关状态（仅 toggleable 有意义，默认开） */
  defaultEnabled?: boolean
  /**
   * 父模块 id：声明「本模块是它的子模块」。
   *
   * 两件事由它决定，缺一不可：
   * - **设置页把它缩进挂在父模块下面**，用户看得出从属关系；
   * - **父模块关掉时子模块自动失效**（见 `stores/features.ts`）——
   *   子模块依赖父模块的数据/会话，父的不在，它开着也没意义。
   */
  parent?: string
  /** 该插件拥有的路由名：关闭后这些路由被守卫拦回主页 */
  routes?: string[]
  tools?: ToolContribution[]
  nav?: NavContribution[]
  /** 桌面顶栏的功能按钮贡献（用户可在顶栏编辑态里决定留哪些、什么顺序） */
  topbar?: TopbarContribution[]
}
