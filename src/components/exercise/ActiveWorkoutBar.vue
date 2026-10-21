<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import ActionSheet from '@/components/common/ActionSheet.vue'
import FloatDock from '@/components/common/FloatDock.vue'
import WorkoutFloatBlob from '@/components/float/WorkoutFloatBlob.vue'
import WorkoutFloatContent from '@/components/float/WorkoutFloatContent.vue'
import { buildWorkoutSnapshot, workoutEndSheet } from '@/components/float/snapshot'
import { workoutRuntime } from '@/system/workoutRuntime'
import { immersiveClosing, immersiveOpen, immersiveReturning, openImmersive, setImmersiveOriginProvider } from '@/system/sessionImmersive'
import { useToast } from '@/composables/useToast'

/**
 * 悬浮运动条：导航栏上方常驻的「当前运动」视图（App.vue 挂载，
 * 沉浸形态下隐藏：fullscreen 路由（跑步）或训练课沉浸层打开；
 * 收起动画期间提前回归与形变块接续）。
 * 数据与动作全部来自运动系统运行时（system/workoutRuntime）：
 * 跑步 = 配速 · 里程 · 暂停（必须暂停再结束）；课程 = 动作名 ·
 * 当前组数 · 完成本组。原有各页「检测到未完成的训练」恢复提示
 * 由本条接管——运行时启动即恢复会话，无运动时整条不显示。
 *
 * 外壳走 common/FloatDock（四条浮条共用的停靠 / 材质 / 进出场）。条 / 方块里的内容
 * 与样式在 components/float/WorkoutFloatContent、WorkoutFloatBlob —— 与全局浮窗
 * （另一个 webview）复用同一份；本文件只留运动域的壳与动作。
 * 停靠在 bottom 时通过 --wbar-reserve 给页面内容追加底部空间（tokens.css 的
 * --page-pad-bottom 计入），页面已滚到底则自动跟随滚到新位置，
 * 让被本条盖住的末尾内容滑出来。
 */
const rt = workoutRuntime
const router = useRouter()
const { toast } = useToast()

const view = rt.view
/** 本条渲染的全部内容：状态点语义 / 标题 / 统计行 / 主动作 / 结束文案都由它派生，
 *  与推给系统浮窗的快照是**同一个函数**（buildWorkoutSnapshot），不是两份文案。
 *  插槽只在 FloatDock 打开时渲染，这里给模板一个非空快照，免去逐字段判空。 */
const barSnapshot = computed(() => buildWorkoutSnapshot(rt)!)
const endOpen = ref(false)
/** FloatDock 暴露的定位层：停靠 / 形变锚点都从它量 */
const dock = ref<InstanceType<typeof FloatDock> | null>(null)

/** 沉浸态的两条根类改由 prop 声明，不再命令式碰子组件 DOM */
const dockClass = computed(() => ({
  'wdock-root': true,
  'immersive-hidden': immersiveOpen.value && !immersiveClosing.value,
  // closing 期浮条保持**可见**（被不透明的形变壳盖住，仅作收起锚点与落位底）：
  // 形变壳贴到它的 rect 上后由落位溶解露出，不再另播滑入动画。
  'immersive-measuring': immersiveClosing.value,
}))

// 注册形变锚点供给：沉浸层展开快照 / 收起实时量取都从 body 取
// （getter 形式——收起时浮窗已恢复显示且可能刚被重新停靠，须现取现量）。
// 量 body 而非 posEl：border-radius（bar/blob 两态不同）长在 body 上。
// posEl 尚未落位（placeInstant 未写 transform，如开课瞬间浮窗刚随
// view 渲染）时返回 null——量到的 (0,0) 会让形变从屏幕左上角长出。
onMounted(() => {
  setImmersiveOriginProvider(() => {
    const pos = dock.value?.posEl ?? null
    if (!pos || getComputedStyle(pos).transform === 'none') return null
    return (pos.firstElementChild as HTMLElement | null) ?? pos
  })
})

/* 沉浸收起的显形不在这里播动画：closing 期浮条就保持在原位（被形变壳盖住），
   壳贴落后由 SessionOverlay 的落位溶解露出——浮条自己始终没动过。 */

/** 移动端是文档级滚动；桌面三窗格壳滚在 .desk-main 上 */
function activeScroller(): HTMLElement | null {
  const dm = document.querySelector('.desk-main')
  if (dm instanceof HTMLElement) return dm
  return (document.scrollingElement as HTMLElement | null) ?? null
}

watch([immersiveOpen, immersiveClosing, immersiveReturning], ([open, closing, returning]) => {
  document.documentElement.dataset.immersive = returning ? 'returning' : closing ? 'closing' : open ? 'open' : 'ready'
}, { immediate: true })

const dockSlot = computed(() => dock.value?.slot ?? 'bottom')

