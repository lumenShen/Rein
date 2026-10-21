<script lang="ts">
import type { Component } from 'vue'

/** 菜单项：icon 缺省为纯文字样式；children 生成下一级层叠面板（bind）或内嵌分组（dialog） */
export interface MenuItem {
  label: string
  value: string
  icon?: Component
  danger?: boolean
  disabled?: boolean
  children?: MenuItem[]
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

/**
 * AppMenu 统一菜单：bind（锚定触发组件旁弹出，默认）与 dialog（底部操作面板）两种出现方式。
 * bind 型 Teleport 到 body 定位，不受父容器 overflow 裁剪；z-index 114+，高于 SheetModal(100)、低于 Toast(120)。
 * 多级层叠：点击带 children 的项推入下一层面板，再点同项或点遮罩收起。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    actions: MenuItem[]
    /** 出现方式：bind = 锚定 anchor 元素旁；dialog = 底部操作面板。默认 bind */
    mode?: 'bind' | 'dialog'
    /** bind 模式的锚定元素（触发菜单的按钮/元素） */
    anchor?: HTMLElement | null
    title?: string
  }>(),
  { mode: 'bind', anchor: null, title: undefined },
)

const emit = defineEmits<{
  close: []
  select: [value: string]
}>()

const bindMode = computed(() => props.mode === 'bind' && props.anchor !== null)

/** 关闭时保留 levels 供离场动画播放，仅停止渲染 */
const visibleLevels = computed(() => (props.open ? levels.value : []))

/* ---------- bind 模式：多级层叠面板 ---------- */

interface MenuLevel {
  items: MenuItem[]
  /** 触发本层的锚定矩形（根层为 anchor 元素，子层为所点菜单项） */
  anchorRect: DOMRect | null
  /** 已打开层来自哪个父项 value，用于再次点击收起 */
  openedFrom?: string
  /** 测量后写入的定位样式；null 表示未测量（先隐藏渲染） */
  style: Record<string, string> | null
}

const levels = ref<MenuLevel[]>([])
const panelEls = new Map<number, HTMLElement>()

function setPanel(i: number, el: unknown): void {
  if (el instanceof HTMLElement) panelEls.set(i, el)
  else panelEls.delete(i)
}

/** 面板与锚点之间的间隙：贴太近会读成「锚点自己的一部分」，苹果菜单约 8px */
const GAP = 8
/** 视口边缘的最小留白（纵向；横向再并上手机的手势安全区，见 hEdges） */
const EDGE = 8

/**
 * 列表里只要有一项带图标，就统一留出图标列 —— 否则缺图标的那几行标签会左移，
 * 同一份菜单里的标签左边缘参差不齐。缺图标的项渲染一个等宽空位（见模板）。
 */
function levelHasIcon(items: MenuItem[] | undefined): boolean {
  return !!items?.some((it) => !!it.icon)
}

/** 横向可用边距：手机两缘有手势返回带（--safe-left/right ≥ 20px），菜单不贴进带内 */
function hEdges(): { left: number; right: number } {
  if (typeof document === 'undefined') return { left: EDGE, right: EDGE }
  const cs = getComputedStyle(document.documentElement)
  const px = (name: string): number => parseFloat(cs.getPropertyValue(name)) || 0
  return { left: Math.max(EDGE, px('--safe-left')), right: Math.max(EDGE, px('--safe-right')) }
}

