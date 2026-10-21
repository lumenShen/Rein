/**
 * 会话工具集 · **动这一组**：改重量 / 次数、登记完成、跳过、加练、回退、休息、跳组。
 *
 * 这一支只碰「手上的这一组」与流程相位；动作编排（换 / 插 / 删 / 改组数）在 `arrange.ts` ——
 * 两个工具分开，模型才不会把「这场改成 5 组」误当成「现在再给我加一组」。
 *
 * 写操作直接落到会话 store —— 它和服务端之间只差一份「中断恢复用的快照」，
 * 状态机本身只活在前端（与沉浸页是同一个实例）。因此：
 *  - 不需要新增 IPC，也就不存在三处同步的问题；
 *  - 调整立刻反映在沉浸页上，store 的 action 内部会 touch() 落快照；
 *  - 幂等：赋值类（set_weight / set_reps）天然幂等，推进类（skip_set / add_set）都先
 *    校验前置条件与上限，重复调用不会叠加。这一点对移动端尤其重要 —— 切屏会让流式
 *    请求被系统掐断，模型重放同一条指令必须是安全的（写操作先落地、再回话）。
 *
 * 所有失败都收敛成 `{ updated: false, reason }` 而不是抛错：参数错让模型改参数，
 * 状态不满足（没在训练 / 相位不对 / 已经做过）让模型改说法，都不该让整轮对话崩掉。
 */

import { Type } from '@earendil-works/pi-ai'

import { defineTool } from '../types'
import { PHASE_LABEL, activeSession, changed, num, rejected } from './shared'

/** 单个动作最多加练几组（与界面一致的上限，防止模型批量 add_set 把课程撑爆） */
const MAX_EXTRA_SETS = 10

