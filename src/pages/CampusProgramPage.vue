<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { BookOpen, RefreshCw, Search } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { campusService } from '@/services/campusService'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import type { ProgramCreditNode, ProgramCreditStat, ProgramInfo } from '@/types'

/**
 * 培养方案。
 *
 * 数据源是教务的 `program-info-json`（实测 900KB+），后端拉一次落 `app_meta` 缓存，
 * 之后离线可读。页面只用其中三段：方案档案、学分分布树、课程清单。
 */
const store = useCampusStore()
const toast = useToast()

const loading = ref(true)
const error = ref('')
const info = ref<ProgramInfo | null>(null)

const keyword = ref('')

/** 学分分布：把树摊平成一维行，用 depth 控制缩进 —— 不做跨层求和，
 *  照教务的口径逐级列出，避免把「父含子」的学分算两遍。 */
interface CreditRow {
  key: string
  name: string
  depth: number
  stats: ProgramCreditStat[]
}

function flatten(node: ProgramCreditNode, depth: number, out: CreditRow[], path: string): void {
  const name = node.type?.nameZh ?? '未命名模块'
  const key = `${path}/${name}`
  out.push({ key, name, depth, stats: node.courseStatistics ?? [] })
  for (const [i, c] of (node.children ?? []).entries()) {
    flatten(c, depth + 1, out, `${key}#${i}`)
  }
}

const creditRows = computed<CreditRow[]>(() => {
  const table = info.value?.creditDistrTable
  if (!table) return []
  const out: CreditRow[] = []
  for (const [i, c] of (table.children ?? []).entries()) flatten(c, 0, out, `r${i}`)
  return out
})

const totalCredits = computed(() => info.value?.creditDistrTable?.sumCredit ?? null)
const earnedCredits = computed(() => store.account?.totalCredits ?? null)

/** 已修 / 要求，用于进度条；要求缺失时不画 */
const progress = computed(() => {
  const need = totalCredits.value
  const got = earnedCredits.value
  if (!need || got == null) return null
  return { got, need, pct: Math.max(0, Math.min(1, got / need)) }
})

const courses = computed(() => info.value?.courseList ?? [])

const filteredCourses = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return courses.value
  return courses.value.filter(
    (c) => c.nameZh.toLowerCase().includes(k) || (c.code ?? '').toLowerCase().includes(k),
  )
})

function statText(stats: ProgramCreditStat[]): string {
  if (stats.length === 0) return ''
  return stats
    .map((s) => `${s.courseProperty?.nameZh ?? '—'} ${s.sumCredit} 学分`)
    .join(' · ')
}

async function load(refresh = false): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const payload = await campusService.program(refresh)
    info.value = payload?.programInfos?.[0] ?? null
    if (!info.value) error.value = '教务系统未返回培养方案'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '获取培养方案失败'
  } finally {
    loading.value = false
  }
}

async function onRefresh(): Promise<void> {
  await load(true)
  if (!error.value) toast.toast('培养方案已更新')
}

onMounted(async () => {
  await store.init()
  if (!store.hasAccount) {
    loading.value = false
    error.value = '还没有绑定教务系统账号'
    return
  }
  await load()
})
</script>

