<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, Cloud, Download, RefreshCw, ShieldCheck, ShieldX, Sparkles } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import MdText from '@/components/common/MdText.vue'
import { useToast } from '@/composables/useToast'
import { useUpdateStore } from '@/stores/update'
import { fmtRelativeTime, humanBytes } from '@/utils/format'
import { notesAboveCurrent } from '@/utils/updateNotes'
import type { SourceReport, UpdatePhase, UpdateSettingsPatch, UpdateSource } from '@/types'

/**
 * 更新中心（二级内容页，入口在「设置 › 关于」）。
 *
 * 这一页要回答四件事，顺序就是从上到下的卡片顺序：
 *   1. 我现在是什么版本、能装什么平台的包
 *   2. 有没有新版本（以及各更新源分别探到了什么）
 *   3. 下载到哪一步了、装不装得上
 *   4. 更新之外的在线服务可用吗（模型网关是预留接口）
 */
const router = useRouter()
const update = useUpdateStore()
const { toast } = useToast()

const customUrl = ref('')
const customName = ref('')
const showSourceEditor = ref(false)
const CHANNELS = ['stable', 'beta'] as const

/** 发布通道的中文标签（界面上不出现 stable / beta 原值）；两条通道的差异收进行内 InfoHint */
const CHANNEL_LABELS: Record<string, string> = { stable: '稳定版', beta: '测试版' }

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '待检查',
  preparing: '准备中…',
  downloading: '下载中',
  verifying: '校验签名…',
  ready: '已就绪，可安装',
  installing: '正在安装…',
  failed: '下载失败',
  cancelled: '已取消',
}

function fmtBytes(n: number | null | undefined): string {
  return n ? humanBytes(n) : '未知大小'
}

