<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, Lock, LockOpen, Pause, Play, RotateCcw, RotateCw, X } from 'lucide-vue-next'

import RingProgress from '@/components/common/RingProgress.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { useToast } from '@/composables/useToast'
import {
  dismissForceHint,
  exitFocusImmersive,
  focusForced,
  focusForceHintDismissed,
  focusImmersiveLevel,
  setFocusForced,
  toggleDeeper,
} from '@/system/focusImmersive'

/**
 * 专注沉浸层（全屏）：App.vue 常驻挂载、按专注模块开关收放，由 system/focusImmersive
 * 的层级驱动显隐（0 普通 / 1 沉浸 / 2 完全沉浸）——与训练课沉浸层同一范式：不走路由、
 * 不卸载重建，显隐靠根节点的 v-show，换层级靠内部淡入淡出。
 *
 * 为什么单独立一层、而不是把专注页放大：沉浸的意义是**让壳层与全部悬浮件整体让位**。
 * 那份规则在 base.css（html[data-focus-immersive='on'] [data-immersive-shell]{opacity:0}），
 * focusImmersive.ts 已负责写这个属性。要让 TabBar / 导航轨 / 各浮条一起被盖住，本层必须
 * 游离在路由与壳层之外 —— 所以它挂在 App 根上，而不是某个页面里。
 *
 * 底走 var(--bg)：沉浸层不是「黑场」，而是同一片画布的放大 —— 亮色跟随亮色、暗色跟随暗色，
 * 与全应用一套主题，不为它多维护一支沉浸专属底色。
 */
const pomo = usePomodoroStore()
const todos = useTodoStore()
const { toast } = useToast()

/** 根节点显隐：level > 0 才出现（0 = 普通态，就是专注页里的卡片形态） */
const visible = computed(() => focusImmersiveLevel.value > 0)

/* ---------- 读数与环 ---------- */

/** 大读数三段：clockTime 恒为 "HH:MM:SS"，固定产出三段，模板直接按下标取用 */
const parts = computed<[string, string, string]>(() => {
  const [h = '00', m = '00', s = '00'] = pomo.clockTime.split(':')
  const tuple: [string, string, string] = [h, m, s]
  return tuple
})

/** 环上的说明：专注显第几颗番茄（今日已完成轮次 + 1），休息显「休息」 */
const capText = computed(() =>
  pomo.phase === 'focus' ? `第 ${pomo.completedRounds + 1} 颗番茄` : '休息',
)

/** 相位色：专注 --mod-focus-tone、休息 --cat-general。冒号与环共用它 —— 情绪色只在环与冒号上，
 * 数字保持中性（与浮条「色相只落状态点」同一条色彩纪律）。 */
const phaseColorVar = computed(() => (pomo.phase === 'focus' ? '--mod-focus-tone' : '--cat-general'))
/** 冒号染色：用行内 style 绑到相位色上，省去一份 phase-class 分支 */
const colonStyle = computed(() => ({ color: `var(${phaseColorVar.value})` }))

/** 视口尺寸：环直径 = min(70vw, 70vh)，须随窗口变化重算（RingProgress 收的是像素值） */
const vw = ref(window.innerWidth)
const vh = ref(window.innerHeight)
function onResize(): void {
  vw.value = window.innerWidth
  vh.value = window.innerHeight
}
const ringSize = computed(() => Math.round(Math.min(vw.value * 0.7, vh.value * 0.7)))
/** 环粗细：viewBox 是 0–100，故粗细全看这一个数；随直径走并留下限，免得小屏细成一根线 */
const ringStroke = computed(() => Math.max(5, Math.round(ringSize.value / 55)))

/* ---------- 关联待办（完全沉浸层底部唯一的一行字） ---------- */

/** 没有关联待办就什么都不挂：一条空标题比什么都不显示更吵 */
const linkedTitle = computed(
  () => todos.dayTodos.find((t) => t.id === pomo.linkedTodoId)?.title ?? null,
)

/* ---------- 控制 ---------- */

/** 暂停 / 继续：start() 幂等（已在跑就直接 return），暂停态再点即续走 */
function toggleRun(): void {
  if (pomo.running) pomo.pause()
  else pomo.start()
}

