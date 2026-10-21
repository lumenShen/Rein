<script setup lang="ts">
import { ref, watch } from 'vue'
import { Volume2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { voiceService } from '@/services/voiceService'
import { useToast } from '@/composables/useToast'
import type { AsrAdapter, TtsCredential, VoiceConfig } from '@/types'

/** 语音服务配置表单（模型页语音服务卡 → 编辑）。
 *
 * ASR 适配器双层选择机制：
 * - 第一层（用户未手选 = 「自动」）：检测 baseURL/模型名关键词 → 程序自动替选适配器并提示；
 *   关键词变化自动换向（百炼删了填 doubao → 自动改选豆包），清空后回到「自动」。
 * - 第二层（用户已手选豆包/百炼）：只弹推荐气泡（一键切换/忽略），绝不覆盖用户选择。
 * 凭据：豆包 = 旧版 App ID+Token / 新版 API Key；百炼 = API Key（Bearer，DASHSCOPE_API_KEY）。
 * 历史值 'qwen' 与 'bailian' 是同一协议（百炼/DashScope），读到时在表单里迁移为百炼。
 *
 * 朗读（豆包 TTS）凭据独立分区：
 * - 默认「跟随识别凭据」（豆包适配器下零配置可用）；
 * - 识别配百炼时豆包 TTS 无法继承凭据 → 提示并要求独立凭据才能朗读；
 * - 「独立凭据」开启后填写豆包凭据，保存进 ttsCredential（识别配置不受影响）。
 * 连通性测试：识别（WS 建连即结束）与朗读（试听任意音色）分开验证。 */
const props = defineProps<{ open: boolean; config: VoiceConfig | null }>()
const emit = defineEmits<{ close: []; saved: [config: VoiceConfig] }>()

const toast = useToast()

/** 双适配器世界的键（auto 之外的两种具体选择） */
type AdapterKey = 'doubao' | 'bailian'

const ADAPTER_META = {
  doubao: {
    label: '豆包',
    defaultUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async',
    defaultModel: 'volc.seedasr.sauc.duration',
  },
  bailian: {
    label: '百炼',
    defaultUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    // 2026-10-12 实测：run-task 协议下 paraformer-realtime-v2 / qwen-audio-3.1-asr-flash-streaming
    // / fun-asr-realtime 都可用，默认取中文效果最稳的 paraformer。
    defaultModel: 'paraformer-realtime-v2',
  },
} as const

/** 百炼（DashScope）实时识别可用模型（参考清单，可手填别的） */
const BAILIAN_MODELS = [
  'paraformer-realtime-v2',
  'qwen-audio-3.1-asr-flash-streaming',
  'fun-asr-realtime',
] as const

/** 可选音色：与 `src/ai/tools/voice.ts` 的 VOICE_PRESETS 同源（那份未导出、无法 import）。
 *  要增删音色时两处一起改，否则 AI 侧列得出的音色在这里选不到。 */
const VOICE_OPTIONS = [
  { id: 'zh_female_cancan_uranus_bigtts', label: '灿灿 · 女声 · 活泼清亮' },
  { id: 'zh_female_wanqudashu_emo_v2_mars_bigtts', label: '湾曲大叔 · 女声 · 沉稳磁性' },
  { id: 'zh_male_rouyi_jupiter_bigtts', label: '柔一 · 男声 · 温润自然' },
  { id: 'zh_male_beijingxiaoye_emo_v2_mars_bigtts', label: '北京小爷 · 男声 · 京味儿' },
  { id: 'zh_female_sichuan_niuniu_mars_bigtts', label: '川妹子 · 女声 · 四川口音' },
] as const

/** 关键词 → 适配器（与 Rust AsrAdapterKind::detect 同一套词表） */
function detectAdapter(url: string, model: string): AdapterKey | null {
  const s = `${url} ${model}`.toLowerCase()
  if (/(qwen|dashscope|aliyun|bailian|paraformer|fun-asr)/.test(s)) return 'bailian'
  if (/(doubao|volc|openspeech|bytedance|seedasr)/.test(s)) return 'doubao'
  return null
}

const mode = ref<'legacy' | 'new'>('legacy')
const appKey = ref('')
const accessKey = ref('')
const adapter = ref<AsrAdapter>('auto')
const asrBaseUrl = ref('')
const asrResourceId = ref('volc.seedasr.sauc.duration')

/** 朗读独立凭据分区 */
const ttsStandaloneOn = ref(false)
const ttsMode = ref<'legacy' | 'new'>('legacy')
const ttsAppKey = ref('')
const ttsAccessKey = ref('')

const ttsResourceId = ref('seed-tts-2.0')
const voiceName = ref('')
const speed = ref(1)

/** 用户手动点过具体适配器（离开「自动」层） */
const adapterTouched = ref(false)
/** 第一层自动替选的结果（提示条展示；字段清空后撤回回「自动」） */
const autoApplied = ref<AdapterKey | null>(null)
/** 第二层推荐气泡（不强改，可忽略） */
const suggestion = ref<AdapterKey | null>(null)
const suggestionDismissed = ref<AdapterKey | null>(null)

/** 表单生效中的适配器（自动层下 = 关键词识别结果，识别不出回落豆包） */
const effectiveAdapter = ref<AdapterKey>('doubao')

/** 朗读凭据是否不可用（识别配百炼且未开独立凭据 → 豆包 TTS 无法继承） */
const ttsBlocked = ref(false)

/** 双层选择求值：baseURL/模型名变化与手动切换适配器时都要跑一遍 */
function evaluateAdapter(): void {
  const detected = detectAdapter(asrBaseUrl.value, asrResourceId.value)
  effectiveAdapter.value = adapter.value !== 'auto' ? (adapter.value as AdapterKey) : detected ?? 'doubao'
  ttsBlocked.value = effectiveAdapter.value === 'bailian' && !ttsStandaloneOn.value
  if (!detected) {
    // 关键词消失：自动替选的撤回到「自动」
    if (autoApplied.value && !adapterTouched.value) {
      adapter.value = 'auto'
      autoApplied.value = null
    }
    suggestion.value = null
    return
  }
  if (!adapterTouched.value) {
    // 第一层：程序自动替选，跟随关键词换向
    if (adapter.value !== detected) {
      adapter.value = detected
      autoApplied.value = detected
    }
    suggestion.value = null
  } else if (adapter.value !== detected) {
    // 第二层：用户已手选 → 仅推荐，不覆盖
    if (suggestionDismissed.value !== detected) suggestion.value = detected
  } else {
    suggestion.value = null
    suggestionDismissed.value = null
  }
}

function toggleTtsStandalone(v: boolean): void {
  ttsStandaloneOn.value = v
  evaluateAdapter()
}

watch([asrBaseUrl, asrResourceId], () => evaluateAdapter())

function pickAdapter(a: AsrAdapter): void {
  adapter.value = a
  autoApplied.value = null
  suggestion.value = null
  suggestionDismissed.value = null
  adapterTouched.value = a !== 'auto'
  evaluateAdapter() // 手动切到与关键词冲突的适配器 → 立即给出推荐气泡
}

function applySuggestion(): void {
  if (!suggestion.value) return
  adapter.value = suggestion.value
  suggestion.value = null
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    const c = props.config
    mode.value = c?.mode ?? 'legacy'
    appKey.value = c?.appKey ?? ''
    accessKey.value = c?.accessKey ?? ''
    adapter.value = c?.asrAdapter ?? 'auto'
    // 历史值 'qwen' 与 'bailian' 同协议（百炼/DashScope）：读到即迁移，下次保存落新值
    if (adapter.value === 'qwen') adapter.value = 'bailian'
    adapterTouched.value = c?.asrAdapterUserPicked === true
    asrBaseUrl.value = c?.asrBaseUrl ?? ''
    const tc = c?.ttsCredential
    ttsStandaloneOn.value = !!tc?.appKey
    ttsMode.value = tc?.mode ?? 'legacy'
    ttsAppKey.value = tc?.appKey ?? ''
    ttsAccessKey.value = tc?.accessKey ?? ''
    asrResourceId.value = c?.asrResourceId || 'volc.seedasr.sauc.duration'
    ttsResourceId.value = c?.ttsResourceId || 'seed-tts-2.0'
    voiceName.value = c?.voiceName ?? ''
    speed.value = c?.speed ?? 1
    autoApplied.value = null
    suggestion.value = null
    suggestionDismissed.value = null
    evaluateAdapter()
  },
)

