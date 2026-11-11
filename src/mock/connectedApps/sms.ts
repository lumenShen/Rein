/**
 * 短信 · mock 样例（读取 + 发送；不标已读、不删除）。
 *
 * 与 Kotlin `SmsOps` 对齐：threads ≤50、messages ≤100（threadId/address 至少一个）、
 * search ≤50、body 列表截断 500；发送单收件人、body 1..2000，返回 `submitted + parts`，
 * 不承诺送达；不做已读/删除/MMS。
 */
import {
  clampInt,
  fail,
  ok,
  sampleIso,
  text,
  type MockAppHandler,
  type MockPayload,
} from './shared'

interface MockMessage {
  id: string
  threadId: string
  address: string
  body: string
  type: 'inbox' | 'sent'
  at: string
}

const MAX_BODY_LIST = 500
const MAX_BODY_SEND = 2_000
const MAX_ADDRESS = 40

const messages: MockMessage[] = [
  {
    id: '1',
    threadId: '10',
    address: '10086',
    body: '您的流量套餐本月剩余 3.2GB。',
    type: 'inbox',
    at: sampleIso(-60 * 60 * 1000),
  },
  {
    id: '2',
    threadId: '10',
    address: '10086',
    body: '查询流量',
    type: 'sent',
    at: sampleIso(-2 * 60 * 60 * 1000),
  },
]

let smsSeq = messages.length

function listView(message: MockMessage) {
  return {
    id: message.id,
    threadId: message.threadId,
    address: message.address,
    body: message.body.slice(0, MAX_BODY_LIST),
    type: message.type,
    at: message.at,
  }
}

export const smsMock: MockAppHandler = (app, method, payload: MockPayload) => {
  switch (method) {
    case 'list_sms_threads': {
      const limit = clampInt(payload.limit, 1, 50, 20)
      const byThread = new Map<string, MockMessage>()
      for (const message of messages) {
        const prev = byThread.get(message.threadId)
        if (!prev || prev.at < message.at) byThread.set(message.threadId, message)
      }
      const items = [...byThread.values()]
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, limit)
        .map((message) => ({
          threadId: message.threadId,
          address: message.address,
          snippet: message.body.slice(0, 200),
          at: message.at,
        }))
      return ok(app, method, { items, count: items.length })
    }

    case 'list_sms_messages': {
      const threadId = text(payload.threadId).trim()
      const address = text(payload.address).trim()
      if (!threadId && !address) {
        return fail(app, method, 'connected_app_bad_request', 'threadId 或 address 至少提供一个')
      }
      const limit = clampInt(payload.limit, 1, 100, 30)
      const items = messages
        .filter((message) => (!threadId || message.threadId === threadId) && (!address || message.address === address))
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, limit)
        .map(listView)
      return ok(app, method, { items, count: items.length })
    }

    case 'search_sms': {
      const query = text(payload.query).trim().toLowerCase()
      if (!query) {
        return fail(app, method, 'connected_app_bad_request', 'query 必填')
      }
      const limit = clampInt(payload.limit, 1, 50, 20)
      const items = messages
        .filter(
          (message) =>
            message.body.toLowerCase().includes(query) ||
            message.address.toLowerCase().includes(query),
        )
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, limit)
        .map(listView)
      return ok(app, method, { items, count: items.length })
    }

    case 'send_sms': {
      const to = text(payload.to).trim()
      const body = text(payload.body)
      if (!to || to.length > MAX_ADDRESS || to.includes(',') || to.includes(';')) {
        return fail(app, method, 'connected_app_bad_request', 'to 必填、单个收件人且不能超过 40 字')
      }
      if (!body.trim() || body.length > MAX_BODY_SEND) {
        return fail(app, method, 'connected_app_bad_request', 'body 必填且不能超过 2000 字')
      }
      const id = String(++smsSeq)
      messages.push({
        id,
        threadId: `sent-${id}`,
        address: to,
        body,
        type: 'sent',
        at: sampleIso(),
      })
      // 与 SmsManager.divideMessage 的语义接近：按 70 字一条估算（CJK）。
      const parts = Math.max(1, Math.ceil(body.length / 70))
      return ok(app, method, { submitted: true, parts, to, messageId: id })
    }

    default:
      return fail(app, method, 'connected_app_unknown_method', `短信不支持方法 ${method}`)
  }
}
