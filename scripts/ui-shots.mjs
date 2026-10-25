/**
 * UI 视觉审查截图（无头 Edge + 原生 CDP）。
 * 运行：node scripts/ui-shots.mjs [前缀]
 * 产出：.tmp-ui-shots/<前缀>*.png —— 主页两端（便当/脊柱/移动）+ 代表页。
 * 依赖：npm run dev 已在 1420（或 REIN_E2E_URL 指向的实例）。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-profile-${Date.now()}`
const PREFIX = process.argv[2] ?? 'shot'
/** DARK=1 时模拟 prefers-color-scheme: dark（令牌联动需要两种主题都过一眼） */
const DARK = process.env.DARK === '1'
/** ALL=1 全路由扫一遍：桌面+移动各一张整页图，供视觉审查分批阅卷 */
const ALL = process.env.ALL === '1'
/** 全页截图（captureBeyondViewport），ALL 模式默认开 */
const FULL = process.env.FULL !== '0'
/**
 * PERF=extreme 时把画质档钉死（`system/perf.ts` 的 `rein.perf.v1`）。
 * 出 README / 宣传图要固定材质档时才用；不传就沿用浏览器里的档，与平时肉眼审查一致。
 */
const PERF = process.env.PERF

/** ALL 模式的路由清单（router.ts 静态路由；带参路由取 mock 种子的 id=1） */
const ROUTES = [
  ['sports', '#/sports'],
  ['ai', '#/ai'],
  ['ai-models', '#/ai/models'],
  ['ai-knowledge', '#/ai/knowledge'],
  ['ai-files', '#/ai/files'],
  ['me', '#/me'],
  ['settings', '#/settings'],
  ['settings-features', '#/settings/features'],
  ['settings-float', '#/settings/float'],
  ['settings-sync', '#/settings/sync'],
  ['settings-update', '#/settings/update'],
  ['settings-perf', '#/settings/perf'],
  ['focus', '#/focus'],
  ['todos', '#/todos'],
  ['nutrition-adjust', '#/nutrition/adjust'],
  ['nutrition-foods', '#/nutrition/foods'],
  ['nutrition-recipes', '#/nutrition/recipes'],
  ['program', '#/program'],
  ['program-wrapup', '#/program/wrapup/1'],
  ['sports-plans', '#/sports/plans'],
  ['sports-plan-detail', '#/sports/plans/1'],
  ['sports-plan-edit', '#/sports/plans/1/edit'],
  ['sports-exercises', '#/sports/exercises'],
  ['sports-records', '#/sports/records'],
  ['campus-schedule', '#/campus/schedule'],
  ['campus-settings', '#/campus/settings'],
  ['campus-program', '#/campus/program'],
  ['campus-course-select', '#/campus/course-select'],
  ['campus-grab-tasks', '#/campus/grab-tasks'],
  ['record', '#/record'],
  ['voice-layouts', '#/voice-layouts'],
  ['run', '#/session/run'],
]
const OUT = new URL('../.tmp-ui-shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

let ws
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function viewport(width, height, mobile) {
  await cdp('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile,
  })
  await sleep(350)
}

async function shot(name) {
  await sleep(600)
  const r = await cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: FULL,
  })
  writeFileSync(`${OUT}${PREFIX}-${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`  ✓ ${PREFIX}-${name}.png`)
}

/** 等待某页 h1 出现（走 hash 路由，避开过渡卡死） */
async function go(hash, h1) {
  await cdp('Runtime.evaluate', { expression: `location.hash = '${hash}'` })
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    await sleep(300)
    const got = await evalJS('document.querySelector("h1")?.textContent ?? ""')
    if (got.includes(h1)) return
  }
  console.log(`  ! 等待 ${hash} 超时（h1=${await evalJS('document.querySelector("h1")?.textContent') ?? '无'}）`)
}

/** 关掉浏览器 mock 下弹出的「发现新版本」假升级弹窗，别让它挡住截图 */
async function dismissUpdateDialog() {
  await evalJS(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => ['稍后','跳过此版本'].includes(b.textContent.trim()))
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await sleep(400)
}

/** 等待 hash 落地（ALL 模式不校验 h1 文案，各页标题不同） */
async function goHash(hash) {
  await cdp('Runtime.evaluate', { expression: `location.hash = '${hash}'` })
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    await sleep(300)
    const got = await evalJS('location.hash')
    if (String(got).endsWith(hash.replace('#', '')) || String(got) === hash || String(got) === `${hash}/`) return
  }
  console.log(`  ! 等待 ${hash} 超时`)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
    const target = await res.json()
    await sleep(300)
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        p.resolve(m.result ?? m.error)
      }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    if (DARK) {
      await cdp('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      })
    }
    await cdp('Page.startScreencast', { format: 'jpeg', everyNthFrame: 1 }).catch(() => undefined)
    await cdp('Page.navigate', { url: `${APP}/#/` })
    await sleep(2500)
    // FEATURES_JSON='{"campus-grab":true}'：需要开启默认关闭的功能模块时先写开关再重载
    if (process.env.FEATURES_JSON) {
      await evalJS(`localStorage.setItem('rein.features.v1', ${JSON.stringify(process.env.FEATURES_JSON)})`)
      await cdp('Page.reload')
      await sleep(2200)
    }
    // PERF=extreme：把液态玻璃钉在某一档上再拍（材质随档位变，截图必须可复现）
    if (PERF) {
      await evalJS(`localStorage.setItem('rein.perf.v1', ${JSON.stringify(PERF)})`)
      await cdp('Page.reload')
      await sleep(2200)
    }
    await dismissUpdateDialog()

    /* ---------- ALL 模式：全路由 × 两端整页图 ---------- */
    if (ALL) {
      for (const vp of [[1440, 900, false, 'desk'], [430, 932, true, 'mob']]) {
        const [w, h, mobile, tag] = vp
        await viewport(w, h, mobile)
        await dismissUpdateDialog()
        for (const [name, hash] of ROUTES) {
          await goHash(hash)
          await shot(`${tag}-${name}`)
        }
      }
      console.log('完成')
      return
    }

    /* ---------- 桌面（工作台壳） ---------- */
    await viewport(1440, 900, false)
    await evalJS(`localStorage.setItem('rein.homeView.v1','bento')`)
    await cdp('Page.reload')
    await sleep(2500)
    await dismissUpdateDialog()
    await shot('desk-bento')
    await evalJS(`localStorage.setItem('rein.homeView.v1','spine')`)
    await cdp('Page.reload')
    await sleep(2200)
    await dismissUpdateDialog()
    await shot('desk-spine')
    await go('#/nutrition', '营养')
    await shot('desk-nutrition')
    await go('#/ledger', '记账')
    await shot('desk-ledger')
    await go('#/todos', '待办')
    await shot('desk-todos')

    /* ---------- 移动（430×932） ---------- */
    await viewport(430, 932, true)
    await go('#/', '今天')
    await shot('mob-home-top')
    // 滚到收尾区（textlinks + 工具卡）
    await evalJS(`window.scrollTo(0, document.body.scrollHeight)`)
    await shot('mob-home-end')
    await go('#/nutrition', '营养')
    await shot('mob-nutrition')
    await go('#/ledger', '记账')
    await shot('mob-ledger')

    console.log('完成')
  } finally {
    try { ws?.close() } catch { /* 已断开 */ }
    edge.kill()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
