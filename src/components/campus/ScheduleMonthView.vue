<script setup lang="ts">
import { computed } from 'vue'

import type { ScheduleEntry } from '@/types'
import { monthGrid, parseDate, todayStr } from '@/utils/date'

/**
 * 月视图 · 整月概览。每格最多画两条课程色条，其余折成「+N」。
 * 点某天会切到日视图并定位过去（由父组件接管）。
 */
const props = defineProps<{
  entries: ScheduleEntry[]
  /** 该月内任意一天 */
  anchor: string
}>()

const emit = defineEmits<{ select: [date: string] }>()

const today = todayStr()

const cells = computed(() => {
  const d = parseDate(props.anchor)
  return monthGrid(d.getFullYear(), d.getMonth() + 1)
})

const byDate = computed(() => {
  const map = new Map<string, ScheduleEntry[]>()
  for (const e of props.entries) {
    const list = map.get(e.date)
    if (list) list.push(e)
    else map.set(e.date, [e])
  }
  return map
})

function entriesOn(date: string | null): ScheduleEntry[] {
  return date ? (byDate.value.get(date) ?? []) : []
}

function colorOf(e: ScheduleEntry): string {
  return e.session.color ?? 'var(--cat-class)'
}

/** 本月上课天数与总课次，给出一句概览 */
const stats = computed(() => {
  const days = new Set<string>()
  let count = 0
  for (const [date, list] of byDate.value) {
    if (date.slice(0, 7) !== props.anchor.slice(0, 7)) continue
    days.add(date)
    count += list.length
  }
  return { days: days.size, count }
})
</script>

<template>
  <div class="month">
    <!-- 概览行只留本页的新信息：年月归页头那颗日期按钮（同一屏曾经两个「2026年10月」）。
         量词不能再用「节」—— 日/周视图里「节」指小节，这里数的是课次，
         两种口径撞一个词，读者只能猜量级 -->
    <p class="sum">
      上课 <span class="num">{{ stats.days }}</span> 天 · <span class="num">{{ stats.count }}</span> 次课
    </p>

    <!-- 单一卡面承载整月：42 个格子各自背 --shadow-card（亮色三层、每帧参与合成）
         曾经是这一页最贵的光栅负载，而「一月 42 张迷你卡」在日历语义里也不成立 ——
         一个月本来就是一张表。格子退成透明 + 细分隔，卡面阴影只画一份。 -->
    <div class="board">
      <div class="head">
        <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w">{{ w }}</span>
      </div>

      <div class="grid">
        <button
          v-for="(c, i) in cells"
          :key="i"
          class="cell"
          :class="{ blank: !c.date, today: c.date === today }"
          :disabled="!c.date"
          @click="c.date && emit('select', c.date)"
        >
          <template v-if="c.date">
            <span class="d">{{ c.day }}</span>
            <span class="chips">
              <span
                v-for="e in entriesOn(c.date).slice(0, 2)"
                :key="e.session.id + (e.holiday ?? '')"
                class="chip"
                :style="{ '--blk': colorOf(e) }"
              >
                <span v-if="e.holiday" class="hd" :class="e.holiday">{{ e.holiday === 'off' ? '假' : '调' }}</span>{{ e.session.courseName }}
              </span>
              <span v-if="entriesOn(c.date).length > 2" class="more">
                +{{ entriesOn(c.date).length - 2 }}
              </span>
            </span>
          </template>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.month {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.sum {
  font-size: var(--fs-caption);
  color: var(--text-2);
  padding: 0 var(--sp-2);
}

.head {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-6) var(--sp-6);
}

.head span {
  text-align: center;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.board {
  background: var(--surface);
  /* 内容容器档 16：整月是一张卡面，与日 / 周视图同层；20 是按钮档 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--sp-8) var(--sp-6);
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--sp-2);
}

.cell {
  min-height: 68px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-4);
  border-radius: var(--radius-s);
  text-align: left;
  overflow: hidden;
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 空档（上月/下月补位格）：透明格子上给一个可感知的按压态 */
.cell:not(.blank):active {
  background: color-mix(in srgb, var(--text-3) 8%, transparent);
  transform: scale(0.97);
}

/* 「今天」= 日期落进 accent 实心圆（iOS 日历语义），不再描整个格子 */
.cell.today .d {
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  font-weight: var(--fw-bold);
}

.d {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.chips {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

/* 课程色条：整面 soft tint（课表三视图同一档浓度，与日视图 / 周视图同画法），
   不再靠 2px 左边框（side-tab 收编）。底色混的是承载它的 --surface（牌面），
   与原先混 transparent 再压到牌面上等效，但合成关系更明确。 */
.chip {
  font-size: var(--fs-micro);
  line-height: var(--lh-title);
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--blk) 12%, var(--surface));
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「假 / 调」：直接缀在课名前面（色条太窄，放不下独立角标） */
.hd {
  font-weight: var(--fw-bold);
  margin-right: var(--sp-2);
}

.hd.off {
  color: var(--warn-strong);
}

.hd.makeup {
  color: var(--accent-strong);
}

.more {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  padding-left: var(--sp-4);
}
</style>
