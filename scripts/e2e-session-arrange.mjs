/**
 * 训练会话「现场编排」运行时实测（浏览器 + mock 后端）。
 *
 * 为什么单独一条：这一批改动有三处**只有跑起来才验得到**的口径问题 ——
 *  1. 换动作之后，智能重量 / 组数建议是不是真的跟着新动作重算（还是停在旧动作的处方上）；
 *  2. 插入 / 删除 / 改处方是不是真的只动这一场（课程库不动）、且进度游标不被打乱；
 *  3. 会话结构有没有真的进快照（`state_json.sessionPlan`）—— 否则中断恢复 / 外部回灌
 *     会把插入的动作抹掉、把删掉的动作请回来。
 *
 * 覆盖：
 *  A. 换动作：处方换成新动作的库内默认值、旧热身组被清掉、建议与预填重量按新动作重算
 *  B. 插入：追加到末尾、处方可用、位置非法被拒
 *  C. 改处方：组数 / 次数 / 休息；非法值被拒
 *  D. 删除：当前动作不能删、未做的可删
 *  E. 快照：state.sessionPlan 与本地一致，回灌能复原整份结构
 *  F. 无会话：所有编排动作只返回 {updated:false} 不抛错
 *
 * 运行：node scripts/e2e-session-arrange.mjs
 *   （前置：另起一个**非 Tauri** 的 vite —— `npx vite --port 5173 --strictPort`）
 *   ⚠️ 本机 1420 / 1430 落在 Windows 保留端口段（WSL/Hyper-V 占位），listen 直接 EACCES，
 *      所以用 REIN_E2E_URL 指到别的端口。
 */

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:5173'
const OUT = 'docs/shots'
const PLAN = 'ppl-push'
let pass = 0
let fail = 0

function ok(cond, msg, detail = '') {
  if (cond) {
    pass++
    console.log('  ✓ ' + msg + (detail ? ` — ${detail}` : ''))
  } else {
    fail++
    console.log('  ✗ ' + msg + (detail ? ` — ${detail}` : ''))
  }
}

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('    [pageerror] ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('    [console.error] ' + m.text())
})

const wait = (ms) => page.waitForTimeout(ms)
const store = (fn, arg) => page.evaluate(fn, arg)

async function ensureToolHook() {
  await page.evaluate(async () => {
    if (typeof window.__REIN_TOOL__ !== 'function') {
      await import('/src/ai/tools/registry.ts')
    }
  })
}

const callTool = (name, args) =>
  page.evaluate(([n, a]) => window.__REIN_TOOL__(n, a), [name, args ?? {}])

await page.goto(`${BASE}/#/sports/plans/${PLAN}`, { waitUntil: 'networkidle' })
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('rein.mock.')) localStorage.removeItem(k)
  }
})
await page.reload({ waitUntil: 'networkidle' })
await wait(2200)
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})

console.log('\n[S] 开课')
await page.locator('button.start', { hasText: '开始' }).first().click()
await page.waitForSelector('.pane .eyebrow', { timeout: 15000 })
await wait(800)
const skipReadiness = page.getByText('跳过（按默认值算）', { exact: false })
if ((await skipReadiness.count()) > 0) {
  await skipReadiness.first().click()
  await wait(600)
}
// 跳过热身，让当前动作处于「正在做组、一组未做」的可换状态
await ensureToolHook()
await callTool('update_active_session', { action: 'skip_warmup' })
await wait(700)
// 跳过热身进入正式组后，今日状态对话框才会弹（它的触发条件就是「做组中 + 还没自评」）；
// 不关掉它会盖住后面要点的抽屉与面板。
const rdSkip = page.locator('.rd-btn', { hasText: '跳过' })
if ((await rdSkip.count()) > 0) {
  await rdSkip.first().click()
  await wait(500)
}
ok((await page.locator('.rd-backdrop').count()) === 0, '今日状态对话框已关闭（不挡住后续操作）')

