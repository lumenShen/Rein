<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Minus } from 'lucide-vue-next'

import DockEditTray from '@/components/mobile/DockEditTray.vue'
import ComposerBar from '@/components/common/ComposerBar.vue'
import GlassDockAssembly from '@/components/common/GlassDockAssembly.vue'
import VoiceInputMask from '@/components/ai/VoiceInputMask.vue'
import { useNavDrag } from '@/composables/useNavDrag'
import { useNavEdit } from '@/composables/useNavEdit'
import { usePressGlow } from '@/composables/usePressGlow'
import { useToast } from '@/composables/useToast'
import { useAiStore } from '@/stores/ai'
import { useComposerStore } from '@/stores/composer'
import { useNavLayoutStore, TABBAR_MAX, type NavEntry } from '@/stores/navLayout'
import { composerEngaged } from '@/system/composerFocus'
import {
  aiVoiceCancel,
  aiVoiceInput,
  aiVoiceSetContinuous,
  aiVoiceStart,
  aiVoiceStop,
  appendVoiceText,
  onAiVoiceResult,
  VOICE_TAP_MS,
  type AiVoiceResult,
} from '@/system/aiVoiceInput'
import { motionRich } from '@/system/motion'

/**
 * 底部悬浮 Dock · 合并版（2026-11 底栏重构）：**一块玻璃两行** ——
 *
 *   上 · AI 快捷输入行（ComposerBar）：+ / 输入 / 麦克风 / 发送。所有显示底栏的
 *       页面都带着它（AI 入口从此长在底栏上，不再只有 AI 页有输入框）；发送走
 *       ai.askFrom（抢课「交给 AI 排查」同一条跨页链路：AI 页挂载时取走即发，
 *       busy 时落输入框等），「+」把草稿带去 AI 页的完整输入条（附件 / 文档在那边）。
 *   下 · 页签行：导航布局层（stores/navLayout）解析的页签 —— 内核固定件（主页 / 我 /
 *       AI）与插件条目（运动…）摊开均分；**长按页签进编辑态**：可移除、可排序、可加回。
 *
 * 从前两侧的独立圆钮（左 = 自定义落点 / 右 = AI 槽位）随合并退役：右钮的职责交给
 * 输入行（输入行本身就是 AI 入口），左钮的「快捷落点」由编辑态承接（把模块页签加回
 * 页签行即常驻）。随它们一起退场的还有落点偏好（stores/dock）与引导气泡（dockHint）。
 *
 * 页签行不再是这里的硬编码清单：渲染 = 用户布局 ∩ 注册表 ∩ 启用态（navLayout.items），
 * 固定件（主页 / 我 / AI）永不入存、位置由容器定；编辑态以草稿为准渲染，退出只有托盘里的
 * 「放弃变更 / 保存布局」两条路。
 *
 * 输入行的显隐：只剩编辑态收起（mask 之上不该有输入面）。AI 页也常驻同一根
 * ComposerBar（从 AIPage Teleport 进来），不再「AI 页有、别的页没有」——两个入口
 * 从此是同一个组件、同一层薄底。显隐写到 <html data-dock-quick> 上 —— --dock-top 的
 * 「让位高度」跟着开关，浮层 / 菜单 / Toast 的避让才不会多让一截（见 tokens.css）。
 *
 * 材质一律走 GlassSurface（与标本同一个组件、同一组默认参数）：超高档折射背后的
 * 页面真实内容，其余档位退化成普通毛玻璃；弱档由 base.css 全局关掉 blur。输入行是
 * 玻璃内的嵌套浅色层（不是又一块玻璃）—— 嵌套不带受光边，不会在缝上画月牙硬边。
 */

/** 长按判定：按住这么久页签进编辑态（松手不跳转） */
const LONG_PRESS_MS = 480
/** 长按位移阈值：超过它是滚动 / 滑动，不是长按（与 useNavDrag、bento 的 slop 同值） */
const SLOP_PX = 8
const ai = useAiStore()
const composer = useComposerStore()
const navLayout = useNavLayoutStore()
const navEdit = useNavEdit('tabbar')
const route = useRoute()
const router = useRouter()
const toast = useToast()

