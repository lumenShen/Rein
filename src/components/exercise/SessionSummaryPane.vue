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
 * 沉浸模式 · 训练总结（summary 阶段的内容区）。
 *
 * 从前这块只有三行：emoji + 课程名 + 一行总量（n/N 组 · 总容量 · 用时 · 大卡），
 * 底下 780px 全空。同样的 480 kg，5 组 × 96 与 2 组 × 240 的训练含义完全不同，
 * 只给总量等于什么都没说。这里按 `utils/sessionSummary` 的三层口径铺开：
 *
 *   1. **完成环** —— 一眼看清做了多少，以及跳过的组去了哪（分母不变、分子不计）。
 *   2. **四项指标** —— 容量 / 用时 / 消耗 / 每组耗时。总容量已是老面孔，
 *      每组耗时是新的：它把"用时"从课时长度变成节奏信息（练得快 = 密度高）。
 *   3. **进步** —— 重量与估算 1RM 的增量，**先出即时判定（对比上次，零请求）**，
 *      历史回来后由 `mergeHistoryPr` 覆盖为真历史 PR。两种可信度视觉上必须分得开
 *      （即时档空心标记、校正档实心），否则等于骗用户那个数一直是准的。
 *   4. **逐动作明细** —— 每一行的「最高组」是力量训练真正的信息量所在。
 *   5. **肌群** + **下次建议** —— 收口：今天练了什么、下次怎么走。
 *
 * 排版约束：这一屏在 932 高的视口里装不下，所以它是**可滚动**的（宿主 .scrollbody
 * 已有滚动与渐隐）。首屏必须完整装下「环 + 指标 + 进步」—— 这三块是"这次怎么样"
 * 的答案，其余是"细节与下一步"，滚下去看。
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

