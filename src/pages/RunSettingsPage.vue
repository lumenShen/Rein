<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { BatteryCharging, Bell, Footprints, Gauge, MapPin, RefreshCw, ShieldAlert } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { isTauri } from '@/services/transport'
import { trackingService, type TrackingStatus } from '@/services/trackingService'
import { useRunStore } from '@/stores/run'
import { fmtPace } from '@/utils/format'

/**
 * 跑步设置（`/sports/settings/run`）：自动暂停 + 后台记录状态 + 两篇权限教程。
 *
 * 自动暂停直接读写 `useRunStore().autoPauseOn` —— 本页**不复制**一份本地状态，
 * store 的 watch 负责落 `localStorage`（`rein.run.autoPause.v1`），页面只做绑定。
 *
 * `tracking_status` 是「缓存 + 异步刷新」语义（原生侧初值 granted=false / busy=true），
 * 冷启动首读几乎必然拿到 busy=true 的旧缓存。这里复用 RunPage 的纪律：400ms 重试
 * 最多 5 次，直到 busy=false —— 否则第一眼会把「已授权」误读成「未授权」。
 */
const r = useRunStore()

const trackStatus = ref<TrackingStatus | null>(null)
const statusBusy = ref(false)
const statusFailed = ref(false)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function refreshTrackStatus(): Promise<void> {
  if (statusBusy.value) return
  statusBusy.value = true
  statusFailed.value = false
  try {
    for (let i = 0; i < 5; i += 1) {
      const st = await trackingService.status()
      if (!st.busy) {
        trackStatus.value = st
        return
      }
      await sleep(400)
    }
    // 五次仍未收敛：按最后一次读到的值落状态（busy 与 granted 同读，不会误报「已授权」）
    trackStatus.value = await trackingService.status()
  } catch {
    trackStatus.value = null
    statusFailed.value = true
  } finally {
    statusBusy.value = false
  }
}

onMounted(() => {
  void refreshTrackStatus()
})

/** 没有原生前台服务（桌面 / 浏览器，或本机不支持）时，教程只适用 Android */
const showPlatformNote = computed(() => !isTauri || (trackStatus.value !== null && !trackStatus.value.native))

const grantedText = computed(() => {
  if (!trackStatus.value) return '—'
  return trackStatus.value.granted ? '已授权' : '未授权 · 锁屏后可能中断'
})
const notifyText = computed(() => {
  if (!trackStatus.value) return '—'
  return trackStatus.value.notify ? '已开启' : '未开启 · 锁屏看不到实时进度'
})
const nativeText = computed(() => {
  if (!trackStatus.value) return '—'
  return trackStatus.value.native ? '原生前台服务' : '当前平台无需保活'
})

/* ---------- 教程：两篇都按「编号步骤 + 注脚」，正文放抽屉（与全局浮窗同版式） ---------- */

const tutBackgroundOpen = ref(false)
const tutKilledOpen = ref(false)

const backgroundSteps = [
  {
    title: '位置权限设为「始终」',
    desc: '系统设置 › 应用 › Rein › 权限 › 位置，选择「始终允许」。只给「使用期间」时，锁屏后系统就会停止定位。',
  },
  {
    title: '关闭电池优化',
    desc: '系统设置 › 电池 / 省电 › Rein，选择「无限制」或「不优化」。不同厂商这里叫「允许后台活动」「后台耗电管理」等。',
  },
  {
    title: '允许通知',
    desc: '系统设置 › 应用 › Rein › 通知，允许通知。跑步时的实时进度常驻在通知栏，也是前台服务不被清理的凭据。',
  },
  {
    title: '锁屏测试一次',
    desc: '开跑后锁屏 1 分钟再解锁，回到本页点刷新，「原生保活」应仍显示「原生前台服务」；轨迹不断点就说明设置生效。',
  },
]

const killedSteps = [
  {
    title: '在多任务界面锁定 Rein',
    desc: '打开最近任务，长按或点按 Rein 卡片上的锁形图标，避免一键清理时把跑步进程一起结束。',
  },
  {
    title: '允许自启动 / 后台运行',
    desc: '系统设置 › 应用 › Rein，打开「自启动」「关联启动」「后台运行」这类开关；不同厂商名称略有不同。',
  },
  {
    title: '关闭省电模式',
    desc: '系统设置 › 电池，退出省电 / 超级省电模式；省电模式会限制后台定位与前台服务。',
  },
  {
    title: '被杀后重新打开 Rein',
    desc: '会提示恢复上次记录，按快照接续即可。轨迹文件已经落盘；不要先结束旧记录再重新开跑。',
  },
]
</script>

