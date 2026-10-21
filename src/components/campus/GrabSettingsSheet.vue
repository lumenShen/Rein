<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { AlertTriangle, RotateCcw } from 'lucide-vue-next'

import GrabTimeline from '@/components/campus/GrabTimeline.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { useCourseSelectStore } from '@/stores/courseSelect'
import type { GrabSettings } from '@/types'

/**
 * 抢课节奏设置。
 *
 * 只暴露**真正需要动的旋钮**，其余（退避上限、轮询上限）留给默认值 ——
 * 一个抢课页面不该有一屏工程参数，调错了还会让人以为程序坏了。
 *
 * 每个数字面上只留一行结论，完整解释收进标题行右侧的说明入口 ——
 * 这些值的取舍是**概率**而不是对错：快一点更容易被风控，慢一点更容易被别人抢走。
 * 用户该知道自己在换什么，但只想改一个数字的人不该先扫过七段散文。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const store = useCourseSelectStore()

/** 连的是正式域时，实测数字的来处（bkjwtest）与靶子（bkjw）不是同一套风控，要说出来 */
const production = computed(() => store.status?.production === true)
const toast = useToast()

const draft = ref<GrabSettings | null>(null)
const saving = ref(false)

/**
 * 首帧占位用的默认值 —— **不是第二份真相**。
 *
 * 真值在 Rust（`grab.rs` 的 `impl Default for GrabSettings`），打开抽屉时会从那边取；
 * 这份只是在取到之前顶一下，以及在 Rust 还没答上话时别让控件空着。
 * 改这里之前先改 Rust —— 两边不一致的表现是「没动过任何设置，保存后节奏却变了」。
 */
const DEFAULTS: GrabSettings = {
  minIntervalMs: 700,
  pollIntervalMs: 2000,
  fullRetryMs: 5000,
  backoffMs: 1500,
  maxBackoffMs: 30000,
  leadMs: 800,
  maxAttempts: 0,
  maxPolls: 15,
  cedeAfterMs: 0,
  watchWindow: true,
}

const s = computed(() => draft.value ?? store.grabSettings ?? DEFAULTS)

/**
 * 打开抽屉时**先把 Rust 的设置取回来再起草**。
 *
 * 早先是「打开就复制一份当前值」：如果这时还没取到，草稿会落在 DEFAULTS 上，
 * 而保存会把整份草稿写回去 —— 于是用户只是点开看了一眼就关，节奏却被
 * 悄悄重置成了默认（那些不在界面上的字段尤其危险）。
 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    if (!store.grabSettings) {
      try {
        await store.loadGrabSettings()
      } catch {
        // 取不到就用占位值起草，保存时会照原样写回；至少不是静默改档
      }
    }
    draft.value = { ...(store.grabSettings ?? DEFAULTS) }
  },
)

onMounted(() => {
  if (!store.grabSettings) void store.loadGrabSettings()
})

function set<K extends keyof GrabSettings>(key: K, value: GrabSettings[K]): void {
  draft.value = { ...s.value, [key]: value }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await store.saveGrabSettings(s.value)
    toast.toast('已生效')
    emit('close')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function reset(): void {
  draft.value = { ...DEFAULTS }
}

/**
 * 让贤期限按**分钟**显示。
 *
 * 一屏里的时间单位本来就有毫秒（其余几个旋钮）、秒（提示语）、次（提交次数）——
 * 而这个参数的量级是几分钟到几十分钟：写成毫秒读不出来（1800000），写成秒要读三位数。
 * 存库仍是毫秒，引擎也按毫秒判；0 = 死守。
 */
const cedeMin = computed({
  get: () => Math.round(s.value.cedeAfterMs / 60000),
  set: (v: number) => set('cedeAfterMs', Math.max(0, Math.round(v)) * 60000),
})

/**
 * 正在调哪个参数 —— 时间轴上对应的那一段会被点亮，其余淡下去。
 *
 * 靠 `focusin` / `pointerdown` 冒泡到这一层来判定，而不是给每个控件加事件：
 * 这样以后再加参数，只要把它放进同一块 `<section data-key="…">` 里就自动接上。
 */
