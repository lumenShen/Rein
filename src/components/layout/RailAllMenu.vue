<script setup lang="ts">
import { computed, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Settings2 } from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import { useNavEdit } from '@/composables/useNavEdit'
import { useFeaturesStore } from '@/stores/features'
import { useNavLayoutStore } from '@/stores/navLayout'

/**
 * 左栏「全部菜单」悬浮面板（docs/nav-redesign.md §6.1）：面板本体复用 AppMenu
 * （bind 模式 —— Teleport + z114+ + 键盘导航白得），本组件只做编排：
 * 开合、两个内容源、编辑入口与出口。锚钮（.ric all）由 DesktopRail 渲染，
 * 这里只收锚元素与开合状态。
 *
 * 开合：open 由导航轨驱动（锚钮 mouseenter / click），关闭走 AppMenu 既有机制
 * （catcher 点击 / Esc / 选中 / 滚动）；**不做 hover-out 关闭** —— 面板 Teleport 到
 * body，跨 Teleport 追指针收益低复杂度高，「扫一眼就走」由 catcher 点击兜住。
 *
 * 两个内容源：
 * - 正常态 = features.nav('rail')（启用的**插件**贡献全集 —— **不是** navLayout.items('rail')：
 *   被用户撤出左栏的条目不在布局里，按布局取会让菜单漏掉它们，违背「列出所有注册的功能」。
 *   也不含内核条目：「总览」有 logo 恒定兜底（DesktopRail 的 aria「回到总览」），不经 nav() 进来）。
 *   点击 = 路由直达 —— 被撤掉的模块从这里一键回得去。
 * - 编辑态 = 会话内的候选，每项「＋」，点击 = addToDraft；locked 常开（AppMenu 四条关闭
 *   路径全部旁路 —— 点「＋」不能把面板关掉，rail 条目的「−」也要点得动：locked 不渲染
 *   catcher，mask 之下的编辑面不背吃点击的锅）。
 *
 * 候选**草稿感知**（已启用目录 − 草稿，不只是 navLayout.candidates 的「目录 − 已存布局」）：
 * 规格里「−」的语义是「撤回到 menu」—— 会话中撤掉的条目要立刻回到面板、可再加回；
 * 会话开始时草稿 ≡ 已存布局，两种读法同值，分歧只发生在会话中（那时只有草稿读法是对的）。
 *
 * ⚠️ 面板内容一变就要「重开一拍」（bumpMenu）：AppMenu 的 levels 快照与定位测量都只在
 * open 翻转时做（watch(open) + layout()），open 不翻转时换数组面板不更新、量好一次的
 * top 也不再算 —— 候选增减后面板高度变了，旧的 top 会把面板悬在半空挡住 rail 的「−」
 * （e2e 探针实测：elementFromPoint 落在面板标题行上，拖拽抓不到条目）。这一拍**不是
 * 关闭路径**：会话不动、mask 不动，面板下一帧按新内容重建并重新贴锚 —— 规格里
 * 「＋不关面板」的意图（编辑流不断）保住了，只是内容切换必须走 AppMenu 的重建机制。
 */
