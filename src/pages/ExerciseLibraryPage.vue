<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronRight, Dumbbell, Plus, Search, SlidersHorizontal, Star } from 'lucide-vue-next'

import ExerciseFilterSheet from '@/components/exercise/ExerciseFilterSheet.vue'
import ExerciseFormSheet from '@/components/exercise/ExerciseFormSheet.vue'
import ExerciseLibrarySheet from '@/components/exercise/ExerciseLibrarySheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { EXERCISE_CATEGORY_LABELS, EXERCISE_CATEGORY_META, EXERCISE_EQUIPMENT_LABELS } from '@/config/domain'
import { MUSCLE_LABELS, type MuscleKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { libraryMuscles } from '@/utils/libraryMuscles'
import { EMPTY_EXERCISE_FILTER, filterBadgeCount } from '@/types'
import type { ExerciseCategory, ExerciseFilterState, ExerciseRecord } from '@/types'

/**
 * 动作库（/sports/exercises）：全部运动动作的唯一真源。
 * 搜索 + 分类 + 筛选（类型/器材/肌群/收藏/排序）+ 逐条进详情（肌群图 / 要领 / 曲线 / 今日建议）；
 * 内置动作只读（可隐藏、可收藏），自建动作可增删改。
 */
const lib = useExerciseLibStore()
const { toast } = useToast()

const kw = ref('')
const filter = ref<ExerciseFilterState>({ ...EMPTY_EXERCISE_FILTER })
const filterOpen = ref(false)
const showHidden = ref(false)
const detail = ref<ExerciseRecord | null>(null)
const detailOpen = ref(false)
const formOpen = ref(false)
const editing = ref<ExerciseRecord | null>(null)

onMounted(() => void lib.load(true))

/** 分类留在主浏览轴上（chips 行），其余条件走筛选面板 */
const category = computed<ExerciseCategory | ''>(() => filter.value.category)
const badge = computed(() => filterBadgeCount(filter.value))

/** 隐藏的内置动作始终在内存里（管理用），只在 UI 上按开关过滤 */
const rows = computed(() =>
  lib.search(kw.value, {
    category: filter.value.category || undefined,
    kind: filter.value.kind || undefined,
    equipment: filter.value.equipment || undefined,
    muscles: filter.value.muscles,
    onlyFavorite: filter.value.onlyFavorite,
    sort: filter.value.sort,
    includeHidden: showHidden.value,
  }),
)

const hiddenCount = computed(() => lib.list.filter((e) => e.hidden).length)

function setCategory(c: ExerciseCategory | ''): void {
  filter.value = { ...filter.value, category: c }
}

async function toggleFavorite(e: ExerciseRecord): Promise<void> {
  try {
    await lib.setFavorite(e.id, !e.favorite)
  } catch (err) {
    toast(err instanceof Error ? err.message : '收藏失败')
  }
}

function muscleLine(e: ExerciseRecord): string {
  const map = libraryMuscles(e)
  const mains = (Object.entries(map) as [MuscleKey, number][])
    .filter(([, lv]) => lv === 3)
    .map(([m]) => MUSCLE_LABELS[m])
  if (mains.length) return mains.join(' · ')
  return EXERCISE_CATEGORY_LABELS[e.category]
}

function openDetail(e: ExerciseRecord): void {
  detail.value = e
  detailOpen.value = true
}

/** 详情里的动作被编辑/删除后：刷新列表并同步抽屉里的那份引用 */
function onChanged(): void {
  void lib.load(true)
}

function onEdit(e: ExerciseRecord): void {
  detailOpen.value = false
  editing.value = e
  formOpen.value = true
}

function startCreate(): void {
  editing.value = null
  formOpen.value = true
}

function onSaved(e: ExerciseRecord): void {
  void lib.load(showHidden.value)
  // 新建后直接打开详情，方便立刻看曲线与今日建议
  if (e) openDetail(e)
}
</script>

<template>
  <div class="page">
    <PageHeader back title="动作库" :subtitle="`${lib.list.length} 个动作`">
      <!-- 「课程的唯一动作来源」是系统设计事实：收进页头帮助入口，副标题只留计数 -->
      <template #action>
        <span class="hdr-btn">
          <InfoHint
            title="动作来源"
            content="课程里添加动作时只能从本页挑选 —— 这里是课程的唯一动作来源。"
          />
        </span>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <div class="searchrow row">
      <Search :size="15" />
      <input v-model="kw" class="search" type="search" placeholder="搜索动作名" aria-label="搜索动作" />
      <button class="filterbtn row" type="button" @click="filterOpen = true">
        <SlidersHorizontal :size="14" />
        <span>筛选</span>
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
      <button
        class="chip fav"
        :class="{ on: filter.onlyFavorite }"
        @click="filter = { ...filter, onlyFavorite: !filter.onlyFavorite }"
      >
        <Star :size="12" :fill="filter.onlyFavorite ? 'currentColor' : 'none'" />收藏
      </button>
    </div>

    <!-- d-list：桌面上这条 81 条的清单摊成两栏流（栏数在下面的桌面段里给） -->
    <ul class="list d-list">
      <li v-for="e in rows" :key="e.id">
        <div class="exrow row">
          <button type="button" class="main row" @click="openDetail(e)">
            <span class="col text">
              <span class="ename">
                {{ e.name }}
                <b v-if="e.isCustom" class="tag">自建</b>
                <b v-if="e.hidden" class="tag muted">已隐藏</b>
              </span>
              <!-- 肌群是主信息（胶囊），器材与次数降一档、竖线分开：同一行不再四件事平铺 -->
              <span class="emeta">
                <PillChip tone="muted" size="sm">{{ muscleLine(e) }}</PillChip>
                <span v-if="e.equipment" class="esub">{{ EXERCISE_EQUIPMENT_LABELS[e.equipment] }}</span>
                <span v-if="e.sessions > 0" class="esub">练过 <b class="num">{{ e.sessions }}</b> 次</span>
                <span v-else class="esub">还没练过</span>
              </span>
            </span>
            <ChevronRight :size="16" class="t-3" />
          </button>
          <button
            type="button"
            class="starbtn"
            :class="{ on: e.favorite }"
            :aria-label="e.favorite ? `取消收藏 ${e.name}` : `收藏 ${e.name}`"
            :aria-pressed="e.favorite"
            @click="void toggleFavorite(e)"
          >
            <Star :size="15" :fill="e.favorite ? 'currentColor' : 'none'" />
          </button>
        </div>
      </li>
    </ul>

    <EmptyState
      v-if="rows.length === 0"
      :icon="Dumbbell"
      title="没有匹配的动作"
      hint="换个关键词，或在下方新建一个自定义动作"
    />

    <button class="newrow row center" @click="startCreate">
      <Plus :size="17" /> 新建自定义动作
    </button>

    <label v-if="hiddenCount > 0 || showHidden" class="hiddenrow row">
      <span>显示已隐藏的动作（{{ hiddenCount }}）</span>
      <ToggleSwitch :model-value="showHidden" label="显示已隐藏的动作" @update:model-value="showHidden = $event" />
    </label>

    <ExerciseLibrarySheet
      :open="detailOpen"
      :exercise="detail"
      @close="detailOpen = false"
      @changed="onChanged"
      @edit="onEdit"
    />

    <ExerciseFilterSheet
      v-model="filter"
      :open="filterOpen"
      :result-count="rows.length"
      @close="filterOpen = false"
    />

    <ExerciseFormSheet
      :open="formOpen"
      :exercise="editing"
      @close="formOpen = false"
      @saved="onSaved"
    />
    </div>
  </div>
</template>

<style scoped>
/* 布局与方案页同构：flex 容器统一管纵向间距（14px），块内不再各写 margin-top */
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
  display: flex;
  flex-direction: column;
  /* 段与段之间 12（卡片间距）：原来 14 让页面比卡内节奏还松 */
  gap: var(--gap-md);
}

