/**
 * 多设备同步的会合与中继（零依赖，全在内存里）。
 *
 * 这里只干三件事，且**一件都不落盘**：
 *   1. 配对：一台设备开一个短码（5 分钟有效），另一台报出同一串码，两边互认公钥与
 *      房间号。码是一次性的，长期身份是各自的 X25519 公钥。
 *   2. 会合（UDP 48990）：设备周期性发 `hello`，服务端只做一件事 —— 把**它看到的**
 *      公网 ip:port 告诉同一个房间里的两台设备，让它们同时向对方打洞。
 *   3. 中继（HTTP 长轮询）：打洞不成时，两台设备把**已经端到端加密**的帧丢进房间邮箱，
 *      由对方取走。服务端看不到明文，也不写磁盘：房间是内存里的环形缓冲，10 分钟
 *      没人碰就消失，容量有上限。
 *
 * 为什么不存业务数据：docs/ARCHITECTURE.md 里那条约定（服务器不放业务数据）没有变。
 * 中继是「转发」，不是「存储」—— 掉电即丢，这正是它该有的语义。
 *
 * 房间号本身就是凭证：128 位随机（配对时两端交换），所以别人猜不到、也无法拿它当
 * 免费网盘（另有每 IP 限流与房间数上限）。
 */
import crypto from 'node:crypto'
import dgram from 'node:dgram'

import { clientIp, createBucket, nowIso, readJsonBody, sendError, sendJson } from './util.mjs'

const PAIR_TTL_MS = 5 * 60 * 1000
const PAIR_MAX = 64
const ROOM_TTL_MS = 10 * 60 * 1000
const ROOM_MAX = 64
const ROOM_FRAMES_MAX = 512
const ROOM_BYTES_MAX = 4 * 1024 * 1024
const POLL_MAX_WAIT_MS = 25_000
const PEER_FRESH_MS = 90 * 1000
const CHUNK_MAX = 256 * 1024 // 单帧上限（对象/块已经分过片，这里再兜一道）
const BODY_MAX = 8 * 1024 * 1024 // 一次投递的 body 上限
const DEFAULT_UDP_PORT = 48990

/** 去掉容易看错的字符（0/O、1/I/L）：这串码是要人念给另一台设备听的。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function randomCode(len = 8) {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

function validRoom(room) {
  return typeof room === 'string' && /^[a-f0-9]{16,64}$/.test(room)
}

/** 设备号是 uuid v4（36 字符）、公钥是 32 字节的 base64（44 字符）。
 *  不设边界的话，一个 4MB 的 device 会随着成功请求被原样写进日志与内存配对位 ——
 *  这台机器磁盘小，持续刷能把盘刷满，所以不合法的值在进门处就拒掉。
 *  公钥对服务端是不透明字节（真正解码在 App 侧），管住长度就够了，字符集不卡。 */
function validDevice(device) {
  return typeof device === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(device)
}

function validIdentity(device, pub) {
  return validDevice(device) && typeof pub === 'string' && pub.length >= 1 && pub.length <= 128
}

export class SyncService {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    /** roomId → { frames: [{ seq, data, at }], bytes, lastAt, waiters: [resolve] } */
    this.rooms = new Map()
    /** code → { device, pub, room, at, claimedBy } */
    this.pairs = new Map()
    /** roomId → { [device]: { ip, port, at } } */
    this.udpPeers = new Map()
    this.limit = createBucket({ rpm: 240, burst: 60 })
    this.udpLimit = createBucket({ rpm: 900, burst: 200 })
    this.udp = null
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  sweep() {
    const now = Date.now()
    for (const [code, v] of this.pairs) if (now - v.at > PAIR_TTL_MS) this.pairs.delete(code)
    for (const [room, v] of this.rooms) {
      if (now - v.lastAt > ROOM_TTL_MS) {
        for (const wake of v.waiters) wake()
        this.rooms.delete(room)
      }
    }
    for (const [room, peers] of this.udpPeers) {
      for (const [device, p] of Object.entries(peers)) {
        if (now - p.at > PEER_FRESH_MS) delete peers[device]
      }
      if (Object.keys(peers).length === 0) this.udpPeers.delete(room)
    }
  }

  // ---------- 配对 ----------

  /** 开一个配对位：返回给人念的短码。repeat 为真表示这是一次「重新配对」。 */
  openPairing(device, pub) {
    if (!validIdentity(device, pub)) return { error: '设备号或公钥不合法' }
    // 每台设备同时只保留一个待配对位，免得旧的短码被翻出来用
    for (const [code, v] of this.pairs) if (v.device === device && !v.claimedBy) this.pairs.delete(code)
    if (this.pairs.size >= PAIR_MAX) return { error: '待配对过多，稍后再试' }
    const code = randomCode()
    this.pairs.set(code, { device, pub, room: null, at: Date.now(), claimedBy: null })
    return { code, expiresAt: Date.now() + PAIR_TTL_MS }
  }

