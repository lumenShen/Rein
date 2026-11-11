<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'

import TabBar from '@/components/layout/TabBar.vue'
import CommandPalette from '@/components/layout/CommandPalette.vue'
import DesktopRail from '@/components/layout/DesktopRail.vue'
import DesktopInspector from '@/components/layout/DesktopInspector.vue'
import AppTitleBar from '@/components/layout/AppTitleBar.vue'
import WindowResizeHandles from '@/components/layout/WindowResizeHandles.vue'
import ActiveWorkoutBar from '@/components/exercise/ActiveWorkoutBar.vue'
import FocusFloatBar from '@/components/pomodoro/FocusFloatBar.vue'
import FocusImmersive from '@/components/pomodoro/FocusImmersive.vue'
import FocusNoticeBar from '@/components/pomodoro/FocusNoticeBar.vue'
import RecordFloatBar from '@/components/record/RecordFloatBar.vue'
import GrabFloatBar from '@/components/campus/GrabFloatBar.vue'
import VoiceSessionView from '@/components/voice/VoiceSessionView.vue'
import VoiceFloatBar from '@/components/voice/VoiceFloatBar.vue'
import SessionOverlay from '@/components/exercise/SessionOverlay.vue'
import UpdatePrompt from '@/components/update/UpdatePrompt.vue'
import GatewayAuthSheet from '@/components/settings/GatewayAuthSheet.vue'
import ToolConfirmSheet from '@/components/settings/ToolConfirmSheet.vue'
import ToastHost from '@/components/common/ToastHost.vue'
import NavEditMask from '@/components/common/NavEditMask.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useNavEdit } from '@/composables/useNavEdit'
import { DESKTOP_MIN } from '@/config/domain'
import { toneForRoute } from '@/config/tones'
import { campusService } from '@/services/campusService'
import { gatewayService } from '@/services/gatewayService'
import { recorder, stopRecording } from '@/system/recorderRuntime'
import { finishSpeaking, isLive as voiceIsLive } from '@/system/voiceRuntime'
import { inspectorOpen, rememberRoute, toggleInspector } from '@/system/deskShell'
import { isTauriDesktopWindow } from '@/system/windowChrome'
import { useFeaturesStore } from '@/stores/features'
import { useUpdateStore } from '@/stores/update'
import { useCourseSelectStore } from '@/stores/courseSelect'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
/** 浏览器里的壳分界：视口 ≥ DESKTOP_MIN 走桌面视图。桌面 Tauri 窗口不看它（见 deskShell）。 */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

/**
 * 壳层选择（2026-11 起：**桌面端只允许桌面视图**）：
 *   · 桌面 Tauri 窗口 —— 恒为三窗格壳（导航轨 + 主人区 + 信息栏），「窄窗回退底部
 *     TabBar」的路径整体退役（.win-shell--narrow 已删）。窗口 minWidth(900) 只是常态
 *     保障：系统把窗口压得更窄（小屏 / RDP 会话夹到屏幕尺寸）时壳也不换，桌面视图
 *     在最差宽度下自行收口。
 *   · 浏览器 —— 仍按宽度响应（e2e 的窄视口手机壳 / 宽屏桌面壳断言都靠它）；
 *   · Android —— 恒为移动壳（TabBar）。 */
const deskShell = computed(() => isTauriDesktopWindow || isDesktop.value)

/**
 * 桌面内容形态，由路由 meta.desk 声明（缺省 'grid'）：
 *   · 'grid' —— 卡片流页面：内容区按 --desk-content 收口，页面根铺两栏栅格，
 *               卡片自然摊开（设置、营养、专注这类「一叠卡」的页面都归这里）；
 *   · 'wide' —— 看板 / 画布 / 长表格 / 对话：内容自己撑满主人区，
 *               由页面决定内部怎么分栏。
 * 放在路由表而不是页面里：这是**壳层**的构图决策，导航轨与信息栏都跟着它变，
 * 页面只负责在给定宽度里把内容排好。 */
const deskWide = computed(() => route.meta.desk === 'wide')

