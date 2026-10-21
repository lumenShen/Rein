<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { ChevronRight, Fingerprint, KeyRound, Link2, LogIn, Package, Smartphone, Zap } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import { useToast } from '@/composables/useToast'
import { syncService } from '@/services/syncService'
import { fmtRelativeTime, humanBytes } from '@/utils/format'
import type { PairStatus, SyncPeerInfo, SyncRunResult, SyncRunStats, SyncStatus } from '@/types'

/**
 * 多设备同步（三级页，入口在「设置 › 多设备同步」）。
 *
 * 三张卡片，顺序就是用户的心智顺序：
 *   1. 本机是谁（名字 / 指纹 / 有多少条在账上）
 *   2. 连了谁（每台上次走的哪条路：局域网直连 · 打洞直连 · 云端中继）
 *   3. 怎么再加一台（开码 / 输码）
 *
 * 路径是自动选的（同网段直连 → 打洞 → 中继兜底），页面上**不给「用哪条路」的开关** ——
 * 那是实现细节，不是用户的选择；这里只如实显示这次走成了哪条。
 */
const { toast } = useToast()

/** 同步链上的失败只给一句平白中文，原始错误进控制台 ——
 *  Rust 侧的错误串（端口占用 / 打洞超时 / 密文校验失败…）是给开发看的诊断信息，
 *  原样进 toast 只会把「配对失败」说成一串英文路径与行号。 */
const SYNC_ERRORS = {
  pairStart: '开码失败，请重试',
  pairClaim: '配对失败，请重试',
  run: '同步没成功，请稍后重试',
} as const

function failToast(key: keyof typeof SYNC_ERRORS, e: unknown): void {
  console.warn(`[sync] ${key} 失败`, e)
  toast(SYNC_ERRORS[key])
}

const status = ref<SyncStatus | null>(null)
const busy = ref(false)
const offer = ref<string | null>(null)
const claimCode = ref('')
const lastRun = ref<SyncRunStats | null>(null)
const peerSheet = ref<SyncPeerInfo | null>(null)
let pollTimer: number | null = null

const PATH_TEXT: Record<string, string> = {
  lan: '局域网直连',
  punch: '打洞直连',
  relay: '云端中继',
}

const peers = computed(() => status.value?.peers ?? [])
const paired = computed(() => peers.value.length > 0)

const peerActions = computed(() => [
  { label: '立即同步', value: 'run' },
  { label: `解除与「${peerSheet.value?.name || peerSheet.value?.short || ''}」的配对`, value: 'forget', danger: true },
])

/** 本机计数：一次只说最要紧的一条（冲突 > 待打包 > 表结构变更），
 *  三条计数的含义与「同步账」的口径收进「本机」卡标题行右侧的 InfoHint */
const pendingHint = computed(() => {
  const s = status.value
  if (!s) return ''
  if (s.conflicts > 0) return `${s.conflicts} 处冲突留档`
  if (s.pending > 0) return `${s.pending} 条改动正在打包`
  if (s.staleTables > 0) return `${s.staleTables} 张表结构变了，会重新补录`
  return ''
})

/**
 * 「上次走的是哪条路」这一行。
 * 本次会话刚回来时用事件里的明细（含用时与流量）；重新进页面时退回到状态里记的那一份 ——
 * 用户最想知道的就是这句话，不该只在刚同步完的那几分钟里看得见。
 * 拆成「结论行（哪条路 + 用时/时间）+ 次要行（收到 / 冲突 / 上下行）」：原先六七个事实
 * 用「·」串成一条 12px 灰字，最关键的「走的哪条路」混在中间读不出来。
 */
const lastSummary = computed(() => {
  const run = lastRun.value
  if (run) {
    return {
      verb: '这次',
      path: run.pathLabel,
      lead: `用时 ${secs(run.ms)} 秒`,
      detail: [
        `收到 ${run.applied} 条`,
        `冲突 ${run.conflicts} 处`,
        `上传 ${fmtBytes(run.up)}`,
        `下载 ${fmtBytes(run.down)}`,
        ...run.notes,
      ],
    }
  }
  const s = status.value
  if (s?.lastAt) {
    return {
      verb: '上次',
      path: pathText(s.lastPath),
      lead: fmtTime(s.lastAt),
      detail: [`上传 ${fmtBytes(s.lastUp)}`, `下载 ${fmtBytes(s.lastDown)}`],
    }
  }
  return null
})

