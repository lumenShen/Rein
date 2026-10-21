<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import { X } from 'lucide-vue-next'

import { checkName, splitExt } from '@/files/sort'
import type { FileItem } from '@/files/types'

/**
 * 批量重命名：**先预览、再执行**。
 *
 * 三种规则可叠加（查找替换 + 前后缀 + 编号），任何一步都能在右侧预览里看到结果 ——
 * 批量改名最怕的是「改完才发现规律写错了」，预览就是那道刹车。
 *
 * 冲突与非法名在预览里逐条标红并阻止执行：同批内重名、与现有同名、非法字符、空名。
 * 真正落库仍是一条一条走操作队列（每步都可取消），这里只负责把「要改成什么」算清楚。
 */
const props = defineProps<{
  items: FileItem[]
  /** 当前目录里的其他名字（冲突检查用；不含 items 自己的原名） */
  siblingNames: string[]
}>()

const emit = defineEmits<{
  apply: [pairs: { item: FileItem; name: string }[]]
  close: []
}>()

const find = ref('')
const replace = ref('')
const useRegex = ref(false)
const ignoreCase = ref(true)
const prefix = ref('')
const suffix = ref('')
/** 编号：空 = 不编号；模板里的 {n} 会被替换成序号（无 {n} 时追加到末尾） */
const numberTpl = ref('')
const numberStart = ref(1)
const numberPad = ref(2)

/** 扩展名是否参与查找替换（默认不动，避免把 .md 换成别的） */
const touchExt = ref(false)

const regexError = computed(() => {
  if (!useRegex.value || !find.value) return ''
  try {
    new RegExp(find.value, ignoreCase.value ? 'gi' : 'g')
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : '正则不合法'
  }
})

const pairs = computed(() => {
  if (regexError.value) return []
  const out: { item: FileItem; name: string; error?: string; changed: boolean }[] = []
  const taken = new Set(props.siblingNames)
  const batch = new Set<string>()

  props.items.forEach((item, index) => {
    const { stem, ext } = splitExt(item.name)
    const target = touchExt.value ? item.name : stem
    let next = target

    // 1) 查找替换（可选正则）
    if (find.value) {
      if (useRegex.value) {
        const re = new RegExp(find.value, ignoreCase.value ? 'gi' : 'g')
        next = next.replace(re, replace.value)
      } else {
        const flags = ignoreCase.value ? 'gi' : 'g'
        const esc = find.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        next = next.replace(new RegExp(esc, flags), replace.value)
      }
    }
    // 2) 前后缀
    next = `${prefix.value}${next}${suffix.value}`
    // 3) 编号（无 {n} 时追加到末尾）
    if (numberTpl.value.trim()) {
      const n = String(Number(numberStart.value) + index).padStart(
        Math.max(1, Number(numberPad.value) || 1),
        '0',
      )
      next = numberTpl.value.includes('{n}') ? numberTpl.value.replace(/\{n\}/g, n) : `${next}${numberTpl.value.replace(/\{n\}/g, n)}`
    }

    const full = touchExt.value || !ext ? next : `${next}.${ext}`
    const changed = full !== item.name
    let error: string | undefined
    if (changed) {
      const check = checkName(full, item.name)
      if (!check.ok) error = check.reason
      else if (taken.has(full)) error = '与目录里已有的名字冲突'
      else if (batch.has(full)) error = '与本次批量里的另一个目标重名'
      batch.add(full)
    }
    out.push({ item, name: full, error, changed })
  })
  return out
})

const changedCount = computed(() => pairs.value.filter((p) => p.changed && !p.error).length)
const errorCount = computed(() => pairs.value.filter((p) => p.error).length)
const canApply = computed(() => changedCount.value > 0 && errorCount.value === 0)

function apply(): void {
  if (!canApply.value) return
  emit(
    'apply',
    pairs.value.filter((p) => p.changed && !p.error).map((p) => ({ item: p.item, name: p.name })),
  )
}

const nameInput = ref<HTMLInputElement | null>(null)
watch(
  () => props.items.length,
  () => nameInput.value?.focus(),
)
</script>

