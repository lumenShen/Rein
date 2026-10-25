<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RotateCcw, Trophy } from 'lucide-vue-next'

import RingProgress from '@/components/common/RingProgress.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useSessionStore } from '@/stores/session'
import { sessionService } from '@/services/sessionService'
import { useToast } from '@/composables/useToast'
import { fmtDateCn, todayStr } from '@/utils/date'
import { fmtKg } from '@/utils/strength'
import {
  buildCompletion,
  buildExerciseRows,
  buildPrRows,
  buildRhythm,
  levelLabel,
  mergeHistoryPr,
  tallyMuscles,
  type ExerciseRow,
  type PrRow,
} from '@/utils/sessionSummary'
import { FEELING_INPUT_LABEL, type FeelingInput } from '@/types'
import type { ActivationMap } from '@/config/muscles'
import type { StrengthSetRecord } from '@/types'

/**
 * 沉浸模式 · 训练总结（summary 阶段的内容区）——「成绩单」版式。
 *
 * 回答三个问题，按阅读次序铺开：
 *   1. **做得全不全**（组格条 + 完成环）：条上每格一组、按状态着色，
 *      「分母去哪了」一眼可读；环给完成率的仪式感读数。
 *      口径与 store 严格一致：只有真正登记的正式组计分子，跳过仍占分母，
 *      激活热身组两边都不进（条上也不画）。
 *   2. **练得怎么样**（容量大数字 + 三格 + 进步 + 逐动作明细）：
 *      总容量是力量训练的灵魂数字，升为全宽 display 档；最高组、PR 增量
 *      各升一档。PR 两级可信度（即时 / 历史校正）必须在视觉与文字上分得开。
 *   3. **下次怎么走**（肌群 + 下次建议）+ 唯一的输入项（体感三档）。
 *
 * ⚠️ 卡片材质**必须在组件内自给自足**：从前这里的 `.blockcard` 引用的是
 * 宿主 SessionOverlay 的 scoped 类 —— scoped 选择器跨组件不生效，
 * 明细 / 肌群 / 建议三块实际从没渲染出卡片（无底无内距无圆角），本次一并修复。
 *
 * 排版约束：932 高的视口装不下全部内容，页面可滚动（宿主 .scrollbody 已有滚动
 * 与渐隐）。首屏要装下「条 + 环 + 指标 + 进步」—— 这是"这次怎么样"的答案，
 * 其余是"细节与下一步"，滚下去看。
 */
const s = useSessionStore()

/** 体感三档：由好到差固定次序（读起来是「比预期好」往下），等权不预设高亮 */
const FEEL_OPTIONS = (['better', 'as_expected', 'worse'] as const).map((value) => ({
  value,
  label: FEELING_INPUT_LABEL[value],
}))

/** 再点一次同一档 = 取消（回到「未回答」），否则用户没有退路只能选错一个 */
function toggleFeeling(v: FeelingInput): void {
  s.setPostFeeling(s.postFeeling === v ? null : v)
}
const lib = useExerciseLibStore()
const { toast } = useToast()

/**
 * 撤销最后一组、回到做组态。
 *
 * 为什么总结页需要它：进 summary 之后 `addExtraSet` 被封、全课抽屉的「跳至该组」也回不去
 * （目标组必然落在游标之前），于是发现「少做了一组 / 最后一组记错了」时只剩两条路 ——
 * 保存一份已知是错的记录，或放弃整节课（把已做的一起丢掉）。而 store 的 `redoLastSet`
 * 本来就能从任何相位回退（它没有 phase 门槛），缺的只是这个入口。
 * 回退成功即 phase 离开 summary，本组件随之卸载、沉浸页回到做组界面。
 * 它是**纠错路径不是成绩内容**：降为文字链（44 热区不变），不再与成绩抢视觉权重。
 */
function undoLastSet(): void {
  if (!s.redoLastSet()) {
    toast('没有可撤销的组')
    return
  }
  toast('已撤销最后一组，继续训练')
}

/* ---------- 完成层 ---------- */

const completion = computed(() => {
  // 加练组数 = 实际组位 − 课程编排组数（store 的 effSets 已含 extraSets）
  let extra = 0
  for (const e of s.plan?.exercises ?? []) extra += s.effSets(e) - e.sets
  return buildCompletion(s.courseSlots, Math.max(0, extra))
})

/**
 * 组格条：每格一组的全课结构（不含热身组 —— 热身不进分母，条上也不画）。
 * done = 绿；skipped = 灰；current/pending = 描边（summary 正常流里不该出现，
 * 但快照恢复等路径的防御分支保持可读，不空白）。
 */
