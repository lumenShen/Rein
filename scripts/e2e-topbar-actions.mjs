/**
 * e2e-topbar-actions —— 桌面顶栏「功能按钮」区端到端（Edge headless + playwright-core）
 *
 * 为什么要 e2e：顶栏按钮是「注册表 + 用户布局」落进**标题栏**的那条链路 —— 按钮由插件
 * 声明（focus/record/voice 的 PluginSpec.topbar）、宿主 TopbarActions 分派动作、用户可
 * 编辑（±/拖拽/候选下拉/放弃/保存），且与浮窗标题栏（FloatTitleBar）共用 TitleBarBase
 * 外壳。这些跨组件、跨窗口的联动只有真渲染一遍才验证得了；哪天有人把按钮塞进
 * TitleBarBase 本体，浮窗泄漏的断言会立刻红。
 *
 * 剧本：
 *   1. Tauri 桌面（≥900）：三颗种子按钮按声明序渲染（专注/录音/语音），窗控三钮完好
 *   1b. 窄 Tauri 窗（430）：标题栏还在，但按钮区根本不渲染（isDesktop 门，不与窗控挤宽度）
 *   1c. 浏览器桌面（无 Tauri 桩）：AppTitleBar 整个不渲染 —— 顶栏按钮是 Tauri 桌面专属
 *   2. 编辑态：进入后全部按钮带「−」徽标；候选为空时下拉不开；「−」撤回后候选下拉出现
 *      （＋ 语音），加回后行恢复；Esc 不退出编辑态（退出只有放弃/保存两条路）
 *   3. 拖拽换位 + 保存布局：草稿序落盘 rein.navLayout.v1，刷新后仍在
 *   4. 放弃变更：撤回一条后放弃 → 行与存储都不动
 *   5. 预置布局含失效 id：解析时静默丢弃、存储原样（不动存储）
 *   6. 关掉专注模块：按钮从渲染清单消失（不是置灰）
 *   7. 动作分派：专注（起跑→浮条「暂停」→再点→「继续」）、录音（起录→录音浮条→停止→收起）、
 *      语音（未配置 → 引导 toast + 跳模型页）
 *   8. 浮窗不泄漏：float.html 的 FloatTitleBar 任何形态都没有 .tb-actions / [data-nav-id]
 *
 * 运行：node scripts/e2e-topbar-actions.mjs   （先 `npm run dev`，或设 REIN_E2E_URL）
 * 退出码非 0 表示有断言失败。
 *
 * 修订（2026-11-07）：候选行的「＋」从文案前缀（`＋ 语音`）改为 AppMenu MenuItem.badge
 * 徽标位（data-nav-badge="+"，§6.1/§8.3 断言靶，与 Dock 托盘 / rail 菜单同一枚圆）——
 * 候选文案断言从「＋ 语音」改读纯标签 + 徽标计数。
 */
import { chromium } from 'playwright-core'

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const EDGE = process.env.REIN_EDGE
const DESK = { width: 1512, height: 945 }
const PHONE = { width: 430, height: 932 }
const NAV_KEY = 'rein.navLayout.v1'
const FEATURES_KEY = 'rein.features.v1'

