<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AlertTriangle, Clock, Info, ListPlus, RefreshCw, Search, Sparkles, Trash2, Wand2 } from 'lucide-vue-next'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { useToast } from '@/composables/useToast'
import { grabStatusMeta, idOf, useCourseSelectStore } from '@/stores/courseSelect'
import type { GrabIntent, GrabMatch, GrabPreview } from '@/types'

/**
 * 抢课计划 —— 「提前输入，到点自动抢」的入口。
 *
 * 它回答的问题是**「我会抢到哪些课」**，而不是「怎么抢」：
 *
 * 1. 用户写的是一句**人的说法**（「高数 张」「体育」「000031」），
 *    不是教学班编号 —— 后者在窗口开放前根本拿不到，而且随时会变。
 * 2. 引擎在能看见名单时把它解析成具体的教学班（`grab.rs::resolve_intent`），
 *    命中的班按「有空位的优先」排成志愿序，**只中一个**（同一门课的多个班是备选）。
 * 3. 解析结果就摆在这里给人确认：哪几个班、谁是第一志愿、谁满员。
 *    窗户开放前看到的就是它 —— 用户不需要守屏幕，关掉 App 也照样抢。
 *
 * 「预览」按钮不是装饰：它拿的是教务**此刻**的名单（与解析共用同一份缓存与同一个匹配器），
 * 所以预览里看到的顺序就是解析后排出来的顺序。
 */
const store = useCourseSelectStore()
const toast = useToast()

const query = ref('')
/** true = 每门课各抢一个班；false = 所有命中合成一组，只中一个 */
const spread = ref(false)

const preview = ref<GrabPreview | null>(null)
const previewing = ref(false)
const previewError = ref('')

/* ---------------- 输入预览 ---------------- */

async function onPreview(): Promise<void> {
  const q = query.value.trim()
  if (!q) return
  previewing.value = true
  previewError.value = ''
  try {
    preview.value = await store.previewMatches(q, store.activeTurn ? idOf(store.activeTurn.id) : null)
  } catch (e) {
    preview.value = null
    previewError.value = e instanceof Error ? e.message : '预览失败'
  } finally {
    previewing.value = false
  }
}

/** 输入变了就把上一次的预览作废：留着它只会让人以为「这就是这次的结果」 */
function onInput(): void {
  preview.value = null
  previewError.value = ''
}

async function onAdd(): Promise<void> {
  const q = query.value.trim()
  if (!q) return
  // **先清空再提交**：提交要等一个来回，回来再清的话，「按了却没反应」会持续几百毫秒 ——
  // 而这段时间里用户很可能已经开始敲下一门课了，那半句会被清空悄悄吃掉。
  // 失败时把原文放回去，不让他白打一遍。
  query.value = ''
  preview.value = null
  try {
    await store.addIntent({
      query: q,
      turnId: store.activeTurn ? idOf(store.activeTurn.id) : null,
      turnName: store.activeTurn?.name ?? null,
      spread: spread.value,
    })
    toast.toast('已加入计划，引擎会自动解析成志愿任务')
  } catch (e) {
    query.value = q
    toast.toast(e instanceof Error ? e.message : '加入计划失败')
  }
}

/* ---------------- 计划列表 ---------------- */

const intents = computed(() => store.intents)

/** 计划派出去的任务现在到哪一步了 —— 这是「抢到没有」的答案 */
function liveLabel(i: GrabIntent): string {
  const tasks = store.intentTasks(i)
  if (!tasks.length) return ''
  if (tasks.some((t) => t.status === 'success')) return '已抢到'
  const alive = tasks.filter((t) => t.status === 'waiting' || t.status === 'running')
  if (alive.length) {
    const lead = alive.find((t) => !t.heldBy) ?? alive[0]
    return lead ? grabStatusMeta(lead).label : '抢课中'
  }
  if (tasks.every((t) => t.status === 'cancelled')) return '已取消'
  return '已结束'
}

/**
 * 状态徽标：**解析状态优先，解析完才看任务进展**。
 *
 * 顺序不能反：重新解析时状态会回到「等解析」，而它上一次派出去的任务还挂在那儿
 * （可能是「已抢到」）—— 先看任务的话，界面上会显示着「已抢到」而引擎正在重新排志愿，
 * 那是在骗人。
 */