<template>
  <div class="page" data-testid="run-settings-page">
    <PageHeader title="跑步设置" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <!-- 自动暂停：绑定 store 的唯一真源，改完立即生效 -->
      <section class="card">
        <header class="row ghead">
          <h2 class="gtitle">自动暂停</h2>
          <span class="hint-slot">
            <InfoHint title="自动暂停说明">
              <p>配速慢于当前阈值时自动停表，重新移动并快过阈值后自动继续。</p>
              <p>自动暂停期间不计入时长与配速；站立不动约 10 秒进入。阈值随跑步记录保存，下一次开跑沿用。</p>
            </InfoHint>
          </span>
        </header>
        <div class="rows">
          <SettingsRow
            as="div"
            title="自动暂停"
            :subtitle="`慢于 ${fmtPace(r.autoPausePaceSec)}/km 自动停表，快起来自动继续`"
            :icon="Gauge"
            accent="--mod-sports"
          >
            <ToggleSwitch
              :model-value="r.autoPauseOn"
              label="自动暂停"
              data-testid="run-settings-autopause"
              @update:model-value="r.autoPauseOn = $event"
            />
          </SettingsRow>
        </div>
        <p class="pnote t-2">自动暂停期间不计入时长与配速；站立不动约 10 秒进入，走动后自动恢复。</p>
      </section>

      <!-- 后台记录：三枚状态 + 刷新。没有原生前台服务时只作参考，不假装「已就绪」 -->
      <section class="card" data-testid="run-settings-background">
        <header class="row ghead">
          <h2 class="gtitle">后台记录</h2>
          <span class="hint-slot">
            <InfoHint title="后台记录说明">
              <p>定位授权决定锁屏后还能不能拿到点；通知权限决定锁屏时看不看得到实时进度；原生保活是 Android 的前台服务。</p>
              <p>三枚状态都来自系统与原生服务的快照，刷新后重新读取；状态不会自己猜。</p>
            </InfoHint>
          </span>
        </header>

        <div v-if="statusFailed" class="errbox">
          <p class="pnote t-2">读取不到运行状态。</p>
          <button
            type="button"
            class="retry"
            data-testid="run-settings-status-retry"
            @click="refreshTrackStatus"
          >
            重试
          </button>
        </div>

        <template v-else>
          <div class="srows">
            <div class="srow" data-testid="run-settings-status-granted">
              <span class="slab row"><MapPin :size="16" aria-hidden="true" />定位授权</span>
              <span class="sval" :class="{ good: trackStatus?.granted, warn: trackStatus && !trackStatus.granted }">
                {{ grantedText }}
              </span>
            </div>
            <div class="srow" data-testid="run-settings-status-notify">
              <span class="slab row"><Bell :size="16" aria-hidden="true" />通知权限</span>
              <span class="sval" :class="{ good: trackStatus?.notify, warn: trackStatus && !trackStatus.notify }">
                {{ notifyText }}
              </span>
            </div>
            <div class="srow" data-testid="run-settings-status-native">
              <span class="slab row"><BatteryCharging :size="16" aria-hidden="true" />原生保活</span>
              <span class="sval" :class="{ good: trackStatus?.native }">{{ nativeText }}</span>
            </div>
          </div>

          <p v-if="showPlatformNote" class="banner t-2">
            当前版本没有原生前台服务（桌面 / 浏览器）{{ isTauri ? '，或本机不支持' : '' }}；下面的教程只适用于 Android 手机。
          </p>
          <p v-else-if="trackStatus?.native && !trackStatus.granted" class="pnote t-2">
            先授权定位，保活才会真正生效。
          </p>

          <!-- 刷新放在卡底：页头同排已经有一枚 ?，不再并第二颗图标钮 -->
          <button
            type="button"
            class="status-refresh"
            :disabled="statusBusy"
            data-testid="run-settings-status-refresh"
            @click="refreshTrackStatus"
          >
            <RefreshCw :size="15" :class="{ spin: statusBusy }" aria-hidden="true" />
            {{ statusBusy ? '正在刷新…' : '刷新状态' }}
          </button>
        </template>
      </section>

      <!-- 教程：两行入口各自打开抽屉，抽屉里是编号步骤 + 小字注脚 -->
      <section class="card d-full">
        <h2 class="gtitle">后台教程</h2>
        <p class="pnote t-2">不同厂商的菜单名称略有不同，按关键词找即可；做完回到本页，状态行会自己刷新。</p>
        <div class="rows">
          <SettingsRow
            title="跑步时拿不到后台数据"
            subtitle="熄屏后没有轨迹？检查定位、电池与通知"
            :icon="Footprints"
            accent="--mod-sports"
            testid="run-settings-tutorial-background"
            @click="tutBackgroundOpen = true"
          />
          <SettingsRow
            title="跑步后台被杀"
            subtitle="省电模式或系统清理结束进程后，怎么恢复"
            :icon="ShieldAlert"
            accent="--mod-sports"
            testid="run-settings-tutorial-killed"
            @click="tutKilledOpen = true"
          />
        </div>
      </section>

      <p class="pnote t-2">自动暂停已从开跑准备页移到这里；准备页不再放开关。</p>
    </div>

    <!-- 教程 A：后台拿不到数据 -->
    <SheetModal
      :open="tutBackgroundOpen"
      title="跑步时拿不到后台数据"
      initial-snap="medium"
      @close="tutBackgroundOpen = false"
    >
      <p class="tsum">
        锁屏后 WebView 会主动注销定位，这不是系统限制；原生前台服务负责锁屏后的采集。下面几项都打开，锁屏也能继续记录。
      </p>
      <ol class="tsteps">
        <li v-for="step in backgroundSteps" :key="step.title" class="tstep">
          <span class="col tsteptxt">
            <b>{{ step.title }}</b>
            <em>{{ step.desc }}</em>
          </span>
        </li>
      </ol>
      <p class="tfoot">不同厂商名称略有不同（如「允许后台活动」「无限制」）；做完回到本页，状态行会自己刷新，或点右上角刷新。</p>
    </SheetModal>

    <!-- 教程 B：后台被杀 -->
    <SheetModal
      :open="tutKilledOpen"
      title="跑步后台被杀"
      initial-snap="medium"
      @close="tutKilledOpen = false"
    >
      <p class="tsum">
        被系统清理后，轨迹文件仍然保留；重新打开 Rein 会按上次的快照接续。先把「不被清理」的开关打开，再谈恢复。
      </p>
      <ol class="tsteps">
        <li v-for="step in killedSteps" :key="step.title" class="tstep">
          <span class="col tsteptxt">
            <b>{{ step.title }}</b>
            <em>{{ step.desc }}</em>
          </span>
        </li>
      </ol>
      <p class="tfoot">不同厂商名称略有不同；被清理后重新打开会提示恢复记录，按快照接续即可，不要先结束旧记录再新开。</p>
    </SheetModal>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 与设置页其它分区同一档：18 Medium 的分区标题 */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

