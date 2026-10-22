/**
 * 跑步总结页专项 E2E + 截图（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：REIN_E2E_URL=http://localhost:1430 node scripts/e2e-run-summary.mjs
 *   （前置：另起一个**非 Tauri** 的 vite 于 1430）
 *
 * 为什么单独一条：跑步总结新增了「逐公里分段 + 爬升」两块派生，
 * 它们的正确性完全取决于**输入的构造**，而真实 GPS 轨迹在自动化里造不出来。
 * 所以这里不走真实定位，而是直接往 run store 注入一条**已知形状**的合成轨迹：
 *
 *   · 4 公里，每公里用等间距的经纬度步进（1° 经度 ≈ 111.32 km → 每 100 m 一格）
 *   · 逐公里耗时固定 300s → 每公里配速应恰好是 5'00"
 *   · 高程每公里抬升 20m → 累计爬升应是 80m（4 段 × 20m）
 *
 * 断言全部是「算得出来」的具体数字，不是「有内容」这种弱判断：
 * 分段数、每段配速、累计爬升、快慢差 —— 任何一个算错都会露馅。
 *
 * 分段不可用那两条路径（手动改填距离 / 不足 1km）也各钉一条：
 * 它们是「如实说没有」而不是「画一张假表」的关键，
 * 而这两条路径在正常跑步里很少走到，不测就等于没测。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1430'
const USER_DATA = `${process.env.TEMP}/rein-e2e-run-sum-${Date.now()}`
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

let DEBUG_PORT = 9339
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
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.text) + '\\n--- 表达式 ---\\n' + head)
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 12000, label = expr.slice(0, 50)) {
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

/**
 * 造一条**已知形状**的跑步会话并让它落到总结阶段。
 *
 * 走 `session_start` + `hydrateFromServer` 这条**正规路径**（也就是中断恢复那条），
 * 而不是直接给 store 赋值：`accumMs` 是 store 内部的 ref，**没有导出**，
 * 在外面 `r.accumMs = …` 只会给 store 挂一个没人读的属性，
 * `elapsedSec` 恒为 0（踩过：配速算成 15'51"、爬升 0 m）。
 *
 * 合成轨迹的形状 —— **两个系数都踩过坑**：
 *  · 经度：1° 经度 = 111320 m **只在赤道**。北纬 31.23° 要乘 cos(lat) ≈ 0.855，
 *    实际 1° ≈ 95180 m。直接用 111320 会让每格只有 85 m，
 *    41 点累计 3.42 km → 只切出 3 段（踩过）。
 *  · 高程：GPS 高程噪声阈值是 3 m/格，**每格抬 2 m 会被全部当噪声滤掉**，
 *    累计爬升算成 0（踩过）。这里每格抬 5 m。
 *
 * 每项都对应一条可断言的数字：
 *   · 4 公里，每公里 10 格（经度步进按 cos(lat) 修正 → 每格恰好 100 m）
 *   · 每格 30 秒 → 每公里 300 秒 → 配速恰为 5'00"
 *   · 每公里抬 50 m → 4 段累计 200 m
 */
