/**
 * 通讯录 · mock 样例（读 + 写会改动内存联系人表）。
 *
 * 与 Kotlin `ContactsOps` 对齐：一次一个联系人；列表每人 ≤5 号 + ≤5 邮箱、
 * get 各 ≤10；不存在 → `connected_app_not_found`；update 只改给定字段、
 * phones/emails 整组替换；delete 删除该联系人的全部 raw contact。
 */
import {
  clampInt,
  fail,
  ok,
  text,
  type MockAppHandler,
  type MockPayload,
} from './shared'

interface MockContact {
  contactId: string
  name: string
  phones: { number: string; type: string }[]
  emails: { address: string; type: string }[]
}

const MAX_LIST_PHONES = 5
const MAX_LIST_EMAILS = 5
const MAX_DETAIL_PHONES = 10
const MAX_DETAIL_EMAILS = 10

const contacts: MockContact[] = [
  {
    contactId: '1',
    name: '张三',
    phones: [{ number: '13800000001', type: 'mobile' }],
    emails: [{ address: 'zhangsan@example.com', type: 'home' }],
  },
  {
    contactId: '2',
    name: '李四',
    phones: [{ number: '13800000002', type: 'mobile' }],
    emails: [],
  },
]

let contactSeq = contacts.length

function readPhones(v: unknown): { number: string; type: string }[] | string {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return 'phones 必须是数组'
  if (v.length > 10) return '号码最多 10 个'
  const out: { number: string; type: string }[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') return 'phones 每项必须是对象'
    const number = text((item as Record<string, unknown>).number).trim()
    if (!number || number.length > 40) return '号码必填且不能超过 40 字'
    out.push({
      number,
      type: text((item as Record<string, unknown>).type, 'mobile') || 'mobile',
    })
  }
  return out
}

function readEmails(v: unknown): { address: string; type: string }[] | string {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return 'emails 必须是数组'
  if (v.length > 10) return '邮箱最多 10 个'
  const out: { address: string; type: string }[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') return 'emails 每项必须是对象'
    const address = text((item as Record<string, unknown>).address).trim()
    if (!address || address.length > 120) return '邮箱必填且不能超过 120 字'
    out.push({
      address,
      type: text((item as Record<string, unknown>).type, 'home') || 'home',
    })
  }
  return out
}

function findIndex(contactId: unknown): number {
  return contacts.findIndex((contact) => contact.contactId === text(contactId).trim())
}

function view(contact: MockContact, maxPhones: number, maxEmails: number): MockContact {
  return {
    contactId: contact.contactId,
    name: contact.name,
    phones: contact.phones.slice(0, maxPhones),
    emails: contact.emails.slice(0, maxEmails),
  }
}

export const contactsMock: MockAppHandler = (app, method, payload: MockPayload) => {
  switch (method) {
    case 'search_contacts': {
      const query = text(payload.query).trim().toLowerCase()
      if (!query) {
        return fail(app, method, 'connected_app_bad_request', 'query 必填')
      }
      const limit = clampInt(payload.limit, 1, 50, 20)
      const items = contacts
        .filter(
          (contact) =>
            contact.name.toLowerCase().includes(query) ||
            contact.phones.some((phone) => phone.number.includes(query)) ||
            contact.emails.some((email) => email.address.toLowerCase().includes(query)),
        )
        .slice(0, limit)
        .map((contact) => view(contact, MAX_LIST_PHONES, MAX_LIST_EMAILS))
      return ok(app, method, { items, count: items.length })
    }

    case 'get_contact': {
      const index = findIndex(payload.contactId)
      if (index < 0) {
        return fail(app, method, 'connected_app_not_found', '没有找到这个联系人')
      }
      return ok(app, method, {
        contact: view(contacts[index], MAX_DETAIL_PHONES, MAX_DETAIL_EMAILS),
      })
    }

    case 'create_contact': {
      const name = text(payload.name).trim()
      if (!name || name.length > 200) {
        return fail(app, method, 'connected_app_bad_request', 'name 必填且不能超过 200 字')
      }
      const phones = readPhones(payload.phones)
      if (typeof phones === 'string') {
        return fail(app, method, 'connected_app_bad_request', phones)
      }
      const emails = readEmails(payload.emails)
      if (typeof emails === 'string') {
        return fail(app, method, 'connected_app_bad_request', emails)
      }
      const contact: MockContact = {
        contactId: String(++contactSeq),
        name,
        phones,
        emails,
      }
      contacts.push(contact)
      return ok(app, method, {
        contactId: contact.contactId,
        contact: view(contact, MAX_DETAIL_PHONES, MAX_DETAIL_EMAILS),
      })
    }

    case 'update_contact': {
      const index = findIndex(payload.contactId)
      if (index < 0) {
        return fail(app, method, 'connected_app_not_found', '没有找到这个联系人')
      }
      const contact = contacts[index]
      let changed = false
      if (payload.name !== undefined) {
        const name = text(payload.name).trim()
        if (!name || name.length > 200) {
          return fail(app, method, 'connected_app_bad_request', 'name 必填且不能超过 200 字')
        }
        contact.name = name
        changed = true
      }
      if (payload.phones !== undefined) {
        const phones = readPhones(payload.phones)
        if (typeof phones === 'string') {
          return fail(app, method, 'connected_app_bad_request', phones)
        }
        contact.phones = phones
        changed = true
      }
      if (payload.emails !== undefined) {
        const emails = readEmails(payload.emails)
        if (typeof emails === 'string') {
          return fail(app, method, 'connected_app_bad_request', emails)
        }
        contact.emails = emails
        changed = true
      }
      if (!changed) {
        return fail(app, method, 'connected_app_bad_request', '至少提供一个要修改的字段')
      }
      return ok(app, method, {
        updated: true,
        contact: view(contact, MAX_DETAIL_PHONES, MAX_DETAIL_EMAILS),
      })
    }

    case 'delete_contact': {
      const index = findIndex(payload.contactId)
      if (index < 0) {
        return fail(app, method, 'connected_app_not_found', '没有找到这个联系人')
      }
      const [removed] = contacts.splice(index, 1)
      return ok(app, method, { deleted: true, contactId: removed.contactId })
    }

    default:
      return fail(app, method, 'connected_app_unknown_method', `通讯录不支持方法 ${method}`)
  }
}
