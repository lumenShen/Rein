<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import ActionSheet from '@/components/common/ActionSheet.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { ACTIVITY_LEVEL_LABELS, GOAL_LABELS, TARGET_FIELD_META } from '@/config/domain'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import { ageFromBirthday } from '@/utils/date'
import { calcTargets } from '@/utils/nutritionCalc'
import type { ActivityLevel, Goal, Sex } from '@/types'

/** 方案计算器：身体参数 → BMR/TDEE → 各营养素与热量推荐；采用前二次确认。
 *  参数改动静默落库（calc_params 快照），再次进入原样恢复；未保存过时回落到资料推导。 */
const n = useNutritionStore()
const { toast } = useToast()

/* ---- 参数（挂载时恢复上次快照，其次用资料预填） ---- */
const sex = ref<Sex>('male')
const age = ref(30)
const heightCm = ref(175)
const weightKg = ref(70)
const activityLevel = ref<ActivityLevel>('light')
const goal = ref<Goal>('cut')

/** 水合完成前不触发自动保存，避免默认值覆盖快照 */
let ready = false

function snapshotParams() {
  return {
    sex: sex.value,
    age: age.value,
    heightCm: heightCm.value,
    weightKg: weightKg.value,
    activityLevel: activityLevel.value,
    goal: goal.value,
    savedAt: null,
  }
}

onMounted(async () => {
  if (!n.profile) await n.loadProfile()
  await n.loadCalcState()
  const s = n.calcState
  if (s && s.savedAt) {
    if (s.sex) sex.value = s.sex
    if (s.age != null) age.value = s.age
    if (s.heightCm != null) heightCm.value = s.heightCm
    if (s.weightKg != null) weightKg.value = s.weightKg
    activityLevel.value = s.activityLevel
    goal.value = s.goal
  } else {
    const p = n.profile
    if (!p) {
      ready = true
      return
    }
    if (p.sex) sex.value = p.sex
    const a = ageFromBirthday(p.birthday)
    if (a != null) age.value = a
    if (p.heightCm != null) heightCm.value = p.heightCm
    if (p.weightKg != null) weightKg.value = p.weightKg
    activityLevel.value = p.activityLevel
    goal.value = p.goal
  }
  ready = true
})

/* ---- 自动保存：防抖 600ms 静默落库；离页前有未保存改动则立即补存 ---- */
let saveTimer: ReturnType<typeof setTimeout> | undefined

watch([sex, age, heightCm, weightKg, activityLevel, goal], () => {
  if (!ready) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void n.saveCalcState(snapshotParams())
  }, 600)
})

onBeforeUnmount(() => {
  if (!saveTimer || !ready) return
  clearTimeout(saveTimer)
  saveTimer = undefined
  void n.saveCalcState(snapshotParams())
})

const SEX_OPTIONS = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
]

const GOAL_OPTIONS = [
  { value: 'cut', label: GOAL_LABELS.cut },
  { value: 'keep', label: GOAL_LABELS.keep },
  { value: 'bulk', label: GOAL_LABELS.bulk },
]

const ACTIVITY_OPTIONS = (Object.keys(ACTIVITY_LEVEL_LABELS) as ActivityLevel[]).map((k) => ({
  value: k,
  // 分段控件空间有限，取标签前两字
  label: ACTIVITY_LEVEL_LABELS[k].slice(0, 2),
}))

/* ---- 实时计算与差异 ---- */
const result = computed(() =>
  calcTargets({
    sex: sex.value,
    age: age.value,
    heightCm: heightCm.value,
    weightKg: weightKg.value,
    activityLevel: activityLevel.value,
    goal: goal.value,
  }),
)

const cells = computed(() =>
  TARGET_FIELD_META.map((m) => {
    const from = Math.round(n.profile?.targets[m.key] ?? result.value.targets[m.key])
    const to = Math.round(result.value.targets[m.key])
    return { ...m, from, to, changed: to !== from }
  }),
)

const diffs = computed(() => cells.value.filter((c) => c.changed))

/** 差异项自带单位（大卡 / g / mg / ml）：量纲跟着每一项走，不靠读者自己补 */
function diffText(c: { label: string; from: number; to: number; unit: string }): string {
  return `${c.label} ${c.from}→${c.to}${c.unit}`
}

