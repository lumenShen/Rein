<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Scale, TrendingDown, TrendingUp } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import { trendGeometry } from '@/utils/chart'
import { todayStr } from '@/utils/date'
import { fmtShortDate } from '@/utils/format'
import type { BodyMetric } from '@/types'

/** 体重 · 身高追踪：按天记录、趋势与历史；非空值自动同步进身体资料。 */
const n = useNutritionStore()
const { toast } = useToast()

onMounted(() => {
  void n.loadMetrics()
})

/* ---- 当前状态（从记录回溯取最近的非空值） ---- */
type MetricField = 'weightKg' | 'heightCm'

function lastValue(key: MetricField): number | null {
  for (const m of n.metrics) {
    const v = m[key]
    if (v != null) return v
  }
  return null
}

/** 较上一条同类值的增量（正为升 / 负为降），无可比对象时为 null */
function deltaFrom(index: number, key: MetricField): number | null {
  const cur = n.metrics[index]?.[key]
  if (cur == null) return null
  for (let i = index + 1; i < n.metrics.length; i++) {
    const prev = n.metrics[i]![key]
    if (prev != null) {
      const d = Math.round((cur - prev) * 10) / 10
      return d === 0 ? null : d
    }
  }
  return null
}

const latestWeight = computed(() => lastValue('weightKg'))
const latestHeight = computed(() => lastValue('heightCm'))

const bmi = computed<{ value: number; label: string; cls: string } | null>(() => {
  const w = latestWeight.value
  const hCm = latestHeight.value ?? n.profile?.heightCm
  if (w == null || hCm == null || hCm <= 0) return null
  const v = Math.round((w / (hCm / 100) ** 2) * 10) / 10
  // 中国成人标准（WS/T 428）
  const [label, cls] =
    v < 18.5 ? ['偏瘦', 'warn'] : v < 24 ? ['正常', 'ok'] : v < 28 ? ['超重', 'warn'] : ['肥胖', 'bad']
  return { value: v, label, cls }
})

/* ---- 体重趋势（最近 ≤30 条含体重的记录，时间升序） ---- */
const CHART_W = 320
const CHART_H = 84
const PAD_X = 5
const PAD_Y = 12

const trend = computed(() =>
  [...n.metrics]
    .filter((m): m is BodyMetric & { weightKg: number } => m.weightKg != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)
    .map((m) => ({ date: m.date, v: m.weightKg })),
)

const trendGeom = computed(() => {
  const pts = trend.value
  const geom = trendGeometry(
    pts.map((p) => p.v),
    { width: CHART_W, height: CHART_H, padX: PAD_X, padY: PAD_Y },
  )
  if (!geom) return null
  return {
    ...geom,
    from: pts[0]!.date,
    to: pts[pts.length - 1]!.date,
  }
})

function fmtShort(s: string): string {
  return fmtShortDate(s)
}

/* ---- 记录弹层 ---- */
const r1 = (v: number) => Math.round(v * 10) / 10

const sheetOpen = ref(false)
const saving = ref(false)
const formDate = ref(todayStr())
const formWeight = ref(70)
const formHeight = ref(175)

function openSheet(): void {
  formDate.value = todayStr()
  formWeight.value = r1(lastValue('weightKg') ?? n.profile?.weightKg ?? 70)
  formHeight.value = r1(lastValue('heightCm') ?? n.profile?.heightCm ?? 175)
  sheetOpen.value = true
}

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    await n.recordMetric({
      date: formDate.value,
      weightKg: r1(formWeight.value),
      heightCm: r1(formHeight.value),
    })
    toast('已记录 · 身体资料已同步')
    sheetOpen.value = false
  } finally {
    saving.value = false
  }
}

/* ---- 单条记录操作 ---- */
const entryOpen = ref(false)
const entry = ref<BodyMetric | null>(null)

