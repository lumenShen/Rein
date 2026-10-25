<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { HEAT_LABELS, MUSCLE_DESCS, MUSCLE_LABELS, isMuscleKey } from '@/config/muscles'
import type { ActivationMap, HeatLevel, MuscleKey } from '@/config/muscles'

import frontSvg from '@/assets/muscles/rein/front.svg?raw'
import backSvg from '@/assets/muscles/rein/back.svg?raw'
import sideSvg from '@/assets/muscles/rein/side.svg?raw'

/**
 * 全身肌群激活图：正面 / 背面 / 侧面三视图。
 *
 * 素材来自 BodyParts3D 的真实人体解剖网格（scripts/build-anatomy.mjs 生成）：
 * 正交投影 → 栅格化 → 等值线追踪，三个视图共用同一套解剖比例，因此等大对齐。
 * 每块肌肉是一个 <g data-m="肌群键">，按观察深度用画家算法层叠 —— 远的下、
 * 近的上，深层肌群同样被画出来，只是被浅层盖住。
 *
 * 分区属性：
 *   data-m      肌群键（与 src/config/muscles.ts 的 MUSCLE_KEYS 一一对应，含 13 个深层键）
 *   data-layer  1 = 浅层肌、2 = 深层肌（「深层」开关控制是否显示）
 *   data-depth  观察深度（0 = 离观察者最远，9 = 最近）；文档顺序即按它升序排好
 *   data-kind   构建脚本写出的 class（"m"/"a"）；**高亮与否只看键**，
 *               键在 MUSCLE_KEYS 内就是肌群，不在就只是解剖底衬
 *
 * ---------- 为什么底色是裸 rgba（令牌纪律的一处**有意豁免**）----------
 * 下面 `.layer.base` / `.layer.deep` 的 fill / stroke 是**解剖素材色**（皮肤 / 骨骼 /
 * 深层肌的教科书配色），不是主题语义色：它描述的是「人体这个物体长什么样」，
 * 与亮暗主题、与运动绿、与任何语义色都不相关。收成 `--mmap-*` 令牌只是把同一批数字
 * 搬个家，却会让它看起来像是「可以换肤的主题色」—— 那正是这里不想给出的暗示。
 * 要换这一套配色，改的是 `scripts/build-anatomy.mjs` 的调色，不是 tokens.css。
 * （决策见 docs/exercise-quality-review-2026-10-17.md §8 D8）
 *
 * ---------- 深度分层（2026-09-26）----------
 * 加这一层是因为「三档颜色」本身说不清**是哪一块肌肉**：正面视图里背阔肌被胸大肌、
 * 腹直肌压住，二者又都是同一种绿，一眼看去只能读出"这里有块肌肉被激活了"，
 * 读不出是哪块。于是按 data-depth 把每块分进三个层，并按「越靠观察者越实」给透明度：
 *
 *   外层（depth ≥ 6.0）alpha 1.00  |  中层（3.2 ~ 6.0）alpha 0.78  |  后层（< 3.2）alpha 0.56
 *
 * 三个层**各自**乘以激活档位的颜色，所以「外层稳定」也依然比「后层主攻」实 —— 读的人
 * 先看到的是"远近"这一维，再看颜色读出强度。阈值不是随手取的：0~9 这个深度标尺上，
 * 3.2 / 6.0 恰好把正视图切成「后背那一片（斜方下 / 菱形 / 背阔 / 竖脊 / 臀 / 腘绳）」
 * 与「前面那一片（胸上下 / 腹直 / 腹斜 / 股四头）」，背视图同样切得干净 —— 而背面视图
 * 的层序是**反的**（可见的背肌在外层），这正对：判据是"离观察者多近"，不是"在人体的哪一面"。
 *
 * 极**致**档另给被表层覆盖的肌肉加景深模糊（中层 1px、后层 2px）：透明度之外再加一条
 * 「被盖住的本来就不在焦平面上」的线索。单位是**CSS 像素**，而 SVG 里的模糊按用户坐标算
 * （台架实测：viewBox 660 渲染到 84px 宽时 blur(16px) 只铺开约 10 个屏幕像素），
 * 所以这里由 JS 量出「1 CSS 像素 = 多少用户单位」写成 --mmap-u，CSS 再乘上去 ——
 * 换个尺寸渲染时模糊量不会跟着缩放失真。
 *
 * 三个层是**按 band 分组的 <g>**，不是给每块单独加样式：分组之后模糊一次只跑 3 遍
 * （而不是每块肌肉一遍），而且因为生成的 SVG 本来就是按 depth 升序写的文档顺序，
 * 分组不会改变任何一块的层叠次序（同组内保持原顺序，组间按 band 顺序）。
 *
 * 着色走 CSS 继承：激活档 3 主攻 / 2 辅助 / 1 稳定 = 运动橙的 88% / 62% / 34%；
 * 未激活走中性冷灰（「没算进评估」不是「练得少」），深层解剖走另一档冷灰。
 * 练够分模式另用一套红 / 琥珀 / 绿语义阶（--heat-*），不与运动橙混用。
 *
 * 细化到肌束：三角肌前/中/后束、胸大肌上/下束、斜方肌上/中/下束、
 * 股四头分股外侧/股直/股内侧、小腿分腓肠肌/比目鱼肌等，均可单独高亮。
 *
 * ---------- 练够分热力模式（heat，2026-10-02 由「容量」改为「练够分」）----------
 * `heat` 传值时整图改画**每块肌肉的本周练够分**，而不是单次动作的激活档位。
 * 为什么另立一套而不是把分数塞进三档 activation：三档只能表达「有没有练」，
 * 而练够分要回答的是「练够了没有」—— 同一块肌肉「30 分」和「100 分」都得看出来。
 *
 * 档位语义**与旧容量相反**：练够分越高越充分（绿），越低越该补（红）。
 * 五档只是颜色粗分（未练 / 不足 / 基本够 / 足够 / 充分），规范里的六段档名
 * （运动充分…明显不足）由调用方逐行以文字给出 —— 颜色回答"先看哪块"，
 * 文字回答"到底多少分"。
 *
 * 热力模式下**本组件不再自带抽屉**：分组明细（10 个评估肌群的分/档/条）与
 * 「计算体系说明」合并成调用方的一个抽屉（`TrainingScoreSheet`），
 * 因为分数本来就是调用方算出来交给本组件的 —— 抽屉留在组件里就得把同一份
 * 数据再定义一遍。所以热力模式下 `interactive` 的点击改为 `emit('detail')`。
 */