console.log('\n[A] 换动作：处方与建议跟着新动作走')
const pick = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const { useExerciseLibStore } = await import('/src/stores/exerciseLib.ts')
  const s = useSessionStore()
  const lib = useExerciseLibStore()
  await lib.ensureLoaded()
  const cur = s.currentEx
  // 选一个「库内有默认重量与默认次数」的力量动作，才验得出处方是否真的换了
  const t = lib.list.find(
    (e) =>
      e.kind === 'strength' &&
      !e.hidden &&
      e.id !== cur.exerciseId &&
      e.defaultWeightKg != null &&
      e.defaultReps != null,
  )
  return {
    idx: s.exIndex + 1,
    count: s.plan.exercises.length,
    old: {
      name: cur.name,
      sets: cur.sets,
      reps: cur.reps,
      warmups: (cur.warmups ?? []).length,
    },
    target: t
      ? { id: t.id, name: t.name, sets: t.defaultSets, reps: t.defaultReps, weight: t.defaultWeightKg }
      : null,
  }
})
ok(!!pick.target, '动作库里找到可替换的同类型动作', pick.target?.name)

const swapRes = await callTool('edit_session_plan', {
  action: 'swap_exercise',
  exerciseIndex: pick.idx,
  exerciseId: pick.target.id,
})
await wait(1400) // 等 loadAdvice / mergeLastWeights 落地
const swapped = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  const ex = s.currentEx
  const a = s.adviceFor(ex)
  return {
    name: ex.name,
    exerciseId: ex.exerciseId,
    sets: ex.sets,
    reps: ex.reps,
    warmups: (ex.warmups ?? []).length,
    working: s.workingWeightFor(ex),
    advised: a?.suggestedWeight ?? null,
    suggestedSets: a?.suggestedSets ?? null,
    suggestedReps: a?.suggestedReps ?? null,
    hasAdvice: !!a,
    prefill: s.weight,
    count: s.plan.exercises.length,
    phase: s.phase,
  }
})
ok(swapRes?.updated === true, 'swap_exercise 生效', swapRes?.message)
ok(swapped.exerciseId === pick.target.id, '当前动作已换成目标动作', swapped.name)
ok(swapped.count === pick.count, '这一场的动作数不变（只换本体，不打乱进度）', `${swapped.count}`)
ok(
  swapped.sets === pick.target.sets && swapped.reps === pick.target.reps,
  '组数 / 次数换成新动作的库内处方（不再沿用旧动作）',
  `${swapped.sets}×${swapped.reps} vs 库内 ${pick.target.sets}×${pick.target.reps}`,
)
ok(swapped.warmups === 0, '旧动作的热身组被清掉（不会再套到新动作上）', `${swapped.warmups} 组`)
ok(swapped.hasAdvice, '新动作有今日建议（建议表已按新动作重算）')
ok(
  swapped.suggestedSets === swapped.sets && swapped.suggestedReps === swapped.reps,
  '建议里的组数 / 次数与这一场的处方同源（不是旧动作那份）',
  `${swapped.suggestedSets}×${swapped.suggestedReps}`,
)
ok(swapped.working > 0, '工作重量可读', `${swapped.working}kg`)
ok(
  swapped.advised == null || swapped.prefill === swapped.advised || swapped.prefill === swapped.working,
  '预填重量对齐到建议 / 工作重量',
  `prefill=${swapped.prefill} advised=${swapped.advised}`,
)
ok(swapped.phase === 'exercise', '换动作后相位仍是做组（不会卡在热身）', swapped.phase)

console.log('\n[B] 插入动作')
const insPick = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const { useExerciseLibStore } = await import('/src/stores/exerciseLib.ts')
  const s = useSessionStore()
  const lib = useExerciseLibStore()
  const cur = s.currentEx
  const t = lib.list.find(
    (e) =>
      e.kind === 'strength' &&
      !e.hidden &&
      e.id !== cur.exerciseId &&
      e.defaultWeightKg != null &&
      e.defaultReps != null,
  )
  return { t: t ? { id: t.id, name: t.name } : null, count: s.plan.exercises.length }
})

