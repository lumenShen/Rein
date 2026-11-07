/**
 * 桌面壳层守卫（真机视口 1512×945）—— 盯住桌面工作台的四条契约，改动后跑一次就能发现漂移。
 *
 *   1 三窗格壳成立：.desk-frame / 导航轨 / 信息栏都在，且主人区拿到 --desk-gutter
 *   2 **栅格与工具类的先后**：grid 路由的 .page 是两栏栅格、.card 半栏、.d-full 通栏。
 *     这条是真实踩过的坑 —— 摆放规则一度写在 App.vue 的 :deep 里，特指度压过 base.css
 *     的 .d-full，页面加了 class 却不生效；这里用「量出来的宽度」把它钉死，比读一遍 CSS 可靠。
 *   3 键盘层：⌘K 面板能开、能过滤、能跳转；⌘I 收信息栏并**落盘**；⌘1–4 换一级页
 *   4 窄屏不回归：430×932 下没有 .desk-frame / .desk-main，退回 .app-frame
 *
 * 运行：node scripts/e2e-desktop-shell.mjs   （先 `npm run dev`，或设 REIN_E2E_URL）
 * 退出码非 0 表示有断言失败。
 *
 * 修订（2026-11-07）：
 *   · 留白断言 34px → 40px —— --desk-gutter 早前由 34 手感值改为 40（HarmonyOS 间隔参数
 *     PC 档，tokens.css），App.vue 把它映射成 --page-pad-x；nav-redesign.md §8.4 已核实这是
 *     存量漂移，断言按当前令牌更新（通栏宽度按两侧各 40 重算）。
 *   · 撤掉「.fab 落在信息栏左侧」断言 —— 悬浮记录钮在 6601259（v0.7.1）被收回内容流
 *     （它长期盖住饮食库列表最后两行），全应用再无 .fab / 等价 teleport 悬浮主操作，
 *     「游离子孙让位」契约暂无承载元素，断言随之退役；base.css 的 .fab 桌面规则成了死样式。
 */
import { chromium } from 'playwright-core'

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const EDGE = process.env.REIN_EDGE
const DESK = { width: 1512, height: 945 }
const PHONE = { width: 430, height: 932 }

