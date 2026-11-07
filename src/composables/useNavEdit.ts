import { computed, ref, type ComputedRef, type Ref } from 'vue'

import type { NavEditScope } from '@/plugins'
import { useNavLayoutStore } from '@/stores/navLayout'

/* ============================================================
   导航编辑会话（Dock / 左栏 / 顶栏三容器共用的共享层）
   ------------------------------------------------------------
   落点风格照 system/deskShell.ts：跨组件共享的状态用模块级单例，
   不进 App 二传手。三个容器各自的「进入编辑 / ±徽标 / 拖拽 / 放弃 / 保存」
   全部走这一个会话，不复制三份 —— 谁在编辑、草稿是什么、怎么退出，
   全局只有一份事实。

   不变量（三容器共用同一份措辞，容器侧不得另立规则）：
   - **同一时刻至多一个容器在编辑态**（activeScope 单例保证；第二个 enter() 是 no-op）。
   - **退出编辑态只有两条路：放弃变更 / 保存布局**。mask 点击不退出（规格原文）；
     Esc 只取消进行中的拖拽（沿用 useBentoDrag 的语义，见 useNavDrag.ts），不退出会话。
   - **草稿只在内存**：从未落盘，所以「放弃变更」天然是回滚（丢弃即回滚）；
     组件卸载（桌面 ↔ 移动壳切换、沉浸页）由 App.vue 统一 discard() ——
     半成品永远到不了 localStorage。
   ============================================================ */

/** 全局活动编辑态（null = 无）。mask 显隐、App.vue 键盘守卫、跨容器互斥都读它 */
const activeScope = ref<NavEditScope | null>(null)
/** 草稿（有序 id，null = 不在编辑态）。容器编辑态视图以草稿为准渲染 */
const draft = ref<string[] | null>(null)

/**
 * 导航编辑会话句柄。
 *
 * - 传 `scope`：容器侧句柄 —— 编辑面的渲染与 ±/拖拽/保存/放弃（TabBar / DesktopRail /
 *   TopbarActions 用这个）。
 * - 不传：壳层侧句柄 —— App.vue 读全局 activeScope 做守卫与 inert 账，
 *   在壳层翻转 / 沉浸页切入时统一 discard()。
 */
export function useNavEdit(scope?: NavEditScope): {
  /** 本容器是否处于编辑态（壳层句柄恒 false —— 壳层自己不是编辑面） */
  editing: ComputedRef<boolean>
  /** 全局活动编辑态（null = 无） */
  activeScope: ComputedRef<NavEditScope | null>
  draft: Ref<string[] | null>
  /** 进入：对 items(scope) 取 id 快照作为草稿。已有其他容器在编辑时为 no-op（互斥） */
  enter: () => void
  /** 「+」：候选加回草稿，插在可移动区末尾（不越过尾部固定件，随后可拖） */
  addToDraft: (id: string) => void
  /** 「-」：从草稿摘除（回到候选） */
  removeFromDraft: (id: string) => void
  /** 拖拽换位：插入位钳制在固定件之间的可移动区间内 */
  moveInDraft: (id: string, to: number) => void
  /** 放弃变更：草稿从未落盘，丢弃即回滚到进入编辑态前的布局 */
  discard: () => void
  /** 保存布局：navLayout.apply(scope, draft) 并退出 */
  save: () => void
} {
  const editing = computed(() => scope !== undefined && activeScope.value === scope && draft.value !== null)
  const activeScopeRO = computed(() => activeScope.value)

  /** 固定件 id 集合（本容器的目录里声明为 fixed 的条目） */
  function fixedIds(): Set<string> {
    return new Set(useNavLayoutStore().items(scope!).filter((it) => it.fixed).map((it) => it.id))
  }

  /**
   * 草稿头尾各有多少连续的固定件：它们是拖拽与「+」的边界。
   * 固定件占着头（主页/总览）与尾（「我」），可移动区夹在中间 ——
   * 新加的条目不能越过尾部固定件，拖拽的落点也不能落进固定件的两侧。
   *
   * 头/尾的划分沿 navLayout.resolveIds 的同一条约定：**声明序第一枚固定件排最前，
   * 其余殿后**。只看「是不是 fixed」的集合在可移动区为空时分不出头尾（Dock 摘掉唯一
   * 可移动项后草稿是 [主页, 我]，两枚都 fixed）——从中间同时往两头数，头游标会越过
   * 「我」、尾游标会越过「主页」，「＋」的插入位就落到固定件外侧去了。必须按这份
   * 划分各数各的：「＋」取 end（尾部固定件之前），拖拽钳在 [start, end-1]。
   */
  function movableBounds(ids: string[]): { start: number; end: number } {
    const fixedInOrder = useNavLayoutStore().items(scope!).filter((it) => it.fixed).map((it) => it.id)
    const headId = fixedInOrder[0]
    const tail = new Set(fixedInOrder.slice(1))
    const start = headId !== undefined && ids[0] === headId ? 1 : 0
    let end = ids.length
    while (end > start && tail.has(ids[end - 1]!)) end -= 1
    return { start, end }
  }

  function enter(): void {
    if (scope === undefined) return
    // 互斥：同一时刻至多一个容器在编辑态，第二个 enter() 直接忽略
    if (activeScope.value !== null) return
    draft.value = useNavLayoutStore().items(scope).map((it) => it.id)
    activeScope.value = scope
  }

  function addToDraft(id: string): void {
    if (scope === undefined || activeScope.value !== scope || !draft.value) return
    if (fixedIds().has(id) || draft.value.includes(id)) return
    const next = draft.value.slice()
    next.splice(movableBounds(next).end, 0, id)
    draft.value = next
  }

  function removeFromDraft(id: string): void {
    if (scope === undefined || activeScope.value !== scope || !draft.value) return
    if (fixedIds().has(id)) return
    draft.value = draft.value.filter((x) => x !== id)
  }

  function moveInDraft(id: string, to: number): void {
    if (scope === undefined || activeScope.value !== scope || !draft.value) return
    if (fixedIds().has(id)) return
    const from = draft.value.indexOf(id)
    if (from < 0) return
    const others = draft.value.filter((x) => x !== id)
    const { start, end } = movableBounds(draft.value)
    // 插入位钳制在可移动区间（others 里被拖项已摘除，可移动区长度少 1）
    const at = Math.max(start, Math.min(end - 1, Math.round(to)))
    const next = others.slice()
    next.splice(at, 0, id)
    draft.value = next
  }

  /** 放弃变更：清掉草稿退出即可 —— 草稿从未落盘，存储从未被写 */
  function discard(): void {
    // 壳层句柄（无 scope）无条件退：App.vue 在壳翻转 / 沉浸页切入时统一收场；
    // 容器句柄只收自己的会话，别误伤别的容器的编辑态
    if (scope !== undefined && activeScope.value !== scope) return
    draft.value = null
    activeScope.value = null
  }

  function save(): void {
    if (scope === undefined || activeScope.value !== scope || !draft.value) return
    useNavLayoutStore().apply(scope, draft.value)
    discard()
  }

  return { editing, activeScope: activeScopeRO, draft, enter, addToDraft, removeFromDraft, moveInDraft, discard, save }
}

export type { NavEditScope }
