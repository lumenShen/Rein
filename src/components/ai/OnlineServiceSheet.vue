<script setup lang="ts">
/**
 * Rein 在线服务（状态抽屉）：地址 + 密钥 + 可用模型 + 调用条件 + 使用说明 + 双端对账。
 *
 * 从「卡片点进来」改成整层抽屉的原因：这里是**查看状态**的地方（服务地址、密钥、
 * 全部可用模型、账号调用条件、成本对账），内容比一行摘要多得多；摊在模型页里
 * 会把下面的提供商列表推得很远，而且每次同步都要重排一次。
 *
 * 三条原则照旧：
 * 1. 模型由服务端指定：只列服务端回的模型，导入的模型 ID 不受用户手填；
 * 2. 必须有密钥：没填密钥时按钮禁用，401/403 的服务端中文错误原样透出；
 * 3. 成本双端各算一份：本机账本（离线可看）+ 服务端账本（权威，可刷新对账）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { AlertCircle, Check, CloudDownload, RefreshCw, Server } from 'lucide-vue-next'

import ModelListToolbar from '@/components/ai/ModelListToolbar.vue'
import SecretInput from '@/components/ai/fields/SecretInput.vue'
import UrlInput from '@/components/ai/fields/UrlInput.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { formatCnyNano } from '@/ai/cost'
import { groupByProvider, modelDisplayName } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { useModelsStore } from '@/stores/models'
import { useOnlineServiceStore } from '@/stores/onlineService'
import { useProvidersStore } from '@/stores/providers'
import type { OnlineModel } from '@/types'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: []; synced: [] }>()

const online = useOnlineServiceStore()
const models = useModelsStore()
const providers = useProvidersStore()
const toast = useToast()

const baseUrl = ref('')
const apiKey = ref('')
const query = ref('')
const syncing = ref(false)

const statusTone = computed(() => {
  if (online.ready) return 'ok'
  if (!online.hasKey) return 'idle'
  return 'warn'
})

const pickedCount = computed(() => online.picked.length)

/** 搜索过滤后的目录（保持服务端顺序） */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return online.models
  return online.models.filter((m) =>
    `${m.id} ${m.providerName} ${m.providerId}`.toLowerCase().includes(q),
  )
})

/** 按提供商分组（沿用列表渲染声明：前缀 / 折叠） */
const groups = computed(() =>
  groupByProvider(
    filtered.value,
    (m: OnlineModel) => m.providerName || m.providerId || '服务端',
    providers.prefs.providerNameFolder,
  ),
)

function labelOf(m: OnlineModel): string {
  const provider = m.providerName || m.providerId || ''
  return modelDisplayName(m.id, provider, providers.prefs.providerNameDisplay)
}

function priceText(m: OnlineModel): string {
  if (!m.priced) return '未定价（按流量计费）'
  return `输入 ¥${m.priceIn} / 输出 ¥${m.priceOut} 每百万 tokens`
}

/** 流量计费方向（对账公式与说明卡共用） */
const trafficScopeText = computed(() => {
  const s = online.catalog?.trafficScope
  return s === 'both' ? '双向' : s === 'ingress' ? '入方向' : '出方向'
})

/** 两账差额结论：服务端账 - 本机账。服务端账还没拉到就不给结论 */
const diffLabel = computed<{ tone: 'ok' | 'warn'; text: string } | null>(() => {
  if (!online.usage?.ok) return null
  const d = online.usage.costTotal - models.totalCostNano / 1e9
  if (Math.abs(d) < 0.005) return { tone: 'ok', text: '两账一致' }
  const who = d > 0 ? '服务端' : '本机'
  return { tone: 'warn', text: `${who}多 ¥${Math.abs(d).toFixed(4)}` }
})

const serverCostNano = computed(() => Math.round((online.usage?.costTotal ?? 0) * 1e9))

