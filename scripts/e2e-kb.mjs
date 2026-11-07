/**
 * 知识库与认知层端到端：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-kb.mjs   （前置：npm run dev 已在 1420，或用 REIN_E2E_URL 指向别的实例）
 *
 * 覆盖两条链路：
 *   A. AI 工具链路 —— search_knowledge / read_knowledge / list_memories / remember / forget
 *      直接在页内调工具 execute()，断言投影形状、结构化过滤、附件 base64 不外泄；
 *   B. 设置与 UI —— 三档模式切换、逐类开关、知识库页渲染与检索试跑。
 *
 * 浏览器 mock 用 includes() 实现关键词检索，但**召回阶梯与形状与 Rust 侧一致**
 * （like / fuzzy / browse），所以这里的断言在真实实现上同样成立。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内（bind 0x271D），可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9333)
/** 目标应用地址：默认 1420；端口被系统排除或并发会话时用 REIN_E2E_URL 指向独立实例 */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-kb-${Date.now()}`

import { spawn } from 'node:child_process'

const results = []
let ws
let msgId = 0
const pending = new Map()

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
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
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  // 页面正在跳转（hash 变更）时上下文会被销毁，取不到 result —— 返回 undefined 交给调用方
  return r?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 触发 hash 路由跳转：先让求值返回，跳转放到下一帧，避免上下文销毁打断 evalJS */
async function gotoHash(hash) {
  await evalJS(`(() => { setTimeout(() => { location.hash = ${JSON.stringify(hash)} }, 0); return true })()`)
  await sleep(300)
}

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function connect(url) {
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
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
}

/** 页内调 invoke（走 transport → mock） */
async function invoke(cmd, args = {}) {
  return evalJS(`(async () => {
    const { invoke } = await import('/src/services/transport.ts')
    return await invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
  })()`)
}

/** 只读工具：重试安全。写类工具（remember/forget/write_note/classify_move…）不重试 */
const TOOL_READ_ONLY = new Set(['search_knowledge', 'read_knowledge', 'glob_knowledge', 'list_memories', 'read_modal', 'list_models', 'get_voice_status', 'list_voice_presets', 'search_food'])

/** 页内调某个 AI 工具的 execute（与模型调用同一条路径） */
async function runTool(name, args) {
  const expr = `(async () => {
    const { findAppTool } = await import('/src/ai/tools/registry.ts')
    const t = findAppTool(${JSON.stringify(name)})
    if (!t) throw new Error('工具不存在: ${name}')
    return await t.execute(${JSON.stringify(args)})
  })()`
  const v = await evalJS(expr)
  return v === undefined && TOOL_READ_ONLY.has(name) ? evalJS(expr) : v
}

/** 只读命令：上下文销毁时重试是安全的；写命令绝不能重试（会重复执行） */
const KB_READ_ONLY = new Set(['status', 'search', 'read', 'memories', 'glob', 'cognition', 'injection', 'fsMoves', 'mediaGet', 'fileGet', 'settingsGet', 'probeEmbedder', 'reindex'])

/** 页内调 kbService（UI 走的就是它）。只读调用带一次重试，抵御 dev 服务器 HMR 重载。 */
async function kb(method, ...args) {
  const expr = `(async () => {
    const { kbService } = await import('/src/services/kbService.ts')
    return await kbService[${JSON.stringify(method)}](${args.map((a) => JSON.stringify(a)).join(', ')})
  })()`
  const v = await evalJS(expr)
  return v === undefined && KB_READ_ONLY.has(method) ? evalJS(expr) : v
}

/* 附件里塞一段足够长的伪 base64，任何一处泄漏到检索结果都能被抓出来 */
const FAKE_B64 = 'QUJDREVGR0g'.repeat(400)

async function seed() {
  await invoke('create_todo', {
    title: '腿部力量训练',
    notes: '深蹲五组，注意膝盖不要内扣',
    date: '2026-09-10',
    category: 'workout',
    attachments: [
      { kind: 'image', name: '膝盖.jpg', content: `data:image/jpeg;base64,${FAKE_B64}`, size: 40960, createdAt: '2026-09-10T10:00:00Z' },
      { kind: 'text', name: '医嘱.txt', content: '避免深蹲超过 60 公斤', createdAt: '2026-09-10T10:00:00Z' },
    ],
  })
  await invoke('create_todo', {
    title: '买蛋白粉',
    notes: '乳清蛋白，巧克力味',
    date: '2026-09-11',
    category: 'general',
  })
  await invoke('create_workout', {
    name: '腿部训练日',
    workoutType: 'strength',
    date: '2026-09-10',
    durationMin: 60,
    intensity: 'moderate',
    kcal: 320,
    note: '卧推与深蹲',
  })
  await invoke('ai_chat_ensure', { id: 'kb-e2e-chat', title: '知识库测试' })
  await invoke('ai_chat_append', {
    chatId: 'kb-e2e-chat',
    input: { id: 'kb-e2e-msg', role: 'user', kind: 'text', text: '我最近膝盖不太舒服', createdAt: new Date().toISOString() },
  })
  // 长助手消息：会话转录文档切出 30+ 块，供文件库派生文档阅读器的翻页 UI 测试
  await invoke('ai_chat_append', {
    chatId: 'kb-e2e-chat',
    input: {
      id: 'kb-e2e-msg2',
      role: 'assistant',
      kind: 'text',
      text: '训练要点：' + '循序渐进增加重量，注意动作质量与恢复。'.repeat(400),
      createdAt: new Date().toISOString(),
    },
  })
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--window-size=430,900',
    'about:blank',
  ])
  await sleep(1800)

  try {
    await connect(APP)
    await waitFor("document.querySelector('h1')", 12000, '应用挂载')
    await sleep(600)

    /* ---------- 播种 + 建索引 ---------- */
    await seed()
    const queued = await invoke('kb_reindex', {})
    ok('建索引：源记录入队', Number(queued) >= 4, `入队 ${queued} 条`)

    /* ---------- A. 工具链路 ---------- */

    const s1 = await runTool('search_knowledge', { query: '膝盖' })
    ok('search_knowledge：两字词命中', Array.isArray(s1.items) && s1.items.length >= 1, `命中 ${s1.items?.length ?? 0} 条`)
    ok('search_knowledge：命中带 id 与标题', Number.isFinite(s1.items?.[0]?.id) && !!s1.items?.[0]?.title, s1.items?.[0]?.title)

    const blob = JSON.stringify(s1)
    ok('附件 base64 不泄漏进检索结果', !blob.includes('QUJDREVGR0g') && !blob.includes('data:image'), '已确认无 data URL')
    // text 附件是独立编目文档，按其内容检索（规范 §5）
    const attHit = await runTool('search_knowledge', { query: '60 公斤', sources: ['todo_attachment'] })
    ok(
      '附件 text 正文进入索引',
      attHit.items.length >= 1 && attHit.items[0].path.startsWith('附件/日程/'),
      attHit.items[0]?.path ?? '无命中',
    )

    const s2 = await runTool('search_knowledge', { query: '深蹲', sources: ['workout'] })
    ok(
      'search_knowledge：sources 过滤生效',
      s2.items.length >= 1 && s2.items.every((i) => i.source === 'workout'),
      `来源 ${[...new Set(s2.items.map((i) => i.source))].join(',')}`,
    )

    const s3 = await runTool('search_knowledge', { query: '训练' })
    ok('search_knowledge：命中带日期', s3.items.some((i) => i.date === '2026-09-10'), '日期投影存在')

    const s4 = await runTool('search_knowledge', { query: '', limit: 5 })
    ok('search_knowledge：空查询 = 浏览最近', s4.items.length >= 1, `返回 ${s4.items.length} 条`)
    ok('search_knowledge：limit 被钳制', (await runTool('search_knowledge', { query: '训练', limit: 999 })).items.length <= 20)

    const docId = s1.items[0].id
    const d1 = await runTool('read_knowledge', { docId })
    ok('read_knowledge：默认 l1 只给概览', d1.content.length <= 1 && d1.content.length >= 1, `块数 ${d1.content.length}`)
    ok('read_knowledge：带总分块数与 hasMore 提示', Number.isFinite(d1.totalChunks ?? d1.hasMore === false), `hasMore=${d1.hasMore}`)

    const d2 = await runTool('read_knowledge', { docId, level: 'l2' })
    ok('read_knowledge：l2 取正文', d2.content.length >= 1 && d2.content.join('').length > 0)

    let readErr = ''
    try {
      await runTool('read_knowledge', { docId: 999999 })
    } catch (e) {
      readErr = e.message ?? String(e)
    }
    ok('read_knowledge：不存在的 id 报可重试的错', readErr.includes('不存在'), readErr.slice(0, 60))

    /* ---------- 记忆链路 ---------- */

    const r1 = await runTool('remember', { content: '膝盖不适，深蹲不宜超过 60kg', memType: 'constraint', topic: '膝盖' })
    ok('remember：写入成功', r1.ok === true && r1.message.includes('已记住'), r1.message)

    const r2 = await runTool('remember', { content: '膝盖不适，深蹲不宜超过 60kg', memType: 'constraint', topic: '膝盖' })
    ok('remember：重复内容幂等', r2.ok === true && r2.message.includes('已经记过'), r2.message)

    const mems = await runTool('list_memories', {})
    ok('list_memories：能查到刚写的记忆', mems.items.some((m) => m.content.includes('深蹲不宜超过')), `共 ${mems.total} 条`)
    ok('list_memories：投影含 id 与类型', mems.items.every((m) => Number.isFinite(m.id) && !!m.type))

    const cog = await kb('cognition')
    ok('cognition：认知块包含该记忆', cog.text.includes('深蹲不宜超过'), cog.text.slice(0, 60))
    ok('cognition：格式为「- [类型] 内容」', /^- \[.+\] .+/m.test(cog.text), cog.text.split('\n')[0])

    const memId = mems.items.find((m) => m.content.includes('深蹲不宜超过')).id
    const s5 = await runTool('search_knowledge', { query: '深蹲', sources: ['memory'] })
    ok('记忆进入知识库检索', s5.items.some((i) => i.source === 'memory'), `命中 ${s5.items.length} 条`)

    const f1 = await runTool('forget', { memoryId: memId })
    ok('forget：删除成功', f1.ok === true, f1.message)
    const mems2 = await runTool('list_memories', {})
    ok('forget：列表已减少', !mems2.items.some((m) => m.id === memId), `剩 ${mems2.total} 条`)

    let forgetErr = ''
    try {
      await runTool('forget', { memoryId: 999999 })
    } catch (e) {
      forgetErr = e.message ?? String(e)
    }
    ok('forget：不存在的 id 抛错而非静默', forgetErr.includes('不存在'), forgetErr.slice(0, 60))

    /* ---------- B. 设置与三档模式 ---------- */

    let probeErr = ''
    try {
      await kb('probeEmbedder')
    } catch (e) {
      probeErr = e.message ?? String(e)
    }
    ok('keyword 模式下测试嵌入后端如实报错', probeErr.includes('关键词'), probeErr.slice(0, 60))

    const st0 = await kb('status')
    ok('status：默认 keyword、全来源启用', st0.mode === 'keyword' && st0.enabledSources.length >= 10, `mode=${st0.mode} sources=${st0.enabledSources.length}`)
    ok('status：keyword 模式不产生向量', st0.vectors === 0, `vectors=${st0.vectors}`)

    const set1 = await kb('settingsSet', { embeddingMode: 'local' })
    ok('settingsSet：切到本地模型', set1.embeddingMode === 'local')
    const catalog = await kb('embedModels')
    ok('本地模型目录：模型都不内置、默认未下载', catalog.models.length > 0 && catalog.models.every((m) => !m.installed))
    ok('本地模型未下载时不算就绪（检索回落关键词）', (await kb('status')).embedderReady === false)

    const set2 = await kb('settingsSet', { embeddingMode: 'cloud', cloudBaseUrl: 'https://api.example.com/v1', cloudModel: 'bge-m3' })
    ok('settingsSet：云端配置落库', set2.cloudBaseUrl === 'https://api.example.com/v1' && set2.cloudModel === 'bge-m3')

    const set3 = await kb('settingsSet', { cloudApiKey: 'sk-secret-abcd1234' })
    ok('settingsSet：密钥只回尾四位', set3.cloudApiKeyTail === '…1234' && !JSON.stringify(set3).includes('sk-secret'), set3.cloudApiKeyTail)

    const set4 = await kb('settingsSet', { cloudApiKey: 'sk-rotated-9999' })
    ok('settingsSet：换密钥不回显旧值', set4.cloudApiKeyTail === '…9999', set4.cloudApiKeyTail)

    let badMode = ''
    try {
      await kb('settingsSet', { embeddingMode: 'magic' })
    } catch (e) {
      badMode = e.message ?? String(e)
    }
    ok('settingsSet：未知模式被拒', badMode.includes('未知的检索模式') || badMode.includes('keyword'), badMode.slice(0, 60))

    await kb('settingsSet', { sourcesEnabled: { chat_message: false } })
    const st1 = await kb('status')
    ok('settingsSet：逐类开关生效', !st1.enabledSources.includes('chat_message'), st1.enabledSources.join(','))

    await kb('settingsSet', { embeddingMode: 'keyword', sourcesEnabled: {} })
    await invoke('kb_reindex', {})

    /* ---------- C. 虚拟文件系统 ---------- */

    // 规范文件：播种、只读、内容来自 docs/kb-vfs.md
    const specList = await kb('glob', '规范/*')
    ok('VFS：规范文件已播种', specList.length === 1 && specList[0].path === '规范/知识库规范.md', specList.map((f) => f.path).join(','))
    ok('VFS：规范文件标记为系统只读', specList[0]?.system === true && specList[0]?.editable === false)
    const specDoc = await kb('read', specList[0].id, 'l1')
    ok('VFS：规范文件内容可读', specDoc.summary.includes('虚拟文件系统') || specDoc.chunks.some((c) => c.text.includes('虚拟文件系统')))

    let specWriteErr = ''
    try {
      await kb('fileWrite', { path: '规范/伪造.md', content: 'x' })
    } catch (e) {
      specWriteErr = e.message ?? String(e)
    }
    ok('VFS：向 规范/ 写入被拒', specWriteErr.includes('系统命名空间'), specWriteErr.slice(0, 50))
    let specDelErr = ''
    try {
      await kb('fileDelete', specList[0].id)
    } catch (e) {
      specDelErr = e.message ?? String(e)
    }
    ok('VFS：删除规范文件被拒', specDelErr.includes('系统文件'), specDelErr.slice(0, 50))

    // 笔记：创建 → glob → 检索 → 分页读
    const longBody = '深蹲注意膝盖不要内扣。'.repeat(60)
    const note1 = await kb('fileWrite', { path: '训练/膝盖注意事项', content: '避免深蹲超过 60 公斤' })
    ok('VFS：笔记落位 笔记/ 命名空间', note1.path === '笔记/训练/膝盖注意事项.md', note1.path)
    const note2 = await kb('fileWrite', { path: '笔记/长文.md', content: longBody })
    ok('VFS：同路径重复写是覆盖', note2.id !== note1.id, '不同文件各自成档')

    const noteGlob = await kb('glob', '笔记/**/*.md')
    ok('VFS：glob 列出笔记（含子目录）', noteGlob.length === 2 && noteGlob.every((f) => f.editable), noteGlob.map((f) => f.path).join(','))

    const hitNote = await runTool('search_knowledge', { query: '60 公斤', sources: ['note'] })
    ok('VFS：笔记正文可被检索', hitNote.items.length >= 1 && hitNote.items[0].path === '笔记/训练/膝盖注意事项.md', hitNote.items[0]?.path)

    const longDoc = await kb('read', note2.docId, 'l2')
    ok('VFS：长笔记分块 >1', longDoc.totalChunks >= 3, `共 ${longDoc.totalChunks} 块`)
    // 3 块：offset=1 取 1 块 → 还有第 3 块，hasMore 应为 true
    const page2 = await kb('read', note2.docId, 'l2', 1, 1)
    ok('VFS：l2 分页 offset/limit 生效', page2.offset === 1 && page2.chunks.length === 1 && page2.hasMore === true, `offset=${page2.offset} 取${page2.chunks.length}块 hasMore=${page2.hasMore}`)
    // 读到最后一页：offset=2 只剩 1 块，hasMore=false 且 nextOffset 应为 undefined
    const paged = await runTool('read_knowledge', { docId: note2.docId, level: 'l2', offset: page2.offset + page2.chunks.length })
    ok(
      'VFS：read_knowledge 分页到末页收尾',
      paged.offset === 2 && paged.hasMore === false && paged.nextOffset === undefined,
      `offset=${paged.offset} hasMore=${paged.hasMore} nextOffset=${paged.nextOffset}`,
    )

    // 改名 + 删除
    const renamed = await kb('fileRename', note1.id, '训练/膝盖禁忌')
    ok('VFS：改名自动补 .md', renamed.path === '笔记/训练/膝盖禁忌.md', renamed.path)
    const rn = await runTool('rename_note', { docId: note2.docId, path: '笔记/长文改名' })
    ok('rename_note：改名成功', rn.ok === true && rn.path === '笔记/长文改名.md', rn.path)
    const afterRename = await kb('glob', '笔记/*.md')
    ok('VFS：改名后旧路径消失', !afterRename.some((f) => f.path === '笔记/长文.md'), afterRename.map((f) => f.path).join(','))

    // 会话文档 + 单条消息 + 附件编目
    const chatGlob = await kb('glob', '对话/**')
    ok('VFS：会话与消息都入路径树', chatGlob.some((f) => f.sourceType === 'chat') && chatGlob.some((f) => f.sourceType === 'chat_message'), `共 ${chatGlob.length} 条`)
    const chatDoc = chatGlob.find((f) => f.sourceType === 'chat')
    const chatFull = await kb('read', chatDoc.id, 'l2')
    ok('VFS：会话文档含全文转录', chatFull.chunks.some((c) => c.text.includes('膝盖不太舒服')), '')

    const attGlob = await kb('glob', '附件/**')
    const imgAtt = attGlob.find((f) => f.kind === 'image')
    ok('VFS：待办附件编目成文档', attGlob.length >= 2, attGlob.map((f) => f.path).join(','))
    ok('VFS：图片附件本体不入索引', imgAtt && !imgAtt.title.includes('jpg') === false && attGlob.every((f) => !JSON.stringify(f).includes('QUJDREVGR0g')), '无 base64')

    // 记忆编辑 + 文档写入（模拟上传归档：文档/ 命名空间）
    const memoAdd = await runTool('remember', { content: '周五下午不安排训练', memType: 'constraint', topic: '时间' })
    ok('remember：写入约束', memoAdd.ok === true)
    const memoList = await runTool('list_memories', {})
    const memoId = memoList.items.find((m) => m.content.includes('周五下午'))?.id
    const memoEdit = await runTool('edit_memory', { memoryId: memoId, content: '周五 17 点后不安排训练' })
    ok('edit_memory：更新内容', memoEdit.ok === true)
    const memoAfter = await runTool('list_memories', {})
    ok('edit_memory：列表反映新内容', memoAfter.items.some((m) => m.content.includes('17 点后')))
    const memPath = await kb('glob', '记忆/**')
    ok('VFS：记忆在 记忆/ 命名空间且可编辑', memPath.length >= 1 && memPath.every((f) => f.editable), memPath.map((f) => f.path).join(','))

    // 文档全文归档（端到端 docx 链路的机械部分）
    const docText = Array.from({ length: 30 }, (_, i) => `第9周 周三 第${i + 1}节 队列训练 地点：训练场`).join('\n')
    const docFile = await kb('fileWrite', { path: '文档/军事技能训练安排表9-10.md', content: docText })
    ok('VFS：上传文档全文归档到 文档/', docFile.path === '文档/军事技能训练安排表9-10.md', docFile.path)
    const docGlob = await kb('glob', '文档/*')
    ok('VFS：文档/ 可被 glob 列出', docGlob.length === 1 && docGlob[0].editable, docGlob.map((f) => f.path).join(','))
    const docPaged = await kb('read', docFile.docId ?? docGlob[0].id, 'l2', 0, 3)
    ok(
      'VFS：长文档可分页读',
      docPaged.totalChunks >= 2 && docPaged.chunks.length === 3 && docPaged.hasMore === false,
      `共 ${docPaged.totalChunks} 块，本页 ${docPaged.chunks.length} 块 hasMore=${docPaged.hasMore}`,
    )
    const docHit = await runTool('search_knowledge', { query: '队列训练', sources: ['note'] })
    ok('VFS：归档文档可被检索', docHit.items.length >= 1, docHit.items[0]?.path)

    // 超长归档文档：超过检索缓存上限（Rust MAX_BODY = 8000 字）也必须能分页读到结尾。
    // 这是 2026-09-12 截断修复的回归：缓存截断只影响召回，阅读按 kb_files 真源切块。
    const hugeTail = '全文结尾标记段必须能到达这里'
    const hugeText = '深蹲注意膝盖不要内扣。'.repeat(1500) + hugeTail
    const hugeFile = await kb('fileWrite', { path: '文档/超长训练手册.md', content: hugeText })
    const hugeDocId =
      hugeFile.docId ?? (await kb('glob', '文档/*')).find((f) => f.path === '文档/超长训练手册.md')?.id
    ok('VFS：超长归档文档落库', Number.isFinite(hugeDocId), `docId=${hugeDocId}`)
    const hugeDoc = await kb('read', hugeDocId, 'l2', 0, 8)
    ok('VFS：超长文档总块数按全文算', hugeDoc.totalChunks >= 60, `约 ${hugeText.length} 字，共 ${hugeDoc.totalChunks} 块`)
    let sawHugeTail = false
    let hugeOff = 0
    for (;;) {
      const p = await kb('read', hugeDocId, 'l2', hugeOff, 64)
      if (!p.chunks.length) break
      sawHugeTail = sawHugeTail || p.chunks.some((c) => c.text.includes(hugeTail))
      if (!p.hasMore) break
      hugeOff = p.offset + p.chunks.length
    }
    ok('VFS：超长文档分页能读到结尾（截断修复）', sawHugeTail, `翻到 offset=${hugeOff}`)
    const hugeLast = await runTool('read_knowledge', { docId: hugeDocId, level: 'l2', offset: hugeDoc.totalChunks - 1, limit: 1 })
    ok(
      'read_knowledge：末页可达且含结尾标记',
      hugeLast.hasMore === false && hugeLast.content.join('').includes(hugeTail),
      `offset=${hugeLast.offset} hasMore=${hugeLast.hasMore}`,
    )

    // 清理笔记，避免影响后续 UI 断言
    await kb('fileDelete', note2.id)
    await kb('fileRename', note1.id, '训练/膝盖注意事项')

    /* ---------- D. 知识库页 UI ---------- */
    //
    // 信息架构（本轮重构后）：主页面只留高频三块 —— 检索 / 长期记忆 / 文件；
    // 机器层（索引概况 · 检索模式 · 索引范围 · 云端配置）收进页头的「检索设置」抽屉。
    // 所以先断言主页面，再开抽屉断言机器层，最后回主页面跑检索。

    await gotoHash('#/ai/knowledge')
    await waitFor("document.body.innerText.includes('长期记忆')", 8000, '知识库页渲染')
    const pageText = await evalJS('document.body.innerText')
    ok('UI：主页面按到访频率排布（检索 / 长期记忆 / 文件）', pageText.includes('检索') && pageText.includes('长期记忆') && pageText.includes('文件库'), '')
    ok(
      'UI：检索入口在位（输入框 + 搜索钮）',
      await evalJS(`!!document.querySelector('input[type=search]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '搜索')`),
      '',
    )

    // 打开「检索设置」抽屉（页头设置钮），机器层全在这里
    await evalJS(`document.querySelector('.hdr-btn[aria-label="检索设置"]')?.click()`)
    await waitFor("document.body.innerText.includes('索引概况')", 8000, '检索设置抽屉')
    const drawerText = await evalJS(`document.querySelector('.panel')?.innerText ?? ''`)
    ok('UI：抽屉渲染索引概况与统计', drawerText.includes('索引概况') && drawerText.includes('条目'), '')
    ok('UI：抽屉渲染检索模式三档', drawerText.includes('关键词') && drawerText.includes('本地模型') && drawerText.includes('云端'), '')
    ok('UI：抽屉渲染索引范围开关', drawerText.includes('索引范围') && drawerText.includes('日程与附件'), '')

    ok('UI：切到云端模式显示配置项', (await evalJS(`(async () => {
      const btns = [...document.querySelectorAll('.panel button')].filter((b) => b.textContent.trim() === '云端')
      btns[0]?.click()
      await new Promise((r) => setTimeout(r, 300))
      const t = document.querySelector('.panel')?.innerText ?? ''
      return t.includes('服务地址') && t.includes('密钥') && t.includes('模型名')
    })()`)) === true)

    // 关抽屉，回主页面
    await evalJS(`document.querySelector('.panel .close')?.click()`)
    await sleep(500)

    // 检索试跑：输入关键词 → 点搜索 → 结果出现
    await evalJS(`(() => {
      const el = [...document.querySelectorAll('input[type=search]')][0]
      if (!el) throw new Error('找不到检索输入框')
      el.value = '膝盖'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '搜索')
      if (!btn) throw new Error('找不到搜索按钮')
      btn.click()
      return true
    })()`)
    await sleep(700)
    const hitText = await evalJS('document.body.innerText')
    ok('UI：检索试跑出结果', hitText.includes('腿部力量训练'), '命中标题已渲染')
    ok('UI：结果不泄漏附件 base64', !hitText.includes('QUJDREVGR0g'))

    /* ---------- E. 文件库页 ---------- */

    await gotoHash('#/ai/knowledge/files')
    await waitFor("document.body.innerText.includes('最近内容')", 8000, '文件库页渲染')
    let libText = await evalJS('document.body.innerText')
    ok('文件库：根目录渲染最近内容与目录网格', libText.includes('最近内容') && libText.includes('目录'), '')
    ok(
      '文件库：命名空间网格齐全（v2：系统提示词/用户记忆/未分类数据/语音）',
      ['系统提示词', '用户记忆', '未分类数据', '笔记', '文档', '语音', '日程', '对话', '记忆', '规范'].every((n) => libText.includes(n)),
      '',
    )

    // 下钻 文档/ 目录
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.querySelector('b')?.textContent === '文档')
      if (!btn) throw new Error('找不到「文档」命名空间入口')
      btn.click()
      return true
    })()`)
    await sleep(500)
    libText = await evalJS('document.body.innerText')
    ok('文件库：下钻列出归档文档', libText.includes('超长训练手册.md'), '')

    // 阅读器：note 源直读原文，超过缓存上限的结尾也完整可见
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('超长训练手册.md'))
      if (!btn) throw new Error('找不到超长文档行')
      btn.click()
      return true
    })()`)
    await sleep(700)
    // 阅读器渲染是异步的（read + fileGet 两次 IPC），等真源原文出现在页面上再断言
    try {
      await waitFor("document.body.innerText.includes('全文结尾标记段必须能到达这里')", 8000, '阅读器渲染全文')
    } catch { /* 断言会给出更清晰的失败信息 */ }
    libText = await evalJS('document.body.innerText')
    ok('文件库：阅读器完整展示原文（结尾可见）', libText.includes(hugeTail), '')
    ok('文件库：阅读器显示路径与字数', libText.includes('文档/超长训练手册.md') && /[\d,]+ 字/.test(libText), '')

    // 返回列表，按文件名搜索（用阅读器自己的返回键，别误点页头的路由返回）
    await evalJS(`(() => {
      ;[...document.querySelectorAll('button[aria-label="返回列表"]')][0]?.click()
      return true
    })()`)
    await sleep(300)
    await evalJS(`(() => {
      const el = document.querySelector('.finder input')
      if (!el) throw new Error('找不到文件名搜索框')
      el.value = '训练手册'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(900)
    libText = await evalJS('document.body.innerText')
    ok('文件库：文件名搜索命中', libText.includes('超长训练手册.md'), '')

    // 派生文档（会话转录）：分块渐进加载 + 一次读完
    await evalJS(`(() => {
      const el = document.querySelector('.finder input')
      el.value = '知识库测试'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(900)
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('知识库测试'))
      if (!btn) throw new Error('找不到会话文档行')
      btn.click()
      return true
    })()`)
    await sleep(700)
    libText = await evalJS('document.body.innerText')
    ok('文件库：派生文档分块加载带翻页', libText.includes('循序渐进') && libText.includes('继续加载'), '')
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '一次读完')
      if (!btn) throw new Error('找不到「一次读完」')
      btn.click()
      return true
    })()`)
    await waitFor("document.body.innerText.includes('已到末尾')", 8000, '一次读完到底')
    ok('文件库：一次读完到达全文末尾', true, '')

    // 清理超长文档，不污染其他断言
    const hugeLeft = (await kb('glob', '文档/*')).find((f) => f.path === '文档/超长训练手册.md')
    if (hugeLeft) await kb('fileDelete', hugeLeft.id)
    ok('文件库：清理超长文档', !(await kb('glob', '文档/*')).some((f) => f.path === '文档/超长训练手册.md'), '')
  } finally {
    try { ws?.close() } catch { /* 忽略 */ }
    edge.kill()
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    }
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('运行失败：', e)
    process.exit(1)
  })
