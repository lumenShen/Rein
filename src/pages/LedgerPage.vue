<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight, NotebookPen, Plus, Search, SearchX } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import BudgetSheet from '@/components/ledger/BudgetSheet.vue'
import LedgerEntrySheet from '@/components/ledger/LedgerEntrySheet.vue'
import LedgerList from '@/components/ledger/LedgerList.vue'
import LedgerStats from '@/components/ledger/LedgerStats.vue'
import { categoryOf } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'
import { addMonths, monthKey, todayStr } from '@/utils/date'
import type { LedgerEntry } from '@/types'

/** 记账：月度统计 + 流水列表 + 记一笔 / 编辑 / 预算设置。 */
const store = useLedgerStore()

onMounted(() => {
  void store.loadMonth()
  void store.loadBudget()
})

/* ---- 月份切换 ---- */
const currentMonth = monthKey(todayStr())
const canNext = computed(() => store.month < currentMonth)

const monthTitle = computed(() => {
  const [y, m] = store.month.split('-')
  return `${y}年${Number(m)}月`
})

function shiftMonth(n: number): void {
  const next = monthKey(addMonths(`${store.month}-01`, n))
  if (n > 0 && next > currentMonth) return
  void store.loadMonth(next)
}

/* ---- 筛选 ---- */
const filterCat = ref<string | null>(null)
const kw = ref('')

const usedCats = computed(() => {
  const keys = new Set<string>()
  for (const e of store.monthEntries) keys.add(e.category)
  return [...keys]
})

const filtered = computed(() => {
  const k = kw.value.trim().toLowerCase()
  return store.monthEntries.filter(
    (e) =>
      (!filterCat.value || e.category === filterCat.value) &&
      (!k || (e.note ?? '').toLowerCase().includes(k)),
  )
})

/** 本月一条流水都没有。区别于「筛出来是空」——后者是关键词/分类的锅，筛选条得留着让人撤回来。 */
const noEntries = computed(() => store.monthEntries.length === 0)
const noMatch = computed(() => kw.value.trim() !== '' || filterCat.value !== null)
/** 空月份整条收起筛选：没有东西可筛，那条孤零零的「全部」胶囊还占着 40px，
 *  把空态卡一路顶到悬浮钮底下（用户截图里被压住的正是这一块）。 */
const showFilters = computed(() => !noEntries.value || noMatch.value)

/* ---- 弹层 ---- */
const entryOpen = ref(false)
const editing = ref<LedgerEntry | null>(null)
const budgetOpen = ref(false)

function onAdd(): void {
  editing.value = null
  entryOpen.value = true
}

function onEdit(e: LedgerEntry): void {
  editing.value = e
  entryOpen.value = true
}

const emptyCopy = computed(() => {
  if (noMatch.value) {
    return {
      icon: SearchX,
      title: '没有匹配的流水',
      hint: usedCats.value.length > 0 ? '换个关键词，或点上面的分类重新筛' : '换个关键词试试',
    }
  }
  return { icon: NotebookPen, title: '本月还没有流水' }
})
</script>

