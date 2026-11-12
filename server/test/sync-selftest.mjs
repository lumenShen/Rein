/**
 * 同步会合 / 中继的自测：不碰线上服务，本地起一个假路由 + 真 SyncService 跑一遍。
 *
 *   node server/test/sync-selftest.mjs
 *
 * 覆盖：配对三拍（开码 / 报码 / 开码侧取回）、中继投递与取件、长轮询被唤醒、
 * UDP 会合互报公网映射、以及几条边界（坏房间号、超大帧、没有帧）。
 */
import dgram from 'node:dgram'
import http from 'node:http'

import { createRouter } from '../src/routes.mjs'
import { SyncService } from '../src/sync.mjs'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    process.stdout.write(`  ✓ ${name}\n`)
  } else {
    failures += 1
    process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cfg = {
  update: { channels: ['stable'], defaultChannel: 'stable' },
  dataDir: '.',
  port: 0,
  host: '127.0.0.1',
  publicBaseUrl: 'http://127.0.0.1',
  adminToken: 'x',
}
const events = []
const log = (event, detail) => events.push({ event, detail })

const sync = new SyncService(cfg, log)
const router = createRouter({ cfg, store: {}, ai: {}, sync, log })

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  Promise.resolve(router.handle(req, res, url)).catch((e) => {
    res.statusCode = 500
    res.end(String(e?.message ?? e))
  })
})

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

