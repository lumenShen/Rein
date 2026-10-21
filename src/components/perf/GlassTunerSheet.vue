<script setup lang="ts">
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { CalendarDays, Dumbbell, House, Sparkles, User } from 'lucide-vue-next'

import GlassDockAssembly from '@/components/common/GlassDockAssembly.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import {
  GLASS_PARAM_SPECS,
  glassParams,
  glassTuned,
  resetGlassParams,
  setGlassParam,
  type GlassParamKey,
  type GlassParamSpec,
} from '@/system/glassParams'
import { liquidGlass, setPerfMode } from '@/system/perf'

/**
 * 液态玻璃参数调节面板（画质预览页的入口拉开）。
 *
 * 面板自带一块**暗场预览**：折射采样的是背后的东西，台子上有细格与光晕才看得出
 * 位移；三块玻璃按真实 Dock 的装配摆（圆 + 药丸 + 圆）。台内换的是与标本台
 * 同一套暗场玻璃上下文（--hero-* 那组），所以这里看到的材质就是 Dock 上的材质。
 *
 * 每一行 = 中文名 + 当前值 + 滑杆（英文键名与 GlassSurface 的 prop 同名，只保留在
 * 读屏与 DOM 里，不占可见行位）：值点一下就地输入（吸附到步长、夹回区间），滑杆给的
 * 是宽区间 —— 这一页是给「调到合适为止」用的，不是日常微调。改动即时写进
 * system/glassParams 并存本地，定稿后把那组数写回 GLASS_DEFAULTS 即可。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const previewItems = [
  { id: 'home', label: '主页', icon: House },
  { id: 'sports', label: '运动', icon: Dumbbell },
  { id: 'me', label: '我', icon: User },
]
const previewLeft = { id: 'schedule', label: '课表', icon: CalendarDays }
const previewRight = { id: 'ai', label: 'AI', icon: Sparkles }

/** 小数位从步长推出来（0.02 → 2 位、1 → 0 位）：读数、输入框、吸附共用一套 */
function decimals(step: number): number {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

function fmt(spec: GlassParamSpec): string {
  return glassParams.value[spec.key].toFixed(decimals(spec.step))
}

/* ---------- 点一下就地输入（与数字步进器同一套手感） ---------- */
const editing = ref<GlassParamKey | null>(null)
const draft = ref('')
let inputEl: HTMLInputElement | null = null

function setInputRef(el: Element | ComponentPublicInstance | null): void {
  inputEl = (el as HTMLInputElement | null) ?? null
}

function beginEdit(spec: GlassParamSpec): void {
  draft.value = fmt(spec)
  editing.value = spec.key
  void nextTick(() => {
    inputEl?.focus()
    inputEl?.select()
  })
}

function cancelEdit(): void {
  editing.value = null
}

/** 提交：解析 → 吸附到步长 → 夹回区间（越界与垃圾输入都拖不坏玻璃） */
function commit(spec: GlassParamSpec): void {
  if (editing.value !== spec.key) return
  editing.value = null
  const n = Number(draft.value.replace(/[，,\s]/g, ''))
  if (!Number.isFinite(n)) return
  const snapped = spec.min + Math.round((n - spec.min) / spec.step) * spec.step
  setGlassParam(spec.key, Number(snapped.toFixed(decimals(spec.step))))
}

function onSlide(spec: GlassParamSpec, e: Event): void {
  setGlassParam(spec.key, Number((e.target as HTMLInputElement).value))
}

const stateText = computed(() =>
  liquidGlass.value ? '折射已开启（塌缩管线），下面的拖动即时生效' : '当前档位没有折射，参数只在「超高」与「极致」生效',
)
</script>

<template>
  <SheetModal :open="props.open" title="液态玻璃参数" initial-snap="large" @close="emit('close')">
    <template #action>
      <button type="button" class="reset" :disabled="!glassTuned" @click="resetGlassParams">恢复默认</button>
    </template>

    <!-- 暗场预览：直接渲染生产 Dock 的共享玻璃装配，圆角与尺寸不会再漂 -->
    <div class="stage stage-dark" aria-hidden="true">
      <span class="glow" />
      <span class="grid" />
      <GlassDockAssembly
        :items="previewItems"
        active="sports"
        :left="previewLeft"
        :right="previewRight"
      />
    </div>

    <!-- 参数只作用于折射分支：没开折射时先说清楚，并给一键切档 -->
    <p class="state" :class="liquidGlass ? 'on' : 'warn'">
      <span class="sdot" />
      <span class="stxt">{{ stateText }}</span>
      <button v-if="!liquidGlass" type="button" class="jump" @click="setPerfMode('ultra')">切到超高</button>
    </p>

    <div class="params">
      <div v-for="s in GLASS_PARAM_SPECS" :key="s.key" class="prow">
        <div class="ptop">
          <code class="pkey">{{ s.key }}</code>
          <span class="pcn">{{ s.cn }}</span>
          <button
            v-if="editing !== s.key"
            type="button"
            class="pval num"
            :aria-label="`修改 ${s.cn}`"
            @click="beginEdit(s)"
          >
            {{ fmt(s) }}
          </button>
          <input
            v-else
            :ref="setInputRef"
            v-model="draft"
            class="pval num edit"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-label="`输入 ${s.cn}`"
            @blur="commit(s)"
            @keydown.enter="commit(s)"
            @keydown.esc="cancelEdit"
          />
        </div>
        <input
          class="prange"
          type="range"
          :min="s.min"
          :max="s.max"
          :step="s.step"
          :value="glassParams[s.key]"
          :aria-label="`${s.cn} ${s.key}`"
          @input="onSlide(s, $event)"
        />
      </div>
    </div>

    <!-- 面板上下不再各罗列一遍参数名：管线顺序这种背景收进 InfoHint，面上只留操作结论 -->
    <p class="pnote">
      <span class="t-2">数值点一下可直接输入；改动即时生效并存在本机。</span>
      <InfoHint
        class="hint"
        title="参数的排布依据"
        content="面板按渲染管线的顺序排：位移贴图（边缘厚度 / 中心亮度 / 贴图模糊 / 贴图分辨率）→ 位移强度 → 收尾柔化 → 表面（背景饱和度 / 底色浓度）。"
      />
    </p>
  </SheetModal>
</template>

<style scoped>
.reset {
  height: var(--control-sm);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.reset:disabled {
  opacity: var(--disabled-opacity);
}

/* ---------- 暗场预览 ---------- */
/* 台内换一套玻璃材质：class 上的 .stage-dark（base.css）—— 暗底上的玻璃按应用在
   暗场的做法压暗（HUD 芯片材质），受光边换中性白，前景因此永远是浅色。
   与画质预览页的标本台**共用那一份**（两处原本各抄了一遍，正是"两份定义必然漂"
   那类事故的温床）；弱档的实底退化也在那份里。 */
.stage {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: var(--sp-4) 0 var(--gap-lg);
  padding: var(--sp-20) var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--hero-bg);
}

/* 「减弱透明度」：折射与白雾底都是内联样式，媒体查询在组件里够不着，靠调用处压住 */
@media (prefers-reduced-transparency: reduce) {
  .stage {
    --surface: var(--hero-bg);
    --line-strong: var(--hero-chip-line);
  }

  .stage :deep(.glass) {
    background: var(--hero-bg) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

.glow,
.grid {
  position: absolute;
  pointer-events: none;
}

.glow {
  top: -60%;
  left: -10%;
  width: 90%;
  height: 200%;
  border-radius: 50%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--c-exercise) 42%, transparent), transparent);
}

