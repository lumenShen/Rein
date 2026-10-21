<script setup lang="ts">
/**
 * 设置页「外部访问」分区：对外服务网关的开关 / 绑定模式 / 端口 / 配对令牌 /
 * 已授权与被拦下的程序 / 允许的网页来源（Origin 白名单）/ 最近访问记录。
 *
 * 只接管理面里「看一眼、改一下、撤一个」这半张脸（`gateway_status` / `gateway_set_enabled` /
 * `gateway_set_bind` / `gateway_revoke_client` / `gateway_set_allowed_origins` /
 * `gateway_audit_recent`）；授权弹窗与它的单例状态机在另一层
 * （`components/settings/GatewayAuthSheet.vue` + `system/externalAccessRuntime.ts`）。
 *
 * 服务**默认关**：用户开了才监听端口（contract §4.1）—— 界面文案照此写实，不美化。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Globe,
  History,
  KeyRound,
  Link2,
  Power,
  RefreshCw,
  Server,
  ShieldAlert,
  TriangleAlert,
  Unplug,
} from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { gatewayService } from '@/services/gatewayService'
import { fmtRelativeTime } from '@/utils/format'
import {
  GATEWAY_SCOPE_LABELS,
  type GatewayAuditEntry,
  type GatewayBindMode,
  type GatewayBlocked,
  type GatewayClient,
  type GatewayScope,
  type GatewayStatus,
} from '@/types'

const { toast } = useToast()

/** 设置页只看最近这些条访问记录（最小实现，不做筛选）；后端把 limit 夹在 [1, 500]。 */
const AUDIT_LIMIT = 20

const status = ref<GatewayStatus | null>(null)
const audit = ref<GatewayAuditEntry[]>([])
/** 「允许的网页来源」输入框的待添加串（回车或点「添加」提交）。 */
const originDraft = ref('')
const busy = ref(false)

const BIND_OPTIONS = [
  { value: 'local', label: '仅本机', testid: 'gateway-bind-local' },
  { value: 'lan', label: '局域网', testid: 'gateway-bind-lan' },
]

const enabled = computed(() => status.value?.enabled ?? false)
const bindMode = computed<GatewayBindMode>(() => status.value?.bindMode ?? 'local')
const port = computed(() => status.value?.port ?? null)
const clients = computed(() => status.value?.clients ?? [])
const blocked = computed(() => status.value?.blocked ?? [])
const pendingCount = computed(() => status.value?.pendingCount ?? 0)
const pairToken = computed(() => status.value?.pairToken ?? null)
const allowedOrigins = computed(() => status.value?.allowedOrigins ?? [])
const blockedOrigins = computed(() => status.value?.blockedOrigins ?? [])

/** 复制配对令牌（局域网模式下外部程序第一次连接要带它）。失败时不吞掉，给用户提示手动抄。 */
async function copyPairToken(): Promise<void> {
  const t = pairToken.value
  if (!t) return
  try {
    await navigator.clipboard.writeText(t)
    toast('已复制配对令牌')
  } catch {
    toast('复制失败，请手动选中复制')
  }
}

/** 卡头右侧的一句话：不开卡片也知道现在是什么状态 */
const stateHint = computed(() => {
  if (pendingCount.value > 0) return `等待授权 ${pendingCount.value} 个`
  if (!enabled.value) return '未开启'
  return clients.value.length > 0 ? `已授权 ${clients.value.length} 个程序` : '监听中 · 还没有程序接入'
})

const portHint = computed(() => {
  if (!enabled.value) return '开启后才会绑定端口，被占用时自动往后顺延'
  return bindMode.value === 'lan' ? '局域网已开放 · 同网段设备可连' : '仅本机可连（127.0.0.1 / ::1）'
})

async function refresh(): Promise<void> {
  try {
    status.value = await gatewayService.status()
  } catch (e) {
    console.warn('[gateway] 读取服务状态失败', e)
  }
}

/** 拉最近若干条访问审计。外部调用**不会**推 `authorization-changed`（它只在开关 / 授权变更时发），
 * 所以这里除了挂载与事件，还得有个手动「刷新」出口，否则用户永远看不到别人的调用记录。 */
async function refreshAudit(): Promise<void> {
  try {
    audit.value = await gatewayService.auditRecent(AUDIT_LIMIT)
  } catch (e) {
    console.warn('[gateway] 读取访问记录失败', e)
  }
}

