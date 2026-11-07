# 导航系统解耦重构 · 实施设计

> 状态：设计定稿（待实施）。本文是唯一的实施蓝图；行号引用以 2026-11-07 的 main（a5bee3a）为准。
> 修订：v2（同日评审修订）——candidates() 契约收紧为编辑态专属（§3.3/§3.5/§5.1）、rail 菜单正常态改目录源（§6.1）、编辑态层级账重做（z + inert，§4.3/§4.4）、AppMenu locked 补「选中即关」第四条路径（§4.5）、touch-action:none 前置（§4.2）、resolve 补 defaultOn 分支与去重（§2.3）、顶栏种子图标与 id 修正（§3.1/§7.1）、长按换身移交（§5.2）。
> 修订：v3（同日第二轮评审修订）——nav()/navCatalog 定死为**插件-only**（内核条目只经 kernelNav/navLayout 进入，保 core 先行的中间提交全绿，§2.3/§3.2/§3.5/§6.1）、被遮主内容根入 inert 账（§4.3）、dock 右钮入非编辑面（§4.3/§5.2）、历史导航记为已知边界（§4.4）、清理 v1 残句与引文混用（§6.2/§4.4/§4.2）。
> 目标一句话：**导航容器只做渲染，内容全部来自「注册表 + 用户布局」**；三个容器（移动端 Dock / 桌面左栏 / 桌面顶栏）共享同一套数据模型与编辑态交互，不复制三份。

---

## 0. 范围与「不做什么」

做：

1. 统一数据模型：每个导航容器一份用户布局（有序 id 列表），渲染 = 布局 ∩ 注册表。
2. 三个容器的编辑态（±徽标 / 拖拽 / mask / 放弃 / 保存）做成共享层。
3. 桌面顶栏新增「功能按钮」贡献面（纯声明 + 宿主实现，对齐 ToolAction 模式）。

不做（并说明为什么不做）：

- **不碰 `GlassDockAssembly.vue` / `GlassSurface.vue` / base.css 的 dock 几何**。三块玻璃装配被 `SettingsPerfPage` 与 `GlassTunerSheet` 当画质标本共用，`e2e-perf-glass` 断言标本与真实 Dock 逐项一致（`scripts/e2e-perf-glass.mjs:291-295,346-364`）。编辑态的一切视觉（徽标 / 托盘）只落在 TabBar 的**插槽内容**里，且只在编辑态渲染——perf 剧本永远不进编辑态，标本比对天然不受影响。
- **不把内核条目塞进 `definePlugin`**。若给 home/me 造一个「shell 插件」，`plugins` 数组会多出一个 id，`App.vue:201` 的 `enabledModuleIds` 快照（推给 Rust 网关，contract §4.7）与 `routeOwner` 语义都会被波及——收益为零、风险面一整条。内核条目走独立的纯数据目录（§2.2），路由所有权（`router.ts:295-302` 守卫）完全不动。
- **不做折射/玻璃升级**。编辑态徽标、mask 是临时态控件，不进 ARCHITECTURE §5 的「有预算的折射名单」；动效只用既有 `--dur-*`/`--ease-*` 令牌，不加 `motionRich` 专属效果（`system/motion.ts:89` 的丰富档是每帧合成的预算位，编辑态不配占）。
- **不重写 `useBentoLayout`**。便当布局是语义先例（`composables/useBentoLayout.ts:16-27` 的「未知 id 丢弃 / 缺省位补齐 / 隐藏项占位」），本设计借用其规则但**不**顺手重构它；`useNavDrag`（§4.2）抄它的手势骨架，不改 bento 一行。
- **不动 `dockHint.ts` / `deskShell.ts` / `windowChrome.ts`**。抑制逻辑放在消费侧（TabBar 的 `maybeShowHint` 门），偏好文件本身无新状态。

---

## 1. 名词

| 词 | 含义 |
| --- | --- |
| **目录（catalog）** | 某容器「所有已注册条目」的全集 = 内核目录 + 插件贡献。与启用态无关（关掉的模块仍在目录里占位）。 |
| **布局（layout）** | 某容器的一份有序 id 列表（用户编排的结果），持久化在 `rein.navLayout.v1`。 |
| **渲染清单** | 布局 ∩ 目录 ∩ 启用态。容器唯一消费的输入。 |
| **候选（candidates）** | 已启用、已注册、但不在当前布局的条目。编辑态「+」徽标的来源。 |
| **固定件（fixed）** | 声明为不可移除/不可拖的条目（Dock 的主页/AI/我、左栏的总览）。位置由容器固定，不进布局存储。 |
| **编辑态（edit session）** | 一次 `useNavEdit` 会话：草稿 + mask + 两颗退出钮。全局同一时刻至多一个容器处于编辑态。 |

---

## 2. 统一数据模型与持久化

### 2.1 条目 id 的命名

- `tabbar` / `rail` 的布局 id = **路由名**（`'home'` / `'sports'` / `'todos'` …）。理由：`NavContribution.route`（`plugins/types.ts:17`）、`dock.leftRoute`（`stores/dock.ts:14-17`）、`App.vue:79-84` 的 deskKeys、e2e 断言全部已经在说路由名，不引入第二套命名。
- `topbar` 的布局 id = **按钮 id**（`'focus.topbar'` 这类；`<模块>.topbar` 前缀的命名空间规则见 §3.1）。顶栏按钮不是路由（多数是就地动作），不冒充路由名。

### 2.2 内核条目目录 `src/plugins/kernelNav.ts`（新建）

纯数据，不 import Pinia/router，与 `registry.ts` 同一条分层纪律：

```ts
import type { Component } from 'vue'
import type { NavContribution, NavSurface } from './types'

/** 内核条目：在 fixed 列出的容器里是固定件（不可移除、不可拖、位置由容器定） */
export interface KernelNavEntry extends NavContribution {
  fixed: NavSurface[]
}

/**
 * 内核导航目录。为什么不经 definePlugin：见本文 §0（routeOwner 与网关快照都不该被波及）。
 * order 沿用 types.ts:21 的约定：内核占 0~99 与末档，插件用 100 起步。
 */
export const KERNEL_NAV: readonly KernelNavEntry[] = [
  {
    route: 'home', label: '主页', labels: { rail: '总览' }, icon: House,
    surfaces: ['tabbar', 'rail'], order: 0, fixed: ['tabbar', 'rail'],
  },
  {
    route: 'me', label: '我', icon: User,
    surfaces: ['tabbar'], order: 990, fixed: ['tabbar'],
  },
]
```

三个刻意决定（都与现状逐像素对齐，并回应规格）：

