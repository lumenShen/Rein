<script setup lang="ts">
import { computed, ref } from 'vue'
import { Merge, RefreshCw, ShieldCheck, Sparkles } from 'lucide-vue-next'

import AppMenu from '@/components/common/AppMenu.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import { usePlanStore } from '@/stores/plan'
import { useToast } from '@/composables/useToast'

/**
 * 内置课程新版本横幅：版本升级时不再自动覆盖用户数据，改为三选一。
 *  - 合并新版（推荐）：新种子按动作字段级合并进本地内置课，用户设置过的值全部保留；
 *  - 整体换成新版：内置课内容整体替换为新种子（不可回退，按 AppMenu 的 danger 语义标出）；
 *  - 暂不更新：本版本不再刷新内置课内容，下个种子版本再问。
 * 三种做法各自会发生什么收进标题行右侧 InfoHint，横幅上只留一行结论。
 */
const planStore = usePlanStore()
const { toast } = useToast()

const sheetOpen = ref(false)
const busy = ref(false)
/** 菜单锚点：横幅里那颗「更新」——bind 菜单要贴着它弹 */
const optBtn = ref<HTMLElement | null>(null)

/** 三种做法的后果：摊在横幅上没人读，收进 InfoHint 抽屉 */
const OPTION_HINT = `合并新版（推荐）：保留你在内置课上的全部修改，只并入新种子新增的内容。

整体换成新版：内置课内容整体替换为新种子，你改过的内容会被覆盖，且无法撤销。

暂不更新：本版本不刷新内置课内容，下个种子版本再问。`

const SUMMARY = computed(() => {
  const s = planStore.seed
  return s ? `内置课程有更新（${s.currentVersion} → ${s.latestVersion}）` : '内置课程有更新'
})

async function run(fn: () => Promise<void>, ok: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await fn()
    toast(ok)
  } finally {
    busy.value = false
  }
}

function onPick(value: string): void {
  sheetOpen.value = false
  if (value === 'migrate') void run(planStore.applySeedMigrate, '已按你的数据合并新版课程')
  else if (value === 'override') void run(planStore.applySeedOverride, '已使用新版内置课程')
  else if (value === 'keep') void run(planStore.applySeedKeep, '已保留你的课程')
}

/** 三选一是平级命令（怎么应用更新），不是破坏性确认 —— 走 bind 菜单，图标 + 文字。
 *  「整体换成新版」不可回退（seed.rs 对内置课无条件 UPDATE），单独标 danger。 */
const ACTIONS = [
  { label: '合并新版（推荐）', value: 'migrate', icon: Merge },
  { label: '整体换成新版', value: 'override', icon: RefreshCw, danger: true },
  { label: '暂不更新', value: 'keep', icon: ShieldCheck },
]
</script>

<template>
  <div v-if="planStore.seedPending" class="banner">
    <div class="row center iconbox">
      <Sparkles :size="20" />
    </div>
    <div class="flex-1 col text">
      <!-- 三种做法的后果在标题行 InfoHint 里；横幅只留一行结论与「更新」入口 -->
      <p class="title row center">
        {{ SUMMARY }}
        <InfoHint class="seedhint" title="三种更新方式" :content="OPTION_HINT" />
      </p>
      <p class="desc">不会自动覆盖，由你选一种方式</p>
    </div>
    <button ref="optBtn" class="opt" :disabled="busy" @click="sheetOpen = true">更新</button>

    <!-- 贴着「更新」弹的 bind 菜单：三项平级、都能反悔（不改数据的那项排在最后） -->
    <AppMenu
      :open="sheetOpen"
      :anchor="optBtn"
      title="如何应用新版内置课程？"
      :actions="ACTIONS"
      @select="onPick"
      @close="sheetOpen = false"
    />
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  margin-bottom: var(--sp-14);
  padding: var(--sp-14);
  border-radius: var(--radius-l);
  /* 底色走令牌（运动域 soft + 主色 soft）：写死 rgba 的那版会跟换档分叉 */
  background: linear-gradient(135deg, var(--c-exercise-soft), var(--accent-soft));
  border: 1px solid var(--line);
}

.iconbox {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-m);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.text {
  gap: var(--gap-text);
  min-width: 0;
}

.title {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  gap: var(--gap-tight);
}

.seedhint {
  margin-left: auto;
}

.desc {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.opt {
  flex: none;
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}
</style>