/** 所有改动都走它：忙碌期拦重复点击；失败回读真实状态，别把没生效的假值留在界面上 */
async function run(action: () => Promise<GatewayStatus>, failText: string): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  try {
    status.value = await action()
    return true
  } catch (e) {
    console.warn('[gateway] 操作失败', e)
    toast(failText)
    await refresh()
    return false
  } finally {
    busy.value = false
  }
}

const toggleChoice = computed({
  get: () => enabled.value,
  set: (on: boolean) => {
    void run(() => gatewayService.setEnabled(on), on ? '开启失败，请稍后重试' : '关闭失败，请稍后重试')
  },
})

const bindChoice = computed({
  get: () => bindMode.value as string,
  set: (v: string) => {
    if (v === bindMode.value) return
    const mode = v as GatewayBindMode
    void run(() => gatewayService.setBind(mode, null), '切换绑定模式失败，请稍后重试')
  },
})

async function revoke(c: { clientId: string; name: string }): Promise<void> {
  const name = c.name || '该程序'
  const ok = await run(() => gatewayService.revokeClient(c.clientId), '操作失败，请稍后重试')
  if (ok) toast(`已解除「${name}」的限制`)
}

/* ---- 允许的网页来源（Origin 白名单，contract §15.2） ---- */

/** 写白名单是**整表替换**：增与删都算出新表，交给同一个命令。 */
async function writeOrigins(next: string[], okText: string): Promise<boolean> {
  const ok = await run(() => gatewayService.setAllowedOrigins(next), '设置失败，请稍后重试')
  if (ok) toast(okText)
  return ok
}

/** 加一个来源。空串 / 重复一律不提交（匹配是精确字符串相等，重复项没有意义）。 */
async function addOrigin(): Promise<void> {
  const origin = originDraft.value.trim()
  if (!origin) return
  if (allowedOrigins.value.includes(origin)) {
    toast('这个来源已经在白名单里了')
    return
  }
  if (await writeOrigins([...allowedOrigins.value, origin], `已放行「${origin}」`)) {
    originDraft.value = ''
  }
}

async function removeOrigin(origin: string): Promise<void> {
  await writeOrigins(
    allowedOrigins.value.filter((o) => o !== origin),
    `已不再放行「${origin}」`,
  )
}

/** 「被拦下的来源」一键加白（§15.2b：这是用户知道该填什么的唯一实用路径）。 */
async function allowOrigin(origin: string): Promise<void> {
  await writeOrigins([...allowedOrigins.value, origin], `已放行「${origin}」`)
}

/** 「被拦下」的原因文案。 */
function blockedReason(b: GatewayBlocked): string {
  if (b.reason === 'deny') return '你拒绝过它'
  if (b.reason === 'revoked') return '授权已撤销'
  return '连续忽略，暂时不再弹窗'
}

/** scope 串 → 中文；后端将来加了新串也不会显示一片空白 */
function scopeLabel(s: string): string {
  return GATEWAY_SCOPE_LABELS[s as GatewayScope] ?? s
}

function scopesText(c: GatewayClient): string {
  if (c.scopes.length === 0) return '未授予任何权限'
  return c.scopes.map(scopeLabel).join('、')
}

function fmtSeen(iso: string): string {
  return fmtRelativeTime(iso, '—')
}

/** 最后活跃时间；「在线」本身由行首图标章 + 胶囊承载，不挤进这句话 */
function seenText(c: GatewayClient): string {
  if (!c.lastSeen) return '从未活跃'
  return `最后活跃 ${fmtSeen(c.lastSeen)}`
}

/* ---- 最近访问记录（`gateway_audit_recent`） ---- */

/** 一行审计里「谁」：认出来了就显示 clientId（截断，完整串对用户没信息量），否则只能给 IP。 */
function auditWho(a: GatewayAuditEntry): string {
  if (a.clientId) return a.clientId.length > 14 ? `${a.clientId.slice(0, 14)}…` : a.clientId
  return a.ip ? `来源 ${a.ip}` : '未知来源'
}

function auditResult(a: GatewayAuditEntry): string {
  if (a.decision === 'allowed') return '成功'
  if (a.decision === 'denied') return '被拒'
  return '出错'
}

