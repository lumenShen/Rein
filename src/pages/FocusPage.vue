<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Plus } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import PomodoroCard from '@/components/pomodoro/PomodoroCard.vue'
import TodoListCard from '@/components/todo/TodoListCard.vue'
import ScheduleCard from '@/components/todo/ScheduleCard.vue'
import AllTodoList from '@/components/todo/AllTodoList.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { todayStr } from '@/utils/date'

/**
 * 专注 · 二级页：番茄钟 + 待办 + 日程时间线；完整时间线与超量待办收进抽屉。
 *
 * 横屏（手机 / 平板转到横屏，仍是 < 900 的手机壳）：一叠卡摊成「计时 | 全部待办」两栏 ——
 * 竖屏那套「先看计时、再翻待办」的顺序是按一屏一卡写的，横屏多出来的宽度只会白白空着。
 */
const today = todayStr()

/**
 * 横屏双栏是否成立。查询串与下面 style 里那条媒体查询**逐字相同**，分工是
 * 「JS 决定要不要把右栏挂进 DOM、CSS 决定几何」：CSS 读不到 TS 变量，TS 也读不到
 * CSS 里的媒体查询，只能两处同文 —— 改一处必须同改。
 *
 * max-width: 899px 与 DESKTOP_MIN(900) 严格接壤：≥900 是桌面壳（App.vue 换三窗格、
 * base.css 给 .page 铺自己的两栏栅格），横屏分栏绝不能跟进去。
 */
const landscape = useMediaQuery('(orientation: landscape) and (max-width: 899px)')

const pomo = usePomodoroStore()
const todo = useTodoStore()

/**
 * 横屏页头右侧那枚「添加待办」的抽屉。
 *
 * 为什么要补这一枚：竖屏的添加入口长在「今日待办」卡里（那张卡横屏换成了完整清单，
 * 而 AllTodoList 按设计不带添加入口）—— 不补的话，转个屏这一页就少掉唯一的添加入路，
 * 而「转屏不该少功能」比「横屏少一颗按钮」重要。竖屏不渲染（见模板里的条件插槽）。
 */
const addOpen = ref(false)

onMounted(() => {
  void pomo.loadToday()
  // 近 7 天完成段：供番茄钟卡的建议时长（循证建议，非硬编码最优时长）
  void pomo.loadRecent()
  void todo.loadDay(today)
  /* 横屏右栏的「全部待办」要 store.allTodos：只在侧栏真会挂出来时才拉
     （竖屏那份内联列表只用 dayTodos，不该为看不见的一栏多付一次全量查询）。
     AllTodoList 自己挂载时也会拉一次，这里不依赖它 —— 侧栏一挂上就有数据。 */
  if (landscape.value) void todo.loadAll()
})
</script>

