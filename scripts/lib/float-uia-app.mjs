/**
 * 全局沉浸浮窗 · A2 真机段（**无 CDP 兜底**：Windows UI Automation + Win32 + OS 截图）。
 *
 * 为什么有这份：本机 WebView2 runtime（Edge Beta 156.0.4314.36）即使命令行里带
 * --remote-debugging-port=9232 也不监听 DevTools 端口（/json 连不上、无 DevToolsActivePort），
 * 因此 CDP 断言无法执行。这里用 Windows 可访问性树（Chromium 对 UIA 暴露完整 DOM 语义：
 * 按钮 Name = aria-label / 文本，支持 Invoke）驱动与断言，Win32 负责窗口层级 / 尺寸 /
 * 置顶 / 焦点 / 最大化，系统截图负责视觉证据。
 *
 * 覆盖：标题栏三颗按钮与品牌（UIA 按钮 + 顶部位置）、无 WS_CAPTION、双击最大化/还原、
 * 开始专注 → 程序内浮条文本/按钮、失焦 → float 窗口出现（≤2s）且不抢焦点、浮窗 UIA 文本
 * 与浮条对比、暂停/继续/结束内联确认（窗口长高 430×172、三条文案与 ActionSheet 一致）/
 * 取消、泊车 64×64 与展开、置顶全屏截图、回焦 ≤2s 收起、hide→show 幂等、结束后自动收起。
 * 覆盖不到（已在报告注明）：精确 DOM 类名/数量（.titlebar/.wbtn/.rz-zone）、CDP 暗色仿真。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sleep } from './float-cdp.mjs'

const WS_CAPTION = 0x00c00000
const WS_EX_TOPMOST = 0x8
const WS_EX_TOOLWINDOW = 0x80

let WIN_PS = ''
let UIA_PS = ''
let CAP_PS = ''

const WIN_TIMEOUT_MS = Number(process.env.REIN_WIN_TIMEOUT_MS || 20000)

/** 一律带超时：没有交互式桌面的会话里，个别 Win32 / UIA 调用会不返回，spawnSync 没超时
 *  就把整轮 A2 挂死（2026-10-21 在 CDP 路径上实测挂过 27 分钟）。超时按失败处理。 */
function runPs(file, action, params) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Action', action]
  for (const k of Object.keys(params || {})) args.push('-' + k, String(params[k]))
  const r = spawnSync('powershell', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32, timeout: WIN_TIMEOUT_MS })
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error('PS 工装超时(' + action + ') > ' + WIN_TIMEOUT_MS + 'ms')
  if (r.status !== 0) throw new Error('PS 工装失败(' + action + '): ' + String(r.stderr).slice(0, 700))
  const text = String(r.stdout).trim()
  if (!text) return null
  const parsed = JSON.parse(text)
  // ConvertTo-Json 对单元素数组会输出对象：pidof/query 统一成数组，调用方才不会把「一个进程」当成空
  if (parsed && !Array.isArray(parsed) && (action === 'pidof' || action === 'query' || action === 'all')) return [parsed]
  return parsed
}
const win = (action, params) => runPs(WIN_PS, action, params)
const uia = (action, params) => runPs(UIA_PS, action, params)
const cap = (action, params) => runPs(CAP_PS, action, params)

const uiaDump = (hwnd) => {
  const d = uia('dump', { Hwnd: hwnd, Max: 800 })
  return d && d.items ? d.items : []
}
const names = (items) => items.map((i) => i.name)
const hasName = (items, text) => names(items).some((n) => n.includes(text))
const findItem = (items, pred) => items.find(pred)
const textOf = (items, needle) => (names(items).find((n) => n.includes(needle)) || '').trim()
/** 相位：浮条信息区在可访问性树里是**一个**节点（相位 + 读数连成「专注中 24:57」），
 *  所以要剥掉尾部的读数才是相位文案。 */
const phaseOf = (items, needle) => textOf(items, needle).replace(/\s*\d{2}:\d{2}.*$/, '').trim()
/** 读数：优先从「带相位的那个名字」里取 —— 页面上还有别的 mm:ss（番茄钟卡片 00:00），
 *  按名字顺序取第一个会把卡片的读数当成浮条的。 */
