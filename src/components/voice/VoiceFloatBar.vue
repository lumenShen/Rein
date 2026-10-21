<script setup lang="ts">
import { computed } from 'vue'
import { ChevronUp, Square } from 'lucide-vue-next'

import FloatDock from '@/components/common/FloatDock.vue'
import TimeSpine from './TimeSpine.vue'
import { finishSpeaking, restore, voice } from '@/system/voiceRuntime'
import { fmtMmSs } from '@/utils/format'

/**
 * 语音转写悬浮条：转写进行中被「⌄ 收起」后常驻（App.vue 挂载）。
 * 外壳走 common/FloatDock（四条浮条共用的停靠 / 材质 / 进出场），本文件只留语音域内容，
 * 并用独立持久化 key；轻点信息区展开回会话视图，「■ 完成」就地触发整理。
 */
function fmtMs(ms: number): string {
  return fmtMmSs(ms)
}

/** 收起态的那根脊：只喂已经定稿的句子，未定稿那句由 head 游标表达 */
const dockSegs = computed(() =>
  voice.sentences.map((s) => ({
    t: s.startMs,
    durMs: s.endMs > s.startMs ? s.endMs - s.startMs : undefined,
    who: '我',
    text: s.text,
  })),
)
</script>

<template>
  <FloatDock
    :open="voice.minimized && (voice.status === 'recording' || voice.status === 'processing')"
    storage-key="rein.vbar.dock.v1"
    region-label="正在转写"
    blob-label="展开语音会话"
    root-class="vdock-root"
  >
    <template #bar>
      <button class="info" type="button" @click="restore">
        <span class="dot" />
        <b>{{ voice.status === 'recording' ? '转写中' : '整理中' }}</b>
        <!-- 时长是主角（caption + .num），句数降成微字档 —— 两者不再共用同一字号字重 -->
        <span class="s num">{{ fmtMs(voice.elapsedMs) }}</span>
        <span class="s-sc num">{{ voice.sentences.length }} 句</span>
      </button>
      <!-- 浮条就是那根正在生长的时间脊：收起后也能看出「说到哪、密不密」 -->
      <TimeSpine
        v-if="voice.sentences.length"
        class="barspine"
        size="mini"
        :segments="dockSegs"
        :head-ms="voice.elapsedMs"
      />
      <div class="acts">
        <button v-if="voice.status === 'recording'" class="abtn end" type="button" @click="finishSpeaking">
          <Square :size="11" :stroke-width="2.5" /> 完成
        </button>
        <button class="abtn ico" type="button" aria-label="展开语音会话" @click="restore">
          <ChevronUp :size="15" :stroke-width="2.5" />
        </button>
      </div>
    </template>

    <template #blob>
      <span class="dot" />
      <b class="bt num">{{ fmtMs(voice.elapsedMs) }}</b>
    </template>
  </FloatDock>
</template>

<style scoped>
/* 浮条里的脊：夹在「转写中 · 时长」与操作按钮之间，是这根条的主体视觉 */
.barspine {
  flex: 1;
  min-width: 44px;
  max-width: 120px;
}

.bt {
  max-width: 100%;
  padding: 0 var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.info {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  text-align: left;
  border-radius: var(--radius-m);
  padding: var(--sp-2);
  transition: background var(--dur-fast) var(--ease-standard);
}

/* 信息区（转写状态 + 时长 + 句数）是打开会话的入口：一行约 19 高，命中区撑到 44 */
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
  background: var(--danger);
  box-shadow: 0 0 8px color-mix(in srgb, var(--danger) 65%, transparent);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.info b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.2px;
  color: var(--text-1);
  flex: none;
}

.info .s {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 句数是次要项：微字 + 三级灰，与时长用形态分开 */
.info .s-sc {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.acts {
  flex: none;
  display: flex;
  gap: var(--gap-sm);
}

.abtn {
  position: relative;
  flex: none;
  height: var(--control-icon);
  padding: 0 var(--sp-12);
  /* 按钮圆角 20（HarmonyOS 圆角规范 · 按钮档）；原先 16 是卡片档 */
  border-radius: var(--radius-l);
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.abtn:active {
  transform: scale(0.94);
}

/* 34 高的胶囊命中区撑到 44×44（原先图标钮只有 40 宽）：
   视觉不放大，热区按触控下限走 */
.abtn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
}

/* 结束钮的 soft 底 + 图标色走令牌对（--danger-soft 底 / --danger-strong 字），
   不再手搓 14% color-mix —— 实底档 --danger 直接当图标/文字色对比度不够 */
.abtn.end {
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
  .dot {
    animation: none;
  }
}
</style>
