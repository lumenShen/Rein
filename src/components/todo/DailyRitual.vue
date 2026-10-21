<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Sparkles } from 'lucide-vue-next'

import { useTodoStore } from '@/stores/todo'
import { addDays, nowMin, todayStr } from '@/utils/date'
import type { Todo } from '@/types'

/**
 * 每日规划仪式：今天首次打开画布时的三步引导（回顾昨天 → 勾选今天要做 → 落位）。
 * 60 秒完成，随时可跳过；当天是否已做过由父级用 localStorage 标记。
 */
const props = defineProps<{
  open: boolean
  /** 候选：收件箱 + 逾期未完成 + 今日未安排 */
  candidates: Todo[]
}>()

const emit = defineEmits<{
  close: []
  /** 确认：ids 勾选的事项改为今天；mode = ai 时父级接着跑智能排程 */
  confirm: [ids: number[], mode: 'ai' | 'manual']
}>()

const store = useTodoStore()
const step = ref(0)
const picked = ref<Set<number>>(new Set())

/**
 * 欢迎语按打开时刻取词。弹层由父级在「当日首次进入画布」时触发（只按日计，不看时间），
 * 写死「早上好」会让下午/深夜打开的应用问候一句错的话。
 */
function greetingAt(min: number): string {
  const h = Math.floor(min / 60)
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
}

const greet = ref('')

watch(
  () => props.open,
  (o) => {
    if (o) {
      step.value = 0
      picked.value = new Set()
      greet.value = greetingAt(nowMin())
    }
  },
)

const yesterday = computed(() => {
  const d = addDays(todayStr(), -1)
  const list = store.allTodos.filter((t) => t.date === d)
  return { done: list.filter((t) => t.status === 'done').length, total: list.length }
})

const yLine = computed(() =>
  yesterday.value.total
    ? `完成了 ${yesterday.value.done}/${yesterday.value.total} 件事${yesterday.value.done === yesterday.value.total ? '，满勤！' : '。'}`
    : '昨天没有安排待办。',
)

function togglePick(t: Todo): void {
  const next = new Set(picked.value)
  if (next.has(t.id)) next.delete(t.id)
  else next.add(t.id)
  picked.value = next
}

function confirm(mode: 'ai' | 'manual'): void {
  emit('confirm', [...picked.value], mode)
}
</script>

<template>
  <div v-if="open" class="scrim" @click.self="emit('close')">
    <div class="card ritual" role="dialog" aria-label="今日规划">
      <header class="row between">
        <h2>今日规划</h2>
        <span class="num st">{{ step + 1 }} / 3</span>
      </header>
      <div class="dots">
        <i v-for="i in 3" :key="i" :class="{ on: i - 1 <= step }" />
      </div>

      <!-- 1 回顾昨天 -->
      <div v-if="step === 0" class="step">
        <p class="hi">{{ greet }}</p>
        <p class="desc">{{ yLine }}</p>
        <p class="hint">花 30 秒想想今天最重要的一件事是什么。</p>
      </div>

      <!-- 2 勾选今天要做 -->
      <div v-else-if="step === 1" class="step">
        <p class="cap">这些还没定时间 — 勾选今天要做的</p>
        <ul class="cands" data-rubber-self>
          <li v-for="t in candidates" :key="t.id">
            <button class="cand" :class="{ on: picked.has(t.id) }" @click="togglePick(t)">
              <span class="box"><Check v-if="picked.has(t.id)" :size="12" :stroke-width="3" /></span>
              <span class="tt">{{ t.title }}</span>
              <span v-if="t.durationMin" class="num dur">{{ t.durationMin }} 分钟</span>
            </button>
          </li>
          <li v-if="!candidates.length" class="none">收件箱是空的，直接去安排吧。</li>
        </ul>
      </div>

      <!-- 3 落位 -->
      <div v-else class="step">
        <p class="cap">怎么安排这 {{ picked.size }} 件事？</p>
        <p class="desc">交给 AI 按空档和优先级排进今天的时间轴，之后还能拖动微调。</p>
      </div>

      <footer class="row between acts">
        <button v-if="step > 0" class="ghost" @click="step--">上一步</button>
        <button v-else class="ghost" @click="emit('close')">跳过</button>
        <div class="row gap">
          <button v-if="step === 2" class="ghost" @click="confirm('manual')">我自己排</button>
          <button v-if="step < 2" class="primary" :disabled="step === 1 && !picked.size" @click="step++">
            {{ step === 0 ? '开始' : '下一步' }}
          </button>
          <button v-else class="primary ai" :disabled="!picked.size" @click="confirm('ai')">
            <Sparkles :size="15" /> AI 建议安排
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 弹层离屏边 24：与页面级大区块同档 */
  padding: var(--sp-24);
}

.ritual {
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-float);
  padding: var(--sp-20) var(--sp-22);
}

h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
}

.st {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.dots {
  display: flex;
  gap: var(--gap-tight);
  margin: var(--gap-md) 0 var(--gap-lg);
}

.dots i {
  height: 4px;
  flex: 1;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.dots i.on {
  background: var(--accent);
}

.step {
  min-height: 120px;
}

.hi {
  font-size: var(--fs-large-title);
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
}

.cap {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.desc {
  margin-top: var(--gap-sm);
  font-size: var(--fs-body);
  color: var(--text-1);
}

.hint {
  margin-top: var(--gap-sm);
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

.cands {
  margin-top: var(--gap-md);
  max-height: 260px;
  overflow-y: auto;
}

.cand {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  /* 候选行上下 12：19px 的勾选框 + 16 号标题要一行读得开，8 会显得挤 */
  padding: var(--sp-12) var(--sp-4);
  text-align: left;
  border-bottom: 0.5px solid var(--line);
}

.box {
  flex: none;
  width: 19px;
  height: 19px;
  border-radius: var(--radius-xs);
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
}

.cand.on .box {
  background: var(--ok);
  border-color: var(--ok);
}

.cand .tt {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
}

.cand .dur {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.none {
  padding: var(--sp-16) 0;
  color: var(--text-3);
  font-size: var(--fs-footnote);
}

.acts {
  /* 页脚操作区：与内容之间一档 16 */
  margin-top: var(--gap-lg);
}

.gap {
  gap: var(--gap-sm);
}

.ghost {
  min-height: var(--control-sm);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  color: var(--text-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.primary {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 常规按钮一档：高 40、左右 24、胶囊 */
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-24);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

.primary.ai {
  background: var(--accent);
}
</style>
