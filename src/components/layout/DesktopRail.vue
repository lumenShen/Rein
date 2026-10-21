<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { House, PanelRight, Search, User } from 'lucide-vue-next'

/** 信息栏的开关状态与命令面板入口都由壳层持有，导航轨只负责显示与转发 */
defineProps<{ inspectorOpen: boolean }>()
const emit = defineEmits<{ 'toggle-inspector': []; 'open-palette': [] }>()

import { useFeaturesStore } from '@/stores/features'
import type { NavContribution } from '@/plugins'
import { MOD } from '@/system/deskShell'

/**
 * 桌面三窗格壳 · 左侧导航轨：替代底部 TabBar，提供一级/常用页直达。
 * 除「总览」与末位的「我」外，条目全部来自插件层（关掉课表模块，这一格就消失）。
 */
const CORE_ITEMS: NavContribution[] = [
  { route: 'home', label: '总览', icon: House, surfaces: ['rail'], order: 0 },
]

const features = useFeaturesStore()
const items = computed(() => [...CORE_ITEMS, ...features.nav('rail')].sort((a, b) => a.order - b.order))

const route = useRoute()
</script>

<template>
  <nav class="rail glass-surface glass-edge-r" aria-label="主导航">
    <!-- 无障碍名与悬停标签同值「回到总览」：读屏 / 语音控制用户按看到的名字找这颗钮
         （WCAG 2.5.3 Label in Name）。与「总览」导航空格在文案上已经区分开 -->
    <button class="logo" aria-label="回到总览" data-label="回到总览" @click="$router.push({ name: 'home' })" />
    <div class="navs col">
      <RouterLink
        v-for="it in items"
        :key="it.route"
        :to="{ name: it.route }"
        class="ric"
        :class="{ on: route.name === it.route }"
        :aria-label="it.label"
        :data-label="it.label"
      >
        <component :is="it.icon" :size="21" :stroke-width="route.name === it.route ? 2.2 : 1.9" />
      </RouterLink>
    </div>
    <!-- 底部两颗开关：命令面板与信息栏。
         命令面板是桌面的主入口（三十多个页面不该靠鼠标一个个翻），把入口钉在导航轨上，
         用户至少有一次机会看见它 —— 快捷键只有被看见才存在。 -->
    <button class="ric cmd" aria-label="命令面板" :data-label="'命令面板 ' + MOD + 'K'" @click="emit('open-palette')">
      <Search :size="20" :stroke-width="2" />
    </button>
    <button
      class="ric insp"
      :class="{ on: inspectorOpen }"
      :aria-pressed="inspectorOpen"
      aria-label="显示或隐藏信息栏"
      :data-label="'信息栏 ' + MOD + 'I'"
      @click="emit('toggle-inspector')"
    >
      <PanelRight :size="20" :stroke-width="2" />
    </button>
    <RouterLink
      :to="{ name: 'me' }"
      class="ric me"
      :class="{ on: route.name === 'me' }"
      aria-label="我"
      data-label="我"
    >
      <User :size="21" :stroke-width="route.name === 'me' ? 2.2 : 1.9" />
    </RouterLink>
  </nav>
</template>

<style scoped>
/* 材质走全局那一份 .glass-surface（受光边 + 内顶高光 + 投影 + 超高的光学层），
   这里只给几何。原先是一份手写的 --surface-translucent + blur(20px)：与其余玻璃
   各写一套的代价是**档位升级要改两遍**，而超高档正是靠改令牌整套升级的。
   glass-edge-r：只保留靠内那一条描边 —— 左边贴着屏幕边缘，画框就是在边上多一条亮线。 */
.rail {
  width: 64px;
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 上下内距取同一档 20（原来 18/20 不对称）；整列间距 8（--gap-sm）——
     图标轨里每一格之间是「无边界的一组」，此前下方三格（命令面板 / 信息栏 / 我）
     完全没有间距，挤成一条竖带 */
  padding: var(--sp-20) 0;
  gap: var(--gap-sm);
  z-index: 50;
}

.logo {
  width: 26px;
  height: 26px;
  flex: none;
  /* 品牌标与导航簇分开 12（加上 .rail 的 gap 8 共 20，原来是一条 22 的裸边距） */
  margin-bottom: var(--sp-12);
  border-radius: var(--radius-xs);
  background: conic-gradient(from 210deg, var(--c-intake), var(--c-exercise), var(--c-balance), var(--c-intake));
}

.navs {
  gap: var(--gap-sm);
}

/* 图标轨的可读性问题：64px 里只放得下图标，而「课表 / 记账 / 健康方案」这几个
   单看图形是猜不出来的。这里给每一格补一条**自绘的悬停标签**（真机上的原生
   title 要等一秒、样式不受控），它是绝对定位的 —— 不占布局、不推挤内容，
   这正是图标轨该有的做法（VS Code 的活动栏同一套）。
   文字走 data-label 而不是 title：title 会同时弹一个原生提示，两个叠在一起。 */
.ric {
  position: relative;
  width: 42px;
  height: 42px;
  border-radius: var(--radius-m);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  text-decoration: none;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}

.ric::after {
  content: attr(data-label);
  position: absolute;
  left: calc(100% + var(--sp-12));
  top: 50%;
  translate: 0 -50%;
  /* 悬停标签：4×10 内距（吸附自 5 上下），是真标签的尺寸而不是按钮 */
  padding: var(--sp-4) var(--sp-10);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-1) 88%, transparent);
  color: var(--bg);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 只给有指针的设备：触屏上悬停会粘住，标签会一直挂在那儿 */
@media (hover: hover) {
  .ric:hover::after {
    opacity: 1;
  }
}

/* 键盘走到这一格也要能看到名字：焦点环说明「在哪」，标签说明「是什么」 */
.ric:focus-visible::after {
  opacity: 1;
}

/* 悬停只给有指针的设备：触屏浏览器的 :hover 会在点过之后粘住不散，
   而窄屏根本不会渲染这条导航轨 —— 这两条加在一起才敢无条件写 hover。 */
@media (hover: hover) {
  .ric:hover {
    color: var(--text-1);
    background: color-mix(in srgb, var(--text-1) 6%, transparent);
  }

  .ric.on:hover {
    background: var(--accent-soft);
  }
}

.ric.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 两颗开关贴着导航轨底部、排在「我」之上：容量类的开关属于壳层，
   与页面导航分成两簇 —— 自动外边距把它们推到底部，.me 仍是最后一项。 */
.cmd {
  margin-top: auto;
}

/* 信息栏收起后这颗钮保持「关」的读数：只有描边色差，不做位移 ——
   开关状态不该让导航轨的节奏跳一下。 */
.insp {
  /* 信息栏钮与下面的「我」之间再挪 2：与上面 .rail 的 gap 8 一起，
     把「壳层开关」和「页面导航」分成两簇 */
  margin-bottom: var(--sp-2);
}

.insp.on {
  color: var(--accent);
}

.me {
  margin-top: 0;
}
</style>
