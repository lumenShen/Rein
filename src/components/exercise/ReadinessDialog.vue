<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Gauge, X } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { READINESS_FACTOR } from '@/utils/trainingAdvice'
import { FEELING_LABEL, FEELING_SCORE, feelingOfReadiness } from '@/utils/trainingScore'

/**
 * 「今日状态」对话框（进入力量训练后出现一次：激活热身做完、第一正式组开做前）。
 *
 * ---------- 为什么从内联 chips 升格成对话框 ----------
 * 这一步**真的会改训练计算**（两处），原来嵌在两组卡片里的三行小字说不清代价，
 * 用户容易随手点或随手跳。对话框能把「会改什么」变成**看得见的数字**（下方预览），
 * 选完再按「就绪」确认 —— 它是一次真正的操作，而不是一个装饰性的 chips 组。
 *
 * ---------- 出现形态为什么是居中卡片而不是底部抽屉 ----------
 * 这一屏（沉浸训练页）已经全是底部簇（动作/重量/完成键），再来一张底部抽屉会跟主操作抢地方；
 * 而且内容高度是固定的中等量（5 档 + 预览），底部抽屉的吸附高度要么留大片空白、要么逼着滚动。
 * 居中卡片随内容自适应高度，正好。视觉与动效沿用更新提示（UpdatePrompt）那一套，
 * 全应用只有一种"居中对话框"长相。
 *
 * ---------- 两处影响（都给真实数字，不写"会影响哦"这种空话）----------
 *  1. **本次建议重量**：`READINESS_FACTOR`（0.90–1.04），用一条以「不加不减」为原点的双向条表示；
 *  2. **本周练够分的「体感」项**：良好 100 / 一般 60 / 差 20 分，占 20%（增肌）–30%（减脂）。
 *
 * 跳过不写任何值 → 引擎按纯自动推断算重量，体感按规范默认 60 分并降低置信度。
 */
const props = defineProps<{
  open: boolean
  /** 当前已选档位（1..5）；null = 尚未自评 */
  value: number | null
}>()

const emit = defineEmits<{
  /** null = 跳过（清除自评） */
  pick: [value: number | null]
  close: []
}>()

/** 五档：label 取自训练页原有话术；体感映射与练够分引擎共用（不另立口径） */
const OPTIONS = [
  { value: 5, label: '很好', hint: '精力充沛' },
  { value: 4, label: '不错', hint: '状态在线' },
  { value: 3, label: '一般', hint: '正常' },
  { value: 2, label: '疲惫', hint: '有点顶' },
  { value: 1, label: '很差', hint: '硬撑' },
] as const

/** 对话框里临时选中的档位：按「就绪」才生效，符合"先看清代价再操作" */
const sel = ref<number | null>(null)
const cardEl = ref<HTMLElement | null>(null)

watch(
  () => props.open,
  (o) => {
    if (o) {
      sel.value = props.value
      // 打开后把焦点收进对话框：Esc / 空格不会漏到下面的训练页
      void Promise.resolve().then(() => cardEl.value?.focus())
    }
  },
)

const factor = computed(() => (sel.value != null ? (READINESS_FACTOR[sel.value] ?? 1) : null))
const feeling = computed(() => feelingOfReadiness(sel.value))
const feelingScore = computed(() => (feeling.value ? FEELING_SCORE[feeling.value] : null))

/** 系数相对「不加不减（×1.00）」的偏离：负 = 降载，正 = 加重 */
const delta = computed(() => (factor.value == null ? 0 : Math.round((factor.value - 1) * 100) / 100))

/**
 * 双向条的半幅长度（% of 整条）：两侧按各自极值归一 ——
 * 降载最深处 0.90（−10%）、加重最高 1.04（+4%）。用同一个分母的话，
 * 加重那侧永远只画出一小截，读起来像"没影响"。
 */
const effectW = computed(() => {
  const d = delta.value
  if (!d) return 0
  const ratio = d < 0 ? Math.min(1, Math.abs(d) / 0.1) : Math.min(1, d / 0.04)
  return Math.round(ratio * 50)
})

/** 档位配色：很好/不错 = 绿，一般 = 琥珀，疲惫/很差 = 红（与练够分同一套语义色阶）。
 *  这三档是「状态好坏」的判断，不跟运动识别橙走，否则「好」与「一般」会挤在橙区。 */
function toneOf(v: number): string {
  return v >= 4 ? 'tone-good' : v === 3 ? 'tone-fair' : 'tone-poor'
}

function confirm(): void {
  if (sel.value == null) return
  emit('pick', sel.value)
}

