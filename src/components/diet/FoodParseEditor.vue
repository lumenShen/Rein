<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Pencil, Repeat2, Search, Trash2 } from 'lucide-vue-next'

import PillChip from '@/components/common/PillChip.vue'
import FoodPickerSheet from '@/components/diet/FoodPickerSheet.vue'
import { dietService } from '@/services/dietService'
import type { Food, ParsedFoodItem } from '@/types'

/**
 * 可编辑食物解析列表：行内改重量（含常见份单位快捷换算）、改名（识别错别字/
 * 想标注场景如「拿铁大杯」）、从食物库匹配/换食物（识别错食物时人工纠正）、
 * 删除条目。聊天里的解析卡与拍照识别弹层共用；条目对象原地修改（引用稳定），
 * 每次变更 shallow-clone 数组向上通知，由父级决定持久化时机。
 */
const props = defineProps<{ modelValue: ParsedFoodItem[] }>()
const emit = defineEmits<{
  'update:modelValue': [ParsedFoodItem[]]
  /** 条目/重量/匹配变化时汇报汇总（父级展示总热量与可写入数） */
  change: [{ totalKcal: number; total: number; matched: number }]
}>()

/* ---- 食物详情缓存（每100g营养素 + 常用份单位），跨实例复用 ---- */
const foodCache = ref(new Map<number, Food>())

watch(
  () => props.modelValue.map((it) => it.foodId).join(','),
  async () => {
    for (const id of props.modelValue.map((it) => it.foodId)) {
      if (id == null || foodCache.value.has(id)) continue
      const f = await dietService.getFood(id)
      if (f) foodCache.value.set(id, f)
    }
  },
  { immediate: true },
)

/** 未匹配项的热量换算基准：首次出现时的克重（估算值按编辑比例缩放） */
const baseGrams = new WeakMap<object, number>()

/* 行身份：条目对象原地修改、数组浅拷贝，引用即稳定身份；
   用索引作 key 会在删除中间行时让后续行的编辑态/焦点串位 */
const uids = new WeakMap<object, number>()
let uidSeq = 0
function keyOf(it: ParsedFoodItem): number {
  let k = uids.get(it)
  if (k == null) {
    uidSeq += 1
    k = uidSeq
    uids.set(it, k)
  }
  return k
}
function baseline(it: ParsedFoodItem): number {
  let b = baseGrams.get(it)
  if (b == null) {
    b = it.grams > 0 ? it.grams : 1
    baseGrams.set(it, b)
  }
  return b
}

function kcalOf(it: ParsedFoodItem): number {
  const f = it.foodId != null ? foodCache.value.get(it.foodId) : undefined
  if (f) return Math.round((f.kcal * it.grams) / 100)
  return Math.round((it.kcalEstimate * it.grams) / baseline(it))
}

/** 汇总上报：克重、条目数或营养缓存变化时重算 */
function emitStats(): void {
  let totalKcal = 0
  let matched = 0
  for (const it of props.modelValue) {
    totalKcal += kcalOf(it)
    if (it.foodId != null) matched++
  }
  emit('change', { totalKcal, total: props.modelValue.length, matched })
}

watch(
  [
    () => props.modelValue.length,
    () => props.modelValue.map((it) => it.grams).join(','),
    () => props.modelValue.map((it) => it.foodId).join(','),
    () => foodCache.value.size,
  ],
  emitStats,
  { immediate: true },
)

/** 已匹配项的三大宏量（按当前克重折算）：行内次要读数，未匹配项没有库数据返回空 */
function macroChips(it: ParsedFoodItem): { label: string; text: string }[] {
  const f = it.foodId != null ? foodCache.value.get(it.foodId) : undefined
  if (!f) return []
  const k = it.grams / 100
  return [
    { label: '蛋白', text: `${Math.round(f.protein * k)}g` },
    { label: '碳水', text: `${Math.round(f.carb * k)}g` },
    { label: '脂肪', text: `${Math.round(f.fat * k)}g` },
  ]
}

/** AI 认错名字、用户改过名时：说明这一行实际匹配到库里的哪个食物（名字行右侧胶囊） */
function matchNote(it: ParsedFoodItem): string | null {
  const f = it.foodId != null ? foodCache.value.get(it.foodId) : undefined
  return f && f.name !== it.foodName ? `匹配「${f.name}」` : null
}

/** 常用份单位快捷按钮：点一下按「一份」的克重设置 */
function unitOptions(it: ParsedFoodItem): { label: string; grams: number }[] {
  const f = it.foodId != null ? foodCache.value.get(it.foodId) : undefined
  return (f?.units ?? []).slice(0, 4).map((u) => ({ label: `1${u.name}=${Math.round(u.grams)}g`, grams: Math.round(u.grams) }))
}

/* ---- 行内重量编辑 ---- */
const editIndex = ref<number | null>(null)
const draftVal = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

/** 函数式 ref：v-for 里的字符串 ref 会被收集成数组，这里确保拿到单个元素 */
function setInputEl(el: unknown): void {
  inputEl.value = el instanceof HTMLInputElement ? el : null
}

