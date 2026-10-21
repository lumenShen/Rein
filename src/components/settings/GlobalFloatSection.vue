<script setup lang="ts">
/**
 * 设置页「全局浮窗」分区（docs/GLOBAL-FLOAT.md）。
 *
 * 只管三件事：开关、能力/权限状态、去授权。真正的显示时机状态机在
 * `system/globalFloat` —— 这一层不判断平台、不碰窗口，只把状态如实印出来：
 * 「未授权」时明确说清楚现在仍是程序内浮窗（降级不是失败，是承诺的兜底）。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { Pin, ShieldAlert } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { isTauri } from '@/services/transport'
import {
  floatEnabled,
  floatStatus,
  globalFloat,
  requestFloatPermission,
  setFloatEnabled,
} from '@/system/globalFloat'

/** 授权页回来时刷新状态（Android 的「在其他应用上显示」不在应用内完成） */
function onVisible(): void {
  if (document.visibilityState === 'visible') void globalFloat.refreshStatus()
}

onMounted(() => {
  void globalFloat.refreshStatus()
  document.addEventListener('visibilitychange', onVisible)
})
onUnmounted(() => document.removeEventListener('visibilitychange', onVisible))

const enabled = computed({
  get: () => floatEnabled.value,
  set: (v: boolean) => {
    setFloatEnabled(v)
    // 打开但还没授权：直接把用户送到系统授权页，省得他先开开关再回来找入口
    if (v && isTauri && floatStatus.value.supported && !floatStatus.value.permitted) {
      void requestFloatPermission()
    }
  },
})

const available = computed(() => isTauri && floatStatus.value.supported)
const needPermission = computed(() => available.value && !floatStatus.value.permitted)

/** 卡头状态：一眼看出「现在到底有没有系统浮窗」 */
const stateText = computed(() => {
  if (!isTauri) return '浏览器预览不支持'
  if (!floatStatus.value.supported) return '本机不支持'
  if (!floatEnabled.value) return '已关闭'
  if (!floatStatus.value.permitted) return '未授权'
  return floatStatus.value.visible ? '浮窗显示中' : '待命'
})

const note = computed(() => {
  if (!isTauri) return '纯浏览器预览没有系统浮窗；桌面端与手机会在离开应用后，把正在进行的专注与训练浮在最上层。'
  if (!floatStatus.value.supported) return '本机不支持系统浮窗，沉浸会话只在程序内显示 —— 功能不受影响。'
  if (!floatStatus.value.permitted) {
    return '还没有「在其他应用上显示」权限。授权之前，专注与训练只在程序内显示（与现在完全一样）。'
  }
  if (!floatEnabled.value) return '关闭后只在程序内显示浮窗（现在的行为）。'
  return '离开应用后，正在进行的专注与训练会浮在其他应用之上；一回到应用就收起，只剩程序内浮条。'
})
</script>

<template>
  <section class="card">
    <header class="row ghead">
      <h2 class="gtitle">全局浮窗</h2>
      <span class="gstate t-2">{{ stateText }}</span>
      <span class="hint-slot">
        <InfoHint title="全局浮窗说明">
          <p>离开应用（桌面端失焦或最小化、手机上切到别的 App）后，正在进行的专注与训练会浮在系统最上层，暂停 / 继续 / 结束都能直接点。</p>
          <p>内容与程序内的浮条同源：同一份文案、同一套按钮，两处不会同时出现，也不会互相抢注意力。</p>
          <p>手机上需要系统的「在其他应用上显示」权限。没授权时自动退回程序内浮窗，计时与记录不受任何影响。</p>
        </InfoHint>
      </span>
    </header>
    <p class="pnote t-2">{{ note }}</p>
    <div class="row between srow">
      <span class="slabel">把进行中的会话浮在最上层</span>
      <ToggleSwitch v-model="enabled" label="全局浮窗" />
    </div>
    <!-- 授权入口只在「支持但没授权」时出现：其余情况这一行没有可做的事 -->
    <button v-if="needPermission" class="frow row" type="button" @click="requestFloatPermission()">
      <i class="fic"><ShieldAlert :size="18" /></i>
      <span class="col ftxt">
        <b>去授权「在其他应用上显示」</b>
        <em class="t-2">系统设置里打开后回到本页即可生效</em>
      </span>
    </button>
    <!-- 没有会话时的能力说明：让用户在会话开始前就知道浮窗长什么样 -->
    <div v-else-if="available && floatStatus.permitted && floatEnabled" class="row frow static">
      <i class="fic on"><Pin :size="18" /></i>
      <span class="col ftxt">
        <b>空闲时不会出现</b>
        <em class="t-2">只有专注或训练进行中、且你离开了应用，浮窗才出现</em>
      </span>
    </div>
  </section>
</template>

<style scoped>
/* 与设置页其它分区同一档：18 Medium 的分区标题 */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

/* 卡头行：标题 + 状态副标 + 右侧帮助入口 */
.ghead {
  gap: var(--gap-sm);
}

.gstate {
  font-size: var(--fs-caption);
}

.hint-slot {
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

.pnote {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* 开关行：与设置页「结束提示音」同一节奏（48 行高、行间由卡内细线分隔） */
.srow {
  min-height: var(--row-h);
  margin-top: var(--gap-md);
  padding: 0;
  border-top: 0.5px solid var(--line);
}

.slabel {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

/* 功能行：图标章 + 标题/说明（与设置页其它分区同构） */
.frow {
  width: 100%;
  gap: var(--gap-md);
  margin-top: var(--gap-md);
  padding: var(--gap-md) 0 0;
  min-height: var(--row-h-double);
  text-align: left;
  color: inherit;
  border-top: 0.5px solid var(--line);
}

/* 说明行不是按钮：去掉按压光标 */
.frow.static {
  cursor: default;
}

.fic {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--text-2);
}

.fic.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.ftxt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.ftxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
