#!/usr/bin/env node
/**
 * 单路由截图台（带数据前置）。
 *
 * 为什么不用 review-hw-shots：那个脚本只截「空壳」——课表、记录、待办这些页面
 * 没有数据时是空态，看不出布局。这里先按需做数据前置（目前只有教务绑定这一条），
 * 再截目标路由，手机 / 桌面、浅色 / 暗色都能选。
 *
 * 用法：
 *   node scripts/shot-app.mjs --route '#/campus/schedule' --campus --out .zcode/shots/x/phone.png
 *   node scripts/shot-app.mjs --route '#/sports' --desk --dark --out .zcode/shots/x/desk-dark.png
 *
 * 参数：
 *   --route <hash>     目标路由（默认 #/）
 *   --campus           先绑定教务账号并同步课表（mock 里才有课程数据）
 *   --desk             1512×950 桌面壳（默认 430×932 手机）
 *   --dark             暗色
 *   --out <path>       截图落盘（默认 .zcode/shots/app.png）
 *   --full             整页截图（默认只截视口）
 *   --wait <ms>        导航后额外等待（默认 1200）
 *   --scroll <px>      截图前滚动到 px
 *   --tap <selector>   截图前点一下（可重复，用于打开抽屉 / 切视图）
 * 环境变量：REIN_E2E_URL（默认 http://localhost:1429）、REIN_EDGE
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { chromium } from 'playwright-core'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const EDGE = process.env.REIN_EDGE || EDGE_CANDIDATES.find((p) => existsSync(p))
const APP = process.env.REIN_E2E_URL || 'http://localhost:1429'

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const val = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const taps = []
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--tap') taps.push(argv[i + 1])

const route = val('--route', '#/')
const out = val('--out', '.zcode/shots/app.png')
const wait = Number(val('--wait', 1200))
const scroll = Number(val('--scroll', 0))
const view = has('--desk')
  ? { width: 1512, height: 950, deviceScaleFactor: 1.5, isMobile: false }
  : { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const ctx = await browser.newContext({
  viewport: { width: view.width, height: view.height },
  deviceScaleFactor: view.deviceScaleFactor,
  isMobile: view.isMobile,
  hasTouch: view.isMobile,
  colorScheme: has('--dark') ? 'dark' : 'light',
  locale: 'zh-CN',
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text())
})

const dismissUpdate = async () => {
  for (let i = 0; i < 3; i += 1) {
    const hit = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.up-card button')].find((x) => ['稍后', '跳过此版本'].includes(x.textContent.trim()))
      if (b) b.click()
      return !!b
    })
    if (hit) {
      await sleep(400)
      return
    }
    await sleep(500)
  }
}

try {
  await page.goto(APP + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page', { timeout: 45000 })
  await sleep(1200)
  await dismissUpdate()

  const step = (m) => { if (process.env.REIN_SHOT_DEBUG) console.log('·', m) }
  if (has('--campus')) {
    /* mock 的教务账号只活在内存里，且**必须走真实路径**：
       先落到课表页（空态）→ 点「去配置」→ 登录 → 返回。
       从别的路由直接进配置页再登录，回到课表仍是空态（store 的首次装载时序），
       那是产品问题，不该在截图工装里绕过 —— 这里只保证「用户怎么走，工装就怎么走」。 */
    step('课表空态')
    await page.evaluate(() => { location.hash = '#/campus/schedule' })
    await page.waitForFunction("document.body.textContent.includes('还没有课表数据')", null, { timeout: 20000 })
    step('点去配置')
    await page.getByRole('button', { name: '去配置' }).first().click()
    await page.waitForFunction("document.querySelector('h1')?.textContent === '课表配置与设置'", null, { timeout: 15000 })
    step('填账号')
    await page.fill('input[autocomplete="username"]', '2600350118')
    await page.fill('input[autocomplete="current-password"]', 'demo1234')
    step('点登录')
    await page.getByRole('button', { name: '登录', exact: true }).first().click()
    step('等同步回执')
    await page.waitForFunction("document.body.textContent.includes('上次同步')", null, { timeout: 25000 })
    step('返回课表')
    // 不用 goBack：Playwright 的 goBack 在 hash 路由 + 相对 URL 下会把 hash 解析成
    // 「#/C:/…/campus/schedule」这种坏 URL（history 里有一条 file 源）。显式改 hash。
    await page.evaluate(() => { location.hash = '#/campus/schedule' })
    await page.waitForFunction("document.querySelectorAll('.grid .cell.head.day').length === 7", null, { timeout: 20000 })
    step('课表已渲染')
  }

  step('准备截图')
  const current = await page.evaluate(() => location.hash)
  if (current !== route) {
    await page.evaluate((r) => { location.hash = r }, route)
    await page.waitForFunction("!!document.querySelector('.page')", null, { timeout: 20000 })
  }
  await sleep(wait)
  await dismissUpdate()

  for (const sel of taps) {
    const el = page.locator(sel).first()
    await el.click({ timeout: 8000 })
    await sleep(700)
  }

  if (scroll) {
    await page.evaluate((y) => {
      for (const el of [document.querySelector('.page'), document.querySelector('.desk-main'), document.scrollingElement]) {
        if (el && el.scrollHeight - el.clientHeight > 8) el.scrollTop = y
      }
    }, scroll)
    await sleep(400)
  }

  step('落盘')
  mkdirSync(dirname(out), { recursive: true })
  await page.screenshot({ path: out, fullPage: has('--full') })
  const info = await page.evaluate(() => ({
    hash: location.hash,
    body: document.body.innerText.slice(0, 60).split('\n').join(' | '),
    title: document.querySelector('h1')?.textContent?.trim() ?? null,
    docH: document.documentElement.scrollHeight,
    vw: innerWidth,
    vh: innerHeight,
  }))
  console.log('shot', out, JSON.stringify(info), errors.length ? '｜错误 ' + errors.length : '')
  if (errors.length) console.log(errors.slice(0, 5).join('\n'))
} catch (e) {
  console.error('截图失败：', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
