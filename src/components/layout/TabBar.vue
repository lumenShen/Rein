<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { House, Sparkles, User } from 'lucide-vue-next'

import AppMenu from '@/components/common/AppMenu.vue'
import DockHintBubble from '@/components/common/DockHintBubble.vue'
import GlassDockAssembly from '@/components/common/GlassDockAssembly.vue'
import { useDockStore } from '@/stores/dock'
import { useFeaturesStore } from '@/stores/features'
import { dockHintDismissed, dismissDockHint, dockHintShownToday, markDockHintShown } from '@/system/dockHint'
import { motionRich } from '@/system/motion'
import { usePressGlow } from '@/composables/usePressGlow'
import type { NavContribution } from '@/plugins'

/**
 * 底部悬浮 Dock：三块并列的玻璃，装配与画质预览页的标本台同款（圆 + 药丸 + 圆）。
 *
 *   左 · 独立圆钮：**用户自定义落点**（默认课表，长按换一个模块主页面）
 *   中 · 药丸：内核两格（主页 / 我）与插件条目（运动…）按 order 排在一起
 *   右 · 独立圆钮：AI —— 内核功能（不可关），与主页/我 一样由 Dock 自己声明
 *
 * 材质一律走 GlassSurface（与标本同一个组件、同一组默认参数）：超高档三块各自折射
 * 背后的**页面真实内容**，其余档位退化成普通毛玻璃；弱档由 base.css 全局关掉 blur、
 * 把玻璃顶成实底。三块**并列留缝、互不叠压** —— 各自都带受光边，一叠就会在缝上
 * 出现一道月牙形硬边（与标本台同一条结论）。折射的底**直接用 --glass-fill**
 * （与其余档位、其余玻璃同色）：底再薄一点，页签文字的真图对比度就会掉下去
 * （真图采像素，见 scripts/e2e-perf-glass.mjs 第 6 节）。
 *
 * 柔性反馈沿用老 Dock：按下一拍快速挤压（volume-preserving squash），松手沿弹簧
 * 曲线回弹过冲，一段过渡自然带出「压扁 → 拉长 → 回正」，不需要 JS。
 */
const CORE_TABS: NavContribution[] = [
  { route: 'home', label: '主页', icon: House, surfaces: ['tabbar'], order: 0 },
  { route: 'me', label: '我', icon: User, surfaces: ['tabbar'], order: 990 },
]

/** 右独立圆钮的落点：AI */
const AI_TAB: NavContribution = { route: 'ai', label: 'AI', icon: Sparkles, surfaces: ['tabbar'], order: 0 }

/** 长按判定：按住这么久就开选择器（松手不跳转） */
const LONG_PRESS_MS = 480

/** 左钮引导气泡最长驻留：到点自动收起 */
const HINT_MS = 20000

const features = useFeaturesStore()
const dock = useDockStore()
const route = useRoute()
const router = useRouter()

/** 药丸页签：内核两格 + 插件条目，按 order 排（关掉「运动」模块，这一格就消失） */
const tabs = computed(() => [...CORE_TABS, ...features.nav('tabbar')].sort((a, b) => a.order - b.order))

/** 左钮候选：导航轨里的模块主页面（已按插件开关过滤），去掉 Dock 里已有的落点 */
const candidates = computed(() => {
  const taken = new Set([...tabs.value.map((t) => t.route), AI_TAB.route])
  return features.nav('rail').filter((n) => !taken.has(n.route))
})

/** 左钮落点：存量落点失效（模块被关）时回落到候选第一项；一个候选都没有就整块不画 */
const leftTab = computed(
  () => candidates.value.find((c) => c.route === dock.leftRoute) ?? candidates.value[0] ?? null,
)

/** 药丸里当前选中的那一格（-1 = 这一页不在 Dock 上，此时不画任何活动底） */
const tabIndex = computed(() => tabs.value.findIndex((t) => route.name === t.route))

/**
 * 液态活动底（丰富档）：挂上之后原来那层纯色活动底让位（见 base.css 的 .goo 规则）。
 * 用 `v-if="goo"` 而不是让 thumb 自己判断 —— 没有选中项时（比如停在二级页）
 * 两块实现都不该画，这个条件只此一处。
 */
const goo = computed(() => motionRich.value && tabIndex.value >= 0)

/** 按压定向光晕（丰富档）：一份监听挂在整个 Dock 上，按 selector 就近点亮被按的那一格 */
const dockEl = ref<HTMLElement | null>(null)
usePressGlow(dockEl, '.dock-tab, .dock-slot')

/* ---------- 左钮：短按直达 / 长按换落点 ---------- */
const pickerOpen = ref(false)
/** 菜单锚点：被长按的那颗左钮 —— bind 菜单从它旁边弹出（Dock 贴底，AppMenu 会自动翻到上方） */
const pickerAnchor = ref<HTMLElement | null>(null)
let pressTimer: ReturnType<typeof setTimeout> | null = null
let longPressed = false

/* ---------- 左钮引导气泡：每天一次 / 最长 20s ---------- */
const hintOpen = ref(false)
/** 气泡锚点：底栏左钮（模板 ref）。气泡从它右上角弹出 */
const leftBtnEl = ref<HTMLElement | null>(null)
let hintTimer: ReturnType<typeof setTimeout> | null = null

function clearHintTimer(): void {
  if (hintTimer) {
    clearTimeout(hintTimer)
    hintTimer = null
  }
}

function closeHint(): void {
  hintOpen.value = false
  clearHintTimer()
}

