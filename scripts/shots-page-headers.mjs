/**
 * 标题区全页面核对 —— 逐个走带页头的路由，拍「顶部 / 滚动后」两张，并量一遍
 * safe area 与遮罩几何，用来人工核对每一页的页头：
 *   1 页头贴住 safe-top（没有压进状态栏那条），滚动后仍贴着容器顶
 *   2 遮罩铺满整帧（左右不露未模糊的窄条），且向下超出页头给模糊化开的空间
 *   3 滚动后模糊层真的显形（层数 5、层自身 opacity=1）
 *   4 高画质 / 降级两档都不出硬边、不出现页头被内容盖住
 *
 * 安全区：无头浏览器的 env(safe-area-inset-*) 恒为 0，真机（Android）的数值由原生侧
 * 注入 --safe-top-native / --safe-bottom-native（见 styles/tokens.css）。本脚本照注入
 * 一份模拟值，才验得到「页头压在状态栏底下」这类只在真机上出现的毛病。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/shots-page-headers.mjs [--desktop]
 * 产物：%TEMP%/rein-shots/headers/*.png（顶部 + 滚动后）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

import { GRAB_PLUGIN_ON } from './lib/features.mjs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-headers-${Date.now()}`
const OUT = `${process.env.TEMP}/rein-shots/headers`

/** 模拟 Android 真机：状态栏 32px、底部手势区 48px */
const SAFE_TOP = 32
const SAFE_BOTTOM = 48

/** 走一遍全部挂了 PageHeader 的路由；:id 类路由先到列表页点第一条取 id */
const ROUTES = [
  ['#/', '今天'],
  ['#/sports', '运动'],
  ['#/ai', 'AI'],
  ['#/me', '关于你'],
  ['#/nutrition', '营养全览'],
  ['#/nutrition/adjust', '饮食调整'],
  ['#/nutrition/foods', '饮食库'],
  ['#/nutrition/recipes', '食谱库'],
  ['#/program', '健康方案'],
  ['#/ledger', '记账'],
  ['#/focus', '专注'],
  ['#/todos', '全部待办'],
  ['#/settings', '设置'],
  ['#/settings/features', '打开或关闭功能'],
  ['#/settings/update', '软件更新'],
  ['#/settings/perf', '画质预览'],
  ['#/ai/models', '管理模型'],
  ['#/ai/knowledge', '知识库'],
  ['#/ai/files', '文件'],
  ['#/sports/plans', '全部课程'],
  ['#/sports/exercises', '动作库'],
  ['#/sports/records', '全部运动记录'],
  ['#/campus/schedule', '我的课表'],
  ['#/campus/settings', '课表配置与设置'],
  ['#/campus/program', '培养方案'],
  ['#/campus/course-select', '选课'],
  ['#/record', '录音'],
  ['#/voice-layouts', '语音版式对照'],
]

const results = []
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
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function shot(file) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  // 整屏抓，不用 clip：CDP 的 clip 是**相对文档**的（实测：滚下去之后抓 y=0..40
  // 得到的是文档顶部那片白，而不是视口里的固定元素），滚动后的视口区域会抓成空白。
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return
  writeFileSync(`${OUT}/${file}.png`, Buffer.from(r.data, 'base64'))
}