1. **`labels` 按容器覆盖**：`NavContribution` 增加可选 `labels?: Partial<Record<NavSurface, string>>`（缺省回落 `label`）。Dock 药丸显示「主页」、左栏显示「总览」——今天这个差别由两份硬编码（`TabBar.vue:34` 与 `DesktopRail.vue:19`）各自维护，收进目录后是同一枚条目的两个投影。
2. **`me` 只投 `tabbar`**：左栏的「我」保持为 DesktopRail 模板里的壳层固定件（`DesktopRail.vue:62-70`，与 logo/命令面板/信息栏同簇，`:46-49` 注释本就把它归为壳层）。规格说左栏「全部条目可自定义、主页必须保留」——本设计把「条目」读作**插件贡献的一级页**，「我」是壳层固定件：桌面始终有一个位置固定的个人入口，且 `e2e-feature-toggles` 的 rail aria 全集断言（`scripts/e2e-feature-toggles.mjs:635-653`）零改动。数据模型不设障碍：将来要放开，把 `me` 加投 `rail` 并摘掉 `fixed` 即可，容器无需改结构。
3. **AI 的右独立圆钮继续由 TabBar 自己声明**（`TabBar.vue:38-39`，与 `core.ts:30-31` 的注释一致）。右钮是 Dock 的**槽位**不是布局条目——「AI 不可移除」由它根本不进布局来保证，比存进布局再禁止移除干净得多。

### 2.3 解析规则（布局 ∩ 注册表）

`stores/navLayout.ts`（新建，Pinia setup store）内的唯一解析函数，规则逐条标注出处：

```
resolve(scope):
  catalog  = kernelNav(scope) + features.navCatalog(scope)  # 目录全集（内核 + 插件贡献），含未启用模块；
                                                            # 插件贡献一律经 §3.2 的 navCatalog（插件-only）取
  stored   = payload[scope]                               # 字段缺省 = 该容器从未编辑过
  if stored 缺省:
      topbar: ordered = catalog.filter(c => c.defaultOn !== false) 按声明 order 排
              # defaultOn 的语义就是「从未编辑时的缺省显隐」（§3.1）——缺省路径必须消费它，
              # 否则 defaultOn:false 的按钮会在从未编辑过的顶栏错误出现
      其它:   ordered = catalog 按声明 order 排            # 全新安装 ≡ 现状渲染（e2e『主页,运动,我』依赖这条）
  else:
      ordered = 固定件就位（tabbar: home 首、me 尾；rail: home 首）
              + stored.filter(id ∈ catalog)               # 失效 id 静默丢弃——只过滤，不写回存储
                .dedupe()                                 # 损坏/手改 payload 的重复 id 只保留首次出现——
                                                          # bento 靠 id→item Map 天然免疫（useBentoLayout.ts:203-217），
                                                          # 这里的有序数组没有那层免疫，必须显式去重
  return ordered.filter(归属插件 isEnabled)                # 关掉模块条目自然消失，位置保留（useBentoLayout.ts:18-19 的「隐藏项占位」语义）
```

- **失效 id 不写回**：解析期过滤，存储原样。模块重开 → 条目原位回来。
- **编辑过的容器是冻结的**：一旦存了布局，新插件条目**不自动出现**，落进候选清单等用户显式加回。这刻意偏离 bento 的「缺省位补齐」（`useBentoLayout.ts:119-125`）：导航条目无法区分「新条目」与「被用户刚删掉的条目」（存储里两者都是「不在列表」），自动补齐会复活用户刚删的东西；而编辑态的候选清单（托盘/menu）天然是新增条目的承接面。
- **候选只列已启用条目**：关掉的模块连候选都不进（设置页开回来它自然进候选）。「+」一个关掉模块的按钮，只会得到一个看不见的空位，那是坏交互。

### 2.4 存储：`rein.navLayout.v1`

风格对齐 `dock.ts`（只存路由名，候选现取、失效回落）与 `features.ts`（只存用户改过的项，新增免迁移）：

```ts
const STORE_KEY = 'rein.navLayout.v1'   // 常量命名 STORE_KEY，与 features.ts:23 / dock.ts:14 同名同位

interface NavLayoutPayload {
  v: 1
  /** 各容器用户布局（有序 id）。字段缺省 = 从未编辑过 → 按目录缺省渲染。
      tabbar/rail 只存可移除项（固定件永不入存）；topbar 存按钮 id 全序列。 */
  tabbar?: string[]
  rail?: string[]
  topbar?: string[]
}
```

- 读：`try/catch` + 版本不符/非数组整份回落缺省（同 `useBentoLayout.ts:129-133`）；**容器没编辑过就绝不写键**（与 features 的 overrides 同一克制——不产生无意义的首写）。
- 写：只在编辑态「保存布局」时写对应字段（`apply()`），`try/catch` 存不下退化为内存态。
- 注释里声明：界面级偏好，**不进 SQLite、不进知识库索引**（`features.ts:20-22` 的原话纪律）。
- 与 `rein.dock.v1` 的关系：互不读写。左钮落点仍是独立偏好（§8.1）。

---

## 3. 注册表与布局层 API

### 3.1 `src/plugins/types.ts` 扩展（core 区）

```ts
/** 顶栏功能按钮的就地动作名。语义同 ToolAction（types.ts:7-12 的注释原样适用）：
    插件声明「做什么」，壳层宿主 TopbarActions.vue 实现「怎么做」。
    新增动作 = 这里加一个字面量 + 宿主 ACTIONS 表实现。 */
export type TopbarAction = 'focus-toggle' | 'record-toggle' | 'voice-session'

/** 顶栏功能按钮贡献：纯数据，不 import router、不持有组件状态 */
export interface TopbarContribution {
  /** 全局唯一 id，顶栏布局存储用它。与 ToolContribution.id（types.ts:27-29）是**两个独立的
      命名空间**，但统一用 `<模块>.topbar` 前缀——ToolContribution.id 的注释写明它与渲染
      key/开关埋点共用（types.ts:27-28），前缀错开才不会在埋点里把「顶栏按钮」读成「工具卡」，
      也避免与既有 'voice.session'（voice.ts:28-29）这类工具卡 id 撞字符串。 */
  id: string
  label: string
  icon: Component
  /** 就地动作（优先于 to） */
  action?: TopbarAction
  /** 纯跳转（与 action 二选一，同 ToolContribution.to） */
  to?: RouteLocationRaw
  order: number
  /** 用户从未编辑过顶栏时的缺省显隐（缺省 true） */
  defaultOn?: boolean
}

/** PluginSpec 增加可选字段（types.ts:46-71 上加一行） */
topbar?: TopbarContribution[]

/** NavContribution 增加可选字段：容器별标签覆盖（§2.2） */
labels?: Partial<Record<NavSurface, string>>
```

`NavSurface` **保持** `'tabbar' | 'rail'` 不变；新增独立联合：

```ts
/** 布局容器键：navLayout 存储 / 编辑态 / mask 的 scope。
    为什么不复用 NavSurface：topbar 不是插件 nav 贡献面（它有自己的 TopbarContribution），
    把它塞进 NavSurface 会让 NavContribution.surfaces 出现永远不该填的值。 */
export type NavEditScope = 'tabbar' | 'rail' | 'topbar'
```

### 3.2 `src/stores/features.ts` 扩展（core 区）

