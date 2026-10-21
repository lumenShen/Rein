<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ImagePlus, LoaderCircle, Pencil, Plus, Search, Sparkles, X } from 'lucide-vue-next'

import ManageModelsButton from '@/components/ai/ManageModelsButton.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import FoodPickerSheet from '@/components/diet/FoodPickerSheet.vue'
import TodoEditorSheet from '@/components/todo/TodoEditorSheet.vue'
import { CATEGORY_META, MEAL_LABELS, MEAL_ORDER, priorityMeta, suggestMeal } from '@/config/domain'
import { recordCardOutcome } from '@/ai/cardOutcomes'
import { useAiStore } from '@/stores/ai'
import { useModelsStore } from '@/stores/models'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm } from '@/utils/date'
import { fmtShortDate } from '@/utils/format'
import { fileToJpegBase64, IMAGE_ACCEPT, DEFAULT_IMAGE_EDGE } from '@/utils/image'
import { useToast } from '@/composables/useToast'
import type { MealType, ParsedFoodItem, Todo, TodoCategory, TodoDraft } from '@/types'

/**
 * 智能添加抽屉（待办 / 饮食通用）：
 * 与 AI 聊天同款交互——上传图片先进草稿区（缩略图芯片，可移除），可同时粘贴文字，
 * 点「生成」后由 AI 在后台解析（任务类内容→待办草稿；吃吃喝喝→食物卡并估算重量），
 * 结果分区出卡供确认、编辑后添加。手动入口按 mode 提供待办表单 / 食物库选择。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    date: string
    /** 待办/饮食模式：决定标题与手动入口 */
    mode?: 'todo' | 'food'
    /** 手动添加待办时的默认分类（如运动页只加运动待办） */
    category?: TodoCategory
    /** 食物模式的预选餐次（如方案页「下一餐」）；缺省按当前时间推测 */
    defaultMeal?: MealType | null
  }>(),
  { mode: 'todo' },
)

const emit = defineEmits<{ close: [] }>()

const todoStore = useTodoStore()
const models = useModelsStore()
const ai = useAiStore()
const toast = useToast()

/** 无模型时的面上结论（只一句）；完整操作指引收进旁边的 InfoHint */
const NO_MODEL_TEXT = '还没有可用的 AI 模型'
/** 完整指引（含视觉模型的限制）：content 纯文本，空行分段 */
const NO_MODEL_HINT = '先到「管理模型」添加并测试模型后，智能添加即可用。\n\n图片识别需要支持视觉的模型。'
const noModel = computed(() => error.value === NO_MODEL_TEXT)
const isFood = computed(() => props.mode === 'food')

const text = ref('')
const busy = ref(false)
const adding = ref(false)
const committing = ref(false)
const error = ref('')
const todos = ref<TodoDraft[]>([])
const foods = ref<ParsedFoodItem[]>([])
const foodStats = ref({ totalKcal: 0, total: 0, matched: 0 })
const meal = ref<MealType>(suggestMeal())
/** 流式过程：工具活动摘要 + 食物行预览（定稿前不做库匹配） */
const streamTool = ref('')
const foodPreview = ref<{ foodName: string; grams: number | null }[]>([])

// 每次打开重置餐次：调用方给了预选（如「下一餐」）就跟随，否则按当前时间推测
watch(
  () => props.open,
  (open) => {
    if (open) meal.value = props.defaultMeal ?? suggestMeal()
  },
)
const foodCommitted = ref(false)
/** 待发送附图（草稿区）：选图后先挂这里，可移除，点「生成」才随文字一起处理 */
const attachment = ref<{ full: string; small: string | null } | null>(null)
const fileRef = ref<HTMLInputElement | null>(null)

/* ---------- AI 生成（文字 + 可选附图一起后台处理） ---------- */

function failMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function ensureModels(): Promise<void> {
  if (!models.loaded) await models.load()
}