const band = computed(() =>
  s.courseSlots
    .filter((slot) => !slot.warmup)
    .map((slot) => (slot.state === 'done' ? 'done' : slot.state === 'skipped' ? 'skipped' : 'rest')),
)

const bandLabel = computed(
  () => `全课 ${completion.value.total} 组：完成 ${completion.value.done} 组，跳过 ${completion.value.skipped} 组`,
)

/* ---------- 成绩层 ---------- */

/**
 * 逐动作编排数据：组间休息 + 库内展示名 + 肌群激活表 + 动作库 id。
 * 这几样在 store 的组格里都没有（组格只带课程条目 id），要在 plan 上取。
 * 展示名与肌群都走 lib —— 动作库改名 / 补表后总结页与沉浸页读同一份。
 * `exerciseId` 是历史聚合键，种子课程整列为空，引擎会回落到展示名。
 */
const exMeta = computed<Record<string, { restSec: number; name: string; muscles: ActivationMap | null; exerciseId: string | null }>>(() => {
  const out: Record<string, { restSec: number; name: string; muscles: ActivationMap | null; exerciseId: string | null }> = {}
  for (const e of s.plan?.exercises ?? []) {
    out[e.id] = {
      restSec: e.restSec,
      name: lib.resolveName(e),
      muscles: lib.musclesOf(e),
      exerciseId: e.exerciseId || null,
    }
  }
  return out
})

/** 下次建议：取该动作的建议重量（引擎没有则 null，UI 不渲染那一段） */
function adviceOf(exId: string): { suggestedWeight: number | null; suggestedReps: number | null } | null {
  const ex = s.plan?.exercises.find((e) => e.id === exId)
  if (!ex) return null
  const a = s.adviceFor(ex)
  return { suggestedWeight: a?.suggestedWeight ?? null, suggestedReps: a?.suggestedReps ?? null }
}

const rows = computed<ExerciseRow[]>(() =>
  buildExerciseRows(s.courseSlots, s.lastWeights, exMeta.value, adviceOf),
)

/* ---------- 节奏层 ---------- */

/** 墙钟秒数由 store 推导（跨重启仍准，且不做分钟级取整） */
const rhythm = computed(() => buildRhythm(rows.value, s.durationSec, completion.value.done))

/* ---------- 进步层 ---------- */

/** 即时判定：与上次比，零请求，进总结页即有内容 */
const instantPr = computed<PrRow[]>(() => buildPrRows(rows.value))

/**
 * 历史校正：进总结阶段时对本次的力量动作各拉一次全量历史。
 * 为什么是逐动作而不是一次全量：没有「按 workoutId 批量取历史」的现成 IPC，
 * 而一节课的力量动作通常 3–6 个，逐个并发可接受；且拉回来的是该动作的**全部**
 * 历史（`strength_history` 不带日期参数），正好是 PR 判定需要的全集。
 * 失败静默 —— 校正只是锦上添花，绝不能因为一次请求失败就让总结页空掉。
 *
 * 键用 `historyKey`（库 id 优先、回落展示名）而不是课程条目 id：
 * 后者在种子数据里与历史里的任何一列都对不上，查出来永远是空数组。
 */
const history = ref<Map<string, StrengthSetRecord[]>>(new Map())
const prLoading = ref(false)

watch(
  () => s.phase,
  async (p) => {
    if (p !== 'summary' || history.value.size > 0 || prLoading.value) return
    const keys = rows.value
      .filter((r) => r.kind === 'strength' && r.doneCount > 0)
      .map((r) => r.historyKey)
    if (!keys.length) return
    prLoading.value = true
    try {
      const lists = await Promise.all(
        keys.map((k) => sessionService.strengthHistory(k).catch(() => [] as StrengthSetRecord[])),
      )
      const m = new Map<string, StrengthSetRecord[]>()
      keys.forEach((k, i) => {
        const list = lists[i] ?? []
        if (list.length) m.set(k, list)
      })
      history.value = m
    } finally {
      prLoading.value = false
    }
  },
  { immediate: true },
)

/**
 * 展示用 PR 列表：历史回来的动作用校正判定，其余保留即时判定。
 * 两个列表按 (exId, kind) 合并 —— 同一个动作可能重量是历史 PR 而 e1RM 不是
 * （重而不沉的情况），所以是逐条覆盖而不是整行动画切换。
 */
const prRows = computed<PrRow[]>(() => {
  if (!history.value.size) return instantPr.value
  const verified = mergeHistoryPr(rows.value, history.value)
  const byKey = new Map<string, PrRow>()
  for (const p of instantPr.value) byKey.set(`${p.exId}:${p.kind}`, p)
  for (const p of verified) byKey.set(`${p.exId}:${p.kind}`, p)
  return [...byKey.values()].sort((a, b) => (b.delta === a.delta ? (a.kind === 'weight' ? -1 : 1) : b.delta - a.delta))
})

