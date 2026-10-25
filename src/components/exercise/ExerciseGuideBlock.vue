<script setup lang="ts">
import { computed } from 'vue'

import type { ExerciseGuide } from '@/config/exerciseGuide'

/**
 * 动作详解 · 三段式教学块（准备 / 轨迹 / 注意）。
 *
 * 为什么按三段切而不是一段话：组间休息只有几十秒，用户需要的是「现在该摆哪里」
 * 这一层信息，不是完整教程。三段各有固定的颜色语义（准备=蓝、轨迹=运动橙、
 * 注意=红），但**颜色只落在色点与细条上**，正文一律 --text-1/2 —— 彩字压彩底
 * 永远到不了 4.5:1（STANDARDS §4）。
 * 准备档的蓝写死 --accent-base：它是**教学语义**，不能被模块页的 data-tone 染成橙色
 * （否则准备与轨迹同色）。轨迹才属于运动身份；注意用 --danger-strong 与轨迹拉开色相。
 *
 * 两档密度：
 *   full    详情抽屉顶部：三条准备带序号、轨迹两行带箭头、注意两条带竖条
 *   compact 沉浸页（热身 / 做组 / 组间休息）：准备压成紧凑三行、轨迹合成一行、
 *           注意只留一句 —— 它的作用是「抬头就能看见」，不是替代详情
 */
const props = withDefaults(
  defineProps<{
    guide: ExerciseGuide
    density?: 'full' | 'compact'
  }>(),
  { density: 'full' },
)

const isFull = computed(() => props.density === 'full')
const cautions = computed(() => (isFull.value ? props.guide.cautions : props.guide.cautions.slice(0, 1)))
</script>

<template>
  <div class="guide" :class="density">
    <!-- 准备：三条固定顺序（摆位 → 躯干 → 呼吸/绷紧） -->
    <section class="seg">
      <p class="segh"><i class="dot prep" aria-hidden="true" />准备</p>
      <ol class="steps">
        <li v-for="(t, i) in guide.setup" :key="i">
          <span class="n num" aria-hidden="true">{{ i + 1 }}</span>
          <span class="t">{{ t }}</span>
        </li>
      </ol>
    </section>

    <!-- 轨迹：开始 → 结束。紧凑档合成一行，箭头保留（轨迹的方向感全靠它） -->
    <section class="seg">
      <p class="segh"><i class="dot move" aria-hidden="true" />开始 · 结束</p>
      <div class="motion">
        <p class="mline">
          <span class="mk">开始</span>
          <span class="t">{{ guide.start }}</span>
        </p>
        <i class="arrow" aria-hidden="true" />
        <p class="mline">
          <span class="mk">结束</span>
          <span class="t">{{ guide.end }}</span>
        </p>
      </div>
    </section>

    <!-- 注意：这两条是这个动作最容易出错的地方 -->
    <section v-if="cautions.length" class="seg">
      <p class="segh"><i class="dot care" aria-hidden="true" />注意</p>
      <ul class="cares">
        <li v-for="(t, i) in cautions" :key="i">{{ t }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.guide {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

/* 紧凑档的分段间距要收一档：它嵌在沉浸页的滚动态里，不是独立抽屉 */
.guide.compact {
  gap: var(--gap-sm);
}

.segh {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  letter-spacing: 0.3px;
  color: var(--text-3);
}

/* 色点：语义只在这一枚 6px 圆点上 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.dot.prep {
  background: var(--accent-base);
}

.dot.move {
  background: var(--c-exercise-deep);
}

.dot.care {
  background: var(--danger-strong);
}

/* 准备：序号 + 正文。序号是「摆位/躯干/呼吸」的固定次序，不是装饰 */
.steps {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
}

.steps li {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
}

.n {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  line-height: 18px;
  text-align: center;
}

.t {
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-1);
}

.compact .t {
  font-size: var(--fs-caption);
}

/* 轨迹：开始 → 结束 竖排，中间一条短竖线（方向从上到下） */
.motion {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  margin-top: var(--gap-sm);
}

.mline {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
}

/* 行首标记固定 32 宽：两行的正文才能对齐到同一个左边缘 */
.mk {
  flex: none;
  width: 32px;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  color: var(--text-3);
  line-height: var(--lh-body);
}

/* 两行之间的竖线：缩进对齐正文（32 + 8），不画满整行 */
.arrow {
  width: 1.5px;
  height: var(--sp-8);
  margin-left: calc(32px + var(--gap-sm));
  border-radius: var(--radius-xs);
  background: var(--line);
}

/* 注意：左侧竖条 + 中性正文 */
.cares {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  margin-top: var(--gap-sm);
}

.cares li {
  position: relative;
  padding-left: var(--sp-12);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.cares li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 4px;
  width: 2px;
  border-radius: var(--radius-xs);
  background: var(--danger-strong);
  opacity: 0.55;
}
</style>
