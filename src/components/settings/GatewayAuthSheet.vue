<script setup lang="ts">
import { computed, ref, watch, type DeepReadonly } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { externalAccessRuntime } from '@/system/externalAccessRuntime'
import {
  GATEWAY_SCOPES,
  GATEWAY_SCOPE_LABELS,
  type GatewayAuthDecision,
  type GatewayAuthRequest,
  type GatewayScope,
} from '@/types'

/**
 * 外部程序授权弹窗（全局常驻层，App.vue 挂载，无 props —— 状态来自单例 runtime）。
 *
 * 四态按钮语义独立（contract §5.1、§8.3）：允许本次会话 / 始终允许 / 忽略 / 拒绝。
 * 「不做静默通过」：抽屉的 × / 背景 / Esc 一律等同「忽略」——不落决策、连接保持
 * pending，程序既没拿到数据、也没被永久拒绝。
 *
 * **逐项勾选**（contract §5.3）：10 条 scope 全部列成可勾选行，默认只勾请求方建议的
 * 最小集（通常是 `schedule.read`）；写 / 删 / 控制权限必须用户显式勾上，`decide` 回传的是
 * 勾选集而不是服务端的建议集 —— 否则除只读日程外任何权限都授不出去。
 *
 * 带 `Origin` 的请求要如实显示出**是哪个网页来源**（contract §15）：能走进这个弹窗说明
 * 该来源已在白名单里，用户据此知道自己在给谁授权，也就能去设置里撤销这个来源。
 *
 * 超时不在这里自己计时：runtime 按 `request.timeoutMs` 计并自动按「忽略」上报，
 * 本组件只负责把「多久后会自动忽略」如实告诉用户。
 */
const live = computed(() => externalAccessRuntime.state.current)
/** 抽屉离场动画期间保留最后一条请求，避免滑出时内容已经空了。 */
const cached = ref<DeepReadonly<GatewayAuthRequest> | null>(null)
watch(live, (v) => {
  if (v) cached.value = v
})
const open = computed(() => live.value !== null)
const request = computed(() => live.value ?? cached.value)

/** 用户当前勾选的 scope 集（默认 = 请求方建议的最小集）。 */
const selected = ref<Set<string>>(new Set())
watch(
  live,
  (v) => {
    selected.value = new Set(v ? v.scopes : [])
  },
  { immediate: true },
)

function toggle(s: GatewayScope): void {
  const next = new Set(selected.value)
  if (next.has(s)) next.delete(s)
  else next.add(s)
  selected.value = next
}

/** 展示给用户的超时提示秒数（协议默认 60s）。 */
const timeoutSec = computed(() => Math.max(1, Math.round((request.value?.timeoutMs ?? 60_000) / 1000)))

/** 这条 scope 有没有中文名：未收录的新 scope 才把协议串原样显示出来（兜底只为不吞信息）。 */
function scopeKnown(s: string): boolean {
  return s in GATEWAY_SCOPE_LABELS
}

function decide(decision: GatewayAuthDecision, scopes?: string[]): void {
  void externalAccessRuntime.decide(decision, scopes)
}

/** 放行类按钮：把用户勾选集（按 Scope::ALL 的展示顺序）回传。 */
function decideAllow(decision: 'allow-session' | 'allow-always'): void {
  decide(decision, GATEWAY_SCOPES.filter((s) => selected.value.has(s)))
}

/** 未收录的新 scope 原样显示串（后端已按白名单过滤，兜底只为不吞信息）。 */
function scopeLabel(s: string): string {
  return GATEWAY_SCOPE_LABELS[s as GatewayScope] ?? s
}
</script>

