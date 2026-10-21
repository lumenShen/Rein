<script setup lang="ts">
import { ref } from 'vue'
import { Copy, SkipForward, TriangleAlert } from 'lucide-vue-next'

import type { ConflictPolicy } from '@/files/types'

/**
 * 同名冲突询问。
 *
 * 刻意做成**页内卡片**而不是模态框：冲突是「这批操作的一部分」，
 * 用户需要一边看着列表一边决定，模态框会把上下文挡住。
 *
 * 三个选项就是文件管理器里那三种老规矩：替换 / 跳过 / 保留两者；
 * 「记住这个选择」把策略记到本次会话，后续同类操作不再打扰（可在菜单里改回「每次都问」）。
 */
defineProps<{
  label: string
  /** 冲突的名字（最多展示若干条） */
  names: string[]
  total: number
}>()

const emit = defineEmits<{
  choose: [policy: ConflictPolicy, remember: boolean]
  cancel: []
}>()

const remember = ref(false)
</script>

<template>
  <section class="card cf">
    <div class="row head">
      <TriangleAlert :size="15" class="warn" />
      <span class="flex-1">
        <b>{{ label }}</b>
        <small>{{ total }} 项里有 {{ names.length }} 个名字已经存在，怎么办？</small>
      </span>
    </div>

    <ul class="names">
      <li v-for="n in names.slice(0, 8)" :key="n">{{ n }}</li>
      <li v-if="names.length > 8" class="t-3">…另有 {{ names.length - 8 }} 个</li>
    </ul>

    <div class="row acts">
      <button class="btn" @click="emit('choose', 'replace', remember)">替换同名</button>
      <button class="btn ghost" @click="emit('choose', 'skip', remember)">跳过这些</button>
      <button class="btn ghost" @click="emit('choose', 'keepBoth', remember)">
        <Copy :size="13" /> 保留两者
      </button>
      <button class="btn ghost" @click="emit('cancel')"><SkipForward :size="13" /> 取消本次</button>
    </div>
    <label class="mini"><input v-model="remember" type="checkbox"> 以后都这样（本次会话内不再问）</label>
  </section>
</template>

<style scoped>
.cf {
  padding: var(--pad-card-tight) var(--pad-inline);
}

.head {
  align-items: flex-start;
  gap: var(--sp-8);
}

.head b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.head small {
  display: block;
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.warn {
  flex: none;
  margin-top: var(--sp-2);
  color: var(--warn);
}

.names {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4) var(--sp-8);
  margin: var(--sp-8) 0 0;
  padding: 0;
  list-style: none;
}

.names li {
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--warn-soft);
  color: var(--warn-strong);
  font-size: var(--fs-caption);
}

.acts {
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  flex-wrap: wrap;
}

.mini {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.btn.ghost {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
}
</style>
