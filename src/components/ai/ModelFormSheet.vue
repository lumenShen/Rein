<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { useModelsStore } from '@/stores/models'
import { useOnlineServiceStore } from '@/stores/onlineService'
import { DEFAULT_IMAGE_EDGE } from '@/utils/image'
import type { AiModel } from '@/types'

/**
 * 添加/编辑 AI 模型：名称、接入方式（预设 baseUrl）、API Key、模型 ID。
 * 「在线服务」这一档的模型 ID 只能从服务端下发的清单里选 —— 服务端决定客户端能用哪些模型。
 */
const props = defineProps<{
  open: boolean
  /** 传入 = 编辑；null = 新增 */
  model: AiModel | null
}>()

const emit = defineEmits<{
  close: []
  saved: [id: number]
}>()

const store = useModelsStore()
const online = useOnlineServiceStore()
const toast = useToast()

/** provider 预设：切换时自动填 baseUrl（用户手动改过则保留） */
const PROVIDER_PRESETS: Record<string, { label: string; baseUrl: string; models: string[] }> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  'openai-compatible': {
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gemini-2.5-flash'],
  },
  'rein-online': {
    // 地址/密钥/模型清单都来自「Rein 在线服务」卡（服务端下发）
    label: '在线服务',
    baseUrl: '',
    models: [],
  },
}

const name = ref('')
const provider = ref('deepseek')
const baseUrl = ref('')
const apiKey = ref('')
const modelId = ref('')
const isDefault = ref(false)
/** 手动模型的可选单价（元/百万 tokens）：填了管理页就能算本机成本 */
const priceIn = ref('')
const priceOut = ref('')
/** 发给该模型的图片最长边（像素）：越大看得越清，也越耗流量与上下文 */
const imageMaxEdge = ref<number>(DEFAULT_IMAGE_EDGE)
/** 发送分辨率档位：覆盖常见视觉模型的输入上限 */
const IMAGE_EDGE_OPTIONS = [
  { value: '1024', label: '1024' },
  { value: '2048', label: '2048' },
  { value: '3072', label: '3072' },
  { value: '4096', label: '4096' },
]
const urlTouched = ref(false)

const editing = computed(() => props.model)
const providerLabel = computed(() => PROVIDER_PRESETS[provider.value]?.label ?? provider.value)
/** 在线服务档：地址/密钥/模型清单都由服务端下发，这几个字段在这里只读 */
const isOnline = computed(() => provider.value === 'rein-online')

/** 在线档：确保设置与目录已加载（进表单就能选模型，不用先去卡片里点一次） */
async function ensureOnline(): Promise<void> {
  await online.load()
  if (!online.settings.apiKey) return
  if (!online.catalog) await online.refresh()
  if (baseUrl.value.trim() === '') baseUrl.value = `${online.settings.baseUrl.replace(/\/+$/, '')}/v1`
  if (apiKey.value.trim() === '') apiKey.value = online.settings.apiKey
  if (!modelId.value.trim() && online.models.length > 0) modelId.value = online.models[0]!.id
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.model) {
      name.value = props.model.name
      provider.value = props.model.provider
      baseUrl.value = props.model.baseUrl
      apiKey.value = props.model.apiKey
      modelId.value = props.model.modelId
      isDefault.value = props.model.isDefault
      imageMaxEdge.value = props.model.imageMaxEdge ?? DEFAULT_IMAGE_EDGE
      priceIn.value = props.model.priceIn ? String(props.model.priceIn) : ''
      priceOut.value = props.model.priceOut ? String(props.model.priceOut) : ''
      urlTouched.value = true
      if (props.model.source === 'online') void ensureOnline()
    } else {
      const p = PROVIDER_PRESETS.deepseek
      name.value = ''
      provider.value = 'deepseek'
      baseUrl.value = p.baseUrl
      apiKey.value = ''
      modelId.value = p.models[0]!
      isDefault.value = store.models.length === 0
      priceIn.value = ''
      priceOut.value = ''
      urlTouched.value = false
    }
  },
)