<template>
  <div class="page">
    <PageHeader title="记账" back>
      <template #action>
        <div class="month row center">
          <button class="nav" aria-label="上一个月" @click="shiftMonth(-1)">
            <ChevronLeft :size="16" :stroke-width="2.4" />
          </button>
          <span class="m-title num">{{ monthTitle }}</span>
          <button class="nav" aria-label="下一个月" :disabled="!canNext" @click="shiftMonth(1)">
            <ChevronRight :size="16" :stroke-width="2.4" />
          </button>
        </div>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 桌面：左统计 / 右流水的主从构图。
         .board 在移动端就是普通的一列（内容与顺序**完全不变**），桌面才分成两栏 ——
         495px 高的统计卡独占一栏、整列流水交给右栏，省掉的是眼睛在
         「月份数字 ↔ 流水条目」之间来回横跳的距离。 -->
    <div class="board d-full">
      <!-- 本月统计 + 预算 + 趋势。桌面左栏定宽 360px（见样式末尾的桌面段）；
           桌面主从构图里它退成 .card.sub 那口浅井（配角），移动端恢复普通卡片外观 -->
      <LedgerStats class="card sub flow-card" @edit-budget="budgetOpen = true" />

      <div class="flow">
        <!-- 筛选：关键词 + 分类（分类胶囊按本月实际用到的分类生成）。
             本月一条流水都没有时整条收起 —— 没有东西可筛，那条孤零零的「全部」胶囊
             还白占 40px，把空态卡一路顶到浮层底下。 -->
        <div v-if="showFilters" class="filters">
          <div class="searchrow row">
            <label class="search row center flex-1">
              <Search :size="15" class="t-3" />
              <input v-model="kw" type="search" placeholder="搜索备注" aria-label="搜索备注" />
            </label>
            <!-- 主操作「记一笔」：**全端就这一处**（原先移动端是底部那颗 fixed 居中胶囊）。
                 胶囊压在滚动内容上，一页里永远有一块被它盖住 —— 393×749 下是分类胶囊与
                 搜索框，430×932 下是某行的分类名与备注，空月份下正是空态那句提示本身。
                 补 padding-bottom 只能保证「滚到底能露出来」，静止时被压的那一行照样读不了；
                 这一页的流水是逐行读的列表，最经不起盖，所以主操作回到流里（而不是把
                 碰撞挪个位置）。它按 `filtered.length` 与空态卡二选一，同一屏只有一颗。 -->
            <button v-if="filtered.length > 0" class="add-inline row center pressable" @click="onAdd">
              <Plus :size="16" :stroke-width="2.6" />
              <span>记一笔</span>
            </button>
          </div>
          <div v-if="usedCats.length > 0" class="chips fade-x" data-rubber-self>
            <button class="chip" :class="{ on: filterCat === null }" @click="filterCat = null">全部</button>
            <button
              v-for="key in usedCats"
              :key="key"
              class="chip"
              :class="{ on: filterCat === key }"
              @click="filterCat = filterCat === key ? null : key"
            >
              <i class="dot" :style="{ background: categoryOf(key)?.colorVar ?? 'var(--led-other)' }" />
              {{ categoryOf(key)?.label ?? key }}
            </button>
          </div>
        </div>

        <!-- 流水 -->
        <LedgerList v-if="filtered.length > 0" :entries="filtered" @edit="onEdit" />
        <!-- 空态：与抢课/知识库同用 EmptyState（图标 + 标题 + 提示）。
             没有可读的流水时，行动出口就落在这张卡里（筛选条那时也收起了，
             不落在卡里就等于整个月没有入口记第一笔）。 -->
        <section v-else class="card">
          <EmptyState :icon="emptyCopy.icon" :title="emptyCopy.title" :hint="emptyCopy.hint">
            <template #action>
              <button class="add-inline row center pressable" @click="onAdd">
                <Plus :size="16" :stroke-width="2.6" />
                <span>记一笔</span>
              </button>
            </template>
          </EmptyState>
        </section>
      </div>
    </div>

    <LedgerEntrySheet :open="entryOpen" :entry="editing" @close="entryOpen = false" @saved="entryOpen = false" />
    <BudgetSheet :open="budgetOpen" @close="budgetOpen = false" @saved="budgetOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部沿用全站页头节奏的一格 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 月份切换（页头 action 槽） */
.month {
  /* 月份导航：两枚圆钮之间 8（无边界控件档）—— 它们各自带 46 的命中区，
     间距小于 8 两块热区就叠在一起，右界的点击会被后一颗截走；
     与页头标题基线错开 4。 */
  gap: var(--gap-sm);
  margin-bottom: var(--gap-tight);
}

/* 圆钮视觉 38：与页头 .back / .hdr-btn 同一档（PageHeader 的圆钮规格）。
   原来是 30 —— 同一条页头动作槽里两颗钮差出一档，靠右的月份导航读起来像二级控件。 */
.nav {
  position: relative;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 命中区 46 = 视觉 38 + 四周各 4（--sp-4），过 --hit-min 44；
   组内 gap 8 时两块热区正好相接、不重叠（38 + 4 + 4 = 46，8 - 4 - 4 = 0）。 */
.nav::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-4));
}

.nav:disabled {
  opacity: var(--disabled-opacity);
}

.m-title {
  min-width: 92px;
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
}

/* ---------- 桌面主从构图（.board 内的一切在移动端都是普通块） ---------- */
.board {
  display: block;
}

/* 左栏固定 360px：统计卡的内容（三栏数字 + 环形图 + 六个月柱）在 360 下刚好排得开，
   再宽只会让它在桌面画布里显得比右边的流水更重 */
.desk-main .board {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: var(--desk-gap);
  align-items: start;
}

/* 左栏定宽那格采用 .card.sub（base.css：--surface-inset 浅井底 / radius-l / 14px 内距 / 无影）
   —— 桌面主从构图里右栏流水是主角，统计是配角，就该退一档而不是又冒出一块带影白卡。
   移动端一列时它不是「二级分组」而是这一屏的主卡：恢复普通卡片外观，否则画布上
   一块没影的浅井会让整页发平。两条规则都带 .page / .desk-main 前缀（特指度高过
   base.css 的 .card.sub），谁覆盖谁不靠样式表注入顺序去赌。 */
.page .flow-card {
  background: var(--surface);
  /* 移动端它是这一屏的主卡：圆角与内距取全站卡片同一档（16 / 16），
     20 圆角 + 20 内距是上一版手感，与其它页的卡并排会高出一档 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--pad-card);
}

.desk-main .flow-card {
  background: var(--surface-inset);
  /* 桌面上它是配角（.card.sub 的二级浅井）：圆角与内距各收一档 */
  border-radius: var(--radius-m-nest);
  box-shadow: none;
  padding: var(--pad-card-tight);
}

/* 筛选 */
.filters {
  display: flex;
  flex-direction: column;
  /* 搜索行与分类胶囊行：两组控件之间 12；与下方流水 12 */
  gap: var(--gap-md);
  margin-bottom: var(--gap-md);
}

