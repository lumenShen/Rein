<script setup lang="ts">
/**
 * 心率区间条（五段色阶 + 位置三角）。
 *
 * 单独抽出来是因为它要在两种尺寸里出现：心率抽屉里的标准条，和训练顶栏
 * 心率胶囊里的紧凑条。两处的定位算法必须是同一份 —— 不然「同一个心率，
 * 抽屉里在 62%，顶栏里在 58%」这种错位没人能解释。
 *
 * 位置按 50%–100% HRmax 连续映射（五个区间各占 20%），用 cqw 把 --p 换算成
 * 像素位移，transition 只作用于 transform。
 *
 * 三角是 SVG 路径（不是 border 三角）：三条边都带圆角，视觉上不再像一把刀尖。
 * 条带在三角正上方被 mask 挖掉一小块（三角外轮廓 + 横长的一半），让指示器
 * 看起来嵌进条里而不是浮在边上；mask 只挂在 10px 高的条上，位置随 --p 用
 * 长度（cqw）计算，不触发整块重排。
 */
import { computed } from 'vue'

import { HR_ZONES } from '@/config/hr'

const props = withDefaults(
  defineProps<{
    bpm?: number | null
    maxHr?: number | null
    /** 有实时样本才画三角；否则整条变淡作图例 */
    live?: boolean
    /** 紧凑档：条更细、三角更小（训练顶栏胶囊用） */
    compact?: boolean
  }>(),
  { bpm: null, maxHr: null, live: false, compact: false },
)

/** 0..1：50% HRmax → 0，100% HRmax → 1 */
const progress = computed<number | null>(() => {
  if (props.bpm == null || !props.maxHr) return null
  const ratio = props.bpm / props.maxHr
  return Math.min(1, Math.max(0, (ratio - 0.5) / 0.5))
})

const showMarker = computed(() => props.live && progress.value != null)
</script>

<template>
  <span
    class="hzb"
    :class="{ dim: !showMarker, compact }"
    :style="showMarker ? { '--p': progress ?? 0 } : undefined"
    aria-hidden="true"
  >
    <span class="hzb-track">
      <i
        v-for="z in HR_ZONES"
        :key="z.zone"
        class="hzb-seg"
        :style="{ background: `var(${z.colorVar})` }"
      />
    </span>
    <!-- 圆角三角：三条边都收圆（各顶点向内 2.6px 的弧起点），尖顶正好落在条的下沿。
         路径上移 1.018px，让二次曲线的顶点（控制点的一半）压在 y=0 上。 -->
    <svg v-if="showMarker" class="hzb-marker" viewBox="0 0 12 6" aria-hidden="true">
      <path
        d="M4.383 1.018Q6 -1.018 7.617 1.018L9.783 3.746Q11.4 5.782 8.8 5.782L3.2 5.782Q0.6 5.782 2.217 3.746Z"
      />
    </svg>
  </span>
</template>

<style scoped>
.hzb {
  position: relative;
  display: block;
  width: 100%;
  height: 10px;
  /* cqw 的基准：三角与 mask 缺口都按 --p 换算成这条的真实像素宽度 */
  container-type: inline-size;
  /* 缺口尺寸：标准档 20×5 —— 三角轮廓真正外扩 4.5px 后的圆角形状
     （底边最宽 ~11.5px、最深 4.5px），比旧的 18×6 硬 V 更贴、更像「按进去」 */
  --hole-w: 20px;
  --hole-h: 5px;
}

.hzb.compact {
  height: 4px;
  --hole-w: 12px;
  --hole-h: 3px;
}

.hzb-track {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 3px;
}

.hzb.compact .hzb-track {
  gap: 2px;
}

.hzb-seg {
  flex: 1;
  border-radius: var(--radius-full);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

/* 没有实时样本时整条变淡：它退化成图例，不再假装是当前读数 */
.hzb.dim .hzb-seg {
  opacity: 0.35;
}

/* 有实时样本才挖缺口：两层 mask 用 exclude 合成。第二层是**透明底 + 黑色洞形**
   （洞口 = 三角轮廓按 4.5px 均匀外扩后的圆角形状，三条边各外推 4.5、三个角
   以 4.5 为半径倒圆），exclude 只挖黑形本身；窗口只留条带高度里的那 5px，
   可见缺口是「底边 ~11.5px 宽、最深 4.5px」的一小口。
   ⚠ 第二层**不能**画成「黑底矩形 + 透明洞」—— exclude 会把整块图像区域一起
   挖掉（实测表现为一整段全高方缺口，像条带被切断）。位置用长度（cqw）而不是
   百分比 —— mask-position 的百分比会按「剩余空间」对齐，洞会随 --p 偏移；
   长度是绝对位移，洞心始终压在三角上。 */
.hzb:not(.dim) .hzb-track {
  -webkit-mask-image: linear-gradient(#000, #000),
    url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20width%3D'20'%20height%3D'5'%20viewBox%3D'0%200%2020%205'%3E%3Cpath%20fill%3D'%23000'%20d%3D'M6.47%202.21A4.5%204.5%200%200%201%2013.53%202.21L19.53%209.81A4.5%204.5%200%200%201%2016%2017.1L4%2017.1A4.5%204.5%200%200%201%20.47%209.81Z'%2F%3E%3C%2Fsvg%3E");
  mask-image: linear-gradient(#000, #000),
    url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20width%3D'20'%20height%3D'5'%20viewBox%3D'0%200%2020%205'%3E%3Cpath%20fill%3D'%23000'%20d%3D'M6.47%202.21A4.5%204.5%200%200%201%2013.53%202.21L19.53%209.81A4.5%204.5%200%200%201%2016%2017.1L4%2017.1A4.5%204.5%200%200%201%20.47%209.81Z'%2F%3E%3C%2Fsvg%3E");
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%, var(--hole-w) var(--hole-h);
  mask-size: 100% 100%, var(--hole-w) var(--hole-h);
  -webkit-mask-position: 0 0, calc(var(--p, 0) * 100cqw - var(--hole-w) / 2) 100%;
  mask-position: 0 0, calc(var(--p, 0) * 100cqw - var(--hole-w) / 2) 100%;
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  mask-mode: alpha;
  /* 与三角同一条曲线：洞不会甩开指示器；只重绘这条 10px 高的细条 */
  transition:
    -webkit-mask-position var(--dur-slow) var(--ease-out),
    mask-position var(--dur-slow) var(--ease-out);
}

.hzb-marker {
  position: absolute;
  left: 0;
  bottom: -6px;
  width: 12px;
  height: 6px;
  margin-left: -6px;
  color: var(--text-1);
  fill: currentColor;
  transform: translateX(calc(var(--p, 0) * 100cqw));
  transition: transform var(--dur-slow) var(--ease-out);
  will-change: transform;
}

.hzb.compact .hzb-marker {
  bottom: -4px;
  width: 8px;
  height: 4px;
  margin-left: -4px;
}
</style>