function fmtSpeed(n: number): string {
  if (!n) return ''
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(n / 1024)} KB/s`
}

function fmtTime(iso: string | null | undefined): string {
  return fmtRelativeTime(iso, iso ?? '从未')
}

/** 发布时间：空值单独成句，不与「发布于」拼句（拼出来是「发布于 从未」） */
function publishedText(iso: string | null | undefined): string {
  return iso ? `发布于 ${fmtTime(iso)}` : '未提供发布时间'
}

/** 平台键 → 人话（键名与 tauri updater 的 target 一致，不能改） */
const platformLabel = computed(() => {
  const key = update.snapshot?.platform ?? ''
  const [os, arch] = key.split('-')
  const osName = ({ windows: 'Windows', android: 'Android', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[os] ?? os
  const archName = ({ x86_64: 'x64', aarch64: 'arm64', armv7: 'armv7', i686: 'x86' } as Record<string, string>)[arch ?? ''] ?? arch
  return archName ? `${osName} · ${archName}` : osName
})

const download = computed(() => update.downloadState)
const check = computed(() => update.check)
/** 说明已由发布侧裁成本版一节；这里再过滤一次是给老清单 / 自定义源兜底（见 utils/updateNotes） */
const notes = computed(() => notesAboveCurrent(check.value?.notes, check.value?.currentVersion ?? ''))

const downloadedPercent = computed(() => {
  const d = download.value
  if (!d) return 0
  if (d.total > 0) return Math.min(100, Math.round((d.received / d.total) * 100))
  return d.phase === 'ready' || d.phase === 'installing' ? 100 : 0
})

/** 某更新源这次检查的结果（还没检查过时为空） */
function reportOf(id: string): SourceReport | null {
  return check.value?.sources.find((s) => s.id === id) ?? null
}

function sourceDetail(s: SourceReport): string {
  if (!s.ok) return s.error ?? '不可用'
  return `${s.version ?? '—'}${s.manifestSigned ? ' · 清单已签名' : ''}`
}

/** 版本卡状态行：只说下方卡片承载不了的那一句。
 *  有更新 / 已跳过 / 下载进度都归各自的卡（版本号在前者里带 v 前缀，这里再报一遍只会
 *  出现两种写法，让人怀疑是两个版本） */
const statusLine = computed(() => {
  if (!update.snapshot) return '正在读取…'
  const d = download.value
  if (d && d.phase !== 'idle') return ''
  if (check.value?.ignored || update.hasUpdate) return ''
  if (check.value) return `已是最新版本（${fmtTime(check.value.checkedAt)} 检查）`
  return '尚未检查过'
})

/** 设置类写操作统一走这里：失败要吵（toast），成功不出声 */
async function save(patch: UpdateSettingsPatch): Promise<void> {
  if (!(await update.save(patch))) toast(update.error ?? '保存失败')
}

async function onCheck(): Promise<void> {
  const result = await update.checkNow(true)
  if (!result) {
    toast(update.error ?? '检查更新失败')
    return
  }
  if (result.downgradeBlocked) toast('该源提供的版本低于此前见过的最新版，已忽略')
  else if (result.available) toast(`发现新版本 ${result.latestVersion}`)
  else toast('当前已是最新版本')
}

async function onDownload(): Promise<void> {
  if (await update.startDownload()) toast('已开始下载，可在本页查看进度')
  else toast(update.error ?? '下载启动失败')
}

async function onInstall(): Promise<void> {
  const result = await update.install()
  toast(result ? result.message : (update.error ?? '安装失败'))
}

async function onCancel(): Promise<void> {
  await update.cancel()
  toast('已取消下载')
}

async function onSkip(): Promise<void> {
  const v = check.value?.latestVersion
  if (v) await save({ ignoredVersion: v })
}

async function onUnskip(): Promise<void> {
  await save({ ignoredVersion: '' })
}

async function onToggleSource(source: UpdateSource, on: boolean): Promise<void> {
  const list = (update.settings?.sources ?? []).map((s) => (s.id === source.id ? { ...s, enabled: on } : s))
  await save({ sources: list })
}

async function onAddSource(): Promise<void> {
  const url = customUrl.value.trim()
  if (!/^https?:\/\//.test(url)) {
    toast('请填写 http(s) 开头的更新清单地址')
    return
  }
  const list = update.settings?.sources ?? []
  if (list.some((s) => s.url === url)) {
    toast('该地址已在列表中')
    return
  }
  const next: UpdateSource = {
    id: `custom-${Date.now().toString(36)}`,
    name: customName.value.trim() || '自定义源',
    kind: 'tauri-static',
    url,
    enabled: true,
    priority: 20 + list.length,
  }
  if (await update.save({ sources: [...list, next] })) {
    customUrl.value = ''
    customName.value = ''
    showSourceEditor.value = false
    toast('已添加更新源')
  } else {
    toast(update.error ?? '添加失败')
  }
}

async function onRemoveCustom(id: string): Promise<void> {
  const list = (update.settings?.sources ?? []).filter((s) => s.id !== id)
  if (await update.save({ sources: list })) toast('已移除（内置源会自动补回）')
}

async function onPrune(): Promise<void> {
  const freed = await update.pruneCache()
  toast(freed > 0 ? `已清理 ${fmtBytes(freed)}` : '没有可清理的残留')
}

onMounted(async () => {
  await update.load()
  // 进页面就把在线服务探一次：这张卡的信息用户一眼要能看到
  void update.probeOnline()
})
</script>

<template>
  <div class="page">
    <PageHeader title="软件更新" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 桌面栅格：壳层只把 .page 的**直接子项**摊成两栏，而这一页的四张主卡
         高矮差得远，两两并排必然在行尾留下空白 —— 桌面上每张都通栏，改在
         卡片**内部**分栏（见 .desk-main 那段注释）。手机端它只是个普通 div -->
    <div class="d-grid upd-grid">
    <!-- 版本 -->
    <section class="card d-full">
      <div class="row between head">
        <span class="col">
          <b class="ver num">v{{ update.currentVersion || '—' }}</b>
          <em class="t-3">{{ platformLabel }}</em>
        </span>
        <button class="btn primary" :disabled="update.checking" @click="onCheck">
          <RefreshCw :size="15" :class="{ spin: update.checking }" />
          {{ update.checking ? '检查中…' : '检查更新' }}
        </button>
      </div>
      <p v-if="statusLine" class="t-3 status">{{ statusLine }}</p>
      <p v-if="update.snapshot && !update.snapshot.installSupported" class="warn">
        <AlertTriangle :size="14" /> {{ update.snapshot.installHint }}
      </p>
    </section>

    <!-- 有更新 -->
    <section v-if="update.hasUpdate || update.readyToInstall" class="card hl d-full">
      <header class="row between ghead">
        <h2 class="gtitle">可更新到 v{{ check?.latestVersion }}</h2>
        <span class="row head-side">
          <span v-if="check?.sourceName" class="t-3 tiny">{{ check.sourceName }}</span>
          <StatusChip v-if="check?.mandatory" tone="warn" size="md">必须更新</StatusChip>
        </span>
      </header>

      <p class="meta t-3">
        <span class="num">{{ fmtBytes(check?.sizeBytes) }}</span> · {{ publishedText(check?.publishedAt) }}
      </p>

      <!-- 说明是 Markdown：从前用 {{ }} 插值，用户看到的是原样的 `**` 与 `##` -->
      <MdText v-if="notes" class="notes" :text="notes" />

      <p v-if="check?.downgradeBlocked" class="warn">
        <ShieldX :size="14" /> 该源给出的版本低于此前见过的最新版，可能被回放旧版本，已阻止自动更新
      </p>

      <!-- 进度 -->
      <div v-if="download && download.phase !== 'idle'" class="progress-box">
        <div class="pbar">
          <i class="pfill" :style="{ transform: `scaleX(${downloadedPercent / 100})` }" />
        </div>
        <div class="row between t-3 tiny">
          <span>{{ PHASE_TEXT[download.phase] }}<template v-if="download.phase === 'downloading'"> · {{ fmtSpeed(download.bytesPerSec) }}</template></span>
          <span class="num">
            {{ fmtBytes(download.received) }} / {{ fmtBytes(download.total) }}
          </span>
        </div>
        <p v-if="download.error" class="warn"><AlertTriangle :size="14" /> {{ download.error }}</p>
        <p v-if="download.phase === 'ready'" class="ok"><ShieldCheck :size="14" /> 已通过摘要与签名校验，可以安装</p>
      </div>

      <div class="actions">
        <button v-if="!update.readyToInstall && !update.busy" class="btn primary" @click="onDownload">
          <Download :size="15" /> 下载安装包
        </button>
        <button v-if="update.readyToInstall && !update.installing" class="btn primary" @click="onInstall">
          <Download :size="15" /> 安装并重启
        </button>
        <button v-if="update.busy && download?.phase === 'downloading'" class="btn" @click="onCancel">取消</button>
        <button v-if="update.readyToInstall" class="btn" @click="update.discard()">丢弃安装包</button>
        <button v-if="!update.readyToInstall" class="btn ghost" @click="onSkip">跳过此版本</button>
      </div>
    </section>

    <!-- 已跳过 -->
    <section v-if="check?.ignored" class="card d-full">
      <p class="t-3">
        已跳过 v{{ check.latestVersion }}。
        <button class="link" @click="onUnskip">恢复提示</button>
      </p>
    </section>

    <!-- 更新源：桌面上保持一列 —— 行里的清单地址可能很长，通栏才不折行 -->
    <section class="card d-full">
      <header class="row between ghead">
        <h2 class="gtitle">更新源</h2>
        <span class="row head-side">
          <button class="link" @click="showSourceEditor = !showSourceEditor">
            {{ showSourceEditor ? '收起' : '添加自定义源' }}
          </button>
          <span class="hint-slot">
            <InfoHint title="更新源与验签">
              <p>更新清单（manifest）是描述新版本的文件：版本号、下载地址、发布时间都在里面，自定义源填的就是它的地址。</p>
              <p>服务端只能分发签过名的更新：安装包下载完成后用内置公钥做 Ed25519 验签，签名或摘要不符的包一律不装；清单本身也带签名。</p>
            </InfoHint>
          </span>
        </span>
      </header>

      <div v-if="showSourceEditor" class="editor">
        <input v-model="customName" class="inp" placeholder="名称（可选）" />
        <input v-model="customUrl" class="inp" placeholder="更新清单（manifest）地址，如 https://…/latest.json" />
        <button class="btn primary" @click="onAddSource">添加</button>
      </div>

      <div v-for="s in update.settings?.sources ?? []" :key="s.id" class="srow row">
        <span class="col stxt">
          <b>{{ s.name }}</b>
          <em class="t-3 url">{{ s.url }}</em>
          <em v-if="reportOf(s.id)" class="t-3" :class="{ bad: !reportOf(s.id)!.ok }">
            {{ reportOf(s.id)!.ok ? '✓ ' : '✕ ' }}{{ sourceDetail(reportOf(s.id)!) }}
          </em>
        </span>
        <button v-if="s.id.startsWith('custom-')" class="link" @click="onRemoveCustom(s.id)">移除</button>
        <ToggleSwitch
          :model-value="s.enabled"
          :label="`${s.name} 开关`"
          @update:model-value="onToggleSource(s, $event)"
        />
      </div>
    </section>

    <!-- 设置 -->
    <section class="card d-full setcard">
      <h2 class="gtitle">更新设置</h2>
      <div class="rows">
        <div class="row between frow">
          <span class="col ftxt"><b>自动检查更新</b><em class="t-3">启动时静默检查，有新版本才提示</em></span>
          <ToggleSwitch
            :model-value="update.settings?.autoCheck ?? true"
            label="自动检查更新"
            @update:model-value="update.save({ autoCheck: $event })"
          />
        </div>
        <NumberStepper
          :model-value="update.settings?.checkIntervalHours ?? 12"
          label="检查间隔"
          unit="小时"
          :step="6"
          :min="1"
          :max="168"
          @update:model-value="update.save({ checkIntervalHours: $event })"
        />
        <div class="row between frow">
          <span class="col ftxt"><b>更新通道</b><em class="t-3">选择跟随哪个发布通道</em></span>
          <span class="row chips">
            <PillChip
              v-for="c in CHANNELS"
              :key="c"
              as="button"
              size="sm"
              :tone="update.settings?.channel === c ? 'action' : 'muted'"
              @click="update.save({ channel: c })"
            >
              {{ CHANNEL_LABELS[c] }}
            </PillChip>
            <span class="hint-slot">
              <InfoHint title="稳定版与测试版的区别">
                <p>稳定版：经过完整验证的正式版本，推荐大多数人使用。</p>
                <p>测试版：抢先体验新功能，可能有不稳定或未完成的部分。</p>
              </InfoHint>
            </span>
          </span>
        </div>
        <div class="row between frow">
          <span class="col ftxt">
            <b>允许明文 http 源</b>
            <em class="t-3">自建服务器没有证书时开启；安装包签名仍是硬校验</em>
          </span>
          <ToggleSwitch
            :model-value="update.settings?.allowHttp ?? true"
            label="允许明文 http 源"
            @update:model-value="update.save({ allowHttp: $event })"
          />
        </div>
        <div v-if="update.snapshot?.platform.startsWith('windows')" class="row between frow">
          <span class="col ftxt"><b>静默安装</b><em class="t-3">安装时不显示进度窗口</em></span>
          <ToggleSwitch
            :model-value="update.settings?.silentInstall ?? false"
            label="静默安装"
            @update:model-value="update.save({ silentInstall: $event })"
          />
        </div>
        <div class="row between frow">
          <span class="col ftxt"><b>清理下载缓存</b><em class="t-3">删除与当前版本无关的安装包残留</em></span>
          <button class="btn" @click="onPrune">清理</button>
        </div>
      </div>
    </section>

    <!-- 在线服务（更新之外的预留接口） -->
    <section class="card d-full onlinecard">
      <header class="row between ghead">
        <h2 class="gtitle">Rein 在线服务</h2>
        <span class="row head-side">
          <button class="link" :disabled="update.onlineLoading" @click="update.probeOnline()">
            {{ update.onlineLoading ? '探测中…' : '重新探测' }}
          </button>
          <span class="hint-slot">
            <InfoHint title="在线大模型端点">
              <p>
                在线大模型走 OpenAI 兼容端点：<code>{{ update.online?.ai?.chatEndpoint || '正在探测…' }}</code>
                （可直接作为 ai_models 的 baseUrl）。
              </p>
              <p>配置服务商与密钥在「AI 模型」页，填好后这里会显示可用模型。</p>
            </InfoHint>
          </span>
        </span>
      </header>

      <template v-if="update.online">
        <p class="row t-3 tiny onlinestat">
          <span class="url-txt">{{ update.online.baseUrl }}</span>
          <StatusChip v-if="update.online.reachable" tone="ok" size="sm">
            在线 · <span class="num">{{ update.online.elapsedMs }} ms</span>
          </StatusChip>
          <StatusChip v-else tone="danger" size="sm">不可达</StatusChip>
        </p>
        <p v-if="update.online.error" class="warn"><AlertTriangle :size="14" /> {{ update.online.error }}</p>
        <p v-else class="t-3 tiny">
          当前发布版本：{{ update.online.currentRelease ?? '尚无发布' }}
        </p>

        <div v-if="update.online.ai" class="ai-box">
          <p class="row tiny">
            <Cloud :size="14" />
            <b>在线大模型 API</b>
            <StatusChip v-if="update.online.ai.status === 'ready'" tone="ok" size="sm">可用</StatusChip>
            <span v-else class="tag">未配置</span>
          </p>
          <p v-if="update.online.ai.providers.length" class="t-3 tiny">
            已接入：
            <template v-for="(p, i) in update.online.ai.providers" :key="p.id">
              {{ i ? '、' : '' }}{{ p.name }}{{ p.enabled ? '' : '（未启用）' }}
            </template>
          </p>
          <p v-else class="t-3 tiny">在线模型服务商还没配置，填入密钥后这里会显示可用模型。</p>
          <button class="btn" @click="router.push({ name: 'ai-models' })">
            <Sparkles :size="14" /> 去配置模型
          </button>
        </div>
      </template>
      <p v-else class="t-3 tiny">正在探测…</p>
    </section>
    </div>

    <p class="note t-2">安装包与更新清单均验签。</p>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开，
     这里只剩页头与内容之间那一档呼吸 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.head {
  gap: var(--sp-12);
}