async function runGenerate(): Promise<void> {
  await ensureModels()
  const cfg = attachment.value ? models.bestVisionModel() : models.defaultModel()
  if (!cfg) {
    // 视觉限制收进 InfoHint，面上只留一句结论（句末不再拖括号）
    error.value = NO_MODEL_TEXT
    return
  }
  busy.value = true
  error.value = ''
  todos.value = []
  createdByKey.value = {}
  editingKey.value = null
  foods.value = []
  foodPreview.value = []
  streamTool.value = ''
  foodCommitted.value = false
  let streamedTodos = false
  try {
    const { generateSmart } = await import('@/ai/smartGen')
    const att = attachment.value
    const r = await generateSmart(
      cfg,
      text.value,
      att ? { data: att.full, mimeType: 'image/jpeg' } : undefined,
      {
        onTodos: (drafts) => {
          todos.value = drafts
          streamedTodos = true
        },
        onFoodRows: (rows) => (foodPreview.value = rows),
        onTool: (brief) => (streamTool.value = brief),
      },
    )
    // 流式已上屏的草稿内容与终稿一致，不重设避免列表动画重放
    if (!streamedTodos) todos.value = r.todos
    foods.value = r.foods
    foodCommitted.value = false
    meal.value = suggestMeal()
    if (r.todos.length === 0 && r.foods.length === 0) {
      error.value = '没有识别出待办或食物。描述得更具体一些（时间、事件、吃的喝的、数量）再试试。'
    }
  } catch (e) {
    error.value = `识别失败：${failMsg(e)}`
  } finally {
    busy.value = false
    streamTool.value = ''
    foodPreview.value = []
  }
}

/** 选图 → 先进草稿区（不立即解析），可继续粘贴文字；发送视图按视觉模型上限压缩 */
async function onPickImage(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!file) return
  await ensureModels()
  const cap = models.bestVisionModel()?.imageMaxEdge ?? DEFAULT_IMAGE_EDGE
  const [full, small] = await Promise.all([
    fileToJpegBase64(file, cap, 0.85),
    fileToJpegBase64(file, 240, 0.6).catch(() => null),
  ])
  attachment.value = { full, small }
  error.value = ''
}

/* ---------- 待办确认 ---------- */

const pendingCount = computed(() => todos.value.filter((d) => d.checked && !d.added).length)

async function addChecked(): Promise<void> {
  if (adding.value) return
  const pick = todos.value.filter((d) => d.checked && !d.added)
  if (pick.length === 0) return
  adding.value = true
  try {
    for (const d of pick) {
      const created = await todoStore.create({
        title: d.title,
        notes: d.notes,
        date: d.date,
        startMin: d.startMin,
        durationMin: d.durationMin,
        category: d.category,
        priority: d.priority,
      })
      createdByKey.value[d.key] = created
      d.added = true
    }
    // 跨页提议卡的「用户已处理」信号：聊天模型看不到这个抽屉，靠 @/ai/cardOutcomes 带过去
    recordCardOutcome(
      'smart-add',
      `智能添加写入待办 ${pick.length} 条（${pick
        .slice(0, 3)
        .map((d) => d.title)
        .join('、')}${pick.length > 3 ? ' 等' : ''}）`,
    )
  } finally {
    adding.value = false
  }
}

/* 点击待办草稿 → 进编辑器调整细节；保存后该草稿已落库，同步展示。
   已落库过的草稿再点铅笔必须走「改」而不是「再建一条」—— 否则同一条草稿被点几次
   就多出几条一模一样的待办（编辑器此前恒以 `todo=null` 打开，save 永远落 create 分支）。 */
const editingKey = ref<string | null>(null)
const editorOpen = ref(false)
/** draft.key → 已落库的待办；有值即编辑器以「编辑」模式打开它 */
const createdByKey = ref<Record<string, Todo>>({})

/** 当前草稿对应的已落库待办（未落库则 null → 新建） */
const editingTodo = computed<Todo | null>(() =>
  editingKey.value ? createdByKey.value[editingKey.value] ?? null : null,
)

function openEditor(d: TodoDraft): void {
  editingKey.value = d.key
  editorOpen.value = true
}