watch(
  [dockSlot, view],
  async ([s, v]) => {
    const rootStyle = document.documentElement.style
    if (!v || s !== 'bottom') {
      rootStyle.removeProperty('--wbar-reserve')
      return
    }
    // 先在旧布局上判断是否已滚到底，再让预留生效——flush:'post' 保证
    // 读到的是切换后形态的真实高度，而 padding 此刻尚未变化
    const sc = activeScroller()
    const atEnd = sc ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 : false
    const h = dock.value?.posEl?.getBoundingClientRect().height || 58
    rootStyle.setProperty('--wbar-reserve', `${Math.round(h + 14)}px`)
    await nextTick()
    // 已在底部还往下补了空间：跟着滚到底，把被悬浮条盖住的内容露出来
    if (atEnd && sc) sc.scrollTop = sc.scrollHeight
  },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(() => {
  document.documentElement.style.removeProperty('--wbar-reserve')
})

/* ---------- 原有动作语义不变 ---------- */
/* 结束确认的标题与动作取自 components/float/snapshot 的同一份构造器：
   标题说后果不说规定（文案即代价），与系统浮窗的内联确认逐字一致。 */
const endSheet = computed(() => {
  const v = view.value
  return v ? workoutEndSheet(v) : null
})
const endTitle = computed(() => endSheet.value?.title ?? '')
const endActions = computed(() =>
  (endSheet.value?.actions ?? []).map((a) => ({ label: a.label, value: a.id, danger: a.danger })),
)

/** 主动作：暂停 / 继续 / 完成本组 —— 与快照里的 primary 同源，不在模板里再判一遍相位 */
function onPrimary(): void {
  const p = barSnapshot.value?.primary
  if (!p) return
  if (p.id === 'pause') rt.pauseActive()
  else if (p.id === 'resume') rt.resumeActive()
  else rt.completeCurrentSet()
}

function goImmersive(): void {
  // 训练课：从浮窗当前位置形变展开为沉浸层（不走路由，任意吸附位同理）；
  // 跑步仍是路由沉浸页。锚点走 provider（量 body，圆角正确）
  const target = rt.immersiveRoute.value
  if (target) void router.push(target)
  else openImmersive()
}

async function onEndPick(value: string): Promise<void> {
  if (value === 'finish') {
    if (rt.kind.value === 'run') {
      // 跑步先冻结进总结页，距离核对 / 补填在沉浸页完成
      rt.enterRunSummary()
      goImmersive()
    } else {
      try {
        const r = await rt.finishCourse()
        if (r) toast(`已保存 ${r.done} 组 · 约 ${r.durationMin} 分钟 · ${r.kcal} 大卡`)
      } catch (e) {
        // 写库失败：会话仍 active、浮条照常，可原样再点（重试用同一 sessionId）
        toast(e instanceof Error ? e.message : '保存失败，请重试')
      }
    }
  } else if (value === 'discard') {
    const wasRun = rt.kind.value === 'run'
    try {
      await rt.discardActive()
      toast(wasRun ? '已放弃本次跑步' : '已放弃本次训练')
    } catch (e) {
      // 放弃失败：保留会话与浮条，供原样重试
      toast(e instanceof Error ? e.message : '放弃失败，请重试')
    }
  }
}

</script>

<template>
  <FloatDock
    ref="dock"
    :open="!!view"
    storage-key="rein.wbar.dock.v1"
    region-label="进行中的运动"
    blob-label="展开运动控制"
    :root-class="dockClass"
    :padding-y="10"
  >
    <template #bar>
      <WorkoutFloatContent
        :snapshot="barSnapshot"
        @primary="onPrimary"
        @end="endOpen = true"
        @open="goImmersive"
        @immerse="goImmersive"
      />
    </template>

    <template #blob>
      <WorkoutFloatBlob :snapshot="barSnapshot" />
    </template>

    <!-- 结束（二级确认）：与沉浸页同一条结束语义 -->
    <ActionSheet
      :open="endOpen"
      :title="endTitle"
      :actions="endActions"
      @select="void onEndPick($event)"
      @close="endOpen = false"
    />
  </FloatDock>
</template>

<style scoped>
.wdock-root.immersive-hidden {
  opacity: 0;
  pointer-events: none;
}

/* 收起形变期（closing）：浮条保持可见充当落位底——被不透明的形变壳整个盖住，
   只摘掉折射与交互（折射采样在壳底下无人看见，白付一次全条重采样）。
   落位由 SessionOverlay 的壳面溶解完成显形，这里**没有**入场动画：
   浮条从未离开过自己的位置，任何位移都会让形变落点对不上。 */
.wdock-root.immersive-measuring {
  pointer-events: none;
  /* 收起（closing）时本浮条是形变壳的**落位底**：壳贴落瞬间露出的必须是 100% 可见的浮条。
     而「开课 → 立刻收起」这个时序里，浮条的入场过渡（FloatDock 的 0→1，250ms）可能还没走完，
     收起又会把这条过渡 retarget 回去 —— 采样与肉眼都会看到一块半透明浮条（既有 e2e
     e2e-immerse-toggle 的「Dock 就位可见」断言正是这一条）。这里直接摘掉过渡并钉死
     opacity: 1：落位底不该有第二种透明度。正常入场（未收起时）不受影响。 */
  opacity: 1 !important;
  transition: none !important;
}

.wdock-root.immersive-measuring :deep(.dock-body) {
  /* `!important` 是必须的：`.dock-body` 的 backdrop-filter 是**内联样式**
     （`glassStyle` 在 liquidGlass 档生成 `url(#…) saturate(…)`，绑在 :style 上），
     而内联的普通声明胜过作者的普通声明 —— 不带它这条规则恒不生效，收起那 400ms 里
     整条全宽玻璃仍在逐帧重算折射（采样点全被形变壳盖住，白付一笔）。
     同一手法见 SessionOverlay 的 `.session-layer.is-morphing :deep(.sgbtn)`：
     那里也是压 GlassSurface 的内联 url()，同样带了 !important。 */
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
</style>
