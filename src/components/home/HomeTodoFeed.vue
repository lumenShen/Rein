<script setup lang="ts">
/**
 * 主页「全部待办」信息流（移动端）· 到边逐批渲染
 *
 * 与「今日画布」（HomeCanvas）的分工：画布管**今天怎么排**（拖动 / 编辑 / 打卡），
 * 这块管**全部待办的状态流**——未完成在前（未安排 → 逾期 → 今天 → 未来日期升序），
 * 已完成整体沉底、组内沿用同一日期桶序。排序是后端的全序（query_todo_feed 的
 * ORDER BY，六键直到 id 唯一），前端只按行自身字段推导分组、不参与排序。
 *
 * 取数与渲染是两条独立管道（「滑到底再增加渲染」的全部机关）：
 *   · 取数：一页 FEED_PAGE=30 条，offset 翻页；同一时刻最多一笔在途（单飞）；
 *   · 渲染：已取回还没挂 DOM 的行先躺在 buffered 里（非响应式），每批只往列表追加
 *     FEED_BATCH=10 行 —— 「未来清单」不会被一次性糊出来。
 *   · 触发：列表尾的哨兵 + IntersectionObserver（下缘 FEED_PREFETCH_PX=600 预取带）——
 *     滚动把哨兵推进带内 → pump() 泵循环先花缓冲、缓冲空了才取下一页，直到哨兵离开带内。
 * 第一页就是全部（后端返回条数 < FEED_PAGE）时**一次挂完**：短清单没有「未来清单」要防，
 * 且主页底边的回弹要留住（信息流还有没取完的页时，一到边就会长高、原生滚动重新有量，
 * rubberScroll 的 canConsume 就把位移交还原生、band 不启动）。
 *
 * 竞态防护（IPC 异步，滚动与点击随时插队）：
 *   · 单飞 inflight + pendingReset：任何路径都不会有两笔并发取数（refresh 遇在途只登记，落地后补跑一次）；
 *   · 世代号 gen：refresh / 卸载都 ++，在途响应落地时对不上号就整笔丢弃（invoke 没有取消通道）；
 *   · seen 去重集：同一 id 永不渲染两次（分页期间有写入时，被挪动的行可能跨页重复）；
 *   · 到底判定双判据：serverExhausted（本页不满）**或** rows >= total；
 *   · 勾选：就地更新（不重排，手上没有未取到的数据），写期间 + 300ms 尾巴屏蔽 store 失效信号。
 *
 * 不自建滚动容器：整块是页面流里的一张普通卡片（与 HomeCanvas 同款 .card 壳 + 14px 网格）；
 * 位移仍由外层 .rubber-layer[data-rubber-content] 承担（system/rubberScroll 的 A 类层），
 * sticky 页头不受影响。
 */
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Check } from 'lucide-vue-next'

import { CATEGORY_META, priorityMeta } from '@/config/domain'
import { todoService } from '@/services/todoService'
import { useTodoStore } from '@/stores/todo'
import { diffDays, fmtDateCn, minToHHmm } from '@/utils/date'
import type { Todo } from '@/types'

const props = defineProps<{ today: string }>()

const router = useRouter()
const todoStore = useTodoStore()

/* ---------- 常量 ---------- */
/** 每页取回条数（与后端默认值同值，显式传：mock 侧 Number(null)=0 会被 clamp 成 1） */
const FEED_PAGE = 30
/** 每批挂 DOM 的行数：一行 ≈ 52px，10 行 ≈ 半屏多一点——追加时肉眼看得见「一批批长出来」 */
const FEED_BATCH = 10
/** 预取带：哨兵进入视口下缘 600px 内就开泵（≈11 行 > 一批 10 行，手指还没到底下一批已在长） */
const FEED_PREFETCH_PX = 600
/** 新行入场错峰：同批内每行 24ms，最多错 6 档（末行最多等 144ms，别拖着） */
const FEED_STAGGER_MS = 24
const FEED_STAGGER_MAX = 6
/** 勾选落地后的尾巴：再屏蔽 store 失效信号这么久，吸收 watcher 的迟到投递 */
const SELF_WRITE_TAIL_MS = 300
/** 挂载宽限：HomeFooter 在 onMounted 里 void todo.loadAll()，与我们的第一页是同一批状态，别重复取 */
const INITIAL_GRACE_MS = 1500
/** store 失效信号的去抖窗：把连发（AI 写入、别的页勾选后返回）合并成一次请求 */
const STORE_REFRESH_DEBOUNCE_MS = 200