.ver {
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
}

.status {
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
}

/* 卡内分区标题：与设置页 / 同步页 / 健康数据同一档 18 Medium（Subtitle_L）。
   此前 12/700 + --text-2 是「眉标」写法，在这一条设置链路里比别的二级页弱一档。 */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.ghead + * {
  margin-top: var(--sp-8);
}

/* 卡头行右侧一组（副标 / 文字按钮 / 帮助入口）：行内再分一组，不让 space-between 摊平 */
.head-side {
  gap: var(--sp-8);
}

/* 标题行右侧的帮助入口：InfoHint 是多根组件，类要落在包裹元素上 */
.hint-slot {
  display: inline-flex;
  flex: none;
}

.tiny {
  font-size: var(--fs-caption);
}

.meta {
  margin-top: var(--sp-6);
  font-size: var(--fs-caption);
}

.notes {
  margin-top: var(--sp-8);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  /* 块级渲染（MdText）：不再需要 pre-wrap 去保换行 */
  color: var(--text-2);
}

.progress-box {
  margin-top: var(--sp-10);
}

.pbar {
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.pfill {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: left center;
  background: var(--accent);
  transition: transform var(--dur-base) var(--ease-standard);
}

.progress-box > .row {
  margin-top: var(--sp-6);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-8);
  margin-top: var(--sp-12);
}

