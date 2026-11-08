import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

import { kernelNav } from '@/plugins/kernelNav'
import type { NavEditScope, TopbarAction } from '@/plugins'
import { useFeaturesStore } from '@/stores/features'

/**
 * 导航布局层：每个导航容器（移动 Dock / 桌面左栏 / 桌面顶栏）一份**用户有序布局**，
 * 渲染结果 = 布局 ∩ 目录 ∩ 启用态。容器从此只 import 本 store，不再各自拼「内核 + 插件」清单
 * —— 内核条目只剩 kernelNav 一份，容器组件里没有第二份业务清单。
 *
 * 与便当（useBentoLayout）同源的规则、两处刻意偏离：
 * - 同源：失效 id **只过滤、不写回**（模块重开 → 条目原位回来）；损坏 payload 整份回落。
 * - 偏离一：编辑过的容器是**冻结**的 —— 一旦存了布局，新插件条目不自动出现，落进候选清单
 *   等用户显式加回。导航条目无法区分「新条目」与「被用户刚删掉的条目」（存储里两者都是
 *   「不在列表」），自动补齐会复活用户刚删的东西；编辑态的候选面天然是新增条目的承接面。
 * - 偏离二：有序数组没有 bento 那层「id→item Map」的天然免疫，重复 id 必须显式去重。
 *
 * 固定件（tabbar 的主页与「我」、rail 的总览）**永不入存**：位置由容器定（头/尾），
 * apply 时防御性剔除。AI 右钮是 Dock 的槽位不是布局条目，根本不进布局 ——
 * 「不可移除」由「不在存储里」保证，比存进去再禁止移除干净。
 *
 * 持久化在 localStorage（`rein.navLayout.v1`）—— 与功能开关 / Dock 落点同属**界面级偏好**，
 * 不进 SQLite、不进知识库索引。与 `rein.dock.v1` 互不读写：左钮落点仍是独立偏好，
 * 候选继续走 features.nav('rail')（目录源），布局怎么重排都污染不到落点。
 */

export const NAV_LAYOUT_STORE_KEY = 'rein.navLayout.v1'

/**
 * 手机底栏页签数上限（2026-11-08 用户定稿：**最多 5 个**）。固定件（主页 / 我 / AI）
 * 计入配额 —— 用户最多再加 2 个模块页签。超出的加回请求被托盘拒绝（带提示），
 * 渲染层对存量超长布局做裁剪兜底（TabBar 的 tabs computed）。
 */
export const TABBAR_MAX = 5

/** 存储载荷：只存编辑过的容器 —— 字段缺省 = 该容器从未编辑过 → 按目录缺省渲染，绝不写键 */
interface NavLayoutPayload {
  v: 1
  /** 有序 id：tabbar/rail 只存可移除项（固定件永不入存）；topbar 存按钮 id 全序列 */
  tabbar?: string[]
  rail?: string[]
  topbar?: string[]
}

/** 解析后的条目：容器渲染与编辑态直接消费；label 已按容器解析好（rail 的 home = 「总览」） */
export interface NavEntry {
  /** 路由名（tabbar/rail）或按钮 id（topbar） */
  id: string
  label: string
  icon: Component
  /** 固定件：不可移除/不可拖（编辑态的徽标与拖拽把手都不渲染） */
  fixed: boolean
  /** 仅 topbar 条目携带；tabbar/rail 条目走路由跳转（容器按 id 自建） */
  action?: TopbarAction
  to?: RouteLocationRaw
}

/** 目录条目（内部）：NavEntry + 解析需要的元数据（缺省显隐 / 归属插件 / 声明序） */
interface CatalogItem extends NavEntry {
  /** 仅 topbar：从未编辑时的缺省显隐（§types.ts 的 TopbarContribution.defaultOn） */
  defaultOn: boolean
  /** 归属插件 id（null = 内核条目，恒启用） */
  pluginId: string | null
  /** 声明序：从未编辑时的缺省排布按它排 */
  order: number
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** 读本地布局：版本不符 / 字段非字符串数组 → 整份回落「从未编辑」（坏布局不能拖垮启动） */
function load(): NavLayoutPayload {
  try {
    const raw = localStorage.getItem(NAV_LAYOUT_STORE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, unknown>
        if (p.v === 1) {
          const out: NavLayoutPayload = { v: 1 }
          if (isStringArray(p.tabbar)) out.tabbar = p.tabbar
          if (isStringArray(p.rail)) out.rail = p.rail
          if (isStringArray(p.topbar)) out.topbar = p.topbar
          return out
        }
      }
    }
  } catch {
    /* 本地存储不可用 / 载荷损坏：全部容器按目录缺省渲染 */
  }
  return { v: 1 }
}

