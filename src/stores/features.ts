import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import {
  pluginById,
  plugins,
  type NavContribution,
  type NavSurface,
  type PluginSpec,
  type ToolContribution,
  type TopbarContribution,
} from '@/plugins'

/**
 * 功能插件开关：整个应用「哪些功能开着」的唯一事实来源。
 *
 * 消费方（导航容器、主页工具格、路由守卫）一律问这里，不各自判断：
 * - `navCatalog(surface)` / `topbarCatalog()`：某扩展点的**全部插件贡献**（不论开关）——
 *   导航容器渲染的是 `stores/navLayout.ts` 的「布局 ∩ 目录」，目录从这里取；
 * - `tools` / `nav(surface)`：已开插件的扩展点贡献，按 order 排好（nav 的成员是
 *   插件-only，内核条目走 kernelNav，不在这里）；
 * - `isEnabled(id)`：路由守卫与条件渲染共用
 *
 * 持久化在 localStorage（`rein.features.v1`）——它与番茄钟设置同属「界面级偏好」，
 * 不是业务数据，因此不进 SQLite、不进知识库索引。
 */
const STORE_KEY = 'rein.features.v1'

type EnabledMap = Record<string, boolean>

/** 读本地开关；损坏/不可用一律回落默认值（开关丢了不能拖垮启动） */
function load(): EnabledMap {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as EnabledMap
    }
  } catch {
    /* 忽略损坏的本地开关 */
  }
  return {}
}

export const useFeaturesStore = defineStore('features', () => {
  /** 只存用户改过的项：解析时与 defaults() 合并，新增插件不必迁移旧数据 */
  const overrides = ref<EnabledMap>(load())

  watch(
    overrides,
    (m) => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(m))
      } catch {
        /* 本地存储不可用时退化为内存态 */
      }
    },
    { deep: true },
  )

  /**
   * 插件是否启用：内核插件（不可开关）恒开。
   *
   * **父模块关掉时，子模块一律视为关闭** —— 子模块（如抢课）吃的是父模块（课表）的
   * 登录会话与学期数据，父的不在，它开着只会撞一堵「还没有绑定教务系统」的墙。
   * 判定放在这里而不是每个消费方各写一遍：入口显隐、路由守卫、AI 工具门禁
   * 都问这一个函数，才不会出现「工具卡没了但直链还能进」这种半关状态。
   */
  function isEnabled(id: string): boolean {
    const p = pluginById(id)
    if (!p || !p.toggleable) return true
    if (p.parent && !isEnabled(p.parent)) return false
    return overrides.value[id] ?? p.defaultEnabled !== false
  }

  function setEnabled(id: string, on: boolean): void {
    const p = pluginById(id)
    if (!p?.toggleable) return
    overrides.value = { ...overrides.value, [id]: on }
  }

  const activePlugins = computed<PluginSpec[]>(() => plugins.filter((p) => isEnabled(p.id)))

  /** 主页工具格：已开插件的工具卡，按 order 升序 */
  const tools = computed<ToolContribution[]>(() =>
    activePlugins.value
      .flatMap((p) => p.tools ?? [])
      .sort((a, b) => a.order - b.order),
  )

  /**
   * 插件贡献目录：某容器的**全部插件贡献**（不论开关），按 order 升序。
   * **不含内核条目** —— kernelNav 只经 navLayout 的 resolve 进入渲染（见 stores/navLayout.ts）。
   * 为什么 nav() 不能把内核并进来：容器换源之前 nav('tabbar') 一旦膨胀出 home/me，
   * 药丸会渲染成「主页,主页,运动,我,我」（RouterLink :key 重复），e2e 的 dock 页签断言当场红。
   * 消费方：navLayout 的目录求交、以及左钮候选这类「目录源」（不关心用户布局）的读法。
   */
  function navCatalog(surface: NavSurface): (NavContribution & { pluginId: string })[] {
    return plugins
      .flatMap((p) =>
        (p.nav ?? [])
          .filter((n) => n.surfaces.includes(surface))
          .map((n) => ({ ...n, pluginId: p.id })),
      )
      .sort((a, b) => a.order - b.order)
  }

  /** 顶栏按钮目录：全部插件 topbar 贡献，按 order 升序（不做 isEnabled 过滤 —— 布局解析自己过滤） */
  function topbarCatalog(): (TopbarContribution & { pluginId: string })[] {
    return plugins
      .flatMap((p) => (p.topbar ?? []).map((t) => ({ ...t, pluginId: p.id })))
      .sort((a, b) => a.order - b.order)
  }

  /**
   * 某个导航容器里的条目：已开插件贡献的，按 order 升序。
   * ＝ navCatalog → isEnabled 过滤，**成员与目录化之前逐字相同**（插件-only）——
   * 对外签名与排序语义不变，存量消费方（左钮候选、命令面板落点候选）零可见变化。
   */
  function nav(surface: NavSurface): NavContribution[] {
    return navCatalog(surface)
      .filter((c) => isEnabled(c.pluginId))
      .map((c) => {
        // 剥掉目录附带的归属插件 id：对外契约保持纯 NavContribution
        const { pluginId: _owner, ...n } = c
        return n
      })
  }

  return { isEnabled, setEnabled, activePlugins, tools, nav, navCatalog, topbarCatalog }
})