/** 主变化 = 能量项（本卡的主读数）；没有能量差异时退回第一项 */
const mainDiff = computed(() => diffs.value.find((c) => c.key === 'kcal') ?? diffs.value[0] ?? null)

const diffsMainText = computed(() => (mainDiff.value ? diffText(mainDiff.value) : ''))
const diffsRestText = computed(() =>
  diffs.value
    .filter((c) => c !== mainDiff.value)
    .map(diffText)
    .join(' | '),
)

/**
 * 目标带来的缺口 / 盈余结论：只有这句上卡面（胶囊），400 / 300 的来路
 * （Mifflin-St Jeor、活动系数）收进标题行右侧 InfoHint，不摊在公式行尾当补语。
 */
const DELTA_LABEL: Record<Goal, string | null> = {
  cut: '减脂缺口约 400 大卡',
  keep: null,
  bulk: '增肌盈余约 300 大卡',
}

function setSex(v: string): void {
  sex.value = v as Sex
}
function setGoal(v: string): void {
  goal.value = v as Goal
}
function setActivity(v: string): void {
  activityLevel.value = v as ActivityLevel
}

/* ---- 采用确认 ---- */
const confirmOpen = ref(false)

async function adopt(): Promise<void> {
  await n.adoptPlan(
    {
      sex: sex.value,
      heightCm: heightCm.value,
      weightKg: weightKg.value,
      activityLevel: activityLevel.value,
      goal: goal.value,
    },
    result.value.targets,
  )
  toast(`已采用${GOAL_LABELS[goal.value]}方案`)
}

function onConfirm(value: string): void {
  if (value === 'adopt') void adopt()
}
</script>

<template>
  <section class="card">
    <header class="head">
      <h2 class="row center">
        方案计算器
        <!-- 公式口径（Mifflin-St Jeor / 活动系数 / 缺口大小）与「采用后可随时手动微调」
             收进这里；卡面不留没人读的解释段 -->
        <InfoHint
          class="headhint"
          title="推算口径"
          content="基础代谢（BMR）按 Mifflin-St Jeor 公式，由性别、年龄、身高、体重推算；总消耗（TDEE）= 基础代谢 × 活动系数。缺口大小只随目标而变：减脂约扣减 400 大卡，增肌约加回 300 大卡。

采用后仍可随时手动微调每日目标。"
        />
      </h2>
    </header>

    <!-- 参数 -->
    <div class="form">
      <div class="frow">
        <span class="flabel">性别</span>
        <SegmentedControl
          class="fctrl"
          :model-value="sex"
          :options="SEX_OPTIONS"
          @update:model-value="setSex"
        />
      </div>
      <NumberStepper v-model="age" label="年龄" unit="岁" :step="1" :min="10" :max="100" />
      <NumberStepper v-model="heightCm" label="身高" unit="cm" :step="1" :min="100" :max="250" />
      <NumberStepper v-model="weightKg" label="体重" unit="kg" :step="0.5" :min="30" :max="200" />
      <div class="frow">
        <span class="flabel">活动水平</span>
        <SegmentedControl
          class="fctrl wide"
          :model-value="activityLevel"
          :options="ACTIVITY_OPTIONS"
          @update:model-value="setActivity"
        />
      </div>
      <div class="frow">
        <span class="flabel">我的目标</span>
        <SegmentedControl
          class="fctrl wide"
          :model-value="goal"
          :options="GOAL_OPTIONS"
          @update:model-value="setGoal"
        />
      </div>
    </div>

    <!-- 推荐结果 -->
    <div class="plan">
      <p class="cap">{{ GOAL_LABELS[goal] }} · 推荐每日目标</p>
      <div class="kcal row">
        <b class="num">{{ result.targets.kcal }}</b>
        <span class="unit">大卡/天</span>
      </div>
      <StatusChip v-if="DELTA_LABEL[goal]" class="goalsign" tone="accent" size="md">
        {{ DELTA_LABEL[goal] }}
      </StatusChip>
      <ul class="cells">
        <li v-for="c in cells.slice(1)" :key="c.key">
          <em>{{ c.label }}</em>
          <span class="num cv"><b>{{ c.to }}</b><i>{{ c.unit }}</i></span>
        </li>
      </ul>
      <p class="formula num">
        基础代谢 {{ result.bmr }} 大卡 · 总消耗 {{ result.tdee }} 大卡
      </p>
      <p v-if="diffs.length" class="diffs">
        <span class="dlead">较当前</span>
        <b class="num dmain">{{ diffsMainText }}</b>
        <span v-if="diffsRestText" class="num drest">{{ diffsRestText }}</span>
      </p>
      <p v-else class="diffs same">与当前目标一致</p>
    </div>

    <button class="adopt" @click="confirmOpen = true">采用该方案</button>
    <!-- 「可随时手动微调」已移入标题行 InfoHint；这行只留按钮下方唯一的后果说明 -->
    <p class="note t-3">采用后同步更新身体资料与每日目标</p>

    <ActionSheet
      :open="confirmOpen"
      title="采用推荐方案？将覆盖当前每日目标"
      :actions="[{ label: '采用并保存', value: 'adopt' }]"
      @select="onConfirm"
      @close="confirmOpen = false"
    />
  </section>