/**
 * 桌面键盘层：⌘K 命令面板、⌘1–4 一级页、⌘I 信息栏。
 *
 * 为什么由壳层统一收：快捷键**不能分布在各页**（同一组合在两个页面里含义不同，
 * 用户就再也不敢按）；而这些都是「壳层的动作」—— 换页、开关窗格、叫出面板。
 * 页面自己的键位仍留在页面里（如 Esc 关抽屉），壳层只认这一组不冲突的。
 *
 * 挂载条件见下方 `hasKeyboard`：按设备能力（有精确指针/实体键盘）挂，
 * 与窗口宽度无关 —— 窄窗口的桌面用户同样要能键盘导航。
 *
 * 输入焦点要排除：在输入框 / 文本域 / contenteditable 里按 ⌘1 应该照常输入，
 * 只有 ⌘K 与 ⌘I 这类带修饰键、输入法不会吃掉的组合才允许穿透。
 */
const paletteOpen = ref(false)

/* ---------------- 导航编辑态 · 壳层侧守卫 ----------------
 *
 * 三个导航容器（移动 Dock / 桌面左栏 / 桌面顶栏）的编辑会话是全局单例
 * （composables/useNavEdit.ts），壳层在这里只做三件事：
 *  · 读全局 activeScope 给 mask 与 inert 账（模板绑定见下方）；
 *  · 键盘守卫：编辑态里 ⌘1-4 / ⌘K / ⌘I 一律忽略 —— 页面在 mask 底下飞走，草稿就悬空了；
 *  · 壳翻转 / 沉浸页切入时统一 discard() —— 草稿只在内存，半成品永远到不了 localStorage。
 * 指针路径不在这里堵：由模板上的 inert 账封死（被遮主内容根与非编辑面浮层），
 * 历史导航（浏览器返回 / Alt+Left）是已知边界 —— 会话跨路由存活，不为它拦 popstate。 */
const { activeScope: navEditScope, discard: discardNavEdit } = useNavEdit()
const navEditAnyEditing = computed(() => navEditScope.value !== null)

const deskKeys: Record<string, string> = {
  '1': 'home',
  '2': 'sports',
  '3': 'ai',
  '4': 'me',
}

function onDeskKey(e: KeyboardEvent): void {
  // 导航编辑态守卫：只堵键盘快捷键（指针路径由 inert 账封死）
  if (navEditScope.value !== null) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
    return
  }
  if (mod && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    toggleInspector()
    return
  }
  if (e.key === 'Escape' && paletteOpen.value) {
    e.preventDefault()
    paletteOpen.value = false
    return
  }
  if (!mod || e.altKey) return
  const target = e.target as HTMLElement | null
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
  if (typing) return
  const name = deskKeys[e.key]
  if (name) {
    e.preventDefault()
    void router.push({ name })
  }
}

/** 最近访问：命令面板的「最近」组靠它。名字而已，不存数据。 */
watch(
  () => route.name,
  (n) => {
    if (deskShell.value && typeof n === 'string') rememberRoute(n)
  },
)

/** 全屏形态：fullscreen 路由（跑步）或训练课沉浸层打开——隐藏壳导航与悬浮条 */
const shellVisible = computed(() => route.meta.fullscreen !== true)

/* ---------------- 参数错误 → 立刻交给 AI 补救 ----------------
 *
 * 教务说「参数错误」就是**这条请求的写法不对**：重试一万次也是同一个结果，
 * 而且每次都在用错的参数骚扰教务。引擎那边会停下来把任务标成 `needs_ai`
 * （见 grab.rs 的 `absorb_error`），这里负责**立刻把现场递给 AI**：
 * 用户要的是「放着不管它也有人在救」，而不是「先弹个提示等我来点」。
 *
 * 放在 App 层而不是抢课页里：用户可能已经翻去别的页面了，救援不该挑页面。
 * 每条任务只自动递一次（AI 那边可能有来回，不能反复把人拽走），之后
 * 面板上仍有「交给 AI 排查」的手动入口。
 *
 * **整个 watcher 受抢课开关管**：模块关着的时候任务根本不会推进，
 * 更不该把用户拽去 AI 页。
 *
 * 救援模块**按需 import**：`utils/campusAi` 认识 `stores/ai`，而 `stores/ai` 拖进来的是
 * 整个 AI 工具栈（工具注册表 + 全部工具域，约 200 KB）。App 是每个路由的父级，
 * 这里静态 import 一句就等于把 AI 栈钉进启动主包 —— 与文档「AI 层不静态进主包」相悖。
 * 这条分支只在教务真的拒了请求时才走到，按需加载不亏任何一次首屏。
 */