<template>
  <div class="page">
    <PageHeader title="培养方案" :subtitle="info?.nameZh ?? ''" back>
      <template #action>
        <button class="hdr-btn" :disabled="loading" aria-label="刷新培养方案" @click="onRefresh">
          <RefreshCw :size="19" :class="{ spin: loading }" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 会话过期时给一条明确的路，而不是让用户自己去「课表配置」里翻 -->
    <EmptyState
      v-if="error"
      :icon="BookOpen"
      :title="error"
      :hint="isSessionLostMessage(error) ? '重新登录一次教务系统就能继续看' : '检查课表配置里的登录状态后重试'"
    >
      <template v-if="isSessionLostMessage(error)" #action>
        <RouterLink :to="{ name: 'campus-settings' }" class="cta">去重新登录</RouterLink>
      </template>
    </EmptyState>

    <!-- 拉取中不能什么都不渲染：那是一页空白，读起来像页面坏了 -->
    <EmptyState
      v-else-if="loading"
      :icon="BookOpen"
      title="正在拉取培养方案…"
      hint="正在从教务系统读取档案、学分与课程清单"
    />

    <template v-else-if="info">
      <!-- 桌面栅格：壳层只把 .page 的**直接子项**摊成两栏，而这一页要的是
           「档案 | 学分分布 并排 + 课程清单通栏」，所以自带一层 .d-grid 承接。
           手机端它只是个普通 div，块流与卡片间距都不变 -->
      <div class="d-grid prog-grid">
      <!-- 档案 -->
      <section class="card">
        <div class="meta-grid">
          <div><span class="k">年级</span><span class="v">{{ info.grade ?? '—' }}</span></div>
          <div><span class="k">学历</span><span class="v">{{ info.education?.nameZh ?? '—' }}</span></div>
          <div><span class="k">院系</span><span class="v">{{ info.department?.nameZh ?? '—' }}</span></div>
          <div><span class="k">专业</span><span class="v">{{ info.major?.nameZh ?? '—' }}</span></div>
          <div><span class="k">培养类型</span><span class="v">{{ info.cultivateType?.nameZh ?? '—' }}</span></div>
          <div><span class="k">课程门数</span><span class="v num">{{ courses.length }}</span></div>
        </div>

        <div v-if="progress" class="prog">
          <div class="prog-top">
            <span class="prog-label">学分进度<em>已修 / 要求</em></span>
            <span class="prog-fig">
              <span class="prog-num num">{{ progress.got }} / {{ progress.need }}</span>
              <span class="prog-unit">学分</span>
              <InfoHint
                class="prog-help"
                title="学分进度怎么算"
                content="已修学分取自习成绩单；要求学分为培养方案总学分。仅统计已出成绩的课程。"
              />
            </span>
          </div>
          <div class="bar"><div class="fill" :style="{ transform: `scaleX(${progress.pct})` }" /></div>
        </div>
      </section>

      <!-- 学分分布 -->
      <section v-if="creditRows.length" class="card">
        <h2 class="sec">
          学分分布<InfoHint title="学分分布怎么读" content="按教务的模块层级逐级列出，不做跨层求和，避免重复计入学分。" />
        </h2>
        <ul class="credit">
          <li
            v-for="r in creditRows"
            :key="r.key"
            class="crow"
            :class="{ l1: r.depth === 0, l2: r.depth >= 1 }"
            :style="{ '--crow-depth': r.depth }"
          >
            <span class="cname">{{ r.name }}</span>
            <span v-if="statText(r.stats)" class="cstat">{{ statText(r.stats) }}</span>
          </li>
        </ul>
      </section>

      <!-- 课程清单：这一页唯一的长列表，桌面上通栏 -->
      <section v-if="courses.length" class="card d-full">
        <h2 class="sec">课程清单 <em class="num">{{ filteredCourses.length }}/{{ courses.length }}</em></h2>
        <div class="search">
          <Search :size="15" />
          <input v-model="keyword" type="search" placeholder="搜索课程名或代码" />
        </div>
        <ul class="courses" data-rubber-self>
          <li v-for="c in filteredCourses" :key="c.id" class="course">
            <span class="cname">{{ c.nameZh }}</span>
            <span v-if="c.code" class="ccode num">{{ c.code }}</span>
          </li>
        </ul>
      </section>
      </div>

      <p v-if="info.printedTime" class="foot">{{ info.printedTime }}</p>
    </template>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶距走 --page-pad-top（手机 12 / 桌面 40），与全库页面同一处来源 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.sec {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  /* 区块标题与内容是主从关系，取 8 档（原来是 10，与卡片内其它 8 对不齐） */
  margin-bottom: var(--gap-sm);
}

.sec em {
  font-style: normal;
  font-weight: var(--fw-semibold);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ---------- 档案 ---------- */
.meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  /* 档案格：行间 12（卡内区块档）、列间 16（有明显边界的列） */
  gap: var(--gap-md) var(--gap-lg);
}

.meta-grid > div {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  min-width: 0;
}

.k {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.v {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  font-variant-numeric: tabular-nums;
}

.prog {
  margin-top: var(--gap-lg);
}

.prog-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--gap-sm);
}