const props = defineProps<{
  /** 单次动作的激活档位（3 主攻 / 2 辅助 / 1 稳定）。heat 存在时本项被忽略 */
  activation?: ActivationMap
  /**
   * 练够分热力档位（0..4），细肌群 → 档位（同评估组同色，投影由调用方做）。
   * 传了它就是热力图；不传则退回 activation 的档位着色。
   */
  heat?: Partial<Record<MuscleKey, HeatLevel>>
  /**
   * 热力模式下每块肌肉的悬停副标（如「胸 84 分 · 足够」）。
   * 热力模式**优先整条采用它**：分数与档名都比一个「足够」更有信息量。
   */
  heatRows?: Partial<Record<MuscleKey, string>>
  interactive?: boolean
}>()

/** 热力模式下点图 → 交给调用方开它自己的练够分抽屉（见文件头说明） */
const emit = defineEmits<{ detail: [] }>()

const heatMode = computed(() => props.heat !== undefined)

/** 无障碍标签：两种模式说的事不同（激活 = 这块肌肉练得多主；热力 = 练够了没有） */
const rootLabel = computed(() =>
  heatMode.value
    ? props.interactive
      ? '查看练够分明细'
      : '肌群练够分热力图'
    : props.interactive
      ? '查看全部激活肌群'
      : '肌群激活图',
)
const viewLabel = computed(() => (heatMode.value ? '肌群练够分' : '肌群激活'))

/** 当前激活表（非热力模式下用于着色与图例） */
const act = computed<ActivationMap>(() => props.activation ?? {})

interface Region {
  kind: 'm' | 'a'
  key: string
  layer: number
  depth: number
  markup: string
}

interface View {
  viewBox: string
  base: string
  regions: Region[]
}

