<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Clock, Calculator, PencilLine, Sparkles } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import {
  EFFORT_LABELS,
  WORKOUT_GROUPS,
  WORKOUT_META,
  estimateKcalByEffort,
  effortToIntensity,
  workoutTypesInGroup,
} from '@/config/domain'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import { todayStr } from '@/utils/date'
import { EFFORT_LEVELS, type EffortLevel, type WorkoutGroup, type WorkoutType } from '@/types'

/**
 * 手动补录运动（SheetModal）。
 *
 * **档位：打开即 large（90%）**。这里踩过一次坑：初版沿用默认的 medium 档
 * （SNAP_RATIOS = 0.2 / 0.4 / 0.9），实测 932 高视口下抽屉只有 373px，
 * 减掉拖动条 24 + 头部 40 + 固定在底部的保存条 78，**内容区只剩 241px**，
 * 而内容总高 629px —— 62% 落在折叠线以下，「消耗」那张结果卡要往上拖 226px
 * 才看得见。等于把主角藏起来，再由用户自己找。
 *
 * 「这个抽屉是一张 6 段表单」这个事实决定了它不该停在 40%：large 档的内容区是
 * 707px，而内容 700px —— **430 与 375 两个宽度下都是一屏装下、0px 溢出**。
 * 为此有两处是量出来的、不是随手定的：
 *   - 区块间距取 15px 而非常见的 18px（18px 时内容 718px，会把末尾那条说明切掉 11px）；
 *   - 分区胶囊必须单行（见 .groups > li 的注释）—— 它在 375px 上折行时
 *     「做了什么」一段会从 145px 涨到 159px，正好把 375 顶出折叠线。
 * 用户仍可下拖回 medium 档。
 * 结论写在组件里，免得下次有人"顺手"改回默认值。
 * 复测：scripts/shot-addworkout-initial.mjs（量折叠线以下剩多少）。
 *
 * 三处刻意的设计（相对旧版那 9 个类型 + ±5 分钟 + 低/中/高）：
 *
 * 1. **时长可输入**。旧版只有 ±5 分钟步进，凑不出「47 分钟」这种真实值 ——
 *    而时长是 MET 公式里唯一线性于消耗的因子，凑出来的整数等于把误差直接写进热量。
 *    交给 NumberStepper：步进给手感，点数字给精度。
 *
 * 2. **强度换成体感**。旧版让用户自选「低/中/高强度」，那要求他先知道自己的 MET 档，
 *    于是几乎所有人一律选中间档 —— 有数字、无信息。现在只问「这次累不累」（1–5），
 *    由 `estimateKcalByEffort` 折回 MET 档。
 *
 * 3. **热量可由用户直接给**。MET 估算对「爬楼梯 8 分钟」「跳绳 3 分钟」这类短项目
 *    误差极大（短时代谢当量占比高、个体差异也最大），而这类项目的用户往往刚好知道
 *    手表/体脂秤给的数。所以 kcal 是可编辑字段，估算值只是它的**初值**：
 *    用户一动输入就切成手动态，不再被估算值覆盖回来。
 */
defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: [] }>()

const exercise = useExerciseStore()
const nutrition = useNutritionStore()
const { toast } = useToast()

/* ---------- 类型选择 ---------- */

const group = ref<WorkoutGroup>('cardio')
const type = ref<WorkoutType>('run')

const typeOptions = computed(() => workoutTypesInGroup(group.value))

/** 切分区时把选中项带过去：直接留着旧类型会造出「分组 B 里选着 A 的类型」的矛盾态 */
watch(group, () => {
  if (!typeOptions.value.includes(type.value)) type.value = typeOptions.value[0] ?? 'other'
})

/* ---------- 时长 ---------- */

const durationMin = ref(30)

/* ---------- 开始时刻（可选） ---------- */

// 留空 = 不记录时刻（旧行为）。为什么值得单独一栏：Health Connect 的运动记录
// 必须有起止时刻，没有时刻的记录在那边无处安放 —— 想把这条回写出去（回写开关
// 开着时），就得知道它是几点练的。手环/手表用户基本都知道自己几点开的练。
const startTime = ref('')

