/** 记账域：月窗口流水 + 月度总预算 + 聚合计算（本月/趋势/分类占比）。 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { ledgerService } from '@/services/ledgerService'
import { addMonths, endOfMonth, monthKey, startOfMonth, todayStr } from '@/utils/date'
import type { LedgerEntry, LedgerEntryInput, LedgerSettings } from '@/types'

export interface MonthTrend {
  key: string
  label: string
  expenseCents: number
  incomeCents: number
}

export const useLedgerStore = defineStore('ledger', () => {
  /** 当前查看月份 YYYY-MM */
  const month = ref(monthKey(todayStr()))
  /** 近 6 个月窗口流水（含当前月），按日期倒序 */
  const entries = ref<LedgerEntry[]>([])
  const settings = ref<LedgerSettings | null>(null)
  const loading = ref(true)
  const error = ref('')
  /** 已加载的窗口范围，避免重复请求 */
  let loadedWindow: [string, string] | null = null
  let monthSeq = 0
  let mutationTail: Promise<void> = Promise.resolve()

  const winStart = computed(() => startOfMonth(addMonths(`${month.value}-01`, -5)))
  const winEnd = computed(() => endOfMonth(`${month.value}-01`))

  async function loadMonth(m?: string): Promise<void> {
    if (m) month.value = m
    const start = winStart.value
    const end = winEnd.value
    const seq = ++monthSeq
    if (!error.value && loadedWindow && loadedWindow[0] === start && loadedWindow[1] === end) return
    loading.value = true
    error.value = ''
    try {
      const list = await ledgerService.listLedgerEntries(start, end)
      if (seq !== monthSeq) return
      entries.value = list
      loadedWindow = [start, end]
    } catch (e) {
      if (seq === monthSeq) error.value = e instanceof Error ? e.message : '流水读取失败'
    } finally {
      if (seq === monthSeq) loading.value = false
    }
  }

  async function loadBudget(): Promise<void> {
    settings.value = await ledgerService.getLedgerBudget()
  }

  /** 写操作后刷新窗口；序号保证旧月份/旧请求不会覆盖当前结果。 */
  async function refresh(): Promise<void> {
    const start = winStart.value
    const end = winEnd.value
    const seq = ++monthSeq
    loading.value = true
    error.value = ''
    try {
      const list = await ledgerService.listLedgerEntries(start, end)
      if (seq !== monthSeq) return
      entries.value = list
      loadedWindow = [start, end]
    } catch (e) {
      if (seq === monthSeq) error.value = e instanceof Error ? e.message : '流水刷新失败'
      throw e
    } finally {
      if (seq === monthSeq) loading.value = false
    }
  }

  /** 写操作按用户发起顺序串行，避免慢请求回写覆盖新操作。 */
  function enqueueMutation(action: () => Promise<unknown>): Promise<void> {
    const run = mutationTail.then(async () => {
      await action()
      try {
        await refresh()
      } catch {
        // 写入已成功；列表刷新失败由页面错误条承载，不能把表单弹回去诱发重复记账。
      }
    })
    mutationTail = run.catch(() => undefined)
    return run
  }

  async function create(input: LedgerEntryInput): Promise<void> {
    await enqueueMutation(() => ledgerService.createLedgerEntry(input))
  }

  async function update(entry: LedgerEntry): Promise<void> {
    await enqueueMutation(() => ledgerService.updateLedgerEntry(entry))
  }

  async function remove(id: number): Promise<void> {
    await enqueueMutation(() => ledgerService.deleteLedgerEntry(id))
  }

  async function setBudget(monthlyBudgetCents: number): Promise<void> {
    settings.value = await ledgerService.setLedgerBudget(monthlyBudgetCents)
  }

  /* ---- 聚合 ---- */

  const monthEntries = computed(() =>
    entries.value.filter((e) => monthKey(e.date) === month.value),
  )

  const monthExpenseCents = computed(() =>
    monthEntries.value.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0),
  )

  const monthIncomeCents = computed(() =>
    monthEntries.value.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amountCents, 0),
  )

  /** 本月支出分类占比（按金额降序） */
  const expenseByCategory = computed(() => {
    const map = new Map<string, number>()
    for (const e of monthEntries.value) {
      if (e.kind !== 'expense') continue
      map.set(e.category, (map.get(e.category) ?? 0) + e.amountCents)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  })

  /** 近 6 个月收支趋势（含当前月） */
  const trend = computed<MonthTrend[]>(() => {
    const out: MonthTrend[] = []
    for (let i = 5; i >= 0; i--) {
      const m = monthKey(addMonths(`${month.value}-01`, -i))
      let expense = 0
      let income = 0
      for (const e of entries.value) {
        if (monthKey(e.date) !== m) continue
        if (e.kind === 'expense') expense += e.amountCents
        else income += e.amountCents
      }
      out.push({
        key: m,
        label: `${Number(m.slice(5))}月`,
        expenseCents: expense,
        incomeCents: income,
      })
    }
    return out
  })

  return {
    month,
    entries,
    settings,
    loading,
    error,
    monthEntries,
    monthExpenseCents,
    monthIncomeCents,
    expenseByCategory,
    trend,
    loadMonth,
    loadBudget,
    create,
    update,
    remove,
    setBudget,
  }
})