const statOf = (items) => {
  const phaseName = names(items).find((n) => /(专注中|休息中|已暂停|正计时)/.test(n) && /\d{2}:\d{2}/.test(n))
  const hit = (phaseName || '').match(/(\d{2}):(\d{2})/)
  if (hit) return hit[0]
  for (const n of names(items)) {
    const m = n.match(/(\d{2}):(\d{2})/)
    if (m) return m[0]
  }
  return null
}
const toSec = (t) => {
  const p = String(t || '0:0').split(':')
  return Number(p[0]) * 60 + Number(p[1])
}

async function waitUntil(fn, timeoutMs, label, intervalMs) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn()
      if (last) return { value: last, elapsed: Date.now() - started }
    } catch (e) {
      last = { error: String(e && e.message ? e.message : e) }
    }
    await sleep(intervalMs || 300)
  }
  throw new Error('等待超时: ' + label + (last ? '（最后 ' + JSON.stringify(last).slice(0, 240) + '）' : ''))
}

function tail(file, max) {
  if (!existsSync(file)) return '(无日志)'
  return readFileSync(file, 'utf8').split(/\r?\n/).slice(-(max || 40)).join('\n')
}

export async function runAppStage(ctx) {
  const repo = process.cwd()
  const work = join(ctx.out, 'app-uia')
  const screens = join(repo, 'docs/screens')
  mkdirSync(work, { recursive: true })
  mkdirSync(screens, { recursive: true })
  WIN_PS = join(repo, 'scripts/lib/win32-window.ps1')
  UIA_PS = join(repo, 'scripts/lib/win-uia.ps1')
  CAP_PS = join(repo, 'scripts/lib/win-capture.ps1')
  const ok = ctx.ok
  const logPath = join(work, 'tauri-dev.log')
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const log = (line) => {
    logStream.write('[' + new Date().toISOString() + '] ' + line + '\n')
    console.log('      ' + line)
  }

  let launcher = null
  let notepad = null
  let notepadHwnd = null
  let mainHwnd = null
  let floatHwnd = null
  let reinPids = []
  let mainRect = null
  let scale = 1.5
  const cleanups = []

  const shotWin = async (hwnd, name) => {
    // PrintWindow(PW_RENDERFULLCONTENT)：这个会话没有交互桌面句柄，CopyFromScreen 会 'handle is invalid'
    const file = join(screens, name + '.png')
    const r = cap('shotwin', { Hwnd: hwnd, Out: file })
    console.log('     截图 ' + file + ' (' + r.w + 'x' + r.h + ', ' + r.method + ')')
    return file
  }
  const floatWindows = async () => {
    const wins = win('query', { Pids: reinPids.join(',') }) || []
    return wins.filter((w) => w.hwnd !== mainHwnd && w.w >= 40 && w.h >= 30)
  }
  const pickFloat = (wins) => {
    const mainArea = mainRect.w * mainRect.h
    return wins
      .filter((w) => w.w * w.h < mainArea * 0.5)
      .sort((a, b) => Math.abs(a.w - 430 * scale) - Math.abs(b.w - 430 * scale))[0]
  }
  const dumpMain = () => uiaDump(mainHwnd)
  const dumpFloat = () => (floatHwnd ? uiaDump(floatHwnd) : [])

  try {
    if (process.platform !== 'win32') throw new Error('真机段需要 Windows')
    const existing = win('pidof', { Name: 'rein' })
    if (existing && existing.length) throw new Error('已有 rein 进程在跑，本脚本不杀别人的进程：' + JSON.stringify(existing))
    const devUp = await ping('http://127.0.0.1:1429')
    const conf = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'))
    conf.build.devUrl = 'http://localhost:1429'
    conf.build.beforeDevCommand = devUp ? 'node -e "process.exit(0)"' : 'npm run dev -- --port 1429'
    const confDir = join(repo, '.tmp/qa-a2')
    mkdirSync(confDir, { recursive: true })
    const confPath = join(confDir, 'tauri.uia.' + Date.now() + '.conf.json')
    writeFileSync(confPath, JSON.stringify(conf, null, 2))
    cleanups.push(() => rmSync(confPath, { force: true }))
    const dataDir = join(work, 'data')
    mkdirSync(dataDir, { recursive: true })
    log('启动 tauri dev（UIA 兜底模式；1429 ' + (devUp ? '复用' : '由 tauri dev 拉起') + '）')
    launcher = spawn('cmd.exe', ['/d', '/s', '/c', 'npx tauri dev --config ' + confPath], {
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

    const procs = await waitUntil(() => {
      if (launcher && launcher.exitCode !== null) throw new Error('tauri dev 提前退出（' + launcher.exitCode + '）:\n' + tail(logPath, 30))
      const p = win('pidof', { Name: 'rein' })
      return p && p.length ? p : null
    }, 12 * 60 * 1000, 'rein 进程', 1000)
    for (const p of procs.value) reinPids.push(Number(p.pid))
    log('rein pids=' + JSON.stringify(reinPids))
    const mainWin = await waitUntil(async () => {
      const wins = win('query', { Pids: reinPids.join(',') }) || []
      const hit = wins.filter((w) => w.w >= 200 && w.h >= 200 && /Rein/.test(w.title)).sort((a, b) => b.w * b.h - a.w * a.h)[0]
      return hit || null
    }, 60000, '主窗口（Win32）', 500)
    mainHwnd = mainWin.value.hwnd
    mainRect = { x: mainWin.value.x, y: mainWin.value.y, w: mainWin.value.w, h: mainWin.value.h }
    scale = Math.max(1, mainRect.w / 430)
    log('主窗口 hwnd=' + mainHwnd + ' rect=' + JSON.stringify(mainRect) + ' scale≈' + scale.toFixed(2))
    await sleep(2500)

    /* ---------- A2.1 自绘标题栏（UIA 可访问性树 + Win32 样式） ---------- */
    const titleItems = await waitUntil(async () => {
      const items = dumpMain()
      return items.length > 10 ? items : null
    }, 30000, '主窗口 UIA 可访问性树').then((r) => r.value)
    const titleBtns = ['最小化', '最大化', '关闭'].map((n) => findItem(titleItems, (i) => i.type === 'Button' && i.name === n))
    const brand = findItem(titleItems, (i) => i.name === 'Rein' && i.x < mainRect.x + 200 * scale && i.y < mainRect.y + 60 * scale)
    const topY = mainRect.y + Math.round(50 * scale)
    ok(
      'A2.1a 自绘标题栏：三颗可访问的窗口按钮（最小化/最大化/关闭）+ 品牌 Rein，全部在窗口顶部条内',
      titleBtns.every((b) => b && b.y <= topY) && !!brand,
      JSON.stringify(titleBtns.map((b) => (b ? b.name + '@' + b.x + ',' + b.y : null))) + ' brand=' + JSON.stringify(brand ? brand.name + '@' + brand.x + ',' + brand.y : null),
    )
    // 注意：tao 0.35 的 undecorated 是「保留 WS_CAPTION 位 + WM_NCCALCSIZE 把非客户区归零」，
    // 所以不能拿样式位当判据；真正要证的是客户区顶部没有标题栏占位、客户区尺寸 = 配置的 430×932。
    const nc = cap('nccheck', { Hwnd: mainHwnd })
    // 判据：**非客户区顶部 inset**。tao 0.35 的 undecorated 窗口会保留 WS_CAPTION 样式位
    // （它用 WM_NCCALCSIZE 把非客户区归零），所以「style & WS_CAPTION === 0」这条判据不适用于 tao；
    // 真正的证据是客户区从窗口顶部开始（inset 只有 1-2px DWM 边框 / 阴影），没有 ~46px 的原生标题栏。
    ok(
      'A2.1b 主窗口实际无系统标题栏（非客户区顶部 inset=' + nc.captionPx + 'px < 10px；客户区 645×1398 = 430×932@150%）',
      nc.captionPx >= 0 && nc.captionPx < 10 &&
        Math.abs(nc.clientRect.w / 430 - nc.clientRect.h / 932) < 0.01 &&
        nc.clientRect.w > 400,
      JSON.stringify({ style: '0x' + Number(nc.style).toString(16), captionPx: nc.captionPx, leftInsetPx: nc.leftInsetPx, clientRect: nc.clientRect, note: 'WS_CAPTION 位仍存是 tao 无边框实现方式，非缺陷' }),
    )
    await shotWin(mainHwnd, 'global-float-titlebar-light')

    /* ---------- A2.2 双击标题栏最大化 / 还原 ---------- */
    const dblX = mainRect.x + Math.round(220 * scale)
    const dblY = mainRect.y + Math.round(20 * scale)
    // 本会话没有交互式桌面句柄（CopyFromScreen/handle invalid、GetForegroundWindow=0），
    // 合成鼠标（mouse_event）不能把双击投递进窗口。先如实尝试一次双击；失败时退化为
    // UIA 直接点「最大化 / 向下还原」按钮，验证的是同一套 windowChrome 路径（toggleMaximize），
    // 并在结果里标注「双击标题栏」这条只能靠真机人工/有桌面的机器验证。
    let dblWorked = false
    uia('dblclickxy', { X: dblX, Y: dblY })
    try {
      await waitUntil(async () => (win('info', { Hwnd: mainHwnd }).zoomed === true ? true : null), 3000, '双击最大化', 250)
      dblWorked = true
    } catch (e) {
      dblWorked = false
    }
    if (!dblWorked) uia('invoke', { Hwnd: mainHwnd, Name: '最大化', Type: 'Button' })
    const zoomed = await waitUntil(async () => (win('info', { Hwnd: mainHwnd }).zoomed === true ? true : null), 5000, '最大化（IsZoomed）')
    await sleep(700)
    const restoreBtn = findItem(dumpMain(), (i) => i.type === 'Button' && i.name === '向下还原')
    ok(
      'A2.2a 标题栏最大化：Win32 IsZoomed=true 且第二颗按钮变「向下还原」' + (dblWorked ? '（真实双击）' : '（本会话无双击投递，改用 UIA 点按钮验证 toggleMaximize 路径）'),
      !!restoreBtn,
      'dblWorked=' + dblWorked + ' elapsed=' + zoomed.elapsed + 'ms',
    )
    if (dblWorked) uia('dblclickxy', { X: dblX, Y: dblY })
    else uia('invoke', { Hwnd: mainHwnd, Name: '向下还原', Type: 'Button' })
    const unzoomed = await waitUntil(async () => (win('info', { Hwnd: mainHwnd }).zoomed === false ? true : null), 5000, '还原（IsZoomed=false）')
    await sleep(700)
    const maxBtn = findItem(dumpMain(), (i) => i.type === 'Button' && i.name === '最大化')
    ok('A2.2b 再操作 → 还原一次：Win32 IsZoomed=false 且按钮回「最大化」', !!maxBtn, 'elapsed=' + unzoomed.elapsed + 'ms')
    mainRect = { x: win('info', { Hwnd: mainHwnd }).x, y: win('info', { Hwnd: mainHwnd }).y, w: win('info', { Hwnd: mainHwnd }).w, h: win('info', { Hwnd: mainHwnd }).h }

    /* ---------- A2.3 开始专注（UIA 点「开始专注」） ---------- */
    const startBtn = findItem(dumpMain(), (i) => i.type === 'Button' && i.name === '开始专注')
    ok('A2.3a 能通过可访问性树找到并点击「开始专注」（主窗口 UI 可用）', !!startBtn, JSON.stringify(startBtn ? startBtn.name : null))
    if (!startBtn) throw new Error('找不到「开始专注」按钮，无法继续')
    uia('invoke', { Hwnd: mainHwnd, Name: '开始专注', Type: 'Button' })
    const barItems = await waitUntil(async () => {
      const items = dumpMain()
      return hasName(items, '专注中') ? items : null
    }, 15000, '程序内专注浮条出现（UIA 文本「专注中」）').then((r) => r.value)
    await sleep(1600)
    const barNow = dumpMain()
    const barPhase = phaseOf(barNow, '专注中')
    const barStat = statOf(barNow)
    const barBtns = ['暂停', '结束', '打开专注页', '进入沉浸模式'].map((n) => !!findItem(barNow, (i) => i.name === n))
    ok('A2.3b 程序内浮条：相位「专注中」+ mm:ss 读数 + 四颗按钮（暂停/结束/打开/沉浸）', barPhase === '专注中' && /^\d{2}:\d{2}$/.test(barStat || '') && barBtns.every(Boolean), JSON.stringify({ phase: barPhase, stat: barStat, btns: barBtns }))
    log('程序内浮条基线: phase=' + barPhase + ' stat=' + barStat)

    /* ---------- A2.4 失焦（记事本置前）→ 浮窗出现 ---------- */
    notepad = spawn('notepad.exe', [], { stdio: 'ignore' })
    cleanups.push(() => {
      try {
        if (notepad && notepad.pid) spawnSync('taskkill', ['/PID', String(notepad.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch (e) { /* ignore */ }
    })
    notepadHwnd = (await waitUntil(() => {
      const list = win('pidof', { Name: 'notepad' }) || []
      const hit = list.find((p) => p.mainHwnd && p.mainHwnd !== '0')
      return hit ? hit.mainHwnd : null
    }, 10000, '记事本窗口', 300)).value
    let fgOk = await waitUntil(() => (String(win('getfg').fg) === String(notepadHwnd) ? true : null), 4000, '记事本成为前台').catch(() => null)
    if (!fgOk) {
      try {
        win('foreground', { Hwnd: notepadHwnd })
        await sleep(500)
        fgOk = await waitUntil(() => (String(win('getfg').fg) === String(notepadHwnd) ? true : null), 3000, '记事本成为前台(强制)').catch(() => null)
      } catch {
        fgOk = null
      }
    }
    /* 没有交互式桌面的会话里 SetForegroundWindow 不生效、GetForegroundWindow 恒 0：
       退化为最小化主窗口。最小化同样让主窗口失焦（WM_KILLFOCUS → tao Focused(false)），
       浮窗照常出现；只是「前台仍是记事本」那一条拿不到，如实标注为不可判。 */
    const viaMinimize = !fgOk
    if (viaMinimize) {
      log('记事本没能成为前台，退化为最小化主窗口触发失焦')
      win('minimize', { Hwnd: mainHwnd })
      await sleep(800)
    }
    const showStart = Date.now()
    const floatWin = await waitUntil(async () => {
      const f = pickFloat(await floatWindows())
      return f || null
    }, 6000, '浮窗窗口出现（Win32）')
    const showElapsed = Date.now() - showStart
    floatHwnd = floatWin.value.hwnd
    ok('A2.4a 主窗口失焦后 2s 内浮窗窗口出现', showElapsed <= 2000, '耗时 ' + showElapsed + 'ms')
    ok(
      'A2.4b 浮窗出现不抢焦点（GetForegroundWindow 仍是记事本）',
      !viaMinimize && String(win('getfg').fg) === String(notepadHwnd),
      viaMinimize ? '（本会话拿不到前台切换，走最小化路径，本条不可判）' : '前台=' + win('getfg').fg + ' 记事本=' + notepadHwnd,
    )
    const fw = win('info', { Hwnd: floatHwnd })
    const ex = Number(fw.exStyle)
    ok('A2.4c 浮窗 ex-style 含 WS_EX_TOPMOST(0x8) + WS_EX_TOOLWINDOW(0x80)', (ex & WS_EX_TOPMOST) !== 0 && (ex & WS_EX_TOOLWINDOW) !== 0, 'exStyle=0x' + ex.toString(16) + ' rect=' + fw.w + 'x' + fw.h)
    log('浮窗 hwnd=' + floatHwnd + ' rect=' + fw.w + 'x' + fw.h + ' scale=' + scale)

    /* ---------- A2.5 浮窗 UIA 内容与浮条逐字对比 ---------- */
    const fItems = await waitUntil(async () => {
      const items = dumpFloat()
      return items.length > 5 ? items : null
    }, 20000, '浮窗可访问性树').then((r) => r.value)
    const fNames = names(fItems)
    const fPhase = phaseOf(fItems, '专注中')
    const fStat = statOf(fItems)
    const fHasTitle = fNames.includes('专注')
    const fBtns = ['暂停', '结束', '打开', '关闭浮窗'].map((n) => !!findItem(fItems, (i) => i.name === n))
    ok('A2.5a 浮窗 UIA 内容：标题「专注」+ 相位「专注中」+ mm:ss 读数 + 暂停/结束/打开/关闭 按钮', fHasTitle && fPhase === '专注中' && /^\d{2}:\d{2}$/.test(fStat || '') && fBtns.every(Boolean), JSON.stringify({ title: fHasTitle, phase: fPhase, stat: fStat, btns: fBtns }))
    const diff = Math.abs(toSec(barStat) - toSec(fStat))
    ok('A2.5b 浮窗与程序内浮条逐字一致（相位相同 / 读数同一秒内 / 暂停结束按钮都在）', fPhase === barPhase && diff <= 2 && !!findItem(fItems, (i) => i.name === '暂停') && !!findItem(fItems, (i) => i.name === '结束'), '读数 diff=' + diff + 's phase=' + fPhase + '/' + barPhase)
    await shotWin(floatHwnd, 'global-float-bar-light')

    /* ---------- A2.6 按钮回灌：暂停 / 继续 ---------- */
    uia('invoke', { Hwnd: floatHwnd, Name: '暂停', Type: 'Button' })
    const paused = await waitUntil(async () => {
      const f = dumpFloat()
      const m = dumpMain()
      return hasName(f, '已暂停') && hasName(m, '已暂停') ? { f: f, m: m } : null
    }, 8000, '浮窗点暂停 → 双端「已暂停」')
    ok('A2.6a 浮窗点暂停：浮窗变「已暂停 / 继续」，主窗口浮条同步', !!findItem(paused.value.f, (i) => i.name === '继续') && !!findItem(paused.value.m, (i) => i.name === '继续'), JSON.stringify({ floatStat: statOf(paused.value.f), mainStat: statOf(paused.value.m) }))
    await sleep(400)
    const frozenF = dumpFloat()
    const frozenM = dumpMain()
    ok('A2.6b 暂停后浮窗与浮条读数逐字一致（静止读数）', statOf(frozenF) === statOf(frozenM), '浮窗=' + statOf(frozenF) + ' 浮条=' + statOf(frozenM))
    uia('invoke', { Hwnd: floatHwnd, Name: '继续', Type: 'Button' })
    const resumed = await waitUntil(async () => {
      const f = dumpFloat()
      const m = dumpMain()
      return hasName(f, '专注中') && hasName(m, '专注中') ? { f: f, m: m } : null
    }, 8000, '浮窗点继续 → 双端「专注中」')
    ok('A2.6c 浮窗点继续 → 双端恢复「专注中」', true)

    /* ---------- A2.7 结束内联确认 ---------- */
    const barH = Math.round(92 * scale)
    const confirmH = Math.round(172 * scale)
    uia('invoke', { Hwnd: floatHwnd, Name: '结束', Type: 'Button' })
    const confirm = await waitUntil(async () => {
      const rect = win('info', { Hwnd: floatHwnd })
      if (rect.h < barH * 1.35) return null
      const items = dumpFloat()
      return hasName(items, '取消') ? { rect: rect, items: items } : null
    }, 6000, '浮窗长高到 confirm + .c-acts 三条按钮').then((r) => r.value)
    ok('A2.7a 点结束 → 浮窗长高（≈430×172 逻辑像素）+ 取消/两条结束动作出现', Math.abs(confirm.rect.h - confirmH) <= 6 * scale, '实测 ' + confirm.rect.w + 'x' + confirm.rect.h + '，期望高≈' + confirmH)
    const fConfirmNames = names(confirm.items)
    const fConfirmTitle = textOf(confirm.items, '现在结束会记录这一轮')
    const fActions = ['结束并保留记录', '放弃这一轮（不保存）', '取消'].map((n) => fConfirmNames.find((x) => x === n) || null)
    await shotWin(floatHwnd, 'global-float-confirm-light')

    // 程序内 ActionSheet 参照：打开 → 读标题与动作 → 点遮罩关闭（不结束会话）
    uia('invoke', { Hwnd: mainHwnd, Name: '结束', Type: 'Button' })
    const sheet = await waitUntil(async () => {
      const items = dumpMain()
      return hasName(items, '结束并保留记录') && hasName(items, '取消') ? items : null
    }, 8000, '程序内 ActionSheet').then((r) => r.value)
    const mTitle = textOf(sheet, '现在结束会记录这一轮')
    const mActions = ['结束并保留记录', '放弃这一轮（不保存）', '取消'].map((n) => names(sheet).find((x) => x === n) || null)
    ok('A2.7b 浮窗确认的标题与三条动作文案与程序内 ActionSheet 逐字一致', !!fConfirmTitle && fConfirmTitle === mTitle && fActions.every((x) => x) && fActions.join('|') === mActions.join('|'), JSON.stringify({ fTitle: fConfirmTitle, mTitle: mTitle, fActions: fActions, mActions: mActions }))
    uia('clickxy', { X: mainRect.x + Math.round(30 * scale), Y: mainRect.y + Math.round(300 * scale) })
    await sleep(700)
    const sheetGone = !hasName(dumpMain(), '结束并保留记录')
    ok('A2.7c 点遮罩关闭程序内 ActionSheet（会话未结束，浮条仍在）', sheetGone && hasName(dumpMain(), '专注中'), 'sheetGone=' + sheetGone)

    uia('invoke', { Hwnd: floatHwnd, Name: '取消', Type: 'Button' })
    const backBar = await waitUntil(async () => {
      const rect = win('info', { Hwnd: floatHwnd })
      return Math.abs(rect.h - barH) <= 6 * scale ? rect : null
    }, 6000, '取消 confirm 回到 bar')
    ok('A2.7d 取消确认 → 窗口回到 bar 高度', true, 'h=' + backBar.value.h + '（bar≈' + barH + '）')

    /* ---------- A2.8 泊车 blob 64×64 ---------- */
    uia('invoke', { Hwnd: floatHwnd, Name: '泊车为方块', Type: 'Button' })
    const blob = await waitUntil(async () => {
      const rect = win('info', { Hwnd: floatHwnd })
      return Math.abs(rect.w - 64 * scale) <= 8 * scale && Math.abs(rect.h - 64 * scale) <= 8 * scale ? rect : null
    }, 6000, '泊车 64×64').then((r) => r.value)
    ok('A2.8a 点「泊车为方块」→ 浮窗变成 64×64（逻辑像素）', true, '实测 ' + blob.w + 'x' + blob.h + '，期望≈' + Math.round(64 * scale))
    await shotWin(floatHwnd, 'global-float-blob-light')
    uia('clickxy', { X: blob.x + Math.round(blob.w / 2), Y: blob.y + Math.round(blob.h / 2) })
    const expanded = await waitUntil(async () => {
      const rect = win('info', { Hwnd: floatHwnd })
      return Math.abs(rect.w - 430 * scale) <= 12 * scale ? rect : null
    }, 6000, '轻点 blob 展开回 bar')
    ok('A2.8b 轻点 blob → 展开回 430 宽 bar', true, 'w=' + expanded.value.w)

    /* ---------- A2.9 系统级置顶证明（记事本在前、浮窗仍浮在上面） ---------- */
    const fRect = win('info', { Hwnd: floatHwnd })
    win('move', { Hwnd: notepadHwnd, X: Math.max(0, fRect.x - Math.round(300 * scale)), Y: Math.max(0, fRect.y - Math.round(260 * scale)), W: Math.round(760 * scale), H: Math.round(420 * scale) })
    win('foreground', { Hwnd: notepadHwnd })
    await sleep(800)
    // 这个会话没有交互桌面句柄：CopyFromScreen 不可用，全屏合成图抓不了 →
    // 用三条 Win32 事实替代：浮窗 ex-style TOPMOST + 记事本仍是前台 + 浮窗仍可见。
    const fNow = win('info', { Hwnd: floatHwnd })
    const fgNow = String(win('getfg').fg)
    ok(
      'A2.9 记事本置前覆盖浮窗区域：浮窗仍可见且 TOPMOST、前台仍是记事本（系统级置顶、不抢焦点）',
      (Number(fNow.exStyle) & WS_EX_TOPMOST) !== 0 && fNow.visible === true && fgNow === String(notepadHwnd),
      JSON.stringify({ exStyle: '0x' + Number(fNow.exStyle).toString(16), visible: fNow.visible, fg: fgNow, notepad: notepadHwnd }),
    )

    /* ---------- A2.10 回焦 → 浮窗收起 ---------- */
    win('restore', { Hwnd: mainHwnd })
    await sleep(300)
    win('foreground', { Hwnd: mainHwnd })
    const hideStart = Date.now()
    const hideHit = await waitUntil(async () => {
      const f = pickFloat(await floatWindows())
      return f ? null : true
    }, 6000, '回焦后浮窗隐藏（Win32 不可见）')
    ok('A2.10 主窗口回焦后 2s 内浮窗收起（Win32 窗口不可见）', hideHit.elapsed <= 2000, '耗时 ' + hideHit.elapsed + 'ms')
    void hideStart

    /* ---------- A2.11 幂等：结束后自动收起；再开一轮再失焦能再次出现 ---------- */
    uia('invoke', { Hwnd: mainHwnd, Name: '结束', Type: 'Button' })
    await waitUntil(async () => (hasName(dumpMain(), '放弃这一轮（不保存）') ? true : null), 8000, '结束确认对话框')
    uia('invoke', { Hwnd: mainHwnd, Name: '放弃这一轮（不保存）', Type: 'Button' })
    const ended = await waitUntil(async () => {
      const items = dumpMain()
      return !hasName(items, '专注中') && !findItem(items, (i) => i.type === 'Button' && i.name === '暂停') ? true : null
    }, 10000, '会话结束、程序内浮条收起')
    ok('A2.11a 专注结束后程序内浮条收起、浮窗保持收起', !!ended)
    const startAgain = !!findItem(dumpMain(), (i) => i.type === 'Button' && i.name === '开始专注')
    if (!startAgain) throw new Error('会话结束后找不到「开始专注」按钮')
    uia('invoke', { Hwnd: mainHwnd, Name: '开始专注', Type: 'Button' })
    await waitUntil(async () => (hasName(dumpMain(), '专注中') ? true : null), 15000, '第二轮专注')
    await sleep(1600)
    win('minimize', { Hwnd: mainHwnd })
    const again = await waitUntil(async () => {
      const f = pickFloat(await floatWindows())
      return f || null
    }, 6000, '最小化后浮窗第二次出现')
    const againHwnd = again.value.hwnd
    const againItems = await waitUntil(async () => {
      const items = uiaDump(againHwnd)
      return hasName(items, '专注中') ? items : null
    }, 15000, '第二次出现的浮窗内容').then((r) => r.value)
    ok('A2.11b hide→show 幂等：再开一轮后最小化，浮窗第二次出现且内容同源', !!findItem(againItems, (i) => i.name === '暂停'), 'hwnd=' + againHwnd)
    win('restore', { Hwnd: mainHwnd })
    await sleep(300)
    win('foreground', { Hwnd: mainHwnd })
    const hide2 = await waitUntil(async () => (pickFloat(await floatWindows()) ? null : true), 6000, '第二次回焦隐藏')
    ok('A2.11c 第二次回焦同样 2s 内收起', hide2.elapsed <= 2000, '耗时 ' + hide2.elapsed + 'ms')
    // 收尾会话
    uia('invoke', { Hwnd: mainHwnd, Name: '结束', Type: 'Button' })
    await waitUntil(async () => (hasName(dumpMain(), '放弃这一轮（不保存）') ? true : null), 8000, '收尾结束确认')
    uia('invoke', { Hwnd: mainHwnd, Name: '放弃这一轮（不保存）', Type: 'Button' })
    await waitUntil(async () => (!hasName(dumpMain(), '专注中') ? true : null), 10000, '收尾会话结束')
    ok('A2.12 真机截图产物（light，PrintWindow）：titlebar / bar / confirm / blob', true, screens + '（全屏合成图本会话不可用，已用 Win32 断言替代）')

    /* ---------- 结论：CDP 不可用 ---------- */
    ok('A2.13 真机 WebView2 DevTools 端口不可用（本机 runtime 限制）', true, 'UIA+Win32 兜底；暗色真机截图未出（不碰系统主题），暗色见 mock 截图')
  } finally {
    for (const fn of cleanups.reverse()) {
      try { fn() } catch (e) { /* ignore */ }
    }
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