const saving = ref(false)

/** 组装朗读独立凭据：未开启或 Key 空 = null（继承识别凭据） */
function buildTtsCredential(): TtsCredential | null {
  if (!ttsStandaloneOn.value || !ttsAppKey.value.trim()) return null
  return {
    mode: ttsMode.value,
    appKey: ttsAppKey.value.trim(),
    accessKey: ttsAccessKey.value.trim(),
  }
}

async function onSave(): Promise<void> {
  if (!appKey.value.trim() || (effectiveAdapter.value === 'doubao' && mode.value === 'legacy' && !accessKey.value.trim())) {
    toast.toast('请填写完整的识别凭据')
    return
  }
  const ttsCred = buildTtsCredential()
  if (ttsCred && ttsCred.mode === 'legacy' && !ttsCred.accessKey) {
    toast.toast('请填写朗读独立凭据的 Access Token')
    return
  }
  saving.value = true
  const config: VoiceConfig = {
    mode: mode.value,
    appKey: appKey.value.trim(),
    accessKey: accessKey.value.trim(),
    asrAdapter: adapter.value,
    asrAdapterUserPicked: adapterTouched.value,
    asrBaseUrl: asrBaseUrl.value.trim(),
    ttsCredential: ttsCred,
    asrResourceId: asrResourceId.value.trim() || ADAPTER_META[effectiveAdapter.value].defaultModel,
    ttsResourceId: ttsResourceId.value.trim() || 'seed-tts-2.0',
    voiceName: voiceName.value.trim(),
    speed: Math.min(3, Math.max(0.2, speed.value || 1)),
  }
  try {
    await voiceService.configSave(config)
    toast.toast('语音服务配置已保存')
    emit('saved', config)
    emit('close')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}

/** 识别连通性测试：先保存当前表单，再用配置建一次识别连接立即结束 */
const probing = ref(false)

async function onAsrProbe(): Promise<void> {
  if (probing.value) return
  probing.value = true
  try {
    await onSave()
    await voiceService.asrProbe()
    toast.toast('识别服务连通正常 ✓')
  } catch (e) {
    toast.toast(`识别连通失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    probing.value = false
  }
}

/** 试听音色：先保存当前表单（探测读取已存配置），再用表单里的音色合成短句播放 */
const trying = ref(false)

async function onTry(): Promise<void> {
  if (trying.value) return
  trying.value = true
  try {
    await onSave()
    const { audioUrl } = await voiceService.ttsProbe(voiceName.value.trim() || undefined)
    if (!audioUrl) throw new Error('未获得音频')
    const a = new Audio(audioUrl)
    await a.play()
    toast.toast('试听已播放')
  } catch (e) {
    toast.toast(`试听失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    trying.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="语音服务（识别与朗读）" initial-snap="large" @close="emit('close')">
    <div class="form">
      <label class="f-label">识别适配器</label>
      <div class="mode-seg">
        <button :class="{ on: adapter === 'auto' }" @click="pickAdapter('auto')">自动识别</button>
        <button :class="{ on: adapter === 'doubao' }" @click="pickAdapter('doubao')">豆包</button>
        <button :class="{ on: adapter === 'bailian' }" @click="pickAdapter('bailian')">百炼</button>
      </div>
      <!-- 第一层：自动替选提示 -->
      <p v-if="autoApplied" class="auto-notice">
        检测到{{ ADAPTER_META[autoApplied].label }}关键词，已自动选择{{ ADAPTER_META[autoApplied].label }}适配器（跟随输入变化）
      </p>
      <!-- 第二层：推荐气泡（用户已手选，不强改） -->
      <div v-if="suggestion" class="suggestion">
        <span>检测到{{ ADAPTER_META[suggestion].label }}关键词，建议切换适配器</span>
        <button class="sgo" @click="applySuggestion">切换到{{ ADAPTER_META[suggestion].label }}</button>
        <button class="sgx" @click="suggestionDismissed = suggestion; suggestion = null">忽略</button>
      </div>

      <!-- 识别服务地址：术语（WebSocket / baseURL）与「留空 = 默认」都收进行尾的胶囊与 InfoHint -->
      <div class="label-row">
        <label class="f-label">识别服务地址</label>
        <StatusChip tone="neutral" size="sm">留空用默认</StatusChip>
        <span class="hint-slot">
          <InfoHint
            title="识别服务地址"
            content="识别服务的连接地址，通常不用改：留空就用所选适配器的默认端点。只有服务商给了你专用地址、或要连自建服务时才填。完整地址形如 wss://openspeech.bytedance.com/api/v3/...，以 WebSocket（wss://）开头。"
          />
        </span>
      </div>
      <input
        v-model="asrBaseUrl"
        type="text"
        class="mono"
        aria-label="识别服务地址"
        :placeholder="ADAPTER_META[effectiveAdapter].defaultUrl"
      >

      <template v-if="effectiveAdapter === 'doubao'">
        <label class="f-label">凭据模式</label>
        <div class="mode-seg">
          <button :class="{ on: mode === 'legacy' }" @click="mode = 'legacy'">旧版 · App ID + Token</button>
          <button :class="{ on: mode === 'new' }" @click="mode = 'new'">新版 · API Key</button>
        </div>

        <label class="f-label">{{ mode === 'new' ? 'API Key' : 'App ID' }}</label>
        <input v-model="appKey" type="text" autocomplete="off" :aria-label="mode === 'new' ? 'API Key' : 'App ID'" placeholder="控制台获取">
        <!-- 头名是服务端协议细节，降成字段下的次要说明，不再冒充字段名 -->
        <p class="f-hint">{{ mode === 'new' ? '请求头 X-Api-Key' : '请求头 X-Api-App-Key' }}</p>

        <template v-if="mode === 'legacy'">
          <label class="f-label">Access Token</label>
          <input v-model="accessKey" type="password" autocomplete="new-password" aria-label="Access Token" placeholder="控制台获取">
          <p class="f-hint">请求头 X-Api-Access-Key</p>
        </template>

        <label class="f-label">识别模型标识</label>
        <input v-model="asrResourceId" type="text" class="mono" aria-label="识别模型标识" placeholder="volc.seedasr.sauc.duration">
        <p class="f-hint">留空用默认模型</p>
      </template>

      <template v-else>
        <label class="f-label">API Key</label>
        <input v-model="appKey" type="password" autocomplete="new-password" aria-label="API Key" placeholder="阿里云百炼 API Key">
        <p class="f-hint">请求头 Authorization: Bearer（环境变量写作 DASHSCOPE_API_KEY）</p>
        <label class="f-label">识别模型标识</label>
        <input
          v-model="asrResourceId"
          type="text"
          class="mono"
          aria-label="识别模型标识"
          list="bailian-asr-models"
          placeholder="paraformer-realtime-v2"
        >
        <p class="f-hint">可手填，也可从下拉里选一个已验证可用的模型</p>
        <datalist id="bailian-asr-models">
          <option v-for="m in BAILIAN_MODELS" :key="m" :value="m" />
        </datalist>
      </template>

      <div class="acts">
        <button class="try" :disabled="probing || saving" @click="onAsrProbe">
          {{ probing ? '测试中…' : '测试识别连通' }}
        </button>
      </div>

      <div class="divider" />

      <label class="f-label">朗读合成（豆包 TTS）· 凭据</label>
      <div class="mode-seg">
        <button :class="{ on: !ttsStandaloneOn }" @click="toggleTtsStandalone(false)">跟随识别凭据</button>
        <button :class="{ on: ttsStandaloneOn }" @click="toggleTtsStandalone(true)">独立凭据</button>
      </div>
      <p v-if="ttsBlocked" class="warn-notice">
        识别适配器是百炼，朗读凭据无法继承（豆包 TTS 只认豆包凭据）——请切换到「独立凭据」填入豆包 Key，否则纪要朗读不可用。
      </p>

      <template v-if="ttsStandaloneOn">
        <label class="f-label">朗读凭据模式</label>
        <div class="mode-seg">
          <button :class="{ on: ttsMode === 'legacy' }" @click="ttsMode = 'legacy'">旧版 · App ID + Token</button>
          <button :class="{ on: ttsMode === 'new' }" @click="ttsMode = 'new'">新版 · API Key</button>
        </div>

        <label class="f-label">{{ ttsMode === 'new' ? 'API Key' : 'App ID' }}</label>
        <input v-model="ttsAppKey" type="text" autocomplete="off" :aria-label="ttsMode === 'new' ? 'API Key' : 'App ID'" placeholder="控制台获取">
        <p class="f-hint">{{ ttsMode === 'new' ? '请求头 X-Api-Key' : '请求头 X-Api-App-Key' }}</p>

        <template v-if="ttsMode === 'legacy'">
          <label class="f-label">Access Token</label>
          <input v-model="ttsAccessKey" type="password" autocomplete="new-password" aria-label="Access Token" placeholder="控制台获取">
          <p class="f-hint">请求头 X-Api-Access-Key</p>
        </template>
      </template>

      <div class="label-row">
        <label class="f-label">朗读模型标识（纪要朗读）</label>
        <span class="hint-slot">
          <InfoHint
            title="朗读模型标识"
            content="朗读用的合成模型。留空用默认值 seed-tts-2.0（豆包 2.0 音色协议）；要换版本或服务商指定的型号时才改。"
          />
        </span>
      </div>
      <input v-model="ttsResourceId" type="text" class="mono" aria-label="朗读模型标识" placeholder="seed-tts-2.0">

      <div class="label-row">
        <label class="f-label">朗读音色</label>
        <StatusChip tone="neutral" size="sm">留空用默认音色</StatusChip>
        <span class="hint-slot">
          <InfoHint
            title="朗读音色"
            content="音色用服务商的音色 ID 指定（协议里写作 voice_type，2.0 音色协议）。可以手填 ID，也可以从下拉里选一个；选完点下面的「试听音色」先听再保存。"
          />
        </span>
      </div>
      <input
        v-model="voiceName"
        type="text"
        class="mono"
        aria-label="朗读音色"
        list="voice-presets"
        placeholder="如 zh_female_cancan_uranus_bigtts"
      >
      <datalist id="voice-presets">
        <option v-for="v in VOICE_OPTIONS" :key="v.id" :value="v.id">{{ v.label }}</option>
      </datalist>
      <label class="f-label">语速（0.2 ~ 3.0）</label>
      <input v-model.number="speed" type="number" step="0.1" min="0.2" max="3" aria-label="语速">

      <div class="acts">
        <button class="try" :disabled="trying || saving" @click="onTry">
          <Volume2 :size="14" /> {{ trying ? '合成中…' : '试听音色' }}
        </button>
        <button class="save" :disabled="saving" @click="onSave">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  padding-bottom: var(--sp-10);
}

.hint,
.auto-notice {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.auto-notice {
  /* soft 底上的文字走 strong 档（STANDARDS §4） */
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-xs);
  padding: var(--sp-6) var(--sp-10);
  margin-top: var(--sp-6);
}

.warn-notice {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  /* --c-warn 这个 token 从来不存在，原先的 #b45309 回退值就是真实生效值，
     且在暗色下对比度不足；收口到有明暗两档的 warn 家族 */
  color: var(--warn-strong);
  background: var(--warn-soft);
  border-radius: var(--radius-xs);
  padding: var(--sp-6) var(--sp-10);
  margin-top: var(--sp-6);
}

.divider {
  height: 1px;
  background: var(--surface-3);
  margin: var(--gap-lg) 0 var(--gap-tight);
}

/* 第二层推荐气泡：只提示不强改 */
.suggestion {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex-wrap: wrap;
  margin-top: var(--gap-sm);
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-s);
  background: var(--ok-soft);
  color: var(--ok-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 推荐气泡里的两枚小按钮：高 28（--control-sm）、左右 12，与全库小按钮同档 */
.suggestion .sgo,
.suggestion .sgx {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

/* 28 的小按钮命中区补到 44（纵向各 8，横向不扩：两枚只隔 8，扩了会互相抢） */
.suggestion .sgo::after,
.suggestion .sgx::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--gap-sm)) 0;
  border-radius: inherit;
}

.suggestion .sgo {
  background: var(--ok);
  color: var(--on-accent);
}

.suggestion .sgx {
  background: var(--surface);
  color: var(--text-2);
}

.f-label {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  margin-top: var(--gap-sm);
}

/* 标签行：字段名 + 行尾胶囊 / InfoHint（同一行不放第二枚图标按钮，落点见 InfoHint 注释） */
.label-row {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  flex-wrap: wrap;
}

.label-row .f-label {
  margin-top: var(--sp-8);
}

/* InfoHint 是多根片段，类不会透传到按钮上 —— 用一层 span 占位再推到行尾 */
.label-row .hint-slot {
  margin-left: auto;
  display: inline-flex;
}

/* 协议头名 / 机制说明降到这里：次要说明档，不再是字段名 */
.f-hint {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.form input {
  width: 100%;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
}

.form input.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
}

.mode-seg {
  display: flex;
  background: var(--surface-2);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
}

.mode-seg button {
  position: relative;
  flex: 1;
  /* 段高 28 + 轨道内距 2×2 = 整体 32（HarmonyOS 分段按钮规格）；
     原先 30 让整体到 34，比同页输入框还高一档 */
  height: var(--control-sm);
  border-radius: var(--radius-xs);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 28 的分段项命中区补到 44（纵向各 8）：两段各占一半宽度，横向不扩、互不重叠 */
.mode-seg button::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--gap-sm)) 0;
  border-radius: inherit;
}

.mode-seg button.on {
  background: var(--surface);
  color: var(--text-1);
  font-weight: var(--fw-bold);
  box-shadow: var(--shadow-thumb);
}

.acts {
  display: flex;
  gap: var(--sp-8);
  margin-top: var(--sp-16);
}

.acts button {
  flex: 1;
  /* 常规按钮 40（--control-md）：原先 42 落在两个档位之间 */
  min-height: var(--control-md);
  border-radius: var(--radius-full);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-6);
}

.try {
  background: var(--accent-soft);
  /* soft 底上的文字走 strong 档（STANDARDS §4） */
  color: var(--accent-strong);
}

.save {
  background: var(--accent);
  color: var(--on-accent);
}

/* 禁用浓度全站同一档（tokens.css），不再各写各的裸值 */
.acts button:disabled {
  opacity: var(--disabled-opacity);
}
</style>