/** 提前结束本段：专注 → 记录并进休息；休息 → 跳过回专注（endPhase 自己分流） */
function endSeg(): void {
  void pomo.endPhase()
}

/**
 * 深入一层：level 1 ⇄ 2。
 * 加一道 350ms 冷却 —— level 2 用单击返回（触屏没有可靠的双击），而单击落在双击里会**各触发
 * 一次**：第一下让 level 2 消失、第二下落到刚复活的 level 1 又被判成双击，一来一回两下就把
 * 人送回了起点。冷却把这一对点击当成同一个意图（其中有一下只是双击的另一半）。
 */
let lastDeeper = 0
function deeper(): void {
  const now = performance.now()
  if (now - lastDeeper < 350) return
  lastDeeper = now
  toggleDeeper()
}

/* ---------- 🔒 强制模式 ---------- */

/** 说明条显隐：首次开启强制模式、且用户没选过「不再提醒」时弹一次 */
const forceSheetOpen = ref(false)

function toggleForced(): void {
  const next = !focusForced.value
  setFocusForced(next)
  if (next && !focusForceHintDismissed.value) forceSheetOpen.value = true
}

function dismissForce(): void {
  dismissForceHint()
  forceSheetOpen.value = false
}

/**
 * 触发条件：强制模式开着 + 正在跑 + 处于**专注**相位。
 * 暂停 / 休息相位不设防（可随意切换或关掉强制模式），与说明条那三句一致。
 */
const enforcing = computed(() => focusForced.value && pomo.running && pomo.phase === 'focus')

/** 事件已挂标记 + 已触发标记：visibilitychange 与 blur 常常前后脚一起来，只许结束一次 */
let enforcingAttached = false
let enforcingFired = false

function onVisibility(): void {
  if (document.hidden) forceEnd()
}

function forceEnd(): void {
  if (enforcingFired) return
  enforcingFired = true
  detachEnforcing() // 先摘监听：结束动作会改相位，别让第二个事件再进来
  void pomo.endPhase()
  toast('强制模式：离开前台，已结束本段专注')
}

function attachEnforcing(): void {
  if (enforcingAttached) return
  enforcingAttached = true
  enforcingFired = false
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('blur', forceEnd)
}

function detachEnforcing(): void {
  if (!enforcingAttached) return
  enforcingAttached = false
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('blur', forceEnd)
}

/** 反应式挂 / 摘监听：随相位、运行态、开关自动重算 */
watch(enforcing, (on) => (on ? attachEnforcing() : detachEnforcing()), { immediate: true })

onMounted(() => window.addEventListener('resize', onResize))

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  detachEnforcing()
})
</script>

