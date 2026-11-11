<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Maximize2, Minimize2, MoreHorizontal, Pause, Play, SkipForward, X } from 'lucide-vue-next'

import type { GlobalFloatSnapshot } from '@/types'

/**
 * 桌面系统浮窗 · 专注卡面（360×450）。
 *
 * 与程序内浮条（FocusFloatContent）是两条渲染路径：浮条是横条，卡面只服务桌面
 * 「一眼看」——刻度环 + 分钟读数 + 下一段。两边的业务动作仍只发 GlobalFloatAction，
 * 状态机只在主窗口；这里的「显示剩余/已用」是纯本地偏好（localStorage），不上报。
 */
const props = defineProps<{ snapshot: GlobalFloatSnapshot; liveSec: number | null }>()
const emit = defineEmits<{
  primary: []
  park: []
  close: []
  immerse: []
  skipPhase: []
  end: [option: string]
}>()

const DISPLAY_KEY = 'rein.float.focus.display.v1'

function readDisplay(): boolean {
  try {
    return localStorage.getItem(DISPLAY_KEY) !== 'elapsed'
  } catch {
    return true
  }
}

const showRemaining = ref(readDisplay())
const menuOpen = ref(false)
const confirmOpen = ref(false)

function setRemaining(next: boolean): void {
  showRemaining.value = next
  menuOpen.value = false
  try {
    localStorage.setItem(DISPLAY_KEY, next ? 'remaining' : 'elapsed')
  } catch {
    /* 存不了偏好不影响读数 */
  }
}

watch(
  () => props.snapshot.kind,
  () => {
    menuOpen.value = false
    confirmOpen.value = false
  },
)

const clock = computed(() => props.snapshot.clock)
const down = computed(() => clock.value?.direction !== 'up')
const sec = computed(() => Math.max(0, props.liveSec ?? clock.value?.baseSec ?? 0))
const total = computed(() => Math.max(0, props.snapshot.phaseTotalSec ?? 0))

/** 大读数：倒计时默认剩余分钟（向上取整，25:00 → 25）；切到已用则向下取整 */
const minutes = computed(() => {
  if (!down.value) return Math.max(0, Math.floor(sec.value / 60))
  if (showRemaining.value) return Math.max(0, Math.ceil(sec.value / 60))
  return Math.max(0, Math.floor(Math.max(0, total.value - sec.value) / 60))
})

const pct = computed(() => {
  if (!down.value || total.value <= 0) return 0
  return Math.min(1, Math.max(0, 1 - sec.value / total.value))
})

/** 60 格刻度：0° 在 3 点钟方向，顺时针 */
const ticks = computed(() =>
  Array.from({ length: 60 }, (_, i) => ({ i, on: i / 60 < pct.value })),
)

const marker = computed(() => {
  const a = pct.value * Math.PI * 2
  return {
    x: 120 + 112 * Math.cos(a),
    y: 120 + 112 * Math.sin(a),
    deg: pct.value * 360,
  }
})

const title = computed(() => {
  const totalRounds = props.snapshot.roundTotal
  const round = props.snapshot.roundIndex
  return totalRounds && round
    ? `专注时间段（第 ${round} 个/共 ${totalRounds} 个）`
    : '专注时间段'
})

const primary = computed(() => props.snapshot.primary)
const running = computed(() => primary.value?.id === 'pause')
const nextLine = computed(() => {
  if (props.snapshot.nextLabel) return `下一个：${props.snapshot.nextLabel}`
  if (props.snapshot.estimatedEnd) return `预计 ${props.snapshot.estimatedEnd} 结束`
  return props.snapshot.tone === 'break' ? '休息一下' : '专注中'
})

const endSheet = computed(() => props.snapshot.end?.sheet ?? null)

function openEnd(): void {
  if (!endSheet.value) return
  menuOpen.value = false
  confirmOpen.value = true
}

function pickEnd(id: string): void {
  confirmOpen.value = false
  emit('end', id)
}
</script>

