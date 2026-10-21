<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { CalendarDays, Check, MapPin, Undo2 } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { CATEGORY_META } from '@/config/domain'
import { minToHHmm } from '@/utils/date'
import type { Todo } from '@/types'

/**
 * 课表派生行的**只读**详情。
 *
 * 为什么不复用 `TodoEditorSheet`：课表派生行是 `campus_sessions` 的投影，
 * 标题/时间/地点都由 `campus_sync` 生成，而同步是**先删后建**——用户在编辑器里
 * 改完，下一次同步就把它抹掉重建，看起来像「App 把我的修改吃了」。
 * 所以这里只给「看」与「打卡」，改的入口一律指回课表配置页。
 *
 * 唯一保留的写操作是打勾（标记完成）：那是用户自己的考勤记录，
 * 而且 `materialize_todos` 对 `status='done'` 的行有「永不删除」的不变量，
 * 打了卡就不会被同步覆盖 —— 这条不变量正是这个按钮敢留着的原因。
 * 已经下课的课由后端 `auto_complete_past_courses` 自动打卡，这里只陈述事实、不再给按钮。
 */
const props = defineProps<{
  open: boolean
  todo: Todo | null
}>()

const emit = defineEmits<{ close: []; toggle: [todo: Todo] }>()

const router = useRouter()

const cat = computed(() => CATEGORY_META[props.todo?.category ?? 'general'])

const day = computed(() => props.todo?.date ?? '')

/** 周几：只在同一年内用 `MM月DD日 周X`，避免多一年时读错 */
const dayLabel = computed(() => {
  if (!day.value) return ''
  const d = new Date(`${day.value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day.value
  const dow = '日一二三四五六'[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 周${dow}`
})

const timeLabel = computed(() => {
  const t = props.todo
  if (!t || t.startMin == null) return ''
  const start = minToHHmm(t.startMin)
  const end = t.durationMin ? minToHHmm(t.startMin + t.durationMin) : ''
  return end ? `${start} – ${end}` : start
})

const done = computed(() => props.todo?.status === 'done')

/**
 * 下课时刻是否已过。课表派生行由后端 `auto_complete_past_courses` 自动打卡，
 * 已下课的课不该再给「撤销打卡」—— 撤销会在下次加载时被自动打卡立刻翻回来，
 * 那个按钮等于骗人。所以已下课只展示「已自动打卡」这个事实，把手工勾选留给未下课的课。
 */
const ended = computed(() => {
  const t = props.todo
  if (!t?.date || t.startMin == null) return false
  const end = new Date(`${t.date}T00:00:00`)
  if (Number.isNaN(end.getTime())) return false
  end.setMinutes(end.getMinutes() + t.startMin + (t.durationMin ?? 95))
  return end.getTime() <= Date.now()
})

function openSchedule(): void {
  emit('close')
  void router.push({ name: 'campus-schedule' })
}
</script>

<template>
  <SheetModal :open="open" title="课程" initial-snap="medium" @close="emit('close')">
    <!-- 「为什么这里是只读的」是背景口径：收进标题行右侧的说明入口，
         面上只留一行结论（连去处一起，那是要做的动作） -->
    <template #action>
      <InfoHint title="这门课为什么改不了">
        <p>这门课来自课表同步：标题、时间与地点都由教务课表生成。</p>
        <p>在这里改会被下次同步覆盖 —— 要改请到<strong>课表配置页</strong>重新同步。</p>
      </InfoHint>
    </template>
    <div v-if="todo" class="course">
      <div class="head">
        <i class="dot" :style="{ background: `var(${cat.colorVar})` }" />
        <h3>{{ todo.title }}</h3>
        <span v-if="done" class="chip done">已打卡</span>
      </div>

      <dl class="facts">
        <div v-if="dayLabel">
          <dt><CalendarDays :size="14" /> 日期</dt>
          <dd>{{ dayLabel }}</dd>
        </div>
        <div v-if="timeLabel">
          <dt><CalendarDays :size="14" /> 时间</dt>
          <dd class="num">{{ timeLabel }}</dd>
        </div>
        <div v-if="todo.notes">
          <dt><MapPin :size="14" /> 安排</dt>
          <dd>{{ todo.notes }}</dd>
        </div>
      </dl>

      <!-- 只留一行结论：只读 + 去哪儿改。完整口径在标题行右侧的说明里 -->
      <PillChip tone="label" size="md">只读 · 改课到课表配置页</PillChip>

      <div class="acts">
        <!-- 已下课：打卡是自动的，不给手工按钮（撤销会被下次自动打卡翻回来） -->
        <p v-if="ended" class="auto">
          <Check :size="15" /> 已自动打卡 · 下课即记
        </p>
        <button v-else class="primary" @click="todo && emit('toggle', todo)">
          <component :is="done ? Undo2 : Check" :size="15" />
          {{ done ? '撤销打卡' : '标记已完成' }}
        </button>
        <button class="ghost" @click="openSchedule">
          <CalendarDays :size="15" /> 在课表中查看
        </button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.course {
  display: flex;
  flex-direction: column;
  /* 抽屉内容区里各块之间 16（有明显边界的一档） */
  gap: var(--gap-lg);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.head h3 {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: var(--lh-title);
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
}

/* soft 底上的文字必须走 --*-strong：--ok 压在 --ok-soft 上只有 1.95:1，
   11px 的「已打卡」是这行最该读出来的状态 */
.chip.done {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.facts {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  /* 卡内的二级分组面：内距 12、圆角收一档（12），比母卡低一层 */
  padding: var(--pad-card-tight) var(--pad-card);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}

.facts > div {
  display: flex;
  align-items: baseline;
  gap: var(--gap-md);
}

.facts dt {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  width: 62px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.facts dd {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  line-height: var(--lh-caption);
  word-break: break-all;
}

.facts .num {
  font-variant-numeric: tabular-nums;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.acts button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  /* 抽屉底部操作钮：高 40、圆角 20（按钮档） */
  min-height: var(--control-md);
  padding: var(--sp-12);
  border-radius: var(--radius-l);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.acts button:active {
  transform: scale(0.985);
}

.primary {
  background: var(--accent);
  color: var(--on-accent);
}

/* 已自动打卡：与按钮同尺寸的静态行，读作「状态」而不是「动作」 */
.auto {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--ok-soft);
  color: var(--ok-strong);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

.ghost {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
