<script setup lang="ts">
/**
 * 添加/编辑提供商：选适配器 → 选接入方式 → 填凭据 → 拉模型清单。
 *
 * 三件事刻意做成「选而不是填」：
 * 1. 适配器与接入方式都是注册表里选（默认地址、支持的模型类别、专属字段都随选择变），
 *    用户不需要去翻文档抄地址；
 * 2. 专属凭据字段由适配器声明（如火山语音的 App ID / Access Token），
 *    按字段类型渲染成密钥输入或普通输入；
 * 3. 保存后直接拉一次 `/models` —— 拉通了下一步就能启用模型，拉不通也当场看到原因。
 */
import { computed, ref, watch } from 'vue'
import { AlertCircle, Check, CloudDownload, Trash2 } from 'lucide-vue-next'

import SecretInput from '@/components/ai/fields/SecretInput.vue'
import UrlInput from '@/components/ai/fields/UrlInput.vue'
import ActionSheet from '@/components/common/ActionSheet.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { KIND_LABEL } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { useProvidersStore } from '@/stores/providers'
import type { AiProvider } from '@/types'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** 传入 = 编辑；null = 新建 */
    provider: AiProvider | null
    /** 新建时的预选适配器（从「某适配器还没配」的入口进来） */
    initialAdapter?: string
  }>(),
  { initialAdapter: '' },
)

const emit = defineEmits<{ close: []; saved: [number] }>()

const providers = useProvidersStore()
const toast = useToast()

const adapterId = ref('volc-ark')
const styleId = ref('')
const name = ref('')
const baseUrl = ref('')
const apiKey = ref('')
const extra = ref<Record<string, string>>({})
const urlTouched = ref(false)
const saving = ref(false)
const fetching = ref(false)
const confirming = ref(false)
/** 拉取结果提示（成功/失败都留一行，用户不必猜） */
const fetchNote = ref<{ ok: boolean; text: string } | null>(null)

const editing = computed(() => !!props.provider)
const adapter = computed(() => providers.adapterOf(adapterId.value))
const style = computed(
  () => adapter.value?.styles.find((s) => s.id === styleId.value) ?? adapter.value?.styles[0],
)

/**
 * 适配器分组：注册表里带了默认服务地址的是「内置适配器」（选完就能用，地址随接入方式带出），
 * 一条默认地址都没有、endpoint 要自己填的归「自定义」。
 *
 * 分组规则不是前端另抄一份名单，而是从 AdapterInfo 本身推出来的，所以后端
 * `modules/ai/providers.rs` 的 `ADAPTERS` 现在与将来都自动一致：目前正是
 * 火山方舟 / 阿里云百炼 / DeepSeek / 硅基流动 4 张内置 + openai-compatible 1 张自定义。
 * 5 张纵向卡片一次平铺超出工作记忆上限，两个组头把「选谁」拆成两步
 * （additive：卡片结构、选中态、点击行为一概不变）。
 */
const customAdapters = computed(() =>
  providers.adapters.filter((a) => a.styles.every((s) => s.baseUrl === '')),
)
const builtinAdapters = computed(() =>
  providers.adapters.filter((a) => !customAdapters.value.some((c) => c.id === a.id)),
)
/** 渲染顺序：内置在前、自定义在后；空组连组头一起不渲染 */
const adapterGroups = computed(() =>
  [
    { label: '内置适配器', items: builtinAdapters.value },
    { label: '自定义', items: customAdapters.value },
  ].filter((g) => g.items.length > 0),
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    fetchNote.value = null
    urlTouched.value = false
    if (props.provider) {
      adapterId.value = props.provider.adapter
      styleId.value = props.provider.apiStyle
      name.value = props.provider.name
      baseUrl.value = props.provider.baseUrl
      apiKey.value = props.provider.apiKey
      extra.value = parseExtra(props.provider.extra)
    } else {
      adapterId.value = props.initialAdapter || providers.adapters[0]?.id || 'volc-ark'
      const a = providers.adapterOf(adapterId.value)
      styleId.value = a?.styles[0]?.id ?? ''
      name.value = a?.nickname ?? ''
      baseUrl.value = a?.styles[0]?.baseUrl ?? ''
      apiKey.value = ''
      extra.value = {}
    }
  },
)

function parseExtra(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v ?? {})) out[k] = String(val ?? '')
    return out
  } catch {
    return {}
  }
}

/** 换适配器：地址、昵称、接入方式、专属字段整套跟着换 */
function pickAdapter(id: string): void {
  if (editing.value) return
  adapterId.value = id
  const a = providers.adapterOf(id)
  styleId.value = a?.styles[0]?.id ?? ''
  name.value = a?.nickname ?? ''
  baseUrl.value = a?.styles[0]?.baseUrl ?? ''
  urlTouched.value = false
  extra.value = {}
  fetchNote.value = null
}

