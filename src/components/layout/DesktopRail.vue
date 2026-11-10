<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LayoutGrid, Minus, PanelRight, Search, User } from 'lucide-vue-next'

import RailAllMenu from '@/components/layout/RailAllMenu.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useNavDrag } from '@/composables/useNavDrag'
import { useNavEdit } from '@/composables/useNavEdit'
import type { NavEntry } from '@/stores/navLayout'
import { useNavLayoutStore } from '@/stores/navLayout'
import { MOD } from '@/system/deskShell'

/** 信息栏的开关状态与命令面板入口都由壳层持有，导航轨只负责显示与转发 */
defineProps<{ inspectorOpen: boolean }>()
const emit = defineEmits<{ 'toggle-inspector': []; 'open-palette': [] }>()

/**
 * 桌面三窗格壳 · 左侧导航轨：替代底部 TabBar，提供一级/常用页直达。
 *
 * 渲染换源（docs/nav-redesign.md §3.4/§6）：容器只做渲染，清单全部来自
 * 「注册表 + 用户布局」（stores/navLayout.ts 的 布局 ∩ 目录 ∩ 启用态）——
 * 关掉模块的条目自然消失、失效 id 静默丢弃、存储不动。「总览」是目录里的
 * 固定件（kernelNav，永在首位、不可移除），「我」/logo/命令面板/信息栏是
 * 壳层簇（编辑态里它们是非编辑面：照常可见、pointer-events:none，§4.3/§6.2）。
 */
const navLayout = useNavLayoutStore()
const { editing, draft, removeFromDraft, moveInDraft } = useNavEdit('rail')

/** 渲染清单（正常态）= 布局 ∩ 目录 ∩ 启用态 */
const items = computed(() => navLayout.items('rail'))

/** 编辑态条目视图 = 草稿序。id → 条目解析用全目录（布局 ∪ 候选）：
    草稿里既有布局成员、也有刚「＋」进来的候选，任何单一来源都解析不全。 */
const entryOf = computed(() => {
  const map = new Map<string, NavEntry>()
  for (const e of [...items.value, ...navLayout.candidates('rail')]) map.set(e.id, e)
  return map
})
const draftItems = computed(() =>
  (draft.value ?? []).map((id) => entryOf.value.get(id)).filter((e): e is NavEntry => e !== undefined),
)

/* ---------- 编辑态 · 拖拽调序（useNavDrag，手势与便当同手感） ----------
   整格就是把手：点按 = 撤回、按住拖过 8px slop = 调序，松手吞 click 把两件事分开。
   落点钳制（固定件两侧不可越过）由 useNavEdit.moveInDraft 负责。 */
const navsEl = ref<HTMLElement | null>(null)
const drag = useNavDrag({
  listEl: navsEl,
  orderIds: () => draft.value ?? [],
  move: moveInDraft,
  snapshot: () => draft.value?.slice() ?? [],
  restore: (ids) => {
    if (draft.value) draft.value = ids
  },
})

function onItemPointerDown(e: PointerEvent, it: NavEntry): void {
  if (!it.fixed) drag.onHandleDown(e, it.id)
}

/* ---------- 壳层簇的编辑态门（§4.3 非编辑面） ----------
   pointer-events:none 挡指针，键盘 Enter 与读屏路径用 aria-disabled + tabindex=-1 +
   点击守卫兜住 —— 编辑态里路由出口必须全部封死，草稿才不会悬空。 */
const router = useRouter()
const route = useRoute()

function onLogo(): void {
  if (editing.value) return
  void router.push({ name: 'home' })
}
function onCmd(): void {
  if (editing.value) return
  emit('open-palette')
}
function onInsp(): void {
  if (editing.value) return
  emit('toggle-inspector')
}
/** 编辑态条目点击 = 撤回（导航语义必须消失）；固定件由 removeFromDraft 拒绝，点不出事 */
function onEditItemClick(it: NavEntry): void {
  removeFromDraft(it.id)
}

/* ---------- 「全部菜单」钮（§6.1）：悬浮面板的锚，面板本体在 RailAllMenu ----------
   hover 开（仅 hover:hover 设备，与 .ric 悬停标签同一前提）；关闭走 AppMenu 既有机制。 */
const hoverOK = useMediaQuery('(hover: hover)')
const allMenuOpen = ref(false)
const allBtnEl = ref<HTMLElement | null>(null)
function onAllHover(): void {
  if (!hoverOK.value || editing.value) return
  allMenuOpen.value = true
}
function onAllClick(): void {
  if (editing.value) return // 编辑态菜单常开（locked 面板），锚钮不是出口
  allMenuOpen.value = true
}
</script>