function onEditorSaved(todo: Todo): void {
  const d = todos.value.find((x) => x.key === editingKey.value)
  if (!d) return
  createdByKey.value[d.key] = todo
  d.title = todo.title
  d.notes = todo.notes
  d.date = todo.date ?? d.date
  d.startMin = todo.startMin
  d.durationMin = todo.durationMin
  d.category = todo.category
  d.priority = todo.priority
  d.added = true
}

/** AI 会推断日期（明天/下周…），不等于当前日期时必须显式展示，否则用户看不到排错天 */
function shortDate(s: string): string {
  return fmtShortDate(s)
}

function fmtMeta(d: TodoDraft): string {
  const parts: string[] = []
  if (d.date !== props.date) parts.push(shortDate(d.date))
  if (d.startMin != null) parts.push(minToHHmm(d.startMin))
  return parts.join(' ')
}

/** AI 幻觉条目直接移除，而不是只能不勾一直留着 */
function removeDraft(key: string): void {
  todos.value = todos.value.filter((x) => x.key !== key)
}

/* ---------- 食物确认 ---------- */

async function commitFoods(): Promise<void> {
  if (foods.value.length === 0 || foodCommitted.value) return
  committing.value = true
  try {
    const r = await ai.commitParsedItems(foods.value, meal.value, 'text_ai')
    if (r.written === 0) {
      toast.toast('没有可写入的食物（全部未匹配食物库）')
      return
    }
    const skipped = foods.value.length - r.written
    toast.toast(
      skipped > 0
        ? `已写入 ${r.written} 项到今日${MEAL_LABELS[meal.value]}，跳过 ${skipped} 项未匹配`
        : `已写入 ${r.written} 项到今日${MEAL_LABELS[meal.value]}`,
    )
    foodCommitted.value = true
    recordCardOutcome(
      'smart-add',
      `智能添加记入今日${MEAL_LABELS[meal.value]} ${r.written} 项（${foods.value
        .slice(0, 3)
        .map((f) => f.foodName)
        .join('、')}${foods.value.length > 3 ? ' 等' : ''}）`,
    )
  } finally {
    committing.value = false
  }
}

/* ---------- 手动入口 ---------- */

const pickerOpen = ref(false)

function clearAll(): void {
  if (busy.value) return // 生成中清空会让完成后的结果凭空回填
  text.value = ''
  attachment.value = null
  todos.value = []
  createdByKey.value = {}
  editingKey.value = null
  foods.value = []
  error.value = ''
  foodCommitted.value = false
}
</script>

