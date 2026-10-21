<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChevronDown, Play, Pencil, SearchX, Trash2 } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import PillChip from '@/components/common/PillChip.vue'
import ExerciseDetailDrawer from '@/components/exercise/ExerciseDetailDrawer.vue'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { usePlanStore } from '@/stores/plan'
import { useSessionStore } from '@/stores/session'
import { openImmersive } from '@/system/sessionImmersive'
import { useToast } from '@/composables/useToast'
import { estimatePlanMinutes, exerciseBadge, exerciseSub, planTypeLabel } from '@/utils/plan'
import type { PlanExercise } from '@/types'

/** 课程详情：动作明细，点击动作弹抽屉（激活肌群 / 参数 / 要点），开始训练 / 编辑 / 删除。 */
const route = useRoute()
const router = useRouter()
const planStore = usePlanStore()
const lib = useExerciseLibStore()
const session = useSessionStore()
const { toast } = useToast()

const ready = ref(false)
const detailEx = ref<PlanExercise | null>(null)
const conflictOpen = ref(false)
const delOpen = ref(false)
/**
 * 开课防重入。`session.start` 里串了 getActive + 建议引擎 + 上次重量 + session_start 一串 IPC，
 * 全程没有任何守卫；双击就让两次并发 start 都读到「无 active」而各建一场 —— 后端会静默把旧的
 * 那行标 aborted（计时被重置），而本地 sessionId 还可能指向已被 abort 的行，此后每次
 * session_snapshot 都打偏。HomeFooter 与 MuscleCatchupSheet 都有这道守卫，最常用的这处反而没有。
 */
const starting = ref(false)

onMounted(async () => {
  await Promise.all([planStore.ensureLoaded(), lib.ensureLoaded()])
  ready.value = true
})

const plan = computed(() => planStore.byId(String(route.params.id)))

/** 进行中的那场是哪种运动：store 只给了目标路由，这里翻成用户看得懂的说法。
 *  从前这条弹窗一律写「已有进行中的训练」，跑步也在里面 —— 用户点下去时并不知道
 *  自己会被送去哪（跑步页还是训练沉浸层），而 store 明明知道。 */
const conflictIsRun = computed(() => session.foreignRoute === '/session/run')
const conflictTitle = computed(() =>
  conflictIsRun.value
    ? '正在跑步，请先接续'
    : `正在上「${session.plan?.name ?? '训练课'}」，请先接续`,
)
const conflictAction = computed(() => (conflictIsRun.value ? '回到跑步' : '回到进行中的训练'))

/** 开始训练；已有进行中会话（训练课/跑步）时提示前往接续。
 *  形变锚点 = 开始按钮（从哪点从哪长出）。 */
async function onStart(e: MouseEvent): Promise<void> {
  if (!plan.value || starting.value) return
  const origin = e.currentTarget as HTMLElement | null // await 后 currentTarget 已置 null，同步先抓
  starting.value = true
  try {
    const r = await session.start(plan.value)
    if (r === 'conflict') conflictOpen.value = true
    else openImmersive(origin)
  } catch {
    // 失败原因由 store 统一 toast（ARCHITECTURE §3：提示由 store 决定、service 不吞错），
    // 这里只负责把按钮放回可点状态。
  } finally {
    starting.value = false
  }
}

/** 接续进行中的会话：训练课开沉浸层，跑步转跑步路由 */
function goConflict(): void {
  conflictOpen.value = false
  if (session.foreignRoute) void router.push(session.foreignRoute)
  else openImmersive()
}

async function doDelete(): Promise<void> {
  delOpen.value = false
  if (!plan.value) return
  await planStore.remove(plan.value.id)
  toast('课程已删除')
  void router.replace('/sports/plans')
}
</script>

