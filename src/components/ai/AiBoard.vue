<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Archive,
  Camera,
  ChartPie,
  Dumbbell,
  NotebookPen,
  Search as SearchIcon,
  Sparkles,
  TrendingUp,
  Wallet,
} from 'lucide-vue-next'

import ActivityRings from '@/components/common/ActivityRings.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import { useAiStore } from '@/stores/ai'
import { useNutritionStore } from '@/stores/nutrition'
import { listFoodDrafts, type FoodDraft } from '@/utils/foodDrafts'
import { todayStr } from '@/utils/date'
import { fmtSameDayTime } from '@/utils/format'
import type { RingItem } from '@/components/common/ActivityRings.vue'

/**
 * AI 会话看板：**空会话时的整屏主页**。
 *
 * 为什么不是一条欢迎语：原来那句「你好，我是 Rein AI……」是纯文字，
 * 与下面第一条真实消息长得一模一样（都是气泡、都居左）—— 分不清哪条是机器说的、
 * 哪条是数据。而这个页面真正缺的不是寒暄，是**「我现在能干什么」**：
 * 拍照识食、记账、查知识库、语音纪要这些能力散落在各页，用户得先知道它们存在。
 *
 * 所以这里给三块，取代那一条字：
 *   1. 今天 —— 摄入/运动/剩余三个数（真实数据，不是装饰）
 *   2. 做什么 —— 五个能力入口，点开直接把那句话填进输入框（不是执行固定动作）
 *   3. 接着聊 —— 最近会话；没有草稿/会话时显示空状态而不是留白
 */

const emit = defineEmits<{
  /** 把一句现成的话递给输入框（不直接发送，见 quickAsks 的注释） */
  ask: [text: string]
  /** 打开饮食草稿箱弹层 —— 由 AIPage 实现（草稿箱的 state 在那边） */
  drafts: []
}>()

const ai = useAiStore()
const nutrition = useNutritionStore()

const today = todayStr()
const drafts = ref<FoodDraft[]>([])

onMounted(() => {
  if (!nutrition.summary) void nutrition.loadSummary(today)
  drafts.value = listFoodDrafts()
})

/* ---------- 1. 今天 ---------- */

const rings = computed<RingItem[]>(() => {
  const s = nutrition.summary
  if (!s) return []
  const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0)
  // 第三环与下面那格「还可吃」必须同一个口径：环的图例就画在「还可吃」旁边，
  // 从前的环用 `目标 − 已摄入`、数字用 `目标 − 已摄入 − 运动` —— 同一张卡上
  // 两个「还能吃多少」互不相等（图例色 `--c-balance` 与 `stats.left` 同源）。
  const left = Math.max(0, s.targets.kcal - s.intake.kcal - s.exerciseKcal)
  return [
    { key: 'intake', value: ratio(s.intake.kcal, s.targets.kcal), colorVar: 'var(--c-intake)' },
    { key: 'exercise', value: ratio(s.exerciseKcal, s.targets.kcal), colorVar: 'var(--c-exercise)' },
    { key: 'balance', value: ratio(left, s.targets.kcal), colorVar: 'var(--c-balance)' },
  ]
})

/** 三格数字：已摄入 / 运动 / 剩余。空数据时给占位而不是 0 —— 0 会被读成「今天没吃」 */
const stats = computed(() => {
  const s = nutrition.summary
  if (!s) return null
  return {
    intake: Math.round(s.intake.kcal),
    target: Math.round(s.targets.kcal),
    exercise: Math.round(s.exerciseKcal),
    left: Math.max(0, Math.round(s.targets.kcal - s.intake.kcal - s.exerciseKcal)),
  }
})

/* ---------- 2. 做什么 ----------
 * 每一项只做一件事：把一句现成的话填进输入框。**不直接执行** ——
 * 「查一下我这周练了几次」该由模型决定调哪个工具、调到什么粒度；
 * 前端替它决定就成了「又一块设定好的卡片」，那正是要删掉的那种东西。 */

interface QuickAsk {
  id: string
  label: string
  hint: string
  icon: typeof Camera
  /** 圆章底与前景：走域色，与主页工具格同一套配方 */
  bg: string
  fg: string
  text: string
}

