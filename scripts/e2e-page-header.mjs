/**
 * e2e-page-header —— 页面标题固定 + 渐进模糊遮罩 E2E（无头 Edge + 原生 CDP）
 *
 * 覆盖四件事：
 *   1 页头是 sticky（不是 fixed）：移动端贴文档顶，桌面壳里贴 .desk-main 顶，
 *     不会跑到导航轨 / 信息栏底下去
 *   2 未滚动时遮罩完全透明（顶部没有内容经过，不该出现任何底色）
 *   3 滚动后遮罩显形，且由多层 backdrop-filter + mask 梯度构成（渐进模糊）
 *   4 性能降级档（localStorage rein.perf.v1 = low）下不给 backdrop-filter，
 *     改铺「底色 → 透明」渐变；同时毛玻璃表面换成实底
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-page-header.mjs
 */
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-header-${Date.now()}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

let ws
let msgId = 0
const pending = new Map()
const loadWaiters = []

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 等一次真正的整页加载。超时返回 false（不抛——调用方自己有后续的挂载等待能报错） */
function waitLoad(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs)
    loadWaiters.push(() => {
      clearTimeout(t)
      resolve(true)
    })
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

async function shot(name) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return
  const file = `${process.env.TEMP}/rein-e2e-header-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
}

/** 页头背后铺一张高频条纹：糊掉之后条纹并成灰，像素能量随之骤降。
 *  放在 z-index 5——低于页头（30），高于页面内容，于是它正好落在模糊层的「背后」。 */
const STRIPES = `(() => {
  let el = document.getElementById('__e2e-stripes')
  if (!el) {
    el = document.createElement('div')
    el.id = '__e2e-stripes'
    el.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'height:260px',
      'z-index:5', 'pointer-events:none',
      'background:repeating-linear-gradient(to right, #000 0 4px, #fff 4px 8px)',
    ].join(';')
    document.body.appendChild(el)
  }
  return true
})()`

/** 一段区域的「边缘能量」= 相邻像素差的均值。清晰条纹 ≈ 190，糊掉 ≈ 3。
 *  ⚠️ CDP 的 clip 是**相对文档**的（实测：滚到 300 之后抓 y=0..40 得到的是文档顶部，
 *  不是视口顶部那个 fixed 元素）。所以这里整屏抓、在页内按**视口坐标**裁子区域来量。 */
async function bandEnergy(rect) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return -1
  return evalJS(`(async () => {
    const img = new Image()
    img.src = 'data:image/png;base64,${r.data}'
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const x0 = Math.max(0, ${Math.round(rect.x)})
    const y0 = Math.max(0, ${Math.round(rect.y)})
    const w = Math.min(${Math.round(rect.width)}, c.width - x0)
    const h = Math.min(${Math.round(rect.height)}, c.height - y0)
    if (w <= 1 || h <= 0) return -1
    const d = g.getImageData(x0, y0, w, h).data
    let sum = 0, n = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = (y * w + x) * 4
        sum += Math.abs(d[i] - d[i + 4]) + Math.abs(d[i + 1] - d[i + 5]) + Math.abs(d[i + 2] - d[i + 6])
        n++
      }
    }
    return n ? sum / n : -1
  })()`)
}

async function waitFor(expr, timeoutMs = 10000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 滚到页面中部；两种壳的滚动容器不同，按实际可滚的那个滚 */
const SCROLL_MID = `(() => {
  const main = document.querySelector('.desk-main')
  if (main && main.scrollHeight > main.clientHeight) {
    main.scrollTop = 320
    return { via: '.desk-main', top: main.scrollTop }
  }
  window.scrollTo(0, 320)
  return { via: 'window', top: window.scrollY }
})()`

const SCROLL_TOP = `(() => {
  const main = document.querySelector('.desk-main')
  if (main) main.scrollTop = 0
  window.scrollTo(0, 0)
  return true
})()`

/** 页头 + 遮罩的当下状态 */
const HEADER_STATE = `(() => {
  const h = document.querySelector('.page-header')
  if (!h) return { error: '没有 .page-header' }
  const cs = getComputedStyle(h)
  const hr = h.getBoundingClientRect()
  const mask = h.querySelector('.ph-mask')
  const mcs = mask ? getComputedStyle(mask) : null
  const mr = mask ? mask.getBoundingClientRect() : null
  // 只量真正的模糊层：.ph-mask 里还有一层 .ph-scrim（超高 / 极致档的底色垫层），
  // 它没有 backdrop-filter、opacity 也永远按自己的规则走，算进来会把层数与显隐判错
  const spans = mask ? [...mask.querySelectorAll('.pblur span')] : []
  const viewportTop = (() => {
    const main = document.querySelector('.desk-main')
    return main ? main.getBoundingClientRect().top : 0
  })()
  return {
    position: cs.position,
    zIndex: cs.zIndex,
    headerTop: Math.round(hr.top),
    headerHeight: Math.round(hr.height),
    headerLeft: Math.round(hr.left),
    headerRight: Math.round(hr.right),
    maskLeft: mr ? Math.round(mr.left) : null,
    maskRight: mr ? Math.round(mr.right) : null,
    maskBottom: mr ? Math.round(mr.bottom) : null,
    maskTail: mr ? Math.round(mr.bottom - hr.bottom) : null,
    viewportTop: Math.round(viewportTop),
    scrollInfo: (() => {
      const main = document.querySelector('.desk-main')
      const el = main ?? document.scrollingElement
      return {
        sel: main ? '.desk-main' : 'document',
        top: Math.round(el.scrollTop),
        h: el.scrollHeight,
        c: el.clientHeight,
        winY: Math.round(window.scrollY),
      }
    })(),
    scrolledClass: h.classList.contains('scrolled'),
    liteClass: h.classList.contains('lite'),
    maskOpacity: mcs ? mcs.opacity : null,
    maskBg: mcs ? mcs.backgroundImage.slice(0, 60) : null,
    layerCount: spans.length,
    /** 模糊层自身的 opacity：高画质档的显隐挂在这里（挂容器上是空转，见 ProgressiveBlur） */
    spanOpacity: spans[0] ? getComputedStyle(spans[0]).opacity : null,
    layerBlur: spans[0] ? getComputedStyle(spans[0]).backdropFilter : null,
    layerMask: spans[0] ? getComputedStyle(spans[0]).maskImage.slice(0, 70) : null,
    perfAttr: document.documentElement.dataset.perf ?? '(未设)',
    tabbarBg: (() => {
      const t = document.querySelector('.dock')
      if (!t) return '(无 TabBar)'
      const cs = getComputedStyle(t)
      // 底栏的底色是**两层渐变**画的（padding-box 实底 + border-box 受光描边），
      // 所以 backgroundColor 恒为 transparent —— 要看的是 background-image 里那层底色。
      // 描边那一层本来就是半透明发丝线，别把它算进来
      return cs.backgroundImage.split('),').slice(0, 2).join('),').slice(0, 120)
    })(),
    /** 玻璃填充变量：低档下被顶成 --surface（不透明），加强档下是半透明的 */
    glassFill: getComputedStyle(document.documentElement).getPropertyValue('--glass-fill').trim(),
  }
})()`

async function connect(debugPort, url, seedScript) {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  await sleep(300)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      p.resolve(m.result ?? m.error)
      return
    }
    if (m.method === 'Page.loadEventFired') loadWaiters.splice(0).forEach((fn) => fn())
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  // 异常收集器跟着每次整页加载重装：后面有多轮 reload，只 eval 一次会在重载后失效
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
addEventListener('error', (e) => window.__errs.push(String(e.message)));
addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));`,
  })
  if (seedScript) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: seedScript })
  const loaded = waitLoad()
  await cdp('Page.navigate', { url })
  await loaded
  await waitFor(`!!document.querySelector('.page-header')`, 15000, '页头挂载')
  await sleep(800)
}

