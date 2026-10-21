<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import GlassFilter from '@/components/common/GlassFilter.vue'
import ProgressiveBlur from '@/components/common/ProgressiveBlur.vue'
import { usePressGlow } from '@/composables/usePressGlow'
import { useScrolled, useScrollCollapsed } from '@/composables/useScrolled'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { liquidGlass, perfDegraded } from '@/system/perf'

/** iOS 大标题页头；back = 二级页返回键（有来路则返回，直链进入回首页）。
 *  compact = 导航条模式（对话/工具页）：单行小标题、按钮居中，把纵向空间留给内容。
 *
 *  页头固定：sticky 顶住滚动容器（移动端滚文档、桌面滚 .desk-main，同一份 CSS 两边
 *  都成立；若用 fixed，桌面壳里会跑到导航轨与信息栏底下）。页面一滚起来就在背后压
 *  一层渐进模糊遮罩（ProgressiveBlur）——内容从模糊里淡出，而不是被一条硬边切掉。
 *  掉帧降级（system/perf）时同位置换成底色遮罩，不做 backdrop-filter。
 *
 *  两个安全区变量，默认值就是「整页滚动」这一最常见形态；页头被放进独立滚动容器
 *  （如 AI 页的消息区）时由使用方覆写：
 *  - `--ph-stick`：粘住的纵向偏移。默认 `--safe-top`——状态栏区域不属于任何滚动容器，
 *    页头粘在视口顶（0）会直接压进手机顶部消息栏，必须让开这段；
 *  - `--ph-up`：遮罩向上铺出的量。默认与 `--ph-stick` 相同：粘在 safe-top 时遮罩正好
 *    铺满状态栏那条，滚上去的内容在那一段里也是糊的。 */
defineProps<{
  /** 页标题。**可为空** —— 空则整块标题区不渲染（如 AI 会话页，见模板注释） */
  title?: string
  subtitle?: string
  back?: boolean
  compact?: boolean
}>()

const router = useRouter()
const root = ref<HTMLElement | null>(null)
const scrolled = useScrolled(root)
/** 丰富档的滚动边缘：向下滚收起、向上滚还原（判定与理由见 composables/useScrolled） */
const collapsed = useScrollCollapsed(root)

/** 动作区折射壳的滤镜 id：与返回键那份（glass-filter-header，固定 38×38）各一份 ——
 *  壳的尺寸随圆钮数量变，得让它自己量、自己烘（见下方模板与 .ph-bar 的注释）。 */
const actionFilterId = `glass-filter-actions-${Math.random().toString(36).slice(2, 12)}`
/** 壳的取样方式：折射可用时是 url()，否则 none（壳本身不画任何东西，只决定背后被采样几次） */
const barStyle = computed(() => ({ '--ph-bar-filter': liquidGlass.value ? `url(#${actionFilterId})` : 'none' }))

/** 粗指针（手机 / 平板）＝ 合成预算最紧的一档：渐进模糊收成 2 层。
 *  实测（2026-10-05 主页滚动卡顿报告，scripts/.tmp-perf-attribute.mjs，**滚动态**）：
 *  5 层在软件合成下每帧 5.15ms，成本随层数线性，2 层 ≈ 2ms（复测粗指针滚动态
 *  4.28ms/帧，基线 6.9）。94px 高的条带靠 mask 渐变补平滑，两段看不出分层；
 *  桌面细指针保持 5 层原画质。 */
const coarsePointer = useMediaQuery('(pointer: coarse)')

/** 按压定向光晕（丰富档）：页头这两处圆钮是控制层里按得最多的。
 *  `.hdr-btn` 在各页的插槽里（挂类不写样式，见 docs/ARCHITECTURE.md 的页头按钮规范），
 *  所以这里按 selector 就近匹配，而不是靠它们自己挂一个标记类。 */
usePressGlow(root, '.back, .hdr-btn')

function goBack(): void {
  const state: unknown = window.history.state
  if (state !== null && typeof state === 'object' && 'back' in state && state.back != null) {
    router.back()
  } else {
    void router.replace('/')
  }
}
</script>