/** 「何时 · 做了什么 · 耗时」。结果（成功/被拒/出错）提到行首胶囊，方法标识只显示中文 scope 名
    （`todo.list` 这类后端标识符对用户没有信息量）。`method` 为空串 = 连接 / 鉴权阶段就结束了。 */
function auditWhat(a: GatewayAuditEntry): string {
  if (!a.method) return `${fmtSeen(a.at)} · 连接 / 鉴权未通过${a.ip ? ` · ${a.ip}` : ''}`
  const what = a.scope ? scopeLabel(a.scope) : a.method
  const cost = a.durationMs > 0 ? ` · ${a.durationMs}ms` : ''
  return `${fmtSeen(a.at)} · ${what}${cost}`
}

let offChanged: (() => void) | null = null

onMounted(async () => {
  await refresh()
  await refreshAudit()
  // 授权 / 撤销后 Rust 会推一份新状态；订阅它，列表就不必轮询
  offChanged = await gatewayService.onAuthorizationChanged((s) => {
    status.value = s
    // 授权裁决本身会落审计（拒绝 / 超时 / 忽略），顺带把记录刷新一次
    void refreshAudit()
  })
})

onUnmounted(() => {
  offChanged?.()
})
</script>

<template>
  <section class="card d-full" data-testid="settings-external-access">
    <header class="row between ghead">
      <h2 class="gtitle">外部访问</h2>
      <span class="t-2">{{ stateHint }}</span>
    </header>

    <p class="pnote t-2">
      让这台电脑上的其它程序（桌面客户端、小组件）读写在 Rein 里的日程、番茄钟与运动数据。
      每个程序连上来都要你当面批一次，只拿到你勾的那几项权限；下面随时可以撤销。
    </p>

    <div class="card sub rows">
      <div class="frow row">
        <i class="fic" :class="{ on: enabled }"><Power :size="17" /></i>
        <span class="col ftxt">
          <b>对外服务</b>
          <em class="t-2">{{ enabled ? '正在监听，外部程序可以连' : '默认关闭，不监听任何端口' }}</em>
        </span>
        <ToggleSwitch v-model="toggleChoice" label="对外服务" :disabled="busy" data-testid="gateway-toggle-enabled" />
      </div>

      <div class="frow row">
        <i class="fic" :class="{ on: enabled && port !== null }"><Server :size="17" /></i>
        <span class="col ftxt">
          <b v-if="port !== null" class="num">端口 {{ port }}</b>
          <b v-else>端口未监听</b>
          <em class="t-2">{{ portHint }}</em>
        </span>
      </div>
    </div>

    <h3 class="stitle">谁能连</h3>
    <div class="segwrap" data-testid="gateway-bind-mode">
      <SegmentedControl v-model="bindChoice" :options="BIND_OPTIONS" />
    </div>
    <p class="pnote t-2">
      「仅本机」只绑 127.0.0.1：这台电脑上的程序才连得上；网页（带着 Origin 的浏览器连接）在握手阶段就被拒掉。
    </p>

    <p v-if="bindMode === 'lan'" class="warn row">
      <TriangleAlert :size="16" class="warn-ico" />
      <span class="col">
        <b>局域网模式把这个端口开给了同网段的设备</b>
        <em>
          同一个 WiFi（宿舍、公司、咖啡店）里的其它设备都能扫到它，拿到配对令牌就能读写你授权过的数据；
          局域网模式下数据不经加密，只在自家可信网络里开，用完切回「仅本机」。
        </em>
      </span>
    </p>

    <div v-if="pairToken" class="card sub rows paircard">
      <div class="frow row">
        <i class="fic on"><KeyRound :size="17" /></i>
        <span class="col ftxt">
          <b>配对令牌</b>
          <em class="t-2">
            {{
              bindMode === 'lan'
                ? '外部程序第一次连接时必须带上它。仅本机设置页可见，别外传。'
                : '仅本机模式不必带；切到「局域网」后，外部程序第一次连接时也要带上它。别外传。'
            }}
          </em>
          <code class="paircode" data-testid="gateway-pair-token">{{ pairToken }}</code>
        </span>
        <button
          type="button"
          class="copy"
          data-testid="gateway-copy-pair-token"
          @click="copyPairToken"
        >
          复制
        </button>
      </div>
    </div>

    <h3 class="stitle">已授权的程序</h3>
    <EmptyState
      v-if="clients.length === 0"
      :icon="Globe"
      title="还没有程序接入"
      hint="外部程序连上来、你在弹窗里点了「允许」之后，会出现在这里"
    />

    <div v-else class="card sub rows">
      <div
        v-for="c in clients"
        :key="c.clientId"
        class="frow row"
        :data-testid="`gateway-client-${c.clientId}`"
      >
        <i class="fic" :class="{ on: c.online }">
          <component :is="c.online ? Link2 : Unplug" :size="17" />
        </i>
        <span class="col ftxt">
          <b>{{ c.name || '未命名程序' }}</b>
          <!-- 授权方式 / 权限条数 / 在线态各走胶囊；名单与活跃时间降为次要行，不再「·」串同权灰字 -->
          <span class="fmeta">
            <StatusChip v-if="c.online" tone="ok">在线</StatusChip>
            <StatusChip>{{ c.grant === 'always' ? '始终允许' : '本次会话' }}</StatusChip>
            <StatusChip v-if="c.scopes.length">{{ c.scopes.length }} 项权限</StatusChip>
          </span>
          <em class="t-2">{{ scopesText(c) }}</em>
          <em class="t-2">{{ seenText(c) }}</em>
        </span>
        <button
          type="button"
          class="revoke"
          :disabled="busy"
          :data-testid="`gateway-client-revoke-${c.clientId}`"
          :aria-label="`撤销「${c.name || '未命名程序'}」的访问权限`"
          @click="revoke(c)"
        >
          撤销
        </button>
      </div>
    </div>

    <template v-if="blocked.length > 0">
      <h3 class="stitle">被拦下的程序</h3>
      <p class="pnote t-2">
        你拒绝过、或撤销过授权、或连续忽略进入静默的程序会列在这里。点「解除」让它回到未记录状态
        —— 下次再连会重新询问。
      </p>
      <div class="card sub rows">
        <div
          v-for="b in blocked"
          :key="b.clientId"
          class="frow row"
          :data-testid="`gateway-blocked-${b.clientId}`"
        >
          <i class="fic"><Ban :size="17" /></i>
          <span class="col ftxt">
            <b>{{ b.name || '未命名程序' }}</b>
            <em class="t-2">{{ blockedReason(b) }}</em>
            <em v-if="b.ip" class="t-2">来自 {{ b.ip }}</em>
          </span>
          <button
            type="button"
            class="unblock"
            :disabled="busy"
            :data-testid="`gateway-blocked-unblock-${b.clientId}`"
            :aria-label="`解除对「${b.name || '未命名程序'}」的限制`"
            @click="revoke({ clientId: b.clientId, name: b.name })"
          >
            解除
          </button>
        </div>
      </div>
    </template>

    <h3 class="stitle row">
      允许的网页来源
      <!-- WebView2 / Origin / 字面量 null / 匹配规则：实现细节收进标题行右端，卡面只留结论 -->
      <InfoHint
        title="允许的网页来源"
        content="桌面小组件是 HTML（WebView2 / Electron / file://）时，握手会带 Origin；原生程序不带，不受这里影响。

