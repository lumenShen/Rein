#!/usr/bin/env node
/**
 * 全局沉浸浮窗 + 桌面自绘标题栏 · 端到端验证（docs/GLOBAL-FLOAT.md §10）
 *
 * 两段式：
 *   A1 mock（浏览器，无头 Edge + 原生 CDP，走 src/mock/server.ts）
 *     · 设置页「全局浮窗」卡在场、如实写「不支持」、开关落 localStorage 并持久化；
 *     · 浏览器模式不出现自绘标题栏 / 拖拽区 / 窗口按钮，430×932 与 1512×945 的壳层不回归；
 *     · 直接打开 float.html 渲染「等待会话」空态且零未捕获异常；
 *     · 既有程序内浮条零变化（专注浮条相位/读数/四颗按钮、结束确认文案；录音条与运动条冒烟）；
 *     · 全流程 console.error / 未捕获异常为零（favicon 404 不计）。
 *   A2 真机（Tauri + WebView2 远程调试，scripts/lib/float-app.mjs）
 *     · 自绘标题栏 DOM、无 WS_CAPTION、双击最大化/还原、八向缩放热区；
 *     · 专注开始后主窗口失焦 → float 窗口出现、DOM 与程序内浮条逐字一致；
 *     · 浮窗按钮回灌（暂停/继续/结束内联确认/取消）、回焦隐藏、hide→show 幂等；
 *     · 置顶且不抢焦点（记事本在前）、ex-style 含 WS_EX_TOPMOST + WS_EX_TOOLWINDOW；
 *     · 浅色 / 暗色截图 → docs/screens/global-float-*.png。
 *
 * 运行：
 *   node scripts/e2e-global-float.mjs                     # A1（默认，约 20s）
 *   node scripts/e2e-global-float.mjs --app               # A2（会自己起 npx tauri dev；首次编译几分钟）
 *   node scripts/e2e-global-float.mjs --all               # A1 + A2
 *   node scripts/e2e-global-float.mjs --mock              # 显式只跑 A1
 *
 * A2 的两种驱动（重要）：
 *   · 默认：CDP（Tauri/WebView2 远程调试，临时配置注入 additionalBrowserArgs）。跑不起来时
 *     会自动切 UIA 兜底（scripts/lib/float-uia-app.mjs）。
 *   · REIN_APP_FORCE_UIA=1：跳过 CDP，直接用 Windows UI Automation（可访问性树）+ Win32 + PrintWindow。
 *   · REIN_APP_NO_FALLBACK=1：禁止自动兜底（CDP 失败即报错退出）。
 *
 * 本机已知限制（2026-10-20 实测，Windows 11 26220 + Edge Beta WebView2 156.0.4314.36）：
 *   1) WebView2 的 DevTools 端口**不监听**：msedgewebview2.exe 命令行里有 --remote-debugging-port=9232，
 *      但 netstat 无 LISTENING、/json/version 连接被拒、EBWebView\DevToolsActivePort 不存在；
 *      试过 feature 开关（--enable-features=msWebView2EnableDevTools / --remote-allow-origins=*）无效。
 *      环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 被 wry 的 AdditionalBrowserArguments 覆盖。
 *   2) 该会话没有交互式桌面句柄：CopyFromScreen 报 "The handle is invalid"、GetForegroundWindow 恒 0。
 *      截图改用 PrintWindow(PW_RENDERFULLCONTENT)（能抓到 WebView2 真实渲染），
 *      但「双击标题栏 / 记事本前台抢焦点」这类输入投递无法自动化，需在有桌面的机器人工验。
 *   3) UIA 兜底可断言：标题栏三按钮/品牌、实际无系统标题栏（非客户区顶部 inset < 10px）、
 *      最大化/还原（可退回 UIA 按钮）、开专注、程序内浮条文本按钮、失焦（最小化）浮窗出现、
 *      浮窗文本/按钮与浮条对比、暂停/继续/结束内联确认/取消、泊车 64×64、结束后收起。
 *      不可断言：精确 DOM 类名/数量、置顶的 GetForegroundWindow 不抢焦点（改为 ex-style 断言）。
 *
 * 环境变量：
 *   REIN_E2E_URL       mock 段的应用地址（默认 http://localhost:1429，避开别人占用的 1420）
 *   REIN_E2E_OUT       截图 / 诊断输出目录（默认系统临时目录）
 *   REIN_APP_CDP_PORT  真机段 WebView2 调试端口（默认 9232）
 *   REIN_APP_FORCE_UIA 1 = 直接走 UIA 兜底
 *   REIN_APP_NO_FALLBACK 1 = CDP 失败不自动切 UIA
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL；2 = 剧本中断（环境问题）。
 */
