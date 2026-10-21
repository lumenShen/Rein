#!/usr/bin/env node
/**
 * 把 docs/design/huawei/img-all 里的配图拼成「接触印相」（contact sheet），
 * 一屏能看 24 张，用来快速判断每张图在讲什么，再挑重点单看。
 *
 * 为什么需要：103 张配图逐张点开看不现实，但规范的关键往往就藏在中后段那几张
 * （「卡片内 12/16 到底落在哪两个块之间」「列表行高 48 的图标列宽」）。
 *
 * 用法：node scripts/hw-contact-sheet.mjs [doc...]   doc ∈ interval|radius|type|overview|all
 * 产物：.zcode/shots/hw/sheet-<doc>-<n>.png（每页 24 张，5 列）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright-core'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const EDGE = process.env.REIN_EDGE || EDGE_CANDIDATES.find((p) => existsSync(p))
const SRC = 'docs/design/huawei/img-all'
const OUT = '.zcode/shots/hw'
const PER_PAGE = 24
const COLS = 5
const CELL_W = 300
const CELL_H = 240

const args = process.argv.slice(2)
const wanted = args.length ? args : ['all']
const pick = (name) => wanted.includes('all') || wanted.includes(name)

mkdirSync(OUT, { recursive: true })
const files = readdirSync(SRC).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
const groups = {}
for (const f of files) {
  const doc = f.split('-')[0]
  ;(groups[doc] ||= []).push(f)
}

/** 图片内联成 data URI：setContent 的页面是 about:blank 源，file:// 会被拦掉 */
const dataUri = (f) => {
  const buf = readFileSync(join(SRC, f))
  const mime = /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
let total = 0
for (const [doc, list] of Object.entries(groups)) {
  if (!pick(doc)) continue
  list.sort()
  for (let i = 0; i < list.length; i += PER_PAGE) {
    const chunk = list.slice(i, i + PER_PAGE)
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#1b1b1f;font:12px/1.4 -apple-system,'Segoe UI',sans-serif;color:#e8e8ea">
<div style="display:grid;grid-template-columns:repeat(${COLS}, ${CELL_W}px);gap:8px;padding:10px">
${chunk
  .map(
    (f) => `<figure style="margin:0;background:#26262b;border-radius:6px;overflow:hidden">
  <img src="${dataUri(f)}" style="width:${CELL_W}px;height:${CELL_H - 22}px;object-fit:contain;background:#fff">
  <figcaption style="padding:3px 6px;font-size:11px;color:#c9c9cf">${f}</figcaption>
</figure>`,
  )
  .join('\n')}
</div></body>`
    const page = await browser.newPage({ viewport: { width: COLS * (CELL_W + 8) + 20, height: 900 } })
    await page.setContent(html, { waitUntil: 'load' })
    await page.waitForTimeout(400)
    const file = join(OUT, `sheet-${doc}-${Math.floor(i / PER_PAGE) + 1}.png`)
    await page.screenshot({ path: file, fullPage: true })
    await page.close()
    total += 1
    console.log('sheet', file, `(${chunk.length} 张)`)
  }
}
await browser.close()
console.log('\n共 ' + total + ' 张接触印相 → ' + OUT)
