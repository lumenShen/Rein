<script setup lang="ts">
/**
 * ToolCallGroup 工具调用行（AI 过程区内的单条工具调用）
 *
 * 展示形态：行内只回答「AI 做了什么」——工具中文短名 + 目标摘要，长文换行，不再有横向溢出；
 * 原始入参与返回结果不在行内展开（长 JSON 会把行撑爆），点击整行打开抽屉看完整参数与结果。
 */
import { computed, ref } from 'vue'
import {
  Activity, Brain, Calendar, ChevronRight, FolderSearch, Globe, List,
  ListTodo, Plus, Search, Settings, Wallet, Wrench, ZoomIn,
} from 'lucide-vue-next'
import ToolDetailDrawer from './ToolDetailDrawer.vue'
import type { ProcessToolCall } from '@/types'

const props = defineProps<{
  /** 工具调用记录列表（按时间顺序） */
  calls: ProcessToolCall[]
}>()

/** 当前查看详情的工具调用（抽屉） */
const detailCall = ref<ProcessToolCall | null>(null)

// 工具图标：根据工具名映射（Rein 工具注册表）
const toolIcons = {
  Activity, Brain, Calendar, FolderSearch, Globe, ZoomIn, List,
  ListTodo, Plus, Search, Settings, Wallet, Wrench,
} as const

function toolIcon(name: string): unknown {
  const map: Record<string, unknown> = {
    search_food: toolIcons.Search,
    create_food: toolIcons.Plus,
    web_search: toolIcons.Globe,
    web_fetch: toolIcons.Globe,
    search_knowledge: toolIcons.FolderSearch,
    glob_knowledge: toolIcons.FolderSearch,
    read_knowledge: toolIcons.List,
    write_note: toolIcons.Plus,
    list_memories: toolIcons.Brain,
    view_image_detail: toolIcons.ZoomIn,
    get_program: toolIcons.Activity,
    generate_program: toolIcons.Activity,
    adjust_program: toolIcons.Activity,
    list_todos: toolIcons.ListTodo,
    get_strength_progress: toolIcons.Activity,
    probe_model: toolIcons.Settings,
    list_models: toolIcons.Settings,
    // 校园教务（AI 的最后补救）：抢课与选课都挂在课表这一天里，原始请求按「读网」算
    campus_status: toolIcons.Calendar,
    campus_lessons: toolIcons.Calendar,
    campus_grab_plan: toolIcons.Calendar,
    campus_grab_control: toolIcons.Calendar,
    campus_select: toolIcons.Calendar,
    campus_session: toolIcons.Calendar,
    campus_http: toolIcons.Globe,
    campus_export_script: toolIcons.List,
  }
  return map[name] ?? toolIcons.Wrench
}

/** 目标字段优先级：优先取「动作对象」这类入参（关键词 / 标题 / 路径 / 日期…） */
const TARGET_KEYS = [
  'query',
  'keyword',
  'title',
  'name',
  'file_path',
  'path',
  'url',
  'date',
  'id',
]

/** 目标摘要上限：超出截断（完整入参在详情抽屉里，这里只求一眼看懂做了什么） */
const TARGET_MAX = 48

function tidy(v: string): string {
  const one = v.replace(/\s+/g, ' ').trim()
  return one.length > TARGET_MAX ? one.slice(0, TARGET_MAX) + '…' : one
}

/** 从入参里挑一个可读的目标，拼成「做了什么」；全是非字符串入参时只显示工具短名 */
function targetOf(args: string): string {
  if (!args) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return tidy(args) // 非 JSON（流式半截 / 纯文本参数）：按原文兜底
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  const obj = parsed as Record<string, unknown>
  for (const k of TARGET_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return tidy(v)
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return tidy(v)
  }
  return ''
}

/** 状态文案 */
function statusText(c: ProcessToolCall): string {
  if (c.pending) return '执行中…'
  return c.isError ? '失败' : '完成'
}

