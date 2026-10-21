<script setup lang="ts">
/** 快捷入口磁贴：圆形图标 + 文字标签。图标底色/颜色由父级以内联样式传入。 */
defineProps<{
  label: string
  iconBg?: string
  iconColor?: string
}>()
</script>

<template>
  <button class="qa col center">
    <i class="ic center" :style="{ background: iconBg, color: iconColor }">
      <slot />
    </i>
    {{ label }}
  </button>
</template>

<style scoped>
.qa {
  /* 磁贴是「功能入口」：圆角 20（--radius-l），图标与标签上下 8（--gap-sm），
     上下内距统一 12（原来 12/10 不对称，一排磁贴的标签基线会高低不一） */
  gap: var(--gap-sm);
  width: 100%;
  padding: var(--sp-12) 0;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ic {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
