<script setup lang="ts">
import { computed } from 'vue'
import { Sparkles } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import { MOTION_LEVELS, motionEffective, motionLevel, setMotionLevel, type MotionLevel } from '@/system/motion'
import { PERF_MODES, liquidGlass, perfMode, setPerfMode, type PerfMode } from '@/system/perf'

/**
 * 外观与性能（`/settings/appearance`）：设置页「通用」组里的二级页。
 *
 * 原先平铺在设置页上的画质卡与动效卡原样搬到这里 —— 两件事本来就正交：
 * 画质管「玻璃画不画得出来」，动效管「界面动不动」。设置页只留一行入口，
 * 需要调的时候再进来；液态玻璃的标本台仍在三级页 `/settings/perf`。
 */
/** 性能档位：四个固定档（low / high / ultra / extreme）都是手动钉死（判定逻辑见 system/perf） */
const PERF_OPTIONS = PERF_MODES.map(({ value, label }) => ({ value, label }))

const perfChoice = computed({
  get: () => perfMode.value as string,
  set: (v: string) => {
    if (PERF_MODES.some((m) => m.value === v)) setPerfMode(v as PerfMode)
  },
})

/** 副标要说清当下生效的是哪一档：不支持折射时如实说明，别让人对着退化结果猜 */
const perfHint = computed(() => {
  if (perfMode.value === 'low') return '始终流畅'
  if (perfMode.value === 'extreme') {
    return liquidGlass.value ? '极致 · 折射 + 全局玻璃' : '极致 · 已铺全局玻璃（本机不支持折射）'
  }
  if (perfMode.value === 'ultra') {
    return liquidGlass.value ? '超高 · 折射已开（塌缩管线）' : '超高 · 已铺全局玻璃（本机不支持折射）'
  }
  return '高画质 · 全局玻璃（无折射）'
})

/** 动效档位：关闭 / 默认 / 丰富（三档在分段控件里放得下完整名字，不必再给 short） */
const MOTION_OPTIONS = MOTION_LEVELS.map(({ value, label }) => ({ value, label }))

const motionChoice = computed({
  get: () => motionLevel.value as string,
  set: (v: string) => {
    if (MOTION_LEVELS.some((m) => m.value === v)) setMotionLevel(v as MotionLevel)
  },
})

/** 副标要报**实际生效**的那一档：被系统减弱动效、或被画质档位压回默认时，
 *  用户选的那一档并没有生效 —— 与 perfHint 同一条原则（如实说，别让人对着假象猜） */
const motionHint = computed(() => {
  if (motionLevel.value === 'off') return '不做补间'
  if (motionEffective.value !== motionLevel.value) {
    return motionEffective.value === 'off' ? '系统已要求减弱动效' : '画质选「流畅」时退回默认'
  }
  return `当前${MOTION_LEVELS.find((m) => m.value === motionLevel.value)?.label ?? ''}`
})
</script>

<template>
  <div class="page" data-testid="appearance-page">
    <PageHeader title="外观与性能" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 画质：画面档位（掉帧判定与降级落地见 system/perf） -->
    <section class="card" data-testid="appearance-perf">
      <header class="row ghead">
        <h2 class="gtitle">画质</h2>
        <span class="gstate t-2">{{ perfHint }}</span>
        <span class="hint-slot">
          <InfoHint title="画质档位说明">
            <p>「流畅」把玻璃顶成实底，关掉模糊与循环动画，最省电；「默认」「超高」「极致」逐档更透，也更吃性能。</p>
            <p>四档都是手动档，切换后立即生效，不会在后台自己切，也不会自己升降。</p>
          </InfoHint>
        </span>
      </header>
      <SegmentedControl v-model="perfChoice" class="perfseg" :options="PERF_OPTIONS" />
      <p class="pnote t-2">四档都是手动档，不会自己切；卡顿就手动切到「流畅」。</p>

      <SettingsRow
        class="preview"
        title="液态玻璃预览"
        subtitle="看这一档的按钮与底部栏长什么样，也可就地切档"
        :icon="Sparkles"
        :to="{ name: 'settings-perf' }"
        testid="appearance-glass-preview"
      />
    </section>

    <!-- 动效：与画质档位正交的另一档（判定与落地见 system/motion） -->
    <section class="card" data-testid="appearance-motion">
      <header class="row ghead">
        <h2 class="gtitle">动效</h2>
        <span class="gstate t-2">{{ motionHint }}</span>
        <span class="hint-slot">
          <InfoHint title="动效档位说明">
            <p>「默认」就是现在这一套，不加装饰；「丰富」多加液态动作；「关闭」不做补间，状态直接切换。</p>
            <p>画质档位管「玻璃画不画得出来」，这里管「界面动不动」——两件事互不影响。</p>
            <p>画质选「流畅」时，「丰富」会退回「默认」；系统要求减弱动效时，全部档位都按「关闭」执行。</p>
          </InfoHint>
        </span>
      </header>
      <SegmentedControl v-model="motionChoice" class="perfseg" :options="MOTION_OPTIONS" />
      <p class="pnote t-2">画质管玻璃画不画得出来，动效管界面动不动；系统要求减弱动效时全部按「关闭」执行。</p>
    </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开，
     这里只剩页头与内容之间那一档呼吸 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 页头下缘自带 16 的呼吸余量，首卡再补 2，与设置页同一条落点 */
.rubber-layer > .card:first-child {
  margin-top: var(--sp-2);
}

/* 卡头行：标题 + 状态副标 + 右侧帮助入口 */
.ghead {
  gap: var(--gap-sm);
}

/* 卡头标题走 18（Subtitle_L）Medium：一页两张档位卡，标题要读得出是一节 */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

/* 卡头状态副标：此刻生效的是哪一档是必读信息，走 --text-2 */
.gstate {
  font-size: var(--fs-caption);
}

/* 标题行右侧的帮助入口：InfoHint 是多根组件，类要落在包裹元素上 */
.hint-slot {
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

/* 卡头 / 分段控件 / 说明各算一块，块间 12 */
.perfseg {
  margin-top: var(--gap-md);
}

/* 说明段（.pnote）解释的是「这档是干什么的、会怎样」，属于要读的正文：
   12 的字号配正文行高 */
.pnote {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* 「液态玻璃预览」排在说明之后：补一条细线把它划到下一块去（组内分隔线用 --line，
   不靠空隙——空隙分不清「换个说法」还是「换一项」） */
.preview {
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 0.5px solid var(--line);
}
</style>
