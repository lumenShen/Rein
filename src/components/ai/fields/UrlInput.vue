<script setup lang="ts">
/**
 * 服务地址输入（专用组件）：网关地址是「填错一个字就全盘不通」的字段，
 * 所以这里把常见错法直接挡在手边。
 *
 * - 失焦时归一：去空白、去结尾斜杠（`…/v1/` 与 `…/v1` 是同一个端点，留两种写法
 *   只会让「同不同一个账号」的判重失效）；
 * - 协议检查：http/https（语音网关用 wss），缺协议的当场提示；
 * - **恢复默认**：适配器给的默认地址一键回填（用户改坏了不必去查文档）。
 */
import { computed, ref } from 'vue'
import { Globe, RotateCcw } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 输入框 id（label / 测试选择器用） */
    id?: string
    placeholder?: string
    /** 适配器/接入方式的默认地址（有值且与当前不同时显示「恢复默认」） */
    defaultBaseUrl?: string
    /** 允许的协议前缀 */
    schemes?: string[]
    hint?: string
    disabled?: boolean
    ariaLabel?: string
  }>(),
  {
    placeholder: 'https://…',
    defaultBaseUrl: '',
    schemes: () => ['http://', 'https://'],
    hint: '',
    disabled: false,
    ariaLabel: '服务地址',
  },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const touched = ref(false)

function normalize(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

function onBlur(): void {
  touched.value = true
  const v = normalize(props.modelValue)
  if (v !== props.modelValue) emit('update:modelValue', v)
}

const invalid = computed(() => {
  if (!touched.value) return false
  const v = props.modelValue.trim()
  if (!v) return true
  return !props.schemes.some((s) => v.toLowerCase().startsWith(s))
})

const canReset = computed(
  () => !!props.defaultBaseUrl && normalize(props.modelValue) !== normalize(props.defaultBaseUrl),
)

function reset(): void {
  emit('update:modelValue', normalize(props.defaultBaseUrl))
  touched.value = true
}
</script>

<template>
  <div class="url">
    <div class="row center box" :class="{ bad: invalid }">
      <Globe :size="15" class="ic" />
      <input
        :id="id"
        type="text"
        inputmode="url"
        :value="modelValue"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :disabled="disabled"
        @input="onInput"
        @blur="onBlur"
      >
      <button v-if="canReset" type="button" class="reset" @click="reset">
        <RotateCcw :size="12" />
        恢复默认
      </button>
    </div>
    <p v-if="invalid" class="hint warn">
      地址要以 {{ schemes.join(' 或 ') }} 开头
    </p>
    <p v-else-if="hint" class="hint t-3">{{ hint }}</p>
  </div>
</template>

<style scoped>
/* 标签与输入框之间 8（表单行配方） */
.url {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.box {
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: var(--sp-4) var(--sp-12) var(--sp-4) var(--sp-16);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.box.bad {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 45%, transparent);
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
}

.reset {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-3);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.hint {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  padding: 0 var(--sp-2);
}

.hint.warn {
  color: var(--danger);
}
</style>
