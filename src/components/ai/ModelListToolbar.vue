<script setup lang="ts">
/**
 * 模型列表工具栏：搜索 + 两条「渲染声明」开关 + 计数。
 *
 * 两条声明直接对应列表的两种渲染方式（用户可在抽屉里当场切换、并被记住）：
 * - **提供商前缀**：模型名前加提供商昵称，跨供应商时一眼看出归属；
 * - **按提供商折叠**：按供应商分组，找某一家的模型不用在长列表里翻。
 *
 * 所有模型列表（选择抽屉 / 全部模型 / 提供商目录）共用这一条，尺寸与说法只有一份。
 */
import { Search, Tags, Rows3 } from 'lucide-vue-next'

withDefaults(
  defineProps<{
    query: string
    count: number
    /** 未过滤时的总数（count < total 时显示「x / y」） */
    total?: number
    folder: boolean
    display: boolean
    placeholder?: string
    loading?: boolean
  }>(),
  { total: 0, placeholder: '搜索模型名或提供商', loading: false },
)

const emit = defineEmits<{
  'update:query': [string]
  'update:folder': [boolean]
  'update:display': [boolean]
}>()
</script>

<template>
  <div class="bar">
    <div class="finder row center">
      <Search :size="16" class="t-3" />
      <input
        type="text"
        :value="query"
        :placeholder="placeholder"
        aria-label="搜索模型"
        autocapitalize="off"
        spellcheck="false"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      >
      <span v-if="loading" class="cnt t-3">加载中…</span>
    </div>

    <!-- 渲染声明与计数**一律左对齐**：两条声明是「这一列按什么画」的开关，
         跟左边搜索框同一条起始线；计数跟着声明走，不再甩到容器另一头。 -->
    <div class="row center flags">
      <div class="row gap">
        <button
          type="button"
          class="flag"
          :class="{ on: display }"
          :aria-pressed="display"
          @click="emit('update:display', !display)"
        >
          <Tags :size="12" />
          提供商前缀
        </button>
        <button
          type="button"
          class="flag"
          :class="{ on: folder }"
          :aria-pressed="folder"
          @click="emit('update:folder', !folder)"
        >
          <Rows3 :size="12" />
          按提供商折叠
        </button>
      </div>
      <!-- 计数带词：哪个是筛出数、哪个是总数，不再把两个数字光秃摆成比例 -->
      <span class="cnt t-3">
        <template v-if="total > count">
          已筛出 <span class="num">{{ count }}</span> / 共 <span class="num">{{ total }}</span> 条
        </template>
        <template v-else>共 <span class="num">{{ count }}</span> 条</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.finder {
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.finder input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

/* 声明 + 计数整体贴左：flex-wrap 让窄屏时计数自然落到下一行，仍从最左开始 */
.flags {
  gap: var(--gap-sm);
  flex-wrap: wrap;
  justify-content: flex-start;
}

/* 筛选开关是**可点控件**，不是静态标签：视觉按小按钮档 28（--control-sm），
   热区再用 ::after 上下各补 8 撑到 44。两颗之间横向只隔 8，所以命中区只纵向外扩，
   不会把相邻那颗的点击吃进来（与 ModelListSheet 的 .act 同一条做法）。 */
.flag {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--control-sm);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}

.flag::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.flag.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.cnt {
  font-size: var(--fs-caption);
  flex: none;
}
</style>