const failures = []
function check(name, ok, detail) {
  if (ok) {
    console.log('  OK  ' + name)
  } else {
    console.log('  XX  ' + name + (detail ? ' —— ' + detail : ''))
    failures.push(name)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 主窗口的 Tauri IPC 桩：让浏览器里的 App 相信自己在桌面 Tauri 里（AppTitleBar 才会渲染），
 * 但 IPC 全部转发给应用自带的 mock 后端 —— `import('/src/mock/server.ts')` 与应用在浏览器
 * 模式下的动态导入是**同一个 URL**，Vite 只装一份模块，所以行为与纯浏览器 e2e 逐条一致，
 * 唯一的差别就是标题栏这一层壳。插件命令（window/event）就地作答：浏览器里没有窗口系统，
 * is_maximized 报 false、事件注册返回句柄、emit 吞掉。
 *
 * 注入时机必须是页面脚本之前：isTauri 在模块装载时判定（transport.ts:4）。
 */
const TAURI_MAIN_STUB = `(() => {
  const callbacks = new Map()
  let seq = 0
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(cb) {
      const id = ++seq
      callbacks.set(id, cb)
      return id
    },
    invoke(cmd, args) {
      if (cmd === 'plugin:event|listen') return Promise.resolve(++seq)
      if (cmd === 'plugin:event|unlisten' || cmd === 'plugin:event|emit') return Promise.resolve(null)
      if (cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:webview|')) {
        const query = /is_(maximized|maximizable|visible|fullscreen|focused)$/.test(cmd)
        return Promise.resolve(query ? false : null)
      }
      return import('/src/mock/server.ts').then((m) => m.mockInvoke(cmd, args))
    },
  }
})()`

/** 预置 localStorage 后再进应用（store 启动即读，进页再写无效 —— 与 presetFeatureFlags 同一条时机纪律） */
async function newPage(browser, { viewport = DESK, tauri = true, storage = [] } = {}) {
  const ctx = await browser.newContext({
    viewport,
    colorScheme: 'light',
    // 录音动作分派要过 getUserMedia：假设备 + 自动授权，headless 下也确定性成功
    permissions: ['microphone'],
  })
  if (tauri) await ctx.addInitScript(TAURI_MAIN_STUB)
  for (const [k, v] of storage) {
    await ctx.addInitScript(
      ([key, val]) => localStorage.setItem(key, JSON.stringify(val)),
      [k, v],
    )
  }
  const page = await ctx.newPage()
  return { ctx, page }
}

/** 更新卡片会盖住整页，先点掉（与其余剧本同一套处理） */
async function dismissUpdate(page) {
  try {
    const later = page.getByRole('button', { name: '稍后' })
    if (await later.count()) await later.first().click({ timeout: 800 })
  } catch {
    /* 没有更新卡片就直接过 */
  }
}

async function goto(page, hash) {
  await page.goto(APP + '/' + hash, { waitUntil: 'load' })
  await sleep(900)
  await dismissUpdate(page)
  await sleep(200)
}

/** 按钮行里的 data-nav-id 序列（渲染清单的直接投影） */
async function rowOrder(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.tb-actions [data-nav-id]')].map((el) => el.dataset.navId),
  )
}

const browser = await chromium.launch({
  channel: EDGE ? undefined : 'msedge',
  executablePath: EDGE || undefined,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

try {
  /* ================= 1. Tauri 桌面：注册 + 缺省渲染 ================= */
  {
    const { ctx, page } = await newPage(browser)
    console.log('1. Tauri 桌面（1512×945）：种子按钮与窗控')
    await goto(page, '#/')
    await page.waitForSelector('.tb-actions')

    const seed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.tb-actions [data-nav-id]')]
      const win = (label) =>
        [...document.querySelectorAll('.titlebar button')].some((b) => b.getAttribute('aria-label') === label)
      return {
        ids: btns.map((b) => b.dataset.navId),
        labels: btns.map((b) => b.getAttribute('aria-label')),
        realButtons: btns.every((b) => b.tagName === 'BUTTON'),
        editEntry: !!document.querySelector('.titlebar [aria-label="编辑顶栏按钮"]'),
        minimize: win('最小化'),
        maximize: win('最大化'),
        close: win('关闭'),
      }
    })
    check(
      '三颗种子按钮按声明序渲染（focus 10 / record 20 / voice 30）',
      JSON.stringify(seed.ids) === JSON.stringify(['focus.topbar', 'record.topbar', 'voice.topbar']),
      '实测 ' + JSON.stringify(seed.ids),
    )
    check('按钮 aria-label = 插件声明的 label', JSON.stringify(seed.labels) === JSON.stringify(['专注', '录音', '语音']), '实测 ' + JSON.stringify(seed.labels))
    check('每颗按钮是真 <button>（标题栏 deep 拖拽区放行 isInteractive）', seed.realButtons)
    check('「编辑顶栏按钮」入口在场', seed.editEntry)
    check('窗控三钮不受影响（最小化/最大化/关闭）', seed.minimize && seed.maximize && seed.close)

    const stored = await page.evaluate((k) => localStorage.getItem(k), NAV_KEY)
    check('从未编辑过就绝不写布局键（不产生无意义首写）', stored === null, '实测 ' + String(stored))
    await ctx.close()
  }

  /* ================= 1b. 窄 Tauri 窗：isDesktop 门 ================= */
  {
    const { ctx, page } = await newPage(browser, { viewport: PHONE })
    console.log('1b. 窄 Tauri 窗（430×932）：按钮区不渲染')
    await goto(page, '#/')
    await sleep(400)
    const narrow = await page.evaluate(() => ({
      titlebar: !!document.querySelector('.titlebar'),
      actions: document.querySelectorAll('.tb-actions').length,
      minimize: [...document.querySelectorAll('.titlebar button')].some(
        (b) => b.getAttribute('aria-label') === '最小化',
      ),
    }))
    check('窄窗标题栏仍渲染（sticky 玻璃带）', narrow.titlebar)
    check('功能按钮区在窄窗根本不渲染（isDesktop ≥900 门）', narrow.actions === 0, '实测 ' + narrow.actions)
    check('窗控三钮完好', narrow.minimize)
    await ctx.close()
  }

  /* ================= 1c. 浏览器桌面（无桩）：AppTitleBar 不渲染 ================= */
  {
    const { ctx, page } = await newPage(browser, { tauri: false })
    console.log('1c. 浏览器桌面（无 Tauri 桩）')
    await goto(page, '#/')
    const plain = await page.evaluate(
      () => ({
        titlebar: document.querySelectorAll('.titlebar').length,
        actions: document.querySelectorAll('.tb-actions').length,
        rail: !!document.querySelector('.rail'),
      }),
    )
    check('浏览器不渲染 AppTitleBar（顶栏按钮是 Tauri 桌面专属，rail 兜住其余形态）', plain.titlebar === 0 && plain.actions === 0)
    check('桌面壳本身照常（导航轨在场）', plain.rail)
    await ctx.close()
  }

  /* ================= 2-4. 编辑态 / 拖拽保存 / 放弃 ================= */
  {
    const { ctx, page } = await newPage(browser)
    console.log('2. 编辑态：徽标 / 候选下拉 / Esc 不退出')
    await goto(page, '#/')
    await page.waitForSelector('.tb-actions')

    await page.locator('.titlebar [aria-label="编辑顶栏按钮"]').click()
    await page.waitForSelector('.nav-edit-mask')
    const edit0 = await page.evaluate(() => ({
      badges: document.querySelectorAll('.tb-actions [data-nav-badge="-"]').length,
      panel: document.querySelectorAll('.panel[role="menu"]').length,
      mask: !!document.querySelector('.nav-edit-mask'),
      rowInert: document.querySelector('.tb-actions')?.inert ?? null,
      minimize: [...document.querySelectorAll('.titlebar button')].some(
        (b) => b.getAttribute('aria-label') === '最小化',
      ),
      discard: !!document.querySelector('.titlebar [aria-label="放弃变更"]'),
      save: !!document.querySelector('.titlebar [aria-label="保存布局"]'),
      editBtnGone: !document.querySelector('.titlebar [aria-label="编辑顶栏按钮"]'),
    }))
    check('编辑态：三颗按钮全部带「−」徽标（顶栏无固定件）', edit0.badges === 3, '实测 ' + edit0.badges)
    check('候选为空时下拉不开（纯重排没有可加回的东西）', edit0.panel === 0)
    check('「编辑」钮原位替换为「放弃变更 / 保存布局」两颗', edit0.discard && edit0.save && edit0.editBtnGone)
    check('编辑面可交互（按钮区不挂 inert）', edit0.rowInert === false)
    check('mask 在场，窗控三钮恒可点（标题栏编辑态提权）', edit0.mask && edit0.minimize)

    await page.keyboard.press('Escape')
    await sleep(300)
    check('Esc 不退出编辑态（退出只有放弃/保存两条路）', await page.evaluate(() => !!document.querySelector('.nav-edit-mask')))

    console.log('2b. 「−」撤回 → 候选下拉出现 → 「＋」加回')
    await page.locator('.tb-actions [data-nav-id="voice.topbar"] .badge').click()
    await sleep(300)
    const edit1 = await page.evaluate(() => ({
      ids: [...document.querySelectorAll('.tb-actions [data-nav-id]')].map((el) => el.dataset.navId),
      panelItems: [...document.querySelectorAll('.panel[role="menu"] .item .lbl')].map((el) => el.textContent.trim()),
      panelBadges: [...document.querySelectorAll('.panel[role="menu"] .item [data-nav-badge="+"]')].length,
    }))
    check('撤回后行里只剩两颗', JSON.stringify(edit1.ids) === JSON.stringify(['focus.topbar', 'record.topbar']), '实测 ' + JSON.stringify(edit1.ids))
    check('候选下拉出现且每项带 data-nav-badge="+" 徽标（纯标签文案）', JSON.stringify(edit1.panelItems) === JSON.stringify(['语音']) && edit1.panelBadges === 1, `items ${JSON.stringify(edit1.panelItems)} · badges ${edit1.panelBadges}`)
    await page.locator('.panel[role="menu"] .item', { hasText: '语音' }).click()
    await sleep(300)
    check('「＋」加回后行恢复三颗', JSON.stringify(await rowOrder(page)) === JSON.stringify(['focus.topbar', 'record.topbar', 'voice.topbar']))

    console.log('3. 拖拽换位 + 保存布局（草稿序落盘，刷新仍在）')
    const voice = page.locator('.tb-actions [data-nav-id="voice.topbar"]')
    const focus = page.locator('.tb-actions [data-nav-id="focus.topbar"]')
    const vb = await voice.boundingBox()
    const fb = await focus.boundingBox()
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2)
    await page.mouse.down()
    // 分步走：越过 8px slop 抓住，再压到 专注 中线（elementFromPoint 落点解算）
    await page.mouse.move((vb.x + fb.x) / 2 + 40, vb.y, { steps: 6 })
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 8 })
    await sleep(120)
    await page.mouse.up()
    await sleep(500)
    const draftOrder = await rowOrder(page)
    check('live reorder：语音拖到最前（草稿序可见）', JSON.stringify(draftOrder) === JSON.stringify(['voice.topbar', 'focus.topbar', 'record.topbar']), '实测 ' + JSON.stringify(draftOrder))

    await page.locator('.titlebar [aria-label="保存布局"]').click()
    await sleep(400)
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.topbar ?? null, NAV_KEY)
    check(
      '保存后存储写入草稿序',
      JSON.stringify(saved) === JSON.stringify(['voice.topbar', 'focus.topbar', 'record.topbar']),
      '实测 ' + JSON.stringify(saved),
    )
    check('保存即退出编辑态（mask 收起）', await page.evaluate(() => !document.querySelector('.nav-edit-mask')))
    await page.reload({ waitUntil: 'load' })
    await sleep(900)
    await dismissUpdate(page)
    check('刷新后布局仍在（localStorage 持久化）', JSON.stringify(await rowOrder(page)) === JSON.stringify(['voice.topbar', 'focus.topbar', 'record.topbar']), '实测 ' + JSON.stringify(await rowOrder(page)))

    console.log('4. 放弃变更：撤回一条后放弃，行与存储都不动')
    await page.locator('.titlebar [aria-label="编辑顶栏按钮"]').click()
    await page.waitForSelector('.nav-edit-mask')
    await page.locator('.tb-actions [data-nav-id="record.topbar"] .badge').click()
    await sleep(200)
    check('草稿里摘除录音', JSON.stringify(await rowOrder(page)) === JSON.stringify(['voice.topbar', 'focus.topbar']))
    await page.locator('.titlebar [aria-label="放弃变更"]').click()
    await sleep(400)
    const afterDiscard = {
      row: await rowOrder(page),
      stored: await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.topbar ?? null, NAV_KEY),
      mask: await page.evaluate(() => !document.querySelector('.nav-edit-mask')),
    }
    check('放弃后行回滚', JSON.stringify(afterDiscard.row) === JSON.stringify(['voice.topbar', 'focus.topbar', 'record.topbar']), '实测 ' + JSON.stringify(afterDiscard.row))
    check('放弃后存储原样（草稿从未落盘）', JSON.stringify(afterDiscard.stored) === JSON.stringify(['voice.topbar', 'focus.topbar', 'record.topbar']))
    check('放弃即退出编辑态', afterDiscard.mask)
    await ctx.close()
  }

  /* ================= 5. 失效 id 静默丢弃，存储不动 ================= */
  {
    const ghostLayout = { tabbar: ['sports', 'ghost-route'], topbar: ['voice.topbar', 'record.topbar', 'focus.topbar', 'ghost.topbar'] }
    const { ctx, page } = await newPage(browser, { storage: [[NAV_KEY, { v: 1, ...ghostLayout }]] })
    console.log('5. 预置布局含失效 id')
    await goto(page, '#/')
    await page.waitForSelector('.tb-actions')
    const ghost = {
      row: await rowOrder(page),
      stored: await page.evaluate((k) => localStorage.getItem(k), NAV_KEY),
    }
    check(
      '失效 id 静默丢弃，其余按存储序渲染',
      JSON.stringify(ghost.row) === JSON.stringify(['voice.topbar', 'record.topbar', 'focus.topbar']),
      '实测 ' + JSON.stringify(ghost.row),
    )
    check('存储原样（解析期过滤，不写回）', ghost.stored === JSON.stringify({ v: 1, ...ghostLayout }))
    await ctx.close()
  }

  /* ================= 6. 关掉模块 → 按钮消失 ================= */
  {
    const { ctx, page } = await newPage(browser, { storage: [[FEATURES_KEY, { focus: false }]] })
    console.log('6. 关掉专注模块')
    await goto(page, '#/')
    await page.waitForSelector('.tb-actions')
    const off = await rowOrder(page)
    check('专注按钮从渲染清单消失（不是置灰）', !off.includes('focus.topbar'), '实测 ' + JSON.stringify(off))
    check('录音 / 语音按钮照常', off.includes('record.topbar') && off.includes('voice.topbar'))
    await ctx.close()
  }

  /* ================= 7. 动作分派（宿主 ACTIONS 表 → 既有 store / runtime） ================= */
  {
    const { ctx, page } = await newPage(browser)
    console.log('7. 动作分派')
    await goto(page, '#/')
    await page.waitForSelector('.tb-actions')

    // 专注：起跑 → 专注浮条出现且主动作是「暂停」；再点（暂停）→ 主动作变「继续」
    await page.locator('.tb-actions [aria-label="专注"]').click()
    await page.waitForSelector('[aria-label="专注计时"]')
    const pauseBtn = page.locator('[aria-label="专注计时"]').getByRole('button', { name: '暂停' })
    check('focus-toggle 起跑：专注浮条出现，主动作「暂停」', (await pauseBtn.count()) === 1)
    await sleep(1300)
    await page.locator('.tb-actions [aria-label="专注"]').click()
    await sleep(300)
    const resumeBtn = page.locator('[aria-label="专注计时"]').getByRole('button', { name: '继续' })
    check('focus-toggle 再点暂停：主动作变「继续」（start 幂等且可从暂停续跑）', (await resumeBtn.count()) === 1)

    // 录音：起录 → 录音浮条出现；再点（停止）→ 浮条收起
    await page.locator('.tb-actions [aria-label="录音"]').click()
    await page.waitForSelector('[aria-label="正在录音"]')
    check('record-toggle 起录：录音浮条出现（录音中）', await page.evaluate(() => document.querySelector('[aria-label="正在录音"]')?.textContent.includes('录音中') ?? false))
    await sleep(1200)
    await page.locator('.tb-actions [aria-label="录音"]').click()
    await sleep(600)
    check('record-toggle 再点停止：录音浮条收起', await page.evaluate(() => !document.querySelector('[aria-label="正在录音"]')))

    // 语音：mock 默认未配置豆包语音 → 引导 toast + 跳模型页（与 HomeFooter 同款引导）
    await page.locator('.tb-actions [aria-label="语音"]').click()
    await page.waitForSelector('.toast')
    check('voice-session 未配置引导 toast', await page.evaluate(() => document.querySelector('.toast .txt')?.textContent.includes('先在「管理模型」里配置豆包语音服务') ?? false))
    await page.waitForFunction(() => location.hash.endsWith('#/ai/models'))
    check('voice-session 跳转模型页', true)
    await ctx.close()
  }

  /* ================= 8. 浮窗不泄漏 ================= */
  {
    const { ctx, page } = await newPage(browser, { viewport: { width: 430, height: 300 }, tauri: false })
    console.log('8. 浮窗标题栏（float.html）不泄漏')
    await page.goto(APP + '/float.html', { waitUntil: 'load' })
    await sleep(900)
    const leak = await page.evaluate(() => ({
      floatTitlebar: !!document.querySelector('.titlebar'),
      floatTitle: document.querySelector('.titlebar')?.textContent.includes('Rein 浮窗') ?? false,
      actions: document.querySelectorAll('.tb-actions').length,
      navIds: document.querySelectorAll('[data-nav-id]').length,
    }))
    check('浮窗空态渲染出自己的标题栏', leak.floatTitlebar && leak.floatTitle)
    check('浮窗标题栏无功能按钮区（插槽内容不共享，绝不泄漏）', leak.actions === 0, '实测 ' + leak.actions)
    check('浮窗内无任何 data-nav-id 条目', leak.navIds === 0, '实测 ' + leak.navIds)
    await ctx.close()
  }

  /* ================= 清场（防跨剧本泄漏，§8.3） ================= */
  {
    const { ctx, page } = await newPage(browser)
    await goto(page, '#/')
    await page.evaluate(([nav, features]) => {
      localStorage.removeItem(nav)
      localStorage.removeItem(features)
    }, [NAV_KEY, FEATURES_KEY])
    await ctx.close()
  }
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\n${failures.length} 项断言失败`)
  process.exit(1)
}
console.log('\n全部通过')