```ts
/** 插件贡献目录：某容器的**全部插件贡献**（不论开关），按 order 升序。
    **不含内核条目**——kernelNav 只经 navLayout 的 resolve 进入渲染（§2.3/§3.3）。
    为什么 nav() 不能把内核并进来：§9 规定 core 先行、容器三线后并行，在 TabBar.vue:53 /
    DesktopRail.vue:23 换源之前，nav('tabbar') 一旦膨胀出 home/me，药丸会渲染成
    「主页,主页,运动,我,我」（RouterLink :key 重复），e2e-feature-toggles.mjs:226 的
    dock0.pill 断言在 core 提交上当场红，rail 侧总览×2 同理。 */
function navCatalog(surface: NavSurface): (NavContribution & { pluginId: string })[]

/** nav(surface)（features.ts:88-92）＝ navCatalog → isEnabled 过滤。
    **成员与今天逐字相同**（插件-only），对外签名与排序语义不变——core 先行的中间提交
    对一切存量消费方（含未换源的 TabBar/DesktopRail）零可见变化。
    消费方：左钮候选、命令面板落点候选消费的是 nav()（§3.5），不是 navCatalog。 */

/** 顶栏按钮目录：全部插件 topbar 贡献，按 order 升序（不做 isEnabled 过滤——布局解析自己过滤） */
function topbarCatalog(): (TopbarContribution & { pluginId: string })[]
```

### 3.3 `src/stores/navLayout.ts`（新建，core 区）

```ts
export const NAV_LAYOUT_STORE_KEY = 'rein.navLayout.v1'

/** 解析后的条目：容器渲染与编辑态直接消费；label 已按容器解析好（rail 的 home = 「总览」） */
export interface NavEntry {
  id: string              // 路由名（tabbar/rail）或按钮 id（topbar）
  label: string
  icon: Component
  /** 固定件：不可移除/不可拖（徽标与拖拽把手都不渲染） */
  fixed: boolean
  /** 仅 topbar 条目携带；tabbar/rail 条目走路由跳转 */
  action?: TopbarAction
  to?: RouteLocationRaw
}

export const useNavLayoutStore = defineStore('navLayout', () => ({
  /** 渲染清单 = 布局 ∩ 目录 ∩ 启用态（§2.3）。三个容器的唯一数据入口。 */
  items(scope: NavEditScope): NavEntry[]
  /** 候选：已启用 ∩ 目录 − 当前布局。**唯一消费方是编辑态**（Dock 托盘 / rail 菜单编辑面板 /
      顶栏编辑下拉）；纯重排保存后它为空是正确语义（没有可加回的东西）。
      Dock 左钮落点候选与 ⌘K「底栏左键」组**不用本函数**——分界见 §3.5。 */
  candidates(scope: NavEditScope): NavEntry[]
  /** 编辑态保存：整表替换对应容器字段并持久化（固定件 id 由这里防御性剔除） */
  apply(scope: NavEditScope, ids: string[]): void
}))
```

容器从此**只 import navLayout**（不再各 import features 拼清单）——`TabBar.vue:53` 的 `[...CORE_TABS, ...features.nav('tabbar')]` 与 `DesktopRail.vue:23` 的同款拼接整体消失，内核清单只剩 kernelNav 一份。

### 3.4 三个容器的消费方式（一行一条）

| 容器 | 渲染 | 候选/编辑 |
| --- | --- | --- |
| TabBar | `navLayout.items('tabbar')` → 药丸（固定件就位 + 用户序） | `navLayout.candidates('tabbar')` → 编辑托盘 |
| DesktopRail | `navLayout.items('rail')` → `.navs` 簇（`me` 固定件留在模板底部簇） | `navLayout.candidates('rail')` → 全部菜单的编辑面板 |
| TopbarActions | `navLayout.items('topbar')` → 标题栏按钮区 | `navLayout.candidates('topbar')` → 编辑下拉面板 |

### 3.5 落点候选（dock 偏好域）与容器渲染域的分界

- **TabBar 左钮候选（`TabBar.vue:55-59`）与 `CommandPalette.vue:207-210` 的 `dockCandidates` 维持现状代码**：继续消费 `features.nav('rail')`。§3.2 改造后 `nav('rail')` ＝ 插件目录派生（启用的插件贡献按 order 排），**成员与今天逐字相同**——它既不含内核条目、也从来不经过用户 rail 布局，所以 rail 布局怎么重排/撤减，左钮候选与 ⌘K 落点清单都不受污染（这正是解耦要买的东西：`rein.dock.v1` 与 rail 布局互不污染）。两处共用的同源规则是 dock 偏好域的既有重复，不属于容器渲染域，本次不收编。
- **`navLayout.candidates()` 若误接到左钮候选会双向坏**：按目录−布局读，全新安装（stored 缺省 = 全量在布局）候选为空 → `leftTab` 回落 null、左钮整块消失（`TabBar.vue:61-64`），`e2e-feature-toggles.mjs:250-253` 的长按清单断言（必含「营养」「待办」）必红；rail 任意一次**纯重排**保存后候选同样为空，左钮会从存量落点（`rein.dock.v1` 里的 `campus-schedule`）静默跳成 candidates[0]——两种读法都违背 §8.1/§10⑤。
- **`useBentoLayout.ts:100-105` 的 `MODULE_ITEMS` 与 FeatureSettingsPage**：消费的是插件开关不是 nav 形状，不动。`features.nav()` 对外签名与语义未变；本设计落地后 `grep 'features.nav('` 的存留命中 = TabBar 左钮候选 ×1（`:58`）、CommandPalette ×2（`:208` tabbar 占用、`:209` rail 目录）——均为 dock 偏好域，合法留存；容器**渲染**清单归零（TabBar `:53` 与 DesktopRail `:23` 的拼接改走 navLayout）。

---

## 4. 共享编辑态（core，三容器复用）

### 4.1 会话层 `src/composables/useNavEdit.ts`（新建）

模块级单例（落点风格照 `system/deskShell.ts:10-11` 的「跨组件共享状态不进 App 二传手」）：

```ts
export type { NavEditScope }

export function useNavEdit(scope: NavEditScope): {
  /** 本容器是否处于编辑态 */
  editing: ComputedRef<boolean>
  /** 全局活动编辑态（null = 无）。mask、App.vue 键盘守卫、跨容器互斥都用它 */
  activeScope: ComputedRef<NavEditScope | null>
  /** 进入：对 items(scope) 取 id 快照作为草稿。已有其他容器在编辑时为 no-op（互斥） */
  enter(): void
  /** 草稿（有序 id，null = 不在编辑态）。容器编辑态视图以草稿为准渲染 */
  draft: Ref<string[] | null>
  addToDraft(id: string): void      // 「+」：追加到草稿末尾（随后可拖）
  removeFromDraft(id: string): void // 「-」：从草稿摘除（回到候选）
  moveInDraft(id: string, to: number): void
  /** 放弃变更：回滚到快照并退出（草稿从未落盘，丢弃即回滚） */
  discard(): void
  /** 保存布局：navLayout.apply(scope, draft) 并退出 */
  save(): void
}
```