/** 点按左钮时考虑弹出：已「不再提醒」或今天已提示过则不动 */
function maybeShowHint(): void {
  if (dockHintDismissed.value || dockHintShownToday()) return
  markDockHintShown() // 弹出即计入当天：20s 自动收起也算提示过，当天不再打扰
  hintOpen.value = true
  clearHintTimer()
  hintTimer = setTimeout(closeHint, HINT_MS)
}

/** 「不再提醒」：永久关闭 + 收起 */
function dismissHint(): void {
  dismissDockHint()
  closeHint()
}

function cancelPress(): void {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

function startPress(e: PointerEvent): void {
  longPressed = false
  // 锚点就取被按住的那颗左钮：长按开了菜单之后，菜单要贴着它出现
  pickerAnchor.value = e.currentTarget as HTMLElement
  cancelPress()
  pressTimer = setTimeout(() => {
    pressTimer = null
    longPressed = true
    pickerOpen.value = true
    closeHint() // 用户已经在长按自定义了：气泡的使命完成，先收起
  }, LONG_PRESS_MS)
}

function onLeftClick(e: MouseEvent): void {
  // 长按已经开过选择器：这次抬手不该再当成一次跳转
  if (longPressed) {
    e.preventDefault()
    return
  }
  maybeShowHint()
  if (leftTab.value) void router.push({ name: leftTab.value.route })
}

function closePicker(): void {
  pickerOpen.value = false
  longPressed = false
}

/** 候选带上各自的模块图标：bind 菜单是「图标 + 文字」版，扫一眼就知道是哪个模块 */
const pickerActions = computed(() =>
  candidates.value.map((c) => ({ label: c.label, value: c.route, icon: c.icon })),
)

const dockItems = computed(() =>
  tabs.value.map((item) => ({ id: item.route, label: item.label, icon: item.icon })),
)
const leftItem = computed(() =>
  leftTab.value
    ? { id: leftTab.value.route, label: leftTab.value.label, icon: leftTab.value.icon }
    : undefined,
)
const rightItem = { id: AI_TAB.route, label: AI_TAB.label, icon: AI_TAB.icon }

onBeforeUnmount(() => {
  cancelPress()
  clearHintTimer()
})
</script>

<template>
  <nav ref="dockEl" class="dock" aria-label="主导航">
    <!-- 图标 24 / 标签 10-11 Medium / 图标与标签 2：底部页签的规格（原生三块玻璃
         与画质预览页的标本共用这份，所以图标尺寸也由装配层给，调用处不再各写 21/22） -->
    <GlassDockAssembly
      :items="dockItems"
      :active="String(route.name ?? '')"
      :left="leftItem"
      :right="rightItem"
      :goo="goo"
      left-slot="left"
      right-slot="ai"
    >
      <template #left="{ item, active }">
        <button
          ref="leftBtnEl"
          type="button"
          class="dock-slot glow-layer"
          :class="{ active }"
          :aria-label="`${item.label}（长按更换）`"
          @pointerdown="startPress($event)"
          @pointerup="cancelPress"
          @pointerleave="cancelPress"
          @pointercancel="cancelPress"
          @contextmenu.prevent
          @click="onLeftClick"
        >
          <component :is="item.icon" :size="24" :stroke-width="active ? 2.4 : 1.9" />
          <span>{{ item.label }}</span>
        </button>
      </template>
      <template #tab="{ item, active }">
        <RouterLink
          :to="{ name: item.id }"
          class="dock-tab glow-layer"
          :class="{ active }"
        >
          <component :is="item.icon" :size="24" :stroke-width="active ? 2.4 : 1.9" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </template>
      <template #right="{ item, active }">
        <RouterLink :to="{ name: item.id }" class="dock-slot glow-layer" :class="{ active }">
          <component :is="item.icon" :size="24" :stroke-width="active ? 2.4 : 1.9" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </template>
    </GlassDockAssembly>

    <!-- 长按左钮的选择器：候选来自插件层（关掉模块即从清单中消失）。
         用 bind 菜单贴着被长按的那颗钮弹（图标 + 文字）——它是「换一个落点」，
         不是需要遮罩压场的破坏性操作 -->
    <AppMenu
      :open="pickerOpen"
      :anchor="pickerAnchor"
      title="底栏左键"
      :actions="pickerActions"
      @select="dock.setLeftRoute"
      @close="closePicker"
    />

    <!-- 左钮引导气泡：点按左钮时（每天首次）弹出，提醒它可以长按自定义；最长 20s 自动收起 -->
    <DockHintBubble
      :open="hintOpen"
      :anchor="leftBtnEl"
      :container="dockEl"
      :icon="leftItem?.icon"
      title="底栏左键可自定义"
      body="长按左下角这个按钮，就能把它换成你常用的模块入口。"
      @close="closeHint"
      @dismiss="dismissHint"
    />
  </nav>
</template>

<style scoped>
/* 几何归 Dock 自己；三块玻璃的尺寸关系与前景（.dock-block / .dock-tab / .dock-slot）
   在全局 base.css —— 与画质预览页的标本共用同一份，标本才不会与真实 Dock 长得不像；
   材质（折射 / 毛玻璃 / 退化）全在 GlassSurface 里。 */
.dock {
  position: fixed;
  bottom: calc(var(--safe-bottom) + var(--dock-float));
  left: var(--safe-left);
  right: var(--safe-right);
  margin: 0 auto;
  max-width: var(--frame-max);
  height: var(--tabbar-h);
  display: flex;
  z-index: 60;
}
</style>
