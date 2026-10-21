<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Ellipsis, FastForward, ListPlus } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import SessionExerciseSwapSheet from './SessionExerciseSwapSheet.vue'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import { exerciseSub } from '@/utils/plan'
import { fmtKg } from '@/utils/strength'
import type { PlanExercise, SessionSetSlot, SwapCandidate } from '@/types'

/**
 * 沉浸模式 · 全课程浏览抽屉（顶部胶囊唤起）。
 * 内容颗粒度到「每一组」：按动作分段，段内先列激活热身组（小重量，不计入组数），
 * 再列正式组，逐组标出状态（已完成 / 已跳过 / 进行中 / 未开始）。
 * 抽屉内可做的三件事：
 *  - 某个待做正式组右侧的 ··· → 跳至该组（只能向前跳，中间的组登记为跳过）；
 *  - 一组都还没做的动作 → 更换动作（只换动作本体与处方，进度不动）；
 *  - 底部一行「插入动作」→ 在这一场末尾加一个动作（课程库不变），
 *    选择面板由沉浸层统一弹（`insert` 事件），免得同一个面板在两处各写一遍。
 * 打开时内容区自动滚到当前组。
 */
const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: []; insert: [] }>()

const s = useSessionStore()
const lib = useExerciseLibStore()
const { toast } = useToast()

/** 内容滚动容器（SheetModal 暴露），用于打开时定位到当前组 */
const sheetRef = ref<InstanceType<typeof SheetModal> | null>(null)

interface ExGroup {
  exIdx: number
  ex: PlanExercise
  sub: string
  /** 激活热身组（不计入完成组数） */
  warmups: SessionSetSlot[]
  /** 正式组 */
  slots: SessionSetSlot[]
  done: number
  total: number
  canSwap: boolean
}

const groups = computed<ExGroup[]>(() => {
  const out: ExGroup[] = []
  for (const slot of s.courseSlots) {
    let g = out[out.length - 1]
    if (!g || g.exIdx !== slot.exIdx) {
      const ex = s.plan?.exercises[slot.exIdx]
      if (!ex) continue
      g = {
        exIdx: slot.exIdx,
        ex,
        sub: exerciseSub(ex),
        warmups: [],
        slots: [],
        done: 0,
        total: 0,
        canSwap: s.canSwapExercise(slot.exIdx),
      }
      out.push(g)
    }
    if (slot.warmup) {
      g.warmups.push(slot)
      continue
    }
    g.slots.push(slot)
    g.total++
    if (slot.state === 'done') g.done++
  }
  return out
})

const skippedTotal = computed(() => s.setSlots.filter((x) => x.state === 'skipped').length)

/* ---------- 打开即滚到当前组 ---------- */

function scrollToCurrent(): void {
  const body = sheetRef.value?.bodyEl
  if (!body) return
  const el = body.querySelector<HTMLElement>('[data-current="true"]')
  if (!el) return
  const b = body.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  body.scrollTop += e.top - b.top - (b.height - e.height) / 2
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    scrollToCurrent()
    // 抽屉入场是 transform 动画，布局落定后再校准一次
    requestAnimationFrame(scrollToCurrent)
  },
)

/* ---------- 单组 ··· 菜单：跳至该组 ---------- */

const menuOpen = ref(false)
const menuTarget = ref<SessionSetSlot | null>(null)
/** 菜单锚定元素：被点的那个 ··· 按钮 */
const menuAnchor = ref<HTMLElement | null>(null)

const MENU_ACTIONS: MenuItem[] = [{ label: '跳至该组', value: 'jump', icon: FastForward }]

/**
 * 某组所属动作的**展示名**：走库内名（`lib.resolveName`），与行内名同源。
 *
 * `SessionSetSlot.exName` 只是课程条目写入时的名称快照（`PlanExercise.name`）——
 * 换过动作、或库内改过名之后它就旧了。于是同一行同一组，行内显示新名，而「···」菜单标题
 * 与跳转提示显示旧名。`exIdx` 越界（脏快照）时回落到快照名。
 */
function slotName(slot: SessionSetSlot): string {
  const ex = s.plan?.exercises[slot.exIdx]
  return ex ? lib.resolveName(ex) : slot.exName
}

function openMenu(e: MouseEvent, slot: SessionSetSlot): void {
  menuAnchor.value = (e.currentTarget as HTMLElement) ?? null
  menuTarget.value = slot
  menuOpen.value = true
}

function onMenuPick(value: string): void {
  const t = menuTarget.value
  menuTarget.value = null
  if (value !== 'jump' || !t) return
  const before = skippedTotal.value
  if (s.skipToSet(t.exIdx, t.setNo)) {
    const skipped = skippedTotal.value - before
    toast(
      skipped > 0
        ? `已跳至 ${slotName(t)} 第 ${t.setNo} 组 · 跳过 ${skipped} 组`
        : `已跳至 ${slotName(t)} 第 ${t.setNo} 组`,
    )
    emit('close')
  } else {
    toast('只能跳到还没做的组')
  }
}

