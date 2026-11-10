<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ExternalAccessSection from '@/components/settings/ExternalAccessSection.vue'

/**
 * 外部访问（`/settings/apps/external`）。
 *
 * 四级页：页头 + 一张「本机网关」说明卡 + 网关分区本体。说明卡只回答「这是什么、授权
 * 有哪四态」；开关 / 端口 / 配对令牌 / 已授权程序 / 审计记录全部由
 * `ExternalAccessSection` 承担（授权弹窗不在这里复制一份）。
 *
 * 组件自带卡头，页头已经有一个「外部访问」标题，所以传 `:show-header="false"`
 * 把它内部那行标题收掉；`settings-external-access` 与 `gateway-*` 的 testid / 状态机
 * 一律不动。
 *
 * 四态与 `system/externalAccessRuntime.ts`、`GatewayAuthSheet.vue` 的裁决按钮一致：
 * 允许本次会话 / 始终允许 / 忽略 / 拒绝。
 */
</script>

<template>
  <div class="page" data-testid="external-access-page">
    <PageHeader title="外部访问" subtitle="对外服务网关 · 授权与审计" back />

    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>
      <section class="card intro">
        <h2 class="gtitle">本机网关</h2>
        <p class="lead">
          外部访问让本机的其它程序通过网关读写 Rein 的数据。默认关闭，不监听任何端口；
          每个程序第一次连上来都要你当面批准。
        </p>
        <div class="states">
          <StatusChip tone="accent" size="md">允许本次会话</StatusChip>
          <StatusChip tone="ok" size="md">始终允许</StatusChip>
          <StatusChip tone="neutral" size="md">忽略</StatusChip>
          <StatusChip tone="danger" size="md">拒绝</StatusChip>
        </div>
      </section>

      <!-- 网关分区：开关 / 绑定模式 / 端口 / 配对令牌 / 授权名单 / 审计记录。
           它自己已经是 .card，页面不再包一层；卡头由 showHeader=false 收掉。 -->
      <ExternalAccessSection :show-header="false" />

      <p class="foot">
        只有桌面端支持绑定端口与局域网访问；Android 上这个页面只做说明。
      </p>
    </div>
  </div>
</template>

<style scoped>
/* 四级页骨架：与设置页 / 连接应用同一份页边距 */
.page {
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

/* 卡内标题与设置页同一档（18 Medium / Subtitle_L） */
.gtitle {
  font-size: var(--fs-title3);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.lead {
  margin-top: var(--gap-sm);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  line-height: var(--lh-body);
}

/* 四态各给一枚语义胶囊：允许走主色 / 绿，拒绝走红，忽略保持中性 */
.states {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

/* 页底说明：桌面能力边界，不抢上面的授权与审计内容 */
.foot {
  margin-top: var(--gap-md);
  color: var(--text-3);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  text-align: center;
}
</style>