/** 从生成的 SVG 里拆出底图与各分区（文档顺序即层叠顺序） */
function parseView(raw: string): View {
  const viewBox = raw.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 660 1500'
  const base = raw.match(/<g id="base">([\s\S]*?)<\/g>/)?.[1] ?? ''
  const regions: Region[] = []
  const re = /<g class="(m|a)" data-m="([^"]+)" data-layer="(\d)" data-depth="([^"]+)">([\s\S]*?)<\/g>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    regions.push({
      kind: m[1] as 'm' | 'a',
      key: m[2],
      layer: Number(m[3]),
      depth: Number(m[4]),
      markup: m[5],
    })
  }
  return { viewBox, base, regions }
}

const FRONT = parseView(frontSvg)
const BACK = parseView(backSvg)
const SIDE = parseView(sideSvg)

const VIEWS: { label: string; view: View }[] = [
  { label: '正面', view: FRONT },
  { label: '背面', view: BACK },
  { label: '侧面', view: SIDE },
]

/** 深层开关：关掉只留浅层肌（被激活的深层肌仍会显示，否则点了没反应） */
const showDeep = ref(false)

/* ---------- 深度分层：把每块肌肉按 data-depth 分进 外层 / 中层 / 后层 ---------- */

/** 分层阈值（深度标尺 0~9，数值的来源与解剖依据见文件头）。改了要同步 e2e 的断言 */
const BAND_MID_FROM = 3.2
const BAND_NEAR_FROM = 6.0

/** 0 = 后层（离观察者最远）、1 = 中层、2 = 外层；索引即绘制顺序，也是 CSS 类名后缀 */
function bandOf(depth: number): 0 | 1 | 2 {
  if (depth >= BAND_NEAR_FROM) return 2
  return depth >= BAND_MID_FROM ? 1 : 0
}

interface Band {
  band: 0 | 1 | 2
  regions: Region[]
}

/**
 * 把一个视图的分区按 band 分组。生成脚本写出的文档顺序本来就是按 data-depth 升序，
 * 所以「按 band 归组」不会改变任何一块的层叠次序 —— 组内保持原顺序、组间按 band 升序，
 * 连起来与原来的文档顺序等价。这也是能把模糊挂在组上的前提。
 */
function bandsOf(regions: Region[]): Band[] {
  const out: Band[] = []
  for (const r of regions) {
    const band = bandOf(r.depth)
    const last = out[out.length - 1]
    if (last && last.band === band) last.regions.push(r)
    else out.push({ band, regions: [r] })
  }
  return out
}

/** 可高亮分区：键在 MUSCLE_KEYS 内即算肌群（不依赖 SVG 里的 class） */
function isMuscle(r: Region): boolean {
  return isMuscleKey(r.key)
}

/**
 * 该分区是否有值可画。
 *
 * 两种模式对「没有值」的处理**刻意不同**：
 *  · 激活模式：没有值的肌群不参与着色（保持中性冷灰），因为「这个动作没练到它」
 *    本来就该读作背景；
 *  · 热力模式：**有值才有色**，而 0 档（无负荷）本身就是一个值 ——
 *    热力图要回答的正是「哪块没练」，把无负荷的肌群也画成冷色。
 *    所以这里按 key 是否出现在 heat 表里判定（而不是按真值判定）。
 */
function hasValue(r: Region): boolean {
  if (!isMuscle(r)) return false
  const k = r.key as MuscleKey
  return heatMode.value ? props.heat?.[k] !== undefined : act.value[k] !== undefined
}

function isActive(r: Region): boolean {
  return hasValue(r)
}

function isVisible(r: Region): boolean {
  if (r.layer <= 1) return true
  if (showDeep.value) return true
  return isActive(r)
}

/**
 * 深层分区在文档顺序里画在浅层之下，会被浅层盖住而「标了看不见」。
 * 已激活的深层分区在全部浅层之后再叠画一遍（半透明），保证可见。
 * 叠画那一遍同样按 band 分组 —— 否则它又会变回「每块肌肉一遍滤镜」。
 */
function overlayBands(view: View): Band[] {
  return bandsOf(view.regions.filter((r) => r.layer > 1 && isActive(r)))
}