function chipOf(i: GrabIntent): { label: string; tone: string } {
  if (i.status === 'ambiguous') return { label: '要补课程代码', tone: 'bad' }
  if (i.status === 'pending') return { label: '等解析', tone: 'run' }
  if (i.status === 'empty') return { label: '没匹配到', tone: 'bad' }
  const live = liveLabel(i)
  if (live) return { label: live, tone: live === '已抢到' ? 'ok' : live === '已结束' ? 'idle' : 'run' }
  const n = (i.groupKeys ?? []).length
  // 排过志愿意味着它派出过任务；任务被清掉之后不能还挂着蓝色的「已排好志愿」——
  // 那会让一条已经出局的计划看起来还在排队（这条链路上最容易骗到自己的地方）
  if (n && !store.intentTasks(i).length) return { label: '任务已清理', tone: 'idle' }
  return { label: n > 1 ? `已排 ${n} 组` : '已排好志愿', tone: 'run' }
}

function targetOf(i: GrabIntent): string {
  return i.turnName?.trim() || '教务当前批次'
}

/**
 * 「这句查询跨了哪几门课」的文案。
 *
 * 判定本身在 Rust（`matcher::ambiguous_courses`）—— 这里只把结果拼成人话：
 * 计划行按 status（引擎说了算），预览按后端回的 `ambiguous`。**两边都不是本地判断**，
 * 免得出现「界面说没问题、引擎却不动手」。
 */
function courseListText(rows: { code: string; name: string }[]): string {
  return rows.map((r) => (r.name ? `${r.code} ${r.name}` : r.code)).join(' / ')
}

/**
 * 计划自己的「下一次唤醒时刻」。
 *
 * 引擎早就把 `nextAt` 算好了，但界面从来不渲染它 —— 于是「它到底会不会自己动」
 * 这件事只存在于「后台有个线程」这句话里。抢课是**人不在场**的动作，屏幕上必须
 * 有一处能当凭据：几点几分它还会再试一次。
 */
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
})

function nextText(i: GrabIntent): string {
  if (!i.nextAt) return ''
  const ms = i.nextAt - now.value
  if (ms <= 0) return i.status === 'pending' ? '正在解析…' : '正在重试…'
  const d = new Date(i.nextAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  // 一小时内给相对量（「还有多久」比「几点」更好算），更远就给绝对时刻
  if (ms < 3600_000) return `${Math.ceil(ms / 60000)} 分钟后（${clock}）`
  return `${clock} 再试`
}

function seat(m: GrabMatch): string {
  const a = m.stdCount
  const b = m.limitCount
  if (a == null && b == null) return ''
  if (a == null || b == null) return `${a ?? '?'} / ${b ?? '?'}`
  const left = b - a
  // 满员不写「余 0」：那一行已经有「已满」徽标了，同一件事说两遍只是噪音
  return left > 0 ? `${a} / ${b} · 余 ${left}` : `${a} / ${b}`
}

function full(m: GrabMatch): boolean {
  return m.limitCount != null && m.stdCount != null && m.stdCount >= m.limitCount
}

/** 命中字段 → 中文名。用户有权知道「为什么这条匹配上了」。 */
const FIELD_LABEL: Record<string, string> = {
  course: '课程名',
  /** 项目名（体育课的「羽毛球」）—— 与课程名分开说：
   *  所有项目的课程名都叫「大学体育1」，不点明的话用户以为自己是按课名命中的 */
  minor: '项目名',
  code: '代码',
  teacher: '教师',
  teacherExact: '教师精确',
  teacherNear: '教师近似',
  /** 教学班名 —— 「3院」「花江校区」这类限定词落在这里 */
  lesson: '教学班名',
  place: '时间地点',
}

function fieldLabel(f: string): string {
  return FIELD_LABEL[f] ?? f
}

/** 这批候选里有没有「打全了老师名字」的 —— 有就说明计划只抢那几位老师的班 */
function hasExactTeacher(list: GrabMatch[]): boolean {
  return list.some((m) => (m.fields ?? []).includes('teacherExact'))
}

/** 有没有靠「可能打错了」才命中的 —— 这种必须提醒用户核对，因为那是猜的 */
function hasNearTeacher(list: GrabMatch[]): boolean {
  return list.some((m) => (m.fields ?? []).includes('teacherNear'))
}

/**
 * 候选行的标题。
 *
 * **项目名优先**：体育课 8 个项目的课程名全都是「大学体育1」，
 * 拿课程名当标题，用户看到的是一列一模一样的名字，根本认不出哪个是羽毛球。
 * 项目名才是他嘴里的那门课；没有项目名时（绝大多数课）就是课程名。
 */
function matchTitle(m: GrabMatch): string {
  const minor = m.minorName?.trim()
  if (minor) return minor
  return m.courseName?.trim() || `教学班 ${idOf(m.lessonId)}`
}

/** 候选行的副标题：把「哪门课 / 哪个班」补全，同门课的几个班才分得开 */
function matchSubtitle(m: GrabMatch): string {
  const bits: string[] = []
  const minor = m.minorName?.trim()
  if (minor && m.courseName?.trim()) bits.push(m.courseName.trim())
  const name = m.lessonName?.trim()
  if (name && name !== m.courseName?.trim()) bits.push(name)
  return bits.join(' · ')
}

async function onRemove(i: GrabIntent): Promise<void> {
  try {
    await store.intentAction(i.id, 'remove')
    toast.toast('已移除计划（它派出去的任务也一并取消）')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '移除失败')
  }
}

