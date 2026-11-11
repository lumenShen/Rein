<script setup lang="ts">
import { computed, watch } from 'vue'
import { Bluetooth, LoaderCircle } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import HeartRateZoneMeter from '@/components/health/HeartRateZoneMeter.vue'
import { useHeartRateStore } from '@/stores/heartRate'
import type { HrDevice } from '@/types'

/**
 * 心率设备抽屉：扫描 → 选择 → 连接 / 断开。
 *
 * 蓝牙唯一的中心位是设备侧限制：手机 App 连着时电脑连不上，所以连接失败的原因
 * 优先说这一条，而不是把 btleplug 的英文错误原样抛给用户。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const hr = useHeartRateStore()

const connectedId = computed(() => (hr.connected ? hr.device?.id ?? null : null))
const scanning = computed(() => hr.scanning)
const busy = computed(() => hr.scanning || hr.connecting || hr.reconnecting)

/** 连上以后只留当前设备：扫描快照里的耳机 / 电视对训练毫无意义，留着只是噪音。
 *  已连接设备不一定还在最后一次扫描快照里（自动连接、列表被新扫描清空），
 *  这时用状态里的 device 兜底，保证「已连接设备」下面永远有一行。 */
const visibleDevices = computed<HrDevice[]>(() => {
  if (!hr.connected) return hr.devices
  const id = connectedId.value
  if (!id) return []
  const own = hr.devices.find((d) => d.id === id) ?? hr.device
  return own ? [own] : []
})

const stateLabel = computed(() => {
  switch (hr.status.state) {
    case 'connected':
      return '已连接'
    case 'scanning':
      return '扫描中'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    case 'error':
      return '连接失败'
    default:
      return '未连接'
  }
})

const stateTone = computed<'neutral' | 'ok' | 'warn' | 'danger' | 'accent'>(() => {
  switch (hr.status.state) {
    case 'connected':
      return 'ok'
    case 'error':
      return 'danger'
    case 'connecting':
    case 'reconnecting':
      return 'warn'
    case 'scanning':
      return 'accent'
    default:
      return 'neutral'
  }
})

function statusText(d: HrDevice): string {
  return d.rssi == null ? '' : `${d.rssi} dBm`
}

function pick(d: HrDevice): void {
  if (d.id === connectedId.value) return
  void hr.connect(d)
}

function rescan(): void {
  void hr.scanStart()
}

function openChanged(open: boolean): void {
  if (!hr.supported) return
  if (open && !hr.connected) void hr.scanStart()
  if (!open) void hr.scanStop()
}

// SheetModal 没有 open-change 事件，直接监听 prop：打开时才扫描、关闭时停扫，
// 避免调用方在每个入口重复写扫描逻辑。初次挂载（open=false）不发任何命令。
watch(
  () => props.open,
  (open, wasOpen) => {
    if (open) openChanged(true)
    else if (wasOpen) openChanged(false)
  },
)
</script>

<template>
  <SheetModal :open="open" title="心率设备" initial-snap="medium" @close="emit('close')">
    <template #action>
      <button
        v-if="hr.connected"
        type="button"
        class="ios-btn ios-btn--plain ios-btn--sm"
        @click="hr.disconnect()"
      >
        断开
      </button>
    </template>

    <section v-if="!hr.supported" class="block">
      <p class="tip">当前平台暂不支持蓝牙心率采集，请在桌面端使用。</p>
    </section>

    <template v-else>
      <section class="hero card sub">
        <!-- 读数 + 区间条 + 当前心率位置：组件自带读数与图心，状态胶囊走 trailing 槽 -->
        <HeartRateZoneMeter
          :bpm="hr.connected ? hr.bpm : null"
          :max-hr="hr.maxHr"
          :zone="hr.zone"
          :live="hr.connected"
        >
          <template #trailing>
            <StatusChip :tone="stateTone">{{ stateLabel }}</StatusChip>
          </template>
        </HeartRateZoneMeter>
        <p class="hero-meta">
          <span v-if="hr.connected">{{ hr.deviceName }}</span>
          <span v-else-if="busy" class="row center">
            <LoaderCircle class="spin" :size="14" :stroke-width="2.2" aria-hidden="true" />
            {{ hr.scanning ? '正在扫描附近的心率设备…' : '正在连接…' }}
          </span>
          <span v-else-if="hr.devicePref">上次设备：{{ hr.devicePref.name }}</span>
          <span v-else>尚未连接过设备</span>
        </p>
        <p v-if="hr.error" class="err" role="alert">{{ hr.error }}</p>
      </section>

      <section class="devices">
        <header class="sec-head">
          <h3>{{ hr.connected ? '已连接设备' : '附近设备' }}</h3>
          <button
            v-if="!hr.connected"
            type="button"
            class="ios-btn ios-btn--plain ios-btn--sm"
            :disabled="busy"
            @click="rescan"
          >
            {{ scanning ? '扫描中…' : busy ? '请稍候…' : '重新扫描' }}
          </button>
          <span v-else class="sec-hint">先断开再扫描</span>
        </header>

        <p v-if="scanning && visibleDevices.length === 0" class="empty">正在扫描…</p>
        <p v-else-if="visibleDevices.length === 0" class="empty">
          <template v-if="hr.connected">
            已连接当前设备。要更换请先点右上角「断开」，再重新扫描。
          </template>
          <template v-else>
            没有发现设备。确认手环已开启心率广播，并先断开手机上的运动健康 App。
          </template>
        </p>
        <ul v-else class="list">
          <li v-for="d in visibleDevices" :key="d.id">
            <button
              type="button"
              class="dev"
              :class="{ on: d.id === connectedId }"
              :aria-label="`连接 ${d.name}`"
              @click="pick(d)"
            >
              <span class="dev-ic" aria-hidden="true"><Bluetooth :size="18" :stroke-width="2" /></span>
              <span class="dev-txt">
                <b>{{ d.name }}</b>
                <em class="num">{{ statusText(d) }}</em>
              </span>
              <StatusChip v-if="d.id === connectedId" tone="ok">已连接</StatusChip>
              <StatusChip v-else-if="d.hasHeartRate" tone="accent">心率</StatusChip>
            </button>
          </li>
        </ul>
      </section>

      <p class="foot-tip">
        手环同时只能被一个中心连接：手机 App 连着时电脑连不上，先在手机上断开。训练开始会自动连上次设备，训练结束自动断开。
      </p>
    </template>
  </SheetModal>
</template>

<style scoped>
.block {
  padding: var(--sp-8) 0;
}

.hero {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
}

.hero-meta {
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.err {
  font-size: var(--fs-subhead);
  color: var(--danger-strong);
}

.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: var(--gap-lg) 0 var(--sp-8);
}

.sec-head h3 {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
}

.sec-hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.empty {
  padding: var(--sp-12) 0;
  font-size: var(--fs-subhead);
  color: var(--text-3);
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--gap-tight);
}

.dev {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  width: 100%;
  min-height: var(--control-md);
  padding: var(--sp-8) var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-inset);
  text-align: left;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.dev.on {
  background: var(--ok-soft);
}

.dev-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--sp-32);
  height: var(--sp-32);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  flex: none;
}

.dev-txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-right: auto;
}

.dev-txt b {
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dev-txt em {
  font-size: var(--fs-caption);
  color: var(--text-3);
  font-style: normal;
}

.foot-tip {
  margin-top: var(--gap-lg);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--text-3);
}

.spin {
  animation: rein-spin 0.9s linear infinite;
}
</style>
