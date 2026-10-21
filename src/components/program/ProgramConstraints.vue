<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import { DIET_RESTRICTION_PRESETS, EQUIPMENT_LABELS, TIME_SLOT_LABELS } from '@/config/domain'
import { useNutritionStore } from '@/stores/nutrition'
import type { ProgramStart } from '@/types'
import type { Equipment, Profile, TimeSlot } from '@/types'
import { addDays, fmtDateCn, startOfWeek, todayStr } from '@/utils/date'
import { phaseForFirstCourse, pickWeekTemplate } from '@/utils/programEngine'
import { constraintSummary, constraintWarning } from '@/utils/programSetup'

/**
 * 内联约束向导：训练频率 / 开始日 / 首练课程 / 器械 / 忌口 / 常练时段当场可改，
 * 不再「跳去「我」页改完再回来」——这些约束本来就是方案的输入参数。
 *
 * 改动直接写回 profile（saveProfile），不引入第二套存储；开始日与首练是方案级
 * 参数（不落 profile）：选项与相位反解都按**本地草稿值**即时计算（先改频率、
 * 再选开始日时，首练选项同步跟随），变化即时经 start-change 回传方案页；
 * 底部一行「按此条件 → …」用与引擎相同的 pickWeekTemplate 口径实时预览。
 */

const props = defineProps<{
  /** 草稿已生成后约束又被改动 → 提示重新计算 */
  stale: boolean
  generating: boolean
  /** CTA 文案随草稿状态变化 */
  hasDrafts: boolean
  /** 课程 id → 名称（首练选择的展示用；加载失败时回退 id） */
  courseNames: Record<string, string>
}>()

const emit = defineEmits<{
  generate: []
  'start-change': [v: ProgramStart]
}>()

const n = useNutritionStore()

const draftDays = ref(4)
const draftEquipment = ref<string>('gym')
const draftSlots = ref<string[]>(['evening'])
const draftRestrictions = ref<string[]>([])
const customInput = ref('')
const saving = ref(false)

const startMode = ref<'next' | 'today' | 'tomorrow'>('next')
const firstCourseId = ref<string | null>(null)

watch(
  () => n.profile,
  (p: Profile | null) => {
    if (!p) return
    draftDays.value = p.trainingDaysPerWeek ?? 4
    draftEquipment.value = p.equipment ?? 'gym'
    draftSlots.value = [...(p.preferredTimeSlots ?? [])]
    draftRestrictions.value = [...(p.dietRestrictions ?? [])]
  },
  { immediate: true },
)

/**
 * 向导只提供 3–6 天：这是「起步建议」而非硬上限（硬上限是
 * ADJUSTMENT_LIMITS.trainingDaysMax）。开方案时给到 7 天会诱导过度承诺，
 * 真需要更高频率可以在方案页手动调参里加。
 */
const DAY_OPTIONS = [3, 4, 5, 6]
const dayOptions = computed(() => {
  const list = DAY_OPTIONS.includes(draftDays.value) ? DAY_OPTIONS : [draftDays.value, ...DAY_OPTIONS]
  return [...list].sort((a, b) => a - b)
})

const EQUIPMENT_OPTIONS = ['gym', 'home', 'mixed']
const SLOT_OPTIONS = ['morning', 'noon', 'evening']

const startDate = computed(() =>
  startMode.value === 'today'
    ? todayStr()
    : startMode.value === 'tomorrow'
      ? addDays(todayStr(), 1)
      : startOfWeek(addDays(todayStr(), 7)),
)

/** 本地草稿（频率/器械）对应的周模板——首练选项与相位都按它算，跟手不滞后 */
const draftTpl = computed(() => pickWeekTemplate(draftEquipment.value === 'home' ? 'home' : 'gym', draftDays.value))

const courseOptions = computed(() => {
  const ids = [...new Set(draftTpl.value.days.filter((d): d is string => d != null))]
  return ids.map((id) => ({ id, name: props.courseNames[id] ?? id }))
})

const phase = computed(() =>
  firstCourseId.value ? phaseForFirstCourse(draftTpl.value, firstCourseId.value) : 0,
)

