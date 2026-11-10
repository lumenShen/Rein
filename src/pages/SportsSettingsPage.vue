<script setup lang="ts">
import { Dumbbell, Footprints } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'

/**
 * 运动设置（`/sports/settings`，入口 = 运动页页头齿轮）。
 *
 * 只有两条：跑步设置（自动暂停 + 后台记录状态与两篇权限教程）与课程设置
 * （训练准备时长）。两条并成一张清单，页底说明「这些旋钮只影响运动模块」——
 * 设置页不再承载运动配置，免得同一项在两处各改一份。
 */
</script>

<template>
  <div class="page" data-testid="sports-settings-page">
    <PageHeader title="运动设置" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <!-- 桌面 d-full：只有两行，摊半栏会显得空 -->
      <section class="card d-full">
        <div class="rows">
          <SettingsRow
            title="跑步设置"
            subtitle="自动暂停 · 后台记录 · 锁屏保活"
            :icon="Footprints"
            accent="--mod-sports"
            to="/sports/settings/run"
            testid="sports-settings-run"
          />
          <SettingsRow
            title="课程设置"
            subtitle="训练准备时长、课程与动作"
            :icon="Dumbbell"
            accent="--mod-sports"
            to="/sports/settings/course"
            testid="sports-settings-course"
          />
        </div>
      </section>

      <p class="pnote t-2">这些设置只影响运动模块，随时可以改；改完从下一次训练 / 跑步生效。</p>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 行组：行与行之间画一条发丝线，读起来是一张清单而不是两组入口。
   首行不留线；行高由 SettingsRow 自己按有没有副标给 64 / 48。 */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

/* 页底说明：属于要读的正文，12 字号配正文行高 */
.pnote {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}
</style>
