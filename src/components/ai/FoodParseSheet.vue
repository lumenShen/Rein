<script setup lang="ts">
import { ref, watch } from 'vue'
import { Archive } from 'lucide-vue-next'

import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { MEAL_LABELS, MEAL_ORDER, suggestMeal } from '@/config/domain'
import { recordCardOutcome } from '@/ai/cardOutcomes'
import { useToast } from '@/composables/useToast'
import { useAiStore } from '@/stores/ai'
import { removeFoodDraft, saveFoodDraft, updateFoodDraftItems, type FoodDraft } from '@/utils/foodDrafts'
import type { MealType, ParsedFoodItem } from '@/types'

/**
 * 食物草稿编辑弹层：打开草稿箱条目 → 可编辑解析卡（改重量 / 删行 / 单位换算）
 * → 写入今日饮食或覆盖回草稿。拍照识别已改为走聊天流（AIPage 附件 → 模型看图出卡），
 * 本组件只服务草稿箱入口。
 */
const emit = defineEmits<{ committed: []; savedDraft: [] }>()

const ai = useAiStore()
const toast = useToast()

const open = ref(false)
const thumb = ref<string | null>(null)
const items = ref<ParsedFoodItem[]>([])
const meal = ref<MealType>(suggestMeal())
const stats = ref({ totalKcal: 0, total: 0, matched: 0 })
/** 正在编辑的草稿 id：条目变化自动回写，写入成功后删除草稿 */
const draftId = ref<string | null>(null)

defineExpose({ openDraft })

function reset(): void {
  thumb.value = null
  items.value = []
  draftId.value = null
  meal.value = suggestMeal()
  stats.value = { totalKcal: 0, total: 0, matched: 0 }
}

/** 草稿箱入口：直接进入编辑态 */
function openDraft(d: FoodDraft): void {
  reset()
  thumb.value = d.thumbBase64 ?? null
  items.value = d.items
  draftId.value = d.id
  open.value = true
}

/* 草稿态下的编辑实时回写 */
watch(
  () => items.value.map((it) => `${it.foodName}:${it.grams}:${it.foodId ?? '-'}`).join('|'),
  () => {
    if (draftId.value && open.value) updateFoodDraftItems(draftId.value, items.value)
  },
)

function saveDraft(): void {
  if (items.value.length === 0) return
  saveFoodDraft({ thumbBase64: thumb.value ?? undefined, items: items.value })
  draftId.value = null
  toast.toast('已存入草稿箱')
  emit('savedDraft')
  close()
}

const committing = ref(false)

async function commit(): Promise<void> {
  if (committing.value || stats.value.matched === 0) return
  committing.value = true
  try {
    const r = await ai.commitParsedItems(items.value, meal.value, 'photo_ai')
    if (r.written === 0) {
      toast.toast('没有可写入的食物（全部未匹配食物库）')
      return
    }
    const skipped = items.value.length - r.written
    toast.toast(
      skipped > 0
        ? `已写入 ${r.written} 项，跳过 ${skipped} 项未匹配`
        : `已写入 ${r.written} 项到今日${MEAL_LABELS[meal.value]}`,
    )
    if (draftId.value) removeFoodDraft(draftId.value)
    // 草稿箱里的卡也是 AI 出的：记一条「用户处理了它」，聊天下轮就知道这笔已经记过
    recordCardOutcome(
      'food-draft',
      `从草稿箱写入今日${MEAL_LABELS[meal.value]} ${r.written} 项（${items.value
        .slice(0, 3)
        .map((it) => it.foodName)
        .join('、')}${items.value.length > 3 ? ' 等' : ''}）`,
    )
    emit('committed')
    close()
  } finally {
    committing.value = false
  }
}

function close(): void {
  open.value = false
}
</script>

<template>
  <SheetModal :open="open" title="编辑食物草稿" initial-snap="large" @close="close">
    <div class="ready">
      <div class="sum row">
        <img v-if="thumb" :src="`data:image/jpeg;base64,${thumb}`" alt="照片缩略图" class="mini">
        <p class="flex-1 sum-line">
          <b class="kcal num">≈{{ stats.totalKcal }}<i class="t-unit">大卡</i></b>
          <span v-if="stats.matched > 0" class="sub">
            识别到 {{ stats.total }} 项<span v-if="stats.matched < stats.total">，{{ stats.matched }} 项可写入</span>
          </span>
          <StatusChip v-else-if="stats.total > 0" tone="warn" size="sm">全部未匹配，无法写入</StatusChip>
        </p>
      </div>

      <FoodParseEditor v-model="items" @change="stats = $event" />

      <SegmentedControl
        v-model:model-value="meal"
        class="meal"
        :options="MEAL_ORDER.map((x) => ({ value: x, label: MEAL_LABELS[x] }))"
      />

      <div class="acts row between">
        <button class="ghost row center" :disabled="!items.length" @click="saveDraft">
          <Archive :size="15" /> 存草稿箱
        </button>
        <button class="primary" :disabled="committing || stats.matched === 0" @click="commit">
          {{ committing ? '写入中…' : `写入今日${MEAL_LABELS[meal]}` }}
        </button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.sum {
  gap: var(--gap-md);
  margin-bottom: var(--gap-sm);
}

/* 总热量是这一行的主数值，项数与可写入数是副行（胶囊/说明文字降一档） */
.sum-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}

.kcal {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.t-unit {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  margin-left: var(--sp-4);
}

.sub {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mini {
  width: 44px;
  height: 44px;
  flex: none;
  /* 缩略图走小尺寸容器档 8 */
  border-radius: var(--radius-s);
  object-fit: cover;
  background: var(--surface-2);
}

.meal {
  margin-top: var(--gap-md);
}

.acts {
  gap: var(--gap-md);
  margin-top: var(--gap-lg);
}

.ghost {
  gap: var(--gap-tight);
  min-height: var(--control-md);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.ghost:disabled {
  opacity: var(--disabled-opacity);
}

.primary {
  min-height: var(--control-md);
  padding: 0 var(--sp-22);
  border-radius: var(--radius-full);
  background: var(--ok);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-medium);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}
</style>
