<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Play, Plus } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import PillChip from '@/components/common/PillChip.vue'
import { usePlanStore } from '@/stores/plan'
import { useSessionStore } from '@/stores/session'
import { openImmersive } from '@/system/sessionImmersive'
import { estimatePlanMinutes } from '@/utils/plan'
import type { WorkoutPlanRecord } from '@/types'

/**
 * 训练课程卡：训练主页只展示最近使用的三个课程；
 * 全部课程的管理（列表/详情/编辑）收敛在 /sports/plans 二级页。
 */
const router = useRouter()
const planStore = usePlanStore()
const session = useSessionStore()

const conflictOpen = ref(false)
const startingId = ref('')

onMounted(() => {
  void planStore.ensureLoaded()
})

/** 快速开始（卡片播放键）：已有进行中会话时提示前往接续。
 *  形变锚点 = 被点的播放键本身（从哪点从哪长出，且不依赖此刻
 *  可能尚未落位的悬浮条）。 */
async function quickStart(e: MouseEvent, p: WorkoutPlanRecord): Promise<void> {
  startingId.value = p.id
  const origin = e.currentTarget as HTMLElement | null // await 后 currentTarget 已置 null，同步先抓
  try {
    const r = await session.start(p)
    if (r === 'conflict') conflictOpen.value = true
    else openImmersive(origin)
  } catch {
    // 开课失败的可视回执由 store 内的 toast 负责（session.start 原样抛）；
    // 这里只吞掉拒绝，避免 unhandled rejection，finally 复位播放键供重试。
  } finally {
    startingId.value = ''
  }
}

/** 接续进行中的会话：训练课开沉浸层，跑步转跑步路由 */
function goConflict(): void {
  conflictOpen.value = false
  if (session.foreignRoute) void router.push(session.foreignRoute)
  else openImmersive()
}
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>训练课程</h2>
      <button class="all row" type="button" @click="void router.push('/sports/plans')">
        全部课程 <ChevronRight :size="15" />
      </button>
    </header>

    <ul v-if="planStore.recent.length > 0" class="list">
      <li v-for="p in planStore.recent" :key="p.id" class="row item">
        <button class="row body flex-1" type="button" @click="void router.push(`/sports/plans/${p.id}`)">
          <span class="flex-1">
            <b class="name">{{ p.name }}</b>
            <!-- 副行拆两级：肌群退居 --text-3 次要文字（行尾截断，不把整行撑开）；
                 动作数与时长走两枚中性胶囊，不再用「·」把五个等权词串成一行。
                 时长不提档——上方 .name（fs-body/600）才是主角，见审计 L1309 的不落地裁定 -->
            <small class="meta">{{ p.subtitle || '自定义课程' }}</small>
            <span class="pills">
              <PillChip size="sm" tone="muted">
                <span class="num">{{ p.exercises.length }}</span> 个动作
              </PillChip>
              <PillChip size="sm" tone="muted">
                约 <span class="num">{{ estimatePlanMinutes(p) }}</span> 分钟
              </PillChip>
            </span>
          </span>
        </button>
        <button
          class="play col center"
          type="button"
          :aria-label="`开始「${p.name}」`"
          :disabled="startingId === p.id"
          @click="quickStart($event, p)"
        >
          <Play :size="16" :stroke-width="2.6" />
        </button>
      </li>
    </ul>

    <!-- 互斥关系扩到两颗按钮：空状态只出现「创建第一个训练课程」，
         有记录才出现「新建课程」—— 同一动作、同一目的地，不能并排两颗 -->
    <button v-if="!planStore.recent.length" class="new row center" type="button" @click="void router.push('/sports/plans/new/edit')">
      <Plus :size="17" /> 创建第一个训练课程
    </button>
    <button v-else class="more row center" type="button" @click="void router.push('/sports/plans/new/edit')">
      <Plus :size="16" /> 新建课程
    </button>

    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练，请先接续"
      :actions="[{ label: '前往继续', value: 'go' }]"
      @select="goConflict"
      @close="conflictOpen = false"
    />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.all {
  position: relative;
  gap: 0;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 「全部课程 ›」视觉只有 17px 高。整行热区用 ::after 撑到 44，
   视觉与卡头高度都不动；外扩只落在卡头周围的空白里。 */
.all::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: calc(100% + 20px);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
}

.list {
  /* 卡头与列表之间 8（卡内标题与内容 8），原来 4 让列表像贴着标题长出来的。 */
  margin-top: var(--gap-sm);
}

.item {
  /* 课程行是双行行：高度统一 64（--row-h-double），行间分隔线间距才稳定 */
  min-height: var(--row-h-double);
  gap: var(--gap-md);
  padding: var(--sp-12) 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.body {
  /* 名字 / 说明 / 胶囊三行同组：行间 8，与 .pills 的 4 一起构成「主次 2、组内 8」 */
  gap: var(--gap-sm);
  text-align: left;
  min-width: 0;
}

.name {
  display: block;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 两枚中性胶囊跟在肌群行下：一行里至多「次要文字 / 中性胶囊」两个层级；
   wrap 兜窄屏，min-width: 0 让 flex 子项可压缩（配 .body 的 ellipsis 链） */
.pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gap-tight);
  margin-top: var(--sp-4);
  min-width: 0;
}

/* 课程主操作：44×44 是拇指下限。40 的圆在手机上偏小，且它是这张卡唯一
   通往训练的主入口，不该比旁边的行尾图标更难按。 */
.play {
  width: var(--hit-min);
  height: var(--hit-min);
  flex: none;
  border-radius: 50%;
  background: var(--text-1);
  color: var(--bg);
  padding-left: var(--sp-2);
}

.play:disabled {
  opacity: var(--disabled-opacity);
}

.new,
.more {
  width: 100%;
  gap: var(--sp-6);
  border-radius: var(--radius-m);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

.new {
  margin-top: var(--sp-6);
  padding: var(--sp-22) 0;
  background: var(--surface-2);
  color: var(--text-2);
}

.more {
  margin-top: var(--sp-10);
  padding: var(--sp-12) 0;
  background: var(--surface-2);
  color: var(--text-2);
}

.more:active,
.new:active {
  opacity: 0.7;
}
</style>