function pathText(p: string | null | undefined): string {
  if (!p) return '未同步'
  return PATH_TEXT[p] ?? p
}

function fmtBytes(n: number | null | undefined): string {
  return humanBytes(n ?? 0)
}

function fmtTime(ms: number | null | undefined): string {
  return fmtRelativeTime(ms, '从未')
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0)
}

async function refresh(): Promise<void> {
  status.value = await syncService.status()
}

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

async function pairStart(): Promise<void> {
  busy.value = true
  try {
    const res = await syncService.pairStart()
    offer.value = res.code
    stopPoll()
    // 另一台输完码这边就该收尾；过期由服务端判，这里只管问
    pollTimer = window.setInterval(() => void pollOnce(), 2000)
  } catch (e) {
    failToast('pairStart', e)
  } finally {
    busy.value = false
  }
}

async function pollOnce(): Promise<void> {
  try {
    const st: PairStatus = await syncService.pairPoll()
    if (st.peer) {
      stopPoll()
      offer.value = null
      await refresh()
      toast(`配对完成：${st.peer.name || st.peer.short} 已加入`)
    }
  } catch {
    // 轮询失败不打扰：下一拍再试，码过期会由服务端返回错误
  }
}

async function claim(): Promise<void> {
  const code = claimCode.value.trim()
  if (!code) return
  busy.value = true
  try {
    const st = await syncService.pairClaim(code)
    claimCode.value = ''
    await refresh()
    toast(`配对完成：${st.peer?.name || '已加入同步组'}`)
  } catch (e) {
    failToast('pairClaim', e)
  } finally {
    busy.value = false
  }
}

async function runNow(): Promise<void> {
  if (busy.value) return
  busy.value = true
  lastRun.value = null
  try {
    await syncService.run()
  } catch (e) {
    busy.value = false
    failToast('run', e)
    return
  }
  // 结果由 sync://result 事件送回来；万一事件没到（例如浏览器里的 mock），
  // 别让按钮一直卡在「同步中」—— 但留足时间，别把真在跑的大同步放开成第二次。
  window.setTimeout(() => {
    if (busy.value) {
      busy.value = false
      void refresh()
    }
  }, 20000)
}

async function forget(peer: SyncPeerInfo): Promise<void> {
  status.value = await syncService.forget(peer.device)
  lastRun.value = null
  toast('已解除配对，本机数据没动')
}

function openPeer(peer: SyncPeerInfo): void {
  peerSheet.value = peer
}

async function onPeerAction(value: string): Promise<void> {
  const peer = peerSheet.value
  if (!peer) return
  if (value === 'run') await runNow()
  if (value === 'forget') await forget(peer)
}

let unlisten: (() => void) | null = null

onMounted(async () => {
  await refresh()
  unlisten = await listen<SyncRunResult>('sync://result', (event) => {
    busy.value = false
    const payload = event.payload
    const first = payload.stats?.[0] ?? null
    lastRun.value = first
    if (payload.error) {
      // 结果事件里的 error 同样是诊断串：控制台留原文，toast 只说结论
      console.warn('[sync] 同步结果返回错误', payload.error)
      toast('同步没成功，请稍后重试')
    } else if (payload.errors && payload.errors.length > 0) {
      console.warn('[sync] 部分设备同步失败', payload.errors)
      toast('部分设备没同步成，请稍后重试')
    } else if (first) {
      toast(`${first.pathLabel} · 收到 ${first.applied} 条，用时 ${secs(first.ms)} 秒`)
    } else {
      toast('还没有配对的设备')
    }
    void refresh()
  })
})

onUnmounted(() => {
  stopPoll()
  unlisten?.()
})
</script>

