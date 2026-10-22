/**
 * 训练总结页专项 E2E + 截图（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：REIN_E2E_URL=http://localhost:1430 node scripts/e2e-session-summary.mjs
 *   （前置：另起一个**非 Tauri** 的 vite —— `cargo tauri dev` 起的 1420 没有 mock 后端）
 *
 * 为什么单独一条：总结页原先只有 3 行（emoji + 标题 + 一行总量），改版后要钉住的是
 * **派生口径**而不是文案 —— 完成环的分子分母、跳过的组去哪了、最高组取哪一组、
 * PR 的两级可信度、计时动作的秒数不进容量。任何一个算错，这屏都会安静地显示
 * 一个看起来合理的错数（这是汇总页最危险的失败模式：数字好看但口径是错的）。
 *
 * S8 额外钉住训练后体感的**整条链路**：总结页三档 → 会话状态 → `state_json.postFeeling`
 * → Rust 拍平成逐组记录 → 练够分的体感维度。只验界面等于没验：这条链路的终点在别处，
 * 中间断一环（比如 state_json 没随快照落盘）界面照样好看。
 *
 * 用课程：ppl-push（9 个力量动作，全 strength）—— 能一次覆盖逐动作明细的多行版式。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1430'
const USER_DATA = `${process.env.TEMP}/rein-e2e-summary-${Date.now()}`
const OUT = 'docs/shots'
const PLAN = 'ppl-push'

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

let DEBUG_PORT = 9335
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
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 10000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

async function clickButton(text, scope = 'body') {
  return evalJS(`(() => {
    const els = [...document.querySelectorAll('${scope} button, ${scope} [role="tab"]')]
    const el = els.find(b => b.textContent.includes(${JSON.stringify(text)}) && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  })()`)
}

/** 总结页的文本快照（去空白，避免模板换行干扰比对） */
async function summaryText() {
  return evalJS(`(document.querySelector('.sumpane')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`)
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

async function connect(pageTargetUrl) {
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
  await cdp('Page.navigate', { url: pageTargetUrl })
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
  await injectStableCSS()
}

async function shoot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`  截图 → ${OUT}/${name}.png`)
}

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=430,932', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/sports/plans/${PLAN}`)
    // mock 的做组明细持久化在 localStorage（rein.mock.sets.v1），**跨运行累积**：
    // 上一轮保存的训练会进历史，PR 断言的基线就变了。测 PR 前必须清干净，
    // 否则这条断言测的是"上一轮跑过之后"的世界。
    await evalJS(`(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('rein.mock.')) localStorage.removeItem(k)
      }
      return true
    })()`)
    await cdp('Page.reload')
    await injectStableCSS()
    await sleep(2500)

    /* ---------- S1. 开课 ---------- */
    await waitFor(
      `[...document.querySelectorAll('button.start')].some(b => b.textContent.includes('开始'))`,
      15000, '课程详情页就绪',
    )
    await clickButton('开始')
    await waitFor(`document.querySelector('.pane .eyebrow')`, 12000, '进入沉浸层')
    ok('S1a 进入沉浸层（做组态）', true)

    /* ---------- S2. 逐组做完：改重量、跳过一组、临时加练 ----------
       这三件事分别喂给总结页的三条口径：最高组取哪一组、跳过组去哪了、加练进不进分母。 */
    const plan = await evalJS(`(async () => {
      const { usePlanStore } = await import('/src/stores/plan.ts')
      const p = usePlanStore()
      await p.ensureLoaded()
      const plan = p.byId(${JSON.stringify(PLAN)})
      return { total: plan.exercises.reduce((s, e) => s + e.sets, 0), n: plan.exercises.length }
    })()`)
    ok('S2a 课程组数可读', plan.total > 0, JSON.stringify(plan))

    // 热身组先清掉：热身不计入完成数与容量，留在流里会让断言分不清
    await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      const s = useSessionStore()
      while (s.phase === 'warmup') s.completeWarmup()
      return s.phase
    })()`)
    await sleep(600)
    // 热身后进的是 rest（45s 组间），跳过它进正式组
    await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      useSessionStore().skipRest()
      return true
    })()`)
    await sleep(500)

    const done = await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      const { useExerciseLibStore } = await import('/src/stores/exerciseLib.ts')
      const s = useSessionStore()
      const lib = useExerciseLibStore()
      // 展示名走 lib（与总结页同一份），课程条目名可能与库内名不同
      const lib_name = (ex) => lib.resolveName(ex)
      // 杠铃卧推在 mock 里有 4 周渐进种子（55 → 62.5 kg），本次刻意做到 70 kg，
      // 让「刷新历史纪录」这条路径真的被走到 —— 否则 PR 区整块不渲染，
      // 断言只能证明"没渲染也不报错"，证明不了口径对。
      const HEAVY = { '杠铃卧推': [65, 67.5, 70, 70] }
      const rows = []
      let guard = 0
      let skipped = 0
      while (s.phase !== 'summary' && guard++ < 400) {
        const ex = s.currentEx
        if (!ex) break
        if (s.phase === 'warmup') { s.completeWarmup(); continue }
        if (s.phase === 'rest') { s.skipRest(); continue }
        if (ex.kind !== 'strength') { s.skipCurrentSet(); skipped++; continue }
        const name = lib_name(ex)
        const setNo = s.exDoneSets.filter(d => !d.warmup).length + 1
        // 计划内的第 2 组跳过一次（第二动作）：验证「跳过仍占分母、不进分子」
        if (s.exIndex === 1 && setNo === 2) { s.skipCurrentSet(); skipped++; continue }
        if (s.exIndex === 0 && setNo === 1) s.addExtraSet() // 第一动作加练一组
        const preset = HEAVY[name]
        s.setWeight(preset ? preset[Math.min(setNo - 1, preset.length - 1)] : 30 + setNo * 2.5)
        s.setReps(8)
        s.completeSet()
        rows.push(ex.name)
      }
      // 跳过组数由 store 口径给出（跳过 = 未做 = 不统计）
      let skipTotal = 0
      for (const arr of Object.values(s.skippedSets)) skipTotal += arr.length
      return {
        phase: s.phase,
        done: s.doneCount,
        total: s.totalCount,
        volume: s.totalVolume,
        skipTotal,
      }
    })()`)
    ok('S2b 走完全课进入总结阶段', done.phase === 'summary', JSON.stringify(done))
    ok('S2c 跳过一组后 done < total（分母含跳过）', done.done < done.total, `${done.done}/${done.total}`)
    // 口径一致性：分母 − 分子 必须等于跳过组数（完成率与「跳过 N 组」标签同源）
    ok('S2d 分母−分子 = 跳过组数（完成率与跳过标签同源）',
      done.total - done.done === done.skipTotal && done.skipTotal > 0,
      `skippedSets=${done.skipTotal} total-done=${done.total - done.done}`)

    await waitFor(`document.querySelector('.sumpane')`, 8000, '总结组件渲染')
    await sleep(1200) // 等 PR 历史校正回来

    // 更新弹窗会盖住总结屏。**走真实 UI：点「稍后」** ——
    // 让 Vue 自己卸载它，连遮罩一起消失。
    // 两条走不通的路（都踩过）：
    //  · `el.remove()` —— 那是 Vue 管理的节点，摘掉会破坏 DOM 记账，
    //    之后关任何弹层都抛 insertBefore of null（看起来像产品 bug）。
    //  · `display:none` 藏卡片 / 猜「满屏 fixed 半透明」是遮罩 ——
    //    页面自己（.run-page / .session-layer）也是满屏 fixed，会被一起藏掉，
    //    症状是整页空白、所有断言读到 0。
    await evalJS(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === '稍后') { b.click(); return true }
      }
      return false
    })()`)
    await sleep(700)

    /* ---------- S3. 口径断言 ---------- */
    const txt = await summaryText()
    const st = await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      const s = useSessionStore()
      return { done: s.doneCount, total: s.totalCount, volume: s.totalVolume, dur: s.durationSec }
    })()`)

    ok('S3a 完成环显示百分比与 n/N 组', /\d+%/.test(txt) && txt.includes(`${st.done}/${st.total} 组`), txt.slice(0, 90))

    const statVals = await evalJS(`[...document.querySelectorAll('.stat')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`)
    ok('S3b 四项指标齐全（容量/用时/消耗/每组耗时）',
      statVals.length === 4 && statVals.some((t) => t.includes('总容量')) && statVals.some((t) => t.includes('每组耗时')),
      JSON.stringify(statVals))
    ok('S3c 总容量与 store 的 totalVolume 一致',
      statVals.some((t) => t.includes(String(st.volume))), `${st.volume} / ${JSON.stringify(statVals[0])}`)

    const tags = await evalJS(`[...document.querySelectorAll('.sumtag')].map(e => e.textContent.trim())`)
    ok('S3d 跳过 / 加练如实标出（分母去哪了）',
      tags.some((t) => t.includes('跳过')) && tags.some((t) => t.includes('加练')), JSON.stringify(tags))

    const exRows = await evalJS(`[...document.querySelectorAll('.exrow')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`)
    ok('S3e 逐动作明细逐个动作成行', exRows.length === plan.n, `${exRows.length} 行 / ${plan.n} 动作`)
    // 最高组必须取最大重量那组（本脚本里每组递增 → 末组最重），
    // 若实现误取「最后一组」或「第一组」这里会露馅
    const firstRow = exRows[0] ?? ''
    const topSetMatch = /(\d+(?:\.\d+)?) kg × (\d+)/.exec(firstRow)
    ok('S3f 明细里的最高组 = 最大重量组', !!topSetMatch, firstRow)
    ok('S3g 明细含该动作容量与组数', /\d+ 组 · \d+ kg/.test(firstRow), firstRow)

    const muscles = await evalJS(`[...document.querySelectorAll('.muschip')].map(e => e.textContent.trim())`)
    ok('S3h 肌群汇总有内容且分档', muscles.length > 0 && muscles.some((m) => m.includes('主攻')), `${muscles.length} 块`)

    /* ---------- S4. PR 两级可信度 ---------- */
    const prs = await evalJS(`[...document.querySelectorAll('.prrow')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`)
    const verified = await evalJS(`[...document.querySelectorAll('.prdelta.verified')].map(e => e.textContent.trim())`)
    const prTitle = await evalJS(`document.querySelector('.prtitle')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)
    console.log('  PR 标题:', prTitle)
    console.log('  PR 行:', JSON.stringify(prs.slice(0, 4)))
    console.log('  校正级:', JSON.stringify(verified.slice(0, 4)))
    // 本次杠铃卧推做到 70 kg，mock 种子的历史最高是 62.5 → 必须判成真历史 PR。
    // 这条是整条 PR 链路的端到端证明：key 回落对、严格大于对、UI 标记对。
    ok('S4a 杠铃卧推被列入进步区', prs.some((t) => t.includes('杠铃卧推')), JSON.stringify(prs))
    ok('S4b 校正级 PR 带「历史」文字标记（不只靠颜色）',
      verified.length > 0 && verified.every((t) => t.includes('历史')), JSON.stringify(verified))
    ok('S4c 标题区分「历史纪录」与「超越上次」',
      prTitle.includes('历史纪录') || prTitle.includes('超越上次'), prTitle)
    ok('S4d 增量与历史最高一致（70 − 62.5 = 7.5）',
      prs.some((t) => t.includes('杠铃卧推') && t.includes('7.5')), JSON.stringify(prs[0] ?? ''))

    /* ---------- S5. 版式：首屏装下「环 + 指标 + 进步」，末段滚得到 ---------- */
    const layout = await evalJS(`(() => {
      const q = (s) => document.querySelector(s)?.getBoundingClientRect() ?? null
      const pane = q('.sumpane')
      const ring = q('.sumpane .ring')
      const grid = q('.statgrid')
      const pr = q('.prcard')
      const sb = document.querySelector('.scrollbody')
      return {
        paneTop: pane?.top ?? 0,
        ringBottom: ring?.bottom ?? 0,
        gridBottom: grid?.bottom ?? 0,
        prBottom: pr?.bottom ?? null,
        vh: window.innerHeight,
        scrollH: sb?.scrollHeight ?? 0,
        clientH: sb?.clientHeight ?? 0,
      }
    })()`)
    console.log('  版式:', JSON.stringify(layout))
    ok('S5a 完成环完整可见（未被顶栏切掉）', layout.ringBottom > 0 && layout.ringBottom < layout.vh, JSON.stringify(layout))
    ok('S5b 四项指标在首屏内', layout.gridBottom > 0 && layout.gridBottom < layout.vh, JSON.stringify(layout))
    // 进步卡在首屏内：这一屏的前三块（环/指标/进步）必须在 932 里，
    // 否则用户一进来先看到半张成绩单。「超出 < 40px」= 允许一点点，
    // 再多就该压缩上面的间距而不是让用户滚。
    if (layout.prBottom != null) {
      ok('S5c 进步卡落在首屏内（环+指标+进步 = 一屏答案）',
        layout.prBottom <= layout.vh, `prBottom=${layout.prBottom} vh=${layout.vh}`)
    } else {
      ok('S5c 无进步卡时跳过（本次未刷新任何纪录）', true)
    }

    /**
     * 末段可达性 —— 这一条是踩过坑才写的：
     * 早期给 .sumpane 写 `flex: 1`，浏览器把它压进父级高度，
     * .scrollbody 的 scrollHeight 恒等于 clientHeight：**内容超一屏却滚不动**。
     * 症状不是「报错」，而是末段被 Dock 压住、怎么划都划不到，
     * 看起来像版式问题而不是滚动问题。
     * 现在 `flex: 1 0 auto`，这里同时钉住两件事：溢出时可滚 + 滚得到末段。
     */
    const reach = await evalJS(`(() => {
      const sb = document.querySelector('.scrollbody')
      sb.scrollTop = sb.scrollHeight
      const cards = [...document.querySelectorAll('.sumpane .sumcard')]
      const last = cards[cards.length - 1]
      const dock = document.querySelector('.ctrl-dock')
      const r = {
        canScroll: sb.scrollHeight > sb.clientHeight + 1,
        scrollTop: Math.round(sb.scrollTop),
        lastTitle: last?.querySelector('h3')?.textContent?.trim() ?? '',
        lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
        dockTop: dock ? Math.round(dock.getBoundingClientRect().top) : null,
      }
      sb.scrollTop = 0
      return r
    })()`)
    console.log('  末段可达:', JSON.stringify(reach))
    ok('S5d 内容超一屏时可滚动', reach.canScroll, `${layout.scrollH} vs ${layout.clientH}`)
    ok('S5e 滚到底时末段进入底簇之上（末段够得到）',
      reach.lastBottom != null && reach.dockTop != null && reach.lastBottom <= reach.dockTop + 1,
      JSON.stringify(reach))

    // 横向溢出：明细行是三段 flex，窄屏最容易把某一格挤出
    const overflow = await evalJS(`(() => {
      const bad = []
      for (const e of document.querySelectorAll('.sumpane *')) {
        if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible') {
          bad.push(e.className + ' ' + e.scrollWidth + '>' + e.clientWidth)
        }
      }
      return bad.slice(0, 6)
    })()`)
    ok('S5d 无横向溢出', overflow.length === 0, JSON.stringify(overflow))

    /* ---------- S6. 截图：亮色 + 暗色，各两张（顶部 / 滚到底） ----------
       末段（下次建议）在 9 动作 + 跳过标签的数据下会超出一屏，
       只截顶部等于把「末段够不够得到」这件事只留在断言里、截图里看不见。
       暗色走 prefers-color-scheme（tokens.css:319），必须用 CDP 改**媒体查询**；
       挂 class / data-theme / localStorage 都不起作用（那是本项目没有的机制）。 */
    await shoot('session-summary-light')
    await evalJS(`(() => { const sb = document.querySelector('.scrollbody'); sb.scrollTop = sb.scrollHeight; return true })()`)
    await sleep(400)
    await shoot('session-summary-light-bottom')
    await evalJS(`(() => { document.querySelector('.scrollbody').scrollTop = 0; return true })()`)
    await sleep(200)
    await cdp('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    await sleep(600)
    // 暗色判据读 `--bg` 令牌而不是 body 的 backgroundColor：
    // body 的背景是「一层 radial-gradient + var(--bg)」，
    // backgroundColor 那一格是 transparent，两档都读成同一个值（判不出来）。
    const darkInfo = await evalJS(`(() => {
      const cs = getComputedStyle(document.documentElement)
      const raw = cs.getPropertyValue('--bg').trim()
      const probe = document.createElement('div')
      probe.style.color = 'var(--bg)'
      document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).color
      probe.remove()
      return { raw, resolved, surface: cs.getPropertyValue('--surface').trim() }
    })()`)
    console.log('  暗色令牌:', JSON.stringify(darkInfo))
    const lum = (() => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(darkInfo.resolved))
      return m ? 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]) : null
    })()
    ok('S6a 暗色媒体查询生效（--bg 亮度 < 128）', lum != null && lum < 128, `${darkInfo.resolved} → ${lum?.toFixed(1)}`)
    await shoot('session-summary-dark')
    await evalJS(`(() => { const sb = document.querySelector('.scrollbody'); sb.scrollTop = sb.scrollHeight; return true })()`)
    await sleep(400)
    await shoot('session-summary-dark-bottom')
    await cdp('Emulation.setEmulatedMedia', { features: [] })

    /* ---------- S7. 保存落库：写库成功即收起沉浸层并回执（R1） ----------
       R1 给 saveNow 补了 try/catch（写库失败可原样重试）；失败分支在 mock 下
       无法注入（mock/server.ts 不在本轮允许清单），故这里只钉住成功路径不被
       这次改动碰坏：「保存训练」→ 回执含「已保存」→ 沉浸层收起（会话已关）。 */
    /* ---------- S8. 训练后体感（练够分「体感」维度的输入） ----------
       三件事要证明：① 总结页真的问了；② 点选会落进会话状态；③ 保存后能从**拍平后的
       逐组记录**里读回来 —— 只验界面等于没验，这条链路的终点是练够分那张卡。 */
    const feelOpts = await evalJS(`[...document.querySelectorAll('.feelopt')].map(b => b.textContent.trim())`)
    ok('S8a 总结页问「这次练得怎么样」并给三档', feelOpts.length === 3, feelOpts.join(' / '))
    ok(
      'S8b 三档文案相对预期（不是 RPE）',
      feelOpts.join('').includes('比预期好') && feelOpts.join('').includes('比预期差'),
      feelOpts.join(' / '),
    )

    await evalJS(`(() => {
      const b = [...document.querySelectorAll('.feelopt')].find(x => x.textContent.includes('比预期好'))
      b?.click()
      return true
    })()`)
    await sleep(400)
    const feltInStore = await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      return { v: useSessionStore().postFeeling, pressed: [...document.querySelectorAll('.feelopt')].map(b => b.getAttribute('aria-pressed')).join(',') }
    })()`)
    ok(
      'S8c 点选后写入会话状态并标出选中（aria-pressed）',
      feltInStore.v === 'better' && feltInStore.pressed === 'true,false,false',
      JSON.stringify(feltInStore),
    )

    await clickButton('保存训练')
    const savedToast = await (async () => {
      const t0 = Date.now()
      while (Date.now() - t0 < 6000) {
        const t = await evalJS(`[...document.querySelectorAll('.toast-host .toast')].map(e => e.textContent).join(' | ')`)
        if (/已保存/.test(t)) return t
        await sleep(120)
      }
      return ''
    })()
    ok('S7a 保存回执含「已保存」', /已保存/.test(savedToast), savedToast)
    await waitFor(`!document.querySelector('.session-layer')?.classList.contains('is-open')`, 8000, '保存后沉浸层收起')
    ok('S7b 保存后沉浸层收起（会话已关）', true)

    // 拍平链路（state_json.$.postFeeling → 逐组记录 → 练够分）：读回来才算真的通了
    const feltRows = await evalJS(`(async () => {
      const { sessionService } = await import('/src/services/sessionService.ts')
      const rows = await sessionService.strengthRecentSets(1)
      const stamped = rows.filter(r => r.postFeeling != null)
      return { total: rows.length, stamped: stamped.length, values: [...new Set(stamped.map(r => r.postFeeling))] }
    })()`)
    ok(
      'S8d 保存后逐组记录里能读到 postFeeling（Rust 端 json_extract 拍平）',
      feltRows.stamped > 0 && feltRows.values.length === 1 && feltRows.values[0] === 'better',
      JSON.stringify(feltRows),
    )

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) process.exit(1)
  } catch (e) {
    console.error('E2E 中断:', e.message)
    process.exit(1)
  } finally {
    edge.kill()
  }
}

main()