不变量（写进文件头注释，三容器共用同一份措辞）：

- 同一时刻至多一个容器在编辑态（`activeScope` 单例保证；第二个 `enter()` 是 no-op）。
- **退出编辑态只有两条路：放弃变更 / 保存布局**。mask 点击不退出（规格原文）；Esc 只取消**进行中的拖拽**（沿用 `useBentoDrag` 的语义，`useBentoLayout.ts:545-549`），不退出会话。
- 草稿只在内存。组件卸载（桌面 ↔ 移动壳切换、沉浸页）时由 App.vue 统一 `discard()`（§4.4）——半成品永远到不了 localStorage。

### 4.2 拖拽 `src/composables/useNavDrag.ts`（新建）

从 `useBentoDrag`（`useBentoLayout.ts:320-581`）抄手势骨架泛化，不引库：

```ts
export function useNavDrag(options: {
  /** 条目所在容器（找项、找滚动宿主） */
  listEl: Ref<HTMLElement | null>
  /** 当前顺序（草稿 id 序） */
  orderIds: () => string[]
  move: (id: string, to: number) => void
}): {
  dragId: Ref<string | null>
  /** 8px slop 起抓（useBentoLayout.ts:320）、elementFromPoint 落点解算（:459-475）、
      松手吞 click（:321-322）、Esc 取消 —— 行为与 bento 拖拽完全同手感 */
  onHandleDown: (e: PointerEvent, id: string) => void
}
```

条目统一带 `data-nav-id` 属性（对应 bento 的 `data-bento-id`，`useBentoLayout.ts:365-367`）。自动滚宿主查找照抄（桌面下就是 `.desk-main`）。**不**给被拖项做绝对定位，live-reorder 语义同 bento。

**`touch-action:none` 是拖拽的前置条件，不是优化**：`base.css:39` 给文档滚动层定的全局手势是 `pan-x pan-y`，安卓上拖拽面一被移动，指针事件就被滚动链接管成 `pointercancel`——拖拽永不触发。编辑态给三个拖拽面（Dock 药丸 / rail `.navs` 簇 / 顶栏按钮行）声明 `touch-action:none`，**只在编辑态挂**：非编辑态不碰手势链，页面滚动照旧。两条引用各归各位——`touch-action:none` 让滚动链整场让手的先例与措辞是 `BentoOverview.vue:439-440`（「rubberScroll 判定滚动链时遇到 touch-action:none 会整场让手」，bento 抓柄自管手势）；页面级容器自己要更宽手势的先例是课表周视图的 `pan-x pan-y`（`ScheduleWeekView.vue:398`）。

### 4.3 mask `src/components/common/NavEditMask.vue`（新建）+ 令牌

- `App.vue` 常驻挂载一枚：`<NavEditMask v-if="navEditAnyEditing" />`。一份组件服务三个容器——**盖谁不盖谁由 z-index + inert 表达，不由 mask 自己判断**。mask 之上浮着三层既有壳层（rail 50 / dock 60 / 标题栏），它们**只有在自己是 activeScope 时**才允许交互；「不是编辑面的浮出层」一律 `inert`（HTML 全局属性：指针与焦点一起封，比 pointer-events:none 多封掉 Tab 链）：

| 层 | z-index | 编辑态交互规则（谁挂 inert / 谁放行） |
| --- | --- | --- |
| `NavEditMask` | **45** | 吞点击、永不据此退出（§4.1） |
| AppTitleBar | 静态流内元素 → **anyEditing 即提权**：App.vue 对其用法挂 `nav-edit-live`（`position:relative; z-index:46`，样式写在 App.vue 的 `.win-shell--desk` 段，避免与窄窗 sticky 规则 `App.vue:444-448` 抢 `position`） | **所有 scope 都提权**：窗控三钮恒可点——rail 编辑时标题栏若无提权恰被 mask 45 盖住，最小化/关闭全部失灵（编辑态卡死窗口是事故级体验）；TopbarActions 按钮区仅 `activeScope === 'topbar'` 可交互（TopbarActions 自读 useNavEdit，§7.3） |
| DesktopRail | 50（现有，`DesktopRail.vue:91`） | 仅 `activeScope === 'rail'`；**topbar 编辑时它浮在 mask 上且处于正常态**——RouterLink、命令面板、全部菜单 hover 全是鼠标路径的路由出口（§4.4 的键盘门堵不住鼠标），App.vue 对它挂 `inert` |
| TabBar | 60（现有，`TabBar.vue:274`） | 仅 `activeScope === 'tabbar'`（移动壳与 rail 不同时挂载，规则对称写下防将来） |
| 常驻浮条 | FloatDock 系 **59 停靠 / 70 拖拽**（`common/FloatDock.vue:103,108`：ActiveWorkoutBar / RecordFloatBar / FocusFloatBar / VoiceFloatBar 四条共用），GrabFloatBar `.hud` **80**（`campus/GrabFloatBar.vue:358`），FocusNoticeBar（`App.vue:374` 挂载） | anyEditing → App.vue 挂 `inert`（App.vue:362-379 本就持有它们的 v-if/v-show，属性透传到各自根元素）。它们全部可点且可触发路由或沉浸层（GrabFloatBar → 选课页），不属于任何编辑面 |
| WindowResizeHandles | 80（`WindowResizeHandles.vue:92`） | 不封：只改窗宽，不触布局数据与路由 |
| AppMenu 面板 | 115+（现有，`AppMenu.vue:151`） | 编辑面（locked 常开，§4.5） |
| ToastHost | 120（现有） | 不封：无路由 |
| **主内容根** | —（流内内容，被 mask 盖住） | anyEditing → App.vue 挂 `inert`：桌面 `main.desk-main`（`App.vue:323`）与 `DesktopInspector`（`:337`）、移动 `app-frame` 的内容层 `data-rubber-shell`（`:344`）。**mask 只挡指针不挡焦点**——不封的话 Tab 仍可走进被遮页面、Enter 照样触发链接与按钮、照样切路由；inert 连焦点一起封，正是本表给浮出层挂 inert 的同一条理由，用在被遮主体上 |

- 沉浸层（`FocusImmersive` / `SessionOverlay`）与编辑态**天然互斥**：它们出现时 `shellVisible=false`、rail/dock 都藏着，没有编辑入口；运行时自发唤起的全屏层（`VoiceSessionView`）不在封禁清单——它的用户入口已被 mask 与 inert 封死。
- 非 `activeScope` 的浮出容器（如 topbar 编辑时的 rail）**只封不灰**：mask 的全局变暗已传达「编辑中」，视觉上再压一层会读成「坏了」；实测读感有歧义再补 opacity 档，不进本版。

- 背景色走新令牌（规格给的是裸值 `rgb(0,0,0,0.05)`；仓库纪律是「魔法值直接打回」，且暗色下 5% 黑罩几乎不可见，参照 `--glass-scroll-edge` 的亮暗双档思路，`tokens.css:138` 亮 0.16 / `:746` 暗 0.44）：