const tomorrow = computed(() => addDays(todayStr(), 1))
const nextMonday = computed(() => startOfWeek(addDays(todayStr(), 7)))
/** 下周一恰好是明天（今天周日）时，两个选项是同一天：隐藏「明天开始」，并入「下周一」 */
const nextIsTomorrow = computed(() => nextMonday.value === tomorrow.value)

const startOptions = computed(() => {
  const opts: { value: 'next' | 'today' | 'tomorrow'; label: string }[] = [
    { value: 'today', label: `今天开始 · ${fmtDateCn(todayStr())}` },
  ]
  if (!nextIsTomorrow.value) {
    opts.push({ value: 'tomorrow', label: `明天开始 · ${fmtDateCn(tomorrow.value)}` })
  }
  opts.push({
    value: 'next',
    label: `下周一 · ${fmtDateCn(nextMonday.value)}${nextIsTomorrow.value ? '（明天）' : ''}`,
  })
  return opts
})

/** 预设之外的自定义忌口（已存进 profile 的关键词） */
const customRestrictions = computed(() =>
  draftRestrictions.value.filter((r) => !DIET_RESTRICTION_PRESETS.includes(r)),
)

/** 预览行拆两级：主数值（「N 练 / 纯饮食」）+ 其余条件，同屏不同字档 */
const preview = computed(() => {
  const parts = constraintSummary(draftDays.value, draftEquipment.value).split(' · ')
  const rest = parts.slice(1)
  if (startMode.value !== 'next') {
    rest.push(`${startMode.value === 'today' ? '今天' : '明天'}开跑`)
  }
  if (firstCourseId.value) {
    const name = courseOptions.value.find((c) => c.id === firstCourseId.value)?.name
    if (name) rest.push(`首练${name}`)
  }
  return { main: parts[0] ?? '', rest }
})
const warning = computed(() => constraintWarning(draftDays.value))

/** 模板变了（频率/器械改动）首练课程可能不存在了：清掉回默认顺序 */
watch(courseOptions, (opts) => {
  if (firstCourseId.value && !opts.some((c) => c.id === firstCourseId.value)) {
    firstCourseId.value = null
  }
})

/** 开始参数即时回传方案页（生成与 stale 判定都吃同一份） */
watch(
  [startMode, firstCourseId, draftTpl],
  () => {
    emit('start-change', {
      startMode: startMode.value,
      firstCourseId: firstCourseId.value,
      phase: phase.value,
      startDate: startDate.value,
    })
  },
  { immediate: true },
)

function pickStart(v: 'next' | 'today' | 'tomorrow'): void {
  startMode.value = v
  if (v === 'next') firstCourseId.value = null
}

/** 「自由安排」= 不限时段（落库 null，引擎按晚间兜底）；只在具体时段全不选时点亮 */
const freeSlots = computed(() => draftSlots.value.length === 0)

function toggleSlot(s: string): void {
  draftSlots.value = draftSlots.value.includes(s)
    ? draftSlots.value.filter((x) => x !== s)
    : [...draftSlots.value, s]
}

function toggleRestriction(r: string): void {
  draftRestrictions.value = draftRestrictions.value.includes(r)
    ? draftRestrictions.value.filter((x) => x !== r)
    : [...draftRestrictions.value, r]
}

function addCustom(): void {
  const v = customInput.value.trim()
  if (!v || draftRestrictions.value.includes(v)) return
  draftRestrictions.value.push(v)
  customInput.value = ''
}

