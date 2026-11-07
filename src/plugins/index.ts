/**
 * 插件层出口。
 * - 声明：`builtin/` 里 definePlugin（导入即注册）
 * - 注册表：`registry.ts`（纯数据，不认识 Pinia）
 * - 启用态与派生列表：`stores/features.ts`
 */
import './builtin'

export type {
  NavContribution,
  NavEditScope,
  NavSurface,
  PluginSpec,
  ToolAction,
  ToolContribution,
  TopbarAction,
  TopbarContribution,
} from './types'
export { definePlugin, pluginById, plugins, routeOwner, toggleablePlugins } from './registry'
export { KERNEL_NAV, kernelNav, type KernelNavEntry } from './kernelNav'
