<script setup lang="ts">
/**
 * 全局浮窗（三级页，入口在「设置 › 功能 › 全局浮窗」）。
 *
 * 为什么从设置页里那张卡搬出来：开关本身只有一行，但「为什么没出现」「手机要授哪个权限」
 * 需要一套带步骤的教程才说得清。卡片放不下教程，教程也不该和番茄钟 / 同步这些配置项挤在
 * 同一屏里 —— 单独一页，开关与授权流程放在一起，用户从入口进来就是来办这一件事的。
 *
 * 状态判定仍然只在 `system/globalFloat`：本页不判断平台能不能浮，只把快照如实印出来。
 * 「未授权」不是失败，是承诺过的降级 —— 程序内浮条照常工作，这一页负责把这一点说清楚。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { Check, Monitor, Pin, ShieldAlert, Timer } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { isTauri } from '@/services/transport'
import {
  floatEnabled,
  floatStateText,
  floatStatus,
  globalFloat,
  isAndroidShell,
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
const stateText = floatStateText

const note = computed(() => {
  if (!isTauri) return '纯浏览器预览没有系统浮窗；桌面端与手机会在离开应用后，把正在进行的专注与训练浮在最上层。'
  if (!floatStatus.value.supported) return '本机不支持系统浮窗，沉浸会话只在程序内显示 —— 功能不受影响。'
  if (!floatStatus.value.permitted) {
    return '还没有「在其他应用上显示」权限。授权之前，专注与训练只在程序内显示（与现在完全一样）。'
  }
  if (!floatEnabled.value) return '关闭后只在程序内显示浮窗（现在的行为）。'
  return '离开应用后，正在进行的专注与训练会浮在其他应用之上；一回到应用就收起，只剩程序内浮条。'
})

/** Android 授权状态（桌面端恒为已授权，不单独显示） */
const permissionText = computed(() => (floatStatus.value.permitted ? '已授权' : '未授权'))

/** Android 的四步教程：开关 → 跳系统页 → 找到 Rein → 回来确认 */
const androidSteps = [
  {
    title: '先打开上面的开关',
    desc: '开关是应用这一侧的总闸；权限是系统那一层，两者都打开才会出现浮窗。',
  },
  {
    title: '点「去系统设置授权」',
    desc: '真机页面上有这颗按钮，会跳到系统的「在其他应用上显示」页面。也可以自己走 系统设置 › 应用 › Rein › 特殊权限。',
  },
  {
    title: '在列表里找到 Rein 并打开',
    desc: '不同手机叫法不同：在其他应用上显示 / 显示悬浮窗 / 悬浮窗 / 显示在其他应用的上层。',
  },
  {
    title: '回到 Rein 确认状态',
    desc: '本页状态变成「已授权」即生效。开始一次专注或训练，离开应用就能在系统最上层看到浮窗。',
  },
]

/** 桌面端没有系统授权这一步，教程换成「怎么看到它」 */
const desktopSteps = [
  {
    title: '打开上面的开关',
    desc: '桌面端不需要额外授权；开关是唯一的总闸。',
  },
  {
    title: '开始一次专注或训练',
    desc: '没有进行中的会话时，浮窗不会出现 —— 它只负责把正在跑的东西留在视野里。',
  },
  {
    title: '最小化 Rein 或切到别的窗口',
    desc: '浮窗会出现在屏幕右下角，置顶显示，也不占任务栏。',
  },
  {
    title: '回到 Rein',
    desc: '浮窗立即收起，由程序内浮条接着显示；两处永远不会同时出现。',
  },
]

const unsupportedNote = computed(() => {
  if (!isTauri) {
    return '浏览器预览没有系统浮窗能力。真正的浮窗只在桌面端与 Android 手机上出现；这一页仍可查看开关与授权流程。'
  }
  return '本机不支持系统浮窗（Android 需要 6.0 以上）。专注与训练仍在程序内显示，计时与记录不受影响。'
})
</script>