function lv(key: MuscleKey): string {
  if (heatMode.value) {
    const h = props.heat?.[key]
    return h === undefined ? '' : `h${h}`
  }
  const v = act.value[key]
  return v === 3 ? 'l3' : v === 2 ? 'l2' : v === 1 ? 'l1' : ''
}

/** 分区着色：激活模式看档位、热力模式看练够分档；两者都没有则走中性（idle） */
function cls(key: MuscleKey): string {
  const v = lv(key)
  return v || 'idle'
}

function title(key: MuscleKey): string {
  if (heatMode.value) {
    const h = props.heat?.[key]
    if (h === undefined) return MUSCLE_LABELS[key]
    // 调用方给的副标（「胸 84 分 · 足够」）信息量大于单一个档名 —— 整条采用
    return props.heatRows?.[key] ?? `${MUSCLE_LABELS[key]} · ${HEAT_LABELS[h]}`
  }
  const v = act.value[key]
  if (!v) return MUSCLE_LABELS[key]
  return `${MUSCLE_LABELS[key]} · ${v === 3 ? '主攻' : v === 2 ? '辅助' : '稳定'}`
}

/* ---------- 交互 ----------
 * 激活模式：点击图 → 内置抽屉列出全部参与肌群（本组件自己就能回答，数据就在手里）。
 * 热力模式：点击图 → `emit('detail')`，由调用方开它的练够分抽屉 ——
 * 分数是调用方算的，明细（10 个评估组 + 计算说明）也归调用方一份定义。 */

const detailOpen = ref(false)

interface MuscleRow {
  key: MuscleKey
  label: string
  tag: string
  level: number
  desc: string
}

/** 激活模式的抽屉列表：主攻 → 辅助 → 稳定 */
const sortedMuscles = computed<MuscleRow[]>(() => {
  const rows: MuscleRow[] = []
  const src = act.value as Record<string, number | undefined>
  for (const key of Object.keys(src)) {
    if (!isMuscleKey(key)) continue
    const v = src[key]
    if (v === undefined) continue
    rows.push({
      key,
      label: MUSCLE_LABELS[key],
      tag: v === 3 ? '主攻' : v === 2 ? '辅助' : '稳定',
      level: v,
      desc: MUSCLE_DESCS[key],
    })
  }
  return rows.sort((a, b) => b.level - a.level)
})

const detailTitle = computed(() => `激活肌群 · ${sortedMuscles.value.length} 个`)

function onMapTap(): void {
  if (!props.interactive) return
  if (heatMode.value) emit('detail')
  else detailOpen.value = true
}

function toggleDeep(): void {
  showDeep.value = !showDeep.value
}

/** 分层示意（InfoHint 插槽用）：三个 band 的透明度与图上完全一致 */
const LAYER_BANDS = [
  { label: '外层', alpha: 1, desc: '最靠近观察者' },
  { label: '中层', alpha: 0.78, desc: '中间层' },
  { label: '后层', alpha: 0.56, desc: '离观察者最远' },
]

/* ---------- 景深模糊的换算：1 CSS 像素 = 多少 SVG 用户单位 ---------- */

/**
 * SVG 里的 CSS `filter: blur(Npx)` 按**用户坐标**算，不是屏幕像素 —— 台架实测：
 * viewBox 660 渲染到 84px 宽（缩放 0.127）时，blur(16px) 在屏幕上只铺开约 10 个像素，
 * 而不是 16 个。所以「1px 模糊」不能直接写 blur(1px)（那样只有 0.13 个屏幕像素，
 * 等于没加），得先量出缩放比再换算。
 *
 * 量出来的是**用户单位/CSS 像素**（= viewBox 宽 / 实测渲染宽，getBoundingClientRect
 * 报的就是 CSS 像素），写进 --mmap-u，CSS 再乘上想要的像素数。
 * 刻意**不**除 devicePixelRatio：景深是**视觉**线索，「1px」该指同一个观感量级，
 * 除以 dpr 会让手机（dpr 2.75~3）上的模糊缩到 1/3、等于关掉。所以这里的 px 是
 * CSS 像素，三端观感一致。量在**根元素**上，三个视图共用一份 —— 它们本来就等大。
 * 尺寸变了要重量（.figwrap 的宽度是响应式的）。
 */