const courseSelect = useCourseSelectStore()
const features = useFeaturesStore()
/** 抢课模块是否开着（课表的子模块，默认关闭） */
const grabOn = computed(() => features.isEnabled('campus-grab'))
/** 语音会话浮层 / 转写浮条、录音浮条：各自听自己的模块开关（关掉就不该有任何常驻 UI） */
const voiceOn = computed(() => features.isEnabled('voice'))
const recordOn = computed(() => features.isEnabled('record'))
/** 专注浮条 / 相位提示条：番茄钟计时切页后仍在跑，常态要看得见 —— 关掉专注则整条收起 */
const focusOn = computed(() => features.isEnabled('focus'))
const toast = useToast()
const aiHandedOff = new Set<number>()
watch(
  () => courseSelect.grabTasks.map((t) => `${t.id}:${t.status}`).join(','),
  () => {
    if (!grabOn.value) return
    const bad = courseSelect.rejectedTasks.filter((t) => !aiHandedOff.has(t.id))
    if (!bad.length) return
    for (const t of bad) aiHandedOff.add(t.id)
    const first = bad[0]!
    // 现场先快照，再异步加载救援模块（理由见下方 import 注释）
    const scene = courseSelect.grab
    void import('@/utils/campusAi').then(({ askAiForGrabRescue }) => askAiForGrabRescue(scene))
    // 先给结论的短句：ToastHost 超宽会从尾部截断，技术原因（参数错误）不占这条的额度 ——
    // 它收在抢课页标题行右侧的帮助入口里（GrabFloatBar 侧），这里只保证「已交给 AI」读得到
    toast.toast(
      `抢课请求被教务拒绝，已交给 AI 排查：${first.courseName ?? first.lessonName ?? '这门课'}`,
    )
  },
)

/**
 * 把抢课开关同步给 Rust 引擎。三个时机都要做，缺一个就会出现
 * 「界面关了、引擎还在跑」这种最糟的不一致：
 * 1. 启动时（引擎自己也会从 `app_meta` 读，这里是双保险 + 覆盖热重载）；
 * 2. 开关被拨动时（含在设置页里拨）；
 * 3. 父模块「课表」被关掉时 —— 子模块随之失效，引擎也必须停。
 */
watch(
  grabOn,
  (on) => {
    void campusService.grabSetEnabled(on).catch(() => {
      /* 引擎开关同步失败不该弹错：下次拨动或重启会再同步一次 */
    })
  },
  { immediate: true },
)

/**
 * 把「已启用的功能模块」同步给对外服务网关（contract §4.7）。
 *
 * 网关的 28 条对外方法里，14 条属运动、6 条属专注、2 条属健康方案、1 条属课表 —— 用户
 * 关掉其中任一模块后，这些方法一律回 `module_disabled`。理由与上面抢课那条同源：
 * **只关 UI 等于没关**（`pomodoro.start` 足以驱动一个前端已经不显示的计时器）。
 *
 * 三个时机：启动（快照必须先于任何外部连接存在）、开关拨动、以及父模块被关掉带动子模块
 * 失效 —— 后两者不必分别处理，`activePlugins` 已经把「父关子关」的继承判定算进去了。
 */
const enabledModuleIds = computed(() => features.activePlugins.map((p) => p.id))
watch(
  enabledModuleIds,
  (ids) => {
    void gatewayService.setEnabledModules(ids).catch(() => {
      /* 推失败不弹错：下次拨动或重启会再推一次（缺快照的语义是「全部放行」） */
    })
  },
  { immediate: true },
)

