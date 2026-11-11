/**
 * 长期记忆分片端到端（浏览器 mock 模式，无头 Edge + 原生 CDP）。
 *
 * 运行：node scripts/e2e-memory-shards.mjs
 * 前置：`npm run dev` 已在 1420；或用 REIN_E2E_URL 指向别的实例。
 *
 * 覆盖（对应 docs/MEMORY-SYSTEM.md）：
 *   A. 自动注入严格只读 —— 连续 inject 不改 history / stability / state，不写 search_hit；
 *   B. 主动搜索强化递减 —— 只强化 top 3；factor 随 rank 递减；10 分钟冷却内再搜不重复强化；
 *   C. mark 地板 —— 归档行被标记后回 active，base=4.0 / floor=0.35，floor 权重 ≥1.4（时间旅行后仍 active）；
 *   D. 归档 / 恢复 —— 归档进 archived 列表、写 manual_archive；恢复回 active、写 manual_restore、可重复调用返回 false；
 *   E. Dream apply 幂等 —— mark_important 被拒绝；同一 run 重放返回 alreadyApplied 且不重复建 shard；
 *   F. alpha 降档 —— 30 天内 5 次命中后 alpha=0.4，rank 0 的 factor=1.4（时间旅行 + 重载 mock 存储）。
 *
 * 说明：本脚本只写不跑；下面所有时间旅行都直接改 mock 的 localStorage 快照，然后重载页面让
 * `src/mock/server.ts` 的模块级 store 重新读取。真实 Rust 后端的同一行为由 `cargo test --lib` 覆盖。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 9386 不在 Windows 的 9238-9337 排除段；可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9386)
/** 目标应用地址：默认 1420；并发会话时用 REIN_E2E_URL 指向独立实例 */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-memory-shards-${Date.now()}`

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
    throw new Error(
      'eval 异常: ' +
        JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
    )
  }
  return r?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return true
    } catch {
      /* 页面重载期间上下文会短暂销毁：下轮再试 */
    }
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

async function connect(url) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
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
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch {
      /* 尚未就绪 */
    }
    await sleep(250)
  }
}

/* ---------- 页内调用（走 transport → mock） ---------- */

async function invoke(cmd, args = {}) {
  return evalJS(`(async () => {
    const { invoke } = await import('/src/services/transport.ts')
    return await invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
  })()`)
}

async function kb(method, ...args) {
  return evalJS(`(async () => {
    const { kbService } = await import('/src/services/kbService.ts')
    return await kbService[${JSON.stringify(method)}](${args
      .map((a) => JSON.stringify(a))
      .join(', ')})
  })()`)
}

/* ---------- 断言小工具 ---------- */

const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps
const countEvent = (detail, event) =>
  (detail?.history ?? []).filter((h) => h.event === event).length
const lastEvent = (detail, event) =>
  [...(detail?.history ?? [])].reverse().find((h) => h.event === event) ?? null
const findShard = (list, prefix) => (list ?? []).find((s) => (s.content ?? '').startsWith(prefix))

/** 添加一条 manual shard 并返回它的 id（按内容前缀在列表里反查）。 */
async function addShard(prefix, content, extra = {}) {
  const r = await kb('memoryShardApply', [
    {
      op: 'add',
      content,
      memType: extra.memType ?? 'preference',
      topic: extra.topic ?? 'e2e',
      category: extra.category ?? '健康/测试',
    },
  ])
  if (Number(r?.added ?? 0) !== 1) {
    throw new Error(`addShard 失败：${prefix} / ${JSON.stringify(r)}`)
  }
  const list = await kb('memoryShards', 'all', 'all', 500, 0)
  const shard = findShard(list, prefix)
  if (!shard) throw new Error(`addShard 后找不到前缀：${prefix}`)
  return shard.id
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
    await connect(`${APP}/#/ai`)
    // AI 页是「无标题页」：用页头的历史圆钮判挂载
    await waitFor(
      `!!document.querySelector('.page-header button[aria-label="历史"]')`,
      12000,
      'AI 页挂载',
    )
    await sleep(500)

    // 新 profile 的 mock 存储应该是空的；显式再清一次，避免上一次运行残留
    await evalJS(`(() => {
      for (const k of [
        'rein.mock.memory_shards.v1',
        'rein.mock.kb_memories.v1',
        'rein.mock.kb_memory_diffs.v1',
        'rein.mock.ai_chats.v1',
      ]) localStorage.removeItem(k)
      return true
    })()`)

    /* ============================================================
       A. 自动注入严格只读
       ============================================================ */
    const injectId = await addShard(
      '注射只读样本',
      '注射只读样本：用户偏好早上训练，晚上不做高强度。',
      { topic: '作息', category: '生活/作息' },
    )
    const beforeShard = await kb('memoryShard', injectId)
    const beforeEvents = await kb('memoryShardEvents', 200)
    const beforeStats = await kb('memoryShardStats')

    let injectText = ''
    for (let i = 0; i < 3; i++) {
      const out = await kb('memoryInject', '注射只读样本', 2000, 8, false)
      injectText = out?.text ?? injectText
    }

    const afterShard = await kb('memoryShard', injectId)
    const afterEvents = await kb('memoryShardEvents', 200)
    const afterStats = await kb('memoryShardStats')

    ok(
      'A1 注入返回包含目标记忆',
      injectText.includes('注射只读样本') && injectText.includes('[偏好·生活/作息]'),
      injectText.slice(0, 80),
    )
    ok(
      'A2 注入不增加 history 行数',
      (beforeEvents?.length ?? -1) === (afterEvents?.length ?? -2),
      `${beforeEvents?.length} → ${afterEvents?.length}`,
    )
    ok(
      'A3 注入不改 stability / state / lastEventAt',
      near(beforeShard?.shard?.stability, afterShard?.shard?.stability, 1e-9) &&
        beforeShard?.shard?.state === afterShard?.shard?.state &&
        beforeShard?.shard?.lastEventAt === afterShard?.shard?.lastEventAt,
      `${beforeShard?.shard?.stability} → ${afterShard?.shard?.stability}`,
    )
    ok(
      'A4 注入不写 search_hit（没有「注入即续命」）',
      countEvent(afterShard, 'search_hit') === 0,
      `search_hit=${countEvent(afterShard, 'search_hit')}`,
    )
    ok(
      'A5 注入前后注入条数/字符数不变',
      beforeStats?.injected === afterStats?.injected &&
        beforeStats?.injectedChars === afterStats?.injectedChars,
      `${beforeStats?.injected}/${beforeStats?.injectedChars} → ${afterStats?.injected}/${afterStats?.injectedChars}`,
    )

    /* ============================================================
       B. 主动搜索：top 3、rank 递减、冷却
       ============================================================ */
    const reinforceIds = []
    for (let i = 0; i < 4; i++) {
      reinforceIds.push(
        await addShard(
          `强化递减样本${i}`,
          `强化递减样本${i}：膝盖恢复期，深蹲重量控制在 ${60 + i * 5}kg 以内。`,
          { topic: '膝盖', category: '健康/训练' },
        ),
      )
    }

    const search1 = await kb('memorySearch', '强化递减', 8, true, false, false)
    const hits1 = search1?.hits ?? []
    const ours1 = hits1.filter((h) => reinforceIds.includes(h.shardId))
    ok(
      'B1 主动搜索命中 4 条样本',
      ours1.length === 4,
      `命中 ${ours1.length} / reinforced=${search1?.reinforced}`,
    )
    ok(
      'B2 只强化 top 3（rank 3 不写 search_hit）',
      search1?.reinforced === 3,
      `reinforced=${search1?.reinforced}`,
    )

    const factors = []
    for (const hit of ours1.slice(0, 3)) {
      const detail = await kb('memoryShard', hit.shardId)
      factors.push(lastEvent(detail, 'search_hit')?.factor ?? null)
    }
    ok(
      'B3 factor 随 rank 递减（0.8/(1+rank)）',
      factors[0] > factors[1] && factors[1] > factors[2],
      factors.map((f) => Number(f).toFixed(3)).join(' > '),
    )
    ok(
      'B4 factor 数值为 1.8 / 1.4 / 1.266…',
      near(factors[0], 1.8) && near(factors[1], 1.4) && near(factors[2], 1 + 0.8 / 3),
      factors.map((f) => Number(f).toFixed(3)).join(' / '),
    )

    const fourth = ours1[3]
    const fourthDetail = await kb('memoryShard', fourth.shardId)
    ok(
      'B5 rank 3 没有 search_hit',
      countEvent(fourthDetail, 'search_hit') === 0,
      `search_hit=${countEvent(fourthDetail, 'search_hit')}`,
    )

    const search2 = await kb('memorySearch', '强化递减', 8, true, false, false)
    ok(
      'B6 10 分钟冷却内再次搜索不重复强化',
      search2?.reinforced === 0,
      `reinforced=${search2?.reinforced}`,
    )

    /* ============================================================
       C. mark 地板 + 归档行复活
       ============================================================ */
    const markId = await addShard(
      '标记地板样本',
      '标记地板样本：这是用户明确要求长期记住的一条约束。',
      { memType: 'constraint', topic: '长期', category: '健康/约束' },
    )
    const archivedBeforeMark = await kb('memoryShardArchive', markId, 'e2e-archive-before-mark')
    const archivedView = await kb('memoryShards', 'archived', 'all', 500, 0)
    ok(
      'C1 先归档成功并进入 archived 列表',
      archivedBeforeMark === true && archivedView.some((s) => s.id === markId),
      `archive=${archivedBeforeMark}`,
    )

    const marked = await kb('memoryShardMarkImportant', markId, 'e2e-mark')
    const markedDetail = await kb('memoryShard', markId)
    const markHistory = lastEvent(markedDetail, 'manual_mark')
    ok(
      'C2 标记后 origin/base/floor 正确',
      marked?.origin === 'marked_important' &&
        near(marked?.baseWeight, 4) &&
        near(marked?.floor, 0.35),
      `${marked?.origin} base=${marked?.baseWeight} floor=${marked?.floor}`,
    )
    ok(
      'C3 标记把归档行拉回 active',
      marked?.state === 'active' && marked?.archivedAt == null && marked?.archivedReason == null,
      `state=${marked?.state}`,
    )
    ok(
      'C4 标记后 stability ≥90 且 effectiveWeight ≥1.4',
      Number(marked?.stability) >= 90 && Number(marked?.effectiveWeight) >= 1.4,
      `S=${marked?.stability} W=${marked?.effectiveWeight}`,
    )
    ok(
      'C5 manual_mark history 记录 4.0/0.35',
      near(markHistory?.baseWeight, 4) && near(markHistory?.floor, 0.35),
      `history base=${markHistory?.baseWeight} floor=${markHistory?.floor}`,
    )

    /* ============================================================
       D. 归档 / 恢复
       ============================================================ */
    const restoreId = await addShard(
      '归档恢复样本',
      '归档恢复样本：用于验证归档与恢复的事件流。',
      { topic: '归档', category: '生活/测试' },
    )
    const birthDetail = await kb('memoryShard', restoreId)
    const birthStability = birthDetail?.history?.[0]?.stability
    const archived = await kb('memoryShardArchive', restoreId, 'e2e-manual')
    const archivedDetail = await kb('memoryShard', restoreId)
    ok(
      'D1 归档返回 true、state=archived、原因写入',
      archived === true &&
        archivedDetail?.shard?.state === 'archived' &&
        archivedDetail?.shard?.archivedReason === 'e2e-manual',
      `state=${archivedDetail?.shard?.state} reason=${archivedDetail?.shard?.archivedReason}`,
    )
    ok(
      'D2 归档写 manual_archive',
      countEvent(archivedDetail, 'manual_archive') === 1,
      `manual_archive=${countEvent(archivedDetail, 'manual_archive')}`,
    )
    const archivedAgain = await kb('memoryShardArchive', restoreId, 'e2e-manual')
    ok('D3 重复归档返回 false（幂等）', archivedAgain === false, `archive=${archivedAgain}`)

    const restored = await kb('memoryShardRestore', restoreId)
    const restoredDetail = await kb('memoryShard', restoreId)
    ok(
      'D4 恢复回 active、清归档字段',
      restored === true &&
        restoredDetail?.shard?.state === 'active' &&
        restoredDetail?.shard?.archivedAt == null,
      `state=${restoredDetail?.shard?.state}`,
    )
    ok(
      'D5 恢复写 manual_restore，stability 不低于 birth',
      countEvent(restoredDetail, 'manual_restore') === 1 &&
        Number(restoredDetail?.shard?.stability) >= Number(birthStability),
      `S=${restoredDetail?.shard?.stability} birth=${birthStability}`,
    )
    const restoreAgain = await kb('memoryShardRestore', restoreId)
    ok('D6 对 active 再恢复返回 false', restoreAgain === false, `restore=${restoreAgain}`)

    /* ============================================================
       E. Dream apply：权限 + 幂等
       ============================================================ */
    const dreamOldId = await addShard(
      'Dream 被取代样本',
      'Dream 被取代样本：旧说法是每周练三次。',
      { topic: '训练频率', category: '健康/训练' },
    )
    const now = new Date().toISOString()
    for (let i = 0; i < 5; i++) {
      await invoke('ai_chat_append', {
        chatId: 'e2e-dream-chat',
        input: {
          id: `e2e-dream-msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          kind: 'text',
          text: `Dream 素材第 ${i} 条：最近训练安排有变化。`,
          createdAt: now,
        },
      })
    }
    const begin = await kb('memoryDreamBegin', true)
    ok(
      'E1 Dream gate 通过并返回 run/context',
      begin?.gate?.eligible === true && !!begin?.runId && !!begin?.context,
      `reason=${begin?.gate?.reason} run=${begin?.runId}`,
    )

    let forbidden = false
    let forbiddenMessage = ''
    try {
      await kb('memoryDreamApply', begin.runId, [
        { type: 'mark_important', shardId: dreamOldId, content: '不允许' },
      ])
    } catch (e) {
      forbidden = true
      forbiddenMessage = e instanceof Error ? e.message : String(e)
    }
    ok(
      'E2 Dream 拒绝 mark_important',
      forbidden && forbiddenMessage.includes('Dream 不能标记重要'),
      forbiddenMessage.slice(0, 120),
    )

    const actions = [
      {
        type: 'supersede',
        oldShardId: dreamOldId,
        content: 'Dream 被取代样本：新说法是每周练四次，已按用户最新说明更新。',
        memType: 'pattern',
        topic: '训练频率',
        category: '健康/训练',
        reason: 'newer_fact',
      },
      {
        type: 'digest',
        content: 'Dream 幂等摘要：最近一周训练频率上升，注意恢复。',
        topic: '恢复',
        category: '健康/训练',
      },
    ]
    const first = await kb('memoryDreamApply', begin.runId, actions)
    const second = await kb('memoryDreamApply', begin.runId, actions)
    const oldAfter = await kb('memoryShard', dreamOldId)
    const dreamShards = await kb('memoryShards', 'all', 'dream_summary', 500, 0)
    const digestShards = dreamShards.filter((s) =>
      (s.content ?? '').startsWith('Dream 幂等摘要'),
    )
    const supersedeShards = dreamShards.filter(
      (s) => s.dreamAction === 'supersede_new' && s.supersedes === dreamOldId,
    )

    ok(
      'E3 第一次 apply 创建 2 条、取代 1 条',
      first?.alreadyApplied === false &&
        first?.created === 2 &&
        first?.superseded === 1 &&
        first?.skipped === 0,
      JSON.stringify(first),
    )
    ok(
      'E4 旧 shard 被归档为 superseded',
      oldAfter?.shard?.state === 'archived' &&
        oldAfter?.shard?.archivedReason === 'superseded',
      `state=${oldAfter?.shard?.state} reason=${oldAfter?.shard?.archivedReason}`,
    )
    ok(
      'E5 supersede 新 shard 指向旧 id、digest 标记正确',
      supersedeShards.length === 1 &&
        digestShards.length === 1 &&
        digestShards[0]?.dreamAction === 'digest',
      `supersede=${supersedeShards.length} digest=${digestShards.length}`,
    )
    ok(
      'E6 同一 run 重放返回 alreadyApplied 且计数相同',
      second?.alreadyApplied === true &&
        second?.created === first?.created &&
        second?.superseded === first?.superseded,
      JSON.stringify(second),
    )
    const dreamShardsAfterReplay = await kb('memoryShards', 'all', 'dream_summary', 500, 0)
    ok(
      'E7 重放不重复建 shard',
      dreamShardsAfterReplay.filter((s) => (s.content ?? '').startsWith('Dream 幂等摘要')).length ===
        1 &&
        dreamShardsAfterReplay.filter(
          (s) => s.dreamAction === 'supersede_new' && s.supersedes === dreamOldId,
        ).length === 1,
      `dream_summary=${dreamShardsAfterReplay.length}`,
    )

    /* ============================================================
       F. 时间旅行：mark 地板 + alpha 降档（改 localStorage 后重载）
       ============================================================ */
    const alphaId = await addShard(
      '阿尔法降档样本',
      '阿尔法降档样本：这是一条独立记忆，只用来观察 alpha 从 0.8 降到 0.4。',
      { topic: 'alpha', category: '生活/测试' },
    )
    const travel = await evalJS(`(() => {
      const KEY = 'rein.mock.memory_shards.v1'
      const store = JSON.parse(localStorage.getItem(KEY))
      const mark = store.shards.find((s) => String(s.content || '').startsWith('标记地板样本'))
      const alpha = store.shards.find((s) => String(s.content || '').startsWith('阿尔法降档样本'))
      if (!mark || !alpha) return { ok: false }
      // mark 行回到 1970 年：只有 floor 权重撑着，sweep 不应把它归档
      mark.lastEventAt = '1970-01-01 00:00:00'
      mark.updatedAt = '1970-01-01 00:00:00'
      // 给 alpha 行塞 5 条 20 分钟前的 search_hit：hits_30d=5 → alpha 降到 0.4
      const maxSeq = Math.max(
        0,
        ...store.history.filter((h) => h.shardId === alpha.id).map((h) => Number(h.seq) || 0),
      )
      const at = new Date(Date.now() - 20 * 60_000).toISOString()
      for (let i = 1; i <= 5; i++) {
        store.history.push({
          shardId: alpha.id,
          seq: maxSeq + i,
          at,
          event: 'search_hit',
          stability: alpha.stability,
          baseWeight: alpha.baseWeight,
          floor: alpha.floor,
          factor: 1.2,
          rank: 0,
          hits30d: i - 1,
          runId: '',
          note: 'e2e-seed',
        })
      }
      localStorage.setItem(KEY, JSON.stringify(store))
      return { ok: true, markId: mark.id, alphaId: alpha.id, maxSeq }
    })()`)
    ok('F1 时间旅行快照写入成功', travel?.ok === true, JSON.stringify(travel))
    // 下一帧再 reload：直接 evalJS('location.reload()') 会销毁当前执行上下文
    await evalJS('(() => { setTimeout(() => location.reload(), 0); return true })()')
    await sleep(600)
    await waitFor(
      `!!document.querySelector('.page-header button[aria-label="历史"]')`,
      15000,
      '重载后 AI 页挂载',
    )
    await sleep(500)

    const sweep = await kb('memoryShardSweep')
    const markAfterTime = await kb('memoryShard', travel.markId)
    ok(
      'F2 1970 年的 marked shard 仍 active（floor 权重 1.4 ≥ 0.25）',
      markAfterTime?.shard?.state === 'active' && Number(markAfterTime?.shard?.effectiveWeight) >= 1.39,
      `state=${markAfterTime?.shard?.state} W=${markAfterTime?.shard?.effectiveWeight} sweep=${JSON.stringify(sweep)}`,
    )

    const alphaSearch = await kb('memorySearch', '阿尔法', 8, true, false, false)
    const alphaDetail = await kb('memoryShard', travel.alphaId)
    const alphaHit = lastEvent(alphaDetail, 'search_hit')
    ok(
      'F3 5 次历史命中后 alpha=0.4、rank 0 factor=1.4',
      alphaSearch?.reinforced === 1 && near(alphaHit?.factor, 1.4),
      `reinforced=${alphaSearch?.reinforced} factor=${alphaHit?.factor}`,
    )
  } finally {
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('运行失败：', e)
  process.exit(1)
})