<template>
  <section v-show="visible" class="fi" role="region" aria-label="专注沉浸模式">
    <!-- 层级 1 · 沉浸：进度环 + 大读数 + 贴边工具簇 -->
    <Transition name="fi">
      <div v-if="focusImmersiveLevel === 1" key="l1" class="l1">
        <!-- 左上：收起 / 退出（与参考设计同角的退出门） -->
        <button
          class="corner tl"
          type="button"
          aria-label="退出沉浸模式"
          @click="exitFocusImmersive()"
        >
          <ChevronDown :size="22" :stroke-width="2.4" />
        </button>
        <!-- 右上：🔒 强制模式开关。开时实底强调（图标与文案都不承担语义，故色只落在表面上） -->
        <button
          class="corner tr"
          type="button"
          :class="{ on: focusForced }"
          :aria-pressed="focusForced"
          :aria-label="focusForced ? '关闭强制模式' : '开启强制模式'"
          @click="toggleForced()"
        >
          <component :is="focusForced ? Lock : LockOpen" :size="20" :stroke-width="2.4" />
        </button>

        <!-- 双击环 / 读数（含其下的提示）深入一层 -->
        <div class="center" @dblclick="deeper()">
          <RingProgress
            :value="pomo.progress"
            :color-var="phaseColorVar"
            :size="ringSize"
            :stroke="ringStroke"
          >
            <span class="cap">{{ capText }}</span>
            <span class="clock">
              <span class="grp">{{ parts[0] }}</span>
              <span class="colon" :style="colonStyle">:</span>
              <span class="grp">{{ parts[1] }}</span>
              <span class="colon" :style="colonStyle">:</span>
              <span class="grp">{{ parts[2] }}</span>
            </span>
          </RingProgress>
          <p class="hint">继续双击时间，可切换到完全沉浸模式</p>
        </div>

        <!-- 贴左缘、垂直居中的控制簇（对应参考设计里那列贴边工具） -->
        <div class="cluster" role="toolbar" aria-label="专注控制">
          <button
            class="btn"
            type="button"
            :aria-label="pomo.running ? '暂停' : '继续'"
            @click="toggleRun()"
          >
            <component :is="pomo.running ? Pause : Play" :size="20" :stroke-width="2.4" />
          </button>
          <button class="btn" type="button" aria-label="回到本番茄钟初" @click="pomo.rewindPhase()">
            <RotateCcw :size="20" :stroke-width="2.4" />
          </button>
          <button class="btn" type="button" aria-label="结束本段" @click="endSeg()">
            <RotateCw :size="20" :stroke-width="2.4" />
          </button>
          <button class="btn" type="button" aria-label="退出沉浸模式" @click="exitFocusImmersive()">
            <X :size="20" :stroke-width="2.4" />
          </button>
        </div>
      </div>
    </Transition>

    <!-- 层级 2 · 完全沉浸：只剩超大读数（竖排 / 横排随屏幕方向），底部挂关联待办 -->
    <Transition name="fi">
      <div v-if="focusImmersiveLevel === 2" key="l2" class="l2" @click="deeper()">
        <div class="clock">
          <span class="grp">{{ parts[0] }}</span>
          <span class="colon" :style="colonStyle">:</span>
          <span class="grp">{{ parts[1] }}</span>
          <span class="colon" :style="colonStyle">:</span>
          <span class="grp">{{ parts[2] }}</span>
        </div>
        <!-- 没有关联待办时整行不渲染 -->
        <p v-if="linkedTitle" class="todo">{{ linkedTitle }}</p>
      </div>
    </Transition>

    <!-- 强制模式说明：首次开启时的一次性嘱咐。放在沉浸层**之上**的弹层里（见 z-index 说明） -->
    <SheetModal
      :open="forceSheetOpen"
      title="启动强制模式"
      initial-snap="medium"
      @close="forceSheetOpen = false"
    >
      <p class="sheet-copy">
        启动强制模式。在专注模式下改变窗口状态或者退出前台后，会强制结束番茄钟；在暂停或者休息模式中可以随意切换或关闭强制模式。（开启番茄钟锁机时，不会强制结束）
      </p>
      <template #footer>
        <div class="sheet-acts">
          <button class="primary" type="button" @click="forceSheetOpen = false">我知道了</button>
          <button class="ghost" type="button" @click="dismissForce()">不再提醒</button>
        </div>
      </template>
    </SheetModal>
  </section>
</template>

<style scoped>
.fi {
  position: fixed;
  inset: 0;
  /* 盖住全部悬浮件与提示条（专注提示条 78、抢课条 80、语音会话 65、底部 Dock 60），
     但**低于一切弹层**（SheetModal 90/100、ActionSheet 110/111、Toast 120）——
     强制模式说明条与 toast 这类二级层必须能压在沉浸层之上。85 正好卡在这两者之间。 */
  z-index: 85;
  background: var(--bg);
  color: var(--text-1);
  overflow: hidden;
  /* 安全区：本层铺满窗口，贴边控件要避开刘海 / 手势带 */
  /* 安全区外再留一格 12：贴边控件不压在刘海/手势带上 */
  padding: calc(var(--safe-top) + var(--sp-12)) calc(var(--safe-right) + var(--sp-12))
    calc(var(--safe-bottom) + var(--sp-12)) calc(var(--safe-left) + var(--sp-12));
}

/* ---------- 层级 1 · 沉浸 ---------- */
.l1 {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}

.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 状态行 / 读数 / 提示气泡三块：16（区块之间），读数本身仍是这一屏的主角 */
  gap: var(--gap-lg);
}

/* 三段式读数：数字中性、分隔冒号染相位色（冒号色由行内 style 给） */
.clock {
  display: flex;
  align-items: baseline;
  justify-content: center;
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--text-1);
}