<template>
  <div class="page">
    <!-- 页头：竖屏不提供 action 插槽（`<template v-if #action>` 在条件为假时
         连插槽都不存在），页头与从前逐像素一致；横屏才补那枚添加入口 -->
    <PageHeader title="专注" back>
      <template v-if="landscape" #action>
        <button class="hdr-btn" aria-label="添加待办" @click="addOpen = true">
          <Plus :size="20" />
        </button>
      </template>
    </PageHeader>

    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

      <!-- ═══ 横屏：计时一栏 + 全部待办一栏（两栏都自己滚，见 style 里的媒体查询） ═══ -->
      <template v-if="landscape">
        <!-- 计时栏：番茄钟在上，一眼看得见 -->
        <div class="pane pane-timer">
          <!-- 栏内的超伸内容层（rubberScroll 的 A 类层，与 AIPage 的 .msgs 同形态）：
               到边拖动时位移落在它身上，滚动框与吸顶页头都不动 -->
          <div class="pane-layer" data-rubber-content>
            <PomodoroCard />

            <!-- 今日日程：**不藏**。时间线是「今天怎么走」的另一半，横屏把它拿掉等于
                 悄悄少一个功能；计时卡高度固定，日程摊在它下面，两栏的滚动高度也都不至于失衡。
                 包一层 div 的理由同竖屏那份：ScheduleCard 的根是「section + TimelineSheet」
                 两段（多根），写在组件标签上的 class 会静默失效。 -->
            <div class="sched">
              <ScheduleCard :date="today" />
            </div>
          </div>
        </div>

        <!-- 待办栏：完整清单（比竖屏内联的 4 条大得多），自己滚 -->
        <div class="pane pane-todos">
          <div class="pane-layer" data-rubber-content>
            <h2 class="pane-title">全部待办</h2>
            <AllTodoList />
          </div>
        </div>
      </template>

      <!-- ═══ 竖屏 / 桌面：原样一叠（不动一条） ═══ -->
      <template v-else>
        <!-- 番茄钟 -->
        <PomodoroCard />

        <!-- 待办（列表内联，超出 4 条收进「全部待办」抽屉） -->
        <TodoListCard :date="today" list-only :inline-limit="4" />

        <!-- 今日日程（时间线预览，完整时间线在抽屉里滑动查看）
             桌面通栏：时间线是横向铺开的刻度轴，590px 的半栏会把「现在」前后压成一团。
             **必须包一层 div**：ScheduleCard 的根是「section + TimelineSheet」两段（多根），
             Vue 不会把外部传进来的 class 落到任何一个根上（控制台会 warn
             "Extraneous non-props attributes"）—— 写在组件标签上的 d-full 是**静默失效**的。
             包一层的代价是这一个 div，换来的是「通栏」真的生效。 -->
        <div class="d-full">
          <ScheduleCard :date="today" />
        </div>
      </template>
    </div>

    <!-- 智能添加：横屏页头那枚「+」的抽屉（竖屏不挂，DOM 与从前一致） -->
    <SmartAddSheet v-if="landscape" :open="addOpen" :date="today" @close="addOpen = false" />
  </div>
</template>

