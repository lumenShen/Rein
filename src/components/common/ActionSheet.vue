<script setup lang="ts">
import { watch } from 'vue'

/** iOS 操作面板：底部圆角卡片 + 选项列表 + 取消。用于确认类操作。 */
const props = defineProps<{
  open: boolean
  title?: string
  actions: { label: string; value: string; danger?: boolean }[]
}>()

const emit = defineEmits<{
  close: []
  select: [value: string]
}>()

/** 锁背景滚动；恢复打开前的值而非直接清空，避免盖在 SheetModal 上时提前解锁背景 */
let prevOverflow = ''
watch(
  () => props.open,
  (open) => {
    if (open) {
      prevOverflow = document.documentElement.style.overflow
      document.documentElement.style.overflow = 'hidden'
    } else {
      document.documentElement.style.overflow = prevOverflow
    }
  },
)

function pick(value: string): void {
  emit('select', value)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="as-mask">
      <div v-if="open" class="mask" @click="emit('close')" />
    </Transition>
    <Transition name="as-card">
      <div v-if="open" class="card-wrap" role="dialog" :aria-label="title ?? '操作'">
        <p v-if="title" class="title">{{ title }}</p>
        <button
          v-for="a in actions"
          :key="a.value"
          type="button"
          class="opt"
          :class="{ danger: a.danger }"
          @click="pick(a.value)"
        >
          {{ a.label }}
        </button>
        <button type="button" class="opt cancel" @click="emit('close')">取消</button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.card-wrap {
  position: fixed;
  /* 离底栏一个卡片间距（--gap-md）：面板像停在 Dock 上方的一叠卡片 */
  bottom: calc(var(--dock-top) + var(--gap-md));
  left: 50%;
  transform: translateX(-50%);
  /* 两侧各留 12：动作面板与手机 / 桌面同一条页边距节奏 */
  width: calc(100% - var(--sp-24));
  max-width: calc(var(--frame-max) - var(--sp-24));
  z-index: 111;
  background: var(--surface);
  /* 与 SheetModal / 更新弹窗同层同圆角：顶层浮层统一 32（--radius-xl）；
     内距也回到同一档 16（--pad-sheet）—— 此前 8 是这一族里唯一的例外，
     面板边缘与行高亮底之间看起来比抽屉紧一档 */
  border-radius: var(--radius-xl);
  padding: var(--pad-sheet);
  box-shadow: var(--shadow-float);
}

.title {
  text-align: center;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  /* 说明行：上边由面板的 16 内距承担，这里只补下方 8，与下面的行拉开一档
     （--text-3 只有 3.6:1，而这一行常常就是「请选择要保存到哪里」，读到才能选对） */
  padding: 0 0 var(--sp-8);
}

.opt {
  width: 100%;
  /* 菜单 / 操作面板行高 48（--row-h）、圆角 20（--radius-l）、左右 16：
     与设置行、菜单项同一档，此前 50 / 16 是两套各写各的 */
  height: var(--row-h);
  padding: 0 var(--pad-row);
  border-radius: var(--radius-l);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

/* 危险操作是**文字**：实底档 --danger 压在白底上只有约 3.5:1，按 tokens.css 的
   色彩契约（实底档给填充 / 图标，文字走 --*-strong）换成 --danger-strong */
.opt.danger {
  color: var(--danger-strong);
}

.opt.cancel {
  /* 取消与上面的选项是两组按钮 → 间隔 8（无边界那档） */
  margin-top: var(--gap-sm);
  border-top: 0.5px solid var(--line);
  border-radius: var(--radius-l);
}

.as-mask-enter-active,
.as-mask-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.as-mask-enter-from,
.as-mask-leave-to {
  opacity: 0;
}

/* 丰富档：遮罩改成透镜式显现（与 SheetModal 同一套，理由与代价见那里的注释） */
html[data-motion='rich'] .mask {
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

html[data-motion='rich'] .as-mask-enter-active,
html[data-motion='rich'] .as-mask-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    backdrop-filter var(--dur-base) var(--ease-out);
}

html[data-motion='rich'] .as-mask-enter-from,
html[data-motion='rich'] .as-mask-leave-to {
  backdrop-filter: blur(0);
  -webkit-backdrop-filter: blur(0);
}

/* 进出同路径：自底弹起；退出更快（取消操作要干脆） */
.as-card-enter-active {
  transition:
    transform var(--dur-sheet) var(--ease-sheet),
    opacity var(--dur-sheet) var(--ease-sheet);
}

.as-card-leave-active {
  transition:
    transform 200ms var(--ease-standard),
    opacity 200ms var(--ease-standard);
}

.as-card-enter-from,
.as-card-leave-to {
  transform: translate(-50%, 24px);
  opacity: 0;
}
</style>