import { rmSync } from 'node:fs'

import {
  launchBrowser,
  openPage,
  sleep,
  injectErrorCollector,
  watchErrors,
  pageErrors,
} from './lib/float-cdp.mjs'

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1429'
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-float-${Date.now()}`

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ==========================================================================
 * A1 · mock（浏览器）
 * ========================================================================== */

/** 启动提示卡（全屏遮罩）会挡住一切点击，出现就点「稍后」 */
async function dismissUpdate(page) {
  return page.eval(`(() => {
    const btn = [...document.querySelectorAll('.up-card button')].find((b) => b.textContent.trim() === '稍后')
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

async function gotoHash(page, hash, readyExpr, label) {
  await page.send('Page.bringToFront').catch(() => undefined)
  await page.eval(`location.hash = ${JSON.stringify(hash)}`)
  try {
    await page.waitFor(readyExpr, 10000, label ?? `路由 ${hash}`)
  } catch {
    // 无头下 out-in 过渡偶发卡死（与 e2e-cdp 同一条已知问题）：以目标页挂载为准，卡住就重载
    console.log(`  [诊断] ${label ?? hash} 过渡卡住，重载恢复`)
    await page.send('Page.reload')
    await page.waitFor(`!!document.querySelector('.page')`, 30000, '重载应用')
    await sleep(900)
    await dismissUpdate(page)
    await page.waitFor(readyExpr, 20000, label ?? `路由 ${hash}`)
  }
  await sleep(350)
  await dismissUpdate(page)
  await sleep(150)
}

/** 设置页的「全局浮窗」卡（用 h2 精确匹配，避免命中含该词的其它卡片） */
const FLOAT_CARD = `[...document.querySelectorAll('section.card')]
  .find((s) => s.querySelector('h2')?.textContent.trim() === '全局浮窗')`

async function readFloatCard(page) {
  return page.eval(`(() => {
    const card = ${FLOAT_CARD}
    if (!card) return null
    const sw = card.querySelector('button[role="switch"]')
    return {
      title: card.querySelector('h2')?.textContent.trim() ?? null,
      state: card.querySelector('.gstate')?.textContent.trim() ?? null,
      note: card.querySelector('.pnote')?.textContent.trim() ?? null,
      switchLabel: sw?.getAttribute('aria-label') ?? null,
      checked: sw?.getAttribute('aria-checked') ?? null,
    }
  })()`)
}

function clickFloatToggle(page) {
  return page.eval(`(() => {
    const card = ${FLOAT_CARD}
    const sw = card?.querySelector('button[role="switch"]')
    if (!sw) return false
    sw.click()
    return true
  })()`)
}

const KEY_FLOAT = 'rein.globalFloat.v1'

/** 程序内专注浮条的事实（相位 / 读数 / 状态点 / 按钮文案与读屏名） */
const FOCUS_BAR = `(() => {
  const root = document.querySelector('.fdock-root')
  if (!root) return null
  const bar = root.querySelector('.layer-bar')
  if (!bar) return null
  const btns = [...bar.querySelectorAll('.acts .abtn')]
  return {
    phase: bar.querySelector('.info .t')?.textContent.trim() ?? null,
    time: bar.querySelector('.info .s')?.textContent.trim() ?? null,
    dot: bar.querySelector('.info .dot')?.className ?? null,
    texts: btns.map((b) => b.textContent.trim()),
    arias: btns.map((b) => b.getAttribute('aria-label')).filter(Boolean),
    infoIsButton: bar.querySelector('.info')?.tagName === 'BUTTON',
  }
})()`

async function startFocus(page) {
  const started = await page.eval(`(() => {
    const el = document.querySelector('.page .card .cta') ?? document.querySelector('.page .card .acts .ibtn.main')
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!started) throw new Error('专注页找不到起跑按钮（.page .card .cta）')
  await page.waitFor(`!!document.querySelector('.fdock-root .layer-bar .info')`, 10000, '专注浮条出现')
  // 等计时真的走掉 1 秒再返回：番茄钟把「暂停但一秒钟都没走」当作空闲态（既有语义），
  // 刚起跑就暂停会让浮条整体收起 —— 那不是浮窗改造引入的行为，测试按真实使用节奏来。
  await sleep(1400)
}

async function stageMock() {
  const preflight = await fetch(APP).catch(() => null)
  if (!preflight?.ok) throw new Error(`mock 段前置失败：${APP} 不可访问（先起 npx vite --port 1429）`)

  const browser = await launchBrowser({ windowSize: '430,932' })
  let main
  try {
    const opened = await openPage(browser.port, 'about:blank', 'mock-main')
    main = opened.page
    const runtime = watchErrors(main)
    await injectErrorCollector(main)
    await main.send('Page.startScreencast', { format: 'jpeg', everyNthFrame: 1 }).catch(() => undefined)
    // 无头下过渡会偶发停住：e2e 只验逻辑与渲染，关掉 CSS 过渡（与 e2e-cdp 同一处理）
    await main.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__errs = []
        window.addEventListener('error', (e) => window.__errs.push(String(e.message)))
        window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)))
        const add = () => {
          if (document.getElementById('__e2e-stable')) return
          const style = document.createElement('style')
          style.id = '__e2e-stable'
          style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
          document.head.appendChild(style)
        }
        if (document.head) add()
        else document.addEventListener('DOMContentLoaded', add)
      })()`,
    })
    await main.send('Page.navigate', { url: `${APP}/#/` })
    await main.waitFor(`location.href.startsWith(${JSON.stringify(APP)}) && !!document.querySelector('.page')`, 45000, '应用挂载')
    await sleep(1500)
    await dismissUpdate(main)

    /* ---------- A1.1 设置页「全局浮窗」卡 / 降级态 / 开关持久化 ---------- */
    await gotoHash(main, '#/settings', `document.querySelector('h1')?.textContent === '设置'`, '设置页')
    const card = await readFloatCard(main)
    ok(
      'A1.1a 设置页有「全局浮窗」卡（开关读屏名 = 全局浮窗）',
      !!card && card.switchLabel === '全局浮窗' && card.title === '全局浮窗',
      JSON.stringify(card),
    )
    ok(
      'A1.1b 卡头如实写「不支持」（浏览器没有系统浮窗）',
      !!card && card.state.includes('不支持') && card.note.includes('浏览器预览'),
      `状态=${card?.state} 说明=${card?.note?.slice(0, 46)}`,
    )
    const mockStatus = await main.eval(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      return await invoke('global_float_status')
    })()`)
    ok(
      'A1.1c 浏览器 mock 返回 supported:false（上层据此降级）',
      mockStatus?.supported === false && mockStatus?.permitted === false,
      JSON.stringify(mockStatus),
    )

    const keyBefore = await main.eval(`localStorage.getItem(${JSON.stringify(KEY_FLOAT)})`)
    ok('A1.1d 开关默认开（未写入 localStorage 时按默认 true 渲染）', card?.checked === 'true', `checked=${card?.checked} key=${keyBefore}`)
    if (!(await clickFloatToggle(main))) throw new Error('点不到「全局浮窗」开关')
    await main.waitFor(`${FLOAT_CARD}?.querySelector('button[role="switch"]')?.getAttribute('aria-checked') === 'false'`, 4000, '开关关闭')
    const afterOff = {
      key: await main.eval(`localStorage.getItem(${JSON.stringify(KEY_FLOAT)})`),
      card: await readFloatCard(main),
    }
    ok(
      'A1.1e 点开关 → 关：localStorage rein.globalFloat.v1 = 0',
      afterOff.key === '0' && afterOff.card?.checked === 'false',
      `key=${afterOff.key} checked=${afterOff.card?.checked}`,
    )
    // 持久化：刷新后仍是关
    await main.send('Page.reload')
    await main.waitFor(`!!document.querySelector('.page')`, 45000, '刷新后应用挂载')
    await sleep(1600)
    await dismissUpdate(main)
    await gotoHash(main, '#/settings', `document.querySelector('h1')?.textContent === '设置'`, '刷新后设置页')
    const afterReload = {
      key: await main.eval(`localStorage.getItem(${JSON.stringify(KEY_FLOAT)})`),
      card: await readFloatCard(main),
    }
    ok(
      'A1.1f 刷新后仍是关（偏好持久化）',
      afterReload.key === '0' && afterReload.card?.checked === 'false',
      `key=${afterReload.key} checked=${afterReload.card?.checked}`,
    )
    // 恢复成开，后面的浮条场景不受它影响
    if (!(await clickFloatToggle(main))) throw new Error('点不到开关（恢复开）')
    await main.waitFor(`${FLOAT_CARD}?.querySelector('button[role="switch"]')?.getAttribute('aria-checked') === 'true'`, 4000, '开关恢复开')
    ok('A1.1g 再点一次恢复开并写回 1', (await main.eval(`localStorage.getItem(${JSON.stringify(KEY_FLOAT)})`)) === '1')

    /* ---------- A1.2 浏览器模式无自绘标题栏 / 缩放热区；两种视口壳层不回归 ---------- */
    const chrome = await main.eval(`({
      titlebar: document.querySelectorAll('.titlebar').length,
      dragRegion: document.querySelectorAll('[data-tauri-drag-region]').length,
      wbtn: document.querySelectorAll('.wbtn').length,
      rz: document.querySelectorAll('.rz, .rz-zone').length,
      shell: document.querySelector('.win-shell')?.className ?? null,
    })`)
    ok(
      'A1.2a 浏览器模式无标题栏 / 拖拽区 / 窗口按钮 / 缩放热区',
      chrome.titlebar === 0 && chrome.dragRegion === 0 && chrome.wbtn === 0 && chrome.rz === 0,
      JSON.stringify(chrome),
    )

    // 窄屏 430×932：仍是 .app-frame，x=0、宽=430，文档可滚
    await main.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
    await gotoHash(main, '#/settings', `document.querySelector('h1')?.textContent === '设置'`, '窄屏设置页')
    const phone = await main.eval(`(() => {
      const frame = document.querySelector('.app-frame')
      const r = frame?.getBoundingClientRect()
      const se = document.scrollingElement
      return {
        frame: !!frame,
        x: r ? Math.round(r.x) : null,
        w: r ? Math.round(r.width) : null,
        desk: !!document.querySelector('.desk-frame'),
        docScrollable: !!se && se.scrollHeight > se.clientHeight + 10,
        innerW: window.innerWidth,
      }
    })()`)
    ok(
      'A1.2b 430×932：.app-frame 贴左铺满（x=0 w=430）且文档可滚、无桌面壳',
      phone.frame && phone.x === 0 && phone.w === 430 && phone.docScrollable && !phone.desk,
      JSON.stringify(phone),
    )

    // 宽屏 1512×945：.desk-frame 铺满，滚动在 .desk-main
    await main.send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 945, deviceScaleFactor: 1, mobile: false })
    await main.waitFor(`!!document.querySelector('.desk-frame')`, 6000, '宽屏桌面壳')
    await sleep(600)
    const desk = await main.eval(`(() => {
      const frame = document.querySelector('.desk-frame')
      const fr = frame?.getBoundingClientRect()
      const dm = document.querySelector('.desk-main')
      const se = document.scrollingElement
      return {
        frame: fr ? { w: Math.round(fr.width), h: Math.round(fr.height) } : null,
        deskMain: dm ? { overflowY: getComputedStyle(dm).overflowY, scrollable: dm.scrollHeight > dm.clientHeight + 10 } : null,
        docScrollable: !!se && se.scrollHeight > se.clientHeight + 10,
        appFrame: !!document.querySelector('.app-frame'),
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      }
    })()`)
    ok(
      'A1.2c 1512×945：.desk-frame 铺满、滚动在 .desk-main、文档不滚',
      !!desk.frame &&
        Math.abs(desk.frame.w - 1512) <= 2 &&
        Math.abs(desk.frame.h - 945) <= 2 &&
        desk.deskMain?.overflowY === 'auto' &&
        desk.deskMain.scrollable &&
        !desk.docScrollable &&
        !desk.appFrame,
      JSON.stringify(desk),
    )

    /* ---------- A1.3 直接打开 float.html：等待会话空态、无未捕获异常 ---------- */
    const floatOpened = await openPage(browser.port, 'about:blank', 'mock-float')
    const floatPage = floatOpened.page
    const floatRuntime = watchErrors(floatPage)
    await injectErrorCollector(floatPage)
    await floatPage.send('Page.navigate', { url: `${APP}/float.html` })
    await floatPage.waitFor(`!!document.querySelector('#float-app .float-app')`, 30000, 'float.html 挂载')
    await sleep(700)
    const floatEmpty = await floatPage.eval(`(() => {
      const app = document.querySelector('#float-app .float-app')
      const shell = app?.querySelector('.float-shell.is-empty')
      return {
        text: app?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        emptyShell: !!shell,
        hint: app?.querySelector('.fe-hint')?.textContent.trim() ?? '',
        titlebar: app?.querySelectorAll('.titlebar').length ?? 0,
        errs: window.__errs ?? [],
      }
    })()`)
    ok(
      'A1.3a float.html 直接打开渲染「等待会话」空态（浏览器预览如实说明）',
      floatEmpty.emptyShell && floatEmpty.text.includes('等待会话') && floatEmpty.hint.includes('浏览器预览'),
      JSON.stringify(floatEmpty).slice(0, 220),
    )
    ok(
      'A1.3b float.html 无未捕获异常',
      floatEmpty.errs.length === 0 && floatRuntime.errors.length === 0 && (await pageErrors(floatPage)).length === 0,
      [...floatEmpty.errs, ...floatRuntime.errors].slice(0, 3).join(' | '),
    )
    floatRuntime.dispose()
    floatPage.close()

    /* ---------- A1.4 既有程序内浮条零变化 ---------- */
    await main.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    await gotoHash(main, '#/focus', `document.querySelector('h1')?.textContent === '专注'`, '专注页')
    // 清掉本地残局，保证从空闲态起跑（与 e2e-focus 同一套键名）
    await main.eval(`(() => {
      localStorage.removeItem('rein.pomodoro.live.v1')
      localStorage.removeItem('rein.pomodoro.round.v1')
      localStorage.removeItem('rein.pomodoro.linkedTodo.v1')
    })()`)
    await main.send('Page.reload')
    await main.waitFor(`document.querySelector('h1')?.textContent === '专注'`, 30000, '刷新后专注页')
    await sleep(1000)
    await dismissUpdate(main)
    await startFocus(main)

    const bar0 = await main.eval(FOCUS_BAR)
    ok(
      'A1.4a 专注浮条在场：相位「专注中」+ mm:ss 读数 + work 状态点',
      !!bar0 && bar0.phase === '专注中' && /^\d{2}:\d{2}$/.test(bar0.time ?? '') && bar0.dot.includes('work'),
      JSON.stringify(bar0),
    )
    ok(
      'A1.4b 按钮集合与改造前一致：暂停 / 结束 / 打开专注页 / 进入沉浸模式',
      !!bar0 &&
        bar0.texts.filter(Boolean).join('|') === '暂停|结束' &&
        bar0.arias.join('|') === '打开专注页|进入沉浸模式' &&
        bar0.infoIsButton,
      JSON.stringify({ texts: bar0?.texts, arias: bar0?.arias, infoIsButton: bar0?.infoIsButton }),
    )

    await main.clickSel('.fdock-root .abtn.main')
    await main.waitFor(`document.querySelector('.fdock-root .info .t')?.textContent.trim() === '已暂停'`, 4000, '浮条暂停')
    const barPaused = await main.eval(FOCUS_BAR)
    ok(
      'A1.4c 浮条暂停：相位「已暂停」、状态点 paused、主按钮「继续」',
      barPaused?.phase === '已暂停' && barPaused.dot.includes('paused') && barPaused.texts[0] === '继续',
      JSON.stringify(barPaused),
    )
    await main.clickSel('.fdock-root .abtn.main')
    await main.waitFor(`document.querySelector('.fdock-root .info .t')?.textContent.trim() === '专注中'`, 4000, '浮条继续')

    // 结束确认（ActionSheet）：标题 + 两条动作 + 取消，文案取自同一份 endSheet
    await main.clickSel('.fdock-root .abtn.end')
    await main.waitFor(`!!document.querySelector('[role="dialog"]')`, 5000, '结束确认面板')
    const sheet = await main.eval(`(() => {
      const dlg = document.querySelector('[role="dialog"]')
      return {
        title: dlg?.querySelector('.title')?.textContent.trim() ?? null,
        opts: [...(dlg?.querySelectorAll('.opt') ?? [])].map((b) => b.textContent.trim()),
      }
    })()`)
    ok(
      'A1.4d 结束确认：标题说明后果 + 结束并保留记录 / 放弃这一轮（不保存）/ 取消',
      !!sheet &&
        sheet.title.includes('现在结束会记录这一轮的专注时长并进入休息') &&
        sheet.opts.join('|') === '结束并保留记录|放弃这一轮（不保存）|取消',
      JSON.stringify(sheet),
    )
    await main.clickText('取消')
    await main.waitFor(`!document.querySelector('[role="dialog"]')`, 4000, '取消结束确认')
    // 真的放弃这一轮：浮条应整体收起
    await main.clickSel('.fdock-root .abtn.end')
    await main.waitFor(`!!document.querySelector('[role="dialog"]')`, 5000, '结束确认面板2')
    await main.clickText('放弃这一轮（不保存）')
    await main.waitFor(`!document.querySelector('.fdock-root')`, 6000, '放弃后浮条收起')
    ok('A1.4e 放弃这一轮后浮条收起（会话结束即无浮条）', true)

    /* 录音条冒烟：无头环境注入伪 getUserMedia + FakeMediaRecorder（与 e2e-record 同法） */
    await main.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const fakeTrack = { stop() {} }
        const fakeMediaDevices = { getUserMedia: async () => ({ getTracks: () => [fakeTrack] }) }
        Object.defineProperty(navigator, 'mediaDevices', { value: fakeMediaDevices, writable: true, configurable: true })
        class FakeMediaRecorder {
          constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm' }
          start() { this.state = 'recording' }
          stop() {
            if (this.state !== 'recording') return
            this.state = 'inactive'
            this.ondataavailable?.({ data: new Blob([new Uint8Array([1])], { type: 'audio/webm' }) })
            setTimeout(() => this.onstop?.(), 20)
          }
        }
        window.MediaRecorder = FakeMediaRecorder
      })()`,
    })
    await main.send('Page.reload')
    await main.waitFor(`!!document.querySelector('.page')`, 30000, '录音冒烟刷新')
    await sleep(1200)
    await dismissUpdate(main)
    await gotoHash(main, '#/record', `!!document.querySelector('[data-testid="record-hero"]')`, '录音页')
    // 录音台的开始键是带 aria-label 的圆钮（没有文字），与 e2e-record 用同一条选择器
    await main.clickSel('[data-testid="rec-toggle"]')
    await main.waitFor(`!!document.querySelector('.rdock-root')`, 8000, '录音浮条出现')
    const rec = await main.eval(`(() => {
      const root = document.querySelector('.rdock-root')
      return {
        text: root?.querySelector('.layer-bar')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        stop: [...(root?.querySelectorAll('button') ?? [])].some((b) => b.textContent.includes('停止')),
      }
    })()`)
    ok('A1.4f 录音条冒烟：出现且显示「录音中」+ 停止按钮', !!rec.text.includes('录音中') && rec.stop, rec.text.slice(0, 80))
    await main.eval(`[...document.querySelectorAll('.rdock-root button')].find((b) => b.textContent.includes('停止'))?.click()`)
    await main.waitFor(`!document.querySelector('.rdock-root')`, 8000, '录音条退场')
    ok('A1.4g 录音条停止后正常退场', true)

    /* 运动条冒烟：塞一条进行中的跑步会话（mock 的 rein.mock.sessions.v1 与 e2e-wbar-drag 同一份） */
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
    await main.eval(`localStorage.setItem('rein.mock.sessions.v1', ${JSON.stringify(JSON.stringify(SESSION))})`)
    await main.send('Page.reload')
    await main.waitFor(`!!document.querySelector('.wdock-root')`, 30000, '运动浮条出现')
    await sleep(600)
    const wbar = await main.eval(`(() => {
      const root = document.querySelector('.wdock-root')
      return {
        text: root?.querySelector('.layer-bar')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        main: root?.querySelector('.abtn.main')?.textContent.trim() ?? null,
      }
    })()`)
    ok(
      'A1.4h 运动条冒烟：出现、显示会话且主按钮为「继续」',
      !!wbar && wbar.main === '继续' && wbar.text.includes('户外跑'),
      JSON.stringify(wbar),
    )
    await main.eval(`localStorage.removeItem('rein.mock.sessions.v1')`)
    await main.send('Page.reload')
    await main.waitFor(`!!document.querySelector('.page')`, 30000, '运动条清理刷新')

    /* ---------- A1.5 控制台无未捕获异常 ---------- */
    const lastErrs = await pageErrors(main)
    ok(
      'A1.5 全流程控制台零未捕获异常 / 零 console.error',
      runtime.errors.length === 0 && lastErrs.length === 0,
      [...runtime.errors, ...lastErrs].slice(0, 3).join(' | '),
    )
    runtime.dispose()
  } finally {
    try {
      main?.close()
    } catch {
      /* ignore */
    }
    try {
      browser.proc.kill()
    } catch {
      /* ignore */
    }
    try {
      rmSync(browser.profile, { recursive: true, force: true })
    } catch {
      /* profile 被浏览器占着时忽略 */
    }
  }
}

