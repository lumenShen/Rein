<script setup lang="ts">
import { computed } from 'vue'
import { CalendarDays, Check, Paperclip, Pencil, Repeat2, Sparkles, Trash2 } from 'lucide-vue-next'

import { CATEGORY_META, priorityMeta } from '@/config/domain'
import { minToHHmm } from '@/utils/date'
import { describeRule } from '@/utils/recurrence'
import type { Todo, TodoSubtask } from '@/types'

/** 画布详情面板（桌面右栏）：选中块的字段、子任务勾选与快捷操作。 */
const props = defineProps<{ todo: Todo | null }>()

const emit = defineEmits<{
  toggle: []
  edit: []
  remove: []
  place: []
  subtasks: [next: TodoSubtask[]]
}>()

const timeLine = computed(() => {
  const t = props.todo
  if (!t || t.startMin == null) return null
  const end = t.startMin + (t.durationMin ?? 30)
  // 起止区间本身就给出时长（09:00 – 10:00 = 60 分钟），不再尾随「· 60 分钟」重复一遍
  return `${minToHHmm(t.startMin)} – ${minToHHmm(end)}`
})

const subProg = computed(() => {
  const s = props.todo?.subtasks
  if (!s?.length) return null
  return `${s.filter((x) => x.done).length}/${s.length}`
})

function flipSub(i: number): void {
  const t = props.todo
  if (!t?.subtasks) return
  emit('subtasks', t.subtasks.map((s, j) => (j === i ? { ...s, done: !s.done } : s)))
}
</script>

<template>
  <aside class="panel" data-testid="detail-panel">
    <template v-if="todo">
      <div class="kick row">
        <i class="dot" :style="{ background: `var(${CATEGORY_META[todo.category].colorVar})` }" />
        <span>{{ CATEGORY_META[todo.category].label }}</span>
        <span v-if="todo.priority > 0" class="prio" :style="{ color: `var(${priorityMeta(todo.priority).colorVar})` }">
          {{ priorityMeta(todo.priority).label }}
        </span>
      </div>
      <h3 class="tt" :class="{ done: todo.status === 'done' }">{{ todo.title }}</h3>
      <p v-if="timeLine" class="num meta time">{{ timeLine }}</p>
      <p v-else class="meta">未安排时间</p>

      <p v-if="todo.recRule" class="chip-row">
        <span class="chip"><Repeat2 :size="13" /> {{ describeRule(todo.recRule) }}</span>
      </p>
      <p v-if="todo.attachments?.length" class="chip-row">
        <button class="chip atch" aria-label="在编辑器中查看附件" @click="emit('edit')">
          <Paperclip :size="13" /> {{ todo.attachments.length }} 个附件与标记
        </button>
      </p>
      <p v-if="todo.programId" class="chip-row">
        <span class="chip src">来自健康方案</span>
      </p>
      <p v-if="todo.notes" class="notes">{{ todo.notes }}</p>

      <template v-if="todo.subtasks?.length">
        <p class="sec">子任务 <span v-if="subProg" class="num prog">{{ subProg }}</span></p>
        <label v-for="(s, i) in todo.subtasks" :key="i" class="sub">
          <input type="checkbox" :checked="s.done" @change="flipSub(i)">
          <span>{{ s.title }}</span>
        </label>
      </template>

      <div class="acts row">
        <button class="primary" @click="emit('toggle')">
          <Check :size="15" /> {{ todo.status === 'done' ? '标为未完成' : '标记完成' }}
        </button>
        <!-- 课表派生行是只读投影：标题/时间由同步生成，下一次同步会覆盖，所以不给编辑与删除 -->
        <template v-if="todo.courseSessionId == null">
          <button class="ghost" aria-label="编辑" @click="emit('edit')"><Pencil :size="15" /></button>
          <button class="ghost danger" aria-label="删除" @click="emit('remove')"><Trash2 :size="15" /></button>
        </template>
      </div>

      <p v-if="todo.courseSessionId != null" class="tip">
        <CalendarDays :size="13" /> 来自课表同步，可在
        <RouterLink :to="{ name: 'campus-schedule' }" class="place">课表</RouterLink>
        里查看
      </p>

      <p v-if="todo.startMin == null" class="tip">
        <Sparkles :size="13" /> 把它拖进时间轴，或
        <button class="place" @click="emit('place')">排入下一个空档</button>
      </p>
    </template>

    <div v-else class="empty">
      <p class="e1">选中一块看详情</p>
      <p class="e2">点时间轴上的块，或点未安排池里的卡片。</p>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  background: var(--surface);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-m);
  padding: var(--pad-card);
  display: flex;
  flex-direction: column;
  /* 卡内区块之间 12：原来是 9，分类引导 / 标题 / 时间 / 胶囊 / 子任务各差 3px，
     读起来没有节奏 */
  gap: var(--gap-md);
  min-height: 200px;
}

