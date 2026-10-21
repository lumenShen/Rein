<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ActionSheet from '@/components/common/ActionSheet.vue'
import { categoriesOf, categoryOf, fmtCents } from '@/config/ledger'
import { useToast } from '@/composables/useToast'
import { useLedgerStore } from '@/stores/ledger'
import { addDays, fmtDateCn, todayStr } from '@/utils/date'
import type { LedgerEntry, LedgerKind } from '@/types'
import type { LedgerCategory } from '@/config/ledger'

/** 记一笔 / 编辑账目：分类宫格 + 数字键盘 + 日期 + 备注（编辑态附加删除）。 */
const props = defineProps<{
  open: boolean
  /** 传入 = 编辑；null = 新增 */
  entry: LedgerEntry | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useLedgerStore()
const toast = useToast()

const kind = ref<LedgerKind>('expense')
const category = ref('food')
const amountStr = ref('')
const note = ref('')
const date = ref(todayStr())

const editing = computed(() => props.entry)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.entry) {
      kind.value = props.entry.kind
      category.value = props.entry.category
      amountStr.value = fmtCents(props.entry.amountCents)
      note.value = props.entry.note ?? ''
      date.value = props.entry.date
    } else {
      kind.value = 'expense'
      category.value = categoriesOf('expense')[0]!.key
      amountStr.value = ''
      note.value = ''
      date.value = todayStr()
    }
  },
)

const grid = computed(() => categoriesOf(kind.value))

/* ---------------- 最近分类 ----------------
 * 「记一笔」是全 app 最高频的动作，而支出宫格有 10 格 —— 第一个决策点平铺 10 个选项
 * 已超出工作记忆上限，高频用户每次都从头找同一格。这里把最近用过的 4 个分类
 * 提到宫格上方一行（additive：宫格原样保留，一行只是捷径，不是替换）。
 * 存储键：`rein.ledgerRecentCats.v1`（key 数组，最多 4 个、最新在前、同一 key 去重）。
 * 写入时机：每次成功保存之后（新增与编辑都记，支出与收入都记）。
 */

const RECENT_KEY = 'rein.ledgerRecentCats.v1'
const RECENT_MAX = 4

function readRecentCats(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(list)) return []
    // 分类表改版后旧 key 可能已不存在：存的时候就过滤掉，别在横条上渲染空气
    return list.filter((x): x is string => typeof x === 'string' && categoryOf(x) !== undefined).slice(0, RECENT_MAX)
  } catch {
    // 隐私模式下 localStorage 读写会抛：没有横条照样能记账，不该因此崩
    return []
  }
}

const recentKeys = ref<string[]>(readRecentCats())

/** 记一次使用：顶到最前、去重、只留最近 4 个 */
function pushRecentCat(key: string): void {
  if (!key) return
  const next = [key, ...recentKeys.value.filter((k) => k !== key)].slice(0, RECENT_MAX)
  recentKeys.value = next
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 本地存储不可用时只丢历史，不影响本次记账 */
  }
}

/** 横条只显示**当前 kind 宫格里存在**的分类（换支出/收入时跨类的记录不出现） */
const recentCats = computed<LedgerCategory[]>(() => {
  const inGrid = new Set(grid.value.map((c) => c.key))
  return recentKeys.value
    .map((k) => categoryOf(k))
    .filter((c): c is LedgerCategory => c !== undefined && inGrid.has(c.key))
})

function switchKind(k: string): void {
  kind.value = k as LedgerKind
  category.value = categoriesOf(kind.value)[0]!.key
}

const displayAmount = computed(() => (amountStr.value === '' ? '0' : amountStr.value))

function onKey(d: string): void {
  if (d === 'back') {
    amountStr.value = amountStr.value.slice(0, -1)
    return
  }
  if (d === '.') {
    if (amountStr.value.includes('.')) return
    amountStr.value = amountStr.value === '' ? '0.' : `${amountStr.value}.`
    return
  }
  // 整数位最多 7 位、小数最多 2 位
  if (amountStr.value.length >= 10 && !amountStr.value.includes('.')) return
  if (amountStr.value.includes('.') && amountStr.value.split('.')[1]!.length >= 2) return
  if (amountStr.value === '0') amountStr.value = d
  else amountStr.value += d
}