匹配是精确字符串相等、大小写敏感：不做通配、子域与前缀。file:// 页面的 Origin 就是字面量 null。

被拦下来的来源列在下方「被拦下的来源」，可以在那里一键加白。"
      />
    </h3>
    <p class="pnote t-2">
      只有精确等于下列字符串的来源能被网页客户端连入（区分大小写，不支持通配）。
    </p>
    <div class="addrow row">
      <input
        v-model="originDraft"
        class="input mono"
        placeholder="http://localhost:5173 或 null"
        autocomplete="off"
        spellcheck="false"
        data-testid="gateway-origin-input"
        @keyup.enter="addOrigin"
      />
      <button
        type="button"
        class="copy"
        :disabled="busy || !originDraft.trim()"
        data-testid="gateway-origin-add"
        @click="addOrigin"
      >
        添加
      </button>
    </div>

    <EmptyState
      v-if="allowedOrigins.length === 0"
      :icon="Globe"
      title="还没有放行任何网页来源"
      hint="默认只放行不带 Origin 的原生程序；网页客户端要先在这里加白"
    />
    <div v-else class="card sub rows">
      <div
        v-for="(o, i) in allowedOrigins"
        :key="o"
        class="frow row"
        :data-testid="`gateway-origin-${i}`"
      >
        <i class="fic on"><Globe :size="17" /></i>
        <span class="col ftxt">
          <b class="mono origin">{{ o }}</b>
        </span>
        <button
          type="button"
          class="revoke"
          :disabled="busy"
          :data-testid="`gateway-origin-remove-${i}`"
          :aria-label="`不再放行「${o}」`"
          @click="removeOrigin(o)"
        >
          移除
        </button>
      </div>
    </div>

    <template v-if="blockedOrigins.length > 0">
      <h3 class="stitle">被拦下的来源</h3>
      <p class="pnote t-2">
        这些来源在握手阶段被拒（403，已记进下面的访问记录）。「加入白名单」即放行它的连接
        —— 放行不等于免检：它照样要过配对令牌与授权弹窗。
      </p>
      <div class="card sub rows">
        <div
          v-for="(o, i) in blockedOrigins"
          :key="o"
          class="frow row"
          :data-testid="`gateway-blocked-origin-${i}`"
        >
          <i class="fic"><ShieldAlert :size="17" /></i>
          <span class="col ftxt">
            <b class="mono origin">{{ o }}</b>
          </span>
          <button
            type="button"
            class="unblock"
            :disabled="busy"
            :data-testid="`gateway-blocked-origin-allow-${i}`"
            :aria-label="`放行来源「${o}」`"
            @click="allowOrigin(o)"
          >
            加入白名单
          </button>
        </div>
      </div>
    </template>

    <h3 class="stitle">
      最近访问记录
      <button
        type="button"
        class="refresh"
        :disabled="busy"
        data-testid="gateway-audit-refresh"
        aria-label="刷新访问记录"
        @click="refreshAudit"
      >
        <RefreshCw :size="13" />刷新
      </button>
    </h3>
    <div class="audit-note row">
      <p class="pnote t-2">每次调用与每次被拒都记一行，只读成功不记。</p>
      <!-- 记录边界（参数挑字段、截断、大字段不入表）是后端存储实现，收进说明入口 -->
      <InfoHint
        title="访问记录记什么"
        content="每次调用与每次被拒都记一行，只读成功不记。

