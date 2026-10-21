/**
 * 会话工具集 · **改这一场的结构**：换动作、插入动作、删除动作、改处方。
 *
 * 与 `update_active_session`（改这一组 / 推进流程）分开的理由：这两个请求在中文里
 * 长得几乎一样 ——「再加一组」是加练，「这场改成 5 组」是改处方；混在一个 action 枚举里，
 * 模型一定会选错，而两者对进度的影响完全不同（一个加组位、一个改组数）。
 *
 * 与 `upsert_plan`（课程库）分开的理由：作用域不同。这里的一切只写内存里的这一场
 * （随快照落盘做中断恢复），课程库一个字不动；用户说「以后都这么练」才走 `upsert_plan`。
 *
 * 智能推荐的口径提醒（写进 description，模型复述时不会说错）：
 * 换动作会**连同处方一起换**成新动作的库内组数 / 次数 / 休息，并把该动作的今日建议
 * 与上次重量异步补齐 —— 沿用旧动作的处方会让建议引擎的「做满即加档」判据失真。
 */

import { Type } from '@earendil-works/pi-ai'

import { useExerciseLibStore } from '@/stores/exerciseLib'
import { defineTool } from '../types'
import { activeSession, changed, num, rejected } from './shared'

/** 单动作组数上限（与 store 的 MAX_SESSION_SETS 一致） */
const MAX_SETS = 20