/* 动作按钮：常规档 40（--control-md）、左右 16、胶囊、14 Medium。
   此前 8/14 内距 + 8 圆角的小方块，高度约 32 —— 既不在按钮的 40/28 两档，
   圆角也落在「小容器」那档而不是按钮档。 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.btn:active {
  opacity: 0.7;
}

.btn:disabled {
  opacity: var(--disabled-opacity);
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

/* 文字型次要动作走 --text-2：--text-3 是「补充信息」档，当按钮文字太淡 */
.btn.ghost {
  background: transparent;
  color: var(--text-2);
}

/* 文字链按钮（添加自定义源 / 移除 / 重新探测 / 恢复提示）：视觉仍是 12px 一行字，
   命中区撑到 44（规范：可点元素热区 ≥44）。它们是卡头与行尾唯一的小入口，
   17px 的行高在触屏上摸不准。 */
.link {
  position: relative;
  color: var(--accent);
  font-size: var(--fs-caption);
}

.link::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--hit-min);
  transform: translateY(-50%);
}

.editor {
  display: grid;
  gap: var(--sp-8);
  margin-top: var(--sp-10);
}

/* 自定义源表单：输入框走常规控件档 40（--control-md）、胶囊，与按钮同高 */
.inp {
  width: 100%;
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.srow {
  gap: var(--sp-10);
  padding: var(--sp-10) 0;
}

.srow + .srow {
  border-top: 0.5px solid var(--line);
}

.stxt {
  flex: 1;
  min-width: 0;
  gap: var(--sp-2);
}

.stxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.stxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  overflow-wrap: anywhere;
}