function beginEdit(i: number): void {
  if (editIndex.value === i) return
  editIndex.value = i
  draftVal.value = String(Math.round(props.modelValue[i]?.grams ?? 0))
  void nextTick(() => {
    inputEl.value?.focus()
    inputEl.value?.select()
  })
}

function commitEdit(): void {
  const i = editIndex.value
  if (i == null) return
  const it = props.modelValue[i]
  const v = Math.round(Number(draftVal.value))
  if (it && Number.isFinite(v) && v > 0 && v !== it.grams) {
    it.grams = v
    emit('update:modelValue', [...props.modelValue])
  }
  editIndex.value = null
}

function cancelEdit(): void {
  editIndex.value = null
}

function applyUnit(it: ParsedFoodItem, grams: number): void {
  if (grams > 0 && grams !== it.grams) {
    it.grams = grams
    emit('update:modelValue', [...props.modelValue])
  }
  editIndex.value = null
}

function removeRow(i: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, idx) => idx !== i),
  )
}

/* ---- 行内改名（识别名是 AI 猜的，允许直接改字） ---- */
const editNameIndex = ref<number | null>(null)
const draftName = ref('')
const nameEl = ref<HTMLInputElement | null>(null)

function setNameEl(el: unknown): void {
  nameEl.value = el instanceof HTMLInputElement ? el : null
}

function beginRename(i: number): void {
  if (editNameIndex.value === i) return
  editNameIndex.value = i
  draftName.value = props.modelValue[i]?.foodName ?? ''
  void nextTick(() => {
    nameEl.value?.focus()
    nameEl.value?.select()
  })
}

function commitRename(): void {
  const i = editNameIndex.value
  if (i == null) return
  const it = props.modelValue[i]
  const v = draftName.value.trim()
  if (it && v && v !== it.foodName) {
    it.foodName = v
    emit('update:modelValue', [...props.modelValue])
  }
  editNameIndex.value = null
}

/* ---- 从食物库匹配 / 换一个（识别错食物时人工纠正；选中即回传不落库） ---- */
const pickIndex = ref<number | null>(null)
const pickerOpen = ref(false)

function openPicker(i: number): void {
  pickIndex.value = i
  pickerOpen.value = true
}

function onPicked(f: Food): void {
  const it = pickIndex.value != null ? props.modelValue[pickIndex.value] : null
  if (it) {
    it.foodId = f.id
    emit('update:modelValue', [...props.modelValue])
  }
  pickIndex.value = null
}
</script>

<template>
  <div>
    <TransitionGroup tag="ul" name="fprl" class="fpl">
      <li v-for="(it, i) in modelValue" :key="keyOf(it)" class="fpr" :class="{ miss: it.foodId == null }">
        <div class="info flex-1" @click="beginEdit(i)">
          <p class="name">
            <button
              v-if="editNameIndex !== i"
              class="name-btn"
              :aria-label="`改名 ${it.foodName}`"
              @click.stop="beginRename(i)"
            >
              <span class="name-text">{{ it.foodName }}</span>
              <Pencil :size="10" class="name-pen" />
            </button>
            <input
              v-else
              :ref="setNameEl"
              v-model="draftName"
              type="text"
              aria-label="食物名称"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="editNameIndex = null"
              @blur="commitRename"
            >
            <PillChip v-if="matchNote(it)" size="sm" class="mnote">{{ matchNote(it) }}</PillChip>
            <span v-if="it.foodId == null" class="tag">未匹配</span>
            <button
              v-else
              class="rematch"
              aria-label="换一个食物"
              @click.stop="openPicker(i)"
            >
              <Repeat2 :size="11" /> 换
            </button>
          </p>
          <!-- 热量是这一行的主数值；蛋白/碳水/脂肪降为次要读数（未匹配项只留「确认时不会写入」） -->
          <p class="macro">
            <b class="mk num">≈{{ kcalOf(it) }} 大卡</b>
            <span v-if="it.foodId == null" class="mm">确认时不会写入</span>
            <template v-else>
              <span v-for="m in macroChips(it)" :key="m.label" class="mm">{{ m.label }} {{ m.text }}</span>
            </template>
          </p>
          <button v-if="it.foodId == null" class="golink" @click.stop="openPicker(i)">
            <Search :size="11" /> 从食物库匹配
          </button>
          <div class="units-wrap" :class="{ open: editIndex === i && unitOptions(it).length > 0 }">
            <div v-if="editIndex === i && unitOptions(it).length > 0" class="units">
              <button
                v-for="u in unitOptions(it)"
                :key="u.label"
                class="unit"
                @click.stop="applyUnit(it, u.grams)"
              >
                {{ u.label }}
              </button>
            </div>
          </div>
        </div>

        <div class="weight">
          <input
            v-if="editIndex === i"
            :ref="setInputEl"
            v-model="draftVal"
            type="number"
            inputmode="decimal"
            min="1"
            aria-label="克重"
            @click.stop
            @keydown.enter.prevent="commitEdit"
            @keydown.esc.prevent="cancelEdit"
            @blur="commitEdit"
          >
          <button v-else class="chip" @click.stop="beginEdit(i)">
            {{ Math.round(it.grams) }}g
            <Pencil :size="11" />
          </button>
          <span v-if="editIndex === i" class="g-suffix">克</span>
        </div>

        <button class="del" aria-label="删除该食物" @click.stop="removeRow(i)">
          <Trash2 :size="15" />
        </button>
      </li>
    </TransitionGroup>

    <!-- 换匹配用的食物库选择（纯选择模式：点结果即回传，不写记录） -->
    <FoodPickerSheet
      :open="pickerOpen"
      title="从食物库选择"
      select-only
      @close="pickerOpen = false"
      @pick="onPicked"
    />
  </div>
