<script setup lang="ts">
/**
 * 导航编辑态遮罩（z 45，--scrim-edit）：三个导航容器（移动 Dock / 桌面左栏 / 桌面顶栏）
 * 共用一枚，由 App.vue 常驻挂载、v-if 控制显隐（进出淡入淡出在 App.vue 的挂载点上）。
 *
 * 盖谁不盖谁由 z-index + inert 表达，遮罩自己不做任何判定：
 * 左栏(50)/Dock(60) 浮在它之上、只有自己是 activeScope 时才可交互；标题栏由 App.vue
 * 在编辑态提权（nav-edit-live，z 46）—— 窗控三钮恒可点；其余浮层与被遮主内容根由
 * App.vue 挂 inert（连焦点一起封，mask 只挡指针不挡焦点）。
 *
 * 不变量（useNavEdit 同款措辞）：吞点击但**永不据此退出** —— 退出编辑态只有
 * 「放弃变更 / 保存布局」两条路，点遮罩不是第三条。
 */
</script>

<template>
  <div class="nav-edit-mask" aria-hidden="true" @pointerdown.prevent @click.prevent @contextmenu.prevent />
</template>

<style scoped>
.nav-edit-mask {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: var(--scrim-edit);
  /* 不加 backdrop-filter：它是每帧合成的预算位，编辑态不占（ARCHITECTURE §5 的折射名单）；
     淡入淡出交给挂载点的 Transition（App.vue），这里只管那一层底色 */
}
</style>