/** 历史列表展开（默认最近 5 条；「共 N 条」要点开看得见，否则与屏上的 5 行对不上） */
const showAll = ref(false)

function tapEntry(m: BodyMetric): void {
  entry.value = m
  entryOpen.value = true
}

async function onEntrySelect(value: string): Promise<void> {
  if (value === 'delete' && entry.value) {
    await n.deleteMetric(entry.value.id)
    toast('已删除该条记录')
  }
}
</script>

<template>
  <section class="card">
    <header class="row between">
      <div>
        <h2>体重 · 身高追踪</h2>
        <p class="t-3">按天记录变化 · 自动同步身体资料</p>
      </div>
      <button class="rec row center" @click="openSheet">记录</button>
    </header>

    <!-- 空态 -->
    <EmptyState
      v-if="!n.metrics.length"
      :icon="Scale"
      title="还没有记录"
      hint="点右上角「记录」，开始追踪体重与身高"
    />

    <template v-else>
      <!-- 当前状态 -->
      <ul class="stats">
        <li>
          <em>最新体重</em>
          <b class="num">{{ latestWeight?.toFixed(1) ?? '--' }}<i>kg</i></b>
          <span
            v-if="deltaFrom(0, 'weightKg') !== null"
            class="delta num"
            :class="(deltaFrom(0, 'weightKg') ?? 0) < 0 ? 'down' : 'up'"
          >
            <TrendingDown v-if="(deltaFrom(0, 'weightKg') ?? 0) < 0" :size="12" />
            <TrendingUp v-else :size="12" />
            {{ Math.abs(deltaFrom(0, 'weightKg')!).toFixed(1) }}<i class="dunit">kg</i>
          </span>
        </li>
        <li>
          <em>最新身高</em>
          <b class="num">{{ latestHeight ?? '--' }}<i>cm</i></b>
        </li>
        <li>
          <em>BMI</em>
          <b class="num">{{ bmi ? bmi.value : '--' }}</b>
          <span v-if="bmi" class="bmi-tag" :class="bmi.cls">{{ bmi.label }}</span>
        </li>
      </ul>

      <!-- 体重趋势 -->
      <figure v-if="trendGeom" class="trend">
        <figcaption class="num t-3">
          <span>近 {{ trend.length }} 次体重</span>
          <span>最低 {{ trendGeom.min.toFixed(1) }} · 最高 {{ trendGeom.max.toFixed(1) }} kg</span>
        </figcaption>
        <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="bt-weight-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path :d="trendGeom.area" fill="url(#bt-weight-fill)" />
          <polyline
            :points="trendGeom.points"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <circle :cx="trendGeom.last.x" :cy="trendGeom.last.y" r="3.2" fill="var(--accent)" />
        </svg>
        <span class="axis num t-3"><i>{{ fmtShort(trendGeom.from) }}</i><i>{{ fmtShort(trendGeom.to) }}</i></span>
      </figure>

      <!-- 历史：默认最近 5 条；「共 N 条」配「查看全部」，数得出才看得见 -->
      <ul class="hist">
        <li
          v-for="(m, i) in n.metrics.slice(0, showAll ? n.metrics.length : 5)"
          :key="m.id"
          role="button"
          tabindex="0"
          :aria-label="`编辑 ${fmtShort(m.date)} 的身体记录`"
          @click="tapEntry(m)"
          @keydown.enter.prevent="tapEntry(m)"
          @keydown.space.prevent="tapEntry(m)"
        >
          <span class="date num">
            {{ fmtShort(m.date) }}
            <i v-if="m.date === todayStr()">今天</i>
          </span>
          <span class="val num">{{ m.weightKg != null ? `${m.weightKg.toFixed(1)} kg` : '--' }}</span>
          <span class="val num t-3">{{ m.heightCm != null ? `${m.heightCm} cm` : '--' }}</span>
          <span
            v-if="deltaFrom(i, 'weightKg') !== null"
            class="delta num"
            :class="(deltaFrom(i, 'weightKg') ?? 0) < 0 ? 'down' : 'up'"
          >
            {{ (deltaFrom(i, 'weightKg') ?? 0) > 0 ? '+' : '' }}{{ deltaFrom(i, 'weightKg')!.toFixed(1) }}<i class="dunit">kg</i>
          </span>
          <span v-else class="delta none"></span>
        </li>
      </ul>
      <p v-if="n.metrics.length > 5" class="more t-3">
        <button v-if="!showAll" class="morebtn" type="button" @click="showAll = true">
          查看全部 {{ n.metrics.length }} 条记录
        </button>
        <button v-else class="morebtn" type="button" @click="showAll = false">仅显示最近 5 条</button>
      </p>
    </template>

    <!-- 记录弹层 -->
    <SheetModal :open="sheetOpen" title="记录体重 · 身高" @close="sheetOpen = false">
      <div class="fsheet">
        <label class="fdate">
          <span>日期</span>
          <input v-model="formDate" type="date" class="num" :max="todayStr()">
        </label>
        <NumberStepper
          :model-value="formWeight"
          label="体重"
          unit="kg"
          :step="0.1"
          :min="30"
          :max="200"
          @update:model-value="formWeight = r1($event)"
        />
        <NumberStepper
          :model-value="formHeight"
          label="身高"
          unit="cm"
          :step="0.5"
          :min="100"
          :max="250"
          @update:model-value="formHeight = r1($event)"
        />
        <button class="save" :disabled="saving" @click="submit">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <p class="fnote t-3">同一天再次记录会覆盖当天数值。</p>
      </div>
    </SheetModal>

    <!-- 单条记录操作 -->
    <ActionSheet
      :open="entryOpen"
      :title="entry ? `删除后 ${entry.date} 的身体记录不再计入趋势，无法恢复` : undefined"
      :actions="[{ label: '删除这条记录', value: 'delete', danger: true }]"
      @select="onEntrySelect"
      @close="entryOpen = false"
    />
  </section>
</template>

<style scoped>
h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

header > div > p {
  font-size: var(--fs-caption);
  /* 标题与副标题：主次文本上下 2 */
  margin-top: var(--gap-text);
}

/* soft 底上的文字一律走对应 --*-strong：实底档（--accent / --ok / --warn / --danger）
   直接当字用只有 1.95~3.74:1（tokens.css:163-168），分档结论词会糊 */
.rec {
  /* 状态胶囊：与全站胶囊同一档（纵向 6 + 14 字 ≈ 32，左右 12） */
  padding: var(--sp-6) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  flex: none;
}

/* 当前状态 */
.stats {
  margin-top: var(--gap-md);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  /* 三格等分，格间 8：它们是同一组读数，不该读成三张卡 */
  gap: var(--gap-sm);
}

.stats li {
  padding: var(--sp-10) var(--pad-inline);
  /* 它是卡片**内**的二级分组面：比母卡 16 收一档（12），才读得出「里面这一层」 */
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}

.stats em {
  display: block;
  font-style: normal;
  /* 「体重」是字段小帽，与相邻的单位后缀不同 —— 要读，所以不落 --text-3 */
  font-size: var(--fs-caption);
  color: var(--text-2);
  white-space: nowrap;
}

.stats b {
  display: block;
  /* 标签与数值：主次文本上下 2 */
  margin-top: var(--gap-text);
  font-size: var(--fs-title2);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.stats b i {
  font-style: normal;
  font-weight: var(--fw-regular);
  /* 大数后的单位后缀（kg / cm），装饰性微字 */
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: var(--gap-text);
}

.delta {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-text);
  margin-top: var(--gap-text);
  /* 「↓0.4」这类变化是体重趋势的结论，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 涨跌不再借宏量营养素域色（--c-protein / --c-carb 是给蛋白质/碳水准备的）：
   降 = ok-strong、升 = warn-strong —— 与 BMI 分档同一套语义档，深浅也配 soft 底 */
.delta.down {
  color: var(--ok-strong);
}

.delta.up {
  color: var(--warn-strong);
}

.dunit {
  font-style: normal;
  font-weight: var(--fw-regular);
  /* 变化量的小帽单位（kg），装饰性微字 */
  font-size: var(--fs-micro);
  margin-left: var(--gap-text);
}

.bmi-tag {
  display: inline-block;
  margin-top: var(--gap-text);
  /* 迷你状态角标：纵向 2 保住单行高度，左右 8 让两字不贴边 */
  padding: var(--gap-text) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  /* BMI 分档是健康结论词，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.bmi-tag.ok {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.bmi-tag.warn {
  background: var(--warn-soft);
  color: var(--warn-strong);
}

.bmi-tag.bad {
  background: var(--danger-soft);
  color: var(--danger-strong);
}

/* 趋势图 */
.trend {
  margin: var(--gap-md) 0 0;
}

.trend figcaption {
  display: flex;
  justify-content: space-between;
  gap: var(--gap-sm);
  /* 「近 10 次体重 · 最低/最高」是趋势摘要，是要读的数 */
  font-size: var(--fs-caption);
}

.trend svg {
  display: block;
  width: 100%;
  height: 84px;
  margin-top: var(--sp-6);
}

.axis {
  display: flex;
  justify-content: space-between;
  /* 趋势图左右两个日期刻度 */
  font-size: var(--fs-caption);
}

.axis i {
  font-style: normal;
}

/* 历史 */
.hist {
  margin-top: var(--gap-md);
}

.hist > * + * {
  border-top: 0.5px solid var(--line);
}

.hist li {
  display: grid;
  grid-template-columns: 1fr auto auto 56px;
  align-items: center;
  /* 四列（日期 / 体重 / 变化 / 操作）之间 12：列间要读得清归属 */
  gap: var(--gap-md);
  /* 单行行：12 上下 + 20 文本 ≈ 44~48 档 */
  padding: var(--sp-12) 0;
  cursor: pointer;
}

.hist .date {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.hist .date i {
  font-style: normal;
  /* 日期与状态胶囊之间 8（文字与胶囊的左右间距） */
  margin-left: var(--gap-sm);
  padding: var(--sp-2) var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  /* 段首的状态词（「已记录」），必须读得出 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.hist .val {
  font-size: var(--fs-subhead);
  min-width: 62px;
  text-align: right;
}

.hist li .delta {
  justify-self: end;
  font-size: var(--fs-footnote);
}

.more {
  margin-top: var(--gap-md);
  padding-top: var(--gap-sm);
  border-top: 0.5px solid var(--line);
  text-align: center;
  font-size: var(--fs-footnote);
}

/* 「查看全部 / 仅显示最近 5 条」：计数要点开看得见，配一枚文字按钮 */
.morebtn {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
  padding: var(--gap-tight) var(--gap-sm);
}

/* 记录弹层表单 */
.fsheet {
  padding-bottom: var(--sp-6);
}

.fdate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 表单行：8 上下 + 输入框 40 ≈ 56，比列表行略松（有输入焦点要容纳） */
  padding: var(--sp-8) 0;
}

.fdate span {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.fdate input {
  /* 输入框规范：高 40（10 上下 + 14 字），左右 16，圆角与按钮同档 20 */
  padding: var(--sp-10) var(--pad-row);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.save {
  width: 100%;
  margin-top: var(--gap-lg);
  /* 主按钮高度 40：12 上下 + 16 字（13 落在 12/14 两档之间，取小避开虚高） */
  padding: var(--sp-12) 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}

.save:disabled {
  opacity: var(--disabled-opacity);
}

.fnote {
  margin-top: var(--gap-sm);
  text-align: center;
  font-size: var(--fs-caption);
}
</style>
