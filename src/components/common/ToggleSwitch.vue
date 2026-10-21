<script setup lang="ts">
/** iOS 风格开关（受控组件）：开 = 系统绿，滑块走 spring 曲线（令牌里就是为它留的）。 */
defineProps<{
  modelValue: boolean
  /** 无障碍名（开关本体是按钮，必须自带可读名） */
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    class="sw"
    :class="{ on: modelValue }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <i class="knob" />
  </button>
</template>

<style scoped>
.sw {
  position: relative;
  width: 51px;
  height: 31px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  transition: background-color var(--dur-base) var(--ease-standard);
}

/* 视觉 51×31 是 iOS 规格，不为了触控放大；热区向上下各撑到 44。
   开关在行尾，外扩的两条横带落在行内空白里，不会压到相邻控件。 */
.sw::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--hit-min);
  transform: translateY(-50%);
  border-radius: var(--radius-full);
}

.sw.on {
  background: var(--ok);
}

.sw:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

.knob {
  position: absolute;
  /* 滑块与轨道之间的缝：2（--sp-2），与左右对称 */
  top: var(--sp-2);
  left: var(--sp-2);
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: var(--switch-knob);
  box-shadow: var(--shadow-thumb);
  transition:
    transform var(--dur-base) var(--ease-spring),
    width var(--dur-fast) var(--ease-standard);
}

.sw.on .knob {
  transform: translateX(20px);
}

/* 按压缩放的是滑块而不是整条轨道（与 iOS 一致）：轨道不动，滑块在按下时
   横向拉伸 4px，松手回弹。全局 button:active 的 scale(.96) 在这里摘掉 ——
   整条开关一起缩会读成「整行被按了一下」，而不是「手柄被捏住」。
   开启态右移量同步收 4px，拉伸后才不会顶出轨道右缘。 */
.sw:active {
  transform: none;
}

.sw:active .knob {
  width: 31px;
}

.sw.on:active .knob {
  transform: translateX(16px);
}

@media (prefers-reduced-motion: reduce) {
  .sw,
  .knob {
    transition: none;
  }
}
</style>
