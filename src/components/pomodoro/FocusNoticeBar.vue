<script setup lang="ts">
import { computed } from 'vue'
import { X } from 'lucide-vue-next'

import { usePomodoroStore } from '@/stores/pomodoro'

/**
 * 专注相位提示条 —— 只补「系统通知没发出去」这一种情况。
 *
 * 项目已立的规矩：「系统通知没送达，就必须留在页面上」（见 services/notifyService.ts 与
 * GrabFloatBar.vue 的注释）。相位切换时 W1 会写一份 `pomo.notice`，其中 `delivered === false`
 * 表示系统通知在**当前环境发不出去**（浏览器 / mock / 没权限）—— 那一刻浮条 + 提示音 +
 * 系统通知三条通道全断，这条常驻提示条就是唯一还在的告知。
 *
 * 反过来，`delivered === true` 时**不渲染**：浮条状态点、提示音、系统通知已经三条通道都在报，
 * 再叠一条只会打扰。放在**顶部居中**、z 78（低于 GrabFloatBar 的 80）：它是「抬头看一眼」的
 * 送达条，与抢课监视器同一族定位，但把上位让给抢课条，避免两条抢同一处落点。
 */
const pomo = usePomodoroStore()

/* 只在「有提示 且 系统通知没送达」时返回那条提示，否则 null。
   把对象本身取出来而不是在模板里读 `pomo.notice.title` —— 这样 v-if 能可靠收窄类型。 */
const shown = computed(() => (pomo.notice && !pomo.notice.delivered ? pomo.notice : null))
</script>

<template>
  <Teleport to="body">
    <Transition name="fnb">
      <div
        v-if="shown"
        class="fnb glass-surface"
        :class="`tone-${shown.tone}`"
        role="status"
        aria-label="专注提示"
      >
        <span class="dot" aria-hidden="true" />
        <span class="lines col">
          <b class="t">{{ shown.title }}</b>
          <span class="b">{{ shown.body }}</span>
        </span>
        <button class="cls" type="button" aria-label="关闭提示" @click="pomo.dismissNotice()">
          <X :size="15" :stroke-width="2.5" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fnb {
  position: fixed;
  /* 顶部浮条离安全区 8：与抽屉/浮条避让的同一档 */
  top: calc(var(--safe-top) + var(--gap-sm));
  left: 50%;
  transform: translateX(-50%);
  /* 低于 GrabFloatBar 的 80：两条同时在时把上位让给抢课监视器 */
  z-index: 78;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  width: min(calc(var(--frame-max) - 24px), calc(100vw - 24px));
  /* 浮条：上下 10 + 两行 12/12 ≈ 44 高，左右 12 */
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-l);
  color: var(--text-1);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 色相只落在状态点上，标题与正文保持中性（STANDARDS §4 色彩配额） */
.dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--mod-focus-tone);
}

.tone-break .dot {
  background: var(--cat-general);
}

.lines {
  flex: 1;
  min-width: 0;
  /* 标题与副行：主次文本上下 2 */
  gap: var(--gap-text);
}

.t {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  letter-spacing: -0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.b {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 关闭钮：视觉 26px、命中区撑到 44（浮条本身才 ~40px 高），点得到又不挤条 */
.cls {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-3);
  transition: background var(--dur-fast) var(--ease-standard);
}

.cls::after {
  content: '';
  position: absolute;
  /* 26 的视觉钮要撑到 44 命中区：外扩 10（9 不是 4/8 体系，10 也够到 46） */
  inset: calc(-1 * var(--sp-10));
}

.cls:active {
  background: var(--surface-2);
}

/* 进出同路径：从顶部滑入 / 滑回，别用缩放 —— 它是「降下来的一条」 */
.fnb-enter-active,
.fnb-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-out);
}

.fnb-enter-from,
.fnb-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-14px);
}

@media (prefers-reduced-motion: reduce) {
  .fnb-enter-from,
  .fnb-leave-to {
    transform: translateX(-50%);
  }

  .fnb-enter-active,
  .fnb-leave-active {
    transition-duration: 150ms;
  }
}
</style>