const quickAsks: QuickAsk[] = [
  {
    id: 'photo',
    label: '拍照识食',
    hint: '一句话记一餐',
    icon: Camera,
    bg: 'color-mix(in srgb, var(--c-intake) 12%, transparent)',
    fg: 'var(--c-intake)',
    text: '我刚吃了',
  },
  {
    id: 'analyze',
    label: '分析今日',
    hint: '让 AI 看真实条目',
    icon: ChartPie,
    bg: 'color-mix(in srgb, var(--c-intake) 12%, transparent)',
    fg: 'var(--c-intake)',
    text: '看看我今天的饮食摄入，分析一下结构和问题，并给出明天可以怎么调整的建议。',
  },
  {
    id: 'ledger',
    label: '记一笔账',
    hint: '说金额和用途',
    icon: Wallet,
    bg: 'color-mix(in srgb, var(--cat-workout) 12%, transparent)',
    fg: 'var(--ok-strong)',
    text: '帮我记一笔账：',
  },
  {
    id: 'workout',
    label: '问训练',
    hint: '看这周练了什么',
    icon: Dumbbell,
    bg: 'color-mix(in srgb, var(--c-exercise) 20%, transparent)',
    fg: 'var(--c-exercise-deep)',
    text: '看一下我这周练了几次，帮我总结一下',
  },
  {
    id: 'kb',
    label: '翻记录',
    hint: '找以前提过的事',
    icon: SearchIcon,
    bg: 'color-mix(in srgb, var(--cat-study) 14%, transparent)',
    fg: 'var(--cat-study)',
    text: '搜一下我的历史记录里关于',
  },
  {
    id: 'note',
    label: '记一条',
    hint: '随手记进知识库',
    icon: NotebookPen,
    bg: 'color-mix(in srgb, var(--led-shopping) 12%, transparent)',
    fg: 'var(--led-shopping)',
    text: '帮我记一条笔记：',
  },
]

/* ---------- 3. 接着聊 ---------- */

const recent = computed(() => ai.chats.slice(0, 4))

function fmtTime(iso: string): string {
  return fmtSameDayTime(iso)
}

const isEmpty = computed(() => recent.value.length === 0 && drafts.value.length === 0)
</script>

