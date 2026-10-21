<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-vue-next'

import StrengthExercisePicker from '@/components/exercise/StrengthExercisePicker.vue'
import WeightCurve from '@/components/exercise/WeightCurve.vue'
import { sessionService } from '@/services/sessionService'
import { useExerciseStore } from '@/stores/exercise'
import { motionOn } from '@/system/motion'
import { fmtDateCn } from '@/utils/date'
import { aggregateStrengthDays, fmtKg, type StrengthDay } from '@/utils/strength'
import type { StrengthExerciseRef } from '@/types'

/**
 * 力量进步卡（运动页）：按动作查看重量变化曲线。
 *
 * 动作选择有三条路，覆盖面不同：
 *  1. **点击动作名** → 抽屉里从全部练过的动作中选（还带搜索）——
 *     想要某个特定动作时走这条，动作多也找得到；
 *  2. **左右箭头** → 在列表里前后翻一个，适合"顺手看看隔壁"；
 *  3. **自动轮播** → 每 5 秒换一个，让人**发现自己没注意过的动作**
 *     （这一卡最大的问题是「只看最近练的那个」，而进步幅度大的往往是别的动作）。
 *     轮播可随时暂停，用户一动（翻页 / 选动作）就重新计时。
 *
 * 轮播默认**跟随动效偏好**：用户在设置里关掉动效、或系统声明减少动态效果时
 * 不自动开始 —— 自己换内容比过渡动画更该让位给「别自己动」这条意愿。
 *
 * 落库变化靠 exerciseStore.strengthRev 失效缓存。
 */
const exStore = useExerciseStore()
const refs = ref<StrengthExerciseRef[]>([])
const loaded = ref(false)
const selected = ref('')
const curveDays = ref<StrengthDay[]>([])
const loadingCurve = ref(false)
const pickerOpen = ref(false)

/** 已加载过的动作历史缓存（切回不重复请求） */
const cache = new Map<string, StrengthDay[]>()

/** chips 的键：动作库 id 优先，老数据回落名称 */
function refKey(r: StrengthExerciseRef): string {
  return r.exerciseId || r.name
}

/* ---------- 自动轮播 ---------- */

const ROTATE_MS = 5000
const rotating = ref(false)
let rotateTimer: number | null = null

function stopRotate(): void {
  rotating.value = false
}

function clearTimer(): void {
  if (rotateTimer !== null) {
    window.clearInterval(rotateTimer)
    rotateTimer = null
  }
}

/** 重新计时：手动操作后从这一刻起重新数 5 秒，而不是让定时器按旧相位打断 */
function restartTimer(): void {
  clearTimer()
  if (!rotating.value || refs.value.length < 2) return
  rotateTimer = window.setInterval(() => next(1), ROTATE_MS)
}

function toggleRotate(): void {
  rotating.value = !rotating.value
  if (rotating.value) restartTimer()
  else clearTimer()
}

/** 前后翻一个（绕回），dir = ±1 */
function next(dir: number): void {
  const list = refs.value
  if (list.length < 2) return
  const idx = list.findIndex((r) => refKey(r) === selected.value)
  const base = idx < 0 ? 0 : idx
  const to = (base + dir + list.length) % list.length
  selected.value = refKey(list[to]!)
  restartTimer()
}

/** 页面切到后台时停轮播：看不见的图上转等于白烧定时器与请求 */
function onVisibility(): void {
  if (document.hidden) clearTimer()
  else restartTimer()
}

onMounted(() => {
  void loadRefs()
  rotating.value = motionOn.value
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  clearTimer()
  document.removeEventListener('visibilitychange', onVisibility)
})

/* ---------- 数据 ---------- */

async function loadRefs(keep = false): Promise<void> {
  const prev = selected.value
  try {
    refs.value = await sessionService.strengthExercises()
  } catch {
    refs.value = []
  } finally {
    loaded.value = true
  }
  if (!refs.value.length) {
    selected.value = ''
    curveDays.value = []
    stopRotate()
    return
  }
  const name = keep && refs.value.some((r) => refKey(r) === prev) ? prev : refKey(refs.value[0]!)
  void select(name)
  // 列表就位后再起轮播（此前 refs 为空，计时器会立刻自己停掉）
  if (rotating.value) restartTimer()
}

watch(selected, (name) => {
  if (name) void select(name)
})

/** 逐组记录落库（结束保存 / 删除训练）后刷新：缓存全部失效，尽量留在当前动作 */
watch(
  () => exStore.strengthRev,
  () => {
    cache.clear()
    void loadRefs(true)
  },
)

/** 抽屉打开时暂停轮播：正在挑动作却被换掉很恼人；关掉后接着转 */
watch(pickerOpen, (o) => {
  if (o) clearTimer()
  else restartTimer()
})

async function select(name: string): Promise<void> {
  selected.value = name
  const hit = cache.get(name)
  if (hit) {
    curveDays.value = hit
    return
  }
  loadingCurve.value = true
  try {
    const rows = await sessionService.strengthHistory(name)
    const days = aggregateStrengthDays(rows).slice(-10)
    cache.set(name, days)
    curveDays.value = days
  } catch {
    curveDays.value = []
  } finally {
    loadingCurve.value = false
  }
}