function onProviderChange(v: string): void {
  provider.value = v
  const preset = PROVIDER_PRESETS[v]
  if (!preset) return
  if (v === 'rein-online') {
    void ensureOnline()
    return
  }
  if (!urlTouched.value || !props.model) baseUrl.value = preset.baseUrl
  if (!modelId.value || !props.model) modelId.value = preset.models[0]!
}

const canSave = computed(
  () =>
    name.value.trim() !== '' &&
    baseUrl.value.trim() !== '' &&
    apiKey.value.trim() !== '' &&
    modelId.value.trim() !== '' &&
    !saving.value,
)
const saving = ref(false)
const title = computed(() => (editing.value ? '编辑模型' : '添加模型'))

/** 单价输入 → 数字；空/非法为 null（=不计模型费） */
function parsePrice(raw: string): number | null {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const input = {
      name: name.value.trim(),
      provider: provider.value,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      modelId: modelId.value.trim(),
      isDefault: isDefault.value,
      imageMaxEdge: imageMaxEdge.value,
      // 在线模型的单价以服务端为准（Rust 侧也会忽略这两个字段）
      priceIn: isOnline.value ? null : parsePrice(priceIn.value),
      priceOut: isOnline.value ? null : parsePrice(priceOut.value),
    }
    if (editing.value) {
      await store.update(editing.value.id, input)
      toast.toast('已保存，重新测试能力')
      emit('saved', editing.value.id)
    } else {
      const created = await store.add(input)
      toast.toast('已添加，正在测试能力')
      emit('saved', created.id)
    }
    emit('close')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" :title="title" @close="emit('close')">
    <template #action>
      <InfoHint title="保存时会做什么">
        <p>{{ providerLabel }} 兼容 OpenAI 接口；保存后发送 max_tokens=1 的测试包探测「看图 / 深度思考 / 思考强度」能力。</p>
        <p>测试包只花极少量额度；结果写回模型的能力胶囊，之后也可以随时重新测试。</p>
      </InfoHint>
    </template>
    <div class="form">
      <label class="row center label" for="ai-name">
        <span class="l">名称</span>
        <input id="ai-name" v-model="name" type="text" placeholder="例如：DeepSeek 视觉" />
      </label>

      <div class="field">
        <p class="l">接入方式</p>
        <SegmentedControl
          class="provider"
          :model-value="provider"
          :options="Object.entries(PROVIDER_PRESETS).map(([k, v]) => ({ value: k, label: v.label }))"
          @update:model-value="onProviderChange($event as string)"
        />
      </div>

      <label class="row center label" for="ai-base" :class="{ locked: isOnline }">
        <span class="l">接口地址</span>
        <input
          id="ai-base"
          v-model="baseUrl"
          type="text"
          inputmode="url"
          :readonly="isOnline"
          placeholder="https://api.deepseek.com"
          @input="urlTouched = true"
        />
      </label>

      <label class="row center label" for="ai-key" :class="{ locked: isOnline }">
        <span class="l">API Key</span>
        <input
          id="ai-key"
          v-model="apiKey"
          :type="isOnline ? 'text' : 'password'"
          autocomplete="off"
          :readonly="isOnline"
          placeholder="sk-…"
        />
      </label>

      <label v-if="!isOnline" class="row center label" for="ai-model">
        <span class="l">模型 ID</span>
        <input id="ai-model" v-model="modelId" type="text" list="ai-model-suggestions" placeholder="deepseek-flash" />
        <datalist id="ai-model-suggestions">
          <option v-for="m in PROVIDER_PRESETS[provider]?.models ?? []" :key="m" :value="m" />
        </datalist>
      </label>
      <label v-else class="row center label" for="ai-model-online">
        <span class="l">模型</span>
        <select id="ai-model-online" v-model="modelId" class="select">
          <option v-for="m in online.models" :key="m.id" :value="m.id">
            {{ m.id }} · {{ m.providerName }}{{ m.priced ? ` · 输入 ¥${m.priceIn} / 输出 ¥${m.priceOut}（每百万 tokens）` : ' · 未定价（按流量计费）' }}
          </option>
        </select>
      </label>

      <p v-if="isOnline" class="edge-hint t-3">
        在线模型的清单、单价与流量价由服务端决定；换可用模型去管理页的「Rein 在线服务」卡同步，
        这里改的是本机名称与默认项。
      </p>

      <div v-if="!isOnline" class="field">
        <p class="l">单价（可选，元/百万 tokens）</p>
        <div class="prices">
          <label class="pcell">
            <span class="t-3">输入</span>
            <input v-model="priceIn" type="text" inputmode="decimal" placeholder="0" />
          </label>
          <label class="pcell">
            <span class="t-3">输出</span>
            <input v-model="priceOut" type="text" inputmode="decimal" placeholder="0" />
          </label>
        </div>
        <p class="edge-hint t-3">填了才会在管理页显示该模型的本机累计花费（自付给 provider 的钱，按官方价填即可）。</p>
      </div>

      <div class="field">
        <p class="l">图片发送分辨率</p>
        <SegmentedControl
          class="provider"
          :model-value="String(imageMaxEdge)"
          :options="IMAGE_EDGE_OPTIONS"
          @update:model-value="imageMaxEdge = Number($event)"
        />
        <p class="edge-hint t-3">发给该模型的图片最长边（像素）。默认 2048 覆盖多数视觉模型；调大看得更清，也更耗流量与上下文。</p>
      </div>

      <div class="row between center">
        <p class="l">设为默认</p>
        <!-- 共享 ToggleSwitch（51×31 iOS 规格）：替掉原先自造的 52×31 开关，
             role=switch + aria-checked 与 spring 滑块都由共享组件负责 -->
        <ToggleSwitch v-model="isDefault" label="设为默认" />
      </div>

      <button type="button" class="save" :disabled="!canSave" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <small class="hint t-3">保存后自动探测该模型是否支持看图、深度思考与思考强度</small>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  padding: 0 0 var(--sp-12);
}

