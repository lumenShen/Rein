<script setup lang="ts">
/**
 * 训练中的心率卡：实时读数 + 五段区间条 + 本次平均/峰值。
 *
 * 为什么不再挂在顶栏：训练时的心率不是「状态栏读数」，而是和重量、次数、肌群激活
 * 并列的**这一组的内容**——顶栏那颗 52px 的小胶囊只够放一个数字，组间休息时
 * 抬头看它还得跳过整屏空白。现在它落在内容流里：动作中在登记卡下方，
 * 组间在休息环下方，和眼睛本来就在的位置一致。
 *
 * 整卡是一个按钮：点开心率设备抽屉（连接/断开/换设备），与顶栏旧胶囊同一条入口。
 */
import { computed } from 'vue'
import { ChevronRight, Heart } from 'lucide-vue-next'

import HeartRateZoneBar from '@/components/health/HeartRateZoneBar.vue'
import HeartRateZoneMeter from '@/components/health/HeartRateZoneMeter.vue'

const props = withDefaults(
  defineProps<{
    /** 当前平台是否支持蓝牙心率；不支持时整卡不渲染 */
    supported?: boolean
    connected?: boolean
    bpm?: number | null
    maxHr?: number | null
    zone?: number | null
    /** 本次测量均值/峰值（未测量时为 null，不占行） */
    avgBpm?: number | null
    maxBpm?: number | null
    /** 是否展示均值/峰值：组间休息用，做组时留白给读数 */
    stats?: boolean
  }>(),
  {
    supported: true,
    connected: false,
    bpm: null,
    maxHr: null,
    zone: null,
    avgBpm: null,
    maxBpm: null,
    stats: false,
  },
)

const emit = defineEmits<{ open: [] }>()

const showStats = computed(
  () => props.stats && props.connected && (props.avgBpm != null || props.maxBpm != null),
)

const ariaLabel = computed(() => {
  if (!props.connected) return '连接心率设备'
  const bpm = props.bpm != null ? `心率 ${props.bpm} 次每分，` : ''
  return `${bpm}打开心率设备与区间`
})
</script>

<template>
  <button
    v-if="supported"
    type="button"
    class="hrcard"
    :class="{ live: connected }"
    :aria-label="ariaLabel"
    @click="emit('open')"
  >
    <span class="hr-top">
      <span class="hr-title">心率</span>
      <span class="hr-state">{{ connected ? '实时' : '未连接' }}</span>
      <ChevronRight :size="14" class="chev" aria-hidden="true" />
    </span>

    <template v-if="connected">
      <HeartRateZoneMeter :bpm="bpm" :max-hr="maxHr" :zone="zone" live />

      <span v-if="showStats" class="hr-stats">
        <span v-if="avgBpm != null">平均 <b class="num">{{ avgBpm }}</b></span>
        <i v-if="avgBpm != null && maxBpm != null" class="sep" aria-hidden="true" />
        <span v-if="maxBpm != null">峰值 <b class="num">{{ maxBpm }}</b></span>
      </span>
    </template>

    <!-- 未连接时不留一个又大又空的「—」（34px 的破折号像加载条），
         改成一行邀请；区间条留作图例，卡高与连接态相近，连接时版式不跳。 -->
    <template v-else>
      <span class="hr-off">
        <span class="hr-off-icon">
          <Heart :size="18" :stroke-width="2" aria-hidden="true" />
        </span>
        <span class="hr-off-text">点此连接心率设备</span>
      </span>
      <HeartRateZoneBar :bpm="null" :max-hr="maxHr" />
    </template>
  </button>
</template>

<style scoped>
/* 与 .setcard / .blockcard 同一材质与几何：内容层实底 + 轻投影，不是玻璃
   （心率是这一组的内容，玻璃只属于顶栏/底簇那层控制面）。 */
.hrcard {
  width: min(360px, 100%);
  border-radius: var(--radius-m);
  padding: var(--pad-card);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  color: var(--text-1);
  transition: transform var(--dur-slow) var(--ease-spring);
}

.hrcard:active {
  transform: scale(0.985);
  transition: transform 120ms var(--ease-out);
}

.hr-top {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

/* 标题行与「肌群激活 / 动作要点」同档：卡片标题是次级信息，不跟读数抢 */
.hr-title {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.hr-state {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.hrcard.live .hr-state {
  color: var(--text-2);
}

.chev {
  color: var(--text-3);
  flex: none;
}

/* 未连接态：与 HeartRateZoneMeter 的图心同尺寸（40），换行文案替掉大号破折号 */
.hr-off {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
}

.hr-off-icon {
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

.hr-off-text {
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.hr-stats {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
  margin-top: calc(-1 * var(--sp-2));
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.hr-stats b {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

.hr-stats .sep {
  flex: none;
  width: 1px;
  height: 10px;
  background: var(--line);
  align-self: center;
}
</style>