<template>
  <SheetModal :open="open" :title="isFood ? '记饮食' : '添加待办'" @close="emit('close')">
    <!-- 右上角：管理模型（无模型/换模型时直接跳转） -->
    <template #action>
      <ManageModelsButton @manage="emit('close')" />
    </template>
    <div class="add">
      <!-- 智能添加面板 -->
      <div class="smart card">
        <div class="row between">
          <p class="tag row center"><Sparkles :size="14" /> 智能添加</p>
          <button v-if="text || attachment || todos.length || foods.length" class="clear" :disabled="busy" @click="clearAll">清空</button>
        </div>

        <textarea
          v-model="text"
          class="paste"
          rows="3"
          placeholder="粘贴便签、聊天记录或想法，AI 会提取待办；提到吃的会同时出食物卡…"
        />

        <!-- 草稿区：选图先进这里（可移除），随文字一起生成 -->
        <div v-if="attachment" class="attach-row">
          <div class="attach-chip">
            <img :src="`data:image/jpeg;base64,${attachment.small ?? attachment.full}`" alt="待处理图片">
            <button class="attach-x" aria-label="移除图片" @click="attachment = null">
              <span class="xmark">×</span>
            </button>
          </div>
          <span class="attach-hint t-3">图片已就绪，可继续粘贴文字后一起生成</span>
        </div>

        <div class="row between">
          <button class="pic" @click="fileRef?.click()">
            <ImagePlus :size="16" />
            {{ attachment ? '换一张图' : '识别图片' }}
          </button>
          <button class="run" :disabled="busy || (!text.trim() && !attachment)" @click="runGenerate">
            <LoaderCircle v-if="busy" :size="15" class="spin" />
            <template v-else>生成</template>
          </button>
        </div>
        <input ref="fileRef" type="file" :accept="IMAGE_ACCEPT" hidden @change="onPickImage">
      </div>

      <!-- 忙碌（流式：工具活动 + 食物行预览）/ 错误 -->
      <div v-if="busy" class="state">
        <p class="row" style="gap: 6px; font-size: var(--fs-caption); color: var(--text-3)">
          <LoaderCircle :size="13" class="spin" />
          <span>{{ streamTool || 'AI 正在后台解析…' }}</span>
        </p>
        <p v-if="foodPreview.length" class="fprev t-3 num">
          {{ foodPreview.map((f) => `${f.foodName}${f.grams ? ` ${f.grams}g` : ''}`).join('、') }}
        </p>
      </div>
      <p v-else-if="error" class="state err-row">
        <span class="err">{{ error }}</span>
        <!-- 无模型时补一枚帮助入口：完整操作指引（含视觉模型限制）收进抽屉 -->
        <InfoHint v-if="noModel" title="可用的 AI 模型" :content="NO_MODEL_HINT" />
      </p>

      <!-- 食物卡（识别结果 → 确认餐次 → 写入今日） -->
      <template v-if="foods.length">
        <p class="count">
          <b class="num ck">识别到 {{ foods.length }} 项食物</b>
          <span class="ck-sub">≈{{ foodStats.totalKcal }} 大卡</span>
        </p>
        <div class="food-card">
          <FoodParseEditor v-model="foods" @change="foodStats = $event" />
          <template v-if="!foodCommitted">
            <SegmentedControl
              class="meal"
              v-model="meal"
              :options="MEAL_ORDER.map((x) => ({ value: x, label: MEAL_LABELS[x] }))"
            />
            <button class="commit" :disabled="committing || foodStats.matched === 0" @click="commitFoods">
              <LoaderCircle v-if="committing" :size="15" class="spin" />
              <template v-else><Plus :size="15" /> 写入今日{{ MEAL_LABELS[meal] }}</template>
            </button>
          </template>
          <p v-else class="done"><Check :size="14" /> 已写入今日{{ MEAL_LABELS[meal] }}</p>
        </div>
      </template>

      <!-- 待办草稿：标题可换行、异日显性、分类色点、备注预览、可移除 -->
      <template v-if="todos.length">
        <!-- 识别数是主数值；「待添加」是结论走胶囊；改细节的入口每行都有铅笔钮 -->
        <p class="count">
          <b class="num ck">识别到 {{ todos.length }} 条待办</b>
          <StatusChip v-if="pendingCount" tone="accent" size="sm">待添加 {{ pendingCount }}</StatusChip>
          <span v-else-if="!todos.some((d) => !d.added)" class="ck-sub">全部已处理</span>
        </p>
        <TransitionGroup tag="ul" name="tdl" class="list">
          <li
            v-for="(d, di) in todos"
            :key="d.key"
            class="draft"
            :class="{ added: d.added }"
            :style="{ '--i': di }"
          >
            <button
              class="pick"
              :class="{ on: d.checked }"
              :aria-label="d.checked ? '取消勾选' : '勾选'"
              :disabled="d.added || busy"
              @click="d.checked = !d.checked"
            >
              <Transition name="ckin">
                <Check v-if="d.checked || d.added" :size="13" :stroke-width="3.2" />
              </Transition>
            </button>
            <button class="info col grow" :disabled="busy" @click="openEditor(d)">
              <span class="trow">
                <i class="catdot" :style="{ background: `var(${CATEGORY_META[d.category].colorVar})` }" />
                <b class="dt">{{ d.title }}</b>
              </span>
              <span class="meta num">
                <em v-if="fmtMeta(d)" class="mt">{{ fmtMeta(d) }}</em>
                <em class="mchip">
                  <i :style="{ background: `var(${CATEGORY_META[d.category].colorVar})` }" />
                  {{ CATEGORY_META[d.category].label }}
                </em>
                <em v-if="d.priority > 0" class="mchip" :class="d.priority === 2 ? 'urgent' : 'major'">
                  {{ priorityMeta(d.priority).label }}
                </em>
                <em v-if="d.added" class="mchip ok"><Check :size="10" :stroke-width="3" /> 已添加</em>
              </span>
              <span v-if="d.notes" class="notes t-2">{{ d.notes }}</span>
            </button>
            <span class="acts">
              <button class="act" aria-label="编辑细节" :disabled="busy" @click="openEditor(d)">
                <Pencil :size="14" />
              </button>
              <button v-if="!d.added" class="act danger" aria-label="移除该条" :disabled="busy" @click="removeDraft(d.key)">
                <X :size="14" />
              </button>
            </span>
          </li>
        </TransitionGroup>
        <button class="commit" :disabled="pendingCount === 0 || adding || busy" @click="addChecked">
          <LoaderCircle v-if="adding" :size="15" class="spin" />
          <template v-else><Plus :size="15" /> 添加{{ pendingCount ? ` ${pendingCount} 条` : '' }}</template>
        </button>
      </template>

      <!-- 手动入口 -->
      <button v-if="isFood" class="manual row center" @click="pickerOpen = true">
        <Search :size="15" /> 从食物库选择
      </button>
      <button v-else class="manual row center" @click="editorOpen = true">
        <Plus :size="15" /> 手动填写待办
      </button>
    </div>

    <!-- 嵌套弹层：待办完整表单 / 食物库选择器 -->
    <TodoEditorSheet
      :open="editorOpen"
      :todo="editingTodo"
      :initial="editingKey ? (todos.find((d) => d.key === editingKey) ?? null) : { date, category }"
      :date
      @close="editorOpen = false"
      @saved="onEditorSaved"
    />
    <FoodPickerSheet :open="pickerOpen" :default-meal="meal" @close="pickerOpen = false" />
  </SheetModal>