/** 导航到目标路由；URL 与当前一致时走 reload，否则 Page.navigate 到新 URL。
 *  两种情况都等真正的 load 事件——只等 location.href 相等会在「同 URL 重载」时
 *  立刻返回，then 读到的是上一份文档的状态。 */
async function navigateTo(url) {
  const same = String(await evalJS('location.href')) === url
  const loaded = waitLoad()
  if (same) await cdp('Page.reload', { ignoreCache: true })
  else await cdp('Page.navigate', { url })
  await loaded
  await waitFor(`!!document.querySelector('.page-header')`, 15000, '页头挂载')
  await sleep(600)
}

async function main() {
  const debugPort = await freePort()
  /** 档位钉死：这些断言验的是遮罩怎么渲染，固定档位最稳 */
  const pinHigh = `localStorage.setItem('rein.perf.v1', 'high');`
  const pinLow = `localStorage.setItem('rein.perf.v1', 'low');`
  /** 抹掉本地档位 = 全新安装的样子（缺省时 loadMode() 回落到 high）—— 见下面的 22b */
  const clearPerf = `localStorage.removeItem('rein.perf.v1');`

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    await connect(debugPort, `${APP}/#/settings`, pinHigh)

    /* ---------- 1 移动端：sticky 且未滚动时遮罩透明 ---------- */
    await waitFor(`document.querySelector('h1')?.textContent === '设置'`, 10000, '设置页挂载')
    await evalJS(SCROLL_TOP)
    await sleep(300)
    let s = await evalJS(HEADER_STATE)
    ok('1 页头为 sticky（非 fixed）', s.position === 'sticky', `position=${s.position}`)
    ok('2 页头建立层叠上下文（z-index 非 auto）', s.zIndex !== 'auto', `z-index=${s.zIndex}`)
    ok('3 未滚动时模糊层不可见', s.spanOpacity === '0', `层 opacity=${s.spanOpacity}`)
    ok('4 未滚动时无 scrolled 类', !s.scrolledClass)
    ok('5 渐进模糊层已就位（5 层）', s.layerCount === 5, `层数=${s.layerCount}`)
    ok(
      '7 每层带 mask 梯度（限定纵向区间）',
      String(s.layerMask).includes('linear-gradient'),
      String(s.layerMask),
    )
    // 6 / 8（各层带 blur、模糊量递增）挪到滚动之后测：顶端静止时整条 backdrop-filter
    // 是**故意**摘掉的（性能修复：背后只有页面底色，糊与不糊像素相同）——在顶端取
    // 计算样式只会得到 none，那是设计不是缺陷。
    await shot('1-mobile-top')

    /* ---------- 2 滚动后：页头贴顶 + 遮罩显形 ---------- */
    const sc = await evalJS(SCROLL_MID)
    await sleep(500)
    s = await evalJS(HEADER_STATE)
    ok('9 滚动生效', sc.top > 0, `经 ${sc.via} 滚到 ${sc.top}`)
    ok('10 滚动后模糊层显形', s.spanOpacity === '1', `层 opacity=${s.spanOpacity}`)
    ok('11 滚动后挂上 scrolled 类', s.scrolledClass)
    // 6 / 8 在这里测（顶端是故意摘滤镜的，见上方注释）：滚动后各层必须真带 blur，且量递增
    const layerBlurs = await evalJS(
      `[...document.querySelectorAll('.ph-mask .pblur span')].map(s => getComputedStyle(s).backdropFilter)`,
    )
    ok(
      '6 滚动后每层带 backdrop-filter: blur',
      layerBlurs.every((b) => String(b).includes('blur')),
      layerBlurs.join(' | '),
    )
    ok(
      '8 各层模糊量递增（越靠上叠加越浓）',
      new Set(layerBlurs).size === layerBlurs.length && layerBlurs[0] !== layerBlurs[4],
      layerBlurs.join(' | '),
    )
    ok(
      '12 页头仍贴容器顶（未被滚走）',
      Math.abs(s.headerTop - s.viewportTop) <= 1,
      `headerTop=${s.headerTop} 容器顶=${s.viewportTop}`,
    )
    await shot('2-mobile-scrolled')

    /* ---------- 2b 像素级：模糊真的画出来了吗 ----------
       这是本页最要紧的一条。曾经的翻车：DOM 里 5 层俱在、backdrop-filter / mask 的计算样式
       全对（上面那些断言全绿），但容器上挂了 mask → 容器成了 backdrop root，层在容器内部
       采样（空无一物），屏幕上一片干净 —— 「样式正确、像素为空」。计算样式断言天生抓不到，
       必须量像素：在页头背后铺一张高频条纹，糊过之后条纹并成灰、边缘能量骤降。 */
    await evalJS(STRIPES)
    await evalJS(SCROLL_MID)
    await sleep(400)
    s = await evalJS(HEADER_STATE)
    await shot('2b-mobile-stripes')
    // 页头中部那一段（避开标题与按钮，取右侧空白列）：条纹在页头背后 → 必须被糊
    const blurred = await bandEnergy({ x: 150, y: s.headerTop + 8, width: 260, height: 18, scale: 1 })
    // 对照段：仍在条纹之内（条纹高 260px）、但在遮罩范围之外 → 条纹应保持清晰
    const sharp = await bandEnergy({ x: 150, y: 170, width: 260, height: 18, scale: 1 })
    ok(
      '12b 页头背后确实糊住了（像素级，糊掉=边缘能量骤降）',
      sharp > 60 && blurred < sharp * 0.25,
      `页头段=${blurred.toFixed(1)} 对照段=${sharp.toFixed(1)}`,
    )
    // 未滚动时遮罩整体不可见：同一段条纹必须是清晰的（反证下面的判据不是恒真）
    await evalJS(SCROLL_TOP)
    await sleep(500)
    const clear = await bandEnergy({ x: 150, y: 8, width: 260, height: 18, scale: 1 })
    ok(
      '12c 未滚动时同一段条纹未被糊（遮罩确实没在显示）',
      clear > 60,
      `未滚段=${clear.toFixed(1)}`,
    )
    await evalJS(`document.getElementById('__e2e-stripes')?.remove()`)
    await evalJS(SCROLL_MID)
    await sleep(300)

    /* ---------- 3 桌面壳：sticky 跟着 .desk-main ---------- */
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(800)
    await navigateTo(`${APP}/#/settings`)
    await evalJS(SCROLL_TOP)
    await sleep(300)
    const deskScrolled = await evalJS(SCROLL_MID)
    await sleep(400)
    s = await evalJS(HEADER_STATE)
    ok('13 桌面壳存在 .desk-main 且由它滚动', deskScrolled.via === '.desk-main', deskScrolled.via)
    ok(
      '14 桌面壳里页头贴 .desk-main 顶（没有跑到导航轨底下）',
      Math.abs(s.headerTop - s.viewportTop) <= 1,
      `headerTop=${s.headerTop} .desk-main顶=${s.viewportTop}`,
    )
    ok('15 桌面壳里遮罩同样显形', s.spanOpacity === '1', `层 opacity=${s.spanOpacity}`)
    await shot('3-desktop-scrolled')

    await cdp('Emulation.clearDeviceMetricsOverride')
    await sleep(600)

    /* ---------- 4 降级档：不用 backdrop-filter，改底色遮罩 ---------- */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: pinLow })
    await navigateTo(`${APP}/#/settings`)
    await evalJS(SCROLL_MID)
    await sleep(500)
    s = await evalJS(HEADER_STATE)
    ok('16 降级档写入 html[data-perf=low]', s.perfAttr === 'low', s.perfAttr)
    ok('17 降级档不再渲染模糊层', s.layerCount === 0, `层数=${s.layerCount}`)
    ok(
      '18 降级档遮罩为底色 → 透明渐变',
      String(s.maskBg).includes('gradient'),
      String(s.maskBg),
    )
    ok('19 降级档页头仍固定贴顶', Math.abs(s.headerTop - s.viewportTop) <= 1, `headerTop=${s.headerTop}`)
    ok('20 降级档遮罩显形', s.maskOpacity === '1', `opacity=${s.maskOpacity}`)
    ok(
      '21 降级档毛玻璃表面换成实底（玻璃填充不再半透明）',
      // 低档下 --glass-fill 被顶成 --surface：取得的值必须是不透明色。
      // 出现 rgba(...,0.x) / 8 位 hex 带 alpha 就说明半透明底还在（关掉 blur 后会成灰膜）
      (() => {
        const v = String(s.glassFill)
        if (/^rgb\(/.test(v)) return true
        if (/^rgba\(/.test(v)) return !/,\s*0?\.\d+\s*\)$/.test(v)
        if (/^#[0-9a-f]{6}$/i.test(v)) return true
        if (/^#[0-9a-f]{8}$/i.test(v)) return /ff$/i.test(v)
        return /^#[0-9a-f]{3}$/i.test(v)
      })(),
      `--glass-fill = ${s.glassFill} · dock=${String(s.tabbarBg).slice(0, 70)}`,
    )
    ok(
      '22 降级档全局不给 backdrop-filter',
      await evalJS(
        `getComputedStyle(document.querySelector('.dock')).backdropFilter === 'none'`,
      ),
    )
    await shot('4-degraded-scrolled')

    /* ---------- 4b 全新安装（没有本地档位）：默认必须是高画质 ----------
       0.2.5 → 0.2.7 升级后「渐进式模糊消失」就是这里翻的车：默认档是 low，
       而遮罩是 v-if="!perfDegraded"，于是装完就少了一块设计。 */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: clearPerf })
    await navigateTo(`${APP}/#/settings`)
    await evalJS(SCROLL_MID)
    await sleep(500)
    s = await evalJS(HEADER_STATE)
    ok(
      '22b 全新安装（无本地档位）默认高画质：渐进模糊在',
      s.perfAttr === 'high' && s.layerCount === 5,
      `data-perf=${s.perfAttr} 层数=${s.layerCount}`,
    )

    /* ---------- 5 其它页标题同样固定 ---------- */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: pinHigh })
    for (const [route, title] of [
      ['#/me', '关于你'],
      ['#/nutrition', '营养全览'],
      ['#/ledger', '记账'],
    ]) {
      await navigateTo(`${APP}/${route}`)
      await evalJS(SCROLL_MID)
      await sleep(500)
      const st = await evalJS(HEADER_STATE)
      ok(
        `24 ${route} 页头固定、标题为「${title}」且滚动后显形遮罩`,
        Math.abs(st.headerTop - st.viewportTop) <= 1 && st.spanOpacity === '1' && st.scrolledClass,
        `headerTop=${st.headerTop} 层 opacity=${st.spanOpacity} scrolled=${st.scrolledClass}`,
      )
      const h1 = await evalJS(`document.querySelector('.page-header h1')?.textContent ?? '(无)'`)
      ok(`25 ${route} 页头标题文本正确`, h1 === title, `h1=${h1}`)
    }

    /* ---------- 7 暗色 + 桌面便当页 ---------- */
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    await navigateTo(`${APP}/#/`)
    const homeScroll = await evalJS(SCROLL_MID)
    await sleep(600)
    s = await evalJS(HEADER_STATE)
    console.log(`      [home 滚动] ${JSON.stringify(homeScroll)} · 实际 ${JSON.stringify(s.scrollInfo)}`)
    ok(
      '27 暗色 + 桌面便当页：页头固定、遮罩显形、模糊层在位',
      Math.abs(s.headerTop - s.viewportTop) <= 1 && s.spanOpacity === '1' && s.layerCount === 5 && s.scrollInfo.top > 0,
      `headerTop=${s.headerTop} 层 opacity=${s.spanOpacity} 层数=${s.layerCount} 滚动=${JSON.stringify(s.scrollInfo)}`,
    )
    ok('28 遮罩向左右铺出页头之外（盖满整帧，不留未模糊的窄条）', s.maskLeft < s.headerLeft && s.maskRight > s.headerRight, `mask=${s.maskLeft}..${s.maskRight} header=${s.headerLeft}..${s.headerRight}`)
    ok('29 遮罩向下超出页头（模糊有化开的空间）', s.maskTail > 0, `超出 ${s.maskTail}px`)
    await shot('5-desktop-dark-home')

    /* ---------- 8 运行期异常 ---------- */
    const errs = await evalJS(`window.__errs ?? ['(收集器未装)']`)
    ok('30 运行期无未捕获异常', Array.isArray(errs) && errs.length === 0, (errs ?? []).join(' | '))
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
  } finally {
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

void main()