const stats = computed(() => {
  // 只有自重时把「次」扶正成主指标
  const repsMain = kgVolume.value <= 0 && bwReps.value > 0
  return [
    {
      key: 'vol',
      label: repsMain ? '总次数' : '总容量',
      value: repsMain ? String(bwReps.value) : kgVolume.value > 0 ? fmtKg(kgVolume.value) : '—',
      unit: repsMain ? '次' : kgVolume.value > 0 ? 'kg' : '',
    },
    { key: 'time', label: '用时', value: String(s.durationMin), unit: '分' },
    { key: 'kcal', label: '消耗', value: String(s.estimateKcalValue), unit: 'kcal' },
    {
      key: 'rate',
      label: '每组耗时',
      value: rhythm.value.secPerSet != null ? String(rhythm.value.secPerSet) : '—',
      unit: rhythm.value.secPerSet != null ? '秒' : '',
    },
  ]
})

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
    <!-- 完成环：分子只算真正登记的正式组；跳过仍占分母（口径与 store 一致） -->
    <div class="hero col center">
      <RingProgress
        v-if="completion.ratio !== null"
        :value="completion.ratio"
        color-var="--c-exercise"
        :size="132"
        :stroke="11"
      >
        <b class="num heropct">{{ Math.round(completion.ratio * 100) }}%</b>
        <span class="herosub num">{{ completion.done }}/{{ completion.total }} 组</span>
      </RingProgress>
      <div v-else class="herofallback num">—</div>
      <!-- 完成状态挨着完成环：它与环里的 N/N 组说的是同一件事，从前还写在副标题行里，
           同一事实一屏出现两遍（这里是它唯一的落脚处） -->
      <p class="herostat">
        <StatusChip :tone="completion.earlyEnd ? 'warn' : 'ok'" size="sm">
          {{ completion.earlyEnd ? '提前结束' : '全程完成' }}
        </StatusChip>
      </p>
      <h1 class="sumtitle">{{ s.plan?.name }}完成</h1>
      <!-- 副标题行只留日期与训练类型：日期降为次要说明，类型交给中性胶囊 ——
           完成状态已并入环旁，不再在这行第三次重复 -->
      <p class="sumsub">
        <span class="sumdate">{{ fmtDateCn(todayStr()) }}</span>
        <StatusChip v-if="s.plan?.workoutType" tone="neutral" size="sm">{{ s.plan.workoutType }}</StatusChip>
      </p>
      <!-- 跳过 / 加练 / 热身：把「分母去哪了」讲清楚，否则 2/19 只会让人困惑 -->
      <p v-if="completion.skipped > 0 || completion.extra > 0 || completion.warmups > 0" class="sumtags">
        <span v-if="completion.skipped > 0" class="sumtag">跳过 {{ completion.skipped }} 组</span>
        <span v-if="completion.extra > 0" class="sumtag">加练 {{ completion.extra }} 组</span>
        <span v-if="completion.warmups > 0" class="sumtag">热身 {{ completion.warmups }} 组</span>
      </p>
      <!-- 回头路：总结页是终态，但「少做一组 / 最后一组记错」时旧界面只剩保存错的那份
           或放弃整节课。放在完成环紧跟处，因为它回答的正是环上那个 n/N 带来的第一疑问。 -->
      <button v-if="completion.done > 0" type="button" class="undo" @click="undoLastSet">
        <RotateCcw :size="14" /> 撤销最后一组，继续训练
      </button>
    </div>

    <!-- 四项指标 -->
    <div class="statgrid">
      <div v-for="st in stats" :key="st.key" class="stat">
        <span class="stlabel">{{ st.label }}</span>
        <b class="stval num">{{ st.value }}<i v-if="st.unit" class="stunit">{{ st.unit }}</i></b>
      </div>
    </div>

    <!-- 训练后体感：练够分「体感」维度的输入，也是这一屏唯一需要用户动手的一格。
         三枚**等权**且不预设高亮 —— 默认选中任何一档都是替他回答；
         再点一次可以取消（记 null），跳过不影响保存：宁可这条没有，也不要编一个值。 -->
    <div class="feelrow">
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
    <!-- 配重与自重混在同一节：kg 容量只统计真配重，自重的次数单独报一行（合并会得出
         「重量 + 次数」这种不存在的量纲） -->
    <p v-if="kgVolume > 0 && bwReps > 0" class="stnote t-3">
      另有自重 <span class="num">{{ bwReps }}</span> 次（不计入 kg 容量）
    </p>

    <!-- 进步：即时判定先出，历史回来后 mergeHistoryPr 覆盖为真纪录 -->
    <section v-if="prTitle" class="blockcard prcard">
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
                ? `${p.value} 次（单组最多）`
                : `估算极限（1RM）${fmtKg(p.value)} kg`
          }}
        </span>
        <span class="prdelta num" :class="{ verified: isVerified(p) }">{{ prDeltaText(p) }}</span>
      </div>
    </section>

    <!-- 逐动作明细：最高组是力量训练真正的信息量（不是最后一组） -->
    <section v-if="detailRows.length" class="blockcard">
      <h3>逐动作明细</h3>
      <div v-for="d in detailRows" :key="d.r.exId" class="exrow">
        <span class="exname">{{ d.r.name }}</span>
        <span class="exmain num">{{ d.main }}</span>
        <!-- 最高组是这一行的结论：升为主数值（title3 + --text-1），
             总容量降为 caption 次要说明 —— 从前两个数同字档，读起来像同一件事的两种写法 -->
        <b v-if="d.top" class="extop num">{{ d.top }}</b>
        <span v-else class="extop-none">{{ d.topNote }}</span>
        <span v-if="d.hasPr" class="expr">{{ d.prLabel }}</span>
      </div>
    </section>

    <!-- 肌群：已折叠到评估组（胸/背/肩…），档位取组内最大值 -->
    <section v-if="muscles.length" class="blockcard">
      <h3>本次练到的肌群</h3>
      <div class="musrow">
        <span v-for="m in muscles" :key="m.group" class="muschip" :class="`lv${m.level}`">
          {{ m.label }} · {{ levelLabel(m.level) }}
        </span>
      </div>
    </section>

    <!-- 下次建议：只给一个具体的数 -->
    <section v-if="nextHint" class="blockcard hintcard">
      <h3>下次建议</h3>
      <p>{{ nextHint }}</p>
    </section>
  </div>
</template>

<style scoped>
/* ---------- 版式 ----------
   **不复用 SessionOverlay 的 .pane**：scoped 选择器跨组件不生效，
   挂了也是死类名（那一层还要 centre 居中，与这一屏的可滚动版式冲突）。

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

/* ---------- 完成环 ---------- */

.hero {
  gap: var(--gap-sm);
  padding: var(--sp-8) 0 var(--sp-4);
}

.heropct {
  /* 沉浸层单屏读数档（与 SessionOverlay 的休息倒数 / 计时同一条刻度），
     值与原裸值一致：30px */
  font-size: var(--fs-readout-sm);
  font-weight: var(--fw-bold);
  line-height: 1;
  letter-spacing: -0.5px;
}

.herosub {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  /* 主次文本上下只留 2（--gap-text）：它紧贴在完成环读数下面，属于同一条读数。 */
  margin-top: var(--gap-text);
}

/* ratio 为 null（无任何组位）时的占位：保持与环同高，避免整块塌下去 */
.herofallback {
  width: 132px;
  height: 132px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 40px = --fs-display-m；与完成环里的百分比读数同一档，占位与真值不会一大一小 */
  font-size: var(--fs-display-m);
  color: var(--text-3);
}

.sumtitle {
  font-size: var(--fs-large-title);
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

/* 完成状态：挨着完成环，与环里 N/N 组同源 —— 形态用 ok/warn 胶囊 */
.herostat {
  display: flex;
  justify-content: center;
  margin-top: var(--sp-2);
}

.sumtags {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-6);
  margin-top: var(--sp-2);
}