export const sessionAdjustTools = [
  defineTool({
    name: 'update_active_session',
    group: 'session',
    label: '调整进行中的这一场（只动这一组）',
    description:
      '**只改当前进行中的这一场，课程库里的课程模板一点不动**（要永久改课程用 upsert_plan；' +
      '要改这一场有哪些动作 / 各几组，用 edit_session_plan）。' +
      '现场执行：改重量 / 次数、登记完成、跳过、加练、回退、跳过热身、临时休息、跳至某组。' +
      '没有进行中的训练时返回 {updated:false,reason}，不会修改任何数据；相位不满足的操作同理，按 reason 提示用户。' +
      'action 取值：set_weight（改当前重量，需 weightKg）、set_reps（改当前组次数，需 reps）、' +
      'complete_set（登记完成当前组，可同时传 weightKg/reps 一并设置）、skip_set（跳过当前组，不计入完成）、' +
      'add_set（当前动作加练一组）、redo_last_set（撤销最近完成的一组并回到该组）、' +
      'skip_warmup（跳过剩余热身，直接进正式组）、start_temp_rest（临时休息，需 minutes）、' +
      'skip_rest（结束当前休息）、goto_set（跳到后面的某组，需 exerciseIndex/setNo，均为 1 起）。' +
      'exerciseIndex 是**这一场**里的第几个动作（1 起，见 get_active_session 的 exercises），不是动作库 id。',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('set_weight'),
          Type.Literal('set_reps'),
          Type.Literal('complete_set'),
          Type.Literal('skip_set'),
          Type.Literal('add_set'),
          Type.Literal('redo_last_set'),
          Type.Literal('skip_warmup'),
          Type.Literal('start_temp_rest'),
          Type.Literal('skip_rest'),
          Type.Literal('goto_set'),
        ],
        { description: '要执行的动作' },
      ),
      weightKg: Type.Optional(Type.Number({ description: '重量 kg（set_weight / complete_set 用）' })),
      reps: Type.Optional(Type.Number({ description: '每组次数（set_reps / complete_set 用）' })),
      minutes: Type.Optional(Type.Number({ description: '临时休息分钟数（start_temp_rest 用）' })),
      exerciseIndex: Type.Optional(
        Type.Number({ description: '这一场里的第几个动作，1 起（goto_set 用）' }),
      ),
      setNo: Type.Optional(Type.Number({ description: '第几组，1 起（goto_set 用）' })),
    }),
    async execute(args) {
      const s = await activeSession()
      if (!s) return rejected('当前没有进行中的训练课')

      const phase = PHASE_LABEL[s.phase] ?? s.phase
      const ex = s.currentEx

      try {
        switch (args.action) {
          case 'set_weight': {
            const kg = num(args.weightKg)
            if (kg == null) return rejected('set_weight 需要 weightKg（数字，单位 kg）')
            if (kg < 0 || kg > 999) return rejected(`weightKg 需在 0~999 之间，收到 ${kg}`)
            s.setWeight(kg)
            return changed(s, `当前重量已设为 ${s.weight} kg`)
          }

          case 'set_reps': {
            const r = num(args.reps)
            if (r == null) return rejected('set_reps 需要 reps（数字，每组次数）')
            if (r < 0 || r > 999) return rejected(`reps 需在 0~999 之间，收到 ${r}`)
            s.setReps(Math.round(r))
            return changed(s, `当前组次数已设为 ${s.reps ?? '未设置'}`)
          }

          case 'complete_set': {
            if (s.phase !== 'exercise') return rejected(`当前是「${phase}」，只有做组中才能登记完成`)
            // 允许「顺手改一下再登记」：模型常见的一句「这组 60kg 做了 8 次，记上」
            const kg = num(args.weightKg)
            if (kg != null) s.setWeight(kg)
            const r = num(args.reps)
            if (r != null) s.setReps(Math.round(r))
            const before = s.doneCount
            s.completeSet()
            if (s.doneCount === before) return rejected('这一组没能登记完成（相位已变化）')
            return changed(s, `已登记完成第 ${before + 1} 组`)
          }

          case 'skip_set': {
            if (!s.skipCurrentSet())
              return rejected(`当前是「${phase}」，没有可跳过的组（热身请用 skip_warmup）`)
            return changed(s, '已跳过当前组（不计入完成）')
          }

          case 'add_set': {
            if (!ex || s.phase === 'summary') return rejected(`当前是「${phase}」，不能加练`)
            const used = s.effSets(ex) - ex.sets
            if (used >= MAX_EXTRA_SETS) return rejected(`加练已达上限（${MAX_EXTRA_SETS} 组）`)
            s.addExtraSet()
            return changed(s, `${ex.name} 已加练一组（现在共 ${s.effSets(ex)} 组）`)
          }

          case 'redo_last_set': {
            if (!s.redoLastSet()) return rejected('没有可重做的组（还没有完成过任何正式组）')
            return changed(s, `已回到「${ex?.name ?? '上一组'}」第 ${s.setIndex} 组重做`)
          }

          case 'skip_warmup': {
            if (s.phase !== 'warmup') return rejected(`当前是「${phase}」，不在热身相位`)
            s.skipWarmup()
            return changed(s, '已跳过剩余热身，直接进入正式组')
          }

          case 'start_temp_rest': {
            const min = num(args.minutes)
            if (min == null) return rejected('start_temp_rest 需要 minutes（分钟数）')
            if (min <= 0 || min > 60) return rejected(`minutes 需在 0~60 之间，收到 ${min}`)
            if (!s.startTempRest(min))
              return rejected(`当前是「${phase}」，这个相位不能开计时休息（热身/休息中请直接用界面）`)
            return changed(s, `已开始 ${min} 分钟临时休息，结束后回到刚才的相位`)
          }

          case 'skip_rest': {
            if (s.phase !== 'rest') return rejected(`当前是「${phase}」，不在休息相位`)
            s.skipRest()
            return changed(s, '已结束休息')
          }

          case 'goto_set': {
            const plan = s.plan
            if (!plan) return rejected('会话里没有课程数据')
            const ei = num(args.exerciseIndex)
            const sn = num(args.setNo)
            if (ei == null || sn == null)
              return rejected('goto_set 需要 exerciseIndex 与 setNo（都从 1 开始）')
            if (!Number.isInteger(ei) || ei < 1 || ei > plan.exercises.length)
              return rejected(`exerciseIndex 需在 1~${plan.exercises.length} 之间，收到 ${ei}`)
            const target = plan.exercises[ei - 1]!
            if (!Number.isInteger(sn) || sn < 1 || sn > s.effSets(target))
              return rejected(`setNo 需在 1~${s.effSets(target)} 之间，收到 ${sn}`)
            if (!s.skipToSet(ei - 1, sn))
              return rejected('只能跳到更靠后的未做组（不能回跳已完成的组）')
            return changed(s, `已跳至「${target.name}」第 ${sn} 组，中间未做的组记为跳过`)
          }

          default:
            return rejected('未知的 action')
        }
      } catch (e) {
        // 兜底：任何意外都收敛成结构化失败，绝不让一轮对话因为一次调整而崩掉
        return rejected(`调整失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }),
]