/**
 * 关掉模块时必须**收手**正在跑的那个会话，而不是只把界面藏起来。
 *
 * 语音会话浮层、转写浮条、录音浮条都是 `v-if` 挂的：会话进行中去关掉模块，UI 会整个消失，
 * 而 `voiceRuntime` / `recorderRuntime` 还在采 —— 麦克风占着，界面上已经没有能停它的按钮
 * （待办抽屉里那枚录音钮也随模块一起收起），用户只能重启应用。
 *
 * 两条都按「不丢数据」收尾，与「关闭只影响入口与路由、不删任何数据」同一条纪律：
 *  - 语音：走 `finishSpeaking()` 正常结算（纪要照常落库）。**不用** `cancelSession()` ——
 *    那会丢掉刚说完的转写，而用户关模块的意思不是「这段不要了」；
 *  - 录音：走 `stopRecording()`，take 留在内存列表里，模块再打开就看得见（不 cancel）。
 */
watch(voiceOn, (on) => {
  if (on || !voiceIsLive()) return
  void finishSpeaking().catch(() => {
    /* 收尾失败不改状态：转写逐句落过草稿，下次进语音还能捞回来 */
  })
})
watch(recordOn, (on) => {
  if (!on && recorder.status === 'recording') stopRecording()
})

/**
 * 启动静默检查更新：只在「开关开着 + 距上次检查超过间隔」时真的联网，
 * 有新版本就弹一张明确的更新卡片（立即更新 / 稍后 / 跳过此版本）。
 * 刻意不阻塞任何首屏渲染：慢网络下最坏的结果只是卡片晚几秒出现。
 */
const updatePrompt = ref(false)

/**
 * 桌面键盘层（⌘K 命令面板、⌘1–4 一级页、⌘I 信息栏）的挂载条件是**设备能力**，
 * 不是窗口宽度：`hover: hover and pointer: fine` = 有实体键盘/精确指针的设备。
 *
 * 为什么与 deskShell 解耦：三窗格壳（desk-frame）的渲染是**布局**决策（桌面恒开、
 * 浏览器跟宽度）；快捷键是**输入能力**决策，跟着设备走。从前监听器跟着壳走，
 * 于是窄窗口的桌面用户（分屏、半宽、外接显示器上把窗口拉窄）完全没有键盘导航。
 * 触屏（hover: none）依旧不挂监听，与从前一样纯手势操作。
 */
const hasKeyboard = useMediaQuery('(hover: hover) and (pointer: fine)')

watch(
  hasKeyboard,
  (on) => {
    if (on) window.addEventListener('keydown', onDeskKey)
    else window.removeEventListener('keydown', onDeskKey)
  },
  { immediate: true },
)

/* 壳层形态写到 <html> 上：**teleport 到 body 的元素（悬浮钮 / 悬浮条 / 提示条）
   不在 .desk-main 里**，它们既用不了 .desk-main 那条祖先规则，也读不到
   「现在是不是桌面」。写一个属性出去，这些游离子孙就能各自适配 —
   与 data-perf / data-motion / data-immersive 同一条做法。 */
watch(
  deskShell,
  (on) => {
    document.documentElement.dataset.shell = on ? 'desk' : 'mobile'
  },
  { immediate: true },
)

/* 导航编辑态 · 壳翻转收场：桌面 ↔ 移动壳切换会让编辑容器（rail / dock / 顶栏）整个消失，
   沉浸页（shellVisible=false）同理 —— rail / dock 都藏着，没有编辑面可回。
   草稿只在内存（useNavEdit 不变量），discard 即回滚，半成品永远到不了 localStorage。
   （桌面 Tauri 壳恒定不再翻转，这条 watch 实际只在浏览器里随宽度越线触发。） */
watch(deskShell, () => discardNavEdit())
watch(shellVisible, (on) => {
  if (!on) discardNavEdit()
})

/* 信息栏的开合也写到 <html>：理由同上 —— 靠右缘定位的游离子孙要跟着让位 */
watch(inspectorOpen, (v) => {
  document.documentElement.dataset.inspector = v ? 'on' : 'off'
}, { immediate: true })

