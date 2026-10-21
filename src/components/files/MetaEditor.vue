<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Star, Tag, X } from 'lucide-vue-next'

import { kbService } from '@/services/kbService'
import { useToast } from '@/composables/useToast'
import type { FileItem } from '@/files/types'

/**
 * 用户元数据编辑器：评分 / 标签 / 注释。
 *
 * 三样东西都**不进索引**（迁移 0041 的取舍）：它们是「人给文件加的话」，
 * 让标签进入检索会把「训练」这类词变成到处都是的噪声词。
 * 所以这里改完不需要重索引，也不需要刷新目录 —— 就地改、就地生效。
 *
 * 写入是「只传改动的字段」（`kb_meta_set` 的契约），所以三个控件各改各的，互不覆盖。
 */
const props = defineProps<{ item: FileItem }>()
const emit = defineEmits<{ changed: [item: FileItem] }>()

const toast = useToast()
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const rating = ref(props.item.rating ?? 0)
const tags = ref<string[]>([...(props.item.tags ?? [])])
const note = ref('')
const busy = ref(false)
const newTag = ref('')
const noteLoaded = ref(false)

/** 注释正文不在列表响应里（避免一层的响应被长文本撑肥），展开详情时按需取 */
async function loadNote(): Promise<void> {
  const fid = props.item.fileId
  if (fid === undefined || noteLoaded.value) return
  try {
    const f = await kbService.fileGet(fid)
    note.value = f.note ?? ''
    noteLoaded.value = true
  } catch {
    /* 详情是附加信息：拿不到就先空着 */
  }
}

watch(
  () => props.item.id,
  () => {
    rating.value = props.item.rating ?? 0
    tags.value = [...(props.item.tags ?? [])]
    note.value = ''
    noteLoaded.value = false
    void loadNote()
  },
  { immediate: true },
)

async function save(patch: { rating?: number; tags?: string[]; note?: string }): Promise<void> {
  const fid = props.item.fileId
  if (fid === undefined) return
  busy.value = true
  try {
    const f = await kbService.metaSet({ id: fid, ...patch })
    emit('changed', { ...props.item, rating: f.rating, tags: f.tags, hasNote: f.note.trim().length > 0 })
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    busy.value = false
  }
}

function setRating(n: number): void {
  // 再点同一颗星 = 取消评分（0 = 未评），不必再找一个「清除」按钮
  const next = rating.value === n ? 0 : n
  rating.value = next
  void save({ rating: next })
}

function addTag(): void {
  const t = newTag.value.trim()
  if (!t || tags.value.includes(t)) {
    newTag.value = ''
    return
  }
  tags.value = [...tags.value, t].slice(0, 30)
  newTag.value = ''
  void save({ tags: tags.value })
}

function removeTag(t: string): void {
  tags.value = tags.value.filter((x) => x !== t)
  void save({ tags: tags.value })
}

const noteDirty = computed(() => noteLoaded.value && note.value !== undefined)

function saveNote(): void {
  if (!noteLoaded.value) return
  void save({ note: note.value })
}
</script>

<template>
  <div class="meta">
    <div class="row line">
      <span class="k">评分</span>
      <span class="stars">
        <button
          v-for="n in 5"
          :key="n"
          class="star"
          :class="{ on: n <= rating }"
          :aria-label="`评 ${n} 星`"
          :aria-pressed="n <= rating"
          :disabled="busy"
          @click="setRating(n)"
        >
          <Star :size="14" />
        </button>
        <span v-if="rating" class="t-3 val">{{ rating }}/5</span>
      </span>
    </div>

    <div class="row line">
      <span class="k">标签</span>
      <span class="tags">
        <span v-for="t in tags" :key="t" class="tag">
          {{ t }}
          <button class="x" :aria-label="`移除标签 ${t}`" :disabled="busy" @click="removeTag(t)">
            <X :size="10" />
          </button>
        </span>
        <span class="adder">
          <Tag :size="11" class="t-3" />
          <input
            v-model="newTag"
            placeholder="加标签"
            aria-label="新增标签"
            :disabled="busy"
            @keydown.enter.prevent="addTag"
            @blur="addTag"
          >
        </span>
      </span>
    </div>

    <div class="line note">
      <span class="k">注释</span>
      <textarea
        v-model="note"
        rows="2"
        placeholder="给这个文件写点备注（失焦自动保存；不进检索，只给人看）"
        aria-label="文件注释"
        :disabled="busy"
        @blur="saveNote"
      />
      <!-- 可点控件只写动作：文案「保存注释」+ Check 图标。
           「失焦自动保存」是保存机制的说明，已收进 placeholder，不占着一个按钮解释原理 -->
      <button v-if="noteDirty" class="savelink" :disabled="busy" @click="saveNote">
        <Check :size="10" /> 保存注释
      </button>
    </div>
  </div>
</template>

<style scoped>
.meta {
  display: grid;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 0.5px solid var(--line);
}

.line {
  align-items: center;
  gap: var(--gap-md);
}

.k {
  flex: none;
  width: 42px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stars {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.star {
  padding: var(--sp-2);
  color: var(--line-strong);
}

.star.on {
  color: var(--warn);
}

.val {
  margin-left: var(--sp-8);
  font-size: var(--fs-caption);
}

.tags {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex-wrap: wrap;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--chip-h);
  padding: 0 var(--sp-8) 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: var(--fs-caption);
}

.x {
  display: inline-flex;
  padding: var(--sp-2);
  border-radius: var(--radius-full);
  color: inherit;
  opacity: 0.7;
}

.adder {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.adder input {
  width: 72px;
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.note {
  align-items: flex-start;
}

.note textarea {
  flex: 1;
  min-width: 0;
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  resize: vertical;
}

/* 保存入口：一枚文字链（动作式文案见模板）。--accent 当链接色是 tokens 认可的用法
   （实底档当图标 / 链接 / 强调描边，压在画布上 5.19:1） */
.savelink {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  color: var(--accent);
  font-size: var(--fs-caption);
}
</style>