/** "HH:MM" → 当日分钟；非法/越界一律按没填处理，不悄悄夹取 */
const startMin = computed<number | null>(() => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(startTime.value)
  if (!m) return null
  const v = Number(m[1]) * 60 + Number(m[2])
  return v >= 0 && v < 24 * 60 ? v : null
})

/* ---------- 体感强度 ---------- */

const effort = ref<EffortLevel>(3)

const effortOptions = EFFORT_LEVELS.map((v) => ({ value: String(v), label: EFFORT_LABELS[v] }))

/* ---------- 热量：估算初值 / 手动改写 ---------- */

/** 用户一旦手动改过就不再被估算值覆盖（`null` = 跟随估算） */
const manualKcal = ref<number | null>(null)

/** 估算依据要摊开给用户看，体重是其中一环 —— 抽出来供文案复用 */
const weightKg = computed(() => Math.round(nutrition.profile?.weightKg ?? 70))

const autoKcal = computed(() =>
  estimateKcalByEffort(type.value, effort.value, durationMin.value, weightKg.value),
)

const kcal = computed(() => manualKcal.value ?? autoKcal.value)

/** 手填值的合法区间：大卡不该是负数，也不该是四位数（那基本是手滑多打了两个 0） */
const kcalInput = ref(String(kcal.value))

watch([type, effort, durationMin], () => {
  kcalInput.value = String(kcal.value)
})

/** 估算 → 手动的切换：只在「当前值仍等于估算值」时允许一键撤回，避免覆盖用户输入 */
const usingManual = computed(() => manualKcal.value !== null)

function applyKcal(raw: string): void {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n <= 0) {
    // 空/非法：回到估算态，并把输入框拉回合法值（不回拉的话输入框会留在屏幕上写着 -5）
    manualKcal.value = null
    kcalInput.value = String(autoKcal.value)
    return
  }
  manualKcal.value = Math.min(2000, n)
  kcalInput.value = String(manualKcal.value)
}

function resetToEstimate(): void {
  manualKcal.value = null
  kcalInput.value = String(autoKcal.value)
}

/* ---------- 名称 ---------- */

const customName = ref('')

const name = computed(() => customName.value.trim() || `${WORKOUT_META[type.value].label} · ${durationMin.value}分钟`)

/* ---------- 保存 ---------- */

const saving = ref(false)

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const label = WORKOUT_META[type.value].label
    await exercise.add({
      name: name.value,
      type: type.value,
      date: todayStr(),
      startMin: startMin.value,
      durationMin: durationMin.value,
      // intensity 是 NOT NULL 列（老代码与知识库派生仍读它），写的是从体感派生的档位；
      // 真正的用户输入落在 effort 上。见 db.rs MIGRATION_0035 的说明。
      intensity: effortToIntensity(effort.value),
      effort: effort.value,
      kcal: kcal.value,
      note: manualKcal.value == null ? null : `用户输入消耗 ${manualKcal.value} 大卡`,
    })
    toast(`已记录 ${label} ${durationMin.value} 分钟，消耗 ${kcal.value} 大卡`)
    reset()
    emit('close')
  } finally {
    saving.value = false
  }
}

/** 关掉再打开时回到干净状态（SheetModal 是常驻挂载的，不重置就会带着上次的草稿） */
function reset(): void {
  group.value = 'cardio'
  type.value = 'run'
  durationMin.value = 30
  startTime.value = ''
  effort.value = 3
  manualKcal.value = null
  customName.value = ''
  kcalInput.value = String(autoKcal.value)
}
</script>