记下的参数按域白名单挑字段并做截断，附件一类大字段不入表 —— 这是存储边界，不是审计范围的变化。"
      />
    </div>
    <EmptyState
      v-if="audit.length === 0"
      :icon="History"
      title="还没有访问记录"
      hint="有外部程序连上来（哪怕被拒）之后，这里就会出现条目"
    />
    <div v-else class="card sub rows">
      <div
        v-for="a in audit"
        :key="a.id"
        class="frow row"
        :data-testid="`gateway-audit-${a.id}`"
      >
        <i class="fic" :class="a.decision === 'allowed' ? 'on' : 'bad'">
          <component :is="a.decision === 'allowed' ? CheckCircle2 : AlertCircle" :size="17" />
        </i>
        <span class="col ftxt">
          <b class="audit-who">
            {{ auditWho(a) }}
            <!-- 结果提到行首胶囊（配行首图标章）；方法标识只显示中文 scope 名 -->
            <StatusChip :tone="a.decision === 'allowed' ? 'ok' : 'danger'">{{ auditResult(a) }}</StatusChip>
          </b>
          <em class="t-2">{{ auditWhat(a) }}</em>
          <em v-if="a.detail" class="t-3 detail">{{ a.detail }}</em>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 卡片级分区标题：18 Medium（Subtitle_L），与设置主页同一档 —— 一页里「对外服务 /
   授权记录」这些区块要读得出是「一节」，而不是一条批注。 */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

/* 卡片内部的小节标题降一档：16 Semibold 与 18 Medium 拉开层级，
   否则同屏两级标题一样大，读不出谁包含谁 */