onMounted(async () => {
  await online.load()
  baseUrl.value = online.settings.baseUrl
  apiKey.value = online.settings.apiKey
})

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    query.value = ''
    await online.load()
    baseUrl.value = online.settings.baseUrl
    apiKey.value = online.settings.apiKey
    // 打开即静默核对一次：第一眼是上次成功的目录（不再每次都显示「待连接」），
    // 核对完自动更正；失败不覆盖快照，错误原文照显示在状态卡里，可主动重试
    if (online.hasKey) await online.refresh(true)
  },
)

/** 连接：保存设置 → 拉目录（失败原因由服务端给，逐字展示） */
async function connect(silent = false): Promise<void> {
  if (!apiKey.value.trim()) {
    toast.toast('先填服务端签发的密钥（rein_sk_…）')
    return
  }
  await online.saveSettings({ baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim() })
  const result = await online.refresh()
  if (result?.ok) {
    void online.refreshUsage()
    if (!silent) toast.toast(`服务端可用模型 ${result.models.length} 个`)
  } else if (result) {
    toast.toast(result.error ?? '连接失败')
  }
}

/** 断开：清掉本机保存的密钥（已导入的模型还在，但下次同步/调用会因无密钥失败） */
async function disconnect(): Promise<void> {
  await online.disconnect()
  apiKey.value = ''
  toast.toast('已断开在线服务（服务密钥已清空）')
}

