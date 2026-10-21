<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, MessageCircle, ListTodo, Play } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import { fmtMmSs } from '@/utils/format'

/**
 * 时间脊 —— 语音记录的唯一时间原语。
 *
 * 核心主张：**会话不是列表，是一段可以摸到的时间**。
 * 一段话在脊上的宽度 = 它真实说出来的时长，块之间的空隙 = 静默。
 * 于是「哪里密、哪里冷场、谁在长篇大论」不用读文字就能看出来。
 *
 * 三种形态同一份数据，缩放即切换，不是三个页面：
 *  - `structure`：整场压进一屏，只看结构（块的宽度与位置）
 *  - `read`：文字展开，顶部保留一条按真实比例的「你在这里」细带
 *  - `mini`：一行缩略脊，给列表 / 浮条 / 选择器用
 *
 * 观感语汇（贯穿三形态）：**一条细轨 + 悬浮其上的发声块**。
 * 细轨画出「整段有多长」这条底，块是「哪几段真的在说话」——
 * 分层让它在任何尺寸下都读成一张时间图，而不是一根被填色的进度条
 * （粗轨道 + 一整块连续色带 = 进度条，那正是这一版要摆脱的观感）。
 *
 * 数据口径：ASR 只给每句的起始时间，没有句末时间，所以**块宽是估计的**
 * （按字数估朗读时长，且不超过到下一句的间隔，剩余部分即静默）。
 */

export interface SpineSeg {
  /** 句首时间（毫秒） */
  t: number
  /** 句末时间；有就用它算块宽，没有才按字数估 */
  durMs?: number
  /** 说话人。ASR 不做说话人分离，真实数据通常只有一位 */
  who: string
  text: string
  /** 未定稿（还在转写中的那句） */
  partial?: boolean
}

export interface SpinePin {
  /** 挂在第几句上（纪要条目本来就有 refs，直接复用） */
  idx: number
  kind: 'answer' | 'todo'
  text: string
}

const props = withDefaults(
  defineProps<{
    segments: SpineSeg[]
    /** 总时长；缺省取最后一句 + 一句的估时 */
    totalMs?: number
    pins?: SpinePin[]
    /** full 整脊 / mini 一行缩略 */
    size?: 'full' | 'mini'
    mode?: 'structure' | 'read'
    /** 播放/录制游标（毫秒） */
    headMs?: number
    /** 游标是否在「实时生长」（录音中）—— 决定它画不画那颗呼吸的定位点 */
    headPulse?: boolean
    /** 当前高亮句下标 */
    activeIdx?: number
    /** 静默超过这个秒数就折叠，0 = 不折 */
    foldSilenceOver?: number
  }>(),
  {
    size: 'full',
    mode: 'structure',
    headPulse: false,
    foldSilenceOver: 8,
  },
)

const emit = defineEmits<{
  seek: [ms: number]
  pick: [idx: number]
  unfold: [i: number]
}>()

/** 块宽：优先用 ASR 给的真实句末时间；只有它缺失时才按字数估朗读时长。
 *  估的时候不超过到下一句的间隔 —— 剩下的部分就是静默。 */
function estimateDur(i: number): number {
  // 越界返回 0 而不是断言非空：`total` 对**空数组**也要能算（此时最后一个下标是 -1），
  // 而空数组是真实存在的状态 —— 会话刚进「转写中」、ASR 还没吐第一句时就是这个形状。
  // 断言在这里会直接抛在 computed 里，把整块会话视图的渲染打断（一次抛、之后每次重渲染都抛），
  // 表现为「开始录音后转写区永远空着」。
  const s = props.segments[i]
  if (!s) return 0
  if (s.durMs != null && s.durMs > 0) return s.durMs
  const next = props.segments[i + 1]
  const byText = Math.max(900, Math.min(14_000, (s.text.length / 5.2) * 1000))
  if (!next) return byText
  return Math.min(byText, Math.max(400, next.t - s.t))
}

const total = computed(() => props.totalMs ?? (props.segments.at(-1)?.t ?? 0) + estimateDur(props.segments.length - 1))

