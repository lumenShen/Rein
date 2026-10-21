/** 训练课程域工具：课程 CRUD · 对应 planService */

import { Type } from '@earendil-works/pi-ai'

import { normalizeActivation, type ActivationMap } from '@/config/muscles'
import { WORKOUT_META } from '@/config/domain'
import { exerciseLibService } from '@/services/exerciseLibService'
import { planService } from '@/services/planService'
import { sessionService } from '@/services/sessionService'
import { todayStr } from '@/utils/date'
import { aggregateStrengthDays, fmtKg } from '@/utils/strength'
import { computeTrainingAdvice } from '@/utils/trainingAdvice'
import type { PlanExercise, PlanExerciseKind, WorkoutType } from '@/types'
import { MUSCLES } from './muscleSchema'
import { defineTool, type AppTool } from './types'

const TYPE_KEYS = Object.keys(WORKOUT_META) as WorkoutType[]
const PLAN_TYPE = Type.Union(
  TYPE_KEYS.map((k) => Type.Literal(k)),
  { description: `保存训练时计入的运动类型：${TYPE_KEYS.map((k) => `${k}=${WORKOUT_META[k].label}`).join(' / ')}` },
)

const EXERCISE_KIND = Type.Union(
  [Type.Literal('strength'), Type.Literal('timed'), Type.Literal('cardio')],
  { description: '动作类型：strength=力量(按组次计重) / timed=计时(平板支撑等) / cardio=有氧(按时长计)' },
)

/** 激活热身组：正式组前的小重量激活（不计入正式组数） */
const WARMUP_SET = Type.Object({
  weightKg: Type.Number({ description: '热身重量 kg，必须明显小于正式组重量' }),
  reps: Type.Number({ description: '热身次数' }),
})

const EXERCISE = Type.Object({
  name: Type.String({
    description: '动作名，如「杠铃卧推」。推荐先用 list_exercises 取库内动作（id + 名称），并把它填进 exerciseId',
  }),
  exerciseId: Type.Optional(
    Type.String({ description: '动作库 id（list_exercises 返回）。填写时以库内动作为准；缺省或库里查不到则按 name 自动入动作库' }),
  ),
  kind: EXERCISE_KIND,
  sets: Type.Optional(Type.Number({ description: '组数，默认 3' })),
  reps: Type.Optional(Type.Number({ description: '每组次数（strength 用）' })),
  weightKg: Type.Optional(Type.Number({ description: '建议重量 kg（strength 用）' })),
  warmups: Type.Optional(
    Type.Array(WARMUP_SET, {
      description:
        '激活热身组（strength 用，最多 2 组）：≥30kg 的复合动作配两段渐进 [50%×8, 75%×4]；12~30kg 配单组激活 [50%×12]；<12kg 不配。热身重量取整到 2.5 的倍数。' +
        '注意：会话运行时热身会按当天推荐重量重新换算（见 get_warmup_rule），这里填的是**回落值**（拿不到推荐重量时用），因此仍需按规则填对',
      maxItems: 2,
    }),
  ),
  targetSec: Type.Optional(Type.Number({ description: '每组目标秒数（timed 用）' })),
  durationMin: Type.Optional(Type.Number({ description: '时长分钟（cardio 用）' })),
  restSec: Type.Optional(Type.Number({ description: '组间休息秒，默认 90' })),
  tips: Type.Optional(Type.String({ description: '动作要点' })),
  muscles: Type.Optional(MUSCLES),
})

/** 动作入参 → 存储结构：补 id / 动作库 id 与缺省值。
 *
 * `stableId`：覆盖已有课程时沿用的动作条目 id（见 `upsert_plan`）。不传才新生成 ——
 * 这个 id 是训练快照 `doneSets` 的键，每次重写都换新会让历史记录在详情页里
 * 全部对不上课程动作。
 */