/* 当前页的模块色调写到 <html>（与 data-shell / data-inspector 同一条做法）：
   页内的页头、按钮与 **teleport 到 body 的弹层** 都要读同一个 --accent；
   只包 RouterView 的话，弹层会停在品牌蓝，同一页里两种主色。 */
watch(
  () => route.name,
  (name) => {
    const tone = toneForRoute(name)
    if (tone) document.documentElement.dataset.tone = tone
    else delete document.documentElement.dataset.tone
  },
  { immediate: true },
)

onBeforeUnmount(() => window.removeEventListener('keydown', onDeskKey))

onMounted(() => {
  const update = useUpdateStore()
  void (async () => {
    await update.load()
    if (await update.autoCheckIfDue()) updatePrompt.value = true
  })()
})
</script>

<template>
  <!-- 桌面 Tauri：无边框窗口的整窗壳（自绘标题栏 + 内容区，恒为 .win-shell--desk 竖排）。
       浏览器 / Android 上这一层只是一个没有样式的普通 div —— .desk-frame / .app-frame
       仍按 deskShell 的规则决定布局（浏览器按宽度），既有 e2e 的布局断言不受影响。 -->
  <div class="win-shell" :class="{ 'win-shell--desk': isTauriDesktopWindow }">
    <!-- 标题栏不画底，让环境光一直透到窗口顶边（窄窗玻璃带模型已随「桌面端只允许
         桌面视图」退役）。
         nav-edit-live（仅 .win-shell--desk 段生效）：导航编辑态把标题栏提权到 mask(45)
         之上 —— 窗控三钮恒可点，rail 编辑时窗口不能被编辑态卡死。顶栏功能按钮区
         是否可交互由 TopbarActions 自读 useNavEdit（仅 activeScope==='topbar'）。 -->
    <AppTitleBar
      v-if="isTauriDesktopWindow"
      :class="{ 'nav-edit-live': navEditAnyEditing }"
    />
    <div class="win-body">
      <!-- 桌面三窗格壳：沉浸页（运动模式）同样隐藏导航轨。
           导航编辑态的 inert 账（遮罩只挡指针不挡焦点，inert 连焦点一起封）：
           · rail 仅在自己是 activeScope 时可交互 —— topbar 编辑时它浮在 mask 上且处于
             正常态，RouterLink / 命令面板 / 全部菜单 hover 全是鼠标路径的路由出口，必须封；
           · 主内容根（.desk-main / DesktopInspector）任何编辑态都封 —— mask 底下的页面
             不许 Tab 进去、Enter 触发链接、切路由。 -->
      <div v-if="deskShell" class="desk-frame">
        <DesktopRail
          v-show="shellVisible"
          data-immersive-shell
          :inert="navEditAnyEditing && navEditScope !== 'rail'"
          :inspector-open="inspectorOpen"
          @toggle-inspector="toggleInspector"
          @open-palette="paletteOpen = true"
        />
        <main class="desk-main" :class="{ wide: deskWide }" :inert="navEditAnyEditing">
          <!-- 整页包装：平时只是路由出口的壳。页面自己挂了内容层（.page > .rubber-layer）
               时超伸平移落在那一层上（system/rubberScroll 的 layerFor 会下钻找到它）；
               只有没挂内容层的页面才回退到整页平移（那时标题栏会跟着动）。 -->
          <div data-rubber-shell>
            <RouterView v-slot="{ Component }">
              <Transition name="page">
                <component :is="Component" />
              </Transition>
            </RouterView>
          </div>
        </main>
        <!-- 第三窗格 · 路由上下文信息栏：全页面常驻（沉浸页除外、可 ⌘I 收起），
             保证桌面构图平衡；窄桌面下用户也可以把它让给主内容 -->
        <DesktopInspector v-show="shellVisible && inspectorOpen" data-immersive-shell :inert="navEditAnyEditing" />
      </div>

      <!-- 移动端（原结构）：内容居中窄栏 + 底部标签导航 -->
      <div v-else class="app-frame">
        <!-- 整页包装（= 页面级超伸的兜底层）：页面自己挂了内容层时只动内容层，
             标题栏留在层外不动；没挂内容层的旧页面才整页平移。
             导航编辑态把内容层封掉（与桌面的 .desk-main 同一条 inert 账） -->
        <div data-rubber-shell :inert="navEditAnyEditing">
          <RouterView v-slot="{ Component }">
            <Transition name="page">
              <component :is="Component" />
            </Transition>
          </RouterView>
        </div>
        <TabBar
          v-show="shellVisible"
          data-immersive-shell
          :inert="navEditAnyEditing && navEditScope !== 'tabbar'"
        />
      </div>
    </div>
    <!-- 无边框窗口的八向缩放热区（只在桌面 Tauri）：原生边框随 decorations:false 一起
         消失，不补这一层窗口就再也改不了大小；最大化时组件自己隐藏。 -->
    <WindowResizeHandles v-if="isTauriDesktopWindow" />
  </div>
  <!-- 导航编辑态遮罩（z 45）：三个导航容器（Dock / 左栏 / 顶栏）共用一枚 —— 盖谁不盖谁
       由 z-index 与上面的 inert 账表达，遮罩自身不做判定。吞点击但永不据此退出：
       退出只有「放弃变更 / 保存布局」两条路。进出淡入淡出写在 .scrim-edit-* 下方。 -->
  <Transition name="scrim-edit">
    <NavEditMask v-if="navEditAnyEditing" />
  </Transition>
  <!-- 悬浮运动条：收起完成后才恢复，自身按停靠方向渐入。
       四条常驻浮条（含下面三条）与相位提示条都不属于任何编辑面，却可点、可触发路由
       或沉浸层 —— 导航编辑态统一挂 inert 封死（属性透传到各自根元素）。 -->
  <ActiveWorkoutBar :inert="navEditAnyEditing" />
  <!-- 录音悬浮条：录音进行中常驻（可拖拽停靠，轻点进录音页）。受录音模块开关管 -->
  <RecordFloatBar v-if="recordOn" v-show="shellVisible" data-immersive-shell :inert="navEditAnyEditing" />
  <!-- 专注悬浮条：番茄钟进行中 / 暂停态常驻（受专注模块开关管）。为什么专注走**底部活动族**
      而不是像抢课那样上移：抢课是「监视器」（抬头看一眼，顶部更合直觉），专注是「活动」——
       与运动、录音一样是「我此刻正在做一件事」的计时，天然与运动互斥（练时不会开番茄），
       同族还共用 useDragDock 的停靠手感与 glass-surface 材质，用户不必为它记第二套交互。 -->
  <FocusFloatBar v-if="focusOn" v-show="shellVisible" data-immersive-shell :inert="navEditAnyEditing" />
  <!-- 专注沉浸层：常驻挂载（不走路由），显隐由 system/focusImmersive 的层级驱动（level 0 隐藏）。
       它是全屏层、盖住壳层，与专注浮条同随专注模块开关收放 —— 关掉专注就不该有这一层。 -->
  <FocusImmersive v-if="focusOn" />
  <!-- 专注相位提示条：只在相位切换的系统通知**没送达**时顶部落一条（常驻送达条） -->
  <FocusNoticeBar v-if="focusOn" :inert="navEditAnyEditing" />
  <!-- 语音转写悬浮条：语音会话收起后台转写继续（与录音浮条同套停靠、独立 key）。受语音模块开关管 -->
  <VoiceFloatBar v-if="voiceOn" v-show="shellVisible" data-immersive-shell :inert="navEditAnyEditing" />
  <!-- 抢课监视器：后台引擎有活儿时顶部落一条，点进选课页（顶部定位，不与底部三条浮条抢位）。
       受模块开关管：关掉抢课（默认关）就不该有任何常驻 UI。 -->
  <GrabFloatBar v-if="grabOn" v-show="shellVisible" data-immersive-shell :inert="navEditAnyEditing" />
  <!-- 语音会话视图：单例 runtime 驱动，任何入口可唤起（voiceRuntime.openView） -->
  <VoiceSessionView v-if="voiceOn" />
  <!-- 训练课沉浸层：常驻挂载不走路由（system/sessionImmersive 驱动显隐与形变） -->
  <SessionOverlay />
  <!-- 命令面板（⌘K）：跟着**设备能力**挂（hasKeyboard），不是跟着桌面壳 ——
       它是键盘入口，触屏上没有对应手势。原先跟 isDesktop 走，于是 800–1099 的桌面用户
       （分屏 / 半宽窗口）里，导航轨的搜索钮不渲染（DesktopRail 只在桌面壳里）、
       面板也没挂：⌘K 完全没有入口。壳层是布局、快捷键是输入能力，两者该分开。 -->
  <CommandPalette v-if="hasKeyboard" :open="paletteOpen" @close="paletteOpen = false" />
  <!-- 启动检查到新版本时的更新卡片（立即更新 / 稍后 / 跳过此版本） -->
  <UpdatePrompt :open="updatePrompt" @close="updatePrompt = false" />
  <!-- 外部程序授权弹窗：单例 runtime 驱动，任何外部连接请求进来都由它唤起（system/externalAccessRuntime） -->
  <GatewayAuthSheet />
  <!-- 危险工具确认层：单例队列驱动，写操作（日历/通讯录/短信/通知/文件/终端）执行前弹一次 -->
  <ToolConfirmSheet />
  <ToastHost />
