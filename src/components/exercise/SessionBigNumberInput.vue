<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Minus, Plus } from 'lucide-vue-next'

/**
 * 沉浸模式大数字输入：常态显示大数字，点数字就地变成输入框，可直接用输入法键入。
 *
 * 为什么用 type="text" + inputmode="decimal" 而不是 type="number"：
 *  - 中文输入法下 type=number 无法输入全角数字，部分 WebView 还会直接丢弃非 ASCII 字符；
 *  - number 输入在各家浏览器对小数点 / 逗号的容忍度不一致，且拿不到原始串做容错解析。
 * 因此这里始终用文本输入，提交时自行归一化（全角→半角、中文句号→小数点）后解析。
 *
 * 提交时机：失焦 / 回车（输入法组合中不响应，避免误提交候选词）；Esc 取消。
 * 清空提交 = null（表示「该动作没配次数」），由调用方决定如何展示。
 *
 * 版式：整行撑满容器，两侧步进钮落在两端、数值居中（调用方给标签与容器宽度）。
 * 步进钮是**看得见的圆底**、图标用 svg —— 从前是两枚裸字形（「−」是 U+2212、
 * 「＋」是全角），落在卡片空白里既不像按钮，两者的字宽也差一档、左右不对称。
 */
const props = withDefaults(
  defineProps<{
    /** 当前值；null = 未设置（展示占位符） */
    modelValue: number | null
    /** 单位文案，如 kg / 次 */
    unit: string
    /** 无障碍与提示用的字段名，如「重量」 */
    label: string
    step?: number
    min?: number
    max?: number
    /** 小数位数：重量 1 位，次数 0 位 */
    precision?: number
    placeholder?: string
  }>(),
  { step: 1, min: 0, max: 9999, precision: 0, placeholder: '—' },
)

const emit = defineEmits<{ 'update:modelValue': [value: number | null] }>()

const editing = ref(false)
const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

/** 展示文本：整数不带小数，小数按 precision 定长 */
const text = computed(() => {
  const v = props.modelValue
  if (v == null) return props.placeholder
  return props.precision > 0 && !Number.isInteger(v) ? v.toFixed(props.precision) : String(v)
})

function beginEdit(): void {
  if (editing.value) return
  draft.value = props.modelValue == null ? '' : String(props.modelValue)
  editing.value = true
  void nextTick(() => {
    const el = inputEl.value
    if (!el) return
    el.focus()
    el.select()
  })
}

/** 归一化后取第一个数字：全角数字 / 中文句号 / 千分位逗号都要能识别 */
function parse(raw: string): number | null {
  const s = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。｡]/g, '.')
    .replace(/[，,\s]/g, '')
  const m = s.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  if (!Number.isFinite(n)) return null
  const k = 10 ** props.precision
  return Math.min(props.max, Math.max(props.min, Math.round(n * k) / k))
}

function commit(): void {
  if (!editing.value) return
  editing.value = false
  emit('update:modelValue', draft.value.trim() === '' ? null : parse(draft.value))
}

function cancel(): void {
  editing.value = false
}

function onEnter(e: KeyboardEvent): void {
  if (e.isComposing) return // 输入法候选还没上屏，别抢这次回车
  e.preventDefault()
  commit()
}

function bump(d: number): void {
  const base = props.modelValue ?? 0
  const raw = Math.min(props.max, Math.max(props.min, base + d))
  const k = 10 ** props.precision
  emit('update:modelValue', Math.round(raw * k) / k)
}
</script>

<template>
  <div class="biginput row">
    <button
      v-if="!editing"
      type="button"
      class="wbtn"
      :aria-label="`${label}减 ${step}${unit}`"
      @click="bump(-step)"
    >
      <Minus :size="19" :stroke-width="2.6" />
    </button>

    <div class="wval row center" :class="{ editing }">
      <input
        v-if="editing"
        ref="inputEl"
        v-model="draft"
        class="winp num"
        type="text"
        inputmode="decimal"
        enterkeyhint="done"
        autocomplete="off"
        :aria-label="`输入${label}`"
        @keydown.enter="onEnter"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      />
      <button v-else type="button" class="wview num" :aria-label="`修改${label}`" @click="beginEdit">
        <b>{{ text }}</b><span class="wunit">{{ unit }}</span>
      </button>
      <!-- mousedown.prevent 保住焦点，避免 blur 先提交把按钮点没了 -->
      <button v-if="editing" type="button" class="wok" @mousedown.prevent @click="commit">确定</button>
    </div>

    <button
      v-if="!editing"
      type="button"
      class="wbtn"
      :aria-label="`${label}加 ${step}${unit}`"
      @click="bump(step)"
    >
      <Plus :size="19" :stroke-width="2.6" />
    </button>
  </div>
</template>

<style scoped>
.biginput {
  width: 100%;
  justify-content: space-between;
  gap: var(--sp-10);
}

/* 步进钮：它们压在**内容卡**上（本组登记卡），卡本身已经是不透明的内容层表面，
   所以这里要的是填充而不是又一层玻璃 —— 苹果的规矩：往玻璃上放东西，上层只用
   fills / transparency / vibrancy，两层都上玻璃就成了 glass on glass。
   填充取 --surface-2，与卡内其它分段（今日状态档位、一键填入）同一个底。 */
.wbtn {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.wbtn:active {
  transform: scale(0.9);
}

/* 值域吃掉两侧钮之间的全部余量：数值居中、两钮分列卡片两端，步进距离够拇指 */
.wval {
  flex: 1;
  min-width: 0;
  gap: var(--sp-6);
  justify-content: center;
}

.wval.editing {
  gap: var(--gap-sm);
}

.wview {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--radius-s);
  color: var(--text-1);
}

.wview:active {
  background: var(--surface-2);
}

.wview b {
  font-size: var(--fs-display-l);
  /* 大字读数取阶梯最轻一档（--fw-light 300）；裸 200 不在五档里，44px 上区别可忽略。 */
  font-weight: var(--fw-light);
  letter-spacing: -1.5px;
  line-height: 1.15;
  white-space: nowrap;
}

.wunit {
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  /* 单位是大数字的**必读**部分（「62.5」不带 kg 就不是一个重量），而 15px 不属于
     WCAG 的 large text：--text-3（3.6:1）在这个字号上过不了 AA。同批的 .restsec /
     .punit 也都取 --text-2，这里跟随。 */
  color: var(--text-2);
  white-space: nowrap;
}

/* 输入框：宽度按最长常见值（3 位 + 1 位小数）留够，避免键入时抖动。
   字号走 --fs-large-title（32px 这一档）：桌面壳整体降一档字号阶梯时这处要跟随 ——
   从前是写死的 32px 魔法值，观感不变 */
.winp {
  width: 116px;
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-large-title);
  font-weight: var(--fw-light);
  letter-spacing: -0.5px;
  text-align: center;
  color: var(--text-1);
}

.wok {
  flex: none;
  /* 命中区撑到 44，与两侧 ± 步进钮同高：输入法弹出时这一行最容易被误触，
     而这颗「确定」从前只有 28 高。这是全批最小的热区。 */
  min-height: 44px;
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-full);
  /* 「确定」是按钮标签：文字中性色，色相留在 soft 底的色块上（色彩配额，STANDARDS §4） */
  background: var(--c-exercise-soft);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}
</style>