<template>
  <header ref="root" class="page-header" :class="{ compact, scrolled, collapsed, lite: perfDegraded }">
    <!-- 页头圆钮的折射滤镜定义（与 Dock / 悬浮条同一份管线，规格固定 38×38 所以按静态
         尺寸烘一次；.back 与各页的 .hdr-btn 共用这一张贴图）。只在折射可用时挂：
         高画质下这几颗圆钮是**普通玻璃**（半透明底 + blur，没有折射），流畅档是实底，
         两种都用不上这段滤镜 -->
    <GlassFilter
      v-if="liquidGlass"
      id="glass-filter-header"
      :w="38"
      :h="38"
      :radius="19"
      :enabled="true"
    />

    <!-- 遮罩：只在页面滚起来后显形（顶部没有内容经过时不该出现任何底色） -->
    <div class="ph-mask" aria-hidden="true">
      <!-- 超高 + 已滚起时的底色垫层（苹果的「硬边缘」变体）：模糊之下再压一层画布色的
           渐变，标题的落点更明确。垫在模糊**之下**（DOM 在前 = 先画），所以它是
           "内容褪成底色、再被糊开"，而不是"在模糊上又糊一层色"。纯渐变，零合成成本。 -->
      <span class="ph-scrim" />
      <!-- 渐进模糊：粗指针（手机 / 平板）收 2 层 × 4px —— 实测 5 层每帧 5.15ms 且
           opacity:0 也不会被合成器剔除（见下方 coarsePointer 的注释与 useMediaQuery）；
           桌面细指针保留 5 层 × 1.6px 原画质。 -->
      <ProgressiveBlur
        v-if="!perfDegraded"
        direction="down"
        :layers="coarsePointer ? 2 : 5"
        :step="coarsePointer ? 4 : 1.6"
      />
    </div>

    <slot name="lead" />
    <button v-if="back" class="back" aria-label="返回" @click="goBack">
      <ChevronLeft :size="21" :stroke-width="2.4" />
    </button>
    <!-- 标题块：**title 为空时整块不渲染**（占位交给下面的 spacer）。
         有的页面不需要标题 —— 比如 AI 会话页：顶栏左边一颗「历史」、右边两颗动作，
         中间再塞两个字的「AI」会变成一个悬空的小标签，与两侧 38px 圆钮的重量对不上。
         页面身份由内容与 Dock 的选中态表达，不必靠顶上那两个字。 -->
    <div v-if="title || subtitle" class="flex-1">
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <span v-else class="flex-1" />
    <!-- 动作区的**折射壳**：里面每颗圆钮各自挂 url() 时，一次滚动要为 N 次独立的背景
         滤镜付钱（实测课表页三颗占 0.36ms/帧，而超高相对高画质的全部增量只有 0.4ms 上下）。
         相邻圆钮并成一壳、**只挂一次** url()，圆钮自己的材质（底 / 受光边 / 光学内层 / 命中区）
         一概不动 —— 变的只是「背后被采样几次」。壳的尺寸由 GlassFilter 量自己，圆钮加减
         （选课页的批量态、各页不同的动作数）都自动跟上。 -->
    <span v-if="$slots.action" class="ph-bar" :style="barStyle">
      <GlassFilter v-if="liquidGlass" :id="actionFilterId" />
      <slot name="action" />
    </span>
  </header>
</template>

<style scoped>
.page-header {
  /* sticky 而非 fixed：贴住最近滚动容器的顶。滚动容器在两种壳下不同
     （移动端是文档、桌面是 .desk-main），sticky 两个都对，fixed 会跑偏。
     z-index 除了抬层级，还负责建立层叠上下文——遮罩用 -1 沉到页头内容背后，
     有上下文它才不会被甩到页面内容下面去。 */
  --ph-stick: var(--safe-top);
  --ph-up: var(--safe-top);
  position: sticky;
  top: var(--ph-stick);
  z-index: 30;
  display: flex;
  align-items: flex-end;
  /* 标题块与操作区是页头上的两个同级大组，分开 16（无边界的小控件才用 8）。
     组内圆钮之间同样 16（.ph-bar），整行节奏一致。 */
  gap: var(--gap-lg);
  /* 横向 0：左右 16 已由页面自己的 --page-pad-x 给出，页头再补 2px 只会让
     30px 的标题比卡片容器左缘偏出去 2px，标题与卡片就不在同一条竖线上了。
     纵向 8 是吸顶条的呼吸（页面顶部留白由 --page-pad-top 那一层负责，页头不能重复吃）；
     下缘 16 = 「页头与首个卡片之间 16」这条规范，从前是 14，首卡会被顶上一点。 */
  padding: var(--sp-8) 0 var(--sp-16);
  /* 遮罩在页头下缘之外多铺一段，模糊才有化开的空间 */
  --ph-tail: var(--sp-16);
}