  /** 另一台报码：两边互相拿到对方的公钥与房间号（房间号由先到的一方生成）。 */
  claimPairing(code, device, pub, room) {
    const key = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const slot = this.pairs.get(key)
    if (!slot) return { error: '同步码不存在或已过期', status: 404 }
    if (Date.now() - slot.at > PAIR_TTL_MS) {
      this.pairs.delete(key)
      return { error: '同步码已过期', status: 404 }
    }
    if (!validIdentity(device, pub)) return { error: '设备号或公钥不合法', status: 400 }
    if (!validRoom(room)) return { error: '房间号非法', status: 400 }
    if (slot.device === device) return { error: '不能与自己配对', status: 400 }
    slot.claimedBy = { device, pub, room, at: Date.now() }
    slot.room = room
    return { peer: { device: slot.device, pub: slot.pub }, room }
  }

  /** 开码那一侧来问「谁认领了」。 */
  pairingState(code) {
    const slot = this.pairs.get(String(code ?? '').toUpperCase())
    if (!slot) return { error: '同步码不存在或已过期' }
    if (!slot.claimedBy) return { pending: true, expiresAt: slot.at + PAIR_TTL_MS }
    const { device, pub, room } = slot.claimedBy
    this.pairs.delete(String(code).toUpperCase())
    return { peer: { device, pub }, room }
  }

  // ---------- HTTP 中继 ----------

  room(roomId) {
    let r = this.rooms.get(roomId)
    if (!r) {
      if (this.rooms.size >= ROOM_MAX) {
        // 房间太多：把最久没动的那个请出去（它要么闲着，要么对面已经不在了）
        let oldest = null
        for (const [id, v] of this.rooms) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [id, v]
        if (oldest) this.rooms.delete(oldest[0])
      }
      r = { frames: [], bytes: 0, lastAt: Date.now(), waiters: [], seq: 0 }
      this.rooms.set(roomId, r)
    }
    return r
  }

  /**
   * 投递帧到房间。`resetBefore`（毫秒时间戳）可选：清掉早于它的旧帧再投。
   *
   * 邮箱按 seq 从 0 重放、取过的帧不删除 —— 上一轮会话的帧（包括握手帧）留在环形
   * 缓存里，下一轮会话从 0 取起会先读到它们，握手接上旧帧后密文计数对不上，两端
   * 一起报解密失败。客户端在每轮的第一帧上捎带 `resetBefore`（约 30 秒前），把
   * 上一轮的残留清走；刚投进来的对端握手帧（两端连接只差几秒）不受影响。
   */
  relaySend(roomId, frames, resetBefore = 0) {
    const r = this.room(roomId)
    const now = Date.now()
    if (resetBefore > 0) {
      const keep = r.frames.filter((f) => f.at >= resetBefore)
      if (keep.length !== r.frames.length) {
        r.frames = keep
        r.bytes = keep.reduce((n, f) => n + f.data.length, 0)
      }
    }
    for (const data of frames) {
      if (typeof data !== 'string' || data.length === 0 || data.length > CHUNK_MAX) {
        return { error: `帧太大或为空（上限 ${CHUNK_MAX} 字节的 base64）` }
      }
      r.seq += 1
      r.frames.push({ seq: r.seq, data, at: now })
      r.bytes += data.length
    }
    while (r.frames.length > ROOM_FRAMES_MAX || r.bytes > ROOM_BYTES_MAX) {
      const drop = r.frames.shift()
      r.bytes -= drop.data.length
    }
    r.lastAt = now
    const wake = r.waiters.splice(0)
    for (const fn of wake) fn()
    return { seq: r.seq, held: r.frames.length }
  }