/** 真历史 PR 与即时对比的分界，用于视觉区分 */
const isVerified = (p: PrRow): boolean => p.confidence === 'verified'

/* ---------- 指标 ---------- */

/** kg 容量（Σ 重量×次数）—— 只含真有重量的组 */
const kgVolume = computed(() => rows.value.reduce((sum, r) => sum + r.volumeKg, 0))

/**
 * 自重动作的总次数。它**不并进 kg 容量**（跨课不可比），但也**不能不报** ——
 * 整节课只有引体/俯卧撑时，总容量会显示「—」，等于说这一节白练了。
 */
const bwReps = computed(() =>
  rows.value.reduce((sum, r) => sum + (r.topWeightKg == null ? r.totalReps : 0), 0),
)

/** 主数字：只有自重时把「次」扶正（量纲跟着换），否则是 kg 容量 */
const heroStat = computed(() => {
  const repsMain = kgVolume.value <= 0 && bwReps.value > 0
  return {
    label: repsMain ? '总次数' : '总容量',
    value: repsMain ? String(bwReps.value) : kgVolume.value > 0 ? fmtKg(kgVolume.value) : '—',
    unit: repsMain ? '次' : kgVolume.value > 0 ? 'kg' : '',
  }
})

const sideStats = computed(() => [
  { key: 'time', label: '用时', value: String(s.durationMin), unit: '分' },
  { key: 'kcal', label: '消耗', value: String(s.estimateKcalValue), unit: 'kcal' },
  {
    key: 'rate',
    label: '每组耗时',
    value: rhythm.value.secPerSet != null ? String(rhythm.value.secPerSet) : '—',
    unit: rhythm.value.secPerSet != null ? '秒' : '',
  },
])

/* ---------- 逐动作行 ---------- */

interface DetailRow {
  r: ExerciseRow
  /** 主指标：力量 = 容量；计时/有氧 = 累计时长 */
  main: string
  /** 最高组数值（只有真有重量组的力量动作才有）；null = 这一行没有最高组 */
  top: string | null
  /** 没有最高组时的说明性占位 —— 孤零零一个「—」读不出是「本来就没有」还是「没读到」 */
  topNote: string
  /** 该动作本次刷新了 PR（任一项） */
  hasPr: boolean
  prLabel: string
}

const detailRows = computed<DetailRow[]>(() =>
  rows.value.map((r) => {
    // 一个动作可能整段没做（跳过 / 未轮到）。这时右侧不给数 ——
    // 「3 组 · 未做」配一个「0 秒」是自相矛盾的两句话，
    // 而 0 秒在这里既不是成绩也不是缺口，只会让那一行读起来像坏了。
    const notDone = r.doneCount === 0
    // 自重动作：kg 容量恒为 0，主指标换成「次」—— 「4 组 · 0 kg」既不是成绩也不是缺口，
    // 它把用户真做过的事显示成没发生。次数才是自重的原生量纲。
    const bw = r.kind === 'strength' && r.topWeightKg == null && r.totalReps > 0
    const main = notDone
      ? `${r.plannedCount} 组 · 未做`
      : r.kind === 'strength'
        ? bw
          ? `${r.doneCount} 组 · ${r.totalReps} 次`
          : `${r.doneCount} 组 · ${fmtKg(r.volumeKg)} kg`
        : `${r.doneCount} 组 · ${fmtSecs(r.totalSec)}`
    const hasTop = !notDone && r.kind === 'strength' && (r.topWeightKg != null || bw)
    const prs = prRows.value.filter((p) => p.exId === r.exId)
    return {
      r,
      main,
      top: !hasTop
        ? null
        : bw
          ? `最多 ${r.topSetReps ?? 0} 次`
          : `${fmtKg(r.topWeightKg!)} kg × ${r.topReps ?? 0}`,
      topNote: notDone ? '未做' : r.kind !== 'strength' ? '非力量动作' : bw ? '自重动作' : '无重量记录',
      hasPr: prs.length > 0,
      prLabel: prs.map((p) => (p.kind === 'weight' ? '重量' : p.kind === 'reps' ? '次数' : '1RM')).join(' · '),
    }
  }),
)

/** 秒 → 「3 分 20 秒」/「45 秒」 */
function fmtSecs(sec: number): string {
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const s2 = sec % 60
  return s2 ? `${m} 分 ${s2} 秒` : `${m} 分`
}

/* ---------- 肌群 ---------- */

