/** 提供商（服务商账号 + 模型目录）与模型页界面偏好。
 *
 * 职责边界：这里只管「账号 + 目录 + 偏好」的读写；**启用模型**（把目录里的一条
 * 落到 ai_models / 语音配置 / 知识库设置）与角色候选在 stores/modelRoles.ts，
 * 因为那三处的真源分别是 models store、voiceService、kbService。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { kindCounts, providerNickname } from '@/ai/providerCatalog'
import { providerService } from '@/services/providerService'
import type {
  AiModelPrefs,
  AiProvider,
  AiProviderInput,
  AiProviderModel,
  ProviderAdapter,
  ProviderCatalog,
  ProviderModelKind,
} from '@/types'

/** 一条「某提供商下的某模型」 */
export interface ProviderModelRef {
  provider: AiProvider
  model: AiProviderModel
}

const DEFAULT_PREFS: AiModelPrefs = {
  visionRef: 'auto',
  asrRef: 'voice',
  embeddingRef: '',
  providerNameDisplay: true,
  providerNameFolder: true,
}

export const useProvidersStore = defineStore('ai-providers', () => {
  const adapters = ref<ProviderAdapter[]>([])
  const providers = ref<AiProvider[]>([])
  const prefs = ref<AiModelPrefs>({ ...DEFAULT_PREFS })
  const loaded = ref(false)
  const error = ref<string | null>(null)
  /** 正在拉清单的提供商 id 集合 */
  const fetching = ref<Record<number, boolean>>({})
  /** 最近一次拉取结果（含错误与内置目录回退），键 = 提供商 id */
  const catalogs = ref<Record<number, ProviderCatalog>>({})

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    try {
      const [a, p, pre] = await Promise.all([
        providerService.adapters(),
        providerService.list(),
        providerService.prefsGet(),
      ])
      adapters.value = a
      providers.value = p
      prefs.value = { ...DEFAULT_PREFS, ...pre }
      loaded.value = true
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  function adapterOf(id: string): ProviderAdapter | undefined {
    return adapters.value.find((a) => a.id === id)
  }

  function providerOf(id: number): AiProvider | undefined {
    return providers.value.find((p) => p.id === id)
  }

  /** provider 字段 → 展示昵称（模型名前缀与折叠分组都用它） */
  function nickname(provider: string): string {
    return providerNickname(provider, adapters.value)
  }

  /** 多模态槽位绑定的模型主键（visionRef = model:<id> 时才有；供 bestVisionModel 用） */
  function visionBoundId(): number | null {
    const ref = prefs.value.visionRef
    if (!ref.startsWith('model:')) return null
    const id = Number(ref.slice('model:'.length))
    return Number.isFinite(id) && id > 0 ? id : null
  }

  async function save(input: AiProviderInput): Promise<AiProvider | null> {
    try {
      const saved = await providerService.save(input)
      await load(true)
      return saved
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  async function remove(id: number): Promise<void> {
    await providerService.remove(id)
    delete catalogs.value[id]
    await load(true)
  }

  /** 拉模型清单并落库；结果（含错误/内置回退）存进 catalogs 供卡片显示 */
  async function fetchModels(id: number): Promise<ProviderCatalog | null> {
    const p = providerOf(id)
    if (!p || fetching.value[id]) return null
    fetching.value[id] = true
    try {
      const result = await providerService.fetch(id, p.adapter, p.baseUrl, p.apiKey)
      catalogs.value[id] = result
      await load(true)
      return result
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      fetching.value[id] = false
    }
  }

  /** 只拉不存：表单里「填完先试一下」用 */
  async function testFetch(
    adapterId: string,
    baseUrl: string,
    apiKey: string,
  ): Promise<ProviderCatalog | null> {
    try {
      return await providerService.fetch(null, adapterId, baseUrl, apiKey)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function addModel(
    providerId: number,
    modelId: string,
    kind: ProviderModelKind,
  ): Promise<void> {
    await providerService.modelAdd(providerId, modelId, kind)
    await load(true)
  }

  async function removeModel(providerId: number, modelId: string): Promise<void> {
    await providerService.modelRemove(providerId, modelId)
    await load(true)
  }

  async function savePrefs(patch: Partial<AiModelPrefs>): Promise<void> {
    const next = { ...prefs.value, ...patch }
    prefs.value = next
    try {
      prefs.value = await providerService.prefsSave(next)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 目录里的全部模型（摊平） */
  const allModels = computed<ProviderModelRef[]>(() =>
    providers.value.flatMap((provider) => provider.models.map((model) => ({ provider, model }))),
  )

  /** 某类别的全部候选（模型页/工具都用它） */
  function modelsByKind(kind: ProviderModelKind): ProviderModelRef[] {
    return allModels.value.filter((r) => r.model.kind === kind)
  }

  /** 提供商卡片摘要：按类别计数（口径在 providerCatalog，模型页与这里共用） */
  const summaryOf = kindCounts

  return {
    adapters,
    providers,
    prefs,
    loaded,
    error,
    fetching,
    catalogs,
    allModels,
    load,
    adapterOf,
    providerOf,
    nickname,
    visionBoundId,
    save,
    remove,
    fetchModels,
    testFetch,
    addModel,
    removeModel,
    savePrefs,
    modelsByKind,
    summaryOf,
  }
})