/** 测量各层面板尺寸并定位：优先锚点下方，空间不足翻到上方；水平越界则右对齐/钳制在视口内 */
async function layout(): Promise<void> {
  await nextTick()
  levels.value.forEach((lv, i) => {
    const el = panelEls.get(i)
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const rect = lv.anchorRect
    if (!rect) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const edge = hEdges()
    let top: number
    let originY: string
    if (i === 0) {
      // 根层：优先锚点下方，空间不足翻到上方，再不行钳制在视口内
      if (h + GAP <= vh - rect.bottom - EDGE) {
        top = rect.bottom + GAP
        originY = 'top'
      } else if (h + GAP <= rect.top - EDGE) {
        top = rect.top - GAP - h
        originY = 'bottom'
      } else {
        top = Math.min(Math.max(EDGE, rect.bottom + GAP), vh - EDGE - h)
        originY = 'top'
      }
    } else {
      // 子层：与父项顶对齐（经典层叠），底部放不下整体上移
      top = rect.top
      originY = 'top'
      if (top + h > vh - EDGE) {
        top = vh - EDGE - h
        originY = 'bottom'
      }
      if (top < EDGE) top = EDGE
    }
    let left: number
    let originX = 'left'
    if (i === 0) {
      left = rect.left
      if (left + w > vw - edge.right) {
        left = rect.right - w
        originX = 'right'
      }
      if (left < edge.left) {
        left = edge.left
        originX = 'left'
      }
    } else {
      // 子层默认向右层叠，右侧放不下翻到左侧
      if (rect.right + GAP + w <= vw - edge.right) {
        left = rect.right + GAP
        originX = 'left'
      } else {
        left = rect.left - GAP - w
        originX = 'right'
      }
    }
    lv.style = {
      position: 'fixed',
      top: `${Math.round(top)}px`,
      left: `${Math.round(Math.max(edge.left, Math.min(left, vw - edge.right - w)))}px`,
      zIndex: `${115 + i}`,
      transformOrigin: `${originX} ${originY}`,
      // 丰富档的透镜式展开（clip-path 圆心）就落在被贴住的那个角上 ——
      // 与 transformOrigin 是同一个判定，不必再量一遍像素
      '--ox': originX === 'left' ? '0%' : '100%',
      '--oy': originY === 'top' ? '0%' : '100%',
    }
  })
}

function onItemClick(a: MenuItem, e: MouseEvent, levelIdx: number): void {
  if (a.disabled) return
  if (a.children?.length) {
    const next = levels.value[levelIdx + 1]
    if (next && next.openedFrom === a.value) {
      levels.value = levels.value.slice(0, levelIdx + 1)
      // 收起后最深层就是本层：键盘下标跟到被点开的那一项上
      activeIdx.value = Math.max(levels.value[levelIdx].items.findIndex((it) => it.value === a.value), 0)
    } else {
      levels.value = levels.value.slice(0, levelIdx + 1)
      levels.value.push({
        items: a.children,
        anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
        openedFrom: a.value,
        style: null,
      })
      // 子层开了：后续方向键该走子层，下标从子层第一项起算
      activeIdx.value = 0
    }
    void layout()
    return
  }
  emit('select', a.value)
  emit('close')
}

function closeAll(): void {
  emit('close')
}

/** Esc 关闭：把焦点还给触发按钮（用户在键盘上「回得去」） */
function closeMenu(): void {
  // 先还焦点再关：anchor 的 focus() 会派发 blur/focus，顺序反了 focus 会落在 body 上
  props.anchor?.focus({ preventScroll: true })
  closeAll()
}

function onViewportChange(): void {
  // 视口变化后锚定位置不可信，直接收起，行为可预期
  if (props.open && bindMode.value) closeAll()
}

/* ---------- 键盘可达：打开即聚焦、方向键行走、Home/End、Esc 归还焦点 ----------
   面板 Teleport 到 body 尾部，直接 Tab 会从触发按钮一路跳到页面末尾之外 —— 那条
   「Tab 顺序陷阱」只能靠把焦点管理接过来解决：↑↓ 在本层菜单项间移动（跳过禁用项）、
   Home/End 去首尾、→ 开子层或推进已开的子层、← 收起最深层并把焦点还给父项、
   Esc 关整层并还焦给触发按钮。Tab 改为在菜单项之间循环，不让焦点跑到页面别处。
   鼠标路径一概不动：焦点用 preventScroll 落位，不触发滚动收起。 */

const sheetEl = ref<HTMLElement | null>(null)
function setSheet(el: unknown): void {
  sheetEl.value = el instanceof HTMLElement ? el : null
}

/** 某一层（dialog 恒为 0）的菜单按钮 DOM；取消键不参与行走 */
function itemsOf(i: number): HTMLElement[] {
  const root = bindMode.value ? panelEls.get(i) : sheetEl.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('.item:not(.cancel)'))
}

