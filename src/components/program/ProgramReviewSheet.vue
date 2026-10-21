<script setup lang="ts">
import { computed, reactive, watch } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { useNutritionStore } from '@/stores/nutrition'
import type { ProgramChange, ProgramParams } from '@/types'
import type { AdjustmentPatch } from '@/utils/programEngine'
import { clampAdjustment } from '@/utils/programEngine'
import type { WeekCompare } from '@/ai/programReview'

/**
 * 复盘卡片流：AI 建议不再「全盘接受或全部放弃」——
 * 每条参数建议独立成卡、独立开关；勾选变化时「将变更为」实时重算
 * （仍走 clampAdjustment，越界值当场标注），最后只把勾选子集交给 store.adjust。
 */
const props = defineProps<{
  open: boolean
  phase: 'running' | 'done' | 'error'
  error: string
  diagnosis: string
  advice: string[]
  /** 模型原始建议（未经钳制） */
  proposed: AdjustmentPatch
  /** 生效中的方案参数（钳制与 diff 的基准） */
  current: ProgramParams | null
  /** 本周 vs 上周执行对比（数据先行：先看数据再看 AI 说了什么） */
  compare: WeekCompare | null
}>()

const emit = defineEmits<{
  apply: [patch: AdjustmentPatch, summary: string]
  retry: []
  close: []
}>()

const n = useNutritionStore()

interface FieldMeta {
  key: keyof AdjustmentPatch
  title: string
  reason: string
  fmt: (v: number) => string
}

