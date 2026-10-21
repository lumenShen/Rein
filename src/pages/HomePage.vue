<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import PageHeader from '@/components/layout/PageHeader.vue'
import HomeCanvas from '@/components/home/HomeCanvas.vue'
import HomeFooter from '@/components/home/HomeFooter.vue'
import HomeTodoFeed from '@/components/home/HomeTodoFeed.vue'
import IntakeOverview from '@/components/nutrition/IntakeOverview.vue'
import ProgramStatusCard from '@/components/program/ProgramStatusCard.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import BentoOverview from '@/components/workbench/BentoOverview.vue'
import DaySpine from '@/components/workbench/DaySpine.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
import { useFeaturesStore } from '@/stores/features'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import { fmtDateCn, todayStr } from '@/utils/date'
import { weightTrendAlert } from '@/utils/weightTrend'

/** 主页。桌面端（≥ DESKTOP_MIN）：工作台双视图（便当总览 / 一日脊柱）。
 *  移动端：状态条 + 一日时间线 + 页脚动作区——主页即今天。 */
const router = useRouter()
const today = todayStr()
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

/** 桌面主页视图模式，localStorage 持久化 */
const VIEW_OPTIONS = [
  { value: 'bento', label: '便当总览' },
  { value: 'spine', label: '一日脊柱' },
] as const
type HomeView = (typeof VIEW_OPTIONS)[number]['value']

const view = ref<HomeView>('bento')
try {
  const saved = localStorage.getItem('rein.homeView.v1')
  if (saved === 'spine' || saved === 'bento') view.value = saved
} catch {
  /* 忽略不可用的本地存储 */
}
watch(view, (v) => {
  try {
    localStorage.setItem('rein.homeView.v1', v)
  } catch {
    /* 同上 */
  }
})

const nutrition = useNutritionStore()
const program = useProgramStore()
const features = useFeaturesStore()

/** 摄入总览与营养数据属「营养」模块：关掉之后数据也不拉（不产生请求）、整条也不渲染 */
const nutritionOn = computed(() => features.isEnabled('nutrition'))

onMounted(() => {
  if (nutritionOn.value) {
    void nutrition.loadSummary(today)
    void nutrition.loadProfile()
    void nutrition.loadMetrics(10)
  }
  // 健康方案被关掉时不必拉方案数据（插件层的收益之一：关掉的模块不产生请求）
  if (features.isEnabled('program')) void program.load()
})

/* ---- 体重趋势异常：连续异常时自动提醒复盘（主页卡片，可忽略）。
       提醒的落点是方案页复盘，方案模块关掉时整卡不出现 ---- */
const weightDismissed = ref(false)
const weightAlert = computed(() =>
  features.isEnabled('program')
    ? weightTrendAlert(nutrition.metrics, nutrition.profile?.goal ?? 'keep', nutrition.profile?.weightKg ?? null)
    : null,
)

/* ---- 移动端页脚：课程条 / 吃 / 练 / 专注·钱 / 工具，见 HomeFooter.vue。
       成员仍来自插件层，就地动作与三张抽屉都在那里面 —— 这页只负责挂。 ---- */
</script>