```css
/* tokens.css 亮色段 */
--scrim-edit: rgb(0, 0, 0, 0.05);   /* 规格值：编辑态「退后一层」的轻遮罩 */
/* tokens.css 暗色段 */
--scrim-edit: rgb(0, 0, 0, 0.28);   /* 暗色下 0.05 不可见；比 --scrim 轻——是层级信号不是模态 */
```

（暗色浓度 0.28 是设计给值，实现时按真机截图微调，双档结构不变。）

- 行为：`position:fixed; inset:0; z-index:45`；**吞点击但永不据此退出**（§4.1 不变量）；淡入淡出走 `--dur-fast`/`--ease-standard`；不加 backdrop-filter（它是每帧合成的预算位，编辑态不占）。
- **编辑容器内的非编辑面**（rail 的 logo/cmd/insp/me、dock 的左钮**与右钮**）：照常可见，`pointer-events:none` + `aria-disabled`，视觉不另加灰（mask 已经把页面压下去了，容器内再压一层会读成「坏了」）。dock 右钮是 RouterLink（`TabBar.vue:220-230`）——dock 编辑态下 mask 之上唯一没封的路由出口，必须与左钮同账。窗控三钮不在「非编辑面」之列：它们恒可点（§4.3 表 AppTitleBar 行），且不触布局数据。

### 4.4 `App.vue` 挂载与守卫（core 区）

- 挂 `<NavEditMask>`；`import { useNavEdit }` 建一个 scope 无关的句柄读 `activeScope`。
- **inert / 提权绑定都落在 App.vue 的模板用法上**（AppTitleBar `:309-312`、DesktopRail `:316-322`、TabBar `:351-354`、浮条与 FocusNoticeBar `:362-379`、主内容根 `.desk-main`/`DesktopInspector`/`data-rubber-shell` `:323,337,344`）——core 拥有这些挂载点，class/attribute 走透传，容器组件自身的模板与样式不动（§4.3 表）。
- `onDeskKey`（`App.vue:86-112`）加一道门：`activeScope !== null` 时忽略 ⌘1-4 与 ⌘K（编辑态里页面飞走 = 草稿悬空；⌘I 信息栏开关同闭）。⌘K 面板虽是 Teleport 浮层不会被 mask 盖住，但入口先关掉。这只堵键盘快捷键；**指针路径由 §4.3 的 inert 账封死**（rail 在非 rail 编辑态、浮条、被遮主内容根）；**历史导航是已知边界**（下一条）。
- **历史导航不退出会话**：浏览器返回 / Alt+Left / 鼠标侧键 / 安卓系统返回（Tauri WebView 的 hash 路由同样走 popstate）不在键盘门与 inert 账内。处置：编辑会话**跨路由存活**——历史导航只改变 mask 底下的页面，会话不退出、草稿不保存也不丢弃，mask 继续盖住新页面；「退出编辑态只有两条路」的不变量对编辑态本身成立。不为它加 popstate 拦截：拦用户的导航自由，比「盖着 mask 换了一页」的怪异瞬间更伤。
- `watch(isDesktop)`（`:265-271` 旁）：`activeScope !== null` 且 isDesktop 翻转（或 `shellVisible` 变 false 的沉浸页切入）→ `discard()`。理由见 §4.1。
- `<html>` 的 `data-*` 不新增——编辑态是会话不是主题，游离子孙无需读它。

### 4.5 `AppMenu.vue` 两处向后兼容扩展（core 区）

1. **`locked?: boolean`**：旁路 AppMenu 的**全部四条**关闭路径——① `.catcher` 点击（`AppMenu.vue:416`，且 catcher 不再渲染：z114 全屏拦截会吃掉 rail 条目的「−」点击，rail z50 < catcher z114）；② Esc（`:314-316`）；③ viewport 变化（`:198-201`）；④ **选中即关**：`onItemClick` 在 `emit('select')` 后紧跟 `emit('close')`（`AppMenu.vue:183-184`），locked 下跳过 close（select 照发，键盘 Enter 走同一函数、同样被覆盖）。④ 是 rail 编辑态的命门：候选面板靠 mouseenter 打开（§6.1），点「＋」若把面板关了，编辑流一次就断且回不去。缺省 false，既有消费方（TabBar picker、dialog 模式）零改动；locked 只影响 bind 模式。
2. **`#panel-actions` 具名插槽**：bind 模式根层面板标题行（`.ptitle`，`AppMenu.vue:430`）右侧渲染，供「编辑」钮（rail）与「放弃/保存」钮（topbar）落位。缺省不渲染，结构不变。

---

## 5. 容器一 · 移动端 Dock（TabBar，mobile 区）

### 5.1 非编辑态：渲染换源，像素不动

- `tabs`（`TabBar.vue:53`）→ `navLayout.items('tabbar')`；`CORE_TABS` 常量删除（进 kernelNav），`AI_TAB` 保留（§2.2 决定 3）。
- 模板、`GlassDockAssembly` 用法、`data-slot`、类名、`aria-label="主导航"`（`:177`）全部不动。新装用户（无 `rein.navLayout.v1`）渲染序列 ≡ 现状 `主页,运动,我`（e2e 断言 `e2e-feature-toggles.mjs:226`）。
- **左钮候选不换源**：`candidates`（`:55-59`）继续消费 `features.nav('rail')`——§3.2 改造后它＝启用的插件贡献目录（成员与今天逐字相同）；`navLayout.candidates()` **不用于此**（§3.3/§3.5 的分界）。效果即解耦目标：用户把「待办」从左栏撤掉后，左钮长按清单里**仍能选到待办**，`rein.dock.v1` 与 rail 布局互不污染。`leftTab` 失效回落（`:61-64`）与 `dock.setLeftRoute`（`dock.ts:43-46`）原样。

### 5.2 编辑态

- **入口：长按药丸页签 480ms**（与左钮 `LONG_PRESS_MS=480` 同值同手感，`TabBar.vue:42`）。实现照左钮的 pressTimer 模式（`:127-138`）：`pointerdown` 起跑、位移超 8px 取消（那是滚动不是长按）、抬手吞掉随后的 click（照 `longPressed` 标记，`:140-148`）。**长按对象区分即共存方案**：长按**左钮** = 换落点 picker（原样保留），长按**药丸页签** = 进编辑态；编辑态内两处长按全部闭闸（`startPress` 加 `activeScope` 门，picker 与气泡都不出）。
  **元素换身死角**：480ms 到点时手指仍按着，非编辑态的 RouterLink 会被编辑态 button 顶替。三件事保证移交不空转：① `pressTimer`/`longPressed` 是 TabBar setup 作用域的变量（`TabBar.vue:84-85`），**不随 DOM 卸载丢失**；② 目标移除后浏览器不会再把 click 派发到旧 RouterLink 上（药丸容器级没有 click 处理，即使落到祖先也无导航语义）——「长按进编辑后松手不跳转」正好是期望行为；③ 兜底：进编辑瞬间挂**一次性 capture click 吞窗**（照 `useBentoLayout.ts:444-456` 的 `armClickSwallow` 同款），把换身窗口期漏网的 click 也吞掉。计时器到点**立即** enter（不等 pointerup），手感与左钮长按一致。