/** 编辑态（模板顶层绑定，自动解包）：进入后页签行以草稿为准渲染、页签按钮化 */
const editing = navEdit.editing

/** 输入行形态：AI 页把**同一根输入条**（AIPage 里的 ComposerBar）Teleport 进
 *  #dock-ai-composer 宿主，其余页由底栏自己渲染 ComposerBar —— 两边是**同一个组件**，
 *  外观 / 圆角 / 薄底 / 回车语义完全一致，差别只在发送落点与芯片。编辑态两样都收
 *  （托盘与徽标独占这块玻璃）。data-dock-quick 因此在 AI 页也保持 on ——
 *  避让高度（--dock-top / --dock-h）必须按两行算。 */
const quickBar = computed(() => !editing.value && route.name !== 'ai')
const aiEmbed = computed(() => !editing.value && route.name === 'ai')
const showQuick = computed(() => !editing.value)

/**
 * 页签行：布局 ∩ 目录 ∩ 启用态，**上限 TABBAR_MAX（5）**——超出的不渲染
 * （存量超长布局来自旧版本或「启用模块变多」，裁掉而不是挤成一团）。
 * 编辑态以**草稿**为准 —— 草稿里可能有刚从候选加回的条目（不在已存布局里），
 * 渲染源要并上候选才是完整的「启用目录」，只按 items 找会把它丢掉。
 */
const tabs = computed<NavEntry[]>(() => {
  if (!navEdit.editing.value) return navLayout.items('tabbar').slice(0, TABBAR_MAX)
  const byId = new Map(
    [...navLayout.items('tabbar'), ...navLayout.candidates('tabbar')].map((it) => [it.id, it]),
  )
  return (navEdit.draft.value ?? [])
    .map((id) => byId.get(id))
    .filter((it): it is NavEntry => !!it)
    .slice(0, TABBAR_MAX)
})

/** 固定件 id 集（主页 / 我 / AI）：徽标显隐与「做不做拖拽把手」按它判定 —— 固定件无徽标、
    不可拖，是排序的边界 */
const fixedIds = computed(() => new Set(tabs.value.filter((t) => t.fixed).map((t) => t.id)))

/** 页签行里当前选中的那一格（-1 = 这一页不在 Dock 上，此时不画任何活动底） */
const tabIndex = computed(() => tabs.value.findIndex((t) => route.name === t.id))

/**
 * 液态活动底（丰富档）：挂上之后原来那层纯色活动底让位（见 base.css 的 .goo 规则）。
 * 用 `v-if="goo"` 而不是让 thumb 自己判断 —— 没有选中项时（比如停在二级页）
 * 两块实现都不该画，这个条件只此一处。
 */
const goo = computed(() => motionRich.value && tabIndex.value >= 0)

/** 按压定向光晕（丰富档）：一份监听挂在整个 Dock 上，按 selector 就近点亮被按的那一格 */
const dockEl = ref<HTMLElement | null>(null)
usePressGlow(dockEl, '.dock-tab')

/* ---------- 编辑态拖拽：手势骨架在 useNavDrag（与便当同手感），换位落在草稿里 ---------- */
const drag = useNavDrag({
  listEl: dockEl,
  orderIds: () => navEdit.draft.value ?? [],
  move: (id, to) => navEdit.moveInDraft(id, to),
  snapshot: () => navEdit.draft.value?.slice() ?? [],
  restore: (ids) => {
    if (navEdit.draft.value) navEdit.draft.value = ids
  },
})

/* ---------- AI 快捷输入行：草稿、跨页发送与语音 ----------
 * 草稿住在 stores/composer（跨页唯一真源）：文字 / 附图 / 文档 / 引用 / 纪要
 * 一起活过任何一次切页 —— 底栏与 AI 页的输入条从此读写同一份。 */

