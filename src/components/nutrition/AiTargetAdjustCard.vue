<script setup lang="ts">
import { ref } from 'vue'
import { Sparkles } from 'lucide-vue-next'

import { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'
import { TARGET_FIELD_META } from '@/config/domain'

/** AI 智能调整：一句话生成目标修改建议，确认后才生效。 */
const ai = useAiStore()
const { toast } = useToast()

const draft = ref('')

/** 热量的字段名从 TARGET_FIELD_META 取：计算器与微调卡里都叫「能量」，示例不能另叫「热量」 */
const KCAL_LABEL = TARGET_FIELD_META.find((m) => m.key === 'kcal')!.label

/** 示例一律带单位与空格：照抄时「钠减到 1200」是 mg 还是 g，量级差一千倍 */
const EXAMPLES = [
  `${KCAL_LABEL}降到 1800 大卡`,
  '蛋白质提高到 130 克',
  '钠减到 1200 mg，饮水加到 2400 ml',
]

async function submit(): Promise<void> {
  if (!draft.value.trim() || ai.busy) return
  try {
    await ai.requestTargetAdjust(draft.value)
    draft.value = ''
  } catch {
    toast('解析失败了，请换个说法试试')
  }
}

async function adopt(): Promise<void> {
  try {
    await ai.applyTargetProposal()
    toast('新目标已生效')
  } catch {
    toast('保存失败，请重试')
  }
}

function dismiss(): void {
  ai.dismissTargetProposal()
}
</script>

<template>
  <section class="card">
    <header class="head">
      <h2 class="row center"><Sparkles :size="16" class="ic" />AI 智能调整</h2>
      <p class="t-3">一句话描述 · AI 给出可确认的新目标</p>
    </header>

    <!-- 输入 -->
    <div class="inbar row">
      <input
        v-model="draft"
        type="text"
        :placeholder="`如：${KCAL_LABEL}降到 1800 大卡，蛋白质提到 130 克`"
        aria-label="描述目标调整"
        @keydown.enter="submit"
      >
      <button class="send" aria-label="生成调整建议" :disabled="ai.busy || !draft.trim()" @click="submit">
        {{ ai.busy ? '…' : '生成' }}
      </button>
    </div>

    <!-- 示例 -->
    <ul class="ex row">
      <li v-for="e in EXAMPLES" :key="e">
        <button class="ex-chip" :disabled="ai.busy" @click="draft = e">{{ e }}</button>
      </li>
    </ul>

    <!-- 建议卡 -->
    <div v-if="ai.targetProposal" class="proposal">
      <p class="reply">{{ ai.targetProposal.reply }}</p>
      <ul v-if="ai.targetProposal.changes.length" class="changes">
        <li v-for="c in ai.targetProposal.changes" :key="c.field" class="row between">
          <span class="cl">{{ c.label }}</span>
          <span class="num cv">
            {{ Math.round(c.from) }} → <b>{{ Math.round(c.to) }}</b><i>{{ c.unit }}</i>
          </span>
        </li>
      </ul>
      <div v-if="ai.targetProposal.changes.length" class="acts row">
        <button class="ghost-btn" @click="dismiss">放弃</button>
        <button class="apply" @click="adopt">采用新方案</button>
      </div>
      <button v-else class="ghost-btn wide" @click="dismiss">知道了</button>
    </div>
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  /* 标题里的图标与文字：同一行内最小呼吸 4/6，6 是 4·8 表里的一格 */
  gap: var(--sp-6);
}

.ic {
  color: var(--accent);
}

.head p {
  font-size: var(--fs-caption);
  /* 标题与副标题：主次文本上下 2 */
  margin-top: var(--gap-text);
}

/* 输入栏：外圈是胶囊，左侧留 16（输入框左右内距的规范档）、右侧 6 是给
   .send 那枚实底按钮的一圈呼吸 */
.inbar {
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  padding: var(--sp-6) var(--sp-6) var(--sp-6) var(--pad-row);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.inbar input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.inbar input::placeholder {
  color: var(--text-3);
}

.send {
  flex: none;
  /* 胶囊按钮高 40 档：10 上下 + 14 字 */
  padding: var(--sp-10) var(--gap-lg);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

.send:disabled {
  opacity: var(--disabled-opacity);
}

/* 示例 */
.ex {
  flex-wrap: wrap;
  /* 示例胶囊组：无边界 8；与输入栏之间 12（区块） */
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

.ex-chip {
  /* 小胶囊：纵向 6 + 12 字 ≈ 28（--control-sm），左右 12 */
  padding: var(--sp-6) var(--pad-inline);
  border-radius: var(--radius-full);
  border: 0.5px solid var(--line-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.ex-chip:disabled {
  opacity: var(--disabled-opacity);
}

/* 建议卡 */
.proposal {
  /* 卡内二级分组面：与上方区块 12，内距取紧凑卡那一档 12 */
  margin-top: var(--gap-md);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m-nest);
  background: var(--accent-soft);
}

.reply {
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.changes {
  margin-top: var(--gap-sm);
  background: var(--surface);
  /* 二级分组面再收一档：8（它是 .proposal 里的列表，层级第三） */
  border-radius: var(--radius-s);
  padding: 0 var(--pad-inline);
}

.changes li {
  /* 单行改动行：40 档（10 上下 + 14 字），比列表行的 48 紧一档但成组对齐 */
  padding: var(--sp-10) 0;
}

.changes li + li {
  border-top: 0.5px solid var(--line);
}

.cl {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.cv {
  font-size: var(--fs-subhead);
  color: var(--text-3);
}

.cv b {
  color: var(--accent);
  font-weight: var(--fw-bold);
}

.cv i {
  font-style: normal;
  /* 大数后的单位后缀，装饰性微字，可留在 10px 档 */
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: var(--gap-text);
}

.acts {
  justify-content: flex-end;
  /* 按钮组：无边界 8（两颗胶囊之间有明确的底色差，不需要 16 那种大间隔） */
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

.ghost-btn {
  padding: var(--sp-10) var(--sp-20);
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ghost-btn.wide {
  width: 100%;
  margin-top: var(--gap-md);
}

.apply {
  padding: var(--sp-10) var(--sp-20);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}
</style>