interface FeedRow {
  todo: Todo
  /** 分组键：inbox / overdue / today / <日期>；已完成组统一加 done: 前缀 */
  group: string
  /** 是否在这行前插组头（与上一行 group 不同才插） */
  header: boolean
  /** 入场错峰延迟（ms），写进行上的 --d */
  delay: number
}

/* ---------- 状态 ---------- */
/** shallowRef：整批替换只触发一次 patch（先例：components/voice/VoiceSessionView.vue:2） */
const rows = shallowRef<FeedRow[]>([])
const total = ref(0)
const feedState = ref<'loading' | 'idle' | 'end' | 'error' | 'empty'>('loading')
const sentinel = ref<HTMLElement | null>(null)

/** 已取回、还没挂 DOM 的行（刻意非响应式：逐行触发的渲染正是要避免的） */
let buffered: Todo[] = []
/** 已渲染过的 id：跨页去重，同 id 只渲染一次 */
const seen = new Set<number>()
let fetchedCount = 0
let fetchedOnce = false
let serverExhausted = false
let gen = 0
let inflight: Promise<void> | null = null
let pendingReset = false
let pumping = false
let unmounted = false
let selfWrites = 0
let selfWriteUntil = 0
let mountedAt = 0
let refreshTimer = 0
let firstActivate = true
let observer: IntersectionObserver | null = null

/* ---------- 分组（由行自身字段推导，后端不加字段） ---------- */
function groupOf(t: Todo): string {
  const done = t.status === 'done'
  if (t.date === null) return done ? 'done:inbox' : 'inbox'
  if (t.date < props.today) return done ? 'done:overdue' : 'overdue'
  if (t.date === props.today) return done ? 'done:today' : 'today'
  return done ? `done:${t.date}` : t.date
}

/** 组头文案：inbox「未安排」/ overdue「已逾期」/ today「今天」/ 未来日期（明天特殊化）；已完成组统一前缀 */
function groupLabel(group: string): string {
  const done = group.startsWith('done:')
  const key = done ? group.slice(5) : group
  const base =
    key === 'inbox'
      ? '未安排'
      : key === 'overdue'
        ? '已逾期'
        : key === 'today'
          ? '今天'
          : diffDays(props.today, key) === 1
            ? '明天'
            : fmtDateCn(key)
  return done ? `已完成 · ${base}` : base
}

/* ---------- 批追加（唯一的挂 DOM 路径） ---------- */
function appendRows(max: number): void {
  const next: FeedRow[] = []
  let prevGroup = rows.value.length ? rows.value[rows.value.length - 1]!.group : ''
  let taken = 0
  while (buffered.length && taken < max) {
    const todo = buffered.shift()!
    if (seen.has(todo.id)) continue /* 跨页重复：丢弃（不重） */
    seen.add(todo.id)
    const group = groupOf(todo)
    next.push({ todo, group, header: group !== prevGroup, delay: Math.min(taken, FEED_STAGGER_MAX) * FEED_STAGGER_MS })
    prevGroup = group
    taken++
  }
  if (next.length) rows.value = [...rows.value, ...next] /* 一次替换 = 一次 patch */
}

/** 首屏：第一页就是全部（serverExhausted）⇒ 一次挂完；否则只挂一批，其余交给滚动。
 *  短清单不必分批，且主页底边的回弹要留住（见头注释）。 */
