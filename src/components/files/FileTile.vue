<script setup lang="ts">
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'

import FileIcon from './FileIcon.vue'
import { useLongPress } from '@/files/useLongPress'
import { formatWhen, kindLabel } from '@/files/sort'
import type { FileItem, IconSize } from '@/files/types'
import { humanBytes } from '@/utils/format'

/**
 * 网格里的一块。图标尺寸按档位给（小/中/大），信息只留「名称 + 一行元信息」——
 * 网格的价值在于一眼扫过视觉特征（图片缩略图），塞满文字反而看不清。
 *
 * 手势与 FileRow 同一套（触屏长按菜单 / 多选态勾选框 / 双击打开），
 * 「🔒 / 钉住」走 FileIcon 的徽章（图标右下角），不再在 .art 里另画一个角标。
 */
const props = withDefaults(
  defineProps<{
    item: FileItem
    selected: boolean
    focused: boolean
    cut: boolean
    dragOver: boolean
    editing: boolean
    iconSize?: IconSize
    pasteTarget?: boolean
    /** 触屏语义（长按菜单） */
    touch?: boolean
    /** 多选态：左上角画勾选框，单击改为切换选中 */
    selectMode?: boolean
  }>(),
  { iconSize: 'md', pasteTarget: false, touch: false, selectMode: false },
)

const emit = defineEmits<{
  activate: [item: FileItem, ev: MouseEvent]
  open: [item: FileItem]
  menu: [item: FileItem, anchor: HTMLElement | null]
  dragStart: [item: FileItem, ev: DragEvent]
  dragEnd: []
  /** 悬停（dragover 期间持续触发）：只做高亮 */
  dragOver: [item: FileItem, ev: DragEvent]
  /** 落下：只触发一次 */
  drop: [item: FileItem, ev: DragEvent]
}>()

const ICON_PX: Record<IconSize, number> = { sm: 28, md: 40, lg: 56 }

const metaLine = computed(() => {
  const bits: string[] = []
  if (props.item.isDir) bits.push(props.item.childCount > 0 ? `${props.item.childCount} 项` : '空')
  else {
    bits.push(kindLabel(props.item.kind))
    if (props.item.size !== undefined) bits.push(humanBytes(props.item.size))
  }
  const t = formatWhen(props.item.modifiedAt)
  if (t) bits.push(t)
  return bits.join(' · ')
})

const ariaLabel = computed(() => {
  const bits = [props.item.name, kindLabel(props.item.kind)]
  if (props.item.size !== undefined && !props.item.isDir) bits.push(humanBytes(props.item.size))
  if (props.item.attributes.system) bits.push('系统文件，只读')
  if (props.item.pinned) bits.push('已钉住')
  if (props.cut) bits.push('待剪切')
  return bits.join('，')
})

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
  <div
    class="tile"
    :class="{ sel: selected, focus: focused, cut, over: dragOver, dir: item.isDir, paste: pasteTarget }"
    role="option"
    :data-item-id="item.id"
    :aria-selected="selected"
    :aria-label="ariaLabel"
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
    <div class="art">
      <FileIcon :item="item" :size="ICON_PX[iconSize]" badges />
      <span v-if="selectMode" class="ck" :class="{ on: selected }" aria-hidden="true">
        <Check :size="12" :stroke-width="3" />
      </span>
    </div>
    <b class="cap">{{ item.displayName }}</b>
    <small class="sub">{{ metaLine }}</small>
  </div>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap-sm);
  height: 100%;
  padding: var(--sp-12) var(--sp-8);
  border-radius: var(--radius-m);
  text-align: center;
  cursor: default;
  user-select: none;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

/* 悬停只在真悬停设备生效：触屏点一下也会留下 :hover 底色 */
@media (hover: hover) {
  .tile:hover {
    background: var(--surface-2);
  }
}

.tile.sel {
  background: var(--accent-soft);
}

/* 早于 .focus/.over：键盘焦点与拖放高亮继续优先 */
.tile:active {
  background: var(--surface-2);
}

.tile.focus {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.tile.cut {
  opacity: var(--disabled-opacity);
}

.tile.over {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

.art {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 60px;
}

/* 多选态勾选框：落在缩略图左上角，与图标右下角的 🔒 徽章错开 */
.ck {
  position: absolute;
  left: calc(-1 * var(--sp-4));
  top: calc(-1 * var(--sp-4));
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
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

.cap {
  width: 100%;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-regular);
  color: var(--text-1);
  /* 两行截断：文件名普遍比一个格子宽，一行会让「报告2026-10-07 早」这类名字全变成省略号 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.tile.sel .cap {
  font-weight: var(--fw-semibold);
}

.sub {
  width: 100%;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