</template>

<style scoped>
/* 卡头只剩标题行：标题 + 右侧帮助入口（公式口径），原解释副段删去 */
.head h2 {
  display: flex;
  align-items: center;
  /* 标题里的图标与文字：4·8 表里的一格 6 */
  gap: var(--sp-6);
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.headhint {
  margin-left: auto;
}

.form {
  /* 标题与内容 8：表单行自己带上下内距，这里不必再给 12 */
  margin-top: var(--gap-sm);
}

.frow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 标签与控件之间 12：中间有可伸缩空隙，12 是下限 */
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
}

.form > * + * {
  border-top: 0.5px solid var(--line);
}

.flabel {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  flex: none;
}

.fctrl {
  width: 128px;
  flex: none;
}

.fctrl.wide {
  width: 190px;
}

/* 推荐面板 */
.plan {
  /* 与上方表单 16（有明显边界的区块） */
  margin-top: var(--gap-lg);
  /* 二级分组面：内距收一档 12 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.cap {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.kcal {
  align-items: baseline;
  /* 大数与「大卡」：图标与文字左右 8 */
  gap: var(--gap-sm);
  margin-top: var(--gap-tight);
}

.kcal b {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-light);
  letter-spacing: -1px;
  color: var(--accent);
  /* 展示级数字用紧行高（--lh-display） */
  line-height: var(--lh-display);
}

/* 缺口/盈余结论：soft 底 + strong 字的语义胶囊，落在主读数正下方 */
.goalsign {
  margin-top: var(--gap-sm);
}

.unit {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.cells {
  margin-top: var(--gap-md);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  /* 行距 8 / 列距 6：五列在窄宽下要挤，列距不能再大 */
  gap: var(--gap-sm) var(--sp-6);
}

.cells li {
  min-width: 0;
}

.cells em {
  display: block;
  font-style: normal;
  /* 字段小帽（蛋白质 / 碳水…）：要读的字段名，不落 --text-3 */
  font-size: var(--fs-caption);
  color: var(--text-2);
  white-space: nowrap;
}

.cv {
  display: block;
  font-size: var(--fs-subhead);
}

.cv b {
  font-weight: var(--fw-bold);
}

.cv i {
  font-style: normal;
  /* 单位后缀，装饰性微字，可留在 10px 档 */
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: var(--gap-text);
}

.formula {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

/* 差异行拆两档：主变化（能量）是要读的数，其余项降为三级灰、竖线分隔 */
.diffs {
  margin-top: var(--gap-sm);
  line-height: var(--lh-body);
}

.dlead {
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-right: var(--sp-6);
}

.dmain {
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.drest {
  display: block;
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.diffs.same {
  margin-top: var(--gap-tight);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

/* 采用按钮 */
.adopt {
  width: 100%;
  margin-top: var(--gap-lg);
  /* 主按钮高度 40 档（12 上下 + 16 字） */
  padding: var(--sp-12) 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}

.note {
  margin-top: var(--gap-sm);
  text-align: center;
  font-size: var(--fs-caption);
}
</style>
