<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Check, SlidersHorizontal, Undo2 } from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import { useNavDrag } from '@/composables/useNavDrag'
import { useNavEdit } from '@/composables/useNavEdit'
import { useToast } from '@/composables/useToast'
import type { TopbarAction } from '@/plugins/types'
import { useNavLayoutStore, type NavEntry } from '@/stores/navLayout'
import { usePomodoroStore } from '@/stores/pomodoro'
import { openView as openVoiceView } from '@/system/voiceRuntime'
import { recorder, startRecording, stopRecording } from '@/system/recorderRuntime'

/**
 * 桌面顶栏「功能按钮」区（容器三，docs/nav-redesign.md §7）。
 *
 * 内容全部来自「注册表 + 用户布局」：渲染清单是 `navLayout.items('topbar')`（编辑态以
 * 草稿为准），本组件里**没有一份业务清单** —— 按钮由各插件经 `PluginSpec.topbar` 声明
 * （纯数据：id/label/icon/动作名），动作由这里的 ACTIONS 表映射到既有 store / runtime
 * 方法（与 HomeFooter 的 ACTIONS/runTool 同一模式：插件声明「做什么」，宿主实现「怎么做」）。
 * 用户可决定留哪些、留多少、什么顺序：编辑交互（±徽标 / 拖拽 / 候选下拉 / 放弃变更 /
 * 保存布局）全部复用 useNavEdit + useNavDrag 共享层，与移动 Dock、桌面左栏同一套。
 *
 * 泄漏防线（§7.3，勘察风险第一条）：本组件**只**作为 AppTitleBar 的插槽内容存在 ——
 * TitleBarBase 本体与 base.css 公共段零改动，浮窗 FloatTitleBar 直接用 TitleBarBase、
 * 不经 AppTitleBar，插槽内容不共享就绝不泄漏；窄 Tauri 窗（430 sticky 玻璃带）由
 * AppTitleBar 的 isDesktop 门让本组件根本不渲染；浏览器桌面不渲染 AppTitleBar ——
 * 顶栏按钮是 Tauri 桌面（≥900）专属，其余形态由 rail 与 ⌘K 兜住。
 */
const router = useRouter()
const { toast } = useToast()
const pomo = usePomodoroStore()
const navLayout = useNavLayoutStore()

const { editing, activeScope, draft, enter, addToDraft, removeFromDraft, moveInDraft, discard, save } =
  useNavEdit('topbar')

/** 全局是否处于任一编辑态：别的容器编辑时，顶栏按钮区浮在 mask 之上（标题栏被 App.vue
 *  提权到 z46）却不属于编辑面 —— 挂 inert 封死（连焦点一起封，光 pointer-events 挡不住 Tab）。 */
const anyEditing = computed(() => activeScope.value !== null)

/* ---------- 渲染清单：非编辑态 = 布局 ∩ 目录 ∩ 启用态；编辑态以草稿为准（live reorder 可见） ---------- */

const entries = computed(() => navLayout.items('topbar'))

/** 目录条目速查（items ∪ candidates）：草稿里可能出现刚加回的候选，两处并起来才查得全 */
const entryById = computed(() => {
  const m = new Map<string, NavEntry>()
  for (const it of entries.value) m.set(it.id, it)
  for (const c of navLayout.candidates('topbar')) m.set(c.id, c)
  return m
})

const shown = computed<NavEntry[]>(() => {
  const ids = draft.value
  if (!editing.value || ids === null) return entries.value
  return ids.map((id) => entryById.value.get(id)).filter((e): e is NavEntry => e !== undefined)
})

/* ---------- 宿主持有动作表：映射到既有 store / runtime，不为按钮新写业务逻辑 ---------- */