/** 保存到 profile 并触发生成（约束是方案的输入参数，改完必须重新计算） */
async function applyAndGenerate(): Promise<void> {
  const p = n.profile
  if (!p || saving.value) return
  saving.value = true
  try {
    await n.saveProfile({
      ...p,
      trainingDaysPerWeek: draftDays.value,
      equipment: draftEquipment.value as Equipment,
      preferredTimeSlots: (draftSlots.value.length ? draftSlots.value : null) as TimeSlot[] | null,
      dietRestrictions: draftRestrictions.value.length ? draftRestrictions.value : null,
    })
    emit('generate')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section v-if="n.profile" class="pod">
    <header class="pod-head">
      <b>定制你的方案</b>
      <span class="t-3 cond-note">保存到「我 › 个人约束」</span>
    </header>

    <div class="group">
      <p class="glabel">每周能练几天</p>
      <div class="chips">
        <button
          v-for="d in dayOptions"
          :key="d"
          class="chip"
          :class="{ on: draftDays === d }"
          :aria-pressed="draftDays === d"
          @click="draftDays = d"
        >
          {{ d === 0 ? '不训练' : `${d} 天` }}
        </button>
      </div>
    </div>

    <div class="group">
      <p class="glabel">什么时候开始</p>
      <div class="chips">
        <button
          v-for="o in startOptions"
          :key="o.value"
          class="chip"
          :class="{ on: startMode === o.value }"
          :aria-pressed="startMode === o.value"
          @click="pickStart(o.value)"
        >
          {{ o.label }}
        </button>
      </div>
    </div>

    <!-- 提前开跑时的相位平移：接续当前训练节奏，避免连续同部位高负荷 -->
    <div v-if="(startMode !== 'next' || nextIsTomorrow) && courseOptions.length" class="group">
      <p class="glabel row">
        首个训练日练
        <!-- 「别连着来」的由来：提前开跑的相位平移口径，收进标签行右端 -->
        <InfoHint
          title="首个训练日练"
          content="提前开跑时，方案按本周模板接着往下排：上次练过的部位不紧跟第二次，中间换部位或休息，避免同一部位连续高负荷。

不选就按模板顺序开始；选了某个课程，第一个训练日就练它。"
        />
      </p>
      <div class="chips">
        <button
          class="chip"
          :class="{ on: firstCourseId === null }"
          :aria-pressed="firstCourseId === null"
          @click="firstCourseId = null"
        >
          按模板顺序
        </button>
        <button
          v-for="c in courseOptions"
          :key="c.id"
          class="chip"
          :class="{ on: firstCourseId === c.id }"
          :aria-pressed="firstCourseId === c.id"
          @click="firstCourseId = c.id"
        >
          {{ c.name }}
        </button>
      </div>
    </div>

    <div class="group">
      <p class="glabel">可用器械</p>
      <div class="chips">
        <button
          v-for="e in EQUIPMENT_OPTIONS"
          :key="e"
          class="chip"
          :class="{ on: draftEquipment === e }"
          :aria-pressed="draftEquipment === e"
          @click="draftEquipment = e"
        >
          {{ EQUIPMENT_LABELS[e] ?? e }}
        </button>
      </div>
    </div>

    <div class="group">
      <p class="glabel row">
        忌口
        <!-- 「引擎」是内部术语：说明收进标签行右端，卡面只留标签二字 -->
        <InfoHint
          title="忌口"
          content="点选排除的忌口会参与方案生成：含这些食材的食谱会被自动替换，不用自己核对每餐配料。

预设之外的忌口在下面填关键词（如芒果、花生），回车即添加。"
        />
      </p>
      <div class="chips">
        <button
          v-for="r in DIET_RESTRICTION_PRESETS"
          :key="r"
          class="chip"
          :class="{ on: draftRestrictions.includes(r) }"
          :aria-pressed="draftRestrictions.includes(r)"
          @click="toggleRestriction(r)"
        >
          {{ r }}
        </button>
        <button
          v-for="r in customRestrictions"
          :key="r"
          class="chip on"
          :aria-pressed="true"
          :aria-label="`移除忌口 ${r}`"
          @click="toggleRestriction(r)"
        >
          {{ r }} ×
        </button>
      </div>
      <div class="custom-add">
        <input v-model="customInput" class="cinput" placeholder="其他忌口关键词" @keyup.enter="addCustom">
        <button class="link" type="button" @click="addCustom">添加</button>
      </div>
    </div>

    <div class="group">
      <p class="glabel">常练时段</p>
      <div class="chips">
        <button
          class="chip"
          :class="{ on: freeSlots }"
          :aria-pressed="freeSlots"
          @click="draftSlots = []"
        >
          自由安排
        </button>
        <button
          v-for="s in SLOT_OPTIONS"
          :key="s"
          class="chip"
          :class="{ on: draftSlots.includes(s) }"
          :aria-pressed="draftSlots.includes(s)"
          @click="toggleSlot(s)"
        >
          {{ TIME_SLOT_LABELS[s] ?? s }}
        </button>
      </div>
    </div>

    <div class="preview num">
      <span class="pv-label">按此条件</span>
      <div class="pv-value">
        <b class="pv-main">{{ preview.main }}</b>
        <span class="pv-rest">{{ preview.rest.join(' ｜ ') }}</span>
      </div>
    </div>

    <p v-if="warning" class="warn-note">{{ warning }}</p>
    <p v-if="stale && hasDrafts" class="stale-note">约束已变化 · 下方方案是旧条件算的，重新计算后生效</p>

    <button class="primary" :disabled="generating || saving" @click="applyAndGenerate">
      {{ generating || saving ? '正在计算…' : hasDrafts ? '按新条件重新计算' : '计算三套方案' }}
    </button>
  </section>
</template>

<style scoped>
.pod {
  /* 卡内距 16（--pad-card）、半径 16（卡片档）：这是「一组条件」的容器，
     不是按钮，层级低于所在面板的 32。 */
  padding: var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
  /* 标题行与下面那组内容之间 8（卡内标题与内容 8） */
  margin-bottom: var(--gap-sm);
}

.pod-head b {
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.cond-note {
  font-size: var(--fs-micro);
}

.group + .group {
  /* 条件分组之间 16（有明显的边界）：同组内部 8、组与组 16，层级才读得出 */
  margin-top: var(--gap-lg);
}

.glabel {
  /* 组标签与组内胶囊 8（标题与内容） */
  margin-bottom: var(--gap-sm);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 标签行带说明入口的：? 推到行右端，与标签同行 */
.glabel.row {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.glabel.row .info-hint {
  margin-left: auto;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  /* 条件胶囊之间 8（无边界控件间距），原来 6 与同页其它组不一致 */
  gap: var(--gap-sm);
}

.chip {
  padding: var(--sp-6) var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

/* 选中态 = 中性墨色实底，不是强调色：这一屏同时有主 CTA、--accent-soft 条件预览框
   与「添加」链接三处强调色（决策与去处），选中胶囊再铺蓝会让主按钮反而不突出。
   明暗两档都成立：--text-1 亮色近黑 / 暗色近白，--bg 相反——与 SegmentedControl
   （白胶囊压灰轨道的中性选中）是同一套语言。 */
.chip.on {
  background: var(--text-1);
  border-color: var(--text-1);
  color: var(--bg);
  font-weight: var(--fw-bold);
}

/* 可见按压态：选中未选中都走同一份缩放反馈（全局只给了 button 的过渡） */
.chip:active {
  transform: scale(0.96);
}

.custom-add {
  margin-top: var(--sp-8);
  display: flex;
  align-items: center;
  gap: var(--sp-10);
}

.cinput {
  flex: 1;
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.link {
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 即时结果预览：方案输入参数的直接反馈（主数值提档，其余条件降为次要行） */
.preview {
  margin-top: var(--gap-md);
  /* 预览块四边同距 12（二级分组面），原来上下 10。 */
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  display: block;
}

.pv-label {
  display: block;
  /* 小标签与预览数值 8（标题与内容） */
  margin-bottom: var(--gap-sm);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
}

/* soft 底上的字走 strong 档；主数值是这一屏唯一 19px 读数 */
.pv-value {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--gap-text) var(--gap-sm);
}

.pv-main {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.pv-rest {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  line-height: var(--lh-body);
}

/* 两条必须读出来的提示：实底档 --warn 当字对比度约 2:1，走 --warn-strong */
.warn-note {
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  color: var(--warn-strong);
  line-height: var(--lh-body);
}

.stale-note {
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  color: var(--warn-strong);
  line-height: var(--lh-body);
}

.primary {
  width: 100%;
  margin-top: var(--sp-12);
  padding: var(--sp-12) 0;
  /* 页脚主按钮走按钮档 20（原来 8，看起来像卡内的小标签） */
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}
</style>