.prog-label {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 分子分母不靠下方说明去猜：「已修 / 要求」跟在标题旁，数字与单位各自一档 */
.prog-label em {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  margin-left: var(--gap-sm);
}

.prog-fig {
  display: inline-flex;
  align-items: baseline;
  /* 数字 / 单位 / 说明图标同属一档读数，横向取 8（主次文本左右） */
  gap: var(--gap-sm);
  margin-left: auto;
}

/* InfoHint 落在图表行右侧；其按钮是按自身基线对齐的，单独居中 */
.prog-help {
  align-self: center;
}

.prog-unit {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.prog-num {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  /* 数值不使用色相（色彩配额）：强调交给字号与字重 */
  color: var(--text-1);
}

.bar {
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.fill {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  transform-origin: left center;
  transition: transform var(--dur-base) var(--ease-standard);
}

/* ---------- 学分分布 ---------- */
.credit {
  display: flex;
  flex-direction: column;
}

.crow {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  /* 列表行上下 8：原 7 不在栅格上，且与相邻行的分隔线对不齐 */
  padding: var(--sp-8) 0;
  /* 层级缩进也走令牌：基础 10 + 每级 14（与原来 10 + depth×14 的像素值一致） */
  padding-left: calc(var(--sp-10) + var(--crow-depth, 0) * var(--sp-14));
  border-bottom: 0.5px solid var(--line);
}

.crow:last-child {
  border-bottom: none;
}

.cname {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  line-height: var(--lh-subtitle);
}

.crow.l1 .cname {
  font-weight: var(--fw-bold);
  font-size: var(--fs-callout);
}

.crow.l2 .cname {
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.cstat {
  flex: none;
  font-size: var(--fs-micro);
  /* 「必修 30 学分」是文字信息，不是图表：走次级文本色，不借用强调色 */
  color: var(--text-2);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}

/* ---------- 课程清单 ---------- */
.search {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 输入条：左右 12（小控件左右档）、纵 8；与下方清单隔 8。
     高度补到 44：这一条在手机上就是搜索框本体，32 高不好点 */
  min-height: var(--hit-min);
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-3);
  margin-bottom: var(--gap-sm);
}

.search input {
  flex: 1;
  min-width: 0;
  /* 输入框撑满整行 44 高：整行看着可点，就不该只有那条 17px 的文字线真的可点 */
  align-self: stretch;
  font-size: var(--fs-caption);
  color: var(--text-1);
  background: none;
}

.courses {
  display: flex;
  flex-direction: column;
  max-height: 340px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   档案与学分分布用 auto-fit 而不是写死两栏：学分分布为空（creditRows 为空）时
   只剩档案一张，它该铺满整行，而不是缩在左半栏。
   课程清单是这一页唯一的长列表：970px 宽、每行只有「课名 + 课程号」的一列
   是读不完的，通栏之后内部摊成两栏。**保留原来的 340px 视口 + 滚动** ——
   课程清单可能有几百门，它不是这一页的主角，档案与学分才是。
   ============================================================ */
.desk-main .prog-grid {
  grid-template-columns: repeat(auto-fit, minmax(var(--desk-aside), 1fr));
}

.desk-main .courses {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--desk-gap);
}

/* 两栏里每条都自己带下边线（原有规则），行与行之间才分得开 */

.course {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
  border-bottom: 0.5px solid var(--line);
}

.course:last-child {
  border-bottom: none;
}

.ccode {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* 页脚说明合成一条声明：原先同一个 .foot 写了两遍（第二遍只补对齐与内距），
   拆开读容易漏掉其中一半，合并后上下内距一并收进栅格 */
.foot {
  margin-top: var(--gap-sm);
  padding: var(--sp-8) 0 var(--sp-4);
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-subtitle);
}

/* 「去重新登录」：与选课页同一个样式，两个空状态的出口看起来要是一回事 */
.cta {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  /* 与选课页 / 课表页的空态出口同一形状：高 40、左右 24、胶囊 */
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-24);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* RouterLink 不继承 button 的按压反馈，这里补上；命中区同时补到 44 */
.cta::after {
  content: '';
  position: absolute;
  inset: -2px 0;
}

.cta:active {
  transform: scale(0.96);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation-duration: 2.4s;
  }
  .fill {
    transition: none;
  }
}
</style>
