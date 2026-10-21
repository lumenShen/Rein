<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Settings2, Target } from 'lucide-vue-next'

import ConstraintsSheet from '@/components/profile/ConstraintsSheet.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import MonthView from '@/components/todo/MonthView.vue'
import PillChip from '@/components/common/PillChip.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import WeekView from '@/components/todo/WeekView.vue'
import { EQUIPMENT_LABELS, EXPERIENCE_LABELS, GOAL_LABELS, TIME_SLOT_LABELS } from '@/config/domain'
import { fmtCents } from '@/config/ledger'
import { useFeaturesStore } from '@/stores/features'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import { bmiBand, bmiOf } from '@/utils/health'
import { todayStr } from '@/utils/date'

/**
 * 我 · 生活面板：与主页卡片同一套版式语言——全宽 .card 竖排（radius-xl / 20px 内边距）、
 * 卡头「大黑标题 + 右侧去处胶囊」、数字 800 字重等宽、卡内分区靠发丝线。
 * 身份缩成一行；番茄钟不在面板里调（完整配置在「设置 › 番茄钟」）；
 * 个人约束是健康方案的生成依据，编辑抽屉与跳转保持既有链路。
 */
const router = useRouter()
const n = useNutritionStore()
const ledger = useLedgerStore()
const program = useProgramStore()
const features = useFeaturesStore()
/** 「目标与结余」两栏各属一个模块：关掉的那栏连同它的数据请求一起收掉，
 *  只剩一栏时那栏通栏（不然右半屏会空出一块，读成没画完） */
const nutritionOn = computed(() => features.isEnabled('nutrition'))
const ledgerOn = computed(() => features.isEnabled('ledger'))

onMounted(() => {
  if (nutritionOn.value) {
    void n.loadProfile()
    void n.loadSummary(todayStr())
  }
  if (ledgerOn.value) {
    void ledger.loadMonth()
    void ledger.loadBudget()
  }
  // 「有方案 / 没方案」决定约束卡上那条链路的文案，只有开着模块时才拉
  if (features.isEnabled('program')) void program.load()
})

const avatarChar = computed(() => (n.profile?.nickname ?? 'R').slice(0, 1))
const heightText = computed(() => n.profile?.heightCm ?? '--')
const weightText = computed(() => n.profile?.weightKg ?? '--')
const goalText = computed(() => (n.profile ? GOAL_LABELS[n.profile.goal] : ''))

/* BMI 分档：档案行上唯一带色的读数，异常档不用点进抽屉就能看见 */
const bmi = computed(() => bmiOf(n.profile?.weightKg ?? 0, n.profile?.heightCm ?? 0))
const bmiBandInfo = computed(() => (bmi.value == null ? null : bmiBand(bmi.value)))
const bmiText = computed(() => (bmi.value == null ? '' : bmi.value.toFixed(1)))

/* 身体读数串：目标体重没设时不渲染悬空的「→ --kg」，有几段拼几段 */
const metaLine = computed(() => {
  const parts = [`${heightText.value}cm`, `${weightText.value}kg`]
  if (n.profile?.targetWeightKg) parts.push(`→ ${n.profile.targetWeightKg}kg`)
  return parts.join(' · ')
})

/* ---- 每日目标 ---- */
const targetKcal = computed(() => (n.profile?.targets ? Math.round(n.profile.targets.kcal) : null))
const targetSub = computed(() => {
  const t = n.profile?.targets
  if (!t) return '未设置 · 点此配置'
  return `蛋白 ${Math.round(t.protein)}g · 碳水 ${Math.round(t.carb)}g · 脂肪 ${Math.round(t.fat)}g`
})

/* ---- 记账 ---- */
const balanceCents = computed(() => ledger.monthIncomeCents - ledger.monthExpenseCents)
const balancePos = computed(() => balanceCents.value >= 0)
/** 结余展示取绝对值，符号由 balancePos 单独渲染（与 ledgerSub 同为分位口径） */
const balanceText = computed(() => fmtCents(Math.abs(balanceCents.value), { group: true }))
const ledgerSub = computed(() => {
  const base = `支 ${fmtCents(ledger.monthExpenseCents)} / 收 ${fmtCents(ledger.monthIncomeCents)}`
  const budget = ledger.settings?.monthlyBudgetCents ?? 0
  if (budget <= 0) return base
  const used = Math.min(999, Math.round((ledger.monthExpenseCents / budget) * 100))
  return `${base} · 预算已用 ${used}%`
})

/* ---- 待办完成度（周 / 月） ---- */
const view = ref<'week' | 'month'>('week')
const selectedDate = ref(todayStr())

/* ---- 个人约束（健康方案生成依据） ---- */
/* 约束摘要卡 + 编辑抽屉（components/profile/ConstraintsSheet：分组行卡版式，
 * 身体数据与训练约束两组，草稿就地改、保存落库）。身体数据此前只有 AI 工具
 * 能写，抽屉是应用内唯一的手动入口。 */
const editOpen = ref(false)