const active = ref<keyof GrabSettings | null>(null)

function markActive(e: Event): void {
  const sec = (e.target as HTMLElement | null)?.closest?.('[data-key]')
  const key = sec?.getAttribute('data-key')
  if (key) active.value = key as keyof GrabSettings
}

/**
 * 节奏档位：把「要调成多快」这件事做成一次点击，而不是让人点几十下加号。
 *
 * 每一档都写明它的**代价**，因为这几个数字不是对错问题 —— 是拿封禁风险换命中率。
 * 「压测档」标了 12ms（≈80 次/秒），那是拿真账号对教务压出来的数，不是猜的。
 */
const PRESETS: { name: string; hint: string; patch: Partial<GrabSettings> }[] = [
  { name: '保守', hint: '默认节奏，最不容易被风控盯上', patch: { minIntervalMs: 700, pollIntervalMs: 2000, fullRetryMs: 5000 } },
  { name: '偏快', hint: '窗口很短、课又热门时用', patch: { minIntervalMs: 200, pollIntervalMs: 800, fullRetryMs: 1500 } },
  { name: '压测档', hint: '≈80 次/秒，实测无异常但风险自负', patch: { minIntervalMs: 12, pollIntervalMs: 300, fullRetryMs: 600 } },
]

/**
 * 档位按钮：**压测档要两步**。
 *
 * 它把请求量从「每秒 1.4 次」一步抬到「每秒 80 次」，而它离默认档只有一次点击，
 * 代价却写在 11px 的提示里、还直接落库。代价大的档位没有第二次确认是不合理的 ——
 * 这也是审查里唯一被点名的「一次点击就不可逆」的地方。
 */
const pendingPreset = ref<string | null>(null)
let presetTimer: number | null = null

function applyPreset(p: (typeof PRESETS)[number]): void {
  if (p.name === '压测档' && pendingPreset.value !== p.name) {
    pendingPreset.value = p.name
    if (presetTimer != null) window.clearTimeout(presetTimer)
    presetTimer = window.setTimeout(() => (pendingPreset.value = null), 5000)
    return
  }
  pendingPreset.value = null
  draft.value = { ...s.value, ...p.patch }
  active.value = 'minIntervalMs'
}
</script>

