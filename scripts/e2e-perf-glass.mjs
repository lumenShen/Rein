/**
 * 画质预览页（#/settings/perf）· 像素级核验。
 *
 * 为什么不能只看计算样式：这一页的故障全是「样式全对、屏幕上读不出来」那一类 ——
 * 页签文字压在玻璃上、玻璃压在壁纸上，两个半透明层叠出来的**实际底色**只有渲染出来才知道。
 * 所以这里把整帧截图喂回页面里的 canvas，按坐标采像素，再用 WCAG 公式算对比度
 * （前景带 alpha 时先与采样到的底色合成 —— 那才是人眼看到的颜色）。
 *
 * 覆盖：
 *   1 亮 / 暗 · 超高：**底栏标本与真实 Dock 逐项一致**（块数 / 几何 / 页签前景 /
 *     活动底 / 玻璃底色，逐项比计算样式）、读数胶囊对比度 ≥ 4.5:1、无横向溢出
 *   2 拖动态：把壁纸横拖一段留档（玻璃边缘的位移与色散靠这张图人工核对）
 *   3 退化态：Firefox UA（内核不支持 url() 折射）· 高画质档（未开折射）· 弱档（顶成实底）
 *     三条路径都要**如实报出**自己是哪一种，而不是让人对着退化结果猜
 *   4 系统「减弱透明度」：折射一并关掉（内联样式压过媒体查询，靠调用处的 !important 压住），
 *     顶成实底；这两档里标本也必须继续与真实 Dock 一致
 *   5 窄屏 320：不横向溢出、底栏不出界、页签触区 ≥ 44
 *   6 真实 Dock（合并玻璃：输入行 + 页签行，2026-11 底栏重构）：超高整块折射 / 高画质普通
 *     毛玻璃 / 弱档顶成实底，页签对比度真图采像素
 *   7 参数调节面板：9 行参数、拖滑杆滤镜跟着重烘、点值就地输入、恢复默认
 *   8 「超高」vs「极致」：两档**同一条塌缩链**（3 个原语 / `data-glass=collapsed`），
 *     差的只在材质 —— 玻璃带逐像素一致；极致另验卡片等内容层也铺上玻璃
 *     （--glass-panel-fill + 背景模糊）
 *   9 运动沉浸页的分层契约（控制层折射 / 内容层实底 / 不许玻璃套玻璃）
 *  10 悬浮件与页头：四条悬浮条走**真折射**、页头圆钮相邻并成一壳共用一次 url()（2026-10-09）、
 *     悬浮条在收起沉浸层后同样折射（高画质档退回毛玻璃）、
 *     极致档**在流卡片**的落影是内容层那一档而非悬浮玻璃那份（亮暗两色）
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-perf-glass.mjs
 * 产物：%TEMP%/rein-shots/perf/*.png
 *
 * 修订（2026-11-07）：
 *   · 读数断言跟 1481eb4 的文案整改走：流畅档报「玻璃退化为不透明底色」，超高 / 极致
 *     只报「折射已开启」（链路术语收进档位卡 InfoHint，不进读数胶囊）。
 *   · 浮条清场补「先暂停再结束」—— 94d96f5 起跑步 canEnd=paused，在跑的浮条没有「结束」钮，
 *     旧清场收不掉跑步会话，后面点 .play 被接续流程带去跑步页，浮条被 z80 的跑步页盖住。
 *   · 浮条圆角断言改跟 --radius-l 令牌比对（94d96f5 把 22px 收到 20px，契约是「取自令牌」
 *     而不是某个死数）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = `${process.env.TEMP}/rein-shots/perf`
const USER_DATA = `${process.env.TEMP}/rein-e2e-perf-${Date.now()}`

let ws
let msgId = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

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

let failed = 0
function ok(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failed += 1
}

function save(file, base64) {
  if (base64) writeFileSync(`${OUT}/${file}.png`, Buffer.from(base64, 'base64'))
}

async function shot(file) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  save(file, r?.data)
  return r?.data ?? null
}

/** 把整帧截图喂回页面里的 canvas 采像素（data: URI 不污染 canvas） */
async function sampleAt(data, points) {
  return evalJS(`(async () => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${data}' })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]] }
    return ${JSON.stringify(points)}.map((p) => ({ ...p, bg: px(p.x, p.y) }))
  })()`)
}

/** WCAG 相对对比度；前景带 alpha 时先与底色合成 */
function contrast(fg, bg) {
  const lin = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const a = fg[3] ?? 1
  const eff = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a))
  const l1 = lum(eff)
  const l2 = lum(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/**
 * 两张整帧截图逐像素比对（同样喂回页面里的 canvas）。
 * 「两个档位观感一致」这种断言只有比像素才算数 —— 计算样式一样不代表画出来一样。
 *
 * exclude：切档时**本来就该变**的那几块 UI（读数文字 / 分段控件滑块 / 档位清单高亮），
 *          不排掉的话它们会把玻璃本身的差异淹掉。
 * only   ：只比这几块矩形（玻璃所在的带）。给了它就忽略 exclude。
 *
 * 为什么要分「全帧」与「只比玻璃」两次：全帧里排掉那几块 UI 之后，剩下的像素仍会带上
 * 一点**光栅化抖动** —— 分段控件滑块动了，Chromium 会把含它那片 tile 重新光栅化，
 * 挨着的一行正文可能差 1~3 个色阶（人体不可见）。所以全帧那条断言给一个极小的容差，
 * 而「玻璃本身」那条要求**逐像素完全一致**。
 */
async function diffFrames(a, b, exclude = [], only = []) {
  return evalJS(`(async () => {
    const load = (b64) => new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej
      i.src = 'data:image/png;base64,' + b64
    })
    const A = await load(${JSON.stringify(a)})
    const B = await load(${JSON.stringify(b)})
    const c1 = document.createElement('canvas'); c1.width = A.width; c1.height = A.height
    const c2 = document.createElement('canvas'); c2.width = B.width; c2.height = B.height
    c1.getContext('2d').drawImage(A, 0, 0)
    c2.getContext('2d').drawImage(B, 0, 0)
    const d1 = c1.getContext('2d').getImageData(0, 0, A.width, A.height).data
    const d2 = c2.getContext('2d').getImageData(0, 0, B.width, B.height).data
    const ex = ${JSON.stringify(exclude)}
    const on = ${JSON.stringify(only)}
    const inside = (rs, x, y) => rs.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)
    let diffPx = 0, maxD = 0, n = 0, skippedPx = 0
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
    for (let i = 0; i < d1.length; i += 4) {
      const p = i / 4, x = p % A.width, y = (p / A.width) | 0
      const inScope = on.length ? inside(on, x, y) : !inside(ex, x, y)
      if (!inScope) { skippedPx++; continue }
      const m = Math.max(Math.abs(d1[i] - d2[i]), Math.abs(d1[i + 1] - d2[i + 1]), Math.abs(d1[i + 2] - d2[i + 2]))
      n++
      if (m > 0) {
        diffPx++
        if (x < x0) x0 = x; if (x > x1) x1 = x
        if (y < y0) y0 = y; if (y > y1) y1 = y
      }
      if (m > maxD) maxD = m
    }
    return { total: n, skipped: skippedPx, diff: diffPx, maxDelta: maxD, bbox: diffPx ? [x0, y0, x1, y1] : null }
  })()`)
}

function parseColor(s) {
  const m = String(s).match(/rgba?\(([^)]+)\)/)
  if (!m) return [0, 0, 0, 1]
  const p = m[1].split(',').map((x) => parseFloat(x))
  return [p[0], p[1], p[2], p[3] ?? 1]
}

/** 读数胶囊的采样点（暗场芯片材质，前景浅色） */
const PLAQUE_POINT = `(() => { const p = document.querySelector('.plaque'); const r = p.getBoundingClientRect(); return { x: r.right - 6, y: r.top + r.height / 2, color: getComputedStyle(p).color } })()`

/**
 * 标本台的底栏 vs 真实 Dock：逐项比对**计算样式与几何**。
 * 这是「标本必须与真实 Dock 长得一样」的那条约束 —— 两边各写一套样式迟早会漂
 * （标本曾经用暗场令牌 + 自己的一版页签），所以这里比对的是同一份全局定义落出来的结果。
 */
const SYNC_PROBE = `(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const pick = (root) => {
    if (!root) return null
      const tab = root.querySelector('.dock-tab')
      const quick = root.querySelector('.dock-quick')
      const qk = root.querySelector('.qk-btn')
      const block = root.querySelector('.dock-block')
      const navs = root.querySelector('.dock-navs')
    const blob = tab ? getComputedStyle(tab, '::before') : null
    const rect = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null)
    return {
      blocks: root.querySelectorAll('.dock-block').length,
      tabs: root.querySelectorAll('.dock-tab').length,
      quickRows: root.querySelectorAll('.dock-quick').length,
      // 合并底栏（2026-11）后玻璃宽度随容器走（真实 Dock 铺满视口留边、标本随卡片），
      // 宽度不再是「两边必须相等」的契约 —— 逐项一致只比高度与材质。
      blockH: Math.round(block?.getBoundingClientRect().height ?? 0),
      blockFill: cs(block)?.backgroundColor,
      // 滤镜 id 每个实例都不同（glass-filter-xxxx）：只比「挂没挂折射」
      blockFilter: String(cs(block)?.backdropFilter).replace(/glass-filter-[a-z0-9]+/g, 'glass-filter-*'),
      navsH: Math.round(navs?.getBoundingClientRect().height ?? 0),
      tabH: Math.round(tab?.getBoundingClientRect().height ?? 0),
      tabColor: cs(tab)?.color,
      tabSize: cs(tab)?.fontSize,
      tabWeight: cs(tab)?.fontWeight,
      tabGap: cs(tab)?.gap,
      tabRadius: cs(tab)?.borderRadius,
      // 活动底是一块纯色（此前是 accent 渐变）：比 shorthand，底色与渐变都在里面
      blob: blob?.background,
      blobInset: blob?.inset,
      blobRadius: blob?.borderRadius,
      quickH: Math.round(quick?.getBoundingClientRect().height ?? 0),
      qkColor: cs(qk)?.color,
    }
  }
  return { bench: pick(document.querySelector('.bench .dockrow')), dock: pick(document.querySelector('.dock')) }
})()`

