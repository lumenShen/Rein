/**
 * 全局沉浸浮窗 · A2 真机段（Tauri + WebView2 远程调试）。
 * 由 scripts/e2e-global-float.mjs --app 调起（也可 import 后直接 runAppStage()）。
 *
 * 覆盖 docs/GLOBAL-FLOAT.md §10 / §9 的真机验收：自绘标题栏 DOM 与「非客户区高度归零」、
 * 双击最大化/还原、八向缩放热区、专注开始后失焦 → float 窗口出现且内容与浮条同源、按钮回灌、
 * 回焦隐藏、hide→show 幂等、置顶不抢焦点（记事本在前）、ex-style（TOPMOST + TOOLWINDOW）、
 * 浅色/暗色截图（docs/screens/global-float-*.png）与系统级置顶全屏证明。
 *
 * 调试端口走临时配置（wry 0.57 总覆盖 AdditionalBrowserArguments，环境变量不生效，见 §10）。
 * 全程不碰别人的 1420 dev server：devUrl 覆盖到 1429；若 1429 已有 dev server 则复用。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { attachPage, listTargets, sleep } from './float-cdp.mjs'

const WS_EX_TOPMOST = 0x8
const WS_EX_TOOLWINDOW = 0x80

let PS1 = ''
let CAP1 = ''

/** Win32 调用一律带超时：本机（无交互式桌面的会话）里 GetForegroundWindow 这类调用
 *  偶发不返回，spawnSync 没有超时就会把整轮 A2 挂死 —— 2026-10-21 实测挂过 27 分钟，
 *  日志停在「记事本 hwnd=…」之后。超时按失败处理，让剧本走到结论而不是静默卡住。 */
const WIN_TIMEOUT_MS = Number(process.env.REIN_WIN_TIMEOUT_MS || 20000)

function psRun(script, action, params, timeout) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action]
  for (const k of Object.keys(params || {})) args.push('-' + k, String(params[k]))
  const r = spawnSync('powershell', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16, timeout: timeout || WIN_TIMEOUT_MS })
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error('Win32 工装超时(' + action + ') > ' + (timeout || WIN_TIMEOUT_MS) + 'ms')
  if (r.status !== 0) throw new Error('Win32 工装失败(' + action + '): ' + String(r.stderr).slice(0, 600))
  const text = String(r.stdout).trim()
  if (!text) return null
  const parsed = JSON.parse(text)
  // ConvertTo-Json 对单元素数组会输出对象：pidof/query 统一成数组
  if (parsed && !Array.isArray(parsed) && (action === 'pidof' || action === 'query' || action === 'all')) return [parsed]
  return parsed
}

function win(action, params, timeout) {
  return psRun(PS1, action, params, timeout)
}

/** win-capture.ps1 的 nccheck / shotwin：非客户区 inset 与 PrintWindow 截图 */
function cap(action, params, timeout) {
  return psRun(CAP1, action, params, timeout)
}

const alive = (proc) => proc && proc.exitCode === null && proc.signalCode === null

/** 给 CDP 页面加单次求值上限：页面被系统节流 / 窗口被隐藏时，`Runtime.evaluate` 带
 *  `awaitPromise` 的那个 promise 可能永远不落地。不加这一层，一次求值就能把整轮 A2 挂死
 *  （2026-10-21 实测：日志停在「记事本 hwnd=…」后 25 分钟没有任何输出）。 */
function guardPage(page, ms) {
  const limit = ms || Number(process.env.REIN_CDP_EVAL_TIMEOUT_MS || 15000)
  const rawEval = page.eval.bind(page)
  page.eval = (expression) =>
    Promise.race([
      rawEval(expression),
      sleep(limit).then(() => {
        throw new Error('CDP 求值超时 ' + limit + 'ms：' + String(expression).slice(0, 80))
      }),
    ])
  return page
}

async function ping(url, timeoutMs) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 1500)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

async function waitUntil(fn, timeoutMs, label, intervalMs) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      /* 单次尝试也要有上限：CDP 的 eval 带 awaitPromise，页面被节流时那个 promise
         可能永远不落地，直接把等待器挂死（超时判据在循环外就成了摆设）。 */
      last = await Promise.race([
        fn(),
        sleep(Math.max(2000, timeoutMs)).then(() => {
          throw new Error('单次尝试超时')
        }),
      ])
      if (last) return { value: last, elapsed: Date.now() - started }
    } catch (e) {
      last = { error: String(e && e.message ? e.message : e) }
    }
    await sleep(intervalMs || 200)
  }
  throw new Error('等待超时: ' + label + (last ? '（最后 ' + JSON.stringify(last).slice(0, 260) + '）' : ''))
}

