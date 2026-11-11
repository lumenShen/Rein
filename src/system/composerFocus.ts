import { computed, ref } from 'vue'

/**
 * 全局输入条的「正在被使用」状态（system 层单例）。
 *
 * 底栏据此在输入时收起页签行：一块玻璃只剩输入行，键盘上方的可用高度回到输入本身。
 * 为什么不是组件内部状态：AI 页的 ComposerBar 挂在 AIPage 里、其余页的挂在 TabBar 里，
 * 两个实例在不同的组件树上，而底栏需要的是**同一份事实** —— 无论用户在哪个页面
 * 聚焦输入框，页签行都该让位。
 *
 * 用 token 集合而不是一个 boolean：路由切换的那一帧两个输入条可能同时在 DOM 里，
 * 离场那个的 blur / 卸载不能把在场那个的聚焦态一起抹掉。
 */
const holders = new Set<number>()
let seq = 0

/** 是否有输入条正握着键盘焦点 */
export const composerFocused = ref(false)

/**
 * 「+」菜单打开期间同样保持收起：菜单绑在 + 钮上，页签行一展开，锚点整块上移，
 * 菜单就会悬在空处。它不是输入焦点，但共享同一个布局结果，所以并进同一个判定。
 */
export const composerMenuOpen = ref(false)

/** 底栏是否该按「只剩输入行」的形态渲染 */
export const composerEngaged = computed(() => composerFocused.value || composerMenuOpen.value)

/** 每个 ComposerBar 实例一枚 token（聚焦集合的键） */
export function createComposerFocusToken(): number {
  return ++seq
}

export function setComposerFocus(token: number, on: boolean): void {
  if (on) holders.add(token)
  else holders.delete(token)
  composerFocused.value = holders.size > 0
}
