<script setup lang="ts">
import { computed } from 'vue'
import { Trash2 } from 'lucide-vue-next'

import { WORKOUT_META } from '@/config/domain'
import WorkoutSourceTag from '@/components/exercise/WorkoutSourceTag.vue'
import { fmtDateCn, minToHHmm } from '@/utils/date'
import type { Workout, WorkoutType } from '@/types'

/** 运动记录行：全部运动记录页（WorkoutRecordsPage）的记录列表。
 *  点击行 → detail 事件（父级开详情抽屉）；行尾删除钮 → remove 事件。
 *  remove 只代表「请求删除」—— 删除会级联抹掉逐组力量记录，
 *  确认层与真正的落库由父级负责，本组件不直接调用 store。 */
const props = withDefaults(
  defineProps<{
    workout: Workout
    /** 分组列表（按日/按月）下组头已含日期，置 false 避免重复 */
    showDate?: boolean
  }>(),
  { showDate: true },
)

defineEmits<{ detail: []; remove: [] }>()

const typeLabel = computed(() => WORKOUT_META[props.workout.type as WorkoutType].label)

const metaLine = computed(() => {
  const parts: string[] = []
  if (props.showDate) parts.push(fmtDateCn(props.workout.date))
  if (props.workout.startMin != null) parts.push(minToHHmm(props.workout.startMin))
  parts.push(typeLabel.value)
  return parts.join(' · ')
})
</script>

<template>
  <li
    class="row item"
    role="button"
    tabindex="0"
    @click="$emit('detail')"
    @keydown.enter="$emit('detail')"
  >
    <i class="ic col center">{{ typeLabel.slice(0, 1) }}</i>
    <div class="flex-1">
      <p class="name">
        <span class="nm">{{ workout.name }}</span>
        <WorkoutSourceTag :source="workout.source" />
      </p>
      <p class="meta num">{{ metaLine }}</p>
    </div>
    <div class="col right">
      <!-- 热量去掉来源不明的「-」前缀并补单位：读者原来既不知道这是千卡还是别的量级，
           也不知道「-」是消耗、支出还是省略符。单位后缀与 HealthWorkoutList 同一套
           排法（同域两种运动记录行，单位写法必须一致）。 -->
      <b class="num kcal">{{ workout.kcal }}<i class="ku">千卡</i></b>
      <span class="unit num">{{ workout.durationMin }} 分钟</span>
    </div>
    <button class="del" aria-label="删除记录" @click.stop="$emit('remove')">
      <Trash2 :size="16" />
    </button>
  </li>
</template>

<style scoped>
.item {
  /* 双行行（名称 / 时长 · 热量）统一 64 高（--row-h-double）：
     原来纯靠内距撑，记录一多、名称长短不一，行高就跟着跳。 */
  min-height: var(--row-h-double);
  gap: var(--gap-md);
  padding: var(--sp-12) 0;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

/* 按压底色：li[role=button] 吃不到全局按压反馈，这里自补一层。
   刻意不用 scale —— 通栏行缩放会从左右边缘豁出缺口（行宽=容器宽） */
.item:active {
  background: var(--surface-2);
}

/* 桌面工作台的悬停反馈，与同域的 StrengthExercisePicker `.prow:hover` 同一做法：
   只在真有指针设备的档位给出 —— 触屏上 hover 会「粘住」（点过之后那一行一直亮着）。 */
@media (hover: hover) {
  .item:hover {
    background: var(--surface-2);
  }
}

/* 分隔线用 :not(:first-child)：跨组件实例的同级 li 依然成立 */
.item:not(:first-child) {
  border-top: 0.5px solid var(--line);
}

.ic {
  width: 40px;
  height: 40px;
  flex: none;
  /* 列表内的 40px 图标底走「小尺寸容器」那一档 8（--radius-s），
     与卡片（16）拉开层级 —— 原来 16 让这枚方块看起来像卡片。 */
  border-radius: var(--radius-s);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-weight: var(--fw-bold);
  font-size: var(--fs-callout);
}

/* 名字与来源标签同一行：标签要贴着名字，才读得出「这条是手机同步的」；
   名字自己可截断（nm），标签不吃压缩（tag 里 flex:none） */
.name {
  display: flex;
  align-items: center;
  /* 名字与来源标签是「主文本 + 标签」：左右 8（--gap-text-inline）。 */
  gap: var(--gap-text-inline);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.right {
  align-items: flex-end;
  flex: none;
}

.kcal {
  /* 热量是数值：中性色（色彩配额，STANDARDS §4）。运动域的色相留给左侧字首头像的色底 */
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

/* 时长是本行要读的数值：必须读出来的时长不吃 11px 水印档
   （从前整行最小最浅的就是它，与右侧 kcal 的 callout 强调绿差了三档） */
.unit {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 删除钮：桌面 hover 才显形，触态完全不显（见末尾 @media）。
   命中区撑到 44×44 —— 16px 的垃圾桶是排版规格，不是触控规格：
   它坐在行尾，正是拇指点按行体的自然落点，44 是拇指的下限。
   22px 的盒子（16 图标 + 左右各 3px）+ ::after 各向外扩 11px = 44；
   多出的 3px 用负边距吃回，图标位置与行内排版都不动。 */
.del {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: calc(-1 * var(--sp-4));
  color: var(--text-3);
  opacity: 0;
  transition:
    color var(--dur-fast) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard);
}

/* 透明伪元素只负责吃事件，不吃视觉 —— 左右外扩 11px 落在行间 12px 的间距里，
   不会压到左侧 kcal 列的点按区 */
.del::after {
  content: '';
  position: absolute;
  inset: -11px;
}

/* 键盘聚焦也显形（桌面）：这颗钮平时不可见，focus-visible 是它唯一的可见反馈 */
.item:hover .del,
.del:focus-visible {
  opacity: 1;
}

/* hover / 聚焦即给出危险语义 —— 它什么都不会直接删，弹确认层才是真门 */
.del:hover,
.del:focus-visible {
  color: var(--danger);
}

/* 触态（无 hover 的设备）：删除钮整颗收回，连 hover / focus-visible 都不放它出来。
   行尾那颗常显图标加上它自身的点按区，把拇指点按行体的自然落点整块吃掉，
   一次误触就是全历史清零；删除统一走确认层（WorkoutRecordsPage 的 ActionSheet）。
   选择器必须与上面同特指度：.item:hover .del 是 (0,2,0)，
   只写一个 .del 压不住它（触摸为主 + 外接鼠标的混合设备上 hover 照样触发）。 */
@media (hover: none) {
  .del,
  .item:hover .del,
  .del:focus-visible {
    opacity: 0;
    /* 隐形也不可点：确认层有话说，但一颗看不见的按钮不该吞拇指。
       删除入口在 WorkoutDetailDrawer（显式「删除这次训练」）。 */
    pointer-events: none;
  }
}
</style>