<template>
  <div class="page">
    <PageHeader title="全局浮窗" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 功能开关：卡头状态 + 说明 + 开关。状态短语与设置页入口同源（system/globalFloat）。 -->
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
      <div class="rows">
        <div class="row between srow">
          <span class="col stxt">
            <b class="slabel">把进行中的会话浮在最上层</b>
            <em class="t-3">关闭后只在程序内显示浮条</em>
          </span>
          <ToggleSwitch v-model="enabled" label="全局浮窗" />
        </div>
      </div>
    </section>

    <!-- 权限开关教程：Android 是「系统授权怎么开」，桌面端是「怎么看到它」。
         两端共用一个步骤容器，只是步骤内容与收尾动作不同。 -->
    <section v-if="available && isAndroidShell" class="card">
      <header class="row ghead">
        <h2 class="gtitle">权限开关教程</h2>
        <span class="gstate t-2">{{ permissionText }}</span>
      </header>
      <p class="pnote t-2">
        Android 的系统浮层要额外过一道系统权限。没授权时，开关打开也只在程序内显示浮条。
      </p>
      <ol class="steps">
        <li v-for="step in androidSteps" :key="step.title" class="step">
          <span class="col steptxt">
            <b>{{ step.title }}</b>
            <em class="t-2">{{ step.desc }}</em>
          </span>
        </li>
      </ol>
      <button v-if="needPermission" class="auth-btn" type="button" @click="requestFloatPermission()">
        <ShieldAlert :size="16" />
        去系统设置授权
      </button>
      <p v-else class="granted row">
        <Check :size="16" />
        已获得「在其他应用上显示」权限，开关打开时离开应用就会出现浮窗
      </p>
    </section>

    <section v-else-if="available" class="card">
      <header class="row ghead">
        <h2 class="gtitle">使用步骤</h2>
        <span class="gstate t-2">无需授权</span>
      </header>
      <p class="pnote t-2">桌面端不需要系统授权；打开开关，按下面四步就能看到浮窗。</p>
      <ol class="steps">
        <li v-for="step in desktopSteps" :key="step.title" class="step">
          <span class="col steptxt">
            <b>{{ step.title }}</b>
            <em class="t-2">{{ step.desc }}</em>
          </span>
        </li>
      </ol>
    </section>

    <!-- 浏览器 / 老系统：把「为什么这里没有教程」讲清楚，而不是留一张空卡。
         浏览器预览额外展开一遍 Android 的授权流程（只读、不可点），
         这样在桌面开发时也能一眼看到真机上的完整引导。 -->
    <section v-else class="card">
      <h2 class="gtitle">本机能力</h2>
      <p class="pnote t-2">{{ unsupportedNote }}</p>
      <template v-if="!isTauri">
        <h3 class="preview-title">Android 真机上的授权流程</h3>
        <ol class="steps">
          <li v-for="step in androidSteps" :key="step.title" class="step">
            <span class="col steptxt">
              <b>{{ step.title }}</b>
              <em class="t-2">{{ step.desc }}</em>
            </span>
          </li>
        </ol>
      </template>
    </section>

    <!-- 出现与收起：三条边界条件，避免用户以为「开了就该一直显示」 -->
    <section v-if="available" class="card">
      <h2 class="gtitle">出现与收起</h2>
      <div class="rows">
        <div class="trow row">
          <i class="fic"><Timer :size="17" /></i>
          <span class="col ftxt">
            <b>只在会话进行中</b>
            <small>专注或训练结束后立即消失，空闲时不占屏幕。</small>
          </span>
        </div>
        <div class="trow row">
          <i class="fic"><Monitor :size="17" /></i>
          <span class="col ftxt">
            <b>离开应用才出现</b>
            <small>桌面失焦 / 最小化、手机切到别的 App 时出现；回到 Rein 就收起。</small>
          </span>
        </div>
        <div class="trow row">
          <i class="fic"><Pin :size="17" /></i>
          <span class="col ftxt">
            <b>和程序内浮条同一份</b>
            <small>暂停 / 继续 / 结束的文案与动作完全一致，不会两处同时出现。</small>
          </span>
        </div>
      </div>
    </section>
    </div>
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

/* 开关行：与设置页「结束提示音」同一节奏（48 行高） */
.rows {
  display: flex;
  flex-direction: column;
  margin-top: var(--gap-md);
}

.srow {
  min-height: var(--row-h);
  padding: 0;
  border-top: 0.5px solid var(--line);
}

.stxt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.slabel {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}

.stxt em {
  font-style: normal;
  font-size: var(--fs-caption);
}

/* 教程步骤：编号由 counter 生成，步骤增删不用改文案里的数字 */
.steps {
  list-style: none;
  counter-reset: step;
  margin: var(--gap-md) 0 0;
  padding: 0;
}

/* 浏览器预览里的只读教程标题：比卡头低一档，明确是「参考流程」而不是本机操作 */
.preview-title {
  margin-top: var(--gap-md);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.step {
  counter-increment: step;
  display: flex;
  align-items: flex-start;
  gap: var(--gap-md);
  padding: var(--sp-10) 0;
}

.step + .step {
  border-top: 0.5px solid var(--line);
}

.step::before {
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

.steptxt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.steptxt b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.steptxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

/* 去授权：本页唯一的主动作，整行宽、44 高，比行尾小胶囊更好按 */
.auth-btn {
  width: 100%;
  min-height: var(--hit-min);
  margin-top: var(--gap-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  border: none;
  border-radius: var(--radius-s);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.granted {
  margin-top: var(--gap-sm);
  gap: var(--gap-tight);
  color: var(--ok-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

/* 「出现与收起」三行：图标章 + 标题/说明，行高 48，行间发丝线 */
.trow {
  min-height: var(--row-h);
  gap: var(--gap-md);
  padding: var(--sp-8) 0;
}

.trow + .trow {
  border-top: 0.5px solid var(--line);
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

.ftxt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.ftxt small {
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}
</style>
