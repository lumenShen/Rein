<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ChevronDown, Image as ImageIcon, Mic, Minus, Paperclip, Plus, Square, Trash2, Type, X } from 'lucide-vue-next'

import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { CATEGORY_META } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { useFeaturesStore } from '@/stores/features'
import { useTodoStore } from '@/stores/todo'
import { recorder, startRecording, stopRecording } from '@/system/recorderRuntime'
import { minToHHmm, todayStr } from '@/utils/date'
import { humanBytes } from '@/utils/format'
import { fileToJpegBase64, IMAGE_ACCEPT } from '@/utils/image'
import { TODO_CATEGORIES } from '@/types'
import type {
  RecRule,
  Todo,
  TodoAttachment,
  TodoAttachmentKind,
  TodoCategory,
  TodoInput,
  TodoSubtask,
} from '@/types'

/**
 * 待办编辑抽屉：首层 = 标题 / 附件与标记 / 备注；下方「安排」区 = 时间 / 时长 / 分类 /
 * 重要程度四象限（重要 × 紧急）；细项（子任务 / 重复）折叠进「更多设置」。
 * 四象限映射 priority：0 普通（不重要不紧急）/ 1 重要不紧急 / 2 紧急不重要 / 3 重要且紧急。
 * 附件存 data URL 内联（本地个人应用量级可控）。
 * 复用场景：TodoItem 行内编辑新建、AI 草稿调整细节、手动添加。
 */
const props = defineProps<{
  open: boolean
  /** 编辑已有待办；为 null 时是新建 */
  todo?: Todo | null
  /** 新建时的预填（AI 草稿 / 手动入口） */
  initial?: Partial<TodoInput> | null
  /** 新建默认日期 */
  date?: string
}>()

const emit = defineEmits<{ close: []; saved: [todo: Todo] }>()

const store = useTodoStore()
/** 录音附件钮属「录音」模块：模块关掉时不出现（已附加的录音作为附件原样保留） */
const features = useFeaturesStore()
const recordOn = computed(() => features.isEnabled('record'))
const { toast } = useToast()

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const REC_FREQS: { value: 'none' | RecRule['freq']; label: string }[] = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'interval', label: '间隔 N 天' },
]

/**
 * 分类 chips 只取用户可选白名单（`TODO_CATEGORIES`），不能遍历 `CATEGORY_META`：
 * 后者还含课表派生专用的 `class`，放出来会让用户手建一条「看起来像课程、但不会被同步管」
 * 的待办。渲染层缺 `class` 会崩，所以两边用途不同，取值来源也得分开。
 */
const CATEGORY_OPTIONS = TODO_CATEGORIES.map((key) => ({ key, ...CATEGORY_META[key] }))

const form = reactive({
  title: '',
  date: '',
  startMin: null as number | null,
  durationMin: null as number | null,
  category: 'general' as TodoCategory,
  priority: 0,
  notes: '',
  subtasks: [] as TodoSubtask[],
  newSub: '',
  recFreq: 'none' as 'none' | RecRule['freq'],
  recWeekdays: [] as number[],
  recInterval: 2,
  recEnd: '' as string,
  attachments: [] as TodoAttachment[],
})

/** 细项折叠：编辑已有待办且细项有内容时自动展开，其余收起保持抽屉精简 */
const foldOpen = ref(false)

/** 四象限格子的选中配色（按象限语义取色） */
const QUAD_COLOR: Record<number, string> = { 0: '--text-3', 1: '--c-carb', 2: '--c-fat', 3: '--danger' }