/** 当前面板的（数据, DOM）两份同序清单：bind 取最深层，dialog 取底部面板 */
function currentPanel(): { data: MenuItem[]; els: HTMLElement[] } {
  if (bindMode.value) {
    const i = Math.max(levels.value.length - 1, 0)
    return { data: levels.value[i]?.items ?? [], els: itemsOf(i) }
  }
  return { data: flatActions.value.filter((f) => !f.header).map((f) => f.item), els: itemsOf(0) }
}

/** 键盘焦点在当前层内的下标；打开时落在第一项上 */
const activeIdx = ref(0)

function focusAt(idx: number): void {
  activeIdx.value = idx
  currentPanel().els[idx]?.focus({ preventScroll: true })
}

function moveFocus(dir: 1 | -1): void {
  const { data } = currentPanel()
  const n = data.length
  if (!n) return
  let idx = activeIdx.value
  for (let k = 0; k < n; k++) {
    idx = (idx + dir + n) % n
    if (!data[idx].disabled) break
  }
  focusAt(idx)
}

function edgeFocus(which: 'first' | 'last'): void {
  const { data } = currentPanel()
  if (which === 'first') {
    const i = data.findIndex((d) => !d.disabled)
    if (i >= 0) focusAt(i)
  } else {
    for (let i = data.length - 1; i >= 0; i--) {
      if (!data[i].disabled) {
        focusAt(i)
        return
      }
    }
  }
}

/** → ：开子层（未开时）或把焦点推进已开的子层 */
function openOrEnterChild(): boolean {
  if (!bindMode.value) return false
  const levelIdx = levels.value.length - 1
  const panel = currentPanel()
  const it = panel.data[activeIdx.value]
  if (!it?.children?.length) return false
  const next = levels.value[levelIdx + 1]
  if (next && next.openedFrom === it.value) {
    focusAt(0)
    return true
  }
  levels.value = levels.value.slice(0, levelIdx + 1)
  levels.value.push({
    items: it.children,
    anchorRect: panel.els[activeIdx.value]?.getBoundingClientRect() ?? null,
    openedFrom: it.value,
    style: null,
  })
  void layout()
  activeIdx.value = 0
  void nextTick(() => focusAt(0))
  return true
}

/** ← ：收起最深层，焦点还给打开它的那一项 */
function closeChild(): boolean {
  if (!bindMode.value || levels.value.length < 2) return false
  const parent = levels.value[levels.value.length - 2]
  const openedFrom = levels.value[levels.value.length - 1].openedFrom
  levels.value = levels.value.slice(0, -1)
  void layout()
  const idx = parent.items.findIndex((it) => it.value === openedFrom)
  focusAt(Math.max(idx, 0))
  return true
}

/** 焦点不在菜单里时（翻到页面别处的输入框）不抢方向键；Esc 仍然全局有效 */
function focusInMenu(t: EventTarget | null): boolean {
  if (!(t instanceof Node)) return false
  if (sheetEl.value?.contains(t)) return true
  for (const el of panelEls.values()) if (el.contains(t)) return true
  return props.anchor === t || (props.anchor?.contains(t) ?? false)
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  switch (e.key) {
    case 'Escape':
      closeMenu()
      return
    case 'ArrowDown':
      if (focusInMenu(e.target)) {
        e.preventDefault()
        moveFocus(1)
      }
      return
    case 'ArrowUp':
      if (focusInMenu(e.target)) {
        e.preventDefault()
        moveFocus(-1)
      }
      return
    case 'Home':
      if (focusInMenu(e.target)) {
        e.preventDefault()
        edgeFocus('first')
      }
      return
    case 'End':
      if (focusInMenu(e.target)) {
        e.preventDefault()
        edgeFocus('last')
      }
      return
    case 'ArrowRight':
      if (focusInMenu(e.target) && openOrEnterChild()) e.preventDefault()
      return
    case 'ArrowLeft':
      if (focusInMenu(e.target) && closeChild()) e.preventDefault()
      return
    case 'Tab':
      // 面板在 body 尾部：Tab 会跳出菜单跳到页面末尾。改成菜单内循环，Esc 仍然是出口
      if (focusInMenu(e.target)) {
        e.preventDefault()
        moveFocus(e.shiftKey ? -1 : 1)
      }
      return
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeIdx.value = 0
      if (bindMode.value) {
        levels.value = [
          {
            items: props.actions,
            anchorRect: props.anchor!.getBoundingClientRect(),
            style: null,
          },
        ]
      }
      // 等面板量完尺寸再落焦点；preventScroll 保证 focus 不当成滚动把菜单收掉
      void layout().then(() => edgeFocus('first'))
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
      window.addEventListener('keydown', onKeydown)
    } else {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('keydown', onKeydown)
    }
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('keydown', onKeydown)
})

