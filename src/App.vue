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
import ToastHost from '@/components/common/ToastHost.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
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
/** 桌面工作台：视口 ≥ DESKTOP_MIN 时以三窗格壳（导航轨 + 主人区 + 右侧信息栏）替代底部 TabBar */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

/**
 * 桌面 Tauri 的两种窗口壳（浏览器 / Android 两个都不挂，DOM 与布局维持原样）：
 *  · 宽窗（≥ DESK_MIN）→ .win-shell--desk：整窗竖排，内容滚在 .desk-main 里；
 *  · 窄窗（无边框窗口的默认 430 宽）→ .win-shell--narrow：**文档滚动模型不变**，
 *    只把标题栏 sticky 在顶上。
 * 为什么要分开：rubberScroll / useScrolled / ActiveWorkoutBar 都是按「文档滚动」写的
 * （document.scrollingElement / window 的 scroll 事件）。无边框只该去掉系统标题栏，
 * 不该顺手把窄窗的滚动容器从 document 换成某个内层 div —— 那会静默打断超范围回弹、
 * 页头的滚动态与运动条跟滚。 */
const deskChrome = computed(() => isTauriDesktopWindow && isDesktop.value)
const narrowChrome = computed(() => isTauriDesktopWindow && !isDesktop.value)

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

const deskKeys: Record<string, string> = {
  '1': 'home',
  '2': 'sports',
  '3': 'ai',
  '4': 'me',
}

function onDeskKey(e: KeyboardEvent): void {
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
    if (isDesktop.value && typeof n === 'string') rememberRoute(n)
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
 * 为什么与 isDesktop 解耦：三窗格壳（desk-frame）与 ⌘K 面板的渲染是**布局**决策，
 * 跟着宽度走；快捷键是**输入能力**决策，跟着设备走。从前监听器跟着 isDesktop 走，
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
  isDesktop,
  (on) => {
    document.documentElement.dataset.shell = on ? 'desk' : 'mobile'
  },
  { immediate: true },
)