async function onReparse(i: GrabIntent): Promise<void> {
  try {
    await store.intentAction(i.id, 'now')
    toast.toast('正在重新解析…')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '重新解析失败')
  }
}
</script>

<template>
  <section class="card plan">
    <header class="head">
      <span class="row title">
        <Sparkles :size="15" class="spark" />
        <b>抢课计划</b>
      </span>
      <span class="sub">写好就不用管了，窗口一开自动抢</span>
    </header>

    <!-- 与「教学班搜索」刻意不同名：同一屏上有两个输入框，
         选择器和人眼都该一眼分得清谁是「写计划」、谁是「筛当前列表」 -->
    <div class="entry">
      <Search :size="15" />
      <input
        v-model="query"
        type="search"
        placeholder="课名 / 课程代码 / 教师，如：高数 张"
        @input="onInput"
        @keyup.enter="onPreview"
      />
      <button class="entry-go" :disabled="previewing || !query.trim()" @click="onPreview">
        {{ previewing ? '…' : '预览' }}
      </button>
    </div>

    <p class="hint">
      <Info :size="13" />
      <span>
        <b>模糊匹配</b>：空格分词、每个词都要命中，词可以落在课名 / 代码 / 教师上。
        「高数」也能命中「高等数学」—— 窗口前只来得及打两个字。
      </span>
    </p>

    <!-- 预览：先看清会抢哪些班，再决定写不写进计划 -->
    <div v-if="preview" class="preview">
      <p class="p-head">
        <template v-if="preview.total === 0">
          教务还没公布这个批次的教学班 —— 计划可以先写好，引擎会等它出现。
        </template>
        <template v-else-if="!preview.matches.length">
          教务有 {{ preview.total }} 个教学班，但没匹配到「{{ query.trim() }}」。换个词试试。
        </template>
        <template v-else>
          匹配到 <b>{{ preview.matches.length }}</b> / {{ preview.total }} 个教学班，按这个顺序抢：
          <template v-if="preview.matched > preview.matches.length">
            （另有 {{ preview.matched - preview.matches.length }} 个匹配被「指定教师」滤掉）
          </template>
        </template>
      </p>

      <ul v-if="preview.matches.length" class="matches">
        <li v-for="(m, i) in preview.matches" :key="idOf(m.lessonId)">
          <span class="ord num">{{ i + 1 }}</span>
          <span class="col flex-1">
            <b>{{ matchTitle(m) }}</b>
            <em v-if="matchSubtitle(m)" class="sub-line">{{ matchSubtitle(m) }}</em>
            <em>
              <span v-if="m.courseCode" class="num">{{ m.courseCode }}</span>
              <span v-if="m.teacher">{{ m.teacher }}</span>
              <span v-if="seat(m)" class="num">{{ seat(m) }}</span>
            </em>
          </span>
          <!-- 「为什么匹配到它」与「能不能抢」是两件事，都摆出来：
               满员的班照样值得排（等别人退），但也得让人看见它是怎么被选中的 -->
          <span v-if="m.picked" class="chip ok">已选</span>
          <span v-else-if="full(m)" class="chip bad">已满</span>
          <span v-for="f in m.fields ?? []" :key="f" class="chip hit">{{ fieldLabel(f) }}</span>
        </li>
      </ul>

      <!-- 跨了多门课：**这是最容易抢错的一步**（年级双开的体育课最典型）——
           引擎到点不会排队，所以现在就把它说清楚，别让人以为计划已经武装好了 -->
      <p v-if="preview.ambiguous?.length" class="note warn">
        <AlertTriangle :size="12" />
        <span>
          这句同时命中 <b>{{ preview.ambiguous.length }}</b> 门课：{{ courseListText(preview.ambiguous) }}。
          「中一个就够」时引擎<b>不会排这个计划</b> —— 补上课程代码就只抢那一门。
        </span>
      </p>

      <!-- 教师名的两种强信号要说清楚：一个是「按你说的办」，另一个是「我猜的」 -->
      <p v-if="hasExactTeacher(preview.matches)" class="note">
        老师名字打全了，按<b>指定</b>处理：只抢这位老师的班，同一门课的其他老师不进候选。
      </p>
      <p v-else-if="hasNearTeacher(preview.matches)" class="note warn">
        教师名没完全对上 —— 这是按「姓相同、最多差一个字」<b>猜</b>的，核对一下上面列出的老师姓名。
      </p>

      <!-- 放宽：严格匹不到、靠丢词才凑出结果。**必须让人看见** ——
           写的是「羽毛球 星期四」，真抢的可能是星期一的班 -->
      <p v-if="preview.relaxNote" class="note warn">
        <AlertTriangle :size="12" />
        <span>
          {{ preview.relaxNote }}<template v-if="preview.droppedWords?.length">
            ：<b>{{ preview.droppedWords.join('、') }}</b></template
          >。上面是按放宽后的条件匹配的 —— 想按原条件抢，就把那个词改对（或去掉）。
        </span>
      </p>

      <!-- 名单是旧的：教务拉不到时引擎会用上一次落盘的那份 —— 名额一定已经变了 -->
      <p v-if="preview.lessonsNote" class="note warn">
        <AlertTriangle :size="12" />
        <span>{{ preview.lessonsNote }}</span>
      </p>
    </div>
    <p v-else-if="previewError" class="err">{{ previewError }}</p>

    <SegmentedControl
      :model-value="spread ? 'all' : 'one'"
      :options="[
        { value: 'one', label: '中一个就够' },
        { value: 'all', label: '每门课都要' },
      ]"
      @update:model-value="spread = $event === 'all'"
    />
    <p class="hint">
      <Info :size="13" />
      <span v-if="!spread">
        命中的教学班<b>互为备选</b>：按上面的顺序出手，只中一个。同一门课的多个班、
        或「谁来教都行」的课，都选这个。
      </span>
      <span v-else>
        按课程分组，<b>每门课各中一个班</b>（同一门课的多个班仍只中一个），课程之间互不影响。
      </span>
    </p>

    <button class="primary" :disabled="store.grabBusy || !query.trim()" @click="onAdd">
      <ListPlus :size="16" />
      加入计划
    </button>

    <p class="hint">
      <Info :size="13" />
      <span>
        写完就可以关掉<b>这个页面</b>：引擎每分钟自己去看一次教务的名单，能查到时把计划解析成
        <b>志愿任务</b>，到点开抢 —— 不需要你再操作。
      </span>
    </p>

    <!-- 已排的计划 -->
    <ul v-if="intents.length" class="plans">
      <li v-for="i in intents" :key="i.id" class="plan-row">
        <div class="row line1">
          <b class="q">{{ i.query }}</b>
          <span class="chip" :class="chipOf(i).tone">{{ chipOf(i).label }}</span>
          <button class="op" title="重新解析" aria-label="重新解析" @click="onReparse(i)">
            <RefreshCw :size="14" />
          </button>
          <button class="op" title="移除计划" aria-label="移除计划" @click="onRemove(i)">
            <Trash2 :size="14" />
          </button>
        </div>
        <!-- 「下次唤醒」是这行上唯一能当凭据的信息：抢课是人不在场的动作，
             「几点还会再动一次」必须一眼看见，所以提成一枚强调胶囊；
             目标批次与抢法只是背景，降到 caption/text-3 并用竖线分隔 -->
        <p class="meta">
          <Wand2 :size="12" />
          <span>{{ targetOf(i) }}</span>
          <i class="sep" aria-hidden="true" />
          <span>{{ i.spread ? '每门课都要' : '只中一个' }}</span>
          <StatusChip v-if="nextText(i)" tone="accent" size="md" class="next">
            <Clock :size="12" />
            <span class="num">{{ nextText(i) }}</span>
          </StatusChip>
        </p>

        <!-- 引擎最近那句话另起一行：它和「凭据」不是一层东西，混在一行里互相稀释 -->
        <p v-if="i.lastMessage && i.status !== 'ambiguous'" class="said">{{ i.lastMessage }}</p>

        <!-- 跨课程：状态由引擎给（`ambiguous`），这里只把课程代码拼出来。
             最危险的一种是年级双开 —— 只写「羽毛球」会同时命中大一与大二那两门 -->
        <p v-if="i.status === 'ambiguous'" class="note warn">
          <AlertTriangle :size="12" />
          <span>
            {{ i.lastMessage ?? '这句同时命中多门课' }}
            <b>引擎不会排它</b> —— 补上课程代码再「重新解析」。
          </span>
        </p>

        <!-- 教师名是猜的就得说出来：计划会照着它去抢，用户得有机会纠正 -->
        <p v-if="hasNearTeacher(i.candidates ?? [])" class="note warn">
          教师名可能打错了：按「姓相同、最多差一个字」猜的，核对下面列出的老师姓名。
        </p>

        <!-- 会抢哪些班：这就是「提前确认」的答案 -->
        <ul v-if="i.candidates?.length" class="matches tight">
          <li v-for="(m, k) in i.candidates" :key="idOf(m.lessonId)">
            <span class="ord num">{{ k + 1 }}</span>
            <span class="col flex-1">
              <b>{{ matchTitle(m) }}</b>
              <em v-if="matchSubtitle(m)" class="sub-line">{{ matchSubtitle(m) }}</em>
              <em>
                <span v-if="m.teacher">{{ m.teacher }}</span>
                <span v-if="seat(m)" class="num">{{ seat(m) }}</span>
              </em>
            </span>
            <span v-if="m.picked" class="chip ok">已选</span>
            <span v-else-if="full(m)" class="chip bad">已满</span>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.card {
  background: var(--surface);
  /* 卡片档 16：这几张是页面级的内容容器，32 是半模态的层级；
     用 32 会让一屏卡片看起来比弹出的抽屉还高一层 */
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  padding: var(--pad-card);
  margin-bottom: var(--gap-md);
}