/** 输入中（或「+」菜单开着）：页签行收起，整块玻璃只剩输入行。
 *  AI 页也认这份状态（那边的输入条是同一个组件、同一个聚焦单例）。 */
const typing = computed(() => showQuick.value && composerEngaged.value)

/** 发送：文字走 askFrom 递话（AI 页挂载即发）；带引用 / 附件 / 文档 / 纪要时整份草稿
 *  交给 AI 页在挂载后发送 —— 引用关系、图片视图与文档元数据只有那边组装得了，
 *  底栏代发会把这些内容悄悄留在原地。 */
function sendQuick(): void {
  if (!composer.hasContent) return
  if (
    composer.quote ||
    composer.attachments.length > 0 ||
    composer.docAtt ||
    composer.memoRefs.length > 0
  ) {
    composer.requestSend()
    void router.push({ name: 'ai' })
    return
  }
  const text = composer.text.trim()
  if (!text) return
  ai.askFrom(text)
  composer.clear()
  void router.push({ name: 'ai' })
}

/** 「+」：去 AI 页的完整输入条（附件 / 文档 / 引用在那边）。草稿已经是全局共享的，
 *  不需要交接 —— 保留「带草稿过去、只填不发」的既有语义。 */
function openFullComposer(): void {
  void router.push({ name: 'ai' })
}

/* 语音输入（按住说话 / 轻点连听）：链路与 AI 页同一条（system/aiVoiceInput），
   手势结算也同一套 —— 按住松开收尾上屏，轻点转入连听。识别文字先进底栏草稿，
   由用户自己按发送：半截话不该不打招呼就飞出去。 */
let voicePressing = false
let voiceDownAt = 0

function onVoiceWindowUp(): void {
  if (!voicePressing) return
  voicePressing = false
  window.removeEventListener('pointerup', onVoiceWindowUp)
  window.removeEventListener('pointercancel', onVoiceWindowUp)
  if (!aiVoiceInput.active) return
  if (Date.now() - voiceDownAt < VOICE_TAP_MS) {
    // 轻点 → 转入连听：等「停止信号」（音量占优的发言人停顿）自动结束，或再点一次手动结束
    aiVoiceSetContinuous()
  } else {
    // 按住松开 → 结束并把识别文字送进输入行
    void aiVoiceStop()
  }
}

function onDockVoiceDown(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault() // 不抢焦点：输入行光标与软键盘保持原状
  voiceDownAt = Date.now()
  voicePressing = true
  window.addEventListener('pointerup', onVoiceWindowUp)
  window.addEventListener('pointercancel', onVoiceWindowUp)
  void aiVoiceStart('hold').then((ok) => {
    if (!ok) {
      onVoiceWindowUp() // 起播失败：先复位本地按压状态再提示
      if (aiVoiceInput.lastError) toast.toast(aiVoiceInput.lastError)
    }
  })
}

/** 识别结果上屏。quickBar 闸门：AI 页自己的语音会话（那边有自己的订阅与遮罩）
    不该再被底栏接一手 —— 底栏只在「底栏这条 ComposerBar」可见时认领结果。 */
function onVoiceDone({ text, reason }: AiVoiceResult): void {
  if (!quickBar.value) return
  if (text) {
    composer.text = appendVoiceText(composer.text, text)
  } else if (reason === 'error') {
    toast.toast(aiVoiceInput.lastError || '识别失败')
  } else if (reason !== 'cancel') {
    toast.toast('没有识别到内容')
  }
}

onAiVoiceResult(onVoiceDone)

// 语音是页面手势：换页即取消（不把半截话留在运行时里），按压中的窗口监听一并拆掉
watch(
  () => route.name,
  () => {
    if (aiVoiceInput.active) void aiVoiceCancel()
  },
)

/* 显隐写到 <html>：浮层（AppMenu / ActionSheet / Toast）靠 --dock-top 避让底栏，
   输入行在编辑态收起时整条 Dock 矮一截，避让高度必须跟着变（tokens.css）。
   三态：off = 没有输入行 / on = 输入行 + 页签行 / input = 输入中（页签行收起）。
   输入中把 --dock-top 也换成「只剩输入行」：键盘上方的浮层不该按两行让位。 */
