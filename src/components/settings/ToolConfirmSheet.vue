<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type DeepReadonly } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import {
  activeToolConfirm,
  resolveToolConfirm,
  TOOL_CONFIRM_TIMEOUT_MS,
  type ToolConfirmActive,
} from '@/system/toolConfirm'

/**
 * 危险工具确认弹层（全局常驻，App.vue 挂载）。
 *
 * 状态来自单例队列 `system/toolConfirm`：同一时刻只有一条，其余排队。
 * 关闭 / 背景 / Esc 一律按「拒绝」——没有「始终允许」；拒绝后模型必须停手，
 * 不能换参数重试（见 connectedAppsPrompt 的写工具段落）。
 */
const live = computed(() => activeToolConfirm.value)
/** 抽屉离场动画期间保留最后一条，避免滑出时内容已经空了。 */
const cached = ref<DeepReadonly<ToolConfirmActive> | null>(null)
watch(live, (v) => {
  if (v) cached.value = v
})
const view = computed(() => live.value ?? cached.value)
const open = computed(() => live.value !== null)
const timeoutSec = Math.round(TOOL_CONFIRM_TIMEOUT_MS / 1000)

function allow(): void {
  resolveToolConfirm(true)
}

function deny(): void {
  resolveToolConfirm(false)
}

/**
 * Esc = 拒绝。SheetModal 自己维护了「Esc 只关栈顶」的栈，但当前版本没有全局 keydown
 * 监听（栈只用于挂载/卸载记账）；确认层必须自己兜住 Esc，才能满足「关闭/Esc 都按拒绝」。
 * 用捕获阶段 + stopPropagation：确认层在最上面，Esc 不应再传给下层抽屉。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !activeToolConfirm.value) return
  e.preventDefault()
  e.stopPropagation()
  deny()
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <SheetModal
    :open="open"
    :title="view?.title ?? '确认操作'"
    :z-index="118"
    initial-snap="small"
    @close="deny"
  >
    <div v-if="view" class="wrap" data-testid="tool-confirm-sheet">
      <StatusChip v-if="view.danger" tone="warn" size="md">危险操作 · 每次都要确认</StatusChip>
      <p class="lead">{{ view.body }}</p>
      <ul v-if="view.details?.length" class="details">
        <li v-for="(line, i) in view.details" :key="i">{{ line }}</li>
      </ul>
      <p class="timeout t-3">{{ timeoutSec }} 秒内未选择将按拒绝处理；拒绝后这次操作不会发生。</p>
    </div>

    <template #footer>
      <div class="acts">
        <button class="btn" data-testid="tool-confirm-deny" @click="deny">拒绝</button>
        <button class="btn primary" data-testid="tool-confirm-allow" @click="allow">允许一次</button>
      </div>
    </template>
  </SheetModal>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.lead {
  margin: 0;
  color: var(--text-1);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.details {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin: 0;
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  overflow-wrap: anywhere;
}

.details li {
  margin: 0;
}

.timeout {
  margin: 0;
}

/* 底栏：拒绝在左（次要），允许一次在右（主操作）；没有「始终允许」 */
.acts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gap-sm);
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.btn:active {
  transform: scale(0.985);
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}
</style>