<template>
  <div class="page">
    <PageHeader title="多设备同步" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 桌面栅格：壳层只把 .page 的**直接子项**摊成两栏，而这一页要的是
         「本机 | 已配对设备 并排 + 加一台设备通栏」，所以自带一层 .d-grid 承接。
         手机端它只是个普通 div，块流与卡片间距都不变 -->
    <div class="d-grid sync-grid">
    <!-- 本机 -->
    <section class="card">
      <header class="row ghead">
        <h2 class="gtitle">本机</h2>
        <span class="hint-slot">
          <InfoHint title="本机计数与同步机制">
            <p>「本机共 N 条记录在同步里」说的是纳入同步的记录总数；改动会自动打包，同步时只发对方没有的。</p>
            <p>计数行一次只说最要紧的一条：待打包的是还没发出去的改动；表结构变了会在下次同步重新补录；冲突留档指同一条记录两边都改过、各留一份。</p>
            <p>配对时两端会互换公钥指纹：两边显示的一致，才说明中间没有人插进来。之后每次连接都按这把公钥校验，换了就拒连。</p>
          </InfoHint>
        </span>
      </header>
      <div class="card sub rows">
        <div class="frow row">
          <i class="fic"><Smartphone :size="17" /></i>
          <span class="col ftxt">
            <b>{{ status?.deviceName || '—' }}</b>
            <em class="t-2">这台设备在同步里的名字</em>
          </span>
        </div>
        <div class="frow row">
          <i class="fic"><Fingerprint :size="17" /></i>
          <span class="col ftxt">
            <b class="mono">{{ status?.fingerprint || '—' }}</b>
            <em class="t-2">公钥指纹 · 设备号 {{ status?.deviceShort || '—' }}</em>
          </span>
        </div>
        <div class="frow row">
          <i class="fic"><Package :size="17" /></i>
          <span class="col ftxt">
            <b class="num">本机共 {{ status?.objects ?? 0 }} 条记录在同步里</b>
            <em v-if="pendingHint" class="t-3 num">{{ pendingHint }}</em>
          </span>
        </div>
      </div>
      <p class="pnote t-2">两端指纹一致，才说明没有被中间人插入。</p>
    </section>

    <!-- 已配对设备 -->
    <section class="card">
      <h2 class="gtitle">已配对设备</h2>

      <EmptyState
        v-if="!paired"
        :icon="Link2"
        title="还没有配对的设备"
        hint="两台设备都装 Rein、都指向同一台在线服务，然后下面开一串码互相认一下即可"
      />

      <template v-else>
        <div class="card sub rows">
          <button v-for="p in peers" :key="p.device" class="frow row" @click="openPeer(p)">
            <i class="fic"><Link2 :size="17" /></i>
            <span class="col ftxt">
              <b>{{ p.name || '未命名设备' }}</b>
              <em class="t-2">{{ p.short }} · 上次 {{ fmtTime(p.lastSeen) }}</em>
            </span>
            <PillChip size="md" :tone="p.path === 'punch' ? 'action' : 'muted'">{{ pathText(p.path) }}</PillChip>
            <ChevronRight :size="16" class="t-3" />
          </button>
        </div>

        <button class="btn" :disabled="busy" @click="runNow">
          <Zap :size="16" />
          {{ busy ? '同步中…' : '立即同步' }}
        </button>

        <div v-if="lastSummary" class="lastsum">
          <p class="sum-main">
            <PillChip size="md" tone="action">{{ lastSummary.verb }}走「{{ lastSummary.path }}」</PillChip>
            <span class="sum-lead num">{{ lastSummary.lead }}</span>
          </p>
          <p class="pnote t-2 num">{{ lastSummary.detail.join(' · ') }}</p>
        </div>
      </template>
    </section>

    <!-- 加一台设备：桌面上通栏后内部再分两栏（见 .desk-main 那段注释） -->
    <section class="card d-full add-card">
      <h2 class="gtitle">加一台设备</h2>
      <div class="card sub rows">
        <div class="frow row">
          <i class="fic"><KeyRound :size="17" /></i>
          <span class="col ftxt">
            <b>在这台开同步码</b>
            <em class="t-2">念给另一台，5 分钟内有效、用过即废</em>
          </span>
          <button class="btn small" :disabled="busy || !!offer" @click="pairStart">开码</button>
        </div>
      </div>

      <div v-if="offer" class="code">
        <b class="mono">{{ offer }}</b>
        <em class="t-2">在另一台上输入这串码，这边会自动收尾</em>
      </div>

      <p class="pnote t-2">或者反过来 —— 在另一台上开码，把码输到这里：</p>
      <div class="claim">
        <input
          v-model="claimCode"
          class="input mono"
          placeholder="ABCD2345"
          maxlength="12"
          autocapitalize="characters"
          autocomplete="off"
          @keyup.enter="claim"
        />
        <button class="btn small" :disabled="busy || !claimCode.trim()" @click="claim">
          <LogIn :size="15" /> 确认
        </button>
      </div>
    </section>
    </div>

    <ActionSheet
      :open="!!peerSheet"
      :title="peerSheet?.name || peerSheet?.short || ''"
      :actions="peerActions"
      @close="peerSheet = null"
      @select="onPeerAction"
    />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开，
     这里只剩页头与内容之间那一档呼吸 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 分区标题：18 Medium（Subtitle_L）。与设置页同一档 —— 「本机 / 已配对设备 /
   加一台设备」是这一页的三个层级，12/700 的眉标写法读不出它们是「一节的标题」 */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