/** 状态档位：决定文案颜色 */
function statusKind(c: ProcessToolCall): 'pending' | 'error' | 'ok' {
  if (c.pending) return 'pending'
  return c.isError ? 'error' : 'ok'
}

/** 行数据：入参只解析一次，避免无关重渲染时反复 JSON.parse */
const rows = computed(() =>
  props.calls.map((c) => ({
    call: c,
    target: targetOf(c.arguments),
    status: statusText(c),
    kind: statusKind(c),
  })),
)

function openDetail(c: ProcessToolCall): void {
  detailCall.value = c
}
</script>

<template>
  <div v-if="calls.length > 0" class="tool-list">
    <button
      v-for="row in rows"
      :key="row.call.callId"
      type="button"
      class="tool-item"
      :aria-label="`查看「${row.call.toolName}」的完整参数与返回结果`"
      @click="openDetail(row.call)"
    >
      <span class="tool-icon">
        <component :is="toolIcon(row.call.rawName ?? row.call.toolName)" :size="14" />
      </span>
      <span class="tool-desc">
        <span class="tool-name">{{ row.call.toolName }}</span>
        <span v-if="row.target" class="tool-target">{{ row.target }}</span>
      </span>
      <span class="tool-status" :class="row.kind">
        <span v-if="row.call.pending" class="status-dot"></span>
        {{ row.status }}
      </span>
      <span class="tool-chevron"><ChevronRight :size="13" /></span>
    </button>

    <ToolDetailDrawer :call="detailCall" @close="detailCall = null" />
  </div>
</template>

<style scoped>
.tool-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

/* 单行：图标 + 「做了什么」描述 + 状态 + 抽屉箭头。
   描述列 flex:1 + min-width:0，其余列 flex:none —— 任何内容都不会横向溢出。
   整行是打开详情抽屉的按钮，高度按热区下限 44 给（原先 4 的内距只有 ~25 高）。 */
.tool-item {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  width: 100%;
  min-width: 0;
  min-height: var(--hit-min);
  padding: var(--sp-4);
  margin: 0 calc(-1 * var(--gap-tight));
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  /* transform 必须显式带上：scoped transition 会覆盖 base.css 里 button 的全局过渡，
     少了它 :active 的 scale(0.96) 就变成瞬贴 */
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .tool-item:hover {
    background: var(--surface-2);
  }
}

/* 触屏没有 hover，按压态必须自己给：底色与悬停同档，另有全局 scale(0.96) */
.tool-item:active {
  background: var(--surface-2);
}

.tool-icon {
  flex: none;
  width: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

/* 描述：工具短名 + 目标，随宽度自然换行；长串（URL/哈希）任意位置断行。
   这是「这一步做了什么」，属于要读的信息 → --text-2 */
.tool-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.tool-name {
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.tool-target::before {
  content: '· ';
}

.tool-status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 失败是「这一步没成」的状态词：实底档 --danger 当文字对比度不够，
   文字一律走 strong 档（tokens 里 --*-strong 的用途就是这一条） */
.tool-status.error {
  color: var(--danger-strong);
}

.tool-chevron {
  flex: none;
  display: inline-flex;
  color: var(--text-2);
  opacity: var(--disabled-opacity);
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .tool-item:hover .tool-chevron {
    opacity: 1;
    transform: translateX(1px);
  }
}

/* 执行中的状态小圆点：呼吸动画 */
.status-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: status-pulse 1s infinite ease-in-out;
}

@keyframes status-pulse {
  0%, 100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

/* 无障碍：reduce 下禁用位移类动效（箭头位移、状态圆点呼吸） */
@media (prefers-reduced-motion: reduce) {
  .tool-chevron,
  .tool-item {
    transition: none;
  }
  .tool-item:hover .tool-chevron {
    transform: none;
  }
  .status-dot {
    animation: none;
  }
}
</style>
