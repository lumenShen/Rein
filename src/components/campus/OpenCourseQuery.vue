<script setup lang="ts">
/**
 * 全校开课查询 + **两个域都检测**。
 *
 * 与「选课」的关键区别：**不依赖选课批次** —— 批次没开的时候照样能查全校开了哪些课。
 * 所以它是「提前规划抢什么」的依据：先看清开课名单与时间地点，再去排志愿。
 *
 * 界面有意把「两个域各自的探测结论」摆在名单**前面**：
 * 本科教务挂着两个域名，但它们不是同一套系统（一个是树维 EAMS5、
 * 另一个是 ASP.NET + ExtJS 桌面走 CAS）。合并汇报会把「这个域压根没有 EAMS5」
 * 伪装成「两个域都没这门课」，那种谎在抢课当天很贵。
 */
import { computed, onMounted, ref } from 'vue'
import { AlertTriangle, Info, RefreshCw, Search } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import { campusService } from '@/services/campusService'
import { useCampusStore } from '@/stores/campus'
import type { LessonSearchHit, LessonSearchOutcome, SchoolDomainProbe } from '@/types'

const campus = useCampusStore()

const loading = ref(false)
const outcome = ref<LessonSearchOutcome | null>(null)
const probe = ref<SchoolDomainProbe[]>([])
const error = ref<string | null>(null)

/**
 * 学期取自校园 store —— **唯一来源**。
 *
 * 这个组件原先自己存了一个 `semesterId = ref(null)`，但全文件没有任何地方
 * 给它赋过值（`run()` 里那句 `if (!semesterId.value && …)` 写在「它非空」的分支里，
 * 是够不着的死代码）。于是这张卡永远停在「还没有拿到学期列表」，
 * 而它给的出口「先刷新一次」只会再弹同一句话 —— 用户被卡在一个没有出路的循环里。
 */
const semesterId = computed(() => campus.currentSemesterId ?? campus.semesters[0]?.id ?? null)
const keyword = ref('')

/** 本地过滤：教务那边的筛选要靠服务端会话，这里只做「已经拿到的这页」的检索 */
const filtered = ref<LessonSearchHit[]>([])

