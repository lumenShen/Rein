<script setup lang="ts">
import { computed } from 'vue'
import { Expand } from 'lucide-vue-next'

import type { GlobalFloatSnapshot } from '@/types'

/**
 * 训练浮条内容 · 程序内浮条与系统浮窗共用的唯一一份。
 *
 * 两行版：状态点 + title / stat（动作名 / 组与重量配置 / 休息目标）。
 * 训练浮条只有两颗业务按钮：**完成当组（或跳过休息）** 与 **跳过动作** ——
 * 结束、打开都不再占浮条：结束在沉浸页顶栏做二次确认，点信息区即可回到应用。
 * 总结态没有训练动作可做，只留一颗「去保存」。
 *
 * emits：
 *  · primary   —— 完成当组 / 跳过休息 / 暂停 / 继续（由快照 primary.id 决定）
 *  · secondary —— 跳过动作 / 总结态去保存（由快照 secondary.id 决定）
 *  · open      —— 点信息区（使用方决定落地：程序内是恢复沉浸，
 *                 浮窗是把应用叫回来并落到对应页面）
 *  · immerse   —— 展开图标（恢复沉浸）
 */
const props = defineProps<{ snapshot: GlobalFloatSnapshot }>()
const emit = defineEmits<{ primary: []; secondary: []; open: []; immerse: [] }>()

/** tone → 原浮条的点类名：live（在跑）/ pause（暂停）/ done（待保存）；break 在训练里不出现，兜底 live */
const dotClass = computed(() => {
  switch (props.snapshot.tone) {
    case 'paused':
      return 'pause'
    case 'done':
      return 'done'
    default:
      return 'live'
  }
})

const primary = computed(() => props.snapshot.primary)
const secondary = computed(() => props.snapshot.secondary ?? null)
</script>

<template>
  <button class="info row" type="button" @click="emit('open')">
    <span
      class="dot"
      :class="dotClass"
    />
    <span class="lines col">
      <b class="t">{{ snapshot.title }}</b>
      <span class="s num">{{ snapshot.stat }}</span>
    </span>
  </button>

  <div class="acts row">
    <button
      v-if="primary"
      class="abtn main"
      type="button"
      @click="emit('primary')"
    >
      {{ primary.label }}
    </button>
    <button
      v-if="secondary"
      class="abtn"
      :class="snapshot.tone === 'done' ? 'main' : 'alt'"
      type="button"
      @click="emit('secondary')"
    >
      {{ secondary.label }}
    </button>
    <button
      v-if="snapshot.canImmersive"
      class="abtn ico"
      type="button"
      aria-label="恢复沉浸模式"
      @click="emit('immerse')"
    >
      <Expand
        :size="15"
        :stroke-width="2.5"
      />
    </button>
  </div>
</template>

<style scoped>
/* 左侧信息区：整块可点，等价「恢复沉浸」 */
.info {
  flex: 1;
  min-width: 0;
  gap: var(--sp-10);
  text-align: left;
  border-radius: var(--radius-m);
  padding: var(--sp-2);
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
  background: var(--text-3);
}

.dot.live {
  background: var(--c-exercise);
  box-shadow: 0 0 8px color-mix(in srgb, var(--c-exercise) 65%, transparent);
  animation: rein-breathe var(--dur-pulse) infinite;
}

.dot.pause {
  background: var(--warn);
}

.lines {
  min-width: 0;
  gap: var(--gap-text);
}

.t {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.s {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 右侧动作区 */
.acts {
  flex: none;
  gap: var(--sp-6);
}

.abtn {
  flex: none;
  position: relative;
  height: 38px;
  padding: 0 var(--sp-14);
  border-radius: var(--radius-l);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 视觉高度留 38（浮条的总高不能因为热区而涨），命中区上下各撑 3px 到 44：
   收起状态下这里是「继续 / 完成本组」的唯一入口，练到力竭时更需要容错。 */
.abtn::after {
  content: '';
  position: absolute;
  inset: -3px;
}

.abtn:active {
  transform: scale(0.94);
}

.abtn.main {
  background: var(--text-1);
  color: var(--bg);
}

/* 次级动作（跳过动作）：中性底，不与「完成当组」抢主行动的位置 */
.abtn.alt {
  background: var(--surface-2);
  color: var(--text-1);
}

.abtn.ico {
  width: 38px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

/* 减弱动效：保留透明度确认，去掉呼吸点（外壳的位移清理在 FloatDock 内） */
@media (prefers-reduced-motion: reduce) {
  .dot.live {
    animation: none;
  }
}
</style>