/** 已折叠到 10 个评估组（口径见 utils/sessionSummary::tallyMuscles） */
const muscles = computed(() => tallyMuscles(rows.value))

/* ---------- 副标题与下次建议 ---------- */

/**
 * 下次建议：只说**下一个动作的下一个数**，不给整段说教。
 * 取本次容量最大的那个力量动作的建议重量（用户最在意"下次推多重"）；
 * 没有建议值（如首次记录、引擎未给）就整段不渲染 —— 一句空话不如没有。
 */
const nextHint = computed(() => {
  const best = [...rows.value]
    .filter((r) => r.kind === 'strength' && r.suggestedWeight != null && r.suggestedWeight > 0)
    .sort((a, b) => b.volumeKg - a.volumeKg)[0]
  if (!best) return ''
  const per = best.suggestedReps != null ? ` × ${best.suggestedReps} 次` : ''
  return `下次「${best.name}」可上 ${fmtKg(best.suggestedWeight!)} kg${per}。`
})

/* ---------- 展示辅助 ---------- */

const prTitle = computed(() => {
  const n = prRows.value.length
  if (n === 0) return ''
  const verified = prRows.value.filter(isVerified).length
  if (prLoading.value) return '本次进步 · 正在核对历史纪录'
  return verified > 0 ? `本次进步 · ${n} 项刷新历史纪录` : `本次进步 · ${n} 项超越上次`
})

/**
 * 增量文本：校正级带「历史」二字，与即时档在**文字**上也分开。
 * 只靠颜色或粗细区分不够 —— 色觉障碍与暗色档下这两种通道都会失效，
 * 而「这个数是跟上次比还是跟历史纪录比」是用户判断该不该信它的唯一依据。
 */
function prDeltaText(p: PrRow): string {
  return isVerified(p) ? `+${fmtKg(p.delta)} kg · 历史` : `+${fmtKg(p.delta)} kg`
}
</script>