</template>

<style scoped>
/* 抽屉内容是一列块：块与块之间 12（--gap-md，与卡内区块同一档） */
.add {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}

/* 抽屉里的二级面：比抽屉的白底退一档（--surface-2 + 12 圆角 --radius-m-nest），
   内距 12（--pad-card-tight）—— 它嵌在 --pad-sheet 16 里面，不该再用母卡的 16 */
.smart {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
}

.tag {
  gap: var(--gap-tight);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  color: var(--accent);
}

/* 「清除」是一个可点的动作，不是说明文字：--text-3 的 3.6:1 读不出来 */
.clear {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.clear:disabled {
  opacity: var(--disabled-opacity);
}

.paste {
  /* 输入框与所在二级面同档圆角（12），左右 12 与二级面的内距对齐 */
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-m-nest);
  background: var(--surface);
  font-size: var(--fs-subhead);
  resize: vertical;
  min-height: 64px;
}

/* 胶囊按钮：图标与文字 4（同组无边界），左右 --pad-inline 12 */
.pic {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.run {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-8) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-bold);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.run:disabled {
  opacity: var(--disabled-opacity);
}

.spin {
  animation: vt-spin 0.9s linear infinite;
}

@keyframes vt-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 草稿区（AI 聊天同款附件芯片） */
.attach-row {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
}

.attach-chip {
  position: relative;
  width: 56px;
  height: 56px;
  flex: none;
}

.attach-chip img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-m);
  background: var(--surface);
}

.attach-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-2);
}

/* 13px 不在字号阶梯上：吸附到 Caption_L 12 */
.xmark {
  font-size: var(--fs-caption);
  line-height: 1;
  font-weight: var(--fw-bold);
}

.attach-hint {
  font-size: var(--fs-caption);
}

.state {
  min-height: 16px;
}

/* 错误行：一句结论 +（无模型时）行内帮助入口 */
.err-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}

.state .err {
  color: var(--danger);
}

/* 流式食物行预览：逐条流出时的单行摘要 */
.fprev {
  margin-top: var(--gap-tight);
  line-height: var(--lh-body);
}