/* 检查失败的诊断行：实底档 --danger 当 12px 文字对比度不够，走文字档 */
.stxt em.bad {
  color: var(--danger-strong);
}

.url {
  color: var(--text-3);
}

.rows {
  display: grid;
  grid-template-columns: 1fr;
  margin-top: var(--sp-6);
}

.rows > * + * {
  border-top: 0.5px solid var(--line);
}

.frow {
  gap: var(--sp-12);
  padding: var(--sp-10) 0;
}

.ftxt {
  flex: 1;
  min-width: 0;
  gap: var(--sp-2);
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.ftxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.chips {
  gap: var(--sp-6);
}

.warn {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  /* 警告文字走 --danger-strong（实底档当文字对比度不够） */
  color: var(--danger-strong);
  line-height: var(--lh-body);
}

.ok {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  margin-top: var(--sp-6);
  font-size: var(--fs-caption);
  /* 与 StatusChip 的 ok 档同一支口径：soft/浅底上的文字走 --ok-strong */
  color: var(--ok-strong);
}

.ai-box {
  display: grid;
  gap: var(--sp-6);
  margin-top: var(--sp-10);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-s);
  background: var(--surface-2);
}

/* 「可用 / 未配置」：ready 态走 StatusChip 的 ok 档（soft 底 + strong 字）；
   中立态与 .ai-box 同底会看不出形状，垫回 --surface-3，几何与 StatusChip sm 对齐 */