function appendInitial(): void {
  appendRows(serverExhausted ? buffered.length : FEED_BATCH)
}

/* ---------- 取一页（单飞） ---------- */
async function fetchPage(): Promise<void> {
  if (inflight) return /* 单飞：同一时刻只允许一笔在途 */
  const my = gen
  const offset = fetchedCount
  feedState.value = 'loading'
  const p = (async () => {
    try {
      const page = await todoService.queryTodoFeed({ today: props.today, limit: FEED_PAGE, offset })
      if (my !== gen || unmounted) return /* 期间被 refresh / 卸载作废：整笔丢弃，不写任何状态 */
      fetchedOnce = true
      buffered.push(...page.items)
      total.value = page.total
      fetchedCount += page.items.length
      if (page.items.length < FEED_PAGE) serverExhausted = true
    } catch (e) {
      if (my === gen && !unmounted) {
        feedState.value = 'error'
        console.warn('[home-todo-feed] 全部待办取数失败', e)
      }
    } finally {
      inflight = null
      /* 在途期间来的刷新请求：落地后补跑一次（不并发，所以 fetchedCount 不会被并发多推） */
      if (pendingReset && !unmounted) {
        pendingReset = false
        void refresh()
      }
    }
  })()
  inflight = p
  await p
}

/* ---------- 四态（到底小结） ---------- */
function recomputeState(): void {
  if (feedState.value === 'error') return /* 错误态只由重试或下一次 refresh 清掉 */
  if (!fetchedOnce) {
    feedState.value = 'loading' /* 还没成功取过：不能报 empty */
    return
  }
  if (total.value === 0) {
    feedState.value = 'empty'
    return
  }
  if (buffered.length === 0 && (serverExhausted || rows.value.length >= total.value)) {
    feedState.value = 'end'
    return
  }
  feedState.value = 'idle'
}

/* ---------- 泵循环（唯一的追加 / 取数入口） ---------- */
/** 哨兵是否已进入预取带（桌面 .desk-main 是壳自己的滚动盒且始终落在视口内，读它的底边） */
function belowBand(): boolean {
  const el = sentinel.value
  if (!el) return false
  const pane = document.querySelector('.desk-main')
  const bottom = pane ? pane.getBoundingClientRect().bottom : window.innerHeight
  return el.getBoundingClientRect().top - bottom <= FEED_PREFETCH_PX
}

async function pump(): Promise<void> {
  if (unmounted || pumping) return /* 重入直接返回：IO 回调 / refresh 后的泵 / 重试点击都只经这里 */
  pumping = true
  try {
    while (!unmounted && belowBand()) {
      if (buffered.length) {
        appendRows(FEED_BATCH)
        await nextTick()
        continue /* 先花缓冲，DOM 一批批长 */
      }
      if (serverExhausted) break
      /* total>0 的守卫必须有：第一页还没取到前 total 是 0，否则 0>=0 会被当成「已经到底」 */
      if (total.value > 0 && rows.value.length >= total.value) break
      await fetchPage()
      if (feedState.value === 'error') break
      if (!buffered.length) break /* 单飞被占 / 取回空页：退出，别自旋 */
    }
    recomputeState()
  } finally {
    pumping = false
  }
}

/* ---------- 重取第一页 ---------- */
async function refresh(): Promise<void> {
  if (unmounted) return /* 卸载后不再发起任何取数 */
  if (inflight) {
    pendingReset = true /* 有在途：不并发，落地后由 fetchPage 的 finally 补跑一次 */
    return
  }
  gen++
  rows.value = []
  buffered = []
  seen.clear()
  fetchedCount = 0
  fetchedOnce = false
  serverExhausted = false
  feedState.value = 'loading'
  await fetchPage()
  appendInitial() /* 整页装得下就一次挂完，否则只挂一批 */
  await nextTick()
  void pump() /* 视口本来就够高时继续补 */
}

