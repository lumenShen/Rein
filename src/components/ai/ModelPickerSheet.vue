<script setup lang="ts">
/**
 * 服务模型选择抽屉：搜索框 + 候选列表（点一下即应用）。
 *
 * 四个角色共用这一个抽屉（标题与提示按角色换），候选来源由 stores/modelRoles 给：
 * 主/多模态 = 已配置的对话模型；ASR = 语音服务那套 + 提供商目录里的识别模型；
 * 向量 = 关键词档 + 本机模型 + 提供商目录里的向量模型。
 *
 * 列表**不在原页面里展开**：抽屉是独立一层，选完即关，底下的页面不会因为
 * 列表变长而重排（这是「列表下方还有按钮/说明时另开抽屉」的落点）。
 */
import { computed, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'

import ModelCandidateList from '@/components/ai/ModelCandidateList.vue'
import ModelListToolbar from '@/components/ai/ModelListToolbar.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { KIND_HINT, parseRef } from '@/ai/providerCatalog'
import { useModelRolesStore } from '@/stores/modelRoles'
import { useProvidersStore } from '@/stores/providers'
import type { ModelRole } from '@/types'

const props = defineProps<{ open: boolean; role: ModelRole | null }>()

const emit = defineEmits<{ close: []; add: [] }>()

const roles = useModelRolesStore()
const providers = useProvidersStore()
const toast = useToast()

const query = ref('')
const applying = ref(false)

const TITLE: Record<ModelRole, string> = {
  llm: '选择主 LLM 模型',
  vision: '选择多模态（视觉）模型',
  asr: '选择 ASR 语音识别模型',
  embedding: '选择向量模型',
}

const title = computed(() => (props.role ? TITLE[props.role] : '选择模型'))
const hint = computed(() => (props.role ? KIND_HINT[props.role] : ''))

/** 当前生效项的 ref（列表打勾用） */
const currentRef = computed(() => {
  switch (props.role) {
    case 'llm':
      return roles.mainModel ? `model:${roles.mainModel.id}` : ''
    case 'vision':
      return providers.prefs.visionRef.startsWith('model:')
        ? providers.prefs.visionRef
        : roles.visionBound
          ? `model:${roles.visionBound.id}`
          : ''
    case 'asr': {
      const bound = providers.prefs.asrRef
      const live = roles.asrCurrent.model
      // 绑定只在「还和实配一致」时才算当前（在语音服务里改过就以实配为准）
      if (bound.startsWith('provider:') && parseRef(bound).b === live) return bound
      return live ? 'voice' : ''
    }
    case 'embedding':
      return roles.embeddingCurrent.ref
    default:
      return ''
  }
})

const all = computed(() => (props.role ? roles.candidatesFor(props.role) : []))

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return all.value
  return all.value.filter((c) =>
    `${c.label} ${c.provider} ${c.sub}`.toLowerCase().includes(q),
  )
})

watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      void roles.load()
    }
  },
)

async function pick(ref_: string): Promise<void> {
  if (!props.role || applying.value) return
  applying.value = true
  try {
    await roles.apply(props.role, ref_)
    emit('close')
  } catch (e) {
    // 切换失败必须说话：这条链路后端会真的抛（未适配的 ASR / 写配置失败 / 提供商已删）
    toast.toast(e instanceof Error ? e.message : '切换失败')
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" :title="title" initial-snap="large" @close="emit('close')">
    <div class="picker">
      <p v-if="hint" class="hint t-3">{{ hint }}</p>

      <ModelListToolbar
        :query="query"
        :count="filtered.length"
        :total="all.length"
        :folder="providers.prefs.providerNameFolder"
        :display="providers.prefs.providerNameDisplay"
        :loading="!roles.loaded"
        @update:query="query = $event"
        @update:folder="providers.savePrefs({ providerNameFolder: $event })"
        @update:display="providers.savePrefs({ providerNameDisplay: $event })"
      />

      <div class="list" data-rubber-self>
        <ModelCandidateList
          :items="filtered"
          :folder="providers.prefs.providerNameFolder"
          :display="providers.prefs.providerNameDisplay"
          :current-ref="currentRef"
          empty-text="没有可选的模型：先在提供商里拉一次模型清单，或手动添加一个模型"
          @select="pick"
        />
      </div>

      <!-- 列表下方还有动作 → 说明放这里，动作本身另开抽屉（不挤在本层里重排）。
           按钮只打开提供商表单，文案不许第二件事（手动模型的出口在提供商目录里） -->
      <button type="button" class="add" @click="emit('add')">
        <Plus :size="15" />
        添加提供商
      </button>
      <p class="hint t-3">
        选中即生效：主模型与多模态立即用于新消息，识别与向量会写入语音服务 / 知识库设置。
      </p>
    </div>
  </SheetModal>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding-bottom: var(--sp-12);
}

.hint {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* 弹层高度上限约半屏（参照里那条「多时给滚动、上限约 1/2 屏高」） */
.list {
  max-height: 50dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}
</style>
