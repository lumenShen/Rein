<script setup lang="ts">
import { computed } from 'vue'
import {
  ChevronRight,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  Image as ImageIcon,
  Paperclip,
} from 'lucide-vue-next'

import { humanBytes } from '@/utils/format'
import type { KbUsageFile } from '@/types'

/** 大文件榜的行渲染（空间总览的摘要与大文件页共用同一份）。
 *
 *  条是**双重编码**：长度 = 相对最大文件的体积，颜色 = 文本 / 本体的构成 ——
 *  一行同时回答「它有多大」和「大在哪」。纯文本的行也是一条实蓝，长度照样读得出它在榜上的位置。
 *
 *  行点击只 emit：跳转是页面的事（这里不 import router，组件保持可测、可复用）。
 */
const props = defineProps<{ files: KbUsageFile[] }>()
const emit = defineEmits<{ open: [file: KbUsageFile] }>()

/** 满格参照 = 榜单第一名（列表已按体积倒序） */
const maxBytes = computed(() => props.files[0]?.bytes ?? 0)

function barWidth(f: KbUsageFile): string {
  if (maxBytes.value <= 0) return '0%'
  // 下限 2%：最细的那条也要看得见，否则末尾几名读起来像「没有体积」
  return `${Math.min(100, Math.max(2, (f.bytes / maxBytes.value) * 100))}%`
}

function kindIcon(kind: string) {
  if (kind === 'folder') return Folder
  if (kind === 'image') return ImageIcon
  if (kind === 'audio') return FileAudio
  if (kind === 'video') return FileVideo
  if (kind === 'file') return Paperclip
  return FileText
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}
</script>

<template>
  <ul class="files">
    <li v-for="f in files" :key="f.id">
      <button class="filerow" @click="emit('open', f)">
        <component :is="kindIcon(f.kind)" :size="15" class="fic" />
        <span class="col flex-1">
          <b>{{ baseName(f.path) }}</b>
          <!-- 路径是分辨「同名文件是哪一份」的唯一依据：caption + --text-2，不再落进 11px 微字档 -->
          <small>{{ f.path }}</small>
        </span>
        <span class="fr-bytes num">{{ humanBytes(f.bytes) }}</span>
        <ChevronRight :size="14" class="t-3" />
      </button>
      <span class="track split" :style="{ width: barWidth(f) }">
        <i class="seg-text" :style="{ flexGrow: f.textBytes }" />
        <i class="seg-asset" :style="{ flexGrow: f.assetBytes }" />
      </span>
    </li>
  </ul>
</template>

<style scoped>
.files {
  display: grid;
  gap: var(--gap-lg);
}

.filerow {
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr) auto 14px;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  text-align: left;
}

.fic {
  color: var(--accent);
}

.filerow b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filerow small {
  display: block;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 等宽数字统一走 base.css 的 .num，不再手抄一份 font-variant-numeric */
.fr-bytes {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.track {
  display: flex;
  gap: 1px;
  height: 4px;
  margin-top: var(--gap-sm);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.track i {
  display: block;
  height: 100%;
}

.seg-text {
  background: var(--sto-text);
}

.seg-asset {
  background: var(--sto-asset);
}

@media (hover: hover) {
  .filerow:hover {
    background: var(--surface-2);
    border-radius: var(--radius-m);
  }
}
</style>