<template>
  <div class="sumpane col">
    <!-- 组格条：每格一组（热身不画 —— 它不进分母）。跳过的组灰格留在原位，
         「分母去哪了」不用读文字就看得见。 -->
    <div v-if="completion.total > 0" class="band" role="img" :aria-label="bandLabel">
      <i v-for="(st, i) in band" :key="i" class="seg" :class="st" aria-hidden="true" />
    </div>
    <!-- 条下的状态行：完成状态（ok/warn 胶囊）+ 跳过 / 加练 / 热身三个解释标签。
         这行只说「.qualifier」，完成率与 n/N 由环说，不在同一屏说两遍。 -->
    <div class="bandcap">
      <StatusChip :tone="completion.earlyEnd ? 'warn' : 'ok'" size="sm">
        {{ completion.earlyEnd ? '提前结束' : '全程完成' }}
      </StatusChip>
      <span v-if="completion.skipped > 0" class="sumtag">跳过 {{ completion.skipped }} 组</span>
      <span v-if="completion.extra > 0" class="sumtag">加练 {{ completion.extra }} 组</span>
      <span v-if="completion.warmups > 0" class="sumtag">热身 {{ completion.warmups }} 组</span>
    </div>

    <!-- 完成环：分子只算真正登记的正式组；环内 83% + n/N 组是完成率的唯一读数 -->
    <div class="hero col center">
      <RingProgress
        v-if="completion.ratio !== null"
        :value="completion.ratio"
        color-var="--c-exercise"
        :size="100"
        :stroke="10"
      >
        <b class="num heropct">{{ Math.round(completion.ratio * 100) }}%</b>
        <span class="herosub num">{{ completion.done }}/{{ completion.total }} 组</span>
      </RingProgress>
      <div v-else class="herofallback num">—</div>
      <h1 class="sumtitle">{{ s.plan?.name }}完成</h1>
      <!-- 副标题行：日期降为次要说明，训练类型交给中性胶囊 -->
      <p class="sumsub">
        <span class="sumdate">{{ fmtDateCn(todayStr()) }}</span>
        <StatusChip v-if="s.plan?.workoutType" tone="neutral" size="sm">{{ s.plan.workoutType }}</StatusChip>
      </p>
      <!-- 回头路：总结页是终态，但「少做一组 / 最后一组记错」时旧界面只剩保存错的那份
           或放弃整节课。降为文字链 —— 它是纠错路径，不该和成绩抢视觉权重；
           热区仍是 44（--hit-min），点得中。 -->
      <button v-if="completion.done > 0" type="button" class="undo" @click="undoLastSet">
        <RotateCcw :size="14" /> 撤销最后一组，继续训练
      </button>
    </div>

    <!-- 指标：主数字（总容量 / 总次数）独占全宽 display 档 —— 力量训练的灵魂数字
         不该和「消耗 6 kcal」同档平铺；用时 / 消耗 / 每组耗时三格一行。 -->
    <div class="statgrid">
      <div class="stat stat-hero">
        <span class="stlabel">{{ heroStat.label }}</span>
        <b class="stval num">{{ heroStat.value }}<i v-if="heroStat.unit" class="stunit">{{ heroStat.unit }}</i></b>
        <!-- 配重与自重混在同一节：kg 容量只统计真配重，自重的次数单独报一行（合并会得出
             「重量 + 次数」这种不存在的量纲） -->
        <p v-if="kgVolume > 0 && bwReps > 0" class="stnote">
          另有自重 <span class="num">{{ bwReps }}</span> 次（不计入 kg 容量）
        </p>
      </div>
      <div v-for="st in sideStats" :key="st.key" class="stat">
        <span class="stlabel">{{ st.label }}</span>
        <b class="stval num">{{ st.value }}<i v-if="st.unit" class="stunit">{{ st.unit }}</i></b>
      </div>
    </div>

    <!-- 进步：即时判定先出，历史回来后 mergeHistoryPr 覆盖为真纪录。
         情绪高点：标题带奖杯标记，增量升为 callout 档。 -->
    <section v-if="prTitle" class="sumcard prcard">
      <h3 class="prtitle">
        <Trophy :size="15" />
        {{ prTitle }}
      </h3>
      <div v-for="p in prRows" :key="`${p.exId}-${p.kind}`" class="prrow">
        <span class="prname">{{ p.name }}</span>
        <span class="prval num">
          {{
            p.kind === 'weight'
              ? `${fmtKg(p.value)} kg`
              : p.kind === 'reps'
                ? `单组最多 ${p.value} 次`
                : `1RM ${fmtKg(p.value)} kg`
          }}
        </span>
        <span class="prdelta num" :class="{ verified: isVerified(p) }">{{ prDeltaText(p) }}</span>
      </div>
    </section>

    <!-- 逐动作明细：两行式（行首 名字+PR 徽标 与 最高组结论；行尾 组数·容量）。
         最高组是力量训练真正的信息量（不是最后一组），主数值档。 -->
    <section v-if="detailRows.length" class="sumcard">
      <h3>逐动作明细</h3>
      <div v-for="d in detailRows" :key="d.r.exId" class="exrow">
        <div class="exhead">
          <span class="exname">{{ d.r.name }}</span>
          <span v-if="d.hasPr" class="expr">{{ d.prLabel }}</span>
          <!-- 最高组是这一行的结论：主数值档（title3 + --text-1）。
               占位说明（非力量 / 未做 / 无重量记录）刻意留在小字档 ——
               它不是成绩，写成大字会与真正的最重组抢层级 -->
          <b v-if="d.top" class="extop num">{{ d.top }}</b>
          <span v-else class="extop-none">{{ d.topNote }}</span>
        </div>
        <p class="exmain num">{{ d.main }}</p>
      </div>
    </section>

    <!-- 肌群：已折叠到评估组（胸/背/肩…），档位取组内最大值 -->
    <section v-if="muscles.length" class="sumcard">
      <h3>本次练到的肌群</h3>
      <div class="musrow">
        <span v-for="m in muscles" :key="m.group" class="muschip" :class="`lv${m.level}`">
          {{ m.label }} · {{ levelLabel(m.level) }}
        </span>
      </div>
    </section>

    <!-- 收口：下次建议（只给一个具体的数）+ 体感三档（这一屏唯一需要动手的一格）。
         两件事同属「下次怎么走」，合进一张卡；三枚**等权**且不预设高亮 ——
         默认选中任何一档都是替他回答；再点一次可以取消（记 null），
         跳过不影响保存：宁可这条没有，也不要编一个值。 -->
    <section class="sumcard tailcard">
      <template v-if="nextHint">
        <h3>下次建议</h3>
        <p class="tailhint">{{ nextHint }}</p>
      </template>
      <div class="feelblock" :class="{ divided: !!nextHint }">
        <span class="feellabel">这次练得怎么样？</span>
        <div class="feelopts">
          <button
            v-for="o in FEEL_OPTIONS"
            :key="o.value"
            type="button"
            class="feelopt"
            :class="{ on: s.postFeeling === o.value }"
            :aria-pressed="s.postFeeling === o.value"
            @click="toggleFeeling(o.value)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ---------- 版式 ----------
   **不复用 SessionOverlay 的 .pane**：scoped 选择器跨组件不生效，
   挂了也是死类名（那一层还要 centre 居中，与这一屏的可滚动版式冲突）。
   卡片材质（.sumcard）在**本组件内定义** —— 从前引用宿主的 .blockcard
   是死类，三张卡从没渲染出材质（教训写在本文件头注释）。

   高度写法踩过两次，都表现为「内容看着都在，末段被 Dock 压住且划不动」：
     · `flex: 1` —— 在 `display:flex; flex-direction:column` 的包裹层里，
       浏览器把子项压进"父级高度"这一档，.scrollbody 的 scrollHeight 恒等于
       clientHeight，**滚不动**；
     · `min-height: 100%` —— 100% 解析到的是**父级**高度（不是内容高度），
       内容超出时它不跟着涨，等于什么都没改。
   `flex: 1 0 auto` 才是这里要的两件事同时成立：basis auto 按内容取高，
   grow 1 让不足一屏时铺满，shrink 0 保证超出时不被压缩 ——
   于是 scrollHeight 真的大于 clientHeight，滚动有得滚。 */
