<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Boxes, Mic, Plus, Server, Sparkles } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ModelFormSheet from '@/components/ai/ModelFormSheet.vue'
import ModelListSheet from '@/components/ai/ModelListSheet.vue'
import ModelPickerSheet from '@/components/ai/ModelPickerSheet.vue'
import OnlineServiceSheet from '@/components/ai/OnlineServiceSheet.vue'
import ProviderFormSheet from '@/components/ai/ProviderFormSheet.vue'
import ProviderSheet from '@/components/ai/ProviderSheet.vue'
import ServiceModelsCard from '@/components/ai/ServiceModelsCard.vue'
import VoiceConfigSheet from '@/components/voice/VoiceConfigSheet.vue'
import { KIND_LABEL } from '@/ai/providerCatalog'
import { voiceService } from '@/services/voiceService'
import { useToast } from '@/composables/useToast'
import { useModelRolesStore } from '@/stores/modelRoles'
import { useModelsStore } from '@/stores/models'
import { useOnlineServiceStore } from '@/stores/onlineService'
import { useProvidersStore } from '@/stores/providers'
import type { AiModel, AiProvider, ModelRole, VoiceConfig } from '@/types'

/**
 * 管理模型（AI 页入口后的第一页）。三层结构，与「模型住在哪」一一对应：
 *
 * 1. **服务模型**：全应用四个模型接口（主 LLM / 多模态备选 / ASR / 向量）当前用哪个 ——
 *    点一行开选择抽屉，选中即写到那个执行位；
 * 2. **Rein 在线服务**：服务端下发的模型（地址 + 密钥 + 目录 + 调用条件 + 对账），
 *    点开是独立一层抽屉；
 * 3. **提供商**：服务商账号（适配器 + 接入方式 + 凭据）→ 拉一次 `/models` 就能看到
 *    这家能提供的对话/视觉/识别/向量模型，逐条启用。
 *
 * 列表一律「页面里只放摘要，全部另开抽屉」：模型目录动辄几十条，在页面里展开会把
 * 下面的内容一路推下去（DOM 重排 + 丢失滚动位置），抽屉则是独立一层。
 */
const models = useModelsStore()
const providers = useProvidersStore()
const roles = useModelRolesStore()
const online = useOnlineServiceStore()
const toast = useToast()
const router = useRouter()

/** 选择抽屉（四行槽位共用） */
const pickerOpen = ref(false)
const pickerRole = ref<ModelRole | null>(null)
/** 全部模型抽屉 */
const listOpen = ref(false)
/** 在线服务抽屉 */
const onlineOpen = ref(false)
/** 提供商详情 / 表单 */
const providerOpen = ref(false)
const providerTarget = ref<AiProvider | null>(null)
const formOpen = ref(false)
const formTarget = ref<AiProvider | null>(null)
const formAdapter = ref('')
/** 手动添加/编辑单条模型（进阶路径） */
const modelFormOpen = ref(false)
const editingModel = ref<AiModel | null>(null)

/* ---- 豆包语音服务：一张卡管一对模型（ASR/TTS），独立于 LLM 列表 ---- */
const voiceConfig = ref<VoiceConfig | null>(null)
const voiceOpen = ref(false)

async function loadVoiceConfig(): Promise<void> {
  voiceConfig.value = await voiceService.configGet().catch(() => null)
}

function voiceConfigured(c: VoiceConfig | null): boolean {
  if (!c) return false
  return c.mode === 'new' ? !!c.appKey.trim() : !!c.appKey.trim() && !!c.accessKey.trim()
}

function onVoiceSaved(c: VoiceConfig): void {
  voiceConfig.value = c
  // ASR 槽位读的就是这份配置，改完立刻回读
  void roles.refreshTargets()
}

onMounted(() => {
  // 在线服务先读一次（设置 + 上次成功的目录快照 + 后台核对）：否则这张卡在
  // 打开过抽屉之前一直显示「未配置服务密钥」，而密钥明明在本机
  void online.load()
  void roles
    .load()
    .then(() => models.loadUsage())
    .catch(() => toast.toast('模型列表加载失败'))
  void loadVoiceConfig()
})

