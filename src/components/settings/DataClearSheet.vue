<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { AlertTriangle, Check, ChevronLeft, Loader2, Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { maintenanceService } from '@/services/maintenanceService'
import type { DataClearItem, DataClearPreview, DataClearReport, DataClearScope } from '@/types'
import { humanBytes } from '@/utils/format'

/**
 * 清除软件数据（设置页「数据」组的抽屉）。
 *
 * 三步走，两段确认：
 *  ① 选档：四档深度（缓存 / AI 会话 / 业务数据 / 恢复出厂），档与档互不包含——
 *     「业务数据」不带走 AI 聊天；想全清的直接选最深那档；
 *  ② 确认：后端统计出「每类多少条 / 多少字节」的真实清单 + 警示语，让「将失去什么」
 *     先于按钮出现；
 *  ③ 长按 1.5 秒才执行——比双击确认多一道闸：长按没法被连点、误触和惯性手势误发。
 *
 * 深层档（除缓存外）清完应用自动重启：前端 store、KB 线程内存态、抢课名单缓存
 * 都还记着旧数据，重启是唯一能把它们一起甩干净的办法。
 */

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { toast } = useToast()

/** 档位元数据：选档页的一句话说明 + 确认页的警示文案（一份说清，两处引用） */
const SCOPES: { id: DataClearScope; title: string; desc: string; warnings: string[] }[] = [
  {
    id: 'cache',
    title: '缓存文件',
    desc: '更新安装包与嵌入模型缓存——都可重新获得，无损失、无需重启',
    warnings: ['清掉的东西都会自己长回来（安装包重新下载、嵌入模型按需重下），不影响任何记录。'],
  },
  {
    id: 'ai',
    title: 'AI 会话与记忆',
    desc: '聊天记录、长期记忆、用量统计、语音纪要（含录音文件）',
    warnings: [
      '不可撤销：AI 会话与长期记忆清掉就找不回来了。',
      '清除完成后应用会自动重启。',
    ],
  },
  {
    id: 'business',
    title: '业务与健康数据',
    desc: '饮食、训练、待办、记账、身体指标、方案、校园课表；AI 配置与密钥保留',
    warnings: [
      '不可撤销：这些记录清掉就找不回来了（内置课程与动作会在重启后自动补回）。',
      '开启了多设备同步时，删除会随同步传播到其他设备。',
      '清除完成后应用会自动重启。',
    ],
  },
  {
    id: 'factory',
    title: '全部数据（恢复出厂）',
    desc: '以上全部，外加 AI 工作区文件、模型与密钥、同步配对、应用设置',
    warnings: [
      '与恢复出厂等效：包括 AI 模型与密钥、AI 工作区文件、同步配对与应用设置在内的一切数据都会被抹掉。',
      '完成后应用自动重启；重启后内置内容（食物库、动作库、内置课程）自动补回。',
    ],
  },
]

const step = ref<'choose' | 'confirm' | 'done'>('choose')
const scope = ref<DataClearScope | null>(null)
const preview = ref<DataClearPreview | null>(null)
const loadingPreview = ref(false)
const running = ref(false)
const report = ref<DataClearReport | null>(null)

const meta = computed(() => SCOPES.find((s) => s.id === scope.value) ?? null)

watch(
  () => props.open,
  (open) => {
    if (open) {
      step.value = 'choose'
      scope.value = null
      preview.value = null
      running.value = false
      report.value = null
    }
    // 抽屉关掉时按住可能还没松（面板已从 DOM 摘掉，pointerup 落不到按钮上）——
    // 不停掉的话 rAF 会摸到 1 并在看不见的地方真的执行清除
    holdStop()
  },
)

async function goConfirm(): Promise<void> {
  if (!scope.value || loadingPreview.value) return
  loadingPreview.value = true
  try {
    preview.value = await maintenanceService.preview(scope.value)
    step.value = 'confirm'
  } catch (e) {
    toast(e instanceof Error ? e.message : '统计失败，请稍后再试')
  } finally {
    loadingPreview.value = false
  }
}

/** 清单项的右列：条数与字节的并集写法 */
function itemText(it: DataClearItem): string {
  if (it.count === null && it.bytes === null) return ''
  const parts: string[] = []
  if (it.count !== null) parts.push(it.count === 0 ? '无' : `${it.count} 条`)
  if (it.bytes !== null) parts.push(humanBytes(it.bytes))
  return parts.join(' · ')
}

/* ---------- 长按确认：1.5 秒填充进度，松手即取消（键盘按住空格/回车同样成立） ---------- */
const HOLD_MS = 1500
const progress = ref(0)
const holding = ref(false)
let raf = 0
let last = 0

function holdStart(): void {
  if (running.value || report.value || holding.value) return
  holding.value = true
  last = performance.now()
  const tick = (now: number): void => {
    if (!holding.value) return
    progress.value = Math.min(1, progress.value + (now - last) / HOLD_MS)
    last = now
    if (progress.value >= 1) {
      holding.value = false
      progress.value = 0
      void execute()
      return
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

function holdStop(): void {
  holding.value = false
  progress.value = 0
  cancelAnimationFrame(raf)
}

function holdKey(e: KeyboardEvent): void {
  if (e.key !== ' ' && e.key !== 'Enter') return
  e.preventDefault()
  if (e.type === 'keydown') {
    if (!e.repeat) holdStart()
  } else {
    holdStop()
  }
}

onBeforeUnmount(holdStop)

async function execute(): Promise<void> {
  if (!scope.value || running.value) return
  running.value = true
  try {
    report.value = await maintenanceService.clear(scope.value)
    step.value = 'done'
    // 结论由完成页持久承载（toast 与完成页不再同屏说同一句话）
    toast('已清除')
    // 报告先给用户读完（完成页），再退进程重启
    if (preview.value?.restartsApp) {
      setTimeout(() => {
        void maintenanceService.restart().catch(() => {
          toast('未能自动重启，请手动重启应用')
        })
      }, 1400)
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : '清除失败，数据未受影响')
  } finally {
    running.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="清除软件数据" @close="emit('close')">
    <!-- ① 选档 -->
    <div v-if="step === 'choose'" class="steps">
      <p class="lead t-2">选一档要清除的深度。每一档只清自己声明的范围，都不可撤销——下一步会先给你看完整清单。</p>
      <div class="card sub rows">
        <button
          v-for="s in SCOPES"
          :key="s.id"
          class="scope"
          :class="{ on: scope === s.id }"
          :data-testid="`data-clear-scope-${s.id}`"
          @click="scope = s.id"
        >
          <span class="col ftxt">
            <b :class="{ danger: s.id === 'factory' }">{{ s.title }}</b>
            <em class="t-2">{{ s.desc }}</em>
          </span>
          <i class="tick" aria-hidden="true"><Check :size="14" :stroke-width="3" /></i>
        </button>
      </div>
    </div>

    <!-- ② 确认：真实统计的清单 + 警示 + 长按 -->
    <div v-else-if="step === 'confirm' && meta && preview" class="steps">
      <button class="back" data-testid="data-clear-back" @click="step = 'choose'">
        <ChevronLeft :size="15" /> 重选档位
      </button>
      <div class="card sub rows list">
        <div
          v-for="it in preview.items"
          :key="it.key"
          class="pitem"
          :class="{ zero: !it.count && !it.bytes }"
          :data-testid="`data-clear-item-${it.key}`"
        >
          <span>{{ it.label }}</span>
          <span class="t-2 pnum">{{ itemText(it) }}</span>
        </div>
      </div>
      <!-- 长按确认前最要紧的结论：继承正文字号（比明细行更大），数字等宽加粗右对齐 -->
      <p v-if="preview.totalBytes > 0" class="total">约可释放 <b class="num">{{ humanBytes(preview.totalBytes) }}</b></p>
      <div class="warn" role="alert">
        <AlertTriangle :size="15" class="warn-ic" />
        <div class="warn-body">
          <p v-for="w in meta.warnings" :key="w">{{ w }}</p>
        </div>
      </div>
    </div>

    <!-- ③ 完成 -->
    <div v-else-if="step === 'done' && report" class="steps done">
      <div class="done-ic"><Check :size="22" :stroke-width="2.5" /></div>
      <b>已清除<span v-if="report.freedBytes > 0">，释放 <span class="num">{{ humanBytes(report.freedBytes) }}</span></span></b>
      <p v-if="report.failures.length" class="t-2 fail-note">
        有 {{ report.failures.length }} 个文件正被占用没能删除（不影响数据，下次清除会再试）：{{ report.failures.join('；') }}
      </p>
      <p v-if="preview?.restartsApp" class="t-2" data-testid="data-clear-restarting">应用即将重启以完成清理…</p>
      <button v-else class="primary" data-testid="data-clear-done" @click="emit('close')">完成</button>
    </div>

    <!-- 完成步不再需要操作区：槽整体不下发，免得 SheetModal 渲染一条空的底栏 -->
    <template v-if="step !== 'done'" #footer>
      <button
        v-if="step === 'choose'"
        class="primary"
        :disabled="!scope || loadingPreview"
        data-testid="data-clear-continue"
        @click="goConfirm"
      >
        <Loader2 v-if="loadingPreview" :size="16" class="spin" />
        <Trash2 v-else :size="16" />
        {{ loadingPreview ? '正在统计…' : '查看将清除的内容' }}
      </button>
      <button
        v-else-if="step === 'confirm'"
        class="hold"
        :class="{ isholding: holding, running }"
        data-testid="data-clear-hold"
        :disabled="running"
        aria-label="长按 1.5 秒确认清除"
        @pointerdown="holdStart"
        @pointerup="holdStop"
        @pointercancel="holdStop"
        @pointerleave="holdStop"
        @contextmenu.prevent
        @keydown="holdKey"
        @keyup="holdKey"
      >
        <i class="fill" :style="{ transform: `scaleX(${progress})` }" aria-hidden="true" />
        <span>{{ running ? '正在清除…' : holding ? '松手即取消' : '长按 1.5 秒确认清除' }}</span>
      </button>
    </template>
  </SheetModal>
</template>

<style scoped>
.steps {
  display: flex;
  flex-direction: column;
}

.lead {
  margin-bottom: var(--gap-md);
  line-height: var(--lh-body);
}

/* 行间细线，首行不留线（与设置页 .rows 同一条分组规则） */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

/* 档位行：选中态描边 + 对勾点亮 */
.scope {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h);
  padding: var(--sp-8) var(--sp-2);
  text-align: left;
  color: inherit;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.scope:active {
  transform: scale(0.99);
}

.ftxt {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--gap-text);
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.ftxt b.danger {
  color: var(--danger-strong);
}

.ftxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.tick {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  color: transparent;
  transition: background var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard);
}

.scope.on .tick {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

/* 清单行：左标签右数值；这一类为空时整行淡显（仍列出——「将失去什么」要如实报全） */
.list {
  padding: var(--sp-2) var(--pad-inline);
}

.pitem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  min-height: var(--row-h);
  padding: 0;
  font-size: var(--fs-subhead);
}

.pitem.zero {
  opacity: var(--disabled-opacity);
}

.pnum {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.total {
  margin-top: var(--gap-sm);
  text-align: right;
  /* 结论行：比明细行大一档（16 对 14），只提字重与等宽数字 */
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.total b {
  font-weight: var(--fw-bold);
}

/* 警示块：danger-soft 底，正文仍读得清的文字红（--danger-strong） */
.warn {
  display: flex;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
}

.warn-ic {
  flex: none;
  margin-top: var(--sp-2);
}

.warn-body p + p {
  margin-top: var(--gap-tight);
}

.warn-body {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  line-height: var(--lh-body);
}

/* 返回上一步：视觉是一枚 12px 的文字链（约 17 高），命中区撑到 44。
   它是这一步唯一的返回口，摸不到就只能关掉整个抽屉重来。 */
.back {
  position: relative;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  margin-bottom: var(--gap-md);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.back::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--hit-min);
  transform: translateY(-50%);
}

/* 长按确认钮：实底危险红；进度层走 transform（scaleX）不重排 */
/* 底栏主操作钮：高 40（--control-md），圆角走按钮档 20，文字 14 Medium */
.hold {
  position: relative;
  overflow: hidden;
  width: 100%;
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-l);
  background: var(--danger);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  user-select: none;
  -webkit-user-select: none;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.hold:active {
  transform: scale(0.985);
}

.hold:disabled {
  opacity: var(--disabled-opacity);
}

.fill {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  transform: scaleX(0);
  transform-origin: left center;
}

.hold span {
  position: relative;
  font-variant-numeric: tabular-nums;
}

.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  width: 100%;
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}



/* 完成页：居中报告 */
.done {
  align-items: center;
  gap: var(--gap-sm);
  padding-top: var(--sp-24);
  text-align: center;
}

.done-ic {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}

.done b {
  font-size: var(--fs-title3);
  font-weight: var(--fw-semibold);
}

.fail-note {
  line-height: var(--lh-body);
}

.done .primary {
  margin-top: var(--gap-md);
}
</style>
