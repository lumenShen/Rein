<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import {
  Apple,
  ArrowRight,
  BookOpen,
  CalendarDays,
  ChartPie,
  Cloud,
  Download,
  Dumbbell,
  Footprints,
  GraduationCap,
  House,
  ListTodo,
  Mic,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Target,
  Timer,
  Wallet,
} from 'lucide-vue-next'

import { routeOwner } from '@/plugins'
import { routes } from '@/router'
import { useDockStore } from '@/stores/dock'
import { useFeaturesStore } from '@/stores/features'
import { usePomodoroStore } from '@/stores/pomodoro'
import { MOD, rememberRoute, recentRoutes, toggleInspector } from '@/system/deskShell'

/**
 * 桌面命令面板（⌘K）。
 *
 * 为什么这个东西值得做：这个应用的页面数量已经到三十多个、动作散在十几个页面里，
 * 而桌面上「找东西」的成本全落在鼠标路径上 —— 从导航轨点到二级页、再找到那个按钮。
 * Linear / Raycast / Notion / Superhuman 这一代桌面工具的共识是**键盘是主入口**：
 * 一个 ⌘K 把「去哪」和「做什么」合成同一个入口，用户不必先记住信息架构。
 *
 * 三条自我约束：
 *   ① 它只**跳转与触发**，不复制任何业务逻辑 —— 每个命令就是一次 router.push 或
 *      一个已经在别处存在的方法调用；
 *   ② 不静态引入重模块（AI 栈 / campus 服务）：面板在桌面常驻挂载，import 什么
 *      就等于把什么钉进主包。这里只读路由表与功能开关；
 *   ③ 中文标签按**子串**匹配（不做拼音），命中的关键词写在 keywords 里 ——
 *      与其上模糊算法，不如把「大家会怎么叫它」写清楚（如「课表 / 课程表 / 上课」）。
 */