<template>
  <SheetModal :open title="记运动" initial-snap="large" @close="emit('close')">
    <!-- 类型：分区切换 + 网格。30 个类型平铺没法用，分区是唯一可读的组织方式 -->
    <div class="sec">
      <span class="seclabel">做了什么</span>
      <ul class="groups">
        <li v-for="g in WORKOUT_GROUPS" :key="g.key">
          <button class="gtag" :class="{ on: group === g.key }" @click="group = g.key">
            {{ g.label }}
          </button>
        </li>
      </ul>
      <ul class="types">
        <li v-for="t in typeOptions" :key="t">
          <button
            class="chip"
            :class="{ on: t === type }"
            :aria-pressed="t === type"
            @click="type = t"
          >
            {{ WORKOUT_META[t].label }}
          </button>
        </li>
      </ul>
    </div>

    <!-- 时长：步进给手感，点数字直接输入实际值 -->
    <div class="sec">
      <span class="seclabel">运动时间</span>
      <div class="stepline">
        <NumberStepper
          v-model="durationMin"
          :step="5"
          :min="1"
          :max="600"
          label="时长"
          class="grow"
        />
      </div>
    </div>

    <!-- 开始时刻（可选）：Health Connect 的运动记录必须有起止时刻，
         想把这条回写出去就得有它；不填则只在本机记账，其他一切照旧。
         外壳用 <label>：整行（时钟图标 + 输入）都可点，原生 time 输入的
         实际可点区只有 ~21px 高，不该要求用户正好戳中那一条。 -->
    <div class="sec">
      <span class="seclabel">开始时刻（可选）</span>
      <label class="namefield">
        <Clock :size="14" class="t-3" />
        <input v-model="startTime" type="time" aria-label="开始时刻，可选" />
      </label>
    </div>

    <!-- 体感强度：替代原来的低/中/高强度 -->
    <div class="sec">
      <span class="seclabel">这次累不累</span>
      <SegmentedControl
        :model-value="String(effort)"
        :options="effortOptions"
        class="effseg"
        @update:model-value="effort = Number($event) as EffortLevel"
      />
    </div>

    <!-- 消耗：**这张抽屉的主角**，所以它是一张结果卡而不是又一个表单项。
         旧版它和「名称」一样高（69px），而「做了什么」占 145px —— 权重完全反了：
         用户来这一趟就是为了这个数。 -->
    <div class="sec result">
      <header class="rhead between">
        <span class="seclabel">
          消耗
          <!-- 「为什么是估算、实测从哪来」收进标题右侧 InfoHint：表单时没人读脚注段 -->
          <InfoHint
            class="kcalhint"
            title="消耗怎么估算的"
            content="消耗按「体重 × 时长 × 强度档」估算，只是参考值。手表 / 运动 App 给了实测数字，就直接填进来 —— 那比任何公式都准。"
          />
        </span>
        <button v-if="usingManual" class="reset" @click="resetToEstimate">
          <Calculator :size="12" /> 用回估算 {{ autoKcal }}
        </button>
        <span v-else class="autotag"><Sparkles :size="12" /> 估算</span>
      </header>

      <div class="rrow">
        <input
          v-model="kcalInput"
          class="kcalinput num"
          type="number"
          inputmode="numeric"
          min="1"
          max="2000"
          aria-label="消耗大卡，可直接填写实测值"
          @change="applyKcal(kcalInput)"
          @blur="applyKcal(kcalInput)"
        />
        <span class="kcalunit">大卡</span>
      </div>

      <!-- 估算依据摊开讲：不然那个数是个黑箱，用户凭什么信它 -->
      <p class="rbasis t-3">
        {{ usingManual ? '你填的实测值' : `${weightKg} 公斤 × ${durationMin} 分钟 × ${EFFORT_LABELS[effort]}` }}
      </p>
    </div>

    <!-- 名称：默认自动生成，可覆盖 -->
    <label class="sec">
      <span class="seclabel">名称（可选）</span>
      <span class="namefield">
        <PencilLine :size="14" class="t-3" />
        <input v-model="customName" type="text" :placeholder="name" aria-label="运动名称" />
      </span>
    </label>

    <!-- 结论只留一行：估算口径与「为什么填实测」在标题行 InfoHint 里 -->
    <p class="hint t-3">估算值，可改成实测</p>

    <!-- 保存：固定在抽屉底部，不随内容滚走 -->
    <template #footer>
      <button class="save" data-testid="workout-save" :disabled="saving" @click="save">
        保存 · {{ kcal }} 大卡
      </button>
    </template>
  </SheetModal>
</template>

<style scoped>
.sec {
  display: block;
  /* 表单项之间按间隔规范的 16（有明显边界的控件组间距），
     原来 14 会让表单的纵向节奏与抽屉内其它 16 的段落对不齐。 */
  margin-bottom: var(--gap-lg);
}

