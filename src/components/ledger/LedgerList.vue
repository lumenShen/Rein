<script setup lang="ts">
import { computed } from 'vue'

import { categoryOf, fmtCents } from '@/config/ledger'
import { fmtDateCn } from '@/utils/date'
import type { LedgerEntry } from '@/types'

/** 流水列表：按日期分组，点击行进入编辑。 */
const props = defineProps<{
  entries: LedgerEntry[]
}>()

const emit = defineEmits<{ edit: [entry: LedgerEntry] }>()

interface DayGroup {
  date: string
  entries: LedgerEntry[]
  expenseCents: number
  incomeCents: number
}

const groups = computed<DayGroup[]>(() => {
  const map = new Map<string, LedgerEntry[]>()
  for (const e of props.entries) {
    const list = map.get(e.date) ?? []
    list.push(e)
    map.set(e.date, list)
  }
  return [...map.entries()].map(([date, list]) => ({
    date,
    entries: list,
    expenseCents: list.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0),
    incomeCents: list.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amountCents, 0),
  }))
})
</script>

<template>
  <ul class="list">
    <li v-for="g in groups" :key="g.date" class="day">
      <header class="dhead">
        <span class="num">{{ fmtDateCn(g.date) }}</span>
        <span class="num dmeta">
          <template v-if="g.expenseCents > 0">支出 ¥{{ fmtCents(g.expenseCents) }}</template>
          <template v-if="g.incomeCents > 0"> · 收入 ¥{{ fmtCents(g.incomeCents) }}</template>
        </span>
      </header>
      <ul class="items">
        <li v-for="e in g.entries" :key="e.id">
          <button
            class="row item"
            :aria-label="`编辑：${e.kind === 'expense' ? '支出' : '收入'} ${categoryOf(e.category)?.label ?? e.category} ¥${fmtCents(e.amountCents)}`"
            @click="emit('edit', e)"
          >
            <!-- 彩章+白图标：纯色圆点只靠色相区分分类（色弱不可辨），字形补上第二通道 -->
            <i class="ic center" :style="{ background: categoryOf(e.category)?.colorVar ?? 'var(--led-other)' }">
              <component v-if="categoryOf(e.category)?.icon" :is="categoryOf(e.category)!.icon" :size="16" />
            </i>
            <div class="flex-1 meta">
              <span class="lbl">{{ categoryOf(e.category)?.label ?? e.category }}</span>
              <span v-if="e.note" class="note">{{ e.note }}</span>
            </div>
            <b class="num amt" :class="e.kind">
              <i class="sign">{{ e.kind === 'expense' ? '−' : '+' }}</i><i class="cur">¥</i>{{ fmtCents(e.amountCents) }}
            </b>
          </button>
        </li>
      </ul>
    </li>
  </ul>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  /* 日期分组是一级区块：组与组之间 16（比行间距大一档，才读得成「另起一天」） */
  gap: var(--gap-lg);
}

.dhead {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  /* 组头与它下面的行之间 6，左右与行内文字对齐（行左右 0：列表不在卡里，
     它和上方的筛选条共用 --page-pad-x 那条竖线） */
  padding: 0 0 var(--sp-6);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.dmeta {
  font-weight: var(--fw-medium);
  /* 当日支出 / 收入是这条流水的日汇总，要读 → --text-2（--text-3 是「补充，不是正文」，
     而这行数字在本页没有第二处出处） */
  color: var(--text-2);
  font-size: var(--fs-caption);
}

.items {
  display: flex;
  flex-direction: column;
}

.items > li + li {
  border-top: 0.5px solid var(--line);
}

.item {
  width: 100%;
  /* 彩章 / 分类名 / 金额三列：12（列间要读得清归属），
     也是列表规范里「右侧元素与中间内容 12vp」那一条 */
  gap: var(--gap-md);
  /* 双行流水平（分类名 + 备注）：行高走 64 档（--row-h-double，列表规范 48/56/64/72/96）。
     原来靠 12+12+34 彩章撑到 58 —— 不在任何一档上，且换行/无备注时高度会跟着抖。 */
  min-height: var(--row-h-double);
  padding: var(--sp-8) 0;
  text-align: left;
}

.ic {
  display: flex;
  width: 34px;
  height: 34px;
  flex: none;
  /* 正圆走 --radius-full，不写裸 50% */
  border-radius: var(--radius-full);
  color: var(--on-accent);
}

.meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 分类名与备注：主次文本上下 2 */
  gap: var(--gap-text);
}

.lbl {
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.note {
  font-size: var(--fs-footnote);
  /* 备注是识别这笔钱花在哪的第二依据（「午餐 + 咖啡」），不是脚注 → --text-2；
     原来的 --text-3 在 12px 上只有约 3:1，暗色里更糊 */
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.amt {
  /* 金额是这一行的核心读数（分类名只是归属）：升到 Body_L 16 半粗，
     比左侧 14 的分类名重一档，扫一列金额时先读到的是数字 */
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  /* 金额右对齐 + 等宽（.num 已在模板里给）：一列金额的末位必须成线，
     上下扫的时候差值一秒读出来 */
  text-align: right;
  /* 一个金额串不折行：「−¥12,345.67」拆成两行就等于读错 */
  white-space: nowrap;
  color: var(--text-1);
}

/* 正负号与币种符号降一档（12 / medium / 次档灰）：它们是语义与量纲，
   不是第二位读数。此前「−¥32.5」五个字符同粗，一眼读不出主数字从哪开始。 */
.amt .sign,
.amt .cur {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.amt .cur {
  margin-right: var(--gap-text);
}

/* 收入与支出同色：色彩配额里金额是**数值**（STANDARDS §4），一律 --text-1；
   区分收支靠正负号（− / +），不靠色相。 */
.amt.income {
  color: var(--text-1);
}
</style>