const quickState = computed<'off' | 'on' | 'input'>(() => {
  if (!showQuick.value) return 'off'
  return typing.value ? 'input' : 'on'
})

watch(
  quickState,
  (state) => {
    document.documentElement.dataset.dockQuick = state
  },
  { immediate: true },
)

/* ---------- 页签行：长按进编辑态（仅非编辑态；编辑态里按住页签是拖拽把手） ---------- */
let tabPressTimer: ReturnType<typeof setTimeout> | null = null
let tabPressX = 0
let tabPressY = 0
let tabLongPressed = false

function cancelTabPress(): void {
  if (tabPressTimer) {
    clearTimeout(tabPressTimer)
    tabPressTimer = null
  }
}

function startTabPress(e: PointerEvent): void {
  // 编辑态优先门：已有会话（含其他容器）时不再起长按 —— 按住页签的语义交给拖拽
  if (navEdit.activeScope.value !== null) return
  tabLongPressed = false
  tabPressX = e.clientX
  tabPressY = e.clientY
  cancelTabPress()
  tabPressTimer = setTimeout(() => {
    tabPressTimer = null
    tabLongPressed = true
    navEdit.enter()
  }, LONG_PRESS_MS)
}

/** 按住后的位移：超过 slop 是滚动不是长按，取消计时（真机上的长按常先被滚动试探） */
function onTabPointerMove(e: PointerEvent): void {
  if (!tabPressTimer) return
  if (Math.hypot(e.clientX - tabPressX, e.clientY - tabPressY) > SLOP_PX) cancelTabPress()
}

/** 非编辑态点按 = 跳转。长按已经进过编辑态的那次抬手 click 在这里被吃掉：
    元素换身（v-if 顶替）后 click 落在换身后的 button 上，不拦就是「进编辑的尾巴
    顺手切了页」；部分安卓内核长按松手不发 click，无 click 就无跳转，天然兼容。 */
function onTabActivate(id: string): void {
  if (tabLongPressed) {
    tabLongPressed = false
    return
  }
  void router.push({ name: id })
}

/** 编辑态整格点击 = 撤回（「−」徽标是 aria-hidden 的装饰，键盘 Enter / 读屏激活落在
    整格上 —— 与 rail 编辑态的整格语义同一套）；固定件由 removeFromDraft 拒绝，no-op。
    长按进编辑后松手的那次 click 会落在换身后的 button 上（旧 RouterLink 已卸载，
    浏览器把 click 派给 release 目标）—— 那一下是「进编辑」的尾巴，不是撤回指令；
    拖拽松手的幽灵 click 由 useNavDrag 的吞窗兜住，两件事分开。 */
function onEditTabClick(id: string): void {
  if (tabLongPressed) {
    tabLongPressed = false
    return
  }
  navEdit.removeFromDraft(id)
}

/** 页签按下：编辑态 = 可移动项的拖拽把手（固定件是边界，不做把手）；非编辑态 = 长按计时起点 */
function onTabDown(e: PointerEvent, id: string): void {
  if (navEdit.editing.value) {
    if (fixedIds.value.has(id)) return
    tabLongPressed = false // 新的一次按下是新手势：清掉长按进编辑的尾巴标记（部分内核不发释放 click）
    drag.onHandleDown(e, id)
    return
  }
  startTabPress(e)
}


const dockItems = computed(() =>
  tabs.value.map((item) => ({ id: item.id, label: item.label, icon: item.icon })),
)

onBeforeUnmount(() => {
  cancelTabPress()
  voicePressing = false
  window.removeEventListener('pointerup', onVoiceWindowUp)
  window.removeEventListener('pointercancel', onVoiceWindowUp)
  if (aiVoiceInput.active) void aiVoiceCancel()
  // data-dock-quick 是本组件写到 <html> 上的：卸载（回到桌面壳）时撤掉，别留悬空让位
  delete document.documentElement.dataset.dockQuick
})
</script>