<template>
  <section class="card br">
    <div class="row head">
      <span class="flex-1"><b>批量重命名 · {{ items.length }} 项</b></span>
      <button class="btn ghost tiny" @click="emit('close')"><X :size="13" /> 关闭</button>
    </div>

    <div class="grid">
      <label class="field">
        <span>查找</span>
        <input ref="nameInput" v-model="find" placeholder="要替换掉的文字" aria-label="查找文字">
      </label>
      <label class="field">
        <span>替换为</span>
        <input v-model="replace" placeholder="留空 = 删除" aria-label="替换文字">
      </label>
      <label class="field">
        <span>前缀</span>
        <input v-model="prefix" placeholder="如 2026-" aria-label="前缀">
      </label>
      <label class="field">
        <span>后缀</span>
        <input v-model="suffix" placeholder="如 -草稿" aria-label="后缀">
      </label>
      <label class="field">
        <span>编号</span>
        <input v-model="numberTpl" placeholder="含 {n}，如 _v{n}" aria-label="编号模板">
      </label>
      <div class="field row padrow">
        <label class="mini">
          起始
          <input v-model.number="numberStart" type="number" min="0" class="num" aria-label="编号起始">
        </label>
        <label class="mini">
          位数
          <input v-model.number="numberPad" type="number" min="1" max="6" class="num" aria-label="编号位数">
        </label>
      </div>
    </div>

    <div class="row toggles">
      <label class="mini"><input v-model="useRegex" type="checkbox"> 用正则</label>
      <label class="mini"><input v-model="ignoreCase" type="checkbox"> 忽略大小写</label>
      <label class="mini"><input v-model="touchExt" type="checkbox"> 连扩展名一起改</label>
    </div>

    <p v-if="regexError" class="err"><TriangleAlert :size="12" /> {{ regexError }}</p>

    <div class="preview">
      <div v-for="p in pairs.slice(0, 40)" :key="p.item.id" class="prev" :class="{ bad: !!p.error, ok: p.changed && !p.error }">
        <span class="old">{{ p.item.name }}</span>
        <span class="arrow">→</span>
        <span class="new">{{ p.name }}</span>
        <span v-if="p.error" class="badge">{{ p.error }}</span>
      </div>
      <p v-if="items.length > 40" class="t-3 more">只预览前 40 项，执行仍按全部。</p>
      <p v-if="!changedCount && !errorCount" class="t-3 more">还没有任何名称会变化 —— 填一条规则试试。</p>
    </div>

    <div class="row foot">
      <span class="t-3 sum">
        {{ changedCount }} 项会改名<template v-if="errorCount">，{{ errorCount }} 项有冲突</template>
      </span>
      <button class="btn" :disabled="!canApply" @click="apply">执行重命名</button>
    </div>
  </section>
</template>

<style scoped>
.br {
  padding: var(--pad-card-tight) var(--pad-inline);
}

.head {
  align-items: center;
  gap: var(--sp-8);
}

.head b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--gap-sm) var(--gap-md);
  margin-top: var(--gap-md);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.field input {
  min-height: var(--control-sm);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}

.padrow {
  flex-direction: row;
  align-items: center;
  gap: var(--sp-10);
}

.mini {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.num {
  width: 58px;
  min-height: var(--control-sm);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}

.toggles {
  gap: var(--sp-12);
  margin-top: var(--sp-8);
  flex-wrap: wrap;
}

.preview {
  max-height: 180px;
  margin-top: var(--gap-md);
  padding: var(--sp-8);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  overflow: auto;
  font-size: var(--fs-caption);
}

.prev {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  padding: var(--sp-4) 0;
  color: var(--text-2);
}

.prev.ok .new {
  color: var(--accent);
}

.prev.bad .new,
.prev.bad .badge {
  color: var(--danger-strong);
}

.old {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new {
  flex: 0 1 auto;
  font-weight: var(--fw-regular);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  flex: none;
  font-size: var(--fs-caption);
}

.more {
  font-size: var(--fs-caption);
}

.err {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  margin-top: var(--sp-8);
  font-size: var(--fs-caption);
  color: var(--danger-strong);
}

.foot {
  align-items: center;
  gap: var(--gap-md);
  margin-top: var(--gap-md);
}

.sum {
  flex: 1;
  font-size: var(--fs-caption);
}

.btn.ghost.tiny {
  padding: var(--sp-4) var(--sp-10);
  font-size: var(--fs-caption);
}
</style>