/** 页头 + 遮罩的当下状态（含安全区变量、sticky 偏移与它自己的滚动容器） */
const STATE = `(() => {
  const px = (v) => Math.round(parseFloat(v) || 0)
  // 自定义属性读出来是**未解析**的 token（max(0px, 32px) 这种），parseFloat 会得 0；
  // 必须让它过一个真实属性、由浏览器算完再读，才拿得到真值
  const resolveVar = (name) => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;padding-top:var(' + name + ')'
    document.body.appendChild(probe)
    const v = px(getComputedStyle(probe).paddingTop)
    probe.remove()
    return v
  }
  const safeTop = resolveVar('--safe-top')
  const h = document.querySelector('.page-header')
  if (!h) return { hasHeader: false, safeTop }
  const hr = h.getBoundingClientRect()
  const cs = getComputedStyle(h)
  // 页头自己的滚动容器：与 composables/useScrolled 同一套判定
  let node = h.parentElement
  let scroller = null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) { scroller = node; break }
    node = node.parentElement
  }
  // 「会卡住页头」的容器：祖先里第一个 overflow auto|scroll 的盒子，**与当下有没有溢出
  // 无关**。sticky 的粘滞位是从它的「内容盒顶」起算的，它的上内边距会原样叠加到页头的
  // 落点上；空态页内容不足一屏时按「可滚」判定会整个漏掉这个容器，而它恰恰是页头贴不贴
  // 顶的决定者（管理模型页就是这么漏过去的）。
  let cap = null
  for (let n = h.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if (oy === 'auto' || oy === 'scroll') {
      cap = n
      break
    }
  }
  const mask = h.querySelector('.ph-mask')
  const mr = mask ? mask.getBoundingClientRect() : null
  const spans = mask ? [...mask.querySelectorAll('span')] : []
  return {
    hasHeader: true,
    title: h.querySelector('h1')?.textContent ?? '',
    safeTop,
    stickyVar: resolveVar('--ph-stick'),
    stickyTop: px(cs.top),
    scroller: scroller ? 'nested' : 'document',
    capName: cap ? cap.className || cap.tagName : 'document',
    capPadTop: cap ? px(getComputedStyle(cap).paddingTop) : 0,
    scrollerTop: scroller ? Math.round(scroller.getBoundingClientRect().top) : 0,
    scrollerScrollTop: scroller ? Math.round(scroller.scrollTop) : Math.round(window.scrollY),
    headerTop: Math.round(hr.top),
    headerBottom: Math.round(hr.bottom),
    headerLeft: Math.round(hr.left),
    headerRight: Math.round(hr.right),
    maskTop: mr ? Math.round(mr.top) : null,
    maskBottom: mr ? Math.round(mr.bottom) : null,
    maskLeft: mr ? Math.round(mr.left) : null,
    maskRight: mr ? Math.round(mr.right) : null,
    maskOpacity: mask ? getComputedStyle(mask).opacity : null,
    layerCount: spans.length,
    layerOpacity: spans[0] ? getComputedStyle(spans[0]).opacity : null,
    scrolled: h.classList.contains('scrolled'),
    lite: h.classList.contains('lite'),
    perf: document.documentElement.dataset.perf ?? '(未设)',
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    docScrollW: document.documentElement.scrollWidth,
  }
})()`

/** 滚到目标位置：从页头沿父链找它自己的滚动容器（与 composables/useScrolled 同一套判定），
 *  找不到才退回文档。嵌套滚动区（AI 页消息区、课表等）只有这么滚才动得了。 */
const scrollTo = (y) => `(() => {
  const h = document.querySelector('.page-header')
  let node = h?.parentElement ?? null
  let target = null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) { target = node; break }
    node = node.parentElement
  }
  if (!target && document.scrollingElement.scrollHeight > window.innerHeight) target = document.scrollingElement
  if (target) { target.scrollTop = ${y}; return Math.round(target.scrollTop) }
  window.scrollTo(0, ${y})
  return Math.round(window.scrollY)
})()`