const ACTIONS: Record<TopbarAction, () => void> = {
  'focus-toggle': () => {
    // 与 FocusFloatBar 的 toggleRun 同一语义：跑着即暂停，暂停/空闲则起跑 ——
    // start() 幂等且能从暂停续跑，一处语义不必第二份口径
    if (pomo.running) pomo.pause()
    else pomo.start()
  },
  'record-toggle': () => {
    if (recorder.status === 'recording') {
      stopRecording()
      return
    }
    void startRecording().then((ok) => {
      if (!ok) toast(recorder.lastError || '无法开始录音')
    })
  },
  'voice-session': () => {
    // 与 HomeFooter 的 ACTIONS['voice-session'] 各自持有（模式代价，§7.2）：
    // 未配置豆包语音服务时引导去模型页
    void openVoiceView().then((ok) => {
      if (!ok) {
        toast('先在「管理模型」里配置豆包语音服务')
        void router.push('/ai/models')
      }
    })
  },
}

function run(e: NavEntry): void {
  // 编辑态整格点击 = 撤回：「−」徽标是 aria-hidden 的装饰，键盘 Enter / 读屏激活落在
  // 整格上 —— 与 rail / dock 的整格语义同一套（共享层同一套交互）；拖拽松手的幽灵
  // click 由 useNavDrag 的吞窗兜住，两件事分开。非编辑态 = 动作 / 跳转。
  // （顶栏无固定件，撤回不存在拒绝分支。）
  if (editing.value) {
    removeFromDraft(e.id)
    return
  }
  if (e.action) {
    ACTIONS[e.action]()
    return
  }
  if (e.to) void router.push(e.to)
}

/* ---------- 编辑态：±徽标 / 拖拽 / 候选下拉 / 两颗退出钮 ---------- */

const rowEl = ref<HTMLElement | null>(null)

const drag = useNavDrag({
  listEl: rowEl,
  orderIds: () => draft.value ?? [],
  move: (id, to) => moveInDraft(id, to),
  snapshot: () => draft.value?.slice() ?? [],
  restore: (ids) => {
    // Esc / pointercancel 取消拖拽：草稿回滚到按下前（内存态，从未落盘）
    if (draft.value !== null) draft.value = ids
  },
})

function onEntryDown(e: PointerEvent, id: string): void {
  // 把手只在编辑态绑定语义：非编辑态 pointerdown 放行给标题栏的拖拽判定
  if (editing.value) drag.onHandleDown(e, id)
}

/**
 * 候选下拉（编辑态常开，AppMenu locked 旁路全部四条关闭路径 —— 编辑态退出只有
 * 放弃/保存两条路）。「＋」走 MenuItem.badge 徽标位（§6.1/§8.3 的 data-nav-badge
 * 靶，与 Dock 托盘 / rail 菜单同一枚圆），文案保持纯标签。
 *
 * 候选的口径：**目录全集 − 草稿**。navLayout.candidates() 读的是存储布局（草稿不进
 * 它的账），从未编辑过的会话里它恒为空 —— 但编辑态的「当前布局」是草稿（useNavEdit
 * 不变量：容器编辑态视图以草稿为准），「−」撤回的条目必须立刻在候选里接得住，
 * 「+/−」才是闭环。目录全集 = items ∪ candidates（顶栏无固定件，两处并起来就是
 * 启用条目的全量），容器侧减去草稿即得候选；保存后语义与 candidates() 逐条一致。
 *
 * 数据形态：一颗 **reactive 稳定数组**。AppMenu 的 bind 面板在 open 翻转时只快照
 * actions 的**引用**（levels[0].items）—— 引用不变、内容原地增删，经同一代理仍会
 * 触发面板重渲染，会话中途「＋」加回后面板当场收窄，不必重开。
 */
const candList = reactive<MenuItem[]>([])

watch([editing, draft, entryById], () => {
  if (!editing.value) {
    candList.length = 0
    return
  }
  const inDraft = new Set(draft.value ?? [])
  const wanted = [...entryById.value.values()]
    .filter((e) => !inDraft.has(e.id))
    .map((c) => ({ label: c.label, value: c.id, icon: c.icon, badge: '+' as const }))
  candList.splice(0, candList.length, ...wanted)
})

const menuOpen = computed(() => editing.value && candList.length > 0)

/** 下拉锚点：尾部控制簇（编辑钮 ↔ 放弃/保存 原位替换，簇本身恒在）——标题栏在顶部，面板向下弹 */
const tailEl = ref<HTMLElement | null>(null)
</script>