- **编辑面**：
  - 药丸页签照常经 `#tab` 插槽渲染，但编辑态渲染为 `<button class="dock-tab">`（点击不再是导航），非固定项右上角叠「−」徽标（绝对定位小圆，scoped 样式，`aria-hidden`，点击 = `removeFromDraft`）。固定项（主页/我）无徽标、不可拖，是拖拽的边界。
  - **右钮（AI）同账**：它是 RouterLink（`TabBar.vue:220-230`），编辑态 `pointer-events:none`——否则它是 mask 之上唯一没封的路由出口（§4.3 非编辑面清单）。
  - 拖拽：`useNavDrag` 绑在药丸上，`data-nav-id` 放在页签上。
  - **候选托盘 `src/components/mobile/DockEditTray.vue`（新建）**：Dock 上方一条（`bottom: calc(--tabbar-h + --dock-float + --gap-md)`），左列候选 chips（`candidates('tabbar')`，各带「＋」徽标，点击 = `addToDraft`），右端两颗文字钮「放弃变更」「保存布局」（保存用 `--accent` 实底）。这是移动端唯一的候选面——桌面 menu 的对应物。z-index 61（Dock 之上、Toast 之下）。
  - `DockHintBubble`：`maybeShowHint`（`:106-112`）加 `activeScope` 门；编辑态永不弹气泡。
- **退出**：只有托盘的两颗钮（§4.1）。保存 → `apply('tabbar', draft)`；放弃 → 回滚。
- **画质门禁安全**：徽标与托盘只在编辑态存在；`GlassDockAssembly`/`GlassSurface`/base.css 几何零改动（§0）。

---

## 6. 容器二 · 桌面左栏（DesktopRail，rail 区）

### 6.1 「全部菜单」圆钮

- 底部簇加入第五颗 `.ric`：**顺序 = 命令面板 · 信息栏 · 我 · 全部菜单（最底）**。图标 `LayoutGrid`（lucide），`aria-label`/`data-label` 同值「全部菜单」——data-label 自绘悬停标签（`DesktopRail.vue:113-157`）自动生效；42×42 ≥ desktop-audit 的 22px 靶（`scripts/e2e-desktop-audit.mjs:20,44`）。
- 命名不与任何模块 label 冲突（e2e rail 全集断言 `:635-653` 是 includes 型，多出的「全部菜单」不破坏；`:683` 同）。
- **`src/components/layout/RailAllMenu.vue`（新建，rail 区）**：编排组件，面板本体复用 `AppMenu`（bind 模式，Teleport + z114+ + 键盘导航白得）：
  - `anchor` = 全部菜单钮；`open` 由 rail 驱动：`mouseenter`（仅 `@media (hover:hover)`，与 `.ric` 悬停同一前提，`DesktopRail.vue:148,161`）开、AppMenu 既有机制关（catcher 点击 / Esc / 选中 / 滚动，`AppMenu.vue:198-201`）。**不做 hover-out 关闭**——面板 Teleport 到 body（`AppMenu.vue:413`），跨 Teleport 追指针收益低复杂度高；「扫一眼就走」由 catcher 点击兜住。
  - **正常态**：菜单项 = `features.nav('rail')`（启用的**插件**贡献全集；**不是** `navLayout.items('rail')`——被用户撤出左栏的条目不在布局里，按布局取会让菜单漏掉它们，违背「列出所有注册的功能」）。**不含「总览」**：内核条目不经 nav()（§3.2），而 rail 域的标签解析（「总览」≠「主页」）只发生在 navLayout 的 NavEntry（§3.3）——硬塞进来会显示未解析的「主页」；总览已有 logo 恒定兜底（`DesktopRail.vue:32` 的 aria-label「回到总览」），不必进菜单。点击 = `router.push`，被撤掉的模块从这里一键回得去。
  - **编辑态**：菜单项 = `navLayout.candidates('rail')`（仅候选），每项带「＋」徽标，点击 = `addToDraft`；`locked` 常开（§4.5）。
  - 面板标题行 `#panel-actions` 放「编辑」钮：**圆角方框、带 icon**（`Settings2`），44×30 走 `.wbtn` 尺寸档（base.css:143-150，≥22px 靶）。
- 编辑态下面板允许被 mask 旁路点击（locked 不渲染 catcher），rail 条目的「−」才点得动（§4.5 理由）。

### 6.2 编辑态

- **入口**：menu 的「编辑」钮。**编辑面**：
  - `.navs` 条目编辑态渲染为 `<button class="ric">`（点击 = 移除而非导航；RouterLink 的跳转语义在编辑态必须消失），非固定项右上角「−」徽标，`aria-label` 换动作语义「从左栏移除『运动』」（编辑态专属改写不碰 e2e——那些剧本不进编辑态）；正常态 `aria-label`/`data-label` 逐字不动。
  - 「我」/logo/cmd/insp：无徽标、`pointer-events:none`（§4.3）。
  - 拖拽：`useNavDrag` 绑 `.navs`，条目带 `data-nav-id`；自动滚宿主 = `.desk-main`。
  - 「＋」加回的条目追加到草稿末尾，可再拖。
- **退出钮**：编辑态下「编辑」钮原位替换为「放弃变更」「保存布局」两颗（`#panel-actions` 里换内容）——规格原文「只有这两颗能退出编辑态」。
- **mask 范围**：主内容（`.desk-main` / `DesktopInspector`，anyEditing → inert，§4.3 表）被盖；rail z50 > 45 浮出且可交互（它是编辑面）；标题栏 anyEditing 即提权——窗控三钮恒可点，TopbarActions 按钮区不可交互（§4.3/§7.3）；菜单面板 z115 浮出。
- 保存 → `apply('rail', draft)`；放弃 → 回滚。rail 布局变更后左钮候选不受影响（§5.1）。

---

## 7. 容器三 · 桌面顶栏（topbar 区）

### 7.1 贡献面声明（builtin 插件）

对齐 `sports.ts:32` 的 `action: 'add-workout'` 范式——插件文件只加数据：

```ts
// builtin/focus.ts
topbar: [{ id: 'focus.topbar', label: '专注', icon: Timer, action: 'focus-toggle', order: 10 }],
// builtin/record.ts —— 图标与模块 icon 同源（record.ts:1,22 是 AudioLines；Mic 是 voice 的）
topbar: [{ id: 'record.topbar', label: '录音', icon: AudioLines, action: 'record-toggle', order: 20 }],
// builtin/voice.ts —— 同上（voice.ts:1,20 是 Mic）；id 不能复用工具卡的 'voice.session'（voice.ts:28-29），见 §3.1 命名空间
topbar: [{ id: 'voice.topbar', label: '语音', icon: Mic, action: 'voice-session', order: 30 }],
```