<template>
  <div class="page">
    <PageHeader back :title="plan?.name ?? '课程详情'">
      <template #action>
        <button v-if="plan" class="hdr-btn" aria-label="编辑课程" @click="void router.push(`/sports/plans/${plan.id}/edit`)">
          <Pencil :size="15" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <EmptyState
      v-if="ready && !plan"
      :icon="SearchX"
      title="课程不存在或已删除"
      hint="回到全部课程看看其他内容"
    />

    <template v-if="plan">
      <!-- 桌面画布：动作明细是这页唯一的主体，整块通栏；移动端这里只是一个普通块容器 -->
      <div class="pd-body">
        <!-- 课程结论：时长是这门课的主角（title3 + 等宽），类别 / 动作数降成胶囊 -->
        <div class="sum">
          <p class="sum-main num">约 {{ estimatePlanMinutes(plan) }} 分钟</p>
          <p class="sum-meta">
            <span class="sum-sub">{{ plan.subtitle || '自定义课程' }}</span>
            <PillChip size="sm" tone="muted">{{ planTypeLabel(plan.workoutType) }}</PillChip>
            <PillChip size="sm" tone="muted"><span class="num">{{ plan.exercises.length }}</span> 个动作</PillChip>
          </p>
        </div>

        <section class="card">
          <!-- 动作条目单独一层：桌面上按两栏流铺开（见样式里的 .exlist） -->
          <div class="exlist">
            <div v-for="(e, i) in plan.exercises" :key="e.id" class="exitem">
              <button type="button" class="row item-row" @click="detailEx = e">
                <!-- 超级组码与序号不是一回事：码走宽胶囊（带 aria-label），序号保持圆点 -->
                <span v-if="e.group" class="grp" role="img" :aria-label="`超级组 ${e.group}`">{{ e.group }}</span>
                <span v-else class="idx num">{{ i + 1 }}</span>
                <span class="mid flex-1">
                  <b class="nm">{{ lib.resolveName(e) }}</b>
                  <small class="sub">{{ exerciseSub(e) }}</small>
                </span>
                <span v-if="exerciseBadge(e)" class="badge">{{ exerciseBadge(e) }}</span>
                <ChevronDown :size="16" class="chev" />
              </button>
            </div>
          </div>

          <!-- 按钮暂留课程名：scripts/e2e-session-timed.mjs:194/199 断言按钮文案含「开始「<课程名>」」，
               收成「开始训练」要等那条断言先改（审计方案 PlanDetailPage.vue L107）。
               准备中换成另一句文案：准备期要读近 42 天做组记录，冷启动并非瞬时，而 HIG 要求
               操作发起后超过约 100ms 就得给出进行中的反馈。点击那一刻文案仍是原样，
               所以上面那条断言照常命中。 -->
          <button
            type="button"
            class="start row center"
            :disabled="starting"
            :aria-busy="starting || undefined"
            @click="onStart"
          >
            <span v-if="starting" class="spin" aria-hidden="true" />
            <Play v-else :size="18" />
            {{ starting ? '正在准备今日处方…' : `开始「${plan.name}」` }}
          </button>
        </section>

        <button class="del row center" @click="delOpen = true">
          <Trash2 :size="16" /> 删除课程
        </button>
      </div>
    </template>

    <ActionSheet
      :open="conflictOpen"
      :title="conflictTitle"
      :actions="[{ label: conflictAction, value: 'go' }]"
      @select="goConflict"
      @close="conflictOpen = false"
    />

    <ActionSheet
      :open="delOpen"
      :title="`删除「${plan?.name ?? '课程'}」后，课程从列表移除且无法恢复；用它跑过的训练记录仍在`"
      :actions="[{ label: `删除「${plan?.name ?? ''}」`, value: 'del', danger: true }]"
      @select="doDelete"
      @close="delOpen = false"
    />

    <!-- 动作详情抽屉：激活肌群 / 训练参数 / 要点 -->
    <ExerciseDetailDrawer :open="detailEx != null" :exercise="detailEx" @close="detailEx = null" />
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 课程结论：时长单独一行作主角（一屏只有一个主数值），类别 / 动作数走胶囊 */
.sum {
  /* 结论块与下方卡片之间 12（卡片间距），左右 2 是字体左侧留白的光学补偿。 */
  margin: var(--sp-2) var(--sp-2) var(--gap-md);
}

.sum-main {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-1);
}

.sum-meta {
  display: flex;
  align-items: center;
  /* 副标题与两枚胶囊是主次文本左右的关系：8（--gap-text-inline） */
  gap: var(--gap-text-inline);
  flex-wrap: wrap;
  margin-top: var(--sp-4);
}