const root = ref<HTMLElement | null>(null)
let scaleObserver: ResizeObserver | null = null

function syncUnit(): void {
  const host = root.value
  const svg = host?.querySelector<SVGSVGElement>('.figwrap svg')
  if (!host || !svg) return
  const viewBoxWidth = svg.viewBox.baseVal.width || 660
  const rendered = svg.getBoundingClientRect().width
  if (rendered <= 0) return
  host.style.setProperty('--mmap-u', String(viewBoxWidth / rendered))
}

onMounted(() => {
  syncUnit()
  scaleObserver = new ResizeObserver(() => syncUnit())
  if (root.value) scaleObserver.observe(root.value)
})

onUnmounted(() => {
  scaleObserver?.disconnect()
})
</script>

<template>
  <div
    ref="root"
    class="mmap col"
    :class="{ interactive }"
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive ? 0 : undefined"
    :aria-label="rootLabel"
    @click="onMapTap"
    @keydown.enter.prevent="onMapTap"
    @keydown.space.prevent="onMapTap"
  >
    <div class="figs row">
      <figure v-for="item in VIEWS" :key="item.label">
        <div class="figwrap">
          <svg :viewBox="item.view.viewBox" role="img" :aria-label="`${viewLabel} · ${item.label}视图`">
            <g class="layer base" aria-hidden="true" v-html="item.view.base" />
            <!-- 按深度分层：三个 band 各是一个组，越靠观察者的越实（后层最淡）。
                 分组同时是模糊的单位 —— 极致档每个组只跑一遍滤镜，不是每块肌肉一遍 -->
            <g
              v-for="b in bandsOf(item.view.regions)"
              :key="`${item.label}-band-${b.band}`"
              class="band"
              :class="`band-${b.band}`"
            >
              <template v-for="r in b.regions" :key="`${item.label}-${r.key}`">
                <g
                  v-show="isVisible(r)"
                  class="layer"
                  :class="isMuscle(r) ? ['muscle', cls(r.key as MuscleKey)] : 'anat'"
                  :data-m="r.key"
                  :data-layer="r.layer"
                  :data-depth="r.depth"
                >
                  <title v-if="isMuscle(r)">{{ title(r.key as MuscleKey) }}</title>
                  <g v-html="r.markup" />
                </g>
              </template>
            </g>
            <!-- 深层已激活分区：叠画在浅层之上，否则被盖住看不见（同样按 band 分组） -->
            <g
              v-for="b in overlayBands(item.view)"
              :key="`${item.label}-ov-band-${b.band}`"
              class="band"
              :class="`band-${b.band}`"
            >
              <g
                v-for="r in b.regions"
                :key="`${item.label}-overlay-${r.key}`"
                class="layer muscle overlay"
                :class="cls(r.key as MuscleKey)"
                aria-hidden="true"
                v-html="r.markup"
              />
            </g>
          </svg>
        </div>
        <figcaption>{{ item.label }}</figcaption>
      </figure>
    </div>

    <!-- 图例：两种模式的说法不同 —— 激活说「这块肌肉练得多主」，热力说「练够了没有」 -->
    <div v-if="heatMode" class="legend row heatlegend">
      <span v-for="h in ([0, 1, 2, 3, 4] as HeatLevel[])" :key="h">
        <i :class="`hs${h}`" />{{ HEAT_LABELS[h] }}
      </span>
      <button
        class="depthbtn"
        type="button"
        :aria-pressed="showDeep"
        @click.stop="toggleDeep"
      >
        {{ showDeep ? '含深层' : '仅浅层' }}
      </button>
    </div>
    <div v-else class="legend row">
      <span><i class="d3" />主攻</span>
      <span><i class="d2" />辅助</span>
      <span><i class="d1" />稳定</span>
      <button
        class="depthbtn"
        type="button"
        :aria-pressed="showDeep"
        @click.stop="toggleDeep"
      >
        {{ showDeep ? '含深层' : '仅浅层' }}
      </button>
      <!-- 分层说明收进帮助入口：「外层/中层/后层」是组件内部术语，配上示意图才读得懂 -->
      <InfoHint class="legendhint" title="分层示意">
        <div class="lh-rows">
          <div v-for="b in LAYER_BANDS" :key="b.label" class="lh-row">
            <i class="lh-dot" :style="{ opacity: b.alpha }" />
            <b class="lh-name">{{ b.label }}</b>
            <span class="lh-desc">{{ b.desc }}</span>
          </div>
        </div>
        <p>透明度表示这块肌肉离观察者的远近 —— 越靠前越实，和颜色的深浅是两回事。</p>
        <p>正面视图里的背阔肌属于后层。</p>
      </InfoHint>
    </div>
    <!-- 深度图例与点击提示：**只在激活模式给**。
         它们是解释「同一个绿色是胸还是背」与「图还能点」的说明文字；热力视图下
         卡上已经有明确的「说明」按钮，再留两行说明只是噪音（2026-10-02 按用户意见移除）。
         分层那句话同理收进图例行右端的 InfoHint（带示意图），不再平铺在卡面上。 -->
    <template v-if="!heatMode">
      <p v-if="interactive" class="taphint">点击查看全部激活肌群</p>
    </template>

    <!-- 激活肌群抽屉（**只有激活模式**；热力模式的明细与计算说明归调用方的练够分抽屉） -->
    <SheetModal v-if="!heatMode" :open="detailOpen" :title="detailTitle" @close="detailOpen = false">
      <div v-for="m in sortedMuscles" :key="m.key" class="mrow row">
        <i class="dot" :class="lv(m.key)" />
        <div class="mid flex-1">
          <div class="namerow row">
            <b>{{ m.label }}</b>
            <span class="tag t-3">{{ m.tag }}</span>
          </div>
          <p class="desc">{{ m.desc }}</p>
        </div>
      </div>
    </SheetModal>
  </div>
