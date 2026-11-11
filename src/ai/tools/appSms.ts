/**
 * 短信工具（`appSms`，Android Telephony.Sms + SmsManager）。
 *
 * 能力边界（plan §1.2 / §13.2）：
 * - 读：会话列表（≤50）、按 threadId/address 的消息（≤100，body ≤500）、正文/号码搜索（≤50）；
 * - 写：只能发送（单收件人、body 1..2000），执行前弹确认；返回 `submitted + parts`，**不承诺送达**；
 * - **不做**标记已读、删除会话、MMS、SIM 选择、送达回执。
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

const APP = 'sms'
type JsonObject = Record<string, unknown>

export const smsTools: AppTool[] = [
  defineTool({
    name: 'list_sms_threads',
    group: 'appSms',
    label: '查看短信会话',
    description:
      '只读：按会话列出最近的短信（threadId、号码、snippet ≤200 字、时间），最多 50 个会话。不会标记已读。',
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: '最多返回多少个会话，默认 20' }),
      ),
    }),
    async execute(args) {
      await assertAppReady(APP)
      return withMeta(
        await callConnectedApp<JsonObject>(APP, 'list_sms_threads', {
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      )
    },
  }),

  defineTool({
    name: 'list_sms_messages',
    group: 'appSms',
    label: '查看短信消息',
    description:
      '只读：按 threadId 或 address 读取消息（至少提供一个），最多 100 条，body 截断到 500 字。只返回收件箱/已发送，不改变已读状态。',
    parameters: Type.Object({
      threadId: Type.Optional(
        Type.String({ maxLength: 64, description: '会话 id（来自 list_sms_threads）' }),
      ),
      address: Type.Optional(
        Type.String({ maxLength: 40, description: '对方号码/短号（与 threadId 二选一）' }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: '最多返回多少条，默认 30' }),
      ),
    }),
    async execute(args) {
      const threadId = args.threadId?.trim()
      const address = args.address?.trim()
      if (!threadId && !address) {
        throw new ConnectedAppToolError(
          'connected_app_bad_request',
          'threadId 或 address 至少提供一个',
        )
      }
      await assertAppReady(APP)
      return withMeta(
        await callConnectedApp<JsonObject>(APP, 'list_sms_messages', {
          ...(threadId ? { threadId } : {}),
          ...(address ? { address } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      )
    },
  }),

  defineTool({
    name: 'search_sms',
    group: 'appSms',
    label: '搜索短信',
    description:
      '只读：按正文/号码片段搜索短信（≤50 条，body 截断到 500 字）。不改已读、不删除。隐私敏感，请用具体查询词。',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 64, description: '正文或号码片段' }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: '最多返回多少条，默认 20' }),
      ),
    }),
    async execute(args) {
      await assertAppReady(APP)
      return withMeta(
        await callConnectedApp<JsonObject>(APP, 'search_sms', {
          query: args.query,
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      )
    },
  }),

  defineTool({
    name: 'send_sms',
    group: 'appSms',
    label: '发送短信',
    description:
      '写：向单个收件人发送短信（to 1..40 字、body 1..2000 字）。执行前会弹确认；可能产生短信费用。返回 submitted + parts，只表示已提交给系统，**不承诺送达**；不做已读/删除。',
    parameters: Type.Object({
      to: Type.String({ minLength: 1, maxLength: 40, description: '收件人号码（单个）' }),
      body: Type.String({ minLength: 1, maxLength: 2_000, description: '短信正文（≤2000 字）' }),
    }),
    dangerous: true,
    async execute(args) {
      const to = args.to.trim()
      const body = args.body
      if (!to || !body.trim()) {
        throw new ConnectedAppToolError(
          'connected_app_bad_request',
          'to 与 body 都不能为空',
        )
      }
      const preview = body.length > 200 ? `${body.slice(0, 200)}…` : body
      return withMeta(
        await callConnectedAppWrite<JsonObject>(
          APP,
          'send_sms',
          { to, body },
          {
            title: '发送短信',
            body: [
              `收件人：${to}`,
              `正文（前 200 字）：${preview}`,
              '',
              '可能产生短信费用；发送后无法撤回。只承诺已提交给系统，不保证送达。',
            ].join('\n'),
            danger: true,
            summary: `send_sms chars=${body.length}`,
          },
        ),
      )
    },
  }),
]

export const tools = smsTools
export const appSmsTools = smsTools