function tail(file, max) {
  if (!existsSync(file)) return '(无日志)'
  return readFileSync(file, 'utf8').split(/\r?\n/).slice(-(max || 40)).join('\n')
}

export async function runAppStage(ctx) {
  const repo = process.cwd()
  const work = join(ctx.out, 'app')
  const screens = join(repo, 'docs/screens')
  mkdirSync(work, { recursive: true })
  mkdirSync(screens, { recursive: true })
  PS1 = join(repo, 'scripts/lib/win32-window.ps1')
  CAP1 = join(repo, 'scripts/lib/win-capture.ps1')
  const cdpPort = Number(process.env.REIN_APP_CDP_PORT || 9232)
  const devUrl = 'http://localhost:1429'
  const logPath = join(work, 'tauri-dev.log')
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const log = (line) => {
    logStream.write('[' + new Date().toISOString() + '] ' + line + '\n')
    console.log('      ' + line)
  }
  const ok = ctx.ok

  let launcher = null
  let main = null
  let floatPage = null
  let notepad = null
  let notepadHwnd = null
  let floatHwnd = null
  const reinPids = []
  const cleanups = []

  const readFloatBar = "(() => { const bar = document.querySelector('.float-stage'); if (!bar) return null; const btns = [...bar.querySelectorAll('.acts .abtn')]; return { title: document.querySelector('.titlebar .tb-title')?.textContent.trim() ?? null, tbDot: document.querySelector('.titlebar .tb-dot')?.className ?? null, phase: bar.querySelector('.info .t')?.textContent.trim() ?? null, time: bar.querySelector('.info .s')?.textContent.trim() ?? null, dot: bar.querySelector('.info .dot')?.className ?? null, texts: btns.map((b) => b.textContent.trim()), arias: btns.map((b) => b.getAttribute('aria-label')).filter(Boolean), inner: [window.innerWidth, window.innerHeight], titlebarButtons: [...document.querySelectorAll('.titlebar .wbtn')].map((b) => b.getAttribute('aria-label')) } })()"
  const readMainBar = "(() => { const bar = document.querySelector('.fdock-root .layer-bar'); if (!bar) return null; const btns = [...bar.querySelectorAll('.acts .abtn')]; return { phase: bar.querySelector('.info .t')?.textContent.trim() ?? null, time: bar.querySelector('.info .s')?.textContent.trim() ?? null, dot: bar.querySelector('.info .dot')?.className ?? null, texts: btns.map((b) => b.textContent.trim()), arias: btns.map((b) => b.getAttribute('aria-label')).filter(Boolean) } })()"
  const statusVisible = () => main.eval("window.__TAURI_INTERNALS__.invoke('global_float_status')")
  const dismissUp = () => main.eval("(() => { const b = [...document.querySelectorAll('.up-card button')].find((x) => ['稍后', '跳过此版本'].includes(x.textContent.trim())); if (b) b.click(); return !!b })()").catch(() => false)
  const shotMain = async (name, dark) => {
    const file = join(screens, 'global-float-' + name + '-' + (dark ? 'dark' : 'light') + '.png')
    await main.shot(file, { dark, clip: { x: 0, y: 0, width: 430, height: 120 } })
    console.log('     截图 ' + file)
  }
  const shotFloat = async (name, dark) => {
    const file = join(screens, 'global-float-' + name + '-' + (dark ? 'dark' : 'light') + '.png')
    await floatPage.shot(file, { dark })
    console.log('     截图 ' + file)
  }

  try {
    if (process.platform !== 'win32') throw new Error('真机段需要 Windows')
    const existing = win('pidof', { Name: 'rein' })
    if (existing && existing.length) throw new Error('已有 rein 进程在跑（可能是别人的 tauri dev），本脚本不杀别人的进程：' + JSON.stringify(existing))
    const tauri = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npx tauri --version'], { cwd: repo, encoding: 'utf8' })
    if (tauri.status !== 0) throw new Error('npx tauri 不可用: ' + String(tauri.stderr).slice(0, 300))
    log('tauri cli: ' + String(tauri.stdout).trim())

    const devUp = await ping('http://127.0.0.1:1429')
    const conf = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'))
    conf.build.devUrl = devUrl
    conf.build.beforeDevCommand = devUp ? 'node -e "process.exit(0)"' : 'npm run dev -- --port 1429'
    conf.app.windows[0].additionalBrowserArgs = '--remote-debugging-port=' + cdpPort
    // 临时配置放仓库 .tmp 下：%TEMP% 在部分父进程里是 8.3 短路径（ADMINI~1），tauri CLI 读它会报 os error 123
    const confDir = join(repo, '.tmp/qa-a2')
    mkdirSync(confDir, { recursive: true })
    // 文件名带时间戳：TAURI_CONFIG（= 临时配置路径）变化才会让 tauri-build 重算内嵌配置；
    // 固定文件名在第二次运行时会让「配置没变」的旧二进制被复用（lead 2026-10-20 实测坑）。
    const confPath = join(confDir, 'tauri.float-e2e.' + Date.now() + '.conf.json')
    writeFileSync(confPath, JSON.stringify(conf, null, 2))
    cleanups.push(() => rmSync(confPath, { force: true }))
    log('1429 dev server ' + (devUp ? '已在跑，beforeDevCommand 置空' : '未在跑，由 tauri dev 拉起'))
    // 强制一次重编译：tauri-build 对「配置路径没变」的增量判定可能让内嵌配置仍是旧的，
    // additionalBrowserArgs 不生效 → 9232 永不监听。碰 mtime 不改内容。
    for (const f of ['src-tauri/src/main.rs', 'src-tauri/build.rs']) {
      try { utimesSync(join(repo, f), new Date(), new Date()) } catch (e) { /* 文件不存在就算了 */ }
    }
    if (await ping('http://127.0.0.1:' + cdpPort + '/json/version')) throw new Error('CDP 端口 ' + cdpPort + ' 已被占用，设 REIN_APP_CDP_PORT 换一个')

    const dataDir = join(work, 'data')
    mkdirSync(dataDir, { recursive: true })
    // 路径无空格，**不加引号**：cmd /s /c 下引号会被当成 --config 值的一部分
    const cmdLine = 'npx tauri dev --config ' + confPath
    log('启动: ' + cmdLine)
    launcher = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
      cwd: repo,
      env: Object.assign({}, process.env, { REIN_DATA_DIR: dataDir, RUST_BACKTRACE: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    launcher.stdout.on('data', (d) => log('[tauri] ' + String(d).trimEnd()))
    launcher.stderr.on('data', (d) => log('[tauri!] ' + String(d).trimEnd()))
    cleanups.push(() => {
      try {
        if (launcher) spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch (e) { /* ignore */ }
    })

    // 不能用 waitUntil：它在轮询里吞掉异常（tauri 编译失败会被当成"还没好"一直等到 15 分钟）
    const launchStart = Date.now()
    let hit = null
    while (Date.now() - launchStart < 15 * 60 * 1000) {
      if (!alive(launcher) && launcher.exitCode !== null) {
        throw new Error('tauri dev 提前退出（' + launcher.exitCode + '），日志尾部:\n' + tail(logPath, 40))
      }
      try {
        const list = await listTargets(cdpPort)
        hit = list.find((t) => t.type === 'page' && /1429/.test(t.url || '') && !/float\.html/.test(t.url || ''))
      } catch (e) {
        hit = null
      }
      if (hit) break
      await sleep(1000)
    }
    if (!hit) throw new Error('等待超时: tauri dev 主窗口 CDP target（15 分钟），日志尾部:\n' + tail(logPath, 40))
    hit = { value: hit, elapsed: Date.now() - launchStart }
    log('主窗口 target 就绪，用时 ' + Math.round(hit.elapsed / 1000) + 's：' + hit.value.url)

    main = guardPage(await attachPage(hit.value, 'app-main'))
    await main.waitFor("!!document.querySelector('.page')", 60000, '真机应用挂载')
    const runtime = await main.eval("({ tauri: '__TAURI_INTERNALS__' in window, ua: navigator.userAgent.slice(0, 60), w: window.innerWidth, h: window.innerHeight })")
    ok('A2.0 连上真机 App（Tauri 运行时 + 应用已挂载）', runtime.tauri === true, JSON.stringify(runtime))
    if (!runtime.tauri) throw new Error('不是 Tauri 环境，拒绝继续')
    await sleep(1500)
    await dismissUp()

    const procs = await waitUntil(async () => {
      const p = win('pidof', { Name: 'rein' })
      return p && p.length ? p : null
    }, 30000, 'rein 进程', 500)
    for (const p of procs.value) reinPids.push(Number(p.pid))
    const mainWin = await waitUntil(async () => {
      const wins = win('query', { Pids: reinPids.join(',') }) || []
      return wins.filter((w) => w.w >= 200 && w.h >= 200).sort((a, b) => b.w * b.h - a.w * a.h)[0] || null
    }, 20000, '主窗口 hwnd', 400)
    const mainHwnd = mainWin.value.hwnd
    log('主窗口 hwnd=' + mainHwnd + ' ' + JSON.stringify(mainWin.value))

    /* ---------- A2.1 标题栏 DOM + Win32 样式 ---------- */
    const dom = await main.eval("(() => { const tb = document.querySelector('.titlebar'); const btns = [...document.querySelectorAll('.titlebar .wbtn')]; return { titlebar: !!tb, dragRegion: tb ? tb.getAttribute('data-tauri-drag-region') : null, titlebarH: tb ? Math.round(tb.getBoundingClientRect().height) : null, brand: tb ? tb.querySelector('.brand .word')?.textContent : null, btns: btns.map((b) => b.getAttribute('aria-label')), wbtnCount: btns.length, rzCount: document.querySelectorAll('.rz-zone').length, rzRoot: !!document.querySelector('.rz'), shell: document.querySelector('.win-shell')?.className ?? null } })()")
    ok('A2.1a 主窗口自绘标题栏：.titlebar + 品牌 + 三颗 .wbtn + 拖拽区', dom.titlebar && dom.dragRegion === 'deep' && dom.brand === 'Rein' && dom.wbtnCount === 3 && dom.btns.join('|') === '最小化|最大化|关闭', JSON.stringify(dom))
    ok('A2.1b 八向缩放热区 DOM = 8（窄窗 .win-shell--narrow）', dom.rzCount === 8 && dom.rzRoot && String(dom.shell).indexOf('win-shell--narrow') >= 0 && Math.abs(dom.titlebarH - 40) <= 1, JSON.stringify({ rz: dom.rzCount, shell: dom.shell, h: dom.titlebarH }))
    const mainStyle = win('info', { Hwnd: mainHwnd })
    /* 判据是**非客户区顶部 inset**，不是 WS_CAPTION 样式位：tao 0.35 的 undecorated 实现是
       「保留 WS_CAPTION 位 + 用 WM_NCCALCSIZE 把非客户区归零」，样式位永远在（2026-10-21 实测
       style=0x14cf0000 含 0x00C00000）。真正的证据是客户区从窗口顶边开始：
       captionPx 只有 0~2px 的 DWM 边框，而不是原生标题栏的 ~46px。 */
    const nc = cap('nccheck', { Hwnd: mainHwnd })
    ok(
      'A2.1c 主窗口实际无系统标题栏（客户区顶部 inset=' + nc.captionPx + 'px < 10px，WS_CAPTION 位仍在是 tao 的无边框实现方式）',
      nc.captionPx >= 0 && nc.captionPx < 10 && nc.clientRect.w > 400 && Math.abs(nc.clientRect.w / 430 - nc.clientRect.h / 932) < 0.01,
      JSON.stringify({ style: '0x' + Number(nc.style).toString(16), captionPx: nc.captionPx, leftInsetPx: nc.leftInsetPx, clientRect: nc.clientRect, winRect: nc.winRect }),
    )

    await shotMain('titlebar', false)
    await shotMain('titlebar', true)
    await main.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

    /* ---------- A2.2 双击标题栏最大化 / 还原 ---------- */
    const dbl = () => main.eval("(() => { const tb = document.querySelector('.titlebar'); if (!tb) return false; const r = tb.getBoundingClientRect(); tb.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2, clientX: r.left + r.width / 2, clientY: r.top + Math.min(20, r.height / 2) })); return true })()")
    const maxLabel = () => main.eval("document.querySelectorAll('.titlebar .wbtn')[1]?.getAttribute('aria-label') ?? null")
    if (!(await dbl())) throw new Error('点不到标题栏')
    const zoomed = await waitUntil(async () => (await maxLabel()) === '向下还原' ? true : null, 4000, '双击最大化')
    const maxStyle = win('info', { Hwnd: mainHwnd })
    ok('A2.2a 双击标题栏 → 最大化一次（aria-label 变「向下还原」，Win32 IsZoomed=true）', zoomed && maxStyle.zoomed === true, 'zoomed=' + maxStyle.zoomed)
    await sleep(400)
    await dbl()
    const unzoomed = await waitUntil(async () => (await maxLabel()) === '最大化' ? true : null, 4000, '双击还原')
    const restoreStyle = win('info', { Hwnd: mainHwnd })
    ok('A2.2b 再双击 → 还原一次（aria-label 回「最大化」，Win32 IsZoomed=false）', unzoomed && restoreStyle.zoomed === false, 'zoomed=' + restoreStyle.zoomed)

    /* ---------- A2.3 专注开始，主窗口仍在前台 ---------- */
    await main.eval("location.hash = '#/focus'")
    await main.waitFor("document.querySelector('h1')?.textContent === '专注'", 20000, '专注页')
    await sleep(1200)
    await dismissUp()
    const started = await main.eval("(() => { const el = document.querySelector('.page .card .cta') ?? document.querySelector('.page .card .acts .ibtn.main'); if (!el) return false; el.click(); return true })()")
    if (!started) throw new Error('专注页找不到起跑按钮')
    await main.waitFor("!!document.querySelector('.fdock-root .layer-bar .info')", 15000, '程序内专注浮条')
    await sleep(1600)
    const bar0 = await main.eval(readMainBar)
    ok('A2.4a 主窗口浮条：专注中 + mm:ss + work 点 + 四颗按钮', !!bar0 && bar0.phase === '专注中' && /^\d{2}:\d{2}$/.test(bar0.time || '') && bar0.dot.indexOf('work') >= 0 && bar0.texts.filter(Boolean).join('|') === '暂停|结束' && bar0.arias.join('|') === '打开专注页|进入沉浸模式', JSON.stringify(bar0))
    log('主窗口浮条基线: ' + JSON.stringify(bar0))

    /* ---------- A2.4 失焦（记事本置前）→ 浮窗出现 ---------- */
    notepad = spawn('notepad.exe', [], { stdio: 'ignore' })
    cleanups.push(() => {
      try {
        if (notepad && notepad.pid) spawnSync('taskkill', ['/PID', String(notepad.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch (e) { /* ignore */ }
    })
    notepadHwnd = (await waitUntil(async () => {
      const list = win('pidof', { Name: 'notepad' }) || []
      const hit2 = list.find((p) => p.mainHwnd && p.mainHwnd !== '0')
      return hit2 ? hit2.mainHwnd : null
    }, 10000, '记事本窗口')).value
    log('记事本 hwnd=' + notepadHwnd)
    let fgOk = null
    try {
      fgOk = await waitUntil(async () => String(win('getfg').fg) === String(notepadHwnd) ? true : null, 4000, '记事本成为前台').catch(() => null)
      if (!fgOk) {
        win('foreground', { Hwnd: notepadHwnd })
        await sleep(500)
        fgOk = await waitUntil(async () => String(win('getfg').fg) === String(notepadHwnd) ? true : null, 3000, '记事本成为前台(强制)').catch(() => null)
      }
    } catch {
      fgOk = null
    }
    /* 本机（无交互式桌面的会话）SetForegroundWindow 可能不生效，getfg 也可能读不到。
       退化为最小化主窗口 —— 与 UIA 兜底同一条触发路径（主窗口不再在前台 ⇒ 浮窗出现），
       只是拿不到「前台仍是记事本」那一条断言。 */
    const viaMinimize = !fgOk
    if (viaMinimize) {
      log('记事本没能成为前台，退化为最小化主窗口触发失焦')
      win('minimize', { Hwnd: mainHwnd })
      await sleep(800)
    }

    const showHit = await waitUntil(async () => {
      const st = await statusVisible()
      return st && st.visible ? st : null
    }, 6000, 'global_float_status.visible=true')
    ok('A2.3a 主窗口失焦后 2s 内 global_float_status.visible=true', showHit.elapsed <= 2000 && showHit.value.supported === true && showHit.value.permitted === true, '耗时 ' + showHit.elapsed + 'ms status=' + JSON.stringify(showHit.value))
    const fgNow = win('getfg')
    ok(
      'A2.8a 浮窗出现不抢焦点（GetForegroundWindow 仍是记事本）',
      !viaMinimize && String(fgNow.fg) === String(notepadHwnd),
      viaMinimize ? '（本会话拿不到前台切换，走最小化路径，本条不可判）' : '前台=' + fgNow.fg + ' 记事本=' + notepadHwnd,
    )

    const fTarget = await waitUntil(async () => {
      const list = await listTargets(cdpPort)
      return list.find((t) => t.type === 'page' && /float\.html/.test(t.url || '')) || null
    }, 8000, '/json/list 出现 float.html target')
    ok('A2.3b /json/list 出现 float.html target', true, fTarget.value.url)
    floatPage = guardPage(await attachPage(fTarget.value, 'app-float'))
    await floatPage.waitFor("!!document.querySelector('.float-app')", 20000, '浮窗页面挂载')
    await floatPage.waitFor("!!document.querySelector('.float-stage .info')", 8000, '浮窗 bar 渲染')

    const floatWin = (await waitUntil(async () => {
      const wins = win('query', { Pids: reinPids.join(',') }) || []
      const small = wins.filter((w) => w.hwnd !== mainHwnd && w.w >= 100 && w.h >= 40 && w.w * w.h < 400000).sort((a, b) => a.w * a.h - b.w * b.h)
      return small[0] || null
    }, 8000, '浮窗 hwnd')).value
    floatHwnd = floatWin.hwnd
    const ex = Number(floatWin.exStyle)
    log('浮窗 hwnd=' + floatHwnd + ' ' + JSON.stringify(floatWin))
    ok('A2.8b 浮窗 ex-style 含 WS_EX_TOPMOST(0x8) + WS_EX_TOOLWINDOW(0x80)', (ex & WS_EX_TOPMOST) !== 0 && (ex & WS_EX_TOOLWINDOW) !== 0, 'exStyle=0x' + ex.toString(16))

    /* ---------- A2.5 浮窗 DOM 与浮条逐字对比 ---------- */
    const fbar = await floatPage.eval(readFloatBar)
    ok('A2.4b 浮窗 DOM：标题「专注」+ 状态点 + 相位 + 读数 + 暂停/结束/打开/沉浸四颗按钮', !!fbar && fbar.title === '专注' && fbar.tbDot.indexOf('work-focus') >= 0 && fbar.phase === '专注中' && /^\d{2}:\d{2}$/.test(fbar.time || '') && fbar.dot.indexOf('work') >= 0 && fbar.texts.filter(Boolean).join('|') === '暂停|结束' && fbar.arias.join('|') === '打开专注页|进入沉浸模式' && fbar.titlebarButtons.join('|') === '泊车为方块|关闭浮窗' && Math.abs(fbar.inner[0] - 430) <= 2 && Math.abs(fbar.inner[1] - 92) <= 2, JSON.stringify(fbar))
    const toSec = (t) => { const p = String(t || '0:0').split(':'); return Number(p[0]) * 60 + Number(p[1]) }
    const diff = Math.abs(toSec(bar0.time) - toSec(fbar.time))
    ok('A2.4c 浮窗与程序内浮条逐字一致（相位 / 按钮集合 / 读屏名 / 状态点语义；读数同一秒内）', fbar.phase === bar0.phase && fbar.texts.filter(Boolean).join('|') === bar0.texts.filter(Boolean).join('|') && fbar.arias.join('|') === bar0.arias.join('|') && diff <= 2, '读数 diff=' + diff + 's')
    await shotFloat('bar', false)
    await shotFloat('bar', true)
    await floatPage.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

    /* ---------- A2.6 动作回灌 ---------- */
    await floatPage.clickSel('.float-stage .abtn.main')
    const paused = await waitUntil(async () => {
      const f = await floatPage.eval(readFloatBar)
      const m = await main.eval(readMainBar)
      return f && f.texts[0] === '继续' && f.phase === '已暂停' && m && m.phase === '已暂停' ? { f: f, m: m } : null
    }, 5000, '浮窗点暂停 → 双端暂停')
    ok('A2.5a 浮窗点暂停 → 下一帧「继续」、状态点 paused，主窗口浮条同步', paused.value.f.dot.indexOf('paused') >= 0 && paused.value.m.dot.indexOf('paused') >= 0, JSON.stringify({ float: paused.value.f.phase, main: paused.value.m.phase }))
    await sleep(400)
    const frozenF = await floatPage.eval(readFloatBar)
    const frozenM = await main.eval(readMainBar)
    ok('A2.5b 暂停后浮窗与浮条读数逐字一致（静止读数）', frozenF.time === frozenM.time, '浮窗=' + frozenF.time + ' 浮条=' + frozenM.time)

    await floatPage.clickSel('.float-stage .abtn.main')
    const resumed = await waitUntil(async () => {
      const f = await floatPage.eval(readFloatBar)
      const m = await main.eval(readMainBar)
      return f && f.texts[0] === '暂停' && m && m.phase === '专注中' ? { f: f, m: m } : null
    }, 5000, '浮窗点继续 → 双端恢复')
    ok('A2.5c 浮窗点继续 → 双端恢复「专注中」', resumed.value.f.phase === '专注中', JSON.stringify({ float: resumed.value.f.phase, main: resumed.value.m.phase }))

    await floatPage.clickSel('.float-stage .abtn.end')
    const confirmF = await waitUntil(async () => {
      const info = await floatPage.eval("(() => ({ h: window.innerHeight, w: window.innerWidth, hasActs: !!document.querySelector('.float-confirm .c-acts'), title: document.querySelector('.float-confirm .c-title')?.textContent.trim() ?? null, buttons: [...document.querySelectorAll('.float-confirm .cbtn')].map((b) => b.textContent.trim()) }))()")
      return info.hasActs && info.h > 120 ? info : null
    }, 5000, '浮窗内联确认（窗口长高）')
    ok('A2.5d 点结束 → 浮窗长高到 confirm（innerHeight≈172）+ .c-acts 三条按钮', Math.abs(confirmF.value.h - 172) <= 4 && confirmF.value.buttons.length === 3, JSON.stringify(confirmF.value))
    await main.clickSel('.fdock-root .abtn.end')
    await main.waitFor("!!document.querySelector('[role=\"dialog\"]')", 5000, '程序内结束确认')
    const sheetM = await main.eval("(() => { const dlg = document.querySelector('[role=\"dialog\"]'); return { title: dlg?.querySelector('.title')?.textContent.trim() ?? null, opts: [...(dlg?.querySelectorAll('.opt') ?? [])].map((b) => b.textContent.trim()) } })()")
    const fActs = confirmF.value.buttons
    ok('A2.5e 浮窗确认的标题与三条动作文案与程序内 ActionSheet 逐字一致', confirmF.value.title === sheetM.title && fActs.slice(1).join('|') === sheetM.opts.slice(0, 2).join('|') && fActs[0] === '取消' && sheetM.opts[2] === '取消', JSON.stringify({ fTitle: confirmF.value.title, mTitle: sheetM.title, fActs: fActs, mOpts: sheetM.opts }))
    await main.eval("(() => { const dlg = document.querySelector('[role=\"dialog\"]'); dlg?.querySelector('.opt.cancel')?.click() })()")
    await main.waitFor("!document.querySelector('[role=\"dialog\"]')", 4000, '关闭程序内确认')
    await shotFloat('confirm', false)
    await shotFloat('confirm', true)
    await floatPage.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await floatPage.clickText('取消', '.float-confirm')
    const backBar = await waitUntil(async () => {
      const info = await floatPage.eval("({ h: window.innerHeight, w: window.innerWidth, hasActs: !!document.querySelector('.float-confirm'), stage: !!document.querySelector('.float-stage') })")
      return info.stage && !info.hasActs && info.h <= 100 ? info : null
    }, 5000, '取消 confirm 回 bar')
    ok('A2.5f 取消确认 → 窗口回到 bar（innerHeight≈92）', Math.abs(backBar.value.h - 92) <= 4 && Math.abs(backBar.value.w - 430) <= 2, JSON.stringify(backBar.value))

    /* ---------- A2.7 blob 泊车 + 截图 ---------- */
    await floatPage.clickSel('.titlebar .wbtn[aria-label="泊车为方块"]')
    const blob = (await waitUntil(async () => {
      const info = await floatPage.eval("({ w: window.innerWidth, h: window.innerHeight, blob: !!document.querySelector('.float-blob'), titlebar: document.querySelectorAll('.titlebar').length, dot: document.querySelector('.float-blob .dot')?.className ?? null, text: document.querySelector('.float-blob .bt')?.textContent.trim() ?? null })")
      return info.blob && info.w <= 70 ? info : null
    }, 5000, '泊车 64x64 blob')).value
    ok('A2.4d 泊车 → 窗口 64×64、标题栏隐藏、blob 内容（状态点 + 读数）在场', blob.titlebar === 0 && blob.dot.indexOf('work') >= 0 && !!blob.text, JSON.stringify(blob))
    await shotFloat('blob', false)
    await shotFloat('blob', true)
    await floatPage.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await floatPage.eval("document.querySelector('.float-blob')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))")
    await waitUntil(async () => {
      const info = await floatPage.eval("({ w: window.innerWidth, h: window.innerHeight, stage: !!document.querySelector('.float-stage') })")
      return info.stage && info.w >= 420 ? info : null
    }, 5000, 'blob 展开回 bar')
    ok('A2.4e 轻点/回车 blob → 展开回 430 宽 bar', true)

    /* ---------- A2.8 全屏置顶证明：记事本在前、浮窗仍浮在上面 ---------- */
    const fRect = win('info', { Hwnd: floatHwnd })
    win('move', { Hwnd: notepadHwnd, X: Math.max(0, fRect.x - 380), Y: Math.max(0, fRect.y - 340), W: 820, H: 520 })
    win('foreground', { Hwnd: notepadHwnd })
    await sleep(700)
    const fullPath = join(screens, 'global-float-topmost-notepad.png')
    const full = win('screenshot', { Out: fullPath })
    const fgShot = win('getfg')
    ok('A2.8c 记事本覆盖浮窗区域并置前：全屏截图成功且前台仍是记事本（系统级置顶不抢焦点）', !!full && full.ok === true && String(fgShot.fg) === String(notepadHwnd), '截图 ' + fullPath)

    /* ---------- A2.9 主窗口回焦 → 浮窗收起 ---------- */
    win('restore', { Hwnd: mainHwnd })
    await sleep(300)
    win('foreground', { Hwnd: mainHwnd })
    setTimeout(() => { main.eval("window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus').catch(() => {})").catch(() => undefined) }, 500)
    const hideHit = await waitUntil(async () => {
      const st = await statusVisible()
      return st && st.visible === false ? st : null
    }, 6000, 'global_float_status.visible=false')
    ok('A2.6 主窗口回焦后 2s 内 visible=false（浮窗收起，浮条接管）', hideHit.elapsed <= 2000, '耗时 ' + hideHit.elapsed + 'ms')
    const hiddenWin = win('info', { Hwnd: floatHwnd })
    ok('A2.6b 浮窗 Win32 窗口同步隐藏', hiddenWin.visible === false, 'visible=' + hiddenWin.visible)

    /* ---------- A2.10 幂等：结束后收起；再开一轮再失焦再次出现 ---------- */
    await main.clickSel('.fdock-root .abtn.end')
    await main.waitFor("!!document.querySelector('[role=\"dialog\"]')", 5000, '结束确认')
    await main.eval("(() => { const dlg = document.querySelector('[role=\"dialog\"]'); [...(dlg?.querySelectorAll('.opt') ?? [])].find((b) => b.textContent.includes('放弃这一轮'))?.click() })()")
    await main.waitFor("!document.querySelector('.fdock-root')", 8000, '会话结束浮条收起')
    await sleep(800)
    const afterEnd = await statusVisible()
    ok('A2.7a 专注结束后程序内浮条收起，浮窗保持收起（visible=false）', afterEnd.visible === false, JSON.stringify(afterEnd))

    await main.eval("document.querySelector('.page .card .cta')?.click()")
    await main.waitFor("!!document.querySelector('.fdock-root .layer-bar .info')", 15000, '第二轮浮条')
    await sleep(1600)
    win('minimize', { Hwnd: mainHwnd })
    const showAgain = await waitUntil(async () => {
      const st = await statusVisible()
      return st && st.visible ? st : null
    }, 6000, '最小化后浮窗第二次出现')
    ok('A2.7b hide→show 幂等：再开一轮后最小化主窗口，浮窗第二次出现', showAgain.elapsed <= 3000, '耗时 ' + showAgain.elapsed + 'ms')
    await floatPage.waitFor("!!document.querySelector('.float-stage .info')", 8000, '第二轮浮窗内容')
    const secondFloat = await floatPage.eval(readFloatBar)
    ok('A2.7c 第二次出现的浮窗内容仍与浮条同源（相位/按钮）', !!secondFloat && secondFloat.phase === '专注中' && secondFloat.texts.filter(Boolean).join('|') === '暂停|结束', JSON.stringify(secondFloat))

    win('restore', { Hwnd: mainHwnd })
    await sleep(300)
    win('foreground', { Hwnd: mainHwnd })
    const hide2 = await waitUntil(async () => {
      const st = await statusVisible()
      return st && st.visible === false ? st : null
    }, 6000, '第二次回焦隐藏')
    ok('A2.7d 第二次回焦同样 2s 内收起', hide2.elapsed <= 2000, '耗时 ' + hide2.elapsed + 'ms')

    await main.clickSel('.fdock-root .abtn.end')
    await main.waitFor("!!document.querySelector('[role=\"dialog\"]')", 5000, '结束确认2')
    await main.eval("(() => { const dlg = document.querySelector('[role=\"dialog\"]'); [...(dlg?.querySelectorAll('.opt') ?? [])].find((b) => b.textContent.includes('放弃这一轮'))?.click() })()")
    await main.waitFor("!document.querySelector('.fdock-root')", 8000, '收尾会话')
    ok('A2.9 截图产物齐全（docs/screens/global-float-*.png，浅色 + 暗色）', true)
  } finally {
    for (const fn of cleanups.reverse()) {
      try { fn() } catch (e) { /* ignore */ }
    }
    try { main?.close() } catch (e) { /* ignore */ }
    try { floatPage?.close() } catch (e) { /* ignore */ }
    await sleep(1500)
    for (const pid of reinPids) {
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) { /* ignore */ }
    }
    try {
      if (notepadHwnd) spawnSync('taskkill', ['/PID', String(notepad.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch (e) { /* ignore */ }
    try {
      const still = win('pidof', { Name: 'rein' })
      console.log(still && still.length ? '     [警告] 仍有 rein 进程: ' + JSON.stringify(still) : '     [清理] tauri dev / rein.exe 已退出')
    } catch (e) {
      console.log('     [清理] 进程检查失败: ' + e.message)
    }
    logStream.end()
  }
}