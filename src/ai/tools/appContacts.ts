/**
 * 通讯录工具（`appContacts`，Android ContactsContract）。
 *
 * 能力边界（plan §1.2 / §13.1）：
 * - 读：按姓名/号码/邮箱搜索（≤50 人，每人列表最多 5 号 + 5 邮箱）、按 contactId 读单条；
 * - 写：一次一个联系人；新建/修改/删除逐个弹确认；
 * - `update` 只改给定字段，给了 phones/emails 就整组替换；云端 raw contact 可能改不动（返回 native_error）；
 * - `delete` 删除该聚合联系人的全部 raw contact，会同步到已登录账户，无法恢复。
 */

import { Type } from '@earendil-works/pi-ai'

import {
  assertAppReady,
  callConnectedApp,
  callConnectedAppWrite,
  ConnectedAppToolError,
  withMeta,
} from './connectedApps'
import { defineTool, type AppTool } from './types'

const APP = 'contacts'
type JsonObject = Record<string, unknown>

interface PhoneEntry {
  number: string
  type?: string
}

interface EmailEntry {
  address: string
  type?: string
}

interface Contact {
  contactId: string
  displayName: string
  phones: PhoneEntry[]
  emails: EmailEntry[]
}

const PhoneParam = Type.Object({
  number: Type.String({ minLength: 1, maxLength: 40, description: '电话号码（≤40 字）' }),
  type: Type.Optional(
    Type.String({ maxLength: 16, description: '类型：mobile / home / work / other' }),
  ),
})

const EmailParam = Type.Object({
  address: Type.String({ minLength: 1, maxLength: 120, description: '邮箱地址（≤120 字）' }),
  type: Type.Optional(Type.String({ maxLength: 16, description: '类型：home / work / other' })),
})

async function getContact(contactId: string): Promise<Contact> {
  const { data } = await callConnectedApp<{ contact?: Contact | null }>(APP, 'get_contact', {
    contactId,
  })
  if (!data.contact) {
    throw new ConnectedAppToolError(
      'connected_app_not_found',
      `没有找到这个联系人（contactId=${contactId}）`,
    )
  }
  return data.contact
}

function formatPhones(phones: PhoneEntry[] | undefined): string {
  return (phones ?? [])
    .map((p) => (p.type ? `${p.number}（${p.type}）` : p.number))
    .join('、')
}

function formatEmails(emails: EmailEntry[] | undefined): string {
  return (emails ?? [])
    .map((e) => (e.type ? `${e.address}（${e.type}）` : e.address))
    .join('、')
}

