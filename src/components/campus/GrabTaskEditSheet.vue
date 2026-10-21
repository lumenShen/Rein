<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Info, Zap } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { idOf } from '@/stores/courseSelect'
import type { GrabTask } from '@/types'

/**
 * 「改设置并重排」抽屉。
 *
 * 为什么是**重排**而不是就地改：引擎里一条任务的身份是 `(批次, 教学班)`，
 * 方式 / 意愿值 / 志愿序这些都写在任务行上。就地改要动 Rust 的任务表与状态机；
 * 而「删掉旧的、按新设置排一条新的」在语义上完全等价 —— 而且它顺手把
 * 「这条已经不想要了」的清理也一起做了，不留一条已取消的垃圾在列表里。
 *
 * 只开放三个真正会改结果的旋钮：抢课方式、意愿值、志愿序（在组里时）。
 * 上课小组不在这里改 —— 换组等于换一个教学班（竞争的人都不一样），
 * 那该回选课页重新挑，不该伪装成「编辑」。
 */
const props = defineProps<{
  open: boolean
  task: GrabTask | null
  /** 重排中（提交要等一个来回，期间不能让人再按一次） */
  busy: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [
    payload: { mode: 'predicate' | 'direct'; virtualCost: number; priority: number },
  ]
}>()

const mode = ref<'predicate' | 'direct'>('predicate')
const virtualCost = ref(0)
const priority = ref(1)

/** 每次打开都从这条任务的**当前设置**起步 —— 编辑的语义就是「在现状上改」 */
watch(
  () => [props.open, props.task?.id] as const,
  ([open]) => {
    if (!open || !props.task) return
    mode.value = props.task.mode
    virtualCost.value = props.task.virtualCost ?? 0
    priority.value = props.task.priority || 1
  },
)

/** 在志愿组里才谈得上志愿序；独立任务没有次序可言 */
const inSquad = computed(() => !!props.task?.groupKey)

const name = computed(() => {
  const t = props.task
  if (!t) return ''
  const course = t.courseName?.trim()
  const label = t.lessonName?.trim()
  if (!course) return label || `教学班 ${idOf(t.lessonId)}`
  if (!label || label === course || label.startsWith(course)) return course
  return `${course} · ${label}`
})
</script>

<template>
  <SheetModal :open="open && !!task" title="改设置并重排" initial-snap="medium" @close="emit('close')">
    <!-- 「先删后建」是内部实现语义：打开抽屉第一眼该看到的是要调什么，
         所以它收进标题行右侧的说明入口，面上只留一行结论 -->
    <template #action>
      <InfoHint title="「改设置并重排」在做什么">
        <p>保存后会<strong>先撤掉这条任务</strong>，再按新设置重新排一条 —— 任务单里不会留下旧的那条。</p>
      </InfoHint>
    </template>

    <p class="meta">
      <b>{{ name }}</b>
      <span v-if="task?.courseCode" class="num">{{ task.courseCode }}</span>
      <span v-if="task?.teacher">{{ task.teacher }}</span>
    </p>

    <p class="lead">保存 = 重新排一条</p>

    <section class="block">
      <h3>抢课方式</h3>
      <SegmentedControl
        v-model="mode"
        :options="[
          { value: 'predicate', label: '占位优先' },
          { value: 'direct', label: '直接提交' },
        ]"
      />
      <p class="hint">
        <Info :size="13" />
        <span v-if="mode === 'predicate'">
          开窗瞬间先占住队列位次（不花意愿值），受理后再正式确认。
        </span>
        <span v-else>跳过占位，直接发正式选课请求。少一次往返，但更容易被排在后面。</span>
      </p>
    </section>

    <section class="block">
      <h3>意愿值</h3>
      <!-- 分组标题已经写着「意愿值」，步进器的可见标签只表动作 ——
           整段删掉会把 aria-label 降级成「减少/增加/修改数值」，所以改成「投入」 -->
      <NumberStepper v-model="virtualCost" :min="0" :max="999" :step="5" label="投入" />
      <p class="hint">
        <Info :size="13" />
        只有启用了「虚拟学分/意愿值」的轮次才需要填；普通轮次留 0 即可。
      </p>
    </section>

    <section v-if="inSquad" class="block">
      <h3>志愿序</h3>
      <NumberStepper v-model="priority" :min="1" :max="20" :step="1" label="第几志愿" />
      <p class="hint">
        <Info :size="13" />
        同组互斥、只会中一个。序号越小越先出手 —— 把它往前挪就是「更想要这门」。
      </p>
    </section>

    <template #footer>
      <div class="acts">
        <button
          class="primary"
          :disabled="busy"
          @click="emit('save', { mode, virtualCost, priority: inSquad ? priority : 0 })"
        >
          <Zap :size="16" />
          {{ busy ? '正在重排…' : '保存并重新排队' }}
        </button>
      </div>
    </template>
  </SheetModal>
</template>

<style scoped>
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--gap-tight) var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-2);
  margin-bottom: var(--gap-sm);
}

.meta b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow-wrap: anywhere;
}

.lead {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
  margin-bottom: var(--gap-md);
  overflow-wrap: anywhere;
}

.block {
  /* 表单分组之间 16（表单项上下同一档） */
  margin-bottom: var(--gap-lg);
}

.block h3 {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  margin-bottom: var(--gap-sm);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
  margin-top: var(--gap-sm);
}

.hint svg {
  flex: none;
  margin-top: var(--gap-text);
}

.acts {
  display: flex;
  flex-direction: column;
}

.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  /* 表单主按钮：高 40、圆角 20 */
  min-height: var(--control-md);
  padding: var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}
</style>
