<script setup lang="ts">
/**
 * 一场运动的心率摘要视图（结果页 / 历史详情共用）。
 *
 * 与训练中的 HeartRateZoneBar 不是同一种图：那条是**此刻位置**（三角沿 5 段滑动），
 * 这条是**整场时间分布**（每段宽 = 该区时长占比）。两处读数都来自同一份
 * `HrWorkoutSummary`，所以历史详情与训练结束页不会各说一套。
 *
 * 没有样本（avgBpm 为 null）时整块不渲染 —— 父级只在记录有时才挂它。
 */
import { computed } from 'vue'
import { Heart } from 'lucide-vue-next'

import { HR_ZONES } from '@/config/hr'
import type { HrWorkoutSummary } from '@/types'

const props = defineProps<{
  hr: HrWorkoutSummary
}>()

const totalSec = computed(() =>
  (props.hr.zones ?? []).reduce((sum, z) => sum + Math.max(0, z.seconds), 0),
)

/** 只保留真正有时间的区间：0 秒的段画不出宽度，只会占一个图例位 */
const rows = computed(() => {
  const byZone = new Map((props.hr.zones ?? []).map((z) => [z.zone, Math.max(0, z.seconds)]))
  return HR_ZONES.map((meta) => {
    const seconds = byZone.get(meta.zone) ?? 0
    return {
      ...meta,
      seconds,
      pct: totalSec.value > 0 ? Math.round((seconds / totalSec.value) * 100) : 0,
    }
  }).filter((z) => z.seconds > 0)
})

const main = computed(() =>
  rows.value.reduce<(typeof rows.value)[number] | null>(
    (best, z) => (best == null || z.seconds > best.seconds ? z : best),
    null,
  ),
)

const highSec = computed(() =>
  rows.value.filter((z) => z.zone >= 4).reduce((sum, z) => sum + z.seconds, 0),
)

const coveragePct = computed(() => Math.round(Math.max(0, Math.min(1, props.hr.coverage)) * 100))

const coverageNote = computed(() =>
  coveragePct.value >= 80 ? '数据完整' : coveragePct.value >= 60 ? '部分区间缺失' : '样本偏少',
)

/** 一句分析：主要区间 → 高强度时长 → 数据覆盖（可信度） */
const analysis = computed(() => {
  const parts: string[] = []
  if (main.value) parts.push(`主要在${main.value.label}区（${main.value.pct}%）`)
  if (highSec.value >= 60) parts.push(`高强度 ${Math.round(highSec.value / 60)} 分钟`)
  parts.push(`心率覆盖 ${coveragePct.value}%（${coverageNote.value}）`)
  return parts.join(' · ')
})
</script>

<template>
  <section v-if="hr.avgBpm != null" class="hrsum">
    <div class="hrhead">
      <Heart class="hric" :size="15" :stroke-width="2.2" aria-hidden="true" />
      <span class="hrtitle">心率</span>
      <span class="hrvals num">
        平均 <b>{{ hr.avgBpm }}</b> · 最高 <b>{{ hr.maxBpm ?? '—' }}</b>
      </span>
      <span class="hrcov num">覆盖 {{ coveragePct }}%</span>
    </div>

    <template v-if="rows.length > 0">
      <!-- 时间分布：每段宽按该区秒数占比；图例里给百分比，不写分钟，
           分钟数由「心率覆盖 + 高强度」那句分析补足 -->
      <div class="zbar" aria-hidden="true">
        <i
          v-for="z in rows"
          :key="z.zone"
          :style="{ flexGrow: z.seconds, background: `var(${z.colorVar})` }"
        />
      </div>
      <div class="zlegend">
        <span v-for="z in rows" :key="z.zone">
          <i class="zdot" :style="{ background: `var(${z.colorVar})` }" />
          {{ z.label }}<b class="num">{{ z.pct }}%</b>
        </span>
      </div>
    </template>

    <p class="analysis">{{ analysis }}</p>
  </section>
</template>

<style scoped>
.hrsum {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  width: 100%;
  min-width: 0;
}

.hrhead {
  display: flex;
  align-items: center;
  gap: var(--gap-text);
  min-width: 0;
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.hric {
  flex: none;
  color: var(--danger);
}

.hrtitle {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.hrvals {
  min-width: 0;
  white-space: nowrap;
}

.hrvals b {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.hrcov {
  margin-left: auto;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.zbar {
  display: flex;
  gap: 2px;
  height: 10px;
  overflow: hidden;
  border-radius: var(--radius-full);
}

.zbar i {
  flex-basis: 0;
  flex-shrink: 1;
  min-width: 2px;
}

.zlegend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4) var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.zlegend span {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  white-space: nowrap;
}

.zdot {
  width: var(--sp-6);
  height: var(--sp-6);
  flex: none;
  border-radius: var(--radius-full);
}

.zlegend b {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.analysis {
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--text-2);
}
</style>
