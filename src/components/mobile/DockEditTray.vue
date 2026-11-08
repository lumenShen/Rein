<script setup lang="ts">
import { computed } from 'vue'
import { Plus } from 'lucide-vue-next'

import { useNavEdit } from '@/composables/useNavEdit'
import { useNavLayoutStore, TABBAR_MAX, type NavEntry } from '@/stores/navLayout'

/**
 * Dock 编辑托盘（mobile 区）：Dock 上方的一条，移动端唯一的候选面 —— 桌面「全部菜单」
 * 编辑面板的对应物。左列候选 chips（不在当前草稿里的已启用条目，「＋」加回草稿末尾，
 * 随后可在药丸上拖），右端「放弃变更 / 保存布局」两颗文字钮。
 *
 * **退出编辑态只有这两条路**（useNavEdit 不变量）：点 mask 不退出、Esc 只取消进行中的
 * 拖拽。保存 → navLayout.apply('tabbar', draft) 并退出；放弃 → 草稿从未落盘，丢弃即回滚。
 *
 * 数据自取（不接 props）：托盘与 TabBar 消费同一个编辑会话（useNavEdit('tabbar') 是
 * 模块级单例），渲染 v-if 自己管 —— 挂载即编辑态。
 *
 * 候选对着**草稿**算而不是直接用 navLayout.candidates()：后者按「已存布局」解析，而
 * 会话里的「−」还没落盘 —— 按 candidates() 取，刚摘除的条目不会出现在托盘里，加不回来。
 */
const navLayout = useNavLayoutStore()
const { draft, addToDraft, discard, save } = useNavEdit('tabbar')

/** 启用目录 = items ∪ candidates（前者含固定件与布局内条目、后者是布局外的剩余） */
const enabled = computed<NavEntry[]>(() => [
  ...navLayout.items('tabbar'),
  ...navLayout.candidates('tabbar'),
])

/** 托盘 chips：启用目录 − 当前草稿（「−」摘除的当场回到这里，「＋」加回的当场消失） */
const chips = computed<NavEntry[]>(() => {
  const inDraft = new Set(draft.value ?? [])
  return enabled.value.filter((it) => !inDraft.has(it.id))
})

/** 页签数上限（TABBAR_MAX=5，固定件计入）：满了就禁用加回并提示 —— 静默拒绝会让
    用户以为 chip 坏了。 */
const full = computed(() => (draft.value?.length ?? 0) >= TABBAR_MAX)

/** 加回：满员时提示而不落草稿 */
function addCapped(id: string): void {
  if (full.value) return
  addToDraft(id)
}
</script>

<template>
  <div class="dock-edit-tray" aria-label="编辑底部导航">
    <div class="tray-chips">
      <button
        v-for="c in chips"
        :key="c.id"
        type="button"
        class="tray-chip"
        :data-nav-id="c.id"
        :aria-label="full ? `底栏最多 ${TABBAR_MAX} 个，先移除一个再加回${c.label}` : `加回${c.label}`"
        :disabled="full"
        @click="addCapped(c.id)"
      >
        <span class="tray-badge" data-nav-badge="+" aria-hidden="true">
          <Plus :size="11" :stroke-width="2.6" />
        </span>
        <component :is="c.icon" :size="16" :stroke-width="1.9" />
        <span>{{ c.label }}</span>
      </button>
      <span v-if="chips.length === 0 && !full" class="tray-empty">从页签上移除的模块会出现在这里</span>
      <span v-else-if="full" class="tray-empty">底栏最多 {{ TABBAR_MAX }} 个：先摘掉一个页签，再来加回</span>
    </div>
    <div class="tray-actions">
      <button type="button" class="tray-btn" @click="discard()">放弃变更</button>
      <button type="button" class="tray-btn tray-save" @click="save()">保存布局</button>
    </div>
  </div>
</template>

<style scoped>
/* Dock 上方一条：Dock 底 = safe-bottom + dock-float，Dock 总高走 --dock-h
   （两行 Dock = 页签行 + 输入行；纯页签形态回落 tabbar-h）—— 再让一格 --gap-md。
   布局键要并上 --safe-bottom：手机手势带上 Dock 整体上浮，托盘跟着抬，不然压在 Dock 上。
   材质与 DockHintBubble 同族（实底 + 描边 + 卡片影）：编辑态的临时面不上 backdrop-filter，
   它是每帧合成的预算位（ARCHITECTURE §5 的折射名单纪律）。 */
.dock-edit-tray {
  position: fixed;
  left: var(--safe-left);
  right: var(--safe-right);
  bottom: calc(var(--safe-bottom) + var(--dock-float) + var(--dock-h) + var(--gap-md));
  /* Dock(60) 之上、Toast(120) 之下：编辑托盘是 Dock 的随行面，不与菜单 / 提示抢层级 */
  z-index: 61;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gap-sm) var(--gap-md);
  padding: var(--gap-sm) var(--gap-md);
  border-radius: var(--radius-full);
  border: 0.5px solid var(--line);
  background: var(--surface);
  color: var(--text-2);
  box-shadow: var(--shadow-card);
}

.tray-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gap-sm);
  flex: 1 1 auto;
  min-width: 0;
}

.tray-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--gap-tight);
  padding: var(--sp-6) var(--sp-10);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  cursor: pointer;
}

/* 「＋」徽标：与药丸页签的「−」同一枚圆、同一份规格，颜色反着来 ——
   加回是「动作可用」（accent），移除是「破坏性」（danger，见 TabBar 的 .dock-badge） */
.tray-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.tray-empty {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.tray-actions {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  flex: none;
}

.tray-btn {
  padding: var(--sp-6) var(--sp-12);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

/* 保存用 --accent 实底：编辑态里唯一的「完成」动作，前景白走 --on-accent（语义色实底
   的通用前景，与全站主按钮同一条规则） */
.tray-save {
  background: var(--accent);
  color: var(--on-accent);
}
</style>
