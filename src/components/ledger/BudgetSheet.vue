<script setup lang="ts">
import { ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { fmtCents } from '@/config/ledger'
import { useToast } from '@/composables/useToast'
import { useLedgerStore } from '@/stores/ledger'

/** 月度总预算设置：快捷金额 + 自定义输入 + 清除预算。 */
defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useLedgerStore()
const toast = useToast()

const PRESETS = [2000, 3000, 5000, 8000]

const val = ref('')

watch(
  () => store.settings,
  (s) => {
    val.value = s && s.monthlyBudgetCents > 0 ? fmtCents(s.monthlyBudgetCents) : ''
  },
  { immediate: true },
)

const cents = (): number => {
  const n = Number.parseFloat(val.value || '0')
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

async function save(): Promise<void> {
  const c = cents()
  if (c <= 0) return
  await store.setBudget(c)
  toast.toast('预算已更新')
  emit('saved')
  emit('close')
}

async function clear(): Promise<void> {
  await store.setBudget(0)
  toast.toast('已清除预算')
  emit('saved')
  emit('close')
}
</script>

<template>
  <SheetModal :open="open" title="月度预算" @close="emit('close')">
    <div class="form">
      <label class="input-wrap">
        <span class="cur">¥</span>
        <input
          v-model="val"
          class="num"
          type="text"
          inputmode="decimal"
          placeholder="如 3000"
          aria-label="输入月度预算"
        />
        <!-- 货币只在一处说清：左边「¥」+ 右边「/ 月」，placeholder 让位给示例 -->
        <span class="unit">/ 月</span>
      </label>

      <div class="presets">
        <button
          v-for="p in PRESETS"
          :key="p"
          type="button"
          class="chip num"
          :class="{ on: String(p) === val }"
          @click="val = String(p)"
        >
          ¥{{ p }}
        </button>
      </div>

      <div class="row between actions">
        <StatusChip
          v-if="store.settings && store.settings.monthlyBudgetCents > 0"
          as="button"
          tone="danger"
          size="md"
          class="clear"
          @click="clear"
        >
          清除预算
        </StatusChip>
        <span v-else />
        <button type="button" class="save" :disabled="cents() <= 0" @click="save">保存</button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  /* 表单块之间 16：金额输入 / 预设 / 动作三块各有明显边界 */
  gap: var(--gap-lg);
}

.input-wrap {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  /* 输入框体：上下 12 托住 24px 的金额字，左右 16 */
  padding: var(--sp-12) var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.cur {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.input-wrap input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-title1);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  background: transparent;
}

.input-wrap input::placeholder {
  color: var(--text-3);
  font-weight: var(--fw-medium);
}

.unit {
  font-size: var(--fs-footnote);
  /* 「元」是金额的单位，读不出来数字就没意义 → --text-2 */
  color: var(--text-2);
}

.presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  /* 四枚预设是并列的小按钮：无边界 8 */
  gap: var(--gap-sm);
}

.chip {
  position: relative;
  /* 预设按钮高 40 档：10 上下 + 14 字（实测 41，落在 --control-md 上） */
  padding: var(--sp-10) 0;
  /* 圆角跟记账域内另外两组格状按键（分类磁贴 / 数字键盘）走同一档 16：
     只把这一处改成 20 会让同一张记账表单里出现两种按钮形状 */
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 四枚预设是并排的小按钮：视觉 41，热区竖向各扩 2 → 45（--hit-min）。
   横向不扩 —— 格间只有 8，横向扩就四块叠在一起。 */
.chip::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-2)) 0;
}

/* 选中态：soft 底上的文字走 --accent-strong（tokens.css 的语义色契约 / STANDARDS §4），
   不拿实底档 --accent 当文字色。 */
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.actions {
  margin-top: var(--gap-tight);
}

/* 清除预算是破坏性操作：语义色走 StatusChip（danger-soft 底 + danger-strong 字），
   不再拿 --text-3 让要清预算的人在最低对比档里找按钮 */
.clear {
  position: relative;
  border: 0;
  cursor: pointer;
}

/* StatusChip md 视觉 24，而它是这个抽屉里唯一的破坏性动作：
   热区竖向各扩 10 → 44（--hit-min）。横向不扩（「清除预算」本身已 72 宽），
   免得压到右侧「保存」。 */
.clear::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-10)) 0;
}

.save {
  /* 主按钮：左右 32（40 是图标钮的直径，文字按钮不必那么宽） */
  padding: var(--sp-10) var(--sp-32);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.save:disabled {
  opacity: var(--disabled-opacity);
}
</style>