function pickStyle(id: string): void {
  styleId.value = id
  const s = adapter.value?.styles.find((x) => x.id === id)
  // 地址没被手动改过就跟着接入方式走（改过就保留用户的地址）
  if (s && (!urlTouched.value || !baseUrl.value.trim())) baseUrl.value = s.baseUrl
}

const canSave = computed(
  () => !!adapterId.value && !!baseUrl.value.trim() && !saving.value && !fetching.value,
)

function extraJson(): string | null {
  const clean = Object.fromEntries(
    Object.entries(extra.value).filter(([, v]) => v.trim() !== ''),
  )
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null
}

async function save(thenFetch: boolean): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  fetchNote.value = null
  try {
    const saved = await providers.save({
      id: props.provider?.id ?? null,
      adapter: adapterId.value,
      name: name.value.trim() || (adapter.value?.nickname ?? adapterId.value),
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      apiStyle: styleId.value || (adapter.value?.styles[0]?.id ?? ''),
      extra: extraJson(),
    })
    if (!saved) throw new Error('保存失败')
    toast.toast(editing.value ? '已保存' : `已添加提供商「${saved.name}」`)
    emit('saved', saved.id)
    if (thenFetch) {
      fetching.value = true
      const result = await providers.fetchModels(saved.id)
      if (result?.ok) {
        fetchNote.value = { ok: true, text: `拉到 ${result.models.length} 个模型（${result.elapsedMs}ms）` }
        toast.toast(`已拉到 ${result.models.length} 个模型，去「模型」里启用`)
        emit('close')
      } else if (result) {
        fetchNote.value = {
          ok: false,
          text: result.error ?? '拉取失败',
        }
      }
    } else {
      emit('close')
    }
  } catch (e) {
    fetchNote.value = { ok: false, text: e instanceof Error ? e.message : String(e) }
  } finally {
    saving.value = false
    fetching.value = false
  }
}

const deleteActions = computed(() => [
  { label: `删除「${props.provider?.name ?? ''}」及其目录`, value: 'delete', danger: true },
])

async function onDelete(value: string): Promise<void> {
  confirming.value = false
  if (value !== 'delete' || !props.provider) return
  await providers.remove(props.provider.id)
  toast.toast('已删除提供商（已启用的模型不受影响）')
  emit('close')
}
</script>