<style scoped>
.page {
  /* 顶部沿用全站页头节奏的一格 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* ============================================================
   横屏 · 计时 | 全部待办 两栏
   ------------------------------------------------------------
   查询串与上面 useMediaQuery 那句逐字相同（分工：JS 决定右栏挂不挂，CSS 决定几何）。

   为什么停在 899：≥900 是桌面壳 —— App.vue 换成三窗格、base.css 给 .page 铺自己的
   两栏栅格。这条规则跟进去只会打架，所以用 max-width: 899px 与 DESKTOP_MIN(900)
   严格接壤：两个壳各占一半、互不重叠（写 900 就会在这一档同时命中两边）。

   为什么**不**脱出壳的 480 窄栏：壳的环境光是按窄栏宽度铺的固定层
   （base.css 的 .app-frame::before），破框会让窗口两侧露出一条没有光的底色。
   两栏就在窄栏里分 —— 480 / 2 确实不宽，但那是壳的构图，页面对它只能顺着来。

   为什么横屏要分栏：竖屏是一屏一卡的一叠（计时 → 待办 → 日程），横屏多出来的宽度
   正好够把计时与完整待办并排放着：计时一眼可见，待办同时摊开，两栏各滚各的。
   ============================================================ */
@media (orientation: landscape) and (max-width: 899px) {
  .page {
    /* 横向留白收窄一档：480 的窄栏一分为二之后，每一像素都是卡片里的行长 */
    --page-pad-x: var(--sp-12);
    /* 页面盒 = 视口：安全区走内边距，不从宽高里扣（与 AIPage 同一条约定）。
       .app-frame 给整页让出的 --safe-top 由负外边距抵掉，再由这里铺成内边距 ——
       盒子的尺寸只由视口决定，安全区不再参与高度计算。 */
    height: 100dvh;
    margin-top: calc(-1 * var(--safe-top));
    padding: var(--safe-top) var(--page-pad-x) 0;
    /* 页面自己不滚：滚动全部交给两栏（容器框定死在 100dvh，不许出现文档级滚动） */
    overflow: hidden;
    /* 用栅格而不是弹性列：下面的内容层会 `display: inherit`（base.css「页面级超伸层」段），
       列宽与间距顺着继承下去 —— 两栏几何只在这一处声明，页面与层不会各写一份 */
    display: grid;
    /* 第一行页头（按内容高），第二行内容层（吃掉剩下的整屏高） */
    grid-template-rows: auto minmax(0, 1fr);
    /* 待办栏宽一档：行里有勾选框 + 标题 + 元信息 + 两颗次操作钮，
       比「一个圆环 + 一排圆钮」的计时栏更需要横向余量 */
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
    /* 两栏之间 12：与卡间距同档（它们是两列内容，不是两张卡） */
    gap: 0 var(--sp-12);
  }

  /* 页头与内容层各占整行：页头留在栏外（超伸时不动），真正的两栏由层内部承担 */
  .page > * {
    grid-column: 1 / -1;
  }

  /* 内容层：单行铺满余高。列宽 / 间距 / 对齐从 .page 继承（base.css 那条），
     这里只补它没继承的两样 —— 行高与 min-height：栅格项默认 min-height: auto，
     不给 0 就会被内容顶高，两栏永远等不到滚动条，底部还会被裁掉一截。 */
  .page > .rubber-layer {
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
  }

  /* 一栏：自己滚。底部让开悬浮 Dock（以及停靠时的悬浮运动条）——
     竖屏是文档滚动、由 --page-pad-bottom 兜住这一让；这里是内层滚动区，得自己让，
     否则两栏各自滚到底时，最后一行永远停在玻璃底下。 */
  .pane {
    min-width: 0;
    /* 内层滚动的前提：栅格项默认 min-height: auto，不给 0 就撑成内容高度 */
    min-height: 0;
    overflow-y: auto;
    /* 滚到底不要把手势递给另一栏：滚动链到此截断（超伸回弹仍归这一栏自己） */
    overscroll-behavior: contain;
    /* 底部让位量 = Dock 上缘 + 一格 8 + 运动条预留：--wbar-reserve 保持透传，
       悬浮运动条停靠时这一栏仍能滚出它盖住的区域 */
    padding-bottom: calc(var(--dock-top) + var(--gap-sm) + var(--wbar-reserve, 0px));
  }

  /* 待办栏的小标题：与卡头同族但低一档，读作「这一栏是什么」 */
  .pane-title {
    padding-bottom: var(--gap-sm);
    font-size: var(--fs-subhead);
    font-weight: var(--fw-bold);
    color: var(--text-2);
  }

  /* 计时栏里的今日日程：与竖屏的卡片间隔同值（那边由 .card + .card 的 12px 承担） */
  .sched {
    margin-top: var(--gap-md);
  }

  /* ---------- 窄栏里的卡内排版修正（:deep，只在这一条媒体查询里生效） ----------
     480 的窄栏一分为二后，卡内只剩 ~170px（卡片自带的 20px 内边距也占掉一份）。
     实测（844×390 真视口）有三处会在这条窄栏里散架：汉字被压成一字一行、
     控制簇比整栏还宽。三处都只是把「横排」改成「放不下就换行 / 收紧间距」，
     组件自己那套（430 竖屏宽下标定的）排版一个字没动 —— 竖屏与桌面照旧。

     · `.head`：卡头横排时标题被挤到 ~19px —— 「番茄钟」竖成三行；
       `.head-right` 是因为 space-between 在换行后会靠左，补一条 margin-left: auto 归位；
     · `.acts`：四颗圆钮 + 10px 间距 + 两边内边距 = 226px，比整栏（211，实测）还宽，
       运行态会把最外侧两颗顶出栏外（栏是 overflow: auto，会被裁）；收窄间距与内边距
       后实测 208px —— 正好收进栏内，且圆钮仍是 44/56px（触区是拇指下限，不缩）；
     · `.meta`：待办行的「时间 · 分类 · 优先级」同理会把「运动」压成一字一行。 */
  .pane-timer :deep(.head) {
    flex-wrap: wrap;
    row-gap: var(--gap-sm);
  }

  .pane-timer :deep(.head-right) {
    margin-left: auto;
  }

  .pane-timer :deep(.acts) {
    gap: var(--gap-tight);
    padding: var(--sp-6) var(--gap-tight);
  }

  .pane-todos :deep(.meta) {
    flex-wrap: wrap;
    row-gap: var(--gap-tight);
  }
}
</style>