/** 让 AI 帮我配置：跳 AI 页并预填请求（模型/语音/提供商工具都是按需装载的） */
function askAiSetup(): void {
  void router.push({
    path: '/ai',
    query: { ask: '帮我检查模型与提供商的配置（主模型、语音识别、向量），有问题直接帮我修好并测试验证' },
  })
}

function openPicker(role: ModelRole): void {
  pickerRole.value = role
  pickerOpen.value = true
}

function openProvider(p: AiProvider): void {
  providerTarget.value = p
  providerOpen.value = true
}

function addProvider(adapter = ''): void {
  formTarget.value = null
  formAdapter.value = adapter
  formOpen.value = true
}

function editProvider(p: AiProvider): void {
  providerOpen.value = false
  formTarget.value = p
  formAdapter.value = p.adapter
  formOpen.value = true
}

function onProviderSaved(id: number): void {
  const p = providers.providerOf(id)
  if (p) {
    providerTarget.value = p
    providerOpen.value = true
  }
}

function openModelForm(m: AiModel | null): void {
  editingModel.value = m
  modelFormOpen.value = true
}

function onModelSaved(id: number): void {
  void models.runProbe(id)
}

/* ---- 提供商卡片摘要 ---- */
const providerCards = computed(() =>
  providers.providers.map((p) => ({
    provider: p,
    adapterLabel: providers.adapterOf(p.adapter)?.label ?? p.adapter,
    summary: p.models.length
      ? providers
          .summaryOf(p)
          .map((s) => `${s.count} ${KIND_LABEL[s.kind]}`)
          .join(' · ')
      : '还没有目录：进去拉一次模型列表',
    error: p.lastError,
  })),
)

const onlineTone = computed(() => {
  if (online.ready) return 'ok'
  if (!online.hasKey) return 'idle'
  return 'warn'
})
</script>