/* 搜索行是页面级独立控件：白卡 + 卡片落影（与食物库 finder 同款），不再是灰底内嵌。
   高度取常规控件 40（--control-md）：原来 10px 内距 + 28px 的筛选胶囊把行撑到 ~48，
   比动作选择器的同款 finder 高出一档，320 下还白占 8px 纵向。 */
.searchrow {
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

/* 筛选入口：程序页 .cap 胶囊同款（描边 + 白底） */
.filterbtn {
  position: relative;
  gap: var(--gap-tight);
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  flex: none;
}

/* 视觉 ~27 高不动，热区撑到 44+：上下各 10px 落在搜索行与胶囊组之间的 12px 里，
   横向 4px 只吃掉行内 8px gap 的一半（不会压到输入框）。 */
.filterbtn::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-10)) calc(-1 * var(--sp-4));
}

/* 计数徽章：程序 .pill 的 accent-soft 语言 */
.fcount {
  min-width: 16px;
  height: 16px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  line-height: 16px;
  text-align: center;
}

.chip.fav {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
}

.chips {
  /* 动作分类胶囊之间 8（无边界控件间距） */
  gap: var(--gap-sm);
  flex-wrap: wrap;
}

/* 分类胶囊的视觉高度保持 28 左右、不补 44 伪元素热区：它们在 flex-wrap 行里，
   上下外扩会与相邻行抢同一段 8px 间隙（点上一行会落到下一行）。
   同族决定见 docs/exercise-quality-review-2026-10-17.md §D10 拍板 B。 */