interface Cmd {
  id: string
  group: string
  label: string
  sub?: string
  /** 键盘快捷键提示（右对齐的小胶囊） */
  keys?: string
  keywords?: string
  icon: Component
  run: () => void
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const features = useFeaturesStore()
const dock = useDockStore()
const pomo = usePomodoroStore()

/* ---------- 主入口快捷键（与 App.vue 的全局监听共用一份声明） ---------- */
const PRIMARY: { name: string; keys: string }[] = [
  { name: 'home', keys: MOD + '1' },
  { name: 'sports', keys: MOD + '2' },
  { name: 'ai', keys: MOD + '3' },
  { name: 'me', keys: MOD + '4' },
]
const primaryKeys = new Map(PRIMARY.map((p) => [p.name, p.keys]))

/** 路径 → 分组名。分组是给人读的（「运动」「课表」），不是路由前缀的复述。 */
function groupOf(path: string): string {
  if (path === '/') return '今天'
  if (path.startsWith('/sports') || path.startsWith('/session')) return '运动'
  if (path.startsWith('/ai')) return 'AI'
  if (path.startsWith('/nutrition')) return '营养'
  if (path.startsWith('/campus')) return '课表'
  if (path.startsWith('/ledger')) return '记账'
  if (path.startsWith('/settings') || path === '/me') return '设置'
  if (path.startsWith('/program')) return '健康方案'
  return '今天'
}

function iconOf(path: string): Component {
  if (path === '/') return House
  if (path.startsWith('/sports/plans')) return ListTodo
  if (path.startsWith('/sports/exercises')) return Dumbbell
  if (path.startsWith('/sports/records')) return ChartPie
  if (path.startsWith('/sports')) return Footprints
  if (path.startsWith('/ai/knowledge')) return BookOpen
  if (path.startsWith('/ai')) return Sparkles
  if (path.startsWith('/nutrition')) return Apple
  if (path.startsWith('/campus')) return GraduationCap
  if (path.startsWith('/ledger')) return Wallet
  if (path.startsWith('/settings')) return Settings2
  if (path.startsWith('/program')) return Target
  if (path.startsWith('/focus')) return Timer
  if (path.startsWith('/record')) return Mic
  if (path.startsWith('/todos')) return ListTodo
  return House
}

/**
 * 路由表读成统一形状：`routes` 是 `as const` 的元组，每条的 meta 各不相同
 * （有的只有 tab、有的只有 title、有的带 fullscreen）—— 面板只关心这四项，
 * 在这里收口一次，比在每个 filter 里反复收窄类型清楚。
 */
interface RouteLike {
  name?: unknown
  path: string
  meta?: { title?: string; tab?: string; fullscreen?: boolean }
}

const routeTable = routes as unknown as RouteLike[]

/** 路由表 → 页面命令。过滤掉：沉浸页（不该出现在跳转里）、被关掉的模块、别名页。 */
const routeCmds = computed<Cmd[]>(() =>
  routeTable
    .filter((r) => r.meta?.fullscreen !== true)
    .filter((r) => String(r.name ?? '') !== 'ai-knowledge-files')
    .filter((r) => {
      const owner = routeOwner(String(r.name ?? ''))
      return !owner || features.isEnabled(owner.id)
    })
    .map((r) => {
      const name = String(r.name ?? '')
      const title = String(r.meta?.title ?? r.meta?.tab ?? name)
      return {
        id: 'route:' + name,
        group: groupOf(r.path),
        label: title,
        keys: primaryKeys.get(name),
        icon: iconOf(r.path),
        run: () => void router.push({ name }),
      }
    }),
)

/** 全局动作：只放「确实有一个已经存在的落点」的几条，不自创业务逻辑。
 *  落在某个功能模块里的一律按模块开关过滤 —— 面板与入口的可见性必须同源，
 *  否则会出现「关了营养，⌘K 里还留一条『记饮食』」（路由守卫只管路由，管不到这里）。 */
const actionCmds = computed<Cmd[]>(() => {
  const base: Cmd[] = [
    { id: 'act:ai', group: '动作', label: '问 AI 一句话', sub: '打开对话', icon: Sparkles, run: () => void router.push({ name: 'ai' }) },
  ]
  if (features.isEnabled('nutrition')) {
    base.push({ id: 'act:food', group: '动作', label: '记饮食', sub: '营养全览', icon: Apple, run: () => void router.push({ name: 'nutrition' }) })
  }
  if (features.isEnabled('ledger')) {
    base.push({ id: 'act:ledger', group: '动作', label: '记一笔账', sub: '记账', icon: Wallet, run: () => void router.push({ name: 'ledger' }) })
  }
  base.push({ id: 'act:todo', group: '动作', label: '添加待办', sub: '全部待办', keywords: '任务 todo', icon: ListTodo, run: () => void router.push({ name: 'todos' }) })
  if (features.isEnabled('focus')) {
    // 文案与行为一致：这条是「开始专注」就必须真的起跑（从前只 push 到 /focus，label 虚报）。
    // start() 幂等 —— 已在跑时再选它等于只跳转过去看计时，不会重开一轮。
    base.push({
      id: 'act:focus',
      group: '动作',
      label: '开始专注',
      sub: `番茄钟 · ${pomo.settings.focusMin} 分钟`,
      keywords: '番茄 pomodoro',
      icon: Timer,
      run: () => {
        pomo.start()
        void router.push({ name: 'focus' })
      },
    })
    // 只有真有一轮在进行中时才给「结束」——没有在跑的计时，这条会是一条骗人的命令
    if (pomo.active) {
      base.push({ id: 'act:focus-end', group: '动作', label: '结束本轮专注', sub: '保存这一轮', keywords: '番茄 pomodoro 结束', icon: Square, run: () => void pomo.endRound() })
    }
  }
  base.push(
    { id: 'act:inspector', group: '动作', label: '显示 / 隐藏信息栏', sub: '右侧面板', keys: MOD + 'I', icon: SlidersHorizontal, run: () => toggleInspector() },
    { id: 'act:features', group: '动作', label: '打开或关闭功能', sub: '功能模块开关', icon: SlidersHorizontal, run: () => void router.push({ name: 'settings-features' }) },
    { id: 'act:update', group: '动作', label: '检查软件更新', sub: '版本与更新通道', icon: Download, run: () => void router.push({ name: 'settings-update' }) },
  )
  if (features.isEnabled('sync')) {
    base.push({ id: 'act:sync', group: '动作', label: '多设备同步', sub: '同一网段直连', icon: Cloud, run: () => void router.push({ name: 'settings-sync' }) })
  }
  if (features.isEnabled('campus')) {
    base.push({ id: 'act:schedule', group: '动作', label: '打开我的课表', sub: '本周课程', keywords: '课程表 上课', icon: CalendarDays, run: () => void router.push({ name: 'campus-schedule' }) })
  }
  return base
})

/* ---------- 底栏左键落点 ----------
   Dock 左键那颗独立圆钮的「换落点」原先只有长按一条路（TabBar 的长按选择器）：
   键盘用户碰都碰不到。这里把同一份候选摊成命令 —— 候选规则与 TabBar 的
   candidates / pickerActions 逐条同源（导航轨条目减掉 Dock 三块玻璃上已有的落点），
   动作只是 dock.setLeftRoute，业务仍然只此一处。
   三个内核落点写死在这里：命令面板本来就只读路由表与功能开关（见文件头约束②），
   为它把 TabBar 那棵树玻璃组件静态拖进主包不划算。 */
const DOCK_SLOT_ROUTES = ['home', 'me', 'ai']

const dockCandidates = computed(() => {
  const taken = new Set([...DOCK_SLOT_ROUTES, ...features.nav('tabbar').map((n) => n.route)])
  return features.nav('rail').filter((n) => !taken.has(n.route))
})

/** 落点偏好走 localStorage，改了立刻对 Dock 生效；带「当前落点」副标省得猜现在指向哪 */
const dockCmds = computed<Cmd[]>(() =>
  dockCandidates.value.map((c) => ({
    id: 'dock:' + c.route,
    group: '底栏',
    label: `底栏左键改为「${c.label}」`,
    sub: dock.leftRoute === c.route ? '当前落点' : undefined,
    keywords: 'dock 底栏 左键 导航 落点',
    icon: c.icon,
    run: () => dock.setLeftRoute(c.route),
  })),
)

/* ---------- 过滤与分组 ---------- */
const q = ref('')

const all = computed<Cmd[]>(() => {
  const byName = new Map(routeCmds.value.map((c) => [c.id.slice(6), c]))
  const current = 'route:' + String(router.currentRoute.value.name ?? '')
  const recentNames = new Set(recentRoutes.value)
  /* 最近组已把这条路由搬到最上面，原分组里那一份要去掉：同一屏出现两遍会让人
     以为有两处入口，上下键还要多走一格。位置更靠上、语义更明的「最近」那份留。 */
  const recent: Cmd[] = recentRoutes.value
    .map((n) => byName.get(n))
    .filter((c): c is Cmd => Boolean(c) && c!.id !== current)
    .map((c) => ({ ...c, group: '最近' }))
  return [
    ...recent,
    ...actionCmds.value,
    ...dockCmds.value,
    ...routeCmds.value.filter((c) => !recentNames.has(c.id.slice(6))),
  ]
})

const results = computed<Cmd[]>(() => {
  const needle = q.value.trim().toLowerCase()
  if (!needle) {
    // 无输入：最近 + 动作置顶，页面按分组铺开（这是「打开就能用」的状态）
    return all.value
  }
  return all.value.filter((c) =>
    (c.label + ' ' + (c.sub ?? '') + ' ' + (c.keywords ?? '') + ' ' + c.id).toLowerCase().includes(needle),
  )
})

/** 按分组切段（顺序沿用命令数组本身的顺序，最近 / 动作天然在前） */
const grouped = computed<{ name: string; items: Cmd[] }[]>(() => {
  const out: { name: string; items: Cmd[] }[] = []
  const seen = new Map<string, Cmd[]>()
  for (const c of results.value) {
    const bucket = seen.get(c.group)
    if (bucket) bucket.push(c)
    else {
      const list = [c]
      seen.set(c.group, list)
      out.push({ name: c.group, items: list })
    }
  }
  return out
})

/** 展平后的顺序 = 上下键的行走顺序 */
const flat = computed<Cmd[]>(() => grouped.value.flatMap((g) => g.items))

const active = ref(0)
watch(results, () => {
  active.value = 0
})

/** 打开时把应用根置为 inert：面板是模态的（role=dialog + aria-modal），
    Tab 不该跑到背后的导航轨/页面上。只作用在 #app 子树 —— 面板 teleport 到 body，
    在它外面，所以面板自己（连同遮罩）不受影响。 */
function setAppInert(on: boolean): void {
  const app = document.getElementById('app')
  if (!app) return
  if (on) app.setAttribute('inert', '')
  else app.removeAttribute('inert')
}

/** 面板打开前的焦点所在：关闭时还回去，键盘用户的「来路」不被抹掉 */
let focusBefore: HTMLElement | null = null

/** 打开时清空上一次的输入：面板每次进来都该是「干净的一屏」；
    关闭时**必须**摘掉 inert —— 残留会把整个界面锁死（点不动、也聚焦不了）。 */
watch(
  () => props.open,
  (v) => {
    if (!v) {
      setAppInert(false)
      if (focusBefore?.isConnected) focusBefore.focus()
      focusBefore = null
      return
    }
    q.value = ''
    active.value = 0
    focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setAppInert(true)
    void nextTick(() => inputEl.value?.focus())
  },
)

const inputEl = ref<HTMLInputElement | null>(null)

/* 组件自己被卸载（设备能力变化 → App 的 v-if 收掉面板）时也要摘 inert：
   残留的 inert 与「关闭时忘摘」同罪，都会把整个界面锁死。 */
onBeforeUnmount(() => setAppInert(false))

function move(delta: number): void {
  const n = flat.value.length
  if (!n) return
  active.value = (active.value + delta + n) % n
  void nextTick(() => {
    document.getElementById('cmd-row-' + active.value)?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * 跑一条命令：记来路 → 执行 → 收面板。**行点击与回车共用这一条路** ——
 * 从前行按钮绑的是 runActive()，而 active 是「鼠标移过哪行」的独立状态：
 * 触屏 / 快速点击时 pointermove 可能还没落到被点的那行，于是点 A 跑了 B
 * （点「记账」跳去「专注」）。谁被点就由谁自己带着命令进来，不再走指针状态。
 */
function run(cmd: Cmd): void {
  const name = String(router.currentRoute.value.name ?? '')
  if (cmd.id.startsWith('route:')) rememberRoute(cmd.id.slice(6))
  else if (name) rememberRoute(name)
  cmd.run()
  emit('close')
}

/** 回车：跑键盘选中的那一条 */
function runActive(): void {
  const cmd = flat.value[active.value]
  if (cmd) run(cmd)
}

/** 当前页面对应的命令下标（面板打开时默认落在它身上，回车=回到当前页也没关系） */
/** 页脚只放行内无处承载的快捷键：⌘1–⌘4 / ⌘I 在结果行上、esc 在输入框右侧，
     屏上已经有键帽了，这里再列一遍只是白占两行高度。 */
const shortcutHints = [
  { keys: MOD + 'K', what: '打开命令面板' },
  { keys: '↑ ↓', what: '在结果间移动' },
  { keys: '↵', what: '打开选中的一项' },
]
</script>

<template>
  <Teleport to="body">
    <Transition name="cmdk">
      <div v-if="open" class="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
        <!-- 遮罩：点空白关闭。桌面面板是要「随时能来、随时能走」的东西，
             所以除了 esc，点外面也必须能关（用户不该被迫去找关闭按钮）。 -->
        <div class="scrim" @pointerdown="emit('close')" />

        <div class="panel glass-surface">
          <label class="field row">
            <Search :size="17" class="t-3" />
            <input
              ref="inputEl"
              v-model="q"
              type="text"
              placeholder="搜索页面或动作…"
              aria-label="搜索命令"
              @keydown.down.prevent="move(1)"
              @keydown.up.prevent="move(-1)"
              @keydown.enter.prevent="runActive"
              @keydown.esc.prevent="emit('close')"
            />
            <kbd class="k">esc</kbd>
          </label>

          <div v-if="flat.length" class="list">
            <section v-for="g in grouped" :key="g.name" class="group">
              <h3 class="ghead">{{ g.name }}</h3>
              <button
                v-for="c in g.items"
                :id="'cmd-row-' + flat.indexOf(c)"
                :key="c.id"
                class="rowitem"
                :class="{ on: flat.indexOf(c) === active }"
                @pointermove="active = flat.indexOf(c)"
                @click="run(c)"
              >
                <component :is="c.icon" :size="16" class="ic" />
                <span class="label">{{ c.label }}</span>
                <span v-if="c.sub" class="sub">{{ c.sub }}</span>
                <kbd v-if="c.keys" class="k">{{ c.keys }}</kbd>
                <ArrowRight v-else :size="14" class="go" />
              </button>
            </section>
          </div>

          <!-- 空态也要给下一步：没有匹配时把可用的快捷键摊出来，
               而不是只说一句「什么都没找到」 -->
          <div v-else class="empty">
            <p class="empty-title">没有匹配「{{ q }}」的页面或动作</p>
            <p class="empty-hint">试试「课表」「记账」「专注」，或者直接用下面的快捷键</p>
          </div>

          <footer class="foot">
            <div class="hints">
              <span v-for="h in shortcutHints" :key="h.keys" class="hint">
                <kbd class="k">{{ h.keys }}</kbd>{{ h.what }}
              </span>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cmdk {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

.scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim);
}

/* 面板压在整页之上、背后有正文经过，所以用 .glass-surface（材质 + blur）而不是实底。
   它**不做折射**：640×480 已经是 30 万 px² 的大面积，折射预算只给离散小控件。 */
.panel {
  position: relative;
  /* 两侧各让 32（--sp-64）；12vh 是定位公式，不动 */
  width: min(640px, calc(100vw - var(--sp-64)));
  margin-top: 12vh;
  max-height: min(560px, 70vh);
  display: flex;
  flex-direction: column;
  /* 命令面板是一块顶层浮层 → 圆角 32（--radius-xl；桌面档由令牌降到 24） */
  border-radius: var(--radius-xl);
  overflow: hidden;
}

.field {
  flex: none;
  /* 图标 / 输入框 / 快捷键提示三组：12（--gap-md）；上下左右 16 与面板内距同线 */
  gap: var(--gap-md);
  padding: var(--sp-16);
  border-bottom: 0.5px solid var(--line);
}

.field input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-headline);
  font-weight: var(--fw-medium);
}

.field input::placeholder {
  color: var(--text-3);
}

/* 输入框是全屏面板里唯一的焦点，全局那条 2px 主色焦点环在这里只会框出一个蓝方块
   （面板本身就是「你正在输入」的状态）。键盘可达性不受影响：焦点环是**全局兜底**，
   这里只是不用它，esc 提示与光标位置仍然说明焦点在哪。 */
.field input:focus-visible {
  outline: none;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 上方 6 承接输入框那条分隔线的呼吸，下方 8 与左右 8 对称 */
  padding: var(--sp-6) var(--sp-8) var(--sp-8);
}

.ghead {
  /* 组标题是有信息的一行（「最近 / 页面 / 动作」）：--text-3 在这块玻璃上读不清，
     抬到 --text-2；左右内距与行的 10 对齐 */
  padding: var(--sp-12) var(--sp-10) var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.4px;
  color: var(--text-2);
}

/* 一行 = 图标 + 主标签 + 去向 + 快捷键。悬停与键盘选中**同一套视觉**：
   鼠标移过去与按方向键落上去不该长得不一样，否则两套焦点会互相打架。 */
.rowitem {
  display: flex;
  align-items: center;
  /* 图标与标签 12；行内距 8×10 —— 与信息栏的 .nav-row 同一档节奏 */
  gap: var(--gap-md);
  width: 100%;
  padding: var(--sp-8) var(--sp-10);
  /* 菜单行圆角 20（--radius-l），与 AppMenu / 操作面板同档 */
  border-radius: var(--radius-l);
  text-align: left;
}

.rowitem.on {
  background: var(--surface-2);
}

.ic {
  flex: none;
  color: var(--text-2);
}

.rowitem.on .ic {
  color: var(--accent);
}

/* 标签吃掉余量、副标贴着右侧的键帽：一行读下来是「做什么 …… 去哪 [⌘n]」。
   没有 :has() 兜底的分支 —— 这里只有一种排布，少一层条件少一处会漂的地方。 */
.label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub {
  flex: none;
  max-width: 45%;
  font-size: var(--fs-caption);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.go {
  flex: none;
  color: var(--text-3);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.rowitem.on .go {
  opacity: 1;
}

/* 键帽：面板里的快捷键提示与页脚共用一份（亮暗色都取中性底 + 描边）。
   nowrap 是必需的：Windows 上写的是「Ctrl+I」，换行会把它断成「Ctrl+ / I」。 */
.k {
  flex: none;
  white-space: nowrap;
  padding: var(--sp-2) var(--sp-6);
  border-radius: var(--radius-xs);
  border: 0.5px solid var(--line-strong);
  background: color-mix(in srgb, var(--text-1) 5%, transparent);
  font-family: inherit;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.empty {
  /* 空态：上下 28/32（30 吸附到 32），左右 20 */
  padding: var(--sp-28) var(--sp-20) var(--sp-32);
  text-align: center;
}

.empty-title {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.empty-hint {
  margin-top: var(--sp-6);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.foot {
  flex: none;
  border-top: 0.5px solid var(--line);
  /* 页脚：上下 8 / 左右 16（与面板内距同线，键帽提示不贴边） */
  padding: var(--sp-8) var(--sp-16);
  background: color-mix(in srgb, var(--surface) 40%, transparent);
}

.hints {
  display: flex;
  flex-wrap: wrap;
  /* 行间 8 / 列间 16：键帽提示是「一组一组」的，组内紧、组间松 */
  gap: var(--sp-8) var(--sp-16);
}

.hint {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 出场比入场快一点：面板是"随时能关"的东西，关闭不该有拖尾 */
.cmdk-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.cmdk-leave-active {
  transition: opacity 90ms var(--ease-standard);
}

.cmdk-enter-from,
.cmdk-leave-to {
  opacity: 0;
}

/* 面板自己不再播入场动画：⌘K 是每天上百次的键盘入口，遮罩 + 整层 150ms 淡入
   已经是全部反馈。原先是外层淡入、面板再淡入并位移一次 —— 两段叠成双重淡入，
   而键盘路径上这段位移毫无信息量，只会让⌘K 显慢。 */
</style>
