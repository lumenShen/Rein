<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'

/**
 * 设置行（图标章 + 标题 / 副标 + 右侧插槽）。
 *
 * 设置页、连接应用、运动设置这些清单页里的「一行一个入口」全都长这样：34 的图标章、
 * 主标题 + 一行灰副标、右侧一颗尖括号或状态控件。抽成一个组件是为了**行高只有一份**
 * —— 双行 64 / 单行 48（`--row-h-double` / `--row-h`），触控目标不会因为哪一页手写
 * 而缩到 44 以下（桌面审计会查）。
 *
 * 三种打开方式，互不排斥：
 *   · `to`    —— 站内跳转（router.push）
 *   · `@click` —— 就地动作（开抽屉 / 切换），事件照常发出
 *   · 两者都给 —— 先发事件再跳转（很少见，但语义明确）
 *
 * 右侧默认是尖括号；传默认插槽即可换成胶囊 / 开关 / `+` `✓` 之类的控件。
 * **插槽里放按钮时把 `as` 改成 `'div'`** —— 行本身可点的话，控件会嵌在 `<button>`
 * 里面（无效 DOM，点控件还会冒泡成整行点击）。
 * 图标章的着色用 `accent` 传模块色变量前缀（如 `--mod-program`），底色取
 * `<accent>-soft`、前景取 `<accent>-strong`；不传则用主色。
 */
const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    icon?: Component
    /** 模块色变量前缀，如 `--mod-program`（不要带 `var()`） */
    accent?: string
    /** 站内落点；与 `@click` 可同时使用 */
    to?: RouteLocationRaw
    /** 行根 testid（e2e 按它定位） */
    testid?: string
    disabled?: boolean
    /** 行根元素：默认可点的 button；右侧插槽自带控件时用 div，避免按钮嵌套 */
    as?: 'button' | 'div'
  }>(),
  { as: 'button' },
)

const emit = defineEmits<{ click: [] }>()

const router = useRouter()

const iconStyle = computed(() =>
  props.accent
    ? { background: `var(${props.accent}-soft)`, color: `var(${props.accent}-strong)` }
    : { background: 'var(--accent-soft)', color: 'var(--accent)' },
)

/** 行高跟内容走：有副标才需要 64，单行压回 48 */
const minHeight = computed(() => (props.subtitle ? 'var(--row-h-double)' : 'var(--row-h)'))

function activate(): void {
  if (props.disabled) return
  emit('click')
  if (props.to) void router.push(props.to)
}
</script>

<template>
  <component
    :is="as"
    :type="as === 'button' ? 'button' : undefined"
    class="settings-row"
    :style="{ minHeight }"
    :disabled="as === 'button' ? disabled : undefined"
    :aria-disabled="as === 'div' && disabled ? 'true' : undefined"
    :data-testid="testid"
    @click="activate"
  >
    <i v-if="icon || $slots.icon" class="row-ic" :style="iconStyle" aria-hidden="true">
      <slot name="icon">
        <component :is="icon" v-if="icon" :size="18" />
      </slot>
    </i>
    <span class="row-txt">
      <b>{{ title }}</b>
      <em v-if="subtitle">{{ subtitle }}</em>
    </span>
    <span class="row-tail">
      <slot>
        <ChevronRight :size="16" />
      </slot>
    </span>
  </component>
</template>

<style scoped>
/* 与 SettingsPage 的 `.frow` 同一档：整行可点、左对齐、继承文字色。
   行高由 style 里的 minHeight 决定（64 双行 / 48 单行），这里不写死。 */
.settings-row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  padding: 0;
  text-align: left;
  color: inherit;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.settings-row:active:not(:disabled) {
  transform: scale(0.995);
}

.settings-row:disabled,
.settings-row[aria-disabled='true'] {
  opacity: var(--disabled-opacity);
}

/* 34 的图标章：与设置页 `.fic` 同一几何（圆角走 --radius-s）。
   34 这一档没有对应的尺寸 token，几何值就地写死并在此说明。 */
.row-ic {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-s);
}

.row-txt {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--gap-text);
}

.row-txt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.row-txt em {
  font-style: normal;
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-2);
}

/* 右侧插槽：控件自身决定宽度，行不压缩它 */
.row-tail {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-sm);
  color: var(--text-3);
}
</style>