/* 识别数：主数值升一档，副行（待添加 / 全部已处理 / 总热量）降为 caption 灰 */
.count {
  font-weight: var(--fw-semibold);
}

.ck {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* 主次文本左右 8（--gap-text-inline） */
.ck-sub {
  margin-left: var(--gap-text-inline);
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 食物卡 */
.food-card {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  animation: draft-in 250ms var(--ease-standard) both;
}

.meal {
  margin-top: var(--gap-tight);
}

/* 待办草稿 */
.list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

/* 增删时其余卡 FLIP 平滑让位 */
.tdl-move {
  transition: transform var(--dur-base) var(--ease-standard);
}

.tdl-enter-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.tdl-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.tdl-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

/* 与 .tdl-enter-from 同向量：进来往上长、出去往下退 —— 一升一缩会读成两套动画 */
.tdl-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* AI 揭晓时刻：逐条浮出（stagger 40ms，不阻塞交互；reduced-motion 全局归零） */
.draft {
  display: flex;
  align-items: flex-start;
  /* 草稿行是抽屉里的二级面：12 内距 / 12 圆角，与 .food-card 同一档 */
  gap: var(--gap-md);
  padding: var(--pad-card-tight);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  animation: draft-in 250ms var(--ease-standard) both;
  animation-delay: calc(var(--i, 0) * 40ms);
}

@keyframes draft-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.draft.added {
  opacity: 0.55;
}

.pick {
  width: 24px;
  height: 24px;
  flex: none;
  margin-top: 1px;
  border-radius: var(--radius-xs);
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  background: var(--surface);
  transition: background-color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard);
}

.pick.on {
  background: var(--accent);
  border-color: var(--accent);
}

.pick:disabled {
  opacity: var(--disabled-opacity);
}

/* 对勾弹入 */
.ckin-enter-active {
  transition:
    transform 120ms var(--ease-standard),
    opacity 120ms var(--ease-standard);
}

.ckin-enter-from {
  transform: scale(0.5);
  opacity: 0;
}

.info {
  text-align: left;
  /* 标题 + 元信息两行文本：主次文本上下 2（--gap-text） */
  gap: var(--gap-text);
  min-width: 0;
  padding: 0;
}

.trow {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-6);
  min-width: 0;
}

/* 分类点与首行文字对齐：7px 的点在 14px 行里要下移 4 才落在文本腰线上 */
.catdot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: var(--gap-tight);
  border-radius: 50%;
}

/* AI 标题可能很长：换行到两行而非截断丢信息 */
.dt {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-subtitle);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  /* 元信息胶囊之间：无边界的一组 → 4（--gap-tight） */
  gap: var(--gap-tight);
}

/* 错排日期是必须被看见的信息（脚本注释明说）：不吃 11px 水印档 */
.meta .mt {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mchip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  /* 微标签不撑高：纵向内距 0 由字号与行高决定，横向 8（--sp-8） */
  padding: 0 var(--sp-8);
  border-radius: var(--radius-full);
  background: var(--surface);
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  white-space: nowrap;
}

.mchip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.mchip.major {
  background: color-mix(in srgb, var(--c-carb) 14%, transparent);
  color: color-mix(in srgb, var(--c-carb) 80%, var(--text-1));
}

.mchip.urgent {
  background: var(--danger-soft);
  color: var(--danger);
}

.mchip.ok {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok-strong);
}

/* AI 可能带来源说明：一行截断预览，点了编辑器里看全文 */
.notes {
  font-size: var(--fs-micro);
  line-height: var(--lh-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.acts {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.act {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.act:active {
  background: var(--surface);
  color: var(--text-2);
}

.act.danger:active {
  color: var(--danger);
}

.commit {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  padding: var(--sp-12);
  /* 主按钮与全局按钮同档：圆角 20（--radius-l），不是卡片的 16 */
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.commit:disabled {
  opacity: var(--disabled-opacity);
}

.done {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--ok);
}

.manual {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  padding: var(--sp-12);
  /* 与 .commit 同一几何（全宽 / 20 圆角 / 12 上下内距），只换底与字重 */
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}
</style>