const constraintSummary = computed(() => {
  const p = n.profile
  return [
    { label: '训练', value: p?.trainingDaysPerWeek != null ? `${p.trainingDaysPerWeek} 天 · ${p.preferredTimeSlots?.length ? p.preferredTimeSlots.map((s) => TIME_SLOT_LABELS[s] ?? s).join('·') : '自由安排'}` : '未设置' },
    { label: '器械', value: p?.equipment ? EQUIPMENT_LABELS[p.equipment] : '未设置' },
    { label: '经验', value: p?.experience ? EXPERIENCE_LABELS[p.experience] : '未设置' },
    { label: '忌口', value: p?.dietRestrictions?.length ? p.dietRestrictions.join('、') : '无' },
  ]
})

function openEdit(): void {
  editOpen.value = true
}
</script>

<template>
  <div class="page">
    <PageHeader title="我" />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 身份条：点头像区进约束/身体资料编辑；目标与 BMI 分档上卡面，省一趟抽屉 -->
    <button class="card id row" @click="openEdit">
      <div class="avatar col center">{{ avatarChar }}</div>
      <div class="idcol">
        <p class="nick">
          {{ n.profile?.nickname ?? '…' }}
          <span class="goal">{{ goalText || '未设目标' }}</span>
        </p>
        <p class="meta num">
          {{ metaLine }}
          <span v-if="bmiBandInfo" class="bmi" :class="`t-${bmiBandInfo.tone}`">· BMI {{ bmiText }} {{ bmiBandInfo.label }}</span>
        </p>
      </div>
      <ChevronRight :size="16" class="t-3" />
    </button>

    <!-- 待办完成度：周 / 月 -->
    <section class="card">
      <header class="row between chead">
        <h2>待办完成度</h2>
        <SegmentedControl
          v-model="view"
          class="seg"
          :options="[
            { value: 'week', label: '周' },
            { value: 'month', label: '月' },
          ]"
        />
      </header>
      <WeekView v-if="view === 'week'" class="cbody" :selected="selectedDate" @select="selectedDate = $event" />
      <MonthView v-else class="cbody" :selected="selectedDate" @select="selectedDate = $event" />
    </section>

    <!-- 目标与结余：一卡两栏，发丝线分栏（摄入总览宏量区同一版式）。
         两栏分别属「营养」与「记账」模块，都关掉时整卡不出现 -->
    <section v-if="nutritionOn || ledgerOn" class="card">
      <div class="stats" :class="{ one: !nutritionOn || !ledgerOn }">
        <button v-if="nutritionOn" class="stat" @click="router.push('/nutrition/adjust')">
          <span class="s-label">每日目标</span>
          <span class="s-big num">{{ targetKcal ?? '--' }}<i>大卡</i></span>
          <span class="s-sub">{{ targetSub }}</span>
        </button>
        <button v-if="ledgerOn" class="stat" @click="router.push('/ledger')">
          <span class="s-label">本月结余</span>
          <!-- 带千分位的金额比目标数字长一截：统一起见两栏同用 display-s，不折行 -->
          <span class="s-big num" :class="balancePos ? 'pos' : 'neg'">
            {{ balancePos ? '+' : '-' }}{{ balanceText }}<i>元</i>
          </span>
          <span class="s-sub num">{{ ledgerSub }}</span>
        </button>
      </div>
    </section>

    <!-- 个人约束：方案生成依据，去处收在卡头右侧胶囊（与「今日画布 · 详情」同位）；
         口径说明（约束怎么进方案）收进标题行右侧的帮助入口，卡面只留 plan-link 一行结论 -->
    <section class="card">
      <header class="row between chead">
        <div class="row chead-title">
          <h2>个人约束</h2>
          <InfoHint title="约束与健康方案" content="健康方案按这些约束计算日程与食谱；也可在「健康方案」向导中临时调整。" />
        </div>
        <PillChip as="button" tone="action" @click="openEdit">
          编辑 <ChevronRight :size="13" :stroke-width="2.6" />
        </PillChip>
      </header>
      <ul class="clist num cbody">
        <li v-for="c in constraintSummary" :key="c.label">
          <em>{{ c.label }}</em>
          <b>{{ c.value }}</b>
        </li>
      </ul>
      <!-- 约束是方案的计算依据，这里给方案一条直达（无方案=去制定，有方案=去看执行） -->
      <button v-if="features.isEnabled('program')" class="plan-link" @click="router.push('/program')">
        <Target :size="14" />
        <span class="grow">{{ program.active ? '方案执行中 · 查看与复盘' : '按这些约束制定健康方案' }}</span>
        <ChevronRight :size="14" />
      </button>
    </section>

    <!-- 设置入口：二级页（功能开关 / 番茄钟完整配置 / 关于） -->
    <button class="card setrow row between" @click="router.push({ name: 'settings' })">
      <span class="row setlabel"><Settings2 :size="16" /> 设置</span>
      <span class="row setval">功能开关 · 番茄钟 · 关于<ChevronRight :size="15" class="chev" /></span>
    </button>

    <!-- 个人约束编辑：分组行卡抽屉（身体数据 / 训练约束 + 钉底保存） -->
    <ConstraintsSheet :open="editOpen" @close="editOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
  /* 竖排卡片间距交给全局 `.card + .card`（12px），与主页一致 */
}

