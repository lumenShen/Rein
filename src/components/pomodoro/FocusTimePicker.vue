<script setup lang="ts">
import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { usePomodoroStore } from '@/stores/pomodoro'

/**
 * 专注设置抽屉。
 *
 * 直接写 store 的 `settings`（不经中间副本、也不带「保存」按钮）：这些参数都是
 * 「立刻生效」的量 —— 抽屉一关就该按新值起跑。中间副本反而会造出「改了但没落盘」
 * 的中间态，用户关掉抽屉时会以为已经生效。store 的 deep watch 负责落 localStorage。
 *
 * `1 / 5` 的步长不是随手取的：专注时长按 5 分钟一档（番茄工作法里 25/30/45/50 都是
 * 5 的倍数），休息按 1 分钟一档（短休息本来就短，5 分钟一档迈不开步）。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const pomo = usePomodoroStore()
</script>

<template>
  <SheetModal :open="props.open" title="专注设置" initial-snap="medium" @close="emit('close')">
    <div class="rows">
      <NumberStepper
        v-model="pomo.settings.focusMin"
        label="专注时长"
        :step="5"
        :min="5"
        :max="120"
        unit="分钟"
      />
      <NumberStepper
        v-model="pomo.settings.breakMin"
        label="短休息"
        :step="1"
        :min="1"
        :max="30"
        unit="分钟"
      />
      <NumberStepper
        v-model="pomo.settings.longBreakMin"
        label="长休息"
        :step="5"
        :min="5"
        :max="60"
        unit="分钟"
      />
      <NumberStepper
        v-model="pomo.settings.roundsBeforeLongBreak"
        label="长休间隔"
        :step="1"
        :min="2"
        :max="8"
      />
      <!-- 最长暂停：值 0 的含义与其它几项相反（0 = 不限制，而不是「零分钟」），
           所以它必须带一句就地可见的说明 —— 只靠抽屉标题说不清 -->
      <div class="frow">
        <NumberStepper
          v-model="pomo.settings.maxPauseMin"
          label="最长暂停"
          :step="1"
          :min="0"
          :max="60"
          unit="分钟"
        />
        <div class="subrow">
          <p class="sub">0 = 不限制；暂停累计超过它自动结束本段</p>
          <InfoHint title="最长暂停">
            <p>暂停是「离开一下」，但一离开就忘了回来、让这一段永远挂在计时里，同样会污染记录。</p>
            <p>所以暂停时间按累计计算：一段专注里多次暂停加起来超过这个上限，就按「提前结束本段」处理 —— 专注记中断段（实际投入 ≥ 1 分钟才写），休息则直接跳过。</p>
            <p>填 0 表示不限制，暂停不会自动结束本段。</p>
          </InfoHint>
        </div>
      </div>
      <div class="row between trow">
        <span class="tlabel">结束提示音</span>
        <ToggleSwitch v-model="pomo.settings.chime" label="结束提示音" />
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.rows {
  display: flex;
  flex-direction: column;
}

/* 行之间一条发丝线（与设置页同一语法）；抽屉里行数不多，不需要分组标题 */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

.frow {
  display: flex;
  flex-direction: column;
}

/* 说明跟着它说明的那一行走，所以不吃上面的行分隔线（它在 .frow 之内）。
   说明 + 帮助入口同一行：结论留在行上，口径/算法收进帮助抽屉（InfoHint 的判据）。 */
.subrow {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-tight);
  /* 说明贴着它说明的那一行：上 -2（与行内文字顶齐）、下 6（下一行之前） */
  margin: calc(-1 * var(--gap-text)) 0 var(--sp-6);
}

/* 说明行：走 --text-2 而不是三级灰 —— 它是用户要照着做的一句话
   （「0 = 不限制」不说清就会被读成「不许暂停」），三级灰是「补充」档，不该放指令 */
.sub {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
  text-wrap: balance;
}

.trow {
  /* 设置行：12 上下 + 一行控件 ≈ 56（比 48 松一档，因为下面还挂着一行说明） */
  padding: var(--sp-12) 0;
}

.tlabel {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
}
</style>
