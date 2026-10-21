<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Target, Wand2 } from 'lucide-vue-next'

import PillChip from '@/components/common/PillChip.vue'
import { GOAL_LABELS } from '@/config/domain'
import { useProgramStore } from '@/stores/program'
import { courseOnDate, programStatus, reviewDue } from '@/utils/programCycle'
import { parseBlob } from '@/utils/programEngine'
import { todayStr } from '@/utils/date'

/**
 * 主页方案状态卡：方案在执行期的唯一常驻落点。
 *
 * 一行说清「什么方案、走到哪、今天做什么」，点击进方案页；
 * 距上次复盘满一周时追加「本周复盘」入口（深链到方案页自动发起）。
 * 主页从「今天该做什么」到「方案在推进什么」的这一层连接，过去只在方案页里。
 */
const router = useRouter()
const program = useProgramStore()

const parsed = computed(() => {
  if (!program.active) return null
  try {
    return parseBlob(program.active)
  } catch {
    return null /* 数据损坏时整卡退化为「打开方案页」，不阻塞主页 */
  }
})

const status = computed(() =>
  program.active && parsed.value ? programStatus(program.active, parsed.value) : null,
)

const tierLabel = computed(() =>
  program.active?.tier === 'conservative' ? '保守' : program.active?.tier === 'aggressive' ? '进取' : '均衡',
)

/**
 * 周进度（卡上主读数）与总周数（分母）——模板分两级渲染：
 * 「第 N 周」是这张卡真正要说的结论（--fs-title3 + .num），「共 N 周」退脚注档。
 * 从前目标、档位、周进度用「·」串成同一字档一行，抓不到重点。
 */
const weekOf = computed(() =>
  status.value ? { week: status.value.week, weeks: status.value.weeks } : null,
)

/** 第二行：今天做什么（或未开跑 / 已结束的状态说明） */
const todayText = computed(() => {
  const st = status.value
  const b = parsed.value
  if (!st || !b) return ''
  if (st.ended) return '本期已结束 · 生成成绩单'
  if (st.upcoming) {
    const first = courseOnDate(b, st.startDate)
    return `${st.startDate.slice(5)} 开跑${first ? ` · 首日 ${first.courseName}` : ''}`
  }
  const course = courseOnDate(b, todayStr())
  return course ? `今天 ${course.courseName} · ${course.durationMin} 分钟` : '今天休息'
})

const due = computed(() => {
  if (!program.active || !parsed.value) return false
  return reviewDue(program.active, parsed.value)
})

function open(): void {
  if (!program.active) return
  const st = status.value
  if (st?.ended) void router.push(`/program/wrapup/${program.active.id}`)
  else void router.push('/program')
}

function openReview(): void {
  void router.push({ path: '/program', query: { review: '1' } })
}
</script>

<template>
  <section v-if="program.active && status" class="card pcard" data-testid="program-card">
    <button class="main pressable" @click="open">
      <i class="ic"><Target :size="18" :stroke-width="2.2" /></i>
      <span class="col txt">
        <!-- 目标与档位是元信息：两枚小胶囊另起一行，与主读数分层 -->
        <span class="ptags">
          <PillChip tone="muted" size="sm">{{ GOAL_LABELS[program.active.goal] }}</PillChip>
          <PillChip tone="muted" size="sm">档位 · {{ tierLabel }}</PillChip>
        </span>
        <b class="pwk num">第 {{ weekOf?.week }} 周<span class="pwk-all num">共 {{ weekOf?.weeks }} 周</span></b>
        <em>{{ todayText }}</em>
      </span>
      <ChevronRight :size="15" class="chev" />
    </button>
    <!-- 到期行：出现/消失用栅格壳收高度（退出比进入快，行内不加外边距故不掺 margin） -->
    <Transition name="due">
      <div v-if="due" class="due-wrap">
        <!-- 裸壳：按钮自带 padding/border-top，直接当轨道项 0fr 收不干净 -->
        <div class="due-shell">
          <button class="due pressable" @click="openReview">
            <Wand2 :size="14" />
            <span class="grow">距上次复盘已满一周，看看数据怎么调</span>
            <b class="go">本周复盘</b>
          </button>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
/* 卡壳交给全局 .card（圆角/阴影），这里只收掉它的内边距（主行自带 13/16px）——
   带上 .card 提升特异性，不依赖样式注入顺序 */
.card.pcard {
  padding: 0;
  overflow: hidden;
}

/* 主行：图标章 + 两行文案 + chevron，与主页工具格同一套几何 */
.main {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  width: 100%;
  padding: var(--sp-12) var(--sp-16);
  text-align: left;
}

.ic {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius-full);
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.txt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-tight);
}

/* 目标 / 档位：中性小胶囊（尺寸语气在 PillChip.vue），这里只管排布 */
.ptags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-tight);
}

/* 主读数「第 N 周」：卡上唯一主档（--fs-title3 + .num）；
   「共 N 周」是分母，退到脚注档、浅一档灰 */
.pwk {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.01em;
}

.pwk .pwk-all {
  margin-left: var(--sp-6);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.txt em {
  font-style: normal;
  font-size: var(--fs-caption);
  /* --text-2：这行是「今天做什么」，属要读的信息（契约见 tokens.css） */
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chev {
  flex: none;
  color: var(--text-3);
}

/* 复盘到期行：强调色的窄条，只在满一周时出现。
   文字走 --accent-strong（accent-soft 底上的指定文字档，tokens.css:181）；
   整行是按钮，命中区补到 44 再不是一条 37px 的细边。 */
.due {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  width: 100%;
  min-height: var(--hit-min);
  padding: var(--sp-10) var(--sp-16);
  border-top: 0.5px solid var(--line);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  text-align: left;
}

.due .grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.due .go {
  flex: none;
  font-weight: var(--fw-bold);
}

/* 到期行的进出场外壳：0fr↔1fr 收高度；出现走入场时长、消失走退场时长。
   轨道项（.due-shell）保持裸壳：按钮自身的 padding/border-top 若画在轨道项上，
   折叠后会留下一截按钮内边距高的缝 */
.due-wrap {
  display: grid;
  grid-template-rows: 1fr;
}

.due-shell {
  min-height: 0;
  overflow: hidden;
}

.due-enter-active {
  transition: grid-template-rows var(--dur-base) var(--ease-standard);
}

.due-leave-active {
  transition: grid-template-rows var(--dur-fast) var(--ease-standard);
}

.due-enter-from,
.due-leave-to {
  grid-template-rows: 0fr;
}
</style>
