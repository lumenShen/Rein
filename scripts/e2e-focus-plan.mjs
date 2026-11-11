/**
 * e2e-focus-plan —— 「安排专注」四模式与新计划语义（2026-11 改版）
 *
 * 覆盖：
 *   A. 进行中的待办 → 空闲卡自动带出计划条，末颗只压缩最后一颗
 *   B. 安排抽屉 · 智能：覆盖卡 / 按最晚结束 / 末颗缩短 / 预计结束
 *   C. 开始后：运行卡显示预计结束，环内显示计划轮次
 *   D. 沉浸一级显示预计结束；二级完全沉浸不显示
 *   E. 横屏（932×430）切「环 | 状态」两栏
 *   F. 到点 / 按颗数两种模式都能从抽屉直接起跑
 *
 * 前置：dev server（REIN_E2E_URL 或 http://localhost:17420）。
 * 运行：node scripts/e2e-run.mjs scripts/e2e-focus-plan.mjs
 */
import { chromium } from 'playwright-core'

const EDGE = process.env.REIN_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = process.env.REIN_E2E_URL ?? 'http://localhost:17420'

const results = []
function ok(name, cond, detail = '') {
  results.push({ name, cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

async function boot() {
  await page.goto(`${BASE}/#/focus`)
  await sleep(1400)
  const skip = page.getByRole('button', { name: '跳过此版本' })
  if (await skip.count()) await skip.first().click()
  await page.evaluate(() => {
    localStorage.removeItem('rein.pomodoro.live.v1')
    localStorage.removeItem('rein.pomodoro.round.v1')
  })
  await page.reload()
  await sleep(1200)
  const skip2 = page.getByRole('button', { name: '跳过此版本' })
  if (await skip2.count()) await skip2.first().click()
  await sleep(300)
}

/** 手动加一条「现在之前 15 分开始、共 60 分」的待办：终点约 now+45 → 末颗会被压缩 */
async function seedOngoingTodo(title) {
  const d = new Date()
  const nowMin = d.getHours() * 60 + d.getMinutes()
  const start = Math.max(0, nowMin - 15)
  const duration = nowMin - start + 45
  const hhmm = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`
  await page.getByRole('button', { name: /添加待办/ }).first().click()
  await sleep(500)
  await page.getByRole('button', { name: /手动填写待办/ }).click()
  await sleep(500)
  await page.getByLabel('待办标题').fill(title)
  await page.getByLabel('开始时间').fill(hhmm)
  const durBtn = page.getByLabel('点击输入时长')
  await durBtn.click()
  const dur = page.getByLabel('时长（分钟）')
  await dur.fill(String(duration))
  await page.keyboard.press('Enter')
  await sleep(250)
  await page.getByRole('button', { name: '保存' }).click()
  await sleep(600)
  const close = page.locator('[role=dialog][aria-label="添加待办"] button[aria-label="关闭"]')
  if (await close.count()) await close.last().click()
  await sleep(600)
  return { start, duration, available: 45 }
}

async function abandonRunning() {
  const x = page.locator('.page .card .ibtn.danger')
  if (!(await x.count())) return
  await x.first().click()
  await sleep(350)
  const danger = page.locator('[role=dialog] button', { hasText: '放弃本轮' })
  if (await danger.count()) await danger.first().click()
  await sleep(700)
}

await boot()
const TITLE = `e2e 计划 ${Date.now() % 100000}`
const seed = await seedOngoingTodo(TITLE)
console.log('seeded', JSON.stringify(seed))

/* ---------- A. 空闲卡计划条 ---------- */
const planText = await page.locator('.plan').first().innerText()
ok('空闲卡自动带出「正在做」计划条', planText.includes('正在做') && planText.includes(TITLE), planText.replace(/\n/g, ' | '))
ok('计划条给出共几颗与预计结束', planText.includes('共') && planText.includes('预计'), '')
ok('只有最后一颗被压缩（计划条/抽屉出现「末颗」）', planText.includes('末颗'), planText.replace(/\n/g, ' | '))

/* ---------- B. 安排抽屉 · 智能 ---------- */
await page.locator('.plan').first().click()
await sleep(700)
const sheet = page.locator('.fps-panel')
ok('安排抽屉打开', await sheet.isVisible())
const sheetText = (await sheet.innerText()).replace(/\n/g, ' | ')
ok('智能覆盖卡显示待办与「按最晚结束」', sheetText.includes(TITLE) && sheetText.includes('按最晚结束'), sheetText.slice(0, 220))
ok('智能说明写明「末颗缩到」', /末颗缩到/.test(sheetText), '')
ok('抽屉底部有颗数与预计结束', /共\s*\d+\s*颗/.test(sheetText) && /预计结束/.test(sheetText), '')

/* ---------- C. 开始 ---------- */
await sheet.getByRole('button', { name: '开始专注' }).click()
await sleep(1000)
const cap = await page.locator('.page .card .cap').innerText()
const est = await page.locator('.page .card .run-est').innerText()
ok('运行卡环内显示计划轮次', /\/ 共 \d+ 颗/.test(cap), cap)
ok('运行卡显示预计结束 + 剩余总时长', est.includes('预计') && est.includes('还剩'), est.replace(/\n/g, ' '))
const live = await page.evaluate(() => JSON.parse(localStorage.getItem('rein.pomodoro.live.v1') || '{}'))
ok('计划已持久化（source=smart，planRound=1）', live.plan?.source === 'smart' && live.planRound === 1, JSON.stringify({ source: live.plan?.source, round: live.planRound }))

/* ---------- D. 沉浸：一级有预计、二级没有 ---------- */
await page.locator('.page .card .ring-wrap').first().dblclick()
await sleep(700)
const immEst = await page.locator('.fi .imm-est').innerText().catch(() => '')
ok('沉浸一级显示预计结束', immEst.includes('预计') && immEst.includes('还剩'), immEst.replace(/\n/g, ' '))
await page.locator('.fi .center').first().dblclick()
await sleep(700)
const l2 = await page.locator('.fi .l2').count()
const l2Est = await page.locator('.fi .l2 .imm-est').count()
ok('二级完全沉浸只剩读数（不显示预计）', l2 === 1 && l2Est === 0, `l2=${l2} est=${l2Est}`)
await page.locator('.fi .l2').first().click()
await sleep(500)

/* ---------- E. 横屏 ---------- */
await page.setViewportSize({ width: 932, height: 430 })
await sleep(700)
const lsInfo = await page.locator('.fi .l1l .ls-info').innerText().catch(() => '')
ok('横屏切成「环 | 状态」两栏，预计结束在右栏', lsInfo.includes('预计') && lsInfo.includes('下一个'), lsInfo.replace(/\n/g, ' ').slice(0, 160))
await page.setViewportSize({ width: 430, height: 932 })
await sleep(500)
await page.locator('.fi .corner.tl').click()
await sleep(500)
await abandonRunning()

/* ---------- F. 到点 / 按颗数 ---------- */
await page.locator('.plan').first().click()
await sleep(500)
await page.getByRole('tab', { name: '到点' }).click()
await sleep(500)
const untilText = (await page.locator('.fps-panel').innerText()).replace(/\n/g, ' | ')
ok('到点模式给出可用时长与可排颗数', untilText.includes('可用') && untilText.includes('可排'), untilText.slice(0, 200))
await page.locator('.fps-panel').getByRole('button', { name: '开始专注' }).click()
await sleep(900)
const untilCap = await page.locator('.page .card .cap').innerText()
ok('到点开始后进入运行态', /\/ 共 \d+ 颗/.test(untilCap), untilCap)
await abandonRunning()

await page.locator('.plan').first().click()
await sleep(500)
await page.getByRole('tab', { name: '按颗数' }).click()
await sleep(400)
const countText = (await page.locator('.fps-panel').innerText()).replace(/\n/g, ' | ')
ok('按颗数模式突出预计结束', countText.includes('预计结束'), countText.slice(0, 160))
await page.locator('.fps-panel').getByRole('button', { name: '开始专注' }).click()
await sleep(900)
const countCap = await page.locator('.page .card .cap').innerText()
ok('按颗数开始后环内显示计划轮次', /\/ 共 4 颗/.test(countCap), countCap)

ok('全流程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await browser.close()
const passed = results.filter((r) => r.cond).length
console.log(`\n${passed}/${results.length} 通过`)
if (passed !== results.length) {
  console.log('失败项：')
  for (const r of results.filter((x) => !x.cond)) console.log(`- ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
}
