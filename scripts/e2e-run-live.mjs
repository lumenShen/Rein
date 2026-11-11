/**
 * 跑步进行中页面 · UI 专项 E2E（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 *
 * 运行：node scripts/e2e-run.mjs scripts/e2e-run-live.mjs
 *   （前置：浏览器 mock 模式，REIN_E2E_URL 指向 vite dev server）
 *
 * 钉住 2026-11 这一轮界面改动的六件事（全部可在 DOM 上复核）：
 *  1 左上角不再有心率 / GPS / 后台对账 chip（页头只剩「收起」，状态不重复上屏）；
 *  2 卫星状态是把手行**左端**的一枚图标（与内容列同线），四档 class 之一；
 *  3 底部四栏收成三栏（时长 / 平均配速 / 消耗），心率整行独占下方；
 *  4 心率条：圆角 SVG 三角 + mask 缺口（mask-image 含 SVG、composite=exclude）；
 *  5 分段控件是胶囊材质：实色灰轨道 + --surface 滑块（丰富档 GlassThumb blob /
 *    默认档 .mthumb），两种动效档都必须有选中底；
 *  6 轨迹上有行进方向箭头（≤8 枚，落在可见窗口内）。
 *
 * 合成轨迹不走真实 GPS（自动化造不出来）：注入一条已知形状的 31 点折线，
 * 走 session_start + hydrateFromServer 的正规恢复路径。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1430'
const USER_DATA = `${process.env.TEMP}/rein-e2e-run-live-${Date.now()}`
const OUT = 'docs/shots'

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

let DEBUG_PORT = 9340
let ws
let msgId = 0
const pending = new Map()
const results = []

function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    const head = expression.slice(0, 300).replace(/\n/g, '\\n')
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.text) + '\n--- 表达式 ---\n' + head)
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 12000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

async function injectStableCSS() {
  await evalJS(`(() => {
    let s = document.getElementById('__e2e-stable')
    if (!s) {
      s = document.createElement('style')
      s.id = '__e2e-stable'
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
      document.head.appendChild(s)
    }
    return true
  })()`)
}

async function shoot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`  截图 → ${OUT}/${name}.png`)
}

/** 31 点、~350m 的 S 形折线 + 进行中的跑步会话（恢复路径与中断续跑同一条） */
const INJECT = `(async () => {
  const { invoke } = await import('/src/services/transport.ts')
  const { useRunStore } = await import('/src/stores/run.ts')
  const LAT = 31.23
  const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180)
  const points = []
  for (let i = 0; i <= 30; i++) {
    const x = i * 12
    const y = Math.round(Math.sin(i / 4) * 30)
    points.push({
      lat: LAT + y / 111320,
      lon: 121.47 + x / M_PER_DEG_LON,
      t: i * 3000,
      alt: 100,
    })
  }
  const rec = await invoke('session_start', {
    planId: '__run__',
    planName: '跑步',
    startedAt: new Date(Date.now() - 96_000).toISOString(),
    stateJson: {
      kind: 'run',
      phase: 'running',
      goalKind: 'open',
      goalTimeMin: 30,
      goalDistanceKm: 5,
      accumMs: 96_000,
      segStartedAt: null,
      distanceM: 350,
      points,
    },
  })
  const r = useRunStore()
  await r.hydrateFromServer()
  return { recId: rec.id, phase: r.phase, pts: r.trackPoints.length, km: r.km, sec: r.elapsedSec }
})()`