.sumpane {
  flex: 1 0 auto;
  /* 卡与卡之间 12（规范卡片间距）；左右收成 16（--pad-sheet 那一档）——
     原来 26 既不在 4/8 体系里，也让总结页的正文比沉浸层其它屏窄一圈。 */
  gap: var(--gap-md);
  padding: var(--sp-24) var(--pad-sheet);
  /* 与 SessionOverlay 的 .pane 共用**同一组 keyframes**，时长就必须同档：一处 420ms、
     一处 250ms，会让同一个「内容块入场」在相邻两屏里给出两种手感。取 --dur-base 而不是
     --dur-sheet：这是沉浸层内的内容入场，不是抽屉面板的运动（令牌语义对不上），
     而 _GUIDE 的口径把 >300ms 的 UI 动效记作 P0。 */
  animation: fadeUp var(--dur-base) var(--ease-standard);
}

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}

/* ---------- 卡片材质（本地自给，不再依赖宿主 scoped 类） ---------- */

.sumcard {
  width: 100%;
  border-radius: var(--radius-m);
  padding: var(--pad-card);
  display: flex;
  flex-direction: column;
  /* 标题与内容之间 8（卡内标题与内容 8） */
  gap: var(--gap-sm);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.sumcard h3 {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  letter-spacing: 0.4px;
}

/* ---------- 组格条 ---------- */

.band {
  display: flex;
  gap: 2px;
  min-width: 0;
  /* 30+ 组的课每格会很窄：圆角 4 在 2px 格上仍是圆的，窄格也不毛糙 */
}

.seg {
  flex: 1 1 0;
  min-width: 0;
  height: 6px;
  border-radius: var(--radius-xs);
}

/* 做完 = 语义绿。运动橙是「这是运动」，不是「做完了」；
   两者绑在一起后，完成格会与「运动身份」同色，和跳过的灰格反而更像一对。 */
.seg.done {
  background: var(--heat-enough);
}

/* 跳过：中性灰且半透明 —— 它「仍在分母里但没做」，不该和背景融为一体，
   也不该抢过绿格。用 text-3 调透明度而不是 surface 系：这一屏的底是玻璃，
   surface 系白格在浅灰底上几乎读不出来（暗色同理）。 */
.seg.skipped {
  background: color-mix(in srgb, var(--text-3) 45%, transparent);
}

/* current / pending（正常流不会出现，快照恢复等路径的防御态）：描边空格 */
.seg.rest {
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--line-strong);
}

.bandcap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-6);
  margin-top: var(--sp-2);
}

.sumtag {
  font-size: var(--fs-micro);
  /* --text-1 而不是 --text-2：--surface-2 是**分段控件底**，
     --text-2 压它实测只有 2.93:1（亮）/ 1.19:1（暗）。
     这三个标签是「分母去哪了」的文字解释，不能读不清。 */
  color: var(--text-1);
  background: var(--surface-2);
  border-radius: var(--radius-full);
  padding: var(--sp-4) var(--sp-8);
}

/* ---------- 完成环 ---------- */

.hero {
  gap: var(--gap-sm);
  padding: var(--sp-4) 0 0;
}

.heropct {
  /* 沉浸层单屏读数档（与 SessionOverlay 的休息倒数 / 计时同一条刻度） */
  font-size: var(--fs-readout-sm);
  font-weight: var(--fw-bold);
  line-height: 1;
  letter-spacing: -0.5px;
}

.heropct + .herosub,
.herofallback {
  /* 环内两行读数：主读数与副读数上下只留 2（--gap-text） */
  margin-top: var(--gap-text);
}