<template>
  <nav ref="dockEl" class="dock" :class="{ 'is-editing': editing, 'is-typing': typing }" aria-label="主导航">
    <!-- 图标 24 / 标签 10-11 Medium / 图标与标签 2：底部页签的规格（玻璃内前景
         与画质预览页的标本共用 base.css 那份，图标尺寸由装配层给，调用处不再各写 21/22） -->
    <GlassDockAssembly
      :items="dockItems"
      :active="String(route.name ?? '')"
      :goo="goo"
      data-slot="dock"
    >
      <template #quick>
        <!-- AI 页：这里渲染的是**宿主** —— AIPage 的输入条（同一颗 ComposerBar +
             引用 / @纪要 / 附图 / 文档芯片）Teleport 进来，合成同一块玻璃的大 Dock；
             其余页是底栏自己渲染的 ComposerBar。宿主常驻 DOM（v-show）：Teleport 目标
             必须在 AIPage 挂载前就存在，否则首帧定位失败。 -->
        <ComposerBar
          v-if="quickBar"
          v-model="composer.text"
          :sendable="composer.hasContent"
          @add="openFullComposer"
          @send="sendQuick"
          @voice-down="onDockVoiceDown"
        />
        <div v-show="aiEmbed" id="dock-ai-composer" class="dock-ai-host" />
      </template>
      <template #tab="{ item, active }">
        <!-- 编辑态：页签按钮化 —— 整格点击 = 撤回（键盘 / 读屏可达，「−」只是装饰），
             可移动项右上角叠「−」徽标、自身是拖拽把手；固定件（主页 / 我 / AI）无徽标
             不可拖不可撤（aria 保持条目名，不用动作语义骗读屏用户）。非编辑态 RouterLink 原样 -->
        <button
          v-if="editing"
          type="button"
          class="dock-tab glow-layer"
          :class="{ active }"
          :data-nav-id="item.id"
          :aria-label="fixedIds.has(item.id) ? undefined : `从底栏移除『${item.label}』`"
          :aria-current="active ? 'page' : undefined"
          @pointerdown="onTabDown($event, item.id)"
          @click="onEditTabClick(item.id)"
          @contextmenu.prevent
        >
          <!-- 页签图标 18（kit 校准二 #34：18 Semibold；24 作废） -->
          <component :is="item.icon" :size="18" :stroke-width="active ? 2.4 : 1.9" />
          <span>{{ item.label }}</span>
          <span
            v-if="!fixedIds.has(item.id)"
            class="dock-badge"
            data-nav-badge="-"
            aria-hidden="true"
            @pointerdown.stop
            @click.stop="navEdit.removeFromDraft(item.id)"
          >
            <Minus :size="11" :stroke-width="2.6" />
          </span>
        </button>
        <!-- 非编辑态也是 button（2026-11-08）：RouterLink 的 href 在安卓上长按弹原生
             链接预览（「主页 http://…」气泡）并 pointercancel 掉长按手势 —— 编辑态进不去，
             @contextmenu.prevent 也拦不住（WebView 原生层先动）。移动 Dock 的页签没有
             「新标签打开 / 复制链接」语义，button + 程序化导航一根筋到底。 -->
        <button
          v-else
          type="button"
          class="dock-tab glow-layer"
          :class="{ active }"
          :aria-current="active ? 'page' : undefined"
          @pointerdown="startTabPress"
          @pointermove="onTabPointerMove"
          @pointerup="cancelTabPress"
          @pointercancel="cancelTabPress"
          @pointerleave="cancelTabPress"
          @click="onTabActivate(item.id)"
          @contextmenu.prevent
        >
          <component :is="item.icon" :size="18" :stroke-width="active ? 2.4 : 1.9" />
          <span>{{ item.label }}</span>
        </button>
      </template>
    </GlassDockAssembly>

    <!-- 编辑态候选托盘：Dock 上方一条（移动端唯一的候选面）。退出编辑态只有托盘里的
         「放弃变更 / 保存布局」两条路（useNavEdit 不变量）；进出淡入淡出与气泡同一节奏 -->
    <Transition name="tray">
      <DockEditTray v-if="editing" />
    </Transition>

    <!-- 语音输入全屏遮罩（按住/轻点说话时渐入，结束时渐出回收）。只在底栏这条
         ComposerBar 可见时挂：AI 页的输入条有自己的遮罩实例，两份叠着只会互相拉扯透明度 -->
    <VoiceInputMask v-if="quickBar" />
  </nav>