</template>

<style scoped>
.fpl {
  position: relative;
  display: flex;
  flex-direction: column;
}

.fpr {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 解析行是三列（名称 / 份量 / 删除）的一整行：上下 8 + 内容 ≈ 48 档 */
  padding: var(--gap-sm) 0;
}

.fpr + .fpr {
  border-top: 0.5px solid var(--line);
}

/* 列表增删：删除折叠退场，其余行 FLIP 平滑让位；新行轻浮入 */
.fprl-move {
  transition: transform var(--dur-base) var(--ease-standard);
}

.fprl-enter-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.fprl-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.fprl-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  transform-origin: top center;
  pointer-events: none; /* 退场期间压在兄弟行上方，不许再被点到 */
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
}

.fprl-leave-to {
  opacity: 0;
  transform: scaleY(0);
}

.info {
  min-width: 0;
  cursor: text;
  border-radius: var(--radius-s);
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.info:active {
  background: var(--surface-2);
}

.name {
  display: flex;
  align-items: center;
  /* 名称与铅笔微图标：同一行最小呼吸 4 */
  gap: var(--gap-tight);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  min-width: 0;
}

/* 名称可点改名：铅笔微图标做可供性，避免整行文字链的视觉噪音 */
.name-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-width: 0;
  /* 1px/2px 只是给按压底色一圈边，归到 2 一档 */
  padding: var(--sp-2);
  border-radius: var(--radius-s);
  text-align: left;
  font: inherit;
  color: inherit;
}

.name-btn:active {
  background: var(--surface-2);
}

.name-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.name-pen {
  flex: none;
  color: var(--text-3);
  opacity: 0.7;
}

.name input {
  width: 100%;
  padding: var(--gap-text) var(--sp-6);
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

/* 换一个（已匹配）：低调的 mini pill，错配时人工纠正 */
.rematch {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-text);
  /* 迷你按钮：上下 2、左右 8 */
  padding: var(--gap-text) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  /* 「换一个」是用户要点的按钮，不吃 11px */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.rematch:active {
  color: var(--accent);
}

/* 未匹配行的显性纠正入口：这类条目确认时不会写入，必须引导处理 */
.golink {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  align-self: flex-start;
  margin-top: var(--gap-tight);
  padding: var(--gap-text) 0;
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.tag {
  /* 状态角标：上下 2、左右 6（两字不贴边） */
  padding: var(--sp-2) var(--sp-6);
  margin-left: var(--gap-text);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  /* 「未匹配」这类状态词必须读得出 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  vertical-align: 1px;
}

.macro {
  /* 名称与下方宏量行：主次文本上下 2 */
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-caption);
}

/* 热量是主数值：等宽 + 加粗 + 最深一档，扫列表时先落眼 */
.mk {
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 蛋白/碳水/脂肪与「确认时不会写入」是次要读数，竖线分隔、降一档灰 */
.mm {
  color: var(--text-3);
}

.mm::before {
  content: '|';
  margin: 0 var(--gap-tight);
  color: var(--text-3);
}

/* 「匹配「X」」备注：名字行右侧中性胶囊，长食物名让名字按钮先截断 */
.mnote {
  flex: none;
}

/* 份单位快捷区：展开时高度过渡，避免编辑中下方内容被无动画顶开 */
.units-wrap {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--dur-fast) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard);
}

.units-wrap.open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.units-wrap > .units {
  overflow: hidden;
  min-height: 0;
}

.units {
  display: flex;
  flex-wrap: wrap;
  /* 份单位胶囊一组无边界控件：组内 4（它们是紧邻的同一族） */
  gap: var(--gap-tight);
  margin-top: var(--gap-tight);
}

.unit {
  /* 迷你胶囊：上下 4、左右 8 */
  padding: var(--gap-tight) var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.weight {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  min-width: 74px;
  justify-content: flex-end;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
}

.weight input {
  width: 72px;
  /* 行内小输入：上下 6、左右 8（与它旁边的 .chip 同高） */
  padding: var(--sp-6) var(--gap-sm);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.g-suffix {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.del {
  position: relative;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-3);
}

/* 30px 圆钮是排版规格，命中区撑到 44×44（PageHeader .back 同款惯用法） */
.del::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.del:active {
  background: var(--surface-2);
  color: var(--danger);
}
</style>