const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / Math.max(1, total.value)) * 100))}%`

interface Block {
  idx: number
  who: string
  t: number
  dur: number
  text: string
  partial: boolean
  /** 本句之前是否有被折叠的静默 */
  foldBefore: number
}

const blocks = computed<Block[]>(() =>
  props.segments.map((s, i) => {
    const prev = props.segments[i - 1]
    const gap = prev ? s.t - (prev.t + estimateDur(i - 1)) : 0
    return {
      idx: i,
      who: s.who,
      t: s.t,
      dur: estimateDur(i),
      text: s.text,
      partial: !!s.partial,
      foldBefore: props.foldSilenceOver > 0 && gap > props.foldSilenceOver * 1000 ? gap : 0,
    }
  }),
)

/** 说话人 → 泳道（最多两条；超过两条的会话按前两位分流） */
const lanes = computed(() => {
  const seen: string[] = []
  for (const s of props.segments) if (!seen.includes(s.who)) seen.push(s.who)
  return seen.slice(0, 2)
})
const laneOf = (who: string) => Math.max(0, lanes.value.indexOf(who))

/**
 * 只有一位说话人（ASR 的常态）时不画说话人列：
 * 一整列「我」既不携带信息，又把每行正文往右挤了一格。
 */
const singleLane = computed(() => lanes.value.length <= 1)

const rulerTicks = computed(() => {
  const stepChoices = [30_000, 60_000, 300_000, 600_000, 900_000]
  const step = stepChoices.find((s) => total.value / s <= 8) ?? 900_000
  const out: { ms: number; label: string }[] = []
  for (let ms = 0; ms <= total.value; ms += step) out.push({ ms, label: fmt(ms) })
  return out
})

function fmt(ms: number): string {
  return fmtMmSs(ms, { padMinutes: true })
}

/** 把注记挂到对应句子的时间点上；同句多条合并成一个锚点 */
const pinsOnAxis = computed(() => {
  const byIdx = new Map<number, SpinePin[]>()
  for (const p of props.pins ?? []) {
    const list = byIdx.get(p.idx) ?? []
    list.push(p)
    byIdx.set(p.idx, list)
  }
  return [...byIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, items]) => ({
      idx,
      items,
      t: props.segments[idx]?.t ?? 0,
      hasTodo: items.some((x) => x.kind === 'todo'),
    }))
})

/** 缩略脊上的纪要小点：夹在 2%~97% 之间，免得贴边被圆角切掉 */
const miniPins = computed(() =>
  pinsOnAxis.value.map((p) => ({
    ...p,
    at: `${Math.min(97, Math.max(2, (p.t / Math.max(1, total.value)) * 100))}%`,
  })),
)

const hasTodoPins = computed(() => (props.pins ?? []).some((p) => p.kind === 'todo'))
const headPct = computed(() => (props.headMs == null ? null : pct(props.headMs)))

function onAxisClick(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  emit('seek', Math.round(ratio * total.value))
}
</script>

<template>
  <!-- ============ 缩略脊：列表 / 浮条 / 选择器用 ============ -->
  <div v-if="size === 'mini'" class="mini" :aria-label="`会话缩略 ${fmt(total)}`">
    <span
      v-for="b in blocks"
      :key="b.idx"
      class="mblk"
      :class="[`lane-${laneOf(b.who)}`, { partial: b.partial }]"
      :style="{ left: pct(b.t), width: pct(b.dur) }"
    />
    <span
      v-for="p in miniPins"
      :key="`mp-${p.idx}`"
      class="mpin"
      :class="{ todo: p.hasTodo }"
      :style="{ left: p.at }"
      aria-hidden="true"
    />
    <span v-if="headPct" class="mhead" :class="{ live: headPulse }" :style="{ left: headPct }" />
  </div>

  <!-- ============ 结构脊：整场压进一屏 ============ -->
  <div v-else-if="mode === 'structure'" class="spine" :class="{ solo: singleLane }">
    <div class="lanes">
      <div v-for="(w, li) in lanes" :key="w" class="lane-row">
        <span v-if="!singleLane" class="lane-name">{{ w }}</span>
        <div class="lane-track" @click="onAxisClick">
          <button
            v-for="b in blocks.filter((x) => laneOf(x.who) === li)"
            :key="b.idx"
            class="blk"
            :class="{ on: b.idx === activeIdx, partial: b.partial }"
            :style="{ left: pct(b.t), width: pct(b.dur) }"
            :title="b.text"
            @click.stop="emit('pick', b.idx)"
          >
            <span class="btext">{{ b.text }}</span>
          </button>
        </div>
      </div>

      <!-- 静默折叠：一条细缝 -->
      <div v-if="blocks.some((x) => x.foldBefore)" class="folds">
        <span v-if="!singleLane" class="lane-name" />
        <div class="fold-track" @click="onAxisClick">
          <button
            v-for="b in blocks.filter((x) => x.foldBefore)"
            :key="`f-${b.idx}`"
            class="fold"
            :style="{ left: pct(b.t - b.foldBefore), width: pct(b.foldBefore) }"
            :aria-label="`静默 ${Math.round(b.foldBefore / 1000)} 秒`"
            @click.stop="emit('unfold', b.idx)"
          >
            <i /><i /><i />
          </button>
        </div>
      </div>

      <!-- 坐标轴 + 纪要锚点 -->
      <div class="axis">
        <span v-if="!singleLane" class="lane-name" />
        <div class="axis-track" @click="onAxisClick">
          <span v-for="tick in rulerTicks" :key="tick.ms" class="tick" :style="{ left: pct(tick.ms) }">
            <i /><em class="num">{{ tick.label }}</em>
          </span>
          <button
            v-for="p in pinsOnAxis"
            :key="`p-${p.idx}`"
            class="pin"
            :class="{ todo: p.hasTodo }"
            :style="{ left: pct(p.t) }"
            :aria-label="`第 ${p.idx + 1} 句处的纪要`"
            @click.stop="emit('pick', p.idx)"
          />
          <span v-if="headPct" class="mhead head-axis" :class="{ live: headPulse }" :style="{ left: headPct }" />
        </div>
      </div>
    </div>

    <p class="legend">
      <span><i class="sw lane-0" />{{ lanes[0] ?? '—' }}</span>
      <span v-if="lanes[1]"><i class="sw lane-1" />{{ lanes[1] }}</span>
      <span v-if="hasTodoPins"><i class="sw pin-sw" />待办</span>
      <!-- 编码规则是图例的一部分（且必须写明「估算」）；「点块跳转」这类交互提示
           与三形态的说明收进行尾 InfoHint —— 图例和操作提示不该并列成一行同类字 -->
      <span class="enc">块宽 ≈ 讲话时长（估算）</span>
      <span class="hint-slot">
        <InfoHint
          title="时间脊怎么看"
          content="同一份数据有三种形态，缩放即切换：整场结构（这一屏，只看块的位置与宽窄）、精读（文字逐句展开，顶部仍有按真实比例的时间带）、缩略（一行小脊，给列表和浮条用）。

点色块跳到对应的那句话；点细轨的空白处，从那一时刻开始播放；菱形点是这场录音里记下的待办锚点。

块宽按讲话时长估算：转写只给出每句的开始时间，句末时长按字数估出来，所以宽度是近似值；块之间的空隙就是静默，超过阈值的静默会折叠起来。"
        />
      </span>
    </p>
  </div>

  <!-- ============ 精读：文字展开，时间仍在 ============ -->
  <div v-else class="reading">
    <div class="strip" @click="onAxisClick">
      <span class="srail" />
      <span
        v-for="b in blocks"
        :key="b.idx"
        class="sblk"
        :class="[`lane-${laneOf(b.who)}`, { on: b.idx === activeIdx, partial: b.partial }]"
        :style="{ left: pct(b.t), width: pct(b.dur) }"
      />
      <span v-if="headPct" class="mhead" :class="{ live: headPulse }" :style="{ left: headPct }" />
    </div>

    <ol class="lines">
      <template v-for="b in blocks" :key="b.idx">
        <li v-if="b.foldBefore" class="silence">
          <span class="stime num">{{ fmt(b.t - b.foldBefore) }}</span>
          <span class="slabel">静默 {{ Math.round(b.foldBefore / 1000) }} 秒</span>
        </li>
        <li
          class="tl"
          :class="{ on: b.idx === activeIdx, partial: b.partial }"
          @click="emit('pick', b.idx)"
        >
          <time class="num">{{ fmt(b.t) }}</time>
          <span v-if="!singleLane" class="who">{{ b.who }}</span>
          <p>
            {{ b.text }}<span v-if="b.partial" class="caret" />
            <button
              v-for="p in pinsOnAxis.find((x) => x.idx === b.idx)?.items ?? []"
              :key="p.text"
              class="ipin"
              :class="{ todo: p.kind === 'todo' }"
              :title="p.text"
            >
              <component :is="p.kind === 'todo' ? ListTodo : MessageCircle" :size="10" />
            </button>
          </p>
          <button class="jump" :aria-label="`从 ${fmt(b.t)} 播放`" @click.stop="emit('seek', b.t)">
            <Play :size="11" />
          </button>
        </li>
      </template>
    </ol>

    <p v-if="pinsOnAxis.length" class="pinbar">
      <ChevronRight :size="12" />
      本场有 {{ pinsOnAxis.length }} 处纪要锚点，点句尾的角标可对照
    </p>
  </div>
</template>

<style scoped>
/* ============================================================
   时间脊的语汇（三形态共用）
   细轨画「整段有多长」，块是「哪几段真的在说话」——
   分层的初衷见文件头：粗轨道 + 一整块连续色带会被读成进度条。
   ============================================================ */
.mini,
.spine,
.reading {
  --spine-c: var(--led-shopping);
  /* 竖直微渐变（上亮下实）+ 顶部内高光：小尺寸的块靠这两条才立得起来，
     不然只是一片纯色贴纸。混的是 --on-accent（亮暗两色档恒为白），
     所以暗色下同样是「提亮」而不是「压暗」。 */
  --spine-fill: linear-gradient(
    180deg,
    color-mix(in srgb, var(--spine-c) 78%, var(--on-accent)),
    var(--spine-c)
  );
  --spine-shine: inset 0 1px 0 color-mix(in srgb, var(--on-accent) 40%, transparent);
  /* 细轨：不写死灰，跟主题走 —— 暗色下「提亮一档」，亮色下「压深一档」 */
  --spine-rail: color-mix(in srgb, var(--text-1) 8%, transparent);
}

/* 两说话人：域色 + 中性，避免再引入第三第四种颜色 */
.lane-0 {
  --spine-c: var(--led-shopping);
}

.lane-1 {
  --spine-c: color-mix(in srgb, var(--led-shopping) 44%, var(--text-3));
}

/* 定位游标（播放头 / 录制头）：一条竖线。它是这块区域里唯一的竖线，
   用来回答「现在在哪」。实时生长时给一点呼吸 —— 不是装饰光晕，是「它在动」。 */
/* 刻度 / 块 / 播放头的圆角是**图形几何**（2px 线、3px 细块、4.5px 缩放后的描环），
   不是界面间距，故保留原值 —— 换成 4/8 的令牌会把 10px 高的色块切成两头圆、
   把 1.5px 的缝吃掉。 */
.mhead {
  position: absolute;
  width: 2px;
  border-radius: 2px;
  background: var(--text-1);
}

.mhead.live {
  animation: spine-head 1.6s var(--ease-standard) infinite;
}

@keyframes spine-head {
  50% {
    opacity: 0.45;
  }
}

/* ===== 缩略脊 ===== */
.mini {
  position: relative;
  width: 100%;
  height: 20px;
}

/* 轨道是一条 3px 细线，块比它高 —— 这层高度差就是「时间图」与「进度条」的分界 */
.mini::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 3px;
  transform: translateY(-50%);
  border-radius: var(--radius-full);
  background: var(--spine-rail);
}

.mblk {
  position: absolute;
  top: 4px;
  height: 12px;
  min-width: 3px;
  border-radius: 4px;
  /* 右缘透明边 + padding-box 裁剪 = 相邻句之间留 1.5px 缝，
     否则连续发声会糊成一整条色带（列表里那一版最丑的就是这一点）。 */
  border-right: 1.5px solid transparent;
  background: var(--spine-fill);
  background-clip: padding-box;
  box-shadow: var(--spine-shine);
}

.mblk.partial {
  opacity: 0.5;
}

/* 缩略脊上的纪要锚点：悬在块上方的一颗小点（待办用分类橙） */
.mpin {
  position: absolute;
  top: 0;
  width: 4px;
  height: 4px;
  margin-left: calc(-1 * var(--sp-2));
  border-radius: 50%;
  background: var(--led-shopping);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-1) 22%, transparent);
}

.mpin.todo {
  background: var(--cat-work);
}

.mini .mhead {
  top: 1px;
  bottom: 1px;
}

/* ===== 结构脊 ===== */
.spine {
  display: flex;
  flex-direction: column;
  gap: var(--sp-10);
}

.lanes {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.lane-row,
.folds,
.axis {
  display: flex;
  align-items: center;
  gap: var(--sp-10);
}

.lane-name {
  flex: none;
  width: 34px;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lane-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 36px;
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-1) 5%, transparent);
  cursor: crosshair;
}

/* 轨道中间那条细线（与缩略脊同一语汇）：有了基准线，块才像「落在时间上」 */
.lane-track::before {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  border-radius: var(--radius-full);
  background: var(--spine-rail);
}

.blk {
  position: absolute;
  top: 5px;
  bottom: 5px;
  min-width: 3px;
  padding: 0 var(--sp-8);
  border-radius: var(--radius-xs);
  overflow: hidden;
  text-align: left;
  color: var(--on-accent);
  border-right: 1.5px solid transparent;
  background: var(--spine-fill);
  background-clip: padding-box;
  box-shadow: var(--spine-shine);
  transition: outline-color var(--dur-fast) var(--ease-standard);
}

/* 当前句：域色描环。不动位置 —— 位移会让整条脊「抖」一下 */
.blk.on {
  outline: 2px solid var(--spine-c);
  outline-offset: 1.5px;
  z-index: 1;
}

.blk.partial {
  opacity: 0.55;
}

.btext {
  display: block;
  font-size: var(--fs-micro);
  line-height: 26px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fold-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 16px;
  cursor: pointer;
}

.fold {
  position: absolute;
  top: 6px;
  height: 4px;
  min-width: 8px;
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  gap: var(--sp-2);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-3) 22%, transparent);
}

.fold i {
  width: 1px;
  height: 4px;
  background: var(--surface);
}

.axis-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 26px;
  border-top: 1px solid var(--line-strong);
  cursor: crosshair;
}

.tick {
  position: absolute;
  top: 0;
}

.tick i {
  display: block;
  width: 1px;
  height: 5px;
  background: var(--line-strong);
}

.tick em {
  position: absolute;
  top: 6px;
  transform: translateX(-50%);
  font-style: normal;
  font-size: var(--fs-micro);
  /* 轴标签是要读的数据，不是水印：11px 用 --text-3 只有 3.6:1，提到 --text-2 */
  color: var(--text-2);
  white-space: nowrap;
}

.pin {
  position: absolute;
  top: -5px;
  width: 9px;
  height: 9px;
  transform: translateX(-50%) rotate(45deg);
  border-radius: 2px;
  background: var(--led-shopping);
}

.pin.todo {
  background: var(--cat-work);
}

/* 轴上的游标比内容行的长：从轴的顶线再往上探一点，读成「指向这一刻」 */
.head-axis {
  top: -6px;
  bottom: 0;
}

.legend {
  display: flex;
  align-items: center;
  gap: var(--sp-12);
  padding-left: 44px;
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.spine.solo .legend {
  padding-left: 0;
}

.legend span {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
}

/* 编码规则留在图例里：caption + text-2 —— 它回答「这张图在编码什么」，是必须读的一句 */
.legend .enc {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 交互说明（点块跳转 / 三形态）收进行尾 InfoHint：与图例同行，但不同形态 */
.legend .hint-slot {
  margin-left: auto;
  display: inline-flex;
}

.sw {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  background: var(--spine-c);
}

.sw.pin-sw {
  border-radius: 2px;
  transform: rotate(45deg);
  background: var(--cat-work);
}

/* ===== 精读 ===== */
.reading {
  display: flex;
  flex-direction: column;
}

/* 顶带不画满宽灰底：一条细轨 + 悬在上面的块，与缩略脊/结构脊同一张脸 */
.strip {
  position: relative;
  height: 18px;
  margin-bottom: var(--sp-4);
  cursor: crosshair;
}

.srail {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 3px;
  transform: translateY(-50%);
  border-radius: var(--radius-full);
  background: var(--spine-rail);
}

.sblk {
  --sblk-grow: 1.4; /* 高亮放大倍率：旧 top:4→2 / height:10→14 绕中心对称生长，14/10 收成一处变量 */
  position: absolute;
  top: 4px;
  bottom: 4px; /* 由上下缘定高（条带 18px 里居中的 10px），scaleY 默认原点 center 即中线 */
  min-width: 3px;
  border-radius: 3px;
  border-right: 1.5px solid transparent;
  background: var(--spine-fill);
  background-clip: padding-box;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.sblk.on {
  transform: scaleY(var(--sblk-grow));
  box-shadow: var(--spine-shine);
}

/* 描环挪到 ::after 并反算缩放（scaleY(calc(1/var(--sblk-grow)))）：box-shadow/outline 都画在
   被变换后的坐标系里，scaleY(1.4) 会把 1.5px 拉成 2.1px，且 outline 不跟圆角 */
.sblk.on::after {
  content: '';
  position: absolute;
  inset: -1.5px;
  border: 1.5px solid color-mix(in srgb, var(--spine-c) 40%, transparent);
  border-radius: 4.5px;
  transform: scaleY(calc(1 / var(--sblk-grow)));
}

.strip .mhead {
  top: 0;
  bottom: 0;
}

.lines {
  display: flex;
  flex-direction: column;
}

.tl {
  display: flex;
  align-items: baseline;
  gap: var(--gap-md);
  padding: var(--sp-12) var(--sp-8);
  margin: 0 calc(-1 * var(--sp-8));
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-standard);
}

/* 行分隔用 inset 阴影而不是 border：进/出行带背景色时不会顶出 1px 位移 */
.tl + .tl {
  box-shadow: inset 0 1px 0 var(--line);
}

.tl.on {
  background: color-mix(in srgb, var(--led-shopping) 8%, transparent);
}

.tl.partial p {
  color: var(--text-2);
}

.tl time {
  flex: none;
  width: 34px;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  /* 同上：时间戳是这句的读数，11px 下 --text-3 读不清 */
  color: var(--text-2);
}

.tl .who {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--led-shopping) 12%, transparent);
  color: var(--text-1);
}

.tl p {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-callout);
  line-height: var(--lh-body);
  color: var(--text-1);
}

.tl .jump {
  flex: none;
  align-self: center;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 触屏没有 hover：只在「当前行」露出跳转键，够用且不吵 */
.tl.on .jump {
  opacity: 1;
}

@media (hover: hover) {
  .tl:hover .jump {
    opacity: 1;
  }

  .tl:hover {
    background: var(--surface-2);
  }
}

/* 行内小徽章 15px：圆角走最小一档（4） */
.ipin {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  margin-left: var(--sp-4);
  vertical-align: -2px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--led-shopping) 16%, transparent);
  color: var(--text-1);
}

.ipin.todo {
  background: color-mix(in srgb, var(--cat-work) 18%, transparent);
  color: var(--text-1);
}

.silence {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: var(--sp-4) var(--sp-8) var(--sp-4) 0;
}

/* 折叠掉的那段空场有多长，是这一行唯一的读数：时间戳抬到 caption + text-2，
   不再叠 opacity 做二次手调弱化（0.6 一叠，亮暗两色下都糊） */
.stime {
  flex: none;
  width: 34px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 标签保留胶囊形态：surface-2 底 + text-2 字，当「折叠静默」的形态标记 */
.slabel {
  display: inline-flex;
  align-items: center;
  min-height: var(--chip-h);
  font-size: var(--fs-caption);
  color: var(--text-2);
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.pinbar {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  margin-top: var(--sp-10);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.caret {
  display: inline-block;
  width: 2px;
  height: 13px;
  margin-left: var(--sp-4);
  vertical-align: -2px;
  background: var(--led-shopping);
  animation: rein-caret-blink 1s steps(2) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .mhead.live,
  .caret {
    animation: none;
  }

  .blk,
  .sblk,
  .tl,
  .tl .jump {
    transition: none;
  }
}
</style>