<template>
  <SheetModal :open="open" title="外部程序请求访问" @close="decide('ignore')">
    <!-- 三段解释（默认勾选口径 / 连接边界 / 两种放行的寿命）与白名单、协议串线索，
         一律收进标题行右侧一枚 InfoHint：授权弹窗上最先撞见的不该是没人读的灰字长句 -->
    <template #action>
      <InfoHint title="授权说明">
        <ul class="hint-list">
          <li>默认只勾「查看日程」；写、删、控制权限要手动勾上，只有勾了的才会授出去。</li>
          <li>授权只对这一个客户端的本次连接生效，不影响其他程序。</li>
          <li>「允许本次会话」在程序关闭后失效；「始终允许」是长期授权，可随时在设置里撤销。</li>
          <li>能弹出这个窗口的网页来源，已经在「允许的网页来源」清单里；要撤掉就去设置里把它移出清单。</li>
          <li>每行只显示中文权限名；未收录的新权限会原样显示英文标识，便于排查。</li>
        </ul>
      </InfoHint>
    </template>
    <div v-if="request" class="wrap" data-testid="gateway-auth-sheet">
      <div class="who">
        <b class="cname">{{ request.clientName }}</b>
        <!-- 来源是与客户端名同档的核心事实：一枚 subhead 胶囊，不再用 caption 灰字低三档 -->
        <span v-if="request.ip" class="origin-chip">来自 {{ request.ip }}</span>
        <span v-if="request.origin" class="origin-chip">网页来源 {{ request.origin }}</span>
      </div>
      <StatusChip class="lead-chip" tone="neutral" size="md">默认只给查看日程，写权限需手动勾选</StatusChip>
      <div class="card sub rows">
        <button
          v-for="s in GATEWAY_SCOPES"
          :key="s"
          type="button"
          class="scope"
          :class="{ on: selected.has(s) }"
          :aria-pressed="selected.has(s)"
          :data-testid="`gateway-auth-scope-${s}`"
          @click="toggle(s)"
        >
          <span class="sname">{{ scopeLabel(s) }}</span>
          <code v-if="!scopeKnown(s)" class="scode t-3">{{ s }}</code>
          <span class="check" aria-hidden="true">{{ selected.has(s) ? '✓' : '' }}</span>
        </button>
      </div>
      <StatusChip class="timeout-chip" tone="warn" size="md">{{ timeoutSec }} 秒内不选择将按「忽略」处理</StatusChip>
    </div>

    <template #footer>
      <div class="acts">
        <button class="btn" data-testid="gateway-auth-ignore" @click="decide('ignore')">忽略</button>
        <button class="btn danger" data-testid="gateway-auth-deny" @click="decide('deny')">拒绝</button>
        <button class="btn" data-testid="gateway-auth-allow-session" @click="decideAllow('allow-session')">
          允许本次会话
        </button>
        <button class="btn primary" data-testid="gateway-auth-allow-always" @click="decideAllow('allow-always')">
          始终允许
        </button>
      </div>
    </template>
  </SheetModal>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
}

.who {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  margin-bottom: var(--gap-md);
}

.cname {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}

/* 来源是与客户端名同档的事实：subhead 胶囊（surface-2 底 + text-2 字）。
   来源串可能很长（完整 URL），胶囊内允许换行，不再靠 break-all 铺满一行 */
.origin-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: var(--chip-h);
  padding: var(--sp-2) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  overflow-wrap: anywhere;
}

/* 默认勾选口径做成一行结论胶囊：卡面上只留这一句，解释全在标题行的 InfoHint 里 */
.lead-chip {
  align-self: flex-start;
  margin-bottom: var(--gap-md);
}

/* InfoHint 插槽：五条授权要点走列表 */
.hint-list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin: 0;
  padding-left: var(--sp-18);
}

.hint-list li {
  line-height: var(--lh-body);
}

/* 行间细线，首行不留线（与设置页 .rows 同一条分组规则） */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

/* 权限行：48 的单行列表档，行间边界由 1px 分隔线画 */
.scope {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h);
  padding: 0;
  background: none;
  border: 0;
  text-align: left;
  color: inherit;
  cursor: pointer;
}

.scope.on .sname {
  color: var(--accent);
}

.check {
  flex: none;
  width: 1.2em;
  text-align: right;
  color: var(--accent);
  font-weight: var(--fw-bold);
}

.sname {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.scode {
  flex: none;
  font-variant-numeric: tabular-nums;
}

/* 超时时限是用户必须看到的一句：单独一枚 warn 胶囊，不混进灰字段落里 */
.timeout-chip {
  align-self: flex-start;
  margin-top: var(--gap-md);
}

/* 四态按钮：两行两列，语义同类相邻（上排「不放行」，下排「放行」） */
/* 底栏按钮组：四颗同层按钮之间 8（无边界），高 40（--control-md） */
.acts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gap-sm);
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.btn:active {
  transform: scale(0.985);
}

.btn.danger {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}
</style>
