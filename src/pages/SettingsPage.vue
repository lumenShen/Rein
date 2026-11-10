<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Link2, MonitorSmartphone, Palette, Pin, RefreshCw, ToggleLeft, Trash2 } from 'lucide-vue-next'

import DataClearSheet from '@/components/settings/DataClearSheet.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import { toggleablePlugins } from '@/plugins'
import { isTauri } from '@/services/transport'
import { useFeaturesStore } from '@/stores/features'
import { useUpdateStore } from '@/stores/update'
import { floatEnabled, floatStatus, refreshFloatStatus } from '@/system/globalFloat'

/**
 * 设置（二级内容页）：三组极简结构 —— 能力与连接 / 通用 / 关于。
 *
 * 组标签在卡外（参考图 04），每组一张卡、卡内一行一个入口。本页只负责指路与
 * 状态摘要；各模块的可调参数留在自己的页面里，避免两处真源。
 */
const update = useUpdateStore()
const features = useFeaturesStore()

/** 同步模块关掉时「设备」行整行收起：配置项是那个模块的旋钮，模块不在就没有可调的对象 */
const syncOn = computed(() => features.isEnabled('sync'))

/** 清除软件数据抽屉（四档深度 + 两段确认，见 DataClearSheet） */
const clearOpen = ref(false)

/** 功能行副标：列出可开关模块，一眼看到有哪些功能可关 */
const featureNames = computed(() => toggleablePlugins().map((p) => p.name).join(' · '))

/** 全局浮窗入口副标：入口这一行就说清「现在是什么状态」，不必点进去才知道 */
const floatHint = computed(() => {
  if (!isTauri) return '浏览器预览不支持系统浮窗'
  if (!floatStatus.value.supported) return '本机不支持 · 仍用程序内浮条'
  if (!floatEnabled.value) return '已关闭 · 只在程序内显示'
  if (!floatStatus.value.permitted) return '未授权「在其他应用上显示」'
  return floatStatus.value.visible ? '浮窗显示中' : '已开启 · 离开应用时出现'
})

/** 副标：把「有没有新版本」直接写在行里，不必进页面才知道 */
const updateHint = computed(() => {
  if (update.hasUpdate) return `发现新版本 v${update.check?.latestVersion}`
  if (update.check) return `已是最新 v${update.currentVersion}`
  return `当前 v${update.currentVersion || '—'}`
})

onMounted(() => {
  // 只在本地读一次快照，不触发联网：设置页不该因为网络慢而卡
  if (!update.snapshot) void update.load()
  // 入口副标要报真实状态（权限可能刚在系统设置里改过）
  void refreshFloatStatus()
})
</script>

<template>
  <div class="page">
    <PageHeader title="设置" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 能力与连接：连接应用 / 设备 / 功能开关 / 全局浮窗 -->
    <section class="sgroup d-full" data-testid="settings-group-capability">
      <h2 class="gtitle">能力与连接</h2>
      <div class="card rows d-full">
        <SettingsRow
          title="连接应用"
          subtitle="安卓、Windows 的数据与操作"
          :icon="Link2"
          :to="{ name: 'settings-apps' }"
          testid="settings-row-apps"
        />
        <SettingsRow
          v-if="syncOn"
          title="设备"
          subtitle="端到端加密同步，服务器不存内容"
          :icon="MonitorSmartphone"
          :to="{ name: 'settings-sync' }"
          testid="settings-row-devices"
        />
        <SettingsRow
          title="打开或关闭功能"
          :subtitle="featureNames"
          :icon="ToggleLeft"
          :to="{ name: 'settings-features' }"
          testid="settings-row-features"
        />
        <!-- 全局浮窗：开关本身一行就够，但权限教程需要一页；这里只留入口与当下状态 -->
        <SettingsRow
          title="全局浮窗"
          :subtitle="floatHint"
          :icon="Pin"
          :to="{ name: 'settings-float' }"
          testid="settings-float-entry"
        />
      </div>
    </section>

    <!-- 通用：外观与性能（画质 + 动效）/ 数据清除 -->
    <section class="sgroup d-full" data-testid="settings-group-general">
      <h2 class="gtitle">通用</h2>
      <div class="card rows d-full">
        <SettingsRow
          title="外观与性能"
          subtitle="画质与动效档位"
          :icon="Palette"
          :to="{ name: 'settings-appearance' }"
          testid="settings-row-appearance"
        />
        <!-- 数据：分层清除（缓存 / AI 会话 / 业务数据 / 恢复出厂），危险区入口用危险色 -->
        <SettingsRow
          title="清除软件数据"
          subtitle="四档由浅到深，先列清单再确认"
          :icon="Trash2"
          accent="--danger"
          testid="settings-data-clear"
          @click="clearOpen = true"
        />
      </div>
    </section>

    <!-- 关于：软件更新（本页不再承载通知设置，通知开关留在各功能页） -->
    <section class="sgroup d-full" data-testid="settings-group-about">
      <h2 class="gtitle">关于</h2>
      <div class="card rows d-full">
        <SettingsRow
          title="软件更新"
          :subtitle="updateHint"
          :icon="RefreshCw"
          :to="{ name: 'settings-update' }"
          testid="settings-row-update"
        />
      </div>
    </section>
    </div>

    <!-- 清除软件数据：选档 → 真实统计清单 → 长按确认（两段确认都在抽屉里完成） -->
    <DataClearSheet :open="clearOpen" @close="clearOpen = false" />
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开，
     这里只剩页头与内容之间那一档呼吸 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 页头下缘自带 16 的呼吸余量，首组再补 2，与旧页首个卡片同一条落点 */
.rubber-layer > .sgroup:first-child {
  margin-top: var(--sp-2);
}

/* 组与组之间 24（区块间隔）：组标签是这一页唯一的层级信号，
   比卡与卡之间的 12 拉开一档，三组才不会被读成一张长清单 */
.sgroup + .sgroup {
  margin-top: var(--gap-xl);
}

/* 桌面壳本身是 12 的栅格间距，组间再叠 24 会变成 36；这里补到 24 的区块间隔，
   两种形态下组与组的呼吸一致 */
.desk-main .sgroup + .sgroup {
  margin-top: var(--gap-md);
}

/* 组标签：小号灰字，留在卡外（参考图 04）；左右 4 让它与卡内文字同一条竖线 */
.gtitle {
  margin: 0 0 var(--sp-8);
  padding-inline: var(--sp-4);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

/* 行组：行间画一条发丝线，首行不留线。SettingsRow 的根节点会继承父组件的
   scoped 属性，所以这条规则直接落在每一行上，不必 :deep 穿透 */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}
</style>