.head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-8);
  margin-bottom: var(--sp-10);
}

.title {
  gap: var(--sp-6);
  font-size: var(--fs-callout);
  color: var(--text-1);
}

.spark {
  color: var(--accent);
}

.sub {
  font-size: var(--fs-micro);
  min-width: 0;
  color: var(--text-2);
}

/* 输入行与「教学班搜索」同一套视觉语言，但类名不重（同屏两个输入框，选择器要分得清）。
   `min-height: 44px` + 按钮纵向拉伸：手机在这一行上点的是「预览」，
   一个 21px 高的文字按钮在拇指下是按不准的。 */
.entry {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  min-height: 44px;
  padding: var(--sp-2) var(--sp-8) var(--sp-2) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-3);
  margin-bottom: var(--sp-8);
}

.entry input {
  flex: 1;
  min-width: 0;
  /* 输入框自己撑满整行高度（整行看着可点，就不该只有那条 16px 的文字线真的可点） */
  align-self: stretch;
  font-size: var(--fs-caption);
  color: var(--text-1);
  background: none;
}

.entry-go {
  flex: none;
  align-self: stretch;
  padding: 0 var(--sp-10);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-strong);
}

.entry-go:disabled {
  opacity: var(--disabled-opacity);
}

/* 计划怎么用：它是「模糊匹配」这套规则唯一的说明，必须读得出来 ——
   原先 11px 的 --text-3 在亮色下约 2.5:1、暗色下更低，解释看不见等于没解释 */