/* ---------- dialog 模式：层级拍平为缩进分组 ---------- */

const flatActions = computed(() => {
  const out: { item: MenuItem; depth: number; header: boolean }[] = []
  const walk = (items: MenuItem[], depth: number): void => {
    for (const it of items) {
      if (it.children?.length) {
        out.push({ item: it, depth, header: true })
        walk(it.children, depth + 1)
      } else {
        out.push({ item: it, depth, header: false })
      }
    }
  }
  walk(props.actions, 0)
  return out
})

/** dialog 模式同样统一图标列（理由见 levelHasIcon） */
const flatHasIcon = computed(() => flatActions.value.some((f) => !f.header && !!f.item.icon))
</script>

<template>
  <Teleport to="body">
    <!-- bind：透明点击层（无视觉遮罩）+ 锚定面板 -->
    <template v-if="bindMode">
      <div v-if="open" class="catcher" @click="closeAll" @contextmenu.prevent="closeAll" />
      <TransitionGroup name="am-pop">
        <div
          v-for="(lv, i) in visibleLevels"
          :key="i"
          :ref="(el) => setPanel(i, el)"
          class="panel"
          :class="{ 'with-ic': levelHasIcon(lv.items) }"
          :style="lv.style ?? undefined"
          role="menu"
          :aria-label="i === 0 ? title : undefined"
        >
          <!-- 超范围平移层：面板自身带定位/入场动画，不能自平移，改包一层只写 transform -->
          <div class="rubber-layer" data-rubber-content>
            <p v-if="i === 0 && title" class="ptitle">{{ title }}</p>
            <button
              v-for="a in lv.items"
              :key="a.value"
              type="button"
              class="item"
              :class="{ danger: a.danger, disabled: a.disabled }"
              role="menuitem"
              :aria-haspopup="a.children?.length ? 'menu' : undefined"
              :aria-expanded="a.children?.length && levels[i + 1]?.openedFrom === a.value ? 'true' : undefined"
              @click="onItemClick(a, $event, i)"
            >
              <component :is="a.icon" v-if="a.icon" class="ic" :size="19" :stroke-width="2" />
              <span v-else-if="levelHasIcon(lv.items)" class="ic" aria-hidden="true" />
              <span class="lbl">{{ a.label }}</span>
              <ChevronRight v-if="a.children?.length" class="chev" :size="14" />
            </button>
          </div>
        </div>
      </TransitionGroup>
    </template>

    <!-- dialog：底部操作面板（遮罩 + 卡片），层级拍平为缩进分组 -->
    <template v-else>
      <Transition name="am-mask">
        <div v-if="open" class="mask" @click="closeAll" />
      </Transition>
      <Transition name="am-card">
        <div v-if="open" class="sheet" :ref="(el) => setSheet(el)" role="dialog" :aria-label="title ?? '操作'">
          <p v-if="title" class="stitle">{{ title }}</p>
          <template v-for="(f, fi) in flatActions" :key="`${f.item.value}-${fi}`">
            <!-- 缩进基线与其余行同一档：行内文字左右 16（--pad-row）。
                 此前 12 让分组的文字比下面的「取消」多缩进一格（取消吃 .item 的 16）；
                 22px 的层级步长也走令牌，避免再出现一个脱离 4/8 栅格的裸值 -->
            <p
              v-if="f.header"
              class="group"
              :style="{ paddingLeft: `calc(var(--pad-row) + ${f.depth} * var(--sp-22))` }"
            >
              {{ f.item.label }}
            </p>
            <button
              v-else
              type="button"
              class="item tall"
              :class="{ danger: f.item.danger, disabled: f.item.disabled }"
              :style="{ paddingLeft: `calc(var(--pad-row) + ${f.depth} * var(--sp-22))` }"
              @click="emit('select', f.item.value); emit('close')"
            >
              <component :is="f.item.icon" v-if="f.item.icon" class="ic" :size="19" :stroke-width="2" />
              <span v-else-if="flatHasIcon" class="ic" aria-hidden="true" />
              <span class="lbl">{{ f.item.label }}</span>
            </button>
          </template>
          <button type="button" class="item tall cancel" @click="closeAll">取消</button>
        </div>
      </Transition>
    </template>
  </Teleport>
