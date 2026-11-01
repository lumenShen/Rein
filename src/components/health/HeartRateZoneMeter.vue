<script setup lang="ts">
/**
 * 心率区间组件：大号读数 + 五段区间条 + 当前心率位置三角。
 *
 * 三角的位置不是「按区间等分取中点」，而是按 50%–100% HRmax 连续映射：
 * 五个区间的边界正好落在 20% / 40% / 60% / 80% 上，所以三角滑动时读到的
 * 是**真实百分比位置**，而不是只跳到某个区。50% 以下（静息）钉在最左端。
 *
 * 位移用 transform（容器查询单位 cqw 直接换算成像素），只走合成器；
 * 心率每秒更新一次，过渡取 --dur-slow（480ms）——短于更新间隔，读数不会永远追不上。
 * 关闭动效 / prefers-reduced-motion 由 base.css 统一把 transition 时长压到 0.01ms。
 */
import { computed } from 'vue'
import { Heart } from 'lucide-vue-next'

import { HR_ZONES, hrZoneMeta } from '@/config/hr'

const props = withDefaults(
  defineProps<{
    /** 当前心率；未连接时传 null（读数显示 —，不画三角） */
    bpm?: number | null
    /** 最大心率（年龄缺失时为 null，此时无法定位） */
    maxHr?: number | null
    /** 当前区间（Rust 按同一份边界计算） */
    zone?: number | null
    /** 有实时样本：图心转危险色、显示呼吸点 */
    live?: boolean
  }>(),
  { bpm: null, maxHr: null, zone: null, live: false },
)

const meta = computed(() => hrZoneMeta(props.zone))

/** 0..1：50% HRmax → 0，100% HRmax → 1 */
const progress = computed<number | null>(() => {
  if (props.bpm == null || !props.maxHr) return null
  const ratio = props.bpm / props.maxHr
  return Math.min(1, Math.max(0, (ratio - 0.5) / 0.5))
})

const showMarker = computed(() => props.live && progress.value != null)
</script>

<template>
  <section class="hzm" :class="{ live }">
    <div class="hzm-head">
      <span class="hzm-heart">
        <Heart :size="20" :stroke-width="2" aria-hidden="true" />
        <i v-if="live" class="hzm-beat" />
      </span>
      <span class="hzm-bpm num">
        <b>{{ bpm ?? '—' }}</b>
        <em>次/分</em>
      </span>
      <span v-if="meta" class="hzm-zone">{{ meta.label }}</span>
      <slot name="trailing" />
    </div>

    <!-- 条本身是装饰：读数与区间名在上面已经是文本，读屏不必再听一遍颜色 -->
    <div class="hzm-bar" :class="{ dim: !showMarker }" aria-hidden="true">
      <i
        v-for="z in HR_ZONES"
        :key="z.zone"
        class="hzm-seg"
        :style="{ background: `var(${z.colorVar})` }"
      />
      <span
        v-if="showMarker"
        class="hzm-marker"
        :style="{ '--p': progress ?? 0 }"
      />
    </div>
  </section>
</template>

<style scoped>
.hzm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
  width: 100%;
  /* 三角吊在条下方，留出它自己那 6px 的落点 */
  padding-bottom: var(--sp-8);
}

.hzm-head {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
}

.hzm-heart {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--sp-40);
  height: var(--sp-40);
  flex: none;
  border-radius: var(--radius-full);
  color: var(--text-2);
  background: var(--surface-2);
}

.hzm.live .hzm-heart {
  color: var(--danger);
  background: var(--danger-soft);
}

.hzm-beat {
  position: absolute;
  top: var(--sp-6);
  right: var(--sp-8);
  width: var(--sp-6);
  height: var(--sp-6);
  border-radius: var(--radius-full);
  background: var(--danger);
  animation: rein-breathe 1.1s var(--ease-standard) infinite;
}

.hzm-bpm {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
  margin-right: auto;
}

.hzm-bpm b {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  line-height: 1;
}

.hzm-bpm em {
  font-size: var(--fs-subhead);
  font-style: normal;
  color: var(--text-2);
}

.hzm-zone {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  /* 区间名保持中性色：色相只由条表达（config/hr 的约定） */
  color: var(--text-2);
}

.hzm-bar {
  position: relative;
  display: flex;
  gap: 3px;
  height: 10px;
  /* cqw 的基准：三角按 --p 换算成这条的真实像素宽度 */
  container-type: inline-size;
}

.hzm-seg {
  flex: 1;
  border-radius: var(--radius-full);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 没有实时样本时整条变淡：它退化成图例，不再假装是当前读数 */
.hzm-bar.dim .hzm-seg {
  opacity: 0.35;
}

.hzm-marker {
  position: absolute;
  left: 0;
  bottom: -6px;
  width: 0;
  height: 0;
  margin-left: -5px;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  /* border-bottom 的三角尖朝上，顶住条的底边 */
  border-bottom: 6px solid var(--text-1);
  transform: translateX(calc(var(--p) * 100cqw));
  transition: transform var(--dur-slow) var(--ease-out);
  will-change: transform;
}
</style>
