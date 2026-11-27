<script setup lang="ts">
/**
 * 心率区间组件：大号读数 + 手表式五段区间条 + 底部位置三角。
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

import HeartRateZoneBar from '@/components/health/HeartRateZoneBar.vue'
import { hrZoneMeta } from '@/config/hr'

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
      <!-- 区间名视觉上只由彩条里的白字承担；这里留一份读屏文本 -->
      <span v-if="meta" class="hzm-sr">{{ meta.label }}</span>
      <slot name="trailing" />
    </div>

    <!-- 区间名只写在当前段里（手表式，视觉上唯一指示）；读屏拿上面的 .hzm-sr。
         同一份条也用在训练顶栏的紧凑档（见 HeartRateZoneBar）。 -->
    <HeartRateZoneBar :bpm="bpm" :max-hr="maxHr" :zone="zone" :live="live" />
  </section>
</template>

<style scoped>
.hzm {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
  width: 100%;
  /* 当前段向上长高 13px，头部与条之间留 8px 即可，不额外占卡片高度 */
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

/* 只给读屏用：视觉上的区间名统一交给彩条里的白字，避免两处重复 */
.hzm-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
</style>