/* ---------- 更换动作 ---------- */

const swapIdx = ref<number | null>(null)

function onSwapPick(src: SwapCandidate): void {
  const i = swapIdx.value
  swapIdx.value = null
  if (i == null) return
  if (s.swapExercise(i, src)) toast(`已更换为「${src.name}」`)
  else toast('该动作已经做过，不能更换')
}

/* ---------- 展示 ---------- */

/** 每组的右侧状态文本：完成态展示真实登记值，其余展示状态词。
 *  热身标识只由左侧 .wtag 胶囊承担 —— 右侧再写一遍「热身」前缀，
 *  同一行的两处文字说同一件事，还挤占了真正的信息（重量 × 次数）。 */
function setMeta(slot: SessionSetSlot): string {
  if (slot.state === 'skipped') return '已跳过'
  if (slot.state === 'current') return '进行中'
  if (slot.state === 'pending') return '未开始'
  if (slot.done?.sec != null) return `${slot.done.sec} 秒`
  if (slot.done?.weight != null) {
    return `${fmtKg(slot.done.weight)}kg${slot.done.reps != null ? ` × ${slot.done.reps}` : ''}`
  }
  return '已完成'
}

const STATE_CLASS: Record<SessionSetSlot['state'], string> = {
  done: 'is-done',
  skipped: 'is-skipped',
  current: 'is-current',
  pending: 'is-pending',
}
</script>

<template>
  <SheetModal ref="sheetRef" :open="open" title="全课程进度" initial-snap="large" @close="emit('close')">
    <!-- 「跳过的组怎么统计」收进标题栏 InfoHint：面上只留顶部那枚「跳过 N 组」胶囊 -->
    <template #action>
      <InfoHint title="跳过的组如何统计">
        <p>跳过的组视为未做，不计入完成组数与总容量统计。</p>
      </InfoHint>
    </template>
    <p class="pname">{{ s.plan?.name ?? '训练课' }}</p>
    <p class="pmeta num">
      <span>已完成 {{ s.doneCount }}/{{ s.totalCount }} 组</span>
      <StatusChip v-if="skippedTotal > 0" tone="warn" size="sm">跳过 {{ skippedTotal }} 组</StatusChip>
    </p>

    <section v-for="g in groups" :key="g.exIdx" class="exblock">
      <header class="exhead row">
        <span class="ord num">{{ String(g.exIdx + 1).padStart(2, '0') }}</span>
        <div class="flex-1 exid col">
          <span class="exname">{{ lib.resolveName(g.ex) }}</span>
          <span class="exsub num t-3">{{ g.sub }}</span>
        </div>
        <!-- 每个动作的「做完了没」是这里要读的读数（旁边那行 .exsub 才是补充说明，留 --text-3），
             与顶部「已完成 n/N 组」同档 -->
        <span class="excount num t-2">{{ g.done }}/{{ g.total }} 组</span>
        <button
          v-if="g.canSwap"
          type="button"
          class="swapbtn"
          :aria-label="`更换动作 ${lib.resolveName(g.ex)}`"
          @click="swapIdx = g.exIdx"
        >
          更换
        </button>
      </header>

      <ul class="sets">
        <!-- 激活热身组：不计入组数，先行展示；未做的热身不提供跳转 -->
        <li
          v-for="w in g.warmups"
          :key="'warm' + w.setNo"
          class="setrow row is-warm"
          :class="STATE_CLASS[w.state]"
          :data-current="w.state === 'current' ? 'true' : undefined"
        >
          <span class="wtag">热身</span>
          <span class="setno num">第 {{ w.setNo }} 组</span>
          <span class="setmeta num">{{ setMeta(w) }}</span>
        </li>
        <li
          v-for="slot in g.slots"
          :key="slot.setNo"
          class="setrow row"
          :class="STATE_CLASS[slot.state]"
          :data-current="slot.state === 'current' ? 'true' : undefined"
        >
          <span class="setno num">第 {{ slot.setNo }} 组</span>
          <span class="setmeta num">{{ setMeta(slot) }}</span>
          <button
            v-if="slot.state === 'pending' || slot.state === 'current'"
            type="button"
            class="morebtn"
            :aria-label="`第 ${slot.setNo} 组的操作`"
            @click="openMenu($event, slot)"
          >
            <Ellipsis :size="18" />
          </button>
        </li>
      </ul>
    </section>

    <!-- 插入动作：这一场想多做点什么（健身房最常见的现场决定）。
         按钮放在流里而不是悬浮 —— 列表页的主操作悬浮必然压住最后一行。
         选择面板由沉浸层弹（见文件头的 `insert` 事件）。 -->
    <button type="button" class="addrow row" @click="emit('insert')">
      <ListPlus :size="16" />
      <span>在末尾插入动作</span>
    </button>

    <!-- 单组操作菜单（只向前跳到未做的组） -->
    <AppMenu
      :open="menuOpen"
      :title="menuTarget ? `${slotName(menuTarget)} · 第 ${menuTarget.setNo} 组` : ''"
      :actions="MENU_ACTIONS"
      :anchor="menuAnchor"
      @select="onMenuPick"
      @close="menuOpen = false"
    />

    <!-- 换动作：候选来自动作库内的同类型动作 -->
    <SessionExerciseSwapSheet
      :open="swapIdx !== null"
      :kind="s.plan?.exercises[swapIdx ?? 0]?.kind ?? 'strength'"
      :current-id="s.plan?.exercises[swapIdx ?? 0]?.exerciseId ?? ''"
      @pick="onSwapPick"
      @close="swapIdx = null"
    />
  </SheetModal>