/* 高画质及以上：base.css 把 .panel 归到**浮层**那一组（底部抽屉 / 锚定菜单 / 操作面板
   占了 .panel 这个名字的多数用法），于是这里的落影会拿到悬浮玻璃那份 ——
   而这块面板是**在流**的（桌面右栏里的一张卡，不浮在任何东西上面），
   在一屏卡片里就它一片黑边。这里按在流内容面的那一档压回去：同一套光学内层，
   落影换成卡片那份（--glass-panel-shadow 与 --shadow-card 同值、且永远不会是 none）。 */
html[data-perf]:not([data-perf='low']) .panel {
  box-shadow: var(--glass-panel-shadow), var(--glass-insets);
}

/* 上面那条比 base.css 的「减弱透明度」退化块更具体（多了本组件的 scoped 属性），
   所以要在这里再压回去一次：系统要求实底时，光学内层也不该留着。 */
@media (prefers-reduced-transparency: reduce) {
  html[data-perf]:not([data-perf='low']) .panel {
    box-shadow: var(--shadow-card);
  }
}

.kick {
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.prio {
  font-weight: var(--fw-semibold);
}

.tt {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.01em;
  line-height: var(--lh-title);
}

.tt.done {
  color: var(--text-3);
  text-decoration: line-through;
}

.meta {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 起止区间是详情面板的时间主读数（原先同行还挂一句「· 60 分钟」把同一事实说两遍） */
.meta.time {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  line-height: var(--lh-title);
}

.chip-row {
  display: flex;
  gap: var(--gap-sm);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 3.5px 的半像素内距 + 10 的横向，落在细节上会显得比同屏胶囊矮一档；
     收进 4/12 与 24 最小高，三枚胶囊（循环 / 附件 / 来源）等高 */
  min-height: var(--chip-h);
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.chip.src {
  /* soft 底上的文字走 strong 档（STANDARDS §4）：实底 --ok 压在同源淡底上只有 1.95:1 */
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.chip.atch {
  position: relative;
  cursor: pointer;
}

/* 24 高的胶囊是排版规格，命中区补到 44（纵向各外扩 10，小于相邻区块的 12 间距） */
.chip.atch::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-10)) calc(-1 * var(--gap-tight));
  border-radius: inherit;
}

.notes {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: var(--radius-s);
  padding: var(--sp-8) var(--pad-inline);
  line-height: var(--lh-body);
}

.sec {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.prog {
  color: var(--accent);
}

.sub {
  display: flex;
  align-items: center;
  /* 复选框与文字之间 8（全库勾选项同一档） */
  gap: var(--gap-sm);
  /* 子任务行整行可点（label 包住复选框与文字）：行高取命中区下限 44，
     原先只有一行文字的 23px，触屏上很难点中 */
  min-height: var(--hit-min);
  font-size: var(--fs-body);
  cursor: pointer;
}

.sub input {
  width: 17px;
  height: 17px;
  accent-color: var(--ok);
}

.sub input:checked + span {
  color: var(--text-3);
  text-decoration: line-through;
}

.acts {
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
}

.primary {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  /* 常规按钮：高 40、圆角 20，与行尾两颗方钮同高 */
  min-height: var(--control-md);
  padding: var(--sp-10) 0;
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.ghost {
  position: relative;
  /* 常规按钮 40（--control-md）：原先 38 比主按钮矮一截，两颗次操作也不等高 */
  width: var(--control-md);
  height: var(--control-md);
  flex: none;
  border-radius: var(--radius-m);
  border: 0.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

/* 40 的视觉钮命中区补到 44：两颗相隔 8，44 热区之间仍留 4 的空隙 */
.ghost::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-m);
}

.ghost.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
}

.tip {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  /* soft 底上的文字走 strong 档（STANDARDS §4），实底 --accent 对比度不够 */
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-s);
  padding: var(--sp-8) var(--pad-inline);
}

.place {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--accent-strong);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.empty {
  margin: auto;
  text-align: center;
}

.e1 {
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.e2 {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
