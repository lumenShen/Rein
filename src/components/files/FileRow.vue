<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'

import FileIcon from './FileIcon.vue'
import { useLongPress } from '@/files/useLongPress'
import { checkName, extChanged, formatFullWhen, formatWhen, kindLabel, splitExt } from '@/files/sort'
import type { ColumnDef } from '@/files/registry'
import type { FileItem } from '@/files/types'
import { KB_SOURCE_LABELS, type KbSourceType } from '@/types'
import { humanBytes } from '@/utils/format'

/**
 * 列表里的一行。
 *
 * 布局由 `wide` 切换（同一个组件，不是两个组件）：宽屏走表格式多列，
 * 窄屏走「名称 + 元信息」两行 —— 且**大小与日期是定宽右对齐的列**，
 * 于是每一行的「名称 / 类型 / 大小 / 日期 / 状态」都对齐（移动端扫列表靠这个）。
 *
 * 手势分两套语义，由 `touch` 切换：
 * - 触屏：单击选中（文件夹单击直接打开）、双击用默认方式打开、长按弹菜单；
 *   多选态下（`selectMode`）行首出现勾选框，单击改为切换选中。
 * - 桌面（细指针）：单击选中、双击打开、右键菜单（与前者一致，只是没有长按）。
 *
 * 「🔒 / 钉住」不再单独占行尾一格：它们走 FileIcon 的徽章，落在**图标右下角**，
 * 行尾只留大小与日期两列，列才对齐得起来。
 */
const props = withDefaults(
  defineProps<{
    item: FileItem
    selected: boolean
    focused: boolean
    cut: boolean
    dragOver: boolean
    editing: boolean
    /** 宽屏：表格式多列 */
    wide?: boolean
    /** 宽屏要显示的列（来自列注册表，用户在列菜单里选过） */
    columns?: ColumnDef[]
    /** 剪贴板非空时高亮「可以粘贴进来」的目录 */
    pasteTarget?: boolean
    /** 触屏语义（长按菜单、单击选中/打开） */
    touch?: boolean
    /** 多选态：行首画勾选框，单击改为切换选中 */
    selectMode?: boolean
  }>(),
  { wide: false, pasteTarget: false, touch: false, selectMode: false, columns: () => [] },
)

const emit = defineEmits<{
  activate: [item: FileItem, ev: MouseEvent]
  open: [item: FileItem]
  menu: [item: FileItem, anchor: HTMLElement | null]
  dragStart: [item: FileItem, ev: DragEvent]
  dragEnd: []
  /** 悬停（dragenter/dragover 期间持续触发）：只做高亮 */
  dragOver: [item: FileItem, ev: DragEvent]
  /** 落下：只触发一次，真正执行移动/复制 */
  drop: [item: FileItem, ev: DragEvent]
  renameCommit: [item: FileItem, name: string]
  renameCancel: []
}>()

const nameInput = ref<HTMLInputElement | null>(null)
const draft = ref('')
const nameError = ref('')

/** 源标签：派生投影标注它来自哪一类应用数据（notes 不必标） */
const sourceLabel = computed(() => {
  const st = props.item.sourceType
  if (!st || st === 'note') return ''
  return KB_SOURCE_LABELS[st as KbSourceType] ?? st
})

const sizeLabel = computed(() => {
  if (props.item.isDir) return props.item.childCount > 0 ? `${props.item.childCount} 项` : '空'
  return props.item.size !== undefined ? humanBytes(props.item.size) : ''
})

const timeLabel = computed(() => formatWhen(props.item.modifiedAt))

/** 第二行左半：类型（派生投影说来源，普通文件说扩展名） */
const typeText = computed(() => {
  if (props.item.isDir) return '文件夹'
  if (sourceLabel.value) return sourceLabel.value
  const ext = (props.item.extension ?? '').toUpperCase()
  const kind = kindLabel(props.item.kind)
  return ext ? `${kind} · ${ext}` : kind
})