<template>
  <div class="page" :class="{ 'desk-home': isDesktop }">
    <!-- ============ 桌面工作台：便当总览 / 一日脊柱 ============ -->
    <template v-if="isDesktop">
      <PageHeader title="今天" :subtitle="fmtDateCn(today)">
        <template #action>
          <SegmentedControl v-model="view" :options="[...VIEW_OPTIONS]" />
        </template>
      </PageHeader>
      <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
      <div class="rubber-layer" data-rubber-content>
        <!-- 便当总览 / 一日脊柱同属「看今天」，切换时整块淡入而不是硬换 -->
        <Transition name="fade">
          <BentoOverview v-if="view === 'bento'" />
          <DaySpine v-else />
        </Transition>
      </div>
    </template>

    <!-- ============ 移动端：状态条 + 一日时间线 + 动作堆 ============ -->
    <template v-else>
      <PageHeader title="今天" :subtitle="fmtDateCn(today)" />

      <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
      <div class="rubber-layer" data-rubber-content>
        <!-- 摄入总览：挂卡片壳（.card 自带的 20px 内边距与材质），
             这样它与「今日画布」等卡片落在同一条竖线上；贴着页面底色时整块会散掉。 -->
        <button v-if="nutritionOn" class="card strip pressable" aria-label="摄入总览详情" @click="router.push('/nutrition')">
          <IntakeOverview />
        </button>

        <!-- 方案状态卡：执行期的常驻落点（今天练什么/走到哪/该复盘了），关掉模块整卡不出现 -->
        <ProgramStatusCard v-if="features.isEnabled('program')" />

        <HomeCanvas :date="today" />

        <!-- 体重趋势异常提醒：出现/忽略都用栅格壳收高度，卡片自身只淡出 -->
        <Transition name="warn">
          <div v-if="weightAlert && !weightDismissed" class="warn-wrap">
            <!-- 裸壳：卡片自带 padding，让它直接当轨道项的话 0fr 会剩一截卡内边距 -->
            <div class="warn-inner">
              <section class="card warn-card">
                <p class="t-2 warn-txt">{{ weightAlert.reason }}</p>
                <div class="row" style="gap: var(--gap-sm); margin-top: var(--gap-md)">
                  <button class="warn-go pressable" @click="router.push('/program')">去复盘</button>
                  <button class="warn-later pressable" @click="weightDismissed = true">知道了</button>
                </div>
              </section>
            </div>
          </div>
        </Transition>

        <!-- 页脚动作区：课程条 / 吃 / 练 / 专注·钱 / 工具（HomeFooter 持有抽屉与就地动作） -->
        <HomeFooter :date="today" />

        <!-- 全部待办信息流：未完成在前（未安排→逾期→今天→未来）、已完成沉底；
             拉到底边附近才逐批追加下一批（取数与渲染的说明在 HomeTodoFeed.vue） -->
        <HomeTodoFeed :today="today" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.page {
  /* 顶部 10 是「页头自带内距 + 页头粘顶」这套全站节奏的一格（--page-pad-top 36 目前
     全库没有页面在用，单改这一页会让主页页头顶得比别人高）。左右与底部走页面令牌。 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 桌面工作台列：便当总览与一日脊柱共用同一条 1240px 列（居中）。
   列宽比卡片流页的 --desk-content(1040) 宽一档 —— 它是「看今天」的画布，
   而每个工作台视图内部再自己收口（bento 的 12 栏 / 脊柱的 900px 时间轴）。
   页头挂在同一个 .page 盒上，随列一起居中；--ph-bleed 跟着横向内边距走，
   否则页头遮罩两侧会露出没被遮住的窄条。 */
.page.desk-home {
  max-width: var(--frame-max-wide);
  margin-inline: auto;
  /* 桌面：顶部与卡片流页同档（--page-pad-top），底部留大区块一格。 */
  padding: var(--page-pad-top) var(--desk-gutter) var(--sp-48);
  --ph-bleed: var(--desk-gutter);
}

/* 页头那枚「便当总览 / 一日脊柱」是**内容宽**控件（分段零横向内距），实测每段
   52px 正好等于 4 个 13px 汉字 —— 选中胶囊的边就压在字的笔画上，整枚控件读成
   「便当总览一日脊柱」一串。给两侧各留一格呼吸：控件长到 ~156px，页头右侧
   还有 500px 余量，不会挤到标题。只作用于主页这一处调用点。 */
.page.desk-home :deep(.seg-item) {
  /* 分段项左右补一格 12（--pad-inline），让「便当总览」四个字不贴选中胶囊的边 */
  padding: var(--sp-6) var(--pad-inline);
}

/* 摄入总览：整条是按钮、壳交给 .card（内边距 20px 与全站卡片一致，别在这里再叠一层），
   这里只管「占满宽度、左对齐」——按钮默认居中文本，得掰回左对齐。
   与下方 HomeCanvas 的间距由全局 `.card + .card`（14px）负责。 */
.strip {
  display: block;
  width: 100%;
  text-align: left;
}

/* 体重趋势提醒 */
.warn-card {
  background: var(--danger-soft);
}

.warn-txt {
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
}

/* 提醒卡里的两枚动作：常规按钮 40（--control-md）+ 伪元素补到 44 命中区。
   从前只有 8px 上下内距、实际高约 37px，拇指在卡边点不稳。 */
.warn-go,
.warn-later {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-md);
  padding: var(--gap-sm) var(--gap-lg);
  border-radius: var(--radius-full);
  font-size: var(--fs-subhead);
}

.warn-go::after,
.warn-later::after {
  content: '';
  position: absolute;
  inset: -2px 0;
  border-radius: var(--radius-full);
}

/* 白字压 --danger(#ff3b30) 实测只有 3.55:1 —— 14px 粗体够不着 4.5:1 的门槛。
   --danger-strong 是「危险色的文字/实底档」，压白字 5.87:1，肉眼仍是同一支红。 */
.warn-go {
  background: var(--danger-strong);
  color: var(--on-accent);
  font-weight: var(--fw-bold);
}

.warn-later {
  background: var(--surface);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

/* 页脚动作区（课程条 / 吃 / 练 / 专注·钱 / 工具）的样式在 HomeFooter.vue 里 */

/* 桌面视图淡入淡出：内容整体更换，只走不透明度，进出场同向 */
.fade-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.fade-enter-from {
  opacity: 0;
}
.fade-leave-active {
  transition: none;
}

/* 体重趋势提醒：0fr↔1fr 壳收高度，卡片自身淡出；出现按入场时长、忽略走退场时长。
   轨道项（.warn-inner）必须是裸壳：卡片的 padding 画在它身上，0fr 就收不到 0，
   折叠后会留下一截卡内边距高的缝 */
.warn-wrap {
  display: grid;
  grid-template-rows: 1fr;
  /* 与上方卡片同档卡间距（.card + .card 的 12），过渡也要的是同一个值 */
  margin-top: var(--gap-md);
}

.warn-inner {
  min-height: 0;
  overflow: hidden;
}

.warn-enter-active {
  transition:
    grid-template-rows var(--dur-base) var(--ease-standard),
    margin-top var(--dur-base) var(--ease-standard);
}

.warn-leave-active {
  transition:
    grid-template-rows var(--dur-fast) var(--ease-standard),
    margin-top var(--dur-fast) var(--ease-standard);
}

.warn-enter-from,
.warn-leave-to {
  grid-template-rows: 0fr;
  margin-top: 0;
}

.warn-enter-active > .warn-inner > .card,
.warn-leave-active > .warn-inner > .card {
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.warn-enter-from > .warn-inner > .card,
.warn-leave-to > .warn-inner > .card {
  opacity: 0;
}
</style>