export const sessionArrangeTools = [
  defineTool({
    name: 'edit_session_plan',
    group: 'session',
    label: '改这一场的动作编排（不写回课程库）',
    description:
      '**只改当前进行中的这一场**：这一场有哪些动作、各几组几次、顺序里插哪一个。' +
      '课程库里的课程模板一点不动（要永久改课程用 upsert_plan，判据是用户说「今天/这次」还是「以后/这门课」）。' +
      '没有进行中的训练、或参数/状态不满足时返回 {updated:false,reason}，不改任何数据。' +
      'action 取值：' +
      'insert_exercise（在这一场插入一个动作库里的动作，需 exerciseId；position 是插完它排第几个，缺省追加到末尾，只能插在当前动作之后；sets/reps 可一并指定，缺省用动作库默认处方）、' +
      'remove_exercise（删掉这一场还没开始做、也没完成过任何一组的一个动作，需 exerciseIndex；当前正在做的不能删）、' +
      'swap_exercise（把某个还没做过的动作换成动作库里同类型的另一个，需 exerciseIndex/exerciseId；组数/次数/休息会一并换成新动作的库内处方）、' +
      'set_prescription（改这一场某个动作的组数/次数/组间休息，需 exerciseIndex 与 sets/reps/restSec 之一）。' +
      'exerciseIndex 是**这一场**里的第几个动作（1 起，见 get_active_session 的 exercises），不是动作库 id。' +
      'insert_exercise / swap_exercise 需要动作库 id：不确定时先用动作库工具查（search_exercises）。' +
      '改完这一场的动作会重算今日建议与实际预填重量（新动作按它自己的历史给建议），不必再手动设重量。',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('insert_exercise'),
          Type.Literal('remove_exercise'),
          Type.Literal('swap_exercise'),
          Type.Literal('set_prescription'),
        ],
        { description: '要执行的动作' },
      ),
      exerciseId: Type.Optional(
        Type.String({ description: '动作库 id（insert_exercise / swap_exercise 用，来自动作库查询）' }),
      ),
      exerciseIndex: Type.Optional(
        Type.Number({
          description: '这一场里的第几个动作，1 起（remove_exercise / swap_exercise / set_prescription 用）',
        }),
      ),
      position: Type.Optional(
        Type.Number({
          description: 'insert_exercise 用：插完这个动作排第几（1 起），缺省追加到末尾；只能大于当前动作的下标',
        }),
      ),
      sets: Type.Optional(Type.Number({ description: '组数（insert_exercise / set_prescription 用，1~20）' })),
      reps: Type.Optional(Type.Number({ description: '每组次数（insert_exercise / set_prescription 用）' })),
      restSec: Type.Optional(
        Type.Number({ description: '组间休息秒数（set_prescription 用，0~600）' }),
      ),
    }),
    async execute(args) {
      const s = await activeSession()
      if (!s) return rejected('当前没有进行中的训练课')
      const plan = s.plan
      if (!plan) return rejected('会话里没有课程数据')

      const phase = s.phase
      const ei = num(args.exerciseIndex)
      const id = args.exerciseId?.trim() ?? ''

      /** 校验 exerciseIndex 并把目标条目取出来（1 起 → 0 起）；不合法时返回可读原因 */
      const target = (): { idx: number; name: string } | string => {
        if (ei == null || !Number.isInteger(ei) || ei < 1 || ei > plan.exercises.length) {
          return `exerciseIndex 需在 1~${plan.exercises.length} 之间，收到 ${ei ?? '空'}`
        }
        return { idx: ei - 1, name: plan.exercises[ei - 1]!.name }
      }

      try {
        switch (args.action) {
          case 'insert_exercise': {
            if (phase === 'summary') return rejected('这一场已经结束，不能再插入动作')
            if (!id) return rejected('insert_exercise 需要 exerciseId（动作库 id）')
            const lib = useExerciseLibStore()
            await lib.ensureLoaded()
            const rec = lib.list.find((e) => e.id === id)
            if (!rec) return rejected(`动作库里没有 id 为「${id}」的动作，请先查动作库拿 id`)
            if (rec.hidden) return rejected(`「${rec.name}」已隐藏，不能插入`)

            const total = plan.exercises.length
            const posRaw = num(args.position)
            if (posRaw != null && (!Number.isInteger(posRaw) || posRaw < 1 || posRaw > total + 1)) {
              return rejected(`position 需在 1~${total + 1} 之间（插完排第几），收到 ${posRaw}`)
            }
            if (posRaw != null && posRaw <= s.exIndex + 1) {
              return rejected(
                `只能插在当前动作（第 ${s.exIndex + 1} 个）之后 —— 插到前面会让这一场的进度游标错位；` +
                  '如果你想让「现在」换成别的动作，用 swap_exercise',
              )
            }
            const sets = num(args.sets)
            if (sets != null && (!Number.isInteger(sets) || sets < 1 || sets > MAX_SETS)) {
              return rejected(`sets 需在 1~${MAX_SETS} 之间，收到 ${sets}`)
            }
            const reps = num(args.reps)
            if (reps != null && (reps < 0 || reps > 999)) {
              return rejected(`reps 需在 0~999 之间，收到 ${reps}`)
            }

            const at = s.insertExercise(rec.id, {
              at: (posRaw ?? total + 1) - 1,
              sets: sets ?? undefined,
              reps: reps ?? undefined,
            })
            if (at == null) {
              return rejected(
                plan.exercises.length >= 20
                  ? '这一场的动作数已达上限（20 个）'
                  : '插入失败：动作不可用或这一场已结束',
              )
            }
            return changed(
              s,
              `已插入「${rec.name}」为这一场第 ${at + 1} 个动作（共 ${s.plan?.exercises.length ?? 0} 个，课程库未改）`,
            )
          }

          case 'remove_exercise': {
            const t = target()
            if (typeof t === 'string') return rejected(t)
            if (phase === 'summary') return rejected('这一场已经结束，不能再删除动作')
            if (plan.exercises.length <= 1) return rejected('这一场只剩一个动作，不能删')
            if (t.idx === s.exIndex) {
              return rejected(
                `「${t.name}」正在做，不能删 —— 想跳过它用 update_active_session 的 skip_set，` +
                  '想换掉它用 swap_exercise',
              )
            }
            const done = s.exDoneCount(plan.exercises[t.idx]!.id)
            if (done > 0) {
              return rejected(`「${t.name}」这一场已经完成 ${done} 组，删掉会让这些组从统计里消失`)
            }
            if (!s.removeExercise(t.idx)) return rejected('删除失败：这一场已结束或该动作不可删')
            return changed(s, `已从这一场删掉「${t.name}」（课程库未改）`)
          }

          case 'swap_exercise': {
            const t = target()
            if (typeof t === 'string') return rejected(t)
            if (!id) return rejected('swap_exercise 需要 exerciseId（动作库 id）')
            const cur = plan.exercises[t.idx]!
            if (!s.canSwapExercise(t.idx)) {
              return rejected(`「${cur.name}」已经做过组了，不能换（只能换还没开始的动作）`)
            }
            const lib = useExerciseLibStore()
            await lib.ensureLoaded()
            const src = lib.list.find((e) => e.id === id)
            if (!src) return rejected(`动作库里没有 id 为「${id}」的动作，请先查动作库拿 id`)
            if (src.hidden) return rejected(`「${src.name}」已隐藏，不能作为替换目标`)
            if (src.kind !== cur.kind) {
              return rejected(`只能换成同类动作：目标是 ${cur.kind}，而「${src.name}」是 ${src.kind}`)
            }
            const ok = s.swapExercise(t.idx, {
              exerciseId: src.id,
              name: src.name,
              tips: src.tips,
              muscles: src.muscles,
            })
            if (!ok) return rejected('替换失败：该动作已开始或与当前动作相同')
            return changed(
              s,
              `这一场第 ${t.idx + 1} 个动作已换成「${src.name}」，组数/次数/休息同步换成它的库内处方（课程库未改）`,
            )
          }

          case 'set_prescription': {
            const t = target()
            if (typeof t === 'string') return rejected(t)
            if (phase === 'summary') return rejected('这一场已经结束，不能再改处方')
            const sets = num(args.sets)
            const reps = num(args.reps)
            const restSec = num(args.restSec)
            if (sets == null && reps == null && restSec == null) {
              return rejected('set_prescription 需要 sets / reps / restSec 至少一个')
            }
            if (sets != null && (!Number.isInteger(sets) || sets < 1 || sets > MAX_SETS)) {
              return rejected(`sets 需在 1~${MAX_SETS} 之间，收到 ${sets}`)
            }
            if (reps != null && (reps < 0 || reps > 999)) {
              return rejected(`reps 需在 0~999 之间，收到 ${reps}`)
            }
            if (restSec != null && (restSec < 0 || restSec > 600)) {
              return rejected(`restSec 需在 0~600 之间，收到 ${restSec}`)
            }
            const done = s.exDoneCount(plan.exercises[t.idx]!.id)
            if (sets != null && sets < done) {
              return rejected(`「${t.name}」这一场已经完成 ${done} 组，组数不能减到 ${sets}`)
            }
            const ok = s.setExercisePrescription(t.idx, {
              sets: sets ?? undefined,
              reps: reps ?? undefined,
              restSec: restSec ?? undefined,
            })
            if (!ok) return rejected('改处方失败：这一场已结束或参数无效')
            const ex = s.plan?.exercises[t.idx]
            return changed(
              s,
              `这一场「${t.name}」已是 ${ex ? s.effSets(ex) : '?'} 组` +
                `${ex?.reps != null ? ` × ${ex.reps} 次` : ''}${ex ? ` · 休息 ${ex.restSec}s` : ''}（课程库未改）`,
            )
          }

          default:
            return rejected('未知的 action')
        }
      } catch (e) {
        // 同 adjust：失败一律结构化回执，不把一轮对话弄崩
        return rejected(`编排失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }),
]