v1 种子三颗、全部 `defaultOn`（缺省 true）：三个动作都是「就地一步」类（开始/暂停、开始/停止、唤起会话），不与 rail 的「去页面」重复。后续模块接法：跳转型填 `to`（零宿主代码），就地型加 `TopbarAction` 字面量 + 宿主实现。

### 7.2 宿主 `src/components/layout/TopbarActions.vue`（新建）

```ts
// 宿主持有动作表：与 HomeFooter.vue:79-106 的 ACTIONS/runTool 同一模式
const ACTIONS: Record<TopbarAction, () => void> = {
  'focus-toggle':  /* pomo.active ? 收束本轮 : start()——语义对齐 HomeFooter 的专注格 */,
  'record-toggle': /* recorder.status === 'recording' ? stopRecording() : 起录（system/recorderRuntime） */,
  'voice-session': /* openVoiceView() + 未配置引导（与 HomeFooter ACTIONS['voice-session'] 各自持有，模式代价） */,
}
function run(c: NavEntry): void { if (c.action) ACTIONS[c.action](); else if (c.to) void router.push(c.to) }
```

- 渲染：`navLayout.items('topbar')` 循环出 `<button class="wbtn">`（复用全局窗控钮类，44×30，base.css:143-150）+ 每颗带 `title`/`aria-label`；非固定项（顶栏没有固定件，全非固定）编辑态右上角「−」徽标。
- **拖拽**：`useNavDrag` 绑按钮行。**编辑入口**：按钮区尾部一颗「编辑」`.wbtn`（`SlidersHorizontal`，`aria-label="编辑顶栏按钮"`）；候选下拉 = `AppMenu`（bind，anchor=编辑钮，标题栏在顶部面板向下弹）列 `candidates('topbar')`（「＋」徽标），编辑态 `locked` 常开；编辑态下「编辑」钮原位替换为「放弃变更」「保存布局」两颗（放进按钮区，不下拉）。
- **动作禁用态**：模块关掉 → 该按钮从渲染清单消失（§2.3 过滤），不是置灰——与导航条目同一条纪律。

### 7.3 `AppTitleBar.vue` 挂载与泄漏防线（topbar 区）

- `#left` 插槽、品牌字标之后：`<TopbarActions v-if="isDesktop" />`（`isDesktop` = ≥900 的 `useMediaQuery`，App.vue:40 同款）。
- **三条防线**（对应勘察风险）：
  1. 按钮只出现在 **AppTitleBar 的插槽内容**里。`TitleBarBase.vue` 本体与 base.css 公共段零改动——浮窗 `FloatTitleBar.vue:47-85` 走同一外壳，插槽不共享就绝不泄漏（compact 32 高的浮窗不会长出功能按钮）。
  2. ~~窄 Tauri 窗（430 宽）的 `isDesktop` 宽度门~~ —— 已随「桌面端只允许桌面视图」（2026-11，`deskShell` 平台锁定、`.win-shell--narrow` 退役）一起移除：本组件只在桌面 Tauri 渲染，按钮区无条件挂载，宽度地板由窗口 `minWidth(900)` 保障。
  3. 每颗按钮是真 `<button>` + `@mousedown.stop` + `@dblclick.stop`（照窗控三钮，`AppTitleBar.vue:62-93`）：`isInteractive`（`TitleBarBase.vue:29-34`）据此放行双击/拖拽判定，deep 拖拽区不会把按钮按下当拖动。
- **编辑态 z 提权（绑定与样式都在 App.vue，不在本组件）**：anyEditing 时由 App.vue 对 AppTitleBar 的**用法**挂 `nav-edit-live`，样式写进 App.vue 自己拥有的 `.win-shell--desk` 段（`position:relative; z-index:46`）——**所有 scope 都提权**（rail 编辑时窗控也要可点，§4.3 表）；样式不写进本组件的 scoped，避免与 App.vue:444-448 的窄窗 sticky 规则抢 `position`。TopbarActions 按钮区仅 `activeScope === 'topbar'` 可交互（组件自读 useNavEdit），窗控三钮不受限。
- 浏览器桌面（非 Tauri）不渲染 AppTitleBar（`App.vue:310`）→ 顶栏按钮是 Tauri 桌面专属；rail 与 ⌘K 兜住其余形态。文档写明这条边界。

---

## 8. 存量兼容与 e2e 迁移

### 8.1 `dock.leftRoute`（`rein.dock.v1`）——零迁移

- 存储格式、默认值 `campus-schedule`（`dock.ts:17`）、失效回落（TabBar.vue:61-64）全部不动。
- **调用点零改动**：候选源 `features.nav('rail')` 在 §3.2 改造后就是「rail 插件目录」（启用的插件贡献按 order 排，成员与今天逐字相同）——它**从来没经过用户 rail 布局**，所以「落点偏好与 rail 布局互不污染」是解耦的直接结果，不是行为修正（§3.5 的分界）。`e2e-feature-toggles` 1b 段（长按换落点、`:223-282`，含 `:250-253` 候选断言与 `:493` 的 campus 关闭回落）在非编辑态照旧通过。
- 命令面板「底栏左键」组同样零改动（§3.5），`dock.setLeftRoute` 仍是唯一写入口。

### 8.2 data-label / aria 钩子——逐字保留

| 钩子 | 出处 | 重构后 |
| --- | --- | --- |
| `.dock .dock-tab` 文本序列 | `e2e-feature-toggles.mjs:156,226` | 不变（默认布局 ≡ 现状） |
| `.dock [data-slot=left|ai] .dock-slot` | `GlassDockAssembly.vue:21-23` | 不变（装配层零改动） |
| `.rail .ric` aria-label 全集 | `e2e-feature-toggles.mjs:635-653,683` | 原有 label 全保留；**新增**「全部菜单」一枚（includes 型断言兼容） |
| `nav[aria-label="主导航"]` ×2 | `TabBar.vue:177` / `DesktopRail.vue:29` | 不变 |
| 长按左钮选择器候选含「营养」「待办」 | `e2e-feature-toggles.mjs:250-253` | 不变（候选维持目录源 `features.nav('rail')`，§3.5） |
| `.panel[role=menu] .item` | AppMenu | 不变（只有可选插槽与 locked 新增） |
| `.dock-hint` 三段剧本 | `e2e-feature-toggles.mjs:286-341` | 不变（编辑态只是新增抑制门，非编辑态路径未动） |
| `.bento .b-item[data-bento-id]` / `.prow [role=switch]` | bento / 设置页 | 不动 |

### 8.3 新键的 e2e 纪律

- 预置时机：新布局键如需预置，必须走 `Page.addScriptToEvaluateOnNewDocument`（`scripts/lib/features.mjs:8-10,21-23` 的同款理由：pinia store 启动即读，进页再写无效）。可在 `features.mjs` 旁增 `presetNavLayout(cdp, payload)` helper（core 区）。
- 清场：`e2e-feature-toggles.mjs` 等剧本结尾的 `removeItem` 清单（`:629,719-720`）补 `'rein.navLayout.v1'`，防跨剧本泄漏；dock/rail/topbar 三个新剧本结尾各自清自己的键。
- 编辑态断言靶（新剧本用）：徽标 `data-nav-badge="-|+"`、托盘/面板按钮走文案定位、拖拽走 `data-nav-id`——与 bento 剧本（`[data-bento-id]`）同风格。

