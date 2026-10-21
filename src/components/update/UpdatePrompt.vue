<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, Download, Sparkles, X } from 'lucide-vue-next'

import { useToast } from '@/composables/useToast'
import MdText from '@/components/common/MdText.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { useUpdateStore } from '@/stores/update'
import { notesAboveCurrent } from '@/utils/updateNotes'

/**
 * 启动更新提示：检查到新版本时弹一张明确的卡片（而不是一闪而过的 toast）。
 *
 * 三个动作对应三种意图：
 *   - 立即更新：开始下载并跳到更新页看进度（下载在后台线程，切页不中断）
 *   - 稍后：本次启动不再打扰（下次启动会再提示，除非跳过）
 *   - 跳过此版本：写 ignoredVersion，之后的静默检查不再提示这个版本
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const update = useUpdateStore()
const { toast } = useToast()

const starting = ref(false)

const version = computed(() => update.check?.latestVersion ?? '')
/** 本机版本：清单里的 currentVersion 优先（与本段说明同一次检查取到的），回落 store 快照 */
const currentVersion = computed(() => update.check?.currentVersion || update.currentVersion)
/** 说明已由发布侧裁成本版一节；这里再过滤一次是给老清单 / 自定义源兜底（见 utils/updateNotes） */
const notes = computed(() => notesAboveCurrent(update.check?.notes, currentVersion.value))
const sizeText = computed(() => {
  const n = update.check?.sizeBytes
  if (!n) return ''
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
})
const mandatory = computed(() => Boolean(update.check?.mandatory))
const unsupported = computed(() => update.snapshot?.installSupported === false)

function close(): void {
  emit('close')
}

/** 当前平台不支持应用内安装：去更新页复制链接手动装。 */
function openPage(): void {
  close()
  void router.push({ name: 'settings-update' })
}

/** 立即更新：后台开始下载 + 跳更新页看进度。下载失败留给更新页的进度卡报错。 */
async function installNow(): Promise<void> {
  if (starting.value) return
  starting.value = true
  try {
    const ok = await update.startDownload()
    close()
    await router.push({ name: 'settings-update' })
    if (!ok) toast(update.error ?? '下载启动失败')
  } finally {
    starting.value = false
  }
}