const insRes = await callTool('edit_session_plan', {
  action: 'insert_exercise',
  exerciseId: insPick.t.id,
  sets: 4,
  reps: 12,
})
await wait(1200)
const afterIns = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  const last = s.plan.exercises[s.plan.exercises.length - 1]
  const a = s.adviceFor(last)
  return {
    count: s.plan.exercises.length,
    last: { name: last.name, sets: last.sets, reps: last.reps, kind: last.kind },
    hasAdvice: !!a,
    advised: a?.suggestedWeight ?? null,
    working: s.workingWeightFor(last),
    exIndex: s.exIndex + 1,
  }
})
ok(insRes?.updated === true, 'insert_exercise 生效', insRes?.message)
ok(afterIns.count === insPick.count + 1, '动作数 +1', `${insPick.count} → ${afterIns.count}`)
ok(afterIns.last.name === insPick.t.name, '新动作追加到末尾', afterIns.last.name)
ok(
  afterIns.last.sets === 4 && afterIns.last.reps === 12,
  '插入时指定的组数 / 次数生效',
  `${afterIns.last.sets}×${afterIns.last.reps}`,
)
ok(afterIns.hasAdvice && afterIns.working > 0, '插入的动作也有建议与工作重量', `${afterIns.advised}kg`)
ok(afterIns.exIndex === pick.idx, '当前动作没有被插入打乱', `第 ${afterIns.exIndex} 个`)

const badPos = await callTool('edit_session_plan', {
  action: 'insert_exercise',
  exerciseId: insPick.t.id,
  position: 1,
})
ok(
  badPos?.updated === false && typeof badPos?.reason === 'string',
  '插到当前动作之前被拒（会让进度游标错位）',
  badPos?.reason,
)

const query = await callTool('get_active_session')
ok(
  Array.isArray(query?.exercises) && query.exercises.length === afterIns.count,
  'get_active_session 给出这一场的完整动作清单（编排的坐标来源）',
  `${query?.exercises?.length} 条`,
)

console.log('\n[C] 改这一场的处方')
const presc = await callTool('edit_session_plan', {
  action: 'set_prescription',
  exerciseIndex: afterIns.count,
  sets: 2,
  reps: 15,
  restSec: 120,
})
const afterPresc = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  const last = s.plan.exercises[s.plan.exercises.length - 1]
  return { eff: s.effSets(last), reps: last.reps, rest: last.restSec, total: s.totalCount }
})
ok(presc?.updated === true, 'set_prescription 生效', presc?.message)
ok(
  afterPresc.eff === 2 && afterPresc.reps === 15 && afterPresc.rest === 120,
  '组数 / 次数 / 休息都落到这一场（课程库不动）',
  JSON.stringify(afterPresc),
)
const badPresc = await callTool('edit_session_plan', {
  action: 'set_prescription',
  exerciseIndex: afterIns.count,
  sets: 0,
})
ok(badPresc?.updated === false, '非法组数被拒（结构化原因）', badPresc?.reason)

console.log('\n[D] 删除动作')
const delCur = await callTool('edit_session_plan', {
  action: 'remove_exercise',
  exerciseIndex: afterIns.exIndex,
})
ok(delCur?.updated === false, '当前正在做的动作不能删', delCur?.reason)
const delIns = await callTool('edit_session_plan', {
  action: 'remove_exercise',
  exerciseIndex: afterIns.count,
})
const afterDel = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  return { count: s.plan.exercises.length, names: s.plan.exercises.map((e) => e.name) }
})
ok(delIns?.updated === true, '删掉未做的动作生效', delIns?.message)
ok(afterDel.count === afterIns.count - 1, '动作数 -1', `${afterIns.count} → ${afterDel.count}`)
ok(
  !afterDel.names.includes(insPick.t.name),
  '被删的动作不在这一场里了',
  afterDel.names.join(' / '),
)