const props = defineProps<{ anchor: HTMLElement | null; open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const router = useRouter()
const features = useFeaturesStore()
const navLayout = useNavLayoutStore()
const { editing, draft, enter, addToDraft, discard, save } = useNavEdit('rail')

/** 面板条目：正常态目录 / 编辑态候选（草稿感知） */
const menuActions = computed<MenuItem[]>(() => {
  if (!editing.value) {
    return features.nav('rail').map((n) => ({ label: n.label, value: n.route, icon: n.icon }))
  }
  const inDraft = new Set(draft.value ?? [])
  const seen = new Set<string>()
  const out: MenuItem[] = []
  // 候选起点 = navLayout.candidates（目录 − 已存布局）；再并入布局里的非固定件 ——
  // 会话中被「−」掉的条目还在已存布局里，candidates 不含它们，从这里补。
  // 「＋」走 MenuItem.badge 徽标位（§6.1/§8.3 的 data-nav-badge 靶），文案保持纯标签
  for (const e of [...navLayout.candidates('rail'), ...navLayout.items('rail')]) {
    if (e.fixed || inDraft.has(e.id) || seen.has(e.id)) continue
    seen.add(e.id)
    out.push({ label: e.label, value: e.id, icon: e.icon, badge: '+' })
  }
  return out
})

/** 面板重开一拍（头注释 ⚠️ 段）：关一 tick 再开，levels 与定位按新内容重建 */
async function bumpMenu(): Promise<void> {
  emit('update:open', false)
  await nextTick()
  emit('update:open', true)
}

// 编辑态的每次草稿变化（进入 / ＋ / rail 侧「−」）都触发重开一拍；
// 会话结束（editing 翻回 false）不重开 —— 下面那条 watcher 收场
watch([editing, draft], () => {
  if (editing.value && props.open) void bumpMenu()
})

/** 会话结束（保存 / 放弃 / 壳层收场）→ 收起面板 —— 编辑态的出口只有两颗钮，
    面板不收走的话「退出」无从谈起 */
watch(editing, (on) => {
  if (!on) emit('update:open', false)
})

/** 菜单项统一回调：正常态 = 路由直达（被撤掉的模块从这里一键回得去）；
    编辑态 = 加回草稿（追加到可移动区末尾，随后可拖） */
function onSelect(value: string): void {
  if (editing.value) addToDraft(value)
  else void router.push({ name: value })
}

/** 进入编辑态（面板右上角的「编辑」钮）。互斥由 useNavEdit 保证：
    别的容器在编辑时 no-op；editing 翻转 → 上面 watcher 重开一拍换候选 */
function startEdit(): void {
  if (editing.value) return
  enter()
}
</script>

<template>
  <AppMenu
    :open="open"
    :anchor="anchor"
    :actions="menuActions"
    :title="editing ? '添加到左栏' : '全部功能'"
    :locked="editing"
    @close="emit('update:open', false)"
    @select="onSelect"
  >
    <template #panel-actions>
      <!-- 正常态：编辑入口 —— 圆角方框 + icon，走 .wbtn 尺寸档（44×30，≥22px 靶） -->
      <button v-if="!editing" type="button" class="wbtn" aria-label="编辑左栏" title="编辑左栏" @click="startEdit">
        <Settings2 :size="16" :stroke-width="2" />
      </button>
      <!-- 编辑态：「编辑」原位替换为两颗退出钮（规格：只有这两颗能退出编辑态）。
           走插槽内容渲染在 AppMenu 的标题行右缘 —— 样式随本组件的 scoped 作用域
           （插槽内容带父组件 scope id，Teleport 不影响）。 -->
      <div v-else class="exit-row">
        <button type="button" class="pact" @click="discard">放弃变更</button>
        <button type="button" class="pact save" @click="save">保存布局</button>
      </div>
    </template>
  </AppMenu>
</template>

<style scoped>
/* 两颗退出钮并排；高度走 .wbtn 同档 30，宽度随文字（四字钮 44 装不下）——
   ≥22px 的可点靶由高度兜住 */
.exit-row {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
}

.pact {
  height: 30px;
  padding: 0 var(--sp-10);
  border-radius: var(--radius-m);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

/* 悬停只给精确指针：触屏上 :hover 会粘住（base.css 桌面悬停那一段同一条理由） */
@media (hover: hover) {
  .pact:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }
}

/* 按压反馈：缩放而不是换色（.wbtn 同一套，两颗并排不留「刚点过哪颗」的残影） */
.pact:active {
  transform: scale(0.96);
}

/* 保存用 --accent 实底（与移动端 Dock 托盘的保存钮同一配色语义）：
   悬停保持实底 —— 上面的通用 hover 换底规则对主操作钮不适用 */
.pact.save {
  background: var(--accent);
  color: var(--on-accent);
}

@media (hover: hover) {
  .pact.save:hover {
    background: var(--accent);
    color: var(--on-accent);
  }
}
</style>