/** 第二行右半：状态（只读 / 钉住 / 归类），没有就不占位 */
const statusText = computed(() => {
  const bits: string[] = []
  if (props.item.attributes.system) bits.push('系统只读')
  else if (props.item.attributes.readOnly) bits.push('只读')
  if (props.item.pinned) bits.push('已钉住')
  if (props.item.classifyState === 'inbox') bits.push('待归类')
  else if (props.item.classifyState === 'filed') bits.push('已归类')
  return bits.join(' · ')
})

const metaLine = computed(() => {
  const bits = [typeText.value]
  if (statusText.value) bits.push(statusText.value)
  return bits.join(' · ')
})

/** 读屏要读全：名称、类型、大小、修改时间、选中态（由 aria-selected 给） */
const ariaLabel = computed(() => {
  const bits = [props.item.name, typeText.value]
  if (props.item.isDir) bits.push(sizeLabel.value || '空目录')
  else if (props.item.size !== undefined) bits.push(humanBytes(props.item.size))
  if (props.item.modifiedAt) bits.push(`修改于 ${formatFullWhen(props.item.modifiedAt)}`)
  if (props.item.attributes.system) bits.push('系统文件，只读')
  else if (props.item.attributes.readOnly) bits.push('只读')
  if (props.item.pinned) bits.push('已钉住')
  if (props.cut) bits.push('待剪切')
  return bits.join('，')
})

/* ---------- 就地改名（F2） ---------- */

watch(
  () => props.editing,
  async (on) => {
    if (!on) return
    draft.value = props.item.name
    nameError.value = ''
    await nextTick()
    const el = nameInput.value
    if (!el) return
    el.focus()
    // 只选中主文件名，扩展名受保护（Windows/macOS 的老规矩）；无扩展名就全选
    const { stem } = splitExt(props.item.name)
    if (stem.length < props.item.name.length) el.setSelectionRange(0, stem.length)
    else el.select()
  },
)

function commitRename(): void {
  const next = draft.value.trim()
  if (next === props.item.name) {
    emit('renameCancel')
    return
  }
  const check = checkName(next, props.item.name)
  if (!check.ok) {
    nameError.value = check.reason ?? '名称不合法'
    nameInput.value?.focus()
    return
  }
  if (extChanged(props.item.name, next)) {
    // 扩展名变了只提示不阻止：内容不会跟着变，用户可能就是想改
    nameError.value = '扩展名已改变，文件内容不会变；打开方式可能失效'
  }
  emit('renameCommit', props.item, next)
}

/* ---------- 长按（触屏）→ 菜单（共享手势，含幽灵点击吞咽） ---------- */

const longPress = useLongPress({
  isTouch: () => props.touch && !props.editing,
  onFire: (el) => emit('menu', props.item, el),
})

function onClick(ev: MouseEvent): void {
  longPress.click(ev, (e) => emit('activate', props.item, e))
}
</script>

