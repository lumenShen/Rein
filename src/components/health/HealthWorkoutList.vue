<script setup lang="ts">
import { WORKOUT_META } from '@/config/domain'
import StatusChip from '@/components/common/StatusChip.vue'
import WorkoutSourceTag from '@/components/exercise/WorkoutSourceTag.vue'
import { fmtDateCn, minToHHmm } from '@/utils/date'
import type { HealthSyncWorkout, WorkoutType } from '@/types'

/**
 * 第三方运动记录行列表（只读）。
 *
 * 只服务「第三方数据管理」页：把「手机同步进来的」与「没填开始时间、回写时被跳过的本机
 * 记录」两组按同一形状列出来。刻意不复用 exercise 域的 WorkoutRow —— 那个组件要完整的
 * Workout 形状（effort / sessionId / createdAt），还带删除入口；这里只要用户最关心的
 * 几列，而且是只读的（补填与删除仍在「全部运动记录」页）。
 */
const props = withDefaults(
  defineProps<{
    items: HealthSyncWorkout[]
    /** 是否逐行标来源：块内来源单一（如「没填开始时间」块恒为本机）时可关掉 */
    showSource?: boolean
  }>(),
  { showSource: true },
)

/** 运动类型标签：导入记录的 type 正常落在 WORKOUT_META 内，脏数据兜底显示原文 */
function typeLabel(t: string): string {
  return WORKOUT_META[t as WorkoutType]?.label ?? t
}

/** 开始时刻；没有开始时间就直说，别留空白让人以为是渲染坏了 */
function timeOf(w: HealthSyncWorkout): string {
  return w.startMin != null ? minToHHmm(w.startMin) : '未填开始时间'
}
</script>

<template>
  <ul class="list">
    <li v-for="w in props.items" :key="w.id" class="item row">
      <i class="ic col center">{{ typeLabel(w.type).slice(0, 1) }}</i>
      <div class="flex-1">
        <p class="name">
          <span class="nm">{{ w.name }}</span>
          <WorkoutSourceTag :source="w.source" :show-local="props.showSource" />
        </p>
        <!-- 时刻是这一行要读的主值；日期是上下文，类型名让中性胶囊承载 -->
        <p class="meta">
          <span class="day">{{ fmtDateCn(w.date) }}</span>
          <span class="when num">{{ timeOf(w) }}</span>
          <StatusChip tone="neutral" size="sm">{{ typeLabel(w.type) }}</StatusChip>
        </p>
        <p v-if="w.note" class="note">{{ w.note }}</p>
      </div>
      <div class="col right">
        <b class="num kcal">{{ w.kcal }}<i class="ku">千卡</i></b>
        <span class="unit num">{{ w.durationMin }} 分钟</span>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  /* 双行行高 64（与 WorkoutRow 同款）：健康页与记录页的同一份记录读起来必须一样高 */
  min-height: var(--row-h-double);
  gap: var(--gap-md);
  padding: var(--sp-12) 0;
}

/* 分隔线用 :not(:first-child)：跨组件实例的同级 li 依然成立（与 WorkoutRow 同款） */
.item:not(:first-child) {
  border-top: 0.5px solid var(--line);
}

.ic {
  width: 40px;
  height: 40px;
  flex: none;
  /* 列表内的小尺寸图标底走 8（--radius-s）：与 WorkoutRow 的 .ic 同一档 */
  border-radius: var(--radius-s);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-weight: var(--fw-bold);
  font-size: var(--fs-callout);
}

.name {
  display: flex;
  align-items: center;
  /* 名字 + 来源标签：左右 8（--gap-text-inline） */
  gap: var(--gap-text-inline);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.nm {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 来源标签的样式在 WorkoutSourceTag 里（全站同一份实现，别在这里再抄一遍） */

.meta {
  margin-top: var(--gap-text);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  /* 行内的时刻 / 时长 / 类型胶囊：4（--gap-tight），比原来的 6 更贴一档 */
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 开始时刻是这一行要读的主值：日期只是上下文，类型名已让胶囊承载 */
.when {
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.note {
  margin-top: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: var(--lh-caption);
}

.right {
  align-items: flex-end;
  flex: none;
}

.kcal {
  /* 热量是数值：中性色（色彩配额，STANDARDS §4）。运动域的色相留给左侧字首头像的色底。
     右列数值统一等宽（tabular-nums），多行之间小数点才对得齐。 */
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--text-1);
  font-weight: var(--fw-bold);
  font-size: var(--fs-callout);
}

/* 热量单位后缀：数字已是主值，单位退成微字（与「N 分钟」成对出现） */
.ku {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  margin-left: var(--sp-4);
}

/* 时长是本行要读的数值：不吃 11px 水印档 */
.unit {
  font-size: var(--fs-caption);
  color: var(--text-2);
}
</style>