.grid {
  inset: 0;
  background-image:
    linear-gradient(var(--hero-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-grid) 1px, transparent 1px);
  background-size: 12px 12px;
}

/* ---------- 状态 ---------- */
.state {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-bottom: var(--gap-md);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.sdot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.state.on .sdot {
  background: var(--c-exercise);
}

.state.warn .sdot {
  background: var(--warn);
}

.jump {
  flex: none;
  margin-left: auto;
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

/* ---------- 参数行 ----------
   这组面板此前**没有任何排版规则**（.params / .prow 只在模板里挂着类）：参数行之间
   零间距、标签与滑块之间只靠输入框自带的行高撑着，一屏八行滑杆糊成一整块。
   这里按「区块 16 / 行内 8」补齐：行与行 16（每行是一个独立参数），
   行内「标签 + 数值」与滑块之间 8。 */
.params {
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
}

.prow {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.ptop {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
}

/* 英文键名退出可见行位（面板看起来不再是调试属性表），但节点与文本保留：
   e2e 按它定位参数行（scripts/e2e-perf-glass.mjs），读屏与开发对照也仍拿得到 */
.pkey {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.pcn {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

/* 当前值：点一下就地输入（数字等宽，避免拖动滑杆时抖动） */
.pval {
  flex: none;
  margin-left: auto;
  min-width: 64px;
  min-height: var(--chip-h);
  padding: 0 var(--sp-6);
  border-radius: var(--radius-s);
  color: var(--accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.pval:active {
  background: var(--surface-2);
}

.pval.edit {
  border-bottom: 1px solid var(--accent);
  background: none;
  color: var(--text-1);
}

.prange {
  width: 100%;
  height: 28px;
  /* 与标签行的间距由 .prow 的 8px gap 给，这里不再叠一层 */
  margin-top: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
}

.prange::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.prange::-webkit-slider-thumb {
  width: 20px;
  height: 20px;
  margin-top: calc(-1 * var(--sp-8));
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  appearance: none;
  -webkit-appearance: none;
}

.prange::-moz-range-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.prange::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
}

/* 操作结论一行 + 行内帮助入口（管线顺序的背景说明收进 InfoHint） */
.pnote {
  margin-top: var(--gap-lg);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}
</style>