</template>

<style scoped>
/* 几何归 Dock 自己：合并玻璃随容器铺满（左右各留 --dock-float 浮边），高度由两行内容
   定；页签前景（.dock-tab / .dock-navs / .dock-quick）在全局 base.css —— 与画质预览页
   的标本共用同一份，标本才不会与真实 Dock 长得不像。材质（折射 / 毛玻璃 / 退化）全在
   GlassSurface 里。 */
.dock {
  position: fixed;
  bottom: calc(var(--safe-bottom) + var(--dock-float));
  /* 左右 = 页面栅格（与卡片边缘对齐；安全区的 20px 硬底只该管竖向手势带） */
  left: var(--page-pad-x);
  right: var(--page-pad-x);
  z-index: 60;
}

/* ---------- 输入中：页签行收起（一块玻璃只剩输入行） ----------
   2026-11-10 用户定稿：聚焦输入框时隐藏 nav-item，键盘上方的空间留给输入本身；
   无论在哪个页面（含 AI 页的 Teleport 输入条）都成立 —— 聚焦态来自
   system/composerFocus 的同一个单例。
   收起做补间（键盘弹起时的位移不突兀）；展开保持瞬时：失焦往往伴随「+」菜单
   打开，菜单的锚点若在动画中途测量，会落在还没回到位的 + 钮上。 */
.dock.is-typing :deep(.dock-navs) {
  height: 0;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  transition:
    height var(--dur-base) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-standard);
}

/* 页签行退场后，输入行自己补上玻璃下缘的内缩（原先由页签行占着这一截）。
   .flush 是并入 AI 页 .composer 的那一根：外边距归 .composer.embedded 管，
   这里不去碰它（否则会多出 4px）。 */
.dock.is-typing :deep(.dock-quick:not(.flush)) {
  margin-bottom: var(--gap-tight);
}

.dock.is-typing :deep(.composer.embedded) {
  margin-bottom: var(--gap-tight);
}

/* 关闭动效：收起这一步也不做补间 */
html[data-motion='off'] .dock.is-typing :deep(.dock-navs) {
  transition: none;
}

/* ---------- 编辑态：一切视觉只落在插槽内容里，装配层零改动 ----------
   GlassDockAssembly / GlassSurface / base.css 的 dock 几何被画质预览页当标本逐像素比对
   （e2e-perf-glass），徽标与手势样式只在编辑态渲染 / 生效，标本永远不进编辑态。 */
.dock.is-editing .dock-tab {
  /* 拖拽面手势前置（useNavDrag 契约 #2）：base.css 给文档滚动层的全局 pan-x pan-y 会把
     指针事件链接管成 pointercancel —— 安卓上不前置这条，拖拽永不触发。
     只在编辑态挂：非编辑态不碰手势链，页面滚动照旧 */
  touch-action: none;
  cursor: grab;
}

/* 「−」徽标：可移动页签右上角的小圆。玻璃 overflow:hidden，徽标落在页签内沿
   （右上角空档：图标居中占 24–42，徽标占 48–64，互不打架） */
.dock-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--danger);
  color: var(--on-accent);
  box-shadow: var(--shadow-float);
}

/* 托盘进出：淡入 + 轻微上浮（与气泡同一套节奏）；离场瞬时淡出 */
.tray-enter-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.tray-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.tray-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.tray-leave-to {
  opacity: 0;
}

html[data-motion='off'] .tray-enter-from {
  transform: none;
}
</style>
