<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Mic, Search, Square, Trash2 } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { useTodoStore } from '@/stores/todo'
import { cancelRecording, fmtDur, recorder, startRecording, stopRecording, type RecTake } from '@/system/recorderRuntime'
import { minToHHmm, todayStr } from '@/utils/date'
import { humanBytes } from '@/utils/format'
import type { Todo, TodoAttachment } from '@/types'

/**
 * 录音页（/record）：全局录音的发起端与「未归档 take」的集散地。
 * - 大按钮开始 / 停止 / 取消；录音中可切走，悬浮条接管控制；
 * - take 列表 = 本会话录完但未附加的录音（内存，应用关闭即失）：
 *   回放、删除，或「附加到待办」写入 todos.attachments 持久化。
 */
const store = useTodoStore()
const { toast } = useToast()

onMounted(() => {
  void store.loadAll()
})

const recording = computed(() => recorder.status === 'recording')

async function toggle(): Promise<void> {
  if (recording.value) {
    stopRecording()
    return
  }
  const ok = await startRecording()
  if (!ok) toast(recorder.lastError || '无法开始录音')
}

function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtSize(n: number): string {
  return humanBytes(n)
}

function removeTake(t: RecTake): void {
  const i = recorder.takes.findIndex((x) => x.id === t.id)
  if (i !== -1) recorder.takes.splice(i, 1)
}

/* ---------- 附加到待办 ---------- */

const pickOpen = ref(false)
const pickTarget = ref<RecTake | null>(null)
const query = ref('')
const attaching = ref(false)

function openPick(t: RecTake): void {
  pickTarget.value = t
  query.value = ''
  pickOpen.value = true
}