/** 导入选中模型（服务端撤下的同源模型会被清掉，手动添加的不受影响） */
async function importPicked(): Promise<void> {
  syncing.value = true
  try {
    const result = await online.sync()
    if (!result) {
      toast.toast(online.error ?? '导入失败')
      return
    }
    await models.load(true)
    await models.loadUsage()
    emit('synced')
    const parts = [`新增 ${result.added}`, `更新 ${result.updated}`]
    if (result.removed > 0) parts.push(`清理 ${result.removed}`)
    toast.toast(`已同步：${parts.join(' · ')}`)
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="Rein 在线服务" initial-snap="large" @close="emit('close')">
    <div class="onl">
      <!-- 状态 + 调用条件：这一句是「还能不能用」的答案 -->
      <section class="card head-card">
        <div class="row between center">
          <span class="row center gap">
            <span class="ic"><Server :size="14" /></span>
            <b>接口状态</b>
          </span>
          <i class="chip" :class="`chip-${statusTone}`">{{ online.statusText }}</i>
        </div>
        <p class="acct">{{ online.accountText }}</p>
        <p v-if="online.error" class="err">
          <AlertCircle :size="13" />
          {{ online.error }}
        </p>
      </section>

      <!-- 地址 + 密钥 -->
      <section class="card">
        <p class="l">服务地址</p>
        <UrlInput
          id="osc-base"
          v-model="baseUrl"
          placeholder="http://47.100.36.179:8787"
          hint="服务端网关地址；末尾斜杠会自动去掉"
        />
        <p class="l">服务密钥</p>
        <SecretInput
          id="osc-key"
          v-model="apiKey"
          :saved-tail="online.settings.apiKey ? online.settings.apiKey.slice(-4) : null"
          placeholder="rein_sk_…"
          hint="密钥由服务端签发，决定这个客户端能用哪些模型；只存在本机"
          aria-label="Rein 在线服务密钥"
        />
        <div class="row gap acts">
          <button type="button" class="btn primary" :disabled="online.loading || !apiKey.trim()" @click="connect()">
            <RefreshCw :size="14" :class="{ spin: online.loading }" />
            {{ online.loading ? '获取中…' : '获取模型列表' }}
          </button>
          <button v-if="online.hasKey" type="button" class="btn" @click="disconnect">断开</button>
        </div>
      </section>

      <!-- 可用模型（服务端下发） -->
      <section v-if="online.models.length > 0" class="card cornered">
        <!-- 胶囊按钮固定在本卡右上角（不是跟在标签文字右边）：标签自己一行，
             操作是「这张卡的动作」，位置钉死才不会随标签长短左右漂 -->
        <button
          type="button"
          class="pill"
          :aria-label="pickedCount === online.models.length ? '全部取消勾选' : '全部勾选'"
          @click="online.pickAll(pickedCount !== online.models.length)"
        >
          {{ pickedCount === online.models.length ? '全不选' : '全选' }}
        </button>
        <p class="l l-hint">
          可用模型（{{ online.models.length }}）
          <InfoHint
            title="导入与同步"
            content="导入后这些模型出现在「全部模型」里（标记「在线」）。服务端撤下的模型会在下次同步时清掉，自己填 key 的模型不受影响。"
          />
        </p>
        <ModelListToolbar
          :query="query"
          :count="filtered.length"
          :total="online.models.length"
          :folder="providers.prefs.providerNameFolder"
          :display="providers.prefs.providerNameDisplay"
          placeholder="搜索模型 ID 或提供商"
          @update:query="query = $event"
          @update:folder="providers.savePrefs({ providerNameFolder: $event })"
          @update:display="providers.savePrefs({ providerNameDisplay: $event })"
        />
        <div class="list" data-rubber-self>
          <section v-for="g in groups" :key="g.provider || '_'" class="grp">
            <p v-if="providers.prefs.providerNameFolder" class="grp-head t-2">{{ g.provider }}</p>
            <ul>
              <li v-for="m in g.items" :key="m.id">
                <button
                  type="button"
                  class="row center m"
                  :class="{ on: online.picked.includes(m.id) }"
                  @click="online.toggle(m.id)"
                >
                  <span class="tick" :class="{ on: online.picked.includes(m.id) }">
                    <Check :size="11" />
                  </span>
                  <span class="flex-1 min0 mt">
                    <b>{{ labelOf(m) }}</b>
                    <em>{{ priceText(m) }}</em>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </div>
        <p class="concl">
          <PillChip tone="muted" size="sm">导入后可随时重新同步</PillChip>
        </p>
        <button type="button" class="btn primary" :disabled="syncing || pickedCount === 0" @click="importPicked">
          <CloudDownload :size="14" />
          {{ syncing ? '同步中…' : `导入所选（${pickedCount}）` }}
        </button>
      </section>

      <!-- 成本：两端各算一份 -->
      <section class="card cost cornered">
        <button
          type="button"
          class="pill"
          :disabled="!online.hasKey"
          aria-label="刷新服务端账本"
          @click="online.refreshUsage()"
        >
          <RefreshCw :size="12" />
          刷新服务端
        </button>
        <p class="l">成本对账</p>
        <div class="crow">
          <span>本机累计（估算）</span>
          <b class="num">{{ formatCnyNano(models.totalCostNano) }}</b>
        </div>
        <div class="csub">
          <span class="num">模型费 {{ formatCnyNano(models.totalModelNano) }} · 流量费 {{ formatCnyNano(models.totalTrafficNano) }}</span>
          <span class="num">{{ models.usage?.total.calls ?? 0 }} 次调用 · 近 {{ models.usage?.days ?? 30 }} 天</span>
        </div>
        <div class="crow">
          <span>服务端累计（权威）</span>
          <b class="num">{{ online.usage?.ok ? formatCnyNano(serverCostNano) : '—' }}</b>
        </div>
        <div class="csub">
          <span v-if="online.usage?.ok" class="num">
            模型费 ¥{{ online.usage.costTokens.toFixed(4) }} · 流量费 ¥{{ online.usage.costTraffic.toFixed(4) }}
            · 出方向 {{ ((online.usage.bytesOut ?? 0) / 1024 / 1024).toFixed(2) }} MB
          </span>
          <span v-else>{{ online.hasKey ? '点「刷新服务端」拉取' : '未配置密钥' }}</span>
        </div>
        <!-- 两账差额做成结论：对得上 / 差多少一眼可见，不用逐位比两行数字 -->
        <div v-if="diffLabel" class="diff">
          <StatusChip :tone="diffLabel.tone" size="sm">{{ diffLabel.text }}</StatusChip>
        </div>
      </section>

      <!-- 使用说明：面上只留计价结论，四条明细收进标题行 InfoHint
           （第 1 条与输入框下的密钥 hint 同内容，不重复） -->
      <section class="card use">
        <p class="l l-hint">
          使用说明
          <InfoHint title="使用说明">
            <p>模型清单、单价与流量价全部由服务端下发，本机不猜也不让手填模型 ID。</p>
            <p>导入后直接用：把其中一条设为主模型（模型页「服务模型」卡）即可开始对话/识别。</p>
            <p>
              计价 = 官方页价（服务端不溢价）+ 服务器流量 {{ online.catalog?.trafficPerGb ?? 0.8 }} 元/GB（{{ trafficScopeText }}）；本机按同一公式估算，服务端的账为准。
            </p>
          </InfoHint>
        </p>
        <p class="concl">
          <PillChip tone="muted" size="md">
            计价 = 官方页价 + 流量 {{ online.catalog?.trafficPerGb ?? 0.8 }} 元/GB
          </PillChip>
        </p>
      </section>
    </div>
  </SheetModal>
</template>

<style scoped>
.onl {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding-bottom: var(--sp-12);
}

.card {
  padding: var(--pad-card-tight) var(--pad-card);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.head-card {
  gap: var(--gap-sm);
}

/* 头部徽章：统一 token-soft（与设置页 / 同步页 / 模型页的图标章同一套），
   整面 accent-soft 底 + accent 图标，撤掉手写渐变 hex */
.ic {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-s);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.head-card b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.chip {
  display: inline-flex;
  align-items: center;
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-full);
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
}

.chip-ok {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.chip-idle {
  background: var(--surface-2);
  color: var(--text-2);
}

.chip-warn {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}

.acct {
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.l {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

/* 标题行带帮助入口：标签与 ? 同一行居中（胶囊按钮仍钉在右上角，互不冲突） */
.l-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
}

/* 卡面结论：一行胶囊，明细收进 InfoHint */
.concl {
  display: flex;
}

.diff {
  margin-top: var(--sp-2);
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

.acts {
  gap: var(--gap-sm);
  margin-top: var(--sp-2);
}

.btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.acts .btn + .btn {
  flex: none;
  padding-left: var(--sp-18);
  padding-right: var(--sp-18);
  color: var(--text-2);
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.btn:disabled {
  opacity: var(--disabled-opacity);
}

/* 胶囊按钮（不再是文字链接）：有底、有圆角、有内边距，才读得出「这是一个可点的按钮」。
   位置由 .cornered 钉在卡片右上角。 */
.pill {
  position: absolute;
  top: var(--sp-8);
  right: var(--sp-12);
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border: none;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.pill:active {
  transform: scale(0.95);
}

.pill:disabled {
  opacity: var(--disabled-opacity);
}

/* 右上角有操作：标签给右侧留出胶囊的宽度，长标题才不会被压到按钮底下 */
.cornered {
  position: relative;
}

.cornered > .l {
  /* 92 = 64 + 28：给右上角那颗胶囊让出的固定宽度（两个间隔档拼出来，不写裸值） */
  padding-right: calc(var(--sp-64) + var(--sp-28));
}

.list {
  max-height: 42dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.grp + .grp {
  margin-top: var(--gap-md);
}

.grp-head {
  padding: var(--sp-4) var(--sp-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.m {
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h);
  padding: 0 var(--sp-2);
  text-align: left;
}

.m + .m {
  border-top: 0.5px solid var(--line);
}

.m.on {
  color: var(--accent);
}

.tick {
  width: 17px;
  height: 17px;
  flex: none;
  border-radius: var(--radius-xs);
  border: 1.5px solid var(--text-3);
  color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tick.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.mt b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  word-break: break-all;
}

.mt em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.cost {
  background: var(--surface-2);
  gap: var(--gap-tight);
}

.crow {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.crow b {
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.csub {
  display: flex;
  justify-content: space-between;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-bottom: var(--sp-4);
}

/* 转圈走 base.css 的共享 keyframes（scoped 的 @keyframes 会被改名，各文件各存一份） */
.spin {
  animation: rein-spin 0.9s linear infinite;
}
</style>