/* chips 用程序向导的描边语言：未选中描边白底，选中实底 accent（不再是绿 tint） */
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

.exrow {
  width: 100%;
  /* 动作条目是双行行：高度 64（--row-h-double） */
  min-height: var(--row-h-double);
  gap: var(--gap-text);
  padding: var(--sp-4) var(--sp-2) var(--sp-4) 0;
  text-align: left;
}

.exrow .main {
  flex: 1;
  min-width: 0;
  gap: var(--sp-10);
  padding: var(--sp-8) 0;
  text-align: left;
}

.exrow .text {
  flex: 1;
  min-width: 0;
  gap: var(--gap-tight);
}

/* 收藏钮：视觉仍是 15px 星星，盒子直接取 44×44（规则 5 的热区下限）。
   行本身 64 高，44 的方形落进去不会改变行高；按钮仍在行尾、不与整行点击区重叠。 */
.starbtn {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--hit-min);
  height: var(--hit-min);
  padding: 0;
  border-radius: var(--radius-full);
  color: var(--text-3);
}

.starbtn.on {
  color: var(--warn);
}

.list li + li {
  border-top: 0.5px solid var(--line);
}

.ename {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

/* 自建/隐藏标签：程序 .pill 几何（胶囊）。「自建」是来源标签不是类型字章：
   文字走中性色，运动域色相留在 soft 底的色块上（色彩配额，STANDARDS §4） */
.tag {
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--c-exercise-soft);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.tag.muted {
  background: var(--surface-3);
  color: var(--text-3);
}

/* 元信息行：肌群胶囊（主）+ 器材/次数（次，竖线分开）。胶囊不收缩，
   次数那截超长时省略号收尾。 */
.emeta {
  display: flex;
  align-items: center;
  /* 行内次信息之间 4（--gap-tight），与 .text 的 4 一致 */
  gap: var(--gap-tight);
  min-width: 0;
}

.emeta .chip {
  flex: none;
  min-width: 0;
  overflow: hidden;
}

.esub {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 竖线分隔：与肌群胶囊的「·」不是同一枚分隔符，两层信息不同符 */
.esub + .esub {
  padding-left: var(--sp-6);
  border-left: 0.5px solid var(--line);
}

.newrow {
  width: 100%;
  gap: var(--sp-6);
  padding: var(--sp-14) 0;
  border-radius: var(--radius-l);
  border: 1.5px dashed var(--line-strong);
  color: var(--text-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.hiddenrow {
  padding: var(--sp-12) var(--sp-2) 0;
  justify-content: space-between;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   81 个动作在 970px 里一行一名、右边空掉大半行，是手机版被拉宽的痕迹。
   桌面上摊成两栏流 —— 动作库是**无序清单**，分栏后「先读完左栏再读右栏」不影响理解。

   为什么用多栏流（columns）而不是 grid：行里的元信息（肌群胶囊 + 器材 / 练过几次）长短不一、
   名字也会换行，条目高度是参差的；grid 会把同一行的两条一起撑到较高那条，
   一屏下来全是锯齿状空白，多栏流则是自然瀑布。

   分栏会带来一个副作用：`li + li` 把「第二栏的第一条」也当成接续条画了一条上边线
   （孤零零悬在右栏顶端）。所以桌面统一改成下边线，并在栏间补一条竖线把两栏分开。 */
.desk-main .list {
  column-gap: var(--desk-gap);
  column-rule: 0.5px solid var(--line);
}

.desk-main .list li + li {
  border-top: 0;
}

.desk-main .list li {
  border-bottom: 0.5px solid var(--line);
}
</style>
