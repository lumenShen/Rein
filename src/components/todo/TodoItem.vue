<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Pencil, Trash2 } from 'lucide-vue-next'

import { CATEGORY_META, priorityMeta } from '@/config/domain'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm } from '@/utils/date'
import type { Todo } from '@/types'
import TodoEditorSheet from './TodoEditorSheet.vue'

/** 单条待办行：点按勾选切换完成，点正文打开编辑（时间段/重要程度等完整字段），悬停显示编辑/删除。 */
const props = defineProps<{ todo: Todo }>()

const store = useTodoStore()
const editorOpen = ref(false)

/**
 * 课表派生行是只读投影（见 types/todo.ts 的 courseSessionId）：标题/时间由课表同步生成，
 * 编辑会被下一次同步覆盖、删除会被 `materialize_todos` 建回来 —— 与其给两个「点了没反应」
 * 的入口，不如像 DayDetailPanel / CanvasTimeline 那样不提供。勾选照旧（打卡是它的用户动作）。
 */
const readonly = computed(() => props.todo.courseSessionId != null)

function openEditor(): void {
  if (!readonly.value) editorOpen.value = true
}
</script>

<template>
  <li class="item row" :class="{ done: todo.status === 'done' }">
    <button class="check" :aria-label="todo.status === 'done' ? '标记未完成' : '标记完成'" @click="store.toggle(todo)">
      <Transition name="ckin">
        <Check v-if="todo.status === 'done'" :size="13" :stroke-width="3.2" />
      </Transition>
    </button>
    <div class="flex-1 body" @click="openEditor">
      <p class="title">{{ todo.title }}</p>
      <p class="meta row">
        <template v-if="todo.startMin != null"><span class="num">{{ minToHHmm(todo.startMin) }}</span>·</template>
        <span class="cat row center">
          <i :style="{ background: `var(${CATEGORY_META[todo.category].colorVar})` }" />{{ CATEGORY_META[todo.category].label }}
        </span>
        <span
          v-if="todo.priority > 0"
          class="prio"
          :style="{ color: `var(${priorityMeta(todo.priority).colorVar})` }"
        >
          {{ priorityMeta(todo.priority).label }}
        </span>
      </p>
    </div>
    <div v-if="!readonly" class="ops row">
      <button class="edit" aria-label="编辑待办" @click="editorOpen = true">
        <Pencil :size="16" />
      </button>
      <button class="del" aria-label="删除待办" @click="store.remove(todo)">
        <Trash2 :size="16" />
      </button>
    </div>

    <TodoEditorSheet :open="editorOpen" :todo @close="editorOpen = false" />
  </li>
</template>

<style scoped>
.item {
  /* 复选 / 正文 / 行尾操作三段间距统一 12：正文是主体，两侧各让一档 */
  gap: var(--gap-md);
  padding: var(--sp-12) 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.check {
  position: relative;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

/* 24px 的勾选框是列表行的排版规格，命中区撑到 44×44（PageHeader .back 同款惯用法） */
.check::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}

/* 对勾弹入：120ms 不拖累连点 */
.ckin-enter-active {
  transition:
    transform 120ms var(--ease-standard),
    opacity 120ms var(--ease-standard);
}

.ckin-enter-from {
  transform: scale(0.5);
  opacity: 0;
}

.done .check {
  background: var(--ok);
  border-color: var(--ok);
}

.body {
  min-width: 0;
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.body:active {
  opacity: 0.55;
}

.title {
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
  /* 删除线常驻、颜色透明过渡：完成时划线像手写划过而非硬蹦 */
  text-decoration: line-through;
  text-decoration-color: transparent;
  transition:
    color var(--dur-base) var(--ease-standard),
    text-decoration-color var(--dur-base) var(--ease-standard);
}

.done .title {
  color: var(--text-3);
  text-decoration-color: currentColor;
}

.meta {
  /* 时刻 / 分类 / 优先级同属一行元信息，用最小呼吸一档 */
  gap: var(--gap-tight);
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.cat {
  gap: var(--gap-tight);
}

.cat i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.prio {
  font-weight: var(--fw-semibold);
}

.ops {
  gap: var(--gap-sm);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.edit,
.del {
  position: relative;
  color: var(--text-3);
  padding: var(--sp-2);
}

/* 桌面壳：指针精度下 ≥22 才点得住，而行尾这两颗原本是 16 图标 + 2px 内边距 = 20×20
   （低于下限，`/` 与 `/sports` 都被守卫量到）。内边距提到 4px → 24×24，仍在
   .edit/.del::after 那条 36×44 的命中区之内，触态那颗也照旧。
   只加在 .desk-main 下：22 是**指针精度**的下限 —— 手机上这两颗的命中区本来就由
   44px 的 ::after 撑着（拇指下限），不该让触屏行去付这一档内边距。 */
.desk-main .edit,
.desk-main .del {
  padding: var(--sp-4);
}

/* 行尾编辑/删除：16px 图标 + 2px 内边距 ≈ 20px 见方，命中区纵向外扩到 44
   （横向不外扩，两颗相隔 8px，扩出去会互相抢） */
.edit::after,
.del::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 36px;
  height: 44px;
  transform: translate(-50%, -50%);
}

/* 行尾两颗是「悬停才显形」的次操作 —— 但 opacity:0 **不妨碍聚焦**：
   TAB 落到 .edit/.del 上时，焦点在一条看不见的按钮上，键盘用户完全不知道自己在哪。
   所以焦点进到行内任何位置就整组显形（照 WorkoutRow 的 .item:hover/.del:focus-visible）。 */
.item:hover .ops,
.item:focus-within .ops {
  opacity: 1;
}

@media (hover: none) {
  .ops {
    opacity: 0.55;
  }
}
</style>
