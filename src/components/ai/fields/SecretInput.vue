<script setup lang="ts">
/**
 * 密钥输入（专用组件）：粘进 Key 这件事上最容易出错的几处都替你处理掉。
 *
 * - **粘贴即清洗**：从控制台复制的 Key 常带换行、空格、引号，一律去掉
 *   （这类字符会让鉴权头非法，报出来的错还看不出原因）；
 * - **默认遮住**：`password` 类型 + 眼睛按钮临时显形，避免肩窥；
 * - **一键粘贴**：不依赖系统长按菜单（桌面端右键菜单在 WebView 里不好用）；
 * - **已保存回显**：库里已有密钥时显示末四位，留空 = 不改（密钥不回传明文，
 *   所以「保留原值」只能表达成留空）。
 */
import { ref } from 'vue'
import { AlertCircle, ClipboardPaste, Eye, EyeOff, KeyRound, X } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 输入框 id（label / 测试选择器用） */
    id?: string
    placeholder?: string
    /** 已保存密钥的末四位（有值时占位符提示「留空 = 不改」） */
    savedTail?: string | null
    /** 期望的前缀（如 sk-），只提示不拦截 */
    prefix?: string
    hint?: string
    disabled?: boolean
    ariaLabel?: string
  }>(),
  {
    placeholder: '粘贴或输入密钥',
    savedTail: null,
    prefix: '',
    hint: '',
    disabled: false,
    ariaLabel: '密钥',
  },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const reveal = ref(false)
/** 粘贴结果提示：成功（已粘贴）与失败（读不到 / 空的）分两态，不能用同一个成功绿 */
const pasteNote = ref<{ ok: boolean; text: string } | null>(null)

/** Key 里不允许出现空白与包裹引号：粘贴时一次清掉，省掉「鉴权失败但看不出为什么」 */
function clean(raw: string): string {
  return raw.replace(/[\s"']+/g, '')
}

function onInput(e: Event): void {
  const el = e.target as HTMLInputElement
  const v = clean(el.value)
  if (v !== el.value) el.value = v
  emit('update:modelValue', v)
}

async function paste(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    const v = clean(text)
    if (!v) {
      pasteNote.value = { ok: false, text: '剪贴板是空的' }
    } else {
      emit('update:modelValue', v)
      pasteNote.value = { ok: true, text: '已粘贴' }
    }
  } catch {
    pasteNote.value = { ok: false, text: '读不到剪贴板，请手动粘贴' }
  }
  setTimeout(() => (pasteNote.value = null), 2200)
}

/** 前缀不对时给一句提醒（不拦保存：服务商的 Key 形态各家不同） */
const prefixWarn = ref(false)
function checkPrefix(): void {
  const v = props.modelValue.trim()
  prefixWarn.value = !!v && !!props.prefix && !v.startsWith(props.prefix)
}
</script>

<template>
  <div class="sec">
    <div class="row center box">
      <KeyRound :size="15" class="ic" />
      <input
        :id="id"
        :type="reveal ? 'text' : 'password'"
        :value="modelValue"
        :placeholder="savedTail ? `已保存 ****${savedTail} · 留空不改` : placeholder"
        :aria-label="ariaLabel"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :disabled="disabled"
        @input="onInput"
        @blur="checkPrefix"
      >
      <button
        type="button"
        class="mini"
        :aria-label="reveal ? '隐藏密钥' : '显示密钥'"
        :disabled="disabled"
        @click="reveal = !reveal"
      >
        <EyeOff v-if="reveal" :size="15" />
        <Eye v-else :size="15" />
      </button>
      <button type="button" class="mini" aria-label="从剪贴板粘贴" :disabled="disabled" @click="paste">
        <ClipboardPaste :size="15" />
      </button>
      <button
        v-if="modelValue"
        type="button"
        class="mini"
        aria-label="清空密钥"
        :disabled="disabled"
        @click="emit('update:modelValue', '')"
      >
        <X :size="15" />
      </button>
    </div>
    <p v-if="pasteNote" class="note" :class="{ bad: !pasteNote.ok }">
      <AlertCircle v-if="!pasteNote.ok" :size="13" />
      {{ pasteNote.text }}
    </p>
    <p v-else-if="prefixWarn" class="note warn">
      该服务商的 Key 通常以 <code>{{ prefix }}</code> 开头，确认没有粘错
    </p>
    <p v-else-if="hint" class="hint t-3">{{ hint }}</p>
  </div>
</template>

<style scoped>
/* 标签与输入框之间 8（表单行配方） */
.sec {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.box {
  gap: var(--gap-tight);
  min-height: var(--control-md);
  padding: var(--sp-4) var(--sp-12) var(--sp-4) var(--sp-16);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.ic {
  flex: none;
  color: var(--text-2);
}

.box input {
  flex: 1;
  min-width: 0;
  min-height: var(--control-md);
  padding: 0;
  font-size: var(--fs-subhead);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.mini {
  position: relative;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

.mini:active {
  background: var(--line);
}

/* 密钥行里两颗 30 圆钮：纵向撑到 44，横向不外扩（两颗之间只隔 2px） */
.mini::after {
  content: '';
  position: absolute;
  inset: -7px 0;
}

.mini:disabled {
  opacity: var(--disabled-opacity);
}

.hint,
.note {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  padding: 0 var(--sp-2);
}

.note {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  color: var(--ok-strong);
}

/* 失败态：读不到剪贴板 / 剪贴板是空的 —— 不能涂成成功绿 */
.note.bad {
  color: var(--warn-strong);
}

.note.warn {
  color: var(--text-2);
}

.note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--surface-2);
  border-radius: var(--radius-xs);
  padding: var(--sp-2) var(--sp-4);
}
</style>