.l1 .clock {
  /* 环内读数：令牌给上下限 —— 小屏不溢出环、大屏仍够「巨」 */
  font-size: clamp(var(--fs-display-m), 9vmin, var(--fs-display-2xl));
}

.cap {
  margin-bottom: var(--gap-sm);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 提示气泡：中性三级字，不与读数抢视线 */
.hint {
  max-width: min(80vw, 320px);
  /* 提示气泡：上下 8、左右 16 */
  padding: var(--gap-sm) var(--pad-card);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
  /* 操作提示是要照着做的一句话，退到 --text-3 会看不清 */
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  text-align: center;
}

/* 圆角矩形按钮的共用底：微透明表面，让环的光透上来一点 */
.corner,
.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: var(--radius-full);
  color: var(--text-1);
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
  transition:
    transform var(--dur-fast) var(--ease-standard),
    background var(--dur-fast) var(--ease-standard);
}

.corner:active,
.btn:active {
  transform: scale(0.92);
}

.corner {
  position: absolute;
}

.corner.tl {
  top: calc(var(--safe-top) + var(--sp-12));
  left: calc(var(--safe-left) + var(--sp-12));
}

.corner.tr {
  top: calc(var(--safe-top) + var(--sp-12));
  right: calc(var(--safe-right) + var(--sp-12));
}

/* 强制模式开：实底橙 + 反色图标（与主按钮同一套「实底档」用法） */
.corner.on {
  background: var(--mod-focus);
  color: var(--on-tone);
}

/* 贴左缘、垂直居中的控制簇：一列圆角微透明按钮 */
.cluster {
  position: absolute;
  left: calc(var(--safe-left) + var(--sp-12));
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  /* 一列圆钮之间 6（紧邻同族），容器内距 8 */
  gap: var(--sp-6);
  padding: var(--gap-sm);
  border-radius: var(--radius-l);
  background: color-mix(in srgb, var(--surface-2) 64%, transparent);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-float);
}

.cluster .btn {
  background: transparent;
}

.cluster .btn:active {
  background: var(--surface-2);
}

/* ---------- 层级 2 · 完全沉浸 ---------- */
.l2 {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.l2 .clock {
  font-size: var(--fs-display-xl);
  letter-spacing: -0.04em;
  /* 数字轻轻长出来：只在本层挂载时播一次（v-if 每次进入都是新节点） */
  animation: fi-digits var(--dur-slow) var(--ease-out) both;
}

/* 竖屏：三段各占一行（HH / MM / SS），冒号缩成小分隔点，让竖排读得顺 */
@media (orientation: portrait) {
  .l2 .clock {
    flex-direction: column;
    align-items: center;
  }

  .l2 .colon {
    margin: 0.08em 0;
    font-size: 0.34em;
    line-height: 1;
  }
}

.todo {
  position: absolute;
  left: 50%;
  /* 底部待办行：离安全区 28（页面底边距同一档） */
  bottom: calc(var(--safe-bottom) + var(--sp-28));
  transform: translateX(-50%);
  max-width: min(84vw, 560px);
  font-size: var(--fs-subhead);
  color: var(--text-2);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@keyframes fi-digits {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.94);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ---------- 层级切换：淡入淡出 + 轻微缩放，不做硬切 ---------- */
.fi-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.fi-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.fi-enter-from,
.fi-leave-to {
  opacity: 0;
}

.fi-enter-from {
  transform: scale(0.96);
}

.fi-leave-to {
  transform: scale(1.02);
}

/* ---------- 强制模式说明条（SheetModal 插槽内容） ---------- */
.sheet-copy {
  margin: var(--gap-tight) 0 var(--gap-sm);
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.sheet-acts {
  display: flex;
  flex-direction: column;
  /* 说明条里的按钮组：纵向 8（半模态配方） */
  gap: var(--gap-sm);
}

.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 主按钮高 40 档（12 上下 + 14 字），圆角取按钮档 20 */
  padding: var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.ghost {
  padding: var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

/* ---------- 减弱动效 ---------- */
@media (prefers-reduced-motion: reduce) {
  .fi-enter-from,
  .fi-leave-to {
    transform: none;
  }

  .l2 .clock {
    animation: none;
  }

  .corner:active,
  .btn:active,
  .primary:active {
    transform: none;
  }
}
</style>