</template>

<style scoped>
.catcher {
  position: fixed;
  inset: 0;
  z-index: 114;
  background: transparent;
}

.panel {
  /* 菜单的参数：宽 224–300px。下限取 HarmonyOS 菜单的 224vp —— 再多两个字的
     中文标签也不会被截成省略号；宽于 300 就失去「贴着触发点」的读感；
     窄屏用 100vw−16 兜底 */
  min-width: 224px;
  max-width: min(300px, calc(100vw - var(--sp-16)));
  max-height: calc(100vh - var(--sp-16));
  overflow-y: auto;
  background: var(--surface);
  border: 0.5px solid var(--line);
  /* 菜单是高频可点的浮层 → 圆角 20（--radius-l）；面板内距 6 让行的高亮底
     与面板边框之间留出一圈等量的边 */
  border-radius: var(--radius-l);
  padding: var(--sp-6);
  box-shadow: var(--shadow-float);
}

.ptitle {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  /* 组标题是「这张菜单是干什么的」：--text-3 的 3.6:1 读不清，抬到 --text-2 */
  color: var(--text-2);
  /* 左右与行内文字同线（--pad-row 16），否则组标题比下面的菜单项缩进一格 */
  padding: var(--sp-8) var(--pad-row) var(--sp-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item {
  display: flex;
  align-items: center;
  /* 图标列与标签 12（--gap-md）；菜单行高 48（--row-h）、圆角 20、左右 16 ——
     与设置行、操作面板行同一档，此前 44 / 8 / 12 各写各的 */
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h);
  padding: 0 var(--pad-row);
  border-radius: var(--radius-l);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--text-1);
  text-align: left;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.item:active {
  background: var(--surface-2);
}

/* 桌面（有悬停能力的设备）：悬停与按压同一档底色 —— 鼠标下「能不能点」要有反馈 */
@media (hover: hover) {
  .item:not(.disabled):hover {
    background: var(--surface-2);
  }
}

/* 键盘焦点落在项上：外发光会被面板的 overflow 裁掉，改成内描边 */
.item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.item .lbl {
  flex: 1;
  min-width: 0;
  /* 菜单是「一眼扫过」的控件：标签不折行，长了给省略号（面板宽度已经放得下常用文案） */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item .chev {
  flex: none;
  color: var(--text-3);
}

/* 图标列：定宽 20px —— 图标与「缺图标的空位」占同一格，标签左边缘才对得齐 */
.item .ic {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  color: var(--text-2);
}

/* 文字走 strong 档（实底 --danger 白底约 3.5:1）；下面那条 .ic 是图标，
   仍留在领域色上 —— tokens.css 的色彩契约对图标与文字是两档 */
.item.danger {
  color: var(--danger-strong);
}

.item.danger .ic {
  color: var(--danger);
}

.item.disabled {
  opacity: var(--disabled-opacity);
}

/* dialog 模式底板（沿用 ActionSheet 的观感） */
.mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.sheet {
  position: fixed;
  /* 与 ActionSheet 同一套落点：离底栏一个卡片间距、两侧各让 12 */
  bottom: calc(var(--dock-top) + var(--gap-md));
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - var(--sp-24));
  max-width: calc(var(--frame-max) - var(--sp-24));
  z-index: 111;
  background: var(--surface);
  /* dialog 模式就是一块半模态底板：与 ActionSheet / SheetModal 同层同圆角，
     内距也统一到 16（--pad-sheet）—— 此前 8 是这一族里唯一的例外 */
  border-radius: var(--radius-xl);
  padding: var(--pad-sheet);
  box-shadow: var(--shadow-float);
}

.stitle {
  text-align: center;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  /* 上边由面板的 16 内距承担，这里只补下方 8 */
  padding: 0 0 var(--sp-8);
}

.group {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  padding: var(--sp-8) var(--pad-row) var(--sp-4);
}

.item.tall {
  /* 与 ActionSheet 的 .opt 同一档：行高 48 / 圆角 20 / 文字 Medium */
  min-height: var(--row-h);
  border-radius: var(--radius-l);
  font-weight: var(--fw-medium);
}

.item.cancel {
  /* 取消与选项是两组按钮 → 8 */
  margin-top: var(--gap-sm);
  border-top: 0.5px solid var(--line);
}

/* bind 面板进出：自锚点角缩放浮现；退出更快 */
.am-pop-enter-active {
  transition:
    transform 200ms var(--ease-standard),
    opacity 150ms var(--ease-standard);
}

.am-pop-leave-active {
  transition:
    transform 120ms var(--ease-standard),
    opacity 120ms var(--ease-standard);
}

.am-pop-enter-from,
.am-pop-leave-to {
  transform: scale(0.92);
  opacity: 0;
}

/* ---------- 丰富档 · bind 面板：透镜式展开 ----------
   苹果那条「菜单从触发它的按钮位置气泡般展开」：从贴住的那个角**扩一个圆**，
   而不是整体缩放 + 淡入。缩放会把面板里的文字一起压扁（读起来像"糊了一下"），
   圆形揭示只换"看得见多少"，内容从头到尾都是清的。

   用 clip-path 而不是动画化 mask-image：后者在 Chromium 里是**离散**属性，
   只能硬切；clip-path 是同形状之间插值，走的是合成器。
   ⚠️ clip-path + overflow 会让它成为后代的 backdrop root —— 面板本身是不透明的
   `--surface`，里面没有 backdrop-filter，所以这条在这里不构成问题。

   160% 的分母是「参考半径」= 对角线/√2，这里给 200% 是因为**投影也在裁剪范围内**：
   圆必须盖过面板本体 + 那一圈 --shadow-float 的扩散，否则展开到一半会看到投影被削掉。 */
html[data-motion='rich'] .panel {
  clip-path: circle(200% at var(--ox, 0%) var(--oy, 0%));
}

html[data-motion='rich'] .am-pop-enter-active {
  transition: clip-path var(--dur-base) var(--ease-liquid);
}

html[data-motion='rich'] .am-pop-leave-active {
  transition: clip-path var(--dur-fast) var(--ease-standard);
}

html[data-motion='rich'] .am-pop-enter-from,
html[data-motion='rich'] .am-pop-leave-to {
  transform: none;
  opacity: 1;
  clip-path: circle(0px at var(--ox, 0%) var(--oy, 0%));
}

.am-mask-enter-active,
.am-mask-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.am-mask-enter-from,
.am-mask-leave-to {
  opacity: 0;
}

/* 丰富档：dialog 模式的遮罩改成透镜式显现（与 SheetModal / ActionSheet 同一套） */
html[data-motion='rich'] .mask {
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

html[data-motion='rich'] .am-mask-enter-active,
html[data-motion='rich'] .am-mask-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    backdrop-filter var(--dur-base) var(--ease-out);
}

html[data-motion='rich'] .am-mask-enter-from,
html[data-motion='rich'] .am-mask-leave-to {
  backdrop-filter: blur(0);
  -webkit-backdrop-filter: blur(0);
}

.am-card-enter-active {
  transition:
    transform var(--dur-sheet) var(--ease-sheet),
    opacity var(--dur-sheet) var(--ease-sheet);
}

.am-card-leave-active {
  transition:
    transform 200ms var(--ease-standard),
    opacity 200ms var(--ease-standard);
}

.am-card-enter-from,
.am-card-leave-to {
  transform: translate(-50%, 24px);
  opacity: 0;
}
</style>
