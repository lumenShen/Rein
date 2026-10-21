<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import ActionSheet from '@/components/common/ActionSheet.vue'
import FloatDock from '@/components/common/FloatDock.vue'
import FocusFloatBlob from '@/components/float/FocusFloatBlob.vue'
import FocusFloatContent from '@/components/float/FocusFloatContent.vue'
import { buildFocusSnapshot, focusEndSheet } from '@/components/float/snapshot'
import { enterFocusImmersive } from '@/system/focusImmersive'
import { usePomodoroStore } from '@/stores/pomodoro'

/**
 * 专注悬浮条：一轮专注「进行中 / 暂停未走完」时全应用常驻（App.vue 挂载，沉浸形态隐藏）。
 *
 * 这是专注域此前最大的产品缺口：番茄钟的计时**本来**就在切页后继续跑（store 是全局单例），
 * 但用户在任何别的页面都看不见它 —— 状态只被关在 /focus 专用页里。录音 / 语音 / 运动 /
 * 抢课四个域都已用「runtime 单例 + FloatBar 常驻」这一范式，专注缺的正是这一层。
 *
 * 外壳走 common/FloatDock（四条浮条共用的停靠 / 材质 / 进出场），本文件只留专注域的
 * 「壳」：快照（components/float/snapshot 的构造器）+ 动作 + ActionSheet 二级确认。
 * 条 / 方块里的内容与样式全部在 components/float/FocusFloatContent、FocusFloatBlob ——
 * 全局浮窗（独立 webview）复用同一份，两条渲染路径才不会漂。
 *
 * 文案分两套口径（`settings.mode`）：倒计时才有「专注 / 休息」两个相位，正计时永不进休息 ——
 * 所以相位文案与结束确认都按方向分支，不能让正计时套上「结束就进休息」这类假承诺。
 */
const router = useRouter()
const pomo = usePomodoroStore()

/** 本条渲染的全部内容：状态点语义 / 相位文案 / 读数 / 主动作 / 结束文案都由它派生，
 *  与推给系统浮窗的快照是**同一个函数**（buildFocusSnapshot），不是两份文案。 */
const snapshot = computed(() => buildFocusSnapshot(pomo))

/** 结束确认（二级）：标题与动作取自同一份快照构造器，与浮窗内联确认逐字一致 */
const endOpen = ref(false)
const endSheet = computed(() => focusEndSheet(pomo))
const endActions = computed(() =>
  endSheet.value.actions.map((a) => ({ label: a.label, value: a.id, danger: a.danger })),
)

function onEndPick(value: string): void {
  if (value === 'end') void pomo.endRound()
  else if (value === 'reset') pomo.reset()
}

/** 暂停 / 继续：start() 幂等（已在跑就直接返回），暂停态再点即续走 */
function toggleRun(): void {
  if (pomo.running) pomo.pause()
  else pomo.start()
}

function openPage(): void {
  void router.push({ name: 'focus' })
}

/** 直接进沉浸层：浮条挂在全应用身上，「现在就专注」的入口该送到手边，
 *  不必先跳专注页再双击读数（卡片那边的双击手势留在卡片上）。
 *  沉浸层由 App.vue 全局挂载，不依赖当前路由；它一置位，本浮条按 base.css 的
 *  `html[data-focus-immersive]` 规则自行收起，不会与全屏层抢视线。 */
function enterImmersive(): void {
  enterFocusImmersive()
}
</script>

<template>
  <FloatDock
    :open="pomo.active"
    storage-key="rein.fbar.dock.v1"
    region-label="专注计时"
    blob-label="展开专注控制"
    root-class="fdock-root"
  >
    <template #bar>
      <FocusFloatContent
        :snapshot="snapshot"
        @primary="toggleRun"
        @end="endOpen = true"
        @open="openPage"
        @immerse="enterImmersive"
      />
    </template>

    <template #blob>
      <FocusFloatBlob :snapshot="snapshot" />
    </template>

    <!-- 结束（二级确认）：与卡片同一套结束语义 -->
    <ActionSheet
      :open="endOpen"
      :title="endSheet.title"
      :actions="endActions"
      @select="onEndPick"
      @close="endOpen = false"
    />
  </FloatDock>
</template>
