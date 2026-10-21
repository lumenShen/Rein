<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Plus } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PlanSeedUpgradeBanner from '@/components/exercise/PlanSeedUpgradeBanner.vue'
import { usePlanStore } from '@/stores/plan'
import { estimatePlanMinutes, planTypeLabel } from '@/utils/plan'

/** 全部课程：训练课程的管理入口（列表 → 详情/编辑/新建）。 */
const router = useRouter()
const planStore = usePlanStore()

onMounted(() => {
  void planStore.ensureLoaded()
})

function fmtUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return '未使用'
  const ms = Date.now() - Date.parse(lastUsedAt.includes('T') ? lastUsedAt : `${lastUsedAt.replace(' ', 'T')}Z`)
  if (Number.isNaN(ms)) return '未使用'
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) return '今天用过'
  if (days === 1) return '昨天用过'
  if (days < 30) return `${days} 天前用过`
  return '很久未用'
}
</script>

<template>
  <div class="page">
    <PageHeader back title="全部课程" subtitle="最近使用的排在前面" />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 内置课程新版本：不再自动覆盖，交给用户三选一 -->
    <PlanSeedUpgradeBanner />

    <button class="new row center" @click="void router.push('/sports/plans/new/edit')">
      <Plus :size="18" /> 新建课程
    </button>

    <!-- d-full：课程清单这张卡通栏，多栏摊到卡**内部**去（理由见样式里的桌面段） -->
    <section class="card d-full plans-card">
      <EmptyState
        v-if="planStore.loaded && planStore.plans.length === 0"
        :icon="Plus"
        title="还没有训练课程"
        hint="点上方「新建课程」创建一个"
      />
      <ul v-else class="list d-list">
        <li v-for="p in planStore.plans" :key="p.id">
          <button class="row item" type="button" @click="void router.push(`/sports/plans/${p.id}`)">
            <div class="flex-1">
              <p class="name">{{ p.name }}</p>
              <!-- 时长是这一行的主角；类别兜底与动作数是次要信息，用竖线分开层级 -->
              <p class="meta">
                <b class="mins num">约 {{ estimatePlanMinutes(p) }} 分钟</b>
                <span class="vsep" aria-hidden="true">｜</span>
                <span class="msub">{{ p.subtitle || '自定义课程' }} · <span class="num">{{ p.exercises.length }}</span> 个动作</span>
              </p>
            </div>
            <div class="col right">
              <span class="type">{{ planTypeLabel(p.workoutType) }}</span>
              <span class="used num">{{ fmtUsed(p.lastUsedAt) }}</span>
            </div>
            <ChevronRight :size="16" class="chev" />
          </button>
        </li>
      </ul>
    </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.new {
  width: 100%;
  /* 与下方课程卡之间 12（卡片间距），原来 14 让按钮像悬在两组之间。 */
  margin-bottom: var(--gap-md);
  gap: var(--sp-6);
  padding: var(--sp-14) 0;
  border-radius: var(--radius-l);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: var(--fw-bold);
  box-shadow: var(--shadow-float);
}

.item {
  width: 100%;
  /* 课程条目是双行行（名字 + 时长/动作数）：行高统一 64（--row-h-double），
     条目再多也齐平，分隔线之间的节奏才稳定。 */
  min-height: var(--row-h-double);
  gap: var(--gap-md);
  padding: var(--sp-12) 0;
  text-align: left;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.name {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.meta {
  display: flex;
  align-items: baseline;
  gap: var(--gap-tight);
  min-width: 0;
  /* 主次文本上下 2（--gap-text）：名字与说明是一组，原来 4 读起来分成两段。 */
  margin-top: var(--gap-text);
  color: var(--text-3);
  font-size: var(--fs-caption);
}

/* 时长作主角：一屏一个主数值（title3 + 等宽 + 主文字档） */
.mins {
  flex: none;
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
  color: var(--text-2);
}

/* 层级分隔符：主值与次要信息之间用竖线，不用「·」 */
.vsep {
  flex: none;
  color: var(--text-3);
}

.msub {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.right {
  align-items: flex-end;
  flex: none;
  gap: var(--gap-text);
}

/* 计划类型签。虽然是「哪一类」的标签，但它逐行重复出现，不满足类型字章
   「只出现一次」的保留条件：文字走中性色，色相留在 soft 底色块上（色彩配额，STANDARDS §4）。
   单实例的同款字章（ExerciseDetailDrawer 标题行）按字章例外保留。 */
.type {
  font-size: var(--fs-micro);
  font-weight: var(--fw-bold);
  padding: var(--sp-4) var(--sp-8);
  border-radius: var(--radius-xs);
  background: var(--c-exercise-soft);
  color: var(--text-1);
}

.used {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.chev {
  color: var(--text-3);
  flex: none;
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   课程清单一整张卡在桌面上被壳层压成半栏（.page 的直接子级 .card），右半屏空着。
   让**卡片**通栏，把多栏摊到卡内部：课程条只有「名字 + 动作数/时长 + 类型 + 上次使用」，
   480px 外还有一半宽度没用上，两栏读起来正好。

   通栏由模板上的 .d-full 声明。 */

/* 卡内两栏流：课程是**无序**清单（排序按最近使用，没有阅读顺序依赖），
   分栏后「先读完左栏再读右栏」不会读错。用多栏流而不是 grid：
   副标题会换行，条目高度不一，grid 会把同行的两条一起撑高。 */
.desk-main .plans-card .list {
  --d-cols: 2;
}
</style>