.seclabel {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  margin-bottom: var(--sp-8);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 「强度按体感折算」这类注解：占一行太占地方，与标签同排右对齐 */
.sechint {
  font-size: var(--fs-micro);
  font-weight: var(--fw-regular);
  font-style: normal;
  color: var(--text-3);
}

/* 「消耗」标题右侧的帮助入口：与文字基线对齐会歪，单独居中 */
.kcalhint {
  align-self: center;
}

/* ---------- 类型选择 ---------- */

/* 一行横向滚动，不换行：375px 上 6 个分区会折成两行，多出的那行把类型网格
   往下推 40px，而这张抽屉的高度本来就不宽裕。
   横向滚动是移动端对「一排筛选项」的常规解法，两侧溢出用负 margin 顶到内容边。 */
.groups {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--sp-6);
  /* 溢出侧顶到抽屉内容边：负 margin 与侧内距同取 --pad-sheet，与 SheetModal 同源 */
  margin: 0 calc(-1 * var(--pad-sheet)) var(--sp-10);
  padding: 0 var(--pad-sheet);
  list-style: none;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.groups::-webkit-scrollbar {
  display: none;
}

/* ⚠️ 必须放在 <li> 上，不能只放 .gtag：flex 项是 li 而不是按钮，
   只给按钮 `flex: none` 的话 li 依然会被压缩 → 按钮跟着变窄 → 
   「跑跳有氧」在 375px 上断成「跑跳有」/「氧」两行（实测踩过）。
   给 li 钉死则整行溢出、交给 overflow-x 横向滚。 */
.groups > li {
  flex: none;
}

.gtag {
  position: relative;
  flex: none;
  white-space: nowrap;
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

/* 选中态必须有别于未选态：accent-soft 底 + accent-strong 字（明暗双态实测
   4.62 / 5.34）。用这两个令牌而不是「白字压 accent」—— 后者暗色下只有 3.65:1。 */
.gtag.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

/* 命中区 44px：视觉胶囊保持 27px 高（一排 6 个撑到 44 会让整行变成一条粗带），
   热区交给伪元素向上下各扩 8.5px —— 分区改成单行后上下没有相邻控件，撑得开。
   与 NumberStepper 同一条约定：撑命中区，不撑视觉。 */
.gtag::after {
  content: '';
  position: absolute;
  inset: -9px 0;
}

.types {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--gap-sm);
  margin: 0;
  padding: 0;
  list-style: none;
}

.chip {
  position: relative;
  width: 100%;
  padding: var(--sp-10) var(--sp-2);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

/* 命中区 44px：格子只有 36px 高，上下各扩 4px 正好吃满 8px 的行距，
   不会与相邻行的热区重叠（撑过头会变成「点上面选中下面」） */
.chip::after {
  content: '';
  position: absolute;
  inset: -4px 0;
}

.chip.on {
  background: var(--accent);
  color: var(--on-accent);
}

/* 同 .save：暗色下白字压主色 3.65:1，改深墨 4.79:1 */
@media (prefers-color-scheme: dark) {
  .chip.on {
    color: #0b1a2f;
  }
}

/* ---------- 时长 ---------- */

/* 步进器自带 7px 上下内边距，这里不额外加框：它自己就是一个可点的数值钮 */
.stepline {
  padding: 0 var(--sp-2);
}

/* ---------- 体感 ---------- */

/* 5 段的中文标签（毫不累/有点累/适中/挺累/累坏了）在 320px 上一段只有 58px，
   必须比默认再小一号才不溢出 —— SegmentedControl 自带的 >4 段规则给的是 12px，
   这里 3 字标签仍偏宽，压到 11px（--fs-micro，字号阶梯下限）。 */
.effseg {
  --seg-fs: var(--fs-micro);
}

/* 分段控件的段高 31px，撑不到 44 —— 用伪元素把热区向上下各扩 7px。
   这里是单选组、上下没有相邻控件（撑开不会误伤别的按钮），所以能放心扩。
   :deep 是必须的：.seg-item 属于 SegmentedControl，scoped 选择器带不上它的属性。 */
.effseg :deep(.seg-item)::after {
  content: '';
  position: absolute;
  inset: -7px 0;
}

/* ---------- 消耗：结果卡 ---------- */

/* 它是「推算出来的结果」而不是「要填的一栏」，所以给它自己的底与圆角，
   从表单里跳出来 —— 视觉上告诉用户：上面三项是输入，这是它们算出来的东西。 */
.result {
  /* 结果卡内距走卡片一档（16）：原来 12/14/10 三边不等，
     左右比上下多 2px，里面的下划线读数看着偏右。 */
  padding: var(--pad-card);
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.rhead {
  display: flex;
  align-items: center;
}

.result .seclabel {
  /* 标题与内容之间 8（规范：卡内标题与内容 8），比其它区块再紧一档 —— 它和读数是一组。 */
  margin-bottom: var(--gap-sm);
  font-size: var(--fs-footnote);
}

.autotag,
.reset {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

/* 用回估算：小字低调，只在「用户改过」时出现。
   它是可点文字，字号下限 12（规则 3，--fs-caption），不再用 10 的微字档；
   视觉只占 ~17px 高，热区上下各扩 16px、横向 8px —— 落点右对齐，
   下方 .rrow 的输入在左侧，不会与读数抢点击。 */
.reset {
  position: relative;
  font-size: var(--fs-caption);
  color: var(--accent-strong);
}

.reset::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-16)) calc(-1 * var(--sp-8));
}

/* 数字与单位成一组，**下划线画在整组下面**而不是画在输入框上。
   画在输入框上的话它只延伸到数字结尾，「大卡」孤零零悬在线外；
   而且通栏的输入框会把「大卡」推到卡的最右边 —— 读数变成「360 …… 大卡」，
   中间空出两百来像素，读起来是两个不相干的东西。 */
.rrow {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
  width: fit-content;
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--line-strong);
}