const failures = []
function check(name, ok, detail) {
  if (ok) {
    console.log('  OK  ' + name);
  } else {
    console.log('  XX  ' + name + (detail ? ' —— ' + detail : ''));
    failures.push(name);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 更新卡片会盖住整页，先点掉（与其余剧本同一套处理） */
async function dismissUpdate(page) {
  try {
    const later = page.getByRole('button', { name: '稍后' })
    if (await later.count()) await later.first().click({ timeout: 800 })
  } catch {
    /* 没有更新卡片就直接过 */
  }
}

async function goto(page, hash) {
  await page.goto(APP + '/' + hash, { waitUntil: 'load' })
  await sleep(900)
  await dismissUpdate(page)
  await sleep(200)
}

const browser = await chromium.launch({
  channel: EDGE ? undefined : 'msedge',
  executablePath: EDGE || undefined,
  headless: true,
})

try {
  /* ---------- 桌面 ---------- */
  const ctx = await browser.newContext({ viewport: DESK, colorScheme: 'light' })
  const page = await ctx.newPage()

  console.log('桌面壳（1512×945）')
  await goto(page, '#/sports')

  const shell = await page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const box = (s) => {
      const el = q(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, maxW: cs.maxWidth }
    }
    const mainEl = q('.desk-main')
    return {
      frame: !!q('.desk-frame'),
      rail: box('.rail'),
      inspector: box('.inspector'),
      main: mainEl ? getComputedStyle(mainEl).getPropertyValue('--page-pad-x').trim() : null,
      page: box('.page'),
      cols: q('.page') ? getComputedStyle(q('.page')).gridTemplateColumns : null,
      dataShell: document.documentElement.dataset.shell,
    }
  })
  check('三窗格壳存在（导航轨 + 主人区 + 信息栏）', shell.frame && !!shell.rail && !!shell.inspector)
  check('主人区拿到桌面留白 --page-pad-x = 40px（--desk-gutter PC 档）', shell.main === '40px', '实测 ' + shell.main)
  check('grid 路由的 .page 是两栏栅格', (shell.cols ?? '').split(' ').length === 2, '实测 ' + shell.cols)
  check('.page 内容上限 = --desk-content 1040', shell.page.maxW === '1040px', '实测 ' + shell.page.maxW)
  check('<html data-shell="desk">（游离子孙据此适配）', shell.dataShell === 'desk', '实测 ' + shell.dataShell)

  // 栅格子项摆放：.card 半栏、.d-full 通栏 —— 工具类的先后顺序靠这里守着。
  // 卡片挂在页面的内容层里（.page > .rubber-layer，system/rubberScroll 的超伸层），
  // 层镜像 .page 的两栏栅格，所以量的是层内的子项。
  // 首页只有半栏卡；通栏卡到记账页量（那一页两种都有）。
  const spans = await page.evaluate(() => {
    const layer = document.querySelector('.page > .rubber-layer') ?? document.querySelector('.page')
    const kids = [...layer.children]
    const half = kids.find((el) => el.classList.contains('card') && !el.classList.contains('d-full'))
    const pageEl = document.querySelector('.page')
    return {
      halfCol: half ? getComputedStyle(half).gridColumn : null,
      pageW: Math.round(pageEl.getBoundingClientRect().width),
    }
  })
  check('.page > .card 缺省半栏', spans.halfCol === 'span 1', '实测 ' + spans.halfCol)
  await goto(page, '#/ledger')
  const fullSpans = await page.evaluate(() => {
    const layer = document.querySelector('.page > .rubber-layer') ?? document.querySelector('.page')
    const full = [...layer.children].find((el) => el.classList.contains('d-full'))
    const pageEl = document.querySelector('.page')
    return {
      fullCol: full ? getComputedStyle(full).gridColumn : null,
      fullW: full ? Math.round(full.getBoundingClientRect().width) : 0,
      pageW: Math.round(pageEl.getBoundingClientRect().width),
    }
  })
  check('.page > .card.d-full 通栏（工具类压过缺省）', fullSpans.fullCol === '1 / -1', '实测 ' + fullSpans.fullCol + ' / 宽 ' + fullSpans.fullW)
  check('通栏宽度 = 页面内容宽（两侧各留 40px）', fullSpans.fullW > 0 && Math.abs(fullSpans.fullW - (fullSpans.pageW - 80)) <= 2, '通栏 ' + fullSpans.fullW + ' / 页面 ' + fullSpans.pageW)

  /* 宽形态页面不该被套栅格：AI 页自己那条阅读栏必须留着 */
  await goto(page, '#/ai')
  const wide = await page.evaluate(() => {
    const el = document.querySelector('.page')
    const cs = getComputedStyle(el)
    return { display: cs.display, w: Math.round(el.getBoundingClientRect().width) }
  })
  check('wide 路由（AI）不套两栏栅格，保持自持阅读栏', wide.display !== 'grid' && wide.w <= 900, 'display ' + wide.display + ' / 宽 ' + wide.w)

  /* ---------- 键盘层 ---------- */
  console.log('键盘层')
  await goto(page, '#/sports')
  await page.keyboard.press('Control+k')
  await sleep(400)
  check('⌘K 打开命令面板', (await page.locator('.panel').count()) === 1)
  await page.keyboard.type('记账')
  await sleep(350)
  const hits = await page.locator('.rowitem').count()
  check('输入即过滤（中文子串）', hits > 0 && hits <= 4, '命中 ' + hits + ' 条')
  await page.keyboard.press('Enter')
  await sleep(700)
  check('回车跳转到选中项', page.url().includes('#/ledger'), '实际 ' + page.url())

  await page.keyboard.press('Control+i')
  await sleep(350)
  const collapsed = await page.evaluate(() => {
    const insp = document.querySelector('.inspector')
    return {
      hidden: !insp || getComputedStyle(insp).display === 'none',
      marker: document.documentElement.dataset.inspector,
      pref: localStorage.getItem('rein.inspector.v1'),
    }
  })
  check('⌘I 收起信息栏', collapsed.hidden)
  check('收起状态写到 <html data-inspector>', collapsed.marker === 'off', '实测 ' + collapsed.marker)
  check('收起偏好落盘（rein.inspector.v1 = 0）', collapsed.pref === '0', '实测 ' + collapsed.pref)

  await page.reload({ waitUntil: 'load' })
  await sleep(1200)
  await dismissUpdate(page)
  const persisted = await page.evaluate(() => {
    const insp = document.querySelector('.inspector')
    return !insp || getComputedStyle(insp).display === 'none'
  })
  check('刷新后仍是收起（偏好生效）', persisted)

  await page.keyboard.press('Control+1')
  await sleep(700)
  check('⌘1 回到总览', page.url().endsWith('#/'), '实际 ' + page.url())

  /* ---------- 窄屏不回归 ---------- */
  console.log('窄屏（430×932）')
  const phone = await browser.newContext({ viewport: PHONE, colorScheme: 'light' })
  const p2 = await phone.newPage()
  await goto(p2, '#/sports')
  const mobile = await p2.evaluate(() => ({
    desk: !!document.querySelector('.desk-frame') || !!document.querySelector('.desk-main'),
    rail: !!document.querySelector('.rail'),
    inspector: !!document.querySelector('.inspector'),
    app: !!document.querySelector('.app-frame'),
    tabbar: !!document.querySelector('.tabbar, .dock, nav[aria-label="主导航"]'),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  check('窄屏没有桌面壳（无 .desk-main / 导航轨 / 信息栏）', !mobile.desk && !mobile.rail && !mobile.inspector)
  check('窄屏仍是原来的 .app-frame', mobile.app && mobile.tabbar)
  check('窄屏无横向溢出', mobile.overflow <= 0, '溢出 ' + mobile.overflow + 'px')
  await phone.close()
  await ctx.close()
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.log('桌面壳守卫失败：' + failures.length + ' 项')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
console.log('桌面壳守卫通过：三窗格 / 栅格与工具类 / 键盘层 / 窄屏不回归')
