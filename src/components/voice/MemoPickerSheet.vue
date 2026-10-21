<script setup lang="ts">
import SheetModal from '@/components/common/SheetModal.vue'
import TimeSpine from './TimeSpine.vue'
import { memoSpine, useVoiceMemos } from '@/composables/useVoiceMemos'
import { fmtMonthDay } from '@/utils/format'
import type { VoiceMemo } from '@/types'

/** @纪要 选择器：AI 页输入 @ 时弹出，选中后以 chip 附到消息（发送时注入纪要内容）。
 *  每行给一缕缩略脊 —— 挑引用时，「哪一段」比「标题叫什么」更好认。 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: [memo: VoiceMemo] }>()

const { loading, keyword, filtered } = useVoiceMemos(() => props.open, {
  limit: 50,
  clearOnError: true,
})
const spineOf = memoSpine

function fmtWhen(iso: string): string {
  return fmtMonthDay(iso)
}
</script>

<template>
  <SheetModal :open="open" title="引用纪要" initial-snap="medium" @close="emit('close')">
    <div class="search">
      <input v-model="keyword" type="text" placeholder="按标题或内容搜索…" @keydown.enter="filtered[0] && emit('pick', filtered[0])">
    </div>
    <p v-if="!loading && filtered.length === 0" class="empty t-3">没有可引用的纪要。</p>
    <ul v-else class="list">
      <li v-for="m in filtered" :key="m.id" class="row" @click="emit('pick', m)">
        <span class="mt">
          <b>{{ m.title || '未命名纪要' }}</b>
          <em>{{ fmtWhen(m.createdAt) }} · {{ m.sentences.length }} 句</em>
          <TimeSpine
            v-if="m.sentences.length"
            class="rowspine"
            size="mini"
            :segments="spineOf(m)"
            :total-ms="m.durationMs"
          />
        </span>
      </li>
    </ul>
  </SheetModal>
</template>

<style scoped>
.search {
  padding: 0 var(--sp-2) var(--gap-sm);
}

.search input {
  width: 100%;
  min-height: var(--control-md);
  padding: 0 var(--sp-12);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
}

.empty {
  padding: var(--sp-20) var(--sp-8);
  text-align: center;
  font-size: var(--fs-footnote);
}

.list {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  min-height: var(--row-h);
  padding: 0 var(--sp-2);
  border-radius: var(--radius-s);
  cursor: pointer;
}

.row:active {
  background: var(--surface-2);
}

.row + .row {
  border-top: 0.5px solid var(--line);
}

.ic {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-s);
  flex: none;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.mt {
  flex: 1;
  min-width: 0;
}

/* 每行一缕缩略脊 */
.rowspine {
  display: block;
  margin-top: var(--sp-6);
}

.mt b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mt em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