</template>

<style scoped>
.mmap {
  gap: var(--sp-10);
  align-items: center;
  width: 100%;
}

.figs {
  justify-content: center;
  /* 两幅人体图之间 24（--gap-xl，区块级）：原来 22 在格点外 */
  gap: var(--gap-xl);
}

figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 图与图下标签 8（标题与内容） */
  gap: var(--gap-sm);
}

/* 三视图共用同一 viewBox（0 0 660 1500），按宽度等比缩放即得等大人体 */
.figwrap {
  width: 84px;
}

.figwrap svg {
  width: 100%;
  height: auto;
  display: block;
}

/* ---------- 深度分层：越靠观察者越实 ----------
   三个 band 的透明度**各自**叠在激活档位的颜色上（fill 在 .layer.l1/2/3 上，与这里正交）：
   于是「外层稳定」也比「后层主攻」实 —— 先读出远近，再读颜色读强度。
   数值刻意拉开到一眼能分（1 / 0.78 / 0.56）：差 0.05 那种量级在读图时是读不出来的，
   而这套分层的唯一目的就是"一眼分清是哪一块"。 */
.band {
  opacity: var(--band-alpha, 1);
}

.band-0 {
  --band-alpha: 0.56;
}

.band-1 {
  --band-alpha: 0.78;
}

.band-2 {
  --band-alpha: 1;
}

/* 极致档：被表层覆盖的肌肉再加一条景深线索（中层 1px、后层 2px 模糊）。
   单位换算见脚本里的 --mmap-u —— SVG 内的模糊按用户坐标算，直接写 1px 等于没加。
   var() 的兜底值是 dpr=1 时量出来的那份，只用于 JS 量到之前的首帧。
   只在极致档给：这是"更贵但更像真玻璃"的那一档该付的钱，其余档靠透明度梯度就够了。 */
html[data-perf='extreme'] .band-1 {
  filter: blur(calc(1 * var(--mmap-u, 7.86) * 1px));
}

html[data-perf='extreme'] .band-0 {
  filter: blur(calc(2 * var(--mmap-u, 7.86) * 1px));
}

/* 命中只发生在「画了的肌群 path」上（空白处穿透到下层/卡片） */
.layer {
  pointer-events: none;
}