</template>

<style scoped>
.pname {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
}

.pmeta {
  /* 课程名与副信息 2（主次文本上下） */
  margin-top: var(--gap-text);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-6);
  font-size: var(--fs-caption);
  /* 「已完成 n/N 组」是这份抽屉的第一条结论读数，与顶栏那枚同义的胶囊同档：
     它落到 --text-3（3.6:1）就比顶栏的同一句话淡一档，同义读数不该在两个位置两个浓度 */
  color: var(--text-2);
}

.exblock {
  /* 动作块之间 16（区块间距），原来 18 在格点外 */
  margin-top: var(--gap-lg);
}
.exhead {
  gap: var(--gap-sm);
  padding-bottom: var(--sp-8);
}

.ord {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-3);
}

.exid {
  gap: var(--gap-text);
}

.exname {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.exsub {
  font-size: var(--fs-caption);
}

.excount {
  font-size: var(--fs-caption);
  flex: none;
}

.swapbtn {
  flex: none;
  position: relative;
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  /* soft 底上的字走 strong 档（tokens.css:163-168）：实底档 --accent 压在上面读不清 */
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

/* 视觉约 27px 高，命中区撑到 44（视觉不动）。竖向 -9px 落进 .exblock 的 18px margin-top
   与表头的 8px padding-bottom 里，不与相邻内容抢点击；横向 -4px 只吃掉 10px gap 的一半。 */
.swapbtn::after {
  content: '';
  position: absolute;
  inset: -9px -4px;
}

/* 插入动作行：与动作块同宽的二级入口（流内，不悬浮）。
   高度与单组行对齐（--row-h），字走 --accent-strong（软底 / chip 上的主色文字档），
   图标与文字同一行、间距走 --gap-sm。 */
.addrow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  width: 100%;
  height: var(--row-h);
  margin-top: var(--gap-lg);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--accent-strong);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

.addrow:active {
  background: var(--accent-soft);
}

.sets {
  border-radius: var(--radius-m);
  background: var(--surface-2);
  overflow: hidden;
}

.setrow {
  gap: var(--sp-10);
  /* 单行组记录统一 48（--row-h），原来 46 不在行高档上 */
  height: var(--row-h);
  padding: 0 var(--sp-12);
}

.setrow + .setrow {
  border-top: 0.5px solid var(--line);
}

.setno {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

/* 热身组行：与正式组区分，轻量展示（不计入完成组数） */
.wtag {
  flex: none;
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong, var(--line));
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
}

.setrow.is-warm .setno {
  color: var(--text-3);
  font-weight: var(--fw-medium);
}

.setrow.is-warm .setmeta {
  color: var(--text-3);
}

.setmeta {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.morebtn {
  flex: none;
  position: relative;
  width: 32px;
  height: 32px;
  margin-right: calc(-1 * var(--sp-4));
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

/* 视觉留 32、命中区撑到 44 —— 这个钮还带 -4px 负 margin，实际热区比 32 还小一点点，
   而它是「跳至该组 / 更换这个动作」的唯一入口。 */
.morebtn::after {
  content: '';
  position: absolute;
  inset: -6px;
}

.morebtn:active {
  background: var(--line-strong);
}

/* 完成：登记值用主字色点题（数值走中性色，色相留给 soft 底的色块）；
   跳过：整行压暗表示不计入统计 */
.setrow.is-done .setmeta {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

/* 跳过：整行压暗表示不计入统计。浓度走令牌（tokens.css:37-40 收编的禁用档）——
   从前这里各写一个 0.5，令牌统一调档时它不跟随，会和其它禁用态悄悄分叉 */
.setrow.is-skipped {
  opacity: var(--disabled-opacity);
}

.setrow.is-skipped .setno {
  text-decoration: line-through;
}

.setrow.is-current {
  background: var(--c-exercise-soft);
}

.setrow.is-current .setno {
  font-weight: var(--fw-bold);
}

.setrow.is-current .setmeta {
  color: var(--text-1);
  font-weight: var(--fw-bold);
}

.setrow.is-pending .setno {
  color: var(--text-2);
  font-weight: var(--fw-medium);
}
</style>