/* 身份条：一行的信息条不是大卡，上下收到 8、左右走卡片档 16，行高按双行档 64 */
.id {
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h-double);
  padding: var(--sp-8) var(--pad-card);
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.id:active {
  background: var(--surface-2);
}

/* 头像章底色是 c-intake 实色起、向白提亮一档的实色渐变（不是半透明浅底），白字压得住，
   取 --on-accent 而不是裸 #fff —— 语义与 --accent 实底钮同源；第二停由 c-intake 派生，
   换肤 / 暗色时整条渐变跟着走，不再各留一支手写粉 */
.avatar {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--c-intake), color-mix(in srgb, var(--c-intake) 68%, var(--on-accent)));
  color: var(--on-accent);
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
}

.idcol {
  flex: 1;
  min-width: 0;
}

/* 姓名是这张条的主信息，走 16 Semibold；目标作为并列的次级标签跟在同一基线 */
.nick {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
}

/* 目标贴着姓名：身份行只有两行字，把目标推到卡右缘会跟箭头打架、读着像掉出来的 */
.goal {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

/* 主次文本上下 2：姓名与读数之间只留一线呼吸 */
.meta {
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* BMI 分档色（与约束抽屉卡头同一套档色；muted 档不另设色，随 meta 灰）。
   三档文字一律走 --*-strong：实底档（--warn / --danger）当小号文字用对比度不够，
   而同页 t-ok 早就用了 --ok-strong，三档必须同一支口径。 */
.bmi.t-ok {
  color: var(--ok-strong);
}

.bmi.t-warn {
  color: var(--warn-strong);
}

.bmi.t-danger {
  color: var(--danger-strong);
}

/* 卡头标题行：标题与帮助入口同一行（落点：卡头图标按钮放标题行右端） */
.chead-title {
  gap: var(--gap-sm);
  min-width: 0;
}

/* 卡头：与「摄入总览 / 今日画布」同一规格 —— title3 / 700 / -0.3px / 主色文字 */
.chead h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-1);
}

/* 卡头行与卡内容之间恒为 12（卡内区块档，周/月视图、摘要列表都吃这条） */
.cbody {
  margin-top: var(--gap-md);
}

.seg {
  width: 104px;
}

/* 目标与结余：两栏 + 发丝竖线 */
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

/* 只剩一栏（另一栏的模块被关掉）：通栏，不留半屏空洞 */
.stats.one {
  grid-template-columns: 1fr;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-sm);
  min-width: 0;
  padding-right: var(--sp-16);
  text-align: left;
  font: inherit;
  color: inherit;
}

.stat + .stat {
  border-left: 0.5px solid color-mix(in srgb, var(--text-1) 10%, transparent);
  padding-left: var(--sp-16);
  padding-right: 0;
}

/* 分栏小帽：与摄入总览宏量标签同一档。字段名是要读的信息，落 --text-2 */
.s-label {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.s-big {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -1.2px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.s-big i {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-3);
  margin-left: var(--sp-4);
  letter-spacing: 0;
}

.s-big.pos {
  color: var(--ok-strong);
}

/* 结余为负与「正」同档：文字档而不是实底档（--danger 压在白卡上当 34px 文字可以、
   当小字不行；这一对读数必须同一支口径，正档已经是 --ok-strong） */
.s-big.neg {
  color: var(--danger-strong);
}

.s-sub {
  max-width: 100%;
  /* 副标读的是「蛋白 100g · 碳水…」这类要照着配餐的比例：12 的字号 + --text-2 */
  font-size: var(--fs-caption);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 约束摘要 */
.clist {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-md);
}

.clist em {
  display: block;
  font-style: normal;
  /* 格上小帽（「训练」「器械」）是要读的字段名：12 字号 + --text-2 */
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.clist b {
  display: block;
  margin-top: var(--gap-text);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 约束 → 方案 的直达链路：一行，强调色文字（约束是方案的输入，去向要显眼但别抢编辑胶囊） */
/* 卡内的功能入口行：圆角比母卡收一档（16 → 12），文字 14 Medium */
.plan-link {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  width: 100%;
  min-height: var(--control-md);
  margin-top: var(--gap-md);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-m-nest);
  background: var(--accent-soft);
  /* accent-soft 底上的文字走 --accent-strong（实底档 --accent 在该底上不足 4.5:1） */
  color: var(--accent-strong);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  text-align: left;
}

.plan-link .grow {
  flex: 1;
  min-width: 0;
}

/* 设置入口行 */
.setrow {
  width: 100%;
  gap: var(--gap-md);
  min-height: var(--row-h);
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.setrow:active {
  background: var(--surface-2);
}

.setlabel {
  gap: var(--gap-sm);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.setval {
  gap: var(--gap-tight);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.chev {
  color: var(--text-3);
}
</style>
