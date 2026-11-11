/* 验证：运动浮条修复后行为（mock + Edge headless）。
 * A 窄屏 bar：垂直 1:1 跟手（逐采样 delta 一致）、水平锁死不横跳、释放 settle 进槽位、
 *   停底时浮条底与 Dock 上缘留 12（两行 Dock 的悬浮距 --dock-float 必须计进让位）
 * D 点按按钮不误触（点击=暂停/继续切换，不触发拖拽）
 * C 横向轻弹 → 右泊车 blob */
import { chromium } from 'playwright-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 与其它 e2e 同一条约定：默认共享 dev（1420）；端口被系统排除或并发会话时指向独立实例 */
const BASE = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:1420'
/** 与 useDragDock 同值：停底距 Dock 上缘 / 侧边距安全区的呼吸边距 */
const EDGE_GAP = 12
/** 泊车方块边长 64（BLOB_SIZE）的一半 */
const BLOB_HALF = 32

const SESSION = [
  {
    id: 999,
    planId: '__run__',
    planName: '户外跑',
    status: 'active',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exIndex: 0,
    setIndex: 1,
    weightKg: 0,
    elapsedSec: 0,
    state: {
      kind: 'run',
      phase: 'paused',
      goalKind: 'open',
      goalTimeMin: 30,
      goalDistanceKm: 5,
      accumMs: 0,
      segStartedAt: null,
      distanceM: 0,
      points: [],
    },
  },
]

let failed = 0
function ok(name, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failed++
}

async function centerOf(page) {
  const r = await page.locator('.dock-pos').boundingBox()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/**
 * 停底槽位的几何契约（2026-11 修复「浮条扎进 Dock」）：
 *
 *   浮条底边 = --dock-top 解析出的 Dock 玻璃上缘 − EDGE_GAP(12)
 *
 * --dock-top 是全应用唯一的底部让位口径（安全区 + Dock 悬浮距 --dock-float + Dock 高，
 * 输入行显隐由 html[data-dock-quick] 改写）。测试不再手抄 --tabbar-h 拼公式 ——
 * 恰恰是手抄漏了 --dock-float 那 16px，浮条才与两行 Dock 叠在一起。
 * `realGap` 同时量真实 `.dock` 的 rect：移动壳里它必须也是 12（桌面壳无 TabBar 时为 null）。
 */
async function slotGeometry(page) {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;left:0;top:auto;right:auto;bottom:var(--dock-top);width:0;height:0;visibility:hidden;pointer-events:none'
    document.documentElement.appendChild(probe)
    const dockTopInset = window.innerHeight - probe.getBoundingClientRect().top
    probe.remove()
    const bar = document.querySelector('.dock-pos').getBoundingClientRect()
    const dock = document.querySelector('nav.dock')?.getBoundingClientRect() ?? null
    return {
      vh: window.innerHeight,
      dockTopInset,
      barBottom: bar.bottom,
      realGap: dock ? dock.top - bar.bottom : null,
      bottomCenterY: window.innerHeight - dockTopInset - 12 - bar.height / 2,
    }
  })
}

/**
 * 关掉「有新版本」启动提示卡。
 *
 * mock 会在加载一两秒后弹出它，而它带**全屏遮罩**（`.up-backdrop`）——
 * 盖上来之后浮条的横竖拖拽与按钮点按全都落在遮罩上，表现是「怎么点都没反应」，
 * 一路查下来全是它在捣鬼（探针里 `elementFromPoint` 直接命中的就是 up-backdrop）。
 * 每次交互前关一次，没弹就什么也不做。
 */
async function dismissUpdate(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('.up-card button')].find((x) => x.textContent.trim() === '稍后')
    if (b) b.click()
    return !!b
  })
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })

/* ---------- 窄屏 420x820 ---------- */
const page = await browser.newPage({ viewport: { width: 420, height: 820 } })
await page.addInitScript(
  (sess) => {
    if (localStorage.getItem('rein.mock.sessions.v1') == null)
      localStorage.setItem('rein.mock.sessions.v1', JSON.stringify(sess))
  },
  SESSION,
)
await page.goto(`${BASE}/#/`)
await page.waitForSelector('.wdock-root', { state: 'attached' })
await page.waitForTimeout(1400) // 等静默更新检查把提示卡弹出来（早关会扑空）
await dismissUpdate(page)
await page.waitForTimeout(300)

