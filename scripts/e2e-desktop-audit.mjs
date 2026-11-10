/**
 * 桌面体验验收守卫 —— 「桌面端要好用」这件事的判据集合。
 *
 * 与 e2e-desktop-shell.mjs 的分工：
 *   · e2e-desktop-shell 管**桌面壳的既有契约**（三窗格、栅格、⌘K、游离子孙让位），是回归网；
 *   · 这里管**跨宽度档的体验底线** —— 尤其是用户点名的「稍微宽一点的竖屏还在用手机版」
 *     那一档（900×1200 / 1024×768），以及指针精度下的可点性、无溢出、无硬裁切。
 *
 * 断言分两类（跑完打印 OK/XX，退出码非 0 = 有失败）：
 *
 *   回归类（改前也应通过，任何改动都不许碰坏）
 *     R1 任何视口都没有整页横向溢出
 *     R2 430×932 仍是手机壳（.app-frame，无桌面壳），内容栏 = 视口宽
 *     R3 1512×945 仍是三窗格桌面壳，卡片流页面内容 ≤ --desk-content
 *     R4 没有字号掉出阶梯（< 11px）
 *
 *   达标类（这一轮的验收目标，改前预期红 —— 修复要以它们转绿为准）
 *     T1 中间宽度（900×1200、1024×768）拿到**桌面级导航**（.desk-main 存在，不再用底部 Dock），
 *        且内容栏 ≥ 600px（现在：480px 的手机窄栏居中）
 *     T2 指针视口（≥1024）没有小于 22×22 的可见交互靶（现在：11–17px 的编辑/勾选钮一屏十来个）
 *     T3 中间宽度下信息栏默认收起（≥1100 才默认展开）—— 900 宽还挂着 298px 的信息栏，
 *        主人区只剩 530px，比手机栏还窄
 *
 * 运行：node scripts/e2e-run.mjs scripts/e2e-desktop-audit.mjs
 * 或：  node scripts/e2e-desktop-audit.mjs   （已有 REIN_E2E_URL / 1420 在跑时）
 */
import { chromium } from 'playwright-core'
import { presetFeatureFlags } from './lib/features.mjs'
import { measureInPage } from './lib/desktop-metrics.mjs'

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const EDGE = process.env.REIN_EDGE

const PHONE = { w: 430, h: 932 }
const MID_PORTRAIT = { w: 900, h: 1200 }
const MID_LANDSCAPE = { w: 1024, h: 768 }
const DESK = { w: 1512, h: 945 }
const MID = [MID_PORTRAIT, MID_LANDSCAPE]

/** 代表路由：够覆盖几种构图（卡片流 / 宽画布 / 列表 / 设置表单 / 对话），不必全量 */
const ROUTES = [
  '#/', '#/sports', '#/ai', '#/settings', '#/todos', '#/ledger', '#/me',
  // 2026-11 「关于你」投影 + 设置三组 + 运动设置链：桌面审计也要量到这些新页
  '#/me/folder?key=health', '#/me/program', '#/settings/apps',
  '#/settings/apps/external', '#/settings/appearance',
  '#/sports/settings', '#/sports/settings/run', '#/sports/settings/course',
]

/** 点击靶下限：指针视口下的可见交互元素（触屏那套 44px 是另一回事，这里按鼠标精度） */
const MIN_TARGET = 22
/** 中间宽度下内容栏的下限：手机栏是 480，这里要求明显更宽 */
const MID_MIN_CONTENT = 600

const failures = []
const notes = []
function check(name, ok, detail) {
  if (ok) console.log('  OK  ' + name)
  else { console.log('  XX  ' + name + (detail ? ' —— ' + detail : '')); failures.push(name) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function dismissUpdate(page) {
  try {
    const later = page.getByRole('button', { name: '稍后' })
    if (await later.count()) await later.first().click({ timeout: 800 })
  } catch { /* 没有更新卡片就直接过 */ }
}

const browser = await chromium.launch({
  channel: EDGE ? undefined : 'msedge',
  executablePath: EDGE || undefined,
  headless: true,
})

/** 在一个视口下把代表路由量一遍，返回 route → measure */
async function scan(vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: 'light' })
  const page = await ctx.newPage()
  const cdpSession = await ctx.newCDPSession(page)
  await presetFeatureFlags((method, params) => cdpSession.send(method, params)).catch(() => {})
  const out = {}
  for (const route of ROUTES) {
    try {
      await page.goto(`${APP}/${route}`, { waitUntil: 'load', timeout: 20000 })
      await page.waitForSelector('.page, .app-frame, .desk-frame', { timeout: 8000 }).catch(() => {})
      await sleep(900)
      await dismissUpdate(page)
      await sleep(150)
      out[route] = await page.evaluate(measureInPage)
    } catch (e) {
      out[route] = { error: String(e).slice(0, 200) }
    }
  }
  await ctx.close()
  return out
}