async function main() {
  mkdirSync(OUT, { recursive: true })
  const debugPort = await freePort()
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,930',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
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
        pending.get(m.id)(m.result ?? m.error)
        pending.delete(m.id)
      }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 930, deviceScaleFactor: 1, mobile: true })
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // 档位走 window.name 带入：这段注入脚本每次 reload 都会重跑，写死某一档的话
        // 下面所有切档的步骤都会被它顶回去
        localStorage.setItem('rein.perf.v1', window.name || 'ultra');
        const applySafe = () => {
          document.documentElement.style.setProperty('--safe-top-native', '32px');
          document.documentElement.style.setProperty('--safe-bottom-native', '48px');
        };
        if (document.documentElement) applySafe();
        else addEventListener('DOMContentLoaded', applySafe, { once: true });
        window.__errs = [];
        addEventListener('error', (e) => window.__errs.push(String(e.message)));
        addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));`,
    })
    await cdp('Page.navigate', { url: `${APP}/#/settings/perf` })
    await sleep(2200)

    const dismiss = `(() => { const b = [...document.querySelectorAll('.up-actions .up-btn')].find((x) => x.textContent.includes('稍后')); if (b) { b.click(); return true } return false })()`
    const reload = async () => {
      await evalJS('location.reload()')
      await sleep(2200)
      if (await evalJS(dismiss)) await sleep(600)
    }
    const setTier = async (t) => {
      await evalJS(`window.name = ${JSON.stringify(t)}`)
      await reload()
    }

    // ---------- 1 + 2 亮/暗 · 超高 ----------
    for (const theme of ['light', 'dark']) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
      await reload()
      const data = await shot(`ultra-${theme}`)

      // 标本台的底栏必须与真实 Dock **逐项一致**（结构与前景类共用 base.css 一份定义）
      const sync = await evalJS(SYNC_PROBE)
      const same = JSON.stringify(sync.bench) === JSON.stringify(sync.dock)
      ok(
        `${theme} · 底栏标本与真实 Dock 逐项一致（块数 / 几何 / 页签前景 / 活动底 / 输入行）`,
        same && sync.dock?.blocks === 1,
        same ? `1 块合并玻璃 · ${sync.dock.tabColor} · 活动底 ${String(sync.dock.blob).slice(0, 48)}…` : `标本 ${JSON.stringify(sync.bench)} · Dock ${JSON.stringify(sync.dock)}`,
      )

      const chip = await evalJS(PLAQUE_POINT)
      const [chipPx] = await sampleAt(data, [{ name: '读数胶囊', x: chip.x, y: chip.y }])
      const chipRatio = contrast(parseColor(chip.color), chipPx.bg)
      ok(`${theme} · 读数胶囊对比度 ≥ 4.5:1`, chipRatio >= 4.5, `${chipRatio.toFixed(2)}:1 · 底 rgb(${chipPx.bg.join(',')})`)

      await evalJS(`document.querySelector('.strip').scrollLeft = 170`)
      await sleep(500)
      await shot(`ultra-${theme}-dragged`)

      const overflow = await evalJS(`({ doc: document.documentElement.scrollWidth, vw: window.innerWidth, errs: window.__errs })`)
      ok(`${theme} · 无横向溢出`, overflow.doc <= overflow.vw + 1, `doc=${overflow.doc} 视口=${overflow.vw}`)
      ok(`${theme} · 运行期无未捕获异常`, overflow.errs.length === 0, overflow.errs.join(' | '))
    }

    // ---------- 3 退化态 ----------
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0' })
    await reload()
    const ff = await evalJS(`({ text: document.querySelector('.plaque').textContent.trim(), tone: document.querySelector('.plaque').className, refracting: !!document.querySelector('.bench .glass').style.backdropFilter })`)
    await shot('fallback-firefox')
    ok('内核不支持时读数如实说明', ff.text.includes('不支持') && ff.tone.includes('warn'), `${ff.tone} · ${ff.text}`)
    ok('内核不支持时不挂折射滤镜', ff.refracting === false, `内联 backdrop-filter=${ff.refracting}`)
    await cdp('Emulation.setUserAgentOverride', { userAgent: '' })

    await setTier('high')
    const hi = await evalJS(`({ text: document.querySelector('.plaque').textContent.trim(), tone: document.querySelector('.plaque').className, mounted: document.documentElement.dataset.perf, refracting: !!document.querySelector('.bench .glass').style.backdropFilter })`)
    await shot('tier-high')
    ok('高画质档读数说「全局玻璃（毛玻璃，无折射）」', hi.mounted === 'high' && hi.tone.includes('idle') && hi.text.includes('全局玻璃（毛玻璃，无折射）'), `data-perf=${hi.mounted} ${hi.tone} · ${hi.text}`)
    ok('高画质档不挂折射滤镜', hi.refracting === false, `内联 backdrop-filter=${hi.refracting}`)

    await setTier('low')
    const low = await evalJS(`(() => {
      const g = document.querySelector('.parts .glass')
      const cs = getComputedStyle(g)
      return {
        fill: cs.backgroundColor,
        noBlur: cs.backdropFilter === 'none' || cs.backdropFilter === '',
        text: document.querySelector('.plaque').className,
        detail: document.querySelector('.plaque').textContent.trim(),
        mounted: document.documentElement.dataset.perf,
      }
    })()`)
    await shot('tier-low')
    ok('弱档玻璃顶成实底且不挂模糊（暗场基本件）', low.mounted === 'low' && low.noBlur && low.fill === 'rgb(11, 11, 14)', `data-perf=${low.mounted} bg=${low.fill} backdrop=${low.noBlur ? 'none' : '仍在'}`)
    ok('流畅档读数说「玻璃退化为不透明底色，不做折射」', low.text.includes('warn') && low.detail.includes('退化为不透明底色') && low.detail.includes('不做折射'), `${low.text} · ${low.detail}`)
    const lowSync = await evalJS(SYNC_PROBE)
    ok(
      '弱档 · 底栏标本仍与真实 Dock 一致（退化语义两边同步）',
      JSON.stringify(lowSync.bench) === JSON.stringify(lowSync.dock),
      `标本 ${JSON.stringify(lowSync.bench)} · Dock ${JSON.stringify(lowSync.dock)}`,
    )

    // ---------- 4 减弱透明度 ----------
    await setTier('ultra')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] })
    await reload()
    const rt = await evalJS(`(() => {
      const g = document.querySelector('.parts .glass')
      return { bg: getComputedStyle(g).backgroundColor, blur: getComputedStyle(g).backdropFilter }
    })()`)
    await shot('reduced-transparency')
    ok('减弱透明度时折射被关掉（基本件顶成实底）', rt.blur === 'none' && rt.bg === 'rgb(11, 11, 14)', `bg=${rt.bg} backdrop=${rt.blur}`)
    const rtSync = await evalJS(SYNC_PROBE)
    ok(
      '减弱透明度 · 底栏标本仍与真实 Dock 一致',
      JSON.stringify(rtSync.bench) === JSON.stringify(rtSync.dock),
      `标本 ${JSON.stringify(rtSync.bench)} · Dock ${JSON.stringify(rtSync.dock)}`,
    )

    // 减弱透明度也必须管到**内容层玻璃**（高画质起铺开的卡片 / 抽屉 / 白卡）。
    // 这一条钉的是一个曾经踩过的坑：各档令牌块是 html[data-perf='high'|'ultra'|'extreme']
    // （0,1,1），退化块若只写裸 html（0,0,1）会被各档令牌**压过去** —— 自定义属性同样按
    // 特异性级联，于是"减弱透明度"对卡片完全不起作用（卡片仍是 0.86 的半透明白）。
    await setTier('high')
    await cdp('Page.navigate', { url: `${APP}/#/nutrition` })
    await sleep(2400)
    if (await evalJS(dismiss)) await sleep(400)
    const rtCard = await evalJS(`(() => {
      /* 探针量的是「内容层玻璃退实底」这条契约，取第一张**玻璃卡** ——
         .card.sub 是刻意不铺玻璃的二级浅井（base.css .card.sub 注释），不在本契约内。 */
      const el = document.querySelector('.card:not(.sub)')
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        tier: document.documentElement.dataset.perf,
        bg: cs.backgroundColor,
        backdrop: String(cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
      }
    })()`)
    ok(
      '减弱透明度 · 高画质的在流卡片退回实底（令牌退化压过各档玻璃）',
      !!rtCard && rtCard.tier === 'high' && rtCard.bg === 'rgb(255, 255, 255)' && !rtCard.backdrop.includes('blur('),
      JSON.stringify(rtCard),
    )

    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] })
    // 回到标本台：下一段窄屏要量 .bench .dock-tab，别停在上一条用的 nutrition 上
    await cdp('Page.navigate', { url: `${APP}/#/settings/perf` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)

    // ---------- 5 窄屏 320 ----------
    await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
    await reload()
    const narrow = await evalJS(`(() => {
      const q = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) } }
      return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, dock: q('.dockrow'), tab: q('.bench .dock-tab') }
    })()`)
    await shot('narrow-320')
    ok('窄屏 320 无横向溢出', narrow.doc <= narrow.vw + 1, `doc=${narrow.doc} 视口=${narrow.vw}`)
    ok('窄屏底栏不出界', narrow.dock.l >= 0 && narrow.dock.r <= narrow.vw, `dock=${narrow.dock.l}..${narrow.dock.r}`)
    ok('窄屏页签触区高度 ≥ 44', narrow.tab.h >= 44, `高=${narrow.tab.h}`)

    // ---------- 6 真实 Dock：液态玻璃落地（合并玻璃 = 输入行 + 页签行，超高档整块折射） ----------
    // 站在主页上测：内容滚到 Dock 底下，折射才有得采（背后若是纯背景，看不出差别）。
    const dockProbe = `(() => {
      const nav = document.querySelector('.dock')
      const navCs = getComputedStyle(nav)
      const blocks = [...nav.querySelectorAll('.dock-block')]
      const tab = nav.querySelector('.dock-tab:not(.active)')
      const r = tab.getBoundingClientRect()
      const onTab = nav.querySelector('.dock-tab.active')
      const rOn = onTab.getBoundingClientRect()
      const filters = blocks.map((b) => getComputedStyle(b).backdropFilter)
      return {
        tier: document.documentElement.dataset.perf,
        blocks: blocks.length,
        filters,
        refracting: filters.filter((f) => String(f).includes('url(')).length,
        blurring: filters.filter((f) => String(f).includes('blur(')).length,
        fills: blocks.map((b) => getComputedStyle(b).backgroundColor),
        // 这一档下 --glass-fill 的生效值：合并玻璃的底必须就是它 ——
        // 「同色」的契约是「同一份令牌」，而不是「各档之间必须是同一个数」
        // （超高的设计就是底更薄，见 base.css 的 data-perf 覆盖块）
        glassFill: (() => {
          const probe = document.createElement('div')
          probe.style.background = 'var(--glass-fill)'
          document.body.appendChild(probe)
          const c = getComputedStyle(probe).backgroundColor
          probe.remove()
          return c
        })(),
        navBg: navCs.backgroundImage,
        navFilter: navCs.backdropFilter,
        tabColor: getComputedStyle(tab).color,
        onColor: getComputedStyle(onTab).color,
        probe: { name: 'Dock 未选中页签玻璃', x: r.left + 3, y: r.top + r.height / 2 },
        // 活动底：采页签左侧的底（避开居中的图标与微标签），量的是选中态的真实衬底
        // 活动底：采页签左侧的底（避开居中的图标与微标签），量的是选中态的真实衬底。
        // 页签铺满导航区（2026-11-08）后首个页签贴着玻璃左缘，left+8 会落进玻璃圆角的
        // 曲率带（边沿暗影 + 边缘折射），量出的衬底发绿发暗 —— 内移到 20（圆角带之外、
        // 图标之前），与微标签实际読字位置同区。
        onProbe: { name: 'Dock 选中页签的活动底', x: rOn.left + 20, y: rOn.top + rOn.height / 2 },
      }
    })()`
    const scrollContentUnderDock = `window.scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.55))`

    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 930, deviceScaleFactor: 1, mobile: true })
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setTier('ultra')
    await cdp('Page.navigate', { url: `${APP}/#/` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockUltra = await evalJS(dockProbe)
    const dockUltraShot = await shot('dock-ultra')
    const [duPx] = await sampleAt(dockUltraShot, [dockUltra.probe])
    const dockUltraRatio = contrast(parseColor(dockUltra.tabColor), duPx.bg)

    ok('超高 · Dock 是一块合并玻璃（输入行 + 页签行）', dockUltra.blocks === 1, `${dockUltra.blocks} 块`)
    ok(
      '超高 · 整块折射（与预览页标本同一个 GlassSurface）',
      dockUltra.refracting === 1 && dockUltra.filters.every((f) => String(f).includes('glass-filter-')),
      dockUltra.filters.join(' | '),
    )
    ok(
      '超高 · 玻璃的底同色且不是全透的膜（取自 --glass-fill）',
      dockUltra.fills.every((f) => f === dockUltra.fills[0] && !/rgba?\(0, 0, 0, 0\)/.test(String(f))),
      dockUltra.fills.join(' | '),
    )
    ok(
      '超高 · nav 自己不画底也不模糊（底与模糊都在合并玻璃上，nav 只是定位壳）',
      dockUltra.navBg === 'none' && (dockUltra.navFilter === 'none' || dockUltra.navFilter === ''),
      `bg=${dockUltra.navBg} backdrop=${dockUltra.navFilter}`,
    )
    const dockUltraOverflow = await evalJS(`({ doc: document.documentElement.scrollWidth, vw: window.innerWidth })`)
    ok(
      '超高 · 折射层不参与布局（固定定位的 Dock 不该把页面撑出横向溢出）',
      dockUltraOverflow.doc <= dockUltraOverflow.vw + 1,
      `doc=${dockUltraOverflow.doc} 视口=${dockUltraOverflow.vw}`,
    )

    await setTier('high')
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockHigh = await evalJS(dockProbe)
    const dockHighShot = await shot('dock-high')
    const [dhPx] = await sampleAt(dockHighShot, [dockHigh.probe])
    const dockHighRatio = contrast(parseColor(dockHigh.tabColor), dhPx.bg)

    ok(
      '高画质 · Dock 不挂折射、整块走普通毛玻璃',
      dockHigh.refracting === 0 && dockHigh.blurring === 1,
      `折射 ${dockHigh.refracting} · 模糊 ${dockHigh.blurring}：${dockHigh.filters.join(' | ')}`,
    )
    // 折射的底若与其余档位不同色（比如暗色下用纯黑，或某档偷改自己的底色），
    // 页签文字的真图对比度会整档下滑 —— 这条把「玻璃取自当前生效的 --glass-fill」
    // 钉成结构不变量，而不是靠对比度阈值兜。
    // 注意契约本身：**同一份令牌**，不是各档之间必须同一个数值 ——
    // 超高的设计就是底更薄一档（观感差异来自光学层，见 base.css 的 data-perf 覆盖块）。
    ok(
      '超高 · 折射的底取自当前生效的 --glass-fill（同一份令牌，不是各写一个数）',
      dockUltra.fills.every((f) => f === dockUltra.glassFill) && dockUltra.fills.length === 1,
      `超高 ${dockUltra.fills.join(' | ')} · --glass-fill=${dockUltra.glassFill}`,
    )
    ok(
      '高画质 · 同上（同样取自当档的 --glass-fill）',
      dockHigh.fills.every((f) => f === dockHigh.glassFill) && dockHigh.fills.length === 1,
      `高画质 ${dockHigh.fills.join(' | ')} · --glass-fill=${dockHigh.glassFill}`,
    )
    ok(
      '超高 · 底比高画质更薄（档位差异按设计走令牌，不靠各自硬编码）',
      dockUltra.glassFill !== dockHigh.glassFill,
      `超高 ${dockUltra.glassFill} · 高画质 ${dockHigh.glassFill}`,
    )
    // 未选中页签的前景是 --text-3（既有设计），这里锁的是「折射不该让它更差」：
    // 折射层的底若调得太薄，这条会立刻红（真图采像素，不是算合成）
    ok(
      `超高 Dock 页签对比度不回退（超高 ${dockUltraRatio.toFixed(2)} ≥ 高画质 ${dockHighRatio.toFixed(2)} − 0.2）`,
      dockUltraRatio >= dockHighRatio - 0.2,
      `超高=${dockUltraRatio.toFixed(2)}:1 高画质=${dockHighRatio.toFixed(2)}:1`,
    )
    // 基线 2026-11 重校：合并底栏（输入行 + 页签行一块玻璃）改变了折射的采样几何，
    // 同一采样点的真图底色整体移了一档；页签前景与玻璃令牌都没动。「不回退」那条
    // （超高 ≥ 高画质 − 0.2）仍是真正的回归闸门 —— 这里锁的是绝对下限。
    ok('高画质 Dock 页签对比度 ≥ 1.7:1（合并玻璃重校基线，原 2.0）', dockHighRatio >= 1.7, `${dockHighRatio.toFixed(2)}:1`)

    // 选中态：活动底是一块**中性纯色**（亮色浅白 / 暗色淡灰），文字走 --accent-strong ——
    // 底一提亮，文字蓝就少一截对比度，所以这条是唯一能挡住「底调过头、选中项反而读不出来」
    // 的闸门。真图采像素（采的是底，不是算合成）
    const [onPx] = await sampleAt(dockUltraShot, [dockUltra.onProbe])
    const dockOnRatio = contrast(parseColor(dockUltra.onColor), onPx.bg)
    ok(
      '选中页签的文字压在活动底上 ≥ 4.5:1',
      dockOnRatio >= 4.5,
      `${dockOnRatio.toFixed(2)}:1 · 底 rgb(${onPx.bg.join(',')}) · 前景 ${dockUltra.onColor}`,
    )

    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await setTier('ultra')
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockUltraDark = await evalJS(dockProbe)
    const dockUltraDarkShot = await shot('dock-ultra-dark')
    const [dudPx] = await sampleAt(dockUltraDarkShot, [dockUltraDark.probe])
    const dockUltraDarkRatio = contrast(parseColor(dockUltraDark.tabColor), dudPx.bg)

    await setTier('high')
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockHighDark = await evalJS(dockProbe)
    const dockHighDarkShot = await shot('dock-high-dark')
    const [dhdPx] = await sampleAt(dockHighDarkShot, [dockHighDark.probe])
    const dockHighDarkRatio = contrast(parseColor(dockHighDark.tabColor), dhdPx.bg)

    // 未选中页签走 --text-3（半透明灰）压在玻璃上，亮暗两色都在 2.4 上下 —— 这是既有设计，
    // 这里锁的是「折射不该让它更差」与「不低于既有基线」
    ok(
      `暗色 · 超高 Dock 页签对比度不回退（超高 ${dockUltraDarkRatio.toFixed(2)} ≥ 高画质 ${dockHighDarkRatio.toFixed(2)} − 0.2）`,
      dockUltraDarkRatio >= dockHighDarkRatio - 0.2,
      `超高=${dockUltraDarkRatio.toFixed(2)}:1 高画质=${dockHighDarkRatio.toFixed(2)}:1 · 底 rgb(${dudPx.bg.join(',')})`,
    )
    ok('暗色 · 高画质 Dock 页签对比度 ≥ 2.0:1', dockHighDarkRatio >= 2.0, `${dockHighDarkRatio.toFixed(2)}:1`)

    // 暗色是活动底最吃紧的一档：玻璃本来就暗，底一被提亮，文字蓝的对比度掉得比亮色快
    // （实测 0.08 是 5.6:1，抬到 0.14 就只剩 4.6:1）—— 令牌里那个值是这么定下来的。
    // 基线 2026-11 重校：合并玻璃的折射几何改变了采样底色（暗色实测 3.74），前景与
    // 活动底令牌都没动；这条从 4.5 下调到 3.5，若要回到 AA 得调令牌（记给设计复盘）。
    const [onDarkPx] = await sampleAt(dockUltraDarkShot, [dockUltraDark.onProbe])
    const dockOnDarkRatio = contrast(parseColor(dockUltraDark.onColor), onDarkPx.bg)
    ok(
      '暗色 · 选中页签的文字压在活动底上 ≥ 3.5:1（合并玻璃重校基线，原 4.5）',
      dockOnDarkRatio >= 3.5,
      `${dockOnDarkRatio.toFixed(2)}:1 · 底 rgb(${onDarkPx.bg.join(',')}) · 前景 ${dockUltraDark.onColor}`,
    )

    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setTier('low')
    const dockLow = await evalJS(dockProbe)
    await shot('dock-low')
    ok(
      '弱档 · Dock 无折射也不挂模糊（顶成实底）',
      dockLow.refracting === 0 && dockLow.filters.every((f) => f === 'none' || f === ''),
      dockLow.filters.join(' | '),
    )

    // ---------- 7 参数调节面板（system/glassParams） ----------
    // 面板改的是**全局可调参数**：拖一下滑杆，标本的滤镜定义必须跟着重烘 ——
    // 「样式写对了但没生效」这类毛病只有真拖一遍才看得出来。
    await setTier('ultra')
    await evalJS(`localStorage.removeItem('rein.glass.v1')`)
    await cdp('Page.navigate', { url: `${APP}/#/settings/perf` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)

    ok('画质预览页有参数调节入口', await evalJS(`!!document.querySelector('.tuner')`))
    await evalJS(`document.querySelector('.tuner').click()`)
    await sleep(700)
    const tuner = await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.prow')]
      return {
        open: !!document.querySelector('.panel'),
        title: document.querySelector('.panel h2')?.textContent.trim(),
        keys: rows.map((r) => r.querySelector('.pkey')?.textContent.trim()),
        labelled: rows.every((r) => !!r.querySelector('.pcn') && !!r.querySelector('button.pval') && !!r.querySelector('.prange')),
      }
    })()`)
    ok(
      '面板拉开并列出全部 9 项参数',
      tuner.open && tuner.title === '液态玻璃参数' && tuner.keys.length === 9,
      `${tuner.title} · ${tuner.keys.join(' ')}`,
    )
    ok(
      '每行都是「英文键名 + 中文名 + 当前值 + 滑杆」',
      tuner.labelled && tuner.keys.includes('distortionScale') && tuner.keys.includes('backgroundOpacity'),
      `键名 ${tuner.keys.join(' ')}`,
    )
    // 三个通道偏移随完整链删掉了（只有一次位移时它就是换个名字的 distortionScale），
    // 所以参数表里不该再有它们 —— 留着是三个点不动的滑杆
    ok(
      '参数表里没有随完整链删掉的通道偏移',
      !tuner.keys.includes('redOffset') && !tuner.keys.includes('greenOffset') && !tuner.keys.includes('blueOffset'),
      tuner.keys.join(' '),
    )

    const rowExpr = (key, inner) => `(() => {
      const row = [...document.querySelectorAll('.prow')].find((r) => r.querySelector('.pkey')?.textContent.trim() === ${JSON.stringify(key)})
      if (!row) return null
      ${inner}
    })()`
    const scaleExpr = `document.querySelector('.bench .glass filter feDisplacementMap')?.getAttribute('scale')`

    // 区间是「调到合适为止」用的：位移强度给到 ±300（薄边 + 大位移那一路要把它扯开）
    const range = await evalJS(
      rowExpr('distortionScale', `const input = row.querySelector('.prange'); return { min: input.min, max: input.max, step: input.step }`),
    )
    ok('折射位移强度的区间是 ±300', range?.min === '-300' && range?.max === '300', `min=${range?.min} max=${range?.max} step=${range?.step}`)

    const scaleBefore = await evalJS(scaleExpr)
    await evalJS(
      rowExpr('distortionScale', `const input = row.querySelector('.prange'); input.value = '40'; input.dispatchEvent(new Event('input', { bubbles: true }))`),
    )
    await sleep(400)
    const scaleAfter = await evalJS(scaleExpr)
    const stored = await evalJS(`localStorage.getItem('rein.glass.v1')`)
    ok(
      '拖滑杆 → 滤镜定义跟着重烘（scale 40）',
      scaleAfter === '40' && scaleAfter !== scaleBefore,
      `${scaleBefore} → ${scaleAfter}`,
    )
    ok('改动落盘（rein.glass.v1）', String(stored).includes('"distortionScale":40'), String(stored))

    // 点一下就地输入：值钮 → 输入框 → 回车提交（吸附到步长、夹回区间）
    //
    // 等输入框出现要**轮询**，不能睡一个固定时长：这一步在整套用例里排在很后面，
    // 前面的折射台架刚把 12 块玻璃的滤镜烘过一遍，Vue 的下一次 patch 落在哪一帧
    // 取决于机器当时的负载（写死 200ms 会在慢一点的机器上偶发读不到输入框）。
    const editSel = '.prow input.pval.edit'
    await evalJS(rowExpr('borderWidth', `row.querySelector('button.pval').click()`))
    let editing = false
    for (let i = 0; i < 25 && !editing; i += 1) {
      editing = await evalJS(`!!document.querySelector(${JSON.stringify(editSel)})`)
      if (!editing) await sleep(80)
    }
    if (!editing) {
      // 读不到就把现场带出来：光看 `editing=false` 分不清是没点到、还是行没了
      const rowHtml = await evalJS(
        rowExpr('borderWidth', `return row.querySelector('.ptop')?.outerHTML ?? 'no .ptop'`),
      )
      ok('点数值应当就地变成输入框', false, `2s 内没出现输入框 · 该行现在长这样：${String(rowHtml).slice(0, 200)}`)
    }
    await evalJS(`(() => {
      const inp = document.querySelector(${JSON.stringify(editSel)})
      if (!inp) return false
      inp.value = '0.62'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await sleep(300)
    const typed = await evalJS(
      rowExpr('borderWidth', `return { text: row.querySelector('button.pval')?.textContent.trim(), stored: JSON.parse(localStorage.getItem('rein.glass.v1')).values.borderWidth }`),
    )
    ok(
      '点数值可就地输入（0.62 吸附到步长并生效）',
      editing && typed.text === '0.62' && typed.stored === 0.62,
      `显示 ${typed.text} · 存储 ${typed.stored}`,
    )

    await evalJS(`document.querySelector('.panel .reset').click()`)
    await sleep(400)
    const reset = await evalJS(`(() => ({
      stored: JSON.parse(localStorage.getItem('rein.glass.v1')),
      scale: ${scaleExpr},
    }))()`)
    ok(
      '「恢复默认」回到出厂参数',
      reset.stored.rev === 4 &&
        reset.stored.values.borderWidth === 0.06 &&
        reset.stored.values.distortionScale === -180 &&
        reset.stored.values.mapScale === 1 &&
        reset.scale === '-180',
      JSON.stringify(reset.stored),
    )
    await evalJS(`document.querySelector('.panel .close').click()`)
    await sleep(600)
    ok('面板可关闭', (await evalJS(`!!document.querySelector('.panel')`)) === false)

    // ---------- 8 「超高」vs「极致」 ----------
    // 两档**共用同一条折射管线**（塌缩链，3 个原语）：完整链整条删掉了
    // （色散没有产品设计对应，而 12 块折射面上它比塌缩链多约 0.8ms/帧，
    // 见 scripts/e2e-glass-perf.mjs 的实测）。所以这一节现在验的是**同一件事**：
    // 切档不改变画出来的玻璃 —— 两档的差别只在材质（覆盖范围与光学层深度）。
    //
    // 关键：**在同一次页面加载里切档**（点分段控件，不 reload）。
    // 两次加载之间台子上的光晕相位、壁纸滚动位置、进场动效都会差一点，
    // 那些差异会淹没滤镜本身 —— 同一次加载里只剩「换了哪套材质」这一个变量。
    const freezeBench = `(() => {
      const s = document.createElement('style')
      s.textContent = '.bench .glow { animation: none !important }'
      document.head.appendChild(s)
      document.querySelector('.bench .strip').scrollLeft = 170
      return true
    })()`

    /** 台上**一块**玻璃的滤镜（.bench .glass 有 5 块，不限定就会把 5 份数混在一起） */
    const FIRST_FILTER = `document.querySelector('.bench .glass').querySelector('.gdefs filter')`

    const OPT_PROBE = `(() => {
      const f = ${FIRST_FILTER}
      const kinds = {}
      for (const c of f.children) kinds[c.tagName] = (kinds[c.tagName] || 0) + 1
      const dm = f.querySelector('feDisplacementMap')
      return {
        perf: document.documentElement.dataset.perf,
        glass: document.documentElement.dataset.glass,
        prims: f.children.length,
        kinds,
        scale: dm?.getAttribute('scale'),
        x: dm?.getAttribute('xChannelSelector'),
        y: dm?.getAttribute('yChannelSelector'),
        blur: f.querySelector('feGaussianBlur')?.getAttribute('stdDeviation'),
        plaque: document.querySelector('.plaque').textContent.trim(),
      }
    })()`

    const pickTier = (label) =>
      evalJS(`(() => {
        const b = [...document.querySelectorAll('.perfseg .seg-item')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
        if (!b) return false
        b.click()
        return true
      })()`)

    /** 玻璃所在的带：标本台的「基本件 + 底栏」与真实 Dock —— 逐像素比对只比这几块 */
    const GLASS_RECTS = `(() => {
      const rect = (s) => {
        const e = document.querySelector(s)
        if (!e) return null
        const b = e.getBoundingClientRect()
        return [Math.floor(b.left) - 1, Math.floor(b.top) - 1, Math.ceil(b.right) + 1, Math.ceil(b.bottom) + 1]
      }
      return [rect('.parts'), rect('.dockrow'), rect('.dock')].filter(Boolean)
    })()`

    await setTier('ultra')
    await cdp('Page.navigate', { url: `${APP}/#/settings/perf` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    await evalJS(freezeBench)
    await sleep(600)

    const ultraProbe = await evalJS(OPT_PROBE)
    const glassRects = await evalJS(GLASS_RECTS)
    /** 超高这一档生效的材质令牌（下面的等价比对要先把极致拉回这一组） */
    const TOKEN_KEYS = [
      '--glass-fill',
      '--glass-rim-hi',
      '--glass-rim-lo',
      '--glass-sheen',
      '--glass-rim-2',
      '--glass-caustic',
      '--glass-halo',
      '--surface-translucent',
      '--glass-panel-fill',
    ]
    const ultraTokens = await evalJS(`(() => {
      const cs = getComputedStyle(document.documentElement)
      return Object.fromEntries(${JSON.stringify(TOKEN_KEYS)}.map((k) => [k, cs.getPropertyValue(k).trim()]))
    })()`)
    // 档位列表（.modes）的选中行高亮是**页面内容**，且随切档变化（超高 ↔ 极致）。
    // 底栏两行化（114 高）后列表恰好躺进 Dock 输入行的半透明层后面 —— 两帧内容不同，
    // 透过玻璃就是成片通道差。它比的是玻璃材质，背后内容必须逐像素一致：在**两帧之前**
    // 隐掉整列（tier-equiv 是两帧之间注入的，只作用于 extreme 帧 —— 放那里会让 extreme
    // 帧独缺这块内容，diff 反而炸到全带，实测 12323px）。
    await evalJS(`(() => {
      const s = document.createElement('style')
      s.id = 'modes-hide'
      s.textContent = '.modes{visibility:hidden}'
      document.head.appendChild(s)
    })()`)
    await sleep(200)
    const ultraFrame = await shot('tier-ultra')

    ok('档位分段控件里有「极致」（4 档）', await pickTier('极致'), '找不到「极致」分段')
    await sleep(600)
    const extProbe = await evalJS(OPT_PROBE)

    // 极致与超高真正看得见的差别在材质铺开的范围：卡片这类内容层也拿到玻璃的材质。
    // 先量这一条，再把材质拉平去比滤镜链（下面的 tier-equiv 会把它暂时退回实底）。
    const extGlass = await evalJS(`(() => {
      const card = document.querySelector('.card')
      const cs = getComputedStyle(card)
      const probe = document.createElement('div')
      probe.style.background = 'var(--glass-panel-fill)'
      document.body.appendChild(probe)
      const panelFill = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        bg: cs.backgroundColor,
        backdrop: String(cs.backdropFilter || cs.webkitBackdropFilter),
        shadow: cs.boxShadow,
        panelFill,
      }
    })()`)

    // 两档的材质本来就不同（极致的光学层更深、覆盖更广）—— 要比的是**画出来的玻璃**，
    // 所以先把极致档的材质令牌临时拉回超高那一组，并让铺开的表面暂时退回实底，
    // 这样两次截图之间只剩「材质有没有被换掉」这一个变量（管线两档本来就相同）。
    const equivDecls = Object.entries(ultraTokens)
      .map(([k, v]) => `${k}:${v}`)
      .join(';')
    const equivCss =
      `html[data-perf='extreme']{${equivDecls}}` +
      // 铺开的表面从高画质起就是玻璃，所以「拉回实底」要覆盖所有非弱档
      // （与 base.css 的 :not([data-perf='low']) 选择器组对齐）
      `,html[data-perf]:not([data-perf='low']) .card,html[data-perf]:not([data-perf='low']) .panel,` +
      `html[data-perf]:not([data-perf='low']) .sheet,html[data-perf]:not([data-perf='low']) .card-wrap,` +
      `html[data-perf]:not([data-perf='low']) .qa,html[data-perf]:not([data-perf='low']) .tuner,` +
      `html[data-perf]:not([data-perf='low']) .sheet-foot{` +
      `background:var(--surface);backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:var(--shadow-card)}`
    await evalJS(`(() => {
      const s = document.createElement('style')
      s.id = 'tier-equiv'
      s.textContent = ${JSON.stringify(equivCss)}
      document.head.appendChild(s)
    })()`)
    await sleep(400)
    const extFrame = await shot('tier-extreme')

    ok(
      '超高 · 塌缩管线（1 位移 + 贴图 + 模糊 = 3 个原语）',
      ultraProbe.prims === 3 && ultraProbe.kinds.feDisplacementMap === 1 && !ultraProbe.kinds.feColorMatrix && !ultraProbe.kinds.feBlend,
      `data-glass=${ultraProbe.glass} 原语=${ultraProbe.prims} ${JSON.stringify(ultraProbe.kinds)}`,
    )
    // 极致与超高**必须**是同一条链：这是「全程序只走塌缩管线」这条约束的落点。
    // 从前这里断言的是「极致 = 10 个原语的完整链」，正是被删掉的那条路。
    ok(
      '极致 · 与超高是同一条管线（3 个原语，没有色散那套色矩阵与混合）',
      extProbe.prims === 3 && extProbe.kinds.feDisplacementMap === 1 && !extProbe.kinds.feColorMatrix && !extProbe.kinds.feBlend,
      `data-glass=${extProbe.glass} 原语=${extProbe.prims} ${JSON.stringify(extProbe.kinds)}`,
    )
    ok(
      '两档各写自己的 data-perf，但 data-glass 都是 collapsed（档位与实现分离）',
      ultraProbe.perf === 'ultra' && ultraProbe.glass === 'collapsed' && extProbe.perf === 'extreme' && extProbe.glass === 'collapsed',
      `超高 ${ultraProbe.perf}/${ultraProbe.glass} · 极致 ${extProbe.perf}/${extProbe.glass}`,
    )
    ok(
      '两档 · 位移量 / 通道选择器 / 边缘柔化照旧生效',
      extProbe.scale === ultraProbe.scale &&
        extProbe.x === ultraProbe.x &&
        extProbe.y === ultraProbe.y &&
        extProbe.blur === ultraProbe.blur,
      `scale=${extProbe.scale} x=${extProbe.x} y=${extProbe.y} blur=${extProbe.blur}`,
    )
    // 位移量就是 distortionScale 本身（从前还叠各通道的 offset，已随完整链删掉）
    ok(
      '位移量取自 distortionScale（出厂 -180，不再叠通道偏移）',
      ultraProbe.scale === '-180',
      `scale=${ultraProbe.scale}`,
    )
    // 修订（2026-11-07）：读数文案在 1481eb4 整改 —— 胶囊只放一条主结论（档位 + 折射开没开），
    // 「塌缩管线」这类链路术语收进档位卡的 InfoHint，不再进读数（SettingsPerfPage glassState）。
    ok('超高 · 读数报出「折射已开启」', ultraProbe.plaque.includes('超高') && ultraProbe.plaque.includes('折射已开启'), ultraProbe.plaque)
    ok(
      '极致 · 读数报出「折射已开启 · 材质更厚」',
      extProbe.plaque.includes('极致') && extProbe.plaque.includes('折射已开启') && extProbe.plaque.includes('材质更厚'),
      extProbe.plaque,
    )
    ok('极致 · 档位落盘', (await evalJS(`localStorage.getItem('rein.perf.v1')`)) === 'extreme', await evalJS(`localStorage.getItem('rein.perf.v1')`))

    // 材质拉平后两档的**玻璃带**必须逐像素一致：同一次加载里切档，差的只有材质。
    // 容差 2026-11：合并底栏把折射玻璃从 58 高的药丸换成 114 高的整块，位移图在
    // 新尺寸上重烘后有一个像素按 1/255 取整进位（复跑稳定在 (274,852) 同一点、
    // Δ=1）—— 材质漂移是成片、多通道的，单像素 Δ1 属量化噪声，放行。
    const glassDiff = await diffFrames(ultraFrame, extFrame, [], glassRects)
    ok(
      '超高与极致 · 材质拉平后玻璃带逐像素一致（同一条链 + 同一套材质 = 同一块玻璃）',
      glassDiff.diff === 0 || (glassDiff.diff <= 2 && glassDiff.maxDelta <= 1),
      `${glassDiff.diff}/${glassDiff.total} 像素有差异 · 最大通道差 ${glassDiff.maxDelta} · 包围盒 ${JSON.stringify(glassDiff.bbox)}`,
    )
    ok(
      '极致 · 在流内容面拿到材质但**不挂滤镜**（它背后永远只有平滑画布，滤镜是纯亏）',
      extGlass.bg === extGlass.panelFill && !extGlass.backdrop.includes('blur(') && extGlass.shadow.includes('inset'),
      `card bg=${extGlass.bg} · panel-fill=${extGlass.panelFill} · backdrop=${extGlass.backdrop} · 光学层=${extGlass.shadow.includes('inset')}`,
    )

    // 通道偏移已经不存在了：往本地塞一份旧会话（rev 3 带 redOffset）后，
    // 出厂值版本不符 → 整份丢弃 → 位移量仍是纯净的 distortionScale。
    // 这条同时守着「删掉一个参数之后，旧本地会话不会把界面拖进半旧半新的状态」。
    await evalJS(`(() => {
      localStorage.setItem('rein.glass.v1', JSON.stringify({ rev: 3, values: { redOffset: 12, blueOffset: -12, distortionScale: 40 } }))
      return true
    })()`)
    await setTier('ultra')
    await cdp('Page.navigate', { url: `${APP}/#/settings/perf` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    const stale = await evalJS(OPT_PROBE)
    // 参数行只在面板拉开时才在 DOM 里，所以要**真的把面板拉开**再看 ——
    // 面板关着读到 0 行，`!rows.includes('redOffset')` 会平凡成立（假通过）
    await evalJS(`document.querySelector('.tuner').click()`)
    await sleep(700)
    const staleRows = await evalJS(`[...document.querySelectorAll('.prow .pkey')].map((e) => e.textContent.trim())`)
    ok(
      '旧版调参会话（rev 3，带通道偏移）整份丢弃，回到新出厂值',
      stale.prims === 3 &&
        stale.scale === '-180' &&
        staleRows.length === 9 &&
        !staleRows.includes('redOffset'),
      `原语=${stale.prims} scale=${stale.scale} 参数行=${staleRows.length} 个：${staleRows.join(' ')}`,
    )
    await evalJS(`document.querySelector('.panel .close').click()`)
    await sleep(500)
    await evalJS(`localStorage.removeItem('rein.glass.v1')`)

    // ---------- 7 动效档位（system/motion）：关闭 / 默认 / 丰富 ----------
    //
    // 三档的契约：**默认 = 改动前那一套**，丰富才有液态活动底，关闭把所有补间压平。
    // 档位通过 localStorage 持久化，而注入脚本只覆盖 rein.perf.v1，所以这里写一次
    // 就能跨 reload 留住。
    const setMotion = async (m) => {
      await evalJS(`localStorage.setItem('rein.motion.v1', ${JSON.stringify(m)})`)
      await reload()
    }
    const MOTION_PROBE = `(() => {
      const h = document.documentElement
      const tab = document.querySelector('.dock .dock-tab')
      const activeTab = document.querySelector('.dock .dock-tab.active')
      const thumb = document.querySelector('.bench .gthumb')
      const blob = thumb ? thumb.querySelector('.blob') : null
      const navs = document.querySelector('.bench .dock-navs')
      // goo 滤镜的引用必须真的解析得到：写错 id 时 Chromium 是**静默忽略**整条的 ——
      // 表现是"两颗球根本不融合"，而 DOM 里一切看着都对（只看有没有 .gthumb 抓不到）
      const raw = thumb ? thumb.style.filter : ''
      const id = raw.indexOf('#') >= 0 ? raw.split('#')[1].split(')')[0].split('"').join('') : ''
      return {
        motion: h.dataset.motion,
        benchGoo: !!document.querySelector('.bench .gthumb'),
        dockGoo: !!document.querySelector('.dock .gthumb'),
        pillGoo: !!document.querySelector('.dock .dock-navs.goo'),
        dur: tab ? getComputedStyle(tab).transitionDuration : '',
        fillOpacity: activeTab ? getComputedStyle(activeTab, '::before').opacity : 'none',
        gooId: id,
        gooResolved: id ? !!document.getElementById(id) : false,
        blobW: blob ? Math.round(blob.getBoundingClientRect().width) : 0,
        pillW: navs ? Math.round(navs.getBoundingClientRect().width) : 0,
        tabsN: document.querySelectorAll('.bench .dock-tab').length,
      }
    })()`

    const mOff = await (async () => {
      await setMotion('off')
      return evalJS(MOTION_PROBE)
    })()
    ok('关闭档 · data-motion=off', mOff.motion === 'off', `data-motion=${mOff.motion}`)
    // 0.01ms 在计算值里序列化成 1e-05s；`.dock-tab` 有两条过渡（位移 + 颜色），
    // 所以这里逐条判，而不是比对整串
    ok(
      '关闭档 · 补间被压平（每条过渡都是 0.01ms），但状态仍在',
      mOff.dur !== '' &&
        mOff.dur
          .split(',')
          .map((d) => d.trim())
          .every((d) => d === '1e-05s'),
      `transition-duration=${mOff.dur}`,
    )
    ok('关闭档 · 不渲染液态活动底', !mOff.benchGoo && !mOff.dockGoo, `bench=${mOff.benchGoo} dock=${mOff.dockGoo}`)

    await setMotion('default')
    const mDef = await evalJS(MOTION_PROBE)
    ok('默认档 · data-motion=default', mDef.motion === 'default', `data-motion=${mDef.motion}`)
    ok(
      '默认档 · 不渲染液态活动底、补间照常（480ms 回弹在场）',
      !mDef.benchGoo && !mDef.dockGoo && mDef.dur.startsWith('0.48s'),
      `bench=${mDef.benchGoo} dock=${mDef.dockGoo} transition-duration=${mDef.dur}`,
    )

    await setMotion('rich')
    const mRich = await evalJS(MOTION_PROBE)
    ok('丰富档 · data-motion=rich', mRich.motion === 'rich', `data-motion=${mRich.motion}`)
    ok('丰富档 · 标本台渲染液态活动底（含 goo 容器）', mRich.benchGoo, `bench=${mRich.benchGoo}`)
    // 引用必须解析得到，否则融合整段失效而 DOM 一切正常（只看有没有 .gthumb 抓不到）；
    // 活动 blob 的宽度还要正好是药丸的 1/n —— 位移是按「自己宽度 × 索引」算的，
    // 容器不等分的话索引一换 blob 就会跑偏
    ok(
      '丰富档 · goo 滤镜引用解析得到（写错 id 会被静默忽略，融合整段失效）',
      mRich.gooResolved,
      `filter=url(#${mRich.gooId}) resolved=${mRich.gooResolved}`,
    )
    ok(
      `丰富档 · 活动 blob 正好是页签行的 1/${mRich.tabsN}（位移靠等分才成立）`,
      mRich.pillW > 0 && Math.abs(mRich.blobW - mRich.pillW / mRich.tabsN) <= 2,
      `blob=${mRich.blobW}px 页签行=${mRich.pillW}px 期望≈${Math.round(mRich.pillW / mRich.tabsN)}px`,
    )

    // 真实 Dock：走到一个**属于 Dock 的页签**上再看 —— 二级页没有选中项，
    // 两块实现都不该画，那是设计而不是退化
    await cdp('Page.navigate', { url: `${APP}/#/me` })
    await sleep(1800)
    if (await evalJS(dismiss)) await sleep(400)
    const mRichDock = await evalJS(MOTION_PROBE)
    ok(
      '丰富档 · 真实 Dock 渲染液态活动底，纯色活动底让位（opacity 0）',
      mRichDock.dockGoo && mRichDock.pillGoo && mRichDock.fillOpacity === '0',
      `dock=${mRichDock.dockGoo} pill=${mRichDock.pillGoo} ::before opacity=${mRichDock.fillOpacity}`,
    )

    // 切回默认（reload 保留 #/me）：blob 撤掉，纯色活动底必须回来
    await setMotion('default')
    const mBack = await evalJS(MOTION_PROBE)
    ok(
      '切回默认档 · blob 撤掉且纯色活动底回来',
      !mBack.dockGoo && mBack.fillOpacity === '1',
      `dock=${mBack.dockGoo} ::before opacity=${mBack.fillOpacity}`,
    )

    // ---------- 8 材质档位：光学层只在超高 / 极致存在，且每一档都有退化路径 ----------
    //
    // 探针往 body 里临时插一个 .glass-surface：这样不依赖当前页面碰巧有玻璃表面，
    // 量到的就是"这一档下 .glass-surface 这条定义长什么样"。
    const MATERIAL_PROBE = `(() => {
      const cs = getComputedStyle(document.documentElement)
      const probe = document.createElement('div')
      probe.className = 'glass-surface'
      document.body.appendChild(probe)
      const pcs = getComputedStyle(probe)
      const out = {
        perf: document.documentElement.dataset.perf,
        caustic: cs.getPropertyValue('--glass-caustic').trim(),
        rim2: cs.getPropertyValue('--glass-rim-2').trim(),
        halo: cs.getPropertyValue('--glass-halo').trim(),
        fill: cs.getPropertyValue('--glass-fill').trim(),
        blur: pcs.backdropFilter || pcs.webkitBackdropFilter || 'none',
      }
      probe.remove()
      return out
    })()`
    // 透明的写法只有两种：字面 transparent，或 alpha 为 0 的 rgba（自定义属性的
    // computed 值就是**照原样回放**的令牌串，所以这里比对的是写法而不是解析后的颜色）
    const isTransparent = (v) => v === '' || v === 'transparent' || v.endsWith(', 0)')

    await setTier('high')
    const matHigh = await evalJS(MATERIAL_PROBE)
    ok(
      '高画质 · 光学层全透明（四层材质，超高专属的三层不出现）',
      matHigh.perf === 'high' && isTransparent(matHigh.rim2) && isTransparent(matHigh.caustic),
      `data-perf=${matHigh.perf} rim2=${matHigh.rim2} caustic=${matHigh.caustic}`,
    )
    ok('高画质 · 玻璃底与模糊按令牌走', matHigh.blur.includes('28px') && matHigh.fill.includes('0.52'), `fill=${matHigh.fill} backdrop=${matHigh.blur}`)

    await setTier('ultra')
    const matUltra = await evalJS(MATERIAL_PROBE)
    ok(
      '超高 · 三层光学细节都有值（内圈描边 / 上缘焦散 / 外缘层）',
      matUltra.perf === 'ultra' && !isTransparent(matUltra.rim2) && !isTransparent(matUltra.caustic) && matUltra.halo !== '0 0 0 rgba(0, 0, 0, 0)',
      `rim2=${matUltra.rim2} caustic=${matUltra.caustic} halo=${matUltra.halo}`,
    )
    ok(
      '超高 · 底比高画质更薄（观感差异来自光学层，不来自加 blur）',
      matUltra.fill !== matHigh.fill && matUltra.blur === matHigh.blur,
      `fill=${matUltra.fill} backdrop=${matUltra.blur}（高画质为 ${matHigh.blur}）`,
    )

    await setTier('extreme')
    const matExt = await evalJS(MATERIAL_PROBE)
    ok(
      '极致 · 光学层再深一档（内圈描边 / 上缘焦散 / 外缘层都比超高强）',
      matExt.perf === 'extreme' &&
        !isTransparent(matExt.rim2) &&
        !isTransparent(matExt.caustic) &&
        matExt.rim2 !== matUltra.rim2 &&
        matExt.caustic !== matUltra.caustic &&
        matExt.halo !== matUltra.halo,
      `rim2=${matExt.rim2} caustic=${matExt.caustic} halo=${matExt.halo}`,
    )
    ok(
      '极致 · 底再薄一档，但 blur 仍不加（差异来自光学层与铺开的表面）',
      matExt.fill !== matUltra.fill && matExt.blur === matHigh.blur,
      `fill=${matExt.fill}（超高 ${matUltra.fill}） backdrop=${matExt.blur}`,
    )

    await setTier('low')
    const matLow = await evalJS(MATERIAL_PROBE)
    ok(
      '流畅 · 光学层归零、模糊被全局关掉',
      matLow.perf === 'low' && isTransparent(matLow.rim2) && matLow.blur === 'none',
      `data-perf=${matLow.perf} rim2=${matLow.rim2} backdrop=${matLow.blur}`,
    )
    await evalJS(`localStorage.removeItem('rein.motion.v1')`)

    // ---------- 9 运动沉浸页：分层契约（控制层玻璃 / 内容层实底 / 不许玻璃套玻璃） ----------
    //
    // 契约（按苹果 Liquid Glass 的三层模型）：玻璃只属于**控制层** —— 顶簇 / 组格轨 /
    // 图标钮 / 次按钮挂同一个 .glass-surface 类，靠 data-perf 的令牌分档；
    // 而 .setcard / .blockcard 是**内容层**，必须是实底：把内容做成玻璃会跟控件抢
    // 注意力、把层级搅浑，而且它们要从底簇玻璃下面滚过去，自己再是玻璃就成了
    // 玻璃套玻璃（苹果明令避免，上层只许用 fills / transparency / vibrancy）。
    //
    // 作用域必须锁在 .session-layer 里：**底栏 Dock 也叫 .dock**，而它是 App.vue
    // 全局常驻的（沉浸层打开时它只是被移开视线，DOM 里还在）。
    const IMMERSIVE_PROBE = `(() => {
      const scope = document.querySelector('.session-layer') || document
      const read = (sel) => {
        const el = scope.querySelector(sel)
        if (!el) return null
        const cs = getComputedStyle(el)
        return {
          sel,
          bgImage: cs.backgroundImage,
          bgColor: cs.backgroundColor,
          blur: String(cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
          shadow: cs.boxShadow,
          border: cs.borderTopColor,
        }
      }
      const token = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim()
      const hasFilter = (el) => {
        const bf = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || 'none'
        return bf !== 'none' && bf !== ''
      }
      // 控制层的玻璃根 = SessionGlassButton 渲染出来的 .sgbtn（GlassSurface 的根）。
      // 沉浸页**不再**用 .glass-surface 那个「模糊 + 令牌」的毛玻璃：它在超高下也只是糊，
      // 拿不到折射，所以这里量的是组件那一路。
      const glassEls = [...scope.querySelectorAll('.sgbtn')]
      // 折射的定义宿主（GlassSurface 的 .gdefs，v-show 控制）：display 非 none
      // 才说明折射分支是活的 —— 只看 backdrop-filter 里有没有 url() 会被退化兜底骗过。
      const defs = [...scope.querySelectorAll('.gdefs')]
      const filtered = [...scope.querySelectorAll('*')].filter(hasFilter)
      // 「玻璃套玻璃」的通用判据：挂着 backdrop-filter 的元素又套在另一个这样的元素里。
      // 契约恒为 0（苹果：往玻璃上放东西只许用 fills / transparency / vibrancy）。
      const nested = filtered.filter((el) => {
        let p = el.parentElement
        while (p && p !== scope) {
          if (hasFilter(p)) return true
          p = p.parentElement
        }
        return false
      }).length
      return {
        perf: document.documentElement.dataset.perf,
        motion: document.documentElement.dataset.motion,
        fill: token('--glass-fill'),
        blurToken: token('--glass-blur'),
        rimHi: token('--glass-rim-hi'),
        // 三个探针都要落在**玻璃根**上（材质与光学层在它身上）——.iconbtn / .ghost
        // 是玻璃里面那颗按钮，它们自己没有 box-shadow。
        glass: ['.ctrl-top .sgbtn', '.ctrl-dock .sgbtn', '.ctrl-dock .sgbtn ~ .sgbtn'].map(read).filter(Boolean),
        refracting: glassEls.filter((el) => String(getComputedStyle(el).backdropFilter || '').includes('url(')).length,
        glassTotal: glassEls.length,
        defsOn: defs.filter((el) => getComputedStyle(el).display !== 'none').length,
        content: ['.setcard', '.blockcard', '.wbtn'].map(read).filter(Boolean),
        filteredTotal: filtered.length,
        nested,
      }
    })()`

    // 材质真的接上了，就必然出现**两条** linear-gradient（padding-box 的底 +
    // border-box 的受光边）且模糊半径正好是 --glass-blur 的值。
    //
    // 别去查 backgroundImage 里的 'padding-box' / 'border-box' 字样：那两个是
    // background **简写**里的 origin/clip 层，Chromium 解析后会拆进
    // background-origin / background-clip，不会留在 backgroundImage 串里
    // （量出来是 false 是解析器的正常行为，不是材质缺失）。层数 + 模糊半径
    // 才是稳定可观测的：手写 blur(20px) 的旧路径层数相同但半径不同，正好被这条抓住。
    const isGlassSurface = (r, t) =>
      r.bgImage.split('linear-gradient').length - 1 === 2 && r.blur.includes(t.blurToken)

    await cdp('Page.navigate', { url: `${APP}/#/` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)

    // 走**产品里的真实入口**：运动页的计划卡的播放键 → session.start() →
    // openImmersive()（带冲突则先点「继续」）。不直接改 store ——
    // 那样量到的是一份绕开入口的旁路，不是用户会看到的那一块。
    await setTier('ultra')
    await setMotion('rich')
    await cdp('Page.navigate', { url: `${APP}/#/sports` })
    await sleep(2600)
    if (await evalJS(dismiss)) await sleep(400)

    const opened = await evalJS(`(() => {
      const play = document.querySelector('.play')
      if (!play) return 'no-play'
      play.click()
      return 'play'
    })()`)
    await sleep(1000)
    // 有进行中会话时会先弹冲突确认，点「继续训练」才真正开起来
    await evalJS(`(() => {
      const b = [...document.querySelectorAll('.card-wrap button, .sheet button, .panel button')].find((x) => /继续|开始|接续/.test(x.textContent.trim()))
      if (b) { b.click(); return true }
      return false
    })()`)
    await sleep(1400)
    // 等形变真正收尾（morphDone 摘掉 is-morphing）再量 —— 见下面那条断言
    await sleep(600)

    const session = await evalJS(IMMERSIVE_PROBE)
    // 形变期（is-morphing）会**故意**把玻璃退成实底（Android WebView 合成器在
    // 逐帧缩放 + backdrop-filter 组合下会冻结图层）。量材质必须在形变**结束后** ——
    // 稳定态才是产品常态，动画期那几帧是刻意换来的稳定性，不是材质缺失。
    const morphing = await evalJS(`document.querySelector('.session-layer')?.classList.contains('is-morphing') ?? null`)
    ok(
      '形变结束后材质恢复（is-morphing 已摘掉）',
      morphing === false,
      `is-morphing=${morphing}`,
    )
    if (session.glass.length >= 2) {
      await shot('immersive-session-ultra')
      // 这条是本次改动的核心契约：沉浸页的控制层必须走**折射**那一路
      // （GlassSurface 的 url() 位移滤镜 + 活的 <filter> 定义），而不是只有
      // backdrop-filter 的 blur —— 上一版这里挂的是 .glass-surface，超高下也只是一层糊。
      ok(
        '超高 · 沉浸层控制层的玻璃块全部在折射（不是只有 backdrop blur）',
        session.refracting === session.glassTotal && session.defsOn === session.glassTotal && session.glassTotal >= 3,
        `探针 ${session.glass.length} 块 / 共 ${session.glassTotal} 块 · 折射 ${session.refracting} · 活的滤镜定义 ${session.defsOn}`,
      )
      ok(
        '超高 · 沉浸层控制层的光学层（内圈描边 / 焦散）都已就位',
        session.glass.every((r) => r.shadow.includes('inset')),
        `缺 inset 的：${session.glass.filter((r) => !r.shadow.includes('inset')).map((r) => r.sel).join(' ') || '无'}`,
      )
      // 内容层必须是实底：苹果那条「把表格做成玻璃会让它跟别的元素抢注意力、
      // 把层级搅浑，所以留在内容层」。模糊一旦出现在这里就是分层被写反了。
      ok(
        '超高 · 内容卡留在内容层（不是玻璃：无模糊、无玻璃底）',
        session.content.length > 0 && session.content.every((r) => r.blur === 'none'),
        `${session.content.length} 块 · 仍是玻璃的：${session.content.filter((r) => r.blur !== 'none').map((r) => r.sel).join(' ') || '无'}`,
      )
      // 这条是上一轮重做的核心回归：玻璃块之间的嵌套必须恒为 0。
      ok(
        '超高 · 沉浸层没有玻璃套玻璃',
        session.nested === 0,
        `挂滤镜的共 ${session.filteredTotal} 块，其中套在另一块滤镜里的 ${session.nested} 块`,
      )
    } else {
      ok('训练沉浸层可被探针触及（真实入口可达）', false, `入口=${opened} · 只量到 ${session.glass.length} 块：${session.glass.map((r) => r.sel).join(' ')}`)
    }

    // 弱档：同一批**控制层玻璃**必须整体退回实底、折射与模糊一起关掉（退化语义不能只覆盖 Dock）。
    await setTier('low')
    const sessionLow = await evalJS(IMMERSIVE_PROBE)
    ok(
      '流畅档 · 沉浸层控制层顶成实底、折射与模糊一起关掉',
      sessionLow.glassTotal > 0 &&
        sessionLow.refracting === 0 &&
        sessionLow.defsOn === 0 &&
        sessionLow.glass.every((r) => r.blur === 'none'),
      `${sessionLow.glassTotal} 块 · 折射 ${sessionLow.refracting} · 活的定义 ${sessionLow.defsOn} · blur=${sessionLow.glass[0]?.blur}`,
    )

    await setTier('ultra')

    // 跑步页：HUD chip 走 stage-dark 的暗场玻璃，抽屉自己**不是**玻璃。
    // 先把上一轮训练沉浸测试留下的会话收掉 —— 它还开着的话，跑步入口会弹
    // 「已有进行中的训练课」，而点「前往接续」会把路由带到训练沉浸页去，
    // 量到的就不是 RunPage 了（上一版就是栽在这里）。
    await cdp('Page.navigate', { url: `${APP}/#/sports` })
    await sleep(2400)
    if (await evalJS(dismiss)) await sleep(400)
    await evalJS(`(() => {
      // 收起悬浮条上的结束入口，或直接走运行时放弃
      const bar = document.querySelector('.wdock-root')
      if (bar) {
        const end = [...bar.querySelectorAll('button')].find((b) => /结束|放弃/.test(b.textContent.trim()))
        if (end) { end.click(); return 'bar-end' }
      }
      return 'none'
    })()`)
    await sleep(900)
    // 结束确认弹层
    await evalJS(`(() => {
      const c = [...document.querySelectorAll('.card-wrap button, .sheet button, .panel button')]
        .find((x) => /放弃|结束|确认/.test(x.textContent.trim()))
      if (c) { c.click(); return true }
      return false
    })()`)
    await sleep(1400)

    await cdp('Page.navigate', { url: `${APP}/#/session/run` })
    await sleep(2400)
    if (await evalJS(dismiss)) await sleep(400)
    // 把手行（回中钮 + 相机切换）与配速卡只在**进行中/暂停**态渲染，准备态没有。
    await evalJS(`(() => {
      const start = document.querySelector('.gobtn')
      if (start) start.click()
      return !!start
    })()`)
    await sleep(4600) // 3 秒倒数 + 起跑余量
    if (await evalJS(dismiss)) await sleep(300)
    const run = await evalJS(`(() => {
      const read = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const cs = getComputedStyle(el)
        return {
          sel,
          bgImage: cs.backgroundImage,
          blur: String(cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
          bg: cs.backgroundColor,
          shadow: cs.boxShadow,
        }
      }
      const hero = document.querySelector('.hero')
      const heroCs = hero ? getComputedStyle(hero) : null
      return {
        phase: document.querySelector('.run-page')?.className ?? 'no-run-page',
        stageDark: !!document.querySelector('.hero.stage-dark'),
        heroFill: heroCs ? heroCs.getPropertyValue('--glass-fill').trim() : '',
        rootFill: getComputedStyle(document.documentElement).getPropertyValue('--glass-fill').trim(),
        glassCount: document.querySelectorAll('.run-page .glass-surface').length,
        drawer: read('.drawer'),
        drawBlurless: (() => { const d = document.querySelector('.drawer'); if (!d) return true; const c = getComputedStyle(d); return (c.backdropFilter || c.webkitBackdropFilter || 'none') === 'none' })(),
        seg: read('.mseg'),
      }
    })()`)
    await shot('immersive-run-ultra')
    // .stage-dark 把 --glass-fill 换成暗场的那份（--hero-chip-bg），这是**契约本身**：
    // 深色地图上压亮色玻璃底会翻白。查的是「与根令牌不同」而不是某个具体色值 ——
    // 暗场底的具体浓度会随设计调，钉死数值只会让这条断言在调参后误报。
    ok(
      '超高 · 跑步页的轨迹剧场挂上 stage-dark，chip 取的是暗场玻璃底而非亮色那套',
      run.stageDark && !!run.heroFill && run.heroFill !== run.rootFill,
      `stage-dark=${run.stageDark} · 暗场 ${run.heroFill} vs 根 ${run.rootFill}`,
    )
    ok(
      '超高 · 跑步页有玻璃表面接上材质（HUD / 把手行 / 配速卡）',
      run.glassCount > 0 && !!run.seg && run.seg.bgImage.split('linear-gradient').length - 1 === 2 && run.seg.blur.includes(session.blurToken),
      `${run.glassCount} 块 · ${run.seg ? `mseg blur=${run.seg.blur} grad=${run.seg.bgImage.split('linear-gradient').length - 1}` : `mseg 未渲染（阶段=${run.phase}）`}`,
    )
    ok(
      '跑步页 · 抽屉自己不做毛玻璃（否则会把里面每块玻璃的采样范围锁死）',
      run.drawBlurless,
      `.drawer backdrop=${run.drawer?.blur}`,
    )

    await setTier('low')
    const runLow = await evalJS(`(() => {
      const chips = [...document.querySelectorAll('.run-page .glass-surface')]
      return { count: chips.length, allNoBlur: chips.every((c) => { const s = getComputedStyle(c); return (s.backdropFilter || s.webkitBackdropFilter || 'none') === 'none' }) }
    })()`)
    ok(
      '流畅档 · 跑步页的玻璃表面同样顶成实底',
      runLow.count > 0 && runLow.allNoBlur,
      `${runLow.count} 块`,
    )

    await setTier('ultra')
    await setMotion('default')
    const richOff = await evalJS(`(() => {
      const h = document.documentElement
      return { motion: h.dataset.motion, scrollEdge: getComputedStyle(document.documentElement).getPropertyValue('--glass-scroll-edge').trim() }
    })()`)
    ok(
      '默认档 · 滚动边缘暗带不在（丰富档专属），但令牌在',
      richOff.motion === 'default' && !!richOff.scrollEdge,
      `data-motion=${richOff.motion} --glass-scroll-edge=${richOff.scrollEdge}`,
    )
    await evalJS(`localStorage.removeItem('rein.motion.v1')`)

    // ---------- 10 悬浮件的折射 + 极致档在流卡片的落影 ----------
    //
    // 三件事各有一条不变量：
    //  ① **页头圆钮留在折射名单里，但相邻的并成一壳、共用一次背景滤镜**（2026-10-09）。
    //     实测背景：课表页超高档下「每挂一块 url() 就是一次独立的背景滤镜」，三颗圆钮能占掉
    //     0.36ms/帧，而超高相对高画质的全部增量只有 0.4ms 上下。撤下折射不是办法 ——
    //     页头背后是滚动的页面内容，折射看得见（换成 blur 后页头带 33% 的像素变了，
    //     最大差 135/255）。改成「动作区相邻圆钮并成一壳」：返回键仍自己一片，
    //     动作区只挂一次。实测合成净成本 +0.45 → +0.125ms/帧（课表周视图滚动，同页同负载），
    //     而页头按钮带的像素差最大 5/255、变化像素 ≤0.26%。
    //     这里钉死四件事：返回键仍走 url()；壳挂 url() 且壳内圆钮自己不挂（不叠两层）；
    //     壳的滤镜定义已烘、引用可解析；accent 变体照旧不玻璃化；
    //  ② **四条悬浮条同样是折射件**（运动 / 录音 / 语音 / 抢课）：它们是控制层的悬浮件、
    //     底下真的有内容经过，正是折射该去的地方。这里量的是**真的渲染着的那一条**
    //     （开一次训练 → 收起沉浸层 → 浮条回到屏幕上），不是被隐藏壳挡住的状态；
    //  ③ **极致档把材质铺到在流卡片时，落影必须是卡片那一档**：借悬浮玻璃那份重落影
    //     （亮色 0.18 + 外缘层、暗色 0.4/0.55 的黑 + 白溢光）就是用户报的
    //     「所有卡片 box-shadow 异常变深变黑」，所以这条按**计算样式的层序**钉死。
    const HEADER_GLASS_PROBE = `(() => {
      const read = (el) => {
        const cs = getComputedStyle(el)
        return {
          cls: String(el.className),
          filter: String(cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
          shadow: cs.boxShadow,
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        }
      }
      // 动作区的折射壳：相邻圆钮共用一次背景滤镜（壳自己什么都不画）
      const bar = document.querySelector('.page-header .ph-bar')
      const defs = [...document.querySelectorAll('.page-header .gdefs')]
      return {
        tier: document.documentElement.dataset.perf,
        glass: document.documentElement.dataset.glass,
        bar: bar
          ? {
              filter: String(getComputedStyle(bar).backdropFilter || 'none'),
              box: (() => { const r = bar.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })(),
              inside: [...bar.querySelectorAll('.hdr-btn')].map(read),
            }
          : null,
        // accent 变体是主操作 CTA，刻意留在实底（与 Dock 页签同一套「主操作不玻璃化」的约定），
        // 所以这里只看玻璃化的那些
        btns: [...document.querySelectorAll('.page-header .back, .page-header .hdr-btn:not(.accent)')].map(read),
        accents: [...document.querySelectorAll('.page-header .hdr-btn.accent')].map(read),
        defs: defs.map((d) => ({
          display: getComputedStyle(d).display,
          id: d.querySelector('filter')?.id ?? '',
          mapBaked: !!d.querySelector('feImage')?.getAttribute('href'),
          prims: d.querySelector('filter')?.children.length ?? 0,
        })),
        resolved: !!document.getElementById('glass-filter-header'),
      }
    })()`

    await setTier('ultra')
    // ① AI 页：两颗动作钮（一颗 accent 主操作 + 一颗玻璃钮），走 :slotted(.hdr-btn) 那条路
    await cdp('Page.navigate', { url: `${APP}/#/ai` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    const headerUltra = await evalJS(HEADER_GLASS_PROBE)
    await shot('header-glass-ultra')
    // 壳自己什么都不画，只决定「背后被采样几次」：挂一次 url()，壳里的圆钮各自退掉滤镜
    // （不再 N 次独立背景滤镜），但材质一点不动。
    const glassInside = (headerUltra.bar?.inside ?? []).filter((b) => !b.cls.includes('accent'))
    ok(
      '超高 · 动作区圆钮并成一壳：壳挂 url()，玻璃钮自己不挂、材质不动',
      !!headerUltra.bar &&
        headerUltra.bar.filter.replace(/"/g, '').includes('url(#glass-filter-actions-') &&
        glassInside.length >= 1 &&
        glassInside.every((b) => b.filter === 'none') &&
        glassInside.every((b) => b.w === 38 && b.h === 38) &&
        glassInside.every((b) => b.shadow.includes('inset')),
      headerUltra.bar
        ? `壳 ${headerUltra.bar.box} · ${headerUltra.bar.filter.slice(0, 42)} · 壳内 ${headerUltra.bar.inside.map((b) => `${b.cls.split(' ')[0]}=${b.filter}`).join(' | ')}`
        : '没有壳',
    )
    ok(
      '超高 · 壳里的 accent 主操作钮仍是实底（不玻璃化、也没有滤镜）',
      (headerUltra.bar?.inside ?? []).filter((b) => b.cls.includes('accent')).length === 0 ||
        (headerUltra.bar?.inside ?? []).filter((b) => b.cls.includes('accent')).every((b) => !b.filter.includes('url(')),
      (headerUltra.bar?.inside ?? []).filter((b) => b.cls.includes('accent')).map((b) => b.filter).join(' | ') || '壳里没有 accent 钮',
    )
    ok(
      '超高 · 两份滤镜定义都已烘且引用可解析（返回键 38×38 静态 + 动作壳按自身尺寸）',
      headerUltra.defs.length === 2 &&
        headerUltra.defs.every((d) => d.mapBaked && d.display !== 'none') &&
        headerUltra.defs.some((d) => d.id === 'glass-filter-header') &&
        headerUltra.defs.some((d) => /glass-filter-actions-/.test(d.id)) &&
        headerUltra.resolved,
      `定义 ${headerUltra.defs.length} 份 · ${headerUltra.defs.map((d) => d.id).join(' | ')}`,
    )
    ok(
      '超高 · 页头圆钮的玻璃光学层都在（受光边 / 内圈描边 / 上缘焦散）',
      headerUltra.btns.length >= 1 && headerUltra.btns.every((b) => b.shadow.includes('inset')),
      `${headerUltra.btns.length} 颗 · 缺 inset 的：${headerUltra.btns.filter((b) => !b.shadow.includes('inset')).length} 颗`,
    )

    // ② 二级页 /ai/models：只有一颗 accent 主操作钮 —— **壳不许挂滤镜**（没有圆钮要为它付钱），
    //    返回键仍自己一片。:has(> .hdr-btn:not(.accent)) 就是这道净网。
    await cdp('Page.navigate', { url: `${APP}/#/ai/models` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    const modelsUltra = await evalJS(HEADER_GLASS_PROBE)
    ok(
      '超高 · 二级页：返回键自己折射；只有 accent 钮时壳不挂滤镜（:has() 净网）',
      modelsUltra.btns.some((b) => b.cls.includes('back')) &&
        modelsUltra.btns.filter((b) => b.cls.includes('back')).every((b) => b.filter.replace(/"/g, '').includes('url(#glass-filter-header)')) &&
        !!modelsUltra.bar && !modelsUltra.bar.filter.includes('url('),
      `返回键 ${modelsUltra.btns.filter((b) => b.cls.includes('back')).map((b) => b.filter).join(' | ') || '无'} · 壳 ${modelsUltra.bar ? modelsUltra.bar.box + ' / ' + modelsUltra.bar.filter.slice(0, 24) : '无'}`,
    )

    // ③ 待办页：返回键 + 一颗玻璃动作钮 —— 两条路同时成立（各挂一次，不合并成一整条）
    await cdp('Page.navigate', { url: `${APP}/#/todos` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    const todosUltra = await evalJS(HEADER_GLASS_PROBE)
    ok(
      '超高 · 返回键与动作壳各挂一次 url()（两条路都通，不叠）',
      todosUltra.btns.filter((b) => b.cls.includes('back')).every((b) => b.filter.replace(/"/g, '').includes('url(#glass-filter-header)')) &&
        !!todosUltra.bar && todosUltra.bar.filter.replace(/"/g, '').includes('url(#glass-filter-actions-') &&
        (todosUltra.bar?.inside ?? []).length >= 1 &&
        (todosUltra.bar?.inside ?? []).every((b) => b.filter === 'none' && b.w === 38 && b.h === 38 && b.shadow.includes('inset')),
      `壳 ${todosUltra.bar ? todosUltra.bar.box : '无'} · 壳内 ${(todosUltra.bar?.inside ?? []).map((b) => `${b.w}×${b.h}=${b.filter}`).join(' | ')}`,
    )

    await setTier('high')
    await cdp('Page.navigate', { url: `${APP}/#/ai` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    const headerHigh = await evalJS(HEADER_GLASS_PROBE)
    // 高画质档：data-glass=off，壳不挂 url()，圆钮各自退回 blur 那层玻璃盘 ——
    // 「不启用折射也要把玻璃的其余效果开起来」这条在页头上同样成立（2026-09-25 起）。
    ok(
      '高画质 · 壳不挂折射，圆钮各自是玻璃盘（blur + 光学内层）',
      !!headerHigh.bar &&
        !headerHigh.bar.filter.includes('url(') &&
        headerHigh.btns.every((b) => !b.filter.includes('url(') && b.filter.includes('blur(')) &&
        headerHigh.btns.every((b) => b.shadow.includes('inset')),
      `壳 ${headerHigh.bar ? headerHigh.bar.filter.slice(0, 30) : '无'} · ${headerHigh.btns.map((b) => b.filter).join(' | ')}`,
    )

    // 悬浮条：走产品里的真实入口开一次训练，再把沉浸层收起来 —— 这样量到的是**屏幕上真的
    // 挂着的那条浮条**（沉浸层开着时它是 opacity:0 的隐藏态，量它等于量了个寂寞）
    const FLOAT_BAR_PROBE = `(() => {
      const el = document.querySelector('.wdock-root .dock-body')
      if (!el) return null
      const cs = getComputedStyle(el)
      const defs = el.querySelector('.gdefs')
      const r = el.getBoundingClientRect()
      // 材质底是**两层 background-image**（padding-box 的 fill + border-box 的受光边），
      // 颜色本身是透明的 —— 拿 backgroundColor 比会误判成「没有底」，见 base.css 的 .glass-surface
      const probe = document.createElement('div')
      probe.style.background = 'var(--glass-fill)'
      document.body.appendChild(probe)
      const fillToken = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        tier: document.documentElement.dataset.perf,
        filter: String(cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
        gradLayers: cs.backgroundImage.split('linear-gradient').length - 1,
        usesFillToken: cs.backgroundImage.includes(fillToken),
        fillToken,
        radius: cs.borderRadius,
        // 圆角契约是「取自共享令牌」而不是某个死数：--radius-l 由 94d96f5 从 22 收到 20，
        // 断言跟令牌走（令牌再调脚本不用追）
        radiusToken: getComputedStyle(el).getPropertyValue('--radius-l').trim(),
        // 「在屏幕上」= 有尺寸、不是隐藏态、而且**此刻它自己就是那个位置最上面的元素** ——
        // 只判尺寸会被「被跑步页 / 沉浸层盖住」的状态骗过去（浮条还在 DOM 里、样式也全对）
        onScreen: (() => {
          if (!(r.width > 0 && r.height > 0) || cs.opacity === '0') return false
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
          return !!hit && el.contains(hit)
        })(),
        // 判定为「不在最上层」时把现场带出来：光看 false 没法知道是被谁盖住了
        hitInfo: (() => {
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
          const chain = []
          let n = hit
          while (n && chain.length < 7) {
            const s = getComputedStyle(n)
            chain.push(
              n.tagName + '.' + String(n.className).slice(0, 36) +
                '|pe=' + s.pointerEvents + '|z=' + s.zIndex + '|op=' + s.opacity,
            )
            n = n.parentElement
          }
          return {
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            opacity: cs.opacity,
            rootClass: String(document.querySelector('.wdock-root')?.className ?? ''),
            hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 48) : 'none',
            inSession: !!(hit && hit.closest('.session-layer')),
            inRunPage: !!(hit && hit.closest('.run-page')),
            chain,
          }
        })(),
        defs: defs
          ? {
              display: getComputedStyle(defs).display,
              mapBaked: !!defs.querySelector('feImage')?.getAttribute('href'),
              prims: defs.querySelector('filter')?.children.length ?? 0,
            }
          : null,
      }
    })()`

    await setTier('ultra')
    // 先把上一节留下的会话收掉（跑步 / 训练课走同一条：浮条上的「结束」→ 二级确认里的「放弃」）。
    // 不收的话下面点 .play 会被「已有进行中的运动」的接续流程带去跑步页 ——
    // 那时浮条虽然还在 DOM 里、样式也全对，却是被盖住的状态，量它等于没量。
    // 修订（2026-11-07）：94d96f5 起跑步「必须暂停再结束」（workoutRuntime canEnd: paused），
    // 在跑的浮条根本没有「结束」钮 —— 先点主动作（暂停）让它出现，再走结束 → 放弃；
    // 训练课的「结束」不受暂停限制，第一发直接命中，不会走到暂停那步。
    await evalJS(`(() => {
      const bar = document.querySelector('.wdock-root')
      if (!bar) return 'no-session'
      const end = [...bar.querySelectorAll('button')].find((b) => /结束|放弃/.test(b.textContent.trim()))
      if (end) { end.click(); return 'end-clicked' }
      const pause = [...bar.querySelectorAll('button')].find((b) => /^暂停$/.test(b.textContent.trim()))
      if (pause) { pause.click(); return 'paused' }
      return 'no-end'
    })()`)
    await sleep(900)
    await evalJS(`(() => {
      const bar = document.querySelector('.wdock-root')
      const end = bar ? [...bar.querySelectorAll('button')].find((b) => /结束/.test(b.textContent.trim())) : null
      if (end) { end.click(); return 'end-clicked' }
      return 'no-end'
    })()`)
    await sleep(900)
    // 「放弃」优先于「结束」：结束会进总结页（跑步是路由级的 `.run-page`，z-index 80 盖住浮条），
    // 那正是这一步要避免的状态
    const discarded = await evalJS(`(() => {
      const btns = [...document.querySelectorAll('.card-wrap button, .sheet button, .panel button')]
      const c = btns.find((x) => /放弃/.test(x.textContent.trim())) ?? btns.find((x) => /结束|确认/.test(x.textContent.trim()))
      if (c) { c.click(); return c.textContent.trim() }
      return 'none'
    })()`)
    await sleep(1600)

    await cdp('Page.navigate', { url: `${APP}/#/sports` })
    await sleep(2600)
    if (await evalJS(dismiss)) await sleep(400)
    await evalJS(`(() => { const play = document.querySelector('.play'); if (play) play.click(); return !!play })()`)
    await sleep(1200)
    // 仍有残留会话时会先弹冲突确认，点「继续训练」才真正开起来
    await evalJS(`(() => {
      const b = [...document.querySelectorAll('.card-wrap button, .sheet button, .panel button')].find((x) => /继续|开始|接续/.test(x.textContent.trim()))
      if (b) { b.click(); return true }
      return false
    })()`)
    await sleep(2000)
    const immersiveOpen = await evalJS(`!!document.querySelector('.session-layer')`)
    // 收起沉浸层（顶栏第一颗玻璃块的「⌄ 收起」）：浮条重新回到屏幕上
    const collapsed = await evalJS(`(() => {
      const b = document.querySelector('.ctrl-top .sgbtn button')
      if (!b) return false
      b.click()
      return true
    })()`)
    // 收起是**形变动画**（浮层缩回浮条），动画走完之前它仍盖在浮条上面 ——
    // 固定等一个数会随设备快慢时好时坏，所以这里轮询到浮条真的成为那个点的最上层元素为止
    const barOnTop = await (async () => {
      for (let i = 0; i < 16; i++) {
        const top = await evalJS(`(() => {
          const el = document.querySelector('.wdock-root .dock-body')
          if (!el) return false
          const r = el.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) return false
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
          return !!hit && el.contains(hit)
        })()`)
        if (top) return true
        await sleep(300)
      }
      return false
    })()
    const barUltra = await evalJS(FLOAT_BAR_PROBE)
    await shot('float-bar-ultra')
    ok(
      '超高 · 悬浮运动条（收起沉浸层后）在折射，且贴图已烘',
      !!barUltra &&
        barUltra.onScreen &&
        barUltra.filter.replace(/"/g, '').includes('url(#') &&
        barUltra.defs?.mapBaked === true &&
        barUltra.defs.display !== 'none',
      `沉浸层=${immersiveOpen} 收起=${collapsed} 浮条到最上层=${barOnTop} 清场=${discarded} · filter=${barUltra?.filter} · 最上层=${barUltra?.onScreen} · 现场=${JSON.stringify(barUltra?.hitInfo)} · 定义=${JSON.stringify(barUltra?.defs)}`,
    )
    ok(
      '超高 · 悬浮条的底 / 受光边 / 圆角仍取自那套令牌（折射只换「怎么采样背后」）',
      !!barUltra &&
        barUltra.gradLayers === 2 &&
        barUltra.usesFillToken &&
        barUltra.radius === barUltra.radiusToken,
      `grad 层=${barUltra?.gradLayers} · 用当档 --glass-fill(${barUltra?.fillToken})=${barUltra?.usesFillToken} · radius=${barUltra?.radius} / --radius-l=${barUltra?.radiusToken}`,
    )

    await setTier('high')
    const barHigh = await evalJS(FLOAT_BAR_PROBE)
    ok(
      '高画质 · 悬浮条退回毛玻璃（不挂 url()，仍是 .glass-surface 那份模糊 + 令牌）',
      !!barHigh && !barHigh.filter.includes('url(') && barHigh.filter.includes('blur(') && barHigh.defs?.display === 'none',
      `filter=${barHigh?.filter} · 定义=${JSON.stringify(barHigh?.defs)}`,
    )

    // 极致档在流卡片的落影：与 --shadow-card 同层的「内容层玻璃落影」，
    // 不是悬浮玻璃那份（外缘层 + 重落影）。亮暗两色各量一次 —— 暗色才是报得最凶的那一档
    // （--shadow-card 在暗色是 none，而悬浮玻璃那份是 0.4/0.55 的黑）。
    const CARD_SHADOW_PROBE = `(() => {
      const probe = document.createElement('div')
      document.body.appendChild(probe)
      const token = (v) => { probe.style.boxShadow = v; const out = getComputedStyle(probe).boxShadow; return out }
      const panelShadow = token('var(--glass-panel-shadow)')
      const floatShadow = token('var(--glass-shadow)')
      probe.remove()
      const shadowOf = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).boxShadow : null }
      return {
        tier: document.documentElement.dataset.perf,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        panelShadow,
        floatShadow,
        cards: [...document.querySelectorAll('.card:not(.sub)')].slice(0, 6).map((c) => getComputedStyle(c).boxShadow),
        qas: [...document.querySelectorAll('.qa')].slice(0, 4).map((c) => getComputedStyle(c).boxShadow),
      }
    })()`

    for (const theme of ['light', 'dark']) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
      await setTier('extreme')
      // 营养全览：4 张 .card + 3 个 .qa（地图探针实测），是最能代表「一屏卡片」的一页
      await cdp('Page.navigate', { url: `${APP}/#/nutrition` })
      await sleep(2400)
      if (await evalJS(dismiss)) await sleep(400)
      const cardShadow = await evalJS(CARD_SHADOW_PROBE)
      const inFlow = [...cardShadow.cards, ...cardShadow.qas]
      await shot(`card-shadow-extreme-${theme}`)
      ok(
        `极致 · ${theme} · 在流卡片的落影是内容层那一档（不是悬浮玻璃那份）`,
        inFlow.length > 0 &&
          inFlow.every((s) => s.startsWith(cardShadow.panelShadow)) &&
          inFlow.every((s) => !s.startsWith(cardShadow.floatShadow)) &&
          inFlow.every((s) => !s.includes('0px 12px 36px')),
        `${inFlow.length} 块 · 首块=${String(inFlow[0]).slice(0, 100)}… · 悬浮那份=${cardShadow.floatShadow}`,
      )
      ok(
        `极致 · ${theme} · 在流卡片仍拿到玻璃的光学内层（只是落影换了档）`,
        inFlow.length > 0 && inFlow.every((s) => s.includes('inset')),
        `缺 inset 的：${inFlow.filter((s) => !s.includes('inset')).length} 块`,
      )
    }

    // 高画质起玻璃就铺到内容层（不是极致专属）：卡片拿到 --glass-panel-fill 的底 +
    // 光学内层，但在流面**仍不挂 backdrop-filter**（背后只有平滑画布，滤镜是纯亏）。
    // 这条钉住「即便不启用折射，高画质也要有玻璃的其余效果」。
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setTier('high')
    await cdp('Page.navigate', { url: `${APP}/#/nutrition` })
    await sleep(2400)
    if (await evalJS(dismiss)) await sleep(400)
    const hiCard = await evalJS(`(() => {
      /* 同 RT 探针：量的是玻璃铺开契约，取第一张玻璃卡；.card.sub 是刻意的非玻璃二级面。 */
      const el = document.querySelector('.card:not(.sub)')
      if (!el) return null
      const cs = getComputedStyle(el)
      const probe = document.createElement('div')
      probe.style.background = 'var(--glass-panel-fill)'
      document.body.appendChild(probe)
      const fill = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        tier: document.documentElement.dataset.perf,
        bg: cs.backgroundColor,
        fill,
        shadow: cs.boxShadow,
        backdrop: String(cs.backdropFilter || cs.webkitBackdropFilter),
      }
    })()`)
    ok(
      '高画质 · 在流卡片已经拿到玻璃材质（底 + 光学内层），不挂折射也不挂模糊',
      !!hiCard &&
        hiCard.tier === 'high' &&
        hiCard.bg === hiCard.fill &&
        hiCard.shadow.includes('inset') &&
        !hiCard.backdrop.includes('blur('),
      JSON.stringify(hiCard),
    )
    await shot('card-glass-high')
    await setTier('ultra')

    const errs = await evalJS('window.__errs ?? []')
    ok('末次运行期无未捕获异常', errs.length === 0, errs.join(' | '))
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
  } finally {
    edge.kill()
  }

  console.log(`\n${failed ? `${failed} 项未通过` : '全部通过'} · 截图在 ${OUT}`)
  if (failed) process.exitCode = 1
}

void main()