let c = await centerOf(page)
const g0 = await slotGeometry(page)
ok(
  'A1 冷启动落位底部居中',
  Math.abs(c.x - 210) < 2 && Math.abs(c.y - g0.bottomCenterY) < 2,
  `实际 ${JSON.stringify(c)} 期望 y=${g0.bottomCenterY.toFixed(1)}`,
)
ok(
  'A1b 浮条底边与 Dock 上缘留 12px（不扎进 Dock）',
  g0.realGap !== null && Math.abs(g0.realGap - 12) < 1.5,
  `gap=${g0.realGap === null ? '无 Dock' : g0.realGap.toFixed(1)}`,
)

/* A1c：输入行聚焦 → 页签行收起（data-dock-quick='input'），Dock 变矮 —— 浮条必须
   跟着 observer 重落位。--dock-top 的 input 口径比真实玻璃底少 2px 描边，容差放到 16。 */
await page.locator('.dock-quick textarea').first().focus()
await page.waitForTimeout(500)
const gTyping = await slotGeometry(page)
ok(
  'A1c 输入中 Dock 变矮后浮条跟随（不扎进 Dock）',
  gTyping.realGap !== null && gTyping.realGap > 8 && gTyping.realGap < 16,
  `gap=${gTyping.realGap === null ? '无 Dock' : gTyping.realGap.toFixed(1)}`,
)
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.waitForTimeout(500)

/* D：点按主按钮（“继续”→点击→“暂停”）——点击必须不被拖拽吞掉 */
const btn = page.locator('.abtn.main')
const dBefore = (await btn.textContent())?.trim()
const bb = await btn.boundingBox()
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(300)
const dAfter = (await btn.textContent())?.trim()
ok('D1 按钮点按生效（继续↔暂停）', dBefore === '继续' && dAfter === '暂停', `${dBefore} → ${dAfter}`)
// 点回暂停态，保持后续场景与原种子一致
await btn.click()
await page.waitForTimeout(300)
ok('D2 再点恢复暂停态', (await btn.textContent())?.trim() === '继续')

/* A2：垂直拖拽，逐采样检查与手指 1:1（用相邻采样 delta 比较，免抓取偏移干扰） */
c = await centerOf(page)
{
  const seq = []
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    const y = c.y - i * 25
    await page.mouse.move(c.x, y, { steps: 2 })
    const r = await page.locator('.dock-pos').boundingBox()
    seq.push({ f: y, c: r.y + r.height / 2 })
  }
  await page.mouse.up()
  let okLag = true
  let worst = 0
  for (let i = 1; i < seq.length; i++) {
    const deltaC = seq[i].c - seq[i - 1].c
    const deltaF = seq[i].f - seq[i - 1].f
    worst = Math.max(worst, Math.abs(deltaC - deltaF))
    if (Math.abs(deltaC - deltaF) > 1.5) okLag = false
  }
  ok('A2 垂直拖拽逐采样 1:1 跟手', okLag, `worst=${worst.toFixed(2)}px`)
  const r = await page.locator('.dock-pos').boundingBox()
  const x = r.x + r.width / 2
  ok('A2b 水平轴锁死（条宽近整屏无余量）', Math.abs(x - 210) < 1, `x=${x.toFixed(1)}`)
}
await page.waitForTimeout(900)
c = await centerOf(page)
const g3 = await slotGeometry(page)
ok(
  'A3 慢速松手 settle 进槽位（顶或底居中）',
  Math.abs(c.x - 210) < 2 &&
    (Math.abs(c.y - 42.5) < 6 || Math.abs(c.y - g3.bottomCenterY) < 6),
  JSON.stringify(c),
)

/* A4：水平快速轻弹 → 右泊车 blob（速度解算仍可用，y 沿用当前位置对应的侧档）。
   侧停靠的竖向范围 = 安全顶 +（方块半宽 32 + EDGE_GAP 12）…  Dock 上缘 − 44：
   从底部起手横向轻弹时落到范围下沿。 */
const afterA3 = c
const sideYExpect =
  afterA3.y < 100 ? 44 : g3.vh - g3.dockTopInset - (BLOB_HALF + EDGE_GAP)
await page.mouse.move(c.x, c.y)
await page.mouse.down()
await page.mouse.move(c.x + 130, c.y, { steps: 5 })
await page.waitForTimeout(50)
await page.mouse.up()
await page.waitForTimeout(900)
c = await centerOf(page)
ok(
  'A4 横向轻弹进入右泊车 blob',
  Math.abs(c.x - 368) < 5 && Math.abs(c.y - sideYExpect) < 10,
  `期望 (368,${sideYExpect}) 实际 ${JSON.stringify(c)}`,
)

