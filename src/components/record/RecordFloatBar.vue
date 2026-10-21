<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Expand, Square } from 'lucide-vue-next'

import FloatDock from '@/components/common/FloatDock.vue'
import { fmtDur, recorder, stopRecording } from '@/system/recorderRuntime'

/**
 * 录音悬浮条：录音进行中常驻（App.vue 挂载，沉浸形态隐藏）。
 * 外壳走 common/FloatDock（四条浮条共用的停靠 / 材质 / 进出场），本文件只留录音域内容，
 * 并用独立持久化 key——两条各停各位，互不挤占。条形态：呼吸红点 + 计时 +
 * 停止 / 打开录音页；轻点信息区进 /record 录音页，拖到左右边缘
 * 收成 64px 方块泊车，轻点展开回条。录音是全局 runtime：从编辑
 * 抽屉或录音页发起的录音，切页后都由本条接管。
 */
const router = useRouter()

function openPage(): void {
  void router.push('/record')
}
</script>

<template>
  <FloatDock
    :open="recorder.status === 'recording'"
    storage-key="rein.rbar.dock.v1"
    region-label="正在录音"
    blob-label="展开录音控制"
    root-class="rdock-root"
  >
    <template #bar>
      <button class="info row" type="button" @click="openPage">
        <span class="dot live" />
        <b class="t">录音中</b>
        <span class="s num">{{ fmtDur(recorder.elapsedSec) }}</span>
      </button>
      <div class="acts row">
        <button class="abtn end" type="button" @click="stopRecording">
          <Square :size="13" :stroke-width="2.5" /> 停止
        </button>
        <button class="abtn ico" type="button" aria-label="打开录音页" @click="openPage">
          <Expand :size="15" :stroke-width="2.5" />
        </button>
      </div>
    </template>

    <template #blob>
      <span class="dot live" />
      <b class="bt num">{{ fmtDur(recorder.elapsedSec) }}</b>
    </template>
  </FloatDock>
</template>

<style scoped>
.bt {
  max-width: 100%;
  padding: 0 var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.info {
  position: relative;
  flex: 1;
  min-width: 0;
  gap: var(--gap-sm);
  text-align: left;
  border-radius: var(--radius-m);
  padding: var(--sp-2);
  transition: background var(--dur-fast) var(--ease-standard);
}

/* 信息区是拖拽手柄 + 打开录音页的入口：视觉只有一行 19，命中区撑到 44 */
.info::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 100%;
  height: var(--hit-min);
  transform: translateY(-50%);
  border-radius: inherit;
}

.info:active {
  background: var(--surface-2);
}

.dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.dot.live {
  background: var(--danger);
  box-shadow: 0 0 8px color-mix(in srgb, var(--danger) 65%, transparent);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.t {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
  color: var(--text-1);
}

.s {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.acts {
  flex: none;
  /* 浮条里两枚按钮之间 8（无边界控件间距） */
  gap: var(--gap-sm);
}

.abtn {
  position: relative;
  flex: none;
  /* 图标/小按钮的视觉直径走 --control-icon（34），不再写裸 34 */
  height: var(--control-icon);
  padding: 0 var(--sp-12);
  /* 按钮圆角 20（HarmonyOS 圆角规范 · 按钮档）；原先 16 是卡片档 */
  border-radius: var(--radius-l);
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 34 高的浮条按钮命中区撑到 44：与语音浮条同一套（视觉不放大，只扩热区） */
.abtn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
}

.abtn:active {
  transform: scale(0.94);
}

.abtn.end {
  /* soft 底 + strong 字（与语音浮条同款令牌对）：原先手搓 14% danger 底配实底 danger 字，
     两层都偏离令牌，且实底档当文字用对比度不够 */
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.abtn.ico {
  width: 34px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .dot.live {
    animation: none;
  }
}
</style>