<template>
  <div class="page">
    <PageHeader title="管理模型" subtitle="选服务模型 · 接服务商 · 拉模型目录" back>
      <template #action>
        <button class="hdr-btn accent" aria-label="添加提供商" @click="addProvider()">
          <Plus :size="19" />
        </button>
      </template>
    </PageHeader>

    <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 页面框与吸顶页头站住，只有 item 位移
         （system/rubberScroll）。页头留在层外，拖动时不跟着漂 -->
    <div class="rubber-layer" data-rubber-content>
      <!-- 1 · 服务模型：四个接口各用哪个，点一行换一个 -->
      <ServiceModelsCard :loading="!roles.loaded" @pick="openPicker" />

      <!-- 2 · Rein 在线服务：点开看状态（地址/密钥/目录/调用条件/对账） -->
      <button class="card onl" @click="onlineOpen = true">
        <span class="ic ic-onl"><Server :size="15" /></span>
        <span class="vt">
          <b>
            Rein 在线服务
            <i class="chip" :class="`chip-${onlineTone}`">{{ online.statusText }}</i>
          </b>
          <em>{{ online.accountText }}</em>
        </span>
        <span class="v-go">›</span>
      </button>

      <!-- 3 · 提供商：服务商账号 → 模型目录 → 逐条启用 -->
      <section class="prov">
        <div class="row between center sec-head">
          <b>提供商</b>
          <button class="mini" @click="listOpen = true">
            全部模型（{{ models.models.length }}）›
          </button>
        </div>

        <ul v-if="providerCards.length > 0" class="pv-list">
          <li v-for="c in providerCards" :key="c.provider.id">
            <button class="card pv" @click="openProvider(c.provider)">
              <span class="ic ic-pv">{{ c.provider.name.slice(0, 1) }}</span>
              <span class="vt">
                <b>
                  {{ c.provider.name }}
                  <i class="tag">{{ c.adapterLabel }}</i>
                </b>
                <em>{{ c.summary }}</em>
                <em v-if="c.error" class="perr">{{ c.error }}</em>
              </span>
              <span class="v-go">›</span>
            </button>
          </li>
        </ul>

        <section v-else class="card empty">
          <EmptyState
            :icon="Boxes"
            title="还没有提供商"
            hint="添加一个服务商账号（火山方舟 / 百炼 / DeepSeek / 硅基流动…），拉一次模型列表就能逐条启用对话、视觉、识别与向量模型"
          />
        </section>

        <!-- 空列表时这张卡兼作引导；有列表后添加入口只留页头那颗钮 -->
        <button v-if="providerCards.length === 0" class="card add-pv" @click="addProvider()">
          <span class="ic ic-add"><Plus :size="15" /></span>
          <span class="vt">
            <b>添加提供商</b>
            <em>选适配器与接入方式，填 API Key 后自动拉模型清单</em>
          </span>
          <span class="v-go">›</span>
        </button>
      </section>

      <!-- 语音服务（凭据与音色；识别模型本身在上面「服务模型」里选） -->
      <button class="card vcfg" @click="voiceOpen = true">
        <span class="ic ic-voice"><Mic :size="15" /></span>
        <span class="vt">
          <b>
            语音服务
            <i v-if="voiceConfigured(voiceConfig)" class="tag ok-t">已连接</i>
            <i v-else class="tag">未配置</i>
          </b>
          <em class="em-main">识别与朗读的凭据</em>
          <em class="em-sub">音色与语速 · 连通性测试</em>
        </span>
        <span class="v-go">›</span>
      </button>
      <button class="card ai-setup" @click="askAiSetup">
        <span class="ic ic-spark"><Sparkles :size="15" /></span>
        <span class="vt">
          <b>让 AI 帮我配置</b>
          <em>聊天里直接填 API Key、拉模型、切换服务模型</em>
        </span>
        <span class="v-go">›</span>
      </button>
    </div>

    <!-- 抽屉层：选择 / 全部模型 / 在线服务 / 提供商 / 表单 -->
    <ModelPickerSheet
      :open="pickerOpen"
      :role="pickerRole"
      @close="pickerOpen = false"
      @add="pickerOpen = false; addProvider()"
    />
    <ModelListSheet
      :open="listOpen"
      @close="listOpen = false"
      @add="listOpen = false; openModelForm(null)"
      @edit="(m) => openModelForm(m)"
    />
    <OnlineServiceSheet
      :open="onlineOpen"
      @close="onlineOpen = false"
      @synced="() => models.loadUsage()"
    />
    <ProviderSheet
      :open="providerOpen"
      :provider="providerTarget"
      @close="providerOpen = false"
      @edit="editProvider"
    />
    <ProviderFormSheet
      :open="formOpen"
      :provider="formTarget"
      :initial-adapter="formAdapter"
      @close="formOpen = false"
      @saved="onProviderSaved"
    />
    <ModelFormSheet
      :open="modelFormOpen"
      :model="editingModel"
      @close="modelFormOpen = false"
      @saved="onModelSaved"
    />
    <VoiceConfigSheet
      :open="voiceOpen"
      :config="voiceConfig"
      @close="voiceOpen = false"
      @saved="onVoiceSaved"
    />
  </div>
</template>

<style scoped>
.page {
  /* 与 AIPage 同因：可用高度还要扣 app-frame 的 safe-top 状态栏 padding，
     以及悬浮运动条停靠 bottom 时的 --wbar-reserve（无运动 / 其他槽位为 0） */
  height: calc(
    100dvh - var(--safe-top) - var(--tabbar-h) - var(--safe-bottom) - var(--wbar-reserve, 0px)
  );
  overflow-y: auto;
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
  scrollbar-width: none;
}

/* 页头自己让开页面顶部那 10px（理由见 AIPage 的 .msgs：写进滚动容器内边距会把
   sticky 的粘滞位一起顶下去）。粘滞位与遮罩一并归零。 */
.page :deep(.page-header) {
  --ph-stick: 0px;
  --ph-up: 0px;
  margin-top: var(--sp-10);
}

