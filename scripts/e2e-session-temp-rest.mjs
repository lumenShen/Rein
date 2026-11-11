/**
 * 训练会话「临时休息」回归实测（浏览器 + mock 后端）。
 *
 * 为什么单独一条：实病是**菜单值串台**，只有真点菜单才验得到 ——
 * 「更多 → 临时休息 → 1/2/3/5 分钟」的子菜单值与「今日状态」的 1–5 档撞值，
 * onMorePick 先判自评，于是点休息反而写入了自评 1–5 档，界面提示
 * 「已记录今日状态 · 建议重量已同步调整」——用户读到的是「变成提交修改训练状态」。
 *
 * 覆盖：
 *  T. 临时休息（手动组间休息）只进入休息相位：restIsTemp / restTotal 正确，
 *     且 readiness 保持原值（绝不写自评）、提示文案是「临时休息 N 分钟」
 *  R. 今日状态子菜单仍能正常写值（前缀化之后两路互不串台）
 *
 * 运行：node scripts/e2e-run.mjs scripts/e2e-session-temp-rest.mjs
 *   （或前置另起一个**非 Tauri** 的 vite，再用 REIN_E2E_URL 指过去）
 */

import { chromium } from 'playwright-core'

const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:5173'
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

/** 页面内直取会话 store */
const sessionState = () =>
  page.evaluate(async () => {
    const { useSessionStore } = await import('/src/stores/session.ts')
    const s = useSessionStore()
    return {
      phase: s.phase,
      restIsTemp: s.restIsTemp,
      restLeft: s.restLeft,
      restTotal: s.restTotal,
      readiness: s.readiness,
    }
  })

const skipRestInStore = () =>
  page.evaluate(async () => {
    const { useSessionStore } = await import('/src/stores/session.ts')
    useSessionStore().skipRest()
  })

async function ensureToolHook() {
  await page.evaluate(async () => {
    if (typeof window.__REIN_TOOL__ !== 'function') {
      await import('/src/ai/tools/registry.ts')
    }
  })
}

const callTool = (name, args) =>
  page.evaluate(([n, a]) => window.__REIN_TOOL__(n, a), [name, args ?? {}])

const toastTexts = () => page.locator('.toast .txt').allTextContents()

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

console.log('\n[S] 开课并进入正式组')
await page.locator('button.start', { hasText: '开始' }).first().click()
await page.waitForSelector('.pane .eyebrow', { timeout: 15000 })
await wait(800)

await ensureToolHook()
await callTool('update_active_session', { action: 'skip_warmup' })
await wait(900)
// 跳过热身进入正式组后今日状态对话框才弹（触发条件 = 做组中 + 还没自评）
const rdSkip = page.locator('.rd-btn', { hasText: '跳过' })
if ((await rdSkip.count()) > 0) {
  await rdSkip.first().click()
  await wait(500)
}
// 让「开始第 1 组」闪现 overlay 播完，避免它盖住底坞
await wait(2000)

const base = await sessionState()
ok(base.phase === 'exercise', '已进入正式组相位', base.phase)
ok(base.readiness === null, '自评基线为 null（跳过即纯自动推断）', String(base.readiness))

console.log('\n[T] 临时休息只改休息相位，不写今日状态')
// 1 / 3 / 5 分钟都曾与自评 1–5 档撞值 —— 三个都点一遍
for (const min of [1, 3, 5]) {
  await page.locator('.ctrl-dock .iconbtn[aria-label="更多功能"]').click()
  await wait(350)
  await page.getByRole('menuitem', { name: '临时休息', exact: true }).click()
  await wait(300)
  await page.getByRole('menuitem', { name: `${min} 分钟`, exact: true }).click()
  await wait(400)

  const st = await sessionState()
  ok(st.phase === 'rest', `${min} 分钟：进入休息相位`, st.phase)
  ok(st.restIsTemp === true, `${min} 分钟：标记为临时休息`, String(st.restIsTemp))
  ok(st.restTotal === min * 60, `${min} 分钟：倒计时总长 ${min * 60} 秒`, String(st.restTotal))
  ok(st.readiness === base.readiness, `${min} 分钟：没有写入今日状态`, String(st.readiness))

  const texts = await toastTexts()
  ok(
    texts.some((t) => t.includes(`临时休息 ${min} 分钟`)),
    `${min} 分钟：提示为「临时休息 ${min} 分钟」`,
    texts.join(' / '),
  )
  ok(
    !texts.some((t) => t.includes('今日状态')),
    `${min} 分钟：没有出现自评提示`,
    texts.join(' / '),
  )

  // 结束临时休息，回到做组（下一轮仍可从 exercise 相位打开菜单）；
  // 恢复时会闪 1.2s 的「继续第 N 组」全屏层，等它退场再点下一轮
  await skipRestInStore()
  await wait(1600)
  const back = await sessionState()
  ok(back.phase === 'exercise' && back.restIsTemp === false, `${min} 分钟：结束后回到做组相位`, back.phase)
}

console.log('\n[R] 今日状态子菜单仍能正常写值')
await page.locator('.ctrl-dock .iconbtn[aria-label="更多功能"]').click()
await wait(350)
await page.getByRole('menuitem', { name: '今日状态', exact: true }).click()
await wait(300)
await page.getByRole('menuitem', { name: '很好 · 精力充沛', exact: true }).click()
await wait(400)

const after = await sessionState()
ok(after.readiness === 5, '选「很好」写入自评 5 档', String(after.readiness))
const readyTexts = await toastTexts()
ok(
  readyTexts.some((t) => t.includes('已记录今日状态')),
  '自评提示仍正常出现',
  readyTexts.join(' / '),
)

console.log(`\n通过 ${pass} · 失败 ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