  async relayPoll(roomId, after, waitMs) {
    const r = this.room(roomId)
    const take = () => r.frames.filter((f) => f.seq > after)
    let got = take()
    if (got.length === 0 && waitMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, POLL_MAX_WAIT_MS))
        r.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      got = take()
    }
    r.lastAt = Date.now()
    const first = r.frames.length > 0 ? r.frames[0].seq - 1 : after
    return {
      frames: got.map((f) => ({ seq: f.seq, data: f.data })),
      cursor: got.length > 0 ? got[got.length - 1].seq : after,
      // 环被挤掉了：告诉对方「你落后了」，让它按对象清单重新对齐（对象层幂等，重发无害）
      behind: after < first,
    }
  }

  // ---------- UDP 会合 ----------

  attachUdp(port = DEFAULT_UDP_PORT) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    sock.on('message', (buf, rinfo) => {
      const ip = rinfo.address
      if (!this.udpLimit.take(ip, 1)) return
      let msg
      try {
        msg = JSON.parse(buf.toString('utf8'))
      } catch {
        return
      }
      if (!msg || msg.t !== 'hello' || !validRoom(msg.room) || !validDevice(msg.device)) return
      const peers = this.udpPeers.get(msg.room) ?? {}
      peers[msg.device] = { ip, port: rinfo.port, at: Date.now() }
      this.udpPeers.set(msg.room, peers)
      const other = Object.entries(peers).find(
        ([device, p]) => device !== msg.device && Date.now() - p.at < PEER_FRESH_MS,
      )
      const reply = { t: 'you', ip, port: rinfo.port, room: msg.room }
      if (other) reply.peer = { device: other[0], ip: other[1].ip, port: other[1].port }
      sock.send(JSON.stringify(reply), rinfo.port, ip)
    })
    sock.on('error', (e) => this.log('sync-udp-error', { error: String(e?.message ?? e) }))
    sock.bind(port, () => this.log('sync-udp-listen', { port }))
    this.udp = sock
    return sock
  }

  // ---------- 路由 ----------

  async handle(req, res, parts, query) {
    const ip = clientIp(req)
    if (!this.limit.take(ip, 1)) return sendError(res, 429, 'rate_limited', '请求过于频繁')

    // POST /api/v1/sync/pair { device, pub }            开码
    if (req.method === 'POST' && parts[0] === 'pair' && parts.length === 1) {
      const body = await readJsonBody(req)
      const out = this.openPairing(String(body.device ?? ''), String(body.pub ?? ''))
      if (out.error) return sendError(res, 400, 'bad_request', out.error)
      this.log('sync-pair-open', { ip, device: body.device })
      return sendJson(res, 200, { ok: true, ...out })
    }

    // POST /api/v1/sync/pair/<code> { device, pub, room }  报码
    if (req.method === 'POST' && parts[0] === 'pair' && parts.length === 2) {
      const body = await readJsonBody(req)
      const out = this.claimPairing(parts[1], String(body.device ?? ''), String(body.pub ?? ''), String(body.room ?? ''))
      if (out.error) return sendError(res, out.status ?? 404, out.status === 400 ? 'bad_request' : 'pair_failed', out.error)
      this.log('sync-pair-claim', { ip, device: body.device })
      return sendJson(res, 200, { ok: true, ...out })
    }

    // GET /api/v1/sync/pair/<code>   开码侧轮询
    if (req.method === 'GET' && parts[0] === 'pair' && parts.length === 2) {
      const out = this.pairingState(parts[1])
      if (out.error) return sendError(res, 404, 'pair_failed', out.error)
      return sendJson(res, 200, { ok: true, ...out })
    }

    // POST /api/v1/sync/relay/<room> { frames: [b64], resetBefore?: ms }
    if (req.method === 'POST' && parts[0] === 'relay' && parts.length === 2) {
      const room = parts[1]
      if (!validRoom(room)) return sendError(res, 400, 'bad_request', '房间号非法')
      const body = await readJsonBody(req, BODY_MAX)
      const frames = Array.isArray(body.frames) ? body.frames : []
      const resetBefore = Number(body.resetBefore ?? 0) || 0
      if (frames.length === 0 && !resetBefore) return sendError(res, 400, 'bad_request', '没有要转发的帧')
      const out = this.relaySend(room, frames, resetBefore)
      if (out.error) return sendError(res, 400, 'bad_request', out.error)
      return sendJson(res, 200, { ok: true, ...out })
    }

    // GET /api/v1/sync/relay/<room>?after=<seq>&wait=<ms>
    if (req.method === 'GET' && parts[0] === 'relay' && parts.length === 2) {
      const room = parts[1]
      if (!validRoom(room)) return sendError(res, 400, 'bad_request', '房间号非法')
      const after = Number(query.after ?? 0) || 0
      const wait = Math.min(Number(query.wait ?? 0) || 0, POLL_MAX_WAIT_MS)
      const out = await this.relayPoll(room, after, wait)
      return sendJson(res, 200, { ok: true, time: nowIso(), ...out })
    }

    return sendError(res, 404, 'not_found', '未知同步接口')
  }
}

export const SYNC_UDP_PORT = DEFAULT_UDP_PORT