export const useNavLayoutStore = defineStore('navLayout', () => {
  const payload = ref<NavLayoutPayload>(load())

  /** 目录全集（内核 + 插件贡献，含未启用模块）：同 id 只留首个（内核在前） */
  function catalogOf(scope: NavEditScope, features: ReturnType<typeof useFeaturesStore>): CatalogItem[] {
    const items: CatalogItem[] = []
    if (scope === 'topbar') {
      // 顶栏没有内核条目（主页/我都是导航条目，不是按钮）
      for (const t of features.topbarCatalog()) {
        items.push({
          id: t.id,
          label: t.label,
          icon: t.icon,
          fixed: false,
          action: t.action,
          to: t.to,
          defaultOn: t.defaultOn !== false,
          pluginId: t.pluginId,
          order: t.order,
        })
      }
    } else {
      for (const k of kernelNav(scope)) {
        items.push({
          id: k.route,
          // 标签按容器解析（rail 的 home = 「总览」），这是两份硬编码收进目录的那个投影
          label: k.labels?.[scope] ?? k.label,
          icon: k.icon,
          fixed: k.fixed.includes(scope),
          defaultOn: true,
          pluginId: null,
          order: k.order,
        })
      }
      for (const n of features.navCatalog(scope)) {
        items.push({
          id: n.route,
          label: n.label,
          icon: n.icon,
          fixed: false,
          defaultOn: true,
          pluginId: n.pluginId,
          order: n.order,
        })
      }
    }
    // 按声明序收敛 + 同 id 去重：内核与插件贡献撞 id 属声明错误，渲染层不做第二份裁决
    // （不去重的话 RouterLink :key 重复，Vue 渲染当场报警）
    items.sort((a, b) => a.order - b.order)
    const byId = new Map<string, CatalogItem>()
    for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it)
    return [...byId.values()]
  }

  /**
   * 布局 ∩ 目录：算出有序 id 序列（尚未做启用态过滤）。
   * 两条路径（§2.3）：从未编辑 → 目录缺省序（topbar 额外消费 defaultOn，否则 defaultOn:false
   * 的按钮会在从未编辑过的顶栏错误出现）；编辑过 → 固定件就位 + 存储序（失效 id 丢弃、
   * 重复 id 只留首次、固定件 id 剔除 —— 只过滤，存储原样不动）。
   */
  function resolveIds(scope: NavEditScope, catalog: CatalogItem[]): string[] {
    const stored = payload.value[scope]
    if (!stored) {
      return catalog
        .filter((c) => scope !== 'topbar' || c.defaultOn)
        .map((c) => c.id)
    }
    // 固定件就位：声明序最小的固定件排最前（tabbar/rail = 主页/总览），其余殿后（tabbar = 我）
    const fixedItems = catalog.filter((c) => c.fixed)
    const head = fixedItems.slice(0, 1).map((c) => c.id)
    const tail = fixedItems.slice(1).map((c) => c.id)
    const inCatalog = new Set(catalog.map((c) => c.id))
    const fixedIds = new Set(fixedItems.map((c) => c.id))
    const storedIds: string[] = []
    for (const id of stored) {
      if (!inCatalog.has(id) || fixedIds.has(id) || storedIds.includes(id)) continue
      storedIds.push(id)
    }
    return [...head, ...storedIds, ...tail]
  }

  /** 目录条目 → 对外 NavEntry（剥掉内部元数据） */
  function toEntry(c: CatalogItem): NavEntry {
    const entry: NavEntry = { id: c.id, label: c.label, icon: c.icon, fixed: c.fixed }
    if (c.action !== undefined) entry.action = c.action
    if (c.to !== undefined) entry.to = c.to
    return entry
  }

  /** 渲染清单 = 布局 ∩ 目录 ∩ 启用态。三个容器的唯一数据入口。 */
  function items(scope: NavEditScope): NavEntry[] {
    const features = useFeaturesStore()
    const catalog = catalogOf(scope, features)
    const byId = new Map(catalog.map((c) => [c.id, c]))
    return resolveIds(scope, catalog)
      .map((id) => byId.get(id))
      .filter((c): c is CatalogItem => !!c)
      // 关掉模块条目自然消失，位置保留（模块重开原位回来）；内核条目恒启用
      .filter((c) => c.pluginId === null || features.isEnabled(c.pluginId))
      .map(toEntry)
  }

  /**
   * 候选：已启用 ∩ 目录 − 当前布局。**唯一消费方是编辑态**（Dock 托盘 / rail 菜单编辑面板 /
   * 顶栏编辑下拉）；纯重排保存后它为空是正确语义（没有可加回的东西）。
   * 关掉的模块连候选都不进（「+」一个看不见的空位是坏交互）；固定件也不进（它们永远在布局里）。
   * 注意：Dock 左钮落点候选与 ⌘K「底栏左键」组**不用本函数** —— 那是 dock 偏好域，
   * 继续消费 features.nav('rail')（目录源），与用户 rail 布局互不污染。
   */
  function candidates(scope: NavEditScope): NavEntry[] {
    const features = useFeaturesStore()
    const catalog = catalogOf(scope, features)
    const inLayout = new Set(resolveIds(scope, catalog))
    // 底栏候选池向桌面左栏看齐（2026-11-08 用户定稿：多加些页面进底栏）：rail 目录里
    // 的页面也能加进底栏编辑 —— 「哪些页面合适」以桌面 rail 的注册面为准。默认布局
    // 不受影响（resolveIds 只消费本容器目录，仍是 主页,运动,我,AI）；固定件照旧不进候选。
    const pool = [...catalog]
    if (scope === 'tabbar') {
      const seen = new Set(pool.map((c) => c.id))
      for (const c of catalogOf('rail', features)) if (!seen.has(c.id)) pool.push(c)
    }
    return pool
      .filter((c) => !c.fixed && !inLayout.has(c.id))
      .filter((c) => c.pluginId === null || features.isEnabled(c.pluginId))
      .map(toEntry)
  }

  /** 编辑态保存：整表替换对应容器字段并持久化（固定件 id 由这里防御性剔除） */
  function apply(scope: NavEditScope, ids: string[]): void {
    const features = useFeaturesStore()
    const fixedIds = new Set(
      catalogOf(scope, features)
        .filter((c) => c.fixed)
        .map((c) => c.id),
    )
    const clean: string[] = []
    for (const id of ids) {
      if (fixedIds.has(id) || clean.includes(id)) continue
      clean.push(id)
    }
    const next: NavLayoutPayload = { ...payload.value }
    next[scope] = clean
    payload.value = next
    try {
      localStorage.setItem(NAV_LAYOUT_STORE_KEY, JSON.stringify(next))
    } catch {
      /* 存不下（私隐模式等）退化为内存态 */
    }
  }

  return { items, candidates, apply }
})
