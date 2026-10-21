<script setup lang="ts">
import { computed } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import { useDietStore } from '@/stores/diet'

/** 今日建议打卡：按食物类别检查六大类覆盖情况（膳食指南多样性建议）。 */
const diet = useDietStore()

const CHECKS = [
  { label: '主食', cats: ['主食'] },
  { label: '优质蛋白', cats: ['肉蛋', '水产', '豆制品'] },
  { label: '蔬菜', cats: ['蔬菜'] },
  { label: '水果', cats: ['水果'] },
  { label: '奶制品', cats: ['奶类'] },
  { label: '坚果', cats: ['坚果'] },
] as const

const checks = computed(() =>
  CHECKS.map((c) => ({
    ...c,
    // as const 元组的 includes 参数是字面量类型，需放宽到 string 才能传入类别
    done: diet.meals.some((m) => m.food && (c.cats as readonly string[]).includes(m.food!.category ?? '')),
  })),
)

const doneCount = computed(() => checks.value.filter((c) => c.done).length)
</script>

<template>
  <section class="card">
    <header class="head row between">
      <div>
        <h2>今日建议打卡</h2>
        <p class="t-3">六大类食物 · 尽量每日覆盖</p>
      </div>
      <!-- 判类口径与「为什么六类」收进标题行右端的说明入口，卡面只留副标题一行结论 -->
      <div class="head-side">
        <InfoHint
          title="今日建议打卡"
          content="打卡按类别判断当天吃没吃过：主食、优质蛋白、蔬菜、水果、奶制品、坚果各算一类，右边的计数就是吃到的类数。

依据是膳食指南的食物多样性建议 —— 一天里尽量六类都吃到，长期这样营养结构更均衡；不看过量，也不要求一顿吃齐。"
        />
        <span class="num count">{{ doneCount }}<em>/{{ checks.length }}</em></span>
      </div>
    </header>

    <ul class="checks">
      <li v-for="c in checks" :key="c.label" class="chip" :class="{ done: c.done }">
        <span class="mark">{{ c.done ? '✓' : '' }}</span>{{ c.label }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.head p {
  font-size: var(--fs-caption);
  /* 标题与副标题之间是主次文本的 2（--gap-text） */
  margin-top: var(--gap-text);
}

/* 标题行右端：说明入口 + x/6 计数 */
.head-side {
  display: flex;
  align-items: center;
  /* 说明入口与 x/6 计数是一组无边界控件：8 */
  gap: var(--gap-sm);
}

.count {
  font-size: var(--fs-title2);
  font-weight: var(--fw-light);
  color: var(--text-1);
  letter-spacing: -0.5px;
}

.count em {
  font-style: normal;
  font-size: var(--fs-subhead);
  color: var(--text-3);
  /* 分母紧贴分子，1px 无可读差异，归零 */
  margin-left: 0;
}

/* 打卡 */
.checks {
  display: flex;
  flex-wrap: wrap;
  /* 打卡胶囊是一组无边界控件：组内 8、与上方标题行之间 12（卡内区块） */
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

.chip {
  display: flex;
  align-items: center;
  /* 勾选标记与类别名之间取 4：它是同一行内最小呼吸 */
  gap: var(--gap-tight);
  /* 静态标签（不可点）走小胶囊档：高 24（--chip-h）、左右 12。
     此前 6 上下撑到 28，与筛选页里「可点的 32」混成一档。 */
  min-height: var(--chip-h);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  transition: background-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard);
}

.chip .mark {
  display: inline-flex;
  width: 15px;
  justify-content: center;
  font-size: var(--fs-micro);
}

/* 完成态：色相只留在勾选标记上（施工单 §1「色相只出现在图标/色点/…」）。
   此前整颗胶囊的字都用 --ok-strong，六颗绿字并排会盖过右侧 5/6 这个真正的结论；
   现在底仍是 ok 浅井（表示「这一类已覆盖」），文字回中性、勾子保留绿色。 */
.chip.done {
  background: var(--ok-soft);
  color: var(--text-1);
}

.chip.done .mark {
  color: var(--ok-strong);
}
</style>
