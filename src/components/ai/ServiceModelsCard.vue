<script setup lang="ts">
/**
 * 服务模型卡：全应用四个模型接口的「当前用哪个」一屏看全，点一行换一个。
 *
 * 四行的真源各不相同（见 stores/modelRoles）：
 * - 主 LLM → ai_models 的默认项；多模态备选 → 界面偏好里的绑定（只在主模型没有
 *   视觉能力时才需要，否则这一行暗着并说明原因）；
 * - ASR → 语音配置；向量 → 知识库设置。
 *
 * 所以这张卡只做「读 + 点开选择」，不在这里改任何配置 —— 换模型的动作全部落到
 * 各自的执行位（选完立即生效，页面回读的就是新值）。
 */
import { Boxes, Eye, MessageSquareText, Mic } from 'lucide-vue-next'

import StatusChip from '@/components/common/StatusChip.vue'
import { useModelRolesStore } from '@/stores/modelRoles'
import type { ModelRole } from '@/types'

defineProps<{ loading?: boolean }>()

const emit = defineEmits<{ pick: [ModelRole] }>()

const roles = useModelRolesStore()

const ICONS = {
  llm: MessageSquareText,
  vision: Eye,
  asr: Mic,
  embedding: Boxes,
} as const
</script>

<template>
  <section class="card sm">
    <div class="row between center head">
      <b>服务模型</b>
      <span class="t-3 sub">聊天 · 看图 · 语音识别 · 语义检索</span>
    </div>

    <ul>
      <li v-for="s in roles.slots" :key="s.role">
        <button
          type="button"
          class="row center slot"
          :class="{ locked: !s.interactive }"
          :disabled="!s.interactive || loading"
          @click="emit('pick', s.role)"
        >
          <span class="ic" :class="`ic-${s.role}`">
            <component :is="ICONS[s.role]" :size="15" />
          </span>
          <span class="flex-1 min0 txt">
            <span class="row center t1">
              <i class="label">{{ s.label }}</i>
              <!-- 就绪状态写成可见文字（原先只有色点，含义藏在 aria-label 里）；
                   圆点降为胶囊内的前导点 -->
              <StatusChip :tone="s.ok ? 'ok' : 'neutral'" size="sm" :aria-label="s.ok ? '已就绪' : '未就绪'">
                <i class="dot" :class="s.ok ? 'ok' : 'warn'" />
                {{ s.ok ? '已就绪' : '未就绪' }}
              </StatusChip>
            </span>
            <b>{{ s.value }}</b>
            <small>{{ s.sub }}</small>
            <em v-if="s.warn" class="warn-line">{{ s.warn }}</em>
            <em v-else-if="s.lockedNote" class="lock-line">{{ s.lockedNote }}</em>
          </span>
          <span class="go">›</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sm {
  padding: var(--pad-card-tight) var(--pad-card);
}

.head {
  gap: var(--gap-sm);
}

.head b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.head .sub {
  font-size: var(--fs-caption);
}

ul {
  margin-top: var(--gap-sm);
}

.slot {
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h-double);
  padding: 0;
  text-align: left;
}

.slot + .slot,
li + li .slot {
  border-top: 0.5px solid var(--line);
}

.slot:disabled {
  opacity: var(--disabled-opacity);
}

.slot.locked .go {
  visibility: hidden;
}

/* 四个槽位徽章统一 token-soft（与设置页 / 同步页 / 模型页的图标章同一套）：
   整面 accent-soft 底 + accent 图标，撤掉四支手写渐变 hex；
   槽位区分靠图标（对话 / 看图 / 语音 / 向量），不靠颜色。 */
.ic {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-s);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ic-llm,
.ic-vision,
.ic-asr,
.ic-embedding {
  background: var(--accent-soft);
  color: var(--accent);
}

.txt {
  min-width: 0;
}

.t1 {
  gap: var(--gap-sm);
}

.label {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.dot.ok {
  background: var(--ok);
}

.dot.warn {
  background: var(--text-3);
}

.txt b {
  display: block;
  margin-top: var(--gap-text);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  word-break: break-all;
}

.txt small {
  display: block;
  margin-top: var(--gap-text);
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  word-break: break-all;
}

.warn-line,
.lock-line {
  display: block;
  margin-top: var(--sp-4);
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.warn-line {
  color: var(--danger);
}

.lock-line {
  color: var(--text-2);
}

.go {
  flex: none;
  color: var(--text-2);
  font-size: var(--fs-headline);
}
</style>