.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
  margin: var(--sp-6) 0;
}

.hint svg {
  flex: none;
  margin-top: var(--sp-2);
}

.preview {
  margin: var(--sp-8) 0;
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--accent-soft);
}

.p-head {
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: var(--lh-body);
  margin-bottom: var(--sp-6);
}

.err {
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  line-height: var(--lh-body);
  margin: var(--sp-8) 0;
}

/* 教师命中的两种解释：指定（按你说的办）/ 近似（我猜的）。
   猜的那条要更显眼 —— 它会照着去抢，用户得有机会纠正。 */
.note {
  font-size: var(--fs-micro);
  color: var(--text-2);
  line-height: var(--lh-body);
  margin: var(--sp-6) 0 0;
}

.note.warn {
  color: var(--warn-strong);
}

.matches {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  list-style: none;
  margin: 0;
  padding: 0;
}

.matches li {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
}

.matches .col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.matches b {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.matches em {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--sp-10);
  font-style: normal;
  font-size: var(--fs-micro);
  /* 教师与余量：确认「这条命中的到底是不是我想抢的那个班」，得读得出来 */
  color: var(--text-2);
}

/* 「哪门课 · 哪个班」那一行：教学班名可能很长（带院系、校区、年级），限两行 */
.matches .sub-line {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.ord {
  flex: none;
  width: 18px;
  text-align: center;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  color: var(--accent-strong);
  background: var(--surface);
  border-radius: var(--radius-full);
  padding: var(--sp-2) 0;
}

.matches.tight {
  margin-top: var(--sp-6);
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  /* 中性档（任务已清理）也是状态词，不该是最淡的一档 */
  color: var(--text-2);
}

.chip.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.chip.bad {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.chip.run {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.chip.idle {
  color: var(--text-2);
  background: var(--surface-2);
}

.chip.hit {
  color: var(--text-2);
  background: var(--surface);
}

.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-6);
  width: 100%;
  margin-top: var(--sp-4);
  padding: var(--sp-12);
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

.plans {
  list-style: none;
  margin: var(--sp-12) 0 0;
  padding: var(--sp-12) 0 0;
  border-top: 0.5px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
}

.plan-row .line1 {
  /* 16px：两个 28px 圆钮的命中区各自外扩 8px 后正好相接（见 .op::after），
     再窄一点，「移除计划」就会压住「重新解析」的边缘 */
  gap: var(--sp-16);
}

.q {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.op {
  position: relative;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 命中区撑到 44×44（视觉尺寸不动）—— 手机上是拇指在点 */
.op::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.op:active {
  transform: scale(0.9);
}

/* 目标批次 + 抢法：只是背景信息，降到 caption/text-3。
   主值（下次唤醒）走 .next 胶囊，引擎最近的话走 .said —— 三者不再同权 */
.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-4);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  margin-top: var(--sp-4);
  color: var(--text-3);
}

.meta svg {
  flex: none;
}

/* 批次与抢法之间的竖线（原来是一枚「·」，与行内其它「·」撞车） */
.meta .sep {
  flex: none;
  width: 1px;
  height: 10px;
  background: var(--line-strong);
}

/* 「下次唤醒」这一格：把「它还会自己再动一次」提成计划行的主值
   （时间压力下它比状态标签重要，所以是胶囊而不是和背景同一档的字） */
.next {
  margin-left: var(--sp-6);
  font-variant-numeric: tabular-nums;
}

/* 引擎最近说的话：另起一行，比背景事实高一档，但不去抢主值的位子 */
.said {
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  margin-top: var(--sp-2);
  color: var(--text-2);
}
</style>