function normalizeExercise(
  e: { [k: string]: unknown },
  stableId?: string,
): {
  id: string
  exerciseId: string
  name: string
  kind: PlanExerciseKind
  sets: number
  reps: number | null
  weightKg: number | null
  warmups?: { weightKg: number; reps: number }[]
  targetSec: number | null
  durationMin: number | null
  restSec: number
  group?: string
  tips: string
  muscles?: ActivationMap
} {
  const out = {
    id: stableId ?? crypto.randomUUID(),
    // 缺省空串：后端 upsert 会按动作名挂库（未命中则建自建动作），不会漏
    exerciseId: typeof e.exerciseId === 'string' ? e.exerciseId.trim() : '',
    name: String(e.name ?? '').trim() || '未命名动作',
    kind: (e.kind as PlanExerciseKind) ?? 'strength',
    sets: typeof e.sets === 'number' && e.sets > 0 ? Math.round(e.sets) : 3,
    reps: typeof e.reps === 'number' ? e.reps : null,
    weightKg: typeof e.weightKg === 'number' ? e.weightKg : null,
    ...normalizeWarmups(e.warmups),
    targetSec: typeof e.targetSec === 'number' ? e.targetSec : null,
    durationMin: typeof e.durationMin === 'number' ? e.durationMin : null,
    restSec: typeof e.restSec === 'number' && e.restSec >= 0 ? Math.round(e.restSec) : 90,
    tips: typeof e.tips === 'string' ? e.tips : '',
    ...musclesField(e.muscles),
  }
  // 热身重量必须小于正式组重量，否则整组丢弃（宁可没有热身也不要假热身）
  if (out.warmups && out.weightKg != null) {
    const ok = out.warmups.filter((w) => w.weightKg < out.weightKg!)
    if (ok.length) out.warmups = ok
    else delete out.warmups
  }
  return out
}

/** 校验激活热身组：重量/次数为正、最多 2 组、必须小于正式组重量，非法时丢弃 */
function normalizeWarmups(w: unknown): { warmups?: { weightKg: number; reps: number }[] } {
  if (!Array.isArray(w)) return {}
  const list: { weightKg: number; reps: number }[] = []
  for (const it of w.slice(0, 2)) {
    if (!it || typeof it !== 'object') continue
    const o = it as { [k: string]: unknown }
    const weightKg = typeof o.weightKg === 'number' ? o.weightKg : NaN
    const reps = typeof o.reps === 'number' ? o.reps : NaN
    if (!Number.isFinite(weightKg) || weightKg <= 0 || !Number.isFinite(reps) || reps <= 0) continue
    list.push({ weightKg: Math.round(weightKg * 10) / 10, reps: Math.round(reps) })
  }
  return list.length ? { warmups: list } : {}
}

/** 白名单校验显式肌群（与 Rust / mock 共用同一套规则）；全非法时不落库 */
function musclesField(m: unknown): { muscles?: ActivationMap } {
  const out = normalizeActivation(m)
  return Object.keys(out).length ? { muscles: out } : {}
}