/** 页面事实一次性取回（避免断言之间状态漂移） */
const FACTS = `(async () => {
  const { useHeartRateStore } = await import('/src/stores/heartRate.ts')
  const hr = useHeartRateStore()
  const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } : null }
  const pace = document.querySelector('.pace')
  const livehr = document.querySelector('.livehr')
  const livehrMeter = livehr?.querySelector('.hzm')
  const bar = document.querySelector('.livehr .hzb')
  const track = bar?.querySelector('.hzb-track')
  const marker = bar?.querySelector('.hzb-marker')
  const drawer = document.querySelector('.drawer')
  const ctl = document.querySelector('.ctl')
  const pane = document.querySelector('.pane.live')
  const shead = document.querySelector('.shead')
  const sat = document.querySelector('.handle .sat')
  const satRect = sat?.getBoundingClientRect()
  const grab = document.querySelector('.handle .grab')
  const grabRect = grab?.getBoundingClientRect()
  const mseg = document.querySelector('.mseg')
  const msegCs = mseg ? getComputedStyle(mseg) : null
  const drawerCs = drawer ? getComputedStyle(drawer) : null
  const msegSel = document.querySelector('.mseg .seg-item.on')
  const blob = document.querySelector('.mseg .gthumb .blob') ?? document.querySelector('.mseg .mthumb')
  const blobCs = blob ? getComputedStyle(blob) : null
  const trackCs = track ? getComputedStyle(track) : null
  const markerRect = marker?.getBoundingClientRect()
  const barRect = bar?.getBoundingClientRect()
  const p = hr.bpm != null && hr.maxHr ? Math.min(1, Math.max(0, (hr.bpm / hr.maxHr - 0.5) / 0.5)) : null
  const arrows = [...document.querySelectorAll('.route-arrow')]
  return {
    phase: document.querySelector('.run-page')?.className ?? '',
    hudHr: document.querySelectorAll('.hud .hr').length,
    hudGps: document.querySelectorAll('.hud .gps').length,
    hudStat: document.querySelectorAll('.hud .stat').length,
    sheadTitle: document.querySelectorAll('.shead .ptitle').length,
    sheadButtons: document.querySelectorAll('.shead button').length,
    satClass: sat?.className ?? null,
    satLabel: sat?.getAttribute('aria-label') ?? null,
    satRect: rect(sat),
    grabRect: grabRect ? { x: grabRect.x, y: grabRect.y, w: grabRect.width, h: grabRect.height } : null,
    msegRect: mseg ? rect(mseg) : null,
    msegTrackBg: msegCs?.backgroundColor ?? null,
    msegTrackRadius: msegCs?.borderRadius ?? null,
    drawerBg: drawerCs?.backgroundColor ?? null,
    paceCols: pace ? pace.querySelectorAll(':scope > div').length : 0,
    paceRect: rect(pace),
    livehrRect: rect(livehr),
    livehrHasMeter: !!livehrMeter,
    livehrHasBar: !!livehr?.querySelector('.hzb'),
    livehrParts: {
      hzm: rect(livehrMeter),
      head: rect(livehr?.querySelector('.hzm-head')),
      bar: rect(livehr?.querySelector('.hzb')),
    },
    hrSupported: hr.supported,
    hrConnected: hr.connected,
    hrBpm: hr.bpm,
    hrMax: hr.maxHr,
    hrZone: hr.zone,
    hzbDim: bar?.classList.contains('dim') ?? null,
    markerSvg: marker?.tagName?.toLowerCase() ?? null,
    maskImage: trackCs ? (trackCs.maskImage || trackCs.webkitMaskImage) : null,
    maskComposite: trackCs ? (trackCs.maskComposite || trackCs.webkitMaskComposite) : null,
    maskSize: trackCs ? trackCs.maskSize : null,
    markerCenter: markerRect && barRect ? markerRect.x + markerRect.width / 2 : null,
    barLeft: barRect?.x ?? null,
    barWidth: barRect?.width ?? null,
    expectedCenter: barRect && p != null ? barRect.x + p * barRect.width : null,
    msegSelectedBg: blobCs?.backgroundColor ?? (msegSel ? getComputedStyle(msegSel).backgroundColor : null),
    msegThumbRadius: blobCs?.borderRadius ?? null,
    msegGoo: !!document.querySelector('.mseg.goo'),
    arrowCount: arrows.length,
    arrowRects: arrows.map(rect),
    drawerRect: rect(drawer),
    ctlRect: rect(ctl),
    sheadRect: rect(shead),
    paneScroll: pane ? { client: pane.clientHeight, scroll: pane.scrollHeight } : null,
    viewport: { w: innerWidth, h: innerHeight },
  }
})()`

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1400)
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
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 430, height: 932, deviceScaleFactor: 2, mobile: true,
    })
    // 真定位注入：web 采集路径会自己写 lastFixAt，卫星档位不再靠直写 store
    try {
      const origin = new URL(APP).origin
      await cdp('Browser.grantPermissions', { permissions: ['geolocation'], origin })
      await cdp('Emulation.setGeolocationOverride', {
        latitude: 31.23, longitude: 121.47, accuracy: 6,
      })
    } catch (e) {
      console.log('  ⚠ 定位注入不可用，稍后回退到直写 lastFixAt:', e?.message ?? e)
    }
    await cdp('Page.navigate', { url: `${APP}/#/session/run` })
    await sleep(3000)
    await injectStableCSS()

    // 清残留会话（否则 hydrateFromServer 会把上一次的跑步恢复回来）
    await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      for (let i = 0; i < 5; i++) {
        const rec = await invoke('session_active')
        if (!rec) break
        await invoke('session_abort', { id: rec.id })
      }
      return true
    })()`)
    await cdp('Page.reload')
    await sleep(3000)
    await injectStableCSS()
    // 等页面自己的 onMounted 走完（refreshTrackStatus 最长 2s + whenReady）：
    // 提前注入会和它的 hydrateFromServer 撞车，把 runStartedAt/lastFixAt 重置掉。
    await waitFor(`document.querySelector('.gobtn')`, 15000, '准备页就绪')
    await sleep(500)
    // 浏览器 mock 会弹「发现新版本」：走真实 UI 点「稍后」，否则它会盖住截图与点击
    await evalJS(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === '稍后') { b.click(); return true }
      }
      return false
    })()`)
    await sleep(300)

    /* ---------- 注入进行中的跑步会话 ---------- */
    const injected = await evalJS(INJECT)
    console.log('  注入:', JSON.stringify(injected))
    ok('L1 会话恢复且处于进行中', injected.phase === 'running' || injected.phase === 'paused', JSON.stringify(injected))
    ok('L2 轨迹 31 点已恢复', injected.pts === 31, String(injected.pts))

    await waitFor(`document.querySelector('.pane.live')`, 10000, '跑步进行中面板')
    await waitFor(`document.querySelector('.route')`, 10000, '轨迹描线')
    // beginWorkout 的 hr_workout_start 是异步的，会把 mock profile 写成空；
    // 等它落地后再补年龄 → maxHr，下一次 1Hz 轮询就能让条带出实时样本。
    await sleep(1200)
    await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      await invoke('hr_set_profile', { ageYears: 30, sex: 'male', weightKg: 70 })
      return true
    })()`)
    // 定位兜底：上面注入了真实 geolocation，无头环境若没吐点，就把落点摆到当下
    const gps = await evalJS(`(async () => {
      const { useRunStore } = await import('/src/stores/run.ts')
      const r = useRunStore()
      if (!r.lastFixAt || Date.now() - r.lastFixAt > 3000) {
        r.lastFixAt = Date.now()
        r.lastFixAccM = 6
      }
      return { fix: r.lastFixAt, acc: r.lastFixAccM }
    })()`)
    console.log('  GPS:', JSON.stringify(gps))
    // 心率 mock 是 1Hz 轮询：等它把 connected/bpm/maxHr 送到 store
    try {
      await waitFor(`document.querySelector('.livehr .hzb:not(.dim)')`, 8000, '心率条有实时样本')
    } catch {
      console.log('  ⚠ 心率 mock 未在 8s 内给出实时样本，相关断言按未连接处理')
    }
    await sleep(400)
    // 更新弹窗可能在注入后再次出现（版本探测是异步的）：截图/断言前再关一次
    await evalJS(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === '稍后') { b.click(); return true }
      }
      return false
    })()`)
    // 「已接续上次跑步」toast 会压住三列卡的读数：等它退场再截图
    try {
      await waitFor(`!document.querySelector('.toast')`, 6000, 'toast 退场')
    } catch {
      /* 没有 toast 或退场超时都不影响断言 */
    }
    await sleep(300)

    const f = await evalJS(FACTS)
    console.log('  事实:', JSON.stringify(f, null, 2))

    /* ---------- 1. 左上角状态不重复上屏 ---------- */
    ok('R1a 左上角没有心率 chip', f.hudHr === 0, String(f.hudHr))
    ok('R1b 左上角没有 GPS 文字 chip', f.hudGps === 0, String(f.hudGps))
    // 2026-11-11：页头精简 —— 「跑步」标题与「后台对账」胶囊都撤了，只留「收起」。
    // 后台状态由系统通知/前台服务承担，屏幕上不再重复一遍。
    ok('R1c 左上角不再有后台对账胶囊', f.hudStat === 0, String(f.hudStat))
    ok('R1d 页头只剩「收起」（无标题）', f.sheadTitle === 0 && f.sheadButtons === 1, JSON.stringify({ title: f.sheadTitle, buttons: f.sheadButtons }))

    /* ---------- 2. 卫星图标：四档 class + 钉在把手行左端 ---------- */
    const satLevels = ['strong', 'good', 'weak', 'off']
    ok('R2a 卫星图标存在且档位合法', !!f.satClass && satLevels.some((k) => f.satClass.split(' ').includes(k)), String(f.satClass))
    ok('R2b 卫星档位是「强」（刚有落点 + ±6m）', (f.satClass ?? '').includes('strong'), String(f.satClass))
    ok('R2c 卫星有完整档位说明', /卫星(强|优|弱|未连接)/.test(f.satLabel ?? ''), String(f.satLabel))
    // 左端 = 与内容列（三栏卡左边界）同一条竖线 ±2；且在拖拽条左侧 —— 旧稿贴着横条左侧，
    // 行左半边整片空着。这两条把「左状态 · 中把手 · 右控件」的构图钉住。
    const satAligned = f.satRect && f.paceRect && Math.abs(f.satRect.x - f.paceRect.x) <= 2
    ok('R2d 卫星与内容列左边线对齐', !!satAligned, JSON.stringify({ sat: f.satRect, content: f.paceRect }))
    const satLeftOfGrab = f.satRect && f.grabRect && f.satRect.right < f.grabRect.x
    ok('R2e 卫星在拖拽条左侧', !!satLeftOfGrab, JSON.stringify({ sat: f.satRect, grab: f.grabRect }))

    /* ---------- 3. 三栏 + 心率整行 ---------- */
    ok('R3a 底部指标卡正好三栏', f.paceCols === 3, String(f.paceCols))
    ok('R3b 心率整行复用区间组件（读数+条带）', f.livehrHasMeter === true && f.livehrHasBar === true, JSON.stringify({ meter: f.livehrHasMeter, bar: f.livehrHasBar }))
    const sameLeft = f.paceRect && f.livehrRect && Math.abs(f.paceRect.x - f.livehrRect.x) <= 1
    const sameRight = f.paceRect && f.livehrRect && Math.abs(f.paceRect.right - f.livehrRect.right) <= 1
    ok('R3c 心率卡与三栏卡同宽同位', !!sameLeft && !!sameRight, JSON.stringify({ pace: f.paceRect, hr: f.livehrRect }))
    ok('R3d 心率卡在三栏卡下方', !!f.livehrRect && !!f.paceRect && f.livehrRect.y >= f.paceRect.bottom - 1, JSON.stringify({ hrY: f.livehrRect?.y, paceBottom: f.paceRect?.bottom }))

    /* ---------- 4. 圆角三角 + mask 缺口 ---------- */
    ok('R4a 指示器是 SVG（圆角路径）', f.markerSvg === 'svg', String(f.markerSvg))
    ok('R4b 条带挂了 SVG mask', !!f.maskImage && f.maskImage.includes('data:image/svg+xml'), String(f.maskImage ?? '').slice(0, 80))
    ok('R4c mask 用 exclude 合成（挖洞）', String(f.maskComposite).includes('exclude') || String(f.maskComposite).includes('xor'), String(f.maskComposite))
    const centerOk = f.markerCenter != null && f.expectedCenter != null && Math.abs(f.markerCenter - f.expectedCenter) <= 2
    ok('R4d 缺口/三角落在当前心率位置', !!centerOk, JSON.stringify({ got: f.markerCenter, want: f.expectedCenter }))

    /* ---------- 5. 分段控件：实色灰轨道 + --surface 胶囊滑块 ---------- */
    const bg = String(f.msegSelectedBg ?? '')
    const transparent = /rgba\(0, 0, 0, 0\)|transparent/.test(bg)
    ok('R5a 选中段有底色（非透明）', !!bg && !transparent, bg.slice(0, 80))
    // 材料要能读出来：轨道是实色、且与抽屉底不同（旧稿用玻璃当轨道，亮色档只剩一圈阴影）
    const trackBg = String(f.msegTrackBg ?? '')
    ok(
      'R5c 轨道是实色灰、与抽屉底不同',
      /^rgb\(/.test(trackBg) && trackBg !== String(f.drawerBg ?? ''),
      JSON.stringify({ track: trackBg, drawer: f.drawerBg, radius: f.msegTrackRadius }),
    )
    // 两种动效档（GlassThumb / .mthumb）都必须是实色滑块、胶囊圆角
    const capsule = (r) => String(r ?? '').startsWith('999') || parseFloat(r) >= 14
    ok(
      'R5d 滑块实色 + 胶囊圆角（与轨道同曲率）',
      /^rgb\(/.test(bg) && capsule(f.msegThumbRadius) && capsule(f.msegTrackRadius),
      JSON.stringify({ bg, thumb: f.msegThumbRadius, track: f.msegTrackRadius }),
    )

    /* ---------- 6. 轨迹方向箭头 ---------- */
    ok('R6a 有方向箭头且不超过 8 枚', f.arrowCount > 0 && f.arrowCount <= 8, String(f.arrowCount))
    const inWindow = (f.arrowRects ?? []).every(
      (r) => r && r.y >= (f.sheadRect?.bottom ?? 0) && r.bottom <= f.drawerRect.y,
    )
    ok('R6b 箭头都在抽屉上沿以上的轨迹区', inWindow, JSON.stringify(f.arrowRects?.[0] ?? null))

    /* ---------- 7. 布局：控制行没有被心率卡顶出抽屉 ---------- */
    const ctlVisible = !!f.ctlRect && !!f.drawerRect && f.ctlRect.bottom <= f.drawerRect.bottom + 1
    ok('R7a 暂停/继续按钮完整落在抽屉内', ctlVisible, JSON.stringify({ ctl: f.ctlRect, drawer: f.drawerRect }))
    // 面板允许滚动，但溢出只能来自底部那截内距（46px）；超过它说明内容把控制行顶走了
    const overflow = f.paneScroll ? f.paneScroll.scroll - f.paneScroll.client : 0
    ok('R7b 溢出不超过底部内距（没有内容被藏）', overflow <= 60, JSON.stringify({ ...f.paneScroll, overflow }))

    await shoot('run-live-light')

    /* ---------- 暗色：滑块仍是实色 --surface（近黑），轨道翻成浅一档的灰 ---------- */
    await cdp('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    await sleep(500)
    const dark = await evalJS(FACTS)
    const dbg = String(dark.msegSelectedBg ?? '')
    ok('R5b 暗色档滑块仍是实色', /^rgb\(/.test(dbg), dbg.slice(0, 80))
    ok(
      'R5e 暗色档轨道与抽屉底不同',
      /^rgb\(/.test(String(dark.msegTrackBg ?? '')) && dark.msegTrackBg !== dark.drawerBg,
      JSON.stringify({ track: dark.msegTrackBg, drawer: dark.drawerBg }),
    )
    await shoot('run-live-dark')

    const failed = results.filter((x) => !x.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length > 0) process.exitCode = 1
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    try { edge.kill() } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