/** 候选：未完成待办（今天的在前），按标题过滤 */
const candidates = computed(() => {
  const today = todayStr()
  const q = query.value.trim().toLowerCase()
  return store.allTodos
    .filter((t) => t.status !== 'done')
    .filter((t) => !q || t.title.toLowerCase().includes(q))
    .sort((a, b) => (b.date === today ? 1 : 0) - (a.date === today ? 1 : 0) || (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.id - b.id)
    .slice(0, 50)
})

async function attachTo(todo: Todo): Promise<void> {
  const t = pickTarget.value
  if (!t || attaching.value) return
  attaching.value = true
  try {
    const cur = store.allTodos.find((x) => x.id === todo.id)
    if (!cur) {
      toast('待办已不存在')
      return
    }
    const att: TodoAttachment = {
      kind: 'audio',
      // 附件名保留「录音」前缀：待办附件列表里没有上下文，光有时长读不出是什么
      name: `录音 ${fmtDur(t.durationSec)}`,
      content: t.dataUrl,
      size: t.size,
      createdAt: t.createdAt,
    }
    await store.update({ ...cur, attachments: [...(cur.attachments ?? []), att] })
    removeTake(t)
    pickOpen.value = false
    toast(`已附加到「${cur.title}」`)
  } finally {
    attaching.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="录音" subtitle="录完可附加到任意待办" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 桌面栅格：壳层只会把 .page 的**直接子项**摊成两栏，而这一页要的是
         「录音台通栏 + take 区通栏（内部再摊两栏）」，所以自带一层 .d-grid 承接，
         手机端它只是个普通 div，块流与间距都不变 -->
    <div class="d-grid rec-grid">
    <!-- 录音台 -->
    <section class="card hero d-full" data-testid="record-hero">
      <button
        class="rec-btn"
        :class="{ on: recording }"
        :aria-label="recording ? '停止并保存' : '开始录音'"
        data-testid="rec-toggle"
        @click="toggle"
      >
        <Square v-if="recording" :size="30" :stroke-width="2.2" />
        <Mic v-else :size="32" :stroke-width="1.9" />
      </button>
      <p class="num timer" :class="{ live: recording }">{{ fmtDur(recorder.elapsedSec) }}</p>
      <!-- 卡面只留一行结论（保存语义同时写进圆钮的 aria-label）——
           「可切到别的页面，悬浮条会跟着你」这类背景说明收进未归档录音卡头的 InfoHint -->
      <p v-if="recording" class="hint t-2">正在录音 — 点按圆钮停止并保存</p>
      <div v-if="recording" class="row rec-acts">
        <button class="cancel" @click="cancelRecording">取消</button>
      </div>
      <p v-if="recorder.lastError && !recording" class="err">{{ recorder.lastError }}</p>
    </section>

    <!-- 未归档 take：通栏 —— 内部的 take 列表自己会摊成多栏 -->
    <section class="takes d-full" data-testid="takes">
      <header class="row between thead">
        <b>未归档录音</b>
        <span class="row thead-side">
          <span class="tcount num t-3">{{ recorder.takes.length }} 条</span>
          <InfoHint
            title="未归档录音"
            content="录音过程中可以切到别的页面，悬浮条会跟着你，随时能在任意页面停止。

录完的录音先留在这里，可以回放、删除，或附加到待办；附加到待办后才会随应用保存，不附加的关掉应用就没了。"
          />
        </span>
      </header>
      <p v-if="!recorder.takes.length" class="empty t-2">
        录完的会先留在这里，回放确认后再附加到待办保存。
      </p>
      <ul class="tlist">
        <li v-for="t in recorder.takes" :key="t.id" class="card take">
          <div class="row between trow">
            <div class="col tmeta">
              <b class="num">{{ fmtDur(t.durationSec) }}</b>
              <span class="num sub">
                <span class="t-2">{{ hhmm(t.createdAt) }}</span>
                <i class="vsep" aria-hidden="true" />
                <span class="ssize t-3">{{ fmtSize(t.size) }}</span>
              </span>
            </div>
            <div class="row tacts">
              <button class="mini primary" :disabled="attaching" @click="openPick(t)">附加到待办</button>
              <button class="tdel" aria-label="删除录音" @click="removeTake(t)">
                <Trash2 :size="15" />
              </button>
            </div>
          </div>
          <audio class="play" controls :src="t.dataUrl" />
        </li>
      </ul>
    </section>
    </div>

    <!-- 附加目标选择 -->
    <SheetModal :open="pickOpen" title="附加到待办" @close="pickOpen = false">
      <div class="picker">
        <label class="search row">
          <Search :size="15" class="t-3" />
          <input v-model="query" type="text" placeholder="搜索待办标题" aria-label="搜索待办标题">
        </label>
        <ul class="plist">
          <li v-for="t in candidates" :key="t.id">
            <button class="prow row between" @click="attachTo(t)">
              <span class="ptt">{{ t.title }}</span>
              <span class="num t-3 pmeta">
                {{ t.date === todayStr() ? '今天' : (t.date ?? '收件箱') }}{{ t.startMin != null ? ` ${minToHHmm(t.startMin)}` : '' }}
              </span>
            </button>
          </li>
          <li v-if="!candidates.length" class="pempty t-3">没有匹配的未完成待办</li>
        </ul>
      </div>
    </SheetModal>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部沿用全站页头节奏的一格 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 录音台 ---------- */

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 圆钮 / 计时 / 提示三块：12（同一张卡内的区块） */
  gap: var(--sp-12);
  /* 上 26 / 下 22 是「一屏只有一颗圆钮」的呼吸，左右 16 */
  padding: var(--sp-26) var(--pad-card) var(--sp-22);
}

.rec-btn {
  position: relative;
  width: 86px;
  height: 86px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--on-accent);
  transition:
    transform var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}

.rec-btn:active {
  transform: scale(0.94);
}

.rec-btn.on {
  background: var(--danger);
}

/* 录音中：外圈呼吸光环（opacity/transform，不触发 layout） */
.rec-btn.on::after {
  content: '';
  position: absolute;
  /* 呼吸光环外扩 8：7 不在 4/8 体系里，8 的光环宽度与圆钮直径之比几乎不变 */
  inset: calc(-1 * var(--sp-8));
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--danger) 55%, transparent);
  animation: recpulse 1.6s var(--ease-standard) infinite;
}

@keyframes recpulse {
  0% {
    transform: scale(0.92);
    opacity: 1;
  }
  70%,
  100% {
    transform: scale(1.18);
    opacity: 0;
  }
}

.timer {
  font-size: var(--fs-display-m);
  font-weight: var(--fw-bold);
  letter-spacing: 1px;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.timer.live {
  color: var(--danger);
}

.hint {
  font-size: var(--fs-caption);
}

.rec-acts {
  /* 录音中的两颗动作钮：无边界 8 */
  gap: var(--gap-sm);
  margin-top: var(--gap-text);
}

.cancel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  /* 常规按钮高 40（HarmonyOS 控件规范）：原先 10+10 内距 + 12 字（行高 1.5）= 38 */
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

/* 40 高的视觉钮命中区补到 44（上下各 2），触屏上「取消录音」不该点空 */
.cancel::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--gap-text)) 0;
  border-radius: inherit;
}

.err {
  font-size: var(--fs-caption);
  color: var(--danger-strong);
  background: var(--danger-soft);
  border-radius: var(--radius-s);
  padding: var(--gap-sm) var(--pad-inline);
}

/* ---------- 未归档 take ---------- */