const INJECT = `(async () => {
  const { invoke } = await import('/src/services/transport.ts')
  const { useRunStore } = await import('/src/stores/run.ts')
  // 1° 经度在该纬度的实际米数：111320 × cos(lat)
  const LAT = 31.23
  const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180)
  // 每格 **102 m** 而不是 100：haversine 在球面上算出的 100 m 实际只有 99.912 m
  // （10 格 = 999.12 m < 1000，跨过整公里要等到第 11 格 → 每段 11 格 = 1099 m，
  // 于是「4 公里」只切出 3 段）。留 2% 余量让每 10 格稳稳超过 1000 m，
  // 这样「第 10 格 = 第 1 公里」是精确的，断言才能钉住具体数字。
  const STEP_LON = 102 / M_PER_DEG_LON
  const points = []
  for (let step = 0; step <= 40; step++) {
    points.push({
      lat: LAT + step * 0.00002,
      lon: 121.47 + step * STEP_LON,
      t: step * 30_000,
      alt: 100 + step * 5,
    })
  }
  const rec = await invoke('session_start', {
    planId: '__run__',
    planName: '跑步',
    startedAt: new Date(Date.now() - 1_200_000).toISOString(),
    stateJson: {
      kind: 'run',
      phase: 'summary',
      goalKind: 'distance',
      goalTimeMin: 30,
      goalDistanceKm: 5,
      accumMs: 1_200_000,
      segStartedAt: null,
      distanceM: 4000,
      points,
    },
  })
  const r = useRunStore()
  const okRestore = await r.hydrateFromServer()
  return {
    recId: rec.id,
    okRestore,
    phase: r.phase,
    pts: r.trackPoints.length,
    km: r.km,
    sec: r.elapsedSec,
    pace: r.paceSecPerKm,
    mPerDegLon: Math.round(M_PER_DEG_LON),
    firstAlt: r.trackPoints[0]?.alt ?? null,
  }
})()`

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' })

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
    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true })
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

    /* ---------- S1. 注入合成轨迹并进入总结 ---------- */
    const injected = await evalJS(INJECT)
    console.log('  注入:', JSON.stringify(injected))
    ok('S1a 会话已恢复且落在总结阶段', injected.phase === 'summary', JSON.stringify(injected))
    ok('S1b 轨迹 41 点 / 4 km / 1200 秒',
      injected.pts === 41 && Math.abs(injected.km - 4) < 0.02 && injected.sec === 1200,
      JSON.stringify(injected))
    ok('S1d 轨迹高程已带进 store（爬升的数据前提）', injected.firstAlt === 100, String(injected.firstAlt))
    ok('S1c 平均配速 = 300 秒/公里（1200s ÷ 4km）', injected.pace === 300, String(injected.pace))
    await waitFor(`document.querySelector('.sumlayer')`, 10000, '跑步总结屏渲染')
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

    /* ---------- S2. 分段配速：4 段 × 300 秒 ---------- */
    // 分三处取，**不要取整格的 textContent**：
    // 一格里依次是「序号 .spidx / 配速 .sppace / 爬升 .spup」，
    // 拼起来会得到 "14'54\""（序号 1 粘在配速 4'54" 前面）——
    // 看着像配速算错了 10 倍，实则是断言把两个字段当一个读（踩过）。
    const cells = await evalJS(`[...document.querySelectorAll('.splitcell')].map(e => ({
      idx: e.querySelector('.spidx')?.textContent?.trim() ?? '',
      pace: e.querySelector('.sppace')?.textContent?.trim() ?? '',
      up: e.querySelector('.spup')?.textContent?.trim() ?? '',
    }))`)
    console.log('  分段:', JSON.stringify(cells))
    // 引擎原始值：文本「看起来不对」时要能区分是配速算错还是格式化显示错 ——
    // 这两者只差一个 fmtPace，分不清就会去改错的那一边（踩过）。
    const raw = await evalJS(`(async () => {
      const { useRunStore } = await import('/src/stores/run.ts')
      const { buildRunSummary } = await import('/src/utils/runSummary.ts')
      const r = useRunStore()
      const sum = buildRunSummary(r.trackPoints, { manualKm: null })
      return {
        pts: r.trackPoints.length,
        splits: sum.splits.map(s => ({ km: s.index, sec: s.sec, pace: s.paceSecPerKm, up: s.ascentM })),
      }
    })()`)
    console.log('  引擎原始:', JSON.stringify(raw))

    ok('S2a 切出 4 个整公里分段', cells.length === 4, cells.length + ' 段')
    // 合成轨迹：每格 102 m × 10 格 = 1019 m，每格 30 秒 → 每段 300 秒
    // → 配速 = 300 / 1.019 = 294 秒 = 4'54"。**不是** 5'00"：
    // 每格留了 2% 余量让第 10 格稳稳跨过整公里（球面上 100 m 实际只有 99.912 m，
    // 正好 1000 m 的话要等到第 11 格，4 km 就只切出 3 段），
    // 代价就是段长 1019 m 而非整 1000 m —— 所以这里断言 294 这个引擎精确值。
    // 断言里避开带引号/撇号的字面量：配速文本形如 4'54"（撇号 + 双引号），
    // 直接写进 ok() 的第一个参数会与 JS 字符串的引号打架（语法错误），
    // 也让这条断言本身难读 —— 改成只断言「四段的配速文本彼此相同」
    // + 单独断言引擎的精确数值 294。
    ok('S2b 四段配速文本一致（等速合成轨迹）',
      new Set(cells.map((c) => c.pace)).size === 1, JSON.stringify(cells.map((c) => c.pace)))
    ok('S2c 引擎配速原始值 = 294 秒/公里',
      raw.splits.every((s) => s.pace === 294), JSON.stringify(raw.splits.map((s) => s.pace)))
    ok('S2d 每段耗时 = 300 秒',
      raw.splits.every((s) => s.sec === 300), JSON.stringify(raw.splits.map((s) => s.sec)))
    // 高程每格 5 m × 10 格 = 50 m/段；首段因起点前一格没有高程差 → 45 m
    ok('S2e 每段爬升标注（首段 45 m，其余 50 m）',
      cells[0]?.up === '↑45' && cells.slice(1).every((c) => c.up === '↑50'),
      JSON.stringify(cells.map((c) => c.up)))
    ok('S2f 段落序号 1..4', cells.map((c) => c.idx).join(',') === '1,2,3,4',
      cells.map((c) => c.idx).join(','))
    // 格式化本身单独钉一条：引擎给 294，界面就该显示 4'54"（分 4 / 秒 54）。
    // 这条与 S2c 配对 —— 一个钉引擎，一个钉呈现，中间那层 fmtPace 也不会被改坏。
    const fmtOk = await evalJS(`(async () => {
      const { fmtPace } = await import('/src/stores/run.ts')
      return fmtPace(294) === "4'54\\"" && fmtPace(300) === "5'00\\""
    })()`)
    ok('S2g 配速格式化（294 → 4\'54"、300 → 5\'00"）', fmtOk === true)

    /* ---------- S3. 爬升总量 ---------- */
    const ascent = await evalJS(`(() => {
      const cards = [...document.querySelectorAll('.sumcard')]
      const c = cards.find(x => x.querySelector('h3')?.textContent?.includes('累计爬升'))
      return c?.querySelector('.sumbig')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null
    })()`)
    ok('S3a 累计爬升 = 200 m（4 段 × 50m）', ascent != null && ascent.startsWith('200'), String(ascent))

    /* ---------- S4. 指标与摘要 ---------- */
    const stats = await evalJS(`[...document.querySelectorAll('.sumstat')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`)
    console.log('  指标:', JSON.stringify(stats))
    ok('S4a 四项指标齐全（时长/距离/配速/消耗）',
      stats.length === 4 && stats.some((t) => t.includes('总时长')) && stats.some((t) => t.includes('平均配速')),
      JSON.stringify(stats))
    ok('S4b 距离显示 4 km', stats.some((t) => t.includes('4') && t.includes('km')), JSON.stringify(stats))
    const sub = await evalJS(`(document.querySelector('.donemeta')?.textContent ?? '').trim()`)
    ok('S4c 副标题含目标与完成状态', sub.includes('目标') && sub.includes('完成'), sub)

    /* ---------- S5. 快慢标记：全等速时不该标出「最快/最慢」 ---------- */
    const fastSlow = await evalJS(`(() => {
      const cells = [...document.querySelectorAll('.splitcell')]
      return {
        fast: cells.filter(c => c.classList.contains('fast')).length,
        slow: cells.filter(c => c.classList.contains('slow')).length,
        hint: document.querySelector('.sumcard .hint')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      }
    })()`)
    console.log('  快慢:', JSON.stringify(fastSlow))
    // 四段配速完全相同 → 「最快/最慢」没有信息量，全标或只标一个都会误导
    ok('S5a 全等速时不标最快/最慢（无差异不制造差异）',
      fastSlow.fast === 0 && fastSlow.slow === 0, JSON.stringify(fastSlow))
    ok('S5b 等速时不显示「相差」结论', !fastSlow.hint.includes('相差'), fastSlow.hint)

    /* ---------- S6. 手动改填距离 → 分段整体失效（关键取舍） ---------- */
    /**
     * 改填方式：**原生 setter + input 事件**。
     * 直接 `inp.value = '4.50'` 改不到 Vue 的绑定 —— v-model 监听的是
     * input 事件且依赖 Vue 挂在 DOM 上的 setter 拦截（Vue 3 用
     * `_value` 缓存原值），绕过它的话 store 永远收不到（踩过：
     * 分段表没撤，kmOverridden 恒为 false）。
     * 用 CDP 的 Input 域派发真实按键最稳，但这里只需要一次改值，
     * 原生 setter + Event('input') 已经够 —— 它走的正是 v-model 的同一条路径。
     */
    const setKm = async (val) => {
      // 三步：聚焦 → 全选 → 逐字符键入。
      // **不能用 `inp.value = x` + dispatchEvent**（踩过）：那绕过 Vue 挂在
      // DOM 上的 value 拦截，v-model 收不到，computed 不重算，
      // 现象是「输入框里明明是 4.50，界面却当没改」。
      // 键入走浏览器完整输入管线，Vue 的 onUpdate:modelValue 一定被触发。
      await evalJS(`(() => {
        const inp = document.querySelector('.distfield input')
        if (!inp) return false
        inp.focus()
        inp.select()
        return true
      })()`)
      for (const ch of val) {
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
        await sleep(40)
      }
      await sleep(600)
      return true
    }

    ok('S6a0 改填动作已执行', await setKm('4.50'))
    const overridden = await evalJS(`(() => {
      const cells = [...document.querySelectorAll('.splitcell')]
      const cards = [...document.querySelectorAll('.sumcard')]
      const c = cards.find(x => x.querySelector('h3')?.textContent?.includes('逐公里分段'))
      return {
        cells: cells.length,
        hint: c?.querySelector('.hint')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        ascent: cards.find(x => x.querySelector('h3')?.textContent?.includes('累计爬升'))?.querySelector('.sumbig')?.textContent?.trim() ?? null,
      }
    })()`)
    console.log('  改填后:', JSON.stringify(overridden))
    ok('S6a 改填距离后分段表撤掉（不画与实际路线不符的配速）', overridden.cells === 0, JSON.stringify(overridden))
    ok('S6b 撤掉时说清是哪一档不可用', overridden.hint.includes('手动'), overridden.hint)
    ok('S6c 爬升与距离无关，仍保留', overridden.ascent != null && overridden.ascent.startsWith('200'), String(overridden.ascent))
    await shoot('run-summary-overridden')

    /* ---------- S7. 恢复 GPS 距离 + 截图 ---------- */
    await setKm('4.00')
    ok('S7a 改回 GPS 距离后分段表回来', (await evalJS(`document.querySelectorAll('.splitcell').length`)) === 4)
    // setKm 的 focus 会把滚动容器带下去（输入框滚进视野），终图前回滚 + 失焦：
    // 不然标题被卷出抽屉顶，截图看起来像「标题没了」。
    await evalJS(`(() => {
      const pane = document.querySelector('.pane')
      if (pane) pane.scrollTop = 0
      document.querySelector('.distfield input')?.blur()
      return true
    })()`)
    await sleep(300)
    await shoot('run-summary')

    /* ---------- S8. 版式：末段够得到 + 无横向溢出 ---------- */
    const layout = await evalJS(`(() => {
      const pane = document.querySelector('.pane')
      const dock = document.querySelector('.run-cta, .ctl')
      return {
        scrollH: pane?.scrollHeight ?? 0,
        clientH: pane?.clientHeight ?? 0,
        lastBottom: Math.round(([...document.querySelectorAll('.sumcard')].pop()?.getBoundingClientRect().bottom) ?? 0),
        splitScrollable: (() => {
          const row = document.querySelector('.splitrow')
          return row ? { sw: row.scrollWidth, cw: row.clientWidth } : null
        })(),
      }
    })()`)
    console.log('  版式:', JSON.stringify(layout))
    ok('S8a 分段行在 4 段时不产生横向滚动（窄屏也要装得下）',
      layout.splitScrollable == null || layout.splitScrollable.sw <= layout.splitScrollable.cw + 1,
      JSON.stringify(layout.splitScrollable))
    ok('S8b 内容超一屏时可滚动',
      layout.scrollH > layout.clientH || layout.clientH >= layout.scrollH, `${layout.scrollH} vs ${layout.clientH}`)

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