<template>
  <SheetModal :open="open" title="抢课节奏" initial-snap="medium" @close="emit('close')">
    <p class="lead t-2">
      这些数字是<b>概率上的取舍</b>：快一点更容易被教务风控拦下，慢一点更容易被别人抢走。
      默认值按「抢 1–4 门课」标定，不确定就别改。
    </p>

    <!-- 正式域 / 测试域必须说清：压测档那 12ms 是**在 bkjwtest 上**实测出来的数 -->
    <p v-if="production" class="note warn">
      <AlertTriangle :size="12" />
      <span>
        你连的是<b>正式教务</b>（bkjw）：下面这些实测数字来自测试域，正式域的风控策略未知。
        保守档是默认值；「压测档」只在你清楚代价时用。
      </span>
    </p>

    <!-- 时间轴放在最前面：先看懂循环长什么样，再谈调哪个数字 -->
    <GrabTimeline :settings="s" :active="active" />

    <div class="presets">
      <button
        v-for="p in PRESETS"
        :key="p.name"
        class="preset"
        :class="{ danger: pendingPreset === p.name }"
        :title="p.hint"
        @click="applyPreset(p)"
      >
        <b>
          {{ pendingPreset === p.name ? '再点一次确认' : p.name }}
        </b>
        <em>{{ pendingPreset === p.name ? '这一档会把请求量抬到 ≈80 次/秒' : p.hint }}</em>
      </button>
    </div>

    <div class="rows" @focusin="markActive" @pointerdown="markActive">
      <!-- 每个参数：面上只留一行结论，完整解释收进标题行右侧的说明入口。
           一屏七个参数各带一段散文，想改一个数字的人要先扫过整面文字墙 -->
      <section class="block" data-key="minIntervalMs" @pointerenter="active = 'minIntervalMs'">
        <div class="p-head">
          <NumberStepper
            :model-value="s.minIntervalMs"
            :min="10"
            :max="5000"
            :step="50"
            unit="ms"
            label="两次提交的最小间隔"
            @update:model-value="set('minIntervalMs', $event)"
          />
          <InfoHint title="两次提交的最小间隔">
            <p>所有任务共用一个闸门 —— 排 5 门课不会变成 5 倍请求量。</p>
            <p><strong>它才是「多久打一次教务」的总开关</strong>，其余几个等待都得排在它后面。</p>
          </InfoHint>
        </div>
        <p class="concl">排 5 门课也不会变成 5 倍请求量</p>
      </section>

      <section class="block" data-key="leadMs" @pointerenter="active = 'leadMs'">
        <div class="p-head">
          <NumberStepper
            :model-value="s.leadMs"
            :min="0"
            :max="3000"
            :step="50"
            unit="ms"
            label="开窗前提前出手"
            @update:model-value="set('leadMs', $event)"
          />
          <InfoHint title="开窗前提前出手">
            <p>请求在路上要走一会。提前这一点出手，才能让<strong>请求本身</strong>落在开窗那一瞬间，而不是排在开窗之后。</p>
            <p>网络越慢越该调大。</p>
          </InfoHint>
        </div>
        <p class="concl">网络越慢越该调大</p>
      </section>

      <section class="block" data-key="pollIntervalMs" @pointerenter="active = 'pollIntervalMs'">
        <div class="p-head">
          <NumberStepper
            :model-value="s.pollIntervalMs"
            :min="50"
            :max="10000"
            :step="100"
            unit="ms"
            label="查结果间隔"
            @update:model-value="set('pollIntervalMs', $event)"
          />
          <InfoHint
            title="查结果间隔"
            content="提交之后隔多久问一次「选上了吗」。教务自己也是 2 秒一次。"
          />
        </div>
        <p class="concl">教务自己也是 2 秒一次</p>
      </section>

      <section class="block" data-key="fullRetryMs" @pointerenter="active = 'fullRetryMs'">
        <div class="p-head">
          <NumberStepper
            :model-value="s.fullRetryMs"
            :min="100"
            :max="60000"
            :step="100"
            unit="ms"
            label="满员后重试间隔"
            @update:model-value="set('fullRetryMs', $event)"
          />
          <InfoHint
            title="满员后重试间隔"
            content="「已满」会一直守着，但节奏放慢 —— 名额释放是稀疏事件，打快了只是白费力气。"
          />
        </div>
        <p class="concl">「已满」会一直守着，只是放慢节奏</p>
      </section>

      <section class="block" data-key="maxAttempts" @pointerenter="active = 'maxAttempts'">
        <div class="p-head">
          <NumberStepper
            :model-value="s.maxAttempts"
            :min="0"
            :max="500"
            :step="5"
            unit="次"
            label="最多提交次数"
            @update:model-value="set('maxAttempts', $event)"
          />
          <InfoHint
            title="最多提交次数"
            content="0 = 不限，一直抢到窗口关闭。抢课通常都设 0；只在你想限制「试几次不行就算了」时才填。"
          />
        </div>
        <p class="concl">0 = 不限，一直抢到窗口关闭</p>
      </section>

      <!-- 志愿组：这条是「互斥备选」的耐心旋钮 -->
      <section class="block" data-key="cedeAfterMs" @pointerenter="active = 'cedeAfterMs'">
        <div class="p-head">
          <NumberStepper
            v-model="cedeMin"
            :min="0"
            :max="120"
            :step="1"
            unit="分钟"
            label="让贤期限"
          />
          <InfoHint title="让贤期限">
            <p>只在<strong>志愿组</strong>里有意义。当前志愿一直满员超过这么久，就把出手机会让给下一志愿。</p>
            <p><strong>0 = 死守</strong>：只有它彻底没戏（时间冲突 / 连败 / 窗口关闭）才轮到下一个 —— 满员是等得到名额的，所以默认死守。</p>
          </InfoHint>
        </div>
        <p class="concl">0 = 死守（默认）</p>
      </section>

      <section class="block toggle-row" data-key="watchWindow" @pointerenter="active = 'watchWindow'">
        <div class="col">
          <b>窗口监听</b>
          <em>App 开着就每分钟问一次「窗口公布了没有」，即使还没排任何课</em>
        </div>
        <ToggleSwitch
          :model-value="s.watchWindow"
          label="窗口监听"
          @update:model-value="set('watchWindow', $event)"
        />
        <InfoHint title="窗口监听">
          <p>关掉它，你就只能在手动刷新页面时才发现窗口开了。开着才可能「窗口一开就收到提示」。</p>
          <p><strong>监听同样活在 App 进程里</strong>：App 被划掉或清理后它就不再问教务了 —— 窗口按教务处的钟点开，而那时人往往不在电脑前。</p>
        </InfoHint>
        <p class="concl">关掉它，只能手动刷新页面时才发现窗口开了</p>
      </section>
    </div>

    <div class="acts">
      <button class="primary" :disabled="saving" @click="save">保存</button>
      <button class="ghost" @click="reset">
        <RotateCcw :size="14" /> 恢复默认
      </button>
    </div>
  </SheetModal>
