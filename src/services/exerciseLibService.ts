/** 动作库 IPC 封装 · 对应 modules/exercise_lib/commands.rs */

import type {
  ExerciseCategory,
  ExerciseGuideInput,
  ExerciseGuideOverride,
  ExerciseInput,
  ExerciseKind,
  ExerciseRecord,
} from '@/types'
import { invoke } from './transport'

export const exerciseLibService = {
  /** 库内动作（默认按最近使用排序；内置动作默认不含被隐藏的） */
  list: (p?: {
    kind?: ExerciseKind
    category?: ExerciseCategory
    query?: string
    includeHidden?: boolean
  }) =>
    invoke<ExerciseRecord[]>('list_exercises', {
      kind: p?.kind ?? null,
      category: p?.category ?? null,
      query: p?.query ?? null,
      includeHidden: p?.includeHidden ?? false,
    }),

  get: (id: string) => invoke<ExerciseRecord>('get_exercise', { id }),

  /** 新建 / 更新自建动作（内置动作只读，提交会被后端拒绝） */
  upsert: (input: ExerciseInput) => invoke<ExerciseRecord>('upsert_exercise', { input }),

  /** 自建动作真删；内置动作只做隐藏（历史做组记录都保留） */
  remove: (id: string) => invoke<void>('delete_exercise', { id }),

  restore: (id: string) => invoke<void>('restore_exercise', { id }),

  /** 收藏 / 取消收藏（内置与自建都可；用户态，种子刷新不覆盖） */
  setFavorite: (id: string, favorite: boolean) =>
    invoke<void>('set_exercise_favorite', { id, favorite }),

  /* ---- 动作详解覆盖层（0048）：内置教学文案的 AI / 用户改动 ---- */

  /** 全部覆盖行（只含被改过的动作；前端与内置基线合成「当前生效值」） */
  listGuides: () => invoke<ExerciseGuideOverride[]>('list_exercise_guides'),

  /** 写一条覆盖（五段必须完整；局部修改由调用方先读再合并） */
  upsertGuide: (input: ExerciseGuideInput) =>
    invoke<ExerciseGuideOverride>('upsert_exercise_guide', { input }),

  /** 删覆盖 = 恢复内置基线 */
  resetGuide: (exerciseId: string) => invoke<void>('delete_exercise_guide', { exerciseId }),
}