/** 跳过 = 清除自评（纯自动推断 + 体感按默认 60 分） */
function skip(): void {
  emit('pick', null)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
watch(
  () => props.open,
  (o) => {
    if (o) window.addEventListener('keydown', onKeydown, true)
    else window.removeEventListener('keydown', onKeydown, true)
  },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="rdfade">
      <div v-if="open" class="rd-backdrop" aria-hidden="true" @click="emit('close')" />
    </Transition>
    <Transition name="rdcard">
      <section
        v-if="open"
        ref="cardEl"
        class="rd-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rd-title"
        tabindex="-1"
      >
        <header class="rd-head">
          <Gauge :size="18" />
          <h2 id="rd-title">今日状态</h2>
          <!-- 完整口径收进标题行右侧 InfoHint：面上只留一行结论胶囊 ——
               弹出即劝学的那段散文删掉，读数字前不必先读完背景 -->
          <InfoHint title="今日状态怎么参与计算">
            <p>今日状态会写进这次训练的快照，从两个地方参与计算：</p>
            <p>一是本次建议重量：作为今日状态系数修正建议重量（0.90–1.04，双向条中线就是「不加不减」）。</p>
            <p>二是本周练够分的「体感」项：良好 100 / 一般 60 / 差 20 分，占 20%（增肌）–30%（减脂）。</p>
            <p>如实选，建议才准。</p>
          </InfoHint>
          <button class="rd-x" type="button" aria-label="关闭" @click="emit('close')">
            <X :size="15" :stroke-width="2.5" />
          </button>
        </header>

        <div class="rd-body">
          <p class="rd-tags">
            <StatusChip tone="neutral" size="md">参与本次建议重量与本周练够分</StatusChip>
          </p>

          <!-- 五档：选中的用「描边 + 抬底」标记（放大在列表里会顶开布局）。
               行尾的 ×1.04 删掉：同一个系数在屏上出现三次、两种记法
               （行尾 ×1.04 / 预览 +4% / 脚注 ×1.04），只留预览主值那一处百分比，
               参照点交给双向条的中线，不再补一行数字。 -->
          <ul class="rd-opts">
            <li v-for="o in OPTIONS" :key="o.value">
              <button
                class="rd-opt"
                type="button"
                :class="[toneOf(o.value), { on: sel === o.value }]"
                :aria-pressed="sel === o.value"
                @click="sel = o.value"
              >
                <i class="rd-dot" />
                <span class="rd-label">{{ o.label }}</span>
                <span class="rd-hint">{{ o.hint }}</span>
              </button>
            </li>
          </ul>

          <!-- 影响预览：把"会影响计算"落成两个看得见的量 -->
          <div class="rd-preview">
            <div class="rd-phead">
              <span class="rd-pt">选择它的影响</span>
              <span v-if="sel == null" class="rd-ptip">选一个档位看看</span>
            </div>

            <template v-if="sel != null">
              <div class="rd-prow">
                <div class="rd-pline">
                  <span class="rd-pk">建议重量</span>
                  <span class="rd-pv num">
                    {{ delta === 0 ? '不加不减' : `${delta > 0 ? '+' : ''}${Math.round(delta * 100)}%` }}
                  </span>
                </div>
                <span class="rd-dtrack">
                  <i class="rd-dcenter" />
                  <i
                    v-if="delta !== 0"
                    class="rd-dbar"
                    :class="delta < 0 ? 'neg' : 'pos'"
                    :style="{ '--p': `${effectW}%` }"
                  />
                </span>
                <!-- 「今日状态系数 ×1.04（相对「一般」的 ×1.00）」这一行删掉：
                     系数全屏只留预览主值那一处百分比，×1.00 这个参照点由双向条
                     的中线承担（见 .rd-dcenter），不再补一行数字让人心算对齐 -->
              </div>

              <div class="rd-prow">
                <div class="rd-pline">
                  <span class="rd-pk">练够分 · 体感项</span>
                  <span class="rd-pv num">{{ FEELING_LABEL[feeling ?? 'fair'] }} · {{ feelingScore }} 分</span>
                </div>
                <span class="rd-strack">
                  <i class="rd-sbar" :class="toneOf(sel)" :style="{ '--p': `${feelingScore}%` }" />
                </span>
                <p class="rd-psub">体感在练够分里占 20%（增肌）–30%（减脂）</p>
              </div>

              <p class="rd-pnote">
                最终建议重量还会叠加恢复 / 容量 / 趋势三项，这里只显示「今日状态」这一项的贡献。
              </p>
            </template>

            <p v-else class="rd-pempty">
              不选就按纯自动推断：建议重量不做状态修正，练够分的体感按默认 60 分计并降低置信度。
            </p>
          </div>
        </div>

        <div class="rd-acts">
          <button class="rd-btn primary" type="button" :disabled="sel == null" @click="confirm">就绪</button>
          <!-- 「不影响计算」是错的：跳过时练够分的体感仍按默认 60 分计并降低置信度
               （FEELING_SCORE.fair = 60），真正零副作用的只有建议重量那一项。
               按钮文案与预览区同一口径 -->
          <button class="rd-btn" type="button" @click="skip">跳过（按默认值算）</button>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩与卡片沿用更新提示那一套（全应用只有一种"居中对话框"长相）：
   遮罩 --scrim、卡片 --surface + --radius-xl + --shadow-float、随内容自适应高度 */
.rd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.rd-card {
  position: fixed;
  z-index: 120;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(400px, calc(100vw - 40px));
  max-height: min(82dvh, 640px);
  display: flex;
  flex-direction: column;
  padding: var(--sp-16) var(--page-pad-x) calc(var(--sp-14) + var(--safe-bottom, 0));
  border-radius: var(--radius-xl);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  outline: none;
}

.rd-head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex: none;
  color: var(--accent);
}

.rd-head h2 {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}

.rd-x {
  flex: none;
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

/* 视觉尺寸不动，命中区撑到 44×44 —— 与 SheetModal.vue 的 `.close::after{inset:-7px}`
   同一做法。同一个应用里两枚关闭键，一处 44 一处 28，拇指只会在小那枚上失手。 */
.rd-x::after {
  content: '';
  position: absolute;
  inset: -8px;
}

/* 内容区可滚：视口矮时（分屏 / 横屏）不至于把操作键挤出卡外 */
.rd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* 面上结论：一行胶囊（参与本次建议重量与本周练够分），口径全文收进标题栏 InfoHint */
.rd-tags {
  margin-top: var(--sp-10);
  display: flex;
}

.rd-opts {
  margin-top: var(--sp-12);
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.rd-opt {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  border: 1px solid transparent;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.rd-opt:active {
  opacity: 0.7;
}

/* 选中同时用「描边 + 抬底」：单靠底色在暗色档差异太弱 */
.rd-opt.on {
  background: var(--surface);
  border-color: var(--line-strong);
}

.rd-dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
}

.tone-good .rd-dot {
  background: var(--heat-enough);
}

.tone-fair .rd-dot {
  background: var(--heat-near);
}

.tone-poor .rd-dot {
  background: var(--heat-low);
}

.rd-label {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.rd-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* ---------- 影响预览 ---------- */
.rd-preview {
  margin-top: var(--sp-14);
  padding: var(--sp-12) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.rd-phead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
}

.rd-pt {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.rd-ptip {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.rd-prow + .rd-prow {
  margin-top: var(--sp-12);
}

.rd-pline {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gap-sm);
}

.rd-pk {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.rd-pv {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 双向条：中点 = 不加不减（×1.00）。左红右绿 —— 降载更保守、加重更进取 */
.rd-dtrack {
  position: relative;
  display: block;
  height: 8px;
  margin-top: var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--surface);
  overflow: hidden;
}

.rd-dcenter {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line-strong);
}

.rd-dbar {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 100%;
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.rd-dbar.pos {
  left: 50%;
  /* 右行长到零线右侧：clip 从右端裁掉（100% − --p），只留左起一段；
     圆帽给末端侧，贴零线那侧直角才接得上中线 */
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round 0 var(--radius-full) var(--radius-full) 0);
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
  background: var(--heat-enough);
}

.rd-dbar.neg {
  right: 50%;
  clip-path: inset(0 0 0 calc(100% - var(--p, 0%)) round var(--radius-full) 0 0 var(--radius-full));
  border-radius: var(--radius-full) 0 0 var(--radius-full);
  background: var(--heat-low);
}

.rd-strack {
  display: block;
  height: 8px;
  margin-top: var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--surface);
  overflow: hidden;
}

.rd-sbar {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.rd-sbar.tone-good {
  background: var(--heat-enough);
}

.rd-sbar.tone-fair {
  background: var(--heat-near);
}

.rd-sbar.tone-poor {
  background: var(--heat-low);
}

.rd-psub {
  margin-top: var(--sp-6);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.rd-pnote {
  margin-top: var(--sp-10);
  font-size: var(--fs-micro);
  line-height: var(--lh-body);
  color: var(--text-3);
}

.rd-pempty {
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
}

/* ---------- 操作 ---------- */
.rd-acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--sp-14);
}

.rd-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  /* 命中区抬到 44：这两颗是弹窗的主操作，而 caption 档字号让盒子只有 38 高。
     这里不用 `.rd-x` 那种伪元素外扩 —— 两颗钮并排、下面紧着下一段，外扩会互相抢点击。 */
  min-height: 44px;
  padding: var(--sp-10) var(--sp-14);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.rd-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

/* 禁用态浓度走令牌（tokens.css:37-40 收编的那一档），不再各写各的裸值 */
.rd-btn:disabled {
  opacity: var(--disabled-opacity);
}

/* ---------- 进出场：与更新提示同一条曲线（进入用 --ease-out 上浮，退出更快、只淡） ---------- */
.rdfade-enter-active,
.rdfade-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}

.rdfade-enter-from,
.rdfade-leave-to {
  opacity: 0;
}

.rdcard-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.rdcard-leave-active {
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.rdcard-enter-from,
.rdcard-leave-to {
  opacity: 0;
}

.rdcard-enter-from {
  transform: translate(-50%, calc(-50% + 14px));
}
</style>