const FIELD_META: FieldMeta[] = [
  {
    key: 'kcalDelta',
    title: '调整每日热量偏移',
    reason: '按最近的体重趋势与摄入达成度校准缺口',
    fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} 大卡`,
  },
  {
    key: 'proteinPerKg',
    title: '调整蛋白质配比',
    reason: '缺口下保护肌肉，按当前体重重算蛋白目标',
    fmt: (v) => `${v.toFixed(1)} g/kg`,
  },
  {
    key: 'trainingDays',
    title: '调整每周训练天数',
    reason: '依从性优先：完成不了的频次不如降下来做满',
    fmt: (v) => `${Math.round(v)} 天`,
  },
]

/** 有建议的参数才出卡片 */
const cards = computed(() => FIELD_META.filter((f) => props.proposed[f.key] != null))

const selected = reactive<Record<string, boolean>>({})

watch(
  () => [props.open, props.phase] as const,
  ([open, phase]) => {
    if (open && phase === 'done') {
      for (const f of FIELD_META) {
        const v = props.proposed[f.key]
        if (v != null) selected[f.key] = true
      }
    }
    if (!open) {
      for (const k of Object.keys(selected)) delete selected[k]
    }
  },
  { immediate: true },
)

/** 单字段 patch（TS 对计算键不做窄化，显式分支更稳） */
function patchOf(f: FieldMeta): AdjustmentPatch {
  const p: AdjustmentPatch = {}
  if (f.key === 'kcalDelta') p.kcalDelta = props.proposed.kcalDelta
  else if (f.key === 'proteinPerKg') p.proteinPerKg = props.proposed.proteinPerKg
  else p.trainingDays = props.proposed.trainingDays
  return p
}

/**
 * 各字段的钳制结果，按字段缓存一次。
 *
 * clampAdjustment 内部会用最新身体数据重算一遍 TDEE 与目标，而模板里每张卡片
 * 会引用 cardChange 两到三次 —— 直接在模板里调等于每次渲染做十几次全量重算。
 */
const changeByField = computed<Map<keyof AdjustmentPatch, ProgramChange>>(() => {
  const m = new Map<keyof AdjustmentPatch, ProgramChange>()
  if (!props.current || !n.profile) return m
  for (const f of FIELD_META) {
    if (props.proposed[f.key] == null) continue
    const { changes } = clampAdjustment(n.profile, props.current, patchOf(f))
    const hit = changes.find((c) => c.field === f.key)
    if (hit) m.set(f.key, hit)
  }
  return m
})

/** 单条卡片的钳制结果（A → B / 已钳制标注） */
function cardChange(f: FieldMeta): ProgramChange | null {
  return changeByField.value.get(f.key) ?? null
}

function isClamped(f: FieldMeta, c: ProgramChange | null): boolean {
  const raw = props.proposed[f.key]
  if (raw == null || !c) return false
  const after = Number(c.after.replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(after) && Math.abs(after - raw) > 1e-6
}

/** 勾选子集 → 实际会生效的全部变更（含目标连带变化） */
const finalChanges = computed<ProgramChange[]>(() => {
  if (!props.current || !n.profile) return []
  const patch = selectedPatch()
  if (!patch) return []
  return clampAdjustment(n.profile, props.current, patch).changes
})

function selectedPatch(): AdjustmentPatch | null {
  let any = false
  const p: AdjustmentPatch = {}
  for (const f of FIELD_META) {
    if (selected[f.key] && props.proposed[f.key] != null) {
      const one = patchOf(f)
      Object.assign(p, one)
      any = true
    }
  }
  return any ? p : null
}

const selectedCount = computed(() => cards.value.filter((f) => selected[f.key]).length)

function apply(): void {
  const patch = selectedPatch()
  if (!patch) return
  emit('apply', patch, props.diagnosis.slice(0, 60) || 'AI 周复盘调整')
}

/* ---------------- 数据先行：本周 vs 上周 ---------------- */

const compareBar = (p: { now: number; prev: number }): number => {
  const max = Math.max(p.now, p.prev, 1)
  return Math.min(p.now / max, 1)
}

const arrowOf = (p: { now: number; prev: number }): { text: string; cls: string } => {
  if (p.now > p.prev) return { text: '↑', cls: 'up' }
  if (p.now < p.prev) return { text: '↓', cls: 'down' }
  return { text: '—', cls: 'flat' }
}
</script>

<template>
  <SheetModal :open="open" title="AI 本周复盘" initial-snap="large" @close="emit('close')">
    <div class="review">
      <!-- 三阶段各自成节：keyed 容器让切换时旧分支真正离开（否则 v-if/v-else 直接替换，Transition 不触发） -->
      <Transition name="fade">
        <div v-if="phase === 'running'" key="running" class="rbody">
          <p class="t-2 center wait">正在汇总最近 7 天的执行数据并交给模型分析…</p>
          <!-- 流式：诊断文本边生成边上屏，定稿后切入下方完整卡片流 -->
          <section v-if="diagnosis" class="card">
            <header class="card-head">
              <b>诊断</b>
              <span class="tag">AI</span>
            </header>
            <p class="diag">{{ diagnosis }}<span class="caret" aria-hidden="true" /></p>
          </section>
        </div>

        <div v-else-if="phase === 'error'" key="error" class="rbody">
          <p class="err">{{ error }}</p>
          <button class="primary" @click="emit('retry')">重试</button>
        </div>

        <div v-else key="done" class="rbody">
          <!-- 数据先行：先自己看数据，再看 AI 怎么说 -->
          <section v-if="compare" class="card">
            <header class="card-head">
              <b>本周执行度</b>
              <!-- 卡片头不再写「本周 vs 上周」这种并列短语：方向和条义各钉一处
                   —— 数值行写「上周 → 本周」，这里只说明横条按本周画 -->
              <span class="t-3">横条表示本周</span>
            </header>
            <div class="bars">
              <div v-for="p in compare.points" :key="p.label" class="bar-row">
                <div class="bar-top">
                  <span>{{ p.label }}</span>
                  <span class="num">
                    上周 {{ p.prev }} → 本周 {{ p.now }} {{ p.unit }}
                    <b class="arrow" :class="arrowOf(p).cls">{{ arrowOf(p).text }}</b>
                  </span>
                </div>
                <div class="bar-track">
                  <i class="bar-fill" :style="{ transform: `scaleX(${compareBar(p)})` }" />
                </div>
              </div>
            </div>
          </section>

          <section class="card">
            <header class="card-head">
              <b>诊断</b>
              <span class="tag">AI</span>
            </header>
            <p class="diag">{{ diagnosis }}</p>
          </section>

          <!-- 建议卡片化：逐条采纳 -->
          <section v-if="cards.length" class="card">
            <header class="card-head">
              <b>建议（可逐条采纳）</b>
              <div class="head-side">
                <!-- 「已按安全值生效」的由来（引擎钳制）收进标题行右端的说明入口 -->
                <InfoHint
                  title="安全范围"
                  content="模型建议的数值如果超出安全范围，应用会按安全值生效，不会照单全收 —— 卡片上「已按安全值生效」就是这个情形。

安全范围由身体数据与方案参数推出；生效中的方案参数永远是安全范围内的值。"
                />
                <span class="tag num">已选 {{ selectedCount }} / {{ cards.length }}</span>
              </div>
            </header>
            <div v-for="f in cards" :key="f.key" class="sug">
              <button
                class="check"
                :class="{ on: selected[f.key] }"
                :aria-pressed="!!selected[f.key]"
                :aria-label="`采纳：${f.title}`"
                @click="selected[f.key] = !selected[f.key]"
              >
                {{ selected[f.key] ? '✓' : '' }}
              </button>
              <div class="sug-body">
                <p class="sug-title" :class="{ dim: !selected[f.key] }">{{ f.title }}</p>
                <p class="sug-reason">{{ f.reason }}</p>
                <span v-if="cardChange(f)" class="tag num">{{ cardChange(f)!.before }} → {{ cardChange(f)!.after }}</span>
                <span v-if="cardChange(f) && isClamped(f, cardChange(f))" class="tag clamp">超出安全范围，已按安全值生效</span>
              </div>
            </div>
          </section>
          <section v-else class="card">
            <p class="diag t-2">数据不足以支持调整，建议保持现参数再观察一周。</p>
          </section>

          <!-- 实时汇总：将变更为 -->
          <section v-if="finalChanges.length" class="card final">
            <header class="card-head">
              <b class="accent">将变更为</b>
            </header>
            <ul class="final-rows num">
              <li v-for="c in finalChanges" :key="c.field">
                <span>{{ c.label }}</span>
                <b>{{ c.before }} → {{ c.after }}</b>
              </li>
            </ul>
          </section>

          <!-- 模型的补充建议：无标题的一串子弹句原先夹在卡片与主按钮之间，来路全靠猜 -->
          <template v-if="advice.length">
            <p class="advice-title">下周执行建议</p>
            <ul class="advice">
              <li v-for="a in advice" :key="a">{{ a }}</li>
            </ul>
          </template>

          <button v-if="selectedCount" class="primary" @click="apply">
            应用这 {{ selectedCount }} 条并重排日程
          </button>
          <p v-if="selectedCount" class="foot">日程将从今天起重排，已完成的记录不受影响</p>
        </div>
      </Transition>
    </div>
  </SheetModal>
</template>

<style scoped>
.review {
  display: grid;
  gap: var(--gap-md);
  padding-bottom: var(--sp-20);
}

/* 阶段容器沿用原 .review 的间距：卡片与文案之间的间距由它接管 */
.rbody {
  display: grid;
  gap: var(--gap-md);
}

/* 三阶段切换的进出场：内容整体更换，只走不透明度且进出同向 */
.fade-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.fade-enter-from {
  opacity: 0;
}
.fade-leave-active {
  transition: none;
}

.wait {
  padding: var(--sp-26) 0;
}

.err {
  color: var(--danger);
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
}

.card {
  /* 与 ProgramEvidenceSheet 的 .card 同一档：四边 12 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.card.final {
  background: var(--accent-soft);
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
  margin-bottom: var(--sp-8);
}

/* 标题行右端：说明入口 + 计数，与标题同一行 */
.card-head .head-side {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.card-head b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.card-head b.accent {
  color: var(--accent);
}

.tag {
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
}

/* 超出安全范围：soft 底 + strong 字配套令牌（实底档 --warn 不当文字用） */
.tag.clamp {
  margin-left: var(--sp-6);
  background: var(--warn-soft);
  color: var(--warn-strong);
}

/* 数据先行条 */
.bars {
  display: grid;
  /* 诊断条之间 8（同组信息） */
  gap: var(--gap-sm);
}

.bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  margin-bottom: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 方向箭头只表示升降、不臧否得失：减脂目标下摄入升高并非好事，
   统一走中性色（原 up 染绿 / down 染红会把「升」读成「进步」） */
.arrow.up,
.arrow.down {
  color: var(--text-2);
}

.arrow.flat {
  color: var(--text-3);
}

.bar-track {
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--surface);
  overflow: hidden;
}

.bar-fill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  opacity: 0.75;
  transform-origin: left center;
  transition: transform var(--dur-base) var(--ease-standard);
}

.diag {
  font-size: var(--fs-callout);
  line-height: var(--lh-body);
}

/* 流式诊断的打字光标 */
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: var(--sp-2);
  vertical-align: -0.12em;
  background: var(--text-2);
  animation: rein-caret-blink 1s steps(2, start) infinite;
}

/* 建议卡片 */
.sug {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  /* 建议条目是双行行：上下 12、组内 8 */
  padding: var(--sp-12) 0;
  border-top: 0.5px solid var(--line);
}

.sug:first-of-type {
  border-top: none;
  padding-top: var(--sp-2);
}

.check {
  position: relative;
  flex: none;
  /* 勾选框视觉仍小（22），命中区由 ::after 补到 44（--hit-min）；
     建议行本身约 70 高，热区上下不会盖到相邻条目 */
  width: 22px;
  height: 22px;
  margin-top: var(--sp-2);
  border-radius: var(--radius-full);
  border: 1.5px solid var(--line-strong);
  background: var(--surface);
  color: var(--on-accent);
  font-size: var(--fs-caption);
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.check::after {
  content: '';
  position: absolute;
  inset: -11px;
  border-radius: var(--radius-full);
}

.check.on {
  background: var(--accent);
  border-color: var(--accent);
}

.sug-body {
  flex: 1;
  min-width: 0;
}

.sug-title {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  transition: color var(--dur-fast) var(--ease-standard);
}

.sug-title.dim {
  color: var(--text-3);
}

/* 采纳理由是要读的判断依据：三级灰是「补充」档，提到 --text-2 */
.sug-reason {
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.sug-body .tag {
  margin-top: var(--sp-6);
  display: inline-block;
  background: var(--surface);
}

/* 汇总 */
.final-rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
}

.final-rows li:first-child {
  border-top: none;
}

.final-rows span {
  color: var(--text-1);
}

.final-rows b {
  color: var(--accent);
}

/* 补充建议的小标题：交代这串子弹句是模型给的下周执行建议 */
.advice-title {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-weight: var(--fw-semibold);
}

.advice {
  display: grid;
  gap: var(--gap-tight);
  margin-top: var(--sp-4);
  padding-left: var(--sp-16);
  list-style: disc;
}

.advice li {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

.primary {
  width: 100%;
  padding: var(--sp-12) 0;
  /* 页脚主按钮走按钮档 20 */
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

.foot {
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill,
  .check,
  .sug-title {
    transition: none;
  }

  .caret {
    animation: none;
  }
}
</style>