</template>

<style scoped>
.lead {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  margin-bottom: var(--gap-lg);
}

/* 「你连的是正式教务」这条警告原先直接拿 --warn 当文字色（#ff9500 压在白底上
   只有 2.2:1），而 tokens.css 开头就写明了：实底档是给填充/描边用的，
   当文字用要换 --*-strong 那一档。这里按模块里其它警告块的做法统一：
   soft 底 + strong 文字 */
.note.warn {
  display: flex;
  gap: var(--gap-sm);
  align-items: flex-start;
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--warn-strong);
  background: var(--warn-soft);
  border-radius: var(--radius-m);
  padding: var(--sp-8) var(--pad-inline);
  margin-bottom: var(--gap-md);
}

.block {
  /* 参数分组面：内距 12（二级面的紧凑档），圆角收一档；组间 12 */
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  margin-bottom: var(--gap-md);
}

/* 节奏档位：一次点击把三个数字一起调好，省得点几十下加号 */
.presets {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap-sm);
  margin-bottom: var(--gap-md);
}

.preset {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  padding: var(--sp-8) var(--sp-6);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.preset:active {
  transform: scale(0.97);
}

.preset b {
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.preset em {
  font-size: var(--fs-micro);
  font-style: normal;
  /* 每一档的**代价**（「默认节奏，最不容易被风控盯上」）—— 那正是选档时要读的 */
  color: var(--text-2);
  line-height: var(--lh-title);
}

/* 待确认的压测档：一眼看出这一下点下去代价不一样 */
.preset.danger {
  background: var(--danger-soft);
  box-shadow: var(--shadow-card), inset 0 0 0 1px var(--danger-strong);
}

.preset.danger b,
.preset.danger em {
  color: var(--danger-strong);
}

.toggle-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: var(--gap-tight) var(--gap-md);
}

.toggle-row .col {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  min-width: 0;
}

.toggle-row b {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.toggle-row em {
  font-size: var(--fs-micro);
  font-style: normal;
  line-height: var(--lh-caption);
}

/* 参数行：步进器占满一行，说明入口贴在右端（与步进钮同一行、垂直居中） */
.p-head {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
}

/* 步进器撑满剩余宽度：否则它收缩成内容宽，「? 」会掉到行中间 */
.p-head .stepper {
  flex: 1;
}

/* 每个参数面上只留一行结论 —— 完整解释在标题行右侧的 InfoHint 里。
   一行结论也要读得出来（--text-2），不能是最淡的那档 */
.concl {
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  margin-top: var(--gap-text);
  color: var(--text-2);
}

.toggle-row .concl {
  grid-column: 1 / -1;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin-top: var(--gap-lg);
}

.primary {
  min-height: var(--control-md);
  padding: var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
}

.ghost {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: var(--sp-12);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-subhead);
  font-weight: var(--fw-semibold);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}
</style>