function quadOn(p: number): Record<string, string> {
  const cv = QUAD_COLOR[p] ?? '--text-3'
  return {
    background: `color-mix(in srgb, var(${cv}) 14%, transparent)`,
    borderColor: `color-mix(in srgb, var(${cv}) 55%, transparent)`,
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const t = props.todo
    form.title = t?.title ?? props.initial?.title ?? ''
    form.date = t?.date ?? props.initial?.date ?? props.date ?? todayStr()
    form.startMin = t?.startMin ?? props.initial?.startMin ?? null
    form.durationMin = t?.durationMin ?? props.initial?.durationMin ?? null
    form.category = t?.category ?? props.initial?.category ?? 'general'
    form.priority = t?.priority ?? props.initial?.priority ?? 0
    form.notes = t?.notes ?? props.initial?.notes ?? ''
    form.subtasks = (t?.subtasks ?? []).map((s) => ({ ...s }))
    form.newSub = ''
    form.recFreq = t?.recRule?.freq ?? 'none'
    form.recWeekdays = t?.recRule?.weekdays ? [...t.recRule.weekdays] : []
    form.recInterval = t?.recRule?.intervalDays || 2
    form.recEnd = t?.recRule?.endDate ?? ''
    form.attachments = (t?.attachments ?? []).map((a) => ({ ...a }))
    foldOpen.value = !!(t && (t.subtasks?.length || t.recRule))
    textDraftOpen.value = false
    expandedAtch.value = null
  },
)

/** <input type="time"> 的 HH:mm 与 startMin 互转；空值 = 无时间段 */
const timeValue = computed({
  get: () => (form.startMin != null ? minToHHmm(form.startMin) : ''),
  set: (v: string) => {
    if (!v) {
      form.startMin = null
      return
    }
    const [h, m] = v.split(':').map(Number)
    form.startMin = (h! * 60 + m!) % 1440
  },
})

/* ---------- 时长步进器：±5 分钟；点数字进入输入态（按分钟），清空提交 = 无时长 ---------- */

const DUR_STEP = 5
const DUR_MIN = 5
const DUR_MAX = 1440

const editingDuration = ref(false)
/** v-model 在 type=number 输入框上会把值自动转成 Number，声明放宽并在提交时统一字符串化 */
const durDraft = ref<string | number>('')
const durInput = ref<HTMLInputElement>()

function bumpDuration(d: number): void {
  if (form.durationMin == null) {
    form.durationMin = d > 0 ? 30 : null
    return
  }
  form.durationMin = Math.min(DUR_MAX, Math.max(DUR_MIN, form.durationMin + d))
}

function fmtDuration(v: number): string {
  if (v < 60) return `${v} 分钟`
  const h = Math.floor(v / 60)
  const m = v % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

async function openDurationEdit(): Promise<void> {
  durDraft.value = form.durationMin != null ? String(form.durationMin) : ''
  editingDuration.value = true
  await nextTick()
  durInput.value?.focus()
  durInput.value?.select()
}

function commitDuration(): void {
  if (!editingDuration.value) return
  editingDuration.value = false
  const raw = String(durDraft.value).trim()
  const v = Number.parseInt(raw, 10)
  form.durationMin = raw && Number.isFinite(v) ? Math.min(DUR_MAX, Math.max(DUR_MIN, v)) : null
}

const canSave = computed(() => form.title.trim().length > 0)
/** 保存中：挡住连点 —— create 是一次异步往返，晚了 100ms 的第二次点击会再落一条 */
const saving = ref(false)

function rulePayload(): RecRule | null {
  if (form.recFreq === 'none') return null
  const weekdays = form.recFreq === 'weekly' ? [...form.recWeekdays].sort((a, b) => a - b) : []
  if (form.recFreq === 'weekly' && !weekdays.length) return null
  return {
    freq: form.recFreq,
    weekdays,
    intervalDays: form.recFreq === 'interval' ? form.recInterval : 0,
    endDate: form.recEnd || null,
  }
}

function addSub(): void {
  const title = form.newSub.trim()
  if (!title || form.subtasks.length >= 10) return
  form.subtasks.push({ title, done: false })
  form.newSub = ''
}

function toggleWeekday(d: number): void {
  const i = form.recWeekdays.indexOf(d)
  if (i === -1) form.recWeekdays.push(d)
  else form.recWeekdays.splice(i, 1)
}

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    const rule = rulePayload()
    const subs = form.subtasks.length ? form.subtasks : null
    const input: TodoInput = {
      title: form.title.trim(),
      notes: form.notes.trim() || null,
      date: form.date || null,
      startMin: form.startMin,
      durationMin: form.durationMin,
      category: form.category,
      priority: form.priority,
      recRule: rule,
      subtasks: subs,
      attachments: form.attachments.length ? form.attachments : null,
    }
    if (props.todo) {
      const next: Todo = { ...props.todo, ...input }
      await store.update(next)
      emit('saved', next)
    } else {
      const created = await store.create(input)
      emit('saved', created)
    }
    emit('close')
  } finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  if (!props.todo) return
  await store.remove(props.todo)
  emit('close')
}

