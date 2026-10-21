<script setup lang="ts">
/**
 * 提供商模型目录（全部）：搜索 + 类别筛选 + 按提供商折叠 + 逐条启用 + 手填模型。
 *
 * 这是「查看全部」的那一层抽屉：目录几十条时不挤在详情里，搜索与筛选也只在这一层
 * 出现（详情里只有预览）。
 */
import { computed, ref, watch } from 'vue'
import { Check, Plus, Trash2 } from 'lucide-vue-next'

import ModelListToolbar from '@/components/ai/ModelListToolbar.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { KIND_LABEL } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { useModelRolesStore } from '@/stores/modelRoles'
import { useProvidersStore } from '@/stores/providers'
import type { AiProvider, ProviderModelKind } from '@/types'

const props = defineProps<{ open: boolean; provider: AiProvider | null }>()

const emit = defineEmits<{ close: []; activated: [string] }>()

const providers = useProvidersStore()
const roles = useModelRolesStore()
const toast = useToast()

const query = ref('')
const kindFilter = ref<ProviderModelKind | 'all'>('all')
const busyRef = ref('')
/** 手填模型 */
const manualId = ref('')
const manualKind = ref<ProviderModelKind>('llm')
const adding = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    kindFilter.value = 'all'
    manualId.value = ''
    void roles.load()
  },
)

/** 一律读 store 里的那一行：加/删目录条目之后 store 会整表刷新 */
const live = computed(() =>
  props.provider ? (providers.providerOf(props.provider.id) ?? props.provider) : null,
)

const kinds = computed<ProviderModelKind[]>(() => {
  const p = live.value
  if (!p) return []
  const a = providers.adapterOf(p.adapter)
  const seen = new Set<ProviderModelKind>()
  for (const m of p.models) seen.add(m.kind)
  // 适配器声明的类别也列出来（即使目录里暂时没有），方便手填
  for (const k of a?.kinds ?? []) seen.add(k)
  return ['llm', 'vision', 'asr', 'embedding', 'tts'].filter((k) =>
    seen.has(k as ProviderModelKind),
  ) as ProviderModelKind[]
})

interface Row {
  ref: string
  label: string
  sub: string
  provider: string
  kind: ProviderModelKind
  badge?: string
}

const rows = computed<Row[]>(() => {
  const p = live.value
  if (!p) return []
  const q = query.value.trim().toLowerCase()
  return p.models
    .filter((m) => kindFilter.value === 'all' || m.kind === kindFilter.value)
    .filter((m) => !q || `${m.modelId} ${m.kind}`.toLowerCase().includes(q))
    .map((m) => {
      const active = roles.isActive(p, m)
      return {
        ref: m.modelId,
        label: m.modelId,
        // 状态只由行尾胶囊（使用中）独家承担，副标题里不再重复「已启用」
        sub: `${KIND_LABEL[m.kind]}${
          m.origin === 'preset' ? ' · 内置参考（接口清单里没有）' : m.origin === 'manual' ? ' · 手填' : ''
        }`,
        provider: p.name,
        kind: m.kind,
        badge: active ? '使用中' : undefined,
      }
    })
    // 类别内按名称**降序**：与「服务模型选项」同向（新版模型名通常更长更新，排在上方）
    .sort((a, b) => a.kind.localeCompare(b.kind) || b.label.localeCompare(a.label))
})

async function activate(row: Row): Promise<void> {
  const p = live.value
  if (!p || busyRef.value) return
  const model = p.models.find((m) => m.modelId === row.ref)
  if (!model) return
  busyRef.value = row.ref
  try {
    const msg = await roles.activate(p, model)
    emit('activated', msg)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '启用失败')
  } finally {
    busyRef.value = ''
  }
}

async function addManual(): Promise<void> {
  const p = live.value
  const id = manualId.value.trim()
  if (!p || !id || adding.value) return
  adding.value = true
  try {
    await providers.addModel(p.id, id, manualKind.value)
    manualId.value = ''
    toast.toast(`已加入目录：${id}`)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '添加失败')
  } finally {
    adding.value = false
  }
}

async function removeRow(row: Row): Promise<void> {
  const p = live.value
  if (!p) return
  await providers.removeModel(p.id, row.ref)
  toast.toast('已从目录移除（接口清单里的条目下次同步会回来）')
}

const isManual = (row: Row): boolean => {
  const m = live.value?.models.find((x) => x.modelId === row.ref)
  return m?.origin === 'manual'
}
</script>

