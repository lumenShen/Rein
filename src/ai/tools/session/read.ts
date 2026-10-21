/**
 * 会话工具集 · **看**：这一场跑到哪了、热身重量是怎么算出来的。
 *
 * 只读，永远不改任何状态 —— 用户可能在耳机里问「现在该多少」，模型需要先看清现场
 * 再决定要不要动它。
 */

import { Type } from '@earendil-works/pi-ai'

import {
  WARMUP_LIGHT_KG,
  WARMUP_MIN_KG,
  WARMUP_RAMP_MIN_KG,
  WARMUP_RELATIVE_MIN_RATIO,
  WARMUP_RELATIVE_RAMP_RATIO,
  WARMUP_RULE_TEXT,
  WARMUP_STEP_KG,
  warmupPlan,
} from '@/utils/warmup'
import { defineTool } from '../types'
import { activeSession, describeSession, num } from './shared'

export const sessionReadTools = [
  defineTool({
    name: 'get_active_session',
    group: 'session',
    label: '查看进行中训练',
    description:
      '查看当前进行中的训练课：课程名、相位（热身/做组/休息）、已进行秒数、当前动作与第几组、今日推荐重量、工作重量、热身处方与剩余热身组数，以及**这一场的完整动作清单**（每个动作的下标 / 组数 / 已完成组数，编排类操作用它挑 exerciseIndex）。没有进行中训练返回 null。',
    parameters: Type.Object({}),
    async execute() {
      const s = await activeSession()
      if (!s) return null
      return describeSession(s)
    },
  }),

  defineTool({
    name: 'get_warmup_rule',
    group: 'session',
    label: '查看热身换算规则',
    description:
      '查看激活热身重量的科学换算规则（阈值 / 百分比 / 取整步进），可选传一个正式组重量做试算，返回该重量下的热身处方。用户问「热身为什么是这个重量」「热身怎么算的」时用它。',
    parameters: Type.Object({
      workingWeightKg: Type.Optional(
        Type.Number({ description: '要试算的正式组重量（kg）；不传则只返回规则' }),
      ),
      e1rmKg: Type.Optional(
        Type.Number({
          description:
            '该动作当天的估算极限（e1RM，kg）。给了就按相对强度换算（百分比乘在极限上）；不传则回落按工作重量的绝对阈值',
        }),
      ),
    }),
    async execute(args) {
      const kg = num(args.workingWeightKg)
      const plan = kg != null ? warmupPlan(kg, { e1rm: num(args.e1rmKg) }) : null
      return {
        rule: WARMUP_RULE_TEXT,
        thresholds: {
          rampFromKg: WARMUP_RAMP_MIN_KG,
          oneSetFromKg: WARMUP_MIN_KG,
          plateStepKg: WARMUP_STEP_KG,
          lightSkipKg: WARMUP_LIGHT_KG,
          rampRatioOfE1rm: WARMUP_RELATIVE_RAMP_RATIO,
          oneSetRatioOfE1rm: WARMUP_RELATIVE_MIN_RATIO,
        },
        basis:
          '热身强度取工作组的 40%–75% 1RM：低于 40% 只局部升温、对表现无增益；高于 ~80% 开始累积疲劳、反而压低正式组输出。注意百分比乘的是**当天的估算极限（e1RM）**而不是工作重量本身 —— 工作重量只占极限一半多时，按工作重量取百分比会落进「低于 40%」那一档，等于白占一组时间。',
        prescribed: plan ? plan.sets.map((d) => ({ weightKg: d.weightKg, reps: d.reps })) : null,
        basisUsed: plan
          ? plan.usedBaseline
            ? '按当天估算极限（e1RM）换算'
            : '没有历史估不出极限，回落按工作重量的绝对阈值'
          : null,
        note:
          '运行时热身重量按当天推荐重量实时换算；推荐重量变化（加档 / 降载 / 改今日自评）会立刻改变热身，不必改课程。',
      }
    },
  }),
]