/* 只有**按钮**卡吃这一条（在线服务 / 提供商 / 添加 / 语音 / AI 配置）。
   裸 `.card` 会顺着 scope id 落到子组件的根节点上（ServiceModelsCard 的 section.card.sm），
   于是「服务模型」卡被压成 flex 横排、标题栏只剩 44px 宽、断成「服务模/型」两行。
   结构卡（section.card.empty）与子组件根节点各按自己的块级流排版：前者自带
   display:block + padding 8px 14px，后者自带 padding 13px 14px 并把 ul 排在标题下方。 */
button.card {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  /* 双行入口卡：标题 + 一到两行副标，走 64 的双行行高档 */
  min-height: var(--row-h-double);
  padding: var(--pad-card-tight) var(--pad-card);
  text-align: left;
}

/* 卡与卡之间 12（间隔规范「卡片之间 12vp」） */
.rubber-layer > * + * {
  margin-top: var(--gap-md);
}

/* 图标徽章统一 token-soft（与设置页 .fic、同步页 .fic 同一套画法）：
   整面 accent-soft 底 + accent 图标。原先三个入口各配一支手写渐变 hex，
   现在收成同一档软底 —— 语义交给图标本身，颜色不再各说各话。
   中性档（提供商首字 / 添加）保持 --surface-2 + 文字档灰，添加入口用 accent 图标。 */
.ic {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-s);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ic-onl,
.ic-voice,
.ic-spark {
  background: var(--accent-soft);
  color: var(--accent);
}

.ic-add,
.ic-pv {
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.ic-add {
  color: var(--accent);
}

.vt {
  flex: 1;
  min-width: 0;
}

.vt b {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex-wrap: wrap;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.vt em {
  font-style: normal;
  font-size: var(--fs-caption);
  /* 副标是「这一项是什么」的唯一说明，落 --text-2 而不是三级灰 */
  color: var(--text-2);
  display: block;
  margin-top: var(--gap-text);
  line-height: var(--lh-caption);
  word-break: break-all;
}

/* 副文案分层：主项一句话（升一档），其余两项降成更小更浅的次行 */
.vt em.em-main {
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.vt em.em-sub {
  font-size: var(--fs-micro);
}

.vt em.perr {
  color: var(--danger);
}

/* 状态胶囊：高 24（--chip-h）、左右 12、12 Medium —— 与全库角标同一档 */
.chip,
.tag {
  display: inline-flex;
  align-items: center;
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-full);
  min-height: var(--chip-h);
  padding: 0 var(--pad-inline);
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
  background: var(--warn-soft);
  color: var(--warn-strong);
}

.tag {
  background: var(--surface-2);
  color: var(--text-2);
}

.tag.ok-t {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.v-go {
  flex: none;
  color: var(--text-2);
  font-size: var(--fs-headline);
}

.prov {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

/* 「提供商」是这一页唯一的分区标题：16 Medium 主色，与下面的卡片标题（14）拉开一级 */
.sec-head b {
  font-size: var(--fs-headline);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

/* 「全部模型」是分区标题里的文字按钮：视觉 28（--control-sm），
   热区上下补 8 到 44；它独占标题行右侧，没有相邻可点元素 */
.mini {
  position: relative;
  min-height: var(--control-sm);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--accent);
}
.mini::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.pv-list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.pv {
  gap: var(--sp-12);
}

.empty {
  display: block;
  padding: var(--pad-card-tight) var(--pad-card);
}

.add-pv .vt b {
  color: var(--accent);
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main） ----------
   内容都挂在 .rubber-layer 里（壳层的 .page 栅格管不到它），这里自己铺成两栏：
   服务模型 / 在线服务 / 提供商通栏，底部两张入口卡并排。 */
.desk-main .rubber-layer {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--desk-gap);
  align-items: start;
}

.desk-main .rubber-layer > * {
  grid-column: 1 / -1;
  min-width: 0;
  margin-top: 0;
}

.desk-main .rubber-layer > .vcfg,
.desk-main .rubber-layer > .ai-setup {
  grid-column: span 1;
}

/* 提供商卡片摊成多栏：auto-fit 让只有一条时也占满整行 */
.desk-main .pv-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--desk-gap);
}
</style>
