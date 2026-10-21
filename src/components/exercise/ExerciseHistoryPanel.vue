<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { sessionService } from '@/services/sessionService'
import { fmtDateCn } from '@/utils/date'
import { fmtKg } from '@/utils/strength'
import { buildExerciseHistory, type ExerciseHistory } from '@/utils/strengthStats'

/**
 * 动作历史 / PR 面板：近 10 次训练逐场聚合 + 三项个人纪录
 * （最大重量、最佳估算 1RM、最佳单次容量）。
 * 自己拉数据（strength_history），父组件只给动作库 id。
 */
const props = defineProps<{ exerciseId: string | null }>()

const history = ref<ExerciseHistory | null>(null)
const loading = ref(false)
const showAll = ref(false)

const RECENT = 10

const rows = computed(() => {
  const all = history.value?.sessions ?? []
  const list = [...all].reverse() // 新的在上
  return showAll.value ? list : list.slice(0, RECENT)
})

const hasMore = computed(() => (history.value?.sessions.length ?? 0) > RECENT)

/**
 * 纯自重动作：所有场次都没有重量（引体 / 俯卧撑 / 双杠臂屈伸…）。
 * 这类动作的 kg 容量恒为 0、weight/e1rm 两路 PR 恒空 —— 三格 PR 与逐场行都要
 * 换成「次」口径，否则这个面板对自重动作永远显示「—」，像没练过。
 */
const bwOnly = computed(
  () => (history.value?.sessions.length ?? 0) > 0 && history.value!.sessions.every((s) => s.topWeightKg <= 0),
)

/** 三格 PR：自重动作换标签与数据源 —— kg 口径（重量/1RM/容量）对它们恒空 */
const prSlots = computed(() => {
  const p = history.value?.prs
  if (!p) return []
  const num = (rec: { value: number; date: string } | null) => ({
    value: rec ? String(rec.value) : '—',
    date: rec ? fmtDateCn(rec.date) : '',
  })
  if (bwOnly.value) {
    return [
      { key: 'reps', label: '单组最多次数 次', ...num(p.reps) },
      // 1RM 对自重组不可估（次数超上限即返回 0），如实留空而不是拿体重去编一个
      { key: 'e1rm', label: '估算极限重量（1RM）', value: '—', date: '' },
      { key: 'repsVolume', label: '最佳单次总次数 次', ...num(p.repsVolume) },
    ]
  }
  return [
    { key: 'weight', label: '最大重量 kg', ...num(p.weight) },
    { key: 'e1rm', label: '估算极限重量（1RM）', ...num(p.e1rm) },
    { key: 'volume', label: '最佳单次训练量 kg', ...num(p.volume) },
  ]
})

watch(
  () => props.exerciseId,
  async (id) => {
    history.value = null
    if (!id) return
    loading.value = true
    try {
      const sets = await sessionService.strengthHistory(id)
      history.value = buildExerciseHistory(sets)
    } catch {
      history.value = null
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="loading" class="state t-3">加载中…</div>
  <div v-else-if="!history || !history.sessions.length" class="state t-3">还没有这个动作的做组记录</div>
  <template v-else>
    <div class="prs row">
      <div v-for="slot in prSlots" :key="slot.key" class="pr">
        <span class="pv num">{{ slot.value }}</span>
        <span class="pk">{{ slot.label }}</span>
        <span class="pd t-3">{{ slot.date }}</span>
      </div>
    </div>

    <ul class="hist">
      <li v-for="s in rows" :key="s.workoutId" class="hrow row">
        <span class="hdate t-2">{{ fmtDateCn(s.date) }}</span>
        <!-- 自重动作没有重量可报：最重永远是 0kg，而「最多 15 次」才是这次的成绩 -->
        <span v-if="bwOnly" class="hmain num">{{ s.sets }} 组 · 最多 {{ s.topSetReps ?? '—' }} 次</span>
        <span v-else class="hmain num">{{ s.sets }} 组 · 最重 {{ fmtKg(s.topWeightKg) }}kg<span v-if="s.topReps">×{{ s.topReps }}</span></span>
        <!-- 训练量带标签：同单位下它比「最重」大一个量级，不标出来会误读成当天最大重量 -->
        <span class="hvol num t-3">{{ bwOnly ? `总次数 ${s.totalReps} 次` : `训练量 ${s.volumeKg} kg` }}</span>
      </li>
    </ul>

    <button v-if="hasMore && !showAll" class="more" @click="showAll = true">
      显示全部 {{ history.sessions.length }} 次
    </button>
  </template>
</template>

<style scoped>
.state {
  font-size: var(--fs-footnote);
}

.prs {
  gap: var(--gap-sm);
  align-items: stretch;
}

.pr {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  padding: var(--sp-10) var(--sp-10);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.pv {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.pk {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.pd {
  font-size: var(--fs-micro);
}

.hist {
  margin-top: var(--sp-10);
}

.hrow {
  gap: var(--gap-sm);
  padding: var(--sp-8) var(--sp-2);
  font-size: var(--fs-footnote);
}

.hist li + li {
  border-top: 0.5px solid var(--line);
}

.hdate {
  flex: none;
  width: 76px;
}

.hmain {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
}

.hvol {
  flex: none;
  /* 训练量与「最重」同单位不同量级：降一档字、交给 --text-3，别跟主读数抢 */
  font-size: var(--fs-caption);
}

.more {
  position: relative;
  margin-top: var(--sp-8);
  padding: var(--sp-8) 0;
  width: 100%;
  font-size: var(--fs-caption);
  /* 「查看更多」是次要标签文字：中性色（色彩配额，STANDARDS §4） */
  color: var(--text-2);
}

/* 实高约 32px，命中区撑到 44（竖向各 6px，落在 8px 的 margin 里，不与上方内容重叠）。
   筛选 chip 那类不这么处理 —— 它在 flex-wrap 行里，伪元素外扩会与相邻 chip 相互抢点击。 */
.more::after {
  content: '';
  position: absolute;
  inset: -6px 0;
}
</style>