console.log('\n[E] 结构与进度进快照')
await wait(1000)
const snap = await store(async () => {
  const { sessionService } = await import('/src/services/sessionService.ts')
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  const rec = await sessionService.getActive()
  const saved = rec?.state?.sessionPlan ?? []
  return {
    savedCount: saved.length,
    localCount: s.plan.exercises.length,
    sameIds: saved.length === s.plan.exercises.length && saved.every((e, i) => e.id === s.plan.exercises[i].id),
    firstName: saved[0]?.name ?? '',
    doneKeys: Object.keys(rec?.state?.doneSets ?? {}).length,
  }
})
ok(snap.savedCount === snap.localCount, 'state.sessionPlan 的动作数与本地一致', `${snap.savedCount}`)
ok(snap.sameIds, '条目 id 逐个一致（doneSets 的键才不会失配）')

// 模拟「按 planId 从课程库重建出一条别的清单」：回灌快照必须把这一场的结构整份复原
const restored = await store(async () => {
  const { sessionService } = await import('/src/services/sessionService.ts')
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  const rec = await sessionService.getActive()
  const want = s.plan.exercises.map((e) => e.name)
  s.plan = { ...s.plan, exercises: [] }
  const okApply = await s.applyExternalSnapshot({
    id: s.sessionId,
    exIndex: rec.exIndex,
    setIndex: rec.setIndex,
    weightKg: rec.weightKg,
    state: rec.state,
  })
  return { okApply, want, got: s.plan.exercises.map((e) => e.name) }
})
ok(
  restored.okApply && restored.got.length === restored.want.length && restored.got.join(',') === restored.want.join(','),
  '快照回灌复原整份结构（插入 / 删除都跟着回来）',
  `${restored.got.length} 个动作`,
)

mkdirSync(OUT, { recursive: true })
await page.screenshot({ path: `${OUT}/session-arrange.png` })
console.log(`    截图 → ${OUT}/session-arrange.png`)

console.log('\n[G] 界面入口：全课抽屉底部的「插入动作」')
const beforeUi = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  return useSessionStore().plan.exercises.length
})
await page.locator('.pcapsule').click()
await page.waitForSelector('.addrow', { timeout: 8000 })
const addText = (await page.locator('.addrow').first().innerText()).trim()
ok(addText.includes('插入动作'), '全课抽屉底部有「插入动作」入口', addText)
await page.screenshot({ path: `${OUT}/session-course-insert.png` })
await page.locator('.addrow').first().click()
await page.waitForTimeout(700)
const pickerTitle = (await page.locator('.head h2:visible').first().innerText()).trim()
ok(pickerTitle.includes('插入'), '点入口弹出动作选择面板（插入模式）', pickerTitle)
const kinds = await page.locator('.kchip:visible').count()
ok(kinds === 3, '插入模式可选动作类型（力量 / 计时 / 有氧）', `${kinds} 个`)
await page.screenshot({ path: `${OUT}/session-insert-sheet.png` })
await page.locator('.cand:visible').first().click()
await wait(800)
const afterUi = await store(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  return useSessionStore().plan.exercises.length
})
ok(afterUi === beforeUi + 1, '界面选一个动作即插入到这一场', `${beforeUi} → ${afterUi}`)
ok((await page.locator('.head h2:visible').count()) === 0, '选完自动收起面板')
// 把刚插入的那个删掉，让后续断言回到已知状态
await callTool('edit_session_plan', { action: 'remove_exercise', exerciseIndex: afterUi })

console.log('\n[F] 无会话时只回结构化拒绝')
const noSession = await page.evaluate(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  await s.discard()
  await new Promise((r) => setTimeout(r, 400))
  const a = await window.__REIN_TOOL__('edit_session_plan', { action: 'remove_exercise', exerciseIndex: 1 })
  const b = await window.__REIN_TOOL__('edit_session_plan', { action: 'insert_exercise', exerciseId: 'x' })
  return { a, b }
})
ok(noSession.a?.updated === false, '无会话时 remove 被拒', noSession.a?.reason)
ok(noSession.b?.updated === false, '无会话时 insert 被拒', noSession.b?.reason)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
