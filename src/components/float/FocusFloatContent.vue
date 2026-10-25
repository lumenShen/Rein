<script setup lang="ts">
import { computed } from 'vue'
import { Expand, Maximize2, Pause, Play } from 'lucide-vue-next'

import type { GlobalFloatSnapshot } from '@/types'

/**
 * 专注浮条内容 · 程序内浮条与系统浮窗共用的唯一一份。
 *
 * 为什么拆成组件：全局浮窗是**另一个 webview**，不能 import Pinia / router，也就不可能
 * 复用 FocusFloatBar 的模板；可它显示的内容必须与程序内逐像素一致（状态点 / 相位 /
 * 读数 / 四颗按钮的文案与顺序）。于是把「#bar 的内容和样式」搬到这里：程序内浮条把
 * store 构造的快照传进来，浮窗把 IPC 载荷里的快照传进来，两边渲染的是同一段 DOM 与
 * 同一段 CSS。改文案 / 按钮只改这里，浮条与浮窗不会各漂一套。
 *
 * emits 与浮条原有的动作一一对应：
 *  · primary —— 暂停 / 继续（具体是哪个由快照的 primary.id 决定）
 *  · end     —— 打开结束确认（程序内 ActionSheet、浮窗内联确认，由使用方决定）
 *  · open    —— 去专注页（点信息区 / 展开图标）
 *  · immerse —— 进入沉浸层
 */
const props = defineProps<{ snapshot: GlobalFloatSnapshot }>()
const emit = defineEmits<{ primary: []; end: []; open: []; immerse: [] }>()

/** tone → 原浮条的状态点类名（.dot.work / .brk / .paused）。
 *  done 在专注里不存在（结束即整条收起），兜底落「已暂停」的警示色，不出现没有底色的点。 */
const dotClass = computed(() => {
  switch (props.snapshot.tone) {
    case 'work':
      return 'work'
    case 'break':
      return 'brk'
    default:
      return 'paused'
  }
})

const primary = computed(() => props.snapshot.primary)
/** running 的语义由 primary.id 反推：暂停键在场 = 正在走（与原来的 pomo.running 同义） */
const running = computed(() => primary.value?.id === 'pause')
</script>

<template>
  <button class="info row" type="button" @click="emit('open')">
    <span
      class="dot"
      :class="dotClass"
    />
    <b class="t">{{ snapshot.title }}</b>
    <span class="s num">{{ snapshot.stat }}</span>
  </button>
  <div class="acts row">
    <button
      v-if="primary"
      class="abtn main"
      type="button"
      @click="emit('primary')"
    >
      <component
        :is="running ? Pause : Play"
        :size="13"
        :stroke-width="2.6"
      />
      {{ primary.label }}
    </button>
    <button
      v-if="snapshot.end"
      class="abtn end"
      type="button"
      @click="emit('end')"
    >
      {{ snapshot.end.label }}
    </button>
    <button
      class="abtn ico"
      type="button"
      aria-label="打开专注页"
      @click="emit('open')"
    >
      <Expand
        :size="15"
        :stroke-width="2.5"
      />
    </button>
    <!-- 进沉浸层（与「打开专注页」分开两颗：一个是去另一个页面，一个是就地放大，
         两件事的目的地不同，合成一颗就得先猜用户想要哪个） -->
    <button
      v-if="snapshot.canImmersive"
      class="abtn ico"
      type="button"
      aria-label="进入沉浸模式"
      @click="emit('immerse')"
    >
      <Maximize2
        :size="15"
        :stroke-width="2.5"
      />
    </button>
  </div>
</template>

<style scoped>
.info {
  flex: 1;
  min-width: 0;
  /* 色点 / 相位 / 读数三段：段间 8 */
  gap: var(--gap-sm);
  overflow: hidden;
  text-align: left;
  border-radius: var(--radius-m);
  padding: var(--gap-text);
  transition: background var(--dur-fast) var(--ease-standard);
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

/* 专注中：与运动条同一条呼吸动画（色相只在色点上，文字保持中性） */
.dot.work {
  background: var(--mod-focus-tone);
  box-shadow: 0 0 8px color-mix(in srgb, var(--mod-focus-tone) 65%, transparent);
  animation: rein-breathe var(--dur-pulse) infinite;
}

/* 休息中：中性灰，节律与专注区分开 —— 不呼吸（它不需要「正在计数」的紧迫感） */
.dot.brk {
  background: var(--cat-general);
}

.dot.paused {
  background: var(--warn);
}

.t {
  min-width: 0;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  /* 相位文案是这条里唯一长短随方向变的段（正计时的「正计时 · 已暂停」有 8 个字），
     而读数必须始终在场上。窄窗下让它自己截断，别把后面的 .s 顶出 .info 的裁剪边界
     （.info 只 overflow: hidden，flex 项默认 min-width: auto 不会缩） */
  overflow: hidden;
  text-overflow: ellipsis;
}

.s {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  white-space: nowrap;
}

.acts {
  flex: none;
  /* 浮条按钮组：组内 8（无边界） */
  gap: var(--gap-sm);
}

.abtn {
  flex: none;
  /* 高度是尺寸：与 --control-icon 同档 34 */
  height: var(--control-icon);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-m);
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.abtn:active {
  transform: scale(0.94);
}

/* 主操作：与运动条的 .abtn.main 同一份（实底 label 反色） */
.abtn.main {
  background: var(--text-1);
  color: var(--bg);
}

.abtn.end {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.abtn.ico {
  width: var(--control-icon);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .dot.work {
    animation: none;
  }
}
</style>
