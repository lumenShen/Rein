<script setup lang="ts">
import { ClipboardList, ListChecks } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import { PREP_SEC_MAX, PREP_SEC_MIN, useExercisePrefs } from '@/stores/exercisePrefs'

/**
 * 课程设置（`/sports/settings/course`）：训练准备时长 + 两个课程入口。
 *
 * 准备时长是训练气泡（SessionStageBubble）在每一组 arm() 时读的旋钮，存在
 * localStorage（`rein.exercisePrefs.v1`），不进 SQLite —— 与功能开关同一档的
 * 界面偏好。改完从下一组生效；临时装卸杠铃片由「点气泡暂停」兜着，不必把时长调大。
 */
const prefs = useExercisePrefs()
</script>

<template>
  <div class="page" data-testid="course-settings-page">
    <PageHeader title="课程设置" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <!-- 训练准备时长：单卡（桌面 d-full，半栏会空一半） -->
      <section class="card d-full">
        <header class="row ghead">
          <h2 class="gtitle">训练准备时长</h2>
          <span class="hint-slot">
            <InfoHint title="准备时长说明">
              <p>每组开始前「准备姿势」的倒计时，给摆姿势、握杠留时间；改完从下一组生效。</p>
              <p>临时装卸杠铃片这类等待，点训练里的气泡可以暂停计时，再点一下继续 —— 不必为了这类停顿把准备时长调得很大。</p>
            </InfoHint>
          </span>
        </header>
        <div class="card sub">
          <NumberStepper
            v-model="prefs.prepSec"
            data-testid="course-settings-prep"
            label="准备时长"
            unit="秒"
            :step="1"
            :min="PREP_SEC_MIN"
            :max="PREP_SEC_MAX"
          />
        </div>
        <p class="pnote t-2">改完从下一组训练生效；零散停顿用训练气泡的暂停，比把准备时长调大更准确。</p>
      </section>

      <!-- 课程与动作：两个既有二级页的入口，不在这里复制列表 -->
      <section class="card d-full">
        <h2 class="gtitle">课程与动作</h2>
        <div class="rows">
          <SettingsRow
            title="我的课程"
            subtitle="全部课程、计划与最近使用"
            :icon="ClipboardList"
            accent="--mod-sports"
            to="/sports/plans"
          />
          <SettingsRow
            title="动作库"
            subtitle="课程的唯一动作来源：查看与编辑"
            :icon="ListChecks"
            accent="--mod-sports"
            to="/sports/exercises"
          />
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

/* 卡头与内容之间 8（间隔规范「标题与内容间隔 8vp」） */
.ghead + .card.sub {
  margin-top: var(--gap-sm);
}

/* 准备时长的可见说明：不把「改完什么时候生效」只收进 ? 抽屉 */
.pnote {
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* 入口行组：行间发丝线，首行不留线 */
.rows {
  margin-top: var(--gap-sm);
}

.rows > * + * {
  border-top: 0.5px solid var(--line);
}
</style>