/* 「撤销最后一组」：总结页唯一的回头路，是**次按钮** —— 描边白底 + 中性字，
   不与底簇那颗实底「保存训练」抢焦点。高度取 44：它是这屏唯一的次要操作，也要点得中。 */
.undo {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  /* 命中区直接引用 --hit-min（44），不再写一个裸数字：
     它是这一屏唯一的次要操作，视觉可以小、热区必须够。 */
  min-height: var(--hit-min);
  margin-top: var(--sp-14);
  padding: 0 var(--sp-18);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.sumtag {
  font-size: var(--fs-micro);
  /* --text-1 而不是 --text-2：--surface-2 是**分段控件底**，
     --text-2 压它实测只有 2.93:1（亮）/ 1.19:1（暗）。
     这三个标签是「分母去哪了」的唯一解释，不能读不清。 */
  color: var(--text-1);
  background: var(--surface-2);
  border-radius: var(--radius-full);
  padding: var(--sp-4) var(--sp-8);
}

/* ---------- 四项指标 ---------- */

.statgrid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--gap-sm);
}

/* 自重单独报的那一行：不占指标格（否则会被读成与「总容量」同单位的第五格），
   只在配重与自重混在同一节课时出现 */
.stnote {
  margin-top: var(--sp-8);
  padding-left: var(--sp-2);
  font-size: var(--fs-caption);
}

/* ---------- 训练后体感 ---------- */

.feelrow {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  margin-top: var(--sp-12);
}

.feellabel {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.feelopts {
  display: flex;
  flex: 1;
  gap: var(--sp-6);
}

/* 三枚等权（flex:1 一样宽）：视觉上就暗示「没有更正确的答案」。
   命中区 44px 直接撑高 —— 这一屏唯一需要动手的一格，不该是 28px 的小胶囊；
   这一行上下没有相邻控件，撑高不会造成误触。 */
.feelopt {
  flex: 1;
  /* 同上：三枚体感胶囊的热区走 --hit-min，与 .undo 同一档。 */
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

.stat {
  background: var(--surface-2);
  border-radius: var(--radius-m);
  padding: var(--sp-8) var(--sp-8);
  min-width: 0;
}

.stlabel {
  display: block;
  font-size: var(--fs-micro);
  /* 四格数值的标签名（容量 / 用时 / 消耗 / 每组耗时）是**要读的**：读不出标签，
     下面那个数就只是一个没有名字的数字。tokens.css 的契约写得很直白——
     「凡是必须读出来的信息都不该放在 --text-3」。 */
  color: var(--text-2);
  /* 四个字标签在 1/4 屏宽里不折行 */
  white-space: nowrap;
}

.stval {
  display: block;
  /* 19px = --fs-title3 */
  font-size: var(--fs-title3);
  font-weight: var(--fw-semibold);
  margin-top: var(--sp-2);
  letter-spacing: -0.3px;
}

.stunit {
  font-size: var(--fs-micro);
  font-style: normal;
  font-weight: var(--fw-regular);
  color: var(--text-3);
  margin-left: var(--sp-2);
}

/* ---------- 进步 ---------- */

/**
 * 进步卡的绿底只留极淡的一层（--c-exercise-soft 合到 surface，约 0.09 alpha），
 * **不承载任何文字** —— 「绿字压绿底」在 sRGB 里无论怎么调都到不了 4.5:1
 * （实测亮色最好的组合只有 3.7:1，暗色 2.3:1；绿与绿的两端亮度天然拉不开）。
 * 所以语义交给标题前那枚绿环标记，标题与数值用 --text-1 / --text-2，
 * 对比度由文字色自己保证。绿底的作用只是「这块是好事」的分区暗示。
 */
.prcard {
  background: color-mix(in srgb, var(--c-exercise-soft) 45%, var(--surface));
}

.prtitle {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  /* 标题用 --text-1：它是这一屏唯一的「好消息」分区标题，
     但绿字压绿底不达标（见上），所以语义靠左侧绿环而不是文字颜色。 */
  color: var(--text-1);
}

/* 绿环标记：语义锚点，尺寸 8px 足够读出「这是一块好消息」 */
.prtitle::before {
  content: '';
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--c-exercise);
}

.prrow {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
}

.prname {
  width: 88px;
  flex: none;
  font-size: var(--fs-subhead);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prval {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prdelta {
  flex: none;
  font-size: var(--fs-footnote);
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
  background: var(--c-exercise);
}

/* ---------- 逐动作明细 ---------- */

.exrow {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
}

.exname {
  width: 88px;
  flex: none;
  font-size: var(--fs-subhead);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exmain {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  /* 徽标不用绿字：--c-exercise-soft 是 alpha 0.2 的软底，绿字压它只有
     2.53:1（亮）/ 9.51:1（暗）—— 亮色完全不达标，而一个读不清的
     「PR」徽标比没有更糟（用户会以为那行没被标记）。
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
  background: var(--c-exercise);
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

/* ---------- 下次建议 ---------- */

.hintcard p {
  color: var(--text-1);
}
</style>