const amountCents = computed(() => Math.round(Number.parseFloat(amountStr.value || '0') * 100))
const canSave = computed(() => amountCents.value > 0 && category.value !== '' && !saving.value)
const saving = ref(false)
const title = computed(() => (editing.value ? '编辑账目' : '记一笔'))

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const input = {
      kind: kind.value,
      category: category.value,
      amountCents: amountCents.value,
      note: note.value.trim() === '' ? null : note.value.trim(),
      date: date.value,
    }
    if (editing.value) {
      await store.update({ ...editing.value, ...input })
      toast.toast('已更新')
    } else {
      await store.create(input)
      toast.toast('已记一笔')
    }
    // 记账成功才记「最近」：保存失败（离线/引擎报错）的分类不该占位
    pushRecentCat(category.value)
    emit('saved')
    emit('close')
  } finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  if (!editing.value) return
  await store.remove(editing.value.id)
  toast.toast('已删除')
  emit('saved')
  emit('close')
}

/* 删除是破坏性操作：先经 ActionSheet 确认 */
const confirmDel = ref(false)

async function onConfirmDelete(value: string): Promise<void> {
  if (value !== 'delete') return
  await remove()
}
</script>

<template>
  <SheetModal :open="open" :title="title" @close="emit('close')">
    <div class="form">
      <SegmentedControl
        :model-value="kind"
        class="seg"
        :options="[
          { value: 'expense', label: '支出' },
          { value: 'income', label: '收入' },
        ]"
        @update:model-value="switchKind"
      />

      <!-- 最近分类：只用最近用过的 4 个，横向一排；没有历史时整行不渲染 -->
      <div v-if="recentCats.length" class="recent">
        <span class="recent-tag">最近</span>
        <button
          v-for="c in recentCats"
          :key="c.key"
          type="button"
          class="cat recent-cat"
          :class="{ on: category === c.key }"
          @click="category = c.key"
        >
          <i :style="{ background: c.colorVar }">
            <component :is="c.icon" :size="18" :stroke-width="2" />
          </i>
          <span>{{ c.label }}</span>
        </button>
      </div>

      <!-- 分类宫格 -->
      <div class="cats">
        <button
          v-for="c in grid"
          :key="c.key"
          type="button"
          class="cat"
          :class="{ on: category === c.key }"
          @click="category = c.key"
        >
          <i :style="{ background: c.colorVar }">
            <component :is="c.icon" :size="20" :stroke-width="2" />
          </i>
          <span>{{ c.label }}</span>
        </button>
      </div>

      <div class="row between">
        <div class="amount">
          <em>¥</em>
          <b class="num">{{ displayAmount }}</b>
        </div>
        <div class="date">
          <button class="chip" :class="{ on: date === todayStr() }" @click="date = todayStr()">今天</button>
          <button class="chip" :class="{ on: date === addDays(todayStr(), -1) }" @click="date = addDays(todayStr(), -1)">
            昨天
          </button>
          <label class="chip date-chip" :class="{ on: date !== todayStr() && date !== addDays(todayStr(), -1) }">
            {{ date !== todayStr() && date !== addDays(todayStr(), -1) ? fmtDateCn(date) : '自定义' }}
            <input v-model="date" type="date" class="date-input" />
          </label>
        </div>
      </div>

      <!-- 数字键盘 -->
      <div class="keypad">
        <button v-for="k in ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back']" :key="k" type="button" class="key" :class="{ fn: k === 'back' }" :aria-label="k === 'back' ? '退格' : `数字 ${k}`" @click="onKey(k)">
          <span v-if="k === 'back'">⌫</span>
          <span v-else>{{ k }}</span>
        </button>
      </div>

      <input v-model="note" class="note" type="text" placeholder="备注（可选，如 午餐、房租）" />

      <div class="row between actions">
        <button v-if="editing" type="button" class="danger" aria-label="删除该账目" @click="confirmDel = true">
          <Trash2 :size="17" /> 删除
        </button>
        <span v-else class="empty" />
        <button type="button" class="save" :disabled="!canSave" @click="save">保存</button>
      </div>
    </div>

    <ActionSheet
      :open="confirmDel"
      title="删除后这笔账目从账本与月度统计中移除，无法恢复"
      :actions="[{ label: '删除', value: 'delete', danger: true }]"
      @select="onConfirmDelete"
      @close="confirmDel = false"
    />
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.seg {
  width: 100%;
}