/* ---------- 展示 ---------- */

const current = computed(() => refs.value.find((r) => refKey(r) === selected.value) ?? null)
const currentName = computed(() => current.value?.name ?? '选择动作')

/** 展示窗口（近 10 次）里最近一次的做组摘要 */
const lastDay = computed(() => curveDays.value[curveDays.value.length - 1] ?? null)

const lastSummary = computed(() => {
  const d = lastDay.value
  if (!d) return ''
  const working = d.sets.map((s) => `${fmtKg(s.weightKg ?? 0)}×${s.reps ?? '?'}`).join(' · ')
  return `${working}（${fmtDateCn(d.date)}）`
})

/** 轮播开关只在动作多于一个时才有意义 */
const canRotate = computed(() => refs.value.length > 1)

function onPick(key: string): void {
  selected.value = key
  restartTimer()
}
</script>

<template>
  <section v-if="!loaded || refs.length > 0" class="card">
    <header class="head">
      <h2>重量曲线</h2>
      <span class="sub">力量训练的渐进超负荷</span>
    </header>

    <!-- 动作切换条：名字可点（开抽屉）、两枚箭头翻页、右侧轮播开关 -->
    <div v-if="refs.length" class="switcher row">
      <button
        v-if="canRotate"
        class="arrow"
        type="button"
        aria-label="上一个动作"
        @click="next(-1)"
      >
        <ChevronLeft :size="17" />
      </button>

      <button
        class="pickbtn row center"
        type="button"
        aria-haspopup="dialog"
        :aria-expanded="pickerOpen"
        @click="pickerOpen = true"
      >
        <span class="pname">{{ currentName }}</span>
        <ChevronDown :size="15" class="pchev" />
      </button>

      <button
        v-if="canRotate"
        class="arrow"
        type="button"
        aria-label="下一个动作"
        @click="next(1)"
      >
        <ChevronRight :size="17" />
      </button>

      <button
        v-if="canRotate"
        class="rotate"
        type="button"
        :aria-pressed="rotating"
        :aria-label="rotating ? '暂停轮播' : '开始轮播'"
        @click="toggleRotate"
      >
        <component :is="rotating ? Pause : Play" :size="14" />
        {{ rotating ? '轮播中' : '轮播' }}
      </button>
    </div>

    <p v-if="current" class="cmeta t-3 num">
      共 {{ current.sessions }} 次训练 · 最近 {{ fmtDateCn(current.lastDate) }}
    </p>

    <div v-if="curveDays.length" class="curvewrap">
      <WeightCurve :days="curveDays" />
      <p v-if="lastSummary" class="lastsets num">{{ lastSummary }}</p>
    </div>
    <!-- 曲线是按重量画的：自重动作（引体/俯卧撑）没有重量数据，这里如实说明并指路，
         而不是留一句「该动作还没有重量记录」—— 用户明明练了 15 个引体，被说成没记录。
         措辞不写「自重动作」是因为记录里也可能只是没填重量，两种成因这里分不出来。 -->
    <p v-else class="hint">
      {{ loadingCurve ? '加载中…' : '没有重量数据 —— 进步看点次数，见动作历史里的次数纪录' }}
    </p>

    <StrengthExercisePicker
      :open="pickerOpen"
      :items="refs"
      :selected="selected"
      @close="pickerOpen = false"
      @pick="onPick"
    />
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.sub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.switcher {
  gap: var(--gap-sm);
  margin-top: var(--sp-12);
}

.arrow {
  position: relative;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 左右翻动作：视觉 34 不动，热区补到 44（落在 .switcher 的 8px 行距里） */
.arrow::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.arrow:active {
  opacity: 0.6;
}

/* 当前动作名：整块可点（这一卡里最主要的选择入口），占了中间的全部余量 */
.pickbtn {
  flex: 1;
  min-width: 0;
  min-height: var(--hit-min);
  gap: var(--gap-tight);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
}

.pickbtn:active {
  opacity: 0.7;
}

.pname {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pchev {
  flex: none;
  color: var(--text-3);
}

.rotate {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--hit-min);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  transition: color var(--dur-fast) var(--ease-standard);
}

/* 轮播开启时用运动色点亮底 —— 与下面的曲线同一个色，读作"这个动作正在被自动翻看"。
   文字（「轮播中」）是按钮标签：走中性色，色相只留在 soft 底的色块上（色彩配额，STANDARDS §4） */
.rotate[aria-pressed='true'] {
  background: var(--c-exercise-soft);
  color: var(--text-1);
}

.cmeta {
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
}

.curvewrap {
  margin-top: var(--sp-8);
}

.lastsets {
  /* 曲线与最近一组 8（标题与内容） */
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.hint {
  margin-top: var(--sp-12);
  font-size: var(--fs-footnote);
  color: var(--text-3);
}
</style>