let base = ''
let udpPort = 0

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  sync.attachUdp(0)
  await sleep(50)
  udpPort = sync.udp.address().port
  process.stdout.write(`\n同步会合自测 · http ${base} · udp ${udpPort}\n\n`)

  // ---------- 配对 ----------
  process.stdout.write('配对\n')
  const opened = await api('POST', '/api/v1/sync/pair', { device: 'dev-a', pub: 'pk-a' })
  check('开码成功', opened.status === 200 && typeof opened.json?.code === 'string', JSON.stringify(opened.json))
  const code = opened.json?.code
  check('短码是 8 位、不含易混字符', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code ?? ''), code)

  const claimed = await api('POST', `/api/v1/sync/pair/${code}`, {
    device: 'dev-b',
    pub: 'pk-b',
    room: 'a'.repeat(32),
  })
  check('报码方拿到对方公钥', claimed.json?.peer?.device === 'dev-a' && claimed.json?.peer?.pub === 'pk-a', JSON.stringify(claimed.json))

  const state = await api('GET', `/api/v1/sync/pair/${code}`)
  check('开码方拿到对方公钥', state.json?.peer?.device === 'dev-b' && state.json?.room === 'a'.repeat(32), JSON.stringify(state.json))

  const again = await api('GET', `/api/v1/sync/pair/${code}`)
  check('同一串码用过即废', again.status === 404, JSON.stringify(again.json))

  const badRoom = await api('POST', '/api/v1/sync/pair', { device: 'dev-c', pub: 'pk-c' })
  const badClaim = await api('POST', `/api/v1/sync/pair/${badRoom.json?.code}`, {
    device: 'dev-d',
    pub: 'pk-d',
    room: 'not-a-room',
  })
  check('坏房间号被拒', badClaim.status === 400, JSON.stringify(badClaim.json))

  const huge = await api('POST', '/api/v1/sync/pair', { device: 'x'.repeat(300 * 1024), pub: 'pk' })
  check('超长设备号被拒（不进日志不进内存）', huge.status === 400, JSON.stringify(huge.json))
  const tricky = await api('POST', '/api/v1/sync/pair', { device: '../evil', pub: 'pk' })
  check('带路径字符的设备号被拒', tricky.status === 400, JSON.stringify(tricky.json))
  const eventsWithEvil = events.filter((e) => e.event === 'sync-pair-open' && String(e.detail?.device ?? '').length > 64)
  check('被拒的设备号没有落进日志', eventsWithEvil.length === 0)

  // ---------- HTTP 中继 ----------
  process.stdout.write('\n中继\n')
  const room = 'b'.repeat(32)
  const sent = await api('POST', `/api/v1/sync/relay/${room}`, { frames: ['ZmFrZS0x', 'ZmFrZS0y'] })
  check('投递两帧', sent.status === 200 && sent.json?.seq === 2, JSON.stringify(sent.json))

  const picked = await api('GET', `/api/v1/sync/relay/${room}?after=0`)
  check(
    '取件拿到两帧且有序',
    picked.json?.frames?.length === 2 && picked.json.frames[0].data === 'ZmFrZS0x' && picked.json.cursor === 2,
    JSON.stringify(picked.json),
  )

  const empty = await api('GET', `/api/v1/sync/relay/${room}?after=2`)
  check('没有新帧时立即返回', empty.json?.frames?.length === 0, JSON.stringify(empty.json))

  const longPoll = api('GET', `/api/v1/sync/relay/${room}?after=2&wait=5000`)
  await sleep(300)
  const t0 = Date.now()
  await api('POST', `/api/v1/sync/relay/${room}`, { frames: ['d2FrZQ=='] })
  const woken = await longPoll
  const waited = Date.now() - t0
  check('长轮询被新帧唤醒', woken.json?.frames?.length === 1 && waited < 3000, `${waited}ms`)

  const tooBig = await api('POST', `/api/v1/sync/relay/${room}`, { frames: ['x'.repeat(300 * 1024)] })
  check('超大帧被拒', tooBig.status === 400, JSON.stringify(tooBig.json))

  const noFrames = await api('POST', `/api/v1/sync/relay/${room}`, { frames: [] })
  check('空投递被拒', noFrames.status === 400, JSON.stringify(noFrames.json))

  const weirdRoom = await api('GET', '/api/v1/sync/relay/zz')
  check('坏房间号被拒', weirdRoom.status === 400, JSON.stringify(weirdRoom.json))

  // 残留清理：上一轮的帧还躺在环形缓存里，新会话第一帧捎带 resetBefore 清掉它们，
  // 但刚投进来（30 秒内）的对端握手帧必须毫发无损。
  const resetRoom = 'd'.repeat(32)
  await api('POST', `/api/v1/sync/relay/${resetRoom}`, { frames: ['c3RhbGUtMQ=='] })
  // 服务端按投递时刻（at）判定新旧；测试里把「上一轮的帧」直接拨回一分钟前。
  sync.rooms.get(resetRoom).frames[0].at = Date.now() - 60_000
  await api('POST', `/api/v1/sync/relay/${resetRoom}`, { frames: ['ZmFrZS0x'] })
  const stale = await api('POST', `/api/v1/sync/relay/${resetRoom}`, {
    frames: ['aGVsbG8='],
    resetBefore: Date.now() - 30_000,
  })
  const afterReset = await api('GET', `/api/v1/sync/relay/${resetRoom}?after=0`)
  check(
    'resetBefore 清掉旧帧但留下新帧',
    stale.status === 200 && afterReset.json?.frames?.length === 2 && afterReset.json.frames[0].data === 'ZmFrZS0x',
    JSON.stringify(afterReset.json),
  )
  const resetOnly = await api('POST', `/api/v1/sync/relay/${resetRoom}`, { resetBefore: Date.now() })
  const afterResetOnly = await api('GET', `/api/v1/sync/relay/${resetRoom}?after=0`)
  check(
    '只带 resetBefore 的空投递也能清房',
    resetOnly.status === 200 && afterResetOnly.json?.frames?.length === 0,
    JSON.stringify(afterResetOnly.json),
  )

  // ---------- UDP 会合 ----------
  process.stdout.write('\nUDP 会合\n')
  const room2 = 'c'.repeat(32)
  const a = dgram.createSocket('udp4')
  const b = dgram.createSocket('udp4')
  const inbox = { a: [], b: [] }
  a.on('message', (m) => inbox.a.push(JSON.parse(m.toString())))
  b.on('message', (m) => inbox.b.push(JSON.parse(m.toString())))
  await new Promise((r) => a.bind(0, '127.0.0.1', r))
  await new Promise((r) => b.bind(0, '127.0.0.1', r))

  const hello = (sock, device) =>
    new Promise((r) => {
      const msg = Buffer.from(JSON.stringify({ t: 'hello', room: room2, device }))
      sock.send(msg, udpPort, '127.0.0.1', r)
    })

  await hello(a, 'dev-a')
  await sleep(150)
  check('第一台拿到自己的公网映射', inbox.a[0]?.t === 'you' && inbox.a[0]?.ip === '127.0.0.1' && !inbox.a[0]?.peer, JSON.stringify(inbox.a[0]))

  await hello(a, 'dev-a')
  await hello(b, 'dev-b')
  await sleep(200)
  const bGot = inbox.b[0]
  check('第二台拿到第一台的映射', bGot?.peer?.device === 'dev-a' && bGot?.peer?.ip === '127.0.0.1' && bGot?.peer?.port > 0, JSON.stringify(bGot))

  await hello(a, 'dev-a')
  await sleep(200)
  const aGot = inbox.a[inbox.a.length - 1]
  check('第一台随后也拿到第二台的映射', aGot?.peer?.device === 'dev-b' && aGot?.peer?.port > 0, JSON.stringify(aGot))

  const bad = dgram.createSocket('udp4')
  await new Promise((r) => bad.bind(0, '127.0.0.1', r))
  await new Promise((r) => {
    bad.send(Buffer.from('not json'), udpPort, '127.0.0.1', r)
  })
  await sleep(120)
  check('垃圾报文不会让服务端崩', true)

  const evil = dgram.createSocket('udp4')
  const evilInbox = []
  evil.on('message', (m) => evilInbox.push(JSON.parse(m.toString())))
  await new Promise((r) => evil.bind(0, '127.0.0.1', r))
  await new Promise((r) => {
    evil.send(Buffer.from(JSON.stringify({ t: 'hello', room: room2, device: '../evil' })), udpPort, '127.0.0.1', r)
  })
  await sleep(150)
  check('UDP 的坏设备号被忽略（不回包不占位）', evilInbox.length === 0, JSON.stringify(evilInbox))

  a.close()
  b.close()
  bad.close()
  evil.close()

  // ---------- 收尾 ----------
  check('日志里有配对与会合事件', events.some((e) => e.event === 'sync-pair-open') && events.some((e) => e.event === 'sync-udp-listen'))

  server.close()
  sync.udp?.close()
  sync.sweeper && clearInterval(sync.sweeper)
  await sleep(50)
  process.stdout.write(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  process.stdout.write(`自测崩了：${e?.stack ?? e}\n`)
  process.exit(1)
})