/* 数字用 --text-1 而不是绿色：它是这张抽屉的主角（用户来就是为这个数），
   而任何绿色令牌压浅灰都到不了 4.5:1（ok-strong 3.93 / c-exercise-deep 2.67）。
   实测：scripts/colorlab/audit_add_workout.mjs（明暗双态像素级）

   宽度收成 4.5ch：足够四位数字（上限 2000），又不会让输入框里拖出一条长尾巴。
   那道下划线是这张表里唯一「能填」的提示 —— 输入框自己没有底（卡已经有底了）。 */
.kcalinput {
  flex: none;
  width: 4.5ch;
  padding: 0;
  border: 0;
  background: none;
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -1px;
  color: var(--text-1);
  text-align: left;
  -moz-appearance: textfield;
}

.kcalinput::-webkit-outer-spin-button,
.kcalinput::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.kcalunit {
  flex: none;
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 估算依据：不摊开讲，那个大数字就是个黑箱 —— 用户凭什么信它 */
.rbasis {
  margin-top: var(--sp-6);
  font-size: var(--fs-micro);
}

/* ---------- 名称 ---------- */

.namefield {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.namefield input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: none;
  font-size: var(--fs-body);
  color: var(--text-1);
}

/* 「开始时刻」也走 .namefield 外壳（与「名称」同构：前置图标 + 输入），
   但原生 time 输入自带一个**大号时钟图标**，于是这一行会并排出现两个时钟
   —— 左边我们放的 <Clock>，右边浏览器的取值指示器。
   整个字段本来就都是可点的（移动端点击即弹原生滚轮），指示器只服务于
   桌面 Chrome 的下拉，这里隐掉它；保留左上那颗与「名称」行对齐的图标。
   `-webkit-` 前缀是必须的：这是 Chromium 私有伪元素。 */
.namefield input[type='time']::-webkit-calendar-picker-indicator {
  display: none;
}

.hint {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* ---------- 保存 ---------- */

.save {
  width: 100%;
  padding: var(--sp-14) 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
}

.save:disabled {
  opacity: var(--disabled-opacity);
}

/**
 * 暗色下白字压 --accent 只有 3.65:1 —— 这是 tokens.css 里**已知且被刻意记下**的两难
 * （--accent 提亮是为图标/链接准备的，白字要托住就得把它压深、那样图标色又掉出 4.5）。
 * 令牌的正解是「组件层别把白字压在主色上」，但那是 60 个文件的成片改动。
 * 本抽屉自己解决：暗色下前景改用深墨（实测 4.79:1）。
 * 只在这一处覆盖，不动全局令牌 —— 见 tokens.css 暗色块的注释。
 */
@media (prefers-color-scheme: dark) {
  .save {
    color: #0b1a2f;
  }
}
</style>