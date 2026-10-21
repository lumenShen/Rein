<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus, Search, SlidersHorizontal } from 'lucide-vue-next'

import ExerciseFilterSheet from '@/components/exercise/ExerciseFilterSheet.vue'
import ExerciseFormSheet from '@/components/exercise/ExerciseFormSheet.vue'
import PillChip from '@/components/common/PillChip.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { EXERCISE_CATEGORY_LABELS, EXERCISE_CATEGORY_META } from '@/config/domain'
import { MUSCLE_LABELS, type MuscleKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { libraryMuscles } from '@/utils/libraryMuscles'
import { EMPTY_EXERCISE_FILTER, filterBadgeCount } from '@/types'
import type { ExerciseCategory, ExerciseFilterState, ExerciseKind, ExerciseRecord } from '@/types'

/**
 * 动作库选择器（课程编辑用）：搜索 + 分类 + 筛选（类型/器材/肌群/收藏/排序）+ 点选。
 * 库内没有合适动作时可当场「新建动作」——建完直接把新动作返回给调用方。
 */
const props = defineProps<{
  open: boolean
  /** 优先展示该类型（不强制过滤，切类型会把课程条目的字段清空） */
  kind?: ExerciseKind
  /** 当前已选动作 id（高亮） */
  currentId?: string
}>()

const emit = defineEmits<{
  close: []
  pick: [exercise: ExerciseRecord]
}>()

const lib = useExerciseLibStore()
const kw = ref('')
const filter = ref<ExerciseFilterState>({ ...EMPTY_EXERCISE_FILTER })
const filterOpen = ref(false)
const formOpen = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    kw.value = ''
    filter.value = { ...EMPTY_EXERCISE_FILTER }
    void lib.ensureLoaded()
  },
)

const category = computed<ExerciseCategory | ''>(() => filter.value.category)
const badge = computed(() => filterBadgeCount(filter.value))

function setCategory(c: ExerciseCategory | ''): void {
  filter.value = { ...filter.value, category: c }
}

/** 同类型优先排序（换类型会清空该条目的参数，放在后面以减少误触）；收藏仍置顶 */
const list = computed(() => {
  const rows = lib.search(kw.value, {
    category: filter.value.category || undefined,
    kind: filter.value.kind || undefined,
    equipment: filter.value.equipment || undefined,
    muscles: filter.value.muscles,
    onlyFavorite: filter.value.onlyFavorite,
    sort: filter.value.sort,
  })
  return [...rows].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    const ak = a.kind === props.kind ? 0 : 1
    const bk = b.kind === props.kind ? 0 : 1
    if (ak !== bk) return ak - bk
    return (b.sessions > 0 ? 1 : 0) - (a.sessions > 0 ? 1 : 0)
  })
})

function muscleLine(e: ExerciseRecord): string {
  const map = libraryMuscles(e)
  const mains = (Object.entries(map) as [MuscleKey, number][])
    .filter(([, lv]) => lv === 3)
    .map(([m]) => MUSCLE_LABELS[m])
  return mains.length ? mains.join(' · ') : EXERCISE_CATEGORY_LABELS[e.category]
}

function onCreated(e: ExerciseRecord): void {
  emit('pick', e)
  emit('close')
}
</script>