/* ==========================================================================
 * 入口
 * ========================================================================== */

async function main() {
  const args = new Set(process.argv.slice(2))
  const wantApp = args.has('--app') || args.has('--all')
  const wantMock = args.has('--mock') || args.has('--all') || !args.has('--app')
  const started = Date.now()
  try {
    if (wantMock) {
      console.log(`\n=== A1 mock（浏览器）：${APP} ===`)
      await stageMock()
    }
    if (wantApp) {
      console.log(`\n=== A2 真机（Tauri + WebView2）===`)
      const ctx = { app: APP, out: OUT, ok, results }
      if (process.env.REIN_APP_FORCE_UIA === '1') {
        console.log('  [模式] UIA + Win32 兜底（本机 WebView2 DevTools 端口不可用）')
        const { runAppStage: runUia } = await import('./lib/float-uia-app.mjs')
        await runUia(ctx)
      } else {
        const { runAppStage: runCdp } = await import('./lib/float-app.mjs')
        try {
          await runCdp(ctx)
        } catch (e) {
          if (process.env.REIN_APP_NO_FALLBACK === '1' || results.length > 0) throw e
          console.log('  [诊断] CDP 真机段不可用：' + e.message)
          console.log('  [诊断] 自动切 UIA + Win32 兜底（REIN_APP_NO_FALLBACK=1 可关闭）')
          const { runAppStage: runUia } = await import('./lib/float-uia-app.mjs')
          await runUia(ctx)
        }
      }
    }
  } catch (e) {
    console.error(`\n剧本中断: ${e.message}`)
    printSummary()
    process.exit(2)
  }
  printSummary()
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(results.some((r) => !r.pass) ? 1 : 0)
}

function printSummary() {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
}

main()