<template>
  <SheetModal :open="open" :title="`${provider?.name ?? ''} · 模型目录`" initial-snap="large" @close="emit('close')">
    <div class="cat">
      <ModelListToolbar
        :query="query"
        :count="rows.length"
        :total="provider?.models.length ?? 0"
        :folder="providers.prefs.providerNameFolder"
        :display="providers.prefs.providerNameDisplay"
        placeholder="搜索模型 ID"
        @update:query="query = $event"
        @update:folder="providers.savePrefs({ providerNameFolder: $event })"
        @update:display="providers.savePrefs({ providerNameDisplay: $event })"
      />

      <!-- 类别筛选 -->
      <div class="row kinds">
        <button
          type="button"
          class="kchip"
          :class="{ on: kindFilter === 'all' }"
          @click="kindFilter = 'all'"
        >
          全部
        </button>
        <button
          v-for="k in kinds"
          :key="k"
          type="button"
          class="kchip"
          :class="{ on: kindFilter === k }"
          @click="kindFilter = k"
        >
          {{ KIND_LABEL[k] }}
        </button>
      </div>

      <div class="list" data-rubber-self>
        <p v-if="rows.length === 0" class="none t-3">
          没有匹配的模型：清空搜索，或先在提供商详情里点「获取模型列表」；本层底部也可以手填一个模型 ID
        </p>
        <ul v-else>
          <li v-for="r in rows" :key="r.ref" class="row center item">
            <button
              type="button"
              class="flex-1 min0 main"
              :disabled="busyRef === r.ref"
              @click="activate(r)"
            >
              <b>{{ r.label }}</b>
              <small>{{ r.sub }}</small>
            </button>
            <span v-if="r.badge" class="on-chip">
              <Check :size="12" />
              {{ r.badge }}
            </span>
            <button v-else type="button" class="use" :disabled="busyRef === r.ref" @click="activate(r)">
              {{ busyRef === r.ref ? '启用中…' : '启用' }}
            </button>
            <button v-if="isManual(r)" type="button" class="rm" aria-label="从目录移除" @click="removeRow(r)">
              <Trash2 :size="14" />
            </button>
          </li>
        </ul>
      </div>

      <!-- 手填模型：接口清单里没有、或该服务商没有 /models 接口 -->
      <section class="manual">
        <p class="l">手填模型 ID</p>
        <div class="row gap">
          <input
            v-model="manualId"
            class="mid"
            type="text"
            placeholder="如 doubao-seed-1.6"
            autocapitalize="off"
            spellcheck="false"
            @keyup.enter="addManual"
          >
          <select v-model="manualKind" class="mkind" aria-label="模型类别">
            <option v-for="k in kinds" :key="k" :value="k">{{ KIND_LABEL[k] }}</option>
          </select>
          <button type="button" class="add" :disabled="!manualId.trim() || adding" @click="addManual">
            <Plus :size="14" />
          </button>
        </div>
        <p class="hint t-3">手填的条目不会被同步清掉；类别决定它启用后归到哪个用途（对话 / 视觉 / 语音识别 / 向量）。</p>
      </section>
    </div>
  </SheetModal>
</template>

<style scoped>
.cat {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding-bottom: var(--sp-10);
}

.kinds {
  gap: var(--gap-sm);
  flex-wrap: wrap;
}

/* 筛选项也是要读的（这一组有哪些类型）：高 24、左右 12、12 Medium */
.kchip {
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.kchip.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.list {
  max-height: 46dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.none {
  text-align: center;
  padding: var(--sp-24) 0;
  font-size: var(--fs-footnote);
}

.item {
  gap: var(--gap-sm);
  min-height: var(--row-h-double);
  padding: 0 var(--sp-2);
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.main {
  text-align: left;
}

.main b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  word-break: break-all;
}

.main small {
  display: block;
  margin-top: var(--gap-text);
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.use {
  flex: none;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.use:disabled {
  opacity: var(--disabled-opacity);
}

.on-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  flex: none;
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--ok-soft);
  color: var(--ok-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.rm {
  position: relative;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

/* 28 的移除钮命中区撑到 44：它在行尾，横向只管往左扩到条目自身宽度内 */
.rm::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.manual {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  padding: var(--pad-card-tight) var(--pad-inline);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}

.l {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.mid {
  flex: 1;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-subhead);
}

.mkind {
  flex: none;
  min-height: var(--control-md);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.add {
  flex: none;
  width: 40px;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.add:disabled {
  opacity: var(--disabled-opacity);
}

.hint {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}
</style>