.herosub {
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

/* ratio 为 null（无任何组位）时的占位：保持与环同高，避免整块塌下去 */
.herofallback {
  width: 100px;
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 40px = --fs-display-m；与完成环里的百分比读数同一档，占位与真值不会一大一小 */
  font-size: var(--fs-display-m);
  color: var(--text-3);
}

.sumtitle {
  font-size: var(--fs-title1);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  text-align: center;
  margin-top: var(--sp-6);
}

.sumsub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-6);
}

/* 日期只是上下文：降为 caption / --text-3 的次要说明，训练类型交给胶囊 */
.sumdate {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 「撤销最后一组」：文字链形态 —— 无边框无底，44 热区不变；
   按压时给一层中性底作反馈。 */
.undo {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  min-height: var(--hit-min);
  margin-top: var(--sp-2);
  padding: 0 var(--sp-14);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.undo:active {
  background: var(--surface-2);
}

/* ---------- 指标 ---------- */

.statgrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap-sm);
}

/* 主数字卡：全宽独占，白卡材质（不是灰砖）—— 它是这一屏的成绩主角 */
.stat-hero {
  grid-column: 1 / -1;
  background: var(--surface);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--sp-12) var(--pad-card);
}

.stlabel {
  display: block;
  font-size: var(--fs-footnote);
  /* 数值的标签名（容量 / 用时 / 消耗 / 每组耗时）是**要读的**：读不出标签，
     下面那个数就只是一个没有名字的数字。tokens.css 的契约写得很直白——
     「凡是必须读出来的信息都不该放在 --text-3」。 */
  color: var(--text-2);
  /* 四个字标签在窄格里不折行 */
  white-space: nowrap;
}

.stval {
  display: block;
  font-size: var(--fs-title3);
  font-weight: var(--fw-semibold);
  margin-top: var(--sp-2);
  letter-spacing: -0.3px;
}

/* 主数字升到 display 档：8360 kg 与「消耗 6」不是同一层级的数 */
.stat-hero .stval {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  margin-top: var(--sp-4);
}

/* 自重单独报的那一行：不占指标格（否则会被读成与「总容量」同单位的第五格），
   只在配重与自重混在同一节课时出现；住在主数字卡内，紧贴着它解释 */
