<script setup lang="ts">
import { Play, Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import TimeSpine from './TimeSpine.vue'
import { memoSpine, useVoiceMemos } from '@/composables/useVoiceMemos'
import { voiceService } from '@/services/voiceService'
import { useToast } from '@/composables/useToast'
import { fmtMmSs, fmtMonthDayTime } from '@/utils/format'
import type { VoiceMemo } from '@/types'

/** 全部纪要抽屉：历史语音纪要列表。
 *  每条不是一行文字，而是**一缕时间脊** —— 一眼看出这段有多长、说到哪、哪几句挂着纪要。 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: [memo: VoiceMemo] }>()

const toast = useToast()
const { loading, keyword, filtered, remove } = useVoiceMemos(() => props.open, {
  onError: () => toast.toast('纪要列表加载失败'),
})

/** 纪要 → 缩略脊的段落 */
const spineOf = memoSpine

/** 纪要点挂在句 idx 上，脊按数组位置索引，映射一次 */
const pinsOf = (m: VoiceMemo) => {
  const pos = new Map(m.sentences.map((s, i) => [s.idx, i]))
  return m.summary.flatMap((it) => {
    const ref = it.refs[0]
    const p = ref == null ? undefined : pos.get(ref)
    return p == null
      ? []
      : [{ idx: p, kind: it.kind === 'todo' ? ('todo' as const) : ('answer' as const), text: it.text }]
  })
}

/** 时长写法与 AI 页语音气泡（fmtVoiceDur）统一成 mm:ss：'" 分秒记号在中文界面里
    容易被读成装饰符号，且与其他地方的计时写法不一致 */
function fmtMs(ms: number): string {
  return fmtMmSs(ms)
}

function fmtWhen(iso: string): string {
  return fmtMonthDayTime(iso)
}

async function onDelete(m: VoiceMemo): Promise<void> {
  try {
    await voiceService.memoDelete(m.id)
    remove(m.id)
    toast.toast('已删除纪要')
  } catch {
    toast.toast('删除失败')
  }
}
</script>

<template>
  <SheetModal :open="open" title="全部纪要" initial-snap="large" @close="emit('close')">
    <div class="search">
      <input v-model="keyword" type="text" placeholder="搜索标题或内容…">
    </div>
    <p v-if="!loading && filtered.length === 0" class="empty t-3">
      还没有纪要。打开录音纪要说一段话，完成后会出现在这里。
    </p>
    <ul v-else class="list">
      <li v-for="m in filtered" :key="m.id" class="row" @click="emit('pick', m)">
        <span class="mt">
          <b>{{ m.title || '未命名纪要' }}</b>
          <!-- 时长是这一行的主数值（subhead + text-2 + 等宽），排在最先；
               日期与句数是它的注脚（caption + text-3），两级不用同一个分隔符 -->
          <em>
            <span class="mdur num">{{ fmtMs(m.durationMs) }}</span>
            <span class="mmeta">{{ fmtWhen(m.createdAt) }} · {{ m.sentences.length }} 句</span>
          </em>
          <TimeSpine
            v-if="m.sentences.length"
            class="rowspine"
            size="mini"
            :segments="spineOf(m)"
            :total-ms="m.durationMs"
            :pins="pinsOf(m)"
          />
        </span>
        <button class="play" aria-label="打开该纪要" @click.stop="emit('pick', m)"><Play :size="13" /></button>
        <button class="del" aria-label="删除纪要" @click.stop="onDelete(m)">
          <Trash2 :size="14" />
        </button>
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
  padding: var(--sp-24) var(--sp-8);
  text-align: center;
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
}

.list {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  min-height: var(--row-h-double);
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

.mt {
  flex: 1;
  min-width: 0;
}

/* 每行一缕缩略脊：这是列表的主体视觉，标题只是它的注脚 */
.rowspine {
  display: block;
  margin-top: var(--gap-sm);
}

.mt b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 时长与注脚本是同一直系的两级：基线对齐，主数值在前、注脚靠间距分开 */
.mt em {
  font-style: normal;
  display: flex;
  align-items: baseline;
  gap: var(--sp-8);
  min-width: 0;
  margin-top: 1px;
}

/* 时长是主数值：与标题同档但不抢标题的粗黑（text-2 + 等宽） */
.mt .mdur {
  flex: none;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-2);
}

/* 日期与句数是注脚：caption + text-3，超出省略 */
.mt .mmeta {
  font-size: var(--fs-caption);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.play {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: none;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.del {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: none;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
}

.del:active {
  color: var(--danger);
  background: var(--danger-soft);
}

/* 30 的圆钮（播放 / 删除）命中区撑到 44：同行控件隔 10px，四向外扩 7px 不越界 */
.play::after,
.del::after {
  content: '';
  position: absolute;
  inset: -7px;
}
</style>
