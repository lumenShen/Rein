<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  CloudOff,
  File as FileGeneric,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  Image as ImageIcon,
  Lock,
  Pin,
  Cloud,
} from 'lucide-vue-next'

import { iconOverride } from '@/files/registry'
import { cachedThumb, thumbEligible, loadThumb } from '@/files/thumbs'
import type { FileItem } from '@/files/types'

/**
 * 文件图标 / 缩略图 + 徽章。
 *
 * 三层显示，从便宜到贵：**扩展名图标**（同步，永远有）→ **缓存缩略图**（同步读，避免滚动闪白）
 * → **异步缩略图**（进视口才排队生成）。任何一层失败都退回上一层，绝不出现空白格。
 */
const props = withDefaults(
  defineProps<{
    item: FileItem
    /** 图标像素尺寸（网格按档位传 28/40/56，列表恒为 18） */
    size?: number
    /** 徽章只在大图标上显示（列表行省空间） */
    badges?: boolean
  }>(),
  { size: 18, badges: false },
)

const ICONS = {
  folder: Folder,
  text: FileText,
  image: ImageIcon,
  audio: FileAudio,
  video: FileVideo,
  file: FileGeneric,
}

// 扩展点优先：注册过的图标 provider（如压缩包）盖过按 kind 推出来的默认图标
const icon = computed(() => iconOverride(props.item) ?? ICONS[props.item.kind] ?? FileText)

const thumbUrl = ref<string | null>(null)
/** 请求序号：虚拟滚动复用实例时，旧请求回来不许覆盖新条目的图 */
let token = 0

function consider(): void {
  // 只对图片且体积合适的条目排队；其余直接吃图标
  if (!thumbEligible(props.item)) return
  const my = ++token
  const edge = props.size <= 24 ? 48 : props.size <= 44 ? 96 : 192
  // 先同步画缓存里的（虚拟滚动反复重挂同一个条目时不会闪白），再去取/生成
  thumbUrl.value = cachedThumb(props.item, edge)
  void loadThumb(props.item, edge).then((url) => {
    if (my === token) thumbUrl.value = url
  })
}

onMounted(consider)
// 换条目 / 换尺寸档要重新考虑（否则会串图）
watch(
  () => [props.item.id, props.item.modifiedAt, props.size].join('|'),
  () => {
    thumbUrl.value = null
    consider()
  },
)
</script>

<template>
  <span class="fic" :style="{ width: `${size}px`, height: `${size}px` }">
    <!-- 缩略图：有就画图，没有就退回图标（不做骨架屏，图标本身就是合格的占位） -->
    <img v-if="thumbUrl" class="thumb" :src="thumbUrl" :alt="item.displayName" draggable="false">
    <component
      :is="icon"
      v-else
      :size="size"
      class="glyph"
      :class="{ dim: item.attributes.system, folder: item.isDir }"
    />
    <template v-if="badges">
      <span v-if="item.attributes.system" class="badge lock" title="系统文件（只读）">
        <Lock :size="9" />
      </span>
      <span v-else-if="item.pinned" class="badge pin" title="已钉住：AI 不会自动移动它">
        <Pin :size="9" />
      </span>
      <span
        v-if="item.cloudState === 'online' || item.cloudState === 'syncing'"
        class="badge cloud"
        :title="item.cloudState === 'syncing' ? '同步中' : '仅在线'"
      >
        <Cloud :size="9" />
      </span>
      <span v-else-if="item.cloudState === 'error'" class="badge err" title="云端状态异常">
        <CloudOff :size="9" />
      </span>
    </template>
  </span>
</template>

<style scoped>
.fic {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.glyph {
  color: var(--accent);
}

.glyph.folder {
  color: var(--accent);
  opacity: 0.85;
}

.glyph.dim {
  color: var(--text-2);
}

.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 缩略图走 8 那一档（+1 是描边视觉补偿，收进 8 与母容器的层级差里） */
  border-radius: var(--radius-s);
  background: var(--surface-2);
}

.badge {
  position: absolute;
  right: calc(-1 * var(--sp-2));
  bottom: calc(-1 * var(--sp-2));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-2);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-2);
  box-shadow: 0 0 0 1px var(--line);
}

.badge.lock {
  color: var(--accent);
}

.badge.pin {
  color: var(--accent);
}

.badge.err {
  color: var(--danger);
}
</style>