.cats {
  display: grid;
  /* 分类磁贴：行距 12（两行要分开）、列距 6（五列在窄宽下要挤） */
  grid-template-columns: repeat(5, 1fr);
  gap: var(--gap-md) var(--sp-6);
}

.cat {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 圆章与名称：4；磁贴上下留 2/4（按压底色不贴字） */
  gap: var(--gap-tight);
  padding: var(--gap-text) 0 var(--gap-tight);
  border-radius: var(--radius-m);
  /* 分类磁贴的名字（「餐饮」）是要读的字段名，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.cat:active {
  background: var(--surface-2);
}

.cat i {
  width: 42px;
  height: 42px;
  /* 正圆走 --radius-full，不写裸 50% */
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cat.on i {
  transform: scale(1.08);
  box-shadow: 0 0 0 3px var(--surface), 0 0 0 6px var(--line-strong);
}

.cat.on span {
  color: var(--text-1);
}

/* 「最近」行：分类格同一套语言，只把视觉重量降一档（图标 42→30、标签更紧），
   横向铺开不换行；窄屏放 4 枚也够。 */
.recent {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.recent-tag {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  /* 「最近」是这一行的字段名，要读 → --text-2 */
  color: var(--text-2);
}

.recent-cat {
  flex: 1 1 0;
  /* 别让单个历史项被拉成通栏一行：上限 88px，剩下的空间留在行尾 */
  max-width: 88px;
  min-width: 0;
  gap: var(--gap-tight);
  padding: 0;
}

.recent-cat i {
  width: 30px;
  height: 30px;
}

.amount {
  display: flex;
  align-items: baseline;
  /* 货币符号与大数字：同一行最小呼吸 2 */
  gap: var(--gap-text);
  padding: var(--sp-6) 0;
}

.amount em {
  font-style: normal;
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

.amount b {
  font-size: var(--fs-large-title);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
}

.date {
  display: flex;
  gap: var(--sp-6);
  align-items: center;
}

.chip {
  position: relative;
  /* 胶囊：纵向 6 + 12 字 ≈ 30（--control-sm 28 之上一点，视觉不动），左右 12 */
  padding: var(--sp-6) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 今天 / 昨天 / 自定义是三个并排的日期选择：视觉 30，热区竖向各扩 8 → 46。
   横向不扩（三个之间只有 6，横向扩会互相压住）。 */
.chip::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-8)) 0;
}

/* 选中态：soft 底上的文字走 --accent-strong（tokens.css 的语义色契约 / STANDARDS §4）。 */
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.date-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.date-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
}

.keypad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  /* 九宫格键位：6 的缝让每格读成独立按键，又不至于散开 */
  gap: var(--sp-6);
}

.key {
  height: 44px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-title3);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.key:active {
  background: var(--line-strong);
}

.key.fn {
  font-size: var(--fs-headline);
  color: var(--text-2);
}

.note {
  /* 备注输入：上下 10（40 档）、左右 16 */
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-body);
  color: var(--text-1);
}

.note::placeholder {
  color: var(--text-3);
}

.actions {
  margin-top: var(--gap-text);
}

.empty {
  flex: 1;
}

.danger {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 删除是破坏性操作：danger-soft 底上的文字走 --danger-strong，
     实底档 --danger 落在这层 soft 底上对比度不够（tokens.css 的语义色契约 / STANDARDS §4） */
  padding: var(--sp-10) var(--sp-18);
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.save {
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
