#!/usr/bin/env node
/**
 * 全局沉浸浮窗 · 截图脚本（浅色 + 暗色，STANDARDS §7）。
 *
 * 默认 mock 模式（无需 Tauri、只需要 1429/1420 上的 vite dev server）：
 *   - 浮窗三种形态：bar 430×92 / confirm 430×172 / blob 64×64（用最小 Tauri IPC 桩把
 *     float.html 当成真浮窗来渲染，与真机同一份组件与 CSS）；
 *   - 设置页「全局浮窗」卡；
 *   → docs/screens/global-float-mock-*.png
 *
 * 真机模式（--app）：直接复用 scripts/e2e-global-float.mjs 的 A2 段（它会起 tauri dev、
 * 断言的同时把真机截图写到 docs/screens/global-float-*.png）。
 *
 * 运行：
 *   node scripts/shot-global-float.mjs          # mock 截图（约 10s）
 *   node scripts/shot-global-float.mjs --app    # 真机截图（会编译启动 App，较慢）
 *
 * 环境变量：REIN_E2E_URL（默认 http://localhost:1429）、REIN_EDGE（浏览器可执行文件）
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright-core'

import { findBrowser, focusPayload, workoutPayload, TAURI_STUB_SOURCE } from './lib/float-cdp.mjs'

const APP = process.env.REIN_E2E_URL || 'http://localhost:1429'
const SCREENS = join(process.cwd(), 'docs/screens')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shotMock() {
  mkdirSync(SCREENS, { recursive: true })
  const browser = await chromium.launch({ executablePath: process.env.REIN_EDGE || findBrowser(), headless: true })
  const saved = []
  const save = async (page, name) => {
    const file = join(SCREENS, 'global-float-mock-' + name + '.png')
    await page.screenshot({ path: file })
    saved.push(file)
    console.log('  截图 ' + file)
  }
  try {
    /* ---------- 浮窗三形态（假 Tauri 通道，真组件） ---------- */
    const page = await browser.newPage({ viewport: { width: 430, height: 92 }, colorScheme: 'light' })
    await page.addInitScript(TAURI_STUB_SOURCE)
    await page.goto(APP + '/float.html', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.float-shell', { timeout: 30000 })
    await sleep(300)
    await page.evaluate((payload) => window.__fire(JSON.stringify(payload)), focusPayload())
    await page.waitForSelector('.float-stage .info', { timeout: 8000 })
    await sleep(400)
    await save(page, 'bar-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await sleep(400)
    await save(page, 'bar-dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await sleep(300)

    // confirm：点结束 → 窗口临时长高到 430×172（真机由 Rust 改窗口尺寸，这里改视口模拟）
    await page.click('.float-stage .abtn.end')
    await page.waitForSelector('.float-confirm .c-acts', { timeout: 5000 })
    await page.setViewportSize({ width: 430, height: 172 })
    await sleep(400)
    await save(page, 'confirm-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await sleep(400)
    await save(page, 'confirm-dark')
    await page.emulateMedia({ colorScheme: 'light' })
    // 取消回 bar，再泊车成 64×64 blob
    await page.click('.float-confirm .cbtn.cancel')
    await page.waitForSelector('.float-stage', { timeout: 5000 })
    await page.setViewportSize({ width: 64, height: 64 })
    await page.evaluate((payload) => window.__fire(JSON.stringify(payload)), workoutPayload({ form: 'blob' }))
    await page.waitForSelector('.float-blob', { timeout: 5000 })
    await sleep(500)
    await save(page, 'blob-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await sleep(400)
    await save(page, 'blob-dark')
    await page.close()

    /* ---------- 设置页「全局浮窗」卡 ---------- */
    const settings = await browser.newPage({ viewport: { width: 430, height: 932 }, colorScheme: 'light' })
    await settings.goto(APP + '/#/settings', { waitUntil: 'domcontentloaded' })
    await settings.waitForSelector('.page', { timeout: 45000 })
    await sleep(1800)
    await settings.evaluate(() => {
      const b = [...document.querySelectorAll('.up-card button')].find((x) => ['稍后', '跳过此版本'].includes(x.textContent.trim()))
      if (b) b.click()
    })
    const card = settings.locator('section.card', { hasText: '全局浮窗' }).first()
    await card.scrollIntoViewIfNeeded()
    /* 底部 Dock 是 fixed 浮层，scrollIntoViewIfNeeded 只保证「滚进可视区」，
       不避开它 —— 直接截元素会把 Dock 一起截进来，文档图看起来像卡片被压住了。
       截图前把 Dock 与浮条藏起来（display 而不是 remove：改完要还原，别动 DOM 结构） */
    await settings.evaluate(() => {
      for (const el of document.querySelectorAll('.dock-assembly, .float-dock')) {
        el.dataset.shotPrevDisplay = el.style.display
        el.style.display = 'none'
      }
    })
    await sleep(300)
    const lightFile = join(SCREENS, 'global-float-mock-settings-light.png')
    await card.screenshot({ path: lightFile })
    saved.push(lightFile)
    console.log('  截图 ' + lightFile)
    await settings.emulateMedia({ colorScheme: 'dark' })
    await sleep(500)
    const darkFile = join(SCREENS, 'global-float-mock-settings-dark.png')
    await card.screenshot({ path: darkFile })
    saved.push(darkFile)
    console.log('  截图 ' + darkFile)
    await settings.evaluate(() => {
      for (const el of document.querySelectorAll('.dock-assembly, .float-dock')) {
        el.style.display = el.dataset.shotPrevDisplay ?? ''
        delete el.dataset.shotPrevDisplay
      }
    })
    await settings.close()
  } finally {
    await browser.close()
  }
  console.log('\nmock 截图 ' + saved.length + ' 张 → ' + SCREENS)
}

function runAppShots() {
  // 真机截图与真机断言同一次运行：复用 A2（临时配置 + 两个 CDP target + 浅/暗截图）
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/e2e-global-float.mjs'), '--app'], { stdio: 'inherit' })
  process.exit(r.status === null ? 1 : r.status)
}

if (process.argv.includes('--app')) {
  runAppShots()
} else {
  shotMock().catch((e) => {
    console.error('截图失败：' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}