.stitle {
  margin-top: var(--gap-lg);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

/* 小节标题行带说明入口的：? 推到行尾，与标题同行（落点约定见 InfoHint 注释） */
.stitle.row {
  gap: var(--gap-sm);
}

.stitle.row .info-hint {
  margin-left: auto;
}

/* 卡头与下面那口浅井之间：标题与内容间隔 8（与设置页其它分区同一条节奏） */
.ghead + .card.sub {
  margin-top: var(--gap-sm);
}

.pnote {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.segwrap {
  margin-top: var(--gap-md);
}

/* 行组：图标章 + 标题/说明 + 尾部控件（与设置页其它分区的格内行同构） */
/* 双行行：走 64 的双行列表档（34 图标章 + 16 标题 + 12 说明），
   行间边界由 1px 分隔线画，不再叠上下内距 */
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
  background: var(--surface-2);
  color: var(--text-2);
}

.fic.on {
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
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 授权方式 / 权限条数 / 在线态各走一枚胶囊；权限名单与活跃时间才是下面的次要行 */
.fmeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--sp-2);
}

/* 行间细线，首行不留线 */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

/* 局域网风险提示：说的是「数据可能被谁拿走」，用危险色，别做成一句可有可无的注脚 */
.warn {
  margin-top: var(--gap-md);
  gap: var(--gap-sm);
  align-items: flex-start;
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-m-nest);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.warn-ico {
  flex: none;
  margin-top: var(--sp-2);
}

.warn b {
  font-weight: var(--fw-semibold);
}

.warn em {
  font-style: normal;
}

/* 行尾小按钮：高 28（--control-sm），左右 12，胶囊，12 Medium。
   视觉保持 28，命中区撑到 44（规范：可点元素热区 ≥44）—— 行高 64，
   上下各外扩 8 不会压到相邻行。 */
.revoke,
.copy,
.unblock {
  position: relative;
}

.revoke::after,
.copy::after,
.unblock::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--hit-min);
  transform: translateY(-50%);
}

.revoke {
  flex: none;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.paircard {
  margin-top: var(--gap-md);
}

/* 复制按钮：中性色，与「撤销」的红色区分开 */
.copy {
  flex: none;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 令牌串：等宽、可选中、长串换行，别被 ellipsis 吞掉尾部 */
.paircode {
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--text-2);
  word-break: break-all;
  user-select: all;
}

.revoke:disabled {
  opacity: var(--disabled-opacity);
}

/* 「被拦下」的解除按钮：中性色（不是破坏性操作） */
.unblock {
  flex: none;
  min-height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.unblock:disabled {
  opacity: var(--disabled-opacity);
}

/* 「允许的网页来源」输入行：输入框 + 添加 */
.addrow {
  margin-top: var(--gap-md);
  gap: var(--gap-sm);
}

.input {
  flex: 1;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  border: 0.5px solid var(--line);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
}

.input::placeholder {
  color: var(--text-3);
}

/* 「添加」是输入行的提交键：与输入框同高（40），不再是一个 30px 的小胶囊 */
.addrow .copy {
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  font-size: var(--fs-callout);
}

/* Origin / clientId 这类机器串：等宽、可选中；长串换行别被 ellipsis 吞掉尾部 */
.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.origin {
  word-break: break-all;
  user-select: all;
}

.fic.bad {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

/* 审计的参数摘要 / 错误串：整行可读优先，不吃 .ftxt em 的单行截断 */
.ftxt em.detail {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  word-break: break-all;
  line-height: var(--lh-body);
}

/* 审计行主标题：截断 ID + 结果胶囊同一行，长 ID 不把胶囊顶出行外 */
.audit-who {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  min-width: 0;
}

/* 审计标题右侧的刷新（外部调用不推事件，只能手动拉） */
.refresh {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  margin-left: var(--gap-sm);
  min-height: var(--chip-h);
  padding: var(--sp-2) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 视觉 22px 不变，热区撑到 44：刷新是审计区唯一的手动更新入口 */
.refresh::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: calc(100% + 16px);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
}

/* 可见按压态（STANDARDS §4）：四枚行尾按钮同一档缩放 */
.revoke:active,
.copy:active,
.unblock:active,
.refresh:active {
  transform: scale(0.97);
}

.refresh:disabled {
  opacity: var(--disabled-opacity);
}

/* 「添加」空串时禁点：与其它禁点按钮同一档禁用浓度 */
.copy:disabled {
  opacity: var(--disabled-opacity);
}

/* 记录边界的一行结论 + 说明入口：入口推到行尾 */
.audit-note {
  gap: var(--gap-sm);
  align-items: center;
}

.audit-note .info-hint {
  margin-left: auto;
}
</style>