.layer.muscle :deep(path) {
  pointer-events: visiblePainted;
}

.interactive {
  cursor: pointer;
}

.interactive .layer.muscle :deep(path) {
  cursor: pointer;
}

/* 底图=素描灰轮廓；未激活肌群=**中性冷灰蓝**，不是暖调。
   未激活不是「练得少」，而是「这块没算进评估」；用暖色会和练够分 h1（不足）
   抢同一片色相。每块带细描边，分区缝隙+描边清晰可读。激活按运动橙三档打标 */
.layer.base {
  fill: rgba(120, 110, 95, 0.34);
}

.layer.base :deep(path) {
  stroke: rgba(90, 70, 55, 0.55);
  stroke-width: 1.2;
  stroke-linejoin: round;
}

.layer.idle {
  fill: rgba(128, 132, 150, 0.28);
}

/* 深层解剖：冷灰、无描边重音，隐去浅层后读作「更里面一层」 */
.layer.anat {
  fill: rgba(112, 106, 128, 0.26);
}

.layer.muscle :deep(path) {
  stroke: rgba(90, 45, 30, 0.4);
  stroke-width: 1;
  stroke-linejoin: round;
}

@media (prefers-color-scheme: dark) {
  .layer.base {
    fill: rgba(150, 142, 130, 0.36);
  }

  .layer.base :deep(path) {
    stroke: rgba(230, 220, 205, 0.4);
  }

  .layer.idle {
    fill: rgba(160, 166, 190, 0.26);
  }

  .layer.anat {
    fill: rgba(150, 144, 170, 0.22);
  }

  .layer.muscle :deep(path) {
    stroke: rgba(255, 214, 200, 0.16);
  }
}

/* 激活三档（主攻 / 辅助 / 稳定）＝ 运动模块色的单色阶。
   这是「这块肌肉被练得多主」，是运动身份，不是好坏判断，所以走橙；
   低档不再直接用 14% 的 soft（叠在肤色上几乎看不见），改成 34% 的混色。 */
.layer.l1 {
  fill: color-mix(in srgb, var(--c-exercise) 34%, transparent);
}

.layer.l2 {
  fill: color-mix(in srgb, var(--c-exercise) 62%, transparent);
}

.layer.l3 {
  fill: color-mix(in srgb, var(--c-exercise) 88%, transparent);
}

/* ---------- 练够分的 5 档色阶（低 → 高）----------
   色相在表达"该不该管"：红（不足，最该补）→ 琥珀（基本够）→ 绿（足够/充分）。
   0 档（未练）刻意用**中性灰**而不是色阶的一端 —— "没练到"不是一个量级，
   是"没有数据"；给它颜色会被读成"练得很少但练了"。
   这一阶**不跟运动识别橙走**（见 tokens.css 的 --heat-* 注释）：
   动作用橙、练够与否用红/琥珀/绿，两者回答的是不同问题。
   填充透明度比旧版更高（64–84%）：旧版 46% 的浅橙叠在肤色上几乎与"基本够"
   分不开，正是这次要修的对比度问题。 */
.layer.h0 {
  fill: color-mix(in srgb, var(--heat-none) 34%, transparent);
}

.layer.h1 {
  fill: color-mix(in srgb, var(--heat-low) 72%, transparent);
}

.layer.h2 {
  fill: color-mix(in srgb, var(--heat-near) 74%, transparent);
}

.layer.h3 {
  fill: color-mix(in srgb, var(--heat-enough) 64%, transparent);
}

.layer.h4 {
  fill: color-mix(in srgb, var(--heat-full) 84%, transparent);
}

/* 深层已激活分区：在浅层之上半透明重描一遍，保证「标了就看得见」。
   它自己也落在某个 band 组里，所以这个 0.72 会与组的透明度**相乘**（后层叠画 = 0.40）——
   这是有意的：把它抬到浅层之上是为了"看得见"，而它仍然该读作"在后头"。
   两者要的是一件事的两面：可见 ≠ 与表层同样靠前。 */
.layer.overlay {
  opacity: 0.72;
}

figcaption {
  font-size: var(--fs-micro);
  letter-spacing: 2px;
  color: var(--text-3);
}