/* 卡头行：标题 + 右侧帮助入口 */
.ghead {
  gap: var(--gap-sm);
}

/* 标题行右侧的帮助入口：InfoHint 是多根组件，类要落在包裹元素上 */
.hint-slot {
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

/* 刷新：卡底一条文字按钮，视觉 44 高；与状态行之间用一条发丝线分区 */
.status-refresh {
  width: 100%;
  min-height: var(--hit-min);
  margin-top: var(--gap-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  border-top: 0.5px solid var(--line);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
}

.status-refresh:active {
  color: var(--text-1);
}

.status-refresh:disabled {
  opacity: var(--disabled-opacity);
}

/* 读状态时转一圈：只转图标，不挪布局 */
.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}

/* 行组：行间发丝线，首行不留线 */
.rows {
  margin-top: var(--gap-sm);
}

.rows > * + * {
  border-top: 0.5px solid var(--line);
}

/* 状态行：左标签 + 右读数，48 行高；三行之间发丝线 */
.srows {
  display: flex;
  flex-direction: column;
  margin-top: var(--gap-md);
}

.srow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  min-height: var(--row-h);
}

.srow + .srow {
  border-top: 0.5px solid var(--line);
}

.slab {
  flex: none;
  gap: var(--gap-tight);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.slab svg {
  color: var(--text-3);
  flex: none;
}

.sval {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: var(--fs-footnote);
  line-height: var(--lh-caption);
  color: var(--text-2);
}

.sval.good {
  color: var(--ok-strong);
}

.sval.warn {
  color: var(--warn-strong);
}

/* 没有原生服务时的说明：一条安静的分隔说明，不伪装成错误 */
.banner {
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* 读取失败：整块换成一句说明 + 重试，不伪造状态 */
.errbox {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

.retry {
  min-height: var(--hit-min);
  padding: 0 var(--pad-inline);
  border-radius: var(--radius-s);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

/* 页底说明：12 字号配正文行高 */
.pnote {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* ---------- 教程抽屉（与全局浮窗同一版式） ---------- */

.tsum {
  margin: 0 0 var(--gap-md);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
  color: var(--text-2);
}

/* 编号由 counter 生成，步骤增删不用改文案里的数字 */
.tsteps {
  list-style: none;
  counter-reset: step;
  margin: 0;
  padding: 0;
}

.tstep {
  counter-increment: step;
  display: flex;
  align-items: flex-start;
  gap: var(--gap-md);
  padding: var(--sp-10) 0;
}

.tstep + .tstep {
  border-top: 0.5px solid var(--line);
}

.tstep::before {
  content: counter(step);
  width: 24px;
  height: 24px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}

.tsteptxt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.tsteptxt b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.tsteptxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--text-2);
}

.tfoot {
  margin: var(--gap-md) 0 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--text-3);
}
</style>