/* 渐进模糊遮罩（模糊本身见 ProgressiveBlur 组件）：
   - 向上多铺 --ph-up：页头粘在 safe-top 时正好盖住状态栏那条（桌面为 0，等于没铺）；
     页头被放进独立滚动容器时（AI 页）由使用方覆写成容器内的可裁切余量
   - 向下多铺 --ph-tail：模糊在页头下缘之外收尾，不留硬边
   - 左右铺回页面横向内边距（--ph-bleed 可被页面覆写）：把整帧宽一起盖住，
     否则两侧会露出未模糊的窄条 */
.ph-mask {
  position: absolute;
  top: calc(-1 * var(--ph-up));
  left: calc(-1 * var(--ph-bleed, var(--page-pad-x)));
  right: calc(-1 * var(--ph-bleed, var(--page-pad-x)));
  bottom: calc(-1 * var(--ph-tail));
  z-index: -1;
  pointer-events: none;
}

/* 模糊层的显隐只能挂在「层自己」身上：容器一旦 opacity<1 就成为 backdrop-filter 的
   backdrop root，过渡那 0.2 秒里模糊根本不渲染，结束后才「啪」地弹出来（看着像闪现）。
   详见 ProgressiveBlur 的文件头。 */
.ph-mask :deep(.pblur span) {
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
}

.page-header.scrolled .ph-mask :deep(.pblur span) {
  opacity: 1;
}

/* 未滚起时整条 backdrop-filter 摘掉：顶端时背后只有页面底色，糊与不糊像素相同，
   顶端的合成成本归零；回到顶部的切换发生在 opacity≈0 的那一帧，肉眼不可见。 */