<template>
  <nav class="rail glass-surface glass-edge-r" aria-label="主导航">
    <!-- 无障碍名与悬停标签同值「回到总览」：读屏 / 语音控制用户按看到的名字找这颗钮
         （WCAG 2.5.3 Label in Name）。与「总览」导航空格在文案上已经区分开 -->
    <button
      class="logo"
      :class="{ gated: editing }"
      aria-label="回到总览"
      data-label="回到总览"
      :aria-disabled="editing || undefined"
      :tabindex="editing ? -1 : undefined"
      @click="onLogo"
    />
    <div ref="navsEl" class="navs col" :class="{ editing }">
      <!-- 正常态：路由直达。aria-label / data-label 逐字保持（e2e 锚点） -->
      <template v-if="!editing">
        <RouterLink
          v-for="it in items"
          :key="it.id"
          :to="{ name: it.id }"
          class="ric"
          :class="{ on: route.name === it.id }"
          :data-nav-id="it.id"
          :aria-label="it.label"
          :data-label="it.label"
        >
          <component :is="it.icon" :size="21" :stroke-width="route.name === it.id ? 2.2 : 1.9" />
        </RouterLink>
      </template>
      <!-- 编辑态：条目换成 button（点击 = 撤回，跳转语义必须消失）；非固定项右上角叠
           「−」徽标（aria-hidden 的装饰，点击落在整格上）；aria-label 换动作语义
           「从左栏移除『…』」—— 编辑态专属改写不碰 e2e（那些剧本不进编辑态）。
           固定件（总览）不可撤也不可拖，aria 保持条目名并注明，不用动作语义骗读屏用户
           （removeFromDraft 对 fixed 直接拒绝，报一个永远执行不了的动作是假提示） -->
      <template v-else>
        <button
          v-for="it in draftItems"
          :key="it.id"
          type="button"
          class="ric"
          :class="{ on: route.name === it.id, dragging: drag.dragId.value === it.id }"
          :data-nav-id="it.id"
          :data-label="it.label"
          :aria-label="it.fixed ? `${it.label}（固定，不可移除）` : `从左栏移除『${it.label}』`"
          @click="onEditItemClick(it)"
          @pointerdown="onItemPointerDown($event, it)"
        >
          <component :is="it.icon" :size="21" :stroke-width="2" />
          <span v-if="!it.fixed" class="ric-badge" data-nav-badge="-" aria-hidden="true">
            <Minus :size="12" :stroke-width="2.6" />
          </span>
        </button>
      </template>
    </div>
    <!-- 底部簇（§6.1 顺序 = 命令面板 · 信息栏 · 我 · 全部菜单最底）：
         命令面板是桌面的主入口（三十多个页面不该靠鼠标一个个翻），把入口钉在导航轨上，
         用户至少有一次机会看见它 —— 快捷键只有被看见才存在。 -->
    <button
      class="ric cmd"
      :class="{ gated: editing }"
      aria-label="命令面板"
      :data-label="'命令面板 ' + MOD + 'K'"
      :tabindex="editing ? -1 : undefined"
      :aria-disabled="editing || undefined"
      @click="onCmd"
    >
      <Search :size="20" :stroke-width="2" />
    </button>
    <button
      class="ric insp"
      :class="{ on: inspectorOpen, gated: editing }"
      :aria-pressed="inspectorOpen"
      :aria-disabled="editing || undefined"
      aria-label="显示或隐藏信息栏"
      :data-label="'信息栏 ' + MOD + 'I'"
      :tabindex="editing ? -1 : undefined"
      @click="onInsp"
    >
      <PanelRight :size="20" :stroke-width="2" />
    </button>
    <!-- 「关于你」：正常态 RouterLink；编辑态换成 dead button（无点击处理）—— RouterLink 的
         跳转语义在编辑态必须消失，与 .navs 条目的按钮化同一条理由（§6.2/§4.3） -->
    <RouterLink
      v-if="!editing"
      :to="{ name: 'me' }"
      class="ric me"
      :class="{ on: route.name === 'me' }"
      aria-label="关于你"
      data-label="关于你"
    >
      <User :size="21" :stroke-width="route.name === 'me' ? 2.2 : 1.9" />
    </RouterLink>
    <button v-else type="button" class="ric me gated" aria-label="关于你" data-label="关于你" aria-disabled="true" tabindex="-1">
      <User :size="21" :stroke-width="2" />
    </button>
    <!-- 全部菜单：列出所有注册功能的悬浮入口（RailAllMenu），也是编辑态的入口与出口 -->
    <button
      ref="allBtnEl"
      class="ric all"
      aria-label="全部菜单"
      data-label="全部菜单"
      aria-haspopup="menu"
      :aria-expanded="allMenuOpen ? 'true' : 'false'"
      @mouseenter="onAllHover"
      @click="onAllClick"
    >
      <LayoutGrid :size="20" :stroke-width="2" />
    </button>
    <RailAllMenu :anchor="allBtnEl" :open="allMenuOpen" @update:open="allMenuOpen = $event" />
  </nav>
</template>

<style scoped>
/* 材质走全局那一份 .glass-surface（受光边 + 内顶高光 + 投影 + 超高的光学层），
   这里只给几何。原先是一份手写的 --surface-translucent + blur(20px)：与其余玻璃
   各写一套的代价是**档位升级要改两遍**，而超高档正是靠改令牌整套升级的。
   glass-edge-r：只保留靠内那一条描边 —— 左边贴着屏幕边缘，画框就是在边上多一条亮线。 */