</template>

<style scoped>
.app-frame {
  position: relative;
  max-width: var(--frame-max);
  min-height: 100dvh;
  margin: 0 auto;
  /* 避开手机状态栏/刘海；环境光是这一栏自己的 ::before 固定层（base.css「环境光」段），
     内容从它上面滚过去 —— 它不铺到窗口两侧去 */
  padding-top: var(--safe-top);
}

/* 桌面壳：导航轨 + 主人区 */
.desk-frame {
  display: flex;
  height: 100dvh;
  overflow: hidden;
}

/* ---------- 桌面 Tauri · 窗口壳 ----------
   桌面端只允许桌面视图（deskShell 平台锁定）：整窗竖排，标题栏占顶部一条、.win-body
   吃剩余高度。桌面三窗格本来就滚在 .desk-main 内部，整窗不产生文档滚动，标题栏天然在
   滚动容器之外。旧的窄窗 sticky 段（.win-shell--narrow）已随「窄窗回退 TabBar」一起
   退役 —— 无边框窗口在 Tauri 侧恒为宽窗模型，宽度地板由 minWidth(900) 保障。 */
.win-shell--desk {
  height: 100dvh;
  display: flex;
  flex-direction: column;
}

.win-shell--desk > .win-body {
  flex: 1;
  min-height: 0;
}