.stnote {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stunit {
  font-size: var(--fs-micro);
  font-style: normal;
  font-weight: var(--fw-regular);
  color: var(--text-3);
  margin-left: var(--sp-2);
}

/* 三格副指标：灰砖（surface-2 是分段控件底，砖与主卡的白面拉开材质层级） */
.stat:not(.stat-hero) {
  background: var(--surface-2);
  border-radius: var(--radius-m-nest);
  padding: var(--sp-8) var(--sp-10);
  min-width: 0;
}

/* ---------- 进步 ---------- */

/**
 * 进步卡是「好消息」分区，底只留极淡的一层语义绿（heat-enough 10%），
 * **不承载任何文字** —— 「绿字压绿底」在 sRGB 里无论怎么调都到不了 4.5:1，
 * 所以语义交给标题前那枚奖杯图标，标题与数值用 --text-1 / --text-2。
 * 不用 --c-exercise-soft：那是运动模块的识别橙，不代表「进步」。
 */
.prcard {
  background: color-mix(in srgb, var(--heat-enough) 10%, var(--surface));
}

.prtitle {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  /* 标题用 --text-1：它是这一屏唯一的「好消息」分区标题，
     但绿字压绿底不达标（见上），所以语义靠左侧奖杯而不是文字颜色。 */
  color: var(--text-1);
}

.prrow {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  padding: var(--sp-2) 0;
}

.prname {
  flex: 1.1;
  min-width: 0;
  font-size: var(--fs-subhead);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prval {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 增量是这一行的结论：升为 callout 档（14 semibold）——
   从前它挤在行尾 12px 小字里，最值得炫耀的数读起来最费劲 */
.prdelta {
  flex: none;
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

/* 校正级（真历史 PR）：加重 + 一枚实心绿点，与即时档在视觉与文字上双重分开。
   文字本身也带「历史」二字（见 prDeltaText）—— 不靠颜色单独承担这个信息。 */
.prdelta.verified {
  font-weight: var(--fw-bold);
  padding-left: var(--sp-10);
  position: relative;
}

.prdelta.verified::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 5px;
  height: 5px;
  margin-top: calc(-1 * var(--sp-2));
  border-radius: 50%;
  background: var(--heat-enough);
}

/* ---------- 逐动作明细 ---------- */

/* 两行式：行首「名字 + PR 徽标 + 最高组结论」，行尾「组数 · 容量」。
   从前三段挤一行、88px 固定名列在窄屏截断动作名；两行后名字有整行可用。 */
.exrow {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  padding: var(--sp-10) 0;
}

.exrow + .exrow {
  border-top: 0.5px solid var(--line);
}

.exhead {
  display: flex;
  align-items: baseline;
  gap: var(--gap-text-inline);
  min-width: 0;
}

.exname {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exmain {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 最高组：这一行的结论，主数值档（title3 + --text-1）。
   占位说明（非力量 / 未做 / 无重量记录）刻意留在小字档 ——
   它不是成绩，写成大字会与真正的最重组抢层级 */
.extop {
  flex: none;
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  letter-spacing: -0.3px;
}

.extop-none {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.expr {
  flex: none;
  /* 走 --fs-micro：11px 是字号阶梯的下限（tokens.css R4），写死 10px 会掉到阶梯之外 ——
     而这一枚恰恰是「这一行有 PR」的唯一文字标记，比别的徽标更不该再小一档。 */
  font-size: var(--fs-micro);
  /* 徽标不用彩色字：语义底是浅绿，绿字压绿底在亮色下只有 2.5:1 ——
     一个读不清的「PR」徽标比没有更糟（用户会以为那行没被标记）。
     改成 --text-1 压 --surface-2 灰底：两档都过 4.5:1，
     「这一行有 PR」由左侧的绿点承载（见下方 ::before）。 */
  color: var(--text-1);
  background: var(--surface-2);
  border-radius: var(--radius-full);
  padding: var(--sp-2) var(--sp-6) var(--sp-2) var(--sp-14);
  position: relative;
}

.expr::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 50%;
  width: 5px;
  height: 5px;
  margin-top: calc(-1 * var(--sp-2));
  border-radius: 50%;
  background: var(--heat-enough);
}

/* ---------- 肌群 ---------- */

.musrow {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-6);
}

.muschip {
  font-size: var(--fs-micro);
  border-radius: var(--radius-full);
  padding: var(--sp-4) var(--sp-8);
  /* 三档只用**底色深浅**区分，文字一律 --text-1 —— 同「绿字压绿底」的道理，
     任何把档位编码进文字颜色的做法都会在某一档掉到 4.5:1 以下。
     档位另有文字（「主攻/辅助/稳定」）与左侧色点，读起来不靠猜。 */
  color: var(--text-1);
  padding-left: var(--sp-16);
  position: relative;
}

.muschip::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 50%;
  width: 5px;
  height: 5px;
  margin-top: calc(-1 * var(--sp-2));
  border-radius: 50%;
}

/* 底色三档：主攻（绿实）> 辅助（绿淡）> 稳定（中性）
   与肌群图的语言一致。档间差刻意拉开（26% / 13% / 0）——
   三个 6~8% 的相邻值在真机上读起来是同一档（实测截图里三档几乎同色），
   而这一屏上「哪块是主角」正是用户要读的。 */
.muschip.lv3 {
  background: color-mix(in srgb, var(--c-exercise) 30%, var(--surface));
}

.muschip.lv3::before {
  background: var(--c-exercise-deep);
}

.muschip.lv2 {
  background: color-mix(in srgb, var(--c-exercise) 12%, var(--surface));
}

.muschip.lv2::before {
  background: var(--c-exercise);
}

.muschip.lv1 {
  background: var(--surface-2);
}

.muschip.lv1::before {
  background: var(--text-3);
}

/* ---------- 收口：下次建议 + 体感 ---------- */

.tailhint {
  margin: 0;
  color: var(--text-1);
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
}

/* 体感块：卡内分区。上一节存在（下次建议）时用细线分隔 ——
   输入项与结论在同一张卡里，靠分隔线而不是两张卡。 */
.feelblock {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
}

.feelblock.divided {
  border-top: 0.5px solid var(--line);
  padding-top: var(--sp-10);
  margin-top: var(--sp-2);
}

.feellabel {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.feelopts {
  display: flex;
  gap: var(--sp-6);
}

/* 三枚等权（flex:1 一样宽）：视觉上就暗示「没有更正确的答案」。
   命中区 44px 直接撑高 —— 这一屏唯一需要动手的一格，不该是 28px 的小胶囊；
   卡内独立分区，撑高不会造成误触。 */
.feelopt {
  flex: 1;
  min-height: var(--hit-min);
  padding: 0 var(--sp-6);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
}

/* 选中态：accent-soft 底 + accent-strong 字（与 AddWorkoutSheet 的 .gtag 同一对令牌，
   明暗双态实测 4.62 / 5.34）。用「白字压 accent」暗色下只有 3.65:1。 */
.feelopt.on {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: var(--fw-semibold);
}
</style>