.l {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

/* 输入框贯通行（参照里的「整行浅井」）：--surface-inset 浅井 + 16 圆角 + 左右 16 + 高 48 */
.label {
  gap: var(--gap-md);
  min-height: var(--row-h);
  background: var(--surface-inset);
  border-radius: var(--radius-m);
  padding: 0 var(--sp-16);
}

.label .l {
  width: 84px;
  flex: none;
}

.label input {
  flex: 1;
  min-width: 0;
  min-height: var(--row-h);
  padding: 0;
  font-size: var(--fs-subhead);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
}

/* 在线档：地址与密钥由服务端下发，这里只读 */
.label.locked {
  opacity: 0.75;
}

.label.locked input {
  color: var(--text-2);
}

.select {
  flex: 1;
  min-width: 0;
  min-height: var(--row-h);
  padding: 0;
  font-size: var(--fs-subhead);
  background: transparent;
  color: var(--text-1);
  text-align: right;
}

.prices {
  display: flex;
  gap: var(--sp-8);
}

.pcell {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-height: var(--row-h);
  background: var(--surface-inset);
  border-radius: var(--radius-m);
  padding: 0 var(--sp-12);
}

.pcell span {
  font-size: var(--fs-caption);
  flex: none;
}

.pcell input {
  flex: 1;
  min-width: 0;
  min-height: var(--row-h);
  padding: 0;
  font-size: var(--fs-subhead);
}

.provider :deep(button) {
  flex: 1;
  justify-content: center;
}

.edge-hint {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.save {
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.save:disabled {
  opacity: var(--disabled-opacity);
}

.hint {
  text-align: center;
  line-height: var(--lh-body);
}
</style>