/** 错误态重试：只重取失败的那一页（失败时 fetchedCount 没推进，offset 还是它），
 *  已渲染的行不清空、不重置 seen——重试不是刷新；挂载量与首屏同一条规则（appendInitial），
 *  所以「≤一页」的清单重试后也直接进 end，不会留半截缓冲。 */
async function retryTap(): Promise<void> {
  if (pumping || inflight) return
  feedState.value = 'idle'
  await fetchPage()
  appendInitial()
  await nextTick()
  void pump()
}

/* ---------- 行内动作 ---------- */
function goTodos(): void {
  void router.push({ name: 'todos' })
}

/** 就地更新这一行（shallowRef 必须整数组替换） */
function patchRow(t: Todo): void {
  rows.value = rows.value.map((r) => (r.todo.id === t.id ? { ...r, todo: t } : r))
}

/** 勾选走 store（唯一写路径，ARCHITECTURE §3「跨组件联动必须走 store action」）；
 *  先在本地落完成态（乐观），写期间 + 尾巴屏蔽 store 失效信号。
 *  **不重排**：勾完的行留在原位，「已完成沉底」等下一次 refresh（重进主页）才发生。 */
async function toggle(todo: Todo): Promise<void> {
  const next: Todo = {
    ...todo,
    status: todo.status === 'done' ? 'todo' : 'done',
    completedAt: todo.status === 'done' ? null : new Date().toISOString(),
  }
  selfWrites++ /* 写期间一直屏蔽 store 变化（不依赖「猜耗时」） */
  patchRow(next)
  try {
    await todoStore.toggle(todo)
  } catch (e) {
    patchRow(todo)
    console.warn('[home-todo-feed] 勾选失败', e)
  } finally {
    selfWrites--
    selfWriteUntil = Date.now() + SELF_WRITE_TAIL_MS
  }
}

/* ---------- 生命周期 ---------- */
onMounted(() => {
  mountedAt = Date.now()
  void refresh()
  /* IO 首帧 observe 必投递一次当前相交态，所以「挂载时哨兵已在带内」不会漏。
     不加 scroll 兜底：两套触发会互相掩护，pump 已是唯一入口。
     移动端是文档级滚动（root:null = 视口即滚动盒）；桌面 .desk-main 始终落在视口内，
     「到没到底部」在视口相交与壳内相交同解。 */
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void pump()
    },
    { root: null, rootMargin: `0px 0px ${FEED_PREFETCH_PX}px 0px`, threshold: 0 },
  )
  if (sentinel.value) observer.observe(sentinel.value)
})

/** 只作休眠保险：将来壳改成 keep-alive 时回到主页仍会重取。
 *  首个 onActivated 与 onMounted 同批触发，跳过以免首屏取两次。 */
onActivated(() => {
  if (firstActivate) {
    firstActivate = false
    return
  }
  void refresh()
})

/** store 失效信号：loadAll 每次都是整体替换引用，所以引用变化 = 数据变了 */
watch(
  () => todoStore.allTodos,
  () => {
    if (unmounted) return
    if (Date.now() - mountedAt < INITIAL_GRACE_MS) return /* 与 HomeFooter 的 loadAll 同一批状态，别重复取 */
    if (selfWrites > 0 || Date.now() < selfWriteUntil) return /* 本组件自己发起的写 */
    if (rows.value.length > FEED_BATCH) return /* 已滚深：重取会把列表缩回一批、滚动进度归零 */
    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      /* 去抖窗内可能又自己写了一次 / 已经卸载：落地前再核一遍 */
      if (unmounted || selfWrites > 0 || Date.now() < selfWriteUntil) return
      void refresh()
    }, STORE_REFRESH_DEBOUNCE_MS)
  },
)