/* 卡头行：标题 + 右侧帮助入口（计数口径与同步机制原先平铺在卡面） */
.ghead {
  gap: var(--gap-sm);
}

/* 标题行右侧的帮助入口：InfoHint 是多根组件，类要落在包裹元素上 */
.hint-slot {
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

/* 分组行：整组挂在 .card.sub 那口浅井上（底 / 圆角 / 内距 / 无影都在 base.css 里），
   这里只留「行间细线，首行不留线」与卡头之下那 8px（标题与内容间隔，与设置页同一套） */
.rows {
  margin-top: var(--gap-sm);
}

.rows > * + * {
  border-top: 0.5px solid var(--line);
}

/* 双行行：34 的图标章 + 16 的标题 + 12 的说明，走 64 的双行列表档；
   行高撑开放的是行本身，不再叠上下内距（行间边界由 1px 分隔线画） */
.frow {
  width: 100%;
  gap: var(--gap-md);
  padding: 0;
  min-height: var(--row-h-double);
  text-align: left;
  color: inherit;
}

.fic {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.ftxt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.ftxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.94em;
  letter-spacing: 0.02em;
}

/* 常规按钮：高 40（--control-md）、左右 16、文字 14 Medium，胶囊形态 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  margin-top: var(--gap-lg);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.btn:disabled {
  opacity: var(--disabled-opacity);
}

/* 小号按钮 28（--control-sm）：与同一行里的 24 角标同一呼吸档。
   视觉不放大，命中区撑到 44（规范：可点元素热区 ≥44）；行高 64，上下各外扩 8 不叠行。 */
.btn.small {
  position: relative;
  margin-top: 0;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  font-size: var(--fs-caption);
}

.btn.small::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--hit-min);
  transform: translateY(-50%);
}

/* 输码行里的「确认」是输入框的提交键：与 40 的输入框同高，不再是一个 28 的小胶囊 */
.claim .btn.small {
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  font-size: var(--fs-callout);
}

/* 同步码块是卡内的二级面：圆角比母卡收一档（16 → 12），内距走卡片档 */
.code {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-tight);
  margin-top: var(--gap-md);
  padding: var(--pad-card);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}

.code b {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: 0.18em;
  color: var(--text-1);
}

.code em {
  font-style: normal;
  font-size: var(--fs-caption);
}

/* 说明段：解释的是机制而非状态，字号同设置页（≥12px），行高走正文档 */
.pnote {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* 上次走哪条路：结论（哪条路 + 用时 / 时间）一行，明细降次要行 */
.sum-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

.sum-lead {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.claim {
  display: flex;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

/* 输入框：高 40、左右 16，胶囊形态与同行的按钮同档 */
.input {
  flex: 1;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  border: 0.5px solid var(--line);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-body);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.input::placeholder {
  color: var(--text-3);
  letter-spacing: 0.14em;
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   三张卡是同一层的三件事：本机是谁 / 连了谁 / 怎么再加一台。
   前两张并排（都是「读」，交给 .d-grid 缺省的两栏）；第三张是「写」——
   要输入、还会吐出一串大号同步码，塞进半栏会把它自己的按钮和码挤到一起。
   让它通栏（.d-full），内部再分两栏：
   左边「在这台开码」（码跟着它），右边「在另一台开码、把码输进来」。
   ============================================================ */

.desk-main .add-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 var(--desk-gap);
  align-items: start;
}

.desk-main .add-card > .gtitle {
  grid-column: 1 / -1;
}

/* 「在这台开码」与它会吐出的那串码同栏；两段说明与输入框同栏 */
.desk-main .add-card > .card.sub,
.desk-main .add-card > .code {
  grid-column: 1;
}

.desk-main .add-card > .pnote,
.desk-main .add-card > .claim {
  grid-column: 2;
}

/* 右栏首行是句小字，加个与 .card.sub 同值的 4px 起始偏移，两栏的第一行才齐平 */
.desk-main .add-card > .pnote {
  margin-top: var(--sp-4);
}
</style>