/* 信息栏的开合也写到 <html>：理由同上 —— 靠右缘定位的游离子孙要跟着让位 */
watch(inspectorOpen, (v) => {
  document.documentElement.dataset.inspector = v ? 'on' : 'off'
}, { immediate: true })

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
  <!-- 桌面 Tauri：无边框窗口的整窗壳（自绘标题栏 + 内容区；宽窗竖排、窄窗标题栏 sticky）。
       浏览器 / Android 上这一层只是一个没有样式的普通 div —— .desk-frame / .app-frame
       仍按原来的规则决定布局，既有 e2e 的布局断言（430 手机壳 / 宽屏桌面壳）不受影响。 -->
  <div class="win-shell" :class="{ 'win-shell--desk': deskChrome, 'win-shell--narrow': narrowChrome }">
    <!-- 窄窗里标题栏是一条玻璃带（内容从它底下滚过，与导航层同一套材质；低画质档
         会自动退化成实底，不用另写）。宽窗不画底，让环境光一直透到窗口顶边。 -->
    <AppTitleBar
      v-if="isTauriDesktopWindow"
      :class="{ 'glass-surface': narrowChrome, 'glass-edge-b': narrowChrome }"
    />
    <div class="win-body">
      <!-- 桌面三窗格壳：沉浸页（运动模式）同样隐藏导航轨 -->
      <div v-if="isDesktop" class="desk-frame">
        <DesktopRail
          v-show="shellVisible"
          data-immersive-shell
          :inspector-open="inspectorOpen"
          @toggle-inspector="toggleInspector"
          @open-palette="paletteOpen = true"
        />
        <main class="desk-main" :class="{ wide: deskWide }">
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
        <DesktopInspector v-show="shellVisible && inspectorOpen" data-immersive-shell />
      </div>

      <!-- 移动端（原结构）：内容居中窄栏 + 底部标签导航 -->
      <div v-else class="app-frame">
        <!-- 整页包装（= 页面级超伸的兜底层）：页面自己挂了内容层时只动内容层，
             标题栏留在层外不动；没挂内容层的旧页面才整页平移 -->
        <div data-rubber-shell>
          <RouterView v-slot="{ Component }">
            <Transition name="page">
              <component :is="Component" />
            </Transition>
          </RouterView>
        </div>
        <TabBar
          v-show="shellVisible"
          data-immersive-shell
        />
      </div>
    </div>
    <!-- 无边框窗口的八向缩放热区（只在桌面 Tauri）：原生边框随 decorations:false 一起
         消失，不补这一层窗口就再也改不了大小；最大化时组件自己隐藏。 -->
    <WindowResizeHandles v-if="isTauriDesktopWindow" />
  </div>
  <!-- 悬浮运动条：收起完成后才恢复，自身按停靠方向渐入 -->
  <ActiveWorkoutBar />
  <!-- 录音悬浮条：录音进行中常驻（可拖拽停靠，轻点进录音页）。受录音模块开关管 -->
  <RecordFloatBar v-if="recordOn" v-show="shellVisible" data-immersive-shell />
  <!-- 专注悬浮条：番茄钟进行中 / 暂停态常驻（受专注模块开关管）。为什么专注走**底部活动族**
      而不是像抢课那样上移：抢课是「监视器」（抬头看一眼，顶部更合直觉），专注是「活动」——
       与运动、录音一样是「我此刻正在做一件事」的计时，天然与运动互斥（练时不会开番茄），
       同族还共用 useDragDock 的停靠手感与 glass-surface 材质，用户不必为它记第二套交互。 -->
  <FocusFloatBar v-if="focusOn" v-show="shellVisible" data-immersive-shell />
  <!-- 专注沉浸层：常驻挂载（不走路由），显隐由 system/focusImmersive 的层级驱动（level 0 隐藏）。
       它是全屏层、盖住壳层，与专注浮条同随专注模块开关收放 —— 关掉专注就不该有这一层。 -->
  <FocusImmersive v-if="focusOn" />
  <!-- 专注相位提示条：只在相位切换的系统通知**没送达**时顶部落一条（常驻送达条） -->
  <FocusNoticeBar v-if="focusOn" />
  <!-- 语音转写悬浮条：语音会话收起后台转写继续（与录音浮条同套停靠、独立 key）。受语音模块开关管 -->
  <VoiceFloatBar v-if="voiceOn" v-show="shellVisible" data-immersive-shell />
  <!-- 抢课监视器：后台引擎有活儿时顶部落一条，点进选课页（顶部定位，不与底部三条浮条抢位）。
       受模块开关管：关掉抢课（默认关）就不该有任何常驻 UI。 -->
  <GrabFloatBar v-if="grabOn" v-show="shellVisible" data-immersive-shell />
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

/* ---------- 桌面 Tauri · 两种窗口壳 ----------
   宽窗（≥ DESK_MIN）：整窗竖排，标题栏占顶部一条、.win-body 吃剩余高度。桌面三窗格
   本来就滚在 .desk-main 内部，整窗不产生文档滚动，标题栏天然在滚动容器之外。

   窄窗（无边框窗口的默认 430 宽）：**保持文档滚动不变** —— .app-frame 仍是普通流内块、
   滚的仍是 document。只让标题栏 position: sticky 粘在视口顶，内容从它底下穿过。
   （试过把 .win-body 当滚动容器：rubberScroll 的 document.scrollingElement 判定、
   useScrolled 的滚动目标、ActiveWorkoutBar 的 activeScroller() 全都按文档滚动写，
   换容器等于静默关掉超范围回弹、页头滚动态与运动条跟滚 —— 无边框不该动滚动模型。） */
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

.win-shell--narrow {
  display: block;
}

/* 标题栏粘在视口顶：z-index 50 —— 低于底部 Dock / TabBar（60），高于页面里那层
   吸顶页头（30），于是内容滚过去时永远被标题栏压住。 */
.win-shell--narrow :deep(.titlebar) {
  position: sticky;
  top: 0;
  z-index: 50;
}

/* 40px 的标题栏要从内容高度里还回去：.app-frame 继续用 100dvh 会凭空多出一条 40px
   的文档滚动（滚到底时底部 Dock 上方多出一截空白）。 */
.win-shell--narrow .app-frame {
  min-height: calc(100dvh - var(--titlebar-h));
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
