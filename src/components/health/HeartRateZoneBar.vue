<script setup lang="ts">
/**
 * 心率区间条（手表式：等高五段色阶 + 当前区间名 + 底沿上指三角）。
 *
 * 照手表运动屏的样式做：五段彩条**等高**连成一条，只有首尾两块外端带圆角，
 * 中间衔接是直边；当前所在区间段里写着区间名（白字）；条的底沿嵌一枚上指
 * 小三角，指着此刻的心率位置，三角周围用 mask 挖出缺口（不是浮在条上，
 * 而是「按进去」）。断开设备 / 没有样本时整条淡成图例，不写区间名、不画三角。
 *
 * 位置按 50%–100% HRmax 连续映射（五个区间各占 20%），用 cqw 把 --p 换算成
 * 像素位移，transition 只作用于 transform / mask-position。区间名优先用外部
 * 传进来的 zone（与 Rust 的边界判定同一份），没传才按 progress 推算。
 */
import { computed } from 'vue'

import { HR_ZONES } from '@/config/hr'

const props = withDefaults(
  defineProps<{
    bpm?: number | null
    maxHr?: number | null
    /** 当前区间（Rust 按同一份边界计算）；不传则按 progress 推算 */
    zone?: number | null
    /** 有实时样本才写区间名 / 画三角 / 挖缺口；否则整条变淡作图例 */
    live?: boolean
    /** 紧凑档：条更细、三角更小（训练顶栏胶囊用） */
    compact?: boolean
  }>(),
  { bpm: null, maxHr: null, zone: null, live: false, compact: false },
)

/** 0..1：50% HRmax → 0，100% HRmax → 1 */
const progress = computed<number | null>(() => {
  if (props.bpm == null || !props.maxHr) return null
  const ratio = props.bpm / props.maxHr
  return Math.min(1, Math.max(0, (ratio - 0.5) / 0.5))
})

const showMarker = computed(() => props.live && progress.value != null)

/** 区间名落在当前段上：优先用外部 zone，避免与 Rust 的边界判定不一致 */
const activeZone = computed<number | null>(() => {
  if (props.zone != null && props.zone >= 1 && props.zone <= 5) return Math.trunc(props.zone)
  if (progress.value == null) return null
  return Math.min(5, Math.max(1, Math.floor(progress.value * 5) + 1))
})

const activeLabel = computed(() => {
  const z = activeZone.value
  return z == null ? null : (HR_ZONES[z - 1]?.label ?? null)
})
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
        :class="{ active: showMarker && z.zone === activeZone }"
        :style="{ background: `var(${z.colorVar})` }"
      >
        <span v-if="showMarker && !compact && z.zone === activeZone" class="hzb-label">
          {{ activeLabel }}
        </span>
      </i>
    </span>
    <!-- 上指三角：底边坐在条的底沿上、尖顶探进缺口里；颜色跟随主题文本色 -->
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
  height: 22px;
  /* cqw 的基准：三角与 mask 缺口都按 --p 换算成这条的真实像素宽度 */
  container-type: inline-size;
  /* 缺口尺寸：三角(12×6)按 2px 定值外扩后的轮廓（16×8），让指示器像「按进」条里 */
  --hole-w: 16px;
  --hole-h: 8px;
}

.hzb.compact {
  height: 10px;
  /* 紧凑档三角 8×4，缺口按同比例缩到 2/3 */
  --hole-w: 10.67px;
  --hole-h: 5.33px;
}

/* 等高连成一条：只有首尾外端圆角，中间衔接保持直边 */
.hzb-track {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 2px;
}

.hzb-seg {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.hzb-seg:first-child {
  border-radius: var(--radius-full) 0 0 var(--radius-full);
}

.hzb-seg:last-child {
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
}

.hzb-label {
  color: #fff;
  font-size: 11px;
  font-weight: var(--fw-bold);
  line-height: 1;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}

/* 没有实时样本时整条淡成图例，不再假装是当前读数 */
.hzb.dim .hzb-seg {
  opacity: 0.35;
}

/* 有实时样本才挖缺口：两层 mask 用 exclude 合成。第二层是「透明底 + 黑色洞形」，
   洞口直接用三角路径**描边外扩**生成（stroke-width 4 = 四周各 2px，linejoin round），
   所以洞缘和三角轮廓是严格等距的，不是另画一个比例不同的大三角。
   三角基线在 y=5.78，外扩后下探到 y≈10 → 底边对齐条的底沿后自然开口。
   ⚠ 第二层**不能**画成「黑底矩形 + 透明洞」—— exclude 会把整块图像区域一起挖掉。
   位置用长度（cqw）而不是百分比 —— mask-position 的百分比按「剩余空间」对齐，
   洞会随 --p 偏移；长度是绝对位移，洞心始终压在三角上。 */
.hzb:not(.dim) .hzb-track {
  -webkit-mask-image: linear-gradient(#000, #000),
    url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20width%3D'16'%20height%3D'8'%20viewBox%3D'0%200%2016%208'%3E%3Cg%20transform%3D'translate(2%2C2.2)'%3E%3Cpath%20d%3D'M4.383%201.018Q6%20-1.018%207.617%201.018L9.783%203.746Q11.4%205.782%208.8%205.782L3.2%205.782Q0.6%205.782%202.217%203.746Z'%20fill%3D'%23000'%20stroke%3D'%23000'%20stroke-width%3D'4'%20stroke-linejoin%3D'round'%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E");
  mask-image: linear-gradient(#000, #000),
    url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20width%3D'16'%20height%3D'8'%20viewBox%3D'0%200%2016%208'%3E%3Cg%20transform%3D'translate(2%2C2.2)'%3E%3Cpath%20d%3D'M4.383%201.018Q6%20-1.018%207.617%201.018L9.783%203.746Q11.4%205.782%208.8%205.782L3.2%205.782Q0.6%205.782%202.217%203.746Z'%20fill%3D'%23000'%20stroke%3D'%23000'%20stroke-width%3D'4'%20stroke-linejoin%3D'round'%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E");
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%, var(--hole-w) var(--hole-h);
  mask-size: 100% 100%, var(--hole-w) var(--hole-h);
  -webkit-mask-position: 0 0, calc(var(--p, 0) * 100cqw - var(--hole-w) / 2) 100%;
  mask-position: 0 0, calc(var(--p, 0) * 100cqw - var(--hole-w) / 2) 100%;
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  mask-mode: alpha;
  /* 与三角同一条曲线：洞不会甩开指示器；只重绘这条细条 */
  transition:
    -webkit-mask-position var(--dur-slow) var(--ease-out),
    mask-position var(--dur-slow) var(--ease-out);
}

/* 上指三角：底边贴住条的底沿，尖顶探进缺口；用文本色，深浅主题都看得见 */
.hzb-marker {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 12px;
  height: 6px;
  margin-left: -6px;
  color: var(--text-1);
  fill: currentColor;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.22));
  transform: translateX(calc(var(--p, 0) * 100cqw));
  transition: transform var(--dur-slow) var(--ease-out);
  will-change: transform;
}

.hzb.compact .hzb-marker {
  width: 8px;
  height: 4px;
  margin-left: -4px;
}
</style>