async function main() {
  mkdirSync(OUT, { recursive: true })
  const debugPort = await freePort()
  const desktop = process.argv.includes('--desktop')
  const viewport = desktop ? { width: 1400, height: 900 } : { width: 430, height: 930 }

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      `--window-size=${viewport.width},${viewport.height}`,
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
        const p = pending.get(m.id)
        pending.delete(m.id)
        p.resolve(m.result ?? m.error)
      }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    // 每次整页加载都装：钉死高画质 + 注入模拟安全区（真机由 MainActivity 注入）
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        localStorage.setItem('rein.perf.v1', 'high');
        // 选课/抢课页在清单里，而抢课是课表的子模块且默认关闭 —— 不预置开关，
        // 那一页会被守卫拦回主页，截出来的就是首页（而且看着「没报错」，很隐蔽）
        ${GRAB_PLUGIN_ON};
        const applySafe = () => {
          document.documentElement.style.setProperty('--safe-top-native', '${SAFE_TOP}px');
          document.documentElement.style.setProperty('--safe-bottom-native', '${SAFE_BOTTOM}px');
        };
        if (document.documentElement) applySafe();
        else addEventListener('DOMContentLoaded', applySafe, { once: true });
        window.__errs = [];
        addEventListener('error', (e) => window.__errs.push(String(e.message)));
        addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));`,
    })
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: !desktop,
    })
    await cdp('Page.navigate', { url: `${APP}/#/` })
    await sleep(2500)
    // 装置自检：安全区没注入成功的话，下面「贴住安全区」那批断言全是假警报
    // （上一版就是在这里翻的车：① 注入落在 documentElement 还不存在的时刻
    //   ② 读 --safe-top 读到未解析的 max(0px, 32px)，parseFloat 得 0）
    const applied = await evalJS(
      `(() => {
        document.documentElement.style.setProperty('--safe-top-native', '${SAFE_TOP}px');
        document.documentElement.style.setProperty('--safe-bottom-native', '${SAFE_BOTTOM}px');
        const p = document.createElement('div')
        p.style.cssText = 'position:absolute;visibility:hidden;padding-top:var(--safe-top)'
        document.body.appendChild(p)
        const v = Math.round(parseFloat(getComputedStyle(p).paddingTop) || 0)
        p.remove()
        return v
      })()`,
    )
    ok('装置自检：模拟安全区已注入', applied === SAFE_TOP, `--safe-top 解析值=${applied}px`)

    for (const [hash, title] of ROUTES) {
      const tag = hash.replace(/^#\//, '').replace(/\//g, '_') || 'home'
      const suffix = desktop ? '-desktop' : ''
      try {
        await evalJS(`location.hash = '${hash}'`)
        // 就绪判据用 document.title（router.afterEach 统一写成 `Rein · <meta>`）：
        // out-in 过渡里上一页还挂着，只看 .page-header 会量到上一页
        // （/todos 曾量到首页的日期标题）。页头 h1 与 meta 未必同名（待办页头是日期），
        // 所以标题只打印核对，不做断言。
        let mounted = true
        try {
          await evalJS(`new Promise((res, rej) => {
            const want = ${JSON.stringify(`Rein · ${title}`)}
            const t0 = Date.now()
            const tick = () => {
              if (document.title === want) return res(true)
              if (Date.now() - t0 > 8000) return rej(new Error('未就绪，document.title=' + document.title))
              setTimeout(tick, 150)
            }
            tick()
          })`)
        } catch (e) {
          mounted = false
          ok(`${hash} 页面就绪`, false, e instanceof Error ? e.message : String(e))
        }
        if (!mounted) {
          await shot(`${tag}${suffix}-NOTMOUNTED`)
          continue
        }

        await evalJS(scrollTo(0))
        await sleep(400)
        const top = await evalJS(STATE)
        await shot(`${tag}${suffix}-top`)

        const scrolledTop = await evalJS(scrollTo(320))
        await sleep(700)
        const s = await evalJS(STATE)
        await shot(`${tag}${suffix}-scrolled`)

        const ctx = `容器=${s.scroller}(顶=${s.scrollerTop}) sticky=${s.stickyTop} safeTop=${s.safeTop}`
        console.log(`      ${hash} h1=「${s.title}」 页头=${s.headerTop}..${s.headerBottom} ${ctx}`)
        if (!s.hasHeader) {
          console.log(`      SKIP ${hash}：这一页不用 PageHeader（自带版式），截图仍留档`)
          continue
        }
        // 1 未滚动：模糊层不该显形（顶部没有内容经过，出现底色就是异常）
        ok(`${hash} 未滚动时遮罩不可见`, top.layerOpacity === '0', `layerOpacity=${top.layerOpacity}`)
        // 2 页头（含未滚动时）不压进状态栏那条 —— 与是否滚动无关，永远要成立。
        //   只在移动壳上验：桌面壳（.desk-frame）是独立根节点、**刻意不做**状态栏内边距
        //   （桌面 OS 没有系统状态栏），把移动端的 inset 注入进去再断言只会得到假警报。
        if (!desktop) {
          ok(
            `${hash} 页头未压进状态栏`,
            top.headerTop >= top.safeTop - 1 && s.headerTop >= s.safeTop - 1,
            `未滚=${top.headerTop} 滚后=${s.headerTop} ≥ safeTop=${s.safeTop}`,
          )
        } else {
          console.log(`      ${hash} 桌面壳：跳过状态栏断言（桌面壳不预留 inset）`)
        }
        // 3 遮罩要在页头下缘之外多铺一段（模糊才有化开的空间）
        ok(
          `${hash} 遮罩在页头下缘外收尾`,
          s.maskBottom > s.headerBottom,
          `maskBottom=${s.maskBottom} headerBottom=${s.headerBottom}`,
        )
        // 4 遮罩左右要铺出页头之外（露出未模糊的窄条就是异常）。
        //   桌面三窗格下页头只占中间内容列，遮罩盖的是这一列，不是整帧——所以判据是
        //   「盖住页头并向外铺出」，而不是「铺满视口」。
        ok(
          `${hash} 遮罩左右铺出页头之外`,
          s.maskLeft <= s.headerLeft && s.maskRight >= s.headerRight,
          `mask=${s.maskLeft}..${s.maskRight} 页头=${s.headerLeft}..${s.headerRight} 视口宽=${s.viewportW}`,
        )
        // 5 撑起页头的滚动容器不许带**上内边距**：sticky 的粘滞位是从容器的「内容盒顶」
        //   起算的，容器带上内边距，页头就被顶下去「内边距 + --ph-stick」那么多
        //   （管理模型页真机 safe-top=42 下实测落在 94 —— 页头上方留出一条 52px 的空白，
        //   滚起来也贴不住容器顶，那条里的内容是**没被遮住**地从页头上方滑过去）。
        //   这条与「能不能滚」无关：容器按「祖先里有 overflow」找，空态页照样验得到 ——
        //   而恰恰是内容不足一屏的页面，下面那批滚动类断言会被整段跳过。
        ok(
          `${hash} 页头的滚动容器没有上内边距`,
          s.capPadTop === 0,
          `容器=${s.capName} 上内边距=${s.capPadTop}px`,
        )
        // 6 滚动相关的三条只在真的滚起来时才有判据：
        //   空态页（mock 没数据）内容不足一屏，滚不动，靠截图人工看
        if (scrolledTop > 0) {
          ok(
            `${hash} 滚动后页头停在 sticky 偏移处`,
            Math.abs(s.headerTop - (s.scrollerTop + s.stickyTop)) <= 1,
            `headerTop=${s.headerTop} 期望=${s.scrollerTop + s.stickyTop} · ${ctx}`,
          )
          ok(
            `${hash} 滚动后模糊层显形`,
            s.layerOpacity === '1' && s.layerCount === 5 && s.scrolled,
            `layerOpacity=${s.layerOpacity} 层数=${s.layerCount} scrolled=${s.scrolled}`,
          )
          // 粘住之后遮罩必须一路盖到视口顶：状态栏那条里滚过的内容同样要是糊的
          ok(
            `${hash} 滚动后遮罩盖住状态栏那条`,
            s.maskTop <= 0,
            `maskTop=${s.maskTop}（页头 ${s.headerTop} - 向上铺出 --ph-up）`,
          )
        } else {
          console.log(`      ${hash} 内容不足一屏（滚不动），滚动类断言跳过 · 容器=${s.scroller}`)
        }
        if (s.docScrollW > s.viewportW + 1) {
          console.log(`      注意：${hash} 文档宽 ${s.docScrollW} > 视口 ${s.viewportW}（横向溢出，看图核对）`)
        }
      } catch (e) {
        ok(`${hash} 走查`, false, e instanceof Error ? e.message : String(e))
      }
    }

    const errs = await evalJS('window.__errs ?? []')
    ok('运行期无未捕获异常', Array.isArray(errs) && errs.length === 0, (errs ?? []).join(' | '))
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
  } finally {
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过 · 截图在 ${OUT}`)
  if (failed.length) process.exitCode = 1
}

void main()