export const planTools: AppTool[] = [
  defineTool({
    name: 'list_plans',
    group: 'plan',
    label: '查看训练课程',
    description: '列出全部训练课程模板（最近使用的在前）。',
    parameters: Type.Object({}),
    async execute() {
      const rows = await planService.list()
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        subtitle: p.subtitle,
        workoutType: p.workoutType,
        exerciseCount: p.exercises.length,
        lastUsedAt: p.lastUsedAt,
      }))
    },
  }),

  defineTool({
    name: 'get_plan',
    group: 'plan',
    label: '查看课程详情',
    description: '查看一门训练课程的完整动作清单。',
    parameters: Type.Object({ id: Type.String({ description: '课程 id（list_plans 返回）' }) }),
    async execute(args) {
      const p = await planService.get(args.id)
      if (!p) throw new Error(`课程不存在：id=${args.id}`)
      return p
    },
  }),

  defineTool({
    name: 'upsert_plan',
    group: 'plan',
    label: '改课程库里的课程（不影响进行中的训练）',
    description:
      '**改的是课程库里的模板，对正在进行的这一场没有任何影响** —— 训练中用户说「这场换个动作 / 这场深蹲改成 5 组 / 这场插一个动作」要用 edit_session_plan（改这一场的编排：换 / 插 / 删 / 改组数），现场执行用 update_active_session。' +
      '创建或整门覆盖一门课程：不传 id = 新建；传已有 id = **整体替换**，必须给出完整的动作清单（没列出的动作会被删掉，不是在原清单上打补丁）。' +
      '判据：用户说「以后都这么练 / 把这门课改成…」用这个；说「今天这次 / 这一场」用 update_active_session / edit_session_plan。' +
      '改完回执里 affectsActiveSession=false，可以据此提醒用户「当前这一场不受影响」。',
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description:
            '课程 id（来自 list_plans）。修改已有课程**必须**传；不传 = 新建一门课程（重名会被拒绝）',
        }),
      ),
      name: Type.String({ description: '课程名，如「推力日 A」' }),
      subtitle: Type.Optional(Type.String({ description: '一句话副标题' })),
      workoutType: PLAN_TYPE,
      exercises: Type.Array(EXERCISE, { description: '完整动作清单，按训练顺序排列（覆盖式写入）' }),
    }),
    async execute(args) {
      if (args.exercises.length === 0) throw new Error('课程至少要有一个动作')
      // 覆盖已有课程时沿用原动作条目 id：那是训练快照 `doneSets` 的键。
      // 从前这里每个动作都重新 randomUUID()，AI 改一次课程就把这场课历史记录的键
      // 全部作废 —— 详情页会把真实做组摊成十几条「其他动作」（见 utils/sessionDetail）。
      // 匹配顺序：动作库 id 优先（同一动作换了处方仍算同一条），其次动作名；都没有才新生成。
      const prev = args.id ? await planService.get(args.id) : null
      // 传了 id 但课程不存在：绝不静默新建一条 id 由模型编的课程（那会在列表里多出一门
      // 谁也找不到来源的课）。要么先去 list_plans 拿真 id，要么明确不传 id 新建。
      if (args.id && !prev) {
        throw new Error(
          `课程 id「${args.id}」不存在。修改已有课程请先用 list_plans 取到真实 id；要新建一门课请不传 id。`,
        )
      }
      // 新建时挡同名：模型漏传 id 是最常见的失误，静默建出一门同名课程会让用户
      // 「改了但没生效」（他打开的还是原来那门）。这里直接拒绝并把已有 id 给它。
      if (!prev) {
        const name = args.name.trim()
        const dup = (await planService.list()).find((p) => p.name.trim() === name)
        if (dup) {
          throw new Error(
            `课程库里已有一门「${dup.name}」（id=${dup.id}）。要修改它请把 id 传进来；确实要再建一门同名的，先换个名字。`,
          )
        }
      }
      const reusable = [...(prev?.exercises ?? [])]
      const takeId = (e: { exerciseId?: string; name?: string }): string | undefined => {
        const exId = e.exerciseId?.trim()
        let i = exId ? reusable.findIndex((p) => p.exerciseId && p.exerciseId === exId) : -1
        if (i < 0) i = reusable.findIndex((p) => p.name === String(e.name ?? '').trim())
        if (i < 0) return undefined
        return reusable.splice(i, 1)[0]!.id
      }
      const saved = await planService.upsert({
        id: args.id ?? crypto.randomUUID(),
        name: args.name.trim(),
        subtitle: args.subtitle?.trim() || '',
        workoutType: args.workoutType,
        exercises: args.exercises.map((e) => normalizeExercise(e, takeId(e))),
      })
      return {
        ok: true,
        id: saved.id,
        name: saved.name,
        exerciseCount: saved.exercises.length,
        /** 明确告诉模型：这次改的是课程库，进行中的那一场没变 */
        affectsActiveSession: false,
      }
    },
  }),

  defineTool({
    name: 'delete_plan',
    group: 'plan',
    label: '删除课程库里的课程',
    description:
      '删除课程库里的一门课程模板。历史训练记录不受影响（逐组明细已单独落库、详情页照常可看）；' +
      '但如果这门课**正在训练中**，那一场会话会被作废（进度不再接续）。仅限用户明确要求删除时使用。',
    dangerous: true,
    parameters: Type.Object({ id: Type.String({ description: '课程 id（来自 list_plans）' }) }),
    async execute(args) {
      await planService.remove(args.id)
      return { ok: true }
    },
  }),

  defineTool({
    name: 'get_strength_progress',
    group: 'plan',
    label: '查看力量进步',
    description:
      '查看动作的重量变化记录（逐组明细，含热身组标记）。不带参数 = 列出有力量记录的动作（按最近训练排序）；带 exerciseId（动作库 id，或直接传动作名）= 该动作每次训练的做组明细与最大重量。用户问「卧推进步了没/该加重了吗/重量曲线」时调用。',
    parameters: Type.Object({
      exerciseId: Type.Optional(
        Type.String({ description: '动作库 id（list_exercises 返回）；也可直接传动作名' }),
      ),
    }),
    async execute(args) {
      if (!args.exerciseId) return { exercises: await sessionService.strengthExercises() }
      const rows = await sessionService.strengthHistory(args.exerciseId)
      const days = aggregateStrengthDays(rows)
      const warmupNote = rows.filter((r) => r.warmup).length
      return {
        exercise: args.exerciseId,
        sessions: days.map((d) => ({
          date: d.date,
          top: `${fmtKg(d.top)}kg${d.topReps != null ? `×${d.topReps}` : ''}`,
          workingSets: d.sets.map((s) => `${fmtKg(s.weightKg ?? 0)}kg×${s.reps ?? '?'}`),
        })),
        latestVsFirst:
          days.length >= 2
            ? `${fmtKg(days[days.length - 1]!.top)} vs ${fmtKg(days[0]!.top)} kg`
            : null,
        warmupSetsTotal: warmupNote,
      }
    },
  }),

  defineTool({
    name: 'list_exercises',
    group: 'plan',
    label: '检索动作库',
    description:
      '检索动作库（全部运动动作的唯一真源）：返回动作 id、名称、类型、分类、器材与主攻肌群。新建/修改课程前先调用它拿 exerciseId。用户问「有哪些练背动作 / 有没有某个动作」也用它。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '关键词（名称或别名，如「卧推」「划船」）' })),
      kind: Type.Optional(EXERCISE_KIND),
      category: Type.Optional(
        Type.Union(
          [Type.Literal('push'), Type.Literal('pull'), Type.Literal('legs'), Type.Literal('core'), Type.Literal('cardio'), Type.Literal('mobility'), Type.Literal('other')],
          { description: '分类：push 推 / pull 拉 / legs 腿 / core 核心 / cardio 有氧 / mobility 柔韧 / other 其他' },
        ),
      ),
    }),
    async execute(args) {
      const rows = await exerciseLibService.list({
        query: args.query,
        kind: args.kind as PlanExerciseKind | undefined,
        category: args.category as never,
      })
      return rows.slice(0, 40).map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        category: e.category,
        equipment: e.equipment,
        // 完整档位表（不只是键名）：AI 据此与自己的标注对齐/纠错
        muscles: e.muscles ?? {},
        sessions: e.sessions,
        custom: e.isCustom,
      }))
    },
  }),

  defineTool({
    name: 'training_advice',
    group: 'plan',
    label: '查看训练建议',
    description:
      '今日训练建议：逐动作建议重量 × 次数 × 组数（目标 RIR 2，依据 = 近几次 e1RM 基线 × 今日状态），以及本周各肌群容量（组数 vs 科学建议区间）。用户问「今天该练多少 / 该加重吗 / 容量够不够 / 恢复了吗」时调用。传 planId 时给出该课程每个动作的具体处方。',
    parameters: Type.Object({
      planId: Type.Optional(Type.String({ description: '课程 id（缺省 = 只看本周各肌群容量）' })),
      selfRating: Type.Optional(
        Type.Number({ description: '用户今日状态自评 1(很差)~5(很好)；用户主动说了疲惫/状态好时填' }),
      ),
    }),
    async execute(args) {
      const [lib, sets] = await Promise.all([
        exerciseLibService.list({ includeHidden: false }),
        sessionService.strengthRecentSets(42),
      ])
      let planExercises: PlanExercise[] | undefined
      if (args.planId) {
        const plan = await planService.get(args.planId)
        planExercises = plan.exercises
      }
      const advice = computeTrainingAdvice({
        sets,
        library: lib,
        planExercises,
        today: todayStr(),
        selfRating: args.selfRating ?? null,
      })
      return {
        summary: advice.summary,
        readiness: advice.readiness,
        exercises: Object.values(advice.perExercise).map((a) => ({
          name: a.name,
          suggested: a.suggestedWeight != null ? `${fmtKg(a.suggestedWeight)}kg × ${a.suggestedReps} × ${a.suggestedSets}组` : '—',
          lastWeight: a.lastWeight != null ? `${fmtKg(a.lastWeight)}kg × ${a.lastReps ?? '?'}（${a.lastDate}）` : null,
          baselineE1rm: a.baselineE1rm != null ? Math.round(a.baselineE1rm) : null,
          readiness: Number(a.readiness.toFixed(2)),
          why: a.rationale,
        })),
        weeklyVolume: advice.muscleLoad
          .filter((m) => m.sets > 0 || m.lastDate)
          .map((m) => `${m.label} ${m.sets}/${m.mav} 组 · ${m.status === 'low' ? '偏低' : m.status === 'ok' ? '达标' : m.status === 'high' ? '充足' : '超量'}`),
      }
    },
  }),
]