.takes {
  margin-top: var(--gap-md);
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   手机上的录音台是「86px 圆钮 + 40px 数字」竖着堆的一张高卡；桌面半栏里
   右边只会空出半屏，所以把它横过来当一条控制台，take 区则摊成多栏。
   ============================================================ */

/* 栅格的行距由 gap 管；.takes 自带的 14px 上边距会与它叠加，收掉 */
.desk-main .rec-grid > .takes {
  margin-top: 0;
}

/* 录音台：一条横排控制台（圆钮 · 计时 · 提示 · 录音中的两个动作）。
   竖排时 86px 的圆钮 + 40px 的数字一张卡就要 250px 高，横过来只占 120px */
.desk-main .hero {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--desk-gap);
  padding: var(--sp-18) var(--sp-22);
}

/* take 是等高条目（名字 + 两个动作 + 一条播放器），桌面上摊成多栏。
   用 grid 而不是多栏流：每一条都要完整可点、不该被拆到两栏里；
   minmax 用 --desk-aside（320px）当栏宽下限，窄桌面自动退回一栏 */
.desk-main .tlist {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--desk-aside), 1fr));
  gap: var(--desk-gap);
}

.thead b {
  /* 区块标题走 Subtitle_S（14 Medium/Bold）：原先 12 与右侧计数同档，
     读不出「这是这一段的标题」 */
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

/* 计数降到与标题同档并补单位（「N 条」）：原来无字号继承 body 17px，比标题还大 */
.tcount {
  font-size: var(--fs-footnote);
}

.thead-side {
  gap: var(--gap-sm);
}

.empty {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  padding: var(--gap-sm) var(--gap-text);
}

.tlist {
  list-style: none;
  /* 与区块标题 8；条目之间 12（卡间距） */
  margin: var(--gap-sm) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.take {
  /* 条内距 12/16；名字行 / 动作行 / 播放器三块之间 8 */
  padding: var(--sp-12) var(--pad-card);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.trow {
  gap: var(--gap-md);
}

.tmeta {
  gap: var(--gap-text);
  min-width: 0;
}

.tmeta b {
  /* 行首只留时长（「录音」这个类别词由区块标题承担）：它是这一行的主数值 */
  font-size: var(--fs-headline);
}

.sub {
  /* 「14:03」是这条录音的身份信息，做这一行的主；体积降一档做体积注 */
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
}

.sub .vsep {
  width: 1px;
  height: 10px;
  background: var(--line-strong);
}

.ssize {
  font-size: var(--fs-micro);
}

.tacts {
  gap: var(--gap-sm);
  flex: none;
}

.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  /* 小按钮视觉 28（--control-sm），命中区由下面的 ::after 补到 44 */
  height: var(--control-sm);
  /* 固定高 + flex 居中，纵向不再叠内距；横向 12 */
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  /* soft 底上的文字走 strong 档（STANDARDS §4） */
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
}

.mini::after {
  content: '';
  position: absolute;
  /* 28 → 44：纵向各扩 8；横向不扩，右边的删除钮另有 44 热区 */
  inset: calc(-1 * var(--gap-sm)) 0;
  border-radius: inherit;
}

.mini:disabled {
  opacity: var(--disabled-opacity);
}

.tdel {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-3);
}

/* 32 的视觉钮命中区撑到 44（各外扩 6）：删除录音是破坏性操作，
   触屏上点偏了不该没反应，也不该误触到旁边的「附加」 */
.tdel::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

/* hover 反色只在真悬停设备生效：触屏点一下会粘在危险色上，像已经删掉了 */
@media (hover: hover) {
  .tdel:hover {
    color: var(--danger);
  }
}

.play {
  width: 100%;
  height: 36px;
}

/* ---------- 附加选择 ---------- */

.picker {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

.search {
  gap: var(--gap-sm);
  /* 搜索胶囊：上下 10（40 档）、左右 12 */
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  transition: box-shadow var(--dur-fast) var(--ease-standard);
}

/* 输入框自己是 outline:none（base.css），容器必须接住焦点：
   否则键盘用户 Tab 进搜索框后完全看不出焦点在哪 */
.search:focus-within {
  box-shadow: 0 0 0 2px var(--accent);
}

.search input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.plist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.prow {
  width: 100%;
  min-height: var(--row-h);
  gap: var(--gap-md);
  /* 单行选择行：12 上下 + 20 文本 ≈ 48 档（HarmonyOS 效率型列表 48 起） */
  padding: var(--sp-12) var(--gap-tight);
  border-bottom: 0.5px solid var(--line);
  text-align: left;
}

.ptt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.pmeta {
  flex: none;
  font-size: var(--fs-caption);
}

.pempty {
  padding: var(--gap-lg) 0;
  font-size: var(--fs-caption);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .rec-btn.on::after {
    animation: none;
    opacity: 0;
  }
}
</style>