.legend {
  gap: var(--gap-lg);
  align-items: center;
}

.legend span {
  display: flex;
  align-items: center;
  gap: var(--gap-tight);
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.legend i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 0.5px solid var(--line-strong);
}

/* 激活图例：三档都是「运动身份」，走运动橙的单色阶。
   低档不能直接用 14% 的 soft（白底上几乎不可见），用与填充同源的混色。 */
.d1 {
  background: color-mix(in srgb, var(--c-exercise) 34%, var(--surface));
}

.d2 {
  background: color-mix(in srgb, var(--c-exercise) 62%, var(--surface));
}

.d3 {
  background: var(--c-exercise);
  border-color: transparent;
}

/* 热力图例的点：与图上 fill 同源，但不带 alpha —— 图例是 10px 小色块，
   按半透明画会糊在画布上，读不出色相。取值全部按非文本 3:1 挑过（见 --heat-*）：
   h2 琥珀与 h3 绿是跨色相的分界；h3/h4 同色相，靠明度分（中绿 / 深绿）。 */
.legend .hs0 {
  background: var(--heat-none);
}

.legend .hs1 {
  background: var(--heat-low);
}

.legend .hs2 {
  background: var(--heat-near);
}

.legend .hs3 {
  background: var(--heat-enough);
}

.legend .hs4 {
  background: var(--heat-full);
}

/* 热力图例：五档 + 开关挤一行会换行，允许折行并收紧间距 */
.heatlegend {
  /* 热力档位是一组无边界样本：8 */
  gap: var(--gap-sm);
  flex-wrap: wrap;
  justify-content: center;
}

.depthbtn {
  position: relative;
  font-size: var(--fs-micro);
  color: var(--text-2);
  padding: var(--sp-2) var(--sp-8);
  border: 0.5px solid var(--line-strong);
  border-radius: var(--radius-full);
  background: transparent;
}

/* 图例里的「仅浅层 / 含深层」是一颗开关胶囊：视觉 21 高不动，热区补到 44。
   它和色块同处一行，外扩只落在图例行的上下留白里。 */
.depthbtn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: calc(100% + 8px);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
}

/* 桌面壳：「仅浅层 / 含深层」实测 53×21 —— 差 1px，但它坐在一行图例色块的末尾，
   指针精度下 22 是下限。只把内边距上调一档（实测 21 → 25），胶囊样子不变。
   手机端维持原档（22 是指针精度的规则）。 */
.desk-main .depthbtn {
  padding: var(--sp-4) var(--sp-10);
}

.depthbtn[aria-pressed='true'] {
  color: var(--text-1);
  background: var(--surface-2);
}

/* 分层示意（InfoHint 插槽内容）：三个圆点的透明度就是图上三个 band */
.legendhint {
  margin-left: auto;
}

.lh-rows {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.lh-row {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.lh-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--c-exercise);
  flex: none;
}

.lh-name {
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.lh-desc {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.taphint {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* 激活肌群列表抽屉。热力模式不再有抽屉（明细与计算说明归调用方的
   TrainingScoreSheet），所以这里只剩激活模式要用的行样式。 */
.mrow {
  /* 肌群行是双行行（名称/数值 + 说明）：高度 64（--row-h-double） */
  min-height: var(--row-h-double);
  gap: var(--gap-md);
  padding: var(--sp-12) var(--sp-2);
  border-bottom: 0.5px solid var(--line);
  align-items: flex-start;
}

.mrow:last-child {
  border-bottom: none;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-top: var(--sp-4);
  flex: none;
}

.dot.l1 {
  background: color-mix(in srgb, var(--c-exercise) 34%, var(--surface));
}

.dot.l2 {
  background: color-mix(in srgb, var(--c-exercise) 62%, var(--surface));
}

.dot.l3 {
  background: var(--c-exercise);
}

.namerow {
  gap: var(--gap-sm);
  align-items: baseline;
}

.namerow b {
  font-size: var(--fs-callout);
  color: var(--text-1);
}

.tag {
  font-size: var(--fs-caption);
}

.desc {
  /* 名称与说明 2（主次文本上下） */
  margin-top: var(--gap-text);
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}
</style>