async function skip(): Promise<void> {
  if (version.value) await update.save({ ignoredVersion: version.value })
  toast(`已跳过 v${version.value}`)
  close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="upfade">
      <div v-if="props.open" class="up-backdrop" @click="close" />
    </Transition>
    <Transition name="upcard">
      <section
        v-if="props.open"
        class="up-card"
        role="dialog"
        aria-modal="true"
        :aria-label="`发现新版本 ${version}`"
      >
        <header class="up-head">
          <Sparkles :size="18" />
          <h2>发现新版本 v{{ version }}</h2>
          <button class="up-x" aria-label="关闭" @click="close">
            <X :size="15" :stroke-width="2.5" />
          </button>
        </header>

        <!-- 决定性结论单独成一颗胶囊：体积与来源退回纯元数据行，两者不再共用一行同一档灰字 -->
        <StatusChip v-if="mandatory" class="up-must" tone="danger" size="sm">此版本必须更新</StatusChip>

        <p class="up-meta">
          <span v-if="sizeText" class="num">{{ sizeText }}</span>
          <template v-if="update.check?.sourceName">
            <span class="up-dot" aria-hidden="true">·</span> 来自 {{ update.check.sourceName }}
          </template>
        </p>

        <!-- 说明是 Markdown（`- ` 条目 / `**强调**` / 行内 `code`）：从前用 {{ }} 插值，
             于是用户看到的是原样的星号与井号。MdText 是 AI 气泡那份零依赖渲染器，
             先转义再按白名单替换，外部文本进来也安全 -->
        <MdText v-if="notes" class="up-notes" data-rubber-self :text="notes" />

        <p v-if="unsupported" class="up-warn">
          <AlertTriangle :size="14" /> {{ update.snapshot?.installHint }}
        </p>

        <div class="up-actions">
          <button v-if="!unsupported" class="up-btn primary" :disabled="starting" @click="installNow">
            <Download :size="15" /> {{ starting ? '正在开始…' : '立即更新' }}
          </button>
          <button v-else class="up-btn primary" @click="openPage">去更新页</button>
          <button class="up-btn" @click="close">稍后</button>
          <button class="up-skip" @click="skip">跳过此版本</button>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.up-backdrop {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.up-card {
  position: fixed;
  z-index: 120;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  /* 弹窗最大宽 400（HarmonyOS 弹出框规格）；两侧各让 20 = 合计 --sp-40，
     不再写裸 40px —— 窄屏时这条是唯一的呼吸来源 */
  width: min(400px, calc(100vw - var(--sp-40)));
  max-height: min(70dvh, 560px);
  display: flex;
  flex-direction: column;
  /* 弹窗内距 16（四边）：此前横向借用 --page-pad-x，桌面档会被顶成 40，
     一张 400 宽的弹窗只剩 320 的内容宽；纵向 16/14 也是两个裸值，一并归到令牌。
     底部不再叠加 --safe-bottom：这张卡在视口里居中（max-height 70dvh），
     离底边始终有余量，留出安全区只会把内容整体推高、四边也不再对称 */
  padding: var(--sp-16);
  /* 居中对话框与底部抽屉同层：统一 --radius-xl（此前是 --radius-l，22） */
  border-radius: var(--radius-xl);
  background: var(--surface);
  box-shadow: var(--shadow-float);
}

.up-head {
  display: flex;
  align-items: center;
  gap: var(--sp-8);
  color: var(--accent);
}

.up-head h2 {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  font-size: var(--fs-headline);
  font-weight: var(--fw-bold);
}

.up-x {
  position: relative;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

/* 视觉 28px 不变，热区撑到 44×44：关闭是这张模态卡唯一的「不选就走」出口 */
.up-x::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--hit-min);
  height: var(--hit-min);
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

.up-meta {
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 底色与字色由 StatusChip 的 danger 档成对提供（--danger-soft 底 + --danger-strong 字），
   这里只管落点：不拉满整行、与页头留一档间距 */
.up-must {
  align-self: flex-start;
  margin-top: var(--sp-8);
}

/* 卡内的二级块：圆角比母卡收一档（16 → 12），行高走正文档 */
.up-notes {
  margin-top: var(--gap-md);
  padding: var(--sp-12);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
  color: var(--text-2);
  /* 不再 pre-wrap：说明现在由 MdText 渲成块级元素（p / ul / li），
     留 pre-wrap 只会把块之间的换行再撑一份行高 */
  overflow-y: auto;
  max-height: 36dvh;
}

/* 条目自带左内边距会在这块窄提示里显得很凹，收紧一档 */
.up-notes :deep(ul) {
  padding-left: var(--sp-16);
}

/* soft 底上的文字走 --danger-strong（tokens.css 规定实底档不当文字用） */
.up-warn {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--danger-strong);
}

/* 三颗动作的排布按 HarmonyOS 弹出框规范：数量 ≥3 时由左右排改为上下排，
   顺序由「左→右」映射成「下→上」。DOM 里仍是主操作在前（读屏 / Tab 顺序不变），
   视觉用 column-reverse 把主操作翻到最底 —— 拇指区最近的一格是「立即更新」，
   「跳过此版本」这颗最轻的落在最上，误触也不会误跳过。 */
.up-actions {
  display: flex;
  flex-direction: column-reverse;
  align-items: stretch;
  /* 3 个以上按钮上下排列时，按钮上下间隔 12（HarmonyOS 弹出框 / 按钮规范）；
     此前 8 是「无边界控件」那一档，而这三颗都带整块底板 */
  gap: var(--gap-md);
  margin-top: var(--gap-lg);
}

.up-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--hit-min);
  padding: 0 var(--sp-16);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.up-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

/* 禁用浓度全站同一档（tokens.css），不再各写各的裸值 */
.up-btn:disabled {
  opacity: var(--disabled-opacity);
}

/* 「跳过此版本」是这一组里最轻的一颗，但也得先读得清才点得中（--text-3 只有 3.6:1）。
   它同样吃满 44 的命中高度：此前实测只有 60×16，手机上几乎点不到。 */
.up-skip {
  align-self: stretch;
  /* 视觉仍是纯文字链，但按压给一块整行浅底：它和上面两颗有底板的按钮不同，
     只靠全局 scale(.96) 在这张窄卡里几乎看不出来 */
  border-radius: var(--radius-l);
  min-height: var(--hit-min);
  padding: 0 var(--sp-12);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.up-skip:active {
  background: var(--surface-2);
}

.upfade-enter-active,
.upfade-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.upfade-enter-from,
.upfade-leave-to {
  opacity: 0;
}

.upcard-enter-active,
.upcard-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.upcard-enter-from,
.upcard-leave-to {
  opacity: 0;
  transform: translate(-50%, calc(-50% + 14px));
}
</style>