.sum-sub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.exitem {
  border-radius: var(--radius-m);
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.exitem:active {
  background: var(--surface-2);
}

.item-row {
  width: 100%;
  /* 动作条目是双行行（名称 + 处方）：行高 64（--row-h-double），
     整套动作读下来行距一致；左右内距收到 0，卡片的 16 已经是行内距。 */
  min-height: var(--row-h-double);
  text-align: left;
  gap: var(--gap-md);
  padding: var(--sp-12) 0;
}

/* 纯序号：圆点只装得下 1-2 位数字，宽内容（超级组 A1）走下面的 .grp 胶囊 */
.idx {
  min-width: 34px;
  height: 34px;
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  flex: none;
}

/* 超级组码：同一格位换成标准胶囊（宽内容不把圆撑成椭圆） */
.grp {
  min-width: 34px;
  height: 34px;
  padding: 0 var(--sp-10);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  flex: none;
}

.nm {
  display: block;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.sub {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-caption);
}

/* 动作类型签（「计时 / 有氧」）。与 ExerciseDetailDrawer 标题行那枚同款，但这里
   逐动作行重复出现，不满足类型字章「只出现一次」的保留条件：文字走中性色，
   色相留在 soft 底的色块上（色彩配额，STANDARDS §4） */
.badge {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--c-balance) 14%, transparent);
  color: var(--text-1);
}

.chev {
  color: var(--text-3);
}

.start {
  width: 100%;
  /* 卡内区块之间 12（规范：卡内区块 12），开始钮不再比列表多挤 2px。 */
  margin-top: var(--gap-md);
  gap: var(--sp-6);
  height: 52px;
  /* 高 52 的主行动走胶囊，与沉浸层那颗主按钮同一形态 */
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
  box-shadow: var(--shadow-float);
}

.start:disabled {
  opacity: var(--disabled-opacity);
}

/* 准备中的旋环：纯 CSS，不引图标库 —— 少一个「这颗图标在不在这个版本里」的来源。 */
.spin {
  width: 16px;
  height: 16px;
  flex: none;
  border: 2px solid color-mix(in srgb, var(--bg) 30%, transparent);
  border-top-color: var(--bg);
  border-radius: var(--radius-full);
  animation: start-spin 700ms linear infinite;
}

@keyframes start-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 旋转是「正在跑」的语义本身，不能按装饰性动效一删了事；降级成静止的环 —— 它仍然
   说明「已经点了、正在准备」，只是不再转。 */
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}

/* 删除是低频但危险的动作：与开始钮同一套按钮层级（圆角 20），
   文字走 --danger-strong —— 实底档 --danger 压浅底 3.55:1，14px 读不清。 */
.del {
  width: 100%;
  min-height: var(--control-md);
  margin-top: var(--sp-12);
  gap: var(--sp-6);
  padding: var(--sp-12) 0;
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--danger-strong);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
}

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   ============================================================ */

/* 这页只有「一套动作」和一枚开始钮。壳层缺省会把 .card 压进半栏（479px），
   右半屏整块空着；动作明细本来就该通栏，所以这里自铺一张单列画布：
   通栏是缺省，将来要塞侧栏再往这里加一列即可。 */
.desk-main .pd-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--desk-gap);
  align-items: start;
}

/* 行距统一交给栅格 gap：条目自身那些 2/12/14px 的纵向边距清掉，
   否则和 gap 叠加成双倍间距 */
.desk-main .pd-body > * {
  min-width: 0;
  margin-block: 0;
}

/* 动作条目摊成两栏流：一行只有「序号 + 名称 / 处方」，970px 单列读起来空荡；
   两栏让整套课程一屏看完。用 columns 而不是 grid —— 处方文字长短不一，
   grid 会把同行条目撑到最高的那条，columns 是按内容自然分栏。
   条目自带序号，按栏读（先读完左栏再读右栏）顺序依然是 1→9。 */
.desk-main .exlist {
  columns: 2;
  column-gap: var(--desk-gap);
}

.desk-main .exlist > .exitem {
  break-inside: avoid;
}
</style>
