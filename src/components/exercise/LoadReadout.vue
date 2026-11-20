<script setup lang="ts">
import { computed } from 'vue'

import type { LoadSetup } from '@/types/load'
import { readLoad } from '@/utils/loadBasis'

/**
 * 口径读数：把「40」读成「每侧 20 kg（合计 40）」。
 *
 * 存在的问题是**同一个数字在不同器械上是不同物理量**：挂片机的 40 是每侧、插片机是插销读数、
 * 杠铃是含杠总重、哑铃是每只、助力机是减重。所以任何显示重量的地方都不该只给「40 kg」，
 * 而应由本组件统一出「数字 + 单位 + 灰字副标」。
 *
 * 三条纪律（`docs/design/weight-load-basis.md` §2.3）：
 *  1. 主数字是**操作数**（到器械前要做的那个数），单位直接带口径（`kg/侧`、`kg/只`）；
 *  2. 合计 / 含杠 / 档位只当副标，**永远不做第二个大字号 kg**；
 *  3. `basis = null`（计时 / 有氧 / 拉伸）不显示任何重量。
 *
 * 尺寸：`inline` 继承上下文（表格行、句子中）；`sm / md / lg` 用于卡片主数字。
 * 颜色：数值一律中性色（色彩配额，STANDARDS §4），只有徽标可以是 soft 底。
 */
const props = withDefaults(
  defineProps<{
    kg: number | null
    setup: LoadSetup
    size?: 'inline' | 'sm' | 'md' | 'lg'
    /** 显示灰字副标（合计 / 含杠 / 档位） */
    showSub?: boolean
    /** 显示读法徽标（每侧 / 读数 / 含杠…），密集列表用 */
    showChip?: boolean
  }>(),
  { size: 'inline', showSub: false, showChip: false },
)

const read = computed(() => readLoad(props.kg, props.setup))
</script>

<template>
  <span class="lread" :class="size">
    <span class="v num">{{ read.main }}<i v-if="read.unit" class="u">{{ read.unit }}</i></span>
    <span v-if="showChip && read.chip" class="chip">{{ read.chip }}</span>
    <span v-if="showSub && read.sub" class="sub">{{ read.sub }}</span>
  </span>
</template>

<style scoped>
.lread {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-6);
  min-width: 0;
}

.v {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 单位带口径本身（kg/侧、kg/只）：比数字小一档，比正文轻一档 */
.u {
  font-style: normal;
  margin-left: 1px;
  font-size: 0.72em;
  color: var(--text-2);
  font-weight: var(--fw-medium);
}

/* 徽标：类型字章，色相留在 soft 底上，文字走中性色 */
.chip {
  flex: none;
  padding: 1px var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  line-height: 1.6;
}

/* 副标：只能在这里出现第二个数字（合计 / 含杠 / 档位），且永远是灰字 */
.sub {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.inline {
  font-size: inherit;
}

.sm .v {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.md .v {
  font-size: var(--fs-title3);
  font-weight: var(--fw-semibold);
}

.lg {
  flex-wrap: wrap;
}

.lg .v {
  font-size: var(--fs-display-l);
  font-weight: var(--fw-bold);
  letter-spacing: -1.4px;
  line-height: 1.05;
}

.lg .u {
  font-size: 0.42em;
  letter-spacing: 0;
}

.lg .sub {
  flex-basis: 100%;
  font-size: var(--fs-caption);
}
</style>