try {
  const phone = await scan(PHONE)
  const midP = await scan(MID_PORTRAIT)
  const midL = await scan(MID_LANDSCAPE)
  const desk = await scan(DESK)

  /* ---------------- 回归类 ---------------- */
  console.log('\n回归：任何宽度都不许坏\n')
  let overflowBad = []
  for (const [vpName, m] of [['430×932', phone], ['900×1200', midP], ['1024×768', midL], ['1512×945', desk]]) {
    for (const [route, d] of Object.entries(m)) {
      if (d.error) { overflowBad.push(`${vpName} ${route} 打不开：${d.error}`); continue }
      if (d.overflowX > 1) overflowBad.push(`${vpName} ${route} 溢出 ${d.overflowX}px`)
    }
  }
  check('R1 整页无横向溢出', overflowBad.length === 0, overflowBad.slice(0, 4).join('；'))

  const phoneHome = phone['#/']
  check(
    'R2 430×932 仍是手机壳（.app-frame、无桌面壳）',
    !phoneHome.error && phoneHome.shell === 'mobile' && !phoneHome.hasDesk,
    phoneHome.error ?? `shell=${phoneHome.shell} hasDesk=${phoneHome.hasDesk}`,
  )
  check(
    'R2b 手机内容栏 = 视口宽（430）',
    !phoneHome.error && Math.abs(phoneHome.contentWidth - PHONE.w) <= 2,
    `content=${phoneHome.contentWidth}`,
  )

  const deskSettings = desk['#/settings']
  check(
    'R3 1512×945 仍是三窗格桌面壳',
    !deskSettings.error && deskSettings.shell === 'desk' && deskSettings.hasDesk,
    deskSettings.error ?? `shell=${deskSettings.shell}`,
  )
  check(
    'R3b 桌面卡片流页内容 ≤ 1040（--desk-content）',
    !deskSettings.error && deskSettings.contentWidth <= 1040 + 2,
    `content=${deskSettings.contentWidth}`,
  )

  const tiny = []
  for (const m of [phone, midP, midL, desk]) {
    for (const [route, d] of Object.entries(m)) if (!d.error && d.tinyFont.length) tiny.push(`${route}:${d.tinyFont[0].fs}px`)
  }
  check('R4 无字号掉出阶梯（<11px）', tiny.length === 0, tiny.slice(0, 4).join('；'))

  /* ---------------- 达标类 ---------------- */
  console.log('\n达标：这一轮的验收目标\n')
  for (const [vpName, m] of [['900×1200', midP], ['1024×768', midL]]) {
    const badShell = ROUTES.filter((r) => !m[r].error && !m[r].hasDesk).map((r) => r)
    check(
      `T1 ${vpName} 拿到桌面级导航（.desk-main，不再用底部 Dock）`,
      badShell.length === 0,
      badShell.length ? `${badShell.join(' ')} 仍是手机壳` : '',
    )
    const narrow = ROUTES.filter((r) => !m[r].error && m[r].contentWidth < MID_MIN_CONTENT).map((r) => `${r}=${m[r].contentWidth}px`)
    check(
      `T1b ${vpName} 内容栏 ≥ ${MID_MIN_CONTENT}px（不再居中放 480 手机栏）`,
      narrow.length === 0,
      narrow.slice(0, 5).join(' '),
    )
  }

  const small = []
  for (const [vpName, m] of [['1024×768', midL], ['1512×945', desk]]) {
    for (const [route, d] of Object.entries(m)) {
      for (const t of d.error ? [] : d.smallTap) {
        if (Math.min(t.rect.w, t.rect.h) < MIN_TARGET) small.push(`${vpName} ${route} ${t.rect.w}×${t.rect.h} ${t.text || t.path}`)
      }
    }
  }
  check(`T2 指针视口没有小于 ${MIN_TARGET}×${MIN_TARGET} 的可见交互靶`, small.length === 0, `${small.length} 处，例：${small.slice(0, 3).join('；')}`)

  for (const [vpName, m] of [['900×1200', midP], ['1024×768', midL]]) {
    // 精确到「有桌面壳就**不许**挂着信息栏」：手机上根本没有这一格，dataset 只是持久偏好残留
    const bad = ROUTES.filter((r) => !m[r].error && m[r].hasDesk && m[r].inspector === 'on').map((r) => r)
    check(
      `T3 ${vpName} 桌面壳下信息栏默认收起（< 1100 没有 298px 的第三窗格）`,
      bad.length === 0,
      bad.length ? `${bad.join(' ')} 仍默认展开` : '',
    )
  }

  if (notes.length) console.log('\n附注：\n  ' + notes.join('\n  '))
} finally {
  await browser.close()
}

console.log(
  failures.length
    ? `\n桌面体验验收：${failures.length} 条未达标\n  - ${failures.join('\n  - ')}`
    : '\n桌面体验验收：全部通过',
)
process.exitCode = failures.length ? 1 : 0