/* A5：blob 拖拽跟手（非退化轴；逐采样 delta 验证） */
{
  const seq = []
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  for (const [dx, dy] of [
    [-40, 90],
    [-80, 180],
    [-120, 250],
  ]) {
    await page.mouse.move(c.x + dx, c.y + dy, { steps: 2 })
    const r = await page.locator('.dock-pos').boundingBox()
    seq.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, tf: await page.locator('.dock-pos').evaluate((el) => el.style.transform) })
  }
  await page.mouse.up()
  let okFollow = true
  let worst = 0
  const seg = [
    [-40, 90],
    [-40, 70],
  ]
  for (let i = 1; i < seq.length; i++) {
    const dd = Math.hypot(
      seq[i].x - seq[i - 1].x - seg[i - 1][0],
      seq[i].y - seq[i - 1].y - seg[i - 1][1],
    )
    worst = Math.max(worst, dd)
    if (dd > 3) okFollow = false
  }
  ok('A5 blob 拖拽逐采样 1:1 跟手', okFollow, `worst=${worst.toFixed(2)}px`)
}
await page.waitForTimeout(900)
c = await centerOf(page)
const g6 = await slotGeometry(page)
const slots = [
  { x: 210, y: g6.bottomCenterY },
  { x: 210, y: 42.5 },
  { x: 52, y: 44 },
  { x: 368, y: 44 },
]
const dSlot = Math.min(...slots.map((s) => Math.hypot(c.x - s.x, c.y - s.y)))
ok('A6 blob 松手回槽位', dSlot < 12, `距最近槽位 ${dSlot.toFixed(1)}px：${JSON.stringify(c)}`)

/* ---------- 宽屏 1440x900：bar 456px 宽，x 轴非退化 ---------- */
{
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page2.addInitScript(
    (sess) => {
      if (localStorage.getItem('rein.mock.sessions.v1') == null)
        localStorage.setItem('rein.mock.sessions.v1', JSON.stringify(sess))
    },
    SESSION,
  )
  await page2.goto(`${BASE}/#/`)
  await page2.waitForSelector('.wdock-root', { state: 'attached' })
  await page2.waitForTimeout(1400)
  await dismissUpdate(page2)
  await page2.waitForTimeout(300)
  let d = await centerOf(page2)
  const gB = await slotGeometry(page2)
  ok(
    'B1 宽屏落位底部居中',
    Math.abs(d.x - 720) < 2 && Math.abs(d.y - gB.bottomCenterY) < 2,
    `实际 ${JSON.stringify(d)} 期望 y=${gB.bottomCenterY.toFixed(1)}`,
  )
  const seq = []
  await page2.mouse.move(d.x, d.y)
  await page2.mouse.down()
  for (let i = 1; i <= 5; i++) {
    await page2.mouse.move(d.x + i * 50, d.y, { steps: 2 })
    const r = await page2.locator('.dock-pos').boundingBox()
    seq.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  }
  await page2.mouse.up()
  let okWide = true
  let worst = 0
  for (let i = 1; i < seq.length; i++) {
    const dd = Math.hypot(seq[i].x - seq[i - 1].x - 50, seq[i].y - seq[i - 1].y)
    worst = Math.max(worst, dd)
    if (dd > 3) okWide = false
  }
  ok('B2 宽屏水平拖拽 1:1 跟手', okWide, `worst=${worst.toFixed(2)}px`)
  await page2.waitForTimeout(900)
  d = await centerOf(page2)
  const gB3 = await slotGeometry(page2)
  const sideY = gB3.vh - gB3.dockTopInset - (BLOB_HALF + EDGE_GAP)
  const slots2 = [
    { x: 720, y: gB3.bottomCenterY },
    { x: 720, y: 42.5 },
    { x: 52, y: sideY },
    { x: 1388, y: sideY },
  ]
  const dSlot2 = Math.min(...slots2.map((s) => Math.hypot(d.x - s.x, d.y - s.y)))
  ok('B3 宽屏松手回槽位', dSlot2 < 12, `距最近槽位 ${dSlot2.toFixed(1)}px：${JSON.stringify(d)}`)
  await page2.close()
}

await browser.close()
console.log(failed === 0 ? '== 全部通过 ==' : `== 失败 ${failed} 项 ==`)
process.exit(failed === 0 ? 0 : 1)
