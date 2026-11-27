<script setup lang="ts">
defineProps<{
  label: string
}>()
</script>

<template>
  <button class="qa col center">
    <i class="ic center">
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
  background: var(--surface-2);
  color: var(--text-1);
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .qa:hover .ic {
    background: var(--accent-soft);
    color: var(--accent);
  }
}
</style>