<template>
  <div class="ffc" :class="{ 'menu-open': menuOpen }">
    <header class="ffc-head">
      <button type="button" class="ffc-ico" aria-label="收起为浮钮" @click="emit('park')">
        <Minimize2 :size="17" :stroke-width="2.2" />
      </button>
      <span class="ffc-title">{{ title }}</span>
      <button type="button" class="ffc-ico" aria-label="关闭浮窗" @click="emit('close')">
        <X :size="17" :stroke-width="2.2" />
      </button>
    </header>

    <div class="ffc-ring-wrap">
      <svg class="ffc-ring" viewBox="0 0 240 240" aria-hidden="true">
        <line
          v-for="t in ticks"
          :key="t.i"
          x1="120"
          y1="8"
          x2="120"
          y2="17"
          class="ffc-tick"
          :class="{ on: t.on }"
          :transform="`rotate(${t.i * 6 + 90} 120 120)`"
        />
        <rect
          class="ffc-marker"
          :x="marker.x - 6"
          :y="marker.y - 2"
          width="12"
          height="4"
          rx="2"
          :transform="`rotate(${marker.deg} ${marker.x} ${marker.y})`"
        />
      </svg>
      <div class="ffc-read">
        <b class="num">{{ minutes }}</b>
        <span>{{ down && !showRemaining ? '分钟已用' : '分钟' }}</span>
      </div>
    </div>

    <div class="ffc-acts">
      <button
        v-if="primary"
        type="button"
        class="ffc-main"
        :aria-label="primary.label"
        @click="emit('primary')"
      >
        <component :is="running ? Pause : Play" :size="20" :stroke-width="2.4" />
      </button>
      <button
        type="button"
        class="ffc-more"
        aria-label="更多操作"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <MoreHorizontal :size="18" :stroke-width="2.4" />
      </button>
    </div>

    <p class="ffc-next">{{ nextLine }}</p>

    <!-- 点空白处收起菜单：整卡的透明层压在内容上、菜单再压它 -->
    <div v-if="menuOpen" class="ffc-menu-scrim" @click="menuOpen = false" />
    <div v-if="menuOpen" class="ffc-menu" role="menu">
      <button v-if="down" type="button" class="ffc-mi" role="menuitemcheckbox" :aria-checked="showRemaining" @click="setRemaining(!showRemaining)">
        <Check :size="16" :class="{ 'ffc-check': showRemaining }" />
        显示剩余时间
      </button>
      <button v-if="down" type="button" class="ffc-mi" @click="menuOpen = false; emit('skipPhase')">
        <SkipForward :size="16" />
        {{ snapshot.tone === 'break' ? '跳过休息' : '跳到休息' }}
      </button>
      <button v-if="snapshot.canImmersive" type="button" class="ffc-mi" @click="menuOpen = false; emit('immerse')">
        <Maximize2 :size="16" />
        进入沉浸模式
      </button>
      <hr />
      <button v-if="endSheet" type="button" class="ffc-mi danger" @click="openEnd">
        <X :size="16" />
        结束专注
      </button>
    </div>

    <!-- 结束确认：留在卡内，不把窗口撑成另一档高度 -->
    <div v-if="confirmOpen && endSheet" class="ffc-confirm">
      <div class="ffc-confirm-card">
        <p class="ffc-confirm-title">{{ endSheet.title }}</p>
        <div class="ffc-confirm-acts">
          <button type="button" class="ffc-cbtn cancel" @click="confirmOpen = false">取消</button>
          <button
            v-for="a in endSheet.actions"
            :key="a.id"
            type="button"
            class="ffc-cbtn"
            :class="{ danger: a.danger }"
            @click="pickEnd(a.id)"
          >
            {{ a.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ffc {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 var(--sp-16);
  color: var(--text-1);
}

.ffc-head {
  flex: none;
  width: 100%;
  height: 50px;
  display: flex;
  align-items: center;
  gap: var(--sp-6);
}

.ffc-ico {
  width: 30px;
  height: 30px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
}

.ffc-ico:active { background: var(--surface-2); }

.ffc-title {
  flex: 1;
  min-width: 0;
  text-align: center;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.1px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ffc-ring-wrap {
  position: relative;
  width: 240px;
  height: 240px;
  margin-top: 10px;
  flex: none;
  transition: opacity var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out);
}

.ffc.menu-open .ffc-ring-wrap {
  opacity: 0.22;
  filter: blur(1px);
}

.ffc-ring { width: 240px; height: 240px; display: block; }

.ffc-tick {
  stroke: color-mix(in srgb, var(--text-1) 13%, transparent);
  stroke-width: 2.5;
  stroke-linecap: round;
}

.ffc-tick.on { stroke: var(--mod-focus-tone); }

.ffc-marker { fill: var(--accent); }

.ffc-read {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ffc-read b {
  font-size: 48px;
  font-weight: var(--fw-light);
  letter-spacing: -1.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.ffc-read span {
  margin-left: 3px;
  align-self: center;
  font-size: var(--fs-callout);
  color: var(--text-2);
}

.ffc-acts {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  margin-top: 10px;
}

.ffc-main {
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  box-shadow: 0 6px 16px rgba(0, 98, 214, 0.32);
}

.ffc-more {
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-2);
  box-shadow: var(--shadow-float);
}

.ffc-next {
  flex: none;
  margin: auto 0 0;
  padding-bottom: 18px;
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

/* ---------- 菜单 ---------- */
.ffc-menu-scrim {
  position: absolute;
  inset: 0;
  z-index: 2;
}

.ffc-menu {
  position: absolute;
  left: 50%;
  bottom: 158px;
  z-index: 3;
  width: 236px;
  transform: translateX(-50%);
  padding: 4px;
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  -webkit-backdrop-filter: blur(30px) saturate(1.6);
  backdrop-filter: blur(30px) saturate(1.6);
  box-shadow:
    inset 0 0 0 0.5px rgba(255, 255, 255, 0.6),
    var(--shadow-float-lift);
}

.ffc-mi {
  width: 100%;
  height: 40px;
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  padding: 0 var(--sp-10);
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-1);
  font-family: inherit;
  font-size: var(--fs-callout);
  text-align: left;
}

.ffc-mi:active { background: var(--surface-2); }

.ffc-mi svg { color: var(--text-2); flex: none; }
.ffc-check { color: var(--accent) !important; }
.ffc-mi.danger { color: var(--danger); }
.ffc-mi.danger svg { color: var(--danger); }

.ffc-menu hr {
  height: 0.5px;
  margin: 4px 8px;
  border: 0;
  background: var(--line-strong);
}

/* ---------- 结束确认 ---------- */
.ffc-confirm {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-16);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}

.ffc-confirm-card {
  width: 100%;
  padding: var(--sp-16);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-float-lift);
}

.ffc-confirm-title {
  margin: 0 0 var(--sp-12);
  font-size: var(--fs-subhead);
  line-height: var(--lh-body);
  color: var(--text-2);
}

.ffc-confirm-acts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-8);
}

.ffc-cbtn {
  height: 42px;
  border: 0;
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  color: var(--text-1);
  font-family: inherit;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.ffc-cbtn.cancel { color: var(--text-2); }
.ffc-cbtn.danger { background: var(--danger-soft); color: var(--danger-strong); }

.ffc-cbtn:active { transform: scale(0.985); }
</style>