### 8.4 既有漂移（本设计不背、也不顺手修出范围）

- `e2e-desktop-shell.mjs:87` 断言 `--page-pad-x === '34px'`，但 `tokens.css:614` 的 `--desk-gutter` 是 40px 且 `App.vue:465` 已映射——**静态核实成立，该剧本基线大概率本来就红**。本设计会话未起 dev server 实跑任何剧本（纯代码核对）；实施门禁前先跑一次确认基线，若确红单独提交修断言（40px），不计入本重构。
- `ARCHITECTURE.md:218`（§8 桌面段）仍写 `DESKTOP_MIN` 1100px，实际 `config/domain.ts:86` = 900——改 §13 的同一 PR 顺手修正这句（文档同步义务，STANDARDS §8）。

---

## 9. 文件分区表（不相交四区）

> 并行施工规则：core 先行（类型 + 目录 + store + 编辑态 + mask + AppMenu 扩展合入后），mobile / rail / topbar 三线才并行；每线只碰自己区的文件。共享物一律先进 core。

| # | owner | path | 动作 | 职责 |
| --- | --- | --- | --- | --- |
| 1 | core | `src/plugins/types.ts` | 改 | `TopbarAction`/`TopbarContribution`/`NavEditScope`、`NavContribution.labels`、`PluginSpec.topbar` |
| 2 | core | `src/plugins/kernelNav.ts` | 新 | 内核条目目录（home/me、fixed、labels） |
| 3 | core | `src/plugins/index.ts` | 改 | 转出 kernelNav 与新类型 |
| 4 | core | `src/stores/features.ts` | 改 | `navCatalog()`/`topbarCatalog()`，`nav()` 改目录派生 |
| 5 | core | `src/stores/navLayout.ts` | 新 | `rein.navLayout.v1`：resolve/candidates/apply |
| 6 | core | `src/composables/useNavEdit.ts` | 新 | 编辑会话单例（草稿/互斥/放弃/保存） |
| 7 | core | `src/composables/useNavDrag.ts` | 新 | 泛化拖拽（源出 useBentoDrag） |
| 8 | core | `src/components/common/NavEditMask.vue` | 新 | 编辑态 mask（z45、`--scrim-edit`） |
| 9 | core | `src/components/common/AppMenu.vue` | 改 | `locked` prop + `#panel-actions` 插槽 |
| 10 | core | `src/App.vue` | 改 | mask 挂载、键盘守卫、壳切换退出编辑、inert/提权绑定（§4.3/§4.4） |
| 11 | core | `src/styles/tokens.css` | 改 | `--scrim-edit` 亮暗双档 |
| 12 | core | `docs/ARCHITECTURE.md` | 改 | §13 扩展点两处→三处 + 布局层；§8 顺手修 1100→900 |
| 13 | core | `scripts/lib/features.mjs` | 改 | `presetNavLayout` 预置 helper |
| 14 | core | `scripts/e2e-feature-toggles.mjs` | 改 | 清场清单补新键；rail 全集断言核对 |
| 15 | mobile | `src/components/layout/TabBar.vue` | 改 | 渲染换源、长按门与共存（含元素换身移交）、编辑态按钮化与「−」徽标、拖拽消费 |
| 16 | mobile | `src/components/mobile/DockEditTray.vue` | 新 | 候选托盘 + 放弃/保存 |
| 17 | mobile | `scripts/e2e-dock-edit.mjs` | 新 | 长按进编辑、±、拖拽、保存/放弃、1b/1c 回归 |
| 18 | rail | `src/components/layout/DesktopRail.vue` | 改 | 渲染换源、全部菜单钮、编辑态「−」/拖拽 |
| 19 | rail | `src/components/layout/RailAllMenu.vue` | 新 | hover 菜单编排（AppMenu 复用、正常态目录源、编辑钮、候选面板） |
| 20 | rail | `scripts/e2e-rail-edit.mjs` | 新 | 菜单/编辑/±/拖拽/保存/放弃/mask |
| 21 | topbar | `src/components/layout/TopbarActions.vue` | 新 | 宿主 ACTIONS 表、按钮区、编辑下拉 |
| 22 | topbar | `src/components/layout/AppTitleBar.vue` | 改 | `#left` 挂 TopbarActions、`isDesktop` 门（z 提权绑定在 App.vue，§7.3） |
| 23 | topbar | `src/plugins/builtin/focus.ts` | 改 | `topbar` 声明 |
| 24 | topbar | `src/plugins/builtin/record.ts` | 改 | `topbar` 声明 |
| 25 | topbar | `src/plugins/builtin/voice.ts` | 改 | `topbar` 声明 |
| 26 | topbar | `scripts/e2e-topbar-actions.mjs` | 新 | 按钮注册/编辑/动作分派/浮窗不泄漏 |

不碰（明确列出的安全区）：`GlassDockAssembly.vue`、`GlassSurface.vue`、`base.css`（dock 几何与 `.wbtn` 定义）、`stores/dock.ts`、`system/dockHint.ts`、`system/deskShell.ts`、`router.ts`、`composables/useBentoLayout.ts`、`plugins/registry.ts`、`plugins/builtin/index.ts`。

---

## 10. 质量门槛与验收

- 闸门（STANDARDS §7）：`npm run lint` / `typecheck` / `build` + `npm run contract`（nav 重构不触 IPC——kernelNav 不进 definePlugin 正是为了网关快照零变化，§0）+ `cd src-tauri && cargo clippy -- -D warnings`（本设计不触 Rust，跑通即可）。
- e2e 回归清单：`e2e-feature-toggles`（页签序列 / rail 全集 / 左钮 1b/1c）、`e2e-desktop-shell`（先确认 §8.4 基线）、`e2e-perf-glass`（标本逐项一致）、`e2e-desktop-audit`（≥22px 靶）、三个新剧本。
- UI 改动附浅/暗截图（STANDARDS §7）：Dock 编辑态、rail 编辑态（menu 常开 + mask）、顶栏按钮区与编辑态各两张。
- 验收判据（对应规格逐条）：① 关掉运动模块 → 三个容器的对应条目消失，`rein.navLayout.v1` 字节数不变；② 药丸序列默认 ≡ `主页,运动,我`；③ 编辑态只有放弃/保存两条退出路径；④ 浮窗标题栏（`FloatTitleBar`）任何形态下无功能按钮；⑤ `rein.dock.v1` 旧数据原样可用（纯重排保存后左钮落点不变）；⑥ rail 任意重排/撤减保存后，左钮长按候选（`e2e-feature-toggles.mjs:250-253`）与 ⌘K 落点清单仍含全部启用模块——dock 偏好域不被布局污染（§3.5）。