<template>
  <SheetModal :open="open" :title="editing ? '编辑提供商' : '添加提供商'" initial-snap="large" @close="emit('close')">
    <template #action>
      <!-- 富内容（URL 带 <code>）走默认插槽；面上只留结论一行 -->
      <InfoHint title="存储与拉取说明">
        <p>
          密钥只存在本机（与模型配置同一套存储）；拉清单走本机直连
          <code>{{ (baseUrl || '…').replace(/\/+$/, '') }}{{ adapter?.modelsPath || '' }}</code>
          ，不通时会列出内置参考目录，也可以手填模型 ID。
        </p>
      </InfoHint>
    </template>
    <div class="form">
      <!-- 适配器：新建时可选；编辑时锁定（换适配器等于换一个账号）。
           分两组呈现（内置 / 自定义）：卡片本身与从前逐字一致，只多两个组头。 -->
      <div class="field">
        <p class="l">适配器</p>
        <div class="adapters">
          <template v-for="(g, gi) in adapterGroups" :key="`${gi}-${g.label}`">
            <p class="grp">{{ g.label }}</p>
            <button
              v-for="a in g.items"
              :key="a.id"
              type="button"
              class="ad"
              :class="{ on: a.id === adapterId, locked: editing }"
              :disabled="editing && a.id !== adapterId"
              @click="pickAdapter(a.id)"
            >
              <b>{{ a.label }}</b>
              <small>{{ a.hint }}</small>
              <span class="kinds">
                <i v-for="k in a.kinds" :key="k">{{ KIND_LABEL[k] }}</i>
              </span>
            </button>
          </template>
        </div>
      </div>

      <!-- 接入方式（API 计划） -->
      <div v-if="(adapter?.styles.length ?? 0) > 0" class="field">
        <p class="l">接入方式</p>
        <div class="styles">
          <button
            v-for="s in adapter?.styles ?? []"
            :key="s.id"
            type="button"
            class="st"
            :class="{ on: s.id === styleId }"
            @click="pickStyle(s.id)"
          >
            <span class="row center gap">
              <Check v-if="s.id === styleId" :size="14" />
              <b>{{ s.label }}</b>
            </span>
            <small>{{ s.note }}</small>
          </button>
        </div>
      </div>

      <label class="row center label" for="pv-name">
        <span class="l">昵称</span>
        <input id="pv-name" v-model="name" type="text" :placeholder="adapter?.nickname" >
      </label>

      <div class="field">
        <p class="l">服务地址</p>
        <UrlInput
          id="pv-base"
          v-model="baseUrl"
          :default-base-url="style?.baseUrl ?? ''"
          :hint="style?.baseUrl ? `默认：${style.baseUrl}` : '填服务商给的 base 地址（通常以 /v1 结尾）'"
          @update:model-value="urlTouched = true"
        />
      </div>

      <div class="field">
        <p class="l">API Key</p>
        <SecretInput
          id="pv-key"
          v-model="apiKey"
          :saved-tail="provider?.apiKey ? provider.apiKey.slice(-4) : null"
          :hint="adapter?.keyHint"
          :aria-label="`${adapter?.label ?? ''} 的 API Key`"
        />
      </div>

      <!-- 适配器专属字段（如火山语音的 App ID / Access Token） -->
      <div v-for="f in adapter?.extraFields ?? []" :key="f.key" class="field">
        <p class="l">{{ f.label }}</p>
        <SecretInput
          v-if="f.secret"
          :id="`pv-x-${f.key}`"
          :model-value="extra[f.key] ?? ''"
          :hint="f.hint"
          :placeholder="f.placeholder"
          :aria-label="f.label"
          @update:model-value="extra = { ...extra, [f.key]: $event }"
        />
        <template v-else>
          <label class="row center label" :for="`pv-x-${f.key}`">
            <input
              :id="`pv-x-${f.key}`"
              :value="extra[f.key] ?? ''"
              type="text"
              autocapitalize="off"
              spellcheck="false"
              :placeholder="f.placeholder"
              @input="extra = { ...extra, [f.key]: ($event.target as HTMLInputElement).value }"
            >
          </label>
          <p class="hint t-3">{{ f.hint }}</p>
        </template>
      </div>

      <p v-if="fetchNote" class="note" :class="{ bad: !fetchNote.ok }">
        <AlertCircle v-if="!fetchNote.ok" :size="13" />
        <Check v-else :size="13" />
        {{ fetchNote.text }}
      </p>

      <div class="row gap btns">
        <button type="button" class="btn primary" :disabled="!canSave" @click="save(true)">
          <CloudDownload :size="15" />
          {{ fetching ? '拉取中…' : editing ? '保存并重新拉取' : '保存并拉取模型' }}
        </button>
        <button type="button" class="btn" :disabled="!canSave" @click="save(false)">
          {{ saving ? '保存中…' : '仅保存' }}
        </button>
      </div>

      <button v-if="editing" type="button" class="del" @click="confirming = true">
        <Trash2 :size="14" />
        删除提供商
      </button>

      <p class="hint t-3">密钥只存本机；拉不到清单时会给出内置参考目录，也可手填模型 ID</p>
    </div>

    <ActionSheet
      :open="confirming"
      title="删除提供商后目录一并删除；已启用的模型仍在"
      :actions="deleteActions"
      @close="confirming = false"
      @select="onDelete"
    />
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  padding-bottom: var(--sp-10);
}

.l {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.label {
  gap: var(--gap-md);
  background: var(--surface-2);
  border-radius: var(--radius-m);
  padding: 0 var(--sp-16);
}

.label .l {
  width: 64px;
  flex: none;
}

.label input {
  flex: 1;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0;
  font-size: var(--fs-subhead);
}

.adapters {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

/* 组头：比字段标签再降一档（小号 + --text-3），把 5 张卡片拆成「内置 / 自定义」两步，
   而不是靠卡片本身的边框或缩进去扮演分组（那会改变卡片自己的视觉重量） */
.grp {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.ad {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  padding: var(--sp-12) var(--sp-16);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
}

.ad b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.ad small {
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.ad.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}

.ad.locked:not(.on) {
  opacity: var(--disabled-opacity);
}

.kinds {
  display: flex;
  gap: var(--gap-sm);
  flex-wrap: wrap;
}

.kinds i {
  display: inline-flex;
  align-items: center;
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  min-height: var(--chip-h);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-3);
  color: var(--text-2);
}

.styles {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.st {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  padding: var(--sp-12) var(--sp-16);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
}

.st b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.st small {
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.st.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.st.on small {
  color: var(--accent);
}

.btns {
  gap: var(--gap-sm);
}

.btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.btn.primary {
  flex: 1.4;
  background: var(--accent);
  color: var(--on-accent);
}

.btn:disabled {
  opacity: var(--disabled-opacity);
}

.del {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-l);
  color: var(--danger);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.note {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--ok-strong);
  word-break: break-all;
}

.note.bad {
  color: var(--danger);
}

.hint {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-caption);
  background: var(--surface-2);
  border-radius: var(--radius-xs);
  padding: var(--sp-2) var(--sp-4);
  word-break: break-all;
}
</style>