onBeforeUnmount(() => {
  unmounted = true
  gen++ /* 在途响应作废（invoke 无法中断，「落地即丢」） */
  observer?.disconnect()
  observer = null
  window.clearTimeout(refreshTimer)
})
</script>

<template>
  <section class="card tfeed" data-testid="home-todo-feed" :data-rendered="rows.length" :data-total="total">
    <header class="tfeed-head">
      <h2>全部待办</h2>
      <!-- 卡头不再放「已显示 / 共」裸计数：同一组数字在到底小结里带标签再说一遍，
           卡头的「12 / 37」还会被误读成完成进度 -->
    </header>

    <ul v-if="rows.length" class="tfeed-list" aria-label="全部待办">
      <template v-for="r in rows" :key="r.todo.id">
        <!-- 组头：排序保证同桶连续，所以每组只会在首行前出现一次，跨批追加也不会重复出头 -->
        <li v-if="r.header" class="tfeed-gsep" data-testid="todo-feed-group" :data-group="r.group">
          {{ groupLabel(r.group) }}
        </li>
        <li
          class="tfeed-row"
          :class="{ done: r.todo.status === 'done' }"
          data-testid="todo-feed-row"
          :data-todo-id="r.todo.id"
          :data-group="r.group"
          :data-date="r.todo.date ?? ''"
          :data-done="r.todo.status === 'done' ? '1' : '0'"
          :style="{ '--d': `${r.delay}ms` }"
        >
          <button
            class="tfeed-check pressable"
            data-testid="todo-feed-check"
            :aria-label="r.todo.status === 'done' ? '标记未完成' : '标记完成'"
            @click="toggle(r.todo)"
          >
            <Check v-if="r.todo.status === 'done'" :size="12" :stroke-width="3.2" />
          </button>
          <button class="flex-1 tfeed-body pressable" :aria-label="`${r.todo.title} · 打开待办页`" @click="goTodos">
            <span class="tfeed-title">{{ r.todo.title }}</span>
            <span class="tfeed-meta">
              <span v-if="r.todo.startMin != null" class="num">{{ minToHHmm(r.todo.startMin) }}</span>
              <span class="tfeed-cat">
                <i :style="{ background: `var(${CATEGORY_META[r.todo.category].colorVar})` }" />{{
                  CATEGORY_META[r.todo.category].label
                }}
              </span>
              <span v-if="r.todo.priority > 0" :style="{ color: `var(${priorityMeta(r.todo.priority).colorVar})` }">
                {{ priorityMeta(r.todo.priority).label }}
              </span>
            </span>
          </button>
        </li>
      </template>
    </ul>

    <!-- 到底小结：单一元素 + data-state 表四态（空态下没有 <ul>，根节点照渲染，e2e 找得到） -->
    <div class="tfeed-end" data-testid="todo-feed-end" :data-state="feedState">
      <span v-if="feedState === 'loading'" role="status">正在加载…</span>
      <button v-else-if="feedState === 'error'" class="pressable" @click="retryTap">加载失败 · 点此重试</button>
      <button v-else-if="feedState === 'empty'" class="pressable" @click="goTodos">还没有待办 · 去待办页新建</button>
      <span v-else-if="feedState === 'end'">已全部载入 · 共 {{ total }} 条</span>
      <span v-else class="num">已显示 {{ rows.length }} / 共 {{ total }} 条</span>
    </div>

    <!-- 预取哨兵：进入视口下缘 600px 内就泵下一批（纯机关，无内容） -->
    <div ref="sentinel" class="tfeed-sentinel" data-testid="todo-feed-sentinel" aria-hidden="true" />
  </section>
</template>

<style scoped>
/* 卡片壳跟 HomeCanvas 同款（.card 自带 surface / radius-xl / shadow-card / 20px 内边距）。
   与上一块（HomeFooter 的 .hf）的 14px 间距：全站卡间距靠 `.card + .card` 相邻选择器，
   这里隔着 .hf 那层包装够不到，得自己给——与 .hf 的做法一致。 */