.tag {
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-3);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 在线状态行：地址降一档小字，可达性独立成胶囊（在线 ok / 不可达 danger） */
.onlinestat {
  gap: var(--sp-8);
  flex-wrap: wrap;
}

.url-txt {
  min-width: 0;
  font-size: var(--fs-micro);
  overflow-wrap: anywhere;
}

.note {
  margin: var(--sp-14) var(--sp-4) 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   这一页四张主卡的高矮差得远（版本 ~150 / 更新源 ~250 / 更新设置 ~430 /
   在线服务 ~250），两两并排必然在行尾留下一块空白。所以桌面上每张卡都通栏，
   把分栏挪到**卡片内部**：
   · 版本     —— 本来就是「左版本、右按钮」的一条，通栏才是它的形状；
   · 更新设置 —— 六行开关摊成两栏，每行约 500px，说明不必折行；
   · 在线服务 —— 状态在左、AI 端点在右；
   更新源刻意保持一列：行里可能挂着一条很长的清单地址，通栏才不折行。
   ============================================================ */

/* 六行开关摊成两栏。行间那条细线只该出现在**第二行起**：手机上一列时它是
   「+ 一行」的通用规则，两栏下会让右上角凭空多出一条线 */
.desk-main .setcard .rows {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--desk-gap);
}

.desk-main .setcard .rows > * + * {
  border-top: none;
}

.desk-main .setcard .rows > *:nth-child(n + 3) {
  border-top: 0.5px solid var(--line);
}

/* 在线服务：状态（左）与 AI 端点（右）并置。ai-box 显式落在右栏第 2 行，
   左边那几行状态文字按自动流一列排下去 */
.desk-main .onlinecard {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--desk-gap);
  align-items: start;
}

.desk-main .onlinecard > .ghead {
  grid-column: 1 / -1;
}

.desk-main .onlinecard > .ai-box {
  grid-column: 2;
  grid-row: 2;
  margin-top: 0;
}

.spin {
  animation: rein-spin 1s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
