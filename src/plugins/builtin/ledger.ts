import { PiggyBank, Wallet } from 'lucide-vue-next'

import { definePlugin } from '../registry'
import { fmtCents } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'

/**
 * 记账模块：流水、预算与月度结余（可开关，见「打开或关闭功能」）。
 *
 * 关闭后 `/ledger` 被守卫拦回主页、导航轨条目与工具卡消失、AI 的「记账」工具组
 * 也不再装载（`ai/tools/registry.ts` 的 `ledger` 组声明了 `plugin: 'ledger'`）——
 * 账本数据本身一条不动。
 */
export const ledgerPlugin = definePlugin({
  id: 'ledger',
  name: '记账',
  desc: '流水、预算与月度结余',
  icon: Wallet,
  accent: '--mod-ledger',
  toggleable: true,
  defaultEnabled: true,
  routes: ['ledger'],
  nav: [{ route: 'ledger', label: '记账', icon: PiggyBank, surfaces: ['rail'], order: 160 }],
  tools: [
    {
      id: 'ledger.open',
      title: '记账',
      sub: () => `本月支出 ¥${fmtCents(useLedgerStore().monthExpenseCents)}`,
      icon: Wallet,
      ic: {
        background: 'var(--mod-ledger-soft)',
        color: 'var(--mod-ledger-strong)',
      },
      order: 70,
      to: { name: 'ledger' },
    },
  ],
})