/* ---------- 附件与标记：文字 / 图片 / 文件 / 录音 ---------- */

const textDraftOpen = ref(false)
const textDraft = ref('')
const expandedAtch = ref<number | null>(null)

function openTextDraft(): void {
  textDraft.value = ''
  textDraftOpen.value = true
}

function commitText(): void {
  const content = textDraft.value.trim()
  if (!content) return
  form.attachments.push({
    kind: 'text',
    name: content.slice(0, 16) || '文字标记',
    content,
    createdAt: new Date().toISOString(),
  })
  textDraftOpen.value = false
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取失败'))
    fr.readAsDataURL(file)
  })
}

const MAX_FILE_BYTES = 4 * 1024 * 1024

const imgRef = ref<HTMLInputElement>()
const fileRef = ref<HTMLInputElement>()

function pickImage(): void {
  imgRef.value?.click()
}

function pickFile(): void {
  fileRef.value?.click()
}

async function onPickImage(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  try {
    // 压到最长边 1600px 内联存储，兼顾清晰度与库体积
    const b64 = await fileToJpegBase64(f, 1600, 0.82)
    form.attachments.push({
      kind: 'image',
      name: f.name,
      content: `data:image/jpeg;base64,${b64}`,
      size: Math.round(b64.length * 0.75),
      createdAt: new Date().toISOString(),
    })
  } catch {
    toast('图片处理失败，换一张试试')
  }
}

async function onPickFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  if (f.size > MAX_FILE_BYTES) {
    toast('文件超过 4MB，先压缩再附加')
    return
  }
  try {
    form.attachments.push({
      kind: 'file',
      name: f.name,
      content: await readAsDataURL(f),
      size: f.size,
      createdAt: new Date().toISOString(),
    })
  } catch {
    toast('文件读取失败')
  }
}

/* 录音：走全局 recorderRuntime（录音中可离开抽屉，录音浮条接管控制）；
   onTake 回调把 take 直接挂进本抽屉的附件列表 */
const recMine = ref(false)