/* 桌面上搜索框与主操作同一行：搜索框吃掉余量，按钮贴右端 */
.searchrow {
  gap: var(--gap-sm);
}

.add-inline {
  /* 排进筛选条时是 flex 项、落进空态卡（.act 是文本居中的块）时必须是 inline-flex，
     否则按钮会被拉满整卡宽 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  flex: none;
  gap: var(--gap-text-inline);
  /* 主操作胶囊：控件常规高 40（--control-md），上下 8、左右 16；
     原来只有 37（8+8+14×1.5），比同一行的搜索胶囊还矮一格 */
  min-height: var(--control-md);
  padding: var(--gap-sm) var(--pad-card);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

/* 桌面：流水一栏里那条 .card + .card 的边距照旧，但统计卡与右栏是栅格子项，
   不需要额外上边距 */
.desk-main .board > .card + .card {
  margin-top: 0;
}

.search {
  gap: var(--gap-sm);
  /* 与同一行的「记一笔」同高：控件常规 40（--control-md）。
     原来靠 8+8 内距自然撑到 37，两颗控件在同一行上下错开 3px。 */
  min-height: var(--control-md);
  /* 搜索胶囊：上下 8、左右 12 */
  padding: var(--gap-sm) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.search input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  color: var(--text-1);
  background: transparent;
}

/* 桌面壳：这条输入框实测只有 17px 高（探针 p5base：1024×768 下 372×17），
   低于指针精度的 22 下限。给它 24px 内高（实测 24），胶囊跟着从 35 涨到 40 ——
   高度差和旁边那颗 .add-inline 相比更明显了，但 19px 的输入框是真的点不住。
   手机上是胶囊里的一格，不改（22 是指针精度的规则）。 */
.desk-main .search input {
  min-height: 24px;
}

.search input::placeholder {
  color: var(--text-3);
}

.chips {
  display: flex;
  /* 分类胶囊一组无边界控件：组内 8 */
  gap: var(--gap-sm);
  overflow-x: auto;
  /* 上下各 6：32 的胶囊 + 6×2 = 44 的热区（::after 在滚动容器里要留出这圈余量，
     否则会被 overflow 裁掉）。滚动行的高度因此与原来的 40 相差无几 */
  padding: var(--sp-6) 0;
  scrollbar-width: none;
}

.chips::-webkit-scrollbar {
  display: none;
}

.chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  /* 色点与分类名是图标 + 文字：左右 8（--gap-text-inline），不是行内最小 4 ——
     5 个字的分类名贴着一枚 8px 色点，色点会被读成字的偏旁 */
  gap: var(--gap-sm);
  flex: none;
  /* 可点胶囊统一 32（施工单 §2「可点胶囊 32」）：与饮食库的分类/排序胶囊同一档，
     此前 40 让分类行比上方搜索行还高 */
  min-height: var(--sp-32);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 32 的视觉胶囊：命中区纵向补到 44（上下各 6，与 .chips 的 padding 对齐） */
.chip::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-6)) 0;
}

/* 选中态：soft 底上的文字走 --accent-strong，不拿实底档 --accent 当文字色
   （tokens.css 的语义色契约 / STANDARDS §4）。 */
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

/* 分类色点 8：与 LedgerStats 图例、HarmonyOS 列表 Badge 同一档（8×8vp） */
.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}

/* EmptyState 自带 26px 上下内边距，而 .card 外面又给了一圈 16 —— 两层叠起来，
   卡里上下一共 84px 的空白，空态卡因此顶到 208px 高（390 宽的下限窗口里，
   它一路伸到 dock 底下）。组件内边距在这里收掉，外侧的卡已经提供了呼吸。 */
.card :deep(.empty) {
  padding: var(--gap-tight) var(--pad-inline);
}

/* 空态卡里那颗是当月唯一的入口（筛选条同时收起了），给它 44px 的触控高度；
   筛选条里那颗仍留在行高内，与搜索框齐平。 */
.card .add-inline {
  /* 空态卡里那颗是当月唯一入口，纵向补到 44 档 */
  padding: var(--sp-12) var(--sp-20);
}

/* 主操作现在全端就这一处（悬浮钮已取消），命中区必须够拇指：视觉高度与搜索框同为 40
   （--control-md），命中区按项目惯例（PageHeader 的 .back / .hdr-btn）撑到 44 ——
   上下各外扩 2px（40 + 4 = 44）；横向**只向左**外扩 2px（右侧留给屏幕边缘，
   横向扩出去也点不到）。左边就是搜索框：扩出来的 2px 从按钮自己的左缘算起，
   而 .searchrow 上另有 8px gap，两段命中区之间净剩 6px，不会把搜索框右端那一段的点击抢走。 */
.add-inline::after {
  content: '';
  position: absolute;
  /* 命中区外扩 2：40 视觉高 + 4 = 44（--hit-min） */
  inset: calc(-1 * var(--sp-2)) 0 calc(-1 * var(--sp-2)) calc(-1 * var(--sp-2));
}
</style>
