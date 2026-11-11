/**
 * 闹钟和计时器工具（`appAlarm`，Android）。
 *
 * 能力边界（plan §1.2 / §13.1 / §13.2）：
 * - 没有公开 API 列出全部闹钟：只能读「下一个」+ 设置/取消；
 * - 设置/取消都通过系统时钟应用的 intent（AlarmClock.ACTION_*），结果只代表 `dispatched`，
 *   不保证时钟应用真的设置成功；`skipUi` 默认 true；
 * - `set_alarm`/`set_timer` 是写（需 `writeAllowed` + 审计）但按需求不弹确认；
 *   `dismiss_alarm`/`dismiss_timer` 写并弹一次确认（`dangerous` 只是 UI 红标）。
 */

import { Type } from '@earendil-works/pi-ai'

import {
  assertAppReady,
  callConnectedApp,
  callConnectedAppWrite,
  withMeta,
} from './connectedApps'
import { defineTool, type AppTool } from './types'

const APP = 'alarm'
type JsonObject = Record<string, unknown>

const ModeParam = Type.Union([Type.Literal('next'), Type.Literal('all')], {
  description: 'next = 下一个，all = 全部',
})

export const alarmTools: AppTool[] = [
  defineTool({
    name: 'alarm_next',
    group: 'appAlarm',
    label: '查看下一个闹钟',
    description:
      '只读：返回系统「下一个闹钟」的时间（at）与来源包名。Android 没有公开 API 列出全部闹钟；没有闹钟时 at 为 null。',
    parameters: Type.Object({}),
    async execute() {
      await assertAppReady(APP)
      return withMeta(await callConnectedApp<JsonObject>(APP, 'alarm_next'))
    },
  }),

  defineTool({
    name: 'set_alarm',
    group: 'appAlarm',
    label: '设置闹钟',
    description:
      '写：通过系统时钟应用设置一个闹钟。hour 0..23、minute 0..59、label ≤64 字、days 1=周一..7=周日；skipUi 默认 true。需要用户允许写入；结果只代表已向系统时钟发出 intent，不保证时钟应用真的设置成功。',
    parameters: Type.Object({
      hour: Type.Integer({ minimum: 0, maximum: 23, description: '小时 0..23' }),
      minute: Type.Integer({ minimum: 0, maximum: 59, description: '分钟 0..59' }),
      label: Type.Optional(Type.String({ maxLength: 64, description: '闹钟标签（≤64 字）' })),
      days: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
          maxItems: 7,
          description: '重复日：1=周一 … 7=周日；不传 = 只响一次',
        }),
      ),
      vibrate: Type.Optional(Type.Boolean({ description: '是否震动，默认 true' })),
      skipUi: Type.Optional(
        Type.Boolean({ description: '是否跳过时钟应用的确认界面，默认 true（部分 OEM 会忽略）' }),
      ),
    }),
    async execute(args) {
      await assertAppReady(APP, { write: true })
      return withMeta(await callConnectedApp<JsonObject>(APP, 'set_alarm', args))
    },
  }),

  defineTool({
    name: 'set_timer',
    group: 'appAlarm',
    label: '设置倒计时',
    description:
      '写：通过系统时钟应用设置一个倒计时。seconds 1..86400、label ≤64 字；skipUi 默认 true。需要用户允许写入；结果只代表已发出 intent，不保证时钟应用真的开始计时。',
    parameters: Type.Object({
      seconds: Type.Integer({ minimum: 1, maximum: 86_400, description: '倒计时秒数 1..86400' }),
      label: Type.Optional(Type.String({ maxLength: 64, description: '计时器标签（≤64 字）' })),
      skipUi: Type.Optional(
        Type.Boolean({ description: '是否跳过时钟应用的确认界面，默认 true（部分 OEM 会忽略）' }),
      ),
    }),
    async execute(args) {
      await assertAppReady(APP, { write: true })
      return withMeta(await callConnectedApp<JsonObject>(APP, 'set_timer', args))
    },
  }),

  defineTool({
    name: 'dismiss_alarm',
    group: 'appAlarm',
    label: '取消闹钟',
    description:
      '写：通过系统时钟应用取消「下一个」或「全部」闹钟（AlarmClock.ACTION_DISMISS_ALARM，Android 6.0+）。执行前会弹一次确认；结果代表已发出 intent。',
    parameters: Type.Object({ mode: ModeParam }),
    dangerous: true,
    async execute(args) {
      const mode = args.mode === 'all' ? 'all' : 'next'
      return withMeta(
        await callConnectedAppWrite<JsonObject>(
          APP,
          'dismiss_alarm',
          { mode },
          {
            title: '取消闹钟',
            body: `将通过系统时钟应用取消${mode === 'all' ? '全部闹钟' : '下一个闹钟'}。该操作会立即生效，请确认。`,
            danger: true,
            summary: `dismiss_alarm mode=${mode}`,
          },
        ),
      )
    },
  }),

  defineTool({
    name: 'dismiss_timer',
    group: 'appAlarm',
    label: '取消计时器',
    description:
      '写：通过系统时钟应用取消「下一个」或「全部」计时器（ACTION_DISMISS_TIMER，仅 Android 8.0+，低版本返回不支持并提示去时钟应用取消）。执行前会弹一次确认。',
    parameters: Type.Object({ mode: ModeParam }),
    dangerous: true,
    async execute(args) {
      const mode = args.mode === 'all' ? 'all' : 'next'
      return withMeta(
        await callConnectedAppWrite<JsonObject>(
          APP,
          'dismiss_timer',
          { mode },
          {
            title: '取消计时器',
            body: `将通过系统时钟应用取消${mode === 'all' ? '全部计时器' : '下一个计时器'}。该操作会立即生效，请确认。`,
            danger: true,
            summary: `dismiss_timer mode=${mode}`,
          },
        ),
      )
    },
  }),
]

/** registry 使用的别名（与 ask 约定的 `tools` 同一份数组）。 */
export const tools = alarmTools
export const appAlarmTools = alarmTools