.tfeed {
  /* 与上一块（HomeFooter）同档卡间距 12：全站卡间距靠 .card + .card，隔了包装够不到 */
  margin-top: var(--gap-md);
}

.tfeed-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  /* 卡头标题与右侧动作是一组无边界控件：8 */
  gap: var(--gap-sm);
}

.tfeed-head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.tfeed-list {
  /* 卡内标题与内容之间 8（再大一档会让这组行读成独立区块） */
  margin: var(--gap-sm) 0 0;
  padding: 0;
  list-style: none;
}

/* 组头：小一号的灰标签，自己当分隔线（所以组内第一行不再画上边框） */
.tfeed-gsep {
  padding: var(--gap-md) 0 var(--gap-text);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-3);
}

.tfeed-row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  /* 双行行（标题 + meta）：12 上下 + 两行文本 ≈ 64 档 */
  padding: var(--sp-12) 0;
}

.tfeed-row + .tfeed-row {
  border-top: 0.5px solid var(--line);
}

.tfeed-check {
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

/* 24px 的勾选框是列表行的排版规格，命中区撑到 44×44（TodoItem.vue 的 .check::after 同款惯用法） */
.tfeed-check::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}

.tfeed-row.done .tfeed-check {
  background: var(--ok);
  border-color: var(--ok);
}

/* 正文即「打开待办页」的整块按钮（去掉行尾编辑/删除那两枚，编辑属于待办页的事）。
   按钮默认把文本居中，得掰回左对齐（HomePage .strip 同款提醒） */
.tfeed-body {
  display: block;
  text-align: left;
  cursor: pointer;
}

.tfeed-title {
  display: block;
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
  /* 长标题截断；行不做换行，列表高度才稳定（一行 ≈ 52px，批大小按它算） */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 删除线常驻、颜色透明过渡：勾完成时划线像手写划过而非硬蹦（照 TodoItem.vue 的 .title） */
  text-decoration: line-through;
  text-decoration-color: transparent;
  transition:
    color var(--dur-base) var(--ease-standard),
    text-decoration-color var(--dur-base) var(--ease-standard);
}

.tfeed-row.done .tfeed-title {
  color: var(--text-3);
  text-decoration-color: currentColor;
}

/* meta 照 TodoItem.vue 的 .meta：flex + gap 5px，**不设 overflow** ——
   它一旦有 overflow 就会落进布局守卫的裁切清单（内容超 3px 即报） */
.tfeed-meta {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.tfeed-cat {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
}

.tfeed-cat i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.tfeed-end {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.tfeed-end button {
  color: var(--accent);
  font-weight: var(--fw-semibold);
}

.tfeed-sentinel {
  height: 1px;
}

/* 新行入场：批追加时逐行错峰（--d 由 appendRows 写在行上）。
   scoped 块里的 @keyframes 会被编译器改名并同步改写 animation 声明（compiler-sfc 的
   scopedPlugin），名字撞不了，叫 tfeed-in 只是因为可读。 */
.tfeed-row,
.tfeed-gsep {
  animation: tfeed-in var(--dur-fast) var(--ease-out) both;
  animation-delay: var(--d, 0ms);
}

@keyframes tfeed-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 减弱动效 / 关闭动效：base.css 的全局规则只把 animation-duration 压到 0.01ms，
   **压不住 animation-delay** —— 不显式关掉动画的话，每行仍会先隐形最多 144ms 再瞬现。
   前缀直接写 html[...]（scoped 编译器只给末段挂 data-v；不要写 :global(html[…])，
   见 HomeFooter.vue 里那段教训注释）。 */
@media (prefers-reduced-motion: reduce) {
  .tfeed-row,
  .tfeed-gsep {
    animation: none;
  }
}

html[data-motion='off'] .tfeed-row,
html[data-motion='off'] .tfeed-gsep {
  animation: none;
}
</style>