<template>
  <div class="board">
    <!-- 1. 今天 -->
    <section v-if="stats" class="today">
      <ActivityRings :rings="rings" :size="52" />
      <div class="t-stats">
        <div class="t-row">
          <b class="num">{{ stats.intake }}<i class="t-unit">大卡</i></b>
          <span class="t-lab">已摄入</span>
          <PillChip tone="muted" size="sm">目标 <span class="num">{{ stats.target }}</span> 大卡</PillChip>
        </div>
        <p class="t-sub">
          <span><i class="d" style="background: var(--c-exercise)" />运动 <span class="num">{{ stats.exercise }}</span> 大卡</span>
          <span><i class="d" style="background: var(--c-balance)" />还可吃 <span class="num">{{ stats.left }}</span> 大卡</span>
        </p>
      </div>
    </section>

    <!-- 2. 做什么 -->
    <section class="sec">
      <h2 class="sec-t">
        做什么
        <InfoHint
          title="点一下会发生什么"
          content="点一下只是把话递给你 —— 接下来你说多少、问什么，AI 那边自己判断。"
        />
      </h2>
      <TransitionGroup appear name="pop" tag="div" class="grid">
        <button
          v-for="(q, i) in quickAsks"
          :key="q.id"
          class="qa"
          :style="{ '--i': i }"
          @click="emit('ask', q.text)"
        >
          <i class="qa-ic" :style="{ background: q.bg, color: q.fg }">
            <component :is="q.icon" :size="18" :stroke-width="2.2" />
          </i>
          <span class="qa-t">
            <b>{{ q.label }}</b>
            <em>{{ q.hint }}</em>
          </span>
        </button>
      </TransitionGroup>
      <p class="qa-tip">
        <PillChip tone="muted" size="sm">点一下只是把话递给你</PillChip>
      </p>
    </section>

    <!-- 3. 接着聊 -->
    <section class="sec">
      <template v-if="!isEmpty">
        <div v-if="drafts.length" class="drafts">
          <!-- 打开草稿箱弹层（不 push 路由 —— 本来就在 AI 页上，push 到自己等于没反应） -->
          <button class="dr" @click="emit('drafts')">
            <i class="dr-ic"><Archive :size="15" /></i>
            <span class="flex-1">
              <b>饮食草稿箱 · {{ drafts.length }}</b>
              <em>{{ drafts[0]?.items.map((i) => i.foodName).slice(0, 3).join('、') ?? '' }}</em>
            </span>
            <span class="dr-go">继续 ›</span>
          </button>
        </div>

        <div v-if="recent.length">
          <h2 class="sec-t">接着聊</h2>
          <ul class="chats">
            <li v-for="c in recent" :key="c.id">
              <button class="ch" @click="ai.selectChat(c.id)">
                <i class="ch-ic"><Sparkles :size="14" /></i>
                <span class="flex-1">
                  <b>{{ c.title }}</b>
                </span>
                <span class="t-3 ch-t num">{{ fmtTime(c.updatedAt) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </template>

      <EmptyState
        v-else
        :icon="TrendingUp"
        title="还没有会话"
        hint="上面选一件事开始，或者直接在下面说话"
      />
    </section>
  </div>
</template>

<style scoped>
.board {
  padding: var(--sp-4) var(--sp-2) var(--sp-8);
}

/* ---------- 今天 ---------- */
/* 「今天」是一张卡：圆角走卡片档 16（不是按钮的 20），内距 16、卡片间距 24 */
.today {
  display: flex;
  align-items: center;
  gap: var(--gap-lg);
  padding: var(--pad-card);
  margin-bottom: var(--gap-xl);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

/* 桌面：这张卡是「一圈环 + 三个数」，整幅铺开时右侧空掉五百多像素
   （实测卡宽 756、内容只占 460 上下）—— 按内容收口，但要**收在栅格线上**：
   下面那条看板是三列，卡收到「两列 + 一个缝」，右缘正好落在第二格右沿。
   原来写死 460px，在 756 的栏里既不铺满也不对齐，读起来像卡没渲染完
   （换人看图的 1512 那组就是这么报的）。手机不动：430 上铺满是合理的。 */
.desk-main .today {
  max-width: calc((100% - 20px) / 3 * 2 + 10px);
}

.t-stats {
  min-width: 0;
  flex: 1;
}

.t-row {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
}

.t-row b {
  font-size: var(--fs-large-title);
  /* 展示级大数字走 Light 档（阶梯里最轻的一档是 300，200 在阶梯外） */
  font-weight: var(--fw-light);
  letter-spacing: -1px;
  line-height: 1;
  /* 摄入量是数值：数值一律中性色 —— 色相只允许出现在图标/色点/进度条与图表/类型字章上
     （色彩配额，STANDARDS §4）。intake 的色相留在色点与条上，不爬到数字上来。 */
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.t-unit {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  margin-left: var(--sp-4);
}

.t-lab {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.t-sub {
  display: flex;
  gap: var(--gap-lg);
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 色点尺寸是图形几何（7px 视觉点），不是间距；点与字的距离走 4 */
.t-sub .d {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: var(--sp-4);
}

/* ---------- 分节 ---------- */
.sec {
  margin-bottom: var(--gap-xl);
}

/* 分节标题：14 Semibold 主色（原来是 12/700 的三级灰眉标，读不出「这是新一轮」） */
.sec-t {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  margin-bottom: var(--gap-sm);
  padding-left: var(--sp-2);
}

/* ---------- 做什么 ---------- */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-md);
}

/* 桌面：整块看板落在 760 的阅读栏里（实测 756），两列时每格 373px，
   而格子内容（40 圆章 + 两行字）只要 111–128px —— 右侧三百多像素全空着，
   六格还被拉成三屏高。三列收口：每格 ~245px，格内可用宽 ~170px，
   最长的那条提示「让 AI 看真实条目」约 92px，仍留得下（不会走到省略号）。
   只在 .desk-main 下生效：手机（430）保持两列，不放宽也不挤窄。 */
.desk-main .grid {
  grid-template-columns: repeat(3, 1fr);
}

.qa {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  min-width: 0;
}

/* 圆章：与主页工具格同一套几何（40px 圆 + 域色 12–20% 底） */
.qa-ic {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
}

.qa-t {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  min-width: 0;
  flex: 1;
}

.qa-t b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.qa-t em {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-regular);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 六格入口的结论行：胶囊承载；完整解释收进标题行 InfoHint，分层不重复 */
.qa-tip {
  margin-top: var(--gap-md);
  padding-left: var(--sp-2);
}

/* 悬停反馈（只有真有指针的设备才要）：内容卡走「抬影」—— 与 base.css 里
   桌面统一补的那条同一条约定（.desk-main .card.pressable:hover 也是 --shadow-float）。
   前缀 .desk-main 不是为了区分形态，是**特异性**：base.css 给 .qa 铺玻璃材质那条是
   `html[data-perf]:not([data-perf='low']) .qa`（0,3,1），
   而 scoped 的 `.qa:hover` 只有 0,3,0 —— 不加前缀，悬停影会被那一条整条吃掉，
   在高画质及以上档位（也就是默认档）等于没写。
   会话行（.ch）在白色列表里，走底色那一档，与 FileRow 等长列表同一条。 */
@media (hover: hover) {
  .desk-main .qa:hover {
    box-shadow: var(--shadow-float);
  }

  .ch:hover {
    background: var(--surface-2);
  }
}

/* 看板入场：六格按 --i 递增延迟依次淡入上移。appear 让空会话刚挂上时也播一遍。
   transition 不用 @keyframes —— 会话清空后看板可能立刻重建，动画必须可打断。 */
.pop-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-out) calc(var(--i, 0) * var(--enter-stagger, 40ms)),
    transform var(--dur-base) var(--ease-out) calc(var(--i, 0) * var(--enter-stagger, 40ms));
}

.pop-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

/* ---------- 草稿 / 会话 ---------- */
.dr {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h-double);
  padding: var(--sp-8) var(--pad-inline);
  margin-bottom: var(--gap-md);
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--ok) 10%, var(--surface));
  text-align: left;
  min-width: 0;
}

.dr-ic {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--surface);
  color: var(--ok-strong);
}

.dr b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.dr em {
  display: block;
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dr-go {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--ok-strong);
}

.chats {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

/* 会话行：48 的单行列表档，左右走列表行内距 16 */
.ch {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  width: 100%;
  min-height: var(--row-h);
  padding: 0 var(--pad-row);
  text-align: left;
  min-width: 0;
}

.ch + .ch {
  border-top: 0.5px solid var(--line);
}

.ch-ic {
  width: 24px;
  height: 24px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--text-3);
}

.ch b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch-t {
  flex: none;
  font-size: var(--fs-caption);
}
</style>