.win-shell--desk .desk-frame {
  height: 100%;
}

/* ---------- 导航编辑态 · 标题栏提权 ----------
   宽窗的标题栏在静态流里（z auto），会被编辑态遮罩（z 45）盖住 —— 提权到 46，
   窗控三钮恒可点（编辑态卡死窗口是事故级体验）。所有 scope 都提权（rail 编辑时
   窗控也要可点）；顶栏功能按钮区是否可交互由 TopbarActions 自读 useNavEdit。
   写 position:relative 而不是动 .titlebar 的定位：定位语义只归本段所有，别的段
   （浮窗 / 页面内吸顶）各写各的，互不抢 position。
   :deep 把 scoped 属性锚在 .win-shell--desk（App 自己的元素）上，titlebar 是
   孙组件（AppTitleBar → TitleBarBase）的根，深选择器与隔壁窄窗规则同一写法。
   这条样式写在 App.vue（挂载点拥有者），不进 AppTitleBar / TitleBarBase ——
   TitleBarBase 与浮窗标题栏（FloatTitleBar）共享，按钮区不能泄漏进浮窗。 */
.win-shell--desk :deep(.titlebar.nav-edit-live) {
  position: relative;
  z-index: 46;
}

/* 编辑态遮罩的进出：--dur-fast / --ease-standard（遮罩本体只管那层底色）。
   类挂的是 NavEditMask 的根元素 —— 子组件根会带上父组件的 scoped 属性 */