.rail {
  width: 64px;
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 上下内距取同一档 20（原来 18/20 不对称）；整列间距 8（--gap-sm）——
     图标轨里每一格之间是「无边界的一组」，此前下方三格（命令面板 / 信息栏 / 我）
     完全没有间距，挤成一条竖带 */
  padding: var(--sp-20) 0;
  gap: var(--gap-sm);
  z-index: 50;
}

.logo {
  width: 26px;
  height: 26px;
  flex: none;
  /* 品牌标与导航簇分开 12（加上 .rail 的 gap 8 共 20，原来是一条 22 的裸边距） */
  margin-bottom: var(--sp-12);
  border-radius: var(--radius-xs);
  background: conic-gradient(from 210deg, var(--c-intake), var(--c-exercise), var(--c-balance), var(--c-intake));
}

.navs {
  gap: var(--gap-sm);
}

/* 编辑态的拖拽面前置 touch-action:none（docs/nav-redesign.md §4.2）：base.css 给文档
   滚动层的全局手势是 pan-x pan-y，不前置这条，安卓上指针事件会被滚动链接管成
   pointercancel，拖拽永不触发。**只在编辑态挂** —— 非编辑态不碰手势链，滚动照旧。 */
.navs.editing {
  touch-action: none;
}

/* 图标轨的可读性问题：64px 里只放得下图标，而「课表 / 记账 / 健康方案」这几个
   单看图形是猜不出来的。这里给每一格补一条**自绘的悬停标签**（真机上的原生
   title 要等一秒、样式不受控），它是绝对定位的 —— 不占布局、不推挤内容，
   这正是图标轨该有的做法（VS Code 的活动栏同一套）。
   文字走 data-label 而不是 title：title 会同时弹一个原生提示，两个叠在一起。 */
.ric {
  position: relative;
  width: 42px;
  height: 42px;
  border-radius: var(--radius-m);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  text-decoration: none;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}

.ric::after {
  content: attr(data-label);
  position: absolute;
  left: calc(100% + var(--sp-12));
  top: 50%;
  translate: 0 -50%;
  /* 悬停标签：4×10 内距（吸附自 5 上下），是真标签的尺寸而不是按钮 */
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-1) 88%, transparent);
  color: var(--bg);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 只给有指针的设备：触屏上悬停会粘住，标签会一直挂在那儿 */
@media (hover: hover) {
  .ric:hover::after {
    opacity: 1;
  }
}

/* 键盘走到这一格也要能看到名字：焦点环说明「在哪」，标签说明「是什么」 */
.ric:focus-visible::after {
  opacity: 1;
}

/* 悬停只给有指针的设备：触屏浏览器的 :hover 会在点过之后粘住不散，
   而窄屏根本不会渲染这条导航轨 —— 这两条加在一起才敢无条件写 hover。 */
@media (hover: hover) {
  .ric:hover {
    color: var(--text-1);
    background: color-mix(in srgb, var(--text-1) 6%, transparent);
  }

  .ric.on:hover {
    background: var(--accent-soft);
  }
}

.ric.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 编辑态 · 正被拖的条目：与选中态同一档的 accent 底 —— 「手里这格」要有落点之外的读感，
   但不做位移/浮起：live reorder 靠的是别的格子让位，被拖项原地不动（useNavDrag 注） */
.ric.dragging {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 编辑态 · 「−」徽标：绝对定位的小圆，压在格子的右上角外缘。
   它是 aria-hidden 的装饰 —— 撤回动作落在整格上（aria-label 已换成动作语义），
   pointer-events:none 让点击穿透到按钮；描一圈面板底色把它从图标上剥出来。 */
.ric-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--danger-soft);
  color: var(--danger-strong);
  box-shadow: 0 0 0 2px var(--surface);
  pointer-events: none;
}

/* 编辑态 · 壳层簇的非编辑面（logo/cmd/insp/me）：照常可见，只封指针 ——
   mask 已经把页面压下去了，容器内再灰一层会读成「坏了」（§4.3）。 */
.gated {
  pointer-events: none;
}

/* 两颗开关贴着导航轨底部、排在「我」之上：容量类的开关属于壳层，
   与页面导航分成两簇 —— 自动外边距把它们推到底部，.me / .all 是最后两项。 */
.cmd {
  margin-top: auto;
}

/* 信息栏收起后这颗钮保持「关」的读数：只有描边色差，不做位移 ——
   开关状态不该让导航轨的节奏跳一下。 */
.insp {
  /* 信息栏钮与下面的「我」之间再挪 2：与上面 .rail 的 gap 8 一起，
     把「壳层开关」和「页面导航」分成两簇 */
  margin-bottom: var(--sp-2);
}

.insp.on {
  color: var(--accent);
}

.me {
  margin-top: 0;
}
</style>