function applyFilter(): void {
  const hits = outcome.value?.page.hits ?? []
  const k = keyword.value.trim().toLowerCase()
  if (!k) {
    filtered.value = hits
    return
  }
  // 课名 / 课程代码 / 教学班名 / 教师 / 时间地点 都要能搜到
  filtered.value = hits.filter((h) => {
    const hay = [
      h.course?.nameZh ?? '',
      h.course?.code ?? '',
      h.nameZh ?? '',
      h.scheduleText ?? '',
      teachersOf(h).join(' '),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(k)
  })
}

/** 教师列表的形状随教务而变，所以按「能认出来就认」处理 */
function teachersOf(h: LessonSearchHit): string[] {
  const list = h.teacherAssignmentList
  if (!Array.isArray(list)) return []
  return list
    .map((t) => {
      if (typeof t === 'string') return t
      const o = t as Record<string, unknown>
      return String(o.nameZh ?? o.name ?? o.teacherName ?? '')
    })
    .filter(Boolean)
}

function textOf(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(' / ')
  const o = v as Record<string, unknown>
  return String(o.nameZh ?? o.name ?? o.value ?? '')
}

function codeOf(h: LessonSearchHit): string {
  return textOf(h.course?.code)
}

function idOf(h: LessonSearchHit): string {
  return textOf(h.id)
}

async function loadProbe(): Promise<void> {
  try {
    probe.value = await campusService.lessonSearchProbe()
  } catch {
    // 探测失败不该挡住查询本身：它是说明性的，不是前置条件
    probe.value = []
  }
}

async function run(): Promise<void> {
  const id = semesterId.value
  if (id == null) {
    // 说清「为什么查不了」以及**出口在哪**，而不是弹一句让用户去点刷新、
    // 点完还是同一句话的死循环
    error.value = '还没有拿到学期列表 —— 到「课表配置与设置」登录或同步一次，再回来看。'
    return
  }
  loading.value = true
  error.value = null
  try {
    const r = await campusService.lessonSearch(id)
    outcome.value = r
    probe.value = r.domains
    applyFilter()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    // 失败时也要把两个域的探测结论拿到手 —— 用户最需要知道的正是「哪个域不行」
    await loadProbe()
  } finally {
    loading.value = false
  }
}

/** 先探一次拿到两个域的结论，再查第一页 */
async function init(): Promise<void> {
  await loadProbe()
  await run()
}

onMounted(init)
</script>

<template>
  <section class="card open-course">
    <header class="head">
      <h2>全校开课查询</h2>
      <button class="mini" :disabled="loading" @click="run">
        <RefreshCw :size="14" :class="{ spin: loading }" />
        {{ loading ? '查询中' : '刷新' }}
      </button>
    </header>
    <p class="hint">
      看清全校开了哪些课、谁在什么时候上 —— <b>与选课批次无关</b>，批次没开也能查。
      查到合适的班可以照着去排抢课计划。
    </p>

    <!-- 两个域都检测：把各自的结论摆出来，不合并。
         **但结论是说给学生的**：域名、EAMS5、HTTP 码是他没法处理的东西 ——
         他要知道的只有一句「这个学期能不能在它上面查到开课名单」，
         技术细节收进「技术详情」里，排障时照样拿得到 -->
    <div v-if="probe.length" class="domains">
      <div v-for="d in probe" :key="d.baseUrl" class="domain" :class="{ ok: d.eamsAssets, off: !d.eamsAssets }">
        <span class="host">{{ d.baseUrl.replace(/^https?:\/\//, '') }}</span>
        <span class="verdict">{{ d.eamsAssets ? '可以查开课' : '另一套系统，查不到' }}</span>
        <details v-if="d.detail" class="tech">
          <summary>技术详情</summary>
          <p>{{ d.detail }}</p>
        </details>
      </div>
    </div>

    <EmptyState
      v-if="error"
      :icon="AlertTriangle"
      title="没有查到开课名单"
      :hint="error"
    />

    <template v-else-if="outcome">
      <div class="toolbar">
        <label class="field">
          <Search :size="14" />
          <input v-model="keyword" placeholder="按课名 / 代码 / 教师 / 时间地点筛选本页" @input="applyFilter" />
        </label>
        <!-- 只交代范围，不印「共 N」：「共 N」取的是教务回执里的整库条数，
             而这张卡只请求了第一页、也没有翻页入口 —— 读者会把「共 851」
             读成「可以翻到 851 条」，实际手上只有第一页 -->
        <span class="count">
          本页 <span class="num">{{ filtered.length }}</span> 条 · 仅第一页结果
        </span>
      </div>

      <p class="src">
        数据来自
        <b>{{ (outcome.usedBaseUrl ?? '').replace(/^https?:\/\//, '') }}</b>
      </p>

      <EmptyState
        v-if="!filtered.length"
        :icon="Info"
        title="这一页没有开课记录"
        hint="换个筛选词，或稍后再刷新一次"
      />

      <ul v-else class="list">
        <li v-for="h in filtered" :key="idOf(h)" class="row">
          <div class="l1">
            <span class="name">{{ h.course?.nameZh ?? '(未知课程)' }}</span>
            <span v-if="h.nameZh" class="lesson">{{ h.nameZh }}</span>
            <span v-if="codeOf(h)" class="num">{{ codeOf(h) }}</span>
            <span v-if="h.course?.credits != null" class="dim">{{ h.course.credits }} 学分</span>
          </div>
          <div class="l2 dim">
            <span v-if="teachersOf(h).length">教师 {{ teachersOf(h).join('、') }}</span>
            <span v-if="h.scheduleText">{{ h.scheduleText }}</span>
            <span v-if="textOf(h.campus)">{{ textOf(h.campus) }}</span>
            <span v-if="textOf(h.courseType)">{{ textOf(h.courseType) }}</span>
          </div>
        </li>
      </ul>

      <!-- 空页时把教务回的字段名收进详情：它能区分「确实没开课」和「教务改了字段名」，
           但那是排障信息，不该印在学生的卡片正面 -->
      <details v-if="!filtered.length && outcome.page.rawKeys.length" class="tech">
        <summary>技术详情</summary>
        <p>教务这一页返回的字段：{{ outcome.page.rawKeys.join('、') }}</p>
      </details>
    </template>

    <p v-else-if="loading" class="hint">正在查开课名单…</p>
  </section>
</template>

<style scoped>
/* 这一块原先自带一套外观（--radius-m + 1px 描边、没有卡片阴影），
   在一页 --radius-xl + shadow-card 的卡片里像是另一个应用。拉回同一套语言 ——
   它是同一页上的第二块内容，不是嵌进来的工具 */
.card {
  padding: var(--pad-card);
  /* 卡片档 16：这块与同页其它卡片是同级的内容容器，32 是半模态的圆角；
     与它们同档之后「同一页的几块」才读得出是一组 */
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  margin-bottom: var(--gap-md);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-10);
}
.head h2 {
  /* 原先写的是 var(--fs-title) —— 这个令牌**不存在**（阶梯里叫 title1/2/3），
     于是标题字号一直落在浏览器的默认档上。与同页其它卡片标题对齐 */
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  margin: 0;
}
.mini {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  min-height: 32px;
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-full);
  border: 1px solid var(--line);
  background: transparent;
  /* 原先的 var(--text) 也不存在（只有 --text-1/2/3），文字色一直是继承来的 */
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}
.mini::after {
  content: '';
  position: absolute;
  inset: -6px 0;
}
.hint {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
  margin: var(--sp-8) 0 0;
}
.domains {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  margin-top: var(--sp-10);
}
.domain {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-8);
  padding: var(--sp-8) var(--sp-10);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-caption);
}
.domain.ok .verdict {
  color: var(--ok-strong);
  background: var(--ok-soft);
}
.domain.off {
  color: var(--text-2);
}
.host {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}
.verdict {
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-2);
}
/* 技术详情：折起来，但它必须**拿得到** —— 排障时全靠它区分
   「确实没开课」和「教务改了字段名」 */
.tech {
  flex: 1 1 100%;
  font-size: var(--fs-micro);
  color: var(--text-2);
}
.tech summary {
  cursor: pointer;
  color: var(--text-2);
}
.tech p {
  margin: var(--sp-4) 0 0;
  line-height: var(--lh-body);
  overflow-wrap: anywhere;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
  margin-top: var(--sp-12);
}
.field {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  flex: 1;
  min-height: 44px;
  padding: var(--sp-6) var(--sp-10);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-2);
}
/* 原先这里 `outline: none` 之后没有任何替代的焦点环 ——
   键盘用户在这一行上看不出自己停在哪 */
.field:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.field input {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  border: none;
  background: transparent;
  color: var(--text-1);
  font-size: var(--fs-caption);
  outline: none;
}
.count { font-size: var(--fs-caption); color: var(--text-2); white-space: nowrap; }
.src { font-size: var(--fs-caption); color: var(--text-2); margin: var(--sp-8) 0 0; }
.list { list-style: none; margin: var(--sp-10) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-8); }
.row {
  padding: var(--sp-10) var(--sp-10);
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.l1 { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-8); }
.name { font-weight: var(--fw-semibold); color: var(--text-1); }
.lesson { font-size: var(--fs-caption); color: var(--text-2); }
.num { font-variant-numeric: tabular-nums; font-size: var(--fs-caption); color: var(--text-2); }
.l2 { display: flex; flex-wrap: wrap; gap: var(--sp-10); font-size: var(--fs-caption); margin-top: 4px; }
.dim { color: var(--text-2); }
.spin { animation: rein-spin 1s linear infinite; }

@media (prefers-reduced-motion: reduce) {
  .spin { animation-duration: 3s; }
}
</style>