.scrim-edit-enter-active,
.scrim-edit-leave-active {
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.scrim-edit-enter-from,
.scrim-edit-leave-to {
  opacity: 0;
}

.desk-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  /* 桌面下的横向留白与页头遮罩宽度：页面里那句 var(--page-pad-x) 会自己跟上，
     所以各页不必为桌面再写一遍 padding。
     取 --desk-gutter（PC 档 40）：从前这个令牌是 34 的手感值，整条桌面的内容
     左右边距都比规范少 6，页头标题与卡片左缘也一起偏出去半格。 */
  --page-pad-x: var(--desk-gutter);
  --ph-bleed: var(--desk-gutter);
}

/* ---------- 桌面内容画布 · 卡片流（meta.desk = 'grid'，缺省） ----------
   移动端那套「一列窄栏居中」在桌面上会留下两侧各 300px 的空白，读起来像没做完。
   这里把页面根直接铺成两栏栅格：**通栏是缺省、卡片是半栏**——
   因为页面里除卡片之外的东西（页头、看板、通栏列表、提示条）本来就该占满一行，
   而 .card 正是「可以并排的一块」，这样一个规则就让二十来个卡片页在桌面上自动成形，
   不需要每页各写一遍媒体查询。只有真正需要另一种构图的页面才去加 d-full / d-split。

   **列数由宽度自己算**（auto-fit + 360px 下限），不写死两栏：
   · 1512 的 --desk-content 经两页内边距后是 972px → 仍然是两栏（479px/栏），
     与从前 repeat(2, 1fr) 逐像素一致；
   · 900–1163 这一段如果用户把信息栏展开（⌘I），主人区掉到 538–802px ——
     两栏会把每张卡挤成 228–328px（比手机卡还窄），auto-fit 自动退回单栏；
   · 360px 是「这张卡还读得下去」的下限（题、副标、右上角两颗按钮不打架），
     不是审美偏好：再窄就该整行，而不是把卡片压扁。 */
.desk-main:not(.wide) :deep(.page) {
  max-width: var(--desk-content);
  margin: 0 auto;
  /* 32 + 页头自己的 8 = 40：PC 档的页面顶部留白（--page-pad-top 的桌面档）。
     从前两处一个 26 一个 8，加起来 34 比规范少 6，桌面页头整体偏上。 */
  padding-top: var(--sp-32);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--desk-gap);
  /* stretch：同行两卡高度对齐（矮卡填满格子），灰底画布不再从卡下漏出；
     align-content: start：内容不满一屏时多余高度留在底部，而不是被分到行间
     （不然短页面会在标题和第一张卡之间凭空多出一条大空档）。 */
  align-items: stretch;
  align-content: start;
}

/* 子项怎么摆**不在这里定**：整行 / 半栏的缺省与 d-* 工具的优先级必须在同一份
   样式表里排序才说得清（见 base.css「桌面工作台 · 栅格」）——分成两个文件写，
   工具类的特指度就会被这里的 :deep 组合压掉，页面作者加了 class 却不生效。
   这里只负责 .page 这个盒子本身。 */

/* ---------- 桌面内容画布 · 宽形态（meta.desk = 'wide'） ----------
   宽形态**不写任何 .page 规则**：上面那条栅格只在 :not(.wide) 时命中，
   所以标了 wide 的页面拿到的就是自己原来的盒模型（AI 页的整帧 flex、待办页的
   一天画布都靠这个），桌面改动完全落在页面自己的 scoped 样式里。
   这样壳层与页面之间只有一条契约：「wide = 主人区整宽，构图你自己负责」，
   不会出现壳层用 max-width 压住页面自己那条 max-width 的级联扯皮。 */

/* 主人区里的页面画布按 --desk-wide 收口（宽形态页面的通行做法） */
.desk-main.wide :deep(.page) {
  margin-inline: auto;
}

/* 页面切换：新页淡入衔接，旧页同步让位——不做 out-in 空屏，也不做旧页淡出 */
.page-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.page-enter-from {
  opacity: 0;
}

/* 离场瞬时移除：淡出会与入场抢同一段视觉，读起来像两次变化 */
.page-leave-active {
  transition: none;
}
</style>