<template>
  <div ref="rowEl" class="tb-actions" :class="{ editing }" :inert="anyEditing && !editing">
    <button
      v-for="e in shown"
      :key="e.id"
      type="button"
      class="wbtn tb-btn"
      :data-nav-id="e.id"
      :title="editing ? `从顶栏移除『${e.label}』` : e.label"
      :aria-label="editing ? `从顶栏移除『${e.label}』` : e.label"
      @mousedown.stop
      @dblclick.stop
      @pointerdown="onEntryDown($event, e.id)"
      @click="run(e)"
    >
      <component :is="e.icon" :size="15" :stroke-width="2" />
      <!-- 「−」徽标（编辑态专属，撤回候选）：pointerdown.stop 防止按钮的拖拽把手
           setPointerCapture 把指针捕获走（捕获后 click 落在按钮上，徽标就点不着了） -->
      <span
        v-if="editing"
        class="badge"
        data-nav-badge="-"
        aria-hidden="true"
        @pointerdown.stop
        @click.stop="removeFromDraft(e.id)"
      >−</span>
    </button>

    <!-- 尾部控制簇：非编辑态一颗「编辑」入口；编辑态原位替换为「放弃变更 / 保存布局」
         两颗（规格原文：只有这两颗能退出编辑态）。窗控三钮的 stops 同款 ——
         按钮不触发窗口拖动，双击按钮不是双击标题栏。 -->
    <span ref="tailEl" class="tail">
      <template v-if="editing">
        <button
          type="button"
          class="wbtn"
          aria-label="放弃变更"
          title="放弃变更"
          @mousedown.stop
          @dblclick.stop
          @click="discard"
        >
          <Undo2 :size="15" :stroke-width="2" />
        </button>
        <button
          type="button"
          class="wbtn wbtn-save"
          aria-label="保存布局"
          title="保存布局"
          @mousedown.stop
          @dblclick.stop
          @click="save"
        >
          <Check :size="15" :stroke-width="2" />
        </button>
      </template>
      <button
        v-else
        type="button"
        class="wbtn"
        aria-label="编辑顶栏按钮"
        title="编辑顶栏按钮"
        @mousedown.stop
        @dblclick.stop
        @click="enter"
      >
        <SlidersHorizontal :size="15" :stroke-width="2" />
      </button>
    </span>

    <!-- 候选下拉（编辑态常开）：Teleport 到 body（z 115+），浮在 mask 与标题栏之上 -->
    <AppMenu
      :open="menuOpen"
      :actions="candList"
      :anchor="tailEl"
      title="加回顶栏按钮"
      locked
      @select="addToDraft"
    />
  </div>
</template>

<style scoped>
/* 按钮行：与品牌字标之间留一档呼吸（TitleBarBase 的 .tb-left 没有列间距）；
   行内间距与 .tb-right 的窗控组同档（--gap-tight），两排按钮读起来是同一套语言 */
.tb-actions {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  margin-left: var(--sp-12);
}

/* 徽标的定位宿主；.wbtn 的其余外观全在 base.css（与窗控三钮逐像素同一套） */
.tb-btn {
  position: relative;
}

/* 编辑态：按钮行是拖拽面 —— touch-action:none 只在编辑态挂（useNavDrag 契约 #2：
   base.css 给文档滚动层的全局手势是 pan-x pan-y，不前置这条，指针事件会被滚动链
   接管成 pointercancel，安卓上拖拽永不触发）；非编辑态不碰手势链 */
.tb-actions.editing {
  touch-action: none;
}

/* 「−」徽标：绝对定位在按钮右上角的小圆。只在编辑态渲染（临时态控件，不进
   ARCHITECTURE §5 的预算名单）；配色与 danger-soft/strong 的既有令牌对 */
.badge {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: var(--fw-bold);
  line-height: 1;
  background: var(--danger-soft);
  color: var(--danger-strong);
}

/* 尾部控制簇：编辑钮 ↔ 放弃/保存 的原位替换容器（也是候选下拉的锚点） */
.tail {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
}

/* 保存布局给一点正向提示（accent 当文字色）：不加新底色，形态与窗控钮同一套 */
.wbtn-save {
  color: var(--accent);
}
</style>