export const contactsTools: AppTool[] = [
  defineTool({
    name: 'search_contacts',
    group: 'appContacts',
    label: '搜索联系人',
    description:
      '只读：按姓名/号码/邮箱模糊搜索联系人（≤50 人）；列表里每人最多 5 个号码 + 5 个邮箱。隐私敏感，请用具体查询词，不要一次性导出全部通讯录。',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 64, description: '姓名/号码/邮箱片段' }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: '最多返回多少人，默认 20' }),
      ),
    }),
    async execute(args) {
      await assertAppReady(APP)
      return withMeta(
        await callConnectedApp<JsonObject>(APP, 'search_contacts', {
          query: args.query,
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      )
    },
  }),

  defineTool({
    name: 'get_contact',
    group: 'appContacts',
    label: '查看联系人',
    description: '只读：按 contactId 读取单个联系人（号码/邮箱各 ≤10 个）。',
    parameters: Type.Object({
      contactId: Type.String({ minLength: 1, maxLength: 64, description: '联系人 id' }),
    }),
    async execute(args) {
      await assertAppReady(APP)
      return withMeta(await callConnectedApp<JsonObject>(APP, 'get_contact', args))
    },
  }),

  defineTool({
    name: 'create_contact',
    group: 'appContacts',
    label: '新建联系人',
    description:
      '写：在本机账户新建一个联系人（一次一个）。name 必填 ≤200；phones/emails 各 ≤10 项。执行前会弹一次确认；返回新 contactId。',
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 200, description: '显示姓名（≤200 字）' }),
      phones: Type.Optional(
        Type.Array(PhoneParam, { maxItems: 10, description: '电话号码（≤10 个）' }),
      ),
      emails: Type.Optional(
        Type.Array(EmailParam, { maxItems: 10, description: '邮箱（≤10 个）' }),
      ),
    }),
    dangerous: true,
    async execute(args) {
      await assertAppReady(APP, { write: true })
      const lines = ['动作：新建联系人', `姓名：${args.name}`]
      if (args.phones?.length) lines.push(`电话：${formatPhones(args.phones)}`)
      if (args.emails?.length) lines.push(`邮箱：${formatEmails(args.emails)}`)
      return withMeta(
        await callConnectedAppWrite<JsonObject>(APP, 'create_contact', args, {
          title: '新建联系人',
          body: lines.join('\n'),
          summary: `create_contact phones=${args.phones?.length ?? 0} emails=${args.emails?.length ?? 0}`,
        }),
      )
    },
  }),

  defineTool({
    name: 'update_contact',
    group: 'appContacts',
    label: '修改联系人',
    description:
      '写：只修改给定字段；给了 phones/emails 就整组替换。只改本机 raw contact，云端账户可能返回 native_error。执行前会弹一次确认。',
    parameters: Type.Object({
      contactId: Type.String({ minLength: 1, maxLength: 64, description: '联系人 id' }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      phones: Type.Optional(Type.Array(PhoneParam, { maxItems: 10, description: '整组替换（≤10 个）' })),
      emails: Type.Optional(Type.Array(EmailParam, { maxItems: 10, description: '整组替换（≤10 个）' })),
    }),
    dangerous: true,
    async execute(args) {
      await assertAppReady(APP, { write: true })
      const current = await getContact(args.contactId)
      const changes: string[] = []
      if (args.name !== undefined) changes.push(`姓名 → ${args.name}`)
      if (args.phones !== undefined) {
        changes.push(`电话 → ${formatPhones(args.phones) || '（清空）'}`)
      }
      if (args.emails !== undefined) {
        changes.push(`邮箱 → ${formatEmails(args.emails) || '（清空）'}`)
      }
      if (changes.length === 0) {
        throw new ConnectedAppToolError(
          'connected_app_bad_request',
          '至少提供一个要修改的字段（name/phones/emails）',
        )
      }
      const lines = [
        '动作：修改联系人',
        `联系人：${current.displayName || '（无姓名）'}（#${current.contactId}）`,
        '修改：',
        ...changes.map((line) => `- ${line}`),
      ]
      return withMeta(
        await callConnectedAppWrite<JsonObject>(APP, 'update_contact', args, {
          title: '修改联系人',
          body: lines.join('\n'),
          summary: `update_contact contact=${current.contactId} fields=${changes.length}`,
        }),
      )
    },
  }),

  defineTool({
    name: 'delete_contact',
    group: 'appContacts',
    label: '删除联系人',
    description:
      '写：删除该联系人的全部 raw contact，会同步到已登录账户且无法恢复。执行前会弹一次确认。',
    parameters: Type.Object({
      contactId: Type.String({ minLength: 1, maxLength: 64, description: '要删除的联系人 id' }),
    }),
    dangerous: true,
    async execute(args) {
      await assertAppReady(APP, { write: true })
      const current = await getContact(args.contactId)
      const lines = [
        '动作：删除联系人',
        `联系人：${current.displayName || '（无姓名）'}（#${current.contactId}）`,
        current.phones.length ? `电话：${formatPhones(current.phones)}` : '',
        '',
        '警告：会删除这个联系人的全部 raw contact，并同步到已登录账户；无法恢复。',
      ].filter((line) => line !== '')
      return withMeta(
        await callConnectedAppWrite<JsonObject>(
          APP,
          'delete_contact',
          { contactId: args.contactId },
          {
            title: '删除联系人',
            body: lines.join('\n'),
            danger: true,
            summary: `delete_contact contact=${current.contactId}`,
          },
        ),
      )
    },
  }),
]

export const tools = contactsTools
export const appContactsTools = contactsTools