<template>
  <SheetModal :open="open" title="从动作库选择" initial-snap="large" @close="emit('close')">
    <div class="searchrow row">
      <Search :size="15" />
      <input v-model="kw" class="search" type="search" placeholder="搜索动作名或别名" aria-label="搜索动作" />
      <button class="filterbtn row" type="button" aria-label="筛选" @click="filterOpen = true">
        <SlidersHorizontal :size="14" />
        筛选
        <b v-if="badge" class="fcount">{{ badge }}</b>
      </button>
    </div>

    <div class="chips row">
      <button class="chip" :class="{ on: category === '' }" @click="setCategory('')">全部</button>
      <button
        v-for="c in EXERCISE_CATEGORY_META"
        :key="c.key"
        class="chip"
        :class="{ on: category === c.key }"
        @click="setCategory(c.key)"
      >
        {{ c.label }}
      </button>
    </div>

    <ul class="list" data-rubber-self>
      <li v-for="e in list" :key="e.id">
        <button
          type="button"
          class="rowitem col"
          :class="{ on: e.id === currentId }"
          @click="emit('pick', e)"
        >
          <span class="ename">
            {{ e.name }}
            <!-- 库内 / 自定义动作的区分：muted 胶囊（--text-2），措辞与下方「新建自定义动作」一致 -->
            <PillChip v-if="e.isCustom" size="sm" tone="muted">自定义</PillChip>
          </span>
          <span class="emeta t-3">{{ muscleLine(e) }}<template v-if="e.sessions > 0"> · 练过 {{ e.sessions }} 次</template></span>
        </button>
      </li>
    </ul>

    <p v-if="list.length === 0" class="empty">动作库里没有匹配的动作，可在下方新建</p>

    <button class="newrow row center" @click="formOpen = true">
      <Plus :size="16" /> 新建自定义动作
    </button>

    <ExerciseFormSheet :open="formOpen" :exercise="null" @close="formOpen = false" @saved="onCreated" />

    <ExerciseFilterSheet
      v-model="filter"
      :open="filterOpen"
      :result-count="list.length"
      @close="filterOpen = false"
    />
  </SheetModal>
</template>

<style scoped>
/* 搜索行/筛选入口/计数徽章与动作库页同款（白卡 finder + cap 胶囊 + accent pill） */
.searchrow {
  /* 输入框一档高 40（--control-md）：搜索行是这一屏的第一枚控件，
     与下方胶囊/列表的间距必须比胶囊之间大一档，层级才读得出来。 */
  min-height: var(--control-md);
  gap: var(--gap-sm);
  padding: 0 var(--sp-14);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-3);
}

.search {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.filterbtn {
  position: relative;
  gap: var(--gap-tight);
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text-2);
  flex: none;
}

/* 与动作库页同一枚筛选胶囊：视觉 ~27 高不动，热区撑到 44+（规则 5）。
   上下 10px 落在搜索行与胶囊组之间的 8px 间隙，横向 4px 只吃掉行内 gap。 */
.filterbtn::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-10)) calc(-1 * var(--sp-4));
}

.fcount {
  min-width: 15px;
  height: 15px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  /* soft 底上的文字走文字档（--accent-strong），不拿实底档当小字 —— tokens.css 的
     语义色两档约定：实底档是给填充/描边/图标用的，压在同名 soft 底上当文字读不清。 */
  color: var(--accent-strong);
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  line-height: 15px;
  text-align: center;
}

.chips {
  gap: var(--gap-sm);
  flex-wrap: wrap;
  /* 筛选胶囊与搜索行之间 8（无边界控件之间），原来 10 不在一档上。 */
  margin-top: var(--gap-sm);
}

/* 与动作库页同一套 chips：描边白底，选中实底 accent */
.chip {
  padding: var(--sp-6) var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-bold);
}

.list {
  /* 列表与胶囊组之间同样是 8：两者都无边界，间距要一致。 */
  margin-top: var(--gap-sm);
  max-height: 46vh;
  overflow: auto;
}

.rowitem {
  width: 100%;
  /* 双行列表项（名称 + 处方说明）统一 64 高（--row-h-double），
     原来是内容撑高，条目一多就高低不齐。 */
  min-height: var(--row-h-double);
  gap: var(--gap-text);
  /* 行节奏与「训练中临时换动作」的 StrengthExercisePicker `.prow` 统一（13px / body 600）：
     两处都是「从列表里选一个动作」，而列表行的高度直接决定触控容错 —— 取高的那个。
     （决策见 docs/exercise-quality-review-2026-10-17.md §8 D4） */
  padding: var(--sp-12) var(--sp-2);
  text-align: left;
  border-radius: var(--radius-s);
}

.rowitem.on {
  /* 已选高亮：选中态与程序对比矩阵同用 accent-soft（不再是绿 tint） */
  background: var(--accent-soft);
}

.list li + li {
  border-top: 0.5px solid var(--line);
}

.ename {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.emeta {
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty {
  padding: var(--sp-20) 0 var(--sp-6);
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.newrow {
  width: 100%;
  margin-top: var(--sp-12);
  gap: var(--sp-6);
  padding: var(--sp-12) 0;
  border-radius: var(--radius-l);
  border: 1.5px dashed var(--line-strong);
  color: var(--text-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}
</style>