function fmtDur(totalSec: number): string {
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`
}

async function toggleRecord(): Promise<void> {
  if (recorder.status === 'recording') {
    if (!recMine.value) {
      toast('已有录音在进行中（见录音浮条）')
      return
    }
    recMine.value = false
    stopRecording()
    return
  }
  recMine.value = true
  const ok = await startRecording({
    onTake: (t) => {
      form.attachments.push({
        kind: 'audio',
        name: `录音 ${fmtDur(t.durationSec)}`,
        content: t.dataUrl,
        size: t.size,
        createdAt: t.createdAt,
      })
    },
  })
  if (!ok) {
    recMine.value = false
    toast(recorder.lastError || '无法开始录音')
  }
}

function atchIcon(kind: TodoAttachmentKind) {
  return kind === 'text' ? Type : kind === 'image' ? ImageIcon : kind === 'file' ? Paperclip : Mic
}

function fmtSize(n?: number): string {
  return n == null ? '' : humanBytes(n)
}

function removeAtch(i: number): void {
  form.attachments.splice(i, 1)
  if (expandedAtch.value === i) expandedAtch.value = null
}

/** 文件附件下载：data URL → Blob → 临时对象链接触发下载 */
function downloadAtch(a: TodoAttachment): void {
  if (!a.content) return
  const [meta = '', b64 = ''] = a.content.split(',')
  const mime = meta.match(/data:([^;]+)/)?.[1] ?? 'application/octet-stream'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = a.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

onBeforeUnmount(() => {
  // 录音归全局 runtime 管：抽屉关闭不打断录音（悬浮条继续控制）
  recMine.value = false
})
</script>

<template>
  <SheetModal :open="open" :title="todo ? '编辑待办' : '添加待办'" @close="emit('close')">
    <div class="form">
      <input v-model="form.title" class="title" type="text" placeholder="要做什么？" aria-label="待办标题" maxlength="80">

      <!-- 首层：附件与标记 -->
      <div class="field col">
        <span class="fb">附件与标记</span>
        <div class="atch-add">
          <button class="abtn" :disabled="textDraftOpen" @click="openTextDraft">
            <Type :size="13" /> 文字
          </button>
          <button class="abtn" @click="pickImage">
            <ImageIcon :size="13" /> 图片
          </button>
          <button class="abtn" @click="pickFile">
            <Paperclip :size="13" /> 文件
          </button>
          <button v-if="recordOn" class="abtn rec" :class="{ on: recMine }" @click="toggleRecord">
            <Square v-if="recMine" :size="13" />
            <Mic v-else :size="13" />
            {{ recMine ? `停止 ${fmtDur(recorder.elapsedSec)}` : '录音' }}
          </button>
        </div>
        <input ref="imgRef" type="file" :accept="IMAGE_ACCEPT" hidden @change="onPickImage">
        <input ref="fileRef" type="file" hidden @change="onPickFile">

        <div v-if="textDraftOpen" class="atch-text">
          <textarea v-model="textDraft" class="notes" rows="2" placeholder="写点标记…" aria-label="文字标记内容" />
          <div class="row between tacts">
            <button class="mini" @click="textDraftOpen = false">取消</button>
            <button class="mini primary" :disabled="!textDraft.trim()" @click="commitText">添加</button>
          </div>
        </div>

        <ul v-if="form.attachments.length" class="atch-list">
          <li v-for="(a, i) in form.attachments" :key="`${a.createdAt}-${i}`">
            <div class="arow">
              <button class="amain" :aria-expanded="expandedAtch === i" @click="expandedAtch = expandedAtch === i ? null : i">
                <i class="aicon"><component :is="atchIcon(a.kind)" :size="13" /></i>
                <span class="aname">{{ a.name }}</span>
                <em v-if="a.size" class="num asize">{{ fmtSize(a.size) }}</em>
              </button>
              <button class="adel" aria-label="删除附件" @click="removeAtch(i)">
                <X :size="13" />
              </button>
            </div>
            <div v-if="expandedAtch === i" class="aprev">
              <textarea v-if="a.kind === 'text'" v-model="a.content" class="notes" rows="3" aria-label="编辑文字标记" />
              <img v-else-if="a.kind === 'image'" class="aimg" :src="a.content" alt="图片附件">
              <audio v-else-if="a.kind === 'audio'" class="aaud" controls :src="a.content" />
              <button v-else-if="a.kind === 'file'" class="mini" @click="downloadAtch(a)">下载文件</button>
            </div>
          </li>
        </ul>
        <p v-else-if="!textDraftOpen" class="aempty t-3">暂无附件</p>
      </div>

      <!-- 首层：备注 -->
      <div class="field col">
        <label class="fb" for="todo-notes">备注</label>
        <textarea id="todo-notes" v-model="form.notes" class="notes" rows="3" placeholder="补充说明（可选）" />
      </div>

      <!-- 安排区：时间 / 分类 / 四象限 -->
      <div class="sect"><span>安排</span></div>

      <div class="time-row">
        <label class="tcell">
          <span class="fb">日期</span>
          <input v-model="form.date" class="date" type="date" aria-label="日期">
        </label>
        <label class="tcell">
          <span class="fb">开始时间</span>
          <input v-model="timeValue" class="date" type="time" aria-label="开始时间">
        </label>
      </div>

      <!-- 时长：步进器，点数字可直接输入；清空 = 无时长 -->
      <div class="field col">
        <span class="fb">时长</span>
        <div class="dstepper row between">
          <button class="dstep-btn" aria-label="减少 5 分钟" :disabled="form.durationMin == null" @click="bumpDuration(-DUR_STEP)">
            <Minus :size="16" />
          </button>
          <button
            v-if="!editingDuration"
            class="dval num"
            :class="{ unset: form.durationMin == null }"
            aria-label="点击输入时长"
            @click="openDurationEdit"
          >
            {{ form.durationMin != null ? fmtDuration(form.durationMin) : '无时长' }}
          </button>
          <span v-else class="dedit">
            <input
              ref="durInput"
              v-model="durDraft"
              class="dinput num"
              type="number"
              inputmode="numeric"
              min="5"
              max="1440"
              aria-label="时长（分钟）"
              @keydown.enter.prevent="commitDuration"
              @keydown.esc="editingDuration = false"
              @blur="commitDuration"
            >
            <span class="dunit">分钟</span>
          </span>
          <button class="dstep-btn" aria-label="增加 5 分钟" @click="bumpDuration(DUR_STEP)">
            <Plus :size="16" />
          </button>
        </div>
      </div>

      <!-- 分类 -->
      <div class="field col">
        <span class="fb">分类</span>
        <div class="chips">
          <button
            v-for="m in CATEGORY_OPTIONS"
            :key="m.key"
            class="chip"
            :class="{ on: form.category === m.key }"
            @click="form.category = m.key"
          >
            {{ m.label }}
          </button>
        </div>
      </div>

      <!-- 重要程度：四象限（重要 × 紧急）→ priority 0-3 -->
      <div class="field col">
        <span class="fb">重要程度</span>
        <div class="quad" role="radiogroup" aria-label="重要程度四象限">
          <i />
          <span class="q-head">重要</span>
          <span class="q-head">不重要</span>

          <span class="q-side">紧急</span>
          <button
            class="q-cell"
            :class="{ on: form.priority === 3 }"
            role="radio"
            :aria-checked="form.priority === 3"
            :style="form.priority === 3 ? quadOn(3) : undefined"
            @click="form.priority = 3"
          >
            <b :style="form.priority === 3 ? { color: 'var(--danger)' } : undefined">重要且紧急</b>
            <em>立即做</em>
          </button>
          <button
            class="q-cell"
            :class="{ on: form.priority === 2 }"
            role="radio"
            :aria-checked="form.priority === 2"
            :style="form.priority === 2 ? quadOn(2) : undefined"
            @click="form.priority = 2"
          >
            <b :style="form.priority === 2 ? { color: 'var(--c-fat)' } : undefined">紧急不重要</b>
            <em>抽空做</em>
          </button>

          <span class="q-side">不紧急</span>
          <button
            class="q-cell"
            :class="{ on: form.priority === 1 }"
            role="radio"
            :aria-checked="form.priority === 1"
            :style="form.priority === 1 ? quadOn(1) : undefined"
            @click="form.priority = 1"
          >
            <b :style="form.priority === 1 ? { color: 'var(--c-carb)' } : undefined">重要不紧急</b>
            <em>计划做</em>
          </button>
          <button
            class="q-cell"
            :class="{ on: form.priority === 0 }"
            role="radio"
            :aria-checked="form.priority === 0"
            :style="form.priority === 0 ? quadOn(0) : undefined"
            @click="form.priority = 0"
          >
            <b>不重要不紧急</b>
            <em>有空再做</em>
          </button>
        </div>
      </div>

      <!-- 细项折叠：子任务 / 重复 -->
      <div class="fold">
        <button class="fold-head row between" :aria-expanded="foldOpen" @click="foldOpen = !foldOpen">
          <span>更多设置 <span class="fold-sub">子任务 · 重复</span></span>
          <ChevronDown :size="15" class="chev" :class="{ flip: foldOpen }" />
        </button>
        <div v-show="foldOpen" class="fold-body">
          <!-- 子任务 -->
          <div class="field col">
            <span class="fb">子任务<span v-if="form.subtasks.length" class="num cnt"> {{ form.subtasks.filter((s) => s.done).length }}/{{ form.subtasks.length }}</span></span>
            <ul v-if="form.subtasks.length" class="subs">
              <li v-for="(s, i) in form.subtasks" :key="i" class="row sub">
                <label class="row submain">
                  <input v-model="s.done" type="checkbox">
                  <span :class="{ off: s.done }">{{ s.title }}</span>
                </label>
                <button class="subdel" aria-label="删除子任务" @click="form.subtasks.splice(i, 1)">
                  <Trash2 :size="14" />
                </button>
              </li>
            </ul>
            <div class="row subadd">
              <input
                v-model="form.newSub"
                class="subinput"
                type="text"
                placeholder="添加子任务（回车）"
                maxlength="60"
                @keydown.enter.prevent="addSub"
              >
              <button class="subbtn" aria-label="添加子任务" :disabled="!form.newSub.trim()" @click="addSub">
                <Plus :size="15" />
              </button>
            </div>
          </div>

          <!-- 重复 -->
          <div class="field col">
            <span class="fb">重复</span>
            <div class="chips">
              <button v-for="f in REC_FREQS" :key="f.value" class="chip" :class="{ on: form.recFreq === f.value }" @click="form.recFreq = f.value">
                {{ f.label }}
              </button>
            </div>
            <div v-if="form.recFreq === 'weekly'" class="chips wd">
              <button
                v-for="(w, i) in WEEKDAYS"
                :key="w"
                class="chip"
                :class="{ on: form.recWeekdays.includes(i) }"
                @click="toggleWeekday(i)"
              >
                {{ w }}
              </button>
            </div>
            <div v-if="form.recFreq === 'interval'" class="row itv">
              <span>间隔</span>
              <NumberStepper v-model="form.recInterval" :min="2" :max="30" unit="天" />
            </div>
            <div v-if="form.recFreq !== 'none'" class="row itv">
              <span>结束</span>
              <button class="chip" :class="{ on: !form.recEnd }" @click="form.recEnd = ''">永不</button>
              <input v-model="form.recEnd" class="date" type="date" aria-label="结束日期">
            </div>
            <!-- 面上只留一行结论；「未来实例重建」是实现语义，收进句末说明入口 -->
            <p v-if="form.recFreq !== 'none'" class="recnote row center">
              重复规则会在未来日期自动生成这条待办
              <InfoHint
                title="改规则会怎样"
                content="保存后，未完成的未来条目会按新规则重排；补选的星期 / 间隔同样只对未来的日子生效。"
              />
            </p>
          </div>
        </div>
      </div>
    </div>

    <div class="actions row between">
      <button v-if="todo" class="danger" aria-label="删除待办" @click="remove">
        <Trash2 :size="16" />
      </button>
      <span v-else />
      <button class="save" :disabled="!canSave || saving" @click="save">保存</button>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  /* 表单项之间 16（有明显边界的一档） */
  gap: var(--gap-lg);
}

.field {
  /* 标签与控件 8 */
  gap: var(--gap-sm);
}

.field > span,
.fb {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.title {
  /* 标题是抽屉里最大的一行输入：整行浅井（radius 16、左右 16、高 48） */
  min-height: var(--row-h);
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-m);
  /* 浅井底（--surface-inset）：压在抽屉的玻璃面上仍读得出一层「可输入」的凹陷 */
  background: var(--surface-inset);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
}

.time-row {
  display: flex;
  gap: var(--gap-md);
}

.tcell {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  min-width: 0;
}

.date {
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface-inset);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-medium);
  color: var(--text-1);
  width: 100%;
  box-sizing: border-box;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  /* 同一组胶囊内 4、组与组之间由 .form 的 16 拉开 —— 参照里的「胶囊分组」配方 */
  gap: var(--gap-tight);
}

.chip {
  /* 胶囊：高 28（--control-sm）、左右 16，与其它胶囊同一档 */
  min-height: var(--control-sm);
  padding: var(--sp-6) var(--sp-16);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  /* soft 底 + strong 字（STANDARDS §4）：实底 accent 压在 accent-soft 上读不清 */
  background: var(--accent-soft);
  color: var(--accent-strong);
}

/* ---------- 时长步进器 ---------- */

.dstepper {
  /* 步进器：圆钮与中间数字之间 12（参照的「圆形 −/+ + 数字」配方） */
  gap: var(--gap-md);
  padding: var(--sp-6) var(--sp-8);
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.dstep-btn {
  position: relative;
  /* 步进器圆钮的视觉直径 34（--control-icon），命中区补到 44 */
  width: var(--control-icon);
  height: var(--control-icon);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.dstep-btn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.dstep-btn:disabled {
  /* 禁用浓度走令牌（tokens.css:37-40）：与本文件其余禁用态同一档，不另写裸值 */
  opacity: var(--disabled-opacity);
}

.dval {
  min-width: 96px;
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-m);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  text-align: center;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.dval:active {
  background: var(--surface);
}

.dval.unset {
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.dedit {
  display: flex;
  align-items: baseline;
  gap: var(--gap-tight);
}

.dinput {
  width: 84px;
  padding: var(--sp-4) var(--sp-6);
  border-radius: var(--radius-m);
  border: 1px solid var(--accent);
  background: var(--surface);
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.dinput:focus {
  outline: none;
}

.dinput::-webkit-outer-spin-button,
.dinput::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.dunit {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.notes {
  padding: var(--sp-12) var(--pad-card);
  border-radius: var(--radius-m);
  background: var(--surface-inset);
  font-size: var(--fs-subhead);
  resize: none;
  width: 100%;
  box-sizing: border-box;
}

.actions {
  margin-top: var(--gap-lg);
}

.danger {
  position: relative;
  /* 常规按钮 40（--control-md）：原先 38 与主按钮不等高 */
  width: var(--control-md);
  height: var(--control-md);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* soft 底走令牌（--danger-soft），底色上的图标/文字一律对应 --danger-strong（tokens.css:163-168） */
  background: var(--danger-soft);
  color: var(--danger-strong);
}

/* 删除是破坏性操作：40 的视觉钮命中区撑到 44，避免点偏 */
.danger::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.save {
  min-height: var(--control-md);
  padding: var(--sp-10) var(--sp-32);
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.save:disabled {
  opacity: var(--disabled-opacity);
}

.cnt {
  color: var(--accent);
  margin-left: var(--gap-tight);
}

/* ---------- 附件与标记 ---------- */

.atch-add {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}

.abtn {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  min-height: var(--control-sm);
  padding: var(--sp-6) var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.abtn:disabled {
  opacity: var(--disabled-opacity);
}

.abtn.rec.on {
  /* 同 .danger：soft 底 + strong 字都走令牌 */
  background: var(--danger-soft);
  color: var(--danger-strong);
}

.atch-text {
  margin-top: var(--gap-sm);
}

.tacts {
  margin-top: var(--gap-sm);
}

.mini {
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--sp-12);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.mini.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.mini:disabled {
  opacity: var(--disabled-opacity);
}

.atch-list {
  list-style: none;
  margin: var(--sp-4) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

.arow {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  border-radius: var(--radius-s);
}

@media (hover: hover) {
  .arow:hover {
    background: var(--surface-2);
  }
}

.amain {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--sp-6) var(--sp-8);
  text-align: left;
  font: inherit;
  color: inherit;
}

.aicon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  color: var(--text-2);
}

.aname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.asize {
  flex: none;
  font-style: normal;
  /* 附件体积（「1.2 MB」）是附件条目上的读数，不吃 11px */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.adel {
  position: relative;
  flex: none;
  /* 补齐到 44 命中区（图标 13px + 16px 内边距） */
  padding: var(--sp-16);
  color: var(--text-3);
}

@media (hover: hover) {
  .adel:hover {
    color: var(--danger);
  }
}

.aprev {
  /* 左侧 40 与附件行的图标列对齐，缩略图落在文件名下面 */
  padding: var(--sp-2) var(--sp-8) var(--sp-8) var(--sp-40);
}

.aimg {
  max-width: 100%;
  max-height: 180px;
  border-radius: var(--radius-s);
  display: block;
}

.aaud {
  width: 100%;
  height: 34px;
}

.aempty {
  margin: 0;
  font-size: var(--fs-caption);
}

/* ---------- 「安排」分区线 ---------- */

.sect {
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  margin-top: var(--gap-text);
  color: var(--text-3);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
}

.sect::before,
.sect::after {
  content: '';
  flex: 1;
  height: 0.5px;
  background: var(--line);
}

/* ---------- 四象限（重要 × 紧急） ---------- */

.quad {
  display: grid;
  grid-template-columns: auto 1fr 1fr;
  gap: var(--gap-sm);
}

.quad > i {
  /* 左上角占位格：不可见但必须占网格位，否则整表左移错位 */
  visibility: hidden;
}

.q-head {
  align-self: end;
  text-align: center;
  /* 四象限表头（「重要」「紧急」）是坐标轴名，要吃 11px 以上 */
  font-size: var(--fs-caption);
  color: var(--text-3);
  padding-bottom: var(--sp-2);
}

.q-side {
  align-self: center;
  /* 四象限侧栏坐标名（「紧急」「不紧急」） */
  font-size: var(--fs-caption);
  color: var(--text-3);
  padding-right: var(--sp-4);
}

.q-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--gap-text);
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-m);
  border: 1px solid transparent;
  background: var(--surface-2);
  text-align: left;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.q-cell:active {
  transform: scale(0.98);
}

.q-cell b {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.q-cell em {
  font-style: normal;
  /* 象限格内的条数是计数读数 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* ---------- 细项折叠 ---------- */

.fold {
  border-top: 0.5px solid var(--line);
}

.fold-head {
  width: 100%;
  /* 可展开行是一条标准设置行：高 48 */
  min-height: var(--row-h);
  padding: var(--sp-8) 0;
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  text-align: left;
}

.fold-sub {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.chev {
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.chev.flip {
  transform: rotate(180deg);
}

.fold-body {
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  /* 展开内容左缩进 16：这条展开行左侧没有图标列（只有文字 + chevron），
     参照里 32 的缩进量是「与图标列同宽」，这里减半才不会读成孤立的一块 */
  padding: var(--sp-8) 0 var(--sp-2) var(--sp-16);
}

.subs {
  display: flex;
  flex-direction: column;
}

.sub {
  justify-content: space-between;
  gap: var(--gap-sm);
  padding: var(--sp-8) 0;
  border-bottom: 0.5px solid var(--line);
}

.submain {
  gap: var(--gap-sm);
  font-size: var(--fs-body);
  min-width: 0;
}

.submain input {
  width: 17px;
  height: 17px;
  accent-color: var(--ok);
  flex: none;
}

.submain span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.submain span.off {
  color: var(--text-3);
  text-decoration: line-through;
}

.subdel {
  color: var(--text-3);
  padding: var(--sp-2);
}

.subadd {
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
}

.subinput {
  flex: 1;
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface-inset);
  font-size: var(--fs-subhead);
}

.subbtn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.subbtn:disabled {
  opacity: var(--disabled-opacity);
}

.wd {
  margin-top: var(--gap-sm);
}

.itv {
  gap: var(--gap-md);
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-2);
  align-items: center;
}

.itv .date {
  margin-left: auto;
  width: auto;
}

.recnote {
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: var(--lh-body);
}
</style>