<template>
  <li
    class="row"
    :class="{ sel: selected, focus: focused, cut, over: dragOver, dir: item.isDir, paste: pasteTarget }"
    role="option"
    :data-item-id="item.id"
    :aria-selected="selected"
    :aria-label="ariaLabel"
  >
    <div
      class="hit"
      :draggable="!editing"
      @click="onClick"
      @dblclick="emit('open', item)"
      @contextmenu.prevent="emit('menu', item, $event.currentTarget as HTMLElement)"
      @pointerdown="longPress.down($event)"
      @pointermove="longPress.move($event)"
      @pointerup="longPress.cancel()"
      @pointercancel="longPress.cancel()"
      @dragstart="emit('dragStart', item, $event)"
      @dragend="emit('dragEnd')"
      @dragover="emit('dragOver', item, $event)"
      @drop.stop="emit('drop', item, $event)"
    >
      <!-- 多选态的勾选框：出现即表示「这一屏点是选中，不是打开」 -->
      <span v-if="selectMode" class="ck" :class="{ on: selected }" aria-hidden="true">
        <Check :size="12" :stroke-width="3" />
      </span>

      <!-- 图标 + 右下角徽章（🔒 / 钉住 / 云状态）：徽章归 FileIcon，行尾不再占格 -->
      <FileIcon :item="item" :size="18" badges />

      <!-- 就地改名：默认只选中主文件名（见 watch） -->
      <template v-if="editing">
        <span class="name-col">
          <input
            ref="nameInput"
            v-model="draft"
            class="rename"
            :aria-label="`重命名为 ${item.name}`"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="emit('renameCancel')"
            @keydown.stop
            @blur="commitRename"
          >
          <small v-if="nameError" class="err">{{ nameError }}</small>
        </span>
      </template>

      <template v-else-if="wide">
        <span
          v-for="c in columns"
          :key="c.key"
          class="col"
          :class="[`c-${c.key}`, { flex: c.flex, end: c.align === 'end' }]"
          :style="c.width ? { width: `${c.width}px` } : undefined"
        >
          <template v-if="c.key === 'name'">
            <b>{{ item.displayName }}</b>
            <!-- 扩展名只在显示名隐去了它时另标出来（否则等于把名字写两遍） -->
            <small v-if="item.extension && item.displayName !== item.name" class="ext">{{ item.extension }}</small>
          </template>
          <template v-else-if="c.key === 'kind'">{{ sourceLabel || c.value(item) }}</template>
          <template v-else>{{ c.value(item) }}</template>
        </span>
      </template>

      <!-- 窄屏：名称一行；第二行是「类型 · 状态」；大小与日期是定宽右对齐的两列 -->
      <template v-else>
        <span class="name-col">
          <b>{{ item.displayName }}</b>
          <small>{{ metaLine }}</small>
        </span>
        <span class="num size">{{ sizeLabel }}</span>
        <span class="num date">{{ timeLabel }}</span>
      </template>
    </div>
  </li>
</template>

<style scoped>
.row {
  height: 100%;
}

/* 行内：图标 + 名称列 + 元数据列。行是列表**内**的一块，圆角收到 8 那档 */
.hit {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  height: 100%;
  padding: 0 var(--sp-12);
  border-radius: var(--radius-s);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

/* 悬停只在真悬停设备生效：触屏点一下也会留下 :hover 底色 */
@media (hover: hover) {
  .hit:hover {
    background: var(--surface-2);
  }
}

.row.sel .hit {
  background: var(--accent-soft);
}

/* 压在选中底色之上、早于 .focus/.over：键盘焦点与拖放高亮继续优先 */
.row .hit:active {
  background: var(--surface-2);
}

/* 焦点与选中**用两种视觉**：只靠颜色区分选中态对看不见颜色的人等于没有状态 */
.row.focus .hit {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.row.cut .hit {
  opacity: var(--disabled-opacity);
}

.row.over .hit {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

/* 剪贴板非空时，目录行给出「可以放到这里」的暗示 */
.row.dir.paste .hit {
  box-shadow: inset 0 0 0 1px var(--line-strong);
}

/* 勾选框：多选态专用，空框描边、选中实底 */
.ck {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-xs);
  border: 1.5px solid var(--text-3);
  background: var(--surface);
  color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ck.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.name-col {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  flex: 1;
  min-width: 0;
}

.name-col b {
  font-size: var(--fs-body);
  font-weight: var(--fw-regular);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.sel .name-col b {
  font-weight: var(--fw-semibold);
}

.name-col small {
  display: block;
  font-size: var(--fs-caption);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ext {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-caption);
}

/* 窄屏两列：定宽 + 右对齐 + 等宽数字 —— 每一行的大小与日期都对齐 */
.num {
  flex: none;
  text-align: right;
  font-size: var(--fs-caption);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num.size {
  width: 56px;
}

.num.date {
  width: 66px;
}

.col {
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 名称列吃剩余宽度；其余列宽由列定义以内联 style 给（列可配置） */
.col.flex {
  flex: 1;
  min-width: 0;
}

.col.end {
  text-align: right;
}

.rename {
  width: 100%;
  min-height: var(--control-sm);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1.5px var(--accent);
  color: var(--text-1);
  font-size: var(--fs-body);
}

.err {
  display: block;
  margin-top: var(--sp-2);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
}
</style>
