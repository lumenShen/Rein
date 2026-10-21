<script setup lang="ts">
import { computed } from 'vue'

import PageHeader from '@/components/layout/PageHeader.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { toggleablePlugins, type PluginSpec } from '@/plugins'
import { useFeaturesStore } from '@/stores/features'

/**
 * 打开或关闭功能（三级页）：`src/plugins` 里声明了 `toggleable` 的功能模块逐项开关。
 * 这里只做开关本身——入口显隐、路由拦截、数据加载跳过全部由插件层统一生效。
 *
 * 子模块（`parent` 非空，如「课表 › 抢课」）缩进挂在父模块下面：它继承父模块的可用性，
 * 父模块关掉时开关置灰并写明原因，而不是让人打开一个开了也没用的开关。
 */
const features = useFeaturesStore()

/** 开关清单来自注册表，不是写死的数组：新增模块 = 加一个插件声明 */
const rows = computed(() => {
  const all: PluginSpec[] = toggleablePlugins()
  return all
    .filter((p) => !p.parent)
    .map((p) => ({ plugin: p, children: all.filter((c) => c.parent === p.id) }))
})

/** 图标章配色：同色相淡彩底 + 深档前景，与主页工具格同一套约定 */
function iconStyle(p: PluginSpec): Record<string, string> {
  return {
    background: `color-mix(in srgb, var(${p.accent}) 12%, transparent)`,
    color: `var(${p.accent})`,
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="打开或关闭功能" back>
      <!-- 关闭功能的影响（原先平铺在卡面下方的三段说明）收进页头帮助入口 -->
      <template #action>
        <span class="hdr-btn">
          <InfoHint
            title="关闭功能的影响"
            content="关闭后入口与页面一起隐藏，已有数据原样保留，随时可以再打开。"
          />
        </span>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- d-full：开关清单这张卡通栏（壳层默认把 .page 的直接子级 .card 压成半栏） -->
    <section class="card d-full plist">
      <template v-for="row in rows" :key="row.plugin.id">
        <div class="prow row" :class="{ off: !features.isEnabled(row.plugin.id) }">
          <i class="pic" :style="iconStyle(row.plugin)">
            <component :is="row.plugin.icon" :size="18" />
          </i>
          <span class="col ptxt">
            <b>{{ row.plugin.name }}</b>
            <em class="t-2">{{ row.plugin.desc }}</em>
          </span>
          <ToggleSwitch
            :model-value="features.isEnabled(row.plugin.id)"
            :label="`${row.plugin.name} 开关`"
            @update:model-value="features.setEnabled(row.plugin.id, $event)"
          />
        </div>

        <!-- 子模块：缩进一格 + 左侧一条引导线，看着就是「属于上面那个模块」 -->
        <div
          v-for="child in row.children"
          :key="child.id"
          class="prow sub row"
          :class="{ off: !features.isEnabled(child.id) }"
        >
          <i class="pic sm" :style="iconStyle(child)">
            <component :is="child.icon" :size="15" />
          </i>
          <span class="col ptxt">
            <!-- 「子模块」标记放在 <b> **外面**：它是装饰，不该混进这一行的名字里
                 （e2e 与无障碍都按 b 的文本认行） -->
            <span class="namerow">
              <b>{{ child.name }}</b>
              <i class="tag">子模块</i>
            </span>
            <em class="t-2">{{ child.desc }}</em>
            <!-- 「为什么按不动」从描述里剥出来单独成态：父模块关闭时子模块跟着不可用。
                 文案与 docs/ARCHITECTURE.md §13 的写法一致（「父模块关闭时不可用」）——
                 只说「课表已关闭」看不出子模块为什么跟着不能开 -->
            <StatusChip v-if="!features.isEnabled(row.plugin.id)" tone="warn">
              {{ row.plugin.name }}关闭时不可用
            </StatusChip>
          </span>
          <ToggleSwitch
            :model-value="features.isEnabled(child.id)"
            :label="`${child.name} 开关`"
            :disabled="!features.isEnabled(row.plugin.id)"
            @update:model-value="features.setEnabled(child.id, $event)"
          />
        </div>
      </template>
    </section>

    <!-- 页尾说明：一行结论胶囊 + 「子模块默认关闭」的状态交代（完整解释在页头帮助入口） -->
    <div class="note">
      <PillChip tone="muted">关闭只隐藏入口，数据保留</PillChip>
      <p class="t-3">子模块默认关闭，开启后它才真正开始工作（含后台任务）。</p>
    </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶部走 --page-pad-top（手机 12 / 桌面 40）：状态栏那段已由 --safe-top 让开，
     这里只剩页头与内容之间那一档呼吸 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 清单卡的内距走卡片档 16，上下收到 4：行的呼吸已经由行高给足，
   再多一层内距会把首行推得离卡头太远 */
.plist {
  padding: var(--sp-4) var(--pad-card);
}

/* 开关行：双行列表档 64。36 的图标章 + 16 的模块名 + 12 的说明叠起来约 44，
   48 会让上下两行贴到发丝线上，64 才是「一行装得下两行字」的那档。
   行间边界交给 1px 分隔线（--line），不再靠内距撑。 */
.prow {
  gap: var(--gap-md);
  padding: 0;
  min-height: var(--row-h-double);
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.prow + .prow {
  border-top: 0.5px solid var(--line);
}

/* 子模块：缩进 + 引导线。行内分隔线改挂到引导线上，避免两条线并排 */
/* 子模块缩进一格：与父行「图标 36 + 间距 12」的文本起点对齐，读数才读得出从属 */
.prow.sub {
  margin-left: var(--sp-16);
  padding-left: var(--sp-16);
  border-top: 0;
  position: relative;
}

.prow.sub::before {
  content: '';
  position: absolute;
  left: 0;
  top: -1px;
  bottom: 0;
  width: 1px;
  background: var(--line);
}

/* 关闭态：图标章降到禁用浓度，模块名降一档字色；描述保持 --text-3 不再二次压暗
   （12px 的 --text-3 再乘裸透明度实测约 1.8:1，会看不清自己关掉的是哪个模块） */
.prow.off .pic {
  opacity: var(--disabled-opacity);
}

.prow.off .ptxt b {
  color: var(--text-2);
}

.pic {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
}

.pic.sm {
  width: 28px;
  height: 28px;
}

.ptxt {
  flex: 1;
  min-width: 0;
  gap: var(--gap-text);
}

.ptxt b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

/* 状态胶囊只占内容宽：.col 默认 stretch 会把软底撑满整列 */
.ptxt .schip {
  align-self: flex-start;
}

.namerow {
  display: flex;
  align-items: center;
  gap: var(--gap-text-inline);
}

.ptxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

/* 「子模块」标记：中性底 + 次级文字色，不用强调色抢注意力 */
/* 「子模块」标记：行内小胶囊，不占 24 的角标高（它跟模块名同一基线），
   左右 8 是「标签贴文字」那一档，上下 2 把胶囊压在行高内 */
.tag {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  color: var(--text-2);
  background: var(--surface-2);
}

.note {
  margin: var(--gap-lg) var(--sp-4) 0;
}

.note p {
  margin-top: var(--gap-sm);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   开关清单只有寥寥几行，却被壳层压成半栏、右半屏空着。这张卡应当通栏 ——
   它是一份「模块清单」，每行的开关都贴在卡右缘，读起来是一张表，摊成两栏反而会把
   子模块（抢课）从它的父模块（课表）身边拆走（栅格逐行填充，父子会被分到不同栏）。

   通栏由模板上的 .d-full 声明。 */
</style>