.page-header:not(.scrolled) .ph-mask :deep(.pblur span) {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* 降级档（system/perf 判定掉帧）：不做毛玻璃，改用「画布底色 → 透明」的渐变遮罩。
   底色是 --bg 而非 --surface：遮罩压的是页面画布，不是卡片。
   这条是纯渐变背景、不涉及 backdrop-filter，照旧用容器自身的透明度淡入。 */
.page-header.lite .ph-mask {
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
  background: linear-gradient(to bottom, var(--bg) 0%, var(--bg) 55%, transparent 100%);
}

.page-header.lite.scrolled .ph-mask {
  opacity: 1;
}

/* 超高 / 极致档的底色垫层（苹果的「硬边缘」变体）：只有这两档才有 —— 它属于材质档位，
   不是动效（动效是下面那两条 scale）。不加 --bg 垫层时，页头压的是"内容被糊开"，
   标题与内容的分离靠模糊本身；加一层同色渐变后，标题的落点更明确。
   显隐只能挂在这层自己身上，与 .pblur 同一条理由（祖先一旦 opacity<1 就成了
   backdrop root，子层的模糊整段失效）。 */
.ph-scrim {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
  background: linear-gradient(to bottom, var(--bg) 0%, transparent 72%);
}

html:is([data-perf='ultra'], [data-perf='extreme']) .page-header.scrolled .ph-scrim {
  opacity: 0.6;
}

/* ---------- 丰富档：滚动边缘（苹果）----------
   向下滚时页头缩一档、把注意力让给内容；向上滚立刻还原 —— 判断的是**方向**不是位置，
   理由见 composables/useScrolled 的 useScrollCollapsed。

   两处刻意的选择：
   · 只动 scale，不动字号/内边距 —— 改布局属性会让整页在滚动中重排，那是掉帧的直接来源；
     用独立属性 `scale`（不是 transform）是为了与按压反馈**并存**：圆钮的
     `:active { transform: scale(0.92) }` 走 transform，两个属性互不覆写，
     缩着的状态下按下去照样有挤压反馈。
   · transform-origin 落在左下：标题与圆钮都是自左往右长出来的，从左边缩才不会
     "整体往左挪一格"。 */
html[data-motion='rich'] .page-header h1,
html[data-motion='rich'] .page-header p,
html[data-motion='rich'] .page-header .back,
html[data-motion='rich'] .page-header :slotted(.hdr-btn),
/* 动作区壳跟着一起缩：壳是这一组圆钮同用的那次背景采样，壳不缩就会出现"钮缩了、
   折射边没缩"的一道错位。放进来之后整组当一颗缩。 */
html[data-motion='rich'] .page-header .ph-bar {
  transform-origin: left bottom;
  transition: scale var(--dur-base) var(--ease-out);
}

html[data-motion='rich'] .page-header.collapsed h1,
html[data-motion='rich'] .page-header.collapsed p,
html[data-motion='rich'] .page-header.collapsed .back,
html[data-motion='rich'] .page-header.collapsed .ph-bar {
  scale: 0.94;
}

/* 壳已在缩，壳里的圆钮就不要再各自缩一次 —— 两层 scale 会叠成 0.883，整组比标题还小。
   摘掉的是圆钮那份，壳那份留着（整组一起缩）。 */
html[data-motion='rich'] .page-header.collapsed .ph-bar > :slotted(.hdr-btn) {
  scale: 1;
}

.back {
  position: relative;
  width: 38px;
  height: 38px;
  flex: none;
  /* 与标题基线的错位微调：页头是 flex-end 对齐，标题行盒比圆形钮低一点点，
     抬 4px（原来是 3px 的手感值，进不了 4/8 体系）刚好让钮的视觉中心落在标题腰线上 */
  margin-bottom: var(--sp-4);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 返回键与页头图标钮：视觉尺寸不动，命中区撑到 44×44。
   38 是这些圆钮的视觉规格，不该为了触控改掉；但 44 是拇指的下限，
   而返回是每个二级页**唯一**的退路（图标钮则常常是这一页唯一的设置入口）。
   横向外扩 3px（(44 - 38) / 2）：同一排按钮间隔 16px，热区之间还留着 10px，不会互相压住。 */
.back::after,
.page-header :slotted(.hdr-btn)::after {
  content: '';
  position: absolute;
  inset: -3px;
}

/* 页头图标按钮统一规范（lead / action 插槽内使用 class="hdr-btn"）：
   与返回键同尺寸同材质；accent 变体留给正向 CTA（如“添加”）。 */
.page-header :slotted(.hdr-btn) {
  position: relative;
  width: 38px;
  height: 38px;
  flex: none;
  /* 与返回键同一档基线微调（理由见 .back） */
  margin-bottom: var(--sp-4);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.page-header :slotted(.hdr-btn:active) {
  transform: scale(0.92);
}

/* 文字胶囊变体（`.hdr-btn.pill`）：38px 圆钮只装得下图标，而有的入口本身就是一句话
   —— 文件页右侧那颗「空间总览 · 总大小」。放宽宽度、内容自己撑，材质/玻璃/按压反馈
   一律沿用上面那套 .hdr-btn 规则（变体不复制材质，只改几何与字号）。 */
.page-header :slotted(.hdr-btn.pill) {
  width: auto;
  min-width: 38px;
  padding: 0 var(--pad-inline);
  gap: var(--sp-6);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 动作区折射壳（见模板里那段注释）：与页头同一套横向节奏（gap 16、底部对齐、不伸长），
   所以包进来之后**一个像素都不挪**。壳没有底、没有命中区 —— 它只是背后那次采样的承载。 */
.ph-bar {
  display: flex;
  align-items: flex-end;
  /* 每颗圆钮都自带一块玻璃盘（有可见边界），组内按「有明显边界 → 16」给 */
  gap: var(--gap-lg);
  flex: none;
  min-width: 0;
}

/* 丰富档：按压定向光晕（位置来自 composables/usePressGlow，显隐交给 :active）。
   这两处圆钮走 background-image 那一层，不用 ::after —— 它们的 ::after 已经被
   44×44 的命中区占掉了（见上面的 .back::after）。accent 变体也一并点亮：
   它压的是主色实底，一层白光晕正是"按下去发光"该有的样子。 */
html[data-motion='rich'] .page-header .back:active,
html[data-motion='rich'] .page-header :slotted(.hdr-btn):active {
  background-image: radial-gradient(
    circle 70px at var(--gx, 50%) var(--gy, 50%),
    var(--glass-specular),
    transparent 70%
  );
}

/* ---------- 高画质及以上：页头的圆钮也变成玻璃盘 ----------
   一份 :slotted 改动覆盖全部页面的图标钮（各页只挂 hdr-btn 类，不各自写样式 ——
   见 docs/ARCHITECTURE.md 的页头按钮规范），这是"玻璃铺到全部组件"里性价比最高的一处。

   分两档落地：
   · 高画质：玻璃盘 = 半透明底 + blur + 光学内层（就是下面这一条）。这一档没有折射，
     但圆钮仍要是玻璃 —— 与 Dock / 卡片同一份材质，不能只剩它们两颗是实底白圆
     （用户要求：不启用折射也要把玻璃的其余效果开起来）；
   · 超高 / 极致：**采样方式换成折射**（再往下的两条：返回键自己一片、动作区共一壳）。

   **超高起要的是真折射，不是又一层 backdrop-filter: blur**（2026-09-25 修）：这一档叫
   「液态玻璃」，而只挂 blur 的那一版在超高下与高画质档读起来是同一层糊 —— 名字在，材质不在。
   位移贴图与滤镜链来自 common/GlassFilter.vue，与底部 Dock / 沉浸层控制层**同一份实现**。

   曾经不这么做的理由是「38px 的圆上折射带只有一两像素、还要压着页头那层渐进模糊」——
   实测下来这两条都不成立：折射带窄是**参数**问题（38px 用同一组出厂参数照样看得见），
   而它压在渐进模糊之上只意味着「折射的是一层已经糊开的底」—— 那正是玻璃压在毛玻璃上
   的正常样子，不是画不出来。

   底薄了会不会读不清：圆钮坐落在页头正上方，背后是已经糊过一遍的内容；亮色主题下
   页面本身是浅的，档位给出的半透明白（+ 折射）合成出来仍接近白。全屏暗场页面（跑步）不走
   PageHeader，所以不存在"白底压暗图"的组合。 */
html[data-perf]:not([data-perf='low']) .page-header .back,
html[data-perf]:not([data-perf='low']) .page-header :slotted(.hdr-btn:not(.accent)) {
  background: var(--glass-fill);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  /* 光学层与 GlassSurface 的 .glass 对齐（外缘层 / 内顶高光 / 上缘焦散都在）——
     页头的玻璃盘与 Dock 的玻璃块要是同一套材质，不能一处厚一处薄。
     高画质档 halo / rim-2 / caustic 这三个令牌还是透明的，所以那几层自动缺席，
     剩下的底 + 内顶高光就是这一档的玻璃。 */
  box-shadow:
    var(--glass-shadow),
    var(--glass-halo),
    inset 0 1px 0 var(--glass-rim-hi),
    inset 0 -1px 0 var(--glass-rim-lo),
    inset 0 14px 22px -16px var(--glass-sheen),
    inset 0 0 0 1px var(--glass-rim-2),
    inset 0 1px 10px -2px var(--glass-caustic);
}

/* 折射可用（内核认 url() 滤镜 + 用户选了这两档，即 data-glass 不是 off）时，
   把上面那份模糊整条换成位移滤镜 —— 与 GlassSurface 的折射分支同一条做法：
   折射生效时不再叠 blur（url() 与 blur 同挂会让位移算在一层糊过的底上，白花）。
   全程序只有一条链，所以这里判的就是那一个值（从前还有个 'full'）。

   **选择器必须压过上面那条模糊规则**（2026-10-03）：模糊那条带 :not([data-perf='low'])
   （0,5,1），而 data-glass='collapsed' 单独只有 (0,4,1) —— 不加这一截，超高 / 极致下
   模糊会盖住折射，页头圆钮就退回"高画质那层糊"了。data-glass='collapsed' 本就只在
   超高 / 极致出现（low 的管线恒为 off），所以 [data-perf]:not([data-perf='low'])
   在这里只是把权重顶到 (0,6,1)、确保折射永远赢，不改变匹配范围。

   返回键仍自己一片（它左边没有别的圆钮可合并），动作区的圆钮走下面 .ph-bar 那条 ——
   一次滚动只采样一次，而不是 N 次。 */
html[data-glass='collapsed'][data-perf]:not([data-perf='low']) .page-header .back {
  backdrop-filter: url(#glass-filter-header) saturate(var(--glass-sat));
  -webkit-backdrop-filter: url(#glass-filter-header) saturate(var(--glass-sat));
}

/* ---------- 动作区的折射壳：相邻圆钮共用一次背景滤镜 ----------
   壳自己**什么都不画**（没有底、没有描边、没有命中区），只负责「背后被采样几次」：
   里面每颗圆钮仍画自己的玻璃盘（底 / 受光边 / 光学内层 / 44×44 命中区一概不动），
   变的只有取样方式从「每颗一次」变成「整个动作区一次」。

   :has() 是这里的净网：插槽里只有 accent 主操作钮 或 根本不是玻璃钮（记账的月份导航、
   选课的批量态）时，壳不挂滤镜 —— 没有圆钮要为它付钱，也不会把一颗实底钮背后的
   页面白白折射一遍。Chromium 才认 backdrop-filter: url()，所以这条门只用在这一条路上。

   --ph-bar-filter 由脚本写（折射可用时是该壳自己的滤镜 id，否则 none），这里不硬编码 id ——
   每个页头实例的壳各自一份 GlassFilter，同尺寸的贴图按 URL 缓存共享（见 GlassFilter）。 */
html[data-glass='collapsed'][data-perf]:not([data-perf='low']) .page-header .ph-bar:has(> .hdr-btn:not(.accent)) {
  backdrop-filter: var(--ph-bar-filter) saturate(var(--glass-sat));
  -webkit-backdrop-filter: var(--ph-bar-filter) saturate(var(--glass-sat));
}

/* 壳里的圆钮退掉自己那份滤镜：壳已经在折射了，圆钮再挂一层就是「url() 叠在自己父亲的
   url() 上」—— 位移会算在一层已经被位移过的底上，白花一次全条采样。材质（底 / 光学层）
   仍由上面那条高画质规则给，这里只摘 backdrop-filter。
   权重 (0,8,1) 压过上面两条 url() 规则 (0,7,1)，且排在其后，双保险。 */
html[data-glass='collapsed'][data-perf]:not([data-perf='low']) .page-header .ph-bar > :slotted(.hdr-btn:not(.accent)) {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* 系统要求「减弱透明度」时退回实底 —— 与 .glass-surface 的退化同一条语义
   （排在上面两条之后、同权重，所以它赢：折射与模糊一起关掉） */
@media (prefers-reduced-transparency: reduce) {
  html[data-perf]:not([data-perf='low']) .page-header .back,
  html[data-perf]:not([data-perf='low']) .page-header :slotted(.hdr-btn:not(.accent)) {
    background: var(--surface);
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    box-shadow: var(--shadow-card);
  }
}

.page-header :slotted(.hdr-btn.accent) {
  background: var(--accent);
  color: var(--on-accent);
}

h1 {
  font-size: var(--fs-large-title);
  font-weight: var(--fw-bold);
  letter-spacing: -0.6px;
  /* 展示级标题用最紧的一档行高（--lh-display 1.16），30px Bold 再多半行就散 */
  line-height: var(--lh-display);
}

/* 主次文本上下 2：标题与副标题是一对，不该被行高撑出空隙 */
p {
  margin-top: var(--gap-text);
  font-size: var(--fs-footnote);
  color: var(--text-2);
  font-weight: var(--fw-medium);
}

/* 紧凑导航条：17px 单行标题（iOS 导航条规格），图标按钮改为垂直居中 */
.page-header.compact {
  align-items: center;
  /* 导航条模式只保留上下 4 / 12 的呼吸：它把纵向空间让给内容，
     横向同样交给页面的 --page-pad-x（见上） */
  padding: var(--sp-4) 0 var(--sp-12);
}

.page-header.compact h1 {
  font-size: var(--fs-headline);
  letter-spacing: -0.3px;
  line-height: var(--lh-title);
}

.page-header.compact .back,
.page-header.compact :slotted(.hdr-btn) {
  margin-bottom: 0;
}
</style>
