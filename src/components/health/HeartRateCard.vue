<script setup lang="ts">
import { computed, ref } from 'vue'
import { Bluetooth, Heart, LoaderCircle } from 'lucide-vue-next'

import HeartRateSheet from '@/components/health/HeartRateSheet.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { HR_ZONES, hrZoneMeta } from '@/config/hr'
import { useHeartRateStore } from '@/stores/heartRate'

/**
 * 运动页的心率设备卡：连接状态 + 实时 BPM + 当前区间 + 本次测量读数。
 * 设备列表与连接动作都在 HeartRateSheet 里；这张卡只负责「现在有没有心率」。
 * 训练时用 Rust 侧积分的热量，卡上只做读数展示，不做任何逐样本计算。
 */
const hr = useHeartRateStore()
const sheetOpen = ref(false)

const zone = computed(() => hrZoneMeta(hr.zone))
const tone = computed<'neutral' | 'ok' | 'warn' | 'danger' | 'accent'>(() => {
  switch (hr.status.state) {
    case 'connected':
      return 'ok'
    case 'error':
      return 'danger'
    case 'connecting':
    case 'reconnecting':
      return 'warn'
    default:
      return 'neutral'
  }
})
const chipLabel = computed(() => {
  switch (hr.status.state) {
    case 'connected':
      return '实时'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    case 'error':
      return '连接失败'
    case 'scanning':
      return '扫描中'
    default:
      return '未连接'
  }
})
const busy = computed(() => hr.connecting || hr.reconnecting)
</script>

<template>
  <section class="card hr-card">
    <header class="row between head">
      <h2 class="title">
        <Heart class="title-ic" :size="18" :stroke-width="2.1" aria-hidden="true" />
        心率
      </h2>
      <StatusChip :tone="tone">{{ chipLabel }}</StatusChip>
    </header>

    <template v-if="!hr.supported">
      <p class="desc">当前平台暂不支持蓝牙心率采集。桌面端可连接手环的标准心率广播（0x180D）。</p>
    </template>

    <template v-else-if="hr.connected">
      <div class="live row between">
        <div class="bpm">
          <b class="num">{{ hr.bpm ?? '—' }}</b>
          <span class="unit">次/分</span>
        </div>
        <div class="live-meta">
          <span class="zone" :style="{ '--zc': zone ? `var(${zone.colorVar})` : 'var(--text-3)' }">
            <i aria-hidden="true" />
            {{ zone ? `${zone.label}区 · ${zone.range}` : '设置生日后显示区间' }}
          </span>
          <span class="dev">{{ hr.deviceName }}</span>
        </div>
      </div>

      <div
        v-if="zone"
        class="zbar"
        role="img"
        :aria-label="`当前心率区间：${zone.label}`"
      >
        <i
          v-for="z in HR_ZONES"
          :key="z.zone"
          :style="{ background: `var(${z.colorVar})`, opacity: zone && z.zone === zone.zone ? 1 : 0.16 }"
        />
      </div>

      <p v-if="hr.workoutActive" class="stats num">
        平均 <b>{{ hr.liveAvgBpm ?? '—' }}</b>
        <span>·</span>
        最高 <b>{{ hr.liveMaxBpm ?? '—' }}</b>
        <span v-if="hr.liveKcal != null">
          · 心率估算参考 <b>{{ Math.round(hr.liveKcal) }}</b> kcal</span>
      </p>
      <p v-else class="stats">训练中记录心率区间与强度；心率热量只作跑步无距离时的兜底参考。</p>
      <p v-if="hr.error" class="err" role="alert">{{ hr.error }}</p>

      <footer class="row between actions">
        <button type="button" class="ios-btn ios-btn--gray ios-btn--sm" @click="hr.disconnect()">断开</button>
        <button type="button" class="ios-btn ios-btn--plain ios-btn--sm" @click="sheetOpen = true">更换设备</button>
      </footer>
    </template>

    <template v-else>
      <p class="desc">
        连接手环的心率广播，训练时按心率计算运动消耗；结束时自动断开，省手环的电。
      </p>
      <div class="row between actions">
        <button
          type="button"
          class="ios-btn ios-btn--tinted connect"
          :disabled="busy"
          @click="sheetOpen = true"
        >
          <LoaderCircle v-if="busy" class="spin" :size="18" :stroke-width="2.2" aria-hidden="true" />
          <Bluetooth v-else :size="18" :stroke-width="2" aria-hidden="true" />
          {{ busy ? '连接中…' : '连接设备' }}
        </button>
        <span v-if="hr.devicePref" class="last">上次：{{ hr.devicePref.name }}</span>
      </div>
      <p v-if="hr.error" class="err" role="alert">{{ hr.error }}</p>
    </template>

    <HeartRateSheet :open="sheetOpen" @close="sheetOpen = false" />
  </section>
</template>

<style scoped>
.hr-card {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
}

.head {
  margin-bottom: var(--sp-2);
}

.title {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.2px;
}

.title-ic {
  color: var(--danger);
}

.desc {
  font-size: var(--fs-subhead);
  line-height: var(--lh-subtitle);
  color: var(--text-2);
}

.live {
  align-items: flex-end;
  margin-top: var(--sp-2);
}

.bpm {
  display: flex;
  align-items: baseline;
  gap: var(--sp-6);
}

.bpm b {
  font-size: var(--fs-display-s);
  font-weight: var(--fw-bold);
  letter-spacing: -0.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.unit {
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.live-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--sp-2);
  min-width: 0;
  padding-bottom: var(--sp-4);
}

.zone {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  font-size: var(--fs-subhead);
  color: var(--text-1);
  font-weight: var(--fw-medium);
}

.zone i {
  width: var(--sp-8);
  height: var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--zc);
}

.dev {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.zbar {
  display: flex;
  gap: var(--sp-4);
  height: var(--sp-6);
  margin: var(--sp-4) 0 0;
}

.zbar i {
  flex: 1;
  border-radius: var(--radius-full);
  transition: opacity var(--dur-base) var(--ease-standard);
}

.stats {
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--text-2);
}

.stats b {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.stats span {
  margin: 0 var(--sp-4);
  color: var(--text-3);
}

.stats .weak {
  margin: 0;
  color: var(--warn-strong);
}

.actions {
  margin-top: var(--sp-4);
  gap: var(--gap-tight);
}

.connect {
  min-height: var(--control-md);
  padding: 0 var(--pad-inline);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
}

.last {
  margin-left: auto;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.err {
  font-size: var(--fs-caption);
  color: var(--danger-strong);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}
</style>
