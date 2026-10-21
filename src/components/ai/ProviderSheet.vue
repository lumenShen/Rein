<script setup lang="ts">
/**
 * 提供商详情抽屉：凭据摘要 → 拉模型清单 → 预览几条 → 启用。
 *
 * 列表只放**前几条预览**，「查看全部」另开一层抽屉（ProviderModelsSheet）——
 * 目录动辄几十条，在详情里展开会把下面的说明与按钮一路推下去（DOM 重排），
 * 而抽屉是独立一层：展开多少都不动底下的页面。
 */
import { computed, ref } from 'vue'
import { AlertCircle, Pencil, RefreshCw } from 'lucide-vue-next'

import ModelCandidateList from '@/components/ai/ModelCandidateList.vue'
import ProviderModelsSheet from '@/components/ai/ProviderModelsSheet.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { KIND_LABEL } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { useModelRolesStore } from '@/stores/modelRoles'
import { useProvidersStore } from '@/stores/providers'
import type { AiProvider } from '@/types'

/** 详情里预览几条（其余去「查看全部」） */
const PREVIEW = 5

const props = defineProps<{ open: boolean; provider: AiProvider | null }>()

const emit = defineEmits<{ close: []; edit: [AiProvider] }>()

const providers = useProvidersStore()
const roles = useModelRolesStore()
const toast = useToast()

const allOpen = ref(false)
const activating = ref('')

/** 一律读 store 里的那一行：拉目录/启用之后 store 会整表刷新，
 *  组件若抱着打开时的那份快照，目录就不会跟着更新 */
const live = computed(() =>
  props.provider ? (providers.providerOf(props.provider.id) ?? props.provider) : null,
)

const adapter = computed(() => (live.value ? providers.adapterOf(live.value.adapter) : undefined))
const catalog = computed(() => (live.value ? providers.catalogs[live.value.id] : undefined))
const busy = computed(() => (live.value ? !!providers.fetching[live.value.id] : false))

/** 预览行：按类别排好（对话 → 视觉 → 识别 → 向量），每类最多几条 */
const preview = computed(() => {
  const p = live.value
  if (!p) return []
  const order = ['llm', 'vision', 'asr', 'embedding', 'tts']
  return [...p.models]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.modelId.localeCompare(b.modelId))
    .slice(0, PREVIEW)
    .map((m) => ({
      ref: `${p.id}:${m.modelId}`,
      label: m.modelId,
      // 状态只由行尾徽章（使用中）独家承担，副标题里不再重复「已启用」
      sub: `${KIND_LABEL[m.kind]}${m.origin === 'preset' ? ' · 内置参考' : m.origin === 'manual' ? ' · 手填' : ''}`,
      provider: p.name,
      kind: m.kind,
      badge: roles.isActive(p, m) ? '使用中' : undefined,
    }))
})

async function fetchModels(): Promise<void> {
  const p = live.value
  if (!p) return
  const result = await providers.fetchModels(p.id)
  if (!result) return
  if (result.ok) toast.toast(`已拉到 ${result.models.length} 个模型`)
  else toast.toast(result.error ?? '拉取失败')
}

/** 预览行点一下 = 启用（按类别落到对应执行位） */
async function activateByRef(ref_: string): Promise<void> {
  const p = live.value
  if (!p) return
  const modelId = ref_.slice(`${p.id}:`.length)
  const model = p.models.find((m) => m.modelId === modelId)
  if (!model || activating.value) return
  activating.value = ref_
  try {
    const msg = await roles.activate(p, model)
    toast.toast(msg)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '启用失败')
  } finally {
    activating.value = ''
  }
}

const keyTail = computed(() => (live.value?.apiKey ? live.value.apiKey.slice(-4) : ''))
</script>

<template>
  <SheetModal :open="open" :title="live?.name ?? '提供商'" initial-snap="large" @close="emit('close')">
    <div v-if="live" class="pv">
      <!-- 凭据摘要：编辑走另一个抽屉（不在本层展开表单） -->
      <section class="card cred">
        <div class="row between center">
          <span class="row center gap">
            <b class="ad-label">{{ adapter?.label ?? live.adapter }}</b>
            <i class="style">{{ adapter?.styles.find((s) => s.id === live!.apiStyle)?.label ?? live.apiStyle }}</i>
          </span>
          <button type="button" class="edit" @click="emit('edit', live)">
            <Pencil :size="13" />
            编辑
          </button>
        </div>
        <p class="kv t-2">{{ live.baseUrl }}</p>
        <p class="kv t-3">
          密钥 ****{{ keyTail }}<template v-if="live.lastSyncAt">
            · 上次同步 {{ live.lastSyncAt.slice(0, 16).replace('T', ' ') }}</template>
        </p>
        <p v-if="live.lastError" class="err">
          <AlertCircle :size="13" />
          {{ live.lastError }}
        </p>
        <div class="row gap">
          <button type="button" class="btn primary" :disabled="busy" @click="fetchModels">
            <RefreshCw :size="14" :class="{ spin: busy }" />
            {{ busy ? '拉取中…' : '获取模型列表' }}
          </button>
        </div>
        <p v-if="catalog?.fromPreset" class="hint t-3">
          接口没通，下面列的是内置参考目录：可以手填模型 ID，或确认地址/密钥后重试。
        </p>
      </section>

      <!-- 目录预览：只放前几条，全部另开抽屉 -->
      <section class="card list-card">
        <div class="row between center">
          <span class="l l-hint">
            模型目录（{{ live.models.length }}）
            <InfoHint
              title="类别与写入位置"
              content="点一条即启用，按类别落到对应位置：

对话 / 视觉模型进入「全部模型」；识别模型写进语音服务；向量模型写进知识库设置。

启用状态以本机实际配置为准（这里只做「启用」）；换用哪个模型，去模型页的「服务模型」卡。"
            />
          </span>
          <button type="button" class="more" @click="allOpen = true">查看全部 ›</button>
        </div>
        <StatusChip tone="accent" size="md">点一条即启用</StatusChip>
        <ModelCandidateList
          :items="preview"
          :folder="false"
          :display="false"
          :active-of="(c) => !!c.badge"
          empty-text="还没有目录：点上面「获取模型列表」，或在全部模型里手填一个"
          @select="activateByRef"
        />
      </section>
    </div>

    <ProviderModelsSheet
      :open="allOpen"
      :provider="live"
      @close="allOpen = false"
      @activated="toast.toast($event)"
    />
  </SheetModal>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding-bottom: var(--sp-10);
}

.card {
  padding: var(--pad-card-tight) var(--pad-card);
}

.cred {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.ad-label {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.style {
  display: inline-flex;
  align-items: center;
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  min-height: var(--chip-h);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

.edit {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--accent);
}

.kv {
  font-size: var(--fs-caption);
  word-break: break-all;
}

.err {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--danger);
  word-break: break-all;
}

.btn {
  flex: 1;
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

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.btn:disabled {
  opacity: var(--disabled-opacity);
}

.list-card {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.l {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

/* 标题行带帮助入口：标签与 ? 同一行居中 */
.l-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
}

.more {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--accent);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* 转圈走 base.css 的共享 keyframes */
.spin {
  animation: rein-spin 0.9s linear infinite;
}
</style>
