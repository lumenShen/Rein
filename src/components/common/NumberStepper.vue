<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { Minus, Plus } from 'lucide-vue-next'

/**
 * 紧凑数字步进器（目标设置等场景）。
 *
 * 值可以**点一下直接输入**。只有 +/- 是不够的：参数区间一旦拉开（比如最小间隔
 * 从 10ms 到 10s），靠固定步长要么点几十下才走到低档、要么在低档完全迈不开步。
 */
const props = withDefaults(
  defineProps<{
    modelValue: number
    step?: number
    min?: number
    max?: number
    unit?: string
    label?: string
    /** 保留小数位（0 = 整数）。小数步进（体重 0.1kg）必须给到 1：落库前的取整口径全看它 */
    decimals?: number
  }>(),
  { step: 1, min: 0, max: 99999, unit: '', label: '', decimals: 0 },
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const editing = ref(false)
/**
 * 输入态的草稿值。
 *
 * 声明成 string 但**不能假设它真是 string**：Vue 3 的 vModelText 在
 * `el.type === 'number'` 时会做 `looseToNumber`，所以 draft 实际拿到的是 number，
 * 草稿上一版在这里直接 `draft.value.trim()` —— 于是「点一下输入」这条路径
 * 一旦真的敲了字就抛 `trim is not a function`，而这条组件在设置页被复用了十几处。
 * 所以草稿一律经 `String(...)` 归一，不依赖运行时类型。
 */
const draft = ref<string | number>('')
const box = ref<HTMLInputElement | null>(null)

/** 按 decimals 归一：既夹区间，也消掉 0.1 步进的浮点尾巴（81.5 + 0.1 = 81.6000…01） */
function quantize(n: number): number {
  return Number(Math.min(props.max, Math.max(props.min, n)).toFixed(props.decimals))
}

function bump(d: number): void {
  emit('update:modelValue', quantize(props.modelValue + d))
}

function startEdit(): void {
  draft.value = String(props.modelValue)
  editing.value = true
  void nextTick(() => box.value?.select())
}

/** 失焦与回车共用：越界的值夹回区间，NaN 直接丢弃（保持原值）。
 *  取整按 decimals 而非一律 Math.round：体重 81.5 曾被吞成 82（0.5 直接丢失） */
function commit(): void {
  const raw = String(draft.value).trim()
  const n = Number(raw)
  if (Number.isFinite(n) && raw !== '') {
    emit('update:modelValue', quantize(n))
  }
  editing.value = false
}
</script>

<template>
  <div class="stepper row between">
    <span v-if="label" class="label">{{ label }}</span>
    <div class="row ctrl">
      <button
        :aria-label="label ? `减少 ${label}` : '减少'"
        :disabled="modelValue <= min"
        @click="bump(-step)"
      >
        <Minus :size="16" />
      </button>
      <input
        v-if="editing"
        ref="box"
        v-model="draft"
        class="val edit num"
        type="number"
        :min="min"
        :max="max"
        :aria-label="label ? `修改 ${label}` : '修改数值'"
        @blur="commit"
        @keyup.enter="commit"
        @keyup.esc="editing = false"
      />
      <button v-else class="val val-btn" :aria-label="`修改${label || '数值'}`" @click="startEdit">
        <b class="num">{{ modelValue }}</b><small v-if="unit">{{ unit }}</small>
      </button>
      <button
        :aria-label="label ? `增加 ${label}` : '增加'"
        :disabled="modelValue >= max"
        @click="bump(step)"
      >
        <Plus :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.stepper {
  /* 行内上下 8（--sp-8）：吸附自 7，让设置行的节奏落在 4/8 体系上 */
  padding: var(--sp-8) 0;
}

.label {
  flex: none;
  white-space: nowrap;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.ctrl {
  /* 行内元素之间最小 4（HarmonyOS 间隔规范）：2 只够画「紧贴」，两颗 44 热区
     之间只剩 2px 会让「按减号却点到数值」的概率变高 */
  gap: var(--gap-tight);
}

/* + / − 的**命中区是 44×44**，视觉那个 34px 的圆画在 ::before 上。
   这两颗钮在一屏里成对出现七次，是该按 44px 标准来的地方 —— 但把圆放大到 44
   会挤掉数值的位置，所以撑命中区而不是撑视觉。
   圆的底用 --surface-3 而不是 --surface-2：步进器多数坐在 .card.sub 的
   --surface-inset 浅井上（#f6f6f6），--surface-2 的 #f2f2f4 与它只差 4 级，
   按钮在真机上几乎看不见；--surface-3 让「这里可以按」有一块明确的背板，
   亮暗两档都保持一档可辨的差。
   **数值钮必须排除在外**（:not(.val-btn)）：它和这两颗钮同在一个 .ctrl 里，
   曾经被同一条规则盖上了一个圆底 —— 圆正好落在数字上（颜色还与两侧步进钮一致），
   把值挡得看不见。 */
.ctrl button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-1);
}

.ctrl button:not(.val-btn) {
  width: 44px;
  height: 44px;
  border-radius: 50%;
}

.ctrl button:not(.val-btn)::before {
  content: '';
  position: absolute;
  width: var(--control-icon);
  height: var(--control-icon);
  border-radius: 50%;
  background: var(--surface-3);
  box-shadow: inset 0 0 0 0.5px var(--line);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.ctrl button:not(.val-btn):active::before {
  transform: scale(0.92);
}

.ctrl button svg {
  position: relative;
}

.ctrl button:disabled {
  opacity: var(--disabled-opacity);
}

.val {
  /* 64 是「4 轮」「180 秒」这类读数在 14px 下仍能居中且不换行的最小宽度；
     74 在 320 宽下会把「长休间隔」挤到第二行。 */
  min-width: 64px;
  text-align: center;
  font-size: var(--fs-subhead);
}

.val b {
  font-weight: var(--fw-bold);
}

/* 数值与单位左右 2（主次文本上下那一档的横向版本） */
.val small {
  color: var(--text-3);
  margin-left: var(--gap-text);
}

/* 数值钮：点一下就地输入。命中区与两侧步进钮同高（44），但没有圆底 —— 它只在自己
   被按下时铺一层浅底，读数始终压在干净的画布上 */
.val-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: var(--sp-2) 0;
  border-radius: var(--radius-s);
  color: inherit;
}

.val-btn:active {
  background: var(--surface-2);
}

/* 直接输入态：宽度与 .val 对齐，避免切进来时整行跳动 */
.edit {
  width: 64px;
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--accent);
  color: var(--text-1);
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
  background: none;
  -moz-appearance: textfield;
}

.edit::-webkit-outer-spin-button,
.edit::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
</style>
